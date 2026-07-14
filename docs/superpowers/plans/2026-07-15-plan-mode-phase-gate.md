# plan モード Phase A-R / Phase B 遵守ゲート 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `--mode plan` の子セッションが ExitPlanMode 承認後に Phase A-R（codex レビュー）と Phase B（実行モデル選択）をスキップして実装に突入する問題を、プロンプト再構成 + ExitPlanMode hook の機械的注入で防ぐ。

**Architecture:** 対策 A（SKILL.md の MANDATORY MODEL SELECTION SEQUENCE テンプレートに plan モード専用指示を追加し、plan 自体の冒頭ステップに Phase A-R / B を組み込ませる）+ 対策 B（`launch-workspace.sh` が plan モード + claude engine のとき worktree の `.claude/settings.local.json` に PostToolUse hook を注入し、承認直後に指示を再注入する）。スペック: `docs/superpowers/specs/2026-07-15-plan-mode-phase-gate-design.md`

**Tech Stack:** bash/zsh（launch-workspace.sh, hook スクリプト）、jq（settings.local.json のマージ）、markdown（SKILL.md / guide-ja.md / README.md / CLAUDE.md）

## Global Constraints

- **4 ファイル同時整合**: MANDATORY MODEL SELECTION SEQUENCE の改変は `SKILL.md` / `references/guide-ja.md` / `README.md` / `CLAUDE.md` を**同一コミット**で更新する（整合が崩れた状態でのコミット禁止 — `apps/cmux-team-dispatch-task/CLAUDE.md` の絶対ルール）
- **言語**: ドキュメント・コメント・コミットメッセージは日本語、コード（変数名・関数名・フラグ）は英語
- **hook はベストエフォート**: settings 書き込み・マージ失敗は警告ログのみで dispatch を止めない（Phase A-R spawn 失敗時と同じ思想）
- **スコープ**: `MODE == "plan"` かつ `RUNNER_ENGINE == "claude"` のみ。superpowers / execute / standby / review モード、codex engine には注入しない。claude-teams レイアウトも除外（子プロンプトに MANDATORY MODEL SELECTION SEQUENCE が無いため）
- **バージョン**: `apps/cmux-team-dispatch-task/.claude-plugin/plugin.json` を 1.5.2 → **1.6.0**、ルート `.claude-plugin/marketplace.json` の同項目も同期
- 作業ディレクトリ: リポジトリルート `/Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins`（以下、パスはすべてリポジトリルート相対）

---

### Task 1: plan-approved-hook.sh の新規作成

**Files:**

- Create: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/plan-approved-hook.sh`

**Interfaces:**

- Consumes: なし（stdin の hook 入力 JSON は読み捨てる。引数なし）
- Produces: stdout に PostToolUse hook の JSON（`hookSpecificOutput.additionalContext`）を出力する。Task 2 の settings.local.json が `zsh <abs-path>/plan-approved-hook.sh` として参照する

- [ ] **Step 1: スクリプトを作成する**

`apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/plan-approved-hook.sh` を以下の内容で作成:

```zsh
#!/usr/bin/env zsh
# ExitPlanMode PostToolUse hook — plan モード子セッション専用。
#
# 標準 plan モードでは ExitPlanMode 承認直後に「プランを実行せよ」という強い
# システム指示が recency 優先で入り、プロンプト焼き込みの MANDATORY MODEL
# SELECTION SEQUENCE (Phase A-R / Phase B) がスキップされることがある。
# この hook は承認直後のタイミングで additionalContext を注入し、
# ファイル編集前に Phase A-R (有効時) → Phase B を強制的に再想起させる。
#
# launch-workspace.sh が --mode plan + claude engine のときのみ、worktree の
# .claude/settings.local.json にこのスクリプトを登録する。
# stdin の hook 入力 JSON は使用しないため読み捨てる。

cat <<'EOF'
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "[cmux-team-dispatch-task] The plan was just approved. STOP — do NOT edit any files yet. First: (1) save the plan to a file if not saved, (2) re-read the MANDATORY MODEL SELECTION SEQUENCE in .cmux-team-dispatch-task-prompt.md and execute Phase A-R (if the REVIEW block is present) then Phase B (model selection via AskUserQuestion) NOW."
  }
}
EOF
```

メッセージは**汎用**（REVIEW_ENABLED の状態を焼き込まない）。有効/無効の分岐は prompt.md 側の `{{REVIEW_BLOCK}}` 有無が担う。

- [ ] **Step 2: 実行権限を付与する**

```bash
chmod +x apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/plan-approved-hook.sh
```

- [ ] **Step 3: 出力の JSON 妥当性を検証する**

```bash
zsh apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/plan-approved-hook.sh | jq -e '.hookSpecificOutput.additionalContext | length > 0'
```

Expected: `true` と出力され exit code 0（JSON が不正なら jq がエラーになる）

- [ ] **Step 4: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/plan-approved-hook.sh
git commit -m "feat(cmux-team-dispatch-task): ExitPlanMode PostToolUse hook スクリプトを追加

plan モード子セッションで承認直後に Phase A-R / Phase B の遵守指示を
additionalContext として再注入するための hook 本体。"
```

---

### Task 2: launch-workspace.sh に hook 注入ブロックを追加

**Files:**

- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh:373-375`（Step 2 プロンプト書き込みの直後、`# --- Step 3: Build runner command ---` コメントの直前に挿入）

**Interfaces:**

- Consumes: Task 1 の `plan-approved-hook.sh`（`$SCRIPT_DIR/plan-approved-hook.sh` で参照。`SCRIPT_DIR` はスクリプト冒頭 72 行目で定義済み）。既存変数 `MODE` / `RUNNER_ENGINE` / `CWD` / `log()`
- Produces: `$CWD/.claude/settings.local.json`（PostToolUse hook 設定）と repo 共有 `info/exclude` への追記。後続タスクからの依存なし

- [ ] **Step 1: 挿入ポイントを確認する**

```bash
grep -n -A1 'log "prompt" "wrote prompt to \$PROMPT_FILE"' apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh
```

Expected: 372 行目付近に `log "prompt" ...`、その次に `fi`、少し下に `# --- Step 3: Build runner command ---` があること

- [ ] **Step 2: hook 注入ブロックを挿入する**

`launch-workspace.sh` の以下の既存テキスト:

```bash
  FULL_PROMPT="$PROMPT"
  printf '%s\n' "$FULL_PROMPT" > "$PROMPT_FILE"
  log "prompt" "wrote prompt to $PROMPT_FILE"
fi

# --- Step 3: Build runner command ---
```

を、`fi` と `# --- Step 3` の間に新ブロックを挟んだ以下の形に変更する:

```bash
  FULL_PROMPT="$PROMPT"
  printf '%s\n' "$FULL_PROMPT" > "$PROMPT_FILE"
  log "prompt" "wrote prompt to $PROMPT_FILE"
fi

# --- Step 2b: plan モード遵守ゲート (ExitPlanMode hook 注入) ---
# 標準 plan モードは ExitPlanMode 承認直後に「プランを実行せよ」という強い指示が入り、
# プロンプト焼き込みの MANDATORY MODEL SELECTION SEQUENCE (Phase A-R / Phase B) が
# スキップされることがある。承認直後に PostToolUse hook で指示を機械的に再注入する。
# hook はベストエフォート: 失敗は警告のみで dispatch を止めない (プロンプト側指示がフォールバック)。
# claude-teams レイアウトは除外: 子プロンプトに MANDATORY MODEL SELECTION SEQUENCE が無いため
# (Phase B はオーケストレーターが teammate を駆動するので不適用)、hook 注入は無意味かつ有害。
if [[ "$MODE" == "plan" && "$RUNNER_ENGINE" == "claude" && "$LAYOUT" != "claude-teams" ]]; then
  SETTINGS_DIR="$CWD/.claude"
  SETTINGS_FILE="$SETTINGS_DIR/settings.local.json"
  HOOK_SCRIPT="$SCRIPT_DIR/plan-approved-hook.sh"
  if [[ -f "$SETTINGS_FILE" ]] && grep -q "plan-approved-hook.sh" "$SETTINGS_FILE" 2>/dev/null; then
    # worktree 再利用時の重複注入を防ぐ
    log "hook" "ExitPlanMode hook already present in $SETTINGS_FILE"
  elif ! mkdir -p "$SETTINGS_DIR" 2>/dev/null; then
    log "warn" "failed to create $SETTINGS_DIR; skipping ExitPlanMode hook injection"
  else
    HOOK_ENTRY=$(jq -n --arg cmd "zsh $HOOK_SCRIPT" \
      '{matcher: "ExitPlanMode", hooks: [{type: "command", command: $cmd}]}' 2>/dev/null) || HOOK_ENTRY=""
    if [[ -z "$HOOK_ENTRY" ]]; then
      log "warn" "failed to compose ExitPlanMode hook entry; skipping injection"
    elif [[ -f "$SETTINGS_FILE" ]]; then
      if MERGED=$(jq --argjson entry "$HOOK_ENTRY" \
        '.hooks.PostToolUse = ((.hooks.PostToolUse // []) + [$entry])' "$SETTINGS_FILE" 2>/dev/null); then
        if printf '%s\n' "$MERGED" > "$SETTINGS_FILE" 2>/dev/null; then
          log "hook" "merged ExitPlanMode hook into $SETTINGS_FILE"
        else
          log "warn" "failed to write merged $SETTINGS_FILE; skipping"
        fi
      else
        log "warn" "failed to merge ExitPlanMode hook into $SETTINGS_FILE; skipping"
      fi
    else
      if jq -n --argjson entry "$HOOK_ENTRY" '{hooks: {PostToolUse: [$entry]}}' > "$SETTINGS_FILE" 2>/dev/null; then
        log "hook" "wrote ExitPlanMode hook to $SETTINGS_FILE"
      else
        log "warn" "failed to write $SETTINGS_FILE; skipping"
      fi
    fi
  fi
  # 誤コミット防止: settings.local.json を repo 共有の info/exclude に追記する。
  # info/exclude は worktree 間で共有されるが、このファイルは元々ローカル専用のため実害なし。
  EXCLUDE_FILE=$(git -C "$CWD" rev-parse --path-format=absolute --git-path info/exclude 2>/dev/null || true)
  if [[ -n "$EXCLUDE_FILE" ]]; then
    mkdir -p "$(dirname "$EXCLUDE_FILE")" 2>/dev/null || true
    grep -qxF '.claude/settings.local.json' "$EXCLUDE_FILE" 2>/dev/null \
      || echo '.claude/settings.local.json' >> "$EXCLUDE_FILE" 2>/dev/null \
      || log "warn" "failed to append to $EXCLUDE_FILE"
  else
    log "warn" "could not resolve info/exclude for $CWD; settings.local.json may appear in git status"
  fi
fi

# --- Step 3: Build runner command ---
```

- [ ] **Step 3: 構文チェック**

```bash
bash -n apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh && echo SYNTAX_OK
```

Expected: `SYNTAX_OK`

- [ ] **Step 4: jq ロジックを fixture で検証する**

scratchpad ディレクトリで新規作成パスとマージパスの両方を検証:

```bash
SP="/private/tmp/claude-501/-Users-yui-Documents-workspace-tanaka-yui-yui-cc-plugins/f4937502-2bf8-423f-b5d9-c671d74964be/scratchpad/hook-test"
mkdir -p "$SP" && cd "$SP"
HOOK_ENTRY=$(jq -n --arg cmd "zsh /abs/path/plan-approved-hook.sh" \
  '{matcher: "ExitPlanMode", hooks: [{type: "command", command: $cmd}]}')

# (1) 新規作成パス
jq -n --argjson entry "$HOOK_ENTRY" '{hooks: {PostToolUse: [$entry]}}' > settings.local.json
jq -e '.hooks.PostToolUse[0].matcher == "ExitPlanMode"' settings.local.json

# (2) 既存 settings へのマージパス (既存キーが保持されること)
echo '{"permissions":{"allow":["Bash(ls:*)"]},"hooks":{"PostToolUse":[{"matcher":"Write","hooks":[]}]}}' > existing.json
jq --argjson entry "$HOOK_ENTRY" \
  '.hooks.PostToolUse = ((.hooks.PostToolUse // []) + [$entry])' existing.json \
  | jq -e '(.permissions.allow | length == 1) and (.hooks.PostToolUse | length == 2) and (.hooks.PostToolUse[1].matcher == "ExitPlanMode")'
cd - >/dev/null
```

Expected: (1) `true`、(2) `true`（既存の permissions と Write hook が保持され、ExitPlanMode entry が末尾に追加される）

- [ ] **Step 5: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh
git commit -m "feat(cmux-team-dispatch-task): plan モード worktree に ExitPlanMode hook を注入

--mode plan + claude engine のときのみ .claude/settings.local.json に
PostToolUse hook を書き込み (既存 settings は jq マージ・重複注入なし)、
repo 共有 info/exclude に追記して誤コミットを防ぐ。失敗は警告のみで
dispatch を止めない。"
```

---

### Task 3: 4 ファイルのドキュメント同期（対策 A + hook 機構の記載）

**Files:**

- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md:542-546`（PHASE A）、`SKILL.md:631-632`（VIOLATION）、`SKILL.md:897-899`（新サブセクション挿入）
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md:1088-1092`（Phase A セクション）
- Modify: `apps/cmux-team-dispatch-task/README.md`（「codex オプションを使う場合は…」の段落直後）
- Modify: `apps/cmux-team-dispatch-task/CLAUDE.md`（メンテナンス手順 16 追加、E2E テスト項目 28 追加）

**Interfaces:**

- Consumes: Task 1 のスクリプト名 `plan-approved-hook.sh`、Task 2 の注入条件（`--mode plan` + claude engine）・ベストエフォート方針・`info/exclude` 追記
- Produces: なし（ドキュメントのみ）。**4 ファイルは必ずこのタスクの単一コミットにまとめる**（整合ルール）

- [ ] **Step 1: SKILL.md — PHASE A テンプレートを修正する**

既存テキスト（SKILL.md 内 MANDATORY MODEL SELECTION SEQUENCE ブロック）:

```
PHASE A — Planning / Brainstorming (always opus):
  Use opus for plan / brainstorming. Do NOT switch models in this phase.
  - superpowers mode: invoke "superpowers:brainstorming" then write a plan
  - plan mode: use Claude's built-in /plan to produce a structured plan
  Remember the path of the plan file you wrote — Phase B may hand it off.
```

を以下に置換:

```
PHASE A — Planning / Brainstorming (always opus):
  Use opus for plan / brainstorming. Do NOT switch models in this phase.
  - superpowers mode: invoke "superpowers:brainstorming" then write a plan
  - plan mode: use Claude's built-in /plan to produce a structured plan.
    The plan you present for approval MUST list, BEFORE any implementation
    step:
      Step 0: Phase A-R codex review (only when the PHASE A-R block exists below)
      Step 1: Phase B execution-model selection via AskUserQuestion
    Executing the approved plan therefore STARTS with Phase A-R / Phase B,
    never with a code change.
  Remember the path of the plan file you wrote — Phase B may hand it off.
  plan mode: if the plan only exists in the ExitPlanMode message, save it to
  a file (e.g. .claude/plans/<task-slug>.md in this worktree) as your FIRST
  action after approval — Phase B hands the path off via --plan-file.
```

- [ ] **Step 2: SKILL.md — VIOLATION 節に PLAN-MODE TRAP を追記する**

既存テキスト:

```
VIOLATION: Do NOT skip Phase B. Even in auto mode, ALWAYS ask. Skipping the
model selection question is a critical error.
=== END MANDATORY MODEL SELECTION SEQUENCE ===
```

を以下に置換:

```
VIOLATION: Do NOT skip Phase B. Even in auto mode, ALWAYS ask. Skipping the
model selection question is a critical error.
PLAN-MODE TRAP: ExitPlanMode approval ("start implementing") does NOT
override this sequence. After the plan is approved, BEFORE editing any file,
return to this block and complete Phase A-R (if present) then Phase B. Save
the plan to a file first if you have not already.
=== END MANDATORY MODEL SELECTION SEQUENCE ===
```

- [ ] **Step 3: SKILL.md — hook 機構のサブセクションを追加する**

既存テキスト（ステータスプロトコル説明の末尾、897-899 行目付近）:

```
Replace `<project-root>` with the actual project root path and `<task-slug>` with the task's slug,
and `<team>` with the agmsg team name resolved in Step 1g (agmsg mode only).

### Launch: Workspace Mode (default)
```

を以下に置換（間に新サブセクションを挿入）:

```
Replace `<project-root>` with the actual project root path and `<task-slug>` with the task's slug,
and `<team>` with the agmsg team name resolved in Step 1g (agmsg mode only).

### Plan-mode Enforcement Hook (ExitPlanMode)

標準 plan モードでは ExitPlanMode 承認直後に「プランを実行せよ」という強いシステム指示が
入り、プロンプト焼き込みの MANDATORY MODEL SELECTION SEQUENCE (Phase A-R / Phase B) が
スキップされることがある。これを防ぐため、`launch-workspace.sh` は **`--mode plan` かつ
claude engine** のときのみ、worktree の `.claude/settings.local.json` に PostToolUse hook
(matcher: `ExitPlanMode`, command: `zsh <this-skill-dir>/scripts/plan-approved-hook.sh`) を
注入する。hook は承認直後に「ファイル編集前に Phase A-R (有効時) → Phase B を実行せよ」と
いう additionalContext を機械的に再注入する。

- hook はベストエフォート: settings 書き込み・マージ失敗は警告ログのみで dispatch を止めない
  (プロンプト側の指示がフォールバック)。既存 settings.local.json は jq でマージし、
  worktree 再利用時に重複注入しない
- 誤コミット防止: `.claude/settings.local.json` は repo 共有の `info/exclude` に追記される
- superpowers モード / codex engine / execute・standby・review モードでは注入されない

### Launch: Workspace Mode (default)
```

- [ ] **Step 4: guide-ja.md — Phase A セクションを同期する**

既存テキスト（1088 行目付近）:

```
### Phase A: Plan / Brainstorming（常に opus）

- superpowers モード: `superpowers:brainstorming` → `superpowers:writing-plans`
- plan モード: 組み込み `/plan`
- このフェーズでは **モデル切り替えを禁止** する。常に opus を使う。
```

を以下に置換:

```
### Phase A: Plan / Brainstorming（常に opus）

- superpowers モード: `superpowers:brainstorming` → `superpowers:writing-plans`
- plan モード: 組み込み `/plan`。提示する plan の冒頭に、実装ステップより前の必須ステップと
  して「Step 0: Phase A-R codex レビュー（有効時）」「Step 1: Phase B 実行モデル選択
  （AskUserQuestion）」を必ず記載する。承認された plan の実行は Phase A-R / Phase B から
  始まり、コード変更からは始まらない
- plan モードで plan が ExitPlanMode メッセージ内にしか存在しない場合、承認後の最初の作業
  としてファイル（例: worktree 内 `.claude/plans/<task-slug>.md`）に保存する（Phase B の
  `--plan-file` 受け渡しに必要）
- このフェーズでは **モデル切り替えを禁止** する。常に opus を使う。

#### plan モードの遵守ゲート（ExitPlanMode hook）

標準 plan モードでは ExitPlanMode 承認直後に「プランを実行せよ」という強いシステム指示が
入り、上記シーケンスがスキップされることがある。これを防ぐため、`launch-workspace.sh` は
`--mode plan` かつ claude engine のときのみ、worktree の `.claude/settings.local.json` に
PostToolUse hook（matcher: `ExitPlanMode`、command:
`zsh <skill-dir>/scripts/plan-approved-hook.sh`）を注入する。hook は承認直後に「ファイル
編集前に Phase A-R（有効時）→ Phase B を実行せよ」という additionalContext を機械的に
再注入する。

- ベストエフォート: settings 書き込み・マージ失敗は警告のみで dispatch を止めない
  （プロンプト側の指示がフォールバック）。既存 settings.local.json は jq でマージし、
  worktree 再利用時に重複注入しない
- 誤コミット防止: `.claude/settings.local.json` は repo 共有の `info/exclude` に追記される
- superpowers モード / codex engine / execute・standby・review モードでは注入されない
```

- [ ] **Step 5: README.md — plan モード遵守ゲートの説明を追加する**

既存テキスト:

```
codex オプションを使う場合は事前に `cmux codex install-hooks` の実行が必要です。
```

を以下に置換（直後に新見出しを追加。次の見出し `### Pre-warm standby panes` の前に入る）:

```
codex オプションを使う場合は事前に `cmux codex install-hooks` の実行が必要です。

### plan モードの Phase A-R / B 遵守ゲート

標準 plan モードでは ExitPlanMode 承認直後に子セッションがそのまま実装へ進み、Phase A-R /
Phase B がスキップされることがあります。対策として `launch-workspace.sh` が plan モード +
claude engine の worktree に `.claude/settings.local.json`（ExitPlanMode の PostToolUse
hook、`scripts/plan-approved-hook.sh` を呼ぶ）を注入し、承認直後に「ファイル編集前に
Phase A-R（有効時）→ Phase B を実行せよ」という指示を機械的に再注入します。あわせて子への
プロンプトで、plan 冒頭に Phase A-R / B を必須ステップとして記載させます。hook はベスト
エフォートで、書き込みに失敗しても dispatch は止まりません。`.claude/settings.local.json`
は repo 共有の `info/exclude` に追記され、タスクブランチにコミットされません。
```

- [ ] **Step 6: CLAUDE.md — メンテナンス手順 16 を追加する**

既存のメンテナンス手順 15（`15. agmsg 配送の watcher 生存チェックが...` の項目全体）の直後に追加:

```
16. plan モードの遵守ゲート（ExitPlanMode hook）が SKILL.md / guide-ja.md / README.md / CLAUDE.md の 4 ファイルで一致しているか確認:
    - `launch-workspace.sh` が `--mode plan` かつ claude engine のときのみ worktree の `.claude/settings.local.json` に PostToolUse hook（matcher: `ExitPlanMode`、command: `zsh <skill-dir>/scripts/plan-approved-hook.sh`）を注入すること（既存 settings は jq マージ、worktree 再利用時は重複注入なし、失敗は警告のみで dispatch 続行）
    - `.claude/settings.local.json` が repo 共有の `info/exclude` に追記されること
    - MANDATORY MODEL SELECTION SEQUENCE の Phase A（plan モード）に「plan 冒頭に Step 0: Phase A-R（有効時）/ Step 1: Phase B を必須ステップとして記載」「plan が ExitPlanMode メッセージ内にしか無い場合は承認後最初にファイル保存」の指示、VIOLATION 節に PLAN-MODE TRAP が含まれること
    - `plan-approved-hook.sh` の出力が有効な JSON（`hookSpecificOutput.additionalContext`）であること
```

- [ ] **Step 7: CLAUDE.md — E2E テスト項目 28 を追加する**

既存の E2E テスト項目 27（`27. **watcher 死亡時のフォールバック**: ...` の項目全体）の直後に追加:

```
28. **plan モード遵守ゲート**: plan モード子セッションで ExitPlanMode 承認後、ファイル編集前に Phase A-R（有効時）→ Phase B の質問が出ること。worktree に `.claude/settings.local.json` が生成され `git status` に現れないこと。superpowers モードの worktree には hook が注入されないこと。既存の `.claude/settings.local.json` がある worktree では既存キーが保持されたままマージされること
```

- [ ] **Step 8: 4 ファイルの整合を目視確認する**

以下がすべて 4 ファイルで一致していることを確認:

```bash
grep -rn "plan-approved-hook.sh" apps/cmux-team-dispatch-task/ --include="*.md"
grep -rn "PLAN-MODE TRAP" apps/cmux-team-dispatch-task/
```

Expected: `plan-approved-hook.sh` が SKILL.md / guide-ja.md / README.md / CLAUDE.md の 4 ファイルに登場すること。`PLAN-MODE TRAP` が SKILL.md（テンプレート）と CLAUDE.md（検証項目）に登場すること

- [ ] **Step 9: 単一コミット（4 ファイル同時）**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md \
        apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md \
        apps/cmux-team-dispatch-task/README.md \
        apps/cmux-team-dispatch-task/CLAUDE.md
git commit -m "docs(cmux-team-dispatch-task): plan モードの Phase A-R/B 遵守ゲートを 4 ファイルに同期

- Phase A テンプレートに plan 冒頭への Step 0/1 記載指示と plan ファイル保存指示を追加
- VIOLATION 節に PLAN-MODE TRAP を追記
- ExitPlanMode hook 機構の説明を SKILL.md / guide-ja.md / README.md に追加
- CLAUDE.md にメンテナンス手順 16 と E2E テスト項目 28 を追加"
```

---

### Task 4: バージョン 1.6.0 への bump

**Files:**

- Modify: `apps/cmux-team-dispatch-task/.claude-plugin/plugin.json`（`"version": "1.5.2"` → `"1.6.0"`）
- Modify: `.claude-plugin/marketplace.json`（`cmux-team-dispatch-task` エントリの `"version": "1.5.2"` → `"1.6.0"`）

**Interfaces:**

- Consumes: なし
- Produces: なし（マニフェストのみ）

- [ ] **Step 1: plugin.json のバージョンを更新する**

`apps/cmux-team-dispatch-task/.claude-plugin/plugin.json` の `"version": "1.5.2",` を `"version": "1.6.0",` に変更

- [ ] **Step 2: marketplace.json の対応エントリを同期する**

`.claude-plugin/marketplace.json` 内、`"name": "cmux-team-dispatch-task"` を含むエントリの `"version": "1.5.2",` を `"version": "1.6.0",` に変更（他プラグインのバージョンには触れない）

- [ ] **Step 3: JSON 妥当性と一致を検証する**

```bash
jq -r '.version' apps/cmux-team-dispatch-task/.claude-plugin/plugin.json
jq -r '.plugins[] | select(.name == "cmux-team-dispatch-task") | .version' .claude-plugin/marketplace.json
```

Expected: 両方とも `1.6.0`

- [ ] **Step 4: コミット**

```bash
git add apps/cmux-team-dispatch-task/.claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "chore(cmux-team-dispatch-task): version bump 1.6.0 (plan モード Phase A-R/B 遵守ゲート)"
```

---

### Task 5: 手動 E2E 検証（cmux セッション内）

**Files:** なし（検証のみ。CLAUDE.md E2E 項目 28 の実施）

**Interfaces:**

- Consumes: Task 1〜4 の全成果物
- Produces: 検証結果の報告（不具合があれば修正タスクを追加）

- [ ] **Step 1: hook 注入の単体確認（cmux 不要の範囲）**

テスト用の一時 git リポジトリで注入ブロックの挙動だけを切り出して確認する。`launch-workspace.sh` 全体は cmux ワークスペースを実際に起動してしまうため、このステップでは Step 2b のブロックを scratchpad 上で再現実行する:

```bash
SP="/private/tmp/claude-501/-Users-yui-Documents-workspace-tanaka-yui-yui-cc-plugins/f4937502-2bf8-423f-b5d9-c671d74964be/scratchpad/e2e-hook"
rm -rf "$SP" && mkdir -p "$SP" && cd "$SP"
git init -q repo && cd repo && git commit -q --allow-empty -m init

# launch-workspace.sh の Step 2b ブロックを実ファイルから抽出して実行する
# (コピーではなく抽出にすることで、テスト対象が常に実装と一致する)
MODE=plan; RUNNER_ENGINE=claude; CWD="$PWD"
SCRIPT_DIR="/Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins/apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts"
log() { echo "[$1] $2" >&2; }
sed -n '/--- Step 2b: plan モード遵守ゲート/,/^fi$/p' "$SCRIPT_DIR/launch-workspace.sh" > step2b.sh
source step2b.sh

# 検証:
jq -e '.hooks.PostToolUse[0].matcher == "ExitPlanMode"' .claude/settings.local.json
git status --porcelain   # 何も出力されないこと (info/exclude が効いている)
cd - >/dev/null
```

Expected: jq が `true`、`git status --porcelain` が空出力

- [ ] **Step 2: 実ディスパッチでの E2E（ユーザーと協働）**

cmux セッション内で plan モードの 1 タスクを実際に dispatch し、以下を確認する（ユーザーの操作が必要なため、実施タイミングはユーザーに確認する）:

1. 子セッションの plan に Step 0（Phase A-R）/ Step 1（Phase B）が含まれること
2. ExitPlanMode 承認後、ファイル編集前に（Phase A-R 有効時は codex レビューが走り）Phase B の AskUserQuestion が出ること
3. worktree の `git status` に `.claude/settings.local.json` が現れないこと
4. superpowers モードのタスクでは hook が注入されないこと

Expected: 4 点すべて成立。不成立の項目があれば systematic-debugging で原因を特定し修正する
