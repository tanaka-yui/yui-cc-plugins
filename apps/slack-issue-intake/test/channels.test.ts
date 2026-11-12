import { findChannel, joinChannel, normalizeChannelName } from '../lib/channels.ts'

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { JsonObject } from '../lib/json.ts'
import type { SlackClient, SlackResult } from '../lib/slack-api.ts'

type Request = { method: string; params: Record<string, string> }
const DEADLINE = Date.now() + 60_000
const TARGET = { id: 'C0TARGET01', name: 'issue-intake', is_private: false, is_member: false }
const stub = (reply: (r: Request) => SlackResult): { client: SlackClient; requests: Request[] } => {
  const requests: Request[] = []
  return {
    requests,
    client: {
      call: async (method, params) => {
        const request = { method, params }
        requests.push(request)
        return reply(request)
      },
      download: async () => ({ ok: false, error: 'unused' }),
    },
  }
}
const ok = (body: JsonObject): SlackResult => ({ ok: true, body })

test('CH1 先頭の # や全角の ＃、大文字、前後の空白を除いて名前をそろえる', () => {
  assert.equal(normalizeChannelName(' #Issue-Intake '), 'issue-intake')
  assert.equal(normalizeChannelName('＃issue-intake'), 'issue-intake')
})
test('CH2 2ページ目のチャンネルも見つけ、アーカイブ済みを除くよう頼む', async () => {
  const s = stub((r) =>
    r.params.cursor === 'c2'
      ? ok({ channels: [TARGET], response_metadata: { next_cursor: '' } })
      : ok({
          channels: [{ id: 'C0OTHER001', name: 'general', is_private: false, is_member: true }],
          response_metadata: { next_cursor: 'c2' },
        }),
  )
  const found = await findChannel(s.client, '#Issue-Intake', DEADLINE)
  assert.deepEqual(found, {
    ok: true,
    channel: { id: 'C0TARGET01', name: 'issue-intake', isPrivate: false, isMember: false },
  })
  assert.equal(s.requests[0]?.method, 'conversations.list')
  assert.equal(s.requests[0]?.params.types, 'public_channel,private_channel')
  assert.equal(s.requests[0]?.params.exclude_archived, 'true')
  assert.equal(s.requests[0]?.params.limit, '200')
  assert.equal(s.requests[1]?.params.cursor, 'c2')
})
test('CH3 チャンネル ID を入れたら conversations.info で確かめる', async () => {
  const s = stub(() => ok({ channel: { ...TARGET, is_private: true, is_member: true } }))
  const found = await findChannel(s.client, 'c0target01', DEADLINE)
  assert.deepEqual(found, {
    ok: true,
    channel: { id: 'C0TARGET01', name: 'issue-intake', isPrivate: true, isMember: true },
  })
  assert.deepEqual(
    s.requests.map((r) => [r.method, r.params.channel]),
    [['conversations.info', 'C0TARGET01']],
  )
})
test('CH4 見つからなければ channel は null、Slack のエラーはそのまま返す', async () => {
  const none = stub(() => ok({ channels: [], response_metadata: { next_cursor: '' } }))
  assert.deepEqual(await findChannel(none.client, 'nothing', DEADLINE), { ok: true, channel: null })
  const failed: SlackResult = { ok: false, error: 'missing_scope', retryAfterSeconds: null }
  const bad = stub(() => failed)
  assert.deepEqual(await findChannel(bad.client, 'issue-intake', DEADLINE), failed)
  assert.deepEqual(await findChannel(bad.client, 'C0TARGET01', DEADLINE), failed)
})
test('CH5 joinChannel は conversations.join を呼ぶ', async () => {
  const s = stub(() => ok({}))
  assert.deepEqual(await joinChannel(s.client, 'C0TARGET01', DEADLINE), { ok: true })
  assert.deepEqual(s.requests, [{ method: 'conversations.join', params: { channel: 'C0TARGET01' } }])
  const failed: SlackResult = { ok: false, error: 'method_not_supported_for_channel_type', retryAfterSeconds: null }
  assert.deepEqual(await joinChannel(stub(() => failed).client, 'G0PRIVATE1', DEADLINE), failed)
})
