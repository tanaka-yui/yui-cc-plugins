#!/bin/bash
# Launch a cmux workspace (or split pane) with git worktree isolation and a runner session
# Based on cmux-launch.sh with cmux-team-dispatch-task extensions
#
# Usage: launch-workspace.sh [options] <workspace-name> <prompt...>
#
# Options:
#   --cwd <path>                       Working directory (skips worktree creation)
#   --mode plan|superpowers|execute|standby|review  Runner launch mode (default: plan).
#                                      execute = Phase B 実行モード。計画ファイルを
#                                      inner prompt として渡し、.cmux-team-dispatch-task-prompt.md
#                                      を書き込まない。--plan-file が必須
#                                      standby = pre-warm 待機モード。--cwd 必須・prompt 省略可。
#                                      配置は 2 方式: --standby-in + --standby-split-from 指定時は
#                                      既存 workspace 内に縦分割ペイン (new-split down)、両方省略時は
#                                      新規 workspace のメイン surface で待機セッションを起動する。
#                                      wrapper は <STATUS_DIR>/.assigned-<workspace-name> が
#                                      存在するときだけ exit 時に status.json を更新する
#                                      review = Phase A-R レビューペイン用モード。挙動は standby と
#                                      同一 (.assigned-<name> が無い限り wrapper は status.json を
#                                      書かない) だが、レビューペインは .assigned を一切使わない
#                                      前提のモード。codex engine では --model を反映する
#   --role plan|review|exec            Model/effort role. Default is derived from mode:
#                                      plan/superpowers=plan, review=review,
#                                      execute/standby=exec. A standby design pane passes
#                                      --role plan; conflicting non-standby overrides fail.
#   --standby-split-direction right|down  standby/review split 配置の分割方向 (default: down)
#   --standby-in <workspace-id>        standby ペインを追加する既存 workspace (split 配置時必須)
#   --standby-split-from <surface-id>  縦分割の分割元 surface (split 配置時必須)
#   --plan-file <path>                 Plan file path (required when --mode execute).
#                                      inner prompt が
#                                      "Read and execute the plan at <path>" になる
#   --model <model>                    Model flag passed as --model <X>. engine を問わず
#                                      未指定時は runner の role 対応 plan_model /
#                                      review_model / exec_model にフォールバックし、
#                                      claude はさらに plan/review=opus[1m] / exec=sonnet を既定とする
#   --effort <level>                   Reasoning effort. engine を問わず未指定時は runner の
#                                      plan_effort / review_effort / exec_effort に
#                                      フォールバックし、既定は plan/review=xhigh / exec=high。
#                                      claude は --effort、codex は -c model_reasoning_effort へ注入
#   --skip-permissions                 claude に --dangerously-skip-permissions を
#                                      追加 (sonnet の auto mode 不在対策)。
#                                      claude engine のみ対応
#   --no-parallel                      並列実行ディレクティブを起動プロンプトへ入れない
#   --agents <N>                       同時に走らせる子エージェントの上限 2..8 (default: 4)
#
#   注記: claude engine では MODE を問わず、worktree の
#   .claude/settings.local.json に permissions.defaultMode: "bypassPermissions" を
#   注入する (Step 2a)。claude engine では注入の成否に関わらず無条件にファイルを
#   読み直し、確認できなかったときは plan (組み立て箇所でリテラル付与済み) と、
#   呼び出し元が --skip-permissions を渡した execute / standby / review
#   (execute / standby は claude engine での --unattended も同様に免除する。
#   review は --unattended を受け付けないので --skip-permissions のみが免除する)
#   を除いて --dangerously-skip-permissions を自動で足す。
#   superpowers は --skip-permissions を読まないので常に足す。
#   --skip-permissions はそれとは別に呼び出し元が明示するフラグ。codex engine は対象外。
#   --defer-status                     runner wrapper が exit 時に <STATUS_DIR>/.deferred
#                                      が存在する場合 status.json 更新 / 親通知 /
#                                      cmux wait-for 発火をスキップ。Phase B で別 surface に
#                                      実行を移譲する Child セッション側で常に指定する
#   --review-config <path>             (--mode execute 専用) Phase B-R コードレビュー配線
#                                      JSON ({reviewer_surface, reviewer_workspace, review_dir}) のパス。指定時、
#                                      inner prompt に「PR 作成前にレビュアー surface へ
#                                      cmux send でレビュー依頼し、review_dir/code-round-<N>.md
#                                      の VERDICT をポーリングして approve までループする」
#                                      プロトコルを追記する
#   --timeout-sentinel <path>          ループモード専用。runner wrapper が exit 時にこの
#                                      パスの存在を確認し、あれば status.json を書かずに
#                                      終了する。batch-wait.sh が timeout として terminal 化
#                                      したタスクの遅延書き込み (status 上書き / status dir の
#                                      再生成) を防ぐ。未指定 (非ループ) では wrapper の
#                                      挙動は従来どおり
#   --unattended                       ループモード専用。--mode execute / standby で有効。
#                                      inner prompt のレビュー fallback から対話質問を除去し、
#                                      claude engine には --dangerously-skip-permissions を
#                                      強制付与する。他モードでは警告して無視
#   --status-dir <path>                Directory for writing status files
#   --parent-notify-workspace <ws-id>  Workspace to notify on completion
#   --parent-notify-surface <sf-id>    Surface to notify on completion
#   --runner <name>                    Runner name to look up in
#                                      ~/.claude/cmux-team-dispatch-task/runners.json.
#                                      Resolves command/engine and role-specific plan/review/exec
#                                      model/effort fields for the child session.
#                                      The composed command is always wrapped in `zsh -ic "..."`
#                                      so functions and env vars from ~/.zshrc are loaded.
#                                      Default: hardcoded {claude, engine=claude}.
#   --agmsg-team <team>                agmsg の team 名 (--agmsg-from とセットで必須)。
#                                      送信は send-prompt.sh が担い、宛先 watcher が生きている
#                                      ときだけ agmsg push を使う (タイプ入力は常に併発)
#   --agmsg-from <agent>               agmsg の送信元 agent 名 (--agmsg-team とセットで必須)
#
# Output: JSON to stdout with workspace/pane details
# Debug:  Logs to stderr

set -euo pipefail

CMUX="${CMUX_BIN:-/Applications/cmux.app/Contents/Resources/bin/cmux}"
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

# worktree の .claude/settings.local.json に jq フィルタをマージして書き戻す。
#   merge_claude_settings '<jq filter>' [jq の追加引数...]
# 一時ファイルは同一ディレクトリの mktemp + mv でアトミックに置き換える
# (共有名 "$FILE.tmp" は prewarm が同じ worktree に複数ペインを起こす場面で壊れる)。
# 失敗はすべて警告のみ。dispatch は止めない。
merge_claude_settings() {
  local filter="$1"
  shift
  local settings_dir="$CWD/.claude"
  local settings_file="$settings_dir/settings.local.json"

  if ! mkdir -p "$settings_dir" 2>/dev/null; then
    log "warn" "failed to create $settings_dir; skipping settings injection"
    return 1
  fi

  local merged=""
  if [[ -f "$settings_file" ]]; then
    merged=$(jq "$@" "$filter" "$settings_file" 2>/dev/null) || merged=""
  else
    merged=$(jq -n "$@" "{} | $filter" 2>/dev/null) || merged=""
  fi
  if [[ -z "$merged" ]]; then
    log "warn" "failed to merge into $settings_file; skipping"
    return 1
  fi

  local tmp
  tmp=$(mktemp "$settings_dir/.settings.local.json.XXXXXX" 2>/dev/null) || {
    log "warn" "failed to create a temp file in $settings_dir; skipping"
    return 1
  }
  if printf '%s\n' "$merged" > "$tmp" 2>/dev/null && mv "$tmp" "$settings_file" 2>/dev/null; then
    return 0
  fi
  rm -f "$tmp" 2>/dev/null || true
  log "warn" "failed to write $settings_file; skipping"
  return 1
}

# 誤コミット防止: settings.local.json と plan 保存先 .claude/plans/ を repo 共有の
# info/exclude に追記する。info/exclude は worktree 間で共有されるが、いずれも
# ローカル専用のため実害なし。
ensure_claude_exclusions() {
  local exclude_file entry
  exclude_file=$(git -C "$CWD" rev-parse --path-format=absolute --git-path info/exclude 2>/dev/null || true)
  if [[ -z "$exclude_file" ]]; then
    log "warn" "could not resolve info/exclude for $CWD; settings.local.json may appear in git status"
    return 1
  fi
  mkdir -p "$(dirname "$exclude_file")" 2>/dev/null || true
  for entry in '.claude/settings.local.json' '.claude/plans/'; do
    grep -qxF "$entry" "$exclude_file" 2>/dev/null \
      || echo "$entry" >> "$exclude_file" 2>/dev/null \
      || log "warn" "failed to append $entry to $exclude_file"
  done
  return 0
}

# シェル起動検知と config 学習（split / standby mode で使用）
# shellcheck source=./terminal-wait.sh
source "$SCRIPT_DIR/terminal-wait.sh"

# --- Argument Parsing ---

CWD=""
MODE="plan"
STANDBY_IN=""
STANDBY_SPLIT_FROM=""
STANDBY_SPLIT_DIRECTION="down"
STATUS_DIR=""
NOTIFY_WORKSPACE=""
NOTIFY_SURFACE=""
RUNNER_NAME=""
WORKSPACE_NAME=""
PROMPT=""
PLAN_FILE=""
MODEL=""
MODEL_ROLE=""
NO_PARALLEL=0
MAX_AGENTS=4
EFFORT=""
SKIP_PERMISSIONS=0
DEFER_STATUS=0
REVIEW_CONFIG=""
TIMEOUT_SENTINEL=""
UNATTENDED=0
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
      [[ $# -lt 2 ]] && die "--mode requires plan, superpowers, execute, standby, or review"
      MODE="$2"
      [[ "$MODE" == "plan" || "$MODE" == "superpowers" || "$MODE" == "execute" || "$MODE" == "standby" || "$MODE" == "review" ]] \
        || die "--mode must be 'plan', 'superpowers', 'execute', 'standby', or 'review'"
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
    --standby-split-direction)
      [[ $# -lt 2 ]] && die "--standby-split-direction requires right or down"
      STANDBY_SPLIT_DIRECTION="$2"
      [[ "$STANDBY_SPLIT_DIRECTION" == "right" || "$STANDBY_SPLIT_DIRECTION" == "down" ]] \
        || die "--standby-split-direction must be 'right' or 'down'"
      shift 2 ;;
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
    --role)
      [[ $# -lt 2 ]] && die "--role requires plan, review, or exec"
      MODEL_ROLE="$2"
      shift 2
      ;;
    --no-parallel) NO_PARALLEL=1; shift ;;
    --agents)
      [[ $# -lt 2 ]] && die "--agents requires a value"
      MAX_AGENTS="$2"; shift 2 ;;
    --effort)
      [[ $# -lt 2 ]] && die "--effort requires a value"
      EFFORT="$2"; shift 2 ;;
    --skip-permissions)
      SKIP_PERMISSIONS=1
      shift
      ;;
    --defer-status)
      DEFER_STATUS=1
      shift
      ;;
    --review-config)
      [[ $# -lt 2 ]] && die "--review-config requires a path argument"
      REVIEW_CONFIG="$2"
      shift 2
      ;;
    --timeout-sentinel)
      [[ $# -lt 2 ]] && die "--timeout-sentinel requires a path argument"
      TIMEOUT_SENTINEL="$2"
      shift 2
      ;;
    --unattended)
      UNATTENDED=1
      shift
      ;;
    --status-dir)
      [[ $# -lt 2 ]] && die "--status-dir requires a path argument"
      STATUS_DIR="$2"
      shift 2
      ;;
    # v1.13.0 で削除。単に case を消すと catch-all が削除済みフラグを workspace 名として
    # 受理してしまう (WORKSPACE_NAME の正規表現 [A-Za-z0-9._-]+ にマッチするため)。
    # 旧 API の呼び出しには明示的なエラーを返す。
    --layout|--split-from|--split-direction|--parent-workspace)
      die "$1 was removed: the layout is always 'workspace'"
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
    # v1.16.0 で削除。agmsg を使うかは --agmsg-team の有無と send.sh の存在で決まる。
    --message-type)
      die "--message-type was removed: agmsg is wired whenever --agmsg-team is given and send.sh exists"
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

if [[ -z "$MODEL_ROLE" ]]; then
  case "$MODE" in
    plan|superpowers) MODEL_ROLE="plan" ;;
    review) MODEL_ROLE="review" ;;
    execute|standby) MODEL_ROLE="exec" ;;
  esac
elif [[ "$MODE" != "standby" ]]; then
  case "$MODE:$MODEL_ROLE" in
    plan:plan|superpowers:plan|review:review|execute:exec) ;;
    *) die "--role '$MODEL_ROLE' conflicts with --mode '$MODE'" ;;
  esac
fi
[[ "$MODEL_ROLE" =~ ^(plan|review|exec)$ ]] || die "--role must be 'plan', 'review', or 'exec'"

# execute mode は --plan-file が必須で PROMPT は不要 (inner prompt が plan-file 由来)
# standby mode は --standby-in / --cwd が必須で PROMPT は省略可 (idle TUI 待機)
if [[ "$MODE" == "execute" ]]; then
  [[ -n "$PLAN_FILE" ]] || die "--plan-file is required when --mode is execute"
elif [[ "$MODE" == "standby" || "$MODE" == "review" ]]; then
  [[ -n "$CWD" ]] || die "--cwd is required when --mode is standby/review (reuse the task worktree)"
  # 配置は 2 方式: --standby-in + --standby-split-from = 既存 workspace 内に縦分割ペイン、
  # 両方省略 = 新規 workspace のメイン surface で standby 起動 (agmsg モードの opus ペイン用)
  if [[ -n "$STANDBY_IN" || -n "$STANDBY_SPLIT_FROM" ]]; then
    [[ -n "$STANDBY_IN" ]] || die "--standby-in is required when --standby-split-from is given"
    [[ -n "$STANDBY_SPLIT_FROM" ]] || die "--standby-split-from is required when --standby-in is given (split placement)"
  fi
else
  [[ -z "$PROMPT" ]] && die "prompt is required. Usage: $0 [options] <workspace-name> <prompt...>"
fi

# --review-config は execute 専用 (Phase B-R: PR 作成前コードレビューのプロトコル注入)
if [[ -n "$REVIEW_CONFIG" ]]; then
  [[ "$MODE" == "execute" ]] || die "--review-config is only valid with --mode execute"
  [[ -f "$REVIEW_CONFIG" ]] || die "review config file not found: $REVIEW_CONFIG"
fi

# Validate workspace name: only allow safe characters for path/branch usage
[[ "$WORKSPACE_NAME" =~ ^[A-Za-z0-9._-]+$ ]] || die "invalid workspace name '$WORKSPACE_NAME': use only [A-Za-z0-9._-]"

# agmsg 配線は team / from が揃っているときだけ行う。send.sh が無ければ未インストール。
if [[ -n "$AGMSG_TEAM" || -n "$AGMSG_FROM" ]]; then
  [[ -n "$AGMSG_TEAM" ]] || die "--agmsg-team is required when --agmsg-from is given"
  [[ -n "$AGMSG_FROM" ]] || die "--agmsg-from is required when --agmsg-team is given"
  [[ -f "$AGMSG_SEND" ]] || die "agmsg is not installed (expected $AGMSG_SEND)"
fi

# WORKSPACE_NAME 別に runner script ファイル名を unique 化する。
# Phase B grandchild (--mode execute) と Child が同じ worktree を共有する状況で、
# 旧固定名 ".cmux-team-dispatch-task-run.sh" は Child の実行中ファイルを上書きしてしまい、
# Child bash が中途半端な byte offset から書き換え後の内容を読んで undefined 挙動になっていた。
RUNNER_SCRIPT_NAME=".cmux-team-dispatch-task-run-${WORKSPACE_NAME}.sh"

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
RUNNER_PLAN_MODEL=""
RUNNER_REVIEW_MODEL=""
RUNNER_EXEC_MODEL=""
RUNNER_PLAN_EFFORT=""
RUNNER_REVIEW_EFFORT=""
RUNNER_EXEC_EFFORT=""

if [[ -n "$RUNNER_NAME" ]]; then
  [[ -f "$RUNNERS_CONFIG_PATH" ]] || die "runners.json not found at $RUNNERS_CONFIG_PATH (required when --runner is specified)"
  RUNNER_JSON=$(jq --arg n "$RUNNER_NAME" '.runners[]? | select(.name == $n)' "$RUNNERS_CONFIG_PATH" 2>/dev/null) \
    || die "failed to parse runners.json at $RUNNERS_CONFIG_PATH"
  [[ -n "$RUNNER_JSON" ]] || die "runner '$RUNNER_NAME' not found in $RUNNERS_CONFIG_PATH"

  RUNNER_COMMAND=$(echo "$RUNNER_JSON" | jq -r '.command // empty')
  RUNNER_ENGINE=$(echo "$RUNNER_JSON" | jq -r '.engine // "claude"')
  RUNNER_PLAN_MODEL=$(echo "$RUNNER_JSON" | jq -r '.plan_model // empty')
  RUNNER_REVIEW_MODEL=$(echo "$RUNNER_JSON" | jq -r '.review_model // empty')
  RUNNER_EXEC_MODEL=$(echo "$RUNNER_JSON" | jq -r '.exec_model // empty')
  RUNNER_PLAN_EFFORT=$(echo "$RUNNER_JSON" | jq -r '.plan_effort // empty')
  RUNNER_REVIEW_EFFORT=$(echo "$RUNNER_JSON" | jq -r '.review_effort // empty')
  RUNNER_EXEC_EFFORT=$(echo "$RUNNER_JSON" | jq -r '.exec_effort // empty')

  [[ -n "$RUNNER_COMMAND" ]] || die "runner '$RUNNER_NAME' is missing 'command' field"
  [[ "$RUNNER_ENGINE" == "claude" || "$RUNNER_ENGINE" == "codex" ]] \
    || die "runner '$RUNNER_NAME' has invalid engine '$RUNNER_ENGINE' (must be 'claude' or 'codex')"
fi

# model / effort 解決: engine 中立。優先順位は 明示指定 > runner の role フィールド > 既定値。
# claude の model 既定は role ごとに固定し、codex の model 既定は置かない
# (モデル名がアカウント・バージョン依存のため codex 側 config.toml へ委ねる)。
# effort の既定は engine 共通 (plan/review=xhigh, exec=high)。
CODEX_EFFORT_FLAG=""
case "$MODEL_ROLE" in
  plan)
    [[ -z "$MODEL" ]] && MODEL="$RUNNER_PLAN_MODEL"
    [[ -z "$EFFORT" ]] && EFFORT="$RUNNER_PLAN_EFFORT"
    [[ -z "$MODEL" && "$RUNNER_ENGINE" == "claude" ]] && MODEL="opus[1m]"
    [[ -z "$EFFORT" ]] && EFFORT="xhigh"
    ;;
  review)
    [[ -z "$MODEL" ]] && MODEL="$RUNNER_REVIEW_MODEL"
    [[ -z "$EFFORT" ]] && EFFORT="$RUNNER_REVIEW_EFFORT"
    [[ -z "$MODEL" && "$RUNNER_ENGINE" == "claude" ]] && MODEL="opus[1m]"
    [[ -z "$EFFORT" ]] && EFFORT="xhigh"
    ;;
  exec)
    [[ -z "$MODEL" ]] && MODEL="$RUNNER_EXEC_MODEL"
    [[ -z "$EFFORT" ]] && EFFORT="$RUNNER_EXEC_EFFORT"
    [[ -z "$MODEL" && "$RUNNER_ENGINE" == "claude" ]] && MODEL="sonnet"
    [[ -z "$EFFORT" ]] && EFFORT="high"
    ;;
esac
[[ -n "$MODEL" ]] && log "runner" "applying model=$MODEL ($RUNNER_ENGINE $MODEL_ROLE)"
if [[ "$RUNNER_ENGINE" == "codex" ]]; then
  [[ "$EFFORT" =~ ^(minimal|low|medium|high|xhigh)$ ]] \
    || die "invalid --effort '$EFFORT' for codex (must be minimal|low|medium|high|xhigh)"
  CODEX_EFFORT_FLAG=" -c model_reasoning_effort='$EFFORT'"
else
  [[ "$EFFORT" =~ ^(low|medium|high|xhigh|max)$ ]] \
    || die "invalid --effort '$EFFORT' for claude (must be low|medium|high|xhigh|max)"
fi
log "runner" "applying reasoning effort=$EFFORT ($RUNNER_ENGINE $MODEL_ROLE)"

# --agents はプロンプトへ埋め込まれる。範囲外・非数値は cmux ペインを起動する前に弾く
[[ "$MAX_AGENTS" =~ ^[2-8]$ ]] || die "--agents must be an integer from 2 to 8"

# codex 0.145 以降は project-local .codex/hooks.json ごとに信頼確認を行う。信頼状態は
# hooks.json の絶対パスをキーに記録されるため、worktree ごとに新しいパスが生成される
# このプラグインでは毎回「未信頼」となり、起動直後に承認待ちで停止する。
# --dangerously-bypass-approvals-and-sandbox はコマンド承認と sandbox だけを無効化し、
# hook trust には作用しないので、専用フラグを全 codex 経路に付ける。
CODEX_HOOK_TRUST_FLAG=" --dangerously-bypass-hook-trust"

# claude-plugins-official の security-guidance は Claude Code の出力契約に合わせて
# stdout に {"metrics": ...} / rewakeSummary / async を書く。codex の hook 出力スキーマは
# additionalProperties: false なので未知キーで必ず parse error になり、
# "hook returned invalid stop hook JSON output" が毎ターン出る (PostToolUse /
# SessionStart も同様)。SECURITY_GUIDANCE_DISABLE=1 の kill switch 経路も metrics を
# 出すため環境変数では回避できず、codex 側でプラグインごと無効化するしかない。
# ここでは検出して警告するだけで、config は書き換えず dispatch も止めない。
warn_if_codex_incompatible_hooks() {
  local cfg="${CODEX_HOME:-$HOME/.codex}/config.toml"
  # config が無い / セクションが無い = 未インストールとみなし、誤警告しない
  [[ -f "$cfg" ]] || return 0
  awk '
    /^[[:space:]]*\[/ {
      in_sg = ($0 ~ /^[[:space:]]*\[plugins\."security-guidance@claude-plugins-official"\]/)
      next
    }
    in_sg && /^[[:space:]]*enabled[[:space:]]*=[[:space:]]*true/ { found = 1 }
    END { exit found ? 0 : 1 }
  ' "$cfg" || return 0
  log "warn" "security-guidance plugin is enabled for codex; its hooks emit stdout keys codex rejects (Stop / PostToolUse / SessionStart report \"invalid ... JSON output\"). Set enabled = false under [plugins.\"security-guidance@claude-plugins-official\"] in $cfg"
}

if [[ "$RUNNER_ENGINE" == "codex" ]]; then
  warn_if_codex_incompatible_hooks
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
if [[ "$MODE" == "execute" || "$MODE" == "standby" || "$MODE" == "review" ]]; then
  log "prompt" "$MODE mode: not writing prompt file"
else
  FULL_PROMPT="$PROMPT"
  printf '%s\n' "$FULL_PROMPT" > "$PROMPT_FILE"
  log "prompt" "wrote prompt to $PROMPT_FILE"
fi

# --- Step 2a: permission prompt 抑止 (claude engine の全 MODE) ---
# claude の子セッションで permission prompt が出ないよう、worktree の
# .claude/settings.local.json に permissions.defaultMode: bypassPermissions を注入し、
# 注入できたことをファイル実体で確認する。確認できなければ CLI フラグへ落とす (Step 3)。
#
# 裏取り (Claude Code 公式ドキュメント + 実測):
#   - --dangerously-skip-permissions は --permission-mode bypassPermissions と
#     「等価なモード」で動作すると cli-reference に明記されている。両者に
#     AskUserQuestion の扱いの差は無い
#   - AskUserQuestion / ExitPlanMode は permission gate とは別レイヤーの対話 UI で、
#     bypassPermissions 下でも対話 TUI では通常どおり表示される (hooks のドキュメントが
#     「非対話モードでプロンプトなしに処理する」ために hook を要求していることが根拠)。
#     したがって superpowers モードのブレスト対話は壊れない
#   - settings.local.json に defaultMode を書くだけで CLI フラグ無しに permission
#     prompt が消えることは実測済み
#
# 注入は best effort で、しかも merge_claude_settings の戻り値は信用できない。
# settings.local.json がディレクトリのとき mv は temp をその中へ移動したうえで 0 を返し、
# 値が 1 つも入っていないのに injected とログに出る。だから戻り値ではなく、書き込んだ
# ファイルを jq -e で直接判定する (シェル文字列へ往復させると $() が末尾改行を剥がして
# 不正な値が等値になるので、比較は jq の中で完結させる)。判定が失敗を告げたときに
# CLI フラグへ落とすのは、設計ペイン (standby / superpowers の有人経路) だけが第二の
# 防壁を持たず、permission prompt に当たると誰にも通知されないまま停止して
# ディスパッチごとデッドロックするため。
#
# bypass モード突入の確認ダイアログはフラグでも defaultMode でも出る。抑止する
# skipDangerousModePermissionPrompt は project settings では無視されるため、
# ユーザー設定 ~/.claude/settings.json 側に置く必要がある (README 参照)。
# したがってフォールバックもこの前提を共有する。
#
# codex engine は .claude/settings.local.json を読まないため対象外。codex は
# --dangerously-bypass-approvals-and-sandbox / review ペインの
# --sandbox workspace-write で既に prompt が出ない。
BYPASS_INJECTION_OK=1
if [[ "$RUNNER_ENGINE" == "claude" ]]; then
  CURRENT_DEFAULT_MODE=""
  if [[ -f "$CWD/.claude/settings.local.json" ]]; then
    CURRENT_DEFAULT_MODE=$(jq -r '.permissions.defaultMode // ""' \
      "$CWD/.claude/settings.local.json" 2>/dev/null || echo "")
  fi
  if [[ "$CURRENT_DEFAULT_MODE" == "bypassPermissions" ]]; then
    # worktree 再利用 (prewarm standby / Phase B の execute 孫) での二重注入を防ぐ
    log "permissions" "defaultMode is already bypassPermissions in $CWD/.claude/settings.local.json"
  elif merge_claude_settings '.permissions.defaultMode = "bypassPermissions"'; then
    log "permissions" "injected permissions.defaultMode=bypassPermissions into $CWD/.claude/settings.local.json"
  fi

  # 注入結果をファイル実体で判定する。merge_claude_settings の戻り値を信用しないのは、
  # settings.local.json がディレクトリのとき mv が temp をその中へ移動して return 0 を返し、
  # 値が 1 つも入っていないのに injected とログに出るため。判定を jq の中で完結させるのは、
  # シェル文字列へ往復させると $() が末尾改行を剥がして "bypassPermissions\n" のような
  # enum として不正な値が等値になってしまうため。jq -e は false で 1、不正 JSON で 5、
  # ファイル不在・ディレクトリで 2 を返すので、0 以外をすべて失敗として扱えば
  # 型混同・末尾空白・注入不能の全ケースに fail-closed になる。
  # -s (slurp) + length == 1 も必須。素の jq -e は複数 JSON ドキュメントが連結された
  # ファイル (JSON としては不正) に対して最後の値だけで rc を決めるため、末尾が
  # bypassPermissions なら confirmed 扱いになってしまう。
  # 既知の残余 (round 2 レビュー MI2-5): jq のパーサは JSON.parse より寛容な入力を
  # 一部受理する (UTF-8 BOM 付きファイル、NaN/Infinity/先頭ゼロ等の非標準数値リテラル)。
  # 到達には既存の settings.local.json がその形で "既に" bypassPermissions を持つ必要が
  # あり (defaultMode が別値なら merge が走って jq が正規化し自己修復する)、
  # merge_claude_settings も delivery.sh もそのような値を書き出さないため外部の書き手を
  # 要する。失敗の向きは可用性側 (フォールバックせずデッドロック) であり権限昇格ではない。
  if ! jq -e -s 'length == 1 and .[0].permissions.defaultMode == "bypassPermissions"' \
       "$CWD/.claude/settings.local.json" >/dev/null 2>&1; then
    BYPASS_INJECTION_OK=0
    # ログ用の値だけを別に読む。制御文字を含む値が stderr へ抜けると端末を書き換えられ、
    # 偽の [permissions] injected 行まで捏造できるため英数字以外を落とす。
    EFFECTIVE_DEFAULT_MODE=$(jq -r '.permissions.defaultMode // ""' \
      "$CWD/.claude/settings.local.json" 2>/dev/null || echo "")
    # 先に 64 文字へ切り詰めてからサニタイズする。逆順だと bash 3.2 の ${var//[^…]/} が
    # 連結 JSON ドキュメント由来の巨大な値 (jq -e -s が全ドキュメントを改行連結して返す)
    # に対して超線形になり、launch を数十秒〜数分止める。切り詰めを先にすれば入力は
    # 常に 64 文字以下に収まり、この経路のコストは定数になる。
    EFFECTIVE_DEFAULT_MODE_LOG="${EFFECTIVE_DEFAULT_MODE:0:64}"
    EFFECTIVE_DEFAULT_MODE_LOG="${EFFECTIVE_DEFAULT_MODE_LOG//[^A-Za-z0-9_-]/}"
    # 生値と潰した値の長さを併記する。これが無いと near-miss 値 (例 ["bypassPermissions"])
    # で「not confirmed なのに defaultMode='bypassPermissions'」という読めない診断になり、
    # 保守者が「比較が壊れている」と誤解してサニタイズ済みの値で比較するよう直してしまう
    # (それはこの設計が禁じている変更そのもの)。末尾改行だけは $() が剥がすので raw_len と
    # shown_len が並ぶが、判定は jq -e が行っているので取りこぼしは無い。
    log "warn" "permission bypass not confirmed in $CWD/.claude/settings.local.json (defaultMode='$EFFECTIVE_DEFAULT_MODE_LOG' raw_len=${#EFFECTIVE_DEFAULT_MODE} shown_len=${#EFFECTIVE_DEFAULT_MODE_LOG})"
  fi

  # `|| true` は必須。このスクリプトは set -euo pipefail で走るので、bare 呼び出しだと
  # info/exclude を解決できないケース (非 git な --cwd など) で launch ごと死ぬ。
  # ensure_claude_exclusions はベストエフォート契約 (警告のみ)。
  ensure_claude_exclusions || true
fi

# --- Step 2b: plan モード遵守ゲート (ExitPlanMode hook 注入) ---
# 標準 plan モードは ExitPlanMode 承認直後に「プランを実行せよ」という強い指示が入り、
# プロンプト焼き込みの MANDATORY MODEL SELECTION SEQUENCE (Phase A-R / Phase B) が
# スキップされることがある。承認直後に PostToolUse hook で指示を機械的に再注入する。
# hook はベストエフォート: 失敗は警告のみで dispatch を止めない (プロンプト側指示がフォールバック)。
# hook は claude engine の plan モードに注入する。
if [[ "$MODE" == "plan" && "$RUNNER_ENGINE" == "claude" ]]; then
  SETTINGS_FILE="$CWD/.claude/settings.local.json"
  HOOK_SCRIPT="$SCRIPT_DIR/plan-approved-hook.sh"
  if [[ -f "$SETTINGS_FILE" ]] && grep -q "plan-approved-hook.sh" "$SETTINGS_FILE" 2>/dev/null; then
    # worktree 再利用時の重複注入を防ぐ
    log "hook" "ExitPlanMode hook already present in $SETTINGS_FILE"
  else
    # パスをクォートして焼き込む (スキルの配置先パスに空白が含まれても壊れないように)
    HOOK_ENTRY=$(jq -n --arg cmd "zsh '$HOOK_SCRIPT'" \
      '{matcher: "ExitPlanMode", hooks: [{type: "command", command: $cmd}]}' 2>/dev/null) || HOOK_ENTRY=""
    if [[ -z "$HOOK_ENTRY" ]]; then
      log "warn" "failed to compose ExitPlanMode hook entry; skipping injection"
    elif merge_claude_settings \
      '.hooks.PostToolUse = ((.hooks.PostToolUse // []) + [$entry])' \
      --argjson entry "$HOOK_ENTRY"; then
      log "hook" "merged ExitPlanMode hook into $SETTINGS_FILE"
    fi
  fi
fi

# --- Step 3: Build runner command ---
# Build the launch command per (engine × MODE) and wrap with `zsh -ic` so that
# user-defined functions and env vars from ~/.zshrc (e.g. ccenec, ccgpt, proxy
# auth) are always resolved.

# --unattended は実行系 (execute / standby) 専用
if [[ $UNATTENDED -eq 1 && "$MODE" != "execute" && "$MODE" != "standby" ]]; then
  log "warn" "--unattended is only meaningful with --mode execute/standby; ignoring for mode=$MODE"
  UNATTENDED=0
fi

# 並列実行ディレクティブ。plan / superpowers / execute の起動プロンプトにだけ連結する。
# standby / review はプロンプト無し (idle 待機文のみ) で起動し、実際の指示は後から
# cmux send で届くため、ここでは扱わない (SKILL.md 側が parallel-directive.sh を
# 実行して送信テキストに含める)。
PARALLEL_INSTRUCTION=""
if [[ $NO_PARALLEL -eq 0 ]] \
  && [[ "$MODE" == "plan" || "$MODE" == "superpowers" || "$MODE" == "execute" ]]; then
  PARALLEL_INSTRUCTION=$(bash "$SCRIPT_DIR/parallel-directive.sh" \
    --engine "$RUNNER_ENGINE" --mode "$MODE" --agents "$MAX_AGENTS")
fi

# execute モードでは計画ファイルを直接 inner prompt に埋め込む。
# あわせて「成功時に必ず完了報告を出せ」という指示を埋め込む。
# これが無いと status.json の終端遷移が runner wrapper の exit 経路だけに依存する。
# claude は /exit で終了できるが codex には自セッションを終わらせる手段が無い
# (/exit は効かず quit/shutdown サブコマンドも無い) ため、codex は作業後に idle
# 残留し、status が executing のまま固まって親に通知が届かない。子自身に
# report-status.sh を叩かせることで、セッションが終わるかどうかと完了報告を切り離す。
# 文中にクォート文字を使わないこと (inner prompt の '...' と zsh -ic の "..." を壊さないため)
if [[ "$MODE" == "execute" ]]; then
  COMPLETION_INSTRUCTION=""
  if [[ -n "$STATUS_DIR" ]]; then
    COMPLETION_INSTRUCTION="MANDATORY COMPLETION REPORT: after all work is committed and before you stop, run: bash $SCRIPT_DIR/report-status.sh $STATUS_DIR done followed by a one line summary of what you changed. That command is the only thing that tells the parent you finished, so do not skip it. "
  fi
  if [[ "$RUNNER_ENGINE" == "codex" ]]; then
    # codex にセッション終了を求めない。実行手段が無い要求はモデルが満たせず、
    # 満たせない指示を残すと「終了したはず」という誤った前提が設計に残る。
    EXIT_INSTRUCTION="After the completion report above, stop and stay idle. Do not try to terminate this session yourself; the parent closes this pane during its final cleanup."
  else
    EXIT_INSTRUCTION="After the completion report above, run /exit to close this Claude session so the wrapper script can also finalize. Do not leave the session idle."
  fi
  # Phase B-R: --review-config 指定時は PR 作成前のコードレビュープロトコルを inner prompt に注入する。
  # 文中にクォート文字を使わないこと (inner prompt の '...' と zsh -ic の "..." を壊さないため)
  REVIEW_INSTRUCTION=""
  if [[ -n "$REVIEW_CONFIG" ]]; then
    REVIEWER_SURFACE=$(jq -r '.reviewer_surface // empty' "$REVIEW_CONFIG" 2>/dev/null) \
      || die "failed to parse review config at $REVIEW_CONFIG"
    REVIEW_DIR=$(jq -r '.review_dir // empty' "$REVIEW_CONFIG" 2>/dev/null) \
      || die "failed to parse review config at $REVIEW_CONFIG"
    REVIEWER_WORKSPACE=$(jq -r '.reviewer_workspace // empty' "$REVIEW_CONFIG" 2>/dev/null) \
      || die "failed to parse review config at $REVIEW_CONFIG"
    # 解決済み review role の engine。design engine との関係から再計算せず、親セッションが
    # review-config に記録した値を使う。欠落 (旧スキーマ) なら注入しない。
    REVIEWER_ENGINE=$(jq -r '.reviewer_engine // empty' "$REVIEW_CONFIG" 2>/dev/null) \
      || die "failed to parse review config at $REVIEW_CONFIG"
    [[ -n "$REVIEWER_SURFACE" && -n "$REVIEW_DIR" ]] \
      || die "review config must contain reviewer_surface and review_dir"
    # reviewer_workspace 欠落時 (旧スキーマ) は --workspace 指定なしにフォールバック。
    # 実装孫は別 workspace に spawn されるため、send / send-key / read-screen のすべてに
    # レビュアー側 workspace を明示しないと配送も生存確認も届かない
    TARGET_FLAGS="--surface $REVIEWER_SURFACE"
    [[ -n "$REVIEWER_WORKSPACE" ]] \
      && TARGET_FLAGS="--workspace $REVIEWER_WORKSPACE --surface $REVIEWER_SURFACE"
    # send-prompt.sh 向けの同じ宛先 (--workspace/--surface を --to-workspace/--to-surface に改名)
    SEND_TARGET_FLAGS="--to-surface $REVIEWER_SURFACE"
    [[ -n "$REVIEWER_WORKSPACE" ]] \
      && SEND_TARGET_FLAGS="--to-workspace $REVIEWER_WORKSPACE --to-surface $REVIEWER_SURFACE"
    READ_SCREEN_CMD="$CMUX read-screen $TARGET_FLAGS"
    # レビュアーに観点別の並列レビューをさせる指示。--no-parallel は起動プロンプト専用の
    # スイッチなのでここでは見ない。注入するかどうかは reviewer_engine の有無だけで決める。
    #
    # この文面は実装者の inner prompt の中に埋め込まれるが、宛先は解決済み review role である。
    # engine ごとに機構が違う (codex は spawn_agent / claude は Task subagent)
    # ため、位置だけで「引用された他人宛のペイロード」と読ませると実装者が自分宛と誤読して
    # 呼べないツールを指示される。前後に明示的な宛先マーカーを付けて境界を語彙で示す。
    REVIEWER_PARALLEL=""
    case "$REVIEWER_ENGINE" in
      claude|codex)
        REVIEWER_PARALLEL=" Also include this in the message to the reviewer, addressed to the reviewer and not to you: $(bash "$SCRIPT_DIR/parallel-directive.sh" \
          --engine "$REVIEWER_ENGINE" --mode review --agents "$MAX_AGENTS") End of the message to the reviewer." ;;
      "") ;;
      *) log "warn" "review config has unknown reviewer_engine=$REVIEWER_ENGINE; skipping parallel directive" ;;
    esac
    # (1)(2) は対話有無で変わらない共通部分
    REVIEW_INSTRUCTION="MANDATORY CODE REVIEW: after all changes are committed and BEFORE creating the PR, you must get a code review approval. Round N starts at 1, max 5 rounds. Each round: (1) request the review by running: CMUX_BIN=$CMUX bash $SCRIPT_DIR/send-prompt.sh $SEND_TARGET_FLAGS --label review-code --outbox-dir $REVIEW_DIR/outbox -- followed by the message text itself: code review round N: review the committed changes on this branch against the plan at $PLAN_FILE and write findings to $REVIEW_DIR/code-round-N.md whose LAST line must be VERDICT: approve or VERDICT: needs_work. From round 2 include your rebuttals to the findings you rejected, with reasons.${REVIEWER_PARALLEL} (2) wait by polling $REVIEW_DIR/code-round-N.md every 5 seconds for a VERDICT line, in 15-minute chunks with no overall time limit while the reviewer is active. Right after sending, capture a baseline of the reviewer pane screen by running: $READ_SCREEN_CMD -- read-screen returns live content even for unfocused workspaces. At each chunk boundary without a verdict, first re-check the verdict file once more, then capture the screen again, retrying up to 3 times 10 seconds apart on failure or empty output, and compare with the previous capture: changed means the reviewer is still working, so update the snapshot and keep waiting with no upper bound; unchanged over a full chunk means the reviewer is stalled; all retries failed is an observation failure, not stalled -- only 2 consecutive all-failed boundaries count as stalled. Whenever the wait exits stalled, re-check the verdict file one final time immediately before any re-send or skip decision. (3) On VERDICT: approve proceed to the PR. On VERDICT: needs_work apply the findings you judge valid, commit, and start round N+1. "
    if [[ $UNATTENDED -eq 1 ]]; then
      # 無人ループ: 判断を求めず固定のフォールバックを取る。文中にクォート文字を使わないこと
      REVIEW_INSTRUCTION="${REVIEW_INSTRUCTION}If round 5 still ends with needs_work, note the unresolved findings in the PR body and proceed to the PR. If the wait exits stalled, re-check the verdict file, then re-send the same round once with a fresh baseline; if it stalls again, skip the review, note the skipped review in the PR body, and proceed to the PR. No interactive user is attached to this session, so never wait for a human decision. "
    else
      REVIEW_INSTRUCTION="${REVIEW_INSTRUCTION}If round 5 still ends with needs_work, or the wait exits stalled again after one re-send of the same round with a fresh baseline: if you can ask the user interactively via AskUserQuestion, ask whether to proceed to the PR or keep going; otherwise note the unresolved or skipped review in the PR body and proceed. "
    fi
  fi
  ABORT_INSTRUCTION=""
  if [[ -n "$STATUS_DIR" ]]; then
    ABORT_REVIEW_STEP=""
    if [[ -n "$REVIEW_CONFIG" ]]; then
      ABORT_REVIEW_STEP="First write the reason to $REVIEW_DIR/code-round-N.md for the current round N, using N=1 if you never sent a review request, with the LAST line being exactly VERDICT: needs_work; this is only a record because the reviewer does not poll that file. Then wake the reviewer by running: CMUX_BIN=$CMUX bash $SCRIPT_DIR/send-prompt.sh $SEND_TARGET_FLAGS --label abort-reviewer --outbox-dir $REVIEW_DIR/outbox and pass as the final argument a message that starts with [abort] and then gives a one line reason for stopping. Next "
    fi
    ABORT_PARENT_STEP=""
    if [[ -n "$NOTIFY_WORKSPACE" ]]; then
      ABORT_PARENT_STEP="Then notify the parent by running: CMUX_BIN=$CMUX bash $SCRIPT_DIR/send-prompt.sh --to-workspace $NOTIFY_WORKSPACE --label dispatch-notify --outbox-dir $STATUS_DIR/outbox -- followed by the message text itself: [dispatch] task $WORKSPACE_NAME finished (status: error). "
    fi
    ABORT_INSTRUCTION="ABORT PROTOCOL, which overrides everything above: if at any point you decide to stop without completing the work, whether from a blocking error, a design contradiction, or simply giving up, you must not stop silently. Writing the status file is not a notification because only the parent polls it. Before you stop: ${ABORT_REVIEW_STEP}write $STATUS_DIR/status.json with status set to error and the reason as the message. ${ABORT_PARENT_STEP}Finally end this session exactly as described below for the successful case. "
  fi
  PROMPT_TEXT="Read and execute the plan at $PLAN_FILE. ${REVIEW_INSTRUCTION}${ABORT_INSTRUCTION}${PARALLEL_INSTRUCTION:+$PARALLEL_INSTRUCTION }${COMPLETION_INSTRUCTION}${EXIT_INSTRUCTION}"
else
  PROMPT_TEXT="Read and follow the task in .cmux-team-dispatch-task-prompt.md${PARALLEL_INSTRUCTION:+ $PARALLEL_INSTRUCTION}"
fi

if [[ "$MODE" == "standby" || "$MODE" == "review" ]]; then
  # standby は与えられた prompt をそのまま使う (agmsg join+待機指示など)。省略時は idle TUI
  PROMPT_TEXT="$PROMPT"
fi

# claude engine の起動フラグ。model/effort と権限フラグを分けるのは、superpowers モードの
# 合成箇所が本来は権限フラグを持たない (permissions.defaultMode を settings.local.json で
# 注入する) 一方で model/effort は全モードで必要なため。ただし注入を確認できなかったときは
# PERM_FALLBACK_FLAG 経由で superpowers にも --dangerously-skip-permissions が付く。
# 順序: <command> [--model X] [--effort Y] [--dangerously-skip-permissions] '<inner prompt>'
CLAUDE_MODEL_FLAGS=""
if [[ -n "$MODEL" ]]; then
  # model 名に [1m] のような glob メタ文字が含まれても zsh -ic 内で展開されないよう quote する
  CLAUDE_MODEL_FLAGS="--model '$MODEL'"
fi
if [[ -n "$EFFORT" ]]; then
  CLAUDE_MODEL_FLAGS="${CLAUDE_MODEL_FLAGS:+$CLAUDE_MODEL_FLAGS }--effort '$EFFORT'"
fi
# 無人ループでは permission prompt / ExitPlanMode 承認で止まらないよう強制する
if [[ $UNATTENDED -eq 1 && "$RUNNER_ENGINE" == "claude" ]]; then
  SKIP_PERMISSIONS=1
fi
CLAUDE_EXTRA_FLAGS="$CLAUDE_MODEL_FLAGS"
if [[ $SKIP_PERMISSIONS -eq 1 ]]; then
  CLAUDE_EXTRA_FLAGS="${CLAUDE_EXTRA_FLAGS:+$CLAUDE_EXTRA_FLAGS }--dangerously-skip-permissions"
fi

# Step 2a の判定で bypass を確認できなかったときだけ付ける緊急フラグ。
# plan は自分の合成箇所でリテラルのフラグを持つので足さない。
# execute / standby / review は呼び出し元の --skip-permissions が CLAUDE_EXTRA_FLAGS 経由で
# 届くので、実際に渡されたときだけ足さない (二重付与の回避)。execute / standby は claude
# engine での --unattended でも SKIP_PERMISSIONS=1 になり同様に免除されるが、review は
# --unattended を受け付けない MODE なのでこの免除は効かず、--skip-permissions のみが効く。
# superpowers はその合成箇所が CLAUDE_MODEL_FLAGS しか読まず --skip-permissions を
# 受け取らないため、その値に関わらず足す。
PERM_FALLBACK_FLAG=""
if [[ "$RUNNER_ENGINE" == "claude" && $BYPASS_INJECTION_OK -eq 0 ]]; then
  case "$MODE" in
    plan) ;;
    superpowers) PERM_FALLBACK_FLAG=" --dangerously-skip-permissions" ;;
    *) if [[ $SKIP_PERMISSIONS -eq 0 ]]; then PERM_FALLBACK_FLAG=" --dangerously-skip-permissions"; fi ;;
  esac
fi
# `|| true` は必須。条件が偽のときではなく、log への書き込みが失敗したときのため。
# log は最後の && の後ろにあり set -e の免除対象外なので、これが無いと launch ごと死ぬ。
[[ -n "$PERM_FALLBACK_FLAG" ]] \
  && log "permissions" "added the CLI permission flag for mode=$MODE because the settings injection was not confirmed" \
  || true

CODEX_MODEL_FLAG=""
[[ -n "$MODEL" ]] && CODEX_MODEL_FLAG=" --model '$MODEL'"

# engine × mode で起動コマンドを構築
  if [[ "$RUNNER_ENGINE" == "codex" ]]; then
    if [[ "$MODE" == "execute" ]]; then
      # codex execute: plan モードと同じく bypass フラグを付与。
      # --model (明示指定 or runner の exec_model) があれば付与、無ければ codex 側デフォルト
      CORE_CMD="$RUNNER_COMMAND$CODEX_EFFORT_FLAG$CODEX_MODEL_FLAG$CODEX_HOOK_TRUST_FLAG --dangerously-bypass-approvals-and-sandbox '$PROMPT_TEXT'"
    elif [[ "$MODE" == "standby" ]]; then
      # codex standby: prompt なしで idle 起動。実行指示は常に cmux send で届く
      # (prewarm.json の delivery=agmsg のときは加えて agmsg inbox にも記録される)。
      if [[ -n "$PROMPT_TEXT" ]]; then
        CORE_CMD="$RUNNER_COMMAND$CODEX_EFFORT_FLAG$CODEX_MODEL_FLAG$CODEX_HOOK_TRUST_FLAG --dangerously-bypass-approvals-and-sandbox '$PROMPT_TEXT'"
      else
        CORE_CMD="$RUNNER_COMMAND$CODEX_EFFORT_FLAG$CODEX_MODEL_FLAG$CODEX_HOOK_TRUST_FLAG --dangerously-bypass-approvals-and-sandbox"
      fi
    elif [[ "$MODE" == "review" ]]; then
      # review は workspace-write に限定し、approval prompt は抑止する。findings は
      # worktree 外の STATUS_DIR/review/ に書かれるため、STATUS_DIR だけを追加許可する。
      REVIEW_WRITABLE_FLAG=""
      [[ -n "$STATUS_DIR" ]] && REVIEW_WRITABLE_FLAG=" --add-dir '$STATUS_DIR'"
      CORE_CMD="$RUNNER_COMMAND$CODEX_EFFORT_FLAG$CODEX_MODEL_FLAG$CODEX_HOOK_TRUST_FLAG --sandbox workspace-write -c approval_policy='never'$REVIEW_WRITABLE_FLAG${PROMPT_TEXT:+ '$PROMPT_TEXT'}"
    elif [[ "$MODE" == "superpowers" ]]; then
      # codex superpowers: $superpowers:brainstorming プレフィックスで brainstorming skill を発動
      CORE_CMD="$RUNNER_COMMAND$CODEX_EFFORT_FLAG$CODEX_MODEL_FLAG$CODEX_HOOK_TRUST_FLAG --dangerously-bypass-approvals-and-sandbox '\$superpowers:brainstorming $PROMPT_TEXT'"
    else
      # codex plan: claude の --dangerously-skip-permissions に相当するのは
      # --dangerously-bypass-approvals-and-sandbox。/plan slash command は codex でも有効
      CORE_CMD="$RUNNER_COMMAND$CODEX_EFFORT_FLAG$CODEX_MODEL_FLAG$CODEX_HOOK_TRUST_FLAG --dangerously-bypass-approvals-and-sandbox '/plan $PROMPT_TEXT'"
    fi
  else
    # claude engine (default)
    if [[ "$MODE" == "execute" ]]; then
      # claude execute: --model / --dangerously-skip-permissions を inner prompt の直前にインジェクト
      if [[ -n "$CLAUDE_EXTRA_FLAGS" ]]; then
        CORE_CMD="$RUNNER_COMMAND $CLAUDE_EXTRA_FLAGS$PERM_FALLBACK_FLAG '$PROMPT_TEXT'"
      else
        CORE_CMD="$RUNNER_COMMAND$PERM_FALLBACK_FLAG '$PROMPT_TEXT'"
      fi
    elif [[ "$MODE" == "standby" || "$MODE" == "review" ]]; then
      # claude standby/review: --model / --skip-permissions を反映し、prompt があれば渡す
      # (agmsg モードでは "/agmsg actas <name>" + 待機指示を初期 prompt にする)
      if [[ -n "$PROMPT_TEXT" ]]; then
        CORE_CMD="$RUNNER_COMMAND${CLAUDE_EXTRA_FLAGS:+ $CLAUDE_EXTRA_FLAGS}$PERM_FALLBACK_FLAG '$PROMPT_TEXT'"
      else
        CORE_CMD="$RUNNER_COMMAND${CLAUDE_EXTRA_FLAGS:+ $CLAUDE_EXTRA_FLAGS}$PERM_FALLBACK_FLAG"
      fi
    elif [[ "$MODE" == "superpowers" ]]; then
      # superpowers mode: 権限フラグは付けない。permission prompt の抑止は Step 2a で
      # worktree の .claude/settings.local.json に注入する permissions.defaultMode が担う
      # (AskUserQuestion は permission gate とは別レイヤーなので bypassPermissions 下でも
      #  対話的に残る。詳細は Step 2a のコメント)。model/effort は役割設定なので付ける
      #  注入を確認できなかったときだけ PERM_FALLBACK_FLAG が権限フラグを補う
      CORE_CMD="$RUNNER_COMMAND${CLAUDE_MODEL_FLAGS:+ $CLAUDE_MODEL_FLAGS}$PERM_FALLBACK_FLAG '$PROMPT_TEXT'"
    else
      CORE_CMD="$RUNNER_COMMAND${CLAUDE_MODEL_FLAGS:+ $CLAUDE_MODEL_FLAGS} --dangerously-skip-permissions '/plan $PROMPT_TEXT'"
    fi
  fi

  # 常に zsh -ic で .zshrc を読み込ませてユーザー定義関数 (ccenec 等) と env (proxy 認証 等) を解決
  SESSION_CMD="zsh -ic \"$CORE_CMD\""

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
[[ "$MODE" == "standby" || "$MODE" == "review" ]] && STANDBY_FLAG=1

RUNNER_FILE="$CWD/$RUNNER_SCRIPT_NAME"
cat > "$RUNNER_FILE" <<EOF
#!/bin/bash
set -uo pipefail

CMUX="${CMUX}"
SEND_PROMPT="${SCRIPT_DIR}/send-prompt.sh"
STATUS_DIR="${STATUS_DIR}"
SLUG="${WORKSPACE_NAME}"
DEFER_STATUS="${DEFER_STATUS}"
STANDBY="${STANDBY_FLAG}"
AGMSG_SEND="${AGMSG_SEND}"
AGMSG_TEAM="${AGMSG_TEAM}"
AGMSG_FROM="${AGMSG_FROM}"
TIMEOUT_SENTINEL="${TIMEOUT_SENTINEL}"

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
    # 子セッションが書いた pr_url を exit 時の上書きで失わないよう引き継ぐ。
    # PR 作成済みかどうかは完了判定の根拠になるため、消してはいけない。
    local PREV_PR_URL=""
    if [[ -f "\$STATUS_DIR/status.json" ]]; then
      PREV_PR_URL=\$(jq -r '.pr_url // empty' "\$STATUS_DIR/status.json" 2>/dev/null || echo "")
    fi
    jq -n --arg s "\$status" --arg m "\$message" --arg ws "\$WORKSPACE_ID" --arg sf "\$SURFACE_ID" \\
      --arg pr "\$PREV_PR_URL" \\
      '{status:\$s, message:\$m, workspace_id:\$ws, surface_id:\$sf, timestamp:(now|todate)}
       + (if \$pr == "" then {} else {pr_url:\$pr} end)' \\
      > "\$STATUS_DIR/status.json"
  fi
}

NOTIFY_WS="${NOTIFY_WORKSPACE}"
NOTIFY_SF="${NOTIFY_SURFACE}"
NOTIFIED_FILE=""
[[ -n "\$STATUS_DIR" ]] && NOTIFIED_FILE="\$STATUS_DIR/.notified-\$SLUG"

# 親へ完了通知を送る。タイプ入力 (常時)・長文のファイル化・Enter 検証は
# send-prompt.sh が受け持つ。agmsg の 3 引数が揃っているときだけ --agmsg-* を渡す
# (inbox 記録は宛先 watcher が生きているときだけ追加で走る。wake 手段ではない)。
notify_parent() {
  local status_label="\$1"
  local msg="[dispatch] task \\\"\$SLUG\\\" finished (status: \$status_label)"

  local target_flag target_id
  if [[ -n "\$NOTIFY_WS" ]]; then
    target_flag="--to-workspace"; target_id="\$NOTIFY_WS"
  elif [[ -n "\$NOTIFY_SF" ]]; then
    target_flag="--to-surface"; target_id="\$NOTIFY_SF"
  else
    return 1
  fi

  local agmsg_args=()
  if [[ -n "\$AGMSG_TEAM" && -n "\$AGMSG_FROM" ]]; then
    agmsg_args=(--agmsg-team "\$AGMSG_TEAM" --agmsg-to parent --agmsg-from "\$AGMSG_FROM")
  fi

  # --status-dir は省略可能なため、未指定時は --outbox-dir を渡さない
  # (渡すと send-prompt.sh 側で "\$STATUS_DIR/outbox" が文字通り "/outbox" になり、
  # 長文閾値を超えたときに usage エラーで die する)。
  local outbox_args=()
  [[ -n "\$STATUS_DIR" ]] && outbox_args=(--outbox-dir "\$STATUS_DIR/outbox")

  CMUX_BIN="\$CMUX" bash "\$SEND_PROMPT" "\$target_flag" "\$target_id" \
    \${agmsg_args[@]+"\${agmsg_args[@]}"} \${outbox_args[@]+"\${outbox_args[@]}"} \
    --label dispatch-notify -- "\$msg" || return 1
  return 0
}

# 同じ status を二度通知しない。通知に成功したときだけ marker を更新するので、
# 失敗したら次の参加者 (watcher の次の poll、または exit パス) が再試行する。
notify_parent_once() {
  local status_label="\$1" prev=""
  [[ -n "\$NOTIFIED_FILE" && -f "\$NOTIFIED_FILE" ]] && prev=\$(cat "\$NOTIFIED_FILE" 2>/dev/null || echo "")
  [[ "\$prev" == "\$status_label" ]] && return 0
  "\$CMUX" wait-for --signal "\$SLUG-done" 2>/dev/null || true
  notify_parent "\$status_label" || return 1
  [[ -n "\$NOTIFIED_FILE" ]] && printf '%s' "\$status_label" > "\$NOTIFIED_FILE"
  return 0
}

notify_reviewer_once() {
  local status_label="\$1"
  [[ "\$status_label" == "error" && -n "\$STATUS_DIR" ]] || return 0
  local cfg="\$STATUS_DIR/review/code-review.json"
  [[ -f "\$cfg" ]] || return 0
  local rsurface rworkspace
  rsurface=\$(jq -r '.reviewer_surface // empty' "\$cfg" 2>/dev/null || echo "")
  rworkspace=\$(jq -r '.reviewer_workspace // empty' "\$cfg" 2>/dev/null || echo "")
  [[ -n "\$rsurface" ]] || return 0
  local marker="\$STATUS_DIR/.notified-reviewer-\$SLUG" prev=""
  [[ -f "\$marker" ]] && prev=\$(cat "\$marker" 2>/dev/null || echo "")
  [[ "\$prev" == "\$status_label" ]] && return 0
  local reason=""
  [[ -f "\$STATUS_DIR/status.json" ]] && reason=\$(jq -r '.message // empty' "\$STATUS_DIR/status.json" 2>/dev/null || echo "")
  local msg="[abort] task \$SLUG stopped with status error: \$reason"
  local ws_args=()
  [[ -n "\$rworkspace" ]] && ws_args=(--to-workspace "\$rworkspace")
  CMUX_BIN="\$CMUX" bash "\$SEND_PROMPT" \${ws_args[@]+"\${ws_args[@]}"} --to-surface "\$rsurface" \
    --label abort-reviewer --outbox-dir "\$STATUS_DIR/outbox" -- "\$msg" || return 1
  printf '%s' "\$status_label" > "\$marker"
}

# この pane の前回実行が残した通知 marker を消す (pane 世代の分離)。
# runner script は pane 起動ごとに 1 回だけ実行されるため、ここで消せば足りる。
if [[ -n "\$STATUS_DIR" ]]; then
  rm -f "\$STATUS_DIR/.notified-\$SLUG" "\$STATUS_DIR/.notified-reviewer-\$SLUG" \
        "\$STATUS_DIR/.stop-watcher-\$SLUG"
fi

# standby wrapper は起動時に status.json を書かない (同じ STATUS_DIR を Child が使用中のため)
if [[ "\$STANDBY" != "1" ]]; then
  write_status "executing" "runner session starting"
fi

# --- status.json watcher ---
# 子が終端 status を書いても TUI が idle のまま残ると、この wrapper は下の
# 子プロセス待ちでブロックしたまま通知に到達しない。そこで子と並行して
# status.json を poll し、終端遷移を検知した時点で親へ通知する。
# 抑止条件は exit パスの所有権判定と同一。.deferred / .assigned-* は実行中に
# 作られるため poll のたびに再評価する。
# 通知に失敗しても marker を更新しないので、次の poll がそのまま再試行になる。
WATCH_INTERVAL="\${CMUX_DISPATCH_WATCH_INTERVAL:-15}"
WATCHER_PID=""
if [[ -n "\$STATUS_DIR" ]]; then
  (
    while true; do
      # 停止要求への追随を 1 秒以内にするため、待機は 1 秒刻みに分割する。
      # まとめて sleep すると、短時間で終わる子の exit パスが最大 WATCH_INTERVAL 秒
      # 待たされ、既存の回帰テストも同じだけ遅くなる。
      [[ -f "\$STATUS_DIR/.stop-watcher-\$SLUG" ]] && exit 0
      _slept=0
      while (( _slept < WATCH_INTERVAL )); do
        sleep 1
        _slept=\$(( _slept + 1 ))
        [[ -f "\$STATUS_DIR/.stop-watcher-\$SLUG" ]] && exit 0
      done

      [[ -n "\$TIMEOUT_SENTINEL" && -f "\$TIMEOUT_SENTINEL" ]] && continue
      [[ "\$DEFER_STATUS" == "1" && -f "\$STATUS_DIR/.deferred" ]] && continue
      [[ "\$STANDBY" == "1" && ! -f "\$STATUS_DIR/.assigned-\$SLUG" ]] && continue

      # 所有権を他 pane へ渡した (.assigned → .deferred の間の窓)
      if [[ "\$DEFER_STATUS" == "1" ]]; then
        _foreign=0
        for _a in "\$STATUS_DIR"/.assigned-*; do
          [[ -e "\$_a" ]] || continue
          [[ "\$_a" == "\$STATUS_DIR/.assigned-\$SLUG" ]] || _foreign=1
        done
        (( _foreign )) && continue
      fi

      [[ -f "\$STATUS_DIR/status.json" ]] || continue
      _st=\$(jq -r '.status // empty' "\$STATUS_DIR/status.json" 2>/dev/null || echo "")
      [[ "\$_st" == "done" || "\$_st" == "error" ]] || continue

      notify_parent_once "\$_st" || continue
      notify_reviewer_once "\$_st" || continue
      exit 0
    done
  ) &
  WATCHER_PID=\$!
fi

SESSION_EXIT=0
${SESSION_CMD}
SESSION_EXIT=\$?

# watcher を協調的に停止する。強制 kill は通知の途中で切れる可能性があるため、
# 先に sentinel を置いて自発的な終了を最大 20 秒待ち、それでも残る場合だけ kill する。
if [[ -n "\$WATCHER_PID" ]]; then
  [[ -n "\$STATUS_DIR" ]] && : > "\$STATUS_DIR/.stop-watcher-\$SLUG"
  for _i in \$(seq 1 20); do
    kill -0 "\$WATCHER_PID" 2>/dev/null || break
    sleep 1
  done
  kill "\$WATCHER_PID" 2>/dev/null || true
  wait "\$WATCHER_PID" 2>/dev/null || true
fi

# ループモード: batch-wait.sh が deadline 超過でこのタスクを terminal 化済みなら、
# 遅れて終了した子が status.json を上書きしたり、cleanup 済みの STATUS_DIR を
# mkdir -p で復活させたりしないよう、ここで何も書かずに終了する。
if [[ -n "\$TIMEOUT_SENTINEL" && -f "\$TIMEOUT_SENTINEL" ]]; then
  echo "[runner] timeout sentinel found at \$TIMEOUT_SENTINEL; skipping status update" >&2
  exit 0
fi

# defer-status: Phase B で別 surface (孫セッション) に実行を移譲した場合、
# Child セッション側の runner wrapper はここで status.json を上書きせず exit する。
# 孫セッションの runner wrapper が status を上書きするのでそちらに任せる。
# Child 側 Claude は exit 前に "<STATUS_DIR>/.deferred" を touch することで意思表示する。
if [[ "\$DEFER_STATUS" == "1" && -n "\$STATUS_DIR" && -f "\$STATUS_DIR/.deferred" ]]; then
  echo "[runner] status update deferred (.deferred sentinel found at \$STATUS_DIR/.deferred)" >&2
  exit 0
fi

# standby: .assigned-<workspace-name> sentinel が無ければ実装を引き受けていない。status を
# 書かずに終了する (未使用 standby tab を閉じても status.json を汚さないための仕組み —
# .deferred の逆向き)。ロール別ファイルにすることで、同じ STATUS_DIR を共有する
# sonnet/codex 等の standby 同士が互いの割り当てを誤検知しない
if [[ "\$STANDBY" == "1" && ! -f "\$STATUS_DIR/.assigned-\$SLUG" ]]; then
  echo "[runner] standby exiting without assignment (no .assigned-\$SLUG at \$STATUS_DIR)" >&2
  exit 0
fi

# 外部から pane を閉じられた場合 (最終クリーンアップの cmux close-surface /
# close-workspace)、子プロセスは signal 由来の終了コード (128+N。SIGHUP=129 /
# SIGKILL=137 / SIGTERM=143) を返す。これはタスクの失敗ではないので、既に
# terminal な status.json が記録済みなら error への降格と偽の完了通知を抑止する。
# status がまだ terminal でない (executing 等) 場合は本当に途中終了なので、
# 従来どおり error を書いて通知する。
PREV_STATUS=""
if [[ -n "\$STATUS_DIR" && -f "\$STATUS_DIR/status.json" ]]; then
  PREV_STATUS=\$(jq -r '.status // empty' "\$STATUS_DIR/status.json" 2>/dev/null || echo "")
fi
if [[ \$SESSION_EXIT -ge 128 && ( "\$PREV_STATUS" == "done" || "\$PREV_STATUS" == "error" ) ]]; then
  echo "[runner] terminated by signal (exit \$SESSION_EXIT) after terminal status '\$PREV_STATUS'; skipping status update and notification" >&2
  exit 0
fi

# 子が書いた終端 status は上書きしない。
# - error: 握り潰すと ABORT プロトコル (status error を書いてセッション終了) が無効化される
# - done + 正常終了: 子が書いた変更サマリを "runner session completed" で潰さない
# - done + 異常終了: done 宣言後のクラッシュは保守的に error 扱いとして親に調査させる
FINAL_STATUS=""
if [[ "\$PREV_STATUS" == "error" ]]; then
  FINAL_STATUS="error"
  echo "[runner] preserving child-written terminal status 'error'" >&2
elif [[ "\$PREV_STATUS" == "done" && \$SESSION_EXIT -eq 0 ]]; then
  FINAL_STATUS="done"
  echo "[runner] preserving child-written terminal status 'done'" >&2
elif [[ \$SESSION_EXIT -eq 0 ]]; then
  write_status "done" "runner session completed (exit 0)"
  FINAL_STATUS="done"
else
  write_status "error" "runner session exited with code \$SESSION_EXIT"
  FINAL_STATUS="error"
fi

if [[ -n "\$NOTIFY_WS" ]]; then
  "\$CMUX" notify --title "Done: \$SLUG" \\
    --body "Exit code: \$SESSION_EXIT" \\
    --workspace "\$NOTIFY_WS" 2>/dev/null || true
fi

notify_parent_once "\$FINAL_STATUS" || \\
  echo "[runner] parent notification failed for status '\$FINAL_STATUS'" >&2
notify_reviewer_once "\$FINAL_STATUS" || \\
  echo "[runner] reviewer abort notification failed (best-effort)" >&2
EOF
chmod +x "$RUNNER_FILE"
log "runner" "generated $RUNNER_FILE"

# --- Step 5: Create cmux workspace OR split pane ---

WORKSPACE_ID=""
SURFACE_ID=""
TITLE=""

if [[ ( "$MODE" == "standby" || "$MODE" == "review" ) && -n "$STANDBY_IN" ]]; then
  # --- Standby Split Placement: 既存 workspace 内に縦分割ペインを追加 ---
  WORKSPACE_ID="$STANDBY_IN"
  TITLE="$WORKSPACE_NAME"

  log "cmux" "creating standby pane (split $STANDBY_SPLIT_DIRECTION from $STANDBY_SPLIT_FROM) in $STANDBY_IN"
  SPLIT_OUTPUT=$("$CMUX" new-split "$STANDBY_SPLIT_DIRECTION" \
    --workspace "$STANDBY_IN" \
    --surface "$STANDBY_SPLIT_FROM" 2>/dev/null) || die "failed to create standby split pane"
  SURFACE_ID=$(echo "$SPLIT_OUTPUT" | grep -oE 'surface:[0-9]+' | head -1)
  [[ -z "$SURFACE_ID" ]] && die "failed to parse surface ID from split output: $SPLIT_OUTPUT"
  log "cmux" "standby pane surface: $SURFACE_ID"

  "$CMUX" rename-tab --workspace "$STANDBY_IN" --surface "$SURFACE_ID" "$TITLE" >/dev/null 2>&1 || \
    log "cmux" "warning: failed to rename tab (non-fatal)"

  wait_for_shell "$SURFACE_ID" || true

  # send-prompt-exempt: TUI へのメッセージ配送ではなくシェルへのコマンド打鍵。
  # 末尾の \n が自分で改行を送るので send-key return は不要であり、貼り付け判定の
  # 問題も起きない (宛先はまだ素のシェルで TUI が立ち上がっていない)。
  "$CMUX" send --surface "$SURFACE_ID" \
    "cd '$CWD' && bash $RUNNER_SCRIPT_NAME\n" >/dev/null 2>&1 || die "failed to send cd+runner command"
  log "cmux" "standby runner command sent"

else
  # --- Workspace Mode ---
  # Use `--command` so the runner starts the instant the workspace shell is ready.
  # This is strictly better than creating the workspace and then sending the
  # runner via `cmux send`: on some environments the new surface is not a
  # terminal at creation time, which previously caused dropped commands.
  log "cmux" "creating workspace with cwd=$CWD, auto-launching runner via --command"
  WORKSPACE_OUTPUT=$("$CMUX" new-workspace --cwd "$CWD" --command "bash $RUNNER_SCRIPT_NAME" 2>/dev/null) \
    || die "failed to create cmux workspace"
  WORKSPACE_ID=$(echo "$WORKSPACE_OUTPUT" | grep -oE 'workspace:[0-9]+' | head -1)
  [[ -z "$WORKSPACE_ID" ]] && die "failed to parse workspace ID from output: $WORKSPACE_OUTPUT"
  log "cmux" "created $WORKSPACE_ID"

  # Rename workspace
  TITLE="[$REPO_NAME] $WORKSPACE_NAME"
  "$CMUX" rename-workspace --workspace "$WORKSPACE_ID" "$TITLE" >/dev/null 2>&1 || die "failed to rename workspace"
  log "cmux" "renamed to: $TITLE"

  # Get surface ID (for initial status payload; the runner resolves its own at runtime)
  SURFACE_OUTPUT=$("$CMUX" list-pane-surfaces --workspace "$WORKSPACE_ID" 2>/dev/null) || die "failed to list pane surfaces"
  SURFACE_ID=$(echo "$SURFACE_OUTPUT" | grep -oE 'surface:[0-9]+' | head -1)
  [[ -z "$SURFACE_ID" ]] && die "failed to parse surface ID from output: $SURFACE_OUTPUT"
  log "cmux" "surface: $SURFACE_ID"

fi

# --- Step 6: Write initial "launched" status ---
# Race protection: the runner is already running in workspace mode,
# so it may have already written "executing"/"done"/"error" to status.json.
# Do not regress from those to "launched".

if [[ -n "$STATUS_DIR" && "$MODE" != "standby" && "$MODE" != "review" ]]; then
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
        --arg layout "workspace" \
        --arg msg "Runner session launched in $MODE mode (workspace layout)" \
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
  --arg layout "workspace" \
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
