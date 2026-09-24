#!/usr/bin/env bash
# 設定層。**未設定はロール既定で埋める**ことと、**設定したのに黙って効かない状態を作らない**こと。
set -uo pipefail
P="$(cd "$(dirname "$0")/.." && pwd)"
S="$P/skills/orca-team-dispatch-task/scripts"
RESOLVE="$S/config-resolve.ts"; EDIT="$S/config-edit.ts"
fails=0; ok() { echo "PASS: $1"; }; fail() { echo "FAIL: $1"; fails=$((fails+1)); }

setup() {
  H=$(mktemp -d); PR=$(mktemp -d); mkdir -p "$PR/.dispatch"
  export ORCA_DISPATCH_CONFIG_HOME="$H"
  G="$H/config.json"; J="$PR/.dispatch/config.json"
}
teardown() { rm -rf "$H" "$PR"; unset ORCA_DISPATCH_CONFIG_HOME; }
res() { node "$RESOLVE" --project-root "$PR" "$@" 2>/dev/null | jq -c '.roles.design'; }
res_err() { node "$RESOLVE" --project-root "$PR" "$@" 2>&1 >/dev/null; }

# CF1: **設定ゼロは各ロールの既定 tuple で走る。**4 ロールすべてを起こして確かめる。
setup
out=$(node "$RESOLVE" --project-root "$PR" --review-mode on --phase-b on 2>/dev/null | jq -c '.roles')
[[ "$out" == '{"design":{"agent":"claude","model":"claude-opus-5-5[1m]","effort":"max"},"design_review":{"agent":"codex","model":"gpt-6-astra","effort":"xhigh"},"exec":{"agent":"codex","model":"gpt-6-sol","effort":"high"},"exec_review":{"agent":"claude","model":"claude-opus-5-5[1m]","effort":"max"}}' ]] \
  && ok "CF1 設定ゼロで各ロールが既定 tuple になる" || fail "CF1 ($out)"
teardown

# CF1b: ★ **既定 agent 以外へ変えたロールには既定の model / effort を混ぜない。**
#       codex へ claude の model を渡すと worker-start まで気づけない。
setup
echo '{"roles":{"design":{"agent":"codex"}}}' > "$G"
[[ "$(res)" == '{"agent":"codex"}' ]] && ok "CF1b 別 agent には既定 model/effort を付けない" \
  || fail "CF1b ($(res))"
teardown

# CF2: 優先順位は override > project > global。
setup
echo '{"roles":{"design":{"agent":"claude","model":"opus[1m]","effort":"low"}}}' > "$G"
[[ "$(res)" == '{"agent":"claude","model":"opus[1m]","effort":"low"}' ]] || fail "CF2 global"
echo '{"roles":{"design":{"model":"sonnet","effort":"high"}}}' > "$J"
[[ "$(res)" == '{"agent":"claude","model":"sonnet","effort":"high"}' ]] || fail "CF2 project"
[[ "$(res --set design.effort=max)" == '{"agent":"claude","model":"sonnet","effort":"max"}' ]] \
  || fail "CF2 override"
ok "CF2 override > project > global"
teardown

# CF3: **合成はフィールド単位。**project が model だけ持つとき agent は global から来る。
setup
echo '{"roles":{"design":{"agent":"codex","model":"gpt-6-astra","effort":"minimal"}}}' > "$G"
echo '{"roles":{"design":{"effort":"high"}}}' > "$J"
[[ "$(res)" == '{"agent":"codex","model":"gpt-6-astra","effort":"high"}' ]] \
  && ok "CF3 フィールド単位で層を合成" || fail "CF3 ($(res))"
teardown

# CF4: ★ **agent と食い違う model は使わない。**フィールド単位の合成は codex + sonnet を
#      作れてしまう。Orca は起動まで気づかず、失敗は worker-start まで遅れる。
setup
echo '{"roles":{"design":{"agent":"codex","model":"gpt-6-astra"}}}' > "$G"
echo '{"roles":{"design":{"model":"sonnet"}}}' > "$J"
out=$(res); err=$(res_err)
[[ "$out" == '{"agent":"codex","model":"gpt-6-astra"}' && "$err" == *"ignoring claude model 'sonnet'"* ]] \
  && ok "CF4 agent と食い違う model を落とし理由を言う" || fail "CF4 ($out / $err)"
teardown

# CF5: ★ Orca は `--effort requires --model`。model 無しの effort は**渡せない**ので落とす。
#      黙って落とすと「設定したのに効かない」になるため、必ず理由を出す。
#      既定 agent なら既定 model が埋まるので、agent を変えたロールで確かめる。
setup
echo '{"roles":{"design":{"agent":"codex","effort":"high"}}}' > "$G"
out=$(res); err=$(res_err)
[[ "$out" == '{"agent":"codex"}' && "$err" == *'Orca requires --model with --effort'* ]] \
  && ok "CF5 model 無しの effort を理由付きで落とす" || fail "CF5 ($out / $err)"
teardown

# CF6: effort の許容値は agent ごとに違う。claude の max / codex の minimal は互いに無効。
#      無効な値は次の層へ落ちる（claude の design なら既定の max、codex の design なら未設定）。
setup
echo '{"roles":{"design":{"agent":"claude","model":"sonnet","effort":"minimal"}}}' > "$G"
[[ "$(res)" == '{"agent":"claude","model":"sonnet","effort":"max"}' && "$(res_err)" == *'ignoring invalid effort'* ]] \
  || fail "CF6 claude が minimal を受けた"
echo '{"roles":{"design":{"agent":"codex","model":"gpt-6-astra","effort":"max"}}}' > "$G"
[[ "$(res)" == '{"agent":"codex","model":"gpt-6-astra"}' ]] || fail "CF6 codex が max を受けた"
echo '{"roles":{"design":{"agent":"claude","model":"sonnet","effort":"low"}}}' > "$G"
[[ "$(res)" == '{"agent":"claude","model":"sonnet","effort":"low"}' ]] || fail "CF6 claude の low を落とした"
ok "CF6 effort の許容値は agent ごと"
teardown

# CF7: 利用者は "xHigh" と書きうる。小文字へ正規化して保存・解決する。
setup
echo '{"roles":{"design":{"agent":"claude","model":"sonnet","effort":"XHigh"}}}' > "$G"
[[ "$(res)" == '{"agent":"claude","model":"sonnet","effort":"xhigh"}' ]] \
  && ok "CF7 effort を小文字へ正規化" || fail "CF7 ($(res))"
teardown

# CF8: 型違いは「その層に無い」ではなく「その層が無効」。警告して次の層へ落とす。
setup
echo '{"roles":{"design":{"agent":123,"model":["x"]}}}' > "$G"
out=$(res); err=$(res_err)
[[ "$out" == '{"agent":"claude","model":"claude-opus-5-5[1m]","effort":"max"}' && "$err" == *'ignoring non-string agent'* ]] \
  && ok "CF8 型違いを警告して落とす" || fail "CF8 ($out / $err)"
teardown

# CF9: ★ **壊れた設定を「無い」と読まない。**握り潰すと、書いたはずの model が黙って
#      効かないまま dispatch が走る。
setup
echo '{not json' > "$G"
node "$RESOLVE" --project-root "$PR" >/dev/null 2>&1
[[ $? -eq 1 ]] && ok "CF9 壊れた設定は exit 1" || fail "CF9"
teardown

# CF10: ★ **agent の allowlist を閉じない。**Orca が agent を増やしたとき、ここを直すまで
#       設定できない状態にしない。未知でも通し、検証できないことは言う。
setup
echo '{"roles":{"design":{"agent":"cursor","model":"composer-1","effort":"whatever"}}}' > "$G"
out=$(res); err=$(res_err)
[[ "$out" == '{"agent":"cursor","model":"composer-1","effort":"whatever"}' \
   && "$err" == *"is not one this version knows"* \
   && "$err" == *'cannot validate effort for unknown agent'* ]] \
  && ok "CF10 未知 agent を通し、検証できない旨を言う" || fail "CF10 ($out / $err)"
teardown

# --- config-edit.ts ---

# CF11: 1 コールの複数 --set が 1 度の mv で入る。新規作成もできる。
setup
node "$EDIT" --config "$G" --set roles.design.agent=codex --set roles.design.model=gpt-6-astra \
  --set roles.design.effort=XHIGH >/dev/null 2>&1
[[ "$(jq -c .roles.design "$G")" == '{"agent":"codex","model":"gpt-6-astra","effort":"xhigh"}' ]] \
  && ok "CF11 新規作成と複数 --set" || fail "CF11 ($(cat "$G"))"
teardown

# CF12: ★ **未知の第三者キーを保持する。**設定を編集しただけで他機能の設定が消えてはならない。
setup
echo '{"shell_ready_ms":1500,"loop":{"task_timeout_min":90}}' > "$G"
node "$EDIT" --config "$G" --set roles.design.model=sonnet >/dev/null 2>&1
[[ "$(jq -c '{a:.shell_ready_ms,b:.loop.task_timeout_min,m:.roles.design.model}' "$G")" \
   == '{"a":1500,"b":90,"m":"sonnet"}' ]] \
  && ok "CF12 第三者キーを保持" || fail "CF12 ($(cat "$G"))"
teardown

# CF13: ★ **不正値は 1 つでも書かない。**部分適用すると、agent だけ変わって effort が
#       前のまま残るような組が生まれる。既存ファイルは byte で変わらないこと。
setup
echo '{"roles":{"design":{"agent":"claude","model":"sonnet","effort":"high"}}}' > "$G"
before=$(cat "$G")
node "$EDIT" --config "$G" --set roles.design.model=opus --set roles.design.effort=minimal >/dev/null 2>&1
rc=$?
[[ "$rc" -eq 2 && "$(cat "$G")" == "$before" ]] \
  && ok "CF13 不正値のバッチは 1 つも書かない" || fail "CF13 (rc=$rc)"
node "$EDIT" --config "$G" --set roles.bogus.agent=claude >/dev/null 2>&1
[[ $? -eq 2 && "$(cat "$G")" == "$before" ]] || fail "CF13 未知ロール"
node "$EDIT" --config "$G" --set 'roles.design.model=a"b' >/dev/null 2>&1
[[ $? -eq 2 && "$(cat "$G")" == "$before" ]] || fail "CF13 シェルメタ文字"
teardown

# CF13b: agent 未設定の effort は**そのロールの既定 agent** で検証する。exec の既定は codex。
setup
node "$EDIT" --config "$G" --set roles.exec.effort=minimal >/dev/null 2>&1
[[ $? -eq 0 && "$(jq -r .roles.exec.effort "$G")" == minimal ]] \
  && ok "CF13b ロール既定 agent で effort を検証" || fail "CF13b ($(cat "$G" 2>/dev/null))"
teardown

# CF14: unset は指定したキーだけを消す。
setup
echo '{"keep":1,"roles":{"design":{"agent":"codex","model":"gpt-6-astra","effort":"high"}}}' > "$G"
node "$EDIT" --config "$G" --unset roles.design.effort --unset roles.design.model >/dev/null 2>&1
[[ "$(jq -c '{k:.keep,d:.roles.design}' "$G")" == '{"k":1,"d":{"agent":"codex"}}' ]] \
  && ok "CF14 unset は指定キーだけ消す" || fail "CF14 ($(cat "$G"))"
teardown

# CF15: --get は未設定なら空、--show は不在なら {}。存在しないことをエラーにしない。
setup
[[ -z "$(node "$EDIT" --config "$G" --get roles.design.model 2>/dev/null)" ]] || fail "CF15 未設定の --get"
[[ "$(node "$EDIT" --config "$G" --show 2>/dev/null)" == '{}' ]] || fail "CF15 不在の --show"
node "$EDIT" --config "$G" --set roles.design.model=sonnet >/dev/null 2>&1
[[ "$(node "$EDIT" --config "$G" --get roles.design.model 2>/dev/null)" == sonnet ]] \
  && ok "CF15 --get / --show" || fail "CF15 --get"
teardown

# CF16: ★ effort の検証に要る agent は、同一バッチ → 既存 config → 既定 の順で決まる。
#       cmux 版はここで `--engine` を呼び出し側に要求していたが、agent が engine そのもの
#       である以上、呼び出し側に渡させる理由が無い。
setup
echo '{"roles":{"design":{"agent":"codex"}}}' > "$G"
node "$EDIT" --config "$G" --set roles.design.effort=minimal >/dev/null 2>&1
[[ $? -eq 0 ]] || fail "CF16 既存 config の agent を見なかった"
node "$EDIT" --config "$G" --set roles.design.agent=claude --set roles.design.effort=minimal >/dev/null 2>&1
[[ $? -eq 2 ]] && ok "CF16 agent は同一バッチ → 既存 config → 既定 の順で決まる" || fail "CF16 同一バッチ"
teardown

# CF17: ★ **「ファイルが在る」と「設定されている」を混同しない。**第三者キーしか無い
#       config.json を「設定済み」と読むと、S0 の問いかけが永久に出なくなる。
setup
[[ "$(node "$RESOLVE" --project-root "$PR" 2>/dev/null | jq -r .configured)" == false ]] \
  || fail "CF17 設定ゼロ"
echo '{"shell_ready_ms":1500}' > "$G"
[[ "$(node "$RESOLVE" --project-root "$PR" 2>/dev/null | jq -r .configured)" == false ]] \
  || fail "CF17 第三者キーだけ"
echo '{"roles":{}}' > "$G"
[[ "$(node "$RESOLVE" --project-root "$PR" 2>/dev/null | jq -r .configured)" == false ]] \
  || fail "CF17 空の roles"
echo '{"roles":{"design":{"model":"sonnet"}}}' > "$G"
[[ "$(node "$RESOLVE" --project-root "$PR" 2>/dev/null | jq -r .configured)" == true ]] \
  || fail "CF17 global に roles"
rm -f "$G"; echo '{"roles":{"design":{"model":"sonnet"}}}' > "$J"
[[ "$(node "$RESOLVE" --project-root "$PR" 2>/dev/null | jq -r .configured)" == true ]] \
  && ok "CF17 configured は roles の有無で決まる" || fail "CF17 project に roles"
teardown

# --- review_mode (Stage B) ---
rm_() { node "$RESOLVE" --project-root "$PR" "$@" 2>/dev/null | jq -r '.review_mode'; }
roles_() { node "$RESOLVE" --project-root "$PR" "$@" 2>/dev/null | jq -r '.roles | keys | join(",")'; }

# CF18: ★ **既定は off。**Stage A の利用者に頼んでいないロールを勝手に起こさない。
#       CF1 / ST31 と同じ「未設定の挙動を変えない」原則である。
setup
[[ "$(rm_)" == off && "$(roles_)" == design ]] \
  && ok "CF18 review_mode の既定は off でロールは design だけ" || fail "CF18 ($(rm_) / $(roles_))"
teardown

# CF19: on なら design と design_review の 2 ロールになる。
setup
echo '{"review_mode":"on"}' > "$G"
[[ "$(rm_)" == on && "$(roles_)" == "design,design_review" ]] \
  && ok "CF19 on で design_review が増える" || fail "CF19 ($(rm_) / $(roles_))"
teardown

# CF20: on / off 以外は警告して次の層へ落とす。型違いも同じ。
setup
echo '{"review_mode":"maybe"}' > "$G"
err=$(node "$RESOLVE" --project-root "$PR" 2>&1 >/dev/null)
[[ "$(rm_)" == off && "$err" == *"ignoring invalid review_mode 'maybe'"* ]] || fail "CF20 不正値"
echo '{"review_mode":true}' > "$G"
err=$(node "$RESOLVE" --project-root "$PR" 2>&1 >/dev/null)
[[ "$(rm_)" == off && "$err" == *'ignoring non-string review_mode'* ]] || fail "CF20 型違い"
echo '{"review_mode":"maybe"}' > "$G"; echo '{"review_mode":"on"}' > "$J"
[[ "$(rm_)" == on ]] && ok "CF20 不正な review_mode を警告して落とす" || fail "CF20 層またぎ"
teardown

# CF21: ★ **使っていないロールの設定を dispatch に見せない。**off のとき
#       design_review の tuple は解決結果に出さない（設定自体は残る）。
setup
echo '{"review_mode":"off","roles":{"design_review":{"agent":"codex","model":"gpt-6-astra"}}}' > "$G"
[[ "$(roles_)" == design ]] || fail "CF21 off なのに出た"
[[ "$(node "$EDIT" --config "$G" --get roles.design_review.agent 2>/dev/null)" == codex ]] \
  && ok "CF21 off でも設定は残るが解決結果には出ない" || fail "CF21 設定が消えた"
teardown

# CF22: ★ **off の間も design_review を設定できる。**できないと on にする前に準備ができない。
#       「この版が知っているロール」と「今動くロール」を分けた理由がこれである。
setup
node "$EDIT" --config "$G" --set roles.design_review.agent=codex \
  --set roles.design_review.model=gpt-6-astra --set roles.design_review.effort=xhigh >/dev/null 2>&1
rc=$?
[[ "$rc" -eq 0 && "$(jq -c .roles.design_review "$G")" == '{"agent":"codex","model":"gpt-6-astra","effort":"xhigh"}' ]] \
  && ok "CF22 off でも design_review を設定できる" || fail "CF22 (rc=$rc)"
teardown

# CF23: config-edit が review_mode を扱う。--unset roles は review_mode を消さない。
setup
node "$EDIT" --config "$G" --set review_mode=on --set roles.design.model=sonnet >/dev/null 2>&1
[[ "$(jq -r .review_mode "$G")" == on ]] || fail "CF23 set"
[[ "$(node "$EDIT" --config "$G" --get review_mode 2>/dev/null)" == on ]] || fail "CF23 get"
node "$EDIT" --config "$G" --set review_mode=maybe >/dev/null 2>&1
[[ $? -eq 2 && "$(jq -r .review_mode "$G")" == on ]] || fail "CF23 不正値を書いた"
node "$EDIT" --config "$G" --unset roles >/dev/null 2>&1
[[ "$(jq -r '.review_mode, (.roles|type)' "$G" | tr '\n' ' ')" == "on null " ]] \
  && ok "CF23 review_mode の set/get と --unset roles の独立" || fail "CF23 ($(cat "$G"))"
teardown

# CF24: review_mode だけを設定した利用者にも S0 を二度と尋ねない。
setup
echo '{"review_mode":"on"}' > "$G"
[[ "$(node "$RESOLVE" --project-root "$PR" 2>/dev/null | jq -r .configured)" == true ]] \
  && ok "CF24 review_mode だけでも configured" || fail "CF24"
teardown

# CF25: --review-mode は 1 回きりの上書きで、両方の層より強い。
setup
echo '{"review_mode":"on"}' > "$G"
[[ "$(roles_ --review-mode off)" == design ]] \
  && ok "CF25 --review-mode の 1 回きり上書き" || fail "CF25 ($(roles_ --review-mode off))"
teardown

# --- phase_b と integration_role (F-a) ---
pb_() { node "$RESOLVE" --project-root "$PR" "$@" 2>/dev/null | jq -r '.phase_b'; }
ir_() { node "$RESOLVE" --project-root "$PR" "$@" 2>/dev/null | jq -r '.integration_role'; }

# CF26: ★ **既定は off。**設定していない利用者の dispatch を 1 ミリも変えない
#       （CF1 / CF18 / ST31 と同じ原則）。
setup
[[ "$(pb_)" == off && "$(roles_)" == design && "$(ir_)" == design ]] \
  && ok "CF26 phase_b の既定は off で取り込む役は design" || fail "CF26 ($(pb_)/$(roles_)/$(ir_))"
teardown

# CF27: ★ on で exec が増え、**取り込む役が exec になる**。merge も PR もこの値を読む。
setup
echo '{"phase_b":"on"}' > "$G"
[[ "$(roles_)" == "design,exec" && "$(ir_)" == exec ]] \
  && ok "CF27 on で exec が増え取り込む役が exec に" || fail "CF27 ($(roles_)/$(ir_))"
teardown

# CF28: on / off 以外は警告して次の層へ落とす。
setup
echo '{"phase_b":"sometimes"}' > "$G"
err=$(node "$RESOLVE" --project-root "$PR" 2>&1 >/dev/null)
[[ "$(pb_)" == off && "$err" == *"ignoring invalid phase_b 'sometimes'"* ]] || fail "CF28 不正値"
echo '{"phase_b":1}' > "$G"
err=$(node "$RESOLVE" --project-root "$PR" 2>&1 >/dev/null)
[[ "$(pb_)" == off && "$err" == *'ignoring non-string phase_b'* ]] \
  && ok "CF28 不正な phase_b を警告して落とす" || fail "CF28 型違い"
teardown

# CF29: ★ off の間も exec の tuple を設定できる（on にする前に準備できる）。CF22 と同型。
setup
node "$EDIT" --config "$G" --set roles.exec.agent=codex --set roles.exec.model=gpt-6-astra \
  >/dev/null 2>&1
[[ $? -eq 0 && "$(jq -r '.roles.exec.agent' "$G")" == codex ]] \
  && [[ "$(roles_)" == design ]] \
  && ok "CF29 off でも exec を設定でき、解決結果には出ない" || fail "CF29"
teardown

# CF30: ★ **両方 on のときだけ 4 役。**`exec_review` は phase_b が on でないと起こさない
#       — レビューする実装役が居ない。
setup
echo '{"review_mode":"on","phase_b":"on"}' > "$G"
[[ "$(roles_)" == "design,design_review,exec,exec_review" && "$(ir_)" == exec ]] \
  && ok "CF30 両方 on で 4 役" || fail "CF30 ($(roles_))"
teardown

# CF37: review_mode=on / phase_b=off では exec_review を起こさない。
setup
echo '{"review_mode":"on","phase_b":"off"}' > "$G"
[[ "$(roles_)" == "design,design_review" ]] \
  && ok "CF37 phase_b=off なら exec_review は起きない" || fail "CF37 ($(roles_))"
teardown

# CF38: review_mode=off / phase_b=on でも exec_review は起きない。
setup
echo '{"review_mode":"off","phase_b":"on"}' > "$G"
[[ "$(roles_)" == "design,exec" ]] \
  && ok "CF38 review_mode=off なら exec_review は起きない" || fail "CF38 ($(roles_))"
teardown

# CF31: --phase-b の 1 回きり上書きは両方の層より強い。
setup
echo '{"phase_b":"on"}' > "$G"
[[ "$(pb_ --phase-b off)" == off && "$(ir_ --phase-b off)" == design ]] \
  && ok "CF31 --phase-b の 1 回きり上書き" || fail "CF31"
teardown

# CF32: phase_b だけを設定した利用者にも S0 を二度と尋ねない。
setup
echo '{"phase_b":"on"}' > "$G"
[[ "$(node "$RESOLVE" --project-root "$PR" 2>/dev/null | jq -r .configured)" == true ]] \
  && ok "CF32 phase_b だけでも configured" || fail "CF32"
teardown

# CF33: config-edit が phase_b を扱い、--unset roles では消えない。
setup
node "$EDIT" --config "$G" --set phase_b=on --set roles.design.model=sonnet >/dev/null 2>&1
[[ "$(node "$EDIT" --config "$G" --get phase_b 2>/dev/null)" == on ]] || fail "CF33 get"
node "$EDIT" --config "$G" --set phase_b=maybe >/dev/null 2>&1
[[ $? -eq 2 && "$(jq -r '.phase_b' "$G")" == on ]] || fail "CF33 不正値を書いた"
node "$EDIT" --config "$G" --unset roles >/dev/null 2>&1
[[ "$(jq -r '.phase_b' "$G")" == on ]] \
  && ok "CF33 phase_b の set/get と --unset roles の独立" || fail "CF33"
teardown

# --- setup hook (F-h) ---
su_() { node "$RESOLVE" --project-root "$PR" "$@" 2>/dev/null | jq -r '.setup'; }

# CF34: 既定は skip（現行の挙動）。
setup
[[ "$(su_)" == skip ]] && ok "CF34 setup の既定は skip" || fail "CF34"
teardown

# CF35: run を選べる。1 回きりの上書きも効く。
setup
echo '{"setup":"run"}' > "$G"
[[ "$(su_)" == run && "$(su_ --setup skip)" == skip ]] \
  && ok "CF35 setup=run と 1 回きりの上書き" || fail "CF35"
teardown

# CF36: skip / run 以外は警告して落とす。
setup
echo '{"setup":"maybe"}' > "$G"
err=$(node "$RESOLVE" --project-root "$PR" 2>&1 >/dev/null)
[[ "$(su_)" == skip && "$err" == *"ignoring invalid setup 'maybe'"* ]] \
  && ok "CF36 不正な setup を警告して落とす" || fail "CF36"
teardown

# --- design_mode (取りかかり方の選択) ---
dm_() { node "$RESOLVE" --project-root "$PR" "$@" 2>/dev/null | jq -r '.design_mode'; }

# CF39: 既定は direct（現行 = 指示を足さない）。
setup
[[ "$(dm_)" == direct ]] && ok "CF39 design_mode の既定は direct" || fail "CF39 ($(dm_))"
teardown

# CF40: plan / brainstorm を選べる。1 回きりの上書きも効く。
setup
echo '{"design_mode":"brainstorm"}' > "$G"
[[ "$(dm_)" == brainstorm && "$(dm_ --design-mode plan)" == plan ]] \
  && ok "CF40 design_mode の選択と 1 回きりの上書き" || fail "CF40"
teardown

# CF41: 3 値以外は警告して落とす。
setup
echo '{"design_mode":"vibes"}' > "$G"
err=$(node "$RESOLVE" --project-root "$PR" 2>&1 >/dev/null)
[[ "$(dm_)" == direct && "$err" == *"ignoring invalid design_mode 'vibes'"* ]] \
  && ok "CF41 不正な design_mode を警告して落とす" || fail "CF41"
teardown

# CF42: zsh から呼んでも同じ結果になる（設計 3-5。呼び出し側のシェルに依存しない）
if command -v zsh >/dev/null 2>&1; then
  setup; echo '{"review_mode":"on","roles":{"design":{"model":"sonnet"}}}' > "$G"
  b=$(bash -c 'node "$1" --project-root "$2" --set design.effort=high' bash "$RESOLVE" "$PR" 2>&1); brc=$?
  z=$(zsh -c 'node "$1" --project-root "$2" --set design.effort=high' zsh "$RESOLVE" "$PR" 2>&1); zrc=$?
  [[ "$brc" -eq 0 && "$zrc" -eq 0 && -n "$b" && "$b" == "$z" ]] \
    && ok "CF42 zsh から呼んでも同じ結果" || fail "CF42 ($brc/$zrc)"
  teardown
else
  echo "SKIP: CF42 zsh が無い"
fi
echo "failures: $fails"; [[ "$fails" -eq 0 ]]
