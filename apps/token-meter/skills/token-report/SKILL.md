---
name: token-report
description: >
  Use when the user invokes `/token-report` or asks for an analytical summary
  of which compression plugin (rtk / headroom / caveman) is effective for which
  workload. Aggregates token-meter JSONL, `rtk gain`, and the active Claude Code
  session transcript, then produces recommendations.
---

## Output Language

All user-facing questions, option labels, tables, and progress reports MUST be
rendered in Japanese. This file is written in English for consistency; it does
not change the language presented to the user.

# token-report: Effectiveness analysis report

Aggregates token-meter logs + rtk gain + the transcript across sources to
produce a qualitative report on which plugin is effective for which kind of
processing.

## Arguments

| Argument | Behavior |
|---|---|
| `--since today\|1d\|7d\|30d\|all` | Aggregation period. Defaults to `7d` |

## Procedure

1. Call the aggregation engine:
   ```bash
   bun run "$CLAUDE_PROJECT_DIR/apps/token-meter/scripts/token-report.ts" --since 7d
   ```
   The output is a single JSON object. Its fields are as follows:
   - `tool_summary`: per-tool calls / input / output / ratio (sorted descending by output)
   - `rtk.jsonl`: rtk savings measured by token-meter
   - `rtk.gain`: the global summary from `rtk gain --format json` (an authoritative value that also includes rtk usage outside Claude)
   - `headroom`: post.compress aggregation (input_tokens - output_tokens = saved)
   - `caveman`: cannot be measured because it's prompt mode. Estimated as an "upper bound assuming full mode was always used" by multiplying the transcript's assistant output_tokens by 0.65
   - `top_wasteful_tool_calls`: top 5 by output_tokens share
2. Read the JSON above and write the report with the following structure:

```
# Token Effectiveness Analysis Report (since=<period>)

## Summary
- Observed tool count: ...
- Observed plugins: rtk (saved=X), headroom (saved=Y), caveman (estimated ≤Z)

## Per-plugin effectiveness and use cases
### rtk (Bash output compression)
- Measured: X tokens saved / Y calls
- Typical cases where it helped: ... ← be specific, drawing from rtk.gain and tool_summary
- Typical cases where it didn't help: ...
- Recommendation: "Use it for <this kind of Bash>"

### headroom (compression of large text)
- Measured: ...
- Typical cases where it helped: calls with input >5K and a small ratio
- Typical cases where it didn't help: cases returning router:noop (short text / protected patterns)
- Recommendation: ...

### caveman (response text shortening)
- Measured: not possible (prompt mode)
- Estimated upper bound: ~Z tokens (transcript aggregate × 0.65 / sonnet-4 benchmark)
- Use case: sessions with many long explanatory responses, free-form report work
- Caution: the estimate is an upper bound assuming "always-on full mode." See `/caveman:caveman-stats` for actual values

## Top wasteful tools
| tool | output_tokens | share |
| ... | ... | ... |
Comment: propose concrete reductions where rtk / headroom have room to help.

## Recommended actions
- 3-5 actionable bullet points backed by numbers, e.g. "apply rtk to X tool's
  output" or "turn caveman ON for Y-type responses."
```

3. A tool with a large ratio (output/input) indicates output-dominant calls (Read / Edit / Bash back-and-forth).
   Conversely, a small ratio, as with StructuredOutput / Workflow / ToolSearch,
   means input billing dominates, so compression plugins offer little benefit.

## Cautions

- `rtk.gain` also sums rtk usage outside Claude. The difference from `rtk.jsonl` can be explained as "outside the Claude session."
- caveman's estimate is an **upper bound**. Always make clear it is not an actual value.
- The session picked up by `transcript_path` may differ from the session currently running. If `current_mode` is null, caveman is not currently in use.
- Always state where each number came from (one of: jsonl aggregation / rtk gain / transcript estimate).
