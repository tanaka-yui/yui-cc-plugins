#!/usr/bin/env bash
set -uo pipefail

# report-status.sh — 子セッションが status.json を終端状態へ遷移させるための入口。
#
# Stage 1 は 1 worker の done/error だけを記録する。PR・追加ロール・cmux の状態は扱わない。
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

# V3: result.md が無くても done は通す。書けない事情 (sandbox / ディスク) で完了不能に
# したくないためで、代わりに親が検知できる痕跡を残す。2026-09-02 には「result.md written」
# と報告しながら実ファイルが無いケースが 3 件あった。
RESULT_MISSING=false
if [[ "$STATUS" == done && ! -s "$STATUS_DIR/result.md" ]]; then
  RESULT_MISSING=true
  echo "report-status: warning: $STATUS_DIR/result.md is missing or empty; recording result_missing" >&2
fi

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
     --argjson rm "$RESULT_MISSING" \
     '.status = $s | .message = $m | .timestamp = (now | todate)
      | if $rm then .result_missing = true else del(.result_missing) end' > "$TMP"; then
  mv "$TMP" "$FILE" || { rm -f "$TMP"; fail "failed to replace $FILE"; }
else
  rm -f "$TMP"
  fail "failed to compose status json"
fi
