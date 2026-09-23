import { readJson, writeAtomic } from '../../lib/fs.ts'

import assert from 'node:assert/strict'
import fs, { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, mock, test } from 'node:test'

const root = mkdtempSync(join(tmpdir(), 'orca-unit-'))
after(() => rmSync(root, { recursive: true, force: true }))
const fresh = (name: string): string => {
  const dir = join(root, name)
  mkdirSync(dir)
  return dir
}

test('writeAtomic は置き換え、一時ファイルを残さない', () => {
  const dir = fresh('replace')
  const file = join(dir, 'plan.json')
  assert.equal(writeAtomic(file, 'first\n'), true)
  assert.equal(writeAtomic(file, 'second\n'), true)
  assert.equal(readFileSync(file, 'utf8'), 'second\n')
  assert.deepEqual(readdirSync(dir), ['plan.json'])
})

test('writeAtomic は書けなければ false を返し、何も残さない', () => {
  const dir = fresh('missing')
  assert.equal(writeAtomic(join(dir, 'absent', 'plan.json'), 'x'), false)
  assert.deepEqual(readdirSync(dir), [])
})

// 一時ファイルの片付け（rmSync）まで失敗する状況は実ファイルでは作れない（書けないディレクトリには
// 一時ファイルもできない）ので、組み込みの rmSync を差し替える。lib/fs.ts の named import にも届くよう
// syncBuiltinESMExports で ESM 側の束縛を同期する
test('writeAtomic は書き込みも一時ファイルの片付けも失敗したとき、例外を投げずに false を返す', () => {
  const dir = fresh('cleanup-fails')
  mock.method(fs, 'rmSync', () => {
    throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
  })
  syncBuiltinESMExports()
  try {
    assert.equal(writeAtomic(join(dir, 'absent', 'plan.json'), 'x'), false)
  } finally {
    mock.restoreAll()
    syncBuiltinESMExports()
  }
})

test('readJson は読めない・壊れたファイルを null にする', () => {
  const dir = fresh('read')
  writeFileSync(join(dir, 'good.json'), '{"run_id":"run_x"}\n')
  writeFileSync(join(dir, 'bad.json'), '{')
  assert.deepEqual(readJson(join(dir, 'good.json')), { run_id: 'run_x' })
  assert.equal(readJson(join(dir, 'bad.json')), null)
  assert.equal(readJson(join(dir, 'absent.json')), null)
})
