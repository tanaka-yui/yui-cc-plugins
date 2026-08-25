#!/usr/bin/env bash
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$SCRIPT_DIR/../skills/cmux-e2e/scripts"
export PATH="$SCRIPT_DIR/stub:$PATH"
source "$SCRIPT_DIR/lib/harness.sh"
h_setup
trap h_teardown EXIT
source "$SCRIPTS/lib/common.sh"
source "$SCRIPTS/lib/surface.sh"

reg=$(cmux_e2e_surface_registry_path)
cmux_e2e_mkdir_secure "$(dirname "$reg")"
jq -n --arg wt "$PWD" '{surface_id:"UUID-1",surface_ref:"surface:5",worktree:$wt}' > "$reg"
h_tree UUID-1 surface:5 browser
mkdir -p .cmux-e2e-scenarios

cat > .cmux-e2e-scenarios/stdin.sh <<'EOF'
#!/usr/bin/env bash
read ignored
EOF
/usr/bin/script -q /dev/null bash "$SCRIPTS/run.sh" stdin </dev/null >/dev/null 2>&1
h_check 'stdin-reading scenario receives EOF instead of hanging' 1 $?

cat > .cmux-e2e-scenarios/wrapper-env.sh <<'EOF'
#!/usr/bin/env bash
export CMUX_E2E_GUARD=0 CMUX_E2E_WRAPPER_REF=surface:99
cmux-e2e-browser identify > "$RESULTS_DIR/wrapper.json"
EOF
bash "$SCRIPTS/run.sh" wrapper-env >/dev/null 2>&1
h_check 'scenario cannot redirect wrapper with inherited-looking variables' 0 $?
h_check 'wrapper retains generated surface ref' surface:5 "$(jq -r .surface_ref .cmux-e2e-results/wrapper-env/wrapper.json)"
h_assert_no_import
exit "$(h_fail_count)"
