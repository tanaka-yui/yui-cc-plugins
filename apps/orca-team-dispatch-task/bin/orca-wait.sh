#!/usr/bin/env bash
# orca-wait.sh — 自分の worker の worker_done を待つ。
# 実測 (spec 6-5): cursor を進めるのは ack だけ (O22/O23) / --types は batch を絞らない (O27)
#                  keepalive は stderr、2>&1 で混ぜない (O10) / selector は --terminal
# **ack は「batch 全件を処理した」の宣言である** (O11)。処理できない message が 1 つでも
# あれば ack しない。Stage 1 の親は worker_done しか処理できないので、それ以外が来たら
# 診断を出して止まる（Task spec 側で ask / escalation を禁じてある）。
# **ledger も再 emit も pending replay も無い**（Stage 1。spec 18-1）。
# Usage: orca-wait.sh --status-dir <d> [--max-waits <n>] [--timeout-ms <n>]
# Exit: 0 成功 / 5 失敗 / 1 batch を処理できない / 2 使用法 / 3 時間切れ / 4 transport または worker state が不明
set -uo pipefail
die() { echo "orca-wait: $1" >&2; exit 2; }
log() { echo "orca-wait: $1" >&2; }
ORCA_BIN="${ORCA_BIN:-/Applications/Orca.app/Contents/Resources/bin/orca}"
need2() { [[ "$2" -ge 2 ]] || die "$1 requires a value"; }
SD="" MAXW=12 TMO=300000
while [[ $# -gt 0 ]]; do case "$1" in
  --status-dir) need2 "$1" $#; SD="$2";   shift 2 ;;
  --max-waits)  need2 "$1" $#; MAXW="$2"; shift 2 ;;
  --timeout-ms) need2 "$1" $#; TMO="$2";  shift 2 ;;
  *) die "unknown option: $1" ;;
esac; done
[[ -n "$SD" ]] || die "--status-dir is required"
[[ "$MAXW" =~ ^[1-9][0-9]*$ ]] || die "--max-waits must be a positive integer"
[[ "$TMO" =~ ^[1-9][0-9]*$ ]] || die "--timeout-ms must be a positive integer"
[[ -r "$SD/run.json" && -r "$SD/workers.json" ]] || die "cannot read the dispatch state in $SD"
PH=$(jq -r '.parent_handle // empty' "$SD/run.json")
TID=$(jq -r '.design.task // empty' "$SD/workers.json")
DID=$(jq -r '.design.dispatch // empty' "$SD/workers.json")
[[ -n "$PH" && -n "$TID" && -n "$DID" ]] || die "the dispatch identity is incomplete"
RECV="$SD/received.json"
write() {
  local t
  t=$(mktemp "$SD/.tmp.XXXXXX") || return 1
  printf '%s\n' "$2" > "$t" && mv -f "$t" "$1" || { rm -f "$t"; return 1; }
}
stored_outcome() {
  local matches count
  [[ -f "$RECV" ]] || return 0
  matches=$(jq -c --arg task "$TID" --arg dispatch "$DID" \
    'if type != "array" or any(.[]; type != "string" or (split("|") | length) != 4) then error("invalid receipts")
     else [.[] | split("|") | select(.[0] == "worker_done" and .[1] == $task and .[2] == $dispatch)]
     end' "$RECV" 2>/dev/null) || { log "received outcome record is invalid or unreadable; it is not acknowledged"; return 1; }
  count=$(jq 'length' <<<"$matches") || { log "received outcome record is invalid or unreadable; it is not acknowledged"; return 1; }
  [[ "$count" -le 1 ]] || { log "received outcome record has duplicate receipts; it is not acknowledged"; return 1; }
  [[ "$count" -eq 0 ]] || jq -r '.[0][3]' <<<"$matches"
}
record_outcome() {
  local records receipt
  records='[]'
  if [[ -f "$RECV" ]]; then
    records=$(jq -c . "$RECV") || { log "received outcome record is invalid or unreadable; it is not acknowledged"; return 1; }
  fi
  receipt="worker_done|$TID|$DID|$1"
  write "$RECV" "$(jq -c --arg receipt "$receipt" '. + [$receipt]' <<<"$records")" \
    || { log "could not record the worker outcome; it is not acknowledged"; return 1; }
}

drain() {   # 0 = batch を処理し切った / 1 = 処理できないものがあった（ack しない）/ 2 = transport または receipt が不明
  local out res n i m d t tid did oc batch_oc existing record_needed REL RELRC RST ACK CHECKRC
  CHECKRC=0
  out=$("$ORCA_BIN" orchestration check --terminal "$PH" --json 2>/dev/null) || CHECKRC=$?
  [[ "$CHECKRC" -eq 0 ]] || { log "check failed (rc=$CHECKRC); the batch is not acknowledged"; return 2; }
  jq -e '.ok == true and (.result | type == "object")' <<<"$out" >/dev/null 2>&1 || {
    log "check receipt was not ok; the batch is not acknowledged"
    return 2
  }
  res=$(jq -c '.result // {}' <<<"$out" 2>/dev/null) || {
    log "check receipt result could not be read; the batch is not acknowledged"
    return 2
  }
  n=$(jq -r '.messages | if type == "array" then length else -1 end' <<<"$res" 2>/dev/null) || {
    log "check receipt messages could not be read; the batch is not acknowledged"
    return 2
  }
  [[ "$n" =~ ^[0-9]+$ ]] || { log "check receipt messages are invalid; the batch is not acknowledged"; return 2; }
  [[ "$n" -gt 0 ]] || return 0
  d=$(jq -r '.deliveryId // empty' <<<"$res")
  [[ -n "$d" ]] || { log "a non-empty batch has no deliveryId"; return 1; }
  for ((i = 0; i < n; i++)); do
    m=$(jq -c ".messages[$i]" <<<"$res")
    t=$(jq -r '.type // empty' <<<"$m")
    tid=$(jq -r '.payload.taskId // empty' <<<"$m")
    did=$(jq -r '.payload.dispatchId // empty' <<<"$m")
    # ★ **処理できない message は捨てない。**捨てて ack すると cursor だけ進んで内容が消える
    if [[ "$t" != worker_done ]] || [[ "$tid" != "$TID" || "$did" != "$DID" ]]; then
      log "batch $d carries a message this version cannot handle (type='$t' task='$tid' dispatch='$did')"
      log "it is NOT acknowledged, so nothing is lost. Inspect with:"
      log "  $ORCA_BIN orchestration check --terminal $PH --peek --json"
      return 1
    fi
    oc=$(jq -r '.payload.outcome // empty' <<<"$m")
    case "$oc" in
      succeeded|failed) ;;
      *) log "worker_done has outcome '${oc:-none}'"; return 1 ;;
    esac
    [[ -z "${batch_oc:-}" || "$batch_oc" == "$oc" ]] || {
      log "batch $d has contradictory outcomes for task '$TID' dispatch '$DID'"
      return 1
    }
    batch_oc="$oc"
  done
  existing=$(stored_outcome) || return 1
  if [[ -n "$existing" && "$existing" != "$batch_oc" ]]; then
    log "received outcome '$existing' contradicts batch outcome '$batch_oc' for task '$TID' dispatch '$DID'"
    return 1
  fi
  record_needed=0
  [[ -n "$existing" ]] || record_needed=1
  # ★ **ack より前に owner を決める** (Orca guide)。accepted な worker_done のあとは
  #   `worker-release` が既定であり、retain は「ユーザーが明示的にデバッグ保持を依頼した
  #   場合」の例外である。この版はその依頼を取らないので release を使う。
  #   **exit 0 は「完了した」の証明ではない。**pending / unknown では ack しない
  [[ "$record_needed" -eq 0 ]] || record_outcome "$batch_oc" || return 1
  RELRC=0
  REL=$("$ORCA_BIN" orchestration worker-release --dispatch "$DID" --json 2>/dev/null) || RELRC=$?
  jq -e '.ok == true and (.result | type == "object")' <<<"$REL" >/dev/null 2>&1 || {
    log "worker-release receipt was not ok (rc=$RELRC); the batch is not acknowledged"
    return 2
  }
  RST=$(jq -r '.result.state // empty' <<<"$REL" 2>/dev/null || echo "")
  if [[ "$RST" == release_unknown ]]; then
    log "release result is unknown; not acknowledging (rc=$RELRC). Do not retry, acknowledge, or merge from this parent terminal; inspect with the user"
    return 1
  fi
  if [[ "$RELRC" -ne 0 ]]; then
    log "worker-release failed (rc=$RELRC state='${RST:-none}'); the batch is not acknowledged"
    return 2
  fi
  case "$RST" in
    retained|already_released) ;;
    release_pending) log "worker-release is pending; not acknowledging. Retry the canonical wait"; return 1 ;;
    *)
      log "worker-release reported '${RST:-none}'; not acknowledging"
      return 1
      ;;
  esac
  ACK=$("$ORCA_BIN" orchestration check --terminal "$PH" --ack "$d" --json 2>/dev/null) || {
    log "ack transport failed; the batch will replay"
    return 2
  }
  jq -e '.ok == true' <<<"$ACK" >/dev/null 2>&1 || { log "ack receipt was not ok; the batch will replay"; return 2; }
  return 0
}
outcome_of() {   # 受信済みと status が一致した結論を返す。無ければ空
  local st oc existing
  st=$(jq -r '.status // empty' "$SD/roles/design/status.json" 2>/dev/null || echo "")
  case "$st" in
    done) oc=succeeded ;;
    error) oc=failed ;;
    *) return 1 ;;
  esac
  existing=$(stored_outcome) || return 1
  [[ "$existing" == "$oc" ]] || return 1
  printf '%s' "$oc"
}
finish() {
  local oc="$1"
  echo "outcome=$oc"
  [[ "$oc" == succeeded ]] && exit 0 || exit 5
}
healthy() {   # **人の入力待ちは healthy である**（CLI help）
  local show st wait SHOWRC
  SHOWRC=0
  show=$("$ORCA_BIN" orchestration worker-show --dispatch "$DID" --json 2>/dev/null) || SHOWRC=$?
  [[ "$SHOWRC" -eq 0 ]] || { log "worker-show failed (rc=$SHOWRC)"; return 2; }
  jq -e '.ok == true and (.result | type == "object")' <<<"$show" >/dev/null 2>&1 || {
    log "worker-show receipt was not ok"
    return 2
  }
  wait=$(jq -r '.result.observation.agentWait // empty' <<<"$show")
  [[ -n "$wait" && "$wait" != null ]] && return 0
  st=$(jq -r '.result.worker.state // empty' <<<"$show")
  case "$st" in
    active|ready|starting|idle) return 0 ;;
    *) log "the worker is '$st'"; return 1 ;;
  esac
}

drain || { drc=$?; [[ "$drc" -eq 2 ]] && exit 4 || exit 1; }
oc=$(outcome_of) && finish "$oc"
n=0
while :; do
  WRC=0; WAIT=$("$ORCA_BIN" orchestration check --terminal "$PH" --wait --timeout-ms "$TMO" --json 2>/dev/null) || WRC=$?
  [[ "$WRC" -eq 0 ]] || { log "check --wait failed (rc=$WRC)"; exit 4; }
  jq -e '.ok == true' <<<"$WAIT" >/dev/null 2>&1 || { log "check --wait receipt was not ok"; exit 4; }
  drain || { drc=$?; [[ "$drc" -eq 2 ]] && exit 4 || exit 1; }
  oc=$(outcome_of) && finish "$oc"
  healthy || exit 4
  n=$((n + 1))
  [[ "$n" -lt "$MAXW" ]] || { log "reached --max-waits ($MAXW); inspect and decide"; exit 3; }
done
