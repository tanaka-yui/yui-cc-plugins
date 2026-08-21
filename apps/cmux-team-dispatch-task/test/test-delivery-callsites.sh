#!/usr/bin/env bash
# 配送経路が agmsg send.sh の 1 呼び出しに一本化されていることの静的検査。
#
# 守っている不変条件:
#   CS1. launch-workspace.sh / prewarm-panes.sh / parallel-directive.sh /
#        render-loop-prompt.sh に配送目的の cmux send / cmux send-key が残らない
#        (シェルコマンドの打鍵だけは免除マーカーで明示的に除外する)
#   CS2. launch-workspace.sh が agmsg send.sh を「呼んでいる」
#        (パスを変数に代入しただけの空虚な PASS を許さない)
#   CS3. SKILL.md と references 配下の全 .md の指示文に配送目的の cmux send /
#        cmux send-key が残らない (訳や無人ループ用ブロックが原文から遅れて旧文面を
#        残す事故を防ぐ)
#   CS4. 削除済みスクリプト (send-prompt.sh / agmsg-path.sh) への参照が
#        スクリプト・文書のどこにも残らない。後続タスクが担当する箇所だけを
#        PENDING 表で明示的に猶予し、件数まで固定する
#
# 免除の仕組み:
#   `cmux send` はシェルにコマンドを打ち込む用途（TUI へのメッセージ配送ではない）でも
#   使うため、その出現の直前 3 行以内（ドキュメントは同一行または直前行）に
#   `send-prompt-exempt:` を含むコメントを置いたときだけ検査対象から外す。
#   行番号でのハードコードを避け、新しい出現は必ずレビューを通す形にしている。
#   ただし CS1 はコメント行を無条件で除外するため、コメント中のマーカーは現状 inert な意図の記録である。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SCRIPTS="$PLUGIN_DIR/skills/cmux-team-dispatch-task/scripts"
SKILL_DIR="$PLUGIN_DIR/skills/cmux-team-dispatch-task"
fail=0

# cmux バイナリを直接叩く送信呼び出し (send / send-key) を列挙する。
# 末尾の `([^-a-zA-Z]|$)` は `send-prompt.sh` のような別コマンドを除外しつつ、
# 行末や backtick で終わる `cmux send` (Enter を伴わない一方通行の配送指示) も拾う。
DIRECT_SEND_RE='(\$\{?CMUX[A-Z_]*\}?"?|\bcmux) (send|send-key)([^-a-zA-Z]|$)'

# --- CS1: スクリプトに cmux send / send-key の直書きが残らない ---
cs1=1
for f in launch-workspace.sh prewarm-panes.sh parallel-directive.sh render-loop-prompt.sh; do
  if [[ ! -f "$SCRIPTS/$f" || ! -r "$SCRIPTS/$f" ]]; then
    echo "  検査対象が読めない: $f"; cs1=0; continue
  fi
  matches=$(grep -nE "$DIRECT_SEND_RE" "$SCRIPTS/$f")
  rc=$?
  if [[ $rc -ge 2 ]]; then
    echo "  検査対象の grep が失敗した: $f (status $rc)"; cs1=0; continue
  fi
  while IFS=: read -r line text; do
    [[ -n "$line" ]] || continue
    # コメント行は指示文ではないので対象外
    [[ "$text" =~ ^[[:space:]]*# ]] && continue
    start=$(( line > 3 ? line - 3 : 1 ))
    if [[ $line -gt 1 ]] && sed -n "${start},$((line - 1))p" "$SCRIPTS/$f" | grep -q 'send-prompt-exempt:'; then
      continue
    fi
    echo "  cmux send / send-key の直書きが残っている: $f:$line"
    cs1=0
  done <<<"$matches"
done
if [[ $cs1 -eq 1 ]]; then
  echo "PASS CS1: スクリプトに配送目的の cmux send / send-key が残らない"
else
  echo "FAIL CS1: 配送目的の cmux send / send-key が残っている"; fail=1
fi

# --- CS2: launch-workspace.sh が agmsg send.sh を呼んでいる ---
# パスの代入だけでは足りない。runner wrapper が実際に実行していることを確かめる
# (代入だけを見る検査は「変数はあるが誰も呼ばない」実装で空虚に PASS する)。
cs2=1
if ! grep -q 'AGMSG_SEND="\${AGMSG_SEND:-\$HOME/\.agents/skills/agmsg/scripts/send\.sh}"' "$SCRIPTS/launch-workspace.sh"; then
  echo "  agmsg send.sh の既定パス解決が無い: launch-workspace.sh"; cs2=0
fi
if ! grep -qE 'bash "\\\$AGMSG_SEND"' "$SCRIPTS/launch-workspace.sh"; then
  echo "  runner wrapper が AGMSG_SEND を実行していない: launch-workspace.sh"; cs2=0
fi
if [[ $cs2 -eq 1 ]]; then
  echo "PASS CS2: launch-workspace.sh が agmsg send.sh を解決して実行している"
else
  echo "FAIL CS2: agmsg send.sh の呼び出しが無い"; fail=1
fi

# --- CS3: SKILL.md / references 配下の全 .md に直書きが残らない ---
# 無人ループ用の references/unattended/*.md も子セッションのタスクプロンプトへ
# そのまま連結されるため、SKILL.md と同じ指示文として検査する。
cs3=1
while IFS= read -r doc; do
  while IFS=: read -r line text; do
    [[ -n "$line" ]] || continue
    # 同一行または直前行の免除マーカーで除外する
    if grep -q 'send-prompt-exempt:' <<<"$text"; then
      continue
    fi
    if [[ $line -gt 1 ]] && sed -n "$((line - 1))p" "$doc" | grep -q 'send-prompt-exempt:'; then
      continue
    fi
    echo "  cmux send / send-key の直書きが残っている: ${doc#"$SKILL_DIR/"}:$line"
    cs3=0
  done < <(grep -nE "$DIRECT_SEND_RE" "$doc" || true)
done < <(printf '%s\n' "$SKILL_DIR/SKILL.md"; find "$SKILL_DIR/references" -name '*.md' | sort)
if [[ $cs3 -eq 1 ]]; then
  echo "PASS CS3: SKILL.md と references 配下の .md に直書きが残らない"
else
  echo "FAIL CS3: cmux send / send-key の直書きが残っている"; fail=1
fi

# --- CS4: 削除済みスクリプトへの参照が残らない ---
# 対象は send-prompt.sh と agmsg-path.sh の 2 つ (この時点で削除したもの)。
# monitor-dispatch.sh / ensure-agmsg-ready.sh / batch-wait.sh の 3 つを DELETED_RE へ
# 加えるのは brief が Task 6 に割り当てている作業なので、ここでは対象にしない。
#
# PENDING 表は「T3 の担当外なので参照が残る箇所」を、担当タスクと件数つきで固定する。
# `*` は件数を問わないの意。表に無いファイルに 1 件でも出れば FAIL、表にあるのに
# 0 件なら「猶予はもう不要」で FAIL する (allowlist が黙って陳腐化しないためのラチェット)。
DELETED_RE='send-prompt\.sh|agmsg-path\.sh'
PENDING=(
  "skills/cmux-team-dispatch-task/SKILL.md|3|T4 (Step 1g の agmsg 配線ブロック / Step 3 の監視セクション)"
  "skills/cmux-team-dispatch-task/scripts/monitor-dispatch.sh|4|T6 (DELETED_RE を 5 つへ拡張して monitor-dispatch.sh / batch-wait.sh を削除。配送の書き換え自体は T4)"
  "skills/cmux-team-dispatch-task/references/guide-ja.md|*|T7 (訳の追従)"
  "README.md|*|T7 (ドキュメント更新)"
  "CLAUDE.md|*|T7 (ドキュメント更新)"
)
pending_expect() {
  local rel="$1" entry
  for entry in "${PENDING[@]}"; do
    [[ "${entry%%|*}" == "$rel" ]] || continue
    entry="${entry#*|}"; printf '%s' "${entry%%|*}"; return 0
  done
  return 1
}
pending_owner() {
  local rel="$1" entry
  for entry in "${PENDING[@]}"; do
    [[ "${entry%%|*}" == "$rel" ]] || continue
    printf '%s' "${entry##*|}"; return 0
  done
  return 1
}

# この検査スクリプト自身は判定パターンを地の文に持つので対象外。
SELF_REL="./test/test-delivery-callsites.sh"

cs4=1
while IFS= read -r rel; do
  [[ -n "$rel" ]] || continue
  [[ "$rel" == "$SELF_REL" ]] && continue
  count=$(grep -cE "$DELETED_RE" "$PLUGIN_DIR/${rel#./}" 2>/dev/null || echo 0)
  if expect=$(pending_expect "${rel#./}"); then
    if [[ "$expect" != "*" && "$count" != "$expect" ]]; then
      echo "  PENDING の件数が変わった: ${rel#./} ($count 件, 期待 $expect 件) — 担当: $(pending_owner "${rel#./}")"
      cs4=0
    fi
    continue
  fi
  echo "  削除済みスクリプトへの参照が残っている: ${rel#./} ($count 件)"
  cs4=0
done < <(cd "$PLUGIN_DIR" && grep -rIlE "$DELETED_RE" . 2>/dev/null | sort)
for entry in "${PENDING[@]}"; do
  rel="${entry%%|*}"
  if ! grep -qE "$DELETED_RE" "$PLUGIN_DIR/$rel" 2>/dev/null; then
    echo "  PENDING の猶予が不要になった (参照 0 件または不在): $rel — PENDING から削除せよ"
    cs4=0
  fi
done
if [[ $cs4 -eq 1 ]]; then
  echo "PASS CS4: send-prompt.sh / agmsg-path.sh への参照は PENDING 表の箇所だけに残る"
else
  echo "FAIL CS4: 削除済みスクリプトへの参照が想定外の場所に残っている"; fail=1
fi

exit $fail
