import { loadConfig } from '../lib/config.ts'
import { getMeta, openDb } from '../lib/db.ts'
import { homePaths } from '../lib/paths.ts'
import { fakeGh, runCliAsync, setupHome, startSlack, tempHome } from './helpers.ts'

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import type { SlackReply } from './helpers.ts'

test('RC1/RC2 report は名前・ID・default と source none を保存し、不正な指定では変更しない', async (t) => {
  const home = tempHome()
  const gh = fakeGh(tempHome())
  const source = join(home, 'report.json')
  writeFileSync(source, '{}')
  let historyError = false
  const slack = await startSlack((r): SlackReply => {
    if (r.method === 'conversations.list')
      return {
        json: {
          ok: true,
          channels: [{ id: 'C0REPORT01', name: 'issue-report', is_private: false, is_member: true }],
          response_metadata: { next_cursor: '' },
        },
      }
    if (r.method === 'conversations.info')
      return {
        json: { ok: true, channel: { id: r.params.channel ?? '', name: 'other', is_private: true, is_member: true } },
      }
    if (historyError) return { json: { ok: false, error: 'not_in_channel' } }
    return { json: { ok: true, messages: [] } }
  })
  t.after(() => slack.close())
  const env = { ...gh.env, ...(await setupHome(home, { apiBase: slack.url, ghPath: gh.ghPath, ghState: gh.state })) }
  const report = (args: string[]) => runCliAsync(['report', ...args], env)
  const first = await report(['--source', source, '--channel', 'default', '--daily-at', '08:30'])
  assert.equal(first.code, 0, first.stderr)
  assert.equal(first.stdout.trim(), `report=${source} channel=default daily_at=08:30`)
  assert.deepEqual(loadConfig(home)?.report, { channel: null, dailyAt: '08:30', source })
  const before = loadConfig(home)
  assert.equal((await report(['--source', source, '--daily-at', '25:00'])).code, 2)
  assert.deepEqual(loadConfig(home), before)
  const missing = await report(['--source', source, '--channel', 'missing'])
  assert.equal(missing.code, 1)
  assert.ok(missing.stderr.includes('チャンネルが見つかりません'))
  assert.deepEqual(loadConfig(home), before)
  assert.equal((await report(['--source', source, '--channel', 'issue-report'])).code, 0)
  assert.equal(loadConfig(home)?.report.channel, 'C0REPORT01')
  assert.equal((await report(['--source', source, '--channel', 'C0OTHER001'])).code, 0)
  assert.equal(loadConfig(home)?.report.channel, 'C0OTHER001')
  historyError = true
  const rejected = await report(['--source', source, '--channel', 'C0OTHER001'])
  assert.equal(rejected.code, 1)
  assert.ok(rejected.stderr.includes('/invite @Issue Intake'))
  const requestsBeforeDisable = slack.requests.length
  assert.equal((await report(['--source', 'none'])).code, 0)
  assert.equal(slack.requests.length, requestsBeforeDisable)
  historyError = false
  assert.equal(loadConfig(home)?.report.source, null)
  assert.equal((await report(['--source', join(home, 'missing')])).code, 1)
  const db = openDb(homePaths(home).db)
  assert.equal(getMeta(db, 'report_asked'), '1')
  db.close()
})

test('RC3 report の出力ではパス内のトークン形式の文字列を伏せる', async (t) => {
  const home = tempHome()
  const gh = fakeGh(tempHome())
  const source = join(home, 'xoxb-red-test-token.json')
  writeFileSync(source, '{}')
  const slack = await startSlack(() => ({ json: { ok: true, messages: [] } }))
  t.after(() => slack.close())
  const env = { ...gh.env, ...(await setupHome(home, { apiBase: slack.url, ghPath: gh.ghPath, ghState: gh.state })) }
  const r = await runCliAsync(['report', '--source', source], env)
  assert.equal(r.code, 0, r.stderr)
  assert.ok(!r.stdout.includes('xoxb-red-test-token'))
  assert.ok(r.stdout.includes('xoxb-***'))
  assert.equal(loadConfig(home)?.report.source, source)
})
