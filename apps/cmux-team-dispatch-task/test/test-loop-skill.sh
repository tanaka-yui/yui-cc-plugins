#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; SK="$SCRIPT_DIR/../skills/cmux-team-dispatch-task"
for needle in '--loop' 'references/loop-mode.md' 'issue-fetch.sh' 'render-loop-prompt.sh'; do
  grep -Fq -- "$needle" "$SK/SKILL.md" || { echo "FAIL: $needle"; exit 1; }
done
for needle in 'issue-fetch.sh' 'batch-wait.sh' 'loop-cleanup.sh' 'render-loop-prompt.sh' '--state-file' 'lock-acquire' 'init' 'ALL_TERMINAL' '--timeout-sentinel' '--unattended'; do
  grep -Fq -- "$needle" "$SK/references/loop-mode.md" || { echo "FAIL: $needle"; exit 1; }
done
# concurrency の契約: 既定 5 / 自由入力可 / 上限 10 / 「タスク数であってペイン数ではない」注記。
# 選択肢の並びは AskUserQuestion の先頭が既定になるため、5 が 3 より前にあることまで検査する。
# loop-mode.md は英語ドキュメントのため needle は英語表現。改行をまたぐ表現があるため
# 空白を単一スペースに畳んだ全文に対して照合する(reflow に強くするため)。
loop_mode_flat=$(tr '\n' ' ' < "$SK/references/loop-mode.md" | tr -s ' ')
for needle in 'default is 5' 'freely enter an integer from 1 to 10' 'task count, not a pane count' 'concurrency=5'; do
  grep -Fq -- "$needle" <<<"$loop_mode_flat" || { echo "FAIL: concurrency 契約 ($needle)"; exit 1; }
done
conc_section=$(sed -n '/Parallel execution count per batch/,/^### /p' "$SK/references/loop-mode.md")
first_choice=$(grep -oE '^   - \*\*[0-9]+' <<<"$conc_section" | head -1 | grep -oE '[0-9]+')
[[ "$first_choice" == "5" ]] || { echo "FAIL: concurrency の先頭選択肢が 5 でない (got: ${first_choice:-none})"; exit 1; }
echo 'PASS: concurrency の既定と上限の契約'

verify_dispatch_cleanup_guard() {
  local file="$1" missing=0 line text start
  # prose の inline code も含めて全出現を読む。実行コマンドだけを判定対象にする。
  # .dispatch/ の一括削除には 2 形式ある: 素の `rm -rf .dispatch/` と、プロジェクト
  # config レイヤー (.dispatch/config.json) を残す `find .dispatch ...` の掃き出し。
  # どちらも直前 6 行以内の lock-check と、fenced block 内であること(行頭インデント)
  # を必須にする。
  while IFS=: read -r line text; do
    [[ "$text" =~ ^[[:space:]]*(rm[[:space:]]|find[[:space:]]|\[\[[[:space:]]) ]] || continue
    start=$(( line > 6 ? line - 6 : 1 ))
    sed -n "${start},${line}p" "$file" | grep -q 'lock-check' || missing=$((missing+1))
    [[ "$text" =~ ^[[:space:]] ]] || missing=$((missing+1))
  done < <(grep -nE 'rm -rf \.dispatch/|find \.dispatch ' "$file" || true)
  [[ $missing -eq 0 ]]
}
verify_dispatch_cleanup_guard "$SK/SKILL.md" || { echo 'FAIL: rm -rf .dispatch/ guard'; exit 1; }
verify_dispatch_cleanup_guard "$SK/references/guide-ja.md" \
  || { echo 'FAIL: guide-ja.md の .dispatch/ 一括削除 guard'; exit 1; }
tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT
{ printf 'rm -rf .dispatch/\n'; cat "$SK/SKILL.md"; } > "$tmp"
if verify_dispatch_cleanup_guard "$tmp"; then
  echo 'FAIL: unguarded rm -rf .dispatch/ を検出できない'; exit 1
fi
echo 'PASS: unguarded rm -rf .dispatch/ を検出する'
{ printf 'find .dispatch -mindepth 1 -maxdepth 1 ! -name config.json -exec rm -rf {} +\n'; cat "$SK/SKILL.md"; } > "$tmp"
if verify_dispatch_cleanup_guard "$tmp"; then
  echo 'FAIL: unguarded find .dispatch 掃き出しを検出できない'; exit 1
fi
echo 'PASS: unguarded find .dispatch 掃き出しを検出する'
echo '--- all tests passed ---'
