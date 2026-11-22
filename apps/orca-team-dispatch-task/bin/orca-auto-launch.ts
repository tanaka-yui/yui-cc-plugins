// 安定したパスへコピーするため、lib を import しない。定数の写しは SU20 が照合する。
import { spawnSync } from 'node:child_process'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const PLUGIN_ID = 'orca-team-dispatch-task@yui-cc-plugins'
export const LAUNCHER_ENV = 'ORCA_AUTO_LAUNCHER_VERSION'
export const LAUNCHER_VERSION = 1
export const CLAUDE_HOME_ENV = 'ORCA_AUTO_CLAUDE_HOME'
export const CONFIG_HOME_ENV = 'ORCA_DISPATCH_CONFIG_HOME'
export const PLUGIN_ROOT_FILE = 'plugin-root.json'
export const ENTRY_FILE = 'bin/orca-auto.ts'
export const LAUNCHER_SOURCE = 'bin/orca-auto-launch.ts'
type Json = string | number | boolean | null | Json[] | { [key: string]: Json }
const readJson = (file: string): Json | null => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}
const field = (value: Json | undefined, key: string): Json | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value[key] : undefined
const usable = (value: Json | undefined): value is string => {
  if (typeof value !== 'string' || !value) return false
  try {
    return [ENTRY_FILE, LAUNCHER_SOURCE].every((path) => statSync(join(value, path)).isFile())
  } catch {
    return false
  }
}
export const resolvePluginRoot = (home: string, claudeHome: string): string | null => {
  const entries = field(
    field(readJson(join(claudeHome, 'plugins/installed_plugins.json')) ?? undefined, 'plugins'),
    PLUGIN_ID,
  )
  if (Array.isArray(entries))
    for (const entry of entries) {
      const path = field(entry, 'installPath')
      if (field(entry, 'scope') === 'user' && usable(path)) return path
    }
  const recorded = field(readJson(join(home, 'bin', PLUGIN_ROOT_FILE)) ?? undefined, 'pluginRoot')
  return usable(recorded) ? recorded : null
}
const main = (): void => {
  // argv の表記を保ち、設定の置き場所を symlink の実体に変えない。
  const home = dirname(dirname(process.argv[1] ?? ''))
  const root = resolvePluginRoot(home, process.env[CLAUDE_HOME_ENV] || join(homedir(), '.claude'))
  if (!root) {
    console.error('orca-team-dispatch-task プラグインが見つかりません。make auto-setup をやり直してください')
    process.exitCode = 2
    return
  }
  const child = spawnSync(process.execPath, [join(root, ENTRY_FILE), ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, [CONFIG_HOME_ENV]: home, [LAUNCHER_ENV]: String(LAUNCHER_VERSION) },
  })
  process.exitCode = child.status ?? 1
}
const isMain = (): boolean => {
  try {
    return realpathSync(process.argv[1] ?? '') === import.meta.filename
  } catch {
    return false
  }
}
if (isMain()) main()
