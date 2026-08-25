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
    worktree=$("$CMUX_E2E_JQ" -r '.worktree // empty' "$stale") || { echo "ERROR: corrupt registry: $stale" >&2; exit 1; }
    [[ -n "$worktree" ]] || { echo "ERROR: corrupt registry: $stale" >&2; exit 1; }
    [[ -e "$worktree" ]] && continue
    id=$("$CMUX_E2E_JQ" -r '.surface_id // empty' "$stale") || exit 1
    tree=$("$CMUX_BIN" --json --id-format both tree --all) || exit 1
    ref=$("$CMUX_E2E_JQ" -r --arg id "$id" '[.windows[]?.workspaces[]?.panes[]?.surfaces[]? | select(.id==$id)] | first.ref // empty' <<< "$tree") || exit 1
    [[ -z "$ref" ]] || cmux_e2e_surface_close "$ref" || exit 1
    rm -f -- "$stale"
  done
fi
reg=$(cmux_e2e_surface_registry_path) || exit 1; ref=$(cmux_e2e_surface_resolve); rc=$?
case "$rc" in 10|11) rm -f -- "$reg"; exit 0 ;; 0) cmux_e2e_surface_close "$ref" || exit 1; rm -f -- "$reg" ;; *) echo "ERROR: unusable recorded surface (resolve rc=$rc)" >&2; exit 1 ;; esac
