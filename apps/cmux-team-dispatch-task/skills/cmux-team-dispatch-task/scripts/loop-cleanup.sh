#!/usr/bin/env bash
# GitHub issue 自動ループのバッチ間 cleanup。
set -euo pipefail
die() { echo "Error: $1" >&2; exit 1; }
log() { echo "[$1] $2" >&2; }
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; FETCH="$SCRIPT_DIR/issue-fetch.sh"
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
  git -C "$wt" add -A >/dev/null 2>&1 || true
  git -C "$wt" -c user.name=cmux-dispatch -c user.email=cmux-dispatch@localhost commit --no-verify -qm "wip: $slug (dispatch failed)" >/dev/null 2>&1 && return 0
  git -C "$wt" diff --binary HEAD > "$dir/wip.patch" || return 1
  git -C "$wt" ls-files --others --exclude-standard -z > "$dir/wip-untracked.manifest" || return 1
  if [[ -s "$dir/wip-untracked.manifest" ]]; then
    tar czf "$dir/wip-untracked.tar.gz" --null -T "$dir/wip-untracked.manifest" -C "$wt" || return 1
    # tar の一覧は改行区切りのため改行を含む名前の identity を NUL-safe と主張しない。
    tar tzf "$dir/wip-untracked.tar.gz" >/dev/null || return 1
  fi
  if [[ -s "$dir/wip.patch" ]]; then
    local base verify; base=$(git -C "$wt" rev-parse HEAD) || return 1; verify=$(mktemp -d); rmdir "$verify"
    git -C "$REPO_ROOT" worktree add --detach -q "$verify" "$base" >/dev/null 2>&1 || return 1
    git -C "$verify" apply --check --binary "$dir/wip.patch" || { git -C "$REPO_ROOT" worktree remove "$verify" --force || true; return 1; }
    git -C "$REPO_ROOT" worktree remove "$verify" --force >/dev/null 2>&1 || true
  fi
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
for issue in $(jq -r --argjson batch "$BATCH" '.issues | to_entries[] | select(.value.batch == $batch) | .key' "$STATE_FILE"); do
  bash "$FETCH" --state-file "$STATE_FILE" heartbeat >/dev/null || die "loop lock owner check failed mid-cleanup"
  slug=$(jq -r --arg issue "$issue" '.issues[$issue].slug' "$STATE_FILE"); status=$(jq -r --arg issue "$issue" '.issues[$issue].status' "$STATE_FILE"); wt="$REPO_ROOT/.worktrees/$slug"; dir="$DISPATCH_DIR/$slug"
  if [[ "$status" == done ]] && ! verify_done "$slug"; then status=error; unverified_count=$((unverified_count+1)); fi
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
  case "$status" in done) done_count=$((done_count+1)); rm -rf "$dir" ;; timeout) timeout_count=$((timeout_count+1)) ;; *) error_count=$((error_count+1)) ;; esac
  git -C "$REPO_ROOT" worktree remove "$wt" --force >/dev/null 2>&1 || record_leak "$slug: worktree 削除に失敗"
  [[ "$status" == done ]] && git -C "$REPO_ROOT" branch -D "feat/$slug" >/dev/null 2>&1 || true
  if [[ -n "$AGMSG_TEAM" ]]; then
    for agent in "$slug" "$slug-sonnet" "$slug-codex" "$slug-review" "$slug-opus"; do
      "$HOME/.agents/skills/agmsg/scripts/leave.sh" "$AGMSG_TEAM" "$agent" >/dev/null 2>&1 || true
    done
  fi
done
if [[ "$leaked" != '[]' ]]; then tmp=$(mktemp "$STATE_FILE.XXXXXX"); jq --argjson leaked "$leaked" '.leaked += $leaked' "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"; fi
jq -n --argjson batch "$BATCH" --argjson done "$done_count" --argjson error "$error_count" --argjson timeout "$timeout_count" --argjson merged "$merged_count" --argjson conflicted "$conflicted_count" --argjson unverified "$unverified_count" --argjson leaked "$leaked" '{batch:$batch,done:$done,error:$error,timeout:$timeout,merged:$merged,conflicted:$conflicted,unverified:$unverified,leaked:$leaked}'
