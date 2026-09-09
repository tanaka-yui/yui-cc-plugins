#!/usr/bin/env bash
# orca-start.sh — worktree を用意し、worker を 1 つ起動してタスクを届ける。
# **recovery 機構は無い** (spec 18-1)。worker-start が成立した後は何も削除しない。
# Usage: orca-start.sh --request-file <f> --slug <s> --objective <o> [--repo-root <p>]
#          [--run <run_id>] [--agent <id>] [--model <id>] [--effort <level>]
# Exit: 0 / 1 = 起動できなかった / 2 = 使用法エラー
set -uo pipefail
die() { echo "orca-start: $1" >&2; exit 2; }
log() { echo "orca-start: $1" >&2; }
ORCA_BIN="${ORCA_BIN:-${ORCA_CLI_COMMAND:-/Applications/Orca.app/Contents/Resources/bin/orca}}"
# ★ WSL2 では Orca 本体が Windows 側に居るので、**CLI 境界で path 形式が変わる**（実測）。
#   送り: `path:` selector が Linux path のままだと repo_not_found になる
#   受け: receipt の path は UNC で返り、bash の -d も git -C も解釈できない
#   HOST_KIND だけを根拠にしない — wslpath の無い環境で変換すると path が空文字になる
ORCA_WSL=0
if [[ "${ORCA_ORCHESTRATION_COMPATIBILITY_HOST_KIND:-}" == wsl ]] \
   && command -v wslpath >/dev/null 2>&1; then ORCA_WSL=1; fi
to_host()  { [[ "$ORCA_WSL" -eq 1 ]] || { printf '%s\n' "$1"; return 0; }; wslpath -w "$1"; }
# 既に local 形式のものは通す。Orca が将来 Linux path を返しても壊さない
to_local() { case "$1" in /*) printf '%s\n' "$1"; return 0 ;; esac
             [[ "$ORCA_WSL" -eq 1 ]] || { printf '%s\n' "$1"; return 0; }; wslpath -u "$1"; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; PLUGIN="$(cd "$HERE/.." && pwd)"
need2() { [[ "$2" -ge 2 ]] || die "$1 requires a value"; }
RF="" SLUG="" OBJ="" RR="" RUN_IN=""
# 役ごとの agent / model / effort は config.json が正本。ここは 1 回きりの上書き口である
OV_AGENT="" OV_MODEL="" OV_EFFORT=""
while [[ $# -gt 0 ]]; do case "$1" in
  --request-file) need2 "$1" $#; RF="$2";     shift 2 ;;
  --slug)         need2 "$1" $#; SLUG="$2";   shift 2 ;;
  --objective)    need2 "$1" $#; OBJ="$2";    shift 2 ;;
  --repo-root)    need2 "$1" $#; RR="$2";     shift 2 ;;
  --run)          need2 "$1" $#; RUN_IN="$2"; shift 2 ;;
  --agent)        need2 "$1" $#; OV_AGENT="$2";  shift 2 ;;
  --model)        need2 "$1" $#; OV_MODEL="$2";  shift 2 ;;
  --effort)       need2 "$1" $#; OV_EFFORT="$2"; shift 2 ;;
  *) die "unknown option: $1" ;; esac; done
[[ -n "$RF" && -n "$SLUG" && -n "$OBJ" ]] || die "--request-file, --slug and --objective are required"
[[ -r "$RF" ]] || die "--request-file is not readable: $RF"
[[ -s "$RF" ]] || die "--request-file must not be empty: $RF"
# ★ slug は path になるので **fail closed に検証する**。../ で .dispatch の外へ出さない
[[ "$SLUG" =~ ^[a-z0-9][a-z0-9-]{0,29}$ ]] || die "invalid slug: $SLUG (use ^[a-z0-9][a-z0-9-]{0,29}$)"
[[ -n "$RR" ]] || RR=$(git rev-parse --show-toplevel 2>/dev/null) || die "not in a git repo"
# ★ repo は **常に親 checkout そのもの**を exact な path selector で指す。
#   `--repo` は受け付けない (round 2 finding 4): 別 repo を指されると worker はそこで動く
#   のに merge 先は $RR のままになり、誤 merge か不可解な失敗になる
RR_HOST=$(to_host "$RR") && [[ -n "$RR_HOST" ]] \
  || { log "cannot express $RR in the form the Orca CLI expects"; exit 1; }
REPO="path:$RR_HOST"
SD="$RR/.dispatch/$SLUG"
[[ ! -e "$SD" ]] || { log "$SD already exists; pick a different slug"; exit 1; }
# critical write。**失敗を握り潰さない。**
# ★ failpoint は **呼び出し地点の ID** で撃つ (round 3 finding 6)。
#   同じ workers.json でも「Task 前」と「Task 後」は別の境界であり、
#   basename で比較すると狙った側を一度も発火させられない。
#   site は run / status / workers-initial / workers-after-task / workers-after-dispatch
write() {   # $1=site $2=path $3=content
  [[ "${ORCA_FAIL_WRITE_AT:-}" == "$1" ]] && { log "injected write failure at $1"; return 1; }
  mkdir -p "$(dirname "$2")" || return 1; printf '%s\n' "$3" > "$2"
}
# ★ **jq の出力を検査せずに write へ渡さない。**入力が空なら jq は空を返して 0 で終わるので、
#   握り潰すと workers.json を空で上書きし、branch と integration_branch が復元不能に消える
jq_write() {   # $1=site $2=path $3.. = jq の引数
  local site="$1" path="$2" content; shift 2
  content=$(jq "$@") && [[ -n "$content" ]] || return 1
  write "$site" "$path" "$content"
}

# --- preflight: 何も作る前に確かめる ---
# ★ ORCA_BIN は path のことも PATH 上の command 名のこともある（WSL2 の `orca-ide`）。
#   command 名に -x を当てると必ず落ちる
case "$ORCA_BIN" in
  */*) [[ -x "$ORCA_BIN" ]] || { log "the Orca CLI is not at $ORCA_BIN"; exit 1; } ;;
  *) command -v "$ORCA_BIN" >/dev/null 2>&1 \
       || { log "the Orca CLI '$ORCA_BIN' is not on PATH"; exit 1; } ;;
esac
"$ORCA_BIN" status --json 2>/dev/null | jq -e '.result.runtime.reachable == true' >/dev/null 2>&1 \
  || { log "the Orca runtime is not reachable"; exit 1; }
# 親の identity は環境変数から取る。候補が 1 つでも推測しない (O26)
PH="${ORCA_TERMINAL_HANDLE:-}"
[[ -n "$PH" ]] || { log "ORCA_TERMINAL_HANDLE is not set; run this from an Orca terminal"; exit 1; }
"$ORCA_BIN" terminal show --terminal "$PH" --json 2>/dev/null \
  | jq -e '.result.terminal.handle != null' >/dev/null 2>&1 \
  || { log "cannot verify the parent terminal $PH"; exit 1; }
# merge 先の identity を今のうちに固定する。待機中に checkout が変わっても取り違えない
IB=$(git -C "$RR" symbolic-ref --short HEAD 2>/dev/null) || IB=""
[[ -n "$IB" ]] || { log "the parent checkout is in a detached HEAD; cannot fix a merge target"; exit 1; }

# ★ **設定は資源を作る前に解決する。**壊れた config で worktree と Task を作ってから
#   落ちると、片付けの要る残骸だけが残る。config-resolve は読めない設定で exit 1 を返す。
#   設定が 1 つも無いのは正常で、そのとき agent は claude、model と effort は付かない。
CFG_SET=()
[[ -n "$OV_AGENT"  ]] && CFG_SET+=(--set "design.agent=$OV_AGENT")
[[ -n "$OV_MODEL"  ]] && CFG_SET+=(--set "design.model=$OV_MODEL")
[[ -n "$OV_EFFORT" ]] && CFG_SET+=(--set "design.effort=$OV_EFFORT")
RESOLVER="$PLUGIN/skills/orca-team-dispatch-task/scripts/config-resolve.sh"
[[ -r "$RESOLVER" ]] || { log "the config resolver is missing at $RESOLVER"; exit 1; }
CRC=0; CFG=$(bash "$RESOLVER" --project-root "$RR" ${CFG_SET[@]+"${CFG_SET[@]}"}) || CRC=$?
[[ "$CRC" -eq 0 ]] && jq -e '.roles.design.agent | type == "string"' <<<"$CFG" >/dev/null 2>&1 \
  || { log "cannot resolve the dispatch configuration (rc=$CRC); nothing was created"; exit 1; }
AGENT=$(jq -r '.roles.design.agent' <<<"$CFG")
MODEL=$(jq -r '.roles.design.model  // empty' <<<"$CFG")
EFFORT=$(jq -r '.roles.design.effort // empty' <<<"$CFG")

mkdir -p "$SD/roles/design" || { log "cannot create $SD"; exit 1; }
cat "$RF" > "$SD/request.md" || { log "cannot materialize the request"; exit 1; }
# ★ `.dispatch/` を repo の除外へ入れる（実測: 入れないと親が常に `?? .dispatch/` で
#   dirty になり、merge の dirty ガードが必ず発火する）。
#   linked worktree では --git-path が絶対パスを返すので、相対のときだけ足す
EX=$(git -C "$RR" rev-parse --git-path info/exclude 2>/dev/null || echo "")
case "$EX" in /*) ;; ?*) EX="$RR/$EX" ;; esac
if [[ -n "$EX" ]]; then
  mkdir -p "$(dirname "$EX")"
  grep -qxF '.dispatch/' "$EX" 2>/dev/null || printf '.dispatch/\n' >> "$EX"
fi

# --- Run ---
if [[ -n "$RUN_IN" ]]; then
  RUN="$RUN_IN"
else
  RCJ=0; RJ=$("$ORCA_BIN" orchestration run-create --objective "$OBJ" --from "$PH" --json 2>/dev/null) || RCJ=$?
  RUN=$(jq -r '.result.run.id // empty' <<<"$RJ" 2>/dev/null || echo "")
  [[ "$RCJ" -eq 0 && -n "$RUN" ]] || { log "run-create failed (rc=$RCJ)"; exit 1; }
fi
# 束縛先が自分であることを確かめる。候補が 1 つのとき Orca は暗黙に選ぶ (O26)
CJ2=$("$ORCA_BIN" orchestration run-current --from "$PH" --json 2>/dev/null)
CO=$(jq -r '.result.run.coordinator_handle // empty' <<<"$CJ2")
CI=$(jq -r '.result.run.id // empty' <<<"$CJ2")
[[ "$CO" == "$PH" ]] || { log "the Run bound to '${CO:-unknown}', not to $PH"; exit 1; }
[[ "$CI" == "$RUN" ]] || { log "this terminal is bound to Run '${CI:-unknown}', not to $RUN"; exit 1; }
write run "$SD/run.json" "$(jq -nc --arg r "$RUN" --arg p "$PH" --arg rr "$RR" \
  '{run_id:$r, parent_handle:$p, repo_root:$rr}')" || {
  log "the Run was created but could not be recorded. Nothing else exists yet."
  log "run=$RUN  inspect with: $ORCA_BIN orchestration run-show --id $RUN --json"; exit 1; }

# --- worktree: 作るか再利用する。**必ず repo で絞る** ---
CREATED=""
# ★ **inspection の失敗を「不在」と解釈しない** (round 2 finding 3)。
#   接続失敗・権限エラー・不正 selector を「作ってよい」と読むと資源が二重になる
LRC=0; WLJ=$("$ORCA_BIN" worktree list --repo "$REPO" --json 2>/dev/null) || LRC=$?
[[ "$LRC" -eq 0 ]] && jq -e '.result.worktrees | type == "array"' <<<"$WLJ" >/dev/null 2>&1 \
  || { log "cannot list worktrees for $REPO (rc=$LRC); refusing to guess whether one exists"; exit 1; }
N=$(jq -r --arg n "$SLUG" '[.result.worktrees[] | select(.name == $n)] | length' <<<"$WLJ")
case "$N" in
  0) WJ="" ;;
  1) WJ=$(jq -c --arg n "$SLUG" '[.result.worktrees[] | select(.name == $n)][0]' <<<"$WLJ")
     log "reusing the existing worktree for $SLUG" ;;
  *) log "$N worktrees are named '$SLUG' in $REPO; refusing to guess which one"; exit 1 ;;
esac
if [[ -z "$WJ" ]]; then
  # ★ --setup skip。repo の setup hook は Stage 1 の対象外だと宣言している以上、走らせない。
  #   **rc と stdout を分けて持つ** — 非 0 と receipt らしき JSON が同時に返ることがある
  CRC=0; CJ=$("$ORCA_BIN" worktree create --repo "$REPO" --name "$SLUG" --no-parent \
                --setup skip --json 2>/dev/null) || CRC=$?
  WJ=$(jq -c '.result.worktree // empty' <<<"$CJ" 2>/dev/null || echo "")
  [[ "$CRC" -eq 0 && -n "$WJ" ]] || { log "worktree create failed (rc=$CRC)"; exit 1; }
  CREATED=$(jq -r '.id // empty' <<<"$WJ")
fi
WT_ID=$(jq -r '.id // empty' <<<"$WJ"); WT_PATH=$(jq -r '.path // empty' <<<"$WJ")
# 戻さないと workers.json に bash が使えない path が残り、[C3] の `git -C "$WP"` が壊れる
if [[ -n "$WT_PATH" ]]; then WT_PATH=$(to_local "$WT_PATH") || WT_PATH=""; fi
BR=$(jq -r '.branch // empty' <<<"$WJ"); BR="${BR#refs/heads/}"
[[ -n "$WT_ID" && -n "$WT_PATH" && -d "$WT_PATH" ]] || { log "the worktree has no usable id/path"; exit 1; }
# branch は receipt から取る。名前を推測しない（merge が使う）
[[ -n "$BR" ]] || { log "the worktree receipt has no branch; refusing to guess"; exit 1; }
# ★ **再利用するなら clean であること** (round 2 finding 4)。dirty な checkout を worker へ
#   渡すと、前回の未完了変更が成果 commit に混ざる。status 自体が失敗するのも判断不能である
if [[ -z "$CREATED" ]]; then
  PORC=$(git -C "$WT_PATH" status --porcelain 2>/dev/null); SRC=$?
  [[ "$SRC" -eq 0 ]] || { log "cannot read the status of the existing worktree $WT_PATH"; exit 1; }
  [[ -z "$PORC" ]] || { log "the existing worktree $WT_PATH is dirty; commit or clean it first"; exit 1; }
fi
# Task 前の cleanup は、この call が作成した resource だけを対象にし、結果を隠さない。
H=""
kept() { log "$1"; log "run=$RUN worktree=$WT_ID path=$WT_PATH branch=$BR terminal=${H:-none}"; }
cleanup_before_task() {
  local wr=0
  if [[ -z "$CREATED" ]]; then log "the worktree was reused, so it is kept"
  else
    "$ORCA_BIN" worktree rm --worktree "id:$CREATED" --force --json >/dev/null 2>&1 || wr=$?
    [[ "$wr" -eq 0 ]] && log "the worktree this call created was removed" \
      || log "worktree rm FAILED (rc=$wr); it is KEPT"
  fi
}

# ★ **資源を作った後の write 失敗は、identity を出してから止める**（round 2 finding 5）。
#   Task はまだ無いので、この呼び出しが作った worktree は戻してよい
postwrite() {   # $1=site $2=path $3=content
  write "$1" "$2" "$3" && return 0
  kept "cannot write $2"
  cleanup_before_task
  exit 1
}
postwrite status "$SD/roles/design/status.json" '{"status":"starting"}'
# ★ **この worktree を誰が作ったか**を記録する (round 3 finding 1)。端末はまだ存在しないので
#   端末集合の inventory は worker-start の後（端末が生まれてから）に回す
OWNED=false; [[ -n "$CREATED" ]] && OWNED=true
# ★ **解決した tuple を記録する。**あとから「この worker は何で走ったのか」を
#   receipt 無しで答えられるようにする。未設定の model / effort はキー自体を置かない
#   （config-resolve の出力と同じ形にし、「未設定」と「空文字」を混ぜない）。
postwrite workers-initial "$SD/workers.json" "$(jq -nc --arg r "$RUN" --arg w "$WT_ID" --arg p "$WT_PATH" \
  --arg b "$BR" --arg ib "$IB" --argjson own "$OWNED" \
  --argjson design "$(jq -c '.roles.design + {retained:false}' <<<"$CFG")" \
  '{run_id:$r,worktree_id:$w,worktree_path:$p,branch:$b,integration_branch:$ib,
    worktree_created_by_this_run:$own, worktree_terminals:null,
    roles:{design:$design}}')"

RD="$SD/roles/design"
SPEC="TASK: $SLUG

$(cat "$SD/request.md")

STATUS PROTOCOL

Your injected preamble gives you the task id, the dispatch id, the dispatch capability
and the --from handle. Use that set. The Orca CLI is at \$ORCA_BIN, already exported.

1. Write $(printf '%q' "$RD/status.json") with status executing.
2. Do the work in this worktree and commit it on this branch.
3. Write $(printf '%q' "$RD/result.md") describing what changed.
4. Run: bash $(printf '%q' "$PLUGIN/skills/orca-team-dispatch-task/scripts/report-status.sh") $(printf '%q' "$RD") done <one line>
   (use error instead of done when the work itself failed)
5. Send worker_done with the SAME conclusion as the status you just wrote:

     \"\$ORCA_BIN\" orchestration send --type worker_done \\
       --task-id <task id> --dispatch-id <dispatch id> \\
       --dispatch-capability <capability> --from <handle> \\
       --outcome succeeded --subject \"<short status>\" --body \"<what you did>\" --json

   Use --outcome failed when you wrote error.
6. **Do not send any other message type.** Do not send ask, question or escalation:
   this version's parent has no path to answer them, so they would only be discarded.
   If you are blocked, write status error, say why in result.md, and send worker_done
   with --outcome failed. The user will look at result.md and dispatch again.
7. If the send fails, inspect with
     \"\$ORCA_BIN\" orchestration dispatch-show --task <task id> --json
   before resending. If the dispatch is already terminal, do not resend.
8. End your turn and stay idle."

TCJ=0; TJ=$("$ORCA_BIN" orchestration task-create --spec "$SPEC" --task-title "$SLUG/design" \
              --from "$PH" --json 2>/dev/null) || TCJ=$?
TID=$(jq -r '.result.task.id // empty' <<<"$TJ" 2>/dev/null || echo "")
if [[ "$TCJ" -ne 0 ]]; then
  if [[ -n "$TID" ]]; then
    kept "task-create failed (rc=$TCJ) but returned task id $TID; a Task may exist. Resources are KEPT."
    log "task=$TID  inspect with: $ORCA_BIN orchestration task-list --run $RUN --json"
    exit 1
  fi
  kept "task-create failed (rc=$TCJ); no Task was created"
  cleanup_before_task
  exit 1
fi
if [[ -z "$TID" ]]; then
  kept "task-create returned success but no task id; a Task may exist. Resources are KEPT."
  log "inspect with: $ORCA_BIN orchestration task-list --run $RUN --json"
  exit 1
fi
# Task が実在するので、ここから先は削除しない。identity を出して止める
jq_write workers-after-task "$SD/workers.json" -c --arg t "$TID" '.roles.design.task = $t' "$SD/workers.json" || {
  kept "the task was created but could not be recorded. Resources are KEPT."
  log "task=$TID  inspect with: $ORCA_BIN orchestration task-list --run $RUN --json"; exit 1; }

# ★ ここから先は何が起きても資源を削除しない (O19)。
#   **rc 0 + state=ready + dispatch id の 3 つ揃い**を要求する。
#   failed / outcome_unknown の receipt にも dispatchId が残ることがある
# ★ `--effort requires --model` (Orca)。config-resolve が model 無しの effort を既に
#   落としているが、ここでも組にして渡す — 片方だけが残ると worker-start が使用法で落ちる
WS_ARGS=(--agent "$AGENT")
if [[ -n "$MODEL" ]]; then
  WS_ARGS+=(--model "$MODEL")
  [[ -n "$EFFORT" ]] && WS_ARGS+=(--effort "$EFFORT")
fi
log "design runs agent=$AGENT model=${MODEL:-<orca default>} effort=${EFFORT:-<orca default>}"
WRC=0; WJ2=$("$ORCA_BIN" orchestration worker-start --task "$TID" --worktree "id:$WT_ID" \
               "${WS_ARGS[@]}" --from "$PH" --json 2>/dev/null) || WRC=$?
WSTATE=$(jq -r '.result.state // empty' <<<"$WJ2" 2>/dev/null || echo "")
DID=$(jq -r '.result.dispatchId // empty' <<<"$WJ2" 2>/dev/null || echo "")
H=$(jq -r 'first(.result.effects[]? | select(.kind == "terminal" and .role == "agent") | .id) // empty' \
     <<<"$WJ2" 2>/dev/null || echo "")
# ★ **生きている dispatch id を捨てない。**記録せずに止めると、その worker はそれでも走って
#   共有 Delivery へ worker_done を送る。**兄弟タスクの wait はその message を処理できず、
#   batch を永久に ack できなくなる** — 完了した隣のタスクの成果まで取り出せなくなる。
#   記録さえ残っていれば、その status dir を wait 集合に入れて drain できる
record_orphan_dispatch() {
  [[ -n "$DID" ]] || return 0
  jq_write workers-orphan-dispatch "$SD/workers.json" -c --arg d "$DID" \
    '.roles.design.dispatch = $d' "$SD/workers.json" \
    || log "the dispatch id could not be recorded either; wait on dispatch=$DID by hand"
}
if [[ "$WRC" -ne 0 || "$WSTATE" != ready || -z "$DID" ]]; then
  record_orphan_dispatch
  log "worker-start did not report ready (rc=$WRC state='${WSTATE:-none}'). Resources are KEPT."
  log "inspect with: $ORCA_BIN orchestration task-list --run $RUN --json"
  exit 1
fi
if [[ -z "$H" ]]; then
  record_orphan_dispatch
  log "worker-start reported ready but returned no agent terminal handle. Resources are KEPT."
  log "task=$TID dispatch=$DID  inspect with: $ORCA_BIN orchestration worker-show --dispatch $DID --json"
  exit 1
fi
# ★ **inventory の失敗を空配列に化けさせない** (round 4 finding 1)。
#   列挙できなかったことと「端末が 0 個」は別である。前者を [] にすると、
#   あとの cleanup gate が「未 account 0」と読んで削除を許してしまう (fail-open)。
#   確定できなければ null を記録し、gate 側はそれを「判断不能」として閉じる
TLRC=0; TL=$("$ORCA_BIN" terminal list --worktree "id:$WT_ID" --json 2>/dev/null) || TLRC=$?
if [[ "$TLRC" -eq 0 ]] && jq -e '.result.terminals | type == "array"' <<<"$TL" >/dev/null 2>&1; then
  TERMS=$(jq -c '[.result.terminals[].handle]' <<<"$TL")
else
  TERMS=null
  log "could not inventory the terminals in this worktree (rc=$TLRC); cleanup will refuse to remove it"
fi
jq_write workers-after-dispatch "$SD/workers.json" -c --arg d "$DID" --arg h "$H" --argjson ts "$TERMS" \
  '.roles.design.dispatch = $d | .roles.design.terminal = $h | .worktree_terminals = $ts' \
  "$SD/workers.json" || {
  kept "the worker started but the dispatch id could not be recorded. Resources are KEPT."
  log "task=$TID dispatch=$DID"
  log "inspect with: $ORCA_BIN orchestration worker-show --dispatch $DID --json"; exit 1; }
printf 'status_dir=%s\nrun_id=%s\n' "$SD" "$RUN"
