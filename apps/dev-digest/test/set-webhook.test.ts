import { saveRepo } from '../lib/config.ts'
import { homePaths } from '../lib/paths.ts'
import { loadSecrets } from '../lib/secrets.ts'
import { tempHome, writeConfig } from './helpers.ts'

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'

import type { CliResult } from './helpers.ts'

const homes: string[] = []
after(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true })
})

const URL_OK = 'https://hooks.slack.com/services/T0/B0/xyz'
const BIN = join(import.meta.dirname, '..', 'bin', 'dev-digest.ts')

const setup = (): { home: string; env: Record<string, string> } => {
  const home = tempHome()
  homes.push(home)
  writeConfig(home)
  saveRepo(home, {
    slug: 'o/r',
    displayName: 'o/r',
    path: '/tmp/o-r',
    addedAt: '2026-11-01T00:00:00.000Z',
    jvnMinSeverity: null,
    devtoTags: [],
    watch: { languages: [], packages: [], cloudServices: [], keywords: [] },
  })
  return { home, env: { DEV_DIGEST_HOME: home } }
}

// 標準入力を渡して実行する（runCli は stdin を渡せない）
const runWith = (args: string[], env: Record<string, string>, input: string): CliResult => {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    input,
  })
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr }
}

test('SW1 正しい URL を保存し伏せて表示する', () => {
  const { home, env } = setup()
  const result = runWith(['set-webhook', '--target', 'global', '--from-stdin'], env, `${URL_OK}\n`)
  assert.equal(result.code, 0)
  assert.match(result.stdout, /saved target=global/)
  assert.ok(!result.stdout.includes('B0/xyz'))
  assert.ok(!result.stderr.includes('B0/xyz'))
  assert.equal(loadSecrets(homePaths(home).secrets).global, URL_OK)
})

test('SW1b リポジトリ slug にも保存できる', () => {
  const { home, env } = setup()
  const result = runWith(['set-webhook', '--target', 'o/r', '--from-stdin'], env, URL_OK)
  assert.equal(result.code, 0)
  assert.equal(loadSecrets(homePaths(home).secrets).repos['o/r'], URL_OK)
})

test('SW2 URL でない値は保存しない', () => {
  const { home, env } = setup()
  const result = runWith(['set-webhook', '--target', 'global', '--from-stdin'], env, 'hello')
  assert.equal(result.code, 1)
  assert.match(result.stderr, /Slack の Incoming Webhook URL ではありません/)
  assert.ok(!existsSync(homePaths(home).secrets))
})

test('SW3 誤った値も stdout / stderr に出さない', () => {
  const { env } = setup()
  const result = runWith(['set-webhook', '--target', 'global', '--from-stdin'], env, 'https://example.com/secret-token')
  assert.equal(result.code, 1)
  assert.ok(!`${result.stdout}${result.stderr}`.includes('secret-token'))
})

test('SW4 未登録の slug は拒む', () => {
  const { home, env } = setup()
  const result = runWith(['set-webhook', '--target', 'x/y', '--from-stdin'], env, URL_OK)
  assert.equal(result.code, 2)
  assert.ok(!existsSync(homePaths(home).secrets))
})

test('SW5 --from-clipboard と --from-stdin は同時に指定できない', () => {
  const { env } = setup()
  const result = runWith(['set-webhook', '--target', 'global', '--from-stdin', '--from-clipboard'], env, URL_OK)
  assert.equal(result.code, 2)
})

test('SW6 --target が無ければ使用法の誤り', () => {
  const { env } = setup()
  assert.equal(runWith(['set-webhook', '--from-stdin'], env, URL_OK).code, 2)
})

test('SW7 クリップボードから読める（コマンドを差し替え）', () => {
  const { home, env } = setup()
  const bin = join(home, 'fakebin')
  mkdirSync(bin)
  for (const name of ['pbpaste', 'wl-paste', 'xclip']) {
    const file = join(bin, name)
    writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${URL_OK}'\n`)
    chmodSync(file, 0o755)
  }
  const result = runWith(
    ['set-webhook', '--target', 'global', '--from-clipboard'],
    { ...env, PATH: `${bin}:${process.env.PATH ?? ''}`, WSL_DISTRO_NAME: '' },
    '',
  )
  assert.equal(result.code, 0)
  assert.equal(loadSecrets(homePaths(home).secrets).global, URL_OK)
})

test('SW8 クリップボードが読めなければ exit 4', () => {
  const { home, env } = setup()
  const bin = join(home, 'emptybin')
  mkdirSync(bin)
  const result = runWith(
    ['set-webhook', '--target', 'global', '--from-clipboard'],
    { ...env, PATH: bin, WSL_DISTRO_NAME: '' },
    '',
  )
  assert.equal(result.code, 4)
})
