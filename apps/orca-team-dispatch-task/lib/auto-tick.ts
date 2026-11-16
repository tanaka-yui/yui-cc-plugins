import { autoCleanup, confirmStopped, pushBranches, unrecordedWorker } from './auto-cleanup.ts'
import { renderComment } from './auto-comment.ts'
import { type AutoConfig, pickSources, readAutoConfig } from './auto-config.ts'
import { ensureCoordinator, openCoordinator } from './auto-coordinator.ts'
import { continuationOf, github, prStatus, readGithub, viewIssue } from './auto-github.ts'
import { envArgs, hostKey, hostsOf, LOCAL_HOST } from './auto-hosts.ts'
import {
  AUTO_FILES,
  AUTO_JUDGE_LEASE_MS,
  AUTO_TICK_BUDGET_MS,
  AUTO_WORKTREE_LIST_LIMIT,
  archiveStatusDir,
  autoCallErrors,
  autoDir,
  autoNow,
  beginAutoTick,
  canAutoCall,
  endAutoTick,
  autoRun as run,
  autoOrca as runOrca,
} from './auto-paths.ts'
import { orderQueue, syncIssues } from './auto-queue.ts'
import { buildReport } from './auto-report.ts'
import { buildRequest, readAutoResult, readPlanResult, slugOf } from './auto-request.ts'
import { type AutoState, type IssueState, readState, releaseLock, takeLock, writeState } from './auto-state.ts'
import { hasCommentMarker, resumeTransition, transition } from './auto-transition.ts'
import { roleNames } from './config.ts'
import { readJson, writeAtomic } from './fs.ts'
import { asArray, asObject, asString, get, type Json, type JsonObject } from './json.ts'
import { receiptArray, receiptOk } from './orca.ts'
import { fetchBranch } from './remote-branch.ts'
import { STATUS } from './status.ts'
import { availableMemoryMb, envCount, runNode as runProcessNode } from './sys.ts'

import { existsSync, mkdirSync, readdirSync, readFileSync, statfsSync } from 'node:fs'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'

import type { HostConfig } from './auto-hosts.ts'

export const AUTO_START_RESERVE_MS = 60_000
export const AUTO_START_MAX_FAILURES = 3
export const AUTO_CREATE_SETTLE_SECS = 20
const runNode = (script: string, args: string[], inherit = false, env?: Record<string, string>) =>
  canAutoCall('子の実行') ? runProcessNode(script, args, inherit, env) : { rc: 1, stdout: '', stderr: 'timed out' }
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
  reachable: Map<string, boolean>
  unreachable: Set<string>
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
  const remote = !!issue.host && issue.host !== LOCAL_HOST
  const response = runOrca(
    ['orchestration', 'worker-list', '--run', id, ...(remote ? ['--include-remote'] : []), '--json'],
    { ORCA_TERMINAL_HANDLE: h },
  )
  if (
    remote &&
    (asArray(get(response.json, 'result', 'partialHostErrors')) ?? []).some(
      (e) => get(e, 'environmentId') === issue.host,
    )
  )
    return null
  const listed = receiptArray(response, 'workers')
  return listed?.every((w) => Boolean(asString(get(w, 'dispatchId')))) ? listed : null
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
  const runId = asString(runRecord(issue)?.run_id) ?? '未記録'
  const processes = run('ps', ['-axo', 'pid=,command='])
  const diagnostic = processes.rc === 0 ? (processes.stdout.includes(`--slug ${issue.slug}`) ? 'あり' : 'なし') : '不明'
  error(
    tick,
    `起動の結果が不明のため保留: ${issue.key} ${issue.slug} ${issue.startAttempt.at} Run=${runId} 起動プロセス=${diagnostic}（診断のみ） — Orca で確かめてから orca-auto.ts clear-start --key ${issue.key}`,
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
  if (!canAutoCall('起動の後片付け')) return false
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
  if (tick.startUsed || !canAutoCall('起動', AUTO_START_RESERVE_MS)) return
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
  if (!canAutoCall('起動の回復')) return
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
    const extra = unrecordedWorker(issue.statusDir, workers, listed)
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
const reachable = (tick: Tick, host: string): boolean => {
  if (host === LOCAL_HOST) return true
  const cached = tick.reachable.get(host)
  if (cached !== undefined) return cached
  const response = runOrca(['status', ...envArgs(host), '--json'])
  const result = receiptOk(response) && get(response.json, 'result', 'runtime', 'reachable') === true
  tick.reachable.set(host, result)
  return result
}
const capacityOf = (
  tick: Tick,
  host: HostConfig,
  log = true,
): { used: number; readable: boolean; reachable: boolean } => {
  const active = Object.values(tick.state.issues).filter((i) => ACTIVE.includes(i.phase))
  const reserved = active.filter((i) => (i.host ?? LOCAL_HOST) === host.id).reduce((n, i) => n + i.worktrees, 0)
  if (!reachable(tick, host.id)) return { used: reserved, readable: false, reachable: false }
  const owned = new Set(
    active.flatMap((i) =>
      Object.values(asObject(workersOf(i)?.roles) ?? {}).flatMap((r) => {
        const path = asString(get(r, 'worktree_path'))
        return path ? [hostKey(asString(get(r, 'environment')) ?? LOCAL_HOST, path)] : []
      }),
    ),
  )
  const response = runOrca([
    'worktree',
    'list',
    ...envArgs(host.id),
    '--limit',
    String(AUTO_WORKTREE_LIST_LIMIT),
    '--json',
  ])
  const list = receiptArray(response, 'worktrees')
  if (!list || get(response.json, 'result', 'truncated') === true) {
    error(tick, 'worktree の一覧を読めないため補充しません')
    return { used: reserved, readable: false, reachable: true }
  }
  const orphans = list.filter(
    (w) =>
      asString(get(w, 'displayName'))?.startsWith('auto-') &&
      !owned.has(hostKey(host.id, asString(get(w, 'path')) ?? '')),
  )
  for (const w of orphans)
    if (log) console.log(`持ち主のいない worktree: ${asString(get(w, 'displayName'))} ${asString(get(w, 'path'))}`)
  return { used: reserved + orphans.length, readable: true, reachable: true }
}
const refill = (tick: Tick): void => {
  if (!canAutoCall('補充')) return
  const capacities = hostsOf(tick.config).map((host) => ({ host, ...capacityOf(tick, host) }))
  if (!capacities.some((c) => c.readable && c.reachable)) return
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
    if (tick.startUsed || !canAutoCall('補充の起動', AUTO_START_RESERVE_MS)) break
    const target = issue.targets[0] ?? ''
    const repo = tick.config.repos[target]
    if (!repo) continue
    const verified = capacities.filter((c) => c.host.repos[target]?.verified === true)
    let candidates = (verified.length ? verified : capacities).filter(
      (c) => c.reachable && c.readable && c.host.repos[target] && c.used + required <= c.host.lanes,
    )
    if (!candidates.length) {
      if (capacities.some((c) => c.reachable && c.readable && c.used + required <= c.host.lanes)) {
        console.log(`この Issue を入れられるマシンがありません: ${issue.key}`)
        continue
      }
      for (const c of capacities.filter((c) => c.reachable && c.readable))
        console.log(`レーンが足りません: lanes=${c.host.lanes} 使用中=${c.used} 1 件の worktree=${required}`)
      break
    }
    let freeDisk = 0
    try {
      const stats = statfsSync(repo.checkout)
      freeDisk = (stats.bavail * stats.bsize) / 1024 / 1024
    } catch {
      error(tick, `checkout を読めません: ${repo.checkout}`)
      continue
    }
    if (
      candidates.some((c) => c.host.id === LOCAL_HOST) &&
      (Number(process.env.ORCA_AUTO_FREE_MEMORY_MB ?? availableMemoryMb()) < tick.config.minFreeMemoryMb ||
        Number(process.env.ORCA_AUTO_FREE_DISK_MB ?? freeDisk) < tick.config.minFreeDiskMb)
    ) {
      console.log('空きメモリまたはディスクが足りません')
      candidates = candidates.filter((c) => c.host.id !== LOCAL_HOST)
    }
    const chosen = candidates.sort(
      (a, b) =>
        (b.host.lanes - b.used) / b.host.lanes - (a.host.lanes - a.used) / a.host.lanes ||
        Number(b.host.id === LOCAL_HOST) - Number(a.host.id === LOCAL_HOST),
    )[0]
    if (!chosen) continue
    const host = chosen.host
    const hostRepo = host.repos[target]
    if (!hostRepo) continue
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
          continuationOf(issue, issue.endedAt ?? issue.updatedAt),
        ),
      )
    )
      throw new Error('依頼文を書けません')
    const h = openCoordinator(repo.checkout, slug)
    if (!h) continue
    if (!hostRepo.verified && !issue.reason.includes('確認が通っていないマシンで実装'))
      issue.reason += '（確認が通っていないマシンで実装）'
    Object.assign(issue, { phase: 'dispatching', slug, statusDir, coordinator: h, worktrees: required, host: host.id })
    tick.save()
    start(
      tick,
      issue,
      [
        '--transport',
        'mail',
        '--base-branch',
        `origin/${defaultBranch}`,
        '--worker-orca',
        host.orcaBin,
        '--host-repo',
        hostRepo.selector,
        ...(host.id === LOCAL_HOST ? [] : ['--on', host.id]),
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
    chosen.used += required
  }
}
const stopRoles = (tick: Tick, issue: IssueState): void => {
  if (!canAutoCall('停止')) return
  if (issue.startAttempt || !owns(tick, issue) || !ensure(tick, issue)) return
  // 全役を止める auto では相方への通知を送らない（決着済みの役を follow-up として起動しない）。
  const stopped = confirmStopped(issue.statusDir)
  for (const reason of stopped.reasons) error(tick, `停止を確かめられません: ${issue.key} ${reason}`)
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
  if (!canAutoCall('人の変更')) return
  issue.phase = 'stopped'
  issue.pendingLabel = null
  issue.failReason = null
  issue.cleanupPending = true
  issue.endedAt = autoNow()
  tick.save()
  stopRoles(tick, issue)
}
const notifyStalled = (tick: Tick, issue: IssueState, reason?: string): void => {
  if (issue.stalledNotified || !canAutoCall('停滞の通知')) return
  const body = renderComment({
    event: 'stalled',
    generation: issue.generation,
    reason,
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
}
const progress = (tick: Tick, issue: IssueState): void => {
  if (!canAutoCall('進み')) return
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
  } else if (timedOut(issue)) {
    markFailure(tick, issue, `上限時間（${issue.limitMinutes} 分）を超えました。`)
    finishFailure(tick, issue)
    clean(tick, issue)
  } else if (waited.rc === 9 && !tick.startUsed) {
    const next = ensure(tick, issue)
    const checkout = tick.config.repos[issue.targets[0] ?? '']?.checkout
    if (next && checkout)
      start(tick, issue, ['--phase', 'exec', '--slug', issue.slug, '--repo-root', checkout], next, false, true)
  } else if (waited.rc === 8 && !issue.stalledNotified) {
    notifyStalled(tick, issue)
  } else if (![3, 8, 9].includes(waited.rc)) error(tick, `待機を進められません: ${issue.key} rc=${waited.rc}`)
}

const AUTO_CI_APPEAR_MINUTES = 30
const AUTO_PR_RETRY_MINUTES = 30
const clean = (tick: Tick, issue: IssueState): void => {
  if (!canAutoCall('後片付け')) return
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
    issue.prevBranch,
  )
  for (const reason of result.reasons) console.log(reason)
  if (result.ok) {
    issue.cleanupPending = false
    tick.save()
  }
}
const finishFailure = (tick: Tick, issue: IssueState): void => {
  if (!canAutoCall('失敗の仕上げ')) return
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
  if (!canAutoCall('仕上げ')) return
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
  const workers = workersOf(issue)
  const needsPlanResult = workers?.transport === 'mail' && workers.integration_role === 'exec'
  const planResult = needsPlanResult ? readPlanResult(join(issue.statusDir, 'plan-result.json')) : null
  const planDecisions = planResult
    ? [
        ...planResult.decisions.map((s) => `計画で決めた点: ${s}`),
        ...planResult.review.unresolved.map((s) => `計画の未解消の指摘: ${s}`),
        ...planResult.review.declined.map((s) => `計画で採らなかった指摘: ${s}`),
      ]
    : []
  issue.decisions = result
    ? [
        ...planDecisions,
        ...result.decisions,
        ...result.review.unresolved.map((s) => `未解消の指摘: ${s}`),
        ...result.review.declined.map((s) => `採らなかった指摘: ${s}`),
      ]
    : planDecisions
  tick.save()
  if (!issue.prs.length) {
    const integration = get(workers, 'roles', asString(workers?.integration_role) ?? '')
    const branch = asString(get(integration, 'branch')) ?? issue.branch
    if (asString(get(integration, 'environment')) && !fetchBranch(options.checkout, branch)) {
      if (Date.parse(autoNow()) - Date.parse(issue.finishingSince) >= AUTO_PR_RETRY_MINUTES * 60_000)
        needsReview(tick, issue, `${branch} が origin にありません`)
      return
    }
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
  if (needsPlanResult && !planResult) reasons.push('計画の結果の報告が読めないため確認してください。')
  for (const [role, prefix, label] of [
    ['design_review', 'plan', '計画'],
    ['exec_review', 'code', 'コード'],
  ] as const) {
    if (!asString(get(workers, 'roles', role, 'dispatch'))) continue
    let name: string | undefined
    try {
      name = readdirSync(join(issue.statusDir, 'review'))
        .filter((n) => new RegExp(`^${prefix}-round-[1-9][0-9]*-findings\\.md$`).test(n))
        .sort((a, b) => Number(a.split('-')[2]) - Number(b.split('-')[2]))
        .at(-1)
    } catch {
      /* レビューの結果がまだ無い */
    }
    if (!name) {
      reasons.push(`${label}のレビューの結果がありません。`)
      continue
    }
    let verdict = ''
    try {
      verdict =
        [
          ...readFileSync(join(issue.statusDir, 'review', name), 'utf8').matchAll(/^VERDICT: (approved|needs_work)$/gm),
        ].at(-1)?.[1] ?? ''
    } catch {
      /* 読めない結果を承認しない */
    }
    if (verdict !== 'approved') reasons.push(`${label}のレビューが承認で終わっていません。`)
  }
  if (!result) reasons.push('結果の報告が読めないため確認してください。')
  if (result && !result.verify.passed) reasons.push('確認コマンドが通っていません。')
  if (result?.envFailure) reasons.push(`環境が原因: ${result.envFailure}`)
  if (issue.decisions.length) reasons.push('AI が判断した点があります。')
  if (status.checks === 'fail') reasons.push('CI が失敗しました。')
  if (hostsOf(tick.config).find((h) => h.id === (issue.host ?? LOCAL_HOST))?.repos[repo]?.verified !== true)
    reasons.push('確認できないリポジトリです。')
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
  if (!canAutoCall('レビューの監視')) return
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
  const deadline = beginAutoTick(budget)
  if (!takeLock(name, budget + 60_000)) {
    endAutoTick()
    return 1
  }
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
      deadline,
      errors: 0,
      dispatched: 0,
      finished: 0,
      startUsed: false,
      deferred: new Set(),
      reachable: new Map(),
      unreachable: new Set(),
    }
    const blocked = new Set(
      Object.values(state.issues)
        .filter((i) => held(tick, i))
        .map((i) => i.key),
    )
    for (const issue of Object.values(state.issues)) {
      if (!ACTIVE.includes(issue.phase) || !issue.host || issue.host === LOCAL_HOST) continue
      if (!reachable(tick, issue.host)) {
        tick.unreachable.add(issue.key)
        blocked.add(issue.key)
        if (!issue.hostUnreachableSince) {
          issue.hostUnreachableSince = autoNow()
          tick.save()
        }
        if (issue.startedAt && Date.parse(autoNow()) - Date.parse(issue.startedAt) > issue.limitMinutes * 60_000)
          notifyStalled(
            tick,
            issue,
            `${hostsOf(config).find((h) => h.id === issue.host)?.name ?? issue.host} につながりません`,
          )
      } else if (issue.hostUnreachableSince !== null) {
        issue.hostUnreachableSince = null
        tick.save()
      }
    }
    for (const issue of Object.values(state.issues))
      if (
        !tick.unreachable.has(issue.key) &&
        (issue.phase !== 'running' ||
          issue.pendingLabel ||
          issue.failReason ||
          issue.startAttempt ||
          issue.cleanupPending) &&
        timedOut(issue) &&
        canAutoCall('上限時間')
      )
        markFailure(tick, issue, `上限時間（${issue.limitMinutes} 分）を超えました。`)
    for (const issue of Object.values(state.issues)) {
      if (
        issue.pendingLabel &&
        !blocked.has(issue.key) &&
        (!issue.failReason || issue.pendingLabel.event === 'failed')
      ) {
        if (!canAutoCall('ラベル再試行')) break
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
    for (const key of synced.unreadable) blocked.add(key)
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
    for (const issue of Object.values(state.issues)) {
      if (issue.phase !== 'running' || blocked.has(issue.key)) continue
      progress(tick, issue)
      if (!issue.failReason && timedOut(issue) && canAutoCall('上限時間')) {
        markFailure(tick, issue, `上限時間（${issue.limitMinutes} 分）を超えました。`)
        finishFailure(tick, issue)
        clean(tick, issue)
      }
    }
    for (const issue of Object.values(state.issues))
      if (issue.phase === 'dispatching' && !blocked.has(issue.key)) recover(tick, issue)
    refill(tick)
    const hosts = hostsOf(config).map((host) => ({ host, ...capacityOf(tick, host, false) }))
    if (
      !writeAtomic(join(autoDir(name), AUTO_FILES.report), JSON.stringify(buildReport(config, state, hosts, autoNow())))
    )
      throw new Error('報告を書けません')
    tick.errors += autoCallErrors()
    const judging = Object.values(state.issues).filter((i) => i.phase === 'judging' && !i.pendingLabel).length
    console.log(`auto: judge=${judging} dispatched=${tick.dispatched} finished=${tick.finished} errors=${tick.errors}`)
    return judging > 0 &&
      (!state.judgingSince || Date.parse(autoNow()) - Date.parse(state.judgingSince) > AUTO_JUDGE_LEASE_MS)
      ? 0
      : 1
  } finally {
    releaseLock(name)
    endAutoTick()
  }
}
