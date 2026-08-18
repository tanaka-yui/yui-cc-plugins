#!/usr/bin/env bash
# 役割設定 (engine + model + effort) が完全一致したとき、prewarm が実装ペインを
# 起動せず executors を空にすることの回帰テスト。

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

# same:  plan と exec が model / effort とも一致
# diffm: model だけ違う
# diffe: effort だけ違う
# nodef: role フィールドを一切持たない (既定値表のテスト用)
cat > "$TMP/runners.json" <<'JSON'
{
  "default": "same",
  "runners": [
    { "name": "same",  "command": "claude", "engine": "claude",
      "plan_model": "fable", "exec_model": "fable", "review_model": "opus[1m]",
      "plan_effort": "max", "exec_effort": "max", "review_effort": "xhigh" },
    { "name": "diffm", "command": "claude", "engine": "claude",
      "plan_model": "fable", "exec_model": "sonnet", "review_model": "opus[1m]",
      "plan_effort": "max", "exec_effort": "max", "review_effort": "xhigh" },
    { "name": "diffe", "command": "claude", "engine": "claude",
      "plan_model": "fable", "exec_model": "fable", "review_model": "opus[1m]",
      "plan_effort": "max", "exec_effort": "high", "review_effort": "xhigh" },
    { "name": "codex", "command": "codex", "engine": "codex",
      "plan_model": "gpt-5.6-sol", "review_model": "gpt-5.6-sol", "exec_model": "gpt-5.6-terra" },
    { "name": "nodef", "command": "claude", "engine": "claude" }
  ]
}
JSON

fail=0
pass() { echo "PASS: $1"; }
bad() { echo "FAIL: $1" >&2; fail=1; }

run_case() {
  local slug="$1"; shift
  mkdir -p "$TMP/repo-$slug"
  : > "$TMP/argv-$slug.log"
  ARGV_LOG="$TMP/argv-$slug.log" AGMSG_DIR="$TMP/agmsg" RUNNERS_CONFIG_PATH="$TMP/runners.json" \
    bash "$TMP/scripts/prewarm-panes.sh" --with-design --agmsg-team demo-team \
      --cwd "$TMP/repo-$slug" --slug "$slug" --status-dir "$TMP/status-$slug" "$@" >/dev/null
}

# IS1: 完全一致 -> 実装ペインなし (design + review の 2 ペイン)
run_case is1 --design-runner same --reviewer-runner codex --exec-runner same --exec-choice claude
[[ $(wc -l < "$TMP/argv-is1.log" | tr -d ' ') == 2 ]] \
  && pass 'IS1 no executor pane when engine+model+effort all match' \
  || bad "IS1 no executor pane (got $(wc -l < "$TMP/argv-is1.log" | tr -d ' ') panes)"
jq -e '.executors == {}' "$TMP/status-is1/prewarm.json" >/dev/null \
  && pass 'IS1b executors is empty' || bad 'IS1b executors is empty'

# Finding B の回帰: 設計 (claude) ペインの起動に選択した runner の --runner フラグが
# 乗っていること (乗っていないと runner の plan_model/plan_effort が設計ペインへ届かず、
# in-session 判定が「設計ペインの実際の起動条件」とずれる)
grep -F -- '--role plan' "$TMP/argv-is1.log" | grep -Fq -- '--runner same' \
  && pass 'IS1c design pane launch carries --runner for the selected claude design runner' \
  || bad 'IS1c design pane launch is missing --runner for the selected claude design runner'

# IS2: model だけ違う -> 実装ペインあり
run_case is2 --design-runner diffm --reviewer-runner codex --exec-runner diffm --exec-choice claude
jq -e '.executors.claude != null' "$TMP/status-is2/prewarm.json" >/dev/null \
  && pass 'IS2 executor pane exists when model differs' \
  || bad 'IS2 executor pane exists when model differs'

# IS3: effort だけ違う -> 実装ペインあり
run_case is3 --design-runner diffe --reviewer-runner codex --exec-runner diffe --exec-choice claude
jq -e '.executors.claude != null' "$TMP/status-is3/prewarm.json" >/dev/null \
  && pass 'IS3 executor pane exists when effort differs' \
  || bad 'IS3 executor pane exists when effort differs'

# IS4: engine が違う -> 実装ペインあり
run_case is4 --design-runner same --reviewer-runner codex --exec-runner codex --exec-choice codex
jq -e '.executors.codex != null' "$TMP/status-is4/prewarm.json" >/dev/null \
  && pass 'IS4 executor pane exists when engine differs' \
  || bad 'IS4 executor pane exists when engine differs'

# IS5: ask では判定せず全候補を起動する (子が Phase B で選ぶまで確定しない)
run_case is5 --design-runner same --reviewer-runner codex \
  --claude-runner same --codex-runner codex --exec-choice ask
jq -e '.executors.claude != null and .executors.codex != null' "$TMP/status-is5/prewarm.json" >/dev/null \
  && pass 'IS5 ask starts every candidate' || bad 'IS5 ask starts every candidate'

# IS6: role フィールド未設定 (既定値表を使う) -> plan は opus[1m]/xhigh、
# exec は sonnet/high に解決され、両者は一致しないので実装ペインあり。
# これが通れば Step 3 で足した既定値表が実際に in-session 判定へ配線されている証拠になる。
run_case is6 --design-runner nodef --reviewer-runner codex --exec-runner nodef --exec-choice claude
jq -e '.executors.claude != null' "$TMP/status-is6/prewarm.json" >/dev/null \
  && pass 'IS6 executor pane exists when relying on default model/effort table' \
  || bad 'IS6 executor pane exists when relying on default model/effort table'

# IS7: 固定 exec_choice=claude で --exec-runner を省略。design runner "same" は
# plan_model=fable/plan_effort=max = exec_model=fable/exec_effort=max なので、判定側が
# 誤って DESIGN_RUNNER にフォールバックすると in-session と誤判定してしまう
# (Finding A の回帰)。実際の起動側 (Step 4) は --exec-runner が無いときフォールバック
# 無しで --runner を一切付けないため、実装ペインは launch-workspace.sh の素の既定
# (sonnet/high) で立ち上がり、design (fable/max) とは一致しない -> 実装ペインは
# 起動されねばならない。
run_case is7 --design-runner same --reviewer-runner codex --exec-choice claude
jq -e '.executors.claude != null' "$TMP/status-is7/prewarm.json" >/dev/null \
  && pass 'IS7 executor pane exists when --exec-runner is omitted (detection must not fall back to DESIGN_RUNNER)' \
  || bad 'IS7 executor pane exists when --exec-runner is omitted (detection must not fall back to DESIGN_RUNNER)'
# 起動側も --runner フラグを一切付けていないことを確認する (フォールバック無しで
# 起動していることの直接証拠)
grep -F -- '--role exec' "$TMP/argv-is7.log" | grep -Fq -- '--runner' \
  && bad 'IS7b executor pane launch must not carry --runner when --exec-runner is omitted' \
  || pass 'IS7b executor pane launch carries no --runner when --exec-runner is omitted'

[[ $fail -eq 0 ]] && echo '--- all tests passed ---' || echo '--- failures ---'
exit "$fail"
