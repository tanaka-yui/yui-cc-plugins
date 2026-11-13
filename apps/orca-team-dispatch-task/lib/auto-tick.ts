import { type AutoConfig, pickSources, readAutoConfig } from './auto-config.ts'
import { ensureCoordinator, openCoordinator } from './auto-coordinator.ts'
import { readGithub } from './auto-github.ts'
import { AUTO_FILES, archiveStatusDir, autoDir, autoNow } from './auto-paths.ts'
import { orderQueue, syncIssues } from './auto-queue.ts'
import { buildRequest, slugOf } from './auto-request.ts'
import { type AutoState, type IssueState, readState, releaseLock, takeLock, writeState } from './auto-state.ts'
import { resumeTransition, transition } from './auto-transition.ts'
import { roleNames } from './config.ts'
import { readJson, writeAtomic } from './fs.ts'
import { asObject, asString, get, type Json, type JsonObject } from './json.ts'
import { receiptArray, runOrca } from './orca.ts'
import { STATUS } from './status.ts'
import { envCount, run, runNode } from './sys.ts'

import { existsSync, mkdirSync, readFileSync, statfsSync } from 'node:fs'
import { freemem, hostname } from 'node:os'
import { join, resolve } from 'node:path'

export const AUTO_TICK_BUDGET_MS = 100_000
export const AUTO_START_RESERVE_MS = 60_000
export const AUTO_START_MAX_FAILURES = 3
export const AUTO_WORKTREE_LIST_LIMIT = 1000
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
  return receiptArray(
    runOrca(['orchestration', 'worker-list', '--run', id, '--json'], { ORCA_TERMINAL_HANDLE: h }),
    'workers',
  )
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
const start = (tick: Tick, issue: IssueState, args: string[], h: string, fresh: boolean): void => {
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
    started(tick, issue, workers)
    return
  }
  issue.startFailures++
  if (issue.startFailures >= AUTO_START_MAX_FAILURES)
    issue.failReason = `worker を起動できませんでした（${issue.startFailures} 回）。`
  tick.save()
  if (result.stderr) console.log(result.stderr.trim())
  if (!existsSync(join(issue.statusDir, 'workers.json'))) retireStart(tick, issue)
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
        buildRequest(issue, detail.body, repo, tick.config.roles, join(statusDir, 'auto-result.json'), null),
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
      if (issue.pendingLabel && !blocked.has(issue.key)) resumeTransition(issue, tick.save)
    const sources = pickSources(config)
    syncIssues(
      state,
      config.sources.filter((s) => sources.includes(s.repo)),
    )
    tick.save()
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
