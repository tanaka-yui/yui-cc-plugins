import {
  addRepo,
  checkoutProblem,
  checkRemoteRepo,
  hostReachable,
  listHostChoices,
  listRemoteRepos,
  measureLocal,
  probeCommand,
  probeRemote,
  repoDefaults,
  runVerifyLocal,
  swapWarning,
} from '../../lib/setup-host.ts'
import { fixture } from '../lib/auto-fixture.ts'

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const now = '2026-11-17T00:00:00Z'
const spec = {
  cpus: 12,
  memoryTotalMb: 65536,
  memoryFreeMb: 32768,
  swapTotalMb: 0,
  diskFreeMb: 102400,
  measuredAt: now,
}
const git = (path: string, ...args: string[]) => {
  const result = spawnSync('git', ['-C', path, ...args], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
test('SU15 host choices exclude SSH and use local machineName', () => {
  const f = fixture()
  try {
    f.respond(
      'host_list',
      {
        ok: true,
        result: {
          hosts: [
            { id: 'local', name: 'this machine', machineName: 'Test Mac', kind: 'local' },
            { id: 'ssh', name: 'SSH', kind: 'ssh' },
            { id: 'env-1', name: 'Server', kind: 'environment' },
          ],
        },
      },
      f.orca,
    )
    assert.deepEqual(listHostChoices(), [
      { id: 'local', name: 'Test Mac', kind: 'local' },
      { id: 'env-1', name: 'Server', kind: 'environment' },
    ])
    f.respond('status', { ok: true, result: { runtime: { reachable: true } } }, f.orca)
    assert.equal(hostReachable('env-1'), true)
    f.respond('status', { ok: true, result: {} }, f.orca)
    assert.equal(hostReachable('env-1'), false)
  } finally {
    f.cleanup()
  }
})
test('SU16 local measurement and SU16b encoded probe execute without real gh', () => {
  const f = fixture()
  try {
    const local = measureLocal(now)
    assert.equal(local.measuredAt, now)
    assert.equal(local.cpus, availableParallelism())
    for (const key of ['memoryTotalMb', 'memoryFreeMb', 'swapTotalMb', 'diskFreeMb'] as const) {
      assert.ok(Number.isInteger(local[key]) && local[key] >= 0)
    }
    const command = probeCommand()
    const result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const match = result.stdout.match(/@@orca-auto-probe:begin@@(.+)@@orca-auto-probe:end@@/)
    assert.ok(match?.[1])
    const value = JSON.parse(match[1])
    assert.equal(value.cpus, availableParallelism())
    assert.equal(value.ghAuthOk, true)
    for (const key of ['platform', 'memoryTotalMb', 'memoryFreeMb', 'swapTotalMb', 'diskFreeMb', 'orcaBin'])
      assert.ok(key in value)
    assert.ok(!command.match(/Buffer.from\('([^']*)'/)?.[1]?.includes("'"))
  } finally {
    f.cleanup()
  }
})
test('SU16c swap warning excludes macOS', () => {
  assert.equal(swapWarning(spec, 'darwin'), false)
  assert.equal(swapWarning(spec, 'linux'), true)
  assert.equal(swapWarning({ ...spec, swapTotalMb: 2048 }, 'linux'), false)
})
test('SU17 remote probe rejoins wrapped output and always closes a created terminal', () => {
  const f = fixture()
  process.env.ORCA_AUTO_PROBE_INTERVAL_MS = '0'
  try {
    f.respond('terminal_create', { ok: true, result: { terminal: { handle: 'term_p' } } }, f.orca)
    const value = JSON.stringify({ ...spec, platform: 'darwin', orcaBin: '/bin/orca', ghAuthOk: true })
    f.respond(
      'terminal_read',
      {
        ok: true,
        result: {
          terminal: {
            tail: [
              'echoed command',
              `@@orca-auto-probe:begin@@${value.slice(0, 40)}`,
              `${value.slice(40)}@@orca-auto-probe:end@@`,
              'prompt',
            ],
          },
        },
      },
      f.orca,
    )
    assert.deepEqual(probeRemote('env-1', 'path:/checkout', now), {
      spec,
      platform: 'darwin',
      orcaBin: '/bin/orca',
      ghAuthOk: true,
    })
    const calls = readFileSync(join(f.orca, 'argv.log'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.split('\x1f'))
    assert.equal(calls.length, 3)
    for (const args of calls) assert.equal(args[args.indexOf('--environment') + 1], 'env-1')
    assert.ok(f.calls(f.orca).includes('terminal close'))
    f.respond('terminal_read', { ok: true, result: { terminal: { tail: ['no json'] } } }, f.orca)
    assert.deepEqual(probeRemote('env-1', 'path:/checkout', now), {
      spec: null,
      platform: null,
      orcaBin: null,
      ghAuthOk: null,
    })
    writeFileSync(join(f.orca, 'calls.log'), '')
    writeFileSync(join(f.orca, 'terminal_create.rc'), '1')
    assert.equal(probeRemote('env-1', 'path:/checkout', now).spec, null)
    assert.ok(!f.calls(f.orca).includes('terminal close'))
  } finally {
    Reflect.deleteProperty(process.env, 'ORCA_AUTO_PROBE_INTERVAL_MS')
    f.cleanup()
  }
})
test('SU18 checkout validation and SU19b verification keep the checkout clean', () => {
  const f = fixture()
  try {
    const path = f.raw.repos['acme/app'].checkout
    mkdirSync(path)
    assert.ok(checkoutProblem('acme/app', 'relative'))
    assert.ok(checkoutProblem('acme/app', path))
    git(path, 'init', '-q')
    git(path, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '--allow-empty', '-qm', 'init')
    git(path, 'remote', 'add', 'origin', 'git@github.com.alias:acme/app.git')
    assert.equal(checkoutProblem('acme/app', path), null)
    mkdirSync(join(path, 'sub'))
    assert.ok(checkoutProblem('acme/app', join(path, 'sub')))
    assert.ok(checkoutProblem('other/api', path))
    assert.deepEqual(repoDefaults(path), { infra: false, ci: false })
    writeFileSync(join(path, 'main.tf'), '')
    mkdirSync(join(path, '.github/workflows'), { recursive: true })
    writeFileSync(join(path, '.github/workflows/ci.yml'), '')
    assert.ok(checkoutProblem('acme/app', path))
    git(path, 'add', 'main.tf', '.github/workflows/ci.yml')
    git(path, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'fixtures')
    assert.deepEqual(repoDefaults(path), { infra: true, ci: true })
    for (const [commands, want] of [
      [['touch generated', 'false'], { ok: false, failed: 'false' }],
      [['touch generated', 'true'], { ok: true, failed: null }],
    ] as const) {
      assert.deepEqual(runVerifyLocal(path, [...commands]), want)
      assert.equal(git(path, 'worktree', 'list').split('\n').length, 1)
      assert.equal(git(path, 'status', '--porcelain'), '')
    }
    // SU19e: 端末につないだまま走らせても、git などがページャを開いて止まらない
    const pager = process.env.PAGER
    process.env.PAGER = 'less'
    try {
      assert.deepEqual(runVerifyLocal(path, ['test "$GIT_PAGER" = cat && test "$PAGER" = cat']), {
        ok: true,
        failed: null,
      })
    } finally {
      if (pager === undefined) Reflect.deleteProperty(process.env, 'PAGER')
      else process.env.PAGER = pager
    }
  } finally {
    f.cleanup()
  }
})
test('SU19 registration selectors, existing local path, and receipt fallback', () => {
  const f = fixture()
  try {
    f.respond('repo_list', { ok: true, result: { repos: [{ id: 'L', path: f.dir }] } }, f.orca)
    assert.equal(addRepo('local', f.dir), `path:${f.dir}`)
    assert.ok(!f.calls(f.orca).includes('repo add'))
    f.respond('repo_add', { ok: true, result: { repo: { id: 'R' } } }, f.orca)
    assert.equal(addRepo('local', '/new'), 'path:/new')
    assert.equal(addRepo('env-1', '/new'), 'id:R')
    f.respond('repo_add', { ok: true, result: {} }, f.orca)
    f.respond('repo_list', { ok: true, result: { repos: [{ id: 'R2', path: '/new' }] } }, f.orca)
    assert.equal(addRepo('env-1', '/new'), 'id:R2')
  } finally {
    f.cleanup()
  }
})
test('SU19c and SU19d remote identity is checked case insensitively', () => {
  const f = fixture()
  try {
    for (const [canonicalKey, want] of [
      ['github.com/Acme/App', 'match'],
      ['github.com/acme/other', 'mismatch'],
      ['', 'unknown'],
    ] as const) {
      f.respond(
        'repo_list',
        { ok: true, result: { repos: [{ id: 'R', path: '/repo', gitRemoteIdentity: { canonicalKey } }] } },
        f.orca,
      )
      assert.deepEqual(listRemoteRepos('env-1'), [
        { id: 'R', path: '/repo', repo: canonicalKey ? canonicalKey.slice('github.com/'.length) : null },
      ])
      assert.equal(checkRemoteRepo('env-1', 'id:R', 'acme/app'), want)
    }
    assert.equal(checkRemoteRepo('env-1', 'id:missing', 'acme/app'), 'unknown')
    writeFileSync(join(f.orca, 'repo_list.rc'), '1')
    assert.equal(checkRemoteRepo('env-1', 'id:R', 'acme/app'), 'unknown')
  } finally {
    f.cleanup()
  }
})
