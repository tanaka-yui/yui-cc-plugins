---
allowed-tools: Bash, TaskStop
description: "plan を対話 codex にカレントdir で実装させ、完了を agmsg 経由で待って通知する"
---

# /codex-exec

Has **interactive codex** (gpt-5.6-sol / xhigh) implement, in a new cmux pane, a plan
that claude/superpowers created. codex notifies via agmsg on completion, and that
message wakes the parent (this session) through its persistent agmsg Monitor stream.

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
if [ ! -d ~/.agents/skills/agmsg ]; then
  installer=$(ls ~/.claude/plugins/cache/fujibee-agmsg/agmsg/*/install.sh 2>/dev/null | head -1)
  [ -n "$installer" ] && bash "$installer" --cmd agmsg
fi
~/.agents/skills/agmsg/scripts/whoami.sh "$(pwd)" claude-code
```

- If `agent=<parent> teams=<team,...>` is returned, remember PARENT / TEAM. If there
  are multiple teams, confirm which one to use with the user.
- If `not_joined=true` / `suggest=true`, ask the user for the team name and parent
  agent name, then join:
  `~/.agents/skills/agmsg/scripts/join.sh <team> <parent> claude-code "$(pwd)"`
  **If `suggest=true`, the `teams=` / `agents=` in that output are registrations from
  other projects and must not be adopted as-is** — a wrong team routes codex's
  notification to a team this session's Monitor stream is not subscribed to.
- **If agmsg is still not installed, or the user declines to join**: run the bin
  **without** `--team` / `--parent`, then say in the same turn that no completion
  notification is wired up and the user must watch the codex pane themselves.
  **Do NOT arm the safety timer and do NOT close the turn as if waiting**: with no
  notification path there is nothing to wake into, and closing the turn behind a
  90-minute timer would only hide that. Skip Steps 3-5. Respond to the user in
  Japanese.

#### Step 1b: Preflight — confirm this session really has a live Monitor stream

`join.sh` only registers an identity. Monitor mode is turned on separately by
`delivery.sh set monitor <type> <project>`, which writes a **SessionStart** hook into
`<project>/.claude/settings.local.json`, and **a SessionStart hook written mid-session
never fires for the session already running**. So a parent that joined a moment ago
above has no Monitor stream at all. Check it; do not assume it:

```bash
sid="${CLAUDE_CODE_SESSION_ID:-}"
live=no
for p in ~/.agents/skills/agmsg/run/watch."$sid".*.pid; do
  [ -e "$p" ] || continue
  b="${p##*/}"; b="${b%.pid}"; pid="${b##*.}"
  if kill -0 "$pid" 2>/dev/null; then live=yes; break; fi
done
echo "monitor_live=$live"
```

This is the same judgement `verify-agmsg-ready.sh --self` makes in the dispatch plan.

If `monitor_live=no`: say so, name the cause (this project's delivery mode is not
`monitor`, or the SessionStart hook has not fired in this session yet), then take the
same branch as "the user declines to join" above — launch without the notification
arguments, report the launch only, and do NOT arm the timer. A timer with no Monitor
stream behind it can only wake into the same ignorance. Respond to the user in
Japanese.

#### Step 1c: Preflight — warn when another watcher shares the read cursor

The agmsg read cursor is one per (team, agent) and rows already read are excluded from
delivery, so **whichever stream polls first TAKES the row and the other sees nothing**
(`watch.sh:619-626`). The default SessionStart directive subscribes **unfiltered**, so
any other live session watching this same project can consume `<PARENT>`'s completion
line — for example this checkout running `/codex-exec` in one session and
`/codex-review` in another.

```bash
for f in ~/.agents/skills/agmsg/run/watch.*.filter; do
  [ -e "$f" ] || continue
  case "${f##*/}" in watch."$sid".*) continue ;; esac
  role="$(sed -n 1p "$f")"; proj="$(sed -n 2p "$f")"; owner="$(sed -n 3p "$f")"
  [ "$role" = unfiltered ] && [ "$proj" = "$(pwd)" ] && kill -0 "$owner" 2>/dev/null \
    && echo "competing_watcher=$f owner=$owner"
done
```

If any line is printed, tell the user that another session watching this project may
consume the completion line, and that Step 5's `history.sh` read is what recovers it.
Optionally assert exclusivity for this identity first:

```bash
~/.agents/skills/agmsg/scripts/actas-claim.sh "$(pwd)" claude-code <PARENT> "$CLAUDE_CODE_SESSION_ID"
```

It answers `status=held owner=<sid>` when another live session owns the pair. **Whether
the claim alone is enough to redirect delivery has not been measured**, so treat it as a
mitigation, never as a guarantee, and keep the Step 5 history read regardless.

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

### Step 4: End the turn and wait for the push

Do NOT run a watcher and do NOT poll. The parent session is woken by the agmsg
Monitor stream that its SessionStart hook started, so codex's completion `send.sh`
arrives as one line in this session even while it is idle.

Arm one single-shot safety timer so a lost completion cannot leave this session asleep
forever. **Using the Bash tool with `run_in_background: true`** — one `sleep`, never a
loop; it is the task's exit that wakes this session:

```bash
sleep $((90 * 60))
```

90 minutes is a safety net, not a deadline. **Remember the task id the Bash tool
returns and how many times you have armed the timer** (start the count at 1); Step 5
needs both.

Then end the turn.

### Step 5: Branch after waking

- **Woken by the Monitor event** — one line of the form
  `<ts> | <team> | <codex_agent> → <parent> | DONE <token>: ...`. Match the `<token>`
  from Step 2 to confirm it is this run. **First stop the safety timer** with `TaskStop`
  on the task id from Step 4: a surviving `sleep` exits 90 minutes later and injects a
  useless wake into whatever conversation the user has moved on to. Then ask the user
  whether to review the uncommitted changes with codex-review, noting that codex-exec
  has finished (including which plan). If the line also carries `agents=<N>`, report
  that number as how many child agents codex ran in parallel. If yes, launch
  `/codex-review --uncommitted`. Respond to the user in Japanese.
- **Woken by the timer task** — this does **not** mean the implementation is
  unfinished. The completion row may exist in the DB while the push never reached this
  session (no Monitor stream, a competing watcher took the row, the stream died,
  codex's `send.sh` hung, or codex ignored the injected instruction). **Before judging
  anything, read the persistent record exactly once:**

  ```bash
  ~/.agents/skills/agmsg/scripts/history.sh <TEAM> <PARENT> 30 | grep -F "<token>" | tail -1
  ```

  Use `history.sh` and **never `inbox.sh`**: a row a competing watcher consumed is
  already marked read, so `inbox.sh` would truthfully answer "nothing new" while the
  completion sits in the DB. Limit the scan to the last 30 lines and take the **last**
  match (`tail -1`) — the token is derived from the surface number, so a recycled pane
  number can make an old `DONE codex-exec-40` look like an answer to this request.

  - **A `DONE <token>` line exists** → treat it as the completion. `TaskStop` the timer
    and report exactly as the Monitor branch does (the notification was lost; the work
    was not).
  - **No such line** → check whether the pane is still alive with
    `cmux read-screen --surface <surface>`. **If it fails, retry once** before
    concluding anything: a transient cmux socket failure must not be read as a dead
    pane. If both attempts fail, tell the user the implementation pane `<surface>` is
    gone and completion could not be detected. Respond to the user in Japanese.
  - **Pane alive** → re-arm the same timer, increment the arm count, and end the turn
    again — **but only while the count is at most 3**. On the 4th wake with no
    completion line and no visible progress in `read-screen`, stop re-arming: report to
    the user with the `read-screen` excerpt and ask how to proceed. "The pane is alive"
    is not evidence of progress — an interactive codex pane never exits, so an unbounded
    re-arm is an infinite loop with no escalation. Respond to the user in Japanese.
