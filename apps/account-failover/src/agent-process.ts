import { asNumber, asString, isObject, parseJson } from './json.ts'

import type { AgentKind, AgentProcess } from './types.ts'

// macOS の `ps -E` は、コマンドラインの後ろに環境変数を空白区切りで付ける
export const PS_ARGS = ['-E', '-ww', '-Ao', 'pid=,command=']

const ENV_KEY = /^[A-Z_][A-Z0-9_]*=/
const HOME_ENV: Record<AgentKind, string> = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' }
const DEFAULT_HOME: Record<AgentKind, string> = { claude: '.claude', codex: '.codex' }

// シングルクォートの外側で、最初に `KEY=` が始まる位置を環境変数部分の先頭とみなす
const envStart = (rest: string): number => {
  let quoted = false
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i]
    if (ch === "'") quoted = !quoted
    else if (ch === ' ' && !quoted && ENV_KEY.test(rest.slice(i + 1))) return i
  }
  return -1
}

// 値には空白を含むパスが入るので、次の ` KEY=` の手前までを値とする
const parseEnv = (env: string): Map<string, string> => {
  const keys = [...` ${env}`.matchAll(/ ([A-Z_][A-Z0-9_]*)=/g)]
  const vars = new Map<string, string>()
  keys.forEach((m, i) => {
    const start = (m.index ?? 0) + m[0].length - 1
    const end = i + 1 < keys.length ? (keys[i + 1]?.index ?? env.length + 1) - 1 : env.length
    if (m[1]) vars.set(m[1], env.slice(start, end))
  })
  return vars
}

export function findAgentProcess(
  psOutput: string,
  terminalHandle: string,
  agent: AgentKind,
  homeDir: string,
): AgentProcess | null {
  const found = psOutput.split('\n').flatMap((line): AgentProcess[] => {
    const m = /^\s*(\d+) (.*)$/.exec(line)
    if (!m?.[1] || m[2] === undefined) return []
    const rest = m[2]
    const split = envStart(rest)
    const command = split < 0 ? rest : rest.slice(0, split)
    const binary = command.split(' ')[0]?.split('/').pop()
    if (binary !== agent) return []
    const env = parseEnv(split < 0 ? '' : rest.slice(split + 1))
    if (env.get('ORCA_TERMINAL_HANDLE') !== terminalHandle) return []
    const home = env.get(HOME_ENV[agent]) || `${homeDir}/${DEFAULT_HOME[agent]}`
    return [{ pid: Number(m[1]), agent, command, home, terminalHandle }]
  })
  return found.reduce<AgentProcess | null>((best, p) => (best === null || p.pid > best.pid ? p : best), null)
}

// `<home>/sessions/<pid>.json`（Claude Code が起動中に書く）から session を読む
export function parseClaudeSessionFile(json: string, pid: number): { sessionId: string; cwd: string } | null {
  const root = parseJson(json)
  if (!isObject(root) || asNumber(root.pid) !== pid) return null
  const sessionId = asString(root.sessionId)
  const cwd = asString(root.cwd)
  return sessionId && cwd ? { sessionId, cwd } : null
}

// `<home>/projects/*/<sessionId>.jsonl` の候補から、ちょうど 1 件のときだけそのパスを返す
export function claudeTranscriptPath(
  projectEntries: readonly string[],
  home: string,
  sessionId: string,
): string | null {
  const prefix = `${home.replace(/\/+$/, '')}/projects/`
  const matches = projectEntries.filter((p) => p.startsWith(prefix) && p.endsWith(`/${sessionId}.jsonl`))
  return matches.length === 1 ? (matches[0] ?? null) : null
}

const ROLLOUT = /\/rollout-[^/]*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/

// `lsof -p <pid> -Fn` の n 行から、codex が書いている rollout を拾う
export function parseCodexRollout(lsofOutput: string, home: string): { sessionId: string; rolloutPath: string } | null {
  const prefix = `${home.replace(/\/+$/, '')}/sessions/`
  for (const line of lsofOutput.split('\n')) {
    if (!line.startsWith('n')) continue
    const path = line.slice(1)
    const m = ROLLOUT.exec(path)
    if (m?.[1] && path.startsWith(prefix)) return { sessionId: m[1], rolloutPath: path }
  }
  return null
}
