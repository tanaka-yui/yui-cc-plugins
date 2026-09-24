---
name: orca-team-dispatch-task
description: >
  Orca の worktree で 1 つ以上のタスクを worker に並列実行させる。
  worker を起動し、全件の完了を待ち、成果を親ブランチへ取り込む。
  親は設計しない — タスク分割と取りかかり方 (brainstorm / plan) だけを尋ねてすぐ dispatch し、
  brainstorming や計画は各 worker が自分の worktree で並列に行う。
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

**No parent-side design.** The parent splits the request into tasks, asks Step 1b's single
question, and dispatches immediately. Brainstorming, planning, clarifying questions about the
requirements, and reading code to decide an approach all belong to each worker, in parallel,
in its own worktree. The parent does none of them before dispatching.

```bash
PLUGIN="${CLAUDE_PLUGIN_ROOT}"
ORCA_BIN="${ORCA_BIN:-${ORCA_CLI_COMMAND:-/Applications/Orca.app/Contents/Resources/bin/orca}}"
```

Orca exports `ORCA_CLI_COMMAND` with the name of its CLI; on WSL2 that is `orca-ide`,
which is on PATH, and on macOS the CLI lives inside the app bundle. Never assume either
shape: always call it through `$ORCA_BIN`, including in commands you show the user.

**Route on the arguments first.** `--setup` and `--reset` configure and dispatch nothing:
do the Configuration section and stop. `--issue` takes its work from GitHub instead of from
the user: do the Issue mode section. Anything else is a dispatch, which reads that
configuration, asks S0 once when there is none, and starts at Step 1.

## Configuration

Each role runs an Orca agent with an optional model and reasoning effort. `--setup` and
`--reset` are the only mechanical entry points; both dispatch nothing.

| File | Purpose |
|---|---|
| `~/.claude/config/orca-team-dispatch-task/config.json` | Global role tuples |
| `<repo>/.dispatch/config.json` | Project role tuples, shadowing the global layer |

A role tuple has `agent`, `model` and `effort`, and the three resolve **field by field**
through override, then project, then global. There is no runner registry: `--agent` is what
Orca launches, so the agent id is the runner. **A layer that is present but unreadable stops
the dispatch** rather than being read as absent.

`review_mode` decides which roles a dispatch starts. It resolves through the same three
layers.

| `review_mode` | Roles started | What happens |
|---|---|---|
| `off` (default) | `design` | One worker builds the thing. This is what a dispatch did before this setting existed |
| `on` | `design`, `design_review` | A reviewer starts first and waits; `design` has its plan reviewed before building it |
| `on` with `phase_b=on` | adds `exec_review` | The implementation is reviewed too, the same way. **A reviewer for the builder only exists when there is a separate builder** |

`phase_b` splits planning from building, and `integration` decides how the work comes back.
Both resolve through the same three layers, and **both default to what a dispatch did before
they existed**.

| Setting | Default | The other value |
|---|---|---|
| `phase_b` | `off` — `design` plans and builds | `on` — `design` writes a plan and builds nothing; a second worker, `exec`, builds from it in its own worktree |
| `integration` | `merge` — the work is merged into the branch you dispatched from | `pr` — the branch is pushed and a pull request is opened instead |
| `setup` | `skip` — the worktree is created without running the repository's setup hooks | `run` — they run, and **a worker is never started on a worktree whose setup failed** |
| `design_mode` | `direct` — `design` is given the request and gets on with it | `plan` — it must decide and record an approach before the first edit. `brainstorm` — it starts with the `superpowers:brainstorming` skill and works the request through with whoever is watching its terminal, writes the agreed design to `spec.md`, then plans with `superpowers:writing-plans` into `plan.md`; with `phase_b=off` it then builds with `superpowers:subagent-driven-development` |

**`phase_b` decides which branch carries the work** — `design` when off, `exec` when on.
Both merging and opening a pull request read that one recorded value, so they cannot
disagree about which branch to take.

A role's tuple can be configured while its role is switched off, so a reviewer can be set up
before `review_mode` is turned on. A tuple for a role that is off is not shown to the
dispatch.

A field left unset in every layer takes its role's built-in default:

| Role | `agent` | `model` | `effort` |
|---|---|---|---|
| `design` | `claude` | `claude-opus-5-5[1m]` | `max` |
| `design_review` | `codex` | `gpt-6-astra` | `xhigh` |
| `exec` | `codex` | `gpt-6-sol` | `high` |
| `exec_review` | `claude` | `claude-opus-5-5[1m]` | `max` |

**The default `model` and `effort` apply only while the role runs its default agent**, so a
model meant for one agent is never handed to another. A role switched to another agent without
a model gets no `--model`, and Orca's own default applies. Orca requires `--model` with
`--effort`, so an effort without a model is dropped with a warning.

### S0. Ask once when nothing is configured

A dispatch reads this configuration, so **a dispatch that finds none asks once before
Step 1**. A layer file holding only third-party keys is not configured.

```bash
: "${PLUGIN:?run the block at the top of this file first}"
SCRIPTS="$PLUGIN/skills/orca-team-dispatch-task/scripts"
RR=$(git rev-parse --show-toplevel) || { echo "not in a git repo" >&2; exit 1; }
CFG=$(node "$SCRIPTS/config-resolve.ts" --project-root "$RR") || exit 1
jq -r 'if .configured then "configured" else "not configured" end' <<<"$CFG"
```

When it prints `not configured`, ask one question with three answers: configure now (go to
S1), dispatch on the built-in defaults, or set values for this one dispatch only. **Declining
is a real answer** — dispatch on the defaults and do not ask again in this session. Never
block a dispatch on this question, and never ask it when the answer is already `configured`.

### S1. Show the current state

Show both layers, the resolved tuple, and which accounts Orca holds. This writes nothing.

```bash
printf 'resolved:\n'; jq '.roles' <<<"$CFG"
printf 'global:\n';   node "$SCRIPTS/config-edit.ts" --config "$(jq -r .global_config  <<<"$CFG")" --show
printf 'project:\n';  node "$SCRIPTS/config-edit.ts" --config "$(jq -r .project_config <<<"$CFG")" --show
```

The account an agent signs in as is **not** part of a role tuple, and this skill cannot
change it. Orca's CLI has only `account add` and `account list`; nothing selects the active
account, so every role uses whatever the Orca app has active for that runtime. Show it so the
user knows which account their dispatch will spend, and say that switching happens in the
Orca app:

```bash
"$ORCA_BIN" account list --json | jq '.result
  | {claude: {accounts: [.claude.accounts[]?.id], active: .claude.activeAccountIdsByRuntime},
     codex:  {accounts: [.codex.accounts[]?.id],  active: .codex.activeAccountIdsByRuntime}}'
```

### S2. Ask which layer, then ask the tuple

Ask one question for the destination: the global layer or the project layer. The chosen
layer is the only one written. Then ask `review_mode`, and after it `agent`, `model` and
`effort` for each role that mode actually starts. **Do not ask for a role the chosen mode
does not start** — a tuple nobody reads is a setting the user cannot verify.

Offer `claude` and `codex` as agent choices, and take a free-text answer for anything else —
the list is a convenience, **not an allowlist**, so Orca gaining an agent does not require a
change here. Offer models and efforts that match the chosen agent, and always offer "leave
unset" so the user can fall back to the role's default.

### S3. Validate before writing

Keep the answers as a pending tuple. Reject an empty answer, leading or trailing whitespace,
control characters, and `'`, `"`, `` ` ``, `$`, `\`, or `!`; re-ask only the invalid
dimension. Do not trim an answer — saving a different value than the one typed is worse than
refusing it. `config-edit.ts` validates again and writes nothing if any part is invalid.

### S4. Preview, confirm, then write once

Show the chosen file before and after, and offer write or abort. On write, make **exactly
one** `config-edit.ts` call carrying every `--set`, so the whole result lands in a single
atomic move and a rejected value leaves the file untouched. For the project layer, `mkdir -p`
its `.dispatch` directory first, and tell the user it now shadows the global layer for this
repository.

```bash
LAYER=$(jq -r .global_config <<<"$CFG")   # or .project_config for the project layer
mkdir -p "$(dirname "$LAYER")"
node "$SCRIPTS/config-edit.ts" --config "$LAYER" \
  --set roles.design.agent="$AGENT" --set roles.design.model="$MODEL" --set roles.design.effort="$EFFORT"
node "$SCRIPTS/config-edit.ts" --config "$LAYER" --show
```

Drop the `--set` for any dimension the user left unset, and use `--unset` to clear one that
was previously set.

### R. `--reset`

Ask which layer, then clear only the key this skill owns. Other keys in that file are kept,
and an absent file is not created.

```bash
node "$SCRIPTS/config-edit.ts" --config "$LAYER" --unset roles
```

Report what changed and offer to continue at S1.

### Choosing how `design` starts

`design_mode` only ever changes the `design` role's instructions. `exec` follows the plan and
a reviewer builds nothing, so telling them how to start would just blur who decides.

**The configured value is a default, not a decision.** A dispatch never starts a worker on it
unasked: Step 1b asks about every task and Step 2 carries the answer. `direct` is therefore
reachable only through the configuration and through `--issue`; a dispatch someone is watching
is always told `brainstorm` or `plan`.

**`brainstorm` needs a person.** The worker's terminal is a real one you can talk to, which
is what makes it work — and it is also why an `--issue` run silently downgrades it to `plan`
and says so: an unattended run has nobody to answer, so the worker would only wait a round
and then decide alone anyway. That run asks nothing, so it has no Step 1b.

A `brainstorm` worker is told not to stall if nobody answers, and to say so in `result.md`
rather than inventing its own version of the skill when it is not installed.

### Trying one dispatch without saving

Step 2 accepts `--agent`, `--model`, `--effort` and `--design-mode`. They outrank both layers
for that one call and write nothing, so a model can be tried before it is saved.

## Issue mode

`--issue` takes the work from GitHub issues instead of from the user's message. `--issue <N>`
carries exactly that one issue and skips I1 entirely; bare `--issue` asks I1 and then claims
issues in batches until it runs out or hits the batch limit.

**One issue is carried end to end by one call**, and `bin/orca-issue.sh` is that call. It
dispatches, waits, merges, moves the labels and closes the issue. **It removes nothing** —
Step 5 decides and Step 6 asks, exactly as for a hand-written dispatch.

| Property | This version |
|---|---|
| Integration | **Merge only.** There is no PR path; do not offer one |
| Driving | One batch at a time, waiting for it to finish before claiming the next |
| Roles | Whatever `review_mode` resolves to, used for every issue in the run |

### I0. Preflight

Check `gh`, `jq` and the Orca runtime, then take the lock. **Do not start if the lock is
live** — two loops claiming the same issues collide on the same worktree name.

```bash
: "${PLUGIN:?run the block at the top of this file first}"
SCRIPTS="$PLUGIN/skills/orca-team-dispatch-task/scripts"
RR=$(git rev-parse --show-toplevel) || { echo "not in a git repo" >&2; exit 1; }
STATE="$RR/.dispatch-issue/state.json"
command -v gh >/dev/null 2>&1 || { echo "gh is not installed" >&2; exit 1; }
bash "$SCRIPTS/issue-fetch.sh" --state-file "$STATE" lock-check || exit 1
bash "$SCRIPTS/issue-fetch.sh" --state-file "$STATE" lock-acquire --lease-min 60 || exit 1
# The state file and its lock would otherwise leave the parent checkout dirty, and every
# merge refuses a dirty checkout. Exclude the directory the way `.dispatch/` is excluded.
EX=$(git -C "$RR" rev-parse --git-path info/exclude) && mkdir -p "$(dirname "$EX")" \
  && grep -qxF '.dispatch-issue/' "$EX" 2>/dev/null || printf '.dispatch-issue/\n' >> "$EX"
```

`lock-acquire` needs a stable session id; export `LOOP_SESSION_ID` if the environment does
not already provide one. **Release the lock on every exit path**, including the ones you did
not plan for.

### I1a. One named issue

`--issue <N>` names the work, so **there is nothing to ask**: no filter, no batch size, no
batch count. Do I0, then claim that issue and carry it. **Claiming goes through the same
`fetch`**, which skips the search for a named issue and keeps the compensation that removes
the label again when the state cannot be written.

```bash
: "${SCRIPTS:?run the I0 block first}"; : "${STATE:?run the I0 block first}"
: "${NUM:?set NUM to the issue number given on the command line}"
bash "$SCRIPTS/issue-fetch.sh" --state-file "$STATE" init \
  --config-json '{"concurrency":1}' --filter-json '{"issue":"named"}' || exit 1
bash "$SCRIPTS/issue-fetch.sh" --state-file "$STATE" ensure-labels || exit 1
CLAIM=$(bash "$SCRIPTS/issue-fetch.sh" --state-file "$STATE" \
          fetch --issue "$NUM" --limit 1 --batch 1) || exit 1
[[ "$(jq 'length' <<<"$CLAIM")" -eq 1 ]] || {
  echo "issue #$NUM was not claimed; it is already recorded in $STATE" >&2
  exit 1
}
SLUG=$(jq -r '.[0].slug' <<<"$CLAIM")
REQ=$(mktemp); jq -r '.[0] | "\(.title)\n\n\(.body)"' <<<"$CLAIM" > "$REQ"
printf 'slug=%s\nrequest_file=%s\n' "$SLUG" "$REQ"
```

An empty claim is not a failure to hide: it means the issue is already in the state file,
from this run or an earlier one. Say which, and stop rather than claiming it twice.

Then carry it with the I3 block and release the lock with the I4 block. **Skip I1 and I2**
— there is no batch. `init` is in the block above because `fetch` needs the state file;
`reconcile` is deliberately left out, because a named issue does not depend on the rest of
the state and `fetch --issue` already refuses one that is already recorded.

### I1. Ask once, then stop asking

This section is for bare `--issue` only. A named issue never reaches it.

Ask a single question with these four parts. An issue run is unattended once it starts, so
**nothing may ask again until it ends**.

1. **Label filter** — the top labels from `gh label list`, plus "no filter" and free text.
2. **Assignee** — `@me`, unassigned only, or no filter.
3. **How many issues at once** — an integer from 1 to 10, default 5. These really do run
   at the same time: I3 dispatches the whole batch before waiting for any of it. **The cap
   of 10 is a safety valve against resource amplification and is not raised on request**:
   each issue costs a worktree and a worker, and doubles under `review_mode=on`.
4. **How many batches** — a number, or until the issues run out.

Do not ask about `review_mode`, `phase_b` or `integration`: they come from the configuration
and are fixed for the run. **Say which ones are in effect** before starting, because they
change what the run costs and where the work ends up.

### I2. Reconcile before claiming anything

```bash
: "${SCRIPTS:?run the I0 block first}"; : "${STATE:?run the I0 block first}"
bash "$SCRIPTS/issue-fetch.sh" --state-file "$STATE" init \
  --config-json '{"concurrency":5}' --filter-json '{"state":"open"}' || exit 1
bash "$SCRIPTS/issue-fetch.sh" --state-file "$STATE" ensure-labels || exit 1
bash "$SCRIPTS/issue-fetch.sh" --state-file "$STATE" reconcile
```

**`reconcile` reporting `abort` stops the run.** It means an earlier run left an issue marked
as dispatched, and that worker may still be alive. Release the lock, show the reasons, and
stop. Do not clear the state by hand.

### I3. Claim a batch and carry each issue

`fetch` claims up to `--limit` issues and prints them as JSON, each with the `slug` it
assigned. Exit 3 means nothing could be claimed and exit 4 means exhaustion could not be
confirmed; **both end the run rather than looping again**.

**The batch runs in parallel, in three passes.** Dispatch every issue first, then wait for
all of them with **one** call, then finish them one by one. Carrying an issue end to end
before starting the next would make the batch size meaningless — the issues would run one at
a time no matter what the user chose.

Pass 1, once per issue. Write its title and body to a request file, then:

```bash
: "${PLUGIN:?run the block at the top of this file first}"
: "${STATE:?run the I0 block first}"
: "${NUM:?set NUM, SLUG and REQ from the claimed issue}"
: "${SLUG:?set NUM, SLUG and REQ from the claimed issue}"
: "${REQ:?set NUM, SLUG and REQ from the claimed issue}"
bash "$PLUGIN/bin/orca-issue.sh" --state-file "$STATE" --phase dispatch \
  --issue "$NUM" --slug "$SLUG" --request-file "$REQ" ${RUN:+--run "$RUN"}
```

**Keep the `run_id` it prints and pass it as `--run` for every later issue in the batch**, so
the whole batch shares one Run and one parent mailbox. Keep every printed `status_dir` too.
An issue that fails to dispatch is already marked `dispatch/failed` with its resources kept;
carry on with the next one, and leave it out of pass 2.

Pass 2, once for the whole batch — one `--status-dir` per issue that dispatched:

```bash
: "${PLUGIN:?run the block at the top of this file first}"
bash "$PLUGIN/bin/orca-wait.sh" --status-dir "<status_dir 1>" --status-dir "<status_dir 2>" \
  --on-stall report
```

`--on-stall report` keeps an unattended run from stopping to ask: a stalled task is written to
its `stall.json` and the log, and the wait goes on. When someone comes back, a `stall.json` with
`detected_at` names the task to take through Step 3's exit 8 steps.

Read its exit code the way Step 3 describes, and run it in the background for the reason
given there. Exit 5 is a partial failure, not a batch failure: go on to pass 3 for every
issue whose own `role=design` line said `succeeded`.

Pass 3, once per issue that dispatched. It merges, moves the labels and closes the issue:

```bash
: "${PLUGIN:?run the block at the top of this file first}"
: "${STATE:?run the I0 block first}"
: "${NUM:?set NUM and SLUG from the issue you dispatched}"
: "${SLUG:?set NUM and SLUG from the issue you dispatched}"
bash "$PLUGIN/bin/orca-issue.sh" --state-file "$STATE" --phase finish \
  --issue "$NUM" --slug "$SLUG" ${REPO:+--repo "$REPO"}
```

When `integration` is `pr`, resolve the repository **once for the whole run** and pass it as
`REPO`, for the reason given in Step 4:

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner) || exit 1
```

**A run that opens pull requests does not close its issues.** Each pull request body carries
`Closes #<N>`, so GitHub closes the issue when it merges. Closing it here would leave it
closed even if the pull request is rejected.

Exit 1 means that issue was not carried; its labels are already moved to `dispatch/failed`
and **its resources are kept on purpose**. Carry on with the next issue — one issue failing
says nothing about the others.

### I4. Between batches

Report what happened per issue, then claim the next batch. Stop when the batch limit is
reached, when `fetch` finds nothing, or on exit 3 or 4. **Release the lock at the end:**

```bash
: "${SCRIPTS:?run the I0 block first}"; : "${STATE:?run the I0 block first}"
bash "$SCRIPTS/issue-fetch.sh" --state-file "$STATE" lock-release
```

Then go to Step 5 for every `status_dir` the run produced, calling `orca-cleanup.ts plan` once
per Run with every `status_dir` that printed that `run_id` — `plan` refuses a list that mixes
Runs. Cleanup is the same as for a hand-written dispatch: it decides, the user approves, and
only what they approve is removed.

## Step 1: Write the request down

Dispatch at most four tasks at once. Four tasks is already four live agent sessions, and
Step 6 asks one question per task — `AskUserQuestion` takes at most four. If
the user wants more, show them the task count and the number of sessions it will start, and get
an explicit yes before going past four.

**Split, do not design.** Splitting the request into tasks is the parent's only decision about
its content. Do not invoke `superpowers:brainstorming` yourself, do not ask the user about the
requirements, and do not explore the code to shape a task — a worker started with `brainstorm`
does all of that with the user in its own terminal. When the split itself is unclear, ask only
how to split it.

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

## Step 1b: Ask how each task starts

**Ask this before Step 2, every time, in one `AskUserQuestion` call.** It covers every task at
once, the way `cmux-team-dispatch-task` asks its Step 1c. A configured `design_mode` is the
recommendation this question starts on, never a reason to skip it — how a task is best started
differs task by task.

Read the configured value first:

```bash
: "${PLUGIN:?run the block at the top of this file first}"
RR=$(git rev-parse --show-toplevel) || { echo "not in a git repo" >&2; exit 1; }
node "$PLUGIN/skills/orca-team-dispatch-task/scripts/config-resolve.ts" --project-root "$RR" \
  | jq -r '"design_mode=\(.design_mode) integration=\(.integration)"'
```

Then ask which tasks should start with brainstorming. Each question is `multiSelect` and its
options are task slugs, so put up to four tasks per question; group the tasks in order and put
up to four such questions in the one call — three when the integration question below shares it.
Past that many tasks, ask the rest in a further call. A selected task gets `brainstorm`, every other task gets `plan`:

| Answer | What the `design` worker is told |
|---|---|
| `brainstorm` (selected) | Start with the `superpowers:brainstorming` skill and settle the open questions with whoever is watching its terminal, write the agreed design to `spec.md`, then plan with `superpowers:writing-plans` into `plan.md`. With `phase_b=off` it then builds with `superpowers:subagent-driven-development` and stops after committing, without `superpowers:finishing-a-development-branch`: the parent brings the branch home; with `phase_b=on` it stops at the plan |
| `plan` (not selected) | Decide the approach and record it in `result.md` before the first edit |

Name the configured value in the question text as the recommendation: all tasks when it is
`brainstorm`, none when it is `plan` or `direct`. **`direct` is not an answer here** — a
dispatch someone is watching is a dispatch that can be asked about, so the choice is between
talking it through and writing it down. The interface may refuse an empty selection, so say in
the question that answering "none" through the free-text option starts every task on `plan`.

**The same call also asks how the finished work comes home**, the way
`cmux-team-dispatch-task` asks its Step 1e. Add one single-select question with two answers:
**Wait and merge** — every task is waited for and its branch merged into the branch you
dispatched from — and **PR per task** — each task's branch is pushed and a pull request is
opened instead. Mark the configured `integration` as the recommendation. It is asked every time,
like the question above: the configuration is the recommendation, never a reason to skip it.

The answer covers every task in the dispatch. Keep it as `INTEGRATION`, `merge` or `pr`, and
pass it in Step 2 for every task. Because this question takes one of the four places in the
call, the first call carries at most three task questions — twelve tasks.

Keep each task's answer as that task's `DESIGN_MODE` and pass it in Step 2. Step 2 refuses to
run without it, so a task nobody was asked about cannot be started.

**`--issue` has no Step 1b.** An unattended run has nobody to ask, so it takes `design_mode`
from the configuration and downgrades `brainstorm` to `plan`. It takes `integration` from the configuration as it is.

## Step 2: Start

Run this once per task. **The first call creates the Run and prints `run_id`; every later
call passes that same `run_id` back with `--run`, so all tasks share one Run and one parent
mailbox.** Call them one after another, not in parallel.

```bash
: "${REQ:?set REQ to the exact request_file path printed in Step 1}"
: "${DESIGN_MODE:?set DESIGN_MODE to this task's Step 1b answer: brainstorm or plan}"
: "${INTEGRATION:?set INTEGRATION to the Step 1b answer: merge or pr}"
RUN="${RUN:-}"   # empty for the first task; the printed run_id for every task after it
OUT=$(bash "$PLUGIN/bin/orca-start.sh" --request-file "$REQ" --slug "$SLUG" \
        --design-mode "$DESIGN_MODE" --integration "$INTEGRATION" \
        --objective "<one line naming the outcome>" ${RUN:+--run "$RUN"}) || { echo "$OUT"; exit 1; }
SD=$(sed -n 's/^status_dir=//p' <<<"$OUT")
RUN=$(sed -n 's/^run_id=//p' <<<"$OUT")
printf 'status_dir=%s\nrun_id=%s\n' "$SD" "$RUN"
```

Take `--objective` from the request's own words; it names the outcome, it is not a design to
work out first. Shell variables do not cross tool calls here either, and `DESIGN_MODE` and
`INTEGRATION` are among them: set them in this call from the Step 1b answers.
`INTEGRATION` is recorded in `workers.json` when the task starts; `--resume` and
`--phase exec` keep the recorded value and refuse a new one. Keep the printed `status_dir` of every task and
the single `run_id`; Step 3, Step 4 and Step 5 all need them by their exact values.

Exit 1 means that task's worker did not start. If the message says resources are KEPT, the
Task already exists: do not delete anything, and run the inspection command it prints. Tasks
that already started are unaffected — wait for them in Step 3 as usual.

When the start failed after the task's reviewer started but before its `design` did, the
status dir already exists, so Step 2 refuses the same slug. Continue it instead with
`bash "$PLUGIN/bin/orca-start.sh" --slug "$SLUG" --resume --design-mode "$DESIGN_MODE"`. It
uses the recorded request and Run, starts only the roles that have no dispatch yet, and
refuses when `design` already has one.

A failed start can still leave a live worker. When the exit-1 message names a `dispatch=<id>`,
or says `worker-start did not report ready` — which records the dispatch id it did get without
printing it — that worker may still send its completion to the shared mailbox. Add that task's
status dir, `<repo root>/.dispatch/<slug>`, to Step 3's wait set anyway — but only once the id
actually reached `workers.json`, which both messages above satisfy; if the message instead says
the dispatch id could not be recorded, the id exists only on stderr, so write it into
`workers.json` by hand before adding that dir, or the whole wait fails at startup with `the
dispatch identity is incomplete` and every sibling task goes down with it. Leaving it out blocks
the whole batch: the wait cannot process a message for a dispatch it was never told about, and
every sibling task's result stays stuck behind it.

## Step 3: Wait

**Finishing takes two phases, and this wait drives the parent's half.** A worker does not
report itself done: it offers the work with a `merge_ready` carrying a nonce, and waits. This
wait checks that the work is actually there — a plan for a planning role, a `result.md` for a
building one, a `VERDICT:` line for a reviewer — and replies on the same dispatch with either
`completion-accepted:` or `completion-remediation:`. Only then does the worker report and
send `worker_done`.

**Reviewers are not exempt from the check.** If they were, the moment their findings became
official would be undefined, and findings could go missing with nobody noticing.

You do not run anything extra for this: the wait below does it while it waits.

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

**Run it in the background, not in the foreground.** It waits up to 24 hours (`--max-waits`
288 windows of five minutes), and your own shell call is cut off long before that. A wait
that is cut off does not lose anything — nothing is acknowledged until a batch is fully
processed — but while it is gone nobody is answering the workers, so start it again.

**Nothing restarts this wait for you, and nothing announces that it stopped.** It is
resident for up to 24 hours, so the host can stop it for reasons that have nothing to do with
this run — measured twice on 2026-09-11, when a worker's own test run filled the machine and
the harness stopped the wait to reclaim memory. Restarting it is always safe; a batch is
never acknowledged until it has been processed in full. To find out whether anyone is
waiting, read the stamp the wait leaves for every task it watches:

```bash
: "${SD:?set SD to the exact status_dir printed in Step 2}"
jq -r '"age=\(now - .beat | floor)s window=\(.window_ms / 1000)s"' "$SD/wait.json" 2>/dev/null \
  || echo "no wait has ever stamped this task"
```

An age above three windows means nobody is answering that task's workers: start the wait
again with the same `--status-dir` set. `orca-recover.sh` reports the same thing before it
decides anything, so a lost worker and a lost wait do not get mistaken for each other.

When a host keeps stopping it, the wait can be detached from whatever supervises it. **Decide
that deliberately**, because it trades one failure for another:

```bash
setsid nohup bash "$PLUGIN/bin/orca-wait.sh" --status-dir "<task 1 status_dir>" \
  --on-stall report >> "$SD/wait.log" 2>&1 < /dev/null &
```

A detached wait survives, but **its exit codes reach nobody**. Exit 6 is the one that hurts:
a worker that asked a person a question stays blocked until someone reads `wait.log` and
answers it. Detach only if you will poll that log.
It passes `--on-stall report` because a stall would otherwise end it with exit 8, which nobody
sees, and after that no worker's completion is answered; with `report` the stall is only
written to `wait.log`.

**When `phase_b` is on, this wait does not return until `exec` has finished — and nothing has
started `exec` yet.** Its aggregate needs a `status.json` for `integration_role`, which is
`exec` under `phase_b`, so a wait left alone here keeps polling with every worker it can see
already finished, until two hours later it reports the task as stalled with `exec` never
started. Go to Step 3.5 **while this wait keeps running**,
then come back to the exit table below.

While it runs it does two things besides collecting outcomes. It answers each `merge_ready`
with an acceptance or a remediation, and it **types one line into that worker's terminal**.
That second part is not decoration: a message put in an Orca mailbox does not wake a worker
that has closed its turn, so a reply nobody reads stops that dispatch for good. For the same
reason the wait re-types that line every 30 minutes into any worker that is still holding an
unanswered completion. Workers that are still working are never typed into.

| Exit | Meaning | What you do |
|---|---|---|
| 0 | Every worker finished and reported success | Read each task's `$SD/roles/design/result.md`, tell the user, go to Step 4 for every task |
| 5 | At least one worker reported failure | Read each `result.md`, tell the user which task failed and why, go to Step 4 only for the tasks that succeeded, and to Step 5 for all of them. **Do not merge a failed task** |
| 3 | Still running | Report progress, then call it again with the same `--status-dir` set |
| 6 | A worker asked a person a question and is blocked on the answer | Relay the question to the user verbatim, run the `reply` command the wait printed with their answer, then run the same wait again. Nothing failed; the worker resumes on the reply |
| 8 | A task has made no progress for two hours, and none of its roles is waiting on a person | Nothing was stopped. Follow the stalled-task steps below: show the user what each role's terminal shows, ask once, run what they chose, then run the same wait again |
| 4 | A worker stopped or failed, or an Orca call the wait depends on could not be verified | Inspect and tell the user; do not delete anything. The retention or the acknowledgement did not complete, so rerun the canonical wait; do not recover a batch by hand. If a worker was lost while its completion was still owed, see the recovery block below |
| 1 | A batch carries a message this version cannot handle, or its outcome contradicts what is recorded | It was not acknowledged. Do not acknowledge it by hand; inspect it as described below |

On exit 6 nothing has gone wrong. A worker used `orchestration ask`, which blocks it until a
person answers through this parent — so the answer is the only thing that moves it. Show the
user the question as printed, ask them, and run the printed
`orchestration reply --id <message id>` with their answer. Then run the same wait again: it
treats a question it has already relayed as handled, so the batch drains and that worker's
completion is processed. Do not acknowledge anything by hand, and do not treat the block as
a failure — the worker is alive and waiting.

On exit 8 nothing has been stopped either. The wait found a task where nothing a worker
writes — its status, result, completion record, spec, plan, review files, or the files and commits
in its worktree — has changed for `--stall-after-min` minutes (120 by default), while no role
was waiting on a person. **Workers never give up waiting by themselves**, so this is the only
place a stuck task is noticed, and **whether to stop anything is the user's decision, never
yours.**

For every `stalled_role` line the wait printed, read what that terminal shows now:

```bash
: "${TERM_HANDLE:?set TERM_HANDLE to the terminal= value of one stalled_role line}"
"$ORCA_BIN" terminal read --terminal "$TERM_HANDLE" --screen --json
```

An `unstarted_role` line names the role that carries the work but was never started. For
`exec` it means Step 3.5 was skipped for that task: do not ask about it, go to Step 3.5,
then run the same wait again so that `exec`'s completion is answered.

Show the user how long each task has been idle and the last lines of each role's screen, then
ask in one `AskUserQuestion` call: one `multiSelect` question per stalled task, whose options
are **Keep waiting** and one option per role on that task's `stalled_role` lines. One call
holds at most four questions; past four stalled tasks, ask the rest in a further call. While
the user is being asked, the wait is not running, so no worker's completion is answered until
you start it again. For a task where only **Keep waiting** was chosen, restart its stall clock:

```bash
: "${PLUGIN:?run the block at the top of this file first}"
: "${SD:?set SD to the status_dir= value of the stalled task line}"
bash "$PLUGIN/bin/orca-stop.sh" --status-dir "$SD" --snooze
```

For every role the user chose to stop, run this once, with `ROLE` set to that role:

```bash
: "${PLUGIN:?run the block at the top of this file first}"
: "${SD:?set SD to the status_dir= value of the stalled task line}"
: "${ROLE:?set ROLE to one role the user chose to stop}"
bash "$PLUGIN/bin/orca-stop.sh" --status-dir "$SD" --role "$ROLE"
```

It records the stop before it closes the terminal, so the wait settles that role as
`outcome=stopped` instead of reporting a lost worker, and `orca-recover.sh` leaves it alone.
It restarts the stall clock too. Stopping a reviewer tells the worker it reviews to carry on
without review: that work is then unreviewed, and Step 4's gate applies as usual. A reviewer
that has already finished is still listed while the worker it reviews is waiting, since one
that could not deliver its verdict leaves that worker waiting; stopping it tells that worker
to carry on. Stopping `design` or `exec` tells its reviewer there is nothing
left to review, so the reviewer finishes, and it fails the task: do not bring it home, and take
it to Step 5. Exit 1
means the stop could not be recorded or the terminal could not be closed, and the message says
which; tell the user. Then run the same wait again.

**The exit code is the authority, not the text.** Before the aggregate line, the wait prints
one `task=... role=... dispatch=... status_dir=... outcome=...` line **per dispatched role**,
so a task under review contributes two lines; on a partial failure those lines carry both
outcomes at once. Use them to name which task failed, and never decide success by searching
the output for `outcome=`.

**A task's outcome is its `design` line.** A reviewer that failed means the work went
unreviewed, not that the work was lost, so it does not by itself make the task fail. Say so
when it happens rather than hiding it — its own line is right there.

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

A dispatch recorded as `pr` uses `orca-pr.sh` instead, as Step 4 shows; `orca-merge.sh`
refuses it.

Show the user the inspected message and why this version could not handle it — an unknown
message type, or an outcome that contradicts the recorded one. A transport/health failure is
exit 4, not an invitation to recover a batch manually.

### Recovering a lost worker

A worker that has offered its work, or written `error`, still owes a `worker_done`. **Orca
will not let the parent send that on its behalf**, so if the agent process is gone, nobody
can — the work is finished but the task never settles. This decides what to do about it, one
role at a time:

```bash
: "${SD:?set SD to the exact status_dir printed in Step 2}"
: "${PLUGIN:?run the block at the top of this file first}"
bash "$PLUGIN/bin/orca-recover.sh" --status-dir "$SD" --dry-run
```

Read what it says it would do, then run it again without `--dry-run` to act. Its choices are
narrow on purpose:

- **Alive** → it only nudges. Replacing a live worker would let two of them drive the same
  completion.
- **Proven `failed` or `stopped`** → it starts a replacement on the *same* task with
  `--retry-of`, raises the generation, and drops the old completion record so the new worker
  offers again with a fresh nonce.
- **Anything it cannot confirm, including `outcome_unknown`** → it does nothing and says so.
  Fencing comes first; guessing here is how two capabilities end up driving one lifecycle.
- **Orca already settled it** → nothing is sent; the local record is brought into line.

Run it when Step 3 reports exit 4, or when a task sits unfinished with no worker left.

## Step 3.5: Start the exec phase when `phase_b` is on

Skip this whole step when `phase_b` is `off` — `design` carries the work itself and there is
no second stage.

`orca-start.sh` starts one stage per call. Step 2 ran `--phase design`; the builder is a
separate stage, because nobody can implement a plan that does not exist yet. **Nothing else
starts it** — not Step 2, not the wait, not the workers. Step 3's wait will not return until
`exec` has run, so a dispatch that skips this step hangs with every worker that was started
already finished, until the stall report two hours later names `exec` as never started.

**Leave Step 3's wait running. Do not stop it.** It reads `workers.json` again whenever a
message names a dispatch it does not know, so it picks `exec` and `exec_review` up by itself
once this step has recorded them. The batch that named them is never acknowledged before it
is understood, so nothing is lost while it reloads.

Stopping it to start a replacement is worse than doing nothing: Orca's waiter outlives the
process that held it, so the new one is refused for a while, and nobody answers any worker
during that gap.

Because the wait holds the mailbox, `design`'s own status file is what tells you it is done.
Look at it, once per task, and check again in a minute if it is not settled yet:

```bash
: "${SD:?set SD to the exact status_dir printed in Step 2}"
jq -r '.status // "missing"' "$SD/roles/design/status.json" 2>/dev/null || echo missing
```

- `$SD/roles/design/stopped.json` exists → the user stopped `design`: **do not start it**,
  whatever the status says. Go to Step 5; the wait settles this task as failed.
- `done` → start the stage, below.
- `error` → **do not start it.** There is no plan worth building. Go to Step 5, and tell the
  user what `$SD/roles/design/result.md` says.
- anything else → `design` is still working. Look again later.

Then, once per task whose `design` reported `done`:

```bash
: "${PLUGIN:?run the block at the top of this file first}"
: "${SLUG:?set SLUG to that task's slug}"
bash "$PLUGIN/bin/orca-start.sh" --phase exec --slug "$SLUG"
```

It continues that task's existing Run and status dir, so it takes no `--request-file`, no
`--objective` and no `--run`. It starts `exec_review` before `exec` when `review_mode` is on,
for the same reason Step 2 starts a reviewer first: the builder may ask for a review the
moment it starts.

It refuses, without starting anything, when `design` is not `done`, when `plan.md` is missing
or empty, or when `exec` already has a dispatch. Those are guards, not failures to retry
around — read what the message names and fix that.

Then go back to Step 3's exit table. The wait you already have is still the one driving this:
it now answers `exec` too, and it does not return until `exec` has settled. Its log says
`a dispatch was added after this wait started` at the moment it picks the new stage up.

## Step 4: Bring the result home

Run this once per succeeded task, with `SD` set to that task's `status_dir`. On exit 0 every
task qualifies. On exit 5 only the tasks whose own line for the **role that carries the
work** ended in `outcome=succeeded` do — that role is named in `integration_role`. A
reviewer's worktree carries no work to bring home.

First read how this dispatch was asked to come home — Step 1b's answer, recorded when it
started:

```bash
: "${SD:?set SD to the exact status_dir printed in Step 2}"
jq -r '.integration // "not recorded"' "$SD/workers.json"
```

`merge` means the merge below. `pr` means the pull request block further down. `not recorded`
means an older version started the dispatch: use the configured `integration`. Each script
refuses the other's recorded value, so the two cannot be mixed up.

```bash
bash "$PLUGIN/bin/orca-merge.sh" --status-dir "$SD"
```

It merges that role's branch into the branch you were on when the dispatch started. It
refuses unless the worker reported success, `result.md` is non-empty, your checkout is
still on that branch, and the checkout is clean. On a conflict it aborts the merge and
keeps everything, so nothing is lost — tell the user how to resolve it. Merge the tasks one
after another and report each result; a refusal for one task says nothing about the others.

**It also refuses work that asked for a review and never got a verdict.** When a reviewer was
started for the integrating role, at least one `review/<plan|code>-round-*-findings.md` must
carry a `VERDICT:` line **and that verdict must have reached the worker it was written for**,
which `sent.json` records. A findings file on its own proves only that someone wrote it. Measured 2026-09-12: a reviewer's verdict was refused delivery and
dropped in two runs out of three, and the unreviewed work still reported `succeeded`. The
worker is never sent back for this — giving up after round 2 is a path this skill allows on
purpose — so the check lives here, where a person decides. Report the refusal to the user
with what `result.md` says about the review, and take the work anyway only if they say so:

```bash
bash "$PLUGIN/bin/orca-merge.sh" --status-dir "$SD" --allow-unreviewed
```

**When it is `pr`, use this instead of the merge above.** Do not do both: opening
a pull request and then merging puts the work in before anyone reviews it.

```bash
: "${SD:?set SD to the exact status_dir printed in Step 2}"
: "${PLUGIN:?run the block at the top of this file first}"
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner) || exit 1
bash "$PLUGIN/bin/orca-pr.sh" --status-dir "$SD" --repo "$REPO"
```

**Resolve the repository once, here, and pass it in.** Measured on 2026-09-02: a worker left
to resolve its own remote in a three-remote repository pushed to a personal fork and opened
the pull request inside that fork, where the issue does not exist, so its `Closes` line did
nothing and the fork's pull request was accepted as proof of completion.

## Step 5: Give the user the exact cleanup commands

**This step removes nothing.** It decides what may go and prints the commands with real
values filled in. Never show a placeholder. Step 6 asks the user before any of them runs.

Nothing here releases a worker. `orca-cleanup.ts plan` asks Orca what it already holds, with
`orchestration worker-list --run <run_id> --json`, `terminal show` and `terminal list` — all
read-only — and classifies from those answers. The release that closes the worker's terminal
is one of the actions Step 6 asks about, so the worker's session is still there while the user
is deciding.

Run it once for the whole Run, with **every** task's exact `status_dir`. Orca reports the whole
Run, so a task left out looks like a retained worker nobody recorded and stops the cleanup of
every task. Never substitute a made-up handle, dispatch, or worktree id: the plan reads them
from the dispatch records.

```bash
: "${PLUGIN:?run the block at the top of this file first}"
# One --status-dir per task of this Run, in Step 2's order. Repeat the flag for every further task.
node "$PLUGIN/bin/orca-cleanup.ts" plan --status-dir "<task 1 status_dir printed by Step 2>" \
                                        --status-dir "<task 2 status_dir printed by Step 2>"
```

It runs the TypeScript file directly, which needs Node 22.18 or later. If `node` is missing or
older, the call fails before it reads anything: tell the user, and do not fall back to cleaning
up by hand.

**Read the exit code:**

- `0` — the plan is written. Its last line is `plan_file=<path>`; Step 6 passes that file on.
  For each task the output lists the commands it offers, what it keeps and why, and whether the
  task stopped. A plan that offers nothing is still exit 0.
- `1` — the whole Run stopped and no plan was written. stderr says why. Nothing may be closed or
  removed for any task; show the user the reason.
- `2` — the call itself was wrong. Fix the arguments.

A task that **stopped** offers nothing: its terminal, its worktree and its record all stay. Besides
[C1], a task stops when Orca's answer leaves out one of its workers or reports a state this
skill does not know, when a terminal that should still be there cannot be shown, or when a
role's record is incomplete. The output prints each reason.

Say these things to the user in plain language:

- [C1] `release_pending` and `release_unknown` mean Orca has not settled an earlier release,
  so the task stops and nothing may be closed or removed for it. There is nothing to acknowledge
  here: Step 3 already acknowledged the message that reported this worker. Show the reported
  state and the inspection command the plan prints for it,
  `$ORCA_BIN orchestration worker-show --dispatch <id> --json`, and leave the terminal, the
  worktree and the record where they are. `release_pending` can settle on its own, so running
  Step 5 again later may clear it; `release_unknown` needs the user to look.
- [C2] `retained`, `active`, `reclaimable` and `not_requested` mean the worker's terminal is
  still there, and only a terminal whose `handle` and `worktreeId` still match our recorded
  state is offered for release. `retained` is the ordinary state, because Step 3 retained this
  worker on purpose. `not_requested` simply means nobody has asked for a release yet, which is
  the normal state of a worker that failed on startup — measured 2026-09-11, and treating it as
  unreadable used to make Step 5 refuse to clean up after exactly the failures that most need
  cleaning up. If they do not match, someone else owns it now. `released` and
  `already_released` mean it is already gone, so there is nothing left to close for that task.
  The command offered is `orchestration worker-release --dispatch <id>`, not a raw terminal
  close: it archives the worker's output before closing, so `worker-read` still works
  afterwards, and it refuses to close a terminal whose identity it cannot prove or that someone
  has taken over. That refusal is a second gate under this one.
- [C3] The removal command is offered only when the work is merged, **this dispatch
  created the worktree**, the checkout is clean and readable, the terminal identity
  matched, and every terminal still in that worktree is one we recorded. A reused
  worktree is never offered for removal: it was not ours to begin with. **If the
  terminals cannot be listed at all, that is not "none" — nothing is proven, so the
  command is not offered.** Under a released state, a terminal that can no longer be shown
  counts as matched, because Orca closing it is the proof. Step 6 runs the terminal action
  first, so a worktree may legitimately be offered while its terminal is still open. When a
  worker failed (Step 3 exit 5) its work is not merged, so no removal is offered for that task —
  that is the intended behaviour, not a gap.
- [C7] Before any removal, what Orca still holds for this Run must match what we recorded.
  `worker-retain` records a durable exception, so a session that died mid-dispatch leaves
  retained workers behind; one we did not record is someone else's, or our own from a previous
  run, and either way not ours to step on. A retained worker we cannot account for stops the
  whole Run's cleanup, not just its own task. A status dir from a **different** Run stops it
  too, because it would widen the known set and hide the very ghost this looks for.
- [C4] `worktree rm` also tries to delete the branch. Orca keeps any branch whose changes
  it cannot prove are already merged, so a surviving branch is a signal, not a failure.
  Do not add `--force` unless the user has looked at the dirty files and accepted losing
  them.
- [C5] The dispatch record under `.dispatch/<slug>` holds the only local copy of the request
  and the worker's result, so it is offered only once that task's work is merged, and only when
  the status dir really is a dispatch record directly inside `.dispatch`. Until then it holds
  the only copy of what was asked and what came back, and losing it loses the way to inspect or
  resume by hand.

## Step 6: Ask once, then run what the user approves

Step 5 decided. This step asks and executes. It derives no decision of its own: `run` executes
only an offer the plan holds, and nothing the plan does not hold. **This is where the worker's
terminal is released**, so closing the session is one of the actions the user approves, never a
side effect of deciding.

[C6] The ask and the run:

- If the plan offers no cleanup command for any task, there is nothing to approve — [C1]'s
  inspection command is not one. Tell the user what is being kept and why, using the reasons
  Step 5 already printed, and stop. Do not ask.
- Ask one question per task, with the task's slug as the question header, and offer only the
  actions Step 5 printed for that task: its terminals, its worktrees, its dispatch record. A
  task for which Step 5 printed nothing — a stopped task included — is left out of the question
  entirely; say what is being kept for it and why.
- `AskUserQuestion` takes at most four questions. If the user approved more than four tasks
  in Step 1, ask a single question instead whose options are "every task's terminals",
  "every task's worktrees" and "every task's dispatch records", and offer an option only when
  Step 5 printed that action for at least one task.
- Never offer an action Step 5 declined to print.
- Selecting nothing is a valid answer. Do not call `run`; leave everything and say what remains.
- The dispatch record holds the ids of the terminal and the worktree. When it is offered
  next to them, say in that option what removing the record while keeping the others costs,
  so the choice is made knowingly.
- Pass each approved action to `run` as `--approve <slug>:<terminal|worktree|record>`, with the
  `plan_file` Step 5 printed. For the single-question form, pass the chosen action once for
  every task that offers it.

```bash
: "${PLUGIN:?run the block at the top of this file first}"
# One --approve per approved action; the plan file is the plan_file line Step 5 printed.
node "$PLUGIN/bin/orca-cleanup.ts" run --plan "<plan_file printed by Step 5>" \
                                       --approve "<slug>:<terminal|worktree|record>"
```

What `run` does, so you can report it truthfully:

- It runs the approved actions task by task in slug order, and within a task in this order:
  terminal, then worktree, then dispatch record. The terminal action is the
  `worker-release` Step 5 printed — that is what ends the worker's session. Orca does not
  let go of a worktree whose terminal is still open, and the record is the last thing to
  lose.
- It runs each one exactly as Step 5 printed it, from the plan file: it never retypes a handle
  or a worktree id, never adds `--force`, and never substitutes a selector. A plan whose
  argv or offered targets differ from the expected form and that task's recorded roles is
  refused as a whole. `run` also checks a record's path and merged state before removing it.
  An `--approve` the plan does not offer is a usage error (exit 2), and then nothing runs.
- It checks the receipt of each Orca command: it counted only when `.ok == true`. On anything
  else it stops that task there, reports what did not happen, and leaves the rest of that task
  in place. A failure never authorises the step after it, and a failure in one task never
  authorises skipping ahead in another; the other tasks still run.
- **`.ok == true` is not enough for the terminal action.** Measured against a real runtime,
  `worker-release` answers `ok` while releasing nothing when Orca considers the terminal
  user-owned: the state still reads `releaseState: retained` with
  `retainedReason: user_takeover`. `run` reads the state back from `orchestration worker-list`
  before it says the session was closed. A terminal kept for `user_takeover` is not a failure to
  stop on — the worktree step still proceeds — but it is reported as kept, never as closed. Any
  other answer is that task's failure, so its worktree and record stay: a state that cannot be
  read back, a worker Orca no longer lists, a release still pending or unknown, or a terminal kept
  for any other reason.
- It removes a dispatch record only after checking again that it is a dispatch status directory
  directly inside `.dispatch`.
- It finishes by printing, per task, what was removed and what was kept. Exit 0 means every
  approved action ran; exit 1 means at least one failed, and the output names it and what it
  left undone; exit 2 is a usage error. Report that per task to the user.

## Known limitations

State these when they apply. Do not work around them silently.

| Limitation | What the user does |
|---|---|
| Cleanup never runs on its own | Answer the Step 6 question; only what you approve is removed, and anything you decline stays |
| Recovery is never automatic; you decide when to run it | `orca-recover.sh` (Step 3) decides per role and acts only when you run it without `--dry-run`. Inspect with `$ORCA_BIN orchestration task-list --run <run_id> --json` and `$ORCA_BIN orchestration worker-show --dispatch <id> --json`, then clean up as in Step 5 and Step 6 |
| If a worker stops without reporting, waiting times out for the whole set | Same inspection; the state is on disk under `.dispatch/<slug>/`, one directory per task |
| A worker asks a person only when its `design_mode` told it to, and it blocks until you answer | Under `direct` and `plan` it is told to fail with a reason in `result.md` instead; read it and dispatch again. Under `brainstorm` it uses `orchestration ask`, the wait exits 6 with the question and the `reply` command, and the worker resumes only once you run that command |
| A worker that is sent back for remediation retries in the same session, and this skill does not cap those rounds | Watch the wait's output: each remediation is logged with its reason. A worker that cannot satisfy the check will keep being sent back until it fails or the wait times out |
| Review stops after two rounds | The role being reviewed records the unresolved findings in `result.md` and keeps the best version it has. Read that section before integrating |
| The account each agent signs in as cannot be chosen | Orca's CLI has only `account add` and `account list`; nothing selects the active account. Switch it in the Orca app, and read the current one with `$ORCA_BIN account list --json` |
| Setup hooks do not run unless you ask for them | Set `setup` to `run`. A worktree whose setup failed never gets a worker, so a failure shows up as a refusal to start rather than as a confusing result |
| A pull request is opened, never merged or reviewed by this skill | Review and merge it yourself. The issue closes when the pull request merges, not when the run ends |
| A reviewer's verdict can be refused delivery, leaving the work unreviewed | Measured 2026-09-12 in two runs out of three: the reviewee stopped waiting and settled, so its dispatch no longer accepted the verdict and `orca-send.ts` reported it undelivered. The findings file stays on disk, which is why neither the wait nor Step 4 counts that file as a review — both read `sent.json` for the delivery. The wait says `accepted UNREVIEWED`, and Step 4 refuses to merge until you pass `--allow-unreviewed` |
| Nothing restarts the wait, and nothing announces that it stopped | It is resident for up to 24 hours, so the host may stop it — measured twice when a worker's own tests exhausted the machine's memory. Read `wait.json` (Step 3), or run `orca-recover.sh`, which says so before deciding anything. Restarting is always safe; detaching it with `setsid` keeps it alive but sends its exit codes nowhere |
| A new worktree is not cut from the parent checkout's current HEAD | `worktree create` takes no base, so Orca chooses one: measured 2026-09-12, a worktree created after an earlier task had been merged still started from the pre-merge base, and building there means working without changes that are already in. Step 2 fast-forwards a worktree **it created** to the parent's HEAD and says so, and refuses to start at all when the two histories are unrelated. A reused worktree is left alone, because moving it could undo work in progress |
| A wait notices a new stage only once a message from it arrives | It reloads `workers.json` on the first message naming a dispatch it does not know, so Step 3.5 needs no restart. Until that first message the new roles are missing from its progress lines, which is not a sign that the stage failed to start |
| A worker may be unable to obtain its own review wait | Measured 2026-09-11: `exec` reported that its review wait could not start because Orca had an already-active actionable waiter for the Run, so it offered its work with no verdict. Workers are now told that this refusal means the mailbox is busy, not that review is unavailable, and to run the wait again. When it still ends up unreviewed the wait names it: `accepted UNREVIEWED` in its log, and `review=unreviewed` on that role's final line |
| `phase_b=on` needs its second stage started by hand, and a wait missing it fails silently | Step 3.5 starts it. A wait whose `integration_role` never writes a `status.json` keeps polling for 24 hours with nothing in its log and every started worker already finished; check `roles/<integration_role>/status.json` before concluding a worker is stuck |
| `phase_b=on` costs a second worker and a second worktree per task | Leave it off unless separating planning from building is worth that. The plan is kept at `.dispatch/<slug>/plan.md` either way it is written |
| An `--issue` run does not resume by itself after a crash | The next run's `reconcile` finds the claim, releases it when nothing is running, and stops the run when something might be |
| A slow issue holds up the rest of its batch | The wait is per batch. Use a smaller batch size when one issue is expected to be long |
| A released worker can stay recorded as `retained`, which makes [C7] stop a later dispatch on the same Run | Measured twice: `worker-release` answers `ok` while the receipt keeps `releaseState: retained` with `retainedReason: user_takeover`, and the record survives the terminal itself. Removing the worktree closes the terminal with it — `$ORCA_BIN worktree rm --worktree "id:<worktree id>"` succeeded where the release did not (measured 2026-09-11), so offer that in Step 6 for that task. Otherwise start a fresh Run rather than reusing one whose dispatches are gone; [C7] is scoped to a Run, so a new Run is unaffected |
| A batch this version cannot handle stays unacknowledged and blocks its parent terminal's queue | Do not acknowledge it. Inspect `received.json` and `result.md`; guarded manual integration does not unblock that queue. Start later dispatches from another Orca terminal, whose `ORCA_TERMINAL_HANDLE` is used at launch |
| A dispatch Orca reports as `release_pending` or `release_unknown` is never cleaned up | [C1] stops that task. Leave its terminal, worktree and record alone and inspect it with `$ORCA_BIN orchestration worker-show --dispatch <id> --json`; `release_pending` may settle by itself, `release_unknown` needs a decision |
| Failure and edge receipt fixtures are partly simulated | The real E2E now proves the success path for one worker and for a reviewed pair, plus real `check` wait/ack, `worker-release` alternate-state, and terminal/worktree cleanup receipts. **Failure and rejection receipts are still simulated**; capture them before relying on the paths that consume them |
| A stalled task is only reported; nothing stops it unless you say so | Workers wait with no time limit. The wait exits 8 after two hours without progress, and Step 3 asks you whether to keep waiting or stop a role. An `--issue` run only records it in `stall.json` and keeps waiting |

## State on disk

One `.dispatch/<slug>/` per task: `request.md`, `run.json`, `workers.json`, `received.json`,
`integration-result.json`, `wait.json` (the stamp the wait leaves each round),
`sent.json` (one entry per message this task actually delivered), `stall.json` (when the
task was found stalled, and when the user chose to keep waiting), `human.json` (the last time
the wait saw a role waiting on a person), and
`roles/design/{status.json,result.md}`, plus `roles/<role>/stopped.json` for a role the user
stopped, and `spec.md` / `plan.md` when a `brainstorm` design wrote them. Tasks of one Run carry
the same `run_id` in `run.json` and their own worktree in `workers.json`, whose `roles` map
holds one entry per role so a later stage can add more without moving anything. Step 5 writes
`.dispatch/cleanup-<run_id>.json` next to them: Step 6's `run` executes only the offers in that
plan. Everything
needed to resume or clean up by hand is here. `.dispatch/` is added to the repository's
`info/exclude`, so it never shows up in the user's `git status`.
