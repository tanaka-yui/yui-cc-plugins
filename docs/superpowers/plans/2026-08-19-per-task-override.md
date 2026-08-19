# タスク個別の一時上書き 実装プラン

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 1 回の dispatch に限って、タスク単位で design / review / exec の runner / model / effort を対話的に上書きできるようにする。

**Architecture:** 上書きは親セッションのメモリ上の解決値を置き換えるだけで、config には書き戻さない。下流へは `prewarm-panes.sh` の新しい役割別 model / effort フラグ経由で明示的に渡り、`launch-workspace.sh` の既存の優先度（明示 > runner の役割フィールド > 既定値）の第 1 段に乗る。

**Tech Stack:** bash 3.2 互換シェルスクリプト、`jq`、cmux CLI、AskUserQuestion（SKILL.md 内の指示文）

**Spec:** `docs/superpowers/specs/2026-08-19-per-task-override-design.md`

## Global Constraints

- 対象は `apps/cmux-team-dispatch-task` のみ
- **bash 3.2 互換**（macOS 標準）。`set -u` 下で空になりうる配列は `${arr[@]+"${arr[@]}"}` で展開する
- 上書き対象は **runner / model / effort の 3 次元 × design / review / exec の 3 役割**だけ。`review_mode` / `prewarm` / 統合戦略 / brainstorming モードは対象外
- **`--override` は config への書き込み経路を持たない**。`config-edit.sh` を呼ばない
- precedence: `--override` > プロジェクト config > グローバル config > `runners.json` の役割フィールド > 組み込み既定値
- 役割既定値: claude model は plan `opus[1m]` / review `opus[1m]` / exec `sonnet`、codex model は既定なし、effort は両 engine 共通で plan `xhigh` / review `xhigh` / exec `high`
- effort allowlist: claude `low|medium|high|xhigh|max` / codex `minimal|low|medium|high|xhigh`。**codex に `max` は提示しない**
- model 文字列は検証しない
- `--override` は `--loop` / `--setup` / `--reset` と排他
- **`SKILL.md` と `*-ja.md` 以外の `references/*.md` に日本語文字を書かない**。`pnpm check:doc-lang` で検証する
- `guide-ja.md` は `SKILL.md` と見出し 1:1。`setup-mode-ja.md` / `loop-mode-ja.md` も同様
- `SKILL.md` / `references/**/*.md` に `cmux send` / `cmux send-key` の直書きを入れない
- ドキュメント整合: `SKILL.md` / `guide-ja.md` / `README.md` / `CLAUDE.md` の 4 ファイルは同一 commit で同期する（Task 4）
- **テストは worktree ディレクトリを事前に `mkdir -p` する**。しないと `prewarm-panes.sh` の `git worktree add` が実リポジトリに対して走る
- 作業ブランチ: `feat/per-task-override`（main へ直接コミットしない）

---

### Task 0: 作業ブランチと AskUserQuestion の下調べ

**Files:**
- なし（調査と分岐作成のみ）

**Interfaces:**
- Produces: `MULTISELECT_OTHER_SUPPORTED`（真偽の事実）— Task 3 のタスク選択質問の設計が参照する

- [ ] **Step 1: 作業ブランチを切る**

```bash
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins
git switch -c feat/per-task-override
```

- [ ] **Step 2: AskUserQuestion の multiSelect で "Other" 自由入力が使えるか確認する**

spec の「実装時に検証する未確定事項 1」。ツール定義を読んで判断する。

```bash
grep -n 'multiSelect' ~/.claude/plugins/cache/claude-plugins-official/superpowers/6.3.0/skills/brainstorming/SKILL.md 2>/dev/null || true
```

判断材料はツールのスキーマ説明にある「Users will always be able to select "Other" to provide
custom text input」と「Use multiSelect: true to allow multiple answers」の 2 文である。
両立が明記されていれば **使える**とみなし、Task 3 は「先頭 3 件 + Other 自由入力」を採用する。
明記が無い、または相互排他と読める場合は **使えない**とみなし、Task 3 は代替案
「タスク選択を 4 件ずつのページに分け、各ページで multiSelect を繰り返す」を採用する。

- [ ] **Step 3: 判定結果をメモに残す**

Task 3 Step 4 がこの結果を参照する。どちらを採ったかを実装時のコメントにも残すこと。

---

### Task 1: `prewarm-panes.sh` に役割別の model / effort 上書きフラグを追加する

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh`
- Test: `apps/cmux-team-dispatch-task/test/test-override.sh`（新規）

**Interfaces:**
- Consumes: なし（`launch-workspace.sh` の既存の `--model` / `--effort` 優先度に乗るだけ）
- Produces: `prewarm-panes.sh` が `--design-model` / `--design-effort` / `--reviewer-model` /
  `--reviewer-effort` / `--exec-model` / `--exec-effort` を受け取り、該当ペインの
  `launch-workspace.sh` 呼び出しへ `--model` / `--effort` として転送する。
  Task 3 の SKILL.md がこれらのフラグ名に依存する

- [ ] **Step 1: 失敗するテストを書く**

`apps/cmux-team-dispatch-task/test/test-override.sh` を新規作成する。

```bash
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
mkdir -p "$TMP/repo-ov5"
if ARGV_LOG="$TMP/argv-ov5.log" AGMSG_DIR="$TMP/agmsg" RUNNERS_CONFIG_PATH="$TMP/runners.json" \
   bash "$TMP/scripts/prewarm-panes.sh" --with-design --agmsg-team demo-team \
     --cwd "$TMP/repo-ov5" --slug ov5 --status-dir "$TMP/status-ov5" \
     --codex-runner codex --review-model gpt-5.6-sol --reviewer-model gpt-5.6-sol \
     >/dev/null 2>&1; then
  bad 'OV5 --reviewer-model with --review-model must be rejected'
else
  pass 'OV5 --reviewer-model with --review-model is rejected'
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

[[ $fail -eq 0 ]] && echo '--- all tests passed ---' || echo '--- failures ---'
exit "$fail"
```

- [ ] **Step 2: テストが落ちることを確認する**

```bash
cd apps/cmux-team-dispatch-task && bash test/test-override.sh
```

期待: OV1〜OV6 が FAIL（`--design-model` などが未知オプションで `prewarm-panes.sh` が die する）。
OV7 / OV9 は `launch-workspace.sh` の既存挙動なので PASS するはず。exit code 1。

- [ ] **Step 3: 変数宣言と引数解析を追加する**

`prewarm-panes.sh` の変数宣言部（`EXEC_ENGINE=""` の直後）へ追加する。

```bash
DESIGN_MODEL_OVERRIDE=""
DESIGN_EFFORT_OVERRIDE=""
REVIEWER_MODEL_OVERRIDE=""
REVIEWER_EFFORT_OVERRIDE=""
EXEC_MODEL_OVERRIDE=""
EXEC_EFFORT_OVERRIDE=""
```

引数解析の `--exec-choice)` ケースの直後へ追加する。

```bash
    # 役割別の一時上書き (--override 経由)。指定時は launch-workspace.sh の
    # 役割フォールバックより優先される明示値として該当ペインへ転送する
    --design-model)
      [[ $# -lt 2 ]] && die "--design-model requires a model name"
      DESIGN_MODEL_OVERRIDE="$2"; shift 2 ;;
    --design-effort)
      [[ $# -lt 2 ]] && die "--design-effort requires an effort level"
      DESIGN_EFFORT_OVERRIDE="$2"; shift 2 ;;
    --reviewer-model)
      [[ $# -lt 2 ]] && die "--reviewer-model requires a model name"
      REVIEWER_MODEL_OVERRIDE="$2"; shift 2 ;;
    --reviewer-effort)
      [[ $# -lt 2 ]] && die "--reviewer-effort requires an effort level"
      REVIEWER_EFFORT_OVERRIDE="$2"; shift 2 ;;
    --exec-model)
      [[ $# -lt 2 ]] && die "--exec-model requires a model name"
      EXEC_MODEL_OVERRIDE="$2"; shift 2 ;;
    --exec-effort)
      [[ $# -lt 2 ]] && die "--exec-effort requires an effort level"
      EXEC_EFFORT_OVERRIDE="$2"; shift 2 ;;
```

- [ ] **Step 4: legacy `--review-model` との排他検証を追加する**

`if [[ -n "$REVIEW_MODEL" && -z "$CODEX_RUNNER" ]]` のブロックの直後へ追加する。

```bash
# --reviewer-model は --reviewer-runner 経路の上書き、--review-model は claude 設計の
# legacy 指定。両方渡すのは意図の取り違えなので受け付けない。
if [[ -n "$REVIEWER_MODEL_OVERRIDE" && -n "$REVIEW_MODEL" ]]; then
  die "--reviewer-model and --review-model are mutually exclusive"
fi
```

- [ ] **Step 5: 転送用のフラグ配列を組み立てる**

`resolve_role_effort` 関数定義の直後（`START_CLAUDE=0` の直前）へ追加する。

```bash
# 役割別上書きを launch-workspace.sh の --model / --effort へ転送する配列。
# 空になりうるので展開は必ず ${arr[@]+"${arr[@]}"} を使う。
DESIGN_OVERRIDE_FLAGS=()
[[ -n "$DESIGN_MODEL_OVERRIDE" ]] && DESIGN_OVERRIDE_FLAGS+=(--model "$DESIGN_MODEL_OVERRIDE")
[[ -n "$DESIGN_EFFORT_OVERRIDE" ]] && DESIGN_OVERRIDE_FLAGS+=(--effort "$DESIGN_EFFORT_OVERRIDE")

EXEC_OVERRIDE_FLAGS=()
[[ -n "$EXEC_MODEL_OVERRIDE" ]] && EXEC_OVERRIDE_FLAGS+=(--model "$EXEC_MODEL_OVERRIDE")
[[ -n "$EXEC_EFFORT_OVERRIDE" ]] && EXEC_OVERRIDE_FLAGS+=(--effort "$EXEC_EFFORT_OVERRIDE")

REVIEW_OVERRIDE_FLAGS=()
[[ -n "$REVIEWER_MODEL_OVERRIDE" ]] && REVIEW_OVERRIDE_FLAGS+=(--model "$REVIEWER_MODEL_OVERRIDE")
[[ -n "$REVIEWER_EFFORT_OVERRIDE" ]] && REVIEW_OVERRIDE_FLAGS+=(--effort "$REVIEWER_EFFORT_OVERRIDE")
```

- [ ] **Step 6: in-session 判定に上書きを反映する**

in-session ブロックの 4 つの `_RESOLVED` 代入を次で置き換える。

```bash
    # 上書きがあればそれが解決値。無ければ runners.json + 既定値から解く。
    PLAN_MODEL_RESOLVED="${DESIGN_MODEL_OVERRIDE:-$(resolve_role_model "$DESIGN_RUNNER" plan "$DESIGN_ENGINE")}"
    PLAN_EFFORT_RESOLVED="${DESIGN_EFFORT_OVERRIDE:-$(resolve_role_effort "$DESIGN_RUNNER" plan)}"
    EXEC_MODEL_RESOLVED="${EXEC_MODEL_OVERRIDE:-$(resolve_role_model "$EXEC_ROLE_RUNNER" exec "$EXEC_ROLE_ENGINE")}"
    EXEC_EFFORT_RESOLVED="${EXEC_EFFORT_OVERRIDE:-$(resolve_role_effort "$EXEC_ROLE_RUNNER" exec)}"
```

- [ ] **Step 7: 4 つの launch 呼び出しへ転送する**

design の **codex 分岐**（`--runner "$DESIGN_RUNNER"` を渡している方）へ、`--runner` 行の直後に挿入する。

```bash
      ${DESIGN_OVERRIDE_FLAGS[@]+"${DESIGN_OVERRIDE_FLAGS[@]}"} \
```

design の **claude 分岐**へ、`${DESIGN_RUNNER_FLAGS[@]+...}` 行の直後に同じ行を挿入する。

claude 実装ペインの `CLAUDE_ARGS` 配列へ、`--status-dir "$STATUS_DIR"` の直後に追加する。

```bash
    ${EXEC_OVERRIDE_FLAGS[@]+"${EXEC_OVERRIDE_FLAGS[@]}"}
```

codex 実装ペインの launch 呼び出しへ、`--runner "$CODEX_EXEC_RUNNER"` 行の直後に挿入する。

```bash
    ${EXEC_OVERRIDE_FLAGS[@]+"${EXEC_OVERRIDE_FLAGS[@]}"} \
```

review ペインの launch 呼び出しへ、`"${REVIEW_RUNNER_FLAGS[@]}"` 行の直後に挿入する。

```bash
    ${REVIEW_OVERRIDE_FLAGS[@]+"${REVIEW_OVERRIDE_FLAGS[@]}"} \
```

- [ ] **Step 8: Usage コメントを更新する**

ヘッダーの Usage 2 ブロック両方に、`[--exec-runner <name>] [--exec-choice <choice>]` の
次の行として追加する。

```bash
#       [--design-model <m>] [--design-effort <e>] \
#       [--reviewer-model <m>] [--reviewer-effort <e>] \
#       [--exec-model <m>] [--exec-effort <e>] \
```

あわせて「内部処理」の一覧へ 1 行足す。

```bash
#   0. 役割別の model/effort 上書き (--override 由来) を該当ペインへ --model / --effort で転送
```

- [ ] **Step 9: テストが通ることを確認する**

```bash
cd apps/cmux-team-dispatch-task && bash test/test-override.sh
```

期待: `--- all tests passed ---`、exit 0。

- [ ] **Step 10: 既存の prewarm スイートが壊れていないことを確認する**

```bash
cd apps/cmux-team-dispatch-task
bash test/test-prewarm-layout.sh && bash test/test-prewarm-all-codex.sh \
  && bash test/test-prewarm-unattended.sh && bash test/test-in-session.sh \
  && bash test/test-role-models.sh
```

期待: 5 本とも `--- all tests passed ---`。続けて汚染確認。

```bash
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins
git worktree list && git branch --list 'feat/ov*' 'feat/is*' 'feat/pg*'
```

期待: worktree はリポジトリ本体のみ、テスト由来ブランチ 0 件。

- [ ] **Step 11: commit**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh \
        apps/cmux-team-dispatch-task/test/test-override.sh
git commit -m "feat(cmux-team-dispatch-task): 役割別 model / effort の上書きフラグを追加する"
```

---

### Task 2: `REVIEW_EFFORT` を導入する

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md:303-304`（fixed policy の解決）
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md:312`（legacy policy の解決）
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md:559`（review 入力の列挙）
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md:1187-1188,1211-1213`（substitution tuple）
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md`（対応節）

**Interfaces:**
- Consumes: なし
- Produces: 親が `REVIEW_EFFORT` を解決し `{{REVIEW_EFFORT}}` として子プロンプトへ渡す。
  Task 3 の `--override` フローがこの変数を上書き対象にする

- [ ] **Step 1: fixed policy の解決へ `REVIEW_EFFORT` を足す**

`SKILL.md:303-304` を次で置き換える。

```markdown
   - fixed runner name → `REVIEW_POLICY=fixed`; resolve `REVIEW_RUNNER`,
     `REVIEW_ENGINE`, `REVIEW_MODEL`, `REVIEW_EFFORT`, and
     `REVIEW_PANE_AGENT=<task-slug>-review` from that runner. `REVIEW_EFFORT` is the
     runner's `review_effort`, defaulting to `xhigh` on both engines. The one dedicated
     review pane handles both Phase A-R and Phase B-R.
```

- [ ] **Step 2: legacy policy の解決へ `REVIEW_EFFORT` を足す**

`SKILL.md:312` の `Store that resolver's result in the same ...` の文を次で置き換える。

```markdown
     result in the same `REVIEW_RUNNER` / `REVIEW_ENGINE` / `REVIEW_MODEL` /
     `REVIEW_EFFORT` variables and
```

- [ ] **Step 3: review 入力の列挙を 4 変数へ改める**

`SKILL.md:559` を含む文を次で置き換える。

```markdown
Resolve the independent review role from Step 1f first; `REVIEW_POLICY`,
`REVIEW_RUNNER`, `REVIEW_ENGINE`, `REVIEW_MODEL`, and `REVIEW_EFFORT` are the only
review inputs used below. A fixed policy never substitutes a different runner based on
the design or implementation engine.
```

- [ ] **Step 4: substitution tuple へ `REVIEW_EFFORT` を足す**

`SKILL.md:1187-1188` の tuple 列挙を次で置き換える。

```markdown
  `DESIGN_RUNNER` / `DESIGN_ENGINE` / `PLAN_MODEL` / `PLAN_EFFORT`, `REVIEW_POLICY` /
  `REVIEW_RUNNER` / `REVIEW_ENGINE` / `REVIEW_MODEL` / `REVIEW_EFFORT` /
  `REVIEW_PANE_AGENT`, and
```

`SKILL.md:1211-1213` の placeholder 列挙を次で置き換える。

```markdown
- `{{REVIEW_POLICY}}`, `{{REVIEW_RUNNER}}`, `{{REVIEW_ENGINE}}`,
  `{{REVIEW_MODEL}}`, `{{REVIEW_EFFORT}}`, `{{REVIEW_PANE_AGENT}}` → the resolved review
  tuple. Under both fixed
```

- [ ] **Step 5: `guide-ja.md` を同期する**

上の 4 箇所に対応する日本語節を更新する。見出しの 1:1 対応を崩さないこと。

- [ ] **Step 6: 言語ルールと配送ルールを検証する**

```bash
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins
node scripts/check-doc-lang.mjs apps/cmux-team-dispatch-task
cd apps/cmux-team-dispatch-task && bash test/test-send-prompt-callsites.sh
```

期待: `check-doc-lang: OK` と CS1-CS3 PASS。

- [ ] **Step 7: commit**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md \
        apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md
git commit -m "feat(cmux-team-dispatch-task): review 役割に effort を追加する"
```

---

### Task 3: `--override` の CLI とフローを SKILL.md に定義する

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md:14`（`argument-hint`）
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md:117-121`（排他規則）
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md:797`（Step 1h の前に新設）
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md:1876-1910`（prewarm 呼び出しへフラグ追加）
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md`（対応節）

**Interfaces:**
- Consumes: Task 1 の 6 フラグ、Task 2 の `REVIEW_EFFORT`
- Produces: `--override` の完全な仕様。Task 4 の README / CLAUDE.md がこれと一致する

- [ ] **Step 1: `argument-hint` を更新する**

`SKILL.md:14` を次で置き換える。

```yaml
argument-hint: "<task1>, <task2>, ... [--loop] [--setup] [--reset [runners|config|all]] [--override]"
```

- [ ] **Step 2: 排他規則を追記する**

`SKILL.md:117-121` の段落の直後へ次を足す。

```markdown
## Override Mode (per-task temporary override)

`--override` takes no value. It makes this dispatch — and only this dispatch — ask, per
task, which of the design / review / exec roles should run on a different runner, model,
or effort than the resolved configuration says. **It never writes to either config file**;
there is no persistence path, by design.

`--override` is mutually exclusive with `--loop`, `--setup`, and `--reset`. The `--loop`
case is structural rather than a policy choice: an unattended issue loop has nobody to
answer the questions. If more than one is given, stop with an error naming both. Like
`--setup` and `--reset`, `--override` must never reach Step 1a's task parsing.
```

- [ ] **Step 3: 新しいステップ本体を書く**

`SKILL.md:797` の `### 1h. Display Summary and Proceed` の直前へ、次の節を挿入する。

````markdown
### 1g-2. Apply Per-Task Overrides (`--override` only)

Skip this entire step unless `--override` was given.

Every role is already resolved at this point, so each question can show the resolved
value as its "keep" option. Overriding replaces the in-memory resolved values only:
`DESIGN_RUNNER` / `DESIGN_ENGINE` / `PLAN_MODEL` / `PLAN_EFFORT`, `REVIEW_RUNNER` /
`REVIEW_ENGINE` / `REVIEW_MODEL` / `REVIEW_EFFORT`, and `EXEC_CHOICE` / `EXEC_RUNNER` /
`EXEC_ENGINE` / `EXEC_MODEL` / `EXEC_EFFORT`. Never call `config-edit.sh` here.

**Call 1 — which tasks.** One AskUserQuestion, `multiSelect: true`:

> Which tasks should use a one-off configuration for this dispatch?

Options are the task slugs. AskUserQuestion allows at most four options, so with more
than three tasks list the first three and let the rest arrive through the automatic
"Other" free-text field, where the user types task slugs separated by commas — the same
escape hatch `runners[]` uses when more than four runners are registered. Selecting
nothing leaves every task on its resolved configuration; skip to Step 1h.

**Call 2 — which roles, per selected task.** One AskUserQuestion per selected task,
`multiSelect: true`, three options: `design` / `review` / `exec`. `review` is offered
only when `REVIEW_ENABLED` is true for that task.

**Call 3.. — the dimensions, one call per selected role.** Three questions in one call:

| Question | Options (first is always the keep option) |
|---|---|
| runner | `keep (<resolved runner>)`, then up to three `runners[].name`; the rest via "Other" |
| model | `keep (<resolved model>)`, then `opus[1m]` / `sonnet` / `fable` for a claude engine, or the runner's role model for a codex engine; any other string via "Other" |
| effort | `keep (<resolved effort>)`, then `xhigh` / `max` / `high` for claude, or `xhigh` / `high` / `medium` for codex |

Never offer `max` for a codex engine — whether codex accepts it was never confirmed, so
the safe branch stands.

**Resolving a runner/model/effort disagreement.** The three questions are asked in one
call, so the options are built from the role's *currently resolved* engine and the
runner answer is not known yet. When the answers land, the runner answer decides:

- The chosen runner's `engine` becomes the role's engine. For exec, assign it to both
  `EXEC_ENGINE` and `EXEC_CHOICE`.
- If the chosen effort is not in the new engine's allowlist (claude
  `low|medium|high|xhigh|max`, codex `minimal|low|medium|high|xhigh`), warn and use that
  role's default effort for the new engine (`xhigh` for plan/review, `high` for exec).
- If the chosen model is one of the claude aliases `opus[1m]` / `sonnet` / `fable` and
  the new engine is codex, warn and drop the model override for that role, falling back
  to the normal `runners.json` → default resolution. Model strings are not validated, so
  decide this on the alias name alone.
- Never stop the dispatch for either case, and carry both warnings into the Step 1h
  override block.

**Passing the result downstream.** For each task with any override, add the matching
flags to that task's `prewarm-panes.sh` invocation (Step 2): `--design-model` /
`--design-effort` / `--reviewer-model` / `--reviewer-effort` / `--exec-model` /
`--exec-effort`. Pass only the dimensions actually overridden. A runner override changes
the existing `--design-runner` / `--reviewer-runner` / `--exec-runner` / `--exec-choice`
values rather than adding a flag. On the non-prewarm spawn path, pass the same values as
`--model` / `--effort` to `launch-workspace.sh`.
````

- [ ] **Step 4: タスク選択の逃がし方を Task 0 の結果に合わせる**

Task 0 Step 2 で multiSelect + "Other" が **使える**と判定した場合は Step 3 の文面をそのまま
残す。**使えない**と判定した場合は、Call 1 の段落を次で置き換える。

```markdown
**Call 1 — which tasks.** AskUserQuestion allows at most four options, so ask in pages of
four: one `multiSelect: true` call per page of task slugs, in order, until every task has
been offered. Selecting nothing on every page leaves each task on its resolved
configuration; skip to Step 1h.
```

- [ ] **Step 5: Step 1h に上書きブロックを追加する**

`### 1h. Display Summary and Proceed` の Template A 出力例の直後へ次を足す。

````markdown
When `--override` produced any change, print this block immediately after the Template A
table. Do not change the table itself. List only the dimensions that actually changed,
one line per task and role, and include any warning raised in Step 1g-2:

```
Overrides (this dispatch only):
  auth-api  exec    runner codex / model gpt-5.6-terra / effort xhigh
  auth-api  design  effort max
```

Print nothing when no override was applied.
````

- [ ] **Step 6: prewarm 呼び出し例へフラグを追加する**

`SKILL.md` の 2 つの `prewarm-panes.sh` 呼び出し例（agmsg 有り / 無し）へ、
`--exec-choice "$EXEC_CHOICE" \` の次の行として追加する。

```bash
  [--design-model "$DESIGN_MODEL"] [--design-effort "$DESIGN_EFFORT"] \
  [--reviewer-model "$REVIEW_MODEL"] [--reviewer-effort "$REVIEW_EFFORT"] \
  [--exec-model "$EXEC_MODEL"] [--exec-effort "$EXEC_EFFORT"] \
```

あわせて「Flag selection per task」の箇条書きへ 1 項目足す。

```markdown
- Pass a `--design-model` / `--design-effort` / `--reviewer-model` / `--reviewer-effort` /
  `--exec-model` / `--exec-effort` flag only for a dimension Step 1g-2 actually overrode.
  Without `--override` none of them is passed and the launcher's role fallback decides.
```

- [ ] **Step 7: spawn 経路へ `--effort` を追加する**

prewarm が無効なときの `launch-workspace.sh --mode execute` 呼び出しは `--model
"$EXEC_MODEL"` を渡しているが `--effort` を渡していない。上書きした effort が
prewarm 経路でしか効かないのを避けるため、`SKILL.md` 内の `--mode execute` 呼び出し
（Phase B の spawn フォールバック）へ `--effort "$EXEC_EFFORT"` を足す。

対象箇所は次で洗い出す。

```bash
cd apps/cmux-team-dispatch-task
grep -n 'mode execute' skills/cmux-team-dispatch-task/SKILL.md
```

ヒットした各呼び出しの `--model "$EXEC_MODEL"` の直後へ `--effort "$EXEC_EFFORT"` を
足す。`--model` を渡していない箇所があればそこは対象外（役割フォールバックに委ねる
設計のため）。

- [ ] **Step 8: Step 1f の既存分岐との責任分担を書く**

`### 1g-2. Apply Per-Task Overrides` 節の末尾へ次を足す。Step 1f の switch 質問
（「Yes (this time only) → for each task, ask which runner to use」）は残るので、
両者の関係を明記しないと同じことを二度聞かれたように見える。

```markdown
**Relationship to Step 1f's per-task runner question.** Step 1f's switch question stays
as it is. The two cover different ground:

| Path | Covers | Granularity |
|---|---|---|
| Step 1f switch question | the design runner only | per task |
| `--override` | runner / model / effort for design, review, and exec | per task |

`--override` runs later, so when both are used its answer wins. A design runner chosen in
Step 1f and then overridden here is not a conflict — the override is simply the last word.
```

- [ ] **Step 9: `guide-ja.md` を同期する**

Step 1〜8 に対応する日本語節を追加・更新する。見出しの 1:1 対応を保つこと
（`### 1g-2. Apply Per-Task Overrides` に対応する見出しを新設する）。

- [ ] **Step 10: 検証する**

```bash
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins
node scripts/check-doc-lang.mjs apps/cmux-team-dispatch-task
cd apps/cmux-team-dispatch-task && bash test/test-send-prompt-callsites.sh
grep -c 'override' skills/cmux-team-dispatch-task/SKILL.md
```

期待: `check-doc-lang: OK`、CS1-CS3 PASS、grep が 1 以上。

- [ ] **Step 11: commit**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md \
        apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md
git commit -m "feat(cmux-team-dispatch-task): --override のフローを定義する"
```

---

### Task 4: 残りのドキュメントと静的テスト

**Files:**
- Modify: `apps/cmux-team-dispatch-task/README.md`
- Modify: `apps/cmux-team-dispatch-task/CLAUDE.md`
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/setup-mode.md`
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/setup-mode-ja.md`
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/loop-mode.md`
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/loop-mode-ja.md`
- Test: `apps/cmux-team-dispatch-task/test/test-override.sh`（OV8 を追記）

**Interfaces:**
- Consumes: Task 1〜3 の全成果
- Produces: 4 ファイル整合が取れた状態。Task 5 のリリースがこれを前提にする

- [ ] **Step 1: OV8（静的検査）をテストへ追記する**

`test/test-override.sh` の最後の `[[ $fail -eq 0 ]]` 行の直前へ追加する。

```bash
# --- OV8: SKILL.md の CLI 記述 ---
SKILL="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/SKILL.md"
grep -Fq -- '[--override]' "$SKILL" \
  && pass 'OV8a argument-hint lists --override' \
  || bad 'OV8a argument-hint lists --override'
for other in '--loop' '--setup' '--reset'; do
  grep -F -- '--override' "$SKILL" | grep -Fq -- "$other" \
    && pass "OV8b --override exclusivity with $other is documented" \
    || bad "OV8b --override exclusivity with $other is documented"
done
grep -Fq -- '1g-2' "$SKILL" \
  && pass 'OV8c the override step is present' \
  || bad 'OV8c the override step is present'
```

- [ ] **Step 2: `README.md` を更新する**

`### 設定のリセット（`--reset`）` の節の直後へ次を足す。

````markdown
### タスク個別の一時上書き（`--override`）

```
/cmux-team-dispatch-task タスクA, タスクB --override
```

その dispatch に限って、タスクごとに design / review / exec の runner / model / effort を
上書きします。難しいタスクだけ effort を上げる、実装だけ別 engine に投げる、といった
使い方を想定しています。

タスク一覧を見てから対象タスクを選び、次に上書きする役割を選び、選んだ役割の
runner / model / effort を答える流れです。各質問の先頭は必ず「変更なし（現在: <解決値>）」
なので、変えたい次元だけ触れば済みます。

**config には一切書き戻しません。** 恒久的に変えたいときは `--setup` を使ってください。
無人実行の `--loop`、および `--setup` / `--reset` とは排他です（`--loop` は質問に答える人が
いないため）。

上書きした内容は起動前のサマリー表の直後に差分として表示されます。
````

`## 前提条件` の直前あたりにある `--setup` / `--reset` の排他を説明した段落へ
`--override` も加える。

- [ ] **Step 3: `CLAUDE.md` を更新する**

「ドキュメント整合の絶対ルール」の下の役割解決の契約節へ次を足す。

```markdown
- `--override` は dispatch 1 回限りのタスク別上書き。precedence は
  `--override` > project config > global config > `runners.json` の役割フィールド > 既定値。
  **config へ書き戻さない**（`config-edit.sh` を呼ばない）。`--loop` / `--setup` / `--reset`
  と排他で、Step 1a のタスク解析に落ちてはならない。上書きは Step 1g-2 で解決値
  （`PLAN_MODEL` / `PLAN_EFFORT` / `REVIEW_MODEL` / `REVIEW_EFFORT` / `EXEC_MODEL` /
  `EXEC_EFFORT` と各 runner / engine）を置き換え、`prewarm-panes.sh` へは
  `--design-model` / `--design-effort` / `--reviewer-model` / `--reviewer-effort` /
  `--exec-model` / `--exec-effort` で渡る
- `REVIEW_EFFORT` は review 役割の effort。runner の `review_effort` → 既定 `xhigh`。
  substitution tuple の `{{REVIEW_EFFORT}}` として子へ渡る
```

「メンテナンス手順」へ項目を 1 つ足す。

```markdown
44. **`--override`**が SKILL.md / guide-ja.md / README.md / CLAUDE.md で一致しているか確認:
    - `argument-hint` に `--override` があり、`--loop` / `--setup` / `--reset` との排他が
      4 ファイルすべてで同じ理由（`--loop` は無人実行で対話できない）とともに書かれていること
    - config への書き込み経路を持たないこと。`--override` の説明のどこにも
      `config-edit.sh` が現れないこと
    - `prewarm-panes.sh` の 6 フラグ名が SKILL.md の記述と一致すること
    - 回帰は `bash test/test-override.sh`（OV1-OV9）で検証する
```

「テスト方法」の E2E 節へ項目を 1 つ足す。

```markdown
45. **`--override`**: タスク一覧 → 対象タスク → 役割 → runner/model/effort の順に質問が出て、
    各質問の先頭が「変更なし（現在: <解決値>）」であること。上書きした内容がサマリー表の
    直後にブロックとして表示されること。dispatch 後に両 `config.json` が変化していないこと。
    `--override --loop` が排他エラーになること
```

- [ ] **Step 4: `setup-mode.md` / `setup-mode-ja.md` を更新する**

`--setup` の排他を説明している箇所（`setup-mode.md:74` 付近）へ `--override` を加える。

```markdown
`--setup` is mutually exclusive with `--loop`, `--reset`, and `--override`. If more than
one is
```

`setup-mode-ja.md` の対応箇所も同様に更新する。あわせて「恒久化したいなら `--setup`、
その回限りなら `--override`」という 1 文を両ファイルへ足す。

- [ ] **Step 5: `loop-mode.md` / `loop-mode-ja.md` を更新する**

まず該当箇所を洗い出す。

```bash
cd apps/cmux-team-dispatch-task
grep -n -- '--setup\|--reset\|mutually exclusive\|排他' \
  skills/cmux-team-dispatch-task/references/loop-mode.md \
  skills/cmux-team-dispatch-task/references/loop-mode-ja.md
```

`loop-mode.md` の該当段落へ次の一文を足す（英語ファイルなので日本語を書かない）。

```markdown
`--loop` is also mutually exclusive with `--override`. This one is structural rather than
policy: `--override` asks a question per task, and an unattended issue loop has nobody to
answer it. A loop run therefore always uses the resolved configuration as-is.
```

`loop-mode-ja.md` の対応段落へ同じ内容の日本語を足す。

```markdown
`--loop` は `--override` とも排他である。これは方針ではなく構造上の制約で、
`--override` はタスクごとに質問を出すのに対し、無人の issue ループには答える人がいない。
ループ実行は常に解決済みの設定をそのまま使う。
```

- [ ] **Step 6: 検証する**

```bash
cd apps/cmux-team-dispatch-task
bash test/test-override.sh
bash test/test-setup-skill.sh
bash test/test-loop-skill.sh
bash test/test-send-prompt-callsites.sh
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins
pnpm check:doc-lang
```

期待: 4 スイートとも PASS、`check-doc-lang: OK`。

- [ ] **Step 7: commit**

```bash
git add apps/cmux-team-dispatch-task/README.md \
        apps/cmux-team-dispatch-task/CLAUDE.md \
        apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/ \
        apps/cmux-team-dispatch-task/test/test-override.sh
git commit -m "docs(cmux-team-dispatch-task): --override を 4 ファイルへ同期する"
```

---

### Task 5: 全テスト・バージョン・リリースコミット

**Files:**
- Modify: `apps/cmux-team-dispatch-task/.claude-plugin/plugin.json`
- Modify: `apps/cmux-team-dispatch-task/.codex-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`

**Interfaces:**
- Consumes: Task 1〜4 の全成果
- Produces: `feat/per-task-override` 上の v1.21.0

- [ ] **Step 1: プラグインの全テストを流す**

```bash
cd apps/cmux-team-dispatch-task
pass=0; fail=0
for t in test/*.sh; do
  if out=$(bash "$t" 2>&1); then pass=$((pass+1)); else fail=$((fail+1)); echo "FAILED: $t"; echo "$out" | grep -E '^FAIL|^Error' | head -3; fi
done
echo "passed=$pass failed=$fail"
```

期待: `passed=28 failed=0`（既存 27 本 + 新規 `test-override.sh`）。
`test-send-prompt.sh` と `test-runner-terminal-status.sh` は数分かかるので待つこと。
**1 本でも FAILED ならバージョンを上げずに停止して報告する。**

- [ ] **Step 2: リポジトリ汚染が無いことを確認する**

```bash
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins
git worktree list
git branch --list 'feat/ov*' 'feat/is*' 'feat/pg*' 'feat/rm*' 'feat/demo*'
```

期待: worktree はリポジトリ本体のみ、テスト由来ブランチ 0 件。残っていれば
`git worktree prune` と `git branch -D` で掃除し、原因のテストを直す。

- [ ] **Step 3: リポジトリ全体の check を流す**

```bash
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins && pnpm check
```

期待: `check-doc-lang: OK`。`@tanaka-yui/token-meter` の `noNonNullAssertion` 警告 4 件は
既存で本変更と無関係。

- [ ] **Step 4: バージョンを 1.21.0 に上げる**

新機能追加なので minor を上げる。

```bash
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins
for f in apps/cmux-team-dispatch-task/.claude-plugin/plugin.json \
         apps/cmux-team-dispatch-task/.codex-plugin/plugin.json; do
  tmp=$(mktemp) && jq '.version = "1.21.0"' "$f" > "$tmp" && mv "$tmp" "$f"
done
tmp=$(mktemp) && jq '(.plugins[] | select(.name=="cmux-team-dispatch-task") | .version) = "1.21.0"' \
  .claude-plugin/marketplace.json > "$tmp" && mv "$tmp" .claude-plugin/marketplace.json
jq -r '.version' apps/cmux-team-dispatch-task/.claude-plugin/plugin.json \
                 apps/cmux-team-dispatch-task/.codex-plugin/plugin.json
jq -r '.plugins[] | select(.name=="cmux-team-dispatch-task") | .version' .claude-plugin/marketplace.json
```

期待: 3 行とも `1.21.0`。

- [ ] **Step 5: Codex cachebuster を適用する**

```bash
cd /Users/yui/.codex/skills/.system/plugin-creator
python3 scripts/update_plugin_cachebuster.py \
  /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins/apps/cmux-team-dispatch-task
jq -r '.version' /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins/apps/cmux-team-dispatch-task/.codex-plugin/plugin.json
```

期待: `1.21.0+codex.<timestamp>` が 1 つだけ付く。

- [ ] **Step 6: commit**

```bash
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins
git add .claude-plugin/marketplace.json \
        apps/cmux-team-dispatch-task/.claude-plugin/plugin.json \
        apps/cmux-team-dispatch-task/.codex-plugin/plugin.json
git commit -m "release(cmux-team-dispatch-task): v1.21.0"
```

- [ ] **Step 7: main へのマージと push は行わない**

このプランは `feat/per-task-override` 上でリリースコミットまでを作る。`main` への
マージ、`origin/main` への push、`claude plugin marketplace update` は不可逆な共有
ブランチ操作なので、最終レビュー後に利用者へ確認してから行う。

---

## 完了条件

- `test/test-override.sh`（OV1-OV9）を含むプラグインの全 28 スイートが通る
- `pnpm check` と `pnpm check:doc-lang` が通る
- `prewarm-panes.sh` が 6 つの上書きフラグを該当ペインへ `--model` / `--effort` として転送する
- 上書きが in-session 判定に反映される
- `REVIEW_EFFORT` が親で解決され `{{REVIEW_EFFORT}}` として子へ渡る
- `--override` が `--loop` / `--setup` / `--reset` と排他で、config へ書き戻さない
- SKILL.md / guide-ja.md / README.md / CLAUDE.md の 4 ファイルが一致している
- `feat/per-task-override` に v1.21.0 のリリースコミットがある
