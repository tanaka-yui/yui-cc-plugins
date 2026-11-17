import { intakeRepoNames, pickSources, readAutoConfig, readIntakeRepos } from '../../lib/auto-config.ts'

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const dir = mkdtempSync(join(tmpdir(), 'auto-config-'))
process.env.ORCA_DISPATCH_CONFIG_HOME = dir
mkdirSync(join(dir, 'auto/main'), { recursive: true })
after(() => rmSync(dir, { recursive: true, force: true }))
const fixture = {
  version: 1,
  name: 'main',
  intakeConfig: join(dir, 'intake.json'),
  sources: [{ repo: 'acme/app', related: ['acme/app'] }],
  repos: { 'acme/app': { checkout: '/tmp/auto-checkout' } },
}
const save = (value: object) => writeFileSync(join(dir, 'auto/main/config.json'), JSON.stringify(value))
test('CF1 fills conservative defaults', () => {
  save(fixture)
  const c = readAutoConfig('main')
  assert.ok(c)
  assert.equal(c.lanes, 1)
  assert.deepEqual(c.roles, { review_mode: 'off', phase_b: 'off' })
  assert.deepEqual(c.limits, { defaultMinutes: 60, maxMinutes: 240, stallMinutes: 30 })
  assert.equal(c.repos['acme/app']?.ci, true)
  assert.equal(c.judge.effort, 'high')
  assert.equal(c.sources[0]?.pick, 'Ready')
})
test('CF2 rejects related repositories without checkout information', () => {
  save({ ...fixture, sources: [{ repo: 'acme/app', related: ['other/api'] }] })
  assert.equal(readAutoConfig('main'), null)
})
test('CF3 rejects invalid lanes and checkout paths', () => {
  for (const lanes of [0, 1.5, -1]) {
    save({ ...fixture, lanes })
    assert.equal(readAutoConfig('main'), null)
  }
  save({ ...fixture, repos: { 'acme/app': { checkout: 'relative' } } })
  assert.equal(readAutoConfig('main'), null)
})
test('CF4 intake is authoritative and orders sources; CF5 unreadable intake is empty', () => {
  save(fixture)
  const c = readAutoConfig('main')
  assert.ok(c)
  assert.deepEqual(pickSources(c), [])
  writeFileSync(fixture.intakeConfig, JSON.stringify({ repos: [{ name: 'other/api' }, { name: 'acme/app' }] }))
  assert.deepEqual(pickSources(c), ['acme/app'])
})

test('CF6 malformed nested configuration fails closed', () => {
  for (const field of ['roles', 'limits', 'judge']) {
    save({ ...fixture, [field]: 'invalid' })
    assert.equal(readAutoConfig('main'), null)
  }
})

test('AU125 source project is optional and validated', () => {
  save(fixture)
  assert.equal(readAutoConfig('main')?.sources[0]?.project, null)
  const project = { owner: 'acme', number: 3 }
  save({ ...fixture, sources: [{ ...fixture.sources[0], project }] })
  assert.deepEqual(readAutoConfig('main')?.sources[0]?.project, project)
  for (const invalid of [
    { owner: '', number: 3 },
    { owner: 'acme', number: 0 },
    { owner: 'acme', number: 1.5 },
    { owner: 'acme' },
    { owner: 3, number: 3 },
    'acme/3',
    null,
  ]) {
    save({ ...fixture, sources: [{ ...fixture.sources[0], project: invalid }] })
    assert.equal(readAutoConfig('main'), null)
  }
})

test('SU2 automation is optional and validated', () => {
  for (const automation of [undefined, null]) {
    save({ ...fixture, automation })
    assert.equal(readAutoConfig('main')?.automation, null)
  }
  for (const acceptedFingerprint of [undefined, null, 'fingerprint']) {
    save({ ...fixture, automation: { id: 'a1', acceptedFingerprint } })
    assert.deepEqual(readAutoConfig('main')?.automation, { id: 'a1', acceptedFingerprint: acceptedFingerprint ?? null })
  }
  for (const automation of [
    { id: '' },
    { id: 'a1', acceptedFingerprint: '' },
    { id: 'a1', acceptedFingerprint: 1 },
    'bad',
  ]) {
    save({ ...fixture, automation })
    assert.equal(readAutoConfig('main'), null)
  }
})

const { intakeConfig: _legacy, ...modern } = fixture
const intakeOf = (extra: object): string[] | null => {
  save({ ...modern, ...extra })
  return readAutoConfig('main')?.intakeConfigs ?? null
}
test('MI1 intakeConfigs and the legacy intakeConfig', () => {
  assert.deepEqual(intakeOf({ intakeConfigs: ['/a', '/b'] }), ['/a', '/b'])
  assert.deepEqual(intakeOf({ intakeConfigs: ['/a', '/b', '/a'] }), ['/a', '/b'])
  assert.deepEqual(intakeOf({ intakeConfig: '/a' }), ['/a'])
  assert.deepEqual(intakeOf({}), [join(homedir(), '.slack-issue-intake', 'config.json')])
  for (const extra of [
    { intakeConfig: '/a', intakeConfigs: ['/a'] },
    { intakeConfigs: [] },
    { intakeConfigs: [''] },
    { intakeConfigs: '/a' },
    { intakeConfigs: [1] },
    { intakeConfig: '' },
    { intakeConfig: 1 },
  ])
    assert.equal(intakeOf(extra), null, JSON.stringify(extra))
})
const REPOS = ['acme/x', 'acme/y', 'acme/z']
const multi = (intakeConfigs: string[], order = REPOS) => {
  save({
    version: 1,
    name: 'main',
    intakeConfigs,
    sources: order.map((repo) => ({ repo, related: [repo] })),
    repos: Object.fromEntries(REPOS.map((repo) => [repo, { checkout: '/tmp/auto-checkout' }])),
  })
  const c = readAutoConfig('main')
  assert.ok(c)
  return c
}
const intake = (file: string, value: object): string => {
  const path = join(dir, file)
  writeFileSync(path, JSON.stringify(value))
  return path
}
test('MI2 sources are the union of intake repos in order', () => {
  const a = intake('mi2-a.json', { repos: [{ name: 'acme/x' }, { name: 'acme/y' }] })
  const b = intake('mi2-b.json', { repos: [{ name: 'acme/y' }, { name: 'acme/z' }] })
  const c = multi([a, b], ['acme/z', 'acme/y', 'acme/x'])
  assert.deepEqual(readIntakeRepos(c), { repos: ['acme/x', 'acme/y', 'acme/z'], unreadable: [] })
  assert.deepEqual(pickSources(c), ['acme/x', 'acme/y', 'acme/z'])
})
test('MI3 an unreadable intake drops only its repos', () => {
  const a = intake('mi3-a.json', { repos: [{ name: 'acme/x' }, { name: 'bad name' }] })
  const broken = intake('mi3-broken.json', { repos: {} })
  const missing = join(dir, 'mi3-missing.json')
  const c = multi([a, missing, broken, missing])
  assert.deepEqual(readIntakeRepos(c), { repos: ['acme/x'], unreadable: [missing, broken] })
  assert.deepEqual(pickSources(c), ['acme/x'])
  assert.deepEqual(intakeRepoNames(a), ['acme/x'])
  assert.equal(intakeRepoNames(missing), null)
})
