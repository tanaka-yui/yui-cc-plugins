// token-meter 計測対象の設定定義と tool 分類ロジック
import type { JsonValue, TargetConfig, ToolClassification, ToolPayload } from './types'

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
      tool: 'mcp__headroom__compress',
      inputField: 'tool_input.text',
      outputField: 'tool_response.compressed',
      label: 'headroom',
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
      return { kind: 'compression', label: c.label, inputField: c.inputField, outputField: c.outputField }
    }
  }

  return { kind: 'normal' }
}
