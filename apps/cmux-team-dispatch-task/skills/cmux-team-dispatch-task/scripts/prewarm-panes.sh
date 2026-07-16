#!/bin/bash
# Pre-warm standby panes: タスク workspace に standby ペイン群を事前起動する
# (--review-model 無し: 縦積み 上 opus / 中 sonnet / 下 codex。
#  --review-model 有り: 2×2 グリッド 左上 opus / 右上 codex review / 左下 sonnet / 右下 codex)
#
# Usage:
#   send-message モード (opus は通常フローで起動済み。sonnet / codex の split のみ追加):
#     prewarm-panes.sh --workspace <ws-id> --base-surface <sf-id> \
#       --cwd <worktree> --slug <task-slug> --status-dir <dir> \
#       [--codex-runner <name>] \
#       [--review-model <model>] \
#       [--parent-notify-workspace <ws-id>] [--parent-notify-surface <sf-id>]
#
#   agmsg モード (workspace 未作成の状態で呼ぶ。opus も standby 起動し workspace はこのスクリプトが作成):
#     prewarm-panes.sh --with-opus \
#       --cwd <worktree> --slug <task-slug> --status-dir <dir> \
#       --message-type agmsg --agmsg-team <team> \
#       [--codex-runner <name>] \
#       [--review-model <model>] \
#       [--parent-notify-workspace <ws-id>] [--parent-notify-surface <sf-id>]
#
# 注意: --message-type agmsg を --with-opus なしで渡す組み合わせは SKILL からは使用しない
#       (sonnet/codex 配線のみ行いたい特殊用途向け)
#
# 内部処理:
#   1. worktree を create-or-reuse (agmsg 配線より先にディレクトリが必要)
#   2. (agmsg 時) join.sh + delivery.sh set を「ペイン起動前に」実行。
#      配線に失敗したペインは delivery: "cmux-send" として記録 (die しない)
#   3. (--with-opus 時) opus-1m standby を workspace 配置で起動 (メイン surface が opus ペイン)
#   4. sonnet / codex を split で配置 (--review-model 有りなら 2×2、無しなら縦積み)
#   4.5 (--review-model 時) codex review ペインを opus の右に split 配置
#   5. <STATUS_DIR>/prewarm.json を書き込む (review キーは --review-model 時のみ)
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
REVIEW_MODEL=""
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
    --review-model)
      [[ $# -lt 2 ]] && die "--review-model requires a model name"
      REVIEW_MODEL="$2"; shift 2 ;;
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

if [[ -n "$REVIEW_MODEL" && -z "$CODEX_RUNNER" ]]; then
  die "--review-model requires --codex-runner"
fi

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
REVIEW_DELIVERY="cmux-send"

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

  if [[ -n "$REVIEW_MODEL" ]]; then
    # review ペインも codex セッション。delivery 配線 (delivery.sh set) は worktree × type 単位
    # なので codex standby の結果を共有する。join は agent 名の登録のために別途必要
    if bash "$AGMSG_DIR/join.sh" "$AGMSG_TEAM" "$SLUG-review" codex "$CWD" >&2 2>/dev/null; then
      REVIEW_DELIVERY="$CODEX_DELIVERY"
    else
      log "agmsg" "review join failed (shim not installed?); falling back to cmux-send"
    fi
  fi
fi

# --- Step 3: opus-1m standby (agmsg モードのみ、workspace 配置) ---

OPUS_SURFACE=""

if [[ $WITH_OPUS -eq 1 ]]; then
  # actas で identity を claim してから待機する。タスク本文は含めない (後から届く)。
  # タスクは常に typed prompt で届く (agmsg push は idle セッションを起こせないため
  # wake チャネルにはならない — inbox には同一コピーが記録として残るだけ)。
  # 配線失敗 (CLAUDE_DELIVERY=cmux-send) のときは actas/watcher が不要なためスキップする
  if [[ "$CLAUDE_DELIVERY" == "agmsg" ]]; then
    OPUS_PROMPT="/agmsg actas $SLUG then wait idle. Your task will arrive as a prompt typed into this pane; an identical copy is also pushed to your agmsg inbox (treat both as ONE task — ignore the duplicate). Do not start any work until the task prompt arrives."
  else
    OPUS_PROMPT="Wait idle. Your task will be typed directly into this pane as a prompt. Do not start any work until it arrives."
  fi
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
  WORKSPACE=$(echo "$OPUS_RESULT" | jq -r '.workspace_id // empty')
  OPUS_SURFACE=$(echo "$OPUS_RESULT" | jq -r '.surface_id // empty')
  BASE_SURFACE="$OPUS_SURFACE"
  [[ -n "$WORKSPACE" && -n "$OPUS_SURFACE" ]] || die "failed to parse opus standby output"
fi

# --- Step 4: sonnet standby (常に、split 配置) ---

SONNET_PROMPT=""
AGMSG_FLAGS_SONNET=()
if [[ "$MESSAGE_TYPE" == "agmsg" ]]; then
  # opus と同じ理由で delivery に応じて出し分ける (cmux-send フォールバック時は actas しない)
  if [[ "$CLAUDE_DELIVERY" == "agmsg" ]]; then
    SONNET_PROMPT="/agmsg actas $SLUG-sonnet then wait idle. Execution instructions will arrive as a prompt typed into this pane; an identical copy is also pushed to your agmsg inbox (treat both as ONE task — ignore the duplicate). Do not start any work until the instructions arrive."
  else
    SONNET_PROMPT="Wait idle. Execution instructions will be typed directly into this pane as a prompt. Do not start any work until they arrive."
  fi
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
SONNET_SURFACE=$(echo "$SONNET_RESULT" | jq -r '.surface_id // empty')
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
  CODEX_DIRECTION_FLAGS=()
  [[ -n "$REVIEW_MODEL" ]] && CODEX_DIRECTION_FLAGS=(--standby-split-direction right)
  log "prewarm" "launching codex standby pane for $SLUG"
  CODEX_RESULT=$(bash "$SCRIPT_DIR/launch-workspace.sh" \
    --cwd "$CWD" \
    --mode standby \
    --standby-in "$WORKSPACE" \
    --standby-split-from "$SONNET_SURFACE" \
    ${CODEX_DIRECTION_FLAGS[@]+"${CODEX_DIRECTION_FLAGS[@]}"} \
    --runner "$CODEX_RUNNER" \
    --status-dir "$STATUS_DIR" \
    ${NOTIFY_FLAGS[@]+"${NOTIFY_FLAGS[@]}"} \
    ${AGMSG_FLAGS_CODEX[@]+"${AGMSG_FLAGS_CODEX[@]}"} \
    "$SLUG-codex") || die "failed to launch codex standby pane"
  CODEX_SURFACE=$(echo "$CODEX_RESULT" | jq -r '.surface_id // empty')
  [[ -n "$CODEX_SURFACE" ]] || die "failed to parse codex standby output"
fi

# --- Step 5.5: codex review ペイン (--review-model 時のみ、opus の右に split 配置) ---
# standby と同じ wrapper だが .assigned-<slug>-review は誰も touch しない前提 —
# close しても status.json を汚さない。初期 prompt は codex standby と同じく常に無し。

REVIEW_SURFACE=""

if [[ -n "$REVIEW_MODEL" ]]; then
  log "prewarm" "launching codex review pane for $SLUG"
  REVIEW_RESULT=$(bash "$SCRIPT_DIR/launch-workspace.sh" \
    --cwd "$CWD" \
    --mode review \
    --standby-in "$WORKSPACE" \
    --standby-split-from "$BASE_SURFACE" \
    --standby-split-direction right \
    --runner "$CODEX_RUNNER" \
    --model "$REVIEW_MODEL" \
    --status-dir "$STATUS_DIR" \
    ${NOTIFY_FLAGS[@]+"${NOTIFY_FLAGS[@]}"} \
    "$SLUG-review") || die "failed to launch codex review pane"
  REVIEW_SURFACE=$(echo "$REVIEW_RESULT" | jq -r '.surface_id // empty')
  [[ -n "$REVIEW_SURFACE" ]] || die "failed to parse review pane output"
fi

# --- Step 6: prewarm.json 書き込み + 出力 ---

mkdir -p "$STATUS_DIR"
PREWARM_JSON=$(jq -n \
  --arg os "$OPUS_SURFACE" \
  --arg ss "$SONNET_SURFACE" \
  --arg cs "$CODEX_SURFACE" \
  --arg rs "$REVIEW_SURFACE" \
  --arg slug "$SLUG" \
  --arg dc "$CLAUDE_DELIVERY" \
  --arg dx "$CODEX_DELIVERY" \
  --arg dr "$REVIEW_DELIVERY" \
  '(if $os != "" then {opus: {surface_id: $os, agent: $slug, delivery: $dc}} else {} end)
   + {sonnet: {surface_id: $ss, agent: ($slug + "-sonnet"), delivery: $dc}}
   + (if $cs != "" then {codex: {surface_id: $cs, agent: ($slug + "-codex"), delivery: $dx}} else {} end)
   + (if $rs != "" then {review: {surface_id: $rs, agent: ($slug + "-review"), delivery: $dr}} else {} end)')
echo "$PREWARM_JSON" > "$STATUS_DIR/prewarm.json"
log "prewarm" "wrote $STATUS_DIR/prewarm.json"

# agmsg prewarm 経路では通常 launch が走らないため、観測用の初期 status.json をここで書く
# (standby wrapper は .assigned-<name> が無い限り status.json を書かないので、上書きの心配はない)
if [[ $WITH_OPUS -eq 1 && ! -f "$STATUS_DIR/status.json" ]]; then
  jq -n --arg ws "$WORKSPACE" --arg sf "$OPUS_SURFACE" \
    '{status: "launched", workspace_id: $ws, surface_id: $sf,
      message: "agmsg prewarm panes launched (idle)", timestamp: (now | todate)}' \
    > "$STATUS_DIR/status.json"
  log "prewarm" "wrote initial launched status.json"
fi

jq -n --arg ws "$WORKSPACE" --argjson panes "$PREWARM_JSON" \
  '{workspace_id: $ws, panes: $panes}'
