import { closeCoordinator } from './auto-coordinator.ts'
import { AUTO_WORKTREE_LIST_LIMIT, archiveStatusDir, autoRun as run, autoOrca as runOrca } from './auto-paths.ts'
import { readJson } from './fs.ts'
import { asObject, asString, get, type Json, type JsonObject } from './json.ts'
import { GONE_STATES, receiptArray, receiptOk, releaseState, userOwned, workerState, workerStateClass } from './orca.ts'

import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'

const readWorkers = (statusDir: string) => asObject(readJson(join(statusDir, 'workers.json')))
const rolesOf = (workers: JsonObject | null) => asObject(workers?.roles) ?? {}
const git = (checkout: string, ...args: string[]) => run('git', ['-C', checkout, ...args])
const existsBranch = (checkout: string, branch: string) =>
  git(checkout, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`)
const ahead = (checkout: string, branch: string, base: string): boolean => {
  const result = git(checkout, 'rev-list', '--count', `refs/remotes/origin/${base}..refs/heads/${branch}`)
  return result.rc !== 0 || result.stdout.trim() !== '0'
}
export const pushBranches = (
  statusDir: string,
  checkout: string,
  skip: string | null,
): { pushed: boolean; reasons: string[] } => {
  const workers = readWorkers(statusDir)
  if (!workers && existsSync(join(statusDir, 'workers.json')))
    return { pushed: false, reasons: ['worker の記録を読めません'] }
  const base = asString(workers?.integration_branch) ?? ''
  const reasons: string[] = []
  for (const branch of new Set(
    Object.values(rolesOf(workers))
      .map((r) => asString(asObject(r)?.branch))
      .filter((b): b is string => Boolean(b)),
  )) {
    if (branch === skip) continue
    const found = existsBranch(checkout, branch)
    if (found.rc !== 0) {
      if (found.rc !== 1 || found.stderr) reasons.push(`ブランチを読めません: ${branch}`)
      continue
    }
    if (!ahead(checkout, branch, base)) continue
    const pushed = git(checkout, 'push', 'origin', `refs/heads/${branch}:refs/heads/${branch}`)
    if (pushed.rc !== 0) reasons.push(`push できません: ${branch}`)
  }
  return { pushed: reasons.length === 0, reasons }
}
export const confirmStopped = (statusDir: string): { stopped: boolean; kept: string[]; reasons: string[] } => {
  const workers = readWorkers(statusDir)
  const roles = rolesOf(workers)
  const record = asObject(readJson(join(statusDir, 'run.json')))
  const id = asString(record?.run_id)
  const h = asString(record?.parent_handle)
  const known = new Set(
    Object.values(roles)
      .map((r) => asString(asObject(r)?.dispatch))
      .filter((d): d is string => Boolean(d)),
  )
  if (!workers && existsSync(join(statusDir, 'workers.json')))
    return { stopped: false, kept: [], reasons: ['worker の記録を読めません'] }
  if (!id || !h)
    return {
      stopped: !existsSync(join(statusDir, 'run.json')) && known.size === 0,
      kept: [],
      reasons: known.size || existsSync(join(statusDir, 'run.json')) ? ['Run の記録を読めません'] : [],
    }
  const env = { ORCA_TERMINAL_HANDLE: h }
  const list = (): Json[] | null => {
    const rows = receiptArray(runOrca(['orchestration', 'worker-list', '--run', id, '--json'], env), 'workers')
    return rows?.every((w) => Boolean(asString(get(w, 'dispatchId')))) ? rows : null
  }
  const unexpected = (rows: Json[]) => rows.some((w) => !known.has(asString(get(w, 'dispatchId')) ?? ''))
  let rows = list()
  const kept: string[] = []
  const reasons: string[] = []
  if (!rows || unexpected(rows))
    return {
      stopped: false,
      kept,
      reasons: [rows ? '起動の結果が不明です（記録の無い worker）' : 'worker の一覧を読めません'],
    }
  for (const [role, data] of Object.entries(roles)) {
    const dispatch = asString(asObject(data)?.dispatch)
    if (!dispatch) continue
    const row = rows.find((w) => get(w, 'dispatchId') === dispatch)
    if (!row) {
      reasons.push(`worker の行がありません: ${role}`)
      continue
    }
    if (GONE_STATES.includes(releaseState(row))) continue
    const shown = runOrca(['orchestration', 'worker-show', '--dispatch', dispatch, '--json'], env)
    const state = receiptOk(shown) ? workerStateClass(workerState(shown.json)) : 'other'
    if (userOwned(row)) {
      if (state === 'settled') kept.push(`${role} ${asString(asObject(data)?.worktree_path) ?? ''}`)
      else reasons.push(`人が操作中の worker: ${role}`)
      continue
    }
    if (state !== 'settled' && state !== 'live' && state !== 'unconfirmed') {
      reasons.push(`worker の停止を確かめられません: ${role}`)
      continue
    }
    runOrca(
      ['orchestration', state === 'settled' ? 'worker-release' : 'worker-stop', '--dispatch', dispatch, '--json'],
      env,
    )
    const after = list()
    if (
      !after ||
      unexpected(after) ||
      !GONE_STATES.includes(releaseState(after.find((w) => get(w, 'dispatchId') === dispatch)))
    )
      reasons.push(`worker が解放されていません: ${role}`)
    if (after) rows = after
  }
  return { stopped: reasons.length === 0, kept, reasons }
}
export const autoCleanup = (
  statusDir: string,
  checkout: string,
  archiveDir: string,
  generation: number,
  merged: boolean,
): { ok: boolean; pushed: boolean; reasons: string[] } => {
  const stopped = confirmStopped(statusDir)
  if (!stopped.stopped) return { ok: false, pushed: false, reasons: stopped.reasons }
  const workers = readWorkers(statusDir)
  const integration = asString(get(workers, 'roles', asString(workers?.integration_role) ?? '', 'branch'))
  const pushed = pushBranches(statusDir, checkout, merged ? integration : null)
  if (!pushed.pushed) return { ok: false, ...pushed }
  const reasons = [...stopped.reasons, ...pushed.reasons]
  const kept = new Set(stopped.kept.map((line) => line.split(' ', 1)[0]))
  const roles = Object.entries(rolesOf(workers))
  if (roles.length) {
    const response = runOrca(['worktree', 'list', '--limit', String(AUTO_WORKTREE_LIST_LIMIT), '--json'])
    const list = receiptArray(response, 'worktrees')
    if (!list || get(response.json, 'result', 'truncated') === true)
      return { ok: false, pushed: true, reasons: [...reasons, 'worktree の一覧を読めません'] }
    let ok = true
    for (const [role, data] of roles) {
      if (kept.has(role)) continue
      const path = asString(asObject(data)?.worktree_path)
      const branch = asString(asObject(data)?.branch)
      if (path && list.some((w) => get(w, 'path') === path)) {
        const removed = runOrca([
          'worktree',
          'rm',
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
      if (!branch || existsBranch(checkout, branch).rc !== 0) continue
      const local = git(checkout, 'rev-parse', '--verify', `refs/heads/${branch}`)
      const remote = git(checkout, 'rev-parse', '--verify', `refs/remotes/origin/${branch}`)
      const same = local.rc === 0 && remote.rc === 0 && local.stdout.trim() === remote.stdout.trim()
      const safe =
        same ||
        !ahead(checkout, branch, asString(workers?.integration_branch) ?? '') ||
        (merged && branch === integration)
      if (safe) {
        if (git(checkout, 'branch', '-D', branch).rc !== 0) {
          ok = false
          reasons.push(`ブランチを消せません: ${branch}`)
        }
      } else reasons.push(`保存を証明できないためブランチを残しました: ${branch}`)
    }
    if (!ok) return { ok: false, pushed: true, reasons }
  }
  closeCoordinator(statusDir)
  if (!archiveStatusDir(statusDir, archiveDir, `${basename(statusDir)}-g${generation}`))
    return { ok: false, pushed: true, reasons: [...reasons, 'status dir を退避できません'] }
  for (const keptRole of stopped.kept) console.log(`人が操作した端末のため残しました: ${keptRole}`)
  return { ok: true, pushed: true, reasons }
}
