#!/usr/bin/env bash
# completion.sh — 完了の二相コミット（spec 10）の worker 側の口。
#
# Usage: completion.sh --role-dir <d> prepare            # 相 2 の前半: prepared を書き nonce を出す
#        completion.sh --role-dir <d> sent               # 相 2 の後半: merge_ready_sent へ
#        completion.sh --role-dir <d> await              # 相 4: 親の返事を 1 回分待つ
#        completion.sh --role-dir <d> accept --nonce <n> # 相 5: nonce 一致なら accepted へ
#        completion.sh --role-dir <d> settle             # 相 7: settled へ
#        completion.sh --role-dir <d> reconcile          # 外部の証拠で settled へ（親専用）
#        completion.sh --role-dir <d> phase              # 現在の phase を出す（無ければ空）
#        completion.sh --role-dir <d> nonce              # 現在の nonce を出す
# Exit: 0 / 1 = 進められない（nonce 不一致・記録が読めない・transport 障害）/ 2 = 使用法エラー
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
  prepare|sent|await|accept|settle|reconcile|phase|nonce) [[ -z "$SUB" ]] || die "one subcommand only"; SUB="$1"; shift ;;
  *) die "unknown argument: $1" ;; esac; done
[[ -n "$RD" ]] || die "--role-dir is required"
[[ -n "$SUB" ]] || die "a subcommand is required"
GEN_IN="${GEN_IN:-1}"
CJ="$RD/completion.json"
ORCA_BIN="${ORCA_BIN:-${ORCA_CLI_COMMAND:-/Applications/Orca.app/Contents/Resources/bin/orca}}"

# ★ **待つのは 24 時間。**「翌日の仕事までに分かっていればよい」が要件である。1 回の
#   ブロックは 10 分（agent の shell の上限）なので、24 時間は呼び直しで作る。期限は
#   `sent` の時刻から決まり、**ファイルに載るので呼び直しをまたいで残る** — agent に
#   回数を数えさせない。
AWAIT_WINDOW_MS="${ORCA_AWAIT_WINDOW_MS:-600000}"
AWAIT_TOTAL_SECONDS="${ORCA_AWAIT_TOTAL_SECONDS:-86400}"

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
    # ★ **待機の期限はここで決まる。**merge_ready が出た瞬間が待ち始めた時刻である。
    #   `sent` は前進済みなら早期 return するので、再入しても期限は伸びない。
    write "$(jq -c --argjson d "$(( $(date +%s) + AWAIT_TOTAL_SECONDS ))" \
      '.phase = "merge_ready_sent" | .await_deadline = $d' "$CJ")" \
      || { log "cannot write $CJ"; exit 1; } ;;

  await)
    # ★ **ここが「途中で止まる」の対策の本体である。**旧手順は merge_ready を送ったあと
    #   worker にターンを閉じさせていたが、`orchestration send` はメールボックスに入れる
    #   だけで**アイドルな worker を起こさない**（実測 2026-09-10: 1 Run の 4 worker 全員が
    #   未読のまま停止した）。だから待つ側はターンを閉じず、この口を呼び直す。
    #
    # ★ **nonce の照合を目視から外す。**「自分のでない nonce は無視して待て」は、目で
    #   やらせると必ずどこかで取り違える。
    #
    # 出力は 1 行: accepted / remediation <本文> / waiting / expired
    cur=$(read_field phase)
    case "$cur" in
      merge_ready_sent) ;;
      accepted|settled) echo accepted; exit 0 ;;      # 受理済みの replay は no-op
      *) log "await is only for a completion that was offered; phase is '${cur:-none}'"; exit 1 ;;
    esac
    have=$(read_field nonce)
    [[ -n "$have" ]] || { log "no completion record; there is nothing to wait for"; exit 1; }
    TH="${ORCA_TERMINAL_HANDLE:-}"
    # ★ **selector を省いて Orca に推測させない。**別の端末のメールボックスを読むより、
    #   読めないほうがよい（orca-send.sh の --from と同じ構え）。
    [[ -n "$TH" ]] || { log "ORCA_TERMINAL_HANDLE is not set; refusing to guess whose mailbox to read"; exit 1; }

    ORC=0
    # ★ **--peek のみ。`--ack` を絶対に付けない** — cursor を進めるのは親である (O22/O23)。
    OUT=$("$ORCA_BIN" orchestration check --terminal "$TH" --peek --wait \
            --timeout-ms "$AWAIT_WINDOW_MS" --json 2>/dev/null) || ORC=$?
    if [[ "$ORC" -ne 0 ]] || ! jq -e '.ok == true' <<<"$OUT" >/dev/null 2>&1; then
      # ★ **transport の障害を「返事が無い」と混ぜない。**混ぜると、壊れた経路を
      #   24 時間叩き続けることになる。
      log "could not read the mailbox (rc=$ORC)"; exit 1
    fi
    # ★ 自分の nonce の返事だけを拾う。**他人の nonce は古い試行のものであり、無視する。**
    #   関係の無い型（heartbeat / review-verdict）も、ここでは黙って読み飛ばす。
    SUBJ=$(jq -r --arg n "$have" \
      'first(.result.messages[]? | select((.subject // "")
         | startswith("completion-accepted: " + $n) or startswith("completion-remediation: " + $n)))
       | .subject // empty' <<<"$OUT" 2>/dev/null || echo "")
    if [[ "$SUBJ" == completion-accepted:* ]]; then
      write "$(jq -c '.phase = "accepted"' "$CJ")" || { log "cannot write $CJ"; exit 1; }
      echo accepted; exit 0
    fi
    if [[ "$SUBJ" == completion-remediation:* ]]; then
      # ★ **相を進めない。**差し戻しは C からのやり直しであって、受理ではない。
      BODY=$(jq -r --arg n "$have" \
        'first(.result.messages[]? | select((.subject // "")
           | startswith("completion-remediation: " + $n))) | .body // ""' <<<"$OUT" 2>/dev/null || echo "")
      echo "remediation ${BODY}"; exit 0
    fi
    # ★ **期限の判定は返事を探したあと。**時計より届いている事実が優先する。
    DL=$(read_field await_deadline)
    if [[ "$DL" =~ ^[0-9]+$ ]] && [[ "$(date +%s)" -ge "$DL" ]]; then echo expired; exit 0; fi
    # ★ **空振りは「まだ来ていない」であって「来ない」ではない。**ここを give-up にした
    #   のが旧版の停止だった。呼び直させる。
    echo waiting ;;

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
