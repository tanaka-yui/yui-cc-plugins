import { loadConfig, saveConfig } from '../lib/config.ts'
import { getMeta, openDb } from '../lib/db.ts'
import { homePaths } from '../lib/paths.ts'
import { fakeGh, runCliAsync, setupHome, startSlack, tempHome } from './helpers.ts'

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import type { JsonObject } from '../lib/json.ts'
import type { SlackReply } from './helpers.ts'

const fixture = async (t: { after: (fn: () => Promise<void>) => void }) => {
  const home = tempHome()
  const gh = fakeGh(tempHome())
  const source = join(home, 'report.json')
  let missing = false
  let count = 0
  const slack = await startSlack(
    (r): SlackReply =>
      r.method === 'chat.postMessage'
        ? { json: { ok: true, ts: `55.${++count}` } }
        : r.method === 'chat.update'
          ? { json: missing ? { ok: false, error: 'message_not_found' } : { ok: true } }
          : { json: { ok: true, messages: [] } },
  )
  t.after(() => slack.close())
  const env = {
    ...gh.env,
    TZ: 'UTC',
    ...(await setupHome(home, {
      apiBase: slack.url,
      ghPath: gh.ghPath,
      ghState: gh.state,
      cursor: String(Date.parse('2026-11-13T08:50:00Z') / 1000),
      report: { channel: null, dailyAt: '09:00', source },
    })),
  }
  const material = (at: string) => {
    const value = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/auto-report.json'), 'utf8')) as JsonObject
    writeFileSync(source, JSON.stringify({ ...value, updatedAt: `2026-11-13T${at}:00Z` }))
  }
  const meta = (key: string) => {
    const db = openDb(homePaths(home).db)
    const value = getMeta(db, key)
    db.close()
    return value
  }
  return {
    home,
    source,
    slack,
    material,
    meta,
    missing: () => {
      missing = true
    },
    poll: (at: string) => runCliAsync(['poll', '--now', `2026-11-13T${at}:00Z`], env),
    calls: () => slack.requests.filter((r) => ['chat.postMessage', 'chat.update'].includes(r.method)),
  }
}
test('RP2 最初と毎日の時刻に新規投稿し、変更時だけ書き換える', async (t) => {
  const f = await fixture(t)
  f.material('08:54')
  assert.match((await f.poll('08:55')).stdout, /report=new/)
  assert.match((await f.poll('09:05')).stdout, /report=new/)
  f.material('09:09')
  assert.match((await f.poll('09:10')).stdout, /report=updated/)
  assert.match((await f.poll('09:15')).stdout, /report=unchanged/)
  assert.deepEqual(
    f.calls().map((c) => c.method),
    ['chat.postMessage', 'chat.postMessage', 'chat.update'],
  )
  assert.equal(f.calls()[2]?.params.ts, '55.2')
  assert.equal(f.meta('report_day'), '2026-11-13')
})
test('RP4 削除された投稿は新しい投稿に置き換える', async (t) => {
  const f = await fixture(t)
  f.material('09:09')
  await f.poll('09:10')
  f.missing()
  f.material('09:12')
  assert.match((await f.poll('09:13')).stdout, /report=new/)
  assert.equal(f.meta('report_ts'), '55.2')
})
test('RP5 材料が無い・壊れている回は errors に加えて終了コードを変えない', async (t) => {
  const f = await fixture(t)
  for (const broken of [false, true]) {
    if (broken) writeFileSync(f.source, '{}')
    const r = await f.poll('09:10')
    assert.equal(r.code, 1)
    assert.match(r.stdout, /errors=1 .*report=failed/)
  }
  assert.equal(f.calls().length, 0)
})
test('RP6 古い投稿の meta が残っても新しいチャンネルに投稿する', async (t) => {
  const f = await fixture(t)
  f.material('09:09')
  await f.poll('09:10')
  const c = loadConfig(f.home)
  assert.ok(c)
  saveConfig(f.home, { ...c, report: { ...c.report, channel: 'C0OTHER001' } })
  assert.match((await f.poll('09:10')).stdout, /report=new/)
  assert.equal(f.calls().at(-1)?.params.channel, 'C0OTHER001')
  assert.equal(f.meta('report_channel'), 'C0OTHER001')
})
