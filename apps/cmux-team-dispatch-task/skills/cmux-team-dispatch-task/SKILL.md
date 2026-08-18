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
argument-hint: "<task1>, <task2>, ... [--loop] [--setup] [--reset [runners|config|all]]"
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
another. A fixed all-Codex unattended task uses codex for all three roles and creates no
claude pane. Timeout sentinels and final cleanup target only the role panes
recorded in `prewarm.json`.

## Setup Mode (explicit configuration)

Only triggers on `--setup`. Dispatches nothing — no task, worktree, workspace, or pane
is created. It walks the user through the role keys (`design_runner` / `review_runner` /
`exec_choice` / `review_mode` / `prewarm`) and the `runners.json` registry, then writes
the result to the layer the user picked. Follow
[`references/setup-mode.md`](references/setup-mode.md).

## Reset Mode (configuration reset)

Only triggers on `--reset`, optionally with a target: `--reset runners` (the registry),
`--reset config` (the role keys), or `--reset all`. With no target, ask for one.
Dispatches nothing, and never removes `.dispatch/`, a worktree, or a branch — that stays
with the end-of-dispatch cleanup prompts. Follow
[`references/setup-mode.md`](references/setup-mode.md).

Both modes write exclusively through `scripts/config-edit.sh`, which merges rather than
replaces so that keys owned by other components (`shell_ready_ms`) survive. Both are
mutually exclusive with `--loop` and with each other, and both refuse to run while an
issue loop holds the lock. Neither is a task description: `--setup` and `--reset` must
never reach Step 1a's task parsing.

## Step 1: Parse and Prepare

This single step handles task collection, agent routing, integration strategy, and runtime
selection. Up to four user interactions before dispatch:
brainstorming selection (1c), integration strategy
selection (1e), child runner selection (1f), and Phase A-R review opt-in
(1g — every dispatch while `review_mode` is unset or `"ask"` and a `review_model`
runner exists). There is NO message-transport question — see 1g.

### 1a. Collect Tasks

If `$ARGUMENTS` is empty or not provided, ask the user what tasks to run:

> What tasks would you like to run in parallel?
> You can specify:
>
> - Plan file paths (e.g., `.claude/plans/feature-a.md`)
> - Task descriptions (e.g., "Implement login page UI")
> - Separate multiple tasks by newline or comma

If `$ARGUMENTS` is provided, parse the input into a task list:

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

### 1f. Configure Child Runner

Decide which runtime each child session should launch with (e.g. parent-account `claude`,
a different account via a zsh function such as `ccenec`, or `codex`). Resolution order:

1. **Check `~/.claude/cmux-team-dispatch-task/runners.json`**
   - If the file does NOT exist, run **First-run setup** (see below) before continuing
2. **Resolve `design_runner`** from `<project>/.dispatch/config.json`, falling back to
   `~/.claude/cmux-team-dispatch-task/config.json`:

   ```bash
   # Validate each layer independently so that an invalid project value does not mask an
   # "always ..." choice already persisted in global. On an invalid value, warn and treat
   # only that layer as unset, then fall back to the next one.
   # Valid values = any runners[].name, or "ask" ("ask" is valid and stops the fallback).
   RUNNERS_JSON=~/.claude/cmux-team-dispatch-task/runners.json
   valid_design_runner() {
     [[ "$1" == "ask" ]] || jq -e --arg n "$1" \
       '.runners[] | select(.name == $n)' "$RUNNERS_JSON" >/dev/null 2>&1
   }
   DESIGN_RUNNER=$(jq -r '.design_runner // empty' .dispatch/config.json 2>/dev/null)
   if [[ -n "$DESIGN_RUNNER" ]] && ! valid_design_runner "$DESIGN_RUNNER"; then
     echo "[warn] design_runner=\"$DESIGN_RUNNER\" (project) not found in runners.json; ignoring this layer" >&2
     DESIGN_RUNNER=""
   fi
   if [[ -z "$DESIGN_RUNNER" ]]; then
     DESIGN_RUNNER=$(jq -r '.design_runner // empty' \
       ~/.claude/cmux-team-dispatch-task/config.json 2>/dev/null)
     if [[ -n "$DESIGN_RUNNER" ]] && ! valid_design_runner "$DESIGN_RUNNER"; then
       echo "[warn] design_runner=\"$DESIGN_RUNNER\" (global) not found in runners.json; ignoring this layer" >&2
       DESIGN_RUNNER=""
     fi
   fi
   ```

   - A value that matches `runners[].name` → assign it to every task and skip both
     the switch and per-task questions (regardless of runner count).
   - `"ask"` (explicit) → use the interactive flow below in its **ask form** (No / Yes /
     reset; a user who reverted from an "always ..." choice back to `"ask"` is not shown
     the persistence options again).
   - Empty (both layers unset, or every layer that was set held an invalid value) →
     use the interactive flow below in its **unset form** (with persistence options —
     even after an invalid value, the user can pick a valid one and save it directly).
3. **Interactive flow**:
   - If exactly **1** runner is registered → silently assign that runner to all tasks
     and skip the switch question (no question and no persistence in either form).
     Continue to Step 1g.
   - If **2 or more** runners are registered → ask the user via AskUserQuestion:
     > Switch the runtime/model per child session? (default: No — apply the default runner to every task)
     Options 1–2 are shared by both forms:
       1. No (this time only) → assign the `default` runner from `runners.json` to all
          tasks. Do not write to config.
       2. Yes (this time only) → for each task, ask which runner to use via AskUserQuestion.
          The options are the entries in `runners[]` (label = `name`, description =
          `command (engine)`). Do not write to config.
     The **ask form** adds option 3; the **unset form** offers options 1–4:
       3. In the ask form: Reset `runners.json` and rerun setup.
          In the unset form: Save a runner preference → ask a 2-choice follow-up:
          - Always use the default runner (`<default>`) → assign it to all tasks and
            persist `design_runner: "<default>"` to the global config.
          - Always pick a fixed runner → ask once more which runner to fix (options =
            `runners[]`, label = `name`, description = `command (engine)`), assign it to
            all tasks, and persist `design_runner: "<name>"` to the global config.
       4. In the unset form: Reset `runners.json` and rerun setup.
     The reset option sets `RUNNERS_RESET=true` and removes only `"$RUNNERS_JSON"`
     (`rm -f -- "$RUNNERS_JSON"`). Immediately run **First-run setup** in reset mode,
     which skips every config-persistence question, then restart Step 1f runner resolution
     with the newly written registry. This keeps both project and global `config.json`
     unchanged throughout reset and re-setup.
     Persistence under the save follow-up uses the same jq merge pattern as `review_mode`
     in Step 1g below (key: `design_runner` — a writer-specific mktemp, moved only on jq
     success). There are two distinct ways to revert an "always ..." choice, and they mean
     different things: rewriting `design_runner` to `"ask"` restores the ask form (including
     reset, but no persistence options), while deleting the key restores the unset form.
4. Resolve the design role for every task from that runner record and carry all three
   values forward: `DESIGN_RUNNER`, `DESIGN_ENGINE`, and `PLAN_MODEL`. `PLAN_MODEL` is
   the runner's `plan_model` for codex; for claude it is the explicitly selected plan
   model, normally `opus[1m]`. Step 2 passes `--runner "$DESIGN_RUNNER"` on every
   prewarm and non-prewarm design launch. Do not infer the design model from the engine.

   ```bash
   # Resolve the design role's model and effort with the same table launch-workspace.sh uses.
   PLAN_MODEL=$(jq -r --arg n "$DESIGN_RUNNER" \
     '.runners[] | select(.name == $n) | .plan_model // empty' "$RUNNERS_JSON")
   PLAN_EFFORT=$(jq -r --arg n "$DESIGN_RUNNER" \
     '.runners[] | select(.name == $n) | .plan_effort // empty' "$RUNNERS_JSON")
   [[ -z "$PLAN_MODEL" && "$DESIGN_ENGINE" == "claude" ]] && PLAN_MODEL="opus[1m]"
   [[ -z "$PLAN_EFFORT" ]] && PLAN_EFFORT="xhigh"
   ```
5. **Resolve the independent review role.** Read `review_runner` with exact precedence
   project config → global config → legacy automatic resolver. Validate each configured
   layer independently: `"ask"` is valid and stops fallback; any other value must name a
   registered runner. A codex candidate is review-capable only when its `review_model` is
   non-empty. A claude candidate is review-capable and may fall back to `opus[1m]`. An
   invalid or incapable project/global value warns, invalidates only that layer, and
   continues to the next layer. The review runner may have the same engine, or even the
   same runner name, as the design runner.

   - fixed runner name → `REVIEW_POLICY=fixed`; resolve `REVIEW_RUNNER`,
     `REVIEW_ENGINE`, `REVIEW_MODEL`, and `REVIEW_PANE_AGENT=<task-slug>-review` from
     that runner. The one dedicated review pane handles both Phase A-R and Phase B-R.
   - `"ask"` → ask once per dispatch from all review-capable runners, without filtering
     out the design engine; the answer becomes the fixed policy for this dispatch only.
   - key absent in both layers → `REVIEW_POLICY=legacy`; preserve the v1.17.0 automatic
     cross-engine resolver. For design=claude, select a review-model-bearing codex
     runner. For design=codex, select a claude runner (one silently, multiple via the
     existing question) and use its `review_model` or `opus[1m]`. Store that resolver's
     result in the same `REVIEW_RUNNER` / `REVIEW_ENGINE` / `REVIEW_MODEL` variables and
     set `REVIEW_PANE_AGENT=<task-slug>-review`; downstream prompt and spawn code never
     recomputes an engine relationship.

   If `review_mode=on` but no review-capable runner is resolved, warn and disable review
   only for the affected task. Do not rewrite `review_mode`. If a review-pane spawn
   fails, warn, skip that task's quality gate, and continue to Phase B.

**runners.json schema (minimal):**

```json
{
  "default": "claude",
  "runners": [
    { "name": "claude", "command": "claude", "engine": "claude",
      "plan_model": "opus[1m]", "review_model": "opus[1m]", "exec_model": "fable",
      "plan_effort": "max", "review_effort": "xhigh", "exec_effort": "high" },
    { "name": "codex", "command": "codex", "engine": "codex",
      "plan_model": "gpt-5.6-sol", "review_model": "gpt-5.6-sol", "exec_model": "gpt-5.6-terra",
      "plan_effort": "xhigh", "review_effort": "xhigh", "exec_effort": "high" }
  ]
}
```

Field meanings:

- `name`: unique identifier shown in AskUserQuestion options
- `command`: the executable / zsh function to invoke
- `engine`: `claude` or `codex` — controls flag composition (see table below)
- `plan_model` / `review_model` / `exec_model` (optional, **both engines**): the model for
  that role. `launch-workspace.sh` resolves them from `--role`.
- `plan_effort` / `review_effort` / `exec_effort` (optional, **both engines**): the
  reasoning effort for that role. claude accepts `low|medium|high|xhigh|max` and receives
  `--effort <value>`; codex accepts `minimal|low|medium|high|xhigh` and receives
  `-c model_reasoning_effort='<value>'`.

Defaults when a field is unset:

| role | claude model | codex model | effort (both engines) |
|------|--------------|-------------|-----------------------|
| plan | `opus[1m]` | none (codex-side default) | `xhigh` |
| review | `opus[1m]` | required when chosen as reviewer | `xhigh` |
| exec | `sonnet` | none (codex-side default) | `high` |

Resolution order for both model and effort:
`--model` / `--effort` explicit > the runner's `<role>_model` / `<role>_effort` > the table above.

**engine × MODE invocation table** (executed by `launch-workspace.sh`):

| engine | MODE        | Composed command                                                                                          |
|--------|-------------|-----------------------------------------------------------------------------------------------------------|
| claude | plan        | `<command> [--model <plan_model>] [--effort <plan_effort>] --dangerously-skip-permissions '/plan Read and follow the task in .cmux-team-dispatch-task-prompt.md'` |
| claude | superpowers | `<command> [--model <plan_model>] [--effort <plan_effort>] 'Read and follow the task in .cmux-team-dispatch-task-prompt.md'` |
| claude | execute     | `<command> [--model <exec_model>] [--effort <exec_effort>] [--dangerously-skip-permissions] 'Read and execute the plan at <plan-file>'` |
| codex  | plan        | `<command> [-c model_reasoning_effort='<plan_effort>'] [--model <plan_model>] --dangerously-bypass-approvals-and-sandbox '/plan Read and follow the task in .cmux-team-dispatch-task-prompt.md'` |
| codex  | superpowers | `<command> [-c model_reasoning_effort='<plan_effort>'] [--model <plan_model>] --dangerously-bypass-approvals-and-sandbox '$superpowers:brainstorming Read and follow the task in .cmux-team-dispatch-task-prompt.md'`   |
| codex  | execute     | `<command> [-c model_reasoning_effort='<exec_effort>'] [--model <exec_model>] --dangerously-bypass-approvals-and-sandbox 'Read and execute the plan at <plan-file>'` |
| codex  | review      | `<command> [-c model_reasoning_effort='<review_effort>'] --model <review_model> --sandbox workspace-write -c approval_policy='never' --add-dir <STATUS_DIR>` |

`execute` mode is used in Phase B (the implementation phase) to hand implementation off
to a separate surface. `--plan-file <path>` specifies the plan file path, and
`.cmux-team-dispatch-task-prompt.md` is not rewritten (the Phase A one is preserved). For
the claude engine, `--model` / `--effort` are resolved from the role fallback table above
and `--skip-permissions` can be added (for models such as sonnet where auto mode does not
work). For the codex engine, the runner's `exec_model` is applied as a fallback when
`--model` is not specified (execute / standby only; review always specifies
`review_model` explicitly); when still unset, codex's own default model applies.

Reasoning effort resolves the same way on both engines, with priority: explicit
`--effort` > runner field (plan_effort: plan/superpowers, review_effort: review,
exec_effort: execute/standby) > the default table above (`xhigh` for plan/review, `high`
for exec). claude receives it as `--effort <value>`; codex receives it as
`-c model_reasoning_effort='<value>'` immediately after `<command>`. Because the
prewarm design codex pane launches with `--mode standby`, `prewarm-panes.sh` passes
`--role plan`; the launcher's role resolver applies both `plan_model` and
`plan_effort`.

The composed command is always wrapped: `zsh -ic "<composed>"` so that `~/.zshrc`
functions (e.g. `ccenec`) and env (proxy auth, PATH) are loaded for the child session.

Regardless of MODE, when the resolved runner engine is `claude`, the script
injects `permissions.defaultMode: "bypassPermissions"` into the worktree's
`.claude/settings.local.json` (merged with `jq`, atomically via `mktemp` + `mv`,
and skipped when the key already holds that value). This is what keeps normal
(non-loop) dispatches free of permission prompts without adding
`--dangerously-skip-permissions` to every launch path.

`AskUserQuestion` stays interactive under that mode: the permission system gates
tool calls, while `AskUserQuestion` and `ExitPlanMode` are interactive UIs that a
TUI session renders regardless of the permission mode. Only a non-interactive
session needs a `PreToolUse` hook to answer them. This is why the brainstorming
dialog of superpowers mode still works.

The bypass-mode confirmation dialog is raised by both
`--dangerously-skip-permissions` and `defaultMode: "bypassPermissions"`, and the
`skipDangerousModePermissionPrompt` setting that suppresses it is ignored in
project settings. Put it in the user-level `~/.claude/settings.json` instead.

The codex engine is unaffected: it does not read `.claude/settings.local.json`,
and it already avoids prompts through
`--dangerously-bypass-approvals-and-sandbox` (or, for review panes,
`--sandbox workspace-write` with `-c approval_policy='never'`).


**First-run setup** (when `runners.json` does not exist, including immediately after
reset, and when `--setup` selects the registry as a target):

1. Show the user via AskUserQuestion:
   > runners.json was not found. Running first-run setup.
   >
   > 1. **starter template (claude only)** — simple start, add more manually later
   > 2. **custom** — register runners one at a time interactively (claude / codex / zsh function / etc.)

2. **If the starter template is chosen**: write the file with a single `claude` runner
   (using the schema above) and continue:

   ```json
   {
     "default": "claude",
     "runners": [
       { "name": "claude", "command": "claude", "engine": "claude" }
     ]
   }
   ```

3. **If custom is chosen**: enter an AskUserQuestion loop. For each runner, collect
   fields (one AskUserQuestion call per runner is ideal — use the question text
   format below; collect all answers, then ask whether to add another):

   - **name** (free text, e.g. `ccenec`) — unique identifier
   - **command** (free text, e.g. `ccenec` or `codex` or `claude`) — what to invoke
   - **engine** (choice: `claude` / `codex`)
   - **plan_model** (free text, asked when engine is `codex`, e.g. `gpt-5.6-sol`) —
     the model for Phase A plan/brainstorming. May be left blank for the codex default.
   - **review_model** (free text) — when engine is `codex`: the model used for Phase
     A-R/B-R review (e.g. `gpt-5.6-sol`). When engine is `claude`: the model used when
     this runner is chosen as the reviewer for design=codex tasks (e.g. `opus[1m]`).
     May be left blank to omit.
   - **exec_model** (free text, asked only when engine is `codex`, e.g. `gpt-5.6-terra`) —
     the model for Phase B's execution paths (execute / standby). May be left blank to
     omit (uses the codex-side default).
   - **plan_effort / review_effort / exec_effort** (choice: blank / minimal / low / medium /
     high / xhigh; asked only when engine is `codex`) — reasoning effort for design /
     review / execution. May be left blank to omit (uses the codex-side config.toml
     default).

   After each runner is added, ask: "Add another one?" (Yes → loop; No → finish).

4. After at least one runner is registered, also ask which runner is the `default`
   (used when the user picks "No" at the switch question, or implicitly when only
   1 runner exists). If only one runner was added, it becomes `default` automatically.

5. If `RUNNERS_RESET=true`, skip review-behavior selection and do not write either config
   file. Otherwise ask for review behavior: **legacy automatic**, **choose every dispatch**,
   or **fixed runner**. Legacy automatic leaves `review_runner` absent. Choose every
   dispatch persists `review_runner: "ask"`; fixed runner asks from the review-capable
   runners and persists that name. Persistence is only for `"ask"` or a fixed runner
   name and uses the writer-specific `mktemp "$CONFIG.XXXXXX"` + successful `mv`
   pattern from Step 1g; never write through a shared temp path.
6. Write the assembled object to `~/.claude/cmux-team-dispatch-task/runners.json`
   (create the directory if missing). Then continue to the runner selection logic above.

There are three ways to fix the normal questions: answer "always ..." during a dispatch,
run `--setup` (see [`references/setup-mode.md`](references/setup-mode.md)), or edit
config.json by hand. All of them write the same role keys, and project config overrides
global config:

```json
{
  "design_runner": "codex",
  "review_runner": "codex",
  "exec_choice": "codex",
  "review_mode": "on",
  "prewarm": true
}
```

With a codex runner configured with `plan_model: "gpt-5.6-sol"`,
`review_model: "gpt-5.6-sol"`, and `exec_model: "gpt-5.6-terra"`, this is an
all-Codex dispatch: no claude command, claude pane, or claude agmsg wiring is created.

To restore the interactive flow there are TWO distinct ways: set the key to `"ask"`
(questions only — the persistence options stay hidden), or remove the key entirely
(back to unset — the questions reappear WITH the persistence options). `--setup` offers
both, and `--reset config` removes the keys.

### 1g. Resolve Delivery, Review Mode and Execution Default

**There is no notification-transport question and no `message_type` config key.**
agmsg is wired whenever `~/.agents/skills/agmsg/scripts/send.sh` exists; when it does
not, the dispatch simply runs without agmsg wiring. Nothing is asked and nothing is
persisted about it.

```bash
AGMSG_INSTALLED=false
[[ -f ~/.agents/skills/agmsg/scripts/send.sh ]] && AGMSG_INSTALLED=true
```

`monitor-dispatch.sh` is launched ONLY when agmsg is not installed (see Step 3).
`--message-type` was removed from `launch-workspace.sh` and `prewarm-panes.sh`;
passing it now dies with a `was removed` message.

**Delivery contract (applies to EVERY message this skill sends).** All delivery goes
through one call to `scripts/send-prompt.sh` — never a raw `cmux send`: <!-- send-prompt-exempt: prohibition, not a delivery instruction -->

```bash
# --to-surface <id> targets a pane; use --to-workspace <id> instead when the
# destination is a whole workspace (the parent). Exactly one of them is required.
bash <SKILL_DIR>/scripts/send-prompt.sh \
  --to-surface <TARGET_SURFACE> \
  --agmsg-team "$TEAM" --agmsg-to <TARGET_AGENT> --agmsg-from <YOUR_AGENT_NAME> \
  --label <label> --outbox-dir <STATUS_DIR>/outbox \
  -- '<message text>'
```

- It **always types the message into the target pane**. Typing is the only thing that
  wakes an idle session, so this half is never optional.
- When the three `--agmsg-*` arguments are given AND the destination's ready sentinel
  (`~/.agents/skills/agmsg/run/ready.<team>__<agent>`) exists, it **additionally
  records the same body in the agmsg inbox**, always AFTER the typed delivery. That
  record is not a wake mechanism; an agmsg failure never affects delivery or the exit
  code, and a hung agmsg writer can never block the only thing that wakes the
  destination. Drop all three `--agmsg-*` flags when `$TEAM` is empty.
- Bodies longer than 400 characters are written to `<outbox-dir>/<label>-<seq>.md` and
  only a one-line pointer is typed. This is what stops a long instruction from being
  treated as a paste and jamming the input box.
- After typing it presses Enter, then confirms via `cmux read-screen` that the input
  box emptied, re-pressing Enter up to 3 times before reporting failure. The check
  applies **when the destination renders a `❯` (or `>`) prompt line at column 0**,
  which is how the input box is located; on a pane that renders no such line the
  message is treated as delivered without verification. An unobservable screen counts
  as delivered too, not as failure, so a caller never re-sends and double-delivers.
- Exit codes: 0 = delivered, 1 = delivery failed, 2 = usage error.

`<label>` groups the outbox files of one call site. Use exactly these:

| Call site | label |
|-----------|-------|
| Phase A task handed to the design pane | `phase-a-task` |
| Phase B execution request to a standby pane | `phase-b-exec` |
| Phase A-R plan/spec review request | `review-plan` |
| Phase B-R code review request | `review-code` |
| Abort notice to the reviewer (from the implementer or the runner wrapper) | `abort-reviewer` |
| Completion / abort notice to the parent | `dispatch-notify` |
| `monitor-dispatch.sh` heartbeat / all-done / DIED notice to the parent | `dispatch-monitor` |

**Resolve review mode (`review_mode`)** — precedence: project config → global config → ask.
Resolve the independent review role from Step 1f first; `REVIEW_POLICY`,
`REVIEW_RUNNER`, `REVIEW_ENGINE`, and `REVIEW_MODEL` are the only review inputs used
below. A fixed policy never substitutes a different runner based on the design or
implementation engine.

1. Read `review_mode` from `<project>/.dispatch/config.json`, falling back to
   `~/.claude/cmux-team-dispatch-task/config.json`:

   ```bash
   REVIEW_MODE=$(jq -r '.review_mode // empty' .dispatch/config.json 2>/dev/null)
   [[ -z "$REVIEW_MODE" ]] && REVIEW_MODE=$(jq -r '.review_mode // empty' \
     ~/.claude/cmux-team-dispatch-task/config.json 2>/dev/null)
   ```

   If set to `"on"` or `"off"`, use it silently — do NOT ask (permanent opt-in/out).

   If unset or `"ask"`:
   - `REVIEW_RUNNER` unresolved → treat as `off` for that task. Do NOT ask and do NOT
     write config, so the question starts firing once a capable reviewer is available.
   - `REVIEW_RUNNER` resolved → ask via AskUserQuestion **on EVERY dispatch, BEFORE
     launching any task** (this question is part of Step 1, alongside 1c-1f):
     > Use review mode? (Phase A-R: review the plan/spec with `<review_runner>` / `<review_model>` until approved; Phase B-R: use the same resolved review policy after implementation, before creating the PR)
     Options:
       1. Yes (this time only) → `REVIEW_MODE=on`. Do not write to config.
       2. No (this time only)  → `REVIEW_MODE=off`. Do not write to config.
       3. Always on            → `REVIEW_MODE=on`. Persist `review_mode: "on"` to the global config.
       4. Always off           → `REVIEW_MODE=off`. Persist `review_mode: "off"` to the global config.
     Persistence (options 3/4 only) writes the GLOBAL config with this jq merge pattern
     (key: `review_mode`) — the canonical pattern every "always ..." answer in this
     skill uses:

     ```bash
     CONFIG=~/.claude/cmux-team-dispatch-task/config.json
     mkdir -p "$(dirname "$CONFIG")"
     # A writer-specific temp file — a shared "$CONFIG.tmp" would be corrupted by concurrent
     # writes. Only mv when jq succeeds (jq fails if the existing config is invalid JSON —
     # mv-ing anyway would zero out config, so on failure remove tmp, warn, and give up on
     # persistence).
     if TMP=$(mktemp "$CONFIG.XXXXXX"); then
       if { [[ -f "$CONFIG" ]] && jq --arg v "<answer>" '.review_mode = $v' "$CONFIG" > "$TMP"; } \
          || { [[ ! -f "$CONFIG" ]] && jq -n --arg v "<answer>" '{review_mode: $v}' > "$TMP"; }; then
         mv "$TMP" "$CONFIG"   # mv within the same directory = atomic replace (whole-file last-write-wins)
       else
         rm -f "$TMP"; echo "[warn] config write failed (existing config broken?); persistence skipped" >&2
       fi
     else
       echo "[warn] mktemp failed; persistence skipped" >&2
     fi
     ```

     To return to asking every time after choosing "always ...", rewrite `review_mode`
     in config to `"ask"` (or delete it).

2. Compute the final per-task flag used by prompt construction (Step 2) and prewarm:

   ```bash
   REVIEW_ENABLED=false
   if [[ "$REVIEW_MODE" == "on" && -n "$REVIEW_RUNNER" ]]; then
     REVIEW_ENABLED=true
   elif [[ "$REVIEW_MODE" == "on" ]]; then
     echo "[warn] review_mode=on but no review-capable runner was resolved; disabling review for this task" >&2
   fi
   ```

   This never writes `review_mode: off`; another task in the same dispatch may still
   have a capable legacy reviewer. A fixed reviewer is valid when its engine equals
   `DESIGN_ENGINE` or the eventual `EXEC_ENGINE`.

**Resolve execution default (`exec_choice`)** — same precedence pattern:

```bash
# Return the registered runner that can execute on the requested engine. Prefer the
# already-resolved design runner when its engine matches; otherwise use the first
# registered runner of that engine. A missing record returns non-zero.
resolve_exec_runner() {
  local required_engine="$1" preferred
  case "$required_engine" in
    claude|codex) ;;
    *) return 1 ;;
  esac

  preferred=$(jq -r --arg n "$DESIGN_RUNNER" --arg e "$required_engine" \
    '.runners[]? | select(.name == $n and .engine == $e and (.command // "") != "") | .name' \
    "$RUNNERS_JSON")
  if [[ -n "$preferred" ]]; then
    printf '%s\n' "$preferred"
    return 0
  fi

  jq -er --arg e "$required_engine" \
    '[.runners[]? | select(.engine == $e and (.name // "") != "" and (.command // "") != "") | .name][0] // empty' \
    "$RUNNERS_JSON"
}

# Valid values = "claude" | "codex" | "ask". "ask" is valid and stops fallback. A fixed
# engine is valid only when a runner of that engine can be resolved. Invalid values or
# unavailable engines warn, invalidate only that config layer, and continue
# project -> global -> interactive fallback. The pre-v1.20.0 per-role values that
# selected the claude opus[1m] / sonnet models directly are no longer accepted; they
# invalidate their layer like any other bad value.
valid_exec_choice() {
  case "$1" in
    ask) return 0 ;;
    claude|codex) resolve_exec_runner "$1" >/dev/null ;;
    *) return 1 ;;
  esac
}
EXEC_CHOICE=$(jq -r '.exec_choice // empty' .dispatch/config.json 2>/dev/null)
if [[ -n "$EXEC_CHOICE" ]] && ! valid_exec_choice "$EXEC_CHOICE"; then
  echo "[warn] exec_choice=\"$EXEC_CHOICE\" (project) invalid (expected: claude | codex | ask); ignoring this layer" >&2
  EXEC_CHOICE=""
fi
if [[ -z "$EXEC_CHOICE" ]]; then
  EXEC_CHOICE=$(jq -r '.exec_choice // empty' \
    ~/.claude/cmux-team-dispatch-task/config.json 2>/dev/null)
  if [[ -n "$EXEC_CHOICE" ]] && ! valid_exec_choice "$EXEC_CHOICE"; then
    echo "[warn] exec_choice=\"$EXEC_CHOICE\" (global) invalid (expected: claude | codex | ask); ignoring this layer" >&2
    EXEC_CHOICE=""
  fi
fi

# Resolve the execution role's runner, engine, model, and effort. Do not infer them
# later from the choice; the same resolved values decide the in-session rule below.
EXEC_RUNNER=""
EXEC_ENGINE=""
EXEC_MODEL=""
EXEC_EFFORT=""
CLAUDE_EXEC_RUNNER=""
CODEX_EXEC_RUNNER=""
if [[ -n "$EXEC_CHOICE" && "$EXEC_CHOICE" != "ask" ]]; then
  EXEC_RUNNER=$(resolve_exec_runner "$EXEC_CHOICE")
  EXEC_ENGINE="$EXEC_CHOICE"
  EXEC_MODEL=$(jq -r --arg n "$EXEC_RUNNER" \
    '.runners[] | select(.name == $n) | .exec_model // empty' "$RUNNERS_JSON")
  EXEC_EFFORT=$(jq -r --arg n "$EXEC_RUNNER" \
    '.runners[] | select(.name == $n) | .exec_effort // empty' "$RUNNERS_JSON")
  [[ -z "$EXEC_MODEL" && "$EXEC_ENGINE" == "claude" ]] && EXEC_MODEL="sonnet"
  [[ -z "$EXEC_EFFORT" ]] && EXEC_EFFORT="high"
else
  # ask/unset advertises every available engine. Resolve its candidates now so
  # prewarm never falls through to the launcher's default command.
  CLAUDE_EXEC_RUNNER=$(resolve_exec_runner claude 2>/dev/null || true)
  CODEX_EXEC_RUNNER=$(resolve_exec_runner codex 2>/dev/null || true)
fi
```

```bash
# In-session execution: the design session implements the task itself instead of
# delegating. Effort is part of the condition because it is baked in at session launch
# and cannot be changed afterwards — matching only the model would silently run the
# execution phase at the design session's effort and ignore exec_effort.
# With EXEC_CHOICE="ask" the engine is not known yet; the child evaluates the same
# condition right after its Phase B answer.
IN_SESSION=false
if [[ -n "$EXEC_CHOICE" && "$EXEC_CHOICE" != "ask" \
   && "$EXEC_ENGINE" == "$DESIGN_ENGINE" \
   && "$EXEC_MODEL" == "$PLAN_MODEL" \
   && "$EXEC_EFFORT" == "$PLAN_EFFORT" ]]; then
  IN_SESSION=true
fi
```

- Empty (both layers unset, or every layer that was set held an invalid value) → embed
  the existing AskUserQuestion Phase B block **plus the persistence follow-up block**
  (see the `{{EXEC_DEFAULT_HINT}}` placeholder rules — a confirmation question that lets
  the child session persist an "always ..." choice to the global config right after
  the selection).
- `"ask"` (explicit) → embed the existing AskUserQuestion Phase B block only (no
  persistence confirmation — not shown again to a user who reverted from "always ..."
  back to `"ask"`).
- `"claude"` / `"codex"` (a valid value that passed layer validation) →
  embed its default-direct Phase B block.

**When agmsg is installed (`AGMSG_INSTALLED=true`), wire the team BEFORE launching (Step 2):**

```bash
TEAM="dispatch-$(basename "$(git rev-parse --show-toplevel)")"
PARENT_ENGINE="claude"
[[ -n "${CODEX_THREAD_ID:-}" ]] && PARENT_ENGINE="codex"
PARENT_AGMSG_TYPE=$(bash <SKILL_DIR>/scripts/resolve-agmsg-type.sh --engine "$PARENT_ENGINE") || exit 1
# Join the parent (if already a member, join.sh treats it as a re-registration), and enable real-time push
~/.agents/skills/agmsg/scripts/join.sh "$TEAM" parent "$PARENT_AGMSG_TYPE" "$(pwd)"
~/.agents/skills/agmsg/scripts/delivery.sh set monitor "$PARENT_AGMSG_TYPE" "$(pwd)"
```

`PARENT_AGMSG_TYPE` must match the current orchestrator runtime. Codex sets
`CODEX_THREAD_ID`, so an all-Codex dispatch resolves this to `codex`; Claude Code
compatibility resolves it to `claude-code`. Do not derive the parent type from a child
runner.

When agmsg is NOT installed, leave `TEAM` empty, skip this whole block, and drop the
`--agmsg-*` flags everywhere below. Delivery still works — it is just typed-only.

`delivery.sh set` may print an `AGMSG-DIRECTIVE:` line — the SessionStart
hook it installs only takes effect for FUTURE sessions, so the directive is
how the CURRENT session activates delivery. If the output contains such a
line, follow it (invoke the Monitor tool exactly as instructed) BEFORE
launching tasks. Note the watcher is a record/reply channel, not a wake
mechanism: its stream output is never injected while this session is idle,
which is why `send-prompt.sh` always types the message in as well.

Each launch then adds `--agmsg-team "$TEAM" --agmsg-from <task-slug>` to
`launch-workspace.sh`. After each task's worktree exists (launch script returned),
register the child:

```bash
CHILD_AGMSG_TYPE=$(bash <SKILL_DIR>/scripts/resolve-agmsg-type.sh --engine "$DESIGN_ENGINE") || exit 1
~/.agents/skills/agmsg/scripts/join.sh "$TEAM" <task-slug> "$CHILD_AGMSG_TYPE" "<repo-root>/.worktrees/<task-slug>"
```

Resolve `CHILD_AGMSG_TYPE` per task from that task's already-resolved `DESIGN_ENGINE`.
Do not infer it from the parent runtime or from another role.

When the pre-warm path is active (workspace layout + `prewarm: true`), skip
this manual `join.sh` — `prewarm-panes.sh` already joins the design agent
(`<task-slug>`) and the standby agents (`<task-slug>-claude` / `-codex`) and
wires delivery into the worktree before any pane starts.

Additionally, append this block to every child prompt's status protocol section:

```
You can message the parent directly at any time (questions, progress):
  ~/.agents/skills/agmsg/scripts/send.sh <team> <task-slug> parent "<message>"

MANDATORY completion notification: immediately after writing done/error to
status.json, notify the parent yourself with ONE send-prompt.sh call:
  bash <SKILL_DIR>/scripts/send-prompt.sh --to-workspace <PARENT_WORKSPACE_ID> \
    --agmsg-team <team> --agmsg-to parent --agmsg-from <task-slug> \
    --label dispatch-notify --outbox-dir <STATUS_DIR>/outbox \
    -- "[dispatch] task \"<task-slug>\" finished (status: <done|error>)"
Drop the three --agmsg-* flags when <team> is empty. send-prompt.sh types the
message into the parent pane (the only thing that wakes an idle parent) and,
when the parent's agmsg watcher is alive, also records the same text in its
inbox — that record is a log, not a wake mechanism. Do NOT rely on session
exit either: the runner wrapper notifies on exit as a backstop, but an idle
TUI session never exits, and when agmsg is installed no monitor loop is
running, so without this call the parent may never be informed.
```

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

Surface IDs are not yet known at this point; print `pending` in that column. After Step 2 launches, re-print using Template A again with concrete `surf:N` values.

---

## Step 2: Launch Sessions

### Prompt File Approach

The launch script writes the full prompt to a `.cmux-team-dispatch-task-prompt.md` file in each
child's working directory (worktree). The Claude command sent via cmux only references
this file, completely avoiding shell escaping issues with complex prompt content.

### Runner Script Wrapper

The launch script generates a `.cmux-team-dispatch-task-run-<workspace-name>.sh` script in
each child's working directory (worktree). The filename includes the workspace name to keep
Child (e.g., `<slug>`) and Phase B grandchild (e.g., `<slug>-exec`) runner files isolated
when they share the same worktree — overwriting an in-flight runner script causes bash to
read undefined content. Instead of sending `claude ...` directly to the terminal, the launcher
sends `bash .cmux-team-dispatch-task-run-<workspace-name>.sh`, which:

1. Updates `status.json` to `"executing"` using absolute paths
2. Runs the `claude` command interactively
3. After Claude exits (for any reason), writes `"done"` or `"error"` to `status.json`
4. Signals completion via `cmux wait-for --signal <slug>-done`
5. Optionally notifies the parent workspace via `cmux notify`
6. Delivers the `[dispatch] task ... finished (status: ...)` text to the parent through
   `scripts/send-prompt.sh` (`--label dispatch-notify`), which types it in and verifies
   the Enter landed, and additionally records it in the parent's agmsg inbox when
   `--agmsg-team` / `--agmsg-from` were given and the parent's watcher is alive

**Deferred completion (`--defer-status`)**: When the launch script is invoked with
`--defer-status` (always done by `launch-workspace.sh` for Child sessions), the
runner wrapper inserts a check before step 3: if `<STATUS_DIR>/.deferred` exists at
claude-exit time, steps 3–5 are skipped. This lets a Child that has spawned a Phase B
grandchild bow out without overwriting the grandchild's `status.json` update. The
grandchild (launched via `launch-workspace.sh --mode execute`) has its own runner
wrapper that owns the final `done`/`error` transition.

The signal name for each task is `<task-slug>-done`, returned in the `signal_name` field
of the launch script's output JSON. For Phase B grandchildren spawned via `--mode execute`,
the signal name is `<task-slug>-exec-done` (or whatever workspace name was passed).

### Building the Task Prompt

For each task, construct the full prompt text. **Order matters** — put behavioral directives
first, then the task content:

1. **Brainstorming directive** (for tasks selected in Step 1c, prepend):

```
=== MANDATORY EXECUTION SEQUENCE ===
You are running in superpowers mode with a STRICT execution sequence.
You MUST follow these phases IN ORDER. Skipping any phase is a critical error.

PHASE 1 — BRAINSTORMING (required, do this FIRST):
  Use the Skill tool to invoke "superpowers:brainstorming" immediately.
  Do NOT read any files, do NOT make any plans, do NOT write any code before
  completing brainstorming.
  The brainstorming skill will:
  - Explore the project context and understand the codebase
  - Design your approach with trade-offs considered
  - Naturally transition to PHASE 2 when complete

PHASE 2 — PLANNING (automatic transition from brainstorming):
  After brainstorming completes, you will be in writing-plans mode.
  Write a structured implementation plan.

PHASE 3 — EXECUTION:
  After the plan is approved, execute it.

VIOLATION: If you start writing code or making changes without completing
Phase 1 (brainstorming) and Phase 2 (planning), you are operating incorrectly.
Stop and use the Skill tool to invoke "superpowers:brainstorming".
=== END MANDATORY EXECUTION SEQUENCE ===
```

2. **Available Agents block** (if agents were discovered in Step 1b):

```
=== AVAILABLE AGENTS ===
The following agent definitions are available in .claude/agents/.
Read the one that best matches your task and follow its guidelines.
If none are relevant, proceed without an agent.

- backend-coding (.claude/agents/backend-coding.md): <description from frontmatter>
- frontend-coding (.claude/agents/frontend-coding.md): <description from frontmatter>
=== END AVAILABLE AGENTS ===
```

3. **Mandatory Model Selection Sequence** (append to EVERY task prompt, regardless of mode).

   This block contains placeholders the parent fills before sending: `{{CODEX_OPTION_LINE}}`,
   `{{CODEX_BEHAVIOR_BLOCK}}`, `{{REVIEW_BLOCK}}`,
   `{{CODE_REVIEW_BLOCK}}`. See the placeholder rules immediately below this template.

```
=== MANDATORY MODEL SELECTION SEQUENCE ===
You will operate in two phases. This sequence is REQUIRED even in auto mode.

OUTPUT LANGUAGE: all user-facing questions, option labels, tables, and progress
reports MUST be rendered in Japanese. The templates in this prompt are written in
English for consistency; translate them when presenting them to the user.

TEAM: {{TEAM}}                     # agmsg team name (empty when agmsg is not installed)

PHASE A — Planning / Brainstorming (resolved design role):
  Runner: {{DESIGN_RUNNER}}; engine: {{DESIGN_ENGINE}}; model: {{PLAN_MODEL}}.
  Use that resolved runner/model for plan / brainstorming. Do NOT infer a model from
  the engine and do NOT switch models in this phase.
  - superpowers mode: invoke "superpowers:brainstorming" then write a plan
  - plan mode: use Claude's built-in /plan to produce a structured plan.
    The plan you present for approval MUST list, BEFORE any implementation
    step:
      Step 0: Phase A-R codex review (only when the PHASE A-R block exists below)
      Step 1: Phase B execution-model selection (per the block below — AskUserQuestion or default direct)
    Executing the approved plan therefore STARTS with Phase A-R / Phase B,
    never with a code change.
    If the plan only exists in the ExitPlanMode message, save it to a file
    (e.g. .claude/plans/<task-slug>.md in this worktree) as your FIRST
    action after approval — Phase B hands the path off via --plan-file.
  Remember the path of the plan file you wrote — Phase B may hand it off.

{{REVIEW_BLOCK}}

{{EXEC_DEFAULT_HINT}}

PHASE B — Execution model selection (REQUIRED before any code change):
  After Phase A completes and BEFORE executing the plan, follow the Phase B flow
  resolved in this task prompt (AskUserQuestion or default direct).

  Question template:
    Q: "Select the engine to use for the execution phase"
    Options:
      1. claude  — in-session when the resolved execution role matches the design
         role's model and effort exactly, otherwise delegates to the claude executor pane
{{CODEX_OPTION_LINE}}

  Behavior by selection:

    [claude] → first determine whether this is in-session execution:
        IN_SESSION is true when EXEC_ENGINE == DESIGN_ENGINE AND EXEC_MODEL ==
        PLAN_MODEL AND EXEC_EFFORT == PLAN_EFFORT (resolved in Step 1f/1g; effort is
        part of the condition because it is baked in at session launch and cannot be
        changed afterwards).

    [IN-SESSION] IN_SESSION == true → continue execution in THIS session. Proceed to
      implement the plan you wrote in Phase A. Do NOT create `.deferred`.

      Leave every other role pane recorded in prewarm.json OPEN and idle — do NOT close
      it. An unassigned standby holds no `.assigned-<name>` sentinel, so it never writes
      status.json. The sparse role set is torn down together only at final cleanup.

    [DELEGATED] IN_SESSION == false → FIRST check for a pre-warmed executor pane:
        PREWARM_FILE="<EXISTING_STATUS_DIR>/prewarm.json"
        CLAUDE_EXEC_SURFACE=$(jq -r '.executors.claude.surface_id // empty' "$PREWARM_FILE" 2>/dev/null)

      IF CLAUDE_EXEC_SURFACE is non-empty (pre-warm path):
        1. Leave every other role pane recorded in prewarm.json OPEN and idle — do NOT
           close it. An unassigned standby holds no `.assigned-<name>` sentinel, so it
           never writes status.json.
        2. touch "<EXISTING_STATUS_DIR>/.assigned-<task-slug>-claude"
           # hands completion ownership (status.json done/error transition +
           # <slug>-claude-done signal + parent notification) to the standby wrapper
        3. Send the execution request with ONE send-prompt.sh call (see the
           delivery contract in Step 1g). It types the text into the standby pane —
           the only thing that wakes it — records the same body in that pane's agmsg
           inbox when its watcher is alive, spills anything over 400 characters to
           the outbox so a long instruction cannot jam the input box, and verifies
           that the Enter landed:
             PARALLEL=$(bash <SKILL_DIR>/scripts/parallel-directive.sh --engine claude --mode execute)
             REQUEST_TEXT="Read and execute the plan at <PLAN_FILE_PATH>. $PARALLEL After all work is
             committed/pushed and the PR is created (or all changes are merged per
             the plan), run /exit to close this session. Do not leave it idle."
             # standby is an execution pane, so pass --mode execute (the script has no
             # standby mode). The exit instruction MUST stay last.
             # IF the PHASE B-R block exists below, do NOT use this REQUEST_TEXT —
             # use the extended REQUEST_TEXT defined in that block instead (it inserts
             # the pre-PR code-review protocol).
             bash <SKILL_DIR>/scripts/send-prompt.sh --to-surface "$CLAUDE_EXEC_SURFACE" \
               --agmsg-team "$TEAM" --agmsg-to <task-slug>-claude --agmsg-from <task-slug> \
               --label phase-b-exec --outbox-dir "<EXISTING_STATUS_DIR>/outbox" \
               -- "$REQUEST_TEXT"
             # $TEAM is the TEAM value given above — do NOT re-derive it in this session.
             # Drop the three --agmsg-* flags when $TEAM is empty. Do NOT branch on
             # prewarm.json's `.executors.claude.delivery`: send-prompt.sh re-checks the ready
             # sentinel itself and simply skips the inbox record when it is gone.
        4. touch "<EXISTING_STATUS_DIR>/.deferred". IF the PHASE B-R block exists,
           call `resolve_code_reviewer_for_choice`: run common protocol b–e only when
           REVIEWER_SURFACE equals your `$CMUX_SURFACE_ID`; otherwise exit THIS session.
           Without Phase B-R, exit THIS session.

      IF prewarm.json is absent (prewarm off), fall back to spawn:
        (unchanged — the steps below are the current spawn procedure verbatim)
        zsh <SKILL_DIR>/scripts/launch-workspace.sh \
          --cwd "$PWD" \
          --mode execute \
          --plan-file <PLAN_FILE_PATH> \
          --runner "$EXEC_RUNNER" \
          [--model "$EXEC_MODEL"] \
          --skip-permissions \
          --status-dir "<EXISTING_STATUS_DIR>" \
          --parent-notify-workspace <PARENT_WORKSPACE_ID> \
          [--parent-notify-surface <PARENT_SURFACE_ID>] \
          [--review-config "<EXISTING_STATUS_DIR>/review/code-review.json"]  # only when PHASE B-R is present
          <task-slug>-exec
        IF the PHASE B-R block exists below, BEFORE the launch above call
        `resolve_code_reviewer_for_choice` from that block and write its coherent
        tuple (the selected pane is not necessarily YOU):
          mkdir -p "<EXISTING_STATUS_DIR>/review"
          resolve_code_reviewer_for_choice
          jq -n --arg s "$REVIEWER_SURFACE" --arg w "$REVIEWER_WORKSPACE" \
            --arg d "<EXISTING_STATUS_DIR>/review" --arg r "$REVIEWER_RUNNER" \
            --arg e "$REVIEWER_ENGINE" \
            '{reviewer_surface: $s, reviewer_workspace: $w, review_dir: $d, reviewer_runner: $r, reviewer_engine: $e}' \
            > "<EXISTING_STATUS_DIR>/review/code-review.json"
          If REVIEWER_SURFACE is empty, omit `--review-config`, warn, and continue
          Phase B without this review gate.
        touch "<EXISTING_STATUS_DIR>/.deferred". IF the PHASE B-R block exists, run
        common protocol b–e only when REVIEWER_SURFACE equals your
        `$CMUX_SURFACE_ID`; otherwise exit THIS session. Without Phase B-R, exit.

{{CODEX_BEHAVIOR_BLOCK}}

{{CODE_REVIEW_BLOCK}}

  Notes on the deferred completion mechanism:
    - Child session (THIS surface) was launched with `--defer-status`, so its
      runner wrapper checks for `<STATUS_DIR>/.deferred` at exit. When the file
      exists, the wrapper skips status.json update, parent notification, and
      `cmux wait-for` emission — letting the grandchild's wrapper own those.
    - When IN_SESSION is true (see the in-session condition above), do NOT create
      `.deferred`. The Child completes implementation in-session and its wrapper
      writes done as usual.

VIOLATION: Do NOT skip Phase B. Follow the exact flow defined in this PHASE B block
(either AskUserQuestion or the default-direct path); do not invent an execution model.
PLAN-MODE TRAP: ExitPlanMode approval ("start implementing") does NOT
override this sequence. After the plan is approved, BEFORE editing any file,
return to this block and complete Phase A-R (if present) then Phase B. Save
the plan to a file first if you have not already.
=== END MANDATORY MODEL SELECTION SEQUENCE ===
```

**codex design variant** (for design=codex tasks, replace PHASE A / PHASE B with the following):

```
PHASE A — Planning / Brainstorming (THIS codex session):
  Runner: {{DESIGN_RUNNER}}; engine: {{DESIGN_ENGINE}}; model: {{PLAN_MODEL}}.
  Produce the plan in THIS session with that resolved plan role. Do NOT switch models
  mid-session.
  - superpowers mode: brainstorm, then write a plan file
  - plan mode: use /plan; the approved plan MUST list Step 0 (Phase A-R, when the
    block exists below) and Step 1 (Phase B selection) BEFORE any implementation
    step, and be saved to a file (e.g. .claude/plans/<task-slug>.md) as the FIRST
    action after approval.
  Remember the plan file path — every Phase B choice hands it off via --plan-file.

PHASE B — Execution model selection (REQUIRED before any code change):
  After Phase A (and Phase A-R when present) completes, follow the Phase B flow
  resolved in this task prompt (AskUserQuestion or default direct):
    Q: "Select the engine to use for the execution phase"
    Options:
      1. claude   — delegates to the claude executor pane
      2. codex    — runs with <exec_model> (recommended for routine implementations, or when
         you want a second perspective; when <exec_model> is unset, write "codex default model")

  Both choices normally DELEGATE to a pre-warmed pane — THIS session does not implement,
  except the in-session exception noted below.
  Common delegation steps (X = chosen key in prewarm.json.executors; NAME = the
  pane's agent name from that object):
    1. Leave the unused standby panes OPEN and idle — do NOT close them.
    2. touch "<EXISTING_STATUS_DIR>/.assigned-<NAME>"
    3. Send the execution request to the pane's surface_id with ONE send-prompt.sh
       call, exactly as the claude variant does:
         bash <SKILL_DIR>/scripts/send-prompt.sh --to-surface <PANE_SURFACE> \
           --agmsg-team "$TEAM" --agmsg-to <NAME> --agmsg-from <task-slug> \
           --label phase-b-exec --outbox-dir "<EXISTING_STATUS_DIR>/outbox" \
           -- "$REQUEST_TEXT"
       (drop the three --agmsg-* flags when $TEAM is empty).
       REQUEST_TEXT: same as the claude variant (execute the plan at
       <PLAN_FILE_PATH>, code-review protocol block when Phase B-R is enabled,
       exit instruction).
    4. touch "<EXISTING_STATUS_DIR>/.deferred"
    5. THEN follow the CODE REVIEW block below for your post-delegation role
       (reviewer or idle).
  Pane-specific notes:
    [claude] target = prewarm.json .executors.claude.
    [codex]  target = prewarm.json .executors.codex (exec_model / exec_effort are baked in
      at pane launch).
    When prewarm.json's .executors is empty ({}), the role config is identical to the
    design session's: do NOT delegate and do NOT create .deferred — implement here.
  IF prewarm.json is absent (prewarm off), fall back to spawning
  via launch-workspace.sh --mode execute exactly as the claude variant does
  with `--runner "$EXEC_RUNNER"` and the resolved `EXEC_MODEL`; no role may fall
  through to launch-workspace.sh's default claude command.
```

**Placeholder rules** (executed by the parent when constructing each child's prompt):

- `{{EXEC_DEFAULT_HINT}}` → resolve `exec_choice` in Step 1g before constructing the
  prompt. When it is valid, replace the entire Phase B AskUserQuestion section in both
  the design=claude template and the design=codex variant with this block (do not leave
  a conflicting AskUserQuestion instruction elsewhere):

  ```text
  PHASE B — Execution engine default is fixed to "<default>" (skip AskUserQuestion):
    After ExitPlanMode, skip AskUserQuestion and immediately run the EXISTING Phase B
    branch for <default>. Do NOT invent a new execution path.
    - claude: run the existing prewarm or spawn claude delegation steps.
    - codex: run the existing prewarm or spawn codex delegation steps.
    - When prewarm.json's .executors is empty, implement in THIS session instead of
      delegating (the role config is identical), and do not create .deferred.
  ```

  When explicitly `"ask"`, substitute an empty hint and retain the existing
  AskUserQuestion section unchanged.

  When **empty** (unset, or every layer that was set held an invalid value), retain
  the existing AskUserQuestion section AND substitute this persistence follow-up block
  (the same block is used for both the design=claude template and the design=codex variant):

  ```text
  PHASE B — Persistence follow-up (exec_choice is unset):
    Immediately after getting the answer to the execution-model AskUserQuestion, and
    BEFORE starting the implementation, ask exactly ONE more AskUserQuestion:
      Q: "Choose how the execution-model selection should behave from now on"
      Options:
        1. This time only — do not save (this confirmation appears again after the
           selection on the next dispatch)
        2. Always use this selection — persist exec_choice="<the value you chose>" to the global config
        3. Always choose every time — persist exec_choice="ask" to the global config
           (the model question keeps firing every time, but this confirmation stops appearing)
    Persistence (options 2/3 only) writes the GLOBAL config (never the project config).
    So that concurrent child sessions writing at the same time cannot corrupt it, ALWAYS
    use a writer-specific temp file + mv within the same directory (atomic replace), and
    mv only when jq succeeded (jq fails if the existing config is invalid JSON — mv-ing
    anyway would zero out config, so on failure remove tmp, warn, and give up on
    persistence):
      CONFIG=~/.claude/cmux-team-dispatch-task/config.json
      mkdir -p "$(dirname "$CONFIG")"
      if TMP=$(mktemp "$CONFIG.XXXXXX"); then
        if { [[ -f "$CONFIG" ]] && jq --arg v "<value>" '.exec_choice = $v' "$CONFIG" > "$TMP"; } \
           || { [[ ! -f "$CONFIG" ]] && jq -n --arg v "<value>" '{exec_choice: $v}' > "$TMP"; }; then
          mv "$TMP" "$CONFIG"
        else
          rm -f "$TMP"; echo "[warn] config write failed; persistence skipped" >&2
        fi
      else
        echo "[warn] mktemp failed; persistence skipped" >&2
      fi
    <value> is one of "claude" / "codex" / "ask". Concurrent writes resolving
    as whole-file last-write-wins is acceptable. The other tasks in the SAME dispatch
    already have their prompts built, so this confirmation keeps appearing for them this
    time; it takes effect from the next dispatch onward.
    The answer to this confirmation does NOT affect this run's Phase B branch — continue
    immediately with the model you chose.
    There are 2 ways to revert after choosing "Always ...", and they differ in meaning:
    rewriting exec_choice to "ask" leaves only the model question every time (this
    confirmation is NOT shown), while DELETING the key returns it to unset so this
    confirmation is shown again.
  ```

- `{{TEAM}}` → the agmsg team name resolved in Step 1g (`dispatch-<repo-name>`); empty
  when agmsg is not installed. Every `--agmsg-team` argument below uses this value (and
  when it is empty, all three `--agmsg-*` flags are dropped). The child session runs
  inside a worktree and must NOT re-derive the team name there — deriving it from the
  worktree's `basename` (as Step 1g's `TEAM=` line does for the parent) yields a wrong
  name, since the worktree directory name is `<task-slug>`, not the repo name.

- Substitute the complete resolved role tuple into every prompt before launch:
  `DESIGN_RUNNER` / `DESIGN_ENGINE` / `PLAN_MODEL`, `REVIEW_POLICY` /
  `REVIEW_RUNNER` / `REVIEW_ENGINE` / `REVIEW_MODEL` / `REVIEW_PANE_AGENT`, and
  `EXEC_CHOICE` / `EXEC_RUNNER` / `EXEC_ENGINE` / `EXEC_MODEL`. These are values,
  not hints: a child must not derive a runner or model again from an engine.
- **Design engine** = `DESIGN_ENGINE` resolved in Step 1f.
- Vary the template by the engine of the task's design runner:
  - design=claude → Phase A names the resolved design runner/model. Phase B's
    in-session option is available only when the resolved execution role's engine,
    model, and effort all equal the design role's (see the in-session condition
    resolved in Step 1f/1g).
  - design=codex → replace the PHASE A / PHASE B sections with the "codex design variant"
    above. `{{REVIEW_BLOCK}}` is still injected between the variant's PHASE A and PHASE B,
    and `{{CODE_REVIEW_BLOCK}}` after the variant's PHASE B — i.e. keep the original
    positions that the `{{REVIEW_BLOCK}}` / `{{CODE_REVIEW_BLOCK}}` markers occupy in the
    template. `{{CODEX_OPTION_LINE}}` and `{{CODEX_BEHAVIOR_BLOCK}}` are NOT emitted for
    design=codex (drop them — substitute the empty string): the variant's PHASE B already
    contains both choices (claude / codex), and keeping the design=claude-only
    `{{CODEX_BEHAVIOR_BLOCK}}` (which tells YOU to turn into the reviewer after a codex
    implementation) would contradict the fixed-review case. Under a fixed policy the
    design pane exits after touching `.deferred`, and the dedicated review pane reviews.
- `{{DESIGN_RUNNER}}`, `{{DESIGN_ENGINE}}`, `{{PLAN_MODEL}}` → the resolved design tuple.
- `{{REVIEW_POLICY}}`, `{{REVIEW_RUNNER}}`, `{{REVIEW_ENGINE}}`,
  `{{REVIEW_MODEL}}`, `{{REVIEW_PANE_AGENT}}` → the resolved review tuple. Under both fixed
  and legacy policy, the dedicated review pane agent is `<task-slug>-review`. Legacy
  preserves only the six-case cross-engine Phase B-R reviewer assignment; it does not
  repurpose the separate `<task-slug>-claude` executor pane as the review pane.
- `{{EXEC_CHOICE}}`, `{{EXEC_RUNNER}}`, `{{EXEC_ENGINE}}`, `{{EXEC_MODEL}}` → the
  resolved execution tuple for the selected/default branch.

- `{{REVIEW_BLOCK}}` → **only when `REVIEW_ENABLED` is true**, bake in the
  WHOLE block below (substituting `{{REVIEW_MODEL}}` / `{{REVIEW_RUNNER_NAME}}` /
  `{{REVIEW_PANE_AGENT}}` from the resolved review tuple above). Empty string when disabled:

  ````
  PHASE A-R — Plan/Spec review by the resolved review role (REQUIRED between Phase A and Phase B):
    Review policy/runner/engine/model: {{REVIEW_POLICY}} / {{REVIEW_RUNNER}} /
    {{REVIEW_ENGINE}} / {{REVIEW_MODEL}}. It runs in a dedicated plain review session
    with NO status.json ownership; the review engine may equal the design engine.
    NEVER touch .assigned-{{REVIEW_PANE_AGENT}} during review. Phase B implementation
    ownership belongs to the separately resolved executor pane, including the claude
    executor pane for design=codex; the dedicated review pane is never reused as an
    executor under either policy.

    Review points (run the round loop below at EACH point, in order):
      - plan mode:        one point  — id "plan" (after the plan is written)
      - superpowers mode: two points — id "spec" (after the brainstorming design doc),
                          then id "plan" (after the implementation plan)

    Setup (before the first point only):
      mkdir -p "<EXISTING_STATUS_DIR>/review"
      REVIEW_SURFACE=$(jq -r '.review.surface_id // empty' "<EXISTING_STATUS_DIR>/prewarm.json" 2>/dev/null)
      IF REVIEW_SURFACE is empty (prewarm off), spawn the pane once:
        RESULT=$(zsh <SKILL_DIR>/scripts/launch-workspace.sh \
          --cwd "$PWD" --mode review \
          --standby-in "$CMUX_WORKSPACE_ID" --standby-split-from "$CMUX_SURFACE_ID" \
          --standby-split-direction right \
          --runner "$REVIEW_RUNNER" --model '{{REVIEW_MODEL}}' \
          --status-dir "<EXISTING_STATUS_DIR>" \
          {{REVIEW_PANE_AGENT}})
          # (when the reviewer engine is claude, append --skip-permissions to the spawn)
        REVIEW_SURFACE=$(echo "$RESULT" | jq -r '.surface_id // empty')
      IF the spawn fails: warn the user, SKIP Phase A-R entirely, and continue to
      Phase B — review is a quality gate, not a dispatch blocker.
      The SAME pane is reused across all points and rounds (it keeps review context).

    Round loop (at point <point>, N = 1, 2, 3, 4, 5):
      1. Compose the request text:
           "Review the <point> document at <ABSOLUTE_DOC_PATH>.
            Reference material: <related file paths — e.g. the spec path when reviewing the plan>.
            This is round <N> (max 5)."
         For N >= 2 append:
           "Previous findings: <EXISTING_STATUS_DIR>/review/<point>-round-<N-1>.md.
            The document was revised in response — check whether concerns were
            addressed (rebuttals are inline below) and look for new issues.
            <your rebuttals to findings you rejected, with reasons>"
         Always append the protocol:
           "Write your findings as markdown to
            <EXISTING_STATUS_DIR>/review/<point>-round-<N>.md.
            The LAST line of that file MUST be exactly 'VERDICT: approve' or
            'VERDICT: needs_work'. approve = the document is ready to implement."
      1b. Append the parallel-review directive for the resolved review pane engine:
            PARALLEL=$(bash <SKILL_DIR>/scripts/parallel-directive.sh --engine "$REVIEW_ENGINE" --mode review)
            <request text>="<request text> $PARALLEL"
      2. Send the request with ONE send-prompt.sh call, then wait by polling the
         verdict file. send-prompt.sh types the request into the review pane (the
         only thing that wakes it), records the same body in the pane's inbox when
         its watcher is alive, and files a request longer than 400 characters into
         the outbox so it cannot jam the input box. An agmsg reply push would never
         wake THIS session while it idle-waits either, so the wait is ALWAYS file
         polling:
           bash <SKILL_DIR>/scripts/send-prompt.sh --to-surface "$REVIEW_SURFACE" \
             --agmsg-team "$TEAM" --agmsg-to {{REVIEW_PANE_AGENT}} --agmsg-from <task-slug> \
             --label review-plan --outbox-dir "<EXISTING_STATUS_DIR>/outbox" \
             -- "<request text>"
           # $TEAM is the TEAM value given above — do NOT re-derive it. Drop the
           # three --agmsg-* flags when $TEAM is empty. Do NOT branch on
           # prewarm.json's `.review.delivery`: send-prompt.sh re-checks the ready
           # sentinel itself and skips the inbox record when the watcher is gone.
           Then wait by polling the verdict file (5s interval, in 15-min chunks with
           NO overall time limit while the reviewer pane is active — liveness is
           judged by a screen-snapshot diff at every chunk boundary):
             F="<EXISTING_STATUS_DIR>/review/<point>-round-<N>.md"
             # read-screen returns live terminal content even for unfocused
             # workspaces (empirically verified) — no refresh step is needed
             RS() { cmux read-screen --workspace "$CMUX_WORKSPACE_ID" --surface "$REVIEW_SURFACE" 2>/dev/null; }
             SNAP=$(RS); STALLED=0; READFAIL=0
             while true; do
               for i in $(seq 1 180); do   # one 15-min chunk
                 [[ -f "$F" ]] && grep -qE '^VERDICT: (approve|needs_work)$' "$F" && break 2
                 sleep 5
               done
               # a verdict written during the final sleep must win over the liveness check
               [[ -f "$F" ]] && grep -qE '^VERDICT: (approve|needs_work)$' "$F" && break
               NEW=""; for r in 1 2 3; do NEW=$(RS); [[ -n "$NEW" ]] && break; sleep 10; done
               if [[ -z "$NEW" ]]; then
                 # observation failure — NOT stalled by itself; only 2 consecutive
                 # all-failed chunk boundaries count as a vanished pane
                 READFAIL=$((READFAIL+1)); (( READFAIL >= 2 )) && { STALLED=1; break; }; continue
               fi
               READFAIL=0
               [[ "$NEW" != "$SNAP" ]] && { SNAP="$NEW"; continue; }   # reviewer still working — keep waiting
               STALLED=1; break
             done
           Each time a chunk boundary passes with the reviewer still active,
           briefly report the elapsed wait to the user and keep waiting.
      3. Read the verdict:
           VERDICT=$(grep -oE 'VERDICT: (approve|needs_work)' "<EXISTING_STATUS_DIR>/review/<point>-round-<N>.md" 2>/dev/null | tail -1)
         - "VERDICT: approve" → this point is done. Move to the next point; after
           the LAST point, proceed to Phase B. Leave the review pane OPEN and idle —
           do NOT close it (it is torn down with the other panes only at the final
           all-tasks-complete cleanup).
         - "VERDICT: needs_work" → read the findings. Apply the ones you judge
           valid to the document; collect reasons for the ones you reject (they
           go into the next round's request as rebuttals). Then:
             N < 5  → run round N+1.
             N == 5 → summarize the unresolved findings and ask via AskUserQuestion:
               Q: "Five review rounds passed without an approve. Remaining findings: <summary>. What do you want to do?"
                 1. Proceed as is — note the remaining findings in the document and go to Phase B
                 2. Revise further — run one more review round
               "Proceed as is" → append the unresolved findings as a note in the
               document and move on (leave the review pane open — do not close it).
               "Revise further" → run one more round; on another needs_work, re-ask.
         - The wait exited stalled (STALLED=1: no screen change over a full
           15-min chunk, or the pane was unobservable at 2 consecutive chunk
           boundaries) → check the verdict file one last time; if still no
           VERDICT line, re-send the SAME round's request once (retake the
           baseline snapshot). If the wait exits stalled again, ask via
           AskUserQuestion:
             Q: "The reviewer appears to be stalled (no change in its pane). What do you want to do?"
               1. Re-send the request
               2. Skip the review and proceed to Phase B
             Option 2 → skip the review and continue to Phase B (leave the review
             pane open — do not close it).

    VIOLATION: When this block is present, do NOT start Phase B before every
    review point reached approve or an explicit user decision was made.
  ````

- `{{CODE_REVIEW_BLOCK}}` → **only when `REVIEW_ENABLED` is true**, bake in the WHOLE
  block below. Empty string when disabled:

  ````
  PHASE B-R — Post-implementation code review (REQUIRED before the PR is created):
    Enabled together with Phase A-R. Review point id: "code". Findings file:
    <EXISTING_STATUS_DIR>/review/code-round-<N>.md — the LAST line MUST be exactly
    'VERDICT: approve' or 'VERDICT: needs_work'. Max 5 rounds.

    Reviewer assignment is selected by REVIEW_POLICY, never inferred by comparing
    engines:

    [fixed policy]
      - REVIEWER_SURFACE = prewarm.json .review.surface_id (or the one review surface
        spawned during Phase A-R). REVIEWER_RUNNER / REVIEWER_ENGINE / REVIEWER_MODEL
        are the resolved REVIEW_RUNNER / REVIEW_ENGINE / REVIEW_MODEL values.
      - This dedicated review pane reviews every implementation choice, including an
        implementer with the same engine or runner. It is the same pane used for all
        Phase A-R and Phase B-R rounds.
      - Every delegated implementer receives the extended REQUEST_TEXT below and a
        code-review.json containing the dedicated review pane's explicit runner and
        engine. After delegation, the design pane touches `.deferred` and exits; it
        never becomes the reviewer.
      - If the dedicated review pane failed to spawn, warn, skip this quality gate,
        and let the implementer continue to PR creation.

    [legacy policy]
      Retain only the six cross-engine reviewer assignments below. Physical panes stay
      dedicated and separate: <task-slug>-review is the review pane and
      <task-slug>-claude is the claude executor pane. These assignments select which existing
      pane reviews Phase B output; they never make the review pane an executor. They are
      outputs of the legacy resolver, not an engine invariant. Write each selected reviewer
      into the same REVIEWER_RUNNER / REVIEWER_ENGINE fields before delegation.

    Concretely, by design engine and Phase B choice in legacy policy:

    [design=claude]
      - "claude", IN_SESSION == true (YOU implement in-session) → the review pane
        reviews your code: run the SAME Round loop as PHASE A-R with point id "code" —
        use the "in-session — the review pane reviews" protocol at the end of this block.
      - "claude", IN_SESSION == false → the review pane reviews. The claude executor
        standby is the implementer: send it the extended REQUEST_TEXT (common protocol
        a) with <REVIEWER_SURFACE> = prewarm.json .review.surface_id. YOU (the design
        pane) touch .deferred and then exit THIS session — you have NO reviewer role
        (do NOT run steps b–e).
      - "codex" → YOU become the code reviewer. The codex standby is the implementer:
        send it REQUEST_TEXT (common protocol a) with <REVIEWER_SURFACE> = your own
        $CMUX_SURFACE_ID, then run steps b–e.

    [design=codex]
      - "claude" → YOU (the design codex session) become the code reviewer. The
        delegated claude pane is the implementer (agent <task-slug>-claude): send it
        REQUEST_TEXT (common protocol a) with <REVIEWER_SURFACE> = your own
        $CMUX_SURFACE_ID, then run steps b–e (do NOT exit after .deferred — idle-wait,
        write findings each round, and exit only after writing approve).
      - "codex", IN_SESSION == true (YOU implement in-session) → the review pane
        reviews your code: run the SAME Round loop as PHASE A-R with point id "code" —
        use the "in-session — the review pane reviews" protocol at the end of this block.
      - "codex", IN_SESSION == false (standby) → the claude review pane reviews. The
        codex standby is the implementer: send it REQUEST_TEXT (common protocol a) with
        <REVIEWER_SURFACE> = prewarm.json .review.surface_id. YOU touch .deferred and
        then exit THIS session — no reviewer role.
      - review pane unavailable (the PHASE A-R Setup spawn failed and review was
        skipped) → skip this code review and proceed to the PR — review is a quality
        gate, not a dispatch blocker.

    Before writing `code-review.json` on either prewarm or spawn paths, resolve one
    coherent reviewer tuple. The runner/engine must describe the pane selected here:

      resolve_code_reviewer_for_choice() {
        REVIEWER_WORKSPACE="$CMUX_WORKSPACE_ID"
        if [[ "$REVIEW_POLICY" == "fixed" ]]; then
          REVIEWER_SURFACE="$REVIEW_SURFACE"
          REVIEWER_RUNNER="$REVIEW_RUNNER"
          REVIEWER_ENGINE="$REVIEW_ENGINE"
          return
        fi

        # The reviewer is always the engine opposite the implementer. When both roles
        # run on the same engine (including in-session execution) the dedicated review
        # pane reviews; when they differ the design session becomes the reviewer.
        if [[ "$DESIGN_ENGINE" == "$EXEC_ENGINE" ]]; then
          REVIEWER_SURFACE="$REVIEW_SURFACE"
          REVIEWER_RUNNER="$REVIEW_RUNNER"
          REVIEWER_ENGINE="$REVIEW_ENGINE"
        else
          REVIEWER_SURFACE="$CMUX_SURFACE_ID"
          REVIEWER_RUNNER="$DESIGN_RUNNER"
          REVIEWER_ENGINE="$DESIGN_ENGINE"
        fi
      }

    Call this after the Phase B choice is known. If its selected surface is empty
    because the review pane failed to spawn, warn and omit `--review-config`; this
    skips only the review gate. Never combine the design surface with the fixed
    review runner/engine, or a review-pane surface with the design runner/engine.

    Common protocol a — extended REQUEST_TEXT (the implementer drives the round loop;
    used in every branch above where a standby / delegated pane implements):
      a. Prewarm path only — REQUEST_TEXT: use this extended version instead
         (compute TWO parallel-execution directives first, then fill every <...>
         before sending. One is for the implementer's engine — claude for the
         claude executor standby / a delegated claude pane, codex for the codex standby.
         The other is for the explicitly resolved reviewer engine; it is quoted
         inside the review request the implementer
         sends, and this is the ONLY thing that gives the prewarm-path reviewer a
         parallel directive — the reviewer pane itself was launched with
         `--mode review`, which carries none):
           PARALLEL=$(bash <SKILL_DIR>/scripts/parallel-directive.sh --engine <implementer-engine> --mode execute)
           REVIEW_PARALLEL=$(bash <SKILL_DIR>/scripts/parallel-directive.sh --engine <reviewer-engine> --mode review)
           "Read and execute the plan at <PLAN_FILE_PATH>. $PARALLEL After all changes are
            committed and BEFORE creating the PR, you MUST get a code review
            approval. Round N starts at 1, max 5 rounds. Each round:
            (1) send the review request with ONE command. It types the request into
                the reviewer pane (the only thing that wakes it), also records the
                same text in the reviewer's agmsg inbox when that watcher is alive
                (a log, not a wake mechanism), and files a request over 400
                characters into the outbox so it cannot jam the input box:
                  bash <SKILL_DIR>/scripts/send-prompt.sh --to-surface <REVIEWER_SURFACE> \
                    --agmsg-team <TEAM> --agmsg-to <task-slug> --agmsg-from <your-agent-name> \
                    --label review-code --outbox-dir <EXISTING_STATUS_DIR>/outbox \
                    -- '<request text>'
                Drop the three --agmsg-* flags when <TEAM> is empty.
                where <request text> is: code review round N: review the committed
                changes on this branch against the plan at <PLAN_FILE_PATH>; write
                findings to <EXISTING_STATUS_DIR>/review/code-round-N.md whose LAST
                line must be VERDICT: approve or VERDICT: needs_work. From round 2
                append your rebuttals to the findings you rejected, with reasons.
                Also include this in the message to the reviewer, addressed to the
                reviewer and not to you: $REVIEW_PARALLEL End of the message to the
                reviewer.
            (2) wait by polling <EXISTING_STATUS_DIR>/review/code-round-N.md every
                5 seconds for a VERDICT line, in 15-minute chunks with NO overall
                time limit while the reviewer is active. Right after sending,
                capture a baseline of the reviewer pane screen (read-screen returns
                live content even when the target workspace is unfocused):
                  cmux read-screen --workspace "$CMUX_WORKSPACE_ID" --surface <REVIEWER_SURFACE>
                At each chunk boundary without a verdict: re-check the verdict
                file once more (a verdict written during the final sleep must
                win), then capture the screen again (on failure or empty output
                retry up to 3 times, 10s apart) and compare with the previous
                capture. Changed → the reviewer is still working: update the
                snapshot and keep waiting. Unchanged → the reviewer is stalled.
                All retries failed → observation failure, NOT stalled; only 2
                consecutive all-failed boundaries count as stalled.
            (3) On VERDICT: approve, create the PR and finish per the instructions
                below. On VERDICT: needs_work, apply the findings you judge valid,
                commit, and start round N+1. If round 5 still ends with needs_work:
                if you can ask the user interactively (AskUserQuestion), ask whether
                to proceed or run one more round; otherwise note the unresolved
                findings in the PR body and proceed. If the wait exits stalled,
                check the verdict file one last time, then re-send the same round
                once (retake the baseline); if it stalls again, ask via
                AskUserQuestion if you can (re-send the request / skip the review and
                create the PR);
                otherwise skip the review and note that in the PR body.
            *** ABORT / ESCALATION PROTOCOL — this overrides everything above ***
            If at ANY point you decide to STOP without completing the work — a
            blocking error, a design contradiction, a decision that the plan is
            wrong, or simply giving up — you MUST NOT stop silently. Writing
            <EXISTING_STATUS_DIR>/status.json is NOT a notification: that file is
            polled by the parent only, and the reviewer waiting on you never sees
            it. Before you stop, do ALL of the following, in this order:
              1. Write the reason to
                 <EXISTING_STATUS_DIR>/review/code-round-<current N>.md with the
                 LAST line exactly 'VERDICT: needs_work'. If you never sent a
                 review request, use N=1. This is a record for the parent — the
                 reviewer does not poll this file.
              2. Notify the REVIEWER. Typing is what actually wakes it, and
                 send-prompt.sh always types:
                   bash <SKILL_DIR>/scripts/send-prompt.sh --to-surface <REVIEWER_SURFACE> \
                     --agmsg-team <TEAM> --agmsg-to <task-slug> --agmsg-from <your-agent-name> \
                     --label abort-reviewer --outbox-dir <EXISTING_STATUS_DIR>/outbox \
                     -- '[abort] <one-line reason>'
                 Drop the three --agmsg-* flags when <TEAM> is empty.
              3. Write status.json with status "error" and the reason as message.
              4. Notify the PARENT with the SAME single send-prompt.sh call as (a)
                 below, but with "status: error". Do NOT add a separate send.sh
                 invocation — send-prompt.sh already records the inbox copy.
              5. END THIS SESSION so the runner wrapper can finalize. claude
                 implementers run /exit. codex implementers must END THE CODEX
                 SESSION ITSELF — do NOT run /exit (codex does not act on it).
            *** END ABORT / ESCALATION PROTOCOL ***

            After the PR is created (or all changes are merged per the plan), do these
            two things IN THIS ORDER. Neither may be skipped.
            (a) MANDATORY completion notification. You received this request as typed
                text and never read the task prompt file, so no other status protocol
                applies to you — this command is the only thing that informs the
                parent:
                  bash <SKILL_DIR>/scripts/send-prompt.sh --to-workspace <PARENT_WORKSPACE_ID> \
                    --agmsg-team <TEAM> --agmsg-to parent --agmsg-from <your-agent-name> \
                    --label dispatch-notify --outbox-dir <EXISTING_STATUS_DIR>/outbox \
                    -- '[dispatch] task <task-slug> finished (status: done)'
                Drop the three --agmsg-* flags when <TEAM> is empty. This call is
                never optional: typing is the only channel that wakes an idle parent,
                and the inbox record it may additionally write is just a log.
            (b) End this session so the runner wrapper can finalize. claude
                implementers run /exit. codex implementers must END THE CODEX SESSION
                ITSELF — do NOT run /exit (codex does not act on it) and do NOT leave
                the session idle. A codex TUI that stays idle blocks its wrapper
                forever, so the wrapper backstop never fires either."
         Placeholder values: <REVIEWER_SURFACE> = the review-policy resolver output
         (fixed → prewarm.json .review.surface_id; legacy → the selected design or
         dedicated review surface), <TEAM> = the TEAM value given above (empty
         when agmsg is not installed — then drop the three --agmsg-* flags and let
         send-prompt.sh deliver by typing alone), <SKILL_DIR> = the absolute path of
         this skill's directory (substitute it before sending — the implementer pane
         cannot resolve the placeholder), <your-agent-name>
         = the implementing pane's agent name (<task-slug>-claude / <task-slug>-codex,
         whichever Phase B choice dispatched to),
         <PARENT_WORKSPACE_ID> = the parent workspace ID this dispatch was launched from,
         <implementer-engine> = `claude` when the implementer is the claude executor
         standby or a delegated claude pane (the claude target in the design=codex
         variant), `codex` when the implementer is the codex standby, <reviewer-engine> = the
         resolved `REVIEWER_ENGINE` for the pane at <REVIEWER_SURFACE>.

         Before sending this REQUEST_TEXT, write the reviewer wiring file so the
         implementer's runner wrapper can also wake the reviewer if the implementer
         stops without following the abort protocol:
           mkdir -p "<EXISTING_STATUS_DIR>/review"
           jq -n --arg s "<REVIEWER_SURFACE>" --arg w "<REVIEWER_WORKSPACE>" \
             --arg d "<EXISTING_STATUS_DIR>/review" --arg r "<REVIEWER_RUNNER>" \
             --arg e "<REVIEWER_ENGINE>" \
             '{reviewer_surface: $s, reviewer_workspace: $w, review_dir: $d, reviewer_runner: $r, reviewer_engine: $e}' \
             > "<EXISTING_STATUS_DIR>/review/code-review.json"
         <REVIEWER_WORKSPACE> is the reviewer pane's workspace ($CMUX_WORKSPACE_ID
         when the legacy design pane is the reviewer). <REVIEWER_RUNNER> and
         <REVIEWER_ENGINE> come directly from the fixed or legacy resolver. The engine
         lets launch-workspace.sh pick the right parallel-review wording for the
         spawn-path reviewer. The spawn fallback already writes this file; this makes
         the prewarm path write it too.

         MAINTENANCE NOTE (for SKILL.md editors — not part of the request text):
         the line break inside the quoted old wording below is DELIBERATE.
         test/test-launch-workspace-codex.sh T14 uses grep -F to assert that the
         banned engine-neutral exit phrase never appears whole on any single line
         of this file, so joining that quotation back onto one line makes T14 fail.
         Do NOT reflow it, and do not restate the banned phrase unbroken anywhere.

         (a) and (b) MUST NOT be omitted. The old wording ended with a single
         engine-neutral sentence ("run /exit (claude) or end the session
         (codex)") and did not mention the completion notification at all. As a result:
           - Enabling Phase B-R made this extended REQUEST_TEXT overwrite the codex base
             REQUEST_TEXT's "end this codex session immediately … Do NOT run /exit", so the
             strong codex-specific instruction was LOST (exactly the regression that
             CLAUDE.md maintenance item 21 exists to prevent)
           - A standby pane never reads the task prompt, so no status protocol backs
             "finish per the instructions below" — the child-side mandatory notification is
             structurally impossible to deliver
         When those two combine, the parent receives NO notification at all, even though the
         implementation finished.

    Common protocol b–e — YOU become the code reviewer (only in the branches above
    that assign the reviewer role to YOU):
      b. After touching .deferred (prewarm step 4 / spawn fallback): do NOT exit.
         Run mkdir -p "<EXISTING_STATUS_DIR>/review", then END YOUR TURN and
         idle-wait for the implementer's review requests (they arrive as text
         typed into this pane; an identical agmsg inbox copy may exist — treat
         both as ONE request). Do not poll or busy-wait.
      c. When the round-N request arrives: review the implementation — the branch
         commits (git log) and the full diff against the branch point (e.g.
         git diff main...HEAD) — against the plan at <PLAN_FILE_PATH>. Judge
         correctness, plan conformance, and obvious quality issues. Write your
         findings as markdown to <EXISTING_STATUS_DIR>/review/code-round-<N>.md;
         the LAST line MUST be exactly 'VERDICT: approve' or 'VERDICT: needs_work'.
         approve = ready to become a PR. Consider the implementer's rebuttals —
         do not blindly repeat rejected findings.
      d. After writing needs_work → END YOUR TURN and idle-wait for the next round.
         After writing approve → exit THIS session (.deferred is already in place,
         so your wrapper stays silent; the implementer pane's wrapper owns status.json).
      e. Orphan guard: if the implementer COMPLETES its work without ever requesting
         a review, you simply stay idle — that is acceptable. The parent closes all
         panes at the final all-tasks-complete cleanup, and status.json is still
         owned by the implementer's wrapper.
         BUT if you receive an '[abort] ...' message from the implementer, do NOT
         keep waiting. Report the abort reason to the parent with one call:
           bash <SKILL_DIR>/scripts/send-prompt.sh --to-workspace <PARENT_WORKSPACE_ID> \
             --agmsg-team <TEAM> --agmsg-to parent --agmsg-from <task-slug> \
             --label dispatch-notify --outbox-dir "<EXISTING_STATUS_DIR>/outbox" \
             -- '<reason>'
         (drop the three --agmsg-* flags when <TEAM> is empty), then exit THIS session.

    [in-session — the review pane reviews] (IN_SESSION == true only)
      After implementation is committed and BEFORE creating the PR, run the SAME
      Round loop as PHASE A-R once more with point id "code", reusing REVIEW_SURFACE
      from the PHASE A-R Setup (use --label review-code instead of review-plan).
      Differences from a document round:
        - Request text: ask for a review of the committed changes on this branch
          (git log / git diff against the branch point) against the plan at
          <PLAN_FILE_PATH>, findings to <EXISTING_STATUS_DIR>/review/code-round-<N>.md.
        - Round 5 needs_work → ask via AskUserQuestion:
            Q: "Five code review rounds passed without an approve. Remaining findings: <summary>. What do you want to do?"
              1. Create the PR as is — note the unresolved findings in the PR body and proceed
              2. Revise further — run one more round (on another needs_work, re-ask)
        - Review pane unavailable (the PHASE A-R Setup spawn failed and review was
          skipped) → skip this code review too and proceed to the PR — review is a
          quality gate, not a dispatch blocker.

    VIOLATION: When this block is present, do NOT create the PR before the code
    review reached approve or one of the explicit fallbacks above was taken.
  ````

- Use the Step 1g execution resolver to check whether a codex execution role is
  available. Prefer a codex `DESIGN_RUNNER`; otherwise use the legacy first capable
  codex runner:

  ```bash
  CODEX_CMD=$(jq -r '[.runners[] | select(.engine == "codex")] | .[0].command // empty' \
    ~/.claude/cmux-team-dispatch-task/runners.json 2>/dev/null)
  ```

  - **codex runner present** (`CODEX_CMD` non-empty):
    - `{{CODEX_OPTION_LINE}}` → `      2. codex    — switch to the codex CLI (recommended for implementations that use codex-specific features)`
    - `{{CODEX_BEHAVIOR_BLOCK}}` →
      ```
          [codex] → FIRST check for a pre-warmed standby pane:
              CODEX_SURFACE=$(jq -r '.executors.codex.surface_id // empty' "<EXISTING_STATUS_DIR>/prewarm.json" 2>/dev/null)
            IF CODEX_SURFACE is non-empty:
              1. Leave every other role pane recorded in prewarm.json OPEN and idle — do
                 NOT close it (see the branch above: an unassigned standby writes no
                 status.json).
              2. touch "<EXISTING_STATUS_DIR>/.assigned-<task-slug>-codex"
              3. Send the execution request with ONE send-prompt.sh call (see the
                 delivery contract in Step 1g). It types the text into the codex
                 pane, records the same body in that pane's inbox when its watcher
                 is alive, and files anything over 400 characters into the outbox.
                 # IF the PHASE B-R block exists below, REQUEST_TEXT must be the
                 # extended version defined in that block (with the pre-PR
                 # code-review protocol) — same as the claude branch.
                   # Base request. CRITICAL: for codex the exit instruction must tell it
                   # to END THE CODEX SESSION ITSELF — do NOT say "run /exit" (that is a
                   # claude command; codex does not act on it). Without a codex-appropriate
                   # exit instruction the codex TUI stays idle after finishing the work, so
                   # the runner wrapper (blocked on the codex process) never reaches
                   # write_status "done" / signal fire / parent notify → the completion
                   # notification never arrives. This mirrors the engine-aware EXIT_INSTRUCTION
                   # that launch-workspace.sh bakes into the spawn (`--mode execute`) path.
                   PARALLEL=$(bash <SKILL_DIR>/scripts/parallel-directive.sh --engine codex --mode execute)
                   REQUEST_TEXT="Read and execute the plan at <PLAN_FILE_PATH>. $PARALLEL After all work is committed/pushed and the PR is created (or all changes are merged per the plan), end this codex session immediately so the wrapper script can finalize the completion notification. Do NOT run /exit and do NOT leave the session idle."
                   bash <SKILL_DIR>/scripts/send-prompt.sh --to-surface "$CODEX_SURFACE" \
                     --agmsg-team "$TEAM" --agmsg-to <task-slug>-codex --agmsg-from <task-slug> \
                     --label phase-b-exec --outbox-dir "<EXISTING_STATUS_DIR>/outbox" \
                     -- "$REQUEST_TEXT"
                   # $TEAM is the TEAM value given above — do NOT re-derive it in this
                   # session. Drop the three --agmsg-* flags when $TEAM is empty, and do
                   # NOT branch on prewarm.json's `.executors.codex.delivery`.
              4. touch "<EXISTING_STATUS_DIR>/.deferred". IF the Phase B-R block
                 exists, run common protocol b–e only when REVIEWER_SURFACE equals
                 your `$CMUX_SURFACE_ID`; otherwise exit. Without Phase B-R, exit.

            IF prewarm.json is absent, fall back to the existing spawn flow (unchanged):
              Build and run (same shape as the claude branch above, but with the codex runner):
                zsh <SKILL_DIR>/scripts/launch-workspace.sh \
                  --cwd "$PWD" \
                  --mode execute \
                  --plan-file <PLAN_FILE_PATH> \
                  --runner "$EXEC_RUNNER" \
                  --status-dir "<EXISTING_STATUS_DIR>" \
                  --parent-notify-workspace <PARENT_WORKSPACE_ID> \
                  [--parent-notify-surface <PARENT_SURFACE_ID>] \
                  [--review-config "<EXISTING_STATUS_DIR>/review/code-review.json"]  # only when PHASE B-R is present
                  <task-slug>-exec
              IF the PHASE B-R block exists below, BEFORE the launch above write the
              reviewer wiring file exactly as in the claude branch, including the
              resolver outputs `reviewer_runner` and `reviewer_engine`. Fixed policy
              always targets the dedicated review pane; legacy policy uses its six-case
              assignment.
              Then write the deferred sentinel:
                touch "<EXISTING_STATUS_DIR>/.deferred"
              IF the PHASE B-R block exists, run common protocol b–e only when
              REVIEWER_SURFACE equals your `$CMUX_SURFACE_ID`; otherwise exit.
              Without Phase B-R, exit.
              The runner wrapper around codex will emit `<task-slug>-exec-done`,
              update status.json, and notify the parent. (codex also inherits the
              claude session via external_migration when the cmux codex hooks are
              installed.)
      ```
      where `EXEC_RUNNER` is the resolved codex execution runner for this task.

  - **codex runner absent** (`CODEX_CMD` empty): claude is the only available engine, so
    there is nothing to ask — skip the Phase B AskUserQuestion entirely and go straight
    to the `[claude]` behavior above.
    - `{{CODEX_OPTION_LINE}}` → empty string (so the option list shows only `1.`)
    - `{{CODEX_BEHAVIOR_BLOCK}}` → empty string

4. **The task description** itself

5. **Progress reporting format** (append to every prompt):

```
PROGRESS REPORTING FORMAT:
When reporting progress to the parent (or in your own visible output), you MUST
use the following box drawing table. Do NOT free-form the layout.
The header row, the column widths, and the fixed token values are NOT translatable:
keep the headers (# / Task / Surface / Mode / Status / Last message) and the mode /
status tokens listed below exactly as written. The OUTPUT LANGUAGE rule applies only
to the free-text cells (Task and Last message) — a translated header would insert
full-width characters and break the fixed column alignment.

┌────┬──────────────────────────┬──────────┬────────────┬───────────┬─────────────────────────┐
│ #  │ Task                     │ Surface  │ Mode       │ Status    │ Last message            │
├────┼──────────────────────────┼──────────┼────────────┼───────────┼─────────────────────────┤
│ 1  │ <this-task-slug>         │ <surf>   │ <mode>     │ <status>  │ <one-line message>      │
└────┴──────────────────────────┴──────────┴────────────┴───────────┴─────────────────────────┘

- mode ∈ {superpwr, plan}   (superpwr = superpowers/brainstorming, plan = built-in /plan)
- status ∈ {launched, executing, done, error}
- Truncate long messages with center ellipsis "…"
```

6. **Status protocol instructions** (append to every prompt):

**When integration strategy is "Wait and merge"** (default):

```
IMPORTANT: Status reporting protocol.
When you finish planning and begin execution, run:
  echo '{"status":"executing","message":"<brief description>","timestamp":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' > <project-root>/.dispatch/<task-slug>/status.json

When all work is complete:
1. Stage and commit ALL changes before reporting done:
  git add -A
  git commit -m "<task-slug>: <concise summary of changes>"
  If there are multiple logical units of work, create separate commits for each.
  Do NOT skip this step — uncommitted changes will be lost when the worktree is cleaned up.

2. Then report completion. Do NOT ask cleanup questions here — the parent asks once at the end of dispatch.
  echo '{"status":"done","message":"<summary of changes>","timestamp":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' > <project-root>/.dispatch/<task-slug>/status.json
And write a result summary to <project-root>/.dispatch/<task-slug>/result.md with sections:
  # <Task Name>
  ## Changes Made
  ## Test Results
  ## Commits

If you encounter a blocking error, run:
  echo '{"status":"error","message":"<error description>","timestamp":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' > <project-root>/.dispatch/<task-slug>/status.json
Writing this file is NOT a notification — it is polled by the parent only. The
completion notification below is MANDATORY on the error path exactly as much as
on the done path. Send it immediately after writing status.json, then end this
session.
```

**When integration strategy is "PR per task"**:

```
IMPORTANT: Status reporting protocol.
When you finish planning and begin execution, run:
  echo '{"status":"executing","message":"<brief description>","timestamp":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' > <project-root>/.dispatch/<task-slug>/status.json

When all work is complete:
1. Stage and commit ALL changes before reporting done:
  git add -A
  git commit -m "<task-slug>: <concise summary of changes>"
  If there are multiple logical units of work, create separate commits for each.
  Do NOT skip this step — uncommitted changes will be lost when the worktree is cleaned up.

2. Push the branch to remote and create a Pull Request:
  git push -u origin feat/<task-slug>
  gh pr create --title "<task-slug>: <concise summary>" --body "## Summary
  <description of changes>

  ## Changes Made
  <list of files changed>

  ## Test Results
  <test pass/fail summary>"

3. Then report completion (include PR URL). Do NOT ask cleanup questions here — the parent asks once at the end of dispatch. The PR is on GitHub, so the remote branch remains even if the local worktree is later deleted.
  PR_URL=$(gh pr view --json url -q '.url')
  echo '{"status":"done","message":"<summary of changes>","pr_url":"'"$PR_URL"'","timestamp":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' > <project-root>/.dispatch/<task-slug>/status.json
And write a result summary to <project-root>/.dispatch/<task-slug>/result.md with sections:
  # <Task Name>
  ## Changes Made
  ## Test Results
  ## Pull Request
  - <PR URL>
  ## Commits

If you encounter a blocking error, run:
  echo '{"status":"error","message":"<error description>","timestamp":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' > <project-root>/.dispatch/<task-slug>/status.json
Writing this file is NOT a notification — it is polled by the parent only. The
completion notification below is MANDATORY on the error path exactly as much as
on the done path. Send it immediately after writing status.json, then end this
session.
```

Replace `<project-root>` with the actual project root path and `<task-slug>` with the task's slug,
and `<team>` with the agmsg team name resolved in Step 1g (only when agmsg is installed).

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
  that reuse the same worktree (including Phase B's execute grandchild). Those do not use
  plan mode, so there is no actual harm
- It is NOT injected in superpowers mode / for the codex engine / in execute, standby, and
  review modes

### Launch: Workspace Mode (default)

```bash
mkdir -p .dispatch/<task-slug>

bash <this-skill-dir>/scripts/launch-workspace.sh \
  --mode <plan|superpowers> \
  --runner "$DESIGN_RUNNER" \
  --status-dir "$(pwd)/.dispatch/<task-slug>" \
  --defer-status \
  --parent-notify-workspace "$CMUX_WORKSPACE_ID" \
  --parent-notify-surface "$CMUX_SURFACE_ID" \
  <task-slug> \
  "$TASK_PROMPT"
```

Run one invocation per task. `--defer-status` is required so a Child runner skips
status.json after Phase B transfers execution to another surface. Each task lands
in its own cmux workspace (sidebar entry) and runs independently — there is no
parent/child surface chaining to worry about.

### Pre-warm Standby Panes (workspace layout only)

Read `prewarm` from config (project config → global config; default `true`):

```bash
PREWARM=$(jq -r '.prewarm // empty' .dispatch/config.json 2>/dev/null)
[[ -z "$PREWARM" ]] && PREWARM=$(jq -r '.prewarm // "true"' \
  ~/.claude/cmux-team-dispatch-task/config.json 2>/dev/null)
[[ -z "$PREWARM" ]] && PREWARM=true
```

When layout is `workspace` AND `PREWARM` is `true`, `prewarm-panes.sh` starts only
the resolved roles inside each task workspace: one design pane, an optional dedicated
review pane, and the execution panes allowed by `EXEC_CHOICE`. A fixed choice suppresses
every unselected execution pane; unset/`ask` starts every advertised compatible candidate.
For Codex design this includes a claude executor using
`CLAUDE_EXEC_RUNNER`, plus Codex using `CODEX_EXEC_RUNNER`. The
review pane uses `REVIEW_RUNNER` even when its engine equals `DESIGN_ENGINE`. The all-Codex
fixed example therefore contains exactly design codex, review codex, and executor codex
panes—no claude pane or process.

Pane placement is a two-row grid: design owns the workspace's main surface, review is a
`right` split off design, and the execution panes form the row below—the first splits
`down` off design, every later one splits `right` off the previous execution pane. Two
execution panes plus review therefore render as a 2×2 grid; a fixed `EXEC_CHOICE` leaves
one execution pane under design with review beside them.

Everything is delegated to `prewarm-panes.sh`; do not create panes manually.

**agmsg NOT installed (`$TEAM` empty)** — the design session was already launched with
its task prompt by "Launch: Workspace Mode" above. Add the claude/codex executor panes
below it (parse `workspace_id` / `surface_id` from that launch's output JSON):

```bash
bash <this-skill-dir>/scripts/prewarm-panes.sh \
  --workspace <workspace-id> --base-surface <surface-id> \
  --cwd "<repo-root>/.worktrees/<task-slug>" \
  --slug <task-slug> \
  --status-dir "$(pwd)/.dispatch/<task-slug>" \
  [--claude-runner "$CLAUDE_EXEC_RUNNER"] \
  [--codex-runner "$CODEX_EXEC_RUNNER"] \
  [--exec-runner "$EXEC_RUNNER"] \
  [--review-model "$REVIEW_MODEL"] \
  --design-runner "$DESIGN_RUNNER" \
  [--reviewer-runner "$REVIEW_RUNNER"] \
  --exec-choice "$EXEC_CHOICE" \
  --parent-notify-workspace "$CMUX_WORKSPACE_ID" \
  --parent-notify-surface "$CMUX_SURFACE_ID"
```

**agmsg installed (`$TEAM` non-empty)** — do NOT run the normal "Launch: Workspace
Mode" invocation. Instead all resolved panes start idle with no task
message, and the Phase A task is delivered afterwards by `send-prompt.sh`.
`prewarm-panes.sh` creates the worktree, wires agmsg delivery into it (join +
`delivery.sh set`, BEFORE any pane starts), launches the design standby workspace,
and places only the resolved review/execution roles:

```bash
RESULT=$(bash <this-skill-dir>/scripts/prewarm-panes.sh \
  --with-design \
  --cwd "<repo-root>/.worktrees/<task-slug>" \
  --slug <task-slug> \
  --status-dir "$(pwd)/.dispatch/<task-slug>" \
  [--claude-runner "$CLAUDE_EXEC_RUNNER"] \
  [--codex-runner "$CODEX_EXEC_RUNNER"] \
  [--exec-runner "$EXEC_RUNNER"] \
  --design-runner "$DESIGN_RUNNER" \
  [--reviewer-runner "$REVIEW_RUNNER"] \
  --exec-choice "$EXEC_CHOICE" \
  --agmsg-team "$TEAM" \
  --parent-notify-workspace "$CMUX_WORKSPACE_ID" \
  --parent-notify-surface "$CMUX_SURFACE_ID")
```

Flag selection per task:
- Always pass `--design-runner "$DESIGN_RUNNER"` and `--exec-choice "$EXEC_CHOICE"`.
- For a fixed `EXEC_CHOICE`, always pass its resolved runner as
  `--exec-runner "$EXEC_RUNNER"`, regardless of whether the choice is claude or codex.
  For unset/`ask`, pass the independently resolved compatible candidates as
  `--claude-runner "$CLAUDE_EXEC_RUNNER"` and `--codex-runner "$CODEX_EXEC_RUNNER"`. A
  Codex design pane needs the explicit Claude candidate for its dedicated claude
  executor; never infer it from `REVIEW_RUNNER`. `--codex-runner` also remains a
  compatibility input for old callers.
- When `REVIEW_ENABLED=true`, pass `--reviewer-runner "$REVIEW_RUNNER"`. The legacy
  `--review-model` input remains only for old design=claude callers; new role-aware
  calls use the independent runner. Do not pass both.

Since the normal task-prompt launch never runs in this mode, `prewarm-panes.sh` itself writes
an initial `"launched"` status.json (with `workspace_id`/`surface_id` populated) right after
creating the panes, so `.dispatch/<task-slug>/status.json` is observable immediately.

Then dispatch the Phase A task to the design pane:

1. Write the full task prompt (including PROGRESS REPORTING FORMAT, the
   MANDATORY MODEL SELECTION SEQUENCE, and the agmsg status-protocol block
   from Step 2 — its MANDATORY completion notification, one `send-prompt.sh`
   call, is what notifies the parent) to
   `<repo-root>/.worktrees/<task-slug>/.cmux-team-dispatch-task-prompt.md`.
2. `touch .dispatch/<task-slug>/.assigned-<task-slug>` — the design standby wrapper owns
   status.json transition from now on (it was launched with `--defer-status`,
   so a Phase B handoff can still suppress it via `.deferred`).
3. Send the task with ONE send-prompt.sh call (see the delivery contract in
   Step 1g). Slash commands cannot fire through agmsg, and typed slash commands
   are not wanted here either, so the mode is conveyed as message text, never as
   `/plan`:

   ```bash
   TASK_TEXT="Read and follow the task in .cmux-team-dispatch-task-prompt.md. Mode: <plan|superpowers> — for superpowers invoke the superpowers:brainstorming skill first; for plan produce a structured plan before implementing."
   DESIGN_SURFACE=$(jq -r '.design.surface_id // empty' "$(pwd)/.dispatch/<task-slug>/prewarm.json")
   bash <this-skill-dir>/scripts/send-prompt.sh --to-surface "$DESIGN_SURFACE" \
     --agmsg-team "$TEAM" --agmsg-to <task-slug> --agmsg-from parent \
     --label phase-a-task --outbox-dir "$(pwd)/.dispatch/<task-slug>/outbox" \
     -- "$TASK_TEXT"
   ```

   Drop the three `--agmsg-*` flags when `$TEAM` is empty, and do NOT branch on
   prewarm.json's `.design.delivery` — send-prompt.sh checks the ready sentinel
   itself. That sentinel (`~/.agents/skills/agmsg/run/ready.<team>__<agent>`) is
   created by agmsg's watch.sh while a live watcher is receiving for that role
   and removed on exit — team/agent names here are `[A-Za-z0-9._-]` slugs, so
   the path needs no encoding. It gates ONLY the inbox copy. It proves that a
   watcher PROCESS is alive, not that the pane can be woken: the same sentinel is
   written whether the watcher runs under a mechanism that injects into an idle
   session or under a plain background shell that does not. Typing is what
   actually delivers.

prewarm.json uses role names and records only panes that exist. `design` is required;
`review` exists when the quality gate is enabled; `executors` contains only the
choices started for this task. Each object records its resolved runner, engine, role,
agent, and informational delivery state. Consumers use these exact lookups:

```bash
DESIGN_SURFACE=$(jq -r '.design.surface_id // empty' "$PREWARM_FILE")
REVIEW_SURFACE=$(jq -r '.review.surface_id // empty' "$PREWARM_FILE")
CODEX_SURFACE=$(jq -r '.executors.codex.surface_id // empty' "$PREWARM_FILE")
CLAUDE_EXEC_SURFACE=$(jq -r '.executors.claude.surface_id // empty' "$PREWARM_FILE")
```

```json
{
  "design": { "surface_id": "surface:1", "agent": "<slug>", "runner": "codex", "engine": "codex", "role": "plan", "delivery": "agmsg" },
  "review": { "surface_id": "surface:2", "agent": "<slug>-review", "runner": "codex", "engine": "codex", "role": "review", "delivery": "agmsg" },
  "executors": {
    "codex": { "surface_id": "surface:3", "agent": "<slug>-codex", "runner": "codex", "engine": "codex", "role": "exec", "delivery": "agmsg" }
  }
}
```

`prewarm: false` skips this section entirely —
Phase B falls back to an on-demand `--mode execute --runner "$EXEC_RUNNER"` spawn,
and Phase A uses the traditional prompt-embedded launch with
`--runner "$DESIGN_RUNNER"`. Phase A-R uses `--mode review --runner "$REVIEW_RUNNER"`.
All three non-prewarm paths pass their resolved runner and never fall through to the
launch script's default claude command.

## Parallel execution inside a task

Tasks already run in parallel across worktrees. This section is about the work
*inside* one task: every child session is told to fan independent investigation
and verification out across child agents instead of doing them one at a time.

`scripts/parallel-directive.sh` is the single source of that wording:

```
parallel-directive.sh --engine <claude|codex> --mode <plan|superpowers|execute|review> [--agents <N>]
```

- codex sessions are told to use `spawn_agent` / `wait_agent`; claude sessions are
  told to launch several Task subagents in one message.
- File edits always stay sequential in the parent agent, and the directive never
  overrides a skill that sequences implementation (superpowers
  subagent-driven-development keeps its one-implementer-at-a-time rule).
- Only read-only verification may be fanned out. Auto-fix and write modes (a
  formatter or linter invoked with its write flag) stay sequential in the parent
  agent, because they mutate files and shared build caches.
- `--agents` caps concurrency. Integers 2-8 only; the default is 4.
- There is no `standby` mode — a standby pane is an execution pane, so pass
  `--mode execute` for it.
- `--agents` and `--no-parallel` are `launch-workspace.sh` flags. This skill never
  passes them, so the defaults apply to every dispatch it launches.

Where the directive is injected:

| Target | Injected by |
|--------|-------------|
| plan / superpowers / execute launch prompt | `launch-workspace.sh` (suppress with `--no-parallel`) |
| Phase B execution request sent to a standby pane | this skill, via the script |
| Phase A-R review request | this skill, via the script |
| Phase B-R review request (prewarm path) | this skill, via the script |
| Phase B-R review request (spawn path) | `launch-workspace.sh`, from `reviewer_engine` in `review/code-review.json` |

Whenever a directive computed for one engine is embedded in text addressed to a
session running the other engine — the reviewer directive carried inside the
implementer's prompt — mark the addressee explicitly. Position alone is not a
boundary, and a claude session told to call `spawn_agent` has no such tool.

## Step 3: Monitor and Complete

### Notification-based Monitoring (Primary)

**Monitoring depends on whether agmsg is installed (Step 1g):**

- agmsg NOT installed → launch `monitor-dispatch.sh` as described below (heartbeat,
  DIED detection, all-done notification).
- agmsg installed → do NOT launch `monitor-dispatch.sh`. Completion notifications
  arrive as `[dispatch] task "<slug>" finished (status: ...)` text typed into this
  pane by `send-prompt.sh`, with an identical copy recorded in this session's agmsg
  inbox whenever its watcher is alive. The typed text is the channel that actually
  wakes this session; the inbox copy is a log. If nothing arrives for an extended
  period, poll `.dispatch/*/status.json` manually (see "Polling Status Files"). The
  `[dispatch-monitor]` heartbeat / DIED messages do not exist in this case.
  Notifications come from three sources: the child itself right after writing
  status.json (mandatory, see Step 2), the status.json watcher that the runner
  wrapper runs alongside the child (it fires on the terminal transition even if
  the session never exits), and the runner wrapper at session exit (backstop).
  Receiving the same completion twice (or via several of these) is normal —
  treat notifications idempotently and trust status.json as the source of truth.

Each child session sends a `[dispatch]` message to the parent terminal when the Claude
process exits:

```
[dispatch] task "<slug>" finished (status: done|error)
```

**After launching all tasks:**

1. Launch the background monitor script:

   ```bash
   zsh <this-skill-dir>/scripts/monitor-dispatch.sh \
     --parent-workspace "$CMUX_WORKSPACE_ID" \
     --interval 10 \
     --heartbeat-interval 60 \
     --dispatch-dir "$(pwd)/.dispatch"
   ```

   Run this command with `run_in_background` so it does not block your turn.

   The monitor:

   - Tees all output to `.dispatch/.monitor.log`
   - Writes its PID to `.dispatch/.monitor.pid`
   - Sends `[dispatch-monitor] alive | loop=N | tasks: …` heartbeats every `--heartbeat-interval` seconds (default 60s)
   - On crash / signal, sends `[dispatch-monitor] DIED (exit=…)` to the parent so silence is never ambiguous
   - Delivers every message through `send-prompt.sh`, so long messages are filed to `.dispatch/outbox/` instead of being pasted, and the Enter is verified — nothing is left sitting in the parent's input box

2. Report the launch summary to the user using Template A with concrete surface IDs.
3. Tell the user: "Monitoring N tasks. Waiting for completion notifications and heartbeats."
4. **End your turn.** Do not block waiting.

### Background process health check

If the parent does NOT receive a `[dispatch-monitor] alive` heartbeat for >2× the heartbeat interval (default >2 minutes), assume the monitor may have died and verify:

```bash
# 1. Check if the PID is still alive
PID=$(cat .dispatch/.monitor.pid 2>/dev/null)
if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
  echo "monitor pid $PID is alive"
else
  echo "monitor is DEAD"
  tail -n 40 .dispatch/.monitor.log
fi
```

If dead, re-launch with `--resume` so already-completed tasks are not re-notified:

```bash
zsh <this-skill-dir>/scripts/monitor-dispatch.sh \
  --parent-workspace "$CMUX_WORKSPACE_ID" \
  --interval 10 \
  --heartbeat-interval 60 \
  --dispatch-dir "$(pwd)/.dispatch" \
  --resume
```

**When you receive a `[dispatch] task "X" finished` message:**

1. Read `.dispatch/<slug>/status.json` to get the full status and message.
2. If status is `"done"`, also read `.dispatch/<slug>/result.md` if it exists.
3. Report the task result to the user using **Template B** (re-emit the full progress table — never a one-line free-form message).
4. Count completed tasks against the total. If all tasks are done, proceed to Completion (Template C).
5. If some tasks remain, tell the user how many are left and end your turn again.

**When you receive a `[dispatch-monitor] alive` heartbeat:**

This is a liveness signal from the background monitor. Do nothing unless the user is actively asking about progress — heartbeats prove the loop is running, not that anything changed.

**When you receive a `[dispatch-monitor] DIED` message:**

The monitor exited unexpectedly. Inspect `.dispatch/.monitor.log`, then re-launch with `--resume` (see "Background process health check" below).

**When you receive a completion message that starts with `[dispatch-monitor]` and contains `(done: N, error: N)`:**

This is the all-done notification from the background monitor (`monitor-dispatch.sh`). Identify it by that prefix and the `(done: N, error: N)` counts rather than matching the message body verbatim — the script emits the body text in Japanese and it is not translated here. All tasks have reached a terminal state. Proceed to Completion.

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
- **Long silence**: If no notifications arrive for an extended time, poll status files or read screens.
- **User request**: The user can ask to check on any specific session at any time.

### Completion

When all tasks reach a terminal status (`"done"` or `"error"`):

1. **Collect results**: Read all `.dispatch/<task-slug>/result.md` files.

2. **Generate consolidated report**. ALWAYS lead with **Template C** (final summary table) before any per-task detail or merge instructions.

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

3. **Proceed to integration based on strategy selected in Step 1e**:

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

Shared by both integration strategies. Run **in the parent session** after the
strategy-specific steps above (merge for "Wait and merge", PR state check for
"PR per task"). Child sessions never ask these questions themselves and never
delete worktrees/branches — all destructive cleanup happens here, once, after
every child has reported `status: done`.

Ask the user three questions (in this order) via `AskUserQuestion`, then apply
each answer to all tasks:

```
Q1 header="Pane/Workspace"
   question="Close all child panes/workspaces now?"
   options: "Yes, close all" / "No, keep open"
Q2 header="Worktree"
   question="Remove all task worktrees (.worktrees/<slug>)?"
   options: "Yes, remove all" / "No, keep"
Q3 header="Branch"
   question="Delete all feature branches (feat/<slug>)?"
   options: "Yes, delete all" / "No, keep"
```

Record answers as booleans `close_all` / `remove_wt_all` / `delete_br_all`, then:

```bash
for slug in <task-slugs>; do
  status_file=".dispatch/$slug/status.json"
  workspace_id=$(jq -r '.workspace_id // empty' "$status_file")
  surface_id=$(jq -r '.surface_id // empty' "$status_file")

  # status.json is not a reliable source for these ids. The child's own
  # done/error write is a 3-field `echo` that CLOBBERS workspace_id/surface_id,
  # and the runner wrapper only restores them on session exit — which never
  # happens when a codex TUI ignores its exit instruction and stays idle.
  # Fall back to the workspace name, which prewarm-panes.sh sets to the slug.
  if [[ -z "$workspace_id" ]]; then
    workspace_id=$(cmux workspace list 2>/dev/null \
      | awk -v s="[$slug]" 'index($0, s) {print $1; exit}')
  fi

  # 1) Close the task workspace (the child process has already exited by status=done).
  if [[ "$close_all" == "true" && -n "$workspace_id" ]]; then
    cmux close-workspace --workspace "$workspace_id"
  fi

  # Close every existing prewarm role once. The role-aware schema is sparse and a
  # surface may be referenced by more than one compatibility role, so recurse and
  # de-duplicate rather than assuming fixed pane names.
  # --workspace is REQUIRED: without it a `surface:N` ref resolves against the
  # PARENT's $CMUX_WORKSPACE_ID and always fails with "Surface ref not found".
  if [[ "$close_all" == "true" && -n "$workspace_id" && -f ".dispatch/$slug/prewarm.json" ]]; then
    for sf in $(jq -r '.. | objects | .surface_id? // empty' ".dispatch/$slug/prewarm.json" 2>/dev/null \
      | awk 'NF && !seen[$0]++'); do
      cmux close-surface --workspace "$workspace_id" --surface "$sf" 2>/dev/null || true
    done
  fi

  # 2) Remove the worktree.
  [[ "$remove_wt_all" == "true" ]] && git worktree remove ".worktrees/$slug" --force 2>/dev/null

  # 3) Delete the feature branch.
  [[ "$delete_br_all" == "true" ]] && git branch -D "feat/$slug" 2>/dev/null
done

# 4) Final housekeeping. A live issue loop owns .dispatch/, so never clear it wholesale.
#    .dispatch/config.json is the project config layer written by --setup, not a dispatch
#    artifact, so it is excluded from the sweep.
if bash <this-skill-dir>/scripts/issue-fetch.sh --state-file .dispatch-loop/loop-state.json lock-check; then
  [[ -d .dispatch ]] && find .dispatch -mindepth 1 -maxdepth 1 ! -name config.json -exec rm -rf {} +
else
  # This message is shown to the user — write it in Japanese (see Output Language)
  echo "<skip bulk .dispatch/ delete: issue loop is running>" >&2
fi
rmdir .worktrees 2>/dev/null
```

Notes:

- The close → worktree → branch order is intentional: closing the pane/workspace
  first terminates any lingering shell that might hold the worktree open, making
  `git worktree remove` cleaner. Branch removal must come after worktree removal.
- If `close_all=true` but `workspace_id` is empty (unusual), skip
  the close step for that task and continue with worktree/branch removal.
- Child sessions do NOT run cleanup prompts and do NOT execute any deletion —
  doing so from inside a child caused the parent to fail `git worktree remove`
  on a still-held worktree. All cleanup is centralized in this parent-side flow.
- When agmsg is installed, remove the child agents from the team during final cleanup:

  ```bash
  for slug in <task-slugs>; do
    while IFS= read -r agent; do
      [[ -n "$agent" ]] || continue
      ~/.agents/skills/agmsg/scripts/leave.sh "$TEAM" "$agent" 2>/dev/null || true
    done < <(jq -r '.. | objects | .agent? // empty' ".dispatch/$slug/prewarm.json" 2>/dev/null \
      | awk 'NF && !seen[$0]++')
  done
  ```

  The parent (`parent`) stays in the repo-fixed team (reused on the next dispatch).

---

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
- **Completion notifications are reliable**: The runner script wrapper guarantees that `status.json` is updated, `cmux wait-for --signal <slug>-done` fires, and a `[dispatch]` text message is delivered to the parent terminal through `scripts/send-prompt.sh` when the child runner session exits. `send-prompt.sh` presses Enter after typing and then confirms via `cmux read-screen` that the input box emptied, so a notification never sits in the parent TUI waiting for a manual Enter press. The confirmation step applies when the parent renders a `❯` (or `>`) prompt line at column 0; a pane without one is treated as delivered without verification.
- **Signal-terminated panes do not report failure**: When the final cleanup closes a pane (`cmux close-surface` / `close-workspace`), the child process exits with a signal-derived code (128+N — SIGHUP 129 / SIGKILL 137 / SIGTERM 143). If `status.json` already holds a terminal status (`done` / `error`), the runner wrapper skips both the status write and the parent notification, so closing panes never downgrades a completed task to `error` nor emits a spurious `[dispatch] task ... finished (status: error)`. A pane killed while still `executing` is a genuine interruption and is still reported as `error`.
- **Runner script**: A `.cmux-team-dispatch-task-run-<workspace-name>.sh` file is created in each worktree (one per launch — Child and Phase B grandchild get different filenames since they share the worktree). They're cleaned up along with the worktree.
- **Codex option in Phase B**: the `codex` choice is shown only when `runners.json`
  contains a runner with `engine: "codex"`, and `claude` only when a claude runner exists.
  With just one engine registered, no question is asked. `cmux codex install-hooks` is
  still required so `external_migration = true` is set when migrating a Claude parent.
- **In-session vs delegated execution in Phase B**: the design session implements the
  task itself only when the execution role's engine, model, and effort all equal the
  design role's. Effort is part of the condition because it is baked in at session launch;
  matching only the model would run the execution phase at the design session's effort and
  silently ignore `exec_effort`. When the condition holds, `prewarm.json`'s `.executors`
  is `{}`, the child does NOT create `.deferred`, and the design pane keeps ownership of
  `status.json`. Otherwise the child delegates to the resolved executor pane, or spawns
  `launch-workspace.sh --mode execute --runner <EXEC_RUNNER>` when prewarm is off.
- **Child runner selection (Step 1f)**: Step 1f decides which runtime *launches* the
  child session; Phase B decides which *engine* implements. `design_runner` can fix
  Step 1f; `exec_choice` can fix Phase B. Models and efforts come from the runner's role
  fields in either case, never from the Phase B answer.
- **Delivery**: There is no notification-transport setting. `message_type` was removed, along with the `--message-type` flag on `launch-workspace.sh` / `prewarm-panes.sh` (both now die with `was removed`). agmsg is wired whenever `~/.agents/skills/agmsg/scripts/send.sh` exists, and `monitor-dispatch.sh` is launched only when it does not (status.json transitions are unchanged either way). Every message goes through one `scripts/send-prompt.sh` call. It **always types the message into the target pane** — typing is the only thing that wakes an idle session — and, when the three `--agmsg-*` arguments are supplied and the destination's ready sentinel exists, it **additionally records the same body in the agmsg inbox**, always AFTER the typed delivery so that a hung agmsg writer can never block the only wake mechanism. **An agmsg push is inbox-record-only and cannot wake an idle session**; the ready sentinel proves only that a watcher PROCESS is alive, not that it can wake the session (the same sentinel is written whether the watcher runs under a mechanism that injects into an idle session or under a plain background shell that does not). An agmsg failure never affects delivery or the exit code. Bodies longer than 400 characters are written to `<outbox-dir>/<label>-<seq>.md` and only a one-line pointer is typed, which is what stops a long instruction from being treated as a paste and jamming the input box. After typing, Enter is pressed and `cmux read-screen` confirms the input box emptied, re-pressing Enter up to 3 times before reporting failure; this verification applies when the destination renders a `❯` (or `>`) prompt line at column 0, and a pane without such a line — like an unobservable screen — counts as delivered, so a caller never re-sends and double-delivers. Completion notifications have two layers: the mandatory one the child session sends right after writing status.json (embedded into the child prompt in Step 2) plus the runner wrapper's exit-time notification (a backstop). Relying on the wrapper alone would miss notifications, because an idle TUI never exits. Also, if Step 1g's `delivery.sh set` output includes an `AGMSG-DIRECTIVE:` line, it MUST be followed so that the currently-dispatching session's own watcher gets started.
- **Pre-warm role panes**: when layout is `workspace` and config `prewarm: true`
  (default), `prewarm-panes.sh` places only resolved roles: design, optional review, and
  the execution engines allowed by `exec_choice`. `prewarm.json`'s `executors` holds at
  most `claude` and `codex`; a fixed `exec_choice` suppresses the other engine and an
  in-session role config leaves it empty. Models and efforts are never passed as
  `--model` / `--effort` from prewarm — the launcher's role fallback resolves them.

- **status.json watcher**: The runner polls for a terminal status and attempts to notify the parent even while the session stays idle. Terminal status is sticky, and the notification marker stores the last status that was successfully notified. The watcher is suppressed by a timeout sentinel, `.deferred`, an unassigned standby, or a foreign assignment.
