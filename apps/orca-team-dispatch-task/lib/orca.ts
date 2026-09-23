import { asArray, asObject, get, type Json, type JsonObject, parseJson } from './json.ts'

import { spawnSync } from 'node:child_process'

export type OrcaResult = { rc: number; json: Json | null; stdout: string }

const APP_BUNDLE_CLI = '/Applications/Orca.app/Contents/Resources/bin/orca'

// SKILL.md の `${ORCA_BIN:-${ORCA_CLI_COMMAND:-...}}` と同じ順。空文字は未設定として扱う
export const orcaBin = (): string => process.env.ORCA_BIN || process.env.ORCA_CLI_COMMAND || APP_BUNDLE_CLI

// ★ 標準入力を渡さない。`bash <<EOF` で流したとき、途中の Orca CLI がスクリプトの残りを
//   標準入力から読んでしまい、判定を黙って飛ばした（2026-09-23 実測）。stderr は捨てる
export const runOrca = (args: string[]): OrcaResult => {
  const child = spawnSync(orcaBin(), args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
  const stdout = child.stdout ?? ''
  return { rc: child.status ?? 1, json: parseJson(stdout), stdout }
}

// receipt が数えられるのは、exit 0 で、かつ Orca が ok: true と答えたときだけ
export const receiptOk = (result: OrcaResult): boolean => result.rc === 0 && get(result.json, 'ok') === true

// 受理された receipt の result.<field> が期待した形のときだけ返す。それ以外は null（fail closed）
export const receiptArray = (result: OrcaResult, field: string): Json[] | null =>
  receiptOk(result) ? asArray(get(result.json, 'result', field)) : null

export const receiptObject = (result: OrcaResult, field: string): JsonObject | null =>
  receiptOk(result) ? asObject(get(result.json, 'result', field)) : null
