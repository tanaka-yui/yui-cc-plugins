// token-meter の中核型定義。
// hook stdin の境界型 (JsonValue / ToolPayload / StopPayload) は schemas.ts で
// zod スキーマから生成し、ここで再エクスポートする。
export type { JsonValue, StopPayload, ToolPayload } from './schemas'

// セッション単位の集計サマリー
export type SessionSummary = {
  tool_calls: number
  output_tokens_total: number
  by_tool: Record<string, number>
  rtk: { calls: number; saved: number }
  compression: Record<string, { calls: number; saved: number }>
}

// ログレコード — kind で discriminated union する
export type LogRecord =
  | {
      kind: 'pre'
      ts: string
      session: string
      tool: string
      input_tokens: number
      input_bytes: number
    }
  | {
      kind: 'post.normal'
      ts: string
      session: string
      tool: string
      input_tokens: number
      output_tokens: number
      output_bytes: number
      duration_ms: number
      degraded?: boolean
    }
  | {
      kind: 'post.rtk'
      ts: string
      session: string
      tool: 'Bash'
      raw_command: string
      wrapped_command: string
      output_tokens: number
      rtk_saved_tokens: number | null
    }
  | {
      kind: 'post.compress'
      ts: string
      session: string
      tool: string
      label: string
      input_tokens: number
      output_tokens: number
      ratio: number
    }
  | {
      kind: 'stop'
      ts: string
      session: string
      summary: SessionSummary
    }

// token-meter の有効/無効状態とツール・プラグインごとのフラグ
export type State = {
  enabled: boolean
  tools: Record<string, boolean>
  plugins: Record<string, boolean>
}

// rtk ラッパーの定義
export type RtkWrapper = {
  tool: string
  detectField: string
  pattern: RegExp
  savingsField: string
}

// 圧縮ツールの定義
// extract が指定されていればそれを最優先。失敗時 / 未指定時は inputField/outputField の text 経路に fallback。
export type CompressionToolDef = {
  tool: string
  inputField: string
  outputField: string
  label: string
  extract?: (payload: import('./schemas').ToolPayload) => { input_tokens: number; output_tokens: number } | null
}

// 計測対象の設定
export type TargetConfig = {
  scope: { include: string[]; exclude: string[] }
  rtkWrappers: RtkWrapper[]
  compressionTools: CompressionToolDef[]
  output: { dir: string; rotation: 'daily' | 'never'; maxFileSizeMB: number }
  tokenizer: { mode: 'anthropic' | 'approx'; fallbackToApprox: boolean }
}

// 圧縮プラグインのインストール仕様
export type PluginInstallSpec =
  | { method: 'brew'; pkg: string }
  | { method: 'pip'; pkg: string }
  | { method: 'curl-sh'; url: string }

// 圧縮プラグインのインターフェース
export type CompressionPlugin = {
  name: string
  description: string
  install: PluginInstallSpec
  isInstalled: () => boolean
  enable: () => Promise<void>
  disable: () => Promise<void>
  isEnabled: () => boolean
  detect: { tool: string; pattern: RegExp } | { tool: string }
}

// hook の種別
export type HookKind = 'pre' | 'post' | 'stop'

// ツール呼び出しの分類結果
export type ToolClassification =
  | { kind: 'rtk'; raw_command: string; wrapped_command: string }
  | { kind: 'compression'; def: CompressionToolDef }
  | { kind: 'normal' }
  | { kind: 'skip' }
