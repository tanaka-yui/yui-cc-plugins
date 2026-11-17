import {
  parseVerifyOutput,
  parseVerifyTmp,
  runVerifyLocal,
  VERIFY_BEGIN,
  VERIFY_END,
  VERIFY_SCRIPT_FAILED,
  VERIFY_TMP,
  verifyCommand,
  verifyRemote,
} from '../../lib/setup-verify.ts'
import { fixture } from '../lib/auto-fixture.ts'

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

test('SV5 remote verify passes the selector and environment and closes the terminal', () => {
  const f = fixture()
  process.env.ORCA_AUTO_VERIFY_INTERVAL_MS = '0'
  try {
    f.respond('terminal_create', { ok: true, result: { terminal: { handle: 't1' } } }, f.orca)
    f.respond(
      'terminal_read',
      {
        ok: true,
        result: {
          terminal: {
            tail: [`${VERIFY_TMP}/tmp/x@@`, ...Array(2000).fill('noise'), marker('{"ok":true,"peakMemoryMb":512}')],
          },
        },
      },
      f.orca,
    )
    const waits: number[] = []
    const r = verifyRemote('env-1', 'path:/remote/app', ['true'], [], (m) => waits.push(m))
    assert.equal(r.result?.ok, true)
    assert.equal(r.result?.peakMemoryMb, 512)
    assert.equal(r.timedOut, false)
    assert.equal(r.tmpPath, '/tmp/x')
    assert.deepEqual(waits, [])
    const calls = readFileSync(join(f.orca, 'argv.log'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.split('\x1f'))
    for (const args of calls) assert.equal(args[args.indexOf('--environment') + 1], 'env-1')
    assert.equal(calls[0]?.[calls[0].indexOf('--worktree') + 1], 'path:/remote/app')
    assert.equal(calls[0]?.[calls[0].indexOf('--title') + 1], 'orca-auto-verify')
    assert.ok(calls[0]?.includes(verifyCommand(['true'], [])))
    assert.deepEqual(calls.at(-1)?.slice(0, 7), [
      'terminal',
      'close',
      '--environment',
      'env-1',
      '--terminal',
      't1',
      '--json',
    ])
  } finally {
    Reflect.deleteProperty(process.env, 'ORCA_AUTO_VERIFY_INTERVAL_MS')
    f.cleanup()
  }
})
test('SV6 a marker split across tail rows is read', () => {
  const f = fixture()
  process.env.ORCA_AUTO_VERIFY_INTERVAL_MS = '0'
  try {
    f.respond('terminal_create', { ok: true, result: { terminal: { handle: 't1' } } }, f.orca)
    const text = `${VERIFY_TMP}/tmp/x@@${marker('{"ok":true,"failed":null}')}`
    f.respond(
      'terminal_read',
      { ok: true, result: { terminal: { tail: [text.slice(0, 10), text.slice(10, 56), text.slice(56)] } } },
      f.orca,
    )
    assert.equal(verifyRemote('env-1', 'path:/remote/app', ['true'], [], () => {}).result?.ok, true)
    assert.ok(f.calls(f.orca).includes('terminal close'))
  } finally {
    Reflect.deleteProperty(process.env, 'ORCA_AUTO_VERIFY_INTERVAL_MS')
    f.cleanup()
  }
})
test('SV7 timeout closes the terminal and reports the temp path', () => {
  const f = fixture()
  process.env.ORCA_AUTO_VERIFY_TIMEOUT_MS = '50'
  process.env.ORCA_AUTO_VERIFY_INTERVAL_MS = '10'
  try {
    f.respond('terminal_create', { ok: true, result: { terminal: { handle: 't1' } } }, f.orca)
    f.respond('terminal_read', { ok: true, result: { terminal: { tail: [`${VERIFY_TMP}/tmp/x@@`] } } }, f.orca)
    assert.deepEqual(
      verifyRemote('env-1', 'path:/remote/app', ['true'], [], () => {}),
      { result: null, timedOut: true, tmpPath: '/tmp/x' },
    )
    assert.ok(f.calls(f.orca).includes('terminal close'))
  } finally {
    Reflect.deleteProperty(process.env, 'ORCA_AUTO_VERIFY_TIMEOUT_MS')
    Reflect.deleteProperty(process.env, 'ORCA_AUTO_VERIFY_INTERVAL_MS')
    f.cleanup()
  }
})
test('SV8 create failure returns without closing', () => {
  const f = fixture()
  process.env.ORCA_AUTO_VERIFY_INTERVAL_MS = '0'
  try {
    writeFileSync(join(f.orca, 'terminal_create.rc'), '1')
    assert.deepEqual(
      verifyRemote('env-1', 'path:/remote/app', ['true'], [], () => {}),
      { result: null, timedOut: false, tmpPath: null },
    )
    assert.ok(!f.calls(f.orca).includes('terminal close'))
  } finally {
    Reflect.deleteProperty(process.env, 'ORCA_AUTO_VERIFY_INTERVAL_MS')
    f.cleanup()
  }
})

test('SV14 cleanup exceptions still emit a result for local and remote verification', () => {
  const dir = checkout()
  const f = fixture()
  const leftovers: string[] = []
  const command = 'mkdir -p ro/sub && touch ro/sub/f && chmod 555 ro/sub && echo built'
  process.env.ORCA_AUTO_VERIFY_TIMEOUT_MS = '100'
  process.env.ORCA_AUTO_VERIFY_INTERVAL_MS = '0'
  try {
    const child = spawnSync('/bin/sh', ['-c', verifyCommand([command], [])], { cwd: dir, encoding: 'utf8' })
    const path = parseVerifyTmp(child.stdout)
    assert.ok(path)
    leftovers.push(path)
    const r = parseVerifyOutput(child.stdout)
    assert.ok(r, child.stdout + child.stderr)
    assert.equal(r.ok, false)
    assert.equal(r.failed, VERIFY_SCRIPT_FAILED)
    assert.equal(r.tmpPath, path)
    assert.equal(existsSync(path), true)
    assert.ok(child.stderr.includes(`一時ディレクトリが残っていれば消してください: ${path}`))
    f.respond('terminal_create', { ok: true, result: { terminal: { handle: 't1' } } }, f.orca)
    f.respond('terminal_read', { ok: true, result: { terminal: { tail: [child.stderr, child.stdout] } } }, f.orca)
    const remote = verifyRemote('env-1', 'path:/remote/app', [command], [], () => {})
    assert.equal(remote.timedOut, false)
    assert.equal(remote.result?.failed, VERIFY_SCRIPT_FAILED)
    assert.ok(f.calls(f.orca).includes('terminal close'))
    const local = runVerifyLocal(dir, [command], [])
    if (local.tmpPath) leftovers.push(local.tmpPath)
    assert.equal(local.failed, VERIFY_SCRIPT_FAILED)
    assert.equal(local.platform, process.platform)
  } finally {
    for (const path of leftovers) {
      spawnSync('chmod', ['-R', 'u+w', path])
      rmSync(path, { recursive: true, force: true })
    }
    Reflect.deleteProperty(process.env, 'ORCA_AUTO_VERIFY_TIMEOUT_MS')
    Reflect.deleteProperty(process.env, 'ORCA_AUTO_VERIFY_INTERVAL_MS')
    f.cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('SV15 an unexpected tool lookup exception also cleans up and emits a result', () => {
  const dir = checkout()
  let leftover: string | null = null
  try {
    const r = runVerifyLocal(dir, ['true'], ['bad\0tool'])
    leftover = r.tmpPath
    assert.equal(r.ok, false)
    assert.equal(r.failed, VERIFY_SCRIPT_FAILED)
    assert.equal(r.platform, process.platform)
    clean(dir, r.tmpPath)
  } finally {
    if (leftover) rmSync(leftover, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
})
