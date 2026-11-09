import { openDb, recordDelivery, startRun, upsertItem } from '../lib/db.ts'
import { homePaths } from '../lib/paths.ts'
import { runCli, tempHome, writeConfig } from './helpers.ts'

import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { after, test } from 'node:test'

import type { FeedItem } from '../lib/feed.ts'
import type { Severity } from '../lib/severity.ts'

const homes: string[] = []
after(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true })
})

const feedItem = (guid: string, title: string, publishedAt: string, severity: Severity | null): FeedItem => ({
  guid,
  url: `https://example.com/${guid}`,
  title,
  summary: title,
  author: null,
  publishedAt,
  updatedAt: null,
  severity,
  products: [],
})

// jvn の Keycloak（repo:a/a に配信）と aws の別項目を入れた home
const seed = (): string => {
  const home = tempHome()
  homes.push(home)
  writeConfig(home)
  const db = openDb(homePaths(home).db)
  const { runId } = startRun(db, '2026-11-09T00:00:00.000Z')
  const seen = '2026-11-09T00:00:00.000Z'
  upsertItem(db, 'jvn', feedItem('k', 'Keycloak vulnerability', '2026-10-15T00:00:00.000Z', 'high'), false, seen)
  upsertItem(db, 'aws-whats-new', feedItem('s', 'S3 new feature', '2026-10-20T00:00:00.000Z', null), false, seen)
  const id = (guid: string): number => Number(db.prepare('SELECT id FROM items WHERE guid = ?').get(guid)?.id)
  recordDelivery(db, [{ itemId: id('k'), revision: 1, destination: 'repo:a/a', status: 'sent', runId }], seen)
  db.close()
  return home
}
const titles = (stdout: string): string[] => JSON.parse(stdout).map((hit: { title: string }) => hit.title)

test('SE1 search は q・期間・section・repo で絞った JSON を返す', () => {
  const env = { DEV_DIGEST_HOME: seed() }
  const search = (...args: string[]) => {
    const result = runCli(['search', ...args], env)
    assert.equal(result.code, 0, result.stderr)
    return titles(result.stdout)
  }
  assert.deepEqual(search('--q', 'keycloak', '--section', 'jvn'), ['Keycloak vulnerability'])
  assert.deepEqual(search('--q', 'keycloak', '--section', 'aws'), [])
  assert.deepEqual(search('--repo', 'a/a'), ['Keycloak vulnerability'])
  assert.deepEqual(search('--repo', 'b/b'), [])
  assert.deepEqual(search('--min-severity', 'high'), ['Keycloak vulnerability'])
  assert.equal(search().length, 2)
  assert.equal(search('--limit', '1').length, 1)
  // 10/16 以降なら Keycloak（10/15）は外れる
  assert.deepEqual(search('--since', '2026-10-16'), ['S3 new feature'])
  assert.deepEqual(search('--until', '2026-10-15'), ['Keycloak vulnerability'])
})

test('SE2 日付は config の timezone の一日として解釈する', () => {
  const home = seed()
  // Asia/Tokyo の 10-15 は UTC の 10-14T15:00 〜 10-15T14:59:59.999。published 10-15T00:00Z は含まれる
  const env = { DEV_DIGEST_HOME: home }
  assert.deepEqual(titles(runCli(['search', '--since', '2026-10-15', '--until', '2026-10-15'], env).stdout), [
    'Keycloak vulnerability',
  ])
  // 10-14 の終わりは UTC 10-14T14:59:59.999 なので 10-15T00:00Z の項目は入らない
  assert.deepEqual(titles(runCli(['search', '--until', '2026-10-14'], env).stdout), [])
})

test('SE3 不正な値は exit 2。設定が無くても exit 2', () => {
  const env = { DEV_DIGEST_HOME: seed() }
  for (const args of [
    ['--section', 'nope'],
    ['--min-severity', 'huge'],
    ['--since', '2026-13-01'],
    ['--until', 'yesterday'],
    ['--limit', '0'],
  ]) {
    assert.equal(runCli(['search', ...args], env).code, 2, args.join(' '))
  }
  const empty = tempHome()
  homes.push(empty)
  const result = runCli(['search'], { DEV_DIGEST_HOME: empty })
  assert.equal(result.code, 2)
  assert.match(result.stderr, /init/)
})
