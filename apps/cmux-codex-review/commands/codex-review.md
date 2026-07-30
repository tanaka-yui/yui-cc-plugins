---
allowed-tools: Bash
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
  destination from the watcher's wait target, so the notification never arrives).
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

### Step 2: Decide whether to wire up the notification

`<TARGET_ARGS>` is the target argument determined in Step 0 (`--uncommitted` /
`--base <branch>` / `--commit <sha>` / `--path <file>...`; empty if Step 0 was skipped
because the user had already specified the target explicitly).
**Always place `$ARGUMENTS` last: everything after `--` is absorbed as custom review
instructions, and subsequent flags stop being parsed.**

- Parent has already joined a team: pre-join the reviewer agent (register the sender),
  and pass the notification arguments to the bin.
  ```bash
  # The reviewer name is not yet fixed to a surface, so join it after launch. Launch first:
  "${CLAUDE_PLUGIN_ROOT}/bin/cmux-codex-review" <TARGET_ARGS> --team <TEAM> --reviewer <REVIEWER> --parent <PARENT> $ARGUMENTS
  ```
  `<REVIEWER>` is a unique name such as `cxrev-review`. Remember the bin output's
  `token=`/`surface=`. Join the reviewer immediately after launch:
  `~/.agents/skills/agmsg/scripts/join.sh <TEAM> <REVIEWER> codex "$(pwd)"`
- Not joined: launch without notification (backward compatible):
  ```bash
  "${CLAUDE_PLUGIN_ROOT}/bin/cmux-codex-review" <TARGET_ARGS> $ARGUMENTS
  ```

> The reviewer name can be a fixed name decided before launching the bin (e.g.
> `cxrev-review`). Separately from the surface-derived token, send.sh works fine even
> when the reviewer agent name is pre-joined under a human-readable fixed name.

### Step 3: Only when notification is wired up, launch and wait on the watcher

**Using the Bash tool with `run_in_background: true`**:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/cmux-codex-wait" <TEAM> <PARENT> <token> --surface <surface>
```

Don't attach `--timeout` (the default is unlimited). Cutting off a long review by wall
clock abandons a codex that's still alive, collapsing the wait so that a
later-arriving completion notification never wakes it again. Instead, pass `--surface`
so termination is judged by pane liveness.

Once launched, end the turn. After waking, branch on the watcher task's output:

- `status=done`: tell the user the review is complete. Respond to the user in
  Japanese.
- `status=gone`: tell the user the review pane `<surface>` was closed and completion
  could not be detected. Respond to the user in Japanese.

### Step 4: Report

Report the bin's launch summary (surface / direction / model / effort / target) in one
line. If Step 0 auto-adopted a candidate, also state which target was chosen. Respond
to the user in Japanese.
