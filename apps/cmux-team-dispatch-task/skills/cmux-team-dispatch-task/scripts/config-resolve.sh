#!/usr/bin/env bash
# config-resolve.sh — global / project / command-line settings をロール単位で解決する。

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./config-lib.sh
. "$SCRIPT_DIR/config-lib.sh"

die() { echo "config-resolve: $1" >&2; exit 2; }
die_read() { echo "config-resolve: $1" >&2; exit 1; }
warn() { echo "[warn] config-resolve: $1" >&2; }

PROJECT_ROOT=''
RUNNERS_FILE=''

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-root)
      [[ $# -ge 2 ]] || die '--project-root requires a directory'
      PROJECT_ROOT="$2"
      shift 2
      ;;
    --runners)
      [[ $# -ge 2 ]] || die '--runners requires a path'
      RUNNERS_FILE="$2"
      shift 2
      ;;
    --set)
      [[ $# -ge 2 ]] || die '--set requires role.field=value'
      override="$2"
      override_key="${override%%=*}"
      override_value="${override#*=}"
      [[ "$override" == *=* ]] || die "invalid --set '$override'"
      case "$override_key" in
        design.runner|design.model|design.effort|design_review.runner|design_review.model|design_review.effort|exec.runner|exec.model|exec.effort|exec_review.runner|exec_review.model|exec_review.effort)
          override_role="${override_key%%.*}"
          override_field="${override_key#*.}"
          printf -v "OVERRIDE_${override_role}_${override_field}" '%s' "$override_value"
          ;;
        *) die "invalid --set '$override'" ;;
      esac
      shift 2
      ;;
    *) die "unknown argument '$1'" ;;
  esac
done

[[ -n "$PROJECT_ROOT" ]] || die '--project-root is required'
[[ -d "$PROJECT_ROOT" ]] || die "project root is not a directory: $PROJECT_ROOT"
[[ -n "$RUNNERS_FILE" ]] || RUNNERS_FILE="$(dispatch_runners_file)"

CONFIG_HOME="$(dispatch_config_home)"
GLOBAL_CONFIG="$(dispatch_config_file)"
PROJECT_CONFIG="$(dispatch_project_config_file "$PROJECT_ROOT")"

validate_json_file() {
  local file="$1"
  local label="$2"
  [[ -r "$file" ]] || die_read "$label is not readable at $file"
  jq -e . "$file" >/dev/null 2>&1 || die_read "$label contains invalid JSON at $file"
}

[[ -e "$RUNNERS_FILE" ]] || die "runners.json not found at $RUNNERS_FILE; run the skill to perform first-run setup"
validate_json_file "$RUNNERS_FILE" 'runners.json'

GLOBAL_PRESENT=0
PROJECT_PRESENT=0
if [[ -e "$GLOBAL_CONFIG" ]]; then
  validate_json_file "$GLOBAL_CONFIG" 'global config.json'
  GLOBAL_PRESENT=1
fi
if [[ -e "$PROJECT_CONFIG" ]]; then
  validate_json_file "$PROJECT_CONFIG" 'project config.json'
  PROJECT_PRESENT=1
fi

layer_field_type() {
  local file="$1"
  local role="$2"
  local field="$3"
  jq -r --arg role "$role" --arg field "$field" '
    .runner as $runners
    | if ($runners | type) != "object" then empty
      elif ($runners[$role] | type) != "object" then empty
      elif ($runners[$role] | has($field)) then $runners[$role][$field] | type
      else empty
      end
  ' "$file"
}

layer_field_string() {
  local file="$1"
  local role="$2"
  local field="$3"
  jq -r --arg role "$role" --arg field "$field" '
    .runner as $runners
    | if ($runners | type) == "object" and ($runners[$role] | type) == "object"
         and ($runners[$role][$field] | type) == "string"
      then $runners[$role][$field]
      else empty
      end
  ' "$file"
}

# source ごとの候補を CANDIDATE_* にセットする。値の型違いも一つの無効レイヤーである。
next_candidate() {
  local source="$1"
  local role="$2"
  local field="$3"
  local override_name
  local file=''
  local value_type=''

  CANDIDATE_PRESENT=0
  CANDIDATE_VALUE=''
  case "$source" in
    override)
      override_name="OVERRIDE_${role}_${field}"
      if [[ -n "${!override_name+x}" ]]; then
        CANDIDATE_PRESENT=1
        CANDIDATE_VALUE="${!override_name}"
      fi
      ;;
    project)
      [[ "$PROJECT_PRESENT" -eq 1 ]] || return 0
      file="$PROJECT_CONFIG"
      ;;
    global)
      [[ "$GLOBAL_PRESENT" -eq 1 ]] || return 0
      file="$GLOBAL_CONFIG"
      ;;
  esac

  [[ -n "$file" ]] || return 0
  value_type="$(layer_field_type "$file" "$role" "$field")"
  [[ -n "$value_type" ]] || return 0
  if [[ "$value_type" != 'string' ]]; then
    warn "ignoring non-string $field for role '$role' in $source config"
    return 0
  fi
  CANDIDATE_PRESENT=1
  CANDIDATE_VALUE="$(layer_field_string "$file" "$role" "$field")"
}

runner_engine() {
  jq -r --arg runner "$1" '
    .runners?
    | if type == "array" then
        .[] | select((.name? == $runner) and (.engine? == "claude" or .engine? == "codex")) | .engine
      else empty
      end
  ' "$RUNNERS_FILE" | head -n 1
}

resolve_review_mode() {
  local source
  local file=''
  local value=''
  local value_type=''
  for source in project global; do
    case "$source" in
      project)
        [[ "$PROJECT_PRESENT" -eq 1 ]] || continue
        file="$PROJECT_CONFIG"
        ;;
      global)
        [[ "$GLOBAL_PRESENT" -eq 1 ]] || continue
        file="$GLOBAL_CONFIG"
        ;;
    esac
    value_type="$(jq -r 'if has("review_mode") then .review_mode | type else empty end' "$file")"
    if [[ "$value_type" != 'string' ]]; then
      [[ -n "$value_type" ]] && warn "ignoring non-string review_mode in $source config"
      continue
    fi
    value="$(jq -r '.review_mode' "$file")"
    case "$value" in
      on|off) printf '%s\n' "$value"; return 0 ;;
      *) warn "ignoring invalid review_mode '$value' in $source config" ;;
    esac
  done
  printf 'on\n'
}

resolve_runner() {
  local role="$1"
  local source
  local engine=''
  RESOLVED_RUNNER=''
  RESOLVED_ENGINE=''
  for source in override project global; do
    next_candidate "$source" "$role" runner
    [[ "$CANDIDATE_PRESENT" -eq 1 ]] || continue
    if ! dispatch_valid_runner_name "$CANDIDATE_VALUE"; then
      warn "ignoring invalid runner for role '$role' in $source config"
      continue
    fi
    engine="$(runner_engine "$CANDIDATE_VALUE")"
    if [[ -z "$engine" ]]; then
      warn "ignoring unknown runner '$CANDIDATE_VALUE' for role '$role' in $source config"
      continue
    fi
    RESOLVED_RUNNER="$CANDIDATE_VALUE"
    RESOLVED_ENGINE="$engine"
    return 0
  done
  return 1
}

resolve_model() {
  local role="$1"
  local engine="$2"
  local source
  RESOLVED_MODEL=''
  for source in override project global; do
    next_candidate "$source" "$role" model
    [[ "$CANDIDATE_PRESENT" -eq 1 ]] || continue
    if ! dispatch_valid_model "$CANDIDATE_VALUE"; then
      warn "ignoring invalid model for role '$role' in $source config"
      continue
    fi
    if [[ "$engine" == codex ]]; then
      case "$CANDIDATE_VALUE" in
        'opus[1m]'|sonnet|fable)
          warn "ignoring Claude model alias for codex role '$role' in $source config"
          continue
          ;;
      esac
    fi
    RESOLVED_MODEL="$CANDIDATE_VALUE"
    return 0
  done
  RESOLVED_MODEL="$(dispatch_default_model "$role" "$engine")"
}

resolve_effort() {
  local role="$1"
  local engine="$2"
  local source
  local normalized=''
  RESOLVED_EFFORT=''
  for source in override project global; do
    next_candidate "$source" "$role" effort
    [[ "$CANDIDATE_PRESENT" -eq 1 ]] || continue
    normalized="$(dispatch_normalize_effort "$CANDIDATE_VALUE")"
    if ! dispatch_valid_effort "$normalized" "$engine"; then
      warn "ignoring invalid effort for role '$role' in $source config"
      continue
    fi
    RESOLVED_EFFORT="$normalized"
    return 0
  done
  RESOLVED_EFFORT="$(dispatch_default_effort "$role")"
}

REVIEW_MODE="$(resolve_review_mode)"
if [[ "$REVIEW_MODE" == on ]]; then
  ACTIVE_ROLES='design design_review exec exec_review'
else
  ACTIVE_ROLES='design exec'
fi

ROLES_JSON='{}'
for role in $ACTIVE_ROLES; do
  resolve_runner "$role" || die "role '$role' has no usable runner; run the skill with --setup"
  runner="$RESOLVED_RUNNER"
  engine="$RESOLVED_ENGINE"
  resolve_model "$role" "$engine"
  model="$RESOLVED_MODEL"
  if [[ -z "$model" ]] && dispatch_model_required "$role" "$engine"; then
    die "role '$role' requires a model for runner '$runner'; run the skill with --setup"
  fi
  resolve_effort "$role" "$engine"
  effort="$RESOLVED_EFFORT"

  role_json="$(jq -n --arg runner "$runner" --arg engine "$engine" --arg effort "$effort" \
    '{runner:$runner, engine:$engine, effort:$effort}')"
  if [[ -n "$model" ]]; then
    role_json="$(jq --arg model "$model" '. + {model:$model}' <<<"$role_json")"
  fi
  ROLES_JSON="$(jq -n --arg role "$role" --argjson role_json "$role_json" --argjson roles "$ROLES_JSON" \
    '$roles + {($role): $role_json}')"
done

jq -n \
  --arg config_home "$CONFIG_HOME" \
  --arg global_config "$GLOBAL_CONFIG" \
  --arg project_config "$PROJECT_CONFIG" \
  --arg runners_file "$RUNNERS_FILE" \
  --arg review_mode "$REVIEW_MODE" \
  --argjson roles "$ROLES_JSON" \
  '{config_home:$config_home, global_config:$global_config, project_config:$project_config,
    runners_file:$runners_file, review_mode:$review_mode, roles:$roles}'
