import {
  CLAUDE_SWITCH_FLAGS,
  CLAUDE_VALUE_FLAGS,
  CODEX_SWITCH_FLAGS,
  CODEX_VALUE_FLAGS,
  CODEX_WRAPPER_CONFIG_PREFIX,
} from './config.ts'

import type { AccountRef, AgentKind, AgentProcess, SessionRef } from './types.ts'

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`

// ps のコマンドラインを、シングルクォートの内側を 1 つにまとめて空白で分ける
const tokenize = (command: string): string[] => {
  const tokens: string[] = []
  let current = ''
  let quoted = false
  for (const ch of command) {
    if (ch === "'") quoted = !quoted
    if (ch === ' ' && !quoted) {
      if (current) tokens.push(current)
      current = ''
    } else current += ch
  }
  if (current) tokens.push(current)
  return tokens
}

export function keptFlags(agent: AgentKind, command: string): string[] {
  const valueFlags = agent === 'claude' ? CLAUDE_VALUE_FLAGS : CODEX_VALUE_FLAGS
  const switchFlags = agent === 'claude' ? CLAUDE_SWITCH_FLAGS : CODEX_SWITCH_FLAGS
  const tokens = tokenize(command).slice(1)
  const kept: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? ''
    const [name = '', inline] = token.split(/=(.*)/s)
    if (switchFlags.includes(token)) kept.push(token)
    else if (valueFlags.includes(name) && inline !== undefined) kept.push(token)
    else if (valueFlags.includes(token) && i + 1 < tokens.length) {
      const value = tokens[++i] ?? ''
      const isConfig = token === '-c' || token === '--config'
      if (!(isConfig && value.startsWith(CODEX_WRAPPER_CONFIG_PREFIX))) kept.push(token, value)
    }
  }
  return kept
}

// ペインのシェルに打ち込む resume コマンド。
// Claude は Orca の claude シェル関数が選択中のアカウントで起動するので、環境変数を付けない。
// Codex の CODEX_HOME はシェル起動時の値で固定されているので、乗り換え先を明示する
export function buildResumeCommand(
  proc: AgentProcess,
  session: SessionRef,
  target: AccountRef,
  prompt: string,
): string {
  const flags = keptFlags(proc.agent, proc.command).map(shellQuote)
  if (proc.agent === 'claude') {
    return ['claude', ...flags, '--resume', shellQuote(session.transcriptPath), shellQuote(prompt)].join(' ')
  }
  const resume = ['codex', 'resume', ...flags, session.sessionId, shellQuote(prompt)].join(' ')
  return target.isSystem ? `(unset CODEX_HOME; ${resume})` : `CODEX_HOME=${shellQuote(target.home)} ${resume}`
}

export function codexRolloutTarget(rolloutPath: string, fromHome: string, toHome: string): string {
  const from = fromHome.replace(/\/+$/, '')
  return `${toHome.replace(/\/+$/, '')}${rolloutPath.slice(from.length)}`
}
