---
name: cmux-team-dispatch-task
description: >
  Orchestrate parallel execution of multiple tasks via cmux workspaces.
  Each task gets its own git worktree + Claude Code session. The parent
  session acts as orchestrator, monitoring all child sessions. Dynamically
  discovers available agent types from .claude/agents/ and passes the list
  to child sessions, which select the appropriate agent themselves.
  Supports three layout modes: split (panes within current
  workspace), workspace (separate sidebar entries), and claude-teams (native
  Agent Teams via cmux claude-teams). Dispatches immediately without parent-side
  planning — each child handles its own brainstorming/planning in parallel.
  Use when: "parallel execution", "team dispatch", "run these at once",
  "run these in parallel", "dispatch tasks", "execute these simultaneously",
  or when 2+ independent tasks need concurrent execution.
argument-hint: "<task1>, <task2>, ... [--layout workspace|claude-teams] [--no-grid]"
---

# Team Dispatch

Orchestrate parallel task execution across multiple Claude Code sessions. Each task runs
in its own isolated git worktree while the parent session coordinates everything.
Dispatches immediately — no parent-side planning. Each child session handles its own
brainstorming and planning in parallel.

For the Japanese reference guide, see `references/guide-ja.md`.

---

## Step 1: Parse and Prepare

This single step handles task collection, agent routing, layout selection, and integration
strategy. Three user interactions before dispatch: brainstorming selection (1c), layout
mode selection (1d), and integration strategy selection (1e).

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
  - `--layout workspace` or `--layout claude-teams`: override default split layout
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
> 1. **split** (default) — Panes within current workspace, auto-grid layout (2-6 tasks recommended)
> 2. **workspace** — Each task in a separate cmux workspace sidebar entry (long-running, 7+ tasks)
> 3. **claude-teams** — Native Agent Teams via cmux claude-teams (sidebar notifications)

| Mode              | Description                                               | Recommended for                        |
| ----------------- | --------------------------------------------------------- | -------------------------------------- |
| `split` (default) | Split panes within current workspace, auto-grid layout    | 2-6 tasks, visual overview             |
| `workspace`       | Each task in a separate cmux workspace (sidebar entry)    | Long-running, 7+ tasks                 |
| `claude-teams`    | Single orchestrator via `cmux claude-teams` + Agent Teams | Native notifications, sidebar metadata |

```
split mode:                  workspace mode:              claude-teams mode:
+----------+----------+     +----------+ +----------+    +----------+----------+
| Parent   | Child 1  |     | ws: t-1  | | ws: t-2  |   | Orchest. | Team-1   |
+----------+----------+     |          | |          |   +----------+----------+
| Child 2  | Child 3  |     +----------+ +----------+   | Team-2   | Team-3   |
+----------+----------+                                  +----------+----------+
(auto-grid)                  (separate tabs)              (native Agent Teams)
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

### 1f. Display Summary and Proceed

Print an informational summary (NOT a confirmation prompt) and proceed to launch immediately:

```
Dispatching 3 tasks (workspace mode, PR per task):
  1. login-page-ui      [brainstorming]
  2. auth-api-endpoint   [plan]
  3. test-coverage       [brainstorming]
Available agents: backend-coding, frontend-coding
Integration: PR per task
Launching...
```

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

3. **The task description** itself

4. **Status protocol instructions** (append to every prompt):

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

2. Capture cleanup preferences before reporting done.
  Use the Skill tool to invoke "AskUserQuestion" with exactly these two questions,
  in this order, asked in THIS child session:
    Q1 header="Worktree"
       question="Delete this worktree (.worktrees/<task-slug>) after completion?
                 Commits remain on branch feat/<task-slug>."
       options: "Yes, delete" / "No, keep"
    Q2 header="Pane/Workspace"
       question="Close this session's pane/workspace after completion?"
       options: "Yes, close" / "No, keep open"
  Record the answers as booleans (Yes=true, No=false) for the next step.

3. Then report completion, embedding the captured preferences:
  echo '{"status":"done","message":"<summary of changes>","cleanup_preference":{"delete_worktree":<bool>,"close_surface":<bool>},"timestamp":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' > <project-root>/.dispatch/<task-slug>/status.json
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

3. Capture cleanup preferences before reporting done.
  The PR is now on GitHub (the remote branch stays even if you delete the local worktree).
  Use the Skill tool to invoke "AskUserQuestion" with exactly these two questions,
  in this order, asked in THIS child session:
    Q1 header="Worktree"
       question="PR created — delete this worktree (.worktrees/<task-slug>) now?
                 Remote branch feat/<task-slug> and the PR remain on GitHub."
       options: "Yes, delete" / "No, keep"
    Q2 header="Pane/Workspace"
       question="Close this session's pane/workspace after completion?"
       options: "Yes, close" / "No, keep open"
  Record the answers as booleans (Yes=true, No=false) for the next step.

4. Then report completion (include PR URL and cleanup preferences):
  PR_URL=$(gh pr view --json url -q '.url')
  echo '{"status":"done","message":"<summary of changes>","pr_url":"'"$PR_URL"'","cleanup_preference":{"delete_worktree":<bool>,"close_surface":<bool>},"timestamp":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' > <project-root>/.dispatch/<task-slug>/status.json
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

### Launch: Split Mode (default)

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

4. **Report launched sessions:**
   ```
   All sessions launched:
     1. login-page-ui      | surface:5  | superpowers
     2. auth-api-endpoint   | surface:7  | plan
     3. test-coverage       | surface:9  | superpowers
   Available agents: backend-coding, frontend-coding
   Layout: split (panes in current workspace)
   ```

### Launch: Workspace Mode

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
     --debug \
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
4. Count completed tasks against the total. If all tasks are done, proceed to Completion.
5. If some tasks remain, tell the user how many are left and end your turn again.

**When you receive a `[dispatch-monitor]` message:**

This is the all-done notification from the background monitor. All tasks have reached
a terminal state. Proceed to Completion.

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

2. **Generate consolidated report**:

   **When integration strategy is "Wait and merge":**

   ```
   # Team Dispatch Report

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
4. After successful merge, apply per-task cleanup preferences
   (see "Per-task cleanup from preferences" below). This replaces the previous blanket
   worktree removal — each task is cleaned up according to what the child session
   captured from the user.
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
3. **Apply per-task cleanup preferences** (see "Per-task cleanup from preferences" below).
   Each child session captured the user's cleanup intent in its own
   `status.json` → `cleanup_preference`. The parent applies those per task; no blanket
   "clean up all / keep all" decision is needed.

   If the user prefers to defer all cleanup (e.g., PRs still need review), they can
   choose "No, keep" in the child sessions, or the parent can skip the per-task loop
   entirely and just run `rm -rf .dispatch/`. Display the manual cleanup instructions
   from "Wait and merge" Option B when worktrees are intentionally kept.

---

### Per-task cleanup from preferences

Shared by both integration strategies. Run after the strategy-specific steps above
(merge for "Wait and merge", PR state check for "PR per task"). `$LAYOUT_MODE` is
whichever layout was selected in Step 1d (`split`, `workspace`, or `claude-teams`).

```bash
# For each task, read the child's captured preferences from status.json and act.
for slug in <task-slugs>; do
  pref_file=".dispatch/$slug/status.json"
  delete=$(jq -r '.cleanup_preference.delete_worktree // empty' "$pref_file")
  close=$(jq -r '.cleanup_preference.close_surface // empty' "$pref_file")
  workspace_id=$(jq -r '.workspace_id // empty' "$pref_file")
  surface_id=$(jq -r '.surface_id // empty' "$pref_file")

  # Fallback: preferences missing → ask the user once, per task.
  if [[ -z "$delete" ]]; then
    read -rp "Delete worktree .worktrees/$slug? [y/N] " ans
    [[ "$ans" =~ ^[Yy] ]] && delete=true || delete=false
  fi
  if [[ -z "$close" ]]; then
    read -rp "Close pane/workspace for $slug? [y/N] " ans
    [[ "$ans" =~ ^[Yy] ]] && close=true || close=false
  fi

  # 1) Close pane/workspace (child process has already exited by status=done).
  #    Pick the cmux command based on the layout mode selected in Step 1d.
  if [[ "$close" == "true" ]]; then
    case "$LAYOUT_MODE" in
      split)
        cmux close-surface --surface "$surface_id"
        ;;
      workspace|claude-teams)
        cmux close-workspace --workspace "$workspace_id"
        ;;
    esac
  fi

  # 2) Remove the worktree and its feature branch.
  if [[ "$delete" == "true" ]]; then
    git worktree remove ".worktrees/$slug" --force 2>/dev/null
    git branch -D "feat/$slug" 2>/dev/null
  fi
done

# 3) Final housekeeping (after all tasks processed).
rm -rf .dispatch/
rmdir .worktrees 2>/dev/null
```

Notes:

- The close-before-remove order is intentional: closing the pane/workspace first
  terminates any lingering shell that might hold the worktree open, making
  `git worktree remove` cleaner.
- If `close_surface=true` but the `workspace_id` / `surface_id` is empty (unusual),
  skip the close step and continue with worktree removal.
- In `claude-teams` mode, closing the workspace that hosts the team effectively
  retires that team from the current cmux session.

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
  "cleanup_preference": {
    "delete_worktree": true,
    "close_surface": true
  },
  "timestamp": "2026-04-07T16:00:00Z"
}
```

The `pr_url` field is only present when integration strategy is "PR per task" and the child
session has successfully created a PR. It is written at status `done`.

The `cleanup_preference` object is written by the **child session itself** at status `done`,
capturing the answers the user gave in-session to the two cleanup questions (see "Capture
cleanup preferences" step in the status protocol). The parent reads these during Integration
and Cleanup and executes the actions per task. If the field is absent (e.g., child errored or
skipped the prompt), the parent falls back to asking the user directly for that task.

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

  3. Parallel (cmux split)          → cmux-team-dispatch-task split mode  ← THIS SKILL
     Each task in its own cmux split pane + git worktree, all run concurrently
```

### When to Suggest Parallel (cmux split)

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
4. **Ask layout mode** (Step 1d) — pre-selected as split mode, or claude-teams via argument; still ask if no `--layout` flag
5. **Ask integration strategy** (Step 1e) — ask PR per task or Wait and merge
6. **Launch all tasks** using launch commands from Step 2
7. **Monitor** using Step 3

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
- **Completion notifications are reliable**: The runner script wrapper guarantees that `status.json` is updated, `cmux wait-for --signal <slug>-done` fires, and a `[dispatch]` text message is sent to the parent terminal via `cmux send` when the child Claude session exits.
- **Runner script**: The `.cmux-team-dispatch-task-run.sh` file is created in each worktree. It's cleaned up along with the worktree.
