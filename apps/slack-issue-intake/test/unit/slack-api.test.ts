import {
  authTest,
  createSlackClient,
  fetchHistoryPage,
  fetchReplies,
  postThread,
  slackApiBase,
  tokenAllowedFor,
  userInfoName,
} from '../../lib/slack-api.ts'
import { historyHandler, startSlack } from '../helpers.ts'

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Json } from '../../lib/json.ts'

const D = () => Date.now() + 5000
test('SA1/SA7/SA9 POST form・認証・投稿・名前の優先順位', async (t) => {
  const server = await startSlack((r) => ({
    json: (r.method === 'auth.test'
      ? { ok: true, user_id: 'UBOT', bot_id: 'BBOT', team_id: 'T1', url: 'https://acme.slack.com/', team: 'acme' }
      : r.method === 'users.info'
        ? { ok: true, user: { name: 'fallback', profile: { display_name: '', real_name: '山田' } } }
        : { ok: true, ts: '2.0' }) as Json,
  }))
  t.after(() => server.close())
  process.env.SLACK_ISSUE_INTAKE_API_BASE = server.url
  const c = createSlackClient('xoxb-t')
  assert.deepEqual(await authTest(c, D()), {
    ok: true,
    info: { userId: 'UBOT', botId: 'BBOT', teamId: 'T1', teamUrl: 'https://acme.slack.com/', team: 'acme' },
  })
  assert.equal(server.requests[0]?.auth, 'Bearer xoxb-t')
  assert.deepEqual(await userInfoName(c, 'U1', D()), { ok: true, name: '山田' })
  assert.deepEqual(await postThread(c, 'C1', '1.0', '文', D()), { ok: true, ts: '2.0' })
  assert.deepEqual(server.requests.at(-1)?.params, {
    channel: 'C1',
    thread_ts: '1.0',
    text: '文',
    unfurl_links: 'false',
    unfurl_media: 'false',
  })
})
test('SA2 エラーと429を区別し、秘密を伏せる', async (t) => {
  const server = await startSlack((r) =>
    r.params.mode === 'rate'
      ? { status: 429, headers: { 'Retry-After': '30' } }
      : { json: { ok: false, error: 'bad xoxb-123-secret' } },
  )
  t.after(() => server.close())
  process.env.SLACK_ISSUE_INTAKE_API_BASE = server.url
  const c = createSlackClient('xoxb-t')
  assert.deepEqual(await c.call('x', { mode: 'bad' }, D()), {
    ok: false,
    error: 'bad xoxb-***',
    retryAfterSeconds: null,
  })
  assert.deepEqual(await c.call('x', { mode: 'rate' }, D()), { ok: false, error: 'ratelimited', retryAfterSeconds: 30 })
})
test('SA3/SA4 差し替え先とダウンロードの送信先を制限', () => {
  process.env.SLACK_ISSUE_INTAKE_API_BASE = 'https://evil.example'
  assert.equal(slackApiBase(), 'https://slack.com/api')
  assert.ok(tokenAllowedFor('https://files.slack.com/a'))
  assert.ok(!tokenAllowedFor('https://evil.example/a'))
  process.env.SLACK_ISSUE_INTAKE_API_BASE = 'http://127.0.0.1:9'
  assert.equal(slackApiBase(), 'http://127.0.0.1:9')
})
test('SA5 履歴は1ページずつ時刻境界を送る', async (t) => {
  const server = await startSlack(
    historyHandler(
      [1, 2, 3, 4, 5].map((n) => ({ ts: `${n}.000100`, text: 'x' })),
      2,
    ),
  )
  t.after(() => server.close())
  process.env.SLACK_ISSUE_INTAKE_API_BASE = server.url
  const c = createSlackClient('xoxb-t')
  const r = await fetchHistoryPage(c, 'C1', '1.000000', '5.000100', true, D())
  assert.ok(r.ok)
  assert.deepEqual(
    r.messages.map((m) => m.ts),
    ['5.000100', '4.000100'],
  )
  assert.ok(r.hasMore)
  assert.equal(server.requests.length, 1)
  assert.equal(server.requests[0]?.params.limit, '200')
  const next = await fetchHistoryPage(c, 'C1', '1.000000', '4.000100', false, D())
  assert.ok(next.ok)
  assert.deepEqual(
    next.messages.map((m) => m.ts),
    ['3.000100', '2.000100'],
  )
})
test('SA6 返信はcursorを辿り、親と古い返信を除く', async (t) => {
  const server = await startSlack((r) => ({
    json: r.params.cursor
      ? { ok: true, messages: [{ ts: '2.0', user: 'U1' }], response_metadata: { next_cursor: '' } }
      : {
          ok: true,
          messages: [
            { ts: '1.0', user: null },
            { ts: '1.5', user: 'U1' },
          ],
          response_metadata: { next_cursor: 'next' },
        },
  }))
  t.after(() => server.close())
  process.env.SLACK_ISSUE_INTAKE_API_BASE = server.url
  const r = await fetchReplies(createSlackClient('xoxb-t'), 'C1', '1.0', '1.5', D())
  assert.ok(r.ok)
  assert.deepEqual(
    r.messages.map((m) => m.ts),
    ['2.0'],
  )
  assert.equal(server.requests[1]?.params.cursor, 'next')
})
test('SA8 バイト数上限と外部hostへの認証送信を拒否', async (t) => {
  const server = await startSlack(() => ({ bytes: new Uint8Array([1, 2, 3]) }))
  t.after(() => server.close())
  process.env.SLACK_ISSUE_INTAKE_API_BASE = server.url
  const c = createSlackClient('xoxb-t')
  assert.deepEqual(await c.download('https://evil.example/x', 5, D()), { ok: false, error: 'host_not_allowed' })
  assert.equal(server.requests.length, 0)
  assert.deepEqual(await c.download(`${server.url}/f`, 2, D()), { ok: false, error: 'too_large' })
  const r = await c.download(`${server.url}/f`, 3, D())
  assert.ok(r.ok)
  assert.equal(r.bytes.length, 3)
})
test('SA10 締め切りを過ぎたら呼ばず、応答が遅ければ打ち切る', async (t) => {
  const server = await startSlack(() => ({ delayMs: 700, json: { ok: true } }))
  t.after(() => server.close())
  process.env.SLACK_ISSUE_INTAKE_API_BASE = server.url
  const c = createSlackClient('xoxb-t')
  assert.deepEqual(await c.call('x', {}, Date.now() - 1), { ok: false, error: 'deadline', retryAfterSeconds: null })
  assert.equal(server.requests.length, 0)
  const start = Date.now()
  const r = await createSlackClient('xoxb-t').call('x', {}, Date.now() + 100)
  assert.ok(!r.ok && r.error === 'deadline')
  assert.ok(Date.now() - start < 500)
})
test('SA2 接続失敗は投稿なしと区別する', async () => {
  const server = await startSlack(() => ({ json: { ok: true } }))
  const base = server.url
  await server.close()
  process.env.SLACK_ISSUE_INTAKE_API_BASE = base
  const r = await createSlackClient('xoxb-t').call('auth.test', {}, D())
  assert.ok(!r.ok && r.error.startsWith('network: '))
})
test('SA8 リダイレクト先へ通信と認証を転送しない', async (t) => {
  const target = await startSlack(() => ({ bytes: new Uint8Array([1]) }))
  t.after(() => target.close())
  const source = await startSlack(() => ({ status: 302, headers: { location: `${target.url}/file` } }))
  t.after(() => source.close())
  process.env.SLACK_ISSUE_INTAKE_API_BASE = source.url
  const r = await createSlackClient('xoxb-t').download(`${source.url}/file`, 10, D())
  assert.ok(!r.ok)
  assert.equal(target.requests.length, 0)
})
