import { parseVerifyOutput, runVerifyLocal, VERIFY_BEGIN, VERIFY_END, verifyCommand } from '../../lib/setup-verify.ts'

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout } from 'node:timers/promises'

const git = (path: string, ...args: string[]) => {
  const r = spawnSync('git', ['-C', path, ...args], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}
const checkout = () => {
  const dir = mkdtempSync(join(tmpdir(), 'verify-test-'))
  git(dir, 'init', '-q')
  git(dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '--allow-empty', '-qm', 'init')
  return dir
}
const marker = (value: string) => `${VERIFY_BEGIN}${value}${VERIFY_END}`
const clean = (dir: string, path: string | null) => {
  assert.equal(git(dir, 'worktree', 'list').split('\n').length, 1)
  assert.equal(git(dir, 'status', '--porcelain'), '')
  assert.ok(path)
  assert.equal(existsSync(path), false)
}
test('SV1 runs commands in a throwaway worktree and measures', () => {
  const dir = checkout()
  try {
    const r = runVerifyLocal(dir, ['head -c 3145728 /dev/urandom > big', 'true'], ['sh', 'definitely-not-a-tool-xyz'])
    assert.equal(r.ok, true)
    assert.equal(r.failed, null)
    assert.equal(r.platform, process.platform)
    assert.deepEqual(r.missingTools, ['definitely-not-a-tool-xyz'])
    assert.ok(r.diskGrowthMb !== null && r.diskGrowthMb >= 3)
    if (existsSync('/usr/bin/time')) assert.ok(r.peakMemoryMb !== null && r.peakMemoryMb > 0)
    clean(dir, r.tmpPath)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('SV2 stops at the first failure and the marker survives wrapping and noise', () => {
  const dir = checkout()
  try {
    const r = runVerifyLocal(dir, ['seq 1 5000', 'exit 3', `touch '${join(dir, 'never')}'`], [])
    assert.equal(r.ok, false)
    assert.equal(r.failed, 'exit 3')
    assert.equal(r.exitCode, 3)
    assert.equal(existsSync(join(dir, 'never')), false)
    clean(dir, r.tmpPath)
    assert.equal(parseVerifyOutput(`noise\n${marker('{"ok":tr\nue,"failed":null}')}\r\n`)?.ok, true)
    for (const text of ['no marker', marker('{bad'), marker('[]'), marker('{"ok":"yes"}')])
      assert.equal(parseVerifyOutput(text), null)
    assert.equal(parseVerifyOutput(marker('{"ok":true,"failed":"x"}'))?.ok, false)
    const bad = parseVerifyOutput(marker('{"ok":true,"peakMemoryMb":0,"diskGrowthMb":-1}'))
    assert.equal(bad?.peakMemoryMb, null)
    assert.equal(bad?.diskGrowthMb, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('SV3 quotes, dollars and Japanese survive the base64 wrapping', () => {
  const dir = checkout()
  try {
    const command = `test "$(printf '%s' 'a"b$c$$&$1 日本')" = 'a"b$c$$&$1 日本'`
    assert.equal(runVerifyLocal(dir, [command], []).ok, true)
    assert.equal(verifyCommand([command], []).match(/'/g)?.length, 6)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('SV4 a command reading stdin finishes at once', () => {
  const dir = checkout()
  try {
    const start = Date.now()
    assert.equal(runVerifyLocal(dir, ['cat'], []).ok, true)
    assert.ok(Date.now() - start < 4000)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('SV12 SIGINT stops the command and still cleans the worktree', async () => {
  const dir = checkout()
  const command = `touch '${join(dir, 'started')}'; sleep 5`
  const child = spawn('/bin/sh', ['-c', verifyCommand([command], [])], {
    cwd: dir,
    detached: true,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  let stdout = '',
    ended = false,
    error: Error | null = null
  child.stdout.on('data', (data: Buffer) => {
    stdout += data.toString()
  })
  child.on('error', (value) => {
    error = value
  })
  const done = new Promise<void>((resolve) =>
    child.on('close', () => {
      ended = true
      resolve()
    }),
  )
  try {
    const deadline = Date.now() + 15000
    while (!existsSync(join(dir, 'started'))) {
      assert.equal(error, null)
      assert.equal(ended, false, stdout)
      assert.ok(Date.now() < deadline, '開始の期限')
      await setTimeout(20)
    }
    assert.ok(child.pid)
    const start = Date.now()
    process.kill(-child.pid, 'SIGINT')
    await Promise.race([
      done,
      setTimeout(4000).then(() => {
        throw new Error('終了の期限')
      }),
    ])
    assert.ok(Date.now() - start < 4000)
    const r = parseVerifyOutput(stdout)
    assert.ok(r, stdout)
    assert.equal(r.ok, false)
    assert.equal(r.failed, command)
    rmSync(join(dir, 'started'))
    clean(dir, r.tmpPath)
  } finally {
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        /* 終了済み */
      }
    }
    await done
    rmSync(dir, { recursive: true, force: true })
  }
})
test('SV13 tool names are passed as arguments and never executed', () => {
  const dir = checkout()
  try {
    const tools = ['definitely-not-a-tool-xyz', `x; touch '${join(dir, 'pwned')}'`]
    const r = runVerifyLocal(dir, ['true'], tools)
    assert.equal(r.ok, true)
    assert.deepEqual(r.missingTools, tools)
    assert.equal(existsSync(join(dir, 'pwned')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
