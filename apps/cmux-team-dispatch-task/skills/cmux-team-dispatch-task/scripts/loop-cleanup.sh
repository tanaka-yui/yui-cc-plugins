#!/usr/bin/env bash
# GitHub issue 自動ループのバッチ間 cleanup。
set -euo pipefail
die() { echo "Error: $1" >&2; exit 1; }
log() { echo "[$1] $2" >&2; }
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; FETCH="$SCRIPT_DIR/issue-fetch.sh"
# shellcheck source=./config-lib.sh
source "$SCRIPT_DIR/config-lib.sh"
STATE_FILE=""; BATCH=""; INTEGRATION=""; DISPATCH_DIR=""; REPO_ROOT=""; AGMSG_TEAM=""
while [[ $# -gt 0 ]]; do case "$1" in
  --state-file) STATE_FILE="$2"; shift 2 ;; --batch) BATCH="$2"; shift 2 ;;
  --integration) INTEGRATION="$2"; shift 2 ;; --dispatch-dir) DISPATCH_DIR="$2"; shift 2 ;;
  --repo-root) REPO_ROOT="$2"; shift 2 ;; --agmsg-team) AGMSG_TEAM="$2"; shift 2 ;;
  *) die "unknown option: $1" ;; esac; done
[[ -n "$STATE_FILE" && -n "$BATCH" && ( "$INTEGRATION" == pr || "$INTEGRATION" == merge ) ]] || die "--state-file, --batch, and --integration are required"
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel)}"; REPO_ROOT="$(cd "$REPO_ROOT" && pwd)"
DISPATCH_DIR="${DISPATCH_DIR:-$REPO_ROOT/.dispatch}"
bash "$FETCH" --state-file "$STATE_FILE" heartbeat >/dev/null || die "loop lock owner check failed"
done_count=0; error_count=0; timeout_count=0; merged_count=0; conflicted_count=0; unverified_count=0; leaked='[]'
record_leak() { leaked=$(jq --arg value "$1" '. + [$value]' <<<"$leaked"); log warn "$1"; }
base_branch=$(git -C "$REPO_ROOT" symbolic-ref --short HEAD 2>/dev/null || echo main)
preserve_wip() {
  local slug="$1" wt="$REPO_ROOT/.worktrees/$slug" dir="$DISPATCH_DIR/$slug"
  [[ -d "$wt" ]] || return 0; mkdir -p "$dir"
  # commit 試行で stage される前に未追跡一覧を保存する。
  git -C "$wt" ls-files --others --exclude-standard -z > "$dir/wip-untracked.manifest" || return 1
  git -C "$wt" add -A >/dev/null 2>&1 || true
  git -C "$wt" -c user.name=cmux-dispatch -c user.email=cmux-dispatch@localhost commit --no-verify -qm "wip: $slug (dispatch failed)" >/dev/null 2>&1 && return 0
  git -C "$wt" diff --binary HEAD > "$dir/wip.patch" || return 1
  if [[ -s "$dir/wip-untracked.manifest" ]]; then
    local archive_stage file
    archive_stage=$(mktemp -d) || return 1
    while IFS= read -r -d '' file; do
      mkdir -p "$archive_stage/$(dirname "$file")" || { rm -rf "$archive_stage"; return 1; }
      cp -p "$wt/$file" "$archive_stage/$file" || { rm -rf "$archive_stage"; return 1; }
    done < "$dir/wip-untracked.manifest"
    tar -czf "$dir/wip-untracked.tar.gz" -C "$archive_stage" . || { rm -rf "$archive_stage"; return 1; }
    rm -rf "$archive_stage"
    # tar の一覧は改行区切りのため改行を含む名前の identity を NUL-safe と主張しない。
    tar -tzf "$dir/wip-untracked.tar.gz" >/dev/null || return 1
  fi
  if [[ -s "$dir/wip.patch" ]]; then
    local base verify; base=$(git -C "$wt" rev-parse HEAD) || return 1; verify=$(mktemp -d); rmdir "$verify"
    git -C "$REPO_ROOT" worktree add --detach -q "$verify" "$base" >/dev/null 2>&1 || return 1
    git -C "$verify" apply --check --binary "$dir/wip.patch" || { git -C "$REPO_ROOT" worktree remove "$verify" --force || true; return 1; }
    git -C "$REPO_ROOT" worktree remove "$verify" --force >/dev/null 2>&1 || true
  fi
  return 0
}
verify_done() {
  local slug="$1" wt="$REPO_ROOT/.worktrees/$slug"
  [[ $(git -C "$REPO_ROOT" rev-list --count "$base_branch..feat/$slug" 2>/dev/null || echo 0) -gt 0 ]] || return 1
  if [[ "$INTEGRATION" == pr ]]; then
    local pr; pr=$(jq -r '.pr_url // empty' "$DISPATCH_DIR/$slug/status.json" 2>/dev/null || echo "")
    [[ -n "$pr" ]] && gh pr view "$pr" --json state >/dev/null 2>&1 && return 0
    [[ $(gh pr list --head "feat/$slug" --json url 2>/dev/null | jq length 2>/dev/null || echo 0) -gt 0 ]]
  else
    [[ ! -d "$wt" || -z "$(git -C "$wt" status --porcelain)" ]]
  fi
}
apply_labels() {
  local issue="$1" status="$2" slug="$3" close_issue="$4" terminal
  [[ "$status" == done ]] && terminal=dispatch/done || terminal=dispatch/failed
  gh issue edit "$issue" --add-label "$terminal" >/dev/null 2>&1 || return 1
  gh issue edit "$issue" --remove-label dispatch/in-progress >/dev/null 2>&1 || true
  if [[ "$status" == done && "$close_issue" == yes ]]; then gh issue close "$issue" --reason completed >/dev/null 2>&1 || true; fi
  if [[ "$status" != done ]]; then gh issue comment "$issue" --body "cmux-team-dispatch-task のループで失敗しました。 .dispatch/$slug/ と branch feat/$slug を確認してください。" >/dev/null 2>&1 || true; fi
}
prewarm_invalid() { log warn "$1: invalid prewarm snapshot; role-aware leave skipped"; }
validate_prewarm_snapshot() { # $1=slug; reads PREWARM_DOC only
  local slug="$1" bad_top review_mode role runner engine effort model runner_engine expected_agent
  jq -e 'type == "object"' >/dev/null 2>&1 <<< "$PREWARM_DOC" \
    || { prewarm_invalid "$slug (top-level value is not an object)"; return 1; }
  bad_top=$(jq -r '[keys[] | select(. != "workspace_id" and . != "review_mode" and
    . != "design" and . != "design_review" and . != "exec" and . != "exec_review")] | first // empty' \
    <<< "$PREWARM_DOC")
  [[ -z "$bad_top" ]] \
    || { prewarm_invalid "$slug (unknown top-level key '$bad_top')"; return 1; }
  jq -e '.workspace_id | type == "string" and length > 0' >/dev/null 2>&1 <<< "$PREWARM_DOC" \
    || { prewarm_invalid "$slug (workspace_id)"; return 1; }
  review_mode=$(jq -r '.review_mode // empty' <<< "$PREWARM_DOC")
  [[ "$review_mode" == on || "$review_mode" == off ]] \
    || { prewarm_invalid "$slug (review_mode)"; return 1; }
  jq -e 'has("design") and has("exec")' >/dev/null 2>&1 <<< "$PREWARM_DOC" \
    || { prewarm_invalid "$slug (design and exec are required)"; return 1; }

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
      >/dev/null 2>&1 <<< "$PREWARM_DOC" \
      || { prewarm_invalid "$slug ($role tuple)"; return 1; }
    case "$role" in
      design) expected_agent="$slug" ;;
      *) expected_agent="$slug-${role//_/-}" ;;
    esac
    [[ $(jq -r --arg role "$role" '.[$role].agent' <<< "$PREWARM_DOC") == "$expected_agent" ]] \
      || { prewarm_invalid "$slug ($role agent)"; return 1; }
    runner=$(jq -r --arg role "$role" '.[$role].runner' <<< "$PREWARM_DOC")
    engine=$(jq -r --arg role "$role" '.[$role].engine' <<< "$PREWARM_DOC")
    effort=$(jq -r --arg role "$role" '.[$role].effort' <<< "$PREWARM_DOC")
    dispatch_valid_runner_name "$runner" \
      || { prewarm_invalid "$slug ($role runner)"; return 1; }
    dispatch_valid_effort "$effort" "$engine" \
      || { prewarm_invalid "$slug ($role effort)"; return 1; }
    runner_engine=$(jq -r --arg runner "$runner" \
      'first(.runners[]? | select(.name == $runner) | .engine) // empty' "$RUNNERS_FILE")
    [[ -n "$runner_engine" && "$runner_engine" == "$engine" ]] \
      || { prewarm_invalid "$slug ($role runner/engine)"; return 1; }
    if jq -e --arg role "$role" '.[$role] | has("model")' >/dev/null 2>&1 <<< "$PREWARM_DOC"; then
      jq -e --arg role "$role" '.[$role].model | type == "string" and length > 0' \
        >/dev/null 2>&1 <<< "$PREWARM_DOC" \
        || { prewarm_invalid "$slug ($role model type)"; return 1; }
      model=$(jq -r --arg role "$role" '.[$role].model' <<< "$PREWARM_DOC")
      dispatch_valid_model "$model" \
        || { prewarm_invalid "$slug ($role model)"; return 1; }
    elif dispatch_model_required "$role" "$engine"; then
      prewarm_invalid "$slug ($role model is required)"
      return 1
    fi
  done
  return 0
}
for issue in $(jq -r --argjson batch "$BATCH" '.issues | to_entries[] | select(.value.batch == $batch) | .key' "$STATE_FILE"); do
  bash "$FETCH" --state-file "$STATE_FILE" heartbeat >/dev/null || die "loop lock owner check failed mid-cleanup"
  slug=$(jq -r --arg issue "$issue" '.issues[$issue].slug' "$STATE_FILE"); status=$(jq -r --arg issue "$issue" '.issues[$issue].status' "$STATE_FILE"); wt="$REPO_ROOT/.worktrees/$slug"; dir="$DISPATCH_DIR/$slug"
  # Snapshot and validate before any done branch can remove $dir. Later leave logic
  # consumes only PREWARM_AGENTS, never the original path.
  PREWARM_FILE="$dir/prewarm.json"; PREWARM_DOC=""; PREWARM_AGENTS=""; PREWARM_CAN_LEAVE=no
  if [[ -e "$PREWARM_FILE" ]]; then
    if PREWARM_DOC=$(cat "$PREWARM_FILE"); then
      RUNNERS_FILE="$(dispatch_runners_file)"
      if ! jq -e 'type' >/dev/null 2>&1 <<< "$PREWARM_DOC"; then
        prewarm_invalid "$slug (not valid JSON)"
      elif [[ ! -f "$RUNNERS_FILE" ]] \
        || ! jq -e '.runners | type == "array"' "$RUNNERS_FILE" >/dev/null 2>&1; then
        prewarm_invalid "$slug (runners.json)"
      elif validate_prewarm_snapshot "$slug"; then
        snapshot_workspace=$(jq -r '.workspace_id' <<< "$PREWARM_DOC")
        cleanup_workspace=$(cmux workspace list 2>/dev/null \
          | grep -F "[$slug]" | awk 'NR == 1 { print $1 }') || true
        if [[ -n "$cleanup_workspace" && "$snapshot_workspace" == "$cleanup_workspace" ]]; then
          PREWARM_AGENTS=$(jq -r '. as $d | ["design","design_review","exec","exec_review"]
            | map(select($d[.] != null) | $d[.].agent) | .[]' <<< "$PREWARM_DOC")
          PREWARM_CAN_LEAVE=yes
        else
          log warn "$slug: prewarm workspace '$snapshot_workspace' does not match cleanup workspace '${cleanup_workspace:-missing}'; role-aware leave skipped"
        fi
      fi
    else
      log warn "$slug: prewarm snapshot could not be read; role-aware leave skipped"
    fi
  fi
  keep_worktree=no
  if [[ "$status" == done ]] && ! verify_done "$slug"; then status=error; keep_worktree=yes; unverified_count=$((unverified_count+1)); fi
  close_issue=no; conflicted=no
  if [[ "$status" == done && "$INTEGRATION" == merge ]]; then
    if git -C "$REPO_ROOT" merge "feat/$slug" --no-edit >/dev/null 2>&1; then merged_count=$((merged_count+1)); close_issue=yes; else git -C "$REPO_ROOT" merge --abort >/dev/null 2>&1 || true; status=error; conflicted_count=$((conflicted_count+1)); conflicted=yes; fi
  fi
  if [[ "$status" != done ]]; then preserve_wip "$slug" || { record_leak "$slug: WIP 保全に失敗"; continue; }; fi
  bash "$FETCH" --state-file "$STATE_FILE" finalize --issue "$issue" --status "$status" || die "finalize failed; destructive cleanup stopped"
  if ! apply_labels "$issue" "$status" "$slug" "$close_issue"; then record_leak "$slug: terminal ラベル付与に失敗"; continue; fi
  if [[ "$conflicted" == yes ]]; then
    error_count=$((error_count+1))
    record_leak "$slug: merge conflict のため worktree と branch を温存"
    continue
  fi
  if [[ "$keep_worktree" == yes ]]; then
    error_count=$((error_count+1))
    record_leak "$slug: completion を検証できないため worktree と branch を温存"
    continue
  fi
  case "$status" in done) done_count=$((done_count+1)); rm -rf "$dir" ;; timeout) timeout_count=$((timeout_count+1)) ;; *) error_count=$((error_count+1)) ;; esac
  git -C "$REPO_ROOT" worktree remove "$wt" --force >/dev/null 2>&1 || record_leak "$slug: worktree 削除に失敗"
  [[ "$status" == done ]] && git -C "$REPO_ROOT" branch -D "feat/$slug" >/dev/null 2>&1 || true
  if [[ -n "$AGMSG_TEAM" && "$PREWARM_CAN_LEAVE" == yes ]]; then
    while IFS= read -r agent; do
      [[ -n "$agent" ]] || continue
      "$HOME/.agents/skills/agmsg/scripts/leave.sh" "$AGMSG_TEAM" "$agent" >/dev/null 2>&1 || true
    done <<< "$PREWARM_AGENTS"
  fi
done
if [[ "$leaked" != '[]' ]]; then tmp=$(mktemp "$STATE_FILE.XXXXXX"); jq --argjson leaked "$leaked" '.leaked += $leaked' "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"; fi
jq -n --argjson batch "$BATCH" --argjson done "$done_count" --argjson error "$error_count" --argjson timeout "$timeout_count" --argjson merged "$merged_count" --argjson conflicted "$conflicted_count" --argjson unverified "$unverified_count" --argjson leaked "$leaked" '{batch:$batch,done:$done,error:$error,timeout:$timeout,merged:$merged,conflicted:$conflicted,unverified:$unverified,leaked:$leaked}'
