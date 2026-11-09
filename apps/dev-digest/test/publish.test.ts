import { type Config, loadRepos, saveRepo } from '../lib/config.ts'
import { type Db, openDb, startRun, upsertItem } from '../lib/db.ts'
import { homePaths } from '../lib/paths.ts'
import { buildPending } from '../lib/pending.ts'
import { saveWebhook } from '../lib/secrets.ts'
import { runCliAsync, startServer, tempHome, writeConfig } from './helpers.ts'

import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'

import type { Route, TestServer } from './helpers.ts'

const homes: string[] = []
const servers: TestServer[] = []
after(async () => {
  for (const home of homes) rmSync(home, { recursive: true, force: true })
  for (const server of servers) await server.close()
})

const T0 = '2026-11-01T00:00:00.000Z'
const NOW = '2026-11-09T00:00:00.000Z'
const GLOBAL_PATH = '/services/T0/B0/xyz'
const REPO_PATH = '/services/T1/B1/repo'
const hookUrl = (path: string): string => `https://hooks.slack.com${path}`

type Setup = { home: string; server: TestServer; db: Db; ids: number[]; env: Record<string, string> }

const setup = async (routes: Record<string, Route>, withRepoHook = true): Promise<Setup> => {
  const home = tempHome()
  homes.push(home)
  const server = await startServer(routes)
  servers.push(server)
  const paths = homePaths(home)
  const config: Config = writeConfig(home)
  saveRepo(home, {
    slug: 'o/r',
    displayName: 'o/r',
    path: '/tmp/o-r',
    addedAt: T0,
    jvnMinSeverity: null,
    devtoTags: [],
    watch: { languages: [], packages: [], cloudServices: [], keywords: [] },
  })
  saveWebhook(paths.secrets, 'global', hookUrl(GLOBAL_PATH))
  if (withRepoHook) saveWebhook(paths.secrets, 'o/r', hookUrl(REPO_PATH))
  const db = openDb(paths.db)
  startRun(db, NOW)
  const ids: number[] = []
  for (const guid of ['a', 'b']) {
    upsertItem(
      db,
      'aws-whats-new',
      {
        guid,
        url: `https://example.com/${guid}`,
        title: `title-${guid}`,
        summary: guid,
        author: null,
        publishedAt: T0,
        updatedAt: null,
        severity: null,
        products: [],
      },
      false,
      NOW,
    )
    ids.push(Number(db.prepare('SELECT id FROM items WHERE guid = ?').get(guid)?.id))
  }
  const pending = buildPending(db, config, [], 1, NOW)
  // repo 付きの pending を作る（候補は a と b）
  pending.repos = [
    {
      slug: 'o/r',
      displayName: 'o/r',
      watch: { languages: [], packages: [], cloudServices: [], keywords: [] },
      candidateIds: ids,
      ownIds: [],
      filtered: [],
    },
  ]
  mkdirSync(paths.runDir, { recursive: true })
  writeFileSync(join(paths.runDir, 'pending.json'), JSON.stringify(pending))
  return {
    home,
    server,
    db,
    ids,
    env: { DEV_DIGEST_HOME: home, DEV_DIGEST_WEBHOOK_OVERRIDE: server.url },
  }
}

const writeDigest = (home: string, body: object): string => {
  const file = join(home, 'digest.json')
  writeFileSync(file, JSON.stringify(body))
  return file
}

const deliveryRows = (db: Db): string[] =>
  db
    .prepare('SELECT item_id, destination, status FROM deliveries ORDER BY item_id, destination')
    .all()
    .map((row) => `${row.item_id}:${row.destination}:${row.status}`)

const finished = (db: Db): boolean =>
  db.prepare('SELECT finished_at FROM runs WHERE id = 1').get()?.finished_at !== null

const OK: Route = { status: 200, body: 'ok', type: 'text/plain' }

test('PB1 publish は全体 1 通とリポジトリ 1 通を送り送信済みを記録する', async () => {
  const s = await setup({ [GLOBAL_PATH]: OK, [REPO_PATH]: OK })
  const [a, b] = s.ids
  const file = writeDigest(s.home, {
    runId: 1,
    notes: [{ id: a, summaryJa: '要約A', tags: ['aws'] }],
    groups: [],
    repos: [{ slug: 'o/r', itemIds: [b] }],
  })
  const result = await runCliAsync(['publish', '--file', file, '--now', NOW], s.env)
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(
    s.server.requests.map((r) => r.path),
    [GLOBAL_PATH, REPO_PATH],
  )
  assert.match(result.stdout, /sent global messages=1/)
  assert.match(result.stdout, /sent repo:o\/r messages=1/)
  assert.deepEqual(deliveryRows(s.db), [
    `${a}:global:sent`,
    `${a}:repo:o/r:irrelevant`,
    `${b}:global:sent`,
    `${b}:repo:o/r:sent`,
  ])
  assert.ok(finished(s.db))
})

test('PB2 digest.json に書かれなかった pending 項目も全体に載る', async () => {
  const s = await setup({ [GLOBAL_PATH]: OK, [REPO_PATH]: OK })
  const file = writeDigest(s.home, { runId: 1, notes: [], groups: [], repos: [] })
  const result = await runCliAsync(['publish', '--file', file, '--now', NOW], s.env)
  assert.equal(result.code, 0, result.stderr)
  const body = s.server.requests[0]?.body ?? ''
  assert.ok(body.includes('title-a') && body.includes('title-b') && body.includes('要約なし'))
  // 0 件の repo は送らず、候補を irrelevant にする
  assert.equal(s.server.requests.length, 1)
  assert.match(result.stdout, /skipped repo:o\/r/)
})

test('PB3 全体 200・repo 500 なら全体だけ送信済み', async () => {
  const s = await setup({ [GLOBAL_PATH]: OK, [REPO_PATH]: { status: 500, body: 'boom', type: 'text/plain' } })
  const [a, b] = s.ids
  const file = writeDigest(s.home, { runId: 1, notes: [], groups: [], repos: [{ slug: 'o/r', itemIds: [a, b] }] })
  const result = await runCliAsync(['publish', '--file', file, '--now', NOW], s.env)
  assert.equal(result.code, 1)
  assert.match(result.stdout, /failed repo:o\/r status=500/)
  assert.deepEqual(deliveryRows(s.db), [`${a}:global:sent`, `${b}:global:sent`])
  assert.ok(!finished(s.db))
  // 2 回目の pending では全体の項目が消え、repo の項目だけが残る
  const again = buildPending(s.db, writeConfig(s.home), loadRepos(s.home), 1, NOW)
  assert.deepEqual(again.globalIds, [])
  assert.deepEqual(again.repos[0]?.candidateIds, [a, b])
  assert.deepEqual(deliveryRows(s.db), [`${a}:global:sent`, `${b}:global:sent`])
})

test('PB4 検証に落ちた digest では何も送らない', async () => {
  const s = await setup({ [GLOBAL_PATH]: OK, [REPO_PATH]: OK })
  const file = writeDigest(s.home, { runId: 99, notes: [], groups: [], repos: [] })
  const result = await runCliAsync(['publish', '--file', file, '--now', NOW], s.env)
  assert.equal(result.code, 3)
  assert.equal(s.server.requests.length, 0)
  assert.deepEqual(deliveryRows(s.db), [])
})

test('PB5 Slack が URL を含む 400 を返しても平文が出ない', async () => {
  const s = await setup({
    [GLOBAL_PATH]: { status: 400, body: `invalid ${hookUrl(GLOBAL_PATH)} B0/xyz`, type: 'text/plain' },
  })
  const file = writeDigest(s.home, { runId: 1, notes: [], groups: [], repos: [] })
  const result = await runCliAsync(['publish', '--file', file, '--now', NOW], s.env)
  assert.equal(result.code, 1)
  for (const text of [result.stdout, result.stderr]) {
    assert.ok(!text.includes('xyz'))
    assert.ok(!text.includes('B0/xyz'))
  }
  assert.match(result.stdout, /failed global status=400/)
})

test('PB6 全体の Webhook が無ければ exit 2、pending.json が無くても exit 2', async () => {
  const s = await setup({ [GLOBAL_PATH]: OK })
  rmSync(homePaths(s.home).secrets)
  const file = writeDigest(s.home, { runId: 1, notes: [], groups: [], repos: [] })
  assert.equal((await runCliAsync(['publish', '--file', file], s.env)).code, 2)
  rmSync(join(homePaths(s.home).runDir, 'pending.json'))
  assert.equal((await runCliAsync(['publish', '--file', file], s.env)).code, 2)
  assert.equal(s.server.requests.length, 0)
})

test('PB7 repo の Webhook が無ければ全体の Webhook で送る', async () => {
  const s = await setup({ [GLOBAL_PATH]: OK }, false)
  const [a] = s.ids
  const file = writeDigest(s.home, { runId: 1, notes: [], groups: [], repos: [{ slug: 'o/r', itemIds: [a] }] })
  const result = await runCliAsync(['publish', '--file', file, '--now', NOW], s.env)
  assert.equal(result.code, 0, result.stderr)
  assert.equal(s.server.requests.length, 2)
  assert.ok(s.server.requests.every((r) => r.path === GLOBAL_PATH))
})

test('PB8 全体の Webhook が無くても要約は保存される（exit 2）', async () => {
  const s = await setup({ [GLOBAL_PATH]: OK })
  rmSync(homePaths(s.home).secrets)
  const a = s.ids[0] ?? -1
  const file = writeDigest(s.home, {
    runId: 1,
    notes: [{ id: a, summaryJa: '要約A', tags: [] }],
    groups: [],
    repos: [],
  })
  const result = await runCliAsync(['publish', '--file', file, '--now', NOW], s.env)
  assert.equal(result.code, 2)
  assert.equal(s.db.prepare('SELECT summary_ja FROM notes WHERE item_id = ?').get(a)?.summary_ja, '要約A')
})

test('PB9 JVN のしきい値で外した項目を送り先ごとに filtered として記録し、送らない', async () => {
  const s = await setup({ [GLOBAL_PATH]: OK, [REPO_PATH]: OK })
  const [a, b] = s.ids
  upsertItem(
    s.db,
    'jvn',
    {
      guid: 'j',
      url: 'https://example.com/j',
      title: 'title-j',
      summary: 'j',
      author: null,
      publishedAt: T0,
      updatedAt: null,
      severity: 'medium',
      products: [],
    },
    false,
    NOW,
  )
  const j = Number(s.db.prepare('SELECT id FROM items WHERE guid = ?').get('j')?.id)
  // 設定のしきい値は high。repo の候補も実際の設定から作る
  const pending = buildPending(s.db, writeConfig(s.home), loadRepos(s.home), 1, NOW)
  writeFileSync(join(homePaths(s.home).runDir, 'pending.json'), JSON.stringify(pending))
  const file = writeDigest(s.home, { runId: 1, notes: [], groups: [], repos: [] })
  const result = await runCliAsync(['publish', '--file', file, '--now', NOW], s.env)
  assert.equal(result.code, 0, result.stderr)
  assert.ok(!s.server.requests.some((r) => r.body.includes('title-j')))
  assert.deepEqual(deliveryRows(s.db), [
    `${a}:global:sent`,
    `${a}:repo:o/r:irrelevant`,
    `${b}:global:sent`,
    `${b}:repo:o/r:irrelevant`,
    `${j}:global:filtered`,
    `${j}:repo:o/r:filtered`,
  ])
})

test('PB10 送り直しは記録済みの送り先を飛ばし、未送信の送り先だけ送る。完了した実行には送らない', async () => {
  const routes: Record<string, Route> = {
    [GLOBAL_PATH]: OK,
    [REPO_PATH]: { status: 500, body: 'boom', type: 'text/plain' },
  }
  const s = await setup(routes)
  const [a, b] = s.ids
  const file = writeDigest(s.home, { runId: 1, notes: [], groups: [], repos: [{ slug: 'o/r', itemIds: [a] }] })
  assert.equal((await runCliAsync(['publish', '--file', file, '--now', NOW], s.env)).code, 1)
  routes[REPO_PATH] = OK
  const second = await runCliAsync(['publish', '--file', file, '--now', NOW], s.env)
  assert.equal(second.code, 0, second.stderr)
  assert.match(second.stdout, /skipped global/)
  assert.match(second.stdout, /sent repo:o\/r messages=1/)
  assert.deepEqual(
    s.server.requests.map((r) => r.path),
    [GLOBAL_PATH, REPO_PATH, REPO_PATH],
  )
  assert.deepEqual(deliveryRows(s.db), [
    `${a}:global:sent`,
    `${a}:repo:o/r:sent`,
    `${b}:global:sent`,
    `${b}:repo:o/r:irrelevant`,
  ])
  assert.ok(finished(s.db))
  // 完了した実行の pending.json では何も送らない
  const third = await runCliAsync(['publish', '--file', file, '--now', NOW], s.env)
  assert.equal(third.code, 2)
  assert.match(third.stderr, /collect/)
  assert.equal(s.server.requests.length, 3)
})

test('PB11 最新の実行のものでない pending.json では何も送らず exit 2', async () => {
  const s = await setup({ [GLOBAL_PATH]: OK, [REPO_PATH]: OK })
  startRun(s.db, NOW)
  const a = s.ids[0] ?? -1
  const file = writeDigest(s.home, {
    runId: 1,
    notes: [{ id: a, summaryJa: '要約A', tags: [] }],
    groups: [],
    repos: [],
  })
  const result = await runCliAsync(['publish', '--file', file, '--now', NOW], s.env)
  assert.equal(result.code, 2)
  assert.match(result.stderr, /collect/)
  assert.equal(s.server.requests.length, 0)
  assert.deepEqual(deliveryRows(s.db), [])
  assert.equal(s.db.prepare('SELECT summary_ja FROM notes WHERE item_id = ?').get(a), undefined)
})
