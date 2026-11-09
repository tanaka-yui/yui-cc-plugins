import { die, parseFlags } from '../cli.ts'
import { loadConfig } from '../config.ts'
import { X_MAX_POSTS_LIST, X_MAX_POSTS_PER_HASHTAG, X_SEARCH_LIVE_SUFFIX, X_SEARCH_URL } from '../defaults.ts'
import { digestHome, homePaths, pluginRoot } from '../paths.ts'

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const NAME = 'dev-digest procedure'
const NONE = 'none'
const MORNING = join('skills', 'dev-digest', 'references', 'morning.md')

// ハッシュタグは検索 URL まで作って渡す（AI に日本語を URL エンコードさせない）
const hashtagLines = (hashtags: string[]): string =>
  hashtags.length === 0
    ? `- ${NONE}`
    : hashtags.map((tag) => `- ${tag}: ${X_SEARCH_URL}${encodeURIComponent(tag)}${X_SEARCH_LIVE_SUFFIX}`).join('\n')

// 毎朝の手順書（正本は references/morning.md）を、この環境の値に置き換えて表示する
export const run = (argv: string[]): void => {
  parseFlags(NAME, { args: argv, options: {} })
  const home = digestHome()
  const config = loadConfig(home) ?? die(NAME, '設定がありません。init を先に実行してください')
  const paths = homePaths(home)
  const values: Record<string, string> = {
    DEV_DIGEST: paths.launcher,
    RUN_DIR: paths.runDir,
    X_LIST: config.x.listUrl ?? NONE,
    X_HASHTAGS: hashtagLines(config.x.hashtags),
    X_MAX_POSTS_LIST: String(X_MAX_POSTS_LIST),
    X_MAX_POSTS_PER_HASHTAG: String(X_MAX_POSTS_PER_HASHTAG),
  }
  let text = readFileSync(join(pluginRoot(), MORNING), 'utf8')
  for (const [key, value] of Object.entries(values)) text = text.replaceAll(`{{${key}}}`, value)
  process.stdout.write(text)
}
