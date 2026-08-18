#!/usr/bin/env bash
# config-edit.sh の単体テスト。
#
# 守っている不変条件:
#   CE1. --set が存在しない config を新規作成する
#   CE2. --set が既知外のキー (shell_ready_ms) を保持する = 置換ではなくマージ
#   CE3. --unset が指定キーだけ削除し、他のキーを残す
#   CE4. prewarm は JSON boolean として書かれる (文字列 "true" ではない)
#   CE5. 未知キーは exit 2
#   CE6. キーの範囲外の値は exit 2
#   CE7. 既存 config が壊れた JSON なら exit 1 かつ元ファイルを破壊しない
#   CE8. 書き込み後に mktemp の残骸 (config.json.XXXXXX) が残らない
#   CE9. --get は値を返し、未設定キー / ファイル未存在では空を返して exit 0
#  CE10. 複数の --set / --unset が 1 回の呼び出しでまとめて反映される
#  CE11. モードの同時指定 (--set と --show など) は exit 2

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EDIT="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/config-edit.sh"
fail=0

[[ -f "$EDIT" ]] || { echo "FAIL: config-edit.sh が無い: $EDIT"; exit 2; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

bad() { echo "FAIL $1"; fail=1; }
ok() { echo "PASS $1"; }

C="$TMP/config.json"
reset_config() { rm -f "$TMP"/config.json*; }

# CE1: 新規作成
reset_config
bash "$EDIT" --config "$C" --set review_mode=on >/dev/null 2>&1
rc=$?
if [[ $rc -eq 0 && -f "$C" && "$(jq -r '.review_mode' "$C")" == 'on' ]]; then
  ok 'CE1: --set が config を新規作成する'
else
  bad "CE1: --set の新規作成 (rc=$rc)"
fi

# CE2: 未知キーの保持 (最重要 — terminal-wait.sh 所有の shell_ready_ms を消さない)
reset_config
printf '{"shell_ready_ms":{"baseline_ms":123,"samples":[1,2,3]},"review_mode":"off"}\n' > "$C"
bash "$EDIT" --config "$C" --set design_runner=codex >/dev/null 2>&1
if [[ "$(jq -r '.shell_ready_ms.baseline_ms' "$C")" == '123' \
   && "$(jq -r '.shell_ready_ms.samples | length' "$C")" == '3' \
   && "$(jq -r '.review_mode' "$C")" == 'off' \
   && "$(jq -r '.design_runner' "$C")" == 'codex' ]]; then
  ok 'CE2: --set が未知キー shell_ready_ms を保持する'
else
  bad "CE2: --set が未知キーを消した ($(cat "$C"))"
fi

# CE3: --unset は指定キーだけ消す
reset_config
printf '{"shell_ready_ms":{"baseline_ms":7},"design_runner":"codex","review_mode":"on"}\n' > "$C"
bash "$EDIT" --config "$C" --unset design_runner >/dev/null 2>&1
if [[ "$(jq -r 'has("design_runner")' "$C")" == 'false' \
   && "$(jq -r '.review_mode' "$C")" == 'on' \
   && "$(jq -r '.shell_ready_ms.baseline_ms' "$C")" == '7' ]]; then
  ok 'CE3: --unset が指定キーだけ削除する'
else
  bad "CE3: --unset の範囲 ($(cat "$C"))"
fi

# CE4: prewarm は boolean
reset_config
bash "$EDIT" --config "$C" --set prewarm=false >/dev/null 2>&1
if [[ "$(jq -r '.prewarm | type' "$C")" == 'boolean' && "$(jq -r '.prewarm' "$C")" == 'false' ]]; then
  ok 'CE4: prewarm が JSON boolean で書かれる'
else
  bad "CE4: prewarm の型 ($(jq -r '.prewarm | type' "$C" 2>/dev/null))"
fi

# CE5: 未知キー
reset_config
out=$(bash "$EDIT" --config "$C" --set foo=bar 2>&1); rc=$?
if [[ $rc -eq 2 ]] && grep -q 'unknown key' <<<"$out"; then
  ok 'CE5: 未知キーは exit 2'
else
  bad "CE5: 未知キー (rc=$rc out=[$out])"
fi
out=$(bash "$EDIT" --config "$C" --unset foo 2>&1); rc=$?
if [[ $rc -eq 2 ]]; then
  ok 'CE5: --unset の未知キーも exit 2'
else
  bad "CE5: --unset の未知キー (rc=$rc)"
fi

# CE6: 範囲外の値
for pair in 'review_mode=maybe' 'exec_choice=haiku' 'exec_choice=opus 1m' 'exec_choice=sonnet' 'prewarm=yes' 'design_runner='; do
  out=$(bash "$EDIT" --config "$C" --set "$pair" 2>&1); rc=$?
  if [[ $rc -eq 2 ]]; then
    ok "CE6: 不正値 $pair は exit 2"
  else
    bad "CE6: 不正値 $pair (rc=$rc out=[$out])"
  fi
done
# 正当な値は通る
reset_config
for pair in 'review_mode=ask' 'exec_choice=claude' 'exec_choice=codex' 'exec_choice=ask' 'design_runner=ask'; do
  bash "$EDIT" --config "$C" --set "$pair" >/dev/null 2>&1 || bad "CE6: 正当値 $pair が拒否された"
done
ok 'CE6: 正当値は受理される'

# CE7: 壊れた JSON
reset_config
printf 'not json at all' > "$C"
out=$(bash "$EDIT" --config "$C" --set review_mode=on 2>&1); rc=$?
if [[ $rc -eq 1 && "$(cat "$C")" == 'not json at all' ]]; then
  ok 'CE7: 壊れた JSON は exit 1 かつ元ファイルを破壊しない'
else
  bad "CE7: 壊れた JSON (rc=$rc content=[$(cat "$C")])"
fi

# CE8: mktemp の残骸が残らない
reset_config
printf 'not json at all' > "$C"
bash "$EDIT" --config "$C" --set review_mode=on >/dev/null 2>&1
bash "$EDIT" --config "$TMP/fresh.json" --set review_mode=on >/dev/null 2>&1
leftovers=$(find "$TMP" -maxdepth 1 -name 'config.json.*' -o -maxdepth 1 -name 'fresh.json.*' | wc -l | tr -d ' ')
if [[ "$leftovers" == '0' ]]; then
  ok 'CE8: mktemp の残骸が残らない'
else
  bad "CE8: 残骸 $leftovers 件"
fi
rm -f "$TMP/fresh.json"

# CE9: --get
reset_config
printf '{"design_runner":"codex"}\n' > "$C"
got=$(bash "$EDIT" --config "$C" --get design_runner 2>/dev/null); rc=$?
[[ $rc -eq 0 && "$got" == 'codex' ]] || bad "CE9: --get の値 (rc=$rc got=[$got])"
got=$(bash "$EDIT" --config "$C" --get review_mode 2>/dev/null); rc=$?
[[ $rc -eq 0 && -z "$got" ]] || bad "CE9: 未設定キーの --get (rc=$rc got=[$got])"
got=$(bash "$EDIT" --config "$TMP/none.json" --get review_mode 2>/dev/null); rc=$?
[[ $rc -eq 0 && -z "$got" ]] || bad "CE9: ファイル未存在の --get (rc=$rc got=[$got])"
ok 'CE9: --get は値 / 空 を返して exit 0'

# CE10: 複数操作が 1 回でまとまる
reset_config
printf '{"shell_ready_ms":{"baseline_ms":1},"review_mode":"off","exec_choice":"claude"}\n' > "$C"
bash "$EDIT" --config "$C" \
  --set design_runner=codex --set review_runner=codex --set prewarm=true \
  --unset review_mode --unset exec_choice >/dev/null 2>&1
if [[ "$(jq -r '.design_runner' "$C")" == 'codex' \
   && "$(jq -r '.review_runner' "$C")" == 'codex' \
   && "$(jq -r '.prewarm' "$C")" == 'true' \
   && "$(jq -r 'has("review_mode")' "$C")" == 'false' \
   && "$(jq -r 'has("exec_choice")' "$C")" == 'false' \
   && "$(jq -r '.shell_ready_ms.baseline_ms' "$C")" == '1' ]]; then
  ok 'CE10: 複数の --set / --unset が 1 回で反映される'
else
  bad "CE10: 複数操作 ($(cat "$C"))"
fi

# CE11: モードの同時指定
reset_config
bash "$EDIT" --config "$C" --set review_mode=on --show >/dev/null 2>&1; rc=$?
[[ $rc -eq 2 ]] || bad "CE11: --set と --show の同時指定 (rc=$rc)"
bash "$EDIT" --config "$C" --get review_mode --show >/dev/null 2>&1; rc=$?
[[ $rc -eq 2 ]] || bad "CE11: --get と --show の同時指定 (rc=$rc)"
bash "$EDIT" --config "$C" >/dev/null 2>&1; rc=$?
[[ $rc -eq 2 ]] || bad "CE11: モード未指定 (rc=$rc)"
bash "$EDIT" --show >/dev/null 2>&1; rc=$?
[[ $rc -eq 2 ]] || bad "CE11: --config 未指定 (rc=$rc)"
ok 'CE11: モード指定の検証'

if [[ $fail -eq 0 ]]; then
  echo '--- all tests passed ---'
else
  echo '--- failures ---'
fi
exit "$fail"
