// hook-pre-tool-use shim の統合テスト

import { dailyPath } from '../../lib/logger'
import { binPath, runHook, runHookRaw } from './helpers'

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BIN = binPath('bin/hook-pre-tool-use.ts')

describe('hook-pre-tool-use', () => {
  test('正常な payload を JSONL に記録し exit 0', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tm-i-'))
    try {
      const { code } = await runHook(
        BIN,
        {
          session_id: 's1',
          tool_name: 'Read',
          tool_input: { file_path: '/x' },
        },
        home,
      )
      expect(code).toBe(0)
      const lines = readFileSync(dailyPath(join(home, 'logs'), new Date()), 'utf8')
        .trim()
        .split('\n')
      expect(JSON.parse(lines[0]!).tool).toBe('Read')
    } finally {
      rmSync(home, { recursive: true })
    }
  })

  test('不正な JSON でも exit 0 で error.log に記録', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tm-i-'))
    try {
      const { code } = await runHookRaw(BIN, '{not json', home)
      expect(code).toBe(0)
      const errLog = readFileSync(join(home, 'error.log'), 'utf8')
      expect(errLog.length).toBeGreaterThan(0)
    } finally {
      rmSync(home, { recursive: true })
    }
  })
})
