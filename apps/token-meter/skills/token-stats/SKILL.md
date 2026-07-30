---
name: token-stats
description: >
  Use when the user invokes `/token-stats` or asks for a token volume /
  compression-effect report across recent days. Aggregates JSONL records by
  tool and plugin into a single page summary.
---

## Output Language

All user-facing questions, option labels, tables, and progress reports MUST be
rendered in Japanese. This file is written in English for consistency; it does
not change the language presented to the user.

# token-stats: Total report

Aggregates JSONL logs by period and displays token volume and compression
effect by tool / by plugin.

## Arguments

| Argument | Behavior |
|---|---|
| `--since today\|1d\|7d\|30d\|all` | Aggregation period. Defaults to `7d` |
| `--by tool\|plugin` | Grouping (defaults to both) |
| `--top N` | Only the top N entries (defaults to 20) |

## Procedure

1. Filter `~/.claude/token-meter/logs/*.jsonl` by `--since`.
2. Aggregate `kind === 'post.normal' | 'post.rtk' | 'post.compress'` per tool.
3. Aggregate `post.rtk`'s `rtk_saved_tokens` and `post.compress`'s `(input_tokens - output_tokens)` per plugin.
4. Perform an `aggregate()`-style aggregation consistent with spec §3.2's pipeline and §5's schema.
5. Output as a box-drawing table (unified with token-measure list).

## Cautions

- `--since all` reads every JSONL file, which can be slow when there are many files. Warn if there are more than 100 files.
- ratio is `output_tokens / input_tokens` (smaller means a higher compression rate).
