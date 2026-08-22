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

PREWARM_DOC=$(cat "$PREWARM_FILE") || die 'cannot read prewarm snapshot'
RUNNERS_FILE="$(dispatch_runners_file)"
[[ -f "$RUNNERS_FILE" ]] || die "runners.json not found at $RUNNERS_FILE"
jq -e -s 'length == 1 and (.[0] | type == "object") and
  (.[0].review_mode == "on" or .[0].review_mode == "off") and
  (.[0] | has("design") and has("exec")) and
  (if .[0].review_mode == "off" then
    (.[0] | has("design_review") or has("exec_review") | not) else true end)' \
  >/dev/null 2>&1 <<< "$PREWARM_DOC" || die 'invalid prewarm snapshot'
PREWARM_WORKSPACE=$(jq -r '.workspace_id // empty' <<< "$PREWARM_DOC")
dispatch_valid_workspace_id "$PREWARM_WORKSPACE" || die 'invalid prewarm workspace ID'
jq -e '.exec | type == "object" and
  ((keys - ["surface_id","agent","runner","engine","model","effort","wired"]) | length == 0) and
  (.surface_id | type == "string") and (.agent | type == "string") and
  (.runner | type == "string") and (.engine == "claude" or .engine == "codex") and
  (.effort | type == "string") and (.wired == true)' >/dev/null 2>&1 <<< "$PREWARM_DOC" \
  || die 'invalid exec tuple'
EXEC_SURFACE=$(jq -r '.exec.surface_id' <<< "$PREWARM_DOC")
EXEC_AGENT=$(jq -r '.exec.agent' <<< "$PREWARM_DOC")
EXEC_RUNNER=$(jq -r '.exec.runner' <<< "$PREWARM_DOC")
EXEC_ENGINE=$(jq -r '.exec.engine' <<< "$PREWARM_DOC")
EXEC_EFFORT=$(jq -r '.exec.effort' <<< "$PREWARM_DOC")
dispatch_valid_surface_id "$EXEC_SURFACE" || die 'invalid exec surface ID'
[[ "$EXEC_AGENT" == "$SLUG-exec" ]] || die 'exec agent does not match slug'
dispatch_valid_runner_name "$EXEC_RUNNER" || die 'invalid exec runner'
dispatch_valid_effort "$EXEC_EFFORT" "$EXEC_ENGINE" || die 'invalid exec effort'
if jq -e '.exec | has("model")' >/dev/null 2>&1 <<< "$PREWARM_DOC"; then
  EXEC_MODEL=$(jq -r '.exec.model' <<< "$PREWARM_DOC")
  dispatch_valid_model "$EXEC_MODEL" || die 'invalid exec model'
elif dispatch_model_required exec "$EXEC_ENGINE"; then
  die 'exec model is required'
fi
REGISTERED_ENGINE=$(jq -r --arg runner "$EXEC_RUNNER" \
  'first(.runners[]? | select(.name == $runner) | .engine) // empty' "$RUNNERS_FILE")
[[ "$REGISTERED_ENGINE" == "$EXEC_ENGINE" ]] || die 'exec runner/engine mismatch'

PARALLEL=$(bash "$SCRIPT_DIR/parallel-directive.sh" \
  --engine "$EXEC_ENGINE" --mode execute --agents "$MAX_AGENTS")
COMPLETION_TEXT="MANDATORY COMPLETION REPORT: after writing result.md, run bash $SCRIPT_DIR/report-status.sh $STATUS_DIR done followed by a one line summary, then call $AGMSG_SEND with exactly four arguments: team $TEAM, sender $EXEC_AGENT, recipient parent, and one dispatch-notify: body. A non-zero send exit means the parent was not told; retry once and record a second failure in status.json."
REQUEST_TEXT="Read and execute the plan at $PLAN_FILE. $PARALLEL $COMPLETION_TEXT"

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
  FINDINGS_PATH="$REVIEW_DIR/code-round-N.md"
  REQUEST_TEXT="$REQUEST_TEXT MANDATORY CODE REVIEW: after all changes are committed and before creating the PR, request a review from $REVIEWER_AGENT with one review-code: message. For round N, the reviewer must inspect the committed implementation, write findings to $FINDINGS_PATH whose last line is VERDICT: approve or VERDICT: needs_work, then send one review-verdict: message back. Run a maximum of 5 rounds. On needs_work, fix valid findings and request N plus 1. On approve, proceed. Do not start round 6; if round 5 is needs_work, record unresolved findings in the PR body and proceed. Include this reviewer-only directive in the review request: $REVIEW_PARALLEL End reviewer-only directive."
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
