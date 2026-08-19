#!/usr/bin/env bash
# ensure-agmsg-ready.sh と agmsg-path.sh の回帰テスト。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SD="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts"

fail=0
bad() { echo "FAIL: $1" >&2; fail=1; }

# --- 共通ヘルパーと stub ツリー ---
TMP=$(mktemp -d)
trap 'cleanup_all' EXIT
FIXTURE_PIDS=()
cleanup_all() {
  local p
  for p in ${FIXTURE_PIDS[@]+"${FIXTURE_PIDS[@]}"}; do kill "$p" 2>/dev/null || true; done
  rm -rf "$TMP"
}

GUARD="$SD/ensure-agmsg-ready.sh"
export AGMSG_DIR="$TMP/stub/scripts"
export AGMSG_READY_DIR="$TMP/stub/run"
export AGMSG_LOG_DIR="$TMP/logs"
export AGMSG_STUB_LOG="$TMP/stub.log"
export AGMSG_READY_TIMEOUT=1
mkdir -p "$AGMSG_DIR" "$AGMSG_READY_DIR" "$AGMSG_LOG_DIR"

# 安全装置: stub を指していない状態で走らせると実機の watcher を kill しうる
[[ "$AGMSG_DIR" == "$TMP"/* && "$AGMSG_READY_DIR" == "$TMP"/* ]] || exit 2

: > "$AGMSG_DIR/send.sh"
cat > "$AGMSG_DIR/delivery.sh" <<'STUB'
#!/usr/bin/env bash
echo "delivery|$*" >> "$AGMSG_STUB_LOG"
echo 'AGMSG-DIRECTIVE: stub'
exit "${AGMSG_STUB_DELIVERY_RC:-0}"
STUB
chmod +x "$AGMSG_DIR/delivery.sh"

cat > "$AGMSG_DIR/watch.sh" <<'STUB'
#!/usr/bin/env bash
printf 'watch.sh|%s|%s\n' "${AGMSG_WATCH_INTERVAL:-}" "$*" >> "$AGMSG_STUB_LOG"
sentinel="$AGMSG_READY_DIR/ready.t__$4"
pidfile="$AGMSG_READY_DIR/watch.$AGMSG_STUB_INSTANCE_ID.pid"
write_ready() { [[ $# -ge 4 ]] && { printf '%s\n' "$AGMSG_STUB_INSTANCE_ID" > "$sentinel"; printf '%s\n' "$$" > "$pidfile"; }; }
case "${AGMSG_STUB_MODE:-alive}" in
  alive)              write_ready "$@"; sleep 300 ;;
  sentinel-then-exit) write_ready "$@"; exit 0 ;;
  no-sentinel)        printf '%s\n' "$$" > "$pidfile"; sleep 300 ;;
  held)               echo 'agmsg watch: cannot claim (held by other sessions): x' >&2; exit 1 ;;
  unregistered)       echo "agmsg watch: no registration for agent 'x'"; exit 0 ;;
  db-error)           echo 'ERROR: cannot open message DB /x'; exit 1 ;;
  silent-exit)        exit 0 ;;
  decoy)              echo '2026-01-01 | t | a - b | agmsg watch: cannot claim'; write_ready "$@"; sleep 300 ;;
esac
STUB
chmod +x "$AGMSG_DIR/watch.sh"

reset_case() {
  rm -rf "${AGMSG_READY_DIR:?}"/* "${AGMSG_LOG_DIR:?}"/* 2>/dev/null || true
  : > "$AGMSG_STUB_LOG"
}

# 出力契約の検証。全ケースで呼ぶ。
assert_line() {  # <output>
  local out="$1"
  [[ $(printf '%s' "$out" | wc -l | tr -d ' ') -eq 0 ]] || bad "output is not a single line: $out"
  local k
  for k in installed wired name watcher pid reason log; do
    [[ "$out" == *" $k="* ]] || bad "output is missing key '$k': $out"
  done
  [[ "$out" == ensure-agmsg-ready:* ]] || bad "output has no prefix: $out"
}

run_guard() {  # 追加の引数をそのまま渡す。GUARD_OUT に stdout、GUARD_RC に rc を入れる。
  # 呼び出しは `out=$(run_guard ...)` の形にしないこと — command substitution は
  # サブシェルで走るため、その中で行った GUARD_RC への代入は呼び出し元へ伝播しない。
  GUARD_RC=0
  GUARD_OUT=$(bash "$GUARD" "$@" 2>"$TMP/stderr.txt") || GUARD_RC=$?
}

# --- AR16a-f: exit 2 ---
reset_case; run_guard --name x; out="$GUARD_OUT"; assert_line "$out"
[[ $GUARD_RC -eq 2 && "$out" == *"reason=usage"* ]] || bad 'AR16a missing --type'
reset_case; run_guard --type claude-code; out="$GUARD_OUT"; assert_line "$out"
[[ $GUARD_RC -eq 2 ]] || bad 'AR16b missing --name'
reset_case; run_guard --type claude-code --name x --bogus; out="$GUARD_OUT"
[[ $GUARD_RC -eq 2 ]] || bad 'AR16c unknown flag'
reset_case; run_guard --type grok --name x; out="$GUARD_OUT"
[[ $GUARD_RC -eq 2 ]] || bad 'AR16d bad --type'
reset_case; run_guard --type claude-code --name 'a b'; out="$GUARD_OUT"; assert_line "$out"
[[ $GUARD_RC -eq 2 && "$out" == *" name=- "* ]] || bad 'AR16e bad --name must print name=-'
reset_case; AGMSG_EXPECTED_NAME=other run_guard --type claude-code --name x; out="$GUARD_OUT"
[[ $GUARD_RC -eq 2 ]] || bad 'AR16f AGMSG_EXPECTED_NAME mismatch'
[[ ! -s "$AGMSG_STUB_LOG" ]] || bad 'AR16 must not call delivery.sh or watch.sh'

# --- AR1: 未インストール ---
reset_case; mv "$AGMSG_DIR/send.sh" "$TMP/send.sh.bak"
run_guard --type claude-code --name ar-$$-1; out="$GUARD_OUT"; assert_line "$out"
[[ $GUARD_RC -eq 1 && "$out" == *"reason=not-installed"* ]] || bad 'AR1'
grep -q 'not installed' "$TMP/stderr.txt" || bad 'AR1 stderr hint'
mv "$TMP/send.sh.bak" "$AGMSG_DIR/send.sh"

# --- AR14: delivery.sh 失敗 ---
reset_case
AGMSG_STUB_DELIVERY_RC=1 run_guard --type claude-code --name ar-$$-14; out="$GUARD_OUT"; assert_line "$out"
[[ $GUARD_RC -eq 1 && "$out" == *"reason=delivery-set-failed"* ]] || bad 'AR14'
grep -q 'watch.sh' "$AGMSG_STUB_LOG" && bad 'AR14 must not launch watch.sh'

# --- AR13: AGMSG-DIRECTIVE が stdout へ漏れない ---
[[ "$out" == *"AGMSG-DIRECTIVE"* ]] && bad 'AR13 directive leaked to stdout'

# --- AR2 / AR2c: ログを作れない ---
reset_case; : > "$TMP/afile"
AGMSG_LOG_DIR="$TMP/afile/sub" AGMSG_STUB_MODE=alive AGMSG_STUB_INSTANCE_ID="s.1" \
      CLAUDE_CODE_SESSION_ID=s run_guard --type claude-code --name ar-$$-2
out="$GUARD_OUT"
assert_line "$out"
[[ $GUARD_RC -eq 0 && "$out" == *"reason=log-unwritable"* ]] || bad 'AR2 reason'
grep -q 'watch.sh' "$AGMSG_STUB_LOG" || bad 'AR2 must still launch the watcher'
[[ -c /dev/null ]] || bad 'AR2c /dev/null was removed'

# --- AR2b: TMPDIR 未設定でも log-unwritable にならない ---
reset_case
out=$(env -u TMPDIR -u AGMSG_LOG_DIR AGMSG_STUB_MODE=held CLAUDE_CODE_SESSION_ID=s \
      bash "$GUARD" --type claude-code --name ar-$$-2b 2>/dev/null)
[[ "$out" != *"reason=log-unwritable"* ]] || bad 'AR2b'

# --- AR15: session id の取り方 ---
reset_case
CLAUDE_CODE_SESSION_ID=cc-sid CODEX_THREAD_ID=cx-sid AGMSG_STUB_MODE=silent-exit \
      run_guard --type claude-code --name ar-$$-15
grep -q '|cc-sid ' "$AGMSG_STUB_LOG" || bad 'AR15 claude-code must use CLAUDE_CODE_SESSION_ID'
reset_case
CLAUDE_CODE_SESSION_ID=cc-sid CODEX_THREAD_ID=cx-sid AGMSG_STUB_MODE=silent-exit \
      run_guard --type codex --name ar-$$-15b
grep -q '|cx-sid ' "$AGMSG_STUB_LOG" || bad 'AR15 codex must use CODEX_THREAD_ID'
reset_case
out=$(env -u CLAUDE_CODE_SESSION_ID -u CODEX_THREAD_ID AGMSG_STUB_MODE=silent-exit \
      bash "$GUARD" --type claude-code --name ar-$$-15c 2>/dev/null)
grep -q '|- ' "$AGMSG_STUB_LOG" && bad 'AR15 must not pass the "-" sentinel'

# --- AR17: エンコードのゴールデンベクタ ---
# shellcheck disable=SC1091
source "$SD/agmsg-path.sh"

check_enc() {  # <team> <agent> <expected basename>
  local got
  got=$(agmsg_ready_path /run "$1" "$2")
  [[ "$got" == "/run/$3" ]] || bad "AR17 enc('$1','$2') = $got (want /run/$3)"
}
check_enc 'dispatch-my repo'  parent   'ready.dispatch-my%20repo__parent'
check_enc 'dispatch-a%b'      parent   'ready.dispatch-a%25b__parent'
check_enc 'dispatch-日本'      parent   'ready.dispatch-%E6%97%A5%E6%9C%AC__parent'
check_enc 'dispatch-ok_1.2-3' x-review 'ready.dispatch-ok_1.2-3__x-review'

[[ $fail -eq 0 ]] && echo '--- all tests passed ---' || echo '--- failures ---'
exit "$fail"
