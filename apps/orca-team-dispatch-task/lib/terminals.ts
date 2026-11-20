// 役ごとの端末へ飛ぶ `terminal switch` のコマンドを表にする。orca-state.ts terminals・orca-wait.ts・orca-auto.ts status が使う。
// **読むだけで何も書かない。**Orca へも何も打たない（切り替えるかは人が決める。Orca の help も
// 「ユーザーが頼んだときだけ switch する」と言う）。
import { awaitingSince, workerLastChange } from './awaiting.ts'
import { ALL_ROLES } from './config.ts'
import { readJson } from './fs.ts'
import { asObject, asString, get } from './json.ts'
import { orcaBin } from './orca.ts'

import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

// ★ 端末の handle はそれを発行したサーバーのもの。遠くの役は `--environment` を付けないと別の端末を指す
export const switchCommand = (terminal: string, environment: string): string =>
  `${quote(orcaBin())} terminal switch --terminal ${quote(terminal)}${environment ? ` --environment ${quote(environment)}` : ''}`

// ★ 手動の issue モードは `<repo>/.dispatch-issue/state.json` の issues[<番号>].slug で slug と番号を結ぶ
//   （lib/issue.ts の defaultStateFile と同じ場所。status dir は `<repo>/.dispatch/<slug>`）
export const issueOfSlug = (statusDir: string): string => {
  const slug = basename(statusDir)
  const issues = asObject(get(readJson(join(dirname(dirname(statusDir)), '.dispatch-issue', 'state.json')), 'issues'))
  const found = Object.entries(issues ?? {}).find(([, entry]) => asString(get(entry, 'slug')) === slug)
  return found ? `#${found[0]}` : ''
}

export type TerminalRow = {
  task: string
  issue: string
  role: string
  agent: string
  model: string
  state: string
  terminal: string
  environment: string
}

const roleState = (statusDir: string, role: string, latest: number): string => {
  const roleDir = join(statusDir, 'roles', role)
  if (existsSync(join(roleDir, 'stopped.json'))) return 'stopped'
  if (awaitingSince(statusDir, role, latest) > 0) return '回答待ち'
  return asString(get(readJson(join(roleDir, 'status.json')), 'status')) || '-'
}

// workers.json に記録された役だけを ALL_ROLES の順に並べる。端末が記録されていない役は handle を推測しない
export const terminalRows = (statusDir: string, issue: string): TerminalRow[] => {
  const latest = workerLastChange(statusDir)
  const roles = asObject(get(readJson(join(statusDir, 'workers.json')), 'roles')) ?? {}
  return ALL_ROLES.filter((role) => asObject(roles[role]) !== null).map((role) => ({
    task: basename(statusDir),
    issue,
    role,
    agent: asString(get(roles[role], 'agent')) ?? '',
    model: asString(get(roles[role], 'model')) ?? '',
    state: roleState(statusDir, role, latest),
    terminal: asString(get(roles[role], 'terminal')) ?? '',
    environment: asString(get(roles[role], 'environment')) ?? '',
  }))
}

const cell = (text: string): string => text.replaceAll('|', '\\|').replaceAll('\n', ' ')

export const terminalTable = (rows: TerminalRow[]): string => {
  const lines = ['| タスク | Issue | 役 | agent / model | 状態 | 切り替え |', '|---|---|---|---|---|---|']
  for (const row of rows) {
    const runner = [row.agent, row.model].filter((part) => part !== '').join(' / ') || '-'
    const jump = row.terminal ? `\`${switchCommand(row.terminal, row.environment)}\`` : '（端末の記録なし）'
    lines.push(`| ${[row.task, row.issue || '-', row.role, runner, row.state].map(cell).join(' | ')} | ${cell(jump)} |`)
  }
  return `${lines.join('\n')}\n`
}
