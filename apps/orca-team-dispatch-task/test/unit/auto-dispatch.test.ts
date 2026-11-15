import { autoDir } from '../../lib/auto-paths.ts'
import { readState, writeState } from '../../lib/auto-state.ts'
import { runtimeFixture } from '../lib/auto-runtime-fixture.ts'

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

test('AU30 starts once with fixed role switches and coordinator identity, comments before labels', () => {
  const f = runtimeFixture()
  try {
    const i = f.track()
    const r = f.cli('tick')
    assert.equal(r.status, 1, r.stderr)
    const calls = f.childCalls()
    assert.equal(calls.split('orca-start.ts').length - 1, 1)
    for (const arg of ['--integration', 'pr', '--unattended', '--review-mode', 'off', '--phase-b', '--repo-root'])
      assert.ok(calls.includes(arg), arg)
    assert.ok(!calls.includes('"--run"'))
    assert.ok(calls.includes('ORCA_TERMINAL_HANDLE=term_auto'))
    assert.ok(calls.includes('ORCA_CREATE_SETTLE_SECS=20'))
    const current = readState('main').issues[i.key]
    assert.equal(current?.phase, 'running')
    assert.ok(current?.branch.startsWith('user/'))
    assert.ok(f.calls().indexOf('issue comment') < f.calls().indexOf('issue edit'))
  } finally {
    f.cleanup()
  }
})
test('AU31/AU32 lanes reserve planned role worktrees and orphan worktrees', () => {
  for (const roles of [
    { review_mode: 'off', phase_b: 'off' },
    { review_mode: 'on', phase_b: 'on' },
  ]) {
    const f = runtimeFixture()
    try {
      f.track()
      f.put(f.configFile, { ...f.raw, lanes: roles.review_mode === 'on' ? 3 : 1, roles })
      if (roles.review_mode === 'off')
        f.respond(
          'worktree_list',
          { ok: true, result: { worktrees: [{ displayName: 'auto-orphan', path: '/orphan' }], truncated: false } },
          f.orca,
        )
      const r = f.cli('tick')
      assert.ok(!f.childCalls().includes('orca-start.ts'), r.stdout)
    } finally {
      f.cleanup()
    }
  }
})
test('AU34 failed start without workers archives the leftover and requeues', () => {
  const f = runtimeFixture()
  try {
    const i = f.track()
    f.childRc('orca-start', 1)
    f.cli('tick')
    const current = readState('main').issues[i.key]
    assert.equal(current?.phase, 'queued')
    assert.equal(current?.startFailures, 1)
    assert.equal(current?.startAttempt, null)
    assert.ok(readdirSync(join(autoDir('main'), 'archive')).some((p) => p.includes('start1')))
    assert.ok(f.calls(f.orca).includes('terminal close'))
    assert.ok(!f.calls().includes('issue edit'))
  } finally {
    f.cleanup()
  }
})
test('AU35 recorded dispatch including start_incomplete advances without auto recovery', () => {
  const f = runtimeFixture()
  try {
    const i = f.track('dispatching')
    const file = join(i.statusDir, 'workers.json')
    const w = JSON.parse(readFileSync(file, 'utf8'))
    w.roles.design.start_incomplete = true
    f.put(file, w)
    f.cli('tick')
    assert.equal(readState('main').issues[i.key]?.phase, 'running')
    assert.ok(!f.childCalls().includes('orca-start.ts'))
  } finally {
    f.cleanup()
  }
})
test('AU35 missing dispatch resumes only after proving there is no unrecorded worker', () => {
  const f = runtimeFixture()
  try {
    const i = f.track('dispatching')
    const file = join(i.statusDir, 'workers.json')
    const w = JSON.parse(readFileSync(file, 'utf8'))
    w.roles.design.dispatch = ''
    f.put(file, w)
    f.respond('orchestration_worker-list', { ok: true, result: { workers: [] } }, f.orca)
    f.cli('tick')
    assert.ok(f.childCalls().includes('"--resume"'))
    assert.ok(f.childCalls().includes('"--design-mode","plan","--unattended"'))
  } finally {
    f.cleanup()
  }
})
test('AU33b refuses a status directory owned by another issue', () => {
  const f = runtimeFixture()
  try {
    const i = f.track('dispatching')
    writeFileSync(join(i.statusDir, 'request.md'), 'other/repo#7 wrong\n')
    const r = f.cli('tick')
    assert.ok(r.stdout.includes('別の Issue の status dir'))
    assert.equal(f.childCalls(), '')
  } finally {
    f.cleanup()
  }
})
test('AU36/AU37 dirty checkout and insufficient free memory do not dispatch', () => {
  for (const reason of ['dirty', 'memory']) {
    const f = runtimeFixture()
    try {
      f.track()
      if (reason === 'dirty') writeFileSync(join(f.checkout, 'uncommitted'), 'x')
      else process.env.ORCA_AUTO_FREE_MEMORY_MB = '0'
      f.cli('tick')
      assert.ok(!f.childCalls().includes('orca-start.ts'))
    } finally {
      f.cleanup()
    }
  }
})
test('AU38 reports orphan worktrees and never removes them', () => {
  const f = runtimeFixture()
  try {
    f.respond(
      'worktree_list',
      { ok: true, result: { worktrees: [{ displayName: 'auto-orphan', path: '/orphan' }], truncated: false } },
      f.orca,
    )
    const r = f.cli('tick')
    assert.ok(r.stdout.includes('持ち主のいない worktree: auto-orphan /orphan'))
    assert.ok(!f.calls(f.orca).includes('worktree rm'))
  } finally {
    f.cleanup()
  }
})
test('D25 an uncertain start holds its lane and all resource operations', () => {
  const f = runtimeFixture()
  try {
    const i = f.track('dispatching')
    const s = readState('main')
    const current = s.issues[i.key]
    assert.ok(current)
    current.startAttempt = { at: '2026-11-13T05:00:00Z', pid: 123, host: 'test' }
    writeState('main', s)
    const r = f.cli('tick')
    assert.ok(r.stdout.includes('保留'))
    assert.equal(f.childCalls(), '')
    assert.ok(!f.calls(f.orca).includes('terminal close'))
    assert.ok(existsSync(i.statusDir))
  } finally {
    f.cleanup()
  }
})

test('AU80 default local dispatch uses portable mail transport and records its host', () => {
  const f = runtimeFixture()
  try {
    const i = f.track()
    f.cli('tick')
    const calls = f.childCalls()
    for (const text of [
      '"--transport","mail"',
      '"--base-branch","origin/main"',
      '"--worker-orca"',
      `"--host-repo","path:${f.checkout}"`,
    ])
      assert.ok(calls.includes(text), text)
    assert.ok(!calls.includes('"--on"'))
    assert.equal(readState('main').issues[i.key]?.host, 'local')
  } finally {
    f.cleanup()
  }
})
test('AU81 configured remote host is passed to orca-start and saved before dispatch', () => {
  const f = runtimeFixture()
  try {
    const i = f.track()
    f.put(f.configFile, {
      ...f.raw,
      hosts: [
        {
          id: 'env-1',
          name: 'Mac M2max',
          lanes: 1,
          orcaBin: 'orca-ide',
          repos: { 'acme/app': { selector: 'id:R', verified: true } },
        },
      ],
    })
    f.respond('status', { ok: true, result: { runtime: { reachable: true } } }, f.orca)
    f.cli('tick')
    for (const text of ['"--on","env-1"', '"--host-repo","id:R"', '"--worker-orca","orca-ide"'])
      assert.ok(f.childCalls().includes(text), text)
    assert.equal(readState('main').issues[i.key]?.host, 'env-1')
  } finally {
    f.cleanup()
  }
})

const multihost = (
  f: ReturnType<typeof runtimeFixture>,
  localLanes = 1,
  remoteLanes = 2,
  localVerified = true,
  remoteVerified = true,
) => {
  f.put(f.configFile, {
    ...f.raw,
    hosts: [
      {
        id: 'local',
        name: 'This Mac',
        lanes: localLanes,
        orcaBin: 'orca',
        repos: {
          'acme/app': { selector: `path:${f.checkout}`, verified: localVerified },
          'other/api': { selector: 'path:/other', verified: true },
        },
      },
      {
        id: 'env-1',
        name: 'Mac M2max',
        lanes: remoteLanes,
        orcaBin: 'orca-ide',
        repos: { 'acme/app': { selector: 'id:R', verified: remoteVerified } },
      },
    ],
  })
  f.respond('status', { ok: true, result: { runtime: { reachable: true } } }, f.orca)
}
test('AU82 host capacity separates reservations and identical orphan paths', () => {
  const f = runtimeFixture()
  try {
    const active = f.track('running')
    const next = f.track('queued', 8)
    const s = readState('main')
    const current = s.issues[active.key]
    assert.ok(current)
    current.host = 'env-1'
    writeState('main', s)
    f.put(join(active.statusDir, 'workers.json'), {
      integration_role: 'design',
      integration_branch: 'main',
      roles: {
        design: {
          dispatch: 'ctx_design',
          environment: 'env-1',
          worktree_path: join(f.children, 'worktree'),
          branch: active.branch,
        },
      },
    })
    multihost(f)
    const same = join(f.children, 'worktree')
    f.hook(
      'worktree_list',
      `case " $* " in *" --environment env-1 "*) printf '%s' '${JSON.stringify({ ok: true, result: { worktrees: [{ displayName: active.slug, path: same }], truncated: false } })}' > '${f.orca}/worktree_list';; *) printf '%s' '${JSON.stringify({ ok: true, result: { worktrees: [{ displayName: 'auto-orphan', path: same }], truncated: false } })}' > '${f.orca}/worktree_list';; esac`,
      f.orca,
    )
    f.respond('issue_view', { state: 'OPEN', labels: [{ name: 'In progress' }], title: '題', body: '本文' })
    // Keep the active issue running and the queued issue Ready when sync reads each.
    f.hook(
      'issue_view',
      `case " $* " in *" 8 "*) printf '%s' '{"state":"OPEN","labels":[{"name":"Ready"}],"title":"題","body":"本文"}' > '${f.gh}/issue_view';; *) printf '%s' '{"state":"OPEN","labels":[{"name":"In progress"}],"title":"題","body":"本文"}' > '${f.gh}/issue_view';; esac`,
    )
    f.cli('tick')
    assert.equal(readState('main').issues[next.key]?.host, 'env-1')
    assert.ok(f.childCalls().includes('"--on","env-1"'))
    assert.ok(f.calls(f.orca).includes('worktree list --environment env-1'))
  } finally {
    f.cleanup()
  }
})
test('AU83 unreachable servers do not consume local capacity or receive new workers', () => {
  for (const full of [false, true]) {
    const f = runtimeFixture()
    try {
      const i = f.track()
      multihost(f)
      f.respond('status', { ok: true, result: { runtime: { reachable: false } } }, f.orca)
      if (full)
        f.respond(
          'worktree_list',
          { ok: true, result: { worktrees: [{ displayName: 'auto-orphan', path: '/orphan' }], truncated: false } },
          f.orca,
        )
      const r = f.cli('tick')
      assert.equal(r.status, 1)
      assert.equal(f.childCalls().includes('orca-start.ts'), !full)
      assert.ok(!f.childCalls().includes('"--on"'))
      if (!full) assert.equal(readState('main').issues[i.key]?.host, 'local')
    } finally {
      f.cleanup()
    }
  }
})
test('AU84 verified host wins over capacity ratio; unverified hosts retain the reason', () => {
  for (const verified of [true, false]) {
    const f = runtimeFixture()
    try {
      const i = f.track()
      multihost(f, 4, 2, false, verified)
      f.cli('tick')
      const current = readState('main').issues[i.key]
      assert.equal(current?.host, verified ? 'env-1' : 'local')
      assert.equal(current?.reason.includes('確認が通っていないマシンで実装'), !verified)
    } finally {
      f.cleanup()
    }
  }
})
test('AU85 low local memory cannot stop a remote dispatch', () => {
  const f = runtimeFixture()
  try {
    const i = f.track()
    multihost(f)
    process.env.ORCA_AUTO_FREE_MEMORY_MB = '0'
    f.cli('tick')
    assert.equal(readState('main').issues[i.key]?.host, 'env-1')
  } finally {
    f.cleanup()
  }
})
test('AU85b a local-only queue head cannot block a later remote-capable issue when local memory is low', () => {
  const f = runtimeFixture()
  try {
    const first = f.track()
    const second = f.track('queued', 8)
    const s = readState('main')
    const head = s.issues[first.key]
    assert.ok(head)
    head.targets = ['other/api']
    head.priority = 'critical'
    writeState('main', s)
    mkdirSync(f.raw.repos['other/api'].checkout, { recursive: true })
    multihost(f)
    process.env.ORCA_AUTO_FREE_MEMORY_MB = '0'
    f.cli('tick')
    const after = readState('main')
    assert.equal(after.issues[first.key]?.phase, 'queued')
    assert.equal(after.issues[second.key]?.host, 'env-1')
    assert.ok(f.childCalls().includes('"--on","env-1"'))
  } finally {
    f.cleanup()
  }
})

test('AU84b finishing uses the selected host verification instead of the parent checkout verification', () => {
  const f = runtimeFixture()
  try {
    const i = f.track('finishing')
    f.result(i)
    multihost(f, 1, 2, true, false)
    const s = readState('main')
    const issue = s.issues[i.key]
    assert.ok(issue)
    issue.host = 'env-1'
    writeState('main', s)
    f.git('-C', f.checkout, 'push', 'origin', i.branch)
    f.put(join(i.statusDir, 'workers.json'), {
      transport: 'mail',
      integration_branch: 'main',
      integration_role: 'design',
      roles: { design: { dispatch: 'ctx_design', branch: i.branch, environment: 'env-1' } },
    })
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
    f.cli('tick')
    assert.equal(readState('main').issues[i.key]?.phase, 'review')
    assert.ok(!f.calls().includes('pr merge'))
  } finally {
    f.cleanup()
  }
})
