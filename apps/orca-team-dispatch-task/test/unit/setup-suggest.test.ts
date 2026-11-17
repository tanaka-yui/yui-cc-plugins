import { suggestVerify } from '../../lib/setup-suggest.ts'
import { readClaudeStubArgs, readClaudeStubPwd, writeClaudeStub } from '../lib/claude-stub.ts'

import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const judge = { model: 'm1', effort: 'high' }
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'suggest-test-'))
  const stub = (stdout: string, options?: { rc?: number; sleepSeconds?: number }) => {
    process.env.ORCA_AUTO_CLAUDE_BIN = writeClaudeStub(dir, stdout, options)
  }
  const cleanup = () => {
    Reflect.deleteProperty(process.env, 'ORCA_AUTO_CLAUDE_BIN')
    Reflect.deleteProperty(process.env, 'ORCA_AUTO_SUGGEST_TIMEOUT_MS')
    rmSync(dir, { recursive: true, force: true })
  }
  return { dir, stub, cleanup }
}
test('SG1 suggestion is read from result text and claude is restricted to read-only tools', () => {
  const f = fixture()
  try {
    const value = { commands: ['npm test'], tools: ['node', 'npm'], notes: 'n' }
    f.stub(JSON.stringify({ type: 'result', result: `Here:\n${JSON.stringify(value)}` }))
    assert.deepEqual(suggestVerify(f.dir, judge), value)
    const args = readClaudeStubArgs(f.dir)
    assert.deepEqual(
      [args[0], ...args.slice(2)],
      [
        '-p',
        '--output-format',
        'json',
        '--model',
        'm1',
        '--effort',
        'high',
        '--tools',
        'Read,Glob,Grep',
        '--allowedTools',
        'Read,Glob,Grep',
        '--permission-mode',
        'dontAsk',
        '--strict-mcp-config',
      ],
    )
    assert.ok(args[1]?.includes('"commands"'))
    assert.equal(readClaudeStubPwd(f.dir), realpathSync(f.dir))
    f.stub(JSON.stringify({ result: '{"commands":[],"tools":[]}' }))
    assert.deepEqual(suggestVerify(f.dir, judge), { commands: [], tools: [], notes: '' })
  } finally {
    f.cleanup()
  }
})
test('SG2 broken or mis-shaped JSON is an error', () => {
  const f = fixture()
  try {
    for (const text of [
      'no json',
      '[]',
      '{"commands":"npm test"}',
      '{"commands":[],"tools":[""]}',
      '{"commands":[],"tools":[],"notes":3}',
    ]) {
      f.stub(JSON.stringify({ result: text }))
      assert.ok('error' in suggestVerify(f.dir, judge), text)
    }
    for (const stdout of [
      'bad',
      '[]',
      JSON.stringify({ type: 'result', is_error: true, result: '{"commands":[],"tools":[]}' }),
    ]) {
      f.stub(stdout)
      assert.deepEqual(suggestVerify(f.dir, judge), { error: 'AI の答えを読めません' })
    }
  } finally {
    f.cleanup()
  }
})
test('SG3 non-zero exit and missing binary are errors', () => {
  const f = fixture()
  try {
    f.stub('{}', { rc: 1 })
    assert.deepEqual(suggestVerify(f.dir, judge), { error: 'claude が失敗しました（終了コード 1）' })
    process.env.ORCA_AUTO_CLAUDE_BIN = join(f.dir, 'not-present')
    const r = suggestVerify(f.dir, judge)
    assert.ok('error' in r && r.error.startsWith('claude を起動できません:'))
  } finally {
    f.cleanup()
  }
})
test('SG4 timeout is an error', () => {
  const f = fixture()
  try {
    f.stub('{}', { sleepSeconds: 5 })
    process.env.ORCA_AUTO_SUGGEST_TIMEOUT_MS = '200'
    const start = Date.now()
    assert.deepEqual(suggestVerify(f.dir, judge), { error: '時間内に終わりませんでした' })
    assert.ok(Date.now() - start < 3000)
  } finally {
    f.cleanup()
  }
})
