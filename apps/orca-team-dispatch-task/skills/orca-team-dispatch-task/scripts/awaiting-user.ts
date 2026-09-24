// 端末でユーザーに尋ね、ターンを終えて答えを待つ直前に worker が呼ぶ（ask_via=terminal の brainstorm）。
//
// Usage: node awaiting-user.ts --role-dir <dir>
// Exit: 0 = 書いた / 1 = 書けなかった / 2 = 使用法エラー
//
// ★ **Orca の agentWait はこの待ちを拾わない**（実測 2026-09-24、logi-app: 端末に質問を書いて `❯` で待つ
//   design の worker-show は state=ready・agentWait=null だった）。印が無いと、答えを待つ間も停滞の時計が
//   進み、120 分で exit 8 になる。orca-wait.ts は、この印がそのタスクで子が最後に書いたものである間、
//   人を待っているとみなす
// ★ status.json を流用しない。merge / pr / recover / Step 3.5 の起動判定が読んでおり、値を増やすと波及する
// ★ 消す手順は持たない。答えのあとの書き込み（spec / plan / commit / status など）で自然に古くなる
import { die, log } from '../../../lib/cli.ts'
import { writeAtomic } from '../../../lib/fs.ts'
import { nowSeconds } from '../../../lib/sys.ts'

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const NAME = 'awaiting-user'

const main = (argv: string[]): number => {
  const [flag = '', roleDir = '', ...rest] = argv
  if (flag !== '--role-dir' || roleDir === '' || rest.length > 0) return die(NAME, 'usage: --role-dir <dir>')
  try {
    mkdirSync(roleDir, { recursive: true })
  } catch {
    log(NAME, `cannot create the role directory: ${roleDir}`)
    return 1
  }
  const file = join(roleDir, 'awaiting-user.json')
  if (!writeAtomic(file, `${JSON.stringify({ asked_at: nowSeconds() })}\n`)) {
    log(NAME, `failed to write ${file}`)
    return 1
  }
  return 0
}

process.exitCode = main(process.argv.slice(2))
