import { createPrompter } from '../../lib/prompt.ts'
import { tempHome } from '../helpers.ts'

import assert from 'node:assert/strict'
import { closeSync, openSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

test('PR1 1行ずつ読み、既定値・y/N・入力の終わりを扱う', () => {
  const file = join(tempHome(), 'answers')
  writeFileSync(file, 'acme/app\n\n y \nYES\nn\n')
  const fd = openSync(file, 'r')
  const out: string[] = []
  try {
    const p = createPrompter(fd, (text) => out.push(text))
    assert.equal(p.ask('Q'), 'acme/app')
    assert.equal(p.ask('Q', '5'), '5')
    assert.equal(p.confirm('C'), true)
    assert.equal(p.confirm('C'), true)
    assert.equal(p.confirm('C'), false)
    assert.equal(p.ask('Q'), null)
    assert.equal(p.confirm('C'), null)
  } finally {
    closeSync(fd)
  }
  assert.ok(out.includes('Q: '))
  assert.ok(out.includes('Q [5]: '))
  assert.ok(out.some((t) => t.endsWith(' [y/N]: ')))
})

test('PR1b 改行で終わらない最後の行と、行をまたぐ日本語を読む', () => {
  const file = join(tempHome(), 'answers')
  writeFileSync(file, '\r\n＃開発チーム')
  const fd = openSync(file, 'r')
  try {
    const p = createPrompter(fd, () => undefined)
    assert.equal(p.ask('Q', 'x'), 'x')
    assert.equal(p.ask('Q'), '＃開発チーム')
    assert.equal(p.ask('Q'), null)
  } finally {
    closeSync(fd)
  }
})
