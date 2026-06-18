// rtk gain --format json を呼び total_saved / total_commands の累積カウンタを取る。
// rtk の tool_response には savings が乗らないため、外部 CLI 経由で取得する。
// 失敗時は null を返す (fail open)。

import { JsonValueSchema } from './schemas'

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { JsonValue } from './schemas'

export type RtkGainSnapshot = {
  total_saved: number
  total_commands: number
}

/** `rtk gain --format json` を実行し summary を返す。失敗時は null。 */
export function readRtkGain(): RtkGainSnapshot | null {
  let stdout: string
  try {
    const res = spawnSync('rtk', ['gain', '--format', 'json'], { encoding: 'utf8', timeout: 2000 })
    if (res.status !== 0 || typeof res.stdout !== 'string' || !res.stdout) return null
    stdout = res.stdout
  } catch {
    return null
  }
  const parsed = JsonValueSchema.safeParse(safeParseJson(stdout))
  if (!parsed.success || !parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) return null
  const summary = parsed.data.summary
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return null
  const totalSaved = summary.total_saved
  const totalCommands = summary.total_commands
  if (typeof totalSaved !== 'number' || typeof totalCommands !== 'number') return null
  return { total_saved: totalSaved, total_commands: totalCommands }
}

function safeParseJson(s: string): JsonValue | null {
  try {
    return JSON.parse(s) as JsonValue
  } catch {
    return null
  }
}

/** session_id ごとの累積カウンタ snapshot ファイルパス */
export function rtkCumPath(logsDir: string, sessionId: string): string {
  return join(logsDir, '.rtk-cum', `${sessionId}.json`)
}

/** snapshot を読む。無 / 壊れていれば null。 */
export function readRtkCum(path: string): RtkGainSnapshot | null {
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const parsed = safeParseJson(content)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const totalSaved = parsed.total_saved
  const totalCommands = parsed.total_commands
  if (typeof totalSaved !== 'number' || typeof totalCommands !== 'number') return null
  return { total_saved: totalSaved, total_commands: totalCommands }
}

/** snapshot を書く。親ディレクトリは無ければ作成。 */
export function writeRtkCum(path: string, snap: RtkGainSnapshot): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, JSON.stringify(snap), { mode: 0o600 })
}

/** snapshot を削除。無くてもエラーにしない。 */
export function deleteRtkCum(path: string): void {
  try {
    rmSync(path)
  } catch {
    // 無い場合は無視
  }
}
