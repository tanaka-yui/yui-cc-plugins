#!/usr/bin/env bash
# engine から agmsg type を解決する実行 API と manual-child consumer を検証する。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESOLVER="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/resolve-agmsg-type.sh"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/agmsg" "$TMP/repo"
LOG="$TMP/agmsg.log"

cat > "$TMP/agmsg/join.sh" <<'STUB'
#!/usr/bin/env bash
printf 'join|%s|%s|%s|%s\n' "$1" "$2" "$3" "$4" >> "$AGMSG_TEST_LOG"
STUB
chmod +x "$TMP/agmsg/join.sh"

fail=0
bad() { echo "FAIL: $1" >&2; fail=1; }

resolve_type() {
  bash "$RESOLVER" "$@"
}

got=$(resolve_type --engine codex 2>/dev/null)
rc=$?
[[ $rc -eq 0 && $got == codex ]] || bad "codex resolves to codex (rc=$rc got=[$got])"

got=$(resolve_type --engine claude 2>/dev/null)
rc=$?
[[ $rc -eq 0 && $got == claude-code ]] || bad "claude resolves to claude-code (rc=$rc got=[$got])"

resolve_type --engine gemini >/dev/null 2>&1
rc=$?
[[ $rc -eq 2 ]] || bad "invalid engine exits 2 (got $rc)"

resolve_type >/dev/null 2>&1
rc=$?
[[ $rc -eq 2 ]] || bad "missing engine exits 2 (got $rc)"

# Non-prewarm/manual-child consumer: pass the helper result to the real join CLI boundary.
manual_child_join() {
  local engine="$1" type
  type=$(resolve_type --engine "$engine") || return
  AGMSG_TEST_LOG="$LOG" "$TMP/agmsg/join.sh" demo task-manual "$type" "$TMP/repo"
}

: > "$LOG"
manual_child_join codex || bad 'codex manual child join exits 0'
[[ $(cat "$LOG") == "join|demo|task-manual|codex|$TMP/repo" ]] || \
  bad 'codex manual child passes codex to join.sh'

: > "$LOG"
manual_child_join claude || bad 'claude manual child join exits 0'
[[ $(cat "$LOG") == "join|demo|task-manual|claude-code|$TMP/repo" ]] || \
  bad 'claude manual child passes claude-code to join.sh'

if [[ $fail -eq 0 ]]; then
  echo '--- all tests passed ---'
else
  echo '--- failures ---'
fi
exit "$fail"
