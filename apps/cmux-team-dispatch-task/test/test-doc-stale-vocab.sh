#!/usr/bin/env bash
# 日本語ドキュメントに旧語彙が残っていないことの静的検査。
#
# 由来: v2.0.0 の monitor 専用化で SKILL.md と英語 references は更新されたのに、
# guide-ja.md / README.md / CLAUDE.md の日本語側だけが旧ポーリング記述と削除済み
# スクリプト名を丸ごと抱えたまま取り残された。これを検知していたテストが 1 つも
# 無かったのが根本原因である — `test-delivery-callsites.sh` の CS5 は
# "polling" / "every 5 seconds" のような**英語の語彙**しか走査しない。
#
# **適用範囲は固有名だけで、散文は対象外。** 「親は 5 秒ごとに status.json を
# ポーリングし」のような日本語の散文による旧手順の説明は、この検査では捕まらない。
# 一般語 (「ポーリング」「タイプ入力」「heartbeat」) を needle に入れると、正しい
# 否定文 (「heartbeat は無い」) まで FAIL にして免除マーカーだらけになり、検査が
# 形骸化するためである。捕まえるのは「現行仕様では書きようが無い固有名」に限る。
#
# 守っている不変条件:
#   DS1. 対象の日本語ドキュメントに、退役済みスクリプト名が出現しない
#   DS2. 対象の日本語ドキュメントに、退役済みの固有名 (フラグ・変数・値) が出現しない
#   DS3. DS1 / DS2 のリストが陳腐化していない。RETIRED_SCRIPTS は現行 scripts/ に
#        実在しないこと、RETIRED_VOCAB は現行 scripts/ にヒットしないことを要求する
#        (現役のトークンを needle にすると、正しいドキュメントが書けなくなる)
#
# **免除マーカー**: 履歴を記録する箇所は、その行または直前の 5 行以内に
# `stale-vocab-exempt: <needle>` を置くと、**その needle だけ**除外される。
# needle 非限定にすると、1 個のマーカーが以後 5 行のあらゆる旧語彙を無条件に
# 通してしまう。素朴な実装 (マーカー無しの単純 grep) がなぜ FAIL するかの反例:
#
#   docs/notification-gaps.md の「修正したパターン」表は「いつ何が壊れていて、
#   どう直したか」の履歴である。P9 の行は ensure-agmsg-ready.sh による guard の
#   追加と廃止を記録しており、旧名で grep して経緯へ辿り着けることに価値がある。
#   マーカーの無い素朴な検査はこの正しい履歴記述を FAIL にし、「名前を消す」
#   方向の修正を誘発する (実際に T7 の初版でそれが起きた)。
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

# 退役済みの固有名。日本語・英語が混在するので固定文字列で持つ。
# **現役のトークンを入れてはならない** — DS3 が現行 scripts/ を grep して弾く。
# 例: `--dispatch-dir` は loop-cleanup.sh:10 が、`--label ` は issue-fetch.sh:233 が
# gh へ渡す生きたフラグなので needle にできない。前者は monitor-dispatch.sh を
# DS1 が捕まえるので不要、後者は退役した label 名まで含めて限定する。
RETIRED_VOCAB=(
  'AGMSG_INSTALLED'        # 二系統分岐の変数。現行に存在しない
  'dispatch-monitor'       # 退役した監視ループの label
  '--heartbeat-interval'   # 退役した監視スクリプトのフラグ
  '--outbox-dir'           # 退役した配送スクリプトのフラグ
  '--agmsg-to'             # 同上 (現行は send.sh の位置引数)
  '--to-surface'           # 同上
  '--to-workspace'         # 同上
  '--label phase-'         # 同上。label は本文の接頭辞になった。gh の
  '--label review-'        #   `--label bug` を巻き込まないよう、退役した
  '--label dispatch-'      #   label 名の接頭辞まで含めて限定する
  '--label abort-'         #   (phase-a-task / review-plan / dispatch-notify / abort-reviewer)
  'guard-injected'         # 退役した prewarm.json の watcher 値
  'ready sentinel'         # agmsg 1.2.1 に実在しない (spec の B5)
  'ready.<team>__<agent>'  # 同上
)

MARKER='stale-vocab-exempt:'

# 行番号 $2 のヒットが needle $3 について免除されているか。行そのもの、または直前
# 5 行に `stale-vocab-exempt: ... <needle> ...` があれば免除。表形式の履歴記録では
# 見出しコメントが表全体を覆えるよう CS1 の 3 行より広い窓を取るが、その分だけ
# needle 一致を要求して「1 個のマーカーが以後 5 行を無条件に通す」のを防ぐ。
is_exempt() {
  local file="$1" lineno="$2" needle="$3" from
  from=$(( lineno - 5 )); (( from < 1 )) && from=1
  sed -n "${from},${lineno}p" "$file" | grep -F -- "$MARKER" | grep -qF -- "$needle"
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
        if is_exempt "$abs" "$lineno" "$needle"; then continue; fi
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

# --- DS2: 退役済みの固有名 ---
check_needles "固有名" "${RETIRED_VOCAB[@]}"
ds2=$CHECK_OK; ds2_seen=$CHECK_SEEN
if [[ $ds2 -eq 1 ]]; then
  echo "PASS DS2: 日本語 4 ファイルに退役済みの固有名が残らない (免除込みの出現 $ds2_seen 件)"
else
  echo "FAIL DS2: 日本語ドキュメントに退役済みの固有名が残っている"; fail=1
fi

# --- DS3: 両リストのラチェット ---
# 退役したはずのものが現行 scripts/ に実在する = もう「退役済み」ではない。
# 放置すると、現役のスクリプト / フラグを日本語ドキュメントで説明できなくなる
# (書けないか、免除マーカーで潰して検査を薄めるかの二択を将来の書き手に強いる)。
ds3=1
for name in "${RETIRED_SCRIPTS[@]}"; do
  if [[ -f "$SCRIPTS/$name" ]]; then
    echo "  退役済みリストのスクリプトが実在する: $name — RETIRED_SCRIPTS から外せ"
    ds3=0
  fi
done
for needle in "${RETIRED_VOCAB[@]}"; do
  hits=$(grep -rlF -- "$needle" "$SCRIPTS" 2>/dev/null | head -3 | tr '\n' ' ')
  if [[ -n "$hits" ]]; then
    echo "  退役済みリストの固有名が現行 scripts/ で使われている: [$needle] — $hits"
    echo "    現役トークンを needle にすると正しいドキュメントが書けなくなる。RETIRED_VOCAB から外すか、退役形まで限定せよ"
    ds3=0
  fi
done
if [[ ${#RETIRED_SCRIPTS[@]} -eq 0 || ${#RETIRED_VOCAB[@]} -eq 0 ]]; then
  echo "  リストが空になっている (検査が空虚に PASS する)"
  ds3=0
fi
if [[ $ds3 -eq 1 ]]; then
  echo "PASS DS3: 両リストは陳腐化していない (スクリプト ${#RETIRED_SCRIPTS[@]} 件 / 固有名 ${#RETIRED_VOCAB[@]} 件)"
else
  echo "FAIL DS3: 退役済みリストが陳腐化している"; fail=1
fi

if [[ $fail -eq 0 ]]; then
  echo "--- all passed ---"
else
  echo "--- failures ---"
fi
exit $fail
