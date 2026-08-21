#!/usr/bin/env bash
# SKILL.md の Step 1g 冒頭にある agmsg readiness guard を、実際に SKILL.md から抽出して
# 実行する動的テスト。指示文の静的検査 (test-message-type-removed.sh の MT4-MT6) では
# 「rc 1 と rc 2 を別メッセージにしている」ことしか固定できないため、本物の
# verify-agmsg-ready.sh と組み合わせて終了コードと理由の文面まで実測する。
#
# 守っている不変条件:
#   GB1. agmsg 未インストール → exit 1、理由は「インストールされていない」
#   GB2. codex 親 (CODEX_THREAD_ID あり / CLAUDE_CODE_SESSION_ID なし) で seat が無い
#        → exit 1、理由は seat 未記録。**watcher の話をしてはならない**
#        (これが I1 の退行: --self が rc 2 で死ぬのを「watcher が無い」と誤報していた)
#   GB3. codex 親で seat が記録済み → exit 0
#   GB4. claude 親で watcher が生きている → exit 0
#   GB5. claude 親で watcher が無い → exit 1、理由は watcher 不在。seat の話はしない
#   GB6. どちらの id も無い (判定不能 = rc 2) → exit 1 だが理由は usage error であり、
#        「watcher が無い」と断定してはならない
#   GB7. Step 3「起床のたびに再導出する」の readiness 検査ブロックも同じ PARENT_ENGINE
#        分岐を持つ: codex 親 + seat 記録済み → rc 0
#   GB8. 同ブロックで codex 親 + seat 無し → rc 1。**rc 2 になってはならない**
#        (無条件 --self は codex 親で必ず rc 2 になり、SKILL.md 自身の「rc 2 = 判定不能
#         なので停止」規約に従うと all-Codex ディスパッチが最初の起床で自滅する)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/SKILL.md"
REAL_VERIFY="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/verify-agmsg-ready.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
fail=0
pass() { echo "PASS $1"; }
bad() { echo "FAIL $1"; fail=1; }

[[ -r "$SKILL" && -r "$REAL_VERIFY" ]] || { echo "FAIL GB0: SKILL.md / verify-agmsg-ready.sh が読めない"; exit 1; }

# --- Step 1g 冒頭の最初の bash ブロックを抽出する ---
GUARD_SRC="$TMP/guard.sh"
awk '
  /^### 1g\. Resolve Delivery/ { section=1; next }
  section && !capture && /^```bash$/ { capture=1; next }
  capture && /^```$/ { exit }
  capture { print }
' "$SKILL" > "$GUARD_SRC"
if ! grep -q 'verify-agmsg-ready.sh' "$GUARD_SRC"; then
  echo "FAIL GB0: Step 1g の guard ブロックを抽出できなかった (SKILL.md の構造変更?)"
  exit 1
fi

# --- 実行環境: HOME を差し替えて ~/.agents/... と AGMSG_RUN_DIR の既定を掌握する ---
HOME_DIR="$TMP/home"
AGMSG_SCRIPTS="$HOME_DIR/.agents/skills/agmsg/scripts"
RUN_DIR="$HOME_DIR/.agents/skills/agmsg/run"
SKILL_STUB="$TMP/skill"
mkdir -p "$AGMSG_SCRIPTS" "$RUN_DIR" "$SKILL_STUB/scripts" "$TMP/bin" "$TMP/repo"
cp "$REAL_VERIFY" "$SKILL_STUB/scripts/verify-agmsg-ready.sh"
cat > "$TMP/bin/git" <<'STUB'
#!/usr/bin/env bash
[[ "$1 $2" == "rev-parse --show-toplevel" ]] && { echo "$STUB_REPO"; exit 0; }
exit 0
STUB
chmod +x "$TMP/bin/git"
# team 名は dispatch-$(basename <repo root>) = dispatch-repo になる
TEAM_EXPECTED="dispatch-repo"

GUARD_RUN="$TMP/guard-run.sh"
sed -e "s|<SKILL_DIR>|$SKILL_STUB|g" "$GUARD_SRC" > "$GUARD_RUN"

run_guard() {  # 環境変数は呼び出し側で env として渡す
  env -i HOME="$HOME_DIR" PATH="$TMP/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    STUB_REPO="$TMP/repo" "$@" \
    bash -c 'set -e; source "$0"' "$GUARD_RUN" 2>&1
}

# --- Step 3 (起床のたびに状態を再導出する) の readiness 検査ブロックを抽出する。
#     アンカーは SKILL.md 側のコメント 1 行。Step 1g と同じ分岐であることを、静的な
#     文字列一致ではなく実行で固定する ---
WAKE_SRC="$TMP/wake.sh"
awk '
  /^```bash$/ { buf=""; capture=1; next }
  capture && /^```$/ { if (buf ~ /wake-readiness/) { printf "%s", buf; exit } capture=0; next }
  capture { buf = buf $0 "\n" }
' "$SKILL" > "$WAKE_SRC"
if ! grep -q 'verify-agmsg-ready.sh' "$WAKE_SRC"; then
  echo "FAIL GB0: Step 3 の起床時 readiness ブロックを抽出できなかった (アンカー wake-readiness が無い?)"
  exit 1
fi
WAKE_RUN="$TMP/wake-run.sh"
sed -e "s|<SKILL_DIR>|$SKILL_STUB|g" "$WAKE_SRC" > "$WAKE_RUN"
# ブロック自身は exit しないので、source した後に WAKE_READY_RC を出力させて判定する
printf '\necho "WAKE_READY_RC=$WAKE_READY_RC"\n' >> "$WAKE_RUN"

run_wake() {  # 環境変数は呼び出し側で env として渡す
  env -i HOME="$HOME_DIR" PATH="$TMP/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    STUB_REPO="$TMP/repo" "$@" \
    bash -c 'source "$0"' "$WAKE_RUN" 2>&1
}

install_agmsg() { : > "$AGMSG_SCRIPTS/send.sh"; }
uninstall_agmsg() { rm -f "$AGMSG_SCRIPTS/send.sh"; }
clear_run() { rm -f "$RUN_DIR"/*; }

# --- GB1: agmsg 未インストール ---
uninstall_agmsg; clear_run
out=$(run_guard CLAUDE_CODE_SESSION_ID=sess1); rc=$?
if [[ $rc -eq 1 ]] && grep -Fq 'is not installed' <<<"$out"; then
  pass "GB1 agmsg 未インストールは exit 1 + not installed ($rc)"
else
  bad "GB1 rc=$rc out=[$out]"
fi
install_agmsg

# --- GB2: codex 親 / seat 無し (I1 の退行そのもの) ---
clear_run
out=$(run_guard CODEX_THREAD_ID=thread-1); rc=$?
if [[ $rc -ne 1 ]]; then
  bad "GB2 codex 親 / seat 無しは exit 1 のはず (rc=$rc): $out"
elif grep -Fq 'no live agmsg watcher' <<<"$out"; then
  bad "GB2 codex 親に対して watcher 不在という誤った理由を出している: $out"
elif grep -Fq 'seat recorded as parent' <<<"$out" \
     && grep -Fq 'codex-record-session.sh' <<<"$out" \
     && grep -Fq "$TEAM_EXPECTED parent" <<<"$out"; then
  pass 'GB2 codex 親 / seat 無しは seat 未記録を名指しし、復旧コマンドに team と parent を含む'
else
  bad "GB2 理由の文面が seat 未記録になっていない: $out"
fi

# --- GB3: codex 親 / seat 記録済み ---
clear_run
printf 'thread-1\n' > "$RUN_DIR/codex-bridge.$TEAM_EXPECTED.parent.thread"
out=$(run_guard CODEX_THREAD_ID=thread-1); rc=$?
if [[ $rc -eq 0 ]] && ! grep -Fq '[error]' <<<"$out"; then
  pass 'GB3 codex 親 / seat 記録済みは exit 0 で通過する'
else
  bad "GB3 rc=$rc out=[$out]"
fi

# --- GB4: claude 親 / watcher 生存 ---
clear_run
printf '%s' "$$" > "$RUN_DIR/watch.sess1.pid"
out=$(run_guard CLAUDE_CODE_SESSION_ID=sess1); rc=$?
if [[ $rc -eq 0 ]] && ! grep -Fq '[error]' <<<"$out"; then
  pass 'GB4 claude 親 / watcher 生存は exit 0 で通過する'
else
  bad "GB4 rc=$rc out=[$out]"
fi

# --- GB5: claude 親 / watcher 無し ---
clear_run
out=$(run_guard CLAUDE_CODE_SESSION_ID=sess1); rc=$?
if [[ $rc -eq 1 ]] && grep -Fq 'no live agmsg watcher' <<<"$out" \
   && ! grep -Fq 'seat recorded' <<<"$out"; then
  pass 'GB5 claude 親 / watcher 無しは watcher 不在を名指しする (seat の話をしない)'
else
  bad "GB5 rc=$rc out=[$out]"
fi

# --- GB6: 判定不能 (rc 2) を watcher 不在と断定しない ---
clear_run
out=$(run_guard); rc=$?
if [[ $rc -ne 1 ]]; then
  bad "GB6 判定不能でも guard は exit 1 で止まるはず (rc=$rc): $out"
elif grep -Fq 'no live agmsg watcher' <<<"$out"; then
  bad "GB6 usage error を watcher 不在と誤報している (rc 1 と rc 2 を混同): $out"
elif grep -Fq 'UNDETERMINED' <<<"$out" && grep -Fq 'usage error' <<<"$out"; then
  pass 'GB6 判定不能は usage error として報告され、watcher 不在とは断定しない'
else
  bad "GB6 理由の文面が usage error になっていない: $out"
fi

# --- GB7: Step 3 の起床時検査、codex 親 / seat 記録済み → rc 0 ---
clear_run
install_agmsg
printf 'thread-1\n' > "$RUN_DIR/codex-bridge.$TEAM_EXPECTED.parent.thread"
out=$(run_wake CODEX_THREAD_ID=thread-1)
if grep -Fq 'WAKE_READY_RC=0' <<<"$out"; then
  pass 'GB7 起床時検査は codex 親 / seat 記録済みを rc 0 と判定する'
else
  bad "GB7 out=[$out]"
fi

# --- GB8: Step 3 の起床時検査、codex 親 / seat 無し → rc 1 (rc 2 ではない) ---
clear_run
out=$(run_wake CODEX_THREAD_ID=thread-1)
if grep -Fq 'WAKE_READY_RC=2' <<<"$out"; then
  bad "GB8 起床時検査が codex 親へ --self を投げている (rc 2 = 判定不能。最初の起床で自滅する): $out"
elif grep -Fq 'WAKE_READY_RC=1' <<<"$out"; then
  pass 'GB8 起床時検査は codex 親 / seat 無しを rc 1 (到達不能) と判定する'
else
  bad "GB8 out=[$out]"
fi

[[ $fail -eq 0 ]] && echo '--- all tests passed ---' || echo '--- failures ---'
exit "$fail"
