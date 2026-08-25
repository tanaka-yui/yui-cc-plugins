#!/usr/bin/env bash
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"; source "$SCRIPT_DIR/lib/lock.sh"; source "$SCRIPT_DIR/lib/surface.sh"
profile=''
if [[ $# -eq 2 && "$1" == --profile ]]; then profile="$2"; elif [[ $# -ne 0 ]]; then echo 'usage: up.sh [--profile <name>]' >&2; exit 2; fi
cmux_e2e_harden_umask; cmux_e2e_install_traps
lock=$(cmux_e2e_surface_lock_dir) || exit 1; cmux_e2e_lock_acquire "$lock" || exit 1
ref=$(cmux_e2e_surface_resolve); rc=$?
case "$rc" in 0) printf '%s\n' "$ref" ;; 10|11) cmux_e2e_surface_create "$profile" || exit 1; printf '\n' ;; *) echo "ERROR: unusable recorded surface (resolve rc=$rc)" >&2; exit 1 ;; esac
