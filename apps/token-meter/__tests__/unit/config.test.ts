import { matchesScope, readState, shouldMeasure, writeState } from '../../lib/config'

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { State } from '../../lib/types'

const SCOPE = { include: ['*'], exclude: ['TodoWrite', 'TodoRead'] }

describe('config', () => {
  test('readState は未存在ならデフォルトを返す', () => {
    const s = readState(join(tmpdir(), 'nonexistent-tm-state.json'))
    expect(s.enabled).toBe(true)
    expect(s.tools).toEqual({})
    expect(s.plugins).toEqual({})
  })

  test('writeState → readState で round trip', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tm-'))
    const path = join(dir, 'state.json')
    const s: State = { enabled: false, tools: { Bash: true }, plugins: { rtk: true } }
    writeState(path, s)
    expect(existsSync(path)).toBe(true)
    expect(readState(path)).toEqual(s)
    const fileMode = statSync(path).mode & 0o777
    expect(fileMode).toBe(0o600)
    rmSync(dir, { recursive: true })
  })

  test('matchesScope は include="*" + exclude を反映', () => {
    expect(matchesScope('Read', SCOPE)).toBe(true)
    expect(matchesScope('TodoWrite', SCOPE)).toBe(false)
  })

  test('shouldMeasure: state.enabled=false なら false', () => {
    const s: State = { enabled: false, tools: {}, plugins: {} }
    expect(shouldMeasure(s, 'Read', SCOPE)).toBe(false)
  })

  test('shouldMeasure: tool 別 override が最優先', () => {
    const s: State = { enabled: true, tools: { TodoWrite: true }, plugins: {} }
    expect(shouldMeasure(s, 'TodoWrite', SCOPE)).toBe(true)
  })

  test('shouldMeasure: tools.X=false で除外', () => {
    const s: State = { enabled: true, tools: { Read: false }, plugins: {} }
    expect(shouldMeasure(s, 'Read', SCOPE)).toBe(false)
  })

  test('shouldMeasure: override 無しなら scope で判定', () => {
    const s: State = { enabled: true, tools: {}, plugins: {} }
    expect(shouldMeasure(s, 'Read', SCOPE)).toBe(true)
    expect(shouldMeasure(s, 'TodoWrite', SCOPE)).toBe(false)
  })
})
