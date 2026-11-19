import { validateDecisions } from '../../lib/decisions.ts'

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Json } from '../../lib/json.ts'
import type { WorkFile, WorkItem } from '../../lib/work.ts'

const item = (id: number, mustCreate: boolean): WorkItem => ({
  id,
  kind: 'new',
  mustCreate,
  mustClose: false,
  questionKind: null,
  issueProposed: false,
  knowledge: null,
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

const question = (id: number, patch: Partial<WorkItem> = {}): WorkItem => ({
  ...item(id, false),
  category: '質問',
  categoryKey: 'question',
  questionKind: 'spec',
  maxRounds: 3,
  knowledge: {
    repo: 'acme/app',
    index: '/k/INDEX.md',
    faq: null,
    docs: '/k/docs',
    commit: 'c0ffee',
    builtAt: '2026-11-12T00:00:00.000Z',
    stale: false,
    files: ['docs/a b.md'],
  },
  ...patch,
})
const decide = (items: WorkItem[], decisions: Json[]) =>
  validateDecisions({ runId: 'r-1', decisions }, { runId: 'r-1', createdAt: '2026-11-12T00:00:00.000Z', items })
test('DE5 質問の answer は索引にある根拠だけを受け、permalink を作る。ask や提案の種類違いは拒否', () => {
  const ok = decide([question(1)], [{ id: 1, action: 'answer', message: '回答', sources: ['docs/a b.md'] }])
  assert.ok(ok.ok)
  assert.deepEqual(ok.ok && ok.value.decisions[0], {
    id: 1,
    action: 'answer',
    message: '回答',
    sources: ['docs/a b.md'],
    links: ['https://github.com/acme/app/blob/c0ffee/docs/a%20b.md'],
    proposeIssue: false,
  })
  const bads: Json[] = [
    { id: 1, action: 'answer', message: '回答', sources: ['.env'] },
    { id: 1, action: 'answer', message: '回答', sources: 'docs/a b.md' },
    { id: 1, action: 'answer', message: '回答', sources: Array.from({ length: 6 }, () => 'docs/a b.md') },
    { id: 1, action: 'answer', message: '', sources: [] },
    { id: 1, action: 'answer', message: '回答', sources: [], proposeIssue: true },
    { id: 1, action: 'answer', message: '回答', sources: [], proposeIssue: 'yes' },
    { id: 1, action: 'ask', message: '質問' },
  ]
  for (const bad of bads) assert.ok(!decide([question(1)], [bad]).ok, JSON.stringify(bad))
  assert.ok(
    decide([question(1, { questionKind: 'unsure' })], [{ id: 1, action: 'answer', message: 'x', proposeIssue: true }])
      .ok,
  )
  for (const action of ['answer', 'close'])
    assert.ok(!decide([item(1, false)], [{ id: 1, action, message: 'x', sources: [] }]).ok, action)
})
test('DE6 回答の上限に達した質問は close だけ', () => {
  const full = question(1, { mustClose: true, kind: 'answered' })
  assert.ok(decide([full], [{ id: 1, action: 'close', message: '締め' }]).ok)
  assert.ok(!decide([full], [{ id: 1, action: 'answer', message: 'x', sources: [] }]).ok)
})
test('DE7 質問からの create は unsure・提案済み・返信ありで、題が要る', () => {
  const create = { id: 1, action: 'create', title: '題', summary: '要約', details: '詳細', unresolved: [] }
  const ready = question(1, { questionKind: 'unsure', issueProposed: true, kind: 'answered' })
  const r = decide([ready], [create])
  assert.ok(r.ok && r.value.decisions[0]?.action === 'create' && r.value.decisions[0].title === '題')
  assert.ok(!decide([ready], [{ ...create, title: '' }]).ok)
  assert.ok(!decide([ready], [{ ...create, title: 'x'.repeat(257) }]).ok)
  assert.ok(!decide([{ ...ready, issueProposed: false }], [create]).ok)
  assert.ok(!decide([{ ...ready, kind: 'new' }], [create]).ok)
  assert.ok(!decide([{ ...ready, questionKind: 'spec' }], [create]).ok)
})
