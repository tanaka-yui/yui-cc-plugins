// token-meter 計測対象の設定定義と tool 分類ロジック
import type { JsonValue, TargetConfig, ToolClassification, ToolPayload } from './types'

/**
 * headroom MCP の応答から original_tokens / compressed_tokens を直接取り出す。
 * 実 wire 形式: tool_response = [{type: "text", text: "<JSON 文字列>"}]
 * JSON 文字列内に { original_tokens, compressed_tokens, tokens_saved, ... } がある。
 * 期待形式に合致しなければ null を返し、handler 側で text 経路にフォールバックさせる。
 */
function extractHeadroomTokens(payload: ToolPayload): { input_tokens: number; output_tokens: number } | null {
  const resp = payload.tool_response
  if (!Array.isArray(resp) || resp.length === 0) return null
  const first = resp[0]
  if (!first || typeof first !== 'object' || Array.isArray(first)) return null
  const text = (first as Record<string, JsonValue>).text
  if (typeof text !== 'string') return null
  let parsed: JsonValue
  try {
    parsed = JSON.parse(text) as JsonValue
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const orig = parsed.original_tokens
  const comp = parsed.compressed_tokens
  if (typeof orig !== 'number' || typeof comp !== 'number') return null
  return { input_tokens: orig, output_tokens: comp }
}

// デフォルト TARGETS — spec §4.1 と同一
export const TARGETS: TargetConfig = {
  scope: {
    include: ['*'],
    exclude: ['TodoWrite', 'TodoRead'],
  },
  rtkWrappers: [
    {
      tool: 'Bash',
      detectField: 'tool_input.command',
      pattern: /^\s*rtk\s+(.+)$/,
      savingsField: 'tool_response.metadata.rtk_saved_tokens',
    },
  ],
  compressionTools: [
    {
      tool: 'mcp__headroom__headroom_compress',
      // text path fallback。実際は extract で原 token 数を直読みする (tool_response が [{type,text}] 配列で dot-path では届かないため)。
      inputField: 'tool_input.content',
      outputField: 'tool_response',
      label: 'headroom',
      extract: extractHeadroomTokens,
    },
    {
      tool: 'mcp__caveman-shrink__compress',
      inputField: 'tool_input.body',
      outputField: 'tool_response.body',
      label: 'caveman',
    },
  ],
  output: {
    dir: `${process.env.HOME ?? ''}/.claude/token-meter/logs`,
    rotation: 'daily',
    maxFileSizeMB: 100,
  },
  tokenizer: {
    mode: 'anthropic',
    fallbackToApprox: true,
  },
}

// ドット記法でネストした JsonValue からフィールドを取り出す
// 配列や null に到達した場合は undefined を返す
export function extractField(obj: JsonValue | undefined, path: string): JsonValue | undefined {
  if (!path) return obj
  const parts = path.split('.')
  let cur: JsonValue | undefined = obj
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object' || Array.isArray(cur)) return undefined
    cur = (cur as Record<string, JsonValue>)[p]
  }
  return cur
}

// ToolPayload から detectField のドット記法パスで値を取り出す
// 先頭セグメントが tool_input / tool_response に対応する
export function getFromPayload(payload: ToolPayload, path: string): JsonValue | undefined {
  const dotIndex = path.indexOf('.')
  const head = dotIndex === -1 ? path : path.slice(0, dotIndex)
  const rest = dotIndex === -1 ? '' : path.slice(dotIndex + 1)

  let base: JsonValue | undefined
  if (head === 'tool_input') {
    base = payload.tool_input
  } else if (head === 'tool_response') {
    base = payload.tool_response
  } else {
    return undefined
  }

  if (!rest) return base
  return extractField(base, rest)
}

// ToolPayload を rtk / compression / normal に分類する
export function classify(toolName: string, payload: ToolPayload, targets: TargetConfig): ToolClassification {
  // rtk ラッパーを先に検査
  for (const w of targets.rtkWrappers) {
    if (w.tool !== toolName) continue
    const cmd = getFromPayload(payload, w.detectField)
    if (typeof cmd !== 'string') continue
    const match = cmd.match(w.pattern)
    if (match) {
      return {
        kind: 'rtk',
        raw_command: match[1] ?? '',
        wrapped_command: cmd,
      }
    }
  }

  // 圧縮ツールを検査
  for (const c of targets.compressionTools) {
    if (c.tool === toolName) {
      return { kind: 'compression', def: c }
    }
  }

  return { kind: 'normal' }
}
