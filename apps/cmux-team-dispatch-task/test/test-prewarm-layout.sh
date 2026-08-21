#!/usr/bin/env bash
# prewarm-panes.sh のペイン配置 (design / review / executors) の回帰テスト。
#
# 期待するグリッド:
#   design = workspace のメイン surface (左上)
#   review = design から right split (右上)
#   executors = 1つ目が design から down split (左下)、2つ目以降は直前の
#               executor から right split (右下 …)
# executor が 2 つで review 有りのときにちょうど 2×2 になる。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREWARM="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/scripts" "$TMP/repo" "$TMP/agmsg"
git -C "$TMP/repo" init -q
git -C "$TMP/repo" config user.email test@example.invalid
git -C "$TMP/repo" config user.name test
touch "$TMP/repo/.gitkeep"
git -C "$TMP/repo" add .gitkeep
git -C "$TMP/repo" commit -qm init

cp "$PREWARM" "$TMP/scripts/prewarm-panes.sh"

cat > "$TMP/scripts/launch-workspace.sh" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$ARGV_LOG"
count=$(wc -l < "$ARGV_LOG" | tr -d ' ')
jq -n --arg surface "surface:$count" '{workspace_id:"workspace:1", surface_id:$surface}'
STUB
chmod +x "$TMP/scripts/launch-workspace.sh"

for s in join.sh delivery.sh leave.sh send.sh; do
  printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/agmsg/$s"
  chmod +x "$TMP/agmsg/$s"
done

# join.sh / delivery.sh は agmsg guard の失敗注入テスト (PW2/PW9) のために
# 環境変数で挙動を切り替えられるスタブへ差し替える。既定 (env 未設定) では
# 上のループと同じ「常に成功」動作のままなので PG1-3 の挙動は変わらない。
cat > "$TMP/agmsg/join.sh" <<'STUB'
#!/usr/bin/env bash
[[ -n "${AGMSG_LOG:-}" ]] && printf '%s %s\n' "$(basename "$0")" "$*" >> "$AGMSG_LOG"
[[ -n "${AGMSG_STUB_JOIN_FAIL:-}" && "${AGMSG_STUB_JOIN_FAIL:-}" == "$2" ]] && exit 1
exit 0
STUB
chmod +x "$TMP/agmsg/join.sh"

cat > "$TMP/agmsg/delivery.sh" <<'STUB'
#!/usr/bin/env bash
[[ -n "${AGMSG_STUB_DIRECTIVE:-}" ]] && echo "AGMSG-DIRECTIVE: watcher active"
exit "${AGMSG_STUB_DELIVERY_RC:-0}"
STUB
chmod +x "$TMP/agmsg/delivery.sh"

cat > "$TMP/runners.json" <<'JSON'
{
  "default": "claude",
  "runners": [
    { "name": "claude", "command": "claude", "engine": "claude" },
    {
      "name": "codex",
      "command": "codex",
      "engine": "codex",
      "plan_model": "gpt-5.6-sol",
      "review_model": "gpt-5.6-sol",
      "exec_model": "gpt-5.6-terra"
    }
  ]
}
JSON

fail=0
pass() { echo "PASS: $1"; }
bad() { echo "FAIL: $1" >&2; fail=1; }

CASE_LOG=""

run_case() {
  local slug="$1"; shift
  CASE_LOG="$TMP/argv-$slug.log"
  : > "$CASE_LOG"
  # worktree は事前に作っておく (prewarm-panes.sh は既存ディレクトリを再利用する)。
  # 未作成のまま渡すと `git worktree add` が「テストを起動したリポジトリ」に対して
  # 走り、実リポジトリへブランチと worktree 登録を残してしまう。
  mkdir -p "$TMP/repo-$slug"
  ARGV_LOG="$CASE_LOG" AGMSG_DIR="$TMP/agmsg" RUNNERS_CONFIG_PATH="$TMP/runners.json" \
    bash "$TMP/scripts/prewarm-panes.sh" --with-design --agmsg-team demo-team \
      --cwd "$TMP/repo-$slug" --slug "$slug" --status-dir "$TMP/status-$slug" "$@" >/dev/null
}

# pane 行を --agmsg-from で特定する (末尾に必ず pane 名が続くので trailing space で前方一致を防ぐ)
pane_line() {
  grep -F -- "--agmsg-from $1 " "$CASE_LOG" || true
}

# <id> <pane-agent> <expected split-from> <down|right>
expect_split() {
  local id="$1" agent="$2" from="$3" dir="$4" line
  line=$(pane_line "$agent")
  if [[ -z "$line" ]]; then
    bad "$id pane '$agent' was not launched"
    return
  fi
  if ! grep -Fq -- "--standby-split-from $from " <<<"$line "; then
    bad "$id pane '$agent' must split from $from: $line"
    return
  fi
  if [[ "$dir" == right ]]; then
    grep -Fq -- '--standby-split-direction right' <<<"$line" \
      && pass "$id pane '$agent' splits right from $from" \
      || bad "$id pane '$agent' must split right from $from: $line"
  else
    grep -Fq -- '--standby-split-direction' <<<"$line" \
      && bad "$id pane '$agent' must split down (no direction flag) from $from: $line" \
      || pass "$id pane '$agent' splits down from $from"
  fi
}

# --- PG1: claude design + review + ask (design / claude / codex / review = 2×2) ---
run_case pg1 --design-runner claude --reviewer-runner codex \
  --claude-runner claude --codex-runner codex --exec-choice ask
[[ $(wc -l < "$TMP/argv-pg1.log" | tr -d ' ') == 4 ]] \
  && pass 'PG1 four panes' || bad 'PG1 four panes'
expect_split PG1 pg1-claude surface:1 down
expect_split PG1 pg1-codex surface:2 right
expect_split PG1 pg1-review surface:1 right

# --- PG2: fixed exec_choice (design / codex / review) ---
run_case pg2 --design-runner claude --reviewer-runner codex \
  --exec-runner codex --exec-choice codex
[[ $(wc -l < "$TMP/argv-pg2.log" | tr -d ' ') == 3 ]] \
  && pass 'PG2 three panes' || bad 'PG2 three panes'
expect_split PG2 pg2-codex surface:1 down
expect_split PG2 pg2-review surface:1 right

# --- PG3: codex design + ask (design / claude / codex / review) ---
run_case pg3 --design-runner codex --reviewer-runner codex \
  --claude-runner claude --codex-runner codex --exec-choice ask
[[ $(wc -l < "$TMP/argv-pg3.log" | tr -d ' ') == 4 ]] \
  && pass 'PG3 four panes' || bad 'PG3 four panes'
expect_split PG3 pg3-claude surface:1 down
expect_split PG3 pg3-codex surface:2 right
expect_split PG3 pg3-review surface:1 right


# ==========================================================================
# PW1-PW14: 全ロールの初期プロンプトへの readiness 確立句 (readiness_clause) 注入
# ==========================================================================
#
# guard_clause() / ensure-agmsg-ready.sh (nohup watcher) は廃止された。
# 新設計では claude は Monitor ツール起動、codex は seat 記録 (codex-record-session.sh)
# を行い、どちらも最後に親へ `send.sh ... parent [ready]\ <name>.` を送る指示を
# プロンプトに埋め込む。fallback は無いので、delivery/join の成否に関わらず
# readiness_clause は常に呼ばれる (PW2 / PW9 がこの no-fallback 特性を検査する)。

# <id> <agent>: そのペインの起動プロンプトに [ready] 送信の readiness 句が入っているか
expect_readiness() {
  local id="$1" agent="$2" line
  line=$(pane_line "$agent")
  if [[ -z "$line" ]]; then
    bad "$id pane '$agent' was not launched"
    return
  fi
  if grep -Fq -- "send.sh demo-team $agent parent [ready]\\ $agent." <<<"$line"; then
    pass "$id pane '$agent' carries the readiness clause ([ready] send instruction)"
  else
    bad "$id pane '$agent' is missing the readiness clause: $line"
  fi
}

# --- PW1 / PW3 / PW4 / PW5 / PW10: 配線成功時、design/claude/codex/review の
#     全ロールに readiness 句が乗り、prewarm.json の wired が true、禁止文字・改行が無い ---
run_case pw1 --design-runner claude --reviewer-runner codex \
  --claude-runner claude --codex-runner codex --exec-choice ask

# PW1: prewarm.json の delivery/watcher キーは退役し、wired: true に統一される
# (join / delivery.sh set / readiness 句注入がすべて成功したことを表す診断情報。
#  fallback が無いのでロールが存在する限り必ず true — 呼び出し元はこの値で分岐しない)
jq -e '[.. | objects | select(has("surface_id")) | (has("delivery") or has("watcher"))] | any' \
  "$TMP/status-pw1/prewarm.json" >/dev/null \
  && bad 'PW1 delivery/watcher キーが残っている (退役したはず)' \
  || pass 'PW1 delivery/watcher キーは残っていない'
jq -e '[.. | objects | select(has("surface_id")) | .wired] | all(. == true)' \
  "$TMP/status-pw1/prewarm.json" >/dev/null \
  && pass 'PW1 全ロールの wired が true' \
  || bad 'PW1 wired が true ではないロールがある'

# PW3: readiness 句が実際にプロンプトへ埋め込まれる
[[ -s "$TMP/argv-pw1.log" ]] || bad 'PW3 argv-pw1.log が空'
expect_readiness PW3 pw1

# PW4: 旧 /agmsg actas 文言が完全に消えている
grep -q '/agmsg actas' "$TMP/argv-pw1.log" \
  && bad 'PW4 /agmsg actas が残っている' || pass 'PW4 /agmsg actas は残っていない'

# PW5: 禁止文字 (' " ` $ !) が一切無く、改行でペイン数が壊れていない。
# \ (バックスラッシュ) だけは [ready] の後の空白を保護するため readiness_clause が
# 意図的に 1 箇所使う (合成後の zsh -ic "... '<prompt>' ..." を実際に二重引用符で
# 壊さないための唯一の安全な手段であることを実測で確認済み。prewarm-panes.sh の
# readiness_clause() 直上コメント参照)。
grep -qE "['\"\`\$!]" "$TMP/argv-pw1.log" \
  && bad 'PW5 禁止文字がプロンプトに含まれる' || pass 'PW5 禁止文字は含まれない'
grep -Fq -- '[ready]\ ' "$TMP/argv-pw1.log" \
  && pass 'PW5 [ready] の後の空白は \\ (バックスラッシュ) で保護されている' \
  || bad 'PW5 [ready] の空白保護 (\\ ) が見つからない'
[[ $(wc -l < "$TMP/argv-pw1.log" | tr -d ' ') == 4 ]] \
  && pass 'PW5 改行でペイン数が壊れていない (4 行)' \
  || bad 'PW5 argv-pw1.log の行数が 4 ではない (改行混入の疑い)'

# PW10: --agmsg-from が各ロールへ正しく渡る
grep -Fq -- '--agmsg-from pw1-claude ' "$TMP/argv-pw1.log" \
  && pass 'PW10 executor role name (--agmsg-from pw1-claude)' \
  || bad 'PW10 executor role name が渡っていない'
grep -Fq -- '--agmsg-from pw1-review ' "$TMP/argv-pw1.log" \
  && pass 'PW10 review role name (--agmsg-from pw1-review)' \
  || bad 'PW10 review role name が渡っていない'

# PW10b: legacy --review-model 経路にも --agmsg-from と readiness 句 (codex seat 記録)
# が渡る (review は REVIEWER_ENGINE 未設定時に codex 既定になるため)
run_case pw10b --design-runner claude --review-model gpt-5.6-sol \
  --claude-runner claude --codex-runner codex --exec-choice claude
grep -Fq -- '--agmsg-from pw10b-review ' "$TMP/argv-pw10b.log" \
  && pass 'PW10b legacy --review-model にも --agmsg-from が渡る' \
  || bad 'PW10b legacy --review-model で --agmsg-from が落ちている'
grep -Fq -- 'codex-record-session.sh demo-team pw10b-review .' "$TMP/argv-pw10b.log" \
  && pass 'PW10b legacy review にも readiness 句 (codex seat 記録) が注入される' \
  || bad 'PW10b legacy review に readiness 句が注入されていない'

# --- PW1c: codex design (design (claude / codex 共通) の codex 側も readiness 句を持つ) ---
run_case pw1c --design-runner codex --reviewer-runner codex \
  --claude-runner claude --exec-choice claude
codex_design_line=$(pane_line pw1c)
[[ "$codex_design_line" == *'codex-record-session.sh'* ]] \
  && pass 'PW1c codex design にも readiness 句 (codex seat 記録) が注入される' \
  || bad 'PW1c codex design に readiness 句が注入されていない'

# --- PW2: delivery.sh set が全ロールで失敗しても (no fallback) readiness 句は
#     変わらず注入され、ペイン数も wired も変わらない。素朴な実装が旧来の
#     「delivery 失敗時は注入しない」ゲートを残していると、readiness 句が消えて
#     ここが FAIL する ---
mkdir -p "$TMP/repo-pw2"
: > "$TMP/argv-pw2.log"
AGMSG_STUB_DELIVERY_RC=1 ARGV_LOG="$TMP/argv-pw2.log" AGMSG_DIR="$TMP/agmsg" RUNNERS_CONFIG_PATH="$TMP/runners.json" \
  bash "$TMP/scripts/prewarm-panes.sh" --with-design --agmsg-team demo-team \
    --cwd "$TMP/repo-pw2" --slug pw2 --status-dir "$TMP/status-pw2" \
    --design-runner claude --reviewer-runner codex \
    --claude-runner claude --codex-runner codex --exec-choice ask >/dev/null
grep -Fq -- 'send.sh demo-team pw2 parent [ready]\ pw2.' "$TMP/argv-pw2.log" \
  && pass 'PW2 delivery.sh set 失敗時も readiness 句は注入される (no fallback)' \
  || bad 'PW2 delivery.sh set 失敗時に readiness 句が消えた'
[[ $(wc -l < "$TMP/argv-pw2.log" | tr -d ' ') == 4 ]] \
  && pass 'PW2 delivery.sh set 失敗時も4ペインすべて起動する' \
  || bad 'PW2 delivery.sh set 失敗時に起動ペイン数が変わった'
jq -e '[.. | objects | select(has("surface_id")) | .wired] | all(. == true)' \
  "$TMP/status-pw2/prewarm.json" >/dev/null \
  && pass 'PW2 delivery.sh set 失敗時も wired は true のまま' \
  || bad 'PW2 wired が true ではないロールがある'

# --- PW6: delivery.sh の AGMSG-DIRECTIVE 出力が prewarm-panes.sh 自身の stderr へ
#     漏れない (wire_delivery のリダイレクト修正の回帰。wire_delivery 自体は本タスクの
#     変更対象ではないため挙動は不変) ---
mkdir -p "$TMP/repo-pw6"
: > "$TMP/argv-pw6.log"
AGMSG_STUB_DIRECTIVE=1 ARGV_LOG="$TMP/argv-pw6.log" AGMSG_DIR="$TMP/agmsg" RUNNERS_CONFIG_PATH="$TMP/runners.json" \
  bash "$TMP/scripts/prewarm-panes.sh" --with-design --agmsg-team demo-team \
    --cwd "$TMP/repo-pw6" --slug pw6 --status-dir "$TMP/status-pw6" \
    --claude-runner claude --exec-choice claude \
    >/dev/null 2>"$TMP/prewarm-pw6.stderr"
grep -q 'AGMSG-DIRECTIVE' "$TMP/prewarm-pw6.stderr" \
  && bad 'PW6 AGMSG-DIRECTIVE が prewarm-panes.sh の stderr へ漏れた' \
  || pass 'PW6 AGMSG-DIRECTIVE は stderr へ漏れない'

# --- PW8: --agmsg-team 無しでは readiness 句を載せない (agmsg を使わない特殊用途) ---
mkdir -p "$TMP/repo-pw8"
: > "$TMP/argv-noteam.log"
ARGV_LOG="$TMP/argv-noteam.log" AGMSG_DIR="$TMP/agmsg" RUNNERS_CONFIG_PATH="$TMP/runners.json" \
  bash "$TMP/scripts/prewarm-panes.sh" \
    --workspace workspace:1 --base-surface surface:1 \
    --cwd "$TMP/repo-pw8" --slug pw8 --status-dir "$TMP/status-pw8" \
    --claude-runner claude --codex-runner codex --exec-choice ask >/dev/null
grep -q 'send.sh' "$TMP/argv-noteam.log" \
  && bad 'PW8 --agmsg-team 無しで readiness 句が注入された' \
  || pass 'PW8 --agmsg-team 無しでは readiness 句を載せない'

# --- PW9: design の join だけが失敗しても、readiness 句は無条件で注入される
#     (no fallback の原則そのものの検査。旧 DESIGN_DELIVERY ゲートを素朴に残した
#     実装だと design だけ readiness 句が消えてここが FAIL する) ---
mkdir -p "$TMP/repo-pw9"
: > "$TMP/argv-pw9.log"
AGMSG_STUB_JOIN_FAIL=pw9 ARGV_LOG="$TMP/argv-pw9.log" AGMSG_DIR="$TMP/agmsg" RUNNERS_CONFIG_PATH="$TMP/runners.json" \
  bash "$TMP/scripts/prewarm-panes.sh" --with-design --agmsg-team demo-team \
    --cwd "$TMP/repo-pw9" --slug pw9 --status-dir "$TMP/status-pw9" \
    --claude-runner claude --exec-choice claude >/dev/null
CASE_LOG="$TMP/argv-pw9.log"
pw9_design_line=$(pane_line pw9)
pw9_claude_line=$(pane_line pw9-claude)
[[ -n "$pw9_design_line" && "$pw9_design_line" == *'send.sh demo-team pw9 parent [ready]\ pw9.'* ]] \
  && pass 'PW9 design join 失敗時も readiness 句は注入される (no fallback)' \
  || bad "PW9 design join 失敗時に readiness 句が消えた (fallback してはならない): $pw9_design_line"
[[ -n "$pw9_claude_line" && "$pw9_claude_line" == *'send.sh demo-team pw9-claude parent'* ]] \
  && pass 'PW9 claude executor の join は独立して成功し readiness 句が乗る' \
  || bad 'PW9 claude executor に readiness 句が乗っていない'
jq -e '.design.wired == true' "$TMP/status-pw9/prewarm.json" >/dev/null \
  && pass 'PW9 design の wired は true のまま' || bad 'PW9 design の wired が true ではない'

# ==========================================================================
# PW11-PW14: readiness_clause 導入 (Task 2) 自体の回帰
# ==========================================================================

# PW9 が CASE_LOG を argv-pw9.log へ進めているので、pw1 の行を見る PW11-13 の前に戻す
# (pane_line は run_case が設定するグローバル $CASE_LOG を見るため)
CASE_LOG="$TMP/argv-pw1.log"

# --- PW11: 4 ロールすべての起動プロンプトに readiness 句 ([ready] を送る指示) が入る ---
for agent in pw1 pw1-claude pw1-codex pw1-review; do
  expect_readiness PW11 "$agent"
done

# --- PW12: codex ロール (codex executor / codex reviewer) の起動プロンプトに
#     codex-record-session.sh が入る ---
for agent in pw1-codex pw1-review; do
  line=$(pane_line "$agent")
  grep -Fq -- 'codex-record-session.sh' <<<"$line" \
    && pass "PW12 codex pane '$agent' carries codex-record-session.sh" \
    || bad "PW12 codex pane '$agent' is missing codex-record-session.sh: $line"
done

# --- PW13: claude ロール (design / claude executor) の起動プロンプトに
#     Monitor ツールの起動指示が入る ---
for agent in pw1 pw1-claude; do
  line=$(pane_line "$agent")
  if grep -Fq -- 'AGMSG-DIRECTIVE' <<<"$line" && grep -Fq -- 'Monitor tool' <<<"$line"; then
    pass "PW13 claude pane '$agent' carries the Monitor tool instruction"
  else
    bad "PW13 claude pane '$agent' is missing the Monitor tool instruction: $line"
  fi
done

# --- PW14: SCRIPT_DIR にシェルメタ文字 (空白含む) があるとき die する。
#     fallback は無いので、旧挙動の「readiness 句無しで idle 起動」に落ちてはならない
#     (die を忘れて旧 PW5b/PW5c のような黙って続行する実装だとここが FAIL する) ---
run_readiness_die_case() {  # <id> <script-dir-name (contains a metachar)>
  local id="$1" dirname="$2" dir repo out
  dir="$TMP/$dirname/scripts"
  repo="$TMP/$dirname/repo-$id"
  mkdir -p "$dir" "$repo"
  cp "$PREWARM" "$dir/prewarm-panes.sh"
  cp "$TMP/scripts/launch-workspace.sh" "$dir/launch-workspace.sh"
  chmod +x "$dir/launch-workspace.sh"
  : > "$TMP/argv-$id.log"
  if out=$(ARGV_LOG="$TMP/argv-$id.log" AGMSG_DIR="$TMP/agmsg" RUNNERS_CONFIG_PATH="$TMP/runners.json" \
      bash "$dir/prewarm-panes.sh" --with-design --agmsg-team demo-team \
        --cwd "$repo" --slug "$id" --status-dir "$TMP/status-$id" \
        --claude-runner claude --exec-choice claude 2>&1); then
    bad "$id must die (fail-fast) but exited 0: $out"
    return
  fi
  [[ ! -s "$TMP/argv-$id.log" ]] \
    && pass "$id 何のペインも起動しないまま die する" \
    || bad "$id die する前にペインを起動してしまった: $(cat "$TMP/argv-$id.log")"
  [[ ! -f "$TMP/status-$id/prewarm.json" ]] \
    && pass "$id prewarm.json を書かない" \
    || bad "$id prewarm.json が書かれてしまった (die のはず)"
  grep -q 'readiness clause cannot be composed safely' <<<"$out" \
    && pass "$id die のメッセージが readiness 句の合成失敗を示す" \
    || bad "$id die メッセージが期待と異なる: $out"
}

run_readiness_die_case pw14 "space dir"
run_readiness_die_case pw14b "qu'ote-dir"

[[ $fail -eq 0 ]] && echo '--- all tests passed ---' || echo '--- failures ---'
exit "$fail"
