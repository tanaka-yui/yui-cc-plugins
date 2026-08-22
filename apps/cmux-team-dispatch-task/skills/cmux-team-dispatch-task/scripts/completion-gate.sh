#!/usr/bin/env bash
# completion-gate.sh — Stop hook から呼ばれ、子セッションが仕事の途中で止まろうとして
# いるかを判定する。止まろうとしているなら block して継続させる。
#
# 判定は **ディスクだけ** を読む。モデル評価もネットワークも cmux も使わない。dispatch の
# 完了条件は既に status.json / .deferred / review ファイルとして materialize されており、
# 「待って良い状態」もそこから確定できるので、会話からの推測に賭ける理由が無い。
# (spec 2026-08-22-dispatch-completion-gate-design.md の §3-4)
#
# 出力キーを decision / reason に限るのは codex の hook 出力スキーマが
# additionalProperties: false で、Stop の許可キーが continue / decision / reason /
# stopReason / suppressOutput / systemMessage の 6 つしか無いためである。未知キーを 1 つ
# 出すと毎ターン parse error になる (security-guidance が metrics を出して拒否されている
# のと同じ失敗)。
#
# reason はログではなく **次ターンへのガイダンス** として届き、モデルがそれに従うことを
# 2026-08-22 に両 engine で実測済み (spec §6 の G-T1 / G-T2)。何をすべきかを書くこと。
#
# Usage:
#   completion-gate.sh --status-dir <dir> --role <design|design_review|exec|exec_review> --agent <name>
#
# Output: block したいときだけ {"decision":"block","reason":"..."} を stdout へ
# Exit:   0 = 判定完了 (block の有無は stdout で表す) / 2 = 使用法エラー
#
# 使用法エラーで stdout へ何も出さないのは意図的である。壊れた JSON を hook へ返すと
# engine 側が毎ターン parse error を報告し、本来の停止理由が見えなくなる。
set -uo pipefail

die() { echo "completion-gate: $1" >&2; exit 2; }

STATUS_DIR=""; ROLE=""; AGENT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --status-dir) [[ $# -ge 2 ]] || die "--status-dir requires a value"; STATUS_DIR="$2"; shift 2 ;;
    --role)       [[ $# -ge 2 ]] || die "--role requires a value";       ROLE="$2";       shift 2 ;;
    --agent)      [[ $# -ge 2 ]] || die "--agent requires a value";      AGENT="$2";      shift 2 ;;
    *)            die "unknown argument: $1" ;;
  esac
done
[[ -n "$STATUS_DIR" ]] || die "--status-dir is required"
[[ -n "$AGENT" ]] || die "--agent is required"
case "$ROLE" in
  design|design_review|exec|exec_review) ;;
  *) die "--role must be design, design_review, exec or exec_review" ;;
esac

# 停止を許す。stdout へ何も出さない。
allow() { exit 0; }

# 継続させる。
block() {
  jq -nc --arg r "$1" '{decision:"block",reason:$r}'
  exit 0
}

# 1. 仕事が終わっている
if [[ -f "$STATUS_DIR/status.json" ]]; then
  st=$(jq -r '.status // empty' "$STATUS_DIR/status.json" 2>/dev/null || echo "")
  case "$st" in done|error) allow ;; esac
fi

# 2. design は Phase B を委譲した時点で終わり
if [[ "$ROLE" == design && -f "$STATUS_DIR/.deferred" ]]; then
  allow
fi

# 最新の review ラウンドファイル。名前は design-round-N.md / code-round-N.md など複数あるので
# glob で拾い、名前順の最後を取る (N が増える命名なので順序が意味を持つ)。
latest_round() {
  local f last=""
  shopt -s nullglob
  for f in "$STATUS_DIR"/review/*round*.md; do last="$f"; done
  [[ -n "$last" ]] && printf '%s' "$last"
}
ROUND_FILE=$(latest_round)

case "$ROLE" in
  design|exec)
    # 3. タスク未着。待つのが正しい状態。
    [[ -f "$STATUS_DIR/.assigned-$AGENT" ]] || allow
    # 5. verdict 待ち。相手が書くまで待つのが正しい状態。
    if [[ -n "$ROUND_FILE" ]] && ! grep -q '^VERDICT:' "$ROUND_FILE" 2>/dev/null; then
      allow
    fi
    ;;
  design_review|exec_review)
    # 4. 依頼未着。レビューペインは .assigned を使わないので round ファイルの有無で判定する
    #    (launch-workspace.sh の所有権判定が .assigned-* を見ており、レビュアーがそれを作ると
    #     foreign assignment と誤認されて status 書き込みが抑止される)。
    [[ -n "$ROUND_FILE" ]] || allow
    # 6. VERDICT を書き終えていない = 自分の仕事が途中。依頼側 (判定 5) とは逆の判定になる。
    if ! grep -q '^VERDICT:' "$ROUND_FILE" 2>/dev/null; then
      block "review round file $ROUND_FILE has no VERDICT line yet. Finish the review, write VERDICT: approve or VERDICT: needs_work as its last line, then send the review-verdict: message."
    fi
    allow
    ;;
esac

# 7. 作業の途中で止まろうとしている
block "the task is not finished: status.json has no terminal status yet. Continue the work, then write status.json and send the dispatch-notify: message."
