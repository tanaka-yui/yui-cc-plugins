#!/usr/bin/env bash
# Source-only validator for the public prewarm.json snapshot contract.

PREWARM_SNAPSHOT_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./config-lib.sh
source "$PREWARM_SNAPSHOT_SCRIPT_DIR/config-lib.sh"

validate_prewarm_snapshot() { # $1=complete in-memory JSON document
  local doc="${1-}" runners_file bad_top review_mode role slug expected_agent
  local runner engine effort model runner_engine

  jq -e -s 'length == 1 and (.[0] | type == "object")' >/dev/null 2>&1 <<< "$doc" \
    || return 1
  bad_top=$(jq -r '[keys[] | select(. != "workspace_id" and . != "review_mode" and
    . != "design" and . != "design_review" and . != "exec" and . != "exec_review")] |
    first // empty' <<< "$doc")
  [[ -z "$bad_top" ]] || return 1
  jq -e '.workspace_id | type == "string"' >/dev/null 2>&1 <<< "$doc" || return 1
  dispatch_valid_workspace_id "$(jq -r '.workspace_id' <<< "$doc")" || return 1

  review_mode=$(jq -r '.review_mode // empty' <<< "$doc")
  [[ "$review_mode" == on || "$review_mode" == off ]] || return 1
  jq -e 'has("design") and has("exec")' >/dev/null 2>&1 <<< "$doc" || return 1
  if [[ "$review_mode" == off ]]; then
    jq -e 'has("design_review") or has("exec_review")' >/dev/null 2>&1 <<< "$doc" \
      && return 1
  fi

  slug=$(jq -r '.design.agent // empty' <<< "$doc")
  [[ "$slug" =~ ^[A-Za-z0-9._-]+$ ]] || return 1
  runners_file="$(dispatch_runners_file)"
  [[ -f "$runners_file" ]] || return 1
  jq -e '.runners | type == "array"' "$runners_file" >/dev/null 2>&1 || return 1

  for role in design design_review exec exec_review; do
    jq -e --arg role "$role" 'has($role)' >/dev/null 2>&1 <<< "$doc" || continue
    jq -e --arg role "$role" '
      (.[$role] | type == "object") and
      ((.[$role] | keys - ["surface_id","agent","runner","engine","model","effort","wired"]) |
        length == 0) and
      (.[$role] | has("surface_id") and has("agent") and has("runner") and has("engine") and
        has("effort") and has("wired")) and
      (.[$role].surface_id | type == "string") and
      (.[$role].agent | type == "string") and
      (.[$role].runner | type == "string") and
      (.[$role].engine | type == "string") and
      (.[$role].effort | type == "string") and
      (.[$role].wired == true)' >/dev/null 2>&1 <<< "$doc" || return 1

    dispatch_valid_surface_id "$(jq -r --arg role "$role" '.[$role].surface_id' <<< "$doc")" \
      || return 1
    case "$role" in
      design) expected_agent="$slug" ;;
      *) expected_agent="$slug-${role//_/-}" ;;
    esac
    [[ "$(jq -r --arg role "$role" '.[$role].agent' <<< "$doc")" == "$expected_agent" ]] \
      || return 1

    runner=$(jq -r --arg role "$role" '.[$role].runner' <<< "$doc")
    engine=$(jq -r --arg role "$role" '.[$role].engine' <<< "$doc")
    effort=$(jq -r --arg role "$role" '.[$role].effort' <<< "$doc")
    dispatch_valid_runner_name "$runner" || return 1
    dispatch_valid_effort "$effort" "$engine" || return 1
    runner_engine=$(jq -r --arg runner "$runner" \
      'first(.runners[]? | select(.name == $runner) | .engine) // empty' "$runners_file")
    [[ -n "$runner_engine" && "$runner_engine" == "$engine" ]] || return 1

    if jq -e --arg role "$role" '.[$role] | has("model")' >/dev/null 2>&1 <<< "$doc"; then
      jq -e --arg role "$role" '.[$role].model | type == "string" and length > 0' \
        >/dev/null 2>&1 <<< "$doc" || return 1
      model=$(jq -r --arg role "$role" '.[$role].model' <<< "$doc")
      dispatch_valid_model "$model" || return 1
    elif dispatch_model_required "$role" "$engine"; then
      return 1
    fi
  done

  jq -e '[. as $doc | ["design","design_review","exec","exec_review"][] |
    select($doc[.] != null) | $doc[.].surface_id] as $ids |
    ($ids | length) == ($ids | unique | length)' >/dev/null 2>&1 <<< "$doc"
}
