import { validateDecisions } from '../../lib/decisions.ts'

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Json } from '../../lib/json.ts'
import type { WorkFile, WorkItem } from '../../lib/work.ts'

const item = (id: number, mustCreate: boolean): WorkItem => ({
  id,
  kind: 'new',
  mustCreate,
  roundsAsked: 0,
  maxRounds: 2,
  title: 'T',
  category: 'バグ',
  categoryKey: 'bug',
  priority: 'high',
  reporter: null,
  body: 'B',
  attachments: [],
  thread: [],
})
const work: WorkFile = { runId: 'r-1', createdAt: '2026-11-12T00:00:00.000Z', items: [item(1, false), item(2, true)] }
const create = { id: 2, action: 'create', summary: '要約', details: '詳細', unresolved: [] }
test('DE1 全件ちょうど1つの正しい決定を受け入れる', () =>
  assert.ok(
    validateDecisions({ runId: 'r-1', decisions: [{ id: 1, action: 'ask', message: '質問' }, create] }, work).ok,
  ))
test('DE2 不一致・欠け・未知・重複をまとめて検出', () => {
  const r = validateDecisions({ runId: 'r-x', decisions: [create, create, { ...create, id: 3 }] }, work)
  assert.ok(!r.ok && r.errors.length >= 4)
})
test('DE3 mustCreateでaskを拒否', () => {
  const r = validateDecisions(
    {
      runId: 'r-1',
      decisions: [
        { id: 1, action: 'ask', message: '質問' },
        { id: 2, action: 'ask', message: '質問' },
      ],
    },
    work,
  )
  assert.ok(!r.ok && r.errors.some((e) => e.includes('id=2') && e.includes('create')))
})
test('DE4 空・文字数超過・unresolvedの形を拒否', () => {
  const invalid: Json[] = [
    { id: 1, action: 'ask', message: '' },
    { id: 1, action: 'ask', message: 'x'.repeat(2001) },
    { ...create, id: 1, summary: 'x'.repeat(1001) },
    { ...create, id: 1, unresolved: 'x' },
    { ...create, id: 1, unresolved: Array.from({ length: 11 }, () => 'x') },
    { ...create, id: 1, unresolved: ['x'.repeat(501)] },
  ]
  for (const bad of invalid) assert.ok(!validateDecisions({ runId: 'r-1', decisions: [bad, create] }, work).ok)
})
