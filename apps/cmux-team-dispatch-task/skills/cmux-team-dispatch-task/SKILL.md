---
name: cmux-team-dispatch-task
description: >
  Orchestrate parallel execution of multiple tasks via cmux workspaces.
  Each task gets its own git worktree + Claude Code session. The parent
  session acts as orchestrator, monitoring all child sessions. Dynamically
  discovers available agent types from .claude/agents/ and routes tasks
  to matching agents. Supports two layout modes: workspace (separate sidebar entries)
  and split (panes within current workspace). Use when: "parallel execution",
  "team dispatch", "run these at once", "run these in parallel",
  "dispatch tasks", "execute these simultaneously", or when 2+ independent
  tasks need concurrent execution. Always use this skill instead of manually
  creating multiple cmux workspaces when orchestrating team work.
argument-hint: "<task1>, <task2>, ... or empty (interactive input)"
---

# Team Dispatch

Orchestrate parallel task execution across multiple Claude Code sessions. Each task runs
in its own isolated git worktree while the parent session coordinates everything.

For the Japanese reference guide, see `references/guide-ja.md`.

---

## Step 1: Collect Tasks

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

**Output of this step:** A numbered task list with slugs and descriptions.

---

## Step 2: Discover Available Agents

Scan the `.claude/agents/` directory to find all agent definitions:

```bash
ls .claude/agents/*.md 2>/dev/null
```

For each `.md` file found, read the YAML frontmatter to extract `name` and `description`.
Build a lookup table of available agent types. Example:

| Agent Name      | Source File                         | Description (excerpt)              |
| --------------- | ----------------------------------- | ---------------------------------- |
| frontend-coding | `.claude/agents/frontend-coding.md` | React, UI, renderer process...     |
| backend-coding  | `.claude/agents/backend-coding.md`  | Node.js, API, IPC, main process... |

If `.claude/agents/` is empty or doesn't exist, all tasks route to general-purpose (no agent hint).

---

## Step 3: Route Tasks to Agents

For each task, determine the best matching agent:

1. **Explicit tag override**: If the task contains `[frontend]`, `[backend]`, or any `[agent-name]` tag, use that agent directly.
2. **Plan file reference**: If the task references a `.claude/plans/*.md` file, read the plan content and match keywords against agent descriptions.
3. **Keyword matching**: Compare task description against each agent's `description` field.
   - Frontend signals: React, component, UI, CSS, page, renderer, Tailwind, styling
   - Backend signals: API, endpoint, IPC, database, service, handler, main process
4. **No match**: Leave as general-purpose (no agent hint).

Present the routing summary to the user for confirmation:

```
Tasks to dispatch:

1. login-page-ui -> Agent: frontend-coding, Mode: TBD
2. auth-api-endpoint -> Agent: backend-coding, Mode: TBD
3. test-coverage -> Agent: general-purpose, Mode: TBD

Does this routing look correct?
```

---

## Step 4: Choose Planning Mode

Ask the user which planning mode to use for each session (or all sessions):

**Option A: superpowers mode**

- If the `superpowers` plugin is installed, each child session will first invoke `superpowers:brainstorming` to explore context and design the approach, then transition to `superpowers:writing-plans` for structured planning before execution.
- Claude is launched without `/plan` prefix so superpowers skills trigger naturally.

**Option B: plan mode**

- Each child session uses Claude's built-in `/plan` mode.
- Claude launches with `/plan` prefix.

The user can choose one mode for all tasks or pick per-task.

---

## Step 5: Choose Layout Mode

Ask the user which layout to use for the child sessions:

**Option A: workspace mode (default)**

- Each task creates a separate cmux workspace (separate sidebar entry).
- Workspaces appear as entries in the left sidebar of cmux.
- Best for long-running or complex tasks that need full screen space.
- Easier to individually monitor.

**Option B: split mode**

- All tasks are split panes within the CURRENT workspace.
- After all panes are created, automatically reorganized into a grid layout (parent included).
- Best for quick tasks or when visual overview of all sessions is desired.
- Recommended for 2-6 tasks (more may make panes too small).
- Use `--no-grid` with `launch-session-splits.sh` to preserve the old linear layout.

```
workspace mode:              split mode (auto-grid):
+----------+ +----------+   +----------+----------+
| ws: t-1  | | ws: t-2  |   | Parent   | Child 1  |
|          | |          |   +----------+----------+
|          | |          |   | Child 2  | Child 3  |
|          | |          |   +----------+----------+
|          | |          |   (4 surfaces -> 2x2 grid)
+----------+ +----------+
```

---

## Step 6: Launch Sessions

### Prompt File Approach

The launch script writes the full prompt to a `.cmux-team-dispatch-task-prompt.md` file in each
child's working directory (worktree). The Claude command sent via cmux only references
this file, completely avoiding shell escaping issues with complex prompt content.

### Runner Script Wrapper

The launch script generates a `.cmux-team-dispatch-task-run.sh` script in each child's working
directory (worktree). Instead of sending `claude ...` directly to the terminal, it sends
`bash .cmux-team-dispatch-task-run.sh`, which:

1. Updates `status.json` to `"executing"` using absolute paths
2. Runs the `claude` command interactively
3. After Claude exits (for any reason), writes `"done"` or `"error"` to `status.json`
4. Signals completion via `cmux wait-for --signal <slug>-done`
5. Optionally notifies the parent workspace via `cmux notify`

This ensures that status reporting and completion signaling happen reliably, regardless
of whether the child Claude session follows the in-prompt status instructions.

The signal name for each task is `<task-slug>-done`, returned in the `signal_name` field
of the launch script's output JSON.

### Building the Task Prompt

For each task, construct the full prompt text that will be written to the file:

1. **The task description** itself
2. **superpowers mode only — brainstorming directive** (append when `--mode superpowers`):

```
IMPORTANT: You are running in superpowers mode.
Before writing an implementation plan, you MUST first invoke /brainstorming to:
- Explore the project context and understand the codebase
- Design your approach with trade-offs considered
After brainstorming completes, it will naturally transition to writing-plans for the implementation plan.
Do NOT skip brainstorming and jump directly to writing-plans.
```

3. **Status protocol instructions** (append to every prompt):

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

2. Then report completion:
  echo '{"status":"done","message":"<summary of changes>","timestamp":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' > <project-root>/.dispatch/<task-slug>/status.json
And write a result summary to <project-root>/.dispatch/<task-slug>/result.md with sections:
  # <Task Name>
  ## Changes Made
  ## Test Results
  ## Commits

If you encounter a blocking error, run:
  echo '{"status":"error","message":"<error description>","timestamp":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' > <project-root>/.dispatch/<task-slug>/status.json
```

Replace `<project-root>` with the actual project root path and `<task-slug>` with the task's slug.

### Launch Command: Workspace Mode

```bash
# Create status directory
mkdir -p .dispatch/<task-slug>

# Launch (prompt is written to file by the script automatically)
bash <this-skill-dir>/scripts/launch-workspace.sh \
  --mode <plan|superpowers> \
  --status-dir "$(pwd)/.dispatch/<task-slug>" \
  --agent-hint <agent-name-or-empty> \
  --parent-notify-workspace "$CMUX_WORKSPACE_ID" \
  --parent-notify-surface "$CMUX_SURFACE_ID" \
  <task-slug> \
  "$TASK_PROMPT"
```

The `<this-skill-dir>` resolves to the directory containing this SKILL.md file.

### Launch Sequence: Split Mode

When split mode is chosen:

1. **Detect current workspace and surface IDs:**

   ```bash
   cmux identify
   ```

   Parse the output to get `PARENT_WS` (workspace ID) and `PARENT_SF` (surface ID).
   If `CMUX_WORKSPACE_ID` and `CMUX_SURFACE_ID` environment variables are set, use those.

2. **Launch the FIRST task** (split right from parent):

   ```bash
   mkdir -p .dispatch/<task-1-slug>

   RESULT=$(bash <this-skill-dir>/scripts/launch-workspace.sh \
     --mode <plan|superpowers> \
     --layout split \
     --parent-workspace "$PARENT_WS" \
     --split-from "$PARENT_SF" \
     --split-direction right \
     --status-dir "$(pwd)/.dispatch/<task-1-slug>" \
     --agent-hint <agent-name> \
     --parent-notify-workspace "$CMUX_WORKSPACE_ID" \
     --parent-notify-surface "$CMUX_SURFACE_ID" \
     <task-1-slug> \
     "$TASK_1_PROMPT")

   # Capture the new surface ID for chaining
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
     --agent-hint <agent-name> \
     --parent-notify-workspace "$CMUX_WORKSPACE_ID" \
     --parent-notify-surface "$CMUX_SURFACE_ID" \
     <task-N-slug> \
     "$TASK_N_PROMPT")

   PREV_SURFACE=$(echo "$RESULT" | jq -r '.surface_id')
   ```

4. **Report all launched sessions** to the user:

   ```
   All sessions launched:

   1. login-page-ui      | surface:5  | frontend-coding | plan mode
   2. auth-api-endpoint   | surface:7  | backend-coding  | plan mode
   3. test-coverage       | surface:9  | general         | superpowers

   Layout: split (panes in current workspace)
   Status directory: .dispatch/
   ```

---

## Step 7: Monitor Sessions

### Notification-based Monitoring (Primary)

Each child session sends a `[dispatch]` message to the parent terminal when the Claude
process exits. The message appears as user input in the parent session:

```
[dispatch] task "<slug>" finished (status: done|error)
```

**After launching all tasks:**

1. Launch the background monitor script:
   ```bash
   bash <this-skill-dir>/scripts/monitor-dispatch.sh \
     --parent-surface "$CMUX_SURFACE_ID" \
     --parent-workspace "$CMUX_WORKSPACE_ID" \
     --layout <split|workspace> \
     --interval 10 \
     "$(pwd)/.dispatch"
   ```
   Run this command with `run_in_background` so it does not block your turn.

2. Report the launch summary to the user (task count, slugs, surfaces).
3. Tell the user: "N タスクを監視中。完了通知を待ちます。"
4. **End your turn.** Do not block waiting.

**When you receive a `[dispatch] task "X" finished` message:**

1. Read `.dispatch/<slug>/status.json` to get the full status and message.
2. If status is `"done"`, also read `.dispatch/<slug>/result.md` if it exists.
3. Report the task result to the user.
4. Count completed tasks against the total. If all tasks are done, proceed to Step 8.
5. If some tasks remain, tell the user how many are left and end your turn again.

**When you receive a `[dispatch-monitor]` message:**

This is the all-done notification from the background monitor. All tasks have reached
a terminal state. Proceed to Step 8.

**Example flow:**

```
User: [dispatch] task "login-page-ui" finished (status: done)

Claude: タスク "login-page-ui" が完了しました。
  結果: ログインフォームコンポーネントを実装。
  残り 2/3 タスク。完了通知を待ちます。

User: [dispatch] task "auth-api" finished (status: done)

Claude: タスク "auth-api" が完了しました。
  結果: /api/auth エンドポイントと JWT ミドルウェアを追加。
  残り 1/3 タスク。完了通知を待ちます。

User: [dispatch] task "test-coverage" finished (status: error)

Claude: タスク "test-coverage" でエラーが発生しました。
  エラー: Claude session exited with code 1.
  全 3 タスクが完了。Step 8 に進みます。
```

### Polling Status Files (Manual Check)

If the user asks about progress, or if you need to check status between notifications:

```bash
for f in .dispatch/*/status.json; do
  task_name=$(dirname "$f" | xargs basename)
  status=$(jq -r '.status' "$f" 2>/dev/null || echo "unknown")
  message=$(jq -r '.message' "$f" 2>/dev/null || echo "")
  echo "$task_name: $status - $message"
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

---

## Step 8: Completion

When all tasks reach `"status": "done"` (detected via `cmux wait-for` signals or status file polling):

1. **Collect results**: Read all `.dispatch/<task-slug>/result.md` files.

2. **Generate consolidated report**:

   ```
   # Team Dispatch Report

   ## Task Results

   ### 1. login-page-ui (frontend-coding)
   <contents of .dispatch/login-page-ui/result.md>

   ### 2. auth-api-endpoint (backend-coding)
   <contents of .dispatch/auth-api-endpoint/result.md>

   ## Worktree Branches
   - feat/login-page-ui
   - feat/auth-api-endpoint

   ## Next Steps
   - Review and merge branches
   - Run full test suite across all changes
   - Clean up worktrees when done
   ```

3. **Ask the user whether to merge**:

### Merge and Cleanup

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
4. After successful merge, run full cleanup:
   ```bash
   # Remove worktrees
   for slug in <task-slugs>; do
     git worktree remove ".worktrees/$slug" --force 2>/dev/null
   done
   # Delete feature branches
   for slug in <task-slugs>; do
     git branch -D "feat/$slug" 2>/dev/null
   done
   # Remove dispatch directory
   rm -rf .dispatch/
   # Remove worktrees directory if empty
   rmdir .worktrees 2>/dev/null
   ```
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
  "timestamp": "2026-04-07T16:00:00Z"
}
```

| Status      | Meaning                                              | Written By                    |
| ----------- | ---------------------------------------------------- | ----------------------------- |
| `launched`  | Session started, Claude loading                      | launch script                 |
| `planning`  | Claude is in planning phase                          | child session (optional)      |
| `executing` | Claude session starting / implementation in progress | runner script / child session |
| `done`      | All work complete                                    | runner script / child session |
| `error`     | Blocked by an error or non-zero exit                 | runner script / child session |

### result.md

Written by the child session when status becomes `done`:

```markdown
# <Task Name>

## Changes Made

- List of files changed and what was done

## Test Results

- Test pass/fail summary

## Commits

- <hash> <commit message>
```

---

## superpowers Execution Handoff Integration

This skill integrates with `superpowers:writing-plans` as a **third execution option** in the
Execution Handoff. When a plan is complete, `writing-plans` presents execution choices. This
skill adds the parallel option:

```
writing-plans Execution Handoff:

  "Plan complete. Three execution options:"

  1. Subagent-Driven (recommended)  → superpowers:subagent-driven-development
     Sequential, one subagent per task, two-stage review after each

  2. Inline Execution               → superpowers:executing-plans
     Batch execution in this session with checkpoints

  3. Parallel (cmux split)          → cmux-team-dispatch-task split mode  ← THIS SKILL
     Each task in its own cmux split pane + git worktree, all run concurrently
```

### When to Suggest Parallel (cmux split)

| Option | Best for |
|--------|----------|
| Subagent-Driven | Tasks with dependencies, review-heavy workflows, cost-conscious execution |
| Inline Execution | Simple plans, interactive execution, single-session preference |
| **Parallel (cmux)** | **3+ independent tasks, speed priority, visual overview of all sessions** |

### Flow When Parallel Is Chosen

When the user selects option 3:

1. **Skip Steps 1-4** of this skill (tasks already defined in the plan, mode is `superpowers`)
2. **Parse the plan file** to extract independent tasks with descriptions
3. **Choose split layout** (Step 5 is pre-selected as split mode)
4. **Launch all tasks** using the convenience script:

   ```bash
   bash <this-skill-dir>/scripts/launch-session-splits.sh \
     --mode superpowers \
     --tasks-file /tmp/plan-tasks.json
   ```

   The tasks JSON file format:
   ```json
   [
     {"slug": "login-ui", "prompt": "Task description...", "agent": "frontend-coding"},
     {"slug": "auth-api", "prompt": "Task description...", "agent": "backend-coding"},
     {"slug": "test-coverage", "prompt": "Task description..."}
   ]
   ```

   Alternatively, pass tasks inline:
   ```bash
   bash <this-skill-dir>/scripts/launch-session-splits.sh \
     --mode superpowers \
     --tasks '[{"slug":"login-ui","prompt":"...","agent":"frontend-coding"}]'
   ```

5. **Monitor** using Step 7 (signal-based monitoring + status file polling)
6. **Complete** using Step 8 (collect results, merge or preserve worktrees)

### Building the Tasks JSON from a Plan

When parsing a `superpowers:writing-plans` plan file:

1. Each `### Task N: <name>` heading becomes a task entry
2. The task slug is derived from the heading (lowercase, hyphens, max 30 chars)
3. The prompt includes:
   - The full task text (all steps under that heading)
   - A reference to the plan file for context
   - The status protocol instructions (same as Step 6)
4. The agent is determined by keyword matching (same as Step 3)

### Example

Given a plan with 3 independent tasks:

```
# Feature Implementation Plan

### Task 1: Login Page UI
(React component implementation...)

### Task 2: Auth API Endpoint
(Express route + middleware...)

### Task 3: Integration Tests
(E2E test suite...)
```

The orchestrator:

```bash
# 1. Parse plan into tasks JSON
cat > /tmp/plan-tasks.json << 'EOF'
[
  {"slug": "login-page-ui", "prompt": "Implement Task 1 from the plan...", "agent": "frontend-coding"},
  {"slug": "auth-api-endpoint", "prompt": "Implement Task 2 from the plan...", "agent": "backend-coding"},
  {"slug": "integration-tests", "prompt": "Implement Task 3 from the plan..."}
]
EOF

# 2. Launch all tasks in split panes
RESULT=$(bash .claude/skills/cmux-team-dispatch-task/scripts/launch-session-splits.sh \
  --mode superpowers \
  --tasks-file /tmp/plan-tasks.json)

# 3. Launch background monitor
bash <this-skill-dir>/scripts/monitor-dispatch.sh \
  --parent-surface "$CMUX_SURFACE_ID" \
  --parent-workspace "$CMUX_WORKSPACE_ID" \
  --layout split \
  "$(pwd)/.dispatch"
# Run with run_in_background. Child sessions send [dispatch] messages
# to this terminal on completion. See Step 7.

# 4. Collect results and merge (after all [dispatch] messages received)
```

### Differences from Standalone Usage

| Aspect | Standalone (Steps 1-8) | superpowers Integration |
|--------|----------------------|------------------------|
| Task source | User input or CLI args | Parsed from plan file |
| Planning mode | User chooses (plan/superpowers) | Always `superpowers` (brainstorming already done) |
| Layout mode | User chooses (workspace/split) | Always `split` |
| Steps used | All (1-8) | Steps 5-8 only (1-4 pre-determined) |
| Agent routing | Keyword matching | Keyword matching (same logic) |

---

## Constraints

- **Concurrent sessions**: Limited by system resources; 3-5 sessions recommended
- **Split mode limit**: Split mode auto-reorganizes into a grid layout. 2-6 tasks work well; 7+ may still make panes small (use workspace mode instead). Use `--no-grid` to preserve linear layout.
- **Worktree conflicts**: Two tasks must NOT modify the same files. If they might, run sequentially.
- **cmux required**: Requires cmux at `/Applications/cmux.app/`
- **Completion notifications are reliable**: The runner script wrapper guarantees that `status.json` is updated, `cmux wait-for --signal <slug>-done` fires, and a `[dispatch]` text message is sent to the parent terminal via `cmux send` when the child Claude session exits. In-prompt status instructions remain best-effort for mid-execution updates.
- **Runner script**: The `.cmux-team-dispatch-task-run.sh` file is created in each worktree. It's cleaned up along with the worktree.
