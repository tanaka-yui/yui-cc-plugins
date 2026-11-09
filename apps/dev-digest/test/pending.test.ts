import { type Config, type RepoConfig, saveRepo } from '../lib/config.ts'
import { type Db, finishRun, openDb, recordDelivery, recordFailure, startRun, upsertItem } from '../lib/db.ts'
import { homePaths } from '../lib/paths.ts'
import { buildPending, sectionByStoreAs } from '../lib/pending.ts'
import { runCli, tempHome, writeConfig } from './helpers.ts'

import assert from 'node:assert/strict'
import { readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'

import type { FeedItem } from '../lib/feed.ts'
import type { Severity } from '../lib/severity.ts'

const homes: string[] = []
after(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true })
})

const T0 = '2026-11-01T00:00:00.000Z'
const NOW = '2026-11-09T00:00:00.000Z'
const config: Config = {
  version: 1,
  schedule: { trigger: 'daily', time: '08:00', timezone: 'Asia/Tokyo' },
  jvnMinSeverity: 'critical',
  devtoTags: [],
  x: { listUrl: null, hashtags: [] },
  orca: { workspaceSelector: null, automationId: null },
  pluginRoot: '/plugin',
}
const repo = (overrides: Partial<RepoConfig> = {}): RepoConfig => ({
  slug: 'o/r',
  displayName: 'o/r',
  path: '/tmp/o-r',
  addedAt: T0,
  jvnMinSeverity: null,
  devtoTags: [],
  watch: {
    languages: [],
    packages: [{ name: 'r', ecosystem: 'npm', github: 'o/r' }],
    cloudServices: [],
    keywords: [],
  },
  ...overrides,
})
const feedItem = (guid: string, severity: Severity | null = null): FeedItem => ({
  guid,
  url: `https://example.com/${guid}`,
  title: guid,
  summary: guid,
  author: null,
  publishedAt: T0,
  updatedAt: null,
  severity,
  products: [],
})
const add = (db: Db, sourceId: string, guid: string, severity: Severity | null = null, at = NOW): number => {
  upsertItem(db, sourceId, feedItem(guid, severity), false, at)
  const row = db.prepare('SELECT id FROM items WHERE source_id = ? AND guid = ?').get(sourceId, guid)
  return Number(row?.id)
}
const memDb = (): Db => {
  const db = openDb(':memory:')
  startRun(db, NOW)
  return db
}

test('PD1 JVN は全体のしきい値で globalIds を絞る', () => {
  const db = memDb()
  const critical = add(db, 'jvn', 'a', 'critical')
  const high = add(db, 'jvn', 'b', 'high')
  const pending = buildPending(db, config, [], 1, NOW)
  assert.deepEqual(pending.globalIds, [critical])
  assert.ok(!pending.globalIds.includes(high))
  assert.deepEqual(
    pending.items.map((i) => [i.id, i.section]),
    [[critical, 'jvn']],
  )
})

test('PD2 リポジトリのしきい値が全体を上書きする', () => {
  const db = memDb()
  const critical = add(db, 'jvn', 'a', 'critical')
  const high = add(db, 'jvn', 'b', 'high')
  const pending = buildPending(db, config, [repo({ jvnMinSeverity: 'high' })], 1, NOW)
  assert.deepEqual(pending.repos[0]?.candidateIds, [critical, high])
  assert.deepEqual(pending.globalIds, [critical])
  assert.equal(pending.items.length, 2)
})

test('PD3 repo.addedAt より前に見つかった項目は repo に出さない', () => {
  const db = memDb()
  const before = add(db, 'aws-whats-new', 'old', null, '2026-11-05T00:00:00.000Z')
  const after = add(db, 'aws-whats-new', 'new', null, '2026-11-08T00:00:00.000Z')
  const pending = buildPending(db, config, [repo({ addedAt: '2026-11-07T00:00:00.000Z' })], 1, NOW)
  assert.deepEqual(pending.repos[0]?.candidateIds, [after])
  assert.deepEqual(pending.globalIds, [before, after])
})

test('PD4 Releases は ownIds に入り globalIds に入らない', () => {
  const db = memDb()
  const release = add(db, 'releases:o/r', 'v1')
  const other = add(db, 'releases:x/y', 'v1')
  const bare = repo({ slug: 'p/q', watch: { ...repo().watch, packages: [] } })
  const pending = buildPending(db, config, [repo(), bare], 1, NOW)
  assert.deepEqual(pending.repos[0]?.ownIds, [release])
  assert.deepEqual(pending.repos[1]?.ownIds, [])
  assert.deepEqual(pending.globalIds, [])
  assert.ok(!pending.items.some((i) => i.id === other))
  assert.equal(pending.items[0]?.section, 'releases')
})

test('PD5 X の投稿は全体に入り、配信済みは除く', () => {
  const db = memDb()
  const x = add(db, 'x', 'p1')
  const sent = add(db, 'x', 'p2')
  recordDelivery(db, [{ itemId: sent, revision: 1, destination: 'global', status: 'sent', runId: 1 }], NOW)
  const pending = buildPending(db, config, [], 1, NOW)
  assert.deepEqual(pending.globalIds, [x])
  assert.equal(pending.items[0]?.section, 'x')
})

test('PD6 storeAs を共有する JVN の 2 フィードでも 1 度だけ数える', () => {
  const db = memDb()
  const id = add(db, 'jvn', 'a', 'critical')
  const pending = buildPending(db, config, [repo()], 1, NOW)
  assert.deepEqual(pending.globalIds, [id])
  assert.deepEqual(
    pending.items.map((i) => i.id),
    [id],
  )
})

test('PD7 failures と previousIncomplete を載せる', () => {
  const db = openDb(':memory:')
  startRun(db, '2026-11-07T00:00:00.000Z')
  startRun(db, '2026-11-08T00:00:00.000Z')
  finishRun(db, 2, '2026-11-08T00:10:00.000Z')
  const { runId } = startRun(db, NOW)
  recordFailure(db, runId, 'devto', 'timeout')
  const pending = buildPending(db, config, [], runId, NOW)
  assert.equal(pending.previousIncomplete, '2026-11-07T00:00:00.000Z')
  assert.deepEqual(pending.failures, [{ sourceId: 'devto', reason: 'timeout' }])
  assert.equal(buildPending(db, config, [], 1, NOW).previousIncomplete, null)
})

test('PD8 sectionByStoreAs は設定のソースと X を引く', () => {
  const sectionOf = sectionByStoreAs(config, [repo()])
  assert.equal(sectionOf('jvn'), 'jvn')
  assert.equal(sectionOf('x'), 'x')
  assert.equal(sectionOf('aws-news-blog'), 'aws')
  assert.equal(sectionOf('releases:o/r'), 'releases')
  assert.equal(sectionOf('releases:gone/repo'), 'releases')
})

test('PD9 pending コマンドは run/pending.json を書く', () => {
  const home = tempHome()
  homes.push(home)
  writeConfig(home)
  saveRepo(home, repo())
  const db = openDb(homePaths(home).db)
  const { runId } = startRun(db, NOW)
  add(db, 'x', 'p1')
  db.close()
  const result = runCli(['pending', '--now', NOW], { DEV_DIGEST_HOME: home })
  assert.equal(result.code, 0, result.stderr)
  const file = join(homePaths(home).runDir, 'pending.json')
  assert.equal(result.stdout, `file=${file}\nitems=1\nrepos=1\n`)
  const text = readFileSync(file, 'utf8')
  assert.ok(text.endsWith('}\n'))
  assert.equal(JSON.parse(text).runId, runId)
  assert.equal(statSync(homePaths(home).runDir).mode & 0o777, 0o700)
})

test('PD10 実行記録が無いと exit 2', () => {
  const home = tempHome()
  homes.push(home)
  writeConfig(home)
  const result = runCli(['pending'], { DEV_DIGEST_HOME: home })
  assert.equal(result.code, 2)
  assert.match(result.stderr, /collect/)
})
