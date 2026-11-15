import { allowedTarget, materialize, parseEnvelope } from '../../lib/mail-artifacts.ts'

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const good = {
  version: 1,
  nonce: '0123456789abcdef',
  branch: 'user/task',
  head: 'a'.repeat(40),
  files: { 'result.md': 'done' },
}
test('MA1 valid envelope is parsed and transport version is removed', () => {
  const { version: _version, ...expected } = good
  assert.deepEqual(parseEnvelope(JSON.stringify(good)), expected)
})
test('MA2 planning artifacts materialize at their designated parent paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mail-artifacts-'))
  try {
    mkdirSync(join(dir, 'roles/design'), { recursive: true })
    const e = parseEnvelope(
      JSON.stringify({ ...good, files: { 'plan.md': 'plan', 'result.md': 'done', 'plan-result.json': '{}' } }),
    )
    assert.ok(!('error' in e))
    assert.equal(materialize(dir, 'design', e, false, true), '')
    assert.equal(readFileSync(join(dir, 'plan.md'), 'utf8'), 'plan')
    assert.equal(readFileSync(join(dir, 'roles/design/result.md'), 'utf8'), 'done')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('MA3/MA4 unsafe names, cross-role reviews, and invalid rounds reject the whole envelope', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mail-artifacts-'))
  try {
    for (const [role, name] of [
      ['design', '../x'],
      ['design', '/etc/x'],
      ['design', 'workers.json'],
      ['design', 'roles/exec/result.md'],
      ['exec_review', 'review/plan-round-1-request.md'],
      ['design', 'review/code-round-1-request.md'],
      ['design', 'review/plan-round-0-request.md'],
      ['design', 'review/plan-round-01-request.md'],
      ['design', 'review/plan-round-100-request.md'],
    ]) {
      assert.equal(allowedTarget(role ?? '', name ?? '', true, false), null)
      const e = parseEnvelope(
        JSON.stringify({ ...good, files: { 'result.md': 'must not write', [name ?? '']: 'bad' } }),
      )
      assert.ok(!('error' in e))
      assert.notEqual(materialize(dir, role ?? '', e, true, false), '')
      assert.equal(existsSync(join(dir, 'roles', role ?? '', 'result.md')), false)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('MA5/MA6 malformed or oversized envelopes fail closed', () => {
  for (const body of [
    'x'.repeat(262145),
    '{',
    'null',
    JSON.stringify({ ...good, version: 2 }),
    JSON.stringify({ ...good, nonce: 'abc' }),
    JSON.stringify({ ...good, head: 'bad' }),
    JSON.stringify({ ...good, branch: '' }),
    JSON.stringify({ ...good, files: [] }),
    JSON.stringify({ ...good, files: { 'result.md': 2 } }),
  ])
    assert.ok('error' in parseEnvelope(body))
  const over = parseEnvelope('x'.repeat(262145))
  assert.ok('error' in over && over.error.includes('262144'))
})
