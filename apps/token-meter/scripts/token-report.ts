// /token-meter:token-report の集計エンジン。
// rtk (jsonl + rtk gain) / headroom (jsonl) / caveman (transcript + benchmark coefficient) を
// 単一の JSON にまとめて stdout に吐く。後段の skill instructions で LLM が分析・整形する。
//
// 出力フォーマット (JSON):
//   {
//     since: '7d',
//     window_start_iso: '...',
//     tool_summary: [{tool, calls, input_tokens, output_tokens, ratio}, ...],
//     rtk: { jsonl: {calls, output_tokens, saved}, gain: {total_saved, total_commands, by_command: [...]} | null },
//     headroom: { calls, input_tokens, output_tokens, saved },
//     caveman: { measurable: false, estimate: {output_tokens, savings_at_full, current_mode, history_seen}, source: '...' },
//     top_wasteful_tool_calls: [{tool, output_tokens, share_pct}, ...],
//   }
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { JsonValue } from '../lib/schemas'
import type { LogRecord } from '../lib/types'

type Args = { since: 'today' | '1d' | '7d' | '30d' | 'all'; logsDir: string; transcriptRoot: string }

function parseArgs(argv: string[]): Args {
  const get = (k: string, def: string): string => {
    const i = argv.indexOf(k)
    return i >= 0 && argv[i + 1] ? (argv[i + 1] as string) : def
  }
  const since = get('--since', '7d') as Args['since']
  return {
    since,
    logsDir: get('--logs-dir', join(homedir(), '.claude', 'token-meter', 'logs')),
    transcriptRoot: get('--transcript-root', join(homedir(), '.claude', 'projects')),
  }
}

function cutoffMs(since: Args['since']): number {
  const day = 86400_000
  const now = Date.now()
  switch (since) {
    case 'today':
    case '1d':
      return now - day
    case '7d':
      return now - 7 * day
    case '30d':
      return now - 30 * day
    case 'all':
      return 0
  }
}

type ToolAgg = { calls: number; input_tokens: number; output_tokens: number }
type Aggregated = {
  tools: Map<string, ToolAgg>
  rtk_calls: number
  rtk_output: number
  rtk_saved: number
  headroom_calls: number
  headroom_input: number
  headroom_output: number
}

function readJsonlAggregate(logsDir: string, cutoff: number): Aggregated {
  const acc: Aggregated = {
    tools: new Map(),
    rtk_calls: 0,
    rtk_output: 0,
    rtk_saved: 0,
    headroom_calls: 0,
    headroom_input: 0,
    headroom_output: 0,
  }
  let files: string[] = []
  try {
    files = readdirSync(logsDir).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return acc
  }
  for (const f of files) {
    let content: string
    try {
      content = readFileSync(join(logsDir, f), 'utf8')
    } catch {
      continue
    }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      let r: LogRecord
      try {
        r = JSON.parse(line) as LogRecord
      } catch {
        continue
      }
      const ts = Date.parse(r.ts)
      if (!Number.isFinite(ts) || ts < cutoff) continue
      const bump = (tool: string, ins: number, outs: number) => {
        const t = acc.tools.get(tool) ?? { calls: 0, input_tokens: 0, output_tokens: 0 }
        t.calls++
        t.input_tokens += ins
        t.output_tokens += outs
        acc.tools.set(tool, t)
      }
      if (r.kind === 'post.normal') bump(r.tool, r.input_tokens, r.output_tokens)
      else if (r.kind === 'post.rtk') {
        bump(r.tool, 0, r.output_tokens)
        acc.rtk_calls++
        acc.rtk_output += r.output_tokens
        acc.rtk_saved += r.rtk_saved_tokens ?? 0
      } else if (r.kind === 'post.compress' && r.label === 'headroom') {
        bump(r.tool, r.input_tokens, r.output_tokens)
        acc.headroom_calls++
        acc.headroom_input += r.input_tokens
        acc.headroom_output += r.output_tokens
      }
    }
  }
  return acc
}

type RtkGain = {
  total_saved: number
  total_commands: number
  by_command: Array<{ command: string; saved: number; count: number }>
}

function readRtkGain(): RtkGain | null {
  let stdout: string
  try {
    const res = spawnSync('rtk', ['gain', '--format', 'json'], { encoding: 'utf8', timeout: 3000 })
    if (res.status !== 0 || typeof res.stdout !== 'string') return null
    stdout = res.stdout
  } catch {
    return null
  }
  let parsed: JsonValue
  try {
    parsed = JSON.parse(stdout) as JsonValue
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const summary = parsed.summary
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return null
  const totalSaved = summary.total_saved
  const totalCmds = summary.total_commands
  if (typeof totalSaved !== 'number' || typeof totalCmds !== 'number') return null
  // by_command は rtk gain --format json では含まれない (text only)。
  // 必要なら --verbose 等で再取得を試みるが、まず summary だけで十分。
  return { total_saved: totalSaved, total_commands: totalCmds, by_command: [] }
}

type CavemanEstimate = {
  measurable: false
  source: string
  current_mode: string | null
  estimate: {
    transcript_path: string | null
    assistant_output_tokens: number
    assumed_coverage_pct: number
    coefficient_full: number
    estimated_savings_at_full: number
  }
}

function findLatestTranscript(root: string): string | null {
  if (!existsSync(root)) return null
  let best: { path: string; mtime: number } | null = null
  const stack = [root]
  while (stack.length > 0) {
    const cur = stack.pop()
    if (!cur) break
    let entries: string[]
    try {
      entries = readdirSync(cur)
    } catch {
      continue
    }
    for (const e of entries) {
      const p = join(cur, e)
      let st: ReturnType<typeof statSync>
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) stack.push(p)
      else if (p.endsWith('.jsonl')) {
        if (!best || st.mtimeMs > best.mtime) best = { path: p, mtime: st.mtimeMs }
      }
    }
  }
  return best?.path ?? null
}

function readCavemanMode(): string | null {
  // caveman の flag ファイル探索。caveman-config の getConfigDir と整合。
  const candidates = [
    process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, 'caveman', '.caveman-flag') : null,
    join(homedir(), '.config', 'caveman', '.caveman-flag'),
  ].filter((p): p is string => p !== null)
  for (const p of candidates) {
    try {
      const raw = readFileSync(p, 'utf8').trim().toLowerCase()
      if (raw) return raw
    } catch {
      // 次の候補
    }
  }
  return null
}

function estimateCaveman(transcriptRoot: string): CavemanEstimate {
  const path = findLatestTranscript(transcriptRoot)
  const COEF_FULL = 0.65
  if (!path) {
    return {
      measurable: false,
      source: 'caveman-stats benchmark (COMPRESSION.full=0.65, sonnet-4)',
      current_mode: readCavemanMode(),
      estimate: {
        transcript_path: null,
        assistant_output_tokens: 0,
        assumed_coverage_pct: 0,
        coefficient_full: COEF_FULL,
        estimated_savings_at_full: 0,
      },
    }
  }
  let assistantOut = 0
  try {
    const raw = readFileSync(path, 'utf8')
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      let entry: JsonValue
      try {
        entry = JSON.parse(line) as JsonValue
      } catch {
        continue
      }
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
      if (entry.type !== 'assistant') continue
      const msg = entry.message
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) continue
      const usage = msg.usage
      if (!usage || typeof usage !== 'object' || Array.isArray(usage)) continue
      const out = usage.output_tokens
      if (typeof out === 'number') assistantOut += out
    }
  } catch {
    // 読めなければ 0
  }
  const mode = readCavemanMode()
  // mode が確定していれば 100% 仮定、そうでなければ「もし常時 caveman full だったら」の上限値。
  const coverage = mode === 'full' ? 100 : 0
  const savingsAtFull = Math.round(assistantOut * COEF_FULL)
  return {
    measurable: false,
    source: 'caveman-stats benchmark (COMPRESSION.full=0.65, sonnet-4)',
    current_mode: mode,
    estimate: {
      transcript_path: path,
      assistant_output_tokens: assistantOut,
      assumed_coverage_pct: coverage,
      coefficient_full: COEF_FULL,
      estimated_savings_at_full: savingsAtFull,
    },
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const cutoff = cutoffMs(args.since)
  const agg = readJsonlAggregate(args.logsDir, cutoff)
  const rtkGain = readRtkGain()
  const caveman = estimateCaveman(args.transcriptRoot)

  const toolSummary = [...agg.tools.entries()]
    .map(([tool, t]) => ({
      tool,
      calls: t.calls,
      input_tokens: t.input_tokens,
      output_tokens: t.output_tokens,
      ratio: t.input_tokens === 0 ? null : t.output_tokens / t.input_tokens,
    }))
    .sort((a, b) => b.output_tokens - a.output_tokens)

  const totalOutput = toolSummary.reduce((s, r) => s + r.output_tokens, 0)
  const topWasteful = toolSummary.slice(0, 5).map((r) => ({
    tool: r.tool,
    output_tokens: r.output_tokens,
    share_pct: totalOutput === 0 ? 0 : Math.round((r.output_tokens / totalOutput) * 1000) / 10,
  }))

  const report = {
    since: args.since,
    window_start_iso: cutoff === 0 ? null : new Date(cutoff).toISOString(),
    tool_summary: toolSummary,
    rtk: {
      jsonl: { calls: agg.rtk_calls, output_tokens: agg.rtk_output, saved: agg.rtk_saved },
      gain: rtkGain,
    },
    headroom: {
      calls: agg.headroom_calls,
      input_tokens: agg.headroom_input,
      output_tokens: agg.headroom_output,
      saved: Math.max(0, agg.headroom_input - agg.headroom_output),
    },
    caveman,
    top_wasteful_tool_calls: topWasteful,
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

main()
