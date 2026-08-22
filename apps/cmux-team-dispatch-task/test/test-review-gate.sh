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
     design:{surface_id:"s1",agent:"t",runner:"ccf",engine:"claude",model:"opus[1m]",effort:"xhigh",wired:true},
     exec:{surface_id:"s3",agent:"t-exec",runner:"ccf",engine:"claude",model:"sonnet",effort:"high",wired:true}}
    + if $key == "have" then
      {exec_review:{surface_id:"s4",agent:"t-exec-review",runner:"ccf",engine:"claude",model:"opus[1m]",effort:"xhigh",wired:true}}
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
    if [[ "$key" == have && "$ready" == yes ]]; then
      if [[ $rc -eq 0 && -f "$cr" ]] \
        && grep -q -- '--review-config' <<< "$out" \
        && ! jq -e 'has("stale")' "$cr" >/dev/null \
        && jq -e '.reviewer_surface == "s4" and .reviewer_agent == "t-exec-review" and
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

exit "$fail"
