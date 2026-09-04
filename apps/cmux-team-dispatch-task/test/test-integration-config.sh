#!/usr/bin/env bash
# prewarm-panes.sh が書く integration.json の契約。
#
# 守っている不変条件:
#   IC1. --integration pr で {integration,repo,base,head} を書き、head は feat/<slug>
#   IC2. --pr-issue を渡すと issue が入り、渡さないと issue キーごと無い
#   IC3. --integration 省略時 (既定 merge) でも必ずファイルを書く
#        (不在を「merge のことだろう」と推測させない)
#   IC4. --integration pr で --pr-repo / --pr-base が欠けたら起動前に die する
#   IC5. 不正な owner/repo と base は die する (値は子のコマンド文へ埋まる)
#
# このテストは JSON 生成部だけを対象にする。ペイン起動は行わない。

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh"
[[ -f "$BIN" ]] || { echo "FAIL: スクリプトが見つからない: $BIN"; exit 2; }

fail=0
pass() { echo "PASS $1"; }
bad() { echo "FAIL $1"; fail=1; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

# prewarm-panes.sh は起動処理を伴うので、JSON 生成関数だけを切り出して評価する。
# 実装は write_integration_config() を「引数解析の直後・ペイン起動の前」に置くこと。
extract_fn() {
  sed -n '/^write_integration_config() {/,/^}/p' "$BIN"
}
[[ -n "$(extract_fn)" ]] || { echo "FAIL: write_integration_config が無い"; exit 1; }

# 値は位置引数で渡す。eval で "VAR=値" を組み立てる形にすると、IC5 が渡すシェル
# メタ文字入りの値をテスト自身が実行してしまう。
run_fn() { # $1=status-dir $2=slug $3=integration $4=repo $5=base $6=issue
  ( set -uo pipefail
    die() { echo "prewarm: $1" >&2; exit 2; }
    # 本体の依存を最小のスタブで満たす。symlink 検証そのものは既存の prewarm テストが見る。
    validate_publish_destination() { :; }
    STATUS_DIR="$1"; SLUG="$2"
    INTEGRATION="${3:-merge}"; PR_REPO="${4:-}"; PR_BASE="${5:-}"; PR_ISSUE="${6:-}"
    eval "$(extract_fn)"
    write_integration_config )
}

# --- IC1 ---
sd="$TMP/ic1"; mkdir -p "$sd"
run_fn "$sd" login-page pr CyberAgentAI/influencer-platform main
got=$(jq -c '[.integration,.repo,.base,.head]' "$sd/integration.json" 2>/dev/null)
if [[ "$got" == '["pr","CyberAgentAI/influencer-platform","main","feat/login-page"]' ]]; then
  pass "IC1: pr の 4 フィールドと head=feat/<slug>"
else
  bad "IC1: got=$got"
fi

# --- IC2 ---
if jq -e 'has("issue") | not' "$sd/integration.json" >/dev/null; then
  pass "IC2a: --pr-issue 無しなら issue キーが無い"
else
  bad "IC2a: issue キーが混入している"
fi
sd="$TMP/ic2"; mkdir -p "$sd"
run_fn "$sd" fix-auth pr o/r main 117
if [[ "$(jq -r '.issue' "$sd/integration.json")" == 117 ]]; then
  pass "IC2b: --pr-issue が数値で入る"
else
  bad "IC2b: issue=$(jq -c '.issue' "$sd/integration.json")"
fi

# --- IC3 ---
sd="$TMP/ic3"; mkdir -p "$sd"
run_fn "$sd" some-task
if [[ "$(jq -c . "$sd/integration.json" 2>/dev/null)" == '{"integration":"merge"}' ]]; then
  pass "IC3: 既定でも必ず書く"
else
  bad "IC3: got=$(cat "$sd/integration.json" 2>/dev/null)"
fi

# --- IC4 ---
sd="$TMP/ic4"; mkdir -p "$sd"
run_fn "$sd" t pr "" main 2>/dev/null
rc4a=$?
run_fn "$sd" t pr o/r "" 2>/dev/null
rc4b=$?
if [[ $rc4a -eq 2 && $rc4b -eq 2 && ! -e "$sd/integration.json" ]]; then
  pass "IC4: pr で repo/base が欠けたら die しファイルも作らない"
else
  bad "IC4: rc=$rc4a/$rc4b"
fi

# --- IC5 ---
sd="$TMP/ic5"; mkdir -p "$sd"
rc5=0
run_fn "$sd" t pr "o/r; rm -rf /" main 2>/dev/null || rc5=$?
[[ $rc5 -eq 2 ]] || { bad "IC5a: 不正な repo を通した"; }
rc5=0
run_fn "$sd" t pr o/r "ma in" 2>/dev/null || rc5=$?
[[ $rc5 -eq 2 ]] || { bad "IC5b: 不正な base を通した"; }
[[ ! -e "$sd/integration.json" ]] && pass "IC5: 不正な値は die しファイルも作らない" \
  || bad "IC5: ファイルが作られた"

[[ $fail -eq 0 ]] && echo "--- すべて PASS ---" || echo "--- FAIL あり ---"
exit $fail
