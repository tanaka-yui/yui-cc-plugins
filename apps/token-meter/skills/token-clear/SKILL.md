---
name: token-clear
description: >
  Use when the user invokes `/token-clear` or asks to delete old token-meter
  JSONL logs by retention period. Confirms before destructive deletion.
---

## Output Language

All user-facing questions, option labels, tables, and progress reports MUST be
rendered in Japanese. This file is written in English for consistency; it does
not change the language presented to the user.

# token-clear: Delete log history

Delete JSONL files under `~/.claude/token-meter/logs/` by retention period.

## Arguments

| Argument | Behavior |
|---|---|
| `--before <N>d` | Delete files older than N days (e.g. `--before 30d`) |
| `--all` | Delete every JSONL file |
| `--dry-run` | Only print the deletion candidates |

## Procedure

1. Parse the date (`YYYY-MM-DD.jsonl`) from each candidate filename and compare it against `--before`.
2. Unless `--dry-run` is set, print the candidate list and their total size, then ask the user to confirm before deleting.
3. Delete with `rm` after confirmation.

## Cautions

- Deletion is **irreversible**. Always confirm the candidates with `--dry-run` before the real run.
- Skip files that are currently being written (the JSONL for today's date) and emit a warning.
