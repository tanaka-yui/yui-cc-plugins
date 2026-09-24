// 自分の worker たちの worker_done を待つ。
// Usage: node orca-wait.ts --status-dir <d> [--status-dir <d> ...] [--max-waits <n>]
//        [--timeout-ms <n>] [--stall-after-min <n>] [--on-stall ask|report]
// Exit: 0 全件成功 / 5 失敗 / 1 batch 不明 / 2 使用法 / 3 時間切れ / 4 transport 不明
//       / 6 worker の質問 / 8 停滞
// ★ cursor は ack だけで進む。batch を全件処理できなければ ack しない。
import { die, log } from '../lib/cli.ts'
import { startIncomplete } from '../lib/dispatch.ts'
import { readJson, writeAtomic } from '../lib/fs.ts'
import { asArray, asObject, asString, get, type Json, type JsonObject, parseJson } from '../lib/json.ts'
import { orcaBin, receiptOk, runOrca, terminalHandles, workerStateClass, workerTerminal } from '../lib/orca.ts'
import { envCount, nowSeconds, run, runNode, sleepSeconds } from '../lib/sys.ts'

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const NAME = 'orca-wait'
const HERE = dirname(fileURLToPath(import.meta.url))
// 移植元の理由（bin/orca-wait.sh）:
// ★ **既定は 24 時間**（5 分 × 288）。子は待機に期限を持たないので、これは子を見捨てる期限では
//   ない。24 時間ごとに exit 3 で状況を報告し、親が呼び直すための区切りである。
// ★ **停滞の既定は 120 分。**子が書くものがそれだけ変わらなければ知らせる（止めはしない）。
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
  unconfirmedSeen: Set<string>
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
// 移植元の理由（bin/orca-wait.sh）:
// ★ **鍵は status dir ではなく (status dir, role) の組である。**レビューモードでは 1 つの
//   タスクが 2 つの dispatch を持ち、**両方が worker_done を送る**。status dir 単位で
//   期待集合を作ると reviewer の message が未知になり、`batch carries a message this
//   version cannot handle` で **batch ごと永久に詰まる**。
//
// ★ **期待集合は組み直せる必要がある。**`orca-start.ts --phase exec` は、この待機が
//   走っている最中に `workers.json` へ 2 段目の dispatch を足す。起動時に 1 度読んだ
//   きりだと、その dispatch の message が「未知」になって batch ごと落ちる
//   （実測 2026-09-11: exec の merge_ready が `unknown dispatch` で exit 1 になった）。
//
// ★ **まだ起動していない役は飛ばす。**片方だけ在るのは記録の破れなので開始時に閉じる —
//   dispatch を知らない worker の worker_done は routing できず、batch を詰まらせる。
//
// ★ **同じ (task, dispatch) を 2 つが名乗ってはならない**（2 つの dir でも、
//   1 つの dir の 2 役でも同じ事故である）。idx_of は先頭しか返さない
//   ので、batch は 1 つ目だけに記録されたまま ack される。2 つ目は永久に settle せず
//   receipt も残らない。他の identity 不一致と同じく **開始時に閉じる**
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
// 移植元の理由（bin/orca-wait.sh）:
// ★ 添字が (task, dispatch) の鍵である。bash 3.2 に連想配列は無いので、
//   T_SD/T_ROLE/TASKS/DISPS を同じ添字で引ける整数を map の key として使う。
const indexOf = (state: State, task: string, dispatch: string): number =>
  state.expected.entries.findIndex((entry) => entry.task === task && entry.dispatch === dispatch)
// ★ 読めない記録を「置き換えられた」と誤認すると worker_done を ack で失う。
const currentState = (entry: Entry): 'current' | 'superseded' | 'unreadable' | 'mismatch' => {
  const workers = asObject(readJson(join(entry.statusDir, 'workers.json')))
  const roles = asObject(workers?.roles)
  const record = asObject(roles?.[entry.role])
  if (workers === null || roles === null || record === null) return 'unreadable'
  if (string(record.dispatch) === entry.dispatch) return 'current'
  if ((array(record.superseded) ?? []).includes(entry.dispatch)) return 'superseded'
  return 'mismatch'
}
const supersededBy = (
  statusDirs: string[],
  dispatch: string,
): { kind: 'superseded'; statusDir: string; role: string } | { kind: 'unreadable' } | null => {
  for (const statusDir of statusDirs) {
    const workers = asObject(readJson(join(statusDir, 'workers.json')))
    const roles = asObject(workers?.roles)
    if (roles === null) return { kind: 'unreadable' }
    for (const [role, record] of Object.entries(roles)) {
      if ((array(get(record, 'superseded')) ?? []).includes(dispatch)) return { kind: 'superseded', statusDir, role }
    }
  }
  return null
}
type Resolved =
  | { kind: 'current'; index: number }
  | { kind: 'superseded'; statusDir: string; role: string }
  | { kind: 'unreadable' }
  | { kind: 'unknown' }
const resolveDispatch = (state: State, task: string, dispatch: string): Resolved => {
  const index = indexOf(state, task, dispatch)
  const entry = state.expected.entries[index]
  if (entry !== undefined) {
    const current = currentState(entry)
    if (current === 'current') return { kind: 'current', index }
    if (current === 'unreadable') return { kind: 'unreadable' }
    // 期待集合に残る旧 dispatch は読み直しへ渡す。ここで無視すると health check が旧試行を見続ける。
    if (current === 'superseded') return { kind: 'unknown' }
    return { kind: 'unknown' }
  }
  const replaced = supersededBy(state.statusDirs, dispatch)
  return replaced ?? { kind: 'unknown' }
}
// 移植元の理由（bin/orca-wait.sh）:
// ★ **「誰も待っていない」をディスクから分かるようにする。**この待機は最大 24 時間
//   常駐するので、**ホスト側の都合で外から止められることがある**（実測 2026-09-11、
//   2 回連続: worker 自身が同じマシンでテストを並列に回してメモリを食い、ハーネスが
//   メモリ逼迫を理由にこのプロセスを停止した）。ack より前に落ちるので取りこぼしは
//   無い設計どおりだが、**誰も起動し直さなければ worker は永久に返事を待つ。**
//   気づくかどうかを人の記憶に賭けない — 鼓動を残し、`orca-recover.ts` に読ませる。
//   **鼓動の失敗で待機を止めない。**書けないことは、待てないことではない。
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
// 移植元の理由（bin/orca-wait.sh）:
// ★ **ユーザーが止めた役は決着済みとして扱う**（`orca-stop.ts`）。止めた端末は閉じてあり、
//   worker_done は二度と来ない。**receipt が在ればそれが優先する**（閉じる直前に送られた場合）。
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
// 移植元の理由（bin/orca-wait.sh）:
// ★ **停滞は親が見つけ、止めるかどうかは人が決める。**子は待機に期限を持たない（待っている
//   相手の事情を知らないので「来ない」を判断できない）。タスク単位で「子が書くもの」が一定時間
//   どれも変わらなければ知らせる。**親が書くもの（wait.json / .woken / received.json /
//   questions.json / stall.json）は数えない** — 数えると親の鼓動で常に「変化あり」になる。
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
// 移植元の理由（bin/orca-wait.sh）:
// ★ **人を待っている間は停滞ではない。**人とのやりとりを見た時点を残し、時計をそこから戻す。
//   書けなくても待機は止めない（最悪、ユーザーに 1 回余計に尋ねるだけで、誤って止めはしない）
const markHuman = (statusDir: string): void => {
  write(statusDir, 'human.json', { last_human_at: nowSeconds() })
}
// 移植元の理由（bin/orca-wait.sh）:
// ★ **停滞の判定は workers.json をその都度読む。**期待集合（TASKS）が読み直されるのは知らない
//   dispatch の message が来たときだけなので、`--phase exec` で足された exec は最初の message
//   まで見えない。そこで決着済みの design だけを見てタスクを決着済みと数えると、exec が何時間
//   黙っていても誰にも知らされない。
const dispatchedRoles = (statusDir: string): string[] =>
  Object.entries(object(get(read(statusDir, 'workers.json'), 'roles')))
    .filter(([, role]) => string(get(role, 'dispatch')) !== '')
    .map(([role]) => role)
const integrationRoleOf = (statusDir: string): string =>
  string(get(read(statusDir, 'workers.json'), 'integration_role')) || 'design'
const roleSettled = (statusDir: string, role: string): boolean => (roleOutcome(statusDir, role) ?? '') !== ''
// 移植元の理由（bin/orca-wait.sh）:
// ★ **成果が載る見込みの無くなったタスクは失敗で決着する。**作る役（design / exec）を
//   ユーザーが止めた（receipt 無し）か、計画役の design が失敗した。どちらも exec は起こされない
//   （Step 3.5）ので、integration_role=exec の status を待つと永久に終わらない。
const taskGivenUp = (statusDir: string): boolean => {
  for (const role of ['design', 'exec']) {
    if (isStopped(statusDir, role) && storedOutcome(statusDir, role) === '') return true
  }
  return integrationRoleOf(statusDir) !== 'design' && storedOutcome(statusDir, 'design') === 'failed'
}
// 移植元の理由（bin/orca-wait.sh）:
// ★ **成果を載せる役がまだ起動されていなければ決着していない**（Step 3.5 の飛ばし）
const taskSettled = (statusDir: string): boolean => {
  if (!dispatchedRoles(statusDir).every((role) => roleSettled(statusDir, role))) return false
  return taskGivenUp(statusDir) || roleSettled(statusDir, integrationRoleOf(statusDir))
}
// 移植元の理由（bin/orca-wait.sh）:
// ★ 依頼側がまだ待っている = dispatch が在り、receipt も stopped.json も無い（orca-stop.ts の waiting と同じ問い）
const roleWaiting = (statusDir: string, role: string): boolean =>
  string(get(read(statusDir, 'workers.json'), 'roles', role, 'dispatch')) !== '' && !roleSettled(statusDir, role)
// 移植元の理由（bin/orca-wait.sh）:
// ★ **決着済み・止めた役は載せない。**載せると、止めたのに同じ役をまた尋ねる。
//   ★ **例外は決着済みの reviewer で、依頼側がまだ待っているとき。**verdict を届けられずに
//   終えた reviewer を止めれば依頼側へ review-skipped が届くが、止める選択肢はこの行からしか
//   作られない。載せないと、ユーザーは待ち続けるか依頼側を止めるかしか選べない
//
// ★ 起動されていない成果の役を知らせるのは、起動済みの役が全部決着してから（計画役がまだ
//   働いている間に Step 3.5 へ送らない）
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
// 移植元の理由（bin/orca-wait.sh）:
// ★ report は抜けない（無人の --issue）。**同じ停滞で毎周書かない**
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
// 移植元の理由（bin/orca-wait.sh）:
// ★ **空を「receipt 0 件」と読まない。**jq は空入力に空を返して 0 で終わるので、
//   検査しないまま追記すると空のまま write が成功し、**ack が通って message が消える**
//
// ★ jq の出力を **検査せずに write へ渡さない**。空を書けば receipt が消える
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
// 移植元の理由（bin/orca-wait.sh）:
// ★ **無レビューの成果を黙って通さない。**レビュー役が起きているのに verdict が 1 つも
//   残らないまま終わることが起きる（実測 2026-09-11: exec の review 待ちが waiter_exists で
//   始められず、verdict 無しで成果を差し出して succeeded になった）。
//   **ここで差し戻してはならない** — 「round 2 で打ち切り」も「1 時間 ×2 で諦めて進む」も
//   spec が認めた離脱経路であり、ゲートにするとその worker は永久に差し戻され続ける。
//   受理はする。**そのうえで、そう見えるようにする。**
//   判定そのものは `review-state.ts` が正本で、`orca-merge.ts` の gate と同じ問いを使う。
const reviewState = (statusDir: string, role: string): string => {
  const result = runNode(join(HERE, 'review-state.ts'), ['--status-dir', statusDir, '--role', role])
  return result.rc === 0 ? result.stdout.trim() : 'none'
}
// ★ 相 3 の検証。成果が無いのに受理して端末を閉じると欠落に気づけない。
// 移植元の理由（bin/orca-wait.sh）:
// ★ **相 3 の検証。**役ごとに「成果が検証可能な形で在るか」を見る（spec 10-1 の表）。
//   ここを緩めると、成果が無いのに受理して端末を閉じ、**欠落に誰も気づかない**。
//
// ★ **review 役を例外にしない**（spec 10-4）。例外にすると findings の受理時点が
//   未定義のまま端末が閉じられ、欠落に誰も気づかない。
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
    let names: string[] = []
    try {
      names = readdirSync(join(statusDir, 'review')).sort()
    } catch {
      /* review はまだ無い */
    }
    for (const name of names) {
      if (!new RegExp(`^${prefix}-round-.*-findings\\.md$`).test(name)) continue
      found = true
      try {
        if (/^VERDICT: /m.test(readFileSync(join(statusDir, 'review', name), 'utf8'))) continue
      } catch {
        // 読めない findings を承認しない
      }
      return `${name} has no VERDICT line`
    }
    if (!found && !nonempty(join(roleDir, 'result.md'))) return 'neither findings nor result.md exist'
  } else if (!nonempty(join(roleDir, 'result.md'))) return 'result.md is missing or empty'
  return ''
}
// 移植元の理由（bin/orca-wait.sh）:
// ★ **相 4a / 4b。**受理も差し戻しも **同じ active な Dispatch** へ返す。別の宛先へ送ると
//   worker は待ち続ける。
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
// 移植元の理由（bin/orca-wait.sh）:
// ★ **配送と起床は別の事実である。**`orchestration send` はメールボックスに入れるだけで、
//   ターンを終えた worker を起こさない（実測 2026-09-10: 1 Run の 4 worker 全員が
//   `completion-accepted` を未読のまま停止し、端末へ直接入力して初めて動き出した）。
//   **ベストエフォート。**起こせなかったことで配送を無かったことにしてはならないので、
//   ここの失敗は batch の結末に影響させない。
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
// 移植元の理由（bin/orca-wait.sh）:
// ★ **返事の直後の 1 回では足りない。**その 1 回が空振りしたら、24 時間だれも気づかない。
//   **叩いてよいのは「返事を待っていることが確定している役」だけ** — `merge_ready_sent`
//   のまま settle していない役である。働いている worker の端末に文字列を撃ち込まない。
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
// 移植元の理由（bin/orca-wait.sh）:
// ★ **heartbeat は liveness signal であって、記録すべき状態を持たない。**Orca が
//   worker preamble で 5 分ごとに送らせるので、未知として batch を止めると
//   起動した全 dispatch が永久に詰まる（実測）。読み飛ばして ack を通す。
//   捨てても失われる内容は無い — outcome も nonce も質問も運ばない。
//
// ★ **`question` は詰まりではなく「人へ取り次げ」である。**worker は `ask` で
//   ブロックしており、**親は `orchestration reply` で答えられる**。未知として扱って
//   batch を止めると、答えれば進む dispatch が永久に止まる（実測で踏んだ）。
//
//   ★ **初回は ack しない**（答えるまで処理済みではない）が、**2 度目は処理済みとして
//   通す。**通さないと、人が答えたあとも同じ質問が queue の先頭に居座り、その worker の
//   `merge_ready` が永久に後ろで待つ（実測: 答えたのに count が 2 のまま減らなかった）。
//
// ★ **一度出した質問で二度止まらない。**取り次いだ時点でこの message の用は済んで
//   いる（worker が動き出すのは `reply` であって ack ではない）。記録しないと、
//   答えたあとも同じ質問で永久に止まり続ける（実測で踏んだ）。
//
// ★ **相 3〜4。**`merge_ready` は worker が「検証してくれ」と言っている状態である。
//   検証して受理か差し戻しを **同じ Dispatch** へ返し、この message は処理済みにする。
//
// ★ **止めた役には返事をしない。**端末は閉じており、受理を送っても読む者は居ない
//
// ★ **nonce は subject で運ぶ。**`--payload` は `--task-id` などの便宜フラグに
//   上書きされるので、そこへ入れても届かない（実測: payload に taskId と dispatchId
//   しか残らなかった）。payload 側も一応見るが、正本は subject である。
//
// ★ **処理できない message は捨てない。**捨てて ack すると cursor だけ進んで内容が消える
//
// ★ 矛盾は **同じ (task, dispatch) の中だけ**で見る。別タスクが別 outcome で settle するのは正常
//
// ★ 記録できなかったのは **retention の write 失敗と同じ種類の事故**である。
//   ふつうの filesystem エラーを 1 (再実行しても無駄) に落としてはならない (return 2)
//
// ★ 止めた役は端末を閉じてある。保持する資源が無いので retain をかけない
//   （かけると失敗して batch が ack されず、同じ batch を永久に読み直す）
//
// ★ **ack より前に owner を決める**（Orca guide）。この版の owner は常に「保持」である。
//   解放は Step 6 のユーザー承認後だけが行う (spec D12)。
//
// ★ **どの dispatch で失敗したかを名指しする。**4 件を drain している最中に id の無い
//   診断だけ出しても、どれを調べればよいか分からない。
//   receipt が問題のときに rc= を出さない — RETRC は process の状態であって receipt ではない
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
      if (resolved.kind === 'unreadable') {
        log(NAME, `cannot read workers.json for dispatch '${dispatch}'; the batch is not acknowledged`)
        return 2
      }
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
      if (resolved.kind === 'unreadable') {
        log(NAME, `cannot read workers.json for dispatch '${dispatch}'; the batch is not acknowledged`)
        return 2
      }
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
    if (resolved.kind === 'unreadable') {
      log(NAME, `cannot read workers.json for dispatch '${dispatch}'; the batch is not acknowledged`)
      return 2
    }
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
    const current = currentState(entry)
    if (current === 'unreadable' || current === 'mismatch') {
      log(NAME, `cannot confirm the current dispatch '${entry.dispatch}'; the batch is not acknowledged`)
      return 2
    }
    if (current === 'superseded') {
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
    const record = asObject(workers)
    const roles = asObject(record?.roles)
    const role = asObject(roles?.[entry.role])
    if (record === null || roles === null || role === null || string(role.dispatch) !== entry.dispatch) {
      log(NAME, `could not record the retention for dispatch '${entry.dispatch}'; the batch is not acknowledged`)
      return 2
    }
    const next = {
      ...record,
      roles: { ...roles, [entry.role]: { ...role, retained: true } },
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
// 移植元の理由（bin/orca-wait.sh）:
// ★ **知らない dispatch は「この版が扱えない」とは限らない。「まだ読んでいない」ことがある。**
//   2 段目 (`orca-start.ts --phase exec`) は、この待機が走っている最中に `workers.json` へ
//   dispatch を足す。ack していない以上 batch はキューの先頭に残っているので、期待集合を
//   読み直してもう一度 drain すれば、そのまま処理できる。
//   **読み直しても集合が変わらなければ、それは本当に未知である** — そこで初めて止まる。
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
// 移植元の理由（bin/orca-wait.sh）:
// ★ **終端の条件は「起動した全 dispatch の receipt が揃うこと」。**reviewer の
//   worker_done を待たずに戻ると、その message はあとから来て次の batch を詰まらせる。
//
// ★ **タスクの結末を決めるのは「成果を載せる役」である。**レビュー役が失敗しても、
//   それは「レビューが付かなかった」であって成果が失われたわけではない。その役の
//   outcome は finish が 1 行ずつ出すので、握り潰してはいない。
//
//   ★ 成果を載せる役は `integration_role`（実装役を分けたら design ではなく exec）。
//   **記録が無ければ design に落とす。**merge は同じ場面で止まるが (MG12)、あちらは
//   取り違えると成果を失う破壊的な操作である。待機は何も壊さないうえ、取り違えても
//   merge の厳格な gate が受け止める。ここで止めると、記録の無い古い status dir を
//   drain できなくなるほうが害が大きい。
//
// ★ 作る役をユーザーが止めたら（計画役を含む）、そのタスクは失敗である。status は書きかけの
//   まま残り、止めた計画役のあとに exec は起こされないので、status を待つと永久に終わらない。
//   計画役が失敗した場合も同じく exec は起こされない（task_given_up）
//
// ★ **無レビューのときだけ足す。**常に出すと、読む側が探す語が 1 つ増えるだけになる
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
    // worker_done 後は healthy() の対象外になる。空の端末 ID は決着時にも Orca から補う
    if (string(get(read(entry.statusDir, 'workers.json'), 'roles', entry.role, 'terminal')) === '') {
      const shown = runOrca(['orchestration', 'worker-show', '--dispatch', entry.dispatch, '--json'])
      if (receiptOk(shown)) recordTerminal(entry, shown.json)
    }
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
// ★ **記録に端末が無ければ、Orca が見せている端末で埋める。**ready にならなかった起動は端末を記録しない
//   （orca-start / orca-recover の start_incomplete）が、Orca はその dispatch の agentTerminalHandle を出している。
//   埋めないと停滞（exit 8）の stalled_role 行が terminal=none になって画面を読めず、Orca が live と言っても
//   orca-wake.ts が叩けない。**起動が終わらなかった役は、埋めても起動が終わらなかった役のまま残す** — 印を外すのは
//   画面を見たユーザーの判断（orca-recover.ts --adopt）である。印の無い旧形式の記録は「端末なし・status が starting」で
//   読まれる（lib/dispatch.ts）ので、端末だけ埋めると起動が終わったことになり、--adopt / --restart が効かなくなる。
//   同じ書き込みで印を明示する（round 1 のレビュー F2）。書けなくても待機は止めない
const recordTerminal = (entry: Entry, shown: Json | null): void => {
  const handle = workerTerminal(shown)
  if (handle === '') return
  const workers = asObject(read(entry.statusDir, 'workers.json'))
  const roles = asObject(workers?.roles)
  const role = asObject(roles?.[entry.role])
  if (workers === null || roles === null || role === null) return
  if (string(role.dispatch) !== entry.dispatch || string(role.terminal) !== '') return
  const next: JsonObject = { ...role, terminal: handle }
  const worktreeId = string(role.worktree_id)
  if (worktreeId !== '' && asArray(role.worktree_terminals) === null)
    next.worktree_terminals = terminalHandles(worktreeId)
  if (startIncomplete(entry.statusDir, entry.role)) next.start_incomplete = true
  if (write(entry.statusDir, 'workers.json', { ...workers, roles: { ...roles, [entry.role]: next } })) {
    log(NAME, `recorded terminal ${handle} for ${entry.role} (dispatch ${entry.dispatch}) as Orca reports it`)
  } else log(NAME, `could not record terminal ${handle} for ${entry.role}; a stall report will show terminal=none`)
}
// ★ **start_unknown で待機を落とさない**（lib/orca.ts の unconfirmed）。Orca がターン開始を観測できなかっただけで、
//   生死のどちらの証拠でもない。以前はここで 4 を返し、動いている reviewer が依頼を待っているのに Step 3 が
//   起動直後に止まった（2026-09-24、influencer-platform）。**死んでいれば子が何も書かないので、停滞（exit 8）で
//   見つかる。**同じ dispatch で毎周言わない。起動が終わらなかった役なら、画面を見て選ぶ回復の 1 行も添える
const noteUnconfirmed = (state: State, entry: Entry): void => {
  if (state.unconfirmedSeen.has(entry.dispatch)) return
  state.unconfirmedSeen.add(entry.dispatch)
  log(
    NAME,
    `${entry.role} (dispatch ${entry.dispatch}) is 'start_unknown': Orca never saw its turn start, which proves neither that it runs nor that it died; this wait keeps waiting on it, and a dead one is reported as a stall`,
  )
  if (!startIncomplete(entry.statusDir, entry.role)) return
  log(
    NAME,
    `its start did not complete; to see its screen and adopt or restart it, run: node ${join(HERE, 'orca-recover.ts')} --status-dir ${entry.statusDir} --role ${entry.role}`,
  )
}
// ★ worker_done 送信後の Orca の終端 state を、receipt 到着前に停止と読まない。
// 移植元の理由（bin/orca-wait.sh）:
// ★ **報告済みで記録前の worker を停止と読み違えない**（実測 2026-09-19、2 回）。worker は
//   `worker_done` を送った直後に Orca 側で終端状態になるが、こちらがそれを drain して
//   receipt にするのは次の周回である。その隙間で 4 を返すと、**まだ働いている兄弟タスクごと
//   待機が落ちる。**そこで、自分で報告して終わる状態（succeeded / failed）に限り、receipt が
//   来るまで数周だけ待つ。**待つのは数周だけ** — 送れずに終わった worker は猶予を使い切った
//   ところで今までどおり 4 になり、recovery の入口を塞がない。
//
// ★ **settle した dispatch を health check にかけない**（実測: 決着済みの dispatch の
//   worker-show は state 'succeeded' を返す。許容集合の外である）。かけると、先に
//   終わった 1 件が、まだ働いている兄弟ごと wait を 4 で落とす。
//   receipt があるなら、その dispatch はもう待つ対象ではない
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
    const status = string(get(shown.json, 'result', 'worker', 'state'))
    const kind = workerStateClass(status)
    // ★ 端末の補完と未確認の通知は、人を待っている worker にも行う（round 1 のレビュー F3）。agentWait で先に
    //   読み飛ばすと、入力待ちの start_unknown の worker の端末がいつまでも埋まらない
    if (kind === 'live' || kind === 'unconfirmed') {
      recordTerminal(entry, shown.json)
      if (kind === 'unconfirmed') noteUnconfirmed(state, entry)
    }
    const agentWait = get(shown.json, 'result', 'observation', 'agentWait')
    if (agentWait !== undefined && agentWait !== null && agentWait !== false && agentWait !== '') {
      markHuman(entry.statusDir)
      continue
    }
    if (kind === 'live' || kind === 'unconfirmed') {
      state.settleSeen.set(entry.dispatch, 0)
    } else if (kind === 'settled') {
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
// 移植元の理由（bin/orca-wait.sh）:
// ★ **`waiter_exists` は「壊れた」ではなく「まだ空いていない」。**段を足すために待機を
//   止めて再起動すると、サーバ側の waiter がしばらく残って再起動が弾かれる（実測
//   2026-09-10: ここで親が降り、worker たちは誰も受理しない返事を待ち続けた）。
//   タイムアウトで解放されるので、待って試し直す。**他の失敗では粘らない。**
const main = (argv: string[]): number => {
  const statusDirs: string[] = []
  let maxWaitsText = String(DEFAULT_MAX_WAITS)
  let timeoutText = String(DEFAULT_TIMEOUT_MS)
  let stallText = String(DEFAULT_STALL_MIN)
  let onStallText = 'ask'
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
      if (flag === '--max-waits') maxWaitsText = value
      if (flag === '--timeout-ms') timeoutText = value
      if (flag === '--stall-after-min') stallText = value
      if (flag === '--on-stall') onStallText = value
    } else die(NAME, `unknown option: ${flag}`)
  }
  if (statusDirs.length === 0) die(NAME, '--status-dir is required')
  const maxWaits = positive('--max-waits', maxWaitsText)
  const timeoutMs = positive('--timeout-ms', timeoutText)
  const stallMin = positive('--stall-after-min', stallText)
  if (onStallText !== 'ask' && onStallText !== 'report') die(NAME, `--on-stall must be ask or report: ${onStallText}`)
  const onStall = onStallText === 'report' ? 'report' : 'ask'
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
    unconfirmedSeen: new Set(),
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
