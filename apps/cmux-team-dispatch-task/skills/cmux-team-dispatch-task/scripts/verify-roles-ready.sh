#!/usr/bin/env bash
# verify-roles-ready.sh — どの role が実際に到達可能かを判定し、そうでないものを列挙する。
#
# 「[ready] を受け取ったか」だけでは足りない。codex role は [ready] を自己申告できても
# bridge seat が無ければ実際には受信できず、send.sh は成功するのにメッセージは未読で
# 滞留する。この 2 つ目の条件は SKILL.md の地の文にしか無く prewarm も実行しなかったため、
# 親エージェントが段落を覚えていなければ飛ばされた。2026-08-22 の事故では実際に飛ばされ、
# seat の無いペインへディスパッチが進んで review-plan: が消えた。
#
# readiness の判定そのものをここへ畳み込むことで飛ばせなくする。親は not-ready の集合を
# 得るためにこれを呼ぶしかなく、その過程で seat 検査が必ず走る。
#
# Usage:
#   verify-roles-ready.sh --prewarm <file> --team <team> [--ready <role>]...
#
# Output: not-ready な role を 1 行 1 件で stdout へ (prune-not-ready.sh の --role に渡せる)
# Exit:   0 = design と exec は到達可能 / 1 = 必須 role が到達不能 (ディスパッチを止める)
#         2 = 使用法エラー
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
die() { echo "verify-roles-ready: $1" >&2; exit 2; }

PREWARM=""; TEAM=""; READY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prewarm) [[ $# -ge 2 ]] || die "--prewarm requires a value"; PREWARM="$2"; shift 2 ;;
    --team)    [[ $# -ge 2 ]] || die "--team requires a value";    TEAM="$2";    shift 2 ;;
    --ready)   [[ $# -ge 2 ]] || die "--ready requires a role";    READY="${READY}${READY:+ }$2"; shift 2 ;;
    *)         die "unknown argument: $1" ;;
  esac
done
[[ -n "$PREWARM" ]] || die "--prewarm is required"
[[ -n "$TEAM" ]] || die "--team is required"
[[ -f "$PREWARM" ]] || die "prewarm snapshot not found: $PREWARM"

# スナップショットは 1 回だけ読んで検証する。role ごとに開き直すと、その間の差し替えで
# 別ワークスペースの surface を掴みうる (prewarm-snapshot.sh の契約)。
# shellcheck source=prewarm-snapshot.sh
source "$SCRIPT_DIR/prewarm-snapshot.sh"
DOC=$(cat "$PREWARM") || die "cannot read $PREWARM"
validate_prewarm_snapshot "$DOC" || die "invalid prewarm snapshot"

reported_ready() { # $1=role
  local r
  for r in $READY; do [[ "$r" == "$1" ]] && return 0; done
  return 1
}

NOT_READY=""
REQUIRED_MISSING=0
for role in design design_review exec exec_review; do
  jq -e --arg r "$role" 'has($r)' >/dev/null 2>&1 <<<"$DOC" || continue
  agent=$(jq -r --arg r "$role" '.[$r].agent' <<<"$DOC")
  engine=$(jq -r --arg r "$role" '.[$r].engine' <<<"$DOC")
  reason=""

  if ! reported_ready "$role"; then
    reason="no [ready] message"
  elif [[ "$engine" == codex ]]; then
    # codex は自己申告だけでは到達性を示せない。seat が無ければ send.sh は成功しても
    # メッセージは未読で滞留する。ここが飛ばされていた検査である。
    if ! bash "$SCRIPT_DIR/verify-agmsg-ready.sh" --codex --team "$TEAM" --name "$agent" >/dev/null 2>&1; then
      reason="reported ready but has no agmsg bridge seat"
    fi
  fi

  [[ -n "$reason" ]] || continue
  NOT_READY="${NOT_READY}${NOT_READY:+ }$role"
  echo "$role"
  echo "verify-roles-ready: $role ($agent, $engine) is not reachable: $reason" >&2
  case "$role" in design|exec) REQUIRED_MISSING=1 ;; esac
done

# design / exec は fail-closed。review role の脱落は gate をスキップするだけなので 0 で返す。
[[ "$REQUIRED_MISSING" -eq 0 ]] || exit 1
exit 0
