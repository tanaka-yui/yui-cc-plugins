import { renderMailSpec } from '../../lib/mail-spec.ts'

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { MailSpecInput } from '../../lib/mail-spec.ts'

const input = (overrides: Partial<MailSpecInput> = {}): MailSpecInput => ({
  slug: 'auto-test',
  role: 'design',
  orcaBin: 'orca',
  request: 'Entire request\n- node --test',
  plan: null,
  baseBranch: 'origin/main',
  integration: true,
  planOnly: false,
  reviewer: null,
  reviewOf: null,
  reviewRounds: 5,
  ...overrides,
})
test('MS1-3 mail handoff is portable and carries full inputs and completion protocol', () => {
  const spec = renderMailSpec(input({ role: 'exec', plan: 'Entire plan' }))
  for (const banned of [new URL('../..', import.meta.url).pathname, '.dispatch/', '/Applications/Orca.app'])
    assert.ok(!spec.includes(banned))
  for (const text of [
    'Entire request',
    'Entire plan',
    'merge_ready: ',
    'completion-accepted: ',
    'completion-remediation: ',
    'worker_done --outcome',
  ])
    assert.ok(spec.includes(text), text)
  assert.doesNotMatch(spec, /^\s*node /m)
})
test('MS4 nonintegration roles receive no push step', () =>
  assert.ok(!renderMailSpec(input({ integration: false })).includes('git push')))
test('MS5/6/7 completion uses preamble identity, terminal peeks, and failure envelope', () => {
  const spec = renderMailSpec(input({ reviewer: 'ctx_r' }))
  for (const text of [
    'dispatch:ctx_r',
    'review-request: plan',
    'reply-to dispatch:',
    '--task-id <task id> --dispatch-id <dispatch id> --from <handle>',
    '--outcome failed',
    '--body "$(cat <envelope file>)"',
  ])
    assert.ok(spec.includes(text), text)
  for (const line of spec
    .split('\n')
    .filter((l) => /orchestration send --type (status|merge_ready|worker_done)/.test(l)))
    assert.ok(line.includes('<ids>'), line)
  // worker_done の直前に既読にする 1 行（MS11）だけが --peek を持たない
  const checks = spec.split('\n').filter((l) => l.includes('orchestration check'))
  for (const line of checks) assert.ok(line.includes('--terminal <handle>'), line)
  assert.deepEqual(
    checks.filter((l) => !l.includes('--peek')),
    ["'orca' orchestration check --terminal <handle> --json"],
  )
  const reviewer = renderMailSpec(input({ role: 'exec_review', reviewOf: 'code', integration: false }))
  for (const text of ['review-verdict: code', 'VERDICT: ', 'abort-reviewer:']) assert.ok(reviewer.includes(text), text)
})
test('MS8 request verification commands remain executable', () =>
  assert.ok(renderMailSpec(input()).includes('Run every verification command the request lists.')))
test('MS9 code reviews name and verify the pushed head without moving reviewer HEAD', () => {
  const spec = renderMailSpec(input({ role: 'exec', reviewer: 'ctx_r' }))
  for (const text of ['branch: ', 'head: ', 'base: ']) assert.ok(spec.includes(text))
  for (const reviewOf of ['plan', 'code'] as const) {
    const review = renderMailSpec(
      input({ role: reviewOf === 'plan' ? 'design_review' : 'exec_review', reviewOf, integration: false }),
    )
    assert.ok(review.includes("Do not move your worktree's HEAD"))
    if (reviewOf === 'code')
      for (const text of ['git fetch origin +refs/heads/', 'FETCH_HEAD', 'git diff']) assert.ok(review.includes(text))
  }
})
test('MS10 only planning-only design produces structured planning decisions', () => {
  const spec = renderMailSpec(input({ planOnly: true, integration: false }))
  assert.ok(spec.includes('plan-result.json'))
  assert.ok(spec.includes('{"decisions":[],"review":{"unresolved":[],"declined":[]}}'))
  assert.ok(!renderMailSpec(input()).includes('plan-result.json'))
  assert.ok(!renderMailSpec(input({ role: 'exec' })).includes('plan-result.json'))
})
// 2026-11-16 の実機: --peek で読んだ受理の返事を未読のまま worker_done を送ると、Orca が followUp の dispatch を作り
// 同じ端末で worker を起こし直した。worker_done の前に --peek の無い check で既読にさせる
test('MS11 every role reads its mail without --peek before worker_done', () => {
  for (const spec of [
    renderMailSpec(input()),
    renderMailSpec(input({ role: 'exec_review', reviewOf: 'code', integration: false })),
  ]) {
    const consume = spec.indexOf('orchestration check --terminal <handle> --json')
    assert.ok(consume > 0)
    assert.ok(consume < spec.indexOf('--type worker_done --outcome succeeded'))
    assert.ok(consume < spec.indexOf('--type worker_done --outcome failed'))
    assert.ok(spec.includes('Never send worker_done while mail is unread'))
  }
})
