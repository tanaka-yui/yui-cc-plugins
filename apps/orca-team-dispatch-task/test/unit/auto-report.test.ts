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
    const r = buildReport(f.config(), s, 3, '2026-11-13T05:30:00Z')
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
