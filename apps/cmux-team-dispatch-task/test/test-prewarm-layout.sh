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
# I5: delivery.sh set とペイン起動の順序を検査するため、AGMSG_LOG が設定されて
# いれば同一ログへも追記する (delivery.sh スタブと合わせて使う)。
[[ -n "${AGMSG_LOG:-}" ]] && printf '%s %s\n' "$(basename "$0")" "$*" >> "$AGMSG_LOG"
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
[[ -n "${AGMSG_LOG:-}" ]] && printf '%s %s\n' "$(basename "$0")" "$*" >> "$AGMSG_LOG"
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
# PW1-PW17: 全ロールの初期プロンプトへの readiness 確立句 (readiness_clause) 注入
# ==========================================================================
#
# guard_clause() / ensure-agmsg-ready.sh (nohup watcher) は廃止された。
# 新設計では claude は Monitor ツール起動、codex は seat 記録 (codex-record-session.sh)
# を行い、どちらも最後に親へ send.sh 経由で本文が厳密に `[ready] <name>` (末尾ピリオド
# 無し) のメッセージを送る指示をプロンプトに埋め込む。「実行するコマンド」を一字一句
# 指定する形にはしていない (I3: 文中の句点が本文へ混入する / I4: `[ready]` を
# 引用せず zsh 上で直接実行させると glob 展開で送信コマンド自体が実行されない、の
# 2 つの実測済みバグを避けるため)。fallback は無いので、join / delivery.sh set が
# 失敗すると die し、ペインは 1 つも起動しない (PW2 / PW9 がこの no-fallback 特性を
# 検査する)。

# <id> <agent>: そのペインの起動プロンプトに [ready] 送信の readiness 句
# (本文を 1 個の引数として渡す指示 + 末尾ピリオド無し) が入っているか
expect_readiness() {
  local id="$1" agent="$2" line
  line=$(pane_line "$agent")
  if [[ -z "$line" ]]; then
    bad "$id pane '$agent' was not launched"
    return
  fi
  if grep -Fq -- "[ready] $agent with no trailing period" <<<"$line" \
     && grep -Fq -- 'quoted as a single argument' <<<"$line" \
     && grep -Fq -- "send.sh with team demo-team, from $agent, to parent" <<<"$line"; then
    pass "$id pane '$agent' carries the readiness clause ([ready] send instruction, single-argument body, no trailing period)"
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
#  fallback が無いのでロールが存在する限り必ず true — 呼び出し元はこの値で分岐しない)。
# M5: select する前に対象ロール数を数え、0 件の空虚な PASS を防ぐ。
jq -e '[.. | objects | select(has("surface_id"))] | length == 4' \
  "$TMP/status-pw1/prewarm.json" >/dev/null \
  && pass 'PW1 4 ロール分のオブジェクトが存在する (以降の any/all が空虚な PASS ではない)' \
  || bad 'PW1 ロール数が 4 ではない'
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

# PW5: 禁止文字 (' " ` $ ! \) が一切無く、改行でペイン数が壊れていない。
# I3/I4 の修正で「実行するコマンド」の直書きを廃したため、[ready] の空白保護のための
# バックスラッシュも不要になった (禁止文字集合に例外は無い)。
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

# PW10b: legacy --review-model 経路にも --agmsg-from と readiness 句 (codex seat 記録)
# が渡る (review は REVIEWER_ENGINE 未設定時に codex 既定になるため)
run_case pw10b --design-runner claude --review-model gpt-5.6-sol \
  --claude-runner claude --codex-runner codex --exec-choice claude
grep -Fq -- '--agmsg-from pw10b-review ' "$TMP/argv-pw10b.log" \
  && pass 'PW10b legacy --review-model にも --agmsg-from が渡る' \
  || bad 'PW10b legacy --review-model で --agmsg-from が落ちている'
grep -Fq -- 'codex-record-session.sh with team demo-team and agent name pw10b-review' "$TMP/argv-pw10b.log" \
  && pass 'PW10b legacy review にも readiness 句 (codex seat 記録) が注入される' \
  || bad 'PW10b legacy review に readiness 句が注入されていない'

# --- PW1c: codex design (design (claude / codex 共通) の codex 側も readiness 句を持つ) ---
run_case pw1c --design-runner codex --reviewer-runner codex \
  --claude-runner claude --exec-choice claude
codex_design_line=$(pane_line pw1c)
[[ "$codex_design_line" == *'codex-record-session.sh'* ]] \
  && pass 'PW1c codex design にも readiness 句 (codex seat 記録) が注入される' \
  || bad 'PW1c codex design に readiness 句が注入されていない'

# --- PW2: delivery.sh set が失敗すると die し、ペインを 1 つも起動しない (I1: no
#     fallback の直接検証)。cmux-send フォールバックは廃止済みなので、配線が失敗した
#     まま readiness 句だけ注入されると親が [ready] を永久に待つことになる — それを
#     許してはならない。旧 PW2 は逆に「delivery 失敗時も readiness 句を注入する」を
#     期待値にしていたが、これは fallback を許す挙動であり制約違反だったため反転した ---
mkdir -p "$TMP/repo-pw2"
: > "$TMP/argv-pw2.log"
if out=$(AGMSG_STUB_DELIVERY_RC=1 ARGV_LOG="$TMP/argv-pw2.log" AGMSG_DIR="$TMP/agmsg" RUNNERS_CONFIG_PATH="$TMP/runners.json" \
    bash "$TMP/scripts/prewarm-panes.sh" --with-design --agmsg-team demo-team \
      --cwd "$TMP/repo-pw2" --slug pw2 --status-dir "$TMP/status-pw2" \
      --design-runner claude --reviewer-runner codex \
      --claude-runner claude --codex-runner codex --exec-choice ask 2>&1); then
  bad "PW2 delivery.sh set 失敗時に die しなかった (exit 0): $out"
else
  [[ ! -s "$TMP/argv-pw2.log" ]] \
    && pass 'PW2 delivery.sh set 失敗時はペインを 1 つも起動しない' \
    || bad "PW2 die する前にペインを起動してしまった: $(cat "$TMP/argv-pw2.log")"
  [[ ! -f "$TMP/status-pw2/prewarm.json" ]] \
    && pass 'PW2 delivery.sh set 失敗時は prewarm.json を書かない' \
    || bad 'PW2 prewarm.json が書かれてしまった (die のはず)'
  grep -q 'delivery wiring failed' <<<"$out" \
    && pass 'PW2 die メッセージが delivery.sh set の失敗を示す' \
    || bad "PW2 die メッセージが期待と異なる: $out"
fi

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

# --- PW9: design の join が失敗すると die し、ペインを 1 つも起動しない (I1: no
#     fallback。旧 PW9 は「design join 失敗時は design だけ readiness 句が乗らないが
#     claude executor は独立して起動する」を期待値にしていたが、これも fallback を
#     許す挙動であり制約違反だったため反転した) ---
mkdir -p "$TMP/repo-pw9"
: > "$TMP/argv-pw9.log"
if out=$(AGMSG_STUB_JOIN_FAIL=pw9 ARGV_LOG="$TMP/argv-pw9.log" AGMSG_DIR="$TMP/agmsg" RUNNERS_CONFIG_PATH="$TMP/runners.json" \
    bash "$TMP/scripts/prewarm-panes.sh" --with-design --agmsg-team demo-team \
      --cwd "$TMP/repo-pw9" --slug pw9 --status-dir "$TMP/status-pw9" \
      --claude-runner claude --exec-choice claude 2>&1); then
  bad "PW9 design join 失敗時に die しなかった (exit 0): $out"
else
  [[ ! -s "$TMP/argv-pw9.log" ]] \
    && pass 'PW9 design join 失敗時はペインを 1 つも起動しない (claude executor も含む)' \
    || bad "PW9 die する前にペインを起動してしまった: $(cat "$TMP/argv-pw9.log")"
  [[ ! -f "$TMP/status-pw9/prewarm.json" ]] \
    && pass 'PW9 design join 失敗時は prewarm.json を書かない' \
    || bad 'PW9 prewarm.json が書かれてしまった (die のはず)'
  grep -q 'design agmsg join failed' <<<"$out" \
    && pass 'PW9 die メッセージが design join の失敗を示す' \
    || bad "PW9 die メッセージが期待と異なる: $out"
fi

# ==========================================================================
# PW11-PW17: readiness_clause 導入 (Task 2) 自体の回帰
# ==========================================================================

# PW2/PW9 は run_case を使わず CASE_LOG に触れないが、PW1c の run_case が CASE_LOG を
# argv-pw1c.log へ進めている。pw1 の行を見る PW11-13/16/17 の前に戻す
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

# --- PW14 / PW14b (I2): SCRIPT_DIR ではなく readiness_clause が実際に埋め込む
#     AGMSG_DIR / AGMSG_TEAM にシェルメタ文字があるとき、引数パース直後に die し、
#     worktree も agmsg join も一切行わない (孤児防止)。SCRIPT_DIR はもうプロンプトに
#     埋め込まないため、SCRIPT_DIR ベースの旧テストはここで保護対象ごと入れ替えた ---
run_metachar_die_case() {  # <id> <cwd (まだ存在しない)> <agmsg-dir> <agmsg-team>
  local id="$1" cwd="$2" adir="$3" ateam="$4"
  : > "$TMP/argv-$id.log"
  : > "$TMP/agmsg-$id.log"
  if out=$(ARGV_LOG="$TMP/argv-$id.log" AGMSG_LOG="$TMP/agmsg-$id.log" AGMSG_DIR="$adir" \
      RUNNERS_CONFIG_PATH="$TMP/runners.json" \
      bash "$TMP/scripts/prewarm-panes.sh" --with-design --agmsg-team "$ateam" \
        --cwd "$cwd" --slug "$id" --status-dir "$TMP/status-$id" \
        --claude-runner claude --exec-choice claude 2>&1); then
    bad "$id must die (fail-fast) but exited 0: $out"
    return
  fi
  [[ ! -d "$cwd" ]] \
    && pass "$id worktree を作らないまま die する (孤児 worktree 無し)" \
    || bad "$id die する前に worktree ($cwd) を作ってしまった"
  [[ ! -s "$TMP/agmsg-$id.log" ]] \
    && pass "$id agmsg join / delivery.sh を一切呼ばないまま die する (孤児 team member 無し)" \
    || bad "$id die する前に agmsg join/delivery を呼んでしまった: $(cat "$TMP/agmsg-$id.log")"
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

run_metachar_die_case pw14 "$TMP/would-be-repo-pw14" "$TMP/agmsg" "dispatch my project"
run_metachar_die_case pw14b "$TMP/would-be-repo-pw14b" "$TMP/qu'ote-agmsg" demo-team

# --- PW15 (I5): delivery.sh set が最初のペイン起動より前であることの静的検査。
#     brief Step 1 の「hook 順序の不変条件」(F1 同型)。この順序が破れると claude
#     ロールの SessionStart hook が注入されないまま readiness 句だけ注入され、
#     fallback 全廃後は必ず不通になる。join.sh / delivery.sh / launch-workspace.sh を
#     同一ログ (AGMSG_LOG) へ追記させ、delivery.sh の行が最初の pane 行より前で
#     あることを検査する ---
mkdir -p "$TMP/repo-pw15"
: > "$TMP/order-pw15.log"
: > "$TMP/argv-pw15.log"
ARGV_LOG="$TMP/argv-pw15.log" AGMSG_LOG="$TMP/order-pw15.log" AGMSG_DIR="$TMP/agmsg" RUNNERS_CONFIG_PATH="$TMP/runners.json" \
  bash "$TMP/scripts/prewarm-panes.sh" --with-design --agmsg-team demo-team \
    --cwd "$TMP/repo-pw15" --slug pw15 --status-dir "$TMP/status-pw15" \
    --claude-runner claude --exec-choice claude >/dev/null
first_delivery=$(grep -n '^delivery.sh ' "$TMP/order-pw15.log" | head -1 | cut -d: -f1)
first_pane=$(grep -n '^launch-workspace.sh ' "$TMP/order-pw15.log" | head -1 | cut -d: -f1)
if [[ -z "$first_delivery" || -z "$first_pane" ]]; then
  bad "PW15 order-pw15.log に delivery.sh / launch-workspace.sh の行が無い: $(cat "$TMP/order-pw15.log")"
elif [[ "$first_delivery" -lt "$first_pane" ]]; then
  pass 'PW15 delivery.sh set はペイン起動より前に走る'
else
  bad "PW15 delivery.sh set がペイン起動より後になっている (順序崩壊): $(cat "$TMP/order-pw15.log")"
fi

# --- PW16 (I3 実測の回帰): 送信本文の指示に「[ready] <name>」直後の直付けピリオドが
#     無い。実測: 旧文面は本文を実行コマンドとして直書きしていたため、末尾ピリオドが
#     引数へ混入し BODY=[[ready] pw1.] argc=4 になっていた。新文面は名前の直後を
#     必ず空白 (" with") にする ---
for agent in pw1 pw1-claude pw1-codex pw1-review; do
  grep -Fq -- "[ready] $agent." "$TMP/argv-pw1.log" \
    && bad "PW16 pane '$agent' の readiness 句に [ready] <name> 直後の直付けピリオドが残っている" \
    || pass "PW16 pane '$agent' に [ready] <name>. の直付けピリオドは無い"
done

# --- PW17 (I4 実測の回帰、静的検査): send.sh を「実行するコマンド」の直書きとして
#     指示していない。実測: `zsh -c 'bash send.sh ... [ready] name.'` は
#     `zsh:1: no matches found: [ready] name.` で送信コマンド自体が実行されない。
#     launch-workspace.sh をスタブする prewarm 系スイートはこの glob 展開を動的に
#     検出できない (M7 としてコントローラが park 済み) ため、文面の性質を静的に固定する ---
grep -q 'run this exact command' "$TMP/argv-pw1.log" \
  && bad 'PW17 send.sh を直書きの実行コマンドとして指示している (glob 展開の危険再発)' \
  || pass 'PW17 send.sh は「送るメッセージ」の記述であり、直書きコマンドではない'
grep -q 'quoted as a single argument' "$TMP/argv-pw1.log" \
  && pass 'PW17 本文を 1 個の引数として渡すことが明示されている' \
  || bad 'PW17 本文を 1 個の引数として渡す指示が無い'

[[ $fail -eq 0 ]] && echo '--- all tests passed ---' || echo '--- failures ---'
exit "$fail"
