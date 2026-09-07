#!/usr/bin/env bash
# orca-wait.sh — 自分の worker たちの worker_done を待つ。
# 実測 (spec 6-5): cursor を進めるのは ack だけ (O22/O23) / --types は batch を絞らない (O27)
#                  keepalive は stderr、2>&1 で混ぜない (O10) / selector は --terminal
# **ack は「batch 全件を処理した」の宣言である** (O11)。処理できない message が 1 つでも
# あれば ack しない。Stage 1 の親は worker_done しか処理できないので、それ以外が来たら
# 診断を出して止まる（Task spec 側で ask / escalation を禁じてある）。
# **ledger も再 emit も pending replay も無い**（Stage 1。spec 18-1）。
# 複数の --status-dir を受けると、1 本の FIFO Delivery を既知の (task, dispatch) 集合に
# 照らして drain する。**outcome の矛盾検査は dispatch ごと**であり batch 全体ではない
# （別タスクが同じ batch で別々に settle するのは正常である）。
# Usage: orca-wait.sh --status-dir <d> [--status-dir <d> ...] [--max-waits <n>] [--timeout-ms <n>]
# Exit: 0 全件成功 / 5 1 件以上が失敗 / 1 batch を処理できない / 2 使用法 / 3 時間切れ
#       / 4 transport または worker state が不明
set -uo pipefail
die() { echo "orca-wait: $1" >&2; exit 2; }
log() { echo "orca-wait: $1" >&2; }
ORCA_BIN="${ORCA_BIN:-/Applications/Orca.app/Contents/Resources/bin/orca}"
need2() { [[ "$2" -ge 2 ]] || die "$1 requires a value"; }
SDS=() MAXW=12 TMO=300000
while [[ $# -gt 0 ]]; do case "$1" in
  --status-dir) need2 "$1" $#; SDS+=("$2"); shift 2 ;;
  --max-waits)  need2 "$1" $#; MAXW="$2";   shift 2 ;;
  --timeout-ms) need2 "$1" $#; TMO="$2";    shift 2 ;;
  *) die "unknown option: $1" ;;
esac; done
[[ "${#SDS[@]}" -ge 1 ]] || die "--status-dir is required"
[[ "$MAXW" =~ ^[1-9][0-9]*$ ]] || die "--max-waits must be a positive integer"
[[ "$TMO" =~ ^[1-9][0-9]*$ ]] || die "--timeout-ms must be a positive integer"

# 期待集合。**1 本の Delivery を共有する以上、親端末と Run は 1 つでなければならない。**
PH="" RUN=""
TASKS=() DISPS=()
for sd in "${SDS[@]}"; do
  [[ -r "$sd/run.json" && -r "$sd/workers.json" ]] || die "cannot read the dispatch state in $sd"
  h=$(jq -r '.parent_handle // empty' "$sd/run.json")
  r=$(jq -r '.run_id // empty' "$sd/run.json")
  t=$(jq -r '.roles.design.task // empty' "$sd/workers.json")
  d=$(jq -r '.roles.design.dispatch // empty' "$sd/workers.json")
  [[ -n "$h" && -n "$r" && -n "$t" && -n "$d" ]] || die "the dispatch identity is incomplete in $sd"
  [[ -z "$PH"  || "$PH"  == "$h" ]] || die "the status dirs do not share one parent terminal"
  [[ -z "$RUN" || "$RUN" == "$r" ]] || die "the status dirs do not share one Run"
  PH="$h"; RUN="$r"; TASKS+=("$t"); DISPS+=("$d")
done

# ★ 添字が (task, dispatch) の鍵である。bash 3.2 に連想配列は無いので、SDS/TASKS/DISPS と
#   同じ添字で引ける整数を map の key として使う。
idx_of() {   # $1=task $2=dispatch → 添字を stdout。集合に無ければ 1
  local i
  for i in "${!SDS[@]}"; do
    [[ "${TASKS[$i]}" == "$1" && "${DISPS[$i]}" == "$2" ]] || continue
    printf '%s' "$i"; return 0
  done
  return 1
}
write() {   # $1=status dir $2=path $3=content
  local t
  t=$(mktemp "$1/.tmp.XXXXXX") || return 1
  printf '%s\n' "$3" > "$t" && mv -f "$t" "$2" || { rm -f "$t"; return 1; }
}
stored_outcome() {   # $1=status dir。receipt が 1 件なら outcome を stdout、0 件なら空、壊れていれば 1
  local sd="$1" recv matches count tid did
  recv="$sd/received.json"
  tid=$(jq -r '.roles.design.task // empty' "$sd/workers.json")
  did=$(jq -r '.roles.design.dispatch // empty' "$sd/workers.json")
  [[ -f "$recv" ]] || return 0
  matches=$(jq -c --arg task "$tid" --arg dispatch "$did" \
    'if type != "array" or any(.[]; type != "string" or (split("|") | length) != 4) then error("invalid receipts")
     else [.[] | split("|") | select(.[0] == "worker_done" and .[1] == $task and .[2] == $dispatch)]
     end' "$recv" 2>/dev/null) || { log "received outcome record is invalid or unreadable; it is not acknowledged"; return 1; }
  count=$(jq 'length' <<<"$matches") || { log "received outcome record is invalid or unreadable; it is not acknowledged"; return 1; }
  [[ "$count" -le 1 ]] || { log "received outcome record has duplicate receipts; it is not acknowledged"; return 1; }
  [[ "$count" -eq 0 ]] || jq -r '.[0][3]' <<<"$matches"
}
record_outcome() {   # $1=status dir $2=task $3=dispatch $4=outcome
  local sd="$1" records receipt
  records='[]'
  if [[ -f "$sd/received.json" ]]; then
    records=$(jq -c . "$sd/received.json") || { log "received outcome record is invalid or unreadable; it is not acknowledged"; return 1; }
  fi
  receipt="worker_done|$2|$3|$4"
  write "$sd" "$sd/received.json" "$(jq -c --arg receipt "$receipt" '. + [$receipt]' <<<"$records")" \
    || { log "could not record the worker outcome; it is not acknowledged"; return 1; }
}

drain() {   # 0 = batch を処理し切った / 1 = 処理できないものがあった（ack しない）/ 2 = transport または receipt が不明
  local out res n i m payload d t tid did oc idx tsd rcode rreason existing RET RETRC ACK CHECKRC
  local -a SETTLED
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
  # SETTLED[添字] = この batch がその dispatch に与えた outcome。空なら未登場
  SETTLED=()
  for ((i = 0; i < ${#SDS[@]}; i++)); do SETTLED[$i]=""; done
  for ((i = 0; i < n; i++)); do
    m=$(jq -c ".messages[$i]" <<<"$res")
    t=$(jq -r '.type // empty' <<<"$m")
    # 実 Orca の payload は JSON を文字列化して返す。object 形式も後方互換で受ける。
    payload=$(jq -ce '.payload
      | if type == "string" then fromjson? else . end
      | select(type == "object")' <<<"$m") || {
      log "this version handles only worker_done messages; the message was left unacknowledged"
      return 1
    }
    tid=$(jq -r '.taskId // empty' <<<"$payload")
    did=$(jq -r '.dispatchId // empty' <<<"$payload")
    if [[ "$(jq -r 'has("_orcaLifecycleRejection")' <<<"$payload")" == true ]]; then
      rcode=$(jq -r '._orcaLifecycleRejection | if type == "object" then .code // "unknown" else "unknown" end' <<<"$payload")
      rreason=$(jq -r '._orcaLifecycleRejection | if type == "object" then .reason // "unknown" else "unknown" end' <<<"$payload")
      log "worker_done was rejected by Orca (code='$rcode' reason='$rreason'); the batch is not acknowledged"
      return 1
    fi
    # ★ **処理できない message は捨てない。**捨てて ack すると cursor だけ進んで内容が消える
    idx=""
    [[ "$t" != worker_done ]] || idx=$(idx_of "$tid" "$did") || idx=""
    if [[ -z "$idx" ]]; then
      log "batch $d carries a message this version cannot handle (type='$t' task='$tid' dispatch='$did')"
      log "it is NOT acknowledged, so nothing is lost. Inspect with:"
      log "  $ORCA_BIN orchestration check --terminal $PH --peek --json"
      return 1
    fi
    oc=$(jq -r '.outcome // empty' <<<"$payload")
    case "$oc" in
      succeeded|failed) ;;
      *) log "worker_done has outcome '${oc:-none}'"; return 1 ;;
    esac
    # ★ 矛盾は **同じ (task, dispatch) の中だけ**で見る。別タスクが別 outcome で settle するのは正常
    [[ -z "${SETTLED[$idx]}" || "${SETTLED[$idx]}" == "$oc" ]] || {
      log "batch $d has contradictory outcomes for task '$tid' dispatch '$did'"
      return 1
    }
    SETTLED[$idx]="$oc"
  done
  # settle した dispatch を 1 つずつ記録し retain する。**1 件でも失敗したら ack せずに戻る。**
  for ((i = 0; i < ${#SDS[@]}; i++)); do
    [[ -n "${SETTLED[$i]}" ]] || continue
    tsd="${SDS[$i]}"; tid="${TASKS[$i]}"; did="${DISPS[$i]}"; oc="${SETTLED[$i]}"
    existing=$(stored_outcome "$tsd") || return 1
    if [[ -n "$existing" && "$existing" != "$oc" ]]; then
      log "received outcome '$existing' contradicts batch outcome '$oc' for task '$tid' dispatch '$did'"
      return 1
    fi
    [[ -n "$existing" ]] || record_outcome "$tsd" "$tid" "$did" "$oc" || return 1
    # ★ **ack より前に owner を決める**（Orca guide）。この版の owner は常に「保持」である。
    #   解放は Step 6 のユーザー承認後だけが行う (spec D12)。
    RETRC=0
    RET=$("$ORCA_BIN" orchestration worker-retain --dispatch "$did" --json 2>/dev/null) || RETRC=$?
    jq -e '.ok == true' <<<"$RET" >/dev/null 2>&1 || {
      log "worker-retain receipt was not ok (rc=$RETRC); the batch is not acknowledged"
      return 2
    }
    [[ "$RETRC" -eq 0 ]] || {
      log "worker-retain failed (rc=$RETRC); the batch is not acknowledged"
      return 2
    }
    write "$tsd" "$tsd/workers.json" "$(jq -c '.roles.design.retained = true' "$tsd/workers.json")" || {
      log "could not record the retention; the batch is not acknowledged"
      return 2
    }
  done
  ACK=$("$ORCA_BIN" orchestration check --terminal "$PH" --ack "$d" --json 2>/dev/null) || {
    log "ack transport failed; the batch will replay"
    return 2
  }
  jq -e '.ok == true' <<<"$ACK" >/dev/null 2>&1 || { log "ack receipt was not ok; the batch will replay"; return 2; }
  return 0
}
aggregate() {   # 全 dispatch が終端なら集約 outcome を stdout。1 件でも未終端なら 1
  local i sd st oc existing worst=succeeded
  for i in "${!SDS[@]}"; do
    sd="${SDS[$i]}"
    st=$(jq -r '.status // empty' "$sd/roles/design/status.json" 2>/dev/null || echo "")
    case "$st" in
      done)  oc=succeeded ;;
      error) oc=failed ;;
      *) return 1 ;;
    esac
    existing=$(stored_outcome "$sd") || return 1
    [[ "$existing" == "$oc" ]] || return 1
    [[ "$oc" == succeeded ]] || worst=failed
  done
  printf '%s' "$worst"
}
finish() {   # $1 = 集約 outcome。**どのタスクが失敗したかを名指しする**
  local i oc
  for i in "${!SDS[@]}"; do
    oc=$(stored_outcome "${SDS[$i]}") || oc=""
    echo "task=${TASKS[$i]} dispatch=${DISPS[$i]} status_dir=${SDS[$i]} outcome=${oc:-unknown}"
  done
  echo "outcome=$1"
  [[ "$1" == succeeded ]] && exit 0 || exit 5
}
healthy() {   # **人の入力待ちは healthy である**（CLI help）。1 つでも不健全なら非 0
  local i show st wait SHOWRC
  for i in "${!DISPS[@]}"; do
    SHOWRC=0
    show=$("$ORCA_BIN" orchestration worker-show --dispatch "${DISPS[$i]}" --json 2>/dev/null) || SHOWRC=$?
    [[ "$SHOWRC" -eq 0 ]] || { log "worker-show failed (rc=$SHOWRC)"; return 2; }
    jq -e '.ok == true and (.result | type == "object")' <<<"$show" >/dev/null 2>&1 || {
      log "worker-show receipt was not ok"
      return 2
    }
    wait=$(jq -r '.result.observation.agentWait // empty' <<<"$show")
    [[ -n "$wait" && "$wait" != null ]] && continue
    st=$(jq -r '.result.worker.state // empty' <<<"$show")
    case "$st" in
      active|ready|starting|idle) ;;
      *) log "the worker for dispatch '${DISPS[$i]}' is '$st'"; return 1 ;;
    esac
  done
  return 0
}

drain || { drc=$?; [[ "$drc" -eq 2 ]] && exit 4 || exit 1; }
oc=$(aggregate) && finish "$oc"
n=0
while :; do
  WRC=0; WAIT=$("$ORCA_BIN" orchestration check --terminal "$PH" --wait --timeout-ms "$TMO" --json 2>/dev/null) || WRC=$?
  [[ "$WRC" -eq 0 ]] || { log "check --wait failed (rc=$WRC)"; exit 4; }
  jq -e '.ok == true' <<<"$WAIT" >/dev/null 2>&1 || { log "check --wait receipt was not ok"; exit 4; }
  drain || { drc=$?; [[ "$drc" -eq 2 ]] && exit 4 || exit 1; }
  oc=$(aggregate) && finish "$oc"
  healthy || exit 4
  n=$((n + 1))
  [[ "$n" -lt "$MAXW" ]] || { log "reached --max-waits ($MAXW); inspect and decide"; exit 3; }
done
