// hook-stop shim の統合テスト

import { dailyPath } from '../../lib/logger'
import { binPath, runHook } from './helpers'

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PRE_BIN = binPath('bin/hook-pre-tool-use.ts')
const POST_BIN = binPath('bin/hook-post-tool-use.ts')
const STOP_BIN = binPath('bin/hook-stop.ts')

describe('hook-stop', () => {
  test('pre / post 後に stop を呼ぶと kind:stop レコードが追記され summary.tool_calls > 0', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tm-i-'))
    try {
      const sid = 'sess-stop-1'

      // pre
      await runHook(PRE_BIN, { session_id: sid, tool_name: 'Read', tool_input: { file_path: '/a' } }, home)
      // post
      await runHook(
        POST_BIN,
        {
          session_id: sid,
          tool_name: 'Read',
          tool_input: { file_path: '/a' },
          tool_response: { content: 'abc' },
          duration_ms: 10,
        },
        home,
      )
      // stop
      const { code } = await runHook(STOP_BIN, { session_id: sid }, home)
      expect(code).toBe(0)

      const lines = readFileSync(dailyPath(join(home, 'logs'), new Date()), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
      const stopRec = lines.find((r) => r.kind === 'stop' && r.session === sid)
      expect(stopRec).toBeDefined()
      expect(stopRec.summary.tool_calls).toBeGreaterThan(0)
    } finally {
      rmSync(home, { recursive: true })
    }
  })
})
