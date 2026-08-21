#!/usr/bin/env bash
# --message-type 廃止と「agmsg は必須」前提の回帰テスト。
#
# 守っている不変条件:
#   MT1. launch-workspace.sh は --message-type を was removed を含む die で拒否する
#   MT2. prewarm-panes.sh は --message-type を was removed を含む die で拒否する
#   MT3. 両スクリプトのソースに MESSAGE_TYPE 変数が残らない
#   MT4. SKILL.md に AGMSG_INSTALLED による true/false 二系統分岐が残らない
#        (agmsg 不在・readiness 不成立は fail-fast であり、degraded モードは存在しない)
#   MT5. Step 1g の guard が agmsg の存在と自セッションの readiness を確認し、どの経路でも
#        exit 1 で止まる (degraded モードへ降格しない)
#   MT6. Step 1g の guard が親エンジンで分岐し、claude 親は --self、codex 親は
#        --codex --name parent で確認する。rc 1 (不成立) と rc 2 (判定不能) を別の
#        メッセージにする。TEAM の解決が readiness 確認より前にある
#
# MT4/MT5 が対になっているのは、片方だけでは空虚に PASS するため。MT4 だけなら
# 「分岐も guard も無い」(誰も readiness を確認しない) 状態を通してしまい、MT5 だけなら
# 「guard はあるが失敗時に degraded モードへ降格する」二系統を通してしまう。
#
# MT5/MT6 は **Step 1g の節だけ**を切り出して検査する。SKILL.md 全体を数えると、将来
# 無関係な箇所に `exit 1` が 2 件生えただけで空虚に PASS しうる。
# guard の実際の終了コードと理由の文面は test-agmsg-guard-block.sh (GB1-GB6) が
# SKILL.md からブロックを抽出して実行し、動的に検証する。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts"
SKILL="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/SKILL.md"
fail=0

check_rejects() {
  local id="$1" script="$2"
  local out rc
  out=$(bash "$SCRIPTS/$script" --message-type agmsg 2>&1); rc=$?
  if [[ $rc -ne 0 ]] && grep -q 'was removed' <<<"$out"; then
    echo "PASS $id: $script は --message-type を was removed で拒否する"
  else
    echo "FAIL $id: rc=$rc out=[$out]"; fail=1
  fi
}

check_rejects MT1 launch-workspace.sh
check_rejects MT2 prewarm-panes.sh

# --- MT3: MESSAGE_TYPE 変数が残らない ---
mt3=1
for f in launch-workspace.sh prewarm-panes.sh; do
  if grep -q 'MESSAGE_TYPE' "$SCRIPTS/$f"; then
    echo "  MESSAGE_TYPE が残っている: $f"
    grep -n 'MESSAGE_TYPE' "$SCRIPTS/$f" | head -5
    mt3=0
  fi
done
if [[ $mt3 -eq 1 ]]; then
  echo "PASS MT3: 両スクリプトに MESSAGE_TYPE 変数が残らない"
else
  echo "FAIL MT3: MESSAGE_TYPE が残っている"; fail=1
fi

# --- MT4: AGMSG_INSTALLED 二系統分岐が SKILL.md に残らない ---
[[ -r "$SKILL" ]] || { echo "FAIL MT4/MT5: SKILL.md が読めない: $SKILL"; exit 1; }
if grep -q 'AGMSG_INSTALLED' "$SKILL"; then
  echo "FAIL MT4: AGMSG_INSTALLED の二系統分岐が残っている"
  grep -n 'AGMSG_INSTALLED' "$SKILL" | head -5
  fail=1
else
  echo "PASS MT4: SKILL.md に AGMSG_INSTALLED は残らない (agmsg は必須前提)"
fi

# --- Step 1g の節だけを切り出す (MT5 / MT6 のスコープ) ---
STEP1G=$(mktemp)
trap 'rm -f "$STEP1G"' EXIT
awk '
  /^### 1g\. Resolve Delivery/ { section=1 }
  section && /^### 1g-2\./ { exit }
  section { print }
' "$SKILL" > "$STEP1G"
if [[ ! -s "$STEP1G" ]]; then
  echo "FAIL MT5/MT6: Step 1g の節を切り出せなかった (見出しの構造変更?)"; exit 1
fi

# --- MT5: Step 1g が agmsg 必須の fail-fast guard になっている ---
mt5=1
grep -Fq '[[ -f ~/.agents/skills/agmsg/scripts/send.sh ]] ||' "$STEP1G" \
  || { echo "  agmsg 未インストールを検出する guard が無い"; mt5=0; }
# 3 経路 (未インストール / readiness 不成立 / 判定不能) がすべて exit 1 で止まること
exits=$(grep -c 'exit 1' "$STEP1G")
if [[ "$exits" -lt 3 ]]; then
  echo "  Step 1g の exit 1 が $exits 件しかない (未インストール / 不成立 / 判定不能の 3 経路が必要)"
  mt5=0
fi
# degraded モードへ降格する語彙が無いこと
if grep -qE 'typed-only|degraded (delivery|mode) is|fall back to (typed|monitor)' "$STEP1G"; then
  echo "  Step 1g に degraded モードへの降格が残っている"; mt5=0
fi
if [[ $mt5 -eq 1 ]]; then
  echo "PASS MT5: Step 1g は 3 経路すべてを fail-fast で止め、降格経路を持たない"
else
  echo "FAIL MT5: agmsg 必須の fail-fast guard になっていない"; fail=1
fi

# --- MT6: 親エンジンでの分岐 / rc 1 と rc 2 の分離 / TEAM の解決順序 ---
mt6=1
grep -Fq 'bash <SKILL_DIR>/scripts/verify-agmsg-ready.sh --self' "$STEP1G" \
  || { echo "  claude 親用の --self 呼び出しが無い"; mt6=0; }
grep -Fq 'verify-agmsg-ready.sh --codex --team "$TEAM" --name parent' "$STEP1G" \
  || { echo "  codex 親用の --codex --name parent 呼び出しが無い"; mt6=0; }
grep -Fq '[[ -n "${CODEX_THREAD_ID:-}" ]] && PARENT_ENGINE="codex"' "$STEP1G" \
  || { echo "  PARENT_ENGINE の解決が無い"; mt6=0; }
# rc 1 と rc 2 が別分岐で、rc 2 側が usage error と名指ししていること
grep -Fq '1) if [[ "$PARENT_ENGINE" == "codex" ]]; then' "$STEP1G" \
  || { echo "  rc 1 が親エンジンで分岐していない"; mt6=0; }
grep -Fq 'usage error' "$STEP1G" \
  || { echo "  rc 2 を usage error として報告していない"; mt6=0; }
# TEAM の解決が readiness 確認より前にあること (codex 親の分岐は TEAM を必要とする)
team_line=$(grep -n 'TEAM="dispatch-' "$STEP1G" | head -1 | cut -d: -f1)
verify_line=$(grep -n 'verify-agmsg-ready.sh' "$STEP1G" | head -1 | cut -d: -f1)
if [[ -z "$team_line" || -z "$verify_line" ]]; then
  echo "  TEAM の解決行または verify 呼び出し行が見つからない"; mt6=0
elif [[ "$team_line" -ge "$verify_line" ]]; then
  echo "  TEAM の解決 ($team_line 行) が readiness 確認 ($verify_line 行) より後にある"; mt6=0
fi
if [[ $mt6 -eq 1 ]]; then
  echo "PASS MT6: guard は親エンジンで分岐し、rc 1 / rc 2 を分け、TEAM を先に解決する"
else
  echo "FAIL MT6: codex 親のサポートまたは rc の分離が欠けている"; fail=1
fi

exit $fail
