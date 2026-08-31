#!/usr/bin/env bash
# launch-workspace.sh が Codex runner 向けに生成するコマンドの回帰テスト。
# 並列実行ディレクティブ (PL1-PL10) もここで検証する。
#   PL1-PL7 : launch-workspace.sh が生成する runner ファイルの動的検査
#   PL8-PL10: Phase B delivery helper の $PARALLEL / $REVIEW_PARALLEL 静的検査

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
  list-workspaces)
    count=$(cat "$CMUX_TEST_STATE" 2>/dev/null || echo 0)
    for ((i=1; i<=count; i++)); do echo "workspace:$i"; done
    ;;
  new-workspace)
    count=$(cat "$CMUX_TEST_STATE" 2>/dev/null || echo 0)
    count=$((count + 1))
    echo "$count" > "$CMUX_TEST_STATE"
    echo "workspace:$count"
    ;;
  list-pane-surfaces) echo 'surface:2' ;;
  rename-workspace|rename-tab|notify|send|send-key|wait-for|identify) ;;
  *) echo "unexpected cmux command: $*" >&2; exit 1 ;;
esac
STUB
chmod +x "$TMP/bin/cmux"
export CMUX_TEST_STATE="$TMP/cmux-workspace-count"

# agmsg send.sh のスタブ。--agmsg-team/--agmsg-from を渡す invocation の存在チェック用。
cat > "$TMP/bin/agmsg-send.sh" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
chmod +x "$TMP/bin/agmsg-send.sh"

cat > "$TMP/runners.json" <<'JSON'
{
  "default": "codex",
  "runners": [
    {
      "name": "codex",
      "command": "codex",
      "engine": "codex",
      "plan_model": "gpt-5.6-sol",
      "review_model": "gpt-5.6-sol",
      "exec_model": "gpt-5.6-terra",
      "plan_effort": "xhigh",
      "review_effort": "xhigh",
      "exec_effort": "high"
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
      --cwd "$TMP/repo" --mode "$mode" --runner codex --plan-file "$TMP/plan.md" --agmsg-team demo-team --agmsg-from "$name" --status-dir "$TMP/status" "$name")
  else
    output=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" bash "$LAUNCH" \
      --cwd "$TMP/repo" --mode "$mode" --runner codex --agmsg-team demo-team --agmsg-from "$name" --status-dir "$TMP/status" "$name" prompt)
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
STATUS_REVIEW_REAL=$(cd "$TMP/status/review" && pwd -P)

assert_not_contains "$plan_runner" '--model' 'MR1 plan omits a codex default model'
assert_not_contains "$superpowers_runner" '--model' 'MR2 superpowers omits a codex default model'
assert_not_contains "$review_runner" '--model' 'MR3 review omits a codex default model'
assert_not_contains "$execute_runner" '--model' 'MR4 execute omits a codex default model'
assert_not_contains "$standby_runner" '--model' 'MR5 standby omits a codex default model'

runner_for_flags() {
  local mode="$1"; shift
  local name="codex-$mode-flags"
  local output
  if [[ "$mode" == "execute" ]]; then
    output=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" bash "$LAUNCH" \
      --cwd "$TMP/repo" --mode "$mode" --runner codex --plan-file "$TMP/plan.md" --agmsg-team demo-team --agmsg-from "$name" --status-dir "$TMP/status" "$@" "$name")
  else
    output=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" bash "$LAUNCH" \
      --cwd "$TMP/repo" --mode "$mode" --runner codex --agmsg-team demo-team --agmsg-from "$name" --status-dir "$TMP/status" "$@" "$name" prompt)
  fi
  jq -r '.runner_file' <<<"$output"
}

plan_standby=$(runner_for_flags standby --role design)
assert_not_contains "$plan_standby" '--model' 'MR6 design standby omits a codex default model'
assert_contains "$plan_standby" "-c model_reasoning_effort='xhigh'" 'MR6 design standby gets design effort'

explicit_plan=$(runner_for_flags plan --model gpt-5.6-terra)
assert_contains "$explicit_plan" "--model 'gpt-5.6-terra'" 'MR7 explicit model wins'

assert_contains "$superpowers_runner" '--dangerously-bypass-approvals-and-sandbox' 'T1 codex + superpowers bypass'
assert_contains "$plan_runner" '--dangerously-bypass-approvals-and-sandbox' 'T2 codex + plan bypass'
assert_contains "$execute_runner" '--dangerously-bypass-approvals-and-sandbox' 'T3 codex + execute bypass'
assert_contains "$execute_runner" 'SESSION_EXIT=$?' 'EN1 generic exit variable'
assert_contains "$execute_runner" 'runner session starting' 'EN2 generic starting status'
assert_not_contains "$execute_runner" 'Claude session starting' 'EN3 no Claude status label'
assert_contains "$standby_runner" '--dangerously-bypass-approvals-and-sandbox' 'T4 codex + standby bypass'
assert_contains "$review_runner" '--sandbox workspace-write' 'T5 review sandbox workspace-write'
assert_contains "$review_runner" "-c approval_policy='never'" 'T5 review approval policy never'
assert_contains "$review_runner" "--add-dir '$STATUS_REVIEW_REAL'" 'T5 canonical review findings directory writable'
assert_not_contains "$review_runner" '--dangerously-bypass-approvals-and-sandbox' 'T5 review does not disable sandbox'

# --- CR1 / CR1b: codex review の --add-dir (agmsg run/db は writable, scripts は不可) ---
FAKE_AGMSG="$TMP/fake-agmsg"; mkdir -p "$FAKE_AGMSG/run" "$FAKE_AGMSG/db" "$FAKE_AGMSG/scripts"
cr1_output=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" AGMSG_SKILL_DIR="$FAKE_AGMSG" \
  bash "$LAUNCH" --cwd "$TMP/repo" --mode review --role design_review --runner codex \
  --agmsg-team demo-team --agmsg-from rv1 --status-dir "$TMP/status" rv1 prompt)
cr1_runner=$(jq -r '.runner_file' <<<"$cr1_output")
assert_contains "$cr1_runner" "--add-dir '$FAKE_AGMSG/run'" 'CR1 agmsg run must be writable'
assert_contains "$cr1_runner" "--add-dir '$FAKE_AGMSG/db'"  'CR1 agmsg db must be writable'
assert_not_contains "$cr1_runner" "$FAKE_AGMSG/scripts"     'CR1 agmsg scripts must NOT be writable'

cr1b_output=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" AGMSG_SKILL_DIR="$FAKE_AGMSG" \
  bash "$LAUNCH" --cwd "$TMP/repo" --mode review --role design_review --runner codex rv2 prompt)
cr1b_runner=$(jq -r '.runner_file' <<<"$cr1b_output")
assert_contains "$cr1b_runner" "--add-dir '$FAKE_AGMSG/run'" 'CR1b must add agmsg dirs without STATUS_DIR'

# --- CR1c: 新規インストール (run/ db/ が未作成) でも --add-dir が付く ---
# CR1/CR1b は fixture が mkdir -p 済みなのでこの分岐を踏まない。実 watch.sh は run/ を
# 初回起動時に自分で作るが、codex reviewer は workspace-write サンドボックスなので
# 中からは作れない。launch-workspace.sh 側がサンドボックス外で先に作る必要がある。
FRESH_AGMSG="$TMP/fresh-agmsg"; mkdir -p "$FRESH_AGMSG/scripts"
cr1c_output=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" AGMSG_SKILL_DIR="$FRESH_AGMSG" \
  bash "$LAUNCH" --cwd "$TMP/repo" --mode review --role design_review --runner codex rv3 prompt)
cr1c_runner=$(jq -r '.runner_file' <<<"$cr1c_output")
assert_contains "$cr1c_runner" "--add-dir '$FRESH_AGMSG/run'" 'CR1c fresh install must still grant agmsg run'
assert_contains "$cr1c_runner" "--add-dir '$FRESH_AGMSG/db'"  'CR1c fresh install must still grant agmsg db'

# --- CR1d: agmsg 未インストールならツリーを勝手に作らない ---
MISSING_AGMSG="$TMP/no-agmsg"
CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" AGMSG_SKILL_DIR="$MISSING_AGMSG" \
  bash "$LAUNCH" --cwd "$TMP/repo" --mode review --role design_review --runner codex rv4 prompt >/dev/null
if [[ -d "$MISSING_AGMSG" ]]; then
  echo 'FAIL: CR1d must not create an agmsg tree when agmsg is not installed'
  fail=1
else
  echo 'PASS: CR1d must not create an agmsg tree when agmsg is not installed'
fi

# --- CR1e: AGMSG_SKILL_DIR にシェルメタ文字があれば --add-dir を付けない ---
# composed command は `zsh -ic "... --add-dir '<path>' ..."` の二重引用で、
# launch-workspace.sh はエスケープしない。`'` を含むパスをそのまま埋めると引用符が
# 破れて後続が別トークンになる。B8 の mkdir -p もこの未検証値を引数に取るので、
# 検出したときは --add-dir もツリー作成もしない (fail-closed)。
QUOTED_AGMSG="$TMP/qu'ote-agmsg"; mkdir -p "$QUOTED_AGMSG/run" "$QUOTED_AGMSG/db"
cr1e_output=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" AGMSG_SKILL_DIR="$QUOTED_AGMSG" \
  bash "$LAUNCH" --cwd "$TMP/repo" --mode review --role design_review --runner codex rv5 prompt 2>/dev/null)
cr1e_runner=$(jq -r '.runner_file' <<<"$cr1e_output")
assert_not_contains "$cr1e_runner" "qu'ote-agmsg" 'CR1e a quoted AGMSG_SKILL_DIR must not be injected'

# CR1f: review ペインの --add-dir は検証・canonicalize 済みの review directory だけ
if grep -q "add-dir '\$REVIEW_SANDBOX_DIR'" "$LAUNCH" && ! grep -q "add-dir '\$STATUS_DIR'" "$LAUNCH"; then
  echo 'PASS: CR1f review pane write permission uses the validated canonical review directory'
else
  echo 'FAIL: CR1f --add-dir is not restricted to the validated review directory'
  fail=1
fi
# CR1g: helper が directory 型・symlink・canonical containment を検証してから付与する
if grep -q '^prepare_review_directory()' "$LAUNCH" \
   && grep -Fq '[[ -d "$review_dir" && ! -L "$review_dir" ]]' "$LAUNCH" \
   && grep -Fq '[[ "$review_real" == "$status_real/review" ]]' "$LAUNCH"; then
  echo 'PASS: CR1g validates and contains the review directory before granting it'
else
  echo 'FAIL: CR1g missing review directory validation/containment'
  fail=1
fi
# CR1h: STATUS_DIR にシェルメタ文字があるときは fail-closed で die する。
BAD_STATUS="$TMP/sta'tus"
if out=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" \
         bash "$LAUNCH" --cwd "$TMP/repo" --mode review --runner codex \
           --agmsg-team demo --agmsg-from p --status-dir "$BAD_STATUS" ws prompt 2>&1); then
  rc=0
else
  rc=$?
fi
if [[ $rc -ne 0 ]] && grep -qi 'status-dir' <<<"$out" \
   && [[ ! -d "$BAD_STATUS" ]] && ! grep -rq "sta'tus" "$TMP" --include='*.sh' 2>/dev/null; then
  echo 'PASS: CR1h rejects metacharacter STATUS_DIR without side effects'
else
  echo "FAIL: CR1h rc=$rc out=$out"
  fail=1
fi

# --- LW1 / LW2: agmsg 配線経路 ---
# launch-workspace.sh:379 は send.sh が無ければ die する。実 $HOME の agmsg に依存させると
# 未インストールのホストで `set -euo pipefail` のこのファイルが LW1 で即死し、以降の
# 全ケースが走らないまま終端行すら出ない。stub を AGMSG_SEND で差し替えてホスト非依存にする。
STUB_AGMSG_SEND="$TMP/agmsg-send.sh"
printf '#!/usr/bin/env bash\nexit 0\n' > "$STUB_AGMSG_SEND"
chmod +x "$STUB_AGMSG_SEND"

# --- LW1: runner script に agmsg 識別子が入る ---
lw1_output=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" AGMSG_SEND="$STUB_AGMSG_SEND" \
  bash "$LAUNCH" --cwd "$TMP/repo" --mode standby --role exec --runner claude \
  --status-dir "$TMP/status" --agmsg-team demo --agmsg-from demo-claude lw1)
lw1_runner=$(jq -r '.runner_file' <<<"$lw1_output")
assert_contains "$lw1_runner" 'AGMSG_TEAM="demo"' 'LW1 runner script must carry AGMSG_TEAM'
assert_contains "$lw1_runner" 'AGMSG_FROM="demo-claude"' 'LW1 runner script must carry AGMSG_FROM'
# AGMSG_SEND が env で差し替え可能なままであること (:202) の回帰。ここを見ずに
# STUB_AGMSG_SEND を注入するだけだと、:202 がハードコードへ戻っても agmsg 導入済みの
# ホスト (= 実開発機全部) では本物の $HOME 配下 send.sh が -f を通り LW1 自体は緑のまま通る。
assert_contains "$lw1_runner" "AGMSG_SEND=\"$STUB_AGMSG_SEND\"" 'LW1 AGMSG_SEND is env-substitutable'

# --- LW2: --agmsg-from の値域検証 ---
lw2_bad=0
CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" AGMSG_SEND="$STUB_AGMSG_SEND" \
  bash "$LAUNCH" --cwd "$TMP/repo" --mode standby --role exec --runner claude \
  --status-dir "$TMP/status" --agmsg-team demo --agmsg-from 'bad name' lw2 >/dev/null 2>&1 && lw2_bad=1
if [[ $lw2_bad -eq 0 ]]; then
  echo 'PASS: LW2 --agmsg-from with a space must die'
else
  echo 'FAIL: LW2 --agmsg-from with a space must die'
  fail=1
fi

# --- LW3 (F3): --runner に空文字を渡したら die する。空は「指定なし」と同じ扱いになり
#     runners.json を引かずに既定 (claude) へ落ちるため、呼び出し側の runner 解決漏れが
#     engine の黙った反転になる。素朴な実装 (`[[ $# -lt 2 ]]` だけ) はこれを通す ---
lw3_bad=0
lw3_out=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" AGMSG_SEND="$STUB_AGMSG_SEND" \
  bash "$LAUNCH" --cwd "$TMP/repo" --mode standby --role exec --runner '' \
  --status-dir "$TMP/status" lw3 2>&1) && lw3_bad=1
# 終了コードだけでは足りない (別の理由で落ちても緑になる)。die の文面まで固定する。
if [[ $lw3_bad -eq 0 ]] && grep -Fq 'non-empty runner name' <<<"$lw3_out"; then
  echo 'PASS: LW3 --runner with an empty value must die'
else
  echo "FAIL: LW3 --runner with an empty value must die (rc_bad=$lw3_bad out=$lw3_out)"
  fail=1
fi

# --- hook trust: codex 0.145 は project-local .codex/hooks.json ごとに信頼を求める。
# agmsg が worktree ごとに新しい hooks.json を生成するためパスが毎回変わり、常に未信頼と
# 判定されて起動直後に承認待ちで停止する。approvals-and-sandbox のバイパスとは別フラグ。 ---
assert_contains "$superpowers_runner" '--dangerously-bypass-hook-trust' 'T8 codex + superpowers hook trust bypass'
assert_contains "$plan_runner" '--dangerously-bypass-hook-trust' 'T8 codex + plan hook trust bypass'
assert_contains "$execute_runner" '--dangerously-bypass-hook-trust' 'T8 codex + execute hook trust bypass'
assert_contains "$standby_runner" '--dangerously-bypass-hook-trust' 'T8 codex + standby hook trust bypass'
assert_contains "$review_runner" '--dangerously-bypass-hook-trust' 'T8 codex + review hook trust bypass'

# --- goal 継続の無効化: codex はターン終了の数十ミリ秒後に
# <codex_internal_context source="goal"> を注入して次のターンを始める。その注入文自体が
# 「同じ blocking condition が自動継続を含めて 3 連続 goal ターン続いたら blocked を宣言せよ」
# という codex の blocked audit を含むため、レビュー待ちが 30 秒足らずでその閾値に達する。
# 2026-08-31 実測: review-code 送信の 81 秒後 / 111 秒後に exec が abort し、どちらも直後に
# update_goal({status:"blocked"}) を実行した (レビュアーは 2 件とも正常に完走)。
# 子ペインは agmsg メッセージと親の nudge で再開する設計なので、この機能は待機を潰す以外の
# 役目を持たない。全 codex 経路で切る。 ---
assert_contains "$superpowers_runner" '-c features.goals=false' 'T16 codex + superpowers disables goal continuation'
assert_contains "$plan_runner" '-c features.goals=false' 'T16 codex + plan disables goal continuation'
assert_contains "$execute_runner" '-c features.goals=false' 'T16 codex + execute disables goal continuation'
assert_contains "$standby_runner" '-c features.goals=false' 'T16 codex + standby disables goal continuation'
assert_contains "$review_runner" '-c features.goals=false' 'T16 codex + review disables goal continuation'

# Exit instruction must be engine-aware: codex ends its own session (it does not
# act on /exit), claude runs /exit. If the codex execute path stopped baking the
# codex-appropriate exit instruction, the codex TUI would stay idle after the work
# and the runner wrapper would never fire the completion notification.
# codex には自セッションを終わらせる手段が無い (/exit は効かず quit/shutdown も無い) ため、
# 旧 T5b が固定していた「end this codex session」は実行不能な要求だった。完了検知は
# report-status.sh の呼び出しに移し、codex には停止して idle のまま待つよう伝える。
assert_contains "$execute_runner" 'report-status.sh' 'T5b codex execute bakes the completion report call'
assert_contains "$execute_runner" 'stop and stay idle' 'T5b codex execute tells codex to stay idle instead of self-terminating'
assert_not_contains "$execute_runner" 'end this codex session' 'T5b codex execute drops the unactionable self-termination demand'
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
  assert_not_contains "$claude_runner_file" '-c features.goals=false' "T16b claude + $mode has no codex goals flag"
  [[ "$mode" == "execute" ]] \
    && assert_contains "$claude_runner_file" 'run /exit' 'T6b claude execute bakes /exit exit instruction'
done

# --- SKILL.md static check: the codex Phase B prewarm-standby block must define a
# base REQUEST_TEXT with a codex-appropriate idle instruction (regression guard for
# the "codex completion notification never arrives" bug). $PARALLEL (the
# parallel-execution directive, injected between the work instruction and the
# completion instruction) is now part of this same string — it must stay between
# the two, with the idle instruction still last. ---
SKILL_MD="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/SKILL.md"
PHASE_B_DELIVER="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/phase-b-deliver.sh"
assert_contains "$SKILL_MD" 'scripts/phase-b-deliver.sh' \
  'T7 SKILL.md delegates prewarmed Phase B request construction to the delivery helper'
assert_contains "$PHASE_B_DELIVER" 'After completion, stop and stay idle. Do not run /exit; the parent closes this pane during final cleanup.' \
  'T7 delivery helper defines the codex completion report and idle instruction'

# --- T14/T15: Phase B-R の拡張 REQUEST_TEXT の退行ガード ---
# Phase B-R が有効なとき、拡張 REQUEST_TEXT は codex 用 base REQUEST_TEXT を上書きする。
# 旧仕様の末尾は engine 中立の「run /exit (claude) or end the session (codex)」1 文だったため、
# codex への強い指示 (Do NOT run /exit / completion report 後は idle) が失われると、
# 実行不能な自己終了を要求する文面へ戻る。さらに standby ペインは task prompt を読まないので、
# 子側の必須通知も構造的に届かない。両方を固定する。
assert_contains "$PHASE_B_DELIVER" 'stop and stay idle' \
  'T14 delivered REQUEST_TEXT tells codex to stay idle for parent cleanup'
assert_contains "$PHASE_B_DELIVER" 'Do not run /exit' \
  'T14 delivered REQUEST_TEXT forbids /exit for codex'
assert_not_contains "$SKILL_MD" 'END THE CODEX SESSION' \
  'T14 self-termination demand is absent from SKILL.md'
assert_not_contains "$SKILL_MD" 'or end the session (codex)' \
  'T14 the ambiguous engine-neutral exit wording is gone'
assert_contains "$PHASE_B_DELIVER" 'MANDATORY STATUS PROTOCOL' \
  'T15 delivered REQUEST_TEXT carries the mandatory status and completion notification protocol'
assert_contains "$PHASE_B_DELIVER" 'recipient parent' \
  'T15 delivered REQUEST_TEXT addresses the completion notification to the parent agent'

# --- pr_url 引き継ぎ / timeout sentinel ガード ---
sentinel_output=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" bash "$LAUNCH" \
  --cwd "$TMP/repo" --mode standby --runner claude --agmsg-team demo-team --agmsg-from sentinel-task --status-dir "$TMP/status" \
  --timeout-sentinel "$TMP/loopstate/timed-out/sentinel-task" "sentinel-task")
sentinel_runner=$(jq -r '.runner_file' <<<"$sentinel_output")
assert_contains "$sentinel_runner" 'TIMEOUT_SENTINEL="'"$TMP"'/loopstate/timed-out/sentinel-task"' \
  'T10 --timeout-sentinel はパスを wrapper に焼き込む'
assert_contains "$sentinel_runner" 'timeout sentinel found' 'T10 wrapper に sentinel ガードがある'
assert_contains "$sentinel_runner" 'PREV_PR_URL' 'T11 write_status が既存 pr_url を読む'

# sentinel を渡さない通常経路には一切現れない（非ループ挙動の不変性）
plain_output=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" bash "$LAUNCH" \
  --cwd "$TMP/repo" --mode standby --runner claude --agmsg-team demo-team --agmsg-from plain-task --status-dir "$TMP/status" "plain-task")
plain_runner=$(jq -r '.runner_file' <<<"$plain_output")
assert_contains "$plain_runner" 'TIMEOUT_SENTINEL=""' 'T10 未指定時は空の sentinel パス'

# --- --unattended: spawn 経路の inner prompt から質問分岐を除去する ---
cat > "$TMP/status/review/code-review.json" <<JSON
{"review_dir":"$STATUS_REVIEW_REAL","reviewer_agent":"unattended-review","reviewer_engine":"codex","reviewer_runner":"codex","reviewer_surface":"surface:2","reviewer_workspace":"workspace:3"}
JSON

unattended_output=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" \
  AGMSG_SEND="$TMP/bin/agmsg-send.sh" bash "$LAUNCH" \
  --cwd "$TMP/repo" --mode execute --runner claude --plan-file "$TMP/plan.md" \
  --agmsg-team demo-team --agmsg-from unattended-exec \
  --status-dir "$TMP/status" --review-config "$TMP/status/review/code-review.json" --unattended "unattended-exec")
unattended_runner=$(jq -r '.runner_file' <<<"$unattended_output")
assert_not_contains "$unattended_runner" 'AskUserQuestion' 'T12 --unattended の runner に質問分岐が無い'
assert_contains "$unattended_runner" '--dangerously-skip-permissions' 'T12 --unattended は claude に skip-permissions を強制'
assert_contains "$unattended_runner" 'note the unresolved findings in the PR body and proceed' \
  'T12 --unattended は round 5 の固定フォールバックを持つ'

# 後方互換: --unattended 無しでは現行文言が保たれる
attended_output=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" \
  AGMSG_SEND="$TMP/bin/agmsg-send.sh" bash "$LAUNCH" \
  --cwd "$TMP/repo" --mode execute --runner claude --plan-file "$TMP/plan.md" \
  --agmsg-team demo-team --agmsg-from attended-exec \
  --status-dir "$TMP/status" --review-config "$TMP/status/review/code-review.json" "attended-exec")
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
jq -n --arg d "$(cd "$TMP/abort-status/review" && pwd -P)" \
  '{review_dir:$d, reviewer_agent:"abort-review-review", reviewer_engine:"claude", reviewer_runner:"probe", reviewer_surface:"surface:2", reviewer_workspace:"workspace:5"}' \
  > "$TMP/abort-status/review/code-review.json"
a1=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners-probe.json" AGMSG_SEND="$TMP/bin/agmsg-send.sh" bash "$LAUNCH" --cwd "$TMP/repo" --mode execute --runner probe --plan-file "$TMP/plan.md" --status-dir "$TMP/abort-status" --agmsg-team demo-team --agmsg-from abort-review --parent-notify-workspace workspace:9 --review-config "$TMP/abort-status/review/code-review.json" abort-review)
a1_runner=$(jq -r '.runner_file' <<<"$a1")
assert_contains "$a1_runner" 'ABORT PROTOCOL' 'A1 review 有効の spawn 経路に abort 手順が入る'
assert_contains "$a1_runner" 'code-round-N.md' 'A1 review 有効時は findings 記録先を含む'
ARGV_OUT="$TMP/argv-a2.txt" ZDOTDIR="$TMP/zdot" PATH="$TMP/bin:$PATH" bash "$a1_runner" >/dev/null 2>&1 || true
a2_argc=$(grep -oE 'argc=[0-9]+' "$TMP/argv-a2.txt" 2>/dev/null | head -1 | cut -d= -f2)
# probe runner は claude engine で role フィールドなしの execute (role=exec) なので、
# 既定の --model 'sonnet' --effort 'high' が inner prompt の前に4引数として付く。
# argc=5 (--model, sonnet, --effort, high, inner prompt) かつ最後の1引数が
# inner prompt 全文であることを確認し、クォート事故で分割されていないことを検証する。
a2_last_arg=$(grep -c '^arg=Read and execute the plan at' "$TMP/argv-a2.txt" 2>/dev/null || true)
if [[ "$a2_argc" == "5" && "$a2_last_arg" == "1" ]]; then
  echo 'PASS: A2 inner prompt が既定 --model/--effort の後に単一引数として渡る'
else
  echo "FAIL: A2 inner prompt が単一引数でない (argc=${a2_argc:-none}, last_arg_match=${a2_last_arg:-0})"
  fail=1
fi
a3=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners-probe.json" AGMSG_SEND="$TMP/bin/agmsg-send.sh" bash "$LAUNCH" --cwd "$TMP/repo" --mode execute --runner probe --plan-file "$TMP/plan.md" --status-dir "$TMP/abort-status-none" --agmsg-team demo-team --agmsg-from abort-none --parent-notify-workspace workspace:9 abort-none)
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
    bash "$LAUNCH" --cwd "$TMP/repo" --mode plan --runner "$runner" --agmsg-team demo-team --agmsg-from "$name" --status-dir "$TMP/status" "$name" prompt \
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

# --- PL1: codex の起動プロンプトにはディレクティブを入れない ---
# codex の子エージェントは app-server daemon 上の別スレッドで走りペインに映らないため、
# 「動いているのか止まっているのか」を判別できなくなる。だから指示そのものを出さない。
assert_not_contains "$plan_runner" 'PARALLEL EXECUTION, mandatory' 'PL1 codex plan にディレクティブは入らない'
assert_not_contains "$superpowers_runner" 'PARALLEL EXECUTION, mandatory' 'PL1 codex superpowers にディレクティブは入らない'
assert_not_contains "$execute_runner" 'PARALLEL EXECUTION, mandatory' 'PL1 codex execute にディレクティブは入らない'
assert_not_contains "$execute_runner" 'spawn_agent' 'PL1 codex には spawn_agent が届かない'

# --- PL2: --no-parallel は claude のディレクティブを止める ---
# codex はそもそも注入されないので、このフラグの効き目は claude でしか観測できない。
np_claude_output=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" bash "$LAUNCH" \
  --cwd "$TMP/repo" --mode execute --runner claude --plan-file "$TMP/plan.md" --no-parallel claude-no-parallel)
np_claude_runner=$(jq -r '.runner_file' <<<"$np_claude_output")
assert_not_contains "$np_claude_runner" 'PARALLEL EXECUTION, mandatory' 'PL2 --no-parallel でディレクティブ非注入 (claude)'

# --- PL3: standby / review の起動プロンプトにはディレクティブを入れない ---
# (両モードはプロンプト無し / idle 待機文のみで起動し、指示は後から cmux send で届く)
assert_not_contains "$standby_runner" 'PARALLEL EXECUTION, mandatory' 'PL3 standby はディレクティブ非注入'
assert_not_contains "$review_runner" 'PARALLEL EXECUTION, mandatory' 'PL3 review はディレクティブ非注入'

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

# --- PL4: execute では EXIT_INSTRUCTION がディレクティブより後ろに来る ---
# (exit 指示の後ろに別の指示が続くと優先順位が曖昧になる)
# codex にはディレクティブが入らなくなったので、順序を観測できるのは claude だけ。
# grep 失敗で set -e が走らないよう || true で受ける。
pl4_line=$(grep -o 'PARALLEL EXECUTION, mandatory.*run /exit to close this Claude session' "$claude_exec_runner" | head -1 || true)
if [[ -n "$pl4_line" ]]; then
  echo 'PASS: PL4 exit 指示がディレクティブより後ろにある (claude)'
else
  echo 'FAIL: PL4 exit 指示がディレクティブより前にある、または片方が欠けている'
  fail=1
fi

# --- PL8/PL9/PL10: prewarmed Phase B helper の parallel directive 挿入を固定する ---
# SKILL.md の手組み REQUEST_TEXT は helper へ集約した。実際に配送本文を作る script を検査し、
# base / review の両 directive と reviewer-only 境界が失われないことを固定する。
assert_contains "$PHASE_B_DELIVER" \
  'PARALLEL=$(bash "$SCRIPT_DIR/parallel-directive.sh"' \
  'PL8 delivery helper computes the implementer parallel directive'
assert_contains "$PHASE_B_DELIVER" \
  'REVIEW_PARALLEL=$(bash "$SCRIPT_DIR/parallel-directive.sh"' \
  'PL9 delivery helper computes the reviewer parallel directive'
assert_contains "$PHASE_B_DELIVER" \
  'REVIEWER_ONLY_BLOCK="Include this reviewer-only directive in the review request: $REVIEW_PARALLEL End reviewer-only directive. "' \
  'PL10 delivery helper marks the reviewer-only parallel directive boundary'
# PL10b: その囲みは directive が空 (codex reviewer) のとき丸ごと落ちること。無条件に連結すると
# 中身のない reviewer-only directive を実装者がレビュー依頼へ転記してしまう。
assert_contains "$PHASE_B_DELIVER" \
  'if [[ -n "$REVIEW_PARALLEL" ]]; then' \
  'PL10b reviewer-only の囲みは directive が空なら出さない'

[[ $fail -eq 0 ]] && echo '--- all tests passed ---' || echo '--- failures ---'
exit "$fail"
