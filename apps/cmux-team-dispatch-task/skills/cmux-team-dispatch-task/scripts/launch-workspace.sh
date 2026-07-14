#!/bin/bash
# Launch a cmux workspace (or split pane) with git worktree isolation and Claude session
# Based on cmux-launch.sh with cmux-team-dispatch-task extensions
#
# Usage: launch-workspace.sh [options] <workspace-name> <prompt...>
#
# Options:
#   --cwd <path>                       Working directory (skips worktree creation)
#   --mode plan|superpowers|execute|standby  Claude launch mode (default: plan).
#                                      execute = Phase B 実行モード。計画ファイルを
#                                      inner prompt として渡し、.cmux-team-dispatch-task-prompt.md
#                                      を書き込まない。--plan-file が必須
#                                      standby = pre-warm 待機モード。--cwd 必須・prompt 省略可。
#                                      配置は 2 方式: --standby-in + --standby-split-from 指定時は
#                                      既存 workspace 内に縦分割ペイン (new-split down)、両方省略時は
#                                      新規 workspace のメイン surface で待機セッションを起動する。
#                                      wrapper は <STATUS_DIR>/.assigned が存在するときだけ
#                                      exit 時に status.json を更新する
#   --standby-in <workspace-id>        standby ペインを追加する既存 workspace (split 配置時必須)
#   --standby-split-from <surface-id>  縦分割の分割元 surface (split 配置時必須)
#   --plan-file <path>                 Plan file path (required when --mode execute).
#                                      inner prompt が
#                                      "Read and execute the plan at <path>" になる
#   --model <model>                    Model flag passed to claude as --model <X>
#                                      (例: claude-sonnet-4-6)。claude engine のみ対応
#   --skip-permissions                 claude に --dangerously-skip-permissions を
#                                      追加 (sonnet の auto mode 不在対策)。
#                                      claude engine のみ対応
#   --defer-status                     runner wrapper が exit 時に <STATUS_DIR>/.deferred
#                                      が存在する場合 status.json 更新 / 親通知 /
#                                      cmux wait-for 発火をスキップ。Phase B で別 surface に
#                                      実行を移譲する Child セッション側で常に指定する
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
#   --message-type <send-message|agmsg>  Parent notification transport (default: send-message).
#                                      send-message = cmux send + send-key return (現行動作)
#                                      agmsg = ~/.agents/skills/agmsg/scripts/send.sh で親 (agent 名
#                                      "parent") にメッセージ送信。--agmsg-team / --agmsg-from が必須
#   --agmsg-team <team>                agmsg の team 名 (message-type=agmsg 時必須)
#   --agmsg-from <agent>               agmsg の送信元 agent 名 (message-type=agmsg 時必須)
#
# Output: JSON to stdout with workspace/pane details
# Debug:  Logs to stderr

set -euo pipefail

CMUX="/Applications/cmux.app/Contents/Resources/bin/cmux"
# RUNNER_SCRIPT_NAME は WORKSPACE_NAME parse 後に解決する (一意化のため)。
# Phase B の grandchild は同じ worktree を再利用 (--cwd "$PWD") するため、固定名だと
# Child の実行中 runner ファイルを上書きしてしまい bash の挙動が undefined になる。
RUNNER_SCRIPT_NAME=""
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

# シェル起動検知と config 学習（split / standby mode で使用）
# shellcheck source=./terminal-wait.sh
source "$SCRIPT_DIR/terminal-wait.sh"

# --- Argument Parsing ---

CWD=""
MODE="plan"
STANDBY_IN=""
STANDBY_SPLIT_FROM=""
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
PLAN_FILE=""
MODEL=""
SKIP_PERMISSIONS=0
DEFER_STATUS=0
MESSAGE_TYPE="send-message"
AGMSG_TEAM=""
AGMSG_FROM=""
AGMSG_SEND="$HOME/.agents/skills/agmsg/scripts/send.sh"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cwd)
      [[ $# -lt 2 ]] && die "--cwd requires a path argument"
      CWD="$2"
      shift 2
      ;;
    --mode)
      [[ $# -lt 2 ]] && die "--mode requires plan, superpowers, execute, or standby"
      MODE="$2"
      [[ "$MODE" == "plan" || "$MODE" == "superpowers" || "$MODE" == "execute" || "$MODE" == "standby" ]] \
        || die "--mode must be 'plan', 'superpowers', 'execute', or 'standby'"
      shift 2
      ;;
    --standby-in)
      [[ $# -lt 2 ]] && die "--standby-in requires a workspace ID"
      STANDBY_IN="$2"
      shift 2
      ;;
    --standby-split-from)
      [[ $# -lt 2 ]] && die "--standby-split-from requires a surface ID"
      STANDBY_SPLIT_FROM="$2"
      shift 2
      ;;
    --plan-file)
      [[ $# -lt 2 ]] && die "--plan-file requires a path argument"
      PLAN_FILE="$2"
      shift 2
      ;;
    --model)
      [[ $# -lt 2 ]] && die "--model requires a model name"
      MODEL="$2"
      shift 2
      ;;
    --skip-permissions)
      SKIP_PERMISSIONS=1
      shift
      ;;
    --defer-status)
      DEFER_STATUS=1
      shift
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
    --message-type)
      [[ $# -lt 2 ]] && die "--message-type requires send-message or agmsg"
      MESSAGE_TYPE="$2"
      [[ "$MESSAGE_TYPE" == "send-message" || "$MESSAGE_TYPE" == "agmsg" ]] \
        || die "--message-type must be 'send-message' or 'agmsg'"
      shift 2
      ;;
    --agmsg-team)
      [[ $# -lt 2 ]] && die "--agmsg-team requires a team name"
      AGMSG_TEAM="$2"
      shift 2
      ;;
    --agmsg-from)
      [[ $# -lt 2 ]] && die "--agmsg-from requires an agent name"
      AGMSG_FROM="$2"
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

# execute mode は --plan-file が必須で PROMPT は不要 (inner prompt が plan-file 由来)
# standby mode は --standby-in / --cwd が必須で PROMPT は省略可 (idle TUI 待機)
if [[ "$MODE" == "execute" ]]; then
  [[ -n "$PLAN_FILE" ]] || die "--plan-file is required when --mode is execute"
elif [[ "$MODE" == "standby" ]]; then
  [[ -n "$CWD" ]] || die "--cwd is required when --mode is standby (reuse the task worktree)"
  # 配置は 2 方式: --standby-in + --standby-split-from = 既存 workspace 内に縦分割ペイン、
  # 両方省略 = 新規 workspace のメイン surface で standby 起動 (agmsg モードの opus ペイン用)
  if [[ -n "$STANDBY_IN" || -n "$STANDBY_SPLIT_FROM" ]]; then
    [[ -n "$STANDBY_IN" ]] || die "--standby-in is required when --standby-split-from is given"
    [[ -n "$STANDBY_SPLIT_FROM" ]] || die "--standby-split-from is required when --standby-in is given (split placement)"
  fi
else
  [[ -z "$PROMPT" ]] && die "prompt is required. Usage: $0 [options] <workspace-name> <prompt...>"
fi

# --model / --skip-permissions は claude engine 向けの拡張。codex engine では別フラグ体系のため無視
if [[ -n "$MODEL" && "$MODE" != "execute" && "$MODE" != "standby" ]]; then
  log "warn" "--model is only meaningful with --mode execute; ignoring for mode=$MODE"
fi

# Validate workspace name: only allow safe characters for path/branch usage
[[ "$WORKSPACE_NAME" =~ ^[A-Za-z0-9._-]+$ ]] || die "invalid workspace name '$WORKSPACE_NAME': use only [A-Za-z0-9._-]"

# agmsg モードは team / from が必須。send.sh が無ければインストールされていない
if [[ "$MESSAGE_TYPE" == "agmsg" ]]; then
  [[ -n "$AGMSG_TEAM" ]] || die "--agmsg-team is required when --message-type is agmsg"
  [[ -n "$AGMSG_FROM" ]] || die "--agmsg-from is required when --message-type is agmsg"
  [[ -f "$AGMSG_SEND" ]] || die "agmsg is not installed (expected $AGMSG_SEND)"
fi

# WORKSPACE_NAME 別に runner script ファイル名を unique 化する。
# Phase B grandchild (--mode execute) と Child が同じ worktree を共有する状況で、
# 旧固定名 ".cmux-team-dispatch-task-run.sh" は Child の実行中ファイルを上書きしてしまい、
# Child bash が中途半端な byte offset から書き換え後の内容を読んで undefined 挙動になっていた。
RUNNER_SCRIPT_NAME=".cmux-team-dispatch-task-run-${WORKSPACE_NAME}.sh"

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
#
# execute mode は計画ファイル (--plan-file) を直接 inner prompt に埋め込むため、
# Phase A の .cmux-team-dispatch-task-prompt.md は上書きせず温存する。

PROMPT_FILE="$CWD/.cmux-team-dispatch-task-prompt.md"
if [[ "$MODE" == "execute" || "$MODE" == "standby" ]]; then
  log "prompt" "$MODE mode: not writing prompt file"
else
  FULL_PROMPT="$PROMPT"
  printf '%s\n' "$FULL_PROMPT" > "$PROMPT_FILE"
  log "prompt" "wrote prompt to $PROMPT_FILE"
fi

# --- Step 3: Build runner command ---
# Build the launch command per (engine × MODE) and wrap with `zsh -ic` so that
# user-defined functions and env vars from ~/.zshrc (e.g. ccenec, ccgpt, proxy
# auth) are always resolved.
#
# claude-teams layout uses `cmux claude-teams` (claude-only) and ignores --runner.

# execute モードでは計画ファイルを直接 inner prompt に埋め込む。
# あわせて「完了後に必ずセッションを exit せよ」という指示を埋め込む。
# これを入れないと grandchild Claude/Codex が PR 作成後も TUI で idle 待機してしまい、
# runner wrapper の write_status "done" / signal 発火 / 親通知が永遠に発火しない。
if [[ "$MODE" == "execute" ]]; then
  if [[ "$RUNNER_ENGINE" == "codex" ]]; then
    EXIT_INSTRUCTION="After all work is committed/pushed and the PR is created (or all changes are merged per the plan), end this codex session immediately so the wrapper script can finalize completion notification. Do not leave the session idle."
  else
    EXIT_INSTRUCTION="After all work is committed/pushed and the PR is created (or all changes are merged per the plan), run /exit to close this Claude session so the wrapper script can finalize completion notification. Do not leave the session idle."
  fi
  PROMPT_TEXT="Read and execute the plan at $PLAN_FILE. ${EXIT_INSTRUCTION}"
else
  PROMPT_TEXT="Read and follow the task in .cmux-team-dispatch-task-prompt.md"
fi

if [[ "$MODE" == "standby" ]]; then
  # standby は与えられた prompt をそのまま使う (agmsg join+待機指示など)。省略時は idle TUI
  PROMPT_TEXT="$PROMPT"
fi

# claude engine の execute モード向け追加フラグ (--model / --dangerously-skip-permissions)
# 順序: <command> [--model X] [--dangerously-skip-permissions] '<inner prompt>'
CLAUDE_EXTRA_FLAGS=""
if [[ -n "$MODEL" ]]; then
  # model 名に [1m] のような glob メタ文字が含まれても zsh -ic 内で展開されないよう quote する
  CLAUDE_EXTRA_FLAGS="--model '$MODEL'"
fi
if [[ $SKIP_PERMISSIONS -eq 1 ]]; then
  if [[ -n "$CLAUDE_EXTRA_FLAGS" ]]; then
    CLAUDE_EXTRA_FLAGS="$CLAUDE_EXTRA_FLAGS --dangerously-skip-permissions"
  else
    CLAUDE_EXTRA_FLAGS="--dangerously-skip-permissions"
  fi
fi

if [[ "$LAYOUT" == "claude-teams" ]]; then
  # claude-teams mode: --runner is ignored; claude-teams only supports claude.
  # execute mode for claude-teams reuses superpowers branch (no --dangerously-skip-permissions)
  if [[ "$MODE" == "superpowers" || "$MODE" == "execute" ]]; then
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
    if [[ "$MODE" == "execute" ]]; then
      # codex execute: plan モードと同じく bypass フラグを付与
      # (codex に --model は不要 — codex runner が独自に処理)
      CORE_CMD="$RUNNER_COMMAND --dangerously-bypass-approvals-and-sandbox '$PROMPT_TEXT'"
    elif [[ "$MODE" == "standby" ]]; then
      # codex standby: prompt なしで idle 起動 (idle codex は agmsg push を受信できないため、
      # 実行指示は message-type に関わらず cmux send で注入される)
      if [[ -n "$PROMPT_TEXT" ]]; then
        CORE_CMD="$RUNNER_COMMAND --dangerously-bypass-approvals-and-sandbox '$PROMPT_TEXT'"
      else
        CORE_CMD="$RUNNER_COMMAND --dangerously-bypass-approvals-and-sandbox"
      fi
    elif [[ "$MODE" == "superpowers" ]]; then
      # codex superpowers: $superpowers:brainstorming プレフィックスで brainstorming skill を発動
      CORE_CMD="$RUNNER_COMMAND '\$superpowers:brainstorming $PROMPT_TEXT'"
    else
      # codex plan: claude の --dangerously-skip-permissions に相当するのは
      # --dangerously-bypass-approvals-and-sandbox。/plan slash command は codex でも有効
      CORE_CMD="$RUNNER_COMMAND --dangerously-bypass-approvals-and-sandbox '/plan $PROMPT_TEXT'"
    fi
  else
    # claude engine (default)
    if [[ "$MODE" == "execute" ]]; then
      # claude execute: --model / --dangerously-skip-permissions を inner prompt の直前にインジェクト
      if [[ -n "$CLAUDE_EXTRA_FLAGS" ]]; then
        CORE_CMD="$RUNNER_COMMAND $CLAUDE_EXTRA_FLAGS '$PROMPT_TEXT'"
      else
        CORE_CMD="$RUNNER_COMMAND '$PROMPT_TEXT'"
      fi
    elif [[ "$MODE" == "standby" ]]; then
      # claude standby: --model / --skip-permissions を反映し、prompt があれば渡す
      # (agmsg モードでは "/agmsg actas <name>" + 待機指示を初期 prompt にする)
      if [[ -n "$PROMPT_TEXT" ]]; then
        CORE_CMD="$RUNNER_COMMAND${CLAUDE_EXTRA_FLAGS:+ $CLAUDE_EXTRA_FLAGS} '$PROMPT_TEXT'"
      else
        CORE_CMD="$RUNNER_COMMAND${CLAUDE_EXTRA_FLAGS:+ $CLAUDE_EXTRA_FLAGS}"
      fi
    elif [[ "$MODE" == "superpowers" ]]; then
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

STANDBY_FLAG=0
[[ "$MODE" == "standby" ]] && STANDBY_FLAG=1

RUNNER_FILE="$CWD/$RUNNER_SCRIPT_NAME"
cat > "$RUNNER_FILE" <<EOF
#!/bin/bash
set -uo pipefail

CMUX="${CMUX}"
STATUS_DIR="${STATUS_DIR}"
SLUG="${WORKSPACE_NAME}"
DEFER_STATUS="${DEFER_STATUS}"
STANDBY="${STANDBY_FLAG}"
MESSAGE_TYPE="${MESSAGE_TYPE}"
AGMSG_SEND="${AGMSG_SEND}"
AGMSG_TEAM="${AGMSG_TEAM}"
AGMSG_FROM="${AGMSG_FROM}"

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

# standby wrapper は起動時に status.json を書かない (同じ STATUS_DIR を Child が使用中のため)
if [[ "\$STANDBY" != "1" ]]; then
  write_status "executing" "Claude session starting"
fi

${CLAUDE_CMD}
CLAUDE_EXIT=\$?

# defer-status: Phase B で別 surface (孫セッション) に実行を移譲した場合、
# Child セッション側の runner wrapper はここで status.json を上書きせず exit する。
# 孫セッションの runner wrapper が status を上書きするのでそちらに任せる。
# Child 側 Claude は exit 前に "<STATUS_DIR>/.deferred" を touch することで意思表示する。
if [[ "\$DEFER_STATUS" == "1" && -n "\$STATUS_DIR" && -f "\$STATUS_DIR/.deferred" ]]; then
  echo "[runner] status update deferred (.deferred sentinel found at \$STATUS_DIR/.deferred)" >&2
  exit 0
fi

# standby: .assigned sentinel が無ければ実装を引き受けていない。status を書かずに終了する
# (未使用 standby tab を閉じても status.json を汚さないための仕組み — .deferred の逆向き)
if [[ "\$STANDBY" == "1" && ! -f "\$STATUS_DIR/.assigned" ]]; then
  echo "[runner] standby exiting without assignment (no .assigned at \$STATUS_DIR)" >&2
  exit 0
fi

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
# message-type=agmsg の場合は agmsg send.sh で親 (agent 名 "parent") に送る。
NOTIFY_MSG="[dispatch] task \"${WORKSPACE_NAME}\" finished (status: \$STATUS_LABEL)"
if [[ "\$MESSAGE_TYPE" == "agmsg" ]]; then
  bash "\$AGMSG_SEND" "\$AGMSG_TEAM" "\$AGMSG_FROM" parent "\$NOTIFY_MSG" 2>/dev/null || true
elif [[ "\$LAYOUT_MODE" == "split" && -n "\$NOTIFY_SF" ]]; then
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

if [[ "$MODE" == "standby" && -n "$STANDBY_IN" ]]; then
  # --- Standby Split Placement: 既存 workspace 内に縦分割ペインを追加 ---
  WORKSPACE_ID="$STANDBY_IN"
  TITLE="$WORKSPACE_NAME"

  log "cmux" "creating standby pane (split down from $STANDBY_SPLIT_FROM) in $STANDBY_IN"
  SPLIT_OUTPUT=$("$CMUX" new-split down \
    --workspace "$STANDBY_IN" \
    --surface "$STANDBY_SPLIT_FROM" 2>/dev/null) || die "failed to create standby split pane"
  SURFACE_ID=$(echo "$SPLIT_OUTPUT" | grep -oE 'surface:[0-9]+' | head -1)
  [[ -z "$SURFACE_ID" ]] && die "failed to parse surface ID from split output: $SPLIT_OUTPUT"
  log "cmux" "standby pane surface: $SURFACE_ID"

  "$CMUX" rename-tab --workspace "$STANDBY_IN" --surface "$SURFACE_ID" "$TITLE" 2>/dev/null || \
    log "cmux" "warning: failed to rename tab (non-fatal)"

  wait_for_shell "$SURFACE_ID" || true

  "$CMUX" send --surface "$SURFACE_ID" \
    "cd '$CWD' && bash $RUNNER_SCRIPT_NAME\n" 2>/dev/null || die "failed to send cd+runner command"
  log "cmux" "standby runner command sent"

elif [[ "$LAYOUT" == "workspace" || "$LAYOUT" == "claude-teams" ]]; then
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

if [[ -n "$STATUS_DIR" && "$MODE" != "standby" ]]; then
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
