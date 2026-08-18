# role ベース model / effort 解決 実装プラン

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `plan_model` / `review_model` / `exec_model` と 3 つの effort を engine 中立にし、claude runner でも役割ごとにモデルと effort を選べるようにする。あわせて `exec_choice` を engine 選択へ退け、in-session 実行を「役割設定が完全一致したとき」へ一般化する。

**Architecture:** 解決の単一入口は `launch-workspace.sh` の役割フォールバック。`prewarm-panes.sh` はモデルを一切ハードコードせず、どのペインを起動するかだけを決める。`exec_choice` は「どの engine が実装するか」だけを表し、モデルと effort は runners.json の役割フィールドが決める。

**Tech Stack:** bash 3.2 互換シェルスクリプト、`jq`、cmux CLI、AskUserQuestion（SKILL.md 内の指示文）

**Spec:** `docs/superpowers/specs/2026-08-18-role-model-effort-resolution-design.md`

## Global Constraints

- 対象は `apps/cmux-team-dispatch-task` のみ。他の app を触らない
- **bash 3.2 互換**（macOS 標準）。`set -u` 下で空配列を展開するときは `${arr[@]+"${arr[@]}"}` イディオムを使う
- **役割 model の既定値**: claude は plan `opus[1m]` / review `opus[1m]` / exec `sonnet`。codex は既定なし（空のまま）
- **役割 effort の既定値**（両 engine 共通）: plan `xhigh` / review `xhigh` / exec `high`
- **effort の allowlist**: claude `low|medium|high|xhigh|max` / codex `minimal|low|medium|high|xhigh`
- **model 文字列は検証しない**
- **`exec_choice` の有効値**: `claude` / `codex` / `ask`
- **in-session 条件**: `EXEC_ENGINE == DESIGN_ENGINE && EXEC_MODEL == PLAN_MODEL && EXEC_EFFORT == PLAN_EFFORT`
- **ドキュメント整合**: `SKILL.md` / `references/guide-ja.md` / `README.md` / `CLAUDE.md` の 4 ファイルは同一 commit で同期する（Task 6）
- **英語厳格ルール**: `SKILL.md` と `references/*.md`（`*-ja.md` を除く）に日本語文字を書かない。`pnpm check:doc-lang` で検証する
- **テストは worktree ディレクトリを事前に `mkdir -p` する**。しないと `prewarm-panes.sh` の `git worktree add` が実リポジトリに対して走り、ブランチと worktree 登録が残る
- 作業ブランチ: `feat/role-model-effort`（main へ直接コミットしない）

---

### Task 0: 作業ブランチと codex effort の受理値確認

**Files:**
- なし（調査と分岐作成のみ）

**Interfaces:**
- Produces: `CODEX_MAX_SUPPORTED`（真偽の事実）— Task 1 の allowlist と Task 6 の `--setup` 候補が参照する

- [ ] **Step 1: 作業ブランチを切る**

```bash
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins
git switch -c feat/role-model-effort
```

- [ ] **Step 2: codex が `max` effort を受理するか確認する**

```bash
codex -c model_reasoning_effort='max' --help >/dev/null 2>&1 && echo "max: ACCEPTED" || echo "max: REJECTED"
codex -c model_reasoning_effort='xhigh' --help >/dev/null 2>&1 && echo "xhigh: ACCEPTED" || echo "xhigh: REJECTED"
```

`xhigh: ACCEPTED` かつ `max: REJECTED` なら spec のとおり codex allowlist は
`minimal|low|medium|high|xhigh` のままとする。両方 ACCEPTED なら codex allowlist にも
`max` を足し、Task 1 の正規表現と Task 6 の `--setup` 候補にも反映する。
`--help` が `-c` を解釈せず両方 ACCEPTED に見える場合は、判定不能として
**allowlist は変えない**（安全側）。

- [ ] **Step 3: 判定結果をメモに残す**

この結果を Task 1 Step 3 と Task 6 Step 2 で参照する。判定不能だった場合はその旨も残す。

---

### Task 1: `launch-workspace.sh` の役割 model / effort を engine 中立化する

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh:427-454`（model/effort 解決）
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh:726-742`（`CLAUDE_EXTRA_FLAGS` の組み立て）
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh:777-801`（claude engine のコマンド組み立て）
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh:33-37`（ヘッダーコメント）
- Test: `apps/cmux-team-dispatch-task/test/test-role-models.sh`（新規）

**Interfaces:**
- Consumes: なし
- Produces: `launch-workspace.sh` が `--role plan|review|exec` と `--runner <name>` から
  model / effort を解決し、claude engine では `--model '<M>' --effort '<E>'` を、
  codex engine では `--model '<M>'` と `-c model_reasoning_effort='<E>'` を composed command
  へ注入する。Task 3・Task 4 の `prewarm-panes.sh` はこれに依存して `--model` を渡さなくなる

- [ ] **Step 1: 失敗するテストを書く**

`apps/cmux-team-dispatch-task/test/test-role-models.sh` を新規作成する。

```bash
#!/usr/bin/env bash
# 役割ごとの model / effort 解決が engine 中立であることの回帰テスト。
#   RM1-RM6 : claude runner の役割別 model / effort
#   RM7-RM9 : 既定値の適用
#   RM10-RM12: 明示指定の優先と allowlist

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCH="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/launch-workspace.sh"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/repo" "$TMP/status"
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
    { "name": "bare", "command": "claude", "engine": "claude" }
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
      --status-dir "$TMP/status" "$@" "$name")
  else
    output=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" bash "$LAUNCH" \
      --cwd "$TMP/repo" --mode "$mode" --runner "$runner" \
      --status-dir "$TMP/status" "$@" "$name" prompt)
  fi
  jq -r '.runner_file' <<<"$output"
}

assert_contains() {
  local file="$1" expected="$2" label="$3"
  [[ -f "$file" ]] || { bad "$label (no such file: $file)"; return; }
  grep -Fq -- "$expected" "$file" && pass "$label" || bad "$label (missing: $expected)"
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
if grep -Fq -- '--dangerously-skip-permissions' "$sp_r"; then
  bad 'RM10c superpowers must not add --dangerously-skip-permissions'
else
  pass 'RM10c superpowers must not add --dangerously-skip-permissions'
fi

# --- RM11: 明示指定が runner 設定より優先される ---
ovr=$(runner_for rm-ovr tuned plan --model haiku --effort high)
assert_contains "$ovr" "--model 'haiku'" 'RM11a explicit --model wins'
assert_contains "$ovr" "--effort 'high'" 'RM11b explicit --effort wins'

# --- RM12: engine 別の effort allowlist ---
if CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" bash "$LAUNCH" \
     --cwd "$TMP/repo" --mode plan --runner bare --effort minimal \
     --status-dir "$TMP/status" rm-bad-claude prompt >/dev/null 2>&1; then
  bad 'RM12a claude rejects effort=minimal'
else
  pass 'RM12a claude rejects effort=minimal'
fi
if CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" bash "$LAUNCH" \
     --cwd "$TMP/repo" --mode plan --runner bare --effort max \
     --status-dir "$TMP/status" rm-ok-claude prompt >/dev/null 2>&1; then
  pass 'RM12b claude accepts effort=max'
else
  bad 'RM12b claude accepts effort=max'
fi

[[ $fail -eq 0 ]] && echo '--- all tests passed ---' || echo '--- failures ---'
exit "$fail"
```

- [ ] **Step 2: テストが落ちることを確認する**

```bash
cd apps/cmux-team-dispatch-task && bash test/test-role-models.sh
```

期待: RM1〜RM12 の大半が FAIL（claude engine では model/effort フォールバックが効かず、
`--effort` フラグも組み立てられないため）。exit code 1。

- [ ] **Step 3: model / effort 解決を engine 中立にする**

`launch-workspace.sh` の 427-454 行（`# model / effort 解決: codex engine のみ` から
`fi` まで）を次で置き換える。Task 0 Step 2 で codex が `max` を受理すると確定した場合だけ
codex 側の正規表現に `|max` を足す。

```bash
# model / effort 解決: engine 中立。優先順位は 明示指定 > runner の role フィールド > 既定値。
# claude の model 既定は role ごとに固定し、codex の model 既定は置かない
# (モデル名がアカウント・バージョン依存のため codex 側 config.toml へ委ねる)。
# effort の既定は engine 共通 (plan/review=xhigh, exec=high)。
CODEX_EFFORT_FLAG=""
case "$MODEL_ROLE" in
  plan)
    [[ -z "$MODEL" ]] && MODEL="$RUNNER_PLAN_MODEL"
    [[ -z "$EFFORT" ]] && EFFORT="$RUNNER_PLAN_EFFORT"
    [[ -z "$MODEL" && "$RUNNER_ENGINE" == "claude" ]] && MODEL="opus[1m]"
    [[ -z "$EFFORT" ]] && EFFORT="xhigh"
    ;;
  review)
    [[ -z "$MODEL" ]] && MODEL="$RUNNER_REVIEW_MODEL"
    [[ -z "$EFFORT" ]] && EFFORT="$RUNNER_REVIEW_EFFORT"
    [[ -z "$MODEL" && "$RUNNER_ENGINE" == "claude" ]] && MODEL="opus[1m]"
    [[ -z "$EFFORT" ]] && EFFORT="xhigh"
    ;;
  exec)
    [[ -z "$MODEL" ]] && MODEL="$RUNNER_EXEC_MODEL"
    [[ -z "$EFFORT" ]] && EFFORT="$RUNNER_EXEC_EFFORT"
    [[ -z "$MODEL" && "$RUNNER_ENGINE" == "claude" ]] && MODEL="sonnet"
    [[ -z "$EFFORT" ]] && EFFORT="high"
    ;;
esac
[[ -n "$MODEL" ]] && log "runner" "applying model=$MODEL ($RUNNER_ENGINE $MODEL_ROLE)"
if [[ "$RUNNER_ENGINE" == "codex" ]]; then
  [[ "$EFFORT" =~ ^(minimal|low|medium|high|xhigh)$ ]] \
    || die "invalid --effort '$EFFORT' for codex (must be minimal|low|medium|high|xhigh)"
  CODEX_EFFORT_FLAG=" -c model_reasoning_effort='$EFFORT'"
else
  [[ "$EFFORT" =~ ^(low|medium|high|xhigh|max)$ ]] \
    || die "invalid --effort '$EFFORT' for claude (must be low|medium|high|xhigh|max)"
fi
log "runner" "applying reasoning effort=$EFFORT ($RUNNER_ENGINE $MODEL_ROLE)"
```

- [ ] **Step 4: claude のフラグ組み立てを model/effort と権限に分ける**

726-742 行の `CLAUDE_EXTRA_FLAGS` ブロックを次で置き換える。`superpowers` モードは
権限フラグを付けない一方で model/effort は必要なので、2 つの変数に分ける。

```bash
# claude engine の起動フラグ。model/effort と権限フラグを分けるのは、superpowers モードが
# 権限フラグを付けない (permissions.defaultMode を settings.local.json で注入する) 一方で
# model/effort は全モードで必要なため。
# 順序: <command> [--model X] [--effort Y] [--dangerously-skip-permissions] '<inner prompt>'
CLAUDE_MODEL_FLAGS=""
if [[ -n "$MODEL" ]]; then
  # model 名に [1m] のような glob メタ文字が含まれても zsh -ic 内で展開されないよう quote する
  CLAUDE_MODEL_FLAGS="--model '$MODEL'"
fi
if [[ -n "$EFFORT" ]]; then
  CLAUDE_MODEL_FLAGS="${CLAUDE_MODEL_FLAGS:+$CLAUDE_MODEL_FLAGS }--effort '$EFFORT'"
fi
# 無人ループでは permission prompt / ExitPlanMode 承認で止まらないよう強制する
if [[ $UNATTENDED -eq 1 && "$RUNNER_ENGINE" == "claude" ]]; then
  SKIP_PERMISSIONS=1
fi
CLAUDE_EXTRA_FLAGS="$CLAUDE_MODEL_FLAGS"
if [[ $SKIP_PERMISSIONS -eq 1 ]]; then
  CLAUDE_EXTRA_FLAGS="${CLAUDE_EXTRA_FLAGS:+$CLAUDE_EXTRA_FLAGS }--dangerously-skip-permissions"
fi
```

- [ ] **Step 5: claude の superpowers / plan モードに model/effort を通す**

777-801 行の claude engine ブロックのうち、`superpowers` と最後の `else`（plan）の
2 分岐を次で置き換える。`execute` / `standby` / `review` の 3 分岐は変更しない。

```bash
    elif [[ "$MODE" == "superpowers" ]]; then
      # superpowers mode: 権限フラグは付けない。permission prompt の抑止は Step 2a で
      # worktree の .claude/settings.local.json に注入する permissions.defaultMode が担う
      # (AskUserQuestion は permission gate とは別レイヤーなので bypassPermissions 下でも
      #  対話的に残る。詳細は Step 2a のコメント)。model/effort は役割設定なので付ける
      CORE_CMD="$RUNNER_COMMAND${CLAUDE_MODEL_FLAGS:+ $CLAUDE_MODEL_FLAGS} '$PROMPT_TEXT'"
    else
      CORE_CMD="$RUNNER_COMMAND${CLAUDE_MODEL_FLAGS:+ $CLAUDE_MODEL_FLAGS} --dangerously-skip-permissions '/plan $PROMPT_TEXT'"
    fi
```

- [ ] **Step 6: ヘッダーコメントを更新する**

33-37 行の `--model` / `--effort` の説明を次で置き換える。

```bash
#   --model <model>                    Model flag passed as --model <X>. engine を問わず
#                                      未指定時は runner の role 対応 plan_model /
#                                      review_model / exec_model にフォールバックし、
#                                      claude はさらに plan/review=opus[1m] / exec=sonnet を既定とする
#   --effort <level>                   Reasoning effort. engine を問わず未指定時は runner の
#                                      plan_effort / review_effort / exec_effort に
#                                      フォールバックし、既定は plan/review=xhigh / exec=high。
#                                      claude は --effort、codex は -c model_reasoning_effort へ注入
```

- [ ] **Step 7: テストが通ることを確認する**

```bash
cd apps/cmux-team-dispatch-task && bash test/test-role-models.sh
```

期待: `--- all tests passed ---`、exit 0。

- [ ] **Step 8: 既存の codex テストへの影響を確認して更新する**

```bash
cd apps/cmux-team-dispatch-task && bash test/test-launch-workspace-codex.sh
```

`runners.json` の `claude` runner（役割フィールドなし）を使う assertion が
`--model 'opus[1m]' --effort 'xhigh'` を含むようになるため、
`--model` が付かないことを期待している negative assertion があれば
「既定値が付く」期待へ書き換える。effort 未設定の codex runner を使うケースがあれば
`-c model_reasoning_effort='xhigh'`（plan/review）/ `'high'`（exec）が付く期待へ更新する。

- [ ] **Step 9: 実際に claude が `--effort` を受け付けることを確認する**

```bash
claude --model 'opus[1m]' --effort 'xhigh' --print 'reply with OK only'
```

期待: エラーにならず応答が返る。失敗する場合は spec の「実装時に検証する未確定事項 2」に
該当するので、この時点で停止して報告する。

- [ ] **Step 10: commit**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh \
        apps/cmux-team-dispatch-task/test/test-role-models.sh \
        apps/cmux-team-dispatch-task/test/test-launch-workspace-codex.sh
git commit -m "feat(cmux-team-dispatch-task): 役割別 model / effort を engine 中立にする"
```

---

### Task 2: `config-edit.sh` の `exec_choice` を engine 値へ変える

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/config-edit.sh:30`（コメント）
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/config-edit.sh:59-60`（`valid_value`）
- Test: `apps/cmux-team-dispatch-task/test/test-config-edit.sh:94,104,145`

**Interfaces:**
- Consumes: なし
- Produces: `config-edit.sh --set exec_choice=claude|codex|ask` のみ成功し、
  `opus 1m` / `sonnet` は exit 2 で拒否される。Task 5 の SKILL.md Step 1g がこの値域に依存する

- [ ] **Step 1: 失敗するテストを書く**

`test/test-config-edit.sh` の 94 行と 104 行のリストを書き換える。

94 行（不正値リスト）:

```bash
for pair in 'review_mode=maybe' 'exec_choice=haiku' 'exec_choice=opus 1m' 'exec_choice=sonnet' 'prewarm=yes' 'design_runner='; do
```

104 行（正当値リスト）:

```bash
for pair in 'review_mode=ask' 'exec_choice=claude' 'exec_choice=codex' 'exec_choice=ask' 'design_runner=ask'; do
```

145 行の fixture も新しい値域に合わせる:

```bash
printf '{"shell_ready_ms":{"baseline_ms":1},"review_mode":"off","exec_choice":"claude"}\n' > "$C"
```

- [ ] **Step 2: テストが落ちることを確認する**

```bash
cd apps/cmux-team-dispatch-task && bash test/test-config-edit.sh
```

期待: `exec_choice=opus 1m` / `exec_choice=sonnet` が受理されてしまい FAIL、
`exec_choice=claude` が拒否されて FAIL。exit code 1。

- [ ] **Step 3: `valid_value` を更新する**

`config-edit.sh` の 59-60 行を置き換える。

```bash
    exec_choice)
      case "$2" in claude|codex|ask) return 0 ;; *) return 1 ;; esac ;;
```

- [ ] **Step 4: ヘッダーコメントを更新する**

30 行を置き換える。

```bash
#   exec_choice    "claude" | "codex" | "ask"
```

- [ ] **Step 5: テストが通ることを確認する**

```bash
cd apps/cmux-team-dispatch-task && bash test/test-config-edit.sh
```

期待: `--- all tests passed ---`、exit 0。

- [ ] **Step 6: commit**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/config-edit.sh \
        apps/cmux-team-dispatch-task/test/test-config-edit.sh
git commit -m "feat(cmux-team-dispatch-task): exec_choice を engine 選択へ変更する"
```

---

### Task 3: `prewarm-panes.sh` の executor を engine 単位にする

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh`（定数、`START_*`、Step 4/4.5/5、`prewarm.json` 生成）
- Test: `apps/cmux-team-dispatch-task/test/test-prewarm-layout.sh`
- Test: `apps/cmux-team-dispatch-task/test/test-prewarm-all-codex.sh`
- Test: `apps/cmux-team-dispatch-task/test/test-prewarm-unattended.sh`

**Interfaces:**
- Consumes: Task 1 の役割フォールバック（`--model` を渡さなくてもモデルが決まる）
- Consumes: Task 2 の `exec_choice` 値域
- Produces: `prewarm.json` の `executors` が `claude` / `codex` の 2 キーのみを持ち、
  実装ペインの agmsg agent 名が `<slug>-claude` / `<slug>-codex` になる。
  Task 4 と Task 5 がこのスキーマに依存する

- [ ] **Step 1: 失敗するテストを書く**

`test/test-prewarm-layout.sh` の PG1 / PG3 を新スキーマへ書き換える。
`pg1-sonnet` → `pg1-claude`、`pg3-sonnet` / `pg3-opus` の 2 ペインは
**1 つの `pg3-claude` に統合される**（engine 単位になるため codex design + ask でも
実装ペインは claude 1 つ + codex 1 つの計 2 つ）。

PG1 ブロックを置き換える:

```bash
# --- PG1: claude design + review + ask (design / claude / codex / review = 2×2) ---
run_case pg1 --design-runner claude --reviewer-runner codex \
  --claude-runner claude --codex-runner codex --exec-choice ask
[[ $(wc -l < "$TMP/argv-pg1.log" | tr -d ' ') == 4 ]] \
  && pass 'PG1 four panes' || bad 'PG1 four panes'
expect_split PG1 pg1-claude surface:1 down
expect_split PG1 pg1-codex surface:2 right
expect_split PG1 pg1-review surface:1 right
```

PG3 ブロックを置き換える:

```bash
# --- PG3: codex design + ask (design / claude / codex / review) ---
run_case pg3 --design-runner codex --reviewer-runner codex \
  --claude-runner claude --codex-runner codex --exec-choice ask
[[ $(wc -l < "$TMP/argv-pg3.log" | tr -d ' ') == 4 ]] \
  && pass 'PG3 four panes' || bad 'PG3 four panes'
expect_split PG3 pg3-claude surface:1 down
expect_split PG3 pg3-codex surface:2 right
expect_split PG3 pg3-review surface:1 right
```

PG2 は `--exec-choice codex` を維持したまま `pg2-codex` のままでよい。

`test/test-prewarm-all-codex.sh` の 71 行と 73-75 行を置き換える:

```bash
# prewarm はもう --model を渡さないので "--model sonnet" の不在では claude ペインの
# 不在を証明できない。engine ごとの pane 記録そのものを見る
grep -Fq -- '--runner claude' "$TMP/argv.log" && bad 'AC5 no claude pane'
jq -e '.design.engine == "codex" and .review.engine == "codex" and
  .executors.codex.engine == "codex" and (.executors.claude == null)' \
  "$TMP/status/prewarm.json" >/dev/null || bad 'AC7 role-aware prewarm.json'
```

`test/test-prewarm-unattended.sh` の 190 / 215 / 243-245 / 279 行の
`.executors.opus` / `.executors.sonnet` を `.executors.claude` へ、
期待ペイン数を engine 単位（claude 1 + codex 1）へ更新する。

- [ ] **Step 2: テストが落ちることを確認する**

```bash
cd apps/cmux-team-dispatch-task
bash test/test-prewarm-layout.sh; bash test/test-prewarm-all-codex.sh; bash test/test-prewarm-unattended.sh
```

期待: いずれも FAIL（`pg1-claude` ペインが存在せず、`executors.claude` が null のため）。

- [ ] **Step 3: 定数と `START_*` を engine 単位にする**

`prewarm-panes.sh` の 55-56 行（`OPUS_MODEL` / `SONNET_MODEL`）を削除する。
続いて `START_SONNET` / `START_CODEX` / `START_OPUS` の宣言と `case "$EXEC_CHOICE"`
ブロック全体（現行 197-227 行相当）を次で置き換える。

```bash
# 実装ペインは engine 単位。exec_choice は「どの engine が実装するか」だけを表し、
# モデルと effort は runners.json の役割フィールドが決める。
START_CLAUDE=0
START_CODEX=0
case "$EXEC_CHOICE" in
  ""|ask)
    [[ -n "$CLAUDE_RUNNER" || "$DESIGN_ENGINE" == "claude" ]] && START_CLAUDE=1
    [[ -n "$CODEX_RUNNER" ]] && START_CODEX=1
    ;;
  claude)
    [[ -z "$EXEC_RUNNER" || "$EXEC_ENGINE" == "claude" ]] \
      || die "exec_choice=claude requires a claude exec runner"
    START_CLAUDE=1 ;;
  codex)
    [[ -n "$EXEC_RUNNER" || -n "$CODEX_RUNNER" ]] \
      || die "exec_choice=codex requires --exec-runner or --codex-runner"
    [[ -z "$EXEC_RUNNER" || "$EXEC_ENGINE" == "codex" ]] \
      || die "exec_choice=codex requires a codex exec runner"
    START_CODEX=1 ;;
  *) die "invalid --exec-choice '$EXEC_CHOICE' (must be claude, codex, or ask)" ;;
esac
```

- [ ] **Step 4: agmsg join を engine 単位にする**

`if [[ $START_SONNET -eq 1 ]]` / `if [[ $START_OPUS -eq 1 ]]` の 2 つの join ブロックを
1 つに統合する。

```bash
  if [[ $START_CLAUDE -eq 1 ]]; then
    if bash "$AGMSG_DIR/join.sh" "$AGMSG_TEAM" "$SLUG-claude" claude-code "$CWD" >&2 2>/dev/null; then
      wire_delivery claude
    else
      log "agmsg" "claude executor join failed; falling back to cmux-send"
    fi
  fi
```

- [ ] **Step 5: Step 4（sonnet）を claude executor に作り替え、Step 4.5（opus）を削除する**

`SONNET_*` 変数群と Step 4 ブロック全体、および Step 4.5（`OPUS_EXEC_SURFACE`）を
次の 1 ブロックで置き換える。`--model` は渡さず、Task 1 の役割フォールバックに委ねる。

```bash
# --- Step 4: claude 実装 standby (選択時のみ、split 配置) ---

CLAUDE_EXEC_SURFACE=""
CLAUDE_EXEC_PROMPT=""
CLAUDE_EXEC_RUNNER=""
if [[ "$EXEC_CHOICE" == "claude" ]]; then
  CLAUDE_EXEC_RUNNER="$EXEC_RUNNER"
elif [[ -z "$EXEC_CHOICE" || "$EXEC_CHOICE" == "ask" ]]; then
  CLAUDE_EXEC_RUNNER="$CLAUDE_RUNNER"
  [[ -z "$CLAUDE_EXEC_RUNNER" && "$DESIGN_ENGINE" == "claude" ]] && CLAUDE_EXEC_RUNNER="$DESIGN_RUNNER"
fi
AGMSG_FLAGS_CLAUDE=()
if [[ $START_CLAUDE -eq 1 && -n "$AGMSG_TEAM" ]]; then
  # design と同じ理由で delivery に応じて出し分ける (cmux-send フォールバック時は actas しない)
  if [[ "$CLAUDE_DELIVERY" == "agmsg" ]]; then
    CLAUDE_EXEC_PROMPT="/agmsg actas $SLUG-claude then wait idle. Execution instructions will arrive as a prompt typed into this pane; an identical copy is also pushed to your agmsg inbox (treat both as ONE task — ignore the duplicate). Do not start any work until the instructions arrive."
  else
    CLAUDE_EXEC_PROMPT="Wait idle. Execution instructions will be typed directly into this pane as a prompt. Do not start any work until they arrive."
  fi
  AGMSG_FLAGS_CLAUDE=(--agmsg-team "$AGMSG_TEAM" --agmsg-from "$SLUG-claude")
fi

if [[ $START_CLAUDE -eq 1 ]]; then
  log "prewarm" "launching claude executor standby pane for $SLUG"
  set_exec_split_flags
  CLAUDE_ARGS=(
    --cwd "$CWD"
    --mode standby
    --role exec
    --standby-in "$WORKSPACE"
    "${EXEC_SPLIT_FLAGS[@]}"
    --skip-permissions
    ${SENTINEL_FLAGS[@]+"${SENTINEL_FLAGS[@]}"}
    --status-dir "$STATUS_DIR"
  )
  [[ -n "$CLAUDE_EXEC_RUNNER" ]] && CLAUDE_ARGS+=(--runner "$CLAUDE_EXEC_RUNNER")
  CLAUDE_RESULT=$(bash "$SCRIPT_DIR/launch-workspace.sh" \
    "${CLAUDE_ARGS[@]}" \
    ${NOTIFY_FLAGS[@]+"${NOTIFY_FLAGS[@]}"} \
    ${AGMSG_FLAGS_CLAUDE[@]+"${AGMSG_FLAGS_CLAUDE[@]}"} \
    "$SLUG-claude" ${CLAUDE_EXEC_PROMPT:+"$CLAUDE_EXEC_PROMPT"}) || die "failed to launch claude executor standby pane"
  CLAUDE_EXEC_SURFACE=$(echo "$CLAUDE_RESULT" | jq -r '.surface_id // empty')
  [[ -n "$CLAUDE_EXEC_SURFACE" ]] || die "failed to parse claude executor standby output"
  EXEC_LAST_SURFACE="$CLAUDE_EXEC_SURFACE"
fi
```

- [ ] **Step 6: review ペインの `--model` を役割フォールバックへ委ねる**

Step 5.5 の `--reviewer-runner` 分岐から `--model` を外す。codex reviewer に
`review_model` を要求する検証（177-180 行相当）は残す。legacy の `--review-model`
分岐は従来どおり `--model "$REVIEW_MODEL"` を渡す。

```bash
    REVIEW_RUNNER_FLAGS=(--runner "$REVIEWER_RUNNER")
    [[ "$REVIEWER_ENGINE" == "claude" ]] && REVIEW_RUNNER_FLAGS+=(--skip-permissions)
```

`REVIEW_MODEL_RESOLVED` は claude の既定を埋める行（`[[ -z "$REVIEW_MODEL_RESOLVED" && ...`）
を削除し、codex 必須チェックのためだけに残す。

- [ ] **Step 7: `prewarm.json` の executors キーを engine 名にする**

Step 6 の `jq -n` 呼び出しから `--arg ops` / `--arg ss` を削除し、
`--arg ces "$CLAUDE_EXEC_SURFACE"` / `--arg cer "$CLAUDE_EXEC_RUNNER"` を足す。
`executors` の式を次で置き換える。

```jq
   + {executors:
        ((if $ces != "" then {claude: {surface_id: $ces, agent: ($slug + "-claude"), runner: $cer, engine: "claude", role: "exec", delivery: $dc}} else {} end)
         + (if $cs != "" then {codex: {surface_id: $cs, agent: ($slug + "-codex"), runner: $crr, engine: "codex", role: "exec", delivery: $dx}} else {} end))}
```

- [ ] **Step 8: 使用箇所コメントとヘッダーを更新する**

ヘッダーの `#   4. --exec-choice で選ばれた sonnet / codex 実装 standby を split で配置` を
`#   4. --exec-choice で選ばれた engine の実装 standby を split で配置` に、
`# --- Step 5: codex standby ...` のコメントも新しい呼称に合わせる。

- [ ] **Step 9: テストが通ることを確認する**

```bash
cd apps/cmux-team-dispatch-task
bash test/test-prewarm-layout.sh && bash test/test-prewarm-all-codex.sh && bash test/test-prewarm-unattended.sh
```

期待: 3 本とも `--- all tests passed ---`。

- [ ] **Step 10: commit**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh \
        apps/cmux-team-dispatch-task/test/test-prewarm-layout.sh \
        apps/cmux-team-dispatch-task/test/test-prewarm-all-codex.sh \
        apps/cmux-team-dispatch-task/test/test-prewarm-unattended.sh
git commit -m "feat(cmux-team-dispatch-task): 実装ペインを engine 単位へ統合する"
```

---

### Task 4: in-session のとき実装ペインを起動しない

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh`（役割解決と `START_*` の抑止）
- Test: `apps/cmux-team-dispatch-task/test/test-in-session.sh`（新規）

**Interfaces:**
- Consumes: Task 3 の `START_CLAUDE` / `START_CODEX` と `executors` スキーマ
- Produces: `prewarm.json` の `executors` が `{}` になるケース。Task 5 の Phase B が
  「executors が空なら in-session」と判定できる

- [ ] **Step 1: 失敗するテストを書く**

`apps/cmux-team-dispatch-task/test/test-in-session.sh` を新規作成する。

```bash
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
      "plan_model": "gpt-5.6-sol", "review_model": "gpt-5.6-sol", "exec_model": "gpt-5.6-terra" }
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

[[ $fail -eq 0 ]] && echo '--- all tests passed ---' || echo '--- failures ---'
exit "$fail"
```

- [ ] **Step 2: テストが落ちることを確認する**

```bash
cd apps/cmux-team-dispatch-task && bash test/test-in-session.sh
```

期待: IS1 / IS1b が FAIL（実装ペインが起動され executors が空にならない）。exit code 1。

- [ ] **Step 3: 役割の model / effort を解決するヘルパーを足す**

`prewarm-panes.sh` の検証セクション（`START_CLAUDE=0` の直前）へ次を挿入する。
既定値は Task 1 と同じ表を使う。

```bash
# 役割ごとの model / effort を runners.json + 既定値から解決する。launch-workspace.sh の
# 役割フォールバックと同じ表を使う (どちらか一方だけ変えると in-session 判定がずれる)。
resolve_role_model() {
  local runner="$1" role="$2" engine="$3" value=""
  if [[ -n "$runner" && -f "$RUNNERS_CONFIG_PATH" ]]; then
    value=$(jq -r --arg n "$runner" --arg f "${role}_model" \
      '.runners[]? | select(.name == $n) | .[$f] // empty' "$RUNNERS_CONFIG_PATH")
  fi
  if [[ -z "$value" && "$engine" == "claude" ]]; then
    case "$role" in
      plan|review) value="opus[1m]" ;;
      exec) value="sonnet" ;;
    esac
  fi
  printf '%s' "$value"
}

resolve_role_effort() {
  local runner="$1" role="$2" value=""
  if [[ -n "$runner" && -f "$RUNNERS_CONFIG_PATH" ]]; then
    value=$(jq -r --arg n "$runner" --arg f "${role}_effort" \
      '.runners[]? | select(.name == $n) | .[$f] // empty' "$RUNNERS_CONFIG_PATH")
  fi
  if [[ -z "$value" ]]; then
    case "$role" in
      plan|review) value="xhigh" ;;
      exec) value="high" ;;
    esac
  fi
  printf '%s' "$value"
}
```

- [ ] **Step 4: in-session 判定を入れて実装ペインを抑止する**

Task 3 Step 3 で書いた `case "$EXEC_CHOICE"` ブロックの**直後**に次を挿入する。
`ask` のときは実装 engine が未確定なので判定しない。

```bash
# 役割設定 (engine + model + effort) が完全一致するときは、設計セッションがそのまま
# 実装するので実装ペインを起動しない。effort を条件に含めるのは、effort がセッション
# 起動時に焼き込まれ、後から変える手段が無いため (モデルだけ一致していても
# exec_effort の設定が無視されてしまう)。
# exec_choice=ask は実装 engine が未確定なので判定せず、全候補を起動する。
if [[ -n "$EXEC_CHOICE" && "$EXEC_CHOICE" != "ask" ]]; then
  EXEC_ROLE_ENGINE="${EXEC_ENGINE:-$EXEC_CHOICE}"
  if [[ "$EXEC_ROLE_ENGINE" == "$DESIGN_ENGINE" ]]; then
    PLAN_MODEL_RESOLVED=$(resolve_role_model "$DESIGN_RUNNER" plan "$DESIGN_ENGINE")
    PLAN_EFFORT_RESOLVED=$(resolve_role_effort "$DESIGN_RUNNER" plan)
    EXEC_MODEL_RESOLVED=$(resolve_role_model "${EXEC_RUNNER:-$DESIGN_RUNNER}" exec "$EXEC_ROLE_ENGINE")
    EXEC_EFFORT_RESOLVED=$(resolve_role_effort "${EXEC_RUNNER:-$DESIGN_RUNNER}" exec)
    if [[ "$PLAN_MODEL_RESOLVED" == "$EXEC_MODEL_RESOLVED" \
       && "$PLAN_EFFORT_RESOLVED" == "$EXEC_EFFORT_RESOLVED" ]]; then
      log "prewarm" "in-session execution (role config identical); skipping the executor pane"
      START_CLAUDE=0
      START_CODEX=0
    fi
  fi
fi
```

- [ ] **Step 5: テストが通ることを確認する**

```bash
cd apps/cmux-team-dispatch-task && bash test/test-in-session.sh
```

期待: IS1〜IS5 が全て PASS、`--- all tests passed ---`。

- [ ] **Step 6: 既存の prewarm テストが壊れていないことを確認する**

```bash
cd apps/cmux-team-dispatch-task
bash test/test-prewarm-layout.sh && bash test/test-prewarm-all-codex.sh && bash test/test-prewarm-unattended.sh
```

期待: 3 本とも `--- all tests passed ---`。`test-prewarm-all-codex.sh` は
design=codex / exec=codex で `plan_model=gpt-5.6-sol` と `exec_model=gpt-5.6-terra` が
異なるため in-session にならず、3 ペインのまま通る。

- [ ] **Step 7: commit**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh \
        apps/cmux-team-dispatch-task/test/test-in-session.sh
git commit -m "feat(cmux-team-dispatch-task): 役割設定が一致するとき実装ペインを省く"
```

---

### Task 5: `SKILL.md` と `guide-ja.md` を新しい解決モデルへ更新する

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md`
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md`

**Interfaces:**
- Consumes: Task 1〜4 の全成果（役割フォールバック、`exec_choice` 値域、`executors` スキーマ、in-session 判定）
- Produces: 子セッションが読む指示文。Task 6 の README / CLAUDE.md がこの記述と一致する

- [ ] **Step 1: runners.json スキーマ節を engine 中立にする**

`SKILL.md:310-345` 付近の「runners.json schema (minimal)」とフィールド説明を書き換える。
`(optional, engine: codex runners only)` の限定を全て外し、既定値の表を足す。

```markdown
**runners.json schema (minimal):**

```json
{
  "default": "claude",
  "runners": [
    { "name": "claude", "command": "claude", "engine": "claude",
      "plan_model": "opus[1m]", "review_model": "opus[1m]", "exec_model": "fable",
      "plan_effort": "max", "review_effort": "xhigh", "exec_effort": "high" },
    { "name": "codex", "command": "codex", "engine": "codex",
      "plan_model": "gpt-5.6-sol", "review_model": "gpt-5.6-sol", "exec_model": "gpt-5.6-terra",
      "plan_effort": "xhigh", "review_effort": "xhigh", "exec_effort": "high" }
  ]
}
```

Field meanings:

- `name`: unique identifier shown in AskUserQuestion options
- `command`: the executable / zsh function to invoke
- `engine`: `claude` or `codex` — controls flag composition (see table below)
- `plan_model` / `review_model` / `exec_model` (optional, **both engines**): the model for
  that role. `launch-workspace.sh` resolves them from `--role`.
- `plan_effort` / `review_effort` / `exec_effort` (optional, **both engines**): the
  reasoning effort for that role. claude accepts `low|medium|high|xhigh|max` and receives
  `--effort <value>`; codex accepts `minimal|low|medium|high|xhigh` and receives
  `-c model_reasoning_effort='<value>'`.

Defaults when a field is unset:

| role | claude model | codex model | effort (both engines) |
|------|--------------|-------------|-----------------------|
| plan | `opus[1m]` | none (codex-side default) | `xhigh` |
| review | `opus[1m]` | required when chosen as reviewer | `xhigh` |
| exec | `sonnet` | none (codex-side default) | `high` |

Resolution order for both model and effort:
`--model` / `--effort` explicit > the runner's `<role>_model` / `<role>_effort` > the table above.
```

- [ ] **Step 2: Step 1g の `exec_choice` 解決を engine 選択へ書き換える**

`SKILL.md:610-700` の `resolve_exec_runner` / `valid_exec_choice` / 解決ブロックを
次で置き換える。

```bash
# Return the registered runner that can execute on the requested engine. Prefer the
# already-resolved design runner when its engine matches; otherwise use the first
# registered runner of that engine. A missing record returns non-zero.
resolve_exec_runner() {
  local required_engine="$1" preferred
  case "$required_engine" in
    claude|codex) ;;
    *) return 1 ;;
  esac

  preferred=$(jq -r --arg n "$DESIGN_RUNNER" --arg e "$required_engine" \
    '.runners[]? | select(.name == $n and .engine == $e and (.command // "") != "") | .name' \
    "$RUNNERS_JSON")
  if [[ -n "$preferred" ]]; then
    printf '%s\n' "$preferred"
    return 0
  fi

  jq -er --arg e "$required_engine" \
    '[.runners[]? | select(.engine == $e and (.name // "") != "" and (.command // "") != "") | .name][0] // empty' \
    "$RUNNERS_JSON"
}

# Valid values = "claude" | "codex" | "ask". "ask" is valid and stops fallback. A fixed
# engine is valid only when a runner of that engine can be resolved. Invalid values or
# unavailable engines warn, invalidate only that config layer, and continue
# project -> global -> interactive fallback. The pre-v1.20.0 values "opus 1m" and
# "sonnet" are no longer accepted; they invalidate their layer like any other bad value.
valid_exec_choice() {
  case "$1" in
    ask) return 0 ;;
    claude|codex) resolve_exec_runner "$1" >/dev/null ;;
    *) return 1 ;;
  esac
}
EXEC_CHOICE=$(jq -r '.exec_choice // empty' .dispatch/config.json 2>/dev/null)
if [[ -n "$EXEC_CHOICE" ]] && ! valid_exec_choice "$EXEC_CHOICE"; then
  echo "[warn] exec_choice=\"$EXEC_CHOICE\" (project) invalid (expected: claude | codex | ask); ignoring this layer" >&2
  EXEC_CHOICE=""
fi
if [[ -z "$EXEC_CHOICE" ]]; then
  EXEC_CHOICE=$(jq -r '.exec_choice // empty' \
    ~/.claude/cmux-team-dispatch-task/config.json 2>/dev/null)
  if [[ -n "$EXEC_CHOICE" ]] && ! valid_exec_choice "$EXEC_CHOICE"; then
    echo "[warn] exec_choice=\"$EXEC_CHOICE\" (global) invalid (expected: claude | codex | ask); ignoring this layer" >&2
    EXEC_CHOICE=""
  fi
fi

# Resolve the execution role's runner, engine, model, and effort. Do not infer them
# later from the choice; the same resolved values decide the in-session rule below.
EXEC_RUNNER=""
EXEC_ENGINE=""
EXEC_MODEL=""
EXEC_EFFORT=""
CLAUDE_EXEC_RUNNER=""
CODEX_EXEC_RUNNER=""
if [[ -n "$EXEC_CHOICE" && "$EXEC_CHOICE" != "ask" ]]; then
  EXEC_RUNNER=$(resolve_exec_runner "$EXEC_CHOICE")
  EXEC_ENGINE="$EXEC_CHOICE"
  EXEC_MODEL=$(jq -r --arg n "$EXEC_RUNNER" \
    '.runners[] | select(.name == $n) | .exec_model // empty' "$RUNNERS_JSON")
  EXEC_EFFORT=$(jq -r --arg n "$EXEC_RUNNER" \
    '.runners[] | select(.name == $n) | .exec_effort // empty' "$RUNNERS_JSON")
  [[ -z "$EXEC_MODEL" && "$EXEC_ENGINE" == "claude" ]] && EXEC_MODEL="sonnet"
  [[ -z "$EXEC_EFFORT" ]] && EXEC_EFFORT="high"
else
  # ask/unset advertises every available engine. Resolve its candidates now so
  # prewarm never falls through to the launcher's default command.
  CLAUDE_EXEC_RUNNER=$(resolve_exec_runner claude 2>/dev/null || true)
  CODEX_EXEC_RUNNER=$(resolve_exec_runner codex 2>/dev/null || true)
fi
```

- [ ] **Step 3: `PLAN_MODEL` / `PLAN_EFFORT` の解決と in-session 判定を足す**

Step 1f の項目 4（`SKILL.md:295-300` 付近、`DESIGN_RUNNER` / `DESIGN_ENGINE` / `PLAN_MODEL`
を持ち回る記述）の直後に次のブロックを足す。

```bash
# Resolve the design role's model and effort with the same table launch-workspace.sh uses.
PLAN_MODEL=$(jq -r --arg n "$DESIGN_RUNNER" \
  '.runners[] | select(.name == $n) | .plan_model // empty' "$RUNNERS_JSON")
PLAN_EFFORT=$(jq -r --arg n "$DESIGN_RUNNER" \
  '.runners[] | select(.name == $n) | .plan_effort // empty' "$RUNNERS_JSON")
[[ -z "$PLAN_MODEL" && "$DESIGN_ENGINE" == "claude" ]] && PLAN_MODEL="opus[1m]"
[[ -z "$PLAN_EFFORT" ]] && PLAN_EFFORT="xhigh"
```

そして Step 1g の `exec_choice` 解決の直後に in-session 判定を足す。

```bash
# In-session execution: the design session implements the task itself instead of
# delegating. Effort is part of the condition because it is baked in at session launch
# and cannot be changed afterwards — matching only the model would silently run the
# execution phase at the design session's effort and ignore exec_effort.
# With EXEC_CHOICE="ask" the engine is not known yet; the child evaluates the same
# condition right after its Phase B answer.
IN_SESSION=false
if [[ -n "$EXEC_CHOICE" && "$EXEC_CHOICE" != "ask" \
   && "$EXEC_ENGINE" == "$DESIGN_ENGINE" \
   && "$EXEC_MODEL" == "$PLAN_MODEL" \
   && "$EXEC_EFFORT" == "$PLAN_EFFORT" ]]; then
  IN_SESSION=true
fi
```

- [ ] **Step 4: Phase B の分岐を engine 2 択 + in-session へ書き換える**

`SKILL.md:915-930` と `SKILL.md:1035-1070` の AskUserQuestion 選択肢を
`claude` / `codex` の 2 択にする。`SKILL.md:1065-1067` の pane-specific notes を
次で置き換える。

```text
  Pane-specific notes:
    [claude] target = prewarm.json .executors.claude.
    [codex]  target = prewarm.json .executors.codex (exec_model / exec_effort are baked in
      at pane launch).
    When prewarm.json's .executors is empty ({}), the role config is identical to the
    design session's: do NOT delegate and do NOT create .deferred — implement here.
```

`SKILL.md:1086-1088` の `{{EXEC_DEFAULT_HINT}}` ブロックを次で置き換える。

```text
  PHASE B — Execution engine default is fixed to "<default>" (skip AskUserQuestion):
    After ExitPlanMode, skip AskUserQuestion and immediately run the EXISTING Phase B
    branch for <default>. Do NOT invent a new execution path.
    - claude: run the existing prewarm or spawn claude delegation steps.
    - codex: run the existing prewarm or spawn codex delegation steps.
    - When prewarm.json's .executors is empty, implement in THIS session instead of
      delegating (the role config is identical), and do not create .deferred.
```

`SKILL.md:1128` の `<value>` 説明を `"claude" / "codex" / "ask"` へ更新する。

- [ ] **Step 5: reviewer 解決マトリクスを 2 ケースへ縮約する**

`SKILL.md:1380-1392` の `case "$DESIGN_ENGINE:$EXEC_CHOICE"` を次で置き換える。

```bash
        # The reviewer is always the engine opposite the implementer. When both roles
        # run on the same engine (including in-session execution) the dedicated review
        # pane reviews; when they differ the design session becomes the reviewer.
        if [[ "$DESIGN_ENGINE" == "$EXEC_ENGINE" ]]; then
          REVIEWER_SURFACE="$REVIEW_SURFACE"
          REVIEWER_RUNNER="$REVIEW_RUNNER"
          REVIEWER_ENGINE="$REVIEW_ENGINE"
        else
          REVIEWER_SURFACE="$CMUX_SURFACE_ID"
          REVIEWER_RUNNER="$DESIGN_RUNNER"
          REVIEWER_ENGINE="$DESIGN_ENGINE"
        fi
```

`SKILL.md:1341-1355` と `SKILL.md:1586` の `"opus 1m"` / `"sonnet"` を指す文言を
`in-session` / `claude` の語彙へ置き換える。

- [ ] **Step 6: 残りの語彙を機械的に置換する**

`SKILL.md` 全体に対して次の対応表で置換する。行番号ではなく**文字列で全数検索**すること
（Step 1〜5 の編集で行番号がずれるため）。

| 置換前 | 置換後 |
|--------|--------|
| `.executors.sonnet` | `.executors.claude` |
| `.executors.opus` | `.executors.claude` |
| `SONNET_SURFACE` | `CLAUDE_EXEC_SURFACE` |
| `<task-slug>-sonnet` / `<slug>-sonnet` | `<task-slug>-claude` / `<slug>-claude` |
| `<task-slug>-opus` / `<slug>-opus` | `<task-slug>-claude` / `<slug>-claude` |
| `exec_choice` の値としての `"opus 1m"` / `"sonnet"` | `"claude"` |
| `opus 1m / sonnet / codex`（選択肢の列挙） | `claude / codex` |
| `dedicated Opus and Sonnet executors` | `a dedicated claude executor` |

残存確認:

```bash
cd apps/cmux-team-dispatch-task
grep -n 'executors\.\(opus\|sonnet\)\|opus 1m\|SONNET_SURFACE' skills/cmux-team-dispatch-task/SKILL.md
```

期待: 0 件。ヒットしたら、そこが Step 1〜5 で拾えなかった箇所なので個別に直す。

- [ ] **Step 7: Notes 節を書き換える**

`SKILL.md` の Notes 節（`- **Same-model vs different-model in Phase B**` /
`- **Pre-warm role panes**` / `- **Codex option in Phase B**` /
`- **Child runner selection (Step 1f)**` の 4 項目）を次の内容へ書き換える。

```markdown
- **In-session vs delegated execution in Phase B**: the design session implements the
  task itself only when the execution role's engine, model, and effort all equal the
  design role's. Effort is part of the condition because it is baked in at session launch;
  matching only the model would run the execution phase at the design session's effort and
  silently ignore `exec_effort`. When the condition holds, `prewarm.json`'s `.executors`
  is `{}`, the child does NOT create `.deferred`, and the design pane keeps ownership of
  `status.json`. Otherwise the child delegates to the resolved executor pane, or spawns
  `launch-workspace.sh --mode execute --runner <EXEC_RUNNER>` when prewarm is off.
- **Pre-warm role panes**: when layout is `workspace` and config `prewarm: true`
  (default), `prewarm-panes.sh` places only resolved roles: design, optional review, and
  the execution engines allowed by `exec_choice`. `prewarm.json`'s `executors` holds at
  most `claude` and `codex`; a fixed `exec_choice` suppresses the other engine and an
  in-session role config leaves it empty. Models and efforts are never passed as
  `--model` / `--effort` from prewarm — the launcher's role fallback resolves them.
- **Codex option in Phase B**: the `codex` choice is shown only when `runners.json`
  contains a runner with `engine: "codex"`, and `claude` only when a claude runner exists.
  With just one engine registered, no question is asked. `cmux codex install-hooks` is
  still required so `external_migration = true` is set when migrating a Claude parent.
- **Child runner selection (Step 1f)**: Step 1f decides which runtime *launches* the
  child session; Phase B decides which *engine* implements. `design_runner` can fix
  Step 1f; `exec_choice` can fix Phase B. Models and efforts come from the runner's role
  fields in either case, never from the Phase B answer.
```

- [ ] **Step 8: `guide-ja.md` を 1:1 で同期する**

上の Step 1〜7 に対応する日本語節を `references/guide-ja.md` で更新する。
見出しの対応関係を崩さないこと。

- [ ] **Step 9: 言語ルールを検証する**

```bash
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins
node scripts/check-doc-lang.mjs apps/cmux-team-dispatch-task
```

期待: `check-doc-lang: OK`。SKILL.md に日本語が混入していたら削る。

- [ ] **Step 10: 配送一本化の回帰テストを流す**

```bash
cd apps/cmux-team-dispatch-task && bash test/test-send-prompt-callsites.sh
```

期待: CS1〜CS3 が PASS（SKILL.md / references の編集で `cmux send` 直書きが
混入していないこと）。

- [ ] **Step 11: commit**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md \
        apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md
git commit -m "docs(cmux-team-dispatch-task): 役割別 model / effort の解決を SKILL へ反映する"
```

---

### Task 6: `--setup` / first-run と README / CLAUDE.md を更新する

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/setup-mode.md:116,126`
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/setup-mode-ja.md`（対応節）
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md:399-455`（First-run setup）
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md`（対応節）
- Modify: `apps/cmux-team-dispatch-task/README.md`
- Modify: `apps/cmux-team-dispatch-task/CLAUDE.md`
- Test: `apps/cmux-team-dispatch-task/test/test-setup-skill.sh`

**Interfaces:**
- Consumes: Task 2 の `exec_choice` 値域、Task 5 の SKILL.md 記述
- Produces: 4 ファイル整合が取れた状態。Task 7 のリリースがこれを前提にする

- [ ] **Step 1: First-run setup の質問を engine 中立にする**

`SKILL.md:399-455` の custom ループのフィールド列挙を次で置き換える。

```markdown
   - **name** (free text, e.g. `ccenec`) — unique identifier
   - **command** (free text, e.g. `ccenec` or `codex` or `claude`) — what to invoke
   - **engine** (choice: `claude` / `codex`)
   - **plan_model** / **review_model** / **exec_model** (asked for **both engines**).
     For claude offer `opus[1m]` / `sonnet` / `fable` plus a free-text "Other"; for codex
     offer free text (e.g. `gpt-5.6-sol`). Leaving one blank keeps the default from the
     schema table: claude uses `opus[1m]` / `opus[1m]` / `sonnet`, codex defers to its
     own default. A codex runner still needs `review_model` to be review-capable.
   - **plan_effort / review_effort / exec_effort** (asked for **both engines**). Present
     four options built around the default so the call stays inside AskUserQuestion's
     limit:
     - claude plan / review: `default (xhigh)` / `max` / `high` / Other
     - claude exec: `default (high)` / `xhigh` / `max` / Other
     - codex plan / review: `default (xhigh)` / `high` / `medium` / Other
     - codex exec: `default (high)` / `xhigh` / `medium` / Other
```

Task 0 Step 2 で codex が `max` を受理すると確定した場合だけ、codex の選択肢にも
`max` を含める。

- [ ] **Step 2: `setup-mode.md` の `exec_choice` を更新する**

126 行を次で置き換える。

```markdown
- **which `exec_choice`** — `claude` / `codex`. Offer `codex` only when a runner with
  `engine: codex` is registered, and `claude` only when a claude runner is registered.
```

116 行の表の `exec_choice` 行の説明は `pick a fixed engine / "ask" / back to unset / leave unchanged`
へ更新する。

- [ ] **Step 3: `setup-mode-ja.md` を同期する**

上の 2 箇所に対応する日本語節を更新する。

- [ ] **Step 4: `README.md` を更新する**

次の 5 点を反映する。

1. runners.json スキーマ節: `plan_model` / `review_model` / `exec_model` と 3 つの effort が
   **engine を問わず有効**であること、および既定値表（claude model は plan/review `opus[1m]` /
   exec `sonnet`、codex model は既定なし、effort は両 engine 共通で plan/review `xhigh` /
   exec `high`）
2. effort の allowlist が engine 別（claude `low|medium|high|xhigh|max` /
   codex `minimal|low|medium|high|xhigh`）であること
3. `exec_choice` の値域が `claude` / `codex` / `ask` になり、旧値 `"opus 1m"` / `"sonnet"` は
   不正値として警告されること（移行なし。`--reset config` で作り直す）
4. Pre-warm 節: `executors` のキーが `claude` / `codex` になり、役割設定
   （engine + model + effort）が完全一致するときは `{}` になって実装ペインが起動しないこと
5. `README.md:366` の `prewarm.json.executors.opus` を `.executors.claude` へ

残存確認:

```bash
grep -n 'executors\.\(opus\|sonnet\)\|opus 1m' apps/cmux-team-dispatch-task/README.md
```

期待: 0 件。

- [ ] **Step 5: `CLAUDE.md` を更新する**

「role 解決の現行契約」節に次を反映する。

- `plan_model` / `review_model` / `exec_model` と 3 つの effort は **engine 中立**。
  既定は claude model が plan/review `opus[1m]` / exec `sonnet`、effort は両 engine 共通で
  plan/review `xhigh` / exec `high`
- `exec_choice` は `claude` / `codex` / `ask` の engine 選択。旧値 `"opus 1m"` / `"sonnet"` は不正値
- `prewarm.json` の `executors` キーは `claude` / `codex`。役割設定 (engine + model + effort) が
  完全一致するときは `{}` になり、設計セッションが in-session で実装する
- reviewer は `DESIGN_ENGINE == EXEC_ENGINE` なら専用 review ペイン、異なれば設計セッション
  （`REVIEW_POLICY=legacy` のときのみ適用）

「テスト方法」節の項目 18 / 19 / 26 / 38 を新仕様へ更新し、
回帰テストとして `bash test/test-role-models.sh` と `bash test/test-in-session.sh` を
追記する。

- [ ] **Step 6: `test-setup-skill.sh` を更新して流す**

`exec_choice` の選択肢を検査している箇所があれば新しい値域へ書き換える。

```bash
cd apps/cmux-team-dispatch-task && bash test/test-setup-skill.sh
```

期待: `--- all tests passed ---`。

- [ ] **Step 7: 言語ルールを検証する**

```bash
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins && pnpm check:doc-lang
```

期待: `check-doc-lang: OK`。

- [ ] **Step 8: commit**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md \
        apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/ \
        apps/cmux-team-dispatch-task/README.md \
        apps/cmux-team-dispatch-task/CLAUDE.md \
        apps/cmux-team-dispatch-task/test/test-setup-skill.sh
git commit -m "docs(cmux-team-dispatch-task): setup と 4 ファイルを新しい役割解決へ同期する"
```

---

### Task 7: 全テスト・リリース・push

**Files:**
- Modify: `apps/cmux-team-dispatch-task/.claude-plugin/plugin.json`
- Modify: `apps/cmux-team-dispatch-task/.codex-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`

**Interfaces:**
- Consumes: Task 1〜6 の全成果
- Produces: `main` に載った v1.20.0

- [ ] **Step 1: プラグインの全テストを流す**

```bash
cd apps/cmux-team-dispatch-task
for t in test/*.sh; do
  printf '%-48s ' "$t"
  if out=$(bash "$t" 2>&1); then echo OK; else echo FAILED; echo "$out" | grep -E '^FAIL|^Error' | head -5; fi
done
```

期待: 全 27 本が OK。`test-send-prompt.sh` と `test-runner-terminal-status.sh` は
数分かかるので待つこと。

- [ ] **Step 2: リポジトリ汚染が無いことを確認する**

```bash
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins
git worktree list
git branch --list 'feat/is*' --list 'feat/pg*' --list 'feat/rm*'
```

期待: worktree はリポジトリ本体のみ。テスト由来のブランチが 0 件。
残っていれば `git worktree prune` と `git branch -D` で掃除し、
該当テストの `mkdir -p` 漏れを直す。

- [ ] **Step 3: リポジトリ全体の check を流す**

```bash
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins && pnpm check
```

期待: `Tasks: 2 successful` と `check-doc-lang: OK`。
（token-meter の warning 4 件は既存で本変更と無関係）

- [ ] **Step 4: バージョンを 1.20.0 に上げる**

破壊的変更を含むため patch ではなく minor を上げる。

```bash
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins
for f in apps/cmux-team-dispatch-task/.claude-plugin/plugin.json \
         apps/cmux-team-dispatch-task/.codex-plugin/plugin.json; do
  tmp=$(mktemp) && jq '.version = "1.20.0"' "$f" > "$tmp" && mv "$tmp" "$f"
done
tmp=$(mktemp) && jq '(.plugins[] | select(.name=="cmux-team-dispatch-task") | .version) = "1.20.0"' \
  .claude-plugin/marketplace.json > "$tmp" && mv "$tmp" .claude-plugin/marketplace.json
jq -r '.version' apps/cmux-team-dispatch-task/.claude-plugin/plugin.json \
                 apps/cmux-team-dispatch-task/.codex-plugin/plugin.json
jq -r '.plugins[] | select(.name=="cmux-team-dispatch-task") | .version' .claude-plugin/marketplace.json
```

期待: 3 行とも `1.20.0`。

- [ ] **Step 5: Codex cachebuster を適用する**

```bash
cd /Users/yui/.codex/skills/.system/plugin-creator
python3 scripts/update_plugin_cachebuster.py \
  /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins/apps/cmux-team-dispatch-task
jq -r '.version' /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins/apps/cmux-team-dispatch-task/.codex-plugin/plugin.json
```

期待: `1.20.0+codex.<timestamp>` が 1 つだけ付く。

- [ ] **Step 6: commit**

```bash
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins
git add .claude-plugin/marketplace.json \
        apps/cmux-team-dispatch-task/.claude-plugin/plugin.json \
        apps/cmux-team-dispatch-task/.codex-plugin/plugin.json
git commit -m "release(cmux-team-dispatch-task): v1.20.0"
```

- [ ] **Step 7: main へマージして push する**

```bash
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins
git switch main
git merge --no-ff feat/role-model-effort -m "Merge branch 'feat/role-model-effort'"
git push origin main
git log --oneline -1 origin/main
```

- [ ] **Step 8: ローカルへ再インストールして手動確認する**

```bash
claude plugin marketplace update yui-cc-plugins
```

そのうえで `config.json` の `exec_choice` に旧値 `"sonnet"` を書いた状態で
ディスパッチを 1 件流し、`[warn] exec_choice="sonnet" ... invalid (expected: claude | codex | ask)`
が出て `ask` にフォールバックすること、prewarm のペインが
design / review / claude 実装 / codex 実装の 4 枚（2×2）になることを確認する。
確認後は `--reset config` で掃除する。

---

## 完了条件

- `test/test-role-models.sh` と `test/test-in-session.sh` を含むプラグインの全テストが通る
- `pnpm check` と `pnpm check:doc-lang` が通る
- claude runner の `plan_model` / `review_model` / `exec_model` と 3 つの effort が
  実際の起動コマンドへ反映される
- `exec_choice` が `claude` / `codex` / `ask` のみを受け付ける
- 役割設定が完全一致したとき実装ペインが起動されない
- SKILL.md / guide-ja.md / README.md / CLAUDE.md の 4 ファイルが一致している
- `main` に v1.20.0 が載っている
