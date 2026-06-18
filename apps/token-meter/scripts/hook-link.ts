#!/usr/bin/env bun

import { type HookGroup, HookGroupSchema, type SettingsJson, SettingsJsonSchema } from '../lib/schemas'

// ~/.claude/settings.json に token-meter hook を安全に追加・削除する CLI スクリプト
// backup → tmpfile → renameSync の 3 ステップでアトミック書き込みを行う
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type { HookGroup, SettingsJson }

// token-meter が管理する hook エントリ: [イベント名, バイナリ名] のペア
// bin/ 配下の実ファイルは .ts 拡張子付き (bun shebang で直接実行可)
const ENTRIES: Array<[string, string]> = [
  ['PreToolUse', 'hook-pre-tool-use.ts'],
  ['PostToolUse', 'hook-post-tool-use.ts'],
  ['Stop', 'hook-stop.ts'],
]

// binDir と hook バイナリ名から実行コマンドパスを生成する
function commandFor(binDir: string, name: string): string {
  return join(binDir, name)
}

// 既存の hooks 配列に token-meter の 3 hook を append する
// 同一 command が既に存在する場合は skip して冪等性を保つ
export function addHooks(settings: SettingsJson, binDir: string): SettingsJson {
  const hooks = { ...(settings.hooks ?? {}) }
  for (const [event, name] of ENTRIES) {
    const cmd = commandFor(binDir, name)
    const groups: HookGroup[] = hooks[event] ?? []
    const exists = groups.some((g) => g.hooks.some((h) => h.command === cmd))
    if (exists) continue
    hooks[event] = [...groups, { matcher: '', hooks: [{ type: 'command', command: cmd }] }]
  }
  return { ...settings, hooks }
}

// settings.json から token-meter が追加した hook エントリのみを除去する
// command パスに 'token-meter' を含むものを除去し、他の hook は保持する
export function removeHooks(settings: SettingsJson): SettingsJson {
  if (!settings.hooks) return settings
  const hooks: Record<string, HookGroup[]> = {}
  for (const [event, groups] of Object.entries(settings.hooks)) {
    // HookGroupSchema で再解析して型安全に処理する
    const filtered: HookGroup[] = []
    for (const rawGroup of groups) {
      const parsed = HookGroupSchema.safeParse(rawGroup)
      if (!parsed.success) continue
      const g = parsed.data
      const remaining = g.hooks.filter((h) => !h.command.includes('token-meter'))
      if (remaining.length > 0) filtered.push({ ...g, hooks: remaining })
    }
    if (filtered.length > 0) hooks[event] = filtered
  }
  return { ...settings, hooks }
}

// settings.json を読み込む。ファイルが存在しない場合や解析失敗時は空オブジェクトを返す
export function loadSettings(path: string): SettingsJson {
  if (!existsSync(path)) return {}
  try {
    const raw = readFileSync(path, 'utf8')
    const result = SettingsJsonSchema.safeParse(JSON.parse(raw))
    if (!result.success) return {}
    return result.data
  } catch {
    return {}
  }
}

// settings.json をアトミックに書き込む
// 手順: 1) 既存ファイルをバックアップ 2) tmpfile に書き込み 3) renameSync でアトミック差替
export function saveSettings(path: string, s: SettingsJson): void {
  if (existsSync(path)) {
    const ts = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
    copyFileSync(path, `${path}.backup-${ts}`)
  }
  const tmp = join(dirname(path), `.settings.${process.pid}.${Date.now()}.tmp`)
  writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`)
  renameSync(tmp, path)
}

// CLI 引数を解析する
function parseArgs(argv: string[]): { remove: boolean; settings: string; bin: string } {
  let remove = false
  let settings = join(homedir(), '.claude', 'settings.json')
  let bin = join(homedir(), '.claude', 'token-meter', 'bin')
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--remove') remove = true
    else if (argv[i] === '--settings') settings = argv[++i] ?? settings
    else if (argv[i] === '--bin') bin = argv[++i] ?? bin
  }
  return { remove, settings, bin }
}

if (import.meta.main) {
  const { remove, settings, bin } = parseArgs(process.argv.slice(2))
  const current = loadSettings(settings)
  const next = remove ? removeHooks(current) : addHooks(current, bin)
  saveSettings(settings, next)
  console.log(remove ? `removed token-meter hooks from ${settings}` : `linked token-meter hooks into ${settings}`)
}
