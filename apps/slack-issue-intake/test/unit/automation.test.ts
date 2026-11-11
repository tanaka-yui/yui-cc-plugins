import { PLUGIN_ID, resolvePluginRoot } from '../../bin/launch.ts'
import {
  automationPrompt,
  createArgs,
  cronFor,
  editArgs,
  isAllowedEvery,
  precheckCommand,
} from '../../lib/automation.ts'
import { renderGuide, renderTemplate } from '../../lib/guide.ts'
import { homePaths } from '../../lib/paths.ts'
import { tempHome } from '../helpers.ts'

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import type { Config } from '../../lib/config.ts'

test('AU1 cronは時間の境界でも指定間隔', () => {
  assert.equal(cronFor(5), '*/5 * * * *')
  assert.equal(cronFor(60), '0 * * * *')
  for (const n of [0, 7, 45, 59, 61, 1.5]) assert.ok(!isAllowedEvery(n))
  for (const n of [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60]) assert.ok(isAllowedEvery(n))
})
test('AU2 シェル引用と手順プロンプト', () => {
  assert.equal(precheckCommand("/h/it's/bin/slack-issue-intake"), "'/h/it'\\''s/bin/slack-issue-intake' poll")
  assert.equal(
    automationPrompt('/h/bin/sii', '/h'),
    'Run `/h/bin/sii procedure` and follow the printed instructions exactly. Never read /h/secrets.json.',
  )
})
test('AU3 無効で作成し、更新では有効・無効を保持', () => {
  const c = { everyMinutes: 5 } as Config
  const paths = homePaths('/h')
  const create = createArgs(c, paths, '/h')
  assert.ok(create.includes('--disabled'))
  assert.ok(create.includes('--fresh-session'))
  assert.ok(create.includes("'/h/bin/slack-issue-intake' poll"))
  const edit = editArgs('auto-1', c, paths, '/h')
  for (const flag of ['--enabled', '--disabled', '--name']) assert.ok(!edit.includes(flag))
})
test('LA1 インストール済みuser scopeを優先、無ければ記録したroot', () => {
  const home = tempHome()
  const ch = tempHome()
  const recorded = tempHome()
  writeFileSync(join(home, 'config.json'), JSON.stringify({ pluginRoot: recorded }))
  assert.equal(resolvePluginRoot(home, ch), recorded)
  mkdirSync(join(ch, 'plugins'))
  const installed = tempHome()
  writeFileSync(
    join(ch, 'plugins/installed_plugins.json'),
    JSON.stringify({ plugins: { [PLUGIN_ID]: [{ scope: 'user', installPath: installed }] } }),
  )
  assert.equal(resolvePluginRoot(home, ch), installed)
})
test('GU1 ガイドはフォームと必要scope、前提を含む', () => {
  const g = renderGuide()
  assert.ok(g.includes(renderTemplate()))
  for (const s of [
    'channels:history',
    'groups:history',
    'chat:write',
    'files:read',
    'users:read',
    '"token_rotation_enabled": false',
    'バグ / 新機能 / 要望',
    'critical / high / middle / low',
    '--permission-mode',
  ])
    assert.ok(g.includes(s))
})
