import { ORCA_DEFAULT_BIN } from './defaults.ts'
import { get, parseJson } from './json.ts'

import { spawnSync } from 'node:child_process'

import type { Json } from './json.ts'

export type OrcaResult = { ok: boolean; json: Json | null; stderr: string }

const JSON_FLAG = '--json'

// 空文字は未設定として扱う
export const orcaBin = (): string => process.env.ORCA_BIN || process.env.ORCA_CLI_COMMAND || ORCA_DEFAULT_BIN

// 実際に渡す argv（--dry-run の表示もこれを使う）
export const orcaArgv = (args: string[]): string[] => [...args, JSON_FLAG]

// ★ 標準入力を渡さない（Global Constraints）。成功は exit 0 かつ Orca が ok: true と答えたときだけ
export const runOrca = (args: string[]): OrcaResult => {
  const child = spawnSync(orcaBin(), orcaArgv(args), { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
  const json = parseJson(child.stdout ?? '')
  const stderr = child.error === undefined ? (child.stderr ?? '') : child.error.message
  return { ok: child.status === 0 && get(json ?? undefined, 'ok') === true, json, stderr }
}
