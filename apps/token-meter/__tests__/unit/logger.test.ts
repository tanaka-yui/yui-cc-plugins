import { appendErrorLog, appendLog, dailyPath, readTodayRecords } from '../../lib/logger'

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { LogRecord } from '../../lib/types'

describe('logger', () => {
  test('dailyPath は dir/YYYY-MM-DD.jsonl を返す', () => {
    const d = new Date('2026-06-18T10:00:00Z')
    expect(dailyPath('/tmp/x', d)).toBe('/tmp/x/2026-06-18.jsonl')
  })

  test('appendLog は JSONL 1 行を追記する', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tm-'))
    const rec: LogRecord = {
      kind: 'pre',
      ts: '2026-06-18T00:00:00.000Z',
      session: 's1',
      tool: 'Read',
      input_tokens: 5,
      input_bytes: 10,
    }
    appendLog(rec, dir)
    const path = dailyPath(dir, new Date())
    expect(existsSync(path)).toBe(true)
    const lines = readFileSync(path, 'utf8').trim().split('\n')
    expect(lines.length).toBe(1)
    expect(JSON.parse(lines[0] ?? '{}').kind).toBe('pre')
    rmSync(dir, { recursive: true })
  })

  test('appendLog は同日複数回呼ぶと append される', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tm-'))
    for (let i = 0; i < 3; i++) {
      appendLog(
        { kind: 'pre', ts: '2026-06-18T00:00:00.000Z', session: 's', tool: 'T', input_tokens: i, input_bytes: i },
        dir,
      )
    }
    const lines = readFileSync(dailyPath(dir, new Date()), 'utf8').trim().split('\n')
    expect(lines.length).toBe(3)
    rmSync(dir, { recursive: true })
  })

  test('readTodayRecords は session 一致のみ返す', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tm-'))
    appendLog({ kind: 'pre', ts: '', session: 'A', tool: 'T', input_tokens: 1, input_bytes: 1 }, dir)
    appendLog({ kind: 'pre', ts: '', session: 'B', tool: 'T', input_tokens: 2, input_bytes: 2 }, dir)
    appendLog({ kind: 'pre', ts: '', session: 'A', tool: 'T', input_tokens: 3, input_bytes: 3 }, dir)
    const recs = readTodayRecords(dir, 'A')
    expect(recs.length).toBe(2)
    rmSync(dir, { recursive: true })
  })

  test('appendErrorLog は dir/../error.log に追記する', () => {
    const root = mkdtempSync(join(tmpdir(), 'tm-'))
    const logs = join(root, 'logs')
    appendErrorLog(new Error('boom'), logs)
    const errLog = readFileSync(join(root, 'error.log'), 'utf8')
    expect(errLog).toContain('boom')
    rmSync(root, { recursive: true })
  })
})
