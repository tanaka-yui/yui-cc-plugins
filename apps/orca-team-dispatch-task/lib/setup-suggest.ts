import { asArray, asObject, parseJson } from './json.ts'
import { envCount, MAX_BUFFER } from './sys.ts'

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type { Json } from './json.ts'

export type VerifySuggestion = { commands: string[]; tools: string[]; notes: string }
export const SUGGEST_TIMEOUT_MS = 10 * 60 * 1000
export const SUGGEST_TOOLS = 'Read,Glob,Grep'
const SUGGEST_PROMPT = `You are preparing verification commands for an automated worker that implements GitHub issues in this repository.
Read the repository in the current directory to learn how it is built, tested and linted. Look at CI definitions (.github/workflows), package.json, Makefile, go.mod, pyproject.toml, mise.toml, .tool-versions, compose files and README, and anything else that helps. Do not assume a language or framework.
Do not modify any file.
Propose shell commands that build, test and lint the project without side effects outside the working tree and without any human input. They run in order with /bin/sh from the root of a clean checkout of HEAD with no dependencies installed yet, so include install steps when needed. Also list the command-line tools those commands need (for example node, npm, go, docker).
Prefer the checks CI runs, and do not invent checks CI does not run. When the repository defines tasks (mise tasks, Makefile targets, package.json scripts), run those tasks instead of re-implementing their commands.
When the repository pins its tools with mise (mise.toml, .mise.toml or .tool-versions), run every command through mise (mise run <task>, or mise exec -- <command> when no task fits) so the pinned versions are used, and list mise among the tools.
Answer with exactly one JSON object and nothing else: {"commands":["..."],"tools":["..."],"notes":"..."}. Write notes as one or two short sentences in Japanese.`
// mise が道具の版を固定するファイル。どれかが checkout の一番上にあれば mise を使うリポジトリとみなす
const MISE_FILES = ['mise.toml', '.mise.toml', '.tool-versions', 'mise/config.toml', '.config/mise.toml']
export const usesMise = (checkout: string): boolean => MISE_FILES.some((file) => existsSync(join(checkout, file)))
const MISE_HINT = 'This repository uses mise: run every command through mise run or mise exec --.'
export const suggestVerify = (
  checkout: string,
  judge: { model: string; effort: string },
  mise = false,
): VerifySuggestion | { error: string } => {
  const r = spawnSync(
    process.env.ORCA_AUTO_CLAUDE_BIN || 'claude',
    [
      '-p',
      mise ? `${SUGGEST_PROMPT}\n${MISE_HINT}` : SUGGEST_PROMPT,
      '--output-format',
      'json',
      '--model',
      judge.model,
      '--effort',
      judge.effort,
      '--tools',
      SUGGEST_TOOLS,
      '--allowedTools',
      SUGGEST_TOOLS,
      '--permission-mode',
      'dontAsk',
      '--strict-mcp-config',
    ],
    {
      cwd: checkout,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: envCount('ORCA_AUTO_SUGGEST_TIMEOUT_MS', SUGGEST_TIMEOUT_MS),
      killSignal: 'SIGKILL',
      maxBuffer: MAX_BUFFER,
    },
  )
  if (r.error) {
    if ('code' in r.error && r.error.code === 'ETIMEDOUT') return { error: '時間内に終わりませんでした' }
    return { error: `claude を起動できません: ${r.error.message}` }
  }
  if (r.status !== 0) return { error: `claude が失敗しました（終了コード ${r.status ?? '不明'}）` }
  const outer = asObject(parseJson(r.stdout))
  if (!outer || outer.is_error === true || typeof outer.result !== 'string') return { error: 'AI の答えを読めません' }
  const start = outer.result.indexOf('{'),
    end = outer.result.lastIndexOf('}')
  const parsed = start >= 0 && end >= start ? parseJson(outer.result.slice(start, end + 1)) : null
  if (parsed === null) return { error: 'AI の答えを読めません' }
  const value = asObject(parsed)
  const strings = (v: Json | undefined): v is string[] =>
    asArray(v) !== null && (v as Json[]).every((s) => typeof s === 'string' && s.length > 0)
  if (
    !value ||
    !strings(value.commands) ||
    !strings(value.tools) ||
    (value.notes !== undefined && typeof value.notes !== 'string')
  )
    return { error: 'AI の答えの形が違います' }
  return { commands: value.commands, tools: value.tools, notes: value.notes ?? '' }
}
