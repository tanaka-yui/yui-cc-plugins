#!/usr/bin/env bash
# .escalated を token 付きで作る唯一の入口。読み手は既存 event を書き換えない。
set -uo pipefail

status_dir="${1:?usage: escalate.sh <status-dir>}"
[[ -d "$status_dir" ]] || exit 1
[[ -e "$status_dir/.escalated" ]] && exit 0

tmp=$(mktemp "$status_dir/.escalated.XXXXXX" 2>/dev/null) || exit 1
printf '%s-%s-%s%s\n' "$(date +%s)" "$$" "$RANDOM" "$RANDOM" > "$tmp" 2>/dev/null \
  || { rm -f "$tmp"; exit 1; }
mv -f "$tmp" "$status_dir/.escalated" 2>/dev/null || { rm -f "$tmp"; exit 1; }
