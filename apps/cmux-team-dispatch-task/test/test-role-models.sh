#!/usr/bin/env bash
# 4 ロールの組込み model / effort と明示 override の回帰テスト。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCH="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/launch-workspace.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/repo" "$TMP/status"

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
  "default": "claude",
  "runners": [
    { "name": "claude", "command": "claude", "engine": "claude" },
    { "name": "codex", "command": "codex", "engine": "codex" }
  ]
}
JSON

fail=0
pass() { echo "PASS: $1"; }
bad() { echo "FAIL: $1" >&2; fail=1; }

# $1=role $2=runner; all four roles are accepted in standby where explicit roles
# deliberately select the pre-warmed pane's personality.
runner_for() {
  local role="$1" runner="$2"; shift 2
  local output name="rm-$role-$runner"
  output=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" bash "$LAUNCH" \
    --cwd "$TMP/repo" --mode standby --role "$role" --runner "$runner" \
    --agmsg-team demo-team --agmsg-from "$name" --status-dir "$TMP/status" "$@" "$name")
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
  grep -Fq -- "$unexpected" "$file" && bad "$label (unexpected: $unexpected)" || pass "$label"
}

# RM1-RM8: claude の組込み既定値。runner role fields を一切使わない。
design=$(runner_for design claude)
assert_contains "$design" "--model 'opus[1m]'" 'RM1 design defaults to opus[1m]'
assert_contains "$design" "--effort 'xhigh'" 'RM2 design defaults to xhigh'

design_review=$(runner_for design_review claude)
assert_contains "$design_review" "--model 'opus[1m]'" 'RM3 design_review defaults to opus[1m]'
assert_contains "$design_review" "--effort 'xhigh'" 'RM4 design_review defaults to xhigh'

exec=$(runner_for exec claude)
assert_contains "$exec" "--model 'sonnet'" 'RM5 exec defaults to sonnet'
assert_contains "$exec" "--effort 'high'" 'RM6 exec defaults to high'

exec_review=$(runner_for exec_review claude)
assert_contains "$exec_review" "--model 'opus[1m]'" 'RM7 exec_review defaults to opus[1m]'
assert_contains "$exec_review" "--effort 'xhigh'" 'RM8 exec_review defaults to xhigh'

# RL1: --role の 4 値が受理され、対応する既定 model / effort が焼き込まれる。
assert_contains "$design" "--model 'opus[1m]'" 'RL1a design'
assert_contains "$design_review" "--model 'opus[1m]'" 'RL1b design_review'
assert_contains "$design_review" "--effort 'xhigh'" 'RL1c design_review default effort'
assert_contains "$exec" "--model 'sonnet'" 'RL1d exec is valid'
assert_contains "$exec" "--effort 'high'" 'RL1e exec default effort'
assert_contains "$exec_review" "--model 'opus[1m]'" 'RL1f exec_review'
assert_contains "$exec_review" "--effort 'xhigh'" 'RL1g exec_review default effort'

# RM9: 明示 --model / --effort は組込み既定値より優先する。
override=$(runner_for design claude --model haiku --effort high)
assert_contains "$override" "--model 'haiku'" 'RM9a explicit model wins'
assert_contains "$override" "--effort 'high'" 'RM9b explicit effort wins'

# RM10-RM12: codex は model omission を維持し effort だけを engine-specific flag へ入れる。
codex_design=$(runner_for design codex)
assert_not_contains "$codex_design" '--model' 'RM10a codex design omits a default model'
assert_contains "$codex_design" "-c model_reasoning_effort='xhigh'" 'RM10b codex design defaults to xhigh'

codex_exec=$(runner_for exec codex)
assert_not_contains "$codex_exec" '--model' 'RM11a codex exec omits a default model'
assert_contains "$codex_exec" "-c model_reasoning_effort='high'" 'RM11b codex exec defaults to high'

codex_review=$(runner_for design_review codex)
assert_not_contains "$codex_review" '--model' 'RM12a codex design_review omits a default model'
assert_contains "$codex_review" "-c model_reasoning_effort='xhigh'" 'RM12b codex design_review defaults to xhigh'

# RM13-RM14: effort allowlist remains engine-specific.
if CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" bash "$LAUNCH" \
     --cwd "$TMP/repo" --mode plan --runner claude --effort minimal \
     --agmsg-team demo-team --agmsg-from rm-bad-claude --status-dir "$TMP/status" rm-bad prompt >/dev/null 2>&1; then
  bad 'RM13 claude rejects effort=minimal'
else
  pass 'RM13 claude rejects effort=minimal'
fi
if CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" bash "$LAUNCH" \
     --cwd "$TMP/repo" --mode plan --runner codex --effort max \
     --agmsg-team demo-team --agmsg-from rm-bad-codex --status-dir "$TMP/status" rm-bad prompt >/dev/null 2>&1; then
  bad 'RM14 codex rejects effort=max'
else
  pass 'RM14 codex rejects effort=max'
fi

# RL2: 旧 role 値は必須引数ではなく値域エラーで落ちる。
for role in plan review; do
  if out=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" bash "$LAUNCH" \
      --cwd "$TMP/repo" --mode standby --role "$role" --runner claude \
      --agmsg-team demo-team --agmsg-from rm-old-role --status-dir "$TMP/status" old-role prompt 2>&1); then
    rc=0
  else
    rc=$?
  fi
  if [[ $rc -ne 0 ]] && grep -q -- '--role' <<<"$out" && grep -qE 'design|exec' <<<"$out"; then
    pass "RL2 old role $role is rejected by the role domain"
  else
    bad "RL2 old role $role rc=$rc out=$out"
  fi
done

[[ $fail -eq 0 ]] && echo '--- all tests passed ---' || echo '--- failures ---'
exit "$fail"
