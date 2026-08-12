#!/bin/zsh
# .dispatch/*/status.json をポーリングし、状態変化を stdout に出力する。
# 全タスクが terminal 状態（done/error）に到達したら cmux send で親に通知して終了。
#
# 使用法:
#   monitor-dispatch.sh [options] <dispatch-dir>
#
# Options:
#   --parent-workspace <id>        親ワークスペース ID
#   --interval <seconds>           ポーリング間隔（default: 10）
#   --heartbeat-interval <seconds> heartbeat 送信間隔（default: 60、0 で無効化）
#   --dispatch-dir <path>          dispatch ディレクトリ（位置引数の代替）
#   --resume                       既存 status.json を読み込んで途中から監視を再開
#   --debug                        シェルトレース有効化 (set -x)
#   --help                         ヘルプ表示
#
# 出力:
#   - 状態変化を "[HH:MM:SS] slug: old_status -> new_status" 形式で stdout に出力
#   - 全 stdout は <dispatch-dir>/.monitor.log にも tee される
#   - PID は <dispatch-dir>/.monitor.pid に書き出される
#   - 親には heartbeat / 完了通知 / 死亡通知 を cmux send + send-key return で送信
#
# Exit:   全タスク完了時に exit 0、異常終了時は親に DIED 通知後に exit 1

set -uo pipefail
setopt NULL_GLOB 2>/dev/null || true

CMUX="/Applications/cmux.app/Contents/Resources/bin/cmux"
SCRIPT_PATH="${(%):-%x}"
SEND_PROMPT="${SCRIPT_PATH:h}/send-prompt.sh"

# --- ヘルパー ---

die() {
  echo "Error: $1" >&2
  exit 1
}

show_help() {
  sed -n '2,/^$/{ s/^# //; s/^#//; p; }' "$SCRIPT_PATH"
  exit 0
}

ts() {
  date +%H:%M:%S
}

# 親に1メッセージを送信する。タイプ入力 (常時)・長文のファイル化・Enter 検証は
# send-prompt.sh が受け持つ (この経路は agmsg を使わないのでタイプ入力のみ)。
# 失敗は silent (|| true)。
send_to_parent() {
  local msg="$1"
  if [[ -n "$PARENT_WORKSPACE" ]]; then
    CMUX_BIN="$CMUX" bash "$SEND_PROMPT" --to-workspace "$PARENT_WORKSPACE" \
      --label dispatch-monitor --outbox-dir "$DISPATCH_DIR/outbox" -- "$msg" 2>/dev/null || true
  fi
}

# 異常終了時に親へ DIED 通知。trap から呼ばれる。
on_exit() {
  local exit_code=$?
  # 正常終了 (exit 0) は無視
  if [[ $exit_code -eq 0 ]]; then
    [[ -f "$PID_FILE" ]] && rm -f "$PID_FILE"
    return
  fi
  send_to_parent "[dispatch-monitor] DIED (exit=$exit_code) — re-launch: zsh $SCRIPT_PATH --dispatch-dir $DISPATCH_DIR --resume"
  [[ -f "$PID_FILE" ]] && rm -f "$PID_FILE"
}

# --- 引数解析 ---

PARENT_WORKSPACE=""
INTERVAL=10
HEARTBEAT_INTERVAL=60
DISPATCH_DIR=""
DEBUG=false
RESUME=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --debug)
      DEBUG=true
      shift
      ;;
    --parent-workspace)
      [[ $# -lt 2 ]] && die "--parent-workspace requires a workspace ID"
      PARENT_WORKSPACE="$2"
      shift 2
      ;;
    # v1.13.0 で削除。レイアウトは常に workspace で、通知先も常に親 workspace。
    --layout|--parent-surface)
      die "$1 was removed: the layout is always 'workspace' and the parent is notified by workspace"
      ;;
    --interval)
      [[ $# -lt 2 ]] && die "--interval requires a number"
      INTERVAL="$2"
      shift 2
      ;;
    --heartbeat-interval)
      [[ $# -lt 2 ]] && die "--heartbeat-interval requires a number"
      HEARTBEAT_INTERVAL="$2"
      shift 2
      ;;
    --dispatch-dir)
      [[ $# -lt 2 ]] && die "--dispatch-dir requires a path"
      DISPATCH_DIR="$2"
      shift 2
      ;;
    --resume)
      RESUME=true
      shift
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

if $DEBUG; then
  set -x
fi

# --- ログ tee 準備 ---
LOG_FILE="$DISPATCH_DIR/.monitor.log"
PID_FILE="$DISPATCH_DIR/.monitor.pid"

# stdout を log file に二重出力（端末にもログにも残す）
exec > >(tee -a "$LOG_FILE") 2>&1

# 起動時の自己 PID を書き出す
echo "$$" > "$PID_FILE"

# 異常終了 / SIGINT / SIGTERM をフックして親に DIED 通知
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "[$(ts)] monitor started (pid=$$, interval=${INTERVAL}s, heartbeat=${HEARTBEAT_INTERVAL}s, resume=$RESUME)"

# --- ポーリングループ ---

typeset -A PREV_STATUS
LOOP_COUNT=0
LAST_HEARTBEAT_EPOCH=$(date +%s)

# --resume の場合、既存の status.json を読んで PREV_STATUS を初期化する
# （既に done/error のタスクには再通知しない）
if $RESUME; then
  for f in "$DISPATCH_DIR"/*/status.json; do
    [[ -f "$f" ]] || continue
    slug=$(basename "$(dirname "$f")")
    task_status=$(jq -r '.status' "$f" 2>/dev/null || echo "unknown")
    PREV_STATUS[$slug]="$task_status"
    echo "[$(ts)] resume: $slug at $task_status (skip re-notification)"
  done
fi

while true; do
  LOOP_COUNT=$((LOOP_COUNT + 1))
  ALL_TERMINAL=true
  TASK_COUNT=0
  DONE_COUNT=0
  ERROR_COUNT=0
  EXECUTING_COUNT=0

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

      # terminal 状態に遷移した場合、親に個別通知
      if [[ "$task_status" == "done" || "$task_status" == "error" ]]; then
        message=$(jq -r '.message // ""' "$f" 2>/dev/null || echo "")
        send_to_parent "[dispatch] task \"$slug\" finished (status: $task_status) - $message"
      fi
    fi

    # terminal 状態のカウント
    case "$task_status" in
      done)      DONE_COUNT=$((DONE_COUNT + 1)) ;;
      error)     ERROR_COUNT=$((ERROR_COUNT + 1)) ;;
      executing) EXECUTING_COUNT=$((EXECUTING_COUNT + 1)); ALL_TERMINAL=false ;;
      *)         ALL_TERMINAL=false ;;
    esac
  done

  # 全タスクが terminal 状態なら通知して終了
  if $ALL_TERMINAL && [[ $TASK_COUNT -gt 0 ]]; then
    echo "[$(ts)] All $TASK_COUNT tasks completed (done: $DONE_COUNT, error: $ERROR_COUNT)"
    send_to_parent "[dispatch-monitor] 全 ${TASK_COUNT} タスクが完了しました (done: ${DONE_COUNT}, error: ${ERROR_COUNT}). Step 3 の Completion へ進んでください。"
    exit 0
  fi

  # heartbeat 送信判定
  if [[ "$HEARTBEAT_INTERVAL" -gt 0 ]]; then
    NOW_EPOCH=$(date +%s)
    ELAPSED=$((NOW_EPOCH - LAST_HEARTBEAT_EPOCH))
    if [[ $ELAPSED -ge $HEARTBEAT_INTERVAL ]]; then
      send_to_parent "[dispatch-monitor] alive | loop=${LOOP_COUNT} | tasks: ${DONE_COUNT} done, ${EXECUTING_COUNT} executing, ${ERROR_COUNT} error (total=${TASK_COUNT}) | next-check ${INTERVAL}s"
      LAST_HEARTBEAT_EPOCH=$NOW_EPOCH
    fi
  fi

  sleep "$INTERVAL"
done
