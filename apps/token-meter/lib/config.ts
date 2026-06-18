// state.json の読み書きと計測判定ロジック。
// writeState は atomic write (tmpfile → rename) で OS レベルの整合性を保証する。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { State, TargetConfig } from './types'

const DEFAULT_STATE: State = { enabled: true, tools: {}, plugins: {} }

/** state.json を読み込む。ファイルが未存在またはパース失敗時はデフォルト値を返す。 */
export function readState(path: string): State {
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as Partial<State>
    return {
      enabled: parsed.enabled ?? true,
      tools: parsed.tools ?? {},
      plugins: parsed.plugins ?? {},
    }
  } catch {
    return { ...DEFAULT_STATE }
  }
}

/** state.json を atomic write で書き込む。ディレクトリが存在しない場合は作成する。 */
export function writeState(path: string, state: State): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = join(dirname(path), `.state.${process.pid}.${Date.now()}.tmp`)
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, path)
}

/**
 * toolName が scope に含まれるか判定する。
 * exclude が include より優先される。include に `*` が含まれる場合は全ツールを対象とする。
 */
export function matchesScope(toolName: string, scope: TargetConfig['scope']): boolean {
  for (const ex of scope.exclude) {
    if (ex === toolName) return false
  }
  for (const inc of scope.include) {
    if (inc === '*' || inc === toolName) return true
  }
  return false
}

/**
 * 指定ツール呼び出しを計測すべきか判定する純粋関数。
 * 判定優先順位:
 *   1. state.enabled === false → false
 *   2. state.tools[toolName] が定義済み → そのまま返す
 *   3. それ以外 → matchesScope で判定
 */
export function shouldMeasure(state: State, toolName: string, scope: TargetConfig['scope']): boolean {
  if (!state.enabled) return false
  const override = state.tools[toolName]
  if (override !== undefined) return override
  return matchesScope(toolName, scope)
}
