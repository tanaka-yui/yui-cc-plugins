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
ORCA_BIN="${ORCA_BIN:-${ORCA_CLI_COMMAND:-/Applications/Orca.app/Contents/Resources/bin/orca}}"
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
#
# ★ **鍵は status dir ではなく (status dir, role) の組である。**レビューモードでは 1 つの
#   タスクが 2 つの dispatch を持ち、**両方が worker_done を送る**。status dir 単位で
#   期待集合を作ると reviewer の message が未知になり、`batch carries a message this
#   version cannot handle` で **batch ごと永久に詰まる**。
PH="" RUN=""
T_SD=() T_ROLE=() TASKS=() DISPS=()
for sd in "${SDS[@]}"; do
  [[ -r "$sd/run.json" && -r "$sd/workers.json" ]] || die "cannot read the dispatch state in $sd"
  h=$(jq -r '.parent_handle // empty' "$sd/run.json")
  r=$(jq -r '.run_id // empty' "$sd/run.json")
  [[ -n "$h" && -n "$r" ]] || die "the dispatch identity is incomplete in $sd"
  [[ -z "$PH"  || "$PH"  == "$h" ]] || die "the status dirs do not share one parent terminal"
  [[ -z "$RUN" || "$RUN" == "$r" ]] || die "the status dirs do not share one Run"
  found=0
  while IFS= read -r role; do
    t=$(jq -r --arg r "$role" '.roles[$r].task // empty' "$sd/workers.json")
    d=$(jq -r --arg r "$role" '.roles[$r].dispatch // empty' "$sd/workers.json")
    # ★ **まだ起動していない役は飛ばす。**片方だけ在るのは記録の破れなので開始時に閉じる —
    #   dispatch を知らない worker の worker_done は routing できず、batch を詰まらせる。
    [[ -n "$t" || -n "$d" ]] || continue
    [[ -n "$t" && -n "$d" ]] || die "the dispatch identity is incomplete for role '$role' in $sd"
    # ★ **同じ (task, dispatch) を 2 つが名乗ってはならない**（2 つの dir でも、
    #   1 つの dir の 2 役でも同じ事故である）。idx_of は先頭しか返さない
    #   ので、batch は 1 つ目だけに記録されたまま ack される。2 つ目は永久に settle せず
    #   receipt も残らない。他の identity 不一致と同じく **開始時に閉じる**
    for ((j = 0; j < ${#TASKS[@]}; j++)); do
      [[ "${TASKS[$j]}" != "$t" || "${DISPS[$j]}" != "$d" ]] \
        || die "the same dispatch is named twice (task '$t' dispatch '$d')"
    done
    T_SD+=("$sd"); T_ROLE+=("$role"); TASKS+=("$t"); DISPS+=("$d"); found=1
  done < <(jq -r '.roles | keys[]' "$sd/workers.json" 2>/dev/null)
  [[ "$found" -eq 1 ]] || die "no dispatched role is recorded in $sd"
  PH="$h"; RUN="$r"
done

# ★ 添字が (task, dispatch) の鍵である。bash 3.2 に連想配列は無いので、
#   T_SD/T_ROLE/TASKS/DISPS を同じ添字で引ける整数を map の key として使う。
idx_of() {   # $1=task $2=dispatch → 添字を stdout。集合に無ければ 1
  local i
  for i in "${!TASKS[@]}"; do
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
stored_outcome() {   # $1=status dir $2=role。receipt が 1 件なら outcome を stdout、0 件なら空、壊れていれば 1
  local sd="$1" role="$2" recv matches count tid did
  recv="$sd/received.json"
  tid=$(jq -r --arg r "$role" '.roles[$r].task // empty' "$sd/workers.json")
  did=$(jq -r --arg r "$role" '.roles[$r].dispatch // empty' "$sd/workers.json")
  [[ -f "$recv" ]] || return 0
  matches=$(jq -c --arg task "$tid" --arg dispatch "$did" \
    'if type != "array" or any(.[]; type != "string" or (split("|") | length) != 4) then error("invalid receipts")
     else [.[] | split("|") | select(.[0] == "worker_done" and .[1] == $task and .[2] == $dispatch)]
     end' "$recv" 2>/dev/null) || { log "received outcome record is invalid or unreadable; it is not acknowledged"; return 1; }
  count=$(jq 'length' <<<"$matches") || { log "received outcome record is invalid or unreadable; it is not acknowledged"; return 1; }
  [[ "$count" -le 1 ]] || { log "received outcome record has duplicate receipts; it is not acknowledged"; return 1; }
  [[ "$count" -eq 0 ]] || jq -r '.[0][3]' <<<"$matches"
}
record_outcome() {   # $1=status dir $2=task $3=dispatch $4=outcome。1 = 記録が壊れている / 2 = 書けなかった
  local sd="$1" records receipt updated
  records='[]'
  if [[ -f "$sd/received.json" ]]; then
    # ★ **空を「receipt 0 件」と読まない。**jq は空入力に空を返して 0 で終わるので、
    #   検査しないまま追記すると空のまま write が成功し、**ack が通って message が消える**
    [[ -s "$sd/received.json" ]] || {
      log "the received outcome record in $sd is empty; it is not acknowledged"; return 1; }
    records=$(jq -c . "$sd/received.json") && [[ -n "$records" ]] || {
      log "received outcome record is invalid or unreadable; it is not acknowledged"; return 1; }
  fi
  receipt="worker_done|$2|$3|$4"
  # ★ jq の出力を **検査せずに write へ渡さない**。空を書けば receipt が消える
  updated=$(jq -c --arg receipt "$receipt" '. + [$receipt]' <<<"$records") && [[ -n "$updated" ]] || {
    log "could not build the outcome record for dispatch '$3'; it is not acknowledged"; return 2; }
  write "$sd" "$sd/received.json" "$updated" \
    || { log "could not record the worker outcome for dispatch '$3'; it is not acknowledged"; return 2; }
}

# ★ **相 3 の検証。**役ごとに「成果が検証可能な形で在るか」を見る（spec 10-1 の表）。
#   ここを緩めると、成果が無いのに受理して端末を閉じ、**欠落に誰も気づかない**。
verify_role() {   # $1=status dir $2=role → 0 = 受理してよい / 1 = 差し戻す（理由を stdout）
  local sd="$1" role="$2" rd="$1/roles/$2" ir integ
  case "$role" in
    design)
      ir=$(jq -r '.integration_role // "design"' "$sd/workers.json" 2>/dev/null || echo design)
      if [[ "$ir" != design ]]; then
        # 実装役が別に居る = design は計画役である。計画の実在を見る
        [[ -s "$sd/plan.md" ]] || { echo "plan.md is missing or empty"; return 1; }
      else
        [[ -s "$rd/result.md" ]] || { echo "result.md is missing or empty"; return 1; }
      fi ;;
    exec)
      [[ -s "$rd/result.md" ]] || { echo "result.md is missing or empty"; return 1; }
      integ=$(jq -r '.integration // "merge"' "$sd/integration-result.json" 2>/dev/null || echo merge)
      # `integration=pr` を選んだ dispatch でも、PR を作るのは親（Step 4）である。
      # ここで pr_url を要求すると、まだ作っていない段階で必ず差し戻すことになる
      ;;
    design_review|exec_review)
      # ★ **review 役を例外にしない**（spec 10-4）。例外にすると findings の受理時点が
      #   未定義のまま端末が閉じられ、欠落に誰も気づかない。
      local pfx=plan; [[ "$role" == exec_review ]] && pfx=code
      local f found=0
      for f in "$sd"/review/$pfx-round-*-findings.md; do
        [[ -e "$f" ]] || continue
        found=1
        grep -q '^VERDICT: ' "$f" || { echo "$(basename "$f") has no VERDICT line"; return 1; }
      done
      # 1 ラウンドも担当しなかった reviewer は、findings が無いのが正しい
      [[ "$found" -eq 1 || -s "$rd/result.md" ]] \
        || { echo "neither findings nor result.md exist"; return 1; } ;;
    *)
      [[ -s "$rd/result.md" ]] || { echo "result.md is missing or empty"; return 1; } ;;
  esac
  return 0
}

# ★ **相 4a / 4b。**受理も差し戻しも **同じ active な Dispatch** へ返す。別の宛先へ送ると
#   worker は待ち続ける。
reply_completion() {   # $1=dispatch $2=nonce $3=accepted|remediation $4=本文
  local subject="completion-accepted: $2"
  [[ "$3" == accepted ]] || subject="completion-remediation: $2"
  "$ORCA_BIN" orchestration send --to "dispatch:$1" --type status \
    --subject "$subject" --body "$4" --from "$PH" --json >/dev/null 2>&1
}

drain() {   # 0 = batch を処理し切った / 1 = 処理できないものがあった（ack しない）/ 2 = transport または receipt が不明
  local out res n i m payload d t tid did oc idx tsd trole rcode rreason existing upd RET RETRC ACK CHECKRC
  local mrn vreason vok esub msub
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
  for ((i = 0; i < ${#TASKS[@]}; i++)); do SETTLED[$i]=""; done
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
    # ★ **相 3〜4。**`merge_ready` は worker が「検証してくれ」と言っている状態である。
    #   検証して受理か差し戻しを **同じ Dispatch** へ返し、この message は処理済みにする。
    if [[ "$t" == merge_ready ]]; then
      idx=$(idx_of "$tid" "$did") || idx=""
      if [[ -z "$idx" ]]; then
        log "batch $d carries a merge_ready for an unknown dispatch (task='$tid' dispatch='$did')"
        return 1
      fi
      # ★ **nonce は subject で運ぶ。**`--payload` は `--task-id` などの便宜フラグに
      #   上書きされるので、そこへ入れても届かない（実測: payload に taskId と dispatchId
      #   しか残らなかった）。payload 側も一応見るが、正本は subject である。
      msub=$(jq -r '.subject // empty' <<<"$m")
      mrn=$(sed -n 's/^merge_ready: *//p' <<<"$msub" | head -1)
      [[ -n "$mrn" ]] || mrn=$(jq -r '.nonce // empty' <<<"$payload")
      [[ -n "$mrn" ]] || {
        log "merge_ready from dispatch '$did' carries no nonce (subject '${msub:-none}')"
        return 1; }
      vreason=$(verify_role "${T_SD[$idx]}" "${T_ROLE[$idx]}") && vok=0 || vok=1
      if [[ "$vok" -eq 0 ]]; then
        reply_completion "$did" "$mrn" accepted "the work is accepted; finish and report" || {
          log "could not send the acceptance to dispatch '$did'; the batch is not acknowledged"; return 2; }
        log "accepted ${T_ROLE[$idx]} (dispatch $did)"
      else
        reply_completion "$did" "$mrn" remediation "$vreason" || {
          log "could not send the remediation to dispatch '$did'; the batch is not acknowledged"; return 2; }
        log "sent ${T_ROLE[$idx]} back for remediation (dispatch $did): $vreason"
      fi
      continue
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
  for ((i = 0; i < ${#TASKS[@]}; i++)); do
    [[ -n "${SETTLED[$i]}" ]] || continue
    tsd="${T_SD[$i]}"; trole="${T_ROLE[$i]}"; tid="${TASKS[$i]}"; did="${DISPS[$i]}"; oc="${SETTLED[$i]}"
    existing=$(stored_outcome "$tsd" "$trole") || return 1
    if [[ -n "$existing" && "$existing" != "$oc" ]]; then
      log "received outcome '$existing' contradicts batch outcome '$oc' for task '$tid' dispatch '$did'"
      return 1
    fi
    # ★ 記録できなかったのは **retention の write 失敗と同じ種類の事故**である。
    #   ふつうの filesystem エラーを 1 (再実行しても無駄) に落としてはならない (return 2)
    [[ -n "$existing" ]] || record_outcome "$tsd" "$tid" "$did" "$oc" || return $?
    # ★ **ack より前に owner を決める**（Orca guide）。この版の owner は常に「保持」である。
    #   解放は Step 6 のユーザー承認後だけが行う (spec D12)。
    RETRC=0
    RET=$("$ORCA_BIN" orchestration worker-retain --dispatch "$did" --json 2>/dev/null) || RETRC=$?
    # ★ **どの dispatch で失敗したかを名指しする。**4 件を drain している最中に id の無い
    #   診断だけ出しても、どれを調べればよいか分からない。
    #   receipt が問題のときに rc= を出さない — RETRC は process の状態であって receipt ではない
    jq -e '.ok == true' <<<"$RET" >/dev/null 2>&1 || {
      log "worker-retain receipt was not ok for dispatch '$did'; the batch is not acknowledged"
      return 2
    }
    [[ "$RETRC" -eq 0 ]] || {
      log "worker-retain failed (rc=$RETRC) for dispatch '$did'; the batch is not acknowledged"
      return 2
    }
    upd=$(jq -c --arg r "$trole" '.roles[$r].retained = true' "$tsd/workers.json") && [[ -n "$upd" ]] \
      && write "$tsd" "$tsd/workers.json" "$upd" || {
      log "could not record the retention for dispatch '$did'; the batch is not acknowledged"
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
  # ★ **終端の条件は「起動した全 dispatch の receipt が揃うこと」。**reviewer の
  #   worker_done を待たずに戻ると、その message はあとから来て次の batch を詰まらせる。
  local i sd st oc existing worst=succeeded
  for i in "${!TASKS[@]}"; do
    existing=$(stored_outcome "${T_SD[$i]}" "${T_ROLE[$i]}") || return 1
    [[ -n "$existing" ]] || return 1
  done
  # ★ **タスクの結末を決めるのは「成果を載せる役」である。**レビュー役が失敗しても、
  #   それは「レビューが付かなかった」であって成果が失われたわけではない。その役の
  #   outcome は finish が 1 行ずつ出すので、握り潰してはいない。
  #
  #   ★ 成果を載せる役は `integration_role`（実装役を分けたら design ではなく exec）。
  #   **記録が無ければ design に落とす。**merge は同じ場面で止まるが (MG12)、あちらは
  #   取り違えると成果を失う破壊的な操作である。待機は何も壊さないうえ、取り違えても
  #   merge の厳格な gate が受け止める。ここで止めると、記録の無い古い status dir を
  #   drain できなくなるほうが害が大きい。
  local irole
  for i in "${!SDS[@]}"; do
    sd="${SDS[$i]}"
    irole=$(jq -r '.integration_role // "design"' "$sd/workers.json" 2>/dev/null || echo design)
    [[ -n "$irole" ]] || irole=design
    st=$(jq -r '.status // empty' "$sd/roles/$irole/status.json" 2>/dev/null || echo "")
    case "$st" in
      done)  oc=succeeded ;;
      error) oc=failed ;;
      *) return 1 ;;
    esac
    existing=$(stored_outcome "$sd" "$irole") || return 1
    [[ "$existing" == "$oc" ]] || return 1
    [[ "$oc" == succeeded ]] || worst=failed
  done
  printf '%s' "$worst"
}
finish() {   # $1 = 集約 outcome。**どの役のどのタスクが失敗したかを名指しする**
  local i oc
  for i in "${!TASKS[@]}"; do
    oc=$(stored_outcome "${T_SD[$i]}" "${T_ROLE[$i]}") || oc=""
    echo "task=${TASKS[$i]} role=${T_ROLE[$i]} dispatch=${DISPS[$i]} status_dir=${T_SD[$i]} outcome=${oc:-unknown}"
  done
  echo "outcome=$1"
  [[ "$1" == succeeded ]] && exit 0 || exit 5
}
healthy() {   # **人の入力待ちは healthy である**（CLI help）。1 つでも不健全なら非 0
  local i show st wait SHOWRC settled
  for i in "${!DISPS[@]}"; do
    # ★ **settle した dispatch を health check にかけない**（実測: 決着済みの dispatch の
    #   worker-show は state 'succeeded' を返す。許容集合の外である）。かけると、先に
    #   終わった 1 件が、まだ働いている兄弟ごと wait を 4 で落とす。
    #   receipt があるなら、その dispatch はもう待つ対象ではない
    settled=$(stored_outcome "${T_SD[$i]}" "${T_ROLE[$i]}") || settled=""
    [[ -z "$settled" ]] || continue
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
