#!/usr/bin/env bash
# --override が下流へ届く経路の回帰テスト。
#   OV1-OV3: prewarm-panes.sh が役割別 model/effort を該当ペインへ転送する
#   OV4    : 転送された明示値が runners.json の役割フィールドより優先される
#   OV5    : --reviewer-model と legacy --review-model の同時指定を拒否する
#   OV6    : 上書きが in-session 判定に反映される
#   OV7/OV9: engine 別 effort allowlist と review ペインへの effort 到達 (実 launcher)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREWARM="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh"
LAUNCH="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/launch-workspace.sh"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/scripts" "$TMP/repo" "$TMP/agmsg" "$TMP/bin" "$TMP/status"
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

for s in join.sh delivery.sh leave.sh send.sh; do
  printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/agmsg/$s"
  chmod +x "$TMP/agmsg/$s"
done

# claude / codex 双方に役割フィールドを持たせ、上書きが「勝つ」ことを見えるようにする
cat > "$TMP/runners.json" <<'JSON'
{
  "default": "claude",
  "runners": [
    { "name": "claude", "command": "claude", "engine": "claude",
      "plan_model": "opus[1m]", "review_model": "opus[1m]", "exec_model": "sonnet",
      "plan_effort": "xhigh", "review_effort": "xhigh", "exec_effort": "high" },
    { "name": "codex", "command": "codex", "engine": "codex",
      "plan_model": "gpt-5.6-sol", "review_model": "gpt-5.6-sol", "exec_model": "gpt-5.6-terra",
      "plan_effort": "xhigh", "review_effort": "xhigh", "exec_effort": "high" }
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
  mkdir -p "$TMP/repo-$slug"
  ARGV_LOG="$CASE_LOG" AGMSG_DIR="$TMP/agmsg" RUNNERS_CONFIG_PATH="$TMP/runners.json" \
    bash "$TMP/scripts/prewarm-panes.sh" --with-design --agmsg-team demo-team \
      --cwd "$TMP/repo-$slug" --slug "$slug" --status-dir "$TMP/status-$slug" "$@" >/dev/null
}

# pane 行を --agmsg-from で特定する (末尾に必ず pane 名が続くので trailing space で前方一致を防ぐ)
pane_line() { grep -F -- "--agmsg-from $1 " "$CASE_LOG" || true; }

# <id> <pane-agent> <expected substring>
expect_in_pane() {
  local id="$1" agent="$2" expected="$3" line
  line=$(pane_line "$agent")
  if [[ -z "$line" ]]; then
    bad "$id pane '$agent' was not launched"
    return
  fi
  grep -Fq -- "$expected" <<<"$line" \
    && pass "$id pane '$agent' carries $expected" \
    || bad "$id pane '$agent' must carry $expected: $line"
}

# --- OV1: design の model/effort 上書きが design ペインへ届く ---
run_case ov1 --design-runner claude --reviewer-runner codex \
  --exec-runner codex --exec-choice codex \
  --design-model fable --design-effort max
expect_in_pane OV1 ov1 "--model fable"
expect_in_pane OV1 ov1 "--effort max"

# --- OV2: exec の model/effort 上書きが実装ペインへ届く ---
run_case ov2 --design-runner claude --reviewer-runner codex \
  --exec-runner claude --exec-choice claude \
  --exec-model fable --exec-effort max
expect_in_pane OV2 ov2-claude "--model fable"
expect_in_pane OV2 ov2-claude "--effort max"

# --- OV3: reviewer の model/effort 上書きが review ペインへ届く ---
run_case ov3 --design-runner claude --reviewer-runner codex \
  --exec-runner codex --exec-choice codex \
  --reviewer-model gpt-5.6-sol --reviewer-effort medium
expect_in_pane OV3 ov3-review "--model gpt-5.6-sol"
expect_in_pane OV3 ov3-review "--effort medium"

# --- OV4: 上書きが runners.json の役割フィールドより優先される ---
# runner `claude` は exec_model=sonnet / exec_effort=high を持つ。上書きは fable/max。
# prewarm は runner 由来の値を --model として渡さない (launch-workspace の役割
# フォールバックに委ねる) ので、ペイン行に sonnet/high が現れないことまで確認する。
#
# CASE_LOG は直近の run_case のものを指すので、OV2 のログへ明示的に戻す。戻さないと
# pane_line が空を返し、否定アサーションが「行が無いから一致しない」で通ってしまう。
CASE_LOG="$TMP/argv-ov2.log"
line=$(pane_line ov2-claude)
if [[ -z "$line" ]]; then
  bad 'OV4 the ov2 claude executor pane line is missing (cannot judge)'
elif grep -Fq -- "--model sonnet" <<<"$line" || grep -Fq -- "--effort high" <<<"$line"; then
  bad 'OV4 override must replace the runner role fields, not coexist with them'
else
  pass 'OV4 override replaces the runner role fields'
fi

# --- OV5: --reviewer-model と legacy --review-model の同時指定を拒否する ---
# exit code だけでは die() の理由を証明できない (runners.json 欠落など無関係な失敗も
# non-zero を返すため)。stderr に "mutually exclusive" が出ていることまで確認する。
mkdir -p "$TMP/repo-ov5"
ov5_stderr="$TMP/stderr-ov5.log"
if ARGV_LOG="$TMP/argv-ov5.log" AGMSG_DIR="$TMP/agmsg" RUNNERS_CONFIG_PATH="$TMP/runners.json" \
   bash "$TMP/scripts/prewarm-panes.sh" --with-design --agmsg-team demo-team \
     --cwd "$TMP/repo-ov5" --slug ov5 --status-dir "$TMP/status-ov5" \
     --codex-runner codex --review-model gpt-5.6-sol --reviewer-model gpt-5.6-sol \
     >/dev/null 2>"$ov5_stderr"; then
  bad 'OV5 --reviewer-model with --review-model must be rejected'
elif grep -Fq -- "mutually exclusive" "$ov5_stderr"; then
  pass 'OV5 --reviewer-model with --review-model is rejected'
else
  bad "OV5 rejected for the wrong reason (stderr: $(cat "$ov5_stderr"))"
fi

# --- OV6: 上書きが in-session 判定に反映される ---
# runner `claude` の既定は plan opus[1m]/xhigh vs exec sonnet/high なので通常は委譲。
# exec を design と同じ opus[1m]/xhigh に上書きすると in-session になり実装ペインが消える。
run_case ov6 --design-runner claude --reviewer-runner codex \
  --exec-runner claude --exec-choice claude \
  --exec-model 'opus[1m]' --exec-effort xhigh
jq -e '.executors == {}' "$TMP/status-ov6/prewarm.json" >/dev/null \
  && pass 'OV6 override makes the roles identical and drops the executor pane' \
  || bad 'OV6 override makes the roles identical and drops the executor pane'

run_case ov6b --design-runner claude --reviewer-runner codex \
  --exec-runner claude --exec-choice claude \
  --exec-model 'opus[1m]' --exec-effort max
jq -e '.executors.claude != null' "$TMP/status-ov6b/prewarm.json" >/dev/null \
  && pass 'OV6b an effort-only difference still delegates' \
  || bad 'OV6b an effort-only difference still delegates'

# --- OV7 / OV9: 実 launcher で effort allowlist と review ペインへの到達を見る ---
real_runner() {
  local name="$1"; shift
  local output
  output=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" bash "$LAUNCH" \
    --cwd "$TMP/repo" --status-dir "$TMP/status" "$@" "$name" prompt)
  jq -r '.runner_file' <<<"$output"
}

if CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" bash "$LAUNCH" \
     --cwd "$TMP/repo" --mode review --role review --runner codex --effort max \
     --status-dir "$TMP/status" ov7 prompt >/dev/null 2>&1; then
  bad 'OV7 codex rejects effort=max'
else
  pass 'OV7 codex rejects effort=max'
fi

ov9_claude=$(real_runner ov9c --mode review --role review --runner claude --effort max)
grep -Fq -- "--effort 'max'" "$ov9_claude" \
  && pass 'OV9a claude review pane carries --effort' \
  || bad 'OV9a claude review pane carries --effort'

ov9_codex=$(real_runner ov9x --mode review --role review --runner codex --effort xhigh)
grep -Fq -- "model_reasoning_effort='xhigh'" "$ov9_codex" \
  && pass 'OV9b codex review pane carries model_reasoning_effort' \
  || bad 'OV9b codex review pane carries model_reasoning_effort'

# --- OV8: SKILL.md の CLI 記述 ---
SKILL="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/SKILL.md"
grep -Fq -- '[--override]' "$SKILL" \
  && pass 'OV8a argument-hint lists --override' \
  || bad 'OV8a argument-hint lists --override'

# OV8b: section-scoped exclusivity check. Extract the "## Override Mode" section (up to the
# next "## " heading) instead of grepping the whole file, so a harmless rewrap elsewhere in
# SKILL.md can't flip this test and an unrelated exclusivity sentence can't pass it.
OVERRIDE_SECTION=$(sed -n '/^## Override Mode/,/^## /p' "$SKILL")
for other in '--loop' '--setup' '--reset'; do
  grep -Fq -- "$other" <<<"$OVERRIDE_SECTION" \
    && pass "OV8b --override exclusivity with $other is documented" \
    || bad "OV8b --override exclusivity with $other is documented"
done

grep -Fq -- '1g-2' "$SKILL" \
  && pass 'OV8c the override step is present' \
  || bad 'OV8c the override step is present'

[[ $fail -eq 0 ]] && echo '--- all tests passed ---' || echo '--- failures ---'
exit "$fail"
