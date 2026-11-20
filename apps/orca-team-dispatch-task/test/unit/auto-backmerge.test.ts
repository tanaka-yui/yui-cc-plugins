import { openBackMerge } from '../../lib/auto-backmerge.ts'
import { beginAutoTick, endAutoTick } from '../../lib/auto-paths.ts'
import { fixture } from '../lib/auto-fixture.ts'

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const url = 'https://github.com/acme/app/pull/300'
const call = () => openBackMerge('acme/app', 'main', 'develop', 'back-title', 'back-body')

test('BM1 opens the back PR when none is open and passes the exact arguments to gh pr create', () => {
  const f = fixture()
  try {
    f.respond('pr_list', [])
    writeFileSync(join(f.gh, 'pr_create'), `${url}\n`)
    assert.deepEqual(call(), { kind: 'opened', url })
    const lines = f
      .calls()
      .split('\n')
      .map((l) => l.trim())
    assert.equal(lines[0], 'pr list --repo acme/app --base develop --head main --state open --json url')
    assert.equal(lines[1], 'pr create --repo acme/app --base develop --head main --title back-title --body back-body')
  } finally {
    f.cleanup()
  }
})

test('BM2 reuses an open back PR and never calls gh pr create', () => {
  const f = fixture()
  try {
    f.respond('pr_list', [{ url }])
    assert.deepEqual(call(), { kind: 'existing', url })
    assert.ok(!f.calls().includes('pr create'))
  } finally {
    f.cleanup()
  }
})

test('BM3 a failed creation that says there are no commits between is reported as no-diff', () => {
  const f = fixture()
  try {
    f.respond('pr_list', [])
    f.hook('pr_create', "echo 'pull request create failed: No commits between develop and main' >&2")
    writeFileSync(join(f.gh, 'pr_create.rc'), '1')
    assert.deepEqual(call(), { kind: 'no-diff' })
  } finally {
    f.cleanup()
  }
})

test('BM4 any other failure is an error carrying the first line of the output', () => {
  const f = fixture()
  try {
    f.respond('pr_list', [])
    f.hook('pr_create', "printf 'GraphQL: boom\\nsecond line\\n' >&2")
    writeFileSync(join(f.gh, 'pr_create.rc'), '1')
    assert.deepEqual(call(), { kind: 'error', why: 'GraphQL: boom' })
  } finally {
    f.cleanup()
  }
})

test('BM5 a gh call refused by the tick budget is deferred, never a failure', () => {
  const f = fixture()
  const oldCap = process.env.ORCA_AUTO_CALL_CAP_MS
  process.env.ORCA_AUTO_CALL_CAP_MS = '1000'
  try {
    f.respond('pr_list', [])
    f.hook('pr_list', 'sleep 0.6')
    beginAutoTick(1400)
    assert.deepEqual(call(), { kind: 'deferred' })
    assert.ok(f.calls().includes('pr list'))
    assert.ok(!f.calls().includes('pr create'))
  } finally {
    endAutoTick()
    if (oldCap === undefined) Reflect.deleteProperty(process.env, 'ORCA_AUTO_CALL_CAP_MS')
    else process.env.ORCA_AUTO_CALL_CAP_MS = oldCap
    f.cleanup()
  }
})
