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

## Step 1: Parse and Prepare

This single step handles task collection, agent routing, layout selection, integration
strategy, and runtime selection. Up to five user interactions before dispatch:
brainstorming selection (1c), layout mode selection (1d), integration strategy
selection (1e), child runner selection (1f), and message transport selection
(1g, first time only).

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
    { "name": "codex",   "command": "codex",   "engine": "codex",  "review_model": "gpt-5.6-sol" }
  ]
}
```

Field meanings:

- `name`: unique identifier shown in AskUserQuestion options
- `command`: the executable / zsh function to invoke
- `engine`: `claude` or `codex` — controls flag composition (see table below)
- `review_model` (optional, `engine: codex` の runner のみ): Phase A-R (plan/spec レビュー)
  でレビューペインに渡すモデル名。未設定なら Phase A-R は無効

**engine × MODE invocation table** (executed by `launch-workspace.sh`):

| engine | MODE        | Composed command                                                                                          |
|--------|-------------|-----------------------------------------------------------------------------------------------------------|
| claude | plan        | `<command> --dangerously-skip-permissions '/plan Read and follow the task in .cmux-team-dispatch-task-prompt.md'` |
| claude | superpowers | `<command> 'Read and follow the task in .cmux-team-dispatch-task-prompt.md'`                              |
| claude | execute     | `<command> [--model <X>] [--dangerously-skip-permissions] 'Read and execute the plan at <plan-file>'`     |
| codex  | plan        | `<command> --dangerously-bypass-approvals-and-sandbox '/plan Read and follow the task in .cmux-team-dispatch-task-prompt.md'` |
| codex  | superpowers | `<command> '$superpowers:brainstorming Read and follow the task in .cmux-team-dispatch-task-prompt.md'`   |
| codex  | execute     | `<command> --dangerously-bypass-approvals-and-sandbox 'Read and execute the plan at <plan-file>'`         |

`execute` モードは Phase B (実装フェーズ) で別 surface に実装を移譲するときに使う。
`--plan-file <path>` で計画ファイルパスを指定し、`.cmux-team-dispatch-task-prompt.md`
は書き換えない (Phase A のものを温存)。claude engine では `--model` と
`--skip-permissions` を追加可能 (sonnet など auto mode が効かないモデル用)。

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
   - **review_model** (free text, engine が `codex` のときのみ質問, 例 `gpt-5.6-sol`) —
     plan/spec レビュー (Phase A-R) 用モデル。空回答で省略可

   After each runner is added, ask: 「もう 1 件追加しますか？」 (Yes → loop; No → finish).

4. After at least one runner is registered, also ask which runner is the `default`
   (used when the user picks "No" at the switch question, or implicitly when only
   1 runner exists). If only one runner was added, it becomes `default` automatically.

5. Write the assembled object to `~/.claude/cmux-team-dispatch-task/runners.json`
   (create the directory if missing). Then continue to the runner selection logic above.

### 1g. Resolve Message Transport

Decide how child sessions notify the parent (`message_type`): `send-message`
(current cmux send behavior, default) or `agmsg` (cross-agent messaging via
[agmsg](https://github.com/fujibee/agmsg)).

1. Read `message_type` from `<project>/.dispatch/config.json`, falling back to
   `~/.claude/cmux-team-dispatch-task/config.json`:

   ```bash
   MSG_TYPE=$(jq -r '.message_type // empty' .dispatch/config.json 2>/dev/null)
   [[ -z "$MSG_TYPE" ]] && MSG_TYPE=$(jq -r '.message_type // empty' \
     ~/.claude/cmux-team-dispatch-task/config.json 2>/dev/null)
   ```

   If set, use it silently — do NOT ask.

2. If unset, check whether agmsg is installed:
   `[ -f ~/.agents/skills/agmsg/scripts/send.sh ]`
   - Not installed → use `send-message`. Do NOT write config (so the question
     fires once agmsg gets installed later).
   - Installed → ask via AskUserQuestion:
     > 通知トランスポートに agmsg を使いますか？ (agmsg: エージェント間の直接メッセージング。monitor ループ不要)
     Persist BOTH answers (Yes → `agmsg`, No → `send-message`) to the global config:

   ```bash
   CONFIG=~/.claude/cmux-team-dispatch-task/config.json
   mkdir -p "$(dirname "$CONFIG")"
   if [[ -f "$CONFIG" ]]; then
     jq --arg mt "<answer>" '.message_type = $mt' "$CONFIG" > "$CONFIG.tmp" && mv "$CONFIG.tmp" "$CONFIG"
   else
     jq -n --arg mt "<answer>" '{message_type: $mt}' > "$CONFIG"
   fi
   ```

**Resolve review mode (`review_mode`)** — same precedence pattern as `message_type`:

1. ALWAYS resolve `REVIEW_MODEL` from runners.json first (it is needed by step 3's
   `REVIEW_ENABLED` computation regardless of whether the question fires):

   ```bash
   REVIEW_MODEL=$(jq -r '[.runners[] | select(.engine == "codex" and .review_model != null)] | .[0].review_model // empty' \
     ~/.claude/cmux-team-dispatch-task/runners.json 2>/dev/null)
   ```

2. Read `review_mode` from `<project>/.dispatch/config.json`, falling back to
   `~/.claude/cmux-team-dispatch-task/config.json`:

   ```bash
   REVIEW_MODE=$(jq -r '.review_mode // empty' .dispatch/config.json 2>/dev/null)
   [[ -z "$REVIEW_MODE" ]] && REVIEW_MODE=$(jq -r '.review_mode // empty' \
     ~/.claude/cmux-team-dispatch-task/config.json 2>/dev/null)
   ```

   If set (`"on"` / `"off"`), use it silently — do NOT ask.

   If unset:
   - `REVIEW_MODEL` empty → treat as `off`. Do NOT write config (so the question
     fires once a review_model gets configured later).
   - `REVIEW_MODEL` non-empty → ask via AskUserQuestion:
     > plan/spec の codex レビュー (Phase A-R) を有効にしますか？ (Phase A の成果物を codex (`<review_model>`) が approve するまでレビューします)
     Persist BOTH answers (Yes → `"on"`, No → `"off"`) to the global config with the
     same jq merge pattern as `message_type` above (key: `review_mode`).

3. Compute the final flag used by prompt construction (Step 2) and pre-warm:

   ```bash
   # REVIEW_ENABLED: codex runner + review_model + review_mode=on の 3 条件
   REVIEW_ENABLED=false
   [[ -n "$CODEX_CMD" && -n "$REVIEW_MODEL" && "$REVIEW_MODE" == "on" ]] && REVIEW_ENABLED=true
   ```

   (`CODEX_CMD` / `CODEX_RUNNER_NAME` は placeholder rules 節と同じ jq クエリで得る)

**When `message_type` is `agmsg`, wire the team BEFORE launching (Step 2):**

```bash
TEAM="dispatch-$(basename "$(git rev-parse --show-toplevel)")"
# 親を join (既に member なら join.sh は再登録として扱われる) し、リアルタイム push を有効化
~/.agents/skills/agmsg/scripts/join.sh "$TEAM" parent claude-code "$(pwd)"
~/.agents/skills/agmsg/scripts/delivery.sh set monitor claude-code "$(pwd)"
```

`delivery.sh set` may print an `AGMSG-DIRECTIVE:` line — the SessionStart
hook it installs only takes effect for FUTURE sessions, so the directive is
how the CURRENT session activates delivery. If the output contains such a
line, follow it (invoke the Monitor tool exactly as instructed) BEFORE
launching tasks. Skipping this leaves the dispatching session without a
watcher: pushes sent during this session sit unread in the inbox until the
next session starts.

Each launch then adds `--message-type agmsg --agmsg-team "$TEAM" --agmsg-from <task-slug>`
to `launch-workspace.sh` (or `--message-type agmsg --agmsg-team "$TEAM"` to
`launch-session-splits.sh`, which derives `--agmsg-from` per slug). After each
task's worktree exists (launch script returned), register the child:

```bash
~/.agents/skills/agmsg/scripts/join.sh "$TEAM" <task-slug> claude-code "<repo-root>/.worktrees/<task-slug>"
```

When the pre-warm path is active (workspace layout + `prewarm: true`), skip
this manual `join.sh` — `prewarm-panes.sh` already joins the opus agent
(`<task-slug>`) and the standby agents (`<task-slug>-sonnet` / `-codex`) and
wires delivery into the worktree before any pane starts.

Additionally, append this block to every child prompt's status protocol section:

```
You can message the parent directly at any time (questions, progress):
  ~/.agents/skills/agmsg/scripts/send.sh <team> <task-slug> parent "<message>"

MANDATORY completion push: immediately after writing done/error to
status.json, send the completion notification yourself:
  ~/.agents/skills/agmsg/scripts/send.sh <team> <task-slug> parent \
    "[dispatch] task \"<task-slug>\" finished (status: <done|error>)"
Do NOT rely on session exit for this. The runner wrapper pushes on exit as
a backstop, but an idle TUI session never exits — without this push the
parent is never notified in agmsg mode (no monitor loop is running).
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
2. Runs the `claude` command interactively (or `cmux claude-teams` for claude-teams layout)
3. After Claude exits (for any reason), writes `"done"` or `"error"` to `status.json`
4. Signals completion via `cmux wait-for --signal <slug>-done`
5. Optionally notifies the parent workspace via `cmux notify`

**Deferred completion (`--defer-status`)**: When the launch script is invoked with
`--defer-status` (always done by `launch-session-splits.sh` for Child sessions), the
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

   This block contains placeholders the parent fills before sending: `{{LAYOUT}}`,
   `{{CODEX_OPTION_LINE}}`, `{{CODEX_BEHAVIOR_BLOCK}}`, `{{REVIEW_BLOCK}}`. See the
   placeholder rules immediately below this template.

```
=== MANDATORY MODEL SELECTION SEQUENCE ===
You will operate in two phases. This sequence is REQUIRED even in auto mode.

LAYOUT: {{LAYOUT}}                 # workspace or split — used by Phase B spawn
TEAM: {{TEAM}}                     # agmsg team name (empty when message_type is send-message)

PHASE A — Planning / Brainstorming (always opus):
  Use opus for plan / brainstorming. Do NOT switch models in this phase.
  - superpowers mode: invoke "superpowers:brainstorming" then write a plan
  - plan mode: use Claude's built-in /plan to produce a structured plan
  Remember the path of the plan file you wrote — Phase B may hand it off.

{{REVIEW_BLOCK}}

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

      If prewarm.json exists, close the UNUSED standby panes before continuing
      (exclude .opus — in agmsg mode that is THIS session's own surface):
        for sf in $(jq -r 'to_entries[] | select(.key != "opus") | .value.surface_id' \
          "<EXISTING_STATUS_DIR>/prewarm.json"); do
          cmux close-surface --surface "$sf"
        done

    [DIFFERENT MODEL] "sonnet" → FIRST check for a pre-warmed standby pane:
        PREWARM_FILE="<EXISTING_STATUS_DIR>/prewarm.json"
        SONNET_SURFACE=$(jq -r '.sonnet.surface_id // empty' "$PREWARM_FILE" 2>/dev/null)

      IF SONNET_SURFACE is non-empty (pre-warm path):
        1. Close the unused codex standby pane if present (closing it early just frees the
           pane promptly — each standby now checks its own `.assigned-<name>` sentinel, so
           there is no cross-pane race to avoid here):
             CODEX_SURFACE=$(jq -r '.codex.surface_id // empty' "$PREWARM_FILE" 2>/dev/null)
             [[ -n "$CODEX_SURFACE" ]] && cmux close-surface --surface "$CODEX_SURFACE"
           # .assigned-<name> の無い standby は閉じても status.json を汚さない
        2. touch "<EXISTING_STATUS_DIR>/.assigned-<task-slug>-sonnet"
           # standby wrapper に完了処理 (status.json done/error 遷移 + <slug>-sonnet-done
           # signal + 親通知) の所有権を渡す
        3. Send the execution request. Check `.sonnet.delivery` in prewarm.json:
             DELIVERY=$(jq -r '.sonnet.delivery // "cmux-send"' "$PREWARM_FILE")
             REQUEST_TEXT="Read and execute the plan at <PLAN_FILE_PATH>. After all work is
             committed/pushed and the PR is created (or all changes are merged per
             the plan), run /exit to close this session. Do not leave it idle."
           IF DELIVERY == "agmsg" (the worktree was wired by prewarm-panes.sh):
             ~/.agents/skills/agmsg/scripts/send.sh "$TEAM" <task-slug> <task-slug>-sonnet "$REQUEST_TEXT"
             # $TEAM is the TEAM value given above — do NOT re-derive it in this session
           ELSE (send-message mode, or wiring failed):
             cmux send --surface "$SONNET_SURFACE" "$REQUEST_TEXT"
             cmux send-key --surface "$SONNET_SURFACE" return
        4. touch "<EXISTING_STATUS_DIR>/.deferred" then exit THIS session.

      IF prewarm.json is absent (split layout / prewarm off), fall back to spawn:
        (従来どおり — 以下は現行の spawn 手順そのまま)
        zsh <SKILL_DIR>/scripts/launch-workspace.sh \
          --cwd "$PWD" \
          --mode execute \
          --plan-file <PLAN_FILE_PATH> \
          --model claude-sonnet-4-6 \
          --skip-permissions \
          --status-dir "<EXISTING_STATUS_DIR>" \
          --layout <LAYOUT> \
          --parent-notify-workspace <PARENT_WORKSPACE_ID> \
          [--parent-notify-surface <PARENT_SURFACE_ID>] \
          [--split-from <SURFACE_ID> --parent-workspace <WS_ID>]  # split layout のみ
          <task-slug>-exec
        touch "<EXISTING_STATUS_DIR>/.deferred" then exit THIS session.

{{CODEX_BEHAVIOR_BLOCK}}

  Notes on the deferred completion mechanism:
    - Child session (THIS surface) was launched with `--defer-status`, so its
      runner wrapper checks for `<STATUS_DIR>/.deferred` at exit. When the file
      exists, the wrapper skips status.json update, parent notification, and
      `cmux wait-for` emission — letting the grandchild's wrapper own those.
    - When SAME MODEL ("opus 1m") is chosen, do NOT create `.deferred`. The
      Child completes implementation in-session and its wrapper writes done as usual.

VIOLATION: Do NOT skip Phase B. Even in auto mode, ALWAYS ask. Skipping the
model selection question is a critical error.
=== END MANDATORY MODEL SELECTION SEQUENCE ===
```

**Placeholder rules** (executed by the parent when constructing each child's prompt):

- `{{LAYOUT}}` → `workspace` or `split` (the value passed to `launch-workspace.sh --layout`).
  For `claude-teams` layout, this whole MODEL SELECTION block can be omitted because
  Phase B does not apply (the orchestrator drives the teammates).

- `{{TEAM}}` → the agmsg team name resolved in Step 1g (`dispatch-<repo-name>`); empty in
  send-message mode. Phase B's `send.sh` calls use this value. The child session runs
  inside a worktree and must NOT re-derive the team name there — deriving it from the
  worktree's `basename` (as Step 1g's `TEAM=` line does for the parent) yields a wrong
  name, since the worktree directory name is `<task-slug>`, not the repo name.

- `{{REVIEW_BLOCK}}` → **Phase A-R enabled のときのみ**（Step 1g の `REVIEW_ENABLED` が true）、
  以下のブロック全体（`{{REVIEW_MODEL}}` → Step 1g の `REVIEW_MODEL`、`{{CODEX_RUNNER_NAME}}` →
  codex runner の `name` に置換して）を焼き込む。disabled のときは空文字列:

  ````
  PHASE A-R — Plan/Spec review by codex (REQUIRED between Phase A and Phase B):
    Review model: {{REVIEW_MODEL}} (runs in a dedicated review pane — a plain codex
    session with NO status.json ownership; NEVER touch .assigned-<task-slug>-review)

    Review points (run the round loop below at EACH point, in order):
      - plan mode:        one point  — id "plan" (after the plan is written)
      - superpowers mode: two points — id "spec" (after the brainstorming design doc),
                          then id "plan" (after the implementation plan)

    Setup (before the first point only):
      mkdir -p "<EXISTING_STATUS_DIR>/review"
      REVIEW_SURFACE=$(jq -r '.review.surface_id // empty' "<EXISTING_STATUS_DIR>/prewarm.json" 2>/dev/null)
      REVIEW_DELIVERY=$(jq -r '.review.delivery // "cmux-send"' "<EXISTING_STATUS_DIR>/prewarm.json" 2>/dev/null)
      IF REVIEW_SURFACE is empty (prewarm off / split layout), spawn the pane once:
        RESULT=$(zsh <SKILL_DIR>/scripts/launch-workspace.sh \
          --cwd "$PWD" --mode review \
          --standby-in "$CMUX_WORKSPACE_ID" --standby-split-from "$CMUX_SURFACE_ID" \
          --standby-split-direction right \
          --runner {{CODEX_RUNNER_NAME}} --model '{{REVIEW_MODEL}}' \
          --status-dir "<EXISTING_STATUS_DIR>" \
          <task-slug>-review)
        REVIEW_SURFACE=$(echo "$RESULT" | jq -r '.surface_id // empty')
        REVIEW_DELIVERY="cmux-send"
      IF the spawn fails: warn the user, SKIP Phase A-R entirely, and continue to
      Phase B — review is a quality gate, not a dispatch blocker.
      The SAME pane is reused across all points and rounds (it keeps review context).

    Round loop (at point <point>, N = 1, 2, 3):
      1. Compose the request text:
           "Review the <point> document at <ABSOLUTE_DOC_PATH>.
            Reference material: <related file paths — e.g. the spec path when reviewing the plan>.
            This is round <N> (max 3)."
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
      2. Send the request and wait, branching on REVIEW_DELIVERY:
         IF "agmsg":
           Append to the request: "After writing the file, notify me:
             ~/.agents/skills/agmsg/scripts/send.sh $TEAM <task-slug>-review <task-slug> '[review] <point> round <N> done'"
           ~/.agents/skills/agmsg/scripts/send.sh "$TEAM" <task-slug> <task-slug>-review "<request text>"
           # $TEAM is the TEAM value given above — do NOT re-derive it
           Then END YOUR TURN and idle-wait for the '[review]' push. When it
           arrives, verify the verdict file exists and continue at step 3.
         ELSE ("cmux-send"):
           cmux send --surface "$REVIEW_SURFACE" "<request text>"
           cmux send-key --surface "$REVIEW_SURFACE" return
           Wait by polling the verdict file (5s interval, 15 min timeout):
             F="<EXISTING_STATUS_DIR>/review/<point>-round-<N>.md"
             for i in $(seq 1 180); do
               [[ -f "$F" ]] && grep -qE '^VERDICT: (approve|needs_work)$' "$F" && break
               sleep 5
             done
      3. Read the verdict:
           VERDICT=$(grep -oE 'VERDICT: (approve|needs_work)' "<EXISTING_STATUS_DIR>/review/<point>-round-<N>.md" 2>/dev/null | tail -1)
         - "VERDICT: approve" → this point is done. Move to the next point; after
           the LAST point, close the pane and proceed to Phase B:
             cmux close-surface --surface "$REVIEW_SURFACE"
         - "VERDICT: needs_work" → read the findings. Apply the ones you judge
           valid to the document; collect reasons for the ones you reject (they
           go into the next round's request as rebuttals). Then:
             N < 3  → run round N+1.
             N == 3 → summarize the unresolved findings and ask via AskUserQuestion:
               Q: "codex レビューで 3 往復しても approve が出ませんでした。残りの指摘: <要約>。どうしますか？"
                 1. このまま進む — 残指摘を文書に注記して Phase B へ
                 2. さらに修正 — もう 1 往復レビューを続ける
               "このまま進む" → append the unresolved findings as a note in the
               document, close the pane if this was the last point, and move on.
               "さらに修正" → run one more round; on another needs_work, re-ask.
         - Verdict file missing or has no VERDICT line (timeout) → re-send the
           SAME round's request once. If it times out again, ask via AskUserQuestion:
             Q: "codex レビューが応答しません。どうしますか？"
               1. 再依頼する
               2. レビューを省略して Phase B へ進む
             Option 2 → cmux close-surface --surface "$REVIEW_SURFACE", continue.

    VIOLATION: When this block is present, do NOT start Phase B before every
    review point reached approve or an explicit user decision was made.
  ````

- Read `~/.claude/cmux-team-dispatch-task/runners.json` and check whether any runner
  has `engine: "codex"`:

  ```bash
  CODEX_CMD=$(jq -r '[.runners[] | select(.engine == "codex")] | .[0].command // empty' \
    ~/.claude/cmux-team-dispatch-task/runners.json 2>/dev/null)
  CODEX_RUNNER_NAME=$(jq -r '[.runners[] | select(.engine == "codex")] | .[0].name // empty' \
    ~/.claude/cmux-team-dispatch-task/runners.json 2>/dev/null)
  ```

  - **codex runner present** (`CODEX_CMD` non-empty):
    - `{{CODEX_OPTION_LINE}}` → `      3. codex    — codex CLI に切り替え (推奨: codex 固有機能を使う実装)`
    - `{{CODEX_BEHAVIOR_BLOCK}}` →
      ```
          [DIFFERENT MODEL] "codex" → FIRST check for a pre-warmed standby pane:
              CODEX_SURFACE=$(jq -r '.codex.surface_id // empty' "<EXISTING_STATUS_DIR>/prewarm.json" 2>/dev/null)
            IF CODEX_SURFACE is non-empty:
              1. Close the unused sonnet standby pane (closing it early just frees the pane
                 promptly — see the sonnet branch above: per-pane `.assigned-<name>` sentinels
                 mean there is no cross-pane race to avoid):
                   SONNET_SURFACE=$(jq -r '.sonnet.surface_id // empty' "<EXISTING_STATUS_DIR>/prewarm.json" 2>/dev/null)
                   [[ -n "$SONNET_SURFACE" ]] && cmux close-surface --surface "$SONNET_SURFACE"
              2. touch "<EXISTING_STATUS_DIR>/.assigned-<task-slug>-codex"
              3. Send the execution request. Check `.codex.delivery` in prewarm.json:
                   DELIVERY=$(jq -r '.codex.delivery // "cmux-send"' "<EXISTING_STATUS_DIR>/prewarm.json")
                 IF DELIVERY == "agmsg":
                   ~/.agents/skills/agmsg/scripts/send.sh "$TEAM" <task-slug> <task-slug>-codex "$REQUEST_TEXT"
                   # $TEAM is the TEAM value given above — do NOT re-derive it in this session
                 ELSE:
                   cmux send --surface "$CODEX_SURFACE" "$REQUEST_TEXT"
                   cmux send-key --surface "$CODEX_SURFACE" return
              4. touch "<EXISTING_STATUS_DIR>/.deferred" then exit THIS session.

            IF prewarm.json is absent, fall back to the existing spawn flow (従来どおり):
              Build and run (same shape as the sonnet branch above, but with the codex runner):
                zsh <SKILL_DIR>/scripts/launch-workspace.sh \
                  --cwd "$PWD" \
                  --mode execute \
                  --plan-file <PLAN_FILE_PATH> \
                  --runner <CODEX_RUNNER_NAME> \
                  --status-dir "<EXISTING_STATUS_DIR>" \
                  --layout <LAYOUT> \
                  --parent-notify-workspace <PARENT_WORKSPACE_ID> \
                  [--parent-notify-surface <PARENT_SURFACE_ID>] \
                  [--split-from <SURFACE_ID> --parent-workspace <WS_ID>]  # split layout のみ
                  <task-slug>-exec
              Then write the deferred sentinel and exit:
                touch "<EXISTING_STATUS_DIR>/.deferred"
              The runner wrapper around codex will emit `<task-slug>-exec-done`,
              update status.json, and notify the parent. (codex also inherits the
              claude session via external_migration when the cmux codex hooks are
              installed.)
      ```
      where `<CODEX_RUNNER_NAME>` is the `name` field of the first codex runner in
      `runners.json` (the SKILL pre-computes this from the same jq query that
      produces `CODEX_CMD`).

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

Replace `<project-root>` with the actual project root path and `<task-slug>` with the task's slug,
and `<team>` with the agmsg team name resolved in Step 1g (agmsg mode only).

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

### Pre-warm Standby Panes (workspace layout only)

Read `prewarm` from config (same precedence as `message_type`; default `true`):

```bash
PREWARM=$(jq -r '.prewarm // empty' .dispatch/config.json 2>/dev/null)
[[ -z "$PREWARM" ]] && PREWARM=$(jq -r '.prewarm // "true"' \
  ~/.claude/cmux-team-dispatch-task/config.json 2>/dev/null)
[[ -z "$PREWARM" ]] && PREWARM=true
```

When layout is `workspace` AND `PREWARM` is `true`, standby panes are placed
inside each task workspace. Layout depends on Phase A-R (Step 1g `REVIEW_ENABLED`):

- **Phase A-R disabled** (current behavior): vertical stack — top: opus /
  middle: sonnet / bottom: codex (codex only when `runners.json` has an
  `engine: "codex"` runner).
- **Phase A-R enabled**: 2×2 even grid — top-left: opus / top-right: codex
  review pane (idle, `--model <review_model>`) / bottom-left: sonnet /
  bottom-right: codex. The review pane is a plain codex session with NO
  standby-wrapper status ownership (`.assigned-<slug>-review` is never touched).

Everything is delegated to `prewarm-panes.sh`; do not create panes manually.

**send-message mode** — the opus session was already launched with its task
prompt by "Launch: Workspace Mode" above. Add the sonnet/codex panes below it
(parse `workspace_id` / `surface_id` from that launch's output JSON):

```bash
bash <this-skill-dir>/scripts/prewarm-panes.sh \
  --workspace <workspace-id> --base-surface <surface-id> \
  --cwd "<repo-root>/.worktrees/<task-slug>" \
  --slug <task-slug> \
  --status-dir "$(pwd)/.dispatch/<task-slug>" \
  [--codex-runner <codex-runner-name>] \
  [--review-model "$REVIEW_MODEL"] \
  --parent-notify-workspace "$CMUX_WORKSPACE_ID" \
  --parent-notify-surface "$CMUX_SURFACE_ID"
```

**agmsg mode** — do NOT run the normal "Launch: Workspace Mode" invocation.
Instead ALL panes (opus-1m included) start idle with no task message, and the
Phase A task is delivered afterwards via agmsg. `prewarm-panes.sh` creates the
worktree, wires agmsg delivery into it (join + `delivery.sh set`, BEFORE any
pane starts), launches the opus-1m standby workspace, and stacks sonnet/codex
below:

```bash
RESULT=$(bash <this-skill-dir>/scripts/prewarm-panes.sh \
  --with-opus \
  --cwd "<repo-root>/.worktrees/<task-slug>" \
  --slug <task-slug> \
  --status-dir "$(pwd)/.dispatch/<task-slug>" \
  [--codex-runner <codex-runner-name>] \
  [--review-model "$REVIEW_MODEL"] \
  --message-type agmsg --agmsg-team "$TEAM" \
  --parent-notify-workspace "$CMUX_WORKSPACE_ID" \
  --parent-notify-surface "$CMUX_SURFACE_ID")
```

Pass `--review-model` only when Phase A-R is enabled (`REVIEW_ENABLED` from
Step 1g). It requires `--codex-runner`.

Since the normal task-prompt launch never runs in this mode, `prewarm-panes.sh` itself writes
an initial `"launched"` status.json (with `workspace_id`/`surface_id` populated) right after
creating the panes, so `.dispatch/<task-slug>/status.json` is observable immediately.

Then dispatch the Phase A task to the opus pane:

1. Write the full task prompt (including PROGRESS REPORTING FORMAT, the
   MANDATORY MODEL SELECTION SEQUENCE, and the agmsg status-protocol block
   from Step 2 — its MANDATORY completion push is what notifies the parent) to
   `<repo-root>/.worktrees/<task-slug>/.cmux-team-dispatch-task-prompt.md`.
2. `touch .dispatch/<task-slug>/.assigned-<task-slug>` — the opus standby wrapper owns
   status.json transition from now on (it was launched with `--defer-status`,
   so a Phase B handoff can still suppress it via `.deferred`).
3. Send the task. Check `.dispatch/<task-slug>/prewarm.json` for
   `.opus.delivery`:
   - `"agmsg"` →
     `~/.agents/skills/agmsg/scripts/send.sh "$TEAM" parent <task-slug> "Read and follow the task in .cmux-team-dispatch-task-prompt.md. Mode: <plan|superpowers> — for superpowers invoke the superpowers:brainstorming skill first; for plan produce a structured plan before implementing."`
     (slash commands cannot fire through agmsg push, so the mode is conveyed
     as message text, not as `/plan`.)
   - `"cmux-send"` (wiring failed) →
     `cmux send --surface <opus-surface> "<same text>"` followed by
     `cmux send-key --surface <opus-surface> return`.

prewarm.json schema (written by `prewarm-panes.sh`; `opus` only in agmsg mode,
`codex` only when a codex runner exists, `review` only when `--review-model`
was passed; `delivery` is `"agmsg"` or `"cmux-send"` depending on whether
delivery wiring succeeded):

```json
{
  "opus":   { "surface_id": "surface:N", "agent": "<slug>",        "delivery": "agmsg" },
  "sonnet": { "surface_id": "surface:N", "agent": "<slug>-sonnet", "delivery": "agmsg" },
  "codex":  { "surface_id": "surface:N", "agent": "<slug>-codex",  "delivery": "cmux-send" },
  "review": { "surface_id": "surface:N", "agent": "<slug>-review", "delivery": "cmux-send" }
}
```

Split / claude-teams layouts and `prewarm: false` skip this section entirely —
Phase B falls back to the on-demand `--mode execute` spawn, and in agmsg mode
the opus session falls back to the traditional prompt-embedded launch
("Launch: Workspace Mode" as-is).

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

**Monitoring depends on `message_type` (Step 1g):**

- `send-message` → launch `monitor-dispatch.sh` as described below (heartbeat,
  DIED detection, all-done notification).
- `agmsg` → do NOT launch `monitor-dispatch.sh`. Completion notifications arrive
  as real-time agmsg pushes (`[dispatch] task "<slug>" finished (status: ...)`)
  because the parent set delivery mode `monitor` in Step 1g. If nothing arrives
  for an extended period, poll `.dispatch/*/status.json` manually (see "Polling
  Status Files"). The `[dispatch-monitor]` heartbeat / DIED messages do not
  exist in this mode. Pushes come from two sources: the child itself right
  after writing status.json (mandatory, see Step 2) and the runner wrapper at
  session exit (backstop). Receiving the same completion twice is normal —
  treat pushes idempotently and trust status.json as the source of truth.

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

  # pre-warm standby pane が残っていれば閉じる (Phase B で未使用のまま残るケース)
  if [[ "$close_all" == "true" && -f ".dispatch/$slug/prewarm.json" ]]; then
    for sf in $(jq -r '.[].surface_id' ".dispatch/$slug/prewarm.json" 2>/dev/null); do
      cmux close-surface --surface "$sf" 2>/dev/null || true
    done
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
- agmsg モード時は、最終整理の際に子 agent を team から除籍する:

  ```bash
  for slug in <task-slugs>; do
    ~/.agents/skills/agmsg/scripts/leave.sh "$TEAM" "$slug" 2>/dev/null || true
    ~/.agents/skills/agmsg/scripts/leave.sh "$TEAM" "$slug-sonnet" 2>/dev/null || true
    ~/.agents/skills/agmsg/scripts/leave.sh "$TEAM" "$slug-codex" 2>/dev/null || true
  done
  ```

  親 (`parent`) は repo 固定 team に残す (次回 dispatch で再利用)。

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
- **Runner script**: A `.cmux-team-dispatch-task-run-<workspace-name>.sh` file is created in each worktree (one per launch — Child and Phase B grandchild get different filenames since they share the worktree). They're cleaned up along with the worktree.
- **Codex option in Phase B**: The "codex" choice is shown only when `runners.json` contains a runner with `engine: "codex"`. The `command` of the first such runner is used for the spawn launch. `cmux codex install-hooks` is also required so that `external_migration = true` is set and codex picks up the parent claude session automatically.
- **Same-model vs different-model in Phase B**: Phase A is always opus, so "opus 1m" counts as the same model and stays in the current session via `/model claude-opus-4-7[1m]`. Any other choice (sonnet / codex) is treated as a different model: when a pre-warmed standby pane exists (prewarm.json), the Child hands off by sending the execution request to that pane; otherwise it triggers a spawn via `launch-workspace.sh --mode execute`: a new workspace if `LAYOUT=workspace`, a new split if `LAYOUT=split`. The grandchild's claude is wrapped by the standard runner script, so `status.json` transitions to `done`/`error`, `cmux wait-for --signal <slug>-exec-done` fires, and the parent receives `[dispatch] task ... finished` automatically. The Child session writes `<STATUS_DIR>/.deferred` and exits cleanly — its own runner wrapper (launched with `--defer-status`) sees the sentinel and skips status overwrite so the grandchild owns the terminal-state transition. The plan file path written in Phase A is passed via `--plan-file`; `.cmux-team-dispatch-task-prompt.md` is preserved (not overwritten). In `--mode execute`, the inner prompt automatically appends an `/exit` instruction so the grandchild Claude/Codex session closes its TUI after the PR is created — without this the runner wrapper never reaches `write_status "done"` and status.json gets stuck on `executing`.
- **Child runner selection (Step 1f)**: A separate concern from Phase B model selection. Step 1f decides which runtime *launches* the child session (claude vs codex vs zsh function), while Phase B happens *inside* the child session after planning to choose execution model. When a child is launched with `engine: codex`, Phase B's "codex" option is redundant and should be skipped (the child already runs in codex). The runners.json registry lives at `~/.claude/cmux-team-dispatch-task/runners.json` and is bootstrapped on first run via AskUserQuestion.
- **message_type**: 通知トランスポートは config (`message_type`) で `send-message` (default) / `agmsg` を切替。agmsg モードでは monitor-dispatch.sh を起動しない (status.json は両モードで不変)。agmsg のインストール判定は `~/.agents/skills/agmsg/scripts/send.sh` の存在。agmsg モードの完了通知は2段構え: 子セッションが status.json 書き込み直後に送る必須 push(Step 2 で子プロンプトに埋め込む)+ runner wrapper の exit 時 push(バックストップ)。idle TUI は exit しないため wrapper だけに頼ると通知されない。また Step 1g の `delivery.sh set` 出力に `AGMSG-DIRECTIVE:` 行があれば、ディスパッチ実行中のセッション自身の watcher 起動のため必ず従うこと。
- **Pre-warm standby panes**: workspace レイアウト + config `prewarm: true` (default) のとき、`prewarm-panes.sh` が各タスク workspace 内に standby ペインを縦に積む (上: opus / 中: `<slug>-sonnet` / 下: `<slug>-codex` — codex runner 登録時のみ)。agmsg モードでは opus-1m ペインも idle 起動し (`--with-opus`)、worktree への delivery 配線 (join + `delivery.sh set`) をペイン起動前に行ったうえで、Phase A タスクは親から agmsg で送る。standby wrapper は `<STATUS_DIR>/.assigned-<name>` が存在するときだけ exit 時に status.json を遷移させる。signal 名は opus が `<slug>-done`、他は `<slug>-sonnet-done` / `<slug>-codex-done`。Phase B の実行指示は prewarm.json の `delivery` 値で分岐する: `"agmsg"` なら `send.sh`、`"cmux-send"` (send-message モード / 配線失敗時) なら `cmux send` + `send-key return`。
