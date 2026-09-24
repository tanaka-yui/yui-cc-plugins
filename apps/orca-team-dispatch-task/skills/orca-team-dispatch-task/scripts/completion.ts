// 完了の二相コミット（spec 10）の worker 側の口（旧版 completion の移植）。
//
// Usage: node completion.ts --role-dir <d> prepare            # 相 2 の前半: prepared を書き nonce を出す
//        node completion.ts --role-dir <d> sent               # 相 2 の後半: merge_ready_sent へ
//        node completion.ts --role-dir <d> await              # 相 4: 親の返事を 1 回分待つ
//        node completion.ts --role-dir <d> accept --nonce <n> # 相 5: nonce 一致なら accepted へ
//        node completion.ts --role-dir <d> settle             # 相 7: settled へ
//        node completion.ts --role-dir <d> reconcile          # 外部の証拠で settled へ（親専用）
//        node completion.ts --role-dir <d> phase              # 現在の phase を出す（無ければ空）
//        node completion.ts --role-dir <d> nonce              # 現在の nonce を出す
// Exit: 0 / 1 = 進められない（nonce 不一致・記録が読めない・transport 障害）/ 2 = 使用法エラー
//
// ★ **これは exactly-once の journal ではない**（spec 10-2 の裁定 1）。自分の disk ファイルの crash 回復の
//   ためだけに在る。相の遷移は前進のみで、後退させる口を持たない。
// ★ **nonce は「その完了の試行」を指す。**generation を上げた replacement は新しい nonce を持つので、
//   旧 generation の accepted は照合で落ちる。
import { die, log } from '../../../lib/cli.ts'
import { readJson, writeAtomic } from '../../../lib/fs.ts'
import { asArray, asObject, asString, get, type Json, type JsonObject, parseJson } from '../../../lib/json.ts'
import { runOrca } from '../../../lib/orca.ts'
import { envCount, sleepSeconds } from '../../../lib/sys.ts'

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

const NAME = 'completion'
const SUBCOMMANDS = ['prepare', 'sent', 'await', 'accept', 'settle', 'reconcile', 'phase', 'nonce']

const main = (argv: string[]): number => {
  let roleDir = ''
  let sub = ''
  let nonceIn = ''
  let generationIn = ''
  for (let index = 0; index < argv.length; ) {
    const argument = argv[index] ?? ''
    if (SUBCOMMANDS.includes(argument)) {
      if (sub !== '') return die(NAME, 'one subcommand only')
      sub = argument
      index += 1
      continue
    }
    const value = argv[index + 1]
    if (argument !== '--role-dir' && argument !== '--nonce' && argument !== '--generation') {
      return die(NAME, `unknown argument: ${argument}`)
    }
    if (value === undefined) return die(NAME, `${argument} requires a value`)
    if (argument === '--role-dir') roleDir = value
    else if (argument === '--nonce') nonceIn = value
    else generationIn = value
    index += 2
  }
  if (roleDir === '') return die(NAME, '--role-dir is required')
  if (sub === '') return die(NAME, 'a subcommand is required')
  const file = join(roleDir, 'completion.json')
  const record = (): JsonObject => asObject(readJson(file)) ?? {}
  const field = (name: string): string => asString(record()[name]) ?? ''
  // 相を 1 つ進める。ほかのフィールドは保つ（jq の `.phase = "..."` と同じ）
  const advance = (phase: string): boolean => writeAtomic(file, `${JSON.stringify({ ...record(), phase })}\n`)
  const cannotWrite = (): number => {
    log(NAME, `cannot write ${file}`)
    return 1
  }
  const print = (value: string): number => {
    if (value !== '') process.stdout.write(`${value}\n`)
    return 0
  }
  const current = field('phase')

  if (sub === 'phase') return print(current)
  if (sub === 'nonce') return print(field('nonce'))

  if (sub === 'prepare') {
    // ★ **冪等。**prepared 直後の crash から再入しても、同じ nonce を返す。新しい nonce を振ると、
    //   飛んでいる merge_ready の accepted が照合で落ちて永久に進めなくなる
    if (current !== '') {
      if (current !== 'prepared') log(NAME, `already at phase '${current}'; not going back to prepared`)
      return print(field('nonce'))
    }
    const generation: Json | null = parseJson(generationIn === '' ? '1' : generationIn)
    if (typeof generation !== 'number') return cannotWrite()
    const nonce = randomUUID()
    if (!writeAtomic(file, `${JSON.stringify({ phase: 'prepared', generation, nonce })}\n`)) return cannotWrite()
    return print(nonce)
  }

  if (sub === 'sent') {
    if (['merge_ready_sent', 'accepted', 'settled'].includes(current)) return 0 // 前進済み。戻さない
    if (current !== 'prepared') {
      log(NAME, `cannot move to merge_ready_sent from '${current || 'none'}'`)
      return 1
    }
    return advance('merge_ready_sent') ? 0 : cannotWrite()
  }

  if (sub === 'await') {
    // ★ **ここが「途中で止まる」の対策の本体である。**`orchestration send` はメールボックスに入れる
    //   だけでアイドルな worker を起こさない（実測 2026-09-10）。だから待つ側はターンを閉じず、この口を
    //   呼び直す。**nonce の照合を目視から外す。**出力は 1 行: accepted / remediation <本文> / waiting
    if (current === 'accepted' || current === 'settled') return print('accepted') // 受理済みの replay は no-op
    if (current !== 'merge_ready_sent') {
      log(NAME, `await is only for a completion that was offered; phase is '${current || 'none'}'`)
      return 1
    }
    const nonce = field('nonce')
    if (nonce === '') {
      log(NAME, 'no completion record; there is nothing to wait for')
      return 1
    }
    // ★ **selector を省いて Orca に推測させない。**別の端末のメールボックスを読むより、読めないほうがよい
    const terminal = process.env.ORCA_TERMINAL_HANDLE ?? ''
    if (terminal === '') {
      log(NAME, 'ORCA_TERMINAL_HANDLE is not set; refusing to guess whose mailbox to read')
      return 1
    }
    // ★ **待機に期限を置かない。**1 回のブロックは 10 分（agent の shell の上限）なので、呼び直しで続ける
    const windowMs = process.env.ORCA_AWAIT_WINDOW_MS || '600000'
    // ★ **--peek のみ。`--ack` を絶対に付けない** — cursor を進めるのは親である (O22/O23)
    const checked = runOrca([
      'orchestration',
      'check',
      '--terminal',
      terminal,
      '--peek',
      '--wait',
      '--timeout-ms',
      windowMs,
      '--json',
    ])
    if (checked.rc !== 0 || get(checked.json, 'ok') !== true) {
      // ★ **`waiter_exists` は「壊れた」ではなく「まだ空いていない」。**即座に戻すと spin になるので、
      //   少し置いてから呼び直させる。transport の障害を「返事が無い」と混ぜない
      if (asString(get(checked.json, 'error', 'code')) === 'waiter_exists') {
        sleepSeconds(envCount('ORCA_WAITER_RETRY_SECONDS', 20))
        return print('waiting')
      }
      log(NAME, `could not read the mailbox (rc=${checked.rc})`)
      return 1
    }
    // ★ 自分の nonce の返事だけを拾う。**他人の nonce は古い試行のものであり、無視する。**
    //   関係の無い型（heartbeat / review-verdict）も黙って読み飛ばす
    const accepted = `completion-accepted: ${nonce}`
    const remediation = `completion-remediation: ${nonce}`
    const reply = (asArray(get(checked.json, 'result', 'messages')) ?? []).find((message) => {
      const subject = asString(get(message, 'subject')) ?? ''
      return subject.startsWith(accepted) || subject.startsWith(remediation)
    })
    const subject = asString(get(reply, 'subject')) ?? ''
    if (subject.startsWith(accepted)) return advance('accepted') ? print('accepted') : cannotWrite()
    // ★ **差し戻しは相を進めない。**C からのやり直しであって、受理ではない
    if (subject.startsWith(remediation)) return print(`remediation ${asString(get(reply, 'body')) ?? ''}`)
    // ★ **空振りは「まだ来ていない」であって「来ない」ではない。**呼び直させる
    return print('waiting')
  }

  if (sub === 'accept') {
    if (nonceIn === '') return die(NAME, 'accept requires --nonce')
    const nonce = field('nonce')
    // ★ **nonce が一致しなければ受理しない。**古い試行や別 generation の accepted を今の受理にしない
    if (nonce === '') {
      log(NAME, 'no completion record; nothing to accept')
      return 1
    }
    if (nonce !== nonceIn) {
      log(NAME, 'nonce mismatch; this accepted is not for the current attempt')
      return 1
    }
    if (current === 'accepted' || current === 'settled') return 0 // replay は no-op
    if (current !== 'prepared' && current !== 'merge_ready_sent') {
      log(NAME, `cannot accept from '${current || 'none'}'`)
      return 1
    }
    return advance('accepted') ? 0 : cannotWrite()
  }

  if (sub === 'settle') {
    // ★ **worker の経路は accepted を経る。**受理されていない完了を「終わった」と記録すると、親は永久に待つ
    if (current === 'settled') return 0
    if (current !== 'accepted') {
      log(NAME, `cannot settle from '${current || 'none'}'`)
      return 1
    }
    return advance('settled') ? 0 : cannotWrite()
  }

  // reconcile: ★ **親専用の別経路。**「Orca 側が既に terminal」という外部の証拠を持つ者だけが使う
  if (current === 'settled') return 0
  if (current === '') {
    log(NAME, 'there is no completion record to reconcile')
    return 1
  }
  return advance('settled') ? 0 : cannotWrite()
}

process.exitCode = main(process.argv.slice(2))
