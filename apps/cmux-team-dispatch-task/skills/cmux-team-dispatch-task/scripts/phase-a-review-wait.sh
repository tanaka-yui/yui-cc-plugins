#!/usr/bin/env bash
# Render the Phase A-R wait protocol from the independently resolved waiter and
# design reviewer engines.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  echo 'usage: phase-a-review-wait.sh --waiter-engine <claude|codex> --reviewer-engine <claude|codex> --team <team> --waiter-agent <agent> --reviewer-agent <agent> --reviewer-workspace <workspace:N> --reviewer-surface <surface:N> --findings-path <path> --send-command <path>' >&2
  exit 2
}

WAITER_ENGINE=''
REVIEWER_ENGINE=''
TEAM=''
WAITER_AGENT=''
REVIEWER_AGENT=''
REVIEWER_WORKSPACE=''
REVIEWER_SURFACE=''
FINDINGS_PATH=''
SEND_COMMAND=''

while [[ $# -gt 0 ]]; do
  case "$1" in
    --waiter-engine) [[ $# -ge 2 ]] || usage; WAITER_ENGINE="$2"; shift 2 ;;
    --reviewer-engine) [[ $# -ge 2 ]] || usage; REVIEWER_ENGINE="$2"; shift 2 ;;
    --team) [[ $# -ge 2 ]] || usage; TEAM="$2"; shift 2 ;;
    --waiter-agent) [[ $# -ge 2 ]] || usage; WAITER_AGENT="$2"; shift 2 ;;
    --reviewer-agent) [[ $# -ge 2 ]] || usage; REVIEWER_AGENT="$2"; shift 2 ;;
    --reviewer-workspace) [[ $# -ge 2 ]] || usage; REVIEWER_WORKSPACE="$2"; shift 2 ;;
    --reviewer-surface) [[ $# -ge 2 ]] || usage; REVIEWER_SURFACE="$2"; shift 2 ;;
    --findings-path) [[ $# -ge 2 ]] || usage; FINDINGS_PATH="$2"; shift 2 ;;
    --send-command) [[ $# -ge 2 ]] || usage; SEND_COMMAND="$2"; shift 2 ;;
    *) usage ;;
  esac
done

case "$WAITER_ENGINE" in claude|codex) ;; *) usage ;; esac
case "$REVIEWER_ENGINE" in claude|codex) ;; *) usage ;; esac
[[ "$TEAM" =~ ^[A-Za-z0-9._-]+$ ]] || usage
[[ "$WAITER_AGENT" =~ ^[A-Za-z0-9._-]+$ ]] || usage
[[ "$REVIEWER_AGENT" =~ ^[A-Za-z0-9._-]+$ ]] || usage
[[ "$REVIEWER_WORKSPACE" =~ ^workspace:[0-9]+$ ]] || usage
[[ "$REVIEWER_SURFACE" =~ ^surface:[0-9]+$ ]] || usage
[[ -n "$FINDINGS_PATH" && -n "$SEND_COMMAND" ]] || usage

case "$REVIEWER_ENGINE" in
  codex)
    REVIEWER_LIVENESS="run bash $SCRIPT_DIR/verify-agmsg-ready.sh --codex --team $TEAM --name $REVIEWER_AGENT once"
    ;;
  claude)
    REVIEWER_LIVENESS="run cmux read-screen --workspace $REVIEWER_WORKSPACE --surface $REVIEWER_SURFACE once; if that transiently fails, retry it once before treating the reviewer as unreachable"
    ;;
esac

case "$WAITER_ENGINE" in
  claude)
    printf 'After each successful review-plan: send, stop and wait for the review-verdict: push. Before stopping, arm ONE single-shot safety timer with the Bash tool using run_in_background. On every wake, re-read %s before deciding anything; a timer wake without a VERDICT line is not a verdict. If the timer fires without a verdict, %s, then re-send the same round once when needed and re-arm the same timer, up to 3 re-arms for that round.\n' \
      "$FINDINGS_PATH" "$REVIEWER_LIVENESS"
    ;;
  codex)
    printf 'After each successful review-plan: send, stop and wait for the review-verdict: push. You have NO safety net for this wait and must not create a timer. Before stopping, %s, then call %s once, passing exactly four arguments in this order: team %s, sender %s, recipient parent, and one dispatch-notify: body reporting an unbacked design review wait; the body must say dispatch-notify: %s waiting for design review verdict; this engine has no timer. On every wake, re-read %s before deciding anything.\n' \
      "$REVIEWER_LIVENESS" "$SEND_COMMAND" "$TEAM" "$WAITER_AGENT" "$WAITER_AGENT" "$FINDINGS_PATH"
    ;;
esac
