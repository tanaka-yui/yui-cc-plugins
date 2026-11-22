// make setup（普段の設定）の入口。worker のモデル・既定・--auto の判定役のモデル・worktree を作る場所を対話で設定し直す。
// --auto の設定から automation の有効化までは make auto-setup（bin/orca-auto.ts setup）。
import { die } from '../lib/cli.ts'
import { runSettings } from '../lib/settings-setup.ts'
import { createPrompter } from '../lib/setup-prompt.ts'

import { writeSync } from 'node:fs'
import { isatty } from 'node:tty'

const NAME = 'orca-setup'
const main = (argv: string[]): number => {
  let name = 'main'
  for (let i = 0; i < argv.length; i += 2) {
    const value = argv[i + 1]
    if (argv[i] !== '--name' || value === undefined || value.startsWith('--'))
      return die(NAME, `invalid option: ${argv[i]}`)
    name = value
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) die(NAME, 'invalid name')
  // 標準入力が端末でなければ何も書かない（auto-setup と同じ。テストだけ ORCA_AUTO_TEST_STDIN で通す）
  if (!isatty(0) && process.env.ORCA_AUTO_TEST_STDIN !== '1') {
    console.error('ターミナルで make setup を実行してください')
    return 2
  }
  const out = (text: string): void => {
    writeSync(1, text)
  }
  return runSettings(name, createPrompter(0, out), out)
}
process.exitCode = main(process.argv.slice(2))
