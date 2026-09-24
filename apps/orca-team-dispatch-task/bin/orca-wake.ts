// 役の端末へ 1 行入力して、アイドルな worker を起こす（旧版 orca-wake の移植）。
//
// ★ **なぜ在るのか。**`orchestration send` はメールボックスに入れるだけで、ターンを終えた worker を
//   起こさない（実測 2026-09-10: 1 Run の 4 worker 全員が `completion-accepted` と `review-verdict` を
//   未読のまま停止し、`terminal send` で直接入力して初めて動き出した）。
//
// ★ **配送と起床は別の事実である。**だから別の入口に分けてある。配送は送信側の exit code で確定して
//   おり、起こせなかったことでそれを覆してはならない — 呼び出し側はここの rc を握り潰してよい。
//
// ★ **「止まっている」と「止まっていて届かない」を別の結論にする。**端末が記録されていない役は 1 で
//   返し、何も打たない。
//
// Usage: node orca-wake.ts --workers <workers.json> --role <role> [--text <text>]
// Exit:  0 = 入力した / 1 = 起こせなかった / 2 = 使用法エラー
import { die, log } from '../lib/cli.ts'
import { readJson } from '../lib/fs.ts'
import { asObject, asString, get } from '../lib/json.ts'
import { dispatchSettled, receiptOk, runOrca, workerStateClass } from '../lib/orca.ts'

import { accessSync, constants } from 'node:fs'

const NAME = 'orca-wake'

// 既定の本文。**手順そのものを書かない** — worker は自分のタスク指示に完全な手順を持っている。
// ★ **1 行でなければならない。**`--enter` は末尾に Enter を足すだけなので、改行があるとそこで送信される
const DEFAULT_TEXT =
  'A message is waiting in your mailbox. Read it the way your task instructions say (--peek, never --ack) and continue from where you stopped.'

const readable = (file: string): boolean => {
  try {
    accessSync(file, constants.R_OK)
    return true
  } catch {
    return false
  }
}

const main = (argv: string[]): number => {
  let workersFile = ''
  let role = ''
  let text = DEFAULT_TEXT
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index] ?? ''
    const value = argv[index + 1]
    if (flag !== '--workers' && flag !== '--role' && flag !== '--text') return die(NAME, `unknown option: ${flag}`)
    if (value === undefined) return die(NAME, `${flag} requires a value`)
    if (flag === '--workers') workersFile = value
    else if (flag === '--role') role = value
    else text = value
  }
  if (workersFile === '' || role === '') return die(NAME, '--workers and --role are required')
  if (!readable(workersFile)) {
    log(NAME, `cannot read ${workersFile}; nothing was typed`)
    return 1
  }
  const workers = readJson(workersFile)
  const terminal = asString(get(workers, 'roles', role, 'terminal')) ?? ''
  if (terminal === '') {
    log(NAME, `role '${role}' has no terminal recorded; it cannot be woken`)
    return 1
  }
  // ★ **終端した dispatch を叩かない。**人がその端末を引き取っていれば、その人の入力欄に文字列を
  //   撃ち込むことになる。状態が読めないときも打たない — 生死の分からないものには触らない
  const dispatch = asString(get(workers, 'roles', role, 'dispatch')) ?? ''
  if (dispatch !== '') {
    const shown = runOrca(['orchestration', 'worker-show', '--dispatch', dispatch, '--json'])
    if (!receiptOk(shown) || asObject(get(shown.json, 'result')) === null) {
      log(NAME, `cannot read the worker state for dispatch '${dispatch}'; nothing was typed`)
      return 1
    }
    const status = asString(get(shown.json, 'result', 'dispatch', 'status')) ?? ''
    if (dispatchSettled(status)) {
      log(NAME, `dispatch '${dispatch}' is already terminal; nothing was typed`)
      return 1
    }
    // ★ **走っている worker にだけ打つ**（lib/orca.ts の live）。settle 済みの worker-show は 'succeeded' を返す。
    //   **start_unknown にも打たない** — 生死が分からず、死んでいれば端末はシェルに戻っていることがある（2026-09-24 の
    //   P2 の exec: codex が自動更新のあとシェルへ戻っていた）。そこへ打つと、この文章がコマンドとして実行される
    const state = asString(get(shown.json, 'result', 'worker', 'state')) ?? ''
    if (workerStateClass(state) !== 'live') {
      log(NAME, `the worker for dispatch '${dispatch}' is not running; nothing was typed`)
      return 1
    }
  }
  const typed = runOrca(['terminal', 'send', '--terminal', terminal, '--text', text, '--enter', '--json'])
  // ★ rc だけでは足りない。**receipt の ok を確かめる**（rc 0 かつ ok:false の応答形が在る）
  if (!receiptOk(typed)) {
    log(NAME, `could not type into the terminal of role '${role}' (rc=${typed.rc})`)
    return 1
  }
  log(NAME, `woke role '${role}' (terminal ${terminal})`)
  return 0
}

process.exitCode = main(process.argv.slice(2))
