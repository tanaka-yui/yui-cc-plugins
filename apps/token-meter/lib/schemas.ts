// zod v4 スキーマ定義。外部から流れ込む hook stdin JSON の境界検証に使う。
// unknown / any は禁止。すべての外部データはここを通過させる。
import { z } from 'zod'

// TypeScript では再帰型エイリアスを z.ZodType<T> の型引数に渡すことができる。
// `type T = ... | T[]` の形式は TypeScript が許容する (直接 infer への代入ではないため)。
// ref: https://zod.dev/v4?id=recursive-types
type _JsonValue = string | number | boolean | null | _JsonValue[] | { [k: string]: _JsonValue }

export const JsonValueSchema: z.ZodType<_JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
)

// 公開型
export type JsonValue = _JsonValue

// PreToolUse / PostToolUse hook の stdin payload
export const ToolPayloadSchema = z.object({
  session_id: z.string(),
  tool_name: z.string(),
  tool_input: JsonValueSchema.optional(),
  tool_response: JsonValueSchema.optional(),
  duration_ms: z.number().optional(),
})
export type ToolPayload = z.infer<typeof ToolPayloadSchema>

// Stop hook の stdin payload
export const StopPayloadSchema = z.object({
  session_id: z.string(),
  transcript_path: z.string().optional(),
})
export type StopPayload = z.infer<typeof StopPayloadSchema>

// .claude.json の MCP サーバエントリ
const McpServerEntrySchema = z
  .object({
    enabled: z.boolean().optional(),
  })
  .passthrough()

// .claude.json のトップレベル構造
export const ClaudeConfigSchema = z
  .object({
    mcpServers: z.record(z.string(), McpServerEntrySchema).optional(),
  })
  .passthrough()

export type ClaudeConfig = z.infer<typeof ClaudeConfigSchema>

// settings.json の hook コマンドエントリ
export const HookCommandSchema = z.object({
  type: z.literal('command'),
  command: z.string(),
})

// settings.json の hook グループ (matcher + hooks 配列)
export const HookGroupSchema = z.object({
  matcher: z.string().optional(),
  hooks: z.array(HookCommandSchema),
})

// ~/.claude/settings.json のトップレベル構造
// passthrough() で未知フィールドを保持する
export const SettingsJsonSchema = z
  .object({
    hooks: z.record(z.string(), z.array(HookGroupSchema)).optional(),
  })
  .passthrough()

export type SettingsJson = z.infer<typeof SettingsJsonSchema>
export type HookGroup = z.infer<typeof HookGroupSchema>
export type HookCommand = z.infer<typeof HookCommandSchema>
