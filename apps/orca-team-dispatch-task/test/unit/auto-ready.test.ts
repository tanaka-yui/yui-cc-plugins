import { parseAutoConfig } from '../../lib/auto-config.ts'
import { syncIssues } from '../../lib/auto-queue.ts'
import { readState, writeState } from '../../lib/auto-state.ts'
import { configJsonFromDraft, draftFromConfig } from '../../lib/setup-draft.ts'
import { fixture } from '../lib/auto-fixture.ts'
import { runtimeFixture } from '../lib/auto-runtime-fixture.ts'

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import type { AutoState } from '../../lib/auto-state.ts'

const empty = (): AutoState => ({ version: 1, judgingSince: null, issues: {}, projectSync: {} })
const row = (number: number, labels: string[], createdAt = '2026-11-13T06:00:00Z') => ({
  number,
  title: `題${number}`,
  labels: labels.map((name) => ({ name })),
  updatedAt: createdAt,
  createdAt,
})
// Ready と Backlog の一覧を別々に返す。gh のスタブは同じ鍵（issue_list）なので、hook で応答を差し替える
const lists = (f: ReturnType<typeof fixture>, ready: object[], backlog: object[]) => {
  f.put(join(f.dir, 'ready.json'), ready as never)
  f.put(join(f.dir, 'backlog.json'), backlog as never)
  f.hook(
    'issue_list',
    `case "$*" in *"--label Backlog"*) cp '${f.dir}/backlog.json' "$GH_STUB_DIR/issue_list" ;; *) cp '${f.dir}/ready.json' "$GH_STUB_DIR/issue_list" ;; esac`,
  )
}
const autoReadyConfig = (f: ReturnType<typeof fixture>) => {
  f.put(f.configFile, {
    ...f.raw,
    sources: f.raw.sources.map((s, i) => (i === 0 ? { ...s, autoReady: true } : s)),
  })
  return f.config()
}

test('AR1 auto-ready starts counting when first seen and picks only new Backlog-only issues', () => {
  const f = fixture()
  try {
    const config = autoReadyConfig(f)
    lists(f, [], [row(1, ['Backlog'])])
    const s = empty()
    // 最初の同期は有効にした時刻を記録するだけで、それまでの Backlog は拾わない
    assert.deepEqual(syncIssues(s, config.sources).added, [])
    assert.equal(s.autoReadySince?.['acme/app'], '2026-11-13T05:30:00Z')
    assert.ok(!f.calls().includes('--label Backlog'))
    lists(
      f,
      [],
      [
        row(1, ['Backlog']),
        row(2, ['Backlog'], '2026-11-13T05:00:00Z'),
        row(3, ['Backlog', 'Pending']),
        row(4, ['Backlog', 'priority: high']),
      ],
    )
    const result = syncIssues(s, config.sources)
    assert.deepEqual(result.added.sort(), ['acme/app#1', 'acme/app#4'])
    assert.equal(s.issues['acme/app#1']?.autoReady, true)
    assert.equal(s.issues['acme/app#1']?.phase, 'judging')
    assert.equal(s.issues['acme/app#4']?.priority, 'high')
    // other/api は auto-ready ではないので Backlog を読まない
    assert.ok(!/other\/api --state open --label Backlog/.test(f.calls()))
    // 状態に記録のある Issue は拾い直さない
    Object.assign(s.issues['acme/app#1'] ?? {}, { phase: 'stopped' })
    syncIssues(s, config.sources)
    assert.equal(s.issues['acme/app#1']?.phase, 'stopped')
    // 外すと時刻も消え、もう一度有効にした時点から数え直す
    syncIssues(
      s,
      f.config().sources.map((src) => ({ ...src, autoReady: false })),
    )
    assert.equal(s.autoReadySince?.['acme/app'], undefined)
  } finally {
    f.cleanup()
  }
})

test('AR2 judging Backlog issues follow human label changes and auto-ready being turned off', () => {
  const f = fixture()
  try {
    const config = autoReadyConfig(f)
    const s = empty()
    lists(f, [], [])
    syncIssues(s, config.sources)
    lists(f, [], [row(1, ['Backlog']), row(2, ['Backlog']), row(3, ['Backlog'])])
    syncIssues(s, config.sources)
    lists(f, [], [])
    const view = (labels: string[]) =>
      f.respond('issue_view', { state: 'OPEN', labels: labels.map((name) => ({ name })), title: '題' })
    view(['Backlog'])
    syncIssues(s, config.sources)
    assert.equal(s.issues['acme/app#1']?.phase, 'judging')
    assert.equal(s.issues['acme/app#1']?.autoReady, true)
    // 人が Ready にした → 通常の Issue
    view(['Ready'])
    syncIssues(s, config.sources)
    assert.equal(s.issues['acme/app#1']?.phase, 'judging')
    assert.equal(s.issues['acme/app#1']?.autoReady, false)
    // 人が Pending にした → 止める
    view(['Pending'])
    syncIssues(s, config.sources)
    assert.equal(s.issues['acme/app#2']?.phase, 'stopped')
    // スタブの issue_view は全 Issue に効くので、#3 だけ判定待ちの auto-ready に戻す
    Object.assign(s.issues['acme/app#3'] ?? {}, { phase: 'judging', autoReady: true })
    // auto-ready を外した → 判定待ちの Backlog は記録から外す（人が Ready にした #1 は止まる）
    view(['Backlog'])
    const off = syncIssues(
      s,
      config.sources.map((src) => ({ ...src, autoReady: false })),
    )
    assert.ok(off.dropped.includes('acme/app#3'))
    assert.equal(s.issues['acme/app#3'], undefined)
  } finally {
    f.cleanup()
  }
})

const judged = (f: ReturnType<typeof fixture>, labels: string[]) => {
  const config = autoReadyConfig(f)
  const s = empty()
  lists(f, [], [])
  syncIssues(s, config.sources)
  lists(f, [], [row(7, ['Backlog'])])
  syncIssues(s, config.sources)
  writeState('main', s)
  lists(f, [], [])
  f.respond('issue_view', { state: 'OPEN', labels: labels.map((name) => ({ name })), title: '題', body: '本文' })
  return (route: string, extra: object = {}) => {
    const file = join(f.dir, 'decisions.json')
    f.put(file, [
      {
        key: 'acme/app#7',
        generation: 1,
        route,
        targets: ['acme/app'],
        limitMinutes: 30,
        reason: '誤字を直すだけです',
        ...extra,
      },
    ])
    return f.cli('judge-apply', '--file', file)
  }
}

test('AR3 judge-list marks auto-ready issues; auto moves Backlog to Ready with a comment first', () => {
  const f = fixture()
  try {
    const apply = judged(f, ['Backlog'])
    const listed = f.cli('judge-list')
    assert.equal(listed.status, 0, listed.stderr)
    assert.equal(JSON.parse(listed.stdout).issues[0]?.autoReady, true)
    const r = apply('auto')
    assert.equal(r.status, 0, r.stderr)
    const calls = f.calls()
    assert.ok(calls.includes('orca-auto:ready:1:auto-ready'))
    assert.ok(calls.indexOf('issue comment') < calls.indexOf('issue edit'))
    assert.match(calls, /--add-label Ready --remove-label Backlog/)
    const issue = readState('main').issues['acme/app#7']
    assert.equal(issue?.phase, 'queued')
    assert.equal(issue?.autoReady, true)
    assert.equal(issue?.pendingLabel, null)
  } finally {
    f.cleanup()
  }
})

test('AR4 eng moves a Backlog issue to Ready_Eng', () => {
  const f = fixture()
  try {
    const r = judged(f, ['Backlog'])('eng')
    assert.equal(r.status, 0, r.stderr)
    assert.ok(f.calls().includes('orca-auto:ready-eng:1:judged'))
    assert.match(f.calls(), /--add-label Ready_Eng --remove-label Backlog/)
    assert.equal(readState('main').issues['acme/app#7']?.phase, 'eng')
  } finally {
    f.cleanup()
  }
})

test('AR5 a person making the issue Ready during judging turns it into a normal issue', () => {
  const f = fixture()
  try {
    const r = judged(f, ['Ready'])('auto')
    assert.equal(r.status, 0, r.stderr)
    const issue = readState('main').issues['acme/app#7']
    assert.equal(issue?.phase, 'queued')
    assert.equal(issue?.autoReady, false)
    assert.ok(!f.calls().includes('issue comment'))
  } finally {
    f.cleanup()
  }
})

test('AR6 a Backlog issue moved elsewhere during judging is stopped without comments', () => {
  const f = fixture()
  try {
    const r = judged(f, ['Pending'])('auto')
    assert.equal(r.status, 0, r.stderr)
    assert.equal(readState('main').issues['acme/app#7']?.phase, 'stopped')
    assert.ok(!f.calls().includes('issue comment'))
  } finally {
    f.cleanup()
  }
})

test('AR7 config: autoReady defaults false, needs pick Ready, and is written only when true', () => {
  const base = {
    version: 1,
    name: 'main',
    repos: { 'acme/app': { checkout: '/x' } },
    sources: [{ repo: 'acme/app', related: ['acme/app'] }],
  }
  assert.equal(parseAutoConfig(base, 'main')?.sources[0]?.autoReady, false)
  const on = { ...base, sources: [{ ...base.sources[0], autoReady: true }] }
  assert.equal(parseAutoConfig(on, 'main')?.sources[0]?.autoReady, true)
  assert.equal(parseAutoConfig({ ...base, sources: [{ ...base.sources[0], autoReady: 'yes' }] }, 'main'), null)
  assert.equal(
    parseAutoConfig({ ...base, sources: [{ ...base.sources[0], autoReady: true, pick: 'Todo' }] }, 'main'),
    null,
  )
  for (const [value, written] of [
    [base, undefined],
    [on, true],
  ] as const) {
    const config = parseAutoConfig(value, 'main')
    if (!config) throw new Error('config')
    const json = configJsonFromDraft(draftFromConfig(config), null)
    assert.equal((json?.sources as Array<Record<string, unknown>>)[0]?.autoReady, written)
  }
})

test('AR8 an auto-ready issue is never merged by AI even when every check passes', () => {
  const f = runtimeFixture()
  try {
    const i = f.track('finishing')
    const s = readState('main')
    const issue = s.issues[i.key]
    if (!issue) throw new Error('issue')
    issue.autoReady = true
    writeState('main', s)
    f.result(i, { needsReview: [] })
    f.cli('tick')
    assert.equal(readState('main').issues[i.key]?.phase, 'review')
    assert.ok(!f.calls().includes('pr merge'))
    assert.ok(f.calls().includes('orca-auto:in-review:1:needs-review'))
  } finally {
    f.cleanup()
  }
})

test('AR9 config: autoMerge defaults false, needs autoReady, and is written only when true', () => {
  const base = {
    version: 1,
    name: 'main',
    repos: { 'acme/app': { checkout: '/x' } },
    sources: [{ repo: 'acme/app', related: ['acme/app'] }],
  }
  const withSource = (extra: object) => ({ ...base, sources: [{ ...base.sources[0], ...extra }] })
  assert.equal(parseAutoConfig(base, 'main')?.sources[0]?.autoMerge, false)
  assert.equal(parseAutoConfig(withSource({ autoReady: true }), 'main')?.sources[0]?.autoMerge, false)
  assert.equal(parseAutoConfig(withSource({ autoMerge: true }), 'main'), null)
  assert.equal(parseAutoConfig(withSource({ autoReady: false, autoMerge: true }), 'main'), null)
  assert.equal(parseAutoConfig(withSource({ autoReady: true, autoMerge: 'yes' }), 'main'), null)
  const on = withSource({ autoReady: true, autoMerge: true })
  assert.equal(parseAutoConfig(on, 'main')?.sources[0]?.autoMerge, true)
  for (const [value, written] of [
    [withSource({ autoReady: true }), undefined],
    [on, true],
  ] as const) {
    const config = parseAutoConfig(value, 'main')
    if (!config) throw new Error('config')
    const json = configJsonFromDraft(draftFromConfig(config), null)
    assert.equal((json?.sources as Array<Record<string, unknown>>)[0]?.autoMerge, written)
  }
})
