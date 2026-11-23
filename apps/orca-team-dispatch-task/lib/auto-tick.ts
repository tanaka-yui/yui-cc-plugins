import { backMergeInput } from './auto-backmerge.ts'
import { actualBases, restrictedBase } from './auto-base.ts'
import { autoCleanup, confirmStopped, pushBranches, unrecordedWorker } from './auto-cleanup.ts'
import { limitBreakdown, renderComment } from './auto-comment.ts'
import {
  type AutoConfig,
  intakeActiveRepos,
  pickSources,
  readAutoConfig,
  readIntakeRepos,
  relayAllowance,
  sourceAutoMerge,
} from './auto-config.ts'
import { ensureCoordinator, openCoordinator } from './auto-coordinator.ts'
import { continuationOf, github, type PrStatus, prStatus, readGithub, viewIssue } from './auto-github.ts'
import { envArgs, hostAvailableMemoryMb, hostKey, hostsOf, LOCAL_HOST } from './auto-hosts.ts'
import {
  applyCancels,
  type EndRecorder,
  endRecorder,
  onProbation,
  readHistory,
  readStore,
  reflectDue,
} from './auto-learn.ts'
import {
  AUTO_CALL_CAP_MS,
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
  hasAutoTime,
  autoRun as run,
  autoOrca as runOrca,
} from './auto-paths.ts'
import { type ProjectSyncContext, syncProjects } from './auto-project.ts'
import { awaitingBase, markUnlabeledBacklog, orderQueue, syncIssues } from './auto-queue.ts'
import { buildReport } from './auto-report.ts'
import { buildRequest, readAutoResult, readPlanResult, slugOf } from './auto-request.ts'
import { type AutoState, type IssueState, limitOf, readState, releaseLock, takeLock, writeState } from './auto-state.ts'
import { hasCommentMarker, resumeTransition, transition } from './auto-transition.ts'
import { roleNames } from './config.ts'
import { readJson, writeAtomic } from './fs.ts'
import { asArray, asObject, asString, get, type Json, type JsonObject } from './json.ts'
import { repoTargets, resultFileOf, roleWorktrees } from './multi-repo.ts'
import { runOrca as orcaWithin, receiptArray, receiptOk } from './orca.ts'
import { fetchBranch } from './remote-branch.ts'
import { listRemoteRepos, probeRemote } from './setup-host.ts'
import { worktreeCost } from './setup-lanes.ts'
import { STATUS } from './status.ts'
import { availableMemoryMb, envCount, runNode as runProcessNode } from './sys.ts'

import { existsSync, mkdirSync, readdirSync, readFileSync, statfsSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import type { HostConfig } from './auto-hosts.ts'

export const AUTO_START_RESERVE_MS = 60_000
export const AUTO_START_MAX_FAILURES = 3
export const AUTO_CREATE_SETTLE_SECS = 20
// 遠くの空きディスクは端末を作って測る（1 台 16 秒前後。2026-11-22、Mac M5max）ので、1 台 1 時間に 1 回まで
export const AUTO_DISK_PROBE_INTERVAL_MS = 60 * 60_000
// 測定は始めたら端末を閉じるまで止められない。読み取りの最大（setup-host の PROBE_READ_ATTEMPTS 回）と close が入る残り
export const AUTO_DISK_PROBE_RESERVE_MS = 60_000
const runNode = (script: string, args: string[], inherit = false, env?: Record<string, string>) =>
  canAutoCall('子の実行') ? runProcessNode(script, args, inherit, env) : { rc: 1, stdout: '', stderr: 'timed out' }
const ACTIVE = ['dispatching', 'running', 'finishing']
type Tick = {
  name: string
  config: AutoConfig
  state: AutoState
  save: () => void
  // 世代の結果を履歴に残す口
  onEnd: EndRecorder
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

const branchesOf = (workers: JsonObject, checkout: string): Record<string, string> => {
  if (repoTargets(workers, checkout).length <= 1) return {}
  const role = asString(workers.integration_role) ?? 'design'
  return Object.fromEntries(
    roleWorktrees(workers, checkout, role)
      .filter((w) => w.branch)
      .map((w) => [w.repo, w.branch]),
  )
}
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
  issue.branches = branchesOf(workers, tick.config.repos[issue.targets[0] ?? '']?.checkout ?? '')
  tick.save()
  transition(
    issue,
    'started',
    {
      reason: issue.reason,
      limitMinutes: issue.limitMinutes,
      relayMinutes: issue.relayMinutes,
      branch: issue.branch,
      ...(repoTargets(workers, tick.config.repos[issue.targets[0] ?? '']?.checkout ?? '').length > 1
        ? {
            branches: issue.targets.flatMap((repo) =>
              issue.branches[repo] ? [{ repo, branch: issue.branches[repo] ?? '' }] : [],
            ),
          }
        : {}),
    },
    STATUS.ready,
    STATUS.inProgress,
    false,
    'running',
    tick.save,
    tick.onEnd,
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
      issue.branches = branchesOf(workers, tick.config.repos[issue.targets[0] ?? '']?.checkout ?? '')
      tick.save()
      return
    }
    started(tick, issue, workers)
    return
  }
  issue.startFailures++
  if (issue.startFailures >= AUTO_START_MAX_FAILURES) {
    issue.failReason = `worker を起動できませんでした（${issue.startFailures} 回）。`
    issue.failEnv = true
  }
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
        const environment = asString(get(r, 'environment')) ?? LOCAL_HOST
        return [r, ...Object.values(asObject(get(r, 'extra')) ?? {})].flatMap((w) => {
          const path = asString(get(w, 'worktree_path'))
          return path ? [hostKey(environment, path)] : []
        })
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
  const rolesPerRepo = roleNames(tick.config.roles.review_mode, tick.config.roles.phase_b).length
  const sources = new Set(pickSources(tick.config))
  // 今の空きメモリ（MB）。tick 内で 1 台 1 回だけ読む。遠くは Orca の diagnostics で、読めなければ null（並列数だけで数える）
  const freeMemory = new Map<string, number | null>()
  const freeMemoryOf = (host: HostConfig): number | null => {
    if (!freeMemory.has(host.id)) {
      if (host.id === LOCAL_HOST)
        freeMemory.set(host.id, Number(process.env.ORCA_AUTO_FREE_MEMORY_MB ?? availableMemoryMb()))
      else {
        const response = runOrca(['diagnostics', 'memory', ...envArgs(host.id), '--json'])
        freeMemory.set(host.id, receiptOk(response) ? hostAvailableMemoryMb(response.json) : null)
      }
    }
    return freeMemory.get(host.id) ?? null
  }
  const queue = orderQueue(
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
  )
  for (const issue of queue) {
    if (tick.startUsed || !canAutoCall('補充の起動', AUTO_START_RESERVE_MS)) break
    const targets = issue.targets
    const repos: Array<{ name: string; options: AutoConfig['repos'][string] }> = []
    for (const name of targets) {
      const options = tick.config.repos[name]
      if (options) repos.push({ name, options })
    }
    const primary = repos[0]
    if (!primary || repos.length !== targets.length) continue
    const target = primary.name
    const repo = primary.options
    const required = rolesPerRepo * targets.length
    const verified = capacities.filter((c) => targets.every((t) => c.host.repos[t]?.verified === true))
    let candidates = (verified.length ? verified : capacities).filter(
      (c) => c.reachable && c.readable && targets.every((t) => c.host.repos[t]) && c.used + required <= c.host.lanes,
    )
    if (!candidates.length) {
      if (capacities.some((c) => c.reachable && c.readable && c.used + required <= c.host.lanes)) {
        console.log(`この Issue を入れられるマシンがありません: ${issue.key}`)
        continue
      }
      for (const c of capacities.filter((c) => c.reachable && c.readable))
        console.log(`レーンが足りません: lanes=${c.host.lanes} 使用中=${c.used} 1 件の worktree=${required}`)
      if (
        required > rolesPerRepo &&
        capacities.some((c) => c.reachable && c.readable && c.used + rolesPerRepo <= c.host.lanes)
      )
        continue
      break
    }
    let freeDisk = Number.POSITIVE_INFINITY
    let unreadable = false
    for (const r of repos) {
      try {
        const stats = statfsSync(r.options.checkout)
        freeDisk = Math.min(freeDisk, (stats.bavail * stats.bsize) / 1024 / 1024)
      } catch {
        error(tick, `checkout を読めません: ${r.options.checkout}`)
        unreadable = true
        break
      }
    }
    if (unreadable) continue
    const local = candidates.find((c) => c.host.id === LOCAL_HOST)
    if (
      local &&
      (Number(freeMemoryOf(local.host)) < tick.config.minFreeMemoryMb ||
        Number(process.env.ORCA_AUTO_FREE_DISK_MB ?? freeDisk) < tick.config.minFreeDiskMb)
    ) {
      console.log('空きメモリまたはディスクが足りません')
      candidates = candidates.filter((c) => c.host.id !== LOCAL_HOST)
    }
    // 遠くのディスクは diagnostics に無いので、tick の終わりに間隔を空けて測った値（state の hostDisk）を使う
    const freeDiskOf = (host: HostConfig): number | null =>
      host.id === LOCAL_HOST
        ? Number(process.env.ORCA_AUTO_FREE_DISK_MB ?? freeDisk)
        : (tick.state.hostDisk?.[host.id]?.diskFreeMb ?? null)
    candidates = candidates.filter((c) => {
      if (c.host.id === LOCAL_HOST) return true
      const memory = freeMemoryOf(c.host)
      if (memory !== null && memory < tick.config.minFreeMemoryMb) {
        console.log(`${c.host.name} の空きメモリが足りません`)
        return false
      }
      const disk = freeDiskOf(c.host)
      if (disk !== null && disk < tick.config.minFreeDiskMb) {
        console.log(`${c.host.name} の空きディスクが足りません`)
        return false
      }
      return true
    })
    // 余力 = 並列数の残り・今の空きメモリに入る worktree の数・空きディスクに入る worktree の数の最小。
    // 1 worktree 分は setup で測った値（無ければ既定）。読めない値は数えない
    const roomOf = (c: (typeof candidates)[number]): number => {
      const cost = worktreeCost(targets.map((t) => c.host.repos[t]?.measure ?? null))
      const memory = freeMemoryOf(c.host)
      const disk = freeDiskOf(c.host)
      return Math.min(
        c.host.lanes - c.used,
        memory === null ? Number.POSITIVE_INFINITY : Math.floor((memory - tick.config.minFreeMemoryMb) / cost.memoryMb),
        disk === null ? Number.POSITIVE_INFINITY : Math.floor((disk - tick.config.minFreeDiskMb) / cost.diskMb),
      )
    }
    const chosen = candidates.sort(
      (a, b) =>
        roomOf(b) - roomOf(a) ||
        (b.host.lanes - b.used) / b.host.lanes - (a.host.lanes - a.used) / a.host.lanes ||
        Number(b.host.id === LOCAL_HOST) - Number(a.host.id === LOCAL_HOST),
    )[0]
    if (!chosen) continue
    const host = chosen.host
    const hostRepo = host.repos[target]
    if (!hostRepo) continue
    const dirty = repos.find((r) => {
      const status = run('git', ['-C', r.options.checkout, 'status', '--porcelain'])
      return status.rc !== 0 || status.stdout.trim()
    })
    if (dirty) {
      console.log(`未コミットの変更があるため補充しません: ${dirty.options.checkout}`)
      continue
    }
    const slug = slugOf(issue.key)
    const statusDir = join(repo.checkout, '.dispatch', slug)
    if (existsSync(statusDir)) {
      console.log(`status dir が残っています: ${statusDir}`)
      continue
    }
    const defaults: Record<string, string> = {}
    for (const r of repos) {
      const branch =
        issue.bases[r.name] ??
        asString(get(readGithub(['repo', 'view', '--json', 'defaultBranchRef', r.name]), 'defaultBranchRef', 'name'))
      if (
        !branch ||
        run('git', ['-C', r.options.checkout, 'fetch', 'origin', branch]).rc !== 0 ||
        run('git', ['-C', r.options.checkout, 'checkout', '-B', branch, `origin/${branch}`]).rc !== 0
      ) {
        // 決めた向き先なら名前を出す。既定ブランチの名前を GitHub から読めなかったときは名前が無い
        error(tick, `${branch ? `向き先ブランチ（${branch}）` : 'default ブランチ'}を用意できません: ${r.name}`)
        break
      }
      defaults[r.name] = branch
    }
    if (Object.keys(defaults).length !== targets.length) continue
    const defaultBranch = defaults[target]
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
          repos,
          tick.config.roles,
          continuationOf(issue, issue.endedAt ?? issue.updatedAt, defaults),
        ),
      )
    )
      throw new Error('依頼文を書けません')
    const reposFile = join(autoDir(tick.name), 'requests', `${slug}-g${issue.generation}.repos.json`)
    if (
      targets.length === 2 &&
      !writeAtomic(
        reposFile,
        JSON.stringify(
          repos.map((r) => ({
            repo: r.name,
            checkout: r.options.checkout,
            host_repo: host.repos[r.name]?.selector ?? '',
            base_branch: `origin/${defaults[r.name]}`,
          })),
        ),
      )
    )
      throw new Error('リポジトリの一覧を書けません')
    const h = openCoordinator(repo.checkout, slug)
    if (!h) continue
    if (!targets.every((t) => host.repos[t]?.verified) && !issue.reason.includes('確認が通っていないマシンで実装'))
      issue.reason += '（確認が通っていないマシンで実装）'
    Object.assign(issue, {
      phase: 'dispatching',
      slug,
      statusDir,
      coordinator: h,
      worktrees: required,
      host: host.id,
      bases: { ...issue.bases, ...defaults },
      relayMinutes: relayAllowance(tick.config.roles, tick.config.everyMinutes),
    })
    tick.save()
    start(
      tick,
      issue,
      [
        '--transport',
        'mail',
        ...(targets.length === 2 ? ['--repos-file', reposFile] : []),
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
  if (queue.length) probeDisk(tick, capacities)
}
// 待っている Issue があるときだけ、測ってから間隔が過ぎた遠くのマシンを 1 台（最も古いもの）測る。結果は次の tick から使う。
// 測定の端末は Orca が遠くのマシンに開いて閉じる。測れなかったときも時刻を残し、間隔まで測り直さない
const probeDisk = (tick: Tick, capacities: Array<{ host: HostConfig; reachable: boolean }>): void => {
  const now = autoNow()
  const due = capacities
    .filter((c) => c.host.id !== LOCAL_HOST && c.reachable)
    .map((c) => ({ host: c.host, at: Date.parse(tick.state.hostDisk?.[c.host.id]?.measuredAt ?? '') || 0 }))
    .filter((d) => Date.parse(now) - d.at >= AUTO_DISK_PROBE_INTERVAL_MS)
    .sort((a, b) => a.at - b.at)[0]
  if (!due || !hasAutoTime(AUTO_DISK_PROBE_RESERVE_MS)) return
  const orca = (args: string[]) => orcaWithin(args, undefined, envCount('ORCA_AUTO_CALL_CAP_MS', AUTO_CALL_CAP_MS))
  const host = due.host
  let path: string | null = null
  for (const r of Object.values(host.repos)) {
    if (r.selector.startsWith('path:')) path = r.selector.slice('path:'.length)
    else if (r.selector.startsWith('id:'))
      path = listRemoteRepos(host.id, orca)?.find((row) => `id:${row.id}` === r.selector)?.path ?? null
    if (path) break
  }
  const diskFreeMb = path
    ? (probeRemote(host.id, `path:${path}`, now, 'orca-auto-disk', orca).spec?.diskFreeMb ?? null)
    : null
  if (diskFreeMb === null) console.log(`${host.name} の空きディスクを測れませんでした`)
  tick.state.hostDisk = { ...tick.state.hostDisk, [host.id]: { diskFreeMb, measuredAt: now } }
  tick.save()
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
    // つながらないマシンの上での失敗は環境が原因
    if (issue.hostUnreachableSince !== null) issue.failEnv = true
    issue.cleanupPending = true
    tick.save()
    stopRoles(tick, issue)
  }
}
const overLimit = (issue: IssueState): string =>
  `上限時間（${limitOf(issue)} 分）を超えました${limitBreakdown(issue.limitMinutes, issue.relayMinutes)}。`
const timedOut = (issue: IssueState): boolean =>
  Boolean(
    issue.startedAt &&
      ['running', 'dispatching'].includes(issue.phase) &&
      issue.pendingLabel?.event !== 'failed' &&
      Date.parse(autoNow()) - Date.parse(issue.startedAt) > limitOf(issue) * 60_000,
  )
const humanStop = (tick: Tick, issue: IssueState, labels: string[] = []): void => {
  if (!canAutoCall('人の変更')) return
  issue.phase = 'stopped'
  issue.pendingLabel = null
  issue.failReason = null
  issue.cleanupPending = true
  issue.endedAt = autoNow()
  tick.onEnd(issue, 'stopped', labels)
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
    relayMinutes: issue.relayMinutes,
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
    markFailure(tick, issue, overLimit(issue))
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

// PR ごとの実際の向き先（repo → ブランチ）。読めなかった PR は含めない
const realBases = (prs: Array<{ repo: string }>, statuses: Array<PrStatus | null>): Record<string, string> =>
  Object.fromEntries(
    prs.flatMap((p, i) => {
      const base = statuses[i]?.baseRefName
      return base ? [[p.repo, base]] : []
    }),
  )
const AUTO_CI_APPEAR_MINUTES = 30
const AUTO_PR_RETRY_MINUTES = 30
export const prevBranchesOf = (issue: IssueState, multi: boolean): Record<string, string> => {
  if (!multi) {
    const branch = issue.prevTargets.length <= 1 ? issue.prevBranch : issue.prevBranches[issue.targets[0] ?? '']
    return branch ? { '': branch } : {}
  }
  return Object.fromEntries(
    issue.targets.flatMap((repo) => {
      const branch = issue.prevBranches[repo]
      return branch ? [[repo, branch]] : []
    }),
  )
}

const clean = (tick: Tick, issue: IssueState): void => {
  if (!canAutoCall('後片付け')) return
  if (!issue.cleanupPending || issue.failReason || issue.pendingLabel || issue.startAttempt || !owns(tick, issue))
    return
  const checkout = tick.config.repos[issue.targets[0] ?? '']?.checkout
  if (!checkout) return
  if (existsSync(join(issue.statusDir, 'run.json')) && !ensure(tick, issue)) return
  const targets = repoTargets(workersOf(issue), checkout)
  const multi = targets.length > 1
  let mergedRepos = issue.phase === 'done' ? targets.map((t) => t.repo) : []
  if (issue.phase !== 'done' && issue.prs.length) {
    const statuses = issue.prs.map((p) => prStatus(p.repo, p.number))
    if (statuses.some((s) => s === null)) return
    mergedRepos = multi
      ? issue.prs.filter((_, i) => statuses[i]?.state === 'MERGED').map((p) => p.repo)
      : statuses.every((s) => s?.state === 'MERGED')
        ? ['']
        : []
  }
  const result = autoCleanup(
    issue.statusDir,
    join(autoDir(tick.name), AUTO_FILES.archive),
    issue.generation,
    mergedRepos,
    prevBranchesOf(issue, multi),
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
  const pushed = pushBranches(issue.statusDir, [])
  const multi = repoTargets(workersOf(issue), checkout).length > 1
  const result = readAutoResult(join(issue.statusDir, 'auto-result.json'))
  const reason = issue.failReason + (result?.envFailure ? ` 環境が原因: ${result.envFailure}` : '')
  // 遷移の保存で一緒に残し、続きの tick で遷移が終わったときに読む
  if (result?.envFailure) issue.failEnv = true
  const view = viewIssue(issue.repo, issue.number)
  if (!view) return
  const from = view.labels.includes(STATUS.inProgress) ? STATUS.inProgress : STATUS.ready
  if (
    transition(
      issue,
      'failed',
      {
        reason,
        branch: issue.branch,
        pushed: pushed.pushed,
        ...(multi
          ? {
              branches: issue.targets.flatMap((repo) =>
                issue.branches[repo] ? [{ repo, branch: issue.branches[repo] ?? '' }] : [],
              ),
            }
          : {}),
      },
      from,
      STATUS.failed,
      false,
      'failed',
      tick.save,
      tick.onEnd,
    )
  )
    tick.finished++
}
const needsReview = (tick: Tick, issue: IssueState, reason: string): void => {
  if (
    transition(
      issue,
      'needs-review',
      { reason, prs: issue.prs, decisions: issue.decisions, reviewPoints: issue.reviewPoints },
      STATUS.inProgress,
      STATUS.inReview,
      false,
      'review',
      tick.save,
      tick.onEnd,
    )
  )
    tick.finished++
}
// 判定が頼った規則に様子見の途中のものがあるか。規則を読めなければ様子見を終えたと確かめられないので true
const probationOf = (name: string, issue: IssueState): boolean => {
  if (!issue.learn || issue.learn.ruleIds.length === 0) return false
  try {
    return onProbation(readStore(name), issue.learn.ruleIds)
  } catch (cause) {
    console.log(
      `学びの規則を読めないので人の確認に回します: ${issue.key}（${cause instanceof Error ? cause.message : String(cause)}）`,
    )
    return true
  }
}
const handoverPrs = (issue: IssueState, multi: boolean): { ok: boolean; reasons: string[] } => {
  const reasons: string[] = []
  if (!multi && (!issue.prevBranch || issue.prevBranch === issue.branch)) return { ok: true, reasons }
  if (!multi && !issue.prs[0]) return { ok: true, reasons }
  for (const previous of issue.prevPrs) {
    const current = multi ? issue.prs.find((p) => p.repo === previous.repo) : issue.prs[0]
    if (previous.repo === current?.repo && previous.number === current.number) continue
    const status = prStatus(previous.repo, previous.number)
    if (!status) return { ok: false, reasons }
    if (status.state !== 'OPEN') continue
    if (!current) {
      reasons.push(`前の世代の PR が残っています: ${previous.repo}#${previous.number}`)
      continue
    }
    const marker = `<!-- orca-auto:handover:${issue.generation}:${slugOf(issue.key)} -->`
    const posted = hasCommentMarker({ ...issue, repo: previous.repo, number: previous.number }, marker)
    if (posted === null) return { ok: false, reasons }
    const body = `${current.repo}#${current.number} に引き継ぎました: ${current.url}\n\n${marker}`
    if (!posted && github(['pr', 'comment', String(previous.number), '--repo', previous.repo, '--body', body]).rc !== 0)
      return { ok: false, reasons }
    if (github(['pr', 'close', String(previous.number), '--repo', previous.repo]).rc !== 0)
      return { ok: false, reasons }
  }
  return { ok: true, reasons }
}
const finish = (tick: Tick, issue: IssueState): void => {
  if (!canAutoCall('仕上げ')) return
  if (issue.pendingLabel || issue.failReason || issue.startAttempt || !owns(tick, issue)) return
  const view = viewIssue(issue.repo, issue.number)
  if (!view) return
  if (view.state !== 'OPEN' || !view.labels.includes(STATUS.inProgress)) {
    humanStop(tick, issue, view.labels)
    return
  }
  issue.finishingSince ??= autoNow()
  tick.save()
  const repo = issue.targets[0] ?? ''
  const options = tick.config.repos[repo]
  if (!options) return
  const result = readAutoResult(join(issue.statusDir, 'auto-result.json'))
  const workers = workersOf(issue)
  const targets = repoTargets(workers, options.checkout)
  const multi = targets.length > 1
  const needsPlanResult = workers?.transport === 'mail' && workers.integration_role === 'exec'
  const planResult = needsPlanResult ? readPlanResult(join(issue.statusDir, 'plan-result.json')) : null
  const planLegacy = planResult !== null && planResult.needsReview === undefined
  const resultLegacy = result !== null && result.needsReview === undefined
  issue.decisions = [
    ...(planResult && !planLegacy ? planResult.decisions.map((s) => `計画で決めた点: ${s}`) : []),
    ...(result && !resultLegacy ? result.decisions : []),
  ]
  issue.reviewPoints = [
    ...(planResult
      ? [
          ...(planLegacy
            ? planResult.decisions.map((s) => `計画で決めた点: ${s}`)
            : (planResult.needsReview ?? []).map((s) => `計画で確認が要る点: ${s}`)),
          ...planResult.review.unresolved.map((s) => `計画の未解消の指摘: ${s}`),
          ...planResult.review.declined.map((s) => `計画で採らなかった指摘: ${s}`),
        ]
      : []),
    ...(result
      ? [
          ...(resultLegacy ? result.decisions : (result.needsReview ?? [])),
          ...result.review.unresolved.map((s) => `未解消の指摘: ${s}`),
          ...result.review.declined.map((s) => `採らなかった指摘: ${s}`),
        ]
      : []),
  ]
  tick.save()
  if (multi) {
    const role = asString(workers?.integration_role) ?? ''
    const worktrees = roleWorktrees(workers, options.checkout, role)
    for (const target of targets) {
      if (issue.prs.some((p) => p.repo === target.repo)) continue
      const branch = worktrees.find((w) => w.repo === target.repo)?.branch ?? ''
      if (asString(get(workers, 'roles', role, 'environment')) && !fetchBranch(target.checkout, branch)) {
        if (Date.parse(autoNow()) - Date.parse(issue.finishingSince) >= AUTO_PR_RETRY_MINUTES * 60_000)
          needsReview(tick, issue, `${branch} が origin にありません`)
        return
      }
      const created = runNode(child('orca-pr.ts'), ['--status-dir', issue.statusDir, '--repo', target.repo])
      const pr =
        created.rc === 0
          ? asObject(readGithub(['pr', 'view', '--repo', target.repo, '--json', 'number,url', branch]))
          : null
      if (!pr || typeof pr.number !== 'number' || typeof pr.url !== 'string') {
        if (Date.parse(autoNow()) - Date.parse(issue.finishingSince) >= AUTO_PR_RETRY_MINUTES * 60_000)
          needsReview(
            tick,
            issue,
            asString(get(readJson(resultFileOf(issue.statusDir, target.repo)), 'reason')) || 'PR を作れません',
          )
        return
      }
      issue.prs.push({ repo: target.repo, number: pr.number, url: pr.url })
      issue.prs.sort(
        (a, b) => targets.findIndex((t) => t.repo === a.repo) - targets.findIndex((t) => t.repo === b.repo),
      )
      tick.save()
    }
    issue.prs.sort((a, b) => targets.findIndex((t) => t.repo === a.repo) - targets.findIndex((t) => t.repo === b.repo))
    tick.save()
  } else if (!issue.prs.length) {
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
  const handover = handoverPrs(issue, multi)
  if (!handover.ok) return
  if (multi && handover.reasons.length) {
    needsReview(tick, issue, handover.reasons.join(' '))
    return
  }
  const pr = issue.prs[0]
  if (!pr) return
  const statuses = (multi ? issue.prs : [pr]).map((p) => prStatus(p.repo, p.number))
  if (statuses.some((s) => !s)) return
  const status = statuses[0]
  if (!status) return
  if (multi ? statuses.every((s) => s?.state === 'MERGED') : status.state === 'MERGED') {
    const back = issue.pendingLabel
      ? {}
      : backMergeInput(issue, targets, repo, tick.config.repos, realBases(multi ? issue.prs : [pr], statuses))
    if (!back) return
    if (
      transition(
        issue,
        'ai-merged',
        { prs: issue.prs, summary: result?.summary, decisions: issue.decisions, ...back },
        STATUS.inProgress,
        STATUS.done,
        true,
        'done',
        tick.save,
        tick.onEnd,
      )
    )
      tick.finished++
    return
  }
  if (multi) {
    if (!statuses.some((s) => s?.state === 'CLOSED')) {
      if (statuses.some((s) => s?.state === 'OPEN' && s.checks === 'pending')) return
      if (
        statuses.some(
          (s, i) => s?.state === 'OPEN' && s.checks === 'none' && tick.config.repos[issue.prs[i]?.repo ?? '']?.ci,
        )
      ) {
        if (Date.parse(autoNow()) - Date.parse(issue.finishingSince) >= AUTO_CI_APPEAR_MINUTES * 60_000)
          needsReview(tick, issue, 'CI が始まりません')
        return
      }
    }
  } else {
    if (status.checks === 'pending') return
    if (status.checks === 'none' && options.ci && status.state === 'OPEN') {
      if (Date.parse(autoNow()) - Date.parse(issue.finishingSince) >= AUTO_CI_APPEAR_MINUTES * 60_000)
        needsReview(tick, issue, 'CI が始まりません')
      return
    }
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
  if (issue.reviewPoints.length) reasons.push('人の確認が要る点があります。')
  // 拾う元の autoMerge が有効なら、auto-ready の Issue も他の条件がそろえば merge する（向き先の制限は下で効く）
  if (issue.autoReady && !sourceAutoMerge(tick.config, issue.repo))
    reasons.push('AI が Backlog から Ready にした Issue なので、merge の前に人が確認します。')
  if (probationOf(tick.name, issue)) reasons.push('新しい学びで自動にした Issue なので、merge の前に人が確認します。')
  if (multi ? statuses.some((s) => s?.state === 'OPEN' && s.checks === 'fail') : status.checks === 'fail')
    reasons.push('CI が失敗しました。')
  const host = hostsOf(tick.config).find((h) => h.id === (issue.host ?? LOCAL_HOST))
  if (multi ? targets.some((t) => host?.repos[t.repo]?.verified !== true) : host?.repos[repo]?.verified !== true)
    reasons.push('確認できないリポジトリです。')
  if (multi ? targets.some((t) => tick.config.repos[t.repo]?.infra) : options.infra)
    reasons.push('インフラの変更は確認が必要です。')
  if (multi ? statuses.some((s) => s?.state === 'CLOSED') : status.state === 'CLOSED')
    reasons.push('PR が閉じられています。')
  // 記録が無い Issue の向き先は run が実際に使ったものに揃える（戻しの PR と同じ解決）。読めなければ理由を足さない。
  // PR の実際の向き先（人が付け替えた・前の世代の PR を拾った）が違えば、それも人に回し、制限はその向き先でも見る
  const expected = actualBases(issue.bases, targets, repo)
  const real = realBases(multi ? issue.prs : [pr], statuses)
  for (const [r, b] of Object.entries(real)) {
    const want = expected.find((e) => e.repo === r)?.base
    if (want && want !== b) reasons.push(`${r} の PR の向き先（${b}）が決めた向き先（${want}）と違います。`)
  }
  for (const base of new Set(
    [...expected, ...Object.entries(real).map(([r, b]) => ({ repo: r, base: b }))].flatMap(({ repo: r, base: b }) =>
      b && restrictedBase(r, b, tick.config.repos) ? [b] : [],
    ),
  ))
    reasons.push(`普段の向き先でない（${base}）への merge は人が確認します。`)
  if (reasons.length) {
    needsReview(tick, issue, reasons.join(' '))
    return
  }
  if (multi) {
    const mergeability: Array<{ repo: string; number: number; value: string }> = []
    for (const [i, p] of issue.prs.entries()) {
      if (statuses[i]?.state !== 'OPEN') continue
      const view = asObject(readGithub(['pr', 'view', String(p.number), '--repo', p.repo, '--json', 'mergeable']))
      if (!view) return
      mergeability.push({ repo: p.repo, number: p.number, value: asString(view.mergeable) ?? '' })
    }
    const conflicts = mergeability.filter((m) => m.value === 'CONFLICTING')
    if (conflicts.length) {
      needsReview(tick, issue, conflicts.map((m) => `${m.repo}#${m.number} が衝突しています。`).join(' '))
      return
    }
    if (mergeability.some((m) => m.value !== 'MERGEABLE')) return
  }
  const mergedPrs = multi ? issue.prs.filter((_, i) => statuses[i]?.state === 'MERGED') : []
  for (const pr of multi ? issue.prs.filter((_, i) => statuses[i]?.state === 'OPEN') : [issue.prs[0]]) {
    if (!pr) continue
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
      if (multi && mergedPrs.length) {
        const unmergedPrs = issue.prs
          .filter((p) => !mergedPrs.some((m) => m.repo === p.repo && m.number === p.number))
          .map((p) => ({ ...p, why: 'merge できませんでした' }))
        if (
          transition(
            issue,
            'partial-merge',
            { mergedPrs, unmergedPrs, decisions: issue.decisions },
            STATUS.inProgress,
            STATUS.inReview,
            false,
            'review',
            tick.save,
            tick.onEnd,
          )
        )
          tick.finished++
      } else needsReview(tick, issue, 'PR を merge できませんでした。')
      return
    }
    mergedPrs.push(pr)
  }
  const back = issue.pendingLabel ? {} : backMergeInput(issue, targets, repo, tick.config.repos, real)
  if (!back) return
  if (
    transition(
      issue,
      'ai-merged',
      { prs: issue.prs, summary: result?.summary, decisions: issue.decisions, ...back },
      STATUS.inProgress,
      STATUS.done,
      true,
      'done',
      tick.save,
      tick.onEnd,
    )
  )
    tick.finished++
}
const watchReview = (tick: Tick, issue: IssueState): void => {
  if (!canAutoCall('レビューの監視')) return
  const view = viewIssue(issue.repo, issue.number)
  if (!view) return
  if (view.state === 'CLOSED') {
    tick.onEnd(issue, 'stopped', view.labels)
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
    tick.onEnd(issue, 'stopped', view.labels)
    tick.save()
    return
  }
  if (!issue.prs.length) return
  if (issue.targets.length > 1) {
    if (issue.prs.length < issue.targets.length) return
    for (const previous of issue.prevPrs) {
      if (issue.prs.some((p) => p.repo === previous.repo)) continue
      const status = prStatus(previous.repo, previous.number)
      if (!status || status.state === 'OPEN') return
    }
  }
  const statuses = issue.prs.map((p) => prStatus(p.repo, p.number))
  if (!statuses.every((s) => s?.state === 'MERGED')) return
  const repo = issue.targets[0] ?? ''
  // review に入った Issue は後片付けで状態ディレクトリが移されていることが多く、run の記録（workers.json）から
  // 2 つ目の対象が読めない。そのときは状態の targets から対象を立てる（向き先は issue.bases から引く）
  const fromRun = repoTargets(workersOf(issue), tick.config.repos[repo]?.checkout ?? '')
  const targets =
    fromRun.length < 2 && issue.targets.length > 1 ? issue.targets.map((r) => ({ repo: r, baseBranch: '' })) : fromRun
  const back = issue.pendingLabel
    ? {}
    : backMergeInput(issue, targets, repo, tick.config.repos, realBases(issue.prs, statuses))
  if (!back) return
  if (
    transition(
      issue,
      'human-merged',
      { prs: issue.prs, ...back },
      STATUS.inReview,
      STATUS.done,
      true,
      'done',
      tick.save,
      tick.onEnd,
    )
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
      onEnd: endRecorder(name),
      deadline,
      errors: 0,
      dispatched: 0,
      finished: 0,
      startUsed: false,
      deferred: new Set(),
      reachable: new Map(),
      unreachable: new Set(),
    }
    try {
      applyCancels(name, config.intakeConfigs.map(dirname), autoNow(), console.log)
    } catch (e) {
      console.log(`学びの取り消しを反映できません: ${e instanceof Error ? e.message : String(e)}`)
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
        if (issue.startedAt && Date.parse(autoNow()) - Date.parse(issue.startedAt) > limitOf(issue) * 60_000)
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
        markFailure(tick, issue, overLimit(issue))
    for (const issue of Object.values(state.issues)) {
      if (
        issue.pendingLabel &&
        !blocked.has(issue.key) &&
        (!issue.failReason || issue.pendingLabel.event === 'failed')
      ) {
        if (!canAutoCall('ラベル再試行')) break
        const before = issue.phase
        resumeTransition(issue, tick.save, false, tick.onEnd)
        if (issue.phase === 'stopped' && before !== 'stopped') stopRoles(tick, issue)
      }
    }
    for (const path of readIntakeRepos(config).unreadable) error(tick, `intake の設定を読めません: ${path}`)
    const picked = pickSources(config)
    const sources = config.sources.filter((s) => picked.includes(s.repo))
    const active = intakeActiveRepos(config, console.log)
    const projectSync: ProjectSyncContext = {
      sources,
      state,
      save: tick.save,
      log: console.log,
      active,
      statuses: new Map(),
      failed: new Set(),
      touched: new Set(),
    }
    syncProjects(projectSync)
    // Project の同期で Status を読んだあとに、ステータスの無い slack-thread の Issue へ Backlog を付ける
    markUnlabeledBacklog(sources, active, projectSync, console.log)
    const synced = syncIssues(state, sources, active, console.log, tick.onEnd)
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
        markFailure(tick, issue, overLimit(issue))
        finishFailure(tick, issue)
        clean(tick, issue)
      }
    }
    for (const issue of Object.values(state.issues))
      if (issue.phase === 'dispatching' && !blocked.has(issue.key)) recover(tick, issue)
    refill(tick)
    syncProjects(projectSync)
    const hosts = hostsOf(config).map((host) => ({ host, ...capacityOf(tick, host, false) }))
    if (
      !writeAtomic(join(autoDir(name), AUTO_FILES.report), JSON.stringify(buildReport(config, state, hosts, autoNow())))
    )
      throw new Error('報告を書けません')
    tick.errors += autoCallErrors()
    // 向き先のラベルを待っている Issue では判定を起こさない（judge-list も出さない）
    const judging = Object.values(state.issues).filter((i) => {
      const asked = synced.asked[i.key]
      const autoReady = sources.find((s) => s.repo === i.repo)?.autoReady === true
      return i.phase === 'judging' && !i.pendingLabel && !(asked && awaitingBase(i, asked, autoReady, config.repos))
    }).length
    // 振り返りが要るリポジトリ。judge-list の reflect と同じ一覧で数える。
    // 履歴か規則を読めなければ（judge-list も振り返りを出さないので）1 行出して数えない
    let learn = 0
    try {
      readStore(name)
      learn = reflectDue(
        readHistory(name),
        config.sources.map((s) => s.repo),
      ).length
    } catch (error) {
      console.log(`判定の学びを読めません（${error instanceof Error ? error.message : String(error)}）`)
    }
    console.log(
      `auto: judge=${judging} dispatched=${tick.dispatched} finished=${tick.finished} errors=${tick.errors} learn=${learn}`,
    )
    // 判定待ちが無くても、振り返りが要れば判定の AI を起こす（リースの条件は同じ）
    return (judging > 0 || learn > 0) &&
      (!state.judgingSince || Date.parse(autoNow()) - Date.parse(state.judgingSince) > AUTO_JUDGE_LEASE_MS)
      ? 0
      : 1
  } finally {
    releaseLock(name)
    endAutoTick()
  }
}
