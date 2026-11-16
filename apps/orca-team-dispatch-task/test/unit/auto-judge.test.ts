import { autoDir } from '../../lib/auto-paths.ts'
import { syncIssues } from '../../lib/auto-queue.ts'
import { readState, releaseLock, takeLock, writeState } from '../../lib/auto-state.ts'
import { resumeTransition } from '../../lib/auto-transition.ts'
import { fixture } from '../lib/auto-fixture.ts'

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const setup = () => {
  const f = fixture()
  f.respond('issue_list', [{ number: 7, title: '題', labels: [], updatedAt: '2026-01-01' }])
  const s = readState('main')
  syncIssues(s, f.config().sources)
  writeState('main', s)
  const decision = (extra: object = {}) => [
    {
      key: 'acme/app#7',
      generation: 1,
      route: 'auto',
      targets: ['acme/app'],
      limitMinutes: 60,
      reason: '明確な修正です',
      ...extra,
    },
  ]
  const apply = (value = decision()) => {
    const file = join(f.dir, 'decisions.json')
    f.put(file, value)
    return f.cli('judge-apply', '--file', file)
  }
  return { ...f, decision, apply }
}
test('AU23 judge-list leases and publishes pending with exact decisions path', () => {
  const f = setup()
  try {
    const result = f.cli('judge-list')
    assert.equal(result.status, 0, result.stderr)
    const out = JSON.parse(result.stdout)
    assert.equal(out.issues.length, 2)
    assert.equal(out.checkouts['acme/app'], f.raw.repos['acme/app'].checkout)
    assert.equal(out.decisionsFile, join(autoDir('main'), 'judge/decisions.json'))
    assert.deepEqual(JSON.parse(readFileSync(join(autoDir('main'), 'judge/pending.json'), 'utf8')), out)
    assert.ok(readState('main').judgingSince)
  } finally {
    f.cleanup()
  }
})
test('AU24 auto queues without comments or labels; AU27 invalid rows are rejected', () => {
  const f = setup()
  try {
    for (const extra of [
      { generation: 0 },
      { limitMinutes: 241 },
      { targets: ['bad/repo'] },
      { route: 'wrong' },
      { reason: '' },
    ]) {
      const r = f.apply(f.decision(extra))
      assert.equal(r.status, 1, r.stderr)
      assert.equal(readState('main').issues['acme/app#7']?.phase, 'judging')
    }
    const result = f.apply()
    assert.equal(result.status, 0, result.stderr)
    const state = readState('main')
    assert.equal(state.issues['acme/app#7']?.phase, 'queued')
    assert.equal(state.judgingSince, null)
    assert.ok(!f.calls().includes('issue comment'))
    assert.ok(!f.calls().includes('issue edit'))
  } finally {
    f.cleanup()
  }
})
test('AU25/AU26 two target repositories queue without engineering comments or labels', () => {
  const f = setup()
  try {
    const r = f.apply(f.decision({ targets: ['acme/app', 'other/api'] }))
    assert.equal(r.status, 0, r.stderr)
    assert.equal(readState('main').issues['acme/app#7']?.phase, 'queued')
    assert.ok(!f.calls().includes('issue comment'))
    assert.ok(!f.calls().includes('issue edit'))
  } finally {
    f.cleanup()
  }
})

test('AU103 three targets go to engineering with a comment before labeling', () => {
  const f = setup()
  try {
    const raw = {
      ...f.raw,
      repos: { ...f.raw.repos, 'third/web': { ...f.raw.repos['other/api'], checkout: join(f.dir, 'checkout3') } },
      sources: f.raw.sources.map((s, i) => (i === 0 ? { ...s, related: [...s.related, 'third/web'] } : s)),
    }
    f.put(f.configFile, raw)
    const r = f.apply(f.decision({ targets: ['acme/app', 'other/api', 'third/web'] }))
    assert.equal(r.status, 0, r.stderr)
    const calls = f.calls()
    assert.ok(calls.indexOf('issue comment') < calls.indexOf('issue edit'))
    assert.ok(calls.includes('orca-auto:ready-eng:1:judged'))
    assert.equal(readState('main').issues['acme/app#7']?.phase, 'eng')
    assert.ok(readState('main').issues['acme/app#7']?.reason.includes('3 つ以上のリポジトリ'))
    assert.ok(calls.includes('Ready_Eng'))
  } finally {
    f.cleanup()
  }
})

test('AU103b targets deduplicate in first occurrence order before routing', () => {
  const f = setup()
  try {
    assert.equal(f.apply(f.decision({ targets: ['acme/app', 'acme/app'] })).status, 0)
    const issue = readState('main').issues['acme/app#7']
    assert.deepEqual(issue?.targets, ['acme/app'])
    assert.equal(issue?.phase, 'queued')
  } finally {
    f.cleanup()
  }
})
test('AU28 comment failure persists transition and never labels', () => {
  const f = setup()
  try {
    f.put(join(f.gh, 'issue_comment.rc'), 1)
    f.apply(f.decision({ route: 'eng' }))
    assert.ok(!f.calls().includes('issue edit'))
    assert.equal(readState('main').issues['acme/app#7']?.pendingLabel?.commented, false)
  } finally {
    f.cleanup()
  }
})
test('AU29 returned feature can queue; AU29b human status prevents engineering comment', () => {
  const f = setup()
  try {
    const s = readState('main')
    const i = s.issues['acme/app#7']
    assert.ok(i)
    i.category = 'feature'
    i.returnedFromEng = true
    writeState('main', s)
    assert.equal(f.apply().status, 0)
    assert.equal(readState('main').issues[i.key]?.phase, 'queued')
    i.phase = 'judging'
    writeState('main', s)
    f.respond('issue_view', { state: 'OPEN', title: '題', labels: [{ name: 'Pending' }] })
    f.apply(f.decision({ route: 'eng' }))
    assert.equal(readState('main').issues[i.key]?.phase, 'stopped')
    assert.ok(!f.calls().includes('issue comment'))
  } finally {
    f.cleanup()
  }
})
test('AU29c lock contention returns 3; AU29e effort is configurable', () => {
  const f = setup()
  try {
    assert.equal(takeLock('main', 10000), true)
    process.env.ORCA_AUTO_LOCK_WAIT_MS = '0'
    assert.equal(f.cli('judge-list').status, 3)
    releaseLock('main')
    assert.equal(f.cli('judge-effort').stdout.trim(), 'high')
    f.put(f.configFile, { ...f.raw, judge: { model: 'custom', effort: 'low' } })
    assert.equal(f.cli('judge-effort').stdout.trim(), 'low')
  } finally {
    Reflect.deleteProperty(process.env, 'ORCA_AUTO_LOCK_WAIT_MS')
    releaseLock('main')
    f.cleanup()
  }
})
test('AU29d stale generation decisions cannot resurrect a manually stopped issue', () => {
  const f = setup()
  try {
    const state = readState('main')
    f.respond('issue_list', [])
    f.respond('issue_view', { state: 'OPEN', title: '題', labels: [{ name: 'Pending' }] })
    syncIssues(state, f.config().sources)
    assert.equal(state.issues['acme/app#7']?.phase, 'stopped')
    f.respond('issue_list', [{ number: 7, title: '題', labels: [], updatedAt: '2026-01-01' }])
    f.respond('issue_view', { state: 'OPEN', title: '題', labels: [{ name: 'Ready' }] })
    syncIssues(state, f.config().sources)
    writeState('main', state)
    assert.equal(state.issues['acme/app#7']?.generation, 2)
    assert.equal(f.apply().status, 1)
    assert.equal(readState('main').issues['acme/app#7']?.phase, 'judging')
  } finally {
    f.cleanup()
  }
})
test('clear-start explicitly clears a persisted uncertain start and prints the old record', () => {
  const f = setup()
  try {
    const s = readState('main')
    const issue = s.issues['acme/app#7']
    assert.ok(issue)
    issue.phase = 'dispatching'
    issue.startAttempt = { at: '2026-11-13T05:00:00Z', pid: 123, host: 'host' }
    writeState('main', s)
    const result = f.cli('clear-start', '--key', issue.key)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).pid, 123)
    assert.equal(readState('main').issues[issue.key]?.startAttempt, null)
    assert.equal(f.cli('clear-start', '--key', issue.key).status, 1)
  } finally {
    f.cleanup()
  }
})

test('a non-closing pending label transition yields to a person closing the issue', () => {
  const f = setup()
  try {
    f.put(join(f.gh, 'issue_comment.rc'), 1)
    f.apply(f.decision({ route: 'eng' }))
    const state = readState('main')
    const issue = state.issues['acme/app#7']
    assert.ok(issue?.pendingLabel)
    issue.pendingLabel.commented = true
    f.respond('issue_view', { state: 'CLOSED', title: '題', labels: [{ name: 'Ready_Eng' }] })
    assert.equal(
      resumeTransition(issue, () => writeState('main', state)),
      false,
    )
    assert.equal(issue.phase, 'stopped')
    assert.equal(issue.pendingLabel, null)
  } finally {
    f.cleanup()
  }
})

test('AU29b closed engineering candidates disappear; fresh features are forced to engineering', () => {
  for (const closed of [true, false]) {
    const f = setup()
    try {
      const state = readState('main')
      const issue = state.issues['acme/app#7']
      assert.ok(issue)
      if (!closed) {
        issue.category = 'feature'
        writeState('main', state)
      } else f.respond('issue_view', { state: 'CLOSED', title: '題', labels: [] })
      f.apply(f.decision({ route: closed ? 'eng' : 'auto' }))
      const current = readState('main').issues[issue.key]
      assert.equal(current?.phase, closed ? undefined : 'eng')
      if (!closed) assert.ok(current?.reason.includes('新機能'))
    } finally {
      f.cleanup()
    }
  }
})
