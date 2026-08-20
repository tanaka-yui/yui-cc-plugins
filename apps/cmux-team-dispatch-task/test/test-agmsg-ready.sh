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
  decoy-exit)         echo '2026-01-01 | t | a - b | agmsg watch: cannot claim'; exit 0 ;;
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

start_fixture() {  # <instance_id> <sid> <project> <type> [<name>] → pid を FIXTURE_PIDS へ
  local iid="$1"; shift
  AGMSG_STUB_INSTANCE_ID="$iid" AGMSG_STUB_MODE=alive \
    nohup bash "$AGMSG_DIR/watch.sh" "$@" </dev/null >/dev/null 2>&1 &
  local p=$!
  FIXTURE_PIDS+=("$p")
  printf '%s\n' "$p" > "$AGMSG_READY_DIR/watch.$iid.pid"
  sleep 0.3
  printf '%s' "$p"
}

# --- AR3: 自セッション・composite・名前一致 → existing ---
reset_case
start_fixture "s3.111" s3 /p claude-code "ar-$$-3" >/dev/null
: > "$AGMSG_STUB_LOG"
CLAUDE_CODE_SESSION_ID=s3 run_guard --type claude-code --name "ar-$$-3"; out="$GUARD_OUT"; assert_line "$out"
[[ "$out" == *"watcher=existing"* ]] || bad 'AR3 existing'
grep -q 'watch.sh' "$AGMSG_STUB_LOG" && bad 'AR3 must not launch a new watcher'

# --- AR3i: existing を返しても既存 watcher を kill しない ---
existing_pid=$(cat "$AGMSG_READY_DIR/watch.s3.111.pid")
kill -0 "$existing_pid" 2>/dev/null || bad 'AR3i the existing watcher was killed'
ls "$AGMSG_READY_DIR"/ready.* >/dev/null 2>&1 || bad 'AR3i the sentinel was removed'

# --- AR3d: 同一セッション・別ロール → existing-other ---
reset_case
start_fixture "s3d.111" s3d /p claude-code "ar-$$-3d-claude" >/dev/null
: > "$AGMSG_STUB_LOG"
CLAUDE_CODE_SESSION_ID=s3d run_guard --type claude-code --name "ar-$$-3d"; out="$GUARD_OUT"
[[ "$out" == *"watcher=existing-other"* ]] || bad 'AR3d existing-other'
grep -q 'watch.sh' "$AGMSG_STUB_LOG" && bad 'AR3d must not launch'

# --- AR3e: broad ($# 3) → existing-other ---
reset_case
start_fixture "s3e.111" s3e /p claude-code >/dev/null
: > "$AGMSG_STUB_LOG"
CLAUDE_CODE_SESSION_ID=s3e run_guard --type claude-code --name "ar-$$-3e"; out="$GUARD_OUT"
[[ "$out" == *"watcher=existing-other"* ]] || bad 'AR3e broad'

# --- AR3c: 別セッションの同名は候補にせず起動する ---
reset_case
start_fixture "other.111" other /p claude-code "ar-$$-3c" >/dev/null
: > "$AGMSG_STUB_LOG"
CLAUDE_CODE_SESSION_ID=s3c AGMSG_STUB_MODE=held run_guard --type claude-code --name "ar-$$-3c"; out="$GUARD_OUT"
[[ "$out" == *"reason=held-by-other-session"* ]] || bad 'AR3c must attempt and report held'
grep -q 'drop' "$TMP/stderr.txt" || bad 'AR3c recovery hint'

# --- AR3j: bare は候補にせず起動する。bare は kill しない ---
reset_case
bare_pid=$(start_fixture "s3j" s3j /p claude-code "ar-$$-3j")
: > "$AGMSG_STUB_LOG"
CLAUDE_CODE_SESSION_ID=s3j AGMSG_STUB_MODE=silent-exit run_guard --type claude-code --name "ar-$$-3j"; out="$GUARD_OUT"
grep -q 'watch.sh' "$AGMSG_STUB_LOG" || bad 'AR3j must launch despite the bare candidate'
kill -0 "$bare_pid" 2>/dev/null || bad 'AR3j must not kill the bare watcher'
grep -q 'bare instance id' "$TMP/stderr.txt" || bad 'AR3j hint'

# --- AR3k: --name codex が型引数へ誤ヒットしない ---
reset_case
start_fixture "s3k.111" s3k /p codex >/dev/null
: > "$AGMSG_STUB_LOG"
CODEX_THREAD_ID=s3k run_guard --type codex --name codex; out="$GUARD_OUT"
[[ "$out" == *"watcher=existing-other"* ]] || bad 'AR3k name slot must be positional'

# --- AR4: 候補の pid が死んでいれば起動する ---
reset_case
printf '%s\n' 999999 > "$AGMSG_READY_DIR/watch.s4.111.pid"
: > "$AGMSG_STUB_LOG"
CLAUDE_CODE_SESSION_ID=s4 AGMSG_STUB_MODE=silent-exit run_guard --type claude-code --name "ar-$$-4"; out="$GUARD_OUT"
grep -q 'watch.sh' "$AGMSG_STUB_LOG" || bad 'AR4 must launch when the candidate pid is dead'

# --- AR3h: 候補ゼロなら ps が空でも起動する ---
reset_case
mkdir -p "$TMP/nops"; printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/nops/ps"; chmod +x "$TMP/nops/ps"
: > "$AGMSG_STUB_LOG"
PATH="$TMP/nops:$PATH" CLAUDE_CODE_SESSION_ID=s3h AGMSG_STUB_MODE=silent-exit \
      run_guard --type claude-code --name "ar-$$-3h"
out="$GUARD_OUT"
grep -q 'watch.sh' "$AGMSG_STUB_LOG" || bad 'AR3h must launch when there is no candidate'

# --- AR3g: 候補があり ps が空 → existing-other ---
reset_case
start_fixture "s3g.111" s3g /p claude-code "ar-$$-3g" >/dev/null
: > "$AGMSG_STUB_LOG"
PATH="$TMP/nops:$PATH" CLAUDE_CODE_SESSION_ID=s3g run_guard --type claude-code --name "ar-$$-3g"; out="$GUARD_OUT"
[[ "$out" == *"watcher=existing-other"* ]] || bad 'AR3g'
grep -q 'watch.sh' "$AGMSG_STUB_LOG" && bad 'AR3g must not launch'

# --- AR5: 生きた owner の sentinel を消さない / 死んだものは消す ---
reset_case
enc=$(bash -c "source '$SD/agmsg-path.sh'; agmsg_encode_component 'ar-$$-5'")
printf 'alive.1\n' > "$AGMSG_READY_DIR/ready.t__$enc"
printf '%s\n' "$$" > "$AGMSG_READY_DIR/watch.alive.1.pid"
CLAUDE_CODE_SESSION_ID=s5 AGMSG_STUB_MODE=silent-exit run_guard --type claude-code --name "ar-$$-5"
[[ -f "$AGMSG_READY_DIR/ready.t__$enc" ]] || bad 'AR5 must keep a sentinel whose pidfile pid is alive'
reset_case
printf 'dead.1\n' > "$AGMSG_READY_DIR/ready.t__$enc"
CLAUDE_CODE_SESSION_ID=s5b AGMSG_STUB_MODE=silent-exit run_guard --type claude-code --name "ar-$$-5"
[[ -f "$AGMSG_READY_DIR/ready.t__$enc" ]] && bad 'AR5 must remove a sentinel with no pidfile'

# --- AR3b: argv[0]/argv[1] が watch.sh でないプロセスは候補にしない ---
reset_case
nohup /bin/sh -c "sleep 300 # $AGMSG_DIR/watch.sh s3b /p claude-code ar-$$-3b" </dev/null >/dev/null 2>&1 &
FIXTURE_PIDS+=($!)
printf '%s\n' "$!" > "$AGMSG_READY_DIR/watch.s3b.111.pid"
sleep 0.3; : > "$AGMSG_STUB_LOG"
CLAUDE_CODE_SESSION_ID=s3b AGMSG_STUB_MODE=silent-exit run_guard --type claude-code --name "ar-$$-3b"
grep -q 'watch.sh' "$AGMSG_STUB_LOG" || bad 'AR3b wrapper shell must not count as a candidate'

# --- AR4b: EPERM を生存として扱う ---
reset_case
mkdir -p "$TMP/eperm"
cat > "$TMP/eperm/kill" <<'STUB'
#!/usr/bin/env bash
# -0 は必ず "not permitted" で失敗させる (EPERM のシミュレーション)
if [[ "${1:-}" == "-0" ]]; then echo "kill: ($2) - Operation not permitted" >&2; exit 1; fi
exec /bin/kill "$@"
STUB
chmod +x "$TMP/eperm/kill"
start_fixture "s4b.111" s4b /p claude-code "ar-$$-4b" >/dev/null
: > "$AGMSG_STUB_LOG"
PATH="$TMP/eperm:$PATH" CLAUDE_CODE_SESSION_ID=s4b run_guard --type claude-code --name "ar-$$-4b"
grep -q 'watch.sh' "$AGMSG_STUB_LOG" && bad 'AR4b EPERM must be treated as alive'

# --- AR6: 正常系 ---
reset_case
CLAUDE_CODE_SESSION_ID=s6 AGMSG_STUB_INSTANCE_ID="s6.222" AGMSG_STUB_MODE=alive \
      run_guard --type claude-code --name "ar-$$-6"; out="$GUARD_OUT"; assert_line "$out"
[[ $GUARD_RC -eq 0 && "$out" == *"watcher=started"* && "$out" == *" log=-" ]] || bad 'AR6'
[[ -f "$AGMSG_READY_DIR/watch.s6.222.pid" ]] || bad 'AR6 pidfile must be composite'
ls "$AGMSG_LOG_DIR"/agmsg-watch-* >/dev/null 2>&1 && bad 'AR6 the log must be removed on success'
# AR7: pid が watch.sh 本体であること
pid=$(printf '%s' "$out" | sed -n 's/.* pid=\([0-9]*\) .*/\1/p')
guard_ps=$(ps -ww -p "$pid" -o args= 2>/dev/null)
[[ "$guard_ps" == *"$AGMSG_DIR/watch.sh"* ]] || bad 'AR7 pid is not the watch.sh process'
# AR20: interval が export される
grep -q '^watch.sh|30|' "$AGMSG_STUB_LOG" || bad 'AR20 AGMSG_WATCH_INTERVAL was not exported'

# --- AR21: 2 回目は existing ---
: > "$AGMSG_STUB_LOG"
CLAUDE_CODE_SESSION_ID=s6 run_guard --type claude-code --name "ar-$$-6"; out="$GUARD_OUT"
[[ "$out" == *"watcher=existing"* ]] || bad 'AR21 second run must not start a second watcher'
grep -q 'watch.sh' "$AGMSG_STUB_LOG" && bad 'AR21 must not launch again'

# --- AR8: watcher 生存中でもコマンド置換が戻る（ハング検出は自前 watchdog） ---
reset_case
( CLAUDE_CODE_SESSION_ID=s8 AGMSG_STUB_INSTANCE_ID="s8.222" AGMSG_STUB_MODE=alive \
  bash "$GUARD" --type claude-code --name "ar-$$-8" >"$TMP/ar8.out" 2>/dev/null ) &
ar8=$!
for _ in $(seq 1 100); do kill -0 "$ar8" 2>/dev/null || break; sleep 0.1; done
if kill -0 "$ar8" 2>/dev/null; then kill -9 "$ar8" 2>/dev/null; bad 'AR8 guard did not return (fd leak)'; fi

# --- AR9a-d: 分類 ---
for m in held:held-by-other-session unregistered:not-registered \
         db-error:db-unavailable silent-exit:watcher-exited; do
  reset_case
  mode="${m%%:*}"; want="${m##*:}"
  start=$SECONDS
  AGMSG_READY_TIMEOUT=10 CLAUDE_CODE_SESSION_ID="s9$mode" AGMSG_STUB_MODE="$mode" \
        run_guard --type claude-code --name "ar-$$-9"; out="$GUARD_OUT"; assert_line "$out"
  [[ "$out" == *"reason=$want"* ]] || bad "AR9 $mode -> $want (got $out)"
  [[ $((SECONDS - start)) -lt 3 ]] || bad "AR9 $mode did not abort early"
  [[ $GUARD_RC -eq 0 ]] || bad "AR9 $mode must exit 0"
done

# --- AR9e: decoy 行で誤分類しない ---
reset_case
CLAUDE_CODE_SESSION_ID=s9e AGMSG_STUB_INSTANCE_ID="s9e.222" AGMSG_STUB_MODE=decoy \
      run_guard --type claude-code --name "ar-$$-9e"; out="$GUARD_OUT"
[[ "$out" == *"watcher=started"* ]] || bad 'AR9e decoy body line must not be classified'

# --- AR9f: decoy 行を吐いて即 exit しても anchoring が効いていれば watcher-exited になる ---
# 行頭アンカーなしの全文一致だと decoy 行の "agmsg watch: cannot claim" 部分文字列に
# 引っかかって held-by-other-session に誤分類される。classify_from_log() が
# '^agmsg watch: cannot claim' のように行頭アンカーで実装されていることの直接検証。
reset_case
CLAUDE_CODE_SESSION_ID=s9f AGMSG_STUB_MODE=decoy-exit run_guard --type claude-code --name "ar-$$-9f"
out="$GUARD_OUT"
[[ "$out" == *"reason=watcher-exited"* ]] || bad "AR9f decoy line must not be classified as held (got $out)"

# --- AR10 / AR10b: bare で起動した watcher は kill する ---
reset_case
CLAUDE_CODE_SESSION_ID=s10 AGMSG_STUB_INSTANCE_ID="s10" AGMSG_STUB_MODE=alive \
      run_guard --type claude-code --name "ar-$$-10"; out="$GUARD_OUT"
[[ "$out" == *"reason=bare-started"* && "$out" == *"watcher=none"* ]] || bad 'AR10'
ls "$AGMSG_READY_DIR"/ready.* >/dev/null 2>&1 && bad 'AR10b the sentinel must be cleaned up'

# --- AR11 / AR11b: timeout ---
reset_case
enc=$(bash -c "source '$SD/agmsg-path.sh'; agmsg_encode_component 'someone-else'")
printf 'alive.1\n' > "$AGMSG_READY_DIR/ready.t__$enc"
printf '%s\n' "$$" > "$AGMSG_READY_DIR/watch.alive.1.pid"
CLAUDE_CODE_SESSION_ID=s11 AGMSG_STUB_INSTANCE_ID="s11.222" AGMSG_STUB_MODE=no-sentinel \
      run_guard --type claude-code --name "ar-$$-11"; out="$GUARD_OUT"
[[ "$out" == *"reason=start-timeout"* ]] || bad 'AR11'
[[ -f "$AGMSG_READY_DIR/ready.t__$enc" ]] || bad 'AR11b must not remove another role sentinel'

# --- AR12: 手順 8 の照合時に ps が空 → orphan-watcher ---
reset_case
mkdir -p "$TMP/lateps"
cat > "$TMP/lateps/ps" <<STUB
#!/usr/bin/env bash
# 候補ゼロの新規起動では手順 5 は ps を呼ばないので、guard_stop_watcher の
# guard_is_watcher 再照合 (手順 8) が最初の呼び出しになる。そこを空にする。
n=\$(cat "$TMP/psn" 2>/dev/null || echo 0); n=\$((n+1)); echo \$n > "$TMP/psn"
exit 0
STUB
chmod +x "$TMP/lateps/ps"; echo 0 > "$TMP/psn"
PATH="$TMP/lateps:$PATH" CLAUDE_CODE_SESSION_ID=s12 AGMSG_STUB_INSTANCE_ID="s12.222" \
      AGMSG_STUB_MODE=no-sentinel run_guard --type claude-code --name "ar-$$-12"; out="$GUARD_OUT"
[[ "$out" == *"reason=orphan-watcher"* ]] || bad 'AR12'
grep -q 'kill it manually' "$TMP/stderr.txt" || bad 'AR12 hint'

# --- AR6b: sentinel 書き込み直後に watch.sh が exit するレースを検知する ---
# 手順 8 で sentinel の内容一致 (done_ok=1) を見つけた直後、その break の時点では
# watch.sh がまだ生きていたかどうか確定しない。手順 8 末尾の再確認
# (`if ! guard_pid_alive "$WATCH_PID"; then classify_from_log; ...`) が
# sentinel-then-exit のような「書いてすぐ exit する」watcher を正しく捕まえ、
# 偽の watcher=started を返さないことを検証する。
reset_case
CLAUDE_CODE_SESSION_ID=s6b AGMSG_STUB_INSTANCE_ID="s6b.222" AGMSG_STUB_MODE=sentinel-then-exit \
      run_guard --type claude-code --name "ar-$$-6b"; out="$GUARD_OUT"
[[ "$out" != *"watcher=started"* ]] || bad "AR6b post-sentinel exit must not report started (got $out)"
[[ "$out" == *"watcher=none"* && "$out" == *"reason=watcher-exited"* ]] || bad "AR6b expected watcher=none reason=watcher-exited (got $out)"

# --- AR6c: 他セッションの sentinel があっても started にしない ---
reset_case
enc=$(bash -c "source '$SD/agmsg-path.sh'; agmsg_encode_component 'ar-$$-6c'")
printf 'alive.1\n' > "$AGMSG_READY_DIR/ready.t__$enc"
printf '%s\n' "$$" > "$AGMSG_READY_DIR/watch.alive.1.pid"
CLAUDE_CODE_SESSION_ID=s6c AGMSG_STUB_MODE=held run_guard --type claude-code --name "ar-$$-6c"; out="$GUARD_OUT"
[[ "$out" == *"reason=held-by-other-session"* ]] || bad 'AR6c must not report started'

# --- AR6d: AGMSG_READY_DIR の指し違い ---
# 実物の watch.sh は AGMSG_READY_DIR という環境変数を認識せず、常に固定の既定パス
# ($AGMSG_READY_DIR の本来値) へ書く。stub は他の全テストのために $AGMSG_READY_DIR を
# 尊重する作りなので、そのままだと guard と stub が常に同じ場所を見てしまい
# 指し違いを再現できない。この 1 ケースだけ watch.sh を固定パス版へ退避・差し替える
# (恒久的な stub 定義は変更しない)。
reset_case
mkdir -p "$TMP/elsewhere"
real_ready_dir="$AGMSG_READY_DIR"
cp "$AGMSG_DIR/watch.sh" "$TMP/watch.sh.bak"
cat > "$AGMSG_DIR/watch.sh" <<STUB
#!/usr/bin/env bash
printf 'watch.sh|%s|%s\n' "\${AGMSG_WATCH_INTERVAL:-}" "\$*" >> "$AGMSG_STUB_LOG"
printf '%s\n' "\$AGMSG_STUB_INSTANCE_ID" > "$real_ready_dir/ready.t__\$4"
printf '%s\n' "\$\$" > "$real_ready_dir/watch.\$AGMSG_STUB_INSTANCE_ID.pid"
sleep 300
STUB
chmod +x "$AGMSG_DIR/watch.sh"
AGMSG_READY_DIR="$TMP/elsewhere" CLAUDE_CODE_SESSION_ID=s6d AGMSG_STUB_INSTANCE_ID="s6d.222" \
      AGMSG_STUB_MODE=alive run_guard --type claude-code --name "ar-$$-6d"; out="$GUARD_OUT"
[[ "$out" == *"reason=pidfile-missing"* ]] || bad 'AR6d'
mv "$TMP/watch.sh.bak" "$AGMSG_DIR/watch.sh"; chmod +x "$AGMSG_DIR/watch.sh"

# --- AR19: ログのモードとユニーク性（異常系で取る） ---
reset_case
CLAUDE_CODE_SESSION_ID=s19 AGMSG_STUB_MODE=held run_guard --type claude-code --name "ar-$$-19"; out1="$GUARD_OUT"
CLAUDE_CODE_SESSION_ID=s19 AGMSG_STUB_MODE=held run_guard --type claude-code --name "ar-$$-19"; out2="$GUARD_OUT"
l1=$(printf '%s' "$out1" | sed -n 's/.* log=\([^ ]*\)$/\1/p')
l2=$(printf '%s' "$out2" | sed -n 's/.* log=\([^ ]*\)$/\1/p')
[[ "$l1" != "$l2" ]] || bad 'AR19 log paths must be unique'
for l in "$l1" "$l2"; do
  [[ "$(ls -l "$l" | cut -c1-10)" == "-rw-------" ]] || bad "AR19 $l is not 0600"
done

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
