#!/usr/bin/env bash
# Build the complete request for an already-running exec role and deliver it once.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./config-lib.sh
source "$SCRIPT_DIR/config-lib.sh"

die() { echo "phase-b-deliver: $1" >&2; exit 2; }
usage() {
  echo 'usage: phase-b-deliver.sh --prewarm <path> [--review-config <path>] --plan-file <path> --status-dir <dir> --team <team> --slug <slug> [--agents <2..8>]' >&2
  exit 2
}

PREWARM_FILE=''; REVIEW_CONFIG=''; PLAN_FILE=''; STATUS_DIR=''; TEAM=''; SLUG=''; MAX_AGENTS=4
AGMSG_SEND="${AGMSG_SEND:-$HOME/.agents/skills/agmsg/scripts/send.sh}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prewarm) [[ $# -ge 2 ]] || usage; PREWARM_FILE="$2"; shift 2 ;;
    --review-config) [[ $# -ge 2 ]] || usage; REVIEW_CONFIG="$2"; shift 2 ;;
    --plan-file) [[ $# -ge 2 ]] || usage; PLAN_FILE="$2"; shift 2 ;;
    --status-dir) [[ $# -ge 2 ]] || usage; STATUS_DIR="$2"; shift 2 ;;
    --team) [[ $# -ge 2 ]] || usage; TEAM="$2"; shift 2 ;;
    --slug) [[ $# -ge 2 ]] || usage; SLUG="$2"; shift 2 ;;
    --agents) [[ $# -ge 2 ]] || usage; MAX_AGENTS="$2"; shift 2 ;;
    *) usage ;;
  esac
done
[[ -n "$PREWARM_FILE" && -n "$PLAN_FILE" && -n "$STATUS_DIR" && -n "$TEAM" && -n "$SLUG" ]] \
  || usage
[[ "$SLUG" =~ ^[A-Za-z0-9._-]+$ ]] || die 'invalid slug'
case "$TEAM" in *[[:space:]]*|*[\'\"\`\$\!\\]*) die 'invalid team' ;; esac
[[ "$MAX_AGENTS" =~ ^[2-8]$ ]] || die 'agents must be 2..8'
[[ -f "$AGMSG_SEND" ]] || die "send.sh not found at $AGMSG_SEND"
if [[ -e "$STATUS_DIR" || -L "$STATUS_DIR" ]]; then
  [[ -d "$STATUS_DIR" && ! -L "$STATUS_DIR" ]] \
    || die 'status directory must be a non-symlink directory'
fi

PREWARM_DOC=$(cat "$PREWARM_FILE") || die 'cannot read prewarm snapshot'
RUNNERS_FILE="$(dispatch_runners_file)"
[[ -f "$RUNNERS_FILE" ]] || die "runners.json not found at $RUNNERS_FILE"
jq -e '.runners | type == "array"' "$RUNNERS_FILE" >/dev/null 2>&1 \
  || die 'runners.json is invalid'

validate_prewarm_snapshot() {
  local bad_top review_mode role expected_agent runner engine effort model runner_engine
  jq -e -s 'length == 1 and (.[0] | type == "object")' >/dev/null 2>&1 <<< "$PREWARM_DOC" \
    || return 1
  bad_top=$(jq -r '[keys[] | select(. != "workspace_id" and . != "review_mode" and
    . != "design" and . != "design_review" and . != "exec" and . != "exec_review")] |
    first // empty' <<< "$PREWARM_DOC")
  [[ -z "$bad_top" ]] || return 1
  jq -e '.workspace_id | type == "string" and length > 0' >/dev/null 2>&1 <<< "$PREWARM_DOC" \
    || return 1
  dispatch_valid_workspace_id "$(jq -r '.workspace_id' <<< "$PREWARM_DOC")" || return 1
  review_mode=$(jq -r '.review_mode // empty' <<< "$PREWARM_DOC")
  [[ "$review_mode" == on || "$review_mode" == off ]] || return 1
  if [[ "$review_mode" == off ]]; then
    jq -e 'has("design_review") or has("exec_review")' >/dev/null 2>&1 <<< "$PREWARM_DOC" \
      && return 1
  fi
  jq -e 'has("design") and has("exec")' >/dev/null 2>&1 <<< "$PREWARM_DOC" || return 1

  for role in design design_review exec exec_review; do
    jq -e --arg role "$role" 'has($role)' >/dev/null 2>&1 <<< "$PREWARM_DOC" || continue
    jq -e --arg role "$role" '
      (.[$role] | type == "object") and
      ((.[$role] | keys - ["surface_id","agent","runner","engine","model","effort","wired"]) |
        length == 0) and
      (.[$role] | has("surface_id") and has("agent") and has("runner") and has("engine") and
        has("effort") and has("wired")) and
      (.[$role].surface_id | type == "string" and length > 0) and
      (.[$role].agent | type == "string" and length > 0) and
      (.[$role].runner | type == "string") and (.[$role].engine | type == "string") and
      (.[$role].effort | type == "string") and (.[$role].wired == true)' \
      >/dev/null 2>&1 <<< "$PREWARM_DOC" || return 1
    dispatch_valid_surface_id "$(jq -r --arg role "$role" '.[$role].surface_id' <<< "$PREWARM_DOC")" \
      || return 1
    case "$role" in
      design) expected_agent="$SLUG" ;;
      *) expected_agent="$SLUG-${role//_/-}" ;;
    esac
    [[ "$(jq -r --arg role "$role" '.[$role].agent' <<< "$PREWARM_DOC")" == "$expected_agent" ]] \
      || return 1
    runner=$(jq -r --arg role "$role" '.[$role].runner' <<< "$PREWARM_DOC")
    engine=$(jq -r --arg role "$role" '.[$role].engine' <<< "$PREWARM_DOC")
    effort=$(jq -r --arg role "$role" '.[$role].effort' <<< "$PREWARM_DOC")
    dispatch_valid_runner_name "$runner" || return 1
    dispatch_valid_effort "$effort" "$engine" || return 1
    runner_engine=$(jq -r --arg runner "$runner" \
      'first(.runners[]? | select(.name == $runner) | .engine) // empty' "$RUNNERS_FILE")
    [[ -n "$runner_engine" && "$runner_engine" == "$engine" ]] || return 1
    if jq -e --arg role "$role" '.[$role] | has("model")' >/dev/null 2>&1 <<< "$PREWARM_DOC"; then
      jq -e --arg role "$role" '.[$role].model | type == "string" and length > 0' \
        >/dev/null 2>&1 <<< "$PREWARM_DOC" || return 1
      model=$(jq -r --arg role "$role" '.[$role].model' <<< "$PREWARM_DOC")
      dispatch_valid_model "$model" || return 1
    elif dispatch_model_required "$role" "$engine"; then
      return 1
    fi
  done
  jq -e '[. as $d | ["design","design_review","exec","exec_review"][] |
    select($d[.] != null) | $d[.].surface_id] as $ids |
    ($ids | length) == ($ids | unique | length)' >/dev/null 2>&1 <<< "$PREWARM_DOC" || return 1
}

validate_prewarm_snapshot || die 'invalid prewarm snapshot'
PREWARM_WORKSPACE=$(jq -r '.workspace_id' <<< "$PREWARM_DOC")
EXEC_AGENT=$(jq -r '.exec.agent' <<< "$PREWARM_DOC")
EXEC_ENGINE=$(jq -r '.exec.engine' <<< "$PREWARM_DOC")
HAS_EXEC_REVIEW=0
jq -e 'has("exec_review")' >/dev/null 2>&1 <<< "$PREWARM_DOC" && HAS_EXEC_REVIEW=1
if [[ $HAS_EXEC_REVIEW -eq 1 && -z "$REVIEW_CONFIG" ]]; then
  die 'usable exec_review requires --review-config'
elif [[ $HAS_EXEC_REVIEW -eq 0 && -n "$REVIEW_CONFIG" ]]; then
  die '--review-config requires a usable exec_review tuple'
fi

PARALLEL=$(bash "$SCRIPT_DIR/parallel-directive.sh" \
  --engine "$EXEC_ENGINE" --mode execute --agents "$MAX_AGENTS")
STATUS_PROTOCOL="MANDATORY STATUS PROTOCOL: before doing any work, write $STATUS_DIR/status.json with status executing, preserve all existing fields, and preserve an existing pr_url. Every terminal path must write $STATUS_DIR/result.md. On success, write the result summary, run bash $SCRIPT_DIR/report-status.sh $STATUS_DIR done followed by a one line summary, then immediately call $AGMSG_SEND with exactly four arguments: team $TEAM, sender $EXEC_AGENT, recipient parent, and the body dispatch-notify: [dispatch] task $EXEC_AGENT finished (status: done). On any failure or blocking error, write the reason to the result file, run bash $SCRIPT_DIR/report-status.sh $STATUS_DIR error followed by that reason, then immediately call $AGMSG_SEND with exactly four arguments: team $TEAM, sender $EXEC_AGENT, recipient parent, and the body dispatch-notify: [dispatch] task $EXEC_AGENT finished (status: error). A non-zero terminal notification means the parent was not told; retry once and, if the second send also fails, record that notification failure in status.json."
REQUEST_TEXT="Read and execute the plan at $PLAN_FILE. ${PARALLEL:+$PARALLEL }$STATUS_PROTOCOL"

if [[ -n "$REVIEW_CONFIG" ]]; then
  [[ -f "$REVIEW_CONFIG" && ! -L "$REVIEW_CONFIG" ]] \
    || die 'review config must be a regular non-symlink file'
  REVIEW_DOC=$(cat "$REVIEW_CONFIG") || die 'cannot read review config'
  jq -e -s 'length == 1 and (.[0] | type == "object") and
    (.[0] | keys == ["review_dir","reviewer_agent","reviewer_engine","reviewer_runner",
      "reviewer_surface","reviewer_workspace"])' >/dev/null 2>&1 <<< "$REVIEW_DOC" \
    || die 'invalid review config schema'
  REVIEWER_AGENT=$(jq -r '.reviewer_agent' <<< "$REVIEW_DOC")
  REVIEWER_RUNNER=$(jq -r '.reviewer_runner' <<< "$REVIEW_DOC")
  REVIEWER_ENGINE=$(jq -r '.reviewer_engine' <<< "$REVIEW_DOC")
  REVIEWER_SURFACE=$(jq -r '.reviewer_surface' <<< "$REVIEW_DOC")
  REVIEWER_WORKSPACE=$(jq -r '.reviewer_workspace' <<< "$REVIEW_DOC")
  REVIEW_DIR=$(jq -r '.review_dir' <<< "$REVIEW_DOC")
  [[ "$REVIEWER_AGENT" == "$SLUG-exec-review" ]] || die 'reviewer agent does not match slug'
  dispatch_valid_runner_name "$REVIEWER_RUNNER" || die 'invalid reviewer runner'
  dispatch_valid_surface_id "$REVIEWER_SURFACE" || die 'invalid reviewer surface ID'
  dispatch_valid_workspace_id "$REVIEWER_WORKSPACE" || die 'invalid reviewer workspace ID'
  [[ "$REVIEWER_WORKSPACE" == "$PREWARM_WORKSPACE" ]] || die 'reviewer workspace mismatch'
  [[ -d "$REVIEW_DIR" && ! -L "$REVIEW_DIR" ]] || die 'invalid review directory'
  REVIEW_DIR=$(cd "$REVIEW_DIR" 2>/dev/null && pwd -P) || die 'cannot resolve review directory'
  STATUS_REAL=$(cd "$STATUS_DIR" 2>/dev/null && pwd -P) || die 'cannot resolve status directory'
  [[ "$REVIEW_DIR" == "$STATUS_REAL/review" ]] || die 'review directory is outside status directory'
  CONFIG_PARENT=$(cd "$(dirname "$REVIEW_CONFIG")" 2>/dev/null && pwd -P) \
    || die 'cannot resolve review config parent'
  [[ "$CONFIG_PARENT" == "$REVIEW_DIR" ]] || die 'review config is outside review directory'
  REGISTERED_REVIEW_ENGINE=$(jq -r --arg runner "$REVIEWER_RUNNER" \
    'first(.runners[]? | select(.name == $runner) | .engine) // empty' "$RUNNERS_FILE")
  [[ "$REGISTERED_REVIEW_ENGINE" == "$REVIEWER_ENGINE" ]] || die 'reviewer runner/engine mismatch'
  jq -e --arg agent "$REVIEWER_AGENT" --arg runner "$REVIEWER_RUNNER" \
    --arg engine "$REVIEWER_ENGINE" --arg surface "$REVIEWER_SURFACE" '
    .exec_review.agent == $agent and .exec_review.runner == $runner and
    .exec_review.engine == $engine and .exec_review.surface_id == $surface' \
    >/dev/null 2>&1 <<< "$PREWARM_DOC" || die 'review config does not match prewarm exec_review tuple'

  REVIEW_PARALLEL=$(bash "$SCRIPT_DIR/parallel-directive.sh" \
    --engine "$REVIEWER_ENGINE" --mode review --agents "$MAX_AGENTS")
  # directive が空 (codex reviewer) のときは囲みごと落とす。空の囲みを残すと実装者が
  # 中身のない reviewer-only directive をレビュー依頼へ転記してしまう。
  REVIEWER_ONLY_BLOCK=""
  if [[ -n "$REVIEW_PARALLEL" ]]; then
    REVIEWER_ONLY_BLOCK="Include this reviewer-only directive in the review request: $REVIEW_PARALLEL End reviewer-only directive. "
  fi
  FINDINGS_PATH="$REVIEW_DIR/code-round-N.md"
  # 依頼をディスクへ materialize させる。completion-gate.sh の「レビュー待ちなら停止を許す」
  # 判定はディスクだけを読み、その材料は <point>-round-<N>-request.md である。Phase A-R は
  # 依頼文を書くので成立するが、Phase B-R は依頼を agmsg メッセージだけで送っていた。その結果
  # round 2 以降の verdict を待つ実装者は、最新 round ファイルが前ラウンドの VERDICT 付き
  # findings を指したまま、最新 request が設計フェーズの古い依頼文のままになり、判定 7 に落ちて
  # 毎ターン block された。block の reason は「詰まっているなら error を書け」と教えるので、
  # 2026-08-28 に codex の exec が依頼の 110 秒後に error を書いて中断した (レビューは
  # 進行中で、round 1 は約 17 分、round 2 は約 10 分かかっていた)。
  REQUEST_PATH="$REVIEW_DIR/code-round-N-request.md"
  case "$REVIEWER_ENGINE" in
    codex)
      REVIEWER_LIVENESS="run bash $SCRIPT_DIR/verify-agmsg-ready.sh --codex --team $TEAM --name $REVIEWER_AGENT once"
      ;;
    claude)
      REVIEWER_LIVENESS="run cmux read-screen --workspace $REVIEWER_WORKSPACE --surface $REVIEWER_SURFACE once; if that transiently fails, retry it once before treating the reviewer as unreachable"
      ;;
  esac
  case "$EXEC_ENGINE" in
    claude)
      WAIT_PROTOCOL="After each successful review-code: send, stop and wait for the review-verdict: push. Before stopping, arm ONE single-shot safety timer with the Bash tool using run_in_background. On every wake, re-read $FINDINGS_PATH before deciding anything; a timer wake without a VERDICT line is not a verdict. If the timer fires without a verdict, $REVIEWER_LIVENESS, then re-send the same round once when needed and re-arm the same timer, up to 3 re-arms for that round."
      ;;
    codex)
      WAIT_PROTOCOL="After each successful review-code: send, stop and wait for the review-verdict: push. You have NO safety net for this wait and must not create a timer. Before stopping, $REVIEWER_LIVENESS, then call $AGMSG_SEND once, passing exactly four arguments in this order: team $TEAM, sender $EXEC_AGENT, recipient parent, and one dispatch-notify: body reporting an unbacked code review wait; the body must say dispatch-notify: $EXEC_AGENT waiting for code review verdict; this engine has no timer. On every wake, re-read $FINDINGS_PATH before deciding anything."
      ;;
  esac
    # 中断記録は $FINDINGS_PATH (レビュアーの出力先) へ書かせない。詳細は completion-gate.sh の
  # latest_abort() の comment を参照。ゲートの解放はそちらが -abort.md を見て行う。
  ABORT_PATH="$REVIEW_DIR/code-round-N-abort.md"
  REVIEW_ABORT="REVIEW ABORT PROTOCOL: if you stop before completing the work, write the stop reason to $ABORT_PATH, never to $FINDINGS_PATH which belongs to the reviewer and may be mid-write, then call $AGMSG_SEND once with exactly four arguments: team $TEAM, sender $EXEC_AGENT, recipient $REVIEWER_AGENT, and a body starting abort-reviewer: [abort] followed by the one line reason. Next follow the error branch of the mandatory status protocol, including the result file, bash $SCRIPT_DIR/report-status.sh $STATUS_DIR error, and the parent notification ending finished (status: error), before ending the session."
  REQUEST_TEXT="$REQUEST_TEXT MANDATORY CODE REVIEW: after all changes are committed and before creating the PR, request the review with ONE call to $AGMSG_SEND, passing exactly four arguments in this order: team $TEAM, sender $EXEC_AGENT, recipient $REVIEWER_AGENT, and the whole review-code: message as one argument. For round N, write that same message text to $REQUEST_PATH before that send: the completion gate reads only the disk, and this file is the sole proof that you are waiting for a verdict instead of idling mid-task. Without it the gate stops you every turn and offers a terminal error you must not take. For round N, that message tells the reviewer to inspect the committed implementation, write findings to $FINDINGS_PATH whose last line is VERDICT: approve or VERDICT: needs_work, then call $AGMSG_SEND once, passing exactly four arguments in this order: team $TEAM, sender $REVIEWER_AGENT, recipient $EXEC_AGENT, and the whole review-verdict: message as one argument. ${REVIEWER_ONLY_BLOCK}$WAIT_PROTOCOL A non-zero send exit means the recipient was not told, so report it instead of waiting. Do not poll the findings file. Run a maximum of 5 rounds. On needs_work, fix valid findings and request N plus 1. On approve, proceed. Do not start round 6; if round 5 is needs_work, record unresolved findings in the PR body and proceed. $REVIEW_ABORT"
fi

case "$EXEC_ENGINE" in
  claude) REQUEST_TEXT="$REQUEST_TEXT After completion, run /exit to close this session." ;;
  codex) REQUEST_TEXT="$REQUEST_TEXT After completion, stop and stay idle. Do not run /exit; the parent closes this pane during final cleanup." ;;
esac

mkdir -p "$STATUS_DIR" || die 'cannot create status directory'
: > "$STATUS_DIR/.assigned-$EXEC_AGENT" || die 'cannot write assignment marker'
if ! bash "$AGMSG_SEND" "$TEAM" "$SLUG" "$EXEC_AGENT" "phase-b-exec: $REQUEST_TEXT"; then
  die 'phase-b-exec delivery failed'
fi
: > "$STATUS_DIR/.deferred" || die 'cannot write deferred marker'
