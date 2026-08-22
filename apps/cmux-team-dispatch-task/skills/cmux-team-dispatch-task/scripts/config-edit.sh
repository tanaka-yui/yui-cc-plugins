#!/usr/bin/env bash
set -euo pipefail

# config-edit.sh — 4 ロールの config.json を原子的に読み書きする。
#
# Usage: config-edit.sh --config <path> [--runners <path>] [--engine <role>=<engine>]...
#                       [--set <key>=<value>]... [--unset <key>]...
#        config-edit.sh --config <path> --get <key>
#        config-edit.sh --config <path> --show
#
# 扱えるキー:
#   review_mode                         on | off
#   runner.<role>.runner | .model | .effort
#   runner.<role> / runner              --unset 専用
#
# 複数の変更は一つの jq 式と同じ directory 内の mv で反映する。未知の第三者キーは
# 保持する。effort の engine は、同一バッチの runner、--engine、既存 config の
# runner の順に runners.json から解決する。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/config-lib.sh"

die_usage() {
  echo "config-edit: $1" >&2
  echo 'Usage: config-edit.sh --config <path> [--runners <path>] [--engine <role>=<engine>]...' >&2
  echo '                      [--set <key>=<value>]... [--unset <key>]...' >&2
  echo '       config-edit.sh --config <path> --get <key>' >&2
  echo '       config-edit.sh --config <path> --show' >&2
  exit 2
}

valid_role() {
  local role
  while IFS= read -r role; do
    [[ "$role" == "$1" ]] && return 0
  done < <(dispatch_role_names)
  return 1
}

KEY_ROLE=""
KEY_FIELD=""

parse_runner_field() {
  local key="$1"
  case "$key" in
    runner.*.*)
      role="${key#runner.}"
      field="${role#*.}"
      role="${role%%.*}"
      valid_role "$role" || return 1
      case "$field" in runner|model|effort) ;; *) return 1 ;; esac
      KEY_ROLE="$role"
      KEY_FIELD="$field"
      return 0
      ;;
    *) return 1 ;;
  esac
}

parse_runner_role() {
  local role
  case "$1" in
    runner.*)
      role="${1#runner.}"
      [[ "$role" != *.* ]] || return 1
      valid_role "$role" || return 1
      KEY_ROLE="$role"
      return 0
      ;;
    *) return 1 ;;
  esac
}

key_kind() {
  case "$1" in
    review_mode) printf 'review_mode\n' ;;
    runner) printf 'runner\n' ;;
    runner.*.*) parse_runner_field "$1" && printf 'field\n' ;;
    runner.*) parse_runner_role "$1" && printf 'role\n' ;;
    *) return 1 ;;
  esac
}

runner_engine() {
  local engine
  [[ -f "$RUNNERS" ]] || return 1
  engine=$(jq -r --arg name "$1" \
    '[.runners[]? | select(type == "object" and .name == $name) | .engine][0] // empty' "$RUNNERS" 2>/dev/null) \
    || return 1
  case "$engine" in claude|codex) printf '%s\n' "$engine" ;; *) return 1 ;; esac
}

CONFIG=""
RUNNERS="$(dispatch_runners_file)"
GET_KEY=""
SHOW=0
MUTATE=0
OPS=()
KEYS=()
VALUES=()
ENGINE_ROLES=()
ENGINE_VALUES=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)
      [[ $# -ge 2 ]] || die_usage '--config requires a value'
      CONFIG="$2"
      shift 2
      ;;
    --runners)
      [[ $# -ge 2 ]] || die_usage '--runners requires a value'
      RUNNERS="$2"
      shift 2
      ;;
    --engine)
      [[ $# -ge 2 ]] || die_usage '--engine requires <role>=<engine>'
      case "$2" in *=*) ;; *) die_usage "--engine must be <role>=<engine>: $2" ;; esac
      ENGINE_ROLES+=("${2%%=*}")
      ENGINE_VALUES+=("${2#*=}")
      shift 2
      ;;
    --set)
      [[ $# -ge 2 ]] || die_usage '--set requires <key>=<value>'
      case "$2" in *=*) ;; *) die_usage "--set must be <key>=<value>: $2" ;; esac
      OPS+=(set)
      KEYS+=("${2%%=*}")
      VALUES+=("${2#*=}")
      MUTATE=1
      shift 2
      ;;
    --unset)
      [[ $# -ge 2 ]] || die_usage '--unset requires a key'
      OPS+=(unset)
      KEYS+=("$2")
      VALUES+=("")
      MUTATE=1
      shift 2
      ;;
    --get)
      [[ $# -ge 2 ]] || die_usage '--get requires a key'
      [[ -z "$GET_KEY" ]] || die_usage '--get may be specified once'
      GET_KEY="$2"
      shift 2
      ;;
    --show)
      SHOW=1
      shift
      ;;
    *) die_usage "unknown argument: $1" ;;
  esac
done

[[ -n "$CONFIG" ]] || die_usage '--config is required'
mode_count=$((MUTATE + SHOW))
[[ -n "$GET_KEY" ]] && mode_count=$((mode_count + 1))
[[ "$mode_count" -eq 1 ]] || die_usage 'specify exactly one of --set/--unset, --get, or --show'

if [[ -n "$GET_KEY" ]]; then
  kind=$(key_kind "$GET_KEY") || die_usage "unknown key: $GET_KEY"
  [[ "$kind" == review_mode || "$kind" == field ]] || die_usage "key is unset-only: $GET_KEY"
  [[ -f "$CONFIG" ]] || exit 0
  if [[ "$kind" == field ]]; then
    parse_runner_field "$GET_KEY"
    filter=".runner.$KEY_ROLE.$KEY_FIELD // empty"
  else
    filter='.review_mode // empty'
  fi
  if ! jq -r "$filter" "$CONFIG" 2>/dev/null; then
    echo "config-edit: cannot read $CONFIG (invalid JSON?)" >&2
    exit 1
  fi
  exit 0
fi

if [[ "$SHOW" -eq 1 ]]; then
  if [[ ! -f "$CONFIG" ]]; then
    echo '{}'
    exit 0
  fi
  if ! jq '.' "$CONFIG" 2>/dev/null; then
    echo "config-edit: cannot read $CONFIG (invalid JSON?)" >&2
    exit 1
  fi
  exit 0
fi

if [[ -f "$CONFIG" ]] && ! jq -e 'type == "object"' "$CONFIG" >/dev/null 2>&1; then
  echo "config-edit: cannot read $CONFIG (invalid JSON?)" >&2
  exit 1
fi

for index in "${!ENGINE_ROLES[@]}"; do
  role="${ENGINE_ROLES[$index]}"
  engine="${ENGINE_VALUES[$index]}"
  valid_role "$role" || die_usage "unknown role for --engine: $role"
  case "$engine" in claude|codex) ;; *) die_usage "invalid engine for role '$role': $engine" ;; esac
  printf -v "ENGINE_$role" '%s' "$engine"
done

for index in "${!OPS[@]}"; do
  op="${OPS[$index]}"
  key="${KEYS[$index]}"
  value="${VALUES[$index]}"
  kind=$(key_kind "$key") || die_usage "unknown key: $key"
  if [[ "$op" == set ]]; then
    [[ "$kind" == review_mode || "$kind" == field ]] || die_usage "key is unset-only: $key"
    if [[ "$kind" == review_mode ]]; then
      [[ "$value" == on || "$value" == off ]] || die_usage "invalid value for $key: $value"
      continue
    fi
    parse_runner_field "$key"
    case "$KEY_FIELD" in
      runner)
        dispatch_valid_runner_name "$value" || die_usage "invalid value for $key: $value"
        printf -v "SET_RUNNER_$KEY_ROLE" '%s' "$value"
        ;;
      model)
        dispatch_valid_model "$value" || die_usage "invalid value for $key: $value"
        ;;
      effort) ;;
    esac
  fi
done

for index in "${!OPS[@]}"; do
  [[ "${OPS[$index]}" == set ]] || continue
  key="${KEYS[$index]}"
  kind=$(key_kind "$key")
  [[ "$kind" == field ]] || continue
  parse_runner_field "$key"
  [[ "$KEY_FIELD" == effort ]] || continue

  runner_var="SET_RUNNER_$KEY_ROLE"
  runner="${!runner_var-}"
  engine=""
  [[ -n "$runner" ]] && engine=$(runner_engine "$runner" || true)
  if [[ -z "$engine" ]]; then
    engine_var="ENGINE_$KEY_ROLE"
    engine="${!engine_var-}"
  fi
  if [[ -z "$engine" && -f "$CONFIG" ]]; then
    runner=$(jq -r --arg role "$KEY_ROLE" '.runner[$role].runner // empty' "$CONFIG")
    [[ -n "$runner" ]] && engine=$(runner_engine "$runner" || true)
  fi
  [[ -n "$engine" ]] || die_usage "cannot determine the engine for role '$KEY_ROLE'; pass --engine <role>=<claude|codex>"
  effort=$(dispatch_normalize_effort "${VALUES[$index]}")
  dispatch_valid_effort "$effort" "$engine" || die_usage "invalid value for $key: ${VALUES[$index]}"
  VALUES[$index]="$effort"
done

FILTER=""
JQ_ARGS=()
ARG_INDEX=0
for index in "${!OPS[@]}"; do
  op="${OPS[$index]}"
  key="${KEYS[$index]}"
  kind=$(key_kind "$key")
  if [[ "$op" == set ]]; then
    ARG_INDEX=$((ARG_INDEX + 1))
    JQ_ARGS+=(--arg "v$ARG_INDEX" "${VALUES[$index]}")
    if [[ "$kind" == review_mode ]]; then
      action=".review_mode = \$v$ARG_INDEX"
    else
      parse_runner_field "$key"
      action=".runner.$KEY_ROLE.$KEY_FIELD = \$v$ARG_INDEX"
    fi
  else
    case "$kind" in
      review_mode) action='del(.review_mode)' ;;
      runner) action='del(.runner)' ;;
      role)
        parse_runner_role "$key"
        action="del(.runner.$KEY_ROLE)"
        ;;
      field)
        parse_runner_field "$key"
        action="del(.runner.$KEY_ROLE.$KEY_FIELD)"
        ;;
    esac
  fi
  FILTER="${FILTER:+$FILTER | }$action"
done

mkdir -p "$(dirname "$CONFIG")"
if ! TMP=$(mktemp "$CONFIG.XXXXXX"); then
  echo 'config-edit: mktemp failed; nothing was written' >&2
  exit 1
fi

if [[ -f "$CONFIG" ]]; then
  jq_ok=0
  jq ${JQ_ARGS[@]+"${JQ_ARGS[@]}"} "$FILTER" "$CONFIG" > "$TMP" 2>/dev/null || jq_ok=1
else
  jq_ok=0
  jq -n ${JQ_ARGS[@]+"${JQ_ARGS[@]}"} "{} | $FILTER" > "$TMP" 2>/dev/null || jq_ok=1
fi

if [[ "$jq_ok" -ne 0 ]]; then
  rm -f "$TMP"
  echo "config-edit: write failed (existing config broken?); $CONFIG is unchanged" >&2
  exit 1
fi

mv "$TMP" "$CONFIG"
