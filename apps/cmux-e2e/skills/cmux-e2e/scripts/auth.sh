#!/usr/bin/env bash
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"; source "$SCRIPT_DIR/lib/lock.sh"; source "$SCRIPT_DIR/lib/surface.sh"; source "$SCRIPT_DIR/lib/auth-core.sh"
cmux_e2e_harden_umask
action="${1:-}"; shift || true
case "$action" in save|load|check|delete) name="${1:-}"; [[ -n "$name" ]] || exit 2; shift ;; list) [[ $# -eq 0 ]] || exit 2; auth_list; exit $? ;; *) exit 2 ;; esac
cmux_e2e_validate_name "$name" || exit 2; [[ $# -eq 0 ]] || exit 2; cmux_e2e_install_traps
alock=$(cmux_e2e_auth_lock_dir "$name") || exit 1; cmux_e2e_lock_acquire "$alock" || exit 1
if [[ "$action" == delete ]]; then auth_delete_locked "$name"; exit $?; fi
wlock=$(cmux_e2e_surface_lock_dir) || exit 1; cmux_e2e_lock_acquire "$wlock" || exit 1; ref=$(cmux_e2e_surface_resolve) || exit 1
case "$action" in save) auth_save_locked "$ref" "$name" '' '' ;; load) auth_load_locked "$ref" "$name" ;; check) auth_check_locked "$ref" "$name" ;; esac
