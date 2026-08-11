#!/usr/bin/env bash
# launch-workspace.sh が Codex runner 向けに生成するコマンドの回帰テスト。
# 並列実行ディレクティブ (PL1-PL10) もここで検証する。
#   PL1-PL7 : launch-workspace.sh が生成する runner ファイルの動的検査
#   PL8-PL10: SKILL.md 側の $PARALLEL / $REVIEW_PARALLEL 挿入位置の静的検査

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
    {
      "name": "codex",
      "command": "codex",
      "engine": "codex",
      "review_model": "gpt-5.6-sol"
    },
    { "name": "claude", "command": "claude", "engine": "claude" }
  ]
}
JSON

fail=0

runner_for() {
  local mode="$1"
  local name="codex-$mode"
  local output
  if [[ "$mode" == "execute" ]]; then
    output=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" bash "$LAUNCH" \
      --cwd "$TMP/repo" --mode "$mode" --runner codex --plan-file "$TMP/plan.md" --status-dir "$TMP/status" "$name")
  else
    output=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" bash "$LAUNCH" \
      --cwd "$TMP/repo" --mode "$mode" --runner codex --status-dir "$TMP/status" "$name" prompt)
  fi
  jq -r '.runner_file' <<<"$output"
}

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
  # ファイルが存在しないと grep は非ゼロで返るため、この確認が無いと「起動が落ちて runner
  # ファイルが生成されなかった」ケースが全部 PASS になる (negative assertion が
  # 間違った理由で通る典型パターン)
  [[ -f "$file" ]] || { echo "FAIL: $label (no such file: $file)"; fail=1; return; }
  if grep -Fq -- "$unexpected" "$file"; then
    echo "FAIL: $label (unexpected: $unexpected)"
    fail=1
  else
    echo "PASS: $label"
  fi
}

superpowers_runner=$(runner_for superpowers)
plan_runner=$(runner_for plan)
execute_runner=$(runner_for execute)
standby_runner=$(runner_for standby)
review_runner=$(runner_for review)

runner_for_flags() {
  local mode="$1"; shift
  local name="codex-$mode-flags"
  local output
  if [[ "$mode" == "execute" ]]; then
    output=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" bash "$LAUNCH" \
      --cwd "$TMP/repo" --mode "$mode" --runner codex --plan-file "$TMP/plan.md" --status-dir "$TMP/status" "$@" "$name")
  else
    output=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" bash "$LAUNCH" \
      --cwd "$TMP/repo" --mode "$mode" --runner codex --status-dir "$TMP/status" "$@" "$name" prompt)
  fi
  jq -r '.runner_file' <<<"$output"
}

assert_contains "$superpowers_runner" '--dangerously-bypass-approvals-and-sandbox' 'T1 codex + superpowers bypass'
assert_contains "$plan_runner" '--dangerously-bypass-approvals-and-sandbox' 'T2 codex + plan bypass'
assert_contains "$execute_runner" '--dangerously-bypass-approvals-and-sandbox' 'T3 codex + execute bypass'
assert_contains "$standby_runner" '--dangerously-bypass-approvals-and-sandbox' 'T4 codex + standby bypass'
assert_contains "$review_runner" '--sandbox workspace-write' 'T5 review sandbox workspace-write'
assert_contains "$review_runner" "-c approval_policy='never'" 'T5 review approval policy never'
assert_contains "$review_runner" "--add-dir '$TMP/status'" 'T5 review status directory writable'
assert_not_contains "$review_runner" '--dangerously-bypass-approvals-and-sandbox' 'T5 review does not disable sandbox'

# --- hook trust: codex 0.145 は project-local .codex/hooks.json ごとに信頼を求める。
# agmsg が worktree ごとに新しい hooks.json を生成するためパスが毎回変わり、常に未信頼と
# 判定されて起動直後に承認待ちで停止する。approvals-and-sandbox のバイパスとは別フラグ。 ---
assert_contains "$superpowers_runner" '--dangerously-bypass-hook-trust' 'T8 codex + superpowers hook trust bypass'
assert_contains "$plan_runner" '--dangerously-bypass-hook-trust' 'T8 codex + plan hook trust bypass'
assert_contains "$execute_runner" '--dangerously-bypass-hook-trust' 'T8 codex + execute hook trust bypass'
assert_contains "$standby_runner" '--dangerously-bypass-hook-trust' 'T8 codex + standby hook trust bypass'
assert_contains "$review_runner" '--dangerously-bypass-hook-trust' 'T8 codex + review hook trust bypass'

# Exit instruction must be engine-aware: codex ends its own session (it does not
# act on /exit), claude runs /exit. If the codex execute path stopped baking the
# codex-appropriate exit instruction, the codex TUI would stay idle after the work
# and the runner wrapper would never fire the completion notification.
assert_contains "$execute_runner" 'end this codex session' 'T5b codex execute bakes codex session-end exit instruction'
assert_not_contains "$execute_runner" 'run /exit' 'T5c codex execute does not tell codex to run /exit'

for mode in superpowers plan execute standby review; do
  name="claude-$mode"
  if [[ "$mode" == "execute" ]]; then
    output=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" bash "$LAUNCH" \
      --cwd "$TMP/repo" --mode "$mode" --runner claude --plan-file "$TMP/plan.md" "$name")
  else
    output=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" bash "$LAUNCH" \
      --cwd "$TMP/repo" --mode "$mode" --runner claude "$name" prompt)
  fi
  claude_runner_file=$(jq -r '.runner_file' <<<"$output")
  assert_not_contains "$claude_runner_file" '--sandbox workspace-write' "T6 claude + $mode has no codex sandbox flag"
  assert_not_contains "$claude_runner_file" '--dangerously-bypass-approvals-and-sandbox' "T6 claude + $mode has no codex bypass"
  assert_not_contains "$claude_runner_file" '--dangerously-bypass-hook-trust' "T9 claude + $mode has no codex hook trust flag"
  [[ "$mode" == "execute" ]] \
    && assert_contains "$claude_runner_file" 'run /exit' 'T6b claude execute bakes /exit exit instruction'
done

# --- SKILL.md static check: the codex Phase B prewarm-standby block must define a
# base REQUEST_TEXT with a codex-appropriate exit instruction (regression guard for
# the "codex completion notification never arrives" bug). $PARALLEL (the
# parallel-execution directive, injected between the work instruction and the
# session-end instruction) is now part of this same string — it must stay between
# the two, with the session-end instruction still last. ---
SKILL_MD="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/SKILL.md"
assert_contains "$SKILL_MD" 'REQUEST_TEXT="Read and execute the plan at <PLAN_FILE_PATH>. $PARALLEL After all work is committed/pushed and the PR is created (or all changes are merged per the plan), end this codex session immediately' \
  'T7 SKILL.md codex prewarm block defines base REQUEST_TEXT with codex session-end exit'

# --- T14/T15: Phase B-R の拡張 REQUEST_TEXT の退行ガード ---
# Phase B-R が有効なとき、拡張 REQUEST_TEXT は codex 用 base REQUEST_TEXT を上書きする。
# 旧仕様の末尾は engine 中立の「run /exit (claude) or end the session (codex)」1 文だったため、
# codex への強い指示 (Do NOT run /exit / idle 残留禁止) が失われ、codex が TUI に居座って
# runner wrapper の完了通知に到達しない事故が起きた。さらに standby ペインは task prompt を
# 読まないので、子側の必須通知も構造的に届いていなかった。両方を固定する。
assert_contains "$SKILL_MD" 'END THE CODEX SESSION' \
  'T14 extended REQUEST_TEXT tells codex to end its own session'
assert_contains "$SKILL_MD" 'do NOT run /exit (codex does not act on it) and do NOT leave' \
  'T14 extended REQUEST_TEXT forbids /exit for codex'
assert_not_contains "$SKILL_MD" 'or end the session (codex)' \
  'T14 the ambiguous engine-neutral exit wording is gone'
assert_contains "$SKILL_MD" 'MANDATORY completion notification. You received this request as typed' \
  'T15 extended REQUEST_TEXT carries the mandatory completion notification'
assert_contains "$SKILL_MD" '<PARENT_WORKSPACE_ID> = the parent workspace ID' \
  'T15 extended REQUEST_TEXT documents the parent workspace placeholder'

# --- pr_url 引き継ぎ / timeout sentinel ガード ---
sentinel_output=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" bash "$LAUNCH" \
  --cwd "$TMP/repo" --mode standby --runner claude --status-dir "$TMP/status" \
  --timeout-sentinel "$TMP/loopstate/timed-out/sentinel-task" "sentinel-task")
sentinel_runner=$(jq -r '.runner_file' <<<"$sentinel_output")
assert_contains "$sentinel_runner" 'TIMEOUT_SENTINEL="'"$TMP"'/loopstate/timed-out/sentinel-task"' \
  'T10 --timeout-sentinel はパスを wrapper に焼き込む'
assert_contains "$sentinel_runner" 'timeout sentinel found' 'T10 wrapper に sentinel ガードがある'
assert_contains "$sentinel_runner" 'PREV_PR_URL' 'T11 write_status が既存 pr_url を読む'

# sentinel を渡さない通常経路には一切現れない（非ループ挙動の不変性）
plain_output=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" bash "$LAUNCH" \
  --cwd "$TMP/repo" --mode standby --runner claude --status-dir "$TMP/status" "plain-task")
plain_runner=$(jq -r '.runner_file' <<<"$plain_output")
assert_contains "$plain_runner" 'TIMEOUT_SENTINEL=""' 'T10 未指定時は空の sentinel パス'

# --- --unattended: spawn 経路の inner prompt から質問分岐を除去する ---
cat > "$TMP/review-config.json" <<JSON
{"reviewer_surface":"surface:9","reviewer_workspace":"workspace:3","review_dir":"$TMP/status/review"}
JSON

unattended_output=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" bash "$LAUNCH" \
  --cwd "$TMP/repo" --mode execute --runner claude --plan-file "$TMP/plan.md" \
  --status-dir "$TMP/status" --review-config "$TMP/review-config.json" --unattended "unattended-exec")
unattended_runner=$(jq -r '.runner_file' <<<"$unattended_output")
assert_not_contains "$unattended_runner" 'AskUserQuestion' 'T12 --unattended の runner に質問分岐が無い'
assert_contains "$unattended_runner" '--dangerously-skip-permissions' 'T12 --unattended は claude に skip-permissions を強制'
assert_contains "$unattended_runner" 'note the unresolved findings in the PR body and proceed' \
  'T12 --unattended は round 5 の固定フォールバックを持つ'

# 後方互換: --unattended 無しでは現行文言が保たれる
attended_output=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" bash "$LAUNCH" \
  --cwd "$TMP/repo" --mode execute --runner claude --plan-file "$TMP/plan.md" \
  --status-dir "$TMP/status" --review-config "$TMP/review-config.json" "attended-exec")
attended_runner=$(jq -r '.runner_file' <<<"$attended_output")
assert_contains "$attended_runner" 'AskUserQuestion' 'T13 --unattended 無しでは現行の質問分岐が残る'

# A1/A2/A3: spawn prompt の abort 手順は review の有無に合わせ、reviewer 宛先を捏造せず、
# inner prompt はクォート事故なく 1 引数として runner に渡される。
cat > "$TMP/bin/argv-probe" <<'PROBE'
#!/usr/bin/env bash
{ echo "argc=$#"; printf 'arg=%s\n' "$@"; } > "$ARGV_OUT"
PROBE
chmod +x "$TMP/bin/argv-probe"
cat > "$TMP/runners-probe.json" <<JSON
{
  "default": "probe",
  "runners": [
    { "name": "probe", "command": "$TMP/bin/argv-probe", "engine": "claude" }
  ]
}
JSON
mkdir -p "$TMP/abort-status/review" "$TMP/zdot"
: > "$TMP/zdot/.zshrc"
jq -n --arg d "$TMP/abort-status/review" '{reviewer_surface:"surface:55", reviewer_workspace:"workspace:5", review_dir:$d}' > "$TMP/abort-status/review/code-review.json"
a1=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners-probe.json" bash "$LAUNCH" --cwd "$TMP/repo" --mode execute --runner probe --plan-file "$TMP/plan.md" --status-dir "$TMP/abort-status" --parent-notify-workspace workspace:9 --review-config "$TMP/abort-status/review/code-review.json" abort-review)
a1_runner=$(jq -r '.runner_file' <<<"$a1")
assert_contains "$a1_runner" 'ABORT PROTOCOL' 'A1 review 有効の spawn 経路に abort 手順が入る'
assert_contains "$a1_runner" 'code-round-N.md' 'A1 review 有効時は findings 記録先を含む'
ARGV_OUT="$TMP/argv-a2.txt" ZDOTDIR="$TMP/zdot" PATH="$TMP/bin:$PATH" bash "$a1_runner" >/dev/null 2>&1 || true
a2_argc=$(grep -oE 'argc=[0-9]+' "$TMP/argv-a2.txt" 2>/dev/null | head -1 | cut -d= -f2)
if [[ "$a2_argc" == "1" ]]; then
  echo 'PASS: A2 inner prompt が単一引数として渡る'
else
  echo "FAIL: A2 inner prompt が単一引数でない (argc=${a2_argc:-none})"
  fail=1
fi
a3=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners-probe.json" bash "$LAUNCH" --cwd "$TMP/repo" --mode execute --runner probe --plan-file "$TMP/plan.md" --status-dir "$TMP/abort-status-none" --parent-notify-workspace workspace:9 abort-none)
a3_runner=$(jq -r '.runner_file' <<<"$a3")
assert_contains "$a3_runner" 'ABORT PROTOCOL' 'A3 review 無効の spawn 経路に abort 手順が入る'
assert_not_contains "$a3_runner" 'code-round-N.md' 'A3 review 無効では reviewer 手順を含めない'

# H1〜H4: security-guidance (claude-plugins-official) の hook は stdout に
# {"metrics": ...} を書くが、codex の hook 出力スキーマは additionalProperties: false
# なので必ず "invalid ... JSON output" になる。preflight は codex engine のときだけ
# 検出して警告し、config は書き換えず dispatch も止めない。誤警告ゼロ (未インストール
# 環境で黙っていること) が要件なので、無効時・config 無しのケースも固定する。
hook_warn_stderr() {
  local home="$1" runner="$2" name="$3" out="$4"
  CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" CODEX_HOME="$home" \
    bash "$LAUNCH" --cwd "$TMP/repo" --mode plan --runner "$runner" --status-dir "$TMP/status" "$name" prompt \
    >/dev/null 2>"$out"
}

HOOK_WARN='security-guidance plugin is enabled for codex'
mkdir -p "$TMP/codex-on" "$TMP/codex-off" "$TMP/codex-none"
printf '[plugins."security-guidance@claude-plugins-official"]\nenabled = true\n' > "$TMP/codex-on/config.toml"
printf '[plugins."security-guidance@claude-plugins-official"]\nenabled = false\n' > "$TMP/codex-off/config.toml"

hook_warn_stderr "$TMP/codex-on" codex hook-on "$TMP/h1.log"
hook_warn_stderr "$TMP/codex-off" codex hook-off "$TMP/h2.log"
hook_warn_stderr "$TMP/codex-none" codex hook-none "$TMP/h3.log"
# 警告は claude engine には出さない (非互換なのは codex の hook 出力スキーマだけ)
hook_warn_stderr "$TMP/codex-on" claude hook-claude "$TMP/h4.log"

assert_contains "$TMP/h1.log" "$HOOK_WARN" 'H1 security-guidance 有効時に警告する'
assert_not_contains "$TMP/h2.log" "$HOOK_WARN" 'H2 security-guidance 無効時は警告しない'
assert_not_contains "$TMP/h3.log" "$HOOK_WARN" 'H3 codex config が無い環境では警告しない'
assert_not_contains "$TMP/h4.log" "$HOOK_WARN" 'H4 claude engine では警告しない'

if command -v codex >/dev/null 2>&1 && [[ "${RUN_CODEX_DYNAMIC_TEST:-0}" == "1" ]]; then
  echo 'INFO: dynamic Codex writable-root test is enabled externally.'
else
  echo 'SKIP: dynamic Codex writable-root test (set RUN_CODEX_DYNAMIC_TEST=1 in an authenticated Codex environment).'
fi

# --- PL1: plan / superpowers / execute の起動プロンプトにディレクティブが入る ---
assert_contains "$plan_runner" 'PARALLEL EXECUTION, mandatory' 'PL1 codex plan で並列ディレクティブが入る'
assert_contains "$superpowers_runner" 'PARALLEL EXECUTION, mandatory' 'PL1 codex superpowers で並列ディレクティブが入る'
assert_contains "$execute_runner" 'PARALLEL EXECUTION, mandatory' 'PL1 codex execute で並列ディレクティブが入る'
assert_contains "$execute_runner" 'spawn_agent' 'PL1 codex には spawn_agent が届く'

# --- PL2: --no-parallel でディレクティブが入らない ---
np_execute=$(runner_for_flags execute --no-parallel)
assert_not_contains "$np_execute" 'PARALLEL EXECUTION, mandatory' 'PL2 --no-parallel でディレクティブ非注入'

# --- PL3: standby / review の起動プロンプトにはディレクティブを入れない ---
# (両モードはプロンプト無し / idle 待機文のみで起動し、指示は後から cmux send で届く)
assert_not_contains "$standby_runner" 'PARALLEL EXECUTION, mandatory' 'PL3 standby はディレクティブ非注入'
assert_not_contains "$review_runner" 'PARALLEL EXECUTION, mandatory' 'PL3 review はディレクティブ非注入'

# --- PL4: execute では EXIT_INSTRUCTION がディレクティブより後ろに来る ---
# (exit 指示の後ろに別の指示が続くと優先順位が曖昧になる)
pl4_line=$(grep -o 'PARALLEL EXECUTION, mandatory.*end this codex session' "$execute_runner" | head -1)
if [[ -n "$pl4_line" ]]; then
  echo 'PASS: PL4 exit 指示がディレクティブより後ろにある'
else
  echo 'FAIL: PL4 exit 指示がディレクティブより前にある、または片方が欠けている'
  fail=1
fi

# --- PL5: --agents の不正値は非ゼロ終了する ---
# 単なる非ゼロ終了だけでは launch-workspace.sh 自身の範囲チェック (line ~442) を検証したことに
# ならない。PARALLEL_INSTRUCTION=$(bash parallel-directive.sh ...) は set -euo pipefail 下では、
# parallel-directive.sh 側の同じ ^[2-8]$ チェック (line 44-45) が die しても同じく exit 1 で
# launch-workspace.sh を落とす。つまり line 442 を消しても PL5 は同じ理由で「たまたま」通って
# しまう (PL7 で捕まえたのと同じ「間違った理由で通るテスト」の罠)。launch-workspace.sh 固有の
# メッセージ ("--agents must be an integer from 2 to 8") が出ていること、かつ
# parallel-directive.sh 側のメッセージ ("parallel-directive:" prefix) が出ていないことまで
# 確認して、検証対象を line 442 に固定する。
pl5_bad=0
pl5_err_range="$TMP/pl5-err-range.log"
pl5_err_nonnum="$TMP/pl5-err-nonnum.log"
CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" bash "$LAUNCH" \
  --cwd "$TMP/repo" --mode execute --runner codex --plan-file "$TMP/plan.md" \
  --agents 9 codex-agents-bad >/dev/null 2>"$pl5_err_range" && pl5_bad=1
CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" bash "$LAUNCH" \
  --cwd "$TMP/repo" --mode execute --runner codex --plan-file "$TMP/plan.md" \
  --agents abc codex-agents-bad2 >/dev/null 2>"$pl5_err_nonnum" && pl5_bad=1
if [[ $pl5_bad -eq 0 ]]; then
  echo 'PASS: PL5 --agents の不正値を拒否する'
else
  echo 'FAIL: PL5 --agents の不正値が通ってしまった'
  fail=1
fi
assert_contains "$pl5_err_range" '--agents must be an integer from 2 to 8' \
  'PL5 --agents 9 は launch-workspace.sh 自身の range check で拒否される'
assert_not_contains "$pl5_err_range" 'parallel-directive:' \
  'PL5 --agents 9 は parallel-directive.sh まで到達していない'
assert_contains "$pl5_err_nonnum" '--agents must be an integer from 2 to 8' \
  'PL5 --agents abc は launch-workspace.sh 自身の range check で拒否される'
assert_not_contains "$pl5_err_nonnum" 'parallel-directive:' \
  'PL5 --agents abc は parallel-directive.sh まで到達していない'

# --- PL7: --agents が値を伴わず CLI 末尾で終わる場合も die で拒否し、pane を作らない ---
pl7_bad=0
pl7_err="$TMP/pl7-err.log"
CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" bash "$LAUNCH" \
  --cwd "$TMP/repo" --mode execute --runner codex --plan-file "$TMP/plan.md" \
  codex-agents-missing --agents >/dev/null 2>"$pl7_err" && pl7_bad=1
if [[ $pl7_bad -eq 0 ]]; then
  echo 'PASS: PL7 --agents に値が無い呼び出しを拒否する'
else
  echo 'FAIL: PL7 --agents に値が無いのに通ってしまった'
  fail=1
fi
assert_contains "$pl7_err" '--agents requires a value' 'PL7 die の明示的なエラーメッセージが出る'
assert_not_contains "$pl7_err" 'creating workspace with cwd=' 'PL7 --agents 欠損時に cmux pane を作成しない'

# --- PL6: claude engine には Task サブエージェントの文面が届く ---
claude_exec_output=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" bash "$LAUNCH" \
  --cwd "$TMP/repo" --mode execute --runner claude --plan-file "$TMP/plan.md" claude-parallel)
claude_exec_runner=$(jq -r '.runner_file' <<<"$claude_exec_output")
assert_contains "$claude_exec_runner" 'Task subagents' 'PL6 claude execute には Task サブエージェント指示が届く'
assert_not_contains "$claude_exec_runner" 'spawn_agent' 'PL6 claude には spawn_agent が届かない'

# --- PL8/PL9/PL10: SKILL.md の claude 側 $PARALLEL 挿入位置を静的に固定する ---
# T7 は codex prewarm 分岐だけを pin していた。sonnet standby 分岐と「共通プロトコル a」の
# 拡張 REQUEST_TEXT には同等の assertion が無く、$PARALLEL を落としても誰も検出できなかった。
# 対象の文面は SKILL.md 上で折り返されているため、改行と連続空白を 1 個の空白に潰した
# 平坦化コピーに対して「連続する 1 本の文字列」で照合する (単なる存在ではなく順序を pin する)。
# T14 の grep -F は行区切りに依存しているので、平坦化コピーは新規 assertion 専用に使う。
SKILL_MD_FLAT="$TMP/skill-md-flat.txt"
tr '\n' ' ' < "$SKILL_MD" | tr -s ' ' > "$SKILL_MD_FLAT"

assert_contains "$SKILL_MD_FLAT" \
  'PARALLEL=$(bash <SKILL_DIR>/scripts/parallel-directive.sh --engine claude --mode execute) REQUEST_TEXT="Read and execute the plan at <PLAN_FILE_PATH>. $PARALLEL After all work is committed/pushed and the PR is created (or all changes are merged per the plan), run /exit to close this session.' \
  'PL8 SKILL.md sonnet standby 分岐は $PARALLEL を作業指示と exit 指示の間に保つ'

assert_contains "$SKILL_MD_FLAT" \
  'PARALLEL=$(bash <SKILL_DIR>/scripts/parallel-directive.sh --engine <implementer-engine> --mode execute) REVIEW_PARALLEL=$(bash <SKILL_DIR>/scripts/parallel-directive.sh --engine <reviewer-engine> --mode review) "Read and execute the plan at <PLAN_FILE_PATH>. $PARALLEL After all changes are committed and BEFORE creating the PR, you MUST get a code review approval.' \
  'PL9 SKILL.md 共通プロトコル a は実装者用とレビュアー用の 2 本を先に計算する'

# prewarm 経路のレビュアーはレビューペイン起動 (--mode review, PL3) ではディレクティブを
# 受け取らないため、実装者が依頼文へ転記するこの 1 箇所が唯一の注入点になる。
# 引用部分は宛先マーカーで挟み、実装者が自分宛と誤読しないようにする。
assert_contains "$SKILL_MD_FLAT" \
  'append your rebuttals to the findings you rejected, with reasons. Also include this in the message to the reviewer, addressed to the reviewer and not to you: $REVIEW_PARALLEL End of the message to the reviewer. (2) wait by polling' \
  'PL10 SKILL.md 共通プロトコル a はレビュー依頼文へ宛先マーカー付きでディレクティブを転記する'

[[ $fail -eq 0 ]] && echo '--- all tests passed ---' || echo '--- failures ---'
exit "$fail"
