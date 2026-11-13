import { readState } from '../../lib/auto-state.ts'
import { runtimeFixture } from '../lib/auto-runtime-fixture.ts'

import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

test('AU40/AU41 each running issue advances independently from its wait exit code', () => {
  const f = runtimeFixture()
  try {
    const a = f.track('running', 7)
    const b = f.track('running', 8)
    writeFileSync(
      join(f.children, 'orca-wait.ts.sh'),
      `case "$2" in *${a.slug}) echo 0 > '${f.children}/orca-wait.ts.rc';; *) echo 4 > '${f.children}/orca-wait.ts.rc';; esac`,
    )
    f.cli('tick')
    const s = readState('main')
    assert.equal(s.issues[a.key]?.phase, 'finishing')
    assert.equal(s.issues[b.key]?.phase, 'running')
    assert.equal(f.childCalls().split('orca-wait.ts ').length - 1, 2)
    assert.ok(f.childCalls().includes('"--max-waits","1"'))
  } finally {
    f.cleanup()
  }
})
test('AU42/AU42b/AU47 phase exec uses the coordinator and refreshes the integration branch', () => {
  const f = runtimeFixture()
  try {
    const i = f.track('running')
    const file = join(i.statusDir, 'workers.json')
    const w = JSON.parse(readFileSync(file, 'utf8'))
    w.integration_role = 'exec'
    w.roles.exec = {}
    f.put(file, w)
    f.childRc('orca-wait', 9)
    f.cli('tick')
    assert.ok(f.childCalls().includes('"--phase","exec"'))
    assert.ok(f.childCalls().includes('ORCA_TERMINAL_HANDLE=term_auto'))
    assert.equal(readState('main').issues[i.key]?.branch, `user/${i.slug}-exec`)
    assert.ok(f.childCalls().includes('"--on-stall","ask"'))
    assert.ok(f.childCalls().includes('ORCA_WAITER_RETRY_TRIES=0'))
  } finally {
    f.cleanup()
  }
})
test('AU43 stall notification is emitted once per generation', () => {
  const f = runtimeFixture()
  try {
    const i = f.track('running')
    f.childRc('orca-wait', 8)
    f.cli('tick')
    f.cli('tick')
    assert.equal(readState('main').issues[i.key]?.stalledNotified, true)
    assert.equal(f.calls().split('issue comment ').length - 1, 1)
  } finally {
    f.cleanup()
  }
})
test('AU44/AU47 timeout stops all roles using the coordinator before failure finalization', () => {
  const f = runtimeFixture()
  try {
    const i = f.track('running')
    f.liveWorker()
    process.env.ORCA_AUTO_NOW = '2026-11-13T06:01:00Z'
    f.cli('tick')
    const issue = readState('main').issues[i.key]
    assert.equal(issue?.phase, 'failed')
    assert.equal(issue?.cleanupPending, false)
    assert.ok(!existsSync(i.statusDir))
    assert.ok(f.calls(f.orca).includes('worker-stop --dispatch ctx_design'))
    assert.ok(f.childCalls().includes('ORCA_TERMINAL_HANDLE=term_auto'))
  } finally {
    f.cleanup()
  }
})
for (const rc of [0, 3, 8, 9])
  test(`C1-1 consumes completion before the time limit, wait exit ${rc}`, () => {
    const f = runtimeFixture()
    try {
      const i = f.track('running')
      f.liveWorker()
      f.result(i)
      f.childRc('orca-wait', rc)
      process.env.ORCA_AUTO_NOW = '2026-11-13T06:01:00Z'
      f.cli('tick')
      const calls = f.childCalls()
      assert.equal(readState('main').issues[i.key]?.phase, rc === 0 ? 'finishing' : 'failed')
      assert.equal(calls.split('orca-wait.ts ').length - 1, 1)
      assert.equal(f.calls(f.orca).includes('worker-stop --dispatch ctx_design'), rc !== 0)
      assert.ok(!calls.includes('"--phase","exec"'))
      assert.ok(!f.calls().includes(':stalled -->'))
    } finally {
      f.cleanup()
    }
  })
test('AU45 human status change stops the run without any comment or label write', () => {
  const f = runtimeFixture()
  try {
    const i = f.track('running')
    f.liveWorker()
    f.respond('issue_view', { state: 'OPEN', title: '題', labels: [{ name: 'Pending' }] })
    f.cli('tick')
    assert.equal(readState('main').issues[i.key]?.phase, 'stopped')
    assert.ok(!existsSync(i.statusDir))
    assert.ok(f.calls(f.orca).includes('worker-stop --dispatch ctx_design'))
    assert.ok(!f.calls().includes('issue comment'))
    assert.ok(!f.calls().includes('issue edit'))
  } finally {
    f.cleanup()
  }
})
test('C1-2 auto stop never notifies a finished reviewer with unread worker_done', () => {
  const f = runtimeFixture()
  try {
    const i = f.track('running')
    const file = join(i.statusDir, 'workers.json')
    const w = JSON.parse(readFileSync(file, 'utf8'))
    w.review_mode = 'on'
    w.roles.design_review = { dispatch: 'ctx_review' }
    f.put(file, w)
    f.put(join(i.statusDir, 'received.json'), {})
    f.respond(
      'orchestration_worker-list',
      {
        ok: true,
        result: {
          workers: [
            { dispatchId: 'ctx_design', resource: { releaseState: 'released' } },
            { dispatchId: 'ctx_review', resource: { releaseState: 'released' } },
          ],
        },
      },
      f.orca,
    )
    process.env.ORCA_AUTO_NOW = '2026-11-13T06:01:00Z'
    f.cli('tick')
    assert.equal(readState('main').issues[i.key]?.phase, 'failed')
    assert.equal(readState('main').issues[i.key]?.cleanupPending, false)
    assert.ok(!f.childCalls().includes('orca-stop.ts'))
    assert.ok(!f.calls(f.orca).includes('orchestration send'))
  } finally {
    f.cleanup()
  }
})
test('AU46 closed coordinator is rebound before waiting', () => {
  const f = runtimeFixture()
  try {
    f.track('running')
    f.respond(
      'terminal_show',
      { ok: true, result: { terminal: { handle: 'term_auto', orphaned: true, connected: false } } },
      f.orca,
    )
    f.hook('orchestration_run-use', `printf 'run-use\\n' >> '${f.children}/calls.log'`, f.orca)
    f.cli('tick')
    assert.ok(f.childCalls().indexOf('run-use') < f.childCalls().indexOf('orca-wait.ts'))
  } finally {
    f.cleanup()
  }
})

test('malformed worker-list evidence cannot authorize stopping a potentially user-owned worker', () => {
  const f = runtimeFixture()
  try {
    f.track('running')
    f.respond(
      'orchestration_worker-list',
      { ok: true, result: { workers: [{ resource: { ownershipState: 'user_owned' } }] } },
      f.orca,
    )
    process.env.ORCA_AUTO_NOW = '2026-11-13T06:01:00Z'
    f.cli('tick')
    assert.ok(!f.childCalls().includes('orca-stop.ts'))
  } finally {
    f.cleanup()
  }
})
