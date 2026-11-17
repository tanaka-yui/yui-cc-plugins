import { readState, releaseLock, takeLock, takeLockWait, writeState } from '../../lib/auto-state.ts'

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const dir = mkdtempSync(join(tmpdir(), 'auto-state-'))
process.env.ORCA_DISPATCH_CONFIG_HOME = dir
const sd = join(dir, 'auto/main')
mkdirSync(sd, { recursive: true })
const lock = join(sd, 'lock.json')
const modulePath = new URL('../../lib/auto-state.ts', import.meta.url).href
after(() => rmSync(dir, { recursive: true, force: true }))
test('SS1 state roundtrip; SS2 corrupt state fails closed', () => {
  const state = readState('main')
  writeState('main', state)
  assert.deepEqual(readState('main'), state)
  writeFileSync(join(sd, 'state.json'), '{bad')
  assert.throws(() => readState('main'))
  rmSync(join(sd, 'state.json'))
})
test('SS3 legacy issues normalize missing host fields and reject invalid values', () => {
  const entry = { key: 'acme/app#1', phase: 'running', generation: 1, targets: [], prs: [] }
  const put = (issue: Record<string, string | number | string[] | null>) =>
    writeFileSync(
      join(sd, 'state.json'),
      JSON.stringify({ version: 1, judgingSince: null, issues: { 'acme/app#1': issue } }),
    )
  put(entry)
  assert.equal(readState('main').issues['acme/app#1']?.host, null)
  assert.equal(readState('main').issues['acme/app#1']?.hostUnreachableSince, null)
  for (const key of ['host', 'hostUnreachableSince']) {
    put({ ...entry, [key]: 1 })
    assert.throws(() => readState('main'), /acme\/app#1/)
  }
  rmSync(join(sd, 'state.json'))
})
test('AU12/AU15 live local lock is never stolen even after expiry', () => {
  writeFileSync(
    lock,
    JSON.stringify({ pid: process.pid, host: hostname(), token: 'live', expiresAt: '2000-01-01T00:00:00Z' }),
  )
  assert.equal(takeLock('main', 100), false)
  rmSync(lock)
  assert.equal(takeLock('main', 100), true)
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `import { takeLock } from '${modulePath}'; console.log(takeLock('main',100))`],
    { encoding: 'utf8' },
  )
  assert.equal(child.stdout.trim(), 'false')
  releaseLock('main')
})
test('AU13 release cannot delete another token; stale foreign lock may be reclaimed', () => {
  assert.equal(takeLock('main', 100), true)
  writeFileSync(
    lock,
    JSON.stringify({ pid: process.pid, host: hostname(), token: 'other', expiresAt: '2000-01-01T00:00:00Z' }),
  )
  releaseLock('main')
  assert.ok(readFileSync(lock, 'utf8').includes('other'))
  writeFileSync(
    lock,
    JSON.stringify({ pid: 1, host: 'different-host', token: 'stale', expiresAt: '2000-01-01T00:00:00Z' }),
  )
  assert.equal(takeLock('main', 100), true)
  releaseLock('main')
})
test('AU14 takeLockWait succeeds after another process releases', () => {
  writeFileSync(
    lock,
    JSON.stringify({ pid: process.pid, host: hostname(), token: 'live', expiresAt: '2099-01-01T00:00:00Z' }),
  )
  const child = spawn(
    process.execPath,
    ['-e', `setTimeout(()=>require('fs').unlinkSync(${JSON.stringify(lock)}),1000)`],
    { stdio: 'ignore' },
  )
  assert.equal(takeLockWait('main', 1000, 2500), true)
  releaseLock('main')
  child.unref()
})
test('AU15c a leftover reclaim mutex is preserved', () => {
  mkdirSync(`${lock}.reclaim`)
  assert.equal(takeLock('main', 100), false)
  assert.equal(takeLock('main', 100), false)
  rmSync(`${lock}.reclaim`, { recursive: true })
})
test('AU15b reclaim rechecks token after another contender takes ownership', async () => {
  writeFileSync(lock, JSON.stringify({ pid: 1, host: 'other-host', token: 'old', expiresAt: '2000-01-01T00:00:00Z' }))
  const child = spawn(
    process.execPath,
    ['--input-type=module', '-e', `import { takeLock } from '${modulePath}'; console.log(takeLock('main',10000))`],
    { env: { ...process.env, ORCA_AUTO_LOCK_TEST_PAUSE_MS: '1000' }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  await new Promise<void>((resolve) => setTimeout(resolve, 400))
  assert.equal(takeLock('main', 10000), true)
  await new Promise<void>((resolve) => {
    child.on('close', () => resolve())
  })
  assert.equal(output.trim(), 'false')
  releaseLock('main')
})

test('AU104 legacy states normalize branch maps and previous targets; malformed values fail closed', () => {
  const entry = { key: 'acme/app#1', phase: 'running', generation: 1, targets: [], prs: [] }
  const put = (extra: object) =>
    writeFileSync(
      join(sd, 'state.json'),
      JSON.stringify({
        version: 1,
        judgingSince: null,
        issues: { 'acme/app#1': { ...entry, ...extra } },
      }),
    )
  try {
    put({})
    const issue = readState('main').issues['acme/app#1']
    assert.deepEqual(issue?.branches, {})
    assert.deepEqual(issue?.prevBranches, {})
    assert.deepEqual(issue?.prevTargets, [])
    for (const key of ['branches', 'prevBranches']) {
      for (const value of [[], null, 'branch', { 'acme/app': 1 }]) {
        put({ [key]: value })
        assert.throws(() => readState('main'), /状態ファイルが壊れています/)
      }
    }
    for (const value of [null, {}, [1]]) {
      put({ prevTargets: value })
      assert.throws(() => readState('main'), /状態ファイルが壊れています/)
    }
  } finally {
    rmSync(join(sd, 'state.json'), { force: true })
  }
})

test('AU126 projectSync defaults and is validated', () => {
  const file = join(sd, 'state.json')
  const base = { version: 1, judgingSince: null, issues: {} }
  try {
    assert.deepEqual(readState('main').projectSync, {})
    writeFileSync(file, JSON.stringify(base))
    assert.deepEqual(readState('main').projectSync, {})
    const projectSync = { 'acme/app#1': { status: 'Ready', label: '' } }
    writeFileSync(file, JSON.stringify({ ...base, projectSync }))
    assert.deepEqual(readState('main').projectSync, projectSync)
    for (const invalid of [
      [],
      null,
      { 'acme/app#1': { status: 1, label: '' } },
      { 'acme/app#1': { status: 'Ready' } },
    ]) {
      writeFileSync(file, JSON.stringify({ ...base, projectSync: invalid }))
      assert.throws(() => readState('main'), /状態ファイルが壊れています/)
    }
  } finally {
    rmSync(file, { force: true })
  }
})
