#!/usr/bin/env bash
# review-state.sh の active point 選択と述語。
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
LIB="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/review-state.sh"
[[ -f "$LIB" ]] || { echo "FAIL: ヘルパーが見つからない: $LIB"; exit 2; }
# shellcheck disable=SC1090
. "$LIB"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
fail=0
pass() { echo "PASS $1"; }
bad() { echo "FAIL $1"; fail=1; }
mk() { local d="$TMP/$1"; mkdir -p "$d/review"; echo "$d"; }
chk() { [[ "$2" == "$3" ]] && pass "$1" || bad "$1: got=[$2] want=[$3]"; }
preds() { printf '%s%s%s%s' "$RS_ANSWER_PENDING" "$RS_ROUND_ABORTED" "$RS_FINDINGS_UNFINISHED" "$RS_SOFT_CLOSED"; }

# RS1: 未応答の request が 1 つ。findings は別 point の古いもの。
d=$(mk rs1)
printf 'findings\nVERDICT: approve\n' > "$d/review/spec-round-1.md"; sleep 1
printf 'req\n' > "$d/review/plan-round-1-request.md"
review_select_active "$d"; chk RS1 "$RS_POINT|$RS_ROUND" 'plan|1'

# RS2: 未応答の request が古く、別 point の findings が新しい。request が勝つ。
d=$(mk rs2)
printf 'req\n' > "$d/review/spec-round-1-request.md"; sleep 1
printf 'findings\nVERDICT: approve\n' > "$d/review/plan-round-1.md"
review_select_active "$d"; chk RS2 "$RS_POINT|$RS_ROUND" 'spec|1'

# RS5: 未応答が複数なら新しい方。
d=$(mk rs5)
printf 'req\n' > "$d/review/spec-round-1-request.md"; sleep 1
printf 'req\n' > "$d/review/plan-round-2-request.md"
review_select_active "$d"; chk RS5 "$RS_POINT|$RS_ROUND" 'plan|2'

# RS6: mtime が厳密に同値の tie でも決定的である。
d=$(mk rs6)
printf 'req\n' > "$d/review/aaa-round-1-request.md"
printf 'req\n' > "$d/review/bbb-round-1-request.md"
touch -r "$d/review/aaa-round-1-request.md" "$d/review/bbb-round-1-request.md"
review_select_active "$d"; first="$RS_POINT|$RS_ROUND"
review_select_active "$d"; second="$RS_POINT|$RS_ROUND"
[[ "$first" == "$second" && -n "$RS_POINT" ]] \
  && pass "RS6: 厳密な mtime tie でも決定的 ($first)" || bad "RS6: [$first] vs [$second]"

# RS7: review が空。
d=$(mk rs7)
review_select_active "$d"; chk RS7 "$RS_HAS_ACTIVITY|$RS_POINT" '0|'

# RS11: 空白を含む status dir。
d=$(mk 'rs 11 with spaces')
printf 'req\n' > "$d/review/spec-round-1-request.md"
review_select_active "$d"; chk RS11 "$RS_POINT" 'spec'

# RS12: nullglob を漏らさない。
d=$(mk rs12); shopt -u nullglob; review_select_active "$d"
shopt -q nullglob && bad 'RS12: nullglob が漏れた' || pass 'RS12: nullglob を漏らさない'

# 述語。順序は pending|aborted|unfinished|soft_closed。
d=$(mk rs14); printf 'req\n' > "$d/review/spec-round-1-request.md"
review_select_active "$d"; chk RS14 "$(preds)" '1000'

d=$(mk rs15); printf 'req\n' > "$d/review/spec-round-1-request.md"; sleep 1
printf 'f\nVERDICT: approve\n' > "$d/review/spec-round-1.md"
review_select_active "$d"; chk RS15 "$(preds)" '0001'

d=$(mk rs16); printf 'req\n' > "$d/review/spec-round-1-request.md"; sleep 1
printf 'f only\n' > "$d/review/spec-round-1.md"
review_select_active "$d"; chk RS16 "$(preds)" '0010'

d=$(mk rs17); printf 'f only\n' > "$d/review/plan-round-3.md"
review_select_active "$d"; chk RS17 "$(preds)" '0010'

d=$(mk rs18); printf 'req\n' > "$d/review/code-round-2-request.md"
printf 'f only\n' > "$d/review/code-round-2.md"; sleep 1
printf 'a\n' > "$d/review/code-round-2-abort.md"
review_select_active "$d"; chk RS18 "$(preds)" '0111'

d=$(mk rs4b); printf 'a\n' > "$d/review/code-round-7-abort.md"
review_select_active "$d"
chk RS4b "$RS_POINT|$RS_ROUND|$(preds)" 'code|7|0101'

d=$(mk rs9); printf 'req\n' > "$d/review/spec-round-1-request.md"
printf 'f\nVERDICT: approve\n' > "$d/review/spec-round-1.md"
touch -r "$d/review/spec-round-1-request.md" "$d/review/spec-round-1.md"
review_select_active "$d"; chk RS9 "$RS_ANSWER_PENDING|$RS_SOFT_CLOSED" '0|1'

d=$(mk rs10); printf 'req\n' > "$d/review/spec-round-1-request.md"
printf 'a\n' > "$d/review/spec-round-1-abort.md"
touch -r "$d/review/spec-round-1-request.md" "$d/review/spec-round-1-abort.md"
review_select_active "$d"; chk RS10 "$RS_ANSWER_PENDING|$RS_ROUND_ABORTED" '1|0'

d=$(mk rs8); printf 'VERDICT: approve\n' > "$d/review/spec-round-1-request.md"
review_select_active "$d"; chk RS8 "$RS_ROUND_FILE|$RS_ANSWER_PENDING" '|1'

[[ $fail -eq 0 ]] && echo '--- all passed ---' || echo '--- failures ---'
exit $fail
