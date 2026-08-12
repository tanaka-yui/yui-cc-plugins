#!/usr/bin/env bash
# 配送経路が send-prompt.sh に一本化されていることの静的検査。
#
# 守っている不変条件:
#   CS1. launch-workspace.sh / monitor-dispatch.sh に cmux send / cmux send-key の
#        直書きが残らない (シェルコマンドの打鍵だけは免除マーカーで明示的に除外する)
#   CS2. 両スクリプトが send-prompt.sh を呼んでいる
#   CS3. SKILL.md と references 配下の全 .md の指示文に cmux send / cmux send-key の
#        直書きが残らない (訳や無人ループ用ブロックが原文から遅れて旧文面を残す事故を防ぐ)
#
# 免除の仕組み:
#   `cmux send` はシェルにコマンドを打ち込む用途（TUI へのメッセージ配送ではない）でも
#   使うため、その出現の直前 3 行以内（ドキュメントは同一行または直前行）に
#   `send-prompt-exempt:` を含むコメントを置いたときだけ検査対象から外す。
#   行番号でのハードコードを避け、新しい出現は必ずレビューを通す形にしている。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts"
SKILL_DIR="$SCRIPT_DIR/../skills/cmux-team-dispatch-task"
fail=0

# cmux バイナリを直接叩く送信呼び出し (send / send-key) を列挙する。
# 末尾の `([^-a-zA-Z]|$)` は `send-prompt.sh` のような別コマンドを除外しつつ、
# 行末や backtick で終わる `cmux send` (Enter を伴わない一方通行の配送指示) も拾う。
DIRECT_SEND_RE='(\$\{?CMUX[A-Z_]*\}?"?|\bcmux) (send|send-key)([^-a-zA-Z]|$)'

# --- CS1: スクリプトに cmux send / send-key の直書きが残らない ---
# send-prompt.sh 自身は当然 cmux を直接叩くので対象外。
cs1=1
for f in launch-workspace.sh monitor-dispatch.sh; do
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
  done < <(grep -nE "$DIRECT_SEND_RE" "$SCRIPTS/$f" || true)
done
if [[ $cs1 -eq 1 ]]; then
  echo "PASS CS1: スクリプトに cmux send / send-key の直書きが残らない"
else
  echo "FAIL CS1: cmux send / send-key の直書きが残っている"; fail=1
fi

# --- CS2: send-prompt.sh を呼んでいる ---
cs2=1
for f in launch-workspace.sh monitor-dispatch.sh; do
  grep -q 'send-prompt.sh' "$SCRIPTS/$f" || { echo "  send-prompt.sh を呼んでいない: $f"; cs2=0; }
done
if [[ $cs2 -eq 1 ]]; then
  echo "PASS CS2: 両スクリプトが send-prompt.sh を呼んでいる"
else
  echo "FAIL CS2: send-prompt.sh の呼び出しが無い"; fail=1
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

exit $fail
