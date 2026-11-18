import { loadConfig, saveConfig } from '../lib/config.ts'
import { getMeta, openDb } from '../lib/db.ts'
import { asArray } from '../lib/json.ts'
import { homePaths } from '../lib/paths.ts'
import { fakeGh, runCliAsync, setupHome, startSlack, tempHome } from './helpers.ts'

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import type { JsonObject } from '../lib/json.ts'
import type { SlackReply } from './helpers.ts'

const fixture = async (t: { after: (fn: () => Promise<void>) => void }, repo = 'orgA/app') => {
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
      repos: [{ name: repo, form: true, existing: 'skip' }],
      defaultRepo: repo,
      cursor: String(Date.parse('2026-11-13T08:50:00Z') / 1000),
      report: { channel: null, dailyAt: '09:00', source },
    })),
  }
  const material = (
    at: string,
    extra: { running?: JsonObject[]; queue?: JsonObject[]; hosts?: JsonObject[] } = {},
  ) => {
    const value = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/auto-report.json'), 'utf8')) as JsonObject
    writeFileSync(
      source,
      JSON.stringify({
        ...value,
        updatedAt: `2026-11-13T${at}:00Z`,
        running: [...(asArray(value.running) ?? []), ...(extra.running ?? [])],
        queue: [...(asArray(value.queue) ?? []), ...(extra.queue ?? [])],
        hosts: extra.hosts ?? value.hosts,
      }),
    )
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
test('RP11 投稿にほかのリポジトリの Issue とマシンの数を出さず、それだけが変わった回は書き換えない', async (t) => {
  const f = await fixture(t, 'OrgA/App')
  f.material('09:09', {
    running: [
      { issue: 'orgB/web#7', title: '他社の障害', host: 'Mac M2max', startedAt: '2026-11-13T09:00:00Z', limitMinutes: 60 },
    ],
    queue: [{ issue: 'orgB/web#8', title: '他社の要望', priority: 'critical' }],
  })
  assert.match((await f.poll('09:10')).stdout, /report=new/)
  const text = f.calls()[0]?.params.text ?? ''
  for (const s of ['実行中 1件', 'orgA/app#42 ログインできない', 'キュー 1件', '1. [critical] orgA/app#51 決済が落ちる'])
    assert.ok(text.includes(s), s)
  assert.ok(text.endsWith('マシン: Mac M2max'))
  for (const s of ['orgB/web', '他社の障害', '他社の要望', '0/2']) assert.ok(!text.includes(s), s)
  // 同じ updatedAt で、ほかのリポジトリの行とマシンの使用数だけが変わった
  f.material('09:09', {
    queue: [{ issue: 'orgB/web#9', title: '他社の別件', priority: 'high' }],
    hosts: [{ name: 'Mac M2max', used: 1, max: 2, reachable: true }],
  })
  assert.match((await f.poll('09:11')).stdout, /report=unchanged/)
  // 対照: 自分のリポジトリの行が変われば書き換える
  f.material('09:09', { queue: [{ issue: 'orgA/app#52', title: '自社の別件', priority: 'high' }] })
  assert.match((await f.poll('09:12')).stdout, /report=updated/)
  assert.deepEqual(
    f.calls().map((c) => c.method),
    ['chat.postMessage', 'chat.update'],
  )
  assert.ok((f.calls()[1]?.params.text ?? '').includes('orgA/app#52 自社の別件'))
})
