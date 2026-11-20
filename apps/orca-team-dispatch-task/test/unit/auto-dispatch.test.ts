import { autoDir } from '../../lib/auto-paths.ts'
import { slugOf } from '../../lib/auto-request.ts'
import { readState, writeState } from '../../lib/auto-state.ts'
import { readJson } from '../../lib/fs.ts'
import { asArray, get, parseJson } from '../../lib/json.ts'
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

for (const mode of ['full', 'unreachable', 'unreadable', 'memory'])
  test(`AU100/F1 ${mode} verified host never falls back to an unverified host or blocks another repository`, () => {
    const f = runtimeFixture()
    try {
      const first = f.track()
      const second = f.track('queued', 8)
      const other = f.raw.repos['other/api'].checkout
      f.git('clone', join(f.dir, 'origin.git'), other)
      const state = readState('main')
      const a = state.issues[first.key]
      const b = state.issues[second.key]
      assert.ok(a && b)
      a.priority = 'critical'
      b.priority = 'low'
      b.targets = ['other/api']
      writeState('main', state)
      f.put(f.configFile, {
        ...f.raw,
        hosts: [
          {
            id: 'local',
            name: 'This Mac',
            lanes: 2,
            orcaBin: 'orca',
            repos: {
              'acme/app': { selector: `path:${f.checkout}`, verified: mode === 'memory' },
              'other/api': { selector: `path:${other}`, verified: mode !== 'memory' },
            },
          },
          {
            id: 'env-1',
            name: 'Mac M2max',
            lanes: 1,
            orcaBin: 'orca',
            repos: {
              'acme/app': { selector: 'id:R', verified: mode !== 'memory' },
              'other/api': { selector: 'id:OTHER', verified: mode === 'memory' },
            },
          },
        ],
      })
      f.respond('status', { ok: true, result: { runtime: { reachable: mode !== 'unreachable' } } }, f.orca)
      const remoteRows = mode === 'full' ? [{ displayName: 'auto-full', path: '/remote/full' }] : []
      f.hook(
        'worktree_list',
        `case " $* " in *" --environment env-1 "*) printf '%s' '${JSON.stringify({ ok: true, result: { worktrees: remoteRows, truncated: false } })}' > '${f.orca}/worktree_list'; echo '${mode === 'unreadable' ? 1 : 0}' > '${f.orca}/worktree_list.rc';; *) printf '%s' '{"ok":true,"result":{"worktrees":[],"truncated":false}}' > '${f.orca}/worktree_list'; echo 0 > '${f.orca}/worktree_list.rc';; esac`,
        f.orca,
      )
      if (mode === 'memory') process.env.ORCA_AUTO_FREE_MEMORY_MB = '0'
      f.cli('tick')
      const after = readState('main')
      assert.equal(after.issues[first.key]?.phase, 'queued', mode)
      assert.equal(after.issues[first.key]?.host, null, mode)
      assert.equal(after.issues[second.key]?.phase, 'running', mode)
      assert.equal(after.issues[second.key]?.host, mode === 'memory' ? 'env-1' : 'local', mode)
      assert.equal(f.childCalls().split('orca-start.ts ').length - 1, 1)
      assert.ok(f.childCalls().includes(other))
    } finally {
      f.cleanup()
    }
  })

test('AU101/F2 skipped unverified placement never changes the saved judgment reason', () => {
  const f = runtimeFixture()
  try {
    const first = f.track()
    const second = f.track('queued', 8)
    multihost(f, 3, 2, false, false)
    const original = readState('main').issues[first.key]?.reason
    mkdirSync(join(f.checkout, '.dispatch', slugOf(first.key)), { recursive: true })
    f.cli('tick')
    const after = readState('main')
    assert.equal(after.issues[first.key]?.phase, 'queued')
    assert.equal(after.issues[first.key]?.reason, original)
    assert.equal(after.issues[second.key]?.phase, 'running')
    assert.ok(after.issues[second.key]?.reason.includes('確認が通っていないマシンで実装'))
  } finally {
    f.cleanup()
  }
})

const multiConfig = (f: ReturnType<typeof runtimeFixture>, lanes = 2) =>
  f.put(f.configFile, {
    ...f.raw,
    lanes,
    repos: { ...f.raw.repos, 'other/api': { ...f.raw.repos['other/api'], verified: true } },
  })

test('AU105 only hosts containing every target are candidates, even when another host has more lanes', () => {
  for (const missing of [false, true]) {
    const f = runtimeFixture()
    try {
      const issue = f.trackMulti('queued', ['acme/app', 'other/api'])
      multihost(f, 2, 8)
      if (missing) {
        f.put(f.configFile, {
          ...f.raw,
          hosts: [
            {
              id: 'local',
              name: 'This Mac',
              lanes: 2,
              orcaBin: 'orca',
              repos: { 'other/api': { selector: 'id:api', verified: true } },
            },
            {
              id: 'env-1',
              name: 'Remote',
              lanes: 8,
              orcaBin: 'orca',
              repos: { 'acme/app': { selector: 'id:app', verified: true } },
            },
          ],
        })
      }
      const r = f.cli('tick')
      if (missing) {
        assert.ok(!f.childCalls().includes('orca-start.ts'))
        assert.ok(r.stdout.includes('この Issue を入れられるマシンがありません'), r.stdout)
      } else assert.equal(readState('main').issues[issue.key]?.host, 'local')
    } finally {
      f.cleanup()
    }
  }
})

test('AU105b unverified placement requires both repositories and records the verification warning', () => {
  const f = runtimeFixture()
  try {
    const issue = f.trackMulti()
    f.put(f.configFile, { ...f.raw, lanes: 2 })
    const r = f.cli('tick')
    assert.equal(r.status, 1, r.stderr)
    assert.ok(readState('main').issues[issue.key]?.reason.includes('確認が通っていないマシンで実装'))
    assert.equal(readState('main').issues[issue.key]?.worktrees, 2)
  } finally {
    f.cleanup()
  }
})

test('AU106 lanes reserve roles times repositories, and recorded extras are owned', () => {
  for (const roles of [
    { review_mode: 'off', phase_b: 'off' },
    { review_mode: 'on', phase_b: 'on' },
  ] as const) {
    const required = roles.review_mode === 'on' ? 8 : 2
    for (const enough of [false, true]) {
      const f = runtimeFixture()
      try {
        const issue = f.trackMulti()
        f.put(f.configFile, { ...f.raw, roles, lanes: enough ? required : required - 1 })
        const r = f.cli('tick')
        if (enough) {
          assert.equal(readState('main').issues[issue.key]?.worktrees, required)
          const report = readJson(join(autoDir('main'), 'report.json'))
          assert.equal(get(asArray(get(report, 'hosts'))?.[0], 'used'), required)
        } else {
          assert.ok(!f.childCalls().includes('orca-start.ts'))
          assert.ok(r.stdout.includes('レーンが足りません'), r.stdout)
        }
      } finally {
        f.cleanup()
      }
    }
  }
  const f = runtimeFixture()
  try {
    const issue = f.trackMulti('running')
    multiConfig(f)
    f.respond(
      'worktree_list',
      {
        ok: true,
        result: { worktrees: [{ displayName: issue.slug, path: join(f.children, 'worktree2') }], truncated: false },
      },
      f.orca,
    )
    const r = f.cli('tick')
    assert.ok(!r.stdout.includes('持ち主のいない worktree'), r.stdout)
    assert.equal(get(asArray(get(readJson(join(autoDir('main'), 'report.json')), 'hosts'))?.[0], 'used'), 2)
  } finally {
    f.cleanup()
  }
})

test('AU106b extra-only failed starts retain environment ownership of identical paths', () => {
  const f = runtimeFixture()
  try {
    const issue = f.trackMulti('dispatching')
    const s = readState('main')
    const current = s.issues[issue.key]
    assert.ok(current)
    current.host = 'env-1'
    writeState('main', s)
    multihost(f, 3, 4)
    f.put(join(issue.statusDir, 'workers.json'), {
      repos: issue.targets.map((repo) => ({
        repo,
        checkout: f.raw.repos[repo === 'acme/app' ? 'acme/app' : 'other/api'].checkout,
        host_repo: 'id:repo',
        base_branch: 'origin/main',
        integration_branch: 'main',
      })),
      integration_role: 'design',
      roles: {
        design: { environment: 'env-1', extra: { 'acme/app': { worktree_path: '/same', branch: 'user/extra' } } },
      },
    })
    f.respond(
      'worktree_list',
      { ok: true, result: { worktrees: [{ displayName: issue.slug, path: '/same' }], truncated: false } },
      f.orca,
    )
    f.liveWorker()
    const r = f.cli('tick')
    const hosts = asArray(get(readJson(join(autoDir('main'), 'report.json')), 'hosts')) ?? []
    assert.equal(
      get(
        hosts.find((h) => get(h, 'name') === 'Mac M2max'),
        'used',
      ),
      2,
    )
    assert.equal(
      get(
        hosts.find((h) => get(h, 'name') === 'This Mac'),
        'used',
      ),
      1,
    )
    assert.ok(r.stdout.includes('持ち主のいない worktree'), r.stdout)
  } finally {
    f.cleanup()
  }
})

test('AU106c a two-repository lane shortage allows a queued single-repository Issue to start', () => {
  for (const roles of [
    { review_mode: 'off', phase_b: 'off' },
    { review_mode: 'on', phase_b: 'on' },
  ] as const) {
    const f = runtimeFixture()
    try {
      const multi = f.trackMulti('queued', ['acme/app', 'other/api'], 7)
      const single = f.track('queued', 8)
      f.put(f.configFile, { ...f.raw, roles, lanes: roles.review_mode === 'on' ? 4 : 1 })
      const r = f.cli('tick')
      assert.ok(r.stdout.includes('レーンが足りません'), r.stdout)
      const state = readState('main')
      assert.equal(state.issues[multi.key]?.phase, 'queued')
      assert.equal(state.issues[single.key]?.phase, 'running')
      assert.equal(f.childCalls().split('orca-start.ts').length - 1, 1)
      assert.ok(f.childCalls().includes(slugOf(single.key)))
    } finally {
      f.cleanup()
    }
  }
})

test('AU106d a single-repository lane shortage still stops queue scanning', () => {
  const f = runtimeFixture()
  try {
    const first = f.track('queued', 7)
    const second = f.track('queued', 8)
    f.put(f.configFile, { ...f.raw, roles: { review_mode: 'on', phase_b: 'on' }, lanes: 3 })
    const r = f.cli('tick')
    assert.equal(r.stdout.split('レーンが足りません').length - 1, 1, r.stdout)
    assert.ok(!f.childCalls().includes('orca-start.ts'))
    const state = readState('main')
    assert.equal(state.issues[first.key]?.phase, 'queued')
    assert.equal(state.issues[second.key]?.phase, 'queued')
  } finally {
    f.cleanup()
  }
})

test('AU107 any dirty checkout blocks dispatch and both default branches are prepared', () => {
  for (const dirty of ['acme/app', 'other/api', 'none']) {
    const f = runtimeFixture()
    try {
      f.trackMulti()
      multiConfig(f)
      const second = f.second()
      for (const checkout of [f.checkout, second]) f.git('-C', checkout, 'checkout', '-b', 'user/parent')
      if (dirty !== 'none') writeFileSync(join(dirty === 'acme/app' ? f.checkout : second, 'dirty'), 'dirt')
      const r = f.cli('tick')
      if (dirty !== 'none') {
        assert.ok(!f.childCalls().includes('orca-start.ts'))
        assert.ok(r.stdout.includes('未コミットの変更があるため補充しません'), r.stdout)
      } else {
        assert.ok(f.childCalls().includes('orca-start.ts'))
        for (const checkout of [f.checkout, second])
          assert.equal(f.git('-C', checkout, 'branch', '--show-current'), 'main')
      }
    } finally {
      f.cleanup()
    }
  }
})

test('AU108 repositories file and primary arguments preserve target order and both branch records', () => {
  const f = runtimeFixture()
  try {
    const issue = f.trackMulti()
    multiConfig(f)
    const r = f.cli('tick')
    assert.equal(r.status, 1, r.stderr)
    const match = f.childCalls().match(/orca-start\.ts (\[.*?\]) ORCA_TERMINAL_HANDLE=/)
    const args = asArray(parseJson(match?.[1] ?? '')) ?? []
    const file = args[args.indexOf('--repos-file') + 1]
    assert.equal(typeof file, 'string')
    if (typeof file !== 'string') throw new Error('repos-file is missing')
    const repos = asArray(readJson(file))
    assert.deepEqual(repos, [
      { repo: 'other/api', checkout: f.second(), host_repo: `path:${f.second()}`, base_branch: 'origin/main' },
      { repo: 'acme/app', checkout: f.checkout, host_repo: `path:${f.checkout}`, base_branch: 'origin/main' },
    ])
    assert.equal(args[args.indexOf('--repo-root') + 1], f.second())
    assert.equal(args[args.indexOf('--host-repo') + 1], `path:${f.second()}`)
    assert.equal(args[args.indexOf('--base-branch') + 1], 'origin/main')
    assert.deepEqual(readState('main').issues[issue.key]?.branches, {
      'other/api': `user/${slugOf(issue.key)}`,
      'acme/app': `user/${slugOf(issue.key)}-2`,
    })
  } finally {
    f.cleanup()
  }
})

test('AU109 legacy starts do not acquire a repos file', () => {
  const f = runtimeFixture()
  try {
    f.track()
    f.cli('tick')
    assert.ok(f.childCalls().includes('orca-start.ts'))
    assert.ok(!f.childCalls().includes('--repos-file'))
  } finally {
    f.cleanup()
  }
})

test('AU138 dispatch freezes the relay allowance and explains the effective limit', () => {
  for (const review_mode of ['on', 'off'] as const) {
    const f = runtimeFixture()
    try {
      f.put(f.configFile, { ...f.raw, lanes: review_mode === 'on' ? 2 : 1, roles: { review_mode, phase_b: 'off' } })
      const i = f.track()
      f.cli('tick')
      assert.equal(readState('main').issues[i.key]?.relayMinutes, review_mode === 'on' ? 55 : 0)
      const comments = readFileSync(join(f.dir, 'comments.jsonl'), 'utf8')
      assert.ok(
        comments.includes(
          review_mode === 'on' ? '上限時間: 115 分（見積もり 60 分 + 取り次ぎ 55 分）' : '上限時間: 60 分',
        ),
      )
      if (review_mode === 'off') assert.ok(!comments.includes('取り次ぎ'))
      f.put(f.configFile, { ...f.raw, everyMinutes: 10 })
      f.cli('tick')
      assert.equal(readState('main').issues[i.key]?.relayMinutes, review_mode === 'on' ? 55 : 0)
    } finally {
      f.cleanup()
    }
  }
})

test('AU153 an issue without bases starts from the default branch and records it', () => {
  const f = runtimeFixture()
  try {
    const issue = f.track()
    assert.deepEqual(issue.bases, {})
    f.cli('tick')
    const args = f.childCalls()
    assert.ok(args.includes('"--base-branch","origin/main"'), args)
    assert.ok(f.calls().includes('repo view'), f.calls())
    assert.equal(f.git('-C', f.checkout, 'branch', '--show-current'), 'main')
    assert.deepEqual(readState('main').issues[issue.key]?.bases, { 'acme/app': 'main' })
  } finally {
    f.cleanup()
  }
})

test('AU154 a decided base starts from that branch without asking GitHub for the default', () => {
  for (const base of ['main', 'develop']) {
    const f = runtimeFixture()
    try {
      if (base === 'develop') {
        f.git('-C', f.checkout, 'checkout', '-b', 'develop')
        writeFileSync(join(f.checkout, 'dev'), 'dev')
        f.git('-C', f.checkout, 'add', 'dev')
        f.git('-C', f.checkout, 'commit', '-m', 'dev')
        f.git('-C', f.checkout, 'push', 'origin', 'develop')
        f.git('-C', f.checkout, 'checkout', 'main')
      }
      const issue = f.track()
      const s = readState('main')
      const current = s.issues[issue.key]
      if (!current) throw new Error('issue')
      current.bases = { 'acme/app': base }
      writeState('main', s)
      f.cli('tick')
      assert.ok(f.childCalls().includes(`"--base-branch","origin/${base}"`), f.childCalls())
      assert.ok(!f.calls().includes('repo view'), f.calls())
      assert.equal(f.git('-C', f.checkout, 'branch', '--show-current'), base)
      assert.deepEqual(readState('main').issues[issue.key]?.bases, { 'acme/app': base })
    } finally {
      f.cleanup()
    }
  }
})
