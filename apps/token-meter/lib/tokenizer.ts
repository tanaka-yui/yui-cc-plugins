import { countTokens } from '@anthropic-ai/tokenizer'

/**
 * テキストのバイト長から簡易トークン数を近似する。
 * UTF-8 バイト長 / 4 の切り上げ。
 */
export function approxTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4)
}

/**
 * テキストが maxBytes を超える場合、先頭と末尾をサンプリングして返す。
 * truncated フラグで切り詰めが発生したかどうかを示す。
 */
export function truncateForTokenize(text: string, maxBytes = 262_144): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return { text, truncated: false }
  }
  const half = Math.floor(maxBytes / 2)
  const head = text.slice(0, half)
  const tail = text.slice(-half)
  return { text: head + tail, truncated: true }
}

/**
 * テキストのトークン数を計算する。
 *
 * - mode='anthropic': @anthropic-ai/tokenizer の countTokens を使用。
 *   256KB 超は先頭/末尾サンプリング後に比率スケールで推定。
 *   tokenizer 失敗時は approxTokens にフォールバック (degraded=true)。
 * - mode='approx': approxTokens を使用し、常に degraded=true を返す。
 */
export function tokenize(text: string, mode: 'anthropic' | 'approx'): { tokens: number; degraded: boolean } {
  if (mode === 'approx') {
    return { tokens: approxTokens(text), degraded: true }
  }
  try {
    const { text: sampled, truncated } = truncateForTokenize(text)
    const tokens = countTokens(sampled)
    if (truncated) {
      const originalBytes = Buffer.byteLength(text, 'utf8')
      const sampledBytes = Buffer.byteLength(sampled, 'utf8')
      const estimated = Math.ceil(tokens * (originalBytes / sampledBytes))
      return { tokens: estimated, degraded: true }
    }
    return { tokens, degraded: false }
  } catch {
    return { tokens: approxTokens(text), degraded: true }
  }
}
