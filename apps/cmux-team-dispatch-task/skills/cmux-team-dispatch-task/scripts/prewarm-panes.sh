#!/usr/bin/env bash
# Pre-warm resolved roles in a fixed two-row workspace layout.
# review_mode=off launches design + exec. review_mode=on additionally launches
# design_review to the right of design and exec_review to the right of exec.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./config-lib.sh
source "$SCRIPT_DIR/config-lib.sh"
AGMSG_DIR="${AGMSG_DIR:-$HOME/.agents/skills/agmsg/scripts}"

die() {
  echo "Error: $1" >&2
  exit 2
}

log() { echo "[$1] $2" >&2; }

WORKSPACE=""
BASE_SURFACE=""
CWD=""
SLUG=""
STATUS_DIR=""
AGMSG_TEAM=""
WITH_DESIGN=0
NOTIFY_WORKSPACE=""
UNATTENDED=0
TIMEOUT_SENTINEL=""
ROLES_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --workspace)
      [[ $# -ge 2 ]] || die "--workspace requires a workspace ID"
      WORKSPACE="$2"; shift 2 ;;
    --base-surface)
      [[ $# -ge 2 ]] || die "--base-surface requires a surface ID"
      BASE_SURFACE="$2"; shift 2 ;;
    --cwd)
      [[ $# -ge 2 ]] || die "--cwd requires a path argument"
      CWD="$2"; shift 2 ;;
    --slug)
      [[ $# -ge 2 ]] || die "--slug requires a task slug"
      SLUG="$2"; shift 2 ;;
    --status-dir)
      [[ $# -ge 2 ]] || die "--status-dir requires a path argument"
      STATUS_DIR="$2"; shift 2 ;;
    --agmsg-team)
      [[ $# -ge 2 ]] || die "--agmsg-team requires a team name"
      AGMSG_TEAM="$2"; shift 2 ;;
    --roles)
      [[ $# -ge 2 ]] || die "--roles requires a path argument"
      ROLES_FILE="$2"; shift 2 ;;
    --with-design|--with-opus)
      WITH_DESIGN=1; shift ;;
    --unattended)
      UNATTENDED=1; shift ;;
    --timeout-sentinel)
      [[ $# -ge 2 ]] || die "--timeout-sentinel requires a path"
      TIMEOUT_SENTINEL="$2"; shift 2 ;;
    --parent-notify-workspace)
      [[ $# -ge 2 ]] || die "--parent-notify-workspace requires a workspace ID"
      NOTIFY_WORKSPACE="$2"; shift 2 ;;
    --design-runner|--reviewer-runner|--exec-runner|--claude-runner|--codex-runner|--exec-choice|--review-"model"|--design-model|--design-effort|--reviewer-model|--reviewer-effort|--exec-model|--exec-effort)
      die "$1 was removed: pass the validated resolver output with --roles instead" ;;
    --message-type)
      die "--message-type was removed: agmsg is mandatory for prewarmed panes" ;;
    --parent-notify-surface)
      die "--parent-notify-surface was removed: pass --parent-notify-workspace instead" ;;
    *) die "unknown option: $1" ;;
  esac
done

[[ -n "$CWD" ]] || die "--cwd is required"
[[ -n "$SLUG" ]] || die "--slug is required"
[[ "$SLUG" =~ ^[A-Za-z0-9._-]+$ ]] || die "invalid slug '$SLUG': use only [A-Za-z0-9._-]"
[[ -n "$STATUS_DIR" ]] || die "--status-dir is required"
[[ -n "$AGMSG_TEAM" ]] || die "--agmsg-team is required: prewarmed panes only receive work through agmsg"
[[ -n "$ROLES_FILE" ]] || die "--roles is required"

if [[ $UNATTENDED -eq 1 && -n "${CODEX_THREAD_ID:-}" ]]; then
  die "--unattended is refused from a codex parent: codex cannot arm the 90-minute safety timer"
fi

case "$AGMSG_DIR" in
  *[[:space:]]*|*[\'\"\`\$\!\\]*) die "AGMSG_DIR contains whitespace or shell metacharacters" ;;
esac
case "$AGMSG_TEAM" in
  *[[:space:]]*|*[\'\"\`\$\!\\]*) die "--agmsg-team contains whitespace or shell metacharacters" ;;
esac

command -v jq >/dev/null 2>&1 || die "jq is not installed"
command -v git >/dev/null 2>&1 || die "git is not installed"

# Read the resolver output exactly once. All validation and extraction below use
# this immutable in-process snapshot, never ROLES_FILE again.
ROLES_DOC=$(cat "$ROLES_FILE") || die "cannot read --roles file"
jq -e . >/dev/null 2>&1 <<< "$ROLES_DOC" || die "--roles file is not valid JSON"

RUNNERS_FILE="$(dispatch_runners_file)"
[[ -f "$RUNNERS_FILE" ]] || die "runners.json not found at $RUNNERS_FILE"
jq -e '.runners | type == "array"' "$RUNNERS_FILE" >/dev/null 2>&1 \
  || die "invalid runners.json at $RUNNERS_FILE"

validate_roles_doc() {
  local bad_top review_mode expected role runner engine effort model runner_engine
  bad_top=$(jq -r '[keys[] | select(. != "review_mode" and . != "roles" and
    . != "config_home" and . != "global_config" and . != "project_config" and
    . != "runners_file")] | first // empty' <<< "$ROLES_DOC")
  [[ -z "$bad_top" ]] || die "invalid --roles top-level key '$bad_top'"
  jq -e '.roles | type == "object"' >/dev/null 2>&1 <<< "$ROLES_DOC" \
    || die "invalid --roles: roles must be an object"

  review_mode=$(jq -r '.review_mode // empty' <<< "$ROLES_DOC")
  [[ "$review_mode" == on || "$review_mode" == off ]] \
    || die "invalid --roles review_mode: expected on or off"
  if [[ "$review_mode" == on ]]; then
    expected='["design","design_review","exec","exec_review"]'
  else
    expected='["design","exec"]'
  fi
  jq -e --argjson expected "$expected" '(.roles | keys) == $expected' >/dev/null 2>&1 <<< "$ROLES_DOC" \
    || die "invalid --roles: active role set does not match review_mode=$review_mode"

  for role in design design_review exec exec_review; do
    jq -e --arg role "$role" '.roles | has($role)' >/dev/null 2>&1 <<< "$ROLES_DOC" || continue
    jq -e --arg role "$role" '
      (.roles[$role] | type == "object") and
      ((.roles[$role] | keys - ["runner","engine","model","effort"]) | length == 0) and
      (.roles[$role] | has("runner") and has("engine") and has("effort")) and
      (.roles[$role].runner | type == "string") and
      (.roles[$role].engine | type == "string") and
      (.roles[$role].effort | type == "string")' >/dev/null 2>&1 <<< "$ROLES_DOC" \
      || die "invalid --roles tuple for $role"

    runner=$(jq -r --arg role "$role" '.roles[$role].runner' <<< "$ROLES_DOC")
    engine=$(jq -r --arg role "$role" '.roles[$role].engine' <<< "$ROLES_DOC")
    effort=$(jq -r --arg role "$role" '.roles[$role].effort' <<< "$ROLES_DOC")
    dispatch_valid_runner_name "$runner" || die "invalid runner name for $role"
    dispatch_valid_effort "$effort" "$engine" || die "invalid effort for $role"
    runner_engine=$(jq -r --arg runner "$runner" \
      'first(.runners[]? | select(.name == $runner) | .engine) // empty' "$RUNNERS_FILE")
    [[ -n "$runner_engine" ]] || die "runner '$runner' for $role is not registered"
    [[ "$runner_engine" == "$engine" ]] \
      || die "engine mismatch for $role: runner '$runner' is $runner_engine, not $engine"

    if jq -e --arg role "$role" '.roles[$role] | has("model")' >/dev/null 2>&1 <<< "$ROLES_DOC"; then
      jq -e --arg role "$role" '.roles[$role].model | type == "string" and length > 0' \
        >/dev/null 2>&1 <<< "$ROLES_DOC" || die "invalid model for $role"
      model=$(jq -r --arg role "$role" '.roles[$role].model' <<< "$ROLES_DOC")
      dispatch_valid_model "$model" || die "invalid model for $role"
    elif dispatch_model_required "$role" "$engine"; then
      die "model is required for $role with engine $engine"
    fi
  done
}

# Every configuration violation is rejected before worktree, agmsg, or pane side effects.
validate_roles_doc
REVIEW_MODE=$(jq -r '.review_mode' <<< "$ROLES_DOC")

if [[ $WITH_DESIGN -eq 1 ]]; then
  [[ -z "$WORKSPACE" && -z "$BASE_SURFACE" ]] \
    || die "--with-design is mutually exclusive with --workspace/--base-surface"
else
  [[ -n "$WORKSPACE" ]] || die "--workspace is required without --with-design"
  [[ -n "$BASE_SURFACE" ]] || die "--base-surface is required without --with-design"
fi
[[ -f "$AGMSG_DIR/send.sh" ]] || die "agmsg is not installed (expected $AGMSG_DIR/send.sh)"

if [[ -d "$CWD" ]]; then
  log worktree "already exists at $CWD, reusing"
else
  BRANCH_NAME="feat/$SLUG"
  log worktree "creating $CWD with branch $BRANCH_NAME"
  git worktree add "$CWD" -b "$BRANCH_NAME" 2>/dev/null \
    || git worktree add "$CWD" "$BRANCH_NAME" 2>/dev/null \
    || die "failed to create worktree at $CWD"
fi

role_value() { jq -r --arg role "$1" --arg field "$2" '.roles[$role][$field] // empty' <<< "$ROLES_DOC"; }
role_has_model() { jq -e --arg role "$1" '.roles[$role] | has("model")' >/dev/null 2>&1 <<< "$ROLES_DOC"; }
role_agent() {
  case "$1" in
    design) printf '%s\n' "$SLUG" ;;
    *) printf '%s-%s\n' "$SLUG" "${1//_/-}" ;;
  esac
}
role_wiring_type() { [[ "$(role_value "$1" engine)" == codex ]] && printf 'codex\n' || printf 'claude-code\n'; }

# readiness 句の前提: delivery.sh set monitor claude-code <worktree> が
# この同じ実行内で成功していること。失敗時は到達不能なので launch 前に止める。
wire_delivery() {
  local role="$1" wiring
  wiring=$(role_wiring_type "$role")
  bash "$AGMSG_DIR/delivery.sh" set monitor "$wiring" "$CWD" >/dev/null 2>&1 \
    || die "$wiring delivery wiring failed; readiness cannot be established"
}

join_role() {
  local role="$1" agent wiring
  agent=$(role_agent "$role")
  wiring=$(role_wiring_type "$role")
  bash "$AGMSG_DIR/join.sh" "$AGMSG_TEAM" "$agent" "$wiring" "$CWD" >&2 2>/dev/null \
    || die "$role agmsg join failed; readiness cannot be established"
  wire_delivery "$role"
}

leave_role() {
  local role="$1" agent
  agent=$(role_agent "$role")
  bash "$AGMSG_DIR/leave.sh" "$AGMSG_TEAM" "$agent" >/dev/null 2>&1 \
    || log warn "failed to leave $agent after pane launch failure"
}

for role in design exec; do join_role "$role"; done
if [[ "$REVIEW_MODE" == on ]]; then
  join_role design_review
  join_role exec_review
fi

readiness_clause() {
  local role="$1" agent wiring
  agent=$(role_agent "$role")
  wiring=$(role_wiring_type "$role")
  if [[ "$wiring" == codex ]]; then
    printf 'FIRST make yourself reachable: call %s/drivers/types/codex/codex-record-session.sh with team %s and agent name %s (two arguments, no trailing punctuation). THEN send a message: call %s/send.sh with team %s, from %s, to parent, and a body — quoted as a single argument — that is exactly [ready] %s with no trailing period or other characters.' \
      "$AGMSG_DIR" "$AGMSG_TEAM" "$agent" "$AGMSG_DIR" "$AGMSG_TEAM" "$agent" "$agent"
  else
    printf 'FIRST follow the AGMSG-DIRECTIVE printed by your SessionStart hook and invoke the Monitor tool right now — that is the only way work will reach you. THEN send a message: call %s/send.sh with team %s, from %s, to parent, and a body — quoted as a single argument — that is exactly [ready] %s with no trailing period or other characters.' \
      "$AGMSG_DIR" "$AGMSG_TEAM" "$agent" "$agent"
  fi
}

NOTIFY_FLAGS=()
[[ -n "$NOTIFY_WORKSPACE" ]] && NOTIFY_FLAGS=(--parent-notify-workspace "$NOTIFY_WORKSPACE")
SENTINEL_FLAGS=()
[[ -n "$TIMEOUT_SENTINEL" ]] && SENTINEL_FLAGS=(--timeout-sentinel "$TIMEOUT_SENTINEL")

launch_role() { # role [workspace split-from direction]
  local role="$1" workspace="${2:-}" split_from="${3:-}" direction="${4:-}"
  local runner engine effort agent prompt result surface
  runner=$(role_value "$role" runner)
  engine=$(role_value "$role" engine)
  effort=$(role_value "$role" effort)
  agent=$(role_agent "$role")
  prompt="$(readiness_clause "$role") Then wait idle. Your task will arrive as an agmsg message. Do not start work until it arrives. Do not poll or run an inbox wait loop."

  local args=(--cwd "$CWD")
  if [[ "$role" == design ]]; then
    args+=(--mode standby --role design --defer-status)
  elif [[ "$role" == exec ]]; then
    args+=(--mode standby --role exec --standby-in "$workspace"
      --standby-split-from "$split_from" --standby-split-direction "$direction")
  else
    args+=(--mode review --role "$role" --standby-in "$workspace"
      --standby-split-from "$split_from" --standby-split-direction "$direction")
  fi
  args+=(--runner "$runner")
  role_has_model "$role" && args+=(--model "$(role_value "$role" model)")
  args+=(--effort "$effort")
  [[ "$engine" == claude && "$role" != design ]] && args+=(--skip-permissions)
  [[ "$engine" == claude && "$role" == design && $UNATTENDED -eq 1 ]] && args+=(--skip-permissions)
  [[ ${#SENTINEL_FLAGS[@]} -eq 0 ]] || args+=("${SENTINEL_FLAGS[@]}")
  args+=(--status-dir "$STATUS_DIR")
  [[ ${#NOTIFY_FLAGS[@]} -eq 0 ]] || args+=("${NOTIFY_FLAGS[@]}")
  args+=(--agmsg-team "$AGMSG_TEAM" --agmsg-from "$agent")

  if result=$(bash "$SCRIPT_DIR/launch-workspace.sh" "${args[@]}" "$agent" "$prompt"); then
    surface=$(jq -r '.surface_id // empty' <<< "$result")
    if [[ -z "$surface" ]]; then
      [[ "$role" == design || "$role" == exec ]] && die "failed to parse required $role pane output"
      leave_role "$role"
      log warn "$role pane output had no surface; omitting that review role"
      return 1
    fi
    LAUNCHED_SURFACE="$surface"
    LAUNCHED_WORKSPACE=""
    [[ "$role" != design ]] || LAUNCHED_WORKSPACE=$(jq -r '.workspace_id // empty' <<< "$result")
    [[ "$role" != design || -n "$LAUNCHED_WORKSPACE" ]] || die "failed to parse design workspace output"
    return 0
  fi

  if [[ "$role" == design || "$role" == exec ]]; then
    die "failed to launch required $role pane"
  fi
  leave_role "$role"
  log warn "failed to launch $role pane; omitting that review role"
  return 1
}

DESIGN_SURFACE="$BASE_SURFACE"
if [[ $WITH_DESIGN -eq 1 ]]; then
  launch_role design
  DESIGN_SURFACE="$LAUNCHED_SURFACE"
  WORKSPACE="$LAUNCHED_WORKSPACE"
fi
[[ -n "$WORKSPACE" && -n "$DESIGN_SURFACE" ]] || die "design workspace and surface are required"

DESIGN_REVIEW_SURFACE=""
if [[ "$REVIEW_MODE" == on ]]; then
  if launch_role design_review "$WORKSPACE" "$DESIGN_SURFACE" right; then
    DESIGN_REVIEW_SURFACE="$LAUNCHED_SURFACE"
  fi
fi

launch_role exec "$WORKSPACE" "$DESIGN_SURFACE" down
EXEC_SURFACE="$LAUNCHED_SURFACE"
EXEC_REVIEW_SURFACE=""
if [[ "$REVIEW_MODE" == on ]]; then
  if launch_role exec_review "$WORKSPACE" "$EXEC_SURFACE" right; then
    EXEC_REVIEW_SURFACE="$LAUNCHED_SURFACE"
  fi
fi

role_entry() {
  local role="$1" surface="$2" agent
  agent=$(role_agent "$role")
  jq -c --arg role "$role" --arg surface "$surface" --arg agent "$agent" \
    '.roles[$role] + {surface_id: $surface, agent: $agent, wired: true}' <<< "$ROLES_DOC"
}

DESIGN_ENTRY=$(role_entry design "$DESIGN_SURFACE")
EXEC_ENTRY=$(role_entry exec "$EXEC_SURFACE")
DESIGN_REVIEW_ENTRY='{}'
EXEC_REVIEW_ENTRY='{}'
[[ -z "$DESIGN_REVIEW_SURFACE" ]] || DESIGN_REVIEW_ENTRY=$(role_entry design_review "$DESIGN_REVIEW_SURFACE")
[[ -z "$EXEC_REVIEW_SURFACE" ]] || EXEC_REVIEW_ENTRY=$(role_entry exec_review "$EXEC_REVIEW_SURFACE")
PANES_JSON=$(jq -n \
  --argjson design "$DESIGN_ENTRY" --argjson exec "$EXEC_ENTRY" \
  --arg drs "$DESIGN_REVIEW_SURFACE" --arg ers "$EXEC_REVIEW_SURFACE" \
  --argjson dr "$DESIGN_REVIEW_ENTRY" --argjson er "$EXEC_REVIEW_ENTRY" \
  '{design: $design} + (if $drs != "" then {design_review: $dr} else {} end) +
   {exec: $exec} + (if $ers != "" then {exec_review: $er} else {} end)')

mkdir -p "$STATUS_DIR"
jq -n --arg workspace_id "$WORKSPACE" --arg review_mode "$REVIEW_MODE" --argjson panes "$PANES_JSON" \
  '{workspace_id: $workspace_id, review_mode: $review_mode} + $panes' > "$STATUS_DIR/prewarm.json"
log prewarm "wrote $STATUS_DIR/prewarm.json"

if [[ $WITH_DESIGN -eq 1 && ! -f "$STATUS_DIR/status.json" ]]; then
  jq -n --arg ws "$WORKSPACE" --arg sf "$DESIGN_SURFACE" \
    '{status: "launched", workspace_id: $ws, surface_id: $sf,
      message: "agmsg prewarm panes launched (idle)", timestamp: (now | todate)}' \
    > "$STATUS_DIR/status.json"
  log prewarm "wrote initial launched status.json"
fi

jq -n --arg workspace_id "$WORKSPACE" --arg review_mode "$REVIEW_MODE" --argjson panes "$PANES_JSON" \
  '{workspace_id: $workspace_id, review_mode: $review_mode, panes: $panes}'
