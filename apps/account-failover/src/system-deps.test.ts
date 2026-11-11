import { assert, test } from 'orca/testing'

import { copyReplacing } from './system-deps.ts'

import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('copy replaces an older rollout already present in the target home', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'account-failover-'))
  const from = join(dir, 'a', 'r.jsonl')
  const to = join(dir, 'b', 'sessions', 'r.jsonl')
  await copyReplacing(join(dir, 'missing'), to).catch(() => {})
  await writeFile(join(dir, 'seed'), 'x')
  await copyReplacing(join(dir, 'seed'), to)
  assert.equal(await readFile(to, 'utf8'), 'x')
  await copyReplacing(join(dir, 'seed'), from)
  await writeFile(from, 'newer conversation')
  await copyReplacing(from, to)
  assert.equal(await readFile(to, 'utf8'), 'newer conversation')
})
