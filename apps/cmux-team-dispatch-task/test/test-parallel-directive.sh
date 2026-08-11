#!/usr/bin/env bash
# parallel-directive.sh の回帰テスト。
#
# 守っている不変条件:
#   PD1. codex 向けは spawn_agent / wait_agent を指示する
#   PD2. claude 向けは Task サブエージェントを指示し、spawn_agent を含まない
#   PD3. 全 engine × 全 mode で superpowers の逐次規則を上書きしない旨を含む
#   PD4. 全 engine × 全 mode の出力に ' " ` $ ! \ が 1 文字も含まれない
#        (出力は zsh -ic "... '<prompt>' ..." の内側に素で置かれ、エスケープされない)
#   PD5. 全モードでファイル編集を逐次に保つ禁止文を含む
#   PD6. --agents が出力に反映され、2..8 以外はエラー終了する
#   PD7. 不正な --engine / --mode はエラー終了する

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/parallel-directive.sh"
[[ -f "$BIN" ]] || { echo "FAIL: スクリプトが見つからない: $BIN"; exit 2; }

fail=0
ENGINES=(claude codex)
MODES=(plan superpowers execute review)

emit() { bash "$BIN" --engine "$1" --mode "$2" ${3:+--agents "$3"}; }

# --- PD1: codex 向けは spawn_agent / wait_agent ---
o=$(emit codex execute)
if grep -q 'spawn_agent' <<<"$o" && grep -q 'wait_agent' <<<"$o"; then
  echo "PASS PD1: codex 向けは spawn_agent / wait_agent を指示する"
else
  echo "FAIL PD1: [$o]"; fail=1
fi

# --- PD2: claude 向けは Task サブエージェント、spawn_agent を含まない ---
o=$(emit claude execute)
if grep -q 'Task subagents' <<<"$o" && ! grep -q 'spawn_agent' <<<"$o"; then
  echo "PASS PD2: claude 向けは Task サブエージェントを指示し spawn_agent を含まない"
else
  echo "FAIL PD2: [$o]"; fail=1
fi

# --- PD3: superpowers 譲歩文が全 engine × 全 mode に入る ---
pd3=1
for e in "${ENGINES[@]}"; do
  for m in "${MODES[@]}"; do
    o=$(emit "$e" "$m")
    grep -q 'subagent-driven-development' <<<"$o" || { echo "  missing SDD clause: $e/$m"; pd3=0; }
    grep -q 'one-implementer-at-a-time' <<<"$o" || { echo "  missing one-implementer clause: $e/$m"; pd3=0; }
  done
done
if [[ $pd3 -eq 1 ]]; then
  echo "PASS PD3: 全 engine × 全 mode に superpowers 譲歩文が入る"
else
  echo "FAIL PD3: 譲歩文が欠けている組み合わせがある"; fail=1
fi

# --- PD4: 禁止文字が 1 文字も含まれない ---
pd4=1
for e in "${ENGINES[@]}"; do
  for m in "${MODES[@]}"; do
    o=$(emit "$e" "$m")
    if [[ "$o" == *\'* || "$o" == *\"* || "$o" == *\`* || "$o" == *\$* || "$o" == *'!'* || "$o" == *\\* ]]; then
      echo "  forbidden character in: $e/$m"
      pd4=0
    fi
    # 改行を含まない 1 行であること
    if [[ "$(printf '%s' "$o" | wc -l | tr -d ' ')" != "0" ]]; then
      echo "  multi-line output: $e/$m"
      pd4=0
    fi
  done
done
if [[ $pd4 -eq 1 ]]; then
  echo "PASS PD4: 全組み合わせでクォート・展開文字を含まない 1 行出力"
else
  echo "FAIL PD4: 禁止文字または改行が混入している"; fail=1
fi

# --- PD5: ファイル編集を逐次に保つ禁止文 ---
pd5=1
for e in "${ENGINES[@]}"; do
  for m in "${MODES[@]}"; do
    o=$(emit "$e" "$m")
    grep -q 'File edits stay in the parent agent and stay sequential' <<<"$o" || { echo "  missing guardrail: $e/$m"; pd5=0; }
  done
done
if [[ $pd5 -eq 1 ]]; then
  echo "PASS PD5: 全組み合わせでファイル編集の逐次維持を指示する"
else
  echo "FAIL PD5: 逐次維持の禁止文が欠けている組み合わせがある"; fail=1
fi

# --- PD6: --agents の反映と範囲チェック ---
o=$(emit codex execute 5)
bad=0
grep -q 'at most 5 child agents' <<<"$o" || bad=1
bash "$BIN" --engine codex --mode execute --agents 1 >/dev/null 2>&1 && bad=1
bash "$BIN" --engine codex --mode execute --agents 9 >/dev/null 2>&1 && bad=1
bash "$BIN" --engine codex --mode execute --agents abc >/dev/null 2>&1 && bad=1
if [[ $bad -eq 0 ]]; then
  echo "PASS PD6: --agents 5 が反映され 1 / 9 / abc は拒否される"
else
  echo "FAIL PD6: [$o]"; fail=1
fi

# --- PD7: 不正な --engine / --mode ---
bad=0
bash "$BIN" --engine gpt --mode execute >/dev/null 2>&1 && bad=1
bash "$BIN" --engine codex --mode standby >/dev/null 2>&1 && bad=1
bash "$BIN" --engine codex >/dev/null 2>&1 && bad=1
bash "$BIN" --mode execute >/dev/null 2>&1 && bad=1
if [[ $bad -eq 0 ]]; then
  echo "PASS PD7: 不正な engine / mode / 省略を拒否する"
else
  echo "FAIL PD7: 不正な引数が通ってしまった"; fail=1
fi

[[ $fail -eq 0 ]] && echo "--- すべて PASS ---" || echo "--- FAIL あり ---"
exit $fail
