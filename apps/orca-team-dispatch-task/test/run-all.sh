#!/usr/bin/env bash
# 全テストを走らせ、**1 件でも失敗したら非 0 で終わる。**
set -uo pipefail
cd "$(dirname "$0")/.."
SUITE="test-start test-wait test-merge test-docs test-e2e"
rc=0
for f in test/test-*.sh; do n=$(basename "$f" .sh)
  grep -qw "$n" <<<"$SUITE" || { echo "MISSING FROM SUITE: $n"; rc=1; }; done
for t in $SUITE; do
  echo "=== $t ==="; out=$(bash "test/$t.sh" 2>&1); trc=$?
  tail -3 <<<"$out"; [[ "$trc" -eq 0 ]] || { echo "!!! $t FAILED (rc=$trc)"; rc=1; }
done
echo "---"; [[ "$rc" -eq 0 ]] && echo "ALL GREEN" || echo "SOME SUITES FAILED"
exit "$rc"
