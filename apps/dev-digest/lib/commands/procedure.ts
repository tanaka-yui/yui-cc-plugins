import { die, parseFlags } from '../cli.ts'
import { loadConfig } from '../config.ts'
import { DIGEST_FILE, NONE_VALUE, X_FILE, X_MAX_POSTS_LIST, X_MAX_POSTS_PER_HASHTAG } from '../defaults.ts'
import { digestHome, homePaths, pluginRoot } from '../paths.ts'

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const NAME = 'dev-digest procedure'
const MORNING = join('skills', 'dev-digest', 'references', 'morning.md')

// X のタブは URL を渡さず x-open で開く（URL は x-open が設定から組み立てる）。どのハッシュタグかはコメント行で示す
const hashtagLines = (launcher: string, hashtags: string[]): string =>
  hashtags.length === 0
    ? `# ${NONE_VALUE}`
    : hashtags.map((tag, index) => `# ${tag}\n${launcher} x-open --target hashtag --index ${index}`).join('\n')

// 毎朝の手順書（正本は references/morning.md）を、この環境の値に置き換えて表示する
export const run = (argv: string[]): void => {
  parseFlags(NAME, { args: argv, options: {} })
  const home = digestHome()
  const config = loadConfig(home) ?? die(NAME, '設定がありません。init を先に実行してください')
  const paths = homePaths(home)
  // X のカテゴリを止めていれば読ませない（リストもハッシュタグも none）
  const xOff = config.disabledSections.includes('x')
  const values: Record<string, string> = {
    DEV_DIGEST: paths.launcher,
    RUN_DIR: paths.runDir,
    X_FILE,
    DIGEST_FILE,
    X_LIST: xOff || config.x.listUrl === null ? NONE_VALUE : `\`${paths.launcher} x-open --target list\``,
    X_HASHTAGS: hashtagLines(paths.launcher, xOff ? [] : config.x.hashtags),
    X_MAX_POSTS_LIST: String(X_MAX_POSTS_LIST),
    X_MAX_POSTS_PER_HASHTAG: String(X_MAX_POSTS_PER_HASHTAG),
  }
  let text = readFileSync(join(pluginRoot(), MORNING), 'utf8')
  for (const [key, value] of Object.entries(values)) text = text.replaceAll(`{{${key}}}`, value)
  process.stdout.write(text)
}
