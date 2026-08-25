#!/usr/bin/env bash
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"; source "$SCRIPT_DIR/lib/lock.sh"; source "$SCRIPT_DIR/lib/surface.sh"
cmux_e2e_harden_umask
[[ $# -eq 0 || ($# -eq 1 && "$1" == --sweep) ]] || { echo 'usage: down.sh [--sweep]' >&2; exit 2; }
sweep=0; [[ $# -eq 1 ]] && sweep=1
cmux_e2e_install_traps; lock=$(cmux_e2e_surface_lock_dir) || exit 1; cmux_e2e_lock_acquire "$lock" || exit 1
if [[ "$sweep" -eq 1 ]]; then
  entries=$(dirname "$(cmux_e2e_surface_registry_path)") || exit 1
  cmux_e2e_secure_path "$entries" || { echo "ERROR: unsafe surface registry directory" >&2; exit 1; }
  for stale in "$entries"/*.json; do
    [[ -f "$stale" && ! -L "$stale" ]] || continue
    worktree=$("$CMUX_E2E_JQ" -r '.worktree // empty' "$stale") || { echo "WARN: skipping corrupt registry: $stale" >&2; continue; }
    [[ -n "$worktree" ]] || { echo "WARN: skipping registry without worktree: $stale" >&2; continue; }
    [[ -e "$worktree" ]] && continue
    key=$(basename "$stale" .json)
    sibling="$(dirname "$entries")/locks/$key"
    cmux_e2e_lock_acquire "$sibling" 2>/dev/null || { echo "WARN: skipping locked stale worktree: $worktree" >&2; continue; }
    id=$("$CMUX_E2E_JQ" -r '.surface_id // empty' "$stale") || { echo "WARN: skipping corrupt registry: $stale" >&2; continue; }
    tree=$("$CMUX_BIN" --json --id-format both tree --all) || { echo "WARN: cannot inspect stale surface: $stale" >&2; continue; }
    ref=$("$CMUX_E2E_JQ" -r --arg id "$id" '[.windows[]?.workspaces[]?.panes[]?.surfaces[]? | select(.id==$id)] | first.ref // empty' <<< "$tree") || { echo "WARN: cannot resolve stale surface: $stale" >&2; continue; }
    [[ -z "$ref" ]] || cmux_e2e_surface_close "$ref" || { echo "WARN: cannot close stale surface: $stale" >&2; continue; }
    rm -f -- "$stale"
  done
fi
reg=$(cmux_e2e_surface_registry_path) || exit 1; ref=$(cmux_e2e_surface_resolve); rc=$?
case "$rc" in 10|11) rm -f -- "$reg"; exit 0 ;; 0) cmux_e2e_surface_close "$ref" || exit 1; rm -f -- "$reg" ;; *) echo "ERROR: unusable recorded surface (resolve rc=$rc)" >&2; exit 1 ;; esac
