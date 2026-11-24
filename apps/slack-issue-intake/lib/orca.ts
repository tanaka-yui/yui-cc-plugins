import { getMeta, setMeta } from './db.ts'
import { META_ORCA_BIN, ORCA_DEFAULT_BIN } from './defaults.ts'
import { asString, get, parseJson } from './json.ts'
import { maskSecrets } from './secrets.ts'

import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'

import type { Db } from './db.ts'
import type { Json } from './json.ts'

export type OrcaResult = { ok: boolean; json: Json | null; stderr: string }

const JSON_FLAG = '--json'

// 空文字は未設定として扱う
export const orcaBin = (): string => process.env.ORCA_BIN || process.env.ORCA_CLI_COMMAND || ORCA_DEFAULT_BIN

const namedOrcaBin = (): string | null => process.env.ORCA_BIN || process.env.ORCA_CLI_COMMAND || null

// ★ Orca が起こす precheck の環境には ORCA_BIN も ORCA_CLI_COMMAND も無く、PATH の orca は別物のことがある
// （2026-11-24、Linux の実機で古い ~/.local/bin/orca に当たり、poll の呼び出しが毎回失敗した）。
// Orca の端末で動くコマンド（collect / apply）が環境の名指す絶対パスを meta に残し、poll はそれを使う
export const rememberOrcaBin = (db: Db): void => {
  const named = namedOrcaBin()
  if (!named || !isAbsolute(named)) return
  try {
    if (getMeta(db, META_ORCA_BIN) !== named) setMeta(db, META_ORCA_BIN, named)
  } catch {
    // 残せなくても本体の処理は変えない（次の回に残す）
  }
}
// 環境が名指せばそれ、無ければ残した場所（今もファイルがあるときだけ）。どちらも無ければ null（PATH の orca は信じない）
export const recalledOrcaBin = (db: Db): string | null => {
  const named = namedOrcaBin()
  if (named) return named
  const recorded = getMeta(db, META_ORCA_BIN)
  try {
    return recorded && isAbsolute(recorded) && statSync(recorded).isFile() ? recorded : null
  } catch {
    return null
  }
}

// 実際に渡す argv（--dry-run の表示もこれを使う）
export const orcaArgv = (args: string[]): string[] => [...args, JSON_FLAG]

// ★ 標準入力を渡さない（Global Constraints）。成功は exit 0 かつ Orca が ok: true と答えたときだけ。
// --json の Orca は失敗も stdout の JSON（error.message）で返し stderr は空なので、そのときは JSON の理由を stderr に入れる
// timeoutMs を渡すと、その時間で子を止める（poll の締め切りの中で呼ぶとき）
export const runOrca = (args: string[], timeoutMs?: number, bin = orcaBin()): OrcaResult => {
  const child = spawnSync(bin, orcaArgv(args), {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    ...(timeoutMs === undefined ? {} : { timeout: Math.max(1, timeoutMs), killSignal: 'SIGKILL' as const }),
  })
  const json = parseJson(child.stdout ?? '')
  const reported = asString(get(json ?? undefined, 'error', 'message')) ?? ''
  const stderr = child.error === undefined ? child.stderr?.trim() || reported : child.error.message
  return { ok: child.status === 0 && get(json ?? undefined, 'ok') === true, json, stderr: maskSecrets(stderr) }
}
