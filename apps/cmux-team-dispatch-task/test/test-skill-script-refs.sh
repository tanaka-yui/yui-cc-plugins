#!/usr/bin/env bash
# SKILL.md が「存在しないスクリプト」を参照していないことの静的検査。
#
# 由来: 削除済みの旧 ensure-agmsg-ready ガードスクリプトを SKILL.md の Step 1g が
# 呼び続けていた事故 (rc 127 → `*)` 分岐 → exit 1 で親の dispatch が起動直後に
# 中止される)。この破綻を検知していた唯一のテスト (削除済み test-agmsg-skill-block.sh
# の AG1) の代替。
#
# 守っている不変条件:
#   SR1. パス付きの参照 (`<SKILL_DIR>/scripts/x.sh` / `<this-skill-dir>/scripts/x.sh`
#        など、agmsg ツリー以外) は skills/*/scripts/ に実在する
#   SR2. 地の文の裸のファイル名 (`verify-agmsg-ready.sh` のようにパスを伴わない言及) も
#        プラグイン配下に実在する。agmsg 等の外部ツリーが持つ名前だけは
#        AGMSG_OWNED で明示的に除外する
#   SR3. AGMSG_OWNED の各エントリは SKILL.md に実際に出現する (allowlist が黙って
#        陳腐化し、いつか同名の自スクリプトを見逃すのを防ぐラチェット)
#
# SR1 と SR2 は補完関係にある。SR1 だけでは
# 「`verify-agmsg-ready.sh` is invoked whenever …」のようなパス無しの言及を見逃し、
# SR2 だけでは `<SKILL_DIR>/scripts/send.sh` のような「実在する名前を誤った場所から
# 呼ぶ」参照を見逃す。片方だけの素朴な実装は空虚に PASS する。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILL="$PLUGIN_DIR/skills/cmux-team-dispatch-task/SKILL.md"
SCRIPTS="$PLUGIN_DIR/skills/cmux-team-dispatch-task/scripts"
fail=0

[[ -r "$SKILL" ]] || { echo "FAIL SR0: SKILL.md が読めない: $SKILL"; exit 1; }

# agmsg (~/.agents/skills/agmsg) が所有するスクリプト名。プラグイン配下には実在しない
# のが正しいので SR2 の対象外にする。
AGMSG_OWNED=(
  send.sh join.sh leave.sh inbox.sh history.sh
  delivery.sh watch.sh codex-record-session.sh
  actas-claim.sh actas-lock.sh
)
is_agmsg_owned() {
  local n="$1" e
  for e in "${AGMSG_OWNED[@]}"; do [[ "$n" == "$e" ]] && return 0; done
  return 1
}

# --- SR1: パス付き参照が skills/*/scripts/ に実在する ---
sr1=1
sr1_seen=0
while IFS= read -r ref; do
  [[ -n "$ref" ]] || continue
  # agmsg ツリーへの参照はこのプラグインの scripts/ ではない
  [[ "$ref" == *"agmsg/scripts/"* ]] && continue
  base="${ref##*/}"
  sr1_seen=$((sr1_seen + 1))
  if [[ ! -f "$SCRIPTS/$base" ]]; then
    echo "  存在しないスクリプトをパス付きで参照している: $ref"
    grep -n -F -- "$base" "$SKILL" | head -3
    sr1=0
  fi
done < <(grep -oE '[A-Za-z0-9_./<>$-]*scripts/[A-Za-z0-9_.-]+\.sh' "$SKILL" | sort -u)
if [[ $sr1_seen -eq 0 ]]; then
  echo "FAIL SR1: パス付き参照が 1 件も抽出できなかった (検査が空虚に PASS している)"
  fail=1
elif [[ $sr1 -eq 1 ]]; then
  echo "PASS SR1: パス付きのスクリプト参照 $sr1_seen 件はすべて実在する"
else
  echo "FAIL SR1: 存在しないスクリプトをパス付きで参照している"; fail=1
fi

# --- SR2: 裸のファイル名もプラグイン配下に実在する ---
sr2=1
sr2_seen=0
while IFS= read -r base; do
  [[ -n "$base" ]] || continue
  is_agmsg_owned "$base" && continue
  sr2_seen=$((sr2_seen + 1))
  if ! find "$PLUGIN_DIR" -name "$base" -type f -print -quit | grep -q .; then
    echo "  存在しないスクリプト名が地の文にある: $base"
    grep -n -F -- "$base" "$SKILL" | head -3
    sr2=0
  fi
done < <(grep -oE '[A-Za-z0-9_.-]+\.sh' "$SKILL" | sort -u)
if [[ $sr2_seen -eq 0 ]]; then
  echo "FAIL SR2: 自プラグインのスクリプト名が 1 件も抽出できなかった (検査が空虚)"
  fail=1
elif [[ $sr2 -eq 1 ]]; then
  echo "PASS SR2: 地の文のスクリプト名 $sr2_seen 件はすべてプラグイン配下に実在する"
else
  echo "FAIL SR2: 存在しないスクリプト名が地の文に残っている"; fail=1
fi

# --- SR3: AGMSG_OWNED のラチェット ---
sr3=1
for e in "${AGMSG_OWNED[@]}"; do
  if ! grep -q -F -- "$e" "$SKILL"; then
    echo "  AGMSG_OWNED の猶予が不要になった (SKILL.md に出現しない): $e"
    sr3=0
  fi
done
if [[ $sr3 -eq 1 ]]; then
  echo "PASS SR3: AGMSG_OWNED の全エントリが SKILL.md に出現する (allowlist は陳腐化していない)"
else
  echo "FAIL SR3: AGMSG_OWNED が陳腐化している"; fail=1
fi

exit $fail
