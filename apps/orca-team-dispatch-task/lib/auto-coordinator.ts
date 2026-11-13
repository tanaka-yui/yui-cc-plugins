import { readJson, writeAtomic } from './fs.ts'
import { asObject, asString, get } from './json.ts'
import { receiptOk, runOrca } from './orca.ts'

import { join } from 'node:path'

export const openCoordinator = (worktreePath: string, slug: string): string | null => {
  const result = runOrca([
    'terminal',
    'create',
    '--worktree',
    `path:${worktreePath}`,
    '--title',
    `orca-auto:${slug}`,
    '--json',
  ])
  return receiptOk(result) ? asString(get(result.json, 'result', 'terminal', 'handle')) : null
}
export const ensureCoordinator = (statusDir: string, worktreePath: string, slug: string): string | null => {
  const file = join(statusDir, 'run.json')
  const record = asObject(readJson(file))
  const handle = asString(record?.parent_handle)
  const run = asString(record?.run_id)
  if (!record || !handle || !run) return null
  const terminal = runOrca(['terminal', 'show', '--terminal', handle, '--json'])
  const current = runOrca(['orchestration', 'run-current', '--from', handle, '--json'], {
    ORCA_TERMINAL_HANDLE: handle,
  })
  if (
    receiptOk(terminal) &&
    get(terminal.json, 'result', 'terminal', 'handle') === handle &&
    get(terminal.json, 'result', 'terminal', 'orphaned') !== true &&
    get(terminal.json, 'result', 'terminal', 'connected') === true &&
    receiptOk(current) &&
    get(current.json, 'result', 'run', 'id') === run &&
    get(current.json, 'result', 'run', 'coordinator_handle') === handle
  )
    return handle
  const next = openCoordinator(worktreePath, slug)
  if (!next) return null
  const used = runOrca(['orchestration', 'run-use', '--id', run, '--from', next, '--json'], {
    ORCA_TERMINAL_HANDLE: next,
  })
  if (receiptOk(used) && writeAtomic(file, JSON.stringify({ ...record, parent_handle: next }))) return next
  runOrca(['terminal', 'close', '--terminal', next, '--json'])
  return null
}
export const closeCoordinator = (statusDir: string): void => {
  const handle = asString(get(readJson(join(statusDir, 'run.json')), 'parent_handle'))
  if (handle) runOrca(['terminal', 'close', '--terminal', handle, '--json'])
}
