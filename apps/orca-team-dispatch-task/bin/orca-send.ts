// ロール名を宛先にして worker 間メッセージを 1 通送る（旧版 orca-send の移植）。
//
// Usage: node orca-send.ts --workers <workers.json> --to <role> --subject <text> --body <text>
// Exit:  0 = 配送された / 1 = 配送されなかった / 2 = 使用法エラー
//
// ★ **配送されたかどうかだけを exit code にする。**呼び出し側は「送れなかったら書いたファイルを消す」
//   補償を行うので、ここが曖昧だと補償が壊れる。
//
// ★ spec 6-1 の addressbook.json は**作らない。**宛先は `workers.json` の `roles.<role>.dispatch` に在る。
import { die, log } from '../lib/cli.ts'
import { readJson, writeAtomic } from '../lib/fs.ts'
import { asArray, asString, get, type Json } from '../lib/json.ts'
import { receiptOk, runOrca } from '../lib/orca.ts'
import { nowSeconds, runNode } from '../lib/sys.ts'

import { accessSync, constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const NAME = 'orca-send'
const WAKE = join(dirname(fileURLToPath(import.meta.url)), 'orca-wake.ts')

const main = (argv: string[]): number => {
  const values: { [flag: string]: string } = {}
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index] ?? ''
    const value = argv[index + 1]
    if (!['--workers', '--to', '--subject', '--body'].includes(flag)) return die(NAME, `unknown option: ${flag}`)
    if (value === undefined) return die(NAME, `${flag} requires a value`)
    values[flag] = value
  }
  const workersFile = values['--workers'] ?? ''
  const role = values['--to'] ?? ''
  const subject = values['--subject'] ?? ''
  const body = values['--body'] ?? ''
  if (workersFile === '' || role === '' || subject === '') {
    return die(NAME, '--workers, --to and --subject are required')
  }
  try {
    accessSync(workersFile, constants.R_OK)
  } catch {
    log(NAME, `cannot read ${workersFile}`)
    return 1
  }
  // ★ **sender handle を自分で解決する。推測しない** (spec 6-2)。`--from` を省くと、候補が 1 つのとき
  //   Orca は暗黙に束縛する (O26)。誤った端末から送ったことにされるより、送れないほうがよい
  const from = process.env.ORCA_TERMINAL_HANDLE ?? ''
  if (from === '') {
    log(NAME, 'ORCA_TERMINAL_HANDLE is not set; refusing to let Orca guess the sender')
    return 1
  }
  const dispatch = asString(get(readJson(workersFile), 'roles', role, 'dispatch')) ?? ''
  // ★ **未登録の宛先は未配送として返す。**黙って捨てるより、送信側に見えるエラーにする
  if (dispatch === '') {
    log(NAME, `role '${role}' has no dispatch recorded in ${workersFile}; nothing was sent`)
    return 1
  }
  const sent = runOrca([
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
    from,
    '--json',
  ])
  // ★ rc だけでは足りない。**receipt の ok と message id を確かめる**（rc 0 かつ ok:false の応答形が在る）
  const messageId = asString(get(sent.json, 'result', 'message', 'id'))
  if (!receiptOk(sent) || messageId === null) {
    // ★ **なぜ届かなかったかまで言う。**rc だけでは「相手がもう終わっている」「端末を取り違えた」
    //   「Orca が落ちている」が同じ 1 行になる（実測 2026-09-12）
    const detail = [asString(get(sent.json, 'error', 'code')), asString(get(sent.json, 'error', 'message'))]
      .filter((part) => part !== null && part !== '')
      .join(': ')
    log(
      NAME,
      `send to role '${role}' (dispatch=${dispatch}) was not delivered (rc=${sent.rc})${detail ? `; ${detail}` : ''}`,
    )
    return 1
  }
  // ★ **配送された事実を残す。**後段の判定（review-state）はこの記録を読む。**ベストエフォート** —
  //   記録できなかったことで配送の成否を覆さない
  const record = join(resolve(dirname(workersFile)), 'sent.json')
  const previous: Json[] = asArray(readJson(record)) ?? []
  const entry = { to: role, subject, message_id: messageId, at: nowSeconds() }
  if (!writeAtomic(record, `${JSON.stringify([...previous, entry])}\n`)) {
    log(NAME, `delivered to role '${role}', but the delivery could not be recorded`)
  }
  // ★ **配送は起床ではない。**メールボックスに入れても、ターンを終えた相手は動かない（実測 2026-09-10）。
  //   **ベストエフォート。**起こせなかったことで配送の成否を変えてはならない
  if (runNode(WAKE, ['--workers', workersFile, '--role', role]).rc !== 0) {
    log(NAME, `delivered to role '${role}', but its terminal could not be woken; it may sit unread`)
  }
  process.stdout.write(`${messageId}\n`)
  return 0
}

process.exitCode = main(process.argv.slice(2))
