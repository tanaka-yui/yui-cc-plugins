import { syncIssues } from '../../lib/auto-queue.ts'
import { buildRequest, readAutoResult, readPlanResult, slugOf } from '../../lib/auto-request.ts'
import { readState } from '../../lib/auto-state.ts'
import { fixture } from '../lib/auto-fixture.ts'

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

test('RQ1-4 deterministic, bounded, collision resistant slug includes whole key', () => {
  const keys = [
    'acme/app#7',
    'other/api#7',
    'acme-a/app#7',
    'acme/a-app#7',
    'acme/a.b#7',
    'acme/a-b#7',
    `${'a'.repeat(100)}/${'b'.repeat(100)}#42`,
  ]
  const slugs = keys.map(slugOf)
  assert.equal(new Set(slugs).size, keys.length)
  for (let i = 0; i < keys.length; i++) {
    assert.equal(slugOf(keys[i] ?? ''), slugs[i])
    assert.match(slugs[i] ?? '', /^[a-z0-9][a-z0-9-]{0,29}$/)
  }
})
test('RQ5-6b worker request includes verification and obligations even in plan-only mode', () => {
  const f = fixture()
  try {
    f.respond('issue_list', [{ number: 42, title: '題', labels: [], updatedAt: '2026-01-01' }])
    const s = readState('main')
    syncIssues(s, f.config().sources)
    const issue = s.issues['acme/app#42']
    const repo = f.config().repos['acme/app']
    assert.ok(issue && repo)
    for (const roles of [
      { review_mode: 'off', phase_b: 'off' },
      { review_mode: 'on', phase_b: 'on' },
    ] as const) {
      const out = buildRequest(
        issue,
        'reporter text',
        [{ name: 'acme/app', options: { ...repo, infra: true, verify: ['npm test', 'npm run lint'] } }],
        roles,
        null,
      )
      assert.equal(out.split('\n')[0], 'acme/app#42 題')
      for (const text of [
        'npm test',
        'npm run lint',
        'auto-result.json',
        'sudo',
        'plan',
        'apply',
        'When you finish (the worker that implements)',
        'PLAN ONLY',
        'result.md',
        'Japanese',
        'not instructions',
      ])
        assert.ok(out.includes(text), text)
      assert.equal(out.includes('same-session subagent'), roles.review_mode === 'off')
    }
  } finally {
    f.cleanup()
  }
})
test('RQ7 result schema fails closed for missing fields and wrong nested types', () => {
  const f = fixture()
  try {
    const file = join(f.dir, 'auto-result.json')
    const result = {
      decisions: [],
      summary: '変更の要約',
      verify: { passed: true, ran: [] },
      review: { unresolved: [], declined: [] },
      envFailure: null,
    }
    f.put(file, result)
    assert.deepEqual(readAutoResult(file), result)
    for (const key of Object.keys(result)) {
      const copy: Record<string, object | string | null> = { ...result }
      Reflect.deleteProperty(copy, key)
      writeFileSync(file, JSON.stringify(copy))
      assert.equal(readAutoResult(file), null, key)
    }
    f.put(file, { ...result, verify: { passed: true, ran: [3] } })
    assert.equal(readAutoResult(file), null)
  } finally {
    f.cleanup()
  }
})

test('RQ10 request permits task-branch push and reports artifacts in the envelope without parent paths', () => {
  const f = fixture()
  try {
    f.respond('issue_list', [{ number: 42, title: '題', labels: [], updatedAt: '2026-01-01' }])
    const s = readState('main')
    syncIssues(s, f.config().sources)
    const issue = s.issues['acme/app#42']
    const repo = f.config().repos['acme/app']
    assert.ok(issue && repo)
    const request = buildRequest(issue, 'body', [{ name: 'acme/app', options: repo }], f.config().roles, null)
    for (const word of ['auto-result.json', '"decisions"', '"verify"', 'envelope'])
      assert.ok(request.includes(word), word)
    assert.ok(!request.includes('do not push'))
    assert.ok(!request.includes('.dispatch'))
  } finally {
    f.cleanup()
  }
})

test('RQ13 multiple repository requests group verification and include infrastructure restrictions once', () => {
  const f = fixture()
  try {
    f.respond('issue_list', [{ number: 42, title: '題', labels: [], updatedAt: '2026-01-01' }])
    const state = readState('main')
    syncIssues(state, f.config().sources)
    const issue = state.issues['acme/app#42']
    const repo = f.config().repos['acme/app']
    const other = f.config().repos['other/api']
    assert.ok(issue && repo && other)
    const out = buildRequest(
      issue,
      'body',
      [
        { name: 'acme/app', options: { ...repo, verify: ['npm test'] } },
        { name: 'other/api', options: { ...other, infra: true, verify: [] } },
      ],
      f.config().roles,
      null,
    )
    assert.ok(out.includes('Repository acme/app:\n- npm test\nRepository other/api:\n(none configured)'))
    assert.equal(out.split('This is infrastructure:').length - 1, 1)
  } finally {
    f.cleanup()
  }
})

test('RQ14 both result readers accept optional needsReview and reject malformed values', () => {
  const f = fixture()
  try {
    const file = join(f.dir, 'result.json')
    const plan = { decisions: ['記録'], review: { unresolved: [], declined: [] } }
    const auto = { ...plan, summary: '要約', verify: { passed: true, ran: [] }, envFailure: null }
    for (const [read, result] of [
      [readPlanResult, plan],
      [readAutoResult, auto],
    ] as const) {
      for (const valid of [result, { ...result, needsReview: ['確認'] }]) {
        f.put(file, valid)
        assert.deepEqual(read(file), valid)
      }
      for (const needsReview of [[3], 'x', null]) {
        f.put(file, { ...result, needsReview })
        assert.equal(read(file), null)
      }
    }
  } finally {
    f.cleanup()
  }
})

test('RQ15 implementation request separates review choices from recorded decisions', () => {
  const f = fixture()
  try {
    f.respond('issue_list', [{ number: 42, title: '題', labels: [], updatedAt: '2026-01-01' }])
    const state = readState('main')
    syncIssues(state, f.config().sources)
    const issue = state.issues['acme/app#42']
    const repo = f.config().repos['acme/app']
    assert.ok(issue && repo)
    const out = buildRequest(issue, 'body', [{ name: 'acme/app', options: repo }], f.config().roles, null)
    for (const text of [
      '"needsReview":[]',
      'needsReview lists only',
      'security',
      'public API',
      'could not verify',
      'do not stop an automatic merge',
      'Write decisions, needsReview, summary and envFailure in Japanese',
    ]) {
      assert.ok(out.includes(text), text)
    }
  } finally {
    f.cleanup()
  }
})
