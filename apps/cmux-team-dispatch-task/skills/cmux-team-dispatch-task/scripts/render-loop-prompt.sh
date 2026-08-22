#!/usr/bin/env bash
# 無人 issue ループ用の完全なタスクプロンプトを決定的に組み立てる。
set -euo pipefail

die() { echo "Error: $1" >&2; exit 1; }
log() { echo "[$1] $2" >&2; }
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REF_DIR="$(cd "$SCRIPT_DIR/../references/unattended" && pwd)"
# shellcheck source=./config-lib.sh
source "$SCRIPT_DIR/config-lib.sh"

SLUG=""; ISSUE=""; TITLE=""; URL=""; BODY_FILE=""; PLAN_HINT=""; PREWARM_FILE=""
STATUS=""; SENTINEL=""; TEAM=""; LAYOUT=""; PARENT_WS=""; PARENT_SF=""; SKILL_DIR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --slug) [[ $# -ge 2 ]] || die "--slug requires a value"; SLUG="$2"; shift 2 ;;
    --issue) [[ $# -ge 2 ]] || die "--issue requires a value"; ISSUE="$2"; shift 2 ;;
    --issue-title) [[ $# -ge 2 ]] || die "--issue-title requires a value"; TITLE="$2"; shift 2 ;;
    --issue-url) [[ $# -ge 2 ]] || die "--issue-url requires a value"; URL="$2"; shift 2 ;;
    --issue-body-file) [[ $# -ge 2 ]] || die "--issue-body-file requires a value"; BODY_FILE="$2"; shift 2 ;;
    --plan-hint) [[ $# -ge 2 ]] || die "--plan-hint requires a value"; PLAN_HINT="$2"; shift 2 ;;
    --prewarm) [[ $# -ge 2 ]] || die "--prewarm requires a path"; PREWARM_FILE="$2"; shift 2 ;;
    --status-dir) [[ $# -ge 2 ]] || die "--status-dir requires a value"; STATUS="$2"; shift 2 ;;
    --timeout-sentinel) [[ $# -ge 2 ]] || die "--timeout-sentinel requires a value"; SENTINEL="$2"; shift 2 ;;
    --team) [[ $# -ge 2 ]] || die "--team requires a value"; TEAM="$2"; shift 2 ;;
    --layout) [[ $# -ge 2 ]] || die "--layout requires a value"; LAYOUT="$2"; shift 2 ;;
    --parent-workspace) [[ $# -ge 2 ]] || die "--parent-workspace requires a value"; PARENT_WS="$2"; shift 2 ;;
    --parent-surface) [[ $# -ge 2 ]] || die "--parent-surface requires a value"; PARENT_SF="$2"; shift 2 ;;
    --skill-dir) [[ $# -ge 2 ]] || die "--skill-dir requires a value"; SKILL_DIR="$2"; shift 2 ;;
    --design-runner|--design-engine|--exec-runner|--exec-engine|--review|--review-model|--review-runner|--review-engine|--review-pane-agent|--exec-choice)
      die "$1 was removed: pass the validated prewarm snapshot with --prewarm instead" ;;
    *) die "unknown option: $1" ;;
  esac
done

for value in "$SLUG" "$ISSUE" "$TITLE" "$URL" "$BODY_FILE" "$PLAN_HINT" "$PREWARM_FILE" \
  "$STATUS" "$SENTINEL" "$TEAM" "$LAYOUT" "$PARENT_WS" "$SKILL_DIR"; do
  [[ -n "$value" ]] || die "required argument is missing"
done
[[ -f "$BODY_FILE" ]] || die "--issue-body-file not found"

# Read once, then validate and extract only from the immutable local snapshot.
PREWARM_DOC=$(cat "$PREWARM_FILE") || die "cannot read --prewarm file"
jq -e 'type' >/dev/null 2>&1 <<< "$PREWARM_DOC" || die "prewarm snapshot is not valid JSON"
RUNNERS_FILE="$(dispatch_runners_file)"
[[ -f "$RUNNERS_FILE" ]] || die "runners.json not found at $RUNNERS_FILE"
jq -e '.runners | type == "array"' "$RUNNERS_FILE" >/dev/null 2>&1 \
  || die "invalid runners.json at $RUNNERS_FILE"

validate_prewarm_snapshot() {
  local bad_top review_mode role runner engine effort model runner_engine expected_agent
  jq -e 'type == "object"' >/dev/null 2>&1 <<< "$PREWARM_DOC" \
    || die "invalid prewarm: top-level JSON value must be an object"
  bad_top=$(jq -r '[keys[] | select(. != "workspace_id" and . != "review_mode" and
    . != "design" and . != "design_review" and . != "exec" and . != "exec_review")] | first // empty' \
    <<< "$PREWARM_DOC")
  [[ -z "$bad_top" ]] || die "invalid prewarm top-level key '$bad_top'"
  jq -e '.workspace_id | type == "string" and length > 0' >/dev/null 2>&1 <<< "$PREWARM_DOC" \
    || die "invalid prewarm workspace_id"
  review_mode=$(jq -r '.review_mode // empty' <<< "$PREWARM_DOC")
  [[ "$review_mode" == on || "$review_mode" == off ]] || die "invalid prewarm review_mode"
  jq -e 'has("design") and has("exec")' >/dev/null 2>&1 <<< "$PREWARM_DOC" \
    || die "invalid prewarm: design and exec roles are required"

  for role in design design_review exec exec_review; do
    jq -e --arg role "$role" 'has($role)' >/dev/null 2>&1 <<< "$PREWARM_DOC" || continue
    jq -e --arg role "$role" '
      (.[$role] | type == "object") and
      ((.[$role] | keys - ["surface_id","agent","runner","engine","model","effort","wired"]) | length == 0) and
      (.[$role] | has("surface_id") and has("agent") and has("runner") and has("engine") and has("effort") and has("wired")) and
      (.[$role].surface_id | type == "string" and length > 0) and
      (.[$role].agent | type == "string" and length > 0) and
      (.[$role].runner | type == "string") and (.[$role].engine | type == "string") and
      (.[$role].effort | type == "string") and (.[$role].wired | type == "boolean" and . == true)' \
      >/dev/null 2>&1 <<< "$PREWARM_DOC" || die "invalid prewarm tuple for $role"

    case "$role" in
      design) expected_agent="$SLUG" ;;
      *) expected_agent="$SLUG-${role//_/-}" ;;
    esac
    [[ $(jq -r --arg role "$role" '.[$role].agent' <<< "$PREWARM_DOC") == "$expected_agent" ]] \
      || die "invalid agent for prewarm role $role"
    runner=$(jq -r --arg role "$role" '.[$role].runner' <<< "$PREWARM_DOC")
    engine=$(jq -r --arg role "$role" '.[$role].engine' <<< "$PREWARM_DOC")
    effort=$(jq -r --arg role "$role" '.[$role].effort' <<< "$PREWARM_DOC")
    dispatch_valid_runner_name "$runner" || die "invalid runner name for prewarm role $role"
    dispatch_valid_effort "$effort" "$engine" || die "invalid effort for prewarm role $role"
    runner_engine=$(jq -r --arg runner "$runner" \
      'first(.runners[]? | select(.name == $runner) | .engine) // empty' "$RUNNERS_FILE")
    [[ -n "$runner_engine" ]] || die "runner '$runner' for prewarm role $role is not registered"
    [[ "$runner_engine" == "$engine" ]] || die "engine mismatch for prewarm role $role"

    if jq -e --arg role "$role" '.[$role] | has("model")' >/dev/null 2>&1 <<< "$PREWARM_DOC"; then
      jq -e --arg role "$role" '.[$role].model | type == "string" and length > 0' \
        >/dev/null 2>&1 <<< "$PREWARM_DOC" || die "invalid model for prewarm role $role"
      model=$(jq -r --arg role "$role" '.[$role].model' <<< "$PREWARM_DOC")
      dispatch_valid_model "$model" || die "invalid model for prewarm role $role"
    elif dispatch_model_required "$role" "$engine"; then
      die "model is required for prewarm role $role with engine $engine"
    fi
  done
}

validate_prewarm_snapshot
role_value() { jq -r --arg role "$1" --arg field "$2" '.[$role][$field] // empty' <<< "$PREWARM_DOC"; }
role_present() { jq -e --arg role "$1" 'has($role)' >/dev/null 2>&1 <<< "$PREWARM_DOC"; }

REVIEW_MODE=$(jq -r '.review_mode' <<< "$PREWARM_DOC")
DESIGN_RUNNER=$(role_value design runner); DESIGN_ENGINE=$(role_value design engine)
EXEC_RUNNER=$(role_value exec runner); EXEC_ENGINE=$(role_value exec engine)
phase=$(cat "$REF_DIR/phase-block-$DESIGN_ENGINE.md")

printf 'Task slug: %s\nIssue: #%s — %s\nURL: %s\nDesign runner: %s\nDesign engine: %s\nExec runner: %s\nExec engine: %s\n' \
  "$SLUG" "$ISSUE" "$TITLE" "$URL" "$DESIGN_RUNNER" "$DESIGN_ENGINE" "$EXEC_RUNNER" "$EXEC_ENGINE"
for role in design_review exec_review; do
  role_present "$role" || continue
  case "$role" in
    design_review) label='Design review' ;;
    exec_review) label='Exec review' ;;
  esac
  printf '%s agent: %s\n%s runner: %s\n%s engine: %s\n%s model: %s\n%s effort: %s\n' \
    "$label" "$(role_value "$role" agent)" "$label" "$(role_value "$role" runner)" \
    "$label" "$(role_value "$role" engine)" "$label" "$(role_value "$role" model)" \
    "$label" "$(role_value "$role" effort)"
done

printf '\n%s\nCommon unattended rules: do not infer the review or execution role from the design engine. Do not request interactive input; record unresolved decisions in the result.\nPhase B: delegate implementation to the configured execution role above. Mark that role as the status owner before delivery. Deliver the complete execution request with ONE call to `~/.agents/skills/agmsg/scripts/send.sh` passing four arguments: the team, your own agent name, the agmsg agent name of the selected pane, and the body prefixed with phase-b-exec: as a single quoted argument. The destination is an agmsg agent name, never a pane surface, and a non-zero exit means the pane was NOT told. Never type it into a pane yourself.\n\nIssue body:\n' "$phase"
cat "$BODY_FILE"
printf '\n\nPlan hint: %s\nStatus directory: %s\nTimeout sentinel: %s\nTeam: %s\nLayout: %s\nParent workspace: %s\nSkill directory: %s\n' "$PLAN_HINT" "$STATUS" "$SENTINEL" "$TEAM" "$LAYOUT" "$PARENT_WS" "$SKILL_DIR"
printf '\nSTATUS PROTOCOL: immediately write %s/status.json with status=executing. On completion, write status=done or status=error and write %s/result.md. Preserve an existing pr_url. If the timeout sentinel exists, do not write status. For PR integration include Closes #%s.\n' "$STATUS" "$STATUS" "$ISSUE"
printf 'Before delegating, inspect %s/prewarm.json, touch .assigned-<selected-pane>, send the complete request text, and touch .deferred when a child owns status. Spawn fallback must pass --unattended and --timeout-sentinel %s.\n' "$STATUS" "$SENTINEL"
[[ -n "$PARENT_SF" ]] && printf 'Parent surface: %s\n' "$PARENT_SF"

if role_present design_review; then
  printf '\nPhase A-R — design-review\nAgent: %s\nRunner: %s\nEngine: %s\nModel: %s\nEffort: %s\n\n' \
    "$(role_value design_review agent)" "$(role_value design_review runner)" \
    "$(role_value design_review engine)" "$(role_value design_review model)" \
    "$(role_value design_review effort)"
  cat "$REF_DIR/review-block.md"
elif [[ "$REVIEW_MODE" == on ]]; then
  log warn "render-loop-prompt: review_mode is on but role 'design_review' is absent from prewarm.json; its review gate will be skipped"
fi
if role_present exec_review; then
  printf '\nPhase B-R — exec-review\nAgent: %s\nRunner: %s\nEngine: %s\nModel: %s\nEffort: %s\n\n' \
    "$(role_value exec_review agent)" "$(role_value exec_review runner)" \
    "$(role_value exec_review engine)" "$(role_value exec_review model)" \
    "$(role_value exec_review effort)"
  cat "$REF_DIR/code-review-block.md"
elif [[ "$REVIEW_MODE" == on ]]; then
  log warn "render-loop-prompt: review_mode is on but role 'exec_review' is absent from prewarm.json; its review gate will be skipped"
fi
