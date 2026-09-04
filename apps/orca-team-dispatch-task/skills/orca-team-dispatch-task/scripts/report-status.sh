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

# --- 終端状態のガード ---
#
# 2026-09-02 の実運用で、完了していないのに done が立つ経路が 2 つ実測された。
#   V1: integration=pr のタスクで、push も PR 作成もせずに done を書いた (issue #79)
#   V2: 委譲を済ませた design ペインが、実装が 1 行も入っていない状態で done を書いた (#78)
# どちらも親が差し戻さなければ、completion-gate が done を見て exec の途中停止を許し、
# 作業が失われていた。
#
# error は決して拒否しない。本当に壊れたときの出口を塞ぐと、子はどこへも行けなくなる。
if [[ "$STATUS" == done ]]; then
  # V2: 委譲済みタスクの terminal status を所有するのは exec であって design ではない。
  if [[ "${DISPATCH_GATE_ROLE:-}" == design && -f "$STATUS_DIR/.deferred" ]]; then
    fail "this task was delegated to the exec role, which owns its terminal status; a design pane must not write done here (use error only when the delegation itself failed)"
  fi
  # V1: PR 統合では PR URL の記録が完了条件である。判定材料は親が書いた integration.json で、
  # 読めないときは発動しない (fail-open)。ガードの誤判定でタスクを永久に終われなくしない。
  _integration=$(jq -r '.integration // empty' "$STATUS_DIR/integration.json" 2>/dev/null || echo "")
  if [[ "$_integration" == pr ]]; then
    _pr=$(jq -r '.pr_url // empty' "$STATUS_DIR/status.json" 2>/dev/null || echo "")
    [[ -n "$_pr" ]] \
      || fail "integration is pr, so recording the PR URL is part of finishing: run record-pr.sh --status-dir $STATUS_DIR first (it verifies the PR exists on the repository this dispatch targets)"
  fi
fi

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
