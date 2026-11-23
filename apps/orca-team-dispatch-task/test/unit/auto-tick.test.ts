import { autoDir } from '../../lib/auto-paths.ts'
import { slugOf } from '../../lib/auto-request.ts'
import { readState, releaseLock, takeLock, writeState } from '../../lib/auto-state.ts'
import { runtimeFixture } from '../lib/auto-runtime-fixture.ts'

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const report = () =>
  JSON.parse(readFileSync(join(autoDir('main'), 'report.json'), 'utf8')) as {
    queue: object[]
    running: object[]
    hosts: Array<{ used: number }>
  }
const lease = (f: ReturnType<typeof runtimeFixture>, since: string | null) => {
  const i = f.track()
  const s = readState('main')
  const current = s.issues[i.key]
  assert.ok(current)
  current.phase = 'judging'
  s.judgingSince = since
  writeState('main', s)
  return i
}
test('AU70/AU71 judge precheck exit follows the judgment lease', () => {
  for (const [since, code] of [
    [null, 0],
    ['2026-11-13T05:25:00Z', 1],
    ['2026-11-13T05:05:00Z', 0],
  ] as const) {
    const f = runtimeFixture()
    try {
      lease(f, since)
      const r = f.cli('tick')
      assert.equal(r.status, code, r.stderr)
      assert.ok(r.stdout.trim().split('\n').at(-1)?.startsWith('auto: judge=1'))
    } finally {
      f.cleanup()
    }
  }
})
test('AU151 an issue waiting for a base label does not start the judge', () => {
  const f = runtimeFixture()
  try {
    const i = lease(f, null)
    const s = readState('main')
    Object.assign(s.issues[i.key] ?? {}, { baseAsked: true, targets: ['acme/app'] })
    writeState('main', s)
    f.respond('issue_view', { state: 'OPEN', title: '題', labels: [{ name: 'Backlog' }] })
    const r = f.cli('tick')
    assert.equal(r.status, 1, r.stderr)
    assert.ok(r.stdout.trim().split('\n').at(-1)?.startsWith('auto: judge=0'))
    assert.equal(readState('main').issues[i.key]?.phase, 'judging')
  } finally {
    f.cleanup()
  }
})
test('AU72 empty queue writes report, AU74 exhausted budget still writes report', () => {
  for (const budget of [undefined, '1']) {
    const f = runtimeFixture()
    try {
      if (budget) process.env.ORCA_AUTO_BUDGET_MS = budget
      const r = f.cli('tick')
      assert.equal(r.status, 1)
      assert.deepEqual(report().queue, [])
      assert.deepEqual(report().running, [])
      if (budget) assert.match(r.stdout, /errors=[1-9]/)
    } finally {
      Reflect.deleteProperty(process.env, 'ORCA_AUTO_BUDGET_MS')
      f.cleanup()
    }
  }
})
test('AU73 overlap exits before any GitHub or Orca call', () => {
  const f = runtimeFixture()
  try {
    takeLock('main', 10000)
    assert.equal(f.cli('tick').status, 1)
    assert.equal(f.calls(), '')
    assert.equal(f.calls(f.orca), '')
  } finally {
    releaseLock('main')
    f.cleanup()
  }
})
test('AU75 budget is checked between issues and children are not killed', () => {
  const f = runtimeFixture()
  try {
    f.track('running', 7)
    f.track('running', 8)
    f.track('running', 9)
    process.env.ORCA_AUTO_BUDGET_MS = '3000'
    process.env.ORCA_AUTO_CALL_CAP_MS = '1000'
    writeFileSync(join(f.children, 'orca-wait.ts.sh'), 'sleep 2\n')
    const r = f.cli('tick')
    assert.ok(f.childCalls().includes('orca-wait.ts'))
    assert.ok(f.childCalls().split('orca-wait.ts ').length - 1 < 3)
    assert.match(r.stdout, /errors=[1-9]/)
    assert.ok(existsSync(join(autoDir('main'), 'report.json')))
  } finally {
    for (const key of ['ORCA_AUTO_BUDGET_MS', 'ORCA_AUTO_CALL_CAP_MS']) Reflect.deleteProperty(process.env, key)
    f.cleanup()
  }
})
test('AU76 SIGKILL deadline bounds an uncooperative read without changing that issue', () => {
  const f = runtimeFixture()
  try {
    const i = f.track('running')
    const before = readState('main').issues[i.key]
    process.env.ORCA_AUTO_BUDGET_MS = '3000'
    process.env.ORCA_AUTO_CALL_CAP_MS = '1000'
    f.hook('issue_view', "trap '' TERM\nexec >/dev/null 2>&1\nsleep 10")
    const started = Date.now()
    f.cli('tick')
    assert.ok(Date.now() - started < 5000)
    assert.deepEqual(readState('main').issues[i.key], before)
    assert.equal(f.childCalls(), '')
  } finally {
    for (const key of ['ORCA_AUTO_BUDGET_MS', 'ORCA_AUTO_CALL_CAP_MS']) Reflect.deleteProperty(process.env, key)
    f.cleanup()
  }
})
test('AU76c/AU76d persisted uncertain starts hold every resource operation until explicitly cleared', () => {
  const f = runtimeFixture()
  try {
    const i = f.track('running')
    const s = readState('main')
    const current = s.issues[i.key]
    assert.ok(current)
    current.startAttempt = { at: '2026-11-13T05:00:00Z', pid: 123, host: 'test' }
    writeState('main', s)
    process.env.ORCA_AUTO_NOW = '2026-11-13T07:00:00Z'
    f.childRc('orca-wait', 9)
    const r = f.cli('tick')
    assert.ok(r.stdout.includes('保留'))
    assert.ok(r.stdout.includes('run_1'))
    assert.ok(r.stdout.includes('起動プロセス'))
    assert.equal(f.childCalls(), '')
    assert.ok(!f.calls(f.orca).includes('worktree rm'))
    assert.ok(!f.calls(f.orca).includes('terminal close'))
    assert.ok(readState('main').issues[i.key]?.failReason)
    assert.ok(readState('main').issues[i.key]?.startAttempt)
  } finally {
    f.cleanup()
  }
})
test('AU76e only one start is allowed across exec and refill paths in a tick', () => {
  const f = runtimeFixture()
  try {
    const a = f.track('running', 7)
    const b = f.track('running', 8)
    f.track('queued', 9)
    f.put(f.configFile, { ...f.raw, lanes: 10 })
    for (const i of [a, b]) {
      const file = join(i.statusDir, 'workers.json')
      const w = JSON.parse(readFileSync(file, 'utf8'))
      w.integration_role = 'exec'
      w.roles.exec = {}
      f.put(file, w)
    }
    f.hook(
      'issue_view',
      `case "$3" in 9) printf '%s' '${JSON.stringify({ state: 'OPEN', title: '題', body: '本文', labels: [{ name: 'Ready' }] })}' > '${f.gh}/issue_view';; *) printf '%s' '${JSON.stringify({ state: 'OPEN', title: '題', body: '本文', labels: [{ name: 'In progress' }] })}' > '${f.gh}/issue_view';; esac`,
    )
    f.childRc('orca-wait', 9)
    f.cli('tick')
    assert.equal(f.childCalls().split('orca-start.ts ').length - 1, 1)
    assert.equal(readState('main').issues['acme/app#9']?.phase, 'queued')
  } finally {
    f.cleanup()
  }
})
test('AU77 second tick cannot overlap a live tick even after its budget is exceeded', async () => {
  const f = runtimeFixture()
  let child: ReturnType<typeof spawn> | null = null
  try {
    f.track('running')
    process.env.ORCA_AUTO_BUDGET_MS = '500'
    process.env.ORCA_AUTO_CALL_CAP_MS = '100'
    const marker = join(f.dir, 'waiting')
    writeFileSync(join(f.children, 'orca-wait.ts.sh'), `touch '${marker}'\nsleep 2\n`)
    child = spawn(process.execPath, [join(f.plugin, 'bin/orca-auto.ts'), 'tick'], { stdio: 'ignore' })
    let ready = false
    for (let n = 0; n < 100; n++) {
      if (existsSync(marker)) {
        ready = true
        break
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 50))
    }
    assert.ok(ready)
    await new Promise<void>((resolve) => setTimeout(resolve, 400))
    const before = [f.calls(), f.calls(f.orca)]
    assert.equal(f.cli('tick').status, 1)
    assert.deepEqual([f.calls(), f.calls(f.orca)], before)
    await new Promise<void>((resolve) => {
      if (!child || child.exitCode !== null) resolve()
      else child.on('close', () => resolve())
    })
  } finally {
    if (child && child.exitCode === null) child.kill('SIGKILL')
    for (const key of ['ORCA_AUTO_BUDGET_MS', 'ORCA_AUTO_CALL_CAP_MS']) Reflect.deleteProperty(process.env, key)
    f.cleanup()
  }
})

test('AU76b acknowledged but unrecorded worker blocks resume and resource cleanup', () => {
  const f = runtimeFixture()
  try {
    const issue = f.track()
    const sd = join(f.checkout, '.dispatch', slugOf(issue.key))
    writeFileSync(
      join(f.children, 'orca-start.ts.sh'),
      `mkdir -p '${sd}'\nprintf '%s' '${JSON.stringify({ run_id: 'run_1', parent_handle: 'term_auto', repo_root: f.checkout })}' > '${sd}/run.json'\n`,
    )
    f.respond(
      'orchestration_worker-list',
      { ok: true, result: { workers: [{ dispatchId: 'unrecorded', resource: { releaseState: 'retained' } }] } },
      f.orca,
    )
    f.childRc('orca-start', 1)
    f.cli('tick')
    const before = f.childCalls()
    const next = f.cli('tick')
    assert.ok(next.stdout.includes('起動の結果が不明'))
    assert.equal(f.childCalls(), before)
    assert.ok(!f.calls(f.orca).includes('terminal close'))
    assert.ok(!f.calls(f.orca).includes('worktree rm'))
    assert.equal(readState('main').issues[issue.key]?.phase, 'dispatching')
  } finally {
    f.cleanup()
  }
})

for (const observation of ['unrecorded', 'partial'])
  test(`AU99 ${observation} remote inventory prevents requeueing or resuming an incomplete startup`, () => {
    const f = runtimeFixture()
    try {
      const issue = f.track()
      const sd = join(f.checkout, '.dispatch', slugOf(issue.key))
      f.put(f.configFile, {
        ...f.raw,
        hosts: [
          {
            id: 'env-1',
            name: 'Mac M2max',
            lanes: 1,
            orcaBin: 'orca',
            repos: { 'acme/app': { selector: 'id:R', verified: true } },
          },
        ],
      })
      f.respond('status', { ok: true, result: { runtime: { reachable: true } } }, f.orca)
      writeFileSync(
        join(f.children, 'orca-start.ts.sh'),
        `mkdir -p '${sd}'\nprintf '%s' '${JSON.stringify({ run_id: 'run_1', parent_handle: 'term_auto', repo_root: f.checkout })}' > '${sd}/run.json'\n`,
      )
      const remote =
        observation === 'partial'
          ? { ok: true, result: { workers: [], partialHostErrors: [{ environmentId: 'env-1' }] } }
          : {
              ok: true,
              result: {
                workers: [{ dispatchId: 'unrecorded', resource: null, projection: { liveness: { verdict: 'live' } } }],
              },
            }
      f.hook(
        'orchestration_worker-list',
        `case " $* " in *" --include-remote "*) printf '%s' '${JSON.stringify(remote)}' > '${f.orca}/orchestration_worker-list';; *) printf '%s' '{"ok":true,"result":{"workers":[]}}' > '${f.orca}/orchestration_worker-list';; esac`,
        f.orca,
      )
      f.childRc('orca-start', 1)
      f.cli('tick')
      assert.equal(readState('main').issues[issue.key]?.phase, 'dispatching', observation)
      const before = f.childCalls()
      f.cli('tick')
      assert.equal(f.childCalls(), before, observation)
      assert.ok(f.calls(f.orca).includes('--include-remote'))
      assert.ok(!f.calls(f.orca).includes('terminal close'))
      assert.ok(!f.calls(f.orca).includes('worktree rm'))
      assert.ok(existsSync(sd))
    } finally {
      f.cleanup()
    }
  })

const projectPage = () => ({
  data: {
    repositoryOwner: {
      projectV2: {
        id: 'PVT_1',
        field: {
          __typename: 'ProjectV2SingleSelectField',
          id: 'PVTSSF_1',
          options: [
            { id: 'opt_pending', name: 'Pending' },
            { id: 'opt_ready', name: 'Ready' },
          ],
        },
        items: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: 'PVTI_1',
              isArchived: false,
              content: {
                __typename: 'Issue',
                number: 1,
                repository: { nameWithOwner: 'acme/app' },
                labels: { nodes: [{ name: 'from-slack' }, { name: 'Ready' }] },
                timelineItems: { nodes: [] },
              },
              status: {
                __typename: 'ProjectV2ItemFieldSingleSelectValue',
                name: 'Pending',
                optionId: 'opt_pending',
                updatedAt: '2026-11-17T01:55:41Z',
              },
            },
          ],
        },
      },
    },
  },
})
const withProject = (f: ReturnType<typeof runtimeFixture>) =>
  f.put(f.configFile, {
    ...f.raw,
    sources: f.raw.sources.map((s) => (s.repo === 'acme/app' ? { ...s, project: { owner: 'acme', number: 3 } } : s)),
  })
test('AU130 tick syncs the Project before and after the queue', () => {
  const f = runtimeFixture()
  try {
    withProject(f)
    const state = readState('main')
    state.projectSync['acme/app#1'] = { status: 'Ready', label: 'Ready' }
    writeState('main', state)
    f.respond('api_graphql', projectPage())
    const result = f.cli('tick')
    assert.equal(result.status, 1, result.stderr)
    const calls = f.calls().trim().split('\n')
    const reads = calls.flatMap((s, i) => (s.startsWith('api graphql') ? [i] : []))
    const lists = calls.flatMap((s, i) => (s.startsWith('issue list') ? [i] : []))
    assert.equal(reads.length, 2)
    assert.ok((reads[0] ?? Infinity) < (lists[0] ?? -1))
    assert.ok((reads[1] ?? -1) > (lists.at(-1) ?? Infinity))
    const edit = calls.findIndex((s) =>
      s.startsWith('issue edit 1 --repo acme/app --add-label Pending --remove-label Ready'),
    )
    assert.ok(edit > (reads[0] ?? Infinity) && edit < (lists[0] ?? -1))
    assert.ok(!f.calls().includes('updateProjectV2ItemFieldValue'))
    assert.deepEqual(readState('main').projectSync['acme/app#1'], { status: 'Pending', label: 'Pending' })
  } finally {
    f.cleanup()
  }
  const absent = runtimeFixture()
  try {
    absent.cli('tick')
    assert.ok(!absent.calls().includes('api graphql'))
  } finally {
    absent.cleanup()
  }
  const unreadable = runtimeFixture()
  try {
    withProject(unreadable)
    unreadable.respond('api_graphql', {})
    unreadable.put(join(unreadable.gh, 'api_graphql.rc'), 1)
    const result = unreadable.cli('tick')
    const lines = result.stdout.trim().split('\n')
    assert.equal(lines.filter((s) => s.startsWith('Project を読めません: acme/3')).length, 1)
    assert.match(lines.at(-1) ?? '', /^auto: judge=.*errors=0 learn=0$/)
  } finally {
    unreadable.cleanup()
  }
})
test('AU130b a Project read that exceeds the call cap is one line and not a tick error', () => {
  const f = runtimeFixture()
  const old = process.env.ORCA_AUTO_CALL_CAP_MS
  try {
    withProject(f)
    process.env.ORCA_AUTO_CALL_CAP_MS = '1000'
    f.hook('api_graphql', "trap '' TERM\nexec >/dev/null 2>&1\nsleep 10")
    const result = f.cli('tick')
    const lines = result.stdout.trim().split('\n')
    assert.equal(lines.filter((s) => s === 'Project を読めません: acme/3: 期限までに読めませんでした').length, 1)
    assert.equal(
      f
        .calls()
        .split('\n')
        .filter((s) => s.startsWith('api graphql')).length,
      1,
    )
    assert.match(lines.at(-1) ?? '', /^auto: judge=.*errors=0 learn=0$/)
  } finally {
    if (old === undefined) Reflect.deleteProperty(process.env, 'ORCA_AUTO_CALL_CAP_MS')
    else process.env.ORCA_AUTO_CALL_CAP_MS = old
    f.cleanup()
  }
})

test('MI7 an unreadable intake prints one line, counts as a tick error, and the other intake keeps syncing', () => {
  const f = runtimeFixture()
  try {
    const missing = join(f.dir, 'missing.json')
    const { intakeConfig, ...rest } = f.raw
    f.put(f.configFile, { ...rest, intakeConfigs: [intakeConfig, missing, missing] }) // 同じパスが 2 回でも 1 行・errors=1
    const result = f.cli('tick')
    const lines = result.stdout.trim().split('\n')
    assert.deepEqual(
      lines.filter((s) => s.startsWith('intake の設定を読めません: ')),
      [`intake の設定を読めません: ${missing}`],
    )
    assert.match(lines.at(-1) ?? '', /^auto: judge=.*errors=1 learn=0$/)
    assert.ok(
      f
        .calls()
        .split('\n')
        .some((s) => s.startsWith('issue list') && s.includes('acme/app')),
    )
  } finally {
    f.cleanup()
  }
})
