import {
  CLAUDE_LIMIT_PATTERN,
  CODEX_ERROR_MARKER,
  CODEX_LIMIT_PATTERN,
  CODEX_RESET_PATTERN,
  LIMIT_TAIL_LINES,
} from './config.ts'

import type { AgentKind, LimitHit } from './types.ts'

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DAY_MS = 24 * 60 * 60_000

const to24h = (hour: number, meridiem: string): number => (hour % 12) + (meridiem.toLowerCase() === 'pm' ? 12 : 0)

// "3:45pm" / "3pm" / "Mon 12:00am" / "Nov 13, 2026 3:45 PM" / "3:45 PM" を、now 以降の epoch ms にする
export function parseResetTime(text: string, now: Date): number | null {
  const full = /^([A-Za-z]{3}) (\d{1,2}), (\d{4}) (\d{1,2}):(\d{2})\s*([ap]m)/i.exec(text.trim())
  if (full) {
    const [, mon = '', day = '', year = '', hour = '', minute = '', meridiem = ''] = full
    const month = MONTHS.indexOf(mon.toLowerCase())
    if (month < 0) return null
    return new Date(Number(year), month, Number(day), to24h(Number(hour), meridiem), Number(minute)).getTime()
  }
  const clock = /^(?:([A-Za-z]{3})\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)/i.exec(text.trim())
  if (!clock) return null
  const [, weekday, hour = '', minute = '0', meridiem = ''] = clock
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate(), to24h(Number(hour), meridiem), Number(minute))
  if (weekday) {
    const target = WEEKDAYS.indexOf(weekday.toLowerCase())
    if (target < 0) return null
    let days = (target - now.getDay() + 7) % 7
    if (days === 0 && base.getTime() < now.getTime()) days = 7
    return base.getTime() + days * DAY_MS
  }
  return base.getTime() < now.getTime() ? base.getTime() + DAY_MS : base.getTime()
}

const lastMatch = (pattern: RegExp, text: string): RegExpExecArray | null => {
  let last: RegExpExecArray | null = null
  for (const m of text.matchAll(pattern)) last = m
  return last
}

const detectClaude = (text: string, now: Date): LimitHit | null => {
  const m = lastMatch(CLAUDE_LIMIT_PATTERN, text)
  if (!m) return null
  const [, reason = '', weekday = '', clock] = m
  return { agent: 'claude', reason, resetsAt: clock ? parseResetTime(`${weekday}${clock}`, now) : null }
}

const detectCodex = (text: string, now: Date): LimitHit | null => {
  const m = lastMatch(CODEX_LIMIT_PATTERN, text)
  if (!m) return null
  const reset = CODEX_RESET_PATTERN.exec(text.slice(m.index))
  return { agent: 'codex', reason: m[1] ?? 'usage', resetsAt: reset?.[1] ? parseResetTime(reset[1], now) : null }
}

// 画面の末尾 LIMIT_TAIL_LINES 行（空行を除く）から limit を判定する。
// 折り返しで語が分断されることがあるので、空白でつないだものと、そのままつないだものの両方を試す
export function detectLimit(agent: AgentKind, lines: readonly string[], now: Date): LimitHit | null {
  let tail = lines.filter((line) => line.trim() !== '').slice(-LIMIT_TAIL_LINES)
  if (agent === 'codex') {
    // エラー表示（■ の行）から後ろだけを見る
    const marker = tail.findLastIndex((line) => CODEX_ERROR_MARKER.test(line))
    if (marker < 0) return null
    tail = tail.slice(marker)
  }
  const detect = agent === 'claude' ? detectClaude : detectCodex
  return detect(tail.join(' '), now) ?? detect(tail.join(''), now)
}
