import { autoDir } from '../../lib/auto-paths.ts'
import { readState, writeState } from '../../lib/auto-state.ts'
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
for (const status of ['completed', 'failed', 'settled', 'terminated', 'dispatched'])
  test(`C2-1 dispatch ${status} with other worker state ${status === 'dispatched' ? 'holds' : 'releases'}`, () => {
    const f = runtimeFixture()
    try {
      const i = f.track('running')
      f.liveWorker()
      f.respond(
        'orchestration_worker-show',
        {
          ok: true,
          result: {
            worker: { state: 'stopped' },
            dispatch: { status },
          },
        },
        f.orca,
      )
      f.hook(
        'orchestration_worker-release',
        `printf '%s' '{"ok":true,"result":{"workers":[{"dispatchId":"ctx_design","resource":{"releaseState":"released"}}]}}' > '${f.orca}/orchestration_worker-list'`,
        f.orca,
      )
      process.env.ORCA_AUTO_NOW = '2026-11-13T06:01:00Z'
      f.cli('tick')
      const released = status !== 'dispatched'
      assert.equal(f.calls(f.orca).includes('worker-release --dispatch ctx_design'), released)
      assert.ok(!f.calls(f.orca).includes('worker-stop --dispatch ctx_design'))
      assert.equal(readState('main').issues[i.key]?.phase, released ? 'failed' : 'running')
      assert.equal(existsSync(i.statusDir), !released)
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

const remoteIssue = (f: ReturnType<typeof runtimeFixture>) => {
  const i = f.track('running')
  const s = readState('main')
  const current = s.issues[i.key]
  assert.ok(current)
  current.host = 'env-1'
  writeState('main', s)
  f.put(join(i.statusDir, 'workers.json'), {
    transport: 'mail',
    integration_branch: 'main',
    integration_role: 'design',
    roles: {
      design: { dispatch: 'ctx_design', environment: 'env-1', branch: i.branch, worktree_path: '/remote/worktree' },
    },
  })
  f.put(f.configFile, {
    ...f.raw,
    hosts: [
      {
        id: 'local',
        name: 'This Mac',
        lanes: 1,
        orcaBin: 'orca',
        repos: { 'acme/app': { selector: `path:${f.checkout}`, verified: true } },
      },
      {
        id: 'env-1',
        name: 'Mac M2max',
        lanes: 2,
        orcaBin: 'orca',
        repos: { 'acme/app': { selector: 'id:R', verified: true } },
      },
    ],
  })
  f.respond('status', { ok: true, result: { runtime: { reachable: false } } }, f.orca)
  return i
}
test('AU95 unreachable host keeps its issue and resources while another host progresses', () => {
  const f = runtimeFixture()
  try {
    const remote = remoteIssue(f)
    const local = f.track('running', 8)
    f.childRc('orca-wait', 0)
    f.cli('tick')
    const s = readState('main')
    assert.equal(s.issues[remote.key]?.phase, 'running')
    assert.ok(s.issues[remote.key]?.hostUnreachableSince)
    assert.equal(s.issues[local.key]?.phase, 'finishing')
    assert.ok(!f.childCalls().includes(remote.statusDir))
    assert.ok(f.childCalls().includes(local.statusDir))
    assert.ok(!f.calls(f.orca).includes('worker-stop'))
    assert.equal(f.calls(f.orca).split('status --environment env-1').length - 1, 1)
  } finally {
    f.cleanup()
  }
})
test('AU96 unreachable timed-out host emits one stalled comment without failing or stopping', () => {
  const f = runtimeFixture()
  try {
    const i = remoteIssue(f)
    process.env.ORCA_AUTO_NOW = '2026-11-13T06:01:00Z'
    f.cli('tick')
    f.cli('tick')
    const current = readState('main').issues[i.key]
    assert.equal(current?.phase, 'running')
    assert.equal(current?.stalledNotified, true)
    const comments = readFileSync(join(f.dir, 'comments.jsonl'), 'utf8')
    assert.ok(comments.includes('Mac M2max につながりません'))
    assert.equal(comments.split('orca-auto:in-progress:1:stalled').length - 1, 1)
    assert.ok(!f.calls(f.orca).includes('worker-stop'))
    assert.ok(!f.childCalls().includes('orca-wait.ts'))
  } finally {
    f.cleanup()
  }
})
test('AU97 restored host clears unreachable state and resumes normal timeout handling', () => {
  const f = runtimeFixture()
  try {
    const i = remoteIssue(f)
    f.cli('tick')
    assert.ok(readState('main').issues[i.key]?.hostUnreachableSince)
    f.respond('status', { ok: true, result: { runtime: { reachable: true } } }, f.orca)
    f.respond(
      'orchestration_worker-list',
      {
        ok: true,
        result: {
          workers: [{ dispatchId: 'ctx_design', resource: null, projection: { liveness: { verdict: 'exited' } } }],
        },
      },
      f.orca,
    )
    process.env.ORCA_AUTO_NOW = '2026-11-13T06:01:00Z'
    f.cli('tick')
    const current = readState('main').issues[i.key]
    assert.equal(current?.hostUnreachableSince, null)
    assert.equal(current?.phase, 'failed')
    assert.ok(f.childCalls().includes('orca-wait.ts'))
  } finally {
    f.cleanup()
  }
})
test('AU98 host status reads obey call caps and leave a report within the tick budget', () => {
  const f = runtimeFixture()
  try {
    remoteIssue(f)
    process.env.ORCA_AUTO_BUDGET_MS = '3000'
    process.env.ORCA_AUTO_CALL_CAP_MS = '1000'
    f.hook('status', "trap '' TERM\nexec >/dev/null 2>&1\nsleep 10", f.orca)
    const started = Date.now()
    f.cli('tick')
    assert.ok(Date.now() - started < 5000)
    assert.ok(existsSync(join(autoDir('main'), 'report.json')))
    assert.ok(!f.childCalls().includes('orca-wait.ts'))
  } finally {
    for (const key of ['ORCA_AUTO_BUDGET_MS', 'ORCA_AUTO_CALL_CAP_MS']) Reflect.deleteProperty(process.env, key)
    f.cleanup()
  }
})

test('AU96b an unreachable finishing issue also reports its elapsed limit without finalizing', () => {
  const f = runtimeFixture()
  try {
    const i = remoteIssue(f)
    const s = readState('main')
    const issue = s.issues[i.key]
    assert.ok(issue)
    issue.phase = 'finishing'
    writeState('main', s)
    process.env.ORCA_AUTO_NOW = '2026-11-13T06:01:00Z'
    f.cli('tick')
    assert.equal(readState('main').issues[i.key]?.phase, 'finishing')
    assert.equal(readState('main').issues[i.key]?.stalledNotified, true)
    assert.ok(!f.childCalls().includes('orca-pr.ts'))
  } finally {
    f.cleanup()
  }
})

test('AU123 failure pushes both repository branches before commenting, and reports any failed push', () => {
  for (const failPush of [false, true]) {
    const f = runtimeFixture()
    try {
      const i = f.trackMulti('running')
      f.liveWorker()
      const primary = f.second()
      const secondary = f.checkout
      const extra = i.branches['acme/app'] ?? ''
      for (const [checkout, branch] of [
        [primary, i.branch],
        [secondary, extra],
      ]) {
        assert.ok(checkout && branch)
        f.git('-C', checkout, 'checkout', branch)
        writeFileSync(join(checkout, 'change'), `change ${checkout}`)
        f.git('-C', checkout, 'add', 'change')
        f.git('-C', checkout, 'commit', '-m', 'change')
        f.git('-C', checkout, 'checkout', 'main')
      }
      if (failPush) f.git('-C', secondary, 'remote', 'set-url', 'origin', join(f.dir, 'missing'))
      const oldHook = readFileSync(join(f.gh, 'issue_comment.hook'), 'utf8')
      f.hook(
        'issue_comment',
        `git -C '${primary}' ls-remote --heads origin '${i.branch}' > '${f.dir}/primary-at-comment' 2>/dev/null\ngit -C '${secondary}' ls-remote --heads origin '${extra}' > '${f.dir}/secondary-at-comment' 2>/dev/null\n${oldHook}`,
      )
      process.env.ORCA_AUTO_NOW = '2026-11-13T06:01:00Z'
      f.cli('tick')
      const current = readState('main').issues[i.key]
      assert.equal(current?.phase, 'failed')
      const body = readFileSync(join(f.dir, 'comments.jsonl'), 'utf8')
      assert.ok(body.includes('other/api') && body.includes('acme/app'), body)
      assert.ok(body.includes(failPush ? 'push できていません' : 'push 済み'), body)
      assert.ok(readFileSync(join(f.dir, 'primary-at-comment'), 'utf8').includes(i.branch))
      assert.equal(Boolean(readFileSync(join(f.dir, 'secondary-at-comment'), 'utf8').trim()), !failPush)
    } finally {
      f.cleanup()
    }
  }
})
