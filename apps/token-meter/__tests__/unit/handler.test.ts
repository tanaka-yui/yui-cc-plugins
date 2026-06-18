import { writeState } from '../../lib/config'
import { aggregate, handlePost, handlePre, handleStop } from '../../lib/handler'
import { dailyPath } from '../../lib/logger'

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { LogRecord } from '../../lib/types'

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'tm-h-'))
  const logsDir = join(root, 'logs')
  const statePath = join(root, 'state.json')
  writeState(statePath, { enabled: true, tools: {}, plugins: {} })
  return { root, logsDir, statePath }
}

describe('handler', () => {
  test('handlePre: 通常 tool の pre レコードを 1 行追記', () => {
    const { root, logsDir, statePath } = setup()
    handlePre({ session_id: 's1', tool_name: 'Read', tool_input: { file_path: '/x' } }, { logsDir, statePath })
    const lines = readFileSync(dailyPath(logsDir, new Date()), 'utf8').trim().split('\n')
    const rec = JSON.parse(lines[0] ?? '') as LogRecord
    expect(rec.kind).toBe('pre')
    if (rec.kind === 'pre') expect(rec.tool).toBe('Read')
    rmSync(root, { recursive: true })
  })

  test('handlePre: enabled=false なら何も書かない', () => {
    const { root, logsDir, statePath } = setup()
    writeState(statePath, { enabled: false, tools: {}, plugins: {} })
    handlePre({ session_id: 's1', tool_name: 'Read' }, { logsDir, statePath })
    expect(() => readFileSync(dailyPath(logsDir, new Date()))).toThrow()
    rmSync(root, { recursive: true })
  })

  test('handlePost: rtk wrap を post.rtk として記録', () => {
    const { root, logsDir, statePath } = setup()
    handlePost(
      {
        session_id: 's1',
        tool_name: 'Bash',
        tool_input: { command: 'rtk git status' },
        tool_response: { stdout: 'M file\n', metadata: { rtk_saved_tokens: 100 } },
        duration_ms: 50,
      },
      { logsDir, statePath },
    )
    const lines = readFileSync(dailyPath(logsDir, new Date()), 'utf8').trim().split('\n')
    const rec = JSON.parse(lines[0] ?? '') as LogRecord
    expect(rec.kind).toBe('post.rtk')
    if (rec.kind === 'post.rtk') {
      expect(rec.raw_command).toBe('git status')
      expect(rec.rtk_saved_tokens).toBe(100)
    }
    rmSync(root, { recursive: true })
  })

  test('handlePost: MCP 圧縮 tool を post.compress として ratio 付きで記録', () => {
    const { root, logsDir, statePath } = setup()
    handlePost(
      {
        session_id: 's1',
        tool_name: 'mcp__headroom__compress',
        tool_input: { text: 'a'.repeat(400) },
        tool_response: { compressed: 'a'.repeat(40) },
      },
      { logsDir, statePath },
    )
    const lines = readFileSync(dailyPath(logsDir, new Date()), 'utf8').trim().split('\n')
    const rec = JSON.parse(lines[0] ?? '') as LogRecord
    expect(rec.kind).toBe('post.compress')
    if (rec.kind === 'post.compress') {
      expect(rec.label).toBe('headroom')
      expect(rec.ratio).toBeLessThan(1)
    }
    rmSync(root, { recursive: true })
  })

  test('aggregate: post.normal + post.rtk + post.compress を集計', () => {
    const recs: LogRecord[] = [
      {
        kind: 'post.normal',
        ts: '',
        session: 's',
        tool: 'Read',
        input_tokens: 1,
        output_tokens: 100,
        output_bytes: 400,
        duration_ms: 10,
      },
      {
        kind: 'post.rtk',
        ts: '',
        session: 's',
        tool: 'Bash',
        raw_command: 'ls',
        wrapped_command: 'rtk ls',
        output_tokens: 20,
        rtk_saved_tokens: 80,
      },
      {
        kind: 'post.compress',
        ts: '',
        session: 's',
        tool: 'mcp__headroom__compress',
        label: 'headroom',
        input_tokens: 1000,
        output_tokens: 100,
        ratio: 0.1,
      },
    ]
    const sum = aggregate(recs)
    expect(sum.tool_calls).toBe(3)
    expect(sum.output_tokens_total).toBe(220)
    expect(sum.by_tool.Read).toBe(100)
    expect(sum.rtk.calls).toBe(1)
    expect(sum.rtk.saved).toBe(80)
    expect(sum.compression.headroom?.saved).toBe(900)
  })

  test('handleStop: 集計 stop レコードを追記', () => {
    const { root, logsDir, statePath } = setup()
    handlePre({ session_id: 's1', tool_name: 'Read' }, { logsDir, statePath })
    handlePost(
      { session_id: 's1', tool_name: 'Read', tool_response: { content: 'hello' }, duration_ms: 5 },
      { logsDir, statePath },
    )
    handleStop({ session_id: 's1' }, { logsDir, statePath })
    const lines = readFileSync(dailyPath(logsDir, new Date()), 'utf8').trim().split('\n')
    const last = JSON.parse(lines[lines.length - 1] ?? '') as LogRecord
    expect(last.kind).toBe('stop')
    if (last.kind === 'stop') {
      expect(last.summary.tool_calls).toBeGreaterThan(0)
    }
    rmSync(root, { recursive: true })
  })
})
