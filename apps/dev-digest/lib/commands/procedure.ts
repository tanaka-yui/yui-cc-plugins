import { die, parseFlags } from '../cli.ts'
import { loadConfig } from '../config.ts'
import {
  DIGEST_FILE,
  NONE_VALUE,
  ORCA_DEFAULT_BIN,
  X_FILE,
  X_MAX_POSTS_LIST,
  X_MAX_POSTS_PER_HASHTAG,
  X_SEARCH_LIVE_SUFFIX,
  X_SEARCH_URL,
} from '../defaults.ts'
import { digestHome, homePaths, pluginRoot } from '../paths.ts'

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const NAME = 'dev-digest procedure'
const MORNING = join('skills', 'dev-digest', 'references', 'morning.md')
// シェルが特別に扱わない文字。それ以外（? & # など）は 1 文字ずつ \ でエスケープする
const SHELL_SAFE = /[A-Za-z0-9/:._~%=+,-]/

// URL を引用符なしで渡す形にする。allow の接頭辞（`orca tab create --url https://x.com/`）は引用符を含まないので、
// 引用符で囲むと一致しなくなる。x.com の接頭辞はエスケープの要る文字を含まない
const shellEscape = (text: string): string =>
  [...text].map((char) => (SHELL_SAFE.test(char) ? char : `\\${char}`)).join('')

// AI に URL を組み立てさせず、そのまま打てるコマンドを渡す（日本語のハッシュタグもここでエンコードする）
const openTab = (url: string): string => `\`${ORCA_DEFAULT_BIN} tab create --url ${shellEscape(url)} --json\``

const hashtagLines = (hashtags: string[]): string =>
  hashtags.length === 0
    ? `- ${NONE_VALUE}`
    : hashtags
        .map((tag) => `- ${tag}: ${openTab(`${X_SEARCH_URL}${encodeURIComponent(tag)}${X_SEARCH_LIVE_SUFFIX}`)}`)
        .join('\n')

// 毎朝の手順書（正本は references/morning.md）を、この環境の値に置き換えて表示する
export const run = (argv: string[]): void => {
  parseFlags(NAME, { args: argv, options: {} })
  const home = digestHome()
  const config = loadConfig(home) ?? die(NAME, '設定がありません。init を先に実行してください')
  const paths = homePaths(home)
  const values: Record<string, string> = {
    DEV_DIGEST: paths.launcher,
    RUN_DIR: paths.runDir,
    X_FILE,
    DIGEST_FILE,
    X_LIST: config.x.listUrl === null ? NONE_VALUE : openTab(config.x.listUrl),
    X_HASHTAGS: hashtagLines(config.x.hashtags),
    X_MAX_POSTS_LIST: String(X_MAX_POSTS_LIST),
    X_MAX_POSTS_PER_HASHTAG: String(X_MAX_POSTS_PER_HASHTAG),
  }
  let text = readFileSync(join(pluginRoot(), MORNING), 'utf8')
  for (const [key, value] of Object.entries(values)) text = text.replaceAll(`{{${key}}}`, value)
  process.stdout.write(text)
}
