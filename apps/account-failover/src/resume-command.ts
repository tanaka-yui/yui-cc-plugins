import {
  CLAUDE_SWITCH_FLAGS,
  CLAUDE_VALUE_FLAGS,
  CODEX_SWITCH_FLAGS,
  CODEX_VALUE_FLAGS,
  CODEX_WRAPPER_CONFIG_PREFIX,
  PATH_VALUE_FLAGS,
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

// 起動引数の先頭のフラグ列だけを見る。フラグでない最初の語から後ろは prompt なので、そこで止める。
// prompt の本文に書かれた `--dangerously-skip-permissions` などを権限のフラグとして拾わないため
export function keptFlags(agent: AgentKind, command: string, pathExists: (path: string) => boolean): string[] {
  const valueFlags = agent === 'claude' ? CLAUDE_VALUE_FLAGS : CODEX_VALUE_FLAGS
  const switchFlags = agent === 'claude' ? CLAUDE_SWITCH_FLAGS : CODEX_SWITCH_FLAGS
  const isWrapperConfig = (flag: string, value: string): boolean =>
    (flag === '-c' || flag === '--config') && value.startsWith(CODEX_WRAPPER_CONFIG_PREFIX)
  const tokens = tokenize(command).slice(1)
  const kept: string[] = []
  let i = 0
  while (i < tokens.length) {
    const token = tokens[i] ?? ''
    if (!token.startsWith('-')) break
    const [name = '', inline] = token.split(/=(.*)/s)
    i++
    if (switchFlags.includes(token)) kept.push(token)
    else if (valueFlags.includes(name) && inline !== undefined) {
      if (!isWrapperConfig(name, inline)) kept.push(token)
    } else if (valueFlags.includes(token)) {
      const value = tokens[i++] ?? ''
      if (!isWrapperConfig(token, value)) kept.push(token, value)
    } else if (PATH_VALUE_FLAGS.includes(token)) {
      // 実在するパスになる最長の語の並びだけを値とする。確かめられなければ prompt との境目が分からないので止める
      let end = -1
      for (let j = i; j < tokens.length && !(tokens[j] ?? '').startsWith('-'); j++) {
        if (pathExists(tokens.slice(i, j + 1).join(' '))) end = j
      }
      if (end < 0) break
      i = end + 1
    }
    // それ以外の知らないフラグは、そのフラグだけを読み飛ばす（値を取るなら、その値は prompt とみなされて止まる）
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
  pathExists: (path: string) => boolean,
): string {
  const flags = keptFlags(proc.agent, proc.command, pathExists).map(shellQuote)
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
