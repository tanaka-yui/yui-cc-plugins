---
allowed-tools: Bash, TaskStop
description: "agmsg inbox を確認し、新ペインで対話 codex (gpt-5.6-sol/xhigh) にコードレビューさせる"
---

# /codex-review

Checks the agmsg inbox, then has **interactive codex** perform a code review in a new
cmux pane. Model **gpt-5.6-sol**, effort **xhigh**, target defaults to **uncommitted
changes**. If no arguments are given, Step 0 presents candidates and confirms with the
user. If the parent has already joined an agmsg team, this also wires up a completion
notification back to the parent.

## Procedure

### Step 0: Determine the review target

If the part of `$ARGUMENTS` before `--` contains any of `--uncommitted` / `--base` /
`--commit` / `--path`, the target is already explicit. **Exclude the custom review
instruction text after `--` from this check** (e.g. free text like
`-- review the --path usage from a security angle` does not count as a target
specification). **Without asking anything**, proceed to Step 1.

If not, list candidates:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/cmux-codex-review" --list-targets
```

The output is one-candidate-per-line TSV (`target<TAB>kind<TAB>value<TAB>label`).
Branch on the number of lines:

- **0 lines**: tell the user no review target could be detected, and ask them for a
  path or branch. Convert the answer to `--path <file>` / `--base <branch>` and go to
  Step 1. Respond to the user in Japanese.
- **1 line**: adopt it as-is (no confirmation needed). Convert `kind=uncommitted` to
  `--uncommitted`, and `kind=path` to `--path <value>`. Include the adopted target in
  the Step 4 report.
- **2 or more lines**: let the user pick one via AskUserQuestion. Offer up to 4 slots
  in this priority order:

| Slot | Content | Converted bin argument |
|----|------|------------------|
| 1 | Uncommitted changes (if a `kind=uncommitted` line exists) | `--uncommitted` |
| 2 | Latest spec (first line whose label starts with `spec /`) | `--path <spec>` |
| 3 | Latest plan (first line whose label starts with `plan /`) | `--path <plan>` |
| 4 | Spec + plan together (only when both slots 2 and 3 exist) | `--path <spec> --path <plan>` |

`--list-targets` returns up to 3 spec / plan candidates each, but only the first of
each is placed in a slot. List the remaining candidates in the question text so the
user can specify them via Other.

Don't use multiSelect. The bin's target specification is a single kind, so mixing
"uncommitted + path" isn't representable. Reviewing multiple files is expressed via
slot 4 (repeating `--path`).

Pass the determined arguments as-is to the Step 2 bin execution.

### Step 1: Resolve agmsg identity and check the inbox (non-blocking)

```bash
if [ ! -d ~/.agents/skills/agmsg ]; then
  installer=$(ls ~/.claude/plugins/cache/fujibee-agmsg/agmsg/*/install.sh 2>/dev/null | head -1)
  [ -n "$installer" ] && bash "$installer" --cmd agmsg
fi
~/.agents/skills/agmsg/scripts/whoami.sh "$(pwd)" claude-code
```

- If `agent=<parent> teams=<team,...>` is returned, remember PARENT / TEAM and check
  each team's inbox: `~/.agents/skills/agmsg/scripts/inbox.sh <team> <parent>`
- **If `suggest=true` is returned, this project has not joined.** The `teams=` /
  `agents=` in this output are **registrations from other projects** and **must not
  be used as-is** (misrouting to the wrong team desyncs codex's notification
  destination from the team this session's Monitor stream is subscribed to, so the
  notification never arrives).
  Confirm with the user:
  - **Join**: ask for a team from `available_teams=` (or a new team name) and a parent
    agent name, then join:
    `~/.agents/skills/agmsg/scripts/join.sh <team> <parent> claude-code "$(pwd)"`
    Once joined, proceed to the Step 2 notification wiring with that TEAM / PARENT.
  - **Don't join**: proceed to Step 2 without notification, noting that the
    completion notification is skipped because agmsg wasn't joined. Respond to the
    user in Japanese.
- If `not_joined=true` or agmsg isn't installed, proceed to Step 2 (without blocking
  the review launch), noting that the notification is skipped because agmsg wasn't
  joined. Respond to the user in Japanese.

#### Step 1b: Preflight — confirm this session really has a live Monitor stream

`join.sh` only registers an identity. Monitor mode is turned on separately by
`delivery.sh set monitor <type> <project>`, which writes a **SessionStart** hook into
`<project>/.claude/settings.local.json`, and **a SessionStart hook written mid-session
never fires for the session already running**. So a parent that joined a moment ago in
Step 1 has no Monitor stream at all. Check it; do not assume it:

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
`monitor`, or the SessionStart hook has not fired in this session yet), then **take the
"Not joined" branch of Step 2 (launch without the notification arguments), report the
launch only, and do NOT arm the timer**. A timer with no Monitor stream behind it can
only wake into the same ignorance, so arming one silently would promise a notification
that cannot arrive. Respond to the user in Japanese.

#### Step 1c: Preflight — warn when another watcher shares the read cursor

The agmsg read cursor is one per (team, agent) and rows already read are excluded from
delivery, so **whichever stream polls first TAKES the row and the other sees nothing**
(`watch.sh:619-626`). The default SessionStart directive subscribes **unfiltered**, so
any other live session watching this same project can consume `<PARENT>`'s completion
line — for example this checkout running `/codex-review` in one session and
`/codex-exec` in another.

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
consume the completion line, and that Step 3b's `history.sh` read is what recovers it.
Optionally assert exclusivity for this identity first:

```bash
~/.agents/skills/agmsg/scripts/actas-claim.sh "$(pwd)" claude-code <PARENT> "$CLAUDE_CODE_SESSION_ID"
```

It answers `status=held owner=<sid>` when another live session owns the pair. **Whether
the claim alone is enough to redirect delivery has not been measured**, so treat it as a
mitigation, never as a guarantee, and keep the Step 3b history read regardless.

### Step 2: Decide whether to wire up the notification

`<TARGET_ARGS>` is the target argument determined in Step 0 (`--uncommitted` /
`--base <branch>` / `--commit <sha>` / `--path <file>...`; empty if Step 0 was skipped
because the user had already specified the target explicitly).
**Always place `$ARGUMENTS` last: everything after `--` is absorbed as custom review
instructions, and subsequent flags stop being parsed.**

- Parent has already joined a team **and Step 1b returned `monitor_live=yes`**:
  pre-join the reviewer agent (register the sender), and pass the notification
  arguments to the bin.
  ```bash
  # The reviewer name is not yet fixed to a surface, so join it after launch. Launch first:
  "${CLAUDE_PLUGIN_ROOT}/bin/cmux-codex-review" <TARGET_ARGS> --team <TEAM> --reviewer <REVIEWER> --parent <PARENT> $ARGUMENTS
  ```
  `<REVIEWER>` is a unique name such as `cxrev-review`. Remember the bin output's
  `token=`/`surface=`. Join the reviewer immediately after launch:
  `~/.agents/skills/agmsg/scripts/join.sh <TEAM> <REVIEWER> codex "$(pwd)"`
- Not joined, or `monitor_live=no`: launch without notification (backward
  compatible):
  ```bash
  "${CLAUDE_PLUGIN_ROOT}/bin/cmux-codex-review" <TARGET_ARGS> $ARGUMENTS
  ```

> The reviewer name can be a fixed name decided before launching the bin (e.g.
> `cxrev-review`). Separately from the surface-derived token, send.sh works fine even
> when the reviewer agent name is pre-joined under a human-readable fixed name.

### Step 3: Only when notification is wired up, end the turn and wait for the push

Do NOT run a watcher and do NOT poll. The parent session is woken by the agmsg
Monitor stream that its SessionStart hook started, so codex's completion `send.sh`
arrives as one line in this session even while it is idle.

#### Step 3a: Arm one single-shot safety timer

Arm it so a lost completion cannot leave this session asleep forever. **Using the Bash
tool with `run_in_background: true`** — one `sleep`, never a loop; it is the task's exit
that wakes this session:

```bash
sleep $((60 * 60))
```

60 minutes is a safety net, not a deadline. **Remember the task id the Bash tool
returns and how many times you have armed the timer** (start the count at 1); Step 3b
needs both.

Then end the turn.

#### Step 3b: Branch after waking

- **Woken by the Monitor event** — one line of the form
  `<ts> | <team> | <reviewer> → <parent> | DONE <token>: ...`. Match the `<token>` from
  Step 2 to confirm it is this review (several reviews may be in flight). **First stop
  the safety timer** with `TaskStop` on the task id from Step 3a: a surviving `sleep`
  exits an hour later and injects a useless wake into whatever conversation the user has
  moved on to. Then tell the user the review is complete. Respond to the user in
  Japanese.
- **Woken by the timer task** — this does **not** mean the review is unfinished. The
  completion row may exist in the DB while the push never reached this session (no
  Monitor stream, a competing watcher took the row, the stream died, codex's `send.sh`
  hung, or codex ignored the injected instruction). **Before judging anything, read the
  persistent record exactly once:**

  ```bash
  ~/.agents/skills/agmsg/scripts/history.sh <TEAM> <PARENT> 30 | grep -F "DONE <token>:" | tail -1
  ```

  Use `history.sh` and **never `inbox.sh`**: a row a competing watcher consumed is
  already marked read, so `inbox.sh` would truthfully answer "nothing new" while the
  completion sits in the DB.

  Match `DONE <token>:` **with the colon**, never the bare token. The token is derived
  from the surface number, so `codex-review-4` is a prefix of `codex-review-40`: a bare
  `grep -F` for the shorter token matches the longer one's completion and reports a
  review that is still running as finished. The colon is what makes the match exact,
  because the notification body is always `DONE <token>: <text>`. Limit the scan to the
  last 30 lines and take the **last** match (`tail -1`) so a recycled pane number cannot
  make an old completion answer this request.

  - **A `DONE <token>` line exists** → treat it as the completion. `TaskStop` the timer
    and report exactly as the Monitor branch does (the notification was lost; the work
    was not).
  - **No such line** → check whether the pane is still alive with
    `cmux read-screen --surface <surface>`. **If it fails, retry once** before
    concluding anything: a transient cmux socket failure must not be read as a dead
    pane. If both attempts fail, tell the user the review pane `<surface>` is gone and
    completion could not be detected. Respond to the user in Japanese.
  - **Pane alive** → re-arm the same timer, increment the arm count, and end the turn
    again — **but only while the count is at most 3**. On the 4th wake with no
    completion line and no visible progress in `read-screen`, stop re-arming: report to
    the user with the `read-screen` excerpt and ask how to proceed. "The pane is alive"
    is not evidence of progress — an interactive codex pane never exits, so an unbounded
    re-arm is an infinite loop with no escalation. Respond to the user in Japanese.

### Step 4: Report

Report the bin's launch summary (surface / direction / model / effort / target) in one
line. If Step 0 auto-adopted a candidate, also state which target was chosen. Respond
to the user in Japanese.
