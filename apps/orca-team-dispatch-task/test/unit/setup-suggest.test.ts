import { suggestVerify, usesMise } from '../../lib/setup-suggest.ts'
import { readClaudeStubArgs, readClaudeStubPwd, writeClaudeStub } from '../lib/claude-stub.ts'

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
test('SG5 a mise repository is detected and the prompt asks for repository tasks run through mise', () => {
  const f = fixture()
  try {
    assert.equal(usesMise(f.dir), false)
    for (const file of ['mise.toml', '.mise.toml', '.tool-versions', 'mise/config.toml', '.config/mise.toml']) {
      const path = join(f.dir, file)
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, '')
      assert.equal(usesMise(f.dir), true, file)
      rmSync(path)
    }
    f.stub(JSON.stringify({ result: '{"commands":["mise run test"],"tools":["mise"]}' }))
    suggestVerify(f.dir, judge)
    const plain = readClaudeStubArgs(f.dir)[1] ?? ''
    assert.ok(plain.includes('do not invent checks CI does not run'), plain)
    assert.ok(plain.includes('mise run <task>'), plain)
    assert.ok(!plain.includes('This repository uses mise'), plain)
    suggestVerify(f.dir, judge, true)
    assert.ok(
      readClaudeStubArgs(f.dir)[1]?.endsWith(
        'This repository uses mise: run every command through mise run or mise exec --.',
      ),
    )
  } finally {
    f.cleanup()
  }
})
