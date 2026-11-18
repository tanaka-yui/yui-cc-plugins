import { MSG_NAME_ASK, MSG_NAME_RULE } from '../lib/defaults.ts'
import { runCli, setupHome, tempHome } from './helpers.ts'

import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
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

test('GD2 不足した設定・トークン・automation はホームと実行するコマンドを示す', async () => {
  const user = tempHome(),
    home = join(user, '.slack-issue-intake-ws2')
  const env = { HOME: user, SLACK_ISSUE_INTAKE_HOME: '' }
  const want = `${home} に設定がありません。make setup NAME=ws2 を実行してください`
  for (const args of [
    ['inspect'],
    ['retry', '--id', '1'],
    ['enable'],
    ['collect'],
    ['mention', '--none'],
    ['report', '--source', 'none'],
    ['form'],
  ]) {
    const r = runCli(['--name', 'ws2', ...args], env)
    assert.equal(r.code, 2, args.join(' '))
    assert.ok(r.stderr.includes(want), args.join(' '))
  }
  const poll = runCli(['--name', 'ws2', 'poll'], env)
  assert.equal(poll.code, 2)
  assert.match(poll.stdout, /^result=unconfigured\b/m)
  assert.ok(poll.stderr.includes(want))
  assert.ok(readFileSync(join(home, 'poll-status.json'), 'utf8').includes('make setup NAME=ws2'))
  const init = runCli(['--name', 'ws2', 'init', '--channel', 'C0123456789', '--repo', 'acme/app'], env)
  assert.equal(init.code, 2)
  assert.ok(init.stderr.includes('node bin/slack-issue-intake.ts --name ws2 set-token'))
  await setupHome(home, { apiBase: 'http://127.0.0.1:1/api', ghPath: '/fake/gh', ghState: '/fake/state' })
  rmSync(join(home, 'secrets.json'))
  const inspect = runCli(['--name', 'ws2', 'inspect'], env)
  assert.equal(inspect.code, 2)
  assert.ok(inspect.stderr.includes(`${home} にトークンがありません`))
  const enable = runCli(['--name', 'ws2', 'enable'], env)
  assert.equal(enable.code, 2)
  assert.ok(enable.stderr.includes(`${home} の automation が登録されていません`))
})
test('GD4 guide は指定した名前と、名前を読めないホームでは placeholder を入れる', () => {
  const r = runCli(['--name', 'ws2', 'guide'], { HOME: tempHome(), SLACK_ISSUE_INTAKE_HOME: '' })
  for (const text of ['node bin/slack-issue-intake.ts --name ws2 set-token', '`make setup NAME=ws2`'])
    assert.ok(r.stdout.includes(text), text)
  assert.ok(runCli(['guide'], { SLACK_ISSUE_INTAKE_HOME: tempHome() }).stdout.includes('--name <名前> set-token'))
})
