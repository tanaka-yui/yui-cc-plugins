#!/usr/bin/env bash
# runner wrapper の終端 status 保持と status.json watcher の動的回帰テスト。
#
# 再現するバグ: 子が status.json に error を書いてセッションを終えても、wrapper が
# 「exit 0 なら done」と無条件に上書きしていたため、error が握り潰されて親には
# `status: done` が通知されていた。
#
# 静的な文言一致ではなく、生成された runner script を実際に実行して検証する。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCH="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/launch-workspace.sh"

TMP=$(mktemp -d)
# 起動した runner を追跡し、異常終了時も「全 stub を解放 → 各 runner を期限付きで
# wait → それでも残るものだけ kill」の順で回収してから temp を消す。
# temp を先に消すと、runner がこれから作る stop-watcher sentinel まで失われ、
# wrapper と watcher が長く残り得る。
RUNNER_PIDS=()
CLEANED=0
cleanup_all() {
  local code="${1:-0}" pid i
  [[ $CLEANED -eq 1 ]] && return
  CLEANED=1
  # 起動済み・起動途中を問わずすべての case を解放する
  for i in "${!CASE_PIDS[@]}"; do : > "$TMP/release-${CASE_LABELS[$i]}" 2>/dev/null || true; done
  if [[ ${#RUNNER_PIDS[@]} -gt 0 ]]; then
    for pid in "${RUNNER_PIDS[@]}"; do
      for i in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
      kill -0 "$pid" 2>/dev/null && kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    done
  fi
  rm -rf "$TMP"
  if [[ "$code" != "0" ]]; then
    exit "$code"
  fi
}
CASE_PIDS=()
CASE_LABELS=()
trap 'cleanup_all 0' EXIT
trap 'cleanup_all 130' INT
trap 'cleanup_all 143' TERM
mkdir -p "$TMP/bin" "$TMP/repo" "$TMP/zdot"
: > "$TMP/zdot/.zshrc"   # ユーザーの .zshrc を読ませない (zsh -ic の副作用を排除)

git -C "$TMP/repo" init -q
git -C "$TMP/repo" config user.email test@example.invalid
git -C "$TMP/repo" config user.name test
touch "$TMP/repo/.gitkeep"
git -C "$TMP/repo" add .gitkeep
git -C "$TMP/repo" commit -qm init

# cmux stub。
# - cmux-attempts.log: 成否によらず send / send-key の呼び出しを記録する
#   (通知の再試行が止まったことを検証するために使う)
# - cmux-calls.log: 成功した呼び出しだけを記録する
# - $TMP/cmux-fail が存在する間は send / send-key を失敗させる
cat > "$TMP/bin/cmux" <<STUB
#!/usr/bin/env bash
case "\$1" in
  new-workspace) echo 'workspace:1' ;;
  list-pane-surfaces) echo 'surface:2' ;;
  send|send-key)
    echo "\$*" >> "$TMP/cmux-attempts.log"
    if [[ -f "$TMP/cmux-fail" ]]; then exit 1; fi
    echo "\$*" >> "$TMP/cmux-calls.log" ;;
  notify) echo "\$*" >> "$TMP/cmux-calls.log" ;;
  rename-workspace|rename-tab|wait-for|identify|new-split) ;;
  *) echo "unexpected cmux command: \$*" >&2; exit 1 ;;
esac
STUB
chmod +x "$TMP/bin/cmux"

# stub runner。
# - STUB_READY:   起動したことを知らせる sentinel
# - STUB_WRITE_STATUS: 起動直後に status.json へ書く値 (子が終端状態を書く再現)
# - STUB_RELEASE: このファイルが現れるまで生存し続ける (子の idle 残留の再現)
# - STUB_EXIT_CODE: release 後の終了コード
#
# 固定 sleep ではなく release sentinel で制御するのが要点。テスト側が wrapper を
# kill すると、wrapper は CLAUDE_EXIT の取得も exit パスも通らない
# (プロセス構造は bash runner → zsh -ic → stub-agent で、signal は伝播しない)。
# stub を自然終了させることで、wrapper が必ず wait → 終了コード確定 → exit パスを通る。
cat > "$TMP/bin/stub-agent" <<'STUB'
#!/usr/bin/env bash
[[ -n "${STUB_READY:-}" ]] && : > "$STUB_READY"
if [[ -n "${STUB_WRITE_STATUS:-}" && -n "${STUB_STATUS_DIR:-}" ]]; then
  jq -n --arg s "$STUB_WRITE_STATUS" '{status:$s, message:"child-written"}' \
    > "$STUB_STATUS_DIR/status.json"
fi
if [[ -n "${STUB_RELEASE:-}" ]]; then
  while [[ ! -f "$STUB_RELEASE" ]]; do sleep 0.2; done
fi
exit "${STUB_EXIT_CODE:-0}"
STUB
chmod +x "$TMP/bin/stub-agent"

cat > "$TMP/runners.json" <<JSON
{
  "default": "stub",
  "runners": [
    { "name": "stub", "command": "$TMP/bin/stub-agent", "engine": "claude" }
  ]
}
JSON

fail=0

assert_eq() {
  local actual="$1" expected="$2" label="$3"
  if [[ "$actual" == "$expected" ]]; then
    echo "PASS: $label"
  else
    echo "FAIL: $label (expected: $expected, got: $actual)"
    fail=1
  fi
}

# 生成された runner script を、子プロセスの終了コードと事前 status を指定して実行する。
# 実行後の status.json と通知ログは $TMP/status-<label> / $TMP/cmux-calls.log に残る。
STATUS_DIR=""
run_case() {
  local label="$1" exit_code="$2" prior_status="$3"
  STATUS_DIR="$TMP/status-$label"
  local name="task-$label"

  rm -rf "$STATUS_DIR" "$TMP/cmux-calls.log" "$TMP/cmux-attempts.log"
  mkdir -p "$STATUS_DIR"
  jq -n --arg s "$prior_status" '{status:$s, message:"child-written"}' > "$STATUS_DIR/status.json"
  touch "$STATUS_DIR/.assigned-$name"

  local output runner
  output=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" bash "$LAUNCH" \
    --cwd "$TMP/repo" --mode standby --runner stub --status-dir "$STATUS_DIR" \
    --parent-notify-workspace 'workspace:9' "$name")
  runner=$(jq -r '.runner_file' <<<"$output")

  ZDOTDIR="$TMP/zdot" STUB_EXIT_CODE="$exit_code" PATH="$TMP/bin:$PATH" \
    bash "$runner" >/dev/null 2>&1 || true
}

status_of()  { jq -r '.status'  "$STATUS_DIR/status.json"; }
message_of() { jq -r '.message' "$STATUS_DIR/status.json"; }
notified_label() {
  grep -oE 'status: (done|error)' "$TMP/cmux-calls.log" 2>/dev/null | tail -1 | sed 's/status: //'
}

# T1: 子が error を書いて正常終了 → error が保持され、親通知も error
run_case error-exit0 0 error
assert_eq "$(status_of)"       'error'         'T1 子が書いた error が done に降格しない'
assert_eq "$(message_of)"      'child-written' 'T1 子が書いた message が保持される'
assert_eq "$(notified_label)"  'error'         'T1 親通知が status: error になる'

# T2: 子が done を書いて正常終了 → done と message が保持される
run_case done-exit0 0 done
assert_eq "$(status_of)"  'done'          'T2 子が書いた done が保持される'
assert_eq "$(message_of)" 'child-written' 'T2 子が書いた message が保持される'

# T3: 子が done を書いた後に非ゼロ終了 → 保守的に error
run_case done-exit1 1 done
assert_eq "$(status_of)" 'error' 'T3 done 宣言後のクラッシュは error 扱い'

# T4: 終端でない status からの正常終了 → 従来どおり done
run_case exec-exit0 0 executing
assert_eq "$(status_of)"      'done' 'T4 executing からの正常終了は done'
assert_eq "$(notified_label)" 'done' 'T4 親通知が status: done になる'

# T5: 終端でない status からの異常終了 → 従来どおり error
run_case exec-exit1 1 executing
assert_eq "$(status_of)" 'error' 'T5 executing からの異常終了は error'

[[ $fail -eq 0 ]] && echo '--- all tests passed ---' || echo '--- failures ---'
exit "$fail"
