#!/usr/bin/env bash
# prewarm-panes.sh が設計ペインと claude executor へ渡す権限フラグの非対称の回帰テスト。
#
# 本ファイルは launch-workspace.sh をスタブへ差し替えるため、Step 2a の注入判定や
# フォールバックのコードには到達しない。固定するのは「claude 設計ペインには
# --skip-permissions が渡らず (settings 注入に依存する)、claude executor には
# 無条件で渡る」という既存の非対称であって、フォールバック機構の回帰ではない。

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
  # worktree は事前に作っておく。未作成のまま渡すと prewarm-panes.sh の
  # `git worktree add` が「テストを起動したリポジトリ」に対して走り、実リポジトリへ
  # ブランチと worktree 登録を残してしまう。使い捨て repo を cwd にするのは二重防御。
  mkdir -p "$TMP/repo-$slug"
  ( cd "$TMP/repo" && ARGV_LOG="$CASE_LOG" AGMSG_DIR="$TMP/agmsg" \
      RUNNERS_CONFIG_PATH="$TMP/runners.json" \
      bash "$TMP/scripts/prewarm-panes.sh" --with-design --agmsg-team demo-team \
        --cwd "$TMP/repo-$slug" --slug "$slug" --status-dir "$TMP/status-$slug" "$@" ) >/dev/null
}

# pane 行を --agmsg-from で特定する。末尾スペースを付けないと <slug> が <slug>-claude にも
# 前方一致する。--role exec での特定は --exec-choice ask のとき claude / codex の 2 行に
# マッチしてしまうので使わない。--agmsg-team は必須 (--with-design は無いと die する)。
pane_line() {
  grep -F -- "--agmsg-from $1 " "$CASE_LOG" || true
}

# <id> <pane-agent> <yes|no>: その pane 行に --skip-permissions があるか
expect_flag() {
  local id="$1" agent="$2" want="$3" line
  line=$(pane_line "$agent")
  if [[ -z "$line" ]]; then
    bad "$id pane '$agent' was not launched"
    return
  fi
  if grep -Fq -- '--skip-permissions' <<<"$line"; then
    [[ "$want" == yes ]] && pass "$id pane '$agent' carries --skip-permissions" \
                         || bad  "$id pane '$agent' must NOT carry --skip-permissions: $line"
  else
    [[ "$want" == no ]] && pass "$id pane '$agent' carries no --skip-permissions" \
                        || bad  "$id pane '$agent' must carry --skip-permissions: $line"
  fi
}

# --- DB1: claude 設計にはフラグ無し / claude executor にはフラグ有り ---
run_case db1 --design-runner claude --exec-runner claude --exec-choice claude
expect_flag DB1 db1 no
expect_flag DB1 db1-claude yes

# --- DB2: codex 設計にもフラグ無し ---
run_case db2 --design-runner codex --exec-runner codex --exec-choice codex
expect_flag DB2 db2 no

[[ $fail -eq 0 ]] && echo '--- all tests passed ---' || echo '--- failures ---'
exit "$fail"
