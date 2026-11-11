import { PANE_SESSION_LEADER, PANE_SHELLS } from './config.ts'
import { asNumber, asString, isObject, parseJson } from './json.ts'

import type { AgentKind, AgentProcess } from './types.ts'

// macOS の `ps -E` は、コマンドラインの後ろに環境変数を空白区切りで付ける
export const PS_ARGS = ['-E', '-ww', '-Ao', 'pid=,ppid=,tty=,command=']

const HOME_ENV: Record<AgentKind, string> = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' }
const DEFAULT_HOME: Record<AgentKind, string> = { claude: '.claude', codex: '.codex' }
const AGENTS: AgentKind[] = ['claude', 'codex']

// 最初に ` KEY=`（大文字の環境変数名）が現れる位置を環境変数部分の先頭とみなす。
// ps は引数をクォートせずに並べるので、prompt に含まれる ' などで区切りを追うことはできない
const envStart = (rest: string): number => {
  const m = / [A-Z_][A-Z0-9_]*=/.exec(rest)
  return m ? m.index : -1
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

type PsRow = { pid: number; ppid: number; tty: string; command: string; env: Map<string, string> }

const parsePs = (psOutput: string): Map<number, PsRow> => {
  const rows = new Map<number, PsRow>()
  for (const line of psOutput.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (!m?.[1] || !m[2] || !m[3] || m[4] === undefined) continue
    const rest = m[4]
    const split = envStart(rest)
    rows.set(Number(m[1]), {
      pid: Number(m[1]),
      ppid: Number(m[2]),
      tty: m[3],
      command: split < 0 ? rest : rest.slice(0, split),
      env: parseEnv(split < 0 ? '' : rest.slice(split + 1)),
    })
  }
  return rows
}

// 実行ファイル名。ログインシェルの先頭の `-`（`-/bin/zsh`）は外す
const binaryOf = (command: string): string => ((command.split(' ')[0] ?? '').split('/').pop() ?? '').replace(/^-/, '')

// ペインのエージェントのプロセスを 1 つに絞る。次の全部を満たすものだけを候補にし、ちょうど 1 つのときだけ返す。
// - 環境変数 ORCA_TERMINAL_HANDLE がペインのハンドル
// - 親がシェル（kill した後に resume コマンドを打ち込む相手）
// - 同じ tty に、Orca がペインを開いた login がいる（tmux や nvim の :terminal は別の pty）
export function findAgentProcess(psOutput: string, terminalHandle: string, homeDir: string): AgentProcess | null {
  const rows = parsePs(psOutput)
  const paneTtys = new Set(
    [...rows.values()].filter((r) => binaryOf(r.command) === PANE_SESSION_LEADER).map((r) => r.tty),
  )
  const candidates = [...rows.values()].flatMap((row): AgentProcess[] => {
    const agent = AGENTS.find((a) => a === binaryOf(row.command))
    if (!agent || row.env.get('ORCA_TERMINAL_HANDLE') !== terminalHandle) return []
    const parent = rows.get(row.ppid)
    if (!parent || !PANE_SHELLS.includes(binaryOf(parent.command)) || !paneTtys.has(row.tty)) return []
    const home = row.env.get(HOME_ENV[agent]) || `${homeDir}/${DEFAULT_HOME[agent]}`
    return [{ pid: row.pid, agent, command: row.command, home, terminalHandle }]
  })
  return candidates.length === 1 ? (candidates[0] ?? null) : null
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

// 本物の limit なら、Claude は transcript の最後のメッセージに API エラー（rate_limit）を記録している。
// そのエントリの uuid を返す（同じ limit を二度処理しないための目印）。画面に同じ文言が映っているだけ
// （ツール出力や本文）のときは null
export function lastRateLimitId(text: string): string | null {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const entry = parseJson(lines[i] ?? '')
    if (!isObject(entry)) continue
    const type = asString(entry.type)
    if (type !== 'assistant' && type !== 'user') continue
    const isLimit = type === 'assistant' && entry.isApiErrorMessage === true && entry.error === 'rate_limit'
    return isLimit ? (asString(entry.uuid) ?? asString(entry.timestamp) ?? `line-${i}`) : null
  }
  return null
}
