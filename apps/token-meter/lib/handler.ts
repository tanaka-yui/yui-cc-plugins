// token-meter の中心パイプライン。pre / post / stop hook エントリから呼ばれる。
import { readState, shouldMeasure } from './config'
import { appendLog, readTodayRecords } from './logger'
import { classify, getFromPayload, TARGETS } from './targets'
import { tokenize } from './tokenizer'

import type { JsonValue, LogRecord, SessionSummary, StopPayload, ToolPayload } from './types'

export type HandlerOpts = {
  logsDir: string
  statePath: string
  now?: () => Date
}

/** 現在時刻を ISO 8601 文字列で返す */
function isoNow(opts: HandlerOpts): string {
  return (opts.now ? opts.now() : new Date()).toISOString()
}

/** JsonValue を文字列に変換する。undefined / null は空文字列。 */
function toText(v: JsonValue | undefined): string {
  if (v === undefined || v === null) return ''
  if (typeof v === 'string') return v
  return JSON.stringify(v)
}

/** テキストのトークン数を返す内部ヘルパ */
function tokensOf(text: string): number {
  return tokenize(text, TARGETS.tokenizer.mode).tokens
}

/** PreToolUse hook — input token 数を pre レコードとして記録する */
export function handlePre(payload: ToolPayload, opts: HandlerOpts): void {
  const state = readState(opts.statePath)
  if (!shouldMeasure(state, payload.tool_name, TARGETS.scope)) return
  const inputText = toText(payload.tool_input)
  const rec: LogRecord = {
    kind: 'pre',
    ts: isoNow(opts),
    session: payload.session_id,
    tool: payload.tool_name,
    input_tokens: tokensOf(inputText),
    input_bytes: Buffer.byteLength(inputText, 'utf8'),
  }
  appendLog(rec, opts.logsDir)
}

/** PostToolUse hook — tool を分類して適切な post レコードを記録する */
export function handlePost(payload: ToolPayload, opts: HandlerOpts): void {
  const state = readState(opts.statePath)
  if (!shouldMeasure(state, payload.tool_name, TARGETS.scope)) return
  const cls = classify(payload.tool_name, payload, TARGETS)
  const ts = isoNow(opts)

  if (cls.kind === 'rtk') {
    const wrapper = TARGETS.rtkWrappers.find((w) => w.tool === payload.tool_name)
    const savedRaw = wrapper ? getFromPayload(payload, wrapper.savingsField) : undefined
    const saved = typeof savedRaw === 'number' ? savedRaw : null
    const outputText = toText(payload.tool_response)
    appendLog(
      {
        kind: 'post.rtk',
        ts,
        session: payload.session_id,
        tool: 'Bash',
        raw_command: cls.raw_command,
        wrapped_command: cls.wrapped_command,
        output_tokens: tokensOf(outputText),
        rtk_saved_tokens: saved,
      },
      opts.logsDir,
    )
    return
  }

  if (cls.kind === 'compression') {
    const inText = toText(getFromPayload(payload, cls.inputField))
    const outText = toText(getFromPayload(payload, cls.outputField))
    const inTok = tokensOf(inText)
    const outTok = tokensOf(outText)
    appendLog(
      {
        kind: 'post.compress',
        ts,
        session: payload.session_id,
        tool: payload.tool_name,
        label: cls.label,
        input_tokens: inTok,
        output_tokens: outTok,
        ratio: inTok === 0 ? 0 : outTok / inTok,
      },
      opts.logsDir,
    )
    return
  }

  // normal (および skip の fallback)
  const inputText = toText(payload.tool_input)
  const outputText = toText(payload.tool_response)
  appendLog(
    {
      kind: 'post.normal',
      ts,
      session: payload.session_id,
      tool: payload.tool_name,
      input_tokens: tokensOf(inputText),
      output_tokens: tokensOf(outputText),
      output_bytes: Buffer.byteLength(outputText, 'utf8'),
      duration_ms: payload.duration_ms ?? 0,
    },
    opts.logsDir,
  )
}

/** セッション全レコードから集計サマリーを返す純粋関数 */
export function aggregate(records: LogRecord[]): SessionSummary {
  const summary: SessionSummary = {
    tool_calls: 0,
    output_tokens_total: 0,
    by_tool: {},
    rtk: { calls: 0, saved: 0 },
    compression: {},
  }
  for (const r of records) {
    if (r.kind === 'post.normal') {
      summary.tool_calls++
      summary.output_tokens_total += r.output_tokens
      summary.by_tool[r.tool] = (summary.by_tool[r.tool] ?? 0) + r.output_tokens
    } else if (r.kind === 'post.rtk') {
      summary.tool_calls++
      summary.output_tokens_total += r.output_tokens
      summary.by_tool[r.tool] = (summary.by_tool[r.tool] ?? 0) + r.output_tokens
      summary.rtk.calls++
      summary.rtk.saved += r.rtk_saved_tokens ?? 0
    } else if (r.kind === 'post.compress') {
      summary.tool_calls++
      summary.output_tokens_total += r.output_tokens
      summary.by_tool[r.tool] = (summary.by_tool[r.tool] ?? 0) + r.output_tokens
      const bucket = summary.compression[r.label] ?? { calls: 0, saved: 0 }
      bucket.calls++
      bucket.saved += Math.max(0, r.input_tokens - r.output_tokens)
      summary.compression[r.label] = bucket
    }
  }
  return summary
}

/** Stop hook — 当日の session レコードを集計して stop レコードを追記する */
export function handleStop(payload: StopPayload, opts: HandlerOpts): void {
  const state = readState(opts.statePath)
  if (!state.enabled) return
  // 注: readTodayRecords は今日の UTC 日付の JSONL のみを読む。
  // セッションが UTC midnight を跨ぐ場合、summary は前日分のレコードを集計対象から外す。
  // spec §15 のオープン項目として将来対応 (今日と昨日の両方を読む形に拡張する余地)。
  const recs = readTodayRecords(opts.logsDir, payload.session_id)
  const summary = aggregate(recs)
  appendLog(
    {
      kind: 'stop',
      ts: isoNow(opts),
      session: payload.session_id,
      summary,
    },
    opts.logsDir,
  )
}
