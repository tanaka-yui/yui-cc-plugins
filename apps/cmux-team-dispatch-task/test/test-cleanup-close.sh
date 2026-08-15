#!/usr/bin/env bash
# 親 cleanup のドキュメント化された shell 例を実行し、sparse な role-aware
# prewarm.json だけから close/leave 対象を解決することを検証する。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/SKILL.md"
GUIDE="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/references/guide-ja.md"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/repo" "$TMP/skill/scripts"
fail=0

cat > "$TMP/bin/cmux" <<'STUB'
#!/usr/bin/env bash
if [[ "$1 $2" == "workspace list" ]]; then
  echo 'workspace:13 [beta]'
  echo 'workspace:42 [alpha]'
  exit 0
fi
printf '%s\n' "$*" >> "$CMUX_TEST_LOG"
STUB
cat > "$TMP/bin/git" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
cat > "$TMP/bin/leave" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$LEAVE_TEST_LOG"
STUB
cat > "$TMP/skill/scripts/issue-fetch.sh" <<'STUB'
#!/usr/bin/env bash
exit 1
STUB
chmod +x "$TMP/bin/cmux" "$TMP/bin/git" "$TMP/bin/leave" "$TMP/skill/scripts/issue-fetch.sh"

make_fixture() {
  mkdir -p "$TMP/repo/.dispatch/alpha" "$TMP/repo/.worktrees"
  printf '{"status":"done"}\n' > "$TMP/repo/.dispatch/alpha/status.json"
  cat > "$TMP/repo/.dispatch/alpha/prewarm.json" <<'JSON'
{
  "design": {"surface_id":"surface:7", "agent":"alpha-design"},
  "review": {"surface_id":"surface:8", "agent":"alpha-review"},
  "executors": {
    "codex": {"surface_id":"surface:7", "agent":"alpha-design"}
  }
}
JSON
}

extract_block() {
  local file="$1" occurrence="$2" output="$3"
  awk -v wanted="$occurrence" '
    /^### Cleanup prompts/ { section=1 }
    section && /^[[:space:]]*for slug in <task-slugs>; do$/ { count++; if (count == wanted) capture=1 }
    capture && /^[[:space:]]*```$/ { exit }
    capture { sub(/^  /, ""); print }
  ' "$file" > "$output"
}

assert_line_count() {
  local file="$1" expected="$2" pattern="$3" label="$4" actual
  actual=$(grep -Fxc -- "$pattern" "$file" 2>/dev/null || true)
  if [[ "$actual" == "$expected" ]]; then
    echo "PASS $label"
  else
    echo "FAIL $label: expected=$expected actual=$actual pattern=$pattern"
    fail=1
  fi
}

for doc in "$SKILL" "$GUIDE"; do
  name=$(basename "$doc")
  cleanup_src="$TMP/$name-cleanup-src.sh"
  cleanup_run="$TMP/$name-cleanup-run.sh"
  extract_block "$doc" 1 "$cleanup_src"
  sed -e 's/<task-slugs>/alpha/g' -e "s|<this-skill-dir>|$TMP/skill|g" "$cleanup_src" > "$cleanup_run"
  make_fixture
  cmux_log="$TMP/$name-cmux.log"
  : > "$cmux_log"
  (
    cd "$TMP/repo" || exit 1
    close_all=true remove_wt_all=false delete_br_all=false \
      CMUX_TEST_LOG="$cmux_log" PATH="$TMP/bin:$PATH" bash "$cleanup_run"
  ) >/dev/null 2>&1 || { echo "FAIL $name cleanup example did not execute"; fail=1; }

  assert_line_count "$cmux_log" 1 'close-workspace --workspace workspace:42' "$name fallback workspace close"
  assert_line_count "$cmux_log" 1 'close-surface --workspace workspace:42 --surface surface:7' "$name de-duplicates design surface"
  assert_line_count "$cmux_log" 1 'close-surface --workspace workspace:42 --surface surface:8' "$name closes review surface"

  leave_src="$TMP/$name-leave-src.sh"
  leave_run="$TMP/$name-leave-run.sh"
  extract_block "$doc" 2 "$leave_src"
  sed -e 's/<task-slugs>/alpha/g' -e "s|~/.agents/skills/agmsg/scripts/leave.sh|$TMP/bin/leave|g" "$leave_src" > "$leave_run"
  make_fixture
  leave_log="$TMP/$name-leave.log"
  : > "$leave_log"
  (
    cd "$TMP/repo" || exit 1
    TEAM=demo LEAVE_TEST_LOG="$leave_log" bash "$leave_run"
  ) >/dev/null 2>&1 || { echo "FAIL $name leave example did not execute"; fail=1; }

  assert_line_count "$leave_log" 1 'demo alpha-design' "$name de-duplicates actual design agent"
  assert_line_count "$leave_log" 1 'demo alpha-review' "$name leaves actual review agent"
  if grep -Eq 'alpha-(sonnet|codex|opus)' "$leave_log"; then
    echo "FAIL $name synthesized a non-existent agent"
    fail=1
  else
    echo "PASS $name does not synthesize absent agents"
  fi
done

exit "$fail"
