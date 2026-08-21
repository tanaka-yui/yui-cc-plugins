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

# cmux stub。配送は agmsg send.sh に移ったので cmux send / send-key は
# 「呼ばれてはならない」経路になった (呼ばれたら unexpected で落ちる)。
cat > "$TMP/bin/cmux" <<STUB
#!/usr/bin/env bash
case "\$1" in
  new-workspace) echo 'workspace:1' ;;
  list-pane-surfaces) echo 'surface:2' ;;
  notify) echo "\$*" >> "$TMP/cmux-calls.log" ;;
  rename-workspace|rename-tab|wait-for|identify|new-split) ;;
  *) echo "unexpected cmux command: \$*" >&2; exit 1 ;;
esac
STUB
chmod +x "$TMP/bin/cmux"

# agmsg send.sh stub。配送の唯一の経路であり、引数は
# <team> <from> <to> <body> の 4 つだけ (フラグは無い)。
# - cmux-attempts.log: 成否によらず呼び出しを記録する (再試行の検証に使う)
# - cmux-calls.log:    成功した呼び出しだけを記録する
# - $TMP/cmux-fail:          存在する間はすべて失敗させる
# - $TMP/cmux-fail-reviewer: 存在する間は宛先 rv-review だけ失敗させる
cat > "$TMP/bin/agmsg-send.sh" <<STUB
#!/usr/bin/env bash
echo "\$*" >> "$TMP/cmux-attempts.log"
if [[ -f "$TMP/cmux-fail" ]]; then exit 1; fi
if [[ -f "$TMP/cmux-fail-reviewer" && "\$3" == "rv-review" ]]; then exit 1; fi
echo "\$*" >> "$TMP/cmux-calls.log"
STUB
chmod +x "$TMP/bin/agmsg-send.sh"

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

STATUS_DIR=""
# 環境変数:
#   STUB_WRITE_STATUS / STUB_SLEEP … stub-agent の挙動 (子の idle 残留を再現)
#   EXTRA_SENTINEL                … 起動前に status dir へ作るファイル名
run_case() {
  local label="$1" exit_code="$2" prior_status="$3"
  STATUS_DIR="$TMP/status-$label"
  local name="task-$label"

  rm -rf "$STATUS_DIR" "$TMP/cmux-calls.log" "$TMP/cmux-attempts.log"
  mkdir -p "$STATUS_DIR"
  jq -n --arg s "$prior_status" '{status:$s, message:"child-written"}' > "$STATUS_DIR/status.json"
  touch "$STATUS_DIR/.assigned-$name"
  [[ -n "${EXTRA_SENTINEL:-}" ]] && touch "$STATUS_DIR/$EXTRA_SENTINEL"

  local output runner
  output=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" \
    AGMSG_SEND="$TMP/bin/agmsg-send.sh" bash "$LAUNCH" \
    --cwd "$TMP/repo" --mode standby --runner stub --status-dir "$STATUS_DIR" \
    --agmsg-team demo-team --agmsg-from "$name" \
    --defer-status --parent-notify-workspace 'workspace:9' "$name")
  runner=$(jq -r '.runner_file' <<<"$output")

  ZDOTDIR="$TMP/zdot" STUB_EXIT_CODE="$exit_code" PATH="$TMP/bin:$PATH" \
    CMUX_DISPATCH_WATCH_INTERVAL=1 STUB_STATUS_DIR="$STATUS_DIR" \
    STUB_WRITE_STATUS="${STUB_WRITE_STATUS:-}" STUB_SLEEP="${STUB_SLEEP:-}" \
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

marker_of() { cat "$STATUS_DIR/.notified-task-$1" 2>/dev/null || echo '(none)'; }

# T6: 通知に成功したら marker に通知済み status が記録される
run_case marker 0 error
assert_eq "$(marker_of marker)" 'error' 'T6 marker に通知済み status が記録される'

# T7: 通知が失敗したら marker を書かない (次の参加者が再試行できる)
: > "$TMP/cmux-fail"
run_case sendfail 0 error
rm -f "$TMP/cmux-fail"
assert_eq "$(marker_of sendfail)" '(none)' 'T7 通知失敗時は marker を書かない'

attempts() {
  if [[ -f "$TMP/cmux-attempts.log" ]]; then
    wc -l < "$TMP/cmux-attempts.log" | tr -d ' '
  else
    echo 0
  fi
}
log_has()   { grep -q "$1" "$TMP/cmux-calls.log" 2>/dev/null; }
log_count() { grep -c "$1" "$TMP/cmux-calls.log" 2>/dev/null || true; }

# runner を非同期起動する。watcher と exit パスを区別するには、子が生存している
# 間に通知ログを観測しなければならない (同期実行では最後の exit パスの結果しか見えない)。
RUNNER_BG_PID=""
CASE_LABEL=""
run_case_bg() {
  local label="$1" exit_code="$2" prior_status="$3"
  CASE_LABEL="$label"
  STATUS_DIR="$TMP/status-$label"
  local name="task-$label"

  [[ -n "${REVIEW_PRESEED:-}" ]] || rm -rf "$STATUS_DIR"
  rm -f "$TMP/cmux-calls.log" "$TMP/cmux-attempts.log" \
        "$TMP/ready-$label" "$TMP/release-$label"
  mkdir -p "$STATUS_DIR"
  jq -n --arg s "$prior_status" '{status:$s, message:"child-written"}' > "$STATUS_DIR/status.json"
  [[ -n "${SKIP_ASSIGN:-}" ]] || touch "$STATUS_DIR/.assigned-$name"
  [[ -n "${EXTRA_SENTINEL:-}" ]] && touch "$STATUS_DIR/$EXTRA_SENTINEL"
  [[ -n "${PRESEED_MARKER:-}" ]] && printf '%s' "$PRESEED_MARKER" > "$STATUS_DIR/.notified-$name"

  local output runner
  output=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" \
    AGMSG_SEND="$TMP/bin/agmsg-send.sh" bash "$LAUNCH" \
    --cwd "$TMP/repo" --mode standby --runner stub --status-dir "$STATUS_DIR" \
    --agmsg-team demo-team --agmsg-from "$name" \
    --defer-status --parent-notify-workspace 'workspace:9' "$name")
  runner=$(jq -r '.runner_file' <<<"$output")

  ZDOTDIR="$TMP/zdot" STUB_EXIT_CODE="$exit_code" PATH="$TMP/bin:$PATH" \
    CMUX_DISPATCH_WATCH_INTERVAL=1 STUB_STATUS_DIR="$STATUS_DIR" \
    STUB_READY="$TMP/ready-$label" STUB_RELEASE="$TMP/release-$label" \
    STUB_WRITE_STATUS="${STUB_WRITE_STATUS:-}" \
    bash "$runner" >/dev/null 2>&1 &
  RUNNER_BG_PID=$!
  RUNNER_PIDS+=("$RUNNER_BG_PID")
  CASE_PIDS+=("$RUNNER_BG_PID")
  CASE_LABELS+=("$label")
  # stub が実際に起動したことを確認してから観測に入る
  # (起動失敗を「抑止できた」と誤認しないため)
  wait_for_file "$TMP/ready-$label" 15 || { echo "FAIL: stub did not start ($label)"; fail=1; }
}

wait_for_file() {
  local f="$1" limit="${2:-10}" i
  for i in $(seq 1 $((limit * 2))); do [[ -f "$f" ]] && return 0; sleep 0.5; done
  return 1
}
wait_for_log() {
  local pattern="$1" limit="${2:-10}" i
  for i in $(seq 1 $((limit * 2))); do log_has "$pattern" && return 0; sleep 0.5; done
  return 1
}
wait_for_content() {
  local f="$1" want="$2" limit="${3:-10}" i
  for i in $(seq 1 $((limit * 2))); do
    [[ -f "$f" && "$(cat "$f" 2>/dev/null)" == "$want" ]] && return 0
    sleep 0.5
  done
  return 1
}
# reviewer 宛は surface ではなく agmsg agent 名で観測する
wait_for_attempt_to() {
  local target="$1" limit="${2:-15}" i
  for i in $(seq 1 $((limit * 2))); do
    grep -q "$target" "$TMP/cmux-attempts.log" 2>/dev/null && return 0
    sleep 0.5
  done
  return 1
}
wait_for_attempts() {
  local want="$1" limit="${2:-15}" i
  for i in $(seq 1 $((limit * 2))); do (( $(attempts) >= want )) && return 0; sleep 0.5; done
  return 1
}
# stub がまだ待機中か (= 子が生存している)
stub_running() { [[ -f "$TMP/ready-$CASE_LABEL" && ! -f "$TMP/release-$CASE_LABEL" ]]; }

# stub を自然終了させ、wrapper が exit パスを通り切るまで待つ。
# wrapper を kill してはならない — kill すると CLAUDE_EXIT も exit パスも通らない。
release_case() {
  : > "$TMP/release-$CASE_LABEL"
  local i
  for i in $(seq 1 60); do
    kill -0 "$RUNNER_BG_PID" 2>/dev/null || { wait "$RUNNER_BG_PID" 2>/dev/null || true; return 0; }
    sleep 0.5
  done
  echo "FAIL: runner did not exit after release ($CASE_LABEL)"; fail=1
  return 1
}

# T8: 子が error を書いたまま生存している間に watcher が親へ通知する
#     (exit パスではなく watcher が発火したことを、子の生存中に観測して確定させる)
STUB_WRITE_STATUS=error run_case_bg watcher-fires 0 executing
unset STUB_WRITE_STATUS
if wait_for_log 'status: error' 15; then t8_seen=yes; else t8_seen=no; fi
t8_alive=$(stub_running && echo yes || echo no)
release_case
assert_eq "$t8_seen"  'yes' 'T8 子の生存中に watcher が error を通知する'
assert_eq "$t8_alive" 'yes' 'T8 通知を観測した時点で子はまだ生存している'

# T9: .deferred があれば watcher は生存中に通知しない
EXTRA_SENTINEL=.deferred STUB_WRITE_STATUS=error run_case_bg watcher-deferred 0 executing
unset EXTRA_SENTINEL STUB_WRITE_STATUS
sleep 8
t9_seen=$(log_has 'status: ' && echo yes || echo no)
t9_alive=$(stub_running && echo yes || echo no)
release_case
assert_eq "$t9_alive" 'yes' 'T9 観測中も子は生存している'
assert_eq "$t9_seen"  'no'  'T9 .deferred があれば watcher は通知しない'

# T10: 他 pane の .assigned-* があれば watcher は生存中に通知しない
#      (exit パスには foreign-assignment ガードが無いので、観測は生存中に限る)
EXTRA_SENTINEL=.assigned-other-pane STUB_WRITE_STATUS=error run_case_bg watcher-foreign 0 executing
unset EXTRA_SENTINEL STUB_WRITE_STATUS
sleep 8
t10_seen=$(log_has 'status: ' && echo yes || echo no)
t10_alive=$(stub_running && echo yes || echo no)
release_case
assert_eq "$t10_alive" 'yes' 'T10 観測中も子は生存している'
assert_eq "$t10_seen"  'no'  'T10 他 pane の .assigned-* があれば watcher は通知しない'

# T11: 未 assigned の standby では watcher は通知しない
SKIP_ASSIGN=1 STUB_WRITE_STATUS=error run_case_bg watcher-unassigned 0 executing
unset SKIP_ASSIGN STUB_WRITE_STATUS
sleep 8
t11_seen=$(log_has 'status: ' && echo yes || echo no)
release_case
assert_eq "$t11_seen" 'no' 'T11 未 assigned standby では watcher は通知しない'

# T12: 親向け送信が失敗し続けても watcher は再試行を続け、復旧後に通知が届く
#      (spec 3.1 の中核保証。子は生存したまま transport を復旧させる)
: > "$TMP/cmux-fail"
STUB_WRITE_STATUS=error run_case_bg watcher-retry 0 executing
unset STUB_WRITE_STATUS
if wait_for_attempts 2 20; then t12_retried=yes; else t12_retried=no; fi
rm -f "$TMP/cmux-fail"
if wait_for_log 'status: error' 15; then t12_recovered=yes; else t12_recovered=no; fi
t12_alive=$(stub_running && echo yes || echo no)
if wait_for_content "$STATUS_DIR/.notified-task-watcher-retry" 'error' 15; then
  t12_marker=error
else
  t12_marker=$(cat "$STATUS_DIR/.notified-task-watcher-retry" 2>/dev/null || echo '(none)')
fi
release_case
assert_eq "$t12_retried"   'yes'   'T12 送信失敗中も watcher が再試行を続ける'
assert_eq "$t12_recovered" 'yes'   'T12 transport 復旧後に親通知が届く'
assert_eq "$t12_alive"     'yes'   'T12 復旧を観測した時点で子はまだ生存している'
assert_eq "$t12_marker"    'error' 'T12 通知成功後に marker が確定する'

# T13: wrapper 終了後に watcher の再試行が止まる (プロセス残留の検出)
: > "$TMP/cmux-fail"
STUB_WRITE_STATUS=error run_case_bg watcher-stops 0 executing
unset STUB_WRITE_STATUS
wait_for_attempts 2 20 || true
release_case
sleep 2
after_exit=$(attempts)
sleep 6
rm -f "$TMP/cmux-fail"
assert_eq "$(attempts)" "$after_exit" 'T13 wrapper 終了後に watcher の再試行が止まる'

# T14: watcher が done を通知した後に子が異常終了 → error の訂正通知が続く
STUB_WRITE_STATUS=done run_case_bg watcher-correction 1 executing
unset STUB_WRITE_STATUS
if wait_for_log 'status: done' 15; then t14_done=yes; else t14_done=no; fi
t14_alive=$(stub_running && echo yes || echo no)
release_case
assert_eq "$t14_done"  'yes' 'T14 子の生存中に watcher が done を通知する'
assert_eq "$t14_alive" 'yes' 'T14 done 通知の時点で子はまだ生存している'
assert_eq "$(log_has 'status: error' && echo yes || echo no)" 'yes' \
  'T14 その後の異常終了で error の訂正通知が届く'

# T15: watcher と exit の双方が同じ遷移を観測しても親通知は 1 回だけ
STUB_WRITE_STATUS=error run_case_bg watcher-once 0 executing
unset STUB_WRITE_STATUS
if wait_for_log 'status: error' 15; then t15_watcher=yes; else t15_watcher=no; fi
t15_alive=$(stub_running && echo yes || echo no)
release_case
assert_eq "$t15_watcher" 'yes' 'T15 生存中に watcher が通知している'
assert_eq "$t15_alive"   'yes' 'T15 通知観測時に子はまだ生存している'
assert_eq "$(log_count 'status: error')" '1' 'T15 同一遷移の親通知は 1 回だけ'

# T16: 旧世代の .notified-* が残っていても、wrapper 起動時に消えて再通知される
PRESEED_MARKER=error STUB_WRITE_STATUS=error run_case_bg marker-stale 0 executing
unset PRESEED_MARKER STUB_WRITE_STATUS
if wait_for_log 'status: error' 15; then t16=yes; else t16=no; fi
release_case
assert_eq "$t16" 'yes' 'T16 stale marker があっても新しい世代として通知される'

reviewer_msgs() { grep -c '\[abort\]' "$TMP/cmux-calls.log" 2>/dev/null || true; }
seed_review_config() { mkdir -p "$1/review"; printf '%s' "$2" > "$1/review/code-review.json"; }

# R1: reviewer config があれば error の watcher が reviewer を wake する。
STATUS_DIR="$TMP/status-rv1"; rm -rf "$STATUS_DIR"
seed_review_config "$STATUS_DIR" '{"reviewer_surface":"surface:77","reviewer_workspace":"workspace:7","reviewer_agent":"rv-review","review_dir":"x"}'
REVIEW_PRESEED=1 STUB_WRITE_STATUS=error run_case_bg rv1 0 executing
unset REVIEW_PRESEED STUB_WRITE_STATUS
wait_for_log '\[abort\]' 15 && r1=yes || r1=no
release_case
assert_eq "$r1" 'yes' 'R1 code-review.json があればレビュアーへ [abort] が飛ぶ'

# R2/R3/R4: reviewer 不在、done、壊れた/legacy config は親通知を妨げない。
# no-agent は reviewer_agent 欠落 (旧スキーマ)。宛先を捏造せず送らないことを確かめる。
for case in none done broken legacy no-agent; do
  STATUS_DIR="$TMP/status-rv-$case"; rm -rf "$STATUS_DIR"
  if [[ "$case" == broken ]]; then seed_review_config "$STATUS_DIR" 'broken'; fi
  if [[ "$case" == no-agent ]]; then seed_review_config "$STATUS_DIR" '{"reviewer_surface":"surface:77","reviewer_workspace":"workspace:7","review_dir":"x"}'; fi
  if [[ "$case" == legacy ]]; then seed_review_config "$STATUS_DIR" '{"reviewer_surface":"surface:77","reviewer_workspace":"","reviewer_agent":"rv-review","review_dir":"x"}'; fi
  write=error; [[ "$case" == done ]] && write=done
  REVIEW_PRESEED=1 STUB_WRITE_STATUS="$write" run_case_bg "rv-$case" 0 executing
  unset REVIEW_PRESEED STUB_WRITE_STATUS
  wait_for_log "status: $write" 15 || true
  if [[ "$case" == legacy ]]; then
    wait_for_log '\[abort\]' 15 || true
    legacy_abort=$(reviewer_msgs)
    assert_eq "$legacy_abort" '1' 'R4 reviewer_workspace 無しでも reviewer_agent があれば [abort] を送る'
  else
    plain_abort=$(reviewer_msgs)
    assert_eq "$plain_abort" '0' "R2/R3 $case では reviewer へ [abort] を送らない"
  fi
  release_case
done

# R5: reviewer の送信だけが失敗しても、復旧後に独立 marker を確定する。
STATUS_DIR="$TMP/status-rv5"; rm -rf "$STATUS_DIR"
seed_review_config "$STATUS_DIR" '{"reviewer_surface":"surface:77","reviewer_workspace":"workspace:7","reviewer_agent":"rv-review","review_dir":"x"}'
: > "$TMP/cmux-fail-reviewer"
REVIEW_PRESEED=1 STUB_WRITE_STATUS=error run_case_bg rv5 0 executing
unset REVIEW_PRESEED STUB_WRITE_STATUS
wait_for_attempt_to 'rv-review' 20 || true
rm -f "$TMP/cmux-fail-reviewer"
wait_for_content "$STATUS_DIR/.notified-reviewer-task-rv5" error 20 && r5=yes || r5=no
release_case
assert_eq "$r5" 'yes' 'R5 reviewer 送信は復旧後に再試行される'

[[ $fail -eq 0 ]] && echo '--- all tests passed ---' || echo '--- failures ---'
exit "$fail"
