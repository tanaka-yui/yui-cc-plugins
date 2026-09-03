---
name: cmux-team-dispatch-task
description: >
  Orchestrate parallel execution of multiple tasks via cmux workspaces.
  Each task gets its own git worktree + Claude Code session. The parent
  session acts as orchestrator, monitoring all child sessions. Dynamically
  discovers available agent types from .claude/agents/ and passes the list
  to child sessions, which select the appropriate agent themselves.
  Dispatches immediately without parent-side planning — each child handles its
  own brainstorming/planning in parallel.
  Use when: "parallel execution", "team dispatch", "run these at once",
  "run these in parallel", "dispatch tasks", "execute these simultaneously",
  or when 2+ independent tasks need concurrent execution.
argument-hint: "<task1>, <task2>, ... [--loop] [--setup] [--reset [runners|config|all]] [--override]"
---

## Output Language

All user-facing questions, option labels, tables, and progress reports MUST be
rendered in Japanese. This file is written in English for consistency; it does
not change the language presented to the user.

# Team Dispatch

Orchestrate parallel task execution across multiple Claude Code sessions. Each task runs
in its own isolated git worktree while the parent session coordinates everything.
Dispatches immediately — no parent-side planning. Each child session handles its own
brainstorming and planning in parallel.

For the Japanese reference guide, see `references/guide-ja.md`.

---

## Display Format Conventions

**MUST USE these box drawing tables for all task list / status / progress / final summary output.** Do not improvise wording or layouts — every dispatch should look the same to the user.

Rules:

- Always use box drawing characters `─ ┼ │ ┌ ┐ └ ┘ ├ ┤ ┬ ┴`. ASCII (`-`, `+`, `|`) is forbidden.
- Column widths are fixed (see templates). Truncate long values with a center ellipsis `…`.
- Status values are limited to: `launched`, `executing`, `done`, `error`.
- Header rows and fixed token values are NOT translatable. Keep the column headers (`#`, `Task`, `Surface`, `Mode`, `Status`, `Last message`, `Duration`, `Strategy`, `Result / PR`) and the `Mode` / `Status` tokens exactly as written above. The "render output in Japanese" rule applies only to the free-text cells (task names, messages, results) — a translated header would insert full-width characters and break the fixed column alignment.
- Embed Template B verbatim into child session prompts so children also report progress in the same shape.

### Template A — Pre-launch task list (Step 1h)

```
┌────┬──────────────────────────┬──────────┬────────────┬──────────────┐
│ #  │ Task                     │ Surface  │ Mode       │ Strategy     │
├────┼──────────────────────────┼──────────┼────────────┼──────────────┤
│ 1  │ login-page-ui            │ surf:5   │ superpwr   │ PR per task  │
│ 2  │ auth-api-endpoint        │ surf:7   │ plan       │ PR per task  │
│ 3  │ test-coverage            │ surf:9   │ superpwr   │ PR per task  │
└────┴──────────────────────────┴──────────┴────────────┴──────────────┘
```

### Template B — Live progress table (Step 3 reporting)

```
┌────┬──────────────────────────┬──────────┬────────────┬───────────┬─────────────────────────┐
│ #  │ Task                     │ Surface  │ Mode       │ Status    │ Last message            │
├────┼──────────────────────────┼──────────┼────────────┼───────────┼─────────────────────────┤
│ 1  │ login-page-ui            │ surf:5   │ superpwr   │ executing │ implementing routes…    │
│ 2  │ auth-api-endpoint        │ surf:7   │ plan       │ done      │ PR: https://…           │
│ 3  │ test-coverage            │ surf:9   │ superpwr   │ error     │ jest config not found   │
└────┴──────────────────────────┴──────────┴────────────┴───────────┴─────────────────────────┘
```

### Template C — Final summary (after all tasks reach terminal state)

```
┌────┬──────────────────────────┬──────────┬────────────┬───────────┬─────────────────────────┐
│ #  │ Task                     │ Duration │ Mode       │ Status    │ Result / PR             │
├────┼──────────────────────────┼──────────┼────────────┼───────────┼─────────────────────────┤
│ 1  │ login-page-ui            │ 12m34s   │ superpwr   │ done      │ https://github.com/…    │
│ 2  │ auth-api-endpoint        │ 08m02s   │ plan       │ done      │ https://github.com/…    │
│ 3  │ test-coverage            │ 04m11s   │ superpwr   │ error     │ jest config not found   │
└────┴──────────────────────────┴──────────┴────────────┴───────────┴─────────────────────────┘
```

Mode column abbreviation: `superpwr` = superpowers (brainstorming), `plan` = built-in /plan mode.

---

## Loop Mode (automatic GitHub issue loop)

Only triggers on `--loop` or an explicit request to process issues automatically until
exhausted. When triggered, follow [`references/loop-mode.md`](references/loop-mode.md).
Before a normal dispatch and before cleanup, run
`scripts/issue-fetch.sh --state-file .dispatch-loop/loop-state.json lock-check`; if
`.dispatch-loop/loop.lock.d` is live, do not start or run bulk cleanup.

The loop prompt is generated by `scripts/render-loop-prompt.sh` from the fixed wording in
`references/unattended/`. Do not assemble it by hand. Pass the resolved design, optional
review, and execution runner/engine fields; the renderer does not infer one role from
another. An unattended task whose four roles are all codex creates no claude pane. Timeout sentinels and final cleanup target only the role panes
recorded in `prewarm.json`.

## Setup Mode (explicit configuration)

Only triggers on `--setup`. Dispatches nothing and delegates the complete workflow to
[`references/setup-mode.md`](references/setup-mode.md).

## Reset Mode (configuration reset)

Only triggers on `--reset` and delegates to
[`references/setup-mode.md`](references/setup-mode.md). `--reset config` removes the two
owned keys, `runner` and `review_mode`; `--reset all` removes both configuration layers.

## Override Mode (per-task temporary override)

`--override` takes no value. It makes this dispatch — and only this dispatch — ask, per
task, which of the design / design-review / execution / execution-review roles should run
on a different runner, model, or effort than the resolved configuration says. **It never writes to either config file**;
there is no persistence path, by design.

`--override` is mutually exclusive with `--loop`, `--setup`, and `--reset`. The `--loop`
case is structural rather than a policy choice: an unattended issue loop has nobody to
answer the questions. If more than one is given, stop with an error naming both. Like
`--setup` and `--reset`, `--override` must never reach Step 1a's task parsing.

## Step 1: Parse and Prepare

This single step handles task collection, agent routing, integration strategy, and runtime
resolution. Role resolution and review mode come only from configuration; there is no
dispatch-time question for either. There is no message-transport question — see 1g.

### 1a. Collect Tasks

If `$ARGUMENTS` is empty or not provided, ask the user what tasks to run:

> What tasks would you like to run in parallel?
> You can specify:
>
> - Plan file paths (e.g., `.claude/plans/feature-a.md`)
> - Task descriptions (e.g., "Implement login page UI")
> - Separate multiple tasks by newline or comma

If `$ARGUMENTS` is provided, parse the input into a task list:

- First strip the mode flags — `--loop`, `--setup`, `--reset [target]`, and `--override`
  — from `$ARGUMENTS` before splitting, so no task text or slug can ever carry one
- Split on commas or newlines
- Paths ending in `.md` inside `.claude/plans/` are recognized as plan file references
- Each task gets a short slug name derived from its description (lowercase, hyphens, max 30 chars)

### 1b. Discover Available Agents (automatic)

Scan `.claude/agents/` to find available agent definitions:

```bash
ls .claude/agents/*.md 2>/dev/null
```

For each `.md` file, read YAML frontmatter to extract `name` and `description`.

Build a reference list of all discovered agents (name + description). This list will be
embedded in each child task's prompt so that **each child session decides which agent
to follow** based on its own task content. The parent does NOT assign agents to tasks.

If `.claude/agents/` is empty or doesn't exist, omit the available agents block from prompts.

### 1c. Select Brainstorming Tasks

Present the task list and ask the user which tasks should use the brainstorming skill:

> Tasks to dispatch:
>
> 1. login-page-ui
> 2. auth-api-endpoint
> 3. test-coverage
>
> Available agents: backend-coding, frontend-coding
> (Each child session will select the appropriate agent)
>
> Which tasks should use the brainstorming skill before planning?
> Select task numbers, "all", or "none".

Based on the selection:

- **Selected tasks** → launched with `--mode superpowers` + MANDATORY EXECUTION SEQUENCE directive
- **Non-selected tasks** → launched with `--mode plan` (Claude built-in `/plan` mode)

### 1d. Layout

The layout is always `workspace`: every task gets its own cmux workspace
(sidebar entry). There is no layout-selection flag.

### 1e. Select Integration Strategy

Ask the user how completed tasks should be integrated:

> How should completed tasks be integrated?
>
> 1. **PR per task** — Each child task pushes its branch and creates a GitHub PR when done. Parent monitors PR status.
> 2. **Wait and merge** (default) — Parent waits for all tasks to finish, then merges worktree branches locally.

Based on the selection:

- **PR per task** → child prompts include push + `gh pr create` instructions in the status protocol
- **Wait and merge** → current behavior (local merge after all tasks complete)

### 1f. Resolve Roles

Every role is fixed by configuration. There is no interactive resolution at dispatch time.

config-lib.sh is source-only — running it produces no output. Source it and call its
functions:

    . <SKILL_DIR>/scripts/config-lib.sh
    RUNNERS_FILE="$(dispatch_runners_file)"
    [[ -f "$RUNNERS_FILE" ]] || run_first_run_setup   # see First-run setup below, then continue

    ROOT="$(git rev-parse --show-toplevel)"
    ROLES_JSON="<STATUS_DIR>/roles.json"
    mkdir -p "$(dirname "$ROLES_JSON")"

    # Keep the resolver's exit code. || exit 1 would flatten 2 into 1 and make the
    # run --setup branch below unreachable.
    RESOLVE_RC=0
    bash <SKILL_DIR>/scripts/config-resolve.sh --project-root "$ROOT" > "$ROLES_JSON" \
      || RESOLVE_RC=$?
    case "$RESOLVE_RC" in
      0) ;;
      2) echo "[error] a role is unconfigured: $(cat "$ROLES_JSON" 2>/dev/null)" >&2
         echo "        run this skill with --setup to fix the configuration" >&2
         rm -f "$ROLES_JSON"; exit 1 ;;
      *) echo "[error] config-resolve.sh failed (rc=$RESOLVE_RC); the configuration could not be read" >&2
         rm -f "$ROLES_JSON"; exit 1 ;;
    esac

Exit 2 means a role has no usable runner, or a codex review role has no model — a
configuration error the user must fix. Any other non-zero means the resolver itself failed
(unreadable file, broken JSON). Keep the two on separate branches: the first names a fix,
the second does not. Create no panes on either.

Read every role value from $ROLES_JSON. Do not re-derive them anywhere else. The canonical
placeholders passed into task prompts are:

| role | runner / engine | model / effort | agent |
|---|---|---|---|
| design | {{DESIGN_RUNNER}} / {{DESIGN_ENGINE}} | {{DESIGN_MODEL}} / {{DESIGN_EFFORT}} | task slug |
| design_review | {{DESIGN_REVIEW_RUNNER}} / {{DESIGN_REVIEW_ENGINE}} | {{DESIGN_REVIEW_MODEL}} / {{DESIGN_REVIEW_EFFORT}} | {{DESIGN_REVIEW_AGENT}} |
| exec | {{EXEC_RUNNER}} / {{EXEC_ENGINE}} | {{EXEC_MODEL}} / {{EXEC_EFFORT}} | task-slug-exec |
| exec_review | {{EXEC_REVIEW_RUNNER}} / {{EXEC_REVIEW_ENGINE}} | {{EXEC_REVIEW_MODEL}} / {{EXEC_REVIEW_EFFORT}} | {{EXEC_REVIEW_AGENT}} |

The review placeholders exist only when their role key exists in the resolved JSON.
REVIEW_ENABLED is derived only from the resolver output:

    REVIEW_ENABLED=false
    [[ "$(jq -r '.review_mode' "$ROLES_JSON")" == on ]] && REVIEW_ENABLED=true

The runner registry contains identity and engine only. Model and effort belong to
configuration, not to runner records:

    {
      "default": "claude",
      "runners": [
        {"name":"claude","command":"claude","engine":"claude"},
        {"name":"codex","command":"codex","engine":"codex"}
      ]
    }

The default field is read only by First-run setup. Normal dispatch resolution never reads
it. launch-workspace.sh receives --role design, --role design_review, --role exec, or
--role exec_review together with the already-resolved runner/model/effort. Claude effort
is low, medium, high, xhigh, or max; Codex effort is minimal, low, medium, high, or xhigh.
A codex design_review or exec_review tuple must contain a model.

**First-run setup.** If runners.json is absent, ask whether to use the starter registry or
build a custom registry. A runner record contains only name, command, and engine; write
only those records plus default. Do not write role-specific model or effort fields into
runners.json.

After writing runners.json, normal setup asks once whether review_mode is on or off and
creates the initial global config. Set runner.<role>.runner to runners.json default for
all four roles. Omit every runner.<role>.model and runner.<role>.effort so the built-in
defaults apply. If the default runner uses the codex engine, ask for the design_review and
exec_review models together in one AskUserQuestion call and write those two model fields;
without them the first resolve would fail fast. If the default uses claude, do not ask for
models. Apply the whole initial config in one config-edit.sh call so unrelated keys survive.

When First-run setup was entered from --reset runners, it is in reset mode: rebuild only
runners.json. Do not ask about review_mode and do not write either project or global
config.json.

### 1g. Resolve Delivery and Review Mode

agmsg is a hard requirement. There is no degraded transport and no typing fallback.
Before any pane is launched, require ~/.agents/skills/agmsg/scripts/send.sh and verify that
this session can actually receive. Do NOT branch on the parent engine here: `--parent` makes
that choice inside the script, which is what keeps a codex parent from being handed a
`--self` call it can only answer with rc=2.

```bash
# Capture the verified path into AGMSG_SEND and pass THAT to every later callsite.
# Checking existence without binding the path leaves $AGMSG_SEND unset, which expands
# to an empty string and makes helpers that require a non-empty --send-command exit 2.
AGMSG_SEND=~/.agents/skills/agmsg/scripts/send.sh
[[ -f "$AGMSG_SEND" ]] || {
  echo "[error] agmsg is not installed; this skill cannot dispatch without it"
  exit 1
}

# The reachability question is keyed by team, so resolve it first.
TEAM="dispatch-$(basename "$(git rev-parse --show-toplevel)")"

READY_RC=0
READY_OUT=$(bash <SKILL_DIR>/scripts/verify-agmsg-ready.sh --parent --team "$TEAM") || READY_RC=$?
case "$READY_RC" in
  0) ;;
  # Branch the ADVICE on the reason the script returned, never on the engine. The reason
  # is the script's answer; the engine is a guess the call site is not allowed to make.
  1) case "$READY_OUT" in
       *reason=no-seat*)
         echo "[error] this codex session has no agmsg seat recorded as parent; record it with"
         echo "        ~/.agents/skills/agmsg/scripts/drivers/types/codex/codex-record-session.sh $TEAM parent" ;;
       *)
         echo "[error] this session has no live agmsg watcher -- the Monitor tool must be running"
         echo "        (SessionStart hook asks for it; /clear re-fires that hook)" ;;
     esac
     exit 1 ;;
  *) echo "[error] agmsg readiness is UNDETERMINED (verify-agmsg-ready.sh usage error, rc=$READY_RC)"
     echo "        a usage error says nothing about the channel -- fix the call, then re-check"
     exit 1 ;;
esac

# sharing= counts other watchers receiving for this project's unclaimed roles. The read
# cursor is one per (team, agent), so whoever polls first takes the row and the others see
# nothing -- and the row is then marked read, so inbox.sh truthfully answers "nothing new".
# This never changes reachability, so it warns and does not stop. Report only a positive
# count: unknown means the question could not be answered, which is not evidence of a
# conflict, and a warning printed every time is a warning nobody reads.
SHARING="${READY_OUT##*sharing=}"
if [[ "$SHARING" =~ ^[1-9][0-9]*$ ]]; then
  echo "[warn] $SHARING other agmsg watcher(s) receive for this project's unclaimed roles;"
  echo "       a message addressed to parent reaches whichever of us polls first"
fi
```

**Only a claude parent has a safety timer.** It arms one single-shot 90-minute sleep,
never a polling loop. A codex parent has no persistent Bash timer -- a backgrounded
subshell and its detached nohup form were both measured on 2026-08-21 (D-T2) and both die
with the turn -- so it arms nothing and must never claim otherwise. This is the ONLY place
that fact is stated; everything downstream says "the parent's timer" and means "if there
is one". Unattended dispatch is refused from a codex parent for exactly this reason: an
unattended run with no backstop has nobody to notice it stopped.

**Delivery contract.** Every message is exactly one send.sh call with four positional
arguments: team, sender agent, recipient agent, and one quoted body. The destination is an
agmsg agent name, never a cmux surface or workspace. A non-zero exit means the message was
not delivered. There is no outbox, heartbeat, polling loop, length split, resend loop, or
type-input fallback.

| body prefix | purpose |
|---|---|
| phase-a-task: | parent to design |
| phase-b-exec: | design to exec |
| review-plan: | design to design_review |
| review-code: | exec to exec_review |
| review-verdict: | review role to requester |
| abort-reviewer: | requester to review role |
| dispatch-notify: | child completion or unbacked wait notice |

Join the parent before launch. The agmsg driver type is the one remaining value that
depends on the parent engine, so derive it here, where it is used, and nowhere else:

    PARENT_ENGINE=claude; [[ -n "${CODEX_THREAD_ID:-}" ]] && PARENT_ENGINE=codex
    PARENT_AGMSG_TYPE=$(bash <SKILL_DIR>/scripts/resolve-agmsg-type.sh --engine "$PARENT_ENGINE") || exit 1
    "$AGMSG_DIR/join.sh" "$TEAM" parent "$PARENT_AGMSG_TYPE" "$(pwd)" >/dev/null 2>&1 || true

**Then claim the `parent` identity, before a single pane is launched.** The Monitor your
SessionStart hook started is *unfiltered*: it subscribes to every agent registered for this
project that nobody has claimed, and the read cursor is one per (team, agent). Any other
session open in this checkout therefore consumes `[ready]` and `dispatch-notify:` rows
addressed to `parent`, and once a row is taken it is marked read — `inbox.sh` will truthfully
answer "nothing new" while the message sits in the DB, unseen. This was measured on
2026-08-22, not theorised.

    # claude parent only. A codex parent has no watch.sh to re-arm; it receives through its
    # bridge seat, so there is nothing to claim here.
    if [[ "$PARENT_ENGINE" == claude ]]; then
      CLAIM=$("$AGMSG_DIR/actas-claim.sh" "$(pwd)" claude-code parent "$CLAUDE_CODE_SESSION_ID" 2>&1) || true
      case "$CLAIM" in
        *status=ok*) ;;
        *status=held*)
          echo "[error] another live session already holds the parent identity for $TEAM:"
          echo "        $CLAIM"
          echo "        two dispatches cannot share one parent in the same repository --"
          echo "        finish or stop the other one, then retry"
          exit 1 ;;
        *) echo "[warn] could not claim the parent identity ($CLAIM); continuing unclaimed --"
           echo "       messages addressed to parent may be consumed by another watcher" ;;
      esac
    fi

When the claim succeeds, **re-arm your own Monitor with the name**: `TaskStop` the watcher task
the SessionStart directive started, then invoke Monitor again with the same command plus
`parent` as a fourth argument. The claim alone changes nothing for an already-running watcher —
a watcher started without a name stays unnamed for its whole life.

Doing this here, and only here, is what makes it safe: no pane exists yet, so there is no
in-flight message to drop while the channel is swapped. **Never re-arm the parent's Monitor
once panes are running.**

A `held` result is fail-closed on purpose. Two dispatches in one repository already share the
single `parent` name today and silently eat each other's notifications; refusing the second one
turns that into a visible error. A crashed dispatch does not block the next: `actas_lock_state`
reports a dead owner as free (`actas-lock.sh:243`).

prewarm-panes.sh joins and wires all child roles. The four agent names are the task slug
for design, then task-slug-design-review, task-slug-exec, and task-slug-exec-review.
Every launched pane must first follow its SessionStart Monitor directive (Claude) or call
codex-record-session.sh (Codex), then send exactly [ready] <agent> to parent. Wait for the
expected readiness messages before delivery.

**A `[ready]` line is not readiness on its own.** For a Codex role it proves the pane took a
turn, not that anything can reach it: `codex-record-session.sh` exits successfully on its
best-effort no-op paths, so a pane can report ready with no agmsg bridge seat, and every
later `send.sh` then succeeds while the message sits unread. Do not judge this by hand and do
not derive `NOT_READY` yourself. Ask the script, which checks both conditions for every role:

    NOT_READY=()
    READY_ARGS=()
    for role in "${REPORTED_READY[@]}"; do READY_ARGS+=(--ready "$role"); done
    RR_RC=0
    while IFS= read -r role; do
      [[ -n "$role" ]] && NOT_READY+=("$role")
    done < <(bash <SKILL_DIR>/scripts/verify-roles-ready.sh \
      --prewarm "<EXISTING_STATUS_DIR>/prewarm.json" --team "$TEAM" \
      ${READY_ARGS[@]+"${READY_ARGS[@]}"}) || RR_RC=$?
    if [[ "$RR_RC" -ne 0 ]]; then
      echo "[error] a required role is not reachable; see the reasons above. Stopping." >&2
      exit 1
    fi

`verify-roles-ready.sh` prints the unreachable roles and explains each on stderr. It exits 1
when `design` or `exec` is unreachable, so the required-role fail-closed rule is enforced by
the script rather than by remembering a paragraph — that is the whole point of it existing.
This check used to live only in prose here, and on 2026-08-22 it was skipped: a dispatch ran
with Codex panes that had no seat, and the `review-plan:` messages sent to them were never
read. Review readiness stays local to its gate: a missing `design_review` skips Phase A-R and
a missing `exec_review` skips Phase B-R. Do not rewrite config.

prewarm.json records launch success, not readiness. Feed the list straight into the
fail-closed pruning helper:

    PRUNE_ARGS=()
    for role in ${NOT_READY[@]+"${NOT_READY[@]}"}; do PRUNE_ARGS+=(--role "$role"); done
    if [[ ${#PRUNE_ARGS[@]} -gt 0 ]]; then
      bash <SKILL_DIR>/scripts/prune-not-ready.sh \
        --prewarm "<EXISTING_STATUS_DIR>/prewarm.json" --workspace "$WS" \
        --team "$TEAM" --slug "<slug>" "${PRUNE_ARGS[@]}" || exit 1
    fi

`prune-not-ready.sh` reads and validates one snapshot, rejects unsafe or duplicate
surface IDs and workspace disagreement, verifies that every target is still owned by the
workspace, and only then closes the optional surfaces, leaves their team members, and
publishes the pruned snapshot. It never accepts design or exec. The order is fixed:
prewarm launch, ready collection, prune-not-ready.sh, then rendering, review gating, and
delivery. After pruning, a role key exists if and only if that role is usable.

Phase A-R always reuses design_review at both the spec and plan checkpoints. Phase B-R
always uses exec_review. The design session never becomes a reviewer; after delegating
Phase B it always touches .deferred and exits. The generated Phase B prompt contains no
AskUserQuestion and always delegates to the configured exec pane.

Do not implement the Phase B-R gate inline. Pass the ready-role set to review-gate.sh.
Its stdout is either empty or the canonical review-config path; it is never a launcher
argument list:

    READY_ARGS=()
    for role in "${READY_ROLES[@]}"; do READY_ARGS+=(--ready "$role"); done
    REVIEW_CONFIG_PATH=$(bash <SKILL_DIR>/scripts/review-gate.sh \
      --prewarm "<EXISTING_STATUS_DIR>/prewarm.json" "${READY_ARGS[@]}" \
      --status-dir "<EXISTING_STATUS_DIR>" --slug "<slug>" --team "$TEAM" \
      --reviewer-workspace "$WS") || exit 1

Embed that exact value as the `REVIEW_CONFIG_PATH` literal in the generated design task
prompt; do not rely on a parent-shell variable being inherited by the child.

Only review-gate.sh may write review/code-review.json. It emits the path only when
exec_review exists in the validated snapshot and was passed as ready. It validates strict
`workspace:<digits>` / `surface:<digits>` identifiers, workspace agreement, unique role
surfaces, the canonical non-symlink review directory, and a final regular JSON file.
Otherwise it emits no stdout and no file, so Phase B does not wait for an unreachable
verdict. Pass the path to phase-b-deliver.sh exactly as shown in Phase B delivery below;
never pass it to launch-workspace.sh.

Append the following to every child prompt. This is the mandatory completion layer; the
runner wrapper exit notification is only a backstop because an idle TUI may never exit:

    You can message the parent directly at any time by calling send.sh once with the
    team, your agent name, parent, and one quoted message.

    Immediately after writing done or error to status.json, send one dispatch-notify:
    message to parent. If send.sh exits non-zero, retry once, then record that failure in
    status.json so the parent sees it when state is re-derived.

### 1g-2. Apply Per-Task Overrides (--override only)

Skip this step unless --override was given. Overrides are in-memory, per-dispatch values;
never call config-edit.sh and never write either config file.

Call 1 asks which tasks should receive overrides. Call 2 asks which roles for each selected
task, with options design, design_review, exec, and exec_review. Present design_review and
exec_review only when review_mode=on for that task.

Call 3 keeps the existing three questions in one call: runner, model, and effort. Treat
the answers as a pending tuple. If the runner changes the engine, revalidate all three
dimensions against the new engine and re-ask only the invalid dimensions. If a re-asked
value is still invalid, discard the entire override for that role; do not partially apply
the other two dimensions.

Before building any command, validate every free-text runner, model, and effort answer.
Reject empty values, leading or trailing whitespace, control characters, apostrophe,
double quote, grave accent, dollar sign, backslash, and exclamation mark, then re-ask.
Do not trim or shell-interpolate an invalid answer.

Always pass pending tuples through override-args.sh. It alone owns the whole-role discard
decision; never build --set arguments inline:

    PENDING=()
    for role in design design_review exec exec_review; do
      eval "sel=\${SELECTED_$role:-}"; [[ -n "$sel" ]] || continue
      for field in runner model effort; do
        eval "v=\${PENDING_${role}_${field}:-}"
        PENDING+=(--pending "$role.$field=$v")
      done
    done

    OVERRIDE_ARGS=()
    if [[ ${#PENDING[@]} -gt 0 ]]; then
      OVERRIDE_OUTPUT=$(mktemp) || exit 1
      OVERRIDE_BUILDER_RC=0
      bash <SKILL_DIR>/scripts/override-args.sh --roles "$ROLES_JSON" \
        ${PENDING[@]+"${PENDING[@]}"} > "$OVERRIDE_OUTPUT" || OVERRIDE_BUILDER_RC=$?
      if [[ $OVERRIDE_BUILDER_RC -ne 0 ]]; then
        rm -f "$OVERRIDE_OUTPUT"
        echo "[error] override validation failed; refusing to continue with silent defaults" >&2
        exit "$OVERRIDE_BUILDER_RC"
      fi
      while IFS= read -r -d '' a; do OVERRIDE_ARGS+=("$a"); done < "$OVERRIDE_OUTPUT"
      rm -f "$OVERRIDE_OUTPUT"
    fi

    if [[ ${#OVERRIDE_ARGS[@]} -gt 0 ]]; then
      RESOLVE_RC=0
      bash <SKILL_DIR>/scripts/config-resolve.sh --project-root "$ROOT" \
        "${OVERRIDE_ARGS[@]}" > "$ROLES_JSON.new" || RESOLVE_RC=$?
      if [[ "$RESOLVE_RC" -eq 0 ]]; then
        mv "$ROLES_JSON.new" "$ROLES_JSON"
      else
        rm -f "$ROLES_JSON.new"
        echo "[warn] the override produced an unresolvable configuration; keeping the resolved values" >&2
      fi
    fi

Runner must be present in each selected role's pending tuple because changing it can
change the engine. Empty keep values are ignored by the builder. Re-read all downstream
placeholder values from the newly resolved roles JSON; do not mutate the original config.

### 1h. Display Summary and Proceed

Print an informational summary using **Template A** (see "Display Format Conventions" above) and proceed to launch immediately. Do NOT free-form the layout.

```
Dispatching 3 tasks (workspace mode, PR per task):

┌────┬──────────────────────────┬──────────┬────────────┬──────────────┐
│ #  │ Task                     │ Surface  │ Mode       │ Strategy     │
├────┼──────────────────────────┼──────────┼────────────┼──────────────┤
│ 1  │ login-page-ui            │ pending  │ superpwr   │ PR per task  │
│ 2  │ auth-api-endpoint        │ pending  │ plan       │ PR per task  │
│ 3  │ test-coverage            │ pending  │ superpwr   │ PR per task  │
└────┴──────────────────────────┴──────────┴────────────┴──────────────┘

Available agents: backend-coding, frontend-coding
Launching…
```

When `--override` produced any change, print this block immediately after the Template A
table. Do not change the table itself. List only the dimensions that actually changed,
one line per task and role, and include any warning raised in Step 1g-2:

```
Overrides (this dispatch only):
  auth-api  exec    runner codex / model gpt-5.6-terra / effort xhigh
  auth-api  design  effort max
```

Print nothing when no override was applied.

Surface IDs are not yet known at this point; print `pending` in that column. After Step 2 launches, re-print using Template A again with concrete `surf:N` values.

---

## Step 2: Launch Sessions

### Prompt File Approach

The launch script writes the full prompt to a `.cmux-team-dispatch-task-prompt.md` file in each
child's working directory (worktree). The Claude command sent via cmux only references
this file, completely avoiding shell escaping issues with complex prompt content.

### Runner Script Wrapper

The launch script generates a `.cmux-team-dispatch-task-run-<workspace-name>.sh` script in
each role's working directory (worktree). The filename includes the workspace name so the
prewarmed design, review, and exec role wrappers stay isolated when they share one worktree —
overwriting an in-flight runner script causes bash to read undefined content. Instead of
sending `claude ...` directly to the terminal, the launcher
sends `bash .cmux-team-dispatch-task-run-<workspace-name>.sh`, which:

1. Updates `status.json` to `"executing"` using absolute paths
2. Runs the `claude` command interactively
3. After Claude exits (for any reason), writes `"done"` or `"error"` to `status.json`
4. Signals completion via `cmux wait-for --signal <slug>-done`
5. Optionally notifies the parent workspace via `cmux notify`
6. Delivers the `dispatch-notify: [dispatch] task ... finished (status: ...)` text to
   the parent through one agmsg `send.sh` call addressed to the `parent` agent name.
   It is skipped when `--agmsg-team` / `--agmsg-from` were not given, because then this
   pane has no agmsg identity to send from

**Deferred completion (`--defer-status`)**: The design role touches
`<STATUS_DIR>/.deferred` after it successfully delivers `phase-b-exec:`. Its wrapper then
skips the terminal status write. The already-prewarmed exec role owns the final
`done`/`error` transition; Phase B never launches another execute session.

The signal name for each role pane is derived from the workspace name and returned in the
launch output. The prewarmed exec role uses `<task-slug>-exec-done`.

### Building the Task Prompt

Build one prompt from resolved values only. Do not infer an execution or review role from
another role's engine, and do not read config again. The placeholder set is:

| placeholder group | source |
|---|---|
| {{DESIGN_RUNNER}}, {{DESIGN_ENGINE}}, {{DESIGN_MODEL}}, {{DESIGN_EFFORT}} | roles.design |
| {{DESIGN_REVIEW_RUNNER}}, {{DESIGN_REVIEW_ENGINE}}, {{DESIGN_REVIEW_MODEL}}, {{DESIGN_REVIEW_EFFORT}}, {{DESIGN_REVIEW_AGENT}}, {{DESIGN_REVIEW_SURFACE}} | roles.design_review when present |
| {{DESIGN_REVIEW_WORKSPACE}} | validated prewarm workspace_id when design_review is present |
| {{EXEC_RUNNER}}, {{EXEC_ENGINE}}, {{EXEC_MODEL}}, {{EXEC_EFFORT}} | roles.exec |
| {{EXEC_REVIEW_RUNNER}}, {{EXEC_REVIEW_ENGINE}}, {{EXEC_REVIEW_MODEL}}, {{EXEC_REVIEW_EFFORT}}, {{EXEC_REVIEW_AGENT}} | roles.exec_review when present |

The design task runs in the task-slug agent. The execution task runs in task-slug-exec.
Phase A-R requests go only to {{DESIGN_REVIEW_AGENT}}. Phase B-R requests go only to
{{EXEC_REVIEW_AGENT}}.

Every generated task prompt begins with the selected task and the available-agent list,
then states:

    PHASE A — DESIGN
    Use runner {{DESIGN_RUNNER}}, engine {{DESIGN_ENGINE}}, model {{DESIGN_MODEL}}, and
    effort {{DESIGN_EFFORT}}. Complete brainstorming or planning and save the approved
    plan under .claude/plans/.

    PHASE B — EXECUTION
    Do not ask which implementation engine or model to use. Always delegate the approved
    plan to the exec pane named task-slug-exec with one phase-b-exec: message. The request
    states runner {{EXEC_RUNNER}}, engine {{EXEC_ENGINE}}, model {{EXEC_MODEL}}, and
    effort {{EXEC_EFFORT}}. Touch .assigned-task-slug-exec before sending. After a
    successful send, touch .deferred and exit; the design session never implements or
    reviews the code itself.

Before any role lookup, consume prewarm.json through one immutable validated snapshot:

    PREWARM_FILE="<EXISTING_STATUS_DIR>/prewarm.json"
    source <SKILL_DIR>/scripts/prewarm-snapshot.sh
    PREWARM_DOC=$(cat "$PREWARM_FILE") || {
      echo "[error] required prewarm snapshot is missing or unreadable" >&2
      exit 1
    }
    validate_prewarm_snapshot "$PREWARM_DOC" || exit 1
    role_value() {
      jq -r --arg role "$1" --arg field "$2" '.[$role][$field] // empty' <<<"$PREWARM_DOC"
    }
    role_present() {
      jq -e --arg role "$1" 'has($role)' >/dev/null 2>&1 <<<"$PREWARM_DOC"
    }

prewarm.json is mandatory and prewarm is always on in workspace mode. There is no spawn
fallback when the file or a required role is absent. A missing design or exec key is a
fatal snapshot error. Optional review keys may be absent only after launch failure or
readiness pruning.

**Phase A-R.** When design_review is present, reuse its one pane for two checkpoints:
the clarified specification before planning and the completed plan before execution.
For each checkpoint, write the request and findings files under
<EXISTING_STATUS_DIR>/review and send exactly one
review-plan: message to {{DESIGN_REVIEW_AGENT}}. **A review pane never gets an
assignment marker.** Do not touch `.assigned-{{DESIGN_REVIEW_AGENT}}`, or any other
`.assigned-*` for a review role: a review pane is standby, and the runner wrapper reads
that marker as "this pane accepted the task", which makes it report the shared
`status.json` — another role's result — as its own. The reviewer writes a VERDICT line and
sends one review-verdict: message back. On every wake, re-read the findings file. Fix
needs_work findings and repeat for at most five rounds. A Claude waiter may arm one
single-shot safety timer; a Codex waiter has no timer. Reviewer liveness always branches
on {{DESIGN_REVIEW_ENGINE}}: a Codex reviewer uses its bridge seat, while a Claude
reviewer uses {{DESIGN_REVIEW_WORKSPACE}} and {{DESIGN_REVIEW_SURFACE}} with one
`cmux read-screen` retry. If design_review is absent, warn once and skip only Phase A-R.

Before delivering the Phase A task, render the exact wait protocol and append its output
once to the generated design prompt. The waiter engine controls timer availability; the
reviewer engine independently controls liveness:

    PHASE_A_WAIT_PROTOCOL=$(bash <SKILL_DIR>/scripts/phase-a-review-wait.sh \
      --waiter-engine "{{DESIGN_ENGINE}}" --reviewer-engine "{{DESIGN_REVIEW_ENGINE}}" \
      --team "$TEAM" --waiter-agent "<slug>" --reviewer-agent "{{DESIGN_REVIEW_AGENT}}" \
      --reviewer-workspace "{{DESIGN_REVIEW_WORKSPACE}}" \
      --reviewer-surface "{{DESIGN_REVIEW_SURFACE}}" \
      --findings-path "<EXISTING_STATUS_DIR>/review/<point>-round-<N>.md" \
      --review-dir "<EXISTING_STATUS_DIR>/review" \
      --send-command "$AGMSG_SEND") || exit 1

Always append the protocol:

1a. The reviewer writes VERDICT: approve or VERDICT: needs_work to the findings file,
then calls send.sh once with a review-verdict: body addressed to the design agent.
2. Send the request with ONE send.sh call. After a successful send, wait for the push
message and re-read the findings file on every wake. As a Claude session, arm ONE
single-shot safety timer with the Bash tool using run_in_background. As a Codex session,
you have NO safety net. Follow the generated `PHASE_A_WAIT_PROTOCOL`; do not replace its
reviewer-engine-specific liveness command with a waiter-engine assumption. Then send one
dispatch-notify: message to parent when that protocol requires it. Never infer a verdict
from a timer wake.
Act on the verdict: fix needs_work findings and resend, or proceed only on approve.
1b. Append the parallel-review directive generated for {{DESIGN_REVIEW_ENGINE}} to the
request text.

**Phase B delivery.** Phase B always uses the `exec` entry from the validated prewarm
snapshot. Never call `launch-workspace.sh --mode execute` and never create another pane.
Call the delivery helper once. It reads the snapshot once, validates the fixed exec tuple,
uses its verified agent and engine to build the execution and completion directives,
writes the assignment marker, and sends one `phase-b-exec:` message to that prewarmed exec
agent. Pass the gate path to this call, not to a launcher:

    PHASE_B_REVIEW_ARGS=()
    if [[ -n "$REVIEW_CONFIG_PATH" ]]; then
      PHASE_B_REVIEW_ARGS=(--review-config "$REVIEW_CONFIG_PATH")
    fi
    bash <SKILL_DIR>/scripts/phase-b-deliver.sh \
      --prewarm "<EXISTING_STATUS_DIR>/prewarm.json" \
      --plan-file "<PLAN_FILE_PATH>" --status-dir "<EXISTING_STATUS_DIR>" \
      --team "$TEAM" --slug "<slug>" "${PHASE_B_REVIEW_ARGS[@]}" || exit 1

`phase-b-deliver.sh` creates `.deferred` only after its single four-argument send.sh call
succeeds. A send failure is not retried by this ownership layer and leaves `.deferred`
absent. The design pane exits only after helper success.

**This helper is the only way to hand Phase B over. Never hand-write the handoff.** The
Phase B-R wiring — the reviewer's agent name, the review directory, the round-file
convention — exists nowhere else: the helper composes it into the `phase-b-exec:` body, and
a design pane that writes its own handoff message deletes all of it without noticing. Even a
handoff that is otherwise excellent, with the plan, the gates and the order of work spelled
out, leaves the executor unable to learn that a reviewer exists. Measured on 2026-08-31
(`lead-psp-liff`, task `member`): the design pane sent a long hand-written "PHASE B" message
that named no reviewer, carried no `review-code:` procedure, told the executor to report to
`parent` instead, and added that `.dispatch/**` does not exist in the worktree — so the
executor asked `parent` for its code review, the `exec_review` agent received nothing at all
from the moment it joined, and not one `code-round-*` file was ever created, while Phase A-R
had run 55 rounds normally in the same task. `.assigned-<exec agent>`, `.deferred` and the
`executing` status were all absent too, because only the helper writes them. Adding context
in a separate message afterwards is fine; replacing the helper's message is not.

**Phase B-R extension.** A non-empty `REVIEW_CONFIG_PATH` means that exec_review survived
launch and readiness. The helper reads that regular JSON file once, proves that it is in
the canonical review directory and matches the verified exec_review tuple and workspace,
then embeds the following protocol into the actual prewarmed exec request exactly once.
After all changes are committed and BEFORE creating the PR, the implementer sends one
`review-code:` request per round only to the verified exec_review agent. Before that send,
it writes the same request text to `<EXISTING_STATUS_DIR>/review/code-round-N-request.md`,
exactly as Phase A-R does for its checkpoints: the completion gate reads only the disk, so
that file is the sole evidence that the implementer is waiting for a verdict rather than
idling mid-task. The reviewer
writes `<EXISTING_STATUS_DIR>/review/code-round-N.md`; its last line is `VERDICT: approve`
or `VERDICT: needs_work`, followed by one `review-verdict:` send.sh call back to the
implementer. On needs_work, fix valid findings and request the next round; on approve,
continue. Run a maximum of 5 rounds. Do not start round 6; when round 5 still returns
needs_work, record unresolved findings in the PR body and proceed.

Append the same engine-specific final instruction used by the base request: Claude runs
`/exit` after the completion report; Codex stops and stays idle until parent cleanup.

After sending each `review-code:` request, a Claude implementer arms one single-shot
safety timer with the Bash tool using `run_in_background`. A Codex implementer has NO
safety net. If {{EXEC_REVIEW_ENGINE}} is codex, it runs
`verify-agmsg-ready.sh --codex` for {{EXEC_REVIEW_AGENT}}; if it is claude, that reviewer is
reachable by definition after its `[ready]` report and needs no seat check. In either case the
Codex implementer sends one `dispatch-notify:` message to parent before ending the turn. On
every wake, re-read the findings file; a timer wake without a VERDICT is not a verdict. A
missing or pruned `exec_review` omits only Phase B-R and never leaves a `code-review.json` file
behind.

The design pane is never selected as code reviewer. design_review never performs code
review, and exec_review never performs design review. Do not compare engines to choose a
reviewer.

Every child status protocol includes:

    1. Write status.json with executing before work.
    2. On success write result.md and status done; on failure write status error.
    3. Preserve an existing pr_url when rewriting status.json.
    4. Immediately after done or error, call agmsg send.sh once with a
       dispatch-notify: body to parent. Retry once on non-zero and record a second
       failure in status.json.
    5. A delegated design session touches .deferred and must not overwrite the exec
       role's terminal status.

The PR-per-task variant also pushes the branch, creates the PR, and records pr_url. The
wait-and-merge variant leaves the verified branch for the parent to merge.

### Plan-mode Enforcement Hook (ExitPlanMode)

In standard plan mode, a strong system instruction ("execute the plan") arrives right
after ExitPlanMode approval, which can cause the MANDATORY MODEL SELECTION SEQUENCE
(Phase A-R / Phase B) baked into the prompt to be skipped. To prevent this,
`launch-workspace.sh` injects a PostToolUse hook (matcher: `ExitPlanMode`, command:
`zsh <this-skill-dir>/scripts/plan-approved-hook.sh`) into the worktree's
`.claude/settings.local.json` — but ONLY when the mode is **`--mode plan`, the engine is
claude**. Right after approval, the hook
mechanically re-injects an additionalContext saying "before editing any file, run
Phase A-R (when enabled) → Phase B".

- The hook is best-effort: a settings write or merge failure only logs a warning and does
  NOT stop the dispatch (the prompt-side instruction is the fallback). An existing
  settings.local.json is merged with jq, and a reused worktree is not injected twice
- Accidental-commit prevention: `.claude/settings.local.json` and the plan directory
  `.claude/plans/` are appended to the repo-shared `info/exclude` (a plan file is a work
  artifact handed off by path via `--plan-file`, and must not be committed to the task
  branch by the child's `git add -A`)
- The hook stays in the worktree's settings.local.json, so it also affects later sessions
  that reuse the same worktree (including the prewarmed exec role). Those do not use
  plan mode, so there is no actual harm
- It is NOT injected in superpowers mode / for the codex engine / in execute, standby, and
  review modes

### Launch: Workspace Mode (default)

Workspace mode is the only layout. The normal dispatch does not invoke
launch-workspace.sh directly for the design task; the always-on prewarm path below owns
worktree creation, role launches, --defer-status, agmsg join/wiring, and the initial
status. launch-workspace.sh remains the underlying role launcher used by
prewarm-panes.sh, and every invocation carries an explicit --role plus the runner, model,
and effort already present in roles.json.

The --agmsg-team and --agmsg-from flags are mandatory whenever --status-dir is passed.
Parent desktop notification flags are independent of agmsg and never replace delivery.

### Pre-warm Standby Panes (workspace layout only)

Prewarm is always on. There is no prewarm configuration key and no non-prewarm spawn
fallback. prewarm-panes.sh receives the validated resolver output through one --roles
argument and launches a fixed role layout:

    review_mode=off                 review_mode=on

    +----------------+              +----------------+----------------+
    | design         |              | design         | design_review  |
    +----------------+              +----------------+----------------+
    | exec           |              | exec           | exec_review    |
    +----------------+              +----------------+----------------+

**The four panes must be equal quadrants** — two equal rows, each divided into two equal
columns — and the two-pane layout must be two equal rows. This is a requirement, not an
illustration: a workspace where one pane spans the full height while the other three share
the opposite side is a defect even though every pane exists and is wired.

Evenness is decided entirely by the ORDER the panes are created in. `cmux new-split` takes
no size argument; it halves whatever surface it is pointed at. So the order is fixed:

    1. design      the whole workspace
    2. exec        split down from design    -> two equal full-width rows
    3. design_review  split right from design -> top row becomes two equal columns
    4. exec_review    split right from exec   -> bottom row becomes two equal columns

**exec must be created before design_review.** Creating design_review first shrinks design
to the left half and gives design_review the full height of the right half; splitting design
down afterwards then divides only the left half, producing three panes stacked on the left
and one full-height pane on the right. Each individual direction and split source is still
correct in that broken layout, which is why `test-prewarm-layout.sh` asserts the order
itself and not only the directions.

### Completion Gate (Stop hook)

A child session sometimes stops in the middle of its task — the implementation does not reach
the end, or a reviewer ends before writing its verdict. `launch-workspace.sh` injects one
`type: "command"` Stop hook per pane so the session continues instead of waiting for a human
to say "keep going". The hook is `scripts/completion-gate.sh`, and it is the same script and
the same output contract on both engines; only the destination differs
(`.claude/settings.local.json` for claude, `.codex/hooks.json` for codex, merged so agmsg's
own entries survive).

**The gate reads only the disk.** No model evaluation, no network, no cmux. The completion
condition is already materialised as `status.json`, `.deferred`, and the review round files,
so there is nothing to infer from the transcript. This is what keeps the gate compatible with
push-based waiting: a pane that has not been given its task yet, and a pane waiting for a
`review-verdict:` it already requested, are **states the gate must not interrupt**, and both
are visible on disk. A model-evaluated gate would have to guess at them.

**The same state means opposite things to the two sides of a review.** A round file with no
`VERDICT:` line means "my counterpart has not answered yet, keep waiting" to the requester and
"I have not finished writing my own review" to the reviewer. The gate lets the requester stop
and blocks the reviewer. Reversing this either strands a reviewer that never writes a verdict
or wakes an implementer that should be idle.

**Only findings files count as round files, and the newest one wins.** `latest_round()` takes
only names ending `round-<N>.md`, so a request file (`<point>-round-<N>-request.md`) is never
mistaken for findings — request text routinely contains a literal `VERDICT: approve` line as
instructions, and reading it as a verdict blocks a requester that is correctly waiting. It then
picks by mtime, not by name: checkpoint names differ per phase (`spec`, `plan`, `design`,
`code`), and `plan-round-1.md` sorts *before* an already-approved `spec-round-5.md`, so a
name-ordered pick returns the finished checkpoint and strands the live one. Both were measured
on 2026-08-24.

The gate scopes the review state to the role's own review point, and there is no fallback to
an unscoped scan. Mixing points and taking the newest file lets a finished review at one point
mask an unfinished review at the other, which sends a waiting implementer into the "task is not
finished" branch; measured on 2026-09-02 in 4 of 7 tasks. Only Phase B-R's point name is fixed:
`phase-b-deliver.sh` and `launch-workspace.sh` hardcode `code`, so `exec` and `exec_review` scope
by inclusion, to `code-round-*` alone. Phase A-R's checkpoint name is not fixed — superpowers mode
reuses the `design_review` pane for two checkpoints, `spec` then `plan`, while the unattended loop
uses `design` (see `references/unattended/review-block.md`) — so scoping `design` and
`design_review` to a literal name would strand a superpowers-mode design pane on its own
`spec-round-*` or `plan-round-*` files the same way the unscoped scan used to strand `exec`.
Those two roles therefore scope by exclusion instead: every point except `code`.

**A findings file alone cannot express "I asked and nobody has answered".** Excluding request
files from the round-file pick is right, but it leaves two windows where the requester looks
idle: right after round 1 is requested (no findings exist yet, so the pick returns nothing) and
during any round N+1 (the pick returns round N's findings, which already carry a `VERDICT:`).
Neither matches the "waiting for a verdict" rule, so both fall through to the final decision and
the requester is told to write a terminal status it must not write. Measured on a real pane on
2026-08-26. The gate therefore also tracks the newest `<point>-round-<N>-request.md` and treats
"request newer than findings" as the answer still being pending. The two sides read that one
condition in opposite directions: the requester is allowed to stop, and the reviewer is blocked —
without the reviewer half, a reviewer could stop having never written a review at all.

**A review round that never touches disk is invisible to the gate, and the final decision then
hands the waiter an exit.** Phase B-R originally sent its `review-code:` request as an agmsg
message only, writing no request file, so an implementer waiting for round N+1 kept a stale
Phase A-R request as its newest request and the approved round N findings as its newest round
file — neither the "no verdict yet" rule nor "request newer than findings" matched. It fell
through to the final decision, whose reason offered `error` as the way out, and a Codex `exec`
took that exit 110 seconds after asking for a review that was still running (round 1 of the same
dispatch had taken 17 minutes). Measured on 2026-08-28. Two things follow, and both are needed:
every review request materializes as `<point>-round-<N>-request.md` before its send, in Phase B-R
exactly as in Phase A-R; and the final decision's reason states that waiting for a verdict is
neither being blocked nor an error, and names the request file as the way to express the wait —
so a waiter that reaches it by any other route is guided back instead of pushed to a terminal
status. Reserving `error` for work that actually failed is what keeps that reason honest.

**A requester that gives up must not write into the reviewer's findings path.** The abort
protocol used to record the stop reason in `<point>-round-<N>.md` with a `VERDICT:` line —
partly as a record, partly to release the reviewer, whose gate blocks on a findings file with
no verdict. But that path is the reviewer's own output, and the two writers have no ordering
between them: on 2026-08-28 an abort note replaced the output of a review that was still
running, and the parent had to redirect the reviewer to a `-final.md` path to save it. The stop
reason therefore goes to `<point>-round-<N>-abort.md`, and this gate takes over the release: an
abort file that is newer than both the request and the findings means that round is over, so
the reviewer is allowed to stop even mid-write. Abort files are never read as findings.

**Allowing a wait is not enough when the engine restarts the turn by itself.** Codex has a goal
continuation feature (feature flag `goals`): tens of milliseconds after a turn ends, it injects
`<codex_internal_context source="goal">` and starts another turn, so a waiting pane cycles every
7 to 10 seconds. That injected text carries Codex's own blocked audit — declare
`update_goal(status:"blocked")` once the same blocking condition has repeated for three
consecutive goal turns, *counting automatic continuations* — so a review wait satisfies it in
under 30 seconds. Measured on 2026-08-31 across two dispatches: `exec` sent `review-code:` and
wrote an abort 81 seconds later after 6 continuations, and 111 seconds later after 13, each
immediately calling `update_goal({status:"blocked"})`; both reviewers were healthy and finished
afterwards. The gate allowed correctly on every one of those turns, and allowing is exactly what
let the next continuation fire. The same session waited 90 minutes on an identical request while
its goal was inactive, which is what rules out "a codex waiter cannot wait" as the explanation.
Since `allow` writes nothing, the gate has no voice during a wait, so it flips to `block` for
waits that are being auto-restarted and argues in the `reason`: it names the elapsed minutes
(only the gate has a clock; the model maps continuations onto timer firings), forbids the abort
file, the terminal status and `update_goal(status:"blocked")`, and states that a continuation is
neither a timer nor a wake. A plain wait is untouched: with nothing restarting the pane the next
`Stop` never comes, so the gate records the time in `<status-dir>/.gate-wait-<role>` and only
treats a return within `DISPATCH_GATE_WAIT_RESTART_SECONDS` (90) as an auto-restart. The defence
expires after `DISPATCH_GATE_WAIT_MINUTES` (30) measured from the request file's mtime, which
keeps the existing give-up path reachable; `0` disables it. This adds no polling loop — the
turns being counted are ones the engine started on its own.

**The driver itself is switched off at launch, and the gate defence stays as the second layer.**
Every codex pane is started with `-c features.goals=false`, which removes the continuation rather
than arguing with it. That is the deterministic half of the fix; the gate's `reason` is the half
that still works if a goal is set through another route, such as a person setting one in the TUI
of a running pane. The cost is that a codex pane which stops no longer restarts itself — recovery
is exactly the agmsg path this skill already relies on (a `review-verdict:` message, or the
parent's `dispatch-nudge:` driven by `work-signal.sh`), which is what the design assumes anyway.
Clearing `CODEX_GOALS_FLAG` in `launch-workspace.sh` restores the old behaviour.

**A review pane cannot own the shared `status.json`, so nothing may make it look like it does.**
All four roles share one status directory, and the runner wrapper decides ownership of a standby
pane from `.assigned-<slug>` alone. Phase A-R used to touch an assignment marker for its
reviewer; the reviewer's wrapper then read the implementer's `error` out of the shared
`status.json` and reported it as its own — one role's failure arriving at the parent as three,
with an `abort-reviewer:` sent to a reviewer that was still working (measured 2026-08-28). No
role writes an `.assigned-*` for a review pane, and independently of that the runner refuses to
write status or notify anything when its mode is `review`, because that is knowable statically.

**A child waiting on the parent is not a stalled child.** When a review hits its round cap, the
child can neither start another round nor proceed, so it hands the decision to the parent and
waits. `status.json` cannot express that — `report-status.sh` takes only `done` or `error`, and
both would be false. The child runs `<SKILL_DIR>/scripts/escalate.sh <STATUS_DIR>` once instead
of touching `<STATUS_DIR>/.escalated`. It writes a unique token atomically, so
`recovery-tick.sh` can distinguish one escalation from a remove-then-recreate escalation between
two 15-second checks. A bare `touch` remains compatible and still allows the pane to stop, but
the tick cannot distinguish that cycle without a token. The gate only tests the sentinel's
presence and allows on it for **every** role. Without it the child is pushed toward writing a
terminal status it knows to be a lie — measured on 2026-08-24, when a design pane at its 5-round
cap was blocked on every stop attempt.

**The gate only runs at Stop, so it cannot impose a deadline on a pane that already stopped.**
`scripts/recovery-tick.sh`, called by the runner's existing watcher, enforces deadlines for the
runner-owned pane. The gate is the sole writer of `.gate-seq-<role>` (which it never deletes) and
`.gate-wait-<role>`; the tick is the sole writer and deleter of `.gate-nudge-<role>`. Deletion is
a write too. The tick evaluates hard closure, `.escalated`, soft closure, a missing lease,
generation change, and then state, in that order. In particular, `.escalated` precedes soft
closure because a child can reach the round cap after findings already contain `VERDICT:`.

`DISPATCH_GATE_WAIT_MINUTES=0` disables both the gate's wait defence and the tick. A `design`
pane may stop for `.deferred` or `done` only after the assignment marker for the exact `exec`
agent named in `prewarm.json` exists; `status=error` remains allowed before that check. The
guarantee covers panes launched through the runner with `DISPATCH_GATE_*`: it defends against
missing records and drift, not deliberate forgery of guard state.

If a parent notification succeeds but recording that success in the status directory fails, the
next tick sends the same notification again, and keeps doing so until the directory is writable.
The usual deduplication guarantees — including I18 and T49 — therefore require a writable status
directory; an unwritable directory is outside that guarantee boundary.

**Blocking is unbounded by default.** A finite cap kills a long task that simply has not
finished yet: the gate keeps its counter when it gives up, and only a genuine allow (decisions
1-5) clears it — so an implementing `exec` (`status=executing`, and the latest round already
carrying a `VERDICT:` line, so not waiting either) never matches any allow again and stops on
every single turn from then on. Measured on a real pane on 2026-08-25. A Codex pane's native
execution model is one turn per reply, so the moment this gate gives up, per-task stopping is
what the user sees. Set `DISPATCH_GATE_MAX_BLOCKS` to a positive number to restore a cap where
a runaway loop is the bigger risk.

When a cap is enabled, consecutive blocks are counted in `<status-dir>/.gate-blocks-<role>` and
giving up does not clear the counter — clearing it there would re-arm the limit immediately and
produce an endless block-then-pause cycle. The counter is per role because all four roles share
one status directory; a single shared file would mean "the cap across all four panes", so no
pane ever reaches its own count.

**Whatever the gate knows goes into the `reason`.** The reason is delivered as guidance for
the next turn and the model acts on it, so a reason that names the condition but not the values
needed to satisfy it makes the session go hunting. Measured on a real pane: with only the
condition, the blocked session spent a whole turn running `ls ..`, reading `completion-gate.sh`
and `report-status.sh`, and searching for a team name it never found — and gave up on the
notification. With the status directory, `report-status.sh`, the agent, the team, and the exact
`send.sh` invocation in the reason, the same scenario took three tool calls and completed the
whole contract. The gate says nothing about notifying when the team or the send command is
missing: showing a command with unfillable arguments makes the session either invent values or
go looking for them.

**The gate's identity comes from the process environment, not the command string.** All four
roles share one worktree, and each engine has exactly one hook file
(`.claude/settings.local.json` / `.codex/hooks.json`), so the command is necessarily shared.
Baking `--role` / `--agent` into it makes the second role of the same engine run the first
role's gate: injection is skipped because a gate is already present, and the stale command
still carries the first role's values. Measured on 2026-08-25 — an `exec_review` pane ran the
`design` gate and was told to write a terminal status it had no business writing, while on the
codex side `design_review` ran `exec`'s. The runner script exports `DISPATCH_GATE_ROLE`,
`DISPATCH_GATE_AGENT`, `DISPATCH_GATE_STATUS_DIR` and `DISPATCH_GATE_TEAM` instead, and the
gate reads them whenever the matching flag is absent. Writing `'$VAR'` into the command is not
an alternative: single quotes are not expanded at hook execution time either, and neither is
`\$VAR`.

**Missing identity is fail-open.** A shared Stop hook fires for any session that opens the same
worktree, including a manual one that this dispatch never launched, so a gate that cannot
resolve its role exits 0 with no output instead of blocking a pane it does not own. It must not
`die`: in Claude Code's Stop hook, exit 2 is a *blocking* error, not a no-op. A role value that
is present but invalid is still a usage error and still exits 2.

Injection removes every existing gate entry before adding one. That single rule covers both a
re-used worktree (no second copy) and a pre-3.6.0 entry with values baked in (migrated away) —
leaving the old entry would keep binding every pane to the first role's values.

Injection is best-effort exactly like the `ExitPlanMode` hook: a failure warns and the dispatch
continues. Re-using a worktree does not inject a second copy.

The review-off layout has exactly two panes. The review-on layout has four unless a review
pane fails to launch, in which case prewarm omits only that review key and the corresponding
gate is skipped. If a required design or exec launch fails, prewarm-panes.sh rolls back
only the worktree, branch, team members, and surfaces that this invocation created,
joined, or launched; reused resources are preserved. The dispatch then stops.

Everything is delegated to prewarm-panes.sh. Do not create role panes manually and do not
also run the normal design launch:

    RESULT=$(bash <this-skill-dir>/scripts/prewarm-panes.sh \
      --with-design \
      --cwd "<repo-root>/.worktrees/<task-slug>" \
      --slug <task-slug> \
      --status-dir "$(pwd)/.dispatch/<task-slug>" \
      --roles "$ROLES_JSON" \
      --agmsg-team "$TEAM" \
      --parent-notify-workspace "$CMUX_WORKSPACE_ID")

prewarm-panes.sh creates or reuses the worktree, joins all configured role agents, wires
delivery with delivery.sh set before launch, starts each pane with its own readiness clause, and writes the
initial launched status.json. It records only successfully launched panes.

The resulting prewarm.json has workspace_id, review_mode, and explicit role keys. Each
role tuple contains surface_id, agent, runner, engine, optional model, effort, and
wired=true. There are no nested executor or generic review containers:

    {
      "workspace_id":"workspace:1",
      "review_mode":"on",
      "design":{"surface_id":"surface:1","agent":"task","runner":"ccf","engine":"claude","model":"opus[1m]","effort":"xhigh","wired":true},
      "design_review":{"surface_id":"surface:2","agent":"task-design-review","runner":"cx","engine":"codex","model":"gpt-5.6-sol","effort":"xhigh","wired":true},
      "exec":{"surface_id":"surface:3","agent":"task-exec","runner":"cx","engine":"codex","model":"gpt-5.6-terra","effort":"high","wired":true},
      "exec_review":{"surface_id":"surface:4","agent":"task-exec-review","runner":"ccf","engine":"claude","model":"opus[1m]","effort":"xhigh","wired":true}
    }

Every consumer follows the verified-snapshot contract: read the file content once, validate
the complete document, and use here-strings for every later jq extraction:

    source <this-skill-dir>/scripts/prewarm-snapshot.sh
    PREWARM_DOC=$(cat "<EXISTING_STATUS_DIR>/prewarm.json") || exit 1
    validate_prewarm_snapshot "$PREWARM_DOC" || exit 1
    DESIGN_SURFACE=$(jq -r '.design.surface_id' <<<"$PREWARM_DOC")
    EXEC_SURFACE=$(jq -r '.exec.surface_id' <<<"$PREWARM_DOC")

Never reopen the original path between role lookups. A file replacement between reads
could otherwise redirect cleanup or delivery to an unrelated surface.

Prepare the Phase A prompt before waiting, but do not send it until the design pane reports
[ready] <task-slug>. Then mark the design assignment and send exactly one phase-a-task:
message to the design agent. Messages sent before readiness can remain unread. Review
readiness is pruned as specified in Step 1g before rendering or delivery.

## Parallel execution inside a task

Tasks already run in parallel across worktrees. This section is about the work
*inside* one task: every child session is told to fan independent investigation
and verification out across child agents instead of doing them one at a time.

`scripts/parallel-directive.sh` is the single source of that wording:

```
parallel-directive.sh --engine <claude|codex> --mode <plan|superpowers|execute|review> [--agents <N>]
```

- **claude sessions only.** They are told to launch several Task subagents in one
  message. `--engine codex` prints nothing and exits 0: codex sub-agents run as
  separate threads on the shared local app-server daemon and never appear in the
  pane, so a codex child told to fan out becomes impossible to tell apart from one
  that has stopped. Keep that decision inside the script — callers pass their
  resolved engine through and must not branch on it themselves.
- This limits what is asked for, not what codex can do: the collaboration tools stay
  registered even with `features.multi_agent_v2 = false` (measured on codex-cli
  0.149.1; no config key removes them). A codex child that goes quiet is caught by
  `scripts/work-signal.sh` in Step 3, not here.
- File edits always stay sequential in the parent agent, and the directive never
  overrides a skill that sequences implementation (superpowers
  subagent-driven-development keeps its one-implementer-at-a-time rule).
- Only read-only verification may be fanned out. Auto-fix and write modes (a
  formatter or linter invoked with its write flag) stay sequential in the parent
  agent, because they mutate files and shared build caches.
- `--agents` caps concurrency. Integers 2-8 only; the default is 4. The range is
  validated for both engines — a codex call still rejects `--agents 9` rather than
  waving bad input through just because its output is empty.
- There is no `standby` mode — a standby pane is an execution pane, so pass
  `--mode execute` for it.
- `--agents` and `--no-parallel` are `launch-workspace.sh` flags and now only affect
  claude. This skill never passes them, so the defaults apply to every dispatch it
  launches.

Where the directive is injected (all five sites call the same script, so a codex
addressee yields nothing at every one of them):

| Target | Injected by |
|--------|-------------|
| plan / superpowers / execute launch prompt | `launch-workspace.sh` (suppress with `--no-parallel`) |
| Phase B execution request sent to a standby pane | this skill, via the script |
| Phase A-R review request | this skill, via the script |
| Phase B-R review request (prewarm path) | this skill, via the script |
| Phase B-R review request (spawn path) | `launch-workspace.sh --mode execute --review-config` |

Whenever a directive computed for one engine is embedded in text addressed to a
session running the other engine — the reviewer directive carried inside the
implementer's prompt — mark the addressee explicitly. Position alone is not a
boundary. **When the directive comes back empty, drop the surrounding sentence
too**: a "reviewer-only directive" wrapper with nothing inside it gets transcribed
into the review request as an empty instruction.

## Step 3: Monitor and Complete

### Push-based Monitoring (the only mode)

There is no monitor script, no heartbeat, and no polling loop. This session keeps a
persistent agmsg Monitor stream, so every child message arrives as one line and wakes
this session even while idle. `.dispatch/*/status.json` is the source of truth; the
messages only tell you when to look.

**As soon as the panes are launched — BEFORE waiting for a single `[ready]`:**

1. **A claude parent** arms one single-shot safety timer so a pane that never reports
   ready, and a child that never starts, cannot leave this session asleep forever.
   Arming it first is what makes the readiness wait itself safe; arming it after the
   tasks are delivered would leave the whole `[ready]` window uncovered. **One sleep,
   never a loop**:

   ```bash
   # claude parent only: run this with the Bash tool and `run_in_background: true`
   sleep $((90 * 60))
   ```

   A codex parent arms nothing here — Step 1g states why, and that is the only place it
   is stated. Instead, before ending this turn, confirm every expected codex pane's seat
   with `verify-agmsg-ready.sh --codex` and say plainly in the launch summary that nothing
   but a child message will wake this session, so a silent child needs the user's eyes.

   **90 minutes, fixed.** Nothing in this dispatch resolves a different value: the
   `loop.task_timeout_min` config key is read only by loop mode's wake-time
   reconciliation (`references/loop-mode.md`), for its own per-issue timeout, and never
   reaches this timer. Use a different number only if the
   user asked for one. This is a safety net, not a deadline — a live-but-slow task
   re-arms it.
   **Timeout detection is coarser than it used to be.** `claimed_at` is no longer
   re-checked every 5 seconds the way the retired loop wait script did it; nothing
   re-checks it between wakes now, so a `loop.task_timeout_min` shorter than this timer
   is not detected until the next wake. That is the intended price of removing every
   wait loop, not a defect.
   **Remember the task id and the number of times you have armed it.** Do not annotate
   the `sleep` with an invented flag name (there is no `--wake-after` parameter on the
   Bash tool; a model that reads one will try to pass it) — say it in prose.

   **Stop the timer at Completion.** When every task is terminal and you emit Template
   C, a claude parent stops the timer first (it is step 1 of `### Completion` below) by
   `TaskStop`ing the background task. A surviving `sleep` exits 90 minutes later and
   injects a useless wake into whatever the user has moved on to, and that wake lands in
   the re-arm branch, so every dispatch would leave one stale timer behind forever.

   **Bound the re-arming.** After 3 re-arms with no message and no visible progress,
   stop re-arming: report with the `cmux read-screen` excerpt and ask the user how to
   proceed. "The pane is alive" is not evidence of progress.

2. Report the launch summary using Template A with concrete surface IDs.
3. Tell the user: "Monitoring N tasks. Waiting for agmsg notifications."
4. **End your turn.** Do not block and do not poll — not for `[ready]`, not for
   completions. Every subsequent step of this dispatch starts from a wake.

### On every wake, re-derive state

You do not keep a monitoring loop, so treat each wake as stateless: read all of
`.dispatch/*/status.json` and decide from that, not from what you remember.

**Check for a Phase B handed over outside the helper.** For every task where
`.dispatch/<slug>/review/code-review.json` exists, `.dispatch/<slug>/.assigned-<exec agent>`
must exist too — only `phase-b-deliver.sh` writes both, and it writes the marker before it
sends. A task with the review config but no marker means the design pane hand-wrote its own
handoff, so the executor never received the reviewer's name and cannot request the mandatory
review; `.deferred` and an `executing` status will be missing for the same reason. Confirm it
is not simply a task that has not reached Phase B, by checking whether the exec pane is
working at all — `work-signal.sh` reporting `changed=yes`, or any `code-round-*` file being
absent while the executor has been messaging `parent`. Report it as a wiring failure, not as a
stalled child, and send the executor one message naming the reviewer agent from
`code-review.json`. Measured on 2026-08-31 (`lead-psp-liff`, task `member`): the reviewer sat
with an empty inbox for a full day while the executor sent its review requests to `parent`,
and nothing in the dispatch noticed.

**Re-verify your own inbound channel on every wake and on every timer firing**, not just
once at launch. Use the same one-line `--parent` call Step 1g uses; each wake is stateless,
so re-derive `TEAM` rather than remembering it:

```bash
# wake-readiness (identical to Step 1g; the engine choice lives inside the script)
TEAM="dispatch-$(basename "$(git rev-parse --show-toplevel)")"

WAKE_READY_RC=0
WAKE_READY_OUT=$(bash <SKILL_DIR>/scripts/verify-agmsg-ready.sh --parent --team "$TEAM") \
  || WAKE_READY_RC=$?
```

Judge it by exit code (`0` = reachable, `1` = not reachable, `2` = usage error) or by the
`ready=yes` / `ready=no` prefix of its stdout — never by the whole line, because
diagnostic fields (`pid=`, `session=`) follow the prefix and change between runs. Keep
`1` and `2` apart here too: `1` is a fact about this session, `2` means the question was
never answered, so on `2` stop and report the usage error instead of concluding anything
about the watcher or the seat.

A claude parent's watcher can die mid-dispatch (`_install_changed` self-exit at
`watch.sh:426-429`; a `/compact` racing a `TaskStop`), and a codex parent's bridge seat
can be dropped the same way. Once the channel is gone, **every** child notification is
silently lost. If it reports `ready=no`, say so and stop treating "no message arrived" as
information about the children.

`sharing=` can change between wakes, because a second session can be opened in this
checkout at any time. Apply the same rule as Step 1g: warn on a positive count, say
nothing on `0` or `unknown`. A competitor that appeared mid-dispatch is worth one line,
because from that moment a `[ready]` or `dispatch-notify:` addressed to parent can be
consumed by the other watcher and never reach this session.

```bash
for f in .dispatch/*/status.json; do
  slug=$(basename "$(dirname "$f")")
  echo "$slug: $(jq -r '.status' "$f" 2>/dev/null || echo unknown) - $(jq -r '.message // ""' "$f" 2>/dev/null)"
done
```

Then branch on what woke you:

- **`[ready] <name>`** — that pane is now reachable. Once every expected pane has
  reported, send the tasks (Step 2's delivery). Nothing else to report to the user.
- **A message whose body starts with `dispatch-notify:` and mentions a task slug** —
  read that task's `status.json` and, when `done`, its `result.md`. Re-emit the full
  progress table (**Template B** — never a one-line free-form message). If every task is
  terminal, proceed to Completion (Template C). Otherwise tell the user how many remain
  and end your turn again.

  Identify it by the `dispatch-notify:` prefix **plus the slug as a substring**. Do NOT
  require an exact `task "<slug>" finished`: the runner wrapper's copy renders the slug
  wrapped in literal backslashes (`task \"<slug>\" finished`), so a matcher anchored on
  the plain double quotes silently never fires on it.

  Receiving the same completion twice is normal: notifications come from the child
  itself, from the status.json watcher the runner wrapper runs alongside it, and from
  the wrapper at session exit. Treat them idempotently and trust status.json.
- **Any other child message** (a question, a progress note) — answer it by replying with
  `send.sh` to that child's agent name, then end your turn.
- **The timer task** (it fires only if one was armed) —
  no message arrived within the window. This is not evidence that
  a child failed; it is evidence that no message arrived. **Read the persistent records
  before judging anything**: re-derive state from `.dispatch/*/status.json`, and for a
  task whose `[ready]` you never saw, check the history rather than the inbox:

  ```bash
  ~/.agents/skills/agmsg/scripts/history.sh "$TEAM" parent 50 | grep -E '\[ready\] <slug>$'
  ```

  Use `history.sh`, **never `inbox.sh`**: a `[ready]` consumed by a competing watcher is
  already marked read, so `inbox.sh` would truthfully answer "nothing new" while the
  row sits in the DB. Anchor the slug to the end of the line, never a bare
  `grep -F '[ready]'`: the body is always `[ready] <slug>` and it ends the history line,
  so an unanchored match lets slug `api` be satisfied by `[ready] api-v2` — a task that
  never reported would look ready. **Marking a task `error` because its `[ready]` was
  stolen kills a healthy child.** Only after the history also shows no `[ready]` may you
  treat the pane as unreachable.

  Then, for each non-terminal task, decide whether it is *working quietly* or *stopped*.
  A live pane does not settle that — an interactive codex pane never exits — so read the
  work signal, which is what the work itself leaves behind rather than what the session
  says about it:

  ```bash
  bash <SKILL_DIR>/scripts/work-signal.sh "<worktree>" \
    --state ".dispatch/<slug>/.work-signal" --surface <surface_id>
  ```

  It hashes the HEAD commit, the set of dirty paths, their mtimes and the pane's screen,
  and compares that with the previous wake. Branch on `changed=`:

  - **`yes` (or `first`)** — the child is working and merely quiet. Re-arm the same timer
    and end your turn **without incrementing the re-arm count**: a task that is visibly
    progressing must not burn the budget meant for stalled ones.
  - **`no`** — nothing moved. Treat it as stalled and try to resume it once. Check the
    child can actually receive a message first:
    `bash <SKILL_DIR>/scripts/verify-agmsg-ready.sh --codex --team "$TEAM" --name <agent>`
    (codex panes; a claude child that reported `[ready]` is reachable by definition).
    - **Reachable** — send exactly one nudge and re-arm, incrementing the count:
      ```bash
      ~/.agents/skills/agmsg/scripts/send.sh "$TEAM" parent <agent> \
        'dispatch-nudge: no progress detected since the last check. Continue the task, and when it is done write status.json and send the dispatch-notify: completion exactly as instructed.'
      ```
      **At most one nudge per task.** Record it (`.dispatch/<slug>/.nudged-<agent>`) and
      if a later wake is still `no` after that nudge, stop nudging: report to the user
      with a `read-screen` excerpt. Poking an unresponsive session repeatedly adds noise,
      not information.
    - **Seat never recorded** — do NOT nudge. `send.sh` would succeed and the row would
      sit unread (`docs/notification-gaps.md` R2). Report "stalled and unreachable" as
      the distinct problem it is, and have that pane re-run `codex-record-session.sh`.
  - **`unknown`** — the screen could not be read, so the comparison means nothing. Fall
    through to the pane check below instead of guessing.

  Pane check: `cmux read-screen --surface <id>`, **retried once** before you conclude
  anything — a transient cmux socket failure must not be read as a dead pane. If a pane
  is really gone, mark that task `error` with the reason and report it. Use
  `verify-agmsg-ready.sh --codex` on codex panes to separate "seat never recorded" from
  "pane died".

### Polling Status Files (Manual Check)

If the user asks about progress:

```bash
for f in .dispatch/*/status.json; do
  task_name=$(dirname "$f" | xargs basename)
  task_status=$(jq -r '.status' "$f" 2>/dev/null || echo "unknown")
  message=$(jq -r '.message' "$f" 2>/dev/null || echo "")
  echo "$task_name: $task_status - $message"
done
```

### Reading Session Screens (on demand)

For workspace mode:

```bash
cmux read-screen --workspace <workspace-id> --scrollback
```

### When to Intervene

- **Status "error"**: Read the error message and session screen. Offer to retry or escalate.
- **Long silence**: Not your cue to act — silence is what the safety timer is for. Do
  NOT start polling; end your turn and let the timer wake you, then follow the timer
  branch above. With no timer armed, silence stays silence until the user asks: say that
  once at launch and do not invent a wait here.
- **User request**: The user can ask to check on any specific session at any time. That
  is a wake like any other: re-derive state once, answer, end your turn.

### Completion

When all tasks reach a terminal status (`"done"` or `"error"`):

1. **Stop the safety timer** armed in Step 3, if one was armed: `TaskStop` the
   background `sleep` task. Do this first, before reading anything — it is the only place the timer is stopped,
   and a survivor fires 90 minutes later into an unrelated conversation.

2. **Collect results**: Read all `.dispatch/<task-slug>/result.md` files.

3. **Generate consolidated report**. ALWAYS lead with **Template C** (final summary table) before any per-task detail or merge instructions.

   **When integration strategy is "Wait and merge":**

   ```
   # Team Dispatch Report

   ┌────┬──────────────────────────┬──────────┬────────────┬───────────┬─────────────────────────┐
   │ #  │ Task                     │ Duration │ Mode       │ Status    │ Result / PR             │
   ├────┼──────────────────────────┼──────────┼────────────┼───────────┼─────────────────────────┤
   │ 1  │ login-page-ui            │ 12m34s   │ superpwr   │ done      │ feat/login-page-ui      │
   │ 2  │ auth-api-endpoint        │ 08m02s   │ plan       │ done      │ feat/auth-api-endpoint  │
   └────┴──────────────────────────┴──────────┴────────────┴───────────┴─────────────────────────┘

   ## Task Results

   ### 1. login-page-ui [brainstorming]
   <contents of .dispatch/login-page-ui/result.md>

   ### 2. auth-api-endpoint [plan]
   <contents of .dispatch/auth-api-endpoint/result.md>

   ## Worktree Branches
   - feat/login-page-ui
   - feat/auth-api-endpoint

   ## Next Steps
   - Review and merge branches
   - Run full test suite across all changes
   - Clean up worktrees when done
   ```

   **When integration strategy is "PR per task":**

   ```
   # Team Dispatch Report

   ┌────┬──────────────────────────┬──────────┬────────────┬───────────┬─────────────────────────┐
   │ #  │ Task                     │ Duration │ Mode       │ Status    │ Result / PR             │
   ├────┼──────────────────────────┼──────────┼────────────┼───────────┼─────────────────────────┤
   │ 1  │ login-page-ui            │ 12m34s   │ superpwr   │ done      │ https://github.com/…    │
   │ 2  │ auth-api-endpoint        │ 08m02s   │ plan       │ done      │ https://github.com/…    │
   └────┴──────────────────────────┴──────────┴────────────┴───────────┴─────────────────────────┘

   ## Task Results

   ### 1. login-page-ui [brainstorming]
   <contents of .dispatch/login-page-ui/result.md>
   PR: <PR URL from status.json>

   ### 2. auth-api-endpoint [plan]
   <contents of .dispatch/auth-api-endpoint/result.md>
   PR: <PR URL from status.json>

   ## Pull Requests
   - login-page-ui: <PR URL>
   - auth-api-endpoint: <PR URL>

   ## Next Steps
   - Review and merge PRs on GitHub
   - Clean up worktrees when done
   ```

4. **Proceed to integration based on strategy selected in Step 1e**:

### Integration and Cleanup

#### When integration strategy is "Wait and merge"

Present the user with two options:

**Option A: Merge worktree branches**

1. Check each worktree for uncommitted changes; commit if needed
2. Merge each branch into the current branch:
   ```bash
   for slug in <task-slugs>; do
     git merge "feat/$slug" --no-edit || echo "CONFLICT in feat/$slug"
   done
   ```
3. If merge conflicts occur, help the user resolve them
4. After successful merge, run the end-of-dispatch cleanup prompts
   (see "Cleanup prompts (parent-side, end of dispatch)" below). The parent asks
   once for workspace/worktree/branch deletion and applies the choice to all tasks.
5. Show merge results with `git log --oneline`

**Option B: Do not merge**

1. Remove only the dispatch directory. `config.json` is the project config layer and is
   NOT a dispatch artifact, so it is the one entry that survives:
   ```bash
   if bash <this-skill-dir>/scripts/issue-fetch.sh --state-file .dispatch-loop/loop-state.json lock-check; then
     [[ -d .dispatch ]] && find .dispatch -mindepth 1 -maxdepth 1 ! -name config.json -exec rm -rf {} +
   else
     # This message is shown to the user — write it in Japanese (see Output Language)
     echo "<skip bulk .dispatch/ delete: issue loop is running>" >&2
   fi
   ```
2. Display cleanup instructions to the user:

   ```
   Worktrees are preserved for manual review. To clean up later:

   # List worktrees
   git worktree list

   # Remove individual worktree and branch
   git worktree remove .worktrees/<task-slug>
   git branch -D feat/<task-slug>

   # Remove all at once
   for slug in <task-slugs>; do
     git worktree remove ".worktrees/$slug" --force
     git branch -D "feat/$slug"
   done
   rmdir .worktrees 2>/dev/null
   ```

#### When integration strategy is "PR per task"

PRs are already created by each child session. Present the user with:

1. **List all PR URLs** extracted from `.dispatch/<slug>/status.json` (`pr_url` field) and `result.md`
2. **Check PR status**:
   ```bash
   for slug in <task-slugs>; do
     pr_url=$(jq -r '.pr_url // empty' ".dispatch/$slug/status.json" 2>/dev/null)
     if [[ -n "$pr_url" ]]; then
       pr_state=$(gh pr view "$pr_url" --json state -q '.state' 2>/dev/null || echo "unknown")
       echo "$slug: $pr_state - $pr_url"
     else
       echo "$slug: no PR created"
     fi
   done
   ```
3. **Run the end-of-dispatch cleanup prompts** (see "Cleanup prompts (parent-side, end of dispatch)" below).
   The parent asks once for workspace/worktree/branch deletion and applies the choice
   to all tasks.

   If the user prefers to defer all cleanup (e.g., PRs still need review), they can
   answer "No" to each prompt — the parent will then just sweep `.dispatch/` as in
   "Wait and merge" Option B, keeping `.dispatch/config.json`.
   Display the manual cleanup instructions from "Wait and merge" Option B when
   worktrees are intentionally kept.

---

### Cleanup prompts (parent-side, end of dispatch)

Shared by both integration strategies. Run this once in the parent after every child has
reached a terminal state. Ask, in order, whether to close child panes/workspaces, remove
task worktrees, and delete feature branches. Record the answers as close_all,
remove_wt_all, and delete_br_all.

The close path trusts neither status.json nor repeated reads of prewarm.json. A child
terminal write may omit workspace_id, and stale status plus stale prewarm can agree with
each other while referring to a different workspace. Resolve the current workspace from
the cleanup argument when available, otherwise from a literal [slug] match in cmux
workspace list. Read and validate prewarm content once, and close explicit role keys only
when its workspace_id matches:

```bash
    . <this-skill-dir>/scripts/config-lib.sh
    RUNNERS_FILE="$(dispatch_runners_file)"
    validate_cleanup_prewarm_snapshot() { # $1=document, $2=task slug
      local doc="$1" slug="$2" role expected runner engine effort model registered review_mode
      [[ -f "$RUNNERS_FILE" ]] || return 1
      jq -e 'type == "object" and
        ((keys - ["workspace_id","review_mode","design","design_review","exec","exec_review"]) | length == 0) and
        (.workspace_id | type == "string" and length > 0) and
        (.review_mode == "on" or .review_mode == "off") and has("design") and has("exec")' \
        >/dev/null 2>&1 <<<"$doc" || return 1
      review_mode=$(jq -r '.review_mode' <<<"$doc")
      if [[ "$review_mode" == off ]]; then
        jq -e 'has("design_review") or has("exec_review")' >/dev/null 2>&1 <<<"$doc" && return 1
      fi
      for role in design design_review exec exec_review; do
        jq -e --arg r "$role" 'has($r)' >/dev/null 2>&1 <<<"$doc" || continue
        jq -e --arg r "$role" '
          (.[$r] | type == "object") and
          ((.[$r] | keys - ["surface_id","agent","runner","engine","model","effort","wired"]) | length == 0) and
          (.[$r].surface_id | type == "string" and length > 0) and
          (.[$r].agent | type == "string" and length > 0) and
          (.[$r].runner | type == "string" and length > 0) and
          (.[$r].engine == "claude" or .[$r].engine == "codex") and
          (.[$r].effort | type == "string") and (.[$r].wired == true)' \
          >/dev/null 2>&1 <<<"$doc" || return 1
        case "$role" in
          design) expected="$slug" ;;
          *) expected="$slug-${role//_/-}" ;;
        esac
        [[ "$(jq -r --arg r "$role" '.[$r].agent' <<<"$doc")" == "$expected" ]] || return 1
        runner=$(jq -r --arg r "$role" '.[$r].runner' <<<"$doc")
        engine=$(jq -r --arg r "$role" '.[$r].engine' <<<"$doc")
        effort=$(jq -r --arg r "$role" '.[$r].effort' <<<"$doc")
        dispatch_valid_runner_name "$runner" || return 1
        dispatch_valid_effort "$effort" "$engine" || return 1
        registered=$(jq -r --arg runner "$runner" \
          'first(.runners[]? | select(.name == $runner) | .engine) // empty' "$RUNNERS_FILE")
        [[ "$registered" == "$engine" ]] || return 1
        if jq -e --arg r "$role" '.[$r] | has("model")' >/dev/null 2>&1 <<<"$doc"; then
          jq -e --arg r "$role" '.[$r].model | type == "string" and length > 0' \
            >/dev/null 2>&1 <<<"$doc" || return 1
          model=$(jq -r --arg r "$role" '.[$r].model' <<<"$doc")
          dispatch_valid_model "$model" || return 1
        elif dispatch_model_required "$role" "$engine"; then
          return 1
        fi
      done
    }

    for slug in <task-slugs>; do
      cleanup_workspace=$(cmux workspace list 2>/dev/null         | awk -v s="[$slug]" 'index($0, s) {print $1; exit}')
      pj=".dispatch/$slug/prewarm.json"
      PREWARM_DOC=
      PREWARM_MATCH=false

      if [[ "$close_all" == "true" && -n "$cleanup_workspace" && -f "$pj" ]]; then
        if PREWARM_DOC=$(cat "$pj") \
          && validate_cleanup_prewarm_snapshot "$PREWARM_DOC" "$slug"; then
          snapshot_workspace=$(jq -r '.workspace_id' <<<"$PREWARM_DOC")
          if [[ "$snapshot_workspace" == "$cleanup_workspace" ]]; then
            PREWARM_MATCH=true
            while IFS= read -r sf; do
              [[ -n "$sf" ]] || continue
              cmux close-surface --workspace "$cleanup_workspace" --surface "$sf" 2>/dev/null || true
            done < <(jq -r '. as $d | ["design","design_review","exec","exec_review"]
              | map(select($d[.] != null) | $d[.].surface_id) | .[]' <<<"$PREWARM_DOC"               | awk 'NF && !seen[$0]++')
            cmux close-workspace --workspace "$cleanup_workspace" 2>/dev/null || true
          else
            echo "[warn] $slug: prewarm workspace '$snapshot_workspace' does not match current workspace '$cleanup_workspace'; nothing closed" >&2
          fi
        else
          echo "[warn] $slug: invalid prewarm snapshot; nothing closed" >&2
        fi
      fi

      [[ "$remove_wt_all" == "true" ]] && git worktree remove ".worktrees/$slug" --force 2>/dev/null
      [[ "$delete_br_all" == "true" ]] && git branch -D "feat/$slug" 2>/dev/null
    done
    true
```

The explicit role list and awk de-duplication are both required. Do not use recursive
object traversal: a future unrelated object could also contain a surface_id.

Leave team members before the dispatch artifact sweep, using the same one-read,
validation, workspace-match, and explicit-role rules:

```bash
    . <this-skill-dir>/scripts/config-lib.sh
    RUNNERS_FILE="$(dispatch_runners_file)"
    validate_cleanup_prewarm_snapshot() { # $1=document, $2=task slug
      local doc="$1" slug="$2" role expected runner engine effort model registered review_mode
      [[ -f "$RUNNERS_FILE" ]] || return 1
      jq -e 'type == "object" and
        ((keys - ["workspace_id","review_mode","design","design_review","exec","exec_review"]) | length == 0) and
        (.workspace_id | type == "string" and length > 0) and
        (.review_mode == "on" or .review_mode == "off") and has("design") and has("exec")' \
        >/dev/null 2>&1 <<<"$doc" || return 1
      review_mode=$(jq -r '.review_mode' <<<"$doc")
      if [[ "$review_mode" == off ]]; then
        jq -e 'has("design_review") or has("exec_review")' >/dev/null 2>&1 <<<"$doc" && return 1
      fi
      for role in design design_review exec exec_review; do
        jq -e --arg r "$role" 'has($r)' >/dev/null 2>&1 <<<"$doc" || continue
        jq -e --arg r "$role" '
          (.[$r] | type == "object") and
          ((.[$r] | keys - ["surface_id","agent","runner","engine","model","effort","wired"]) | length == 0) and
          (.[$r].surface_id | type == "string" and length > 0) and
          (.[$r].agent | type == "string" and length > 0) and
          (.[$r].runner | type == "string" and length > 0) and
          (.[$r].engine == "claude" or .[$r].engine == "codex") and
          (.[$r].effort | type == "string") and (.[$r].wired == true)' \
          >/dev/null 2>&1 <<<"$doc" || return 1
        case "$role" in
          design) expected="$slug" ;;
          *) expected="$slug-${role//_/-}" ;;
        esac
        [[ "$(jq -r --arg r "$role" '.[$r].agent' <<<"$doc")" == "$expected" ]] || return 1
        runner=$(jq -r --arg r "$role" '.[$r].runner' <<<"$doc")
        engine=$(jq -r --arg r "$role" '.[$r].engine' <<<"$doc")
        effort=$(jq -r --arg r "$role" '.[$r].effort' <<<"$doc")
        dispatch_valid_runner_name "$runner" || return 1
        dispatch_valid_effort "$effort" "$engine" || return 1
        registered=$(jq -r --arg runner "$runner" \
          'first(.runners[]? | select(.name == $runner) | .engine) // empty' "$RUNNERS_FILE")
        [[ "$registered" == "$engine" ]] || return 1
        if jq -e --arg r "$role" '.[$r] | has("model")' >/dev/null 2>&1 <<<"$doc"; then
          jq -e --arg r "$role" '.[$r].model | type == "string" and length > 0' \
            >/dev/null 2>&1 <<<"$doc" || return 1
          model=$(jq -r --arg r "$role" '.[$r].model' <<<"$doc")
          dispatch_valid_model "$model" || return 1
        elif dispatch_model_required "$role" "$engine"; then
          return 1
        fi
      done
    }

    for slug in <task-slugs>; do
      cleanup_workspace=$(cmux workspace list 2>/dev/null         | awk -v s="[$slug]" 'index($0, s) {print $1; exit}')
      pj=".dispatch/$slug/prewarm.json"
      PREWARM_DOC=
      if [[ -n "$cleanup_workspace" && -f "$pj" ]] && PREWARM_DOC=$(cat "$pj") \
        && validate_cleanup_prewarm_snapshot "$PREWARM_DOC" "$slug" \
        && [[ "$(jq -r '.workspace_id' <<<"$PREWARM_DOC")" == "$cleanup_workspace" ]]; then
        while IFS= read -r agent; do
          [[ -n "$agent" ]] || continue
          ~/.agents/skills/agmsg/scripts/leave.sh "$TEAM" "$agent" 2>/dev/null || true
        done < <(jq -r '. as $d | ["design","design_review","exec","exec_review"]
          | map(select($d[.] != null) | $d[.].agent) | .[]' <<<"$PREWARM_DOC"           | awk 'NF && !seen[$0]++')
      fi
    done
```

Finally, preserve .dispatch/config.json and refuse the bulk artifact sweep while an issue
loop owns the lock:

    if bash <this-skill-dir>/scripts/issue-fetch.sh --state-file .dispatch-loop/loop-state.json lock-check; then
      [[ -d .dispatch ]] && find .dispatch -mindepth 1 -maxdepth 1 ! -name config.json -exec rm -rf {} +
    else
      echo "<skip bulk .dispatch/ delete: issue loop is running>" >&2
    fi
    rmdir .worktrees 2>/dev/null

The close → worktree → branch order is intentional. Child sessions never ask cleanup
questions or delete their own worktrees.

## Status Protocol Reference

Child sessions communicate with the orchestrator via `.dispatch/<task-slug>/`:

### status.json

```json
{
  "status": "launched",
  "workspace_id": "workspace:N",
  "surface_id": "surface:N",
  "message": "Human-readable status description",
  "pr_url": "https://github.com/owner/repo/pull/123",
  "timestamp": "2026-04-07T16:00:00Z"
}
```

The `pr_url` field is only present when integration strategy is "PR per task" and the child
session has successfully created a PR. It is written at status `done`.

Cleanup decisions are NOT stored in `status.json`. The parent asks once at the end
of dispatch (see "Cleanup prompts (parent-side, end of dispatch)") and applies the
user's answers to every task — child sessions do not ask or record cleanup intent.

| Status      | Meaning                                              | Written By                    |
| ----------- | ---------------------------------------------------- | ----------------------------- |
| `launched`  | Runner session started and loading                   | launch script                 |
| `planning`  | Design runner is in planning phase                   | child session (optional)      |
| `executing` | runner session starting / implementation in progress | runner script / child session |
| `done`      | All work complete                                    | runner script / child session |
| `error`     | Blocked by an error or non-zero exit                 | runner script / child session |

### result.md

Written by the child session when status becomes `done`:

**Wait and merge:**

```markdown
# <Task Name>

## Changes Made

- List of files changed and what was done

## Test Results

- Test pass/fail summary

## Commits

- <hash> <commit message>
```

**PR per task:**

```markdown
# <Task Name>

## Changes Made

- List of files changed and what was done

## Test Results

- Test pass/fail summary

## Pull Request

- <PR URL>

## Commits

- <hash> <commit message>
```

---

## superpowers Execution Handoff Integration

This skill integrates with `superpowers:writing-plans` as a **third execution option** in the
Execution Handoff. When a plan is complete, `writing-plans` presents execution choices:

```
writing-plans Execution Handoff:

  "Plan complete. Three execution options:"

  1. Subagent-Driven (recommended)  → superpowers:subagent-driven-development
     Sequential, one subagent per task, two-stage review after each

  2. Inline Execution               → superpowers:executing-plans
     Batch execution in this session with checkpoints

  3. Parallel (cmux)                → cmux-team-dispatch-task              ← THIS SKILL
     Each task in its own cmux workspace + git worktree,
     all run concurrently.
```

### When to Suggest Parallel (cmux)

| Option              | Best for                                                                  |
| ------------------- | ------------------------------------------------------------------------- |
| Subagent-Driven     | Tasks with dependencies, review-heavy workflows, cost-conscious execution |
| Inline Execution    | Simple plans, interactive execution, single-session preference            |
| **Parallel (cmux)** | **3+ independent tasks, speed priority, visual overview of all sessions** |

### Flow When Parallel Is Chosen

When the user selects option 3:

1. **Skip Step 1a** of this skill (tasks already defined in the plan)
2. **Parse the plan file** to extract independent tasks with descriptions
3. **Ask brainstorming selection** (Step 1c) — since tasks come from a superpowers plan, default to "none" (brainstorming was already done by the planner)
4. **Use the workspace layout** (Step 1d)
5. **Ask integration strategy** (Step 1e) — ask PR per task or Wait and merge
6. **Configure child runner** (Step 1f) — bootstrap `runners.json` if missing, then assign runners per task
7. **Launch all tasks** using launch commands from Step 2
8. **Monitor** using Step 3

### Building the Tasks JSON from a Plan

When parsing a `superpowers:writing-plans` plan file:

1. Each `### Task N: <name>` heading becomes a task entry
2. The task slug is derived from the heading (lowercase, hyphens, max 30 chars)
3. The prompt includes:
   - The full task text (all steps under that heading)
   - A reference to the plan file for context
   - The available agents block (same as Step 2)
   - The status protocol instructions (same as Step 2)

---

## Constraints

- **Concurrent sessions**: Limited by system resources; 3-5 sessions recommended
- **Worktree conflicts**: Two tasks must NOT modify the same files. If they might, run sequentially.
- **cmux required**: Requires cmux at `/Applications/cmux.app/`
- **Completion notifications are push-based**: The child sends `dispatch-notify:` immediately after its terminal status write. The wrapper repeats it on process exit as a backstop. A non-zero `send.sh` exit means the parent was not told.
- **Signal-terminated panes do not report failure**: When the final cleanup closes a pane (`cmux close-surface` / `close-workspace`), the child process exits with a signal-derived code (128+N — SIGHUP 129 / SIGKILL 137 / SIGTERM 143). If `status.json` already holds a terminal status (`done` / `error`), the runner wrapper skips both the status write and the parent notification, so closing panes never downgrades a completed task to `error` nor emits a spurious `[dispatch] task ... finished (status: error)`. A pane killed while still `executing` is a genuine interruption and is still reported as `error`.
- **Runner script**: A `.cmux-team-dispatch-task-run-<workspace-name>.sh` file is created for each prewarmed role. Distinct workspace names keep their wrappers separate when they share a worktree. They're cleaned up along with the worktree.
- **Fixed execution role**: Phase B always delegates to the configured exec pane. The
  design pane touches `.deferred` and exits after successful delivery; there is no
  path that continues implementation in the design pane and no execution-choice question.
- **Independent review roles**: design_review owns both Phase A-R checkpoints and
  exec_review owns Phase B-R. Neither role is inferred from another role's engine.
- **Delivery**: There is no notification-transport setting. `message_type` was removed, along with the `--message-type` flag on `launch-workspace.sh` / `prewarm-panes.sh` (both now die with `was removed`). agmsg is a hard requirement with no degraded mode: Step 1g stops the dispatch when `~/.agents/skills/agmsg/scripts/send.sh` is missing, or when the parent's own readiness check fails. That check is one call, `verify-agmsg-ready.sh --parent --team "$TEAM"`, and the engine choice lives inside the script: a claude parent is answered from its live Monitor watcher and a codex parent from its recorded bridge seat. The call site must never branch on the engine itself — an unconditional `--self` answers rc=2 from a codex session, which the "rc=2 is undetermined, stop" rule then turns into a dispatch that aborts on its own first wake. The same call also reports `sharing=<N>|unknown`, the number of other watchers receiving for this project's unclaimed roles; it never changes reachability, so a positive count warns and `0` / `unknown` say nothing. There is no monitor script, no heartbeat and no polling loop (status.json transitions are unchanged). Every message goes through one `~/.agents/skills/agmsg/scripts/send.sh` call whose destination is an **agmsg agent name**, never a surface or workspace id. There is no outbox, no length threshold, no Enter verification and no re-send: `send.sh` either writes the body into agmsg's shared SQLite DB or exits non-zero, and **a non-zero exit means the message was NOT delivered** and must be reported. The message kind is a label prefix on the body (`phase-a-task:`, `phase-b-exec:`, `review-plan:`, `review-code:`, `review-verdict:`, `abort-reviewer:`, `dispatch-notify:`), not a flag. A pane is reachable only after it has reported `[ready] <name>`; a message sent earlier sits unread in its inbox. Completion notifications have two layers: the mandatory one the child session sends right after writing status.json (embedded into the child prompt in Step 2) plus the runner wrapper's exit-time notification (a backstop). Relying on the wrapper alone would miss notifications, because an idle TUI never exits. The parent's own wake channel is the persistent `Monitor` stream its SessionStart hook asks for; Step 1g only verifies that it is alive and Step 3 re-verifies it on every wake. Waiting for a review verdict is push too: the reviewer writes the findings file and then sends one `review-verdict:` message to the requester, and nobody polls the file. Every waiter — the design pane in Phase A-R, the implementer in Phase B-R — re-reads the findings file on every wake, because only the message can be lost. **Safety timers are claude-only**: a claude session backgrounds ONE single-shot `sleep` with the Bash tool (the parent's 90-minute timer is the same mechanism). A codex session has no such tool and cannot substitute a self-addressed delayed message either — a backgrounded subshell that sleeps and then messages you, and the detached `nohup` form of the same, were both measured on 2026-08-21 (D-T2) and both die with the turn — so **a codex waiter has no safety net and must not pretend to arm one**; it verifies its counterpart is reachable and reports the unbacked wait to the parent before ending its turn. An unattended loop driven by a codex parent therefore has no backstop at all and is refused. A timer wake never means `needs_work` — it means no message arrived.
- **Pre-warm role panes**: prewarm is always on. review_mode=off launches design and exec;
  review_mode=on also launches design_review and exec_review. prewarm.json uses only these
  explicit role keys and every consumer reads and validates one immutable snapshot.
