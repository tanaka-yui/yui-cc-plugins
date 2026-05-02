---
name: cmux-team-dispatch-task
description: >
  Orchestrate parallel execution of multiple tasks via cmux workspaces.
  Each task gets its own git worktree + Claude Code session. The parent
  session acts as orchestrator, monitoring all child sessions. Dynamically
  discovers available agent types from .claude/agents/ and passes the list
  to child sessions, which select the appropriate agent themselves.
  Supports three layout modes: workspace (default, separate sidebar entries),
  split (panes within current workspace), and claude-teams (native Agent Teams
  via cmux claude-teams). Dispatches immediately without parent-side
  planning — each child handles its own brainstorming/planning in parallel.
  Use when: "parallel execution", "team dispatch", "run these at once",
  "run these in parallel", "dispatch tasks", "execute these simultaneously",
  or when 2+ independent tasks need concurrent execution.
argument-hint: "<task1>, <task2>, ... [--layout split|claude-teams] [--no-grid]"
---

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
- Embed Template B verbatim into child session prompts so children also report progress in the same shape.

### Template A — Pre-launch task list (Step 1g)

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

## Step 1: Parse and Prepare

This single step handles task collection, agent routing, layout selection, integration
strategy, and runtime selection. Up to four user interactions before dispatch:
brainstorming selection (1c), layout mode selection (1d), integration strategy
selection (1e), and child runner selection (1f).

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
- Parse flags from the end of arguments:
  - `--layout split` or `--layout claude-teams`: override default workspace layout
  - `--no-grid`: skip grid layout reorganization in split mode

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

### 1d. Select Layout Mode

If `--layout` was specified in arguments, use that value and skip this question.
Otherwise, ask the user which layout mode to use:

> Which layout mode should be used for this dispatch?
>
> 1. **workspace** (default) — Each task in a separate cmux workspace sidebar entry (recommended for most cases)
> 2. **split** — Panes within current workspace, auto-grid layout (2-6 tasks, visual overview)
> 3. **claude-teams** — Native Agent Teams via cmux claude-teams (sidebar notifications)

| Mode                  | Description                                               | Recommended for                        |
| --------------------- | --------------------------------------------------------- | -------------------------------------- |
| `workspace` (default) | Each task in a separate cmux workspace (sidebar entry)    | Most cases, long-running, 7+ tasks     |
| `split`               | Split panes within current workspace, auto-grid layout    | 2-6 tasks, visual overview             |
| `claude-teams`        | Single orchestrator via `cmux claude-teams` + Agent Teams | Native notifications, sidebar metadata |

```
workspace mode (default):    split mode:                   claude-teams mode:
+----------+ +----------+    +----------+----------+      +----------+----------+
| ws: t-1  | | ws: t-2  |    | Parent   | Child 1  |      | Orchest. | Team-1   |
|          | |          |    +----------+----------+      +----------+----------+
+----------+ +----------+    | Child 2  | Child 3  |      | Team-2   | Team-3   |
                             +----------+----------+      +----------+----------+
(separate tabs)              (auto-grid)                  (native Agent Teams)
```

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
2. **Read `runners[]`**:
   - If exactly **1** runner is registered → silently assign that runner to all tasks
     and skip the switch question. Continue to Step 1g.
   - If **2 or more** runners are registered → ask the user via AskUserQuestion:
     > 子セッションごとにランタイム/モデルを切り替えますか？ (default: No, 全タスクに既定 runner を適用)
   - **No** → assign the `default` runner from `runners.json` to all tasks
   - **Yes** → for each task, ask which runner to use via AskUserQuestion. The options
     are the entries in `runners[]` (label = `name`, description = `command (engine)`).
3. Each task receives a `runner` field (the chosen `name` string), which Step 2 passes
   through `launch-session-splits.sh` and on to `launch-workspace.sh --runner <name>`.

**runners.json schema (minimal):**

```json
{
  "default": "claude",
  "runners": [
    { "name": "claude",  "command": "claude",  "engine": "claude" },
    { "name": "ccenec",  "command": "ccenec",  "engine": "claude" },
    { "name": "codex",   "command": "codex",   "engine": "codex"  }
  ]
}
```

Field meanings:

- `name`: unique identifier shown in AskUserQuestion options
- `command`: the executable / zsh function to invoke
- `engine`: `claude` or `codex` — controls flag composition (see table below)

**engine × MODE invocation table** (executed by `launch-workspace.sh`):

| engine | MODE        | Composed command                                                                                          |
|--------|-------------|-----------------------------------------------------------------------------------------------------------|
| claude | plan        | `<command> --dangerously-skip-permissions '/plan Read and follow the task in .cmux-team-dispatch-task-prompt.md'` |
| claude | superpowers | `<command> 'Read and follow the task in .cmux-team-dispatch-task-prompt.md'`                              |
| codex  | plan        | `<command> --dangerously-bypass-approvals-and-sandbox '/plan Read and follow the task in .cmux-team-dispatch-task-prompt.md'` |
| codex  | superpowers | `<command> '$superpowers:brainstorming Read and follow the task in .cmux-team-dispatch-task-prompt.md'`   |

The composed command is always wrapped: `zsh -ic "<composed>"` so that `~/.zshrc`
functions (e.g. `ccenec`) and env (proxy auth, PATH) are loaded for the child session.

The `claude-teams` layout ignores runner configuration (always uses `cmux claude-teams` /
the parent claude account).

**First-run setup** (when `runners.json` does not exist):

1. Show the user via AskUserQuestion:
   > runners.json が見つかりません。初回セットアップを行います。
   >
   > 1. **starter テンプレ (claude のみ)** — シンプル開始、後から手動で追加可能
   > 2. **カスタム** — runner を 1 件ずつ対話で登録 (claude / codex / zsh 関数 等)

2. **starter テンプレを選んだ場合**: write the file with a single `claude` runner
   (using the schema above) and continue:

   ```json
   {
     "default": "claude",
     "runners": [
       { "name": "claude", "command": "claude", "engine": "claude" }
     ]
   }
   ```

3. **カスタムを選んだ場合**: enter an AskUserQuestion loop. For each runner, collect
   three fields (one AskUserQuestion call per runner is ideal — use the question text
   format below; collect all answers, then ask whether to add another):

   - **name** (free text, e.g. `ccenec`) — unique identifier
   - **command** (free text, e.g. `ccenec` or `codex` or `claude`) — what to invoke
   - **engine** (choice: `claude` / `codex`)

   After each runner is added, ask: 「もう 1 件追加しますか？」 (Yes → loop; No → finish).

4. After at least one runner is registered, also ask which runner is the `default`
   (used when the user picks "No" at the switch question, or implicitly when only
   1 runner exists). If only one runner was added, it becomes `default` automatically.

5. Write the assembled object to `~/.claude/cmux-team-dispatch-task/runners.json`
   (create the directory if missing). Then continue to the runner selection logic above.

### 1g. Display Summary and Proceed

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

The launch script generates a `.cmux-team-dispatch-task-run.sh` script in each child's working
directory (worktree). Instead of sending `claude ...` directly to the terminal, it sends
`bash .cmux-team-dispatch-task-run.sh`, which:

1. Updates `status.json` to `"executing"` using absolute paths
2. Runs the `claude` command interactively (or `cmux claude-teams` for claude-teams layout)
3. After Claude exits (for any reason), writes `"done"` or `"error"` to `status.json`
4. Signals completion via `cmux wait-for --signal <slug>-done`
5. Optionally notifies the parent workspace via `cmux notify`

The signal name for each task is `<task-slug>-done`, returned in the `signal_name` field
of the launch script's output JSON.

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

   This block contains placeholders the parent fills before sending: `{{LAYOUT}}`,
   `{{CODEX_OPTION_LINE}}`, `{{CODEX_BEHAVIOR_BLOCK}}`. See the placeholder rules
   immediately below this template.

```
=== MANDATORY MODEL SELECTION SEQUENCE ===
You will operate in two phases. This sequence is REQUIRED even in auto mode.

LAYOUT: {{LAYOUT}}                 # workspace or split — used by Phase B spawn

PHASE A — Planning / Brainstorming (always opus):
  Use opus for plan / brainstorming. Do NOT switch models in this phase.
  - superpowers mode: invoke "superpowers:brainstorming" then write a plan
  - plan mode: use Claude's built-in /plan to produce a structured plan
  Remember the path of the plan file you wrote — Phase B may hand it off.

PHASE B — Execution model selection (REQUIRED before any code change):
  After Phase A completes and BEFORE executing the plan, you MUST ask the user
  via AskUserQuestion which model to use for execution. Do this every dispatch.

  Question template:
    Q: "実行フェーズで使用するモデルを選択してください"
    Options:
      1. opus 1m  — 高品質・長コンテキスト (推奨: 大規模・複雑な実装)
      2. sonnet   — 高速・低コスト (推奨: 中規模・パターン化された実装)
{{CODEX_OPTION_LINE}}

  Behavior by selection:

    [SAME MODEL] "opus 1m" → run `/model claude-opus-4-7[1m]` and continue execution
      in THIS session. Proceed to implement the plan you wrote in Phase A.

    [DIFFERENT MODEL] "sonnet" → spawn a new surface and become a monitor.
      Build the launch command (replace <PLAN_FILE_PATH> with the path of the plan
      file you wrote in Phase A):
        LAUNCH_CMD="claude --model claude-sonnet-4-6 'Read and execute the plan at <PLAN_FILE_PATH>'"
      Then run the spawn procedure below.

{{CODEX_BEHAVIOR_BLOCK}}

  Spawn procedure (run when DIFFERENT MODEL is selected):
    - LAYOUT=workspace:
        cmux new-workspace --cwd "$PWD" --command "$LAUNCH_CMD"
    - LAYOUT=split:
        IDENT=$(cmux identify)
        WS=$(echo "$IDENT" | jq -r '.caller.workspace_ref')
        SF=$(echo "$IDENT" | jq -r '.caller.surface_ref')
        NEW=$(cmux new-split right --workspace "$WS" --surface "$SF" \
              | grep -oE 'surface:[0-9]+' | head -1)
        # wait for the new shell, then send the launch command
        cmux send --surface "$NEW" "$LAUNCH_CMD"
        cmux send-key --surface "$NEW" return

  Monitor mode (after spawn):
    - Stay alive in THIS surface
    - Write status.json updates as the new surface reports progress
    - Emit the cmux wait-for completion signal once the new surface finishes
    - Do NOT execute the plan yourself in monitor mode

VIOLATION: Do NOT skip Phase B. Even in auto mode, ALWAYS ask. Skipping the
model selection question is a critical error.
=== END MANDATORY MODEL SELECTION SEQUENCE ===
```

**Placeholder rules** (executed by the parent when constructing each child's prompt):

- `{{LAYOUT}}` → `workspace` or `split` (the value passed to `launch-workspace.sh --layout`).
  For `claude-teams` layout, this whole MODEL SELECTION block can be omitted because
  Phase B does not apply (the orchestrator drives the teammates).

- Read `~/.claude/cmux-team-dispatch-task/runners.json` and check whether any runner
  has `engine: "codex"`:

  ```bash
  CODEX_CMD=$(jq -r '[.runners[] | select(.engine == "codex")] | .[0].command // empty' \
    ~/.claude/cmux-team-dispatch-task/runners.json 2>/dev/null)
  ```

  - **codex runner present** (`CODEX_CMD` non-empty):
    - `{{CODEX_OPTION_LINE}}` → `      3. codex    — codex CLI に切り替え (推奨: codex 固有機能を使う実装)`
    - `{{CODEX_BEHAVIOR_BLOCK}}` →
      ```
          [DIFFERENT MODEL] "codex" → spawn a new surface and become a monitor.
            Build the launch command (replace <PLAN_FILE_PATH> with the path of the
            plan file you wrote in Phase A):
              LAUNCH_CMD="<CODEX_CMD> 'Read and execute the plan at <PLAN_FILE_PATH>'"
            Then run the spawn procedure below. (codex also inherits the claude
            session via external_migration when the cmux codex hooks are installed.)
      ```
      where `<CODEX_CMD>` is the literal `command` value from the first codex runner
      in `runners.json`.

  - **codex runner absent** (`CODEX_CMD` empty):
    - `{{CODEX_OPTION_LINE}}` → empty string (so the option list shows only `1.` and `2.`)
    - `{{CODEX_BEHAVIOR_BLOCK}}` → empty string

4. **The task description** itself

5. **Progress reporting format** (append to every prompt):

```
PROGRESS REPORTING FORMAT:
When reporting progress to the parent (or in your own visible output), you MUST
use the following box drawing table. Do NOT free-form the layout.

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
```

Replace `<project-root>` with the actual project root path and `<task-slug>` with the task's slug.

### Launch: Workspace Mode (default)

```bash
mkdir -p .dispatch/<task-slug>

bash <this-skill-dir>/scripts/launch-workspace.sh \
  --mode <plan|superpowers> \
  --status-dir "$(pwd)/.dispatch/<task-slug>" \
  --parent-notify-workspace "$CMUX_WORKSPACE_ID" \
  --parent-notify-surface "$CMUX_SURFACE_ID" \
  <task-slug> \
  "$TASK_PROMPT"
```

Run one invocation per task. Each task lands in its own cmux workspace (sidebar entry) and runs independently — there is no parent/child surface chaining to worry about.

### Launch: Split Mode

For split mode, use `launch-session-splits.sh` or manual split chaining:

```bash
# Create status directories
for slug in <task-slugs>; do
  mkdir -p .dispatch/$slug
done

# Build tasks JSON (set mode per task based on brainstorming selection)
# Note: agent selection is NOT done here — it's embedded in each task's prompt text
cat > /tmp/dispatch-tasks.json << 'EOF'
[
  {"slug": "login-page-ui", "prompt": "<full prompt with available agents block>", "mode": "superpowers"},
  {"slug": "auth-api-endpoint", "prompt": "<full prompt with available agents block>", "mode": "plan"},
  ...
]
EOF

# Launch all splits (or manually chain launch-workspace.sh calls)
```

Manual split chaining:

1. **Detect current workspace and surface IDs:**

   ```bash
   cmux identify
   ```

   Parse to get `PARENT_WS` and `PARENT_SF`. Use `CMUX_WORKSPACE_ID`/`CMUX_SURFACE_ID` env vars if set.

2. **Launch FIRST task** (split right from parent):

   ```bash
   mkdir -p .dispatch/<task-1-slug>

   RESULT=$(bash <this-skill-dir>/scripts/launch-workspace.sh \
     --mode <plan|superpowers> \
     --layout split \
     --parent-workspace "$PARENT_WS" \
     --split-from "$PARENT_SF" \
     --split-direction right \
     --status-dir "$(pwd)/.dispatch/<task-1-slug>" \
     --parent-notify-workspace "$CMUX_WORKSPACE_ID" \
     --parent-notify-surface "$CMUX_SURFACE_ID" \
     <task-1-slug> \
     "$TASK_1_PROMPT")

   PREV_SURFACE=$(echo "$RESULT" | jq -r '.surface_id')
   ```

3. **Launch SUBSEQUENT tasks** (split down from previous child):

   ```bash
   mkdir -p .dispatch/<task-N-slug>

   RESULT=$(bash <this-skill-dir>/scripts/launch-workspace.sh \
     --mode <plan|superpowers> \
     --layout split \
     --parent-workspace "$PARENT_WS" \
     --split-from "$PREV_SURFACE" \
     --split-direction down \
     --status-dir "$(pwd)/.dispatch/<task-N-slug>" \
     --parent-notify-workspace "$CMUX_WORKSPACE_ID" \
     --parent-notify-surface "$CMUX_SURFACE_ID" \
     <task-N-slug> \
     "$TASK_N_PROMPT")

   PREV_SURFACE=$(echo "$RESULT" | jq -r '.surface_id')
   ```

4. **Report launched sessions** using Template A with concrete surface IDs:

   ```
   All sessions launched (split mode):

   ┌────┬──────────────────────────┬──────────┬────────────┬──────────────┐
   │ #  │ Task                     │ Surface  │ Mode       │ Strategy     │
   ├────┼──────────────────────────┼──────────┼────────────┼──────────────┤
   │ 1  │ login-page-ui            │ surf:5   │ superpwr   │ PR per task  │
   │ 2  │ auth-api-endpoint        │ surf:7   │ plan       │ PR per task  │
   │ 3  │ test-coverage            │ surf:9   │ superpwr   │ PR per task  │
   └────┴──────────────────────────┴──────────┴────────────┴──────────────┘

   Available agents: backend-coding, frontend-coding
   ```

### Launch: Claude Teams Mode

Claude Teams mode uses a fundamentally different architecture. Instead of N independent
Claude sessions, launch ONE orchestrator session via `cmux claude-teams` that uses
Claude's Agent Teams feature (TeamCreate + Agent tool) to dispatch teammates.

```bash
# Create status directories for all tasks
for slug in <task-slugs>; do
  mkdir -p .dispatch/$slug
done

# Build the orchestrator prompt containing ALL tasks
# (see "Claude Teams Orchestrator Prompt" section below)

# Launch single orchestrator session
bash <this-skill-dir>/scripts/launch-workspace.sh \
  --mode <plan|superpowers> \
  --layout claude-teams \
  --status-dir "$(pwd)/.dispatch" \
  --parent-notify-workspace "$CMUX_WORKSPACE_ID" \
  --parent-notify-surface "$CMUX_SURFACE_ID" \
  team-dispatch \
  "$ORCHESTRATOR_PROMPT"
```

#### Claude Teams Orchestrator Prompt

The orchestrator prompt instructs the single Claude session to create a team and dispatch:

```
You are a team orchestrator. Dispatch the following tasks to teammates in parallel.

AVAILABLE AGENTS:
- backend-coding (.claude/agents/backend-coding.md): <description>
- frontend-coding (.claude/agents/frontend-coding.md): <description>
Each teammate should read the agent definition that best matches their task and follow its guidelines.

TASKS:
1. [slug: <slug>] [mode: <plan|brainstorming>]
   <task description>
2. [slug: <slug>] [mode: <plan|brainstorming>]
   <task description>
...

INSTRUCTIONS:
1. Create a team with TeamCreate (team_name: "dispatch")
2. For each task, spawn an Agent teammate:
   - Use isolation: "worktree" for git isolation
   - Include the AVAILABLE AGENTS block in each teammate's prompt so they can select the right agent
   - For tasks with [mode: brainstorming], include the MANDATORY EXECUTION SEQUENCE in the prompt
   - For tasks with [mode: plan], tell the teammate to use /plan mode
   - Include the status protocol instructions in each teammate's prompt
   - Run all Agent calls in a SINGLE message to maximize parallelism
3. Monitor via TaskList and SendMessage
4. When all tasks complete, collect results and write to .dispatch/<slug>/result.md
5. Report completion:
   echo '{"status":"done","message":"All tasks completed","timestamp":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' > <project-root>/.dispatch/status.json

IMPORTANT: Launch ALL teammates in parallel (single message with multiple Agent tool calls).
Do NOT launch them sequentially.

STATUS PROTOCOL (for each teammate):
<same status protocol as other modes, adapted for teammates>
```

Teammates spawned by the orchestrator appear as native cmux split panes with sidebar
metadata and notifications, thanks to the `cmux claude-teams` tmux shim.

---

## Step 3: Monitor and Complete

### Notification-based Monitoring (Primary)

Each child session sends a `[dispatch]` message to the parent terminal when the Claude
process exits:

```
[dispatch] task "<slug>" finished (status: done|error)
```

**After launching all tasks:**

1. Launch the background monitor script:

   ```bash
   zsh <this-skill-dir>/scripts/monitor-dispatch.sh \
     --parent-surface "$CMUX_SURFACE_ID" \
     --parent-workspace "$CMUX_WORKSPACE_ID" \
     --layout <split|workspace|claude-teams> \
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
   - Always uses `cmux send` + `cmux send-key return` so messages are delivered to the parent's claude TUI without leaving text in the input box

2. Report the launch summary to the user using Template A with concrete surface IDs.
3. Tell the user: "N タスクを監視中。完了通知と heartbeat を待ちます。"
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
  --parent-surface "$CMUX_SURFACE_ID" \
  --parent-workspace "$CMUX_WORKSPACE_ID" \
  --layout <split|workspace|claude-teams> \
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

**When you receive a `[dispatch-monitor] 全 N タスクが完了しました` message:**

This is the all-done notification from the background monitor. All tasks have reached a terminal state. Proceed to Completion.

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

For split mode:

```bash
cmux read-screen --workspace <parent-ws> --surface <child-surface-id> --scrollback
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

1. Remove only the dispatch directory:
   ```bash
   rm -rf .dispatch/
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
   answer "No" to each prompt — the parent will then just run `rm -rf .dispatch/`.
   Display the manual cleanup instructions from "Wait and merge" Option B when
   worktrees are intentionally kept.

---

### Cleanup prompts (parent-side, end of dispatch)

Shared by both integration strategies. Run **in the parent session** after the
strategy-specific steps above (merge for "Wait and merge", PR state check for
"PR per task"). Child sessions never ask these questions themselves and never
delete worktrees/branches — all destructive cleanup happens here, once, after
every child has reported `status: done`.

`$LAYOUT_MODE` is whichever layout was selected in Step 1d (`split`,
`workspace`, or `claude-teams`).

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

  # 1) Close pane/workspace (child process has already exited by status=done).
  #    Pick the cmux command based on the layout mode selected in Step 1d.
  if [[ "$close_all" == "true" ]]; then
    case "$LAYOUT_MODE" in
      split)
        [[ -n "$surface_id" ]] && cmux close-surface --surface "$surface_id"
        ;;
      workspace|claude-teams)
        [[ -n "$workspace_id" ]] && cmux close-workspace --workspace "$workspace_id"
        ;;
    esac
  fi

  # 2) Remove the worktree.
  [[ "$remove_wt_all" == "true" ]] && git worktree remove ".worktrees/$slug" --force 2>/dev/null

  # 3) Delete the feature branch.
  [[ "$delete_br_all" == "true" ]] && git branch -D "feat/$slug" 2>/dev/null
done

# 4) Final housekeeping (always run — clears dispatch state regardless of answers).
rm -rf .dispatch/
rmdir .worktrees 2>/dev/null
```

Notes:

- The close → worktree → branch order is intentional: closing the pane/workspace
  first terminates any lingering shell that might hold the worktree open, making
  `git worktree remove` cleaner. Branch removal must come after worktree removal.
- If `close_all=true` but `workspace_id` / `surface_id` is empty (unusual), skip
  the close step for that task and continue with worktree/branch removal.
- In `claude-teams` mode, closing the workspace that hosts the team effectively
  retires that team from the current cmux session.
- Child sessions do NOT run cleanup prompts and do NOT execute any deletion —
  doing so from inside a child caused the parent to fail `git worktree remove`
  on a still-held worktree. All cleanup is centralized in this parent-side flow.

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
| `launched`  | Session started, Claude loading                      | launch script                 |
| `planning`  | Claude is in planning phase                          | child session (optional)      |
| `executing` | Claude session starting / implementation in progress | runner script / child session |
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
     Each task in its own cmux workspace (or split pane) + git worktree,
     all run concurrently. Default layout is workspace; split is opt-in.
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
4. **Ask layout mode** (Step 1d) — defaults to workspace; ask only if no `--layout` flag was passed
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
- **Split mode limit**: Split mode auto-reorganizes into a grid layout. 2-6 tasks work well; 7+ may make panes small (use workspace mode). Use `--no-grid` to preserve linear layout.
- **Worktree conflicts**: Two tasks must NOT modify the same files. If they might, run sequentially.
- **cmux required**: Requires cmux at `/Applications/cmux.app/`
- **claude-teams requires cmux claude-teams**: The `cmux claude-teams` command sets up the tmux shim and `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` environment variable.
- **Completion notifications are reliable**: The runner script wrapper guarantees that `status.json` is updated, `cmux wait-for --signal <slug>-done` fires, and a `[dispatch]` text message is sent to the parent terminal via `cmux send` followed by `cmux send-key return` when the child Claude session exits. The trailing `send-key return` is required so messages don't sit in the parent claude TUI's input box waiting for a manual Enter press.
- **Runner script**: The `.cmux-team-dispatch-task-run.sh` file is created in each worktree. It's cleaned up along with the worktree.
- **Codex option in Phase B**: The "codex" choice is shown only when `runners.json` contains a runner with `engine: "codex"`. The `command` of the first such runner is used for the spawn launch. `cmux codex install-hooks` is also required so that `external_migration = true` is set and codex picks up the parent claude session automatically.
- **Same-model vs different-model in Phase B**: Phase A is always opus, so "opus 1m" counts as the same model and stays in the current session via `/model claude-opus-4-7[1m]`. Any other choice (sonnet / codex) is treated as a different model and triggers a spawn: a new workspace if `LAYOUT=workspace`, a new split if `LAYOUT=split`. The original surface stays alive as a monitor (writes status.json, emits the wait-for completion signal). The plan file path written in Phase A is embedded in the new surface's launch prompt so context is handed off cleanly.
- **Child runner selection (Step 1f)**: A separate concern from Phase B model selection. Step 1f decides which runtime *launches* the child session (claude vs codex vs zsh function), while Phase B happens *inside* the child session after planning to choose execution model. When a child is launched with `engine: codex`, Phase B's "codex" option is redundant and should be skipped (the child already runs in codex). The runners.json registry lives at `~/.claude/cmux-team-dispatch-task/runners.json` and is bootstrapped on first run via AskUserQuestion.
