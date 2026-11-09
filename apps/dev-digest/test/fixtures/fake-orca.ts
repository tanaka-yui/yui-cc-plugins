// 偽の orca。argv を $FAKE_ORCA_LOG に 1 行 1 JSON で追記し、スパイク（spec §13）で記録した形の JSON を返す。
// テストは `#!/bin/sh` の小さな wrapper から `node <このファイル>` で呼ぶ（ORCA_BIN は 1 つの実行ファイルしか取らない）
//   FAKE_ORCA_REPO_ADD=exists  repo add を「登録済み」の失敗にする（repo list で引き直す経路のため）
//   FAKE_ORCA_REPO_PATH        repo list が返す登録済みの path
import { appendFileSync } from 'node:fs'

import type { Json } from '../../lib/json.ts'

const args = process.argv.slice(2)
const logFile = process.env.FAKE_ORCA_LOG
if (logFile) appendFileSync(logFile, `${JSON.stringify(args)}\n`)

const flag = (name: string): string | null => {
  const at = args.indexOf(name)
  return at < 0 ? null : (args[at + 1] ?? null)
}

const reply = (result: Json): void => {
  process.stdout.write(`${JSON.stringify({ id: 'fake-request', ok: true, result }, null, 2)}\n`)
}

const fail = (message: string): void => {
  process.stdout.write(`${JSON.stringify({ id: 'fake-request', ok: false, error: { message } })}\n`)
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
}

const command = `${args[0] ?? ''} ${args[1] ?? ''}`
if (command === 'repo add') {
  if (process.env.FAKE_ORCA_REPO_ADD === 'exists') fail('repo already added')
  else reply({ repo: { id: 'repo-1', path: flag('--path'), kind: 'folder' } })
} else if (command === 'repo list') {
  reply({ repos: [{ id: 'repo-1', path: process.env.FAKE_ORCA_REPO_PATH ?? '', kind: 'folder' }] })
} else if (command === 'automations create') {
  reply({ automation: { id: 'auto-1', name: flag('--name') } })
} else if (command === 'automations edit') {
  reply({ automation: { id: args[2] ?? '' } })
} else {
  fail(`fake orca: unknown command: ${args.join(' ')}`)
}
