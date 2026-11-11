import { createGh, createIssue, ensureLabels, findIssueByMarker, repoInfo, viewerLogin } from '../../lib/github.ts'
import { isAlive, selfIdentity } from '../../lib/process.ts'
import { fakeGh, ghCalls, seedIssues, startIdleProcess, tempHome } from '../helpers.ts'

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import type { ProcessIdentity } from '../../lib/types.ts'

const D = () => Date.now() + 10000
test('GH1 createIssue のargvとゲートの子の身元', async () => {
  const dir = tempHome()
  const fake = fakeGh(dir)
  Object.assign(process.env, fake.env)
  const file = join(dir, 'body')
  writeFileSync(file, '本文')
  const seen: ProcessIdentity[] = []
  const r = await createIssue(
    createGh(fake.ghPath),
    'acme/app',
    { title: 'T', bodyFile: file, labels: ['bug', 'priority: high', 'from-slack'] },
    D(),
    (c) => {
      seen.push(c)
      return true
    },
  )
  assert.deepEqual(r, { ok: true, url: 'https://github.com/acme/app/issues/42', number: 42 })
  const call = ghCalls(fake.log)[0]
  assert.deepEqual(call?.argv, [
    'issue',
    'create',
    '--repo',
    'acme/app',
    '--title',
    'T',
    '--body-file',
    file,
    '--label',
    'bug',
    '--label',
    'priority: high',
    '--label',
    'from-slack',
  ])
  assert.equal(call?.pid, seen[0]?.pid)
})
test('GH2/GH5 失敗は伏せ、リポジトリとアカウントを検証', async () => {
  const fake = fakeGh(tempHome())
  Object.assign(process.env, fake.env)
  const gh = createGh(fake.ghPath)
  assert.equal(await viewerLogin(gh, D()), 'intake-bot')
  assert.deepEqual(await repoInfo(gh, 'acme/app', D()), {
    ok: true,
    info: { visibility: 'PRIVATE', viewerPermission: 'WRITE', hasIssuesEnabled: true },
  })
  process.env.FAKE_GH_REPO = 'missing'
  const r = await repoInfo(gh, 'acme/app', D())
  delete process.env.FAKE_GH_REPO
  assert.ok(!r.ok && !r.error.includes('secret'))
})
test('GH3 一覧の全ページで作者と最終行を照合、失敗を未発見にしない', async () => {
  const fake = fakeGh(tempHome())
  Object.assign(process.env, fake.env)
  const gh = createGh(fake.ghPath)
  const marker = '<!-- slack-issue-intake:C1:1 -->'
  const issue = (n: number, body: string, login = 'intake-bot') => ({
    number: n,
    html_url: `https://github.com/acme/app/issues/${n}`,
    body,
    created_at: new Date(Date.now() - n * 1000).toISOString(),
    user: { login },
    labels: [{ name: 'from-slack' }],
  })
  seedIssues(fake.state, [...Array.from({ length: 100 }, (_, i) => issue(i + 1, 'other')), issue(101, `s\n${marker}`)])
  assert.deepEqual(await findIssueByMarker(gh, 'acme/app', marker, '2020-01-01T00:00:00.000Z', 'intake-bot', D()), {
    ok: true,
    issue: { url: 'https://github.com/acme/app/issues/101', number: 101 },
  })
  process.env.FAKE_GH_API_FAIL_PAGE = '2'
  const bad = await findIssueByMarker(gh, 'acme/app', marker, '2020-01-01T00:00:00.000Z', 'intake-bot', D())
  delete process.env.FAKE_GH_API_FAIL_PAGE
  assert.ok(!bad.ok)
  seedIssues(fake.state, [
    issue(1, marker, 'other'),
    issue(2, `${marker}\nother`),
    { ...issue(3, marker), pull_request: { url: 'x' } },
  ])
  assert.deepEqual(await findIssueByMarker(gh, 'acme/app', marker, '2020-01-01T00:00:00.000Z', 'intake-bot', D()), {
    ok: true,
    issue: null,
  })
})
test('GH4 無いラベルだけ作り、権限が無ければ作らない', async () => {
  const fake = fakeGh(tempHome())
  Object.assign(process.env, fake.env)
  process.env.FAKE_GH_LABELS = 'bug'
  const gh = createGh(fake.ghPath)
  const a = await ensureLabels(gh, 'acme/app', false, D())
  assert.ok(!a.ok && a.missing.length === 7)
  assert.equal(ghCalls(fake.log).length, 1)
  const b = await ensureLabels(gh, 'acme/app', true, D())
  delete process.env.FAKE_GH_LABELS
  assert.ok(b.ok && b.created.length === 7)
})
test('GH6/GH7 期限切れと拒否ゲートは送信せず、遅い子は停止', async () => {
  const fake = fakeGh(tempHome())
  Object.assign(process.env, fake.env)
  const gh = createGh(fake.ghPath)
  assert.equal((await gh(['api', 'user'], Date.now() - 1)).stderr, 'deadline')
  assert.equal(ghCalls(fake.log).length, 0)
  const seen: ProcessIdentity[] = []
  const reject = await gh(['api', 'user'], D(), (c) => {
    seen.push(c)
    return false
  })
  assert.equal(reject.stderr, 'gate refused')
  assert.equal(ghCalls(fake.log).length, 0)
  assert.ok(seen[0] && !isAlive(seen[0]))
  process.env.FAKE_GH_SLEEP_MS = '5000'
  const start = Date.now()
  const slow = await gh(['api', 'user'], Date.now() + 100, (c) => {
    seen.push(c)
    return true
  })
  delete process.env.FAKE_GH_SLEEP_MS
  assert.equal(slow.stderr, 'timeout')
  assert.ok(Date.now() - start < 1500)
  assert.ok(seen[1] && !isAlive(seen[1]))
})
test('PR1 生死とpid再利用を起動時刻で区別', async () => {
  assert.ok(isAlive(selfIdentity()))
  const p = await startIdleProcess()
  assert.ok(isAlive(p.identity))
  assert.ok(!isAlive({ pid: p.pid, start: 'other' }))
  await p.stop()
  assert.ok(!isAlive(p.identity))
})
test('GH8 goを送る前に親が終了すると、子はghを起動しない', async () => {
  const { spawn } = await import('node:child_process')
  const { readFileSync } = await import('node:fs')
  const fake = fakeGh(tempHome())
  const record = join(tempHome(), 'child.json')
  const p = spawn(process.execPath, [join(import.meta.dirname, '../fixtures/gh-gate-crash.ts'), fake.ghPath, record], {
    env: { ...process.env, ...fake.env },
    stdio: 'ignore',
  })
  await new Promise<void>((done) => p.once('close', () => done()))
  await new Promise((done) => setTimeout(done, 1000))
  assert.equal(ghCalls(fake.log).length, 0)
  const child = JSON.parse(readFileSync(record, 'utf8')) as ProcessIdentity
  assert.ok(!isAlive(child))
  assert.equal(readFileSync(fake.state, 'utf8'), '[]')
})
test('GH9 タイトルはシェル展開されず1つの引数になる', async () => {
  const { existsSync } = await import('node:fs')
  const dir = tempHome()
  const fake = fakeGh(dir)
  Object.assign(process.env, fake.env)
  const sentinel = join(dir, 'injected')
  const title = `T ' $(touch ${sentinel})`
  const body = join(dir, 'body.md')
  writeFileSync(body, '本文')
  const r = await createIssue(createGh(fake.ghPath), 'acme/app', { title, bodyFile: body, labels: [] }, D(), () => true)
  assert.ok(r.ok)
  assert.ok(!existsSync(sentinel))
  const argv = ghCalls(fake.log)[0]?.argv ?? []
  assert.equal(argv[argv.indexOf('--title') + 1], title)
})
test('PR2 起動時刻の照会が失敗しただけでは生きた送り手を死亡扱いにしない', () => {
  const identity = selfIdentity()
  const previous = process.env.PATH
  process.env.PATH = '/no-such-process-tools'
  try {
    assert.ok(isAlive(identity))
    assert.ok(isAlive(identity, '/no-such-process-tools/ps'))
  } finally {
    if (previous === undefined) delete process.env.PATH
    else process.env.PATH = previous
  }
})
test('GH10 正規URLとのリポジトリ表記の大小差を成功として扱う', async () => {
  const r = await createIssue(
    async () => ({ code: 0, stdout: 'https://github.com/acme/app/issues/42\n', stderr: '' }),
    'Acme/App',
    { title: 'T', bodyFile: '/unused', labels: [] },
    D(),
    () => true,
  )
  assert.deepEqual(r, { ok: true, url: 'https://github.com/acme/app/issues/42', number: 42 })
})
test('PR3 psがエラーを出してexit 1のときも死亡と断定しない', () => {
  const identity = selfIdentity()
  const file = join(tempHome(), 'ps')
  writeFileSync(file, '#!/bin/sh\necho inspection-failed >&2\nexit 1\n', { mode: 0o755 })
  assert.ok(isAlive(identity, file))
})
test('PR4 実行環境のタイムゾーンが変わっても同じPIDを生存と判定する', () => {
  const previous = process.env.TZ
  try {
    process.env.TZ = 'UTC'
    const identity = selfIdentity()
    process.env.TZ = 'Asia/Tokyo'
    assert.ok(isAlive(identity))
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
})
