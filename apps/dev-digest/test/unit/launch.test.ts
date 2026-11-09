import {
  CLAUDE_DIRNAME as LAUNCH_CLAUDE_DIRNAME,
  CLAUDE_HOME_ENV as LAUNCH_CLAUDE_HOME_ENV,
  LAUNCHER_VERSION as LAUNCH_LAUNCHER_VERSION,
  LAUNCHER_VERSION_ENV as LAUNCH_LAUNCHER_VERSION_ENV,
  PLUGIN_ID as LAUNCH_PLUGIN_ID,
  resolvePluginRoot,
} from '../../bin/launch.ts'
import { CLAUDE_HOME_ENV, LAUNCHER_VERSION, LAUNCHER_VERSION_ENV, PLUGIN_ID } from '../../lib/defaults.ts'
import { CLAUDE_DIRNAME } from '../../lib/paths.ts'
import { tempHome } from '../helpers.ts'

import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'

const dirs: string[] = []
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const setup = (): { home: string; claudeHome: string; installed: string; recorded: string } => {
  const root = tempHome()
  dirs.push(root)
  const home = join(root, 'home')
  const claudeHome = join(root, 'claude')
  const installed = join(root, 'cache', 'dev-digest', '0.2.0')
  const recorded = join(root, 'recorded-plugin')
  for (const dir of [home, join(claudeHome, 'plugins'), installed, recorded]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(home, 'config.json'), JSON.stringify({ version: 1, pluginRoot: recorded }))
  return { home, claudeHome, installed, recorded }
}

const writeInstalled = (claudeHome: string, installPath: string): void => {
  const plugins = {
    [PLUGIN_ID]: [
      { scope: 'project', projectPath: '/somewhere', installPath: '/not/used' },
      { scope: 'user', installPath, version: '0.2.0' },
    ],
  }
  writeFileSync(join(claudeHome, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins }))
}

test('LA1 resolvePluginRoot は installed_plugins.json を優先し、無ければ config の pluginRoot', () => {
  const { home, claudeHome, installed, recorded } = setup()
  // installed_plugins.json が無い → config の pluginRoot
  assert.equal(resolvePluginRoot(home, claudeHome), recorded)
  // user scope の installPath が在る → それを優先
  writeInstalled(claudeHome, installed)
  assert.equal(resolvePluginRoot(home, claudeHome), installed)
  // installPath のディレクトリが消えた（プラグインの更新で古い版が消えた）→ pluginRoot に落ちる
  rmSync(installed, { recursive: true })
  assert.equal(resolvePluginRoot(home, claudeHome), recorded)
  // どちらも無い → null
  rmSync(recorded, { recursive: true })
  assert.equal(resolvePluginRoot(home, claudeHome), null)
})

test('LA2 ランチャーが持つ定数の写しは lib の値と一致する', () => {
  assert.equal(LAUNCH_LAUNCHER_VERSION, LAUNCHER_VERSION)
  assert.equal(LAUNCH_PLUGIN_ID, PLUGIN_ID)
  assert.equal(LAUNCH_CLAUDE_HOME_ENV, CLAUDE_HOME_ENV)
  assert.equal(LAUNCH_LAUNCHER_VERSION_ENV, LAUNCHER_VERSION_ENV)
  assert.equal(LAUNCH_CLAUDE_DIRNAME, CLAUDE_DIRNAME)
})
