#!/usr/bin/env bash
# report-status.sh のガード。
#
# 守っている不変条件:
#   RS-G1. integration=pr かつ pr_url 無しの done は exit 1 で status を書かない
#   RS-G2. DISPATCH_GATE_ROLE=design かつ .deferred 存在の done は exit 1
#          (委譲済みタスクの terminal status の所有者は exec である)
#   RS-G3. result.md 不在の done は通すが result_missing: true を残す
#   RS-G4. result.md があれば result_missing を立てない (前回の残骸も消す)
#   RS-G5. error は 3 条件すべてで常に通る (壊れたときの出口を塞がない)
#   RS-G6. integration.json が読めないときは V1 を発動させない (fail-open)
#   RS-G7. 既存フィールド (workspace_id / surface_id / pr_url) を保存する

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/report-status.sh"
[[ -f "$BIN" ]] || { echo "FAIL: スクリプトが見つからない: $BIN"; exit 2; }

fail=0
pass() { echo "PASS $1"; }
bad() { echo "FAIL $1"; fail=1; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

setup() { # $1=name $2=integration.json (空文字なら作らない)
  local d="$TMP/$1"; mkdir -p "$d"
  printf '{"status":"executing","workspace_id":"workspace:5","surface_id":"surface:3"}\n' \
    > "$d/status.json"
  [[ -z "$2" ]] || printf '%s\n' "$2" > "$d/integration.json"
  printf '%s' "$d"
}
PRJSON='{"integration":"pr","repo":"o/r","base":"main","head":"feat/x"}'
st() { jq -r '.status // empty' "$1/status.json"; }

# --- RS-G1 ---
d=$(setup g1 "$PRJSON"); printf 'done\n' > "$d/result.md"
bash "$BIN" "$d" done finished 2>/dev/null
rc=$?
if [[ $rc -eq 1 && "$(st "$d")" == executing ]]; then
  pass "RS-G1: pr で pr_url 無しの done を拒否する"
else
  bad "RS-G1: rc=$rc status=$(st "$d")"
fi

# pr_url があれば通る
jq '.pr_url = "https://github.com/o/r/pull/1"' "$d/status.json" > "$d/t" && mv "$d/t" "$d/status.json"
bash "$BIN" "$d" done finished
if [[ $? -eq 0 && "$(st "$d")" == done ]]; then
  pass "RS-G1b: pr_url があれば done を通す"
else
  bad "RS-G1b: status=$(st "$d")"
fi

# --- RS-G2 ---
d=$(setup g2 '{"integration":"merge"}'); printf 'done\n' > "$d/result.md"; : > "$d/.deferred"
DISPATCH_GATE_ROLE=design bash "$BIN" "$d" done delegated 2>/dev/null
rc=$?
if [[ $rc -eq 1 && "$(st "$d")" == executing ]]; then
  pass "RS-G2: 委譲済み design の done を拒否する"
else
  bad "RS-G2: rc=$rc status=$(st "$d")"
fi
DISPATCH_GATE_ROLE=exec bash "$BIN" "$d" done implemented
if [[ $? -eq 0 && "$(st "$d")" == done ]]; then
  pass "RS-G2b: 同じ状態でも exec の done は通る"
else
  bad "RS-G2b: status=$(st "$d")"
fi

# --- RS-G3 / RS-G4 ---
d=$(setup g3 '{"integration":"merge"}')
bash "$BIN" "$d" done finished
if [[ $? -eq 0 && "$(jq -r '.result_missing' "$d/status.json")" == true ]]; then
  pass "RS-G3: result.md 不在は通すが result_missing を残す"
else
  bad "RS-G3: result_missing=$(jq -c '.result_missing' "$d/status.json")"
fi
printf 'summary\n' > "$d/result.md"
bash "$BIN" "$d" done finished
if jq -e '.result_missing | not' "$d/status.json" >/dev/null; then
  pass "RS-G4: result.md が現れたら result_missing を落とす"
else
  bad "RS-G4: result_missing が残っている"
fi

# --- RS-G5 ---
d=$(setup g5 "$PRJSON"); : > "$d/.deferred"
DISPATCH_GATE_ROLE=design bash "$BIN" "$d" error something broke
if [[ $? -eq 0 && "$(st "$d")" == error ]]; then
  pass "RS-G5: error は常に通る"
else
  bad "RS-G5: status=$(st "$d")"
fi

# --- RS-G6 ---
d=$(setup g6 'not json at all'); printf 'x\n' > "$d/result.md"
bash "$BIN" "$d" done finished
if [[ $? -eq 0 && "$(st "$d")" == done ]]; then
  pass "RS-G6: integration.json が壊れていても done を止めない"
else
  bad "RS-G6: status=$(st "$d")"
fi

# --- RS-G7 ---
d=$(setup g7 '{"integration":"merge"}'); printf 'x\n' > "$d/result.md"
bash "$BIN" "$d" done finished
got=$(jq -c '[.workspace_id,.surface_id]' "$d/status.json")
if [[ "$got" == '["workspace:5","surface:3"]' ]]; then
  pass "RS-G7: 既存フィールドを保存する"
else
  bad "RS-G7: got=$got"
fi

[[ $fail -eq 0 ]] && echo "--- すべて PASS ---" || echo "--- FAIL あり ---"
exit $fail
