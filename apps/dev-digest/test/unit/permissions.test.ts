import { applyRules, inheritedAllow, replaceRules } from '../../lib/permissions.ts'
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
    assert.throws(() => replaceRules(file, 'allow', ['Bash(a)'], 'dontAsk'))
    assert.equal(readFileSync(file, 'utf8'), content)
  }
})

test('PM7 replaceRules は allow が同じでもモードが違えば書き直す', () => {
  const dir = tempHome()
  dirs.push(dir)
  const file = join(dir, 'settings.json')
  writeFileSync(file, JSON.stringify({ permissions: { allow: ['Bash(a)'] } }))
  assert.equal(replaceRules(file, 'allow', ['Bash(a)'], 'dontAsk'), 1)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
    permissions: { allow: ['Bash(a)'], defaultMode: 'dontAsk' },
  })
})

test('PM8 inheritedAllow は user の設定の allow を読むだけで、無ければ空、読めなければ null', () => {
  const dir = tempHome()
  dirs.push(dir)
  const file = join(dir, 'settings.json')
  assert.deepEqual(inheritedAllow(file), [])
  const content = JSON.stringify({ permissions: { allow: ['Bash(rtk:*)', 'WebFetch(domain:github.com)'] } })
  writeFileSync(file, content)
  assert.deepEqual(inheritedAllow(file), ['Bash(rtk:*)', 'WebFetch(domain:github.com)'])
  assert.equal(readFileSync(file, 'utf8'), content)
  writeFileSync(file, '{')
  assert.equal(inheritedAllow(file), null)
})
