#!/bin/bash
# terminal-wait.sh — シェル起動検知 + ベースライン値の config 永続化ヘルパー
#
# 提供関数:
#   load_baseline_ms              baseline_ms を stdout に出力（無ければ空）
#   save_sample_ms <ms>           グローバル config に新サンプルを記録し EMA 更新
#   wait_for_shell <surface_id>   シェルプロンプト検知。成功で経過 ms を save_sample_ms に渡す
#
# 呼び出し元で必要な環境:
#   CMUX         cmux バイナリのパス
#   PROJECT_ROOT（任意）プロジェクトルート。プロジェクト config の解決に使う
#   log（任意）  関数。未定義なら内蔵フォールバックを使う

# --- 設定 ---
TERMINAL_WAIT_GLOBAL_CONFIG="$HOME/.claude/cmux-team-dispatch-task/config.json"
TERMINAL_WAIT_EMA_ALPHA_NUM=3   # EMA α = 0.3（×10 で整数演算）
TERMINAL_WAIT_EMA_ALPHA_DEN=10
TERMINAL_WAIT_SAMPLES_MAX=5
TERMINAL_WAIT_DEFAULT_MS=10000  # baseline 未設定時の最大待機
TERMINAL_WAIT_POLL_MS=100       # ポーリング間隔
TERMINAL_WAIT_SAFETY_MULT=3     # baseline の何倍を最大待機にするか

# log 関数フォールバック
if ! declare -F log >/dev/null 2>&1; then
  log() { echo "[$1] $2" >&2; }
fi

# --- 内部ヘルパー ---
_terminal_wait_project_config() {
  # プロジェクト config のパスを解決（PROJECT_ROOT 不在でも CWD からフォールバック）
  local root="${PROJECT_ROOT:-${CWD:-}}"
  [[ -z "$root" ]] && return 0
  echo "$root/.dispatch/config.json"
}

_terminal_wait_read_baseline() {
  local file="$1"
  [[ -f "$file" ]] || return 1
  jq -r '.shell_ready_ms.baseline_ms // empty' "$file" 2>/dev/null
}

# --- Public: load_baseline_ms ---
load_baseline_ms() {
  local proj_cfg
  proj_cfg=$(_terminal_wait_project_config)
  local val=""
  if [[ -n "$proj_cfg" ]]; then
    val=$(_terminal_wait_read_baseline "$proj_cfg" || true)
  fi
  if [[ -z "$val" ]]; then
    val=$(_terminal_wait_read_baseline "$TERMINAL_WAIT_GLOBAL_CONFIG" || true)
  fi
  [[ -n "$val" ]] && echo "$val"
}

# --- Public: save_sample_ms ---
save_sample_ms() {
  local new_ms="$1"
  [[ -z "$new_ms" ]] && return 0
  mkdir -p "$(dirname "$TERMINAL_WAIT_GLOBAL_CONFIG")"

  local existing="{}"
  if [[ -f "$TERMINAL_WAIT_GLOBAL_CONFIG" ]]; then
    existing=$(cat "$TERMINAL_WAIT_GLOBAL_CONFIG" 2>/dev/null || echo "{}")
  fi

  local tmp
  tmp=$(mktemp)
  if echo "$existing" | jq \
    --argjson new "$new_ms" \
    --argjson alpha_num "$TERMINAL_WAIT_EMA_ALPHA_NUM" \
    --argjson alpha_den "$TERMINAL_WAIT_EMA_ALPHA_DEN" \
    --argjson max_samples "$TERMINAL_WAIT_SAMPLES_MAX" \
    '
    .shell_ready_ms = (.shell_ready_ms // {baseline_ms: null, samples: [], updated_at: ""}) |
    .shell_ready_ms.samples = ((.shell_ready_ms.samples // []) + [$new])[-$max_samples:] |
    .shell_ready_ms.baseline_ms = (
      if (.shell_ready_ms.baseline_ms // null) == null then $new
      else (($alpha_num * $new + ($alpha_den - $alpha_num) * .shell_ready_ms.baseline_ms) / $alpha_den | floor)
      end
    ) |
    .shell_ready_ms.updated_at = (now | todate)
    ' > "$tmp" 2>/dev/null; then
    mv "$tmp" "$TERMINAL_WAIT_GLOBAL_CONFIG"
  else
    rm -f "$tmp"
    log "terminal-wait" "warning: failed to update config at $TERMINAL_WAIT_GLOBAL_CONFIG"
  fi
}

# --- Public: wait_for_shell ---
wait_for_shell() {
  local surface_id="$1"
  [[ -z "$surface_id" ]] && { log "terminal-wait" "wait_for_shell: surface_id required"; return 1; }

  local baseline_ms
  baseline_ms=$(load_baseline_ms)

  local max_wait_ms
  if [[ -n "$baseline_ms" && "$baseline_ms" -gt 0 ]]; then
    max_wait_ms=$((baseline_ms * TERMINAL_WAIT_SAFETY_MULT))
    [[ $max_wait_ms -lt $TERMINAL_WAIT_DEFAULT_MS ]] && max_wait_ms=$TERMINAL_WAIT_DEFAULT_MS
    log "terminal-wait" "baseline=${baseline_ms}ms max_wait=${max_wait_ms}ms surface=$surface_id"
  else
    max_wait_ms=$TERMINAL_WAIT_DEFAULT_MS
    log "terminal-wait" "baseline=(unset) max_wait=${max_wait_ms}ms surface=$surface_id"
  fi

  local poll_sec
  poll_sec=$(awk -v ms="$TERMINAL_WAIT_POLL_MS" 'BEGIN{printf "%.3f", ms/1000}')
  local iters=$((max_wait_ms / TERMINAL_WAIT_POLL_MS))
  [[ $iters -lt 1 ]] && iters=1

  local i=0
  local elapsed_ms=0
  local pane_content=""
  while [[ $i -lt $iters ]]; do
    pane_content=$("$CMUX" read-screen --surface "$surface_id" 2>/dev/null || true)
    if echo "$pane_content" | grep -qE '[\$%#❯>]\s*$'; then
      elapsed_ms=$((i * TERMINAL_WAIT_POLL_MS))
      log "terminal-wait" "shell ready after ${elapsed_ms}ms"
      save_sample_ms "$elapsed_ms"
      return 0
    fi
    sleep "$poll_sec"
    i=$((i + 1))
  done

  log "terminal-wait" "warning: shell readiness detection timed out after ${max_wait_ms}ms (proceeding)"
  return 1
}
