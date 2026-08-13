#!/usr/bin/env bash
# 最終クリーンアップの pane / workspace close 手順の静的検査。
#
# 守っている不変条件:
#   CL1. close-surface の呼び出しには必ず --workspace が付く
#        (付けないと surface ref が親の $CMUX_WORKSPACE_ID に対して解決され、
#         "Surface ref not found" で必ず失敗する)
#   CL2. workspace_id は status.json だけに依存せず、取れなかったときに
#        cmux workspace list から slug 名で引き直すフォールバックがある
#        (子セッションの status 書き込みは workspace_id を落とすため)
#
# 背景: この 2 つが揃って欠けていたため、ディスパッチ終了後に pane が閉じられず、
# その後 git worktree remove が生きている codex の cwd を消し、codex TUI が
# "failed to refresh skills: ... failed to reload config: No such file or directory"
# を出し続ける事故が起きた。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/SKILL.md"
GUIDE="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/references/guide-ja.md"
fail=0

for f in "$SKILL" "$GUIDE"; do
  [[ -f "$f" ]] || { echo "FAIL: ファイルが見つからない: $f"; exit 2; }
done

# --- CL1: close-surface の呼び出しに --workspace が付く ---
cl1=1
for f in "$SKILL" "$GUIDE"; do
  while IFS= read -r line; do
    # 実際の呼び出し行だけを見る (散文中の言及は --surface を伴わない)
    case "$line" in
      *"close-surface"*"--surface"*)
        case "$line" in
          *"--workspace"*) ;;
          *) echo "  --workspace が無い close-surface: $(basename "$f"): $line"; cl1=0 ;;
        esac
        ;;
    esac
  done < "$f"
done
if [[ $cl1 -eq 1 ]]; then
  echo "PASS CL1: close-surface の呼び出しには必ず --workspace が付く"
else
  echo "FAIL CL1: --workspace の無い close-surface が残っている"; fail=1
fi

# --- CL2: workspace_id のフォールバックがある ---
cl2=1
for f in "$SKILL" "$GUIDE"; do
  if ! grep -q 'workspace list' "$f"; then
    echo "  workspace_id のフォールバックが無い: $(basename "$f")"
    cl2=0
  fi
done
if [[ $cl2 -eq 1 ]]; then
  echo "PASS CL2: workspace_id は status.json 欠落時に cmux workspace list から引き直す"
else
  echo "FAIL CL2: status.json だけに依存している"; fail=1
fi

exit $fail
