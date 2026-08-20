#!/bin/bash
set -uo pipefail

CMUX="/Applications/cmux.app/Contents/Resources/bin/cmux"
SEND_PROMPT="/Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins/apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/send-prompt.sh"
STATUS_DIR="/Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins/.dispatch/setup-model-effort"
SLUG="setup-model-effort-review"
DEFER_STATUS="0"
STANDBY="1"
AGMSG_SEND="/Users/yui/.agents/skills/agmsg/scripts/send.sh"
AGMSG_TEAM="dispatch-yui-cc-plugins"
AGMSG_FROM="setup-model-effort-review"
TIMEOUT_SENTINEL=""

# Resolve the workspace / surface IDs we are running inside.
# cmux normally exports CMUX_WORKSPACE_ID and CMUX_SURFACE_ID into spawned shells;
# if they are missing, fall back to `cmux identify`.
WORKSPACE_ID="${CMUX_WORKSPACE_ID:-}"
SURFACE_ID="${CMUX_SURFACE_ID:-}"
if [[ -z "$WORKSPACE_ID" || -z "$SURFACE_ID" ]]; then
  _IDENT=$("$CMUX" identify 2>/dev/null || true)
  if [[ -n "$_IDENT" ]]; then
    [[ -z "$WORKSPACE_ID" ]] && WORKSPACE_ID=$(echo "$_IDENT" | jq -r '.caller.workspace_ref // empty' 2>/dev/null || echo "")
    [[ -z "$SURFACE_ID" ]]   && SURFACE_ID=$(echo "$_IDENT"   | jq -r '.caller.surface_ref // empty'   2>/dev/null || echo "")
  fi
fi

write_status() {
  local status="$1"
  local message="$2"
  if [[ -n "$STATUS_DIR" ]]; then
    mkdir -p "$STATUS_DIR"
    # 子セッションが書いた pr_url を exit 時の上書きで失わないよう引き継ぐ。
    # PR 作成済みかどうかは完了判定の根拠になるため、消してはいけない。
    local PREV_PR_URL=""
    if [[ -f "$STATUS_DIR/status.json" ]]; then
      PREV_PR_URL=$(jq -r '.pr_url // empty' "$STATUS_DIR/status.json" 2>/dev/null || echo "")
    fi
    jq -n --arg s "$status" --arg m "$message" --arg ws "$WORKSPACE_ID" --arg sf "$SURFACE_ID" \
      --arg pr "$PREV_PR_URL" \
      '{status:$s, message:$m, workspace_id:$ws, surface_id:$sf, timestamp:(now|todate)}
       + (if $pr == "" then {} else {pr_url:$pr} end)' \
      > "$STATUS_DIR/status.json"
  fi
}

NOTIFY_WS="2D4ADB77-A086-4A3B-856A-9DF6A27F4AF6"
NOTIFY_SF="EC09FE79-68A5-4606-8A28-C8BABEAF8978"
NOTIFIED_FILE=""
[[ -n "$STATUS_DIR" ]] && NOTIFIED_FILE="$STATUS_DIR/.notified-$SLUG"

# 親へ完了通知を送る。タイプ入力 (常時)・長文のファイル化・Enter 検証は
# send-prompt.sh が受け持つ。agmsg の 3 引数が揃っているときだけ --agmsg-* を渡す
# (inbox 記録は宛先 watcher が生きているときだけ追加で走る。wake 手段ではない)。
notify_parent() {
  local status_label="$1"
  local msg="[dispatch] task \\"$SLUG\\" finished (status: $status_label)"

  local target_flag target_id
  if [[ -n "$NOTIFY_WS" ]]; then
    target_flag="--to-workspace"; target_id="$NOTIFY_WS"
  elif [[ -n "$NOTIFY_SF" ]]; then
    target_flag="--to-surface"; target_id="$NOTIFY_SF"
  else
    return 1
  fi

  local agmsg_args=()
  if [[ -n "$AGMSG_TEAM" && -n "$AGMSG_FROM" ]]; then
    agmsg_args=(--agmsg-team "$AGMSG_TEAM" --agmsg-to parent --agmsg-from "$AGMSG_FROM")
  fi

  # --status-dir は省略可能なため、未指定時は --outbox-dir を渡さない
  # (渡すと send-prompt.sh 側で "$STATUS_DIR/outbox" が文字通り "/outbox" になり、
  # 長文閾値を超えたときに usage エラーで die する)。
  local outbox_args=()
  [[ -n "$STATUS_DIR" ]] && outbox_args=(--outbox-dir "$STATUS_DIR/outbox")

  CMUX_BIN="$CMUX" bash "$SEND_PROMPT" "$target_flag" "$target_id"     ${agmsg_args[@]+"${agmsg_args[@]}"} ${outbox_args[@]+"${outbox_args[@]}"}     --label dispatch-notify -- "$msg" || return 1
  return 0
}

# 同じ status を二度通知しない。通知に成功したときだけ marker を更新するので、
# 失敗したら次の参加者 (watcher の次の poll、または exit パス) が再試行する。
notify_parent_once() {
  local status_label="$1" prev=""
  [[ -n "$NOTIFIED_FILE" && -f "$NOTIFIED_FILE" ]] && prev=$(cat "$NOTIFIED_FILE" 2>/dev/null || echo "")
  [[ "$prev" == "$status_label" ]] && return 0
  "$CMUX" wait-for --signal "$SLUG-done" 2>/dev/null || true
  notify_parent "$status_label" || return 1
  [[ -n "$NOTIFIED_FILE" ]] && printf '%s' "$status_label" > "$NOTIFIED_FILE"
  return 0
}

notify_reviewer_once() {
  local status_label="$1"
  [[ "$status_label" == "error" && -n "$STATUS_DIR" ]] || return 0
  local cfg="$STATUS_DIR/review/code-review.json"
  [[ -f "$cfg" ]] || return 0
  local rsurface rworkspace
  rsurface=$(jq -r '.reviewer_surface // empty' "$cfg" 2>/dev/null || echo "")
  rworkspace=$(jq -r '.reviewer_workspace // empty' "$cfg" 2>/dev/null || echo "")
  [[ -n "$rsurface" ]] || return 0
  local marker="$STATUS_DIR/.notified-reviewer-$SLUG" prev=""
  [[ -f "$marker" ]] && prev=$(cat "$marker" 2>/dev/null || echo "")
  [[ "$prev" == "$status_label" ]] && return 0
  local reason=""
  [[ -f "$STATUS_DIR/status.json" ]] && reason=$(jq -r '.message // empty' "$STATUS_DIR/status.json" 2>/dev/null || echo "")
  local msg="[abort] task $SLUG stopped with status error: $reason"
  local ws_args=()
  [[ -n "$rworkspace" ]] && ws_args=(--to-workspace "$rworkspace")
  CMUX_BIN="$CMUX" bash "$SEND_PROMPT" ${ws_args[@]+"${ws_args[@]}"} --to-surface "$rsurface"     --label abort-reviewer --outbox-dir "$STATUS_DIR/outbox" -- "$msg" || return 1
  printf '%s' "$status_label" > "$marker"
}

# この pane の前回実行が残した通知 marker を消す (pane 世代の分離)。
# runner script は pane 起動ごとに 1 回だけ実行されるため、ここで消せば足りる。
if [[ -n "$STATUS_DIR" ]]; then
  rm -f "$STATUS_DIR/.notified-$SLUG" "$STATUS_DIR/.notified-reviewer-$SLUG"         "$STATUS_DIR/.stop-watcher-$SLUG"
fi

# standby wrapper は起動時に status.json を書かない (同じ STATUS_DIR を Child が使用中のため)
if [[ "$STANDBY" != "1" ]]; then
  write_status "executing" "runner session starting"
fi

# --- status.json watcher ---
# 子が終端 status を書いても TUI が idle のまま残ると、この wrapper は下の
# 子プロセス待ちでブロックしたまま通知に到達しない。そこで子と並行して
# status.json を poll し、終端遷移を検知した時点で親へ通知する。
# 抑止条件は exit パスの所有権判定と同一。.deferred / .assigned-* は実行中に
# 作られるため poll のたびに再評価する。
# 通知に失敗しても marker を更新しないので、次の poll がそのまま再試行になる。
WATCH_INTERVAL="${CMUX_DISPATCH_WATCH_INTERVAL:-15}"
WATCHER_PID=""
if [[ -n "$STATUS_DIR" ]]; then
  (
    while true; do
      # 停止要求への追随を 1 秒以内にするため、待機は 1 秒刻みに分割する。
      # まとめて sleep すると、短時間で終わる子の exit パスが最大 WATCH_INTERVAL 秒
      # 待たされ、既存の回帰テストも同じだけ遅くなる。
      [[ -f "$STATUS_DIR/.stop-watcher-$SLUG" ]] && exit 0
      _slept=0
      while (( _slept < WATCH_INTERVAL )); do
        sleep 1
        _slept=$(( _slept + 1 ))
        [[ -f "$STATUS_DIR/.stop-watcher-$SLUG" ]] && exit 0
      done

      [[ -n "$TIMEOUT_SENTINEL" && -f "$TIMEOUT_SENTINEL" ]] && continue
      [[ "$DEFER_STATUS" == "1" && -f "$STATUS_DIR/.deferred" ]] && continue
      [[ "$STANDBY" == "1" && ! -f "$STATUS_DIR/.assigned-$SLUG" ]] && continue

      # 所有権を他 pane へ渡した (.assigned → .deferred の間の窓)
      if [[ "$DEFER_STATUS" == "1" ]]; then
        _foreign=0
        for _a in "$STATUS_DIR"/.assigned-*; do
          [[ -e "$_a" ]] || continue
          [[ "$_a" == "$STATUS_DIR/.assigned-$SLUG" ]] || _foreign=1
        done
        (( _foreign )) && continue
      fi

      [[ -f "$STATUS_DIR/status.json" ]] || continue
      _st=$(jq -r '.status // empty' "$STATUS_DIR/status.json" 2>/dev/null || echo "")
      [[ "$_st" == "done" || "$_st" == "error" ]] || continue

      notify_parent_once "$_st" || continue
      notify_reviewer_once "$_st" || continue
      exit 0
    done
  ) &
  WATCHER_PID=$!
fi

SESSION_EXIT=0
zsh -ic "claude --model 'opus[1m]' --effort 'xhigh' --dangerously-skip-permissions"
SESSION_EXIT=$?

# watcher を協調的に停止する。強制 kill は通知の途中で切れる可能性があるため、
# 先に sentinel を置いて自発的な終了を最大 20 秒待ち、それでも残る場合だけ kill する。
if [[ -n "$WATCHER_PID" ]]; then
  [[ -n "$STATUS_DIR" ]] && : > "$STATUS_DIR/.stop-watcher-$SLUG"
  for _i in $(seq 1 20); do
    kill -0 "$WATCHER_PID" 2>/dev/null || break
    sleep 1
  done
  kill "$WATCHER_PID" 2>/dev/null || true
  wait "$WATCHER_PID" 2>/dev/null || true
fi

# ループモード: batch-wait.sh が deadline 超過でこのタスクを terminal 化済みなら、
# 遅れて終了した子が status.json を上書きしたり、cleanup 済みの STATUS_DIR を
# mkdir -p で復活させたりしないよう、ここで何も書かずに終了する。
if [[ -n "$TIMEOUT_SENTINEL" && -f "$TIMEOUT_SENTINEL" ]]; then
  echo "[runner] timeout sentinel found at $TIMEOUT_SENTINEL; skipping status update" >&2
  exit 0
fi

# defer-status: Phase B で別 surface (孫セッション) に実行を移譲した場合、
# Child セッション側の runner wrapper はここで status.json を上書きせず exit する。
# 孫セッションの runner wrapper が status を上書きするのでそちらに任せる。
# Child 側 Claude は exit 前に "<STATUS_DIR>/.deferred" を touch することで意思表示する。
if [[ "$DEFER_STATUS" == "1" && -n "$STATUS_DIR" && -f "$STATUS_DIR/.deferred" ]]; then
  echo "[runner] status update deferred (.deferred sentinel found at $STATUS_DIR/.deferred)" >&2
  exit 0
fi

# standby: .assigned-<workspace-name> sentinel が無ければ実装を引き受けていない。status を
# 書かずに終了する (未使用 standby tab を閉じても status.json を汚さないための仕組み —
# .deferred の逆向き)。ロール別ファイルにすることで、同じ STATUS_DIR を共有する
# sonnet/codex 等の standby 同士が互いの割り当てを誤検知しない
if [[ "$STANDBY" == "1" && ! -f "$STATUS_DIR/.assigned-$SLUG" ]]; then
  echo "[runner] standby exiting without assignment (no .assigned-$SLUG at $STATUS_DIR)" >&2
  exit 0
fi

# 外部から pane を閉じられた場合 (最終クリーンアップの cmux close-surface /
# close-workspace)、子プロセスは signal 由来の終了コード (128+N。SIGHUP=129 /
# SIGKILL=137 / SIGTERM=143) を返す。これはタスクの失敗ではないので、既に
# terminal な status.json が記録済みなら error への降格と偽の完了通知を抑止する。
# status がまだ terminal でない (executing 等) 場合は本当に途中終了なので、
# 従来どおり error を書いて通知する。
PREV_STATUS=""
if [[ -n "$STATUS_DIR" && -f "$STATUS_DIR/status.json" ]]; then
  PREV_STATUS=$(jq -r '.status // empty' "$STATUS_DIR/status.json" 2>/dev/null || echo "")
fi
if [[ $SESSION_EXIT -ge 128 && ( "$PREV_STATUS" == "done" || "$PREV_STATUS" == "error" ) ]]; then
  echo "[runner] terminated by signal (exit $SESSION_EXIT) after terminal status '$PREV_STATUS'; skipping status update and notification" >&2
  exit 0
fi

# 子が書いた終端 status は上書きしない。
# - error: 握り潰すと ABORT プロトコル (status error を書いてセッション終了) が無効化される
# - done + 正常終了: 子が書いた変更サマリを "runner session completed" で潰さない
# - done + 異常終了: done 宣言後のクラッシュは保守的に error 扱いとして親に調査させる
FINAL_STATUS=""
if [[ "$PREV_STATUS" == "error" ]]; then
  FINAL_STATUS="error"
  echo "[runner] preserving child-written terminal status 'error'" >&2
elif [[ "$PREV_STATUS" == "done" && $SESSION_EXIT -eq 0 ]]; then
  FINAL_STATUS="done"
  echo "[runner] preserving child-written terminal status 'done'" >&2
elif [[ $SESSION_EXIT -eq 0 ]]; then
  write_status "done" "runner session completed (exit 0)"
  FINAL_STATUS="done"
else
  write_status "error" "runner session exited with code $SESSION_EXIT"
  FINAL_STATUS="error"
fi

if [[ -n "$NOTIFY_WS" ]]; then
  "$CMUX" notify --title "Done: $SLUG" \
    --body "Exit code: $SESSION_EXIT" \
    --workspace "$NOTIFY_WS" 2>/dev/null || true
fi

notify_parent_once "$FINAL_STATUS" || \
  echo "[runner] parent notification failed for status '$FINAL_STATUS'" >&2
notify_reviewer_once "$FINAL_STATUS" || \
  echo "[runner] reviewer abort notification failed (best-effort)" >&2
