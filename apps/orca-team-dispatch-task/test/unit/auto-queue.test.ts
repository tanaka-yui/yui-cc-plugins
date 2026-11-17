import { orderQueue, priorityOf, syncIssues } from '../../lib/auto-queue.ts'
import { fixture } from '../lib/auto-fixture.ts'

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { AutoState, IssueState } from '../../lib/auto-state.ts'

const empty = (): AutoState => ({ version: 1, judgingSince: null, issues: {}, projectSync: {} })
test('QU1-4 priority, age and stable key order', () => {
  const items = [
    { key: 'b', priority: 'middle', readyAt: '2026-02-01' },
    { key: 'a', priority: 'middle', readyAt: '2026-02-01' },
    { key: 'c', priority: 'critical', readyAt: '2026-03-01' },
    { key: 'd', priority: 'low', readyAt: '2026-01-01' },
  ] as IssueState[]
  assert.deepEqual(
    orderQueue(items).map((i) => i.key),
    ['c', 'a', 'b', 'd'],
  )
  assert.equal(priorityOf([]), 'middle')
  assert.equal(priorityOf(['priority: low', 'priority: high']), 'high')
})
test('AU16-19 managed issues from multiple repositories use distinct keys and deduplicate', () => {
  const f = fixture()
  try {
    f.respond('issue_list', [{ number: 7, title: '題', labels: [{ name: 'priority: high' }], updatedAt: '2026-01-01' }])
    const s = empty()
    const result = syncIssues(s, f.config().sources)
    assert.deepEqual(result.added, ['acme/app#7', 'other/api#7'])
    assert.equal(Object.keys(s.issues).length, 2)
    assert.equal(s.issues['acme/app#7']?.phase, 'judging')
    assert.match(f.calls(), /--label Ready --label from-slack/)
    assert.match(f.calls(), /--label Ready --label slack-thread/)
    f.respond('issue_view', { state: 'CLOSED', labels: [], title: '題' })
    assert.deepEqual(syncIssues(s, f.config().sources).dropped.sort(), ['acme/app#7', 'other/api#7'])
  } finally {
    f.cleanup()
  }
})
test('AU20 unreadable list/view preserves tracked state', () => {
  const f = fixture()
  try {
    f.respond('issue_list', [{ number: 7, title: '題', labels: [], updatedAt: '2026-01-01' }])
    const s = empty()
    syncIssues(s, f.config().sources)
    const before = JSON.stringify(s)
    f.put(`${f.gh}/issue_list.rc`, 1)
    f.put(`${f.gh}/issue_view.rc`, 1)
    syncIssues(s, f.config().sources)
    assert.equal(JSON.stringify(s), before)
  } finally {
    f.cleanup()
  }
})
test('AU21/AU22b-f generation preserves continuation and waits for cleanup', () => {
  const f = fixture()
  try {
    const s = empty()
    f.respond('issue_list', [{ number: 7, title: '題', labels: [], updatedAt: '2026-01-01' }])
    const source = f.config().sources[0]
    assert.ok(source)
    syncIssues(s, [source])
    const issue = s.issues['acme/app#7']
    assert.ok(issue)
    issue.phase = 'eng'
    issue.branch = 'auto/old'
    issue.endedAt = '2026-01-01'
    issue.cleanupPending = true
    syncIssues(s, [source])
    assert.equal(issue.generation, 1)
    issue.cleanupPending = false
    syncIssues(s, [source])
    assert.equal(issue.generation, 2)
    assert.equal(issue.returnedFromEng, true)
    assert.equal(issue.prevBranch, 'auto/old')
    assert.equal(issue.branch, '')
    f.respond('issue_list', [])
    f.respond('issue_view', { state: 'OPEN', labels: [{ name: 'Pending' }], title: '題' })
    syncIssues(s, [source])
    assert.equal(issue.phase, 'stopped')
    assert.equal(issue.generation, 2)
    issue.phase = 'dispatching'
    assert.deepEqual(syncIssues(s, f.config().sources).humanChanged, [issue.key])
    issue.phase = 'finishing'
    assert.deepEqual(syncIssues(s, f.config().sources).humanChanged, [issue.key])
    issue.pendingLabel = {
      event: 'started',
      from: 'Ready',
      to: 'In progress',
      close: false,
      body: 'saved',
      commented: true,
      labeled: false,
      // biome-ignore lint/suspicious/noThenProperty: persisted transition target, never a promise.
      then: 'running',
    }
    assert.deepEqual(syncIssues(s, f.config().sources).humanChanged, [])
  } finally {
    f.cleanup()
  }
})

test('AU22e/AU22f/AU22g stopped generations retain history and cleanup tombstones cannot disappear', () => {
  const f = fixture()
  try {
    const s = empty()
    const source = f.config().sources[0]
    assert.ok(source)
    const row = { number: 7, title: '題', labels: [], updatedAt: '2026-01-01' }
    f.respond('issue_list', [row])
    syncIssues(s, [source])
    const i = s.issues['acme/app#7']
    assert.ok(i)
    i.phase = 'queued'
    i.generation = 2
    i.prevBranch = 'user/old'
    f.respond('issue_list', [])
    f.respond('issue_view', { state: 'OPEN', title: '題', labels: [{ name: 'Pending' }] })
    syncIssues(s, [source])
    assert.equal(i.phase, 'stopped')
    assert.equal(i.prevBranch, 'user/old')
    f.respond('issue_list', [row])
    f.respond('issue_view', { state: 'OPEN', title: '題', labels: [{ name: 'Ready' }] })
    syncIssues(s, [source])
    assert.equal(i.generation, 3)
    i.phase = 'failed'
    i.cleanupPending = true
    i.endedAt = '2026-01-01'
    syncIssues(s, [source])
    assert.equal(i.generation, 3)
    f.respond('issue_list', [])
    f.respond('issue_view', { state: 'CLOSED', title: '題', labels: [] })
    syncIssues(s, [source])
    assert.ok(s.issues[i.key])
    i.cleanupPending = false
    syncIssues(s, [source])
    assert.equal(s.issues[i.key], undefined)
  } finally {
    f.cleanup()
  }
})

test('AU104b generations preserve repository identity even after partial starts and engineering-only generations', () => {
  const f = fixture()
  try {
    const source = f.config().sources[0]
    assert.ok(source)
    const cases = [
      {
        targets: ['other/api', 'acme/app'],
        branch: 'user/a',
        branches: { 'other/api': 'user/a', 'acme/app': 'user/b' },
        prevTargets: [],
        prevBranches: {},
        wantTargets: ['other/api', 'acme/app'],
        want: { 'other/api': 'user/a', 'acme/app': 'user/b' },
      },
      {
        targets: ['acme/app'],
        branch: 'user/one',
        branches: {},
        prevTargets: [],
        prevBranches: {},
        wantTargets: ['acme/app'],
        want: { 'acme/app': 'user/one' },
      },
      {
        targets: ['acme/app'],
        branch: '',
        branches: {},
        prevTargets: ['other/api', 'acme/app'],
        prevBranches: { 'other/api': 'user/partial' },
        wantTargets: ['other/api', 'acme/app'],
        want: { 'other/api': 'user/partial' },
      },
    ]
    for (const c of cases) {
      const s = empty()
      f.respond('issue_list', [{ number: 7, title: '題', labels: [], updatedAt: '2026-01-01' }])
      syncIssues(s, [source])
      const issue = s.issues['acme/app#7']
      assert.ok(issue)
      Object.assign(issue, c, { phase: 'eng' })
      syncIssues(s, [source])
      assert.equal(issue.generation, 2)
      assert.deepEqual(issue.prevTargets, c.wantTargets)
      assert.deepEqual(issue.prevBranches, c.want)
      assert.deepEqual(issue.branches, {})
    }
  } finally {
    f.cleanup()
  }
})
