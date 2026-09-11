#!/usr/bin/env bash
# review-state.sh — ある役の成果がレビューを経たかを 1 語で言う。
# Usage: review-state.sh --status-dir <d> --role <r>
# 出力: reviewed / unreviewed / none (レビューを求めていない)
# Exit: 0 = 判定した / 2 = 使用法エラー
#
# ★ **判定を 1 箇所に置く。**`orca-wait.sh` は受理時の警告と最終行に、`orca-merge.sh` は
#   取り込みの gate に、**同じ問い**を使う。2 箇所に書くと必ず片方だけ直されてドリフトする。
#
# ★ **「findings が在る」は「レビューされた」ではない。**reviewer が findings を書いて
#   verdict を送ろうとしても、依頼側が先に決着していればその dispatch はもう受け取らない
#   （実測 2026-09-12: 3 Run 中 2 Run で未配送。findings はディスクに残ったままになる）。
#   ディスクの findings だけを見ると、**届かなかったレビューを「済み」と数える。**
#   配送された記録 (`sent.json`) まで揃って初めて reviewed である。
set -uo pipefail
die() { echo "review-state: $1" >&2; exit 2; }
SD="" ROLE=""
while [[ $# -gt 0 ]]; do case "$1" in
  --status-dir) [[ $# -ge 2 ]] || die '--status-dir requires a value'; SD="$2"; shift 2 ;;
  --role)       [[ $# -ge 2 ]] || die '--role requires a value';       ROLE="$2"; shift 2 ;;
  *) die "unknown option: $1" ;; esac; done
[[ -n "$SD" && -n "$ROLE" ]] || die "--status-dir and --role are required"

# レビューされうるのは成果を作る役だけである。reviewer 自身は対象ではない
case "$ROLE" in
  design) PFX=plan ;;
  exec)   PFX=code ;;
  *) printf none; exit 0 ;;
esac
# その役の reviewer が起きていなければ、そもそもレビューを求めていない
[[ -n "$(jq -r --arg r "${ROLE}_review" '.roles[$r].dispatch // empty' \
          "$SD/workers.json" 2>/dev/null)" ]] || { printf none; exit 0; }

FOUND=0
for f in "$SD"/review/$PFX-round-*-findings.md; do
  [[ -e "$f" ]] || continue
  grep -q '^VERDICT: ' "$f" && { FOUND=1; break; }
done
[[ "$FOUND" -eq 1 ]] || { printf unreviewed; exit 0; }

# ★ **ここが「findings が在る」と「届いた」を分ける。**記録が無ければ未配送として扱う —
#   取り違えるなら、通してしまうより止めるほうへ倒す（gate は override を持っている）。
jq -e --arg to "$ROLE" 'type == "array" and any(.[];
     type == "object" and (.to // "") == $to and ((.subject // "") | startswith("review-verdict:")))' \
   "$SD/sent.json" >/dev/null 2>&1 || { printf unreviewed; exit 0; }
printf reviewed
