#!/usr/bin/env bash

cmux_e2e_die() { echo "cmux-e2e: $1" >&2; exit "${2:-1}"; }

CMUX_E2E_JQ="${CMUX_E2E_JQ:-jq}"
CMUX_E2E_YQ="${CMUX_E2E_YQ:-yq}"
CMUX_E2E_SHASUM="${CMUX_E2E_SHASUM:-shasum}"

cmux_e2e_harden_umask() { umask 077; }

cmux_e2e_validate_name() {
  local name="${1-}"
  [[ -n "$name" && "$name" != '.' && "$name" != '..' && "$name" =~ ^[A-Za-z0-9._-]+$ ]] || return 2
}

_cmux_e2e_sha256_16() { printf '%s' "$1" | "$CMUX_E2E_SHASUM" -a 256 | cut -c1-16; }

cmux_e2e_worktree_key() {
  local root key
  root=$(git rev-parse --show-toplevel) || return 1
  root=$(cd "$root" && pwd -P) || return 1
  key=$(_cmux_e2e_sha256_16 "$root") || return 1
  [[ -n "$key" ]] || return 1
  printf '%s' "$key"
}

cmux_e2e_worktree_git_dir() {
  local root git_dir
  root=$(git rev-parse --show-toplevel) || return 1
  git_dir=$(git -C "$root" rev-parse --git-dir) || return 1
  case "$git_dir" in /*) ;; *) git_dir=$(cd "$root/$git_dir" && pwd -P) || return 1 ;; esac
  printf '%s' "$git_dir"
}

cmux_e2e_project_key() {
  local root common main key
  root=$(git rev-parse --show-toplevel) || return 1
  if [[ -f "$root/.dev-up.yaml" ]]; then
    command -v "$CMUX_E2E_YQ" >/dev/null 2>&1 || {
      echo 'ERROR: .dev-up.yaml exists but yq is not installed; cannot resolve the project name.' >&2
      return 1
    }
    key=$("$CMUX_E2E_YQ" -r '.project // ""' "$root/.dev-up.yaml" 2>/dev/null) || return 1
    if [[ -n "$key" && "$key" != null ]]; then
      cmux_e2e_validate_name "$key" || {
        echo "ERROR: invalid project name in .dev-up.yaml: $key" >&2
        return 1
      }
      printf '%s' "$key"
      return 0
    fi
  fi
  common=$(git -C "$root" rev-parse --git-common-dir) || return 1
  case "$common" in /*) ;; *) common="$root/$common" ;; esac
  main=$(cd "$(dirname "$common")" && pwd -P) || return 1
  key="$(basename "$main")-$(_cmux_e2e_sha256_16 "$main")" || return 1
  cmux_e2e_validate_name "$key" || return 1
  printf '%s' "$key"
}

cmux_e2e_cache_root() { printf '%s/.cache/cc-skills/cmux-e2e' "$HOME"; }

_cmux_e2e_no_dot_components() {
  local path="$1" part
  local IFS=/
  for part in $path; do
    [[ "$part" != '.' && "$part" != '..' ]] || return 1
  done
}

_cmux_e2e_no_symlink_from_home() {
  local target="$1" home="$HOME" rel cur part
  local -a parts
  [[ "$home" == /* && "$target" == "$home"* ]] || return 1
  [[ "$target" == "$home" || "$target" == "$home/"* ]] || return 1
  [[ -L "$home" ]] && return 1
  rel="${target#"$home"}"; rel="${rel#/}"
  cur="$home"
  IFS='/' read -r -a parts <<< "$rel"
  for part in "${parts[@]}"; do
    [[ -n "$part" ]] || continue
    [[ "$part" != '.' && "$part" != '..' ]] || return 1
    cur="$cur/$part"
    [[ -L "$cur" ]] && return 1
  done
  return 0
}

cmux_e2e_secure_path() {
  local path="$1" root
  root=$(cmux_e2e_cache_root) || return 1
  [[ "$path" == "$root" || "$path" == "$root/"* ]] || return 1
  _cmux_e2e_no_dot_components "$path" || return 1
  _cmux_e2e_no_symlink_from_home "$path" || return 1
}

cmux_e2e_mkdir_secure() {
  local path="$1" root cur part rel
  local -a parts
  root=$(cmux_e2e_cache_root) || return 1
  cmux_e2e_secure_path "$path" || return 1
  mkdir -p "$path" || return 1
  cur="$root"
  chmod 700 "$cur" || return 1
  rel="${path#"$root"}"
  IFS='/' read -r -a parts <<< "$rel"
  for part in "${parts[@]}"; do
    [[ -n "$part" ]] || continue
    cur="$cur/$part"
    [[ -d "$cur" && ! -L "$cur" ]] || return 1
    chmod 700 "$cur" || return 1
  done
}

cmux_e2e_install_file() {
  local tmp="$1" dest="$2"
  cmux_e2e_secure_path "$dest" || return 1
  [[ -f "$tmp" && ! -L "$tmp" ]] || return 1
  if [[ -e "$dest" || -L "$dest" ]]; then
    [[ -f "$dest" && ! -L "$dest" ]] || return 1
  fi
  cmux_e2e_mkdir_secure "$(dirname "$dest")" || return 1
  chmod 600 "$tmp" || return 1
  mv -- "$tmp" "$dest" || return 1
  [[ -f "$dest" && ! -L "$dest" ]] || return 1
  chmod 600 "$dest"
}

_cmux_e2e_path_below() {
  local path="$1" root="$2"
  [[ "$root" == /* && "$path" == "$root"* ]] || return 1
  [[ "$path" == "$root" || "$path" == "$root/"* ]] || return 1
}

cmux_e2e_secure_artifact() {
  local path="$1" root="$2" rel cur part
  local -a parts
  _cmux_e2e_path_below "$path" "$root" || return 1
  _cmux_e2e_no_dot_components "$path" || return 1
  [[ -L "$root" ]] && return 1
  rel="${path#"$root"}"; rel="${rel#/}"
  cur="$root"
  IFS='/' read -r -a parts <<< "$rel"
  for part in "${parts[@]}"; do
    [[ -n "$part" ]] || continue
    cur="$cur/$part"
    [[ -L "$cur" ]] && return 1
  done
  if [[ -e "$path" ]]; then
    [[ -f "$path" ]] || return 1
  fi
}
