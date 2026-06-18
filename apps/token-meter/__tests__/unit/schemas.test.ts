import { JsonValueSchema, StopPayloadSchema, ToolPayloadSchema } from '../../lib/schemas'

import { describe, expect, test } from 'bun:test'

describe('schemas', () => {
  test('ToolPayloadSchema.parse が最小セットで通る', () => {
    const result = ToolPayloadSchema.parse({ session_id: 's', tool_name: 'Read' })
    expect(result.session_id).toBe('s')
    expect(result.tool_name).toBe('Read')
  })

  test('ToolPayloadSchema.safeParse が session_id 欠落で false を返す', () => {
    const result = ToolPayloadSchema.safeParse({ tool_name: 'Read' })
    expect(result.success).toBe(false)
  })

  test('JsonValueSchema.parse がネストオブジェクトで通る', () => {
    const result = JsonValueSchema.parse({ nested: { arr: [1, 'a', null] } })
    expect(result).toEqual({ nested: { arr: [1, 'a', null] } })
  })

  test('StopPayloadSchema.parse が最小セットで通る', () => {
    const result = StopPayloadSchema.parse({ session_id: 'abc' })
    expect(result.session_id).toBe('abc')
    expect(result.transcript_path).toBeUndefined()
  })
})
