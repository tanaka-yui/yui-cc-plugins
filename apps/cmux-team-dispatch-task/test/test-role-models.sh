#!/usr/bin/env bash
# 役割ごとの model / effort 解決が engine 中立であることの回帰テスト。
#   RM1-RM6 : claude runner の役割別 model / effort
#   RM7-RM9 : 既定値の適用
#   RM10-RM12: 明示指定の優先と allowlist
#   RM13-RM15: codex runner の役割別 model / effort (-c model_reasoning_effort へ注入)
#   RM16    : codex は effort=max を拒否する (Task 0 probe が INCONCLUSIVE だった safe branch)
#   RM17    : codex には model の既定値が無い (claude は sonnet に既定する exec role で対比)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCH="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/launch-workspace.sh"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/repo" "$TMP/status"

# agmsg send.sh の stub。--status-dir を渡す launch は agmsg 識別子を要求するので
# (配送は agmsg send.sh の 1 本だけで、タイプ入力への fallback が無い)、
# 実体の存在チェックを通すためにこれを AGMSG_SEND として export する。
printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/bin/agmsg-send.sh"
chmod +x "$TMP/bin/agmsg-send.sh"
export AGMSG_SEND="$TMP/bin/agmsg-send.sh"
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
  "default": "tuned",
  "runners": [
    { "name": "tuned", "command": "claude", "engine": "claude",
      "plan_model": "fable", "review_model": "sonnet", "exec_model": "opus[1m]",
      "plan_effort": "max", "review_effort": "medium", "exec_effort": "low" },
    { "name": "bare", "command": "claude", "engine": "claude" },
    { "name": "tuned-codex", "command": "codex", "engine": "codex",
      "plan_model": "gpt-5.6-sol", "review_model": "gpt-5.6-mid", "exec_model": "gpt-5.6-terra",
      "plan_effort": "low", "review_effort": "medium", "exec_effort": "minimal" },
    { "name": "bare-codex", "command": "codex", "engine": "codex" }
  ]
}
JSON

fail=0
pass() { echo "PASS: $1"; }
bad() { echo "FAIL: $1" >&2; fail=1; }

# <name> <runner> <mode> [extra args...] -> runner script path
runner_for() {
  local name="$1" runner="$2" mode="$3"; shift 3
  local output
  if [[ "$mode" == "execute" ]]; then
    output=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" bash "$LAUNCH" \
      --cwd "$TMP/repo" --mode "$mode" --runner "$runner" --plan-file "$TMP/plan.md" \
      --agmsg-team demo-team --agmsg-from "$name" \
      --status-dir "$TMP/status" "$@" "$name")
  else
    output=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" bash "$LAUNCH" \
      --cwd "$TMP/repo" --mode "$mode" --runner "$runner" \
      --agmsg-team demo-team --agmsg-from "$name" \
      --status-dir "$TMP/status" "$@" "$name" prompt)
  fi
  jq -r '.runner_file' <<<"$output"
}

assert_contains() {
  local file="$1" expected="$2" label="$3"
  [[ -f "$file" ]] || { bad "$label (no such file: $file)"; return; }
  grep -Fq -- "$expected" "$file" && pass "$label" || bad "$label (missing: $expected)"
}

assert_not_contains() {
  local file="$1" unexpected="$2" label="$3"
  [[ -f "$file" ]] || { bad "$label (no such file: $file)"; return; }
  grep -Fq -- "$unexpected" "$file" && bad "$label (unexpectedly present: $unexpected)" || pass "$label"
}

# --- RM1-RM6: claude runner の役割別 model / effort ---
plan_r=$(runner_for rm-plan tuned plan)
assert_contains "$plan_r" "--model 'fable'"   'RM1 plan uses plan_model'
assert_contains "$plan_r" "--effort 'max'"    'RM2 plan uses plan_effort'

review_r=$(runner_for rm-review tuned review)
assert_contains "$review_r" "--model 'sonnet'"  'RM3 review uses review_model'
assert_contains "$review_r" "--effort 'medium'" 'RM4 review uses review_effort'

exec_r=$(runner_for rm-exec tuned execute)
assert_contains "$exec_r" "--model 'opus[1m]'" 'RM5 execute uses exec_model'
assert_contains "$exec_r" "--effort 'low'"     'RM6 execute uses exec_effort'

# --- RM7-RM9: 既定値 ---
bare_plan=$(runner_for rm-bare-plan bare plan)
assert_contains "$bare_plan" "--model 'opus[1m]'" 'RM7 plan defaults to opus[1m]'
assert_contains "$bare_plan" "--effort 'xhigh'"   'RM8 plan effort defaults to xhigh'

bare_exec=$(runner_for rm-bare-exec bare execute)
assert_contains "$bare_exec" "--model 'sonnet'" 'RM9a exec defaults to sonnet'
assert_contains "$bare_exec" "--effort 'high'"  'RM9b exec effort defaults to high'

bare_review=$(runner_for rm-bare-review bare review)
assert_contains "$bare_review" "--model 'opus[1m]'" 'RM9c review defaults to opus[1m]'

# --- RM10: superpowers モードにも model/effort が入るが権限フラグは入らない ---
sp_r=$(runner_for rm-sp tuned superpowers)
assert_contains "$sp_r" "--model 'fable'" 'RM10a superpowers carries plan_model'
assert_contains "$sp_r" "--effort 'max'"  'RM10b superpowers carries plan_effort'
assert_not_contains "$sp_r" '--dangerously-skip-permissions' 'RM10c superpowers must not add --dangerously-skip-permissions'

# --- RM11: 明示指定が runner 設定より優先される ---
ovr=$(runner_for rm-ovr tuned plan --model haiku --effort high)
assert_contains "$ovr" "--model 'haiku'" 'RM11a explicit --model wins'
assert_contains "$ovr" "--effort 'high'" 'RM11b explicit --effort wins'

# --- RM12: engine 別の effort allowlist ---
if CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" bash "$LAUNCH" \
     --cwd "$TMP/repo" --mode plan --runner bare --effort minimal \
     --agmsg-team demo-team --agmsg-from rm-bad-claude \
     --status-dir "$TMP/status" rm-bad-claude prompt >/dev/null 2>&1; then
  bad 'RM12a claude rejects effort=minimal'
else
  pass 'RM12a claude rejects effort=minimal'
fi
if CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" bash "$LAUNCH" \
     --cwd "$TMP/repo" --mode plan --runner bare --effort max \
     --agmsg-team demo-team --agmsg-from rm-ok-claude \
     --status-dir "$TMP/status" rm-ok-claude prompt >/dev/null 2>&1; then
  pass 'RM12b claude accepts effort=max'
else
  bad 'RM12b claude accepts effort=max'
fi

# --- RM13-RM15: codex runner の役割別 model / effort (-c model_reasoning_effort へ注入) ---
codex_plan_r=$(runner_for rm-codex-plan tuned-codex plan)
assert_contains "$codex_plan_r" "--model 'gpt-5.6-sol'"                'RM13a codex plan uses plan_model'
assert_contains "$codex_plan_r" "-c model_reasoning_effort='low'"      'RM13b codex plan uses plan_effort'

codex_review_r=$(runner_for rm-codex-review tuned-codex review)
assert_contains "$codex_review_r" "--model 'gpt-5.6-mid'"              'RM14a codex review uses review_model'
assert_contains "$codex_review_r" "-c model_reasoning_effort='medium'" 'RM14b codex review uses review_effort'

codex_exec_r=$(runner_for rm-codex-exec tuned-codex execute)
assert_contains "$codex_exec_r" "--model 'gpt-5.6-terra'"               'RM15a codex execute uses exec_model'
assert_contains "$codex_exec_r" "-c model_reasoning_effort='minimal'"   'RM15b codex execute uses exec_effort'

# --- RM16: codex は effort=max を拒否する (Task 0 probe が INCONCLUSIVE だった safe branch) ---
if CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" bash "$LAUNCH" \
     --cwd "$TMP/repo" --mode plan --runner bare-codex --effort max \
     --agmsg-team demo-team --agmsg-from rm-bad-codex \
     --status-dir "$TMP/status" rm-bad-codex prompt >/dev/null 2>&1; then
  bad 'RM16 codex rejects effort=max'
else
  pass 'RM16 codex rejects effort=max'
fi

# --- RM17: codex には model の既定値が無い (role フィールドが無い runner の exec role) ---
bare_codex_exec=$(runner_for rm-bare-codex-exec bare-codex execute)
[[ -f "$bare_codex_exec" ]] && pass 'RM17a bare codex exec runner file exists' || bad 'RM17a bare codex exec runner file exists'
assert_not_contains "$bare_codex_exec" '--model' 'RM17b codex has no model default (unlike claude which defaults to sonnet)'

[[ $fail -eq 0 ]] && echo '--- all tests passed ---' || echo '--- failures ---'
exit "$fail"
