#!/usr/bin/env bash
# launch-workspace.sh が --review-config 指定時に生成する REVIEW_INSTRUCTION の回帰テスト。
# 検証項目: liveness 待機文言 / 旧 15 分タイムアウト文言の除去 / reviewer_workspace の
# read-screen への埋め込み（欠落時フォールバック含む）/ クォート文字の混入なし /
# reviewer_engine による並列レビュー指示の埋め込み（欠落時は非注入）。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCH="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/launch-workspace.sh"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/repo" "$TMP/status/review"
git -C "$TMP/repo" init -q
git -C "$TMP/repo" config user.email test@example.invalid
git -C "$TMP/repo" config user.name test
touch "$TMP/repo/.gitkeep"
git -C "$TMP/repo" add .gitkeep
git -C "$TMP/repo" commit -qm init

cat > "$TMP/bin/cmux" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  new-workspace) echo 'workspace:1' ;;
  list-pane-surfaces) echo 'surface:2' ;;
  rename-workspace|rename-tab|notify|send|send-key|wait-for|identify) ;;
  *) echo "unexpected cmux command: $*" >&2; exit 1 ;;
esac
STUB
chmod +x "$TMP/bin/cmux"

cat > "$TMP/runners.json" <<'JSON'
{
  "default": "codex",
  "runners": [
    { "name": "codex", "command": "codex", "engine": "codex" },
    { "name": "claude", "command": "claude", "engine": "claude" }
  ]
}
JSON

cat > "$TMP/status/review/code-review.json" <<JSON
{
  "reviewer_surface": "surface:99",
  "reviewer_workspace": "workspace:7",
  "review_dir": "$TMP/status/review"
}
JSON

cat > "$TMP/status/review/code-review-legacy.json" <<JSON
{
  "reviewer_surface": "surface:99",
  "review_dir": "$TMP/status/review"
}
JSON

cat > "$TMP/status/review/code-review-codex-reviewer.json" <<JSON
{
  "reviewer_surface": "surface:99",
  "reviewer_workspace": "workspace:7",
  "reviewer_engine": "codex",
  "review_dir": "$TMP/status/review"
}
JSON

cat > "$TMP/status/review/code-review-claude-reviewer.json" <<JSON
{
  "reviewer_surface": "surface:99",
  "reviewer_workspace": "workspace:7",
  "reviewer_engine": "claude",
  "review_dir": "$TMP/status/review"
}
JSON

fail=0

assert_contains() {
  local file="$1" expected="$2" label="$3"
  if grep -Fq -- "$expected" "$file"; then
    echo "PASS: $label"
  else
    echo "FAIL: $label (missing: $expected)"
    fail=1
  fi
}

assert_not_contains() {
  local file="$1" unexpected="$2" label="$3"
  if grep -Fq -- "$unexpected" "$file"; then
    echo "FAIL: $label (unexpected: $unexpected)"
    fail=1
  else
    echo "PASS: $label"
  fi
}

runner_with_config() {
  local runner="$1" config="$2" name="$3"
  local output
  # --no-parallel で起動プロンプト側のディレクティブを止め、レビュー依頼文への
  # 注入だけを切り分けて検査する
  output=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" bash "$LAUNCH" \
    --cwd "$TMP/repo" --mode execute --runner "$runner" --plan-file "$TMP/plan.md" \
    --status-dir "$TMP/status" --review-config "$config" --no-parallel "$name")
  jq -r '.runner_file' <<<"$output"
}

runner_file=$(runner_with_config claude "$TMP/status/review/code-review.json" review-cfg-claude)

assert_contains "$runner_file" 'MANDATORY CODE REVIEW' 'T1 review protocol injected'
assert_contains "$runner_file" 'read-screen --workspace workspace:7 --surface surface:99' 'T2 read-screen uses reviewer_workspace'
assert_contains "$runner_file" 'send --workspace workspace:7 --surface surface:99' 'T2 send uses reviewer_workspace'
assert_contains "$runner_file" 'send-key --workspace workspace:7 --surface surface:99 return' 'T2 send-key uses reviewer_workspace'
assert_contains "$runner_file" '15-minute chunks with no overall time limit' 'T3 liveness wording present'
assert_contains "$runner_file" '2 consecutive all-failed boundaries count as stalled' 'T3 observation-failure rule present'
assert_contains "$runner_file" 'one final time immediately before any re-send or skip decision' 'T3 final verdict re-check present'
assert_not_contains "$runner_file" 'up to 15 minutes' 'T4 old timeout wording removed'

# REVIEW_INSTRUCTION 部分にクォート文字が混入していないこと (inner prompt の '...' を壊さないため)
review_segment=$(grep -o 'MANDATORY CODE REVIEW.*in the PR body and proceed\.' "$runner_file" | head -1)
if [[ -z "$review_segment" ]]; then
  echo 'FAIL: T5 review segment not extractable'
  fail=1
elif [[ "$review_segment" == *\'* || "$review_segment" == *\"* ]]; then
  echo 'FAIL: T5 review instruction contains quote characters'
  fail=1
else
  echo 'PASS: T5 review instruction is quote-free'
fi

# 旧スキーマ (reviewer_workspace なし) では --workspace 指定なしにフォールバックする
legacy_runner=$(runner_with_config codex "$TMP/status/review/code-review-legacy.json" review-cfg-legacy)
assert_contains "$legacy_runner" 'read-screen --surface surface:99' 'T6 legacy config falls back to surface-only read-screen'
assert_contains "$legacy_runner" 'send --surface surface:99' 'T6 legacy config falls back to surface-only send'
assert_not_contains "$legacy_runner" '--workspace workspace:7' 'T6 legacy config has no --workspace flag'

# --- PR1: reviewer_engine ありならレビュー依頼文に review モードのディレクティブが入る ---
codex_reviewer=$(runner_with_config claude "$TMP/status/review/code-review-codex-reviewer.json" review-cfg-codex-rev)
assert_contains "$codex_reviewer" 'PARALLEL EXECUTION, mandatory' 'PR1 reviewer_engine=codex でディレクティブが入る'
assert_contains "$codex_reviewer" 'spawn_agent' 'PR1 codex レビュアーには spawn_agent が届く'
assert_contains "$codex_reviewer" 'Give each review lens its own child agent' 'PR1 review モードの文面が使われる'

claude_reviewer=$(runner_with_config codex "$TMP/status/review/code-review-claude-reviewer.json" review-cfg-claude-rev)
assert_contains "$claude_reviewer" 'Task subagents' 'PR1 claude レビュアーには Task サブエージェント指示が届く'
assert_not_contains "$claude_reviewer" 'spawn_agent' 'PR1 claude レビュアーに spawn_agent は届かない'

# --- PR2: reviewer_engine 欠落 (旧スキーマ) では注入しない ---
assert_not_contains "$runner_file" 'PARALLEL EXECUTION, mandatory' 'PR2 reviewer_engine 欠落ではディレクティブ非注入'
assert_not_contains "$legacy_runner" 'PARALLEL EXECUTION, mandatory' 'PR2 旧スキーマではディレクティブ非注入'

# --- PR3: ディレクティブを足しても REVIEW_INSTRUCTION はクォートフリーのまま ---
pr3_segment=$(grep -o 'MANDATORY CODE REVIEW.*in the PR body and proceed\.' "$codex_reviewer" | head -1)
if [[ -z "$pr3_segment" ]]; then
  echo 'FAIL: PR3 review segment not extractable'
  fail=1
elif [[ "$pr3_segment" == *\'* || "$pr3_segment" == *\"* || "$pr3_segment" == *\`* ]]; then
  echo 'FAIL: PR3 review instruction contains quote characters'
  fail=1
else
  echo 'PASS: PR3 review instruction is quote-free with the directive'
fi

[[ $fail -eq 0 ]] && echo '--- all tests passed ---' || echo '--- failures ---'
exit "$fail"
