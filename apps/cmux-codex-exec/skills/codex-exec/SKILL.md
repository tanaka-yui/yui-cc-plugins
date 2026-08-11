---
name: codex-exec
description: >-
  claude/superpowers が作成した plan を、新しい cmux ペインで対話 codex (gpt-5.6-sol / reasoning
  effort xhigh) にカレントディレクトリで実装させ、完了を親セッションが agmsg 経由で検知してレビューへ繋ぐ
  スキル。ユーザーが「この plan を codex に実装させて」「codex で plan を実行」「plan を回して終わったら教えて」
  「codex-exec」等と言ったとき、または書き上げた plan を独立した codex プロセスに実装させたいときに必ず使う。
  cmux セッション内 (CMUX_SOCKET_PATH) が前提。実装後は cmux-codex-review でのレビューへ繋ぐ。
allowed-tools: Bash
---

## Output Language

All user-facing questions, option labels, tables, and progress reports MUST be
rendered in Japanese. This file is written in English for consistency; it does
not change the language presented to the user.

# codex-exec

A skill that has an independent interactive codex implement a plan, waits for
completion via agmsg, and wakes the parent session.

Default: model `gpt-5.6-sol` / effort `xhigh` / the current directory / split direction right / the
plan is taken from the argument first, and if unspecified, candidates from
`docs/superpowers/plans/` are confirmed with the user (the bin's standalone fallback
remains the most recently modified file by mtime, as before).

## Why this design

Delegating the implementation to an independent codex lets the plan take shape from a
perspective different from the person who designed it (this session). While using
agmsg for completion detection, a "short-lived watcher that exits on token detection"
is chained in as a background task to reliably wake the idle parent session (verified
empirically that agmsg monitor push cannot wake an idle parent session).

Parallelism is not left to codex's discretion. The launched prompt carries a
mandatory directive: whenever two or more pieces of work are independent, codex
MUST fan them out with `spawn_agent` and collect them with `wait_agent`. Only
read-only investigation and post-implementation verification are parallelized —
file edits stay sequential in the parent agent, because this plugin runs in the
current directory without worktree isolation and concurrent writers would
clobber each other.

## Prerequisites

- Inside a cmux session (`CMUX_SOCKET_PATH`).
- `codex` CLI is on PATH.
- The parent session has already joined the agmsg team (if not joined, the command
  guides through join).

## Parallel execution

The prompt is built with a directive that caps concurrent child agents (default
4) and asks codex to close with a summary table of what it spawned. Available
`agent_type` values are discovered from `.codex/agents/*.toml` in the current
directory and listed with their descriptions; if none exist, codex is told to
omit `agent_type`.

| Argument | Meaning |
|------|------|
| `--no-parallel` | Do not inject the directive (identical to the previous behavior) |
| `--agents <N>` | Concurrency cap. Integers 2-8 only; anything else exits non-zero before splitting a pane (default: 4) |

When notification wiring is on, codex appends `agents=<N>` to the completion
message, and `bin/cmux-codex-wait` echoes it back as
`status=done token=<token> agents=<N>`.

## Procedure

Follow Step 0-5 of the `/codex-exec` command (`commands/codex-exec.md`). Key points:

1. **Determine the plan**: if `$ARGUMENTS` has no plan path, list candidates with
   `bin/cmux-codex-exec --list-targets` and confirm with the user via AskUserQuestion
   **even when there is only 1 candidate** (running the wrong plan rewrites the
   repository). If there are 0 candidates, ask for the path. See Step 0 of
   `commands/codex-exec.md` for details.
2. Resolve the parent session identity (TEAM/PARENT) with `whoami.sh` (join if not
   joined).
3. Launch the pane with `bin/cmux-codex-exec <PLAN> $ARGUMENTS --team <TEAM> --parent <PARENT>`
   and obtain `token`/`codex_agent`.
4. Pre-join the sender with `join.sh <TEAM> <codex_agent> codex`.
5. Launch `bin/cmux-codex-wait <TEAM> <PARENT> <token> --surface <surface>` as a
   **background task** and wait for it (do not attach `--timeout`; the default is
   unlimited, and termination is judged by pane liveness).
6. After waking, if `status=done`, confirm whether review is appropriate and hand off
   to `cmux-codex-review`; if `status=gone`, prompt the user to check the pane.
