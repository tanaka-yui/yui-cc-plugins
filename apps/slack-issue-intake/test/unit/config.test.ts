import { loadConfig, mentionPrefix, saveConfig } from '../../lib/config.ts'
import { homePaths } from '../../lib/paths.ts'
import { tempHome } from '../helpers.ts'

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'

const V03 = {
  version: 1,
  channel: 'C0123456789',
  repo: 'acme/app',
  everyMinutes: 5,
  ghPath: '/usr/bin/gh',
  pluginRoot: '/p',
  slack: { teamId: 'T1', teamUrl: 'https://acme.slack.com/', botUserId: 'U1', botId: 'B1' },
  github: { login: 'intake-bot' },
  orca: { workspaceSelector: null, automationId: 'auto-1' },
  acceptedPermissions: null,
}
test('CF1 mention の無い 0.3 の config は asked:false として読め、保存して読み直すと値が残る', () => {
  const home = tempHome()
  writeFileSync(homePaths(home).config, JSON.stringify(V03))
  const c = loadConfig(home)
  assert.deepEqual(c?.mention, { asked: false, groupId: null, handle: null })
  assert.equal(mentionPrefix(c ?? assert.fail()), '')
  saveConfig(home, { ...c, mention: { asked: true, groupId: 'S0DEV0001', handle: 'dev-member' } })
  const again = loadConfig(home)
  assert.deepEqual(again?.mention, { asked: true, groupId: 'S0DEV0001', handle: 'dev-member' })
  assert.equal(mentionPrefix(again ?? assert.fail()), '<!subteam^S0DEV0001> ')
  // 形が壊れていれば、ほかの項目と同じく読めない設定として扱う
  writeFileSync(homePaths(home).config, JSON.stringify({ ...V03, mention: { asked: 'yes' } }))
  assert.equal(loadConfig(home), null)
  assert.ok(readFileSync(homePaths(home).config, 'utf8').includes('asked'))
})
