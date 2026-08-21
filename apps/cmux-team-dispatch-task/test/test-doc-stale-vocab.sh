#!/usr/bin/env bash
# 日本語ドキュメントに旧語彙が残っていないことの静的検査。
#
# 由来: v1.21.0 の monitor 専用化で SKILL.md と英語 references は更新されたのに、
# guide-ja.md / README.md / CLAUDE.md の日本語側だけが旧ポーリング記述と削除済み
# スクリプト名を丸ごと抱えたまま取り残された。これを検知していたテストが 1 つも
# 無かったのが根本原因である — `test-delivery-callsites.sh` の CS5 は
# "polling" / "every 5 seconds" のような**英語の語彙**しか走査しない。
#
# 守っている不変条件:
#   DS1. 対象の日本語ドキュメントに、退役済みスクリプト名が出現しない
#   DS2. 対象の日本語ドキュメントに、退役済みの語彙が出現しない
#   DS3. DS1 / DS2 のリストが陳腐化していない (退役済みのはずのスクリプトが
#        復活していたら、リストから外せと言う)
#
# **免除マーカー**: 履歴を記録する箇所は、その行または直前の 5 行以内に
# `stale-vocab-exempt:` を含む行を置くと除外される。素朴な実装 (マーカー無しの
# 単純 grep) がなぜ FAIL するかの反例:
#
#   docs/notification-gaps.md の「修正したパターン」表は「いつ何が壊れていて、
#   どう直したか」の履歴である。P9 の行は `ensure-agmsg-ready.sh` による guard
#   追加とその廃止を記録しており、この名前が出るのは**意図**である。マーカーの
#   無い素朴な検査はこの正しい履歴記述を FAIL にし、「履歴を消す」方向の修正を
#   誘発してしまう。同じことは CLAUDE.md の「退役候補」節にも起きる。
#
# したがって「名前が 1 つも出ない」ではなく「マーカーで明示していない箇所に
# 出ない」を不変条件にしている。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SCRIPTS="$PLUGIN_DIR/skills/cmux-team-dispatch-task/scripts"
fail=0

# 対象は日本語で書かれた 4 ファイル。英語側 (SKILL.md / references/*.md) は
# test-delivery-callsites.sh の CS3 / CS5 と test-skill-script-refs.sh が見る。
TARGETS=(
  "skills/cmux-team-dispatch-task/references/guide-ja.md"
  "README.md"
  "CLAUDE.md"
  "docs/notification-gaps.md"
)

# 退役済みスクリプト名 (このプラグイン配下に実在しないことが正しい)。
RETIRED_SCRIPTS=(
  send-prompt.sh
  agmsg-path.sh
  monitor-dispatch.sh
  ensure-agmsg-ready.sh
  batch-wait.sh
)

# 退役済みの語彙。日本語・英語が混在するので固定文字列で持つ。
# 否定文（「heartbeat は無い」等）でも正当に登場しうる一般語は入れない — 入れると
# 正しい記述を FAIL にしてしまい、免除マーカーだらけになって検査が形骸化する。
# ここに置くのは「現行仕様では書きようが無い」固有名だけ。
RETIRED_VOCAB=(
  'AGMSG_INSTALLED'        # 二系統分岐の変数。現行に存在しない
  'dispatch-monitor'       # 退役した監視ループの label
  '--heartbeat-interval'   # 退役した監視スクリプトのフラグ
  '--dispatch-dir'         # 同上
  '--outbox-dir'           # 退役した配送スクリプトのフラグ
  '--agmsg-to'             # 同上 (現行は send.sh の位置引数)
  '--to-surface'           # 同上
  '--to-workspace'         # 同上
  '--label '               # 同上 (label は本文の接頭辞になった)
  'guard-injected'         # 退役した prewarm.json の watcher 値
  'ready sentinel'         # agmsg 1.2.1 に実在しない (spec の B5)
  'ready.<team>__<agent>'  # 同上
)

MARKER='stale-vocab-exempt:'

# 行番号 $2 のヒットが免除されているか。行そのもの、または直前 5 行にマーカーが
# あれば免除。表形式の履歴記録では見出しコメントが表全体を覆えるようにしたいので、
# CS1 の 3 行より広めの窓を取る。
is_exempt() {
  local file="$1" lineno="$2" from
  from=$(( lineno - 5 )); (( from < 1 )) && from=1
  sed -n "${from},${lineno}p" "$file" | grep -qF -- "$MARKER"
}

# 結果はグローバルへ返す (コマンド置換で受けると、見つけた違反の出力まで
# 戻り値に混ざって数値比較が壊れる)。
CHECK_OK=1
CHECK_SEEN=0
check_needles() {
  local label="$1"; shift
  local -a needles=("$@")
  local ok=1 seen=0 rel abs needle lineno line
  for rel in "${TARGETS[@]}"; do
    abs="$PLUGIN_DIR/$rel"
    if [[ ! -r "$abs" ]]; then
      echo "  対象ファイルが読めない: $rel"
      ok=0; continue
    fi
    for needle in "${needles[@]}"; do
      while IFS=: read -r lineno line; do
        [[ -n "$lineno" ]] || continue
        seen=$(( seen + 1 ))
        if is_exempt "$abs" "$lineno"; then continue; fi
        echo "  旧$label が残っている: $rel:$lineno  [$needle]"
        echo "    ${line:0:120}"
        ok=0
      done < <(grep -nF -- "$needle" "$abs" 2>/dev/null)
    done
  done
  CHECK_OK=$ok
  CHECK_SEEN=$seen
}

# --- DS1: 退役済みスクリプト名 ---
check_needles "スクリプト名" "${RETIRED_SCRIPTS[@]}"
ds1=$CHECK_OK; ds1_seen=$CHECK_SEEN
if [[ $ds1 -eq 1 ]]; then
  echo "PASS DS1: 日本語 4 ファイルに退役済みスクリプト名が残らない (免除込みの出現 $ds1_seen 件)"
else
  echo "FAIL DS1: 日本語ドキュメントに退役済みスクリプト名が残っている"; fail=1
fi

# --- DS2: 退役済みの語彙 ---
check_needles "語彙" "${RETIRED_VOCAB[@]}"
ds2=$CHECK_OK; ds2_seen=$CHECK_SEEN
if [[ $ds2 -eq 1 ]]; then
  echo "PASS DS2: 日本語 4 ファイルに退役済みの語彙が残らない (免除込みの出現 $ds2_seen 件)"
else
  echo "FAIL DS2: 日本語ドキュメントに退役済みの語彙が残っている"; fail=1
fi

# --- DS3: リストのラチェット ---
# RETIRED_SCRIPTS のスクリプトが復活したら、それはもう「退役済み」ではないので
# リストから外す必要がある。放置すると、復活した現行スクリプトを日本語ドキュメントで
# 説明できなくなる。
ds3=1
for name in "${RETIRED_SCRIPTS[@]}"; do
  if [[ -f "$SCRIPTS/$name" ]]; then
    echo "  退役済みリストのスクリプトが実在する: $name — RETIRED_SCRIPTS から外せ"
    ds3=0
  fi
done
if [[ ${#RETIRED_SCRIPTS[@]} -eq 0 || ${#RETIRED_VOCAB[@]} -eq 0 ]]; then
  echo "  リストが空になっている (検査が空虚に PASS する)"
  ds3=0
fi
if [[ $ds3 -eq 1 ]]; then
  echo "PASS DS3: 退役済みリストは陳腐化していない"
else
  echo "FAIL DS3: 退役済みリストが陳腐化している"; fail=1
fi

if [[ $fail -eq 0 ]]; then
  echo "--- all passed ---"
else
  echo "--- failures ---"
fi
exit $fail
