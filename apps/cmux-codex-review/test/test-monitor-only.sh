#!/usr/bin/env bash
# monitor 専用化の回帰テスト (静的検査)。
#
# 実行: bash apps/cmux-codex-review/test/test-monitor-only.sh
#
# 守っている不変条件:
#   M1. 両プラグインに bin/cmux-codex-wait が存在しない
#   M2. 両プラグインの .md / bin に cmux-codex-wait への参照が残っていない
#       (このファイル自身が持つ検出用の文字列リテラルは対象外。除外は自ファイル名のみで行う)
#   M3. 両プラグインの commands/*.md に「ターンを閉じて Monitor イベントで起きる」
#       手順がある (agmsg monitor が唯一の完了検知経路であること)
#   M4. 両プラグインの commands/*.md に単発タイマー保険の手順がある
#       (run_in_background の Bash タスク + sleep。--surface による即時 gone 検知を
#        失う代償の受け皿。spec の R1)
#   M5. 並列実行 (spawn_agent) が両プラグインから完全に消えている (否定的不変条件)。
#       codex-parallel-lib.sh が存在せず、commands/** / skills/** / bin/** に
#       並列の契約語彙が 1 つも残っていないこと。かつては 2 コピーの同一性を検査して
#       いたが、機能ごと撤廃したので「同一であること」ではなく「無いこと」を固定する。
#       codex の子エージェントは app-server daemon 上の別スレッドで走りペインに映らず、
#       「動いているのか止まっているのか」を判別できなくするため再導入を禁じる
#   M6. 両プラグインの commands/** / skills/** / bin/** に旧ポーリング watcher の
#       契約語彙が残っていない (否定的不変条件)。M2 は具体名 1 つしか grep しないため、
#       自己矛盾した記述が 7 コミットと承認済みレビューを通過した (F5)
#   M7. 完了通知の照合が `DONE <token>:` 形式で、裸の token を grep していないこと
#       (token は surface 番号由来で `codex-review-4` は `codex-review-40` の前方一致に
#        なる。裸の照合は進行中を完了と誤報告する = 見逃しより悪い誤答)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
REVIEW="$ROOT/apps/cmux-codex-review"
EXEC="$ROOT/apps/cmux-codex-exec"
fail=0

# --- M1: bin/cmux-codex-wait が存在しない ---
if [[ ! -e "$REVIEW/bin/cmux-codex-wait" && ! -e "$EXEC/bin/cmux-codex-wait" ]]; then
  echo "PASS M1: bin/cmux-codex-wait は両プラグインから削除済み"
else
  echo "FAIL M1: cmux-codex-wait が残っている"
  fail=1
fi

# --- M2: cmux-codex-wait への参照が残っていない ---
# このスクリプト自身は検出用の文字列リテラルとして "cmux-codex-wait" を含むため、
# 自ファイル名だけを --exclude で除外する (プロダクト/ドキュメントへの検査は厳格に保つ)。
# grep の exit status 2 以上 (読めない等) も FAIL にして fail-open させない
SELF_NAME="$(basename "${BASH_SOURCE[0]}")"
hits=$(grep -rl --exclude="$SELF_NAME" "cmux-codex-wait" "$REVIEW" "$EXEC" 2>/dev/null); rc=$?
if [[ $rc -ge 2 ]]; then
  echo "FAIL M2: grep が status=$rc を返した (検査不能)"
  fail=1
elif [[ -z "$hits" ]]; then
  echo "PASS M2: cmux-codex-wait への参照なし"
else
  echo "FAIL M2: 参照が残っている:"
  while IFS= read -r hit_f; do printf '  %s\n' "$hit_f"; done <<< "$hits"
  fail=1
fi

# --- M3: Monitor push で起きる手順がある ---
for f in "$REVIEW/commands/codex-review.md" "$EXEC/commands/codex-exec.md"; do
  if grep -q "end the turn" "$f" && grep -qi "monitor" "$f"; then
    echo "PASS M3: $(basename "$f") に Monitor push で起きる手順がある"
  else
    echo "FAIL M3: $(basename "$f") に Monitor push の手順が無い"
    fail=1
  fi
done

# --- M4: 単発タイマー保険の手順がある ---
for f in "$REVIEW/commands/codex-review.md" "$EXEC/commands/codex-exec.md"; do
  if grep -q "run_in_background" "$f" && grep -qE 'sleep [0-9$]' "$f"; then
    echo "PASS M4: $(basename "$f") にタイマー保険の手順がある"
  else
    echo "FAIL M4: $(basename "$f") にタイマー保険の手順が無い"
    fail=1
  fi
done

# --- M5: 並列実行が両プラグインから完全に消えている ---
m5=1
for plugin in "$REVIEW" "$EXEC"; do
  if [[ -e "$plugin/bin/codex-parallel-lib.sh" ]]; then
    echo "  codex-parallel-lib.sh が残っている: $plugin"
    m5=0
  fi
  for word in spawn_agent wait_agent build_parallel_directive list_codex_agent_types \
              '--no-parallel を注入' 'PARALLEL EXECUTION'; do
    hits=$(grep -rl -- "$word" "$plugin/commands" "$plugin/skills" "$plugin/bin" 2>/dev/null || true)
    if [[ -n "$hits" ]]; then
      echo "  並列の契約語彙 [$word] が残っている: $hits"
      m5=0
    fi
  done
done
if [[ $m5 -eq 1 ]]; then
  echo "PASS M5: 並列実行 (spawn_agent) が両プラグインから消えている"
else
  echo "FAIL M5: 並列実行の痕跡が残っている"
  fail=1
fi

# --- M6: 旧契約の語彙が残っていない (否定的不変条件。I4 / F5) ---
# 検査対象は commands/** / skills/** / bin/** のみ。test/ を含めないので、
# このスクリプト自身が持つ検出用の文字列リテラルは走査されない。
STALE_TERMS=(
  "short-lived watcher"
  "watcher's wait target"
  "status=done"
  "status=gone"
  "status=timeout"
  "--timeout"
  "--interval"
  "--liveness-interval"
)
m6_fail=0
for d in "$REVIEW" "$EXEC"; do
  for sub in commands skills bin; do
    [[ -d "$d/$sub" ]] || continue
    for t in "${STALE_TERMS[@]}"; do
      # grep の exit status 2 以上 (読めない等) も FAIL にして fail-open させない
      h=$(grep -rn -F -e "$t" "$d/$sub" 2>/dev/null); rc=$?
      if [[ $rc -ge 2 ]]; then
        echo "FAIL M6: grep が status=$rc を返した (検査不能): $d/$sub [$t]"
        m6_fail=1
      elif [[ -n "$h" ]]; then
        echo "FAIL M6: 旧契約の語彙 [$t] が残っている:"
        while IFS= read -r line; do printf '  %s\n' "$line"; done <<< "$h"
        m6_fail=1
      fi
    done
  done
done
if [[ $m6_fail -eq 0 ]]; then
  echo "PASS M6: 旧ポーリング watcher の契約語彙は 2 プラグインの commands/skills/bin に残っていない"
else
  fail=1
fi

# --- M7: 完了通知の照合が DONE <token>: 形式であること ---
for f in "$REVIEW/commands/codex-review.md" "$EXEC/commands/codex-exec.md"; do
  base=$(basename "$f")
  if grep -qF 'grep -F "DONE <token>:"' "$f" && ! grep -qF 'grep -F "<token>"' "$f"; then
    echo "PASS M7: $base は DONE <token>: で照合し裸の token を grep していない"
  else
    echo "FAIL M7: $base の token 照合が裸のまま (進行中を完了と誤報告する)"
    fail=1
  fi
done

if [[ $fail -eq 0 ]]; then
  echo "--- all passed ---"
else
  echo "--- failures ---"
fi
exit $fail
