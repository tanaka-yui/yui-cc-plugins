#!/usr/bin/env bash
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"; source "$SCRIPT_DIR/lib/lock.sh"; source "$SCRIPT_DIR/lib/surface.sh"
cmux_e2e_harden_umask
[[ $# -eq 0 || ($# -eq 1 && "$1" == --sweep) ]] || { echo 'usage: down.sh [--sweep]' >&2; exit 2; }
cmux_e2e_install_traps; lock=$(cmux_e2e_surface_lock_dir) || exit 1; cmux_e2e_lock_acquire "$lock" || exit 1
reg=$(cmux_e2e_surface_registry_path) || exit 1; ref=$(cmux_e2e_surface_resolve); rc=$?
case "$rc" in 10|11) rm -f -- "$reg"; exit 0 ;; 0) cmux_e2e_surface_close "$ref" || exit 1; rm -f -- "$reg" ;; *) echo "ERROR: unusable recorded surface (resolve rc=$rc)" >&2; exit 1 ;; esac
