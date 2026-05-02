#!/bin/bash
# Launch a cmux workspace (or split pane) with git worktree isolation and Claude session
# Based on cmux-launch.sh with cmux-team-dispatch-task extensions
#
# Usage: launch-workspace.sh [options] <workspace-name> <prompt...>
#
# Options:
#   --cwd <path>                       Working directory (skips worktree creation)
#   --mode plan|superpowers            Claude launch mode (default: plan)
#   --status-dir <path>                Directory for writing status files
#   --layout workspace|split           Layout mode (default: workspace)
#   --split-from <surface-id>          Surface to split from (required for split mode)
#   --split-direction right|down       Split direction (default: right)
#   --parent-workspace <ws-id>         Parent workspace ID (required for split mode)
#   --parent-notify-workspace <ws-id>  Workspace to notify on completion
#   --parent-notify-surface <sf-id>    Surface to notify on completion
#   --runner <name>                    Runner name to look up in
#                                      ~/.claude/cmux-team-dispatch-task/runners.json.
#                                      Resolves to {command, engine} which control
#                                      the launch command for the child session.
#                                      The composed command is always wrapped in `zsh -ic "..."`
#                                      so functions and env vars from ~/.zshrc are loaded.
#                                      Default: hardcoded {claude, engine=claude}.
#
# Output: JSON to stdout with workspace/pane details
# Debug:  Logs to stderr

set -euo pipefail

CMUX="/Applications/cmux.app/Contents/Resources/bin/cmux"
RUNNER_SCRIPT_NAME=".cmux-team-dispatch-task-run.sh"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNERS_CONFIG_PATH="${RUNNERS_CONFIG_PATH:-$HOME/.claude/cmux-team-dispatch-task/runners.json}"

# --- Helpers ---

die() {
  echo "Error: $1" >&2
  exit 1
}

log() {
  echo "[$1] $2" >&2
}

# シェル起動検知と config 学習（split mode のみで使用）
# shellcheck source=./terminal-wait.sh
source "$SCRIPT_DIR/terminal-wait.sh"

# --- Argument Parsing ---

CWD=""
MODE="plan"
STATUS_DIR=""
LAYOUT="workspace"
SPLIT_FROM=""
SPLIT_DIRECTION="right"
PARENT_WORKSPACE=""
NOTIFY_WORKSPACE=""
NOTIFY_SURFACE=""
RUNNER_NAME=""
WORKSPACE_NAME=""
PROMPT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cwd)
      [[ $# -lt 2 ]] && die "--cwd requires a path argument"
      CWD="$2"
      shift 2
      ;;
    --mode)
      [[ $# -lt 2 ]] && die "--mode requires plan or superpowers"
      MODE="$2"
      [[ "$MODE" == "plan" || "$MODE" == "superpowers" ]] || die "--mode must be 'plan' or 'superpowers'"
      shift 2
      ;;
    --status-dir)
      [[ $# -lt 2 ]] && die "--status-dir requires a path argument"
      STATUS_DIR="$2"
      shift 2
      ;;
    --layout)
      [[ $# -lt 2 ]] && die "--layout requires workspace, split, or claude-teams"
      LAYOUT="$2"
      [[ "$LAYOUT" == "workspace" || "$LAYOUT" == "split" || "$LAYOUT" == "claude-teams" ]] || die "--layout must be 'workspace', 'split', or 'claude-teams'"
      shift 2
      ;;
    --split-from)
      [[ $# -lt 2 ]] && die "--split-from requires a surface ID"
      SPLIT_FROM="$2"
      shift 2
      ;;
    --split-direction)
      [[ $# -lt 2 ]] && die "--split-direction requires right or down"
      SPLIT_DIRECTION="$2"
      [[ "$SPLIT_DIRECTION" == "right" || "$SPLIT_DIRECTION" == "down" ]] || die "--split-direction must be 'right' or 'down'"
      shift 2
      ;;
    --parent-workspace)
      [[ $# -lt 2 ]] && die "--parent-workspace requires a workspace ID"
      PARENT_WORKSPACE="$2"
      shift 2
      ;;
    --parent-notify-workspace)
      [[ $# -lt 2 ]] && die "--parent-notify-workspace requires a workspace ID"
      NOTIFY_WORKSPACE="$2"
      shift 2
      ;;
    --parent-notify-surface)
      [[ $# -lt 2 ]] && die "--parent-notify-surface requires a surface ID"
      NOTIFY_SURFACE="$2"
      shift 2
      ;;
    --runner)
      [[ $# -lt 2 ]] && die "--runner requires a runner name"
      RUNNER_NAME="$2"
      shift 2
      ;;
    *)
      if [[ -z "$WORKSPACE_NAME" ]]; then
        WORKSPACE_NAME="$1"
        shift
      else
        # Remaining args are the prompt
        PROMPT="$*"
        break
      fi
      ;;
  esac
done

[[ -z "$WORKSPACE_NAME" ]] && die "workspace name is required. Usage: $0 [options] <workspace-name> <prompt...>"
[[ -z "$PROMPT" ]] && die "prompt is required. Usage: $0 [options] <workspace-name> <prompt...>"

# Validate workspace name: only allow safe characters for path/branch usage
[[ "$WORKSPACE_NAME" =~ ^[A-Za-z0-9._-]+$ ]] || die "invalid workspace name '$WORKSPACE_NAME': use only [A-Za-z0-9._-]"

# Validate split mode requirements
if [[ "$LAYOUT" == "split" ]]; then
  [[ -z "$PARENT_WORKSPACE" ]] && die "--parent-workspace is required when --layout is split"
  [[ -z "$SPLIT_FROM" ]] && die "--split-from is required when --layout is split"
fi

# claude-teams mode uses workspace-like creation (no split requirements)

# --- Validation ---

[[ -x "$CMUX" ]] || die "cmux is not installed at $CMUX"
command -v git &>/dev/null || die "git is not installed"
command -v jq &>/dev/null || die "jq is not installed (required for JSON output)"

# --- Resolve runner ---
# When --runner is specified, look up the runner in runners.json and extract
# {command, engine}. When unset, fall back to hardcoded claude defaults
# so the script remains usable standalone (without runners.json being present).

RUNNER_COMMAND="claude"
RUNNER_ENGINE="claude"

if [[ -n "$RUNNER_NAME" ]]; then
  [[ -f "$RUNNERS_CONFIG_PATH" ]] || die "runners.json not found at $RUNNERS_CONFIG_PATH (required when --runner is specified)"
  RUNNER_JSON=$(jq --arg n "$RUNNER_NAME" '.runners[]? | select(.name == $n)' "$RUNNERS_CONFIG_PATH" 2>/dev/null) \
    || die "failed to parse runners.json at $RUNNERS_CONFIG_PATH"
  [[ -n "$RUNNER_JSON" ]] || die "runner '$RUNNER_NAME' not found in $RUNNERS_CONFIG_PATH"

  RUNNER_COMMAND=$(echo "$RUNNER_JSON" | jq -r '.command // empty')
  RUNNER_ENGINE=$(echo "$RUNNER_JSON" | jq -r '.engine // "claude"')

  [[ -n "$RUNNER_COMMAND" ]] || die "runner '$RUNNER_NAME' is missing 'command' field"
  [[ "$RUNNER_ENGINE" == "claude" || "$RUNNER_ENGINE" == "codex" ]] \
    || die "runner '$RUNNER_NAME' has invalid engine '$RUNNER_ENGINE' (must be 'claude' or 'codex')"
fi

log "runner" "name=${RUNNER_NAME:-<default>} command=$RUNNER_COMMAND engine=$RUNNER_ENGINE"

# Resolve git repo info
REPO_ROOT=""
if [[ -n "$CWD" ]]; then
  REPO_ROOT=$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null || true)
  REPO_NAME=$(basename "${REPO_ROOT:-$CWD}")
else
  REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || die "not inside a git repository"
  REPO_NAME=$(basename "$REPO_ROOT")
fi

# --- Step 1: Git Worktree (skip if --cwd specified) ---

BRANCH_NAME=""
WORKTREE_PATH=""

if [[ -n "$CWD" ]]; then
  [[ -d "$CWD" ]] || die "specified --cwd path does not exist: $CWD"
  log "worktree" "skipped (using --cwd: $CWD)"
else
  WORKTREE_PATH="$REPO_ROOT/.worktrees/$WORKSPACE_NAME"
  BRANCH_NAME="feat/$WORKSPACE_NAME"

  if [[ -d "$WORKTREE_PATH" ]]; then
    log "worktree" "already exists at $WORKTREE_PATH, reusing"
  else
    log "worktree" "creating $WORKTREE_PATH with branch $BRANCH_NAME"
    if ! git worktree add "$WORKTREE_PATH" -b "$BRANCH_NAME" 2>/dev/null; then
      # Branch might already exist, try without -b
      log "worktree" "branch $BRANCH_NAME exists, checking out"
      git worktree add "$WORKTREE_PATH" "$BRANCH_NAME" 2>/dev/null || die "failed to create worktree at $WORKTREE_PATH"
    fi
  fi
  CWD="$WORKTREE_PATH"
fi

# --- Step 2: Write prompt file ---
# Writing to a file avoids all shell escaping issues when passing complex
# prompt text (JSON, quotes, special chars) through cmux send / --command.

FULL_PROMPT="$PROMPT"
PROMPT_FILE="$CWD/.cmux-team-dispatch-task-prompt.md"
printf '%s\n' "$FULL_PROMPT" > "$PROMPT_FILE"
log "prompt" "wrote prompt to $PROMPT_FILE"

# --- Step 3: Build runner command ---
# Build the launch command per (engine × MODE) and wrap with `zsh -ic` so that
# user-defined functions and env vars from ~/.zshrc (e.g. ccenec, ccgpt, proxy
# auth) are always resolved.
#
# claude-teams layout uses `cmux claude-teams` (claude-only) and ignores --runner.

PROMPT_TEXT="Read and follow the task in .cmux-team-dispatch-task-prompt.md"

if [[ "$LAYOUT" == "claude-teams" ]]; then
  # claude-teams mode: --runner is ignored; claude-teams only supports claude.
  if [[ "$MODE" == "superpowers" ]]; then
    # superpowers mode: --dangerously-skip-permissions を使わない
    # --dangerously-skip-permissions は AskUserQuestion もバイパスしてしまうため、
    # ブレストの対話フローが機能しない。env の permissions.defaultMode: bypassPermissions は
    # ツール許可をバイパスしつつ AskUserQuestion を対話的に保つのでそちらに依存する
    CLAUDE_CMD="$CMUX claude-teams '$PROMPT_TEXT'"
  else
    CLAUDE_CMD="$CMUX claude-teams --dangerously-skip-permissions '/plan $PROMPT_TEXT'"
  fi
else
  # engine × mode で起動コマンドを構築
  if [[ "$RUNNER_ENGINE" == "codex" ]]; then
    if [[ "$MODE" == "superpowers" ]]; then
      # codex superpowers: $superpowers:brainstorming プレフィックスで brainstorming skill を発動
      CORE_CMD="$RUNNER_COMMAND '\$superpowers:brainstorming $PROMPT_TEXT'"
    else
      # codex plan: claude の --dangerously-skip-permissions に相当するのは
      # --dangerously-bypass-approvals-and-sandbox。/plan slash command は codex でも有効
      CORE_CMD="$RUNNER_COMMAND --dangerously-bypass-approvals-and-sandbox '/plan $PROMPT_TEXT'"
    fi
  else
    # claude engine (default)
    if [[ "$MODE" == "superpowers" ]]; then
      CORE_CMD="$RUNNER_COMMAND '$PROMPT_TEXT'"
    else
      CORE_CMD="$RUNNER_COMMAND --dangerously-skip-permissions '/plan $PROMPT_TEXT'"
    fi
  fi

  # 常に zsh -ic で .zshrc を読み込ませてユーザー定義関数 (ccenec 等) と env (proxy 認証 等) を解決
  CLAUDE_CMD="zsh -ic \"$CORE_CMD\""
fi

# --- Step 4: Generate runner script ---
# The runner is written BEFORE the workspace is created so it can be launched
# directly via `cmux new-workspace --command "bash <runner>"`. That removes
# the race between shell readiness detection and `cmux send`, which was
# unreliable on environments where the new workspace surface is not a plain
# terminal at creation time.
#
# The runner resolves its own workspace/surface IDs at runtime (env vars first,
# `cmux identify` as fallback) so we don't need them baked in at generation.

RUNNER_FILE="$CWD/$RUNNER_SCRIPT_NAME"
cat > "$RUNNER_FILE" <<EOF
#!/bin/bash
set -uo pipefail

CMUX="${CMUX}"
STATUS_DIR="${STATUS_DIR}"
SLUG="${WORKSPACE_NAME}"

# Resolve the workspace / surface IDs we are running inside.
# cmux normally exports CMUX_WORKSPACE_ID and CMUX_SURFACE_ID into spawned shells;
# if they are missing, fall back to \`cmux identify\`.
WORKSPACE_ID="\${CMUX_WORKSPACE_ID:-}"
SURFACE_ID="\${CMUX_SURFACE_ID:-}"
if [[ -z "\$WORKSPACE_ID" || -z "\$SURFACE_ID" ]]; then
  _IDENT=\$("\$CMUX" identify 2>/dev/null || true)
  if [[ -n "\$_IDENT" ]]; then
    [[ -z "\$WORKSPACE_ID" ]] && WORKSPACE_ID=\$(echo "\$_IDENT" | jq -r '.caller.workspace_ref // empty' 2>/dev/null || echo "")
    [[ -z "\$SURFACE_ID" ]]   && SURFACE_ID=\$(echo "\$_IDENT"   | jq -r '.caller.surface_ref // empty'   2>/dev/null || echo "")
  fi
fi

write_status() {
  local status="\$1"
  local message="\$2"
  if [[ -n "\$STATUS_DIR" ]]; then
    mkdir -p "\$STATUS_DIR"
    jq -n --arg s "\$status" --arg m "\$message" --arg ws "\$WORKSPACE_ID" --arg sf "\$SURFACE_ID" \\
      '{status:\$s, message:\$m, workspace_id:\$ws, surface_id:\$sf, timestamp:(now|todate)}' \\
      > "\$STATUS_DIR/status.json"
  fi
}

write_status "executing" "Claude session starting"

${CLAUDE_CMD}
CLAUDE_EXIT=\$?

if [[ \$CLAUDE_EXIT -eq 0 ]]; then
  write_status "done" "Claude session completed (exit 0)"
else
  write_status "error" "Claude session exited with code \$CLAUDE_EXIT"
fi

"\$CMUX" wait-for --signal "${WORKSPACE_NAME}-done" 2>/dev/null || true

NOTIFY_WS="${NOTIFY_WORKSPACE}"
if [[ -n "\$NOTIFY_WS" ]]; then
  "\$CMUX" notify --title "Done: ${WORKSPACE_NAME}" \\
    --body "Exit code: \$CLAUDE_EXIT" \\
    --workspace "\$NOTIFY_WS" 2>/dev/null || true
fi

# --- 親ターミナルにテキスト通知を送信 ---
NOTIFY_SF="${NOTIFY_SURFACE}"
LAYOUT_MODE="${LAYOUT}"
STATUS_LABEL="done"
if [[ \$CLAUDE_EXIT -ne 0 ]]; then
  STATUS_LABEL="error"
fi

# cmux send だけでは親が claude TUI の場合 input box にテキストが残って Enter が
# 押されないため、必ず send-key return を続けて発行する。
NOTIFY_MSG="[dispatch] task \"${WORKSPACE_NAME}\" finished (status: \$STATUS_LABEL)"
if [[ "\$LAYOUT_MODE" == "split" && -n "\$NOTIFY_SF" ]]; then
  "\$CMUX" send --surface "\$NOTIFY_SF" "\$NOTIFY_MSG" 2>/dev/null || true
  "\$CMUX" send-key --surface "\$NOTIFY_SF" return 2>/dev/null || true
elif [[ -n "\$NOTIFY_WS" ]]; then
  "\$CMUX" send --workspace "\$NOTIFY_WS" "\$NOTIFY_MSG" 2>/dev/null || true
  "\$CMUX" send-key --workspace "\$NOTIFY_WS" return 2>/dev/null || true
fi
EOF
chmod +x "$RUNNER_FILE"
log "runner" "generated $RUNNER_FILE"

# --- Step 5: Create cmux workspace OR split pane ---

WORKSPACE_ID=""
SURFACE_ID=""
TITLE=""

if [[ "$LAYOUT" == "workspace" || "$LAYOUT" == "claude-teams" ]]; then
  # --- Workspace Mode / Claude Teams Mode ---
  # Use `--command` so the runner starts the instant the workspace shell is ready.
  # This is strictly better than creating the workspace and then sending the
  # runner via `cmux send`: on some environments the new surface is not a
  # terminal at creation time, which previously caused dropped commands.
  log "cmux" "creating workspace with cwd=$CWD (layout: $LAYOUT), auto-launching runner via --command"
  WORKSPACE_OUTPUT=$("$CMUX" new-workspace --cwd "$CWD" --command "bash $RUNNER_SCRIPT_NAME" 2>/dev/null) \
    || die "failed to create cmux workspace"
  WORKSPACE_ID=$(echo "$WORKSPACE_OUTPUT" | grep -oE 'workspace:[0-9]+' | head -1)
  [[ -z "$WORKSPACE_ID" ]] && die "failed to parse workspace ID from output: $WORKSPACE_OUTPUT"
  log "cmux" "created $WORKSPACE_ID"

  # Rename workspace
  TITLE="[$REPO_NAME] $WORKSPACE_NAME"
  "$CMUX" rename-workspace --workspace "$WORKSPACE_ID" "$TITLE" 2>/dev/null || die "failed to rename workspace"
  log "cmux" "renamed to: $TITLE"

  # Get surface ID (for initial status payload; the runner resolves its own at runtime)
  SURFACE_OUTPUT=$("$CMUX" list-pane-surfaces --workspace "$WORKSPACE_ID" 2>/dev/null) || die "failed to list pane surfaces"
  SURFACE_ID=$(echo "$SURFACE_OUTPUT" | grep -oE 'surface:[0-9]+' | head -1)
  [[ -z "$SURFACE_ID" ]] && die "failed to parse surface ID from output: $SURFACE_OUTPUT"
  log "cmux" "surface: $SURFACE_ID"

elif [[ "$LAYOUT" == "split" ]]; then
  # --- Split Mode: Create new pane in existing workspace ---
  # `cmux new-split` does not support --command, so we fall back to the
  # send-after-create approach with shell readiness detection.
  WORKSPACE_ID="$PARENT_WORKSPACE"
  TITLE="$WORKSPACE_NAME"

  log "cmux" "splitting $SPLIT_DIRECTION from $SPLIT_FROM in $WORKSPACE_ID"
  SPLIT_OUTPUT=$("$CMUX" new-split "$SPLIT_DIRECTION" \
    --workspace "$WORKSPACE_ID" \
    --surface "$SPLIT_FROM" 2>/dev/null) || die "failed to create split pane"
  SURFACE_ID=$(echo "$SPLIT_OUTPUT" | grep -oE 'surface:[0-9]+' | head -1)
  [[ -z "$SURFACE_ID" ]] && die "failed to parse surface ID from split output: $SPLIT_OUTPUT"
  log "cmux" "new split surface: $SURFACE_ID"

  # Rename the tab for the new split pane
  "$CMUX" rename-tab --workspace "$WORKSPACE_ID" --surface "$SURFACE_ID" "$TITLE" 2>/dev/null || \
    log "cmux" "warning: failed to rename tab (non-fatal)"

  wait_for_shell "$SURFACE_ID" || true

  # Launch the runner via send (split mode only).
  RUNNER_CMD="bash $RUNNER_SCRIPT_NAME"
  "$CMUX" send --surface "$SURFACE_ID" \
    "cd '$CWD' && $RUNNER_CMD\n" 2>/dev/null || die "failed to send cd+runner command"
  log "cmux" "split runner command sent"
fi

# --- Step 6: Write initial "launched" status ---
# Race protection: the runner is already running in workspace/claude-teams mode,
# so it may have already written "executing"/"done"/"error" to status.json.
# Do not regress from those to "launched".

if [[ -n "$STATUS_DIR" ]]; then
  mkdir -p "$STATUS_DIR"
  existing_status=""
  if [[ -f "$STATUS_DIR/status.json" ]]; then
    existing_status=$(jq -r '.status // ""' "$STATUS_DIR/status.json" 2>/dev/null || echo "")
  fi
  case "$existing_status" in
    executing|done|error)
      log "status" "runner already at '$existing_status'; not overwriting with 'launched'"
      ;;
    *)
      jq -n \
        --arg status "launched" \
        --arg ws "$WORKSPACE_ID" \
        --arg sf "$SURFACE_ID" \
        --arg title "$TITLE" \
        --arg mode "$MODE" \
        --arg layout "$LAYOUT" \
        --arg msg "Claude session launched in $MODE mode ($LAYOUT layout)" \
        '{
          status: $status,
          workspace_id: $ws,
          surface_id: $sf,
          title: $title,
          mode: $mode,
          layout: $layout,
          message: $msg,
          timestamp: (now | todate)
        }' > "$STATUS_DIR/status.json"
      log "status" "wrote $STATUS_DIR/status.json"
      ;;
  esac
fi

# --- Output JSON ---

SIGNAL_NAME="${WORKSPACE_NAME}-done"

jq -n \
  --arg workspace_id "$WORKSPACE_ID" \
  --arg surface_id "$SURFACE_ID" \
  --arg title "$TITLE" \
  --arg cwd "$CWD" \
  --arg branch "$BRANCH_NAME" \
  --arg worktree "$WORKTREE_PATH" \
  --arg mode "$MODE" \
  --arg layout "$LAYOUT" \
  --arg split_from "$SPLIT_FROM" \
  --arg split_direction "$SPLIT_DIRECTION" \
  --arg status_dir "$STATUS_DIR" \
  --arg prompt_file "$PROMPT_FILE" \
  --arg runner_file "$RUNNER_FILE" \
  --arg signal_name "$SIGNAL_NAME" \
  --arg runner_name "$RUNNER_NAME" \
  --arg runner_command "$RUNNER_COMMAND" \
  --arg runner_engine "$RUNNER_ENGINE" \
  '{
    workspace_id: $workspace_id,
    surface_id: $surface_id,
    title: $title,
    cwd: $cwd,
    branch: (if $branch == "" then null else $branch end),
    worktree_path: (if $worktree == "" then null else $worktree end),
    mode: $mode,
    layout: $layout,
    split_from: (if $split_from == "" then null else $split_from end),
    split_direction: (if $split_direction == "" then null else $split_direction end),
    status_dir: (if $status_dir == "" then null else $status_dir end),
    prompt_file: $prompt_file,
    runner_file: $runner_file,
    signal_name: $signal_name,
    runner: {
      name: (if $runner_name == "" then null else $runner_name end),
      command: $runner_command,
      engine: $runner_engine
    },
    prompt_sent: true
  }'
