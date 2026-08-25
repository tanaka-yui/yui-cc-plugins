#!/usr/bin/env bash
cmux_e2e_auth_root() { local r p; r=$(cmux_e2e_cache_root) || return 1; p=$(cmux_e2e_project_key) || return 1; printf '%s/%s/auth' "$r" "$p"; }
cmux_e2e_auth_dir() { local r; r=$(cmux_e2e_auth_root) || return 1; printf '%s/entries/%s' "$r" "$1"; }
cmux_e2e_auth_lock_dir() { local r; r=$(cmux_e2e_auth_root) || return 1; printf '%s/locks/%s' "$r" "$1"; }
_cmux_e2e_auth_dir() { cmux_e2e_validate_name "$1" || return 2; local d; d=$(cmux_e2e_auth_dir "$1") || return 1; cmux_e2e_secure_path "$d" || return 1; printf '%s' "$d"; }
_cmux_e2e_digest() { "$CMUX_E2E_SHASUM" -a 256 "$1" | awk '{print $1}'; }
auth_save_locked() {
  local ref="$1" name="$2" url="${3:-}" sel="${4:-}" d s m
  [[ -z "$url" && -z "$sel" || -n "$url" && -n "$sel" ]] || return 2
  d=$(_cmux_e2e_auth_dir "$name") || return $?
  cmux_e2e_mkdir_secure "$d" || return 1
  s="$d/.state.$$"; m="$d/.meta.$$"
  "$CMUX_BIN" browser --surface "$ref" state save "$s" >/dev/null || { rm -f -- "$s" "$m"; return 1; }
  "$CMUX_E2E_JQ" -n --arg sha "$(_cmux_e2e_digest "$s")" --arg url "$url" --arg sel "$sel" '{state_sha256:$sha,check_url:($url|select(.!="") // null),check_selector:($sel|select(.!="") // null)}' > "$m" || { rm -f -- "$s" "$m"; return 1; }
  cmux_e2e_install_file "$s" "$d/state.json" || { rm -f -- "$s" "$m"; return 1; }
  cmux_e2e_install_file "$m" "$d/meta.json" || { rm -f -- "$m"; return 1; }
}
auth_load_locked() { local ref="$1" name="$2" d want got; d=$(_cmux_e2e_auth_dir "$name") || return $?; [[ -f "$d/state.json" && -f "$d/meta.json" && ! -L "$d/state.json" && ! -L "$d/meta.json" ]] || return 1; want=$("$CMUX_E2E_JQ" -r '.state_sha256 // empty' "$d/meta.json") || return 1; got=$(_cmux_e2e_digest "$d/state.json") || return 1; [[ -n "$want" && "$want" == "$got" ]] || return 1; "$CMUX_BIN" browser --surface "$ref" state load "$d/state.json" >/dev/null; }
auth_check_locked() { auth_load_locked "$1" "$2"; }
auth_list() { local r d; r=$(cmux_e2e_auth_root) || return 1; for d in "$r"/entries/*; do [[ -f "$d/state.json" && -f "$d/meta.json" ]] && basename "$d"; done; }
auth_delete_locked() { local d; d=$(_cmux_e2e_auth_dir "$1") || return $?; [[ -d "$d" ]] && rm -rf -- "$d"; return 0; }
