#!/usr/bin/env bash
# IV1: all three docs validate before command construction; IV2: rejected characters;
# IV3: re-ask; IV4: all pending tuple dimensions.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
R="$SCRIPT_DIR/../skills/cmux-team-dispatch-task"
fail=0
bad() { echo "FAIL $1"; fail=1; }
ok() { echo "PASS $1"; }
for f in "$R/SKILL.md" "$R/references/setup-mode.md" "$R/references/setup-mode-ja.md"; do
  base=$(basename "$f")
  grep -qiE 'before building|before the command|コマンドを組み立てる前' "$f" && ok "IV1: $base" || bad "IV1: $base"
  for ch in "'" '"' '`' '$' '\' '!'; do grep -qF -- "$ch" "$f" || bad "IV2: $base [$ch]"; done
  grep -qE 're-ask|再質問' "$f" && ok "IV3: $base" || bad "IV3: $base"
  for dim in runner model effort; do grep -qi "$dim" "$f" || bad "IV4: $base [$dim]"; done
done
exit "$fail"
