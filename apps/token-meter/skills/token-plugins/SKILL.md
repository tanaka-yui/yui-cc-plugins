---
name: token-plugins
description: >
  Use when the user invokes `/token-plugins` or asks to list, install, enable,
  or disable a compression plugin (rtk / caveman / headroom). Wraps each
  plugin's enable/disable mechanism behind a unified interface.
---

## Output Language

All user-facing questions, option labels, tables, and progress reports MUST be
rendered in Japanese. This file is written in English for consistency; it does
not change the language presented to the user.

# token-plugins: Control compression plugins

Load `COMPRESSION_PLUGINS` from `apps/token-meter/lib/plugins.ts` and dispatch
to each plugin's `enable()` / `disable()` / `isEnabled()` / `isInstalled()`.

## Arguments

| Subcommand | Behavior |
|---|---|
| `list` | Plugin list + installed / enabled / effect over the last 7 days |
| `on <name>` | `COMPRESSION_PLUGINS.find(p => p.name === <name>).enable()` |
| `off <name>` | Same as above with `disable()` |
| `install <name>` | Calls `make install-<name>` |
| `status <name>` | Details for a single plugin (install location / config path / observed activity) |

## Procedure

1. Get the plugin list with `bun -e "import { COMPRESSION_PLUGINS } from '$HOME/.claude/token-meter/lib/plugins.ts'; ..."`.
2. For `list`, aggregate `kind === 'post.rtk'` and `kind === 'post.compress'` from JSONL and compute saved_tokens.
3. `on` / `off` are async, so call `await p.enable()`.
4. `install` runs `cd $HOME/.claude/token-meter && make install-<name>`.

## Output Format

spec §6.2's table format (installed/enabled shown as ✓/✗).

## Cautions

- For some plugins, `enable()` rewrites `.claude.json`, requiring a Claude Code restart (headroom). Show this after running `on`/`off`.
- caveman's session flag path may change in the future (spec §15).
