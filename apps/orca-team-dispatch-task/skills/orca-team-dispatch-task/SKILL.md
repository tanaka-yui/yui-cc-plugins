---
name: orca-team-dispatch-task
description: >
  Orca の worktree で 1 つのタスクを worker に実行させる。
  worker を起動し、完了を待ち、成果を親ブランチへ取り込む。
  Use when: "orca dispatch", "orca でタスクを実行", "dispatch on orca".
argument-hint: "<task description>"
---

## Output Language

All user-facing questions, option labels, tables, and progress reports MUST be
rendered in Japanese. This file is written in English for consistency; it does
not change the language presented to the user.

# Orca Team Dispatch

Run one task in its own Orca worktree with one worker, then bring the result home.

```bash
PLUGIN="${CLAUDE_PLUGIN_ROOT:?the plugin root is not set; reinstall the plugin}"
ORCA_BIN="${ORCA_BIN:-/Applications/Orca.app/Contents/Resources/bin/orca}"
```

The Orca CLI is not on PATH. Always call it through `$ORCA_BIN`, including in commands
you show the user.

## Step 1: Write the request down

The worker reads the request from a file. Copy it verbatim — summarising it is how the
user's actual instructions get lost.

```bash
SLUG=<lowercase, digits and hyphens, 1-30 chars>
REQ=$(mktemp)
# Use the coding environment's file-write tool to write the user's request verbatim to "$REQ".
# Do not use a shell heredoc: a request may contain REQUEST (or any delimiter) on its own line.
printf 'request_file=%s\n' "$REQ"
```

Give the file-write tool the printed `request_file` path. Shell variables do not cross tool
calls, so set `REQ` to that exact printed path before running Step 2.

## Step 2: Start

```bash
: "${REQ:?set REQ to the exact request_file path printed in Step 1}"
OUT=$(bash "$PLUGIN/bin/orca-start.sh" --request-file "$REQ" --slug "$SLUG" \
        --objective "<one line naming the outcome>") || { echo "$OUT"; exit 1; }
SD=$(sed -n 's/^status_dir=//p' <<<"$OUT")
```

Exit 1 means the worker did not start. If the message says resources are KEPT, the Task
already exists: do not delete anything, and run the inspection command it prints.

## Step 3: Wait

Tell the user first: when the worker finishes, this skill releases the dispatch before it
acknowledges the message. The terminal was created here and handed to `worker-start`, so
Orca reports it `retained` and does not close it — the terminal and worktree survive until
Step 5 decides what may go and Step 6 asks the user. That is Orca's own rule about reused
terminals, not a retention this skill asked for.

```bash
bash "$PLUGIN/bin/orca-wait.sh" --status-dir "$SD"
```

| Exit | Meaning | What you do |
|---|---|---|
| 0 | The worker finished and reported success | Read `$SD/roles/design/result.md`, tell the user, go to Step 4 |
| 5 | The worker finished and reported failure | Read `result.md`, tell the user what failed, go to Step 5. **Do not merge** |
| 3 | Still running | Report progress, then call it again |
| 4 | The worker stopped or failed, or Orca transport could not be verified | Inspect and tell the user; do not delete anything. If receipt recording succeeded before a release transport failure, rerun the canonical wait; do not recover a batch by hand |
| 1 | A batch is unsupported or contradictory, the receipt cannot be read or written, or release did not complete | It was not acknowledged. Do not acknowledge it by hand; use the state-specific action below |

On exit 1, **do not run `--ack` yourself**. Read the error first. A `worker_done` receipt is
recorded before release is attempted, so `release_pending` is safe to retry: run
`orca-wait.sh` again and it will retry release before acknowledging. `release_unknown` is
different: a retry cannot prove the prior release result. Keep the terminal and worktree,
do not acknowledge, and **do not proceed to Step 4**. Inspect the recorded receipt and result
with the user. If they show a successful worker outcome, the user may explicitly choose the
manual integration command below; it does not acknowledge the batch. That unacknowledged batch
stays at the front of this parent terminal's queue, and manual integration does not unblock that
queue. Start every later dispatch by opening another Orca terminal and invoking this skill
there. `orca-start.sh` has no parent-terminal flag: it reads `ORCA_TERMINAL_HANDLE` from the
Orca terminal that runs it, so it uses the new terminal's handle. Do not copy or set the blocked
handle. For an unsupported or contradictory batch, or an invalid receipt, inspect without moving
the cursor and stop for user direction; do not discard a message this version cannot handle:

```bash
PH=$(jq -r '.parent_handle // empty' "$SD/run.json")
[[ -n "$PH" ]] || { echo "missing parent handle; do not acknowledge anything" >&2; exit 1; }
"$ORCA_BIN" orchestration check --terminal "$PH" --peek --json
# Retry the canonical wait only when its error said release_pending.
# For release_unknown, do not retry or use normal Step 4; never ack by hand.
```

For `release_unknown` only, after the preceding inspection, show the user the recorded outcome
and result. If they explicitly decide to integrate a successful result, they may run this safe
merge command. It performs the normal receipt, status, result, branch, and clean-checkout
guards; it does not acknowledge the blocked batch:

```bash
cat "$SD/received.json"
sed -n '1,240p' "$SD/roles/design/result.md"
# Only after the user has inspected both files and chosen manual integration:
bash "$PLUGIN/bin/orca-merge.sh" --status-dir "$SD"
```

Show the user the inspected message and whether it is `release_pending`, `release_unknown`,
or an unsupported/contradictory message. A transport/health failure is exit 4, not an
invitation to recover a batch manually.

## Step 4: Bring the result home

On exit 0 only.

```bash
bash "$PLUGIN/bin/orca-merge.sh" --status-dir "$SD"
```

It merges the worker's branch into the branch you were on when the dispatch started. It
refuses unless the worker reported success, `result.md` is non-empty, your checkout is
still on that branch, and the checkout is clean. On a conflict it aborts the merge and
keeps everything, so nothing is lost — tell the user how to resolve it.

## Step 5: Give the user the exact cleanup commands

**This step removes nothing.** It decides what may go and prints the commands with real
values filled in. Never show a placeholder. Step 6 asks the user before any of them runs.

Run the release yourself and classify its result — the exit code alone does not tell you
whether closing the terminal is authorised.

Each cleanup block is a separate tool call. Set `SD` to the exact `status_dir` printed by
Step 2 before running a block; every block reloads its own state and fails closed if that
state is absent. Never substitute a made-up handle, dispatch, or worktree id.

[C1] `release_pending` or `release_unknown`: **stop here.** Exiting 0 is not authority to
close anything. Show the user the receipt and this inspection command, and say the
terminal and worktree are being kept on purpose:

```bash
: "${SD:?set SD to the exact status_dir printed in Step 2}"
ORCA_BIN="${ORCA_BIN:-/Applications/Orca.app/Contents/Resources/bin/orca}"
DID=$(jq -r '.roles.design.dispatch // empty' "$SD/workers.json" 2>/dev/null)
[[ -n "$DID" && -n "$ORCA_BIN" ]] || {
  echo "required cleanup state is missing; do not close or remove anything" >&2
  exit 1
}
RELRC=0; REL=$("$ORCA_BIN" orchestration worker-release --dispatch "$DID" --json 2>/dev/null) || RELRC=$?
jq -e '.ok == true and (.result | type == "object")' <<<"$REL" >/dev/null 2>&1 || {
  echo "could not confirm the release; do not close anything" >&2
  exit 1
}
STATE=$(jq -r '.result.state // empty' <<<"$REL" 2>/dev/null)
if [[ "$STATE" == release_unknown ]]; then
  printf '%s\n' "$REL"
  printf '%q orchestration worker-show --dispatch %q --json\n' "$ORCA_BIN" "$DID"
  exit 0
fi
[[ "$RELRC" -eq 0 ]] || { echo "could not confirm the release; do not close anything" >&2; exit 1; }
[[ "$STATE" == release_pending ]] || { echo "release state '${STATE:-unknown}' does not authorise C1" >&2; exit 1; }
printf '%s\n' "$REL"
printf '%q orchestration worker-show --dispatch %q --json\n' "$ORCA_BIN" "$DID"
```

[C2] `retained` or `already_released`: Orca left the terminal to us. **Prove it is ours
before closing it** — compare the handle and the worktree it lives in against the state:

```bash
: "${SD:?set SD to the exact status_dir printed in Step 2}"
ORCA_BIN="${ORCA_BIN:-/Applications/Orca.app/Contents/Resources/bin/orca}"
WT=$(jq -r '.worktree_id // empty' "$SD/workers.json" 2>/dev/null)
TH=$(jq -r '.roles.design.terminal // empty' "$SD/workers.json" 2>/dev/null)
DID=$(jq -r '.roles.design.dispatch // empty' "$SD/workers.json" 2>/dev/null)
WP=$(jq -r '.worktree_path // empty' "$SD/workers.json" 2>/dev/null)
[[ -n "$WT" && -n "$TH" && -n "$DID" && -n "$WP" && -n "$ORCA_BIN" ]] || {
  echo "required cleanup state is missing; do not close or remove anything" >&2
  exit 1
}
RELRC=0; REL=$("$ORCA_BIN" orchestration worker-release --dispatch "$DID" --json 2>/dev/null) || RELRC=$?
jq -e '.ok == true and (.result | type == "object")' <<<"$REL" >/dev/null 2>&1 || {
  echo "could not confirm the release; do not close anything" >&2
  exit 1
}
STATE=$(jq -r '.result.state // empty' <<<"$REL" 2>/dev/null)
[[ "$RELRC" -eq 0 ]] || { echo "could not confirm the release; do not close anything" >&2; exit 1; }
case "$STATE" in
  retained|already_released) ;;
  *) echo "release state '${STATE:-unknown}' does not authorise C2" >&2; exit 1 ;;
esac
SHRC=0; SHOWN=$("$ORCA_BIN" terminal show --terminal "$TH" --json 2>/dev/null) || SHRC=$?
[[ "$SHRC" -eq 0 ]] && jq -e '.ok == true and (.result.terminal | type == "object")' <<<"$SHOWN" >/dev/null 2>&1 || {
  echo "could not verify the terminal identity; do not close anything" >&2
  exit 1
}
if [[ "$(jq -r '.result.terminal.handle // empty' <<<"$SHOWN")" == "$TH" \
   && "$(jq -r '.result.terminal.worktreeId // empty' <<<"$SHOWN")" == "$WT" ]]; then
  printf '%s terminal close --terminal %q --json\n' "$ORCA_BIN" "$TH"
else
  echo "the terminal no longer matches our state; leave it alone"
fi
```

[C3] Removing the worktree is destructive, so **only print that command when every
condition below actually holds**. Check them; do not describe them.

```bash
: "${SD:?set SD to the exact status_dir printed in Step 2}"
ORCA_BIN="${ORCA_BIN:-/Applications/Orca.app/Contents/Resources/bin/orca}"
WT=$(jq -r '.worktree_id // empty' "$SD/workers.json" 2>/dev/null)
TH=$(jq -r '.roles.design.terminal // empty' "$SD/workers.json" 2>/dev/null)
DID=$(jq -r '.roles.design.dispatch // empty' "$SD/workers.json" 2>/dev/null)
WP=$(jq -r '.worktree_path // empty' "$SD/workers.json" 2>/dev/null)
MERGED=$(jq -r '.merged // false' "$SD/integration-result.json" 2>/dev/null)
OWNED=$(jq -r '.worktree_created_by_this_run // false' "$SD/workers.json" 2>/dev/null)
KNOWN=$(jq -c '.worktree_terminals // null' "$SD/workers.json" 2>/dev/null)
[[ -n "$WT" && -n "$TH" && -n "$DID" && -n "$WP" && -n "$ORCA_BIN" && -n "$KNOWN" ]] || {
  echo "required cleanup state is missing; do not close or remove anything" >&2
  exit 1
}
RELRC=0; REL=$("$ORCA_BIN" orchestration worker-release --dispatch "$DID" --json 2>/dev/null) || RELRC=$?
jq -e '.ok == true and (.result | type == "object")' <<<"$REL" >/dev/null 2>&1 || {
  echo "could not confirm the release; do not remove anything" >&2
  exit 1
}
STATE=$(jq -r '.result.state // empty' <<<"$REL" 2>/dev/null)
[[ "$RELRC" -eq 0 ]] || { echo "could not confirm the release; do not remove anything" >&2; exit 1; }
case "$STATE" in
  retained|already_released) ;;
  *) echo "release state '${STATE:-unknown}' does not authorise C3" >&2; exit 1 ;;
esac
SHRC=0; SHOWN=$("$ORCA_BIN" terminal show --terminal "$TH" --json 2>/dev/null) || SHRC=$?
[[ "$SHRC" -eq 0 ]] && jq -e '.ok == true and (.result.terminal | type == "object")' <<<"$SHOWN" >/dev/null 2>&1 || {
  echo "could not verify the terminal identity; do not remove anything" >&2
  exit 1
}
IDENTITY_OK=no
if [[ "$(jq -r '.result.terminal.handle // empty' <<<"$SHOWN")" == "$TH" \
   && "$(jq -r '.result.terminal.worktreeId // empty' <<<"$SHOWN")" == "$WT" ]]; then
  IDENTITY_OK=yes
fi
DIRTY=$(git -C "$WP" status --porcelain 2>/dev/null); DRC=$?

# Every terminal Orca still has in that worktree must be one we recorded. Keep all three
# states: yes is proven, no is disproven, and unknown is not enough authority to remove.
ACCOUNTED=unknown
TLRC=0; TL=$("$ORCA_BIN" terminal list --worktree "id:$WT" --json 2>/dev/null) || TLRC=$?
if [[ "$TLRC" -eq 0 ]] && jq -e '.ok == true and (.result.terminals | type == "array")' <<<"$TL" >/dev/null 2>&1 \
   && jq -e 'type == "array"' <<<"$KNOWN" >/dev/null 2>&1; then
  ACCOUNTED=$(jq -n --argjson l "$(jq -c '[.result.terminals[].handle]' <<<"$TL")" \
                    --argjson k "$KNOWN" 'if (($l - $k) | length) == 0 then "yes" else "no" end' -r)
fi

if [[ "$MERGED" == true && "$OWNED" == true && "$DRC" -eq 0 && -z "$DIRTY" \
      && "$IDENTITY_OK" == yes && "$ACCOUNTED" == yes ]]; then
  printf '%s worktree rm --worktree %q --json\n' "$ORCA_BIN" "id:$WT"
else
  echo "not offering to remove the worktree:"
  [[ "$MERGED" == true ]]      || echo "  - the work is not merged yet"
  [[ "$OWNED" == true ]]       || echo "  - this dispatch reused an existing worktree; it is not ours to remove"
  [[ "$DRC" -eq 0 ]]           || echo "  - the worker checkout could not be inspected"
  [[ -z "$DIRTY" ]]            || echo "  - the worker checkout has uncommitted changes"
  [[ "$IDENTITY_OK" == yes ]]  || echo "  - the terminal identity did not match our state"
  case "$ACCOUNTED" in
    yes) ;;
    no)      echo "  - a terminal in that worktree is not one we recorded" ;;
    unknown) echo "  - the terminals in that worktree could not be listed, so nothing is proven" ;;
  esac
fi
```

`IDENTITY_OK` is calculated inside [C3]; do not carry a shell variable from [C2]. It is `yes`
only when the handle and worktree matched in this block.
When the worker failed (Step 3 exit 5) `MERGED` is false, so no removal is offered — that
is the intended behaviour, not a gap.

[C5] The dispatch record under `.dispatch/<slug>` holds the only local copy of the request
and the worker's result, so it is offered for removal only once the work is merged. This
block calls no Orca command, so it classifies no release; it proves instead that `$SD` really
is this dispatch's record and that it sits inside a `.dispatch` directory:

```bash
: "${SD:?set SD to the exact status_dir printed in Step 2}"
MERGED=$(jq -r '.merged // false' "$SD/integration-result.json" 2>/dev/null)
[[ -f "$SD/run.json" && -f "$SD/workers.json" ]] || {
  echo "this is not a dispatch status directory; do not remove anything" >&2
  exit 1
}
PARENT=$(cd "$SD/.." 2>/dev/null && pwd -P) || PARENT=""
[[ "$(basename "${PARENT:-/}")" == .dispatch ]] || {
  echo "the status directory is not inside .dispatch; do not remove it" >&2
  exit 1
}
if [[ "$MERGED" == true ]]; then
  printf 'rm -rf %q\n' "$SD"
else
  echo "not offering to remove the dispatch record:"
  echo "  - the work is not merged yet, so this is the only copy of the request and result"
fi
```

Say these things to the user in plain language:

- [C1] `release_pending` and `release_unknown` mean the release did not finish. Do not
  close the terminal or acknowledge by hand. Retry only `release_pending`; for
  `release_unknown`, inspect the receipt and result, then leave the original parent queue
  blocked even if the user explicitly chooses the guarded manual integration.
- [C2] Only a terminal whose handle and worktree still match our recorded state may be
  closed. If they do not match, someone else owns it now.
- [C3] The removal command is printed only when the work is merged, **this dispatch
  created the worktree**, the checkout is clean and readable, the terminal identity
  matched, and every terminal still in that worktree is one we recorded. A reused
  worktree is never offered for removal: it was not ours to begin with. **If the
  terminals cannot be listed at all, that is not "none" — nothing is proven, so the
  command is not printed.**
- [C4] `worktree rm` also tries to delete the branch. Orca keeps any branch whose changes
  it cannot prove are already merged, so a surviving branch is a signal, not a failure.
  Do not add `--force` unless the user has looked at the dirty files and accepted losing
  them.
- [C5] The dispatch record is offered only after a merge. Until then it holds the only copy
  of what was asked and what came back, and losing it loses the way to inspect or resume by
  hand.

## Step 6: Ask once, then run what the user approves

Step 5 decided. This step asks and executes. It derives no decision of its own: it runs only
a command Step 5 actually printed, exactly as printed.

[C6] The ask and the run:

- If Step 5 printed no cleanup command, there is nothing to approve — [C1]'s inspection
  command is not one. Tell the user what is being kept and why, using the reasons Step 5
  already printed, and stop. Do not ask.
- Ask once, in a single multi-select question, and offer only the actions Step 5 printed:
  closing the terminal ([C2]), removing the worktree ([C3]), and removing the dispatch
  record ([C5]). Never offer an action Step 5 declined to print.
- Selecting nothing is a valid answer. Leave everything and say what remains.
- Run the approved commands in this order: terminal, then worktree, then dispatch record.
  Orca does not let go of a worktree whose terminal is still open, and the record is the
  last thing to lose.
- Run each command exactly as Step 5 printed it. Do not retype a handle or a worktree id,
  do not add `--force`, and do not substitute a selector you did not see printed.
- Check the receipt of each Orca command: it counted only when `.ok == true`. On anything
  else, stop there, report what did not happen, and leave the rest in place. A failure never
  authorises the step after it.
- The dispatch record holds the ids of the terminal and the worktree. When it is offered
  next to them, say in that option what removing the record while keeping the others costs,
  so the choice is made knowingly.
- Finish by reporting what was removed and what was kept.

## Known limitations

State these when they apply. Do not work around them silently.

| Limitation | What the user does |
|---|---|
| Cleanup never runs on its own | Answer the Step 6 question; only what you approve is removed, and anything you decline stays |
| If this session dies mid-dispatch, nothing recovers automatically | Inspect with `$ORCA_BIN orchestration task-list --run <run_id> --json` and `$ORCA_BIN orchestration worker-show --dispatch <id> --json`, then clean up as in Step 5 and Step 6 |
| If the worker stops without reporting, waiting times out | Same inspection; the state is on disk under `.dispatch/<slug>/` |
| The worker cannot ask questions | It is told to fail with a reason in `result.md` instead. Read it and dispatch again |
| The runner is fixed and cannot be configured; it runs `claude --dangerously-skip-permissions` | Dispatch only a task you trust: the worker receives no permission prompts |
| Repositories that need setup hooks are out of scope | The worktree is created with setup skipped |
| A `release_unknown` batch blocks its original parent terminal's queue | Do not acknowledge it. Inspect `received.json` and `result.md`; guarded manual integration does not unblock that queue. Start later dispatches from another Orca terminal, whose `ORCA_TERMINAL_HANDLE` is used at launch |
| Failure and edge receipt fixtures are partly simulated | The real E2E proves the one-worker success path only. Stage 2 must capture real `check` wait/ack, `worker-show` wait-state, `worker-release` alternate-state, and terminal/worktree cleanup receipts before relying on their consuming paths |

## State on disk

`.dispatch/<slug>/`: `request.md`, `run.json`, `workers.json`, `received.json`,
`integration-result.json`, `run-design.sh`, and `roles/design/{status.json,result.md}`.
Everything needed to resume or clean up by hand is here. `.dispatch/` is added to the
repository's `info/exclude`, so it never shows up in the user's `git status`.
