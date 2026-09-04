#!/usr/bin/env bash
# record-pr.sh — PR が正しいリポジトリに実在することを確認してから pr_url を記録する。
#
# 子に URL を自己申告させない。2026-09-02 の実運用では、実装とレビューを終えた子が push も
# gh pr create もせずに done を書き (F2)、別の子は remote が 3 つある環境で個人フォークへ
# PR を作った (F3)。どちらも「PR を作った」という申告だけは正しく見えていた。
#
# 検索先は integration.json (親が dispatch 時に書く) の repo と head であり、子が選べない。
#
# Usage: record-pr.sh --status-dir <dir>
#
# Exit: 0 = 記録した (または integration=merge で対象外) / 1 = PR 不在・gh 失敗・書き込み失敗
#       / 2 = 使用法エラー
set -uo pipefail

die() { echo "record-pr: $1" >&2; exit 2; }
fail() { echo "record-pr: $1" >&2; exit 1; }

STATUS_DIR=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --status-dir) [[ $# -ge 2 ]] || die '--status-dir requires a value'; STATUS_DIR="$2"; shift 2 ;;
    *) die "unknown option: $1" ;;
  esac
done
[[ -n "$STATUS_DIR" && -d "$STATUS_DIR" && ! -L "$STATUS_DIR" ]] \
  || die 'status-dir must be an existing non-symlink directory'
command -v jq >/dev/null 2>&1 || fail 'jq is not installed'

CONFIG="$STATUS_DIR/integration.json"
[[ -f "$CONFIG" && ! -L "$CONFIG" ]] || die "integration.json not found at $CONFIG"
INTEGRATION=$(jq -r '.integration // empty' "$CONFIG" 2>/dev/null) \
  || die 'integration.json is not valid JSON'
case "$INTEGRATION" in
  merge) exit 0 ;;
  pr) ;;
  *) die "integration.json has an unknown integration: ${INTEGRATION:-<empty>}" ;;
esac

REPO=$(jq -r '.repo // empty' "$CONFIG")
HEAD=$(jq -r '.head // empty' "$CONFIG")
[[ -n "$REPO" && -n "$HEAD" ]] || die 'integration.json is missing repo or head'
command -v gh >/dev/null 2>&1 || fail 'gh is not installed'

# --repo を必ず付ける。付けないと gh は現在のディレクトリの remote 設定から推測し、
# fork 側に作られた PR を拾う (2026-09-02 の F3 がまさにその形で成立した)。
# --state open も必須: 無いと closed/abandoned な旧 PR が .[0] として拾われ、loop の
# retry が同じ branch 名を再利用したときに「PR 実在」を偽装してしまう。
GH_STDERR=$(mktemp) || fail 'mktemp failed for gh stderr capture'
URL=$(gh pr list --repo "$REPO" --head "$HEAD" --state open --json url,state \
  --jq '.[0].url // empty' 2>"$GH_STDERR")
GH_RC=$?
GH_ERR_TEXT=$(cat "$GH_STDERR" 2>/dev/null)
rm -f "$GH_STDERR"
[[ $GH_RC -eq 0 ]] \
  || fail "gh pr list failed for $REPO ($HEAD): ${GH_ERR_TEXT:-<no stderr output>}"
[[ -n "$URL" ]] \
  || fail "no open pull request for $HEAD on $REPO; push the branch to origin and create the PR with --repo $REPO before recording it"

FILE="$STATUS_DIR/status.json"
BASE='{}'
if [[ -f "$FILE" ]] && jq -e . "$FILE" >/dev/null 2>&1; then
  BASE=$(cat "$FILE")
fi
TMP=$(mktemp "$FILE.XXXXXX") || fail 'mktemp failed'
if printf '%s' "$BASE" | jq --arg u "$URL" '.pr_url = $u' > "$TMP"; then
  mv -- "$TMP" "$FILE" || { rm -f "$TMP"; fail "failed to replace $FILE"; }
else
  rm -f "$TMP"; fail 'failed to compose status json'
fi
echo "record-pr: recorded $URL" >&2
