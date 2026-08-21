#!/usr/bin/env bash
# monitor 専用化の回帰テスト (静的検査)。
#
# 実行: bash apps/cmux-codex-review/test/test-monitor-only.sh
#
# 守っている不変条件:
#   M1. 両プラグインに bin/cmux-codex-wait が存在しない
#   M2. 両プラグインの .md / bin に cmux-codex-wait への参照が残っていない
#   M3. 両プラグインの commands/*.md に「ターンを閉じて Monitor イベントで起きる」
#       手順がある (agmsg monitor が唯一の完了検知経路であること)
#   M4. 両プラグインの commands/*.md に単発タイマー保険 (sleep) の手順がある
#       (--surface による即時 gone 検知を失う代償の受け皿。spec の R1)
#   M5. codex-parallel-lib.sh が review / exec 2 プラグインで同一内容
#       (削除する test-cmux-codex-wait.sh の W8 を引き継ぐ)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
REVIEW="$ROOT/apps/cmux-codex-review"
EXEC="$ROOT/apps/cmux-codex-exec"
fail=0

# --- M1: bin/cmux-codex-wait が存在しない ---
if [[ ! -e "$REVIEW/bin/cmux-codex-wait" && ! -e "$EXEC/bin/cmux-codex-wait" ]]; then
  echo "PASS M1: bin/cmux-codex-wait は両プラグインから削除済み"
else
  echo "FAIL M1: cmux-codex-wait が残っている"
  fail=1
fi

# --- M2: cmux-codex-wait への参照が残っていない ---
# grep の exit status 2 以上 (読めない等) も FAIL にして fail-open させない
hits=$(grep -rl "cmux-codex-wait" "$REVIEW" "$EXEC" 2>/dev/null); rc=$?
if [[ $rc -ge 2 ]]; then
  echo "FAIL M2: grep が status=$rc を返した (検査不能)"
  fail=1
elif [[ -z "$hits" ]]; then
  echo "PASS M2: cmux-codex-wait への参照なし"
else
  echo "FAIL M2: 参照が残っている:"
  printf '  %s\n' $hits
  fail=1
fi

# --- M3: Monitor push で起きる手順がある ---
for f in "$REVIEW/commands/codex-review.md" "$EXEC/commands/codex-exec.md"; do
  if grep -q "end the turn" "$f" && grep -qi "monitor" "$f"; then
    echo "PASS M3: $(basename "$f") に Monitor push で起きる手順がある"
  else
    echo "FAIL M3: $(basename "$f") に Monitor push の手順が無い"
    fail=1
  fi
done

# --- M4: 単発タイマー保険の手順がある ---
for f in "$REVIEW/commands/codex-review.md" "$EXEC/commands/codex-exec.md"; do
  if grep -q "wake-after" "$f" && grep -qE 'sleep [0-9$]' "$f"; then
    echo "PASS M4: $(basename "$f") にタイマー保険の手順がある"
  else
    echo "FAIL M4: $(basename "$f") にタイマー保険の手順が無い"
    fail=1
  fi
done

# --- M5: codex-parallel-lib.sh の同一性 (旧 W8 の引き継ぎ) ---
if diff -q "$REVIEW/bin/codex-parallel-lib.sh" "$EXEC/bin/codex-parallel-lib.sh" >/dev/null 2>&1; then
  echo "PASS M5: codex-parallel-lib.sh が 2 プラグインで同一"
else
  echo "FAIL M5: codex-parallel-lib.sh が乖離している"
  fail=1
fi

if [[ $fail -eq 0 ]]; then
  echo "--- all passed ---"
else
  echo "--- failures ---"
fi
exit $fail
