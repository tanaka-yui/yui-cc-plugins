import { MSG_NAME_ASK, MSG_NAME_RULE } from '../lib/defaults.ts'
import { runCli, tempHome } from './helpers.ts'

import assert from 'node:assert/strict'
import { mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

test('NR5 名前なしでは候補と名前付きコマンドを示し、使用法は先に検査する', () => {
  const user = tempHome()
  mkdirSync(join(user, '.slack-issue-intake-acme'))
  const env = { HOME: user, SLACK_ISSUE_INTAKE_HOME: '' }
  const r = runCli(['inspect', '--raw'], env)
  assert.equal(r.code, 2)
  assert.equal(r.stdout, '')
  assert.match(r.stderr, /^slack-issue-intake: ワークスペースの名前がありません/m)
  for (const text of ['今あるワークスペース: acme', '--name acme inspect --raw'])
    assert.ok(r.stderr.includes(text), text)
  assert.deepEqual(readdirSync(user), ['.slack-issue-intake-acme'])
  const legacy = tempHome()
  mkdirSync(join(legacy, '.slack-issue-intake'))
  const none = runCli(['status'], { ...env, HOME: legacy })
  assert.equal(none.code, 2)
  for (const text of [
    'make setup NAME=<名前> で作ってください',
    '名前なしのホーム（~/.slack-issue-intake）は使わなくなりました',
  ])
    assert.ok(none.stderr.includes(text), text)
  for (const args of [['nope'], []]) {
    const bad = runCli(args, env)
    assert.equal(bad.code, 2)
    assert.match(bad.stderr, /使用法/)
    assert.ok(!bad.stderr.includes('今あるワークスペース'))
  }
})
test('NR6 make の名前の質問は stderr に出し、stdout は manifest の JSON だけにする', () => {
  const user = tempHome()
  mkdirSync(join(user, '.slack-issue-intake-acme'))
  const env = { HOME: user, SLACK_ISSUE_INTAKE_HOME: '' }
  const r = runCli(['--ask-name=manifest', 'form', '--manifest'], env, 'BAD\nws2\n')
  assert.equal(r.code, 0, r.stderr)
  JSON.parse(r.stdout)
  for (const text of ['今あるワークスペース: acme', MSG_NAME_ASK, MSG_NAME_RULE])
    assert.ok(r.stderr.includes(text), text)
  const unread = runCli(['--ask-name=manifest', 'form', '--manifest'], env, '')
  assert.equal(unread.code, 2)
  assert.equal(unread.stdout, '')
  for (const text of [
    'make manifest NAME=<名前> のように NAME を付けて実行してください',
    '例: make manifest NAME=acme',
  ])
    assert.ok(unread.stderr.includes(text), text)
  const withEnv = runCli(
    ['--ask-name=manifest', 'form', '--manifest'],
    { HOME: user, SLACK_ISSUE_INTAKE_HOME: tempHome() },
    '',
  )
  assert.equal(withEnv.code, 0, withEnv.stderr)
  assert.ok(!withEnv.stderr.includes(MSG_NAME_ASK))
  assert.equal(runCli(['--ask-name=', 'setup'], env, '').code, 2)
})
