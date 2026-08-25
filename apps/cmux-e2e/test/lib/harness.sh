#!/usr/bin/env bash

_H_FAIL=0
_H_TMP=""

h_setup() {
  _H_TMP=$(mktemp -d)
  export HOME="$_H_TMP/home"
  mkdir -p "$HOME" "$_H_TMP/repo"
  (
    cd "$_H_TMP/repo" || exit 1
    git init -q
    git config user.email t@example.com
    git config user.name t
    git commit -q --allow-empty -m init
  )
  cd "$_H_TMP/repo" || exit 1
  export CMUX_STUB_LOG="$_H_TMP/calls.log"
  : > "$CMUX_STUB_LOG"
  export CMUX_STUB_TREE="$_H_TMP/tree.json"
  h_tree_empty
}

h_tmp() { printf '%s' "$_H_TMP"; }

h_tree() {
  local out='' first=1
  while [[ $# -ge 3 ]]; do
    [[ "$first" -eq 1 ]] || out+=','
    first=0
    out+=$(printf '{"id":"%s","ref":"%s","type":"%s"}' "$1" "$2" "$3")
    shift 3
  done
  printf '{"windows":[{"workspaces":[{"panes":[{"surfaces":[%s]}]}]}]}\n' "$out" > "$CMUX_STUB_TREE"
}

h_tree_empty() { printf '{"windows":[{"workspaces":[{"panes":[{"surfaces":[]}]}]}]}\n' > "$CMUX_STUB_TREE"; }

h_check() {
  if [[ "$2" == "$3" ]]; then
    echo "ok   - $1"
  else
    echo "FAIL - $1: expected '$2' got '$3'"
    _H_FAIL=1
  fi
}

h_contains() {
  if [[ "$2" == *"$3"* ]]; then
    echo "ok   - $1"
  else
    echo "FAIL - $1: '$2' lacks '$3'"
    _H_FAIL=1
  fi
}

h_mode() { stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1"; }

h_assert_no_import() {
  if grep -q 'import' "$CMUX_STUB_LOG"; then
    echo 'FAIL - cmux browser import was called'
    _H_FAIL=1
  else
    echo 'ok   - import never called'
  fi
}

h_teardown() { cd /; [[ -n "$_H_TMP" ]] && rm -rf "$_H_TMP"; }
h_fail_count() { printf '%s' "$_H_FAIL"; }
