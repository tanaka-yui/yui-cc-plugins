import { isWebhookUrl, loadSecrets, maskSecrets, maskWebhook, saveWebhook, webhookFor } from '../../lib/secrets.ts'
import { tempHome } from '../helpers.ts'

import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'

const homes: string[] = []
after(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true })
})

const URL_G = 'https://hooks.slack.com/services/T0/B0/xyz'

test('SC1 maskWebhook / maskSecrets は token を出さない', () => {
  assert.ok(!maskWebhook(URL_G).includes('B0/xyz'))
  assert.equal(maskWebhook('nope'), '***')
  const secrets = { global: URL_G, repos: {} }
  assert.ok(!maskSecrets(`error: POST ${URL_G} failed`, secrets).includes('xyz'))
  // origin が書き換えられた URL も伏せる
  assert.ok(!maskSecrets('fetch http://127.0.0.1:9/services/T0/B0/xyz failed', secrets).includes('xyz'))
  assert.ok(!maskSecrets('got /services/T9/B9/other', secrets).includes('other'))
})

test('SC2 saveWebhook は 0600 で書き、既存ファイルも締める', () => {
  const home = tempHome()
  homes.push(home)
  const file = join(home, 'sub', 'secrets.json')
  saveWebhook(file, 'global', URL_G)
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.equal(statSync(join(home, 'sub')).mode & 0o777, 0o700)
  chmodSync(file, 0o644)
  saveWebhook(file, 'o/r', 'https://hooks.slack.com/services/T1/B1/abc')
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(loadSecrets(file), { global: URL_G, repos: { 'o/r': 'https://hooks.slack.com/services/T1/B1/abc' } })
})

test('SC3 loadSecrets は無い・壊れたファイルを空として読む', () => {
  const home = tempHome()
  homes.push(home)
  assert.deepEqual(loadSecrets(join(home, 'none.json')), { global: null, repos: {} })
  const bad = join(home, 'bad.json')
  writeFileSync(bad, '{')
  assert.deepEqual(loadSecrets(bad), { global: null, repos: {} })
})

test('SC4 isWebhookUrl と webhookFor', () => {
  assert.ok(isWebhookUrl(URL_G))
  assert.ok(!isWebhookUrl('https://example.com/services/a'))
  const secrets = { global: URL_G, repos: { 'o/r': 'https://hooks.slack.com/services/T1/B1/abc' } }
  assert.deepEqual(webhookFor(secrets, 'o/r'), { url: secrets.repos['o/r'], viaGlobal: false })
  assert.deepEqual(webhookFor(secrets, 'x/y'), { url: URL_G, viaGlobal: true })
  assert.equal(webhookFor({ global: null, repos: {} }, null), null)
})

test('SC5 saveWebhook は緩い既存ディレクトリを締め、残った一時ファイルを無視する', () => {
  const home = tempHome()
  homes.push(home)
  const dir = join(home, 'loose')
  mkdirSync(dir, { mode: 0o755 })
  chmodSync(dir, 0o755)
  const file = join(dir, 'secrets.json')
  writeFileSync(`${file}.${process.pid}.tmp`, 'stale', { mode: 0o644 })
  saveWebhook(file, 'global', URL_G)
  assert.equal(statSync(dir).mode & 0o777, 0o700)
  assert.equal(loadSecrets(file).global, URL_G)
})
