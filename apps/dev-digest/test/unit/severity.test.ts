import { atLeast, maxSeverity, parseSeverity } from '../../lib/severity.ts'

import assert from 'node:assert/strict'
import { test } from 'node:test'

test('SV1 parseSeverity は大文字小文字を問わない', () => {
  assert.equal(parseSeverity('Critical'), 'critical')
  assert.equal(parseSeverity('HIGH'), 'high')
  assert.equal(parseSeverity('none'), null)
})

test('SV2 atLeast はしきい値以上だけ true', () => {
  assert.equal(atLeast('high', 'high'), true)
  assert.equal(atLeast('critical', 'high'), true)
  assert.equal(atLeast('medium', 'high'), false)
  assert.equal(atLeast(null, 'medium'), false)
  assert.equal(atLeast(null, 'low'), true)
})

test('SV3 maxSeverity', () => {
  assert.equal(maxSeverity(['medium', 'critical', 'high']), 'critical')
  assert.equal(maxSeverity([]), null)
})
