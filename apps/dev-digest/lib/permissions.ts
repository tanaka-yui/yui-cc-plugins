import { ORCA_BROWSER_SUBCOMMANDS, ORCA_DEFAULT_BIN } from './defaults.ts'
import { asArray, asObject, parseJson } from './json.ts'
import { CLAUDE_DIRNAME, claudeHome, homePaths } from './paths.ts'

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { JsonObject } from './json.ts'

export type ProposedRules = {
  project: { file: string; allow: string[] }
  user: { file: string; deny: string[] }
}

const SETTINGS_FILE = 'settings.json'
const NEW_FILE_MODE = 0o644
const MODE_BITS = 0o777

// Claude の permission ルールで絶対パスを書くときは先頭を `//` にする（spec §13。`/x` は settings からの相対になる）
const absolute = (path: string): string => `/${path}`

// project = 毎朝の Claude が動く runDir の設定（ランチャー・Orca のブラウザ・runDir への読み書き）
// user = 全セッションの設定（secrets.json を読ませない）
export const proposedRules = (home: string): ProposedRules => {
  const paths = homePaths(home)
  const runDir = absolute(paths.runDir)
  const secrets = absolute(paths.secrets)
  return {
    project: {
      file: join(paths.runDir, CLAUDE_DIRNAME, SETTINGS_FILE),
      allow: [
        `Bash(${paths.launcher}:*)`,
        ...ORCA_BROWSER_SUBCOMMANDS.map((command) => `Bash(${ORCA_DEFAULT_BIN} ${command}:*)`),
        `Read(${runDir}/**)`,
        `Write(${runDir}/**)`,
        `Edit(${runDir}/**)`,
      ],
    },
    user: { file: join(claudeHome(), SETTINGS_FILE), deny: [`Read(${secrets})`, `Edit(${secrets})`] },
  }
}

// 既存の設定は読めなければ書き換えない（壊れた user 設定を上書きで消さない）
const readSettings = (file: string): JsonObject => {
  if (!existsSync(file)) return {}
  const root = asObject(parseJson(readFileSync(file, 'utf8')) ?? undefined)
  if (root === null) throw new Error(`JSON のオブジェクトとして読めません: ${file}`)
  return root
}

// permissions[key] に無いものだけ足し、足した数を返す。ほかのキーと既存のルールの順は保つ
export const applyRules = (file: string, key: 'allow' | 'deny', rules: string[]): number => {
  const root = readSettings(file)
  const permissions = root.permissions === undefined ? {} : asObject(root.permissions)
  if (permissions === null) throw new Error(`permissions がオブジェクトではありません: ${file}`)
  const current = permissions[key] === undefined ? [] : asArray(permissions[key])
  if (current === null) throw new Error(`permissions.${key} が配列ではありません: ${file}`)
  const missing = rules.filter((rule) => !current.includes(rule))
  if (missing.length === 0) return 0
  root.permissions = { ...permissions, [key]: [...current, ...missing] }

  // 一時ファイルに書いてから rename する。既存ファイルの権限は保つ
  const mode = existsSync(file) ? statSync(file).mode & MODE_BITS : NEW_FILE_MODE
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  rmSync(temp, { force: true })
  writeFileSync(temp, `${JSON.stringify(root, null, 2)}\n`, { mode, flag: 'wx' })
  renameSync(temp, file)
  return missing.length
}
