import { asArray, asObject, asString, get, parseJson } from '../../lib/json.ts'

import assert from 'node:assert/strict'
import { test } from 'node:test'

test('parseJson は読めない文字列を null にする', () => {
  assert.deepEqual(parseJson('{"ok":true}'), { ok: true })
  assert.equal(parseJson('not json'), null)
  assert.equal(parseJson(''), null)
})

test('asObject は配列と null をオブジェクトと取り違えない', () => {
  assert.deepEqual(asObject({ a: 1 }), { a: 1 })
  assert.equal(asObject([1]), null)
  assert.equal(asObject(null), null)
  assert.equal(asObject('x'), null)
  assert.equal(asObject(undefined), null)
})

test('asArray と asString は型が違えば null', () => {
  assert.deepEqual(asArray([1, 'a']), [1, 'a'])
  assert.equal(asArray({ a: 1 }), null)
  assert.equal(asString('x'), 'x')
  assert.equal(asString(1), null)
})

test('get は途中がオブジェクトでなければ undefined（jq の .a.b と同じ）', () => {
  const value = { result: { workers: [{ dispatchId: 'ctx' }] }, text: 'x' }
  assert.deepEqual(get(value, 'result', 'workers'), [{ dispatchId: 'ctx' }])
  assert.equal(get(value, 'result', 'missing'), undefined)
  assert.equal(get(value, 'text', 'length'), undefined)
  assert.equal(get(value, 'result', 'workers', '0'), undefined)
  assert.equal(get(undefined, 'a'), undefined)
  assert.deepEqual(get(value), value)
})
