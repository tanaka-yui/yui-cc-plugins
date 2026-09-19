#!/usr/bin/env bash
# orca-start.sh — worktree を用意し、worker を 1 つ起動してタスクを届ける。
# **recovery 機構は無い** (spec 18-1)。worker-start が成立した後は何も削除しない。
# Usage: orca-start.sh --request-file <f> --slug <s> --objective <o> [--repo-root <p>]
#          [--run <run_id>] [--agent <id>] [--model <id>] [--effort <level>]
#          [--phase design|exec] [--design-mode direct|plan|brainstorm]
#        orca-start.sh --slug <s> --resume [--repo-root <p>] [--design-mode ...]
#
# ★ `--resume` は **design 段の起動が途中で落ちた status dir を続ける。**記録済みの依頼と
#   Run を使い、dispatch の無い役だけを起こす（exec 段は元から続きなので付けない）。
#
# ★ **exec は design が終わってからでないと起こせない。**計画が無いうちに実装させられない
#   ので、起動は 2 段に分かれる。`--phase design`（既定）が 1 段目、`--phase exec` が
#   2 段目である。**待ちはこのコマンドに持たせない** — 呼び出し側が `orca-wait.sh` で
#   待ってから 2 段目を呼ぶ（`orca-issue.sh` の phase 分割と同じ理由）。
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
OV_AGENT="" OV_MODEL="" OV_EFFORT="" OV_DESIGN_MODE="" PHASE=design RESUME=0
while [[ $# -gt 0 ]]; do case "$1" in
  --resume)       RESUME=1; shift ;;
  --request-file) need2 "$1" $#; RF="$2";     shift 2 ;;
  --slug)         need2 "$1" $#; SLUG="$2";   shift 2 ;;
  --objective)    need2 "$1" $#; OBJ="$2";    shift 2 ;;
  --repo-root)    need2 "$1" $#; RR="$2";     shift 2 ;;
  --run)          need2 "$1" $#; RUN_IN="$2"; shift 2 ;;
  --agent)        need2 "$1" $#; OV_AGENT="$2";  shift 2 ;;
  --design-mode)  need2 "$1" $#; OV_DESIGN_MODE="$2"; shift 2 ;;
  --model)        need2 "$1" $#; OV_MODEL="$2";  shift 2 ;;
  --effort)       need2 "$1" $#; OV_EFFORT="$2"; shift 2 ;;
  --phase)        need2 "$1" $#; PHASE="$2";     shift 2 ;;
  *) die "unknown option: $1" ;; esac; done
case "$PHASE" in design|exec) ;; *) die "--phase must be design or exec: $PHASE" ;; esac
if [[ "$RESUME" -eq 1 ]]; then
  [[ "$PHASE" == design ]] || die "--resume continues the design phase; the exec phase always continues"
  # 依頼と Run は記録済みのものを使う。別のものを渡されても黙って捨てない
  [[ -z "$RF" && -z "$RUN_IN" ]] || die "--resume uses the recorded request and Run; do not pass --request-file or --run"
fi
# ★ **続きの起動**（exec 段と --resume）は既存の status dir の記録を引き継ぐ
CONT=0; [[ "$PHASE" == exec || "$RESUME" -eq 1 ]] && CONT=1
# 続きの起動は記録を引き継ぐので依頼ファイルを要らない
if [[ "$CONT" -eq 1 ]]; then
  [[ -n "$SLUG" ]] || die "--slug is required"
else
  [[ -n "$RF" && -n "$SLUG" && -n "$OBJ" ]] || die "--request-file, --slug and --objective are required"
fi
if [[ "$CONT" -eq 0 ]]; then
  [[ -r "$RF" ]] || die "--request-file is not readable: $RF"
  [[ -s "$RF" ]] || die "--request-file must not be empty: $RF"
fi
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
# exec 段は既存の status dir の続きである。1 段目と同じ「既にある＝やり直し」判定を当てない
if [[ "$PHASE" == exec ]]; then
  [[ -d "$SD" ]] || { log "$SD does not exist; run the design phase first"; exit 1; }
elif [[ "$RESUME" -eq 1 ]]; then
  [[ -d "$SD" ]] || { log "$SD does not exist; there is nothing to resume"; exit 1; }
else
  [[ ! -e "$SD" ]] || { log "$SD already exists; pick a different slug"; exit 1; }
fi
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
[[ -n "$OV_DESIGN_MODE" ]] && CFG_SET+=(--design-mode "$OV_DESIGN_MODE")
RESOLVER="$PLUGIN/skills/orca-team-dispatch-task/scripts/config-resolve.sh"
[[ -r "$RESOLVER" ]] || { log "the config resolver is missing at $RESOLVER"; exit 1; }
CRC=0; CFG=$(bash "$RESOLVER" --project-root "$RR" ${CFG_SET[@]+"${CFG_SET[@]}"}) || CRC=$?
[[ "$CRC" -eq 0 ]] && jq -e '.roles.design.agent | type == "string"' <<<"$CFG" >/dev/null 2>&1 \
  || { log "cannot resolve the dispatch configuration (rc=$CRC); nothing was created"; exit 1; }
REVIEW_MODE=$(jq -r '.review_mode // "off"' <<<"$CFG")
# ★ **起動順は reviewer が先** (spec 5-1 T4a)。design は起動直後にレビューを依頼しうるので、
#   その時点で reviewer の dispatch が workers.json に無いと、依頼が宛先不明で落ちる。
PHASE_B=$(jq -r '.phase_b // "off"' <<<"$CFG")
SETUP=$(jq -r '.setup // "skip"' <<<"$CFG")
DESIGN_MODE=$(jq -r '.design_mode // "direct"' <<<"$CFG")
LAUNCH_ORDER=()
# $1=role → その役の dispatch が workers.json に記録済みなら 0
started() { jq -e --arg r "$1" '.roles[$r].dispatch // empty | length > 0' "$SD/workers.json" >/dev/null 2>&1; }
if [[ "$PHASE" == exec ]]; then
  # ★ **2 段目。**design が成功していることと、その計画が実在することを確かめてから起こす。
  [[ "$PHASE_B" == on ]] || { log "phase_b is off; there is no exec role to start"; exit 1; }
  DST=$(jq -r '.status // empty' "$SD/roles/design/status.json" 2>/dev/null || echo "")
  [[ "$DST" == done ]] \
    || { log "the design role is '${DST:-missing}', not done; refusing to start exec"; exit 1; }
  # ★ **空の計画で実装させない。**plan.md が無い／空なら、exec は何を作るか知らないまま走る
  [[ -s "$SD/plan.md" ]] \
    || { log "$SD/plan.md is missing or empty; refusing to start exec on no plan"; exit 1; }
  jq -e '.roles.exec.dispatch // empty | length > 0' "$SD/workers.json" >/dev/null 2>&1 \
    && { log "the exec role has already started for $SLUG"; exit 1; }
  # ★ **reviewer が先**（T4a と同じ理由）。exec は起動直後にレビューを依頼しうるので、
  #   その時点で exec_review の dispatch が workers.json に無いと宛先不明で落ちる。
  #   **やり直しでは起きている reviewer を起こし直さない**（実測 2026-09-19: exec_review が
  #   起きたあと exec の worktree create だけが落ちた）。起こし直すと先の reviewer が
  #   workers.json から外れ、誰にも使われないまま retained で残る。
  if [[ "$REVIEW_MODE" == on ]]; then
    if started exec_review; then
      log "exec_review has already started for $SLUG; starting exec only"
    else
      LAUNCH_ORDER+=(exec_review)
    fi
  fi
  LAUNCH_ORDER+=(exec)
else
  if [[ "$RESUME" -eq 1 ]]; then
    # ★ **続ける元が揃っていなければ何も起こさない。**依頼か記録が無いまま起こすと、
    #   何を頼まれたか分からない worker ができる
    [[ -s "$SD/request.md" && -s "$SD/workers.json" ]] \
      || { log "$SD has no recorded request or dispatch state; there is nothing to resume"; exit 1; }
    started design && { log "the design role has already started for $SLUG"; exit 1; }
  fi
  # exec 段と同じ理由で、再開では起きている reviewer を起こし直さない
  if [[ "$REVIEW_MODE" == on ]]; then
    if [[ "$RESUME" -eq 1 ]] && started design_review; then
      log "design_review has already started for $SLUG; starting design only"
    else
      LAUNCH_ORDER+=(design_review)
    fi
  fi
  LAUNCH_ORDER+=(design)
fi

# review dir は **タスク単位で共有する** (spec 7)。ロール別 status dir の外に置く —
# 依頼側と reviewer の両方が読み書きするためである。両者は別の worktree に居るが、
# ここは親 repo 側の絶対パスなのでどちらからも届く。
RVD="$SD/review"
for role in "${LAUNCH_ORDER[@]}"; do
  mkdir -p "$SD/roles/$role" || { log "cannot create $SD/roles/$role"; exit 1; }
done
mkdir -p "$RVD" || { log "cannot create $RVD"; exit 1; }
# ★ 続きの起動（exec 段と --resume）は記録の続きである。依頼も Run も上書きしない
if [[ "$CONT" -eq 0 ]]; then
  cat "$RF" > "$SD/request.md" || { log "cannot materialize the request"; exit 1; }
fi
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
if [[ "$CONT" -eq 1 ]]; then
  # 1 段目が記録した Run と親端末をそのまま使う。取り違えると Delivery が別になる
  RUN=$(jq -r '.run_id // empty' "$SD/run.json" 2>/dev/null)
  [[ -n "$RUN" ]] || { log "no run_id recorded in $SD/run.json"; exit 1; }
  RPH=$(jq -r '.parent_handle // empty' "$SD/run.json" 2>/dev/null)
  [[ "$RPH" == "$PH" ]] \
    || { log "this terminal is $PH but the dispatch was started from ${RPH:-unknown}"; exit 1; }
elif [[ -n "$RUN_IN" ]]; then
  RUN="$RUN_IN"
else
  RCJ=0; RJ=$("$ORCA_BIN" orchestration run-create --objective "$OBJ" --from "$PH" --json 2>/dev/null) || RCJ=$?
  RUN=$(jq -r '.result.run.id // empty' <<<"$RJ" 2>/dev/null || echo "")
  [[ "$RCJ" -eq 0 && -n "$RUN" ]] || { log "run-create failed (rc=$RCJ)"; exit 1; }
fi
if [[ "$CONT" -eq 0 ]]; then
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

# ★ **解決した tuple を全ロール分まとめて先に置く。**あとから「この worker は何で
#   走ったのか」を receipt 無しで答えられるようにする。未設定の model / effort は
#   キー自体を置かない（config-resolve の出力と同じ形にし、未設定と空文字を混ぜない）。
# ★ **取り込み先の役を 1 箇所で決める。**merge も PR も同じ値を読む。別々に判断すると
#   必ずずれる。今は design だけだが、実装役が増えたらここが変わる。
write workers-initial "$SD/workers.json" "$(jq -nc --arg r "$RUN" --arg ib "$IB" \
  --arg ir "$(jq -r '.integration_role // "design"' <<<"$CFG")" \
  --argjson roles "$(jq -c '.roles | map_values(. + {retained:false})' <<<"$CFG")" \
  '{run_id:$r, integration_branch:$ib, integration_role:$ir, roles:$roles}')" || {
  log "the Run was created but the dispatch state could not be recorded. Nothing else exists yet."
  log "run=$RUN  inspect with: $ORCA_BIN orchestration run-show --id $RUN --json"; exit 1; }
else
  # ★ 続きの起動は tuple だけを足す。**既存の役の記録を上書きしない**
  for r in "${LAUNCH_ORDER[@]}"; do
    jq_write "workers-tuple-$r" "$SD/workers.json" -c --arg r "$r" \
      --argjson t "$(jq -c --arg r "$r" '.roles[$r] + {retained:false}' <<<"$CFG")" \
      '.roles[$r] = ((.roles[$r] // {}) + $t)' "$SD/workers.json" \
      || { log "cannot record the $r tuple"; exit 1; }
  done
fi

SCRIPTS="$PLUGIN/skills/orca-team-dispatch-task/scripts"
SENDER="$PLUGIN/bin/orca-send.sh"
WFILE="$SD/workers.json"

# ── ここから下はロール単位。**先に起動したロールの資源は、後のロールが失敗しても消さない** ──

# $1=role  → 標準出力に spec 本文
render_spec() {
  local role="$1" rd="$SD/roles/$role" q_bin q_rd q_rs q_send q_wf q_rvd
  q_bin=$(printf '%q' "$ORCA_BIN"); q_rd=$(printf '%q' "$rd")
  q_rs=$(printf '%q' "$SCRIPTS/report-status.sh"); q_send=$(printf '%q' "$SENDER")
  q_wf=$(printf '%q' "$WFILE"); q_rvd=$(printf '%q' "$RVD")

  # 全ロール共通の終わり方。**ここだけは 1 箇所で組み立てる** — 役ごとに書き分けると
  # STATUS PROTOCOL がドリフトする。
  local q_cmp; q_cmp=$(printf '%q' "$SCRIPTS/completion.sh")
  local closing="STATUS PROTOCOL

Your injected preamble gives you the task id, the dispatch id, the dispatch capability
and the --from handle. Use that set. The Orca CLI is $q_bin.

**Finishing is two-phase: you offer the work, the parent checks it, then you report.** Do
not report done before the parent has accepted. Do not skip a step because the work looks
obviously fine — the point is that the parent, not you, decides that.

A. Write $q_rd/status.json with status executing when you start.
B. Do the work, then write $q_rd/result.md describing what you did.

C. Offer it. This records the attempt and prints its nonce:

     bash $q_cmp --role-dir $q_rd prepare

D. Tell the parent it is ready. **The subject carries the nonce and nothing else** — Orca
   builds the payload from the id flags, so a nonce put there would be dropped.
   **Read the nonce back from the record inside the same command**, as written here: each
   command you run is a fresh shell, so a variable you set in C is gone by now, and a
   merge_ready without a nonce jams the parent's whole batch.

     $q_bin orchestration send --type merge_ready \\
       --task-id <task id> --dispatch-id <dispatch id> \\
       --dispatch-capability <capability> --from <handle> \\
       --subject \"merge_ready: \$(bash $q_cmp --role-dir $q_rd nonce)\" \\
       --body \"<what you did>\" --json

   Then run: bash $q_cmp --role-dir $q_rd sent
   The parent replies on this same dispatch.

E. Wait for that reply. **Do not end your turn to wait.** A message put in your mailbox
   does not wake you: a turn closed here is a dispatch that stops for good, and someone has
   to come and restart you by hand.

     bash $q_cmp --role-dir $q_rd await

   It blocks for up to 10 minutes, reads your mailbox with --peek (never --ack), matches
   your own nonce, and prints one line:
   - \`accepted\` -> go to F.
   - \`remediation <reason>\` -> the reason says what is missing. Fix it and go back to C.
     The nonce does not change.
   - \`waiting\` -> nobody has answered yet. **Run it again, in this same turn.** Keep
     running it. It is normal for this to take several rounds.
   - \`expired\` -> 24 hours passed with no answer. Write that in result.md, run
     \`bash $q_rs $q_rd error the parent never answered\`, and stop. Do not report done.
   A non-zero exit means the mailbox could not be read at all; try once more, then treat it
   like \`expired\`.

F. Report. \`await\` already checked the nonce and recorded the acceptance, so there is
   nothing to confirm here:

     bash $q_rs $q_rd done <one line>

G. Send worker_done, then record that it landed:

     $q_bin orchestration send --type worker_done \\
       --task-id <task id> --dispatch-id <dispatch id> \\
       --dispatch-capability <capability> --from <handle> \\
       --outcome succeeded --subject \"<short status>\" --body \"<what you did>\" --json
     bash $q_cmp --role-dir $q_rd settle

   **Before resending anything, inspect:**
     $q_bin orchestration dispatch-show --task <task id> --json
   If the dispatch is already terminal, **do not resend** — run settle and stop.

H. **If the work itself failed, none of C-G applies.** Write why in result.md, run
   \`bash $q_rs $q_rd error <reason>\`, and send worker_done with --outcome failed. That
   status is the record that a failure is still owed; there is nothing to offer.

I. **Do not invent message types.** The only things you send are the ones above, plus
   \`orchestration ask\` **when this task told you to ask** (see the brainstorming section, if
   there is one). Do not send escalations: the parent has no path for them.

   When you do use \`ask\`, expect it to block until a person answers through the parent, and
   remember it costs someone's attention. Ask once, with everything you need in it.
J. End your turn and stay idle."

  if [[ "$role" == design_review || "$role" == exec_review ]]; then
    # ★ 依頼元とラベルは役で決まる。design は計画を、exec は実装をレビューさせる
    local rq_role=design rq_label='review-plan:' rq_what=plan rq_noun='plan'
    if [[ "$role" == exec_review ]]; then
      rq_role=exec; rq_label='review-code:'; rq_what=code; rq_noun='implementation'
    fi
    cat <<SPEC_R
REVIEWER FOR TASK: $SLUG

You review. **You do not implement anything and you change no file** except the findings
files described below. The work itself belongs to another worker.

The request that worker was given is in $(printf '%q' "$SD/request.md"). Read it for context.

REVIEW LOOP

1. Wait for a request:

     $q_bin orchestration check --terminal "\$ORCA_TERMINAL_HANDLE" \\
       --peek --wait --timeout-ms 600000 --json

   Use --peek. **Never pass --ack** — the cursor is not yours to advance.
   A review request has a subject starting \`$rq_label\` and names a round number.
   A subject starting \`abort-reviewer:\` means the work finished without you; go to step 5.

   **Do not end your turn to wait.** A message put in your mailbox does not wake you, so a
   turn closed here leaves the worker you review waiting on a verdict that never comes.
   **An error naming an existing waiter is not a failure.** Orca refuses a wait while
   another one is active on this Run; the message says so (\`waiter_exists\`, or an
   already-active actionable waiter). That means the mailbox is busy, not that the work is
   gone. Wait a few seconds and run the same command again. It does not count as an empty
   wait.
   If the wait returns nothing, run it again, in this same turn. Give up and go to step 5
   only once it has come back empty six times in a row (one hour).

2. The body names a file under $q_rvd. Read it and review the $rq_noun against the request.

3. Write your findings to $q_rvd/$rq_what-round-<n>-findings.md, where <n> is the round
   from the subject. **The prefix matters**: two reviewers share this directory, and a
   shared filename would overwrite the other one's findings. **End the file with exactly one line of this form and nothing after it:**

       VERDICT: approved

   or

       VERDICT: needs_work

   Use needs_work when something must change before this is worth building. Say what and
   why, concretely, above the verdict line. Do not edit the request file.

4. Send the verdict back:

     bash $q_send --workers $q_wf --to $rq_role \\
       --subject 'review-verdict: round <n>' --body '<absolute path to your findings file>'

   A non-zero exit means it was NOT delivered. Try once more; if it fails again, leave the
   findings file in place and go to step 5.
   Then go back to step 1 for the next round.

5. Finish. Say in result.md which rounds you answered and what each verdict was.

$closing
SPEC_R
    return 0
  fi

  # ★ 依頼側のレビュー手順は design と exec で **ラベルとファイル名だけ**が違う。
  #   本文を 2 つ書くと必ず片方だけ直されてドリフトするので、1 箇所で組み立てる。
  render_review_block() {   # $1=reviewer 役 $2=ラベル $3=ファイル prefix $4=何をレビューさせるか
    printf '%s' "REVIEW PROTOCOL (do this before you finish)

A reviewer is already running and waiting for you. Have your $4 reviewed before you finish.

1. Write your $4 to $q_rvd/$3-round-<n>-request.md, starting at n=1. Be concrete enough
   that someone can disagree with it.

2. Send the request:

     bash $q_send --workers $q_wf --to $1 \\\\
       --subject '$2 round <n>' --body '<absolute path to your request file>'

   **A non-zero exit means it was NOT delivered.** Delete the request file you just wrote,
   note in result.md that review was unavailable, and carry on without it.

3. Wait for the verdict:

     $q_bin orchestration check --terminal \"\\$ORCA_TERMINAL_HANDLE\" \\\\
       --peek --wait --timeout-ms 600000 --json

   Use --peek. **Never pass --ack.** Look for a subject starting \`review-verdict:\`.

   **Do not end your turn to wait.** A message put in your mailbox does not wake you, so a
   turn closed here is a dispatch that stops for good. If the wait returns nothing, run it
   again, in this same turn — reviewing takes longer than one wait.

   **An error naming an existing waiter is not "review is unavailable".** Orca refuses a
   wait while another one is active on this Run (\`waiter_exists\`, or an already-active
   actionable waiter). Wait a few seconds and run the same command again. **Do not record
   the review as skipped because of it** — only the empty waits in step 6 justify that.

4. The body names a findings file. Read it. **Only a line reading exactly
   \`VERDICT: approved\` means approved.** Anything else, including a missing VERDICT line,
   is needs_work.

5. On needs_work: revise and repeat from step 1 with the next round number.
   **Stop after round 2.** Record the unresolved findings in result.md and keep the best
   version you have. Do not keep asking.

6. Once the wait has come back empty six times in a row (one hour), send the same round
   once more. If another hour brings nothing, note in result.md that review was skipped
   and proceed.

7. When you are done, release the reviewer:

     bash $q_send --workers $q_wf --to $1 \\\\
       --subject 'abort-reviewer: done' --body 'the work is finished'

"
  }

  if [[ "$role" == exec ]]; then
    local exec_review_block=""
    [[ "$REVIEW_MODE" == on ]] \
      && exec_review_block=$(render_review_block exec_review 'review-code:' code 'implementation')
    cat <<SPEC_X
TASK: $SLUG (implementation)

Another worker has already planned this. **The plan is the specification.** It is at
$(printf '%q' "$SD/plan.md"). Read it first; the original request is at
$(printf '%q' "$SD/request.md") for context.

${exec_review_block}1. Build what the plan describes, in this worktree, and commit it on this branch.
2. **Follow the plan.** If a step turns out to be wrong or impossible, do the rest, and say
   in result.md exactly which step you departed from and why. Do not silently redesign it.
3. Do not edit $(printf '%q' "$SD/plan.md"). It is the record of what was agreed.

$closing
SPEC_X
    return 0
  fi

  # design
  local review_block=""
  [[ "$REVIEW_MODE" == on ]] \
    && review_block=$(render_review_block design_review 'review-plan:' plan 'plan')
  # ★ **取りかかり方の指示は design にだけ載せる。**exec は計画に従う役であり、
  #   reviewer は何も作らない。
  local approach=""
  case "$DESIGN_MODE" in
    plan)
      approach="**Decide the approach before you touch anything.** Write down what you are
going to do and why, in result.md, before the first edit. If what you find while working
makes that approach wrong, say so there rather than quietly doing something else.

" ;;
    brainstorm)
      approach="**Start with the superpowers brainstorming skill.** Invoke
\`superpowers:brainstorming\` and settle the open questions before you plan or build anything.

**Ask through \`orchestration ask\`, not by printing a question and stopping.** The parent
relays it to a person and sends their answer back; a question you only print is read by
nobody. It blocks until someone answers, so **ask once and put everything you need in it**
rather than going back and forth.

If nobody ever answers, that call is where you will be waiting — that is expected, and the
person watching decides whether to answer or to stop the dispatch.

If the skill is not installed in this session, say so in result.md and carry on without it
rather than inventing your own version of it.

" ;;
  esac
  local design_task="${approach}Do the work in this worktree and commit it on this branch."
  if [[ "$PHASE_B" == on ]]; then
    # ★ **design は実装しない。**実装役が別に居るのに両方が書くと、同じ変更が 2 つの
    #   ブランチに載って取り込みが壊れる。
    design_task="${approach}PLAN ONLY. **Do not implement anything and commit nothing.**

Another worker will build this from your plan, in a different worktree. Write the plan to
$(printf '%q' "$SD/plan.md") and leave every other file alone.

Make it specific enough to be built from without asking you: name the files to change, what
each change is for, and how someone would tell it worked. If the request cannot be built as
asked, say so in the plan rather than inventing a different task."
  fi

  cat <<SPEC_D
TASK: $SLUG

$(cat "$SD/request.md")

${review_block}$design_task

$closing
SPEC_D
}

# ★ **接続が切れた create は、Orca 側では作り終えていることがある**（実測 2026-09-19:
#   runtime_unavailable が 3 回続き、どれも同名の worktree が後から現れた）。待つ長さは
#   env で変えられる（テストが 2 分待たずに済むように）。
SETTLE_SECS="${ORCA_CREATE_SETTLE_SECS:-120}"; SETTLE_INTERVAL="${ORCA_CREATE_SETTLE_INTERVAL:-5}"
# $1=worktree 名 → 現れたら標準出力にその entry。**1 つに決まらなければ採らない**
await_created() {
  local name="$1" waited=0 L n
  while [[ "$waited" -lt "$SETTLE_SECS" ]]; do
    sleep "$SETTLE_INTERVAL"; waited=$((waited + SETTLE_INTERVAL))
    L=$("$ORCA_BIN" worktree list --repo "$REPO" --json 2>/dev/null) || continue
    n=$(jq -r --arg n "$name" '[.result.worktrees[]? | select(.displayName == $n)] | length' <<<"$L" 2>/dev/null) \
      || continue
    case "$n" in
      0) ;;
      1) jq -c --arg n "$name" '[.result.worktrees[] | select(.displayName == $n)][0]' <<<"$L"; return 0 ;;
      *) return 1 ;;
    esac
  done
  return 1
}

# $1=role  → その役の worktree を用意し、Task と worker を起こす
launch_role() {
  local role="$1" wt_name title
  local WT_ID WT_PATH BR CREATED="" WJ WLJ N CRC CJ H="" TID DID
  # ★ **役ごとに違う名前にする。**`design` 以外を一律 `-review` にしていたので、
  #   `exec` が `<slug>-review` を名乗り、**review_mode と phase_b を同時に on にすると
  #   design_review と衝突した**（実機で発見: exec のブランチが `pb-live-review` になった）。
  wt_name="$SLUG"; [[ "$role" == design ]] || wt_name="$SLUG-${role//_/-}"
  title="$SLUG/$role"

  local rd="$SD/roles/$role"
  local agent model effort
  agent=$(jq -r --arg r "$role" '.roles[$r].agent'          <<<"$CFG")
  model=$(jq -r --arg r "$role" '.roles[$r].model  // empty' <<<"$CFG")
  effort=$(jq -r --arg r "$role" '.roles[$r].effort // empty' <<<"$CFG")
  [[ -n "$agent" ]] || { log "role '$role' has no agent resolved"; return 1; }

  # ★ **inspection の失敗を「不在」と解釈しない** (round 2 finding 3)。
  #   接続失敗・権限エラー・不正 selector を「作ってよい」と読むと資源が二重になる
  local LRC=0; WLJ=$("$ORCA_BIN" worktree list --repo "$REPO" --json 2>/dev/null) || LRC=$?
  [[ "$LRC" -eq 0 ]] && jq -e '.result.worktrees | type == "array"' <<<"$WLJ" >/dev/null 2>&1 \
    || { log "cannot list worktrees for $REPO (rc=$LRC); refusing to guess whether one exists"; return 1; }
  # ★ **receipt の名前は `.displayName` である。`.name` は存在しない**（実測 O40）。
  N=$(jq -r --arg n "$wt_name" '[.result.worktrees[] | select(.displayName == $n)] | length' <<<"$WLJ")
  case "$N" in
    0) WJ="" ;;
    1) WJ=$(jq -c --arg n "$wt_name" '[.result.worktrees[] | select(.displayName == $n)][0]' <<<"$WLJ")
       log "reusing the existing worktree for $wt_name" ;;
    *) log "$N worktrees are named '$wt_name' in $REPO; refusing to guess which one"; return 1 ;;
  esac
  if [[ -z "$WJ" ]]; then
    # ★ setup hook を走らせるかは設定で決まる（既定 skip）。
    #   **rc と stdout を分けて持つ** — 非 0 と receipt らしき JSON が同時に返ることがある
    CRC=0; CJ=$("$ORCA_BIN" worktree create --repo "$REPO" --name "$wt_name" --no-parent \
                  --setup "$SETUP" --json 2>/dev/null) || CRC=$?
    WJ=$(jq -c '.result.worktree // empty' <<<"$CJ" 2>/dev/null || echo "")
    local ADOPTED=0
    if [[ "$CRC" -ne 0 || -z "$WJ" ]]; then
      # ★ **なぜ作れなかったかまで言う**（実測 2026-09-19: rc だけでは原因が残らなかった）
      local CERR CCODE
      CERR=$(jq -r '[.error.code // empty, .error.message // empty]
                    | map(select(. != "")) | join(": ")' <<<"$CJ" 2>/dev/null || echo "")
      CCODE=$(jq -r '.error.code // empty' <<<"$CJ" 2>/dev/null || echo "")
      # ★ 接続切れだけは待つ。作る前に同名が無いことを確かめてあるので、後から現れた
      #   ものはこの呼び出しが作ったものである。**それ以外の失敗は Orca が作れなかったと
      #   答えているので待たない**
      if [[ "$CCODE" == runtime_unavailable ]]; then
        WJ=$(await_created "$wt_name") || WJ=""
        [[ -n "$WJ" ]] || {
          log "worktree create failed for $role (rc=$CRC)${CERR:+; $CERR}; the worktree $wt_name did not appear within ${SETTLE_SECS}s"
          return 1; }
        log "worktree create for $role reported $CCODE, but Orca created $wt_name afterwards; adopting it"
        ADOPTED=1
      else
        log "worktree create failed for $role (rc=$CRC)${CERR:+; $CERR}"; return 1
      fi
    fi
    CREATED=$(jq -r '.id // empty' <<<"$WJ")
    # ★ **setup が失敗した worktree で作業させない。**依存の無いまま実装すると、
    #   なぜ失敗したか分からない成果ができる。receipt が setup の失敗を報告したら、
    #   この呼び出しが作った worktree を戻して止まる。
    #   **拾った worktree には receipt が無く、setup の成否を証明できない。**消す根拠も
    #   無いので残して止まる
    if [[ "$SETUP" == run && "$ADOPTED" -eq 1 ]]; then
      log "cannot verify that the repository setup hook succeeded for $role (no receipt); refusing to start a worker on it. The worktree is KEPT"
      log "worktree=$CREATED  inspect with: $ORCA_BIN worktree list --repo $REPO --json"
      return 1
    fi
    if [[ "$SETUP" == run ]]; then
      local SST
      SST=$(jq -r '.result.setup.state // .result.setup.status
                   // (first(.result.effects[]? | select(.kind == "setup") | .state)) // empty' \
              <<<"$CJ" 2>/dev/null || echo "")
      case "$SST" in
        ''|succeeded|success|completed|not_applicable|skipped) ;;
        *)
          log "the repository setup hook did not succeed for $role (state '$SST'); refusing to start a worker on it"
          "$ORCA_BIN" worktree rm --worktree "id:$CREATED" --force --json >/dev/null 2>&1 \
            && log "the worktree this call created for $role was removed" \
            || log "worktree rm FAILED for $role; it is KEPT"
          return 1 ;;
      esac
    fi
  fi
  WT_ID=$(jq -r '.id // empty' <<<"$WJ"); WT_PATH=$(jq -r '.path // empty' <<<"$WJ")
  # 戻さないと workers.json に bash が使えない path が残り、[C3] の `git -C "$WP"` が壊れる
  if [[ -n "$WT_PATH" ]]; then WT_PATH=$(to_local "$WT_PATH") || WT_PATH=""; fi
  BR=$(jq -r '.branch // empty' <<<"$WJ"); BR="${BR#refs/heads/}"
  [[ -n "$WT_ID" && -n "$WT_PATH" && -d "$WT_PATH" ]] || { log "the $role worktree has no usable id/path"; return 1; }
  # branch は receipt から取る。名前を推測しない（merge が使う）
  [[ -n "$BR" ]] || { log "the $role worktree receipt has no branch; refusing to guess"; return 1; }
  # ★ **再利用するなら clean であること** (round 2 finding 4)。dirty な checkout を worker へ
  #   渡すと、前回の未完了変更が成果 commit に混ざる。status 自体が失敗するのも判断不能である
  if [[ -z "$CREATED" ]]; then
    local PORC SRC
    PORC=$(git -C "$WT_PATH" status --porcelain 2>/dev/null); SRC=$?
    [[ "$SRC" -eq 0 ]] || { log "cannot read the status of the existing worktree $WT_PATH"; return 1; }
    [[ -z "$PORC" ]] || { log "the existing worktree $WT_PATH is dirty; commit or clean it first"; return 1; }
  fi

  kept() { log "$1"; log "run=$RUN role=$role worktree=$WT_ID path=$WT_PATH branch=$BR terminal=${H:-none}"; }
  # **この呼び出しがこの役のために作った worktree だけ**を戻す。先に起動した役のものは触らない。
  cleanup_before_task() {
    local wr=0
    if [[ -z "$CREATED" ]]; then log "the $role worktree was reused, so it is kept"
    else
      "$ORCA_BIN" worktree rm --worktree "id:$CREATED" --force --json >/dev/null 2>&1 || wr=$?
      [[ "$wr" -eq 0 ]] && log "the worktree this call created for $role was removed" \
        || log "worktree rm FAILED for $role (rc=$wr); it is KEPT"
    fi
  }
  rolewrite() {   # $1=site $2=path $3=content
    write "$1" "$2" "$3" && return 0
    kept "cannot write $2"
    cleanup_before_task
    return 1
  }

  # ★ **作った worktree が、親の「いまの」HEAD から切られているかを確かめる。**
  #   `worktree create` に基点を渡す口が無いので、基点を決めるのは Orca である。実測:
  #   先のタスクを親へ取り込んで HEAD が進んだあとに切った worktree が、**取り込み前の
  #   base のまま**だった。そこで実装させると、既に入っている変更を知らないまま働くので、
  #   持ち帰りで必ず衝突する。**古い基点で黙って働かせない。**
  #   **再利用した worktree には触らない** — 進行中の作業を巻き戻しかねない。
  if [[ -n "$CREATED" ]]; then
    local HRR HWT
    HRR=$(git -C "$RR" rev-parse HEAD 2>/dev/null) || HRR=""
    HWT=$(git -C "$WT_PATH" rev-parse HEAD 2>/dev/null) || HWT=""
    if [[ -z "$HRR" || -z "$HWT" ]]; then
      # ★ **読めないことを「一致している」と読まない。**判断できないなら作らない。
      kept "cannot compare the $role worktree's base with the parent checkout"
      cleanup_before_task; return 1
    fi
    if [[ "$HWT" != "$HRR" ]]; then
      if git -C "$WT_PATH" merge-base --is-ancestor "$HWT" "$HRR" 2>/dev/null; then
        # 親のほうが進んでいる = これが実測した状態。**早送りだけで直す** — commit は作らない
        git -C "$WT_PATH" merge --ff-only "$HRR" >/dev/null 2>&1 || {
          kept "the $role worktree is behind the parent checkout and cannot be fast-forwarded"
          cleanup_before_task; return 1; }
        log "fast-forwarded the $role worktree to the parent checkout ($HRR)"
      elif ! git -C "$WT_PATH" merge-base --is-ancestor "$HRR" "$HWT" 2>/dev/null; then
        # 祖先関係がどちらにも無い = 別の歴史。**推測で混ぜない**
        kept "the $role worktree's base ($HWT) is unrelated to the parent checkout ($HRR)"
        cleanup_before_task; return 1
      fi
    fi
  fi
  rolewrite "status-$role" "$rd/status.json" '{"status":"starting"}' || return 1
  # ★ **この worktree を誰が作ったか**を記録する (round 3 finding 1)。端末はまだ存在しないので
  #   端末集合の inventory は worker-start の後（端末が生まれてから）に回す
  local OWNED=false; [[ -n "$CREATED" ]] && OWNED=true
  jq_write "workers-worktree-$role" "$WFILE" -c --arg r "$role" --arg w "$WT_ID" --arg p "$WT_PATH" \
    --arg b "$BR" --argjson own "$OWNED" \
    '.roles[$r] += {worktree_id:$w, worktree_path:$p, branch:$b,
                    worktree_created_by_this_run:$own, worktree_terminals:null}' "$WFILE" || {
    kept "cannot record the $role worktree"; cleanup_before_task; return 1; }

  local SPEC TCJ TJ
  SPEC=$(render_spec "$role")
  TCJ=0; TJ=$("$ORCA_BIN" orchestration task-create --spec "$SPEC" --task-title "$title" \
                --from "$PH" --json 2>/dev/null) || TCJ=$?
  TID=$(jq -r '.result.task.id // empty' <<<"$TJ" 2>/dev/null || echo "")
  if [[ "$TCJ" -ne 0 ]]; then
    if [[ -n "$TID" ]]; then
      kept "task-create failed for $role (rc=$TCJ) but returned task id $TID; a Task may exist. Resources are KEPT."
      log "task=$TID  inspect with: $ORCA_BIN orchestration task-list --run $RUN --json"
      return 1
    fi
    kept "task-create failed for $role (rc=$TCJ); no Task was created"
    cleanup_before_task
    return 1
  fi
  if [[ -z "$TID" ]]; then
    kept "task-create returned success but no task id for $role; a Task may exist. Resources are KEPT."
    log "inspect with: $ORCA_BIN orchestration task-list --run $RUN --json"
    return 1
  fi
  # Task が実在するので、ここから先は削除しない。identity を出して止める
  jq_write "workers-after-task-$role" "$WFILE" -c --arg r "$role" --arg t "$TID" \
    '.roles[$r].task = $t' "$WFILE" || {
    kept "the $role task was created but could not be recorded. Resources are KEPT."
    log "task=$TID  inspect with: $ORCA_BIN orchestration task-list --run $RUN --json"; return 1; }

  # ★ **`worktree create` が作った空の最初の端末を覚えておく**（実測 2026-09-19）。
  #   worker-start は既存 worktree に agent 端末を別に作るので、放っておくと空のシェルが残る。
  #   receipt は handle を返さない（startupTerminal=null）ため、agent 端末が生まれる前に列挙する。
  #   **この呼び出しが作り、setup を走らせず、端末がちょうど 1 枚のときだけ**それと確定する。
  #   それ以外（再利用 / setup 端末 / repo 設定のタブ / 列挙失敗）は区別できないので触らない
  local ST="" STL
  if [[ -n "$CREATED" && "$SETUP" != run ]]; then
    STL=$("$ORCA_BIN" terminal list --worktree "id:$WT_ID" --json 2>/dev/null) \
      && ST=$(jq -r '.result.terminals | if type == "array" and length == 1 then .[0].handle // "" else "" end' \
                <<<"$STL" 2>/dev/null) || ST=""
  fi
  # ★ ここから先は何が起きても資源を削除しない (O19)。
  #   **rc 0 + state=ready + dispatch id の 3 つ揃い**を要求する。
  #   failed / outcome_unknown の receipt にも dispatchId が残ることがある
  # ★ `--effort requires --model` (Orca)。config-resolve が model 無しの effort を既に
  #   落としているが、ここでも組にして渡す — 片方だけが残ると worker-start が使用法で落ちる
  local WS_ARGS=(--agent "$agent")
  if [[ -n "$model" ]]; then
    WS_ARGS+=(--model "$model")
    [[ -n "$effort" ]] && WS_ARGS+=(--effort "$effort")
  fi
  log "$role runs agent=$agent model=${model:-<orca default>} effort=${effort:-<orca default>}"
  local WRC=0 WJ2 WSTATE
  WJ2=$("$ORCA_BIN" orchestration worker-start --task "$TID" --worktree "id:$WT_ID" \
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
    jq_write "workers-orphan-dispatch-$role" "$WFILE" -c --arg r "$role" --arg d "$DID" \
      '.roles[$r].dispatch = $d' "$WFILE" \
      || log "the dispatch id could not be recorded either; wait on dispatch=$DID by hand"
  }
  if [[ "$WRC" -ne 0 || "$WSTATE" != ready || -z "$DID" ]]; then
    record_orphan_dispatch
    log "worker-start did not report ready for $role (rc=$WRC state='${WSTATE:-none}'). Resources are KEPT."
    log "inspect with: $ORCA_BIN orchestration task-list --run $RUN --json"
    return 1
  fi
  if [[ -z "$H" ]]; then
    record_orphan_dispatch
    log "worker-start reported ready for $role but returned no agent terminal handle. Resources are KEPT."
    log "task=$TID dispatch=$DID  inspect with: $ORCA_BIN orchestration worker-show --dispatch $DID --json"
    return 1
  fi
  # 空の最初の端末を**ペイン単位で**閉じる。`--tab` だと agent が同じタブに split で
  # 置かれる設定のとき agent ごと閉じる。閉じられなくても見た目だけの問題なので止めない
  if [[ -n "$ST" && "$ST" != "$H" ]]; then
    "$ORCA_BIN" terminal close --terminal "$ST" --json >/dev/null 2>&1 \
      || log "could not close the empty startup terminal $ST in the $role worktree; it is left open"
  fi
  # ★ **inventory の失敗を空配列に化けさせない** (round 4 finding 1)。
  #   列挙できなかったことと「端末が 0 個」は別である。前者を [] にすると、
  #   あとの cleanup gate が「未 account 0」と読んで削除を許してしまう (fail-open)。
  #   確定できなければ null を記録し、gate 側はそれを「判断不能」として閉じる
  local TLRC=0 TL TERMS
  TL=$("$ORCA_BIN" terminal list --worktree "id:$WT_ID" --json 2>/dev/null) || TLRC=$?
  if [[ "$TLRC" -eq 0 ]] && jq -e '.result.terminals | type == "array"' <<<"$TL" >/dev/null 2>&1; then
    TERMS=$(jq -c '[.result.terminals[].handle]' <<<"$TL")
  else
    TERMS=null
    log "could not inventory the terminals in the $role worktree (rc=$TLRC); cleanup will refuse to remove it"
  fi
  jq_write "workers-after-dispatch-$role" "$WFILE" -c --arg r "$role" --arg d "$DID" --arg h "$H" \
    --argjson ts "$TERMS" \
    '.roles[$r] += {dispatch:$d, terminal:$h, worktree_terminals:$ts}' "$WFILE" || {
    kept "the $role worker started but the dispatch id could not be recorded. Resources are KEPT."
    log "task=$TID dispatch=$DID"
    log "inspect with: $ORCA_BIN orchestration worker-show --dispatch $DID --json"; return 1; }
  return 0
}

for role in "${LAUNCH_ORDER[@]}"; do
  # ★ **reviewer が起きなければ design を起こさない。**依頼先の無いレビュー要求で
  #   design が待ち続けるより、1 件も起こさないほうが片付けが簡単である。
  #   逆に design が失敗しても reviewer の資源は消さない（Task 成立後は削除しない / O19）。
  launch_role "$role" || exit 1
done
printf 'status_dir=%s\nrun_id=%s\n' "$SD" "$RUN"
