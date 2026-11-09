import {
  finishRun,
  hasSource,
  markBaseline,
  openDb,
  recordDelivery,
  saveNote,
  search,
  startRun,
  undelivered,
  upsertItem,
} from '../../lib/db.ts'

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Section } from '../../lib/config.ts'
import type { SearchQuery } from '../../lib/db.ts'
import type { FeedItem } from '../../lib/feed.ts'

const NOW = '2026-11-09T00:00:00Z'
const item = (overrides: Partial<FeedItem> = {}): FeedItem => ({
  guid: 'g1',
  url: 'https://example.com/1',
  title: 'title',
  summary: 'summary',
  author: null,
  publishedAt: '2026-11-08T23:00:00Z',
  updatedAt: null,
  severity: null,
  products: [],
  ...overrides,
})
const query = (overrides: Partial<SearchQuery> = {}): SearchQuery => ({
  text: null,
  since: null,
  until: null,
  sections: [],
  repo: null,
  minSeverity: null,
  limit: 50,
  ...overrides,
})
const sectionOf = (): Section => 'jvn'

test('DB1 初回は new、同じものは unchanged', () => {
  const db = openDb(':memory:')
  assert.equal(upsertItem(db, 's', item(), false, NOW), 'new')
  assert.equal(upsertItem(db, 's', item(), false, NOW), 'unchanged')
  assert.equal(hasSource(db, 's'), true)
  assert.equal(hasSource(db, 'other'), false)
})

test('DB2 trackUpdates の source だけ本文の変化で revision が上がる', () => {
  const db = openDb(':memory:')
  upsertItem(db, 'gcp', item(), true, NOW)
  upsertItem(db, 'plain', item(), false, NOW)
  assert.equal(upsertItem(db, 'gcp', item({ summary: 'changed' }), true, NOW), 'updated')
  assert.equal(upsertItem(db, 'plain', item({ summary: 'changed' }), false, NOW), 'unchanged')
  const gcp = undelivered(db, 'global', ['gcp'], null)[0]
  const plain = undelivered(db, 'global', ['plain'], null)[0]
  assert.equal(gcp?.revision, 2)
  assert.equal(gcp?.updated, true)
  assert.equal(plain?.revision, 1)
  assert.equal(plain?.updated, false)
})

test('DB3 深刻度は trackUpdates に関係なく上書きされ、revision は上がらない', () => {
  const db = openDb(':memory:')
  upsertItem(db, 's', item({ severity: 'high' }), false, NOW)
  assert.equal(upsertItem(db, 's', item({ severity: 'critical' }), false, NOW), 'unchanged')
  const stored = undelivered(db, 'global', ['s'], null)[0]
  assert.equal(stored?.severity, 'critical')
  assert.equal(stored?.revision, 1)
})

test('DB4 markBaseline は cutoff より古い項目と日付無しを除外する', () => {
  const db = openDb(':memory:')
  upsertItem(db, 's', item({ guid: 'old', publishedAt: '2026-11-07T00:00:00Z' }), false, NOW)
  upsertItem(db, 's', item({ guid: 'recent', publishedAt: '2026-11-08T23:00:00Z' }), false, NOW)
  upsertItem(db, 's', item({ guid: 'none', publishedAt: null }), false, NOW)
  assert.equal(markBaseline(db, 's', '2026-11-08T00:00:00Z'), 2)
  assert.deepEqual(
    undelivered(db, 'global', ['s'], null).map((stored) => stored.guid),
    ['recent'],
  )
})

test('DB5 undelivered は送り先ごと', () => {
  const db = openDb(':memory:')
  upsertItem(db, 's', item(), false, NOW)
  const stored = undelivered(db, 'global', ['s'], null)[0]
  assert.ok(stored)
  recordDelivery(db, [{ itemId: stored.id, revision: 1, destination: 'global', status: 'sent', runId: 1 }], NOW)
  assert.equal(undelivered(db, 'global', ['s'], null).length, 0)
  assert.equal(undelivered(db, 'repo:a/a', ['s'], null).length, 1)
  assert.equal(undelivered(db, 'repo:a/a', ['s'], '2026-11-10T00:00:00Z').length, 0)
})

test('DB6 revision が上がると再び undelivered になる', () => {
  const db = openDb(':memory:')
  upsertItem(db, 's', item(), true, NOW)
  const stored = undelivered(db, 'global', ['s'], null)[0]
  assert.ok(stored)
  recordDelivery(db, [{ itemId: stored.id, revision: 1, destination: 'global', status: 'irrelevant', runId: 1 }], NOW)
  assert.equal(undelivered(db, 'global', ['s'], null).length, 0)
  upsertItem(db, 's', item({ summary: 'changed' }), true, NOW)
  const again = undelivered(db, 'global', ['s'], null)
  assert.equal(again.length, 1)
  assert.equal(again[0]?.revision, 2)
})

test('DB7 startRun は前回の未完了を返す', () => {
  const db = openDb(':memory:')
  const first = startRun(db, NOW)
  assert.equal(first.previousIncomplete, null)
  const second = startRun(db, NOW)
  assert.equal(second.previousIncomplete?.runId, first.runId)
  finishRun(db, second.runId, NOW)
  finishRun(db, first.runId, NOW)
  assert.equal(startRun(db, NOW).previousIncomplete, null)
})

test('DB8 search は日本語の部分一致と期間・深刻度で絞る', () => {
  const db = openDb(':memory:')
  upsertItem(db, 's', item({ guid: 'a', title: 'Keycloak における認証回避の脆弱性', severity: 'critical' }), false, NOW)
  upsertItem(
    db,
    's',
    item({ guid: 'b', title: 'Keycloak minor', severity: 'high', publishedAt: '2026-10-01T00:00:00Z' }),
    false,
    NOW,
  )
  upsertItem(db, 's', item({ guid: 'c', title: 'AI の話', summary: 'x' }), false, NOW)
  assert.equal(search(db, query({ text: '認証回避' }), sectionOf).length, 1)
  assert.equal(search(db, query({ text: 'keycloak' }), sectionOf).length, 2)
  assert.deepEqual(
    search(db, query({ text: 'keycloak', minSeverity: 'critical' }), sectionOf).map((hit) => hit.guid),
    ['a'],
  )
  assert.deepEqual(
    search(db, query({ text: 'keycloak', since: '2026-11-01T00:00:00Z' }), sectionOf).map((hit) => hit.guid),
    ['a'],
  )
  assert.deepEqual(
    search(db, query({ text: 'AI' }), sectionOf).map((hit) => hit.guid),
    ['c'],
  )
})

test('DB9 search は note と送信先を返し、危険な文字でも落ちない', () => {
  const db = openDb(':memory:')
  upsertItem(db, 's', item({ title: 'plain' }), false, NOW)
  const stored = undelivered(db, 'global', ['s'], null)[0]
  assert.ok(stored)
  saveNote(db, stored.id, 1, { summaryJa: '要約テキスト', tags: ['auth'], groupKey: null })
  recordDelivery(db, [{ itemId: stored.id, revision: 1, destination: 'repo:a/a', status: 'sent', runId: 1 }], NOW)
  const hits = search(db, query({ text: '要約テキ', repo: 'a/a' }), sectionOf)
  assert.equal(hits.length, 1)
  assert.equal(hits[0]?.summaryJa, '要約テキスト')
  assert.deepEqual(hits[0]?.tags, ['auth'])
  assert.deepEqual(hits[0]?.deliveredTo, ['repo:a/a'])
  assert.equal(search(db, query({ text: 'plain', repo: 'b/b' }), sectionOf).length, 0)
  assert.equal(search(db, query({ text: 'a-b "x" AND' }), sectionOf).length, 0)
  assert.equal(search(db, query({ text: '"' }), sectionOf).length, 0)
})
