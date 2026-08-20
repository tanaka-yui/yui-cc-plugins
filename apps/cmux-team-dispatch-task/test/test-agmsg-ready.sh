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

# 安全装置: stub を指していない状態で走らせると実機の watcher を kill しうるし、
# AGMSG_LOG_DIR が外れていると開発者の実 $HOME/.cache/agmsg へログを残す
[[ "$AGMSG_DIR" == "$TMP"/* && "$AGMSG_READY_DIR" == "$TMP"/* && "$AGMSG_LOG_DIR" == "$TMP"/* ]] || exit 2

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
# AR22 用: 自分と同じ pid を持つ「他ロールの stale pidfile」を先に置く。
# nohup は exec するので、ここの $$ は guard 側の $WATCH_PID と同じ値になる。
[[ -n "${AGMSG_STUB_DECOY_ID:-}" ]] && printf '%s\n' "$$" > "$AGMSG_READY_DIR/watch.$AGMSG_STUB_DECOY_ID.pid"
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

# 出力契約の検証。**全ケースで呼ぶ** (spec の「毎ケース」要求)。
# キー名の存在だけでは足りない: キーの**順序**と、その reason 行における各値の**値域**まで
# 見ないと「reason=- なのに watcher=none」のような spec の出力表に無い行を通してしまう。
assert_line() {  # <output> [<label>]
  local out="$1" label="${2:-}"
  [[ -n "$label" ]] && label=" [$label]"
  if [[ $(printf '%s' "$out" | wc -l | tr -d ' ') -ne 0 ]]; then
    bad "output is not a single line$label: $out"; return
  fi
  # 7 キーがこの順序で並び、各キーの字面が値域内であること。
  local re='^ensure-agmsg-ready: installed=(yes|no) wired=(yes|no) name=([A-Za-z0-9._-]+|-) watcher=(existing|existing-other|started|none) pid=([0-9]+|-) reason=([a-z-]+) log=(.+)$'
  if [[ ! "$out" =~ $re ]]; then
    bad "output does not match the 7-key contract (prefix / order / value domain)$label: $out"; return
  fi
  local installed="${BASH_REMATCH[1]}" wired="${BASH_REMATCH[2]}" watcher="${BASH_REMATCH[4]}"
  local pid="${BASH_REMATCH[5]}" reason="${BASH_REMATCH[6]}" log="${BASH_REMATCH[7]}"
  # spec の出力表 1 行 = ここの 1 分岐。
  case "$reason" in
    -)
      [[ "$installed" == yes && "$wired" == yes ]] || bad "reason=- must be installed=yes wired=yes$label: $out"
      [[ "$watcher" != none ]] || bad "reason=- must not be watcher=none$label: $out"
      [[ "$pid" != - ]] || bad "reason=- must carry a pid$label: $out"
      [[ "$log" == - ]] || bad "reason=- must have dropped the log$label: $out" ;;
    usage|not-installed)
      [[ "$installed" == no && "$wired" == no && "$watcher" == none && "$pid" == - && "$log" == - ]] \
        || bad "reason=$reason row does not match the table$label: $out" ;;
    delivery-set-failed)
      [[ "$installed" == yes && "$wired" == no && "$watcher" == none && "$pid" == - ]] \
        || bad "reason=delivery-set-failed row does not match the table$label: $out" ;;
    log-unwritable)
      # watcher / pid は「通常どおり」。ログを作れなかった実行なので log は必ず -。
      [[ "$installed" == yes && "$wired" == yes && "$log" == - ]] \
        || bad "reason=log-unwritable row does not match the table$label: $out" ;;
    orphan-watcher)
      # 失敗系で唯一 pid を出す reason (手動 kill の案内に要る)。
      [[ "$installed" == yes && "$wired" == yes && "$watcher" == none && "$pid" != - ]] \
        || bad "reason=orphan-watcher row does not match the table$label: $out" ;;
    interrupted)
      # EXIT trap 専用。シグナル死でしか出ないので run_guard 経由では現れない。
      [[ "$watcher" == none ]] || bad "reason=interrupted must be watcher=none$label: $out" ;;
    pidfile-missing|not-registered|held-by-other-session|db-unavailable|watcher-exited|start-timeout|bare-started)
      [[ "$installed" == yes && "$wired" == yes && "$watcher" == none && "$pid" == - ]] \
        || bad "reason=$reason row does not match the table$label: $out" ;;
    *) bad "unknown reason '$reason'$label: $out" ;;
  esac
}

# プロセスツリーを子から順に SIGKILL する。バックグラウンドのサブシェルだけを
# kill すると、その下の guard 本体と guard が起こした watcher が孤児として残る。
# 非対話シェルはジョブ制御が無効なのでサブシェルは独立した pgid を持たない
# (`kill -9 -$pid` はスイート自身のプロセスグループを撃ちかねない)。よって
# pgrep で親子関係を辿る。
kill_tree() {
  local p="$1" c
  for c in $(pgrep -P "$p" 2>/dev/null || true); do kill_tree "$c"; done
  kill -9 "$p" 2>/dev/null || true
}

# run_guard の上限 (0.1 秒 × N)。正常なケースは最長でも 15 秒程度
# (AGMSG_READY_TIMEOUT の既定 15 = 75 反復 × 0.2 秒) なので 4 倍の余裕を取る。
GUARD_BOUND_TICKS=600

run_guard() {  # 追加の引数をそのまま渡す。GUARD_OUT に stdout、GUARD_RC に rc を入れる。
  # 呼び出しは `out=$(run_guard ...)` の形にしないこと — command substitution は
  # サブシェルで走るため、その中で行った GUARD_RC への代入は呼び出し元へ伝播しない。
  #
  # **上限付きで走らせる。** 素の `GUARD_OUT=$(bash "$GUARD" ...)` は上限が無く、
  # fd 漏れの退行が入るとスイート全体が無限にハングして `--- failures ---` すら
  # 出さない (CI は永久に終わらない)。AR8 と同型のバックグラウンドサブシェル +
  # `kill -0` ポーリングで囲み、どの呼び出し箇所で詰まっても診断を出して落ちるようにする。
  # `timeout` / `gtimeout` は macOS に無いので使えない。
  #
  # コマンド置換はサブシェルの**内側**に置く。ここでファイルへ直接リダイレクトすると
  # guard の stdout がパイプでなくなり、watcher が呼び出し元のパイプを握り続ける
  # 退行 (AR8 が見ているもの) を全呼び出し箇所で見逃す。
  local bin="${RUN_GUARD_BIN:-$GUARD}" tick
  GUARD_RC=0; GUARD_OUT=""
  rm -f "$TMP/run_guard.out" "$TMP/run_guard.rc"
  ( rc=0
    out=$(bash "$bin" "$@" 2>"$TMP/stderr.txt") || rc=$?
    printf '%s' "$out" > "$TMP/run_guard.out"
    printf '%s' "$rc" > "$TMP/run_guard.rc" ) &
  local gp=$!
  for tick in $(seq 1 "$GUARD_BOUND_TICKS"); do
    kill -0 "$gp" 2>/dev/null || break
    sleep 0.1
  done
  if kill -0 "$gp" 2>/dev/null; then
    kill_tree "$gp"
    bad "run_guard did not return within $((GUARD_BOUND_TICKS / 10))s: $*"
    # ここで打ち切る。上限に掛かるのは fd 漏れのような構造的な退行だけで、その場合は
    # 長命 watcher を起こす後続ケースがすべて同じように詰まる (実測: 打ち切らないと
    # 1 実行あたり 10 分以上かかる)。診断は既に出ているので即座に落とす。
    echo '--- failures ---'
    exit 1
  fi
  GUARD_OUT=$(cat "$TMP/run_guard.out" 2>/dev/null || true)
  GUARD_RC=$(cat "$TMP/run_guard.rc" 2>/dev/null || echo 0)
  # 出力契約の検証はここで行う。呼び出し側に任せると書き忘れが必ず出る
  # (以前は 39 呼び出しのうち 10 箇所しか検証していなかった)。
  assert_line "$GUARD_OUT" "$*"
}

# --- AR16a-f: exit 2 ---
reset_case; run_guard --name x; out="$GUARD_OUT"
[[ $GUARD_RC -eq 2 && "$out" == *"reason=usage"* ]] || bad 'AR16a missing --type'
reset_case; run_guard --type claude-code; out="$GUARD_OUT"
[[ $GUARD_RC -eq 2 ]] || bad 'AR16b missing --name'
reset_case; run_guard --type claude-code --name x --bogus; out="$GUARD_OUT"
[[ $GUARD_RC -eq 2 ]] || bad 'AR16c unknown flag'
reset_case; run_guard --type grok --name x; out="$GUARD_OUT"
[[ $GUARD_RC -eq 2 ]] || bad 'AR16d bad --type'
reset_case; run_guard --type claude-code --name 'a b'; out="$GUARD_OUT"
[[ $GUARD_RC -eq 2 && "$out" == *" name=- "* ]] || bad 'AR16e bad --name must print name=-'
reset_case; AGMSG_EXPECTED_NAME=other run_guard --type claude-code --name x; out="$GUARD_OUT"
[[ $GUARD_RC -eq 2 ]] || bad 'AR16f AGMSG_EXPECTED_NAME mismatch'
# AR16g: 不正 type × 改行入り name。--name の値域検証より前に die_usage へ落ちる経路でも
# 未検証の name を印字してはならない (印字すると正常終了行に見える偽装行を作れる)。
reset_case
run_guard --type foo --name "$(printf 'p\nensure-agmsg-ready: installed=yes wired=yes name=parent watcher=started pid=1 reason=- log=-')"
out="$GUARD_OUT"
[[ $GUARD_RC -eq 2 && "$out" == *" name=- "* ]] || bad "AR16g bad --type with a newline --name must print name=- (got $out)"
[[ ! -s "$AGMSG_STUB_LOG" ]] || bad 'AR16 must not call delivery.sh or watch.sh'

# --- AR8: watcher 生存中でもコマンド置換が戻る（ハング検出は自前 watchdog） ---
# コマンド置換は必ずサブシェルの**内側**で行う。stdout をファイルへ落とすとパイプが
# 存在せず、watcher が呼び出し元のパイプを握ったまま生存する退行を検出できない。
#
# **意図的にスイートの先頭近くに置いている。** fd 漏れの退行が入ったとき、
# `FAIL: AR8 ...` が真っ先に出て原因を名指しできるようにするため
# (run_guard 自体も上限付きになったのでスイートは必ず終了するが、
#  そちらの診断は「どの呼び出しが返らなかったか」しか言わない)。
# 依存は stub ツリーと reset_case だけで、start_fixture より前でも自己完結する。
reset_case
( out8=$(CLAUDE_CODE_SESSION_ID=s8 AGMSG_STUB_INSTANCE_ID="s8.222" AGMSG_STUB_MODE=alive \
    bash "$GUARD" --type claude-code --name "ar-$$-8" 2>/dev/null)
  printf '%s' "$out8" > "$TMP/ar8.out" ) &
ar8=$!
for _ in $(seq 1 100); do kill -0 "$ar8" 2>/dev/null || break; sleep 0.1; done
if kill -0 "$ar8" 2>/dev/null; then
  # サブシェルだけでなく guard 本体と guard が起こした watcher まで回収する。
  kill_tree "$ar8"; bad 'AR8 guard did not return (fd leak)'
else
  # 「戻ってくる」だけでなく「正しい 1 行を返す」まで見る。
  out=$(cat "$TMP/ar8.out" 2>/dev/null); assert_line "$out" AR8
  [[ "$out" == *"watcher=started"* ]] || bad "AR8 expected watcher=started (got $out)"
  # AR8 は「guard が返っても watcher は生きている」ことを前提にした唯一のケースなので、
  # ここで回収しないとスイート終了後も sleep 300 の孤児が残る。
  ar8_pid=$(printf '%s' "$out" | sed -n 's/.* pid=\([0-9]*\) .*/\1/p')
  [[ -n "$ar8_pid" ]] && FIXTURE_PIDS+=("$ar8_pid")
fi

# --- AR1: 未インストール ---
reset_case; mv "$AGMSG_DIR/send.sh" "$TMP/send.sh.bak"
run_guard --type claude-code --name ar-$$-1; out="$GUARD_OUT"
[[ $GUARD_RC -eq 1 && "$out" == *"reason=not-installed"* ]] || bad 'AR1'
grep -q 'not installed' "$TMP/stderr.txt" || bad 'AR1 stderr hint'
mv "$TMP/send.sh.bak" "$AGMSG_DIR/send.sh"

# --- AR14: delivery.sh 失敗 ---
reset_case
AGMSG_STUB_DELIVERY_RC=1 run_guard --type claude-code --name ar-$$-14; out="$GUARD_OUT"
[[ $GUARD_RC -eq 1 && "$out" == *"reason=delivery-set-failed"* ]] || bad 'AR14'
grep -q 'watch.sh' "$AGMSG_STUB_LOG" && bad 'AR14 must not launch watch.sh'

# --- AR13: AGMSG-DIRECTIVE が stdout へ漏れない ---
[[ "$out" == *"AGMSG-DIRECTIVE"* ]] && bad 'AR13 directive leaked to stdout'

# --- AR2 / AR2c: ログを作れない ---
reset_case; : > "$TMP/afile"
AGMSG_LOG_DIR="$TMP/afile/sub" AGMSG_STUB_MODE=alive AGMSG_STUB_INSTANCE_ID="s.1" \
      CLAUDE_CODE_SESSION_ID=s run_guard --type claude-code --name ar-$$-2
out="$GUARD_OUT"
[[ $GUARD_RC -eq 0 && "$out" == *"reason=log-unwritable"* ]] || bad 'AR2 reason'
grep -q 'watch.sh' "$AGMSG_STUB_LOG" || bad 'AR2 must still launch the watcher'
[[ -c /dev/null ]] || bad 'AR2c /dev/null was removed'

# --- AR2b: TMPDIR 未設定でも log-unwritable にならない ---
# HOME も差し替える。既定値は ${TMPDIR:-$HOME/.cache}/agmsg なので、両方 unset のまま
# だと開発者の実 $HOME/.cache/agmsg へ 0600 のログを毎回残す (held は異常系なので
# 手順 10 のログ削除に到達しない)。落ち先まで positive に assert する。
reset_case
mkdir -p "$TMP/fakehome"
out=$(env -u TMPDIR -u AGMSG_LOG_DIR HOME="$TMP/fakehome" AGMSG_STUB_MODE=held CLAUDE_CODE_SESSION_ID=s \
      bash "$GUARD" --type claude-code --name ar-$$-2b 2>/dev/null)
assert_line "$out" AR2b
[[ "$out" != *"reason=log-unwritable"* ]] || bad 'AR2b'
ar2b_log=$(printf '%s' "$out" | sed -n 's/.* log=\([^ ]*\)$/\1/p')
[[ "$ar2b_log" == "$TMP/fakehome/.cache/agmsg/"* && -f "$ar2b_log" ]] \
  || bad "AR2b the log must land under \$HOME/.cache/agmsg (got $ar2b_log)"

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
assert_line "$out" AR15c
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
CLAUDE_CODE_SESSION_ID=s3 run_guard --type claude-code --name "ar-$$-3"; out="$GUARD_OUT"
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
[[ $GUARD_RC -eq 0 ]] || bad 'AR3c a watcher-launch failure must never exit 1'
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

# --- AR22: pid が衝突する他ロールの stale pidfile を「自分」と誤認しない ---
# SIGKILL でペインが落ちると EXIT trap が走らず pidfile が run/ に残る。macOS の pid は
# 周回するので、$WATCH_PID と同じ pid 番号を持つ他ロールの残骸は現実に起こりうる。
# glob はアルファベット順なので decoy (aaa-stale) の方が先に来る。pid 値だけで照合して
# いると decoy の正規化 id を「自分のもの」と誤認し、sentinel の中身と一致しないまま
# 時間切れになって**健全な自分の watcher を SIGTERM で殺す**。
reset_case
AGMSG_STUB_DECOY_ID="aaa-stale" CLAUDE_CODE_SESSION_ID=s22 AGMSG_STUB_INSTANCE_ID="s22.222" \
      AGMSG_STUB_MODE=alive run_guard --type claude-code --name "ar-$$-22"
out="$GUARD_OUT"
[[ $GUARD_RC -eq 0 && "$out" == *"watcher=started"* ]] \
  || bad "AR22 a colliding decoy pidfile must not hijack the guard's own normalized id (got $out)"
ar22_pid=$(printf '%s' "$out" | sed -n 's/.* pid=\([0-9]*\) .*/\1/p')
if [[ -n "$ar22_pid" ]]; then
  kill -0 "$ar22_pid" 2>/dev/null || bad 'AR22 the guard must not kill its own healthy watcher'
  FIXTURE_PIDS+=("$ar22_pid")
else
  bad 'AR22 no pid was reported'
fi

# --- AR22b: 同一セッションの非数値 suffix も「自分」と誤認しない ---
# guard_my_norm_id の session-id フィルタが `"$SID"|"$SID".*` と緩いと、
# `s22b.0abc` (glob 順で純数字の `.222` より前) が手順 5 の `^[0-9]+$` 判定を
# 通らないまま「自分」として採用され、AR22 と同じ形で健全な watcher を殺す。
reset_case
AGMSG_STUB_DECOY_ID="s22b.0abc" CLAUDE_CODE_SESSION_ID=s22b AGMSG_STUB_INSTANCE_ID="s22b.222" \
      AGMSG_STUB_MODE=alive run_guard --type claude-code --name "ar-$$-22b"
out="$GUARD_OUT"
[[ $GUARD_RC -eq 0 && "$out" == *"watcher=started"* ]] \
  || bad "AR22b a non-numeric suffix must not be accepted as the guard's own id (got $out)"
[[ -f "$AGMSG_READY_DIR/watch.s22b.0abc.pid" ]] || bad 'AR22b the decoy pidfile was not written'
ar22b_pid=$(printf '%s' "$out" | sed -n 's/.* pid=\([0-9]*\) .*/\1/p')
if [[ -n "$ar22b_pid" ]]; then
  kill -0 "$ar22b_pid" 2>/dev/null || bad 'AR22b the guard must not kill its own healthy watcher'
  FIXTURE_PIDS+=("$ar22b_pid")
fi

# --- AR6: 正常系 ---
reset_case
CLAUDE_CODE_SESSION_ID=s6 AGMSG_STUB_INSTANCE_ID="s6.222" AGMSG_STUB_MODE=alive \
      run_guard --type claude-code --name "ar-$$-6"; out="$GUARD_OUT"
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

# --- AR9a-d: 分類 ---
for m in held:held-by-other-session unregistered:not-registered \
         db-error:db-unavailable silent-exit:watcher-exited; do
  reset_case
  mode="${m%%:*}"; want="${m##*:}"
  start=$SECONDS
  AGMSG_READY_TIMEOUT=10 CLAUDE_CODE_SESSION_ID="s9$mode" AGMSG_STUB_MODE="$mode" \
        run_guard --type claude-code --name "ar-$$-9"; out="$GUARD_OUT"
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
[[ $GUARD_RC -eq 0 ]] || bad 'AR9f a watcher-launch failure must never exit 1'

# --- AR10 / AR10b: bare で起動した watcher は kill する ---
reset_case
CLAUDE_CODE_SESSION_ID=s10 AGMSG_STUB_INSTANCE_ID="s10" AGMSG_STUB_MODE=alive \
      run_guard --type claude-code --name "ar-$$-10"; out="$GUARD_OUT"
[[ "$out" == *"reason=bare-started"* && "$out" == *"watcher=none"* ]] || bad 'AR10'
ls "$AGMSG_READY_DIR"/ready.* >/dev/null 2>&1 && bad 'AR10b the sentinel must be cleaned up'
[[ $GUARD_RC -eq 0 ]] || bad 'AR10 a watcher-launch failure must never exit 1'

# --- AR11 / AR11b: timeout ---
reset_case
enc=$(bash -c "source '$SD/agmsg-path.sh'; agmsg_encode_component 'someone-else'")
printf 'alive.1\n' > "$AGMSG_READY_DIR/ready.t__$enc"
printf '%s\n' "$$" > "$AGMSG_READY_DIR/watch.alive.1.pid"
CLAUDE_CODE_SESSION_ID=s11 AGMSG_STUB_INSTANCE_ID="s11.222" AGMSG_STUB_MODE=no-sentinel \
      run_guard --type claude-code --name "ar-$$-11"; out="$GUARD_OUT"
[[ "$out" == *"reason=start-timeout"* ]] || bad 'AR11'
[[ -f "$AGMSG_READY_DIR/ready.t__$enc" ]] || bad 'AR11b must not remove another role sentinel'
[[ $GUARD_RC -eq 0 ]] || bad 'AR11 a watcher-launch failure must never exit 1'

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
[[ $GUARD_RC -eq 0 ]] || bad 'AR12 a watcher-launch failure must never exit 1'

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
[[ $GUARD_RC -eq 0 ]] || bad 'AR6b a watcher-launch failure must never exit 1'

# --- AR6c: 他セッションの sentinel があっても started にしない ---
reset_case
enc=$(bash -c "source '$SD/agmsg-path.sh'; agmsg_encode_component 'ar-$$-6c'")
printf 'alive.1\n' > "$AGMSG_READY_DIR/ready.t__$enc"
printf '%s\n' "$$" > "$AGMSG_READY_DIR/watch.alive.1.pid"
CLAUDE_CODE_SESSION_ID=s6c AGMSG_STUB_MODE=held run_guard --type claude-code --name "ar-$$-6c"; out="$GUARD_OUT"
[[ "$out" == *"reason=held-by-other-session"* ]] || bad 'AR6c must not report started'
[[ $GUARD_RC -eq 0 ]] || bad 'AR6c a watcher-launch failure must never exit 1'

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
[[ $GUARD_RC -eq 0 ]] || bad 'AR6d a watcher-launch failure must never exit 1'
mv "$TMP/watch.sh.bak" "$AGMSG_DIR/watch.sh"; chmod +x "$AGMSG_DIR/watch.sh"

# --- AR19: ログのモードとユニーク性（異常系で取る） ---
reset_case
CLAUDE_CODE_SESSION_ID=s19 AGMSG_STUB_MODE=held run_guard --type claude-code --name "ar-$$-19"; out1="$GUARD_OUT"
[[ $GUARD_RC -eq 0 ]] || bad 'AR19 a watcher-launch failure must never exit 1'
CLAUDE_CODE_SESSION_ID=s19 AGMSG_STUB_MODE=held run_guard --type claude-code --name "ar-$$-19"; out2="$GUARD_OUT"
[[ $GUARD_RC -eq 0 ]] || bad 'AR19 a watcher-launch failure must never exit 1 (2nd)'
l1=$(printf '%s' "$out1" | sed -n 's/.* log=\([^ ]*\)$/\1/p')
l2=$(printf '%s' "$out2" | sed -n 's/.* log=\([^ ]*\)$/\1/p')
[[ "$l1" != "$l2" ]] || bad 'AR19 log paths must be unique'
for l in "$l1" "$l2"; do
  [[ "$(ls -l "$l" | cut -c1-10)" == "-rw-------" ]] || bad "AR19 $l is not 0600"
done

# --- AR23: 待機中の SIGTERM は reason=interrupted の 1 行になる ---
# EXIT trap の契約 (シグナル死でも出力表に無い行を出さない) の唯一の直接検証。
# trap から interrupted 分岐を外すと `reason=-` かつ `watcher=none` の行が出て
# assert_line が落ちる。run_guard は使えない — シグナルを送る相手が guard 本体である
# 必要があり、バックグラウンドのラッパー越しでは pid が取れないため。
# guard をラッパーのサブシェル越しに起こすのは、ジョブ表に載るのをラッパーだけにして
# `Terminated: 15` の通知行がスイートの stderr へ漏れないようにするため
# (ラッパー自身は printf で正常終了する)。撃つ相手は pgrep で辿った guard 本体。
reset_case
( CLAUDE_CODE_SESSION_ID=s23 AGMSG_STUB_INSTANCE_ID="s23.222" AGMSG_STUB_MODE=no-sentinel \
    AGMSG_READY_TIMEOUT=30 bash "$GUARD" --type claude-code --name "ar-$$-23" \
    >"$TMP/ar23.out" 2>/dev/null
  printf '%s' "$?" > "$TMP/ar23.rc" ) &
ar23_wrap=$!
# 手順 8 の待機ループへ入るまで待つ (pidfile が出れば watcher は起動済み)。
for _ in $(seq 1 100); do
  [[ -f "$AGMSG_READY_DIR/watch.s23.222.pid" ]] && break
  sleep 0.1
done
sleep 0.3
ar23=$(pgrep -P "$ar23_wrap" 2>/dev/null | head -1)
[[ -n "$ar23" ]] || bad 'AR23 could not locate the guard process'
kill -TERM "$ar23" 2>/dev/null
for _ in $(seq 1 100); do kill -0 "$ar23_wrap" 2>/dev/null || break; sleep 0.1; done
ar23_rc=$(cat "$TMP/ar23.rc" 2>/dev/null || echo 0)
out=$(cat "$TMP/ar23.out" 2>/dev/null || true)
assert_line "$out" AR23
[[ "$out" == *"reason=interrupted"* ]] \
  || bad "AR23 a SIGTERM during the wait must emit reason=interrupted (got $out)"
[[ "$out" == *"watcher=none"* ]] || bad "AR23 interrupted must be watcher=none (got $out)"
[[ "$out" =~ \ pid=[0-9]+\  ]] \
  || bad "AR23 the orphaned watcher pid must be reported for manual kill (got $out)"
[[ $ar23_rc -eq 143 ]] || bad "AR23 expected rc 143 from SIGTERM (got $ar23_rc)"
ar23_watcher=$(cat "$AGMSG_READY_DIR/watch.s23.222.pid" 2>/dev/null || true)
[[ -n "$ar23_watcher" ]] && FIXTURE_PIDS+=("$ar23_watcher")

# --- AR24: 20 桁の AGMSG_READY_TIMEOUT でも rc 0・1 行・有限時間で戻る ---
# 桁数上限を外すと `deadline=$(( 99999999999999999999 * 5 ))` が 64bit 算術で
# 1937910009842106363 へラップし、待機が事実上無限になる (旧実装ではさらに
# `seq 1 <巨大>` が xrealloc の致命エラーになり、EXIT trap すら走らずに 0 行 rc 2)。
# sentinel を書かない watcher を相手にして「既定の 15 秒で start-timeout する」
# ところまで見ないと上限が効いているか確かめられない。
reset_case
ar24_start=$SECONDS
AGMSG_READY_TIMEOUT=99999999999999999999 CLAUDE_CODE_SESSION_ID=s24 \
  AGMSG_STUB_INSTANCE_ID="s24.222" AGMSG_STUB_MODE=no-sentinel \
  run_guard --type claude-code --name "ar-$$-24"
out="$GUARD_OUT"
[[ $GUARD_RC -eq 0 ]] || bad "AR24 a 20-digit AGMSG_READY_TIMEOUT must not crash the guard (rc=$GUARD_RC)"
[[ -n "$out" ]] || bad 'AR24 the guard printed no line'
[[ "$out" == *"reason=start-timeout"* || "$out" == *"reason=orphan-watcher"* ]] \
  || bad "AR24 expected the capped default timeout to expire (got $out)"
[[ $((SECONDS - ar24_start)) -lt 40 ]] \
  || bad "AR24 the 4-digit cap did not apply (waited $((SECONDS - ar24_start))s)"

# --- AR25: 先頭ゼロの AGMSG_READY_TIMEOUT は既定値へ倒す ---
# bash 算術は先頭ゼロを 8 進として読む。`08` / `0018` は不正な 8 進数字で
# `deadline=$(( ... ))` ごと落ち (待機 0 回 + stderr 3 行)、`0000` は待機 0 回になる。
# どちらも健全な watcher を即 kill するか pidfile-missing と誤分類する。
for tv in 08 0018 0000; do
  reset_case
  AGMSG_READY_TIMEOUT="$tv" CLAUDE_CODE_SESSION_ID="s25$tv" AGMSG_STUB_INSTANCE_ID="s25$tv.222" \
    AGMSG_STUB_MODE=alive run_guard --type claude-code --name "ar-$$-25"
  out="$GUARD_OUT"
  [[ $GUARD_RC -eq 0 && "$out" == *"watcher=started"* ]] \
    || bad "AR25 AGMSG_READY_TIMEOUT=$tv must fall back to the default (got rc=$GUARD_RC $out)"
  [[ ! -s "$TMP/stderr.txt" ]] || bad "AR25 AGMSG_READY_TIMEOUT=$tv must keep stderr empty"
  tv_pid=$(printf '%s' "$out" | sed -n 's/.* pid=\([0-9]*\) .*/\1/p')
  [[ -n "$tv_pid" ]] && FIXTURE_PIDS+=("$tv_pid")
done

# --- AR26: agmsg-path.sh が読めなくても壊れない (send-prompt.sh の SP26 と対) ---
# guard は --name を [A-Za-z0-9._-]+ に限定済みで、エンコーダはその文字集合の恒等写像
# なので依存を持たない。source して読めなかった場合は READY_ENC が空になり、
# 手順 8 の glob が一切マッチせず自分の健全な watcher を start-timeout で殺す。
reset_case
mkdir -p "$TMP/nolib"
cp "$GUARD" "$TMP/nolib/ensure-agmsg-ready.sh"
RUN_GUARD_BIN="$TMP/nolib/ensure-agmsg-ready.sh" CLAUDE_CODE_SESSION_ID=s26 \
  AGMSG_STUB_INSTANCE_ID="s26.222" AGMSG_STUB_MODE=alive \
  run_guard --type claude-code --name "ar-$$-26"
out="$GUARD_OUT"
[[ $GUARD_RC -eq 0 && "$out" == *"watcher=started"* ]] \
  || bad "AR26 the guard must not depend on agmsg-path.sh (got rc=$GUARD_RC $out)"
[[ ! -s "$TMP/stderr.txt" ]] || bad 'AR26 the guard must keep stderr empty without agmsg-path.sh'
ar26_pid=$(printf '%s' "$out" | sed -n 's/.* pid=\([0-9]*\) .*/\1/p')
[[ -n "$ar26_pid" ]] && FIXTURE_PIDS+=("$ar26_pid")

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
