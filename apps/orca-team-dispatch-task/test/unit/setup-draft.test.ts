import { parseAutoConfig } from '../../lib/auto-config.ts'
import { readState } from '../../lib/auto-state.ts'
import { asArray, asObject, get } from '../../lib/json.ts'
import {
  configJsonFromDraft,
  draftFromConfig,
  inUseConflicts,
  readDraft,
  removeDraft,
  writeDraft,
} from '../../lib/setup-draft.ts'
import { fixture } from '../lib/auto-fixture.ts'

import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import type { JsonObject } from '../../lib/json.ts'

test('SU5 draft round trip and corrupt or malformed drafts are rejected', () => {
  const f = fixture()
  try {
    const draft = draftFromConfig(f.config())
    draft.done = ['prereq']
    writeDraft(draft)
    assert.deepEqual(readDraft('main'), draft)
    const file = join(f.dir, 'config/auto/main/setup.json')
    for (const invalid of [
      '{',
      JSON.stringify({ ...draft, version: 2 }),
      JSON.stringify({ ...draft, name: 'other' }),
      JSON.stringify({ ...draft, done: [1] }),
      JSON.stringify({ ...draft, values: { sources: 'bad' } }),
    ]) {
      writeFileSync(file, invalid)
      assert.equal(readDraft('main'), null)
    }
    for (const lanes of [0, 1.5, '2']) {
      f.put(file, { ...draft, values: { lanes } })
      assert.equal(readDraft('main'), null, 'SU5b')
    }
    removeDraft('main')
    assert.equal(existsSync(file), false)
  } finally {
    f.cleanup()
  }
})
test('SU6 config round trips with and without hosts and preserves global lanes', () => {
  const f = fixture()
  try {
    for (const hosts of [
      undefined,
      [
        { id: 'local', name: 'Mac', lanes: 2, orcaBin: 'orca', repos: {} as JsonObject },
        {
          id: 'env-1',
          name: 'Server',
          lanes: 3,
          orcaBin: 'orca-ide',
          repos: { 'acme/app': { selector: 'id:R', verified: true } },
        },
      ],
    ]) {
      const base = { ...f.raw, lanes: 2, ...(hosts ? { hosts } : {}) }
      f.put(f.configFile, base)
      const config = f.config()
      const draft = draftFromConfig(config)
      assert.deepEqual(draft.done, [])
      assert.equal(draft.values.lanes, hosts ? undefined : 2)
      const json = configJsonFromDraft(draft, base)
      assert.ok(json)
      assert.deepEqual(parseAutoConfig(json, 'main'), config)
    }
  } finally {
    f.cleanup()
  }
})
test('SU7 base keys survive and null project/spec keys are omitted', () => {
  const f = fixture()
  try {
    const base = {
      ...f.raw,
      limits: { defaultMinutes: 20, maxMinutes: 40, stallMinutes: 10 },
      judge: { model: 'custom', effort: 'high' },
      extra: 'keep',
    }
    const draft = draftFromConfig(f.config())
    draft.values.hosts = [{ id: 'local', name: 'Mac', lanes: 1, orcaBin: 'orca', repos: {}, spec: null }]
    const json = configJsonFromDraft(draft, base)
    assert.ok(json)
    assert.deepEqual(json.limits, base.limits)
    assert.deepEqual(json.judge, base.judge)
    assert.equal(json.extra, 'keep')
    assert.equal('project' in JSON.parse(JSON.stringify(json)).sources[0], false)
    assert.equal('spec' in JSON.parse(JSON.stringify(json)).hosts[0], false, 'SU7b')
  } finally {
    f.cleanup()
  }
})
test('SU8 invalid related repositories cannot become a config', () => {
  const f = fixture()
  try {
    const draft = draftFromConfig(f.config())
    assert.ok(draft.values.sources?.[0])
    draft.values.sources[0].related = ['missing/repo']
    assert.equal(configJsonFromDraft(draft, f.raw), null)
  } finally {
    f.cleanup()
  }
})
test('SU9 and SU9b active issues protect source, host, target and host repository', () => {
  const f = fixture()
  try {
    f.put(join(f.dir, 'config/auto/main/state.json'), {
      version: 1,
      judgingSince: null,
      issues: {
        'acme/app#1': {
          key: 'acme/app#1',
          repo: 'acme/app',
          generation: 1,
          phase: 'running',
          host: 'env-1',
          targets: ['acme/app'],
          prs: [],
        },
      },
    })
    const state = readState('main')
    const draft = draftFromConfig(f.config())
    draft.values.hosts = [
      {
        id: 'env-1',
        name: 'Server',
        lanes: 1,
        orcaBin: 'orca',
        spec: null,
        repos: { 'acme/app': { selector: 'id:R', verified: false, measure: null } },
      },
    ]
    const next = configJsonFromDraft(draft, f.raw)
    assert.ok(next)
    assert.deepEqual(inUseConflicts(state, next), [])
    assert.deepEqual(inUseConflicts(state, { ...next, hosts: [{ ...draft.values.hosts[0], repos: {} }] }), [
      'acme/app#1 がマシン env-1 のリポジトリ acme/app を使っています',
    ])
    assert.ok(inUseConflicts(state, { ...next, hosts: [] }).includes('acme/app#1 がマシン env-1 を使っています'))
    assert.ok(inUseConflicts(state, { ...next, repos: {} }).includes('acme/app#1 がリポジトリ acme/app を使っています'))
    assert.deepEqual(inUseConflicts(state, { ...next, sources: [] }), ['acme/app#1 が拾う元 acme/app を使っています'])
    const issue = state.issues['acme/app#1']
    assert.ok(issue)
    issue.phase = 'done'
    assert.deepEqual(inUseConflicts(state, { ...next, sources: [], hosts: [], repos: {} }), [])
    assert.ok(readFileSync(f.configFile, 'utf8'))
  } finally {
    f.cleanup()
  }
})

test('SV11 measure survives draft and config round trips', () => {
  const f = fixture()
  try {
    const measure = { peakMemoryMb: 900, diskGrowthMb: 0, measuredAt: '2026-11-17T00:00:00Z' }
    const base = {
      ...f.raw,
      hosts: [
        {
          id: 'env-1',
          name: 'Server',
          lanes: 1,
          orcaBin: 'orca',
          repos: {
            'acme/app': { selector: 'id:R', verified: true, measure },
            'other/api': { selector: 'id:A', verified: false },
          },
        },
      ],
    }
    f.put(f.configFile, base)
    const draft = draftFromConfig(f.config())
    const json = configJsonFromDraft(draft, base)
    assert.ok(json)
    assert.deepEqual(get(asArray(json.hosts)?.[0], 'repos', 'acme/app', 'measure'), measure)
    const other = asObject(get(asArray(json.hosts)?.[0], 'repos', 'other/api'))
    assert.ok(other)
    assert.equal('measure' in other, false)
    assert.deepEqual(parseAutoConfig(json, 'main'), f.config())
    writeDraft(draft)
    assert.deepEqual(readDraft('main'), draft)
  } finally {
    f.cleanup()
  }
})
