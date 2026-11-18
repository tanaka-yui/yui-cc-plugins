import { hostsOf } from '../../lib/auto-hosts.ts'
import { buildReport } from '../../lib/auto-report.ts'
import { readState, writeState } from '../../lib/auto-state.ts'
import { runtimeFixture } from '../lib/auto-runtime-fixture.ts'

import assert from 'node:assert/strict'
import { hostname } from 'node:os'
import { test } from 'node:test'

test('RP1-3 report preserves the shared contract, excludes judging and orders queued items', () => {
  const f = runtimeFixture()
  try {
    const a = f.track('running', 7)
    f.track('queued', 8)
    f.track('queued', 9)
    const s = readState('main')
    const queued = s.issues['acme/app#8']
    assert.ok(queued)
    queued.phase = 'queued'
    const i = s.issues['acme/app#9']
    assert.ok(i)
    i.priority = 'critical'
    const j = { ...i, key: 'acme/app#10', number: 10, phase: 'judging' as const }
    s.issues[j.key] = j
    writeState('main', s)
    const host = hostsOf(f.config())[0]
    assert.ok(host)
    const r = buildReport(f.config(), s, [{ host, used: 3, reachable: true }], '2026-11-13T05:30:00Z')
    assert.deepEqual(
      Object.keys(r).sort(),
      ['version', 'name', 'updatedAt', 'everyMinutes', 'running', 'queue', 'hosts'].sort(),
    )
    assert.deepEqual(r.running, [
      { issue: a.key, title: '題', host: hostname(), startedAt: '2026-11-13T05:00:00Z', limitMinutes: 60 },
    ])
    assert.deepEqual(
      r.queue.map((q) => q.issue),
      ['acme/app#9', 'acme/app#8'],
    )
    assert.deepEqual(r.hosts, [{ name: hostname(), used: 3, max: 1, reachable: true }])
  } finally {
    f.cleanup()
  }
})

test('RP4-6 reports every host capacity and maps running issues to their host names without changing contract keys', () => {
  const f = runtimeFixture()
  try {
    const i = f.track('running')
    const state = readState('main')
    const issue = state.issues[i.key]
    assert.ok(issue)
    issue.host = 'env-1'
    const local = hostsOf(f.config())[0]
    assert.ok(local)
    const remote = { id: 'env-1', name: 'Mac M2max', lanes: 4, orcaBin: 'orca', repos: {}, spec: null }
    const report = buildReport(
      f.config(),
      state,
      [
        { host: local, used: 1, reachable: true },
        { host: remote, used: 2, reachable: false },
      ],
      '2026-11-13T05:30:00Z',
    )
    assert.deepEqual(report.hosts, [
      { name: hostname(), used: 1, max: 1, reachable: true },
      { name: 'Mac M2max', used: 2, max: 4, reachable: false },
    ])
    assert.equal(report.running[0]?.host, 'Mac M2max')
    assert.deepEqual(
      Object.keys(report).sort(),
      ['version', 'name', 'updatedAt', 'everyMinutes', 'running', 'queue', 'hosts'].sort(),
    )
    assert.deepEqual(Object.keys(report.hosts[0] ?? {}).sort(), ['name', 'used', 'max', 'reachable'].sort())
    assert.deepEqual(
      Object.keys(report.running[0] ?? {}).sort(),
      ['issue', 'title', 'host', 'startedAt', 'limitMinutes'].sort(),
    )
  } finally {
    f.cleanup()
  }
})

test('RP7 report uses the effective limit with unchanged contract keys', () => {
  const f = runtimeFixture()
  try {
    const i = f.track('running')
    const state = readState('main')
    const issue = state.issues[i.key]
    assert.ok(issue)
    issue.relayMinutes = 55
    const host = hostsOf(f.config())[0]
    assert.ok(host)
    const report = buildReport(f.config(), state, [{ host, used: 1, reachable: true }], '2026-11-13T06:01:00Z')
    assert.equal(report.running[0]?.limitMinutes, 115)
    assert.deepEqual(Object.keys(report.running[0] ?? {}), ['issue', 'title', 'host', 'startedAt', 'limitMinutes'])
  } finally {
    f.cleanup()
  }
})
