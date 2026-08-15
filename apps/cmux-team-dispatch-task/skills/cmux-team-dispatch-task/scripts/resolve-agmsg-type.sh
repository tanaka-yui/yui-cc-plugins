#!/usr/bin/env bash

set -euo pipefail

usage() {
  echo 'Usage: resolve-agmsg-type.sh --engine <codex|claude>' >&2
  exit 2
}

ENGINE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --engine)
      [[ $# -ge 2 ]] || usage
      ENGINE="$2"
      shift 2
      ;;
    *) usage ;;
  esac
done

case "$ENGINE" in
  codex) echo 'codex' ;;
  claude) echo 'claude-code' ;;
  *) usage ;;
esac
