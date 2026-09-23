// 片付けの判定（Step 5 = plan）と、承認された片付けの実行（Step 6 = run）。
//
// Usage: node orca-cleanup.ts plan --status-dir <dir> [--status-dir <dir> ...]
//        node orca-cleanup.ts run --plan <file> --approve <slug>:<terminal|worktree|record> [...]
//
// plan の exit: 0 = 計画を書いた（提示が 0 件でも）/ 1 = Run 全体を止めた（計画は書かない）/ 2 = 使用法の誤り
// run の exit:  0 = 承認された操作を全部終えた / 1 = どれかが失敗した / 2 = 使用法の誤り
//
// ★ plan は Orca に読み取り（worker-list / terminal show / terminal list）しか打たない。
//   判定の条件と止まる理由の文言は、SKILL.md の Step 5 にあった [C1]〜[C7] のブロックから移した。
import { die, log, parseFlags } from '../lib/cli.ts'
import { readJson, writeAtomic } from '../lib/fs.ts'
import { asArray, asObject, asString, get, type Json, type JsonObject } from '../lib/json.ts'
import { type OrcaResult, orcaBin, receiptArray, receiptObject, receiptOk, runOrca } from '../lib/orca.ts'

import { spawnSync } from 'node:child_process'
import { realpathSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

const NAME = 'orca-cleanup'
const USAGE =
  'usage: orca-cleanup.ts plan --status-dir <dir> [--status-dir <dir> ...] | ' +
  'run --plan <file> --approve <slug>:<terminal|worktree|record> [--approve ...]'

const MISSING = 'required cleanup state is missing; do not close or remove anything'
const UNREADABLE = 'could not read the release state; do not close anything'
const UNVERIFIED = 'could not verify the terminal identity; do not close anything'
const NOT_A_RECORD = 'this is not a dispatch status directory; do not remove anything'
const OUTSIDE_DISPATCH = 'the status directory is not inside .dispatch; do not remove it'

const HELD_STATES = ['release_pending', 'release_unknown']
const GONE_STATES = ['released', 'already_released']
const LIVE_STATES = ['not_requested', 'retained', 'active', 'reclaimable']

type Kind = 'terminal' | 'worktree' | 'record'
type TerminalOffer = { role: string; dispatch: string; argv: string[] }
type WorktreeOffer = { role: string; worktree_id: string; argv: string[] }
type RecordOffer = { path: string }
type Offers = { terminal: TerminalOffer[]; worktree: WorktreeOffer[]; record: RecordOffer[] }
type Kept = { kind: Kind; role: string | null; reasons: string[] }
type Stopped = { reasons: string[]; reported: Json[]; inspect: string[][] }
type TaskPlan = { slug: string; status_dir: string; stopped: Stopped | null; offers: Offers; kept: Kept[] }
type CleanupPlan = { run_id: string; tasks: TaskPlan[] }
type Sink = { offers: Offers; kept: Kept[]; stopped: Stopped }
type Step = { kind: Kind; label: string; act: () => { ok: boolean; line: string } }

const isKind = (value: string): value is Kind => value === 'terminal' || value === 'worktree' || value === 'record'
const terminalArgv = (dispatch: string): string[] => [
  'orchestration',
  'worker-release',
  '--dispatch',
  dispatch,
  '--json',
]
const worktreeArgv = (worktreeId: string): string[] => ['worktree', 'rm', '--worktree', `id:${worktreeId}`, '--json']
const show = (argv: string[]): string => [orcaBin(), ...argv].join(' ')
const emptyOffers = (): Offers => ({ terminal: [], worktree: [], record: [] })

const stopRun = (lines: string[]): number => {
  for (const line of lines) log(NAME, line)
  return 1
}

// jq の `.resource.releaseState // .terminalState // empty` と同じ読み方
const releaseState = (worker: Json | undefined): string =>
  asString(get(worker, 'resource', 'releaseState')) ?? asString(get(worker, 'terminalState')) ?? ''

const runOf = (dir: string): string => asString(get(readJson(join(dir, 'run.json')), 'run_id')) ?? ''

const isFile = (file: string): boolean => {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

// [C5] 記録を消してよいのは、run.json と workers.json を持ち、`.dispatch` の直下にある status dir だけ
const recordRefusal = (dir: string): string | null => {
  if (!isFile(join(dir, 'run.json')) || !isFile(join(dir, 'workers.json'))) return NOT_A_RECORD
  try {
    return basename(realpathSync(dirname(resolve(dir)))) === '.dispatch' ? null : OUTSIDE_DISPATCH
  } catch {
    return OUTSIDE_DISPATCH
  }
}

// [C3] 破壊的なので、全条件が実際に成り立つときだけ提示する。成り立たない理由は全部挙げる
const worktreeReasons = (
  record: Json,
  worktreeId: string,
  worktreePath: string,
  merged: boolean,
  identity: boolean,
): string[] => {
  const owned = get(record, 'worktree_created_by_this_run') === true
  const recorded = asArray(get(record, 'worktree_terminals'))
  const git = spawnSync('git', ['-C', worktreePath, 'status', '--porcelain'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  })
  const inspected = git.status === 0
  const dirty = (git.stdout ?? '').trim() !== ''
  // ★ yes / no / unknown の 3 値を保つ。列挙できないことを「端末 0 件」と取り違えない
  const listed = receiptArray(runOrca(['terminal', 'list', '--worktree', `id:${worktreeId}`, '--json']), 'terminals')
  let accounted = 'unknown'
  if (listed !== null && recorded !== null) {
    accounted = listed.every((entry) => recorded.includes(get(entry, 'handle') ?? null)) ? 'yes' : 'no'
  }
  const reasons: string[] = []
  if (!merged) reasons.push('the work is not merged yet')
  if (!owned) reasons.push('this dispatch reused an existing worktree; it is not ours to remove')
  if (!inspected) reasons.push('the worker checkout could not be inspected')
  if (dirty) reasons.push('the worker checkout has uncommitted changes')
  if (!identity) reasons.push('the terminal identity did not match our state')
  if (accounted === 'no') reasons.push('a terminal in that worktree is not one we recorded')
  if (accounted === 'unknown') reasons.push('the terminals in that worktree could not be listed, so nothing is proven')
  return reasons
}

const planRole = (role: string, record: Json, listed: Json[], merged: boolean, sink: Sink): void => {
  const dispatch = asString(get(record, 'dispatch')) ?? ''
  const terminal = asString(get(record, 'terminal')) ?? ''
  const worktreeId = asString(get(record, 'worktree_id')) ?? ''
  const worktreePath = asString(get(record, 'worktree_path')) ?? ''
  const worker = listed.find((entry) => get(entry, 'dispatchId') === dispatch)
  if (worker === undefined) {
    sink.stopped.reasons.push(`${role}: ${UNREADABLE}`)
    return
  }
  const state = releaseState(worker)
  // [C1] 以前の release を Orca が確定できていない。そのタスクは何も閉じない・消さない
  if (HELD_STATES.includes(state)) {
    sink.stopped.reasons.push(
      `${role}: the worker is ${state}; Orca has not settled an earlier release, so nothing may be closed or removed for this task`,
    )
    sink.stopped.reported.push(worker)
    sink.stopped.inspect.push(['orchestration', 'worker-show', '--dispatch', dispatch, '--json'])
    return
  }
  const gone = GONE_STATES.includes(state)
  if (!gone && !LIVE_STATES.includes(state)) {
    sink.stopped.reasons.push(`${role}: ${UNREADABLE}`)
    return
  }
  if (terminal === '' || worktreeId === '' || worktreePath === '') {
    sink.stopped.reasons.push(`${role}: ${MISSING}`)
    return
  }
  // ★ released 系で show できないのは、Orca が閉じたことの証明になる。それ以外の state では
  //   端末はまだ在るはずなので、show できなければ止まる
  const shown = receiptObject(runOrca(['terminal', 'show', '--terminal', terminal, '--json']), 'terminal')
  if (shown === null && !gone) {
    sink.stopped.reasons.push(`${role}: ${UNVERIFIED}`)
    return
  }
  const identity = shown === null || (get(shown, 'handle') === terminal && get(shown, 'worktreeId') === worktreeId)
  // [C2] 提示するのは raw な terminal close ではなく worker-release（出力を archive してから閉じる）
  if (gone) {
    sink.kept.push({ kind: 'terminal', role, reasons: [`Orca already closed the ${role} terminal; nothing to close`] })
  } else if (identity) {
    sink.offers.terminal.push({ role, dispatch, argv: terminalArgv(dispatch) })
  } else {
    sink.kept.push({
      kind: 'terminal',
      role,
      reasons: [`the ${role} terminal no longer matches our state; leave it alone`],
    })
  }
  const reasons = worktreeReasons(record, worktreeId, worktreePath, merged, identity)
  if (reasons.length === 0) {
    sink.offers.worktree.push({ role, worktree_id: worktreeId, argv: worktreeArgv(worktreeId) })
  } else {
    sink.kept.push({ kind: 'worktree', role, reasons })
  }
}

const planTask = (dir: string, workers: JsonObject, listed: Json[]): TaskPlan => {
  const merged = get(readJson(join(dir, 'integration-result.json')), 'merged') === true
  // ★ 役を全部走査する。レビューモードでは 1 タスクに複数の役（端末と worktree）が居る
  const roles = Object.entries(asObject(workers.roles) ?? {}).filter(
    ([, record]) => (asString(get(record, 'dispatch')) ?? '') !== '',
  )
  const sink: Sink = { offers: emptyOffers(), kept: [], stopped: { reasons: [], reported: [], inspect: [] } }
  if (roles.length === 0) sink.stopped.reasons.push(MISSING)
  for (const [role, record] of roles) planRole(role, record, listed, merged, sink)
  const refusal = recordRefusal(dir)
  if (refusal !== null) {
    sink.kept.push({ kind: 'record', role: null, reasons: [refusal] })
  } else if (merged) {
    sink.offers.record.push({ path: dir })
  } else {
    sink.kept.push({
      kind: 'record',
      role: null,
      reasons: ['the work is not merged yet, so this is the only copy of the request and result'],
    })
  }
  const slug = basename(dir)
  // ★ タスクの停止は「そのタスクの何も閉じない・消さない」。提示を全部取り下げる
  if (sink.stopped.reasons.length > 0) {
    return { slug, status_dir: dir, stopped: sink.stopped, offers: emptyOffers(), kept: [] }
  }
  return { slug, status_dir: dir, stopped: null, offers: sink.offers, kept: sink.kept }
}

const keptLines = (item: Kept): string[] => {
  const reasons = item.reasons.map((reason) => `    - ${reason}`)
  if (item.kind === 'worktree') {
    return [`  keep worktree (${item.role}): not offering to remove the ${item.role} worktree:`, ...reasons]
  }
  if (item.kind === 'record') return ['  keep record: not offering to remove the dispatch record:', ...reasons]
  return [`  keep terminal (${item.role}): ${item.reasons.join('; ')}`]
}

const printPlan = (plan: CleanupPlan, file: string): void => {
  const lines = [`Run ${plan.run_id}: every retained worker in this Run is one we recorded`]
  for (const task of plan.tasks) {
    lines.push(`${task.slug} (${task.status_dir})`)
    if (task.stopped !== null) {
      lines.push('  stopped: nothing may be closed or removed for this task')
      for (const reason of task.stopped.reasons) lines.push(`    - ${reason}`)
      for (const worker of task.stopped.reported) lines.push(`    reported: ${JSON.stringify(worker)}`)
      for (const argv of task.stopped.inspect) lines.push(`    inspect: ${show(argv)}`)
      continue
    }
    for (const offer of task.offers.terminal) lines.push(`  offer terminal (${offer.role}): ${show(offer.argv)}`)
    for (const offer of task.offers.worktree) lines.push(`  offer worktree (${offer.role}): ${show(offer.argv)}`)
    for (const offer of task.offers.record) lines.push(`  offer record: remove ${offer.path}`)
    for (const item of task.kept) lines.push(...keptLines(item))
  }
  lines.push(`plan_file=${file}`)
  process.stdout.write(`${lines.join('\n')}\n`)
}

const planCommand = (args: string[]): number => {
  const { values } = parseFlags(NAME, {
    args,
    options: { 'status-dir': { type: 'string', multiple: true } },
    strict: true,
    allowPositionals: false,
  })
  const given = values['status-dir'] ?? []
  if (given.length === 0) return die(NAME, `plan needs at least one --status-dir\n${USAGE}`)
  if (given.includes('')) return die(NAME, '--status-dir must not be empty')
  const dirs = [...new Set(given.map((dir) => resolve(dir)))]
  const slugs = dirs.map((dir) => basename(dir))
  const repeated = slugs.find((slug, index) => slugs.indexOf(slug) !== index)
  if (repeated !== undefined) return die(NAME, `two status dirs share the slug ${repeated}; pass each task once`)

  // [C7] 前半。別の Run の dir が混じると既知の集合が広がり、本物の ghost を隠す。Orca を呼ぶ前に確かめる
  const first = dirs[0] ?? ''
  const run = runOf(first)
  if (run === '') return stopRun([MISSING])
  const foreign = dirs.find((dir) => runOf(dir) !== run)
  if (foreign !== undefined) {
    return stopRun([`${foreign} does not belong to Run ${run}; do not close or remove anything`])
  }
  const inputs: { dir: string; workers: JsonObject }[] = []
  for (const dir of dirs) {
    const workers = asObject(readJson(join(dir, 'workers.json')))
    if (workers === null) return stopRun([MISSING])
    inputs.push({ dir, workers })
  }

  // [C7] 後半。worker-retain は durable な例外を残す。記録に無い保持は他者のものか前回の自分たちのもの
  const known = new Set(
    inputs.flatMap(({ workers }) =>
      Object.values(asObject(workers.roles) ?? {})
        .map((record) => asString(get(record, 'dispatch')))
        .filter((id) => id !== null),
    ),
  )
  const retained = receiptArray(
    runOrca(['orchestration', 'worker-list', '--run', run, '--terminal-state', 'retained', '--json']),
    'workers',
  )
  if (retained === null) return stopRun(['could not list what Orca still holds for this Run; do not remove anything'])
  const ghosts = retained
    .map((worker) => get(worker, 'dispatchId'))
    .filter((id) => typeof id !== 'string' || !known.has(id))
    .map((id) => (typeof id === 'string' ? id : JSON.stringify(id ?? null)))
  if (ghosts.length > 0) {
    return stopRun([
      'Orca still holds retained workers we did not record:',
      ...ghosts,
      'do not remove any worktree or dispatch record for this Run',
    ])
  }

  // [C1]〜[C3] は Run 全体の 1 回の答えから、タスクごとに分類する
  const listed = receiptArray(runOrca(['orchestration', 'worker-list', '--run', run, '--json']), 'workers')
  if (listed === null) return stopRun([UNREADABLE])
  const plan: CleanupPlan = { run_id: run, tasks: inputs.map(({ dir, workers }) => planTask(dir, workers, listed)) }
  // status dir は `<repo>/.dispatch/<slug>` なので、計画はその隣の `<repo>/.dispatch/cleanup-<run_id>.json` に置く
  const file = join(dirname(first), `cleanup-${run}.json`)
  if (!writeAtomic(file, `${JSON.stringify(plan, null, 2)}\n`)) {
    return stopRun([`could not write the cleanup plan to ${file}; do not close or remove anything`])
  }
  printPlan(plan, file)
  return 0
}

const stringArray = (value: Json | undefined): string[] | null => {
  const array = asArray(value)
  if (array === null) return null
  const strings = array.filter((item) => typeof item === 'string')
  return strings.length === array.length ? strings : null
}

const sameArgv = (left: string[], right: string[]): boolean =>
  left.length === right.length && left.every((item, index) => item === right[index])

// ★ 計画に書いた形の操作しか実行しない。書き換えられた argv（`--force` の追加など）は計画ごと拒む
const readOffers = (value: Json | undefined): Offers | null => {
  const terminal = asArray(get(value, 'terminal'))
  const worktree = asArray(get(value, 'worktree'))
  const record = asArray(get(value, 'record'))
  if (terminal === null || worktree === null || record === null) return null
  const offers = emptyOffers()
  for (const item of terminal) {
    const role = asString(get(item, 'role'))
    const dispatch = asString(get(item, 'dispatch'))
    const argv = stringArray(get(item, 'argv'))
    if (role === null || dispatch === null || argv === null || !sameArgv(argv, terminalArgv(dispatch))) return null
    offers.terminal.push({ role, dispatch, argv })
  }
  for (const item of worktree) {
    const role = asString(get(item, 'role'))
    const worktreeId = asString(get(item, 'worktree_id'))
    const argv = stringArray(get(item, 'argv'))
    if (role === null || worktreeId === null || argv === null || !sameArgv(argv, worktreeArgv(worktreeId))) return null
    offers.worktree.push({ role, worktree_id: worktreeId, argv })
  }
  for (const item of record) {
    const path = asString(get(item, 'path'))
    if (path === null) return null
    offers.record.push({ path })
  }
  return offers
}

const readKept = (value: Json | undefined): Kept[] | null => {
  const items = asArray(value)
  if (items === null) return null
  const kept: Kept[] = []
  for (const item of items) {
    const kind = asString(get(item, 'kind')) ?? ''
    const reasons = stringArray(get(item, 'reasons'))
    if (!isKind(kind) || reasons === null) return null
    kept.push({ kind, role: asString(get(item, 'role')), reasons })
  }
  return kept
}

const readPlan = (file: string): CleanupPlan | null => {
  const json = readJson(file)
  const run = asString(get(json, 'run_id')) ?? ''
  const tasks = asArray(get(json, 'tasks'))
  if (run === '' || tasks === null) return null
  const plan: CleanupPlan = { run_id: run, tasks: [] }
  for (const item of tasks) {
    const slug = asString(get(item, 'slug'))
    const statusDir = asString(get(item, 'status_dir'))
    const offers = readOffers(get(item, 'offers'))
    const kept = readKept(get(item, 'kept'))
    if (slug === null || statusDir === null || offers === null || kept === null) return null
    // run が使うのは止めた理由だけ。reported / inspect は Step 5 の要約で既に示している
    const reasons = stringArray(get(item, 'stopped', 'reasons'))
    const stopped = reasons === null ? null : { reasons, reported: [], inspect: [] }
    if (basename(statusDir) !== slug || runOf(statusDir) !== run) return null
    if (offers.record.some((offer) => offer.path !== statusDir)) return null
    if (stopped !== null && (offers.terminal.length > 0 || offers.worktree.length > 0 || offers.record.length > 0)) {
      return null
    }
    const workers = asObject(readJson(join(statusDir, 'workers.json')))
    if (workers === null) return null
    const roles = asObject(workers.roles)
    for (const offer of offers.terminal) {
      if (get(roles?.[offer.role], 'dispatch') !== offer.dispatch) return null
    }
    for (const offer of offers.worktree) {
      const role = roles?.[offer.role]
      if (get(role, 'worktree_id') !== offer.worktree_id || get(role, 'worktree_created_by_this_run') !== true) {
        return null
      }
    }
    if (offers.record.length > 0 && get(readJson(join(statusDir, 'integration-result.json')), 'merged') !== true) {
      return null
    }
    plan.tasks.push({ slug, status_dir: statusDir, stopped, offers, kept })
  }
  return plan
}

const failureDetail = (result: OrcaResult): string => {
  const code = asString(get(result.json, 'error', 'code'))
  const message = asString(get(result.json, 'error', 'message')) ?? asString(get(result.json, 'error'))
  return [`rc=${result.rc}`, code, message].filter((part) => part !== null && part !== '').join('; ')
}

// ★ worker-release は ok を返しながら何も解放しないことがある（実測 O43: releaseState retained /
//   retainedReason user_takeover）。Step 5 と同じ worker-list から state を読み直して確かめる。
//   後続へ進めてよいのは、閉じたと確かめられたときと、user_takeover で Orca が保持したとき（spec 4-2）だけ。
//   読み直せない・未確定・ほかの理由での保持は、そのタスクの失敗として後続（worktree・記録）を止める
const release = (run: string, offer: TerminalOffer): { ok: boolean; line: string } => {
  const label = `${offer.role} terminal`
  const result = runOrca(offer.argv)
  if (!receiptOk(result)) return { ok: false, line: `  failed: ${label}: ${failureDetail(result)}` }
  const workers = receiptArray(runOrca(['orchestration', 'worker-list', '--run', run, '--json']), 'workers')
  if (workers === null) {
    return { ok: false, line: `  failed: ${label}: the release was accepted, but its state could not be read back` }
  }
  const worker = workers.find((entry) => get(entry, 'dispatchId') === offer.dispatch)
  if (worker === undefined) {
    return { ok: false, line: `  failed: ${label}: the release was accepted, but Orca no longer lists this worker` }
  }
  const state = releaseState(worker)
  if (GONE_STATES.includes(state)) return { ok: true, line: `  removed: ${label}` }
  if (state === 'retained') {
    const reason = asString(get(worker, 'resource', 'retainedReason')) ?? 'unknown'
    const kept = `Orca kept it (releaseState: retained, retainedReason: ${reason}); it was not closed`
    return reason === 'user_takeover'
      ? { ok: true, line: `  kept: ${label}: ${kept}` }
      : { ok: false, line: `  failed: ${label}: ${kept}` }
  }
  return {
    ok: false,
    line: `  failed: ${label}: the release was accepted, but its state reads '${state || 'unknown'}'; it is not confirmed closed`,
  }
}

const removeWorktree = (label: string, offer: WorktreeOffer): { ok: boolean; line: string } => {
  const result = runOrca(offer.argv)
  if (!receiptOk(result)) return { ok: false, line: `  failed: ${label}: ${failureDetail(result)}` }
  return { ok: true, line: `  removed: ${label}` }
}

// 記録は依頼と結果の唯一の控え。消す直前に [C5] と同じ検査をもう一度行う
const removeRecord = (label: string, offer: RecordOffer): { ok: boolean; line: string } => {
  const refusal = recordRefusal(offer.path)
  if (refusal !== null) return { ok: false, line: `  failed: ${label}: ${refusal}` }
  if (get(readJson(join(offer.path, 'integration-result.json')), 'merged') !== true) {
    return { ok: false, line: `  failed: ${label}: the work is not merged yet` }
  }
  try {
    rmSync(offer.path, { recursive: true })
    return { ok: true, line: `  removed: ${label}` }
  } catch (error) {
    return { ok: false, line: `  failed: ${label}: ${error instanceof Error ? error.message : String(error)}` }
  }
}

// タスク内の順は 端末 → worktree → 記録。端末が開いたままの worktree を Orca は手放さず、記録は最後に失うもの
const stepsOf = (run: string, task: TaskPlan): Step[] => [
  ...task.offers.terminal.map(
    (offer): Step => ({ kind: 'terminal', label: `${offer.role} terminal`, act: () => release(run, offer) }),
  ),
  ...task.offers.worktree.map((offer): Step => {
    const label = `${offer.role} worktree id:${offer.worktree_id}`
    return { kind: 'worktree', label, act: () => removeWorktree(label, offer) }
  }),
  ...task.offers.record.map((offer): Step => {
    const label = `dispatch record ${offer.path}`
    return { kind: 'record', label, act: () => removeRecord(label, offer) }
  }),
]

const runTask = (run: string, task: TaskPlan, approved: Set<Kind>): { lines: string[]; failed: boolean } => {
  const lines = [task.slug]
  let failed = false
  for (const step of stepsOf(run, task)) {
    if (!approved.has(step.kind)) {
      lines.push(`  kept: ${step.label} (not approved)`)
    } else if (failed) {
      // ★ 失敗は後続を authorise しない。そのタスクの残りには手を付けない
      lines.push(`  not run: ${step.label} (an earlier step for this task failed)`)
    } else {
      const outcome = step.act()
      failed = !outcome.ok
      lines.push(outcome.line)
    }
  }
  for (const item of task.kept) {
    const label = item.kind === 'record' ? 'dispatch record' : `${item.role} ${item.kind}`
    lines.push(`  kept: ${label}: ${item.reasons.join('; ')}`)
  }
  if (task.stopped !== null) {
    lines.push(`  kept: everything; Step 5 stopped this task: ${task.stopped.reasons.join('; ')}`)
  }
  return { lines, failed }
}

const runCommand = (args: string[]): number => {
  const { values } = parseFlags(NAME, {
    args,
    options: { plan: { type: 'string' }, approve: { type: 'string', multiple: true } },
    strict: true,
    allowPositionals: false,
  })
  const file = values.plan ?? ''
  const approvals = values.approve ?? []
  if (file === '') return die(NAME, `run needs --plan <file>\n${USAGE}`)
  if (approvals.length === 0) return die(NAME, 'run needs at least one --approve <slug>:<terminal|worktree|record>')
  const plan = readPlan(file)
  if (plan === null) return stopRun([`could not read the cleanup plan ${file}; nothing was run`])
  const approved = new Map<string, Set<Kind>>()
  for (const approval of approvals) {
    const at = approval.lastIndexOf(':')
    const slug = approval.slice(0, at)
    const kind = approval.slice(at + 1)
    const task = plan.tasks.find((candidate) => candidate.slug === slug)
    // ★ 計画に無い操作は実行しない。提示されていない承認は使用法の誤りとして、何も実行せずに止める
    if (at < 1 || task === undefined || !isKind(kind) || task.offers[kind].length === 0) {
      return die(NAME, `--approve ${approval} is not an offer in ${file}`)
    }
    approved.set(slug, (approved.get(slug) ?? new Set<Kind>()).add(kind))
  }
  const lines: string[] = []
  let failed = false
  const tasks = [...plan.tasks].sort((left, right) => (left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0))
  for (const task of tasks) {
    const outcome = runTask(plan.run_id, task, approved.get(task.slug) ?? new Set<Kind>())
    lines.push(...outcome.lines)
    failed = failed || outcome.failed
  }
  process.stdout.write(`${lines.join('\n')}\n`)
  return failed ? 1 : 0
}

const main = (argv: string[]): number => {
  const [command, ...rest] = argv
  if (command === 'plan') return planCommand(rest)
  if (command === 'run') return runCommand(rest)
  return die(NAME, USAGE)
}

// ★ process.exit で終えない。パイプへの stdout 書き込みが途中で切れうる（macOS ではパイプが非同期）
process.exitCode = main(process.argv.slice(2))
