#!/usr/bin/env bash
# 親 cleanup の文書化された shell 例を実行し、4 ロールの明示列挙と
# prewarm workspace の照合を検証する。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/SKILL.md"
GUIDE="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/references/guide-ja.md"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/repo" "$TMP/skill/scripts" "$TMP/config"
fail=0

cp "$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/config-lib.sh" "$TMP/skill/scripts/config-lib.sh"

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

cat > "$TMP/config/runners.json" <<'JSON'
{"default":"ccf","runners":[{"name":"ccf","command":"ccf","engine":"claude"}]}
JSON
export DISPATCH_CONFIG_HOME="$TMP/config"

make_fixture() {
  local workspace="$1" mode="$2"
  mkdir -p "$TMP/repo/.dispatch/alpha" "$TMP/repo/.worktrees"
  jq -n --arg ws "$workspace" --arg mode "$mode" '
    {workspace_id:$ws,review_mode:$mode,
     design:{surface_id:"surface:7",agent:"alpha",runner:"ccf",engine:"claude",model:"opus[1m]",effort:"xhigh",wired:true},
     exec:{surface_id:"surface:9",agent:"alpha-exec",runner:"ccf",engine:"claude",model:"sonnet",effort:"high",wired:true}}
    + if $mode == "on" then {
       design_review:{surface_id:"surface:8",agent:"alpha-design-review",runner:"ccf",engine:"claude",model:"opus[1m]",effort:"xhigh",wired:true},
       exec_review:{surface_id:"surface:10",agent:"alpha-exec-review",runner:"ccf",engine:"claude",model:"opus[1m]",effort:"xhigh",wired:true}}
      else {} end' > "$TMP/repo/.dispatch/alpha/prewarm.json"
  printf '%s\n' '{"status":"done"}' > "$TMP/repo/.dispatch/alpha/status.json"
}

extract_block() {
  local file="$1" occurrence="$2" output="$3"
  awk -v wanted="$occurrence" '
    /^### Cleanup prompts/ { section=1 }
    section && /^[[:space:]]*\. <this-skill-dir>\/scripts\/config-lib.sh$/ {
      count++; if (count == wanted) capture=1
    }
    capture && /^[[:space:]]*```$/ { exit }
    capture { sub(/^  /, ""); print }
  ' "$file" > "$output"
}

close_count() { grep -c '^close-surface ' "$1" 2>/dev/null || true; }

for doc in "$SKILL" "$GUIDE"; do
  name=$(basename "$doc")
  close_src="$TMP/$name-close-src.sh"
  close_run="$TMP/$name-close-run.sh"
  extract_block "$doc" 1 "$close_src"
  sed -e 's/<task-slugs>/alpha/g' -e "s|<this-skill-dir>|$TMP/skill|g" "$close_src" > "$close_run"

  run_close() {
    local workspace="$1" mode="$2" log="$TMP/$name-close.log"
    make_fixture "$workspace" "$mode"
    : > "$log"
    (
      cd "$TMP/repo" || exit 1
      close_all=true remove_wt_all=false delete_br_all=false \
        CMUX_TEST_LOG="$log" PATH="$TMP/bin:$PATH" bash "$close_run"
    ) >/dev/null 2>&1 || {
      echo "FAIL $name cleanup example did not execute" >&2
      echo execution-error
      return
    }
    close_count "$log"
  }

  [[ "$(run_close 'workspace:42' on)" == 4 ]] \
    && echo "PASS $name CL3a: review on で 4 件 close" \
    || { echo "FAIL $name CL3a"; fail=1; }
  [[ "$(run_close 'workspace:42' off)" == 2 ]] \
    && echo "PASS $name CL3b: review off で 2 件 close" \
    || { echo "FAIL $name CL3b"; fail=1; }
  [[ "$(run_close 'workspace:999' on)" == 0 ]] \
    && echo "PASS $name CL3c: workspace 不一致では close しない" \
    || { echo "FAIL $name CL3c"; fail=1; }

  make_fixture 'workspace:999' on
  printf '%s\n' '{"status":"done","workspace_id":"workspace:999"}' > "$TMP/repo/.dispatch/alpha/status.json"
  log="$TMP/$name-stale.log"; : > "$log"
  (
    cd "$TMP/repo" || exit 1
    close_all=true remove_wt_all=false delete_br_all=false \
      CMUX_TEST_LOG="$log" PATH="$TMP/bin:$PATH" bash "$close_run"
  ) >/dev/null 2>&1 || { echo "FAIL $name stale cleanup example did not execute"; fail=1; }
  [[ "$(close_count "$log")" == 0 ]] \
    && echo "PASS $name CL3d: status.json は照合元にならない" \
    || { echo "FAIL $name CL3d: status.json 経由で close した"; fail=1; }

  leave_src="$TMP/$name-leave-src.sh"
  leave_run="$TMP/$name-leave-run.sh"
  extract_block "$doc" 2 "$leave_src"
  sed -e 's/<task-slugs>/alpha/g' -e "s|<this-skill-dir>|$TMP/skill|g" \
    -e "s|~/.agents/skills/agmsg/scripts/leave.sh|$TMP/bin/leave|g" "$leave_src" > "$leave_run"
  make_fixture 'workspace:42' on
  leave_log="$TMP/$name-leave.log"; : > "$leave_log"
  (
    cd "$TMP/repo" || exit 1
    TEAM=demo LEAVE_TEST_LOG="$leave_log" PATH="$TMP/bin:$PATH" bash "$leave_run"
  ) >/dev/null 2>&1 || { echo "FAIL $name leave example did not execute"; fail=1; }
  [[ "$(wc -l < "$leave_log" | tr -d ' ')" == 4 ]] \
    && echo "PASS $name CL4: 4 ロールの実在 agent を leave" \
    || { echo "FAIL $name CL4"; fail=1; }

  assert_invalid_snapshot_is_inert() {
    local label="$1" filter="$2" mutated
    mutated="$TMP/$name-$label.json"
    make_fixture 'workspace:42' on
    jq "$filter" "$TMP/repo/.dispatch/alpha/prewarm.json" > "$mutated" \
      && mv "$mutated" "$TMP/repo/.dispatch/alpha/prewarm.json"

    local close_log="$TMP/$name-$label-close.log"
    local invalid_leave_log="$TMP/$name-$label-leave.log"
    : > "$close_log"; : > "$invalid_leave_log"
    (
      cd "$TMP/repo" || exit 1
      close_all=true remove_wt_all=false delete_br_all=false \
        CMUX_TEST_LOG="$close_log" PATH="$TMP/bin:$PATH" bash "$close_run"
      TEAM=demo LEAVE_TEST_LOG="$invalid_leave_log" PATH="$TMP/bin:$PATH" bash "$leave_run"
    ) >/dev/null 2>&1 || {
      echo "FAIL $name $label: cleanup example did not execute"
      fail=1
      return
    }
    if [[ ! -s "$close_log" && ! -s "$invalid_leave_log" ]]; then
      echo "PASS $name $label: invalid snapshot has zero destructive side effects"
    else
      echo "FAIL $name $label: invalid snapshot triggered close or leave"
      fail=1
    fi
  }

  assert_invalid_snapshot_is_inert CL5-unregistered-runner '.design.runner = "missing"'
  assert_invalid_snapshot_is_inert CL5-engine-mismatch '.design.engine = "codex"'
  assert_invalid_snapshot_is_inert CL5-required-model-absent 'del(.exec_review.model)'
  assert_invalid_snapshot_is_inert CL5-review-off-with-review-key '.review_mode = "off"'
  assert_invalid_snapshot_is_inert CL5-allowed-key-violation '.exec.extra = "bad"'
done

exit "$fail"
