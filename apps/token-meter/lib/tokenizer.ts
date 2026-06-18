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
 * UTF-8 マルチバイト文字 (日本語等) でも byte 境界を守る。
 */
export function truncateForTokenize(text: string, maxBytes = 262_144): { text: string; truncated: boolean } {
  const totalBytes = Buffer.byteLength(text, 'utf8')
  if (totalBytes <= maxBytes) {
    return { text, truncated: false }
  }
  const halfBytes = Math.floor(maxBytes / 2)
  // 先頭/末尾を byte 境界で切り出す (UTF-8 char boundary を尊重)
  const headChars = sliceByBytes(text, halfBytes, 'head')
  const tailChars = sliceByBytes(text, halfBytes, 'tail')
  return { text: headChars + tailChars, truncated: true }
}

function sliceByBytes(text: string, maxBytes: number, side: 'head' | 'tail'): string {
  let acc = 0
  if (side === 'head') {
    let i = 0
    for (; i < text.length; i++) {
      const charBytes = Buffer.byteLength(text[i] ?? '', 'utf8')
      if (acc + charBytes > maxBytes) break
      acc += charBytes
    }
    return text.slice(0, i)
  }
  let i = text.length
  for (; i > 0; i--) {
    const charBytes = Buffer.byteLength(text[i - 1] ?? '', 'utf8')
    if (acc + charBytes > maxBytes) break
    acc += charBytes
  }
  return text.slice(i)
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
