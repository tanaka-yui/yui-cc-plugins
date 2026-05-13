#!/usr/bin/env bash
# setsid-compat.sh — exec a command in a new session, falling back to perl on macOS.
# Usage: setsid-compat.sh <command> [args...]

set -euo pipefail

if command -v setsid >/dev/null 2>&1; then
  exec setsid "$@"
elif command -v perl >/dev/null 2>&1; then
  exec perl -e 'use POSIX qw(setsid); setsid or die "setsid: $!"; exec @ARGV or die "exec: $!"' -- "$@"
else
  echo "ERROR: neither setsid nor perl is available; cannot create new session" >&2
  exit 1
fi
