#!/usr/bin/env bash
# spawn-command.sh — spawn a `type: command` service as a session leader.
# Usage: spawn-command.sh <config-file> <service-name> <env-dispatch-file> <processes-json>
# Outputs nothing on stdout; on success the processes.json is updated.

set -euo pipefail

CONFIG_FILE="$1"
SVC_NAME="$2"
ENV_FILE="$3"
PROCESSES_JSON="$4"

WORKTREE_ROOT=$(git rev-parse --show-toplevel)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Find the service block.
SVC_INDEX=$(yq -r ".services | to_entries | map(select(.value.name == \"$SVC_NAME\")) | .[0].key" "$CONFIG_FILE")
[[ "$SVC_INDEX" == "null" ]] && { echo "ERROR: service not found: $SVC_NAME" >&2; exit 1; }

CWD=$(yq -r ".services[$SVC_INDEX].cwd // \".\"" "$CONFIG_FILE")
CMD=$(yq -r ".services[$SVC_INDEX].command" "$CONFIG_FILE")
LOG_FILE=$(yq -r ".services[$SVC_INDEX].log_file // \"\"" "$CONFIG_FILE")
[[ -z "$LOG_FILE" ]] && LOG_FILE=".dev-up-logs/$SVC_NAME.log"

# Resolve LOG_FILE relative to worktree root.
case "$LOG_FILE" in /*) ABS_LOG="$LOG_FILE";; *) ABS_LOG="$WORKTREE_ROOT/$LOG_FILE";; esac
mkdir -p "$(dirname "$ABS_LOG")"

# Resolve CWD relative to worktree root.
case "$CWD" in /*) ABS_CWD="$CWD";; *) ABS_CWD="$WORKTREE_ROOT/$CWD";; esac
[[ -d "$ABS_CWD" ]] || { echo "ERROR: cwd does not exist: $ABS_CWD" >&2; exit 1; }

# Collect env_files (worktree-root relative).
ENV_FILE_ARGS=()
while IFS= read -r ef; do
  [[ -z "$ef" ]] && continue
  case "$ef" in /*) abs="$ef";; *) abs="$WORKTREE_ROOT/$ef";; esac
  [[ -f "$abs" ]] || { echo "ERROR: env_file not found: $abs" >&2; exit 1; }
  ENV_FILE_ARGS+=("$abs")
done < <(yq -r "(.services[$SVC_INDEX].env_files // []) | .[]" "$CONFIG_FILE")

# Build env-loading commands: env_files → .env.dispatch.
# (env_overrides are already merged into .env.dispatch by render-env.sh)
ENV_LOAD=""
for ef in "${ENV_FILE_ARGS[@]+"${ENV_FILE_ARGS[@]}"}"; do
  ENV_LOAD+="set -a; source '$ef'; set +a; "
done
ENV_LOAD+="set -a; source '$ENV_FILE'; set +a; "

# Build a self-contained wrapper script that loads env, cds, and execs the command.
# Using a wrapper file avoids quoting hell with nested bash -c invocations.
WRAPPER=$(mktemp)
{
  echo "#!/usr/bin/env bash"
  echo "set -euo pipefail"
  echo "$ENV_LOAD"
  echo "cd \"$ABS_CWD\""
  echo "exec $CMD"
} > "$WRAPPER"
chmod +x "$WRAPPER"

# Spawn in a new session, redirecting stdout/stderr to log.
bash "$SCRIPT_DIR/setsid-compat.sh" "$WRAPPER" >> "$ABS_LOG" 2>&1 &
SPAWN_PID=$!

# Schedule wrapper cleanup: the bash process opens and reads the file at start,
# so we can safely delete it after a short delay.
( sleep 5; rm -f "$WRAPPER" ) &
disown

# Wait briefly for the session leader to be established, then read PGID.
sleep 0.3
if ! kill -0 "$SPAWN_PID" 2>/dev/null; then
  echo "ERROR: command spawned but died immediately. See log: $ABS_LOG" >&2
  exit 1
fi

PGID=$(ps -o pgid= -p "$SPAWN_PID" | tr -d ' ')
STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Build depends_on JSON array.
DEPS_JSON=$(yq -o=json -I=0 ".services[$SVC_INDEX].depends_on // []" "$CONFIG_FILE")

# Append/update the entry in processes.json.
TMP=$(mktemp)
jq --arg name "$SVC_NAME" \
   --argjson pid "$SPAWN_PID" \
   --argjson pgid "$PGID" \
   --arg started_at "$STARTED_AT" \
   --arg log_file "$ABS_LOG" \
   --argjson deps "$DEPS_JSON" \
   '. + { ($name): { pid: $pid, pgid: $pgid, started_at: $started_at, log_file: $log_file, depends_on: $deps } }' \
   "$PROCESSES_JSON" > "$TMP"
mv "$TMP" "$PROCESSES_JSON"

echo "spawned $SVC_NAME: pid=$SPAWN_PID pgid=$PGID log=$ABS_LOG" >&2
