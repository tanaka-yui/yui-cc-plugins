---
name: codex-exec
description: >-
  claude/superpowers が作成した plan を、新しい cmux ペインで対話 codex (gpt-5.6-sol / reasoning
  effort xhigh) にカレントディレクトリで実装させ、完了を親セッションが agmsg 経由で検知してレビューへ繋ぐ
  スキル。ユーザーが「この plan を codex に実装させて」「codex で plan を実行」「plan を回して終わったら教えて」
  「codex-exec」等と言ったとき、または書き上げた plan を独立した codex プロセスに実装させたいときに必ず使う。
  cmux セッション内 (CMUX_SOCKET_PATH) が前提。実装後は cmux-codex-review でのレビューへ繋ぐ。
allowed-tools: Bash, TaskStop
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
perspective different from the person who designed it (this session). Completion
detection is the agmsg Monitor stream itself: the parent keeps a persistent watcher
started by its SessionStart hook, and a message delivered through it wakes the parent
even while idle (verified 2026-08-21; the earlier finding to the contrary predates
this harness exposing the Monitor tool).

This plugin never asks codex to run work in parallel. Everything it is told to
do happens in the visible pane, in the foreground.

## Prerequisites

- Inside a cmux session (`CMUX_SOCKET_PATH`).
- `codex` CLI is on PATH.
- The parent session has already joined the agmsg team (if not joined, the command
  guides through join).

## Foreground-only execution

Codex sub-agents do not run in the pane. They run as separate threads on the
shared local app-server daemon, visible only through the separate `codex agents`
TUI. From the pane you cannot tell whether four of them are working or none are,
which is why this plugin stopped asking for them.

This is a limit on what is *asked for*, not a guarantee about what codex *can*
do. The collaboration tools stay registered even with
`features.multi_agent_v2 = false` — measured on codex-cli 0.149.1, where
`codex debug prompt-input` still carries the `functions.collaboration.*` block
and `list_agents` answers a real call. None of `multi_agent_v2.enabled=false`,
`--disable multi_agent`, `--disable collaboration_modes`, or
`non_code_mode_only=true` removes it. So codex may still spawn on its own
initiative; detecting a session that went quiet is `bin/work-signal`'s job, not
this one's.

`--no-parallel` and `--agents` were removed. Passing either exits non-zero
before a pane is split, rather than being silently absorbed as a plan path.

## Stall detection and auto-resume

An interactive codex pane never exits, so its liveness proves nothing. On a timer
wake, `bin/work-signal` answers the question the pane cannot: it hashes the HEAD
commit, the set of dirty paths, their mtimes, and the pane's screen, and compares
that against the previous wake. Progress means codex is working and merely quiet;
no progress across a wake means it stopped.

A stopped session that is still reachable gets exactly one `dispatch-nudge:`
message and then keeps waiting. This adds no polling loop: the single-shot timer
that already existed is the only thing that schedules the check.

`bin/cmux-codex-exec` therefore has the launched codex record a bridge seat with
`codex-record-session.sh` before it starts work. `join.sh` alone registers the
sender only, and a nudge to a seatless pane is written to the DB and never read
(`docs/notification-gaps.md` R2). Step 5 of `commands/codex-exec.md` checks the
seat before nudging so that "stalled" and "stalled and unreachable" stay
distinguishable.

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
5. End the turn. The completion arrives as an agmsg Monitor event; arm one
   single-shot `sleep` background task as a safety net and remember its task id (see
   Step 4 of `commands/codex-exec.md`).
6. After waking, follow **Step 5 of `commands/codex-exec.md`** as written. It is the
   only place that carries the `token` match, the `TaskStop` that stops the timer on
   completion, the `history.sh` read that must happen before any judgement on a timer
   wake, the single retry before declaring a pane gone, and the bound on re-arming. Do
   not improvise those from this file.
