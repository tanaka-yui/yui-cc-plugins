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
  log "send to role '$TO' (dispatch=$DID) was not delivered (rc=$RC)"
  exit 1
fi
jq -r '.result.message.id' <<<"$OUT"
