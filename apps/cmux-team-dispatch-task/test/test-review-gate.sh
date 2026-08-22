#!/usr/bin/env bash
# Phase B-R gate は exec_review の launch と readiness の両方を要求する。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/review-gate.sh"
fail=0
bad() { echo "FAIL $1"; fail=1; }
ok() { echo "PASS $1"; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export DISPATCH_CONFIG_HOME="$TMP/home"
mkdir -p "$DISPATCH_CONFIG_HOME" "$TMP/status"
cat > "$DISPATCH_CONFIG_HOME/runners.json" <<'JSON'
{"default":"ccf","runners":[{"name":"ccf","command":"ccf","engine":"claude"}]}
JSON

PJ="$TMP/prewarm.json"
setup_prewarm() {
  local key="$1"
  jq -n --arg key "$key" '
    {workspace_id:"workspace:1",review_mode:"on",
     design:{surface_id:"surface:1",agent:"t",runner:"ccf",engine:"claude",model:"opus[1m]",effort:"xhigh",wired:true},
     exec:{surface_id:"surface:3",agent:"t-exec",runner:"ccf",engine:"claude",model:"sonnet",effort:"high",wired:true}}
    + if $key == "have" then
      {exec_review:{surface_id:"surface:4",agent:"t-exec-review",runner:"ccf",engine:"claude",model:"opus[1m]",effort:"xhigh",wired:true}}
      else {} end' > "$PJ"
}

for key in have missing; do
  for ready in yes no; do
    rm -rf "$TMP/status/review"
    setup_prewarm "$key"
    mkdir -p "$TMP/status/review"
    printf '%s\n' '{"stale":true}' > "$TMP/status/review/code-review.json"
    args=(--prewarm "$PJ" --status-dir "$TMP/status" --slug t --team tm --reviewer-workspace workspace:1)
    [[ "$ready" == yes ]] && args+=(--ready exec_review)
    out=$(bash "$GATE" "${args[@]}" 2>/dev/null)
    rc=$?
    cr="$TMP/status/review/code-review.json"
    cr_real=$(cd "$(dirname "$cr")" 2>/dev/null && pwd -P)/code-review.json
    if [[ "$key" == have && "$ready" == yes ]]; then
      if [[ $rc -eq 0 && -f "$cr" ]] \
        && [[ "$out" == "$cr_real" ]] \
        && ! jq -e 'has("stale")' "$cr" >/dev/null \
        && jq -e '.reviewer_surface == "surface:4" and .reviewer_agent == "t-exec-review" and
          .reviewer_runner == "ccf" and .reviewer_engine == "claude" and
          .reviewer_workspace == "workspace:1"' "$cr" >/dev/null; then
        ok "RG-$key-$ready: 両方そろって出る"
      else
        bad "RG-$key-$ready"
      fi
    else
      [[ $rc -eq 0 && ! -f "$cr" && -z "$out" ]] \
        && ok "RG-$key-$ready: 両方とも出ない" \
        || bad "RG-$key-$ready: 片方だけ出た (rc=$rc out=$out)"
    fi
  done
done

assert_reject() { # label, optional expected stderr needle
  local label="$1" needle="${2:-review-gate}" rc
  shift 2 || true
  if bash "$GATE" --prewarm "$PJ" --status-dir "$TMP/status" --slug t --team tm \
       --reviewer-workspace workspace:1 --ready exec_review "$@" \
       >"$TMP/reject.out" 2>"$TMP/reject.err"; then
    bad "$label: invalid input was accepted"
  else
    rc=$?
    [[ $rc -eq 2 && ! -s "$TMP/reject.out" && $(cat "$TMP/reject.err") == *"$needle"* ]] \
      && ok "$label" || bad "$label: rc=$rc err=$(tr '\n' ' ' < "$TMP/reject.err")"
  fi
}

setup_prewarm have
jq '.workspace_id = "workspace:2"' "$PJ" > "$TMP/bad.json" && mv "$TMP/bad.json" "$PJ"
assert_reject 'RG5 snapshot/caller workspace mismatch is rejected' 'snapshot'

setup_prewarm have
jq '.exec_review.surface_id = .exec.surface_id' "$PJ" > "$TMP/bad.json" && mv "$TMP/bad.json" "$PJ"
assert_reject 'RG6 duplicate role surfaces are rejected' 'snapshot'

setup_prewarm have
sentinel="$TMP/gate-pwn"
jq --arg v "surface:4'; touch $sentinel; #" '.exec_review.surface_id = $v' "$PJ" \
  > "$TMP/bad.json" && mv "$TMP/bad.json" "$PJ"
assert_reject 'RG7 shell-special surface is rejected' 'snapshot'
[[ ! -e "$sentinel" ]] && ok 'RG7 shell-special surface caused no side effect' \
  || bad 'RG7 shell-special surface caused a side effect'

setup_prewarm have
rm -rf "$TMP/status/review"
mkdir -p "$TMP/outside"
ln -s "$TMP/outside" "$TMP/status/review"
assert_reject 'RG8 symlink review directory is rejected' 'review directory'
[[ ! -e "$TMP/outside/code-review.json" ]] && ok 'RG8 publish stayed contained' \
  || bad 'RG8 publish escaped status directory'

rm -f "$TMP/status/review"
mkdir -p "$TMP/status/review/code-review.json"
assert_reject 'RG9 directory code-review target is rejected' 'target'
[[ ! -f "$TMP/status/review/code-review.json" ]] && ok 'RG9 final target is not misreported as a file' \
  || bad 'RG9 unexpected regular target'

setup_prewarm have
mkdir -p "$TMP/outside-status"
ln -s "$TMP/outside-status" "$TMP/status-link"
assert_reject 'RG10 symlink status directory is rejected' 'status' \
  --status-dir "$TMP/status-link"
[[ ! -e "$TMP/outside-status/review/code-review.json" ]] \
  && ok 'RG10 publish did not follow the top-level status symlink' \
  || bad 'RG10 publish escaped through the top-level status symlink'

exit "$fail"
