---
name: codex-review
description: >-
  agmsg の inbox を確認したうえで、新しい cmux ペインで codex (gpt-5.6-sol / reasoning effort
  xhigh = extra high) によるコードレビューを起動するスキル。ユーザーが「codex でレビュー」「codex review」
  「5.6 sol でレビュー」「extra high でレビュー」「agmsg 起動してレビュー」「別ペインでレビューを回して」等と
  言ったとき、または現在の変更を codex に第三者レビューさせたいときに必ず使う。cmux セッション内
  (CMUX_SOCKET_PATH が設定されている) が前提。単に diff を自分で読むのではなく、独立した codex プロセスに
  高リーズニングでレビューさせたい意図があればこのスキルを起動すること。対話型で起動し、
  完了を agmsg 経由で親へ通知できる。
allowed-tools: Bash, TaskStop
---

## Output Language

All user-facing questions, option labels, tables, and progress reports MUST be
rendered in Japanese. This file is written in English for consistency; it does
not change the language presented to the user.

# codex-review

A skill for having **codex perform a third-party review** of the current work. After
checking the agmsg inbox, it launches an **interactive codex** in a new cmux pane,
hands it a review prompt, and runs it at high reasoning effort. If the parent session
has already joined the agmsg team, it also wires up a completion notification to the
parent session.

Default settings:

- **Model**: `gpt-5.6-sol`
- **Reasoning effort**: `xhigh` (extra high)
- **Target**: uncommitted changes (`--uncommitted`). If unspecified, candidates are
  listed and confirmed with the user
- **Split direction**: `right`

## Why this design

Delegating the review to an independent codex process yields findings that aren't
dragged down by the assumptions of the person who implemented it (i.e., this session).
Effort is raised to `xhigh` because review benefits more from "catching what was
missed" than implementation does, and letting it think deeply is worth the cost even
if it's a bit slower. It launches interactively in a new pane so the user can follow
the findings visually and ask follow-up questions if needed.

The review runs in the foreground, in that one visible pane. This plugin never
asks codex to split the work across child agents: those run as separate threads
on the shared local app-server daemon, visible only through the separate
`codex agents` TUI, so from the pane you cannot tell whether four of them are
working or none are. A review you cannot watch defeats the point of launching it
interactively.

This limits what is *asked for*, not what codex *can* do. The collaboration
tools stay registered even with `features.multi_agent_v2 = false` — measured on
codex-cli 0.149.1, where `codex debug prompt-input` still carries the
`functions.collaboration.*` block and `list_agents` answers a real call, and
none of `multi_agent_v2.enabled=false`, `--disable multi_agent`,
`--disable collaboration_modes`, or `non_code_mode_only=true` removes it.

Unlike `/codex-exec`, a stalled review is not auto-detected: the work-signal
check keys off commits and file mtimes, and a review writes nothing, so a
working reviewer and a stopped one look identical to it. The timer branch in
Step 3 stays the only backstop here.

## Prerequisites

- Must be **inside a cmux session** (`CMUX_SOCKET_PATH` is required). Panes cannot be
  split outside cmux.
- The `codex` CLI must be installed and on PATH.
- agmsg is optional. Launching the review is not blocked even if not joined or not
  installed.

## Procedure

### 0. Determine the review target

If `--uncommitted` / `--base` / `--commit` / `--path` is specified, use it as-is.
If unspecified, list candidates (uncommitted changes / recent md files under
`docs/superpowers/{specs,plans}`) with `bin/cmux-codex-review --list-targets`, and if
there are 2 or more, let the user choose via AskUserQuestion. If there is 1, adopt it
automatically; if 0, ask the user for the target. The branching details are the same
as Step 0 of the `/codex-review` command (`commands/codex-review.md`).

### 1. Check the agmsg inbox (non-blocking)

If `~/.agents/skills/agmsg/` does not exist, bootstrap it by running the plugin's
install.sh once. Then resolve identity with `whoami.sh`, and if joined, check the
inbox with `inbox.sh`. If not joined or not installed, skip with a short note and
proceed to launching the review. The detailed branching is the same as Step 1 of the
`/codex-review` command (`commands/codex-review.md`).

### 2. Launch the codex review

Run the bin script. It splits a cmux pane and sends the review prompt to
**interactive codex** in that pane.

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/cmux-codex-review" [args]
```

Main arguments (all optional; see the bin's header comment for details):

| Argument | Meaning |
|------|------|
| `right` / `down` / `left` / `up` | Split direction (default: right) |
| `--base <branch>` | Review the diff against a base branch instead of uncommitted changes |
| `--commit <sha>` | Review the changes in the specified commit |
| `--path <file>` | Review the **full contents** of the specified file (repeatable; for spec/plan) |
| `--list-targets` | List candidates as TSV and exit (cmux not required; for Step 0) |
| `-m <model>` / `-e <effort>` | Override model / effort (default: gpt-5.6-sol / xhigh) |
| `-- <instructions>` | Custom review instructions for codex |
| `--team <team> --reviewer <name> --parent <agent>` | Wires up the agmsg completion notification |

The bin outputs `surface=` / `token=`. When notification wiring is enabled, the
token identifies which request a completion line belongs to; the parent is woken by
the agmsg Monitor stream, not by a watcher.

### 3. Report and wait

Convey the launch summary line the bin prints (surface / direction / model / effort /
target) in one line. Since the review starts flowing on the codex side, polling from
this session is unnecessary (when notification wiring is enabled, end the turn; the
completion arrives as an agmsg Monitor event, with one single-shot sleep task armed
as a safety net).

**Follow Step 3 of the `/codex-review` command (`commands/codex-review.md`) for the
waiting contract itself**, exactly as Sections 0 and 1 above delegate their branching.
It is the only place that carries the Monitor-liveness preflight, the competing-watcher
check, the timer duration, the `TaskStop` on completion, the `token` match, the
`history.sh` read that must happen before any judgement on a timer wake, and the bound
on re-arming. Do not improvise those from this file.

## codex command that gets launched (reference)

Launches by handing the review prompt to interactive codex (does not use the
`codex review` subcommand):

```bash
codex --sandbox workspace-write --ask-for-approval never \
  -c model="gpt-5.6-sol" -c model_reasoning_effort="xhigh" \
  "$REVIEW_INSTR"
```

`REVIEW_INSTR` is assembled in `bin/cmux-codex-review` from the review target's description
(`TARGET_DESC`) plus any custom `--` instructions; its actual text is Japanese.

The approval policy is set to `never` because, if left unspecified, codex stops at an
approval prompt every time it runs a command, turning the review into something that
waits on a human's accept (the sandbox stays workspace-write; only the approval is
disabled).

When `--team/--reviewer/--parent` is specified, "after presenting the review, notify
the parent session of completion via `send.sh`" is injected at the end of the prompt.
The parent session is woken by the agmsg Monitor event carrying that notification.

> **Do not set the sandbox to `read-only`**: the completion notification's `send.sh`
> INSERTs into agmsg's SQLite DB (i.e., writes). `config.toml`'s
> `[sandbox_workspace_write] writable_roots` (agmsg's db/teams/run) **only applies in
> workspace-write mode**, so under read-only the notification can no longer be fired.
