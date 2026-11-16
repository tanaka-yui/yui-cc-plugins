import { closeCoordinator } from './auto-coordinator.ts'
import { envArgs, LOCAL_HOST } from './auto-hosts.ts'
import { AUTO_WORKTREE_LIST_LIMIT, archiveStatusDir, autoRun as run, autoOrca as runOrca } from './auto-paths.ts'
import { readJson, writeAtomic } from './fs.ts'
import { asArray, asObject, asString, get, type Json, type JsonObject } from './json.ts'
import { repoTargets, roleWorktrees } from './multi-repo.ts'
import {
  dispatchSettled,
  GONE_STATES,
  receiptArray,
  receiptOk,
  releaseState,
  userOwned,
  workerState,
  workerStateClass,
} from './orca.ts'
import { fetchBranch, remoteHead, savedOnOrigin } from './remote-branch.ts'

import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'

const readWorkers = (statusDir: string) => asObject(readJson(join(statusDir, 'workers.json')))
const rolesOf = (workers: JsonObject | null) => asObject(workers?.roles) ?? {}
const roleDispatches = (data: Json): string[] => {
  const r = asObject(data)
  return [r?.dispatch, ...(asArray(r?.superseded) ?? []), ...(asArray(r?.follow_ups) ?? [])].filter(
    (id): id is string => typeof id === 'string' && id.length > 0,
  )
}
export const unrecordedWorker = (statusDir: string, workers: JsonObject, rows: Json[]): string | null => {
  const roles = rolesOf(workers)
  const known = new Map(
    Object.entries(roles).flatMap(([role, data]) => roleDispatches(data).map((id): [string, string] => [id, role])),
  )
  const h = asString(get(readJson(join(statusDir, 'run.json')), 'parent_handle'))
  for (const row of rows) {
    const dispatch = asString(get(row, 'dispatchId'))
    if (!dispatch || known.has(dispatch)) continue
    if (!h) return dispatch
    let current = dispatch
    const seen = new Set([dispatch])
    for (;;) {
      const shown = runOrca(['orchestration', 'worker-show', '--dispatch', current, '--json'], {
        ORCA_TERMINAL_HANDLE: h,
      })
      const parent = receiptOk(shown) ? asString(get(shown.json, 'result', 'dispatch', 'followUpOf')) : null
      if (!parent || seen.has(parent)) return dispatch
      seen.add(parent)
      const role = known.get(parent)
      if (role) {
        const record = asObject(roles[role]) ?? {}
        record.follow_ups = [...(asArray(record.follow_ups) ?? []), dispatch]
        roles[role] = record
        if (!writeAtomic(join(statusDir, 'workers.json'), `${JSON.stringify(workers)}\n`)) return dispatch
        known.set(dispatch, role)
        break
      }
      current = parent
    }
  }
  return null
}
const git = (checkout: string, ...args: string[]) => run('git', ['-C', checkout, ...args])
const existsBranch = (checkout: string, branch: string) =>
  git(checkout, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`)
const ahead = (checkout: string, branch: string, base: string): boolean => {
  const result = git(checkout, 'rev-list', '--count', `refs/remotes/origin/${base}..refs/heads/${branch}`)
  return result.rc !== 0 || result.stdout.trim() !== '0'
}
export type RemoteRow = { present: boolean; head: string }
export const pushBranches = (
  statusDir: string,
  skipRepos: string[],
  remote: Record<string, RemoteRow> = {},
  prevBranches: Record<string, string> = {},
): { pushed: boolean; reasons: string[] } => {
  const workers = readWorkers(statusDir)
  const root = asString(get(readJson(join(statusDir, 'run.json')), 'repo_root')) ?? ''
  const targets = repoTargets(workers, root)
  if ((!workers && existsSync(join(statusDir, 'workers.json'))) || !targets.length)
    return { pushed: false, reasons: ['worker の記録を読めません'] }
  const integration = roleWorktrees(workers, root, asString(workers?.integration_role) ?? '')
  const reasons: string[] = []
  const seen = new Set<string>()
  for (const [role, data] of Object.entries(rolesOf(workers))) {
    const environment = asString(get(data, 'environment'))
    if (environment && role !== workers?.integration_role) continue
    for (const w of roleWorktrees(workers, root, role)) {
      const branch = w.branch
      const key = `${w.repo}\t${branch}`
      if (
        !branch ||
        (skipRepos.includes(w.repo) && branch === integration.find((i) => i.repo === w.repo)?.branch) ||
        seen.has(key)
      )
        continue
      seen.add(key)
      const base = targets.find((t) => t.repo === w.repo)?.integrationBranch ?? ''
      const previous = prevBranches[w.repo] ?? null
      if (environment) {
        if (
          fetchBranch(w.checkout, branch) ||
          remote[`${role}\t${w.repo}`]?.present === false ||
          savedOnOrigin(w.checkout, remote[`${role}\t${w.repo}`]?.head ?? '', [base, previous])
        )
          continue
        reasons.push(`${branch} は origin にもこの Mac にもありません`)
        continue
      }
      const found = existsBranch(w.checkout, branch)
      if (found.rc !== 0) {
        if (found.rc !== 1 || found.stderr) reasons.push(`ブランチを読めません: ${branch}`)
        continue
      }
      if (!ahead(w.checkout, branch, base)) continue
      if (git(w.checkout, 'push', 'origin', `refs/heads/${branch}:refs/heads/${branch}`).rc !== 0)
        reasons.push(`push できません: ${branch}`)
    }
  }
  return { pushed: reasons.length === 0, reasons }
}
export const confirmStopped = (statusDir: string): { stopped: boolean; kept: string[]; reasons: string[] } => {
  const workers = readWorkers(statusDir)
  const roles = rolesOf(workers)
  const record = asObject(readJson(join(statusDir, 'run.json')))
  const id = asString(record?.run_id)
  const h = asString(record?.parent_handle)
  const known = new Set(Object.values(roles).flatMap(roleDispatches))
  if (!workers && existsSync(join(statusDir, 'workers.json')))
    return { stopped: false, kept: [], reasons: ['worker の記録を読めません'] }
  if (!id || !h)
    return {
      stopped: !existsSync(join(statusDir, 'run.json')) && known.size === 0,
      kept: [],
      reasons: known.size || existsSync(join(statusDir, 'run.json')) ? ['Run の記録を読めません'] : [],
    }
  const env = { ORCA_TERMINAL_HANDLE: h }
  const environments = new Set(
    Object.values(roles)
      .map((r) => asString(get(r, 'environment')))
      .filter((v): v is string => !!v),
  )
  let listError = 'worker の一覧を読めません'
  // ★ followUp に端末の持ち主が移った元の dispatch は、release が ownership_transferred の retained を返し続け、
  //   released にならない（2026-11-16 の実機）。決着した dispatch で、Orca が結びついた資源は無いと言う行も
  //   止まった証拠にする。端末を持つ followUp の行はこの関数で別に確かめる
  const gone = (row: Json | undefined, data: Json | undefined): boolean =>
    asString(get(data, 'environment'))
      ? get(row, 'projection', 'liveness', 'verdict') === 'exited'
      : GONE_STATES.includes(releaseState(row)) ||
        (dispatchSettled(asString(get(row, 'dispatchStatus')) ?? '') &&
          get(row, 'projection', 'resource', 'state') === 'absent')
  const list = (): Json[] | null => {
    const response = runOrca(
      ['orchestration', 'worker-list', '--run', id, ...(environments.size ? ['--include-remote'] : []), '--json'],
      env,
    )
    const partial = (asArray(get(response.json, 'result', 'partialHostErrors')) ?? []).find((e) =>
      environments.has(asString(get(e, 'environmentId')) ?? ''),
    )
    if (partial) {
      listError = `${asString(get(partial, 'environmentId'))} の worker を確かめられません`
      return null
    }
    const rows = receiptArray(response, 'workers')
    return rows?.every((w) => Boolean(asString(get(w, 'dispatchId')))) ? rows : null
  }
  const unexpected = (rows: Json[]) =>
    !workers ? rows.length > 0 : Boolean(unrecordedWorker(statusDir, workers, rows))
  let rows = list()
  const kept: string[] = []
  const keptDispatches = new Set<string>()
  const reasons: string[] = []
  if (!rows || unexpected(rows))
    return {
      stopped: false,
      kept,
      reasons: [rows ? '起動の結果が不明です（記録の無い worker）' : listError],
    }
  for (const [role, data] of Object.entries(roles)) {
    for (const dispatch of roleDispatches(data)) {
      const row = rows.find((w) => get(w, 'dispatchId') === dispatch)
      if (!row) {
        reasons.push(`worker の行がありません: ${role}`)
        continue
      }
      if (gone(row, data)) continue
      const shown = runOrca(['orchestration', 'worker-show', '--dispatch', dispatch, '--json'], env)
      const state = receiptOk(shown) ? workerStateClass(workerState(shown.json)) : 'other'
      if (userOwned(row)) {
        if (state === 'settled') {
          kept.push(`${role} ${asString(asObject(data)?.worktree_path) ?? ''}`)
          keptDispatches.add(dispatch)
        } else reasons.push(`人が操作中の worker: ${role}`)
        continue
      }
      const settled =
        receiptOk(shown) &&
        (dispatchSettled(asString(get(shown.json, 'result', 'dispatch', 'status')) ?? '') || state === 'settled')
      if (!settled && state !== 'live' && state !== 'unconfirmed') {
        reasons.push(`worker の停止を確かめられません: ${role}`)
        continue
      }
      runOrca(['orchestration', settled ? 'worker-release' : 'worker-stop', '--dispatch', dispatch, '--json'], env)
      const after = list()
      if (
        !after ||
        unexpected(after) ||
        !gone(
          after.find((w) => get(w, 'dispatchId') === dispatch),
          data,
        )
      )
        reasons.push(`worker が解放されていません: ${role}`)
      if (after) rows = after
    }
  }
  for (const row of rows)
    if (
      !gone(
        row,
        Object.values(roles).find((r) => roleDispatches(r).includes(asString(get(row, 'dispatchId')) ?? '')),
      ) &&
      !keptDispatches.has(asString(get(row, 'dispatchId')) ?? '')
    )
      reasons.push(`worker が解放されていません: ${asString(get(row, 'dispatchId'))}`)
  return { stopped: reasons.length === 0, kept, reasons }
}
export const autoCleanup = (
  statusDir: string,
  archiveDir: string,
  generation: number,
  mergedRepos: string[],
  prevBranches: Record<string, string> = {},
): { ok: boolean; pushed: boolean; reasons: string[] } => {
  const workers = readWorkers(statusDir)
  const root = asString(get(readJson(join(statusDir, 'run.json')), 'repo_root')) ?? ''
  const targets = repoTargets(workers, root)
  if ((!workers && existsSync(join(statusDir, 'workers.json'))) || !targets.length)
    return { ok: false, pushed: false, reasons: ['worker の記録を読めません'] }
  const stopped = confirmStopped(statusDir)
  if (!stopped.stopped) return { ok: false, pushed: false, reasons: stopped.reasons }
  const integrationRole = asString(workers?.integration_role) ?? ''
  const integration = roleWorktrees(workers, root, integrationRole)
  const roles = Object.entries(rolesOf(workers))
  const lists = new Map<string, Json[]>()
  const remote: Record<string, RemoteRow> = {}
  for (const [role, data] of roles) {
    const environment = asString(get(data, 'environment'))
    if (!environment) continue
    if (!lists.has(environment)) {
      const response = runOrca([
        'worktree',
        'list',
        ...envArgs(environment),
        '--limit',
        String(AUTO_WORKTREE_LIST_LIMIT),
        '--json',
      ])
      const rows = receiptArray(response, 'worktrees')
      if (!rows || get(response.json, 'result', 'truncated') === true)
        return { ok: false, pushed: false, reasons: [`worktree の一覧を読めません: ${environment}`] }
      lists.set(environment, rows)
    }
    for (const w of roleWorktrees(workers, root, role)) {
      const row = lists.get(environment)?.find((r) => get(r, 'path') === w.worktreePath)
      remote[`${role}\t${w.repo}`] = { present: !!row, head: asString(get(row, 'head')) ?? '' }
    }
  }
  const pushed = pushBranches(statusDir, mergedRepos, remote, prevBranches)
  if (!pushed.pushed) return { ok: false, ...pushed }
  const reasons = [...stopped.reasons, ...pushed.reasons]
  const kept = new Set(stopped.kept.map((line) => line.split(' ', 1)[0]))
  if (roles.some(([, data]) => !asString(get(data, 'environment')))) {
    const response = runOrca(['worktree', 'list', '--limit', String(AUTO_WORKTREE_LIST_LIMIT), '--json'])
    const rows = receiptArray(response, 'worktrees')
    if (!rows || get(response.json, 'result', 'truncated') === true)
      return { ok: false, pushed: true, reasons: [...reasons, 'worktree の一覧を読めません'] }
    lists.set(LOCAL_HOST, rows)
  }
  let ok = true
  for (const [role, data] of roles) {
    if (kept.has(role)) continue
    const environment = asString(get(data, 'environment'))
    for (const w of roleWorktrees(workers, root, role)) {
      const path = w.worktreePath
      const branch = w.branch
      const base = targets.find((t) => t.repo === w.repo)?.integrationBranch ?? ''
      const previous = prevBranches[w.repo] ?? null
      const merged = mergedRepos.includes(w.repo)
      const row = path ? lists.get(environment ?? LOCAL_HOST)?.find((r) => get(r, 'path') === path) : null
      if (environment && path && !row) reasons.push(`遠くの worktree はもうありません: ${environment} ${path}`)
      if (path && row) {
        if (environment) {
          const head = asString(get(row, 'head')) ?? ''
          const completion = readJson(join(statusDir, 'roles', role, 'completion.json'))
          const acceptedHead =
            asString(get(completion, 'heads', w.repo)) ?? (w.primary ? (asString(get(completion, 'head')) ?? '') : '')
          const isIntegration = role === integrationRole
          const saved = head
            ? savedOnOrigin(w.checkout, head, [branch, base, previous]) ||
              (isIntegration && merged && head === acceptedHead)
            : isIntegration && !!acceptedHead && !!branch && remoteHead(w.checkout, branch) === acceptedHead
          if (!saved) {
            ok = false
            reasons.push(`保存を証明できないため遠くの worktree を残しました: ${environment} ${path}`)
            continue
          }
        }
        const removed = runOrca([
          'worktree',
          'rm',
          ...envArgs(environment ?? LOCAL_HOST),
          '--worktree',
          `path:${path}`,
          '--force',
          '--delete-branch',
          '--json',
        ])
        if (!receiptOk(removed)) {
          ok = false
          reasons.push(`worktree を消せません: ${path}`)
          continue
        }
      }
      if (!branch || existsBranch(w.checkout, branch).rc !== 0) continue
      const local = git(w.checkout, 'rev-parse', '--verify', `refs/heads/${branch}`)
      const remoteRef = git(w.checkout, 'rev-parse', '--verify', `refs/remotes/origin/${branch}`)
      const same = local.rc === 0 && remoteRef.rc === 0 && local.stdout.trim() === remoteRef.stdout.trim()
      const safe =
        same ||
        (merged && branch === integration.find((i) => i.repo === w.repo)?.branch) ||
        (!environment && !ahead(w.checkout, branch, base))
      if (safe) {
        if (git(w.checkout, 'branch', '-D', branch).rc !== 0) {
          ok = false
          reasons.push(`ブランチを消せません: ${branch}`)
        }
      } else reasons.push(`保存を証明できないためブランチを残しました: ${branch}`)
    }
  }
  if (!ok) return { ok: false, pushed: true, reasons }
  closeCoordinator(statusDir)
  if (!archiveStatusDir(statusDir, archiveDir, `${basename(statusDir)}-g${generation}`))
    return { ok: false, pushed: true, reasons: [...reasons, 'status dir を退避できません'] }
  for (const keptRole of stopped.kept) console.log(`人が操作した端末のため残しました: ${keptRole}`)
  return { ok: true, pushed: true, reasons }
}
