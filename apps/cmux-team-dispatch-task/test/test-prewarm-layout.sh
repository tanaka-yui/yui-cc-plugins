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
# PW1-PW10: 全ロールの初期プロンプトへの agmsg guard 注入
# ==========================================================================

# --- PW1 / PW3 / PW4 / PW5 / PW10: 配線成功時、design/claude/codex/review の
#     全ロールに guard が乗り、watcher が delivery と一致し、禁止文字・改行が無い ---
run_case pw1 --design-runner claude --reviewer-runner codex \
  --claude-runner claude --codex-runner codex --exec-choice ask

# PW1: prewarm.json の watcher キー
jq -e '[.. | objects | select(has("delivery")) | has("watcher")] | all' \
  "$TMP/status-pw1/prewarm.json" >/dev/null \
  && pass 'PW1 delivery を持つ全ロールに watcher がある' \
  || bad 'PW1 delivery を持つロールに watcher が無い'
jq -e '[.. | objects | select(has("delivery")) | (.delivery == "agmsg") == (.watcher == "guard-injected")] | all' \
  "$TMP/status-pw1/prewarm.json" >/dev/null \
  && pass 'PW1 delivery と watcher が一致する' \
  || bad 'PW1 delivery と watcher が不一致'

# PW3: guard が実際にプロンプトへ埋め込まれる
[[ -s "$TMP/argv-pw1.log" ]] || bad 'PW3 argv-pw1.log が空'
grep -q 'ensure-agmsg-ready.sh' "$TMP/argv-pw1.log" \
  && pass 'PW3 guard が注入される' || bad 'PW3 guard が注入されていない'

# PW4: 旧 /agmsg actas 文言が完全に消えている
grep -q '/agmsg actas' "$TMP/argv-pw1.log" \
  && bad 'PW4 /agmsg actas が残っている' || pass 'PW4 /agmsg actas は残っていない'

# PW5: 禁止文字 (' " ` $ ! \) が一切無く、改行でペイン数が壊れていない
grep -qE "['\"\`\$!\\\\]" "$TMP/argv-pw1.log" \
  && bad 'PW5 禁止文字がプロンプトに含まれる' || pass 'PW5 禁止文字は含まれない'
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

# PW10b: legacy --review-model 経路にも --agmsg-from が渡る
# guard 注入は REVIEW_DELIVERY だけを見るので、この分岐で --agmsg-from を落とすと
# 「guard は注入されるのに runner script へ export AGMSG_EXPECTED_NAME が出ない」状態に
# なる。ネストしたディスパッチで外側の名前を継承すると guard が rc 2 (usage) で死ぬのに、
# prewarm.json は watcher: guard-injected と報告してしまう。
run_case pw10b --design-runner claude --review-model gpt-5.6-sol \
  --claude-runner claude --codex-runner codex --exec-choice claude
grep -Fq -- '--agmsg-from pw10b-review ' "$TMP/argv-pw10b.log" \
  && pass 'PW10b legacy --review-model にも --agmsg-from が渡る' \
  || bad 'PW10b legacy --review-model で --agmsg-from が落ちている'
grep -Fq -- '--name pw10b-review ' "$TMP/argv-pw10b.log" \
  && pass 'PW10b legacy review にも guard が注入される' \
  || bad 'PW10b legacy review に guard が注入されていない'

# --- PW1c: codex design (design (claude / codex 共通) の codex 側も guard を持つ) ---
run_case pw1c --design-runner codex --reviewer-runner codex \
  --claude-runner claude --exec-choice claude
codex_design_line=$(pane_line pw1c)
[[ "$codex_design_line" == *'ensure-agmsg-ready.sh'* ]] \
  && pass 'PW1c codex design にも guard が注入される' \
  || bad 'PW1c codex design に guard が注入されていない'

# --- PW2: delivery.sh set が全て失敗する場合、全ロールの watcher が none になり
#     guard もプロンプトへ現れない ---
mkdir -p "$TMP/repo-pw2"
: > "$TMP/argv-pw2.log"
AGMSG_STUB_DELIVERY_RC=1 ARGV_LOG="$TMP/argv-pw2.log" AGMSG_DIR="$TMP/agmsg" RUNNERS_CONFIG_PATH="$TMP/runners.json" \
  bash "$TMP/scripts/prewarm-panes.sh" --with-design --agmsg-team demo-team \
    --cwd "$TMP/repo-pw2" --slug pw2 --status-dir "$TMP/status-pw2" \
    --design-runner claude --reviewer-runner codex \
    --claude-runner claude --codex-runner codex --exec-choice ask >/dev/null
grep -q 'ensure-agmsg-ready.sh' "$TMP/argv-pw2.log" \
  && bad 'PW2 delivery 失敗時に guard が注入された' \
  || pass 'PW2 delivery 失敗時は guard を注入しない'
jq -e '[.. | objects | select(has("delivery")) | .watcher] | all(. == "none")' \
  "$TMP/status-pw2/prewarm.json" >/dev/null \
  && pass 'PW2 delivery 失敗時は全ロール watcher: none' \
  || bad 'PW2 watcher が none になっていないロールがある'

# --- PW5b: SCRIPT_DIR に空白があるときは guard を注入しない (GUARD_INJECTABLE=0) ---
SP_DIR="$TMP/space dir/scripts"
mkdir -p "$SP_DIR" "$TMP/space dir/repo-pw5b"
cp "$PREWARM" "$SP_DIR/prewarm-panes.sh"
cp "$TMP/scripts/launch-workspace.sh" "$SP_DIR/launch-workspace.sh"
chmod +x "$SP_DIR/launch-workspace.sh"
: > "$TMP/argv-pw5b.log"
ARGV_LOG="$TMP/argv-pw5b.log" AGMSG_DIR="$TMP/agmsg" RUNNERS_CONFIG_PATH="$TMP/runners.json" \
  bash "$SP_DIR/prewarm-panes.sh" --with-design --agmsg-team demo-team \
    --cwd "$TMP/space dir/repo-pw5b" --slug pw5b --status-dir "$TMP/status-pw5b" \
    --claude-runner claude --exec-choice claude >/dev/null
grep -q 'ensure-agmsg-ready.sh' "$TMP/argv-pw5b.log" \
  && bad 'PW5b SCRIPT_DIR に空白があるのに guard を注入した' \
  || pass 'PW5b SCRIPT_DIR に空白があるときは guard を注入しない'
jq -e '.design.watcher == "none"' "$TMP/status-pw5b/prewarm.json" >/dev/null \
  && pass 'PW5b design watcher は none' || bad 'PW5b design watcher が none ではない'

# --- PW5c: SCRIPT_DIR にシェルメタ文字があるときも guard を注入しない ---
# 空白と同根。composed command は `zsh -ic "... '<prompt>' ..."` の二重引用なので、
# `'` を含むパスを埋めると引用符が破れて後続が別トークンになる。
QT_DIR="$TMP/qu'ote-dir/scripts"
mkdir -p "$QT_DIR" "$TMP/qu'ote-dir/repo-pw5c"
cp "$PREWARM" "$QT_DIR/prewarm-panes.sh"
cp "$TMP/scripts/launch-workspace.sh" "$QT_DIR/launch-workspace.sh"
chmod +x "$QT_DIR/launch-workspace.sh"
: > "$TMP/argv-pw5c.log"
ARGV_LOG="$TMP/argv-pw5c.log" AGMSG_DIR="$TMP/agmsg" RUNNERS_CONFIG_PATH="$TMP/runners.json" \
  bash "$QT_DIR/prewarm-panes.sh" --with-design --agmsg-team demo-team \
    --cwd "$TMP/qu'ote-dir/repo-pw5c" --slug pw5c --status-dir "$TMP/status-pw5c" \
    --claude-runner claude --exec-choice claude >/dev/null
grep -q 'ensure-agmsg-ready.sh' "$TMP/argv-pw5c.log" \
  && bad 'PW5c SCRIPT_DIR にメタ文字があるのに guard を注入した' \
  || pass 'PW5c SCRIPT_DIR にメタ文字があるときは guard を注入しない'
jq -e '.design.watcher == "none"' "$TMP/status-pw5c/prewarm.json" >/dev/null \
  && pass 'PW5c design watcher は none' || bad 'PW5c design watcher が none ではない'

# --- PW6: delivery.sh の AGMSG-DIRECTIVE 出力が prewarm-panes.sh 自身の stderr へ
#     漏れない (wire_delivery のリダイレクト修正の回帰) ---
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

# --- PW7: ensure-agmsg-ready.sh 自体が exit 1 でも (prewarm は文字列として
#     埋め込むだけで実行しないため) prewarm.json は正常に書かれる ---
printf '#!/usr/bin/env bash\nexit 1\n' > "$TMP/scripts/ensure-agmsg-ready.sh"
chmod +x "$TMP/scripts/ensure-agmsg-ready.sh"
mkdir -p "$TMP/repo-pw7"
: > "$TMP/argv-pw7.log"
ARGV_LOG="$TMP/argv-pw7.log" AGMSG_DIR="$TMP/agmsg" RUNNERS_CONFIG_PATH="$TMP/runners.json" \
  bash "$TMP/scripts/prewarm-panes.sh" --with-design --agmsg-team demo-team \
    --cwd "$TMP/repo-pw7" --slug pw7 --status-dir "$TMP/status-pw7" \
    --claude-runner claude --exec-choice claude >/dev/null
jq -e '.design.watcher == "guard-injected"' "$TMP/status-pw7/prewarm.json" >/dev/null \
  && pass 'PW7 guard exit 1 でも prewarm.json が正常に書かれる' \
  || bad 'PW7 prewarm.json が期待どおりに書かれていない'

# --- PW8: --agmsg-team 無しでは guard を載せない ---
mkdir -p "$TMP/repo-pw8"
: > "$TMP/argv-noteam.log"
ARGV_LOG="$TMP/argv-noteam.log" AGMSG_DIR="$TMP/agmsg" RUNNERS_CONFIG_PATH="$TMP/runners.json" \
  bash "$TMP/scripts/prewarm-panes.sh" \
    --workspace workspace:1 --base-surface surface:1 \
    --cwd "$TMP/repo-pw8" --slug pw8 --status-dir "$TMP/status-pw8" \
    --claude-runner claude --codex-runner codex --exec-choice ask >/dev/null
grep -q 'ensure-agmsg-ready.sh' "$TMP/argv-noteam.log" \
  && bad 'PW8 --agmsg-team 無しで guard が注入された' \
  || pass 'PW8 --agmsg-team 無しでは guard を載せない'

# --- PW9: design の join だけが失敗するとき、design gate は DESIGN_DELIVERY を
#     見るべきで、claude executor の join/delivery 成功に引きずられて design へ
#     guard が漏れてはならない (DESIGN_DELIVERY gate バグの回帰) ---
mkdir -p "$TMP/repo-pw9"
: > "$TMP/argv-pw9.log"
AGMSG_STUB_JOIN_FAIL=pw9 ARGV_LOG="$TMP/argv-pw9.log" AGMSG_DIR="$TMP/agmsg" RUNNERS_CONFIG_PATH="$TMP/runners.json" \
  bash "$TMP/scripts/prewarm-panes.sh" --with-design --agmsg-team demo-team \
    --cwd "$TMP/repo-pw9" --slug pw9 --status-dir "$TMP/status-pw9" \
    --claude-runner claude --exec-choice claude >/dev/null
CASE_LOG="$TMP/argv-pw9.log"
pw9_design_line=$(pane_line pw9)
pw9_claude_line=$(pane_line pw9-claude)
[[ -n "$pw9_design_line" && "$pw9_design_line" != *'ensure-agmsg-ready.sh'* ]] \
  && pass 'PW9 design join 失敗時は design プロンプトに guard が無い' \
  || bad 'PW9 design プロンプトに guard が (誤って) 含まれる'
[[ -n "$pw9_claude_line" && "$pw9_claude_line" == *'ensure-agmsg-ready.sh'* ]] \
  && pass 'PW9 claude executor の join は独立して成功し guard が乗る' \
  || bad 'PW9 claude executor に guard が乗っていない'
jq -e '.design.watcher == "none"' "$TMP/status-pw9/prewarm.json" >/dev/null \
  && pass 'PW9 design watcher は none' || bad 'PW9 design watcher が none ではない'

[[ $fail -eq 0 ]] && echo '--- all tests passed ---' || echo '--- failures ---'
exit "$fail"
