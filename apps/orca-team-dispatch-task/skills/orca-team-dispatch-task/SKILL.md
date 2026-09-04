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
```

## Step 2: Start

```bash
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
the user cleans up in Step 5. That is Orca's own rule about reused terminals, not a
retention this skill asked for.

```bash
bash "$PLUGIN/bin/orca-wait.sh" --status-dir "$SD"
```

| Exit | Meaning | What you do |
|---|---|---|
| 0 | The worker finished and reported success | Read `$SD/roles/design/result.md`, tell the user, go to Step 4 |
| 5 | The worker finished and reported failure | Read `result.md`, tell the user what failed, go to Step 5. **Do not merge** |
| 3 | Still running | Report progress, then call it again |
| 4 | Worker health or Orca transport could not be verified | Inspect and tell the user; do not delete anything |
| 1 | A batch is unsupported, contradictory, or release is still pending | It was not acknowledged. Do not acknowledge it by hand; inspect and retry safely below |

On exit 1, **do not run `--ack` yourself**. A `worker_done` receipt is recorded before
release is attempted, so `release_pending` is safe to retry: run `orca-wait.sh` again and
it will retry release before acknowledging. For an unsupported batch, inspect without
moving the cursor and stop for user direction; do not discard a message this version cannot
handle:

```bash
PH=$(jq -r '.parent_handle // empty' "$SD/run.json")
[[ -n "$PH" ]] || { echo "missing parent handle; do not acknowledge anything" >&2; exit 1; }
"$ORCA_BIN" orchestration check --terminal "$PH" --peek --json
# For release_pending only, retry the canonical wait; it alone decides whether to ack.
bash "$PLUGIN/bin/orca-wait.sh" --status-dir "$SD"
```

Show the user the inspected message and whether it is a retryable release state or an
unsupported message. A transport/health failure is exit 4, not an invitation to recover a
batch manually.

## Step 4: Bring the result home

Only on exit 0.

```bash
bash "$PLUGIN/bin/orca-merge.sh" --status-dir "$SD"
```

It merges the worker's branch into the branch you were on when the dispatch started. It
refuses unless the worker reported success, `result.md` is non-empty, your checkout is
still on that branch, and the checkout is clean. On a conflict it aborts the merge and
keeps everything, so nothing is lost — tell the user how to resolve it.

## Step 5: Give the user the exact cleanup commands

**This version removes nothing.** Print the commands with real values filled in, and let
the user decide. Never show a placeholder.

Run the release yourself and classify its result — the exit code alone does not tell you
whether closing the terminal is authorised.

```bash
WT=$(jq -r '.worktree_id' "$SD/workers.json")
TH=$(jq -r '.design.terminal' "$SD/workers.json")
DID=$(jq -r '.design.dispatch' "$SD/workers.json")
WP=$(jq -r '.worktree_path' "$SD/workers.json")
MERGED=$(jq -r '.merged // false' "$SD/integration-result.json" 2>/dev/null)
IDENTITY_OK=no
if [[ -z "$WT" || -z "$TH" || -z "$DID" || -z "$WP" || -z "$ORCA_BIN" ]]; then
  echo "required cleanup state is missing; do not close or remove anything" >&2
  exit 1
fi
DIRTY=$(git -C "$WP" status --porcelain 2>/dev/null)
echo "merged=$MERGED  worker checkout dirty=[${DIRTY:-clean}]"

REL=$("$ORCA_BIN" orchestration worker-release --dispatch "$DID" --json 2>/dev/null)
STATE=$(jq -r '.result.state // empty' <<<"$REL")
```

[C1] `release_pending` or `release_unknown`: **stop here.** Exiting 0 is not authority to
close anything. Show the user the receipt and this inspection command, and say the
terminal and worktree are being kept on purpose:

```bash
echo "$REL"; echo "$ORCA_BIN orchestration worker-show --dispatch $DID --json"
```

[C2] `retained` or `already_released`: Orca left the terminal to us. **Prove it is ours
before closing it** — compare the handle and the worktree it lives in against the state:

```bash
SHOWN=$("$ORCA_BIN" terminal show --terminal "$TH" --json 2>/dev/null)
if [[ "$(jq -r '.result.terminal.handle // empty' <<<"$SHOWN")" == "$TH" \
   && "$(jq -r '.result.terminal.worktreeId // empty' <<<"$SHOWN")" == "$WT" ]]; then
  IDENTITY_OK=yes
  printf '%s terminal close --terminal %q --json\n' "$ORCA_BIN" "$TH"
else
  IDENTITY_OK=no
  echo "the terminal no longer matches our state; leave it alone"
fi
```

[C3] Removing the worktree is destructive, so **only print that command when every
condition below actually holds**. Check them; do not describe them.

```bash
OWNED=$(jq -r '.worktree_created_by_this_run // false' "$SD/workers.json")
DIRTY=$(git -C "$WP" status --porcelain 2>/dev/null); DRC=$?

# Every terminal Orca still has in that worktree must be one we recorded.
# **Failing to list them is not the same as there being none** — if either side of the
# comparison is unknown, the answer is "cannot tell", and cannot-tell closes the gate.
KNOWN=$(jq -c '.worktree_terminals' "$SD/workers.json")   # null when the inventory failed
TLRC=0; TL=$("$ORCA_BIN" terminal list --worktree "id:$WT" --json 2>/dev/null) || TLRC=$?
if [[ "$TLRC" -eq 0 ]] && jq -e '.result.terminals | type == "array"' <<<"$TL" >/dev/null 2>&1 \
   && [[ "$KNOWN" != null ]]; then
  ACCOUNTED=$(jq -n --argjson l "$(jq -c '[.result.terminals[].handle]' <<<"$TL")" \
                    --argjson k "$KNOWN" 'if (($l - $k) | length) == 0 then "yes" else "no" end' -r)
else
  ACCOUNTED=unknown
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

`IDENTITY_OK` comes from [C2]: set it to `yes` only when the handle and worktree matched.
When the worker failed (Step 3 exit 5) `MERGED` is false, so no removal is offered — that
is the intended behaviour, not a gap.

Say these things to the user in plain language:

- [C1] `release_pending` and `release_unknown` mean the release did not finish. Do not
  close the terminal by hand to make up for it; re-run the release later or inspect.
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

## Known limitations

State these when they apply. Do not work around them silently.

| Limitation | What the user does |
|---|---|
| Nothing is cleaned up automatically | Run the commands from Step 5 |
| If this session dies mid-dispatch, nothing recovers automatically | Inspect with `$ORCA_BIN orchestration task-list --run <run_id> --json` and `$ORCA_BIN orchestration worker-show --dispatch <id> --json`, then clean up as in Step 5 |
| If the worker stops without reporting, waiting times out | Same inspection; the state is on disk under `.dispatch/<slug>/` |
| The worker cannot ask questions | It is told to fail with a reason in `result.md` instead. Read it and dispatch again |
| The runner is fixed and cannot be configured; it runs `claude --dangerously-skip-permissions` | Dispatch only a task you trust: the worker receives no permission prompts |
| Repositories that need setup hooks are out of scope | The worktree is created with setup skipped |

## State on disk

`.dispatch/<slug>/`: `request.md`, `run.json`, `workers.json`, `received.json`,
`integration-result.json`, `run-design.sh`, and `roles/design/{status.json,result.md}`.
Everything needed to resume or clean up by hand is here. `.dispatch/` is added to the
repository's `info/exclude`, so it never shows up in the user's `git status`.
