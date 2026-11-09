import { validateDigest } from '../../lib/digest.ts'

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Json, JsonObject } from '../../lib/json.ts'
import type { PendingEntry, PendingFile } from '../../lib/pending.ts'

const entry = (id: number): PendingEntry => ({
  id,
  revision: 1,
  section: 'aws',
  sourceId: 'aws-whats-new',
  title: 't',
  url: 'u',
  summary: 's',
  author: null,
  publishedAt: null,
  severity: null,
  products: [],
  updated: false,
})
const pending: PendingFile = {
  runId: 3,
  generatedAt: '2026-11-09T00:00:00.000Z',
  previousIncomplete: null,
  items: [entry(1), entry(2), entry(3)],
  globalIds: [1, 2],
  repos: [
    {
      slug: 'o/r',
      displayName: 'o/r',
      watch: { languages: [], packages: [], cloudServices: [], keywords: [] },
      candidateIds: [1],
      ownIds: [3],
      filtered: [],
    },
  ],
  filtered: [],
  failures: [],
}
const digest = (overrides: JsonObject = {}): JsonObject => ({
  runId: 3,
  notes: [{ id: 1, summaryJa: 'まとめ', tags: ['aws'] }],
  groups: [{ key: 'g', titleJa: 't', summaryJa: 's', itemIds: [1, 2] }],
  repos: [{ slug: 'o/r', itemIds: [1, 3] }],
  ...overrides,
})
const errorsOf = (value: Json): string[] => {
  const result = validateDigest(value, pending)
  return result.ok ? [] : result.errors
}

test('DG0 正しい digest は ok', () => {
  const result = validateDigest(digest(), pending)
  assert.ok(result.ok)
  assert.equal(result.digest.groups.length, 1)
})

test('DG1 validateDigest は runId の不一致を拒む', () => {
  assert.ok(errorsOf(digest({ runId: 4 })).some((e) => e.startsWith('runId')))
})

test('DG2 candidate 外の id を repo に書くと拒む', () => {
  const errors = errorsOf(digest({ repos: [{ slug: 'o/r', itemIds: [2] }] }))
  assert.ok(errors.some((e) => e.startsWith('repos[0].itemIds')))
})

test('DG3 同じ id を 2 つの group に入れると拒む', () => {
  const groups = [
    { key: 'a', titleJa: 't', summaryJa: 's', itemIds: [1] },
    { key: 'b', titleJa: 't', summaryJa: 's', itemIds: [1, 2] },
  ]
  assert.ok(errorsOf(digest({ groups })).some((e) => e.startsWith('groups[1].itemIds')))
})

test('DG4 notes が欠けていても ok', () => {
  const { notes: _omitted, ...withoutNotes } = digest()
  assert.ok(validateDigest(withoutNotes, pending).ok)
})

test('DG5 pending に無い id と空の group を拒む', () => {
  const empty = [{ key: 'a', titleJa: 't', summaryJa: 's', itemIds: [] }]
  assert.ok(errorsOf(digest({ groups: empty })).some((e) => e.includes('1 件以上')))
  const unknownGroup = [{ key: 'a', titleJa: 't', summaryJa: 's', itemIds: [99] }]
  assert.ok(errorsOf(digest({ groups: unknownGroup })).some((e) => e.startsWith('groups[0].itemIds')))
  assert.ok(
    errorsOf(digest({ notes: [{ id: 99, summaryJa: 'x', tags: [] }] })).some((e) => e.startsWith('notes[0].id')),
  )
})

test('DG6 不正な形の JSON でも投げずに項目名つきで拒む', () => {
  const shapes: Json[] = [null, 1, 'x', [], {}, { runId: 3, groups: 'x', repos: {} }, digest({ notes: 5, groups: [1] })]
  for (const value of shapes) assert.equal(validateDigest(value, pending).ok, false)
  const errors = errorsOf({ runId: 3 })
  assert.ok(errors.includes('groups: 配列にしてください'))
  assert.ok(errors.includes('repos: 配列にしてください'))
  assert.ok(errorsOf(digest({ repos: [{ slug: 'x/y', itemIds: [] }] })).some((e) => e.startsWith('repos[0].slug')))
  assert.ok(errorsOf(digest({ repos: [{ slug: 'o/r', itemIds: 'x' }] })).some((e) => e.startsWith('repos[0].itemIds')))
})
