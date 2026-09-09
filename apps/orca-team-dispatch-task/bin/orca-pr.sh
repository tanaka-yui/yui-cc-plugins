#!/usr/bin/env bash
# orca-pr.sh — 成果のブランチを push して pull request を作る。
#
# Usage: orca-pr.sh --status-dir <d> --repo <owner/repo> [--issue <N>] [--remote <name>]
# Exit:  0 = PR がある（作った、または既にあった）/ 1 = 作れなかった / 2 = 使用法エラー
#
# ★ **`--repo` は必須である。自分で remote を見に行かない。**spec 12-2 の実測
#   (2026-09-02): 3 つの remote を持つ repository で子が remote を自分で解決し、
#   **personal fork へ push して fork の中に PR を作った。**issue はそこに無いので
#   `Closes #NNN` は効かず、その fork PR が完了の証拠として受理された。
#   呼び出し側が 1 度だけ解決した値を渡す。`gh` にも推測させない。
#
# ★ **merge はしない。**PR を作ったうえで親へ merge すると、レビューされる前に成果が
#   入る。統合はどちらか一方である。

set -uo pipefail
die() { echo "orca-pr: $1" >&2; exit 2; }
log() { echo "orca-pr: $1" >&2; }
need2() { [[ "$2" -ge 2 ]] || die "$1 requires a value"; }

SD="" REPO="" ISSUE="" REMOTE=origin
while [[ $# -gt 0 ]]; do case "$1" in
  --status-dir) need2 "$1" $#; SD="$2";     shift 2 ;;
  --repo)       need2 "$1" $#; REPO="$2";   shift 2 ;;
  --issue)      need2 "$1" $#; ISSUE="$2";  shift 2 ;;
  --remote)     need2 "$1" $#; REMOTE="$2"; shift 2 ;;
  *) die "unknown option: $1" ;; esac; done
[[ -n "$SD" ]] || die "--status-dir is required"
# ★ ここを任意にしない。省略を許すと「たまたま origin が正しい環境」でだけ通り、
#   fork を持つ環境で静かに壊れる。
[[ -n "$REPO" ]] || die "--repo <owner/repo> is required; this never resolves the remote itself"
[[ "$REPO" == */* ]] || die "--repo must be <owner>/<repo>: $REPO"
[[ -z "$ISSUE" || "$ISSUE" =~ ^[0-9]+$ ]] || die "--issue must be a number: $ISSUE"
[[ -r "$SD/workers.json" && -r "$SD/run.json" ]] || die "cannot read the dispatch state in $SD"
command -v gh >/dev/null 2>&1 || die "gh is not installed"

write() {   # $1=path $2=content
  local t
  t=$(mktemp "$SD/.tmp.XXXXXX") || return 1
  printf '%s\n' "$2" > "$t" && mv -f "$t" "$1" || { rm -f "$t"; return 1; }
}
stop() {
  write "$SD/integration-result.json" "$(jq -nc --arg reason "$1" '{merged:false,reason:$reason}')" || true
  log "$1"; exit 1
}

# ★ 既に PR があるなら作り直さない。**同じ成果に 2 つの PR を作らない。**
EXISTING=$(jq -r '.pr_url // empty' "$SD/integration-result.json" 2>/dev/null || echo "")
if [[ -n "$EXISTING" ]]; then
  log "a pull request is already recorded for this dispatch"
  printf '%s\n' "$EXISTING"; exit 0
fi

RR=$(jq -er '.repo_root // empty' "$SD/run.json" 2>/dev/null) || stop "no repository identity recorded"
IR=$(jq -er '.integration_role // empty' "$SD/workers.json" 2>/dev/null) \
  || stop "no integration role recorded; refusing to guess"
BR=$(jq -er --arg r "$IR" '.roles[$r].branch // empty' "$SD/workers.json" 2>/dev/null) \
  || stop "no branch recorded for role '$IR'; refusing to guess"
BASE=$(jq -er '.integration_branch // empty' "$SD/workers.json" 2>/dev/null) \
  || stop "no base branch recorded; refusing to guess"

# 受理の証拠。merge と同じ基準で見る — **成果が無いブランチで PR を作らない。**
ST=$(jq -r '.status // empty' "$SD/roles/$IR/status.json" 2>/dev/null || echo "")
[[ "$ST" == done ]] || stop "the worker status is '${ST:-missing}', not done"
[[ -s "$SD/roles/$IR/result.md" ]] || stop "result.md is missing or empty"
git -C "$RR" show-ref --quiet "refs/heads/$BR" || stop "branch $BR does not exist"
# ★ base と同じ内容なら PR は作れない。空の PR を作って「届いた」と言わない
if git -C "$RR" rev-parse --quiet --verify "refs/heads/$BASE" >/dev/null 2>&1; then
  [[ -n "$(git -C "$RR" rev-list --count "refs/heads/$BASE..refs/heads/$BR" 2>/dev/null | grep -v '^0$')" ]] \
    || stop "branch $BR has no commits that $BASE does not already have"
fi

# push。**失敗したら PR を作らない** — 中身の無い PR は誤解を生むだけである
git -C "$RR" push "$REMOTE" "refs/heads/$BR:refs/heads/$BR" >/dev/null 2>&1 \
  || stop "could not push $BR to $REMOTE; no pull request was created"

TITLE=$(head -1 "$SD/request.md" 2>/dev/null | cut -c1-72)
[[ -n "$TITLE" ]] || TITLE="$BR"
BODY_FILE=$(mktemp) || stop "mktemp failed"
{
  sed -n '1,200p' "$SD/roles/$IR/result.md"
  # ★ **`Closes #N` は issue が同じ repository にあるときだけ効く。**`--repo` を必須に
  #   しているのはこれを効かせるためである。
  [[ -z "$ISSUE" ]] || { printf '\n'; printf 'Closes #%s\n' "$ISSUE"; }
} > "$BODY_FILE"

PRC=0
URL=$(gh pr create --repo "$REPO" --base "$BASE" --head "$BR" \
        --title "$TITLE" --body-file "$BODY_FILE" 2>&1) || PRC=$?
rm -f "$BODY_FILE"
if [[ "$PRC" -ne 0 ]] || [[ "$URL" != http* ]]; then
  log "$URL"
  stop "gh pr create failed for $BR"
fi
write "$SD/integration-result.json" \
  "$(jq -nc --arg u "$URL" --arg b "$BR" --arg base "$BASE" --arg repo "$REPO" \
     '{merged:false, integration:"pr", pr_url:$u, branch:$b, base:$base, repo:$repo}')" \
  || { log "the pull request was created at $URL but the result could not be persisted"; exit 1; }
log "opened $URL"
printf '%s\n' "$URL"
