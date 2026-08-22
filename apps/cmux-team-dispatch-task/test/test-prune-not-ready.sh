#!/usr/bin/env bash
# Readiness prune is destructive: validate workspace, uniqueness, and live ownership first.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRUNE="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/prune-not-ready.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
fail=0
bad() { echo "FAIL $1"; fail=1; }
ok() { echo "PASS $1"; }
export DISPATCH_CONFIG_HOME="$TMP/home"
mkdir -p "$DISPATCH_CONFIG_HOME" "$TMP/bin"
cat > "$DISPATCH_CONFIG_HOME/runners.json" <<'JSON'
{"default":"ccf","runners":[{"name":"ccf","command":"ccf","engine":"claude"}]}
JSON
cat > "$TMP/bin/cmux" <<'STUB'
#!/usr/bin/env bash
if [[ "$1" == list-pane-surfaces ]]; then cat "$LIVE_SURFACES"; exit 0; fi
printf 'cmux %s\n' "$*" >> "$PRUNE_CALLS"
STUB
cat > "$TMP/bin/leave.sh" <<'STUB'
#!/usr/bin/env bash
printf 'leave %s\n' "$*" >> "$PRUNE_CALLS"
STUB
chmod +x "$TMP/bin/cmux" "$TMP/bin/leave.sh"
export CMUX_BIN="$TMP/bin/cmux" AGMSG_DIR="$TMP/bin" PRUNE_CALLS="$TMP/calls" \
  LIVE_SURFACES="$TMP/live-surfaces"

write_valid() {
  cat > "$TMP/prewarm.json" <<'JSON'
{"workspace_id":"workspace:1","review_mode":"on",
 "design":{"surface_id":"surface:1","agent":"t","runner":"ccf","engine":"claude","model":"opus[1m]","effort":"xhigh","wired":true},
 "design_review":{"surface_id":"surface:2","agent":"t-design-review","runner":"ccf","engine":"claude","model":"opus[1m]","effort":"xhigh","wired":true},
 "exec":{"surface_id":"surface:3","agent":"t-exec","runner":"ccf","engine":"claude","model":"sonnet","effort":"high","wired":true},
 "exec_review":{"surface_id":"surface:4","agent":"t-exec-review","runner":"ccf","engine":"claude","model":"opus[1m]","effort":"xhigh","wired":true}}
JSON
  printf 'surface:1\nsurface:2\nsurface:3\nsurface:4\n' > "$LIVE_SURFACES"
  : > "$PRUNE_CALLS"
}
run_prune() {
  bash "$PRUNE" --prewarm "$TMP/prewarm.json" --workspace "$1" --team tm --slug t --role "$2" \
    >"$TMP/out" 2>"$TMP/err"
}

[[ -f "$PRUNE" ]] || { bad "PN0 missing production prune script: $PRUNE"; exit "$fail"; }

write_valid
if run_prune workspace:1 design_review \
  && grep -Fq 'cmux close-surface --workspace workspace:1 --surface surface:2' "$PRUNE_CALLS" \
  && grep -Fq 'leave tm t-design-review' "$PRUNE_CALLS" \
  && ! jq -e 'has("design_review")' "$TMP/prewarm.json" >/dev/null; then
  ok 'PN1 valid review target is closed, left, and pruned'
else
  bad "PN1 valid prune failed: $(tr '\n' ' ' < "$TMP/err")"
fi

assert_inert() { # label, workspace, role
  local label="$1" workspace="$2" role="$3"
  if run_prune "$workspace" "$role"; then
    bad "$label: invalid target was accepted"
  elif [[ ! -s "$PRUNE_CALLS" ]] && jq -e 'has("design_review") and has("exec_review")' \
       "$TMP/prewarm.json" >/dev/null; then
    ok "$label"
  else
    bad "$label: destructive side effect occurred"
  fi
}

write_valid
assert_inert 'PN2 caller/snapshot workspace mismatch is inert' workspace:9 design_review

write_valid
jq '.design_review.surface_id = .design.surface_id' "$TMP/prewarm.json" > "$TMP/bad.json" \
  && mv "$TMP/bad.json" "$TMP/prewarm.json"
assert_inert 'PN3 duplicate role surfaces are inert' workspace:1 design_review

write_valid
printf 'surface:1\nsurface:3\nsurface:4\n' > "$LIVE_SURFACES"
assert_inert 'PN4 target not owned by live workspace is inert' workspace:1 design_review

write_valid
assert_inert 'PN5 required roles cannot be readiness-pruned' workspace:1 design

exit "$fail"
