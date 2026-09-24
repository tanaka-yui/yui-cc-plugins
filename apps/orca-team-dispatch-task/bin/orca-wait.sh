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
#                     [--stall-after-min <n>] [--on-stall ask|report]
# Exit: 0 全件成功 / 5 1 件以上が失敗 / 1 batch を処理できない / 2 使用法 / 3 時間切れ
#       / 4 transport または worker state が不明 / 6 worker が人へ質問している
#       / 8 進んでいないタスクがある（--on-stall ask のとき。止めるかはユーザーが決める）
set -uo pipefail
die() { echo "orca-wait: $1" >&2; exit 2; }
log() { echo "orca-wait: $1" >&2; }
ORCA_BIN="${ORCA_BIN:-${ORCA_CLI_COMMAND:-/Applications/Orca.app/Contents/Resources/bin/orca}}"
need2() { [[ "$2" -ge 2 ]] || die "$1 requires a value"; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WAKE="$HERE/orca-wake.ts"
# ★ **既定は 24 時間**（5 分 × 288）。子は待機に期限を持たないので、これは子を見捨てる期限では
#   ない。24 時間ごとに exit 3 で状況を報告し、親が呼び直すための区切りである。
# ★ **停滞の既定は 120 分。**子が書くものがそれだけ変わらなければ知らせる（止めはしない）。
SDS=() MAXW=288 TMO=300000 STALL_MIN=120 ON_STALL=ask
# 起こし直しの間隔と、waiter_exists の待ち。テストが実時間を使わずに済むよう env で開ける。
WAKE_INTERVAL="${ORCA_WAKE_INTERVAL_SECONDS:-1800}"
WAITER_RETRY="${ORCA_WAITER_RETRY_SECONDS:-20}"
WAITER_TRIES="${ORCA_WAITER_RETRY_TRIES:-15}"
while [[ $# -gt 0 ]]; do case "$1" in
  --status-dir) need2 "$1" $#; SDS+=("$2"); shift 2 ;;
  --max-waits)  need2 "$1" $#; MAXW="$2";   shift 2 ;;
  --timeout-ms) need2 "$1" $#; TMO="$2";    shift 2 ;;
  --stall-after-min) need2 "$1" $#; STALL_MIN="$2"; shift 2 ;;
  --on-stall)        need2 "$1" $#; ON_STALL="$2";  shift 2 ;;
  *) die "unknown option: $1" ;;
esac; done
[[ "${#SDS[@]}" -ge 1 ]] || die "--status-dir is required"
[[ "$MAXW" =~ ^[1-9][0-9]*$ ]] || die "--max-waits must be a positive integer"
[[ "$TMO" =~ ^[1-9][0-9]*$ ]] || die "--timeout-ms must be a positive integer"
[[ "$STALL_MIN" =~ ^[1-9][0-9]*$ ]] || die "--stall-after-min must be a positive integer"
case "$ON_STALL" in ask|report) ;; *) die "--on-stall must be ask or report: $ON_STALL" ;; esac
# テストが実時間を使わずに済むよう、秒で上書きできる（他の間隔と同じ構え）
STALL_SECONDS="${ORCA_STALL_AFTER_SECONDS:-$((STALL_MIN * 60))}"

# 期待集合。**1 本の Delivery を共有する以上、親端末と Run は 1 つでなければならない。**
#
# ★ **鍵は status dir ではなく (status dir, role) の組である。**レビューモードでは 1 つの
#   タスクが 2 つの dispatch を持ち、**両方が worker_done を送る**。status dir 単位で
#   期待集合を作ると reviewer の message が未知になり、`batch carries a message this
#   version cannot handle` で **batch ごと永久に詰まる**。
PH="" RUN=""
T_SD=() T_ROLE=() TASKS=() DISPS=()
# ★ **期待集合は組み直せる必要がある。**`orca-start.sh --phase exec` は、この待機が
#   走っている最中に `workers.json` へ 2 段目の dispatch を足す。起動時に 1 度読んだ
#   きりだと、その dispatch の message が「未知」になって batch ごと落ちる
#   （実測 2026-09-11: exec の merge_ready が `unknown dispatch` で exit 1 になった）。
load_roles() {
  local sd h r role t d found j
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
}
roles_key() { local i; for i in "${!TASKS[@]}"; do printf '%s|%s\n' "${TASKS[$i]}" "${DISPS[$i]}"; done; }
load_roles
# drain が「知らない dispatch に出会った」と言うときの身元。drain の外で診断に使う
UNK_TYPE="" UNK_T="" UNK_D="" UNK_BATCH=""

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
# ★ **「誰も待っていない」をディスクから分かるようにする。**この待機は最大 24 時間
#   常駐するので、**ホスト側の都合で外から止められることがある**（実測 2026-09-11、
#   2 回連続: worker 自身が同じマシンでテストを並列に回してメモリを食い、ハーネスが
#   メモリ逼迫を理由にこのプロセスを停止した）。ack より前に落ちるので取りこぼしは
#   無い設計どおりだが、**誰も起動し直さなければ worker は永久に返事を待つ。**
#   気づくかどうかを人の記憶に賭けない — 鼓動を残し、`orca-recover.sh` に読ませる。
#   **鼓動の失敗で待機を止めない。**書けないことは、待てないことではない。
beat() {
  local sd stamp
  stamp=$(jq -nc --argjson p "$$" --argjson b "$(date +%s)" --argjson w "$TMO" \
            '{pid: $p, beat: $b, window_ms: $w}') || return 0
  for sd in "${SDS[@]}"; do write "$sd" "$sd/wait.json" "$stamp" || true; done
  return 0
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
# ★ **ユーザーが止めた役は決着済みとして扱う**（`orca-stop.ts`）。止めた端末は閉じてあり、
#   worker_done は二度と来ない。**receipt が在ればそれが優先する**（閉じる直前に送られた場合）。
is_stopped() { [[ -f "$1/roles/$2/stopped.json" ]]; }
role_outcome() {   # $1=status dir $2=role → receipt の outcome、無ければ止めた役は stopped。壊れていれば 1
  local oc
  oc=$(stored_outcome "$1" "$2") || return 1
  if [[ -z "$oc" ]] && is_stopped "$1" "$2"; then oc=stopped; fi
  printf '%s' "$oc"
}

# ★ **停滞は親が見つけ、止めるかどうかは人が決める。**子は待機に期限を持たない（待っている
#   相手の事情を知らないので「来ない」を判断できない）。タスク単位で「子が書くもの」が一定時間
#   どれも変わらなければ知らせる。**親が書くもの（wait.json / .woken / received.json /
#   questions.json / stall.json）は数えない** — 数えると親の鼓動で常に「変化あり」になる。
file_mtime() {   # $1=path → epoch。**GNU と BSD の stat の違いはここ 1 箇所で吸収する**
  stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0
}
LATEST=0
newer() { [[ "$1" =~ ^[0-9]+$ ]] && [[ "$1" -gt "$LATEST" ]] && LATEST="$1"; return 0; }
task_last_change() {   # $1=status dir → 子が最後に何かを変えた時刻（epoch）を stdout
  local sd="$1" f wt
  LATEST=0
  # 下限は dispatch の開始（run.json は起動時に 1 度だけ書かれる）
  newer "$(file_mtime "$sd/run.json")"
  # human.json は親が書くが、人とのやりとりの記録なので数える（人を待つ間は停滞ではない）
  for f in "$sd"/roles/*/status.json "$sd"/roles/*/result.md "$sd"/roles/*/completion.json \
           "$sd/spec.md" "$sd/plan.md" "$sd"/review/* "$sd/human.json"; do
    [[ -e "$f" ]] || continue
    newer "$(file_mtime "$f")"
  done
  while IFS= read -r wt; do
    [[ -n "$wt" && -d "$wt" ]] || continue
    newer "$(git -C "$wt" log -1 --format=%ct 2>/dev/null || echo 0)"
    while IFS= read -r f; do
      [[ -e "$wt/$f" ]] || continue
      newer "$(file_mtime "$wt/$f")"
    done < <(git -C "$wt" status --porcelain 2>/dev/null | cut -c4-)
  done < <(jq -r '.roles[].worktree_path // empty' "$sd/workers.json" 2>/dev/null)
  printf '%s' "$LATEST"
}
# ★ **人を待っている間は停滞ではない。**人とのやりとりを見た時点を残し、時計をそこから戻す。
#   書けなくても待機は止めない（最悪、ユーザーに 1 回余計に尋ねるだけで、誤って止めはしない）
mark_human() {   # $1=status dir
  write "$1" "$1/human.json" "$(jq -nc --argjson t "$(date +%s)" '{last_human_at: $t}')" || true
}
# ★ **停滞の判定は workers.json をその都度読む。**期待集合（TASKS）が読み直されるのは知らない
#   dispatch の message が来たときだけなので、`--phase exec` で足された exec は最初の message
#   まで見えない。そこで決着済みの design だけを見てタスクを決着済みと数えると、exec が何時間
#   黙っていても誰にも知らされない。
dispatched_roles() {   # $1=status dir → dispatch の記録が在る役を 1 行ずつ
  jq -r '.roles // {} | to_entries[] | select((.value.dispatch // "") != "") | .key' "$1/workers.json" 2>/dev/null
}
integration_role_of() {   # $1=status dir。記録が無ければ design に落とす（aggregate の注記を参照）
  local ir
  ir=$(jq -r '.integration_role // "design"' "$1/workers.json" 2>/dev/null || echo design)
  printf '%s' "${ir:-design}"
}
role_settled() {   # $1=status dir $2=role → receipt か stopped.json が在れば 0
  local oc
  oc=$(role_outcome "$1" "$2" 2>/dev/null) || return 1
  [[ -n "$oc" ]]
}
# ★ **成果が載る見込みの無くなったタスクは失敗で決着する。**作る役（design / exec）を
#   ユーザーが止めた（receipt 無し）か、計画役の design が失敗した。どちらも exec は起こされない
#   （Step 3.5）ので、integration_role=exec の status を待つと永久に終わらない。
task_given_up() {   # $1=status dir
  local sd="$1" r
  for r in design exec; do
    is_stopped "$sd" "$r" && [[ -z "$(stored_outcome "$sd" "$r" 2>/dev/null)" ]] && return 0
  done
  [[ "$(integration_role_of "$sd")" != design && "$(stored_outcome "$sd" design 2>/dev/null)" == failed ]]
}
task_settled() {   # $1=status dir → dispatch の在る役が全部決着し、成果を載せる役も決着していれば 0
  local sd="$1" role
  while IFS= read -r role; do
    role_settled "$sd" "$role" || return 1
  done < <(dispatched_roles "$sd")
  task_given_up "$sd" && return 0
  # ★ **成果を載せる役がまだ起動されていなければ決着していない**（Step 3.5 の飛ばし）
  role_settled "$sd" "$(integration_role_of "$sd")"
}
# ★ 依頼側がまだ待っている = dispatch が在り、receipt も stopped.json も無い（orca-stop.ts の waiting と同じ問い）
role_waiting() {   # $1=status dir $2=role
  jq -e --arg r "$2" '(.roles[$r].dispatch // "") != ""' "$1/workers.json" >/dev/null 2>&1 \
    && ! role_settled "$1" "$2"
}
stall_lines() {   # $1=status dir $2=止まっている分 → 報告行を stdout
  local sd="$1" role ph th slug ir open=0
  slug=$(basename "$sd")
  echo "stalled task=$slug status_dir=$sd idle_min=$2"
  # ★ **決着済み・止めた役は載せない。**載せると、止めたのに同じ役をまた尋ねる。
  #   ★ **例外は決着済みの reviewer で、依頼側がまだ待っているとき。**verdict を届けられずに
  #   終えた reviewer を止めれば依頼側へ review-skipped が届くが、止める選択肢はこの行からしか
  #   作られない。載せないと、ユーザーは待ち続けるか依頼側を止めるかしか選べない
  while IFS= read -r role; do
    if role_settled "$sd" "$role"; then
      case "$role" in
        design_review) is_stopped "$sd" "$role" || ! role_waiting "$sd" design && continue ;;
        exec_review)   is_stopped "$sd" "$role" || ! role_waiting "$sd" exec && continue ;;
        *) continue ;;
      esac
    else
      open=1
    fi
    ph=$(jq -r '.phase // empty' "$sd/roles/$role/completion.json" 2>/dev/null || echo "")
    [[ -n "$ph" ]] || ph=$(jq -r '.status // empty' "$sd/roles/$role/status.json" 2>/dev/null || echo "")
    th=$(jq -r --arg r "$role" '.roles[$r].terminal // empty' "$sd/workers.json" 2>/dev/null || echo "")
    echo "stalled_role task=$slug role=$role phase=${ph:-none} terminal=${th:-none}"
  done < <(dispatched_roles "$sd")
  # ★ 起動されていない成果の役を知らせるのは、起動済みの役が全部決着してから（計画役がまだ
  #   働いている間に Step 3.5 へ送らない）
  [[ "$open" -eq 0 ]] || return 0
  ir=$(integration_role_of "$sd")
  jq -e --arg r "$ir" '(.roles[$r].dispatch // "") != ""' "$sd/workers.json" >/dev/null 2>&1 \
    || task_given_up "$sd" || echo "unstarted_role task=$slug role=$ir"
}
check_stall() {   # 0 = 尋ねるべき停滞は無い / 1 = ask で停滞を stdout に出した（呼び出し側が 8 で抜ける）
  local sd now last snz idle cur upd l found=0
  now=$(date +%s)
  for sd in "${SDS[@]}"; do
    task_settled "$sd" && continue
    last=$(task_last_change "$sd")
    snz=$(jq -r '.snoozed_at // 0' "$sd/stall.json" 2>/dev/null || echo 0)
    [[ "$snz" =~ ^[0-9]+$ ]] && [[ "$snz" -gt "$last" ]] && last="$snz"
    cur=$(jq -c 'if type == "object" then . else {} end' "$sd/stall.json" 2>/dev/null) || cur='{}'
    [[ -n "$cur" ]] || cur='{}'
    if [[ $((now - last)) -lt "$STALL_SECONDS" ]]; then
      # 動き出したら、次の停滞をまた報告できるよう記録を消す
      if jq -e 'has("detected_at")' <<<"$cur" >/dev/null 2>&1; then
        upd=$(jq -c 'del(.detected_at, .idle_min)' <<<"$cur") && [[ -n "$upd" ]] \
          && write "$sd" "$sd/stall.json" "$upd" || true
      fi
      continue
    fi
    idle=$(( (now - last) / 60 ))
    if [[ "$ON_STALL" == ask ]]; then
      stall_lines "$sd" "$idle"; found=1; continue
    fi
    # ★ report は抜けない（無人の --issue）。**同じ停滞で毎周書かない**
    jq -e 'has("detected_at")' <<<"$cur" >/dev/null 2>&1 && continue
    while IFS= read -r l; do log "$l"; done < <(stall_lines "$sd" "$idle")
    upd=$(jq -c --argjson t "$now" --argjson m "$idle" '.detected_at = $t | .idle_min = $m' <<<"$cur") \
      && [[ -n "$upd" ]] && write "$sd" "$sd/stall.json" "$upd" \
      || log "could not record the stall in $sd/stall.json"
  done
  [[ "$found" -eq 0 ]]
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

# ★ **無レビューの成果を黙って通さない。**レビュー役が起きているのに verdict が 1 つも
#   残らないまま終わることが起きる（実測 2026-09-11: exec の review 待ちが waiter_exists で
#   始められず、verdict 無しで成果を差し出して succeeded になった）。
#   **ここで差し戻してはならない** — 「round 2 で打ち切り」も「1 時間 ×2 で諦めて進む」も
#   spec が認めた離脱経路であり、ゲートにするとその worker は永久に差し戻され続ける。
#   受理はする。**そのうえで、そう見えるようにする。**
#   判定そのものは `review-state.ts` が正本で、`orca-merge.ts` の gate と同じ問いを使う。
REVSTATE="$HERE/review-state.ts"
review_state() {   # $1=status dir $2=役 → reviewed / unreviewed / none を stdout
  node "$REVSTATE" --status-dir "$1" --role "$2" 2>/dev/null || printf none
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

# ★ **配送と起床は別の事実である。**`orchestration send` はメールボックスに入れるだけで、
#   ターンを終えた worker を起こさない（実測 2026-09-10: 1 Run の 4 worker 全員が
#   `completion-accepted` を未読のまま停止し、端末へ直接入力して初めて動き出した）。
#   **ベストエフォート。**起こせなかったことで配送を無かったことにしてはならないので、
#   ここの失敗は batch の結末に影響させない。
wake_role() {   # $1=status dir $2=role
  local rd="$1/roles/$2"
  # 間隔の記録は **mtime ではなく中身**。`stat` の flag は GNU と BSD で違う。
  mkdir -p "$rd" 2>/dev/null && printf '%s\n' "$(date +%s)" > "$rd/.woken" 2>/dev/null
  node "$WAKE" --workers "$1/workers.json" --role "$2" >/dev/null 2>&1 \
    || log "could not wake $2; the reply is delivered but it may be sitting unread"
}

# ★ **返事の直後の 1 回では足りない。**その 1 回が空振りしたら、24 時間だれも気づかない。
#   **叩いてよいのは「返事を待っていることが確定している役」だけ** — `merge_ready_sent`
#   のまま settle していない役である。働いている worker の端末に文字列を撃ち込まない。
rewake_stalled() {
  local i rd ph last now settled
  now=$(date +%s)
  for i in "${!TASKS[@]}"; do
    settled=$(role_outcome "${T_SD[$i]}" "${T_ROLE[$i]}") || settled=""
    [[ -z "$settled" ]] || continue
    rd="${T_SD[$i]}/roles/${T_ROLE[$i]}"
    ph=$(jq -r '.phase // empty' "$rd/completion.json" 2>/dev/null || echo "")
    [[ "$ph" == merge_ready_sent ]] || continue
    last=$(cat "$rd/.woken" 2>/dev/null || echo 0); [[ "$last" =~ ^[0-9]+$ ]] || last=0
    [[ $((now - last)) -ge "$WAKE_INTERVAL" ]] || continue
    wake_role "${T_SD[$i]}" "${T_ROLE[$i]}"
  done
}

drain() {   # 0 = batch を処理し切った / 1 = 処理できないものがあった（ack しない）/ 2 = transport または receipt が不明
  local out res n i m payload d t tid did oc idx tsd trole rcode rreason existing upd RET RETRC ACK CHECKRC
  local mrn vreason vok esub msub qid qbody qseen qnew
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
    # ★ **heartbeat は liveness signal であって、記録すべき状態を持たない。**Orca が
    #   worker preamble で 5 分ごとに送らせるので、未知として batch を止めると
    #   起動した全 dispatch が永久に詰まる（実測）。読み飛ばして ack を通す。
    #   捨てても失われる内容は無い — outcome も nonce も質問も運ばない。
    [[ "$t" != heartbeat ]] || continue
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
    # ★ **`question` は詰まりではなく「人へ取り次げ」である。**worker は `ask` で
    #   ブロックしており、**親は `orchestration reply` で答えられる**。未知として扱って
    #   batch を止めると、答えれば進む dispatch が永久に止まる（実測で踏んだ）。
    #
    #   ★ **初回は ack しない**（答えるまで処理済みではない）が、**2 度目は処理済みとして
    #   通す。**通さないと、人が答えたあとも同じ質問が queue の先頭に居座り、その worker の
    #   `merge_ready` が永久に後ろで待つ（実測: 答えたのに count が 2 のまま減らなかった）。
    if [[ "$t" == question ]]; then
      idx=$(idx_of "$tid" "$did") || idx=""
      if [[ -z "$idx" ]]; then
        UNK_TYPE=question UNK_T="$tid" UNK_D="$did" UNK_BATCH="$d"; return 7
      fi
      qid=$(jq -r '.id // empty' <<<"$m")
      qbody=$(jq -r '.body // empty' <<<"$m")
      qseen="${T_SD[$idx]}/questions.json"
      # ★ **一度出した質問で二度止まらない。**取り次いだ時点でこの message の用は済んで
      #   いる（worker が動き出すのは `reply` であって ack ではない）。記録しないと、
      #   答えたあとも同じ質問で永久に止まり続ける（実測で踏んだ）。
      if [[ -f "$qseen" ]] && jq -e --arg i "$qid" 'index($i) != null' "$qseen" >/dev/null 2>&1; then
        log "${T_ROLE[$idx]}'s question was already relayed; treating it as handled"
        # 取り次ぎ済みとして通すのは、人が答えたあとの呼び直しである。そこで時計を戻す
        mark_human "${T_SD[$idx]}"
        continue
      fi
      qnew=$(jq -nc --arg i "$qid" --slurpfile prev <(cat "$qseen" 2>/dev/null || echo '[]') \
               '($prev[0] // []) + [$i] | unique') || qnew=""
      [[ -z "$qnew" ]] || write "${T_SD[$idx]}" "$qseen" "$qnew" \
        || log "could not record that this question was relayed; it may be surfaced again"
      log "${T_ROLE[$idx]} is asking a question and is blocked until someone answers:"
      log "  $qbody"
      log "relay it to the user, then answer with:"
      log "  $ORCA_BIN orchestration reply --id ${qid:-<message id>} --body '<their answer>' --from $PH"
      log "then run this wait again"
      mark_human "${T_SD[$idx]}"
      return 6
    fi
    # ★ **相 3〜4。**`merge_ready` は worker が「検証してくれ」と言っている状態である。
    #   検証して受理か差し戻しを **同じ Dispatch** へ返し、この message は処理済みにする。
    if [[ "$t" == merge_ready ]]; then
      idx=$(idx_of "$tid" "$did") || idx=""
      if [[ -z "$idx" ]]; then
        UNK_TYPE=merge_ready UNK_T="$tid" UNK_D="$did" UNK_BATCH="$d"; return 7
      fi
      # ★ **止めた役には返事をしない。**端末は閉じており、受理を送っても読む者は居ない
      if is_stopped "${T_SD[$idx]}" "${T_ROLE[$idx]}"; then
        log "ignoring merge_ready from ${T_ROLE[$idx]} (dispatch $did): the user stopped it"
        continue
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
        [[ "$(review_state "${T_SD[$idx]}" "${T_ROLE[$idx]}")" != unreviewed ]] \
          || log "WARNING: ${T_ROLE[$idx]} produced no review verdict; its work is accepted UNREVIEWED"
        wake_role "${T_SD[$idx]}" "${T_ROLE[$idx]}"
      else
        reply_completion "$did" "$mrn" remediation "$vreason" || {
          log "could not send the remediation to dispatch '$did'; the batch is not acknowledged"; return 2; }
        log "sent ${T_ROLE[$idx]} back for remediation (dispatch $did): $vreason"
        wake_role "${T_SD[$idx]}" "${T_ROLE[$idx]}"
      fi
      continue
    fi
    # ★ **処理できない message は捨てない。**捨てて ack すると cursor だけ進んで内容が消える
    idx=""
    if [[ "$t" == worker_done ]]; then
      idx=$(idx_of "$tid" "$did") \
        || { UNK_TYPE=worker_done UNK_T="$tid" UNK_D="$did" UNK_BATCH="$d"; return 7; }
    fi
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
    # ★ 止めた役は端末を閉じてある。保持する資源が無いので retain をかけない
    #   （かけると失敗して batch が ack されず、同じ batch を永久に読み直す）
    is_stopped "$tsd" "$trole" && continue
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
# ★ **知らない dispatch は「この版が扱えない」とは限らない。「まだ読んでいない」ことがある。**
#   2 段目 (`orca-start.sh --phase exec`) は、この待機が走っている最中に `workers.json` へ
#   dispatch を足す。ack していない以上 batch はキューの先頭に残っているので、期待集合を
#   読み直してもう一度 drain すれば、そのまま処理できる。
#   **読み直しても集合が変わらなければ、それは本当に未知である** — そこで初めて止まる。
drain_batch() {   # drain と同じ終了鍵。7 は外へ出さない
  local rc before
  drain; rc=$?
  [[ "$rc" -eq 7 ]] || return "$rc"
  before=$(roles_key)
  load_roles
  if [[ "$(roles_key)" != "$before" ]]; then
    log "a dispatch was added after this wait started; reloaded the role set from workers.json"
    drain; rc=$?
    [[ "$rc" -eq 7 ]] || return "$rc"
  fi
  log "batch $UNK_BATCH carries a $UNK_TYPE for a dispatch this wait does not know (task='$UNK_T' dispatch='$UNK_D')"
  log "it is NOT acknowledged, so nothing is lost. A stage started later is only visible here"
  log "once its dispatch is recorded in workers.json. Inspect with:"
  log "  $ORCA_BIN orchestration check --terminal $PH --peek --json"
  return 1
}
aggregate() {   # 全 dispatch が終端なら集約 outcome を stdout。1 件でも未終端なら 1
  # ★ **終端の条件は「起動した全 dispatch の receipt が揃うこと」。**reviewer の
  #   worker_done を待たずに戻ると、その message はあとから来て次の batch を詰まらせる。
  local i sd st oc existing worst=succeeded
  for i in "${!TASKS[@]}"; do
    existing=$(role_outcome "${T_SD[$i]}" "${T_ROLE[$i]}") || return 1
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
    # ★ 作る役をユーザーが止めたら（計画役を含む）、そのタスクは失敗である。status は書きかけの
    #   まま残り、止めた計画役のあとに exec は起こされないので、status を待つと永久に終わらない。
    #   計画役が失敗した場合も同じく exec は起こされない（task_given_up）
    if task_given_up "$sd"; then
      worst=failed; continue
    fi
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
  local i oc rv
  for i in "${!TASKS[@]}"; do
    oc=$(role_outcome "${T_SD[$i]}" "${T_ROLE[$i]}") || oc=""
    # ★ **無レビューのときだけ足す。**常に出すと、読む側が探す語が 1 つ増えるだけになる
    rv=""; [[ "$(review_state "${T_SD[$i]}" "${T_ROLE[$i]}")" != unreviewed ]] || rv=" review=unreviewed"
    echo "task=${TASKS[$i]} role=${T_ROLE[$i]} dispatch=${DISPS[$i]} status_dir=${T_SD[$i]} outcome=${oc:-unknown}$rv"
  done
  echo "outcome=$1"
  [[ "$1" == succeeded ]] && exit 0 || exit 5
}
# ★ **報告済みで記録前の worker を停止と読み違えない**（実測 2026-09-19、2 回）。worker は
#   `worker_done` を送った直後に Orca 側で終端状態になるが、こちらがそれを drain して
#   receipt にするのは次の周回である。その隙間で 4 を返すと、**まだ働いている兄弟タスクごと
#   待機が落ちる。**そこで、自分で報告して終わる状態（succeeded / failed）に限り、receipt が
#   来るまで数周だけ待つ。**待つのは数周だけ** — 送れずに終わった worker は猶予を使い切った
#   ところで今までどおり 4 になり、recovery の入口を塞がない。
SETTLE_GRACE="${ORCA_WAIT_SETTLE_GRACE:-3}"
declare -A SETTLE_SEEN=()
healthy() {   # **人の入力待ちは healthy である**（CLI help）。1 つでも不健全なら非 0
  local i show st wait SHOWRC settled seen
  for i in "${!DISPS[@]}"; do
    # ★ **settle した dispatch を health check にかけない**（実測: 決着済みの dispatch の
    #   worker-show は state 'succeeded' を返す。許容集合の外である）。かけると、先に
    #   終わった 1 件が、まだ働いている兄弟ごと wait を 4 で落とす。
    #   receipt があるなら、その dispatch はもう待つ対象ではない
    settled=$(role_outcome "${T_SD[$i]}" "${T_ROLE[$i]}") || settled=""
    [[ -z "$settled" ]] || continue
    SHOWRC=0
    show=$("$ORCA_BIN" orchestration worker-show --dispatch "${DISPS[$i]}" --json 2>/dev/null) || SHOWRC=$?
    [[ "$SHOWRC" -eq 0 ]] || { log "worker-show failed (rc=$SHOWRC)"; return 2; }
    jq -e '.ok == true and (.result | type == "object")' <<<"$show" >/dev/null 2>&1 || {
      log "worker-show receipt was not ok"
      return 2
    }
    wait=$(jq -r '.result.observation.agentWait // empty' <<<"$show")
    if [[ -n "$wait" && "$wait" != null ]]; then mark_human "${T_SD[$i]}"; continue; fi
    st=$(jq -r '.result.worker.state // empty' <<<"$show")
    case "$st" in
      active|ready|starting|idle) SETTLE_SEEN["${DISPS[$i]}"]=0 ;;
      succeeded|failed)
        seen=$(( ${SETTLE_SEEN["${DISPS[$i]}"]:-0} + 1 ))
        SETTLE_SEEN["${DISPS[$i]}"]=$seen
        if [[ "$seen" -le "$SETTLE_GRACE" ]]; then
          log "dispatch '${DISPS[$i]}' reports '$st' but its worker_done has not arrived yet ($seen/$SETTLE_GRACE)"
        else
          log "the worker for dispatch '${DISPS[$i]}' is '$st'"; return 1
        fi ;;
      *) log "the worker for dispatch '${DISPS[$i]}' is '$st'"; return 1 ;;
    esac
  done
  return 0
}

beat
drain_batch || { drc=$?; case "$drc" in 2) exit 4 ;; 6) exit 6 ;; *) exit 1 ;; esac; }
oc=$(aggregate) && finish "$oc"
n=0; wex=0
while :; do
  beat
  WRC=0; WAIT=$("$ORCA_BIN" orchestration check --terminal "$PH" --wait --timeout-ms "$TMO" --json 2>/dev/null) || WRC=$?
  if [[ "$WRC" -ne 0 ]] || ! jq -e '.ok == true' <<<"$WAIT" >/dev/null 2>&1; then
    # ★ **`waiter_exists` は「壊れた」ではなく「まだ空いていない」。**段を足すために待機を
    #   止めて再起動すると、サーバ側の waiter がしばらく残って再起動が弾かれる（実測
    #   2026-09-10: ここで親が降り、worker たちは誰も受理しない返事を待ち続けた）。
    #   タイムアウトで解放されるので、待って試し直す。**他の失敗では粘らない。**
    if [[ "$(jq -r '.error.code // empty' <<<"$WAIT" 2>/dev/null || echo "")" == waiter_exists ]] \
       && [[ "$wex" -lt "$WAITER_TRIES" ]]; then
      wex=$((wex + 1))
      log "another waiter still holds this terminal; retrying in ${WAITER_RETRY}s ($wex/$WAITER_TRIES)"
      [[ "$WAITER_RETRY" -le 0 ]] || sleep "$WAITER_RETRY"
      continue
    fi
    [[ "$WRC" -eq 0 ]] && log "check --wait receipt was not ok" || log "check --wait failed (rc=$WRC)"
    exit 4
  fi
  wex=0
  drain_batch || { drc=$?; case "$drc" in 2) exit 4 ;; 6) exit 6 ;; *) exit 1 ;; esac; }
  oc=$(aggregate) && finish "$oc"
  healthy || exit 4
  rewake_stalled
  check_stall || {
    log "a task has made no progress for $(( STALL_SECONDS / 60 )) minutes or more and nobody is waiting on a person;"
    log "ask the user whether to keep waiting or stop a role (orca-stop.ts), then run this wait again"
    exit 8
  }
  n=$((n + 1))
  [[ "$n" -lt "$MAXW" ]] || { log "reached --max-waits ($MAXW); inspect and decide"; exit 3; }
done
