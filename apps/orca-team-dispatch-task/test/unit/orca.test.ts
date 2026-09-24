import {
  dispatchSettled,
  failureDetail,
  orcaBin,
  receiptArray,
  receiptObject,
  receiptOk,
  releaseState,
  runOrca,
  terminalHandles,
  workerStateClass,
  workerTerminal,
} from '../../lib/orca.ts'

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const ORCA_TS = new URL('../../lib/orca.ts', import.meta.url).href
// 標準入力を渡してしまう回帰では子が読み続けて止まるので、止まらずに落ちるよう上限を置く
const HANG_GUARD_MS = 10_000
const dir = mkdtempSync(join(tmpdir(), 'orca-unit-'))
after(() => rmSync(dir, { recursive: true, force: true }))

// Orca の代役。引数（STUB_READ_STDIN があれば標準入力も）を JSON で返し、stderr にも書き、STUB_RC で終わる
const STUB = join(dir, 'orca')
writeFileSync(
  STUB,
  [
    '#!/bin/sh',
    'input=""',
    '[ -n "$STUB_READ_STDIN" ] && input=$(cat)',
    'echo noise >&2',
    'printf \'{"ok":true,"result":{"args":"%s","input":"%s"}}\\n\' "$*" "$input"',
    '[ -n "$STUB_RC" ] || STUB_RC=0',
    'exit "$STUB_RC"',
    '',
  ].join('\n'),
)
chmodSync(STUB, 0o755)

const withEnv = (env: { [name: string]: string }, body: () => void): void => {
  const saved = Object.keys(env).map((name) => ({ name, value: process.env[name] }))
  Object.assign(process.env, env)
  try {
    body()
  } finally {
    for (const { name, value } of saved) {
      if (value === undefined) Reflect.deleteProperty(process.env, name)
      else process.env[name] = value
    }
  }
}

test('orcaBin は ORCA_BIN → ORCA_CLI_COMMAND → アプリ同梱の順で、空文字は未設定として扱う', () => {
  withEnv({ ORCA_BIN: '/x/orca', ORCA_CLI_COMMAND: 'orca-ide' }, () => assert.equal(orcaBin(), '/x/orca'))
  withEnv({ ORCA_BIN: '', ORCA_CLI_COMMAND: 'orca-ide' }, () => assert.equal(orcaBin(), 'orca-ide'))
  withEnv({ ORCA_BIN: '', ORCA_CLI_COMMAND: '' }, () =>
    assert.equal(orcaBin(), '/Applications/Orca.app/Contents/Resources/bin/orca'),
  )
})

test('runOrca は stdout を JSON として読み、stderr を捨て、終了コードを返す', () => {
  withEnv({ ORCA_BIN: STUB }, () => {
    const result = runOrca(['worker-list', '--json'])
    assert.equal(result.rc, 0)
    assert.equal(result.stdout.includes('noise'), false)
    assert.deepEqual(result.json, { ok: true, result: { args: 'worker-list --json', input: '' } })
  })
  withEnv({ ORCA_BIN: STUB, STUB_RC: '3' }, () => assert.equal(runOrca([]).rc, 3))
})

// ★ `bash <<EOF` で流したとき、途中の Orca CLI がスクリプトの残りを標準入力から読んで判定を
//   飛ばした（2026-09-23）。呼び出し元に標準入力があっても、CLI には渡さない
test('runOrca は呼び出し元の標準入力を CLI に渡さない', () => {
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { runOrca } from '${ORCA_TS}'; process.stdout.write(JSON.stringify(runOrca([]).json))`,
    ],
    {
      input: 'rest of the script\n',
      env: { ...process.env, ORCA_BIN: STUB, STUB_READ_STDIN: '1' },
      encoding: 'utf8',
      timeout: HANG_GUARD_MS,
    },
  )
  assert.equal(child.status, 0)
  assert.deepEqual(JSON.parse(child.stdout), { ok: true, result: { args: '', input: '' } })
})

test('receipt は exit 0 かつ ok: true で、result の形が合うときだけ数える', () => {
  const json = { ok: true, result: { workers: [], terminal: {} } }
  assert.equal(receiptOk({ rc: 0, json, stdout: '' }), true)
  assert.deepEqual(receiptArray({ rc: 0, json, stdout: '' }, 'workers'), [])
  assert.deepEqual(receiptObject({ rc: 0, json, stdout: '' }, 'terminal'), {})
  // 失敗 receipt に古い成功の形が残っていても数えない
  assert.equal(receiptArray({ rc: 7, json, stdout: '' }, 'workers'), null)
  assert.equal(receiptArray({ rc: 0, json: { ...json, ok: false }, stdout: '' }, 'workers'), null)
  assert.equal(receiptArray({ rc: 0, json, stdout: '' }, 'terminal'), null)
  assert.equal(receiptObject({ rc: 0, json, stdout: '' }, 'workers'), null)
  assert.equal(receiptOk({ rc: 0, json: null, stdout: '' }), false)
})

test('releaseState は resource.releaseState を先に、無ければ terminalState を読む', () => {
  assert.equal(releaseState({ resource: { releaseState: 'released' }, terminalState: 'retained' }), 'released')
  assert.equal(releaseState({ terminalState: 'retained' }), 'retained')
  assert.equal(releaseState(undefined), '')
})

test('failureDetail は rc と error.code / error.message を 1 行にする', () => {
  const json = { ok: false, error: { code: 'release_unknown', message: 'stub' } }
  assert.equal(failureDetail({ rc: 1, json, stdout: '' }), 'rc=1; release_unknown; stub')
  assert.equal(failureDetail({ rc: 0, json: { ok: false, error: 'gone' }, stdout: '' }), 'rc=0; gone')
  assert.equal(failureDetail({ rc: 7, json: null, stdout: '' }), 'rc=7')
})

test('terminalHandles は列挙できなければ null で、0 件とは区別する', () => {
  const list = join(dir, 'list-orca')
  writeFileSync(
    list,
    [
      '#!/bin/sh',
      '[ -n "$STUB_FAIL" ] && { echo \'{"ok":false}\'; exit 7; }',
      'echo \'{"ok":true,"result":{"terminals":[{"handle":"term_a"},{"handle":"term_b"}]}}\'',
      '',
    ].join('\n'),
  )
  chmodSync(list, 0o755)
  withEnv({ ORCA_BIN: list }, () => assert.deepEqual(terminalHandles('wt_1'), ['term_a', 'term_b']))
  withEnv({ ORCA_BIN: list, STUB_FAIL: '1' }, () => assert.equal(terminalHandles('wt_1'), null))
})

// ★ start_unknown はどの入口の「知っている状態」にも無く、待機・停止・回復の 3 つの行き止まりになった（2026-09-24）
test('workerStateClass は走っている・未確認・決着済みを分け、残りを other にする', () => {
  for (const state of ['active', 'ready', 'starting', 'idle']) assert.equal(workerStateClass(state), 'live')
  assert.equal(workerStateClass('start_unknown'), 'unconfirmed')
  for (const state of ['succeeded', 'failed']) assert.equal(workerStateClass(state), 'settled')
  // stopped / outcome_unknown は各入口が今までどおり扱う。stage の値や Object の既定の key を分類に化けさせない
  for (const state of ['stopped', 'outcome_unknown', '', 'turn_start_unobserved', 'constructor'])
    assert.equal(workerStateClass(state), 'other')
})

test('dispatchSettled は Orca 側で決着した dispatch の status だけを真にする', () => {
  for (const status of ['completed', 'failed', 'settled', 'terminated']) assert.equal(dispatchSettled(status), true)
  for (const status of ['dispatched', 'pending', '']) assert.equal(dispatchSettled(status), false)
})

test('workerTerminal は worker.agentTerminalHandle を読み、無ければ空文字', () => {
  assert.equal(workerTerminal({ ok: true, result: { worker: { agentTerminalHandle: 'term_u' } } }), 'term_u')
  assert.equal(workerTerminal({ ok: true, result: { terminal: { handle: 'term_u' } } }), '')
  assert.equal(workerTerminal(null), '')
})
