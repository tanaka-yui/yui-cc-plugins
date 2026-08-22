#!/usr/bin/env bash
# runner wrapper の signal 終了ガードの動的回帰テスト。
#
# 再現するバグ: 最終クリーンアップで pane を閉じる (cmux close-surface) と、実装済みで
# status.json が done の standby でも子プロセスが signal 終了 (128+N) するため、wrapper が
# status を error へ降格し `[dispatch] task ... finished (status: error)` を親へ誤送信していた。
#
# 静的な文言一致ではなく、生成された runner script を実際に実行して検証する。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCH="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/launch-workspace.sh"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/repo" "$TMP/zdot"
: > "$TMP/zdot/.zshrc"   # ユーザーの .zshrc を読ませない (zsh -ic の副作用を排除)

git -C "$TMP/repo" init -q
git -C "$TMP/repo" config user.email test@example.invalid
git -C "$TMP/repo" config user.name test
touch "$TMP/repo/.gitkeep"
git -C "$TMP/repo" add .gitkeep
git -C "$TMP/repo" commit -qm init

# cmux stub: send / send-key の呼び出しを記録して親通知の有無を判定する
cat > "$TMP/bin/cmux" <<STUB
#!/usr/bin/env bash
case "\$1" in
  list-workspaces) ;;
  new-workspace) echo 'workspace:1' ;;
  list-pane-surfaces) echo 'surface:2' ;;
  notify) echo "\$*" >> "$TMP/cmux-calls.log" ;;
  rename-workspace|rename-tab|wait-for|identify|new-split) ;;
  *) echo "unexpected cmux command: \$*" >&2; exit 1 ;;
esac
STUB
chmod +x "$TMP/bin/cmux"

# agmsg send.sh stub。親通知の唯一の経路。<team> <from> <to> <body> の 4 引数。
cat > "$TMP/bin/agmsg-send.sh" <<STUB
#!/usr/bin/env bash
echo "\$*" >> "$TMP/agmsg-calls.log"
STUB
chmod +x "$TMP/bin/agmsg-send.sh"

# 終了コードを引数で決める stub runner。zsh -ic 経由でも終了コードは伝播する
cat > "$TMP/bin/stub-agent" <<'STUB'
#!/usr/bin/env bash
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

# 生成された runner script を、子プロセスの終了コードと事前 status を指定して実行する。
# 出力: 実行後の status.json の .status
run_case() {
  local label="$1" exit_code="$2" prior_status="$3"
  local status_dir="$TMP/status-$label"
  local name="task-$label"

  rm -rf "$status_dir" "$TMP/cmux-calls.log" "$TMP/agmsg-calls.log"
  mkdir -p "$status_dir"
  jq -n --arg s "$prior_status" '{status:$s, message:"pre-existing"}' > "$status_dir/status.json"
  # standby が実装を引き受けている状態 (.assigned) を作る
  touch "$status_dir/.assigned-$name"

  local output runner
  output=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" \
    AGMSG_SEND="$TMP/bin/agmsg-send.sh" bash "$LAUNCH" \
    --cwd "$TMP/repo" --mode standby --runner stub --status-dir "$status_dir" \
    --agmsg-team demo-team --agmsg-from "$name" \
    --parent-notify-workspace 'workspace:9' "$name")
  runner=$(jq -r '.runner_file' <<<"$output")

  ZDOTDIR="$TMP/zdot" STUB_EXIT_CODE="$exit_code" PATH="$TMP/bin:$PATH" \
    bash "$runner" >/dev/null 2>&1 || true

  jq -r '.status' "$status_dir/status.json"
}

notified() { [[ -s "$TMP/agmsg-calls.log" ]] && echo yes || echo no; }

assert_eq() {
  local actual="$1" expected="$2" label="$3"
  if [[ "$actual" == "$expected" ]]; then
    echo "PASS: $label"
  else
    echo "FAIL: $label (expected: $expected, got: $actual)"
    fail=1
  fi
}

# S1: 完了済み (done) の pane を close された場合 = signal 終了。
#     status を error へ降格せず、親通知も送らない (これが修正したバグ本体)
s1_status=$(run_case sighup 129 done)
s1_notify=$(notified)
assert_eq "$s1_status" 'done' 'S1 SIGHUP 終了で done が保持される'
assert_eq "$s1_notify" 'no'   'S1 SIGHUP 終了で親通知を送らない'

# S2: SIGTERM (143) / SIGKILL (137) でも同じ
s2_status=$(run_case sigterm 143 done)
assert_eq "$s2_status" 'done' 'S2 SIGTERM 終了で done が保持される'
s3_status=$(run_case sigkill 137 done)
assert_eq "$s3_status" 'done' 'S3 SIGKILL 終了で done が保持される'

# S4: まだ実行中 (executing) の pane が signal 終了した場合は本当の中断なので
#     従来どおり error を書いて通知する (ガードが広すぎないことの確認)
s4_status=$(run_case executing-sighup 129 executing)
s4_notify=$(notified)
assert_eq "$s4_status" 'error' 'S4 executing 中の signal 終了は error を報告する'
assert_eq "$s4_notify" 'yes'   'S4 executing 中の signal 終了は親へ通知する'

# S5: signal 以外の異常終了 (exit 1) は done 済みでも従来どおり error を報告する
s5_status=$(run_case exit1 1 done)
assert_eq "$s5_status" 'error' 'S5 非 signal の異常終了は従来どおり error'

# S6: 正常終了は従来どおり done + 通知
s6_status=$(run_case ok 0 executing)
s6_notify=$(notified)
assert_eq "$s6_status" 'done' 'S6 正常終了は done'
assert_eq "$s6_notify" 'yes'  'S6 正常終了は親へ通知する'

[[ $fail -eq 0 ]] && echo '--- all tests passed ---' || echo '--- failures ---'
exit "$fail"
