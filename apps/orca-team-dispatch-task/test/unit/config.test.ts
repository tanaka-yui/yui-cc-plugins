import {
  DEFAULT_TUPLES,
  integrationRole,
  isRole,
  isToggle,
  knownAgent,
  modelAgent,
  roleNames,
  validEffort,
  validShellValue,
  validToggle,
} from '../../lib/config.ts'

import assert from 'node:assert/strict'
import { test } from 'node:test'

test('validShellValue は空・前後の空白・シェルメタ文字・制御文字を拒み、内部の空白は許す', () => {
  for (const bad of ['', ' a', 'a ', '\ta', "a'b", 'a"b', 'a`b', 'a$b', 'a\\b', 'a!b', 'a\u0001b', 'a\u007fb']) {
    assert.equal(validShellValue(bad), false, JSON.stringify(bad))
  }
  for (const good of ['claude', 'claude-opus-5-5[1m]', 'gpt 6', 'a.b/c']) {
    assert.equal(validShellValue(good), true, good)
  }
})

test('roleNames は review_mode と phase_b から起動する役を決め、exec_review は両方 on のときだけ', () => {
  assert.deepEqual(roleNames('off', 'off'), ['design'])
  assert.deepEqual(roleNames('on', 'off'), ['design', 'design_review'])
  assert.deepEqual(roleNames('off', 'on'), ['design', 'exec'])
  assert.deepEqual(roleNames('on', 'on'), ['design', 'design_review', 'exec', 'exec_review'])
  assert.equal(integrationRole('on'), 'exec')
  assert.equal(integrationRole('off'), 'design')
})

test('トグルとロールの判定は既知の綴りだけを通す', () => {
  assert.equal(isToggle('review_mode'), true)
  assert.equal(isToggle('toString'), false)
  assert.equal(validToggle('design_mode', 'brainstorm'), true)
  assert.equal(validToggle('integration', 'both'), false)
  assert.equal(isRole('exec_review'), true)
  assert.equal(isRole('bogus'), false)
})

test('effort の検証は agent ごと。知らない agent は検証しない（false を返す）', () => {
  assert.equal(validEffort('max', 'claude'), true)
  assert.equal(validEffort('minimal', 'claude'), false)
  assert.equal(validEffort('minimal', 'codex'), true)
  assert.equal(validEffort('max', 'codex'), false)
  assert.equal(validEffort('high', 'cursor'), false)
  assert.equal(knownAgent('cursor'), false)
})

test('modelAgent は綴りで所属が分かる model だけを答える', () => {
  assert.equal(modelAgent('sonnet'), 'claude')
  assert.equal(modelAgent('claude-opus-5-5[1m]'), 'claude')
  assert.equal(modelAgent('gpt-6-sol'), 'codex')
  assert.equal(modelAgent('o3-mini'), 'codex')
  assert.equal(modelAgent('composer-1'), null)
})

test('既定 tuple はロールごと（Opus はフルネーム）', () => {
  assert.deepEqual(DEFAULT_TUPLES.design, { agent: 'claude', model: 'claude-opus-5-5[1m]', effort: 'max' })
  assert.deepEqual(DEFAULT_TUPLES.exec, { agent: 'codex', model: 'gpt-6-sol', effort: 'high' })
})
