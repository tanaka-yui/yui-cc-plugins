#!/usr/bin/env bash
# 全テストを走らせ、**1 件でも失敗したら非 0 で終わる。**
set -uo pipefail
cd "$(dirname "$0")/.."
SUITE="test-start test-config test-send test-wake test-issue-fetch test-issue test-pr test-completion test-recover test-stop test-wait test-merge test-report-status test-docs test-e2e"
rc=0
for f in test/test-*.sh; do n=$(basename "$f" .sh)
  grep -qw "$n" <<<"$SUITE" || { echo "MISSING FROM SUITE: $n"; rc=1; }; done
for t in $SUITE; do
  echo "=== $t ==="; out=$(bash "test/$t.sh" 2>&1); trc=$?
  tail -3 <<<"$out"; [[ "$trc" -eq 0 ]] || { echo "!!! $t FAILED (rc=$trc)"; rc=1; }
done
# lib/ の単体テスト。node はディレクトリを渡されるとモジュールとして読んで失敗するので、glob で渡す
echo "=== unit ==="; out=$(node --test 'test/unit/*.test.ts' 2>&1); trc=$?
grep -E '^ℹ (tests|pass|fail) |^✖ ' <<<"$out"; [[ "$trc" -eq 0 ]] || { echo "!!! unit FAILED (rc=$trc)"; rc=1; }
echo "---"; [[ "$rc" -eq 0 ]] && echo "ALL GREEN" || echo "SOME SUITES FAILED"
exit "$rc"
