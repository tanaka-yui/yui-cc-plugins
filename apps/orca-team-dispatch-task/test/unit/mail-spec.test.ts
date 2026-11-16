import { renderMailSpec } from '../../lib/mail-spec.ts'

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'

import type { MailSpecInput } from '../../lib/mail-spec.ts'

const input = (overrides: Partial<MailSpecInput> = {}): MailSpecInput => ({
  slug: 'auto-test',
  role: 'design',
  orcaBin: 'orca',
  request: 'Entire request\n- node --test',
  plan: null,
  baseBranch: 'origin/main',
  primaryRepo: '',
  extraRepos: [],
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
    'review-request: plan',
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
    assert.ok(spec.includes('If that check returns mail you have not acted on'))
  }
})
// 2026-11-16 の実機: 遠くの worker（federated dispatch）は --to を付けた send を「Federated Dispatch messages route to
// their Run home」で拒まれ、レビュー役へ直接送れなかった。レビューのメールは --to 無しで親へ送り、親が相手へ転送する
test('MS12 review mail goes through the coordinator without --to, and review-unavailable ends the wait', () => {
  const requester = renderMailSpec(input({ role: 'design', planOnly: true, integration: false, reviewer: 'ctx_r' }))
  const reviewer = renderMailSpec(input({ role: 'exec_review', reviewOf: 'code', integration: false }))
  for (const spec of [requester, reviewer]) {
    assert.ok(!spec.includes('--to dispatch:'), 'no direct worker-to-worker address')
    assert.ok(!spec.includes('reply-to'))
    assert.ok(spec.includes('omit --to'))
  }
  for (const text of [
    'orchestration send --type status <ids> --subject "review-request: plan round <n>"',
    'orchestration send --type status <ids> --subject "abort-reviewer: done"',
    'review-unavailable: plan round <n>',
  ])
    assert.ok(requester.includes(text), text)
  assert.ok(
    reviewer.includes('orchestration send --type status <ids> --subject "review-verdict: code round <n>"'),
    'verdict via coordinator',
  )
})

const multi = {
  primaryRepo: 'acme/api',
  extraRepos: [{ repo: 'acme/web', worktreePath: '/work/web', branch: 'user/web', baseBranch: 'origin/develop' }],
}

test('MS13 every worktree is checked, pushed and included in a version 2 envelope', () => {
  const spec = renderMailSpec(input({ ...multi, role: 'exec' }))
  for (const part of [
    'This task spans 2 repositories',
    'acme/api',
    '/work/web',
    'user/web',
    'origin/develop',
    'git -C',
    '"version":2',
    'heads',
  ]) {
    assert.ok(spec.includes(part), part)
  }
  assert.ok(spec.includes("git -C '/work/web' push origin HEAD:refs/heads/user/web"))
})

test('MS14 code review requests identify each repository, head and base', () => {
  const spec = renderMailSpec(input({ ...multi, role: 'exec', reviewer: 'ctx_r' }))
  assert.ok(spec.includes('repo: acme/api\nbranch:'))
  assert.ok(spec.includes('repo: acme/web\nbranch:'))
  assert.ok(spec.includes('base: origin/develop'))
})

test('MS15 reviewer fetches each repository in its own worktree', () => {
  const spec = renderMailSpec(input({ ...multi, role: 'exec_review', reviewOf: 'code', integration: false }))
  for (const part of [
    "git -C '/work/web' fetch origin +refs/heads/<branch>",
    "git -C '/work/web' rev-parse FETCH_HEAD",
    "git -C '/work/web' diff <base>...FETCH_HEAD",
    "git -C '/work/web' worktree add --detach",
  ]) {
    assert.ok(spec.includes(part), part)
  }
})

test('MS16 legacy instructions remain byte-for-byte identical for every role', () => {
  const cases: Array<[Partial<MailSpecInput>, string]> = [
    [{}, '28d98c97ee3f029987cac52e9a1f35c11705b7f90a133734d18994c9e531518d'],
    [
      { planOnly: true, integration: false, reviewer: 'ctx_r' },
      'a72705b9d8e171aa8676d3cecfec59586f37a4d66bec78b0263044b5540c916f',
    ],
    [
      { role: 'exec', plan: 'Entire plan', reviewer: 'ctx_r' },
      'c608be35bb2e662087482dc2ab658ab1cd73f64e6466131a05169b38c4e37255',
    ],
    [
      { role: 'design_review', reviewOf: 'plan', integration: false },
      '2742f6d4ae1004b5f4782ea37b50788ce9af24129e5fc6fd78ef3bd453c28557',
    ],
    [
      { role: 'exec_review', reviewOf: 'code', integration: false },
      '547081e571075603e04f80ce2e96027eecf6ba8cb3c2ed8e5d4ffee547a5d496',
    ],
  ]
  for (const [overrides, hash] of cases) {
    assert.equal(
      createHash('sha256')
        .update(renderMailSpec(input(overrides)))
        .digest('hex'),
      hash,
    )
  }
})
