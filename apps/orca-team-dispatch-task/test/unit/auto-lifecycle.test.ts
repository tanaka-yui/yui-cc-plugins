import { autoDir } from '../../lib/auto-paths.ts'
import { slugOf } from '../../lib/auto-request.ts'
import { readState, writeState } from '../../lib/auto-state.ts'
import { runtimeFixture } from '../lib/auto-runtime-fixture.ts'

import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const count = (text: string, needle: string) => text.split(needle).length - 1
const bodies = (dir: string): string[] => {
  try {
    return readFileSync(join(dir, 'comments.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string)
  } catch {
    return []
  }
}
test('AU59c failed label edit retries only the label, without another started comment', () => {
  const f = runtimeFixture()
  try {
    const i = f.track()
    f.put(join(f.gh, 'issue_edit.rc'), 1)
    f.cli('tick')
    assert.equal(readState('main').issues[i.key]?.pendingLabel?.commented, true)
    rmSync(join(f.gh, 'issue_edit.rc'))
    f.cli('tick')
    assert.equal(readState('main').issues[i.key]?.phase, 'running')
    assert.equal(count(f.calls(), 'issue comment '), 1)
    assert.equal(count(f.childCalls(), 'orca-start.ts '), 1)
  } finally {
    f.cleanup()
  }
})
test('AU59d/AU59j human change cancels pending started transition and stops all roles', () => {
  const f = runtimeFixture()
  try {
    const i = f.track()
    f.put(join(f.gh, 'issue_edit.rc'), 1)
    f.cli('tick')
    const before = f.calls()
    f.respond('issue_view', { state: 'OPEN', title: '題', labels: [{ name: 'Pending' }] })
    f.cli('tick')
    const current = readState('main').issues[i.key]
    assert.equal(current?.phase, 'stopped')
    assert.equal(current?.pendingLabel, null)
    assert.ok(f.childCalls().includes('orca-stop.ts'))
    assert.ok(!f.calls().slice(before.length).includes('issue edit'))
  } finally {
    f.cleanup()
  }
})
test('AU59f detects a previously posted final-line marker after a crash', () => {
  const f = runtimeFixture()
  try {
    const i = f.track()
    f.put(join(f.gh, 'issue_edit.rc'), 1)
    f.cli('tick')
    const s = readState('main')
    const issue = s.issues[i.key]
    assert.ok(issue?.pendingLabel)
    issue.pendingLabel.commented = false
    f.respond('api', [{ body: issue.pendingLabel.body }])
    writeState('main', s)
    rmSync(join(f.gh, 'issue_edit.rc'))
    f.cli('tick')
    assert.equal(count(f.calls(), 'issue comment '), 1)
    assert.equal(readState('main').issues[i.key]?.phase, 'running')
  } finally {
    f.cleanup()
  }
})
test('AU59h/AU59g retries the exact saved comment body and holds all work while pending', () => {
  const f = runtimeFixture()
  try {
    const i = f.track()
    f.put(join(f.gh, 'issue_comment.rc'), 1)
    f.cli('tick')
    const first = readState('main').issues[i.key]?.pendingLabel?.body
    assert.ok(first)
    f.cli('tick')
    assert.equal(count(f.childCalls(), 'orca-start.ts '), 1)
    assert.ok(!f.childCalls().includes('orca-wait.ts'))
    rmSync(join(f.gh, 'issue_comment.rc'))
    process.env.ORCA_AUTO_NOW = '2026-11-13T05:35:00Z'
    f.cli('tick')
    assert.deepEqual(bodies(f.dir), [first, first, first])
  } finally {
    f.cleanup()
  }
})
test('AU59i started comment failure never suppresses the time limit', () => {
  const f = runtimeFixture()
  try {
    const i = f.track()
    f.put(join(f.gh, 'issue_comment.rc'), 1)
    f.cli('tick')
    process.env.ORCA_AUTO_NOW = '2026-11-13T06:31:00Z'
    f.cli('tick')
    const current = readState('main').issues[i.key]
    assert.ok(current?.failReason?.includes('上限時間'))
    assert.ok(f.childCalls().includes('orca-stop.ts'))
    assert.notEqual(current?.pendingLabel?.event, 'started')
  } finally {
    f.cleanup()
  }
})
test('AU59e close retries without label/comment repetition, and yields to a restored human label', () => {
  for (const changed of [false, true]) {
    const f = runtimeFixture()
    try {
      const i = f.track('finishing')
      f.result(i)
      f.put(join(f.gh, 'issue_close.rc'), 1)
      f.cli('tick')
      assert.equal(readState('main').issues[i.key]?.pendingLabel?.labeled, true)
      const previous = f.calls()
      rmSync(join(f.gh, 'issue_close.rc'))
      if (changed) f.respond('issue_view', { state: 'OPEN', title: '題', labels: [{ name: 'In progress' }] })
      f.cli('tick')
      const calls = f.calls().slice(previous.length)
      assert.ok(!calls.includes('issue comment'))
      assert.ok(!calls.includes('issue edit'))
      assert.equal(calls.includes('issue close'), !changed)
      assert.equal(readState('main').issues[i.key]?.phase, changed ? 'stopped' : 'done')
    } finally {
      f.cleanup()
    }
  }
})
test('AU59k/AU58g failed cleanup never repeats failed notification or starts a new generation early', () => {
  const f = runtimeFixture()
  try {
    const i = f.track('running')
    f.respond(
      'worktree_list',
      {
        ok: true,
        result: { worktrees: [{ displayName: i.slug, path: join(f.children, 'worktree') }], truncated: false },
      },
      f.orca,
    )
    f.put(join(f.orca, 'worktree_rm.rc'), 1)
    process.env.ORCA_AUTO_NOW = '2026-11-13T06:01:00Z'
    f.cli('tick')
    assert.equal(readState('main').issues[i.key]?.phase, 'failed')
    const previous = f.calls()
    f.respond('issue_list', [
      { number: 7, title: '題', labels: [{ name: 'Ready' }], updatedAt: '2026-11-13T06:02:00Z' },
    ])
    f.respond('issue_view', { state: 'OPEN', title: '題', body: '本文', labels: [{ name: 'Ready' }] })
    f.cli('tick')
    assert.equal(readState('main').issues[i.key]?.generation, 1)
    assert.ok(!f.calls().slice(previous.length).includes('issue edit'))
    assert.ok(!f.calls().slice(previous.length).includes('issue comment'))
    rmSync(join(f.orca, 'worktree_rm.rc'))
    f.cli('tick')
    assert.equal(readState('main').issues[i.key]?.generation, 1)
    assert.equal(readState('main').issues[i.key]?.cleanupPending, false)
    assert.ok(existsSync(join(autoDir('main'), 'archive', `${i.slug}-g1`)))
    f.cli('tick')
    assert.equal(readState('main').issues[i.key]?.generation, 2)
    assert.equal(readState('main').issues[i.key]?.phase, 'judging')
  } finally {
    f.cleanup()
  }
})
test('AU59b failed push is stated truthfully and preserves resources', () => {
  const f = runtimeFixture()
  try {
    const i = f.track('running')
    f.git('-C', f.checkout, 'checkout', i.branch)
    writeFileSync(join(f.checkout, 'last'), 'x')
    f.git('-C', f.checkout, 'add', 'last')
    f.git('-C', f.checkout, 'commit', '-m', 'last')
    f.git('-C', f.checkout, 'checkout', 'main')
    f.git('-C', f.checkout, 'remote', 'set-url', '--push', 'origin', join(f.dir, 'missing'))
    process.env.ORCA_AUTO_NOW = '2026-11-13T06:01:00Z'
    f.cli('tick')
    assert.equal(readState('main').issues[i.key]?.phase, 'failed')
    assert.ok(bodies(f.dir).some((body) => body.includes('push できていません')))
    assert.ok(existsSync(i.statusDir))
    assert.ok(!f.calls(f.orca).includes('worktree rm'))
  } finally {
    f.cleanup()
  }
})
test('AU39 three failed starts finish with a Failed comment and label', () => {
  const f = runtimeFixture()
  try {
    const i = f.track()
    f.childRc('orca-start', 1)
    for (let n = 0; n < 3; n++) f.cli('tick')
    assert.equal(readState('main').issues[i.key]?.phase, 'failed')
    assert.ok(bodies(f.dir).some((b) => b.includes('起動できませんでした（3 回）')))
    assert.ok(f.calls().indexOf('issue comment') < f.calls().indexOf('issue edit'))
  } finally {
    f.cleanup()
  }
})
test('AU59l a human status change while stop is unconfirmed cancels failure notification', () => {
  const f = runtimeFixture()
  try {
    const i = f.track('running')
    f.respond(
      'orchestration_worker-list',
      { ok: true, result: { workers: [{ dispatchId: 'ctx_design', resource: { releaseState: 'retained' } }] } },
      f.orca,
    )
    f.respond('orchestration_worker-show', { ok: true, result: { worker: { state: 'active' } } }, f.orca)
    f.put(join(f.orca, 'orchestration_worker-stop.rc'), 1)
    process.env.ORCA_AUTO_NOW = '2026-11-13T06:01:00Z'
    f.cli('tick')
    assert.ok(readState('main').issues[i.key]?.failReason)
    assert.ok(!f.calls().includes('issue comment'))
    f.respond('issue_view', { state: 'OPEN', title: '題', labels: [{ name: 'Pending' }] })
    f.cli('tick')
    const current = readState('main').issues[i.key]
    assert.equal(current?.phase, 'stopped')
    assert.equal(current?.failReason, null)
    assert.equal(current?.cleanupPending, true)
    assert.ok(!f.calls().includes('issue comment'))
    assert.ok(!f.calls().includes('issue edit'))
  } finally {
    f.cleanup()
  }
})
test('AU59m a human restoration after a persisted failed label cancels failure permanently', () => {
  const f = runtimeFixture()
  try {
    const i = f.track('running')
    f.respond(
      'worktree_list',
      {
        ok: true,
        result: { worktrees: [{ displayName: i.slug, path: join(f.children, 'worktree') }], truncated: false },
      },
      f.orca,
    )
    f.put(join(f.orca, 'worktree_rm.rc'), 1)
    process.env.ORCA_AUTO_NOW = '2026-11-13T06:01:00Z'
    f.cli('tick')
    const s = readState('main')
    const current = s.issues[i.key]
    assert.ok(current)
    const then = 'failed' as const
    current.pendingLabel = {
      event: 'failed',
      from: 'In progress',
      to: 'Failed',
      close: false,
      body: bodies(f.dir)[0] ?? 'body',
      commented: true,
      labeled: true,
      then,
    }
    current.failReason = '上限時間'
    writeState('main', s)
    f.respond('issue_view', { state: 'OPEN', title: '題', labels: [{ name: 'In progress' }] })
    const previous = f.calls()
    f.cli('tick')
    f.cli('tick')
    assert.equal(readState('main').issues[i.key]?.failReason, null)
    assert.equal(readState('main').issues[i.key]?.phase, 'stopped')
    assert.ok(!f.calls().slice(previous.length).includes('issue comment'))
    assert.ok(!f.calls().slice(previous.length).includes('issue edit'))
  } finally {
    f.cleanup()
  }
})
test('AU58e2 live user-owned cleanup reserves the old generation even if Ready is restored', () => {
  const f = runtimeFixture()
  try {
    const i = f.track('failed')
    const s = readState('main')
    const current = s.issues[i.key]
    assert.ok(current)
    current.cleanupPending = true
    writeState('main', s)
    f.respond(
      'orchestration_worker-list',
      {
        ok: true,
        result: {
          workers: [{ dispatchId: 'ctx_design', resource: { releaseState: 'retained', ownershipState: 'user_owned' } }],
        },
      },
      f.orca,
    )
    f.respond('orchestration_worker-show', { ok: true, result: { worker: { state: 'active' } } }, f.orca)
    f.respond('issue_list', [
      { number: 7, title: '題', labels: [{ name: 'Ready' }], updatedAt: '2026-11-13T05:30:00Z' },
    ])
    f.respond('issue_view', { state: 'OPEN', title: '題', body: '本文', labels: [{ name: 'Ready' }] })
    f.cli('tick')
    assert.equal(readState('main').issues[i.key]?.generation, 1)
    assert.equal(readState('main').issues[i.key]?.cleanupPending, true)
    assert.ok(!f.childCalls().includes('orca-start.ts'))
    assert.ok(!f.calls(f.orca).includes('worktree rm'))
    assert.ok(existsSync(i.statusDir))
  } finally {
    f.cleanup()
  }
})

test('AU59 worker environment failure is included in the failed comment before cleanup', () => {
  const f = runtimeFixture()
  try {
    const issue = f.track('running')
    f.result(issue, { envFailure: '道具が足りません' })
    f.childRc('orca-wait', 5)
    f.cli('tick')
    assert.equal(readState('main').issues[issue.key]?.phase, 'failed')
    assert.ok(bodies(f.dir).some((body) => body.includes('環境が原因: 道具が足りません')))
  } finally {
    f.cleanup()
  }
})

test('AU39b a returned failed start with workers remains dispatching and safely resumes next tick', () => {
  const f = runtimeFixture()
  try {
    const issue = f.track()
    const slug = slugOf(issue.key)
    const sd = join(f.checkout, '.dispatch', slug)
    const workers = {
      run_id: 'run_1',
      integration_branch: 'main',
      integration_role: 'design',
      roles: { design: { branch: `user/${slug}` } },
    }
    const run = { run_id: 'run_1', parent_handle: 'term_auto', repo_root: f.checkout }
    writeFileSync(
      join(f.children, 'orca-start.ts.sh'),
      `mkdir -p '${sd}'\nprintf '%s' '${JSON.stringify(workers)}' > '${sd}/workers.json'\nprintf '%s' '${JSON.stringify(run)}' > '${sd}/run.json'\n`,
    )
    f.respond('orchestration_worker-list', { ok: true, result: { workers: [] } }, f.orca)
    f.childRc('orca-start', 1)
    f.cli('tick')
    assert.equal(readState('main').issues[issue.key]?.phase, 'dispatching')
    f.childRc('orca-start', 0)
    f.cli('tick')
    assert.equal(readState('main').issues[issue.key]?.phase, 'running')
    assert.ok(f.childCalls().includes('"--resume"'))
  } finally {
    f.cleanup()
  }
})
test('AU58g failed push cleanup finishes before a restored Ready can begin another generation', () => {
  const f = runtimeFixture()
  try {
    const issue = f.track('running')
    f.git('-C', f.checkout, 'checkout', issue.branch)
    writeFileSync(join(f.checkout, 'last-push'), 'x')
    f.git('-C', f.checkout, 'add', 'last-push')
    f.git('-C', f.checkout, 'commit', '-m', 'last push')
    f.git('-C', f.checkout, 'checkout', 'main')
    f.git('-C', f.checkout, 'remote', 'set-url', '--push', 'origin', join(f.dir, 'missing'))
    process.env.ORCA_AUTO_NOW = '2026-11-13T06:01:00Z'
    f.cli('tick')
    assert.equal(readState('main').issues[issue.key]?.phase, 'failed')
    f.respond('issue_list', [
      { number: 7, title: '題', labels: [{ name: 'Ready' }], updatedAt: '2026-11-13T06:01:00Z' },
    ])
    f.respond('issue_view', { state: 'OPEN', title: '題', body: '本文', labels: [{ name: 'Ready' }] })
    f.cli('tick')
    assert.equal(readState('main').issues[issue.key]?.generation, 1)
    f.git('-C', f.checkout, 'remote', 'set-url', '--push', 'origin', join(f.dir, 'origin.git'))
    f.cli('tick')
    assert.equal(readState('main').issues[issue.key]?.cleanupPending, false)
    assert.equal(readState('main').issues[issue.key]?.generation, 1)
    f.cli('tick')
    assert.equal(readState('main').issues[issue.key]?.generation, 2)
  } finally {
    f.cleanup()
  }
})
