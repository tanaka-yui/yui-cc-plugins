#!/usr/bin/env bash
# orca-send.sh — ロール名を宛先にして worker 間メッセージを 1 通送る。
#
# Usage: orca-send.sh --workers <workers.json> --to <role> --subject <text> --body <text>
# Exit:  0 = 配送された / 1 = 配送されなかった / 2 = 使用法エラー
#
# ★ **配送されたかどうかだけを exit code にする。**呼び出し側 (review-request.sh) は
#   「送れなかったら書いたファイルを消す」補償を行うので、ここが曖昧だと補償が壊れる。
#
# ★ spec 6-1 の addressbook.json は**作らない。**宛先は `workers.json` の
#   `roles.<role>.dispatch` にすでに在る。同じ事実を 2 つのファイルに置くとドリフトする。
#   generation ごとに dispatch が差し替わる段 (spec の F-e) まで、別台帳を持つ理由が無い。

set -uo pipefail
die() { echo "orca-send: $1" >&2; exit 2; }
log() { echo "orca-send: $1" >&2; }
ORCA_BIN="${ORCA_BIN:-${ORCA_CLI_COMMAND:-/Applications/Orca.app/Contents/Resources/bin/orca}}"
need2() { [[ "$2" -ge 2 ]] || die "$1 requires a value"; }

WF="" TO="" SUBJECT="" BODY=""
while [[ $# -gt 0 ]]; do case "$1" in
  --workers) need2 "$1" $#; WF="$2";      shift 2 ;;
  --to)      need2 "$1" $#; TO="$2";      shift 2 ;;
  --subject) need2 "$1" $#; SUBJECT="$2"; shift 2 ;;
  --body)    need2 "$1" $#; BODY="$2";    shift 2 ;;
  *) die "unknown option: $1" ;; esac; done
[[ -n "$WF" && -n "$TO" && -n "$SUBJECT" ]] || die "--workers, --to and --subject are required"
[[ -r "$WF" ]] || { log "cannot read $WF"; exit 1; }

# ★ **sender handle を自分で解決する。推測しない** (spec 6-2)。`--from` を省くと、
#   候補が 1 つのとき Orca は暗黙に束縛する (O26)。誤った端末から送ったことにされるより、
#   送れないほうがよい。
FROM="${ORCA_TERMINAL_HANDLE:-}"
[[ -n "$FROM" ]] || { log "ORCA_TERMINAL_HANDLE is not set; refusing to let Orca guess the sender"; exit 1; }

DID=$(jq -r --arg r "$TO" '.roles[$r].dispatch // empty' "$WF" 2>/dev/null || echo "")
# ★ **未登録の宛先は未配送として返す。**黙って捨てるより、送信側に見えるエラーにする。
[[ -n "$DID" ]] || { log "role '$TO' has no dispatch recorded in $WF; nothing was sent"; exit 1; }

RC=0
OUT=$("$ORCA_BIN" orchestration send --to "dispatch:$DID" --type status \
        --subject "$SUBJECT" --body "$BODY" --from "$FROM" --json 2>/dev/null) || RC=$?
# ★ rc だけでは足りない。**receipt の ok を確かめる** — 実測で「rc 0 かつ ok:false」の
#   応答形が在る (worker-release の user_takeover)。ここも同じ構えで閉じる。
if [[ "$RC" -ne 0 ]] || ! jq -e '.ok == true and (.result.message.id | type == "string")' \
     <<<"$OUT" >/dev/null 2>&1; then
  # ★ **なぜ届かなかったかまで言う。**rc だけでは「相手がもう終わっている」「端末を
  #   取り違えた」「Orca が落ちている」が同じ 1 行になる（実測 2026-09-12: reviewer の
  #   verdict が rc=1 で捨てられ、receipt を開くまで理由が分からなかった）。
  ERR=$(jq -r '[.error.code // empty, .error.message // empty]
               | map(select(. != "")) | join(": ")' <<<"$OUT" 2>/dev/null || echo "")
  log "send to role '$TO' (dispatch=$DID) was not delivered (rc=$RC)${ERR:+; $ERR}"
  exit 1
fi
# ★ **配送された事実を残す。**「findings がディスクに在る」と「それが相手に届いた」は
#   別の事実である（実測 2026-09-12: 依頼側が先に決着し、verdict が受け取られなかった）。
#   後段の判定 (`review-state.ts`) はこの記録を読む。**ベストエフォート** — 記録できな
#   かったことで配送の成否を覆さない。呼び出し側の補償はこの exit code で決まる。
SDIR=$(cd "$(dirname "$WF")" 2>/dev/null && pwd) || SDIR=""
if [[ -n "$SDIR" ]]; then
  MID=$(jq -r '.result.message.id' <<<"$OUT")
  PREV=$(jq -c 'if type == "array" then . else [] end' "$SDIR/sent.json" 2>/dev/null) || PREV='[]'
  [[ -n "$PREV" ]] || PREV='[]'
  NEW=$(jq -c --arg to "$TO" --arg s "$SUBJECT" --arg id "$MID" --argjson at "$(date +%s)" \
          '. + [{to: $to, subject: $s, message_id: $id, at: $at}]' <<<"$PREV" 2>/dev/null) || NEW=""
  if [[ -n "$NEW" ]] && TMP=$(mktemp "$SDIR/.sent.XXXXXX" 2>/dev/null); then
    printf '%s\n' "$NEW" > "$TMP" && mv -f "$TMP" "$SDIR/sent.json" \
      || { rm -f "$TMP"; log "delivered to role '$TO', but the delivery could not be recorded"; }
  else
    log "delivered to role '$TO', but the delivery could not be recorded"
  fi
fi
# ★ **配送は起床ではない。**メールボックスに入れても、ターンを終えた相手は動かない
#   （実測 2026-09-10: `review-verdict:` が未読のまま滞留し、依頼元が止まった）。
#   **ベストエフォート。**起こせなかったことで配送の成否を変えてはならない — 呼び出し側は
#   この exit code で「書いたファイルを消す」補償を決めるので、ここを汚すと補償が壊れる。
bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/orca-wake.sh" \
  --workers "$WF" --role "$TO" >/dev/null 2>&1 \
  || log "delivered to role '$TO', but its terminal could not be woken; it may sit unread"
jq -r '.result.message.id' <<<"$OUT"
