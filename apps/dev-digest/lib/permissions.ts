import {
  CLAUDE_SETTINGS_FILE,
  DIGEST_FILE,
  MORNING_ARG_SUBCOMMANDS,
  MORNING_EXACT_SUBCOMMANDS,
  ORCA_DEFAULT_BIN,
  ORCA_MORNING_COMMANDS,
  PROJECT_PERMISSION_MODE,
  SETTINGS_FILE_MODE,
  X_FILE,
} from './defaults.ts'
import { asArray, asObject, parseJson } from './json.ts'
import { CLAUDE_DIRNAME, claudeHome, homePaths } from './paths.ts'

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { Json, JsonObject } from './json.ts'

export type ProposedRules = {
  project: { file: string; allow: string[]; defaultMode: string }
  user: { file: string; deny: string[] }
}

const MODE_BITS = 0o777

// Claude の permission ルールで絶対パスを書くときは先頭を `//` にする（spec §13。`/x` は settings からの相対になる）
const absolute = (path: string): string => `/${path}`

// project = 毎朝の Claude が動く runDir の設定。無人の実行は信用できない X の本文を読むので、手順が使う操作だけを許す:
//   ランチャーは朝のサブコマンドだけ、Orca は x.com のタブを開く・閉じる・読む・スクロールするだけ、
//   書き込みは手順が書く 2 ファイルだけ（runDir/CLAUDE.md などに指示を残させない）
//   モードは dontAsk にして、allow に無い操作は尋ねずに拒ませる（user の設定のモードに左右されない）
// user = 全セッションの設定（secrets.json を読ませない）
export const proposedRules = (home: string): ProposedRules => {
  const paths = homePaths(home)
  const runDir = absolute(paths.runDir)
  const secrets = absolute(paths.secrets)
  const writable = [X_FILE, DIGEST_FILE].map((name) => `${runDir}/${name}`)
  return {
    project: {
      file: join(paths.runDir, CLAUDE_DIRNAME, CLAUDE_SETTINGS_FILE),
      allow: [
        ...MORNING_EXACT_SUBCOMMANDS.map((command) => `Bash(${paths.launcher} ${command})`),
        ...MORNING_ARG_SUBCOMMANDS.map((command) => `Bash(${paths.launcher} ${command}:*)`),
        ...ORCA_MORNING_COMMANDS.map((command) => `Bash(${ORCA_DEFAULT_BIN} ${command}:*)`),
        `Read(${runDir}/**)`,
        ...writable.map((file) => `Write(${file})`),
        ...writable.map((file) => `Edit(${file})`),
      ],
      defaultMode: PROJECT_PERMISSION_MODE,
    },
    user: { file: join(claudeHome(), CLAUDE_SETTINGS_FILE), deny: [`Read(${secrets})`, `Edit(${secrets})`] },
  }
}

// 既存の設定は読めなければ書き換えない（壊れた user 設定を上書きで消さない）
const readSettings = (file: string): JsonObject => {
  if (!existsSync(file)) return {}
  const root = asObject(parseJson(readFileSync(file, 'utf8')) ?? undefined)
  if (root === null) throw new Error(`JSON のオブジェクトとして読めません: ${file}`)
  return root
}

type RuleKey = 'allow' | 'deny'

// permissions と permissions[key] を形を確かめて取り出す。形が違えば書き換えずに投げる
const readRules = (file: string, key: RuleKey): { root: JsonObject; permissions: JsonObject; current: Json[] } => {
  const root = readSettings(file)
  const permissions = root.permissions === undefined ? {} : asObject(root.permissions)
  if (permissions === null) throw new Error(`permissions がオブジェクトではありません: ${file}`)
  const current = permissions[key] === undefined ? [] : asArray(permissions[key])
  if (current === null) throw new Error(`permissions.${key} が配列ではありません: ${file}`)
  return { root, permissions, current }
}

// 一時ファイルに書いてから rename する。既存ファイルの権限は保つ
const writeSettings = (file: string, root: JsonObject): void => {
  const mode = existsSync(file) ? statSync(file).mode & MODE_BITS : SETTINGS_FILE_MODE
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  rmSync(temp, { force: true })
  writeFileSync(temp, `${JSON.stringify(root, null, 2)}\n`, { mode, flag: 'wx' })
  renameSync(temp, file)
}

// user の設定の allow は作業フォルダの朝の実行にも効く（allow は全スコープで合わさり、dontAsk でも通る）。
// dev-digest は書き換えず、--show で見せるために読むだけ。読めなければ null
export const inheritedAllow = (file: string): string[] | null => {
  try {
    return readRules(file, 'allow').current.filter((rule): rule is string => typeof rule === 'string')
  } catch {
    return null
  }
}

// permissions[key] に無いものだけ足し、足した数を返す。ほかのキーと既存のルールの順は保つ（user の設定に使う）
export const applyRules = (file: string, key: RuleKey, rules: string[]): number => {
  const { root, permissions, current } = readRules(file, key)
  const missing = rules.filter((rule) => !current.includes(rule))
  if (missing.length === 0) return 0
  root.permissions = { ...permissions, [key]: [...current, ...missing] }
  writeSettings(file, root)
  return missing.length
}

// permissions[key] を rules ちょうどに、permissions.defaultMode を defaultMode に置き換え、置いた数を返す。
// ほかのキーと permissions のほかの欄は保つ。
// 作業フォルダの設定は dev-digest のものなので、前の版が足した広い許可（Bash(<launcher>:*) など）を残さない
export const replaceRules = (file: string, key: RuleKey, rules: string[], defaultMode: string): number => {
  const { root, permissions, current } = readRules(file, key)
  const same =
    permissions.defaultMode === defaultMode &&
    current.length === rules.length &&
    rules.every((rule, index) => current[index] === rule)
  if (!same) {
    root.permissions = { ...permissions, [key]: [...rules], defaultMode }
    writeSettings(file, root)
  }
  return rules.length
}
