#!/usr/bin/env bash
# Pre-warm resolved roles in a fixed two-row workspace layout.
# review_mode=off launches design + exec. review_mode=on additionally launches
# design_review to the right of design and exec_review to the right of exec.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./config-lib.sh
source "$SCRIPT_DIR/config-lib.sh"
AGMSG_DIR="${AGMSG_DIR:-$HOME/.agents/skills/agmsg/scripts}"
CMUX_BIN="${CMUX_BIN:-/Applications/cmux.app/Contents/Resources/bin/cmux}"

ROLLBACK_ACTIVE=0
CREATED_WORKTREE=0
CREATED_BRANCH=""
JOINED_ROLES=()
LAUNCHED_SURFACES=()
LAUNCHED_WORKSPACES=()
PREWARM_TMP=""
STATUS_TMP=""
PUBLISHED_INITIAL_STATUS=0

rollback_owned_resources() {
  local i role agent workspace surface
  [[ $ROLLBACK_ACTIVE -eq 1 ]] || return 0
  ROLLBACK_ACTIVE=0

  if [[ $PUBLISHED_INITIAL_STATUS -eq 1 ]]; then
    if [[ -f "$STATUS_DIR/status.json" && ! -L "$STATUS_DIR/status.json" ]]; then
      rm -f -- "$STATUS_DIR/status.json" \
        || log warn "failed to remove rollback status artifact $STATUS_DIR/status.json"
    else
      log warn "refusing to remove changed rollback status artifact $STATUS_DIR/status.json"
    fi
    PUBLISHED_INITIAL_STATUS=0
  fi
  if [[ -n "$PREWARM_TMP" ]]; then
    rm -f -- "$PREWARM_TMP" || log warn "failed to remove temporary prewarm artifact"
    PREWARM_TMP=""
  fi
  if [[ -n "$STATUS_TMP" ]]; then
    rm -f -- "$STATUS_TMP" || log warn "failed to remove temporary status artifact"
    STATUS_TMP=""
  fi

  for ((i=${#LAUNCHED_SURFACES[@]}-1; i>=0; i--)); do
    surface="${LAUNCHED_SURFACES[$i]}"
    workspace="${LAUNCHED_WORKSPACES[$i]}"
    [[ -n "$workspace" && -n "$surface" ]] || continue
    "$CMUX_BIN" close-surface --workspace "$workspace" --surface "$surface" \
      >/dev/null 2>&1 || log warn "failed to close rollback surface $surface in $workspace"
  done
  for ((i=${#JOINED_ROLES[@]}-1; i>=0; i--)); do
    role="${JOINED_ROLES[$i]}"
    agent=$(role_agent "$role")
    bash "$AGMSG_DIR/leave.sh" "$AGMSG_TEAM" "$agent" >/dev/null 2>&1 \
      || log warn "failed to leave rollback agent $agent"
  done
  if [[ $CREATED_WORKTREE -eq 1 && -n "${CWD:-}" ]]; then
    git worktree remove "$CWD" --force >/dev/null 2>&1 \
      || log warn "failed to remove rollback worktree $CWD"
  fi
  if [[ -n "$CREATED_BRANCH" ]]; then
    git branch -D "$CREATED_BRANCH" >/dev/null 2>&1 \
      || log warn "failed to remove rollback branch $CREATED_BRANCH"
  fi
}

die() {
  echo "Error: $1" >&2
  rollback_owned_resources
  exit 2
}

log() { echo "[$1] $2" >&2; }

WORKSPACE=""
BASE_SURFACE=""
CWD=""
SLUG=""
STATUS_DIR=""
AGMSG_TEAM=""
WITH_DESIGN=0
NOTIFY_WORKSPACE=""
UNATTENDED=0
TIMEOUT_SENTINEL=""
ROLES_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --workspace)
      [[ $# -ge 2 ]] || die "--workspace requires a workspace ID"
      WORKSPACE="$2"; shift 2 ;;
    --base-surface)
      [[ $# -ge 2 ]] || die "--base-surface requires a surface ID"
      BASE_SURFACE="$2"; shift 2 ;;
    --cwd)
      [[ $# -ge 2 ]] || die "--cwd requires a path argument"
      CWD="$2"; shift 2 ;;
    --slug)
      [[ $# -ge 2 ]] || die "--slug requires a task slug"
      SLUG="$2"; shift 2 ;;
    --status-dir)
      [[ $# -ge 2 ]] || die "--status-dir requires a path argument"
      STATUS_DIR="$2"; shift 2 ;;
    --agmsg-team)
      [[ $# -ge 2 ]] || die "--agmsg-team requires a team name"
      AGMSG_TEAM="$2"; shift 2 ;;
    --roles)
      [[ $# -ge 2 ]] || die "--roles requires a path argument"
      ROLES_FILE="$2"; shift 2 ;;
    --with-design|--with-opus)
      WITH_DESIGN=1; shift ;;
    --unattended)
      UNATTENDED=1; shift ;;
    --timeout-sentinel)
      [[ $# -ge 2 ]] || die "--timeout-sentinel requires a path"
      TIMEOUT_SENTINEL="$2"; shift 2 ;;
    --parent-notify-workspace)
      [[ $# -ge 2 ]] || die "--parent-notify-workspace requires a workspace ID"
      NOTIFY_WORKSPACE="$2"; shift 2 ;;
    --design-runner|--reviewer-runner|--exec-runner|--claude-runner|--codex-runner|--exec-choice|--review-"model"|--design-model|--design-effort|--reviewer-model|--reviewer-effort|--exec-model|--exec-effort)
      die "$1 was removed: pass the validated resolver output with --roles instead" ;;
    --message-type)
      die "--message-type was removed: agmsg is mandatory for prewarmed panes" ;;
    --parent-notify-surface)
      die "--parent-notify-surface was removed: pass --parent-notify-workspace instead" ;;
    *) die "unknown option: $1" ;;
  esac
done

[[ -n "$CWD" ]] || die "--cwd is required"
[[ -n "$SLUG" ]] || die "--slug is required"
[[ "$SLUG" =~ ^[A-Za-z0-9._-]+$ ]] || die "invalid slug '$SLUG': use only [A-Za-z0-9._-]"
[[ -n "$STATUS_DIR" ]] || die "--status-dir is required"
[[ -n "$AGMSG_TEAM" ]] || die "--agmsg-team is required: prewarmed panes only receive work through agmsg"
[[ -n "$ROLES_FILE" ]] || die "--roles is required"

if [[ $UNATTENDED -eq 1 && -n "${CODEX_THREAD_ID:-}" ]]; then
  die "--unattended is refused from a codex parent: codex cannot arm the 90-minute safety timer"
fi

case "$AGMSG_DIR" in
  *[[:space:]]*|*[\'\"\`\$\!\\]*) die "AGMSG_DIR contains whitespace or shell metacharacters" ;;
esac
case "$AGMSG_TEAM" in
  *[[:space:]]*|*[\'\"\`\$\!\\]*) die "--agmsg-team contains whitespace or shell metacharacters" ;;
esac

command -v jq >/dev/null 2>&1 || die "jq is not installed"
command -v git >/dev/null 2>&1 || die "git is not installed"

validate_publish_destination() {
  local prewarm_file="$STATUS_DIR/prewarm.json" status_file="$STATUS_DIR/status.json"
  if [[ -e "$STATUS_DIR" || -L "$STATUS_DIR" ]]; then
    [[ -d "$STATUS_DIR" && ! -L "$STATUS_DIR" ]] \
      || die "status path must be a non-symlink directory"
  fi
  if [[ -e "$prewarm_file" || -L "$prewarm_file" ]]; then
    [[ -f "$prewarm_file" && ! -L "$prewarm_file" ]] \
      || die "prewarm target must be a regular non-symlink file"
  fi
  if [[ -e "$status_file" || -L "$status_file" ]]; then
    [[ -f "$status_file" && ! -L "$status_file" ]] \
      || die "status target must be a regular non-symlink file"
  fi
}

# Read the resolver output exactly once. All validation and extraction below use
# this immutable in-process snapshot, never ROLES_FILE again.
ROLES_DOC=$(cat "$ROLES_FILE") || die "cannot read --roles file"
jq -e 'type' >/dev/null 2>&1 <<< "$ROLES_DOC" || die "--roles file is not valid JSON"

RUNNERS_FILE="$(dispatch_runners_file)"
[[ -f "$RUNNERS_FILE" ]] || die "runners.json not found at $RUNNERS_FILE"
jq -e '.runners | type == "array"' "$RUNNERS_FILE" >/dev/null 2>&1 \
  || die "invalid runners.json at $RUNNERS_FILE"

validate_roles_doc() {
  local bad_top review_mode expected role runner engine effort model runner_engine
  jq -e 'type == "object"' >/dev/null 2>&1 <<< "$ROLES_DOC" \
    || die "invalid --roles: top-level JSON value must be an object"
  bad_top=$(jq -r '[keys[] | select(. != "review_mode" and . != "roles" and
    . != "config_home" and . != "global_config" and . != "project_config" and
    . != "runners_file")] | first // empty' <<< "$ROLES_DOC")
  [[ -z "$bad_top" ]] || die "invalid --roles top-level key '$bad_top'"
  jq -e '.roles | type == "object"' >/dev/null 2>&1 <<< "$ROLES_DOC" \
    || die "invalid --roles: roles must be an object"

  review_mode=$(jq -r '.review_mode // empty' <<< "$ROLES_DOC")
  [[ "$review_mode" == on || "$review_mode" == off ]] \
    || die "invalid --roles review_mode: expected on or off"
  if [[ "$review_mode" == on ]]; then
    expected='["design","design_review","exec","exec_review"]'
  else
    expected='["design","exec"]'
  fi
  jq -e --argjson expected "$expected" '(.roles | keys) == $expected' >/dev/null 2>&1 <<< "$ROLES_DOC" \
    || die "invalid --roles: active role set does not match review_mode=$review_mode"

  for role in design design_review exec exec_review; do
    jq -e --arg role "$role" '.roles | has($role)' >/dev/null 2>&1 <<< "$ROLES_DOC" || continue
    jq -e --arg role "$role" '
      (.roles[$role] | type == "object") and
      ((.roles[$role] | keys - ["runner","engine","model","effort"]) | length == 0) and
      (.roles[$role] | has("runner") and has("engine") and has("effort")) and
      (.roles[$role].runner | type == "string") and
      (.roles[$role].engine | type == "string") and
      (.roles[$role].effort | type == "string")' >/dev/null 2>&1 <<< "$ROLES_DOC" \
      || die "invalid --roles tuple for $role"

    runner=$(jq -r --arg role "$role" '.roles[$role].runner' <<< "$ROLES_DOC")
    engine=$(jq -r --arg role "$role" '.roles[$role].engine' <<< "$ROLES_DOC")
    effort=$(jq -r --arg role "$role" '.roles[$role].effort' <<< "$ROLES_DOC")
    dispatch_valid_runner_name "$runner" || die "invalid runner name for $role"
    dispatch_valid_effort "$effort" "$engine" || die "invalid effort for $role"
    runner_engine=$(jq -r --arg runner "$runner" \
      'first(.runners[]? | select(.name == $runner) | .engine) // empty' "$RUNNERS_FILE")
    [[ -n "$runner_engine" ]] || die "runner '$runner' for $role is not registered"
    [[ "$runner_engine" == "$engine" ]] \
      || die "engine mismatch for $role: runner '$runner' is $runner_engine, not $engine"

    if jq -e --arg role "$role" '.roles[$role] | has("model")' >/dev/null 2>&1 <<< "$ROLES_DOC"; then
      jq -e --arg role "$role" '.roles[$role].model | type == "string" and length > 0' \
        >/dev/null 2>&1 <<< "$ROLES_DOC" || die "invalid model for $role"
      model=$(jq -r --arg role "$role" '.roles[$role].model' <<< "$ROLES_DOC")
      dispatch_valid_model "$model" || die "invalid model for $role"
    elif dispatch_model_required "$role" "$engine"; then
      die "model is required for $role with engine $engine"
    fi
  done
}

# Every configuration violation is rejected before worktree, agmsg, or pane side effects.
validate_roles_doc
REVIEW_MODE=$(jq -r '.review_mode' <<< "$ROLES_DOC")
validate_publish_destination

if [[ $WITH_DESIGN -eq 1 ]]; then
  [[ -z "$WORKSPACE" && -z "$BASE_SURFACE" ]] \
    || die "--with-design is mutually exclusive with --workspace/--base-surface"
else
  [[ -n "$WORKSPACE" ]] || die "--workspace is required without --with-design"
  [[ -n "$BASE_SURFACE" ]] || die "--base-surface is required without --with-design"
fi
[[ -f "$AGMSG_DIR/send.sh" ]] || die "agmsg is not installed (expected $AGMSG_DIR/send.sh)"

if [[ -d "$CWD" ]]; then
  log worktree "already exists at $CWD, reusing"
else
  BRANCH_NAME="feat/$SLUG"
  BRANCH_EXISTED=0
  git show-ref --verify --quiet "refs/heads/$BRANCH_NAME" && BRANCH_EXISTED=1 || true
  log worktree "creating $CWD with branch $BRANCH_NAME"
  git worktree add "$CWD" -b "$BRANCH_NAME" 2>/dev/null \
    || git worktree add "$CWD" "$BRANCH_NAME" 2>/dev/null \
    || die "failed to create worktree at $CWD"
  CREATED_WORKTREE=1
  [[ $BRANCH_EXISTED -eq 1 ]] || CREATED_BRANCH="$BRANCH_NAME"
fi

role_value() { jq -r --arg role "$1" --arg field "$2" '.roles[$role][$field] // empty' <<< "$ROLES_DOC"; }
role_has_model() { jq -e --arg role "$1" '.roles[$role] | has("model")' >/dev/null 2>&1 <<< "$ROLES_DOC"; }
role_agent() {
  case "$1" in
    design) printf '%s\n' "$SLUG" ;;
    *) printf '%s-%s\n' "$SLUG" "${1//_/-}" ;;
  esac
}
role_wiring_type() { [[ "$(role_value "$1" engine)" == codex ]] && printf 'codex\n' || printf 'claude-code\n'; }

# readiness 句の前提: delivery.sh set monitor claude-code <worktree> が
# この同じ実行内で成功していること。失敗時は到達不能なので launch 前に止める。
# worktree を agmsg の独立プロジェクトとして登録する。
#
# resolve-project.sh は既定で git worktree をメインリポジトリのルートへ解決する (#92 の
# 意図的な仕様。ユーザーがサブディレクトリへ cd したときの取り違えを防ぐため)。だが
# dispatch の子セッションは worktree に *住んでいる* ので、その解決は事実と合わない。
# 解決されると子も親も同一のプロジェクトキーを共有し、無記名 watcher が (project, type) に
# 登録された全 agent 宛てを購読して read cursor を奪い合う。2026-08-22 の実害は
# 「子の無記名 watcher が parent ペアを購読していたため [ready] が食われた」形で出た。
#
# AGMSG_RESOLVE_PROJECT=0 は raw パスを保つ documented なエスケープハッチで、
# spawn.sh:357 が同じ理由で使っている。以後 agmsg_ancestor_project は inclusive
# (start 自身を候補にする) なので worktree で止まり、タスクごとに別キーになる。
#
# join と delivery の両方に付けること。片方だけだと登録先と配送モードの付け先がずれる。
wire_delivery() {
  local role="$1" wiring
  wiring=$(role_wiring_type "$role")
  AGMSG_RESOLVE_PROJECT=0 bash "$AGMSG_DIR/delivery.sh" set monitor "$wiring" "$CWD" >/dev/null 2>&1 \
    || die "$wiring delivery wiring failed; readiness cannot be established"
}

join_role() {
  local role="$1" agent wiring
  agent=$(role_agent "$role")
  wiring=$(role_wiring_type "$role")
  AGMSG_RESOLVE_PROJECT=0 bash "$AGMSG_DIR/join.sh" "$AGMSG_TEAM" "$agent" "$wiring" "$CWD" >&2 2>/dev/null \
    || die "$role agmsg join failed; readiness cannot be established"
  JOINED_ROLES+=("$role")
  wire_delivery "$role"
}

forget_joined_role() {
  local target="$1" current kept=()
  for current in "${JOINED_ROLES[@]}"; do
    [[ "$current" == "$target" ]] || kept+=("$current")
  done
  JOINED_ROLES=("${kept[@]}")
}

leave_role() {
  local role="$1" agent
  agent=$(role_agent "$role")
  if bash "$AGMSG_DIR/leave.sh" "$AGMSG_TEAM" "$agent" >/dev/null 2>&1; then
    forget_joined_role "$role"
  else
    log warn "failed to leave $agent after pane launch failure"
  fi
}

ROLLBACK_ACTIVE=1
for role in design exec; do join_role "$role"; done
if [[ "$REVIEW_MODE" == on ]]; then
  join_role design_review
  join_role exec_review
fi

readiness_clause() {
  local role="$1" agent wiring
  agent=$(role_agent "$role")
  wiring=$(role_wiring_type "$role")
  if [[ "$wiring" == codex ]]; then
    # codex には Monitor tool が無い (type.conf の monitor=no) が、agmsg の SessionStart は
    # engine で分岐せず invoke the Monitor tool now と出力する。それに従おうとした codex
    # ペインが、代替として watch.sh をバックグラウンド端末で起動した実例がある
    # (2026-08-22)。watch.sh は読まれたかに関係なく row を既読にするので、idle の codex
    # ペイン — つまりターンを取らないペイン — 宛のメッセージは配信され、既読になり、誰にも
    # 読まれずに消える。review-plan: 2 通がこれで失われ、design ペインは応答を待ち続けた。
    # 起動しなければメッセージは未読のまま残り、あとから回復できる。だから明示的に禁じる。
    printf 'FIRST make yourself reachable: call %s/drivers/types/codex/codex-record-session.sh with team %s and agent name %s (two arguments, no trailing punctuation). Do not start watch.sh yourself, in a background terminal or anywhere else, and never start a watcher of any kind by hand: you have no Monitor tool, so if your SessionStart hook tells you to invoke one, that part does not apply to you. A watcher you start marks messages as read whether or not you ever look at them, so anything that arrives while you are idle is consumed and lost; left alone, it stays unread and can still be recovered. THEN send a message: call %s/send.sh with team %s, from %s, to parent, and a body — quoted as a single argument — that is exactly [ready] %s with no trailing period or other characters.' \
      "$AGMSG_DIR" "$AGMSG_TEAM" "$agent" "$AGMSG_DIR" "$AGMSG_TEAM" "$agent" "$agent"
  else
    # 順序が要件そのものである。claim → 名前付き Monitor → [ready] の順で打たないと、
    # 無記名 watcher のまま名乗ることになり、その窓の間 (project, type) に登録された
    # 全 agent 宛てを購読して read cursor を奪い合う。SessionStart は role-filtered 指示を
    # 出せない — その判定材料 (role-session レコード) を書くのがペイン起動後だからである。
    # 文面にクォート文字を入れてはならない (zsh -ic "... '<prompt>'" の二重引用が壊れる)。
    printf 'FIRST claim your identity so messages addressed to you cannot be taken by another watcher: run %s/actas-claim.sh with four arguments in this order — the current working directory, then claude-code, then %s, then the value of CLAUDE_CODE_SESSION_ID — and read the status= line it prints. On status=held another live session already owns this name: stop, report that, and do not continue. SECOND invoke the Monitor tool with the command your SessionStart AGMSG-DIRECTIVE printed plus %s appended as a fourth argument; that fourth argument is what limits delivery to you. If you already started that Monitor without the fourth argument, TaskStop it first — a watcher started without a name stays unnamed for its whole life. THEN send a message: call %s/send.sh with team %s, from %s, to parent, and a body — quoted as a single argument — that is exactly [ready] %s with no trailing period or other characters.' \
      "$AGMSG_DIR" "$agent" "$agent" "$AGMSG_DIR" "$AGMSG_TEAM" "$agent" "$agent"
  fi
}

NOTIFY_FLAGS=()
[[ -n "$NOTIFY_WORKSPACE" ]] && NOTIFY_FLAGS=(--parent-notify-workspace "$NOTIFY_WORKSPACE")
SENTINEL_FLAGS=()
[[ -n "$TIMEOUT_SENTINEL" ]] && SENTINEL_FLAGS=(--timeout-sentinel "$TIMEOUT_SENTINEL")

launch_role() { # role [workspace split-from direction]
  local role="$1" workspace="${2:-}" split_from="${3:-}" direction="${4:-}"
  local runner engine effort agent prompt result surface
  runner=$(role_value "$role" runner)
  engine=$(role_value "$role" engine)
  effort=$(role_value "$role" effort)
  agent=$(role_agent "$role")
  prompt="$(readiness_clause "$role") Then wait idle. Your task will arrive as an agmsg message. Do not start work until it arrives. Do not poll or run an inbox wait loop."

  local args=(--cwd "$CWD")
  if [[ "$role" == design ]]; then
    args+=(--mode standby --role design --defer-status)
  elif [[ "$role" == exec ]]; then
    args+=(--mode standby --role exec --standby-in "$workspace"
      --standby-split-from "$split_from" --standby-split-direction "$direction")
  else
    args+=(--mode review --role "$role" --standby-in "$workspace"
      --standby-split-from "$split_from" --standby-split-direction "$direction")
  fi
  args+=(--runner "$runner")
  role_has_model "$role" && args+=(--model "$(role_value "$role" model)")
  args+=(--effort "$effort")
  [[ "$engine" == claude && "$role" != design ]] && args+=(--skip-permissions)
  [[ "$engine" == claude && "$role" == design && $UNATTENDED -eq 1 ]] && args+=(--skip-permissions)
  [[ ${#SENTINEL_FLAGS[@]} -eq 0 ]] || args+=("${SENTINEL_FLAGS[@]}")
  args+=(--status-dir "$STATUS_DIR")
  [[ ${#NOTIFY_FLAGS[@]} -eq 0 ]] || args+=("${NOTIFY_FLAGS[@]}")
  args+=(--agmsg-team "$AGMSG_TEAM" --agmsg-from "$agent")

  if result=$(bash "$SCRIPT_DIR/launch-workspace.sh" "${args[@]}" "$agent" "$prompt"); then
    if ! jq -e 'type == "object"' >/dev/null 2>&1 <<< "$result"; then
      if [[ "$role" == design || "$role" == exec ]]; then
        die "required $role pane returned invalid JSON"
      fi
      leave_role "$role"
      log warn "$role pane returned invalid JSON; omitting that review role"
      return 1
    fi
    surface=$(jq -r 'if (.surface_id | type) == "string" then .surface_id else empty end' <<< "$result")
    if [[ -z "$surface" ]]; then
      [[ "$role" == design || "$role" == exec ]] && die "failed to parse required $role pane output"
      leave_role "$role"
      log warn "$role pane output had no surface; omitting that review role"
      return 1
    fi
    LAUNCHED_SURFACE="$surface"
    LAUNCHED_WORKSPACE=""
    [[ "$role" != design ]] || LAUNCHED_WORKSPACE=$(jq -r \
      'if (.workspace_id | type) == "string" then .workspace_id else empty end' <<< "$result")
    [[ "$role" != design || -n "$LAUNCHED_WORKSPACE" ]] || die "failed to parse design workspace output"
    LAUNCHED_SURFACES+=("$LAUNCHED_SURFACE")
    if [[ "$role" == design ]]; then
      LAUNCHED_WORKSPACES+=("$LAUNCHED_WORKSPACE")
    else
      LAUNCHED_WORKSPACES+=("$workspace")
    fi
    return 0
  fi

  if [[ "$role" == design || "$role" == exec ]]; then
    die "failed to launch required $role pane"
  fi
  leave_role "$role"
  log warn "failed to launch $role pane; omitting that review role"
  return 1
}

DESIGN_SURFACE="$BASE_SURFACE"
if [[ $WITH_DESIGN -eq 1 ]]; then
  launch_role design
  DESIGN_SURFACE="$LAUNCHED_SURFACE"
  WORKSPACE="$LAUNCHED_WORKSPACE"
fi
[[ -n "$WORKSPACE" && -n "$DESIGN_SURFACE" ]] || die "design workspace and surface are required"

# 順序が 4 象限の均等さを決める。`cmux new-split` はサイズ引数を取らず対象ペインを 50/50 に
# 割るだけなので、「何を分割するか」を間違えると幅と高さがずれる。
#
#   1) design が全面        2) exec を down    3) design_review を right  4) exec_review を right
#   +-------------+         +------+------+   +------+------+            +------+------+
#   |             |         |design       |   |design| d_rev|            |design| d_rev|
#   |   design    |   -->   +------+------+ - +------+------+     -->    +------+------+
#   |             |         |exec         |   |exec         |            |exec  | e_rev|
#   +-------------+         +------+------+   +------+------+            +------+------+
#
# design_review を exec より先に作ってはならない。design が先に左半分へ縮み、design_review が
# 右半分を全高で占めるため、そのあと design を down 分割しても割れるのは左半分だけになり、
# 左に 3 枚・右に 1 枚という不均等なレイアウトになる。方向と分割元は個別には正しいままなので、
# この崩れは順序を検査しないと見つからない (test-prewarm-layout.sh の PG1)。
launch_role exec "$WORKSPACE" "$DESIGN_SURFACE" down
EXEC_SURFACE="$LAUNCHED_SURFACE"

DESIGN_REVIEW_SURFACE=""
if [[ "$REVIEW_MODE" == on ]]; then
  if launch_role design_review "$WORKSPACE" "$DESIGN_SURFACE" right; then
    DESIGN_REVIEW_SURFACE="$LAUNCHED_SURFACE"
  fi
fi

EXEC_REVIEW_SURFACE=""
if [[ "$REVIEW_MODE" == on ]]; then
  if launch_role exec_review "$WORKSPACE" "$EXEC_SURFACE" right; then
    EXEC_REVIEW_SURFACE="$LAUNCHED_SURFACE"
  fi
fi

role_entry() {
  local role="$1" surface="$2" agent
  agent=$(role_agent "$role")
  jq -c --arg role "$role" --arg surface "$surface" --arg agent "$agent" \
    '.roles[$role] + {surface_id: $surface, agent: $agent, wired: true}' <<< "$ROLES_DOC"
}

DESIGN_ENTRY=$(role_entry design "$DESIGN_SURFACE")
EXEC_ENTRY=$(role_entry exec "$EXEC_SURFACE")
DESIGN_REVIEW_ENTRY='{}'
EXEC_REVIEW_ENTRY='{}'
[[ -z "$DESIGN_REVIEW_SURFACE" ]] || DESIGN_REVIEW_ENTRY=$(role_entry design_review "$DESIGN_REVIEW_SURFACE")
[[ -z "$EXEC_REVIEW_SURFACE" ]] || EXEC_REVIEW_ENTRY=$(role_entry exec_review "$EXEC_REVIEW_SURFACE")
PANES_JSON=$(jq -n \
  --argjson design "$DESIGN_ENTRY" --argjson exec "$EXEC_ENTRY" \
  --arg drs "$DESIGN_REVIEW_SURFACE" --arg ers "$EXEC_REVIEW_SURFACE" \
  --argjson dr "$DESIGN_REVIEW_ENTRY" --argjson er "$EXEC_REVIEW_ENTRY" \
  '{design: $design} + (if $drs != "" then {design_review: $dr} else {} end) +
   {exec: $exec} + (if $ers != "" then {exec_review: $er} else {} end)')

mkdir -p "$STATUS_DIR" || die "cannot create status directory at $STATUS_DIR"
validate_publish_destination
PREWARM_TMP=$(mktemp "$STATUS_DIR/.prewarm.json.XXXXXX") \
  || die "cannot create temporary prewarm artifact"
jq -n --arg workspace_id "$WORKSPACE" --arg review_mode "$REVIEW_MODE" --argjson panes "$PANES_JSON" \
  '{workspace_id: $workspace_id, review_mode: $review_mode} + $panes' > "$PREWARM_TMP" \
  || die "cannot write temporary prewarm artifact"

WROTE_INITIAL_STATUS=0
if [[ $WITH_DESIGN -eq 1 && ! -f "$STATUS_DIR/status.json" ]]; then
  STATUS_TMP=$(mktemp "$STATUS_DIR/.status.json.XXXXXX") \
    || die "cannot create temporary initial status artifact"
  jq -n --arg ws "$WORKSPACE" --arg sf "$DESIGN_SURFACE" \
    '{status: "launched", workspace_id: $ws, surface_id: $sf,
      message: "agmsg prewarm panes launched (idle)", timestamp: (now | todate)}' \
    > "$STATUS_TMP" || die "cannot write temporary initial status artifact"
fi

validate_publish_destination
if [[ -n "$STATUS_TMP" ]]; then
  mv -- "$STATUS_TMP" "$STATUS_DIR/status.json" \
    || die "cannot publish initial $STATUS_DIR/status.json"
  STATUS_TMP=""
  PUBLISHED_INITIAL_STATUS=1
  WROTE_INITIAL_STATUS=1
fi
mv -- "$PREWARM_TMP" "$STATUS_DIR/prewarm.json" \
  || die "cannot publish $STATUS_DIR/prewarm.json"
PREWARM_TMP=""
ROLLBACK_ACTIVE=0
PUBLISHED_INITIAL_STATUS=0

log prewarm "wrote $STATUS_DIR/prewarm.json"
[[ $WROTE_INITIAL_STATUS -eq 0 ]] || log prewarm "wrote initial launched status.json"

jq -n --arg workspace_id "$WORKSPACE" --arg review_mode "$REVIEW_MODE" --argjson panes "$PANES_JSON" \
  '{workspace_id: $workspace_id, review_mode: $review_mode, panes: $panes}'
