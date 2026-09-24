// 完了を託した worker が失われたとき、または起動が終わらなかったときに、その役の owner を回復する
// （旧版 orca-recover の移植。spec 10-1 / F-e）。
//
// Usage: node orca-recover.ts --status-dir <d> [--role <r>] [--dry-run] [--adopt | --restart]
// Exit:  0 = 判断して行動した（何もしないという判断を含む）/ 1 = 判断できない / 2 = 使用法エラー
//
// ★ **なぜ要るか。**O33 により **親は `worker_done` を代理送信できない。**元の agent process が消えたら
//   誰も送れない。これは失敗系だけでなく、`completion.json = accepted` の後・`worker_done` の前に worker が
//   失われた**成功系にも同じく存在する**。
// ★ **回復するのは「durable intent を実行できる owner」であって、completion の exactly-once journal ではない。**
// ★ **fence が先。**旧 capability と新 capability が同時に lifecycle を進めてはならない。だから
//   `outcome_unknown` では replacement を作らない（O19）。
// ★ **--adopt / --restart は、起動が終わらなかった役を Orca が start_unknown と言うときの、ユーザーの判断である。**
//   start_unknown は生死のどちらの証拠でもない（lib/orca.ts の workerStateClass）ので、引数なしでは画面の最後の数行と
//   2 つの手段を見せて止まる。--adopt は「動いている」: その端末を記録して start_incomplete を外す。--restart は
//   「動いていない」: worker-stop で fence し、Orca が stopped と言うのを確かめてから置き換える。どちらも --role で
//   1 役を名指しし、起動が終わらなかった役（start_incomplete）にだけ効く
import { die, log } from '../lib/cli.ts'
import { startIncomplete } from '../lib/dispatch.ts'
import { readJson, writeAtomic } from '../lib/fs.ts'
import { asArray, asObject, asString, get, type Json, type JsonObject } from '../lib/json.ts'
import {
  dispatchSettled,
  failureDetail,
  orcaBin,
  receiptOk,
  runOrca,
  terminalHandles,
  workerStateClass,
  workerTerminal,
} from '../lib/orca.ts'
import { nowSeconds, runNode } from '../lib/sys.ts'
import { trustBlocked, trustHint } from '../lib/trust.ts'

import { accessSync, constants, existsSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const NAME = 'orca-recover'
const HERE = dirname(fileURLToPath(import.meta.url))
const COMPLETION = join(HERE, '..', 'skills', 'orca-team-dispatch-task', 'scripts', 'completion.ts')
const WAKE = join(HERE, 'orca-wake.ts')
const SELF = fileURLToPath(import.meta.url)
// ★ 生死は画面でしか分からない。起動が終わらなかった役を Orca が start_unknown と言うとき、その最後の数行を見せる
const SCREEN_LINES = 15

const readable = (file: string): boolean => {
  try {
    accessSync(file, constants.R_OK)
    return true
  } catch {
    return false
  }
}

const isFile = (file: string): boolean => {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

// jq -r で読んで `^[0-9]+$` に合うか、と同じ判定（数値でも数字だけの文字列でもよい）
const count = (value: Json | undefined): number | null => {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 ? value : null
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  return null
}

// ★ **回復に入る前に「誰か待っているか」を言う。**待機は最大 24 時間常駐するので外から止められることがあり、
//   止まったままだと worker は生きているのに誰も受理を返さない。要るのは待機の起動し直しである。
//   **役ごとの判断は変えない** — 見落とさせないために言うだけである
const reportWait = (statusDir: string): void => {
  const stamp = readJson(join(statusDir, 'wait.json'))
  if (stamp === null) {
    log(NAME, 'no wait has stamped this status dir; if a worker is alive, start orca-wait.ts before recovering')
    return
  }
  const beat = count(get(stamp, 'beat'))
  if (beat === null) return
  const windowMs = count(get(stamp, 'window_ms')) ?? 300000
  // ★ 沈黙 3 窓ぶんで「居ない」とみなす。1 窓は待ちの上限そのものなので、2 窓では正常な 1 回の待ちを
  //   死んだと呼びかねない
  const limit = Math.max(Math.floor(windowMs / 1000) * 3, 60)
  const age = nowSeconds() - beat
  if (age >= limit) {
    log(
      NAME,
      `no wait has answered for ${age}s (its window is ${Math.floor(windowMs / 1000)}s); start orca-wait.ts again before recovering`,
    )
  }
}

type Role = { name: string; dispatch: string; task: string; record: JsonObject }

// 置き換えの発行と記録の間に応答を失ったら、新 dispatch の有無が分かるまで旧 nonce を戻さない
const reportParked = (statusDir: string, role: Role, parked: string): void => {
  const run = asString(get(readJson(join(statusDir, 'run.json')), 'run_id')) ?? ''
  const completion = join(statusDir, 'roles', role.name, 'completion.json')
  const retry = `node ${SELF} --status-dir ${statusDir} --role ${role.name}`
  const superseded = (asArray(role.record.superseded) ?? []).filter((id) => typeof id === 'string')
  log(NAME, `${role.name}: recovery stopped with its completion record parked at ${parked}; nothing was changed`)
  log(
    NAME,
    `  inspect task ${role.task}: ${orcaBin()} orchestration worker-list${run === '' ? '' : ` --run ${run}`} --json`,
  )
  log(NAME, `  known dispatch: ${role.dispatch}; superseded dispatches: ${superseded.join(', ') || '(none)'}`)
  log(
    NAME,
    `  if no new dispatch exists and ${completion} is absent, move ${parked} to ${completion}; then run ${retry}`,
  )
  log(
    NAME,
    `  if task ${role.task} has a dispatch outside that known set, do not restore ${parked}: record the new ID as roles.${role.name}.dispatch in ${join(statusDir, 'workers.json')}, set start_incomplete=true and retained=false, increment generation, append ${role.dispatch} to superseded, set terminal to Orca's agent handle and worktree_terminals to only that handle; then remove ${parked}, rerun ${retry}, and restart orca-wait.ts`,
  )
}

// ★ codex がフォルダの信頼を求めて止まった起動なら、その解き方を言う（lib/trust.ts）。案内する path は worker の worktree
//   から求める（codex はそこから本体の checkout の root を信頼の鍵にする）。記録に無ければ親の checkout で代える
const sayTrust = (statusDir: string, role: Role, shown: Json | null): void => {
  if (!trustBlocked(shown)) return
  const worktree =
    asString(role.record.worktree_path) || asString(get(readJson(join(statusDir, 'run.json')), 'repo_root')) || ''
  const retry = `node ${SELF} --status-dir ${statusDir} --role ${role.name}`
  for (const line of trustHint(role.name, workerTerminal(shown), worktree, retry)) log(NAME, line)
}

// 端末の画面の最後の数行。`terminal read --screen` の result.terminal.tail（行の配列）を読み、末尾の空行を落とす。
// 読めなければ worker-show が添える terminal.preview に落とし、それも無ければ空を返す
const screenTail = (terminal: string, shown: Json | null): string[] => {
  const screen = terminal === '' ? null : runOrca(['terminal', 'read', '--terminal', terminal, '--screen', '--json'])
  const tail = screen !== null && receiptOk(screen) ? asArray(get(screen.json, 'result', 'terminal', 'tail')) : null
  const lines =
    tail === null
      ? (asString(get(shown, 'result', 'terminal', 'preview')) ?? '').split('\n')
      : tail.filter((line): line is string => typeof line === 'string')
  while (lines.length > 0 && (lines.at(-1) ?? '').trim() === '') lines.pop()
  return lines.slice(-SCREEN_LINES)
}

// ★ **start_unknown の起動には何もせず、画面と 2 つの手段を見せて止まる。**生死のどちらの証拠でもないので、
//   置き換えるか引き受けるかは画面を見たユーザーが決める。勝手に置き換えると、生きている worker と 2 つの capability で
//   1 つの lifecycle を進めうる。勝手に引き受けると、死んだ worker を生きているとして待ち続ける
const showUnconfirmed = (statusDir: string, name: string, dispatch: string, shown: Json | null): void => {
  const terminal = workerTerminal(shown)
  log(
    NAME,
    `${name}: its start did not complete and Orca reports the worker as 'start_unknown' (dispatch ${dispatch}): Orca never saw its turn start, which proves neither that it runs nor that it died. Nothing was changed.`,
  )
  const lines = screenTail(terminal, shown)
  if (lines.length === 0) {
    log(NAME, `${name}: its screen could not be read; look at terminal ${terminal || '(none reported)'} in Orca`)
  } else {
    log(NAME, `${name}: the screen of terminal ${terminal || '(none reported)'} ends with:`)
    for (const line of lines) log(NAME, `  | ${line}`)
  }
  const self = `node ${SELF} --status-dir ${statusDir} --role ${name}`
  log(NAME, `${name}: look at it with the user, then run one of:`)
  log(NAME, `  the agent is working, or waiting on its mailbox: ${self} --adopt`)
  log(NAME, `  anything else (a shell prompt, an error, an update screen): ${self} --restart`)
}

// ★ **--adopt: 画面を見たユーザーが「動いている」と判断した起動を、その dispatch のまま引き受ける。**Orca が見せている
//   端末を記録し、start_incomplete の印を外し、端末の inventory を取り直す（ready になった起動が記録するものと同じ。
//   取り直さないと、Step 5 の [C3] は列挙できなかった worktree として片付けを拒む）。generation と完了の記録には
//   触らない — 置き換えは新しい worker を起こす前に前の試行の完了の記録を退避している（replace()）ので、ここにある
//   記録は引き受ける試行が自分で書いたものである。Orca はこのあとも start_unknown と言い続けうるが、待機はそれで止まらない
const adopt = (statusDir: string, role: Role, terminal: string): boolean => {
  const workersFile = join(statusDir, 'workers.json')
  const workers = asObject(readJson(workersFile))
  const roles = asObject(get(workers, 'roles'))
  const current = asObject(get(workers, 'roles', role.name))
  if (workers === null || roles === null || current === null || asString(current.dispatch) !== role.dispatch) {
    log(NAME, `${role.name}: its record changed while it was read; nothing was adopted`)
    return false
  }
  const worktreeId = asString(current.worktree_id) ?? ''
  const updated: JsonObject = {
    ...current,
    terminal,
    worktree_terminals: worktreeId === '' ? (current.worktree_terminals ?? null) : terminalHandles(worktreeId),
  }
  delete updated.start_incomplete
  if (!writeAtomic(workersFile, `${JSON.stringify({ ...workers, roles: { ...roles, [role.name]: updated } })}\n`)) {
    log(NAME, `${role.name}: could not record the adoption in ${workersFile}; nothing was adopted`)
    return false
  }
  log(
    NAME,
    `${role.name}: adopted dispatch ${role.dispatch} with terminal ${terminal}; its start is no longer marked incomplete`,
  )
  return true
}

// ★ **--restart: 画面を見たユーザーが「動いていない」と判断した起動を、止めてから置き換える。fence が先**である —
//   start_unknown は生死のどちらの証拠でもないので、止めずに置き換えると、生きていた場合に 2 つの capability が 1 つの
//   lifecycle を進める。worker-stop で dispatch を fence し（Orca は start_unknown の worker への worker-stop を
//   受け付ける。2026-09-24 に手で確認）、Orca が failed か stopped と言うのを確かめてから置き換えへ進む。まだ言わなければ
//   何も起こさない — 次の回復は、失敗が証明された起動としてふつうに置き換える
const stopForRestart = (role: Role): boolean => {
  const stopped = runOrca(['orchestration', 'worker-stop', '--dispatch', role.dispatch, '--json'])
  if (!receiptOk(stopped)) {
    log(
      NAME,
      `${role.name}: Orca did not stop dispatch ${role.dispatch} (${failureDetail(stopped)}); nothing was replaced`,
    )
    return false
  }
  const shown = runOrca(['orchestration', 'worker-show', '--dispatch', role.dispatch, '--json'])
  const state = asString(get(shown.json, 'result', 'worker', 'state')) ?? ''
  if (!receiptOk(shown) || (state !== 'failed' && state !== 'stopped')) {
    log(
      NAME,
      `${role.name}: Orca accepted the stop of dispatch ${role.dispatch} but reports it as '${state || 'unknown'}'; nothing was replaced. Run this again once Orca reports it stopped`,
    )
    return false
  }
  log(
    NAME,
    `${role.name}: Orca stopped dispatch ${role.dispatch}; a wait that was running may exit 4 on it, so start it again afterwards`,
  )
  return true
}

// ★ **失われたことが証明された役を、同じ Task へ置き換える。**`task-create` は走らせない — Task は既に在る。
//   generation を上げ（旧 generation の accepted は nonce 照合で落ちる）、置き換えた dispatch を `superseded`
//   に残す（Orca がそれを retained のまま持っていても、[C7] が「記録に無い保持」と数えないため）。
//   新しい agent 端末が同じ worktree に生まれるので、端末の inventory も取り直す（取り直さないと [C3] が
//   「記録に無い端末が居る」と読み、worktree の片付けを提示できない）
const replace = (statusDir: string, parent: string, role: Role): boolean => {
  const worktreeId = asString(role.record.worktree_id) ?? ''
  if (worktreeId === '') {
    log(NAME, `${role.name}: no worktree recorded; refusing to place a replacement`)
    return false
  }
  const agent = asString(role.record.agent) ?? 'claude'
  const model = asString(role.record.model) ?? ''
  const effort = asString(role.record.effort) ?? ''
  const args = ['--task', role.task, '--worktree', `id:${worktreeId}`, '--retry-of', role.dispatch]
  args.push('--agent', agent, '--from', parent)
  if (model !== '') {
    args.push('--model', model)
    if (effort !== '') args.push('--effort', effort)
  }
  // ★ **置き換える試行の完了の記録は、新しい worker を起こす前に退避する**（round 1・2 のレビュー F1）。新しい worker は
  //   ready を報告する前から動いていることがあり（Orca の start_unknown。2026-09-24）、worker-start が返る前に
  //   prepare / await を走らせうる。記録が残っていれば prepare（冪等）は前の試行の nonce を返し、前の試行が accepted /
  //   settled まで進んでいれば、await は親の検証を待たずに accepted を返す。起こしたあとで消すと、今度は新しい worker が
  //   自分で書いた記録を消しうる。だから境界は起こす前に置き、起こしたあとは completion.json に触らない。
  //   退避できなければ起こさない（fail closed）
  const completion = join(statusDir, 'roles', role.name, 'completion.json')
  const parked = join(statusDir, 'roles', role.name, `completion.superseded-${role.dispatch}.json`)
  let parking: 'parked' | 'none' = 'none'
  if (existsSync(completion)) {
    try {
      renameSync(completion, parked)
      parking = 'parked'
    } catch {
      log(
        NAME,
        `${role.name}: could not move the completion record of dispatch ${role.dispatch} aside; not starting a replacement that would read it`,
      )
      return false
    }
  }
  const started = runOrca(['orchestration', 'worker-start', ...args, '--json'])
  const next = asString(get(started.json, 'result', 'dispatchId')) ?? ''
  const state = asString(get(started.json, 'result', 'state')) ?? ''
  const ready = started.rc === 0 && state === 'ready' && next !== ''
  if (next === '') {
    // 応答に ID が無くても Orca は置き換えを起こしているかもしれない。旧 nonce は戻さない
    log(NAME, `${role.name}: could not start a replacement (rc=${started.rc}); the old resources are KEPT`)
    if (parking === 'parked') reportParked(statusDir, role, parked)
    return false
  }
  const shownResult = ready ? null : runOrca(['orchestration', 'worker-show', '--dispatch', next, '--json'])
  const shown = shownResult !== null && receiptOk(shownResult) ? shownResult.json : null
  const terminal =
    asString(
      get(
        (asArray(get(started.json, 'result', 'effects')) ?? []).find(
          (effect) => get(effect, 'kind') === 'terminal' && get(effect, 'role') === 'agent',
        ),
        'id',
      ),
    ) || workerTerminal(shown)
  const generation = (count(role.record.generation) ?? 1) + 1
  const superseded = (asArray(role.record.superseded) ?? []).filter((id) => typeof id === 'string')
  const workersFile = join(statusDir, 'workers.json')
  const workers = asObject(readJson(workersFile))
  const roles = asObject(get(workers, 'roles'))
  const current = asObject(get(workers, 'roles', role.name))
  // ★ **発行された dispatch は ready でなくても記録する**（orca-start の record_orphan_dispatch と同じ理由）。
  //   捨てると、次の回復は古い dispatch を --retry-of に渡し直し、新しい試行は誰にも追われないまま残る。
  //   ready でなくても Orca が端末を返せば記録する。起動未完了の印は別に残す
  const updated: JsonObject = {
    ...(current ?? {}),
    dispatch: next,
    terminal,
    generation,
    retained: false,
    superseded: [...superseded, role.dispatch],
    worktree_terminals: terminalHandles(worktreeId),
  }
  if (ready) delete updated.start_incomplete
  else updated.start_incomplete = true
  const inspect = `  ${orcaBin()} orchestration worker-show --dispatch ${next} --json`
  if (
    workers === null ||
    roles === null ||
    !writeAtomic(workersFile, `${JSON.stringify({ ...workers, roles: { ...roles, [role.name]: updated } })}\n`)
  ) {
    log(
      NAME,
      `${role.name}: dispatch ${next} was issued but could not be recorded in ${workersFile}; record it there as the ${role.name} dispatch before running this again. Inspect with:`,
    )
    log(NAME, inspect)
    if (parking === 'parked')
      log(NAME, `${role.name}: the completion record of dispatch ${role.dispatch} is kept at ${parked}`)
    return false
  }
  // 新しい dispatch が役の dispatch になった — ready でなくても。退避した前の試行の記録はもう要らない
  //   （起動が終わらなかったことは start_incomplete の印が追う）。新しい worker は新しい nonce で offer する
  if (parking === 'parked') rmSync(parked, { force: true })
  if (!ready) {
    log(
      NAME,
      `${role.name}: the replacement did not report ready (rc=${started.rc} state='${state || 'none'}'); dispatch ${next} is recorded in place of ${role.dispatch}. Run this again: it replaces that attempt once Orca reports it failed or stopped, and shows its screen when Orca reports it start_unknown. Inspect with:`,
    )
    log(NAME, inspect)
    sayTrust(statusDir, role, shown)
    return false
  }
  log(NAME, `${role.name}: replaced dispatch ${role.dispatch} with ${next} (generation ${generation})`)
  return true
}

// ★ **起動が終わらなかった試行の端末は、その dispatch が持ったまま `reclaimable` で残る**（Orca の
//   recovery-and-cleanup）。Orca の勧めどおり release で閉じる（出力は保存される）。手で閉じると
//   user_takeover として残る。**閉じられなくても置き換えは止めない** — その dispatch は superseded として
//   記録に残るので、[C7] は止まらない
const releaseFailedStart = (role: Role): void => {
  const released = runOrca(['orchestration', 'worker-release', '--dispatch', role.dispatch, '--json'])
  if (receiptOk(released)) {
    log(NAME, `${role.name}: asked Orca to release the terminal of the failed start (dispatch ${role.dispatch})`)
  } else {
    log(
      NAME,
      `${role.name}: could not release the terminal of the failed start (dispatch ${role.dispatch}, ${failureDetail(released)}); it stays recorded as superseded`,
    )
  }
}

const main = (argv: string[]): number => {
  let statusDir = ''
  let onlyRole = ''
  let dryRun = false
  let adoptFlag = false
  let restartFlag = false
  for (let index = 0; index < argv.length; ) {
    const flag = argv[index] ?? ''
    if (flag === '--dry-run' || flag === '--adopt' || flag === '--restart') {
      if (flag === '--dry-run') dryRun = true
      else if (flag === '--adopt') adoptFlag = true
      else restartFlag = true
      index += 1
      continue
    }
    const value = argv[index + 1]
    if (flag !== '--status-dir' && flag !== '--role') return die(NAME, `unknown option: ${flag}`)
    if (value === undefined) return die(NAME, `${flag} requires a value`)
    if (flag === '--status-dir') statusDir = value
    else onlyRole = value
    index += 2
  }
  if (statusDir === '') return die(NAME, '--status-dir is required')
  if (adoptFlag && restartFlag) return die(NAME, 'pass either --adopt or --restart, not both')
  const action = adoptFlag ? 'adopt' : restartFlag ? 'restart' : ''
  if (action !== '' && onlyRole === '') return die(NAME, `--${action} acts on one role; pass --role`)
  const workersFile = join(statusDir, 'workers.json')
  if (!readable(workersFile) || !readable(join(statusDir, 'run.json'))) {
    return die(NAME, `cannot read the dispatch state in ${statusDir}`)
  }
  const parent = asString(get(readJson(join(statusDir, 'run.json')), 'parent_handle')) ?? ''
  if (parent === '') return die(NAME, 'no parent handle recorded')
  reportWait(statusDir)

  const say = (line: string): void => {
    process.stdout.write(`${line}\n`)
  }
  const phaseOf = (roleDir: string): string => {
    const result = runNode(COMPLETION, ['--role-dir', roleDir, 'phase'])
    return result.rc === 0 ? result.stdout.replace(/\n+$/, '') : ''
  }

  let rc = 0
  const roles = asObject(get(readJson(workersFile), 'roles')) ?? {}
  // ★ 名指しした役が記録に無ければ、黙って 0 で終わらない（--adopt の打ち間違いを「引き受けた」と読ませない）
  if (action !== '' && asObject(roles[onlyRole]) === null) {
    log(NAME, `${onlyRole}: no such role is recorded in ${workersFile}; nothing was changed`)
    return 1
  }
  // jq の `.roles | keys[]` と同じく、役名の順に回す
  for (const name of Object.keys(roles).sort()) {
    if (onlyRole !== '' && onlyRole !== name) continue
    const record = asObject(roles[name]) ?? {}
    const role: Role = {
      name,
      dispatch: asString(record.dispatch) ?? '',
      task: asString(record.task) ?? '',
      record,
    }
    if (role.dispatch === '' || role.task === '') continue
    const roleDir = join(statusDir, 'roles', name)
    // ★ **ユーザーが止めた役には何もしない**（orca-stop.ts）。置き換えると、止めた役が別の端末で生き返る
    if (isFile(join(roleDir, 'stopped.json'))) {
      log(NAME, `${name}: stopped by the user; not recovering it`)
      continue
    }
    // worker-start 中の中断なら、置き換えを発行済みか分からない。旧 nonce を戻さず、確認を求める
    const parked = join(roleDir, `completion.superseded-${role.dispatch}.json`)
    if (existsSync(parked)) {
      reportParked(statusDir, role, parked)
      rc = 1
      continue
    }
    // ★ **起動が終わらなかった役は「起動」を負っている。**完了を負っているかの判定より先に見る
    const incomplete = startIncomplete(statusDir, name)
    // ★ --adopt / --restart は起動が終わらなかった役だけのもの。起動が終わった役に付けたら、何もせずに言う
    if (action !== '' && !incomplete) {
      log(NAME, `${name}: its start completed, so --${action} does not apply; nothing was changed`)
      rc = 1
      continue
    }
    const phase = incomplete ? '' : phaseOf(roleDir)
    if (!incomplete) {
      // ★ **その役に「まだ送るべきもの」があるか。**無いなら回復するものも無い。
      //   成功系は completion.json が settled でないこと、失敗系は status.json = error である
      const status = asString(get(readJson(join(roleDir, 'status.json')), 'status')) ?? ''
      if (phase === 'settled') {
        log(NAME, `${name}: already settled locally; nothing is owed`)
        continue
      }
      if (phase === '' && status !== 'error') {
        log(NAME, `${name}: nothing is owed yet (phase '${phase || 'none'}', status '${status || 'none'}')`)
        continue
      }
    }
    const shown = runOrca(['orchestration', 'worker-show', '--dispatch', role.dispatch, '--json'])
    if (!receiptOk(shown) || asObject(get(shown.json, 'result')) === null) {
      log(NAME, `${name}: cannot read the worker state for dispatch '${role.dispatch}'; not deciding anything`)
      rc = 1
      continue
    }
    const state = asString(get(shown.json, 'result', 'worker', 'state')) ?? ''
    const dispatchStatus = asString(get(shown.json, 'result', 'dispatch', 'status')) ?? ''
    const inspect = (): void => {
      log(NAME, `  ${orcaBin()} orchestration worker-show --dispatch ${role.dispatch} --json`)
    }

    if (incomplete) {
      const kind = workerStateClass(state)
      if (action === 'adopt') {
        // ★ 引き受けてよいのは、走っているか未確認の起動だけ。失敗・停止が証明された起動は置き換える
        const terminal = workerTerminal(shown.json)
        if ((kind !== 'live' && kind !== 'unconfirmed') || terminal === '') {
          log(
            NAME,
            `${name}: Orca reports the worker as '${state || 'unknown'}'${terminal === '' ? ' and names no terminal' : ''}; only a start that runs or is unconfirmed can be adopted. Nothing was changed`,
          )
          rc = 1
          continue
        }
        if (dryRun) {
          say(`${name}: adopt the start (terminal ${terminal})`)
          continue
        }
        if (!adopt(statusDir, role, terminal)) rc = 1
        continue
      }
      if (kind === 'unconfirmed') {
        if (action !== 'restart') {
          showUnconfirmed(statusDir, name, role.dispatch, shown.json)
          rc = 1
          continue
        }
        if (dryRun) {
          say(`${name}: stop the start, then replace it`)
          continue
        }
        if (!stopForRestart(role)) {
          rc = 1
          continue
        }
      } else if (state !== 'failed' && state !== 'stopped') {
        // ★ **置き換えてよいのは、失敗か停止が証明された試行だけ**（Orca の recovery-and-cleanup）。
        //   それ以外（まだ起動中・outcome_unknown など）は見るだけにする。--restart でも、走っている起動は止めない
        log(
          NAME,
          `${name}: its start did not complete and Orca reports the worker as '${state || 'unknown'}'; not replacing anything. Inspect with:`,
        )
        inspect()
        rc = 1
        continue
      } else if (dryRun) {
        // 信頼で止まった起動なら、本番の前に解き方を見せる（信頼しないまま置き換えると、同じ画面で止まる）
        sayTrust(statusDir, role, shown.json)
        say(`${name}: replace the failed start`)
        continue
      }
      releaseFailedStart(role)
      if (!replace(statusDir, parent, role)) rc = 1
      continue
    }

    if (dispatchSettled(dispatchStatus)) {
      // ★ **Orca 側が既に terminal。送らない。**ローカルを合わせて終わる
      if (dryRun) {
        say(`${name}: reconcile (orca is terminal)`)
        continue
      }
      if (phase !== '' && phase !== 'settled' && runNode(COMPLETION, ['--role-dir', roleDir, 'reconcile']).rc !== 0) {
        log(NAME, `${name}: could not reconcile the local record to settled`)
      }
      log(NAME, `${name}: Orca already settled this dispatch; reconciled locally`)
      continue
    }
    if (workerStateClass(state) === 'live') {
      // ★ **生きているなら nudge するだけ。**replacement を作ると、旧 capability と新 capability が
      //   同時に lifecycle を進めうる
      if (dryRun) {
        say(`${name}: nudge`)
        continue
      }
      const nudged = runOrca([
        'orchestration',
        'send',
        '--to',
        `dispatch:${role.dispatch}`,
        '--type',
        'status',
        '--subject',
        `completion-nudge: ${name}`,
        '--body',
        'your completion is still owed; continue from your completion record',
        '--from',
        parent,
        '--json',
      ])
      if (nudged.rc === 0) {
        log(NAME, `${name}: nudged the live worker`)
      } else {
        log(NAME, `${name}: could not nudge dispatch '${role.dispatch}'`)
        rc = 1
      }
      // ★ **nudge も届くだけでは起こせない。****ベストエフォート** — 起こせないことは「回復できなかった」
      //   ではないので rc を汚さない
      if (runNode(WAKE, ['--workers', workersFile, '--role', name]).rc !== 0) {
        log(NAME, `${name}: could not wake its terminal; the nudge may sit unread`)
      }
      continue
    }
    if (state === 'failed' || state === 'stopped') {
      // ★ **失われたことが証明された。**同じ Task へ replacement を作る
      if (dryRun) {
        say(`${name}: replace`)
        continue
      }
      if (!replace(statusDir, parent, role)) rc = 1
      continue
    }
    // ★ `outcome_unknown` を含め、**確認できないものでは replacement を作らない**（O19）
    log(NAME, `${name}: the worker state is '${state || 'unknown'}'; not replacing anything. Inspect with:`)
    inspect()
    rc = 1
  }
  return rc
}

process.exitCode = main(process.argv.slice(2))
