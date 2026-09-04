#!/usr/bin/env bash
# orca-start.sh — worktree を用意し、worker を 1 つ起動してタスクを届ける。
# **recovery 機構は無い** (spec 18-1)。worker-start が成立した後は何も削除しない。
# Usage: orca-start.sh --request-file <f> --slug <s> --objective <o> [--repo-root <p>]
# Exit: 0 / 1 = 起動できなかった / 2 = 使用法エラー
set -uo pipefail
die() { echo "orca-start: $1" >&2; exit 2; }
log() { echo "orca-start: $1" >&2; }
ORCA_BIN="${ORCA_BIN:-/Applications/Orca.app/Contents/Resources/bin/orca}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; PLUGIN="$(cd "$HERE/.." && pwd)"
need2() { [[ "$2" -ge 2 ]] || die "$1 requires a value"; }
RF="" SLUG="" OBJ="" RR=""
while [[ $# -gt 0 ]]; do case "$1" in
  --request-file) need2 "$1" $#; RF="$2";   shift 2 ;;
  --slug)         need2 "$1" $#; SLUG="$2"; shift 2 ;;
  --objective)    need2 "$1" $#; OBJ="$2";  shift 2 ;;
  --repo-root)    need2 "$1" $#; RR="$2";   shift 2 ;;
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
REPO="path:$RR"
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

# --- preflight: 何も作る前に確かめる ---
[[ -x "$ORCA_BIN" ]] || { log "the Orca CLI is not at $ORCA_BIN"; exit 1; }
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
RCJ=0; RJ=$("$ORCA_BIN" orchestration run-create --objective "$OBJ" --from "$PH" --json 2>/dev/null) || RCJ=$?
RUN=$(jq -r '.result.run.id // empty' <<<"$RJ" 2>/dev/null || echo "")
[[ "$RCJ" -eq 0 && -n "$RUN" ]] || { log "run-create failed (rc=$RCJ)"; exit 1; }
# 束縛先が自分であることを確かめる。候補が 1 つのとき Orca は暗黙に選ぶ (O26)
CO=$("$ORCA_BIN" orchestration run-current --from "$PH" --json 2>/dev/null \
     | jq -r '.result.run.coordinator_handle // empty')
[[ "$CO" == "$PH" ]] || { log "the Run bound to '${CO:-unknown}', not to $PH"; exit 1; }
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
  local cr=0 wr=0
  if [[ -n "$H" ]]; then
    "$ORCA_BIN" terminal close --terminal "$H" --json >/dev/null 2>&1 || cr=$?
    [[ "$cr" -eq 0 ]] && log "the terminal was closed" || log "terminal close FAILED (rc=$cr); it is KEPT"
  else
    log "no terminal handle was returned, so no terminal close was attempted"
  fi
  if [[ -z "$CREATED" ]]; then log "the worktree was reused, so it is kept"
  else
    "$ORCA_BIN" worktree rm --worktree "id:$CREATED" --force --json >/dev/null 2>&1 || wr=$?
    [[ "$wr" -eq 0 ]] && log "the worktree this call created was removed" \
      || log "worktree rm FAILED (rc=$wr); it is KEPT"
  fi
}

# ★ runner は **worker checkout の外**（status dir）に置く。中に置くと checkout が dirty になり、
#   worker の成果 commit に混ざるか、後の worktree rm で消える
RUNNER="$SD/run-design.sh"
{ printf '%s\n' '#!/usr/bin/env bash'
  printf 'export ORCA_BIN=%q\n' "$ORCA_BIN"
  # 権限プロンプトで止まらないようにする。Stage 1 の runner は claude 固定
  printf 'exec claude --dangerously-skip-permissions\n'
} > "$RUNNER" && chmod +x "$RUNNER" || { kept "cannot write the runner"; cleanup_before_task; exit 1; }

# ★ **command string の中で runner path を shell quote する** (round 3 finding 4)。
#   `$RR/.dispatch/...` に空白があると別 argv に割れる
printf -v RUN_CMD 'bash %q' "$RUNNER"
# **rc と stdout を分けて持つ**（round 2 finding 3）
TCR=0; TCJ2=$("$ORCA_BIN" terminal create --worktree "id:$WT_ID" --title "$SLUG-design" \
                --command "$RUN_CMD" --json 2>/dev/null) || TCR=$?
H=$(jq -r '.result.terminal.handle // empty' <<<"$TCJ2" 2>/dev/null || echo "")
[[ "$TCR" -eq 0 && -n "$H" ]] || { kept "terminal create failed (rc=$TCR)"; cleanup_before_task; exit 1; }
"$ORCA_BIN" terminal wait --terminal "$H" --for tui-idle --timeout-ms 120000 --json >/dev/null 2>&1 \
  || log "tui-idle wait timed out (continuing)"

# ★ **資源を作った後の write 失敗は、identity を出してから止める**（round 2 finding 5）。
#   Task はまだ無いので、この呼び出しが作った端末と worktree は戻してよい
postwrite() {   # $1=site $2=path $3=content
  write "$1" "$2" "$3" && return 0
  kept "cannot write $2"
  cleanup_before_task
  exit 1
}
postwrite status "$SD/roles/design/status.json" '{"status":"starting"}'
# ★ **この worktree を誰が作ったか**と、**この worktree に居る端末の集合**を記録する
#   (round 3 finding 1)。bare な worktree create は最初の fallback terminal も作るので、
#   design terminal だけを account すると「残留物ゼロ」を証明できない
OWNED=false; [[ -n "$CREATED" ]] && OWNED=true
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
postwrite workers-initial "$SD/workers.json" "$(jq -nc --arg r "$RUN" --arg w "$WT_ID" --arg p "$WT_PATH" \
  --arg b "$BR" --arg h "$H" --arg ib "$IB" --argjson own "$OWNED" --argjson ts "$TERMS" \
  '{run_id:$r,worktree_id:$w,worktree_path:$p,branch:$b,integration_branch:$ib,
    worktree_created_by_this_run:$own, worktree_terminals:$ts, design:{terminal:$h}}')"

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
write workers-after-task "$SD/workers.json" "$(jq -c --arg t "$TID" '.design.task = $t' "$SD/workers.json")" || {
  kept "the task was created but could not be recorded. Resources are KEPT."
  log "task=$TID  inspect with: $ORCA_BIN orchestration task-list --run $RUN --json"; exit 1; }

# ★ ここから先は何が起きても資源を削除しない (O19)。
#   **rc 0 + state=ready + dispatch id の 3 つ揃い**を要求する。
#   failed / outcome_unknown の receipt にも dispatchId が残ることがある
WRC=0; WJ2=$("$ORCA_BIN" orchestration worker-start --task "$TID" --terminal "$H" \
               --worktree "id:$WT_ID" --from "$PH" --json 2>/dev/null) || WRC=$?
WSTATE=$(jq -r '.result.state // empty' <<<"$WJ2" 2>/dev/null || echo "")
DID=$(jq -r '.result.dispatchId // empty' <<<"$WJ2" 2>/dev/null || echo "")
if [[ "$WRC" -ne 0 || "$WSTATE" != ready || -z "$DID" ]]; then
  log "worker-start did not report ready (rc=$WRC state='${WSTATE:-none}'). Resources are KEPT."
  log "inspect with: $ORCA_BIN orchestration task-list --run $RUN --json"
  exit 1
fi
write workers-after-dispatch "$SD/workers.json" "$(jq -c --arg d "$DID" '.design.dispatch = $d' "$SD/workers.json")" || {
  kept "the worker started but the dispatch id could not be recorded. Resources are KEPT."
  log "task=$TID dispatch=$DID"
  log "inspect with: $ORCA_BIN orchestration worker-show --dispatch $DID --json"; exit 1; }
printf 'status_dir=%s\nrun_id=%s\n' "$SD" "$RUN"
