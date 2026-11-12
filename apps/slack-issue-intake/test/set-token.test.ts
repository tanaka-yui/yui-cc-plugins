import { loadToken } from '../lib/secrets.ts'
import { runCli, tempHome } from './helpers.ts'

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

test('ST-1 標準入力から保存し、値を出さない', () => {
  const home = tempHome()
  const r = runCli(['set-token', '--from-stdin'], { SLACK_ISSUE_INTAKE_HOME: home }, 'xoxb-111-secret\n')
  assert.equal(r.code, 0)
  assert.equal(r.stdout, 'saved token=xoxb-***\n')
  assert.ok(!(r.stdout + r.stderr).includes('secret'))
  assert.equal(loadToken(join(home, 'secrets.json')), 'xoxb-111-secret')
})
test('ST-2 形が違えば保存しない', () => {
  const home = tempHome()
  assert.equal(runCli(['set-token', '--from-stdin'], { SLACK_ISSUE_INTAKE_HOME: home }, 'xoxp-1').code, 1)
  assert.ok(!existsSync(join(home, 'secrets.json')))
})
test('ST-3 入力方式は排他的', () => {
  assert.equal(runCli(['set-token', '--from-stdin', '--from-clipboard'], {}).code, 2)
})
test('ST-4 未知のコマンドは使用法', () => {
  const r = runCli(['nope'], {})
  assert.equal(r.code, 2)
  assert.match(r.stderr, /set-token/)
})
