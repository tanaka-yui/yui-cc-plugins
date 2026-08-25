#!/usr/bin/env bash
CMUX_BIN="${CMUX_BIN:-cmux}"
cmux_e2e_surface_registry_path() { local r p w; r=$(cmux_e2e_cache_root) || return 1; p=$(cmux_e2e_project_key) || return 1; w=$(cmux_e2e_worktree_key) || return 1; printf '%s/%s/surfaces/entries/%s.json' "$r" "$p" "$w"; }
cmux_e2e_surface_lock_dir() { local r p w; r=$(cmux_e2e_cache_root) || return 1; p=$(cmux_e2e_project_key) || return 1; w=$(cmux_e2e_worktree_key) || return 1; printf '%s/%s/surfaces/locks/%s' "$r" "$p" "$w"; }
cmux_e2e_surface_resolve() {
  local reg id tree node ref got tmp
  reg=$(cmux_e2e_surface_registry_path) || return 20; cmux_e2e_secure_path "$reg" || return 20; [[ -f "$reg" ]] || return 10
  "$CMUX_E2E_JQ" -e . "$reg" >/dev/null 2>&1 || return 20; id=$("$CMUX_E2E_JQ" -r '.surface_id // empty' "$reg") || return 20; [[ -n "$id" ]] || return 20
  tree=$("$CMUX_BIN" --json --id-format both tree --all) || return 20; "$CMUX_E2E_JQ" -e . >/dev/null <<< "$tree" || return 20
  node=$("$CMUX_E2E_JQ" -c --arg id "$id" '[.windows[]?.workspaces[]?.panes[]?.surfaces[]? | select(.id==$id)] | first // empty' <<< "$tree") || return 20
  [[ -n "$node" ]] || return 11; [[ $("$CMUX_E2E_JQ" -r '.type' <<< "$node") == browser ]] || return 12
  ref=$("$CMUX_E2E_JQ" -r '.ref // empty' <<< "$node") || return 20; [[ -n "$ref" ]] || return 20
  got=$("$CMUX_BIN" --json browser --surface "$ref" identify | "$CMUX_E2E_JQ" -r '.surface_ref // .browser.surface // empty') || return 20; [[ "$got" == "$ref" ]] || return 13
  tmp="$reg.tmp.$$"; "$CMUX_E2E_JQ" --arg r "$ref" '.surface_ref=$r' "$reg" > "$tmp" || return 20; cmux_e2e_install_file "$tmp" "$reg" || return 20; printf '%s' "$ref"
}
cmux_e2e_surface_create() {
  local profile="${1:-}" out ref tree id reg tmp git_dir
  if [[ -n "$profile" ]]; then out=$("$CMUX_BIN" --json browser new --profile "$profile") || return 20; else out=$("$CMUX_BIN" --json browser new) || return 20; fi
  ref=$("$CMUX_E2E_JQ" -r '.surface_ref // empty' <<< "$out") || return 20; [[ -n "$ref" ]] || return 20
  tree=$("$CMUX_BIN" --json --id-format both tree --all) || return 20
  id=$("$CMUX_E2E_JQ" -r --arg ref "$ref" '[.windows[]?.workspaces[]?.panes[]?.surfaces[]? | select(.ref==$ref)] | first.id // empty' <<< "$tree") || return 20; [[ -n "$id" ]] || return 20
  reg=$(cmux_e2e_surface_registry_path) || return 20; cmux_e2e_mkdir_secure "$(dirname "$reg")" || return 20
  git_dir=$(cmux_e2e_worktree_git_dir) || return 20
  tmp="$reg.tmp.$$"
  "$CMUX_E2E_JQ" -n --arg id "$id" --arg ref "$ref" --arg wt "$(git rev-parse --show-toplevel)" --arg gd "$git_dir" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{surface_id:$id,surface_ref:$ref,worktree:$wt,git_dir:$gd,created_at:$at}' > "$tmp" || return 20
  cmux_e2e_install_file "$tmp" "$reg" || return 20; printf '%s' "$ref"
}
cmux_e2e_surface_close() { "$CMUX_BIN" close-surface --surface "$1" >/dev/null 2>&1; }
