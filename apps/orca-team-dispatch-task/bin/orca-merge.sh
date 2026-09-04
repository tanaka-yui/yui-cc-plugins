#!/usr/bin/env bash
# orca-merge.sh — worker の成果を親ブランチへ取り込む。資源は消さない。
# Usage: orca-merge.sh --status-dir <d>
# Exit: 0 = merge 済み (冪等) / 1 = 未 merge / 2 = 使用法エラー
set -uo pipefail

die() { echo "orca-merge: $1" >&2; exit 2; }
log() { echo "orca-merge: $1" >&2; }
need2() { [[ "$2" -ge 2 ]] || die "$1 requires a value"; }

SD=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --status-dir) need2 "$1" "$#"; SD="$2"; shift 2 ;;
    *) die "unknown option: $1" ;;
  esac
done

[[ -n "$SD" ]] || die "--status-dir is required"
[[ -r "$SD/workers.json" && -r "$SD/run.json" ]] || die "cannot read the dispatch state in $SD"

write() {
  local temporary
  temporary=$(mktemp "$SD/.tmp.XXXXXX") || return 1
  printf '%s\n' "$2" > "$temporary" && mv -f "$temporary" "$1" || {
    rm -f "$temporary"
    return 1
  }
}

stop() {
  write "$SD/integration-result.json" "$(jq -nc --arg reason "$1" '{merged:false,reason:$reason}')" || true
  log "$1"
  exit 1
}

value() {
  jq -er "$1 // empty" "$2" 2>/dev/null
}

jq -e '.merged == true' "$SD/integration-result.json" >/dev/null 2>&1 && {
  log "already merged"
  exit 0
}

RR=$(value '.repo_root' "$SD/run.json") || stop "no repository identity recorded"
BR=$(value '.branch' "$SD/workers.json") || stop "no branch identity recorded; refusing to guess"
IB=$(value '.integration_branch' "$SD/workers.json") || stop "no integration branch recorded; refusing to guess"
TID=$(value '.design.task' "$SD/workers.json") || stop "the dispatch identity is incomplete"
DID=$(value '.design.dispatch' "$SD/workers.json") || stop "the dispatch identity is incomplete"

git -C "$RR" rev-parse --is-inside-work-tree >/dev/null 2>&1 || stop "the recorded repository is unavailable"

# 受理の証拠。全て揃わなければ取り込まない。
ST=$(value '.status' "$SD/roles/design/status.json" 2>/dev/null || true)
[[ "$ST" == "done" ]] || stop "the worker status is '${ST:-missing}', not done"
jq -e --arg receipt "worker_done|$TID|$DID|succeeded" \
  'type == "array"
   and all(.[]; type == "string" and (split("|") | length == 4 and .[0] == "worker_done"
      and .[1] != "" and .[2] != "" and (.[3] == "succeeded" or .[3] == "failed")))
   and index($receipt) != null' "$SD/received.json" >/dev/null 2>&1 \
  || stop "no succeeded worker_done was received for this dispatch; run orca-wait.sh first"
[[ -s "$SD/roles/design/result.md" ]] || stop "result.md is missing or empty"

# 取り込み先の identity。start 時と同じ checkout / branch に限定する。
git -C "$RR" show-ref --quiet "refs/heads/$BR" || stop "branch $BR does not exist"
BASE=$(git -C "$RR" symbolic-ref --short HEAD 2>/dev/null) || BASE=""
[[ "$BASE" == "$IB" ]] || stop "the parent checkout is on '${BASE:-detached}', not the '$IB' it started on"
[[ "$BASE" != "$BR" ]] || stop "the parent checkout is on the worker branch itself"
PORCELAIN=$(git -C "$RR" status --porcelain 2>/dev/null) || stop "cannot inspect the parent checkout"
[[ -z "$PORCELAIN" ]] || stop "the parent checkout has uncommitted changes"

if git -C "$RR" merge --no-edit "$BR" >/dev/null 2>&1; then
  write "$SD/integration-result.json" \
    "$(jq -nc --arg branch "$BR" --arg base "$BASE" '{merged:true,branch:$branch,base:$base}')" \
    || { log "merged but cannot persist the result"; exit 1; }
  log "merged $BR into $BASE"
  exit 0
fi

# conflict。worktree と branch は残し、親の未完了 merge だけを戻す。
git -C "$RR" merge --abort >/dev/null 2>&1 || true
stop "merge conflict; the worktree and branch are kept for manual resolution"
