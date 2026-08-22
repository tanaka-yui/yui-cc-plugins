#!/usr/bin/env bash
# config-edit.sh の単体テスト。
#
# 守っている不変条件:
#   CE1. --set が存在しない config を新規作成する
#   CE2. --set が既知外のキー (shell_ready_ms) を保持する = 置換ではなくマージ
#   CE3. --unset が指定キーだけ削除し、他のキーを残す
#   CE4. review_mode は JSON string として書かれる
#   CE5. 未知キーは exit 2
#   CE6. キーの範囲外の値は exit 2
#   CE7. 既存 config が壊れた JSON なら exit 1 かつ元ファイルを破壊しない
#   CE8. 書き込み後に mktemp の残骸 (config.json.XXXXXX) が残らない
#   CE9. --get は値を返し、未設定キー / ファイル未存在では空を返して exit 0
#  CE10. 複数の --set / --unset が 1 回の呼び出しでまとめて反映される
#  CE11. モードの同時指定 (--set と --show など) は exit 2
#  CE12. 入れ子キー runner.<role>.<field> の set / get / unset
#  CE13. --unset runner がトップレベルごと消し、空オブジェクトを残さない
#  CE14. --set runner は受け付けない (unset 専用)
#  CE15. 旧 4 キー (design_runner / review_runner / exec_choice / prewarm) は exit 2
#  CE16. review_mode の "ask" は exit 2
#  CE17. effort の engine 解決順 4 段。--set の並び順に依存しない
#  CE18. --engine <role>=<engine> が繰り返せる
#  CE19. runner 名の禁止文字を直接渡すと exit 2 かつ原本不変
#  CE20. model の禁止文字 / 内部空白の許容
#  CE21. effort の engine 別 allowlist (codex に max は無い)
#  CE22. reset 相当 (--unset review_mode --unset runner) が第三者キーを温存する
#  CE23. read モードでは --engine / --runners を拒否し、指定 engine も検証する
#  CE24. 不正な入れ子 role / field を set / get / unset で拒否する

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
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
bash "$EDIT" --config "$C" --set runner.design.runner=ccf >/dev/null 2>&1
if [[ "$(jq -r '.shell_ready_ms.baseline_ms' "$C")" == '123' \
   && "$(jq -r '.shell_ready_ms.samples | length' "$C")" == '3' \
   && "$(jq -r '.review_mode' "$C")" == 'off' \
   && "$(jq -r '.runner.design.runner' "$C")" == 'ccf' ]]; then
  ok 'CE2: --set が未知キー shell_ready_ms を保持する'
else
  bad "CE2: --set が未知キーを消した ($(cat "$C"))"
fi

# CE3: --unset は指定キーだけ消す
reset_config
printf '{"shell_ready_ms":{"baseline_ms":7},"runner":{"design":{"runner":"ccf"}},"review_mode":"on"}\n' > "$C"
bash "$EDIT" --config "$C" --unset runner.design.runner >/dev/null 2>&1
if [[ "$(jq -r '.runner.design | has("runner")' "$C")" == 'false' \
   && "$(jq -r '.review_mode' "$C")" == 'on' \
   && "$(jq -r '.shell_ready_ms.baseline_ms' "$C")" == '7' ]]; then
  ok 'CE3: --unset が指定キーだけ削除する'
else
  bad "CE3: --unset の範囲 ($(cat "$C"))"
fi

# CE4: review_mode は JSON string
reset_config
bash "$EDIT" --config "$C" --set review_mode=off >/dev/null 2>&1
if [[ "$(jq -r '.review_mode | type' "$C")" == 'string' && "$(jq -r '.review_mode' "$C")" == 'off' ]]; then
  ok 'CE4: review_mode が JSON string で書かれる'
else
  bad "CE4: review_mode の型 ($(jq -r '.review_mode | type' "$C" 2>/dev/null))"
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
[[ $rc -eq 2 ]] && ok 'CE5: --unset の未知キーも exit 2' || bad "CE5: --unset の未知キー (rc=$rc)"

# CE6: 範囲外の値
for pair in 'review_mode=maybe' 'review_mode=ask' 'runner.design.runner='; do
  out=$(bash "$EDIT" --config "$C" --set "$pair" 2>&1); rc=$?
  [[ $rc -eq 2 ]] && ok "CE6: 不正値 $pair は exit 2" || bad "CE6: 不正値 $pair (rc=$rc out=[$out])"
done
reset_config
for pair in 'review_mode=on' 'review_mode=off' 'runner.design.runner=ccf'; do
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
[[ "$leftovers" == '0' ]] && ok 'CE8: mktemp の残骸が残らない' || bad "CE8: 残骸 $leftovers 件"
rm -f "$TMP/fresh.json"

# CE9: --get
reset_config
printf '{"runner":{"design":{"runner":"ccf"}}}\n' > "$C"
got=$(bash "$EDIT" --config "$C" --get runner.design.runner 2>/dev/null); rc=$?
[[ $rc -eq 0 && "$got" == 'ccf' ]] || bad "CE9: --get の値 (rc=$rc got=[$got])"
got=$(bash "$EDIT" --config "$C" --get review_mode 2>/dev/null); rc=$?
[[ $rc -eq 0 && -z "$got" ]] || bad "CE9: 未設定キーの --get (rc=$rc got=[$got])"
got=$(bash "$EDIT" --config "$TMP/none.json" --get review_mode 2>/dev/null); rc=$?
[[ $rc -eq 0 && -z "$got" ]] || bad "CE9: ファイル未存在の --get (rc=$rc got=[$got])"
ok 'CE9: --get は値 / 空 を返して exit 0'

# CE10: 複数操作が 1 回でまとまる
reset_config
printf '{"shell_ready_ms":{"baseline_ms":1},"review_mode":"off","runner":{"design":{"runner":"old"},"exec":{"runner":"cx"}}}\n' > "$C"
bash "$EDIT" --config "$C" \
  --set runner.design.runner=ccf --set runner.exec.model='gpt 5 sol' --set review_mode=on \
  --unset runner.design.runner --unset review_mode >/dev/null 2>&1
if [[ "$(jq -r '.runner.design | has("runner")' "$C")" == 'false' \
   && "$(jq -r '.runner.exec.runner' "$C")" == 'cx' \
   && "$(jq -r '.runner.exec.model' "$C")" == 'gpt 5 sol' \
   && "$(jq -r 'has("review_mode")' "$C")" == 'false' \
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

# CE23: read モードの mutation helper と engine の検証
reset_config
printf '{"review_mode":"on","runner":{"design":{"runner":"ccf"}}}\n' > "$C"
out=$(bash "$EDIT" --config "$C" --engine bogus=gemini --get review_mode 2>&1); rc=$?
[[ $rc -eq 2 && "$out" == *'unknown role for --engine: bogus'* ]] \
  && ok 'CE23a: --get でも --engine の role を検証する' \
  || bad "CE23a: rc=$rc out=[$out]"
out=$(bash "$EDIT" --config "$C" --engine design=gemini --show 2>&1); rc=$?
[[ $rc -eq 2 && "$out" == *"invalid engine for role 'design': gemini"* ]] \
  && ok 'CE23b: --show でも --engine の値を検証する' \
  || bad "CE23b: rc=$rc out=[$out]"
out=$(bash "$EDIT" --config "$C" --engine design=claude --get review_mode 2>&1); rc=$?
[[ $rc -eq 2 && "$out" == *'--engine is only valid with mutations'* ]] \
  && ok 'CE23c: --get は有効な --engine も拒否する' \
  || bad "CE23c: rc=$rc out=[$out]"
out=$(bash "$EDIT" --config "$C" --runners "$TMP/runners.json" --show 2>&1); rc=$?
[[ $rc -eq 2 && "$out" == *'--runners is only valid with mutations'* ]] \
  && ok 'CE23d: --show は --runners を拒否する' \
  || bad "CE23d: rc=$rc out=[$out]"

# CE24: allowlist 外の role / field は全境界で拒否する
reset_config
printf '{"review_mode":"on","runner":{"design":{"runner":"ccf"}}}\n' > "$C"
before=$(cat "$C")
for key in runner.unknown.model runner.design.unknown; do
  out=$(bash "$EDIT" --config "$C" --set "$key=value" 2>&1); rc=$?
  [[ $rc -eq 2 && "$out" == *"unknown key: $key"* && "$(cat "$C")" == "$before" ]] \
    && ok "CE24: --set $key を拒否し原本不変" \
    || bad "CE24: --set $key (rc=$rc out=[$out])"
  out=$(bash "$EDIT" --config "$C" --unset "$key" 2>&1); rc=$?
  [[ $rc -eq 2 && "$out" == *"unknown key: $key"* && "$(cat "$C")" == "$before" ]] \
    && ok "CE24: --unset $key を拒否し原本不変" \
    || bad "CE24: --unset $key (rc=$rc out=[$out])"
  out=$(bash "$EDIT" --config "$C" --get "$key" 2>&1); rc=$?
  [[ $rc -eq 2 && "$out" == *"unknown key: $key"* ]] \
    && ok "CE24: --get $key を拒否する" \
    || bad "CE24: --get $key (rc=$rc out=[$out])"
done

# CE12: 入れ子キー
reset_config
bash "$EDIT" --config "$C" --engine design=claude \
  --set runner.design.runner=ccf --set runner.design.model='opus[1m]' \
  --set runner.design.effort=xhigh >/dev/null 2>&1
if [[ "$(jq -r '.runner.design.runner' "$C")" == 'ccf' \
   && "$(jq -r '.runner.design.model' "$C")" == 'opus[1m]' \
   && "$(jq -r '.runner.design.effort' "$C")" == 'xhigh' ]]; then
  ok 'CE12a: 入れ子キーの --set'
else
  bad "CE12a: $(cat "$C")"
fi
[[ "$(bash "$EDIT" --config "$C" --get runner.design.model)" == 'opus[1m]' ]] \
  && ok 'CE12b: 入れ子キーの --get' || bad 'CE12b'
bash "$EDIT" --config "$C" --unset runner.design.model >/dev/null 2>&1
[[ "$(jq -r '.runner.design | has("model")' "$C")" == 'false' \
&& "$(jq -r '.runner.design.runner' "$C")" == 'ccf' ]] \
  && ok 'CE12c: 入れ子キーの --unset' || bad 'CE12c'

# CE12d: --unset runner.<role> はそのロールだけ消し、他ロールを温存する
reset_config
printf '%s\n' '{"runner":{"design":{"runner":"ccf","model":"opus[1m]"},"exec":{"runner":"cx","effort":"high"}},"review_mode":"on"}' > "$C"
bash "$EDIT" --config "$C" --unset runner.design >/dev/null 2>&1
if [[ "$(jq -r '.runner | has("design")' "$C")" == 'false' \
   && "$(jq -r '.runner.exec.runner' "$C")" == 'cx' \
   && "$(jq -r '.runner.exec.effort' "$C")" == 'high' \
   && "$(jq -r '.review_mode' "$C")" == 'on' ]]; then
  ok 'CE12d: --unset runner.<role> はそのロールだけ消す'
else
  bad "CE12d: $(cat "$C")"
fi

# CE13 / CE22: reset 相当
reset_config
printf '%s\n' '{"shell_ready_ms":{"baseline_ms":7},"loop":{"task_timeout_min":45,"other":1},"review_mode":"on","runner":{"design":{"runner":"ccf"},"exec":{"runner":"ccf"}}}' > "$C"
before_loop=$(jq -cS '.loop' "$C"); before_srm=$(jq -cS '.shell_ready_ms' "$C")
bash "$EDIT" --config "$C" --unset review_mode --unset runner >/dev/null 2>&1
if [[ "$(jq -r 'has("review_mode")' "$C")" == 'false' \
   && "$(jq -r 'has("runner")' "$C")" == 'false' \
   && "$(jq -cS '.loop' "$C")" == "$before_loop" \
   && "$(jq -cS '.shell_ready_ms' "$C")" == "$before_srm" ]]; then
  ok 'CE13/CE22: reset が役割キーだけ消し loop と shell_ready_ms を温存する'
else
  bad "CE13/CE22: $(cat "$C")"
fi

# CE14 / CE15 / CE16: 拒否
reset_config; printf '{}\n' > "$C"; before=$(cat "$C")
for k in 'runner=x' 'design_runner=ccf' 'review_runner=ccf' 'exec_choice=codex' 'prewarm=true' 'review_mode=ask'; do
  bash "$EDIT" --config "$C" --set "$k" >/dev/null 2>&1
  rc=$?
  [[ $rc -eq 2 && "$(cat "$C")" == "$before" ]] \
    && ok "CE14-16: --set $k を exit 2 で拒否し原本不変" \
    || bad "CE14-16: --set $k (rc=$rc)"
done
for k in design_runner review_runner exec_choice prewarm; do
  bash "$EDIT" --config "$C" --unset "$k" >/dev/null 2>&1
  [[ $? -eq 2 ]] && ok "CE15: --unset $k を exit 2 で拒否" || bad "CE15: --unset $k"
done

# CE17 / CE18: effort の engine 解決順と --engine の反復
reset_config
printf '%s\n' '{"runner":{"design":{"runner":"ccf"},"exec":{"runner":"cx"}}}' > "$C"
cat > "$TMP/runners.json" <<'JSON'
{"default":"ccf","runners":[{"name":"ccf","command":"ccf","engine":"claude"},
                            {"name":"cx","command":"codex","engine":"codex"}]}
JSON
# 対象ファイル内の runner から engine を引く (解決順 3)
bash "$EDIT" --config "$C" --runners "$TMP/runners.json" \
  --set runner.design.effort=max --set runner.exec.effort=minimal >/dev/null 2>&1
[[ $? -eq 0 && "$(jq -r '.runner.design.effort' "$C")" == 'max' \
&& "$(jq -r '.runner.exec.effort' "$C")" == 'minimal' ]] \
  && ok 'CE17a: 対象ファイルの runner から engine を引いて 2 ロールを 1 コールで更新' \
  || bad "CE17a: $(cat "$C")"
# --engine の反復 (解決順 2)。config に runner が無いケース
reset_config; printf '{}\n' > "$C"
bash "$EDIT" --config "$C" --runners "$TMP/runners.json" \
  --engine design=claude --engine exec=codex \
  --set runner.design.effort=max --set runner.exec.effort=minimal >/dev/null 2>&1
[[ $? -eq 0 && "$(jq -r '.runner.design.effort' "$C")" == 'max' \
&& "$(jq -r '.runner.exec.effort' "$C")" == 'minimal' ]] \
  && ok 'CE18: --engine <role>=<engine> の反復で異種 engine を 1 コール更新' \
  || bad "CE18: $(cat "$C")"
# 解決順 1 が 2 より優先。--set の並び順に依存しない
reset_config; printf '{}\n' > "$C"
bash "$EDIT" --config "$C" --runners "$TMP/runners.json" --engine exec=claude \
  --set runner.exec.effort=minimal --set runner.exec.runner=cx >/dev/null 2>&1
[[ $? -eq 0 && "$(jq -r '.runner.exec.effort' "$C")" == 'minimal' ]] \
  && ok 'CE17b: 同一バッチの runner が --engine より優先し、順序に依存しない' || bad 'CE17b'
# engine がどこからも決まらない
reset_config; printf '{}\n' > "$C"
bash "$EDIT" --config "$C" --runners "$TMP/runners.json" --set runner.exec.effort=high >/dev/null 2>&1
[[ $? -eq 2 ]] && ok 'CE17c: engine が決まらないと exit 2' || bad 'CE17c'

# CE19 / CE20 / CE21: 値の検証（旧 runner 編集テストからの移植）
reset_config; printf '{}\n' > "$C"; before=$(cat "$C")
for v in '' ' x' 'x ' "q'uote" 'd"q' "b$(printf '\140')t" 'd$l' 'b\s' 'bang!'; do
  bash "$EDIT" --config "$C" --set "runner.design.runner=$v" >/dev/null 2>&1
  [[ $? -eq 2 && "$(cat "$C")" == "$before" ]] || bad "CE19: runner 名 '$v' を受理した"
  bash "$EDIT" --config "$C" --set "runner.design.model=$v" >/dev/null 2>&1
  [[ $? -eq 2 && "$(cat "$C")" == "$before" ]] || bad "CE20: model '$v' を受理した"
done
ok 'CE19/CE20: runner 名と model の禁止文字を exit 2 で拒否し原本不変'
bash "$EDIT" --config "$C" --engine design=claude --set 'runner.design.model=gpt 5 sol' >/dev/null 2>&1
[[ $? -eq 0 ]] && ok 'CE20b: model の内部空白は許容' || bad 'CE20b'
reset_config; printf '{}\n' > "$C"
bash "$EDIT" --config "$C" --runners "$TMP/runners.json" --engine design=codex \
  --set runner.design.effort=max >/dev/null 2>&1
[[ $? -eq 2 ]] && ok 'CE21: codex に max は無いので exit 2' || bad 'CE21'

if [[ $fail -eq 0 ]]; then
  echo '--- all tests passed ---'
else
  echo '--- failures ---'
fi
exit "$fail"
