import { buildSources, loadConfig, loadRepos, type RepoConfig, saveRepo } from '../lib/config.ts'
import { type Db, openDb, runFailures, undelivered } from '../lib/db.ts'
import { homePaths } from '../lib/paths.ts'
import { runCli, runCliAsync, startServer, type TestServer, tempHome, writeConfig } from './helpers.ts'

import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'

const FIXTURES = join(import.meta.dirname, 'fixtures')
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')
const homes: string[] = []
const servers: TestServer[] = []
after(async () => {
  for (const home of homes) rmSync(home, { recursive: true, force: true })
  for (const server of servers) await server.close()
})

// 取得先 path → fixture。全フィードに応答がある状態から、テストごとに差し替える
const feedRoutes = (
  overrides: Record<string, { status: number; body: string }> = {},
): Record<string, { status: number; body: string }> => ({
  '/about-aws/whats-new/recent/feed/': { status: 200, body: fixture('aws-whats-new.xml') },
  '/blogs/aws/feed/': { status: 200, body: fixture('aws-whats-new.xml') },
  '/feeds/gcp-release-notes.xml': { status: 200, body: fixture('gcp-release-notes.xml') },
  '/rss/': { status: 200, body: fixture('devto.xml') },
  '/feed': { status: 200, body: fixture('devto.xml') },
  '/ja/rss/jvndb_new.rdf': { status: 200, body: fixture('jvndb_new.rdf') },
  '/ja/rss/jvndb.rdf': { status: 200, body: fixture('jvndb_new.rdf') },
  ...overrides,
})

const setup = async (
  overrides: Record<string, { status: number; body: string }> = {},
): Promise<{ home: string; server: TestServer; env: Record<string, string>; db: () => Db }> => {
  const home = tempHome()
  homes.push(home)
  writeConfig(home)
  const server = await startServer(feedRoutes(overrides))
  servers.push(server)
  const env = { DEV_DIGEST_HOME: home, DEV_DIGEST_FEED_BASE: server.url }
  return { home, server, env, db: () => openDb(homePaths(home).db) }
}

const parseLines = (stdout: string): Record<string, string> =>
  Object.fromEntries(
    stdout
      .trim()
      .split('\n')
      .map((line) => {
        const index = line.indexOf('=')
        return [line.slice(0, index), line.slice(index + 1)]
      }),
  )

// フィクスチャで最も新しい項目（devto の 2026-11-09T11:44:18Z）
const NEWEST = '2026-11-09T11:44:18.000Z'
const HOUR_MS = 3_600_000
const plusHours = (iso: string, hours: number): string =>
  new Date(new Date(iso).getTime() + hours * HOUR_MS).toISOString()

const globalStoreIds = (home: string): string[] => {
  const config = loadConfig(home)
  assert.ok(config)
  return [
    ...new Set(
      buildSources(config, loadRepos(home))
        .filter((s) => s.scope === 'global')
        .map((s) => s.storeAs),
    ),
  ]
}

test('CO1 collect は全ソースを取り込み key=value を出す', async () => {
  const { env } = await setup()
  const result = await runCliAsync(['collect', '--now', plusHours(NEWEST, 1)], env)
  assert.equal(result.code, 0, result.stderr)
  const lines = parseLines(result.stdout)
  assert.equal(lines.run_id, '1')
  assert.equal(lines.previous_incomplete, 'none')
  assert.equal(lines.x_since, 'none')
  assert.ok(Number(lines.new) > 0)
  assert.equal(lines.updated, '0')
  assert.equal(lines.failed, 'none')
})

test('CO2 初めてのソースの 24 時間より古い項目は送らない', async () => {
  const { home, env, db } = await setup()
  const now = plusHours(NEWEST, 1)
  const result = await runCliAsync(['collect', '--now', now], env)
  assert.equal(result.code, 0, result.stderr)
  const handle = db()
  const items = undelivered(handle, 'global', globalStoreIds(home), null)
  const total = Number(handle.prepare('SELECT COUNT(*) AS n FROM items').get()?.n)
  handle.close()
  const cutoff = plusHours(now, -24)
  assert.ok(items.length > 0 && items.length < total, `${items.length} of ${total}`)
  for (const item of items) assert.ok(item.publishedAt !== null && item.publishedAt >= cutoff, item.title)
})

test('CO3 後から足したリポジトリの Releases も溢れない', async () => {
  const { home, env, db } = await setup({ '/o/r/releases.atom': { status: 200, body: fixture('releases.atom') } })
  // releases.atom の 3 件は 11/6 17:04Z・11/4・11/3。now の 24 時間以内は先頭の 1 件だけ
  const now = '2026-11-07T10:00:00.000Z'
  assert.equal((await runCliAsync(['collect', '--now', now], env)).code, 0)
  const repo: RepoConfig = {
    slug: 'o/r',
    displayName: 'o/r',
    path: '/tmp/o-r',
    addedAt: now,
    jvnMinSeverity: null,
    devtoTags: [],
    watch: {
      languages: [],
      packages: [{ name: 'r', ecosystem: 'npm', github: 'o/r' }],
      cloudServices: [],
      keywords: [],
    },
  }
  saveRepo(home, repo)
  const second = await runCliAsync(['collect', '--now', now], env)
  assert.equal(second.code, 0, second.stderr)
  const handle = db()
  const items = undelivered(handle, 'repo:o/r', ['releases:o/r'], null)
  handle.close()
  assert.equal(items.length, 1)
})

test('CO4 1 ソースの 500 は全体を止めない', async () => {
  const { env, db } = await setup({ '/about-aws/whats-new/recent/feed/': { status: 500, body: 'secret-body' } })
  const result = await runCliAsync(['collect', '--now', plusHours(NEWEST, 1)], env)
  assert.equal(result.code, 0, result.stderr)
  assert.equal(parseLines(result.stdout).failed, 'aws-whats-new')
  assert.ok(!result.stdout.includes('secret-body') && !result.stderr.includes('secret-body'))
  const handle = db()
  const sources = handle
    .prepare('SELECT DISTINCT source_id FROM items')
    .all()
    .map((row) => row.source_id)
  const failures = runFailures(handle, 1)
  handle.close()
  assert.ok(sources.includes('devto') && sources.includes('jvn'))
  assert.ok(!sources.includes('aws-whats-new'))
  assert.deepEqual(failures, [{ sourceId: 'aws-whats-new', reason: 'http 500' }])
})

test('CO4b 大きすぎる本文は失敗として記録する', async () => {
  const { env, db } = await setup({ '/rss/': { status: 200, body: 'x'.repeat(5_000_001) } })
  const result = await runCliAsync(['collect', '--now', plusHours(NEWEST, 1)], env)
  assert.equal(result.code, 0, result.stderr)
  assert.equal(parseLines(result.stdout).failed, 'gcp-blog')
  const handle = db()
  assert.deepEqual(runFailures(handle, 1), [{ sourceId: 'gcp-blog', reason: 'too large' }])
  handle.close()
})

test('CO5 2 回目の collect で同じ項目は new にならない', async () => {
  const { env } = await setup()
  const now = plusHours(NEWEST, 1)
  assert.equal((await runCliAsync(['collect', '--now', now], env)).code, 0)
  const second = parseLines((await runCliAsync(['collect', '--now', now], env)).stdout)
  assert.equal(second.new, '0')
  assert.equal(second.run_id, '2')
  assert.equal(second.previous_incomplete, now)
})

const xPost = (id: string, postedAt: string): { [key: string]: string } => ({
  id,
  url: `https://x.com/u/status/${id}`,
  author: 'u',
  text: `post ${id}`,
  postedAt,
  via: 'list',
})

test('CO6 ingest-x は同じ id を二重に入れない、--failed は失敗として残る', async () => {
  const { home, env, db } = await setup()
  const now = plusHours(NEWEST, 1)
  assert.equal((await runCliAsync(['collect', '--now', now], env)).code, 0)
  const file = join(home, 'x.json')
  writeFileSync(
    file,
    JSON.stringify({
      posts: [
        xPost('1', '2026-11-09T11:00:00Z'),
        xPost('2', '2026-11-09T11:30:00+09:00'),
        xPost('bad', 'not a date'),
        { id: '4', text: 'no url', postedAt: '2026-11-09T11:00:00Z' },
      ],
    }),
  )
  const first = runCli(['ingest-x', '--file', file, '--now', now], env)
  assert.equal(first.code, 0, first.stderr)
  assert.equal(first.stdout, 'new=2\n')
  assert.equal(runCli(['ingest-x', '--file', file, '--now', now], env).stdout, 'new=0\n')
  const failed = runCli(['ingest-x', '--failed', 'not logged in'], env)
  assert.equal(failed.code, 0, failed.stderr)
  const handle = db()
  const stored = handle
    .prepare("SELECT guid, published_at, baseline FROM items WHERE source_id = 'x' ORDER BY guid")
    .all()
  const failures = runFailures(handle, 1)
  handle.close()
  assert.deepEqual(
    stored.map((row) => [row.guid, row.published_at, row.baseline]),
    [
      ['1', '2026-11-09T11:00:00.000Z', 0],
      ['2', '2026-11-09T02:30:00.000Z', 0],
    ],
  )
  assert.deepEqual(failures, [{ sourceId: 'x', reason: 'not logged in' }])
  // 次の collect は x_since に取り込み時刻を出す
  const next = parseLines((await runCliAsync(['collect', '--now', plusHours(now, 1)], env)).stdout)
  assert.equal(next.x_since, now)
})

test('CO6b 実行記録がないときの ingest-x --failed は exit 2', () => {
  const home = tempHome()
  homes.push(home)
  const result = runCli(['ingest-x', '--failed', 'x'], { DEV_DIGEST_HOME: home })
  assert.equal(result.code, 2)
  assert.match(result.stderr, /collect/)
})

test('CO7 JVN の新着と更新の両方に載る脆弱性は 1 件として入る', async () => {
  const original = fixture('jvndb_new.rdf')
  assert.ok(original.includes('severity="Critical"'))
  // 新着側では深刻度が低く、更新側で critical に上がっている
  const lowered = original.replaceAll('severity="Critical"', 'severity="Low"')
  const { env, db } = await setup({
    '/ja/rss/jvndb_new.rdf': { status: 200, body: lowered },
    '/ja/rss/jvndb.rdf': { status: 200, body: original },
  })
  const result = await runCliAsync(['collect', '--now', plusHours(NEWEST, 1)], env)
  assert.equal(result.code, 0, result.stderr)
  const handle = db()
  const rows = handle
    .prepare("SELECT severity FROM items WHERE source_id = 'jvn' AND url LIKE '%JVNDB-2026-000163%'")
    .all()
  handle.close()
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.severity, 'critical')
})

test('CO8 未知のコマンドと config 無しは exit 2', () => {
  const home = tempHome()
  homes.push(home)
  assert.equal(runCli(['nope'], { DEV_DIGEST_HOME: home }).code, 2)
  const noConfig = runCli(['collect'], { DEV_DIGEST_HOME: home })
  assert.equal(noConfig.code, 2)
  assert.match(noConfig.stderr, /init/)
})

test('CO9 共有 storeAs の片方が初回に失敗しても、回復した初回の古い項目は送らない', async () => {
  const { env, db } = await setup({ '/ja/rss/jvndb_new.rdf': { status: 500, body: 'down' } })
  const now = plusHours(NEWEST, 1)
  const first = parseLines((await runCliAsync(['collect', '--now', now], env)).stdout)
  assert.equal(first.failed, 'jvn-new')
  const handle = db()
  const before = undelivered(handle, 'global', ['jvn'], null).map((item) => item.guid)
  handle.close()
  // jvn-new を回復させる（古い項目を載せた版）
  const older = fixture('jvndb_new.rdf')
    .replaceAll('JVNDB-2026-000163', 'JVNDB-2026-000001')
    .replaceAll('2026-11-09T14:24+09:00', '2026-10-01T00:00+09:00')
  const recovered = await startServer(feedRoutes({ '/ja/rss/jvndb_new.rdf': { status: 200, body: older } }))
  servers.push(recovered)
  const second = await runCliAsync(['collect', '--now', now], { ...env, DEV_DIGEST_FEED_BASE: recovered.url })
  assert.equal(second.code, 0, second.stderr)
  assert.equal(parseLines(second.stdout).failed, 'none')
  const after = db()
  const items = undelivered(after, 'global', ['jvn'], null)
  after.close()
  const cutoff = plusHours(now, -24)
  for (const item of items) {
    if (!before.includes(item.guid)) assert.ok(item.publishedAt !== null && item.publishedAt >= cutoff, item.guid)
  }
  for (const guid of before)
    assert.ok(
      items.some((item) => item.guid === guid),
      `${guid} stays undelivered`,
    )
  assert.ok(!items.some((item) => item.url.includes('JVNDB-2026-000001')))
})

test('CO10 X の初回に 24 時間より古い投稿があっても送らない', () => {
  const home = tempHome()
  homes.push(home)
  const now = '2026-11-09T12:00:00.000Z'
  const file = join(home, 'x.json')
  writeFileSync(
    file,
    JSON.stringify({ posts: [xPost('old', '2026-11-07T00:00:00Z'), xPost('fresh', '2026-11-09T11:00:00Z')] }),
  )
  const result = runCli(['ingest-x', '--file', file, '--now', now], { DEV_DIGEST_HOME: home })
  assert.equal(result.code, 0, result.stderr)
  const handle = openDb(homePaths(home).db)
  const items = undelivered(handle, 'global', ['x'], null)
  handle.close()
  assert.deepEqual(
    items.map((item) => item.guid),
    ['fresh'],
  )
})

test('CO11 ingest-x は postedAt が無いか読めない投稿の時刻を数字の id（Snowflake）から求める', () => {
  const home = tempHome()
  homes.push(home)
  const now = '2026-11-09T12:00:00.000Z'
  const file = join(home, 'x.json')
  // 同じ時刻の 2 件: postedAt が無いものと、postedAt が読めないもの（下位ビットだけ違う id）
  const missing = '2119757882736668924'
  const invalid = '2119757882736668925'
  writeFileSync(
    file,
    JSON.stringify({
      posts: [
        { id: missing, url: `https://x.com/u/status/${missing}`, author: 'u', text: 'hi' },
        xPost(invalid, 'not a date'),
      ],
    }),
  )
  const result = runCli(['ingest-x', '--file', file, '--now', now], { DEV_DIGEST_HOME: home })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stdout, 'new=2\n')
  const handle = openDb(homePaths(home).db)
  const stored = handle.prepare("SELECT guid, published_at FROM items WHERE source_id = 'x' ORDER BY guid").all()
  handle.close()
  assert.deepEqual(
    stored.map((row) => [row.guid, row.published_at]),
    [
      [missing, '2026-11-09T11:43:57.098Z'],
      [invalid, '2026-11-09T11:43:57.098Z'],
    ],
  )
})
