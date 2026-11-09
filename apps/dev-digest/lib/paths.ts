import { CLAUDE_HOME_ENV } from './defaults.ts'

import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const HOME_ENV = 'DEV_DIGEST_HOME'
export const HOME_DIRNAME = '.dev-digest'
export const CLAUDE_DIRNAME = '.claude'

// 設定・DB・秘密情報を置く場所。環境変数で差し替えられる（テスト用）
export const digestHome = (): string => process.env[HOME_ENV] || join(homedir(), HOME_DIRNAME)

// Claude Code の設定の場所。環境変数で差し替えられる（テスト用。本物の ~/.claude に触れない）
export const claudeHome = (): string => process.env[CLAUDE_HOME_ENV] || join(homedir(), CLAUDE_DIRNAME)

// このプラグインの root（apps/dev-digest）。入口 bin/dev-digest.ts から見ても lib/ から見ても 1 つ上
export const pluginRoot = (): string => dirname(import.meta.dirname)

export type HomePaths = {
  config: string
  reposDir: string
  secrets: string
  db: string
  binDir: string
  launcher: string
  launcherScript: string
  runDir: string
}

export const homePaths = (home: string): HomePaths => {
  const binDir = join(home, 'bin')
  return {
    config: join(home, 'config.json'),
    reposDir: join(home, 'repos'),
    secrets: join(home, 'secrets.json'),
    db: join(home, 'digest.db'),
    binDir,
    launcher: join(binDir, 'dev-digest'),
    // 拡張子を .mts にして、置き場所に package.json が無くても必ず ES module として読ませる
    launcherScript: join(binDir, 'launch.mts'),
    runDir: join(home, 'run'),
  }
}
