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
argument-hint: "<task1>, <task2>, ... [--layout split|claude-teams] [--no-grid] [--loop]"
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

## Loop Mode (GitHub issue 自動ループ)

`--loop` または issue を尽きるまで自動処理する明示要求でのみ発動する。発動時は [`references/loop-mode.md`](references/loop-mode.md) に従う。通常 dispatch の前と cleanup 前には `scripts/issue-fetch.sh --state-file .dispatch-loop/loop-state.json lock-check` を実行し、`.dispatch-loop/loop.lock.d` が live なら開始・一括 cleanup を行わない。

ループ用のプロンプトは `scripts/render-loop-prompt.sh` が `references/unattended/` の確定文面から生成する。手で組み立てない。

## Step 1: Parse and Prepare

This single step handles task collection, agent routing, layout selection, integration
strategy, and runtime selection. Up to six user interactions before dispatch:
brainstorming selection (1c), layout mode selection (1d), integration strategy
selection (1e), child runner selection (1f), message transport selection
(1g, first time only), and Phase A-R review opt-in (1g — every dispatch while
`review_mode` is unset or `"ask"` and a `review_model` runner exists).

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
2. **Resolve `design_runner`** from `<project>/.dispatch/config.json`, falling back to
   `~/.claude/cmux-team-dispatch-task/config.json`:

   ```bash
   # 各レイヤーを個別に検証する — project の不正値が global に保存済みの「常に〜」を
   # 遮蔽しないよう、不正値は警告してそのレイヤーだけ未設定として扱い次へフォールバック。
   # 有効値 = runners[].name のいずれか、または "ask"（"ask" は有効値としてフォールバック停止）
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
   - `"ask"` (explicit) → use the interactive flow below in its **ask form**（今回のみの
     2 択。「常に〜」から `"ask"` に戻したユーザーへ永続化オプションを再提示しない）.
   - Empty（両レイヤーとも未設定、または設定されていたレイヤーがすべて不正値だった）→
     use the interactive flow below in its **unset form**（永続化オプション付き —
     不正値のときも有効な値を選び直してそのまま保存できる）.
3. **Interactive flow**:
   - If exactly **1** runner is registered → silently assign that runner to all tasks
     and skip the switch question (どちらの form でも質問・永続化なし). Continue to Step 1g.
   - If **2 or more** runners are registered → ask the user via AskUserQuestion:
     > 子セッションごとにランタイム/モデルを切り替えますか？ (default: いいえ, 全タスクに既定 runner を適用)
     Options — **ask form** は 1–2 のみ、**unset form** は 1–4:
       1. いいえ (今回のみ) → assign the `default` runner from `runners.json` to all
          tasks。config には書かない
       2. はい (今回のみ)   → for each task, ask which runner to use via AskUserQuestion.
          The options are the entries in `runners[]` (label = `name`, description =
          `command (engine)`)。config には書かない
       3. 常に既定 runner (<default>) を使う → assign the default runner to all tasks
          AND persist `design_runner: "<default>"` to the global config
       4. 常に固定 runner を選ぶ → ask once more which runner to fix (options =
          `runners[]`, label = `name`, description = `command (engine)`), assign it to
          all tasks AND persist `design_runner: "<name>"` to the global config
     Persistence (options 3/4 only) uses the same jq merge pattern as `message_type`
     in Step 1g below (key: `design_runner` — writer 固有の mktemp + jq 成功時のみ mv)。「常に〜」を選んだ後の
     戻し方は 2 通りで意味が異なる: `design_runner` を `"ask"` に書き換えると今回のみの
     2 択（永続化オプションなし）、キーを削除すると未設定に戻り 4 択が再表示される。
4. Each task receives a `runner` field (the chosen `name` string), which Step 2 passes
   through `launch-session-splits.sh` and on to `launch-workspace.sh --runner <name>`.
5. **Cross-engine reviewer** — `engine: codex` の runner が設計に割り当てられたタスクが
   1 つでもある場合、claude 側レビュアー runner を決める（design=codex のレビューは
   claude が担うため）:
   - claude engine の runner が 0 件 → 警告し、codex 設計タスクの Phase A-R / B-R は無効
   - 1 件 → その runner を黙って採用
   - 2 件以上 → AskUserQuestion で毎 dispatch 選択:
     > codex 設計タスクのレビュアー (claude 側) に使う runner を選んでください
     options = claude engine runners (label = `name`, description = `command` + 設定済み `review_model`)
   選ばれた runner 名を `REVIEWER_RUNNER` とし、その `review_model`（未設定なら
   `opus[1m]`）を `CLAUDE_REVIEW_MODEL` として Step 1g / Step 2 に渡す。

**runners.json schema (minimal):**

```json
{
  "default": "claude",
  "runners": [
    { "name": "claude",  "command": "claude",  "engine": "claude", "review_model": "opus[1m]" },
    { "name": "ccenec",  "command": "ccenec",  "engine": "claude" },
    { "name": "codex",   "command": "codex",   "engine": "codex",  "review_model": "gpt-5.6-sol", "exec_model": "gpt-5.6-terra",
      "plan_effort": "xhigh", "review_effort": "xhigh", "exec_effort": "high" }
  ]
}
```

Field meanings:

- `name`: unique identifier shown in AskUserQuestion options
- `command`: the executable / zsh function to invoke
- `engine`: `claude` or `codex` — controls flag composition (see table below)
- `review_model` (optional):
  - `engine: codex` の runner: design=claude のタスクで Phase A-R/B-R のレビューペイン
    (codex) に渡すモデル名。未設定ならそのタスクのレビューは無効
  - `engine: claude` の runner: design=codex のタスクでレビュアー runner に選ばれたとき、
    claude レビューペインに渡すモデル名。未設定時は `opus[1m]` にフォールバック
- `exec_model` (optional, `engine: codex` の runner のみ): Phase B の実行系
  (execute / standby) で `--model` 未指定時に `launch-workspace.sh` がフォールバック適用する
  モデル名。review ペインには適用されない。未設定なら codex 側デフォルト (config.toml)
- `plan_effort` / `review_effort` / `exec_effort` (optional, `engine: codex` の runner のみ,
  値: `minimal`|`low`|`medium`|`high`|`xhigh`): codex セッションの reasoning effort。
  それぞれ Phase A 設計 (plan / superpowers) / レビューペイン (review) / 実行系
  (execute / standby) に `-c model_reasoning_effort='<値>'` として注入される。
  未設定なら `-c` フラグを付けず `~/.codex/config.toml` の既定に任せる

**engine × MODE invocation table** (executed by `launch-workspace.sh`):

| engine | MODE        | Composed command                                                                                          |
|--------|-------------|-----------------------------------------------------------------------------------------------------------|
| claude | plan        | `<command> --dangerously-skip-permissions '/plan Read and follow the task in .cmux-team-dispatch-task-prompt.md'` |
| claude | superpowers | `<command> 'Read and follow the task in .cmux-team-dispatch-task-prompt.md'`                              |
| claude | execute     | `<command> [--model <X>] [--dangerously-skip-permissions] 'Read and execute the plan at <plan-file>'`     |
| codex  | plan        | `<command> [-c model_reasoning_effort='<plan_effort>'] --dangerously-bypass-approvals-and-sandbox '/plan Read and follow the task in .cmux-team-dispatch-task-prompt.md'` |
| codex  | superpowers | `<command> [-c model_reasoning_effort='<plan_effort>'] --dangerously-bypass-approvals-and-sandbox '$superpowers:brainstorming Read and follow the task in .cmux-team-dispatch-task-prompt.md'`   |
| codex  | execute     | `<command> [-c model_reasoning_effort='<exec_effort>'] [--model <exec_model>] --dangerously-bypass-approvals-and-sandbox 'Read and execute the plan at <plan-file>'` |
| codex  | review      | `<command> [-c model_reasoning_effort='<review_effort>'] --model <review_model> --sandbox workspace-write -c approval_policy='never' --add-dir <STATUS_DIR>` |

`execute` モードは Phase B (実装フェーズ) で別 surface に実装を移譲するときに使う。
`--plan-file <path>` で計画ファイルパスを指定し、`.cmux-team-dispatch-task-prompt.md`
は書き換えない (Phase A のものを温存)。claude engine では `--model` と
`--skip-permissions` を追加可能 (sonnet など auto mode が効かないモデル用)。
codex engine では `--model` 未指定時に runner の `exec_model` がフォールバック適用される
(execute / standby のみ。review は常に `review_model` を明示)。

codex engine の reasoning effort は明示 `--effort` > runner フィールド (plan_effort:
plan/superpowers, review_effort: review, exec_effort: execute/standby) > 無指定
(config.toml 既定) の優先で解決され、`-c model_reasoning_effort='<値>'` として
`<command>` 直後に注入される。prewarm の設計 codex ペインは `--mode standby` で
起動されるため、`prewarm-panes.sh` が `--effort <plan_effort>` を明示して渡す。

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
   - **review_model** (free text) — engine が `codex` のとき: Phase A-R/B-R レビュー用モデル
     (例 `gpt-5.6-sol`)。engine が `claude` のとき: design=codex タスクのレビュアーに
     選ばれた場合のモデル (例 `opus[1m]`)。空回答で省略可
   - **exec_model** (free text, engine が `codex` のときのみ質問, 例 `gpt-5.6-terra`) —
     Phase B 実行系 (execute / standby) 用モデル。空回答で省略可 (codex 側デフォルトを使用)
   - **plan_effort / review_effort / exec_effort** (choice: 空 / minimal / low / medium /
     high / xhigh。engine が `codex` のときのみ質問) — 設計 / レビュー / 実行の
     reasoning effort。空回答で省略可 (codex 側 config.toml の既定を使用)

   After each runner is added, ask: 「もう 1 件追加しますか？」 (Yes → loop; No → finish).

4. After at least one runner is registered, also ask which runner is the `default`
   (used when the user picks "No" at the switch question, or implicitly when only
   1 runner exists). If only one runner was added, it becomes `default` automatically.

5. Write the assembled object to `~/.claude/cmux-team-dispatch-task/runners.json`
   (create the directory if missing). Then continue to the runner selection logic above.

The first-run setup does not ask for defaults. To fix the normal questions manually,
add either key to config.json (project config overrides global config):

```json
{
  "design_runner": "claude",
  "exec_choice": "sonnet"
}
```

To restore the interactive flow there are TWO distinct ways: set the key to `"ask"`
(questions only — the persistence options stay hidden), or remove the key entirely
(back to unset — the questions reappear WITH the persistence options).

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
   # writer 固有の一時ファイル — 共有 "$CONFIG.tmp" は並列書き込みで壊れる。
   # jq が成功したときだけ mv（既存 config が不正 JSON だと jq が失敗する — そのまま
   # mv すると config を 0 byte で潰すため、失敗時は tmp を消して警告し永続化を諦める）
   if TMP=$(mktemp "$CONFIG.XXXXXX"); then
     if { [[ -f "$CONFIG" ]] && jq --arg mt "<answer>" '.message_type = $mt' "$CONFIG" > "$TMP"; } \
        || { [[ ! -f "$CONFIG" ]] && jq -n --arg mt "<answer>" '{message_type: $mt}' > "$TMP"; }; then
       mv "$TMP" "$CONFIG"   # 同一ディレクトリ内 mv = atomic replace（ファイル全体の last-write-wins）
     else
       rm -f "$TMP"; echo "[warn] config write failed (existing config broken?); persistence skipped" >&2
     fi
   else
     echo "[warn] mktemp failed; persistence skipped" >&2
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

   If set to `"on"` or `"off"`, use it silently — do NOT ask (permanent opt-in/out).

   If unset or `"ask"`:
   - `REVIEW_MODEL` empty かつ `REVIEWER_RUNNER` 未解決（codex 設計タスクが無い、または
     claude engine runner が無い）→ treat as `off`. Do NOT ask and do NOT write config
     (so the question starts firing once a review_model or a cross-engine reviewer
     gets configured later).
   - `REVIEW_MODEL` non-empty **または** codex 設計タスクが存在し `REVIEWER_RUNNER` が
     解決済み → ask via AskUserQuestion **on EVERY dispatch, BEFORE
     launching any task** (this question is part of Step 1, alongside 1c-1f):
     > レビューモードを使いますか？ (Phase A-R: plan/spec を codex (`<review_model>`) が approve するまでレビュー / Phase B-R: 実装完了後・PR 作成前にコードレビュー)
     Options:
       1. はい (今回のみ)   → `REVIEW_MODE=on`。config には書かない
       2. いいえ (今回のみ) → `REVIEW_MODE=off`。config には書かない
       3. 常に有効         → `REVIEW_MODE=on`。global config に `review_mode: "on"` を永続化
       4. 常に無効         → `REVIEW_MODE=off`。global config に `review_mode: "off"` を永続化
     Persistence (options 3/4 only) uses the same jq merge pattern as `message_type`
     above (key: `review_mode`). 「常に〜」を選んだ後に再び毎回質問へ戻すには、config の
     `review_mode` を `"ask"` に書き換える (または削除する)。

3. Compute the final flag used by prompt construction (Step 2) and pre-warm:

   ```bash
   # REVIEW_ENABLED はタスクの設計 engine ごとに決まる (review_mode の解決は共通):
   #   design=claude のタスク → review_model 付き codex runner が存在 (REVIEW_MODEL 非空)
   #   design=codex のタスク  → claude engine runner が存在 (REVIEWER_RUNNER 非空)
   REVIEW_ENABLED=false                 # design=claude タスク用
   [[ -n "$REVIEW_MODEL" && "$REVIEW_MODE" == "on" ]] && REVIEW_ENABLED=true
   REVIEW_ENABLED_CODEX_DESIGN=false    # design=codex タスク用
   [[ -n "$REVIEWER_RUNNER" && "$REVIEW_MODE" == "on" ]] && REVIEW_ENABLED_CODEX_DESIGN=true
   ```

   (`{{REVIEW_BLOCK}}` の placeholder 埋め込み時にのみ必要な `CODEX_CMD` / `CODEX_RUNNER_NAME` は
   placeholder rules 節と同じ jq クエリで得る — REVIEW_ENABLED の算出には使わない)

**Resolve execution default (`exec_choice`)** — same precedence pattern:

```bash
# 各レイヤーを個別に検証する — project の不正値が global に保存済みの「常に〜」を遮蔽しないように。
# 有効値 = "opus 1m" | "sonnet" | "ask" | "codex" (engine: codex runner 登録時のみ)。
# "ask" は有効値としてフォールバックを停止する。不正値 (runner 未登録の "codex" 含む) は
# 警告してそのレイヤーだけ未設定として次へフォールバック
CODEX_RUNNER_COUNT=$(jq -r '[.runners[] | select(.engine == "codex")] | length' \
  ~/.claude/cmux-team-dispatch-task/runners.json 2>/dev/null)
valid_exec_choice() {
  case "$1" in
    "opus 1m"|sonnet|ask) return 0 ;;
    codex) (( ${CODEX_RUNNER_COUNT:-0} > 0 )) ;;
    *) return 1 ;;
  esac
}
EXEC_CHOICE=$(jq -r '.exec_choice // empty' .dispatch/config.json 2>/dev/null)
if [[ -n "$EXEC_CHOICE" ]] && ! valid_exec_choice "$EXEC_CHOICE"; then
  echo "[warn] exec_choice=\"$EXEC_CHOICE\" (project) invalid (expected: opus 1m | sonnet | codex | ask); ignoring this layer" >&2
  EXEC_CHOICE=""
fi
if [[ -z "$EXEC_CHOICE" ]]; then
  EXEC_CHOICE=$(jq -r '.exec_choice // empty' \
    ~/.claude/cmux-team-dispatch-task/config.json 2>/dev/null)
  if [[ -n "$EXEC_CHOICE" ]] && ! valid_exec_choice "$EXEC_CHOICE"; then
    echo "[warn] exec_choice=\"$EXEC_CHOICE\" (global) invalid (expected: opus 1m | sonnet | codex | ask); ignoring this layer" >&2
    EXEC_CHOICE=""
  fi
fi
```

- Empty（両レイヤーとも未設定、または設定されていたレイヤーがすべて不正値だった）→ embed
  the existing AskUserQuestion Phase B block **plus the persistence follow-up block**
  （`{{EXEC_DEFAULT_HINT}}` の placeholder rules を参照 — 子セッションが選択直後に
  「常に〜」を global config へ永続化できる確認質問）.
- `"ask"` (explicit) → embed the existing AskUserQuestion Phase B block only（永続化
  確認は出さない — 「常に〜」から `"ask"` に戻したユーザーへ再提示しない）.
- `"opus 1m"` / `"sonnet"` / `"codex"`（レイヤー検証を通過した有効値）→ embed its
  default-direct Phase B block.

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
launching tasks. Note the watcher is a record/reply channel, not a wake
mechanism: its stream output is never injected while this session is idle,
which is why every instruction and completion notification in this skill is
ALSO delivered as a typed `cmux send` prompt.

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

MANDATORY completion notification: immediately after writing done/error to
status.json, notify the parent yourself over BOTH channels:
  ~/.agents/skills/agmsg/scripts/send.sh <team> <task-slug> parent \
    "[dispatch] task \"<task-slug>\" finished (status: <done|error>)"
  /Applications/cmux.app/Contents/Resources/bin/cmux send --workspace <PARENT_WORKSPACE_ID> \
    "[dispatch] task \"<task-slug>\" finished (status: <done|error>)"
  /Applications/cmux.app/Contents/Resources/bin/cmux send-key --workspace <PARENT_WORKSPACE_ID> return
The agmsg push is the inbox record only — it CANNOT wake an idle parent
session (a watcher's stream output sits in a background-Bash buffer and is
never injected while the session is idle), so the cmux send + send-key
return pair is REQUIRED. Do NOT rely on session exit either. The runner
wrapper notifies on exit as a backstop, but an idle TUI session never
exits — without this notification the parent is never informed in agmsg
mode (no monitor loop is running).
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
   `{{CODEX_OPTION_LINE}}`, `{{CODEX_BEHAVIOR_BLOCK}}`, `{{REVIEW_BLOCK}}`,
   `{{CODE_REVIEW_BLOCK}}`. See the placeholder rules immediately below this template.

```
=== MANDATORY MODEL SELECTION SEQUENCE ===
You will operate in two phases. This sequence is REQUIRED even in auto mode.

LAYOUT: {{LAYOUT}}                 # workspace or split — used by Phase B spawn
TEAM: {{TEAM}}                     # agmsg team name (empty when message_type is send-message)

PHASE A — Planning / Brainstorming (always opus):
  Use opus for plan / brainstorming. Do NOT switch models in this phase.
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
    Q: "実行フェーズで使用するモデルを選択してください"
    Options:
      1. opus 1m  — 高品質・長コンテキスト (推奨: 大規模・複雑な実装)
      2. sonnet   — 高速・低コスト (推奨: 中規模・パターン化された実装)
{{CODEX_OPTION_LINE}}

  Behavior by selection:

    [SAME MODEL] "opus 1m" → run `/model opus[1m]` and continue execution
      in THIS session. Proceed to implement the plan you wrote in Phase A.

      Leave the pre-warmed standby panes (sonnet / codex / review) OPEN and idle —
      do NOT close them. An unassigned standby holds no `.assigned-<name>` sentinel,
      so it never writes status.json; keeping all four panes open is the intended
      layout. They are torn down together only at the final all-tasks-complete cleanup.

    [DIFFERENT MODEL] "sonnet" → FIRST check for a pre-warmed standby pane:
        PREWARM_FILE="<EXISTING_STATUS_DIR>/prewarm.json"
        SONNET_SURFACE=$(jq -r '.sonnet.surface_id // empty' "$PREWARM_FILE" 2>/dev/null)

      IF SONNET_SURFACE is non-empty (pre-warm path):
        1. Leave the unused standby panes (codex / opus / review) OPEN and idle — do NOT
           close them. An unassigned standby holds no `.assigned-<name>` sentinel, so it
           never writes status.json; keeping all four panes open is the intended layout.
        2. touch "<EXISTING_STATUS_DIR>/.assigned-<task-slug>-sonnet"
           # standby wrapper に完了処理 (status.json done/error 遷移 + <slug>-sonnet-done
           # signal + 親通知) の所有権を渡す
        3. Send the execution request. Delivery is ALWAYS the typed prompt
           (`cmux send`) — an agmsg push alone never wakes an idle claude pane
           (its watcher runs as a background Bash whose stream output is not
           injected until the process exits). When the pane's agmsg wiring is
           alive, ALSO push the same text to its inbox first (record + reply
           channel). Check `.sonnet.delivery` in prewarm.json:
             DELIVERY=$(jq -r '.sonnet.delivery // "cmux-send"' "$PREWARM_FILE")
             # the inbox copy is only useful while the standby's watcher is
             # alive (ready sentinel present) — re-verify right before sending:
             [[ "$DELIVERY" == "agmsg" && ! -f "$HOME/.agents/skills/agmsg/run/ready.${TEAM}__<task-slug>-sonnet" ]] \
               && DELIVERY="cmux-send"
             REQUEST_TEXT="Read and execute the plan at <PLAN_FILE_PATH>. After all work is
             committed/pushed and the PR is created (or all changes are merged per
             the plan), run /exit to close this session. Do not leave it idle."
             # IF the PHASE B-R block exists below, do NOT use this REQUEST_TEXT —
             # use the extended REQUEST_TEXT defined in that block instead (it inserts
             # the pre-PR code-review protocol).
           IF DELIVERY == "agmsg" (the worktree was wired by prewarm-panes.sh):
             ~/.agents/skills/agmsg/scripts/send.sh "$TEAM" <task-slug> <task-slug>-sonnet "$REQUEST_TEXT"
             # $TEAM is the TEAM value given above — do NOT re-derive it in this session
             REQUEST_TEXT="$REQUEST_TEXT (An identical copy of this message is in your agmsg inbox — treat both as ONE task; ignore the duplicate.)"
           ALWAYS (both delivery values):
             cmux send --surface "$SONNET_SURFACE" "$REQUEST_TEXT"
             cmux send-key --surface "$SONNET_SURFACE" return
        4. touch "<EXISTING_STATUS_DIR>/.deferred". IF the PHASE B-R block exists
           below, do NOT exit — switch to the reviewer role it defines. OTHERWISE
           exit THIS session.

      IF prewarm.json is absent (split layout / prewarm off), fall back to spawn:
        (従来どおり — 以下は現行の spawn 手順そのまま)
        zsh <SKILL_DIR>/scripts/launch-workspace.sh \
          --cwd "$PWD" \
          --mode execute \
          --plan-file <PLAN_FILE_PATH> \
          --model sonnet \
          --skip-permissions \
          --status-dir "<EXISTING_STATUS_DIR>" \
          --layout <LAYOUT> \
          --parent-notify-workspace <PARENT_WORKSPACE_ID> \
          [--parent-notify-surface <PARENT_SURFACE_ID>] \
          [--split-from <SURFACE_ID> --parent-workspace <WS_ID>]  # split layout のみ
          [--review-config "<EXISTING_STATUS_DIR>/review/code-review.json"]  # PHASE B-R があるときのみ
          <task-slug>-exec
        IF the PHASE B-R block exists below, BEFORE the launch above write the
        reviewer wiring file (you are the reviewer):
          mkdir -p "<EXISTING_STATUS_DIR>/review"
          jq -n --arg s "$CMUX_SURFACE_ID" --arg w "$CMUX_WORKSPACE_ID" \
            --arg d "<EXISTING_STATUS_DIR>/review" \
            '{reviewer_surface: $s, reviewer_workspace: $w, review_dir: $d}' \
            > "<EXISTING_STATUS_DIR>/review/code-review.json"
        touch "<EXISTING_STATUS_DIR>/.deferred". IF the PHASE B-R block exists below,
        do NOT exit — switch to the reviewer role it defines. OTHERWISE exit THIS session.

{{CODEX_BEHAVIOR_BLOCK}}

{{CODE_REVIEW_BLOCK}}

  Notes on the deferred completion mechanism:
    - Child session (THIS surface) was launched with `--defer-status`, so its
      runner wrapper checks for `<STATUS_DIR>/.deferred` at exit. When the file
      exists, the wrapper skips status.json update, parent notification, and
      `cmux wait-for` emission — letting the grandchild's wrapper own those.
    - When SAME MODEL ("opus 1m") is chosen, do NOT create `.deferred`. The
      Child completes implementation in-session and its wrapper writes done as usual.

VIOLATION: Do NOT skip Phase B. Follow the exact flow defined in this PHASE B block
(either AskUserQuestion or the default-direct path); do not invent an execution model.
PLAN-MODE TRAP: ExitPlanMode approval ("start implementing") does NOT
override this sequence. After the plan is approved, BEFORE editing any file,
return to this block and complete Phase A-R (if present) then Phase B. Save
the plan to a file first if you have not already.
=== END MANDATORY MODEL SELECTION SEQUENCE ===
```

**codex 設計 variant**（design=codex のタスクでは PHASE A / PHASE B を以下に差し替える）:

```
PHASE A — Planning / Brainstorming (THIS codex session):
  Produce the plan in THIS session. Do NOT switch models mid-session.
  - superpowers mode: brainstorm, then write a plan file
  - plan mode: use /plan; the approved plan MUST list Step 0 (Phase A-R, when the
    block exists below) and Step 1 (Phase B selection) BEFORE any implementation
    step, and be saved to a file (e.g. .claude/plans/<task-slug>.md) as the FIRST
    action after approval.
  Remember the plan file path — every Phase B choice hands it off via --plan-file.

PHASE B — Execution model selection (REQUIRED before any code change):
  After Phase A (and Phase A-R when present) completes, follow the Phase B flow
  resolved in this task prompt (AskUserQuestion or default direct):
    Q: "実行フェーズで使用するモデルを選択してください"
    Options:
      1. opus 1m  — 高品質・長コンテキスト (推奨: 大規模・複雑な実装)
      2. sonnet   — 高速・低コスト (推奨: 中規模・パターン化された実装)
      3. codex    — <exec_model> で実行 (推奨: 定型実装・別視点が欲しいとき；
         <exec_model> が未設定なら「codex 既定モデル」と記す)

  ALL three choices DELEGATE to a pre-warmed pane — THIS session never implements.
  Common delegation steps (X = chosen pane key in prewarm.json: "review" for
  opus 1m / "sonnet" / "codex"; NAME = the pane's agent name from prewarm.json):
    1. Leave the unused standby panes OPEN and idle — do NOT close them.
    2. touch "<EXISTING_STATUS_DIR>/.assigned-<NAME>"
    3. Send the execution request to the pane's surface_id. Delivery is ALWAYS
       the typed prompt (cmux send + send-key return); when the pane's delivery
       is "agmsg" AND its ready sentinel exists, ALSO record the request in its
       inbox first (same dual-send rules as the claude variant).
       REQUEST_TEXT: same as the claude variant (execute the plan at
       <PLAN_FILE_PATH>, code-review protocol block when Phase B-R is enabled,
       exit instruction).
    4. touch "<EXISTING_STATUS_DIR>/.deferred"
    5. THEN follow the CODE REVIEW block below for your post-delegation role
       (reviewer or idle).
  Pane-specific notes:
    [opus 1m] target = prewarm.json .review (the claude pane, agent <task-slug>-opus).
      Its model is already <CLAUDE_REVIEW_MODEL> — do not pass /model commands.
    [sonnet]  target = prewarm.json .sonnet (same as the claude variant sonnet branch).
    [codex]   target = prewarm.json .codex (exec_model / exec_effort are baked in
      at pane launch).
  IF prewarm.json is absent (prewarm off / split layout), fall back to spawning
  via launch-workspace.sh --mode execute exactly as the claude variant does
  (opus 1m fallback: --model 'opus[1m]' --skip-permissions with the
  reviewer runner's command via --runner <REVIEWER_RUNNER>).
```

**Placeholder rules** (executed by the parent when constructing each child's prompt):

- `{{LAYOUT}}` → `workspace` or `split` (the value passed to `launch-workspace.sh --layout`).
  For `claude-teams` layout, this whole MODEL SELECTION block can be omitted because
  Phase B does not apply (the orchestrator drives the teammates).

- `{{EXEC_DEFAULT_HINT}}` → resolve `exec_choice` in Step 1g before constructing the
  prompt. When it is valid, replace the entire Phase B AskUserQuestion section in both
  the design=claude template and the design=codex variant with this block (do not leave
  a conflicting AskUserQuestion instruction elsewhere):

  ```text
  PHASE B — Execution model default is fixed to "<default>" (skip AskUserQuestion):
    ExitPlanMode 後は AskUserQuestion をスキップし、直ちに <default> の既存 Phase B
    ブランチを実行してください。新しい実行経路は作らないこと。
    - opus 1m: design=claude は `/model opus[1m]` で現セッション実装、
      design=codex は既存の review/opus pane 委譲手順を実行する。
    - sonnet: 既存の prewarm または spawn の sonnet 委譲手順を実行する。
    - codex: 既存の prewarm または spawn の codex 委譲手順を実行する。
  ```

  When explicitly `"ask"`, substitute an empty hint and retain the existing
  AskUserQuestion section unchanged.

  When **empty**（unset、または設定されていたレイヤーがすべて不正値だった場合）, retain
  the existing AskUserQuestion section AND substitute this persistence follow-up block
  （design=claude テンプレート・design=codex variant のどちらでも同じブロックを使う）:

  ```text
  PHASE B — Persistence follow-up (exec_choice is unset):
    実行モデルの AskUserQuestion に回答を得た直後・実装を始める前に、もう 1 問だけ
    AskUserQuestion で確認する:
      Q: "実行モデル選択の今後の動作を選んでください"
      Options:
        1. 今回のみ — 保存しない（次回の dispatch でも選択後にこの確認が出ます）
        2. 常にこの選択を使う — global config に exec_choice="<選んだ値>" を永続化
        3. 常に毎回選ぶ — global config に exec_choice="ask" を永続化
           （以後モデル質問は毎回出るが、この確認は出なくなる）
    Persistence (options 2/3 only) writes the GLOBAL config (project config には
    書かない)。並列の子セッションが同時に書いても壊れないよう、必ず writer 固有の
    一時ファイル + 同一ディレクトリ内 mv (atomic replace) を使い、jq が成功したとき
    だけ mv する（既存 config が不正 JSON だと jq が失敗する — そのまま mv すると
    config を 0 byte で潰すため、失敗時は tmp を消して警告し永続化を諦める）:
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
    <value> は "opus 1m" / "sonnet" / "codex" / "ask" のいずれか。同時書き込みは
    ファイル全体の last-write-wins（後勝ち）で構わない。同一 dispatch 内の他タスクは
    prompt 構築済みのため今回はこの確認が出続けるが、次回 dispatch から反映される。
    この確認の回答は今回の Phase B 分岐には影響しない — 選んだモデルで直ちに続行する。
    「常に〜」を選んだ後の戻し方は 2 通りで意味が異なる: exec_choice を "ask" に書き換える
    と毎回モデル質問のみ（この確認は出ない）、キーを削除すると未設定に戻りこの確認が再表示される。
  ```

- `{{TEAM}}` → the agmsg team name resolved in Step 1g (`dispatch-<repo-name>`); empty in
  send-message mode. Phase B's `send.sh` calls use this value. The child session runs
  inside a worktree and must NOT re-derive the team name there — deriving it from the
  worktree's `basename` (as Step 1g's `TEAM=` line does for the parent) yields a wrong
  name, since the worktree directory name is `<task-slug>`, not the repo name.

- **設計 engine** = Step 1f でこのタスクに割り当てた runner の engine（`claude` または
  `codex`）。以下のテンプレート出し分けはすべてこの値で決まる。
- テンプレートはタスクの設計 runner の engine で出し分ける:
  - design=claude → 従来どおり（PHASE A は "always opus"、PHASE B の SAME MODEL は
    `/model opus[1m]`）
  - design=codex → PHASE A / PHASE B セクションを上の「codex 設計 variant」に差し替える。
    `{{REVIEW_BLOCK}}` は variant の PHASE A と PHASE B の間に、`{{CODE_REVIEW_BLOCK}}` は
    variant の PHASE B の後に、それぞれ差し替え後もそのまま注入する（挿入位置はテンプレート内の
    `{{REVIEW_BLOCK}}` / `{{CODE_REVIEW_BLOCK}}` の元の位置を踏襲）。`{{CODEX_OPTION_LINE}}` と
    `{{CODEX_BEHAVIOR_BLOCK}}` は design=codex では出力しない（drop して空文字列にする）—
    variant の PHASE B が 3 択 (opus 1m / sonnet / codex) をすでに内包しており、design=claude
    前提の `{{CODEX_BEHAVIOR_BLOCK}}`（codex 実装後に YOU がレビュアーへ転じる指示）を残すと、
    design=codex の codex 実装ケース（正: YOU は `.deferred` touch 後に exit し、レビューは
    右上 claude ペインが担う）と矛盾する
- `{{REVIEW_MODEL}}` → design=claude: Step 1g の `REVIEW_MODEL` / design=codex:
  `CLAUDE_REVIEW_MODEL`
- `{{REVIEW_RUNNER_NAME}}`（旧 `{{CODEX_RUNNER_NAME}}` を改名）→ design=claude:
  codex runner の `name` / design=codex: `REVIEWER_RUNNER`
- `{{REVIEW_PANE_AGENT}}` → design=claude: `<task-slug>-review` / design=codex:
  `<task-slug>-opus`

- `{{REVIEW_BLOCK}}` → **Phase A-R enabled のときのみ**（design=claude タスクは Step 1g の
  `REVIEW_ENABLED`、design=codex タスクは `REVIEW_ENABLED_CODEX_DESIGN` が true）、以下のブロック
  全体（`{{REVIEW_MODEL}}` / `{{REVIEW_RUNNER_NAME}}` / `{{REVIEW_PANE_AGENT}}` は上の設計 engine
  分岐で置換して）を焼き込む。disabled のときは空文字列:

  ````
  PHASE A-R — Plan/Spec review by the counterpart engine (REQUIRED between Phase A and Phase B):
    Review model: {{REVIEW_MODEL}} (runs in a dedicated review pane — a plain review
    session (engine is the opposite of this session's) with NO status.json ownership;
    NEVER touch .assigned-{{REVIEW_PANE_AGENT}} during review — the ONLY exception is
    the Phase B opus 1m delegation step (design=codex), which explicitly touches it to
    hand over implementation ownership)

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
          --runner {{REVIEW_RUNNER_NAME}} --model '{{REVIEW_MODEL}}' \
          --status-dir "<EXISTING_STATUS_DIR>" \
          {{REVIEW_PANE_AGENT}})
          # (when the reviewer engine is claude, append --skip-permissions to the spawn)
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
      2. Send the request, then wait by polling the verdict file. The request is
         ALWAYS delivered as a typed prompt (`cmux send`) — an agmsg push alone
         never wakes an idle pane, and an agmsg reply push never wakes THIS
         session while it idle-waits, so the wait is ALWAYS file polling too.
         When the review pane's agmsg wiring is alive (ready sentinel present),
         ALSO push the request to its inbox first as a record:
           [[ "$REVIEW_DELIVERY" == "agmsg" && ! -f "$HOME/.agents/skills/agmsg/run/ready.${TEAM}__{{REVIEW_PANE_AGENT}}" ]] \
             && REVIEW_DELIVERY="cmux-send"
         IF "agmsg":
           ~/.agents/skills/agmsg/scripts/send.sh "$TEAM" <task-slug> {{REVIEW_PANE_AGENT}} "<request text>"
           # $TEAM is the TEAM value given above — do NOT re-derive it
           Append to the request text: " (An identical copy of this request is in
           your agmsg inbox — treat both as ONE request; ignore the duplicate.)"
         ALWAYS (both delivery values):
           cmux send --surface "$REVIEW_SURFACE" "<request text>"
           cmux send-key --surface "$REVIEW_SURFACE" return
           Wait by polling the verdict file (5s interval, in 15-min chunks with
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
             N < 3  → run round N+1.
             N == 3 → summarize the unresolved findings and ask via AskUserQuestion:
               Q: "レビューで 3 往復しても approve が出ませんでした。残りの指摘: <要約>。どうしますか？"
                 1. このまま進む — 残指摘を文書に注記して Phase B へ
                 2. さらに修正 — もう 1 往復レビューを続ける
               "このまま進む" → append the unresolved findings as a note in the
               document and move on (leave the review pane open — do not close it).
               "さらに修正" → run one more round; on another needs_work, re-ask.
         - The wait exited stalled (STALLED=1: no screen change over a full
           15-min chunk, or the pane was unobservable at 2 consecutive chunk
           boundaries) → check the verdict file one last time; if still no
           VERDICT line, re-send the SAME round's request once (retake the
           baseline snapshot). If the wait exits stalled again, ask via
           AskUserQuestion:
             Q: "レビュアーが停止しているようです（pane に変化なし）。どうしますか？"
               1. 再依頼する
               2. レビューを省略して Phase B へ進む
             Option 2 → skip the review and continue to Phase B (leave the review
             pane open — do not close it).

    VIOLATION: When this block is present, do NOT start Phase B before every
    review point reached approve or an explicit user decision was made.
  ````

- `{{CODE_REVIEW_BLOCK}}` → **Phase A-R と同一条件**（design=claude タスクは `REVIEW_ENABLED`、
  design=codex タスクは `REVIEW_ENABLED_CODEX_DESIGN` が true）のときのみ、以下のブロック全体を
  焼き込む。disabled のときは空文字列:

  ````
  PHASE B-R — Post-implementation code review (REQUIRED before the PR is created):
    Enabled together with Phase A-R. Review point id: "code". Findings file:
    <EXISTING_STATUS_DIR>/review/code-round-<N>.md — the LAST line MUST be exactly
    'VERDICT: approve' or 'VERDICT: needs_work'. Max 3 rounds.

    Reviewer assignment (unified rule): the reviewer is ALWAYS the opposite engine
    of the implementer. Physically:
      - implementer engine == 設計 engine → the review pane reviews
        (REVIEWER_SURFACE = prewarm.json .review.surface_id)
      - implementer engine != 設計 engine → the DESIGN session (YOU) reviews
        (REVIEWER_SURFACE = your own $CMUX_SURFACE_ID)
    Concretely, by 設計 engine and Phase B choice:

    [design=claude]
      - "opus 1m" (YOU implement in-session) → the review pane reviews your code:
        run the SAME Round loop as PHASE A-R with point id "code" — use the
        「opus 1m — the review pane reviews」 protocol at the end of this block.
      - "sonnet" → the review pane reviews. The sonnet standby is the implementer:
        send it the extended REQUEST_TEXT (共通プロトコル a) with <REVIEWER_SURFACE>
        = prewarm.json .review.surface_id. YOU (the design pane) touch .deferred and
        then exit THIS session — you have NO reviewer role (do NOT run steps b–e).
        (現行変更: 旧仕様では設計 opus ペインがレビューしていた。)
      - "codex" → YOU become the code reviewer. The codex standby is the implementer:
        send it REQUEST_TEXT (共通プロトコル a) with <REVIEWER_SURFACE> = your own
        $CMUX_SURFACE_ID, then run steps b–e.

    [design=codex]
      - "opus 1m" / "sonnet" → YOU (the design codex session) become the code
        reviewer. The delegated claude pane is the implementer (opus 1m → the review
        pane, agent <task-slug>-opus / sonnet → the sonnet standby): send it
        REQUEST_TEXT (共通プロトコル a) with <REVIEWER_SURFACE> = your own
        $CMUX_SURFACE_ID, then run steps b–e (.deferred の後も exit せず idle 待機
        → round ごとに findings を書く → approve 書き込み後に exit)。
      - "codex" (standby) → the claude review pane reviews. The codex standby is the
        implementer: send it REQUEST_TEXT (共通プロトコル a) with <REVIEWER_SURFACE>
        = prewarm.json .review.surface_id. YOU touch .deferred and then exit THIS
        session — no reviewer role.
      - review pane unavailable (the PHASE A-R Setup spawn failed and review was
        skipped) → skip this code review and proceed to the PR — review is a quality
        gate, not a dispatch blocker.

    共通プロトコル a — extended REQUEST_TEXT (the implementer drives the round loop;
    used in every branch above where a standby / delegated pane implements):
      a. Prewarm path only — REQUEST_TEXT: use this extended version instead
         (fill every <...> before sending):
           "Read and execute the plan at <PLAN_FILE_PATH>. After all changes are
            committed and BEFORE creating the PR, you MUST get a code review
            approval. Round N starts at 1, max 3 rounds. Each round:
            (1) send the review request. If <TEAM> is non-empty AND the file
                $HOME/.agents/skills/agmsg/run/ready.<TEAM>__<task-slug> exists, first
                record the request in the reviewer's inbox (an agmsg push alone cannot
                wake the idle reviewer pane, so this is a record only — the cmux send
                below is what delivers):
                  ~/.agents/skills/agmsg/scripts/send.sh <TEAM> <your-agent-name> <task-slug> '<request text>'
                then ALWAYS run (regardless of the agmsg record above):
                  /Applications/cmux.app/Contents/Resources/bin/cmux send --surface <REVIEWER_SURFACE> '<request text>'
                  /Applications/cmux.app/Contents/Resources/bin/cmux send-key --surface <REVIEWER_SURFACE> return
                where <request text> is: code review round N: review the committed
                changes on this branch against the plan at <PLAN_FILE_PATH>; write
                findings to <EXISTING_STATUS_DIR>/review/code-round-N.md whose LAST
                line must be VERDICT: approve or VERDICT: needs_work. From round 2
                append your rebuttals to the findings you rejected, with reasons.
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
                commit, and start round N+1. If round 3 still ends with needs_work:
                if you can ask the user interactively (AskUserQuestion), ask whether
                to proceed or run one more round; otherwise note the unresolved
                findings in the PR body and proceed. If the wait exits stalled,
                check the verdict file one last time, then re-send the same round
                once (retake the baseline); if it stalls again, ask via
                AskUserQuestion if you can (再依頼 / レビュー省略して PR 作成);
                otherwise skip the review and note that in the PR body.
            After the PR is created (or all changes are merged per the plan), run
            /exit (claude) or end the session (codex). Do not leave it idle."
         Placeholder values: <REVIEWER_SURFACE> = the value fixed by the 設計 engine
         branch above (YOU review → your own $CMUX_SURFACE_ID; the review pane reviews
         → prewarm.json .review.surface_id), <TEAM> = the TEAM value given above (empty
         in send-message mode — then always use the cmux send path), <your-agent-name>
         = the implementing pane's agent name (<task-slug>-sonnet / <task-slug>-codex /
         <task-slug>-opus, whichever Phase B choice dispatched to).

    共通プロトコル b–e — YOU become the code reviewer (only in the branches above
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
      e. Orphan guard: if the implementer finishes without ever requesting a review,
         you simply stay idle — that is acceptable. The parent closes all panes at
         the final all-tasks-complete cleanup, and status.json is still owned by the
         implementer's wrapper.

    [opus 1m — the review pane reviews] (design=claude "opus 1m" のみ)
      After implementation is committed and BEFORE creating the PR, run the SAME
      Round loop as PHASE A-R once more with point id "code", reusing REVIEW_SURFACE
      and REVIEW_DELIVERY from the PHASE A-R Setup. Differences from a document round:
        - Request text: ask for a review of the committed changes on this branch
          (git log / git diff against the branch point) against the plan at
          <PLAN_FILE_PATH>, findings to <EXISTING_STATUS_DIR>/review/code-round-<N>.md.
        - Round 3 needs_work → ask via AskUserQuestion:
            Q: "コードレビューで 3 往復しても approve が出ませんでした。残りの指摘: <要約>。どうしますか？"
              1. このまま PR 作成 — 未解決指摘を PR 本文に注記して進む
              2. さらに修正 — もう 1 往復続ける（再度 needs_work なら再質問）
        - Review pane unavailable (the PHASE A-R Setup spawn failed and review was
          skipped) → skip this code review too and proceed to the PR — review is a
          quality gate, not a dispatch blocker.

    VIOLATION: When this block is present, do NOT create the PR before the code
    review reached approve or one of the explicit fallbacks above was taken.
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
              1. Leave the unused standby panes (sonnet / opus / review) OPEN and idle — do
                 NOT close them (see the sonnet branch above: an unassigned standby writes no
                 status.json, and keeping all four panes open is the intended layout).
              2. touch "<EXISTING_STATUS_DIR>/.assigned-<task-slug>-codex"
              3. Send the execution request. Delivery is ALWAYS the typed prompt
                 (`cmux send`) — an agmsg push alone is not guaranteed to wake an
                 idle codex pane. When the agmsg wiring is alive, ALSO push the
                 same text to its inbox first (record + reply channel).
                 Check `.codex.delivery` in prewarm.json:
                 # IF the PHASE B-R block exists below, REQUEST_TEXT must be the
                 # extended version defined in that block (with the pre-PR
                 # code-review protocol) — same as the sonnet branch.
                   DELIVERY=$(jq -r '.codex.delivery // "cmux-send"' "<EXISTING_STATUS_DIR>/prewarm.json")
                   # re-verify watcher liveness right before sending (see the sonnet branch)
                   [[ "$DELIVERY" == "agmsg" && ! -f "$HOME/.agents/skills/agmsg/run/ready.${TEAM}__<task-slug>-codex" ]] \
                     && DELIVERY="cmux-send"
                   # Base request. CRITICAL: for codex the exit instruction must tell it
                   # to END THE CODEX SESSION ITSELF — do NOT say "run /exit" (that is a
                   # claude command; codex does not act on it). Without a codex-appropriate
                   # exit instruction the codex TUI stays idle after finishing the work, so
                   # the runner wrapper (blocked on the codex process) never reaches
                   # write_status "done" / signal fire / parent notify → the completion
                   # notification never arrives. This mirrors the engine-aware EXIT_INSTRUCTION
                   # that launch-workspace.sh bakes into the spawn (`--mode execute`) path.
                   REQUEST_TEXT="Read and execute the plan at <PLAN_FILE_PATH>. After all work is committed/pushed and the PR is created (or all changes are merged per the plan), end this codex session immediately so the wrapper script can finalize the completion notification. Do NOT run /exit and do NOT leave the session idle."
                 IF DELIVERY == "agmsg":
                   ~/.agents/skills/agmsg/scripts/send.sh "$TEAM" <task-slug> <task-slug>-codex "$REQUEST_TEXT"
                   # $TEAM is the TEAM value given above — do NOT re-derive it in this session
                   REQUEST_TEXT="$REQUEST_TEXT (An identical copy of this message is in your agmsg inbox — treat both as ONE task; ignore the duplicate.)"
                 ALWAYS (both delivery values):
                   cmux send --surface "$CODEX_SURFACE" "$REQUEST_TEXT"
                   cmux send-key --surface "$CODEX_SURFACE" return
              4. touch "<EXISTING_STATUS_DIR>/.deferred". IF the PHASE B-R block
                 exists below, do NOT exit — switch to the reviewer role it defines.
                 OTHERWISE exit THIS session.

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
                  [--review-config "<EXISTING_STATUS_DIR>/review/code-review.json"]  # PHASE B-R があるときのみ
                  <task-slug>-exec
              IF the PHASE B-R block exists below, BEFORE the launch above write the
              reviewer wiring file exactly as in the sonnet branch (mkdir -p the
              review dir, then jq -n {reviewer_surface: $CMUX_SURFACE_ID,
              reviewer_workspace: $CMUX_WORKSPACE_ID,
              review_dir: <EXISTING_STATUS_DIR>/review} > .../review/code-review.json).
              Then write the deferred sentinel:
                touch "<EXISTING_STATUS_DIR>/.deferred"
              IF the PHASE B-R block exists below, do NOT exit — switch to the
              reviewer role it defines. OTHERWISE exit.
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

### Plan-mode Enforcement Hook (ExitPlanMode)

標準 plan モードでは ExitPlanMode 承認直後に「プランを実行せよ」という強いシステム指示が
入り、プロンプト焼き込みの MANDATORY MODEL SELECTION SEQUENCE (Phase A-R / Phase B) が
スキップされることがある。これを防ぐため、`launch-workspace.sh` は **`--mode plan` かつ
claude engine、かつ非 claude-teams レイアウト** のときのみ、worktree の `.claude/settings.local.json` に PostToolUse hook
(matcher: `ExitPlanMode`, command: `zsh <this-skill-dir>/scripts/plan-approved-hook.sh`) を
注入する。hook は承認直後に「ファイル編集前に Phase A-R (有効時) → Phase B を実行せよ」と
いう additionalContext を機械的に再注入する。

- hook はベストエフォート: settings 書き込み・マージ失敗は警告ログのみで dispatch を止めない
  (プロンプト側の指示がフォールバック)。既存 settings.local.json は jq でマージし、
  worktree 再利用時に重複注入しない
- 誤コミット防止: `.claude/settings.local.json` と plan 保存先 `.claude/plans/` は repo 共有の
  `info/exclude` に追記される（plan ファイルは `--plan-file` のパス渡しで使う作業物であり、
  子の `git add -A` でタスクブランチにコミットさせない）
- hook は worktree の settings.local.json に残存するため、同一 worktree を再利用する後続
  セッション（Phase B の execute 孫を含む）にも作用する。それらは plan モードを使わないため
  実害はない
- superpowers モード / codex engine / execute・standby・review モード / claude-teams レイアウトでは注入されない

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
- **Phase A-R enabled**: 2×2 even grid。レビューペインは常に設計 engine の逆:
  - design=claude (現行): top-left: opus / top-right: codex review pane (idle,
    `--model <review_model>`, agent `<slug>-review`) / bottom-left: sonnet /
    bottom-right: codex
  - design=codex: top-left: design codex (idle, `--effort <plan_effort>`) /
    top-right: claude review pane (idle, reviewer runner + `--model
    <CLAUDE_REVIEW_MODEL>` + `--skip-permissions`, agent `<slug>-opus` — A-R
    レビュアー兼 Phase B opus 1m 実装先の二役) / bottom-left: sonnet /
    bottom-right: codex (exec_model / exec_effort)
  どちらも review pane は standby wrapper の status 所有権なしで起動する
  (design=codex の右上のみ、Phase B で opus 1m が選ばれたときに
  `.assigned-<slug>-opus` が touch され実装者として status を持つ)。

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
  [--design-runner <design-runner-name>] \
  [--reviewer-runner <reviewer-runner-name>] \
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
  [--design-runner <design-runner-name>] \
  [--reviewer-runner <reviewer-runner-name>] \
  --message-type agmsg --agmsg-team "$TEAM" \
  --parent-notify-workspace "$CMUX_WORKSPACE_ID" \
  --parent-notify-surface "$CMUX_SURFACE_ID")
```

Flag selection per task:
- codex implementation pane: pass `--codex-runner <name>` whenever a codex
  runner exists in `runners.json` (`CODEX_RUNNER_COUNT > 0`), **INDEPENDENT of
  review mode** — this is the Phase B implementation codex pane (bottom of the
  vertical stack when Phase A-R is off, bottom-right of the 2×2 grid when on).
  `<name>` is the `name` of the first `engine: codex` runner. Applies to BOTH
  design=claude and design=codex tasks. Omitting it when review is off would
  hide the codex exec option even though `exec_choice`/`codex` remains valid.
- design=claude: pass `--review-model "$REVIEW_MODEL"` only when Phase A-R is
  enabled (`REVIEW_ENABLED`). It additionally requires `--codex-runner` (already
  passed by the rule above whenever a codex runner exists).
- design=codex: ALWAYS pass `--design-runner <runner>`. Pass
  `--reviewer-runner "$REVIEWER_RUNNER"` only when `REVIEW_ENABLED_CODEX_DESIGN`
  is true. `--review-model` must NOT be passed (mutually exclusive).

Since the normal task-prompt launch never runs in this mode, `prewarm-panes.sh` itself writes
an initial `"launched"` status.json (with `workspace_id`/`surface_id` populated) right after
creating the panes, so `.dispatch/<task-slug>/status.json` is observable immediately.

Then dispatch the Phase A task to the opus pane:

1. Write the full task prompt (including PROGRESS REPORTING FORMAT, the
   MANDATORY MODEL SELECTION SEQUENCE, and the agmsg status-protocol block
   from Step 2 — its MANDATORY completion notification (send.sh + cmux send)
   is what notifies the parent) to
   `<repo-root>/.worktrees/<task-slug>/.cmux-team-dispatch-task-prompt.md`.
2. `touch .dispatch/<task-slug>/.assigned-<task-slug>` — the opus standby wrapper owns
   status.json transition from now on (it was launched with `--defer-status`,
   so a Phase B handoff can still suppress it via `.deferred`).
3. Send the task. Delivery is ALWAYS the typed prompt (`cmux send`) — an agmsg
   push alone never wakes an idle claude pane: its watcher runs as a background
   Bash whose stream output sits in a buffer and is not injected until the
   process exits, so a push-only task sits undelivered forever even while the
   watcher is alive. When the opus pane's agmsg wiring is alive, ALSO push the
   same text to its inbox first (record + reply channel). Check
   `.dispatch/<task-slug>/prewarm.json` for `.opus.delivery`:

   ```bash
   OPUS_DELIVERY=$(jq -r '.opus.delivery // "cmux-send"' .dispatch/<task-slug>/prewarm.json)
   [[ "$OPUS_DELIVERY" == "agmsg" && ! -f "$HOME/.agents/skills/agmsg/run/ready.${TEAM}__<task-slug>" ]] \
     && OPUS_DELIVERY="cmux-send"
   TASK_TEXT="Read and follow the task in .cmux-team-dispatch-task-prompt.md. Mode: <plan|superpowers> — for superpowers invoke the superpowers:brainstorming skill first; for plan produce a structured plan before implementing."
   ```

   - IF `"agmsg"` → first record the task in the inbox:
     `~/.agents/skills/agmsg/scripts/send.sh "$TEAM" parent <task-slug> "$TASK_TEXT"`
     (slash commands cannot fire through agmsg push, so the mode is conveyed
     as message text, not as `/plan`), then append to TASK_TEXT:
     ` (An identical copy of this message is in your agmsg inbox — treat both as ONE task; ignore the duplicate.)`
   - ALWAYS (both delivery values) →
     `cmux send --surface <opus-surface> "$TASK_TEXT"` followed by
     `cmux send-key --surface <opus-surface> return`.

   The ready sentinel (`~/.agents/skills/agmsg/run/ready.<team>__<agent>`) is
   created by agmsg's watch.sh while a live watcher is receiving for that role
   and removed on exit — team/agent names here are `[A-Za-z0-9._-]` slugs, so
   the path needs no encoding. It gates only the inbox copy: a live watcher
   proves the pane can RECORD and REPLY via agmsg, not that a push alone would
   be seen — the typed prompt is what actually delivers.

prewarm.json schema (written by `prewarm-panes.sh`; `opus` only in agmsg mode,
`codex` only when a codex runner exists, `review` only when `--review-model`
or `--reviewer-runner` was passed; `delivery` is `"agmsg"` or `"cmux-send"`
depending on whether delivery wiring succeeded; `engine` is `"claude"` or
`"codex"` — `opus`'s engine follows the design runner (`claude` normally,
`codex` when `--design-runner` is a codex-engine runner), `sonnet` is
always `claude`, `codex` is always `codex`, and `review`'s engine is the
opposite of the design engine (`codex` review pane when design is `claude`,
with `agent` suffix `-review`; `claude` review pane when design is `codex`,
with `agent` suffix `-opus`)):

```json
{
  "opus":   { "surface_id": "surface:N", "agent": "<slug>",        "engine": "claude", "delivery": "agmsg" },
  "sonnet": { "surface_id": "surface:N", "agent": "<slug>-sonnet", "engine": "claude", "delivery": "agmsg" },
  "codex":  { "surface_id": "surface:N", "agent": "<slug>-codex",  "engine": "codex",  "delivery": "cmux-send" },
  "review": { "surface_id": "surface:N", "agent": "<slug>-review", "engine": "codex",  "delivery": "cmux-send" }
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
  as typed `[dispatch] task "<slug>" finished (status: ...)` prompts (`cmux send`
  + `send-key return`), with an identical agmsg push recorded in the parent's
  inbox. The typed prompt is the channel that actually wakes this session — an
  agmsg push alone cannot wake an idle session (watcher stream output is never
  injected while idle). If nothing arrives for an extended period, poll
  `.dispatch/*/status.json` manually (see "Polling Status Files"). The
  `[dispatch-monitor]` heartbeat / DIED messages do not exist in this mode.
  Notifications come from two sources: the child itself right after writing
  status.json (mandatory, see Step 2) and the runner wrapper at session exit
  (backstop). Receiving the same completion twice (or via both channels) is
  normal — treat notifications idempotently and trust status.json as the
  source of truth.

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

  # pre-warm standby pane が残っていれば全て閉じる (常 4 ペイン維持のため Phase B 後も全 standby が残る)
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
- **Same-model vs different-model in Phase B**: `exec_choice` controls whether Phase B asks or takes a fixed default; it never introduces a new execution path. For design=claude, "opus 1m" counts as the same model and stays in the current session via `/model opus[1m]`. Any other choice (sonnet / codex) is treated as a different model: when a pre-warmed standby pane exists (prewarm.json), the Child hands off by sending the execution request to that pane; otherwise it triggers a spawn via `launch-workspace.sh --mode execute`: a new workspace if `LAYOUT=workspace`, a new split if `LAYOUT=split`. The grandchild's claude is wrapped by the standard runner script, so `status.json` transitions to `done`/`error`, `cmux wait-for --signal <slug>-exec-done` fires, and the parent receives `[dispatch] task ... finished` automatically. The Child session writes `<STATUS_DIR>/.deferred` and exits cleanly — its own runner wrapper (launched with `--defer-status`) sees the sentinel and skips status overwrite so the grandchild owns the terminal-state transition. The plan file path written in Phase A is passed via `--plan-file`; `.cmux-team-dispatch-task-prompt.md` is preserved (not overwritten). In `--mode execute`, the inner prompt automatically appends an `/exit` instruction so the grandchild Claude/Codex session closes its TUI after the PR is created — without this the runner wrapper never reaches `write_status "done"` and status.json gets stuck on `executing`.
- **Child runner selection (Step 1f)**: A separate concern from Phase B model selection. Step 1f decides which runtime *launches* the child session (claude vs codex vs zsh function), while Phase B happens *inside* the child session after planning to choose execution model. `design_runner` can fix the Step 1f selection for all tasks; `exec_choice` can fix Phase B. The runners.json registry remains runtime-only and is bootstrapped on first run via AskUserQuestion.
- **message_type**: 通知トランスポートは config (`message_type`) で `send-message` (default) / `agmsg` を切替。agmsg モードでは monitor-dispatch.sh を起動しない (status.json は両モードで不変)。agmsg のインストール判定は `~/.agents/skills/agmsg/scripts/send.sh` の存在。**agmsg push は inbox 記録専用で、idle セッションを起こせない** (watcher はバックグラウンド Bash として動き、その stream 出力はプロセスが終了するまで注入されない) — したがって wake は常に `cmux send` + `send-key return` で行い、agmsg 配線が生きているときは同一文を inbox にも記録する (dual-send)。agmsg モードの完了通知は2段構え: 子セッションが status.json 書き込み直後に送る必須通知 (send.sh + cmux send の両方。Step 2 で子プロンプトに埋め込む) + runner wrapper の exit 時通知 (バックストップ。同じく両チャネル)。idle TUI は exit しないため wrapper だけに頼ると通知されない。また Step 1g の `delivery.sh set` 出力に `AGMSG-DIRECTIVE:` 行があれば、ディスパッチ実行中のセッション自身の watcher 起動のため必ず従うこと。
- **Pre-warm standby panes**: workspace レイアウト + config `prewarm: true` (default) のとき、`prewarm-panes.sh` が各タスク workspace 内に standby ペインを配置。Phase A-R (Step 1g `REVIEW_ENABLED`) が無効時は縦に積む (上: opus / 中: `<slug>-sonnet` / 下: `<slug>-codex` — codex runner 登録時のみ)、有効時は 2×2 均等グリッド (左上: opus / 右上: codex レビュー / 左下: sonnet / 右下: codex、prewarm.json に `review` キー)。agmsg モードでは opus-1m ペインも idle 起動し (`--with-opus`)、worktree への delivery 配線 (join + `delivery.sh set`) をペイン起動前に行ったうえで、Phase A タスクは親から dual-send で送る (常に `cmux send` + `send-key return`、agmsg 配線が生きていれば加えて `send.sh` で inbox 記録)。standby wrapper は `<STATUS_DIR>/.assigned-<name>` が存在するときだけ exit 時に status.json を遷移させる。signal 名は opus が `<slug>-done`、他は `<slug>-sonnet-done` / `<slug>-codex-done`。Phase B の実行指示も同じ dual-send: prewarm.json の `delivery` 値が `"agmsg"` なら `send.sh` で inbox にも記録し、どちらの値でも `cmux send` + `send-key return` を必ず発行する。
