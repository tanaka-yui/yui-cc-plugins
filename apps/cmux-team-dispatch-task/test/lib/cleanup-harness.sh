#!/usr/bin/env bash
# Self-contained loop-cleanup.sh harness. The caller supplies SCRIPT_DIR and TMP.

CLEANUP_HARNESS_ROOT="$TMP/cleanup-harness"
CLEANUP_HARNESS_SCRIPTS="$CLEANUP_HARNESS_ROOT/scripts"
CLEANUP_HARNESS_BIN="$CLEANUP_HARNESS_ROOT/bin"
CLEANUP_HARNESS_HOME="$CLEANUP_HARNESS_ROOT/home"
CLEANUP_HARNESS_REPO="$CLEANUP_HARNESS_ROOT/repo"
CLEANUP_HARNESS_CONFIG="$CLEANUP_HARNESS_ROOT/config"
mkdir -p "$CLEANUP_HARNESS_SCRIPTS" "$CLEANUP_HARNESS_BIN" \
  "$CLEANUP_HARNESS_HOME/.agents/skills/agmsg/scripts" "$CLEANUP_HARNESS_REPO" "$CLEANUP_HARNESS_CONFIG"
cp "$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/loop-cleanup.sh" \
  "$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/config-lib.sh" "$CLEANUP_HARNESS_SCRIPTS/"
CLEANUP_HARNESS_SCRIPT="$CLEANUP_HARNESS_SCRIPTS/loop-cleanup.sh"

cat > "$CLEANUP_HARNESS_SCRIPTS/issue-fetch.sh" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
cat > "$CLEANUP_HARNESS_BIN/git" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  *'symbolic-ref --short HEAD'*) echo main ;;
  *'rev-list --count'*) echo 1 ;;
esac
exit 0
STUB
cat > "$CLEANUP_HARNESS_BIN/gh" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
cat > "$CLEANUP_HARNESS_BIN/cmux" <<'STUB'
#!/usr/bin/env bash
if [[ "$1 $2" == 'workspace list' ]]; then
  cat "$CLEANUP_HARNESS_WORKSPACES"
  exit 0
fi
printf '%s\n' "cmux $*" >> "$CLEANUP_HARNESS_CALLS"
STUB
cat > "$CLEANUP_HARNESS_HOME/.agents/skills/agmsg/scripts/leave.sh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "leave.sh $*" >> "$CLEANUP_HARNESS_CALLS"
STUB
chmod +x "$CLEANUP_HARNESS_SCRIPTS/issue-fetch.sh" "$CLEANUP_HARNESS_BIN/"* \
  "$CLEANUP_HARNESS_HOME/.agents/skills/agmsg/scripts/leave.sh"
cat > "$CLEANUP_HARNESS_CONFIG/runners.json" <<'JSON'
{"default":"ccf","runners":[{"name":"ccf","command":"ccf","engine":"claude"},
                            {"name":"cx","command":"codex","engine":"codex"}]}
JSON

export CLEANUP_HARNESS_CALLS="$CLEANUP_HARNESS_ROOT/calls.log"
export CLEANUP_HARNESS_WORKSPACES="$CLEANUP_HARNESS_ROOT/workspaces.txt"
export CLEANUP_HARNESS_STDERR="$CLEANUP_HARNESS_ROOT/stderr.log"
: > "$CLEANUP_HARNESS_CALLS"
: > "$CLEANUP_HARNESS_WORKSPACES"
: > "$CLEANUP_HARNESS_STDERR"

cleanup_stub_workspace() { # $1=workspace id, optional $2=slug
  local workspace_id="$1" slug="${2:-t}"
  printf '%s [%s]\n' "$workspace_id" "$slug" > "$CLEANUP_HARNESS_WORKSPACES"
  : > "$CLEANUP_HARNESS_CALLS"
}

run_cleanup_for_slug() { # $1=slug $2=dispatch dir [$3=status] [$4=integration]
  local slug="$1" dispatch_dir="$2" status="${3:-error}" integration="${4:-pr}"
  local state="$CLEANUP_HARNESS_ROOT/state.json"
  jq -n --arg slug "$slug" --arg status "$status" \
    '{issues:{"1":{slug:$slug,status:$status,batch:1}},batches:[],leaked:[]}' > "$state"
  : > "$CLEANUP_HARNESS_STDERR"
  HOME="$CLEANUP_HARNESS_HOME" DISPATCH_CONFIG_HOME="$CLEANUP_HARNESS_CONFIG" \
    PATH="$CLEANUP_HARNESS_BIN:$PATH" \
    bash "$CLEANUP_HARNESS_SCRIPT" --state-file "$state" --batch 1 --integration "$integration" \
      --dispatch-dir "$dispatch_dir" --repo-root "$CLEANUP_HARNESS_REPO" --agmsg-team demo \
      2> "$CLEANUP_HARNESS_STDERR"
}

run_cleanup_with_prewarm() { # $1=prewarm path (may be a FIFO)
  local prewarm_path="$1" dispatch="$CLEANUP_HARNESS_ROOT/fifo-dispatch"
  mkdir -p "$dispatch/t"
  rm -f "$dispatch/t/prewarm.json"
  ln -s "$prewarm_path" "$dispatch/t/prewarm.json"
  cleanup_stub_workspace 'workspace:1' t
  run_cleanup_for_slug t "$dispatch"
}
