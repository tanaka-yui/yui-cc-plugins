// enabled フラグ・per-tool override の end-to-end テスト

import { writeState } from '../../lib/config'
import { dailyPath } from '../../lib/logger'
import { binPath, runHook } from './helpers'

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PRE_BIN = binPath('bin/hook-pre-tool-use.ts')

describe('e2e-flag', () => {
  test('enabled:false のとき hook-pre を呼んでも JSONL ファイルが作成されない', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tm-i-'))
    try {
      const statePath = join(home, 'state.json')
      writeState(statePath, { enabled: false, tools: {}, plugins: {} })

      const { code } = await runHook(
        PRE_BIN,
        { session_id: 'off', tool_name: 'Read', tool_input: { file_path: '/x' } },
        home,
      )
      expect(code).toBe(0)
      expect(existsSync(dailyPath(join(home, 'logs'), new Date()))).toBe(false)
    } finally {
      rmSync(home, { recursive: true })
    }
  })

  test('tools.Read:false のとき hook-pre Read を呼んでも JSONL に記録されない', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tm-i-'))
    try {
      const statePath = join(home, 'state.json')
      writeState(statePath, { enabled: true, tools: { Read: false }, plugins: {} })

      const { code } = await runHook(
        PRE_BIN,
        { session_id: 'excl', tool_name: 'Read', tool_input: { file_path: '/x' } },
        home,
      )
      expect(code).toBe(0)
      expect(existsSync(dailyPath(join(home, 'logs'), new Date()))).toBe(false)
    } finally {
      rmSync(home, { recursive: true })
    }
  })
})
