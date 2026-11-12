import { loadConfig, saveConfig } from '../../lib/config.ts'
import { runPaths } from '../../lib/paths.ts'
import { isBotToken, loadToken, maskSecrets, maskToken, saveToken } from '../../lib/secrets.ts'
import { tempHome } from '../helpers.ts'

import assert from 'node:assert/strict'
import { statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import type { Config } from '../../lib/config.ts'
export const config: Config = {
  version: 1,
  channel: 'C0123456789',
  repo: 'acme/app',
  everyMinutes: 5,
  ghPath: '/bin/gh',
  pluginRoot: '/plugin',
  slack: { teamId: 'T1', teamUrl: 'https://acme.slack.com/', botUserId: 'UBOT00001', botId: 'BBOT00001' },
  github: { login: 'intake-bot' },
  orca: { workspaceSelector: null, automationId: null },
  acceptedPermissions: null,
  mention: { asked: false, groupId: null, handle: null },
}
test('SE1 保存と読み込み、権限 0600/0700', () => {
  const home = tempHome()
  const file = join(home, 'secrets.json')
  saveToken(file, 'xoxb-1-abc')
  assert.equal(loadToken(file), 'xoxb-1-abc')
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.equal(statSync(home).mode & 0o777, 0o700)
})
test('SE2 形の判定と伏せ字', () => {
  assert.ok(isBotToken('xoxb-123-abc'))
  assert.ok(!isBotToken('xoxp-123') && !isBotToken('xoxb-'))
  assert.equal(maskToken('xoxb-1-secret'), 'xoxb-***')
  assert.equal(maskSecrets('err xoxb-1-a and xoxp-2-b'), 'err xoxb-*** and xoxp-***')
})
test('CF1 往復と不正な設定の拒否', () => {
  const home = tempHome()
  saveConfig(home, config)
  assert.deepEqual(loadConfig(home), config)
  for (const value of ['{', '{"version":1}', JSON.stringify({ ...config, slack: {} })]) {
    writeFileSync(join(home, 'config.json'), value)
    assert.equal(loadConfig(home), null)
  }
})
test('CF2 runPaths', () => {
  assert.equal(runPaths('/h/run/runs', 'r').decisionsFile, '/h/run/runs/r/decisions.json')
})
