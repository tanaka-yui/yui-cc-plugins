import { defaultStateFile, excludeStateDir } from '../../lib/issue.ts'
import { run } from '../../lib/sys.ts'

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const root = mkdtempSync(join(tmpdir(), 'issue-unit-'))
after(() => rmSync(root, { recursive: true, force: true }))

// .dispatch-issue/ を置いた git repo を作り、その info/exclude の path を返す
const repo = (name: string): { dir: string; exclude: string } => {
  const dir = join(root, name)
  mkdirSync(join(dir, '.dispatch-issue'), { recursive: true })
  run('git', ['init', '-q', dir])
  return { dir, exclude: join(dir, '.git', 'info', 'exclude') }
}
const lines = (file: string): string[] => {
  try {
    return readFileSync(file, 'utf8').split('\n')
  } catch {
    return []
  }
}

test('defaultStateFile は repo root の .dispatch-issue/state.json', () => {
  assert.equal(defaultStateFile('/r'), '/r/.dispatch-issue/state.json')
})

test('excludeStateDir は state の directory を除外へ 1 度だけ足す', () => {
  const { dir, exclude } = repo('once')
  excludeStateDir(defaultStateFile(dir), dir)
  excludeStateDir(defaultStateFile(dir), dir)
  assert.equal(lines(exclude).filter((line) => line === '.dispatch-issue/').length, 1)
})

test('excludeStateDir は repo の外の state を除外へ足さない', () => {
  const { dir, exclude } = repo('outside')
  const elsewhere = join(root, 'elsewhere')
  mkdirSync(elsewhere)
  excludeStateDir(join(elsewhere, 'state.json'), dir)
  assert.equal(lines(exclude).includes('.dispatch-issue/'), false)
})

// ★ repo root を symlink 越しに渡しても外れない（test-issue.sh の IS23 と同じ失敗様式。macOS の /var → /private/var）
test('excludeStateDir は symlink 越しの repo root でも除外する', () => {
  const { dir, exclude } = repo('linked')
  const link = join(root, 'link')
  symlinkSync(dir, link)
  excludeStateDir(defaultStateFile(link), link)
  assert.equal(lines(exclude).includes('.dispatch-issue/'), true)
})
