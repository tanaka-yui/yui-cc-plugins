import { pickSources, readAutoConfig } from '../../lib/auto-config.ts'

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
