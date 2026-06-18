import { describe, expect, test } from 'bun:test'

import type { LogRecord, State, TargetConfig } from '../../lib/types'

describe('types', () => {
  test('LogRecord discriminated union が kind で narrowing できる', () => {
    const rec: LogRecord = {
      kind: 'pre',
      ts: '2026-06-18T00:00:00.000Z',
      session: 's1',
      tool: 'Read',
      input_tokens: 10,
      input_bytes: 30,
    }
    if (rec.kind === 'pre') {
      expect(rec.input_tokens).toBe(10)
    }
  })

  test('State.tools と State.plugins は省略可能なフラグ辞書', () => {
    const s: State = { enabled: true, tools: {}, plugins: {} }
    expect(s.enabled).toBe(true)
  })

  test('TargetConfig.scope は include/exclude を持つ', () => {
    const t: TargetConfig = {
      scope: { include: ['*'], exclude: ['TodoWrite'] },
      rtkWrappers: [],
      compressionTools: [],
      output: { dir: '/tmp', rotation: 'daily', maxFileSizeMB: 100 },
      tokenizer: { mode: 'anthropic', fallbackToApprox: true },
    }
    expect(t.scope.exclude).toContain('TodoWrite')
  })
})
