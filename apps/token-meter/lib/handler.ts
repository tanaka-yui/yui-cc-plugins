// token-meter の中心パイプライン。pre / post / stop hook エントリから呼ばれる。
import { readState, shouldMeasure } from './config'
import { appendLog, readTodayRecords } from './logger'
import { deleteRtkCum, readRtkCum, readRtkGain, rtkCumPath, writeRtkCum } from './rtk-gain'
import { classify, getFromPayload, TARGETS } from './targets'
import { tokenize } from './tokenizer'

import type { RtkGainSnapshot } from './rtk-gain'
import type { JsonValue, LogRecord, SessionSummary, StopPayload, ToolPayload } from './types'

export type HandlerOpts = {
  logsDir: string
  statePath: string
  now?: () => Date
  // テスト用 DI: rtk gain サブプロセスをモック差し替えする
  getRtkGain?: () => RtkGainSnapshot | null
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
    // 旧仕様: tool_response.metadata.rtk_saved_tokens を読む経路。
    // 実 rtk は metadata を返さないため通常 undefined → null。テスト互換のため残す。
    const savedRaw = wrapper ? getFromPayload(payload, wrapper.savingsField) : undefined
    let saved: number | null = typeof savedRaw === 'number' ? savedRaw : null
    // 新仕様: `rtk gain --format json` の累積カウンタを post 毎に snapshot し、前回値との差を当該 call の節約量とする。
    if (saved === null) {
      saved = diffRtkGain(payload.session_id, opts)
    }
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
    // extract が定義されていればそれを最優先で試し、null 返却時のみ text 経路に fallback。
    const extracted = cls.def.extract ? cls.def.extract(payload) : null
    let inTok: number
    let outTok: number
    if (extracted) {
      inTok = extracted.input_tokens
      outTok = extracted.output_tokens
    } else {
      inTok = tokensOf(toText(getFromPayload(payload, cls.def.inputField)))
      outTok = tokensOf(toText(getFromPayload(payload, cls.def.outputField)))
    }
    appendLog(
      {
        kind: 'post.compress',
        ts,
        session: payload.session_id,
        tool: payload.tool_name,
        label: cls.def.label,
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
  // session 終了で rtk-gain snapshot を片付ける。次セッションでベースライン汚染を防ぐ。
  deleteRtkCum(rtkCumPath(opts.logsDir, payload.session_id))
}

/**
 * `rtk gain --format json` の累積カウンタと、前回 snapshot の差から当該 call の節約量を返す。
 * 初回 / counter リセット / rtk 取得失敗時は null。snapshot は今回値で更新する。
 */
function diffRtkGain(sessionId: string, opts: HandlerOpts): number | null {
  const getGain = opts.getRtkGain ?? readRtkGain
  const curr = getGain()
  if (!curr) return null
  const cumPath = rtkCumPath(opts.logsDir, sessionId)
  const prev = readRtkCum(cumPath)
  writeRtkCum(cumPath, curr)
  if (!prev) return null
  if (curr.total_saved < prev.total_saved) return null
  return curr.total_saved - prev.total_saved
}
