#!/usr/bin/env bash
# Reclaim non-ready optional review roles only after validating all destructive targets.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./config-lib.sh
source "$SCRIPT_DIR/config-lib.sh"
CMUX_BIN="${CMUX_BIN:-/Applications/cmux.app/Contents/Resources/bin/cmux}"
AGMSG_DIR="${AGMSG_DIR:-$HOME/.agents/skills/agmsg/scripts}"

die() { echo "prune-not-ready: $1" >&2; exit 2; }
usage() {
  echo 'usage: prune-not-ready.sh --prewarm <path> --workspace <id> --team <team> --slug <slug> --role design_review|exec_review [--role ...]' >&2
  exit 2
}

PREWARM_FILE=''; WORKSPACE=''; TEAM=''; SLUG=''; ROLES=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prewarm) [[ $# -ge 2 ]] || usage; PREWARM_FILE="$2"; shift 2 ;;
    --workspace) [[ $# -ge 2 ]] || usage; WORKSPACE="$2"; shift 2 ;;
    --team) [[ $# -ge 2 ]] || usage; TEAM="$2"; shift 2 ;;
    --slug) [[ $# -ge 2 ]] || usage; SLUG="$2"; shift 2 ;;
    --role)
      [[ $# -ge 2 ]] || usage
      case "$2" in design_review|exec_review) ROLES+=("$2") ;; *) die "role '$2' is not optional" ;; esac
      shift 2 ;;
    *) usage ;;
  esac
done
[[ -n "$PREWARM_FILE" && -n "$WORKSPACE" && -n "$TEAM" && -n "$SLUG" && ${#ROLES[@]} -gt 0 ]] \
  || usage
dispatch_valid_workspace_id "$WORKSPACE" || die 'invalid workspace ID'
[[ "$SLUG" =~ ^[A-Za-z0-9._-]+$ ]] || die 'invalid slug'
[[ -x "$CMUX_BIN" ]] || die 'cmux is not executable'
[[ -x "$AGMSG_DIR/leave.sh" ]] || die 'agmsg leave.sh is not executable'

PREWARM_DOC=$(cat "$PREWARM_FILE") || die 'cannot read prewarm snapshot'
RUNNERS_FILE="$(dispatch_runners_file)"
[[ -f "$RUNNERS_FILE" ]] || die 'runners.json not found'
jq -e -s 'length == 1 and (.[0] | type == "object")' >/dev/null 2>&1 <<< "$PREWARM_DOC" \
  || die 'invalid prewarm JSON'
jq -e '((keys - ["workspace_id","review_mode","design","design_review","exec","exec_review"]) | length == 0) and
  (.review_mode == "on" or .review_mode == "off") and has("design") and has("exec")' \
  >/dev/null 2>&1 <<< "$PREWARM_DOC" || die 'invalid prewarm snapshot'
SNAPSHOT_WORKSPACE=$(jq -r '.workspace_id // empty' <<< "$PREWARM_DOC")
dispatch_valid_workspace_id "$SNAPSHOT_WORKSPACE" || die 'invalid snapshot workspace ID'
[[ "$SNAPSHOT_WORKSPACE" == "$WORKSPACE" ]] || die 'snapshot workspace mismatch'
if [[ $(jq -r '.review_mode' <<< "$PREWARM_DOC") == off ]]; then
  jq -e 'has("design_review") or has("exec_review")' >/dev/null 2>&1 <<< "$PREWARM_DOC" \
    && die 'review_mode=off contains review roles'
fi

for role in design design_review exec exec_review; do
  jq -e --arg role "$role" 'has($role)' >/dev/null 2>&1 <<< "$PREWARM_DOC" || continue
  jq -e --arg role "$role" '
    (.[$role] | type == "object") and
    ((.[$role] | keys - ["surface_id","agent","runner","engine","model","effort","wired"]) | length == 0) and
    (.[$role].surface_id | type == "string") and (.[$role].agent | type == "string") and
    (.[$role].runner | type == "string") and
    (.[$role].engine == "claude" or .[$role].engine == "codex") and
    (.[$role].effort | type == "string") and (.[$role].wired == true)' \
    >/dev/null 2>&1 <<< "$PREWARM_DOC" || die "invalid $role tuple"
  surface=$(jq -r --arg role "$role" '.[$role].surface_id' <<< "$PREWARM_DOC")
  agent=$(jq -r --arg role "$role" '.[$role].agent' <<< "$PREWARM_DOC")
  runner=$(jq -r --arg role "$role" '.[$role].runner' <<< "$PREWARM_DOC")
  engine=$(jq -r --arg role "$role" '.[$role].engine' <<< "$PREWARM_DOC")
  effort=$(jq -r --arg role "$role" '.[$role].effort' <<< "$PREWARM_DOC")
  dispatch_valid_surface_id "$surface" || die "invalid $role surface ID"
  case "$role" in design) expected_agent="$SLUG" ;; *) expected_agent="$SLUG-${role//_/-}" ;; esac
  [[ "$agent" == "$expected_agent" ]] || die "invalid $role agent"
  dispatch_valid_runner_name "$runner" || die "invalid $role runner"
  dispatch_valid_effort "$effort" "$engine" || die "invalid $role effort"
  registered_engine=$(jq -r --arg runner "$runner" \
    'first(.runners[]? | select(.name == $runner) | .engine) // empty' "$RUNNERS_FILE")
  [[ "$registered_engine" == "$engine" ]] || die "$role runner/engine mismatch"
  if jq -e --arg role "$role" '.[$role] | has("model")' >/dev/null 2>&1 <<< "$PREWARM_DOC"; then
    model=$(jq -r --arg role "$role" '.[$role].model' <<< "$PREWARM_DOC")
    dispatch_valid_model "$model" || die "invalid $role model"
  elif dispatch_model_required "$role" "$engine"; then
    die "$role model is required"
  fi
done

jq -e '[. as $d | ["design","design_review","exec","exec_review"][] |
  select($d[.] != null) | $d[.].surface_id] as $ids |
  ($ids | length) == ($ids | unique | length)' >/dev/null 2>&1 <<< "$PREWARM_DOC" \
  || die 'duplicate role surfaces'

TARGET_SURFACES=(); TARGET_AGENTS=(); SEEN_ROLES=' '
for role in "${ROLES[@]}"; do
  [[ "$SEEN_ROLES" != *" $role "* ]] || die "duplicate requested role '$role'"
  SEEN_ROLES="$SEEN_ROLES$role "
  jq -e --arg role "$role" 'has($role)' >/dev/null 2>&1 <<< "$PREWARM_DOC" \
    || die "requested role '$role' is absent"
  TARGET_SURFACES+=("$(jq -r --arg role "$role" '.[$role].surface_id' <<< "$PREWARM_DOC")")
  TARGET_AGENTS+=("$(jq -r --arg role "$role" '.[$role].agent' <<< "$PREWARM_DOC")")
done

LIVE_DOC=$("$CMUX_BIN" list-pane-surfaces --workspace "$WORKSPACE" 2>/dev/null) \
  || die 'cannot list workspace surfaces'
for surface in "${TARGET_SURFACES[@]}"; do
  grep -oE 'surface:[0-9]+' <<< "$LIVE_DOC" | grep -Fxq "$surface" \
    || die "target surface '$surface' is not owned by '$WORKSPACE'"
done

op_failed=0
for ((i=0; i<${#ROLES[@]}; i++)); do
  "$CMUX_BIN" close-surface --workspace "$WORKSPACE" --surface "${TARGET_SURFACES[$i]}" \
    >/dev/null 2>&1 || op_failed=1
  "$AGMSG_DIR/leave.sh" "$TEAM" "${TARGET_AGENTS[$i]}" >/dev/null 2>&1 || op_failed=1
done
[[ $op_failed -eq 0 ]] || die 'failed to reclaim one or more review roles'

PRUNE_ROLES_JSON=$(printf '%s\n' "${ROLES[@]}" | jq -R . | jq -s .)
tmp=$(mktemp "$PREWARM_FILE.XXXXXX") || die 'cannot create snapshot temp file'
if jq --argjson roles "$PRUNE_ROLES_JSON" 'reduce $roles[] as $role (. ; del(.[$role]))' \
     <<< "$PREWARM_DOC" > "$tmp"; then
  mv -- "$tmp" "$PREWARM_FILE" || { rm -f -- "$tmp"; die 'cannot publish pruned snapshot'; }
else
  rm -f -- "$tmp"
  die 'cannot write pruned snapshot'
fi
