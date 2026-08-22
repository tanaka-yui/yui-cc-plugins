#!/usr/bin/env bash
# config-resolve.sh の単体テスト。
#
# 守っている不変条件:
#   CR1. (role, field) 単位の precedence: project が field 単位で global を上書きする
#   CR2. global runner + project effort-only が成立する (ロールごと置換にしない)
#   CR3. effort の小文字正規化が解決経路に効く
#   CR4. 組込み既定値の表
#   CR5. runner 未設定 / runners.json に不在なら exit 2 (ペインを作らせない)
#   CR6. codex の review 2 ロールは model 必須、design / exec は省略可
#   CR7. model のメタ文字は読み取り時にも拒否する
#   CR8. --set が最優先レイヤーとして適用される
#   CR9. review_mode の終端規則 (無効レイヤーを飛ばして最後は既定 on)
#  CR10. レイヤー単位 fallback の負例 (不正値が出力に残らない)
#  CR11. review_mode=off では review 2 ロールを解決しない
#  CR12. model が決まらないロールはキーごと省略される
#  CR14. 壊れた JSON / 読めないファイルは exit 1 (設定エラーの exit 2 と区別する)

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESOLVE="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/config-resolve.sh"
fail=0
bad() { echo "FAIL $1"; fail=1; }
ok() { echo "PASS $1"; }
[[ -f "$RESOLVE" ]] || { echo "FAIL: config-resolve.sh が無い: $RESOLVE"; exit 2; }

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
export DISPATCH_CONFIG_HOME="$TMP/home"
PROJ="$TMP/repo"
mkdir -p "$DISPATCH_CONFIG_HOME" "$PROJ/.dispatch"

write_runners() {
  cat > "$DISPATCH_CONFIG_HOME/runners.json" <<'JSON'
{"default":"ccf","runners":[
  {"name":"ccf","command":"ccf","engine":"claude"},
  {"name":"cx","command":"codex","engine":"codex"}
]}
JSON
}
write_global() { printf '%s\n' "$1" > "$DISPATCH_CONFIG_HOME/config.json"; }
write_project() { printf '%s\n' "$1" > "$PROJ/.dispatch/config.json"; }
clear_project() { rm -f "$PROJ/.dispatch/config.json"; }
run_resolve() { bash "$RESOLVE" --project-root "$PROJ" "$@" 2>"$TMP/err"; }

FULL_GLOBAL='{"review_mode":"on","runner":{
  "design":{"runner":"ccf","model":"opus[1m]","effort":"xhigh"},
  "design_review":{"runner":"cx","model":"gpt-5.6-sol","effort":"xhigh"},
  "exec":{"runner":"cx","model":"gpt-5.6-terra","effort":"high"},
  "exec_review":{"runner":"ccf","model":"opus[1m]","effort":"high"}}}'

write_runners

# CR1: project が field 単位で上書きする
clear_project; write_global "$FULL_GLOBAL"
write_project '{"runner":{"design":{"model":"fable"}}}'
out=$(run_resolve)
[[ "$(jq -r '.roles.design.model' <<<"$out")" == 'fable' \
&& "$(jq -r '.roles.design.runner' <<<"$out")" == 'ccf' \
&& "$(jq -r '.roles.design.effort' <<<"$out")" == 'xhigh' ]] \
  && ok 'CR1: project の model だけが上書きされ runner/effort は global を継承' \
  || bad "CR1: $(jq -c '.roles.design' <<<"$out")"

# CR2: global runner + project effort-only
clear_project; write_global "$FULL_GLOBAL"
write_project '{"runner":{"exec":{"effort":"medium"}}}'
out=$(run_resolve)
[[ "$(jq -r '.roles.exec.effort' <<<"$out")" == 'medium' \
&& "$(jq -r '.roles.exec.engine' <<<"$out")" == 'codex' ]] \
  && ok 'CR2: project effort-only でも global runner から engine を引ける' \
  || bad "CR2: $(jq -c '.roles.exec' <<<"$out")"

# CR3: 大文字混じりの effort が正規化される
clear_project; write_global "$FULL_GLOBAL"
write_project '{"runner":{"design":{"effort":"xHigh"}}}'
out=$(run_resolve)
[[ "$(jq -r '.roles.design.effort' <<<"$out")" == 'xhigh' ]] \
  && ok 'CR3: xHigh が xhigh へ正規化される' || bad 'CR3'

# CR4: 既定値 (model / effort を書かない config)
clear_project
write_global '{"review_mode":"on","runner":{
  "design":{"runner":"ccf"},"design_review":{"runner":"ccf"},
  "exec":{"runner":"ccf"},"exec_review":{"runner":"ccf"}}}'
out=$(run_resolve)
[[ "$(jq -r '.roles.design.model' <<<"$out")" == 'opus[1m]' \
&& "$(jq -r '.roles.exec.model' <<<"$out")" == 'sonnet' \
&& "$(jq -r '.roles.exec.effort' <<<"$out")" == 'high' \
&& "$(jq -r '.roles.exec_review.effort' <<<"$out")" == 'xhigh' ]] \
  && ok 'CR4: 組込み既定値が埋まる' || bad "CR4: $(jq -c '.roles' <<<"$out")"

# CR5: runner 未設定 / 不在
clear_project
write_global '{"review_mode":"off","runner":{"exec":{"runner":"ccf"}}}'
run_resolve >/dev/null; [[ $? -eq 2 ]] && ok 'CR5a: design の runner 未設定で exit 2' || bad 'CR5a'
write_global '{"review_mode":"off","runner":{"design":{"runner":"nope"},"exec":{"runner":"ccf"}}}'
run_resolve >/dev/null; [[ $? -eq 2 ]] && ok 'CR5b: 未登録 runner で exit 2' || bad 'CR5b'

# CR6: codex review の model 必須 / design・exec は省略可
clear_project
write_global '{"review_mode":"on","runner":{
  "design":{"runner":"cx"},"design_review":{"runner":"cx","model":"gpt-5.6-sol"},
  "exec":{"runner":"cx"},"exec_review":{"runner":"cx"}}}'
run_resolve >/dev/null; [[ $? -eq 2 ]] && ok 'CR6a: codex exec_review の model 欠落で exit 2' || bad 'CR6a'
write_global '{"review_mode":"on","runner":{
  "design":{"runner":"cx"},"design_review":{"runner":"cx"},
  "exec":{"runner":"cx"},"exec_review":{"runner":"cx","model":"gpt-5.6-sol"}}}'
run_resolve >/dev/null; [[ $? -eq 2 ]] && ok 'CR6b: codex design_review の model 欠落で exit 2' || bad 'CR6b'
write_global '{"review_mode":"off","runner":{"design":{"runner":"cx"},"exec":{"runner":"cx"}}}'
out=$(run_resolve); rc=$?
[[ $rc -eq 0 ]] && ok 'CR6c: codex design / exec は model 省略可' || bad "CR6c (rc=$rc)"

# CR7: model のメタ文字は「当該レイヤーだけ無効化」であって resolver 全体の失敗ではない。
# 値は必ず jq --arg でデータとして渡す (シェルへ埋めるとテスト自身がコマンドを実行する)。
clear_project
write_global "$FULL_GLOBAL"
EVIL="a'; touch $TMP/pwn; #"
jq -n --arg v "$EVIL" '{runner:{design:{model:$v}}}' > "$PROJ/.dispatch/config.json"
out=$(run_resolve); rc=$?
if [[ $rc -eq 0 && "$(jq -r '.roles.design.model' <<<"$out")" == 'opus[1m]' ]]; then
  ok 'CR7a: メタ文字入り model は当該レイヤーだけ無効化され global へ落ちる'
else
  bad "CR7a: rc=$rc model=$(jq -r '.roles.design.model' <<<"$out")"
fi
grep -qF -- "$EVIL" <<<"$out" && bad 'CR7b: 不正 model が出力に残った' || ok 'CR7b: 不正 model は出力に残らない'
[[ -e "$TMP/pwn" ]] && bad 'CR7c: テストが副作用を起こした' || ok 'CR7c: 副作用なし'

# CR13: --runners による registry の個別指定
clear_project; write_global "$FULL_GLOBAL"
cat > "$TMP/alt-runners.json" <<'JSON'
{"default":"ccf","runners":[{"name":"ccf","command":"ccf","engine":"claude"},
                            {"name":"cx","command":"codex","engine":"codex"}]}
JSON
out=$(bash "$RESOLVE" --project-root "$PROJ" --runners "$TMP/alt-runners.json" 2>"$TMP/err")
[[ $? -eq 0 && "$(jq -r '.runners_file' <<<"$out")" == "$TMP/alt-runners.json" ]] \
  && ok 'CR13: --runners が registry のパスを差し替える' || bad "CR13: $(cat "$TMP/err")"

# CR8: --set が最優先
clear_project; write_global "$FULL_GLOBAL"
out=$(run_resolve --set exec.model=custom-model --set exec.effort=medium)
[[ "$(jq -r '.roles.exec.model' <<<"$out")" == 'custom-model' \
&& "$(jq -r '.roles.exec.effort' <<<"$out")" == 'medium' ]] \
  && ok 'CR8: --set が最優先レイヤーになる' || bad "CR8: $(jq -c '.roles.exec' <<<"$out")"

# CR9: review_mode の終端規則
clear_project
write_global '{"review_mode":"ask","runner":{"design":{"runner":"ccf"},"exec":{"runner":"ccf"},
  "design_review":{"runner":"ccf"},"exec_review":{"runner":"ccf"}}}'
out=$(run_resolve)
[[ "$(jq -r '.review_mode' <<<"$out")" == 'on' ]] \
  && ok 'CR9a: "ask" は無効化され既定 on へ' || bad 'CR9a'
write_global '{"review_mode":true,"runner":{"design":{"runner":"ccf"},"exec":{"runner":"ccf"},
  "design_review":{"runner":"ccf"},"exec_review":{"runner":"ccf"}}}'
out=$(run_resolve)
[[ "$(jq -r '.review_mode' <<<"$out")" == 'on' ]] \
  && ok 'CR9b: boolean も無効化され既定 on へ' || bad 'CR9b'
write_global '{"review_mode":"off","runner":{"design":{"runner":"ccf"},"exec":{"runner":"ccf"}}}'
write_project '{"review_mode":"nonsense"}'
out=$(run_resolve)
[[ "$(jq -r '.review_mode' <<<"$out")" == 'off' ]] \
  && ok 'CR9c: 不正な project レイヤーを飛ばして global の off を採る' || bad 'CR9c'

# CR10: レイヤー単位 fallback の負例
clear_project; write_global "$FULL_GLOBAL"
write_project '{"runner":{"design":{"effort":"bogus"}}}'
out=$(run_resolve)
[[ "$(jq -r '.roles.design.effort' <<<"$out")" == 'xhigh' ]] \
  && ok 'CR10a: 不正 effort は当該レイヤーだけ無効化され global へ落ちる' || bad 'CR10a'
grep -q 'bogus' <<<"$out" && bad 'CR10b: 不正値が出力に残った' || ok 'CR10b: 不正値は出力に残らない'
write_project '{"runner":{"exec":{"model":"opus[1m]"}}}'
out=$(run_resolve)
[[ "$(jq -r '.roles.exec.model' <<<"$out")" == 'gpt-5.6-terra' ]] \
  && ok 'CR10c: codex ロールの claude alias は当該レイヤーだけ無効化される' || bad 'CR10c'

# CR14: 読み取り・パース失敗は exit 1 (設定エラーの exit 2 と区別する)
clear_project; write_global "$FULL_GLOBAL"
printf 'not json at all\n' > "$PROJ/.dispatch/config.json"
run_resolve >/dev/null; [[ $? -eq 1 ]] && ok 'CR14a: 壊れた project config は exit 1' || bad 'CR14a'
clear_project
printf '{ broken\n' > "$DISPATCH_CONFIG_HOME/runners.json"
run_resolve >/dev/null; [[ $? -eq 1 ]] && ok 'CR14b: 壊れた runners.json は exit 1' || bad 'CR14b'
rm -f "$DISPATCH_CONFIG_HOME/runners.json"
run_resolve >/dev/null; [[ $? -eq 2 ]] && ok 'CR14c: runners.json 不在は exit 2 (setup で直せる)' || bad 'CR14c'
write_runners

# CR11 / CR12: review off と model 省略
clear_project
write_global '{"review_mode":"off","runner":{"design":{"runner":"cx"},"exec":{"runner":"cx"}}}'
out=$(run_resolve)
[[ "$(jq -r '.roles | keys | join(",")' <<<"$out")" == 'design,exec' ]] \
  && ok 'CR11: review off では 2 ロールだけ解決する' || bad "CR11: $(jq -c '.roles|keys' <<<"$out")"
[[ "$(jq -r '.roles.design | has("model")' <<<"$out")" == 'false' ]] \
  && ok 'CR12: 決まらない model はキーごと省略される' || bad 'CR12'

exit $fail
