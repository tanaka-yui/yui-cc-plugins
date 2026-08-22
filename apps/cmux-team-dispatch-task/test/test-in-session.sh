#!/usr/bin/env bash
# IS1 no in-session collapse; IS2 identical design/exec tuples still launch exec;
# IS3 prewarm.json has no executors key.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail=0
pass() { echo "PASS: $1"; }
bad() { echo "FAIL: $1" >&2; fail=1; }
. "$SCRIPT_DIR/lib/prewarm-harness.sh"

jq '.roles.design = {runner:"ccf",engine:"claude",model:"opus[1m]",effort:"xhigh"} |
    .roles.exec = .roles.design |
    .roles.design_review = .roles.design |
    .roles.exec_review = .roles.design' "$ROLES_ON" > "$TMP/same.json"
run_pw "$TMP/same.json" >/dev/null 2>&1
PJ="$STATUS/prewarm.json"

grep -qi 'in-session' "$PW" && bad 'IS1 collapse code remains' || pass 'IS1 no in-session detection code'
[[ "$(launch_count)" == 4 ]] && jq -e 'has("exec")' "$PJ" >/dev/null \
  && pass 'IS2 identical tuples still launch a distinct exec pane' || bad 'IS2 exec pane'
jq -e 'has("executors")' "$PJ" >/dev/null \
  && bad 'IS3 legacy executors key remains' || pass 'IS3 no executors key'
for role in design design_review exec exec_review; do
  grep -qE "^launch .*--role $role( |$)" "$TMP/calls.log" || bad "IS4 missing $role launch"
done
pass 'IS4 all four role launches are assembled'

exit "$fail"
