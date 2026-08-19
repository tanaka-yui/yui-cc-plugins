#!/bin/bash
# Pre-warm standby panes: タスク workspace に要求された設計・レビュー・実装ペインを事前起動する。
#
# 配置は 2 行のグリッド。上段が design (左) と review (右)、下段に実装ペインを横並びに置く:
#   design = workspace のメイン surface
#   review = design から right split
#   実装   = 1 つ目が design から down split、2 つ目以降は直前の実装ペインから right split
# 実装 2 つ + review でちょうど 2×2 になる。固定 exec_choice なら実装は 1 つだけ。
#
# Usage:
#   agmsg 未使用 (design は通常フローで起動済み。claude / codex 実装 executor の split のみ追加):
#     prewarm-panes.sh --workspace <ws-id> --base-surface <sf-id> \
#       --cwd <worktree> --slug <task-slug> --status-dir <dir> \
#       [--claude-runner <name>] [--codex-runner <name>] [--exec-runner <name>] \
#       [--design-model <m>] [--design-effort <e>] \
#       [--reviewer-model <m>] [--reviewer-effort <e>] \
#       [--exec-model <m>] [--exec-effort <e>] \
#       [--review-model <model>] \
#       [--design-runner <name>] [--reviewer-runner <name>] \
#       [--parent-notify-workspace <ws-id>] [--parent-notify-surface <sf-id>] [--unattended]
#
#   agmsg 使用 (workspace 未作成の状態で呼ぶ。--with-design で design standby も起動し workspace はこのスクリプトが作成):
#     prewarm-panes.sh --with-design \
#       --cwd <worktree> --slug <task-slug> --status-dir <dir> \
#       --agmsg-team <team> \
#       [--claude-runner <name>] [--codex-runner <name>] \
#       [--exec-runner <name>] [--exec-choice <choice>] \
#       [--design-model <m>] [--design-effort <e>] \
#       [--reviewer-model <m>] [--reviewer-effort <e>] \
#       [--exec-model <m>] [--exec-effort <e>] \
#       [--review-model <model>] \
#       [--design-runner <name>] [--reviewer-runner <name>] \
#       [--parent-notify-workspace <ws-id>] [--parent-notify-surface <sf-id>] [--unattended]
#
# 注意: --agmsg-team を --with-design なしで渡す組み合わせは SKILL からは使用しない
#       (claude/codex executor の配線のみ行いたい特殊用途向け)
#
# 内部処理:
#   0. 役割別の model/effort 上書き (--override 由来) を該当ペインへ --model / --effort で転送
#   1. worktree を create-or-reuse (agmsg 配線より先にディレクトリが必要)
#   2. (agmsg 時) join.sh + delivery.sh set を「ペイン起動前に」実行。
#      配線に失敗したペインは delivery: "cmux-send" として記録 (die しない)
#   3. (--with-design 時) 設計 standby を workspace 配置で起動 (メイン surface が design ペイン)
#   4. --exec-choice で選ばれた engine の実装 standby を split で配置
#   5. --review-model または --reviewer-runner 時に review ペインを split 配置
#   6. <STATUS_DIR>/prewarm.json を design / review? / executors スキーマで書き込む
#   --unattended: ループモード専用。設計ペイン (claude engine 時は opus standby、--role plan の既定解決による) の起動に
#                 --skip-permissions を付ける (無人実行で permission prompt / ExitPlanMode
#                 承認により停止しないようにするため)。codex 系は bypass フラグで解決済み
#   --timeout-sentinel <path>: ループモード専用。status 所有者になり得る全 standby
#                 (design / review / 実行) の launch へ
#                 そのまま転送する。batch-wait.sh が timeout として terminal 化した後に
#                 遅れて終了した子が status.json を上書きするのを防ぐ
#
# Output: JSON to stdout: {workspace_id, panes: {design?, review?, executors}}
# Debug:  Logs to stderr

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGMSG_DIR="${AGMSG_DIR:-$HOME/.agents/skills/agmsg/scripts}"

die() {
  echo "Error: $1" >&2
  exit 1
}

log() {
  echo "[$1] $2" >&2
}

# --- Argument Parsing ---

WORKSPACE=""
BASE_SURFACE=""
CWD=""
SLUG=""
STATUS_DIR=""
CODEX_RUNNER=""
CLAUDE_RUNNER=""
EXEC_RUNNER=""
REVIEW_MODEL=""
AGMSG_TEAM=""
WITH_DESIGN=0
EXEC_CHOICE=""
NOTIFY_WORKSPACE=""
NOTIFY_SURFACE=""
DESIGN_RUNNER=""
REVIEWER_RUNNER=""
DESIGN_ENGINE="claude"
REVIEWER_ENGINE=""
REVIEW_MODEL_RESOLVED=""
EXEC_ENGINE=""
DESIGN_MODEL_OVERRIDE=""
DESIGN_EFFORT_OVERRIDE=""
REVIEWER_MODEL_OVERRIDE=""
REVIEWER_EFFORT_OVERRIDE=""
EXEC_MODEL_OVERRIDE=""
EXEC_EFFORT_OVERRIDE=""
UNATTENDED=0
TIMEOUT_SENTINEL=""
RUNNERS_CONFIG_PATH="${RUNNERS_CONFIG_PATH:-$HOME/.claude/cmux-team-dispatch-task/runners.json}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --workspace)
      [[ $# -lt 2 ]] && die "--workspace requires a workspace ID"
      WORKSPACE="$2"; shift 2 ;;
    --base-surface)
      [[ $# -lt 2 ]] && die "--base-surface requires a surface ID"
      BASE_SURFACE="$2"; shift 2 ;;
    --cwd)
      [[ $# -lt 2 ]] && die "--cwd requires a path argument"
      CWD="$2"; shift 2 ;;
    --slug)
      [[ $# -lt 2 ]] && die "--slug requires a task slug"
      SLUG="$2"; shift 2 ;;
    --status-dir)
      [[ $# -lt 2 ]] && die "--status-dir requires a path argument"
      STATUS_DIR="$2"; shift 2 ;;
    --codex-runner)
      [[ $# -lt 2 ]] && die "--codex-runner requires a runner name"
      CODEX_RUNNER="$2"; shift 2 ;;
    --claude-runner)
      [[ $# -lt 2 ]] && die "--claude-runner requires a runner name"
      CLAUDE_RUNNER="$2"; shift 2 ;;
    --exec-runner)
      [[ $# -lt 2 ]] && die "--exec-runner requires a runner name"
      EXEC_RUNNER="$2"; shift 2 ;;
    --design-runner)
      [[ $# -lt 2 ]] && die "--design-runner requires a runner name"
      DESIGN_RUNNER="$2"; shift 2 ;;
    --reviewer-runner)
      [[ $# -lt 2 ]] && die "--reviewer-runner requires a runner name"
      REVIEWER_RUNNER="$2"; shift 2 ;;
    --review-model)
      [[ $# -lt 2 ]] && die "--review-model requires a model name"
      REVIEW_MODEL="$2"; shift 2 ;;
    --exec-choice)
      [[ $# -lt 2 ]] && die "--exec-choice requires a choice"
      EXEC_CHOICE="$2"; shift 2 ;;
    # 役割別の一時上書き (--override 経由)。指定時は launch-workspace.sh の
    # 役割フォールバックより優先される明示値として該当ペインへ転送する
    --design-model)
      [[ $# -lt 2 ]] && die "--design-model requires a model name"
      DESIGN_MODEL_OVERRIDE="$2"; shift 2 ;;
    --design-effort)
      [[ $# -lt 2 ]] && die "--design-effort requires an effort level"
      DESIGN_EFFORT_OVERRIDE="$2"; shift 2 ;;
    --reviewer-model)
      [[ $# -lt 2 ]] && die "--reviewer-model requires a model name"
      REVIEWER_MODEL_OVERRIDE="$2"; shift 2 ;;
    --reviewer-effort)
      [[ $# -lt 2 ]] && die "--reviewer-effort requires an effort level"
      REVIEWER_EFFORT_OVERRIDE="$2"; shift 2 ;;
    --exec-model)
      [[ $# -lt 2 ]] && die "--exec-model requires a model name"
      EXEC_MODEL_OVERRIDE="$2"; shift 2 ;;
    --exec-effort)
      [[ $# -lt 2 ]] && die "--exec-effort requires an effort level"
      EXEC_EFFORT_OVERRIDE="$2"; shift 2 ;;
    # v1.16.0 で削除。agmsg を使うかは --agmsg-team の有無と send.sh の存在で決まる。
    --message-type)
      die "--message-type was removed: agmsg is wired whenever --agmsg-team is given and send.sh exists" ;;
    --agmsg-team)
      [[ $# -lt 2 ]] && die "--agmsg-team requires a team name"
      AGMSG_TEAM="$2"; shift 2 ;;
    --with-design|--with-opus)
      WITH_DESIGN=1; shift ;;
    --unattended)
      UNATTENDED=1; shift ;;
    --timeout-sentinel)
      [[ $# -lt 2 ]] && die "--timeout-sentinel requires a path"
      TIMEOUT_SENTINEL="$2"; shift 2 ;;
    --parent-notify-workspace)
      [[ $# -lt 2 ]] && die "--parent-notify-workspace requires a workspace ID"
      NOTIFY_WORKSPACE="$2"; shift 2 ;;
    --parent-notify-surface)
      [[ $# -lt 2 ]] && die "--parent-notify-surface requires a surface ID"
      NOTIFY_SURFACE="$2"; shift 2 ;;
    *)
      die "unknown option: $1" ;;
  esac
done

# --- Validation ---

[[ -n "$CWD" ]] || die "--cwd is required"
[[ -n "$SLUG" ]] || die "--slug is required"
[[ "$SLUG" =~ ^[A-Za-z0-9._-]+$ ]] || die "invalid slug '$SLUG': use only [A-Za-z0-9._-]"
[[ -n "$STATUS_DIR" ]] || die "--status-dir is required"

if [[ -n "$REVIEW_MODEL" && -z "$CODEX_RUNNER" ]]; then
  die "--review-model requires --codex-runner"
fi

# --reviewer-model は --reviewer-runner 経路の上書き、--review-model は claude 設計の
# legacy 指定。両方渡すのは意図の取り違えなので受け付けない。
if [[ -n "$REVIEWER_MODEL_OVERRIDE" && -n "$REVIEW_MODEL" ]]; then
  die "--reviewer-model and --review-model are mutually exclusive"
fi

# design=codex / reviewer の解決。runner の engine と model/effort を runners.json から引く
if [[ -n "$DESIGN_RUNNER" ]]; then
  [[ -f "$RUNNERS_CONFIG_PATH" ]] || die "runners.json not found at $RUNNERS_CONFIG_PATH (required for --design-runner)"
  DESIGN_ENGINE=$(jq -r --arg n "$DESIGN_RUNNER" '.runners[]? | select(.name == $n) | .engine // "claude"' "$RUNNERS_CONFIG_PATH")
  [[ -n "$DESIGN_ENGINE" ]] || die "design runner '$DESIGN_RUNNER' not found in $RUNNERS_CONFIG_PATH"
fi
if [[ -n "$REVIEWER_RUNNER" ]]; then
  [[ -n "$REVIEW_MODEL" ]] && die "--reviewer-runner and --review-model are mutually exclusive"
  REVIEWER_ENGINE=$(jq -r --arg n "$REVIEWER_RUNNER" '.runners[]? | select(.name == $n) | .engine // "claude"' "$RUNNERS_CONFIG_PATH")
  [[ -n "$REVIEWER_ENGINE" ]] || die "reviewer runner '$REVIEWER_RUNNER' not found in $RUNNERS_CONFIG_PATH"
  REVIEW_MODEL_RESOLVED=$(jq -r --arg n "$REVIEWER_RUNNER" '.runners[]? | select(.name == $n) | .review_model // empty' "$RUNNERS_CONFIG_PATH")
  if [[ "$REVIEWER_ENGINE" == "codex" && -z "$REVIEW_MODEL_RESOLVED" ]]; then
    die "codex reviewer runner '$REVIEWER_RUNNER' requires review_model"
  fi
fi
if [[ "$DESIGN_ENGINE" == "codex" && -n "$REVIEW_MODEL" ]]; then
  die "--review-model is for claude-design tasks; use --reviewer-runner when the design runner is codex"
fi
if [[ -n "$EXEC_RUNNER" ]]; then
  [[ -f "$RUNNERS_CONFIG_PATH" ]] \
    || die "runners.json not found at $RUNNERS_CONFIG_PATH (required for --exec-runner)"
  EXEC_ENGINE=$(jq -r --arg n "$EXEC_RUNNER" \
    '.runners[]? | select(.name == $n) | .engine // empty' "$RUNNERS_CONFIG_PATH")
  [[ -n "$EXEC_ENGINE" ]] || die "exec runner '$EXEC_RUNNER' not found in $RUNNERS_CONFIG_PATH"
fi
if [[ -n "$CLAUDE_RUNNER" ]]; then
  [[ -f "$RUNNERS_CONFIG_PATH" ]] \
    || die "runners.json not found at $RUNNERS_CONFIG_PATH (required for --claude-runner)"
  CLAUDE_RUNNER_ENGINE=$(jq -r --arg n "$CLAUDE_RUNNER" \
    '.runners[]? | select(.name == $n) | .engine // empty' "$RUNNERS_CONFIG_PATH")
  [[ -n "$CLAUDE_RUNNER_ENGINE" ]] || die "claude runner '$CLAUDE_RUNNER' not found in $RUNNERS_CONFIG_PATH"
  [[ "$CLAUDE_RUNNER_ENGINE" == "claude" ]] || die "--claude-runner requires a claude engine runner"
fi

# 役割ごとの model / effort を runners.json + 既定値から解決する。launch-workspace.sh の
# 役割フォールバックと同じ表を使う (どちらか一方だけ変えると in-session 判定がずれる)。
resolve_role_model() {
  local runner="$1" role="$2" engine="$3" value=""
  if [[ -n "$runner" && -f "$RUNNERS_CONFIG_PATH" ]]; then
    value=$(jq -r --arg n "$runner" --arg f "${role}_model" \
      '.runners[]? | select(.name == $n) | .[$f] // empty' "$RUNNERS_CONFIG_PATH")
  fi
  if [[ -z "$value" && "$engine" == "claude" ]]; then
    case "$role" in
      plan|review) value="opus[1m]" ;;
      exec) value="sonnet" ;;
    esac
  fi
  printf '%s' "$value"
}

resolve_role_effort() {
  local runner="$1" role="$2" value=""
  if [[ -n "$runner" && -f "$RUNNERS_CONFIG_PATH" ]]; then
    value=$(jq -r --arg n "$runner" --arg f "${role}_effort" \
      '.runners[]? | select(.name == $n) | .[$f] // empty' "$RUNNERS_CONFIG_PATH")
  fi
  if [[ -z "$value" ]]; then
    case "$role" in
      plan|review) value="xhigh" ;;
      exec) value="high" ;;
    esac
  fi
  printf '%s' "$value"
}

# 役割別上書きを launch-workspace.sh の --model / --effort へ転送する配列。
# 空になりうるので展開は必ず ${arr[@]+"${arr[@]}"} を使う。
DESIGN_OVERRIDE_FLAGS=()
[[ -n "$DESIGN_MODEL_OVERRIDE" ]] && DESIGN_OVERRIDE_FLAGS+=(--model "$DESIGN_MODEL_OVERRIDE")
[[ -n "$DESIGN_EFFORT_OVERRIDE" ]] && DESIGN_OVERRIDE_FLAGS+=(--effort "$DESIGN_EFFORT_OVERRIDE")

EXEC_OVERRIDE_FLAGS=()
[[ -n "$EXEC_MODEL_OVERRIDE" ]] && EXEC_OVERRIDE_FLAGS+=(--model "$EXEC_MODEL_OVERRIDE")
[[ -n "$EXEC_EFFORT_OVERRIDE" ]] && EXEC_OVERRIDE_FLAGS+=(--effort "$EXEC_EFFORT_OVERRIDE")

REVIEW_OVERRIDE_FLAGS=()
[[ -n "$REVIEWER_MODEL_OVERRIDE" ]] && REVIEW_OVERRIDE_FLAGS+=(--model "$REVIEWER_MODEL_OVERRIDE")
[[ -n "$REVIEWER_EFFORT_OVERRIDE" ]] && REVIEW_OVERRIDE_FLAGS+=(--effort "$REVIEWER_EFFORT_OVERRIDE")

# 実装ペインは engine 単位。exec_choice は「どの engine が実装するか」だけを表し、
# モデルと effort は runners.json の役割フィールドが決める。
START_CLAUDE=0
START_CODEX=0
case "$EXEC_CHOICE" in
  ""|ask)
    [[ -n "$CLAUDE_RUNNER" || "$DESIGN_ENGINE" == "claude" ]] && START_CLAUDE=1
    [[ -n "$CODEX_RUNNER" ]] && START_CODEX=1
    ;;
  claude)
    [[ -z "$EXEC_RUNNER" || "$EXEC_ENGINE" == "claude" ]] \
      || die "exec_choice=claude requires a claude exec runner"
    START_CLAUDE=1 ;;
  codex)
    [[ -n "$EXEC_RUNNER" || -n "$CODEX_RUNNER" ]] \
      || die "exec_choice=codex requires --exec-runner or --codex-runner"
    [[ -z "$EXEC_RUNNER" || "$EXEC_ENGINE" == "codex" ]] \
      || die "exec_choice=codex requires a codex exec runner"
    START_CODEX=1 ;;
  *) die "invalid --exec-choice '$EXEC_CHOICE' (must be claude, codex, or ask)" ;;
esac

# claude/codex 実装 runner 名をここで解決する。Step 4/5 の起動と in-session 判定の
# 両方がこの変数を参照するので、起動側とは別の式で再計算して乖離させない。
CLAUDE_EXEC_RUNNER=""
if [[ "$EXEC_CHOICE" == "claude" ]]; then
  CLAUDE_EXEC_RUNNER="$EXEC_RUNNER"
elif [[ -z "$EXEC_CHOICE" || "$EXEC_CHOICE" == "ask" ]]; then
  CLAUDE_EXEC_RUNNER="$CLAUDE_RUNNER"
  [[ -z "$CLAUDE_EXEC_RUNNER" && "$DESIGN_ENGINE" == "claude" ]] && CLAUDE_EXEC_RUNNER="$DESIGN_RUNNER"
fi
# exec_choice=claude のとき EXEC_RUNNER は claude runner 名を持つため、無条件で
# ${EXEC_RUNNER:-$CODEX_RUNNER} にすると codex 用のこの変数が claude runner 名を
# 引き継んでしまう (実害は START_CODEX=0 で未使用のため無いが、次の変更で罠になる)。
# CLAUDE_EXEC_RUNNER と対称に、exec_choice が実際に codex のときだけ EXEC_RUNNER を使う。
CODEX_EXEC_RUNNER=""
if [[ "$EXEC_CHOICE" == "codex" ]]; then
  CODEX_EXEC_RUNNER="$EXEC_RUNNER"
elif [[ -z "$EXEC_CHOICE" || "$EXEC_CHOICE" == "ask" ]]; then
  CODEX_EXEC_RUNNER="$CODEX_RUNNER"
fi

# 役割設定 (engine + model + effort) が完全一致するときは、設計セッションがそのまま
# 実装するので実装ペインを起動しない。effort を条件に含めるのは、effort がセッション
# 起動時に焼き込まれ、後から変える手段が無いため (モデルだけ一致していても
# exec_effort の設定が無視されてしまう)。
# exec_choice=ask は実装 engine が未確定なので判定せず、全候補を起動する。
if [[ -n "$EXEC_CHOICE" && "$EXEC_CHOICE" != "ask" ]]; then
  EXEC_ROLE_ENGINE="${EXEC_ENGINE:-$EXEC_CHOICE}"
  if [[ "$EXEC_ROLE_ENGINE" == "$DESIGN_ENGINE" ]]; then
    # 実装 runner は Step 4/5 が実際に起動へ渡す変数 (CLAUDE_EXEC_RUNNER /
    # CODEX_EXEC_RUNNER) と同じものを読む。EXEC_RUNNER/DESIGN_RUNNER から
    # 独自に再計算すると、--exec-runner 省略時に起動側 (フォールバック無し)
    # と判定側がずれる。
    EXEC_ROLE_RUNNER="$CLAUDE_EXEC_RUNNER"
    [[ "$EXEC_ROLE_ENGINE" == "codex" ]] && EXEC_ROLE_RUNNER="$CODEX_EXEC_RUNNER"
    # 上書きがあればそれが解決値。無ければ runners.json + 既定値から解く。
    PLAN_MODEL_RESOLVED="${DESIGN_MODEL_OVERRIDE:-$(resolve_role_model "$DESIGN_RUNNER" plan "$DESIGN_ENGINE")}"
    PLAN_EFFORT_RESOLVED="${DESIGN_EFFORT_OVERRIDE:-$(resolve_role_effort "$DESIGN_RUNNER" plan)}"
    EXEC_MODEL_RESOLVED="${EXEC_MODEL_OVERRIDE:-$(resolve_role_model "$EXEC_ROLE_RUNNER" exec "$EXEC_ROLE_ENGINE")}"
    EXEC_EFFORT_RESOLVED="${EXEC_EFFORT_OVERRIDE:-$(resolve_role_effort "$EXEC_ROLE_RUNNER" exec)}"
    if [[ "$PLAN_MODEL_RESOLVED" == "$EXEC_MODEL_RESOLVED" \
       && "$PLAN_EFFORT_RESOLVED" == "$EXEC_EFFORT_RESOLVED" ]]; then
      log "prewarm" "in-session execution (role config identical); skipping the executor pane"
      START_CLAUDE=0
      START_CODEX=0
    fi
  fi
fi

if [[ $WITH_DESIGN -eq 1 ]]; then
  # agmsg モード専用: workspace はこのスクリプトが作成する
  [[ -n "$AGMSG_TEAM" ]] || die "--with-design requires --agmsg-team"
  [[ -z "$WORKSPACE" && -z "$BASE_SURFACE" ]] \
    || die "--with-design is mutually exclusive with --workspace/--base-surface"
else
  [[ -n "$WORKSPACE" ]] || die "--workspace is required (without --with-design)"
  [[ -n "$BASE_SURFACE" ]] || die "--base-surface is required (without --with-design)"
fi

if [[ -n "$AGMSG_TEAM" ]]; then
  [[ -f "$AGMSG_DIR/send.sh" ]] || die "agmsg is not installed (expected $AGMSG_DIR/send.sh)"
fi

command -v jq &>/dev/null || die "jq is not installed"
command -v git &>/dev/null || die "git is not installed"

# 共通の notify / agmsg フラグ (配列で組み立てて quote 事故を防ぐ)
# 注意: macOS の bash 3.2 は set -u 下で空配列の "${arr[@]}" 展開がエラーになるため、
# 空になりうる配列の展開は必ず ${arr[@]+"${arr[@]}"} イディオムを使う
NOTIFY_FLAGS=()
[[ -n "$NOTIFY_WORKSPACE" ]] && NOTIFY_FLAGS+=(--parent-notify-workspace "$NOTIFY_WORKSPACE")
[[ -n "$NOTIFY_SURFACE" ]] && NOTIFY_FLAGS+=(--parent-notify-surface "$NOTIFY_SURFACE")

# ループモードでは、status 所有者になり得る全 standby wrapper に timeout sentinel を
# 焼き込む。ここで転送しないと prewarm 経路 (既定) では sentinel が効かず、
# timeout 後に遅れて終了した子が status.json を上書きしてしまう
SENTINEL_FLAGS=()
[[ -n "$TIMEOUT_SENTINEL" ]] && SENTINEL_FLAGS=(--timeout-sentinel "$TIMEOUT_SENTINEL")

# --- Step 1: worktree create-or-reuse ---
# agmsg 配線 (settings.local.json への hook 注入) が worktree ディレクトリを必要とするため、
# launch-workspace.sh に任せず先に作成する (ロジックは launch-workspace.sh と同一)。

if [[ -d "$CWD" ]]; then
  log "worktree" "already exists at $CWD, reusing"
else
  BRANCH_NAME="feat/$SLUG"
  log "worktree" "creating $CWD with branch $BRANCH_NAME"
  if ! git worktree add "$CWD" -b "$BRANCH_NAME" 2>/dev/null; then
    git worktree add "$CWD" "$BRANCH_NAME" 2>/dev/null || die "failed to create worktree at $CWD"
  fi
fi

# --- Step 2: agmsg 配線 (ペイン起動前) ---
# delivery.sh set は worktree 相対の未追跡ファイル (.claude/settings.local.json /
# .codex/hooks.json) に SessionStart hook を注入する。セッション起動前に実行しないと
# hook が効かないため、必ずこの位置で行う。失敗したペインは cmux-send にフォールバック。

CLAUDE_DELIVERY="cmux-send"
CODEX_DELIVERY="cmux-send"
REVIEW_DELIVERY="cmux-send"
DESIGN_DELIVERY="cmux-send"
REVIEW_JOINED=0

wire_delivery() {
  local engine="$1"
  if [[ "$engine" == "codex" ]]; then
    if bash "$AGMSG_DIR/delivery.sh" set monitor codex "$CWD" >&2 2>/dev/null; then
      CODEX_DELIVERY="agmsg"
    else
      log "agmsg" "codex delivery wiring failed; falling back to cmux-send"
    fi
  else
    if bash "$AGMSG_DIR/delivery.sh" set monitor claude-code "$CWD" >&2 2>/dev/null; then
      CLAUDE_DELIVERY="agmsg"
    else
      log "agmsg" "claude-code delivery wiring failed; falling back to cmux-send"
    fi
  fi
}

if [[ -n "$AGMSG_TEAM" ]]; then
  if [[ $WITH_DESIGN -eq 1 ]]; then
    DESIGN_WIRING_TYPE="claude-code"
    [[ "$DESIGN_ENGINE" == "codex" ]] && DESIGN_WIRING_TYPE="codex"
    if bash "$AGMSG_DIR/join.sh" "$AGMSG_TEAM" "$SLUG" "$DESIGN_WIRING_TYPE" "$CWD" >&2 2>/dev/null; then
      wire_delivery "$DESIGN_ENGINE"
      [[ "$DESIGN_ENGINE" == "codex" ]] && DESIGN_DELIVERY="$CODEX_DELIVERY" || DESIGN_DELIVERY="$CLAUDE_DELIVERY"
    else
      log "agmsg" "design join failed; falling back to cmux-send"
    fi
  fi

  if [[ $START_CLAUDE -eq 1 ]]; then
    if bash "$AGMSG_DIR/join.sh" "$AGMSG_TEAM" "$SLUG-claude" claude-code "$CWD" >&2 2>/dev/null; then
      wire_delivery claude
    else
      log "agmsg" "claude executor join failed; falling back to cmux-send"
    fi
  fi

  if [[ $START_CODEX -eq 1 ]]; then
    if bash "$AGMSG_DIR/join.sh" "$AGMSG_TEAM" "$SLUG-codex" codex "$CWD" >&2 2>/dev/null; then
      wire_delivery codex
    else
      log "agmsg" "codex join failed; falling back to cmux-send"
    fi
  fi

  if [[ -n "$REVIEW_MODEL" || -n "$REVIEWER_RUNNER" ]]; then
    REVIEW_WIRING_ENGINE="${REVIEWER_ENGINE:-codex}"
    REVIEW_WIRING_TYPE="claude-code"
    [[ "$REVIEW_WIRING_ENGINE" == "codex" ]] && REVIEW_WIRING_TYPE="codex"
    if bash "$AGMSG_DIR/join.sh" "$AGMSG_TEAM" "$SLUG-review" "$REVIEW_WIRING_TYPE" "$CWD" >&2 2>/dev/null; then
      REVIEW_JOINED=1
      wire_delivery "$REVIEW_WIRING_ENGINE"
      [[ "$REVIEW_WIRING_ENGINE" == "codex" ]] && REVIEW_DELIVERY="$CODEX_DELIVERY" || REVIEW_DELIVERY="$CLAUDE_DELIVERY"
    else
      log "agmsg" "review join failed; falling back to cmux-send"
    fi
  fi
fi

# --- Step 3: 設計ペイン standby (agmsg モードのみ、workspace 配置) ---

DESIGN_SURFACE=""

if [[ $WITH_DESIGN -eq 1 ]]; then
  if [[ "$DESIGN_ENGINE" == "codex" ]]; then
    log "prewarm" "launching codex design workspace for $SLUG"
    DESIGN_RESULT=$(bash "$SCRIPT_DIR/launch-workspace.sh" \
      --cwd "$CWD" \
      --mode standby \
      --role plan \
      --defer-status \
      --runner "$DESIGN_RUNNER" \
      ${DESIGN_OVERRIDE_FLAGS[@]+"${DESIGN_OVERRIDE_FLAGS[@]}"} \
      ${SENTINEL_FLAGS[@]+"${SENTINEL_FLAGS[@]}"} \
      --status-dir "$STATUS_DIR" \
      ${NOTIFY_FLAGS[@]+"${NOTIFY_FLAGS[@]}"} \
      --agmsg-team "$AGMSG_TEAM" --agmsg-from "$SLUG" \
      "$SLUG") || die "failed to launch codex design workspace"
  else
    # actas で identity を claim してから待機する。タスク本文は含めない (後から届く)。
    # タスクは常に typed prompt で届く (agmsg push は idle セッションを起こせないため
    # wake チャネルにはならない — inbox には同一コピーが記録として残るだけ)。
    # 配線失敗 (CLAUDE_DELIVERY=cmux-send) のときは actas/watcher が不要なためスキップする
    if [[ "$CLAUDE_DELIVERY" == "agmsg" ]]; then
      OPUS_PROMPT="/agmsg actas $SLUG then wait idle. Your task will arrive as a prompt typed into this pane; an identical copy is also pushed to your agmsg inbox (treat both as ONE task — ignore the duplicate). Do not start any work until the task prompt arrives."
    else
      OPUS_PROMPT="Wait idle. Your task will be typed directly into this pane as a prompt. Do not start any work until it arrives."
    fi
    log "prewarm" "launching opus standby workspace for $SLUG"
    OPUS_UNATTENDED_FLAGS=()
    [[ $UNATTENDED -eq 1 ]] && OPUS_UNATTENDED_FLAGS=(--skip-permissions)
    # codex 分岐と対称にする: DESIGN_RUNNER が指定されていれば plan_model/plan_effort が
    # 設計ペインへ届くよう --runner を渡す (未指定時は launch-workspace.sh の既定に委ねる)
    DESIGN_RUNNER_FLAGS=()
    [[ -n "$DESIGN_RUNNER" ]] && DESIGN_RUNNER_FLAGS=(--runner "$DESIGN_RUNNER")
    DESIGN_RESULT=$(bash "$SCRIPT_DIR/launch-workspace.sh" \
      --cwd "$CWD" \
      --mode standby \
      --role plan \
      --defer-status \
      ${DESIGN_RUNNER_FLAGS[@]+"${DESIGN_RUNNER_FLAGS[@]}"} \
      ${DESIGN_OVERRIDE_FLAGS[@]+"${DESIGN_OVERRIDE_FLAGS[@]}"} \
      ${OPUS_UNATTENDED_FLAGS[@]+"${OPUS_UNATTENDED_FLAGS[@]}"} \
      ${SENTINEL_FLAGS[@]+"${SENTINEL_FLAGS[@]}"} \
      --status-dir "$STATUS_DIR" \
      ${NOTIFY_FLAGS[@]+"${NOTIFY_FLAGS[@]}"} \
      --agmsg-team "$AGMSG_TEAM" --agmsg-from "$SLUG" \
      "$SLUG" "$OPUS_PROMPT") || die "failed to launch opus standby workspace"
  fi
  WORKSPACE=$(echo "$DESIGN_RESULT" | jq -r '.workspace_id // empty')
  DESIGN_SURFACE=$(echo "$DESIGN_RESULT" | jq -r '.surface_id // empty')
  BASE_SURFACE="$DESIGN_SURFACE"
  [[ -n "$WORKSPACE" && -n "$DESIGN_SURFACE" ]] || die "failed to parse design standby output"
fi

# --- 実装ペインの配置ヘルパー ---
# 実装ペインは design の下に 1 行を作り、そこへ横並びで積む。
#   1 つ目 = design から down split (左下)
#   2 つ目以降 = 直前の実装ペインから right split (右下 …)
# review が design の右に入るので、実装 2 つ + review でちょうど 2×2 になる。
# down のまま縦積みすると左カラムが 3 段になり 2×2 が崩れるため、
# 2 つ目以降の direction は必ず right を渡す。

EXEC_LAST_SURFACE=""
EXEC_SPLIT_FLAGS=()

set_exec_split_flags() {
  if [[ -z "$EXEC_LAST_SURFACE" ]]; then
    EXEC_SPLIT_FLAGS=(--standby-split-from "$BASE_SURFACE")
  else
    EXEC_SPLIT_FLAGS=(--standby-split-from "$EXEC_LAST_SURFACE" --standby-split-direction right)
  fi
}

# --- Step 4: claude 実装 standby (選択時のみ、split 配置) ---

CLAUDE_EXEC_SURFACE=""
CLAUDE_EXEC_PROMPT=""
# CLAUDE_EXEC_RUNNER は case "$EXEC_CHOICE" の直後で解決済み (in-session 判定と共有)
AGMSG_FLAGS_CLAUDE=()
if [[ $START_CLAUDE -eq 1 && -n "$AGMSG_TEAM" ]]; then
  # design と同じ理由で delivery に応じて出し分ける (cmux-send フォールバック時は actas しない)
  if [[ "$CLAUDE_DELIVERY" == "agmsg" ]]; then
    CLAUDE_EXEC_PROMPT="/agmsg actas $SLUG-claude then wait idle. Execution instructions will arrive as a prompt typed into this pane; an identical copy is also pushed to your agmsg inbox (treat both as ONE task — ignore the duplicate). Do not start any work until the instructions arrive."
  else
    CLAUDE_EXEC_PROMPT="Wait idle. Execution instructions will be typed directly into this pane as a prompt. Do not start any work until they arrive."
  fi
  AGMSG_FLAGS_CLAUDE=(--agmsg-team "$AGMSG_TEAM" --agmsg-from "$SLUG-claude")
fi

if [[ $START_CLAUDE -eq 1 ]]; then
  log "prewarm" "launching claude executor standby pane for $SLUG"
  set_exec_split_flags
  CLAUDE_ARGS=(
    --cwd "$CWD"
    --mode standby
    --role exec
    --standby-in "$WORKSPACE"
    "${EXEC_SPLIT_FLAGS[@]}"
    --skip-permissions
    ${SENTINEL_FLAGS[@]+"${SENTINEL_FLAGS[@]}"}
    --status-dir "$STATUS_DIR"
    ${EXEC_OVERRIDE_FLAGS[@]+"${EXEC_OVERRIDE_FLAGS[@]}"}
  )
  [[ -n "$CLAUDE_EXEC_RUNNER" ]] && CLAUDE_ARGS+=(--runner "$CLAUDE_EXEC_RUNNER")
  CLAUDE_RESULT=$(bash "$SCRIPT_DIR/launch-workspace.sh" \
    "${CLAUDE_ARGS[@]}" \
    ${NOTIFY_FLAGS[@]+"${NOTIFY_FLAGS[@]}"} \
    ${AGMSG_FLAGS_CLAUDE[@]+"${AGMSG_FLAGS_CLAUDE[@]}"} \
    "$SLUG-claude" ${CLAUDE_EXEC_PROMPT:+"$CLAUDE_EXEC_PROMPT"}) || die "failed to launch claude executor standby pane"
  CLAUDE_EXEC_SURFACE=$(echo "$CLAUDE_RESULT" | jq -r '.surface_id // empty')
  [[ -n "$CLAUDE_EXEC_SURFACE" ]] || die "failed to parse claude executor standby output"
  EXEC_LAST_SURFACE="$CLAUDE_EXEC_SURFACE"
fi

# --- Step 5: codex standby (選択時のみ、実装行へ split 配置) ---
# codex は idle でも agmsg push を受けられる保証が無いため初期 prompt は常に無し。
# 実行指示の配送手段は CODEX_DELIVERY (prewarm.json) で分岐する。

CODEX_SURFACE=""

if [[ $START_CODEX -eq 1 ]]; then
  AGMSG_FLAGS_CODEX=()
  if [[ -n "$AGMSG_TEAM" ]]; then
    AGMSG_FLAGS_CODEX=(--agmsg-team "$AGMSG_TEAM" --agmsg-from "$SLUG-codex")
  fi
  log "prewarm" "launching codex standby pane for $SLUG"
  # CODEX_EXEC_RUNNER は case "$EXEC_CHOICE" の直後で解決済み (in-session 判定と共有)
  set_exec_split_flags
  CODEX_RESULT=$(bash "$SCRIPT_DIR/launch-workspace.sh" \
    --cwd "$CWD" \
    --mode standby \
    --role exec \
    --standby-in "$WORKSPACE" \
    "${EXEC_SPLIT_FLAGS[@]}" \
    --runner "$CODEX_EXEC_RUNNER" \
    ${EXEC_OVERRIDE_FLAGS[@]+"${EXEC_OVERRIDE_FLAGS[@]}"} \
    ${SENTINEL_FLAGS[@]+"${SENTINEL_FLAGS[@]}"} \
    --status-dir "$STATUS_DIR" \
    ${NOTIFY_FLAGS[@]+"${NOTIFY_FLAGS[@]}"} \
    ${AGMSG_FLAGS_CODEX[@]+"${AGMSG_FLAGS_CODEX[@]}"} \
    "$SLUG-codex") || die "failed to launch codex standby pane"
  CODEX_SURFACE=$(echo "$CODEX_RESULT" | jq -r '.surface_id // empty')
  [[ -n "$CODEX_SURFACE" ]] || die "failed to parse codex standby output"
  EXEC_LAST_SURFACE="$CODEX_SURFACE"
fi

# --- Step 5.5: review ペイン (--review-model / --reviewer-runner 時のみ、design の右に split 配置) ---
# standby と同じ wrapper だが .assigned-<slug>-review は誰も touch しない前提 —
# close しても status.json を汚さない。初期 prompt は codex standby と同じく常に無し。
# --reviewer-runner は engine を問わず利用できる。--review-model は claude 設計の
# 既存 codex review 指定として維持する。

REVIEW_SURFACE=""

leave_failed_review_join() {
  [[ $REVIEW_JOINED -eq 1 && -n "$AGMSG_TEAM" ]] || return 0
  if bash "$AGMSG_DIR/leave.sh" "$AGMSG_TEAM" "$SLUG-review" >/dev/null 2>&1; then
    REVIEW_JOINED=0
  else
    log "warn" "failed to leave review agmsg member after pane launch failure"
  fi
}

if [[ -n "$REVIEW_MODEL" || -n "$REVIEWER_RUNNER" ]]; then
  AGMSG_FLAGS_REVIEW=()
  if [[ -n "$REVIEWER_RUNNER" ]]; then
    log "prewarm" "launching review pane for $SLUG (reviewer runner: $REVIEWER_RUNNER)"
    REVIEW_PANE_NAME="$SLUG-review"
    REVIEW_RUNNER_FLAGS=(--runner "$REVIEWER_RUNNER")
    [[ "$REVIEWER_ENGINE" == "claude" ]] && REVIEW_RUNNER_FLAGS+=(--skip-permissions)
    if [[ -n "$AGMSG_TEAM" ]]; then
      AGMSG_FLAGS_REVIEW=(--agmsg-team "$AGMSG_TEAM" --agmsg-from "$SLUG-review")
    fi
  else
    log "prewarm" "launching codex review pane for $SLUG"
    REVIEW_PANE_NAME="$SLUG-review"
    REVIEW_RUNNER_FLAGS=(--runner "$CODEX_RUNNER" --model "$REVIEW_MODEL")
  fi
  if REVIEW_RESULT=$(bash "$SCRIPT_DIR/launch-workspace.sh" \
    --cwd "$CWD" \
    --mode review \
    --role review \
    --standby-in "$WORKSPACE" \
    --standby-split-from "$BASE_SURFACE" \
    --standby-split-direction right \
    "${REVIEW_RUNNER_FLAGS[@]}" \
    ${REVIEW_OVERRIDE_FLAGS[@]+"${REVIEW_OVERRIDE_FLAGS[@]}"} \
    ${SENTINEL_FLAGS[@]+"${SENTINEL_FLAGS[@]}"} \
    --status-dir "$STATUS_DIR" \
    ${NOTIFY_FLAGS[@]+"${NOTIFY_FLAGS[@]}"} \
    ${AGMSG_FLAGS_REVIEW[@]+"${AGMSG_FLAGS_REVIEW[@]}"} \
    "$REVIEW_PANE_NAME"); then
    if ! REVIEW_SURFACE=$(echo "$REVIEW_RESULT" | jq -er '.surface_id // empty'); then
      REVIEW_SURFACE=""
      leave_failed_review_join
      log "warn" "review pane output had no surface; review is disabled for this task"
    fi
  else
    leave_failed_review_join
    log "warn" "failed to launch review pane; review is disabled for this task"
  fi
fi

# --- Step 6: prewarm.json 書き込み + 出力 ---

mkdir -p "$STATUS_DIR"
REVIEW_ENGINE="${REVIEWER_ENGINE:-codex}"
PREWARM_JSON=$(jq -n \
  --arg ds "$DESIGN_SURFACE" \
  --arg ces "$CLAUDE_EXEC_SURFACE" \
  --arg cs "$CODEX_SURFACE" \
  --arg rs "$REVIEW_SURFACE" \
  --arg slug "$SLUG" \
  --arg drr "$DESIGN_RUNNER" \
  --arg cer "$CLAUDE_EXEC_RUNNER" \
  --arg crr "${CODEX_EXEC_RUNNER:-$CODEX_RUNNER}" \
  --arg rrr "${REVIEWER_RUNNER:-$CODEX_RUNNER}" \
  --arg de "$DESIGN_ENGINE" \
  --arg dd "$DESIGN_DELIVERY" \
  --arg dc "$CLAUDE_DELIVERY" \
  --arg dx "$CODEX_DELIVERY" \
  --arg dr "$REVIEW_DELIVERY" \
  --arg re "$REVIEW_ENGINE" \
  '(if $ds != "" then {design: {surface_id: $ds, agent: $slug, runner: $drr, engine: $de, role: "plan", delivery: $dd}} else {} end)
   + (if $rs != "" then {review: {surface_id: $rs, agent: ($slug + "-review"), runner: $rrr, engine: $re, role: "review", delivery: $dr}} else {} end)
   + {executors:
        ((if $ces != "" then {claude: {surface_id: $ces, agent: ($slug + "-claude"), runner: $cer, engine: "claude", role: "exec", delivery: $dc}} else {} end)
         + (if $cs != "" then {codex: {surface_id: $cs, agent: ($slug + "-codex"), runner: $crr, engine: "codex", role: "exec", delivery: $dx}} else {} end))}')
echo "$PREWARM_JSON" > "$STATUS_DIR/prewarm.json"
log "prewarm" "wrote $STATUS_DIR/prewarm.json"

# agmsg prewarm 経路では通常 launch が走らないため、観測用の初期 status.json をここで書く
# (standby wrapper は .assigned-<name> が無い限り status.json を書かないので、上書きの心配はない)
if [[ $WITH_DESIGN -eq 1 && ! -f "$STATUS_DIR/status.json" ]]; then
  jq -n --arg ws "$WORKSPACE" --arg sf "$DESIGN_SURFACE" \
    '{status: "launched", workspace_id: $ws, surface_id: $sf,
      message: "agmsg prewarm panes launched (idle)", timestamp: (now | todate)}' \
    > "$STATUS_DIR/status.json"
  log "prewarm" "wrote initial launched status.json"
fi

jq -n --arg ws "$WORKSPACE" --argjson panes "$PREWARM_JSON" \
  '{workspace_id: $ws, panes: $panes}'
