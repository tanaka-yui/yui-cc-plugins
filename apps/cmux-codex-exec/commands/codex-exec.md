---
allowed-tools: Bash
description: "plan を対話 codex にカレントdir で実装させ、完了を agmsg 経由で待って通知する"
---

# /codex-exec

Has **interactive codex** (gpt-5.6-sol / xhigh) implement, in a new cmux pane, a plan
that claude/superpowers created. codex notifies via agmsg on completion, and the
parent (this session) is woken by the short-lived watcher's exit.

## Procedure

### Step 0: Determine the plan to implement

If `$ARGUMENTS` contains a plan path (a positional argument ending in `.md`), use it.
**Without asking anything**, proceed to Step 1.

If not, list candidates:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/cmux-codex-exec" --list-targets
```

The output is one-candidate-per-line TSV (`target<TAB>plan<TAB><path><TAB><label>`).
Branch on the number of lines:

- **0 lines**: tell the user no plan was found, and ask them for the plan path.
  Respond to the user in Japanese.
- **1 or more lines**: **even with only 1 candidate, always** confirm via
  AskUserQuestion. Offer the top 3 candidates as options (attach the label's
  `committed` / `untracked` and the update time to the description). If none match,
  the user can specify a path via Other.

Unlike review, exec never skips confirmation even for a single candidate, because
grabbing the wrong plan rewrites the repository.

Pass the determined plan path **explicitly** to the Step 2 bin execution (don't rely
on the bin's own most-recent-mtime fallback).

### Step 1: Resolve agmsg identity

```bash
~/.agents/skills/agmsg/scripts/whoami.sh "$(pwd)" claude-code
```

- If `agent=<parent> teams=<team,...>` is returned, remember PARENT / TEAM. If there
  are multiple teams, confirm which one to use with the user.
- If `not_joined=true` / `suggest=true`, ask the user for the team name and parent
  agent name, then join:
  `~/.agents/skills/agmsg/scripts/join.sh <team> <parent> claude-code "$(pwd)"`

### Step 2: Run the bin to launch the codex pane

Append `--team <TEAM> --parent <PARENT>` to the plan path determined in Step 0 and
`$ARGUMENTS` (e.g. `-d down`), then run:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/cmux-codex-exec" <PLAN> $ARGUMENTS --team <TEAM> --parent <PARENT>
```

If Step 0 was skipped (i.e. `$ARGUMENTS` already contains the plan path), omit
`<PLAN>` and pass only `$ARGUMENTS`.

Remember the output's `token=` / `codex_agent=` / `surface=` / `plan=`.

### Step 3: Pre-join the sending codex agent to the team

So codex can fire the completion notification (send.sh), register `codex_agent` with
the team (agmsg 1.1.8 rejects an unregistered `from`):

```bash
~/.agents/skills/agmsg/scripts/join.sh <TEAM> <codex_agent> codex "$(pwd)"
```

### Step 4: Launch the short-lived watcher as a background task and wait

**Using the Bash tool with `run_in_background: true`**, launch the following (token
is the value from Step 2's output):

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/cmux-codex-wait" <TEAM> <PARENT> <token> --surface <surface>
```

Don't attach `--timeout` (the default is unlimited). Cutting off a long implementation
by wall clock abandons a codex that's still alive, collapsing the wait so that a
later-arriving completion notification never wakes it again. Instead, pass `--surface`
so termination is judged by pane liveness.

Once launched, end this turn. The watcher's completion notification
(`<task-notification>`) wakes the parent.

### Step 5: Branch after waking

Check the watcher task's output:

- `status=done`: ask the user whether to review the uncommitted changes with
  codex-review, noting that codex-exec has finished (including which plan). If the
  output also carries `agents=<N>`, report that number as how many child agents
  codex ran in parallel. If yes, launch `/codex-review --uncommitted`
  (cmux-codex-review) with the target stated explicitly (since the user has
  already answered the target, don't make Step 0 ask for candidates again).
  Respond to the user in Japanese.
- `status=gone`: tell the user the implementation pane `<surface>` was closed and
  codex's completion could not be detected. Respond to the user in Japanese.
