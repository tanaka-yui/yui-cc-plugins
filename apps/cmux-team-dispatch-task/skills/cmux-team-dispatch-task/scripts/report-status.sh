#!/usr/bin/env bash
set -uo pipefail

# report-status.sh — 子セッションが status.json を終端状態へ遷移させるための入口。
#
# 子に status.json を直接書かせると 2 つの問題が起きる:
#   1. echo で JSON を組むにはクォートが要るが、execute モードの inner prompt は
#      zsh -ic "... '<prompt>' ..." の内側に素で置かれるため ' や " を書けない
#   2. 素朴な echo は launch 時に書かれた workspace_id / surface_id を消してしまう。
#      親のクリーンアップはこの id で pane を閉じるので、消えると閉じられなくなる
#
# このスクリプトは引数にクォートを要求せず、既存フィールドを保存したまま
# status / message / timestamp だけを更新する。
#
# なぜ子が呼ぶ必要があるのか: runner wrapper も exit 時に status を書くが、それは
# セッションが終了したときだけである。codex には自セッションを終わらせる手段が
# 無い (/exit は効かず quit/shutdown サブコマンドも無い) ため、codex は作業後に
# idle 残留する。wrapper の exit 経路だけに頼ると status が executing のまま固まり、
# 親は永久に待つ。
#
# Usage: report-status.sh <status-dir> <done|error> [message words...]
#
# Exit: 0 = 書き込み成功 / 1 = 書き込み失敗 / 2 = 使用法エラー

die() { echo "report-status: $1" >&2; exit 2; }
fail() { echo "report-status: $1" >&2; exit 1; }

STATUS_DIR="${1:-}"
STATUS="${2:-}"
[[ -n "$STATUS_DIR" ]] || die "status directory is required"
[[ -n "$STATUS" ]] || die "status is required (done or error)"
case "$STATUS" in
  done|error) ;;
  *) die "status must be done or error (got: $STATUS)" ;;
esac
shift 2
MESSAGE="$*"

command -v jq >/dev/null 2>&1 || fail "jq is not installed"
mkdir -p "$STATUS_DIR" || fail "cannot create status dir: $STATUS_DIR"

FILE="$STATUS_DIR/status.json"
# 既存ファイルが無ければ空オブジェクトから組む。壊れた JSON も同様に扱う
# (ここで諦めると完了が親に伝わらないため、保存より報告を優先する)。
BASE="{}"
if [[ -f "$FILE" ]] && jq -e . "$FILE" >/dev/null 2>&1; then
  BASE=$(cat "$FILE")
fi

# 一時ファイルは同一ディレクトリの mktemp + mv でアトミックに置き換える。
# 共有名の .tmp は並列書き込みで壊れるため使わない。
TMP=$(mktemp "$FILE.XXXXXX") || fail "mktemp failed"
if printf '%s' "$BASE" | jq --arg s "$STATUS" --arg m "$MESSAGE" \
     '.status = $s | .message = $m | .timestamp = (now | todate)' > "$TMP"; then
  mv "$TMP" "$FILE" || { rm -f "$TMP"; fail "failed to replace $FILE"; }
else
  rm -f "$TMP"
  fail "failed to compose status json"
fi
