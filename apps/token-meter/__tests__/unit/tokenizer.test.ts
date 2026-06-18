import { approxTokens, tokenize, truncateForTokenize } from '../../lib/tokenizer'

import { describe, expect, test } from 'bun:test'

describe('tokenizer', () => {
  test('anthropic モードで hello world のトークン数を返す', () => {
    const result = tokenize('hello world', 'anthropic')
    expect(result.tokens).toBeGreaterThan(0)
    expect(result.degraded).toBe(false)
  })

  test('approx モードはバイト数 / 4 を切り上げる', () => {
    expect(approxTokens('a'.repeat(8))).toBe(2)
    expect(approxTokens('a'.repeat(9))).toBe(3)
  })

  test('approx モードで degraded=true を返す', () => {
    const r = tokenize('abc', 'approx')
    expect(r.degraded).toBe(true)
  })

  test('256KB を超えるテキストは先頭/末尾サンプリングされる', () => {
    const big = 'a'.repeat(300_000)
    const r = truncateForTokenize(big, 262_144)
    expect(r.truncated).toBe(true)
    expect(r.text.length).toBeLessThanOrEqual(262_144)
  })

  test('256KB 以下はそのまま返す', () => {
    const r = truncateForTokenize('short', 262_144)
    expect(r.truncated).toBe(false)
    expect(r.text).toBe('short')
  })
})
