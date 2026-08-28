#!/usr/bin/env bash
# work-signal.sh の回帰テスト。
#
# 守っている不変条件:
#   WS1. 初回は changed=first、直後の再実行は changed=no
#   WS2. 新しいファイルに触れると changed=yes (dirty 集合の変化)
#   WS3. 既に dirty なファイルを再編集しても changed=yes
#        (porcelain だけを見ていると取りこぼす。mtime 成分が要る理由)
#   WS4. コミットが進むと changed=yes
#   WS5. exit 契約: 0 = 判定できた / 1 = worktree を読めない / 2 = 使用法エラー
#   WS6. --surface で read-screen が失敗したら changed=unknown を返し、state を更新しない
#        (画面成分が欠けた信号を素直に比較すると「ペイン死亡」を「動いている」と読み違える)
#   WS7. cmux-codex-exec の bin/work-signal が dispatch 版と同一内容
#        (両プラグインは独立にインストールされるのでコピーを持つ。乖離をここで検出する)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/work-signal.sh"
COPY="$SCRIPT_DIR/../../cmux-codex-exec/bin/work-signal"
[[ -f "$BIN" ]] || { echo "FAIL: スクリプトが見つからない: $BIN"; exit 2; }

fail=0
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

WT="$TMP/wt"
mkdir -p "$WT"
git -C "$WT" init -q .
git -C "$WT" config user.email t@example.com
git -C "$WT" config user.name tester
echo a > "$WT/a.txt"
git -C "$WT" add -A
git -C "$WT" commit -qm init

STATE="$TMP/state"
# cmux を PATH から締め出し、--surface 未指定の経路が cmux に依存しないことも同時に担保する
run() { PATH="/usr/bin:/bin:/usr/sbin:/sbin" bash "$BIN" "$WT" --state "$STATE" "$@"; }
changed_of() { sed -n 's/.*changed=\([a-z]*\).*/\1/p' <<< "$1"; }

# --- WS1: 初回 first / 再実行 no ---
c1=$(changed_of "$(run)")
c2=$(changed_of "$(run)")
if [[ "$c1" == "first" && "$c2" == "no" ]]; then
  echo "PASS WS1: 初回 first / 無変化 no"
else
  echo "FAIL WS1: first/no を期待したが $c1/$c2"; fail=1
fi

# --- WS2: 新しいファイル ---
echo b > "$WT/b.txt"
if [[ "$(changed_of "$(run)")" == "yes" ]]; then
  echo "PASS WS2: 新しいファイルで changed=yes"
else
  echo "FAIL WS2: 新しいファイルを検出できない"; fail=1
fi

# --- WS3: 同じ dirty ファイルの再編集 ---
[[ "$(changed_of "$(run)")" == "no" ]] || { echo "FAIL WS3: 準備段階で無変化にならない"; fail=1; }
sleep 1.1   # mtime の解像度は 1 秒なので、意図的に跨がせる
echo bb >> "$WT/b.txt"
if [[ "$(changed_of "$(run)")" == "yes" ]]; then
  echo "PASS WS3: 既存 dirty の再編集で changed=yes"
else
  echo "FAIL WS3: 同一ファイルの再編集を取りこぼす (mtime 成分が効いていない)"; fail=1
fi

# --- WS4: コミット ---
[[ "$(changed_of "$(run)")" == "no" ]] || { echo "FAIL WS4: 準備段階で無変化にならない"; fail=1; }
git -C "$WT" add -A
git -C "$WT" commit -qm second
if [[ "$(changed_of "$(run)")" == "yes" ]]; then
  echo "PASS WS4: コミットで changed=yes"
else
  echo "FAIL WS4: コミットを検出できない"; fail=1
fi

# --- WS5: exit 契約 ---
bad=0
bash "$BIN" "$TMP/missing" --state "$STATE" >/dev/null 2>&1; [[ $? -eq 1 ]] || bad=1
mkdir -p "$TMP/plain"
bash "$BIN" "$TMP/plain" --state "$STATE" >/dev/null 2>&1; [[ $? -eq 1 ]] || bad=1
bash "$BIN" "$WT" >/dev/null 2>&1;                          [[ $? -eq 2 ]] || bad=1
bash "$BIN" >/dev/null 2>&1;                                [[ $? -eq 2 ]] || bad=1
bash "$BIN" "$WT" --state >/dev/null 2>&1;                  [[ $? -eq 2 ]] || bad=1
bash "$BIN" "$WT" --state "$STATE" extra >/dev/null 2>&1;   [[ $? -eq 2 ]] || bad=1
if [[ $bad -eq 0 ]]; then
  echo "PASS WS5: exit 0/1/2 の契約を守る"
else
  echo "FAIL WS5: exit コードの契約が崩れている"; fail=1
fi

# --- WS6: read-screen 失敗時は unknown、かつ state を汚さない ---
# cmux を見つけられない PATH で --surface を渡すと screen=unavailable になる
before=$(cat "$STATE")
out=$(PATH="/usr/bin:/bin" bash "$BIN" "$WT" --state "$STATE" --surface surface:1 2>/dev/null)
after=$(cat "$STATE")
if [[ "$(changed_of "$out")" == "unknown" ]] && grep -q 'screen=unavailable' <<< "$out" \
  && [[ "$before" == "$after" ]]; then
  echo "PASS WS6: read-screen 失敗は unknown で state を更新しない"
else
  echo "FAIL WS6: unknown / state 保持のどちらかが崩れている: $out"; fail=1
fi

# --- WS7: cmux-codex-exec のコピーと同一 ---
if [[ ! -f "$COPY" ]]; then
  echo "FAIL WS7: コピーが存在しない: $COPY"; fail=1
elif diff -q "$BIN" "$COPY" >/dev/null; then
  echo "PASS WS7: cmux-codex-exec の bin/work-signal が dispatch 版と同一"
else
  echo "FAIL WS7: 2 つの work-signal が乖離している"; fail=1
fi

[[ $fail -eq 0 ]] && echo "--- すべて PASS ---" || echo "--- FAIL あり ---"
exit $fail
