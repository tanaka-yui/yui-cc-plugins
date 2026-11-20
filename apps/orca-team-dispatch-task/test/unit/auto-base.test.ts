import {
  applyFlow,
  baseLabels,
  candidatesOf,
  needsChoice,
  type RepoBranches,
  resolveBases,
  restrictedBase,
} from '../../lib/auto-base.ts'

import assert from 'node:assert/strict'
import { test } from 'node:test'

const plain: RepoBranches = { baseBranch: null, branches: [] }
const api: RepoBranches = { baseBranch: 'develop', branches: ['develop', 'main'] }
const client: RepoBranches = { baseBranch: 'main', branches: ['main'] }
const two = { api, client }

test('AB1 no label and a single candidate resolves to the default', () => {
  assert.deepEqual(resolveBases([], ['o/a'], { 'o/a': plain }), { kind: 'ok', bases: { 'o/a': null } })
  assert.deepEqual(resolveBases([], ['client'], two), { kind: 'ok', bases: { client: 'main' } })
})

test('AB2 no label and several candidates asks the judge', () => {
  assert.deepEqual(resolveBases([], ['o/a'], { 'o/a': api }), { kind: 'judge' })
})

test('AB3 one label is applied as a flow per repository', () => {
  assert.deepEqual(resolveBases(['base:main'], ['api', 'client'], two), {
    kind: 'ok',
    bases: { api: 'main', client: 'main' },
  })
  assert.deepEqual(resolveBases(['base:develop'], ['api', 'client'], two), {
    kind: 'ok',
    bases: { api: 'develop', client: 'main' },
  })
})

test('AB4 a label no repository offers asks', () => {
  assert.equal(resolveBases(['base:release'], ['api', 'client'], two).kind, 'ask')
})

test('AB5 two or more base labels ask', () => {
  assert.equal(resolveBases(['base:main', 'base:develop'], ['api'], two).kind, 'ask')
})

test('AB6 prefix is case-insensitive and the name is trimmed but case-sensitive', () => {
  assert.deepEqual(baseLabels(['Base: main ', 'bug', 'status:x']), ['main'])
  assert.equal(resolveBases(['base:Main'], ['api'], two).kind, 'ask')
})

test('AB7 restrictedBase is true only when baseBranch is set and differs', () => {
  const repos = { 'o/a': api, 'o/b': plain }
  assert.equal(restrictedBase('o/a', 'main', repos), true)
  assert.equal(restrictedBase('o/a', 'develop', repos), false)
  assert.equal(restrictedBase('o/b', 'main', repos), false)
  assert.equal(restrictedBase('o/none', 'main', repos), false)
})

test('AB8 applyFlow, needsChoice and candidatesOf', () => {
  assert.equal(applyFlow('release', ['api', 'client'], two), null)
  assert.deepEqual(applyFlow('develop', ['api', 'client'], two), { api: 'develop', client: 'main' })
  assert.deepEqual(applyFlow('x', ['o/a'], { 'o/a': plain }), null)
  assert.equal(needsChoice(['client'], two), false)
  assert.equal(needsChoice(['api', 'client'], two), true)
  assert.deepEqual(candidatesOf(['api', 'client'], two), ['develop', 'main'])
  assert.deepEqual(candidatesOf(['client', 'api'], two), ['main', 'develop'])
  assert.deepEqual(candidatesOf(['o/a'], { 'o/a': plain }), [])
})
