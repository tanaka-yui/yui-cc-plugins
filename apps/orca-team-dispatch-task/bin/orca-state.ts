// SKILL.md の block が jq で読んでいた状態を 1 行（accounts は JSON 1 つ）で返す（設計 6 章の「小さな入口」）。
// **読むだけで何も書かない。**Orca へは読み取り（`orchestration check --peek` と `account list`）しか打たない。
//
// Usage: node orca-state.ts wait-stamp    --status-dir <d>   # Step 3: 待機の鼓動の年齢
//        node orca-state.ts design-status --status-dir <d>   # Step 3.5: design の status（止めた役は stopped）
//        node orca-state.ts integration   --status-dir <d>   # Step 4: 起動時に記録した取り込み方
//        node orca-state.ts mailbox       --status-dir <d>   # Step 3 の exit 1: 親端末の mailbox を覗く
//        node orca-state.ts accounts                         # S1: Orca が持つアカウント
// Exit: 0 = 答えた / 1 = 読めなかった・記録が壊れていた（理由は stderr）/ 2 = 使用法の誤り
//
// ★ block は呼び出し側のシェル（mac も WSL も zsh）で走る。判定を block に書かず、ここに置く
import { die, log, parseFlags } from '../lib/cli.ts'
import { validToggle } from '../lib/config.ts'
import { readJson } from '../lib/fs.ts'
import { asArray, asObject, asString, get, type JsonObject } from '../lib/json.ts'
import { failureDetail, receiptOk, runOrca } from '../lib/orca.ts'

import { existsSync } from 'node:fs'
import { join } from 'node:path'

const NAME = 'orca-state'
const USAGE =
  'usage: orca-state.ts <wait-stamp|design-status|integration|mailbox> --status-dir <dir> | orca-state.ts accounts'

const statusDirOf = (args: string[]): string => {
  const { values } = parseFlags(NAME, {
    args,
    options: { 'status-dir': { type: 'string' } },
    strict: true,
    allowPositionals: false,
  })
  const dir = values['status-dir'] ?? ''
  if (dir === '') return die(NAME, `--status-dir is required\n${USAGE}`)
  return dir
}

// Step 3 が `jq -r '"age=\(now - .beat | floor)s window=\(.window_ms / 1000)s"'` で出していた 1 行と同じ形。
// 読めない・数でない鼓動は、jq が失敗したときの echo と同じ文にする
const waitStamp = (statusDir: string): number => {
  const stamp = readJson(join(statusDir, 'wait.json'))
  const beat = get(stamp, 'beat')
  const windowMs = get(stamp, 'window_ms')
  if (typeof beat !== 'number' || typeof windowMs !== 'number') {
    process.stdout.write('no wait has ever stamped this task\n')
    return 0
  }
  process.stdout.write(`age=${Math.floor(Date.now() / 1000 - beat)}s window=${windowMs / 1000}s\n`)
  return 0
}

// ★ **`stopped.json` は status より強い。**ユーザーが止めた design は、status が done でも exec を起こさない
//   （orca-wait.ts が止めた役を決着させるのと同じ印を読む）。status が読めなければ missing（Step 3.5 は待つ）
const designStatus = (statusDir: string): number => {
  const roleDir = join(statusDir, 'roles', 'design')
  const status = existsSync(join(roleDir, 'stopped.json'))
    ? 'stopped'
    : asString(get(readJson(join(roleDir, 'status.json')), 'status')) || 'missing'
  process.stdout.write(`${status}\n`)
  return 0
}

// 起動時に記録した取り込み方（Step 1b の答え）。旧版の記録（キーが無い・null）だけが not recorded。
// ★ **読めない・object でない workers.json と、知らない値を「記録が無い」と取り違えない。**取り違えると Step 4 は
//   設定の値で取り込む。orca-merge.ts は pr を、orca-pr.ts は merge を拒むだけなので、知らない値はどちらにも通る。
//   `false` も未記録にしない — orca-start.ts は解決した文字列か null しか書かず、jq の `//` が false を未記録へ
//   落としていたのは偶然である
const integration = (statusDir: string): number => {
  const file = join(statusDir, 'workers.json')
  const workers = asObject(readJson(file))
  if (workers === null) {
    log(NAME, `cannot read ${file}`)
    return 1
  }
  const recorded = workers.integration
  if (recorded === undefined || recorded === null) {
    process.stdout.write('not recorded\n')
    return 0
  }
  if (typeof recorded !== 'string' || !validToggle('integration', recorded)) {
    log(NAME, `${file} records an integration this version does not know: ${JSON.stringify(recorded)}`)
    return 1
  }
  process.stdout.write(`${recorded}\n`)
  return 0
}

// ★ **覗くだけ。**`--peek` で読み、`--ack` は決して渡さない。扱えなかった batch を acknowledge すると、
//   処理していない message を処理したと宣言することになる（Step 3 の exit 1）
const mailbox = (statusDir: string): number => {
  const parent = asString(get(readJson(join(statusDir, 'run.json')), 'parent_handle')) ?? ''
  if (parent === '') {
    log(NAME, 'missing parent handle; do not acknowledge anything')
    return 1
  }
  const checked = runOrca(['orchestration', 'check', '--terminal', parent, '--peek', '--json'])
  process.stdout.write(checked.stdout)
  if (!receiptOk(checked)) {
    log(NAME, `orchestration check failed (${failureDetail(checked)})`)
    return 1
  }
  return 0
}

// S1 の jq と同じ射影。receipt には rate limit や既定アカウントの email も載るので、id とアクティブだけを出す
const accounts = (args: string[]): number => {
  parseFlags(NAME, { args, options: {}, strict: true, allowPositionals: false })
  const listed = runOrca(['account', 'list', '--json'])
  if (!receiptOk(listed)) {
    log(NAME, `cannot read the Orca accounts (${failureDetail(listed)})`)
    return 1
  }
  const runtime = (name: string): JsonObject => ({
    accounts: (asArray(get(listed.json, 'result', name, 'accounts')) ?? []).map((entry) => get(entry, 'id') ?? null),
    active: get(listed.json, 'result', name, 'activeAccountIdsByRuntime') ?? null,
  })
  process.stdout.write(`${JSON.stringify({ claude: runtime('claude'), codex: runtime('codex') }, null, 2)}\n`)
  return 0
}

const main = (argv: string[]): number => {
  const [command, ...rest] = argv
  if (command === 'wait-stamp') return waitStamp(statusDirOf(rest))
  if (command === 'design-status') return designStatus(statusDirOf(rest))
  if (command === 'integration') return integration(statusDirOf(rest))
  if (command === 'mailbox') return mailbox(statusDirOf(rest))
  if (command === 'accounts') return accounts(rest)
  return die(NAME, USAGE)
}

// ★ process.exit で終えない。パイプへの stdout 書き込みが途中で切れうる
process.exitCode = main(process.argv.slice(2))
