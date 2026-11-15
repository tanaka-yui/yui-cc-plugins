import { envArgs, hostKey, hostsOf } from '../../lib/auto-hosts.ts'
import { fixture } from '../lib/auto-fixture.ts'

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { HostConfig } from '../../lib/auto-hosts.ts'

test('HC1/HC2 defaults preserve C2a and explicit hosts keep configuration order', () => {
  const f = fixture()
  try {
    const local = hostsOf(f.config())
    assert.equal(local.length, 1)
    assert.equal(local[0]?.id, 'local')
    assert.equal(local[0]?.lanes, 1)
    assert.equal(local[0]?.repos['acme/app']?.selector, `path:${f.raw.repos['acme/app'].checkout}`)
    const hosts: HostConfig[] = [
      { id: 'local', name: 'Mac', lanes: 2, orcaBin: 'orca', repos: {} },
      {
        id: 'env-1',
        name: 'Server',
        lanes: 3,
        orcaBin: 'orca-ide',
        repos: { 'acme/app': { selector: 'id:R', verified: true } },
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
