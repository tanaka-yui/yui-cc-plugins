#!/usr/bin/env bash
# config-resolve.sh — global / project / コマンドラインの設定をロール単位で解決し JSON で出す。
#
# Usage: config-resolve.sh --project-root <path> [--review-mode <on|off>] [--phase-b <on|off>]
#                          [--integration <merge|pr>] [--setup <skip|run>]
#                          [--design-mode <direct|plan|brainstorm>]
#                          [--set <role>.<field>=<value>]...
# Exit:  0 = 解決した / 1 = 設定が読めない / 2 = 使用法エラー
#
# 優先順位は override > project > global。**設定ファイルが 1 つも無いのは正常**で、
# その場合 agent だけが既定 (claude) になり、model と effort は出力に現れない。
#
# ★ **model と effort は設定されたときだけ出す。**未設定を既定値で埋めない。
#   worker-start は `--model` を省けば Orca 側の既定を使う。ここで既定を捏造すると、
#   設定していない利用者の挙動が黙って変わる。

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./config-lib.sh
. "$SCRIPT_DIR/config-lib.sh"

die()      { echo "config-resolve: $1" >&2; exit 2; }
die_read() { echo "config-resolve: $1" >&2; exit 1; }
warn()     { echo "[warn] config-resolve: $1" >&2; }

PROJECT_ROOT=''
OVERRIDE_review_mode=''
OVERRIDE_phase_b=''
OVERRIDE_integration=''
OVERRIDE_setup=''
OVERRIDE_design_mode=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-root)
      [[ $# -ge 2 ]] || die '--project-root requires a directory'
      PROJECT_ROOT="$2"; shift 2 ;;
    --set)
      [[ $# -ge 2 ]] || die '--set requires <role>.<field>=<value>'
      [[ "$2" == *=* ]] || die "invalid --set '$2'"
      ov_key="${2%%=*}"; ov_value="${2#*=}"
      [[ "$ov_key" == *.* ]] || die "invalid --set '$2'"
      ov_role="${ov_key%%.*}"; ov_field="${ov_key#*.}"
      dispatch_all_role_names | grep -qxF "$ov_role" || die "unknown role in --set: $ov_role"
      case "$ov_field" in agent|model|effort) ;; *) die "unknown field in --set: $ov_field" ;; esac
      printf -v "OVERRIDE_${ov_role}_${ov_field}" '%s' "$ov_value"
      shift 2 ;;
    --review-mode)
      [[ $# -ge 2 ]] || die '--review-mode requires on or off'
      dispatch_valid_review_mode "$2" || die "invalid --review-mode: $2"
      OVERRIDE_review_mode="$2"; shift 2 ;;
    --phase-b)
      [[ $# -ge 2 ]] || die '--phase-b requires on or off'
      dispatch_valid_phase_b "$2" || die "invalid --phase-b: $2"
      OVERRIDE_phase_b="$2"; shift 2 ;;
    --integration)
      [[ $# -ge 2 ]] || die '--integration requires merge or pr'
      dispatch_valid_integration "$2" || die "invalid --integration: $2"
      OVERRIDE_integration="$2"; shift 2 ;;
    --setup)
      [[ $# -ge 2 ]] || die '--setup requires skip or run'
      dispatch_valid_setup "$2" || die "invalid --setup: $2"
      OVERRIDE_setup="$2"; shift 2 ;;
    --design-mode)
      [[ $# -ge 2 ]] || die '--design-mode requires direct, plan or brainstorm'
      dispatch_valid_design_mode "$2" || die "invalid --design-mode: $2"
      OVERRIDE_design_mode="$2"; shift 2 ;;
    *) die "unknown argument '$1'" ;;
  esac
done

[[ -n "$PROJECT_ROOT" ]] || die '--project-root is required'
[[ -d "$PROJECT_ROOT" ]] || die "project root is not a directory: $PROJECT_ROOT"

CONFIG_HOME="$(dispatch_config_home)"
GLOBAL_CONFIG="$(dispatch_config_file)"
PROJECT_CONFIG="$(dispatch_project_config_file "$PROJECT_ROOT")"

# ★ **壊れた設定を「無い」と読まない。**握り潰すと、利用者が書いたはずの model が
#   黙って効かないまま dispatch が走る。読めなければ止める。
GLOBAL_PRESENT=0; PROJECT_PRESENT=0
check_layer() {   # $1=path $2=label -> 0=使う 1=無い
  [[ -e "$1" ]] || return 1
  [[ -r "$1" ]] || die_read "$2 is not readable at $1"
  jq -e 'type == "object"' "$1" >/dev/null 2>&1 || die_read "$2 is not a JSON object at $1"
  return 0
}
check_layer "$GLOBAL_CONFIG"  'global config.json'  && GLOBAL_PRESENT=1
check_layer "$PROJECT_CONFIG" 'project config.json' && PROJECT_PRESENT=1

# ★ **「ファイルが在る」と「設定されている」は別。**第三者キーだけを持つ config.json は
#   この skill にとって未設定である。First-run の問いかけはこちらで判定する。
CONFIGURED=0
# review_mode だけを設定した利用者にも S0 を二度と尋ねない。所有キーのどれかが在れば設定済み。
has_ours() { [[ -f "$1" ]] && jq -e \
  '((.roles | type) == "object" and (.roles | length) > 0)
   or (.review_mode | type) == "string" or (.phase_b | type) == "string"
   or (.integration | type) == "string" or (.setup | type) == "string"
   or (.design_mode | type) == "string"' \
  "$1" >/dev/null 2>&1; }
{ has_ours "$GLOBAL_CONFIG" || has_ours "$PROJECT_CONFIG"; } && CONFIGURED=1

# 型違いは「その層に無い」ではなく「その層が無効」である。警告して次の層へ落とす。
# ★ 型と値を別々の jq で取る。1 つの出力に番兵を混ぜると、利用者がその番兵を
#   そのまま値に書いたときに区別できなくなる。
layer_type() {   # $1=file $2=role $3=field ; 出力: 型名 / 空 = 不在
  jq -r --arg role "$2" --arg field "$3" '
    if (.roles | type) == "object" and (.roles[$role] | type) == "object"
       and (.roles[$role] | has($field))
    then (.roles[$role][$field] | type) else empty end' "$1" 2>/dev/null
}
layer_string() {   # $1=file $2=role $3=field
  jq -r --arg role "$2" --arg field "$3" '.roles[$role][$field]' "$1" 2>/dev/null
}

CANDIDATE_PRESENT=0; CANDIDATE_VALUE=''
next_candidate() {   # $1=source $2=role $3=field
  local source="$1" role="$2" field="$3" name file='' vtype
  CANDIDATE_PRESENT=0; CANDIDATE_VALUE=''
  case "$source" in
    override)
      name="OVERRIDE_${role}_${field}"
      if [[ -n "${!name+x}" ]]; then CANDIDATE_PRESENT=1; CANDIDATE_VALUE="${!name}"; fi
      return 0 ;;
    project) [[ "$PROJECT_PRESENT" -eq 1 ]] || return 0; file="$PROJECT_CONFIG" ;;
    global)  [[ "$GLOBAL_PRESENT"  -eq 1 ]] || return 0; file="$GLOBAL_CONFIG"  ;;
  esac
  vtype="$(layer_type "$file" "$role" "$field")"
  [[ -n "$vtype" ]] || return 0
  if [[ "$vtype" != string ]]; then
    warn "ignoring non-string $field for role '$role' in $source config"
    return 0
  fi
  CANDIDATE_PRESENT=1; CANDIDATE_VALUE="$(layer_string "$file" "$role" "$field")"
}

resolve_agent() {   # $1=role -> RESOLVED_AGENT (必ず埋まる)
  local role="$1" source
  RESOLVED_AGENT=''
  for source in override project global; do
    next_candidate "$source" "$role" agent
    [[ "$CANDIDATE_PRESENT" -eq 1 ]] || continue
    if ! dispatch_valid_agent "$CANDIDATE_VALUE"; then
      warn "ignoring invalid agent for role '$role' in $source config"; continue
    fi
    # 知らない agent も通す。allowlist は閉じない (config-lib.sh の理由を参照)
    dispatch_known_agent "$CANDIDATE_VALUE" \
      || warn "agent '$CANDIDATE_VALUE' for role '$role' is not one this version knows; passing it to Orca as-is"
    RESOLVED_AGENT="$CANDIDATE_VALUE"; return 0
  done
  RESOLVED_AGENT="$(dispatch_default_agent)"
}

resolve_model() {   # $1=role $2=agent -> RESOLVED_MODEL ('' = 未設定 = flag を渡さない)
  local role="$1" agent="$2" source owner
  RESOLVED_MODEL=''
  for source in override project global; do
    next_candidate "$source" "$role" model
    [[ "$CANDIDATE_PRESENT" -eq 1 ]] || continue
    if ! dispatch_valid_model "$CANDIDATE_VALUE"; then
      warn "ignoring invalid model for role '$role' in $source config"; continue
    fi
    # ★ agent と食い違う model は使わない。層をまたぐと codex + sonnet が成立しうる
    owner="$(dispatch_model_agent "$CANDIDATE_VALUE")"
    if [[ -n "$owner" ]] && dispatch_known_agent "$agent" && [[ "$owner" != "$agent" ]]; then
      warn "ignoring $owner model '$CANDIDATE_VALUE' for role '$role' running agent '$agent' in $source config"
      continue
    fi
    RESOLVED_MODEL="$CANDIDATE_VALUE"; return 0
  done
}

resolve_effort() {   # $1=role $2=agent -> RESOLVED_EFFORT ('' = 未設定)
  local role="$1" agent="$2" source normalized
  RESOLVED_EFFORT=''
  for source in override project global; do
    next_candidate "$source" "$role" effort
    [[ "$CANDIDATE_PRESENT" -eq 1 ]] || continue
    normalized="$(dispatch_normalize_effort "$CANDIDATE_VALUE")"
    if dispatch_known_agent "$agent"; then
      if ! dispatch_valid_effort "$normalized" "$agent"; then
        warn "ignoring invalid effort for role '$role' in $source config"; continue
      fi
    else
      # 未知の agent の許容値は分からない。shell-safe であることだけ確かめて素通しし、
      # 判定は Orca に委ねる（誤りは worker-start の失敗として見える）
      if ! dispatch_valid_model "$normalized"; then
        warn "ignoring invalid effort for role '$role' in $source config"; continue
      fi
      warn "cannot validate effort for unknown agent '$agent'; Orca will validate it at worker-start"
    fi
    RESOLVED_EFFORT="$normalized"; return 0
  done
}

# on/off のトグルを解決する。tuple と同じ override → project → global。
# $1=キー名  $2=検証関数  $3=既定値を出す関数  $4=override 値（空なら未指定）
resolve_toggle() {
  local key="$1" validate="$2" default_fn="$3" override="$4" source file='' vtype value
  if [[ -n "$override" ]]; then printf '%s\n' "$override"; return 0; fi
  for source in project global; do
    case "$source" in
      project) [[ "$PROJECT_PRESENT" -eq 1 ]] || continue; file="$PROJECT_CONFIG" ;;
      global)  [[ "$GLOBAL_PRESENT"  -eq 1 ]] || continue; file="$GLOBAL_CONFIG"  ;;
    esac
    vtype=$(jq -r --arg k "$key" 'if has($k) then .[$k] | type else empty end' "$file" 2>/dev/null)
    [[ -n "$vtype" ]] || continue
    if [[ "$vtype" != string ]]; then
      warn "ignoring non-string $key in $source config"; continue
    fi
    value=$(jq -r --arg k "$key" '.[$k]' "$file" 2>/dev/null)
    if "$validate" "$value"; then printf '%s\n' "$value"; return 0; fi
    warn "ignoring invalid $key '$value' in $source config"
  done
  "$default_fn"
}
REVIEW_MODE="$(resolve_toggle review_mode dispatch_valid_review_mode \
                 dispatch_default_review_mode "$OVERRIDE_review_mode")"
PHASE_B="$(resolve_toggle phase_b dispatch_valid_phase_b \
             dispatch_default_phase_b "$OVERRIDE_phase_b")"
INTEGRATION="$(resolve_toggle integration dispatch_valid_integration \
                 dispatch_default_integration "$OVERRIDE_integration")"
SETUP="$(resolve_toggle setup dispatch_valid_setup dispatch_default_setup "$OVERRIDE_setup")"
DESIGN_MODE="$(resolve_toggle design_mode dispatch_valid_design_mode \
                 dispatch_default_design_mode "$OVERRIDE_design_mode")"
INTEGRATION_ROLE="$(dispatch_integration_role "$PHASE_B")"

ROLES_JSON='{}'
while IFS= read -r role; do
  resolve_agent  "$role"; agent="$RESOLVED_AGENT"
  resolve_model  "$role" "$agent"; model="$RESOLVED_MODEL"
  resolve_effort "$role" "$agent"; effort="$RESOLVED_EFFORT"
  # ★ Orca の制約: `--effort requires --model`。model 無しの effort は渡せないので落とす。
  #   黙って落とすと「設定したのに効かない」になるため警告する。
  if [[ -n "$effort" && -z "$model" ]]; then
    warn "role '$role' sets effort but no model; Orca requires --model with --effort, so effort is dropped"
    effort=''
  fi
  role_json="$(jq -nc --arg a "$agent" '{agent:$a}')"
  [[ -n "$model"  ]] && role_json="$(jq -c --arg m "$model"  '. + {model:$m}'  <<<"$role_json")"
  [[ -n "$effort" ]] && role_json="$(jq -c --arg e "$effort" '. + {effort:$e}' <<<"$role_json")"
  ROLES_JSON="$(jq -nc --arg r "$role" --argjson rj "$role_json" --argjson acc "$ROLES_JSON" \
    '$acc + {($r): $rj}')"
done < <(dispatch_role_names "$REVIEW_MODE" "$PHASE_B")

jq -n \
  --arg config_home "$CONFIG_HOME" \
  --arg global_config "$GLOBAL_CONFIG" \
  --arg project_config "$PROJECT_CONFIG" \
  --argjson global_present "$GLOBAL_PRESENT" \
  --argjson project_present "$PROJECT_PRESENT" \
  --argjson configured "$CONFIGURED" \
  --arg review_mode "$REVIEW_MODE" \
  --arg phase_b "$PHASE_B" \
  --arg integration_role "$INTEGRATION_ROLE" \
  --arg integration "$INTEGRATION" \
  --arg setup "$SETUP" \
  --arg design_mode "$DESIGN_MODE" \
  --argjson roles "$ROLES_JSON" \
  '{config_home:$config_home, global_config:$global_config, project_config:$project_config,
    global_present:($global_present == 1), project_present:($project_present == 1),
    configured:($configured == 1), review_mode:$review_mode, phase_b:$phase_b,
    integration_role:$integration_role, integration:$integration, setup:$setup,
    design_mode:$design_mode, roles:$roles}'
