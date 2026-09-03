#!/usr/bin/env bash
# record-pr.sh の回帰テスト。
#
# 守っている不変条件:
#   RP1. gh が URL を返したら status.json へ pr_url をマージし、既存フィールドを保存する
#   RP2. gh へ --repo と --head を integration.json の値で渡す
#        (--repo が無いと fork 側の PR を拾う。2026-09-02 の F3)
#   RP3. PR が見つからなければ exit 1 で pr_url を書かない
#   RP4. gh が非ゼロなら exit 1 で pr_url を書かない
#   RP5. integration=merge のときは何もせず exit 0 (PR を要求しないモード)
#   RP6. integration.json が無ければ exit 2

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/record-pr.sh"
[[ -f "$BIN" ]] || { echo "FAIL: スクリプトが見つからない: $BIN"; exit 2; }

fail=0
pass() { echo "PASS $1"; }
bad() { echo "FAIL $1"; fail=1; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

BIN_DIR="$TMP/bin"; mkdir -p "$BIN_DIR"
GH_LOG="$TMP/gh.log"
cat > "$BIN_DIR/gh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GH_LOG"
[[ -n "${GH_FAIL:-}" ]] && exit 1
printf '%s' "${GH_URL:-}"
exit 0
STUB
chmod +x "$BIN_DIR/gh"

setup() { # $1=name $2=integration.json の中身
  local d="$TMP/$1"; mkdir -p "$d"
  printf '%s\n' "$2" > "$d/integration.json"
  printf '{"status":"executing","workspace_id":"workspace:5","surface_id":"surface:3"}\n' \
    > "$d/status.json"
  printf '%s' "$d"
}
run() { PATH="$BIN_DIR:$PATH" GH_LOG="$GH_LOG" bash "$BIN" "$@"; }

PRJSON='{"integration":"pr","repo":"CyberAgentAI/influencer-platform","base":"main","head":"feat/fix-auth"}'

# --- RP1 / RP2 ---
d=$(setup rp1 "$PRJSON"); : > "$GH_LOG"
GH_URL='https://github.com/CyberAgentAI/influencer-platform/pull/117' run --status-dir "$d"
rc=$?
url=$(jq -r '.pr_url // empty' "$d/status.json")
ws=$(jq -r '.workspace_id // empty' "$d/status.json")
if [[ $rc -eq 0 && "$url" == 'https://github.com/CyberAgentAI/influencer-platform/pull/117' \
   && "$ws" == 'workspace:5' ]]; then
  pass "RP1: pr_url をマージし既存フィールドを保存する"
else
  bad "RP1: rc=$rc url=[$url] ws=[$ws]"
fi
if grep -q -- '--repo CyberAgentAI/influencer-platform' "$GH_LOG" \
   && grep -q -- '--head feat/fix-auth' "$GH_LOG"; then
  pass "RP2: gh へ --repo と --head を渡す"
else
  bad "RP2: gh の引数: $(cat "$GH_LOG")"
fi

# --- RP3 ---
d=$(setup rp3 "$PRJSON")
GH_URL='' run --status-dir "$d"
rc=$?
if [[ $rc -eq 1 ]] && jq -e '.pr_url | not' "$d/status.json" >/dev/null; then
  pass "RP3: PR 不在なら exit 1 で書かない"
else
  bad "RP3: rc=$rc url=$(jq -c '.pr_url' "$d/status.json")"
fi

# --- RP4 ---
d=$(setup rp4 "$PRJSON")
GH_FAIL=1 run --status-dir "$d"
rc=$?
if [[ $rc -eq 1 ]] && jq -e '.pr_url | not' "$d/status.json" >/dev/null; then
  pass "RP4: gh 失敗なら exit 1 で書かない"
else
  bad "RP4: rc=$rc"
fi

# --- RP5 ---
d=$(setup rp5 '{"integration":"merge"}'); : > "$GH_LOG"
run --status-dir "$d"
rc=$?
if [[ $rc -eq 0 && ! -s "$GH_LOG" ]]; then
  pass "RP5: merge では gh を呼ばず exit 0"
else
  bad "RP5: rc=$rc gh=$(cat "$GH_LOG")"
fi

# --- RP6 ---
d="$TMP/rp6"; mkdir -p "$d"
run --status-dir "$d"
[[ $? -eq 2 ]] && pass "RP6: integration.json 不在は exit 2" || bad "RP6: exit 2 にならない"

[[ $fail -eq 0 ]] && echo "--- すべて PASS ---" || echo "--- FAIL あり ---"
exit $fail
