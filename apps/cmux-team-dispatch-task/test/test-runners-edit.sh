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
# --dry-run の select / ENGINE / --get / --show の型安全ガードも kill する。
# object-first だと first(...) の短絡で露見しないので、非オブジェクトが先頭のレジストリも使う。
echo '{"runners":[true,{"name":"cc","engine":"claude"}]}' > "$TMP/mixedrev.json"
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

if [[ $fail -eq 0 ]]; then
  echo '--- all tests passed ---'
else
  echo '--- failures ---'
fi
exit "$fail"
