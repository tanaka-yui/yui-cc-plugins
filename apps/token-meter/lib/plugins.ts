// 圧縮プラグインの定義と enable/disable 抽象。
// rtk (gate ファイル) / caveman (session flag) / headroom (MCP enabled フラグ) の
// 3 プラグインを統一インタフェースで操作する。

import { type ClaudeConfig, ClaudeConfigSchema } from './schemas'

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { CompressionPlugin } from './types'

// ゲートファイルのディレクトリ (テスト時は env var で上書き)
function gateDir(): string {
  return process.env.TOKEN_METER_GATE_DIR ?? join(homedir(), '.claude', 'token-meter', 'gates')
}

function gatePath(name: string): string {
  return join(gateDir(), `${name}.gate`)
}

// .claude.json のパス (テスト時は env var で上書き)
function claudeJsonPath(): string {
  return process.env.TOKEN_METER_CLAUDE_JSON ?? join(homedir(), '.claude.json')
}

// `which <cmd>` 経由でコマンドの存在確認
export function commandExists(cmd: string): boolean {
  try {
    const r = spawnSync('which', [cmd], { stdio: 'ignore' })
    return r.status === 0
  } catch {
    return false
  }
}

// gate ファイルを touch (on=true) または rm (on=false)
export async function writeGate(name: string, on: boolean): Promise<void> {
  const path = gatePath(name)
  if (on) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, '', { mode: 0o600 })
  } else {
    rmSync(path, { force: true })
  }
}

// gate ファイルの存在確認
export function readGate(name: string): boolean {
  return existsSync(gatePath(name))
}

// .claude.json を zod スキーマ経由で読み込む (失敗時は空オブジェクト)
function readClaudeConfig(): ClaudeConfig {
  try {
    const raw = JSON.parse(readFileSync(claudeJsonPath(), 'utf8'))
    const result = ClaudeConfigSchema.safeParse(raw)
    return result.success ? result.data : {}
  } catch {
    return {}
  }
}

// .claude.json を atomic write (tmpfile → renameSync)
function writeClaudeConfig(cfg: ClaudeConfig): void {
  const path = claudeJsonPath()
  const tmp = join(dirname(path), `.claude.${process.pid}.${Date.now()}.tmp`)
  writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`)
  renameSync(tmp, path)
}

// .claude.json の mcpServers.<name>.enabled を書き換える
export async function mcpToggle(name: string, on: boolean): Promise<void> {
  const cfg = readClaudeConfig()
  const servers = cfg.mcpServers ?? {}
  const entry = servers[name] ?? {}
  servers[name] = { ...entry, enabled: on }
  cfg.mcpServers = servers
  writeClaudeConfig(cfg)
}

// .claude.json の mcpServers.<name>.enabled を読み出す
export function mcpStatus(name: string): boolean {
  const cfg = readClaudeConfig()
  const entry = cfg.mcpServers?.[name]
  return entry?.enabled === true
}

export const COMPRESSION_PLUGINS: CompressionPlugin[] = [
  {
    name: 'rtk',
    description: 'Rust Token Killer — Bash コマンド出力を圧縮',
    install: { method: 'brew', pkg: 'rtk-ai/tap/rtk' },
    isInstalled: () => commandExists('rtk'),
    enable: async () => writeGate('rtk', true),
    disable: async () => writeGate('rtk', false),
    isEnabled: () => readGate('rtk'),
    detect: { tool: 'Bash', pattern: /^\s*rtk\s+(.+)$/ },
  },
  {
    name: 'caveman',
    description: 'caveman talk 形式に出力を圧縮するスキル',
    install: {
      method: 'curl-sh',
      url: 'https://raw.githubusercontent.com/JuliusBrussee/caveman/main/install.sh',
    },
    isInstalled: () => existsSync(join(homedir(), '.claude', 'skills', 'caveman')),
    enable: async () => {
      const flag = join(homedir(), '.claude', 'caveman.session.flag')
      mkdirSync(dirname(flag), { recursive: true })
      writeFileSync(flag, '', { mode: 0o600 })
    },
    disable: async () => {
      rmSync(join(homedir(), '.claude', 'caveman.session.flag'), { force: true })
    },
    isEnabled: () => existsSync(join(homedir(), '.claude', 'caveman.session.flag')),
    detect: { tool: 'mcp__caveman-shrink__compress' },
  },
  {
    name: 'headroom',
    description: 'tool 出力・履歴を圧縮する MCP サーバ',
    install: { method: 'npm', pkg: 'headroom-ai' },
    isInstalled: () => commandExists('headroom'),
    enable: async () => mcpToggle('headroom', true),
    disable: async () => mcpToggle('headroom', false),
    isEnabled: () => mcpStatus('headroom'),
    detect: { tool: 'mcp__headroom__compress' },
  },
]
