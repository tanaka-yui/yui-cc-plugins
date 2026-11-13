import { readState, writeState } from '../../lib/auto-state.ts'
import { runtimeFixture } from '../lib/auto-runtime-fixture.ts'

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const pr = { repo: 'acme/app', number: 101, url: 'https://github.com/acme/app/pull/101' }
const check = (status = 'COMPLETED', conclusion = 'SUCCESS') => ({
  __typename: 'CheckRun',
  name: 'ci',
  status,
  conclusion,
})
test('AU50 auto merges, then comments, labels and closes; PR helper never receives --issue', () => {
  const f = runtimeFixture()
  try {
    const i = f.track('finishing')
    f.result(i)
    const r = f.cli('tick')
    assert.equal(r.status, 1, r.stderr)
    assert.equal(readState('main').issues[i.key]?.phase, 'done')
    const c = f.calls()
    assert.ok(c.includes('pr merge 101 --repo acme/app --squash'))
    assert.ok(c.indexOf('pr merge') < c.indexOf('issue comment'))
    assert.ok(c.indexOf('issue comment') < c.indexOf('issue edit'))
    assert.ok(c.indexOf('issue edit') < c.indexOf('issue close'))
    assert.ok(f.childCalls().includes('orca-pr.ts'))
    assert.ok(!f.childCalls().includes('"--issue"'))
  } finally {
    f.cleanup()
  }
})
for (const [id, extra, repo, checks] of [
  ['AU51', { decisions: ['422 にした'] }, {}, [check()]],
  ['AU52', {}, {}, [check('COMPLETED', 'FAILURE')]],
  ['AU54', {}, { infra: true }, [check()]],
  ['AU55', null, {}, [check()]],
  ['unverified', {}, { verified: false }, [check()]],
  ['verify failure', { verify: { passed: false, ran: ['node --test'] } }, {}, [check()]],
  ['review findings', { review: { unresolved: ['未解消'], declined: ['不採用'] } }, {}, [check()]],
] as const)
  test(`${id} routes uncertain work to review`, () => {
    const f = runtimeFixture()
    try {
      const i = f.track('finishing')
      if (extra !== null) f.result(i, extra)
      f.put(f.configFile, { ...f.raw, repos: { ...f.raw.repos, 'acme/app': { ...f.raw.repos['acme/app'], ...repo } } })
      f.respond('pr_view', { ...pr, state: 'OPEN', mergedAt: null, statusCheckRollup: [...checks] })
      f.cli('tick')
      assert.equal(readState('main').issues[i.key]?.phase, 'review')
      assert.ok(!f.calls().includes('pr merge'))
      assert.ok(f.calls().includes('orca-auto:in-review:1:needs-review'))
    } finally {
      f.cleanup()
    }
  })
test('AU52/AU53 pending CI and expected but absent CI wait; missing CI eventually requests review', () => {
  const f = runtimeFixture()
  try {
    const i = f.track('finishing')
    f.result(i)
    f.respond('pr_view', { ...pr, state: 'OPEN', mergedAt: null, statusCheckRollup: [check('IN_PROGRESS', '')] })
    f.cli('tick')
    assert.equal(readState('main').issues[i.key]?.phase, 'finishing')
    assert.ok(!f.calls().includes('issue comment'))
    f.respond('pr_view', { ...pr, state: 'OPEN', mergedAt: null, statusCheckRollup: [] })
    f.cli('tick')
    assert.equal(readState('main').issues[i.key]?.phase, 'finishing')
    process.env.ORCA_AUTO_NOW = '2026-11-13T06:01:00Z'
    f.cli('tick')
    assert.equal(readState('main').issues[i.key]?.phase, 'review')
  } finally {
    f.cleanup()
  }
})
test('AU53 no-CI repository merges; AU56 merge method falls back to merge commit', () => {
  const f = runtimeFixture()
  try {
    const i = f.track('finishing')
    f.result(i)
    f.put(f.configFile, { ...f.raw, repos: { ...f.raw.repos, 'acme/app': { ...f.raw.repos['acme/app'], ci: false } } })
    f.respond('pr_view', { ...pr, state: 'OPEN', mergedAt: null, statusCheckRollup: [] })
    f.respond('repo_view', { squashMergeAllowed: false, mergeCommitAllowed: true, rebaseMergeAllowed: true })
    f.cli('tick')
    assert.equal(readState('main').issues[i.key]?.phase, 'done')
    assert.ok(f.calls().includes('--merge'))
  } finally {
    f.cleanup()
  }
})
test('AU50b already merged PR is completed without another merge command', () => {
  const f = runtimeFixture()
  try {
    const i = f.track('finishing')
    f.result(i)
    f.respond('pr_view', { ...pr, state: 'MERGED', mergedAt: '2026-11-13T05:00:00Z', statusCheckRollup: [] })
    f.cli('tick')
    assert.equal(readState('main').issues[i.key]?.phase, 'done')
    assert.ok(!f.calls().includes('pr merge'))
  } finally {
    f.cleanup()
  }
})
test('AU51b StatusContext pending and failure are recognized; failure outranks pending', () => {
  const f = runtimeFixture()
  try {
    const i = f.track('finishing')
    f.result(i)
    f.respond('pr_view', {
      ...pr,
      state: 'OPEN',
      mergedAt: null,
      statusCheckRollup: [{ __typename: 'StatusContext', context: 'build', state: 'PENDING' }],
    })
    f.cli('tick')
    assert.equal(readState('main').issues[i.key]?.phase, 'finishing')
    f.respond('pr_view', {
      ...pr,
      state: 'OPEN',
      mergedAt: null,
      statusCheckRollup: [
        check('IN_PROGRESS', ''),
        { __typename: 'StatusContext', context: 'build', state: 'FAILURE' },
      ],
    })
    f.cli('tick')
    assert.equal(readState('main').issues[i.key]?.phase, 'review')
  } finally {
    f.cleanup()
  }
})
test('AU55b PR creation retries, then reports integration-result reason after 30 minutes', () => {
  const f = runtimeFixture()
  try {
    const i = f.track('finishing')
    f.result(i)
    f.childRc('orca-pr', 1)
    f.put(join(i.statusDir, 'integration-result.json'), { reason: '変更コミットがありません' })
    f.cli('tick')
    assert.equal(readState('main').issues[i.key]?.phase, 'finishing')
    process.env.ORCA_AUTO_NOW = '2026-11-13T06:01:00Z'
    f.cli('tick')
    assert.equal(readState('main').issues[i.key]?.phase, 'review')
  } finally {
    f.cleanup()
  }
})
test('AU57 human merge of the current generation PR closes the issue', () => {
  const f = runtimeFixture()
  try {
    const i = f.track('review')
    const s = readState('main')
    const current = s.issues[i.key]
    assert.ok(current)
    current.prs = [pr]
    writeState('main', s)
    f.respond('issue_view', { state: 'OPEN', title: '題', labels: [{ name: 'In review' }] })
    f.respond('pr_view', { state: 'MERGED', mergedAt: '2026-11-13T05:00:00Z', statusCheckRollup: [] })
    f.cli('tick')
    assert.equal(readState('main').issues[i.key]?.phase, 'done')
    assert.ok(f.calls().includes('orca-auto:done:1:human-merged'))
  } finally {
    f.cleanup()
  }
})
test('AU57b review respects human close and status changes without comments', () => {
  for (const closed of [true, false]) {
    const f = runtimeFixture()
    try {
      const i = f.track('review')
      f.respond('issue_view', { state: closed ? 'CLOSED' : 'OPEN', title: '題', labels: [{ name: 'Pending' }] })
      f.cli('tick')
      assert.equal(readState('main').issues[i.key]?.phase, closed ? undefined : 'stopped')
      assert.ok(!f.calls().includes('issue comment'))
    } finally {
      f.cleanup()
    }
  }
})

test('a human label change immediately after merge never resurrects the merged branch', () => {
  const f = runtimeFixture()
  try {
    const issue = f.track('finishing')
    f.result(issue)
    f.git('-C', f.checkout, 'checkout', issue.branch)
    writeFileSync(join(f.checkout, 'merged-change'), 'x')
    f.git('-C', f.checkout, 'add', 'merged-change')
    f.git('-C', f.checkout, 'commit', '-m', 'merged change')
    f.git('-C', f.checkout, 'checkout', 'main')
    f.hook(
      'pr_merge',
      `printf '%s' '${JSON.stringify({ state: 'OPEN', title: '題', labels: [{ name: 'Pending' }] })}' > '${f.gh}/issue_view'\nprintf '%s' '${JSON.stringify({ ...pr, state: 'MERGED', mergedAt: '2026-11-13T05:30:00Z', statusCheckRollup: [] })}' > '${f.gh}/pr_view'`,
    )
    f.cli('tick')
    assert.equal(readState('main').issues[issue.key]?.phase, 'stopped')
    assert.equal(f.git('--git-dir', join(f.dir, 'origin.git'), 'branch', '--list', issue.branch), '')
  } finally {
    f.cleanup()
  }
})
