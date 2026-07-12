# dispatch agmsg トランスポート + pre-warm tab 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** cmux-team-dispatch-task に (1) `message_type` config による通知トランスポート切替（`send-message` / `agmsg`）と (2) workspace レイアウト時の sonnet/codex standby tab 事前起動（pre-warm）を追加する。

**Architecture:** runner wrapper（launch-workspace.sh が生成する bash）の親通知コードを `message_type` で分岐させ、agmsg モードでは monitor-dispatch.sh を起動しない。pre-warm は `--mode standby` として launch-workspace.sh に追加し、`.assigned` sentinel が存在するときだけ exit 時に status.json を書く standby wrapper で実現する。Phase B は `prewarm.json` があればメッセージ送信 1 回で実装を依頼し、なければ従来の `--mode execute` spawn にフォールバックする。

**Tech Stack:** bash, jq, cmux CLI (`/Applications/cmux.app/Contents/Resources/bin/cmux`), agmsg scripts (`~/.agents/skills/agmsg/scripts/*.sh`)

**Spec:** `docs/superpowers/specs/2026-07-12-dispatch-agmsg-prewarm-design.md`

## Global Constraints

- **4 ファイル同期の絶対ルール**: 機能仕様を変えたら `skills/cmux-team-dispatch-task/SKILL.md`（SoT）/ `skills/cmux-team-dispatch-task/references/guide-ja.md` / `README.md` / `CLAUDE.md`（プラグイン側）を同時更新する（プラグイン CLAUDE.md 記載のルール）
- 言語規約: ドキュメント・コメント・コミットメッセージは日本語、コード（変数名・フラグ）は英語
- config キーは snake_case: `message_type`（値: `"send-message"` | `"agmsg"`、default `send-message`）、`prewarm`（`true` | `false`、default `true`）
- config 優先順位: `<project>/.dispatch/config.json` > `~/.claude/cmux-team-dispatch-task/config.json`（既存規則）
- agmsg のスクリプトパス: `~/.agents/skills/agmsg/scripts/`（インストール判定は `send.sh` の存在）
- agmsg team 名: `dispatch-<repo-name>`、親 agent 名: `parent`、子: `<slug>`、standby: `<slug>-sonnet` / `<slug>-codex`
- signal 名は既存規則 `<workspace-name>-done`（standby は `<slug>-sonnet-done` / `<slug>-codex-done`）
- status.json / result.md / `cmux wait-for` signal のスキーマ・発火は両モードで不変
- codex は idle 時に agmsg push を受信できないため、codex standby への実行指示は agmsg モードでも `cmux send` で注入（完了通知のみ agmsg）
- すべてのタスクはリポジトリルート `/Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins` からの相対パスで記述。作業ディレクトリは `apps/cmux-team-dispatch-task`

---

### Task 1: launch-workspace.sh — `--message-type` / `--agmsg-team` / `--agmsg-from` と wrapper 通知分岐

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh`

**Interfaces:**
- Produces: CLI フラグ `--message-type <send-message|agmsg>`、`--agmsg-team <team>`、`--agmsg-from <agent>`。agmsg モード時、生成 wrapper は exit 時に `bash ~/.agents/skills/agmsg/scripts/send.sh <team> <from> parent "[dispatch] task \"<name>\" finished (status: done|error)"` を実行する（`cmux send` ペアの代わり）。Task 2〜6 がこのフラグ群を前提にする。

- [ ] **Step 1: 変数とオプションパースを追加**

`launch-workspace.sh` のヘッダーコメント（`--runner` の説明の直後、40行目付近）に追記:

```bash
#   --message-type <send-message|agmsg>  Parent notification transport (default: send-message).
#                                      send-message = cmux send + send-key return (現行動作)
#                                      agmsg = ~/.agents/skills/agmsg/scripts/send.sh で親 (agent 名
#                                      "parent") にメッセージ送信。--agmsg-team / --agmsg-from が必須
#   --agmsg-team <team>                agmsg の team 名 (message-type=agmsg 時必須)
#   --agmsg-from <agent>               agmsg の送信元 agent 名 (message-type=agmsg 時必須)
```

初期値ブロック（`DEFER_STATUS=0` の直後、85行目付近）に追加:

```bash
MESSAGE_TYPE="send-message"
AGMSG_TEAM=""
AGMSG_FROM=""
AGMSG_SEND="$HOME/.agents/skills/agmsg/scripts/send.sh"
```

`while` の `case` に追加（`--runner` の case の直後）:

```bash
    --message-type)
      [[ $# -lt 2 ]] && die "--message-type requires send-message or agmsg"
      MESSAGE_TYPE="$2"
      [[ "$MESSAGE_TYPE" == "send-message" || "$MESSAGE_TYPE" == "agmsg" ]] \
        || die "--message-type must be 'send-message' or 'agmsg'"
      shift 2
      ;;
    --agmsg-team)
      [[ $# -lt 2 ]] && die "--agmsg-team requires a team name"
      AGMSG_TEAM="$2"
      shift 2
      ;;
    --agmsg-from)
      [[ $# -lt 2 ]] && die "--agmsg-from requires an agent name"
      AGMSG_FROM="$2"
      shift 2
      ;;
```

- [ ] **Step 2: agmsg モードのバリデーションを追加**

workspace 名バリデーション（`[[ "$WORKSPACE_NAME" =~ ... ]]`、189行目付近）の直後に追加:

```bash
# agmsg モードは team / from が必須。send.sh が無ければインストールされていない
if [[ "$MESSAGE_TYPE" == "agmsg" ]]; then
  [[ -n "$AGMSG_TEAM" ]] || die "--agmsg-team is required when --message-type is agmsg"
  [[ -n "$AGMSG_FROM" ]] || die "--agmsg-from is required when --message-type is agmsg"
  [[ -f "$AGMSG_SEND" ]] || die "agmsg is not installed (expected $AGMSG_SEND)"
fi
```

- [ ] **Step 3: wrapper 生成の通知部分を分岐させる**

wrapper heredoc（`cat > "$RUNNER_FILE" <<EOF`）内の変数展開部、`DEFER_STATUS="${DEFER_STATUS}"` の直後に追加:

```bash
MESSAGE_TYPE="${MESSAGE_TYPE}"
AGMSG_SEND="${AGMSG_SEND}"
AGMSG_TEAM="${AGMSG_TEAM}"
AGMSG_FROM="${AGMSG_FROM}"
```

同 heredoc 内の「親ターミナルにテキスト通知を送信」ブロックを次に置き換え（`NOTIFY_MSG=` 行から `fi` まで。`\$` エスケープは heredoc 内なのでそのまま維持すること）:

```bash
# cmux send だけでは親が claude TUI の場合 input box にテキストが残って Enter が
# 押されないため、必ず send-key return を続けて発行する。
# message-type=agmsg の場合は agmsg send.sh で親 (agent 名 "parent") に送る。
NOTIFY_MSG="[dispatch] task \"${WORKSPACE_NAME}\" finished (status: \$STATUS_LABEL)"
if [[ "\$MESSAGE_TYPE" == "agmsg" ]]; then
  bash "\$AGMSG_SEND" "\$AGMSG_TEAM" "\$AGMSG_FROM" parent "\$NOTIFY_MSG" 2>/dev/null || true
elif [[ "\$LAYOUT_MODE" == "split" && -n "\$NOTIFY_SF" ]]; then
  "\$CMUX" send --surface "\$NOTIFY_SF" "\$NOTIFY_MSG" 2>/dev/null || true
  "\$CMUX" send-key --surface "\$NOTIFY_SF" return 2>/dev/null || true
elif [[ -n "\$NOTIFY_WS" ]]; then
  "\$CMUX" send --workspace "\$NOTIFY_WS" "\$NOTIFY_MSG" 2>/dev/null || true
  "\$CMUX" send-key --workspace "\$NOTIFY_WS" return 2>/dev/null || true
fi
```

（`cmux notify`（OS 通知）と `cmux wait-for --signal` は両モード共通なので触らない）

- [ ] **Step 4: 構文チェックとバリデーション動作確認**

```bash
cd apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts
bash -n launch-workspace.sh
# Expected: 出力なし (exit 0)

bash launch-workspace.sh --message-type bogus test-slug "p" 2>&1 | head -1
# Expected: Error: --message-type must be 'send-message' or 'agmsg'

bash launch-workspace.sh --message-type agmsg test-slug "p" 2>&1 | head -1
# Expected: Error: --agmsg-team is required when --message-type is agmsg

bash launch-workspace.sh --message-type agmsg --agmsg-team t test-slug "p" 2>&1 | head -1
# Expected: Error: --agmsg-from is required when --message-type is agmsg
```

（最後のケースは `~/.agents/skills/agmsg/scripts/send.sh` が存在する環境では次の die まで進まないことに注意 — from 欠落が先に検出される）

- [ ] **Step 5: Commit**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh
git commit -m "feat(cmux-team-dispatch-task): launch-workspace.sh に --message-type (send-message|agmsg) を追加"
```

---

### Task 2: launch-workspace.sh — `--mode standby` / `--standby-in` と `.assigned` sentinel wrapper

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh`

**Interfaces:**
- Consumes: Task 1 の `--message-type` / `--agmsg-team` / `--agmsg-from`
- Produces: `--mode standby --standby-in <workspace-id> --cwd <worktree>` で既存 workspace 内に terminal tab を作成し、`<workspace-name>` の standby wrapper を起動する。standby wrapper は起動時に status.json を書かず、exit 時に `<STATUS_DIR>/.assigned` が存在する場合のみ done/error 遷移 + `<workspace-name>-done` signal + 親通知を行う。prompt は省略可能（省略時 idle TUI）。出力 JSON の `surface_id` を親が `prewarm.json` に記録する（Task 4）。

- [ ] **Step 1: standby モードのパースとバリデーションを追加**

ヘッダーコメントの `--mode` 説明を更新:

```bash
#   --mode plan|superpowers|execute|standby  Claude launch mode (default: plan).
#                                      execute = Phase B 実行モード。計画ファイルを
#                                      inner prompt として渡し、.cmux-team-dispatch-task-prompt.md
#                                      を書き込まない。--plan-file が必須
#                                      standby = pre-warm 待機モード。--standby-in の workspace 内に
#                                      terminal tab を作成して待機セッションを起動する。
#                                      --cwd 必須・prompt 省略可。wrapper は <STATUS_DIR>/.assigned が
#                                      存在するときだけ exit 時に status.json を更新する
#   --standby-in <workspace-id>        standby tab を作成する既存 workspace (--mode standby 時必須)
```

`--mode` の case のバリデーションを変更:

```bash
    --mode)
      [[ $# -lt 2 ]] && die "--mode requires plan, superpowers, execute, or standby"
      MODE="$2"
      [[ "$MODE" == "plan" || "$MODE" == "superpowers" || "$MODE" == "execute" || "$MODE" == "standby" ]] \
        || die "--mode must be 'plan', 'superpowers', 'execute', or 'standby'"
      shift 2
      ;;
```

初期値に `STANDBY_IN=""` を追加し、case に追加:

```bash
    --standby-in)
      [[ $# -lt 2 ]] && die "--standby-in requires a workspace ID"
      STANDBY_IN="$2"
      shift 2
      ;;
```

`MODE == "execute"` の必須チェック（`--plan-file is required...` 付近）を次のように拡張:

```bash
# execute mode は --plan-file が必須で PROMPT は不要 (inner prompt が plan-file 由来)
# standby mode は --standby-in / --cwd が必須で PROMPT は省略可 (idle TUI 待機)
if [[ "$MODE" == "execute" ]]; then
  [[ -n "$PLAN_FILE" ]] || die "--plan-file is required when --mode is execute"
elif [[ "$MODE" == "standby" ]]; then
  [[ -n "$STANDBY_IN" ]] || die "--standby-in is required when --mode is standby"
  [[ -n "$CWD" ]] || die "--cwd is required when --mode is standby (reuse the task worktree)"
else
  [[ -z "$PROMPT" ]] && die "prompt is required. Usage: $0 [options] <workspace-name> <prompt...>"
fi
```

- [ ] **Step 2: prompt file / コマンド構築を standby 対応にする**

Step 2（Write prompt file）の分岐を拡張 — standby も prompt file を書かない:

```bash
PROMPT_FILE="$CWD/.cmux-team-dispatch-task-prompt.md"
if [[ "$MODE" == "execute" || "$MODE" == "standby" ]]; then
  log "prompt" "$MODE mode: not writing prompt file"
else
  FULL_PROMPT="$PROMPT"
  printf '%s\n' "$FULL_PROMPT" > "$PROMPT_FILE"
  log "prompt" "wrote prompt to $PROMPT_FILE"
fi
```

Step 3（Build runner command）の `PROMPT_TEXT` 解決に standby 分岐を追加（`if [[ "$MODE" == "execute" ]]` ブロックの直後）:

```bash
if [[ "$MODE" == "standby" ]]; then
  # standby は与えられた prompt をそのまま使う (agmsg join+待機指示など)。省略時は idle TUI
  PROMPT_TEXT="$PROMPT"
fi
```

engine × mode のコマンド構築（`else # claude engine (default)` ブロック周辺）に standby を追加。codex 側:

```bash
    if [[ "$MODE" == "execute" ]]; then
      # codex execute: plan モードと同じく bypass フラグを付与
      # (codex に --model は不要 — codex runner が独自に処理)
      CORE_CMD="$RUNNER_COMMAND --dangerously-bypass-approvals-and-sandbox '$PROMPT_TEXT'"
    elif [[ "$MODE" == "standby" ]]; then
      # codex standby: prompt なしで idle 起動 (idle codex は agmsg push を受信できないため、
      # 実行指示は message-type に関わらず cmux send で注入される)
      if [[ -n "$PROMPT_TEXT" ]]; then
        CORE_CMD="$RUNNER_COMMAND --dangerously-bypass-approvals-and-sandbox '$PROMPT_TEXT'"
      else
        CORE_CMD="$RUNNER_COMMAND --dangerously-bypass-approvals-and-sandbox"
      fi
    elif [[ "$MODE" == "superpowers" ]]; then
```

claude 側:

```bash
    if [[ "$MODE" == "execute" ]]; then
      if [[ -n "$CLAUDE_EXTRA_FLAGS" ]]; then
        CORE_CMD="$RUNNER_COMMAND $CLAUDE_EXTRA_FLAGS '$PROMPT_TEXT'"
      else
        CORE_CMD="$RUNNER_COMMAND '$PROMPT_TEXT'"
      fi
    elif [[ "$MODE" == "standby" ]]; then
      # claude standby: --model / --skip-permissions を反映し、prompt があれば渡す
      # (agmsg モードでは "/agmsg actas <name>" + 待機指示を初期 prompt にする)
      if [[ -n "$PROMPT_TEXT" ]]; then
        CORE_CMD="$RUNNER_COMMAND${CLAUDE_EXTRA_FLAGS:+ $CLAUDE_EXTRA_FLAGS} '$PROMPT_TEXT'"
      else
        CORE_CMD="$RUNNER_COMMAND${CLAUDE_EXTRA_FLAGS:+ $CLAUDE_EXTRA_FLAGS}"
      fi
    elif [[ "$MODE" == "superpowers" ]]; then
```

あわせて既存の warn（`--model is only meaningful with --mode execute`）の条件を `[[ -n "$MODEL" && "$MODE" != "execute" && "$MODE" != "standby" ]]` に変更する。

- [ ] **Step 3: standby wrapper の status 制御を追加**

heredoc（`cat > "$RUNNER_FILE" <<EOF`）の直前に追加:

```bash
STANDBY_FLAG=0
[[ "$MODE" == "standby" ]] && STANDBY_FLAG=1
```

heredoc 内の `DEFER_STATUS="${DEFER_STATUS}"` の並びに追加:

```bash
STANDBY="${STANDBY_FLAG}"
```

heredoc 内の `write_status "executing" "Claude session starting"` を次に置き換え（standby は子の status.json を汚さない）:

```bash
# standby wrapper は起動時に status.json を書かない (同じ STATUS_DIR を Child が使用中のため)
if [[ "\$STANDBY" != "1" ]]; then
  write_status "executing" "Claude session starting"
fi
```

heredoc 内の `.deferred` チェックの直後（`if [[ \$CLAUDE_EXIT -eq 0 ]]` の前）に追加:

```bash
# standby: .assigned sentinel が無ければ実装を引き受けていない。status を書かずに終了する
# (未使用 standby tab を閉じても status.json を汚さないための仕組み — .deferred の逆向き)
if [[ "\$STANDBY" == "1" && ! -f "\$STATUS_DIR/.assigned" ]]; then
  echo "[runner] standby exiting without assignment (no .assigned at \$STATUS_DIR)" >&2
  exit 0
fi
```

- [ ] **Step 4: standby の surface 作成パスを追加**

Step 5（Create cmux workspace OR split pane）の `if [[ "$LAYOUT" == "workspace" ...` の**前**に standby 分岐を追加し、standby の場合は既存の workspace/split 分岐に入らないようにする:

```bash
if [[ "$MODE" == "standby" ]]; then
  # --- Standby Mode: 既存 workspace に terminal tab (surface) を追加 ---
  WORKSPACE_ID="$STANDBY_IN"
  TITLE="$WORKSPACE_NAME"

  log "cmux" "creating standby tab in $STANDBY_IN"
  SURFACE_OUTPUT=$("$CMUX" new-surface --type terminal --workspace "$STANDBY_IN" 2>/dev/null) \
    || die "failed to create standby surface in $STANDBY_IN"
  SURFACE_ID=$(echo "$SURFACE_OUTPUT" | grep -oE 'surface:[0-9]+' | head -1)
  [[ -z "$SURFACE_ID" ]] && die "failed to parse surface ID from output: $SURFACE_OUTPUT"
  log "cmux" "standby surface: $SURFACE_ID"

  "$CMUX" rename-tab --workspace "$STANDBY_IN" --surface "$SURFACE_ID" "$TITLE" 2>/dev/null || \
    log "cmux" "warning: failed to rename tab (non-fatal)"

  wait_for_shell "$SURFACE_ID" || true

  "$CMUX" send --surface "$SURFACE_ID" \
    "cd '$CWD' && bash $RUNNER_SCRIPT_NAME\n" 2>/dev/null || die "failed to send cd+runner command"
  log "cmux" "standby runner command sent"

elif [[ "$LAYOUT" == "workspace" || "$LAYOUT" == "claude-teams" ]]; then
```

- [ ] **Step 5: standby は "launched" status を書かない**

Step 6（Write initial "launched" status）の `if [[ -n "$STATUS_DIR" ]]` を次に変更:

```bash
if [[ -n "$STATUS_DIR" && "$MODE" != "standby" ]]; then
```

（standby の STATUS_DIR は Child と共有しており、`launched` を書くと Child の進行中 status を巻き戻すため）

- [ ] **Step 6: 構文チェックとバリデーション動作確認**

```bash
cd apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts
bash -n launch-workspace.sh
# Expected: 出力なし (exit 0)

bash launch-workspace.sh --mode standby test-sonnet 2>&1 | head -1
# Expected: Error: --standby-in is required when --mode is standby

bash launch-workspace.sh --mode standby --standby-in workspace:99 test-sonnet 2>&1 | head -1
# Expected: Error: --cwd is required when --mode is standby (reuse the task worktree)

bash launch-workspace.sh --mode bogus test 2>&1 | head -1
# Expected: Error: --mode must be 'plan', 'superpowers', 'execute', or 'standby'
```

- [ ] **Step 7: Commit**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh
git commit -m "feat(cmux-team-dispatch-task): --mode standby (pre-warm tab) と .assigned sentinel を追加"
```

---

### Task 3: launch-session-splits.sh — `--message-type` / `--agmsg-team` パススルー

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-session-splits.sh`

**Interfaces:**
- Consumes: Task 1 の launch-workspace.sh フラグ
- Produces: `launch-session-splits.sh --message-type agmsg --agmsg-team <team> ...` が各タスクの launch-workspace.sh 呼び出しに `--message-type agmsg --agmsg-team <team> --agmsg-from <slug>` を渡す（`--agmsg-from` はタスクごとに slug を自動設定）

- [ ] **Step 1: オプション追加とパススルー**

ヘッダーコメントの Options に追記:

```bash
#   --message-type <send-message|agmsg>  子の親通知トランスポート (launch-workspace.sh に伝播)
#   --agmsg-team <team>             agmsg の team 名 (message-type=agmsg 時必須。
#                                   --agmsg-from はタスクごとに slug が自動設定される)
```

初期値に追加:

```bash
MESSAGE_TYPE="send-message"
AGMSG_TEAM=""
```

case に追加:

```bash
    --message-type)
      [[ $# -lt 2 ]] && die "--message-type requires send-message or agmsg"
      MESSAGE_TYPE="$2"
      [[ "$MESSAGE_TYPE" == "send-message" || "$MESSAGE_TYPE" == "agmsg" ]] \
        || die "--message-type must be 'send-message' or 'agmsg'"
      shift 2
      ;;
    --agmsg-team)
      [[ $# -lt 2 ]] && die "--agmsg-team requires a team name"
      AGMSG_TEAM="$2"
      shift 2
      ;;
```

Validation セクション（`command -v jq` の直後）に追加:

```bash
if [[ "$MESSAGE_TYPE" == "agmsg" ]]; then
  [[ -n "$AGMSG_TEAM" ]] || die "--agmsg-team is required when --message-type is agmsg"
fi
```

`LAUNCH_ARGS` 構築（`--defer-status` の直後）に追加:

```bash
  # agmsg モード時は launch-workspace.sh にトランスポート設定を伝播 (from はタスク slug)
  if [[ "$MESSAGE_TYPE" == "agmsg" ]]; then
    LAUNCH_ARGS+=(--message-type agmsg --agmsg-team "$AGMSG_TEAM" --agmsg-from "$SLUG")
  fi
```

- [ ] **Step 2: 構文チェックと動作確認**

```bash
cd apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts
bash -n launch-session-splits.sh
# Expected: 出力なし (exit 0)

bash launch-session-splits.sh --message-type agmsg --tasks '[{"slug":"a","prompt":"p"}]' 2>&1 | head -1
# Expected: Error: --agmsg-team is required when --message-type is agmsg

bash launch-session-splits.sh --help | grep -c 'message-type'
# Expected: 1 以上
```

- [ ] **Step 3: Commit**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-session-splits.sh
git commit -m "feat(cmux-team-dispatch-task): launch-session-splits.sh に --message-type/--agmsg-team パススルーを追加"
```

---

### Task 4: SKILL.md 更新（Step 1g 挿入 / pre-warm / Phase B / Step 3 分岐）

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md`

**Interfaces:**
- Consumes: Task 1〜3 のフラグ群
- Produces: エージェント実行時の SoT。ここで定義する文言（Step 1g、prewarm.json スキーマ、Phase B prewarm 分岐、Step 3 分岐）を Task 5・6 が各ドキュメントへ同期する。

- [ ] **Step 1: Step 1f の直後に「1g. Resolve Message Transport」を挿入し、既存 1g を 1h に繰り下げ**

既存 `### 1g. Display Summary and Proceed` を `### 1h. Display Summary and Proceed` にリネームし、Step 1 冒頭の説明文「Up to four user interactions before dispatch: ...」を「Up to five user interactions before dispatch: brainstorming selection (1c), layout mode selection (1d), integration strategy selection (1e), child runner selection (1f), and message transport selection (1g, first time only).」に更新。**`1g` への既存参照もすべて `1h` に更新する**（`### Template A — Pre-launch task list (Step 1g)` → `(Step 1h)`、および本文中の「(Step 1g)」参照。guide-ja.md の Template A 見出しも Task 5 で同様に更新）。その上で 1f の直後に挿入:

````markdown
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

**When `message_type` is `agmsg`, wire the team BEFORE launching (Step 2):**

```bash
TEAM="dispatch-$(basename "$(git rev-parse --show-toplevel)")"
# 親を join (既に member なら join.sh は再登録として扱われる) し、リアルタイム push を有効化
~/.agents/skills/agmsg/scripts/join.sh "$TEAM" parent claude-code "$(pwd)"
~/.agents/skills/agmsg/scripts/delivery.sh set monitor claude-code "$(pwd)"
```

Each launch then adds `--message-type agmsg --agmsg-team "$TEAM" --agmsg-from <task-slug>`
to `launch-workspace.sh` (or `--message-type agmsg --agmsg-team "$TEAM"` to
`launch-session-splits.sh`, which derives `--agmsg-from` per slug). After each
task's worktree exists (launch script returned), register the child:

```bash
~/.agents/skills/agmsg/scripts/join.sh "$TEAM" <task-slug> claude-code "<repo-root>/.worktrees/<task-slug>"
```

Additionally, append this line to every child prompt's status protocol section:

```
You can message the parent directly at any time (questions, progress):
  ~/.agents/skills/agmsg/scripts/send.sh <team> <task-slug> parent "<message>"
```
````

- [ ] **Step 2: Step 2 に pre-warm 起動手順を追加**

`### Launch: Workspace Mode (default)` セクションの launch コマンド例の直後に挿入:

````markdown
### Pre-warm Standby Tabs (workspace layout only)

Read `prewarm` from config (same precedence as `message_type`; default `true`):

```bash
PREWARM=$(jq -r '.prewarm // empty' .dispatch/config.json 2>/dev/null)
[[ -z "$PREWARM" ]] && PREWARM=$(jq -r '.prewarm // "true"' \
  ~/.claude/cmux-team-dispatch-task/config.json 2>/dev/null)
```

When layout is `workspace` AND `PREWARM` is `true`, after each task's
`launch-workspace.sh` returns (parse `workspace_id` from its output JSON):

1. **sonnet standby** (always):

   ```bash
   SONNET_RESULT=$(bash <this-skill-dir>/scripts/launch-workspace.sh \
     --cwd "<repo-root>/.worktrees/<task-slug>" \
     --mode standby \
     --standby-in <workspace-id> \
     --model claude-sonnet-4-6 \
     --skip-permissions \
     --status-dir "$(pwd)/.dispatch/<task-slug>" \
     --parent-notify-workspace "$CMUX_WORKSPACE_ID" \
     --parent-notify-surface "$CMUX_SURFACE_ID" \
     [--message-type agmsg --agmsg-team "$TEAM" --agmsg-from <task-slug>-sonnet] \
     <task-slug>-sonnet \
     [AGMSG_STANDBY_PROMPT])
   ```

   `AGMSG_STANDBY_PROMPT` is passed ONLY when `message_type` is `agmsg`
   (send-message mode launches an idle TUI with no prompt). Before launching,
   pre-join the standby agent: `join.sh "$TEAM" <task-slug>-sonnet claude-code "<worktree>"`.
   The prompt text:

   ```
   /agmsg actas <task-slug>-sonnet
   You are a standby implementation session. Wait for an agmsg message starting
   with "EXECUTE:". When it arrives, follow its instructions (execute the plan),
   then run /exit. Do not do anything else until that message arrives.
   ```

2. **codex standby** (only when `runners.json` has an `engine: "codex"` runner):

   ```bash
   CODEX_RESULT=$(bash <this-skill-dir>/scripts/launch-workspace.sh \
     --cwd "<repo-root>/.worktrees/<task-slug>" \
     --mode standby \
     --standby-in <workspace-id> \
     --runner <codex-runner-name> \
     --status-dir "$(pwd)/.dispatch/<task-slug>" \
     --parent-notify-workspace "$CMUX_WORKSPACE_ID" \
     --parent-notify-surface "$CMUX_SURFACE_ID" \
     [--message-type agmsg --agmsg-team "$TEAM" --agmsg-from <task-slug>-codex] \
     <task-slug>-codex)
   ```

   No prompt in either mode: an idle codex session cannot receive agmsg pushes
   (no Monitor), so the execution request is always injected via `cmux send`.

3. **Write `.dispatch/<task-slug>/prewarm.json`** from the output JSONs:

   ```bash
   jq -n \
     --arg ss "$(echo "$SONNET_RESULT" | jq -r '.surface_id')" \
     --arg cs "$(echo "${CODEX_RESULT:-}" | jq -r '.surface_id // empty')" \
     --arg slug "<task-slug>" \
     '{sonnet: {surface_id: $ss, agent: ($slug + "-sonnet")}}
      + (if $cs != "" then {codex: {surface_id: $cs, agent: ($slug + "-codex")}} else {} end)' \
     > .dispatch/<task-slug>/prewarm.json
   ```

Split / claude-teams layouts and `prewarm: false` skip this section entirely —
Phase B falls back to the on-demand `--mode execute` spawn.
````

- [ ] **Step 3: MANDATORY MODEL SELECTION SEQUENCE テンプレートに prewarm 分岐を追加**

テンプレート内の `LAYOUT: {{LAYOUT}}` 行の直後に追加:

```
MESSAGE_TYPE: {{MESSAGE_TYPE}}     # send-message or agmsg — used by Phase B request sending
AGMSG_TEAM: {{AGMSG_TEAM}}         # agmsg team name (empty when MESSAGE_TYPE=send-message)
```

`[DIFFERENT MODEL] "sonnet" → spawn the implementation via launch-workspace.sh.` の段落を次に置き換え:

```
    [DIFFERENT MODEL] "sonnet" → FIRST check for a pre-warmed standby tab:
        PREWARM_FILE="<EXISTING_STATUS_DIR>/prewarm.json"
        SONNET_SURFACE=$(jq -r '.sonnet.surface_id // empty' "$PREWARM_FILE" 2>/dev/null)

      IF SONNET_SURFACE is non-empty (pre-warm path):
        1. touch "<EXISTING_STATUS_DIR>/.assigned"
           # standby wrapper に完了処理 (status.json done/error 遷移 + <slug>-sonnet-done
           # signal + 親通知) の所有権を渡す
        2. Send the execution request (REQUEST_TEXT):
             Read and execute the plan at <PLAN_FILE_PATH>. After all work is
             committed/pushed and the PR is created (or all changes are merged per
             the plan), run /exit to close this session. Do not leave it idle.
           - MESSAGE_TYPE=send-message:
               cmux send --surface "$SONNET_SURFACE" "$REQUEST_TEXT"
               cmux send-key --surface "$SONNET_SURFACE" return
           - MESSAGE_TYPE=agmsg:
               ~/.agents/skills/agmsg/scripts/send.sh {{AGMSG_TEAM}} <task-slug> \
                 <task-slug>-sonnet "EXECUTE: $REQUEST_TEXT"
        3. Close the unused codex standby tab if present:
             CODEX_SURFACE=$(jq -r '.codex.surface_id // empty' "$PREWARM_FILE" 2>/dev/null)
             [[ -n "$CODEX_SURFACE" ]] && cmux close-surface --surface "$CODEX_SURFACE"
           # .assigned の無い standby は閉じても status.json を汚さない
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
```

`[SAME MODEL] "opus 1m"` の段落末尾に追加:

```
      If prewarm.json exists, close ALL standby tabs before continuing
      (they will not be used):
        for sf in $(jq -r '.[].surface_id' "<EXISTING_STATUS_DIR>/prewarm.json"); do
          cmux close-surface --surface "$sf"
        done
```

`{{CODEX_BEHAVIOR_BLOCK}}` のプレースホルダー規則（codex runner present 時のブロック）も同様に prewarm 分岐を先頭に追加:

```
    [DIFFERENT MODEL] "codex" → FIRST check for a pre-warmed standby tab:
        CODEX_SURFACE=$(jq -r '.codex.surface_id // empty' "<EXISTING_STATUS_DIR>/prewarm.json" 2>/dev/null)
      IF CODEX_SURFACE is non-empty:
        1. touch "<EXISTING_STATUS_DIR>/.assigned"
        2. Send the execution request via cmux send REGARDLESS of MESSAGE_TYPE
           (an idle codex session cannot receive agmsg pushes):
             cmux send --surface "$CODEX_SURFACE" "$REQUEST_TEXT"
             cmux send-key --surface "$CODEX_SURFACE" return
        3. Close the unused sonnet standby tab:
             SONNET_SURFACE=$(jq -r '.sonnet.surface_id // empty' "<EXISTING_STATUS_DIR>/prewarm.json" 2>/dev/null)
             [[ -n "$SONNET_SURFACE" ]] && cmux close-surface --surface "$SONNET_SURFACE"
        4. touch "<EXISTING_STATUS_DIR>/.deferred" then exit THIS session.
      IF prewarm.json is absent, fall back to the existing spawn flow
      (launch-workspace.sh --mode execute --runner <CODEX_RUNNER_NAME> ... — 現行手順そのまま).
```

Placeholder rules に追記:

```
- `{{MESSAGE_TYPE}}` → Step 1g で解決した message_type (`send-message` / `agmsg`)
- `{{AGMSG_TEAM}}` → agmsg モード時は `dispatch-<repo-name>`、send-message モード時は空文字
```

- [ ] **Step 4: Step 3（Monitor and Complete）に message_type 分岐を追加**

`### Notification-based Monitoring (Primary)` の冒頭（monitor 起動コマンドの前）に追加:

````markdown
**Monitoring depends on `message_type` (Step 1g):**

- `send-message` → launch `monitor-dispatch.sh` as described below (heartbeat,
  DIED detection, all-done notification).
- `agmsg` → do NOT launch `monitor-dispatch.sh`. Completion notifications arrive
  as real-time agmsg pushes (`[dispatch] task "<slug>" finished (status: ...)`)
  because the parent set delivery mode `monitor` in Step 1g. If nothing arrives
  for an extended period, poll `.dispatch/*/status.json` manually (see "Polling
  Status Files"). The `[dispatch-monitor]` heartbeat / DIED messages do not
  exist in this mode.
````

- [ ] **Step 5: クリーンアップと Constraints を更新**

「Cleanup prompts (parent-side, end of dispatch)」の bash ループ内、close 処理の後に追加:

```bash
  # pre-warm standby tab が残っていれば閉じる (Phase B で未使用のまま残るケース)
  if [[ "$close_all" == "true" && -f ".dispatch/$slug/prewarm.json" ]]; then
    for sf in $(jq -r '.[].surface_id' ".dispatch/$slug/prewarm.json" 2>/dev/null); do
      cmux close-surface --surface "$sf" 2>/dev/null || true
    done
  fi
```

同セクション末尾の Notes に追加:

```
- agmsg モード時は、最終整理の際に子 agent を team から除籍する:
  for slug in <task-slugs>; do
    ~/.agents/skills/agmsg/scripts/leave.sh "$TEAM" "$slug" 2>/dev/null || true
    ~/.agents/skills/agmsg/scripts/leave.sh "$TEAM" "$slug-sonnet" 2>/dev/null || true
    ~/.agents/skills/agmsg/scripts/leave.sh "$TEAM" "$slug-codex" 2>/dev/null || true
  done
  親 (`parent`) は repo 固定 team に残す (次回 dispatch で再利用)。
```

`## Constraints` に追加:

```
- **message_type**: 通知トランスポートは config (`message_type`) で `send-message` (default) / `agmsg` を切替。agmsg モードでは monitor-dispatch.sh を起動しない (status.json は両モードで不変)。agmsg のインストール判定は `~/.agents/skills/agmsg/scripts/send.sh` の存在。
- **Pre-warm standby tabs**: workspace レイアウト + config `prewarm: true` (default) のとき、各タスク workspace 内に `<slug>-sonnet` (+ codex runner があれば `<slug>-codex`) の standby tab を事前起動する。standby wrapper は `<STATUS_DIR>/.assigned` が存在するときだけ exit 時に status.json を遷移させる。signal 名は `<slug>-sonnet-done` / `<slug>-codex-done`。idle codex は agmsg push を受信できないため、codex への実行指示は常に `cmux send` で注入する。
```

- [ ] **Step 6: 整合確認と Commit**

```bash
cd apps/cmux-team-dispatch-task
grep -c '### 1h. Display Summary' skills/cmux-team-dispatch-task/SKILL.md
# Expected: 1
grep -c 'Resolve Message Transport' skills/cmux-team-dispatch-task/SKILL.md
# Expected: 1
grep -c 'prewarm.json' skills/cmux-team-dispatch-task/SKILL.md
# Expected: 5 以上 (Step 2 / Phase B sonnet / Phase B opus / codex block / cleanup)
git add skills/cmux-team-dispatch-task/SKILL.md
git commit -m "docs(cmux-team-dispatch-task): SKILL.md に message_type 解決 (Step 1g)・pre-warm・Phase B prewarm 分岐を追加"
```

---

### Task 5: guide-ja.md 同期

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md`

**Interfaces:**
- Consumes: Task 4 で確定した SKILL.md の文言（Step 1g / prewarm.json スキーマ / Phase B 分岐 / Step 3 分岐）
- Produces: 日本語リファレンスの同期。以下の各セクションは SKILL.md の対応箇所と**内容が完全一致**していること（4 ファイル同期ルール）。

- [ ] **Step 1: 「Step 1: Parse and Prepare」（118行目付近）に 1g を追記**

Step 1 の説明リストに「1g. メッセージトランスポート解決（初回のみ質問）」を追加し、既存のサマリー表示ステップの番号を 1h に更新（「Template A — 起動前タスク一覧（Step 1g / ...）」の見出し参照も `Step 1h` に更新）。SKILL.md Step 1g と同内容の日本語説明を追加する:

````markdown
#### 1g. メッセージトランスポート解決（message_type）

子 → 親の通知手段を決める。`send-message`（現行の cmux send、default）/ `agmsg`
（[agmsg](https://github.com/fujibee/agmsg) によるエージェント間メッセージング）。

- config（`.dispatch/config.json` > `~/.claude/cmux-team-dispatch-task/config.json`）に
  `message_type` があればそれを使い、質問しない
- 未設定 + agmsg インストール済み（`~/.agents/skills/agmsg/scripts/send.sh` が存在）
  → AskUserQuestion で確認し、**Yes / No どちらの回答もグローバル config に永続化**
- 未設定 + agmsg 未インストール → `send-message`（config には書かない）

agmsg モード時は dispatch 前に team を配線する:

```bash
TEAM="dispatch-$(basename "$(git rev-parse --show-toplevel)")"
~/.agents/skills/agmsg/scripts/join.sh "$TEAM" parent claude-code "$(pwd)"
~/.agents/skills/agmsg/scripts/delivery.sh set monitor claude-code "$(pwd)"
```

各 launch に `--message-type agmsg --agmsg-team "$TEAM" --agmsg-from <slug>` を付与し、
worktree 作成後に子 agent を join する。子プロンプトには「親 (`parent`) へ
`send.sh` で直接質問・進捗報告できる」旨を追記する。
````

- [ ] **Step 2: 「Config スキーマ」（343行目付近）に `message_type` / `prewarm` を追記**

既存の `shell_ready_ms` スキーマ説明に並べて追加:

````markdown
```json
{
  "message_type": "agmsg",
  "prewarm": true,
  "shell_ready_ms": { "baseline_ms": 1200, "samples": 5, "updated_at": "..." }
}
```

- `message_type`: 子 → 親の通知トランスポート。`"send-message"`（default）| `"agmsg"`
- `prewarm`: workspace レイアウト時の sonnet/codex standby tab 事前起動。`true`（default）| `false`
````

- [ ] **Step 3: 「Step 2: Launch Sessions」（158行目付近）に pre-warm 説明を追加**

SKILL.md「Pre-warm Standby Tabs」と同内容（sonnet/codex standby の起動コマンド、agmsg 時の `/agmsg actas` 初期 prompt、codex は prompt なし、prewarm.json スキーマ、split/claude-teams・prewarm off はスキップ）の日本語版を追加する。コマンド例は SKILL.md からそのまま転記。

- [ ] **Step 4: 「ランナースクリプト ラッパー」（473行目付近）に standby と agmsg の挙動を追記**

「ランナースクリプトが保証すること」に追加:

```markdown
- **message_type=agmsg 時**: 親へのテキスト通知は `cmux send` ペアの代わりに
  `~/.agents/skills/agmsg/scripts/send.sh <team> <from> parent "<msg>"` で送信される
  （`cmux notify` と `cmux wait-for --signal` は両モード共通）
- **standby wrapper（`--mode standby`）**: 起動時に status.json を書かず、exit 時も
  `<STATUS_DIR>/.assigned` が存在するときだけ done/error に遷移させる（`.deferred` の逆向き）。
  signal 名は `<workspace-name>-done`（例: `login-page-ui-sonnet-done`）
```

- [ ] **Step 5: 「子セッションのモデル選択フロー」（855行目付近）Phase B に prewarm 分岐を追記**

SKILL.md Phase B の変更と同内容: sonnet/codex 選択時は prewarm.json を先に確認 → あれば `.assigned` touch + 実行指示送信（sonnet: message_type 準拠 / codex: 常に cmux send）+ 不要 tab close + `.deferred` → exit。なければ従来の spawn。opus 1m 選択時は全 standby tab を close。

- [ ] **Step 6: 「監視と完了」（575行目付近）に message_type 分岐を追記**

```markdown
### message_type による監視方式の違い

- `send-message`: 従来どおり `monitor-dispatch.sh` を起動（heartbeat / DIED 検知 / 全完了通知）
- `agmsg`: `monitor-dispatch.sh` を**起動しない**。完了通知は agmsg のリアルタイム push で届く
  （親が Step 1g で delivery mode `monitor` を設定済み）。長時間通知が無い場合は
  `.dispatch/*/status.json` を手動ポーリングで確認する。`[dispatch-monitor]` 系の
  heartbeat / DIED メッセージはこのモードには存在しない
```

- [ ] **Step 7: クリーンアップ（772行目付近）に prewarm tab close と agmsg leave を追記**

SKILL.md Step 5 のクリーンアップ追記と同内容（prewarm.json の surface close、agmsg leave.sh、親は team に残す）を日本語で追加。

- [ ] **Step 8: 整合確認と Commit**

```bash
cd apps/cmux-team-dispatch-task
grep -c 'message_type' skills/cmux-team-dispatch-task/references/guide-ja.md
# Expected: 5 以上
grep -c 'prewarm' skills/cmux-team-dispatch-task/references/guide-ja.md
# Expected: 5 以上
git add skills/cmux-team-dispatch-task/references/guide-ja.md
git commit -m "docs(cmux-team-dispatch-task): guide-ja.md に message_type / pre-warm を同期"
```

---

### Task 6: README.md と plugin CLAUDE.md 同期

**Files:**
- Modify: `apps/cmux-team-dispatch-task/README.md`
- Modify: `apps/cmux-team-dispatch-task/CLAUDE.md`

**Interfaces:**
- Consumes: Task 4・5 で確定した文言
- Produces: 4 ファイル同期の完成。メンテナンス手順・E2E テスト項目に新機能の検証項目が入る。

- [ ] **Step 1: README.md「ステータスプロトコル」（135行目付近）の後に「メッセージトランスポート」セクションを追加**

````markdown
## メッセージトランスポート（message_type）

子 → 親の完了通知は config の `message_type` で切り替えられる:

| 値 | 通知手段 | monitor ループ |
|----|---------|---------------|
| `send-message`（default） | `cmux send` + `cmux send-key return` | `monitor-dispatch.sh` を起動（heartbeat / 死活監視） |
| `agmsg` | [agmsg](https://github.com/fujibee/agmsg) `send.sh`（リアルタイム push） | 起動しない（沈黙時は status.json を手動確認） |

config は `~/.claude/cmux-team-dispatch-task/config.json`（`<project>/.dispatch/config.json` が優先）。
未設定で agmsg がインストール済みの場合、初回 dispatch 時に一度だけ質問し、回答を config に永続化する。
agmsg モードの team 名は `dispatch-<repo-name>`、親の agent 名は `parent`。
status.json / result.md / `cmux wait-for` signal は両モードで不変。
````

- [ ] **Step 2: README.md「モデル選択フロー (Phase B)」（158行目付近）に pre-warm を追記**

既存セクション末尾に追加:

````markdown
### Pre-warm standby tab（workspace レイアウト時）

config `prewarm: true`（default）のとき、各タスクの workspace 内に sonnet
（+ `runners.json` に codex runner があれば codex）の待機セッションを tab として事前起動する。
Phase B で sonnet / codex を選ぶと、別 workspace を spawn する代わりに待機 tab へ
実行指示を 1 メッセージ送るだけで実装が始まる（sonnet への送信は message_type 準拠、
codex は idle 時に agmsg push を受信できないため常に `cmux send`）。
未使用の待機 tab は閉じても status.json を汚さない（`.assigned` sentinel 方式）。
split / claude-teams レイアウトや `prewarm: false` では従来の on-demand spawn。
````

- [ ] **Step 3: CLAUDE.md のファイル構成表と絶対ルールを更新**

ファイル構成表の `~/.claude/cmux-team-dispatch-task/config.json` の行を更新:

```markdown
| `~/.claude/cmux-team-dispatch-task/config.json` | グローバル設定（自動生成）。`shell_ready_ms.baseline_ms`（EMA 学習値）、`message_type`（通知トランスポート）、`prewarm`（standby tab 事前起動） |
```

「メンテナンス手順」に追加:

```markdown
12. `message_type`（`send-message` / `agmsg`）の解決フロー（Step 1g: config 優先 → agmsg インストール時のみ初回質問 → Yes/No とも永続化）が SKILL.md / guide-ja.md / README.md で一致しているか確認。agmsg モードでは monitor-dispatch.sh を起動しないこと、runner wrapper の親通知が `send.sh <team> <from> parent` に切り替わること、status.json / signal は不変であることを検証
13. pre-warm（`--mode standby` / `--standby-in` / `.assigned` sentinel / prewarm.json スキーマ / signal 名 `<slug>-sonnet-done`）が SKILL.md / guide-ja.md / README.md で一致しているか確認。standby wrapper が起動時・未 assigned exit 時に status.json を書かないこと、codex への実行指示が message_type に関わらず `cmux send` であることを検証
```

「E2E テスト（cmux セッション内で実行）」に追加:

```markdown
16. **message_type 解決**: config 未設定 + agmsg インストール済みで初回質問が出て、Yes/No どちらでも `~/.claude/cmux-team-dispatch-task/config.json` に永続化されること。config 設定済みなら質問が出ないこと
17. **agmsg モード**: monitor-dispatch.sh が起動しないこと。子の完了時に agmsg push で `[dispatch] task ... finished` が親に届くこと。status.json は従来どおり遷移すること
18. **pre-warm**: workspace レイアウトで各タスク workspace に `<slug>-sonnet` tab（codex runner があれば `<slug>-codex` tab も）が起動すること。`prewarm: false` / split レイアウトでは起動しないこと
19. **Phase B prewarm 経路**: sonnet 選択 → `.assigned` が touch され、待機 tab に実行指示が送信され、実装完了 exit 時に standby wrapper が status.json を done にし `<slug>-sonnet-done` signal + 親通知が発火すること。opus 1m 選択 → 全 standby tab が close され status.json が汚れないこと。prewarm.json が無い場合は従来の spawn にフォールバックすること
```

- [ ] **Step 4: 整合確認と Commit**

```bash
cd apps/cmux-team-dispatch-task
# 4 ファイルすべてに新機能の記述があること
for f in skills/cmux-team-dispatch-task/SKILL.md skills/cmux-team-dispatch-task/references/guide-ja.md README.md CLAUDE.md; do
  echo "$f: message_type=$(grep -c 'message_type' "$f") prewarm=$(grep -c 'prewarm' "$f")"
done
# Expected: 全ファイルで両カウントが 1 以上

git add README.md CLAUDE.md
git commit -m "docs(cmux-team-dispatch-task): README / CLAUDE.md に message_type・pre-warm を同期"
```

---

### Task 7: 最終検証（repo チェック + E2E チェックリスト）

**Files:**
- Test: リポジトリ全体（変更ファイルの静的検証）

**Interfaces:**
- Consumes: Task 1〜6 の全成果物

- [ ] **Step 1: 静的検証**

```bash
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins
bash -n apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh
bash -n apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-session-splits.sh
# Expected: 出力なし

cat apps/cmux-team-dispatch-task/.claude-plugin/plugin.json | jq . > /dev/null && echo OK
# Expected: OK

pnpm check
# Expected: pass (bash 変更なので TS への影響なし — 念のため全体確認)
```

- [ ] **Step 2: E2E チェックリスト（cmux セッション内・手動）**

実 cmux セッションで以下を確認する（自動化不可。ユーザーに提示して実施を依頼）:

1. `message_type` 未設定 + agmsg インストール済み → dispatch 時に質問が出る。「No」でも config に `"message_type": "send-message"` が書かれ、次回は質問されない
2. `message_type: agmsg` 設定済み → 質問なし。`monitor-dispatch.sh` のプロセスが存在しない（`cat .dispatch/.monitor.pid` が無い）
3. agmsg モードで子タスク完了 → 親セッションに agmsg push で `[dispatch] task "<slug>" finished (status: done)` が届く
4. workspace レイアウト + `prewarm` 未設定（default true）→ 各タスク workspace に `<slug>-sonnet` tab が現れる（codex runner 登録時は `<slug>-codex` も）
5. Phase B で sonnet 選択 → 待機 tab で実装が始まり、完了後 `/exit` → status.json が `done`、親に通知が届く
6. Phase B で opus 1m 選択 → standby tab が閉じ、`.dispatch/<slug>/status.json` の status が巻き戻らない
7. `--layout split` → standby tab は作られず、Phase B は従来の spawn 経路になる

- [ ] **Step 3: バージョン更新の確認**

`apps/cmux-team-dispatch-task/.claude-plugin/plugin.json` の `version` を minor bump し、ルート `.claude-plugin/marketplace.json` の対応 `version` を同期する（リポジトリ規約）:

```bash
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins
jq '.version' apps/cmux-team-dispatch-task/.claude-plugin/plugin.json
# 現在値を確認し、minor を +1 した値で両ファイルを更新
git add apps/cmux-team-dispatch-task/.claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "chore(cmux-team-dispatch-task): version bump (message_type + pre-warm)"
```
