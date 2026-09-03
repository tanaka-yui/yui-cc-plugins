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
#   --role design|design_review|exec|exec_review
#                                      Model/effort role. Default is derived from mode:
#                                      plan/superpowers=design, review=design_review,
#                                      execute/standby=exec. A standby design pane passes
#                                      --role design; conflicting non-standby overrides fail.
#   --standby-split-direction right|down  standby/review split 配置の分割方向 (default: down)
#   --standby-in <workspace-id>        standby ペインを追加する既存 workspace (split 配置時必須)
#   --standby-split-from <surface-id>  縦分割の分割元 surface (split 配置時必須)
#   --plan-file <path>                 Plan file path (required when --mode execute).
#                                      inner prompt が
#                                      "Read and execute the plan at <path>" になる
#   --model <model>                    Model flag passed as --model <X>. engine を問わず
#                                      未指定時は role 対応の組込み既定値を使う。claude は
#                                      design/design_review/exec_review=opus[1m] / exec=sonnet、
#                                      codex は model を省略して codex 側の既定に委ねる
#   --effort <level>                   Reasoning effort. engine を問わず未指定時は runner の
#                                      組込み既定値は design/design_review/exec_review=xhigh / exec=high。
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
#                                      inner prompt に「PR 作成前に agmsg send.sh の 1 呼び出しで
#                                      reviewer_agent へレビュー依頼し、単発タイマーを 1 本張って
#                                      待ち、レビュアーからの review-verdict メッセージで起きて
#                                      review_dir/code-round-<N>.md を読む (ファイルはポーリング
#                                      しない)」プロトコルを追記する
#   --timeout-sentinel <path>          ループモード専用。runner wrapper が exit 時にこの
#                                      パスの存在を確認し、あれば status.json を書かずに
#                                      終了する。親の単発タイマー wake 時の再導出処理が
#                                      timeout として terminal 化したタスクの遅延書き込み
#                                      (status 上書き / status dir の再生成) を防ぐ。
#                                      未指定 (非ループ) では wrapper の挙動は従来どおり
#   --unattended                       ループモード専用。--mode execute / standby で有効。
#                                      inner prompt のレビュー fallback から対話質問を除去し、
#                                      claude engine には --dangerously-skip-permissions を
#                                      強制付与する。他モードでは警告して無視
#   --status-dir <path>                Directory for writing status files
#   --parent-notify-workspace <ws-id>  Workspace to notify on completion
#   --runner <name>                    Runner name to look up in
#                                      DISPATCH_CONFIG_HOME/runners.json (or RUNNERS_CONFIG_PATH override).
#                                      Resolves command/engine for the child session.
#                                      The composed command is always wrapped in `zsh -ic "..."`
#                                      so functions and env vars from ~/.zshrc are loaded.
#                                      Default: hardcoded {claude, engine=claude}.
#   --agmsg-team <team>                agmsg の team 名 (--agmsg-from とセットで必須)。
#                                      runner wrapper の親・レビュアーへの通知はこの team と
#                                      --agmsg-from を送信元に agmsg send.sh で配送する。
#                                      両方が無いペインは通知手段を持たない
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
# 完走ゲートの entry を識別する印。command は 4 ロールで共有される 1 本なので、
# 「誰の entry か」を role ではなくこの印で判定する。
GATE_MARKER="cmux-team-dispatch-task"
RECOVERY_TICK_BIN="${DISPATCH_RECOVERY_TICK:-$SCRIPT_DIR/recovery-tick.sh}"
source "$SCRIPT_DIR/config-lib.sh"
RUNNERS_CONFIG_PATH="$(dispatch_runners_file)"

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
  # .codex/hooks.json も対象にする。worktree ごとに生成され、放っておくと git 差分として
  # 現れて実装ペインへ「コミットするな」と口頭で伝える運用になっていた。
  for entry in '.claude/settings.local.json' '.claude/plans/' '.codex/hooks.json' '.dispatch-handoff.json'; do
    grep -qxF "$entry" "$exclude_file" 2>/dev/null \
      || echo "$entry" >> "$exclude_file" 2>/dev/null \
      || log "warn" "failed to append $entry to $exclude_file"
  done
  return 0
}

# ペインが自分の配線をディスクから引ける 1 ファイルを worktree に置く。
#
# Phase B-R の配線 (レビュアーの agent 名・review dir・依頼の出し方) は、これまで
# phase-b-deliver.sh が組み立てる `phase-b-exec:` メッセージの **本文にしか存在しなかった**。
# 設計ペインが正規経路を通らず自作の引き継ぎ文を送ると、その情報ごと消える。
# 2026-08-31 に実測: lead-psp-liff の member タスクで、設計ペインが phase-b-deliver.sh を
# 使わず手書きの PHASE B 引き継ぎを送った。本文には review-code の手順も
# member-exec-review という名前も無く、代わりに「進捗と blocker は parent へ報告せよ」と
# 書かれていた。実装者は指示どおり parent へレビューを依頼し、レビュアーの inbox は参加以来
# 0 通のままだった (code-round-* は 1 つも生まれていない)。
# 同じ引き継ぎ文には「.dispatch/** はこの worktree に存在しないので参照するな」とも
# 書かれており、ディスク側の発見経路まで塞がれていた — 事実として worktree には
# .dispatch/ が無い (本体チェックアウトにある) ので、その一文自体は正しい。
#
# したがって「本体チェックアウトの status dir を指す 1 ファイル」を worktree の中に置く。
# worktree の中なので、引き継ぎ文が何と言おうと実装者は必ず到達できる。完走ゲートの
# reason (判定 7) もこの配線を読んで名指しするので、経路は 2 つになる。
# ベストエフォート: 失敗しても dispatch は止めない (ゲートの reason が残る)。
write_dispatch_handoff() {
  local file="$CWD/.dispatch-handoff.json" tmp
  [[ -n "$STATUS_DIR" ]] || return 0
  tmp=$(mktemp "$CWD/.dispatch-handoff.json.XXXXXX" 2>/dev/null) || {
    log "warn" "could not create a temp file for $file; skipping the handoff pointer"
    return 1
  }
  if jq -n \
    --arg status_dir "$STATUS_DIR" \
    --arg review_dir "$STATUS_DIR/review" \
    --arg review_config "$STATUS_DIR/review/code-review.json" \
    --arg team "$AGMSG_TEAM" \
    --arg agent "$AGMSG_FROM" \
    --arg role "$MODEL_ROLE" \
    --arg send_command "$AGMSG_SEND" \
    '{status_dir:$status_dir, review_dir:$review_dir, review_config:$review_config,
      team:$team, agent:$agent, role:$role, send_command:$send_command,
      note:"This dispatch pane owns the status directory above. It lives in the main checkout, not in this worktree. When a mandatory code review is wired, review_config names the reviewer agent; request the review with one send_command call addressed to that agent name, never to parent and never to a surface id."}' \
    > "$tmp" 2>/dev/null && mv "$tmp" "$file" 2>/dev/null; then
    log "handoff" "wrote $file"
    return 0
  fi
  rm -f "$tmp" 2>/dev/null || true
  log "warn" "failed to write $file; the completion gate reason remains the only wiring path"
  return 1
}

# gate へ渡す送信コマンドは hook のコマンド文字列ではなく STATUS_DIR のファイルで
# 受け渡す。agmsg は「その Stop エントリが自分の書いたものか」を command 文字列に
# 'agmsg' が含まれるかどうか **だけ** で判定しており (delivery.sh の
# agmsg_delivery_status_default: instr(json_extract(h.value,'$.command'), 'agmsg') > 0)、
# --send-command に ~/.agents/skills/agmsg/scripts/send.sh を焼き込むと、この gate が
# agmsg 由来の Stop と誤認される。すると mode が monitor ではなく both と報告され、
# codex-shim.sh は `mode: monitor` の完全一致 (grep -qx) を要求するため shim が素通しに
# なり、app-server bridge が起動しない。結果として codex ペインは bridge seat を持てず、
# send.sh は成功するのにメッセージが永久に届かない (2026-08-24 実測)。
# ファイル経由なら AGMSG_SEND をユーザーが上書きしても衝突は再発しない。
write_send_command_file() {
  [[ -n "$STATUS_DIR" && -n "$AGMSG_SEND" ]] || return 0
  mkdir -p "$STATUS_DIR" 2>/dev/null || return 0
  printf '%s\n' "$AGMSG_SEND" > "$STATUS_DIR/.send-command" 2>/dev/null || true
}

# 完走ゲート: 子セッションが仕事の途中で止まったら Stop hook が継続させる。
# 判定は completion-gate.sh がディスクだけを見て行う (モデル評価は使わない)。
# ExitPlanMode hook と同じくベストエフォート — 失敗は警告のみで dispatch を止めない。
# 冪等性はファイルに completion-gate.sh が既にあるかで判定する (worktree 再利用時の
# 二重注入を防ぐ)。
inject_completion_gate() {
  local script="$SCRIPT_DIR/completion-gate.sh"
  local settings_file="$CWD/.claude/settings.local.json"
  local cmd

  [[ -n "$STATUS_DIR" ]] || return 0
  write_send_command_file
  # status-dir / role / agent / team は焼き込まない。4 ロールは 1 つの worktree を共有し、
  # .claude/settings.local.json は 1 本しか無いので、焼き込むと後発ロールが先発ロールの
  # ゲートを実行する (2026-08-25 実測: exec_review が design のゲートで動き、レビュー専任
  # なのに「タスクの terminal status を書け」と迫られ続けた)。値は runner script が
  # DISPATCH_GATE_* として export し、gate がプロセス環境から読む。
  # command 文字列に '$VAR' を書いて実行時展開させることはできない — シングルクォート内は
  # hook 実行時も展開されず、\$VAR も同じである。
  cmd="bash '$script' --gate-id '$GATE_MARKER'"
  # 既存の gate entry を取り除いてから 1 本足す。worktree 再利用時の二重注入防止と、
  # 3.5.0 以前の「値を焼き込んだ entry」の migration が、これ 1 つで同時に済む。
  # 古い entry を残したままだと、そちらが先発ロールの値で全ペインを縛り続ける。
  if merge_claude_settings \
    '.hooks.Stop = (((.hooks.Stop // [])
       | map(.hooks |= map(select((.command // "") | test("completion-gate\\.sh") | not)))
       | map(select((.hooks | length) > 0)))
       + [{matcher: "", hooks: [{type: "command", command: $cmd}]}])' \
    --arg cmd "$cmd"; then
    log "hook" "merged the completion gate into $settings_file"
  else
    log "warn" "failed to inject the completion gate into $settings_file"
  fi
}

# codex 版。注入先が .codex/hooks.json である以外は claude 版と同じ契約である。
# このファイルには agmsg が SessionStart / SessionEnd を書いているので必ずマージする
# (上書きすると codex ペインが agmsg を受信できなくなる)。
# worktree ごとに新しいパスになるため codex は毎回「未信頼」と判定するが、
# launch-workspace は全 codex 経路に --dangerously-bypass-hook-trust を付けているので
# 承認待ちにはならない (CODEX_HOOK_TRUST_FLAG)。
inject_completion_gate_codex() {
  local script="$SCRIPT_DIR/completion-gate.sh"
  local hooks_dir="$CWD/.codex"
  local hooks_file="$hooks_dir/hooks.json"
  local cmd merged tmp

  [[ -n "$STATUS_DIR" ]] || return 0
  write_send_command_file
  if ! mkdir -p "$hooks_dir" 2>/dev/null; then
    log "warn" "failed to create $hooks_dir; skipping the codex completion gate"
    return 1
  fi
  # 値を焼き込まない理由は claude 版と同じ。codex も .codex/hooks.json を worktree で
  # 共有するので、焼き込むと design_review が exec のゲートを実行する。
  # --send-command も渡さない。渡すと agmsg がこの Stop を自分のものと誤認し、
  # mode が both と報告されて codex-shim が bridge を起動しなくなる
  # (write_send_command_file の comment を参照)。
  cmd="bash '$script' --gate-id '$GATE_MARKER'"
  if [[ -f "$hooks_file" ]]; then
    # 既存の gate entry を除去してから足す (二重注入防止 + 旧形式の migration)。
    merged=$(jq --arg cmd "$cmd" \
      '.hooks.Stop = (((.hooks.Stop // [])
         | map(.hooks |= map(select((.command // "") | test("completion-gate\\.sh") | not)))
         | map(select((.hooks | length) > 0)))
         + [{matcher: "", hooks: [{type: "command", command: $cmd}]}])' \
      "$hooks_file" 2>/dev/null) || merged=""
  else
    merged=$(jq -n --arg cmd "$cmd" \
      '{hooks:{Stop:[{matcher:"",hooks:[{type:"command",command:$cmd}]}]}}' 2>/dev/null) || merged=""
  fi
  if [[ -z "$merged" ]]; then
    log "warn" "failed to merge the completion gate into $hooks_file; skipping"
    return 1
  fi
  # 一時ファイルは同一ディレクトリの mktemp + mv でアトミックに置き換える
  # (共有名は prewarm が同じ worktree に複数ペインを起こす場面で壊れる)。
  tmp=$(mktemp "$hooks_dir/.hooks.json.XXXXXX" 2>/dev/null) || {
    log "warn" "failed to create a temp file in $hooks_dir; skipping"
    return 1
  }
  if printf '%s\n' "$merged" > "$tmp" && mv "$tmp" "$hooks_file"; then
    log "hook" "merged the completion gate into $hooks_file"
    return 0
  fi
  rm -f "$tmp"
  log "warn" "failed to write $hooks_file"
  return 1
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
REVIEW_CONFIG_DOC=""
REVIEWER_SURFACE=""
REVIEWER_WORKSPACE=""
REVIEWER_RUNNER=""
REVIEWER_ENGINE=""
REVIEWER_AGENT=""
REVIEW_DIR=""
REVIEW_SANDBOX_DIR=""
TIMEOUT_SENTINEL=""
UNATTENDED=0
AGMSG_TEAM=""
AGMSG_FROM=""
# env で差し替えられないと、agmsg 未インストールのホストで `--agmsg-team` を渡すテストが
# :379 の die で即死し、`set -euo pipefail` のスイートが終端行すら出さずに途中で止まる。
# この値は runner wrapper へ焼き込まれ、通知配送の唯一の実体になる。
AGMSG_SEND="${AGMSG_SEND:-$HOME/.agents/skills/agmsg/scripts/send.sh}"

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
      [[ $# -lt 2 ]] && die "--role requires design, design_review, exec, or exec_review"
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
    --runner)
      [[ $# -lt 2 ]] && die "--runner requires a runner name"
      # 空文字は「指定なし」と同じ扱いになり、runners.json を引かずに既定 (claude) へ
      # 落ちる。呼び出し側で runner 名の解決に失敗したときに engine が黙って反転する
      # ため、ここで落とす (F3 をクラス単位で塞ぐ)。
      [[ -n "$2" ]] || die "--runner requires a non-empty runner name"
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
    # v2.0.0 で削除。runner wrapper へ NOTIFY_SF として書き出していたが読み手が無く
    # (cmux notify は --workspace しか取らない)、渡した側は通知先を指定したつもりで
    # 黙って無視されていた。未知オプションは workspace 名として飲まれてしまうので、
    # ここで明示的に die する。
    --parent-notify-surface)
      die "--parent-notify-surface was removed: the runner wrapper never read it (cmux notify only takes --workspace); pass --parent-notify-workspace instead" ;;
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
    plan|superpowers) MODEL_ROLE="design" ;;
    review) MODEL_ROLE="design_review" ;;
    execute|standby) MODEL_ROLE="exec" ;;
  esac
elif [[ "$MODE" != "standby" ]]; then
  case "$MODE:$MODEL_ROLE" in
    plan:design|superpowers:design|review:design_review|review:exec_review|execute:exec) ;;
    *) die "--role '$MODEL_ROLE' conflicts with --mode '$MODE'" ;;
  esac
fi
[[ "$MODEL_ROLE" =~ ^(design|design_review|exec|exec_review)$ ]] \
  || die "--role must be 'design', 'design_review', 'exec', or 'exec_review'"

# STATUS_DIR は review の composed command に --add-dir '<path>' として埋め込まれる。
# 引用を破る値は、ファイル生成やコマンド組立てより前に fail-closed で拒否する。
STATUS_DIR_SAFE=1
case "$STATUS_DIR" in
  *\'*|*\"*|*\`*|*\$*|*\!*|*\\*|*[[:cntrl:]]*)
    STATUS_DIR_SAFE=0
    die "--status-dir contains a shell metacharacter; refusing to build the composed command" ;;
esac

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
  [[ -f "$REVIEW_CONFIG" && ! -L "$REVIEW_CONFIG" ]] \
    || die "review config must be a regular non-symlink file: $REVIEW_CONFIG"
fi

# Validate workspace name: only allow safe characters for path/branch usage
[[ "$WORKSPACE_NAME" =~ ^[A-Za-z0-9._-]+$ ]] || die "invalid workspace name '$WORKSPACE_NAME': use only [A-Za-z0-9._-]"

# agmsg の from 名は readiness 確立句の name と runner script の AGMSG_FROM に
# そのまま入るので、workspace 名と同じ値域で検証する。
if [[ -n "$AGMSG_FROM" ]]; then
  [[ "$AGMSG_FROM" =~ ^[A-Za-z0-9._-]+$ ]] || die "invalid --agmsg-from '$AGMSG_FROM': use only [A-Za-z0-9._-]"
fi

# AGMSG_SEND は :875 の未クォート heredoc へそのまま埋まる。WORKSPACE_NAME / AGMSG_FROM /
# AGMSG_SKILL_DIR と同じ理由で、埋め込みを破る文字は事前に弾く。
case "$AGMSG_SEND" in *[\'\"\`\$\!\\]*) die "invalid AGMSG_SEND '$AGMSG_SEND': must not contain ' \" \` \$ ! \\" ;; esac

# AGMSG_TEAM も REVIEW_INSTRUCTION / ABORT_* 経由で inner prompt に補間され、その全体が
# `zsh -ic "... '<prompt>'"` の二重引用へ入る。team 名には slug 制約が無い
# (prewarm-panes.sh:205 が空白とメタ文字を die させているのと同じ理由) ため、
# ここで同じ禁止文字集合を適用する。fallback は無いので合成できなければ die する。
if [[ -n "$AGMSG_TEAM" ]]; then
  case "$AGMSG_TEAM" in
    *[[:space:]]*|*[\'\"\`\$\!\\]*)
      die "invalid --agmsg-team '$AGMSG_TEAM': must not contain whitespace or ' \" \` \$ ! \\" ;;
  esac
fi

# agmsg 配線は team / from が揃っているときだけ行う。send.sh が無ければ未インストール。
if [[ -n "$AGMSG_TEAM" || -n "$AGMSG_FROM" ]]; then
  [[ -n "$AGMSG_TEAM" ]] || die "--agmsg-team is required when --agmsg-from is given"
  [[ -n "$AGMSG_FROM" ]] || die "--agmsg-from is required when --agmsg-team is given"
  [[ -f "$AGMSG_SEND" ]] || die "agmsg is not installed (expected $AGMSG_SEND)"
fi

# 配送は agmsg send.sh の 1 本だけで、送信元は --agmsg-team / --agmsg-from である。
# タイプ入力への fallback は無いので、agmsg 識別子が無いまま「通知するはずの launch」を
# 通してしまうと、黙って無通知のペインが立つ。実際に agmsg を必要とするものに紐付けて落とす:
#
#   --status-dir … この launch は dispatch 管理下であり、生成される runner wrapper が
#       status.json の終端遷移と親への完了通知 (notify_parent_once) を所有する。
#       notify_parent_once は watcher からも exit 経路からも**全モードで無条件に**呼ばれ、
#       team / from が無いと毎回 return 1 になる (watcher は `|| continue` で回り続け、
#       exit 経路は警告 1 行だけ)。
#   --review-config … REVIEW_INSTRUCTION / ABORT_REVIEW_STEP に空の team / sender が
#       補間され、実行不能な指示が子のプロンプトに焼き込まれる。
#
# **--parent-notify-workspace は条件に入れない。**
# これは wrapper 内で `cmux notify` のデスクトップ通知にしか使われず、agmsg の
# 親通知とは独立した機構である。両者を混同すると「デスクトップ通知だけ欲しい
# launch」を殺し、逆に「--parent-notify-workspace 無しで status-dir だけの launch」の
# 無通知を見逃す。(対になっていた `--parent-notify-surface` は v2.0.0 で削除した:
# runner wrapper が書き出す NOTIFY_SF に読み手が無く、`cmux notify` は --workspace
# しか取らないため。)
if [[ -z "$AGMSG_TEAM" || -z "$AGMSG_FROM" ]]; then
  if [[ -n "$STATUS_DIR" ]]; then
    die "--status-dir requires --agmsg-team and --agmsg-from: the runner wrapper owns the parent completion notification and agmsg send.sh is the only delivery channel (there is no typed fallback)"
  fi
  if [[ -n "$REVIEW_CONFIG" ]]; then
    die "--review-config requires --agmsg-team and --agmsg-from: the review request instruction is composed from them and there is no typed fallback"
  fi
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

# model / effort 解決: 明示指定 > role 対応の組込み既定値。
CODEX_EFFORT_FLAG=""
[[ -z "$MODEL" ]] && MODEL="$(dispatch_default_model "$MODEL_ROLE" "$RUNNER_ENGINE")"
[[ -z "$EFFORT" ]] && EFFORT="$(dispatch_default_effort "$MODEL_ROLE")"
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

# codex の goal 継続機能を切る。ターン終了の数十ミリ秒後に
# <codex_internal_context source="goal"> を注入して次のターンを始める機能で、待機中のペインを
# 7〜10 秒周期で回し続ける。しかもその注入文自体が codex の blocked audit を含む:
# 「同じ blocking condition が自動継続を含めて 3 連続 goal ターン続いたら
# update_goal(status:"blocked") を宣言せよ」。レビュー待ちはこれを 30 秒足らずで満たす。
#
# 2026-08-31 に rollout から実測: exec が review-code を送った 81 秒後 (継続 6 回) と、別
# dispatch の 111 秒後 (継続 13 回) に abort を書き、どちらも直後に
# update_goal({status:"blocked"}) を実行した。レビュアーは 2 件とも正常で、あとから完走した。
# 同一セッションで goal が非アクティブだった区間では、同じ待機が 90 分そのまま続いている。
#
# このスキルの子ペインは agmsg メッセージと親の nudge で再開する設計なので、goal 継続は
# 待機を潰す以外の役目を持たない。完走ゲートの待機防衛 (completion-gate.sh の wait_guard) は
# 注入文と議論して勝つ形の防御だが、こちらは駆動源そのものを消すので確定的である。両方を
# 残すのは、goal が別経路 (ユーザーが TUI で設定するなど) で復活しうるための多重防御。
#
# 代償: 止まった codex ペインが自力で再開しなくなる。復帰は agmsg 経由の nudge に一本化される
# (停滞検知は work-signal.sh が担う)。復活させたいときは CODEX_GOALS_FLAG を空にすること。
CODEX_GOALS_FLAG=" -c features.goals=false"

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

prepare_review_directory() { # $1=status directory; stdout=canonical review directory
  local status_dir="$1" review_dir status_real review_real
  [[ -n "$status_dir" ]] || return 1
  if [[ -e "$status_dir" || -L "$status_dir" ]]; then
    [[ -d "$status_dir" && ! -L "$status_dir" ]] || return 1
  else
    mkdir -p "$status_dir" || return 1
  fi
  review_dir="$status_dir/review"
  if [[ -e "$review_dir" || -L "$review_dir" ]]; then
    [[ -d "$review_dir" && ! -L "$review_dir" ]] || return 1
  else
    mkdir "$review_dir" || return 1
  fi
  status_real=$(cd "$status_dir" 2>/dev/null && pwd -P) || return 1
  review_real=$(cd "$review_dir" 2>/dev/null && pwd -P) || return 1
  [[ "$review_real" == "$status_real/review" ]] || return 1
  printf '%s\n' "$review_real"
}

validate_review_config() {
  local expected_review config_parent surface_list registered_engine required_field
  REVIEW_CONFIG_DOC=$(cat "$REVIEW_CONFIG") || die "cannot read review config at $REVIEW_CONFIG"
  for required_field in reviewer_surface reviewer_workspace reviewer_agent reviewer_runner reviewer_engine review_dir; do
    jq -e --arg field "$required_field" -s \
      'length == 1 and (.[0] | type == "object") and (.[0] | has($field))' \
      >/dev/null 2>&1 <<< "$REVIEW_CONFIG_DOC" \
      || die "review config must contain $required_field"
  done
  jq -e -s 'length == 1 and (.[0] | type == "object") and
    (.[0] | keys == ["review_dir","reviewer_agent","reviewer_engine","reviewer_runner",
      "reviewer_surface","reviewer_workspace"]) and
    (.[0].reviewer_surface | type == "string") and
    (.[0].reviewer_workspace | type == "string") and
    (.[0].reviewer_agent | type == "string") and
    (.[0].reviewer_runner | type == "string") and
    (.[0].reviewer_engine == "claude" or .[0].reviewer_engine == "codex") and
    (.[0].review_dir | type == "string")' >/dev/null 2>&1 <<< "$REVIEW_CONFIG_DOC" \
    || die "invalid review config schema at $REVIEW_CONFIG"

  REVIEWER_SURFACE=$(jq -r '.reviewer_surface' <<< "$REVIEW_CONFIG_DOC")
  REVIEWER_WORKSPACE=$(jq -r '.reviewer_workspace' <<< "$REVIEW_CONFIG_DOC")
  REVIEWER_RUNNER=$(jq -r '.reviewer_runner' <<< "$REVIEW_CONFIG_DOC")
  REVIEWER_ENGINE=$(jq -r '.reviewer_engine' <<< "$REVIEW_CONFIG_DOC")
  REVIEWER_AGENT=$(jq -r '.reviewer_agent' <<< "$REVIEW_CONFIG_DOC")
  REVIEW_DIR=$(jq -r '.review_dir' <<< "$REVIEW_CONFIG_DOC")

  dispatch_valid_surface_id "$REVIEWER_SURFACE" \
    || die "invalid reviewer_surface '$REVIEWER_SURFACE' in $REVIEW_CONFIG"
  dispatch_valid_workspace_id "$REVIEWER_WORKSPACE" \
    || die "invalid reviewer_workspace '$REVIEWER_WORKSPACE' in $REVIEW_CONFIG"
  [[ "$REVIEWER_AGENT" =~ ^[A-Za-z0-9._-]+$ ]] \
    || die "invalid reviewer_agent '$REVIEWER_AGENT' in $REVIEW_CONFIG: use only [A-Za-z0-9._-]"
  dispatch_valid_runner_name "$REVIEWER_RUNNER" \
    || die "invalid reviewer_runner '$REVIEWER_RUNNER' in $REVIEW_CONFIG"

  [[ -f "$RUNNERS_CONFIG_PATH" ]] || die "runners.json not found at $RUNNERS_CONFIG_PATH"
  registered_engine=$(jq -r --arg runner "$REVIEWER_RUNNER" \
    'first(.runners[]? | select(.name == $runner) | .engine) // empty' "$RUNNERS_CONFIG_PATH") \
    || die "failed to parse runners.json at $RUNNERS_CONFIG_PATH"
  [[ -n "$registered_engine" && "$registered_engine" == "$REVIEWER_ENGINE" ]] \
    || die "reviewer_runner/reviewer_engine mismatch in $REVIEW_CONFIG"

  expected_review=$(prepare_review_directory "$STATUS_DIR") \
    || die "unsafe review directory under --status-dir"
  [[ -d "$REVIEW_DIR" && ! -L "$REVIEW_DIR" ]] \
    || die "review_dir must be a non-symlink directory in $REVIEW_CONFIG"
  REVIEW_DIR=$(cd "$REVIEW_DIR" 2>/dev/null && pwd -P) \
    || die "cannot resolve review_dir in $REVIEW_CONFIG"
  [[ "$REVIEW_DIR" == "$expected_review" ]] \
    || die "review_dir is outside the canonical --status-dir review directory"
  config_parent=$(cd "$(dirname "$REVIEW_CONFIG")" 2>/dev/null && pwd -P) \
    || die "cannot resolve review config parent directory"
  [[ "$config_parent" == "$REVIEW_DIR" ]] \
    || die "review config is outside review_dir"

  surface_list=$("$CMUX" list-pane-surfaces --workspace "$REVIEWER_WORKSPACE" 2>/dev/null) \
    || die "cannot inspect reviewer_workspace '$REVIEWER_WORKSPACE'"
  grep -oE 'surface:[0-9]+' <<< "$surface_list" | grep -Fxq "$REVIEWER_SURFACE" \
    || die "reviewer_surface '$REVIEWER_SURFACE' does not belong to '$REVIEWER_WORKSPACE'"
}

if [[ -n "$REVIEW_CONFIG" ]]; then
  validate_review_config
fi

if [[ "$MODE" == "review" && -n "$STATUS_DIR" ]]; then
  REVIEW_SANDBOX_DIR=$(prepare_review_directory "$STATUS_DIR") \
    || die "unsafe review directory under --status-dir"
fi

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
  # 既知の残余: jq のパーサは JSON.parse より寛容な入力を
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
    # 除去対象を 1 つでも含む (先頭付近を除き) 長い EFFECTIVE_DEFAULT_MODE (直上の jq -r は
    # -s を付けていないため、連結 JSON ドキュメントでは全ドキュメント分の値が改行連結されて
    # 返る。単一ドキュメントでも defaultMode 自体が長ければ同じ経路に乗る) に対して長さの
    # 超線形 (実測で長さの約 2.7〜3 乗) なコストになり、1 万文字を超えると launch を
    # 数分単位で止める。切り詰めを先にすれば入力は常に 64 文字以下に収まり、
    # この経路のコストは定数になる。
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

# --- Step 2c: 完走ゲート (Stop hook 注入) ---
# plan モードに限らず、status-dir がある全ロール・両 engine に入れる。判定スクリプトと
# 出力契約は共通で、注入先だけが engine ごとに違う。
if [[ "$RUNNER_ENGINE" == "claude" ]]; then
  inject_completion_gate || true
else
  inject_completion_gate_codex || true
  # claude 側は Step 2a で呼んでいるが、codex はそこを通らないのでここで呼ぶ。
  # `|| true` は必須 (非 git な --cwd で launch ごと死ぬのを防ぐ)。
  ensure_claude_exclusions || true
fi

# --- Step 2d: 配線ポインタ (worktree 内の .dispatch-handoff.json) ---
# 引き継ぎメッセージの本文が唯一の情報源である状態を解消する。詳細は
# write_dispatch_handoff() の comment を参照。`|| true` は必須 (ベストエフォート契約)。
write_dispatch_handoff || true

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
    TARGET_FLAGS="--workspace $REVIEWER_WORKSPACE --surface $REVIEWER_SURFACE"
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
        # directive が空 (codex は指示しないので常に空) のときは囲みの一文ごと出さない。
        # 空の囲みを残すと、実装者が中身のない「reviewer-only directive」をレビュー依頼へ
        # 転記してしまい、レビュアーは意味の無い指示を受け取る。
        REVIEWER_DIRECTIVE=$(bash "$SCRIPT_DIR/parallel-directive.sh" \
          --engine "$REVIEWER_ENGINE" --mode review --agents "$MAX_AGENTS")
        if [[ -n "$REVIEWER_DIRECTIVE" ]]; then
          REVIEWER_PARALLEL=" Also include this in the message to the reviewer, addressed to the reviewer and not to you: $REVIEWER_DIRECTIVE End of the message to the reviewer."
        fi
        ;;
      "") ;;
      *) log "warn" "review config has unknown reviewer_engine=$REVIEWER_ENGINE; skipping parallel directive" ;;
    esac
    # (1)(2) は対話有無で変わらない共通部分
    REVIEW_INSTRUCTION="MANDATORY CODE REVIEW: after all changes are committed and BEFORE creating the PR, you must get a code review approval. Round N starts at 1, max 5 rounds. Each round: (1) request the review with ONE call to bash $SCRIPT_DIR/review-request.sh --review-dir $REVIEW_DIR --point code --round N --team $AGMSG_TEAM --from $AGMSG_FROM --to $REVIEWER_AGENT, piping the whole request text into it on standard input with a here-document. That single call writes the request to $REVIEW_DIR/code-round-N-request.md and sends it. Do NOT send a review request with agmsg send.sh and do NOT write the request file by hand. A non-zero exit means the reviewer was NOT told and the file was removed, so report that instead of waiting. The request text you pipe in reads: code review round N: review the committed changes on this branch against the plan at $PLAN_FILE and write findings to $REVIEW_DIR/code-round-N.md whose LAST line must be VERDICT: approve or VERDICT: needs_work. After writing that file, notify me with ONE call to $AGMSG_SEND, passing exactly four arguments in this order: the team $AGMSG_TEAM, the sender $REVIEWER_AGENT, the recipient $AGMSG_FROM, and as a single quoted argument a message that starts with the prefix review-verdict: followed by code-round-N and then the verdict word, approve or needs_work. The file is the record and that message is the only thing that wakes me, so without it I never learn the review finished. From round 2 include your rebuttals to the findings you rejected, with reasons.${REVIEWER_PARALLEL} (2) then stop and wait. As a claude session, first arm ONE single-shot safety timer, a single 30 minute sleep and never a loop, by running sleep 1800 as a background Bash task. As a codex session you have NO safety net for this wait and you cannot build one: a background subshell that first sleeps and then messages you was measured on 2026-08-21 and it dies the moment your turn ends, so do NOT write one -- a timer that looks armed but never fires is worse than no timer, because you would stop believing you are covered. As a codex session do these two things instead, before you stop: first check that the reviewer is alive by running: $READ_SCREEN_CMD -- read-screen returns live content even for unfocused workspaces and a transient failure must not be read as a dead pane, so retry it once, and if the reviewer is gone report that now instead of waiting for a verdict that can never appear; second send ONE message with $AGMSG_SEND, passing exactly four arguments in this order: the team $AGMSG_TEAM, the sender $AGMSG_FROM, the recipient parent, and as a single quoted argument a message starting with the prefix dispatch-notify: followed by $AGMSG_FROM and then the words waiting for code review verdict, this engine has no timer -- that one line is what lets a human notice a waiter that never came back. Do NOT poll the verdict file and do NOT watch the reviewer pane. The reviewer sends you a message whose body starts with review-verdict: once the file is ready, and that message resumes you; as a claude session stop that timer as soon as it arrives, which means TaskStop, and as a codex session there is nothing to stop. As a codex session you also have NO wake budget for this wait and you must never end it yourself: no timer exists, so nothing can fire, and if one of your turns ends and another starts on its own that is an automatic goal continuation from the engine arriving seconds later, not a timer and not a wake. Do not count those turns, do not treat the same wait repeating across them as a blocking condition, do not call update_goal with status blocked, and do not write an abort file or a terminal status because of them. A code review normally takes 10 to 30 minutes of wall clock, which is hundreds of such turns. On one of them, say in one sentence that you are still waiting and end the turn, without re-reading the verdict file and without checking the reviewer pane again. Measured on 2026-08-31: two codex exec panes ended a healthy wait 81 and 111 seconds after sending the request, after 6 and 13 automatic continuations, while both reviewers were working normally and finished later. Only a review-verdict: message, an instruction from parent, or a reviewer confirmed gone ends this wait. Match that message by the review-verdict: prefix plus the round id as a substring, never by an exact whole line match. On ANY wake, whether the message or the timer, re-read $REVIEW_DIR/code-round-N.md before deciding anything: only the message can be lost, so a timer wake with a VERDICT line already in the file means the review finished. If the review-verdict: message arrives but the file has no VERDICT line, treat it as VERDICT: needs_work and say so in your next request. A timer wake with no VERDICT line is NOT a verdict and says nothing about the review, so handle it under (3) and never start a new round on it. (3) On VERDICT: approve proceed to the PR. On VERDICT: needs_work apply the findings you judge valid, commit, and start round N+1. If the timer fires while $REVIEW_DIR/code-round-N.md still has no VERDICT line (claude only -- as a codex session no timer will ever fire), check whether the reviewer is alive by running: $READ_SCREEN_CMD -- read-screen returns live content even for unfocused workspaces, and a transient failure must not be read as a dead pane, so retry it once. Still working means re-arm the same timer and keep waiting, at most 3 re-arms for this round. Otherwise re-send the same round once and re-arm the timer. "
    if [[ $UNATTENDED -eq 1 ]]; then
      # 無人ループ: 判断を求めず固定のフォールバックを取る。文中にクォート文字を使わないこと
      REVIEW_INSTRUCTION="${REVIEW_INSTRUCTION}If round 5 still ends with needs_work, note the unresolved findings in the PR body and proceed to the PR. If the re-armed timer also fires with no VERDICT line after that one re-send, or the 3 re-arms are used up, skip the review, note the skipped review in the PR body, and proceed to the PR. No interactive user is attached to this session, so never wait for a human decision. "
    else
      REVIEW_INSTRUCTION="${REVIEW_INSTRUCTION}If round 5 still ends with needs_work, or the re-armed timer also fires with no VERDICT line after one re-send of the same round, or the 3 re-arms are used up: if you can ask the user interactively via AskUserQuestion, ask whether to proceed to the PR or keep going; otherwise note the unresolved or skipped review in the PR body and proceed. "
    fi
  fi
  ABORT_INSTRUCTION=""
  if [[ -n "$STATUS_DIR" ]]; then
    ABORT_REVIEW_STEP=""
    if [[ -n "$REVIEW_CONFIG" ]]; then
      ABORT_REVIEW_STEP="First write the reason to $REVIEW_DIR/code-round-N-abort.md for the current round N, using N=1 if you never sent a review request; never write it to code-round-N.md, which belongs to the reviewer and may be mid-write. This is only a record because nobody watches that file, so it cannot wake the reviewer. Then tell the reviewer with ONE call to $AGMSG_SEND, passing exactly four arguments in this order: the team $AGMSG_TEAM, the sender $AGMSG_FROM, the recipient $REVIEWER_AGENT, and as a single quoted argument a message that starts with the prefix abort-reviewer: followed by [abort] and then a one line reason for stopping. A non-zero exit means the reviewer was NOT told, so report it. Next "
    fi
    ABORT_PARENT_STEP=""
    # 宛先は parent という agmsg agent 名。agmsg の識別子 (team + from) が無いペインは
    # 親へ届ける手段を持たないので、この手順そのものを出さない。
    if [[ -n "$AGMSG_TEAM" && -n "$AGMSG_FROM" ]]; then
      ABORT_PARENT_STEP="Then notify the parent with ONE call to $AGMSG_SEND, passing exactly four arguments in this order: the team $AGMSG_TEAM, the sender $AGMSG_FROM, the recipient parent, and as a single quoted argument the message text, which is exactly: dispatch-notify: [dispatch] task $WORKSPACE_NAME finished (status: error). A non-zero exit means the parent was NOT told, so report it. "
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
      # --model (明示指定) があれば付与、無ければ codex 側デフォルト
      CORE_CMD="$RUNNER_COMMAND$CODEX_EFFORT_FLAG$CODEX_MODEL_FLAG$CODEX_HOOK_TRUST_FLAG$CODEX_GOALS_FLAG --dangerously-bypass-approvals-and-sandbox '$PROMPT_TEXT'"
    elif [[ "$MODE" == "standby" ]]; then
      # codex standby: prompt なしで idle 起動。実行指示は常に cmux send で届く
      # (prewarm.json の delivery=agmsg のときは加えて agmsg inbox にも記録される)。
      if [[ -n "$PROMPT_TEXT" ]]; then
        CORE_CMD="$RUNNER_COMMAND$CODEX_EFFORT_FLAG$CODEX_MODEL_FLAG$CODEX_HOOK_TRUST_FLAG$CODEX_GOALS_FLAG --dangerously-bypass-approvals-and-sandbox '$PROMPT_TEXT'"
      else
        CORE_CMD="$RUNNER_COMMAND$CODEX_EFFORT_FLAG$CODEX_MODEL_FLAG$CODEX_HOOK_TRUST_FLAG$CODEX_GOALS_FLAG --dangerously-bypass-approvals-and-sandbox"
      fi
    elif [[ "$MODE" == "review" ]]; then
      # review は workspace-write に限定し、approval prompt は抑止する。findings は
      # worktree 外の findings 保存先だけを追加許可する。
      REVIEW_WRITABLE_FLAG=""
      if [[ -n "$REVIEW_SANDBOX_DIR" ]]; then
        # reviewer が worktree 外へ書くのは findings だけ。STATUS_DIR 全体を許可すると
        # roles.json / prewarm.json まで書けてしまい、検証を通る別内容へ差し替えられる。
        REVIEW_WRITABLE_FLAG+=" --add-dir '$REVIEW_SANDBOX_DIR'"
      fi
      # watcher は run/ と db/ にしか書かない。scripts/ を書き込み許可に含めては
      # ならない — そこは全ペインの guard が実行し session-start.sh 経由で
      # マシン上の全 Claude Code セッションが触れるコードで、無人 codex reviewer に
      # 書き込み権を与えるとサンドボックス外・別セッションの権限で任意コードが走る。
      AGMSG_SKILL_DIR="${AGMSG_SKILL_DIR:-$HOME/.agents/skills/agmsg}"
      # 値域検証。この値は下で `--add-dir '<path>'` として composed command に埋まり、
      # その全体が `zsh -ic "..."` で再度包まれる。launch-workspace.sh はエスケープを
      # しないので、`'` を含むパスは引用符を破って後続を別トークンにできる
      # (`-i` は対話モードなので `!` の history 展開も効く)。--agmsg-from と同じ
      # 禁止文字集合で弾く。弾いたときは mkdir も --add-dir もしない (fail-closed)。
      AGMSG_SKILL_DIR_SAFE=1
      case "$AGMSG_SKILL_DIR" in
        *[\'\"\`\$\!\\]*)
          AGMSG_SKILL_DIR_SAFE=0
          log "warn" "AGMSG_SKILL_DIR contains a shell metacharacter; not granting --add-dir for agmsg run/db" ;;
      esac
      # run/ と db/ をここで先に作る。watch.sh は run/ を初回起動時に自分で作る設計
      # (`mkdir -p "$RUN_DIR" 2>/dev/null || return 0`) だが、codex reviewer は
      # --sandbox workspace-write で走るのでサンドボックス内の mkdir は黙って拒否される。
      # 未作成のまま下の -d を評価すると --add-dir が付かず、guard は恒久的に
      # reason=pidfile-missing に落ちる (agmsg を新規インストールしてまだ一度も watcher を
      # 起動していない環境 = このガードが救おうとしている状況そのもの)。
      # agmsg 未インストール時にツリーを勝手に生やさないよう、親の存在を条件にする。
      if [[ $AGMSG_SKILL_DIR_SAFE -eq 1 && -d "$AGMSG_SKILL_DIR" ]]; then
        mkdir -p "$AGMSG_SKILL_DIR/run" "$AGMSG_SKILL_DIR/db" 2>/dev/null || true
      fi
      if [[ $AGMSG_SKILL_DIR_SAFE -eq 1 ]]; then
        [[ -d "$AGMSG_SKILL_DIR/run" ]] && REVIEW_WRITABLE_FLAG+=" --add-dir '$AGMSG_SKILL_DIR/run'"
        [[ -d "$AGMSG_SKILL_DIR/db" ]]  && REVIEW_WRITABLE_FLAG+=" --add-dir '$AGMSG_SKILL_DIR/db'"
      fi
      CORE_CMD="$RUNNER_COMMAND$CODEX_EFFORT_FLAG$CODEX_MODEL_FLAG$CODEX_HOOK_TRUST_FLAG$CODEX_GOALS_FLAG --sandbox workspace-write -c approval_policy='never'$REVIEW_WRITABLE_FLAG${PROMPT_TEXT:+ '$PROMPT_TEXT'}"
    elif [[ "$MODE" == "superpowers" ]]; then
      # codex superpowers: $superpowers:brainstorming プレフィックスで brainstorming skill を発動
      CORE_CMD="$RUNNER_COMMAND$CODEX_EFFORT_FLAG$CODEX_MODEL_FLAG$CODEX_HOOK_TRUST_FLAG$CODEX_GOALS_FLAG --dangerously-bypass-approvals-and-sandbox '\$superpowers:brainstorming $PROMPT_TEXT'"
    else
      # codex plan: claude の --dangerously-skip-permissions に相当するのは
      # --dangerously-bypass-approvals-and-sandbox。/plan slash command は codex でも有効
      CORE_CMD="$RUNNER_COMMAND$CODEX_EFFORT_FLAG$CODEX_MODEL_FLAG$CODEX_HOOK_TRUST_FLAG$CODEX_GOALS_FLAG --dangerously-bypass-approvals-and-sandbox '/plan $PROMPT_TEXT'"
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
      # (agmsg 配線時は呼び出し元 (prewarm-panes.sh) が組み立てた
      #  readiness 確立句 + 待機指示を初期 prompt にする)
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

# review ペインはタスクの所有者に「なれない」。4 ロールが 1 つの STATUS_DIR を共有するため、
# 所有権判定が .assigned-<slug> の有無だけだと、誰かがレビュアーの marker を作った瞬間に
# review ペインが共有 status.json の所有者に化ける。2026-08-28 に実測: Phase A-R の指示で
# 作られた .assigned-<design-review> により、exec が書いた error を design_review が自分の
# 終端状態として親へ通知し、さらに exec_review へ abort-reviewer: まで送った。1 ロールの
# 失敗が 3 ロールの失敗として拡散する。marker を作らせない修正 (SKILL.md) と独立に、
# runner 側でも無条件に黙らせる — 所有できないことは MODE から静的に分かる。
REVIEW_ROLE_FLAG=0
[[ "$MODE" == "review" ]] && REVIEW_ROLE_FLAG=1

RUNNER_FILE="$CWD/$RUNNER_SCRIPT_NAME"
RECOVERY_TICK=$(printf '%q' "$RECOVERY_TICK_BIN")
cat > "$RUNNER_FILE" <<EOF
#!/bin/bash
set -uo pipefail

CMUX="${CMUX}"
STATUS_DIR="${STATUS_DIR}"
SLUG="${WORKSPACE_NAME}"

# completion-gate はこの 4 つでロールを解決する。hook の command は 4 ロールで共有される
# 1 本なので、値は command ではなくプロセス環境から渡さなければならない
# (理由は completion-gate.sh の環境変数フォールバックの comment を参照)。
export DISPATCH_GATE_STATUS_DIR="${STATUS_DIR}"
export DISPATCH_GATE_ROLE="${MODEL_ROLE}"
export DISPATCH_GATE_AGENT="${AGMSG_FROM}"
export DISPATCH_GATE_TEAM="${AGMSG_TEAM}"
DEFER_STATUS="${DEFER_STATUS}"
STANDBY="${STANDBY_FLAG}"
REVIEW_ROLE="${REVIEW_ROLE_FLAG}"
AGMSG_SEND="${AGMSG_SEND}"
AGMSG_TEAM="${AGMSG_TEAM}"
AGMSG_FROM="${AGMSG_FROM}"
TIMEOUT_SENTINEL="${TIMEOUT_SENTINEL}"
RECOVERY_TICK=${RECOVERY_TICK}

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
NOTIFIED_FILE=""
[[ -n "\$STATUS_DIR" ]] && NOTIFIED_FILE="\$STATUS_DIR/.notified-\$SLUG"

# 親へ完了通知を送る。配送は agmsg send.sh の 1 呼び出しだけで、宛先は
# workspace / surface id ではなく parent という agmsg agent 名である。
# 非ゼロ終了はメッセージが届いていないことを意味するので、呼び出し元は再試行する。
notify_parent() {
  local status_label="\$1"
  local msg="dispatch-notify: [dispatch] task \\\"\$SLUG\\\" finished (status: \$status_label)"
  [[ -n "\$AGMSG_TEAM" && -n "\$AGMSG_FROM" ]] || return 1
  bash "\$AGMSG_SEND" "\$AGMSG_TEAM" "\$AGMSG_FROM" parent "\$msg" || return 1
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

# レビュアーへの abort 通知。宛先は review-config が記録した agmsg agent 名で、
# \$SLUG からは組み立てられない (\$SLUG は <task-slug>-exec / <task-slug>-claude で
# あってレビュアーの親 slug とは一致しない)。名前が無ければ黙って諦める。
notify_reviewer_once() {
  local status_label="\$1"
  [[ "\$status_label" == "error" && -n "\$STATUS_DIR" ]] || return 0
  local cfg="\$STATUS_DIR/review/code-review.json"
  [[ -f "\$cfg" ]] || return 0
  local ragent
  ragent=\$(jq -r '.reviewer_agent // empty' "\$cfg" 2>/dev/null || echo "")
  [[ -n "\$ragent" ]] || return 0
  [[ -n "\$AGMSG_TEAM" && -n "\$AGMSG_FROM" ]] || return 1
  local marker="\$STATUS_DIR/.notified-reviewer-\$SLUG" prev=""
  [[ -f "\$marker" ]] && prev=\$(cat "\$marker" 2>/dev/null || echo "")
  [[ "\$prev" == "\$status_label" ]] && return 0
  local reason=""
  [[ -f "\$STATUS_DIR/status.json" ]] && reason=\$(jq -r '.message // empty' "\$STATUS_DIR/status.json" 2>/dev/null || echo "")
  local msg="abort-reviewer: [abort] task \$SLUG stopped with status error: \$reason"
  bash "\$AGMSG_SEND" "\$AGMSG_TEAM" "\$AGMSG_FROM" "\$ragent" "\$msg" || return 1
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
# review ロールは共有 status.json の所有者になれないので watcher ごと起動しない。
# BEGIN RECOVERY WATCHER
if [[ -n "\$STATUS_DIR" && "\$REVIEW_ROLE" != "1" ]]; then
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

      # Deadline enforcement lives outside the stopped pane. This is one tick only; the
      # existing watcher owns the loop and has already established this runner's ownership.
      bash "\$RECOVERY_TICK" --status-dir "\$STATUS_DIR" --role "\$DISPATCH_GATE_ROLE" \
        --agent "\$AGMSG_FROM" --team "\$AGMSG_TEAM" --send-command "\$AGMSG_SEND" 2>/dev/null || true

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
# END RECOVERY WATCHER

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

# ループモード: 親の単発タイマー wake 時の再導出処理が deadline 超過でこのタスクを
# terminal 化済みなら、遅れて終了した子が status.json を上書きしたり、cleanup 済みの
# STATUS_DIR を mkdir -p で復活させたりしないよう、ここで何も書かずに終了する。
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

# review: レビューペインはどんな marker があってもタスクを所有しない。共有 status.json は
# 他ロールのものなので、書き換えも通知もしない (理由は REVIEW_ROLE_FLAG の comment)。
if [[ "\$REVIEW_ROLE" == "1" ]]; then
  echo "[runner] review role never owns the shared status.json; exiting without status update" >&2
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
CREATED_WORKSPACE_ID=""
CREATED_SURFACE_ID=""
CREATED_SURFACE_WORKSPACE=""

list_workspace_ids() {
  local output
  output=$("$CMUX" list-workspaces 2>/dev/null) || return 1
  grep -oE 'workspace:[0-9]+' <<< "$output" | sort -u || true
}

list_workspace_surface_ids() { # $1=workspace
  local output
  output=$("$CMUX" tree --workspace "$1" 2>/dev/null) || return 1
  grep -oE 'surface:[0-9]+' <<< "$output" | sort -u || true
}

# --- 作成したリソースの所有権判定 ---
#
# 2 つの性質を同時に満たす必要がある。片方だけを見て単純化すると、もう片方が壊れる。
#
#   (A) 並列ディスパッチが成立すること。別タスクの launch が同じ瞬間に別の
#       workspace / surface を足すのは正常系なので、「追加はちょうど 1 件」を
#       所有権の条件にしてはならない。条件にすると 2 タスク同時起動が必ず die し、
#       しかも所有権確定前なので EXIT trap も掃除できず孤児が残る。
#   (B) stdout が壊れていても自分のリソースを閉じられること。cmux が成功しつつ
#       解析不能な payload を返す / 既存 ID を先頭に返すケースでは、差分が唯一なら
#       それが自分のものだと確定できるので、所有してから die する。
#
# したがって「stdout の ID が差分に含まれるか」を第一の判定にし (A)、それが使えない
# ときだけ「差分が唯一なら所有」へ落とす (B)。差分が複数かつ stdout が使えない場合は
# 他人のリソースを閉じる危険があるので、所有せずに die する。

added_refs() { # $1=kind $2=before refs $3=after refs
  comm -13 \
    <(grep -E "^$1:[0-9]+$" <<< "$2" | sort -u || true) \
    <(grep -E "^$1:[0-9]+$" <<< "$3" | sort -u || true)
}

# (A) stdout が名乗った ref が差分に含まれるか。追加件数は問わない。
ref_was_added() { # $1=kind $2=ref $3=before refs $4=after refs
  [[ "$2" =~ ^$1:[0-9]+$ ]] || return 1
  grep -qxF "$2" <<< "$(added_refs "$1" "$3" "$4")"
}

# (B) 差分がちょうど 1 件ならそれを返す。stdout が使えないときの回収専用。
sole_added_ref() { # $1=kind $2=before refs $3=after refs
  local added
  added=$(added_refs "$1" "$2" "$3")
  [[ $(grep -Ec "^$1:[0-9]+$" <<< "$added" || true) == 1 ]] || return 1
  printf '%s\n' "$added"
}

# 作成直後・inventory 取得前の暫定所有。inventory 呼び出し自体が一時失敗しても
# 自分のリソースを閉じられるようにする。ただし stdout が既存 ID を返した場合に
# 他人のリソースを掴まないよう、before に無い ID だけを暫定所有する。
provisional_ref() { # $1=kind $2=ref $3=before refs
  [[ "$2" =~ ^$1:[0-9]+$ ]] || return 1
  grep -qxF "$2" <<< "$3" && return 1
  return 0
}

cleanup_created_cmux_resource() {
  local rc=$?
  [[ $rc -ne 0 ]] || return 0
  if [[ -n "$CREATED_SURFACE_ID" ]]; then
    "$CMUX" close-surface --workspace "$CREATED_SURFACE_WORKSPACE" \
      --surface "$CREATED_SURFACE_ID" >/dev/null 2>&1 \
      || log "warn" "failed to close launcher-owned surface $CREATED_SURFACE_ID"
  elif [[ -n "$CREATED_WORKSPACE_ID" ]]; then
    "$CMUX" close-workspace --workspace "$CREATED_WORKSPACE_ID" >/dev/null 2>&1 \
      || log "warn" "failed to close launcher-owned workspace $CREATED_WORKSPACE_ID"
  fi
  return "$rc"
}
trap cleanup_created_cmux_resource EXIT

if [[ ( "$MODE" == "standby" || "$MODE" == "review" ) && -n "$STANDBY_IN" ]]; then
  # --- Standby Split Placement: 既存 workspace 内に縦分割ペインを追加 ---
  WORKSPACE_ID="$STANDBY_IN"
  TITLE="$WORKSPACE_NAME"

  SURFACES_BEFORE=$(list_workspace_surface_ids "$STANDBY_IN") \
    || die "failed to inventory standby workspace before split creation"
  log "cmux" "creating standby pane (split $STANDBY_SPLIT_DIRECTION from $STANDBY_SPLIT_FROM) in $STANDBY_IN"
  SPLIT_OUTPUT=$("$CMUX" new-split "$STANDBY_SPLIT_DIRECTION" \
    --workspace "$STANDBY_IN" \
    --surface "$STANDBY_SPLIT_FROM" 2>/dev/null) || die "failed to create standby split pane"
  SURFACE_ID=$(echo "$SPLIT_OUTPUT" | grep -oE 'surface:[0-9]+' | head -1 || true)
  # 暫定所有: inventory 取得が一時失敗しても閉じられるようにする。既存 ID は掴まない。
  CREATED_SURFACE_WORKSPACE="$WORKSPACE_ID"
  if provisional_ref surface "$SURFACE_ID" "$SURFACES_BEFORE"; then
    CREATED_SURFACE_ID="$SURFACE_ID"
  fi
  SURFACES_AFTER=$(list_workspace_surface_ids "$STANDBY_IN") \
    || die "failed to inventory standby workspace after split creation"
  if ref_was_added surface "$SURFACE_ID" "$SURFACES_BEFORE" "$SURFACES_AFTER"; then
    CREATED_SURFACE_ID="$SURFACE_ID"
  else
    # stdout が使えない。差分が唯一ならそれを回収してから落ちる。
    if RECOVERED_SURFACE_ID=$(sole_added_ref surface "$SURFACES_BEFORE" "$SURFACES_AFTER"); then
      CREATED_SURFACE_ID="$RECOVERED_SURFACE_ID"
    else
      CREATED_SURFACE_ID=""
    fi
    die "split output surface '${SURFACE_ID:-<unparseable>}' is not in the inventory delta: $SPLIT_OUTPUT"
  fi
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
  WORKSPACES_BEFORE=$(list_workspace_ids) \
    || die "failed to inventory workspaces before workspace creation"
  log "cmux" "creating workspace with cwd=$CWD, auto-launching runner via --command"
  WORKSPACE_OUTPUT=$("$CMUX" new-workspace --cwd "$CWD" --command "bash $RUNNER_SCRIPT_NAME" 2>/dev/null) \
    || die "failed to create cmux workspace"
  WORKSPACE_ID=$(echo "$WORKSPACE_OUTPUT" | grep -oE 'workspace:[0-9]+' | head -1 || true)
  # 暫定所有: inventory 取得が一時失敗しても閉じられるようにする。既存 ID は掴まない。
  if provisional_ref workspace "$WORKSPACE_ID" "$WORKSPACES_BEFORE"; then
    CREATED_WORKSPACE_ID="$WORKSPACE_ID"
  fi
  WORKSPACES_AFTER=$(list_workspace_ids) \
    || die "failed to inventory workspaces after workspace creation"
  if ref_was_added workspace "$WORKSPACE_ID" "$WORKSPACES_BEFORE" "$WORKSPACES_AFTER"; then
    CREATED_WORKSPACE_ID="$WORKSPACE_ID"
  else
    # stdout が使えない。差分が唯一ならそれを回収してから落ちる。
    if RECOVERED_WORKSPACE_ID=$(sole_added_ref workspace "$WORKSPACES_BEFORE" "$WORKSPACES_AFTER"); then
      CREATED_WORKSPACE_ID="$RECOVERED_WORKSPACE_ID"
    else
      CREATED_WORKSPACE_ID=""
    fi
    die "workspace output ID '${WORKSPACE_ID:-<unparseable>}' is not in the inventory delta: $WORKSPACE_OUTPUT"
  fi
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
