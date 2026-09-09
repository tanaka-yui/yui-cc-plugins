#!/usr/bin/env bash
set -euo pipefail

# config-edit.sh — config.json を原子的に読み書きする。**手で jq を組み立ててはならない。**
#
# Usage: config-edit.sh --config <path> [--set <key>=<value>]... [--unset <key>]...
#        config-edit.sh --config <path> --get <key>
#        config-edit.sh --config <path> --show
#
# 扱えるキー:
#   review_mode                             on | off
#   roles.<role>.agent | .model | .effort   set / unset
#   roles.<role>                            unset 専用
#   roles                                   unset 専用
#
# 複数の変更は 1 つの jq 式と、同じ directory 内の mktemp + mv で反映する。
# **未知の第三者キーは保持する。**
#
# ★ cmux 版にあった `--runners` / `--engine` は無い。engine は agent そのものなので、
#   effort の検証に必要な engine は「同一バッチの agent → 既存 config の agent → 既定」
#   の順で必ず決まる。呼び出し側に engine を渡させる理由が無い。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./config-lib.sh
source "$SCRIPT_DIR/config-lib.sh"

die_usage() {
  echo "config-edit: $1" >&2
  echo 'Usage: config-edit.sh --config <path> [--set <key>=<value>]... [--unset <key>]...' >&2
  echo '       config-edit.sh --config <path> --get <key>' >&2
  echo '       config-edit.sh --config <path> --show' >&2
  exit 2
}

valid_role() { dispatch_all_role_names | grep -qxF "$1"; }

KEY_ROLE=""
KEY_FIELD=""

parse_role_field() {   # roles.<role>.<field>
  local key="$1" rest role field
  case "$key" in roles.*.*) ;; *) return 1 ;; esac
  rest="${key#roles.}"
  role="${rest%%.*}"
  field="${rest#*.}"
  [[ "$field" != *.* ]] || return 1
  valid_role "$role" || return 1
  case "$field" in agent|model|effort) ;; *) return 1 ;; esac
  KEY_ROLE="$role"; KEY_FIELD="$field"
}

parse_role() {   # roles.<role>
  local role
  case "$1" in roles.*) ;; *) return 1 ;; esac
  role="${1#roles.}"
  [[ "$role" != *.* ]] || return 1
  valid_role "$role" || return 1
  KEY_ROLE="$role"
}

key_kind() {
  case "$1" in
    review_mode) printf 'review_mode\n' ;;
    roles)     printf 'roles\n' ;;
    roles.*.*) parse_role_field "$1" && printf 'field\n' ;;
    roles.*)   parse_role "$1" && printf 'role\n' ;;
    *) return 1 ;;
  esac
}

CONFIG=""
GET_KEY=""
SHOW=0
MUTATE=0
OPS=(); KEYS=(); VALUES=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config) [[ $# -ge 2 ]] || die_usage '--config requires a value'; CONFIG="$2"; shift 2 ;;
    --set)
      [[ $# -ge 2 ]] || die_usage '--set requires <key>=<value>'
      case "$2" in *=*) ;; *) die_usage "--set must be <key>=<value>: $2" ;; esac
      OPS+=(set); KEYS+=("${2%%=*}"); VALUES+=("${2#*=}"); MUTATE=1; shift 2 ;;
    --unset)
      [[ $# -ge 2 ]] || die_usage '--unset requires a key'
      OPS+=(unset); KEYS+=("$2"); VALUES+=(""); MUTATE=1; shift 2 ;;
    --get)
      [[ $# -ge 2 ]] || die_usage '--get requires a key'
      [[ -z "$GET_KEY" ]] || die_usage '--get may be specified once'
      GET_KEY="$2"; shift 2 ;;
    --show) SHOW=1; shift ;;
    *) die_usage "unknown argument: $1" ;;
  esac
done

[[ -n "$CONFIG" ]] || die_usage '--config is required'
mode_count=$((MUTATE + SHOW))
[[ -n "$GET_KEY" ]] && mode_count=$((mode_count + 1))
[[ "$mode_count" -eq 1 ]] || die_usage 'specify exactly one of --set/--unset, --get, or --show'

if [[ -n "$GET_KEY" ]]; then
  kind=$(key_kind "$GET_KEY") || die_usage "unknown key: $GET_KEY"
  [[ "$kind" == field || "$kind" == review_mode ]] || die_usage "key is unset-only: $GET_KEY"
  [[ -f "$CONFIG" ]] || exit 0
  if [[ "$kind" == review_mode ]]; then GET_FILTER='.review_mode // empty'
  else parse_role_field "$GET_KEY"; GET_FILTER=".roles.$KEY_ROLE.$KEY_FIELD // empty"; fi
  if ! jq -r "$GET_FILTER" "$CONFIG" 2>/dev/null; then
    echo "config-edit: cannot read $CONFIG (invalid JSON?)" >&2; exit 1
  fi
  exit 0
fi

if [[ "$SHOW" -eq 1 ]]; then
  [[ -f "$CONFIG" ]] || { echo '{}'; exit 0; }
  if ! jq '.' "$CONFIG" 2>/dev/null; then
    echo "config-edit: cannot read $CONFIG (invalid JSON?)" >&2; exit 1
  fi
  exit 0
fi

if [[ -f "$CONFIG" ]] && ! jq -e 'type == "object"' "$CONFIG" >/dev/null 2>&1; then
  echo "config-edit: cannot read $CONFIG (invalid JSON?)" >&2; exit 1
fi

# 第 1 巡: キーと値を検証し、同一バッチの agent を覚える。
for index in "${!OPS[@]}"; do
  op="${OPS[$index]}"; key="${KEYS[$index]}"; value="${VALUES[$index]}"
  kind=$(key_kind "$key") || die_usage "unknown key: $key"
  [[ "$op" == set ]] || continue
  [[ "$kind" == field || "$kind" == review_mode ]] || die_usage "key is unset-only: $key"
  if [[ "$kind" == review_mode ]]; then
    dispatch_valid_review_mode "$value" || die_usage "invalid value for $key: $value"
    continue
  fi
  parse_role_field "$key"
  case "$KEY_FIELD" in
    agent)
      dispatch_valid_agent "$value" || die_usage "invalid value for $key: $value"
      printf -v "SET_AGENT_$KEY_ROLE" '%s' "$value" ;;
    model)
      dispatch_valid_model "$value" || die_usage "invalid value for $key: $value" ;;
    effort) ;;
  esac
done

# 第 2 巡: effort は agent が決まってからでないと検証できないので、別巡で正規化する。
for index in "${!OPS[@]}"; do
  [[ "${OPS[$index]}" == set ]] || continue
  key="${KEYS[$index]}"
  kind=$(key_kind "$key"); [[ "$kind" == field ]] || continue
  parse_role_field "$key"; [[ "$KEY_FIELD" == effort ]] || continue

  agent_var="SET_AGENT_$KEY_ROLE"; agent="${!agent_var-}"
  if [[ -z "$agent" && -f "$CONFIG" ]]; then
    agent=$(jq -r --arg r "$KEY_ROLE" '.roles[$r].agent // empty' "$CONFIG" 2>/dev/null || true)
  fi
  [[ -n "$agent" ]] || agent="$(dispatch_default_agent)"
  effort=$(dispatch_normalize_effort "${VALUES[$index]}")
  if dispatch_known_agent "$agent"; then
    dispatch_valid_effort "$effort" "$agent" || die_usage "invalid value for $key: ${VALUES[$index]}"
  else
    # 未知の agent の許容値は分からない。shell-safe だけ確かめ、判定は Orca に委ねる。
    dispatch_valid_model "$effort" || die_usage "invalid value for $key: ${VALUES[$index]}"
    echo "config-edit: cannot validate effort for unknown agent '$agent'; storing it as-is" >&2
  fi
  VALUES[$index]="$effort"
done

FILTER=""
JQ_ARGS=()
ARG_INDEX=0
for index in "${!OPS[@]}"; do
  op="${OPS[$index]}"; key="${KEYS[$index]}"; kind=$(key_kind "$key")
  if [[ "$op" == set ]]; then
    ARG_INDEX=$((ARG_INDEX + 1))
    JQ_ARGS+=(--arg "v$ARG_INDEX" "${VALUES[$index]}")
    if [[ "$kind" == review_mode ]]; then
      action=".review_mode = \$v$ARG_INDEX"
    else
      parse_role_field "$key"
      action=".roles.$KEY_ROLE.$KEY_FIELD = \$v$ARG_INDEX"
    fi
  else
    case "$kind" in
      review_mode) action='del(.review_mode)' ;;
      roles) action='del(.roles)' ;;
      role)  parse_role "$key";       action="del(.roles.$KEY_ROLE)" ;;
      field) parse_role_field "$key"; action="del(.roles.$KEY_ROLE.$KEY_FIELD)" ;;
    esac
  fi
  FILTER="${FILTER:+$FILTER | }$action"
done

mkdir -p "$(dirname "$CONFIG")"
if ! TMP=$(mktemp "$CONFIG.XXXXXX"); then
  echo 'config-edit: mktemp failed; nothing was written' >&2; exit 1
fi

jq_ok=0
if [[ -f "$CONFIG" ]]; then
  jq ${JQ_ARGS[@]+"${JQ_ARGS[@]}"} "$FILTER" "$CONFIG" > "$TMP" 2>/dev/null || jq_ok=1
else
  jq -n ${JQ_ARGS[@]+"${JQ_ARGS[@]}"} "{} | $FILTER" > "$TMP" 2>/dev/null || jq_ok=1
fi

if [[ "$jq_ok" -ne 0 ]]; then
  rm -f "$TMP"
  echo "config-edit: write failed (existing config broken?); $CONFIG is unchanged" >&2
  exit 1
fi

mv "$TMP" "$CONFIG"
