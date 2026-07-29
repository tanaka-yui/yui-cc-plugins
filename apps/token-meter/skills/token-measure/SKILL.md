---
name: token-measure
description: >
  Use when the user invokes `/token-measure` or asks to enable/disable the
  token-meter measurement system, list per-tool measurement state, or override
  a single tool. Provides ON/OFF control and JSONL-backed activity listing.
---

## Output Language

All user-facing questions, option labels, tables, and progress reports MUST be
rendered in Japanese. This file is written in English for consistency; it does
not change the language presented to the user.

# token-measure: Control the measurement mechanism

Edit `~/.claude/token-meter/state.json` to control the overall token-meter
measurement mechanism and per-tool ON/OFF. Aggregates observed activity from
JSONL logs and displays it with `/token-measure list`.

## Arguments

| Subcommand | Behavior |
|---|---|
| `on` | `state.enabled = true` |
| `off` | `state.enabled = false` |
| `on <tool>` | `state.tools[<tool>] = true` |
| `off <tool>` | `state.tools[<tool>] = false` |
| `reset` | Reset `state.tools` to `{}` |
| `reset <tool>` | Delete `state.tools[<tool>]` |
| `status` | Pretty-dump `state.json` |
| `list [--since 7d] [--sort calls\|tokens\|name] [--show-disabled] [--only-active]` | Per-tool observed activity + current ON/OFF determination |

## Procedure

1. Read `STATE=$HOME/.claude/token-meter/state.json`. If it doesn't exist, use `{"enabled":true,"tools":{},"plugins":{}}`.
2. Rewrite the JSON with a Bun one-liner depending on the subcommand:
   ```bash
   bun -e "import { readState, writeState } from '$HOME/.claude/token-meter/lib/config.ts'; const s = readState('$STATE'); s.enabled = true; writeState('$STATE', s)"
   ```
   (writeState guarantees an atomic write)
3. For `list`, aggregate today's JSONL by `kind` and print it as a table. `--since` accepts `today|1d|7d|30d|all`.
4. The output format follows spec §6.1's box drawing (`──`).

## Cautions

- When editing state.json directly, always go through `writeState` (tmpfile + rename). Do not overwrite the JSON by hand.
- Always show each tool's "basis" column in the `list` output (one of override / scope.include / scope.exclude).
- Do not rewire hooks from within this skill alone (that's `make hook-link`'s responsibility).
