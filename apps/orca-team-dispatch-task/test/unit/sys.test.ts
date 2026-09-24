import { envCount, nowIso, nowSeconds, run, runNode, sleepSeconds, which } from '../../lib/sys.ts'

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const SYS_TS = new URL('../../lib/sys.ts', import.meta.url).href
const HANG_GUARD_MS = 10_000
const dir = mkdtempSync(join(tmpdir(), 'sys-unit-'))
after(() => rmSync(dir, { recursive: true, force: true }))

test('run は stdout と stderr を分けて受け、終了コードを返す', () => {
  const result = run('sh', ['-c', 'echo out; echo err >&2; exit 3'])
  assert.deepEqual(result, { rc: 3, stdout: 'out\n', stderr: 'err\n' })
})

test('run は起動できないコマンドを rc 1 にする（例外を投げない）', () => {
  const result = run(join(dir, 'missing'), [])
  assert.equal(result.rc, 1)
  assert.equal(result.stdout, '')
})

// ★ lib/orca.ts の runOrca と同じ理由（`bash <<EOF` で途中の CLI が残りを読んだ）
test('run は呼び出し元の標準入力を子に渡さない', () => {
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `import { run } from '${SYS_TS}'; process.stdout.write(run('cat', []).stdout)`],
    { input: 'rest of the script\n', encoding: 'utf8', timeout: HANG_GUARD_MS },
  )
  assert.equal(child.status, 0)
  assert.equal(child.stdout, '')
})

test('runNode は同じ node で .ts を走らせる', () => {
  const script = join(dir, 'hello.ts')
  writeFileSync(script, "const n: number = 2\nprocess.stdout.write(['hello', String(n)].join(' '))\n")
  assert.deepEqual(runNode(script, []), { rc: 0, stdout: 'hello 2', stderr: '' })
})

test('which は PATH を前から見て、実行できる最初のものを返す', () => {
  const first = join(dir, 'first')
  const second = join(dir, 'second')
  for (const bin of [first, second]) {
    spawnSync('mkdir', ['-p', bin])
    writeFileSync(join(bin, 'tool'), '#!/bin/sh\n')
  }
  chmodSync(join(second, 'tool'), 0o755)
  const saved = process.env.PATH
  process.env.PATH = `${first}:${second}`
  try {
    // first の tool は実行できないので飛ばす
    assert.equal(which('tool'), join(second, 'tool'))
    assert.equal(which('nothing-like-this'), null)
  } finally {
    process.env.PATH = saved
  }
})

test('sleepSeconds は指定した秒だけ止まり、0 以下なら止まらない', () => {
  const start = Date.now()
  sleepSeconds(0)
  assert.ok(Date.now() - start < 500)
  sleepSeconds(1)
  assert.ok(Date.now() - start >= 900)
})

test('nowSeconds と nowIso は秒単位の今', () => {
  assert.ok(Math.abs(nowSeconds() - Date.now() / 1000) < 2)
  assert.match(nowIso(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
})

test('envCount は空文字を未設定として扱い、整数でなければ既定値に落とす', () => {
  const saved = process.env.SYS_UNIT_COUNT
  try {
    for (const [value, expected] of [
      ['', 20],
      ['5', 5],
      ['0', 0],
      ['abc', 20],
      ['-3', 20],
    ] as const) {
      process.env.SYS_UNIT_COUNT = value
      assert.equal(envCount('SYS_UNIT_COUNT', 20), expected)
    }
    Reflect.deleteProperty(process.env, 'SYS_UNIT_COUNT')
    assert.equal(envCount('SYS_UNIT_COUNT', 20), 20)
  } finally {
    if (saved !== undefined) process.env.SYS_UNIT_COUNT = saved
  }
})
