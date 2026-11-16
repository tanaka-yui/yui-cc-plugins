// 片付けの判定（Step 5 = plan）と、承認された片付けの実行（Step 6 = run）。
//
// Usage: node orca-cleanup.ts plan --status-dir <dir> [--status-dir <dir> ...] [--pr-saved <dir> ...]
//        node orca-cleanup.ts run --plan <file> --approve <slug>:<terminal|worktree|record> [...]
//        node orca-cleanup.ts auto --status-dir <dir>
//        node orca-cleanup.ts sweep
//
// plan の exit: 0 = 計画を書いた（提示が 0 件でも）/ 1 = Run 全体を止めた（計画は書かない）/ 2 = 使用法の誤り
// run の exit:  0 = 承認された操作を全部終えた / 1 = どれかが失敗した / 2 = 使用法の誤り
// auto の exit: 0 = 片付けた・何もしなかった（Run 全体が止まったときも）/ 1 = 操作のどれかが失敗した / 2 = 使用法の誤り
// sweep の exit: 0 = いつも（掃除の失敗で dispatch を止めない）/ 2 = 使用法の誤り
//
// ★ plan は Orca に読み取り（worker-list / terminal show / terminal list）しか打たない。
//   判定の条件と止まる理由の文言は、SKILL.md の Step 5 にあった [C1]〜[C7] のブロックから移した。
import { die, log, parseFlags } from '../lib/cli.ts'
import { readJson, writeAtomic } from '../lib/fs.ts'
import { asArray, asObject, asString, get, type Json, type JsonObject, parseJson } from '../lib/json.ts'
import {
  failureDetail,
  GONE_STATES,
  HELD_STATES,
  LIVE_STATES,
  orcaBin,
  receiptArray,
  receiptObject,
  receiptOk,
  releaseState,
  runOrca,
  userOwned,
} from '../lib/orca.ts'

import { spawnSync } from 'node:child_process'
import { readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const NAME = 'orca-cleanup'
const USAGE =
  'usage: orca-cleanup.ts plan --status-dir <dir> [--status-dir <dir> ...] [--pr-saved <dir> ...] | ' +
  'run --plan <file> --approve <slug>:<terminal|worktree|record> [--approve ...] | auto --status-dir <dir> | sweep'

// ★ origin を読めなかったときと同じに扱う
const REMOTE_TIMEOUT_MS = 30_000
// ★ gh の打ち切りも、読めなかったときと同じに扱う
const GH_TIMEOUT_MS = 30_000

const MISSING = 'required cleanup state is missing; do not close or remove anything'
const UNREADABLE = 'could not read the release state; do not close anything'
const UNVERIFIED = 'could not verify the terminal identity; do not close anything'
const NOT_A_RECORD = 'this is not a dispatch status directory; do not remove anything'
const OUTSIDE_DISPATCH = 'the status directory is not inside .dispatch; do not remove it'

type Kind = 'terminal' | 'worktree' | 'record'
type TerminalOffer = { role: string; dispatch: string; argv: string[] }
type WorktreeOffer = { role: string; worktree_id: string; argv: string[] }
type RecordOffer = { path: string }
type Offers = { terminal: TerminalOffer[]; worktree: WorktreeOffer[]; record: RecordOffer[] }
type Kept = { kind: Kind; role: string | null; reasons: string[] }
type Stopped = { reasons: string[]; reported: Json[]; inspect: string[][] }
type TaskPlan = {
  slug: string
  status_dir: string
  stopped: Stopped | null
  offers: Offers
  kept: Kept[]
  pr_saved?: boolean
  pr_head?: string
}
type CleanupPlan = { run_id: string; tasks: TaskPlan[] }
type Built = { ok: true; plan: CleanupPlan; file: string } | { ok: false; lines: string[] }
type Sink = { offers: Offers; kept: Kept[]; stopped: Stopped }
type Step = { kind: Kind; role: string | null; label: string; act: () => { ok: boolean; line: string; held?: boolean } }

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

// ★ PR の成果は、URL の記録と、手元の branch が origin と一致すること（sweep が merge 済みの PR の head を
//   渡したときは、その head と一致することでもよい）で保存済みと証明する
const prUrlOf = (dir: string): string => {
  const result = readJson(join(dir, 'integration-result.json'))
  return get(result, 'integration') === 'pr' ? (asString(get(result, 'pr_url')) ?? '') : ''
}

// ★ lib/mail-artifacts.ts の head と同じ形。git も GitHub も小文字で返す。それ以外は head が無いのと同じ
const COMMIT_OID = /^[0-9a-f]{40,64}$/
const validHead = (value: string | null): string | null => (value !== null && COMMIT_OID.test(value) ? value : null)

type LocalBranch = { repo: string; ref: string; sha: string }
const localBranch = (dir: string, workers: JsonObject): LocalBranch | null => {
  const role = asString(workers.integration_role) ?? ''
  const branch = asString(get(workers, 'roles', role, 'branch')) ?? ''
  const repo = asString(get(readJson(join(dir, 'run.json')), 'repo_root')) ?? ''
  if (role === '' || branch === '' || repo === '') return null
  const ref = `refs/heads/${branch}`
  const local = spawnSync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', ref], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  })
  if (local.status !== 0 || local.stdout.trim() === '') return null
  return { repo, ref, sha: local.stdout.trim() }
}
const branchOnOrigin = (local: LocalBranch): boolean => {
  const remote = spawnSync('git', ['-C', local.repo, 'ls-remote', 'origin', local.ref], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: REMOTE_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  })
  if (remote.status !== 0) return false
  const match = remote.stdout
    .split('\n')
    .map((line) => line.split('\t'))
    .find(([, name]) => name === local.ref)
  return match?.[0] === local.sha
}

const prSavedReasons = (dir: string, workers: JsonObject, prHead: string | null): string[] => {
  const reasons: string[] = []
  if (prUrlOf(dir) === '') reasons.push('the pull request is not recorded')
  const local = localBranch(dir, workers)
  const head = validHead(prHead)
  // ★ merge された PR の head が手元と同じなら、手元の成果は全部 merge 済み（merge で origin の head branch が消えてもよい）
  if (local === null || (local.sha !== head && !branchOnOrigin(local))) {
    reasons.push(
      head === null
        ? 'the branch has commits that are not on origin'
        : 'the branch matches neither origin nor the head of the merged pull request',
    )
  }
  return reasons
}

// [C3] 破壊的なので、全条件が実際に成り立つときだけ提示する。成り立たない理由は全部挙げる
const worktreeReasons = (
  record: Json,
  worktreeId: string,
  worktreePath: string,
  merged: boolean,
  identity: boolean,
  notSaved: string[],
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
  if (!merged) reasons.push('the work is not merged yet', ...notSaved)
  if (!owned) reasons.push('this dispatch reused an existing worktree; it is not ours to remove')
  if (!inspected) reasons.push('the worker checkout could not be inspected')
  if (dirty) reasons.push('the worker checkout has uncommitted changes')
  if (!identity) reasons.push('the terminal identity did not match our state')
  if (accounted === 'no') reasons.push('a terminal in that worktree is not one we recorded')
  if (accounted === 'unknown') reasons.push('the terminals in that worktree could not be listed, so nothing is proven')
  return reasons
}

const planRole = (
  role: string,
  record: Json,
  listed: Json[],
  sink: Sink,
  rules: { merged: boolean; notSaved: string[]; unattended: boolean },
): void => {
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
    const fields = [
      terminal === '' ? 'terminal' : '',
      worktreeId === '' ? 'worktree_id' : '',
      worktreePath === '' ? 'worktree_path' : '',
    ].filter(Boolean)
    const repair =
      terminal === ''
        ? `; inspect ${show(['orchestration', 'worker-show', '--dispatch', dispatch, '--json', '--full'])} and, if reported, copy result.worker.agentTerminalHandle to roles.${role}.terminal in workers.json`
        : ''
    sink.stopped.reasons.push(`${role}: ${MISSING} (${fields.join(', ')} in workers.json)${repair}`)
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
  // [C2] 提示するのは raw な terminal close ではなく worker-release（出力を archive してから閉じる）。
  //   ★ **ユーザーが操作した端末（ownershipState: user_owned）は提示しない。**Orca はそれを release で閉じず、ok を
  //   返して何も閉じない（retainedReason は Step 3 の user_requested のままのことがある。2026-09-23 と 24 に 4 Run で実測）。
  //   worktree を消せば端末も閉じるので、worktree は [C3] の条件どおりに提示する
  if (gone) {
    sink.kept.push({ kind: 'terminal', role, reasons: [`Orca already closed the ${role} terminal; nothing to close`] })
  } else if (!identity) {
    sink.kept.push({
      kind: 'terminal',
      role,
      reasons: [`the ${role} terminal no longer matches our state; leave it alone`],
    })
  } else if (userOwned(worker)) {
    sink.kept.push({
      kind: 'terminal',
      role,
      reasons: [
        `the user owns the ${role} terminal (ownershipState: user_owned), so Orca will not release it; removing the ${role} worktree closes it`,
      ],
    })
  } else {
    sink.offers.terminal.push({ role, dispatch, argv: terminalArgv(dispatch) })
  }
  const reasons = worktreeReasons(record, worktreeId, worktreePath, rules.merged, identity, rules.notSaved)
  if (
    rules.unattended &&
    !gone &&
    (userOwned(worker) || get(worker, 'resource', 'retainedReason') === 'user_takeover')
  ) {
    reasons.push(`the user operated the ${role} terminal, so removing this worktree would close it without asking`)
  }
  if (reasons.length === 0) {
    sink.offers.worktree.push({ role, worktree_id: worktreeId, argv: worktreeArgv(worktreeId) })
  } else {
    sink.kept.push({ kind: 'worktree', role, reasons })
  }
}

// ★ **置き換えた試行（orca-recover の --retry-of。役の `superseded`）も判定に入れる。**[C1] と同じく、以前の
//   release を Orca が確定できていない試行があれば、そのタスクは何も閉じない・消さない。一覧に無い・知らない
//   state も同じく止まる。Orca がまだ保持していれば、その端末と理由を示し、記録は残す — 記録を消すと、どの保持が
//   自分たちのものかを失い、次の [C7] が ghost と読む。返り値は「まだ Orca が保持している試行があるか」
// ★ orca-wait.ts が `follow_ups` に記録した dispatch（終わった役に届いた message で Orca が起動し直した worker）も
//   同じ扱いにする。同じ worktree に居るので、Orca が保持している間は何も閉じない
const planSuperseded = (role: string, record: Json, listed: Json[], sink: Sink): boolean => {
  let held = false
  const attempts = [
    ...(asArray(get(record, 'superseded')) ?? []).map((id) => ({ id, label: 'the replaced attempt' })),
    ...(asArray(get(record, 'follow_ups')) ?? []).map((id) => ({ id, label: 'the follow-up' })),
  ]
  for (const { id, label } of attempts) {
    const dispatch = asString(id)
    if (dispatch === null) continue
    const worker = listed.find((entry) => get(entry, 'dispatchId') === dispatch)
    const state = worker === undefined ? '' : releaseState(worker)
    if (worker !== undefined && HELD_STATES.includes(state)) {
      sink.stopped.reasons.push(
        `${role}: ${label} ${dispatch} is ${state}; Orca has not settled an earlier release, so nothing may be closed or removed for this task`,
      )
      sink.stopped.reported.push(worker)
      sink.stopped.inspect.push(['orchestration', 'worker-show', '--dispatch', dispatch, '--json'])
    } else if (worker === undefined || (!GONE_STATES.includes(state) && !LIVE_STATES.includes(state))) {
      sink.stopped.reasons.push(`${role}: ${label} ${dispatch}: ${UNREADABLE}`)
    } else if (LIVE_STATES.includes(state)) {
      held = true
      sink.kept.push({
        kind: 'terminal',
        role,
        reasons: [
          `Orca still holds the terminal of ${label} ${dispatch} (releaseState: ${state}); it is not offered here`,
        ],
      })
    }
  }
  return held
}

// ★ **手で直した merge が記録されていないだけなら、その記録の仕方を言う。**orca-merge.ts が衝突で止まったあと親が手で
//   merge しても、integration-result.json は merged:false のままで、ここは何も offer しない（3.10.13、logi-app）。
//   ここで merged とみなさない — record を消す根拠は orca-merge.ts の記録だけにし、祖先かどうかは案内にだけ使う
const mergedByHand = (dir: string, workers: JsonObject): string => {
  const role = asString(workers.integration_role) ?? ''
  const branch = asString(get(workers, 'roles', role, 'branch')) ?? ''
  const base = asString(workers.integration_branch) ?? ''
  const repo = asString(get(readJson(join(dir, 'run.json')), 'repo_root')) ?? ''
  if (role === '' || branch === '' || base === '' || repo === '') return ''
  const ancestor = spawnSync('git', ['-C', repo, 'merge-base', '--is-ancestor', branch, base], { stdio: 'ignore' })
  if (ancestor.status !== 0) return ''
  const merge = join(dirname(fileURLToPath(import.meta.url)), 'orca-merge.ts')
  return `${branch} is already in ${base}; if it was merged by hand, record it with: node ${merge} --status-dir ${dir}`
}

const planTask = (
  dir: string,
  workers: JsonObject,
  listed: Json[],
  prSaved: boolean,
  prHead: string | null,
): TaskPlan => {
  const integrated = get(readJson(join(dir, 'integration-result.json')), 'merged') === true
  const notSaved = prSaved && !integrated ? prSavedReasons(dir, workers, prHead) : []
  const saved = prSaved && !integrated && notSaved.length === 0
  const savedProof = saved ? { pr_saved: true, ...(prHead === null ? {} : { pr_head: prHead }) } : {}
  const merged = integrated || saved
  // ★ 役を全部走査する。レビューモードでは 1 タスクに複数の役（端末と worktree）が居る
  const roles = Object.entries(asObject(workers.roles) ?? {}).filter(
    ([, record]) => (asString(get(record, 'dispatch')) ?? '') !== '',
  )
  const sink: Sink = { offers: emptyOffers(), kept: [], stopped: { reasons: [], reported: [], inspect: [] } }
  if (roles.length === 0) sink.stopped.reasons.push(MISSING)
  let held = false
  for (const [role, record] of roles) {
    planRole(role, record, listed, sink, { merged, notSaved, unattended: saved })
    held = planSuperseded(role, record, listed, sink) || held
  }
  const refusal = recordRefusal(dir)
  const reasons: string[] = []
  if (refusal !== null) reasons.push(refusal)
  if (refusal === null && !merged) {
    reasons.push('the work is not merged yet, so this is the only copy of the request and result')
    const hint = prSaved ? '' : mergedByHand(dir, workers)
    if (hint !== '') reasons.push(hint)
    reasons.push(...notSaved)
  }
  if (refusal === null && held) {
    reasons.push(
      'Orca still holds a replaced attempt of this task, and this record is what tells a later Step 5 that it is ours',
    )
  }
  if (saved) {
    const parts: string[] = []
    for (const [role, record] of roles) {
      const worker = listed.find((entry) => get(entry, 'dispatchId') === get(record, 'dispatch'))
      if (!sink.offers.terminal.some((offer) => offer.role === role) && !GONE_STATES.includes(releaseState(worker))) {
        parts.push(`${role} terminal`)
      }
      if (!sink.offers.worktree.some((offer) => offer.role === role)) parts.push(`${role} worktree`)
    }
    if (parts.length > 0) {
      reasons.push(`part of this task stays (${parts.join(', ')}), so the record that points at it stays too`)
    }
  }
  if (reasons.length === 0) sink.offers.record.push({ path: dir })
  else sink.kept.push({ kind: 'record', role: null, reasons })
  const slug = basename(dir)
  // ★ タスクの停止は「そのタスクの何も閉じない・消さない」。提示を全部取り下げる
  if (sink.stopped.reasons.length > 0) {
    return {
      slug,
      status_dir: dir,
      stopped: sink.stopped,
      offers: emptyOffers(),
      kept: [],
      ...savedProof,
    }
  }
  return {
    slug,
    status_dir: dir,
    stopped: null,
    offers: sink.offers,
    kept: sink.kept,
    ...savedProof,
  }
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

const buildPlan = (dirs: string[], prSaved: Set<string>, heads: Map<string, string> = new Map()): Built => {
  // [C7] 前半。別の Run の dir が混じると既知の集合が広がり、本物の ghost を隠す。Orca を呼ぶ前に確かめる
  const first = dirs[0] ?? ''
  const run = runOf(first)
  if (run === '') return { ok: false, lines: [MISSING] }
  const foreign = dirs.find((dir) => runOf(dir) !== run)
  if (foreign !== undefined) {
    return { ok: false, lines: [`${foreign} does not belong to Run ${run}; do not close or remove anything`] }
  }
  const inputs: { dir: string; workers: JsonObject }[] = []
  for (const dir of dirs) {
    const workers = asObject(readJson(join(dir, 'workers.json')))
    if (workers === null) return { ok: false, lines: [MISSING] }
    inputs.push({ dir, workers })
  }

  // [C7] 後半。worker-retain は durable な例外を残す。記録に無い保持は他者のものか前回の自分たちのもの
  // ★ 置き換えた試行（orca-recover の --retry-of）も記録のうちである。Orca がそれを retained のまま
  //   持っていても、他者や前回の保持ではない
  const known = new Set(
    inputs.flatMap(({ workers }) =>
      Object.values(asObject(workers.roles) ?? {})
        .flatMap((record) => [
          get(record, 'dispatch'),
          ...(asArray(get(record, 'superseded')) ?? []),
          ...(asArray(get(record, 'follow_ups')) ?? []),
        ])
        .map((id) => asString(id))
        .filter((id) => id !== null),
    ),
  )
  const retained = receiptArray(
    runOrca(['orchestration', 'worker-list', '--run', run, '--terminal-state', 'retained', '--json']),
    'workers',
  )
  if (retained === null)
    return { ok: false, lines: ['could not list what Orca still holds for this Run; do not remove anything'] }
  const ghosts = retained
    .map((worker) => get(worker, 'dispatchId'))
    .filter((id) => typeof id !== 'string' || !known.has(id))
    .map((id) => (typeof id === 'string' ? id : JSON.stringify(id ?? null)))
  if (ghosts.length > 0) {
    return {
      ok: false,
      lines: [
        'Orca still holds retained workers we did not record:',
        ...ghosts,
        'do not remove any worktree or dispatch record for this Run',
      ],
    }
  }

  // [C1]〜[C3] は Run 全体の 1 回の答えから、タスクごとに分類する
  const listed = receiptArray(runOrca(['orchestration', 'worker-list', '--run', run, '--json']), 'workers')
  if (listed === null) return { ok: false, lines: [UNREADABLE] }
  const plan: CleanupPlan = {
    run_id: run,
    tasks: inputs.map(({ dir, workers }) => planTask(dir, workers, listed, prSaved.has(dir), heads.get(dir) ?? null)),
  }
  // status dir は `<repo>/.dispatch/<slug>` なので、計画はその隣の `<repo>/.dispatch/cleanup-<run_id>.json` に置く
  const file = join(dirname(first), `cleanup-${run}.json`)
  if (!writeAtomic(file, `${JSON.stringify(plan, null, 2)}\n`)) {
    return { ok: false, lines: [`could not write the cleanup plan to ${file}; do not close or remove anything`] }
  }
  return { ok: true, plan, file }
}
const planCommand = (args: string[]): number => {
  const { values } = parseFlags(NAME, {
    args,
    options: {
      'status-dir': { type: 'string', multiple: true },
      'pr-saved': { type: 'string', multiple: true },
    },
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

  const savedGiven = values['pr-saved'] ?? []
  if (savedGiven.includes('')) return die(NAME, '--pr-saved must not be empty')
  const prSaved = new Set(savedGiven.map((dir) => resolve(dir)))
  for (const dir of prSaved) {
    if (!dirs.includes(dir)) return die(NAME, `${dir} is not one of the --status-dir values`)
  }

  const built = buildPlan(dirs, prSaved)
  if (!built.ok) return stopRun(built.lines)
  printPlan(built.plan, built.file)
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
    const prSaved = get(item, 'pr_saved') === true
    if (prSaved && prSavedReasons(statusDir, workers, asString(get(item, 'pr_head'))).length > 0) return null
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
    if (
      offers.record.length > 0 &&
      !prSaved &&
      get(readJson(join(statusDir, 'integration-result.json')), 'merged') !== true
    ) {
      return null
    }
    plan.tasks.push({ slug, status_dir: statusDir, stopped, offers, kept, ...(prSaved ? { pr_saved: true } : {}) })
  }
  return plan
}

// ★ worker-release は ok を返しながら何も解放しないことがある（実測 O43: releaseState retained /
//   retainedReason user_takeover。2026-09-23 と 24 には ownershipState user_owned / retainedReason user_requested で
//   4 Run の design）。Step 5 と同じ worker-list から state を読み直して確かめる。
//   その役の worktree へ進めてよいのは、閉じたと確かめられたときと、Orca が retained のまま保持した理由がユーザーの
//   所有（ownershipState: user_owned。retainedReason は問わない）か user_takeover（spec 4-2）のときだけ。
//   読み直せない・未確定・ほかの理由での保持は、その役の失敗として、その役の worktree とタスクの記録を止める
const release = (run: string, offer: TerminalOffer): { ok: boolean; line: string; held?: boolean } => {
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
    if (userOwned(worker)) {
      return {
        ok: true,
        held: true,
        line: `  kept: ${label}: the user owns it (ownershipState: user_owned, releaseState: retained, retainedReason: ${reason}), so Orca did not close it; removing its worktree closes it`,
      }
    }
    const kept = `Orca kept it (releaseState: retained, retainedReason: ${reason}); it was not closed`
    return reason === 'user_takeover'
      ? { ok: true, held: true, line: `  kept: ${label}: ${kept}` }
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
const removeRecord = (label: string, offer: RecordOffer, prSaved: boolean): { ok: boolean; line: string } => {
  const refusal = recordRefusal(offer.path)
  if (refusal !== null) return { ok: false, line: `  failed: ${label}: ${refusal}` }
  if (prSaved && prUrlOf(offer.path) === '') {
    return { ok: false, line: `  failed: ${label}: the pull request is not recorded` }
  }
  if (!prSaved && get(readJson(join(offer.path, 'integration-result.json')), 'merged') !== true) {
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
    (offer): Step => ({
      kind: 'terminal',
      role: offer.role,
      label: `${offer.role} terminal`,
      act: () => release(run, offer),
    }),
  ),
  ...task.offers.worktree.map((offer): Step => {
    const label = `${offer.role} worktree id:${offer.worktree_id}`
    return { kind: 'worktree', role: offer.role, label, act: () => removeWorktree(label, offer) }
  }),
  ...task.offers.record.map((offer): Step => {
    const label = `dispatch record ${offer.path}`
    return { kind: 'record', role: null, label, act: () => removeRecord(label, offer, task.pr_saved === true) }
  }),
]

// ★ **失敗が止めるのは、それに依存する手順だけ。**役の worktree はその役の端末に依存し（役ごとに worktree は別で、
//   [C3] はその worktree の端末がその役の記録どおりのときだけ提示する）、記録はタスクの全手順に依存する（最後に
//   失うもの）。ほかの役の端末と worktree は続ける。2026-09-24 に、design の端末 1 本が閉じなかっただけで、同じ
//   タスクの残り 3 本の端末と 4 つの worktree が 1 つも実行されなかった。返り値は止める理由（依存が無事なら null）
const blockedBy = (step: Step, failed: boolean, failedRoles: Set<string>): string | null => {
  if (step.kind === 'record') return failed ? 'an earlier step for this task failed' : null
  if (step.kind === 'worktree' && step.role !== null && failedRoles.has(step.role)) {
    return `the ${step.role} terminal step failed`
  }
  return null
}

// ★ 無人の片付けでは、plan のあとにユーザーへ渡った端末の worktree と記録も残す
const heldBy = (step: Step, task: TaskPlan, heldRoles: Set<string>): string | null => {
  if (task.pr_saved !== true) return null
  if (step.kind === 'worktree' && step.role !== null && heldRoles.has(step.role)) {
    return `the user took over the ${step.role} terminal after the plan, so its worktree stays`
  }
  if (step.kind === 'record' && heldRoles.size > 0) {
    const parts = [...heldRoles].map((role) => `${role} terminal`)
    return `part of this task stays with the user (${parts.join(', ')}), so the record that points at it stays too`
  }
  return null
}
const runTask = (run: string, task: TaskPlan, approved: Set<Kind>): { lines: string[]; failed: boolean } => {
  const lines = [task.slug]
  let failed = false
  const failedRoles = new Set<string>()
  const heldRoles = new Set<string>()
  for (const step of stepsOf(run, task)) {
    const blocker = blockedBy(step, failed, failedRoles) ?? heldBy(step, task, heldRoles)
    if (!approved.has(step.kind)) {
      lines.push(`  kept: ${step.label} (not approved)`)
    } else if (blocker !== null) {
      // ★ 失敗は、それに依存する手順を authorise しない
      lines.push(`  not run: ${step.label} (${blocker})`)
    } else {
      const outcome = step.act()
      if (task.pr_saved === true && outcome.held === true && step.role !== null) heldRoles.add(step.role)
      if (!outcome.ok) {
        failed = true
        if (step.role !== null) failedRoles.add(step.role)
      }
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

const executePlan = (plan: CleanupPlan, approved: Map<string, Set<Kind>>): { lines: string[]; failed: boolean } => {
  const lines: string[] = []
  let failed = false
  const tasks = [...plan.tasks].sort((left, right) => (left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0))
  for (const task of tasks) {
    const outcome = runTask(plan.run_id, task, approved.get(task.slug) ?? new Set<Kind>())
    lines.push(...outcome.lines)
    failed = failed || outcome.failed
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
  const { lines, failed } = executePlan(plan, approved)
  process.stdout.write(`${lines.join('\n')}\n`)
  return failed ? 1 : 0
}

// ★ 同じ Run の記録を全部渡し、ほかのタスクの worker を [C7] の ghost と取り違えない
const sameRunDirs = (dispatchDir: string, run: string): string[] => {
  try {
    return readdirSync(dispatchDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(dispatchDir, entry.name))
      .filter((dir) => runOf(dir) === run)
      .sort()
  } catch {
    return []
  }
}

// ★ 保存済みと判定した対象だけを承認し、実行前には run と同じ検査を通す
const cleanSaved = (
  built: { plan: CleanupPlan; file: string },
  slugs: string[],
): { lines: string[]; failed: boolean } => {
  const lines: string[] = []
  const approved = new Map<string, Set<Kind>>()
  for (const task of built.plan.tasks.filter((item) => slugs.includes(item.slug))) {
    if (task.stopped !== null) {
      lines.push(`${task.slug}: Step 5 stopped this task, so nothing was cleaned up`)
      lines.push(...task.stopped.reasons.map((reason) => `    - ${reason}`))
      continue
    }
    if (task.pr_saved !== true) {
      lines.push(`${task.slug}: the pull request is not proven saved, so nothing was cleaned up`)
      lines.push(...task.kept.flatMap(keptLines))
      continue
    }
    const kinds = (['terminal', 'worktree', 'record'] as const).filter((kind) => task.offers[kind].length > 0)
    if (kinds.length === 0) {
      lines.push(`${task.slug}: nothing to clean up`)
      lines.push(...task.kept.flatMap(keptLines))
      continue
    }
    approved.set(task.slug, new Set(kinds))
  }
  if (approved.size === 0) return { lines, failed: false }
  const read = readPlan(built.file)
  if (read === null) {
    lines.push(`could not read the cleanup plan ${built.file}; nothing was run`)
    return { lines, failed: true }
  }
  const selected: CleanupPlan = { run_id: read.run_id, tasks: read.tasks.filter((task) => approved.has(task.slug)) }
  const outcome = executePlan(selected, approved)
  return { lines: [...lines, ...outcome.lines], failed: outcome.failed }
}

const autoCommand = (args: string[]): number => {
  const { values } = parseFlags(NAME, {
    args,
    options: { 'status-dir': { type: 'string' } },
    strict: true,
    allowPositionals: false,
  })
  if (values['status-dir'] === undefined) return die(NAME, `auto needs --status-dir <dir>\n${USAGE}`)
  if (values['status-dir'] === '') return die(NAME, '--status-dir must not be empty')
  const dir = resolve(values['status-dir'])
  const slug = basename(dir)
  const workers = asObject(readJson(join(dir, 'workers.json')))
  if (get(workers, 'transport') === 'mail') {
    process.stdout.write(`${slug} was started by --auto (transport: mail); nothing to do\n`)
    return 0
  }
  const mode = asString(get(workers, 'cleanup')) ?? 'end'
  if (mode !== 'pr_created') {
    process.stdout.write(`cleanup mode is ${mode}; nothing to do\n`)
    return 0
  }
  const run = runOf(dir)
  if (run === '') {
    process.stdout.write(`${MISSING}\nnothing was cleaned up for ${slug}\n`)
    return 0
  }
  const built = buildPlan(sameRunDirs(dirname(dir), run), new Set([dir]))
  if (!built.ok) {
    process.stdout.write(`${[...built.lines, `nothing was cleaned up for ${slug}`].join('\n')}\n`)
    return 0
  }
  const outcome = cleanSaved(built, [slug])
  process.stdout.write(`${outcome.lines.join('\n')}\n`)
  return outcome.failed ? 1 : 0
}
const sweepCommand = (args: string[]): number => {
  parseFlags(NAME, { args, options: {}, strict: true, allowPositionals: false })
  const root = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  })
  if (root.status !== 0) {
    process.stdout.write('sweep: not inside a git repository; nothing to sweep\n')
    return 0
  }
  const dispatchDir = join(root.stdout.trim(), '.dispatch')
  let all: string[] = []
  try {
    all = readdirSync(dispatchDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(dispatchDir, entry.name))
      .filter((dir) => runOf(dir) !== '')
      .sort()
  } catch {
    all = []
  }
  const candidates = all.filter((dir) => {
    const workers = asObject(readJson(join(dir, 'workers.json')))
    return workers !== null && workers.transport !== 'mail' && workers.cleanup === 'pr_merged' && prUrlOf(dir) !== ''
  })
  const lines: string[] = []
  const targets = new Map<string, string[]>()
  const heads = new Map<string, string>()
  for (const dir of candidates) {
    const url = prUrlOf(dir)
    const result = spawnSync('gh', ['pr', 'view', '--json', 'state,headRefOid', url], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: GH_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    })
    const pr = result.status === 0 ? parseJson(result.stdout) : null
    const state = asString(get(pr, 'state'))
    if (state === null) {
      lines.push(`could not read ${url}; left as is`)
    } else if (state === 'MERGED') {
      const run = runOf(dir)
      targets.set(run, [...(targets.get(run) ?? []), dir])
      const head = validHead(asString(get(pr, 'headRefOid')))
      if (head !== null) heads.set(dir, head)
    }
  }
  for (const [run, dirs] of targets) {
    const built = buildPlan(
      all.filter((dir) => runOf(dir) === run),
      new Set(dirs),
      heads,
    )
    if (!built.ok) {
      lines.push(`Run ${run}: nothing was cleaned up`, ...built.lines.map((line) => `  ${line}`))
      continue
    }
    lines.push(
      ...cleanSaved(
        built,
        dirs.map((dir) => basename(dir)),
      ).lines,
    )
  }
  if (lines.length === 0) lines.push('sweep: nothing to clean up')
  process.stdout.write(`${lines.join('\n')}\n`)
  return 0
}
const main = (argv: string[]): number => {
  const [command, ...rest] = argv
  if (command === 'plan') return planCommand(rest)
  if (command === 'run') return runCommand(rest)
  if (command === 'auto') return autoCommand(rest)
  if (command === 'sweep') return sweepCommand(rest)
  return die(NAME, USAGE)
}

// ★ process.exit で終えない。パイプへの stdout 書き込みが途中で切れうる（macOS ではパイプが非同期）
process.exitCode = main(process.argv.slice(2))
