#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; SK="$SCRIPT_DIR/../skills/cmux-team-dispatch-task"
for needle in '--loop' 'references/loop-mode.md' 'issue-fetch.sh' 'render-loop-prompt.sh'; do
  grep -Fq -- "$needle" "$SK/SKILL.md" || { echo "FAIL: $needle"; exit 1; }
done
for needle in 'issue-fetch.sh' 'batch-wait.sh' 'loop-cleanup.sh' 'render-loop-prompt.sh' '--state-file' 'lock-acquire' 'init' 'ALL_TERMINAL' '--timeout-sentinel' '--unattended'; do
  grep -Fq -- "$needle" "$SK/references/loop-mode.md" || { echo "FAIL: $needle"; exit 1; }
done
verify_dispatch_cleanup_guard() {
  local file="$1" missing=0 line text start
  # prose の inline code も含めて全出現を読む。実行コマンドだけを判定対象にする。
  while IFS=: read -r line text; do
    [[ "$text" =~ ^[[:space:]]*rm\ -rf\ \.dispatch/ ]] || continue
    start=$(( line > 6 ? line - 6 : 1 ))
    sed -n "${start},${line}p" "$file" | grep -q 'lock-check' || missing=$((missing+1))
    [[ "$text" =~ ^[[:space:]] ]] || missing=$((missing+1))
  done < <(grep -n 'rm -rf \.dispatch/' "$file" || true)
  [[ $missing -eq 0 ]]
}
verify_dispatch_cleanup_guard "$SK/SKILL.md" || { echo 'FAIL: rm -rf .dispatch/ guard'; exit 1; }
tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT
{ printf 'rm -rf .dispatch/\n'; cat "$SK/SKILL.md"; } > "$tmp"
if verify_dispatch_cleanup_guard "$tmp"; then
  echo 'FAIL: unguarded rm -rf .dispatch/ を検出できない'; exit 1
fi
echo 'PASS: unguarded rm -rf .dispatch/ を検出する'
echo '--- all tests passed ---'
