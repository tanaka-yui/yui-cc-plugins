// 安定パスのランチャー。init がこのファイルを ~/.dev-digest/bin/launch.mts へコピーし、~/.dev-digest/bin/dev-digest
// （`exec node <このファイル>`）から呼ばれる。プラグインの版付きのパスを automation に焼き込まないため、実行のたびに
// 今のプラグインの場所を解決して bin/dev-digest.ts を起動する。
// ★ lib を import しない（コピー先に lib は無い）。下の定数は lib/defaults.ts・lib/paths.ts の写しで、
//   test/unit/launch.test.ts の LA2 が一致を確かめる。版の食い違いは bin/dev-digest.ts が警告する
import { spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const LAUNCHER_VERSION = 1
export const PLUGIN_ID = 'dev-digest@yui-cc-plugins'
export const LAUNCHER_VERSION_ENV = 'DEV_DIGEST_LAUNCHER_VERSION'
export const CLAUDE_HOME_ENV = 'DEV_DIGEST_CLAUDE_HOME'
export const CLAUDE_DIRNAME = '.claude'
export const HOME_ENV = 'DEV_DIGEST_HOME'

const EXIT_NOT_FOUND = 2

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

const isDir = (path: Json | undefined): path is string => {
  if (typeof path !== 'string' || path === '') return false
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

// 1) Claude Code が user scope で入れたプラグインの installPath（更新で版が変わってもここが追う）
// 2) init が config.json に記録した pluginRoot（開発中の checkout から init したときなど）
export const resolvePluginRoot = (home: string, claudeHome: string): string | null => {
  const installed = readJson(join(claudeHome, 'plugins', 'installed_plugins.json'))
  const entries = field(field(installed ?? undefined, 'plugins'), PLUGIN_ID)
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      const installPath = field(entry, 'installPath')
      if (field(entry, 'scope') === 'user' && isDir(installPath)) return installPath
    }
  }
  const recorded = field(readJson(join(home, 'config.json')) ?? undefined, 'pluginRoot')
  return isDir(recorded) ? recorded : null
}

const main = (): void => {
  // このファイルは <home>/bin/launch.mts に置かれる
  const home = dirname(dirname(import.meta.filename))
  const claudeHome = process.env[CLAUDE_HOME_ENV] || join(homedir(), CLAUDE_DIRNAME)
  const root = resolvePluginRoot(home, claudeHome)
  if (root === null) {
    process.stderr.write('dev-digest: dev-digest プラグインが見つかりません。init をやり直してください\n')
    process.exitCode = EXIT_NOT_FOUND
    return
  }
  const child = spawnSync(process.execPath, [join(root, 'bin', 'dev-digest.ts'), ...process.argv.slice(2)], {
    stdio: 'inherit',
    // 子にも同じ home を渡す（ランチャーの置き場所と子の DEV_DIGEST_HOME を食い違わせない）
    env: { ...process.env, [HOME_ENV]: home, [LAUNCHER_VERSION_ENV]: String(LAUNCHER_VERSION) },
  })
  process.exitCode = child.status ?? 1
}

if (import.meta.main) main()
