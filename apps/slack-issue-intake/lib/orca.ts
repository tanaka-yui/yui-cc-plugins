import { ORCA_DEFAULT_BIN } from './defaults.ts'
import { asString, get, parseJson } from './json.ts'
import { maskSecrets } from './secrets.ts'

import { spawnSync } from 'node:child_process'

import type { Json } from './json.ts'

export type OrcaResult = { ok: boolean; json: Json | null; stderr: string }

const JSON_FLAG = '--json'

// 空文字は未設定として扱う
export const orcaBin = (): string => process.env.ORCA_BIN || process.env.ORCA_CLI_COMMAND || ORCA_DEFAULT_BIN

// 実際に渡す argv（--dry-run の表示もこれを使う）
export const orcaArgv = (args: string[]): string[] => [...args, JSON_FLAG]

// ★ 標準入力を渡さない（Global Constraints）。成功は exit 0 かつ Orca が ok: true と答えたときだけ。
// --json の Orca は失敗も stdout の JSON（error.message）で返し stderr は空なので、そのときは JSON の理由を stderr に入れる
// timeoutMs を渡すと、その時間で子を止める（poll の締め切りの中で呼ぶとき）
export const runOrca = (args: string[], timeoutMs?: number): OrcaResult => {
  const child = spawnSync(orcaBin(), orcaArgv(args), {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    ...(timeoutMs === undefined ? {} : { timeout: Math.max(1, timeoutMs), killSignal: 'SIGKILL' as const }),
  })
  const json = parseJson(child.stdout ?? '')
  const reported = asString(get(json ?? undefined, 'error', 'message')) ?? ''
  const stderr = child.error === undefined ? child.stderr?.trim() || reported : child.error.message
  return { ok: child.status === 0 && get(json ?? undefined, 'ok') === true, json, stderr: maskSecrets(stderr) }
}
