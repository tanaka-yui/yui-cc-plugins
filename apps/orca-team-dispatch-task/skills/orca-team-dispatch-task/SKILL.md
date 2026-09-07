---
name: orca-team-dispatch-task
description: >
  Orca の worktree で 1 つ以上のタスクを worker に並列実行させる。
  worker を起動し、全件の完了を待ち、成果を親ブランチへ取り込む。
  Use when: "orca dispatch", "orca でタスクを実行", "dispatch on orca".
argument-hint: "<task description>"
---

## Output Language

All user-facing questions, option labels, tables, and progress reports MUST be
rendered in Japanese. This file is written in English for consistency; it does
not change the language presented to the user.

# Orca Team Dispatch

Run each task in its own Orca worktree with its own worker, all on one shared Run, then
bring the results home.

```bash
PLUGIN="${CLAUDE_PLUGIN_ROOT:?the plugin root is not set; reinstall the plugin}"
ORCA_BIN="${ORCA_BIN:-/Applications/Orca.app/Contents/Resources/bin/orca}"
```

The Orca CLI is not on PATH. Always call it through `$ORCA_BIN`, including in commands
you show the user.

## Step 1: Write the request down

Dispatch at most four tasks at once. Four tasks is already four live agent sessions, and
Step 6 asks one question per task — `AskUserQuestion` takes at most four. If the user wants
more, show them the task count and the number of sessions it will start, and get an explicit
yes before going past four.

The worker reads the request from a file. Copy it verbatim — summarising it is how the
user's actual instructions get lost. Do this once per task, giving each task its own slug
and its own request file.

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

Run this once per task. **The first call creates the Run and prints `run_id`; every later
call passes that same `run_id` back with `--run`, so all tasks share one Run and one parent
mailbox.** Call them one after another, not in parallel.

```bash
: "${REQ:?set REQ to the exact request_file path printed in Step 1}"
RUN="${RUN:-}"   # empty for the first task; the printed run_id for every task after it
OUT=$(bash "$PLUGIN/bin/orca-start.sh" --request-file "$REQ" --slug "$SLUG" \
        --objective "<one line naming the outcome>" ${RUN:+--run "$RUN"}) || { echo "$OUT"; exit 1; }
SD=$(sed -n 's/^status_dir=//p' <<<"$OUT")
RUN=$(sed -n 's/^run_id=//p' <<<"$OUT")
printf 'status_dir=%s\nrun_id=%s\n' "$SD" "$RUN"
```

Shell variables do not cross tool calls here either. Keep the printed `status_dir` of every
task and the single `run_id`; Step 3, Step 4 and Step 5 all need them by their exact values.

Exit 1 means that task's worker did not start. If the message says resources are KEPT, the
Task already exists: do not delete anything, and run the inspection command it prints. Tasks
that already started are unaffected — wait for them in Step 3 as usual.

A failed start can still leave a live worker. When the exit-1 message names a `dispatch=<id>`,
or says `worker-start did not report ready` — which records the dispatch id it did get without
printing it — that worker may still send its completion to the shared mailbox. Add that task's
status dir, `<repo root>/.dispatch/<slug>`, to Step 3's wait set anyway. Leaving it out blocks
the whole batch: the wait cannot process a message for a dispatch it was never told about, and
every sibling task's result stays stuck behind it.

## Step 3: Wait

Tell the user first: when a worker finishes, this skill retains its terminal before it
acknowledges the message. Nothing is released here. The terminal, the worktree and the
dispatch record all survive until Step 5 decides what may go and Step 6 asks the user.
Retention is deliberate — a later stage sends review feedback back to the same session.

One call waits for every task at once: the tasks share one Run and one parent mailbox, so a
single drain settles all of them. Pass one `--status-dir` per task.

```bash
# One --status-dir per task, in Step 2's order. Repeat the flag for every further task.
bash "$PLUGIN/bin/orca-wait.sh" --status-dir "<task 1 status_dir printed by Step 2>" \
                               --status-dir "<task 2 status_dir printed by Step 2>"
```

| Exit | Meaning | What you do |
|---|---|---|
| 0 | Every worker finished and reported success | Read each task's `$SD/roles/design/result.md`, tell the user, go to Step 4 for every task |
| 5 | At least one worker reported failure | Read each `result.md`, tell the user which task failed and why, go to Step 4 only for the tasks that succeeded, and to Step 5 for all of them. **Do not merge a failed task** |
| 3 | Still running | Report progress, then call it again with the same `--status-dir` set |
| 4 | A worker stopped or failed, or an Orca call the wait depends on could not be verified | Inspect and tell the user; do not delete anything. The retention or the acknowledgement did not complete, so rerun the canonical wait; do not recover a batch by hand |
| 1 | A batch carries a message this version cannot handle, or its outcome contradicts what is recorded | It was not acknowledged. Do not acknowledge it by hand; inspect it as described below |

**The exit code is the authority, not the text.** Before the aggregate line, the wait prints
one `task=... dispatch=... status_dir=... outcome=...` line per task; on a partial failure
those lines carry both outcomes at once. Use them to name which task failed, and never
decide success by searching the output for `outcome=`.

On exit 1, **do not run `--ack` yourself**. Read the error first. Acknowledging a batch
declares that every message in it was processed, and this batch was not: it either carries a
message type this version cannot handle, or an outcome that contradicts what is already
recorded on disk. Neither is repairable by hand, and rerunning the wait cannot help — it will
read the same batch again. Keep the terminal and worktree, do not acknowledge, and
**do not proceed to Step 4**. Inspect the recorded receipt and result with the user. If they show a successful worker outcome, the user may explicitly choose the
manual integration command below; it does not acknowledge the batch. That unacknowledged batch
stays at the front of this parent terminal's queue, and manual integration does not unblock that
queue. Start every later dispatch by opening another Orca terminal and invoking this skill
there. `orca-start.sh` has no parent-terminal flag: it reads `ORCA_TERMINAL_HANDLE` from the
Orca terminal that runs it, so it uses the new terminal's handle. Do not copy or set the blocked
handle. Inspect without moving the cursor and stop for user direction; do not discard a
message this version cannot handle:

```bash
PH=$(jq -r '.parent_handle // empty' "$SD/run.json")
[[ -n "$PH" ]] || { echo "missing parent handle; do not acknowledge anything" >&2; exit 1; }
"$ORCA_BIN" orchestration check --terminal "$PH" --peek --json
# Rerun the canonical wait only for exit 4; it retries the retention and the acknowledgement.
# For an unhandled or contradictory batch, do not rerun it, and never ack by hand.
```

After that inspection, show the user the recorded outcome and result. If they explicitly
decide to integrate a successful result, they may run this safe merge command. It performs the normal receipt, status, result, branch, and clean-checkout
guards; it does not acknowledge the blocked batch:

```bash
cat "$SD/received.json"
sed -n '1,240p' "$SD/roles/design/result.md"
# Only after the user has inspected both files and chosen manual integration:
bash "$PLUGIN/bin/orca-merge.sh" --status-dir "$SD"
```

Show the user the inspected message and why this version could not handle it — an unknown
message type, or an outcome that contradicts the recorded one. A transport/health failure is
exit 4, not an invitation to recover a batch manually.

## Step 4: Bring the result home

Run this once per succeeded task, with `SD` set to that task's `status_dir`. On exit 0 every
task qualifies. On exit 5 only the tasks whose own `task=...` line ended in
`outcome=succeeded` do.

```bash
bash "$PLUGIN/bin/orca-merge.sh" --status-dir "$SD"
```

It merges the worker's branch into the branch you were on when the dispatch started. It
refuses unless the worker reported success, `result.md` is non-empty, your checkout is
still on that branch, and the checkout is clean. On a conflict it aborts the merge and
keeps everything, so nothing is lost — tell the user how to resolve it. Merge the tasks one
after another and report each result; a refusal for one task says nothing about the others.

## Step 5: Give the user the exact cleanup commands

**This step removes nothing.** It decides what may go and prints the commands with real
values filled in. Never show a placeholder. Step 6 asks the user before any of them runs.

Nothing here releases a worker. Ask Orca what it already holds, with
`orchestration worker-list --run <run_id> --json`, and classify from that answer. The release
that closes the worker's terminal is one of the actions Step 6 asks about, so the worker's
session is still there while the user is deciding.

Each cleanup block is a separate tool call. Run [C1], [C2], [C3] and [C5] once per task, with
`SD` set to that task's exact `status_dir`; run [C7] once for the whole Run, before any
removal. Every block reloads its own state and fails closed if that state is absent. Never
substitute a made-up handle, dispatch, or worktree id.

**Read the exit codes by their message, not by their number.** [C1] exits 0 only when it found
a reason to stop, so on the ordinary path it exits 1 with a message that begins `expected:` —
that is not a stop, and you go straight on to [C2]. Every other non-zero exit is a stop: those
messages begin `required cleanup state is missing`, `could not …`, or `release state … does not
authorise`, and they mean nothing may be closed or removed for that task. A [C2] or [C3] that
exits 0 without printing a command is also not a stop; it has simply decided there is nothing
to offer, and it says why.

[C1] `release_pending` or `release_unknown`: **stop here** for that task. Exiting 0 is not
authority to close anything. Show the user the reported state and this inspection command, and
say the terminal and worktree are being kept on purpose. On the ordinary path this block prints
`expected: no hold on this task …` and exits 1; continue with [C2]:

```bash
: "${SD:?set SD to the exact status_dir printed in Step 2}"
ORCA_BIN="${ORCA_BIN:-/Applications/Orca.app/Contents/Resources/bin/orca}"
DID=$(jq -r '.roles.design.dispatch // empty' "$SD/workers.json" 2>/dev/null)
RUN=$(jq -r '.run_id // empty' "$SD/run.json" 2>/dev/null)
[[ -n "$DID" && -n "$RUN" && -n "$ORCA_BIN" ]] || {
  echo "required cleanup state is missing; do not close or remove anything" >&2
  exit 1
}
WLRC=0; WL=$("$ORCA_BIN" orchestration worker-list --run "$RUN" --json 2>/dev/null) || WLRC=$?
[[ "$WLRC" -eq 0 ]] && jq -e '.ok == true and (.result.workers | type == "array")' <<<"$WL" >/dev/null 2>&1 || {
  echo "could not read the release state; do not close anything" >&2
  exit 1
}
W=$(jq -c --arg d "$DID" 'first(.result.workers[] | select(.dispatchId == $d)) // empty' <<<"$WL" 2>/dev/null)
[[ -n "$W" ]] || { echo "could not read the release state; do not close anything" >&2; exit 1; }
STATE=$(jq -r '.resource.releaseState // .terminalState // empty' <<<"$W" 2>/dev/null)
case "$STATE" in
  release_pending|release_unknown)
    printf '%s\n' "$W"
    printf '%q orchestration worker-show --dispatch %q --json\n' "$ORCA_BIN" "$DID"
    exit 0 ;;
  released|already_released|retained|active|reclaimable)
    echo "expected: no hold on this task (release state '$STATE'); continue with [C2]" >&2
    exit 1 ;;
  *)
    echo "could not read the release state; do not close anything" >&2
    exit 1 ;;
esac
```

[C2] Decide whether the worker's terminal may be closed, and print the command that closes it
**without running it**. On the ordinary path the state is `retained`, because Step 3 retained
this worker on purpose; `active` and `reclaimable` mean the same thing here — the terminal is
still there and closing it is ours to offer. `released` and `already_released` mean the
terminal is already gone, so there is nothing to offer. Print the command only when the
handle and worktree Orca reports still match our recorded state; otherwise say it is being
kept and why.

The command printed is `orchestration worker-release --dispatch <id>`, not a raw terminal
close: it archives the worker's output before closing, so `worker-read` still works
afterwards, and it refuses to close a terminal whose identity it cannot prove or that someone
has taken over. That refusal is a second gate under the one this block applies.

A terminal Orca has already closed cannot be shown, so a failing `terminal show` is fatal
here: under every state that reaches the identity check the terminal is supposed to still be
there.

```bash
: "${SD:?set SD to the exact status_dir printed in Step 2}"
ORCA_BIN="${ORCA_BIN:-/Applications/Orca.app/Contents/Resources/bin/orca}"
WT=$(jq -r '.worktree_id // empty' "$SD/workers.json" 2>/dev/null)
TH=$(jq -r '.roles.design.terminal // empty' "$SD/workers.json" 2>/dev/null)
DID=$(jq -r '.roles.design.dispatch // empty' "$SD/workers.json" 2>/dev/null)
WP=$(jq -r '.worktree_path // empty' "$SD/workers.json" 2>/dev/null)
RUN=$(jq -r '.run_id // empty' "$SD/run.json" 2>/dev/null)
[[ -n "$WT" && -n "$TH" && -n "$DID" && -n "$WP" && -n "$RUN" && -n "$ORCA_BIN" ]] || {
  echo "required cleanup state is missing; do not close or remove anything" >&2
  exit 1
}
WLRC=0; WL=$("$ORCA_BIN" orchestration worker-list --run "$RUN" --json 2>/dev/null) || WLRC=$?
[[ "$WLRC" -eq 0 ]] && jq -e '.ok == true and (.result.workers | type == "array")' <<<"$WL" >/dev/null 2>&1 || {
  echo "could not read the release state; do not close anything" >&2
  exit 1
}
W=$(jq -c --arg d "$DID" 'first(.result.workers[] | select(.dispatchId == $d)) // empty' <<<"$WL" 2>/dev/null)
[[ -n "$W" ]] || { echo "could not read the release state; do not close anything" >&2; exit 1; }
STATE=$(jq -r '.resource.releaseState // .terminalState // empty' <<<"$W" 2>/dev/null)
case "$STATE" in
  released|already_released)
    echo "Orca already closed the worker terminal; nothing to close"; exit 0 ;;
  retained|active|reclaimable) ;;
  *) echo "release state '${STATE:-unknown}' does not authorise C2" >&2; exit 1 ;;
esac
SHRC=0; SHOWN=""
SHOWN=$("$ORCA_BIN" terminal show --terminal "$TH" --json 2>/dev/null) || SHRC=$?
[[ "$SHRC" -eq 0 ]] && jq -e '.ok == true and (.result.terminal | type == "object")' <<<"$SHOWN" >/dev/null 2>&1 || {
  echo "could not verify the terminal identity; do not close anything" >&2
  exit 1
}
if [[ "$(jq -r '.result.terminal.handle // empty' <<<"$SHOWN")" == "$TH" \
   && "$(jq -r '.result.terminal.worktreeId // empty' <<<"$SHOWN")" == "$WT" ]]; then
  printf '%s orchestration worker-release --dispatch %q --json\n' "$ORCA_BIN" "$DID"
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
RUN=$(jq -r '.run_id // empty' "$SD/run.json" 2>/dev/null)
MERGED=$(jq -r '.merged // false' "$SD/integration-result.json" 2>/dev/null)
OWNED=$(jq -r '.worktree_created_by_this_run // false' "$SD/workers.json" 2>/dev/null)
KNOWN=$(jq -c '.worktree_terminals // null' "$SD/workers.json" 2>/dev/null)
[[ -n "$WT" && -n "$TH" && -n "$DID" && -n "$WP" && -n "$RUN" && -n "$ORCA_BIN" && -n "$KNOWN" ]] || {
  echo "required cleanup state is missing; do not close or remove anything" >&2
  exit 1
}
WLRC=0; WL=$("$ORCA_BIN" orchestration worker-list --run "$RUN" --json 2>/dev/null) || WLRC=$?
[[ "$WLRC" -eq 0 ]] && jq -e '.ok == true and (.result.workers | type == "array")' <<<"$WL" >/dev/null 2>&1 || {
  echo "could not read the release state; do not remove anything" >&2
  exit 1
}
W=$(jq -c --arg d "$DID" 'first(.result.workers[] | select(.dispatchId == $d)) // empty' <<<"$WL" 2>/dev/null)
[[ -n "$W" ]] || { echo "could not read the release state; do not remove anything" >&2; exit 1; }
STATE=$(jq -r '.resource.releaseState // .terminalState // empty' <<<"$W" 2>/dev/null)
case "$STATE" in
  released|already_released|retained|active|reclaimable) ;;
  *) echo "release state '${STATE:-unknown}' does not authorise C3" >&2; exit 1 ;;
esac
SHRC=0; SHOWN=""; SHOW_OK=no
SHOWN=$("$ORCA_BIN" terminal show --terminal "$TH" --json 2>/dev/null) || SHRC=$?
[[ "$SHRC" -eq 0 ]] && jq -e '.ok == true and (.result.terminal | type == "object")' <<<"$SHOWN" >/dev/null 2>&1 \
  && SHOW_OK=yes
if [[ "$SHOW_OK" == no && "$STATE" != released && "$STATE" != already_released ]]; then
  echo "could not verify the terminal identity; do not remove anything" >&2
  exit 1
fi
IDENTITY_OK=no
if [[ "$SHOW_OK" == no ]]; then
  IDENTITY_OK=yes
elif [[ "$(jq -r '.result.terminal.handle // empty' <<<"$SHOWN")" == "$TH" \
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

[C3] decides whether the worktree may be removed; like [C2] it removes nothing. Step 6 runs
the terminal action first, so a worktree may legitimately be offered here while its terminal
is still open.

`IDENTITY_OK` is calculated inside [C3]; do not carry a shell variable from [C2]. It is `yes`
when the terminal cannot be shown at all under a released state — Orca closed it, which is
the proof — and otherwise only when the handle and worktree matched in this block.
When a worker failed (Step 3 exit 5) that task's `MERGED` is false, so no removal is offered
for it — that is the intended behaviour, not a gap.

[C7] `worker-retain` records a durable exception, so a session that died mid-dispatch
leaves retained terminals behind. Before removing anything for this Run, ask Orca what it
actually still holds and compare it against what we recorded. A retention we did not record
is someone else's — or our own from a previous run — and either way it is not ours to step
on. Every task of this Run shares one answer, so run this once, and list **every** task's
status dir in `SDS` — Orca reports the whole Run, so a sibling left out of `SDS` looks like
a ghost and stops the cleanup of every task. A dir from a **different** Run would do the
opposite — widen the known set and hide a real ghost — so each listed dir's `run_id` is
checked before its dispatches are trusted:

```bash
: "${SD:?set SD to the exact status_dir printed in Step 2}"
ORCA_BIN="${ORCA_BIN:-/Applications/Orca.app/Contents/Resources/bin/orca}"
SDS=("$SD")   # append every other status_dir of this Run
RUN=$(jq -r '.run_id // empty' "$SD/run.json" 2>/dev/null)
[[ -n "$RUN" && -n "$ORCA_BIN" ]] || {
  echo "required cleanup state is missing; do not close or remove anything" >&2
  exit 1
}
# A dir from another Run would widen the known set and hide the very ghost we look for.
WJ=()
for d in "${SDS[@]}"; do
  [[ "$(jq -r '.run_id // empty' "$d/run.json" 2>/dev/null)" == "$RUN" ]] || {
    echo "$d does not belong to Run $RUN; do not close or remove anything" >&2
    exit 1
  }
  WJ+=("$d/workers.json")
done
KNOWN=$(jq -sc '[.[] | .roles[]?.dispatch // empty]' "${WJ[@]}" 2>/dev/null)
[[ -n "$KNOWN" ]] || {
  echo "required cleanup state is missing; do not close or remove anything" >&2
  exit 1
}
WLRC=0; WL=$("$ORCA_BIN" orchestration worker-list --run "$RUN" --terminal-state retained --json 2>/dev/null) || WLRC=$?
[[ "$WLRC" -eq 0 ]] && jq -e '.ok == true and (.result.workers | type == "array")' <<<"$WL" >/dev/null 2>&1 || {
  echo "could not list what Orca still holds for this Run; do not remove anything" >&2
  exit 1
}
GHOSTS=$(jq -c --argjson k "$KNOWN" '[.result.workers[].dispatchId] - $k' <<<"$WL")
if [[ "$(jq 'length' <<<"$GHOSTS")" -eq 0 ]]; then
  echo "every retained worker in this Run is one we recorded"
else
  echo "Orca still holds retained workers we did not record:" >&2
  jq -r '.[]' <<<"$GHOSTS" >&2
  echo "do not remove any worktree or dispatch record for this Run" >&2
  exit 1
fi
```

[C5] The dispatch record under `.dispatch/<slug>` holds the only local copy of the request
and the worker's result, so it is offered for removal only once that task's work is merged.
This block calls no Orca command, so it classifies no release; it proves instead that `$SD`
really is this dispatch's record and that it sits inside a `.dispatch` directory:

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

- [C1] `release_pending` and `release_unknown` mean Orca has not settled an earlier release,
  so nothing may be closed or removed for that task. There is nothing to acknowledge here:
  Step 3 already acknowledged the message that reported this worker. Show the reported state
  and the inspection command, and leave the terminal, the worktree and the record where they
  are. `release_pending` can settle on its own, so running Step 5 again later may clear it;
  `release_unknown` needs the user to look.
- [C2] `retained`, `active` and `reclaimable` mean the worker's terminal is still there, and
  only a terminal whose handle and worktree still match our recorded state is offered for
  release. If they do not match, someone else owns it now. `released` and `already_released`
  mean it is already gone, so there is nothing left to close for that task.
- [C3] The removal command is printed only when the work is merged, **this dispatch
  created the worktree**, the checkout is clean and readable, the terminal identity
  matched, and every terminal still in that worktree is one we recorded. A reused
  worktree is never offered for removal: it was not ours to begin with. **If the
  terminals cannot be listed at all, that is not "none" — nothing is proven, so the
  command is not printed.**
- [C7] Before any removal, what Orca still holds for this Run must match what we recorded.
  A retained worker we cannot account for stops the whole Run's cleanup, not just its own
  task.
- [C4] `worktree rm` also tries to delete the branch. Orca keeps any branch whose changes
  it cannot prove are already merged, so a surviving branch is a signal, not a failure.
  Do not add `--force` unless the user has looked at the dirty files and accepted losing
  them.
- [C5] The dispatch record is offered only after a merge. Until then it holds the only copy
  of what was asked and what came back, and losing it loses the way to inspect or resume by
  hand.

## Step 6: Ask once, then run what the user approves

Step 5 decided. This step asks and executes. It derives no decision of its own: it runs only
a command Step 5 actually printed, exactly as printed. **This is where the worker's terminal
is released**, so closing the session is one of the actions the user approves, never a side
effect of deciding.

[C6] The ask and the run:

- If Step 5 printed no cleanup command for any task, there is nothing to approve — [C1]'s
  inspection command is not one. Tell the user what is being kept and why, using the reasons
  Step 5 already printed, and stop. Do not ask.
- Ask one question per task, with the task's slug as the question header, and offer only the
  actions Step 5 printed for that task. A task for which Step 5 printed nothing is left out
  of the question entirely — say what is being kept for it and why.
- `AskUserQuestion` takes at most four questions. If the user approved more than four tasks
  in Step 1, ask a single question instead whose options are "every task's terminals",
  "every task's worktrees" and "every task's dispatch records", and offer an option only when
  Step 5 printed that action for at least one task.
- Never offer an action Step 5 declined to print.
- Selecting nothing is a valid answer. Leave everything and say what remains.
- Run the approved commands task by task in slug order, and within a task in this order:
  terminal, then worktree, then dispatch record. The terminal command is the
  `worker-release` Step 5 printed — that is what ends the worker's session. Orca does not
  let go of a worktree whose terminal is still open, and the record is the last thing to
  lose.
- Run each command exactly as Step 5 printed it. Do not retype a handle or a worktree id,
  do not add `--force`, and do not substitute a selector you did not see printed.
- Check the receipt of each Orca command: it counted only when `.ok == true`. On anything
  else, stop there, report what did not happen, and leave the rest in place. A failure never
  authorises the step after it, and a failure in one task never authorises skipping ahead in
  another.
- The dispatch record holds the ids of the terminal and the worktree. When it is offered
  next to them, say in that option what removing the record while keeping the others costs,
  so the choice is made knowingly.
- Finish by reporting, per task, what was removed and what was kept.

## Known limitations

State these when they apply. Do not work around them silently.

| Limitation | What the user does |
|---|---|
| Cleanup never runs on its own | Answer the Step 6 question; only what you approve is removed, and anything you decline stays |
| If this session dies mid-dispatch, nothing recovers automatically | Inspect with `$ORCA_BIN orchestration task-list --run <run_id> --json` and `$ORCA_BIN orchestration worker-show --dispatch <id> --json`, then clean up as in Step 5 and Step 6 |
| If a worker stops without reporting, waiting times out for the whole set | Same inspection; the state is on disk under `.dispatch/<slug>/`, one directory per task |
| A worker cannot ask questions | It is told to fail with a reason in `result.md` instead. Read it and dispatch again |
| Every role runs the `claude` agent Orca launches; the model and effort cannot be chosen yet | Dispatch only a task you trust, and wait for the stage that adds per-role agent settings |
| Repositories that need setup hooks are out of scope | The worktree is created with setup skipped |
| A batch this version cannot handle stays unacknowledged and blocks its parent terminal's queue | Do not acknowledge it. Inspect `received.json` and `result.md`; guarded manual integration does not unblock that queue. Start later dispatches from another Orca terminal, whose `ORCA_TERMINAL_HANDLE` is used at launch |
| A dispatch Orca reports as `release_pending` or `release_unknown` is never cleaned up | [C1] stops that task. Leave its terminal, worktree and record alone and inspect it with `$ORCA_BIN orchestration worker-show --dispatch <id> --json`; `release_pending` may settle by itself, `release_unknown` needs a decision |
| Failure and edge receipt fixtures are partly simulated | The real E2E proves the one-worker success path only. Stage 2 must capture real `check` wait/ack, `worker-show` wait-state, `worker-release` alternate-state, and terminal/worktree cleanup receipts before relying on their consuming paths |

## State on disk

One `.dispatch/<slug>/` per task: `request.md`, `run.json`, `workers.json`, `received.json`,
`integration-result.json`, and `roles/design/{status.json,result.md}`. Tasks of one Run carry
the same `run_id` in `run.json` and their own worktree in `workers.json`, whose `roles` map
holds one entry per role so a later stage can add more without moving anything. Everything
needed to resume or clean up by hand is here. `.dispatch/` is added to the repository's
`info/exclude`, so it never shows up in the user's `git status`.
