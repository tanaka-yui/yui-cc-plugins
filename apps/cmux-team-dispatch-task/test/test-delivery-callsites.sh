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
#   CS4. 削除済みスクリプト (send-prompt.sh / agmsg-path.sh / monitor-dispatch.sh /
#        ensure-agmsg-ready.sh / batch-wait.sh / runners-edit.sh) への参照がスクリプト・文書のどこにも
#        残らない。後続タスクが担当する箇所だけを PENDING 表で明示的に猶予し、件数まで
#        固定する
#   CS5. verdict 待ちのポーリング指示 (polling / every 5 seconds / 15-min /
#        seq 1 180) が SKILL.md / references/**/*.md / launch-workspace.sh に
#        残らない。「ポーリングしない」と否定形で語る行だけを許す。あわせて
#        verdict を待つ 3 領域に待機ループの構文 (while true / seq ループ等) が
#        無いことも見る (語彙だけの検査はループの書き戻しを素通しする)
#   CS6. レビュー依頼文に verdict 通知 (review-verdict: の送信指示) が含まれる
#   CS7. verdict を待つ側の手順に単発タイマー (single-shot safety timer) がある
#        — これが無いと review-verdict が失われた瞬間に待つ側が永久に眠る
#   CS9. レビュー依頼は review-request.sh 経由に一本化されている。
#        依頼側の 4 つの生成元と 2 つの無人ブロックが helper を名指ししており、かつ
#        「request ファイルを書いてから send.sh を呼べ」という 2 手順の旧文面が残らない。
#        2 手順のままだと 4/7 の頻度で書き込みだけが落ちる (2026-09-02 実測)。
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
# 対象は 6 つ: send-prompt.sh / agmsg-path.sh / runners-edit.sh (T3 の時点で削除) と
# monitor-dispatch.sh (T4 で削除) / ensure-agmsg-ready.sh (T1 で verify-agmsg-ready.sh に
# 置き換え) / batch-wait.sh (T6 で削除)。SKILL.md 自身が存在しないスクリプトを参照して
# いないことは test-skill-script-refs.sh (SR1/SR2) が別途固定する。
#
# PENDING 表は「意図的に参照が残る箇所」を、理由と件数つきで固定する。
# `*` は件数を問わないの意。表に無いファイルに 1 件でも出れば FAIL、表にあるのに
# 0 件なら「猶予はもう不要」で FAIL する (allowlist が黙って陳腐化しないためのラチェット)。
#
# T7 (ドキュメント更新) の完了により、日本語 4 ファイル (guide-ja.md / README.md /
# CLAUDE.md / docs/notification-gaps.md) の猶予は不要になったので表から外した。
# 日本語側の退役語彙は test-doc-stale-vocab.sh (DS1-DS3) が別途固定する。
DELETED_RE='send-prompt\.sh|agmsg-path\.sh|monitor-dispatch\.sh|ensure-agmsg-ready\.sh|batch-wait\.sh|runners-edit\.sh'
PENDING=(
  "test/test-doc-stale-vocab.sh|*|検査対象そのものを needle として持つ検査スクリプト"
  "docs/notification-gaps.md|1|履歴表 P9 の旧名 (旧名で grep して経緯へ辿り着けることに価値がある。test-doc-stale-vocab.sh の行内マーカーで明示済み)"
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
  echo "PASS CS4: 削除済み 6 スクリプトへの参照は PENDING 表の箇所だけに残る"
else
  echo "FAIL CS4: 削除済みスクリプトへの参照が想定外の場所に残っている"; fail=1
fi


# ---------------------------------------------------------------------------
# CS5-CS7: verdict 待ちが push (review-verdict メッセージ) になっていることの検査
# ---------------------------------------------------------------------------
LAUNCH="$SCRIPTS/launch-workspace.sh"
REVIEW_BLOCK_MD="$SKILL_DIR/references/unattended/review-block.md"
CODE_REVIEW_BLOCK_MD="$SKILL_DIR/references/unattended/code-review-block.md"

# 領域抽出。抽出が空なら呼び出し側で FAIL させる (アンカーを動かした瞬間に
# 検査が空虚に PASS するのを防ぐ番人。T4 の GB 系と同じ規律)。
extract_region() {
  local file="$1" start="$2" end="$3"
  [[ -r "$file" ]] || return 0
  # 終端アンカーが見つからないときは領域を出さない。ここで EOF まで垂れ流すと
  # 無関係な後続セクション (Step 3 の単発タイマーなど) を拾って空虚に PASS する。
  # 失敗の理由は start / end を区別して返す (どちらのアンカーが崩れたのか分からないと
  # 保守者が誤った側を直すため)。
  awk -v s="$start" -v e="$end" '
    !f && index($0, s) { f = 1 }
    f { buf = buf $0 "\n"; n++ }
    f && n > 1 && index($0, e) { closed = 1; exit }
    END {
      if (closed) printf "%s", buf
      else if (f) print "__REGION_NO_END__"
      else print "__REGION_NO_START__"
    }
  ' "$file"
}

# --- CS5: verdict のポーリング指示が残らない ---
# 「ポーリングしない」と書いた行 (no polling monitor / do NOT start polling など) は
# 新プロトコルの説明そのものなので許す。素の指示だけを落とす。
POLL_RE='polling|every 5 seconds|5s interval|15-min|seq 1 180'
# 否定免除は 5 語彙すべてに掛ける。`polling` だけを免除していた頃は、旧挙動の具体値
# (「かつては 5 秒ごとに再確認していた」) が書けず、書き手が「a short fixed interval」の
# ような言い換えで回避した — 検査が文書の精度を下げていた。
POLL_NEGATED_RE='(\bno\b|\bnot\b|\bNOT\b|\bnever\b|\bNever\b|\bwithout\b|\bWithout\b)[^.]{0,40}('"$POLL_RE"')'
# 待機ループの構文。語彙 (POLL_RE) だけの検査は
# `while true; do ... sleep 5; done` を書き戻す変異を素通しする (実測済み)。
# 対象は verdict を待つ 3 領域だけに絞る: SKILL.md には status.json を読む正当な
# `for ... do ... done` があり、launch-workspace.sh の runner wrapper 本体にも
# 正当な `while true` があるので、ファイル全体に掛けると誤検知する。
WAIT_LOOP_RE='while true|while :|until [^;]*;|for [A-Za-z_]+ in \$\(seq|for [A-Za-z_]+ in \{[0-9]+\.\.|sleep [0-9]+ *;? *(done|do)'
cs5=1
cs5_files=0
while IFS= read -r target; do
  [[ -n "$target" ]] || continue
  if [[ ! -f "$target" || ! -r "$target" ]]; then
    echo "  検査対象が読めない: $target"; cs5=0; continue
  fi
  cs5_files=$((cs5_files + 1))
  matches=$(grep -nE "$POLL_RE" "$target")
  rc=$?
  if [[ $rc -ge 2 ]]; then
    echo "  検査対象の grep が失敗した: $target (status $rc)"; cs5=0; continue
  fi
  while IFS=: read -r line text; do
    [[ -n "$line" ]] || continue
    # 否定形で「ポーリングしない」と語る行だけ許す。5 秒間隔 / 15 分チャンク /
    # seq 1 180 も同じ免除の対象で、否定語が語彙の直前 (40 桁以内・文をまたがない)
    # にあるときだけ通す。素の指示は依然として落ちる。
    # 否定語は 80 桁の折り返しで前の行に残ることがあるので、前後 1 行を含めて
    # 平坦化 (改行と連続空白を 1 空白に) した窓で判定する。
    window=$(sed -n "$((line > 1 ? line - 1 : 1)),$((line + 1))p" "$target" | tr '\n' ' ' | tr -s ' ')
    if grep -qE "$POLL_NEGATED_RE" <<<"$window"; then
      continue
    fi
    echo "  verdict のポーリング指示が残っている: ${target#"$PLUGIN_DIR/"}:$line"
    cs5=0
  done <<<"$matches"
done < <(printf '%s\n' "$SKILL_DIR/SKILL.md" "$LAUNCH"; find "$SKILL_DIR/references" -name '*.md' | sort)
# verdict を待つ 3 領域に待機ループの構文が無いこと。領域抽出は CS7 と同じアンカーを
# 使うので、アンカーごと消す変異も (空抽出として) 落ちる。
check_region_lacks() {
  local label="$1" file="$2" start="$3" end="$4" banned="$5"
  local region hit
  if [[ ! -r "$file" ]]; then
    echo "  検査対象が読めない ($label): $file"; return 1
  fi
  if [[ -z "$end" ]]; then
    region=$(grep -F -- "$start" "$file")
  else
    region=$(extract_region "$file" "$start" "$end")
  fi
  case "$region" in
    "")                   echo "  領域の抽出が空 ($label): 開始アンカー '$start' が無い"; return 1 ;;
    __REGION_NO_START__*) echo "  領域を切り出せない ($label): 開始アンカー '$start' が無い"; return 1 ;;
    __REGION_NO_END__*)   echo "  領域を切り出せない ($label): 終端アンカー '$end' が無い"; return 1 ;;
  esac
  if hit=$(grep -nE -- "$banned" <<<"$region"); then
    # REVIEW_INSTRUCTION は 1 行が数千文字あるので、診断は先頭 160 文字に切る
    echo "  $label に待機ループの構文が復活している (${file#"$PLUGIN_DIR/"}): $(head -1 <<<"$hit" | cut -c1-160)"
    return 1
  fi
  return 0
}
check_region_lacks 'Phase A-R の待機手順' "$SKILL_DIR/SKILL.md" \
  '2. Send the request with ONE send.sh call' 'Act on the verdict:' "$WAIT_LOOP_RE" || cs5=0
check_region_lacks 'Phase B-R の待機手順' "$SKILL_DIR/SKILL.md" \
  'After sending each `review-code:` request' 'The design pane is never selected as code reviewer' \
  "$WAIT_LOOP_RE" || cs5=0
check_region_lacks 'REVIEW_INSTRUCTION の待機手順' "$LAUNCH" \
  'REVIEW_INSTRUCTION="MANDATORY CODE REVIEW' '' "$WAIT_LOOP_RE" || cs5=0

if [[ $cs5_files -eq 0 ]]; then
  echo "FAIL CS5: 検査対象が 1 件も無い (検査が空虚に PASS している)"; fail=1
elif [[ $cs5 -eq 1 ]]; then
  echo "PASS CS5: verdict のポーリング指示 (語彙) が $cs5_files ファイルに無く、待機 3 領域に待機ループの構文も無い"
else
  echo "FAIL CS5: verdict のポーリング指示が残っている"; fail=1
fi

# --- CS6: レビュー依頼文に review-verdict: の通知指示がある ---
# 依頼文ごとに領域を切って検査する。ファイル全体を 1 回 grep する素朴な実装では、
# Phase A-R にだけ通知指示があって Phase B-R の依頼文が素のままでも PASS してしまう。
cs6=1
check_region_has() {
  local label="$1" file="$2" start="$3" end="$4"; shift 4
  local region needle
  if [[ ! -r "$file" ]]; then
    echo "  検査対象が読めない ($label): $file"; return 1
  fi
  if [[ -z "$end" ]]; then
    region=$(grep -F -- "$start" "$file")
  else
    region=$(extract_region "$file" "$start" "$end")
  fi
  case "$region" in
    "")
      echo "  領域の抽出が空 ($label): 開始アンカー '$start' が ${file#"$PLUGIN_DIR/"} に無い"
      return 1 ;;
    __REGION_NO_START__*)
      echo "  領域を切り出せない ($label): 開始アンカー '$start' が ${file#"$PLUGIN_DIR/"} に無い"
      return 1 ;;
    __REGION_NO_END__*)
      echo "  領域を切り出せない ($label): 開始アンカーは見つかったが終端アンカー '$end' が後ろに無い (${file#"$PLUGIN_DIR/"})"
      return 1 ;;
  esac
  # 改行と連続空白を 1 個の空白に潰した平坦化コピーで照合する。SKILL.md の指示文は
  # 80 桁で折り返されるので、行単位で見ると「single-shot safety timer」のような句が
  # 折り返しの位置次第で見つからなくなる (再折り返しだけで FAIL する偽陽性になる)。
  region=$(tr '\n' ' ' <<<"$region" | tr -s ' ')
  local rc=0
  for needle in "$@"; do
    if ! grep -qE -- "$needle" <<<"$region"; then
      echo "  $label に '$needle' が無い (${file#"$PLUGIN_DIR/"})"
      rc=1
    fi
  done
  return $rc
}

# 依頼文 1: SKILL.md Phase A-R (親でなく design ペインが待つ側)
check_region_has 'Phase A-R の依頼文' "$SKILL_DIR/SKILL.md" \
  'Always append the protocol:' '1b. Append the parallel-review directive' \
  'review-verdict:' 'send\.sh' || cs6=0
# 依頼文 2: SKILL.md Phase B-R 共通プロトコル a (実装者が待つ側)
check_region_has 'Phase B-R の依頼文' "$SKILL_DIR/SKILL.md" \
  'After all changes are committed and BEFORE creating the PR' \
  'Append the same engine-specific final instruction' \
  'review-verdict:' 'send\.sh' || cs6=0
# 依頼文 3: launch-workspace.sh が焼き込む REVIEW_INSTRUCTION (spawn 経路)
check_region_has 'REVIEW_INSTRUCTION の依頼文' "$LAUNCH" \
  'REVIEW_INSTRUCTION="MANDATORY CODE REVIEW' '' \
  'review-verdict:' 'AGMSG_SEND' || cs6=0
# 依頼文 4/5: 無人ループ用ブロック (子プロンプトへそのまま連結される)
check_region_has '無人ループの review-block' "$REVIEW_BLOCK_MD" \
  'Phase A-R is assigned to the `design_review` pane.' '' 'review-verdict:' || cs6=0
check_region_has '無人ループの code-review-block' "$CODE_REVIEW_BLOCK_MD" \
  'Request each review with ONE call' 'If you stop before completing the work' \
  'review-verdict:' 'send\.sh' || cs6=0
if [[ $cs6 -eq 1 ]]; then
  echo "PASS CS6: 5 箇所のレビュー依頼文すべてに review-verdict: の通知指示がある"
else
  echo "FAIL CS6: レビュー依頼文に review-verdict: の通知指示が無い"; fail=1
fi

# --- CS7: verdict を待つ側の保険が engine ごとに正しく書かれている ---
# claude 待機者には単発タイマーが 1 本あること。**codex 待機者には保険が無いと明記され、
# 動かないと実測された自己タイマー (D-T2: `( sleep N; send.sh ) &` /
# `setsid nohup bash -c ... &`) の指示が残っていないこと。**
# engine で分けずに「単発タイマーがある」だけを検査していた頃は、codex 待機者へ
# 「不発の手段を張れ」と指示したままでも緑だった (待機者は保険があるつもりで永久に眠る)。
cs7=1
# claude 側: タイマーの指示が生きていること
check_region_has 'Phase A-R の待機手順 (claude)' "$SKILL_DIR/SKILL.md" \
  '2. Send the request with ONE send.sh call' 'Act on the verdict:' \
  'single-shot safety timer' 'run_in_background' || cs7=0
check_region_has 'Phase B-R の待機手順 (claude)' "$SKILL_DIR/SKILL.md" \
  'After sending each `review-code:` request' 'The design pane is never selected as code reviewer' \
  'single-shot safety timer' 'run_in_background' || cs7=0
check_region_has 'REVIEW_INSTRUCTION の待機手順 (claude)' "$LAUNCH" \
  'REVIEW_INSTRUCTION="MANDATORY CODE REVIEW' '' \
  'single-shot safety timer' || cs7=0
# codex 側: 「保険が無い」ことと親への 1 通報告があること。Phase A-R の
# reviewer-engine 別到達性確認は、下の CS8 が production renderer の実出力で検査する。
check_region_has 'Phase A-R の待機手順 (codex)' "$SKILL_DIR/SKILL.md" \
  '2. Send the request with ONE send.sh call' 'Act on the verdict:' \
  'NO safety net' 'dispatch-notify:' || cs7=0
check_region_has 'Phase B-R の待機手順 (codex)' "$SKILL_DIR/SKILL.md" \
  'After sending each `review-code:` request' 'The design pane is never selected as code reviewer' \
  'NO safety net' 'verify-agmsg-ready\.sh --codex' 'dispatch-notify:' || cs7=0
check_region_has 'REVIEW_INSTRUCTION の待機手順 (codex)' "$LAUNCH" \
  'REVIEW_INSTRUCTION="MANDATORY CODE REVIEW' '' \
  'NO safety net' 'dispatch-notify:' || cs7=0
# 不発と実測された自己タイマーの指示が復活していないこと
CODEX_TIMER_RE='\( *sleep [^;]*; *[^)]*send\.sh|setsid|start a background subshell|prefix review-timer:'
check_region_lacks 'Phase A-R の待機手順' "$SKILL_DIR/SKILL.md" \
  '2. Send the request with ONE send.sh call' 'Act on the verdict:' "$CODEX_TIMER_RE" || cs7=0
check_region_lacks 'Phase B-R の待機手順' "$SKILL_DIR/SKILL.md" \
  'After sending each `review-code:` request' 'The design pane is never selected as code reviewer' \
  "$CODEX_TIMER_RE" || cs7=0
check_region_lacks 'REVIEW_INSTRUCTION の待機手順' "$LAUNCH" \
  'REVIEW_INSTRUCTION="MANDATORY CODE REVIEW' '' "$CODEX_TIMER_RE" || cs7=0
# 無人ループのブロックも同じ規律に従うこと
check_region_has '無人ループの code-review-block (engine 別)' "$CODE_REVIEW_BLOCK_MD" \
  'Request each review with ONE call' 'If you stop before completing the work' \
  'single-shot safety timer' 'NO safety net' 'dispatch-notify:' || cs7=0
check_region_lacks '無人ループの code-review-block' "$CODE_REVIEW_BLOCK_MD" \
  'Request each review with ONE call' 'If you stop before completing the work' \
  "$CODEX_TIMER_RE" || cs7=0
if [[ $cs7 -eq 1 ]]; then
  echo "PASS CS7: verdict を待つ 4 箇所とも claude=タイマー / codex=保険なし+代替 2 手で書かれている"
else
  echo "FAIL CS7: verdict 待機の保険が engine ごとに正しく書かれていない"; fail=1
fi

# --- CS8: Phase A-R の実配送 prompt は waiter/reviewer engine を独立に扱う ---
# 静的な語彙検査だけでは、design=codex の分岐内で reviewer engine を見ずに常に
# --codex seat を検査する退行を見逃す。production renderer を mixed-engine 2 方向で
# 実行し、配送される wait protocol 本文そのものを検査する。
PHASE_A_WAIT="$SCRIPTS/phase-a-review-wait.sh"
codex_claude=$(bash "$PHASE_A_WAIT" --waiter-engine codex --reviewer-engine claude \
  --team tm --waiter-agent task --reviewer-agent task-design-review \
  --reviewer-workspace workspace:1 --reviewer-surface surface:2 \
  --findings-path /dispatch/review/spec-round-1.md --review-dir /dispatch/review \
  --send-command /agmsg/send.sh 2>/dev/null)
codex_claude_rc=$?
claude_codex=$(bash "$PHASE_A_WAIT" --waiter-engine claude --reviewer-engine codex \
  --team tm --waiter-agent task --reviewer-agent task-design-review \
  --reviewer-workspace workspace:1 --reviewer-surface surface:2 \
  --findings-path /dispatch/review/plan-round-1.md --review-dir /dispatch/review \
  --send-command /agmsg/send.sh 2>/dev/null)
claude_codex_rc=$?
skill_flat=$(tr '\n' ' ' < "$SKILL_DIR/SKILL.md" | tr -s ' ')
if [[ $codex_claude_rc -eq 0 \
   && "$codex_claude" == *'NO safety net'* \
   && "$codex_claude" == *'cmux read-screen --workspace workspace:1 --surface surface:2'* \
   && "$codex_claude" == *'dispatch-notify:'* \
   && "$codex_claude" != *'verify-agmsg-ready.sh --codex'* \
   && $claude_codex_rc -eq 0 \
   && "$claude_codex" == *'single-shot safety timer'* \
   && "$claude_codex" == *'run_in_background'* \
   && "$claude_codex" == *'verify-agmsg-ready.sh --codex --team tm --name task-design-review'* \
   && "$claude_codex" != *'cmux read-screen'* \
   && "$skill_flat" == *'{{DESIGN_REVIEW_SURFACE}}'* \
   && "$skill_flat" == *'{{DESIGN_REVIEW_WORKSPACE}}'* ]]; then
  echo 'PASS CS8: mixed-engine 2 方向の Phase A-R 実配送 prompt が reviewer engine 別 liveness を持つ'
else
  echo 'FAIL CS8: Phase A-R 実配送 prompt が waiter/reviewer engine を独立に扱っていない'
  fail=1
fi


# --- CS9: レビュー依頼は review-request.sh 経由に一本化されている ---
CS9_SOURCES=(
  "$SCRIPTS/phase-b-deliver.sh"
  "$SCRIPTS/phase-a-review-wait.sh"
  "$SCRIPTS/launch-workspace.sh"
  "$SCRIPTS/completion-gate.sh"
  "$SKILL_DIR/references/unattended/review-block.md"
  "$SKILL_DIR/references/unattended/code-review-block.md"
)
cs9=0
for f in "${CS9_SOURCES[@]}"; do
  grep -q 'review-request\.sh' "$f" || { echo "  CS9: $f に review-request.sh が無い"; cs9=1; }
done
# 旧文面の残骸。request ファイルのパスと send を同じ文で語る指示は消えていること。
if grep -rn 'write that same message text to' "${CS9_SOURCES[@]}" >/dev/null 2>&1; then
  echo "  CS9: 2 手順の旧文面が残っている"; cs9=1
fi
if [[ $cs9 -eq 0 ]]; then
  echo 'PASS CS9: レビュー依頼が review-request.sh へ一本化されている'
else
  echo 'FAIL CS9: レビュー依頼の一本化が未完了'; fail=1
fi

exit $fail
