#!/usr/bin/env bash
# orca-merge.sh — worker の成果を親ブランチへ取り込む。資源は消さない。
# Usage: orca-merge.sh --status-dir <d> [--allow-unreviewed]
# Exit: 0 = merge 済み (冪等) / 1 = 未 merge / 2 = 使用法エラー
set -uo pipefail

die() { echo "orca-merge: $1" >&2; exit 2; }
log() { echo "orca-merge: $1" >&2; }
need2() { [[ "$2" -ge 2 ]] || die "$1 requires a value"; }

SD="" ALLOW_UNREVIEWED=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --status-dir)       need2 "$1" "$#"; SD="$2"; shift 2 ;;
    --allow-unreviewed) ALLOW_UNREVIEWED=1; shift ;;
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

# ★ **PR と決めた dispatch を merge しない。**両方やるとレビュー前に成果が入る。記録が無い
#   （旧版で起動した）dispatch は今までどおり通す。`stop` は integration-result.json を書くので
#   使わない — PR 側の記録を汚さない。
[[ "$(jq -r '.integration // empty' "$SD/workers.json" 2>/dev/null)" != pr ]] || {
  log "this dispatch was started to open a pull request; use orca-pr.sh instead"; exit 1; }

jq -e '.merged == true' "$SD/integration-result.json" >/dev/null 2>&1 && {
  log "already merged"
  exit 0
}

RR=$(value '.repo_root' "$SD/run.json") || stop "no repository identity recorded"
# ★ **取り込む役は記録から引く。既定を置かない。**`// "design"` と書くと、記録を書き
#   損ねた dispatch が黙って design のブランチを取り込む。取り込み先の取り違えは成果の
#   喪失につながるので、他の identity と同じく「無ければ止まる」。
IR=$(value '.integration_role' "$SD/workers.json") || stop "no integration role recorded; refusing to guess"
BR=$(jq -er --arg r "$IR" '.roles[$r].branch // empty' "$SD/workers.json" 2>/dev/null) \
  || stop "no branch identity recorded for role '$IR'; refusing to guess"
IB=$(value '.integration_branch' "$SD/workers.json") || stop "no integration branch recorded; refusing to guess"
TID=$(jq -er --arg r "$IR" '.roles[$r].task // empty' "$SD/workers.json" 2>/dev/null) \
  || stop "the dispatch identity is incomplete for role '$IR'"
DID=$(jq -er --arg r "$IR" '.roles[$r].dispatch // empty' "$SD/workers.json" 2>/dev/null) \
  || stop "the dispatch identity is incomplete for role '$IR'"

git -C "$RR" rev-parse --is-inside-work-tree >/dev/null 2>&1 || stop "the recorded repository is unavailable"

# 受理の証拠。全て揃わなければ取り込まない。
ST=$(value '.status' "$SD/roles/$IR/status.json" 2>/dev/null || true)
[[ "$ST" == "done" ]] || stop "the worker status is '${ST:-missing}', not done"
jq -e --arg receipt "worker_done|$TID|$DID|succeeded" \
  'type == "array"
   and all(.[]; type == "string" and (split("|") | length == 4 and .[0] == "worker_done"
      and .[1] != "" and .[2] != "" and (.[3] == "succeeded" or .[3] == "failed")))
   and index($receipt) != null' "$SD/received.json" >/dev/null 2>&1 \
  || stop "no succeeded worker_done was received for this dispatch; run orca-wait.sh first"
[[ -s "$SD/roles/$IR/result.md" ]] || stop "result.md is missing or empty"

# ★ **レビューを求めておいて verdict が 1 つも無い成果を、黙って取り込まない。**
#   実測 2026-09-12: reviewer の verdict が未配送のまま捨てられ（3 Run 中 2 Run）、
#   無レビューの成果が succeeded のまま取り込み待ちになった。
#   **worker を差し戻して閉じてはならない** — 「round 2 で打ち切り」も「諦めて進む」も
#   spec が認めた離脱経路であり、そこを塞ぐと worker は永久に差し戻される。だから
#   **人の承認を経る離散的な一手であるここ**で閉じ、明示の override だけを通す。
RVS=$(bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/review-state.sh" \
        --status-dir "$SD" --role "$IR" 2>/dev/null) || RVS=none
[[ "$RVS" != unreviewed || "$ALLOW_UNREVIEWED" -eq 1 ]] \
  || stop "a reviewer was started for '$IR' but no delivered verdict exists; read $SD/roles/$IR/result.md and $SD/review, then pass --allow-unreviewed to take it anyway"

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
