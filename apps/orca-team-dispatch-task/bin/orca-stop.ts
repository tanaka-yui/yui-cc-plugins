// ユーザーが止めると決めた役を止める / 停滞の判定を数え直す（旧版 orca-stop の移植）。
//
// Usage: node orca-stop.ts --status-dir <d> --role <role>
//        node orca-stop.ts --status-dir <d> --snooze
// Exit:  0 = 止めた（決着済み・止め済みで何もしなかった場合を含む）/ 1 = 止め切れなかった / 2 = 使用法エラー
//
// ★ **止めるかどうかを決めるのはユーザーである。**子は待機に期限を持たず、親（orca-wait.ts）は停滞を
//   見つけて exit 8 で知らせるだけで、自分では何も止めない。これはユーザーが選んだあとに親が呼ぶ口である。
//
// ★ **止まっている子が協力してくれる前提を置かない。**message で「終われ」と頼むのではなく、Orca に止めさせる。
//
// ★ **記録してから止める。**`stopped.json` の無いまま止めると、orca-wait.ts からは worker が消えたように
//   見え、exit 4 と orca-recover.ts の置き換えに回ってしまう。
import { die, log } from '../lib/cli.ts'
import { readJson, writeAtomic } from '../lib/fs.ts'
import { asArray, asObject, asString, get, type JsonObject } from '../lib/json.ts'
import {
  dispatchSettled,
  failureDetail,
  GONE_STATES,
  listWorkers,
  receiptOk,
  releaseState,
  runOrca,
  workerStateClass,
} from '../lib/orca.ts'
import { nowSeconds, runNode } from '../lib/sys.ts'

import { accessSync, constants, existsSync, mkdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const NAME = 'orca-stop'
const SEND = join(dirname(fileURLToPath(import.meta.url)), 'orca-send.ts')

// 相方への知らせ。reviewer を止めたら依頼側へ review-skipped、作る役を止めたら reviewer へ abort-reviewer
const PEERS: { [role: string]: { peer: string; subject: string; body: (role: string) => string } } = {
  design_review: {
    peer: 'design',
    subject: 'review-skipped: stopped by the user',
    body: (role) => `the ${role} reviewer was stopped by the user; continue without review`,
  },
  exec_review: {
    peer: 'exec',
    subject: 'review-skipped: stopped by the user',
    body: (role) => `the ${role} reviewer was stopped by the user; continue without review`,
  },
  design: {
    peer: 'design_review',
    subject: 'abort-reviewer: stopped by the user',
    body: (role) => `the ${role} worker was stopped by the user; there is nothing more to review`,
  },
  exec: {
    peer: 'exec_review',
    subject: 'abort-reviewer: stopped by the user',
    body: (role) => `the ${role} worker was stopped by the user; there is nothing more to review`,
  },
}

// ★ **停滞の時計を今から数え直す。**止めた直後もタスクの最終変化時刻はまだ古いので、数え直さないと
//   次の周回で同じタスクがすぐ停滞に戻る
const snooze = (statusDir: string): boolean => {
  const file = join(statusDir, 'stall.json')
  const current: JsonObject = { ...(asObject(readJson(file)) ?? {}), snoozed_at: nowSeconds() }
  Reflect.deleteProperty(current, 'detected_at')
  Reflect.deleteProperty(current, 'idle_min')
  return writeAtomic(file, `${JSON.stringify(current)}\n`)
}

// ★ Orca に worker を止めさせる。**端末を直接閉じない**（`terminal close` で閉じると、Orca はその worker を
//   retained / retainedReason: user_takeover として残し、worker-release でも解放できない。記録から外せば
//   [C7] が Run 全体の片付けを止める。2026-09-23 の P1 の dispatch で実測）。
//   Orca が決着済みと言う worker は worker-release（出力を保存してから閉じる）。決着していない worker には
//   release が効かない（Orca は active な端末を保持する）ので worker-stop（dispatch を fence して、その worker の
//   端末だけを閉じる）。**状態が読めなければどちらも打たない** — 生死の分からないものには触らない
const stopWorker = (run: string, dispatch: string, role: string): { ok: boolean; line: string } => {
  const kept = `${role} is recorded as stopped`
  const shown = runOrca(['orchestration', 'worker-show', '--dispatch', dispatch, '--json'])
  if (!receiptOk(shown) || asObject(get(shown.json, 'result')) === null) {
    return {
      ok: false,
      line: `cannot read the worker state for dispatch ${dispatch}; ${kept}, but nothing was stopped`,
    }
  }
  const status = asString(get(shown.json, 'result', 'dispatch', 'status')) ?? ''
  const state = asString(get(shown.json, 'result', 'worker', 'state')) ?? ''
  // ★ **どちらへ進めるかの証拠が揃ったときだけ打つ。**決着の証拠があれば release、走っている証拠があれば stop
  //   （分類は lib/orca.ts）。state / status が無い・知らない値（outcome_unknown など）は「読めない」と同じく、何も打たない
  //   ★ **未確認（start_unknown）には stop を打つ。**生死のどちらの証拠でもないが、worker-stop は dispatch を fence して
  //   その worker の端末だけを閉じるので、生きていても死んでいても「止める」として正しい。決着していれば dispatch の
  //   status が先に決着を言うので、出力を保存せずに閉じることもない。Orca は start_unknown の worker への worker-stop を
  //   受け付ける（2026-09-24 に手で確認）。以前はここで何も打たず、止めると決めた役が止まらなかった
  const kind = workerStateClass(state)
  const settled = dispatchSettled(status) || kind === 'settled'
  const running = !settled && (kind === 'live' || kind === 'unconfirmed')
  if (!settled && !running) {
    return {
      ok: false,
      line: `cannot tell whether the worker for dispatch ${dispatch} has settled (state '${state || 'none'}', status '${status || 'none'}'); ${kept}, but nothing was stopped`,
    }
  }
  const verb = settled ? 'worker-release' : 'worker-stop'
  const result = runOrca(['orchestration', verb, '--dispatch', dispatch, '--json'])
  if (!receiptOk(result)) {
    return { ok: false, line: `${verb} failed for ${role} (dispatch ${dispatch}, ${failureDetail(result)}); ${kept}` }
  }
  // ★ receipt の ok だけでは「閉じた」と言えない（実測 O43）。orca-cleanup.ts と同じ worker-list から読み直す
  const worker = (run === '' ? null : listWorkers(run))?.find((entry) => get(entry, 'dispatchId') === dispatch)
  if (worker === undefined) {
    return {
      ok: false,
      line: `${verb} was accepted for ${role} (dispatch ${dispatch}), but its state could not be read back; ${kept}`,
    }
  }
  const release = releaseState(worker)
  if (GONE_STATES.includes(release)) {
    return { ok: true, line: `stopped ${role} (dispatch ${dispatch}; ${verb} closed its terminal)` }
  }
  const reason = asString(get(worker, 'resource', 'retainedReason'))
  const why = `releaseState: ${release || 'unknown'}${reason === null ? '' : `, retainedReason: ${reason}`}`
  return {
    ok: false,
    line: `${verb} was accepted for ${role} (dispatch ${dispatch}), but Orca still holds its terminal (${why}); ${kept}, and Step 5 decides what happens to that terminal`,
  }
}

const main = (argv: string[]): number => {
  let statusDir = ''
  let role = ''
  let snoozing = false
  for (let index = 0; index < argv.length; ) {
    const flag = argv[index] ?? ''
    if (flag === '--snooze') {
      snoozing = true
      index += 1
      continue
    }
    const value = argv[index + 1]
    if (flag !== '--status-dir' && flag !== '--role') return die(NAME, `unknown option: ${flag}`)
    if (value === undefined) return die(NAME, `${flag} requires a value`)
    if (flag === '--status-dir') statusDir = value
    else role = value
    index += 2
  }
  if (statusDir === '') return die(NAME, '--status-dir is required')
  if (snoozing && role !== '') return die(NAME, 'pass either --role or --snooze, not both')
  if (!snoozing && role === '') return die(NAME, 'pass --role <role> or --snooze')
  const workersFile = join(statusDir, 'workers.json')
  try {
    accessSync(workersFile, constants.R_OK)
  } catch {
    return die(NAME, `cannot read the dispatch state in ${statusDir}`)
  }

  if (snoozing) {
    if (!snooze(statusDir)) {
      log(NAME, `could not record the snooze in ${statusDir}/stall.json`)
      return 1
    }
    log(NAME, `the stall clock for ${basename(statusDir)} restarts now`)
    return 0
  }

  const workers = readJson(workersFile)
  const field = (name: string, value: string): string => asString(get(workers, 'roles', name, value)) ?? ''
  const task = field(role, 'task')
  const dispatch = field(role, 'dispatch')
  if (task === '' || dispatch === '') {
    log(NAME, `role '${role}' has no dispatch recorded in ${statusDir}; nothing was stopped`)
    return 1
  }
  // ★ 役の receipt が在れば決着している（その役は worker_done を送った）
  const received = asArray(readJson(join(statusDir, 'received.json')))
  const settled = (name: string): boolean => {
    const prefix = `worker_done|${field(name, 'task')}|${field(name, 'dispatch')}|`
    return (
      field(name, 'task') !== '' &&
      field(name, 'dispatch') !== '' &&
      (received ?? []).some((item) => typeof item === 'string' && item.startsWith(prefix))
    )
  }
  const stoppedFile = (name: string): string => join(statusDir, 'roles', name, 'stopped.json')
  // ★ 知らせる相手は「dispatch が在り、決着しておらず、止められていない」役だけ
  const waiting = (name: string): boolean =>
    field(name, 'dispatch') !== '' && !settled(name) && !existsSync(stoppedFile(name))

  let rc = 0
  let acted = false
  if (settled(role)) {
    // 1. 決着済みなら記録も止めることもしない。止める対象がもう無い
    log(NAME, `${role} has already settled; nothing to stop`)
  } else if (existsSync(stoppedFile(role))) {
    // ★ **止め直しを失敗にしない。**記録を上書きせず、止めた worker を止め直さない
    log(NAME, `${role} was already stopped; nothing to stop`)
  } else {
    // 2. 記録する。**書けなければ止めない**
    let recorded = false
    try {
      mkdirSync(join(statusDir, 'roles', role), { recursive: true })
      recorded = writeAtomic(stoppedFile(role), `${JSON.stringify({ stopped_at: nowSeconds(), by: 'user' })}\n`)
    } catch {
      recorded = false
    }
    if (!recorded) {
      log(NAME, `could not record that ${role} was stopped; its worker was left running`)
      return 1
    }
    acted = true
    // 3. Orca に止めさせる。止め切れなくても 2 の記録は残す（待機は止めた役として扱える）
    const run = asString(get(readJson(join(statusDir, 'run.json')), 'run_id')) ?? ''
    const outcome = stopWorker(run, dispatch, role)
    log(NAME, outcome.line)
    if (!outcome.ok) rc = 1
  }

  // 4. 相方へ知らせる。**送れなくても 1〜3 は覆さない。**決着済み・止め済みでも送る —
  //   ★ **reviewer は verdict を届けられないまま決着しうる。**依頼側は `review-verdict:` か `review-skipped:`
  //   でしか待機を抜けないので、ここで送らないと永久に待つ。reviewer も依頼か `abort-reviewer:` でしか抜けない
  const peer = PEERS[role]
  if (peer !== undefined && waiting(peer.peer)) {
    const sent = runNode(SEND, [
      '--workers',
      workersFile,
      '--to',
      peer.peer,
      '--subject',
      peer.subject,
      '--body',
      peer.body(role),
    ])
    process.stderr.write(sent.stderr)
    if (sent.rc === 0) acted = true
    else log(NAME, `could not tell ${peer.peer} that ${role} was stopped; it may keep waiting`)
  }
  // 何かをしたときだけ停滞の時計を数え直す
  if (acted && !snooze(statusDir)) {
    log(NAME, `could not restart the stall clock for ${basename(statusDir)}; the next wait may report it again`)
  }
  return rc
}

process.exitCode = main(process.argv.slice(2))
