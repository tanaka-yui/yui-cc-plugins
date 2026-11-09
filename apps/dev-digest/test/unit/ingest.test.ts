import { isFirstFetch, openDb, undelivered } from '../../lib/db.ts'
import { ingestFeed } from '../../lib/ingest.ts'

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { FeedItem } from '../../lib/feed.ts'

const NOW = '2026-11-09T00:00:00.000Z'
const FEED = { id: 'f', storeAs: 's', trackUpdates: false }
const item = (guid: string, publishedAt: string): FeedItem => ({
  guid,
  url: `https://example.com/${guid}`,
  title: guid,
  summary: guid,
  author: null,
  publishedAt,
  updatedAt: null,
  severity: null,
  products: [],
})

test('IG1 初回の取得で 1 件も読めなければ取得済みにせず、次の取得を初回として扱う', () => {
  const db = openDb(':memory:')
  // HTML の 200 や空のフィードは 0 件になる
  ingestFeed(db, FEED, [], NOW)
  assert.equal(isFirstFetch(db, FEED.id), true)
  ingestFeed(db, FEED, [item('old', '2026-11-01T00:00:00.000Z'), item('fresh', '2026-11-08T23:00:00.000Z')], NOW)
  assert.equal(isFirstFetch(db, FEED.id), false)
  assert.deepEqual(
    undelivered(db, 'global', [FEED.storeAs], null).map((stored) => stored.guid),
    ['fresh'],
  )
})
