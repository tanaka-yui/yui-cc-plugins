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

[[ $fail -eq 0 ]] && echo '--- all tests passed ---' || echo '--- failures ---'
exit "$fail"
