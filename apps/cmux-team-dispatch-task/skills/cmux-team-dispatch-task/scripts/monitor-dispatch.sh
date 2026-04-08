#!/bin/zsh
# .dispatch/*/status.json をポーリングし、状態変化を stdout に出力する。
# 全タスクが terminal 状態（done/error）に到達したら cmux send で親に通知して終了。
#
# 使用法:
#   monitor-dispatch.sh [options] <dispatch-dir>
#
# Options:
#   --parent-surface <id>      親サーフェス ID（split モード用）
#   --parent-workspace <id>    親ワークスペース ID（workspace モード用）
#   --layout split|workspace   レイアウトモード（default: split）
#   --interval <seconds>       ポーリング間隔（default: 10）
#   --help                     ヘルプ表示
#
# Output: 状態変化を "[HH:MM:SS] slug: old_status -> new_status" 形式で stdout に出力
# Exit:   全タスク完了時に exit 0

set -euo pipefail
setopt NULL_GLOB 2>/dev/null || true

CMUX="/Applications/cmux.app/Contents/Resources/bin/cmux"

# --- ヘルパー ---

die() {
  echo "Error: $1" >&2
  exit 1
}

show_help() {
  sed -n '2,/^$/{ s/^# //; s/^#//; p; }' "$0"
  exit 0
}

ts() {
  date +%H:%M:%S
}

send_to_parent() {
  local msg="$1"
  if [[ "$LAYOUT" == "split" && -n "$PARENT_SURFACE" ]]; then
    "$CMUX" send --surface "$PARENT_SURFACE" "${msg}\n" 2>/dev/null || true
  elif [[ -n "$PARENT_WORKSPACE" ]]; then
    "$CMUX" send --workspace "$PARENT_WORKSPACE" "${msg}\n" 2>/dev/null || true
  fi
}

# --- 引数解析 ---

PARENT_SURFACE=""
PARENT_WORKSPACE=""
LAYOUT="split"
INTERVAL=10
DISPATCH_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --parent-surface)
      [[ $# -lt 2 ]] && die "--parent-surface requires a surface ID"
      PARENT_SURFACE="$2"
      shift 2
      ;;
    --parent-workspace)
      [[ $# -lt 2 ]] && die "--parent-workspace requires a workspace ID"
      PARENT_WORKSPACE="$2"
      shift 2
      ;;
    --layout)
      [[ $# -lt 2 ]] && die "--layout requires split or workspace"
      LAYOUT="$2"
      shift 2
      ;;
    --interval)
      [[ $# -lt 2 ]] && die "--interval requires a number"
      INTERVAL="$2"
      shift 2
      ;;
    --help)
      show_help
      ;;
    *)
      if [[ -z "$DISPATCH_DIR" ]]; then
        DISPATCH_DIR="$1"
        shift
      else
        die "unexpected argument: $1"
      fi
      ;;
  esac
done

[[ -n "$DISPATCH_DIR" ]] || die "dispatch directory is required"
[[ -d "$DISPATCH_DIR" ]] || die "dispatch directory does not exist: $DISPATCH_DIR"

# --- ポーリングループ ---

typeset -A PREV_STATUS

while true; do
  ALL_TERMINAL=true
  TASK_COUNT=0
  DONE_COUNT=0
  ERROR_COUNT=0

  for f in "$DISPATCH_DIR"/*/status.json; do
    [[ -f "$f" ]] || continue
    slug=$(basename "$(dirname "$f")")
    task_status=$(jq -r '.status' "$f" 2>/dev/null || echo "unknown")

    TASK_COUNT=$((TASK_COUNT + 1))

    # 状態変化を検出
    prev="${PREV_STATUS[$slug]:-}"
    if [[ "$prev" != "$task_status" ]]; then
      if [[ -n "$prev" ]]; then
        echo "[$(ts)] $slug: $prev -> $task_status"
      else
        echo "[$(ts)] $slug: $task_status"
      fi
      PREV_STATUS[$slug]="$task_status"
    fi

    # terminal 状態のカウント
    case "$task_status" in
      done)  DONE_COUNT=$((DONE_COUNT + 1)) ;;
      error) ERROR_COUNT=$((ERROR_COUNT + 1)) ;;
      *)     ALL_TERMINAL=false ;;
    esac
  done

  # 全タスクが terminal 状態なら通知して終了
  if $ALL_TERMINAL && [[ $TASK_COUNT -gt 0 ]]; then
    echo "[$(ts)] All $TASK_COUNT tasks completed (done: $DONE_COUNT, error: $ERROR_COUNT)"
    send_to_parent "[dispatch-monitor] 全 ${TASK_COUNT} タスクが完了しました (done: ${DONE_COUNT}, error: ${ERROR_COUNT}). Step 8 に進んでください。"
    exit 0
  fi

  sleep "$INTERVAL"
done
