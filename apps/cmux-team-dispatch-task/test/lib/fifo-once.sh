#!/usr/bin/env bash

# Background jobs need their own process groups so a timed-out FIFO consumer and
# all of its children can be terminated together.
set -m

fifo_read_once() { # $1=label $2=source file $3..=command (FIFO path is appended)
  local label="$1" src="$2"
  shift 2
  local fifo="$TMP/in.fifo"
  rm -f "$fifo"
  mkfifo "$fifo" || {
    bad "$label (mkfifo failed)"
    return
  }
  rm -f "$TMP/fifo.rc"

  (cat "$src" > "$fifo" 2>/dev/null) &
  local wpid=$!
  ("$@" "$fifo" >/dev/null 2>&1; printf '%s' "$?" > "$TMP/fifo.rc") &
  local cpid=$!

  local i=0
  while kill -0 "$cpid" 2>/dev/null && [[ $i -lt 40 ]]; do
    sleep 0.5
    i=$((i + 1))
  done

  local timed_out=0
  if kill -0 "$cpid" 2>/dev/null; then
    timed_out=1
    kill -TERM -- "-$cpid" 2>/dev/null || kill -TERM "$cpid" 2>/dev/null || true
    sleep 1
    kill -KILL -- "-$cpid" 2>/dev/null || kill -KILL "$cpid" 2>/dev/null || true
  fi
  kill -KILL -- "-$wpid" 2>/dev/null || kill -KILL "$wpid" 2>/dev/null || true
  wait "$cpid" "$wpid" 2>/dev/null || true
  rm -f "$fifo"

  if [[ $timed_out -eq 1 ]]; then
    bad "$label — did not finish within 20 seconds; it may have blocked opening the FIFO twice"
  else
    [[ "$(cat "$TMP/fifo.rc" 2>/dev/null)" == 0 ]] \
      && ok "$label" || bad "$label (rc=$(cat "$TMP/fifo.rc" 2>/dev/null))"
  fi
  kill -0 -- "-$cpid" 2>/dev/null && bad "$label: プロセスグループが残っている" || true
}
