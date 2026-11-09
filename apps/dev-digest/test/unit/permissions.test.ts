import { applyRules, replaceRules } from '../../lib/permissions.ts'
import { tempHome } from '../helpers.ts'

import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'

const dirs: string[] = []
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

// 読めない設定は上書きせずに投げ、ファイルをそのまま残す
const assertRefused = (content: string, pattern: RegExp): void => {
  const dir = tempHome()
  dirs.push(dir)
  const file = join(dir, 'settings.json')
  writeFileSync(file, content)
  assert.throws(() => applyRules(file, 'deny', ['Read(//x)']), pattern)
  assert.equal(readFileSync(file, 'utf8'), content)
}

test('PM1 applyRules は JSON として読めない設定を上書きしない', () => {
  assertRefused('{ "permissions": { "deny": [', /JSON/)
})

test('PM2 applyRules は permissions がオブジェクトでない設定を上書きしない', () => {
  assertRefused(JSON.stringify({ permissions: ['Read(//x)'] }), /permissions/)
})

test('PM3 applyRules は permissions[key] が配列でない設定を上書きしない', () => {
  assertRefused(JSON.stringify({ permissions: { deny: 'Read(//x)' } }), /permissions\.deny/)
})

test('PM4 applyRules はファイルが無ければ作る', () => {
  const dir = tempHome()
  dirs.push(dir)
  const file = join(dir, 'nested', 'settings.json')
  assert.equal(applyRules(file, 'allow', ['Bash(a)', 'Bash(b)']), 2)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { permissions: { allow: ['Bash(a)', 'Bash(b)'] } })
})

test('PM6 replaceRules も読めない設定や形の違う permissions を上書きしない', () => {
  for (const content of ['{', JSON.stringify({ permissions: [] }), JSON.stringify({ permissions: { allow: 'x' } })]) {
    const dir = tempHome()
    dirs.push(dir)
    const file = join(dir, 'settings.json')
    writeFileSync(file, content)
    assert.throws(() => replaceRules(file, 'allow', ['Bash(a)']))
    assert.equal(readFileSync(file, 'utf8'), content)
  }
})
