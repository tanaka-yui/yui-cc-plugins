#!/usr/bin/env bash
# GitHub issue 自動ループの issue 取得・claim・状態管理。
# Usage: issue-fetch.sh --state-file <path> <subcommand> [options]

set -euo pipefail

die() { echo "Error: $1" >&2; exit 1; }
log() { echo "[$1] $2" >&2; }

MAX_WINDOW=1000
STATE_FILE=""
SUBCOMMAND=""
LEASE_MIN=30
LIMIT=0
BATCH=0
LABELS=""
ASSIGNEE=""
ISSUE_STATE="open"
DRY_RUN=0
ISSUE_NUM=""
FINAL_STATUS=""
PR_URL=""
MESSAGE=""
CONFIG_JSON=""
FILTER_JSON=""
OWNER_GENERATION=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --state-file) [[ $# -lt 2 ]] && die "--state-file requires a path"; STATE_FILE="$2"; shift 2 ;;
    --lease-min) [[ $# -lt 2 ]] && die "--lease-min requires a number"; LEASE_MIN="$2"; shift 2 ;;
    --limit) [[ $# -lt 2 ]] && die "--limit requires a number"; LIMIT="$2"; shift 2 ;;
    --batch) [[ $# -lt 2 ]] && die "--batch requires a number"; BATCH="$2"; shift 2 ;;
    --labels) [[ $# -lt 2 ]] && die "--labels requires a value"; LABELS="$2"; shift 2 ;;
    --assignee) [[ $# -lt 2 ]] && die "--assignee requires a value"; ASSIGNEE="$2"; shift 2 ;;
    --state) [[ $# -lt 2 ]] && die "--state requires a value"; ISSUE_STATE="$2"; shift 2 ;;
    --issue) [[ $# -lt 2 ]] && die "--issue requires a number"; ISSUE_NUM="$2"; shift 2 ;;
    --status) [[ $# -lt 2 ]] && die "--status requires a value"; FINAL_STATUS="$2"; shift 2 ;;
    --pr-url) [[ $# -lt 2 ]] && die "--pr-url requires a value"; PR_URL="$2"; shift 2 ;;
    --message) [[ $# -lt 2 ]] && die "--message requires a value"; MESSAGE="$2"; shift 2 ;;
    --config-json) [[ $# -lt 2 ]] && die "--config-json requires JSON"; CONFIG_JSON="$2"; shift 2 ;;
    --filter-json) [[ $# -lt 2 ]] && die "--filter-json requires JSON"; FILTER_JSON="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -*) die "unknown option: $1" ;;
    *) [[ -z "$SUBCOMMAND" ]] || die "unexpected argument: $1"; SUBCOMMAND="$1"; shift ;;
  esac
done

[[ -n "$STATE_FILE" ]] || die "--state-file is required"
[[ -n "$SUBCOMMAND" ]] || die "a subcommand is required"
command -v jq >/dev/null 2>&1 || die "jq is not installed"

abs_dir() {
  case "$1" in
    /*) printf '%s' "$1" ;;
    *) printf '%s/%s' "$(pwd)" "$1" ;;
  esac
}

LOOP_DIR="$(abs_dir "$(dirname "$STATE_FILE")")"
LOCK_DIR="$LOOP_DIR/loop.lock.d"
OWNER_FILE="$LOCK_DIR/owner.json"
TAKEOVER_MUTEX="$LOOP_DIR/loop.lock.takeover.d"
SESSION_ID="${LOOP_SESSION_ID:-${CLAUDE_CODE_SESSION_ID:-}}"
HOST="$(hostname -s 2>/dev/null || echo unknown)"
LOCK_INFLIGHT_GRACE_SEC=60
TAKEOVER_MUTEX_GRACE_SEC=120

require_session_id() {
  [[ -n "$SESSION_ID" ]] || die "stable session id not found; set LOOP_SESSION_ID (or CLAUDE_CODE_SESSION_ID)"
}
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
# issue タイトルから workspace 名として安全な slug を作る (最大 30 文字)。
make_slug() {
  local number="$1" title="$2" body
  body=$(printf '%s' "$title" | tr '[:upper:]' '[:lower:]' | sed -e 's/[^a-z0-9]\{1,\}/-/g' -e 's/^-//' -e 's/-$//')
  printf 'issue-%s-%s' "$number" "$body" | cut -c1-30 | sed -e 's/-$//'
}
dir_mtime_epoch() { stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo 0; }
iso_to_epoch() {
  date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$1" +%s 2>/dev/null || date -u -d "$1" +%s 2>/dev/null || echo 0
}

# 0 は live。owner.json の欠落・破損は有限の grace の間だけ in-flight として守る。
lock_is_live() {
  [[ -d "$LOCK_DIR" ]] || return 1
  if [[ ! -f "$OWNER_FILE" ]]; then
    (( $(date -u +%s) - $(dir_mtime_epoch "$LOCK_DIR") <= LOCK_INFLIGHT_GRACE_SEC ))
    return
  fi
  local heartbeat age
  heartbeat=$(jq -r '.heartbeat // empty' "$OWNER_FILE" 2>/dev/null || echo "")
  if [[ -z "$heartbeat" ]]; then
    (( $(date -u +%s) - $(dir_mtime_epoch "$LOCK_DIR") <= LOCK_INFLIGHT_GRACE_SEC ))
    return
  fi
  age=$(( $(date -u +%s) - $(iso_to_epoch "$heartbeat") ))
  (( age <= LEASE_MIN * 60 ))
}

write_owner() {
  local tmp timestamp generation
  timestamp=$(now_iso)
  generation="$timestamp-$SESSION_ID-$RANDOM"
  tmp=$(mktemp "$LOCK_DIR/owner.json.XXXXXX") || die "mktemp failed"
  jq -n --arg s "$SESSION_ID" --arg h "$HOST" --arg t "$timestamp" --arg g "$generation" \
    '{session_id:$s,host:$h,started_at:$t,heartbeat:$t,generation:$g}' > "$tmp" || { rm -f "$tmp"; die "failed to write owner.json"; }
  mv "$tmp" "$OWNER_FILE"
  OWNER_GENERATION="$generation"
}

acquire_takeover_mutex() {
  if mkdir "$TAKEOVER_MUTEX" 2>/dev/null; then return 0; fi
  local age quarantine
  age=$(( $(date -u +%s) - $(dir_mtime_epoch "$TAKEOVER_MUTEX") ))
  if (( age > TAKEOVER_MUTEX_GRACE_SEC )); then
    quarantine="$LOOP_DIR/loop.lock.takeover.stale.$(date -u +%Y%m%dT%H%M%SZ).$$"
    if mv "$TAKEOVER_MUTEX" "$quarantine" 2>/dev/null; then
      rmdir "$quarantine" 2>/dev/null || rm -rf "$quarantine"
      mkdir "$TAKEOVER_MUTEX" 2>/dev/null && return 0
    fi
  fi
  return 1
}

verify_owner_generation() {
  [[ -f "$OWNER_FILE" ]] || die "no active loop lock at $LOCK_DIR"
  local owner generation
  owner=$(jq -r '.session_id // empty' "$OWNER_FILE" 2>/dev/null || echo "")
  generation=$(jq -r '.generation // empty' "$OWNER_FILE" 2>/dev/null || echo "")
  [[ "$owner" == "$SESSION_ID" ]] || die "loop lock is owned by '$owner', not '$SESSION_ID'"
  [[ -z "$OWNER_GENERATION" || "$generation" == "$OWNER_GENERATION" ]] || die "loop lock generation changed"
  OWNER_GENERATION="$generation"
}

require_owner() {
  require_session_id
  verify_owner_generation
  local tmp
  tmp=$(mktemp "$OWNER_FILE.XXXXXX") || die "mktemp failed"
  jq --arg t "$(now_iso)" '.heartbeat = $t' "$OWNER_FILE" > "$tmp" || { rm -f "$tmp"; die "heartbeat update failed"; }
  mv "$tmp" "$OWNER_FILE"
}

# loop-state.json は常に同一ディレクトリの tmp + mv で更新する。
state_write() {
  local filter="$1"; shift
  verify_owner_generation
  local tmp
  [[ -f "$STATE_FILE" ]] || jq -n '{issues:{},batches:[],leaked:[]}' > "$STATE_FILE"
  tmp=$(mktemp "$STATE_FILE.XXXXXX") || die "mktemp failed"
  if jq "$@" "$filter" "$STATE_FILE" > "$tmp"; then mv "$tmp" "$STATE_FILE"; else rm -f "$tmp"; die "failed to update $STATE_FILE"; fi
}

state_write_soft() {
  local filter="$1"; shift
  local tmp
  [[ -f "$STATE_FILE" ]] || return 1
  tmp=$(mktemp "$STATE_FILE.XXXXXX") || return 1
  if jq "$@" "$filter" "$STATE_FILE" > "$tmp"; then mv "$tmp" "$STATE_FILE"; return 0; fi
  rm -f "$tmp"; return 1
}

record_orphan() {
  local number="$1" reason="$2"
  log warn "issue #$number: $reason"
  state_write_soft '.leaked += [$r]' --arg r "issue #$number: $reason" || true
}

case "$SUBCOMMAND" in
  lock-check)
    if lock_is_live; then log lock "an issue loop is already running"; exit 1; fi
    ;;
  lock-acquire)
    require_session_id
    (( LEASE_MIN >= 10 )) || die "--lease-min must be at least 10"
    mkdir -p "$LOOP_DIR"
    if mkdir "$LOCK_DIR" 2>/dev/null; then write_owner; log lock "acquired ($SESSION_ID)"; exit 0; fi
    if [[ -f "$OWNER_FILE" && "$(jq -r '.session_id // empty' "$OWNER_FILE")" == "$SESSION_ID" ]]; then exit 0; fi
    if lock_is_live; then log lock "another loop is running"; exit 1; fi
    acquire_takeover_mutex || { log lock "another process is taking over"; exit 1; }
    trap 'rmdir "$TAKEOVER_MUTEX" 2>/dev/null || true' EXIT
    if lock_is_live; then exit 1; fi
    if [[ -d "$LOCK_DIR" ]]; then
      mv "$LOCK_DIR" "$LOOP_DIR/loop.lock.stale.$(date -u +%Y%m%dT%H%M%SZ).$SESSION_ID" || die "failed to quarantine stale lock"
    fi
    mkdir "$LOCK_DIR" || die "failed to create lock after takeover"
    write_owner
    ;;
  lock-release)
    require_session_id
    [[ -d "$LOCK_DIR" ]] || exit 0
    acquire_takeover_mutex || die "a takeover is in progress; not releasing"
    trap 'rmdir "$TAKEOVER_MUTEX" 2>/dev/null || true' EXIT
    [[ -f "$OWNER_FILE" ]] || die "lock has no owner.json; not releasing"
    [[ "$(jq -r '.session_id // empty' "$OWNER_FILE")" == "$SESSION_ID" ]] || die "lock belongs to another owner; not releasing"
    rm -rf "$LOCK_DIR"
    ;;
  heartbeat)
    require_owner
    ;;
  init)
    require_owner
    [[ -n "$CONFIG_JSON" && -n "$FILTER_JSON" ]] || die "init requires --config-json and --filter-json"
    jq -e . >/dev/null <<<"$CONFIG_JSON" || die "--config-json is not valid JSON"
    jq -e . >/dev/null <<<"$FILTER_JSON" || die "--filter-json is not valid JSON"
    local_tmp=$(mktemp "$STATE_FILE.XXXXXX") || die "mktemp failed"
    if [[ -f "$STATE_FILE" ]]; then
      jq --argjson c "$CONFIG_JSON" --argjson f "$FILTER_JSON" '.config=$c | .filter=$f | .issues=(.issues // {}) | .batches=(.batches // []) | .leaked=(.leaked // []) | .started_at=(.started_at // (now|todate))' "$STATE_FILE" > "$local_tmp" || { rm -f "$local_tmp"; die "failed to update state"; }
    else
      jq -n --argjson c "$CONFIG_JSON" --argjson f "$FILTER_JSON" --arg t "$(now_iso)" '{started_at:$t,filter:$f,config:$c,issues:{},batches:[],leaked:[]}' > "$local_tmp"
    fi
    mv "$local_tmp" "$STATE_FILE"
    ;;
  fetch)
    require_owner
    command -v gh >/dev/null 2>&1 || die "gh is not installed"
    (( LIMIT > 0 && BATCH > 0 )) || die "fetch requires positive --limit and --batch"
    [[ -f "$STATE_FILE" ]] || die "$STATE_FILE not found; run init first"
    local_search="-label:dispatch/in-progress -label:dispatch/done -label:dispatch/failed"
    gh_assignee_flags=()
    case "$ASSIGNEE" in
      '') ;;
      @me) gh_assignee_flags=(--assignee @me) ;;
      none) local_search="$local_search no:assignee" ;;
      *) gh_assignee_flags=(--assignee "$ASSIGNEE") ;;
    esac
    gh_label_flags=()
    [[ -n "$LABELS" ]] && gh_label_flags=(--label "$LABELS")
    window=$(( LIMIT * 2 )); (( window > MAX_WINDOW )) && window=$MAX_WINDOW
    candidates='[]'
    exhaustion_known=0
    while :; do
      raw=$(gh issue list --state "$ISSUE_STATE" ${gh_label_flags[@]+"${gh_label_flags[@]}"} ${gh_assignee_flags[@]+"${gh_assignee_flags[@]}"} --search "$local_search" --limit "$window" --json number,title,body,url,labels) || die "gh issue list failed"
      returned=$(jq 'length' <<<"$raw")
      candidates=$(jq --slurpfile state <(jq '.issues // {}' "$STATE_FILE") '[.[] | (.number | tostring) as $number | select(($state[0] | has($number)) | not)]' <<<"$raw")
      candidate_count=$(jq 'length' <<<"$candidates")
      if (( returned < window || candidate_count > 0 )); then exhaustion_known=1; break; fi
      (( window >= MAX_WINDOW )) && break
      window=$(( window * 2 )); (( window > MAX_WINDOW )) && window=$MAX_WINDOW
      log fetch "window全除外につき拡張: --limit $window"
    done
    if (( exhaustion_known == 0 )); then
      log warn "取得窓を上限 $MAX_WINDOW まで広げても候補が尽きたと確認できませんでした"
      exit 4
    fi
    if [[ "$(jq 'length' <<<"$candidates")" == 0 ]]; then echo '[]'; exit 0; fi
    if (( DRY_RUN == 1 )); then jq --argjson max "$LIMIT" '.[0:$max]' <<<"$candidates"; exit 0; fi
    tasks='[]'
    candidate_length=$(jq 'length' <<<"$candidates")
    index=0
    while (( index < candidate_length )); do
      [[ "$(jq 'length' <<<"$tasks")" -ge "$LIMIT" ]] && break
      number=$(jq -r ".[$index].number" <<<"$candidates")
      title=$(jq -r ".[$index].title" <<<"$candidates")
      index=$(( index + 1 ))
      if ! gh issue edit "$number" --add-label dispatch/in-progress >/dev/null 2>&1; then
        log warn "issue #$number の claim に失敗したため除外します"
        continue
      fi
      slug=$(make_slug "$number" "$title")
      if ! state_write_soft '.issues[$number] = {slug:$slug,status:"claimed",batch:$batch,claimed_at:$claimed_at}' --arg number "$number" --arg slug "$slug" --argjson batch "$BATCH" --arg claimed_at "$(now_iso)"; then
        gh issue edit "$number" --remove-label dispatch/in-progress >/dev/null 2>&1 || die "issue #$number: state 記録と claim 補償の両方に失敗しました"
        log warn "issue #$number の state 記録に失敗したため claim を取り消しました"
        continue
      fi
      source_index=$(( index - 1 ))
      tasks=$(jq --argjson source "$candidates" --argjson i "$source_index" --arg slug "$slug" '. + [($source[$i] + {slug:$slug})]' <<<"$tasks")
      log claim "issue #$number -> $slug"
    done
    if [[ "$(jq 'length' <<<"$tasks")" == 0 ]]; then log warn "候補はありましたが claim が 1 件も成立しませんでした"; exit 3; fi
    state_write '.batches += [{n:$batch,issues:$issues,started_at:$started_at}]' --argjson batch "$BATCH" --argjson issues "$(jq '[.[].number]' <<<"$tasks")" --arg started_at "$(now_iso)"
    echo "$tasks"
    ;;
  *) die "unknown subcommand: $SUBCOMMAND" ;;
esac
