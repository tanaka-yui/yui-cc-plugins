// 自分の worker たちの worker_done を待つ。
// Usage: node orca-wait.ts --status-dir <d> [--status-dir <d> ...] [--max-waits <n>]
//        [--timeout-ms <n>] [--stall-after-min <n>] [--on-stall ask|report]
// Exit: 0 全件成功 / 5 失敗 / 1 batch 不明 / 2 使用法 / 3 時間切れ / 4 transport 不明
//       / 6 worker の質問 / 8 停滞
// ★ cursor は ack だけで進む。batch を全件処理できなければ ack しない。
import { die, log } from '../lib/cli.ts'
import { readJson, writeAtomic } from '../lib/fs.ts'
import { asArray, asObject, asString, get, type Json, type JsonObject, parseJson } from '../lib/json.ts'
import { orcaBin, receiptOk, runOrca } from '../lib/orca.ts'
import { envCount, nowSeconds, run, runNode, sleepSeconds } from '../lib/sys.ts'

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const NAME = 'orca-wait'
const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_MAX_WAITS = 288
const DEFAULT_TIMEOUT_MS = 300000
const DEFAULT_STALL_MIN = 120
type Entry = { statusDir: string; role: string; task: string; dispatch: string }
type Expected = { parent: string; run: string; entries: Entry[] }
type State = {
  statusDirs: string[]
  maxWaits: number
  timeoutMs: number
  onStall: 'ask' | 'report'
  stallSeconds: number
  wakeInterval: number
  waiterRetry: number
  waiterTries: number
  settleGrace: number
  expected: Expected
  settleSeen: Map<string, number>
  unknown: { type: string; task: string; dispatch: string; batch: string }
}
const string = (value: Json | undefined): string => asString(value) ?? ''
const object = (value: Json | undefined): JsonObject => asObject(value) ?? {}
const array = (value: Json | undefined): Json[] | null => asArray(value)
const read = (statusDir: string, name: string): Json | null => readJson(join(statusDir, name))
const write = (statusDir: string, name: string, content: Json): boolean =>
  writeAtomic(join(statusDir, name), `${JSON.stringify(content)}\n`)
const readable = (file: string): boolean => {
  try {
    readFileSync(file)
    return true
  } catch {
    return false
  }
}
const nonempty = (file: string): boolean => {
  try {
    return statSync(file).size > 0
  } catch {
    return false
  }
}
const loadRoles = (statusDirs: string[]): Expected => {
  let parent = ''
  let run = ''
  const entries: Entry[] = []
  for (const statusDir of statusDirs) {
    if (!readable(join(statusDir, 'run.json')) || !readable(join(statusDir, 'workers.json'))) {
      die(NAME, `cannot read the dispatch state in ${statusDir}`)
    }
    const currentParent = string(get(read(statusDir, 'run.json'), 'parent_handle'))
    const currentRun = string(get(read(statusDir, 'run.json'), 'run_id'))
    if (currentParent === '' || currentRun === '') die(NAME, `the dispatch identity is incomplete in ${statusDir}`)
    if (parent !== '' && parent !== currentParent) die(NAME, 'the status dirs do not share one parent terminal')
    if (run !== '' && run !== currentRun) die(NAME, 'the status dirs do not share one Run')
    let found = false
    const roles = object(get(read(statusDir, 'workers.json'), 'roles'))
    for (const role of Object.keys(roles).sort()) {
      const task = string(get(roles[role], 'task'))
      const dispatch = string(get(roles[role], 'dispatch'))
      if (task === '' && dispatch === '') continue
      if (task === '' || dispatch === '')
        die(NAME, `the dispatch identity is incomplete for role '${role}' in ${statusDir}`)
      if (entries.some((entry) => entry.task === task && entry.dispatch === dispatch)) {
        die(NAME, `the same dispatch is named twice (task '${task}' dispatch '${dispatch}')`)
      }
      entries.push({ statusDir, role, task, dispatch })
      found = true
    }
    if (!found) die(NAME, `no dispatched role is recorded in ${statusDir}`)
    parent = currentParent
    run = currentRun
  }
  return { parent, run, entries }
}
const rolesKey = (state: State): string =>
  state.expected.entries.map((entry) => `${entry.task}|${entry.dispatch}`).join('\n')
const indexOf = (state: State, task: string, dispatch: string): number =>
  state.expected.entries.findIndex((entry) => entry.task === task && entry.dispatch === dispatch)
// ★ lifecycle の副作用より先に、ディスク上の現行 dispatch を確かめる。
const stillCurrent = (entry: Entry): boolean =>
  string(get(readJson(join(entry.statusDir, 'workers.json')), 'roles', entry.role, 'dispatch')) === entry.dispatch
const supersededBy = (statusDirs: string[], dispatch: string): { statusDir: string; role: string } | null => {
  for (const statusDir of statusDirs) {
    const roles = object(get(readJson(join(statusDir, 'workers.json')), 'roles'))
    for (const [role, record] of Object.entries(roles)) {
      if ((array(get(record, 'superseded')) ?? []).includes(dispatch)) return { statusDir, role }
    }
  }
  return null
}
type Resolved =
  | { kind: 'current'; index: number }
  | { kind: 'superseded'; statusDir: string; role: string }
  | { kind: 'unknown' }
const resolveDispatch = (state: State, task: string, dispatch: string): Resolved => {
  const index = indexOf(state, task, dispatch)
  const entry = state.expected.entries[index]
  if (entry !== undefined) return stillCurrent(entry) ? { kind: 'current', index } : { kind: 'unknown' }
  const replaced = supersededBy(state.statusDirs, dispatch)
  return replaced === null ? { kind: 'unknown' } : { kind: 'superseded', ...replaced }
}
const beat = (state: State): void => {
  for (const statusDir of state.statusDirs)
    write(statusDir, 'wait.json', { pid: process.pid, beat: nowSeconds(), window_ms: state.timeoutMs })
}
// ★ 破損や重複のある receipt を正常と扱うと、ack の根拠が消える。
const storedOutcome = (statusDir: string, role: string): string | null => {
  const workers = read(statusDir, 'workers.json')
  const task = string(get(workers, 'roles', role, 'task'))
  const dispatch = string(get(workers, 'roles', role, 'dispatch'))
  const file = join(statusDir, 'received.json')
  if (!existsSync(file)) return ''
  if (!nonempty(file)) return ''
  const entries = array(readJson(file))
  if (entries === null || entries.some((entry) => typeof entry !== 'string' || entry.split('|').length !== 4)) {
    log(NAME, 'received outcome record is invalid or unreadable; it is not acknowledged')
    return null
  }
  const matches = entries.filter(
    (entry) => typeof entry === 'string' && entry.startsWith(`worker_done|${task}|${dispatch}|`),
  )
  if (matches.length > 1) {
    log(NAME, 'received outcome record has duplicate receipts; it is not acknowledged')
    return null
  }
  return matches.length === 0 ? '' : (String(matches[0]).split('|')[3] ?? '')
}
const isStopped = (statusDir: string, role: string): boolean =>
  existsSync(join(statusDir, 'roles', role, 'stopped.json'))
const roleOutcome = (statusDir: string, role: string): string | null => {
  const outcome = storedOutcome(statusDir, role)
  return outcome === '' && isStopped(statusDir, role) ? 'stopped' : outcome
}
const fileMtime = (file: string): number => {
  try {
    return Math.floor(statSync(file).mtimeMs / 1000)
  } catch {
    return 0
  }
}
const taskLastChange = (statusDir: string): number => {
  let latest = fileMtime(join(statusDir, 'run.json'))
  const newer = (file: string): void => {
    latest = Math.max(latest, fileMtime(file))
  }
  const rolesDir = join(statusDir, 'roles')
  try {
    for (const role of readdirSync(rolesDir)) {
      for (const name of ['status.json', 'result.md', 'completion.json']) newer(join(rolesDir, role, name))
    }
  } catch {
    /* 子のファイルがまだ無い */
  }
  for (const name of ['spec.md', 'plan.md', 'human.json']) newer(join(statusDir, name))
  try {
    for (const name of readdirSync(join(statusDir, 'review'))) newer(join(statusDir, 'review', name))
  } catch {
    /* review はまだ無い */
  }
  const roles = object(get(read(statusDir, 'workers.json'), 'roles'))
  for (const role of Object.values(roles)) {
    const worktree = string(get(role, 'worktree_path'))
    if (worktree === '' || !existsSync(worktree)) continue
    const last = run('git', ['-C', worktree, 'log', '-1', '--format=%ct'])
    latest = Math.max(latest, Number(last.stdout.trim()) || 0)
    const changed = run('git', ['-C', worktree, 'status', '--porcelain'])
    for (const line of changed.stdout.split('\n')) {
      if (line.length < 4) continue
      newer(join(worktree, line.slice(3)))
    }
  }
  return latest
}
const markHuman = (statusDir: string): void => {
  write(statusDir, 'human.json', { last_human_at: nowSeconds() })
}
const dispatchedRoles = (statusDir: string): string[] =>
  Object.entries(object(get(read(statusDir, 'workers.json'), 'roles')))
    .filter(([, role]) => string(get(role, 'dispatch')) !== '')
    .map(([role]) => role)
const integrationRoleOf = (statusDir: string): string =>
  string(get(read(statusDir, 'workers.json'), 'integration_role')) || 'design'
const roleSettled = (statusDir: string, role: string): boolean => (roleOutcome(statusDir, role) ?? '') !== ''
const taskGivenUp = (statusDir: string): boolean => {
  for (const role of ['design', 'exec']) {
    if (isStopped(statusDir, role) && storedOutcome(statusDir, role) === '') return true
  }
  return integrationRoleOf(statusDir) !== 'design' && storedOutcome(statusDir, 'design') === 'failed'
}
const taskSettled = (statusDir: string): boolean => {
  if (!dispatchedRoles(statusDir).every((role) => roleSettled(statusDir, role))) return false
  return taskGivenUp(statusDir) || roleSettled(statusDir, integrationRoleOf(statusDir))
}
const roleWaiting = (statusDir: string, role: string): boolean =>
  string(get(read(statusDir, 'workers.json'), 'roles', role, 'dispatch')) !== '' && !roleSettled(statusDir, role)
const stallLines = (statusDir: string, idleMin: number): string[] => {
  const slug = basename(statusDir)
  const lines = [`stalled task=${slug} status_dir=${statusDir} idle_min=${idleMin}`]
  let open = false
  for (const role of dispatchedRoles(statusDir)) {
    if (roleSettled(statusDir, role)) {
      if (role === 'design_review' && (isStopped(statusDir, role) || !roleWaiting(statusDir, 'design'))) continue
      if (role === 'exec_review' && (isStopped(statusDir, role) || !roleWaiting(statusDir, 'exec'))) continue
      if (role !== 'design_review' && role !== 'exec_review') continue
    } else open = true
    const phase =
      string(get(read(statusDir, `roles/${role}/completion.json`), 'phase')) ||
      string(get(read(statusDir, `roles/${role}/status.json`), 'status')) ||
      'none'
    const terminal = string(get(read(statusDir, 'workers.json'), 'roles', role, 'terminal')) || 'none'
    lines.push(`stalled_role task=${slug} role=${role} phase=${phase} terminal=${terminal}`)
  }
  if (!open) {
    const integrationRole = integrationRoleOf(statusDir)
    if (
      string(get(read(statusDir, 'workers.json'), 'roles', integrationRole, 'dispatch')) === '' &&
      !taskGivenUp(statusDir)
    ) {
      lines.push(`unstarted_role task=${slug} role=${integrationRole}`)
    }
  }
  return lines
}
const checkStall = (state: State): boolean => {
  let found = false
  const now = nowSeconds()
  for (const statusDir of state.statusDirs) {
    if (taskSettled(statusDir)) continue
    let last = taskLastChange(statusDir)
    const current = object(read(statusDir, 'stall.json'))
    const snoozed = typeof current.snoozed_at === 'number' ? current.snoozed_at : 0
    if (snoozed > last) last = snoozed
    if (now - last < state.stallSeconds) {
      if (Object.hasOwn(current, 'detected_at')) {
        const next = { ...current }
        delete next.detected_at
        delete next.idle_min
        write(statusDir, 'stall.json', next)
      }
      continue
    }
    const idle = Math.floor((now - last) / 60)
    if (state.onStall === 'ask') {
      process.stdout.write(`${stallLines(statusDir, idle).join('\n')}\n`)
      found = true
      continue
    }
    if (Object.hasOwn(current, 'detected_at')) continue
    for (const line of stallLines(statusDir, idle)) log(NAME, line)
    if (!write(statusDir, 'stall.json', { ...current, detected_at: now, idle_min: idle })) {
      log(NAME, `could not record the stall in ${statusDir}/stall.json`)
    }
  }
  return !found
}
// ★ 空ファイルを receipt 0 件と読まない。ack すると結果が消える。
const recordOutcome = (statusDir: string, task: string, dispatch: string, outcome: string): 0 | 1 | 2 => {
  const file = join(statusDir, 'received.json')
  if (existsSync(file) && !nonempty(file)) {
    log(NAME, `the received outcome record in ${statusDir} is empty; it is not acknowledged`)
    return 1
  }
  const records = existsSync(file) ? array(readJson(file)) : []
  if (records === null) {
    log(NAME, 'received outcome record is invalid or unreadable; it is not acknowledged')
    return 1
  }
  if (!write(statusDir, 'received.json', [...records, `worker_done|${task}|${dispatch}|${outcome}`])) {
    log(NAME, `could not record the worker outcome for dispatch '${dispatch}'; it is not acknowledged`)
    return 2
  }
  return 0
}
const reviewState = (statusDir: string, role: string): string => {
  const result = runNode(join(HERE, 'review-state.ts'), ['--status-dir', statusDir, '--role', role])
  return result.rc === 0 ? result.stdout.trim() : 'none'
}
// ★ 相 3 の検証。成果が無いのに受理して端末を閉じると欠落に気づけない。
const verifyRole = (statusDir: string, role: string): string => {
  const roleDir = join(statusDir, 'roles', role)
  if (role === 'design') {
    const integrationRole = integrationRoleOf(statusDir)
    if (integrationRole !== 'design') {
      if (!nonempty(join(statusDir, 'plan.md'))) return 'plan.md is missing or empty'
    } else if (!nonempty(join(roleDir, 'result.md'))) return 'result.md is missing or empty'
  } else if (role === 'design_review' || role === 'exec_review') {
    const prefix = role === 'exec_review' ? 'code' : 'plan'
    let found = false
    try {
      for (const name of readdirSync(join(statusDir, 'review')).sort()) {
        if (!new RegExp(`^${prefix}-round-.*-findings\\.md$`).test(name)) continue
        found = true
        if (!/^VERDICT: /m.test(readFileSync(join(statusDir, 'review', name), 'utf8'))) {
          return `${name} has no VERDICT line`
        }
      }
    } catch {
      /* review はまだ無い */
    }
    if (!found && !nonempty(join(roleDir, 'result.md'))) return 'neither findings nor result.md exist'
  } else if (!nonempty(join(roleDir, 'result.md'))) return 'result.md is missing or empty'
  return ''
}
const replyCompletion = (state: State, dispatch: string, nonce: string, accepted: boolean, body: string): boolean => {
  const subject = `${accepted ? 'completion-accepted' : 'completion-remediation'}: ${nonce}`
  return (
    runOrca([
      'orchestration',
      'send',
      '--to',
      `dispatch:${dispatch}`,
      '--type',
      'status',
      '--subject',
      subject,
      '--body',
      body,
      '--from',
      state.expected.parent,
      '--json',
    ]).rc === 0
  )
}
// ★ 配送と起床は別の事実。起床の失敗で配送や batch の結末を覆さない。
const wakeRole = (statusDir: string, role: string): void => {
  const roleDir = join(statusDir, 'roles', role)
  try {
    mkdirSync(roleDir, { recursive: true })
    writeFileSync(join(roleDir, '.woken'), `${nowSeconds()}\n`)
  } catch {
    /* 起床自体は試す */
  }
  const woke = runNode(join(HERE, 'orca-wake.ts'), ['--workers', join(statusDir, 'workers.json'), '--role', role])
  if (woke.rc !== 0) log(NAME, `could not wake ${role}; the reply is delivered but it may be sitting unread`)
}
const rewakeStalled = (state: State): void => {
  for (const entry of state.expected.entries) {
    if ((roleOutcome(entry.statusDir, entry.role) ?? '') !== '') continue
    if (string(get(read(entry.statusDir, `roles/${entry.role}/completion.json`), 'phase')) !== 'merge_ready_sent')
      continue
    let last = 0
    try {
      last = Number.parseInt(readFileSync(join(entry.statusDir, 'roles', entry.role, '.woken'), 'utf8'), 10) || 0
    } catch {
      /* まだ起床していない */
    }
    if (nowSeconds() - last >= state.wakeInterval) wakeRole(entry.statusDir, entry.role)
  }
}
const unknown = (state: State, type: string, task: string, dispatch: string, batch: string): 7 => {
  state.unknown = { type, task, dispatch, batch }
  return 7
}
// ★ 全 message を処理してから ack する。知らない dispatch は集合の読み直しへ渡す。
const drain = (state: State): 0 | 1 | 2 | 6 | 7 => {
  const checked = runOrca(['orchestration', 'check', '--terminal', state.expected.parent, '--json'])
  if (checked.rc !== 0) {
    log(NAME, `check failed (rc=${checked.rc}); the batch is not acknowledged`)
    return 2
  }
  const result = asObject(get(checked.json, 'result'))
  if (!receiptOk(checked) || result === null) {
    log(NAME, 'check receipt was not ok; the batch is not acknowledged')
    return 2
  }
  const messages = array(result.messages)
  if (messages === null) {
    log(NAME, 'check receipt messages are invalid; the batch is not acknowledged')
    return 2
  }
  if (messages.length === 0) return 0
  const batch = string(result.deliveryId)
  if (batch === '') {
    log(NAME, 'a non-empty batch has no deliveryId')
    return 1
  }
  const settled = new Map<number, string>()
  for (const rawMessage of messages) {
    const message = object(rawMessage)
    const type = string(message.type)
    if (type === 'heartbeat') continue
    const rawPayload = message.payload
    const payload = asObject(typeof rawPayload === 'string' ? parseJson(rawPayload) : rawPayload)
    if (payload === null) {
      log(NAME, 'this version handles only worker_done messages; the message was left unacknowledged')
      return 1
    }
    const task = string(payload.taskId)
    const dispatch = string(payload.dispatchId)
    if (Object.hasOwn(payload, '_orcaLifecycleRejection')) {
      const code = string(get(payload, '_orcaLifecycleRejection', 'code')) || 'unknown'
      const reason = string(get(payload, '_orcaLifecycleRejection', 'reason')) || 'unknown'
      log(NAME, `worker_done was rejected by Orca (code='${code}' reason='${reason}'); the batch is not acknowledged`)
      return 1
    }
    if (type === 'question') {
      const resolved = resolveDispatch(state, task, dispatch)
      if (resolved.kind === 'superseded') {
        log(
          NAME,
          `ignoring ${type} from dispatch '${dispatch}': it was replaced (superseded) for ${resolved.role} in ${resolved.statusDir}`,
        )
        continue
      }
      if (resolved.kind === 'unknown') return unknown(state, type, task, dispatch, batch)
      const index = resolved.index
      const entry = state.expected.entries[index]
      if (entry === undefined) return 1
      const id = string(message.id)
      const body = string(message.body)
      const prior = array(read(entry.statusDir, 'questions.json')) ?? []
      if (prior.includes(id)) {
        log(NAME, `${entry.role}'s question was already relayed; treating it as handled`)
        markHuman(entry.statusDir)
        continue
      }
      const next = [...new Set([...prior.filter((item): item is string => typeof item === 'string'), id])].sort()
      if (!write(entry.statusDir, 'questions.json', next)) {
        log(NAME, 'could not record that this question was relayed; it may be surfaced again')
      }
      log(NAME, `${entry.role} is asking a question and is blocked until someone answers:`)
      log(NAME, `  ${body}`)
      log(NAME, 'relay it to the user, then answer with:')
      log(
        NAME,
        `  ${orcaBin()} orchestration reply --id ${id || '<message id>'} --body '<their answer>' --from ${state.expected.parent}`,
      )
      log(NAME, 'then run this wait again')
      markHuman(entry.statusDir)
      return 6
    }
    if (type === 'merge_ready') {
      const resolved = resolveDispatch(state, task, dispatch)
      if (resolved.kind === 'superseded') {
        log(
          NAME,
          `ignoring ${type} from dispatch '${dispatch}': it was replaced (superseded) for ${resolved.role} in ${resolved.statusDir}`,
        )
        continue
      }
      if (resolved.kind === 'unknown') return unknown(state, type, task, dispatch, batch)
      const index = resolved.index
      const entry = state.expected.entries[index]
      if (entry === undefined) return 1
      if (isStopped(entry.statusDir, entry.role)) {
        log(NAME, `ignoring merge_ready from ${entry.role} (dispatch ${dispatch}): the user stopped it`)
        continue
      }
      const subject = string(message.subject)
      const nonce = subject.match(/^merge_ready: *(.*)/)?.[1] || string(payload.nonce)
      if (!nonce) {
        log(NAME, `merge_ready from dispatch '${dispatch}' carries no nonce (subject '${subject || 'none'}')`)
        return 1
      }
      const reason = verifyRole(entry.statusDir, entry.role)
      if (reason === '') {
        if (!replyCompletion(state, dispatch, nonce, true, 'the work is accepted; finish and report')) {
          log(NAME, `could not send the acceptance to dispatch '${dispatch}'; the batch is not acknowledged`)
          return 2
        }
        log(NAME, `accepted ${entry.role} (dispatch ${dispatch})`)
        if (reviewState(entry.statusDir, entry.role) === 'unreviewed') {
          log(NAME, `WARNING: ${entry.role} produced no review verdict; its work is accepted UNREVIEWED`)
        }
      } else {
        if (!replyCompletion(state, dispatch, nonce, false, reason)) {
          log(NAME, `could not send the remediation to dispatch '${dispatch}'; the batch is not acknowledged`)
          return 2
        }
        log(NAME, `sent ${entry.role} back for remediation (dispatch ${dispatch}): ${reason}`)
      }
      wakeRole(entry.statusDir, entry.role)
      continue
    }
    const resolved = type === 'worker_done' ? resolveDispatch(state, task, dispatch) : { kind: 'unknown' as const }
    if (resolved.kind === 'superseded') {
      log(
        NAME,
        `ignoring ${type} from dispatch '${dispatch}': it was replaced (superseded) for ${resolved.role} in ${resolved.statusDir}`,
      )
      continue
    }
    if (type === 'worker_done' && resolved.kind === 'unknown') return unknown(state, type, task, dispatch, batch)
    const index = resolved.kind === 'current' ? resolved.index : -1
    if (index < 0) {
      log(
        NAME,
        `batch ${batch} carries a message this version cannot handle (type='${type}' task='${task}' dispatch='${dispatch}')`,
      )
      log(NAME, 'it is NOT acknowledged, so nothing is lost. Inspect with:')
      log(NAME, `  ${orcaBin()} orchestration check --terminal ${state.expected.parent} --peek --json`)
      return 1
    }
    const outcome = string(payload.outcome)
    if (outcome !== 'succeeded' && outcome !== 'failed') {
      log(NAME, `worker_done has outcome '${outcome || 'none'}'`)
      return 1
    }
    const previous = settled.get(index) ?? ''
    if (previous !== '' && previous !== outcome) {
      log(NAME, `batch ${batch} has contradictory outcomes for task '${task}' dispatch '${dispatch}'`)
      return 1
    }
    settled.set(index, outcome)
  }
  for (const [index, outcome] of settled) {
    const entry = state.expected.entries[index]
    if (entry === undefined) return 1
    if (!stillCurrent(entry)) {
      log(NAME, `not recording dispatch '${entry.dispatch}': it was replaced while this batch was read`)
      continue
    }
    const previous = storedOutcome(entry.statusDir, entry.role)
    if (previous === null) return 1
    if (previous !== '' && previous !== outcome) {
      log(
        NAME,
        `received outcome '${previous}' contradicts batch outcome '${outcome}' for task '${entry.task}' dispatch '${entry.dispatch}'`,
      )
      return 1
    }
    if (previous === '') {
      const recorded = recordOutcome(entry.statusDir, entry.task, entry.dispatch, outcome)
      if (recorded !== 0) return recorded
    }
    if (isStopped(entry.statusDir, entry.role)) continue
    const retained = runOrca(['orchestration', 'worker-retain', '--dispatch', entry.dispatch, '--json'])
    if (get(retained.json, 'ok') !== true) {
      log(NAME, `worker-retain receipt was not ok for dispatch '${entry.dispatch}'; the batch is not acknowledged`)
      return 2
    }
    if (retained.rc !== 0) {
      log(
        NAME,
        `worker-retain failed (rc=${retained.rc}) for dispatch '${entry.dispatch}'; the batch is not acknowledged`,
      )
      return 2
    }
    const workers = read(entry.statusDir, 'workers.json')
    const roles = object(get(workers, 'roles'))
    const next = {
      ...object(workers),
      roles: { ...roles, [entry.role]: { ...object(roles[entry.role]), retained: true } },
    }
    if (!write(entry.statusDir, 'workers.json', next)) {
      log(NAME, `could not record the retention for dispatch '${entry.dispatch}'; the batch is not acknowledged`)
      return 2
    }
  }
  const ack = runOrca(['orchestration', 'check', '--terminal', state.expected.parent, '--ack', batch, '--json'])
  if (ack.rc !== 0) {
    log(NAME, 'ack transport failed; the batch will replay')
    return 2
  }
  if (!receiptOk(ack)) {
    log(NAME, 'ack receipt was not ok; the batch will replay')
    return 2
  }
  return 0
}
const drainBatch = (state: State): 0 | 1 | 2 | 6 => {
  let result = drain(state)
  if (result !== 7) return result
  const previous = rolesKey(state)
  state.expected = loadRoles(state.statusDirs)
  if (rolesKey(state) !== previous) {
    log(NAME, 'a dispatch was added after this wait started; reloaded the role set from workers.json')
    result = drain(state)
    if (result !== 7) return result
  }
  const current = state.unknown
  log(
    NAME,
    `batch ${current.batch} carries a ${current.type} for a dispatch this wait does not know (task='${current.task}' dispatch='${current.dispatch}')`,
  )
  log(NAME, 'it is NOT acknowledged, so nothing is lost. A stage started later is only visible here')
  log(NAME, 'once its dispatch is recorded in workers.json. Inspect with:')
  log(NAME, `  ${orcaBin()} orchestration check --terminal ${state.expected.parent} --peek --json`)
  return 1
}
const aggregate = (state: State): 'succeeded' | 'failed' | null => {
  for (const entry of state.expected.entries) {
    if ((roleOutcome(entry.statusDir, entry.role) ?? '') === '') return null
  }
  let worst: 'succeeded' | 'failed' = 'succeeded'
  for (const statusDir of state.statusDirs) {
    if (taskGivenUp(statusDir)) {
      worst = 'failed'
      continue
    }
    const role = integrationRoleOf(statusDir)
    const status = string(get(read(statusDir, `roles/${role}/status.json`), 'status'))
    if (status !== 'done' && status !== 'error') return null
    const outcome = status === 'done' ? 'succeeded' : 'failed'
    if (storedOutcome(statusDir, role) !== outcome) return null
    if (outcome === 'failed') worst = 'failed'
  }
  return worst
}
const finish = (state: State, outcome: 'succeeded' | 'failed'): number => {
  const lines: string[] = []
  for (const entry of state.expected.entries) {
    const roleResult = roleOutcome(entry.statusDir, entry.role) || 'unknown'
    const review = reviewState(entry.statusDir, entry.role) === 'unreviewed' ? ' review=unreviewed' : ''
    lines.push(
      `task=${entry.task} role=${entry.role} dispatch=${entry.dispatch} status_dir=${entry.statusDir} outcome=${roleResult}${review}`,
    )
  }
  lines.push(`outcome=${outcome}`)
  process.stdout.write(`${lines.join('\n')}\n`)
  return outcome === 'succeeded' ? 0 : 5
}
// ★ worker_done 送信後の Orca の終端 state を、receipt 到着前に停止と読まない。
const healthy = (state: State): boolean => {
  for (const entry of state.expected.entries) {
    if ((roleOutcome(entry.statusDir, entry.role) ?? '') !== '') continue
    const shown = runOrca(['orchestration', 'worker-show', '--dispatch', entry.dispatch, '--json'])
    if (shown.rc !== 0) {
      log(NAME, `worker-show failed (rc=${shown.rc})`)
      return false
    }
    if (!receiptOk(shown) || asObject(get(shown.json, 'result')) === null) {
      log(NAME, 'worker-show receipt was not ok')
      return false
    }
    const agentWait = get(shown.json, 'result', 'observation', 'agentWait')
    if (agentWait !== undefined && agentWait !== null && agentWait !== false && agentWait !== '') {
      markHuman(entry.statusDir)
      continue
    }
    const status = string(get(shown.json, 'result', 'worker', 'state'))
    if (['active', 'ready', 'starting', 'idle'].includes(status)) {
      state.settleSeen.set(entry.dispatch, 0)
    } else if (status === 'succeeded' || status === 'failed') {
      const seen = (state.settleSeen.get(entry.dispatch) ?? 0) + 1
      state.settleSeen.set(entry.dispatch, seen)
      if (seen <= state.settleGrace) {
        log(
          NAME,
          `dispatch '${entry.dispatch}' reports '${status}' but its worker_done has not arrived yet (${seen}/${state.settleGrace})`,
        )
      } else {
        log(NAME, `the worker for dispatch '${entry.dispatch}' is '${status}'`)
        return false
      }
    } else {
      log(NAME, `the worker for dispatch '${entry.dispatch}' is '${status}'`)
      return false
    }
  }
  return true
}
const positive = (flag: string, value: string): number => {
  if (!/^[1-9][0-9]*$/.test(value)) die(NAME, `${flag} must be a positive integer`)
  return Number(value)
}
const main = (argv: string[]): number => {
  const statusDirs: string[] = []
  let maxWaits = DEFAULT_MAX_WAITS
  let timeoutMs = DEFAULT_TIMEOUT_MS
  let stallMin = DEFAULT_STALL_MIN
  let onStall: 'ask' | 'report' = 'ask'
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (
      flag === '--status-dir' ||
      flag === '--max-waits' ||
      flag === '--timeout-ms' ||
      flag === '--stall-after-min' ||
      flag === '--on-stall'
    ) {
      if (i + 1 >= argv.length) die(NAME, `${flag} requires a value`)
      const value = argv[++i] ?? ''
      if (flag === '--status-dir') statusDirs.push(value)
      if (flag === '--max-waits') maxWaits = positive(flag, value)
      if (flag === '--timeout-ms') timeoutMs = positive(flag, value)
      if (flag === '--stall-after-min') stallMin = positive(flag, value)
      if (flag === '--on-stall') {
        if (value !== 'ask' && value !== 'report') die(NAME, `--on-stall must be ask or report: ${value}`)
        onStall = value === 'report' ? 'report' : 'ask'
      }
    } else die(NAME, `unknown option: ${flag}`)
  }
  if (statusDirs.length === 0) die(NAME, '--status-dir is required')
  const state: State = {
    statusDirs,
    maxWaits,
    timeoutMs,
    onStall,
    stallSeconds: envCount('ORCA_STALL_AFTER_SECONDS', stallMin * 60),
    wakeInterval: envCount('ORCA_WAKE_INTERVAL_SECONDS', 1800),
    waiterRetry: envCount('ORCA_WAITER_RETRY_SECONDS', 20),
    waiterTries: envCount('ORCA_WAITER_RETRY_TRIES', 15),
    settleGrace: envCount('ORCA_WAIT_SETTLE_GRACE', 3),
    expected: loadRoles(statusDirs),
    settleSeen: new Map(),
    unknown: { type: '', task: '', dispatch: '', batch: '' },
  }
  beat(state)
  let drained = drainBatch(state)
  if (drained !== 0) return drained === 2 ? 4 : drained === 6 ? 6 : 1
  let outcome = aggregate(state)
  if (outcome !== null) return finish(state, outcome)
  let rounds = 0
  let waiterErrors = 0
  while (true) {
    beat(state)
    const waited = runOrca([
      'orchestration',
      'check',
      '--terminal',
      state.expected.parent,
      '--wait',
      '--timeout-ms',
      String(state.timeoutMs),
      '--json',
    ])
    if (!receiptOk(waited)) {
      if (string(get(waited.json, 'error', 'code')) === 'waiter_exists' && waiterErrors < state.waiterTries) {
        waiterErrors++
        log(
          NAME,
          `another waiter still holds this terminal; retrying in ${state.waiterRetry}s (${waiterErrors}/${state.waiterTries})`,
        )
        sleepSeconds(state.waiterRetry)
        continue
      }
      if (waited.rc === 0) log(NAME, 'check --wait receipt was not ok')
      else log(NAME, `check --wait failed (rc=${waited.rc})`)
      return 4
    }
    waiterErrors = 0
    drained = drainBatch(state)
    if (drained !== 0) return drained === 2 ? 4 : drained === 6 ? 6 : 1
    outcome = aggregate(state)
    if (outcome !== null) return finish(state, outcome)
    if (!healthy(state)) return 4
    rewakeStalled(state)
    if (!checkStall(state)) {
      log(
        NAME,
        `a task has made no progress for ${Math.floor(state.stallSeconds / 60)} minutes or more and nobody is waiting on a person;`,
      )
      log(NAME, 'ask the user whether to keep waiting or stop a role (orca-stop.ts), then run this wait again')
      return 8
    }
    rounds++
    if (rounds >= state.maxWaits) {
      log(NAME, `reached --max-waits (${state.maxWaits}); inspect and decide`)
      return 3
    }
  }
}

process.exitCode = main(process.argv.slice(2))
