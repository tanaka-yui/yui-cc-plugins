#!/bin/bash
# Pre-warm standby panes: タスク workspace に standby ペイン群を事前起動する
# (--review-model 無し: 縦積み 上 opus / 中 sonnet / 下 codex。
#  --review-model 有り: 2×2 グリッド 左上 opus / 右上 codex review / 左下 sonnet / 右下 codex。
#  --design-runner（codex engine）有り: 左上 design codex / 右上 claude review (`<slug>-opus`) / 左下 sonnet / 右下 codex)
#
# Usage:
#   agmsg 未使用 (opus は通常フローで起動済み。sonnet / codex の split のみ追加):
#     prewarm-panes.sh --workspace <ws-id> --base-surface <sf-id> \
#       --cwd <worktree> --slug <task-slug> --status-dir <dir> \
#       [--codex-runner <name>] \
#       [--review-model <model>] \
#       [--design-runner <name>] [--reviewer-runner <name>] \
#       [--parent-notify-workspace <ws-id>] [--parent-notify-surface <sf-id>] [--unattended]
#
#   agmsg 使用 (workspace 未作成の状態で呼ぶ。opus も standby 起動し workspace はこのスクリプトが作成):
#     prewarm-panes.sh --with-opus \
#       --cwd <worktree> --slug <task-slug> --status-dir <dir> \
#       --agmsg-team <team> \
#       [--codex-runner <name>] \
#       [--review-model <model>] \
#       [--design-runner <name>] [--reviewer-runner <name>] \
#       [--parent-notify-workspace <ws-id>] [--parent-notify-surface <sf-id>] [--unattended]
#
# 注意: --agmsg-team を --with-opus なしで渡す組み合わせは SKILL からは使用しない
#       (sonnet/codex 配線のみ行いたい特殊用途向け)
#
# 内部処理:
#   1. worktree を create-or-reuse (agmsg 配線より先にディレクトリが必要)
#   2. (agmsg 時) join.sh + delivery.sh set を「ペイン起動前に」実行。
#      配線に失敗したペインは delivery: "cmux-send" として記録 (die しない)
#   3. (--with-opus 時) opus-1m standby を workspace 配置で起動 (メイン surface が opus ペイン)。
#      --design-runner が codex engine の場合は opus の代わりに codex design standby を起動する
#   4. sonnet / codex を split で配置 (--review-model / --reviewer-runner 有りなら 2×2、無しなら縦積み)
#   4.5 (--review-model または --reviewer-runner 時) review ペインを opus の右に split 配置。
#       --reviewer-runner 時は claude review ペイン (`<slug>-opus`)、--review-model 時は従来どおり codex review ペイン
#   5. <STATUS_DIR>/prewarm.json を書き込む (review キーは --review-model / --reviewer-runner 時のみ。engine フィールドを各ペインに含める)
#   --unattended: ループモード専用。設計ペイン (claude opus standby) の起動に
#                 --skip-permissions を付ける (無人実行で permission prompt / ExitPlanMode
#                 承認により停止しないようにするため)。codex 系は bypass フラグで解決済み
#   --timeout-sentinel <path>: ループモード専用。status 所有者になり得る全 standby
#                 (opus / design codex / sonnet / codex / claude review) の launch へ
#                 そのまま転送する。batch-wait.sh が timeout として terminal 化した後に
#                 遅れて終了した子が status.json を上書きするのを防ぐ
#
# Output: JSON to stdout: {workspace_id, panes: {opus?, sonnet, codex?}}
# Debug:  Logs to stderr

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGMSG_DIR="${AGMSG_DIR:-$HOME/.agents/skills/agmsg/scripts}"
OPUS_MODEL="opus[1m]"
SONNET_MODEL="sonnet"

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
REVIEW_MODEL=""
AGMSG_TEAM=""
WITH_OPUS=0
NOTIFY_WORKSPACE=""
NOTIFY_SURFACE=""
DESIGN_RUNNER=""
REVIEWER_RUNNER=""
DESIGN_ENGINE="claude"
DESIGN_PLAN_EFFORT=""
CLAUDE_REVIEW_MODEL=""
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
    --design-runner)
      [[ $# -lt 2 ]] && die "--design-runner requires a runner name"
      DESIGN_RUNNER="$2"; shift 2 ;;
    --reviewer-runner)
      [[ $# -lt 2 ]] && die "--reviewer-runner requires a runner name"
      REVIEWER_RUNNER="$2"; shift 2 ;;
    --review-model)
      [[ $# -lt 2 ]] && die "--review-model requires a model name"
      REVIEW_MODEL="$2"; shift 2 ;;
    # v1.16.0 で削除。agmsg を使うかは --agmsg-team の有無と send.sh の存在で決まる。
    --message-type)
      die "--message-type was removed: agmsg is wired whenever --agmsg-team is given and send.sh exists" ;;
    --agmsg-team)
      [[ $# -lt 2 ]] && die "--agmsg-team requires a team name"
      AGMSG_TEAM="$2"; shift 2 ;;
    --with-opus)
      WITH_OPUS=1; shift ;;
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

# design=codex / reviewer の解決。runner の engine と model/effort を runners.json から引く
if [[ -n "$DESIGN_RUNNER" ]]; then
  [[ -f "$RUNNERS_CONFIG_PATH" ]] || die "runners.json not found at $RUNNERS_CONFIG_PATH (required for --design-runner)"
  DESIGN_ENGINE=$(jq -r --arg n "$DESIGN_RUNNER" '.runners[]? | select(.name == $n) | .engine // "claude"' "$RUNNERS_CONFIG_PATH")
  [[ -n "$DESIGN_ENGINE" ]] || die "design runner '$DESIGN_RUNNER' not found in $RUNNERS_CONFIG_PATH"
  DESIGN_PLAN_EFFORT=$(jq -r --arg n "$DESIGN_RUNNER" '.runners[]? | select(.name == $n) | .plan_effort // empty' "$RUNNERS_CONFIG_PATH")
fi
if [[ -n "$REVIEWER_RUNNER" ]]; then
  [[ "$DESIGN_ENGINE" == "codex" ]] || die "--reviewer-runner requires a codex-engine --design-runner"
  [[ -n "$REVIEW_MODEL" ]] && die "--reviewer-runner and --review-model are mutually exclusive"
  REVIEWER_ENGINE=$(jq -r --arg n "$REVIEWER_RUNNER" '.runners[]? | select(.name == $n) | .engine // "claude"' "$RUNNERS_CONFIG_PATH")
  [[ "$REVIEWER_ENGINE" == "claude" ]] || die "reviewer runner '$REVIEWER_RUNNER' must be claude engine"
  CLAUDE_REVIEW_MODEL=$(jq -r --arg n "$REVIEWER_RUNNER" '.runners[]? | select(.name == $n) | .review_model // empty' "$RUNNERS_CONFIG_PATH")
  [[ -z "$CLAUDE_REVIEW_MODEL" ]] && CLAUDE_REVIEW_MODEL="$OPUS_MODEL"
fi
if [[ "$DESIGN_ENGINE" == "codex" && -n "$REVIEW_MODEL" ]]; then
  die "--review-model is for claude-design tasks; use --reviewer-runner when the design runner is codex"
fi

if [[ $WITH_OPUS -eq 1 ]]; then
  # agmsg モード専用: workspace はこのスクリプトが作成する
  [[ -n "$AGMSG_TEAM" ]] || die "--with-opus requires --agmsg-team"
  [[ -z "$WORKSPACE" && -z "$BASE_SURFACE" ]] \
    || die "--with-opus is mutually exclusive with --workspace/--base-surface"
else
  [[ -n "$WORKSPACE" ]] || die "--workspace is required (without --with-opus)"
  [[ -n "$BASE_SURFACE" ]] || die "--base-surface is required (without --with-opus)"
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

if [[ -n "$AGMSG_TEAM" ]]; then
  if [[ $WITH_OPUS -eq 1 ]]; then
    if [[ "$DESIGN_ENGINE" == "codex" ]]; then
      # design=codex: 設計ペインも codex セッションなので codex standby と同じ
      # フォールバック付き join を行う (shim 未導入だと失敗しうる)
      if bash "$AGMSG_DIR/join.sh" "$AGMSG_TEAM" "$SLUG" codex "$CWD" >&2 2>/dev/null; then
        if bash "$AGMSG_DIR/delivery.sh" set monitor codex "$CWD" >&2 2>/dev/null; then
          DESIGN_DELIVERY="agmsg"
        else
          log "agmsg" "codex design delivery wiring failed; falling back to cmux-send"
        fi
      else
        log "agmsg" "codex design join failed (shim not installed?); falling back to cmux-send"
        bash "$AGMSG_DIR/join.sh" "$AGMSG_TEAM" "$SLUG" claude-code "$CWD" >&2 || true
      fi
    else
      bash "$AGMSG_DIR/join.sh" "$AGMSG_TEAM" "$SLUG" claude-code "$CWD" >&2 \
        || die "agmsg join failed for agent $SLUG"
    fi
  fi
  bash "$AGMSG_DIR/join.sh" "$AGMSG_TEAM" "$SLUG-sonnet" claude-code "$CWD" >&2 \
    || die "agmsg join failed for agent $SLUG-sonnet"
  if bash "$AGMSG_DIR/delivery.sh" set monitor claude-code "$CWD" >&2; then
    CLAUDE_DELIVERY="agmsg"
  else
    log "agmsg" "claude-code delivery wiring failed; falling back to cmux-send"
  fi
  if [[ $WITH_OPUS -eq 1 && "$DESIGN_ENGINE" != "codex" ]]; then
    # claude 設計時は claude-code standby と同じ delivery を共有する
    DESIGN_DELIVERY="$CLAUDE_DELIVERY"
  fi

  if [[ -n "$CODEX_RUNNER" ]]; then
    # codex は shim 未導入だと join / delivery が失敗しうる。失敗しても die せず
    # cmux-send フォールバックとして記録する (完了通知用に claude-code type で join を試す)
    if bash "$AGMSG_DIR/join.sh" "$AGMSG_TEAM" "$SLUG-codex" codex "$CWD" >&2 2>/dev/null; then
      if bash "$AGMSG_DIR/delivery.sh" set monitor codex "$CWD" >&2 2>/dev/null; then
        CODEX_DELIVERY="agmsg"
      else
        log "agmsg" "codex delivery wiring failed; falling back to cmux-send"
      fi
    else
      log "agmsg" "codex join failed (shim not installed?); falling back to cmux-send"
      bash "$AGMSG_DIR/join.sh" "$AGMSG_TEAM" "$SLUG-codex" claude-code "$CWD" >&2 || true
    fi
  fi

  if [[ -n "$REVIEW_MODEL" || -n "$REVIEWER_RUNNER" ]]; then
    if [[ -n "$REVIEWER_RUNNER" ]]; then
      # design=codex: レビューペインは claude セッション (SLUG-opus)。delivery 配線は
      # claude-code standby (SLUG-sonnet) と共有するので CLAUDE_DELIVERY を流用する
      if bash "$AGMSG_DIR/join.sh" "$AGMSG_TEAM" "$SLUG-opus" claude-code "$CWD" >&2 2>/dev/null; then
        REVIEW_DELIVERY="$CLAUDE_DELIVERY"
      else
        log "agmsg" "review join failed; falling back to cmux-send"
      fi
    else
      # review ペインも codex セッション。delivery 配線 (delivery.sh set) は worktree × type 単位
      # なので codex standby の結果を共有する。join は agent 名の登録のために別途必要
      if bash "$AGMSG_DIR/join.sh" "$AGMSG_TEAM" "$SLUG-review" codex "$CWD" >&2 2>/dev/null; then
        REVIEW_DELIVERY="$CODEX_DELIVERY"
      else
        log "agmsg" "review join failed (shim not installed?); falling back to cmux-send"
      fi
    fi
  fi
fi

# --- Step 3: 設計ペイン standby (agmsg モードのみ、workspace 配置) ---
# DESIGN_ENGINE == codex なら codex design standby、それ以外は現行の opus-1m standby

OPUS_SURFACE=""

if [[ $WITH_OPUS -eq 1 ]]; then
  if [[ "$DESIGN_ENGINE" == "codex" ]]; then
    # design=codex: 設計ペインは codex idle standby (初期 prompt なし — codex は
    # slash command での actas ができないため、タスクは常に typed prompt で届く)
    log "prewarm" "launching codex design workspace for $SLUG"
    EFFORT_FLAGS=()
    [[ -n "$DESIGN_PLAN_EFFORT" ]] && EFFORT_FLAGS=(--effort "$DESIGN_PLAN_EFFORT")
    OPUS_RESULT=$(bash "$SCRIPT_DIR/launch-workspace.sh" \
      --cwd "$CWD" \
      --mode standby \
      --defer-status \
      --runner "$DESIGN_RUNNER" \
      ${EFFORT_FLAGS[@]+"${EFFORT_FLAGS[@]}"} \
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
    OPUS_RESULT=$(bash "$SCRIPT_DIR/launch-workspace.sh" \
      --cwd "$CWD" \
      --mode standby \
      --defer-status \
      --model "$OPUS_MODEL" \
      ${OPUS_UNATTENDED_FLAGS[@]+"${OPUS_UNATTENDED_FLAGS[@]}"} \
      ${SENTINEL_FLAGS[@]+"${SENTINEL_FLAGS[@]}"} \
      --status-dir "$STATUS_DIR" \
      ${NOTIFY_FLAGS[@]+"${NOTIFY_FLAGS[@]}"} \
      --agmsg-team "$AGMSG_TEAM" --agmsg-from "$SLUG" \
      "$SLUG" "$OPUS_PROMPT") || die "failed to launch opus standby workspace"
  fi
  WORKSPACE=$(echo "$OPUS_RESULT" | jq -r '.workspace_id // empty')
  OPUS_SURFACE=$(echo "$OPUS_RESULT" | jq -r '.surface_id // empty')
  BASE_SURFACE="$OPUS_SURFACE"
  [[ -n "$WORKSPACE" && -n "$OPUS_SURFACE" ]] || die "failed to parse opus standby output"
fi

# --- Step 4: sonnet standby (常に、split 配置) ---

SONNET_PROMPT=""
AGMSG_FLAGS_SONNET=()
if [[ -n "$AGMSG_TEAM" ]]; then
  # opus と同じ理由で delivery に応じて出し分ける (cmux-send フォールバック時は actas しない)
  if [[ "$CLAUDE_DELIVERY" == "agmsg" ]]; then
    SONNET_PROMPT="/agmsg actas $SLUG-sonnet then wait idle. Execution instructions will arrive as a prompt typed into this pane; an identical copy is also pushed to your agmsg inbox (treat both as ONE task — ignore the duplicate). Do not start any work until the instructions arrive."
  else
    SONNET_PROMPT="Wait idle. Execution instructions will be typed directly into this pane as a prompt. Do not start any work until they arrive."
  fi
  AGMSG_FLAGS_SONNET=(--agmsg-team "$AGMSG_TEAM" --agmsg-from "$SLUG-sonnet")
fi

log "prewarm" "launching sonnet standby pane for $SLUG"
SONNET_ARGS=(
  --cwd "$CWD"
  --mode standby
  --standby-in "$WORKSPACE"
  --standby-split-from "$BASE_SURFACE"
  --model "$SONNET_MODEL"
  --skip-permissions
  ${SENTINEL_FLAGS[@]+"${SENTINEL_FLAGS[@]}"}
  --status-dir "$STATUS_DIR"
)
SONNET_RESULT=$(bash "$SCRIPT_DIR/launch-workspace.sh" \
  "${SONNET_ARGS[@]}" \
  ${NOTIFY_FLAGS[@]+"${NOTIFY_FLAGS[@]}"} \
  ${AGMSG_FLAGS_SONNET[@]+"${AGMSG_FLAGS_SONNET[@]}"} \
  "$SLUG-sonnet" ${SONNET_PROMPT:+"$SONNET_PROMPT"}) || die "failed to launch sonnet standby pane"
SONNET_SURFACE=$(echo "$SONNET_RESULT" | jq -r '.surface_id // empty')
[[ -n "$SONNET_SURFACE" ]] || die "failed to parse sonnet standby output"

# --- Step 5: codex standby (runner 登録時のみ、sonnet の下に split 配置) ---
# codex は idle でも agmsg push を受けられる保証が無いため初期 prompt は常に無し。
# 実行指示の配送手段は CODEX_DELIVERY (prewarm.json) で分岐する。

CODEX_SURFACE=""

if [[ -n "$CODEX_RUNNER" ]]; then
  AGMSG_FLAGS_CODEX=()
  if [[ -n "$AGMSG_TEAM" ]]; then
    AGMSG_FLAGS_CODEX=(--agmsg-team "$AGMSG_TEAM" --agmsg-from "$SLUG-codex")
  fi
  CODEX_DIRECTION_FLAGS=()
  [[ -n "$REVIEW_MODEL" || -n "$REVIEWER_RUNNER" ]] && CODEX_DIRECTION_FLAGS=(--standby-split-direction right)
  log "prewarm" "launching codex standby pane for $SLUG"
  CODEX_RESULT=$(bash "$SCRIPT_DIR/launch-workspace.sh" \
    --cwd "$CWD" \
    --mode standby \
    --standby-in "$WORKSPACE" \
    --standby-split-from "$SONNET_SURFACE" \
    ${CODEX_DIRECTION_FLAGS[@]+"${CODEX_DIRECTION_FLAGS[@]}"} \
    --runner "$CODEX_RUNNER" \
    ${SENTINEL_FLAGS[@]+"${SENTINEL_FLAGS[@]}"} \
    --status-dir "$STATUS_DIR" \
    ${NOTIFY_FLAGS[@]+"${NOTIFY_FLAGS[@]}"} \
    ${AGMSG_FLAGS_CODEX[@]+"${AGMSG_FLAGS_CODEX[@]}"} \
    "$SLUG-codex") || die "failed to launch codex standby pane"
  CODEX_SURFACE=$(echo "$CODEX_RESULT" | jq -r '.surface_id // empty')
  [[ -n "$CODEX_SURFACE" ]] || die "failed to parse codex standby output"
fi

# --- Step 5.5: review ペイン (--review-model / --reviewer-runner 時のみ、opus の右に split 配置) ---
# standby と同じ wrapper だが .assigned-<slug>-review は誰も touch しない前提 —
# close しても status.json を汚さない。初期 prompt は codex standby と同じく常に無し。
# --reviewer-runner 時 (design=codex) は claude review ペイン (`<slug>-opus`)、
# --review-model 時は従来どおり codex review ペイン。

REVIEW_SURFACE=""

if [[ -n "$REVIEW_MODEL" || -n "$REVIEWER_RUNNER" ]]; then
  AGMSG_FLAGS_REVIEW=()
  if [[ -n "$REVIEWER_RUNNER" ]]; then
    # design=codex: claude レビューペイン (A-R レビュアー兼 Phase B opus 1m 実装先の二役)
    log "prewarm" "launching claude review pane for $SLUG (reviewer runner: $REVIEWER_RUNNER)"
    REVIEW_PANE_NAME="$SLUG-opus"
    REVIEW_RUNNER_FLAGS=(--runner "$REVIEWER_RUNNER" --model "$CLAUDE_REVIEW_MODEL" --skip-permissions)
    # opus 1m 委譲時にこのペインが status.json / 親通知の所有者になるため、
    # 完了通知の dual-send (cmux send + agmsg inbox 記録) 用に agmsg 配線を渡す
    if [[ -n "$AGMSG_TEAM" ]]; then
      AGMSG_FLAGS_REVIEW=(--agmsg-team "$AGMSG_TEAM" --agmsg-from "$SLUG-opus")
    fi
  else
    log "prewarm" "launching codex review pane for $SLUG"
    REVIEW_PANE_NAME="$SLUG-review"
    REVIEW_RUNNER_FLAGS=(--runner "$CODEX_RUNNER" --model "$REVIEW_MODEL")
  fi
  REVIEW_RESULT=$(bash "$SCRIPT_DIR/launch-workspace.sh" \
    --cwd "$CWD" \
    --mode review \
    --standby-in "$WORKSPACE" \
    --standby-split-from "$BASE_SURFACE" \
    --standby-split-direction right \
    "${REVIEW_RUNNER_FLAGS[@]}" \
    ${SENTINEL_FLAGS[@]+"${SENTINEL_FLAGS[@]}"} \
    --status-dir "$STATUS_DIR" \
    ${NOTIFY_FLAGS[@]+"${NOTIFY_FLAGS[@]}"} \
    ${AGMSG_FLAGS_REVIEW[@]+"${AGMSG_FLAGS_REVIEW[@]}"} \
    "$REVIEW_PANE_NAME") || die "failed to launch review pane"
  REVIEW_SURFACE=$(echo "$REVIEW_RESULT" | jq -r '.surface_id // empty')
  [[ -n "$REVIEW_SURFACE" ]] || die "failed to parse review pane output"
fi

# --- Step 6: prewarm.json 書き込み + 出力 ---

mkdir -p "$STATUS_DIR"
REVIEW_AGENT_SUFFIX="-review"
REVIEW_ENGINE="codex"
if [[ -n "$REVIEWER_RUNNER" ]]; then
  REVIEW_AGENT_SUFFIX="-opus"
  REVIEW_ENGINE="claude"
fi
PREWARM_JSON=$(jq -n \
  --arg os "$OPUS_SURFACE" \
  --arg ss "$SONNET_SURFACE" \
  --arg cs "$CODEX_SURFACE" \
  --arg rs "$REVIEW_SURFACE" \
  --arg slug "$SLUG" \
  --arg de "$DESIGN_ENGINE" \
  --arg dd "$DESIGN_DELIVERY" \
  --arg dc "$CLAUDE_DELIVERY" \
  --arg dx "$CODEX_DELIVERY" \
  --arg dr "$REVIEW_DELIVERY" \
  --arg ras "$REVIEW_AGENT_SUFFIX" \
  --arg re "$REVIEW_ENGINE" \
  '(if $os != "" then {opus: {surface_id: $os, agent: $slug, engine: $de, delivery: $dd}} else {} end)
   + {sonnet: {surface_id: $ss, agent: ($slug + "-sonnet"), engine: "claude", delivery: $dc}}
   + (if $cs != "" then {codex: {surface_id: $cs, agent: ($slug + "-codex"), engine: "codex", delivery: $dx}} else {} end)
   + (if $rs != "" then {review: {surface_id: $rs, agent: ($slug + $ras), engine: $re, delivery: $dr}} else {} end)')
echo "$PREWARM_JSON" > "$STATUS_DIR/prewarm.json"
log "prewarm" "wrote $STATUS_DIR/prewarm.json"

# agmsg prewarm 経路では通常 launch が走らないため、観測用の初期 status.json をここで書く
# (standby wrapper は .assigned-<name> が無い限り status.json を書かないので、上書きの心配はない)
if [[ $WITH_OPUS -eq 1 && ! -f "$STATUS_DIR/status.json" ]]; then
  jq -n --arg ws "$WORKSPACE" --arg sf "$OPUS_SURFACE" \
    '{status: "launched", workspace_id: $ws, surface_id: $sf,
      message: "agmsg prewarm panes launched (idle)", timestamp: (now | todate)}' \
    > "$STATUS_DIR/status.json"
  log "prewarm" "wrote initial launched status.json"
fi

jq -n --arg ws "$WORKSPACE" --argjson panes "$PREWARM_JSON" \
  '{workspace_id: $ws, panes: $panes}'
