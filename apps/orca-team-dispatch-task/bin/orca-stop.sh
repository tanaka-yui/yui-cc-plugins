#!/usr/bin/env bash
# orca-stop.sh — ユーザーが止めると決めた役を止める / 停滞の判定を数え直す。
#
# Usage: orca-stop.sh --status-dir <d> --role <role>
#        orca-stop.sh --status-dir <d> --snooze
# Exit:  0 = 止めた（決着済みで何もしなかった場合を含む）/ 1 = 止め切れなかった / 2 = 使用法エラー
#
# ★ **止めるかどうかを決めるのはユーザーである。**子は待機に期限を持たず、親（`orca-wait.sh`）は
#   停滞を見つけて exit 8 で知らせるだけで、自分では何も止めない。これはユーザーが選んだあとに
#   親が呼ぶ口である。
#
# ★ **止まっている子が協力してくれる前提を置かない。**止めたいのは応答しない子なので、
#   message で「終われ」と頼むのではなく、端末を閉じる。
#
# ★ **記録してから閉じる。**`stopped.json` の無いまま閉じると、`orca-wait.sh` からは worker が
#   消えたように見え、exit 4 と `orca-recover.sh` の置き換えに回ってしまう。

set -uo pipefail
die() { echo "orca-stop: $1" >&2; exit 2; }
log() { echo "orca-stop: $1" >&2; }
ORCA_BIN="${ORCA_BIN:-${ORCA_CLI_COMMAND:-/Applications/Orca.app/Contents/Resources/bin/orca}}"
need2() { [[ "$2" -ge 2 ]] || die "$1 requires a value"; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SD="" ROLE="" SNOOZE=0
while [[ $# -gt 0 ]]; do case "$1" in
  --status-dir) need2 "$1" $#; SD="$2";   shift 2 ;;
  --role)       need2 "$1" $#; ROLE="$2"; shift 2 ;;
  --snooze)     SNOOZE=1; shift ;;
  *) die "unknown option: $1" ;; esac; done
[[ -n "$SD" ]] || die "--status-dir is required"
if [[ "$SNOOZE" -eq 1 ]]; then
  [[ -z "$ROLE" ]] || die "pass either --role or --snooze, not both"
else
  [[ -n "$ROLE" ]] || die "pass --role <role> or --snooze"
fi
[[ -r "$SD/workers.json" ]] || die "cannot read the dispatch state in $SD"

write() {   # $1=path $2=content
  local t
  t=$(mktemp "$SD/.tmp.XXXXXX") || return 1
  printf '%s\n' "$2" > "$t" && mv -f "$t" "$1" || { rm -f "$t"; return 1; }
}
# ★ **停滞の時計を今から数え直す。**止めた直後もタスクの最終変化時刻はまだ古いので、
#   数え直さないと次の周回で同じタスクがすぐ停滞に戻る。
snooze() {
  local cur upd
  cur=$(jq -c 'if type == "object" then . else {} end' "$SD/stall.json" 2>/dev/null) || cur='{}'
  [[ -n "$cur" ]] || cur='{}'
  upd=$(jq -c --argjson t "$(date +%s)" '.snoozed_at = $t | del(.detected_at, .idle_min)' <<<"$cur") \
    && [[ -n "$upd" ]] && write "$SD/stall.json" "$upd"
}

if [[ "$SNOOZE" -eq 1 ]]; then
  snooze || { log "could not record the snooze in $SD/stall.json"; exit 1; }
  log "the stall clock for $(basename "$SD") restarts now"
  exit 0
fi

TID=$(jq -r --arg r "$ROLE" '.roles[$r].task // empty' "$SD/workers.json" 2>/dev/null || echo "")
DID=$(jq -r --arg r "$ROLE" '.roles[$r].dispatch // empty' "$SD/workers.json" 2>/dev/null || echo "")
[[ -n "$TID" && -n "$DID" ]] || { log "role '$ROLE' has no dispatch recorded in $SD; nothing was stopped"; exit 1; }

# 1. 決着済みなら何もしない。止める対象がもう無い
if [[ -f "$SD/received.json" ]] \
   && jq -e --arg p "worker_done|$TID|$DID|" 'any(.[]; type == "string" and startswith($p))' \
        "$SD/received.json" >/dev/null 2>&1; then
  log "$ROLE has already settled; nothing to stop"
  exit 0
fi

# 2. 記録する。**書けなければ閉じない**
mkdir -p "$SD/roles/$ROLE" 2>/dev/null \
  && write "$SD/roles/$ROLE/stopped.json" "$(jq -nc --argjson t "$(date +%s)" '{stopped_at: $t, by: "user"}')" \
  || { log "could not record that $ROLE was stopped; its terminal was left open"; exit 1; }
snooze || log "could not restart the stall clock for $(basename "$SD"); the next wait may report it again"

RC=0
# 3. 端末を閉じる。閉じられなくても 2 の記録は残す（待機は止めた役として扱える）
TH=$(jq -r --arg r "$ROLE" '.roles[$r].terminal // empty' "$SD/workers.json" 2>/dev/null || echo "")
if [[ -z "$TH" ]]; then
  log "$ROLE has no terminal recorded; it is recorded as stopped, but nothing was closed"
  RC=1
else
  CRC=0; OUT=$("$ORCA_BIN" terminal close --terminal "$TH" --json 2>/dev/null) || CRC=$?
  if [[ "$CRC" -ne 0 ]] || ! jq -e '.ok == true' <<<"$OUT" >/dev/null 2>&1; then
    log "could not close the terminal of $ROLE ($TH, rc=$CRC); it is recorded as stopped, so close it by hand"
    RC=1
  else
    log "stopped $ROLE (terminal $TH)"
  fi
fi

# 4. reviewer を止めたら、レビューを待っている依頼側を進ませる。**送れなくても 1〜3 は覆さない**
case "$ROLE" in
  design_review) RQ=design ;;
  exec_review)   RQ=exec ;;
  *)             RQ="" ;;
esac
if [[ -n "$RQ" ]] && jq -e --arg r "$RQ" '.roles[$r].dispatch // empty | length > 0' "$SD/workers.json" >/dev/null 2>&1; then
  bash "$HERE/orca-send.sh" --workers "$SD/workers.json" --to "$RQ" \
    --subject 'review-skipped: stopped by the user' \
    --body "the $ROLE reviewer was stopped by the user; continue without review" >/dev/null \
    || log "could not tell $RQ that its reviewer was stopped; it may keep waiting for a verdict"
fi
exit "$RC"
