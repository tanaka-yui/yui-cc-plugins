#!/usr/bin/env bash
# runners-edit.sh の単体テスト。
#
# 守っている不変条件（spec: docs/superpowers/specs/2026-08-20-setup-model-effort-design.md §4.1）:
#   RE1  --set が指定 runner のフィールドだけを更新し、他 runner と default の値を変えない
#   RE2  allowlist 外のフィールド名は --set / --unset / --get の 3 モードとも exit 2
#   RE3  engine 別 effort allowlist（負と正のコントロール両方）
#   RE4  model はモデル名を allowlist しないが、空 / 空白のみ / 前後の空白 /
#        シェルメタ文字 / 制御文字は exit 2
#   RE5  --unset は該当フィールドだけ削除。不在フィールドでも exit 0（冪等）
#   RE6  未知の --name は exit 2 かつ cmp でバイト同一
#   RE7  複数の --set / --unset が 1 回でまとめて反映される
#   RE8  壊れた JSON / 読み取り不能 / 0 バイトは exit 1、元ファイル無傷
#   RE9  temp の残骸が全経路でゼロ（7 経路。--dry-run は RE18 の no_residue、
#        mv 失敗は RE9b の find が担保する）
#   RE9b mv 失敗（chflags uchg）で exit 1・固有メッセージ・残骸ゼロ・原ファイル無傷
#   RE9c mktemp 失敗（chmod 555 の親）で exit 1・固有メッセージ・残骸ゼロ
#   RE9d 順序の直接検証（555 親で検証エラーが exit 2 になる = mktemp より前に検証している）
#   RE9e --dry-run と読み取りモードが 555 親でも exit 0（mktemp を経由していない）
#   RE10 --get / --show は非破壊。不在 / 未登録 name / 破損の扱い
#   RE11 引数エラーはすべて exit 2
#   RE12 編集対象レコード内の allowlist 外フィールドが生存する（マージであって置換でない）
#   RE13 書き込みモードでファイル不在は exit 2、親ディレクトリを作らない
#   RE14a 注入・拒否側: メタ文字入りペイロードは exit 2 かつ cmp バイト同一
#   RE14b 注入・往復側: opus[1m] が exit 0 で完全一致往復し、他フィールドが不変
#   RE15 .runners が配列でないときは exit 2。配列だが要素が非オブジェクトのときは
#        型安全 select で素通しして exit 0（ガードを外すと rc=5 → exit 1 になる）
#   RE16 name 重複は exit 2。" や $ を含む name でも 3 モードとも正しく動く
#   RE17 engine 欠落 / 未知 engine への --set <*_effort> は exit 2、--unset は exit 0
#   RE18 --dry-run は書き込まず当該レコードだけを出す
#   RE18b --dry-run の出力が実書き込み結果と一致する
#   RE19 欠番（trap により弁別力がゼロだったため RE9 へ統合。id は詰めない）
#   RE20 runners[] が空配列のときの --set / bare --show

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EDIT="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/runners-edit.sh"
fail=0

[[ -f "$EDIT" ]] || { echo "FAIL: runners-edit.sh が無い: $EDIT"; exit 2; }

TMP=$(mktemp -d)
# chmod 555 のディレクトリと uchg のファイルは rm -rf で消せないので、trap の前に必ず戻す
cleanup() {
  chmod -R u+w "$TMP" 2>/dev/null || true
  find "$TMP" -flags uchg -exec chflags nouchg {} + 2>/dev/null || true
  rm -rf "$TMP"
}
# EXIT だけだと SIGTERM でハンドラは走るがスクリプトが続行し、消えた $TMP に対して
# 残りのテストが走って rc=0 の偽成功になる。INT / TERM は明示的に終了させる。
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

bad() { echo "FAIL $1"; fail=1; }
ok() { echo "PASS $1"; }

R="$TMP/runners.json"

# 標準フィクスチャ。claude と codex を 1 件ずつ、未知フィールド zzz_custom 付き。
reset_registry() {
  rm -f "$TMP"/runners.json*
  cat > "$R" <<'JSON'
{
  "default": "cc",
  "zzz_top": "keep-me",
  "runners": [
    { "name": "cc", "command": "claude", "engine": "claude",
      "plan_model": "opus[1m]", "exec_model": "fable",
      "plan_effort": "max", "zzz_custom": "keep-me-too" },
    { "name": "cx", "command": "codex", "engine": "codex",
      "review_model": "gpt-5.6-sol", "exec_effort": "high" }
  ]
}
JSON
}

# temp の残骸検査。runners.json.XXXXXX が 1 件も無いこと。
no_residue() {
  local n
  n=$(find "$TMP" -maxdepth 1 -name 'runners.json.*' | wc -l | tr -d ' ')
  [[ "$n" == 0 ]]
}

# ---- RE11: 引数エラーはすべて exit 2 ----
reset_registry
re11_pass=1
run_rc() { bash "$EDIT" "$@" >/dev/null 2>&1; echo $?; }
[[ "$(run_rc)" == 2 ]] || re11_pass=0                                          # 引数なし
[[ "$(run_rc --runners "$R" --name cc --set plan_effort=max --show)" == 2 ]] || re11_pass=0
[[ "$(run_rc --runners "$R" --name cc)" == 2 ]] || re11_pass=0                 # モード未指定
[[ "$(run_rc --name cc --show)" == 2 ]] || re11_pass=0                         # --runners 未指定
[[ "$(run_rc --runners "$R" --set plan_effort=max)" == 2 ]] || re11_pass=0     # --set に --name なし
[[ "$(run_rc --runners "$R" --get plan_model)" == 2 ]] || re11_pass=0          # --get に --name なし
[[ "$(run_rc --runners "$R" --name cc --set plan_effort)" == 2 ]] || re11_pass=0  # 形式違い
[[ "$(run_rc --runners "$R" --name cc --set plan_effort=max --unset plan_effort)" == 2 ]] || re11_pass=0
[[ "$(run_rc --runners "$R" --name cc --unset plan_effort --set plan_effort=max)" == 2 ]] || re11_pass=0  # 逆順
[[ "$(run_rc --runners "$R" --name cc --set plan_effort=max --set plan_effort=high)" == 2 ]] || re11_pass=0
[[ "$(run_rc --runners "$R" --name cc --unset plan_effort --unset plan_effort)" == 2 ]] || re11_pass=0
[[ "$(run_rc --runners "$R" --name cc --get plan_model --get exec_model)" == 2 ]] || re11_pass=0
[[ "$(run_rc --runners "$R" --name cc --name cx --show)" == 2 ]] || re11_pass=0
[[ "$(run_rc --runners "$R" --runners "$R" --name cc --show)" == 2 ]] || re11_pass=0
[[ "$(run_rc --runners "$R" --name cc --show --dry-run)" == 2 ]] || re11_pass=0
if [[ $re11_pass == 1 ]]; then ok 'RE11: 引数エラーはすべて exit 2'; else bad 'RE11'; fi

# ---- RE2: allowlist 外のフィールド名は 3 モードとも exit 2 ----
reset_registry
re2_pass=1
[[ "$(run_rc --runners "$R" --name cc --set engine=codex)" == 2 ]] || re2_pass=0
[[ "$(run_rc --runners "$R" --name cc --unset engine)" == 2 ]] || re2_pass=0
[[ "$(run_rc --runners "$R" --name cc --get engine)" == 2 ]] || re2_pass=0
[[ "$(run_rc --runners "$R" --name cc --set default=cx)" == 2 ]] || re2_pass=0
[[ "$(run_rc --runners "$R" --name cc --set plan_modl=x)" == 2 ]] || re2_pass=0
# runner の同一性に触らないことの唯一の機械的担保。command は実際に実行される文字列。
[[ "$(run_rc --runners "$R" --name cc --set command=x)" == 2 ]] || re2_pass=0
[[ "$(run_rc --runners "$R" --name cc --unset command)" == 2 ]] || re2_pass=0
[[ "$(run_rc --runners "$R" --name cc --unset name)" == 2 ]] || re2_pass=0
[[ "$(run_rc --runners "$R" --name cc --unset default)" == 2 ]] || re2_pass=0
if [[ $re2_pass == 1 ]]; then ok 'RE2: allowlist 外フィールドは 3 モードとも exit 2'; else bad 'RE2'; fi

# ---- RE4: model の値検証（allowlist は作らないが空とメタ文字は弾く） ----
reset_registry
# Task 1 では拒否側だけを検査する（受理側は書き込みを伴うので Task 2 で足す）。
re4_pass=1
for bad_v in '' '   ' '  fable' 'fable  ' "a'b" 'a"b' 'a`b' 'a$b' 'a\b' \
             "$(printf 'a\033b')" "$(printf 'a\tb')"; do
  [[ "$(run_rc --runners "$R" --name cc --set "plan_model=$bad_v")" == 2 ]] || re4_pass=0
done
if [[ $re4_pass == 1 ]]; then ok 'RE4: model の空とメタ文字を弾く'; else bad 'RE4'; fi

# ---- RE10: 読み取りモード ----
reset_registry
re10_pass=1
[[ "$(bash "$EDIT" --runners "$R" --name cc --get plan_model 2>/dev/null)" == 'opus[1m]' ]] || re10_pass=0
[[ -z "$(bash "$EDIT" --runners "$R" --name cc --get review_model 2>/dev/null)" ]] || re10_pass=0
bash "$EDIT" --runners "$R" --name cc --get review_model >/dev/null 2>&1 || re10_pass=0
[[ "$(bash "$EDIT" --runners "$R" --name cx --show 2>/dev/null | jq -r '.name')" == cx ]] || re10_pass=0
[[ "$(bash "$EDIT" --runners "$R" --show 2>/dev/null | jq -r '.default')" == cc ]] || re10_pass=0
# ファイル不在
[[ "$(bash "$EDIT" --runners "$TMP/none.json" --show 2>/dev/null)" == '{}' ]] || re10_pass=0
[[ "$(run_rc --runners "$TMP/none.json" --show)" == 0 ]] || re10_pass=0
[[ -z "$(bash "$EDIT" --runners "$TMP/none.json" --name cc --get plan_model 2>/dev/null)" ]] || re10_pass=0
[[ "$(run_rc --runners "$TMP/none.json" --name cc --get plan_model)" == 0 ]] || re10_pass=0
# 未登録 name は exit 2（フィールド未設定の exit 0 と区別する）
[[ "$(run_rc --runners "$R" --name nope --show)" == 2 ]] || re10_pass=0
[[ "$(run_rc --runners "$R" --name nope --get plan_model)" == 2 ]] || re10_pass=0
# 破損 JSON は読み取りでも exit 1
echo '{ broken' > "$TMP/broken.json"
[[ "$(run_rc --runners "$TMP/broken.json" --show)" == 1 ]] || re10_pass=0
[[ "$(run_rc --runners "$TMP/broken.json" --name cc --get plan_model)" == 1 ]] || re10_pass=0
if [[ $re10_pass == 1 ]]; then ok 'RE10: 読み取りモードは非破壊で契約どおり'; else bad 'RE10'; fi

# ---- RE8: 壊れた JSON / 0 バイト / 読み取り不能 ----
re8_pass=1
echo '{ broken' > "$TMP/b.json"; before=$(cksum < "$TMP/b.json")
[[ "$(run_rc --runners "$TMP/b.json" --name cc --set plan_effort=max)" == 1 ]] || re8_pass=0
[[ "$(cksum < "$TMP/b.json")" == "$before" ]] || re8_pass=0
: > "$TMP/z.json"
for m in '--show' '--name cc --get plan_model' '--name cc --set plan_effort=max' \
         '--name cc --set plan_effort=max --dry-run'; do
  # shellcheck disable=SC2086
  [[ "$(run_rc --runners "$TMP/z.json" $m)" == 1 ]] || re8_pass=0
done
if [[ $EUID -ne 0 ]]; then
  reset_registry
  cp "$R" "$TMP/ro.json"
  chmod 000 "$TMP/ro.json"
  rc_ro=$(run_rc --runners "$TMP/ro.json" --show)
  chmod 644 "$TMP/ro.json"          # 判定より前に必ず戻す（SP6 と同じ形）
  [[ "$rc_ro" == 1 ]] || re8_pass=0
fi
if [[ $re8_pass == 1 ]]; then ok 'RE8: 破損 / 0 バイト / 読み取り不能は exit 1 で原本保持'; else bad 'RE8'; fi

# ---- RE15: .runners の型崩れ ----
re15_pass=1
echo '{"runners": {"a": {"name": "cc"}}}' > "$TMP/o.json"
[[ "$(run_rc --runners "$TMP/o.json" --name cc --set plan_effort=max)" == 2 ]] || re15_pass=0
[[ "$(jq -r '.runners | type' "$TMP/o.json")" == object ]] || re15_pass=0
echo '{"runners": null}' > "$TMP/n.json"
[[ "$(run_rc --runners "$TMP/n.json" --name cc --set plan_effort=max)" == 2 ]] || re15_pass=0
echo '{"x": 1}' > "$TMP/m.json"
[[ "$(run_rc --runners "$TMP/m.json" --name cc --set plan_effort=max)" == 2 ]] || re15_pass=0
echo '{"runners": [1, 2]}' > "$TMP/e.json"
[[ "$(run_rc --runners "$TMP/e.json" --name cc --set plan_effort=max)" == 2 ]] || re15_pass=0
[[ "$(run_rc --runners "$TMP/e.json" --name cc --get plan_model)" == 2 ]] || re15_pass=0
# 配列だが一部の要素が非オブジェクト: 型安全 select が効くので成功し、非オブジェクト要素も生存する。
# WRITE_FILTER から (type == "object") and を外すと jq が rc=5 → exit 1 になるのでここで kill できる。
echo '{"runners":[{"name":"cc","engine":"claude"},true]}' > "$TMP/mixed.json"
[[ "$(run_rc --runners "$TMP/mixed.json" --name cc --set plan_effort=max)" == 0 ]] || re15_pass=0
[[ "$(jq -r '.runners[0].plan_effort' "$TMP/mixed.json")" == max ]] || re15_pass=0
[[ "$(jq -r '.runners[1]' "$TMP/mixed.json")" == true ]] || re15_pass=0
[[ "$(bash "$EDIT" --runners "$TMP/mixed.json" --name cc --show 2>/dev/null | jq -r '.name')" == cc ]] || re15_pass=0
# --dry-run の select / ENGINE / --get / --show の型安全ガードも kill する。
# object-first だと first(...) の短絡で露見しないので、非オブジェクトが先頭のレジストリも使う。
[[ "$(run_rc --runners "$TMP/mixed.json" --name cc --set plan_effort=max --dry-run)" == 0 ]] || re15_pass=0
echo '{"runners":[true,{"name":"cc","engine":"claude"}]}' > "$TMP/mixedrev.json"
[[ "$(run_rc --runners "$TMP/mixedrev.json" --name cc --set plan_effort=max)" == 0 ]] || re15_pass=0
[[ "$(bash "$EDIT" --runners "$TMP/mixedrev.json" --name cc --get plan_effort 2>/dev/null)" == max ]] || re15_pass=0
[[ "$(bash "$EDIT" --runners "$TMP/mixedrev.json" --name cc --show 2>/dev/null | jq -r '.name')" == cc ]] || re15_pass=0
# --name 無しの bare --show は素通し
[[ "$(run_rc --runners "$TMP/o.json" --show)" == 0 ]] || re15_pass=0
if [[ $re15_pass == 1 ]]; then ok 'RE15: .runners が非配列なら exit 2、要素が非オブジェクトなら型安全 select で素通し'; else bad 'RE15'; fi

# ---- RE20: runners[] が空配列 ----
re20_pass=1
echo '{"default": "cc", "runners": []}' > "$TMP/empty.json"
[[ "$(run_rc --runners "$TMP/empty.json" --name cc --set plan_effort=max)" == 2 ]] || re20_pass=0
[[ "$(run_rc --runners "$TMP/empty.json" --show)" == 0 ]] || re20_pass=0
if [[ $re20_pass == 1 ]]; then ok 'RE20: 空 runners[] は --set が exit 2、bare --show は exit 0'; else bad 'RE20'; fi

# ---- RE13: 書き込みモードでファイル不在 ----
re13_pass=1
[[ "$(run_rc --runners "$TMP/nodir/runners.json" --name cc --set plan_effort=max)" == 2 ]] || re13_pass=0
[[ ! -d "$TMP/nodir" ]] || re13_pass=0
# -f を -e に緩めるとディレクトリで偽成功する（コメントに理由が書いてあるのに無テストだった）
mkdir -p "$TMP/adir"
[[ "$(run_rc --runners "$TMP/adir" --name cc --set plan_effort=max)" == 2 ]] || re13_pass=0
[[ "$(run_rc --runners "$TMP/adir" --show)" == 0 ]] || re13_pass=0
if [[ $re13_pass == 1 ]]; then ok 'RE13: 不在 / ディレクトリの扱いと、親を作らないこと'; else bad 'RE13'; fi

# ---- RE1 / RE12: 指定 runner のフィールドだけ更新、他は値が不変 ----
reset_registry
before_cx=$(jq -cS '.runners[1]' "$R")
bash "$EDIT" --runners "$R" --name cc --set plan_effort=high >/dev/null 2>&1
re1_pass=1
[[ "$(jq -r '.runners[0].plan_effort' "$R")" == high ]] || re1_pass=0
[[ "$(jq -cS '.runners[1]' "$R")" == "$before_cx" ]] || re1_pass=0
[[ "$(jq -r '.default' "$R")" == cc ]] || re1_pass=0
[[ "$(jq -r '.zzz_top' "$R")" == keep-me ]] || re1_pass=0
[[ "$(jq -r '.runners[0].zzz_custom' "$R")" == keep-me-too ]] || re1_pass=0
[[ "$(jq -r '.runners[0].command' "$R")" == claude ]] || re1_pass=0
if [[ $re1_pass == 1 ]]; then ok 'RE1/RE12: 指定 runner だけ更新、未知キーとフィールドは生存'; else bad 'RE1/RE12'; fi

# ---- RE4（受理側）: モデル名の allowlist は作らない ----
reset_registry
re4b_pass=1
# 'opus 1m' は「内部の空白は通る」の witness。doc がそう書いているのに検査が無いと、
# valid_model_value を *[[:space:]]* で弾く変異体が全緑で生存する。
for good in 'gpt-9.9-nova' 'opus[1m]' 'a.b_c-d/e' 'opus 1m'; do
  bash "$EDIT" --runners "$R" --name cc --set "plan_model=$good" >/dev/null 2>&1 \
    && [[ "$(jq -r '.runners[0].plan_model' "$R")" == "$good" ]] || re4b_pass=0
done
if [[ $re4b_pass == 1 ]]; then ok 'RE4: 未知のモデル名文字列がそのまま通る'; else bad 'RE4 受理側'; fi

# ---- RE3: engine 別 effort allowlist（負と正のコントロール） ----
reset_registry
re3_pass=1
[[ "$(run_rc --runners "$R" --name cc --set plan_effort=minimal)" == 2 ]] || re3_pass=0
[[ "$(run_rc --runners "$R" --name cx --set plan_effort=max)" == 2 ]] || re3_pass=0
for v in max low; do
  bash "$EDIT" --runners "$R" --name cc --set "plan_effort=$v" >/dev/null 2>&1 \
    && [[ "$(jq -r '.runners[0].plan_effort' "$R")" == "$v" ]] || re3_pass=0
done
for v in minimal xhigh; do
  bash "$EDIT" --runners "$R" --name cx --set "plan_effort=$v" >/dev/null 2>&1 \
    && [[ "$(jq -r '.runners[1].plan_effort' "$R")" == "$v" ]] || re3_pass=0
done
if [[ $re3_pass == 1 ]]; then ok 'RE3: engine 別 effort allowlist（負と正の両方）'; else bad 'RE3'; fi

# ---- RE5: --unset は該当フィールドだけ削除。不在でも冪等 ----
reset_registry
re5_pass=1
bash "$EDIT" --runners "$R" --name cc --unset plan_model >/dev/null 2>&1 || re5_pass=0
[[ "$(jq -r '.runners[0] | has("plan_model")' "$R")" == false ]] || re5_pass=0
[[ "$(jq -r '.runners[0].exec_model' "$R")" == fable ]] || re5_pass=0
bash "$EDIT" --runners "$R" --name cc --unset plan_model >/dev/null 2>&1 || re5_pass=0
bash "$EDIT" --runners "$R" --name cc --unset review_effort >/dev/null 2>&1 || re5_pass=0
if [[ $re5_pass == 1 ]]; then ok 'RE5: --unset は該当フィールドだけ削除し冪等'; else bad 'RE5'; fi

# ---- RE6: 未知の --name は exit 2 かつバイト同一 ----
reset_registry
cp "$R" "$TMP/expect.json"
re6_pass=1
[[ "$(run_rc --runners "$R" --name nope --set plan_effort=max)" == 2 ]] || re6_pass=0
cmp -s "$R" "$TMP/expect.json" || re6_pass=0
if [[ $re6_pass == 1 ]]; then ok 'RE6: 未知 --name は exit 2 かつバイト同一'; else bad 'RE6'; fi

# ---- RE7: 複数の --set / --unset が 1 回でまとめて反映される ----
reset_registry
re7_pass=1
bash "$EDIT" --runners "$R" --name cc \
  --set plan_effort=xhigh --set review_model=fable --unset exec_model >/dev/null 2>&1 || re7_pass=0
[[ "$(jq -r '.runners[0].plan_effort' "$R")" == xhigh ]] || re7_pass=0
[[ "$(jq -r '.runners[0].review_model' "$R")" == fable ]] || re7_pass=0
[[ "$(jq -r '.runners[0] | has("exec_model")' "$R")" == false ]] || re7_pass=0
if [[ $re7_pass == 1 ]]; then ok 'RE7: 複数の --set / --unset が 1 回で反映される'; else bad 'RE7'; fi

# ---- RE14a: 注入・拒否側 ----
reset_registry
cp "$R" "$TMP/expect.json"
re14a_pass=1
[[ "$(run_rc --runners "$R" --name cc --set 'plan_model=a", "command": "pwned')" == 2 ]] || re14a_pass=0
cmp -s "$R" "$TMP/expect.json" || re14a_pass=0
if [[ $re14a_pass == 1 ]]; then ok 'RE14a: メタ文字入りペイロードは exit 2 かつバイト同一'; else bad 'RE14a'; fi

# ---- RE14b: 注入・往復側（jq 構文として意味を持つ値） ----
# 値はフィクスチャの現在値 (opus[1m]) と必ず違えること。同値だと --set を no-op にする
# 変異体でも PASS してしまい、「完全一致往復」が証明できない。
reset_registry
re14b_pass=1
bash "$EDIT" --runners "$R" --name cc --set 'plan_model=fable[1m]' >/dev/null 2>&1 || re14b_pass=0
[[ "$(jq -r '.runners[0].plan_model' "$R")" == 'fable[1m]' ]] || re14b_pass=0
[[ "$(jq -r '.runners[0].command' "$R")" == claude ]] || re14b_pass=0
[[ "$(jq -r '.runners[0].engine' "$R")" == claude ]] || re14b_pass=0
[[ "$(jq -r '.runners[0].name' "$R")" == cc ]] || re14b_pass=0
[[ "$(jq -r '.runners[1].name' "$R")" == cx ]] || re14b_pass=0
[[ "$(jq -r '.default' "$R")" == cc ]] || re14b_pass=0
if [[ $re14b_pass == 1 ]]; then ok 'RE14b: jq 添字構文を含む値が完全一致往復する'; else bad 'RE14b'; fi

# ---- RE16: name 重複と、" / $ を含む name の 3 モード ----
re16_pass=1
cat > "$TMP/dup.json" <<'JSON'
{ "runners": [ { "name": "d", "engine": "claude" }, { "name": "d", "engine": "claude" } ] }
JSON
cp "$TMP/dup.json" "$TMP/dup.expect"
[[ "$(run_rc --runners "$TMP/dup.json" --name d --set plan_effort=max)" == 2 ]] || re16_pass=0
cmp -s "$TMP/dup.json" "$TMP/dup.expect" || re16_pass=0
cat > "$TMP/odd.json" <<'JSON'
{ "runners": [ { "name": "a\"b$c", "engine": "claude", "command": "x" },
               { "name": "plain", "engine": "claude" } ] }
JSON
bash "$EDIT" --runners "$TMP/odd.json" --name 'a"b$c' --set plan_effort=max >/dev/null 2>&1 || re16_pass=0
[[ "$(jq -r '.runners[0].plan_effort' "$TMP/odd.json")" == max ]] || re16_pass=0
[[ "$(jq -r '.runners[1] | has("plan_effort")' "$TMP/odd.json")" == false ]] || re16_pass=0
[[ "$(bash "$EDIT" --runners "$TMP/odd.json" --name 'a"b$c' --get plan_effort 2>/dev/null)" == max ]] || re16_pass=0
[[ "$(bash "$EDIT" --runners "$TMP/odd.json" --name 'a"b$c' --show 2>/dev/null | jq -r '.command')" == x ]] || re16_pass=0
if [[ $re16_pass == 1 ]]; then ok 'RE16: name 重複は exit 2、特殊文字 name は 3 モードとも正常'; else bad 'RE16'; fi

# ---- RE17: engine 欠落 / 未知 engine ----
re17_pass=1
cat > "$TMP/noeng.json" <<'JSON'
{ "runners": [ { "name": "g", "command": "x", "plan_effort": "high" },
               { "name": "h", "command": "y", "engine": "gemini" } ] }
JSON
cp "$TMP/noeng.json" "$TMP/noeng.expect"
[[ "$(run_rc --runners "$TMP/noeng.json" --name g --set plan_effort=high)" == 2 ]] || re17_pass=0
[[ "$(run_rc --runners "$TMP/noeng.json" --name h --set plan_effort=high)" == 2 ]] || re17_pass=0
cmp -s "$TMP/noeng.json" "$TMP/noeng.expect" || re17_pass=0
[[ "$(run_rc --runners "$TMP/noeng.json" --name g --set plan_effort=high --dry-run)" == 2 ]] || re17_pass=0
bash "$EDIT" --runners "$TMP/noeng.json" --name g --unset plan_effort >/dev/null 2>&1 || re17_pass=0
[[ "$(jq -r '.runners[0] | has("plan_effort")' "$TMP/noeng.json")" == false ]] || re17_pass=0
if [[ $re17_pass == 1 ]]; then ok 'RE17: engine 不明への --set <*_effort> は exit 2、--unset は exit 0'; else bad 'RE17'; fi

# ---- RE9: 全経路で残骸ゼロ ----
reset_registry
re9_pass=1
bash "$EDIT" --runners "$R" --name cc --set plan_effort=high >/dev/null 2>&1
no_residue || re9_pass=0
run_rc --runners "$R" --name cc --set "plan_model=a'b" >/dev/null; no_residue || re9_pass=0
run_rc --runners "$R" --name cx --set plan_effort=max >/dev/null; no_residue || re9_pass=0
run_rc --runners "$R" --name nope --set plan_effort=max >/dev/null; no_residue || re9_pass=0
echo '{ broken' > "$TMP/br2.json"
bash "$EDIT" --runners "$TMP/br2.json" --name cc --set plan_effort=max >/dev/null 2>&1
[[ "$(find "$TMP" -maxdepth 1 -name 'br2.json.*' | wc -l | tr -d ' ')" == 0 ]] || re9_pass=0
if [[ $re9_pass == 1 ]]; then ok 'RE9: 全経路で temp の残骸がゼロ'; else bad 'RE9'; fi

# ---- RE9b: mv 失敗（chflags uchg） ----
if [[ $EUID -ne 0 ]] && command -v chflags >/dev/null 2>&1; then
  reset_registry
  cp "$R" "$TMP/imm.json"
  chflags uchg "$TMP/imm.json" 2>/dev/null && {
    out=$(bash "$EDIT" --runners "$TMP/imm.json" --name cc --set plan_effort=high 2>&1); rc=$?
    chflags nouchg "$TMP/imm.json"
    re9b_pass=1
    [[ $rc -eq 1 ]] || re9b_pass=0
    grep -q 'move failed' <<<"$out" || re9b_pass=0
    [[ "$(find "$TMP" -maxdepth 1 -name 'imm.json.*' | wc -l | tr -d ' ')" == 0 ]] || re9b_pass=0
    [[ "$(jq -r '.runners[0].plan_effort' "$TMP/imm.json")" == max ]] || re9b_pass=0
    if [[ $re9b_pass == 1 ]]; then ok 'RE9b: mv 失敗で exit 1・固有メッセージ・残骸ゼロ・原本保持'; else bad 'RE9b'; fi
  } || echo 'SKIP RE9b: chflags uchg が使えない'
else
  echo 'SKIP RE9b: root または chflags 無し'
fi

# ---- RE9c / RE9d: chmod 555 の親ディレクトリ ----
if [[ $EUID -ne 0 ]]; then
  mkdir -p "$TMP/ro"
  reset_registry
  cp "$R" "$TMP/ro/runners.json"
  chmod 555 "$TMP/ro"
  # RE9c: mktemp 失敗 → exit 1・固有メッセージ・残骸ゼロ
  out=$(bash "$EDIT" --runners "$TMP/ro/runners.json" --name cc --set plan_effort=high 2>&1); rc9c=$?
  # RE9d: 検証エラーは mktemp より前なので exit 2 のまま（誤順序なら mktemp が先に落ちて rc=1）
  rc_effort=$(bash "$EDIT" --runners "$TMP/ro/runners.json" --name cc --set plan_effort=minimal >/dev/null 2>&1; echo $?)
  rc_name=$(bash "$EDIT" --runners "$TMP/ro/runners.json" --name nope --set plan_effort=high >/dev/null 2>&1; echo $?)
  rc_model=$(bash "$EDIT" --runners "$TMP/ro/runners.json" --name cc --set "plan_model=a'b" >/dev/null 2>&1; echo $?)
  # RE9e: --dry-run と読み取りモードは mktemp を経由しないので 555 でも成功する
  dry=$(bash "$EDIT" --runners "$TMP/ro/runners.json" --name cc --set plan_effort=high --dry-run 2>/dev/null); rc_dry=$?
  showout=$(bash "$EDIT" --runners "$TMP/ro/runners.json" --name cc --show 2>/dev/null); rc_show=$?
  getout=$(bash "$EDIT" --runners "$TMP/ro/runners.json" --name cc --get plan_model 2>/dev/null); rc_get=$?
  residue=$(find "$TMP/ro" -maxdepth 1 -name 'runners.json.*' 2>/dev/null | wc -l | tr -d ' ')
  chmod 755 "$TMP/ro"

  re9c_pass=1
  [[ $rc9c -eq 1 ]] || re9c_pass=0
  grep -q 'mktemp failed' <<<"$out" || re9c_pass=0
  [[ "$residue" == 0 ]] || re9c_pass=0
  if [[ $re9c_pass == 1 ]]; then ok 'RE9c: mktemp 失敗で exit 1・固有メッセージ・残骸ゼロ'; else bad 'RE9c'; fi

  re9d_pass=1
  [[ "$rc_effort" == 2 ]] || re9d_pass=0
  [[ "$rc_name" == 2 ]] || re9d_pass=0
  [[ "$rc_model" == 2 ]] || re9d_pass=0   # 正のコントロール（手順 0 なので順序の観測窓ではない）
  if [[ $re9d_pass == 1 ]]; then ok 'RE9d: 検証は mktemp より前（555 親でも exit 2）'; else bad 'RE9d'; fi

  re9e_pass=1
  [[ $rc_dry -eq 0 ]] || re9e_pass=0
  [[ "$(jq -r '.plan_effort' <<<"$dry")" == high ]] || re9e_pass=0
  [[ $rc_show -eq 0 ]] || re9e_pass=0
  [[ "$(jq -r '.name' <<<"$showout")" == cc ]] || re9e_pass=0
  [[ $rc_get -eq 0 ]] || re9e_pass=0
  [[ "$getout" == 'opus[1m]' ]] || re9e_pass=0
  if [[ $re9e_pass == 1 ]]; then ok 'RE9e: --dry-run と読み取りは mktemp を経由しない'; else bad 'RE9e'; fi
else
  echo 'SKIP RE9c/RE9d/RE9e: root'
fi

# ---- RE18 / RE18b: --dry-run ----
reset_registry
cp "$R" "$TMP/expect.json"
re18_pass=1
out=$(bash "$EDIT" --runners "$R" --name cc --set plan_effort=high --dry-run 2>/dev/null); rc=$?
[[ $rc -eq 0 ]] || re18_pass=0
cmp -s "$R" "$TMP/expect.json" || re18_pass=0            # ファイルを変更しない
[[ "$(jq -r '.name' <<<"$out")" == cc ]] || re18_pass=0  # レコード単体を出す
[[ "$(jq -r '.plan_effort' <<<"$out")" == high ]] || re18_pass=0
no_residue || re18_pass=0
[[ "$(run_rc --runners "$R" --name cc --show --dry-run)" == 2 ]] || re18_pass=0
[[ "$(run_rc --runners "$R" --name cc --get plan_model --dry-run)" == 2 ]] || re18_pass=0
[[ "$(run_rc --runners "$TMP/none2.json" --name cc --set plan_effort=high --dry-run)" == 2 ]] || re18_pass=0
if [[ $re18_pass == 1 ]]; then ok 'RE18: --dry-run は書き込まずレコード単体を出す'; else bad 'RE18'; fi

# RE18b: dry-run の出力 == 同一引数の実書き込み結果。
# フィクスチャは claude runner（codex には max が無く effort allowlist で落ちるため）。
# 現在値 (max) と --set の値 (high) を必ず違えて、恒真になるのを防ぐ。
reset_registry
re18b_pass=1
dry=$(bash "$EDIT" --runners "$R" --name cc \
        --set plan_effort=high --unset exec_model --dry-run 2>/dev/null) || re18b_pass=0
bash "$EDIT" --runners "$R" --name cc \
  --set plan_effort=high --unset exec_model >/dev/null 2>&1 || re18b_pass=0
real=$(bash "$EDIT" --runners "$R" --name cc --show 2>/dev/null)
[[ "$(jq -S . <<<"$dry")" == "$(jq -S . <<<"$real")" ]] || re18b_pass=0
# 正のコントロール: 実際に変わっていること
[[ "$(jq -r '.plan_effort' <<<"$dry")" == high ]] || re18b_pass=0
[[ "$(jq -r 'has("exec_model")' <<<"$dry")" == false ]] || re18b_pass=0
if [[ $re18b_pass == 1 ]]; then ok 'RE18b: dry-run 出力が実書き込み結果と一致する'; else bad 'RE18b'; fi

if [[ $fail -eq 0 ]]; then
  echo '--- all tests passed ---'
else
  echo '--- failures ---'
fi
exit "$fail"
