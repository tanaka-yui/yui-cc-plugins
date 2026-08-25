#!/usr/bin/env bash
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"; source "$SCRIPT_DIR/lib/lock.sh"; source "$SCRIPT_DIR/lib/surface.sh"; source "$SCRIPT_DIR/lib/auth-core.sh"
usage() { echo 'usage: run.sh <scenario> [--auth <name>] [--allow-js-errors] [--no-guard]' >&2; exit 2; }
scenario="${1:-}"; [[ -n "$scenario" && ! "$scenario" =~ [/.] ]] || usage; shift
auth=''; allow_js=0; guard=1
while [[ $# -gt 0 ]]; do case "$1" in --auth) [[ $# -ge 2 ]] || usage; auth="$2"; shift 2 ;; --allow-js-errors) allow_js=1; shift ;; --no-guard) guard=0; shift ;; *) usage ;; esac; done
[[ -z "$auth" ]] || cmux_e2e_validate_name "$auth" || usage
root=$(git rev-parse --show-toplevel) || exit 1; root=$(cd "$root" && pwd -P) || exit 1
file="$root/.cmux-e2e-scenarios/$scenario.sh"; cmux_e2e_secure_artifact "$file" "$root" || exit 1; [[ -f "$file" && ! -L "$file" ]] || { echo "ERROR: scenario not found: $file" >&2; exit 1; }
cmux_e2e_harden_umask; cmux_e2e_install_traps
lock=$(cmux_e2e_surface_lock_dir) || exit 1; cmux_e2e_lock_acquire "$lock" || exit 1
if [[ -n "$auth" ]]; then alock=$(cmux_e2e_auth_lock_dir "$auth") || exit 1; cmux_e2e_lock_acquire "$alock" || exit 1; fi
ref=$(cmux_e2e_surface_resolve) || { echo 'ERROR: no usable surface; run up first.' >&2; exit 1; }
[[ -z "$auth" ]] || auth_check_locked "$ref" "$auth" || exit 1
tabs=$("$CMUX_BIN" --json browser --surface "$ref" tab list | "$CMUX_E2E_JQ" '.tabs|length') || exit 1; [[ "$tabs" -eq 1 ]] || exit 1
out="$root/.cmux-e2e-results/$scenario"; cmux_e2e_secure_artifact "$out" "$root" || exit 1; mkdir -p "$out" && chmod 700 "$out" || exit 1
wrap=$(mktemp -d); trap 'rm -rf -- "$wrap"; cmux_e2e_lock_release_all' EXIT
cat > "$wrap/cmux-e2e-browser" <<EOF
#!/usr/bin/env bash
set -uo pipefail
if [[ '$guard' == 1 ]]; then
  got=\$("$CMUX_BIN" --json browser --surface '$ref' identify | "$CMUX_E2E_JQ" -r '.surface_ref // empty') || exit 1
  [[ "\$got" == '$ref' ]] || exit 1
fi
exec "$CMUX_BIN" browser --surface "$ref" "\$@"
EOF
chmod 755 "$wrap/cmux-e2e-browser"
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
PATH="$wrap:$PATH" RESULTS_DIR="$out" WORKTREE_ROOT="$root" CMUX_E2E_SURFACE="$ref" bash "$file"; rc=$?
"$CMUX_BIN" browser --surface "$ref" console list > "$out/console.log" 2>/dev/null || true
"$CMUX_BIN" browser --surface "$ref" errors list > "$out/errors.log" 2>/dev/null || true
[[ "$rc" -eq 0 || "$allow_js" -eq 1 || ! -s "$out/errors.log" ]] || rc=1
if [[ "$rc" -ne 0 ]]; then "$CMUX_BIN" browser --surface "$ref" screenshot --out "$out/failure.png" >/dev/null 2>&1 || true; fi
finished=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf '# %s\n\n- scenario: %s\n- started_at: %s\n- finished_at: %s\n- exit_code: %s\n- guard: %s\n' "$scenario" "$scenario" "$started" "$finished" "$rc" "$([[ "$guard" -eq 1 ]] && echo enabled || echo disabled)" > "$out/summary.md"
chmod 600 "$out"/* 2>/dev/null || true
exit "$rc"
