import { classify, extractField, TARGETS } from '../../lib/targets'

import { describe, expect, test } from 'bun:test'

describe('targets', () => {
  test('extractField はドット記法でネストを取り出す', () => {
    expect(extractField({ a: { b: { c: 1 } } }, 'a.b.c')).toBe(1)
    expect(extractField({ a: 1 }, 'a.b')).toBeUndefined()
  })

  test('TARGETS.scope.exclude に TodoWrite/TodoRead を含む', () => {
    expect(TARGETS.scope.exclude).toEqual(['TodoWrite', 'TodoRead'])
  })

  test('classify: Bash + "rtk foo" は kind=rtk', () => {
    const r = classify('Bash', { session_id: 's', tool_name: 'Bash', tool_input: { command: 'rtk ls' } }, TARGETS)
    expect(r.kind).toBe('rtk')
    if (r.kind === 'rtk') {
      expect(r.wrapped_command).toBe('rtk ls')
      expect(r.raw_command).toBe('ls')
    }
  })

  test('classify: Bash + 通常コマンドは kind=normal', () => {
    const r = classify('Bash', { session_id: 's', tool_name: 'Bash', tool_input: { command: 'ls -l' } }, TARGETS)
    expect(r.kind).toBe('normal')
  })

  test('classify: mcp__headroom__headroom_compress は kind=compression label=headroom', () => {
    const r = classify(
      'mcp__headroom__headroom_compress',
      { session_id: 's', tool_name: 'mcp__headroom__headroom_compress', tool_input: { text: 'hi' } },
      TARGETS,
    )
    expect(r.kind).toBe('compression')
    if (r.kind === 'compression') {
      expect(r.def.label).toBe('headroom')
      expect(r.def.inputField).toBe('tool_input.content')
      expect(typeof r.def.extract).toBe('function')
    }
  })

  test('classify: Read は kind=normal', () => {
    const r = classify('Read', { session_id: 's', tool_name: 'Read' }, TARGETS)
    expect(r.kind).toBe('normal')
  })
})
