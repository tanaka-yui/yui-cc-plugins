#!/usr/bin/env bash
# completion.sh — 完了の二相コミット（spec 10）の worker 側の口。
#
# Usage: completion.sh --role-dir <d> prepare            # 相 2 の前半: prepared を書き nonce を出す
#        completion.sh --role-dir <d> sent               # 相 2 の後半: merge_ready_sent へ
#        completion.sh --role-dir <d> accept --nonce <n> # 相 5: nonce 一致なら accepted へ
#        completion.sh --role-dir <d> settle             # 相 7: settled へ
#        completion.sh --role-dir <d> reconcile          # 外部の証拠で settled へ（親専用）
#        completion.sh --role-dir <d> phase              # 現在の phase を出す（無ければ空）
#        completion.sh --role-dir <d> nonce              # 現在の nonce を出す
# Exit: 0 / 1 = 進められない（nonce 不一致・記録が読めない）/ 2 = 使用法エラー
#
# ★ **これは exactly-once の journal ではない**（spec 10-2 の裁定 1）。自分の disk ファイルの
#   crash 回復のためだけに在る。相の遷移は前進のみで、後退させる口を持たない。
#
# ★ **nonce は「その完了の試行」を指す。**親の `accepted` が古い試行のものだったとき、
#   それを新しい試行の受理として使わないためにある。generation を上げた replacement は
#   新しい nonce を持つので、旧 generation の accepted は照合で落ちる。

set -uo pipefail
die() { echo "completion: $1" >&2; exit 2; }
log() { echo "completion: $1" >&2; }

RD="" SUB="" NONCE_IN=""
while [[ $# -gt 0 ]]; do case "$1" in
  --role-dir) [[ $# -ge 2 ]] || die '--role-dir requires a value'; RD="$2"; shift 2 ;;
  --nonce)    [[ $# -ge 2 ]] || die '--nonce requires a value';    NONCE_IN="$2"; shift 2 ;;
  --generation) [[ $# -ge 2 ]] || die '--generation requires a value'; GEN_IN="$2"; shift 2 ;;
  prepare|sent|accept|settle|reconcile|phase|nonce) [[ -z "$SUB" ]] || die "one subcommand only"; SUB="$1"; shift ;;
  *) die "unknown argument: $1" ;; esac; done
[[ -n "$RD" ]] || die "--role-dir is required"
[[ -n "$SUB" ]] || die "a subcommand is required"
GEN_IN="${GEN_IN:-1}"
CJ="$RD/completion.json"

write() {   # $1=content
  local t
  t=$(mktemp "$RD/.completion.XXXXXX") || return 1
  printf '%s\n' "$1" > "$t" && mv -f "$t" "$CJ" || { rm -f "$t"; return 1; }
}
read_field() { jq -r --arg f "$1" '.[$f] // empty' "$CJ" 2>/dev/null || echo ""; }

case "$SUB" in
  phase) read_field phase ;;
  nonce) read_field nonce ;;

  prepare)
    # ★ **冪等。**prepared 直後の crash から再入しても、同じ nonce を返す。新しい nonce を
    #   振ると、飛んでいる merge_ready の accepted が照合で落ちて永久に進めなくなる。
    cur=$(read_field phase)
    if [[ -n "$cur" ]]; then
      [[ "$cur" == prepared ]] || { log "already at phase '$cur'; not going back to prepared"; }
      read_field nonce; exit 0
    fi
    n=$( { command -v uuidgen >/dev/null 2>&1 && uuidgen; } 2>/dev/null || echo "" )
    [[ -n "$n" ]] || n="$(date -u +%s)-$$-$RANDOM"
    write "$(jq -nc --arg n "$n" --argjson g "$GEN_IN" \
      '{phase:"prepared", generation:$g, nonce:$n}')" || { log "cannot write $CJ"; exit 1; }
    printf '%s\n' "$n" ;;

  sent)
    cur=$(read_field phase)
    case "$cur" in
      prepared) ;;
      merge_ready_sent|accepted|settled) exit 0 ;;   # 前進済み。戻さない
      *) log "cannot move to merge_ready_sent from '${cur:-none}'"; exit 1 ;;
    esac
    write "$(jq -c '.phase = "merge_ready_sent"' "$CJ")" || { log "cannot write $CJ"; exit 1; } ;;

  accept)
    [[ -n "$NONCE_IN" ]] || die "accept requires --nonce"
    have=$(read_field nonce)
    # ★ **nonce が一致しなければ受理しない。**古い試行や別 generation の accepted を、
    #   今の完了の受理として使わない。
    [[ -n "$have" ]] || { log "no completion record; nothing to accept"; exit 1; }
    [[ "$have" == "$NONCE_IN" ]] || { log "nonce mismatch; this accepted is not for the current attempt"; exit 1; }
    cur=$(read_field phase)
    case "$cur" in
      prepared|merge_ready_sent) ;;
      accepted|settled) exit 0 ;;                   # replay は no-op
      *) log "cannot accept from '${cur:-none}'"; exit 1 ;;
    esac
    write "$(jq -c '.phase = "accepted"' "$CJ")" || { log "cannot write $CJ"; exit 1; } ;;

  settle)
    # ★ **worker の経路は accepted を経る。**受理されていない完了を「終わった」と記録すると、
    #   親は永久に待つ。
    cur=$(read_field phase)
    case "$cur" in
      accepted) ;;
      settled) exit 0 ;;
      *) log "cannot settle from '${cur:-none}'"; exit 1 ;;
    esac
    write "$(jq -c '.phase = "settled"' "$CJ")" || { log "cannot write $CJ"; exit 1; } ;;

  reconcile)
    # ★ **親専用の別経路。**「Orca 側が既に terminal」という**外部の証拠**を持つ者だけが
    #   使う。worker の `settle` を緩めるのではなく別の口にしてあるのは、**証拠の出どころが
    #   違う**からである。worker は自分の受理を知らずに settled を書いてはならない。
    cur=$(read_field phase)
    [[ "$cur" != settled ]] || exit 0
    if [[ -z "$cur" ]]; then
      log "there is no completion record to reconcile"; exit 1
    fi
    write "$(jq -c '.phase = "settled"' "$CJ")" || { log "cannot write $CJ"; exit 1; } ;;
esac
