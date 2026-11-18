import { renderFormManifest } from '../lib/form.ts'
import { homePaths } from '../lib/paths.ts'
import { loadToken } from '../lib/secrets.ts'
import { runCli, tempHome } from './helpers.ts'

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { test } from 'node:test'

test('SH1 deploy フックは環境変数のボットトークンを保存し、伏せた形だけを表示する', () => {
  const home = tempHome()
  const r = runCli(['slack-hook', 'deploy'], { SLACK_ISSUE_INTAKE_HOME: home, SLACK_BOT_TOKEN: 'xoxb-111-secret' })
  assert.equal(r.code, 0)
  assert.equal(r.stdout, 'saved token=xoxb-***\n')
  assert.equal(loadToken(homePaths(home).secrets), 'xoxb-111-secret')
  assert.ok(!`${r.stdout}${r.stderr}`.includes('111-secret'))
})
test('SH2 トークンが無いか xoxb- でなければ、何も保存せずに失敗する', () => {
  for (const token of [undefined, 'xoxp-1']) {
    const home = tempHome()
    const env: Record<string, string> = { SLACK_ISSUE_INTAKE_HOME: home, SLACK_BOT_TOKEN: '' }
    if (token) env.SLACK_BOT_TOKEN = token
    const r = runCli(['slack-hook', 'deploy'], env)
    assert.equal(r.code, 1)
    assert.ok(r.stderr.includes('Slack CLI からボットのトークンを受け取れませんでした'))
    assert.equal(existsSync(homePaths(home).secrets), false)
  }
})
test('SH3 get-manifest はフォーム付きのマニフェストをそのまま返す', () => {
  assert.equal(
    runCli(['slack-hook', 'get-manifest'], { SLACK_ISSUE_INTAKE_HOME: tempHome() }).stdout,
    `${renderFormManifest([])}\n`,
  )
})

test('SH4 設定のリポジトリ一覧からマニフェストと deploy の指紋を作る', async () => {
  const { setupHome } = await import('./helpers.ts')
  const { manifestHash, slackProject } = await import('../lib/slack-cli.ts')
  const { readFileSync } = await import('node:fs')
  const home = tempHome()
  const repos = ['acme/app', 'acme/web']
  const env = await setupHome(home, {
    apiBase: 'http://127.0.0.1:1/api',
    ghPath: '/fake/gh',
    ghState: '/fake/state',
    repos: repos.map((name) => ({ name, form: true, existing: 'skip' })),
  })
  const manifest = runCli(['slack-hook', 'get-manifest'], env)
  assert.equal(manifest.stdout.trim(), renderFormManifest(repos))
  const deploy = runCli(['slack-hook', 'deploy'], { ...env, SLACK_BOT_TOKEN: 'xoxb-test-token' })
  assert.equal(deploy.code, 0, deploy.stderr)
  assert.equal(readFileSync(slackProject(home).manifestHash, 'utf8').trim(), manifestHash(repos))
})

test('NR10 Slack CLI の cwd から名前つきと名前なしのホームを決める', async () => {
  const { setupHome } = await import('./helpers.ts')
  const { slackProject } = await import('../lib/slack-cli.ts')
  const { mkdirSync, realpathSync } = await import('node:fs')
  const { join } = await import('node:path')
  const user = realpathSync(tempHome())
  const named = join(user, '.slack-issue-intake-ws2'),
    legacy = join(user, '.slack-issue-intake')
  await setupHome(named, {
    apiBase: 'http://127.0.0.1:1/api',
    ghPath: '/fake/gh',
    ghState: '/fake/state',
    repos: ['acme/app', 'acme/web'].map((name) => ({ name, form: true, existing: 'skip' })),
  })
  for (const home of [named, legacy]) mkdirSync(slackProject(home).dir, { recursive: true })
  const env = { HOME: user, SLACK_ISSUE_INTAKE_HOME: '' }
  const manifest = runCli(['slack-hook', 'get-manifest'], env, undefined, slackProject(named).dir)
  assert.equal(manifest.code, 0, manifest.stderr)
  assert.ok(manifest.stdout.includes('acme/web'))
  const deploy = runCli(
    ['slack-hook', 'deploy'],
    { ...env, SLACK_BOT_TOKEN: 'xoxb-legacy-1' },
    undefined,
    slackProject(legacy).dir,
  )
  assert.equal(deploy.code, 0, deploy.stderr)
  assert.equal(loadToken(homePaths(legacy).secrets), 'xoxb-legacy-1')
  const elsewhere = runCli(['slack-hook', 'get-hooks'], env, undefined, user)
  assert.equal(elsewhere.code, 2)
  assert.ok(elsewhere.stderr.includes('--name'))
})
