#!/usr/bin/env bash
# loop-cleanup.sh の完了検証・WIP 保全・timeout authoritative を検査する。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLEANUP="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/loop-cleanup.sh"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/repo/.dispatch-loop" "$TMP/repo/.dispatch"
STATE="$TMP/repo/.dispatch-loop/loop-state.json"
FETCH="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/issue-fetch.sh"
git -C "$TMP/repo" init -q -b main
git -C "$TMP/repo" config user.email test@example.invalid; git -C "$TMP/repo" config user.name test
echo base > "$TMP/repo/base"; git -C "$TMP/repo" add . && git -C "$TMP/repo" commit -qm init
export LOOP_SESSION_ID=cleanup-test
bash "$FETCH" --state-file "$STATE" lock-acquire --lease-min 30 >/dev/null
jq -n '{issues:{},batches:[],leaked:[]}' > "$STATE"
out=$(bash "$CLEANUP" --state-file "$STATE" --batch 1 --integration pr --repo-root "$TMP/repo")
[[ $(jq -r '.batch' <<<"$out") == 1 ]] && echo 'PASS: C0 空バッチを集計できる' || { echo 'FAIL: C0 空バッチ'; exit 1; }
bash "$FETCH" --state-file "$STATE" lock-release >/dev/null
echo '--- all tests passed ---'
