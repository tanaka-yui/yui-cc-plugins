import { saveRepo } from '../lib/config.ts'
import { homePaths } from '../lib/paths.ts'
import { loadSecrets } from '../lib/secrets.ts'
import { tempHome, writeConfig } from './helpers.ts'

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

// ダイアログ経路: 既定の方式が dialog になるのは darwin だけなので darwin でだけ走らせる
const dialogTest = process.platform === 'darwin' ? test : test.skip
const PROMPT = '[global] の Slack Incoming Webhook URL を貼り付けてください'

// 本物の osascript の代わりに PATH に置く。動きは環境変数で決める
const FAKE_OSASCRIPT = `#!/bin/sh
case "$FAKE_MODE" in
  cancel) echo 'execution error: User canceled. (-128)' >&2; exit 1 ;;
  error) echo 'execution error: boom (-1)' >&2; exit 1 ;;
  ok) for a in "$@"; do printf '%s\\n' "$a"; done > "$FAKE_ARGV"; printf '%s\\n' "$FAKE_URL" ;;
esac
`
const fakeDialog = (home: string): string => {
  const bin = join(home, 'dialogbin')
  mkdirSync(bin)
  const file = join(bin, 'osascript')
  writeFileSync(file, FAKE_OSASCRIPT)
  chmodSync(file, 0o755)
  return bin
}

dialogTest('SW9 ダイアログのキャンセルは exit 1 で何も保存しない', () => {
  const { home, env } = setup()
  const bin = fakeDialog(home)
  const result = runWith(['set-webhook', '--target', 'global'], { ...env, PATH: bin, FAKE_MODE: 'cancel' }, '')
  assert.equal(result.code, 1)
  assert.ok(!existsSync(homePaths(home).secrets))
})

dialogTest('SW10 osascript の別のエラーは exit 4 と fallback=clipboard', () => {
  const { home, env } = setup()
  const bin = fakeDialog(home)
  const result = runWith(['set-webhook', '--target', 'global'], { ...env, PATH: bin, FAKE_MODE: 'error' }, '')
  assert.equal(result.code, 4)
  assert.match(result.stdout, /fallback=clipboard/)
  assert.ok(!existsSync(homePaths(home).secrets))
})

dialogTest('SW11 osascript が無ければ exit 4 と fallback=clipboard', () => {
  const { home, env } = setup()
  const bin = join(home, 'nobin')
  mkdirSync(bin)
  const result = runWith(['set-webhook', '--target', 'global'], { ...env, PATH: bin }, '')
  assert.equal(result.code, 4)
  assert.match(result.stdout, /fallback=clipboard/)
})

dialogTest('SW12 成功時は値を argv に載せず、プロンプトは -- の次に渡す', () => {
  const { home, env } = setup()
  const bin = fakeDialog(home)
  const argvFile = join(home, 'argv.txt')
  const result = runWith(
    ['set-webhook', '--target', 'global'],
    { ...env, PATH: bin, FAKE_MODE: 'ok', FAKE_ARGV: argvFile, FAKE_URL: URL_OK },
    '',
  )
  assert.equal(result.code, 0)
  assert.equal(loadSecrets(homePaths(home).secrets).global, URL_OK)
  const dump = readFileSync(argvFile, 'utf8')
  assert.ok(!dump.includes('B0/xyz'))
  const argv = dump.split('\n')
  const at = argv.indexOf('--')
  assert.ok(at >= 0)
  assert.equal(argv[at + 1], PROMPT)
  assert.ok(!result.stdout.includes('B0/xyz'))
  assert.match(result.stdout, /saved target=global url=https:\/\/hooks\.slack\.com\/services\/T\*\*\*/)
})
