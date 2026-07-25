#!/usr/bin/env bash
# 無人 issue ループ用の完全なタスクプロンプトを決定的に組み立てる。
set -euo pipefail
die() { echo "Error: $1" >&2; exit 1; }
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; REF_DIR="$(cd "$SCRIPT_DIR/../references/unattended" && pwd)"
SLUG=""; ISSUE=""; TITLE=""; URL=""; BODY_FILE=""; PLAN_HINT=""; EXEC=""; DESIGN=""; REVIEW=""; STATUS=""; SENTINEL=""; TEAM=""; LAYOUT=""; PARENT_WS=""; PARENT_SF=""; SKILL_DIR=""; REVIEW_MODEL=""; REVIEW_RUNNER=""; REVIEW_AGENT=""
while [[ $# -gt 0 ]]; do case "$1" in
  --slug) SLUG="$2"; shift 2 ;; --issue) ISSUE="$2"; shift 2 ;; --issue-title) TITLE="$2"; shift 2 ;; --issue-url) URL="$2"; shift 2 ;;
  --issue-body-file) BODY_FILE="$2"; shift 2 ;; --plan-hint) PLAN_HINT="$2"; shift 2 ;; --exec-choice) EXEC="$2"; shift 2 ;; --design-engine) DESIGN="$2"; shift 2 ;;
  --review) REVIEW="$2"; shift 2 ;; --status-dir) STATUS="$2"; shift 2 ;; --timeout-sentinel) SENTINEL="$2"; shift 2 ;; --team) TEAM="$2"; shift 2 ;;
  --layout) LAYOUT="$2"; shift 2 ;; --parent-workspace) PARENT_WS="$2"; shift 2 ;; --parent-surface) PARENT_SF="$2"; shift 2 ;; --skill-dir) SKILL_DIR="$2"; shift 2 ;;
  --review-model) REVIEW_MODEL="$2"; shift 2 ;; --review-runner) REVIEW_RUNNER="$2"; shift 2 ;; --review-pane-agent) REVIEW_AGENT="$2"; shift 2 ;;
  *) die "unknown option: $1" ;; esac; done
for value in "$SLUG" "$ISSUE" "$TITLE" "$URL" "$BODY_FILE" "$PLAN_HINT" "$EXEC" "$DESIGN" "$REVIEW" "$STATUS" "$SENTINEL" "$TEAM" "$LAYOUT" "$PARENT_WS" "$SKILL_DIR"; do [[ -n "$value" ]] || die "required argument is missing"; done
[[ -f "$BODY_FILE" ]] || die "--issue-body-file not found"
[[ "$DESIGN" == claude || "$DESIGN" == codex ]] || die "--design-engine must be claude or codex"
[[ "$REVIEW" == on || "$REVIEW" == off ]] || die "--review must be on or off"
phase=$(cat "$REF_DIR/phase-block-$DESIGN.md")
printf 'Task slug: %s\nIssue: #%s — %s\nURL: %s\n\n%s\n\nIssue body:\n' "$SLUG" "$ISSUE" "$TITLE" "$URL" "$phase"
cat "$BODY_FILE"
printf '\n\nPlan hint: %s\nExecution choice: %s\nStatus directory: %s\nTimeout sentinel: %s\nTeam: %s\nLayout: %s\nParent workspace: %s\nSkill directory: %s\n' "$PLAN_HINT" "$EXEC" "$STATUS" "$SENTINEL" "$TEAM" "$LAYOUT" "$PARENT_WS" "$SKILL_DIR"
printf '\nSTATUS PROTOCOL: immediately write %s/status.json with status=executing. On completion, write status=done or status=error and write %s/result.md. Preserve an existing pr_url. If the timeout sentinel exists, do not write status. For PR integration include Closes #%s.\n' "$STATUS" "$STATUS" "$ISSUE"
printf 'Before delegating, inspect %s/prewarm.json, touch .assigned-<selected-pane>, send the complete request text, and touch .deferred when a child owns status. Spawn fallback must pass --unattended and --timeout-sentinel %s.\n' "$STATUS" "$SENTINEL"
[[ -n "$PARENT_SF" ]] && printf 'Parent surface: %s\n' "$PARENT_SF"
if [[ "$REVIEW" == on ]]; then
  [[ -n "$REVIEW_MODEL" && -n "$REVIEW_RUNNER" && -n "$REVIEW_AGENT" ]] || die "review=on requires review model, runner, and pane agent"
  cat "$REF_DIR/review-block.md" "$REF_DIR/code-review-block.md"
  printf '\nReview model: %s\nReview runner: %s\nReview pane agent: %s\n' "$REVIEW_MODEL" "$REVIEW_RUNNER" "$REVIEW_AGENT"
fi
