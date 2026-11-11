import { type Config, type RepoConfig, saveRepo } from '../lib/config.ts'
import { type Db, finishRun, openDb, recordDelivery, recordFailure, startRun, upsertItem } from '../lib/db.ts'
import { homePaths } from '../lib/paths.ts'
import { buildPending, parsePending, sectionByStoreAs } from '../lib/pending.ts'
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
  jvnKeywords: [],
  devtoTags: [],
  x: { listUrl: null, hashtags: [] },
  orca: { workspaceSelector: null, automationId: null },
  pluginRoot: '/plugin',
  disabledSections: [],
  categories: [],
  excludeWords: [],
  categoryExclude: {},
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
const add = (
  db: Db,
  sourceId: string,
  guid: string,
  severity: Severity | null = null,
  at = NOW,
  extra: Partial<FeedItem> = {},
): number => {
  upsertItem(db, sourceId, { ...feedItem(guid, severity), ...extra }, false, at)
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

test('PD1b jvnKeywords は全体の JVN をタイトルか製品名で絞り、リポジトリの候補は絞らない', () => {
  const db = memDb()
  const byTitle = add(db, 'jvn', 'a', 'critical', NOW, { title: 'Apache Tomcat における脆弱性' })
  const byProduct = add(db, 'jvn', 'b', 'critical', NOW, { title: '複数の製品', products: ['PostgreSQL'] })
  const other = add(db, 'jvn', 'c', 'critical', NOW, { title: 'ある産業用制御機器', summary: 'tomcat を含む' })
  const aws = add(db, 'aws-whats-new', 'd')
  const pending = buildPending(db, { ...config, jvnKeywords: ['tomcat', 'postgresql'] }, [repo()], 1, NOW)
  assert.deepEqual(pending.globalIds, [byTitle, byProduct, aws])
  assert.deepEqual(pending.filtered, [{ id: other, revision: 1 }])
  assert.deepEqual(pending.repos[0]?.candidateIds, [byTitle, byProduct, other, aws])
  assert.deepEqual(pending.repos[0]?.filtered, [])
})

test('PD1c 同じ URL の項目は送り先ごとに 1 件だけ送り、残りは filtered にする', () => {
  const db = memDb()
  const url = 'https://dev.to/a/post'
  const first = add(db, 'devto', 'p', null, NOW, { url })
  // 別のタグのフィードから来た同じ記事（クエリと末尾の / だけ違う）
  const copy = add(db, 'devto-tag:ai', 'p', null, NOW, { url: `${url}/?utm_source=rss` })
  const pending = buildPending(db, { ...config, devtoTags: ['ai'] }, [repo()], 1, NOW)
  assert.deepEqual(pending.globalIds, [first])
  assert.deepEqual(pending.filtered, [{ id: copy, revision: 1 }])
  assert.deepEqual(pending.repos[0]?.candidateIds, [first])
  assert.deepEqual(pending.repos[0]?.filtered, [{ id: copy, revision: 1 }])
})

test('PD1d 前の実行で別の項目として送った URL は送らない。同じ項目の更新は送る', () => {
  const db = memDb()
  const url = 'https://example.com/same'
  const sent = add(db, 'aws-whats-new', 'a', null, NOW, { url })
  recordDelivery(db, [{ itemId: sent, revision: 1, destination: 'global', status: 'sent', runId: 1 }], NOW)
  const again = add(db, 'aws-news-blog', 'b', null, NOW, { url })
  assert.deepEqual(buildPending(db, config, [], 1, NOW).filtered, [{ id: again, revision: 1 }])
  // gcp-release-notes は更新を追う。本文が変わって revision 2 になった自分の項目は【追記】として送る
  const tracked = add(db, 'gcp-release-notes', 'g', null, NOW, { url: 'https://example.com/notes' })
  recordDelivery(db, [{ itemId: tracked, revision: 1, destination: 'global', status: 'sent', runId: 1 }], NOW)
  upsertItem(
    db,
    'gcp-release-notes',
    { ...feedItem('g'), url: 'https://example.com/notes', summary: 'changed' },
    true,
    NOW,
  )
  assert.deepEqual(buildPending(db, config, [], 1, NOW).globalIds, [tracked])
})

test('PD1e 除外ワードは共通とカテゴリごとのものが、全体・リポジトリの候補・リポジトリの Releases に効く', () => {
  const db = memDb()
  const ad = add(db, 'aws-whats-new', 'a', null, NOW, { title: 'Sponsored: 新サービス' })
  const tutorial = add(db, 'devto', 'b', null, NOW, { summary: 'A Tutorial for you' })
  const keep = add(db, 'aws-whats-new', 'c', null, NOW, { title: 'Lambda の更新', summary: 'tutorial を追加' })
  const release = add(db, 'releases:o/r', 'v1', null, NOW, { title: 'v1.0.0 sponsored build' })
  const excluding = { ...config, excludeWords: ['sponsored'], categoryExclude: { devto: ['tutorial'] } }
  const pending = buildPending(db, excluding, [repo()], 1, NOW)
  assert.deepEqual(pending.globalIds, [keep])
  assert.deepEqual(
    pending.filtered.map((ref) => ref.id),
    [ad, tutorial],
  )
  assert.deepEqual(pending.repos[0]?.candidateIds, [keep])
  assert.deepEqual(pending.repos[0]?.ownIds, [])
  assert.deepEqual(
    pending.repos[0]?.filtered.map((ref) => ref.id),
    [ad, tutorial, release],
  )
})

test('PD1f 項目にカテゴリが付き、追加カテゴリのフィードを全体に入れ、X を止めると X を入れない', () => {
  const db = memDb()
  const feedUrl = 'https://kubernetes.io/feed.xml'
  const k8s = add(db, `feed:${feedUrl}`, 'k', null, NOW, { title: 'Kubernetes v1.40' })
  const llm = add(db, 'aws-news-blog', 'l', null, NOW, { title: 'Bedrock で LLM を使う' })
  const post = add(db, 'x', 'p1')
  const withCategories = {
    ...config,
    categories: [
      { id: 'k8s', title: 'Kubernetes', feeds: [feedUrl], keywords: [] },
      { id: 'ai', title: 'AI', feeds: [], keywords: ['llm'] },
    ],
  }
  const pending = buildPending(db, withCategories, [], 1, NOW)
  assert.deepEqual(pending.globalIds, [k8s, llm, post])
  assert.deepEqual(
    pending.items.map((item) => [item.id, item.section, item.category]),
    [
      [k8s, 'feed', 'k8s'],
      [llm, 'aws', 'ai'],
      [post, 'x', 'x'],
    ],
  )
  const noX = buildPending(db, { ...withCategories, disabledSections: ['x'] }, [], 1, NOW)
  assert.deepEqual(noX.globalIds, [k8s, llm])
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
  finishRun(db, 1, '2026-11-07T00:10:00.000Z')
  startRun(db, '2026-11-08T00:00:00.000Z')
  const { runId } = startRun(db, NOW)
  recordFailure(db, runId, 'devto', 'timeout')
  const pending = buildPending(db, config, [], runId, NOW)
  assert.equal(pending.previousIncomplete, '2026-11-08T00:00:00.000Z')
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

test('PD11 parsePending は buildPending の出力を往復でき、欠けた形は null', () => {
  const db = memDb()
  add(db, 'jvn', 'a', 'critical')
  recordFailure(db, 1, 'devto', 'timeout')
  const pending = buildPending(db, config, [repo()], 1, NOW)
  assert.deepEqual(parsePending(JSON.parse(JSON.stringify(pending))), pending)
  const { failures: _failures, ...withoutFailures } = JSON.parse(JSON.stringify(pending))
  assert.equal(parsePending(withoutFailures), null)
  const broken = JSON.parse(JSON.stringify(pending))
  broken.items[0].section = 'nope'
  assert.equal(parsePending(broken), null)
  assert.equal(parsePending('x'), null)
})

test('PD12 しきい値で外した JVN は送り先ごとに filtered に出し、記録後にしきい値を下げても送らない', () => {
  const db = memDb()
  const high = add(db, 'jvn', 'b', 'high')
  const pending = buildPending(db, config, [repo()], 1, NOW)
  assert.deepEqual(pending.globalIds, [])
  assert.deepEqual(pending.filtered, [{ id: high, revision: 1 }])
  assert.deepEqual(pending.repos[0]?.filtered, [{ id: high, revision: 1 }])
  assert.deepEqual(pending.items, [])
  recordDelivery(
    db,
    (['global', 'repo:o/r'] as const).map((destination) => ({
      itemId: high,
      revision: 1,
      destination,
      status: 'filtered',
      runId: 1,
    })),
    NOW,
  )
  // 翌朝しきい値を high に下げても、溜まった high を一度に送らない
  const lowered = buildPending(db, { ...config, jvnMinSeverity: 'high' }, [repo()], 1, NOW)
  assert.deepEqual(lowered.globalIds, [])
  assert.deepEqual(lowered.repos[0]?.candidateIds, [])
  assert.deepEqual(lowered.filtered, [])
})

test('PD13 filtered にした JVN も、あとで深刻度がしきい値を越えたら送る', () => {
  const db = memDb()
  const id = add(db, 'jvn', 'b', 'high')
  recordDelivery(db, [{ itemId: id, revision: 1, destination: 'global', status: 'filtered', runId: 1 }], NOW)
  assert.deepEqual(buildPending(db, config, [], 1, NOW).globalIds, [])
  upsertItem(db, 'jvn', feedItem('b', 'critical'), false, NOW)
  assert.deepEqual(buildPending(db, config, [], 1, NOW).globalIds, [id])
})
