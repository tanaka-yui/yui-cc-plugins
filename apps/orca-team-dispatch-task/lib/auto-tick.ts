import { autoCleanup, confirmStopped, pushBranches } from './auto-cleanup.ts'
import { renderComment } from './auto-comment.ts'
import { type AutoConfig, pickSources, readAutoConfig } from './auto-config.ts'
import { ensureCoordinator, openCoordinator } from './auto-coordinator.ts'
import { continuationOf, github, prStatus, readGithub, viewIssue } from './auto-github.ts'
import { AUTO_FILES, AUTO_WORKTREE_LIST_LIMIT, archiveStatusDir, autoDir, autoNow } from './auto-paths.ts'
import { orderQueue, syncIssues } from './auto-queue.ts'
import { buildRequest, readAutoResult, slugOf } from './auto-request.ts'
import { type AutoState, type IssueState, readState, releaseLock, takeLock, writeState } from './auto-state.ts'
import { hasCommentMarker, resumeTransition, transition } from './auto-transition.ts'
import { roleNames } from './config.ts'
import { readJson, writeAtomic } from './fs.ts'
import { asObject, asString, get, type Json, type JsonObject } from './json.ts'
import { receiptArray, runOrca, userOwned } from './orca.ts'
import { STATUS } from './status.ts'
import { envCount, run, runNode } from './sys.ts'

import { existsSync, mkdirSync, readFileSync, statfsSync } from 'node:fs'
import { freemem, hostname } from 'node:os'
import { join, resolve } from 'node:path'

export const AUTO_TICK_BUDGET_MS = 100_000
export const AUTO_START_RESERVE_MS = 60_000
export const AUTO_START_MAX_FAILURES = 3
export const AUTO_CREATE_SETTLE_SECS = 20
const JUDGE_LEASE_MS = 20 * 60_000
const ACTIVE = ['dispatching', 'running', 'finishing']
type Tick = {
  name: string
  config: AutoConfig
  state: AutoState
  save: () => void
  deadline: number
  errors: number
  dispatched: number
  finished: number
  startUsed: boolean
  deferred: Set<string>
}
const error = (tick: Tick, message: string): void => {
  tick.errors++
  console.log(message)
}
const child = (name: string): string =>
  join(process.env.ORCA_AUTO_BIN_DIR || resolve(import.meta.dirname, '../bin'), name)
const workersOf = (issue: IssueState): JsonObject | null => asObject(readJson(join(issue.statusDir, 'workers.json')))
const branchOf = (workers: JsonObject): string =>
  asString(get(workers, 'roles', asString(workers.integration_role) ?? '', 'branch')) ?? ''
const runRecord = (issue: IssueState) => asObject(readJson(join(issue.statusDir, 'run.json')))
const coordinator = (issue: IssueState): string | null => asString(runRecord(issue)?.parent_handle) || issue.coordinator
const listedWorkers = (issue: IssueState): Json[] | null => {
  const record = runRecord(issue)
  const id = asString(record?.run_id)
  const h = coordinator(issue)
  if (!id || !h) return existsSync(join(issue.statusDir, 'run.json')) ? null : []
  const listed = receiptArray(
    runOrca(['orchestration', 'worker-list', '--run', id, '--json'], { ORCA_TERMINAL_HANDLE: h }),
    'workers',
  )
  return listed?.every((w) => Boolean(asString(get(w, 'dispatchId')))) ? listed : null
}
const unknownWorker = (workers: JsonObject, listed: Json[]): string | null => {
  const known = new Set(
    Object.values(asObject(workers.roles) ?? {})
      .map((r) => asString(asObject(r)?.dispatch))
      .filter(Boolean),
  )
  return listed.map((w) => asString(get(w, 'dispatchId'))).find((id) => Boolean(id && !known.has(id))) ?? null
}
const owns = (tick: Tick, issue: IssueState): boolean => {
  if (!existsSync(issue.statusDir)) return true
  let first = ''
  try {
    first = readFileSync(join(issue.statusDir, 'request.md'), 'utf8').split(/\s/, 1)[0] ?? ''
  } catch {
    /* keep the directory */
  }
  if (first === issue.key) return true
  error(tick, `別の Issue の status dir: ${issue.statusDir}`)
  return false
}
const held = (tick: Tick, issue: IssueState): boolean => {
  if (!issue.startAttempt) return false
  error(
    tick,
    `起動の結果が不明のため保留: ${issue.key} ${issue.slug} ${issue.startAttempt.at} — Orca で確かめてから orca-auto.ts clear-start --key ${issue.key}`,
  )
  return true
}
const ensure = (tick: Tick, issue: IssueState): string | null => {
  const checkout = tick.config.repos[issue.targets[0] ?? '']?.checkout
  if (!checkout || !owns(tick, issue)) return null
  const h = ensureCoordinator(issue.statusDir, checkout, issue.slug)
  if (h && issue.coordinator !== h) {
    issue.coordinator = h
    tick.save()
  }
  return h
}
const started = (tick: Tick, issue: IssueState, workers: JsonObject): void => {
  issue.startAttempt = null
  issue.startedAt ??= autoNow()
  issue.startFailures = 0
  issue.branch = branchOf(workers)
  tick.save()
  transition(
    issue,
    'started',
    { reason: issue.reason, limitMinutes: issue.limitMinutes, branch: issue.branch },
    STATUS.ready,
    STATUS.inProgress,
    false,
    'running',
    tick.save,
  )
}
const retireStart = (tick: Tick, issue: IssueState): boolean => {
  const list = listedWorkers(issue)
  if (!list || list.length) {
    error(tick, `起動の結果が不明: ${issue.key} — Orca で確かめてください`)
    return false
  }
  if (
    existsSync(issue.statusDir) &&
    !archiveStatusDir(
      issue.statusDir,
      join(autoDir(tick.name), AUTO_FILES.archive),
      `${issue.slug}-g${issue.generation}-start${issue.startFailures}`,
    )
  ) {
    error(tick, `起動の記録を退避できません: ${issue.key}`)
    return false
  }
  const h = coordinator(issue)
  if (h) runOrca(['terminal', 'close', '--terminal', h, '--json'])
  issue.phase = 'queued'
  issue.coordinator = null
  issue.worktrees = 0
  tick.deferred.add(issue.key)
  tick.save()
  return true
}
const start = (tick: Tick, issue: IssueState, args: string[], h: string, fresh: boolean, exec = false): void => {
  if (tick.startUsed || tick.deadline - Date.now() < AUTO_START_RESERVE_MS) return
  tick.startUsed = true
  issue.startAttempt = { at: autoNow(), pid: process.pid, host: hostname() }
  tick.save()
  const result = runNode(child('orca-start.ts'), args, false, {
    ORCA_TERMINAL_HANDLE: h,
    ORCA_CREATE_SETTLE_SECS: String(AUTO_CREATE_SETTLE_SECS),
  })
  issue.startAttempt = null
  const workers = workersOf(issue)
  if (result.rc === 0 && workers) {
    if (fresh) tick.dispatched++
    if (exec) {
      issue.startFailures = 0
      issue.branch = branchOf(workers)
      tick.save()
      return
    }
    started(tick, issue, workers)
    return
  }
  issue.startFailures++
  if (issue.startFailures >= AUTO_START_MAX_FAILURES)
    issue.failReason = `worker を起動できませんでした（${issue.startFailures} 回）。`
  tick.save()
  if (result.stderr) console.log(result.stderr.trim())
  if (!existsSync(join(issue.statusDir, 'workers.json'))) retireStart(tick, issue)
  if (issue.failReason) {
    finishFailure(tick, issue)
    clean(tick, issue)
  }
}
const recover = (tick: Tick, issue: IssueState): void => {
  if (issue.pendingLabel || issue.failReason || issue.startAttempt || !owns(tick, issue)) return
  if (!existsSync(join(issue.statusDir, 'workers.json'))) {
    retireStart(tick, issue)
    return
  }
  const workers = workersOf(issue)
  if (!workers || !asObject(workers.roles)) {
    error(tick, `起動の結果が不明: ${issue.key}`)
    return
  }
  const h = ensure(tick, issue)
  if (!h) return
  const roles = asObject(workers.roles) ?? {}
  const review = asString(workers.review_mode) ?? tick.config.roles.review_mode
  const required = review === 'on' ? ['design_review', 'design'] : ['design']
  if (required.some((role) => !asString(get(roles, role, 'dispatch')))) {
    const listed = listedWorkers(issue)
    if (!listed) return
    const extra = unknownWorker(workers, listed)
    if (extra) {
      error(
        tick,
        `起動の結果が不明: ${issue.key} ${asString(runRecord(issue)?.run_id)} ${extra} — orca-recover.ts か Orca で確かめてください`,
      )
      return
    }
    const checkout = tick.config.repos[issue.targets[0] ?? '']?.checkout
    if (checkout)
      start(
        tick,
        issue,
        ['--slug', issue.slug, '--resume', '--repo-root', checkout, '--design-mode', 'plan', '--unattended'],
        h,
        false,
      )
  } else {
    const incomplete = required.filter((role) => get(roles, role, 'start_incomplete') === true)
    if (incomplete.length) console.log(`起動未完了の役: ${issue.key} ${incomplete.join(', ')}`)
    started(tick, issue, workers)
  }
}
const capacity = (tick: Tick): { used: number; readable: boolean } => {
  const active = Object.values(tick.state.issues).filter((i) => ACTIVE.includes(i.phase))
  const reserved = active.reduce((n, i) => n + i.worktrees, 0)
  const owned = new Set(
    active.flatMap((i) =>
      Object.values(asObject(workersOf(i)?.roles) ?? {})
        .map((r) => asString(asObject(r)?.worktree_path))
        .filter(Boolean),
    ),
  )
  const response = runOrca(['worktree', 'list', '--limit', String(AUTO_WORKTREE_LIST_LIMIT), '--json'])
  const list = receiptArray(response, 'worktrees')
  if (!list || get(response.json, 'result', 'truncated') === true) {
    error(tick, 'worktree の一覧を読めないため補充しません')
    return { used: reserved, readable: false }
  }
  const orphans = list.filter(
    (w) => asString(get(w, 'displayName'))?.startsWith('auto-') && !owned.has(asString(get(w, 'path'))),
  )
  for (const w of orphans)
    console.log(`持ち主のいない worktree: ${asString(get(w, 'displayName'))} ${asString(get(w, 'path'))}`)
  return { used: reserved + orphans.length, readable: true }
}
const refill = (tick: Tick): void => {
  const available = capacity(tick)
  if (!available.readable) return
  let used = available.used
  const required = roleNames(tick.config.roles.review_mode, tick.config.roles.phase_b).length
  const sources = new Set(pickSources(tick.config))
  for (const issue of orderQueue(
    Object.values(tick.state.issues).filter(
      (i) =>
        i.phase === 'queued' &&
        !i.pendingLabel &&
        !i.failReason &&
        !i.startAttempt &&
        !i.cleanupPending &&
        !tick.deferred.has(i.key) &&
        sources.has(i.repo),
    ),
  )) {
    if (tick.startUsed || tick.deadline - Date.now() < AUTO_START_RESERVE_MS) break
    if (used + required > tick.config.lanes) {
      console.log(`レーンが足りません: lanes=${tick.config.lanes} 使用中=${used} 1 件の worktree=${required}`)
      break
    }
    const repo = tick.config.repos[issue.targets[0] ?? '']
    if (!repo) continue
    let freeDisk = 0
    try {
      const stats = statfsSync(repo.checkout)
      freeDisk = (stats.bavail * stats.bsize) / 1024 / 1024
    } catch {
      error(tick, `checkout を読めません: ${repo.checkout}`)
      continue
    }
    if (
      Number(process.env.ORCA_AUTO_FREE_MEMORY_MB ?? freemem() / 1024 / 1024) < tick.config.minFreeMemoryMb ||
      Number(process.env.ORCA_AUTO_FREE_DISK_MB ?? freeDisk) < tick.config.minFreeDiskMb
    ) {
      console.log('空きメモリまたはディスクが足りません')
      break
    }
    const status = run('git', ['-C', repo.checkout, 'status', '--porcelain'])
    if (status.rc !== 0 || status.stdout.trim()) {
      console.log(`未コミットの変更があるため補充しません: ${repo.checkout}`)
      continue
    }
    const slug = slugOf(issue.key)
    const statusDir = join(repo.checkout, '.dispatch', slug)
    if (existsSync(statusDir)) {
      console.log(`status dir が残っています: ${statusDir}`)
      continue
    }
    const target = issue.targets[0] ?? ''
    const defaultBranch = asString(
      get(readGithub(['repo', 'view', '--json', 'defaultBranchRef', target]), 'defaultBranchRef', 'name'),
    )
    if (
      !defaultBranch ||
      run('git', ['-C', repo.checkout, 'fetch', 'origin', defaultBranch]).rc !== 0 ||
      run('git', ['-C', repo.checkout, 'checkout', '-B', defaultBranch, `origin/${defaultBranch}`]).rc !== 0
    ) {
      error(tick, `default ブランチを用意できません: ${target}`)
      continue
    }
    const detail = asObject(readGithub(['issue', 'view', String(issue.number), '--repo', issue.repo, '--json', 'body']))
    if (typeof detail?.body !== 'string') continue
    mkdirSync(join(autoDir(tick.name), 'requests'), { recursive: true })
    const request = join(autoDir(tick.name), 'requests', `${slug}-g${issue.generation}.md`)
    if (
      !writeAtomic(
        request,
        buildRequest(
          issue,
          detail.body,
          repo,
          tick.config.roles,
          join(statusDir, 'auto-result.json'),
          continuationOf(issue, issue.endedAt ?? issue.updatedAt),
        ),
      )
    )
      throw new Error('依頼文を書けません')
    const h = openCoordinator(repo.checkout, slug)
    if (!h) continue
    Object.assign(issue, { phase: 'dispatching', slug, statusDir, coordinator: h, worktrees: required })
    tick.save()
    start(
      tick,
      issue,
      [
        '--request-file',
        request,
        '--slug',
        slug,
        '--objective',
        `${issue.key} ${issue.title}`,
        '--repo-root',
        repo.checkout,
        '--integration',
        'pr',
        '--unattended',
        '--design-mode',
        'plan',
        '--review-mode',
        tick.config.roles.review_mode,
        '--phase-b',
        tick.config.roles.phase_b,
      ],
      h,
      true,
    )
    used += required
  }
}
const stopRoles = (tick: Tick, issue: IssueState): void => {
  if (issue.startAttempt || !owns(tick, issue)) return
  const workers = workersOf(issue)
  if (!workers) return
  const list = listedWorkers(issue)
  if (!list || unknownWorker(workers, list)) {
    error(tick, `停止を確かめられません: ${issue.key}`)
    return
  }
  const h = ensure(tick, issue)
  if (!h) return
  for (const [role, data] of Object.entries(asObject(workers.roles) ?? {})) {
    const dispatch = asString(asObject(data)?.dispatch)
    if (!dispatch || list.some((w) => get(w, 'dispatchId') === dispatch && userOwned(w))) continue
    runNode(child('orca-stop.ts'), ['--status-dir', issue.statusDir, '--role', role], false, {
      ORCA_TERMINAL_HANDLE: h,
    })
  }
}
const markFailure = (tick: Tick, issue: IssueState, reason: string): void => {
  if (!issue.failReason) {
    issue.pendingLabel = null
    issue.failReason = reason
    issue.cleanupPending = true
    tick.save()
    stopRoles(tick, issue)
  }
}
const timedOut = (issue: IssueState): boolean =>
  Boolean(
    issue.startedAt &&
      ['running', 'dispatching'].includes(issue.phase) &&
      issue.pendingLabel?.event !== 'failed' &&
      Date.parse(autoNow()) - Date.parse(issue.startedAt) > issue.limitMinutes * 60_000,
  )
const humanStop = (tick: Tick, issue: IssueState): void => {
  issue.phase = 'stopped'
  issue.pendingLabel = null
  issue.failReason = null
  issue.cleanupPending = true
  issue.endedAt = autoNow()
  tick.save()
  stopRoles(tick, issue)
}
const progress = (tick: Tick, issue: IssueState): void => {
  if (issue.pendingLabel || issue.failReason || issue.startAttempt || issue.cleanupPending || !owns(tick, issue)) return
  const h = ensure(tick, issue)
  if (!h) return
  const waited = runNode(
    child('orca-wait.ts'),
    [
      '--status-dir',
      issue.statusDir,
      '--max-waits',
      '1',
      '--timeout-ms',
      '1000',
      '--stall-after-min',
      String(tick.config.limits.stallMinutes),
      '--on-stall',
      'ask',
    ],
    false,
    { ORCA_TERMINAL_HANDLE: h, ORCA_WAITER_RETRY_TRIES: '0' },
  )
  if (waited.rc === 0) {
    issue.phase = 'finishing'
    issue.finishingSince = autoNow()
    tick.save()
  } else if (waited.rc === 5) {
    markFailure(tick, issue, 'worker が失敗を報告しました。')
    finishFailure(tick, issue)
    clean(tick, issue)
  } else if (waited.rc === 9 && !tick.startUsed) {
    const next = ensure(tick, issue)
    const checkout = tick.config.repos[issue.targets[0] ?? '']?.checkout
    if (next && checkout)
      start(tick, issue, ['--phase', 'exec', '--slug', issue.slug, '--repo-root', checkout], next, false, true)
  } else if (waited.rc === 8 && !issue.stalledNotified) {
    const body = renderComment({
      event: 'stalled',
      generation: issue.generation,
      elapsedMinutes: Math.floor((Date.parse(autoNow()) - Date.parse(issue.startedAt ?? autoNow())) / 60_000),
      limitMinutes: issue.limitMinutes,
    }).body
    const found = hasCommentMarker(issue, body.split('\n').at(-1) ?? '')
    if (
      found === true ||
      (found === false &&
        github(['issue', 'comment', String(issue.number), '--repo', issue.repo, '--body', body]).rc === 0)
    ) {
      issue.stalledNotified = true
      tick.save()
    }
  } else if (![3, 8, 9].includes(waited.rc)) error(tick, `待機を進められません: ${issue.key} rc=${waited.rc}`)
}

const AUTO_CI_APPEAR_MINUTES = 30
const AUTO_PR_RETRY_MINUTES = 30
const clean = (tick: Tick, issue: IssueState): void => {
  if (!issue.cleanupPending || issue.failReason || issue.pendingLabel || issue.startAttempt || !owns(tick, issue))
    return
  const checkout = tick.config.repos[issue.targets[0] ?? '']?.checkout
  if (!checkout) return
  if (existsSync(join(issue.statusDir, 'run.json')) && !ensure(tick, issue)) return
  let merged = issue.phase === 'done'
  if (!merged && issue.prs.length) {
    const statuses = issue.prs.map((p) => prStatus(p.repo, p.number))
    if (statuses.some((s) => s === null)) return
    merged = statuses.every((s) => s?.state === 'MERGED')
  }
  const result = autoCleanup(
    issue.statusDir,
    checkout,
    join(autoDir(tick.name), AUTO_FILES.archive),
    issue.generation,
    merged,
  )
  for (const reason of result.reasons) console.log(reason)
  if (result.ok) {
    issue.cleanupPending = false
    tick.save()
  }
}
const finishFailure = (tick: Tick, issue: IssueState): void => {
  if (!issue.failReason || issue.pendingLabel || issue.startAttempt || !owns(tick, issue)) return
  if (!issue.cleanupPending) {
    issue.cleanupPending = true
    tick.save()
    stopRoles(tick, issue)
  }
  const checkout = tick.config.repos[issue.targets[0] ?? '']?.checkout
  if (!checkout) return
  if (existsSync(join(issue.statusDir, 'run.json')) && !ensure(tick, issue)) return
  const stopped = confirmStopped(issue.statusDir)
  if (!stopped.stopped) {
    for (const reason of stopped.reasons) error(tick, reason)
    return
  }
  const pushed = pushBranches(issue.statusDir, checkout, null)
  const result = readAutoResult(join(issue.statusDir, 'auto-result.json'))
  const reason = issue.failReason + (result?.envFailure ? ` 環境が原因: ${result.envFailure}` : '')
  const view = viewIssue(issue.repo, issue.number)
  if (!view) return
  const from = view.labels.includes(STATUS.inProgress) ? STATUS.inProgress : STATUS.ready
  if (
    transition(
      issue,
      'failed',
      { reason, branch: issue.branch, pushed: pushed.pushed },
      from,
      STATUS.failed,
      false,
      'failed',
      tick.save,
    )
  )
    tick.finished++
}
const needsReview = (tick: Tick, issue: IssueState, reason: string): void => {
  if (
    transition(
      issue,
      'needs-review',
      { reason, prs: issue.prs, decisions: issue.decisions },
      STATUS.inProgress,
      STATUS.inReview,
      false,
      'review',
      tick.save,
    )
  )
    tick.finished++
}
const handoverPrs = (issue: IssueState): boolean => {
  if (!issue.prevBranch || issue.prevBranch === issue.branch) return true
  const current = issue.prs[0]
  if (!current) return true
  for (const previous of issue.prevPrs) {
    if (previous.repo === current.repo && previous.number === current.number) continue
    const status = prStatus(previous.repo, previous.number)
    if (!status) return false
    if (status.state !== 'OPEN') continue
    const marker = `<!-- orca-auto:handover:${issue.generation}:${slugOf(issue.key)} -->`
    const posted = hasCommentMarker({ ...issue, repo: previous.repo, number: previous.number }, marker)
    if (posted === null) return false
    const body = `${current.repo}#${current.number} に引き継ぎました: ${current.url}\n\n${marker}`
    if (!posted && github(['pr', 'comment', String(previous.number), '--repo', previous.repo, '--body', body]).rc !== 0)
      return false
    if (github(['pr', 'close', String(previous.number), '--repo', previous.repo]).rc !== 0) return false
  }
  return true
}
const finish = (tick: Tick, issue: IssueState): void => {
  if (issue.pendingLabel || issue.failReason || issue.startAttempt || !owns(tick, issue)) return
  const view = viewIssue(issue.repo, issue.number)
  if (!view) return
  if (view.state !== 'OPEN' || !view.labels.includes(STATUS.inProgress)) {
    humanStop(tick, issue)
    return
  }
  issue.finishingSince ??= autoNow()
  tick.save()
  const repo = issue.targets[0] ?? ''
  const options = tick.config.repos[repo]
  if (!options) return
  const result = readAutoResult(join(issue.statusDir, 'auto-result.json'))
  issue.decisions = result
    ? [
        ...result.decisions,
        ...result.review.unresolved.map((s) => `未解消の指摘: ${s}`),
        ...result.review.declined.map((s) => `採らなかった指摘: ${s}`),
      ]
    : []
  tick.save()
  if (!issue.prs.length) {
    const created = runNode(child('orca-pr.ts'), ['--status-dir', issue.statusDir, '--repo', repo])
    const pr =
      created.rc === 0
        ? asObject(readGithub(['pr', 'view', '--repo', repo, '--json', 'number,url', issue.branch]))
        : null
    if (!pr || typeof pr.number !== 'number' || typeof pr.url !== 'string') {
      if (Date.parse(autoNow()) - Date.parse(issue.finishingSince) >= AUTO_PR_RETRY_MINUTES * 60_000) {
        const reason =
          asString(get(readJson(join(issue.statusDir, 'integration-result.json')), 'reason')) || 'PR を作れません'
        needsReview(tick, issue, reason)
      }
      return
    }
    issue.prs = [{ repo, number: pr.number, url: pr.url }]
    tick.save()
  }
  if (!handoverPrs(issue)) return
  const pr = issue.prs[0]
  if (!pr) return
  const status = prStatus(pr.repo, pr.number)
  if (!status) return
  if (status.state === 'MERGED') {
    if (
      transition(
        issue,
        'ai-merged',
        { prs: issue.prs, summary: result?.summary },
        STATUS.inProgress,
        STATUS.done,
        true,
        'done',
        tick.save,
      )
    )
      tick.finished++
    return
  }
  if (status.checks === 'pending') return
  if (status.checks === 'none' && options.ci && status.state === 'OPEN') {
    if (Date.parse(autoNow()) - Date.parse(issue.finishingSince) >= AUTO_CI_APPEAR_MINUTES * 60_000)
      needsReview(tick, issue, 'CI が始まりません')
    return
  }
  const reasons: string[] = []
  if (!result) reasons.push('結果の報告が読めないため確認してください。')
  if (result && !result.verify.passed) reasons.push('確認コマンドが通っていません。')
  if (result?.envFailure) reasons.push(`環境が原因: ${result.envFailure}`)
  if (issue.decisions.length) reasons.push('AI が判断した点があります。')
  if (status.checks === 'fail') reasons.push('CI が失敗しました。')
  if (!options.verified) reasons.push('確認できないリポジトリです。')
  if (options.infra) reasons.push('インフラの変更は確認が必要です。')
  if (status.state === 'CLOSED') reasons.push('PR が閉じられています。')
  if (reasons.length) {
    needsReview(tick, issue, reasons.join(' '))
    return
  }
  const allowed = asObject(
    readGithub(['repo', 'view', '--json', 'squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed', pr.repo]),
  )
  if (!allowed) return
  const method =
    allowed.squashMergeAllowed === true
      ? '--squash'
      : allowed.mergeCommitAllowed === true
        ? '--merge'
        : allowed.rebaseMergeAllowed === true
          ? '--rebase'
          : null
  if (!method || github(['pr', 'merge', String(pr.number), '--repo', pr.repo, method]).rc !== 0) {
    needsReview(tick, issue, 'PR を merge できませんでした。')
    return
  }
  if (
    transition(
      issue,
      'ai-merged',
      { prs: issue.prs, summary: result?.summary },
      STATUS.inProgress,
      STATUS.done,
      true,
      'done',
      tick.save,
    )
  )
    tick.finished++
}
const watchReview = (tick: Tick, issue: IssueState): void => {
  const view = viewIssue(issue.repo, issue.number)
  if (!view) return
  if (view.state === 'CLOSED') {
    if (issue.cleanupPending) {
      issue.phase = 'stopped'
      tick.save()
    } else {
      delete tick.state.issues[issue.key]
      tick.save()
    }
    return
  }
  if (!view.labels.includes(STATUS.inReview)) {
    issue.phase = 'stopped'
    tick.save()
    return
  }
  if (!issue.prs.length) return
  const statuses = issue.prs.map((p) => prStatus(p.repo, p.number))
  if (
    statuses.every((s) => s?.state === 'MERGED') &&
    transition(issue, 'human-merged', { prs: issue.prs }, STATUS.inReview, STATUS.done, true, 'done', tick.save)
  )
    tick.finished++
}

export const runTick = (name: string): number => {
  const budget = envCount('ORCA_AUTO_BUDGET_MS', AUTO_TICK_BUDGET_MS)
  if (!takeLock(name, budget + 60_000)) return 1
  try {
    const config = readAutoConfig(name)
    if (!config) {
      console.error('設定を読めません')
      return 1
    }
    const state = readState(name)
    const tick: Tick = {
      name,
      config,
      state,
      save: () => writeState(name, state),
      deadline: Date.now() + budget,
      errors: 0,
      dispatched: 0,
      finished: 0,
      startUsed: false,
      deferred: new Set(),
    }
    const blocked = new Set(
      Object.values(state.issues)
        .filter((i) => held(tick, i))
        .map((i) => i.key),
    )
    for (const issue of Object.values(state.issues))
      if (timedOut(issue)) markFailure(tick, issue, `上限時間（${issue.limitMinutes} 分）を超えました。`)
    for (const issue of Object.values(state.issues)) {
      if (
        issue.pendingLabel &&
        !blocked.has(issue.key) &&
        (!issue.failReason || issue.pendingLabel.event === 'failed')
      ) {
        const before = issue.phase
        resumeTransition(issue, tick.save)
        if (issue.phase === 'stopped' && before !== 'stopped') stopRoles(tick, issue)
      }
    }
    const sources = pickSources(config)
    const synced = syncIssues(
      state,
      config.sources.filter((s) => sources.includes(s.repo)),
    )
    tick.save()
    for (const key of synced.humanChanged) {
      const issue = state.issues[key]
      if (issue && !blocked.has(key)) humanStop(tick, issue)
    }
    for (const issue of Object.values(state.issues))
      if (issue.failReason && !blocked.has(issue.key)) finishFailure(tick, issue)
    for (const issue of Object.values(state.issues)) {
      if (blocked.has(issue.key) || issue.pendingLabel || issue.failReason) continue
      if (issue.phase === 'finishing') finish(tick, issue)
      else if (issue.phase === 'review') watchReview(tick, issue)
      clean(tick, issue)
    }
    for (const issue of Object.values(state.issues))
      if (issue.phase === 'running' && !blocked.has(issue.key)) progress(tick, issue)
    for (const issue of Object.values(state.issues))
      if (issue.phase === 'dispatching' && !blocked.has(issue.key)) recover(tick, issue)
    refill(tick)
    const judging = Object.values(state.issues).filter((i) => i.phase === 'judging' && !i.pendingLabel).length
    console.log(`auto: judge=${judging} dispatched=${tick.dispatched} finished=${tick.finished} errors=${tick.errors}`)
    return judging > 0 &&
      (!state.judgingSince || Date.parse(autoNow()) - Date.parse(state.judgingSince) > JUDGE_LEASE_MS)
      ? 0
      : 1
  } finally {
    releaseLock(name)
  }
}
