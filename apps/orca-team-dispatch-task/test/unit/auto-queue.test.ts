import { AUTO_ISSUE_LIST_LIMIT, listReadyManaged, listUnlabeledThread } from '../../lib/auto-github.ts'
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
test('AU187 lists are read up to the limit and a full list says so; listUnlabeledThread drops status-labelled rows', () => {
  const f = fixture()
  try {
    const row = (number: number, labels: string[]) => ({
      number,
      title: `題${number}`,
      labels: labels.map((name) => ({ name })),
      updatedAt: '2026-01-01',
      createdAt: '2026-01-01',
    })
    f.respond(
      'issue_list',
      Array.from({ length: AUTO_ISSUE_LIST_LIMIT }, (_, i) => row(i + 1, [])),
    )
    const lines: string[] = []
    assert.equal(listReadyManaged('acme/app', 'Ready', (line) => lines.push(line))?.length, AUTO_ISSUE_LIST_LIMIT)
    assert.match(f.calls(), new RegExp(`--limit ${AUTO_ISSUE_LIST_LIMIT}\\b`))
    assert.equal(AUTO_ISSUE_LIST_LIMIT, 1000)
    // 印ごとの一覧が 2 つあり、どちらも上限ちょうどなので 2 行。どの印の一覧かが行ごとに分かる
    assert.deepEqual(lines, [
      `acme/app の Ready と from-slack の Issue が ${AUTO_ISSUE_LIST_LIMIT} 件を超えているかもしれません。超えた分は拾いません`,
      `acme/app の Ready と slack-thread の Issue が ${AUTO_ISSUE_LIST_LIMIT} 件を超えているかもしれません。超えた分は拾いません`,
    ])
    f.respond('issue_list', [row(1, ['slack-thread']), row(2, ['Ready', 'slack-thread'])])
    const short: string[] = []
    assert.deepEqual(
      listUnlabeledThread('acme/app', (line) => short.push(line))?.map((i) => i.number),
      [1],
    )
    assert.deepEqual(short, [])
    assert.match(f.calls(), /--label slack-thread/)
    // スタブは引数をシェルの形に直して書くので、引用符の前に \ が付く
    assert.match(f.calls(), /-label:\\"Backlog\\"/)
    assert.match(f.calls(), /-label:\\"Ready\\"/)
    f.put(`${f.gh}/issue_list.rc`, 1)
    assert.equal(listUnlabeledThread('acme/app'), null)
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

test('AU138b a new generation clears relay allowance and previous review points', () => {
  const f = fixture()
  try {
    const state = empty()
    const source = f.config().sources[0]
    assert.ok(source)
    f.respond('issue_list', [{ number: 7, title: '題', labels: [], updatedAt: '2026-01-01' }])
    syncIssues(state, [source])
    const issue = state.issues['acme/app#7']
    assert.ok(issue)
    Object.assign(issue, { phase: 'review', relayMinutes: 125, reviewPoints: ['前の確認'], decisions: ['前の記録'] })
    syncIssues(state, [source])
    assert.equal(issue.generation, 2)
    assert.equal(issue.relayMinutes, 0)
    assert.deepEqual(issue.reviewPoints, [])
    assert.deepEqual(issue.decisions, [])
  } finally {
    f.cleanup()
  }
})

test('AU147 an asked issue waits in Backlog, rejoins judging from Ready, and stops on any other change', () => {
  const f = fixture()
  try {
    const s = empty()
    const source = f.config().sources[0]
    assert.ok(source)
    f.respond('issue_list', [{ number: 7, title: '題', labels: [], updatedAt: '2026-01-01' }])
    syncIssues(s, [source])
    f.respond('issue_list', [])
    const issue = s.issues['acme/app#7']
    assert.ok(issue)
    Object.assign(issue, { baseAsked: true, targets: ['acme/app'] })
    const view = (labels: string[], state = 'OPEN') =>
      f.respond('issue_view', { state, title: '題', labels: labels.map((name) => ({ name })) })
    view(['Backlog', 'base:main'])
    assert.deepEqual(syncIssues(s, [source]).asked, { 'acme/app#7': ['Backlog', 'base:main'] })
    assert.equal(issue.phase, 'judging')
    view(['Ready'])
    assert.deepEqual(syncIssues(s, [source]).asked, {})
    assert.equal(issue.phase, 'judging')
    assert.equal(issue.autoReady, false)
    view(['Pending'])
    syncIssues(s, [source])
    assert.equal(issue.phase, 'stopped')
    Object.assign(issue, { phase: 'judging' })
    view(['Backlog'], 'CLOSED')
    assert.deepEqual(syncIssues(s, [source]).dropped, ['acme/app#7'])
    assert.equal(s.issues['acme/app#7'], undefined)
  } finally {
    f.cleanup()
  }
})

test('AU171 a new generation keeps the previous generation bases only when it had branches', () => {
  const f = fixture()
  try {
    const s = empty()
    f.respond('issue_list', [{ number: 7, title: '題', labels: [], updatedAt: '2026-01-01' }])
    const source = f.config().sources[0]
    assert.ok(source)
    syncIssues(s, [source])
    const issue = s.issues['acme/app#7']
    assert.ok(issue)
    assert.deepEqual(issue.prevBases, {})
    Object.assign(issue, {
      phase: 'review',
      branch: 'auto/old',
      targets: ['acme/app'],
      bases: { 'acme/app': 'develop' },
    })
    syncIssues(s, [source])
    assert.equal(issue.generation, 2)
    assert.deepEqual(issue.prevBases, { 'acme/app': 'develop' })
    assert.deepEqual(issue.bases, {})
    // 枝を持たずに終わった世代（判定だけで止まったもの）は前の記録を消さない
    Object.assign(issue, { phase: 'stopped', branch: '', bases: { 'acme/app': 'main' } })
    syncIssues(s, [source])
    assert.equal(issue.generation, 3)
    assert.deepEqual(issue.prevBases, { 'acme/app': 'develop' })
  } finally {
    f.cleanup()
  }
})

test('AU196 a merged issue returned from Testing to Ready starts a new generation from its base, not from the merged branch', () => {
  const f = fixture()
  try {
    const s = empty()
    f.respond('issue_list', [{ number: 7, title: '題', labels: [], updatedAt: '2026-01-01' }])
    const source = f.config().sources[0]
    assert.ok(source)
    syncIssues(s, [source])
    const issue = s.issues['acme/app#7']
    assert.ok(issue)
    const merged = { repo: 'acme/app', number: 101, url: 'https://github.com/acme/app/pull/101' }
    Object.assign(issue, {
      phase: 'done',
      targets: ['acme/app'],
      branch: 'auto/merged',
      branches: { 'acme/app': 'auto/merged' },
      bases: { 'acme/app': 'main' },
      prs: [merged],
      prevBranch: 'auto/older',
      prevBranches: { 'acme/app': 'auto/older' },
      prevTargets: ['acme/app'],
      endedAt: '2026-01-02',
    })
    syncIssues(s, [source])
    assert.equal(issue.generation, 2)
    assert.equal(issue.phase, 'judging')
    // merge 済みの枝から続けると、squash merge のあとで同じ変更をもう一度出してしまう
    assert.equal(issue.prevBranch, '')
    assert.deepEqual(issue.prevBranches, {})
    assert.deepEqual(issue.prevTargets, [])
    assert.deepEqual(issue.prevBases, {})
    // 動作確認で見つかったことは、merge した PR と Issue のコメントから続きの材料として読む
    assert.deepEqual(issue.prevPrs, [merged])
  } finally {
    f.cleanup()
  }
})
