# pre-warm 縦分割ペイン化 + agmsg 全面配送 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** cmux-team-dispatch-task の pre-warm をタブから縦分割ペイン(上 opus / 中 sonnet / 下 codex)に変更し、agmsg モードでは opus-1m を含む全ペインを idle 起動して Phase A / Phase B のタスク配送を agmsg 経由にする。

**Architecture:** 新設ラッパー `prewarm-panes.sh` が「worktree 作成 → agmsg 配線 → 縦分割ペイン起動 → prewarm.json 書き込み」を1回の呼び出しで決定論的に行う。`launch-workspace.sh` は standby 配置をタブ(`new-surface`)から「split 配置(`new-split down`)」と「workspace 配置(メイン surface で standby 起動)」の2方式に変更する。Phase B の実行指示は `prewarm.json` の `delivery` 値(`agmsg` / `cmux-send`)で送信手段を分岐する。

**Tech Stack:** bash, jq, cmux CLI (`/Applications/cmux.app/Contents/Resources/bin/cmux`), agmsg (`~/.agents/skills/agmsg/scripts/`)

**Spec:** `docs/superpowers/specs/2026-07-14-prewarm-vertical-panes-agmsg-design.md`

## Global Constraints

- ドキュメント・コメント・コミットメッセージは日本語、コード(変数名・関数名・CLI フラグ)は英語
- **4ファイル整合ルール**: SKILL.md / guide-ja.md / README.md / apps/cmux-team-dispatch-task/CLAUDE.md の機能仕様記述は完全一致させる。整合が崩れた状態でコミットしない(ただし本計画ではタスク単位でコミットし、Task 6 完了時点で整合が完成する)
- `apps/cmux-team-dispatch-task/.claude-plugin/plugin.json` の version を更新したらルートの `.claude-plugin/marketplace.json` も同期する(現在どちらも `1.2.0` → `1.3.0` に上げる)
- このプラグインに自動テストランナーは無い。検証は `bash -n`(構文)+ 引数バリデーションの die テスト + 手動 E2E チェックリストで行う
- スクリプトのベースディレクトリ: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/`(以下 `<scripts>` と表記)。ドキュメント: SKILL.md は `<scripts>/../SKILL.md`、guide-ja.md は `<scripts>/../references/guide-ja.md`
- 作業ディレクトリはリポジトリルート `/Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins` を前提とする

---

### Task 1: launch-workspace.sh — standby 配置の変更 + `--model` の quote 修正

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh`

**Interfaces:**
- Produces: `--standby-split-from <surface-id>` オプション(standby split 配置)。standby モードで `--standby-in` 省略時は新規 workspace のメイン surface で standby 起動(workspace 配置)。Task 2 の prewarm-panes.sh がこの両方を呼ぶ。

**背景(このタスクの実装者向け):** 現在 `--mode standby` は既存 workspace に「タブ」(`cmux new-surface --type terminal`)を追加する。これを (a) `cmux new-split down` による縦分割ペイン、(b) 新規 workspace のメイン surface、の2方式に置き換える。タブ配置のコードパスは削除する(消費者は SKILL.md と Task 2 の prewarm-panes.sh のみ)。また `--model 'claude-opus-4-7[1m]'` を渡せるようにするため、`zsh -ic "..."` ラップ内で `[1m]` が zsh の glob として解釈されない quote 修正を行う。

- [ ] **Step 1: ヘッダーコメントの更新**

`launch-workspace.sh` 13-17行目の standby 説明:

```
#                                      standby = pre-warm 待機モード。--standby-in の workspace 内に
#                                      terminal tab を作成して待機セッションを起動する。
#                                      --cwd 必須・prompt 省略可。wrapper は <STATUS_DIR>/.assigned が
#                                      存在するときだけ exit 時に status.json を更新する
#   --standby-in <workspace-id>        standby tab を作成する既存 workspace (--mode standby 時必須)
```

を以下に置き換える:

```
#                                      standby = pre-warm 待機モード。--cwd 必須・prompt 省略可。
#                                      配置は 2 方式: --standby-in + --standby-split-from 指定時は
#                                      既存 workspace 内に縦分割ペイン (new-split down)、両方省略時は
#                                      新規 workspace のメイン surface で待機セッションを起動する。
#                                      wrapper は <STATUS_DIR>/.assigned が存在するときだけ
#                                      exit 時に status.json を更新する
#   --standby-in <workspace-id>        standby ペインを追加する既存 workspace (split 配置時必須)
#   --standby-split-from <surface-id>  縦分割の分割元 surface (split 配置時必須)
```

- [ ] **Step 2: 変数とパーサの追加**

変数宣言部(`STANDBY_IN=""` の直後、84行目付近)に追加:

```bash
STANDBY_SPLIT_FROM=""
```

引数パーサ(`--standby-in` の case の直後、117-121行目付近)に追加:

```bash
    --standby-split-from)
      [[ $# -lt 2 ]] && die "--standby-split-from requires a surface ID"
      STANDBY_SPLIT_FROM="$2"
      shift 2
      ;;
```

- [ ] **Step 3: standby バリデーションの変更**

218-220行目:

```bash
elif [[ "$MODE" == "standby" ]]; then
  [[ -n "$STANDBY_IN" ]] || die "--standby-in is required when --mode is standby"
  [[ -n "$CWD" ]] || die "--cwd is required when --mode is standby (reuse the task worktree)"
```

を以下に置き換える:

```bash
elif [[ "$MODE" == "standby" ]]; then
  [[ -n "$CWD" ]] || die "--cwd is required when --mode is standby (reuse the task worktree)"
  # 配置は 2 方式: --standby-in + --standby-split-from = 既存 workspace 内に縦分割ペイン、
  # 両方省略 = 新規 workspace のメイン surface で standby 起動 (agmsg モードの opus ペイン用)
  if [[ -n "$STANDBY_IN" || -n "$STANDBY_SPLIT_FROM" ]]; then
    [[ -n "$STANDBY_IN" ]] || die "--standby-in is required when --standby-split-from is given"
    [[ -n "$STANDBY_SPLIT_FROM" ]] || die "--standby-split-from is required when --standby-in is given (split placement)"
  fi
```

- [ ] **Step 4: `--model` の quote 修正**

365-367行目:

```bash
if [[ -n "$MODEL" ]]; then
  CLAUDE_EXTRA_FLAGS="--model $MODEL"
fi
```

を以下に置き換える(`zsh -ic "..."` 内で `claude-opus-4-7[1m]` の `[1m]` が glob 展開されて nomatch エラーになるのを防ぐ):

```bash
if [[ -n "$MODEL" ]]; then
  # model 名に [1m] のような glob メタ文字が含まれても zsh -ic 内で展開されないよう quote する
  CLAUDE_EXTRA_FLAGS="--model '$MODEL'"
fi
```

- [ ] **Step 5: Step 5 の standby 分岐をタブ作成から split 作成に置き換え**

561-580行目の standby ブロック:

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

を以下に置き換える(条件に `-n "$STANDBY_IN"` を追加。`--standby-in` 省略の standby は後続の workspace 分岐に落ちて `new-workspace --command` でメイン surface 起動になる):

```bash
if [[ "$MODE" == "standby" && -n "$STANDBY_IN" ]]; then
  # --- Standby Split Placement: 既存 workspace 内に縦分割ペインを追加 ---
  WORKSPACE_ID="$STANDBY_IN"
  TITLE="$WORKSPACE_NAME"

  log "cmux" "creating standby pane (split down from $STANDBY_SPLIT_FROM) in $STANDBY_IN"
  SPLIT_OUTPUT=$("$CMUX" new-split down \
    --workspace "$STANDBY_IN" \
    --surface "$STANDBY_SPLIT_FROM" 2>/dev/null) || die "failed to create standby split pane"
  SURFACE_ID=$(echo "$SPLIT_OUTPUT" | grep -oE 'surface:[0-9]+' | head -1)
  [[ -z "$SURFACE_ID" ]] && die "failed to parse surface ID from split output: $SPLIT_OUTPUT"
  log "cmux" "standby pane surface: $SURFACE_ID"

  "$CMUX" rename-tab --workspace "$STANDBY_IN" --surface "$SURFACE_ID" "$TITLE" 2>/dev/null || \
    log "cmux" "warning: failed to rename tab (non-fatal)"

  wait_for_shell "$SURFACE_ID" || true

  "$CMUX" send --surface "$SURFACE_ID" \
    "cd '$CWD' && bash $RUNNER_SCRIPT_NAME\n" 2>/dev/null || die "failed to send cd+runner command"
  log "cmux" "standby runner command sent"

elif [[ "$LAYOUT" == "workspace" || "$LAYOUT" == "claude-teams" ]]; then
```

注意: 後続の workspace 分岐・Step 6(`"$MODE" != "standby"` ガード)・出力 JSON は変更しない。standby × workspace 配置では workspace 分岐がそのまま `--command "bash $RUNNER_SCRIPT_NAME"` で runner を起動し、TITLE は `[$REPO_NAME] $WORKSPACE_NAME` になる(タスク workspace として正しい)。

- [ ] **Step 6: 構文チェック**

Run: `bash -n apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh`
Expected: 出力なし(exit 0)

- [ ] **Step 7: バリデーションの die テスト**

cmux 到達前に die する引数エラーを確認する(worktree もダミーで良い — バリデーションは `--cwd` 存在チェックより先):

```bash
S=apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh
# split-from だけ指定 → die
bash "$S" --mode standby --cwd /tmp --standby-split-from surface:1 foo 2>&1 | grep -q "standby-in is required" && echo OK1
# standby-in だけ指定 → die
bash "$S" --mode standby --cwd /tmp --standby-in workspace:1 foo 2>&1 | grep -q "standby-split-from is required" && echo OK2
# cwd なし → die
bash "$S" --mode standby foo 2>&1 | grep -q "cwd is required" && echo OK3
```

Expected: `OK1` `OK2` `OK3` がすべて出力される

- [ ] **Step 8: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh
git commit -m "feat(cmux-team-dispatch-task): standby 配置を tab から縦分割 split / workspace の2方式に変更、--model の glob quote 修正"
```

---

### Task 2: prewarm-panes.sh の新規作成

**Files:**
- Create: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh`

**Interfaces:**
- Consumes: Task 1 の `launch-workspace.sh --mode standby`(split 配置: `--standby-in` + `--standby-split-from` / workspace 配置: 両方省略)
- Produces: `prewarm-panes.sh` CLI(下記 Usage)。`<STATUS_DIR>/prewarm.json`(スキーマ: `{opus?: {surface_id, agent, delivery}, sonnet: {...}, codex?: {...}}`、`delivery` は `"agmsg"` | `"cmux-send"`)。stdout に `{workspace_id, panes}` の JSON。SKILL.md(Task 3)がこの CLI と JSON を参照する。

- [ ] **Step 1: スクリプト本体を作成**

`apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh` を以下の内容で作成する:

```bash
#!/bin/bash
# Pre-warm standby panes: タスク workspace に縦分割の standby ペイン群を事前起動する
# (上: opus-1m [agmsg モードのみ] / 中: sonnet / 下: codex [runner 登録時のみ])
#
# Usage:
#   send-message モード (opus は通常フローで起動済み。sonnet / codex の split のみ追加):
#     prewarm-panes.sh --workspace <ws-id> --base-surface <sf-id> \
#       --cwd <worktree> --slug <task-slug> --status-dir <dir> \
#       [--codex-runner <name>] \
#       [--parent-notify-workspace <ws-id>] [--parent-notify-surface <sf-id>]
#
#   agmsg モード (workspace 未作成の状態で呼ぶ。opus も standby 起動し workspace はこのスクリプトが作成):
#     prewarm-panes.sh --with-opus \
#       --cwd <worktree> --slug <task-slug> --status-dir <dir> \
#       --message-type agmsg --agmsg-team <team> \
#       [--codex-runner <name>] \
#       [--parent-notify-workspace <ws-id>] [--parent-notify-surface <sf-id>]
#
# 内部処理:
#   1. worktree を create-or-reuse (agmsg 配線より先にディレクトリが必要)
#   2. (agmsg 時) join.sh + delivery.sh set を「ペイン起動前に」実行。
#      配線に失敗したペインは delivery: "cmux-send" として記録 (die しない)
#   3. (--with-opus 時) opus-1m standby を workspace 配置で起動 (メイン surface が opus ペイン)
#   4. sonnet / codex を new-split down で縦に積む
#   5. <STATUS_DIR>/prewarm.json を書き込む
#
# Output: JSON to stdout: {workspace_id, panes: {opus?, sonnet, codex?}}
# Debug:  Logs to stderr

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGMSG_DIR="$HOME/.agents/skills/agmsg/scripts"
OPUS_MODEL="claude-opus-4-7[1m]"
SONNET_MODEL="claude-sonnet-4-6"

die() {
  echo "Error: $1" >&2
  exit 1
}

log() {
  echo "[$1] $2" >&2
}

# --- Argument Parsing ---

WORKSPACE=""
BASE_SURFACE=""
CWD=""
SLUG=""
STATUS_DIR=""
CODEX_RUNNER=""
MESSAGE_TYPE="send-message"
AGMSG_TEAM=""
WITH_OPUS=0
NOTIFY_WORKSPACE=""
NOTIFY_SURFACE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --workspace)
      [[ $# -lt 2 ]] && die "--workspace requires a workspace ID"
      WORKSPACE="$2"; shift 2 ;;
    --base-surface)
      [[ $# -lt 2 ]] && die "--base-surface requires a surface ID"
      BASE_SURFACE="$2"; shift 2 ;;
    --cwd)
      [[ $# -lt 2 ]] && die "--cwd requires a path argument"
      CWD="$2"; shift 2 ;;
    --slug)
      [[ $# -lt 2 ]] && die "--slug requires a task slug"
      SLUG="$2"; shift 2 ;;
    --status-dir)
      [[ $# -lt 2 ]] && die "--status-dir requires a path argument"
      STATUS_DIR="$2"; shift 2 ;;
    --codex-runner)
      [[ $# -lt 2 ]] && die "--codex-runner requires a runner name"
      CODEX_RUNNER="$2"; shift 2 ;;
    --message-type)
      [[ $# -lt 2 ]] && die "--message-type requires send-message or agmsg"
      MESSAGE_TYPE="$2"
      [[ "$MESSAGE_TYPE" == "send-message" || "$MESSAGE_TYPE" == "agmsg" ]] \
        || die "--message-type must be 'send-message' or 'agmsg'"
      shift 2 ;;
    --agmsg-team)
      [[ $# -lt 2 ]] && die "--agmsg-team requires a team name"
      AGMSG_TEAM="$2"; shift 2 ;;
    --with-opus)
      WITH_OPUS=1; shift ;;
    --parent-notify-workspace)
      [[ $# -lt 2 ]] && die "--parent-notify-workspace requires a workspace ID"
      NOTIFY_WORKSPACE="$2"; shift 2 ;;
    --parent-notify-surface)
      [[ $# -lt 2 ]] && die "--parent-notify-surface requires a surface ID"
      NOTIFY_SURFACE="$2"; shift 2 ;;
    *)
      die "unknown option: $1" ;;
  esac
done

# --- Validation ---

[[ -n "$CWD" ]] || die "--cwd is required"
[[ -n "$SLUG" ]] || die "--slug is required"
[[ "$SLUG" =~ ^[A-Za-z0-9._-]+$ ]] || die "invalid slug '$SLUG': use only [A-Za-z0-9._-]"
[[ -n "$STATUS_DIR" ]] || die "--status-dir is required"

if [[ $WITH_OPUS -eq 1 ]]; then
  # agmsg モード専用: workspace はこのスクリプトが作成する
  [[ "$MESSAGE_TYPE" == "agmsg" ]] || die "--with-opus requires --message-type agmsg"
  [[ -z "$WORKSPACE" && -z "$BASE_SURFACE" ]] \
    || die "--with-opus is mutually exclusive with --workspace/--base-surface"
else
  [[ -n "$WORKSPACE" ]] || die "--workspace is required (without --with-opus)"
  [[ -n "$BASE_SURFACE" ]] || die "--base-surface is required (without --with-opus)"
fi

if [[ "$MESSAGE_TYPE" == "agmsg" ]]; then
  [[ -n "$AGMSG_TEAM" ]] || die "--agmsg-team is required when --message-type is agmsg"
  [[ -f "$AGMSG_DIR/send.sh" ]] || die "agmsg is not installed (expected $AGMSG_DIR/send.sh)"
fi

command -v jq &>/dev/null || die "jq is not installed"
command -v git &>/dev/null || die "git is not installed"

# 共通の notify / agmsg フラグ (配列で組み立てて quote 事故を防ぐ)
# 注意: macOS の bash 3.2 は set -u 下で空配列の "${arr[@]}" 展開がエラーになるため、
# 空になりうる配列の展開は必ず ${arr[@]+"${arr[@]}"} イディオムを使う
NOTIFY_FLAGS=()
[[ -n "$NOTIFY_WORKSPACE" ]] && NOTIFY_FLAGS+=(--parent-notify-workspace "$NOTIFY_WORKSPACE")
[[ -n "$NOTIFY_SURFACE" ]] && NOTIFY_FLAGS+=(--parent-notify-surface "$NOTIFY_SURFACE")

# --- Step 1: worktree create-or-reuse ---
# agmsg 配線 (settings.local.json への hook 注入) が worktree ディレクトリを必要とするため、
# launch-workspace.sh に任せず先に作成する (ロジックは launch-workspace.sh と同一)。

if [[ -d "$CWD" ]]; then
  log "worktree" "already exists at $CWD, reusing"
else
  BRANCH_NAME="feat/$SLUG"
  log "worktree" "creating $CWD with branch $BRANCH_NAME"
  if ! git worktree add "$CWD" -b "$BRANCH_NAME" 2>/dev/null; then
    git worktree add "$CWD" "$BRANCH_NAME" 2>/dev/null || die "failed to create worktree at $CWD"
  fi
fi

# --- Step 2: agmsg 配線 (ペイン起動前) ---
# delivery.sh set は worktree 相対の未追跡ファイル (.claude/settings.local.json /
# .codex/hooks.json) に SessionStart hook を注入する。セッション起動前に実行しないと
# hook が効かないため、必ずこの位置で行う。失敗したペインは cmux-send にフォールバック。

CLAUDE_DELIVERY="cmux-send"
CODEX_DELIVERY="cmux-send"

if [[ "$MESSAGE_TYPE" == "agmsg" ]]; then
  if [[ $WITH_OPUS -eq 1 ]]; then
    bash "$AGMSG_DIR/join.sh" "$AGMSG_TEAM" "$SLUG" claude-code "$CWD" >&2 \
      || die "agmsg join failed for agent $SLUG"
  fi
  bash "$AGMSG_DIR/join.sh" "$AGMSG_TEAM" "$SLUG-sonnet" claude-code "$CWD" >&2 \
    || die "agmsg join failed for agent $SLUG-sonnet"
  if bash "$AGMSG_DIR/delivery.sh" set monitor claude-code "$CWD" >&2; then
    CLAUDE_DELIVERY="agmsg"
  else
    log "agmsg" "claude-code delivery wiring failed; falling back to cmux-send"
  fi

  if [[ -n "$CODEX_RUNNER" ]]; then
    # codex は shim 未導入だと join / delivery が失敗しうる。失敗しても die せず
    # cmux-send フォールバックとして記録する (完了通知用に claude-code type で join を試す)
    if bash "$AGMSG_DIR/join.sh" "$AGMSG_TEAM" "$SLUG-codex" codex "$CWD" >&2 2>/dev/null; then
      if bash "$AGMSG_DIR/delivery.sh" set monitor codex "$CWD" >&2 2>/dev/null; then
        CODEX_DELIVERY="agmsg"
      else
        log "agmsg" "codex delivery wiring failed; falling back to cmux-send"
      fi
    else
      log "agmsg" "codex join failed (shim not installed?); falling back to cmux-send"
      bash "$AGMSG_DIR/join.sh" "$AGMSG_TEAM" "$SLUG-codex" claude-code "$CWD" >&2 || true
    fi
  fi
fi

# --- Step 3: opus-1m standby (agmsg モードのみ、workspace 配置) ---

OPUS_SURFACE=""

if [[ $WITH_OPUS -eq 1 ]]; then
  # actas で identity を claim してから待機する。タスク本文は含めない (後から agmsg で届く)
  OPUS_PROMPT="/agmsg actas $SLUG then wait idle. Your task will arrive as an agmsg message. Do not start any work until a task message arrives."
  log "prewarm" "launching opus standby workspace for $SLUG"
  OPUS_RESULT=$(bash "$SCRIPT_DIR/launch-workspace.sh" \
    --cwd "$CWD" \
    --mode standby \
    --defer-status \
    --model "$OPUS_MODEL" \
    --status-dir "$STATUS_DIR" \
    ${NOTIFY_FLAGS[@]+"${NOTIFY_FLAGS[@]}"} \
    --message-type agmsg --agmsg-team "$AGMSG_TEAM" --agmsg-from "$SLUG" \
    "$SLUG" "$OPUS_PROMPT") || die "failed to launch opus standby workspace"
  WORKSPACE=$(echo "$OPUS_RESULT" | jq -r '.workspace_id')
  OPUS_SURFACE=$(echo "$OPUS_RESULT" | jq -r '.surface_id')
  BASE_SURFACE="$OPUS_SURFACE"
  [[ -n "$WORKSPACE" && -n "$OPUS_SURFACE" ]] || die "failed to parse opus standby output"
fi

# --- Step 4: sonnet standby (常に、split 配置) ---

SONNET_PROMPT=""
AGMSG_FLAGS_SONNET=()
if [[ "$MESSAGE_TYPE" == "agmsg" ]]; then
  SONNET_PROMPT="/agmsg actas $SLUG-sonnet then wait idle. Execution instructions will arrive as an agmsg message. Do not start any work until they arrive."
  AGMSG_FLAGS_SONNET=(--message-type agmsg --agmsg-team "$AGMSG_TEAM" --agmsg-from "$SLUG-sonnet")
fi

log "prewarm" "launching sonnet standby pane for $SLUG"
SONNET_ARGS=(
  --cwd "$CWD"
  --mode standby
  --standby-in "$WORKSPACE"
  --standby-split-from "$BASE_SURFACE"
  --model "$SONNET_MODEL"
  --skip-permissions
  --status-dir "$STATUS_DIR"
)
SONNET_RESULT=$(bash "$SCRIPT_DIR/launch-workspace.sh" \
  "${SONNET_ARGS[@]}" \
  ${NOTIFY_FLAGS[@]+"${NOTIFY_FLAGS[@]}"} \
  ${AGMSG_FLAGS_SONNET[@]+"${AGMSG_FLAGS_SONNET[@]}"} \
  "$SLUG-sonnet" ${SONNET_PROMPT:+"$SONNET_PROMPT"}) || die "failed to launch sonnet standby pane"
SONNET_SURFACE=$(echo "$SONNET_RESULT" | jq -r '.surface_id')
[[ -n "$SONNET_SURFACE" ]] || die "failed to parse sonnet standby output"

# --- Step 5: codex standby (runner 登録時のみ、sonnet の下に split 配置) ---
# codex は idle でも agmsg push を受けられる保証が無いため初期 prompt は常に無し。
# 実行指示の配送手段は CODEX_DELIVERY (prewarm.json) で分岐する。

CODEX_SURFACE=""

if [[ -n "$CODEX_RUNNER" ]]; then
  AGMSG_FLAGS_CODEX=()
  if [[ "$MESSAGE_TYPE" == "agmsg" ]]; then
    AGMSG_FLAGS_CODEX=(--message-type agmsg --agmsg-team "$AGMSG_TEAM" --agmsg-from "$SLUG-codex")
  fi
  log "prewarm" "launching codex standby pane for $SLUG"
  CODEX_RESULT=$(bash "$SCRIPT_DIR/launch-workspace.sh" \
    --cwd "$CWD" \
    --mode standby \
    --standby-in "$WORKSPACE" \
    --standby-split-from "$SONNET_SURFACE" \
    --runner "$CODEX_RUNNER" \
    --status-dir "$STATUS_DIR" \
    ${NOTIFY_FLAGS[@]+"${NOTIFY_FLAGS[@]}"} \
    ${AGMSG_FLAGS_CODEX[@]+"${AGMSG_FLAGS_CODEX[@]}"} \
    "$SLUG-codex") || die "failed to launch codex standby pane"
  CODEX_SURFACE=$(echo "$CODEX_RESULT" | jq -r '.surface_id')
  [[ -n "$CODEX_SURFACE" ]] || die "failed to parse codex standby output"
fi

# --- Step 6: prewarm.json 書き込み + 出力 ---

mkdir -p "$STATUS_DIR"
PREWARM_JSON=$(jq -n \
  --arg os "$OPUS_SURFACE" \
  --arg ss "$SONNET_SURFACE" \
  --arg cs "$CODEX_SURFACE" \
  --arg slug "$SLUG" \
  --arg dc "$CLAUDE_DELIVERY" \
  --arg dx "$CODEX_DELIVERY" \
  '(if $os != "" then {opus: {surface_id: $os, agent: $slug, delivery: $dc}} else {} end)
   + {sonnet: {surface_id: $ss, agent: ($slug + "-sonnet"), delivery: $dc}}
   + (if $cs != "" then {codex: {surface_id: $cs, agent: ($slug + "-codex"), delivery: $dx}} else {} end)')
echo "$PREWARM_JSON" > "$STATUS_DIR/prewarm.json"
log "prewarm" "wrote $STATUS_DIR/prewarm.json"

jq -n --arg ws "$WORKSPACE" --argjson panes "$PREWARM_JSON" \
  '{workspace_id: $ws, panes: $panes}'
```

作成後に実行権限を付与する:

```bash
chmod +x apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh
```

- [ ] **Step 2: 構文チェック**

Run: `bash -n apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh`
Expected: 出力なし(exit 0)

- [ ] **Step 3: バリデーションの die テスト**

```bash
P=apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh
bash "$P" 2>&1 | grep -q -- "--cwd is required" && echo OK1
bash "$P" --cwd /tmp --slug foo --status-dir /tmp/s 2>&1 | grep -q -- "--workspace is required" && echo OK2
bash "$P" --with-opus --cwd /tmp --slug foo --status-dir /tmp/s 2>&1 | grep -q -- "--with-opus requires --message-type agmsg" && echo OK3
bash "$P" --with-opus --cwd /tmp --slug foo --status-dir /tmp/s --message-type agmsg 2>&1 | grep -q -- "--agmsg-team is required" && echo OK4
bash "$P" --with-opus --workspace workspace:1 --cwd /tmp --slug foo --status-dir /tmp/s --message-type agmsg --agmsg-team t 2>&1 | grep -q "mutually exclusive" && echo OK5
```

Expected: `OK1` `OK2` `OK3` `OK4` `OK5` がすべて出力される

- [ ] **Step 4: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh
git commit -m "feat(cmux-team-dispatch-task): prewarm-panes.sh を新設 — 縦分割 standby ペイン起動と agmsg 配線を1コマンドに集約"
```

---

### Task 3: SKILL.md の更新

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md`

**Interfaces:**
- Consumes: Task 2 の `prewarm-panes.sh` CLI と `prewarm.json` スキーマ(`delivery` フィールド含む)
- Produces: guide-ja.md / README.md / CLAUDE.md(Task 4-5)が同期すべき SoT テキスト

**編集箇所は5つ。行番号は Task 1-2 実施前の現行ファイル基準(セクション見出しで探すこと)。**

- [ ] **Step 1: 「Pre-warm Standby Tabs (workspace layout only)」セクション(714行目付近)を全面書き換え**

見出しから「Split / claude-teams layouts and `prewarm: false` skip this section entirely — Phase B falls back to the on-demand `--mode execute` spawn.」までを、以下に置き換える:

````markdown
### Pre-warm Standby Panes (workspace layout only)

Read `prewarm` from config (same precedence as `message_type`; default `true`):

```bash
PREWARM=$(jq -r '.prewarm // empty' .dispatch/config.json 2>/dev/null)
[[ -z "$PREWARM" ]] && PREWARM=$(jq -r '.prewarm // "true"' \
  ~/.claude/cmux-team-dispatch-task/config.json 2>/dev/null)
[[ -z "$PREWARM" ]] && PREWARM=true
```

When layout is `workspace` AND `PREWARM` is `true`, standby panes are stacked
vertically inside each task workspace (top: opus / middle: sonnet / bottom:
codex — codex only when `runners.json` has an `engine: "codex"` runner).
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
  --message-type agmsg --agmsg-team "$TEAM" \
  --parent-notify-workspace "$CMUX_WORKSPACE_ID" \
  --parent-notify-surface "$CMUX_SURFACE_ID")
```

Then dispatch the Phase A task to the opus pane:

1. Write the full task prompt (including PROGRESS REPORTING FORMAT and the
   MANDATORY MODEL SELECTION SEQUENCE blocks) to
   `<repo-root>/.worktrees/<task-slug>/.cmux-team-dispatch-task-prompt.md`.
2. `touch .dispatch/<task-slug>/.assigned` — the opus standby wrapper owns
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
`codex` only when a codex runner exists; `delivery` is `"agmsg"` or
`"cmux-send"` depending on whether delivery wiring succeeded):

```json
{
  "opus":   { "surface_id": "surface:N", "agent": "<slug>",        "delivery": "agmsg" },
  "sonnet": { "surface_id": "surface:N", "agent": "<slug>-sonnet", "delivery": "agmsg" },
  "codex":  { "surface_id": "surface:N", "agent": "<slug>-codex",  "delivery": "cmux-send" }
}
```

Split / claude-teams layouts and `prewarm: false` skip this section entirely —
Phase B falls back to the on-demand `--mode execute` spawn, and in agmsg mode
the opus session falls back to the traditional prompt-embedded launch
("Launch: Workspace Mode" as-is).
````

- [ ] **Step 2: Phase B の sonnet 分岐(488-511行目付近)の書き換え**

`[DIFFERENT MODEL] "sonnet" → FIRST check for a pre-warmed standby tab:` のブロック内、手順 1-4 のうち **手順 3 のみ** を以下に置き換える(1, 2, 4 は「tab」→「pane」の語句置換のみ。`REGARDLESS of MESSAGE_TYPE` の説明文を削除する):

```
3. Send the execution request. Check `.sonnet.delivery` in prewarm.json:
     DELIVERY=$(jq -r '.sonnet.delivery // "cmux-send"' "$PREWARM_FILE")
     REQUEST_TEXT="Read and execute the plan at <PLAN_FILE_PATH>. After all work is
     committed/pushed and the PR is created (or all changes are merged per
     the plan), run /exit to close this session. Do not leave it idle."
   IF DELIVERY == "agmsg" (the worktree was wired by prewarm-panes.sh):
     ~/.agents/skills/agmsg/scripts/send.sh "$TEAM" <task-slug> <task-slug>-sonnet "$REQUEST_TEXT"
   ELSE (send-message mode, or wiring failed):
     cmux send --surface "$SONNET_SURFACE" "$REQUEST_TEXT"
     cmux send-key --surface "$SONNET_SURFACE" return
```

また同ブロック冒頭の `FIRST check for a pre-warmed standby tab` を `FIRST check for a pre-warmed standby pane` に、opus 1m 分岐(482-486行目)の `close ALL standby tabs` を `close ALL standby panes` に変更する。

- [ ] **Step 3: Phase B の codex 分岐(`{{CODEX_BEHAVIOR_BLOCK}}`、564-578行目付近)の書き換え**

sonnet と同様に、手順 3 を以下に置き換える(他は「tab」→「pane」置換のみ):

```
3. Send the execution request. Check `.codex.delivery` in prewarm.json:
     DELIVERY=$(jq -r '.codex.delivery // "cmux-send"' "<EXISTING_STATUS_DIR>/prewarm.json")
   IF DELIVERY == "agmsg":
     ~/.agents/skills/agmsg/scripts/send.sh "$TEAM" <task-slug> <task-slug>-codex "$REQUEST_TEXT"
   ELSE:
     cmux send --surface "$CODEX_SURFACE" "$REQUEST_TEXT"
     cmux send-key --surface "$CODEX_SURFACE" return
```

- [ ] **Step 4: Step 2 の agmsg 配線注記(327-334行目付近)に prewarm 経路の注記を追加**

「After each task's worktree exists (launch script returned), register the child:」の join.sh コードブロックの直後に以下を追加する:

```markdown
When the pre-warm path is active (workspace layout + `prewarm: true`), skip
this manual `join.sh` — `prewarm-panes.sh` already joins the opus agent
(`<task-slug>`) and the standby agents (`<task-slug>-sonnet` / `-codex`) and
wires delivery into the worktree before any pane starts.
```

- [ ] **Step 5: 制約 bullet(1461・1464行目付近)と cleanup 文言(1272-1274行目付近)の更新**

(a) 1464行目付近の `- **Pre-warm standby tabs**: ...` bullet 全体を以下に置き換える:

```markdown
- **Pre-warm standby panes**: workspace レイアウト + config `prewarm: true` (default) のとき、`prewarm-panes.sh` が各タスク workspace 内に standby ペインを縦に積む (上: opus / 中: `<slug>-sonnet` / 下: `<slug>-codex` — codex runner 登録時のみ)。agmsg モードでは opus-1m ペインも idle 起動し (`--with-opus`)、worktree への delivery 配線 (join + `delivery.sh set`) をペイン起動前に行ったうえで、Phase A タスクは親から agmsg で送る。standby wrapper は `<STATUS_DIR>/.assigned` が存在するときだけ exit 時に status.json を遷移させる。signal 名は opus が `<slug>-done`、他は `<slug>-sonnet-done` / `<slug>-codex-done`。Phase B の実行指示は prewarm.json の `delivery` 値で分岐する: `"agmsg"` なら `send.sh`、`"cmux-send"` (send-message モード / 配線失敗時) なら `cmux send` + `send-key return`。
```

(b) 1461行目付近の Same-model bullet 内の `a pre-warmed standby tab` を `a pre-warmed standby pane` に変更する。

(c) 1272-1274行目付近の cleanup コメント `# pre-warm standby tab が残っていれば閉じる` を `# pre-warm standby pane が残っていれば閉じる` に変更する(`jq -r '.[].surface_id'` のループは `opus` キーが増えても全 surface を列挙するので変更不要)。

- [ ] **Step 6: 整合確認とコミット**

Run: `grep -n "standby tab\|Standby Tab" apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md`
Expected: マッチなし(全て pane に置換済み)

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md
git commit -m "docs(cmux-team-dispatch-task): SKILL.md — pre-warm 縦分割ペイン化と agmsg 全面配送 (prewarm-panes.sh / delivery 分岐 / opus idle 起動)"
```

---

### Task 4: guide-ja.md の同期

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md`

**Interfaces:**
- Consumes: Task 3 でコミット済みの SKILL.md 新セクション(SoT。対応セクションを日本語で完全に同内容にする)

- [ ] **Step 1: 「Pre-warm Standby Tabs(workspace レイアウトのみ)」セクション(185-253行目付近)を全面書き換え**

見出しを `### Pre-warm Standby Panes(workspace レイアウトのみ)` とし、内容を Task 3 Step 1 の新セクションの日本語版に置き換える。必須要素(SKILL.md と1対1対応):

- `prewarm` config 読み取りの bash ブロック(変更なし、そのまま維持)
- 縦積みレイアウトの説明: 「上: opus / 中: sonnet / 下: codex(codex runner 登録時のみ)。ペイン作成は `prewarm-panes.sh` に委譲し、手動で作成しない」
- **send-message モード**: opus は「Launch: Workspace Mode」で起動済み。`prewarm-panes.sh --workspace <ws> --base-surface <sf> --cwd <worktree> --slug <slug> --status-dir <dir> [--codex-runner <name>] --parent-notify-workspace ... --parent-notify-surface ...` の呼び出し例(Task 3 Step 1 のコードブロックをそのまま)
- **agmsg モード**: 通常の Launch を行わないこと。`prewarm-panes.sh --with-opus ... --message-type agmsg --agmsg-team "$TEAM" ...` の呼び出し例。続けて Phase A タスク配送の手順 1-3(プロンプトファイル書き込み → `.assigned` touch → `.opus.delivery` で agmsg / cmux send 分岐。slash command は agmsg push で発火できないためモードはメッセージ本文で伝える旨も含む)
- prewarm.json スキーマの JSON ブロック(`opus` / `sonnet` / `codex` + `delivery`、Task 3 Step 1 と同一)
- 末尾: split / claude-teams / `prewarm: false` はスキップし、agmsg モードの opus は従来のプロンプト付き起動にフォールバックする旨

- [ ] **Step 2: Phase B 記述の同期**

guide-ja.md 内の Phase B 説明(1012行目付近のモデル選択表と、その周辺の standby 送信手順)について:

- 「standby tab」→「standby ペイン」に置換(930-932行目付近の cleanup コメント含む)
- 実行指示送信の記述を「message_type に関わらず常に `cmux send`」から「prewarm.json の `delivery` 値で分岐(`"agmsg"` → `send.sh "$TEAM" <slug> <slug>-sonnet|-codex "$REQUEST_TEXT"` / `"cmux-send"` → `cmux send` + `send-key return`)」に書き換える(Task 3 Step 2/3 と同内容)

- [ ] **Step 3: config 説明(452-464行目付近)の `prewarm` 記述更新**

`- prewarm: workspace レイアウト時の sonnet/codex standby tab 事前起動。` を以下に置き換える:

```markdown
- `prewarm`: workspace レイアウト時の standby ペイン事前起動(縦積み: 上 opus / 中 sonnet / 下 codex)。agmsg モードでは opus-1m も idle 起動し Phase A タスクを agmsg で配送する。`true`(default)| `false`
```

- [ ] **Step 4: 整合確認とコミット**

Run: `grep -n "standby tab\|Standby Tab" apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md`
Expected: マッチなし

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md
git commit -m "docs(cmux-team-dispatch-task): guide-ja.md を pre-warm 縦分割ペイン + agmsg 配送仕様に同期"
```

---

### Task 5: README.md と CLAUDE.md の同期

**Files:**
- Modify: `apps/cmux-team-dispatch-task/README.md:193-201`
- Modify: `apps/cmux-team-dispatch-task/CLAUDE.md`(メンテナンス手順 13・E2E テスト 18/19・ファイル構成表)

**Interfaces:**
- Consumes: Task 3 の SKILL.md 新仕様

- [ ] **Step 1: README.md の pre-warm セクション(193-201行目)書き換え**

`### Pre-warm standby tab(workspace レイアウト時)` セクションを以下に置き換える:

```markdown
### Pre-warm standby panes(workspace レイアウト時)

config `prewarm: true`(default)のとき、`prewarm-panes.sh` が各タスクの workspace 内に
standby ペインを縦に積んで事前起動する(上: opus / 中: sonnet / 下: codex — codex は
`runners.json` に codex runner があるときのみ)。Phase B で sonnet / codex が選ばれたら
待機中のペインに実行指示を送るだけで済み、セッション起動を待たない。

- send-message モード: opus は従来どおりタスクプロンプト付きで起動し、sonnet / codex のみ
  idle 起動。実行指示は `cmux send` で注入する。
- agmsg モード: opus-1m を含む全ペインをメッセージ未指定(idle)で起動する。
  `prewarm-panes.sh` が worktree への agmsg delivery 配線(join + `delivery.sh set`)を
  ペイン起動前に行い、Phase A の初期タスクも Phase B の実行指示も agmsg で配送する
  (配線に失敗したペインは `cmux send` にフォールバック。prewarm.json の `delivery` 値で分岐)。

split / claude-teams レイアウトや `prewarm: false` では従来の on-demand spawn。
```

- [ ] **Step 2: CLAUDE.md の更新**

(a) ファイル構成表に prewarm-panes.sh の行を追加(`launch-session-splits.sh` の行の直後):

```markdown
| `skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh` | pre-warm standby ペイン一括起動ラッパー(縦分割・agmsg 配線・prewarm.json 生成) |
```

(b) メンテナンス手順 13 を以下に置き換える:

```markdown
13. pre-warm(`prewarm-panes.sh` / `--mode standby` の split・workspace 配置 / `.assigned` sentinel / prewarm.json スキーマ(`opus`・`sonnet`・`codex` + `delivery`)/ signal 名 `<slug>-done`・`<slug>-sonnet-done`・`<slug>-codex-done`)が SKILL.md / guide-ja.md / README.md で一致しているか確認。standby ペインは縦積み(上 opus / 中 sonnet / 下 codex)であること、standby wrapper が起動時・未 assigned exit 時に status.json を書かないこと、agmsg モードでは opus-1m も idle 起動し worktree への delivery 配線をペイン起動前に行うこと、Phase A / Phase B の指示送信が prewarm.json の `delivery` 値(`agmsg` / `cmux-send`)で分岐すること、Phase B の手順が「未使用側 pane を close → `.assigned` touch → 実行指示送信 → `.deferred` touch」の順であることを検証
```

(c) E2E テスト 18 を以下に置き換える:

```markdown
18. **pre-warm**: workspace レイアウトで各タスク workspace が縦分割ペインになること(agmsg モード: 上 opus-1m[idle] / 中 sonnet / 下 codex、send-message モード: 上 opus[タスク実行中] / 中 sonnet / 下 codex。codex runner が無ければ縦2分割)。agmsg モードでは全ペインが idle 起動し、親からの agmsg 送信(`.assigned` touch 後)で Phase A が開始されること。`prewarm: false` / split レイアウトでは起動しないこと。タスク未割り当てのまま workspace を閉じても status.json が汚れないこと
```

(d) E2E テスト 19 の文中の「standby tab」を「standby pane」に置換し、末尾に以下を追加する:

```markdown
実行指示の送信は prewarm.json の `delivery` 値で分岐すること(`agmsg` → `send.sh`、`cmux-send` → `cmux send` + `send-key return`)。codex 配線失敗時に `delivery: "cmux-send"` へフォールバックすること
```

- [ ] **Step 3: 整合確認とコミット**

Run: `grep -rn "standby tab" apps/cmux-team-dispatch-task/README.md apps/cmux-team-dispatch-task/CLAUDE.md`
Expected: マッチなし

```bash
git add apps/cmux-team-dispatch-task/README.md apps/cmux-team-dispatch-task/CLAUDE.md
git commit -m "docs(cmux-team-dispatch-task): README / CLAUDE.md を pre-warm 縦分割ペイン + agmsg 配送仕様に同期"
```

---

### Task 6: version bump と最終整合チェック

**Files:**
- Modify: `apps/cmux-team-dispatch-task/.claude-plugin/plugin.json`(version `1.2.0` → `1.3.0`)
- Modify: `.claude-plugin/marketplace.json`(cmux-team-dispatch-task の version `1.2.0` → `1.3.0`)

- [ ] **Step 1: version bump**

`apps/cmux-team-dispatch-task/.claude-plugin/plugin.json` の `"version": "1.2.0"` を `"version": "1.3.0"` に、`.claude-plugin/marketplace.json` の cmux-team-dispatch-task エントリ(53行目付近)の `"version": "1.2.0"` を `"version": "1.3.0"` に変更する。

- [ ] **Step 2: JSON 妥当性チェック**

Run: `jq . apps/cmux-team-dispatch-task/.claude-plugin/plugin.json > /dev/null && jq . .claude-plugin/marketplace.json > /dev/null && echo OK`
Expected: `OK`

- [ ] **Step 3: 4ファイル整合の最終確認**

以下を実行し、4ファイルすべてで新仕様の記述が揃っていることを確認する:

```bash
# prewarm-panes.sh への言及が SoT 3ファイル + CLAUDE.md にあること
grep -l "prewarm-panes.sh" \
  apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md \
  apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md \
  apps/cmux-team-dispatch-task/README.md \
  apps/cmux-team-dispatch-task/CLAUDE.md | wc -l   # → 4
# delivery 分岐の記述があること
grep -l '"cmux-send"' \
  apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md \
  apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md | wc -l  # → 2
# 旧仕様の残骸が無いこと
grep -rn "standby tab\|Standby Tab" apps/cmux-team-dispatch-task/ --include="*.md" | wc -l    # → 0
```

- [ ] **Step 4: コミット**

```bash
git add apps/cmux-team-dispatch-task/.claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "chore(cmux-team-dispatch-task): version bump 1.3.0 (pre-warm 縦分割ペイン + agmsg 全面配送)"
```

---

### 手動 E2E チェックリスト(cmux セッション内・実装完了後にユーザーと実施)

自動化できない実機確認。`apps/cmux-team-dispatch-task/CLAUDE.md` の E2E テスト 18/19 に準拠:

1. **send-message モード**: 2タスクをディスパッチ → 各 workspace が縦分割(上 opus 実行中 / 中 sonnet idle / 下 codex idle)になること
2. **agmsg モード**: 全ペイン idle 起動 → 親の agmsg send で Phase A 開始 → Phase B で sonnet 選択 → codex ペイン close → 実行指示が agmsg で届くこと
3. **フォールバック**: codex shim 未導入環境で `prewarm.json` の codex.delivery が `cmux-send` になり、実行指示が `cmux send` で届くこと
4. **未使用 close**: タスク未割り当てのまま workspace を閉じ、status.json が `launched` のまま汚れないこと
5. **opus-1m glob**: opus ペインの claude が `--model 'claude-opus-4-7[1m]'` で正常起動すること(zsh の nomatch エラーが出ないこと)
