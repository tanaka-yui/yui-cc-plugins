import { envArgs, hostAvailableMemoryMb, hostKey, hostsOf, parseHosts, recordedOrcaBin } from '../../lib/auto-hosts.ts'
import { fixture } from '../lib/auto-fixture.ts'

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { test } from 'node:test'

import type { HostConfig } from '../../lib/auto-hosts.ts'
import type { Json } from '../../lib/json.ts'

test('HC1/HC2 defaults preserve C2a and explicit hosts keep configuration order', () => {
  const f = fixture()
  try {
    const local = hostsOf(f.config())
    assert.equal(local.length, 1)
    assert.equal(local[0]?.id, 'local')
    assert.equal(local[0]?.lanes, 1)
    assert.equal(local[0]?.repos['acme/app']?.selector, `path:${f.raw.repos['acme/app'].checkout}`)
    const hosts: HostConfig[] = [
      { id: 'local', name: 'Mac', lanes: 2, orcaBin: 'orca', repos: {}, spec: null },
      {
        id: 'env-1',
        name: 'Server',
        lanes: 3,
        orcaBin: 'orca-ide',
        spec: null,
        repos: { 'acme/app': { selector: 'id:R', verified: true, measure: null } },
      },
    ]
    f.put(f.configFile, { ...f.raw, hosts })
    assert.deepEqual(hostsOf(f.config()), hosts)
  } finally {
    f.cleanup()
  }
})

test('HC3 invalid host settings fail closed', () => {
  const f = fixture()
  try {
    const h = {
      id: 'env-1',
      name: 'Server',
      lanes: 2,
      orcaBin: 'orca',
      repos: { 'acme/app': { selector: 'id:R', verified: true } },
    }
    for (const hosts of [
      [],
      {},
      [h, h],
      [
        { ...h, id: 'local' },
        { ...h, id: 'local' },
      ],
      [{ ...h, lanes: 0 }],
      [{ ...h, name: '' }],
      [{ ...h, id: '' }],
      [{ ...h, orcaBin: '' }],
      [{ ...h, repos: { missing: { selector: 'id:R' } } }],
      [{ ...h, repos: { constructor: { selector: 'id:R' } } }],
      [{ ...h, repos: { 'acme/app': { selector: '' } } }],
      [{ ...h, repos: { 'acme/app': { selector: 'id:R', verified: 'yes' } } }],
      [{ ...h, repos: { 'acme/app': { selector: 'id:R', verified: null } } }],
    ]) {
      f.put(f.configFile, { ...f.raw, hosts })
      assert.throws(() => f.config(), JSON.stringify(hosts))
    }
    f.put(f.configFile, { ...f.raw, hosts: [{ ...h, repos: { 'acme/app': { selector: 'id:R' } } }] })
    assert.equal(hostsOf(f.config())[0]?.repos['acme/app']?.verified, false)
  } finally {
    f.cleanup()
  }
})

test('HC4/HC5 environment arguments and host identity separate identical paths', () => {
  assert.deepEqual(envArgs('local'), [])
  assert.deepEqual(envArgs('env-1'), ['--environment', 'env-1'])
  assert.notEqual(hostKey('local', '/p'), hostKey('env-1', '/p'))
})

test('SU1 hosts spec is optional and validated', () => {
  const f = fixture()
  try {
    const host = { id: 'local', name: 'Mac', lanes: 1, orcaBin: 'orca', repos: {} }
    f.put(f.configFile, { ...f.raw, hosts: [host] })
    assert.equal(f.config().hosts?.[0]?.spec, null)
    const spec = {
      cpus: 4,
      memoryTotalMb: 16384,
      memoryFreeMb: 4096,
      swapTotalMb: 0,
      diskFreeMb: 20480,
      measuredAt: '2026-11-17T00:00:00Z',
    }
    for (const value of [null, spec]) {
      f.put(f.configFile, { ...f.raw, hosts: [{ ...host, spec: value }] })
      assert.deepEqual(f.config().hosts?.[0]?.spec, value)
    }
    for (const invalid of [
      { ...spec, cpus: 0 },
      { ...spec, memoryTotalMb: '1' },
      { ...spec, memoryFreeMb: -1 },
      { ...spec, measuredAt: null },
      { ...spec, measuredAt: '' },
      { ...spec, measuredAt: 'bad' },
    ]) {
      f.put(f.configFile, { ...f.raw, hosts: [{ ...host, spec: invalid }] })
      assert.throws(() => f.config())
    }
  } finally {
    f.cleanup()
  }
})

test('SV9 measure parses, defaults to null, and rejects bad shapes', () => {
  const f = fixture()
  try {
    const measure = { peakMemoryMb: 900, diskGrowthMb: 0, measuredAt: '2026-11-17T00:00:00Z' }
    const host = (value: Json) => [
      {
        id: 'env-1',
        name: 'Server',
        lanes: 1,
        orcaBin: 'orca',
        repos: { 'acme/app': { selector: 'id:R', verified: true, measure: value } },
      },
    ]
    for (const value of [null, measure]) {
      const r = parseHosts(host(value), f.config().repos)
      assert.ok(r.ok)
      assert.deepEqual(r.hosts?.[0]?.repos['acme/app']?.measure, value)
    }
    const absent = parseHosts(
      [{ id: 'env-1', name: 'Server', lanes: 1, orcaBin: 'orca', repos: { 'acme/app': { selector: 'id:R' } } }],
      f.config().repos,
    )
    assert.ok(absent.ok)
    assert.equal(absent.hosts?.[0]?.repos['acme/app']?.measure, null)
    for (const value of [
      'x',
      { ...measure, peakMemoryMb: 0 },
      { ...measure, diskGrowthMb: -1 },
      { ...measure, diskGrowthMb: 1.5 },
      { ...measure, measuredAt: 'x' },
      { ...measure, measuredAt: '' },
    ])
      assert.equal(parseHosts(host(value), f.config().repos).ok, false)
  } finally {
    f.cleanup()
  }
})

test('HC6 live available memory is read from the Orca diagnostics host block', () => {
  const mib = 1024 * 1024
  assert.equal(hostAvailableMemoryMb({ ok: true, result: { host: { availableMemory: 3 * mib + 5 } } }), 3)
  for (const json of [
    null,
    { ok: true, result: {} },
    { ok: true, result: { host: { availableMemory: 'x' } } },
    { ok: true, result: { host: { availableMemory: -1 } } },
  ] as Json[])
    assert.equal(hostAvailableMemoryMb(json), null)
})

// 2026-11-24: Linux の Orca が automation の precheck を起こす環境には ORCA_BIN も ORCA_CLI_COMMAND も無く、
// orcaBin() が macOS のアプリ同梱の path に落ちて、tick の orca の呼び出しが全部 ENOENT になった
test('HC7 recorded orca binary of the local host is used only when the environment names none', () => {
  const f = fixture()
  try {
    assert.equal(recordedOrcaBin(f.config(), {}), null)
    const hosts: HostConfig[] = [
      { id: 'env-1', name: 'Server', lanes: 3, orcaBin: 'remote-orca', repos: {}, spec: null },
      { id: 'local', name: 'EC2', lanes: 2, orcaBin: '/usr/bin/orca-ide', repos: {}, spec: null },
    ]
    f.put(f.configFile, { ...f.raw, hosts })
    assert.equal(recordedOrcaBin(f.config(), {}), '/usr/bin/orca-ide')
    assert.equal(recordedOrcaBin(f.config(), { ORCA_BIN: '', ORCA_CLI_COMMAND: '' }), '/usr/bin/orca-ide')
    assert.equal(recordedOrcaBin(f.config(), { ORCA_BIN: '/x/orca' }), null)
    assert.equal(recordedOrcaBin(f.config(), { ORCA_CLI_COMMAND: 'orca-ide' }), null)
    f.put(f.configFile, { ...f.raw, hosts: hosts.slice(0, 1) })
    assert.equal(recordedOrcaBin(f.config(), {}), null)
  } finally {
    f.cleanup()
  }
})

test('HC8 tick adopts the recorded orca binary and names a missing one instead of failing every call', () => {
  const f = fixture()
  try {
    const tick = (env: Record<string, string>) => {
      const base = { ...process.env, ...env }
      for (const key of ['ORCA_BIN', 'ORCA_CLI_COMMAND']) if (!(key in env)) Reflect.deleteProperty(base, key)
      return spawnSync(process.execPath, [resolve(import.meta.dirname, '../../bin/orca-auto.ts'), 'tick'], {
        encoding: 'utf8',
        env: base,
      })
    }
    const host = { id: 'local', name: 'EC2', lanes: 2, orcaBin: '/nonexistent/recorded-orca', repos: {}, spec: null }
    f.put(f.configFile, { ...f.raw, hosts: [host] })
    const recorded = tick({})
    assert.equal(recorded.status, 1)
    assert.match(recorded.stdout, /orca が見つかりません: \/nonexistent\/recorded-orca/)
    // 環境が名指しすれば、記録より環境が勝つ
    const named = tick({ ORCA_BIN: '/nonexistent/env-orca' })
    assert.match(named.stdout, /orca が見つかりません: \/nonexistent\/env-orca/)
  } finally {
    f.cleanup()
  }
})
