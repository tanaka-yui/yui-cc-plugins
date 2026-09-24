import { startIncomplete } from '../../lib/dispatch.ts'

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const dir = mkdtempSync(join(tmpdir(), 'dispatch-unit-'))
after(() => rmSync(dir, { recursive: true, force: true }))

// role の記録と status.json を置いた status dir を作る。status が null なら status.json を置かない
const statusDir = (name: string, record: { [key: string]: string }, status: string | null): string => {
  const sd = join(dir, name)
  mkdirSync(join(sd, 'roles', 'exec'), { recursive: true })
  writeFileSync(join(sd, 'workers.json'), JSON.stringify({ roles: { exec: record } }))
  if (status !== null) writeFileSync(join(sd, 'roles', 'exec', 'status.json'), JSON.stringify({ status }))
  return sd
}

test('startIncomplete は dispatch あり・端末なし・status starting の 3 つが揃ったときだけ真', () => {
  assert.equal(startIncomplete(statusDir('a', { dispatch: 'ctx_e' }, 'starting'), 'exec'), true)
  // 端末が記録されている = 起動は終わった
  assert.equal(startIncomplete(statusDir('b', { dispatch: 'ctx_e', terminal: 'term_e' }, 'starting'), 'exec'), false)
  // status を書き換えた = worker は動き出した
  assert.equal(startIncomplete(statusDir('c', { dispatch: 'ctx_e' }, 'executing'), 'exec'), false)
  // status が無い = 起動の前に止まった（何も託していない）
  assert.equal(startIncomplete(statusDir('d', { dispatch: 'ctx_e' }, null), 'exec'), false)
  // dispatch が無い = worker-start は id を返さなかった
  assert.equal(startIncomplete(statusDir('e', {}, 'starting'), 'exec'), false)
  assert.equal(startIncomplete(join(dir, 'missing'), 'exec'), false)
})

test('start_incomplete の印は、役の status や端末の記録より先に効く', () => {
  const marked = (name: string, status: string | null): string => {
    const sd = statusDir(name, { dispatch: 'ctx_retry' }, status)
    const file = join(sd, 'workers.json')
    writeFileSync(file, JSON.stringify({ roles: { exec: { dispatch: 'ctx_retry', start_incomplete: true } } }))
    return sd
  }
  // 前の試行が done を報告していても、最新の試行が起きていなければ真（round 2 のレビュー）
  assert.equal(startIncomplete(marked('f', 'done'), 'exec'), true)
  assert.equal(startIncomplete(marked('g', null), 'exec'), true)
})
