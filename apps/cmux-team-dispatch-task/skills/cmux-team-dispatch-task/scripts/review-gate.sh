#!/usr/bin/env bash
# Materialize the Phase B-R launcher configuration only when exec_review was
# launched and subsequently reported ready.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./config-lib.sh
. "$SCRIPT_DIR/config-lib.sh"

usage() {
  echo 'usage: review-gate.sh --prewarm <path> --ready <role>... --status-dir <dir> --slug <slug> --team <team> --reviewer-workspace <ws>' >&2
  exit 2
}
die() { echo "review-gate: $1" >&2; exit 2; }
skip() {
  prepare_review_destination no
  if [[ -e "$CONFIG_FILE" || -L "$CONFIG_FILE" ]]; then
    [[ -f "$CONFIG_FILE" && ! -L "$CONFIG_FILE" ]] || die 'unsafe existing review config target'
    rm -f -- "$CONFIG_FILE" || die 'cannot remove stale review config'
  fi
  echo "[warn] review-gate: $1; skipping Phase B-R" >&2
  exit 0
}

PREWARM_FILE=''
STATUS_DIR=''
SLUG=''
TEAM=''
REVIEWER_WORKSPACE=''
EXEC_REVIEW_READY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prewarm) [[ $# -ge 2 ]] || usage; PREWARM_FILE="$2"; shift 2 ;;
    --ready)
      [[ $# -ge 2 ]] || usage
      case "$2" in
        design|design_review|exec) ;;
        exec_review) EXEC_REVIEW_READY=1 ;;
        *) usage ;;
      esac
      shift 2
      ;;
    --status-dir) [[ $# -ge 2 ]] || usage; STATUS_DIR="$2"; shift 2 ;;
    --slug) [[ $# -ge 2 ]] || usage; SLUG="$2"; shift 2 ;;
    --team) [[ $# -ge 2 ]] || usage; TEAM="$2"; shift 2 ;;
    --reviewer-workspace) [[ $# -ge 2 ]] || usage; REVIEWER_WORKSPACE="$2"; shift 2 ;;
    *) usage ;;
  esac
done

[[ -n "$PREWARM_FILE" && -n "$STATUS_DIR" && -n "$SLUG" && -n "$TEAM" \
  && -n "$REVIEWER_WORKSPACE" ]] || usage
[[ "$SLUG" =~ ^[A-Za-z0-9._-]+$ ]] || die 'invalid slug'
dispatch_valid_workspace_id "$REVIEWER_WORKSPACE" || die 'invalid reviewer workspace ID'

REVIEW_DIR="$STATUS_DIR/review"
CONFIG_FILE="$REVIEW_DIR/code-review.json"

prepare_review_destination() { # $1=yes creates missing directories; no only validates existing paths
  local create="$1" status_real review_real
  if [[ -e "$STATUS_DIR" || -L "$STATUS_DIR" ]]; then
    [[ -d "$STATUS_DIR" && ! -L "$STATUS_DIR" ]] \
      || die 'status path must be a non-symlink directory'
  elif [[ "$create" == yes ]]; then
    mkdir -p "$STATUS_DIR" || die 'cannot create status directory'
  else
    return 0
  fi

  REVIEW_DIR="$STATUS_DIR/review"
  if [[ -e "$REVIEW_DIR" || -L "$REVIEW_DIR" ]]; then
    [[ -d "$REVIEW_DIR" && ! -L "$REVIEW_DIR" ]] || die 'review directory must be a non-symlink directory'
  elif [[ "$create" == yes ]]; then
    mkdir "$REVIEW_DIR" || die 'cannot create review directory'
  else
    CONFIG_FILE="$REVIEW_DIR/code-review.json"
    return 0
  fi

  status_real=$(cd "$STATUS_DIR" 2>/dev/null && pwd -P) || die 'cannot resolve status directory'
  review_real=$(cd "$REVIEW_DIR" 2>/dev/null && pwd -P) || die 'cannot resolve review directory'
  [[ "$review_real" == "$status_real/review" ]] || die 'review directory escapes status directory'
  REVIEW_DIR="$review_real"
  CONFIG_FILE="$REVIEW_DIR/code-review.json"
  if [[ -e "$CONFIG_FILE" || -L "$CONFIG_FILE" ]]; then
    [[ -f "$CONFIG_FILE" && ! -L "$CONFIG_FILE" ]] || die 'unsafe existing review config target'
  fi
}

# One content read only. Validation and extraction below never reopen the path.
PREWARM_DOC=$(cat "$PREWARM_FILE") || die 'cannot read prewarm snapshot'
jq -e 'type == "object"' >/dev/null 2>&1 <<< "$PREWARM_DOC" \
  || die 'prewarm snapshot is not a JSON object'

RUNNERS_FILE="$(dispatch_runners_file)"
[[ -f "$RUNNERS_FILE" ]] || die "runners.json not found at $RUNNERS_FILE"
jq -e '.runners | type == "array"' "$RUNNERS_FILE" >/dev/null 2>&1 \
  || die 'runners.json is invalid'

validate_prewarm_snapshot() {
  local bad_top review_mode role expected_agent runner engine effort model runner_engine
  bad_top=$(jq -r '[keys[] | select(. != "workspace_id" and . != "review_mode" and
    . != "design" and . != "design_review" and . != "exec" and . != "exec_review")] | first // empty' \
    <<< "$PREWARM_DOC")
  [[ -z "$bad_top" ]] || return 1
  jq -e '.workspace_id | type == "string" and length > 0' >/dev/null 2>&1 <<< "$PREWARM_DOC" \
    || return 1
  dispatch_valid_workspace_id "$(jq -r '.workspace_id' <<< "$PREWARM_DOC")" || return 1
  [[ "$(jq -r '.workspace_id' <<< "$PREWARM_DOC")" == "$REVIEWER_WORKSPACE" ]] || return 1
  review_mode=$(jq -r '.review_mode // empty' <<< "$PREWARM_DOC")
  [[ "$review_mode" == on || "$review_mode" == off ]] || return 1
  if [[ "$review_mode" == off ]]; then
    jq -e 'has("design_review") or has("exec_review")' >/dev/null 2>&1 <<< "$PREWARM_DOC" && return 1
  fi
  jq -e 'has("design") and has("exec")' >/dev/null 2>&1 <<< "$PREWARM_DOC" || return 1

  for role in design design_review exec exec_review; do
    jq -e --arg role "$role" 'has($role)' >/dev/null 2>&1 <<< "$PREWARM_DOC" || continue
    jq -e --arg role "$role" '
      (.[$role] | type == "object") and
      ((.[$role] | keys - ["surface_id","agent","runner","engine","model","effort","wired"]) | length == 0) and
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
jq -e 'has("exec_review")' >/dev/null 2>&1 <<< "$PREWARM_DOC" \
  || skip 'exec_review was not launched or was pruned after readiness failure'
[[ $EXEC_REVIEW_READY -eq 1 ]] || skip 'exec_review did not report ready'

prepare_review_destination yes
tmp=$(mktemp "$REVIEW_DIR/.code-review.json.XXXXXX") || die 'cannot create temporary review config'
if jq -n \
  --arg reviewer_surface "$(jq -r '.exec_review.surface_id' <<< "$PREWARM_DOC")" \
  --arg reviewer_agent "$(jq -r '.exec_review.agent' <<< "$PREWARM_DOC")" \
  --arg reviewer_runner "$(jq -r '.exec_review.runner' <<< "$PREWARM_DOC")" \
  --arg reviewer_engine "$(jq -r '.exec_review.engine' <<< "$PREWARM_DOC")" \
  --arg reviewer_workspace "$REVIEWER_WORKSPACE" --arg review_dir "$REVIEW_DIR" \
  '{reviewer_surface:$reviewer_surface, reviewer_agent:$reviewer_agent,
    reviewer_runner:$reviewer_runner, reviewer_engine:$reviewer_engine,
    reviewer_workspace:$reviewer_workspace, review_dir:$review_dir}' > "$tmp"; then
  mv -- "$tmp" "$CONFIG_FILE" || { rm -f -- "$tmp"; die 'cannot publish review config'; }
else
  rm -f -- "$tmp"
  die 'cannot write review config'
fi

[[ -f "$CONFIG_FILE" && ! -L "$CONFIG_FILE" ]] \
  || die 'published review config is not a regular file'
jq -e -s 'length == 1 and (.[0] | type == "object") and
  (.[0] | keys == ["review_dir","reviewer_agent","reviewer_engine","reviewer_runner",
    "reviewer_surface","reviewer_workspace"])' "$CONFIG_FILE" >/dev/null 2>&1 \
  || die 'published review config is not valid JSON'

printf '%s\n' "$CONFIG_FILE"
