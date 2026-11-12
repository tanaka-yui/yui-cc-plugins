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
  assert.equal(runCli(['slack-hook', 'get-manifest'], {}).stdout, `${renderFormManifest()}\n`)
})
