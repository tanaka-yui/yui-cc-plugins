// JSONL ロガー — daily rotation + session フィルタ
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { LogRecord } from './types'

/** `${dir}/YYYY-MM-DD.jsonl` のパスを返す純粋関数 (UTC 日付) */
export function dailyPath(dir: string, now: Date): string {
  const y = now.getUTCFullYear()
  const m = String(now.getUTCMonth() + 1).padStart(2, '0')
  const d = String(now.getUTCDate()).padStart(2, '0')
  return join(dir, `${y}-${m}-${d}.jsonl`)
}

/** LogRecord を当日の JSONL ファイルに 1 行 append する (O_APPEND) */
export function appendLog(record: LogRecord, dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = dailyPath(dir, new Date())
  appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 })
}

/** エラーを `${dirname(logsDir)}/error.log` に append する */
export function appendErrorLog(err: unknown, logsDir: string): void {
  const parent = dirname(logsDir)
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)
  const ts = new Date().toISOString()
  appendFileSync(join(parent, 'error.log'), `[${ts}] ${msg}\n`, { mode: 0o600 })
}

/** 当日 JSONL から session 一致レコードのみ抽出して返す */
export function readTodayRecords(dir: string, session: string): LogRecord[] {
  const path = dailyPath(dir, new Date())
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const out: LogRecord[] = []
  for (const line of content.split('\n')) {
    if (!line) continue
    try {
      const rec = JSON.parse(line) as LogRecord
      if (rec.session === session) out.push(rec)
    } catch {
      // 壊れた行は skip して次へ
    }
  }
  return out
}
