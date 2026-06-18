// hook-post-tool-use shim の統合テスト

import { dailyPath } from '../../lib/logger'
import { binPath, runHook } from './helpers'

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BIN = binPath('bin/hook-post-tool-use.ts')

describe('hook-post-tool-use', () => {
  test('Bash + rtk wrap payload を post.rtk レコードとして記録', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tm-i-'))
    try {
      const { code } = await runHook(
        BIN,
        {
          session_id: 's1',
          tool_name: 'Bash',
          tool_input: { command: 'rtk ls -la' },
          tool_response: { output: 'result', metadata: { rtk_saved_tokens: 42 } },
        },
        home,
      )
      expect(code).toBe(0)
      const lines = readFileSync(dailyPath(join(home, 'logs'), new Date()), 'utf8')
        .trim()
        .split('\n')
      const rec = JSON.parse(lines[0]!)
      expect(rec.kind).toBe('post.rtk')
      expect(rec.tool).toBe('Bash')
      expect(rec.raw_command).toBe('ls -la')
    } finally {
      rmSync(home, { recursive: true })
    }
  })

  test('mcp__headroom__compress payload を post.compress レコードとして記録', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tm-i-'))
    try {
      const { code } = await runHook(
        BIN,
        {
          session_id: 's2',
          tool_name: 'mcp__headroom__compress',
          tool_input: { text: 'hello world this is a long text' },
          tool_response: { compressed: 'hw long' },
        },
        home,
      )
      expect(code).toBe(0)
      const lines = readFileSync(dailyPath(join(home, 'logs'), new Date()), 'utf8')
        .trim()
        .split('\n')
      const rec = JSON.parse(lines[0]!)
      expect(rec.kind).toBe('post.compress')
      expect(rec.label).toBe('headroom')
    } finally {
      rmSync(home, { recursive: true })
    }
  })

  test('通常 Read payload (tool_response 付き) を post.normal レコードとして記録', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tm-i-'))
    try {
      const { code } = await runHook(
        BIN,
        {
          session_id: 's3',
          tool_name: 'Read',
          tool_input: { file_path: '/foo.ts' },
          tool_response: { content: 'const x = 1' },
          duration_ms: 100,
        },
        home,
      )
      expect(code).toBe(0)
      const lines = readFileSync(dailyPath(join(home, 'logs'), new Date()), 'utf8')
        .trim()
        .split('\n')
      const rec = JSON.parse(lines[0]!)
      expect(rec.kind).toBe('post.normal')
      expect(rec.tool).toBe('Read')
      expect(rec.duration_ms).toBe(100)
    } finally {
      rmSync(home, { recursive: true })
    }
  })
})
