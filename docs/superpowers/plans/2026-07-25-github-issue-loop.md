# GitHub issue 自動ループ Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `cmux-team-dispatch-task` に、GitHub issue を自動取得して対象がなくなるまでバッチ実行し続ける無人ループモードを追加し、あわせて codex 子セッションの承認待ちを全経路で解消する。

**Architecture:** 親 Claude セッションがループを駆動する。新規シェルスクリプト 3 本（`issue-fetch.sh` / `batch-wait.sh` / `loop-cleanup.sh`）が issue の claim・バッチ待機・後片付けを担い、ループ手順は `references/loop-mode.md` に分離する。既存の起動系（`launch-workspace.sh` / `prewarm-panes.sh`）には非対話化フラグ `--unattended` と codex の hook trust バイパスを追加する。非ループ経路の挙動は、明示された 2 つの例外（hook trust バイパス、active loop lock ガード）以外は変えない。

**Tech Stack:** bash 3.2 互換シェルスクリプト、`jq`、`gh` CLI、`git worktree`、cmux CLI。テストは既存の `apps/cmux-team-dispatch-task/test/*.sh` と同じ「一時ディレクトリ + スタブ実行ファイル + assert 関数」方式。

**設計の SoT:** `docs/superpowers/specs/2026-07-25-github-issue-loop-design.md`。以下の本文で「spec §N」と書いたらこのファイルの該当節を指す。

## Global Constraints

- ドキュメント・コメント・コミットメッセージは **日本語**、コード（変数名・関数名・CLI フラグ）は **英語**。
- 新規シェルスクリプトは `#!/usr/bin/env bash` + `set -euo pipefail`。macOS の bash 3.2 で動くこと（連想配列を使わない。空配列の展開は `${arr[@]+"${arr[@]}"}` イディオムを使う）。
- 既存スクリプトのスタイルに合わせる: `die()` / `log()` ヘルパー、stderr にログ、stdout に JSON。
- スクリプトは `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/` に置く。テストは `apps/cmux-team-dispatch-task/test/` に置く。
- ループ状態は `<repo-root>/.dispatch-loop/` 配下。タスクの `STATUS_DIR` は従来どおり `<repo-root>/.dispatch/<slug>`。
- `loop-state.json` への書き込みは必ず **同一ディレクトリの `mktemp` + `mv`**（atomic replace）。`jq` が成功したときだけ `mv` する。
- ドキュメント整合の絶対ルール: `SKILL.md` / `references/guide-ja.md` / `README.md` / `CLAUDE.md` の 4 ファイルは同時に更新する。
- バージョン: `apps/cmux-team-dispatch-task/.claude-plugin/plugin.json` を `1.9.0` → `1.10.0`、ルート `.claude-plugin/marketplace.json` の対応 version も同期。
- 各タスクの最後に必ずコミットする。コミット本文は日本語。

---

### Task 1: codex 全経路に hook trust バイパスを追加する

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh:571-603`
- Test: `apps/cmux-team-dispatch-task/test/test-launch-workspace-codex.sh`

**Interfaces:**
- Consumes: なし（最初のタスク）
- Produces: codex engine の生成コマンドに常に `--dangerously-bypass-hook-trust` が含まれるようになる。以降のタスクはこれを前提にしてよい。

**背景（spec §6.2）:** codex 0.145.0 の hook trust は `~/.codex/config.toml` の `[hooks.state."<hooks.json の絶対パス>:..."]` に記録される。agmsg が worktree ごとに新しい `.codex/hooks.json` を生成するためパスが毎回変わり、常に未信頼と判定されて起動直後に承認待ちで停止する。`--dangerously-bypass-approvals-and-sandbox` はこれをカバーしない。

- [ ] **Step 1: 失敗するテストを追加する**

`apps/cmux-team-dispatch-task/test/test-launch-workspace-codex.sh` の `assert_not_contains "$review_runner" '--dangerously-bypass-approvals-and-sandbox' 'T5 review does not disable sandbox'` の直後に追加:

```bash
# --- hook trust: codex 0.145 は project-local .codex/hooks.json ごとに信頼を求める。
# agmsg が worktree ごとに新しい hooks.json を生成するためパスが毎回変わり、常に未信頼と
# 判定されて起動直後に承認待ちで停止する。approvals-and-sandbox のバイパスとは別フラグ。 ---
assert_contains "$superpowers_runner" '--dangerously-bypass-hook-trust' 'T8 codex + superpowers hook trust bypass'
assert_contains "$plan_runner" '--dangerously-bypass-hook-trust' 'T8 codex + plan hook trust bypass'
assert_contains "$execute_runner" '--dangerously-bypass-hook-trust' 'T8 codex + execute hook trust bypass'
assert_contains "$standby_runner" '--dangerously-bypass-hook-trust' 'T8 codex + standby hook trust bypass'
assert_contains "$review_runner" '--dangerously-bypass-hook-trust' 'T8 codex + review hook trust bypass'
```

同ファイルの claude ループ（`for mode in superpowers plan execute standby review; do` の中）に、`assert_not_contains "$claude_runner_file" '--dangerously-bypass-approvals-and-sandbox' ...` の直後へ追加:

```bash
  assert_not_contains "$claude_runner_file" '--dangerously-bypass-hook-trust' "T9 claude + $mode has no codex hook trust flag"
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `bash apps/cmux-team-dispatch-task/test/test-launch-workspace-codex.sh`
Expected: `FAIL: T8 codex + superpowers hook trust bypass (missing: --dangerously-bypass-hook-trust)` が 5 件出て exit 1

- [ ] **Step 3: 実装する**

`launch-workspace.sh` の codex engine 分岐（`if [[ "$RUNNER_ENGINE" == "codex" ]]; then` のブロック）の直前に定数を追加する。`CODEX_EFFORT_FLAG` を組み立てている箇所（`log "runner" "name=..."` の直前）に置く:

```bash
# codex 0.145 以降は project-local .codex/hooks.json ごとに信頼確認を行う。信頼状態は
# hooks.json の絶対パスをキーに記録されるため、worktree ごとに新しいパスが生成される
# このプラグインでは毎回「未信頼」となり、起動直後に承認待ちで停止する。
# --dangerously-bypass-approvals-and-sandbox はコマンド承認と sandbox だけを無効化し、
# hook trust には作用しないので、専用フラグを全 codex 経路に付ける。
CODEX_HOOK_TRUST_FLAG=" --dangerously-bypass-hook-trust"
```

続いて codex 分岐の 5 箇所すべてで、`$CODEX_EFFORT_FLAG` の直後（`--dangerously-bypass-approvals-and-sandbox` / `--sandbox` の直前）に `$CODEX_HOOK_TRUST_FLAG` を挿入する。置換後の各行:

```bash
    if [[ "$MODE" == "execute" ]]; then
      CODEX_MODEL_FLAG=""
      [[ -n "$MODEL" ]] && CODEX_MODEL_FLAG=" --model '$MODEL'"
      CORE_CMD="$RUNNER_COMMAND$CODEX_EFFORT_FLAG$CODEX_MODEL_FLAG$CODEX_HOOK_TRUST_FLAG --dangerously-bypass-approvals-and-sandbox '$PROMPT_TEXT'"
    elif [[ "$MODE" == "standby" ]]; then
      CODEX_MODEL_FLAG=""
      [[ -n "$MODEL" ]] && CODEX_MODEL_FLAG=" --model '$MODEL'"
      if [[ -n "$PROMPT_TEXT" ]]; then
        CORE_CMD="$RUNNER_COMMAND$CODEX_EFFORT_FLAG$CODEX_MODEL_FLAG$CODEX_HOOK_TRUST_FLAG --dangerously-bypass-approvals-and-sandbox '$PROMPT_TEXT'"
      else
        CORE_CMD="$RUNNER_COMMAND$CODEX_EFFORT_FLAG$CODEX_MODEL_FLAG$CODEX_HOOK_TRUST_FLAG --dangerously-bypass-approvals-and-sandbox"
      fi
    elif [[ "$MODE" == "review" ]]; then
      CODEX_MODEL_FLAG=""
      [[ -n "$MODEL" ]] && CODEX_MODEL_FLAG=" --model '$MODEL'"
      REVIEW_WRITABLE_FLAG=""
      [[ -n "$STATUS_DIR" ]] && REVIEW_WRITABLE_FLAG=" --add-dir '$STATUS_DIR'"
      CORE_CMD="$RUNNER_COMMAND$CODEX_EFFORT_FLAG$CODEX_MODEL_FLAG$CODEX_HOOK_TRUST_FLAG --sandbox workspace-write -c approval_policy='never'$REVIEW_WRITABLE_FLAG${PROMPT_TEXT:+ '$PROMPT_TEXT'}"
    elif [[ "$MODE" == "superpowers" ]]; then
      CORE_CMD="$RUNNER_COMMAND$CODEX_EFFORT_FLAG$CODEX_HOOK_TRUST_FLAG --dangerously-bypass-approvals-and-sandbox '\$superpowers:brainstorming $PROMPT_TEXT'"
    else
      CORE_CMD="$RUNNER_COMMAND$CODEX_EFFORT_FLAG$CODEX_HOOK_TRUST_FLAG --dangerously-bypass-approvals-and-sandbox '/plan $PROMPT_TEXT'"
    fi
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `bash apps/cmux-team-dispatch-task/test/test-launch-workspace-codex.sh`
Expected: `--- all tests passed ---` で exit 0

Run: `bash -n apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh && zsh -n apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh`
Expected: 無出力・exit 0

- [ ] **Step 5: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh \
        apps/cmux-team-dispatch-task/test/test-launch-workspace-codex.sh
git commit -m "fix(cmux-team-dispatch-task): codex 全経路に hook trust バイパスを付与し起動時の承認待ちを解消"
```

---

### Task 2: runner wrapper の pr_url 引き継ぎと timeout sentinel ガード

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh`（引数パース部、runner script 生成部）
- Test: `apps/cmux-team-dispatch-task/test/test-launch-workspace-codex.sh`

**Interfaces:**
- Consumes: Task 1 の変更
- Produces:
  - `launch-workspace.sh --timeout-sentinel <path>`: 生成される runner wrapper が、そのパスが存在するとき `status.json` を書かずに exit する
  - runner wrapper の `write_status` が既存 `status.json` の `pr_url` を保持する

**背景（spec §3.7.1, §3.8.1）:** 現行 wrapper は TUI 終了時に `write_status` で status.json を全置換するため、子が書いた `pr_url` が消える。また `batch-wait.sh` が timeout として terminal 化した後に子が終了すると、`write_status` の `mkdir -p "$STATUS_DIR"` が cleanup 済みディレクトリを復活させ、次回ループの stale 検査を止めてしまう。sentinel はタスクディレクトリの外（`.dispatch-loop/timed-out/<slug>`）に置くので、cleanup では消えない。

- [ ] **Step 1: 失敗するテストを追加する**

`test-launch-workspace-codex.sh` の末尾（`if command -v codex ...` の直前）に追加:

```bash
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
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `bash apps/cmux-team-dispatch-task/test/test-launch-workspace-codex.sh`
Expected: `Error: unknown option` 相当で落ちるか、`FAIL: T10 ...` が出る

- [ ] **Step 3: 実装する**

3-a. 変数の初期化。`REVIEW_CONFIG=""` の行の直後に追加:

```bash
TIMEOUT_SENTINEL=""
```

3-b. 引数パース。`--review-config)` の case ブロックの直後に追加:

```bash
    --timeout-sentinel)
      [[ $# -lt 2 ]] && die "--timeout-sentinel requires a path argument"
      TIMEOUT_SENTINEL="$2"
      shift 2
      ;;
```

3-c. usage コメント。ファイル冒頭の `#   --review-config <path> ...` ブロックの直後に追加:

```bash
#   --timeout-sentinel <path>          ループモード専用。runner wrapper が exit 時にこの
#                                      パスの存在を確認し、あれば status.json を書かずに
#                                      終了する。batch-wait.sh が timeout として terminal 化
#                                      したタスクの遅延書き込み (status 上書き / status dir の
#                                      再生成) を防ぐ。未指定 (非ループ) では wrapper の
#                                      挙動は従来どおり
```

3-d. runner script 生成。`cat > "$RUNNER_FILE" <<EOF` の変数定義部に `TIMEOUT_SENTINEL` を追加する。`AGMSG_FROM="${AGMSG_FROM}"` の直後:

```bash
TIMEOUT_SENTINEL="${TIMEOUT_SENTINEL}"
```

3-e. `write_status` を pr_url 引き継ぎ版に置き換える。現行の `write_status() { ... }` 全体を次で差し替える:

```bash
write_status() {
  local status="\$1"
  local message="\$2"
  if [[ -n "\$STATUS_DIR" ]]; then
    mkdir -p "\$STATUS_DIR"
    # 子セッションが書いた pr_url を exit 時の上書きで失わないよう引き継ぐ。
    # PR 作成済みかどうかは完了判定の根拠になるため、消してはいけない。
    local PREV_PR_URL=""
    if [[ -f "\$STATUS_DIR/status.json" ]]; then
      PREV_PR_URL=\$(jq -r '.pr_url // empty' "\$STATUS_DIR/status.json" 2>/dev/null || echo "")
    fi
    jq -n --arg s "\$status" --arg m "\$message" --arg ws "\$WORKSPACE_ID" --arg sf "\$SURFACE_ID" \\
      --arg pr "\$PREV_PR_URL" \\
      '{status:\$s, message:\$m, workspace_id:\$ws, surface_id:\$sf, timestamp:(now|todate)}
       + (if \$pr == "" then {} else {pr_url:\$pr} end)' \\
      > "\$STATUS_DIR/status.json"
  fi
}
```

3-f. sentinel ガード。`.deferred` の判定ブロック（`if [[ "\$DEFER_STATUS" == "1" && ...`）の**直前**に挿入する:

```bash
# ループモード: batch-wait.sh が deadline 超過でこのタスクを terminal 化済みなら、
# 遅れて終了した子が status.json を上書きしたり、cleanup 済みの STATUS_DIR を
# mkdir -p で復活させたりしないよう、ここで何も書かずに終了する。
if [[ -n "\$TIMEOUT_SENTINEL" && -f "\$TIMEOUT_SENTINEL" ]]; then
  echo "[runner] timeout sentinel found at \$TIMEOUT_SENTINEL; skipping status update" >&2
  exit 0
fi
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `bash apps/cmux-team-dispatch-task/test/test-launch-workspace-codex.sh`
Expected: `--- all tests passed ---`

Run: `bash -n apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh`
Expected: 無出力

- [ ] **Step 5: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh \
        apps/cmux-team-dispatch-task/test/test-launch-workspace-codex.sh
git commit -m "feat(cmux-team-dispatch-task): runner wrapper に pr_url 引き継ぎと timeout sentinel ガードを追加"
```

---

### Task 3: `launch-workspace.sh --unattended`

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh:505-555`
- Test: `apps/cmux-team-dispatch-task/test/test-launch-workspace-codex.sh`

**Interfaces:**
- Consumes: Task 2 の変更
- Produces: `launch-workspace.sh --unattended`。`--mode execute` / `--mode standby` で有効。指定時、生成される runner script に `AskUserQuestion` の文字列が一切含まれず、claude engine には `--dangerously-skip-permissions` が強制付与される。

**背景（spec §4.3）:** Phase B で `prewarm.json` が無いとき、実装者は `--mode execute` で spawn され、その inner prompt は `REVIEW_INSTRUCTION` から新規構築される。現行の `REVIEW_INSTRUCTION` は round 3 / stalled 時に「可能なら AskUserQuestion で聞け」と明記しており、ループ中に質問が発生する。

- [ ] **Step 1: 失敗するテストを追加する**

`test-launch-workspace-codex.sh` の Task 2 で追加したブロックの後に追加:

```bash
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
  'T12 --unattended は round 3 の固定フォールバックを持つ'

# 後方互換: --unattended 無しでは現行文言が保たれる
attended_output=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" bash "$LAUNCH" \
  --cwd "$TMP/repo" --mode execute --runner claude --plan-file "$TMP/plan.md" \
  --status-dir "$TMP/status" --review-config "$TMP/review-config.json" "attended-exec")
attended_runner=$(jq -r '.runner_file' <<<"$attended_output")
assert_contains "$attended_runner" 'AskUserQuestion' 'T13 --unattended 無しでは現行の質問分岐が残る'
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `bash apps/cmux-team-dispatch-task/test/test-launch-workspace-codex.sh`
Expected: `Error: unknown option: --unattended` で落ちる

- [ ] **Step 3: 実装する**

3-a. 変数の初期化。`TIMEOUT_SENTINEL=""` の直後に追加:

```bash
UNATTENDED=0
```

3-b. 引数パース。`--timeout-sentinel)` の case ブロックの直後に追加:

```bash
    --unattended)
      UNATTENDED=1
      shift
      ;;
```

3-c. usage コメント。`--timeout-sentinel` の説明の直後に追加:

```bash
#   --unattended                       ループモード専用。--mode execute / standby で有効。
#                                      inner prompt のレビュー fallback から対話質問を除去し、
#                                      claude engine には --dangerously-skip-permissions を
#                                      強制付与する。他モードでは警告して無視
```

3-d. モード検証。`if [[ -n "$REVIEW_CONFIG" ]]; then ... fi` の直後に追加:

```bash
# --unattended は実行系 (execute / standby) 専用
if [[ $UNATTENDED -eq 1 && "$MODE" != "execute" && "$MODE" != "standby" ]]; then
  log "warn" "--unattended is only meaningful with --mode execute/standby; ignoring for mode=$MODE"
  UNATTENDED=0
fi
```

3-e. `REVIEW_INSTRUCTION` の末尾（`(3) On VERDICT: approve ...` の文）を分岐させる。現行の `REVIEW_INSTRUCTION="MANDATORY CODE REVIEW: ..."` の代入を、共通部分と末尾に分ける:

```bash
    READ_SCREEN_CMD="$CMUX read-screen $TARGET_FLAGS"
    # (1)(2) は対話有無で変わらない共通部分
    REVIEW_INSTRUCTION="MANDATORY CODE REVIEW: after all changes are committed and BEFORE creating the PR, you must get a code review approval. Round N starts at 1, max 3 rounds. Each round: (1) request the review by running: $CMUX send $TARGET_FLAGS followed by: $CMUX send-key $TARGET_FLAGS return -- the message must say: code review round N: review the committed changes on this branch against the plan at $PLAN_FILE and write findings to $REVIEW_DIR/code-round-N.md whose LAST line must be VERDICT: approve or VERDICT: needs_work. From round 2 include your rebuttals to the findings you rejected, with reasons. (2) wait by polling $REVIEW_DIR/code-round-N.md every 5 seconds for a VERDICT line, in 15-minute chunks with no overall time limit while the reviewer is active. Right after sending, capture a baseline of the reviewer pane screen by running: $READ_SCREEN_CMD -- read-screen returns live content even for unfocused workspaces. At each chunk boundary without a verdict, first re-check the verdict file once more, then capture the screen again, retrying up to 3 times 10 seconds apart on failure or empty output, and compare with the previous capture: changed means the reviewer is still working, so update the snapshot and keep waiting with no upper bound; unchanged over a full chunk means the reviewer is stalled; all retries failed is an observation failure, not stalled -- only 2 consecutive all-failed boundaries count as stalled. Whenever the wait exits stalled, re-check the verdict file one final time immediately before any re-send or skip decision. (3) On VERDICT: approve proceed to the PR. On VERDICT: needs_work apply the findings you judge valid, commit, and start round N+1. "
    if [[ $UNATTENDED -eq 1 ]]; then
      # 無人ループ: 判断を求めず固定のフォールバックを取る。文中にクォート文字を使わないこと
      REVIEW_INSTRUCTION="${REVIEW_INSTRUCTION}If round 3 still ends with needs_work, note the unresolved findings in the PR body and proceed to the PR. If the wait exits stalled, re-check the verdict file, then re-send the same round once with a fresh baseline; if it stalls again, skip the review, note the skipped review in the PR body, and proceed to the PR. No interactive user is attached to this session, so never wait for a human decision. "
    else
      REVIEW_INSTRUCTION="${REVIEW_INSTRUCTION}If round 3 still ends with needs_work, or the wait exits stalled again after one re-send of the same round with a fresh baseline: if you can ask the user interactively via AskUserQuestion, ask whether to proceed to the PR or keep going; otherwise note the unresolved or skipped review in the PR body and proceed. "
    fi
```

3-f. claude engine への skip-permissions 強制。`if [[ $SKIP_PERMISSIONS -eq 1 ]]; then` のブロックの**直前**に挿入:

```bash
# 無人ループでは permission prompt / ExitPlanMode 承認で止まらないよう強制する
if [[ $UNATTENDED -eq 1 && "$RUNNER_ENGINE" == "claude" ]]; then
  SKIP_PERMISSIONS=1
fi
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `bash apps/cmux-team-dispatch-task/test/test-launch-workspace-codex.sh`
Expected: `--- all tests passed ---`

Run: `bash apps/cmux-team-dispatch-task/test/test-launch-workspace-review-config.sh`
Expected: 既存テストが引き続き通ること

- [ ] **Step 5: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh \
        apps/cmux-team-dispatch-task/test/test-launch-workspace-codex.sh
git commit -m "feat(cmux-team-dispatch-task): launch-workspace.sh に --unattended を追加し spawn 経路の質問分岐を除去"
```

---

### Task 4: `prewarm-panes.sh` の `--unattended` と `--timeout-sentinel`

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh`
- Test: `apps/cmux-team-dispatch-task/test/test-prewarm-unattended.sh`（新規）

**Interfaces:**
- Consumes: Task 2 の `--timeout-sentinel`、Task 3 の `--unattended`
- Produces:
  - `prewarm-panes.sh --unattended`: 設計ペイン（claude opus standby）の `launch-workspace.sh` 呼び出しに `--skip-permissions` が付く
  - `prewarm-panes.sh --timeout-sentinel <path>`: **status 所有者になり得るすべての standby 起動**（opus / sonnet / codex / claude review ペイン）へ `--timeout-sentinel <path>` を転送する

**背景（spec §4.4, §3.7.1）:** 既定経路（agmsg + prewarm）では設計ペインが `--mode standby` で起動され `--skip-permissions` が付かない。またこの経路が sentinel を転送しないと、`batch-wait.sh` が sentinel を作っても standby wrapper は `TIMEOUT_SENTINEL=""` のままで late write を防げない。**`prewarm: true` が既定なので、この転送が無いと spec §3.7.1 の対策は事実上未実装になる。**

- [ ] **Step 1: 失敗するテストを書く**

Create `apps/cmux-team-dispatch-task/test/test-prewarm-unattended.sh`:

opus ペインは `--with-opus`（agmsg モード）でしか起動しないため、**両ケースとも
`--with-opus --message-type agmsg` で実行する**。agmsg スクリプトはスタブ化する。

```bash
#!/usr/bin/env bash
# prewarm-panes.sh の --unattended / --timeout-sentinel が各 standby 起動へ
# 正しく転送されることの検査。launch-workspace.sh と agmsg をスタブ化する。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/scripts" "$TMP/repo" "$TMP/status" "$TMP/agmsg"
git -C "$TMP/repo" init -q
git -C "$TMP/repo" config user.email test@example.invalid
git -C "$TMP/repo" config user.name test
touch "$TMP/repo/.gitkeep"
git -C "$TMP/repo" add .gitkeep
git -C "$TMP/repo" commit -qm init

cp "$SRC" "$TMP/scripts/prewarm-panes.sh"

# launch-workspace.sh のスタブ: 引数を 1 行ずつ argv.log に記録して最小 JSON を返す
cat > "$TMP/scripts/launch-workspace.sh" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$ARGV_LOG"
jq -n '{workspace_id:"workspace:1", surface_id:"surface:1"}'
STUB
chmod +x "$TMP/scripts/launch-workspace.sh"

# agmsg のスタブ (join / delivery / leave すべて成功扱い)
for s in join.sh delivery.sh leave.sh send.sh; do
  printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/agmsg/$s"
  chmod +x "$TMP/agmsg/$s"
done

fail=0
ok()  { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; fail=1; }

# argv.log の中で pattern を含む行がすべて flag を含むか
assert_all_lines_with() {
  local pattern="$1" flag="$2" label="$3" total matched
  total=$(grep -c -F -- "$pattern" "$TMP/argv.log" || true)
  matched=$(grep -F -- "$pattern" "$TMP/argv.log" | grep -c -F -- "$flag" || true)
  if [[ "$total" -gt 0 && "$total" == "$matched" ]]; then ok "$label"
  else bad "$label (pattern 一致 $total 行のうち flag を含むのは $matched 行)"; fi
}
assert_no_line_with() {
  local pattern="$1" flag="$2" label="$3"
  if grep -F -- "$pattern" "$TMP/argv.log" | grep -Fq -- "$flag"; then
    bad "$label (予期しない $flag)"
  else ok "$label"; fi
}

run_prewarm() {   # 追加フラグを引数で受ける
  : > "$TMP/argv.log"
  ARGV_LOG="$TMP/argv.log" AGMSG_DIR="$TMP/agmsg" \
    bash "$TMP/scripts/prewarm-panes.sh" \
      --with-opus --message-type agmsg --agmsg-team demo-team \
      --cwd "$TMP/repo" --slug demo --status-dir "$TMP/status" "$@" >/dev/null
}

# --- U1: --unattended は設計 opus ペインに --skip-permissions を渡す ---
run_prewarm --unattended
assert_all_lines_with "--mode standby --defer-status --model opus[1m]" "--skip-permissions" \
  'U1 --unattended は opus standby に --skip-permissions を渡す'

# --- U2: --unattended 無しでは opus に付かない（後方互換） ---
run_prewarm
assert_no_line_with "--mode standby --defer-status --model opus[1m]" "--skip-permissions" \
  'U2 --unattended 無しでは opus standby に付かない'

# --- U3: --timeout-sentinel を全 standby へ転送する ---
run_prewarm --unattended --timeout-sentinel "$TMP/loop/timed-out/demo"
assert_all_lines_with "--mode standby" "--timeout-sentinel $TMP/loop/timed-out/demo" \
  'U3 全 standby 起動に sentinel が転送される'

# --- U4: --timeout-sentinel 未指定なら一切現れない ---
run_prewarm
assert_no_line_with "--mode standby" "--timeout-sentinel" 'U4 未指定時は sentinel を渡さない'

[[ $fail -eq 0 ]] && echo '--- all tests passed ---' || echo '--- failures ---'
exit "$fail"
```

**注:** U1 / U2 の `--mode standby --defer-status --model opus[1m]` というパターンは、実装側の
引数の並び（`--cwd` → `--mode standby` → `--defer-status` → `--model` → …）に依存する。
Step 3 の実装でこの並びを保つこと。

- [ ] **Step 2: テストが失敗することを確認する**

Run: `bash apps/cmux-team-dispatch-task/test/test-prewarm-unattended.sh`
Expected: `Error: unknown option: --unattended`

- [ ] **Step 3: 実装する**

3-a. `prewarm-panes.sh` の変数初期化部（`CLAUDE_REVIEW_MODEL=""` の直後）に追加:

```bash
UNATTENDED=0
TIMEOUT_SENTINEL=""
```

3-b. `AGMSG_DIR` をテストから差し替えられるようにする。冒頭の定義を変更:

```bash
AGMSG_DIR="${AGMSG_DIR:-$HOME/.agents/skills/agmsg/scripts}"
```

3-c. 引数パース。`--with-opus)` の case ブロックの直後に追加:

```bash
    --unattended)
      UNATTENDED=1; shift ;;
    --timeout-sentinel)
      [[ $# -lt 2 ]] && die "--timeout-sentinel requires a path"
      TIMEOUT_SENTINEL="$2"; shift 2 ;;
```

3-d. usage コメント。ファイル冒頭の Usage ブロックの各形式に `[--unattended]` を追記し、「内部処理」節の下に 1 行加える:

```bash
#   --unattended: ループモード専用。設計ペイン (claude opus standby) の起動に
#                 --skip-permissions を付ける (無人実行で permission prompt / ExitPlanMode
#                 承認により停止しないようにするため)。codex 系は bypass フラグで解決済み
#   --timeout-sentinel <path>: ループモード専用。status 所有者になり得る全 standby
#                 (opus / design codex / sonnet / codex / claude review) の launch へ
#                 そのまま転送する。batch-wait.sh が timeout として terminal 化した後に
#                 遅れて終了した子が status.json を上書きするのを防ぐ
```

3-e. sentinel を全 standby 起動へ転送するための共通配列を用意する。`NOTIFY_FLAGS=()` を
組み立てている箇所の直後に追加:

```bash
# ループモードでは、status 所有者になり得る全 standby wrapper に timeout sentinel を
# 焼き込む。ここで転送しないと prewarm 経路 (既定) では sentinel が効かず、
# timeout 後に遅れて終了した子が status.json を上書きしてしまう
SENTINEL_FLAGS=()
[[ -n "$TIMEOUT_SENTINEL" ]] && SENTINEL_FLAGS=(--timeout-sentinel "$TIMEOUT_SENTINEL")
```

3-f. opus standby の起動に反映する。`OPUS_RESULT=$(bash "$SCRIPT_DIR/launch-workspace.sh" \` の claude 側ブロック（`--model "$OPUS_MODEL"` を渡している方）を次に置き換える:

```bash
    log "prewarm" "launching opus standby workspace for $SLUG"
    OPUS_UNATTENDED_FLAGS=()
    [[ $UNATTENDED -eq 1 ]] && OPUS_UNATTENDED_FLAGS=(--skip-permissions)
    OPUS_RESULT=$(bash "$SCRIPT_DIR/launch-workspace.sh" \
      --cwd "$CWD" \
      --mode standby \
      --defer-status \
      --model "$OPUS_MODEL" \
      ${OPUS_UNATTENDED_FLAGS[@]+"${OPUS_UNATTENDED_FLAGS[@]}"} \
      ${SENTINEL_FLAGS[@]+"${SENTINEL_FLAGS[@]}"} \
      --status-dir "$STATUS_DIR" \
      ${NOTIFY_FLAGS[@]+"${NOTIFY_FLAGS[@]}"} \
      --message-type agmsg --agmsg-team "$AGMSG_TEAM" --agmsg-from "$SLUG" \
      "$SLUG" "$OPUS_PROMPT") || die "failed to launch opus standby workspace"
```

3-g. 残り 3 つの standby 起動にも同じ配列を渡す。いずれも `--status-dir "$STATUS_DIR"` の
**直前**に `${SENTINEL_FLAGS[@]+"${SENTINEL_FLAGS[@]}"} \` を 1 行挿入する:

- design=codex の設計ペイン（`--runner "$DESIGN_RUNNER"` を渡している `OPUS_RESULT=` のブロック）
- sonnet standby（`SONNET_ARGS=(...)` の配列に `--status-dir` の前で追加してもよい）
- codex standby（`CODEX_RESULT=` のブロック）
- claude review ペイン（`REVIEW_RESULT=` のブロック。design=codex で opus 1m が選ばれると
  このペインが status 所有者になるため必要）

`SONNET_ARGS` は配列なので、次のように組み立てる:

```bash
SONNET_ARGS=(
  --cwd "$CWD"
  --mode standby
  --standby-in "$WORKSPACE"
  --standby-split-from "$BASE_SURFACE"
  --model "$SONNET_MODEL"
  --skip-permissions
  ${SENTINEL_FLAGS[@]+"${SENTINEL_FLAGS[@]}"}
  --status-dir "$STATUS_DIR"
)
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `bash apps/cmux-team-dispatch-task/test/test-prewarm-unattended.sh`
Expected: `--- all tests passed ---`

Run: `bash -n apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh`
Expected: 無出力

- [ ] **Step 5: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh \
        apps/cmux-team-dispatch-task/test/test-prewarm-unattended.sh
git commit -m "feat(cmux-team-dispatch-task): prewarm-panes.sh に --unattended を追加し設計ペインを非対話化"
```

---

### Task 5: `issue-fetch.sh` のロックと状態基盤

**Files:**
- Create: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/issue-fetch.sh`
- Test: `apps/cmux-team-dispatch-task/test/test-issue-fetch.sh`（新規）

**Interfaces:**
- Consumes: なし
- Produces:
  - `issue-fetch.sh --state-file <path> lock-check` → active loop があれば exit 1
  - `issue-fetch.sh --state-file <path> lock-acquire --lease-min <N>` → 取得成功で exit 0
  - `issue-fetch.sh --state-file <path> lock-release` → owner 一致時のみ削除
  - `issue-fetch.sh --state-file <path> heartbeat`
  - 環境変数 `LOOP_SESSION_ID`（未設定なら `$CLAUDE_CODE_SESSION_ID`、それも無ければ `unknown`）で owner identity を決める
  - シェル関数 `state_write` / `require_owner`（後続タスクが同ファイル内で使う）

**背景（spec §3.4）:** `mkdir` による atomic 取得、stale takeover は atomic rename の勝者のみ、liveness の正本は `owner.json.heartbeat` に一本化、release は owner 一致時のみ。

- [ ] **Step 1: 失敗するテストを書く**

Create `apps/cmux-team-dispatch-task/test/test-issue-fetch.sh`:

```bash
#!/usr/bin/env bash
# issue-fetch.sh のロック・状態遷移・取得クエリの検査。gh はスタブ化する。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FETCH="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/issue-fetch.sh"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
# .dispatch-loop/ は「まだ存在しない」状態から始める。事前に mkdir すると
# 初回ループで起動できないバグを隠してしまう
mkdir -p "$TMP/bin" "$TMP/repo"
STATE="$TMP/repo/.dispatch-loop/loop-state.json"
export PATH="$TMP/bin:$PATH"

fail=0
ok()   { echo "PASS: $1"; }
bad()  { echo "FAIL: $1"; fail=1; }
check(){ if eval "$1"; then ok "$2"; else bad "$2"; fi; }

run() { LOOP_SESSION_ID="${SID:-sess-a}" bash "$FETCH" --state-file "$STATE" "$@"; }

# --- L0: 完全に新しいリポジトリで lock-check が成功し、何も作らない ---
check 'SID=sess-a run lock-check' 'L0 .dispatch-loop 不在でも lock-check が成功する'
check '[[ ! -d "$TMP/repo/.dispatch-loop" ]]' 'L0 lock-check は read-only (ディレクトリを作らない)'

# --- L1: 初回取得は成功する ---
check 'SID=sess-a run lock-acquire --lease-min 30' 'L1 初回 lock-acquire が成功する'
check '[[ -d "$TMP/repo/.dispatch-loop/loop.lock.d" ]]' 'L1 ロックディレクトリが作られる'

# --- L2: 別 owner は取得できない ---
check '! SID=sess-b run lock-acquire --lease-min 30' 'L2 別 owner の lock-acquire は失敗する'

# --- L3: 別 owner の release は拒否される ---
SID=sess-b run lock-release || true
check '[[ -d "$TMP/repo/.dispatch-loop/loop.lock.d" ]]' 'L3 別 owner の lock-release はロックを消さない'

# --- L4: lock-check は active を検出する ---
check '! SID=sess-b run lock-check' 'L4 lock-check は active loop を検出して非 0'

# --- L5: 自分の release は成功する ---
check 'SID=sess-a run lock-release' 'L5 owner 一致の lock-release は成功する'
check '[[ ! -d "$TMP/repo/.dispatch-loop/loop.lock.d" ]]' 'L5 ロックディレクトリが消える'

# --- L6: stale takeover は 1 owner のみ ---
SID=sess-a run lock-acquire --lease-min 30
# heartbeat を過去にする
OWNER="$TMP/repo/.dispatch-loop/loop.lock.d/owner.json"
jq '.heartbeat = "2000-01-01T00:00:00Z"' "$OWNER" > "$OWNER.tmp" && mv "$OWNER.tmp" "$OWNER"
check 'SID=sess-c run lock-acquire --lease-min 30' 'L6 stale なロックは takeover できる'
check '[[ $(ls -d "$TMP/repo/.dispatch-loop"/loop.lock.stale.* | wc -l) -eq 1 ]]' 'L6 旧ロックは 1 つだけ退避される'

# --- L7: owner token 不一致では state を書かない ---
check '! SID=sess-a run heartbeat' 'L7 owner 不一致の heartbeat は exit 1'

# --- L8: owner.json 未生成のロックは stale 扱いせず、release もしない ---
SID=sess-c run lock-release
mkdir "$TMP/repo/.dispatch-loop/loop.lock.d"     # mkdir に勝った直後の状態を再現
check '! SID=sess-x run lock-acquire --lease-min 30' 'L8 owner.json 未生成のロックは奪わない'
check '! SID=sess-x run lock-release' 'L8 owner.json 未生成のロックは release しない'
check '[[ -d "$TMP/repo/.dispatch-loop/loop.lock.d" ]]' 'L8 ロックが残っている'
rm -rf "$TMP/repo/.dispatch-loop/loop.lock.d"

# --- L9: 同時取得しても owner は 1 つに定まる ---
# barrier ファイルの出現を待ってから一斉に取得を試みる
BAR="$TMP/barrier"
for s in p1 p2 p3 p4; do
  (
    while [[ ! -f "$BAR" ]]; do sleep 0.05; done
    LOOP_SESSION_ID="$s" bash "$FETCH" --state-file "$STATE" lock-acquire --lease-min 30 \
      >/dev/null 2>&1 && echo "$s" >> "$TMP/winners.txt"
  ) &
done
sleep 0.3; : > "$BAR"; wait
check '[[ $(wc -l < "$TMP/winners.txt" | tr -d " ") -eq 1 ]]' 'L9 同時取得の勝者は 1 つだけ'
WINNER=$(cat "$TMP/winners.txt")
check '[[ $(jq -r ".session_id" "$TMP/repo/.dispatch-loop/loop.lock.d/owner.json") == "$WINNER" ]]' \
  'L9 owner.json が勝者と一致する'
LOOP_SESSION_ID="$WINNER" bash "$FETCH" --state-file "$STATE" lock-release >/dev/null 2>&1

# --- L10: 同時 stale takeover でも owner は 1 つ ---
SID=sess-a run lock-acquire --lease-min 30 >/dev/null
OWNER="$TMP/repo/.dispatch-loop/loop.lock.d/owner.json"
jq '.heartbeat = "2000-01-01T00:00:00Z"' "$OWNER" > "$OWNER.tmp" && mv "$OWNER.tmp" "$OWNER"
rm -f "$TMP/winners.txt" "$BAR"
for s in t1 t2 t3; do
  (
    while [[ ! -f "$BAR" ]]; do sleep 0.05; done
    LOOP_SESSION_ID="$s" bash "$FETCH" --state-file "$STATE" lock-acquire --lease-min 30 \
      >/dev/null 2>&1 && echo "$s" >> "$TMP/winners.txt"
  ) &
done
sleep 0.3; : > "$BAR"; wait
check '[[ $(wc -l < "$TMP/winners.txt" | tr -d " ") -eq 1 ]]' 'L10 同時 stale takeover の勝者も 1 つ'
WINNER=$(cat "$TMP/winners.txt")
LOOP_SESSION_ID="$WINNER" bash "$FETCH" --state-file "$STATE" lock-release >/dev/null 2>&1
SID=sess-c run lock-acquire --lease-min 30 >/dev/null

[[ $fail -eq 0 ]] && echo '--- all tests passed ---' || echo '--- failures ---'
exit "$fail"
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `bash apps/cmux-team-dispatch-task/test/test-issue-fetch.sh`
Expected: `bash: .../issue-fetch.sh: No such file or directory`

- [ ] **Step 3: 実装する（ロック部分のみ）**

Create `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/issue-fetch.sh`:

```bash
#!/usr/bin/env bash
# GitHub issue 自動ループの issue 取得・claim・状態管理。
#
# Usage: issue-fetch.sh --state-file <path> <subcommand> [options]
#
# Subcommands:
#   lock-check                    取得せずに active loop の有無だけを判定する
#   lock-acquire --lease-min <N>  .dispatch-loop/loop.lock.d を mkdir で atomic 取得する
#   lock-release                  自分が owner のときだけ解放する (冪等)
#   heartbeat                     owner.json の heartbeat を現在時刻に更新する
#   reconcile                     claimed / dispatched の突き合わせ
#   ensure-labels                 dispatch/* ラベルを確認し不足分を作成する
#   fetch --limit <N> --batch <N> [--labels a,b] [--assignee @me|none]
#         [--state open|all] [--dry-run]
#   mark-dispatched --issue <n>
#   release --issue <n>
#   finalize --issue <n> --status <done|error|timeout> [--pr-url <url>] [--message <s>]
#
# Exit codes:
#   0 正常 (fetch の 0 件は「候補が尽きた」ことが確認できた場合のみ)
#   1 致命的失敗 (gh/jq 不在、認証エラー、state 破損、ロック取得失敗、owner 不一致)
#   3 fetch で候補は存在したが claim が 1 件も成立しなかった
#   4 fetch で取得窓を上限まで広げても候補が尽きたと確認できなかった
#
# Output: fetch のみタスク JSON 配列を stdout へ。reconcile は判定 JSON。他は無出力
# Debug:  stderr にログ

set -euo pipefail

die() { echo "Error: $1" >&2; exit 1; }
log() { echo "[$1] $2" >&2; }

MAX_WINDOW=1000

STATE_FILE=""
SUBCOMMAND=""
LEASE_MIN=30
LIMIT=0
BATCH=0
LABELS=""
ASSIGNEE=""
ISSUE_STATE="open"
DRY_RUN=0
ISSUE_NUM=""
FINAL_STATUS=""
PR_URL=""
MESSAGE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --state-file) [[ $# -lt 2 ]] && die "--state-file requires a path"; STATE_FILE="$2"; shift 2 ;;
    --lease-min)  [[ $# -lt 2 ]] && die "--lease-min requires a number"; LEASE_MIN="$2"; shift 2 ;;
    --limit)      [[ $# -lt 2 ]] && die "--limit requires a number"; LIMIT="$2"; shift 2 ;;
    --batch)      [[ $# -lt 2 ]] && die "--batch requires a number"; BATCH="$2"; shift 2 ;;
    --labels)     [[ $# -lt 2 ]] && die "--labels requires a value"; LABELS="$2"; shift 2 ;;
    --assignee)   [[ $# -lt 2 ]] && die "--assignee requires a value"; ASSIGNEE="$2"; shift 2 ;;
    --state)      [[ $# -lt 2 ]] && die "--state requires a value"; ISSUE_STATE="$2"; shift 2 ;;
    --issue)      [[ $# -lt 2 ]] && die "--issue requires a number"; ISSUE_NUM="$2"; shift 2 ;;
    --status)     [[ $# -lt 2 ]] && die "--status requires a value"; FINAL_STATUS="$2"; shift 2 ;;
    --pr-url)     [[ $# -lt 2 ]] && die "--pr-url requires a value"; PR_URL="$2"; shift 2 ;;
    --message)    [[ $# -lt 2 ]] && die "--message requires a value"; MESSAGE="$2"; shift 2 ;;
    --dry-run)    DRY_RUN=1; shift ;;
    -*)           die "unknown option: $1" ;;
    *)            [[ -z "$SUBCOMMAND" ]] && SUBCOMMAND="$1" || die "unexpected argument: $1"; shift ;;
  esac
done

[[ -n "$STATE_FILE" ]] || die "--state-file is required"
[[ -n "$SUBCOMMAND" ]] || die "a subcommand is required (see the usage comment)"
command -v jq >/dev/null 2>&1 || die "jq is not installed"

# 親ディレクトリがまだ存在しなくても絶対パスに解決する。初回ループでは
# .dispatch-loop/ が無いため、cd で解決しようとすると lock-check すら失敗する。
abs_dir() {
  local d="$1"
  case "$d" in
    /*) printf '%s' "$d" ;;
    *)  printf '%s/%s' "$(pwd)" "$d" ;;
  esac
}
LOOP_DIR="$(abs_dir "$(dirname "$STATE_FILE")")"
LOCK_DIR="$LOOP_DIR/loop.lock.d"
OWNER_FILE="$LOCK_DIR/owner.json"
# 共通の "unknown" にすると、session id を持たない別プロセスを同一 owner と誤認する。
# 最終手段では PID と時刻から一意な値を作る。
SESSION_ID="${LOOP_SESSION_ID:-${CLAUDE_CODE_SESSION_ID:-anon-$$-$(date -u +%s)}}"
HOST="$(hostname -s 2>/dev/null || echo unknown)"

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# ISO8601 を epoch 秒に変換する (macOS の date と GNU date の両対応)
iso_to_epoch() {
  local iso="$1"
  date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$iso" +%s 2>/dev/null \
    || date -u -d "$iso" +%s 2>/dev/null \
    || echo 0
}

# ロックが生きているか (0 = 生きている / takeover してはいけない)
# owner.json がまだ無い状態は「mkdir に勝った直後の書き込み途中」の可能性があるため、
# stale ではなく in-flight として扱う。ここを stale にすると、mkdir で勝ったプロセスが
# owner.json を書き終える前に別プロセスが rename で奪えてしまう。
LOCK_INFLIGHT_GRACE_SEC=60
lock_is_live() {
  [[ -d "$LOCK_DIR" ]] || return 1
  if [[ ! -f "$OWNER_FILE" ]]; then
    # ディレクトリの作成直後なら in-flight。十分古ければ書き込み失敗の残骸とみなす
    local dir_age
    dir_age=$(( $(date -u +%s) - $(dir_mtime_epoch "$LOCK_DIR") ))
    (( dir_age <= LOCK_INFLIGHT_GRACE_SEC ))
    return
  fi
  local hb age
  hb=$(jq -r '.heartbeat // empty' "$OWNER_FILE" 2>/dev/null || echo "")
  [[ -n "$hb" ]] || return 0   # 壊れた owner.json も in-flight 扱いで安全側に倒す
  age=$(( $(date -u +%s) - $(iso_to_epoch "$hb") ))
  (( age <= LEASE_MIN * 60 ))
}

dir_mtime_epoch() {
  stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo 0
}

# owner.json は atomic replace で公開する (部分書き込みを他プロセスに見せない)
write_owner() {
  local tmp
  tmp=$(mktemp "$LOCK_DIR/owner.json.XXXXXX") || die "mktemp failed"
  if jq -n --arg s "$SESSION_ID" --arg h "$HOST" --arg t "$(now_iso)" \
       '{session_id:$s, host:$h, started_at:$t, heartbeat:$t}' > "$tmp"; then
    mv "$tmp" "$OWNER_FILE"
  else
    rm -f "$tmp"; die "failed to write owner.json"
  fi
}

# 自分が owner でなければ何も書かずに終了する
require_owner() {
  [[ -f "$OWNER_FILE" ]] || die "no active loop lock at $LOCK_DIR"
  local o
  o=$(jq -r '.session_id // empty' "$OWNER_FILE" 2>/dev/null || echo "")
  [[ "$o" == "$SESSION_ID" ]] || die "loop lock is owned by '$o', not '$SESSION_ID'"
  # owner 確認と同時に鮮度を更新する
  local tmp
  tmp=$(mktemp "$OWNER_FILE.XXXXXX") || die "mktemp failed"
  if jq --arg t "$(now_iso)" '.heartbeat = $t' "$OWNER_FILE" > "$tmp"; then
    mv "$tmp" "$OWNER_FILE"
  else
    rm -f "$tmp"; log "warn" "heartbeat update failed"
  fi
}

# loop-state.json を atomic に書き換える。引数は jq のフィルタと追加引数。
# 初期化も含めて必ず mktemp + mv を通す (直接 redirect すると部分書き込みが見える)
state_write() {
  local filter="$1"; shift
  local tmp
  if [[ ! -f "$STATE_FILE" ]]; then
    tmp=$(mktemp "$STATE_FILE.XXXXXX") || die "mktemp failed"
    if jq -n '{issues:{}, batches:[], leaked:[]}' > "$tmp"; then mv "$tmp" "$STATE_FILE"
    else rm -f "$tmp"; die "failed to initialize $STATE_FILE"; fi
  fi
  tmp=$(mktemp "$STATE_FILE.XXXXXX") || die "mktemp failed"
  if jq "$@" "$filter" "$STATE_FILE" > "$tmp"; then
    mv "$tmp" "$STATE_FILE"
  else
    rm -f "$tmp"; die "failed to update $STATE_FILE (broken JSON?)"
  fi
}

# 失敗を呼び出し側で補償したいときに使う非致命版 (成功 0 / 失敗 1)
state_write_soft() {
  local filter="$1"; shift
  local tmp
  [[ -f "$STATE_FILE" ]] || { state_write '.' || return 1; }
  tmp=$(mktemp "$STATE_FILE.XXXXXX") || return 1
  if jq "$@" "$filter" "$STATE_FILE" > "$tmp"; then mv "$tmp" "$STATE_FILE"; return 0
  else rm -f "$tmp"; return 1; fi
}

# ラベルだけが残って追跡できなくなった issue を記録する。ループは止めないが、
# Step L3 のサマリで人に提示して手動で外してもらう
record_orphan() {
  local num="$1" reason="$2"
  log "warn" "issue #$num: $reason"
  state_write_soft '.leaked += [$r]' --arg r "issue #$num: $reason" || true
}

case "$SUBCOMMAND" in
  lock-check)
    # Step L0 は read-only probe。ディレクトリを作らない
    if lock_is_live; then
      log "lock" "an issue loop is already running"
      exit 1
    fi
    exit 0
    ;;

  lock-acquire)
    (( LEASE_MIN >= 10 )) || die "--lease-min must be at least 10"
    mkdir -p "$LOOP_DIR"
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      write_owner
      log "lock" "acquired ($SESSION_ID)"
      exit 0
    fi
    # 既存ロックがある。自分のものなら再取得扱い
    if [[ -f "$OWNER_FILE" ]] && [[ "$(jq -r '.session_id // empty' "$OWNER_FILE")" == "$SESSION_ID" ]]; then
      log "lock" "already owned by this session"
      exit 0
    fi
    if lock_is_live; then
      log "lock" "another loop is running; refusing to start"
      exit 1
    fi
    # stale: owner.json を上書きすると 2 プロセスが同時に owner になれる。
    # ディレクトリ自体の atomic rename に成功した 1 つだけが新しいロックを作る。
    STALE_DIR="$LOOP_DIR/loop.lock.stale.$(date -u +%Y%m%dT%H%M%SZ).$SESSION_ID"
    if mv "$LOCK_DIR" "$STALE_DIR" 2>/dev/null; then
      if mkdir "$LOCK_DIR" 2>/dev/null; then
        write_owner
        log "lock" "took over a stale lock (previous moved to $STALE_DIR)"
        exit 0
      fi
    fi
    log "lock" "lost the race to take over a stale lock"
    exit 1
    ;;

  lock-release)
    if [[ ! -d "$LOCK_DIR" ]]; then
      exit 0
    fi
    # owner.json が無いロックは「他プロセスが取得中」の可能性がある。消してはいけない
    if [[ ! -f "$OWNER_FILE" ]]; then
      log "warn" "lock has no owner.json (another process may be acquiring it); not releasing"
      exit 1
    fi
    o=$(jq -r '.session_id // empty' "$OWNER_FILE" 2>/dev/null || echo "")
    if [[ "$o" != "$SESSION_ID" ]]; then
      log "warn" "lock is owned by '$o'; not releasing"
      exit 1
    fi
    rm -rf "$LOCK_DIR"
    log "lock" "released"
    exit 0
    ;;

  heartbeat)
    require_owner
    exit 0
    ;;

  *)
    die "unknown subcommand: $SUBCOMMAND"
    ;;
esac
```

`chmod +x` は不要（既存スクリプトも `bash <path>` で起動される）。

- [ ] **Step 4: テストが通ることを確認する**

Run: `bash apps/cmux-team-dispatch-task/test/test-issue-fetch.sh`
Expected: L1〜L7 がすべて PASS し `--- all tests passed ---`

Run: `bash -n apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/issue-fetch.sh`
Expected: 無出力

- [ ] **Step 5: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/issue-fetch.sh \
        apps/cmux-team-dispatch-task/test/test-issue-fetch.sh
git commit -m "feat(cmux-team-dispatch-task): issue-fetch.sh にループ用ロックと状態書き込み基盤を実装"
```

---

### Task 6: `issue-fetch.sh` の fetch / claim / exhaustion 判定

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/issue-fetch.sh`
- Modify: `apps/cmux-team-dispatch-task/test/test-issue-fetch.sh`

**Interfaces:**
- Consumes: Task 5 の `require_owner` / `state_write` / `LOOP_DIR`
- Produces: `issue-fetch.sh --state-file <p> fetch --limit N --batch N [...]` → タスク JSON 配列を stdout。exit 0 / 3 / 4。

**背景（spec §3.6）:** dispatch ラベル 3 種をサーバサイドの negative search qualifier で除外し、未割当は `--search "no:assignee"` を使う（`--assignee none` という値は存在しない）。窓は `min(LIMIT*2, 1000)` から始めて `min(FETCH_LIMIT*2, 1000)` で拡張し、返却件数が窓未満になるまで続ける。1000 でも満杯なら exit 4。

- [ ] **Step 1: 失敗するテストを追加する**

`test-issue-fetch.sh` の `SID=sess-c run lock-release` の直前に追加:

```bash
# --- gh スタブ: 呼ばれた引数を gh.log に残し、GH_FIXTURE の中身を返す ---
cat > "$TMP/bin/gh" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$GH_LOG"
case "$1 $2" in
  "issue list") cat "$GH_FIXTURE" ;;
  "issue edit") exit "${GH_EDIT_EXIT:-0}" ;;
  "label list") echo '[]' ;;
  "label create") exit 0 ;;
  *) exit 0 ;;
esac
STUB
chmod +x "$TMP/bin/gh"
export GH_LOG="$TMP/gh.log" GH_FIXTURE="$TMP/fixture.json"

SID=sess-c run lock-release || true
SID=sess-d run lock-acquire --lease-min 30
echo '{"issues":{},"batches":[],"leaked":[]}' > "$STATE"

# --- F1: 通常取得 ---
: > "$GH_LOG"
cat > "$GH_FIXTURE" <<'JSON'
[{"number":12,"title":"Fix login redirect","body":"b","url":"https://x/12","labels":[]}]
JSON
out=$(SID=sess-d run fetch --limit 2 --batch 1)
check '[[ $(jq -r ".[0].number" <<<"$out") == 12 ]]' 'F1 候補を 1 件返す'
check '[[ $(jq -r ".[0].slug" <<<"$out") == "issue-12-fix-login-redirect" ]]' 'F1 slug を生成する'
check 'grep -q -- "-label:dispatch/in-progress" "$GH_LOG"' 'F1 dispatch ラベルの negative qualifier を送る'
check 'grep -q -- "-label:dispatch/done" "$GH_LOG"' 'F1 dispatch/done も除外する'
check '! grep -q -- "no:assignee" "$GH_LOG"' 'F1 assignee 未指定では no:assignee を付けない'
check '[[ $(jq -r ".issues[\"12\"].status" "$STATE") == "claimed" ]]' 'F1 claim 済みとして記録する'

# --- F2: assignee none は --assignee ではなく no:assignee ---
: > "$GH_LOG"
echo '[]' > "$GH_FIXTURE"
SID=sess-d run fetch --limit 2 --batch 2 --assignee none >/dev/null
check 'grep -q -- "no:assignee" "$GH_LOG"' 'F2 未割当は no:assignee で表現する'
check '! grep -q -- "--assignee none" "$GH_LOG"' 'F2 --assignee none を渡さない'

# --- F3: 候補ゼロは exit 0 + [] ---
: > "$GH_LOG"
echo '[]' > "$GH_FIXTURE"
out=$(SID=sess-d run fetch --limit 2 --batch 3)
check '[[ "$out" == "[]" ]]' 'F3 候補ゼロは空配列'

# --- F4: claim 全滅は exit 3 ---
: > "$GH_LOG"
cat > "$GH_FIXTURE" <<'JSON'
[{"number":21,"title":"t","body":"b","url":"https://x/21","labels":[]}]
JSON
set +e
GH_EDIT_EXIT=1 SID=sess-d run fetch --limit 2 --batch 4 >/dev/null 2>&1
rc=$?
set -e
check '[[ $rc -eq 3 ]]' 'F4 claim 全滅は exit 3'

# --- F5: 窓が満杯のまま上限に達したら exit 4、最後の --limit は 1000 ---
: > "$GH_LOG"
# ローカル state に登録済みの issue だけを 1000 件返すフィクスチャ
jq -n '[range(1;1001) | {number:., title:"t", body:"b", url:"https://x", labels:[]}]' > "$GH_FIXTURE"
jq -n '[range(1;1001)] | {issues: (map({(tostring): {slug:"s", status:"done", batch:0}}) | add),
        batches: [], leaked: []}' > "$STATE"
set +e
SID=sess-d run fetch --limit 2 --batch 5 >/dev/null 2>&1
rc=$?
set -e
check '[[ $rc -eq 4 ]]' 'F5 上限まで満杯なら exit 4'
check '[[ $(grep -c -- "--limit 1000" "$GH_LOG") -ge 1 ]]' 'F5 上限 1000 を一度は問い合わせる'
check '! grep -qE -- "--limit (1[0-9]{3,}|[2-9][0-9]{3,})" "$GH_LOG"' 'F5 --limit は 1000 を超えない'

# --- F6: 先頭窓は全除外だが、拡張後の窓に候補がある ---
# 窓サイズごとに違う結果を返すスタブに差し替える
cat > "$TMP/bin/gh" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$GH_LOG"
case "$1 $2" in
  "issue list")
    lim=""
    while [[ $# -gt 0 ]]; do [[ "$1" == "--limit" ]] && { lim="$2"; break; }; shift; done
    if [[ "$lim" -le 4 ]]; then
      # 窓 4: すべて state 登録済みの 1..4
      jq -n '[range(1;5) | {number:., title:"t", body:"b", url:"https://x", labels:[]}]'
    else
      # 窓 8: 5 件目以降に未処理の 7 が現れる
      jq -n '[range(1;8) | {number:., title:"t", body:"b", url:"https://x", labels:[]}]'
    fi ;;
  "issue edit") exit "${GH_EDIT_EXIT:-0}" ;;
  "label list") echo '[]' ;;
  *) exit 0 ;;
esac
STUB
chmod +x "$TMP/bin/gh"
: > "$GH_LOG"
jq -n '[range(1;5)] | {issues: (map({(tostring): {slug:"s", status:"done", batch:0}}) | add),
        batches: [], leaked: []}' > "$STATE"
out=$(SID=sess-d run fetch --limit 2 --batch 6)
check '[[ $(jq -r ".[0].number" <<<"$out") == 7 ]]' 'F6 窓を広げて次窓の候補を拾う'
check 'grep -q -- "--limit 8" "$GH_LOG"' 'F6 窓が倍化される'

echo '{"issues":{},"batches":[],"leaked":[]}' > "$STATE"
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `bash apps/cmux-team-dispatch-task/test/test-issue-fetch.sh`
Expected: `Error: unknown subcommand: fetch`

- [ ] **Step 3: 実装する**

`issue-fetch.sh` の `case "$SUBCOMMAND" in` に `fetch)` ブロックを追加する（`heartbeat)` の直後、`*)` の直前）。あわせて `now_iso()` の下にヘルパーを追加する:

```bash
# issue タイトルから workspace 名として安全な slug を作る (最大 30 文字)
make_slug() {
  local num="$1" title="$2" body
  body=$(printf '%s' "$title" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -e 's/[^a-z0-9]\{1,\}/-/g' -e 's/^-//' -e 's/-$//')
  printf 'issue-%s-%s' "$num" "$body" | cut -c1-30 | sed -e 's/-$//'
}
```

```bash
  fetch)
    require_owner
    command -v gh >/dev/null 2>&1 || die "gh is not installed"
    (( LIMIT > 0 )) || die "--limit must be a positive number"
    (( BATCH > 0 )) || die "--batch must be a positive number"

    # dispatch ラベルはサーバ側で除外する。ローカル除外だけだと、先頭の窓が
    # すべて処理済みで埋まったときに「対象なし」と誤判定する。
    SEARCH="-label:dispatch/in-progress -label:dispatch/done -label:dispatch/failed"
    GH_ASSIGNEE_FLAGS=()
    case "$ASSIGNEE" in
      "")     ;;
      "@me")  GH_ASSIGNEE_FLAGS=(--assignee "@me") ;;
      "none") SEARCH="$SEARCH no:assignee" ;;      # gh に --assignee none という値は無い
      *)      GH_ASSIGNEE_FLAGS=(--assignee "$ASSIGNEE") ;;
    esac
    GH_LABEL_FLAGS=()
    [[ -n "$LABELS" ]] && GH_LABEL_FLAGS=(--label "$LABELS")

    WINDOW=$(( LIMIT * 2 ))
    (( WINDOW > MAX_WINDOW )) && WINDOW=$MAX_WINDOW
    CANDIDATES="[]"
    EXHAUSTION_KNOWN=0
    while :; do
      RAW=$(gh issue list --state "$ISSUE_STATE" \
        ${GH_LABEL_FLAGS[@]+"${GH_LABEL_FLAGS[@]}"} \
        ${GH_ASSIGNEE_FLAGS[@]+"${GH_ASSIGNEE_FLAGS[@]}"} \
        --search "$SEARCH" --limit "$WINDOW" \
        --json number,title,body,url,labels) || die "gh issue list failed"
      RETURNED=$(jq 'length' <<<"$RAW")
      # ローカル除外: 既に state に登録済みの番号 (ラベル反映遅延と release 失敗の保険)
      # 候補の番号を先に束縛する。$st[0] へパイプすると . が state object に変わるため、
      # そこで .number を参照すると常に null になり、除外が一切効かなくなる
      CANDIDATES=$(jq --slurpfile st <(jq '.issues // {}' "$STATE_FILE") \
        '[ .[] | (.number | tostring) as $n | select( ($st[0] | has($n)) | not ) ]' <<<"$RAW")
      COUNT=$(jq 'length' <<<"$CANDIDATES")
      if (( RETURNED < WINDOW )); then EXHAUSTION_KNOWN=1; break; fi   # サーバ側の候補が尽きた
      if (( COUNT > 0 )); then EXHAUSTION_KNOWN=1; break; fi           # claim 対象が見つかった
      if (( WINDOW >= MAX_WINDOW )); then break; fi                    # 上限まで満杯 = 不明
      WINDOW=$(( WINDOW * 2 ))
      (( WINDOW > MAX_WINDOW )) && WINDOW=$MAX_WINDOW
      log "fetch" "window全除外につき拡張: --limit $WINDOW"
    done

    if (( EXHAUSTION_KNOWN == 0 )); then
      log "warn" "取得窓を上限 $MAX_WINDOW まで広げても候補が尽きたと確認できませんでした"
      exit 4
    fi
    if [[ "$(jq 'length' <<<"$CANDIDATES")" == "0" ]]; then
      echo '[]'
      exit 0
    fi

    if (( DRY_RUN == 1 )); then
      jq --argjson lim "$LIMIT" '.[0:$lim]' <<<"$CANDIDATES"
      exit 0
    fi

    # claim: ラベル付与に成功した issue だけをバッチに入れる。付与に失敗したものを
    # 起動すると次のバッチで再取得され、同じ issue を無限に拾い続ける。
    TASKS="[]"
    CLAIMED_NUMS=""
    IDX=0
    TOTAL=$(jq 'length' <<<"$CANDIDATES")
    while (( IDX < TOTAL )); do
      [[ "$(jq 'length' <<<"$TASKS")" -ge "$LIMIT" ]] && break
      NUM=$(jq -r ".[$IDX].number" <<<"$CANDIDATES")
      TITLE=$(jq -r ".[$IDX].title" <<<"$CANDIDATES")
      IDX=$(( IDX + 1 ))
      if ! gh issue edit "$NUM" --add-label dispatch/in-progress >/dev/null 2>&1; then
        log "warn" "issue #$NUM の claim に失敗したためこのバッチから除外します"
        continue
      fi
      SLUG=$(make_slug "$NUM" "$TITLE")
      # ラベルは付いたのに state を書けなかった場合、その issue は
      # サーバサイドの negative qualifier で永久に除外され、ローカルに追跡記録も
      # 残らない = 二度と拾えなくなる。書けなければラベルを補償的に外す。
      if ! state_write_soft '.issues[$k] = {slug:$s, status:"claimed", batch:$b, claimed_at:$t}' \
             --arg k "$NUM" --arg s "$SLUG" --argjson b "$BATCH" --arg t "$(now_iso)"; then
        gh issue edit "$NUM" --remove-label dispatch/in-progress >/dev/null 2>&1 \
          || record_orphan "$NUM" "state 書き込み失敗後のラベル除去にも失敗しました"
        log "warn" "issue #$NUM の state 記録に失敗したため claim を取り消しました"
        continue
      fi
      TASKS=$(jq --argjson n "$NUM" --arg s "$SLUG" --argjson src "$CANDIDATES" --argjson i "$((IDX-1))" \
        '. + [{number:$n, slug:$s, title:$src[$i].title, url:$src[$i].url, body:$src[$i].body}]' <<<"$TASKS")
      CLAIMED_NUMS="$CLAIMED_NUMS $NUM"
      log "claim" "issue #$NUM -> $SLUG"
    done

    if [[ "$(jq 'length' <<<"$TASKS")" == "0" ]]; then
      log "warn" "候補はありましたが claim が 1 件も成立しませんでした"
      exit 3
    fi
    state_write '.batches += [{n:$b, issues:$nums, started_at:$t}]' \
      --argjson b "$BATCH" --argjson nums "$(jq '[.[].number]' <<<"$TASKS")" --arg t "$(now_iso)"
    echo "$TASKS"
    exit 0
    ;;
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `bash apps/cmux-team-dispatch-task/test/test-issue-fetch.sh`
Expected: F1〜F5 がすべて PASS

- [ ] **Step 5: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/issue-fetch.sh \
        apps/cmux-team-dispatch-task/test/test-issue-fetch.sh
git commit -m "feat(cmux-team-dispatch-task): issue-fetch.sh に issue 取得・claim・exhaustion 判定を実装"
```

---

### Task 7: `issue-fetch.sh` の状態遷移サブコマンド

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/issue-fetch.sh`
- Modify: `apps/cmux-team-dispatch-task/test/test-issue-fetch.sh`

**Interfaces:**
- Consumes: Task 6 の state スキーマ
- Produces:
  - `mark-dispatched --issue <n>` → `status: claimed` → `dispatched`
  - `release --issue <n>` → ラベル除去 + レコード削除
  - `reconcile` → stdout に `{"action":"ok"|"abort","reasons":[...]}`
  - `ensure-labels` → 3 ラベルを確認し不足分を作成（失敗は exit 1）
  - `finalize --issue <n> --status <s>` → 最終結果を記録

- [ ] **Step 1: 失敗するテストを追加する**

`test-issue-fetch.sh` の末尾（`[[ $fail -eq 0 ]]` の直前）に追加:

```bash
# --- S1: mark-dispatched ---
jq -n '{issues:{"12":{slug:"issue-12-x",status:"claimed",batch:1,claimed_at:"2026-01-01T00:00:00Z"}},
        batches:[{n:1,issues:[12],started_at:"2026-01-01T00:00:00Z"}], leaked:[]}' > "$STATE"
SID=sess-d run mark-dispatched --issue 12
check '[[ $(jq -r ".issues[\"12\"].status" "$STATE") == "dispatched" ]]' 'S1 mark-dispatched が status を進める'

# --- S2: release はレコードを消しラベルを外す ---
: > "$GH_LOG"
SID=sess-d run release --issue 12
check '[[ $(jq -r ".issues | has(\"12\")" "$STATE") == "false" ]]' 'S2 release がレコードを削除する'
check 'grep -q -- "--remove-label dispatch/in-progress" "$GH_LOG"' 'S2 release がラベルを外す'

# --- S3: reconcile は dispatched があれば abort ---
jq -n '{issues:{"13":{slug:"s",status:"dispatched",batch:1}},batches:[],leaked:[]}' > "$STATE"
out=$(SID=sess-d run reconcile)
check '[[ $(jq -r ".action" <<<"$out") == "abort" ]]' 'S3 dispatched が残っていれば abort'

# --- S4: reconcile は workspace 消滅済みの claimed を release する ---
jq -n '{issues:{"14":{slug:"gone",status:"claimed",batch:1}},batches:[],leaked:[]}' > "$STATE"
out=$(DISPATCH_DIR="$TMP/repo/.dispatch" SID=sess-d run reconcile)
check '[[ $(jq -r ".action" <<<"$out") == "ok" ]]' 'S4 消滅済み claimed は ok'
check '[[ $(jq -r ".issues | has(\"14\")" "$STATE") == "false" ]]' 'S4 消滅済み claimed を release する'

# --- S5: ensure-labels は不足分を作る ---
: > "$GH_LOG"
SID=sess-d run ensure-labels
check '[[ $(grep -c -- "label create" "$GH_LOG") -eq 3 ]]' 'S5 3 ラベルを作成する'

# --- S6: finalize ---
jq -n '{issues:{"15":{slug:"s",status:"dispatched",batch:1}},batches:[],leaked:[]}' > "$STATE"
SID=sess-d run finalize --issue 15 --status done --pr-url https://x/pr/1
check '[[ $(jq -r ".issues[\"15\"].status" "$STATE") == "done" ]]' 'S6 finalize が status を書く'
check '[[ $(jq -r ".issues[\"15\"].pr_url" "$STATE") == "https://x/pr/1" ]]' 'S6 finalize が pr_url を書く'
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `bash apps/cmux-team-dispatch-task/test/test-issue-fetch.sh`
Expected: `Error: unknown subcommand: mark-dispatched`

- [ ] **Step 3: 実装する**

`issue-fetch.sh` の `fetch)` ブロックの直後に追加する。冒頭の変数定義に `DISPATCH_DIR` を足す（`HOST=` の直後）:

```bash
# タスクの STATUS_DIR は従来どおり .dispatch/<slug>。テストから差し替えられるようにする
DISPATCH_DIR="${DISPATCH_DIR:-$(dirname "$LOOP_DIR")/.dispatch}"
```

```bash
  mark-dispatched)
    require_owner
    [[ -n "$ISSUE_NUM" ]] || die "--issue is required"
    state_write '.issues[$k].status = "dispatched" | .issues[$k].dispatched_at = $t' \
      --arg k "$ISSUE_NUM" --arg t "$(now_iso)"
    exit 0
    ;;

  release)
    require_owner
    [[ -n "$ISSUE_NUM" ]] || die "--issue is required"
    # 順序が重要: ラベルを外せていないのに state から消すと、サーバ側では
    # dispatch/in-progress のまま除外され続け、ローカルの追跡記録も消えて
    # その issue は二度と拾えなくなる。外せるまで record は消さない。
    if command -v gh >/dev/null 2>&1; then
      if ! gh issue edit "$ISSUE_NUM" --remove-label dispatch/in-progress >/dev/null 2>&1; then
        log "warn" "issue #$ISSUE_NUM のラベル除去に失敗したため state は保持します"
        exit 1
      fi
    fi
    state_write 'del(.issues[$k])' --arg k "$ISSUE_NUM"
    log "release" "issue #$ISSUE_NUM を解放しました"
    exit 0
    ;;

  reconcile)
    require_owner
    [[ -f "$STATE_FILE" ]] || { jq -n '{action:"ok", reasons:[]}'; exit 0; }
    REASONS="[]"
    ACTION="ok"
    # dispatched が残っている = 前回のループが走行中に中断した。自動再開はしない
    for n in $(jq -r '.issues | to_entries[] | select(.value.status == "dispatched") | .key' "$STATE_FILE"); do
      ACTION="abort"
      REASONS=$(jq --arg r "issue #$n は dispatched のままです (前回のループが中断した可能性)" \
        '. + [$r]' <<<"$REASONS")
    done
    # claimed は workspace の生存で判定する
    for n in $(jq -r '.issues | to_entries[] | select(.value.status == "claimed") | .key' "$STATE_FILE"); do
      slug=$(jq -r --arg k "$n" '.issues[$k].slug' "$STATE_FILE")
      if [[ -f "$DISPATCH_DIR/$slug/status.json" ]]; then
        ACTION="abort"
        REASONS=$(jq --arg r "issue #$n ($slug) の workspace が生存しています" '. + [$r]' <<<"$REASONS")
      else
        # release と同じ順序規則: ラベルを外せない限り record は消さない
        if command -v gh >/dev/null 2>&1 \
           && ! gh issue edit "$n" --remove-label dispatch/in-progress >/dev/null 2>&1; then
          ACTION="abort"
          REASONS=$(jq --arg r "issue #$n ($slug) のラベル除去に失敗しました (手動で外してください)" \
            '. + [$r]' <<<"$REASONS")
        else
          state_write 'del(.issues[$k])' --arg k "$n"
          REASONS=$(jq --arg r "issue #$n ($slug) を release しました" '. + [$r]' <<<"$REASONS")
        fi
      fi
    done
    jq -n --arg a "$ACTION" --argjson r "$REASONS" '{action:$a, reasons:$r}'
    exit 0
    ;;

  ensure-labels)
    require_owner
    command -v gh >/dev/null 2>&1 || die "gh is not installed"
    EXISTING=$(gh label list --limit 200 --json name 2>/dev/null) \
      || die "gh label list failed (認証・権限・通信を確認してください)"
    for lbl in dispatch/in-progress dispatch/done dispatch/failed; do
      if [[ "$(jq -r --arg n "$lbl" '[.[] | select(.name == $n)] | length' <<<"$EXISTING")" == "0" ]]; then
        # || true では潰さない: 「既に存在」と認証・権限エラーを区別できなくなる
        gh label create "$lbl" --description "cmux-team-dispatch-task issue loop" \
          >/dev/null 2>&1 || die "ラベル '$lbl' の作成に失敗しました"
        log "label" "created $lbl"
      fi
    done
    exit 0
    ;;

  finalize)
    require_owner
    [[ -n "$ISSUE_NUM" ]] || die "--issue is required"
    [[ -n "$FINAL_STATUS" ]] || die "--status is required"
    state_write '.issues[$k].status = $s
                 | (if $pr == "" then . else .issues[$k].pr_url = $pr end)
                 | (if $m  == "" then . else .issues[$k].message = $m end)' \
      --arg k "$ISSUE_NUM" --arg s "$FINAL_STATUS" --arg pr "$PR_URL" --arg m "$MESSAGE"
    exit 0
    ;;
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `bash apps/cmux-team-dispatch-task/test/test-issue-fetch.sh`
Expected: S1〜S6 を含め全 PASS

- [ ] **Step 5: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/issue-fetch.sh \
        apps/cmux-team-dispatch-task/test/test-issue-fetch.sh
git commit -m "feat(cmux-team-dispatch-task): issue-fetch.sh に状態遷移サブコマンド群を実装"
```

---

### Task 8: `batch-wait.sh`

**Files:**
- Create: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/batch-wait.sh`
- Test: `apps/cmux-team-dispatch-task/test/test-batch-wait.sh`（新規）

**Interfaces:**
- Consumes: Task 5〜7 の `loop-state.json` スキーマ、Task 2 の `--timeout-sentinel`
- Produces: `batch-wait.sh --state-file <p> --batch <N> --timeout-min <T> [--max-wait-sec 540]`。stdout は `ALL_TERMINAL <done>/<error>/<timeout>` または `WAITING <terminal>/<total> [timed-out:<n>]` の 1 行。

**背景（spec §3.7）:** 出力は 2 種類のみ。timeout の terminal 化はこのスクリプト自身が行い、sentinel は `.dispatch-loop/timed-out/<slug>` に置く（タスクディレクトリと一緒に消えないため late write を確実に封じられる）。全 slug が terminal になるまで `ALL_TERMINAL` を返さない。

- [ ] **Step 1: 失敗するテストを書く**

Create `apps/cmux-team-dispatch-task/test/test-batch-wait.sh`:

```bash
#!/usr/bin/env bash
# batch-wait.sh がバッチの全 slug が terminal になるまで待つこと、
# deadline 超過を自分で terminal 化すること、sentinel を外部に置くことの検査。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WAIT="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/batch-wait.sh"
FETCH="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/issue-fetch.sh"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
LOOP="$TMP/repo/.dispatch-loop"
DISP="$TMP/repo/.dispatch"
mkdir -p "$LOOP" "$DISP/slug-a" "$DISP/slug-b"
STATE="$LOOP/loop-state.json"

fail=0
ok()   { echo "PASS: $1"; }
bad()  { echo "FAIL: $1"; fail=1; }
check(){ if eval "$1"; then ok "$2"; else bad "$2"; fi; }

export LOOP_SESSION_ID=sess-w
bash "$FETCH" --state-file "$STATE" lock-acquire --lease-min 30 >/dev/null 2>&1

# slug-a は期限前で実行中、slug-b は claim 時刻が古く deadline 超過
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
jq -n --arg now "$NOW" '{
  issues: {
    "1": {slug:"slug-a", status:"dispatched", batch:1, claimed_at:$now},
    "2": {slug:"slug-b", status:"dispatched", batch:1, claimed_at:"2000-01-01T00:00:00Z"}
  },
  batches: [{n:1, issues:[1,2], started_at:$now}], leaked: []
}' > "$STATE"
echo '{"status":"executing"}' > "$DISP/slug-a/status.json"
echo '{"status":"executing"}' > "$DISP/slug-b/status.json"

run_wait() {
  DISPATCH_DIR="$DISP" bash "$WAIT" --state-file "$STATE" --batch 1 --timeout-min 60 --max-wait-sec "${1:-3}"
}

# --- W1: 1 件 timeout・1 件実行中 → WAITING（ALL_TERMINAL にしない） ---
out=$(run_wait 3)
check '[[ "$out" == WAITING* ]]' 'W1 timeout 混在では ALL_TERMINAL を返さない'
check '[[ $(jq -r ".issues[\"2\"].status" "$STATE") == "timeout" ]]' 'W1 deadline 超過を timeout にする'
check '[[ $(jq -r ".status" "$DISP/slug-b/status.json") == "error" ]]' 'W1 status.json を error にする'

# --- W2: sentinel はタスクディレクトリの外に作られる ---
check '[[ -f "$LOOP/timed-out/slug-b" ]]' 'W2 sentinel は .dispatch-loop/timed-out 配下'
check '[[ ! -f "$DISP/slug-b/.timed-out" ]]' 'W2 sentinel をタスクディレクトリに置かない'

# --- W3: タスクディレクトリを消しても sentinel は残る（late write 封じの前提） ---
rm -rf "$DISP/slug-b"
check '[[ -f "$LOOP/timed-out/slug-b" ]]' 'W3 タスクディレクトリ削除後も sentinel が残る'

# --- W4: 残りが terminal になれば ALL_TERMINAL ---
echo '{"status":"done"}' > "$DISP/slug-a/status.json"
out=$(run_wait 3)
check '[[ "$out" == ALL_TERMINAL* ]]' 'W4 全件 terminal で ALL_TERMINAL'

# --- W5: heartbeat が更新される ---
OLD=$(jq -r '.heartbeat' "$LOOP/loop.lock.d/owner.json")
sleep 1
run_wait 1 >/dev/null
NEW=$(jq -r '.heartbeat' "$LOOP/loop.lock.d/owner.json")
check '[[ "$OLD" != "$NEW" ]]' 'W5 呼び出しごとに heartbeat が更新される'

bash "$FETCH" --state-file "$STATE" lock-release >/dev/null 2>&1
[[ $fail -eq 0 ]] && echo '--- all tests passed ---' || echo '--- failures ---'
exit "$fail"
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `bash apps/cmux-team-dispatch-task/test/test-batch-wait.sh`
Expected: `No such file or directory`

- [ ] **Step 3: 実装する**

Create `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/batch-wait.sh`:

```bash
#!/usr/bin/env bash
# GitHub issue 自動ループのバッチ完了待ち。
#
# Usage:
#   batch-wait.sh --state-file <path> --batch <N> --timeout-min <N> [--max-wait-sec 540]
#
# 指定バッチで status=dispatched の slug 集合を loop-state.json から引き、
# <dispatch-dir>/<slug>/status.json を 5 秒間隔でポーリングする。
# deadline (claimed_at + timeout-min) を超えた slug は、このスクリプト自身が
#   1. <loop-dir>/timed-out/<slug> sentinel を作成 (runner wrapper の late write を封じる。
#      タスクディレクトリの外なので cleanup で消えない)
#   2. <dispatch-dir>/<slug>/status.json を error に書き換え
#   3. loop-state.json の当該 issue を timeout に更新
# して terminal 化する。書き換えに失敗したら leaked[] に記録して待機から外す。
#
# 出力 (1 行):
#   ALL_TERMINAL <done>/<error>/<timeout>   バッチの全 slug が terminal に到達
#   WAITING <terminal>/<total> [timed-out:<n>]
# 親は ALL_TERMINAL のときだけ待機を抜ける。
#
# Exit: 0 = 上記いずれか / 1 = 致命的失敗

set -euo pipefail

die() { echo "Error: $1" >&2; exit 1; }
log() { echo "[$1] $2" >&2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FETCH="$SCRIPT_DIR/issue-fetch.sh"

STATE_FILE=""
BATCH=""
TIMEOUT_MIN=90
MAX_WAIT_SEC=540

while [[ $# -gt 0 ]]; do
  case "$1" in
    --state-file)   [[ $# -lt 2 ]] && die "--state-file requires a path"; STATE_FILE="$2"; shift 2 ;;
    --batch)        [[ $# -lt 2 ]] && die "--batch requires a number"; BATCH="$2"; shift 2 ;;
    --timeout-min)  [[ $# -lt 2 ]] && die "--timeout-min requires a number"; TIMEOUT_MIN="$2"; shift 2 ;;
    --max-wait-sec) [[ $# -lt 2 ]] && die "--max-wait-sec requires a number"; MAX_WAIT_SEC="$2"; shift 2 ;;
    *) die "unknown option: $1" ;;
  esac
done

[[ -n "$STATE_FILE" ]] || die "--state-file is required"
[[ -n "$BATCH" ]] || die "--batch is required"
command -v jq >/dev/null 2>&1 || die "jq is not installed"

LOOP_DIR="$(cd "$(dirname "$STATE_FILE")" && pwd)"
DISPATCH_DIR="${DISPATCH_DIR:-$(dirname "$LOOP_DIR")/.dispatch}"
SENTINEL_DIR="$LOOP_DIR/timed-out"

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
iso_to_epoch() {
  date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$1" +%s 2>/dev/null \
    || date -u -d "$1" +%s 2>/dev/null || echo 0
}

# owner token 検証 + heartbeat 更新。長時間処理の最中もロックの鮮度を保つ
bash "$FETCH" --state-file "$STATE_FILE" heartbeat || die "loop lock owner check failed"

mkdir -p "$SENTINEL_DIR"

state_write() {
  local filter="$1"; shift
  local tmp
  tmp=$(mktemp "$STATE_FILE.XXXXXX") || die "mktemp failed"
  if jq "$@" "$filter" "$STATE_FILE" > "$tmp"; then mv "$tmp" "$STATE_FILE"
  else rm -f "$tmp"; die "failed to update $STATE_FILE"; fi
}

DEADLINE_EPOCH=$(( $(date -u +%s) + MAX_WAIT_SEC ))

while :; do
  TOTAL=0; TERMINAL=0; N_DONE=0; N_ERROR=0; N_TIMEOUT=0; N_NEW_TIMEOUT=0
  for key in $(jq -r --argjson b "$BATCH" \
      '.issues | to_entries[] | select(.value.batch == $b) | .key' "$STATE_FILE"); do
    st=$(jq -r --arg k "$key" '.issues[$k].status' "$STATE_FILE")
    slug=$(jq -r --arg k "$key" '.issues[$k].slug' "$STATE_FILE")
    case "$st" in
      claimed) continue ;;   # 起動されなかった (release 済み or 起動失敗) ので待機対象外
      done)    TOTAL=$((TOTAL+1)); TERMINAL=$((TERMINAL+1)); N_DONE=$((N_DONE+1)); continue ;;
      error)   TOTAL=$((TOTAL+1)); TERMINAL=$((TERMINAL+1)); N_ERROR=$((N_ERROR+1)); continue ;;
      timeout) TOTAL=$((TOTAL+1)); TERMINAL=$((TERMINAL+1)); N_TIMEOUT=$((N_TIMEOUT+1)); continue ;;
    esac
    TOTAL=$((TOTAL+1))

    task_status=$(jq -r '.status // "unknown"' "$DISPATCH_DIR/$slug/status.json" 2>/dev/null || echo unknown)
    if [[ "$task_status" == "done" || "$task_status" == "error" ]]; then
      pr=$(jq -r '.pr_url // empty' "$DISPATCH_DIR/$slug/status.json" 2>/dev/null || echo "")
      state_write '.issues[$k].status = $s | (if $pr == "" then . else .issues[$k].pr_url = $pr end)' \
        --arg k "$key" --arg s "$task_status" --arg pr "$pr"
      TERMINAL=$((TERMINAL+1))
      [[ "$task_status" == "done" ]] && N_DONE=$((N_DONE+1)) || N_ERROR=$((N_ERROR+1))
      continue
    fi

    claimed_at=$(jq -r --arg k "$key" '.issues[$k].claimed_at // empty' "$STATE_FILE")
    if [[ -n "$claimed_at" ]]; then
      age=$(( $(date -u +%s) - $(iso_to_epoch "$claimed_at") ))
      if (( age > TIMEOUT_MIN * 60 )); then
        # 1) sentinel を先に作る。runner wrapper が後から終了しても status.json を
        #    書かず、cleanup 済みの STATUS_DIR を再生成しない
        if : > "$SENTINEL_DIR/$slug" 2>/dev/null; then
          if jq -n --arg m "timeout after $TIMEOUT_MIN min" \
               '{status:"error", message:$m, timestamp:(now|todate)}' \
               > "$DISPATCH_DIR/$slug/status.json" 2>/dev/null; then
            state_write '.issues[$k].status = "timeout" | .issues[$k].message = $m' \
              --arg k "$key" --arg m "timeout after $TIMEOUT_MIN min"
          else
            # status.json を書けなくても待機からは外す (同じ slug で無限に留まらない)
            state_write '.issues[$k].status = "timeout" | .leaked += [$r]' \
              --arg k "$key" --arg r "slug=$slug status.json の timeout 書き込みに失敗"
          fi
        else
          state_write '.issues[$k].status = "timeout" | .leaked += [$r]' \
            --arg k "$key" --arg r "slug=$slug timeout sentinel の作成に失敗"
        fi
        log "timeout" "$slug が ${TIMEOUT_MIN} 分の上限を超えました"
        TERMINAL=$((TERMINAL+1)); N_TIMEOUT=$((N_TIMEOUT+1)); N_NEW_TIMEOUT=$((N_NEW_TIMEOUT+1))
      fi
    fi
  done

  if (( TERMINAL >= TOTAL )); then
    echo "ALL_TERMINAL $N_DONE/$N_ERROR/$N_TIMEOUT"
    exit 0
  fi
  NOW=$(date -u +%s)
  if (( NOW >= DEADLINE_EPOCH )); then
    if (( N_NEW_TIMEOUT > 0 )); then
      echo "WAITING $TERMINAL/$TOTAL timed-out:$N_NEW_TIMEOUT"
    else
      echo "WAITING $TERMINAL/$TOTAL"
    fi
    exit 0
  fi
  # 残り時間が 5 秒未満なら --max-wait-sec を超えないよう短く眠る
  REMAIN=$(( DEADLINE_EPOCH - NOW ))
  (( REMAIN > 5 )) && REMAIN=5
  sleep "$REMAIN"
done
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `bash apps/cmux-team-dispatch-task/test/test-batch-wait.sh`
Expected: W1〜W5 が PASS

Run: `bash -n apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/batch-wait.sh`
Expected: 無出力

- [ ] **Step 5: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/batch-wait.sh \
        apps/cmux-team-dispatch-task/test/test-batch-wait.sh
git commit -m "feat(cmux-team-dispatch-task): batch-wait.sh を実装しバッチ完了待ちと timeout を確定化"
```

---

### Task 9: `loop-cleanup.sh`

**Files:**
- Create: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/loop-cleanup.sh`
- Test: `apps/cmux-team-dispatch-task/test/test-loop-cleanup.sh`（新規）

**Interfaces:**
- Consumes: Task 5〜8 の `loop-state.json`
- Produces: `loop-cleanup.sh --state-file <p> --batch <N> --integration <pr|merge> [...]`。stdout に `{batch, done, error, timeout, merged, conflicted, unverified, leaked}`。

**背景（spec §3.8）:** runner の `done` は成果の証拠ではないので cleanup 前に独立検証し、落ちたら `error` へ降格する。失敗タスクは worktree 削除前に WIP を保全する（`--no-verify` コミット → `--binary` patch + 未追跡 tar → 検証は基準コミットから作った clean な一時 worktree で）。merge は worktree 削除より前に試す。

- [ ] **Step 1: 失敗するテストを書く**

Create `apps/cmux-team-dispatch-task/test/test-loop-cleanup.sh`:

```bash
#!/usr/bin/env bash
# loop-cleanup.sh の完了検証・WIP 保全・遷移表の検査。cmux / gh はスタブ化する。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLEANUP="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/loop-cleanup.sh"
FETCH="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/issue-fetch.sh"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"
export PATH="$TMP/bin:$PATH"
for c in cmux gh; do
  printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/bin/$c"; chmod +x "$TMP/bin/$c"
done

REPO="$TMP/repo"
mkdir -p "$REPO"
git -C "$REPO" init -q -b main
git -C "$REPO" config user.email t@example.invalid
git -C "$REPO" config user.name t
echo base > "$REPO/base.txt"
git -C "$REPO" add . && git -C "$REPO" commit -qm init

LOOP="$REPO/.dispatch-loop"; DISP="$REPO/.dispatch"
mkdir -p "$LOOP" "$DISP"
STATE="$LOOP/loop-state.json"
export LOOP_SESSION_ID=sess-c
bash "$FETCH" --state-file "$STATE" lock-acquire --lease-min 30 >/dev/null 2>&1

fail=0
ok()   { echo "PASS: $1"; }
bad()  { echo "FAIL: $1"; fail=1; }
check(){ if eval "$1"; then ok "$2"; else bad "$2"; fi; }

make_task() {   # slug, ブランチにコミットを作るか
  local slug="$1" commit="$2"
  git -C "$REPO" worktree add -q "$REPO/.worktrees/$slug" -b "feat/$slug" >/dev/null 2>&1
  mkdir -p "$DISP/$slug"
  if [[ "$commit" == "yes" ]]; then
    echo change > "$REPO/.worktrees/$slug/f.txt"
    git -C "$REPO/.worktrees/$slug" add f.txt
    git -C "$REPO/.worktrees/$slug" commit -qm "work"
  fi
}

run_cleanup() { bash "$CLEANUP" --state-file "$STATE" --batch 1 --integration "$1" --repo-root "$REPO"; }

# --- C1: PR 戦略で PR が確認できない done は error に降格し worktree/branch を残す ---
make_task unverified yes
echo '{"status":"done"}' > "$DISP/unverified/status.json"
jq -n '{issues:{"1":{slug:"unverified",status:"done",batch:1}},batches:[{n:1,issues:[1]}],leaked:[]}' > "$STATE"
out=$(run_cleanup pr)
check '[[ $(jq -r ".unverified" <<<"$out") -ge 1 ]]' 'C1 PR 未確認の done を unverified に数える'
check '[[ $(jq -r ".issues[\"1\"].status" "$STATE") == "error" ]]' 'C1 done を error に降格する'
check 'git -C "$REPO" show-ref --verify -q refs/heads/feat/unverified' 'C1 branch を温存する'

# --- C2: commit が失敗し未追跡ファイルだけが残るケースで内容が保全される ---
# commit だけを確実に失敗させる git ラッパーを PATH の先頭に置く。
# detached HEAD でも git は通常どおり commit できるため、それでは再現できない。
REAL_GIT=$(command -v git)
cat > "$TMP/bin/git" <<STUB
#!/usr/bin/env bash
for a in "\$@"; do
  if [[ "\$a" == "commit" && -n "\${FAIL_GIT_COMMIT:-}" ]]; then
    echo "stubbed commit failure" >&2; exit 1
  fi
done
exec "$REAL_GIT" "\$@"
STUB
chmod +x "$TMP/bin/git"

make_task untracked no
echo brand-new > "$REPO/.worktrees/untracked/new.txt"
echo '{"status":"error"}' > "$DISP/untracked/status.json"
jq -n '{issues:{"2":{slug:"untracked",status:"error",batch:1}},batches:[{n:1,issues:[2]}],leaked:[]}' > "$STATE"
FAIL_GIT_COMMIT=1 run_cleanup pr >/dev/null
check '[[ -f "$DISP/untracked/wip-untracked.tar.gz" ]]' 'C2 未追跡ファイルを tar に保全する'
check 'tar tzf "$DISP/untracked/wip-untracked.tar.gz" | grep -q new.txt' 'C2 tar に内容が入っている'
check '[[ ! -d "$REPO/.worktrees/untracked" ]]' 'C2 保全に成功したら worktree を削除する'

# --- C5: 保全が全滅したら worktree を温存し leaked に記録する ---
make_task unsalvageable no
echo x > "$REPO/.worktrees/unsalvageable/n.txt"
echo '{"status":"error"}' > "$DISP/unsalvageable/status.json"
jq -n '{issues:{"5":{slug:"unsalvageable",status:"error",batch:1}},batches:[{n:1,issues:[5]}],leaked:[]}' > "$STATE"
chmod 500 "$DISP/unsalvageable"          # 成果物を書けなくする
FAIL_GIT_COMMIT=1 run_cleanup pr >/dev/null || true
chmod 700 "$DISP/unsalvageable"
check '[[ -d "$REPO/.worktrees/unsalvageable" ]]' 'C5 保全失敗時は worktree を温存する'
check '[[ $(jq -r ".leaked | length" "$STATE") -ge 1 ]]' 'C5 leaked に記録する'

# --- C6: loop-state の timeout は後着の status.json=done より優先される ---
make_task latewrite yes
echo '{"status":"done","pr_url":"https://x/pr/9"}' > "$DISP/latewrite/status.json"   # 遅れて書かれた done
jq -n '{issues:{"6":{slug:"latewrite",status:"timeout",batch:1}},batches:[{n:1,issues:[6]}],leaked:[]}' > "$STATE"
run_cleanup pr >/dev/null
check '[[ $(jq -r ".issues[\"6\"].status" "$STATE") == "timeout" ]]' 'C6 timeout を done へ戻さない'
check 'git -C "$REPO" show-ref --verify -q refs/heads/feat/latewrite' 'C6 timeout の branch を温存する'

# --- C3: binary の変更が --binary patch で復元検証を通る ---
make_task binfile yes
printf '\x00\x01\x02binary' > "$REPO/.worktrees/binfile/b.bin"
git -C "$REPO/.worktrees/binfile" add b.bin
git -C "$REPO/.worktrees/binfile" commit -qm "add binary"
printf '\x00\x09\x09changed' > "$REPO/.worktrees/binfile/b.bin"
echo '{"status":"error"}' > "$DISP/binfile/status.json"
jq -n '{issues:{"3":{slug:"binfile",status:"error",batch:1}},batches:[{n:1,issues:[3]}],leaked:[]}' > "$STATE"
run_cleanup pr >/dev/null
check '[[ -f "$DISP/binfile/wip.patch" ]] || git -C "$REPO" log -1 --oneline feat/binfile | grep -q wip' \
  'C3 binary 変更が WIP コミットまたは patch として保全される'

# --- C4: merge conflict では worktree・branch とも温存される ---
make_task conflicted yes
echo conflicting > "$REPO/base.txt"
git -C "$REPO" add base.txt && git -C "$REPO" commit -qm "main side"
echo other > "$REPO/.worktrees/conflicted/base.txt"
git -C "$REPO/.worktrees/conflicted" add base.txt
git -C "$REPO/.worktrees/conflicted" commit -qm "branch side"
echo '{"status":"done"}' > "$DISP/conflicted/status.json"
jq -n '{issues:{"4":{slug:"conflicted",status:"done",batch:1}},batches:[{n:1,issues:[4]}],leaked:[]}' > "$STATE"
out=$(run_cleanup merge)
check '[[ $(jq -r ".conflicted" <<<"$out") -ge 1 ]]' 'C4 conflict を数える'
check '[[ -d "$REPO/.worktrees/conflicted" ]]' 'C4 conflict 時は worktree を温存する'
check 'git -C "$REPO" show-ref --verify -q refs/heads/feat/conflicted' 'C4 conflict 時は branch を温存する'

bash "$FETCH" --state-file "$STATE" lock-release >/dev/null 2>&1
[[ $fail -eq 0 ]] && echo '--- all tests passed ---' || echo '--- failures ---'
exit "$fail"
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `bash apps/cmux-team-dispatch-task/test/test-loop-cleanup.sh`
Expected: `No such file or directory`

- [ ] **Step 3: 実装する**

Create `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/loop-cleanup.sh`:

```bash
#!/usr/bin/env bash
# GitHub issue 自動ループのバッチ間 cleanup。
#
# Usage:
#   loop-cleanup.sh --state-file <path> --batch <N> --integration <pr|merge>
#                   [--dispatch-dir <path>] [--repo-root <path>] [--agmsg-team <team>]
#
# 各 slug について、この順で処理する:
#   1. 完了検証 (runner の done を信用せず成果物の存在を確認。落ちたら error に降格)
#   2. prewarm.json の全 surface を close / status.json の workspace を close
#   3. integration=merge かつ検証済み done なら worktree 削除より前に merge を試す
#   4. error/timeout/unverified なら WIP を保全してから worktree を削除
#   5. 遷移表に従い worktree / branch / .dispatch/<slug> を処理
#   6. loop-state.json に最終結果とラベル遷移を反映
#
# 出力: {batch, done, error, timeout, merged, conflicted, unverified, leaked}
# Exit: 0 = 正常 (個別失敗は警告) / 1 = 致命的失敗

set -euo pipefail

die() { echo "Error: $1" >&2; exit 1; }
log() { echo "[$1] $2" >&2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FETCH="$SCRIPT_DIR/issue-fetch.sh"
CMUX="${CMUX_BIN:-/Applications/cmux.app/Contents/Resources/bin/cmux}"
AGMSG_DIR="${AGMSG_DIR:-$HOME/.agents/skills/agmsg/scripts}"

STATE_FILE=""; BATCH=""; INTEGRATION=""; DISPATCH_DIR=""; REPO_ROOT=""; AGMSG_TEAM=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --state-file)   [[ $# -lt 2 ]] && die "--state-file requires a path"; STATE_FILE="$2"; shift 2 ;;
    --batch)        [[ $# -lt 2 ]] && die "--batch requires a number"; BATCH="$2"; shift 2 ;;
    --integration)  [[ $# -lt 2 ]] && die "--integration requires pr or merge"; INTEGRATION="$2"; shift 2 ;;
    --dispatch-dir) [[ $# -lt 2 ]] && die "--dispatch-dir requires a path"; DISPATCH_DIR="$2"; shift 2 ;;
    --repo-root)    [[ $# -lt 2 ]] && die "--repo-root requires a path"; REPO_ROOT="$2"; shift 2 ;;
    --agmsg-team)   [[ $# -lt 2 ]] && die "--agmsg-team requires a team"; AGMSG_TEAM="$2"; shift 2 ;;
    *) die "unknown option: $1" ;;
  esac
done

[[ -n "$STATE_FILE" ]] || die "--state-file is required"
[[ -n "$BATCH" ]] || die "--batch is required"
[[ "$INTEGRATION" == "pr" || "$INTEGRATION" == "merge" ]] || die "--integration must be pr or merge"
command -v jq >/dev/null 2>&1 || die "jq is not installed"

# すべて絶対パスで扱う。git -C <dir> は相対パスを <dir> 基準で解決するため、
# 成果物のパスが相対だと検証用 worktree の内側として解決されて必ず失敗する。
[[ -n "$REPO_ROOT" ]] || REPO_ROOT=$(git rev-parse --show-toplevel) || die "not in a git repository"
REPO_ROOT=$(cd "$REPO_ROOT" && pwd)
LOOP_DIR="$(cd "$(dirname "$STATE_FILE")" && pwd)"
[[ -n "$DISPATCH_DIR" ]] || DISPATCH_DIR="$REPO_ROOT/.dispatch"

bash "$FETCH" --state-file "$STATE_FILE" heartbeat || die "loop lock owner check failed"

N_DONE=0; N_ERROR=0; N_TIMEOUT=0; N_MERGED=0; N_CONFLICTED=0; N_UNVERIFIED=0
LEAKED="[]"

record_leak() { LEAKED=$(jq --arg r "$1" '. + [$r]' <<<"$LEAKED"); log "warn" "$1"; }

BASE_BRANCH=$(git -C "$REPO_ROOT" symbolic-ref --quiet --short HEAD 2>/dev/null || echo main)

# 完了検証: runner の done は TUI が exit 0 で終わっただけなので、成果物を独立に確認する
verify_done() {
  local slug="$1" wt="$REPO_ROOT/.worktrees/$slug"
  local commits
  commits=$(git -C "$REPO_ROOT" rev-list --count "$BASE_BRANCH..feat/$slug" 2>/dev/null || echo 0)
  (( commits > 0 )) || { log "verify" "$slug: コミットがありません"; return 1; }
  if [[ "$INTEGRATION" == "pr" ]]; then
    local pr
    pr=$(jq -r '.pr_url // empty' "$DISPATCH_DIR/$slug/status.json" 2>/dev/null || echo "")
    if [[ -n "$pr" ]] && gh pr view "$pr" --json state >/dev/null 2>&1; then return 0; fi
    if [[ "$(gh pr list --head "feat/$slug" --json url 2>/dev/null | jq 'length' 2>/dev/null || echo 0)" -gt 0 ]]; then
      return 0
    fi
    log "verify" "$slug: PR が確認できません"; return 1
  else
    [[ -d "$wt" ]] || return 0
    [[ -z "$(git -C "$wt" status --porcelain 2>/dev/null)" ]] \
      || { log "verify" "$slug: 未コミットの変更が残っています"; return 1; }
    return 0
  fi
}

# 失敗タスクの成果物を worktree 削除前に保全する。成功で 0
preserve_wip() {
  local slug="$1" wt="$REPO_ROOT/.worktrees/$slug" d="$DISPATCH_DIR/$slug"
  [[ -d "$wt" ]] || return 0
  mkdir -p "$d"
  # 1) WIP コミット: hook と identity 未設定という環境要因を取り除いて試す
  git -C "$wt" add -A >/dev/null 2>&1 || true
  if git -C "$wt" -c user.name="cmux-dispatch" -c user.email="cmux-dispatch@localhost" \
       commit --no-verify -qm "wip: $slug (dispatch failed)" >/dev/null 2>&1; then
    log "wip" "$slug: WIP コミットを作成しました"
    return 0
  fi
  # 2) patch + 未追跡 archive。git diff HEAD は未追跡を含まず --binary 無しでは
  #    binary を復元できないので、両方を明示的に保全する。
  #    ここから先はすべて fail-closed: 生成・検証のどれか 1 つでも失敗したら
  #    非 0 を返し、呼び出し側は worktree を削除しない
  local base tmpwt
  base=$(git -C "$wt" rev-parse HEAD 2>/dev/null) || { record_leak "$slug: HEAD を解決できません"; return 1; }
  git -C "$wt" diff --binary HEAD > "$d/wip.patch" 2>/dev/null \
    || { record_leak "$slug: git diff に失敗しました"; return 1; }
  git -C "$wt" ls-files --others --exclude-standard -z > "$d/wip-untracked.manifest" 2>/dev/null \
    || { record_leak "$slug: 未追跡ファイル一覧の取得に失敗しました"; return 1; }
  if [[ -s "$d/wip-untracked.manifest" ]]; then
    tar czf "$d/wip-untracked.tar.gz" --null -T "$d/wip-untracked.manifest" -C "$wt" 2>/dev/null \
      || { record_leak "$slug: 未追跡ファイルの archive 作成に失敗"; return 1; }
    tar tzf "$d/wip-untracked.tar.gz" >/dev/null 2>&1 \
      || { record_leak "$slug: archive が壊れています"; return 1; }
    # 件数だけでなくエントリ名そのものを NUL-safe に照合する (spec §10 の hardening 項目)
    if ! diff -q \
        <(tr '\0' '\n' < "$d/wip-untracked.manifest" | grep -v '^$' | LC_ALL=C sort) \
        <(tar tzf "$d/wip-untracked.tar.gz" | grep -v '/$' | LC_ALL=C sort) >/dev/null 2>&1; then
      record_leak "$slug: manifest と archive のエントリが一致しません"
      return 1
    fi
  fi
  git -C "$wt" status --porcelain > "$d/wip-status.txt" 2>/dev/null \
    || { record_leak "$slug: status の保存に失敗しました"; return 1; }
  # 3) patch の検証は「基準コミットから作った clean な一時 worktree」で行う。
  #    生成元 (dirty) に当てると既に適用済みで必ず落ちる。
  #    検証用 worktree を作れなかった場合も「検証できていない」ので失敗扱いにする。
  if [[ -s "$d/wip.patch" ]]; then
    tmpwt=$(mktemp -d) || { record_leak "$slug: 検証用ディレクトリを作れません"; return 1; }
    rmdir "$tmpwt"   # git worktree add は存在しないパスを要求する
    local verify_rc=0
    if git -C "$REPO_ROOT" worktree add --detach -q "$tmpwt" "$base" >/dev/null 2>&1; then
      git -C "$tmpwt" apply --check --binary "$d/wip.patch" >/dev/null 2>&1 || verify_rc=1
      git -C "$REPO_ROOT" worktree remove "$tmpwt" --force >/dev/null 2>&1 || true
      git -C "$REPO_ROOT" worktree prune >/dev/null 2>&1 || true
    else
      verify_rc=1
    fi
    rm -rf "$tmpwt"
    if (( verify_rc != 0 )); then
      record_leak "$slug: WIP patch を検証できなかったため worktree を温存します"
      return 1
    fi
  fi
  log "wip" "$slug: patch と未追跡ファイルを $d に保全しました"
  return 0
}

close_panes() {
  local slug="$1" d="$DISPATCH_DIR/$slug"
  if [[ -f "$d/prewarm.json" ]]; then
    for sf in $(jq -r '.[].surface_id // empty' "$d/prewarm.json" 2>/dev/null); do
      "$CMUX" close-surface --surface "$sf" >/dev/null 2>&1 || true
    done
  fi
  local ws
  ws=$(jq -r '.workspace_id // empty' "$d/status.json" 2>/dev/null || echo "")
  [[ -n "$ws" ]] && "$CMUX" close-workspace --workspace "$ws" >/dev/null 2>&1 || true
}

apply_labels() {
  local num="$1" result="$2" closed="$3" slug="$4"
  command -v gh >/dev/null 2>&1 || return 0
  gh issue edit "$num" --remove-label dispatch/in-progress >/dev/null 2>&1 || true
  if [[ "$result" == "done" ]]; then
    gh issue edit "$num" --add-label dispatch/done >/dev/null 2>&1 \
      || log "warn" "issue #$num への dispatch/done 付与に失敗"
    [[ "$closed" == "yes" ]] && { gh issue close "$num" --reason completed >/dev/null 2>&1 || true; }
  else
    gh issue edit "$num" --add-label dispatch/failed >/dev/null 2>&1 \
      || log "warn" "issue #$num への dispatch/failed 付与に失敗"
    gh issue comment "$num" --body "cmux-team-dispatch-task のループでこの issue の処理に失敗しました (結果: $result)。詳細は .dispatch/$slug/ と branch feat/$slug を確認してください。" \
      >/dev/null 2>&1 || true
  fi
}

for key in $(jq -r --argjson b "$BATCH" \
    '.issues | to_entries[] | select(.value.batch == $b) | .key' "$STATE_FILE"); do
  slug=$(jq -r --arg k "$key" '.issues[$k].slug' "$STATE_FILE")
  status=$(jq -r --arg k "$key" '.issues[$k].status' "$STATE_FILE")
  wt="$REPO_ROOT/.worktrees/$slug"
  d="$DISPATCH_DIR/$slug"
  closed="no"

  # loop-state.json の timeout が authoritative。後着の status.json=done で戻さない
  if [[ "$status" == "done" ]]; then
    if verify_done "$slug"; then :; else status="error"; N_UNVERIFIED=$((N_UNVERIFIED+1)); fi
  fi

  close_panes "$slug"

  merged="no"
  if [[ "$status" == "done" && "$INTEGRATION" == "merge" ]]; then
    if git -C "$REPO_ROOT" merge "feat/$slug" --no-edit >/dev/null 2>&1; then
      merged="yes"; closed="yes"; N_MERGED=$((N_MERGED+1))
    else
      git -C "$REPO_ROOT" merge --abort >/dev/null 2>&1 || true
      N_CONFLICTED=$((N_CONFLICTED+1))
      log "merge" "$slug: コンフリクトのため worktree と branch を温存します"
      bash "$FETCH" --state-file "$STATE_FILE" finalize --issue "$key" --status error \
        --message "merge conflict" \
        || die "issue #$key の finalize に失敗しました"
      apply_labels "$key" "error" "no" "$slug"
      N_ERROR=$((N_ERROR+1))
      continue
    fi
  fi

  keep_wt="no"
  if [[ "$status" == "done" ]]; then
    N_DONE=$((N_DONE+1))
  else
    [[ "$status" == "timeout" ]] && N_TIMEOUT=$((N_TIMEOUT+1)) || N_ERROR=$((N_ERROR+1))
    preserve_wip "$slug" || keep_wt="yes"
  fi

  # 破壊的処理の前に state を確定させる。state を更新できないまま worktree や
  # branch を消すと、何が起きたのか追跡できないまま成果物だけが失われる
  pr=$(jq -r '.pr_url // empty' "$d/status.json" 2>/dev/null || echo "")
  if [[ -n "$pr" ]]; then
    bash "$FETCH" --state-file "$STATE_FILE" finalize --issue "$key" --status "$status" --pr-url "$pr" \
      || die "issue #$key の finalize に失敗しました (state を更新できない状態で破壊的処理を続けません)"
  else
    bash "$FETCH" --state-file "$STATE_FILE" finalize --issue "$key" --status "$status" \
      || die "issue #$key の finalize に失敗しました (state を更新できない状態で破壊的処理を続けません)"
  fi

  if [[ "$keep_wt" == "no" ]]; then
    git -C "$REPO_ROOT" worktree remove "$wt" --force >/dev/null 2>&1 \
      || record_leak "$slug: worktree の削除に失敗しました"
    if [[ "$status" == "done" ]]; then
      git -C "$REPO_ROOT" branch -D "feat/$slug" >/dev/null 2>&1 \
        || record_leak "$slug: branch の削除に失敗しました"
    fi
  fi

  apply_labels "$key" "$status" "$closed" "$slug"

  # 成功したタスクのディレクトリのみ削除する。失敗は調査用に残す
  [[ "$status" == "done" ]] && rm -rf "$d"

  if [[ -n "$AGMSG_TEAM" && -f "$AGMSG_DIR/leave.sh" ]]; then
    for suffix in "" "-sonnet" "-codex" "-review" "-opus"; do
      bash "$AGMSG_DIR/leave.sh" "$AGMSG_TEAM" "$slug$suffix" >/dev/null 2>&1 || true
    done
  fi
done

if [[ "$(jq 'length' <<<"$LEAKED")" != "0" ]]; then
  tmp=$(mktemp "$STATE_FILE.XXXXXX")
  if jq --argjson l "$LEAKED" '.leaked += $l' "$STATE_FILE" > "$tmp"; then mv "$tmp" "$STATE_FILE"
  else rm -f "$tmp"; fi
fi

jq -n --argjson b "$BATCH" --argjson d "$N_DONE" --argjson e "$N_ERROR" --argjson t "$N_TIMEOUT" \
  --argjson m "$N_MERGED" --argjson c "$N_CONFLICTED" --argjson u "$N_UNVERIFIED" --argjson l "$LEAKED" \
  '{batch:$b, done:$d, error:$e, timeout:$t, merged:$m, conflicted:$c, unverified:$u, leaked:$l}'
```

- [ ] **Step 3b: 長時間処理中の heartbeat を打つ（spec §10 の hardening 項目）**

`loop-cleanup.sh` はバッチ全体を処理するため、slug 数が多いと lease（既定 30 分）に近づき得る。
slug ループの先頭で heartbeat を打ち直す。`for key in ...; do` の直後に追加:

```bash
  # 長時間処理の途中でも lock の鮮度を保つ (owner token 検証も兼ねる)
  bash "$FETCH" --state-file "$STATE_FILE" heartbeat >/dev/null 2>&1 \
    || die "loop lock owner check failed mid-cleanup"
```

同じ理由で `batch-wait.sh` のポーリングループにも入れる。`sleep 5` の直前に追加:

```bash
  # 待機が長引いても lock の鮮度を保つ
  bash "$FETCH" --state-file "$STATE_FILE" heartbeat >/dev/null 2>&1 || true
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `bash apps/cmux-team-dispatch-task/test/test-loop-cleanup.sh`
Expected: C1〜C4 が PASS

Run: `bash apps/cmux-team-dispatch-task/test/test-batch-wait.sh`
Expected: Step 3b の追加後も W1〜W5 が引き続き PASS

Run: `bash -n apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/loop-cleanup.sh`
Expected: 無出力

- [ ] **Step 5: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/loop-cleanup.sh \
        apps/cmux-team-dispatch-task/test/test-loop-cleanup.sh
git commit -m "feat(cmux-team-dispatch-task): loop-cleanup.sh を実装し完了検証と WIP 保全付きの後片付けを追加"
```

---

### Task 10: `references/loop-mode.md`（ループ手順の SoT）

**Files:**
- Create: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/loop-mode.md`

**Interfaces:**
- Consumes: Task 3〜9 のスクリプト CLI
- Produces: 親セッションが従うループ手順の SoT。`SKILL.md` からはここを参照するだけにする。

- [ ] **Step 1: ファイルを作成する**

Create `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/loop-mode.md`:

内容は spec の以下を、親セッションが実行できる手順書として書き下す。**spec の文章をコピーするのではなく、実行手順として書く**こと。

1. **発動条件**（spec §3.1 冒頭）: `--loop` が唯一の機械的 entry point。自然言語トリガの場合は Step L0-1 の確認を必ず通す。通常のタスク列挙入力は L0 に入らず既存 Step 1a へ直行する
2. **Step L0**（read-only の probe のみ）: L0-1 発動確認 / L0-2 依存検査 / L0-3 `issue-fetch.sh ... lock-check`
3. **Step L1**（一括設定質問、spec §5 の 3 コール分の質問文と選択肢をそのまま記載）と、末尾での `lock-acquire --lease-min <lock_lease_min>`
4. **Step L1.5**（ロック取得後）: `reconcile` → stale 検査 → `ensure-labels`。中止時は必ず `lock-release`
5. **Step L2**（バッチループ）: `fetch` の exit code 分岐（0+`[]` / 3 / 4）、プロンプト構築、起動、`mark-dispatched` / `release`、`batch-wait.sh` の反復呼び出し（`ALL_TERMINAL` でのみ抜ける）、Template B での報告、`loop-cleanup.sh`。

   **起動コマンドは必ず次の 2 フラグを含める**（これが無いと無人化と late write 対策が効かない）:

   ```bash
   bash <this-skill-dir>/scripts/prewarm-panes.sh \
     --with-opus --message-type agmsg --agmsg-team "$TEAM" \
     --cwd "<repo-root>/.worktrees/<slug>" --slug "<slug>" \
     --status-dir "<repo-root>/.dispatch/<slug>" \
     --unattended \
     --timeout-sentinel "<repo-root>/.dispatch-loop/timed-out/<slug>" \
     …
   ```

   pre-warm を使わない経路（`prewarm: false`）で Phase B が spawn fallback を取る場合は、
   子プロンプトから `launch-workspace.sh --mode execute --unattended --timeout-sentinel <同じパス>`
   を呼ぶよう指示すること。
6. **Step L3**: Template C（batch 列付き）でのサマリ、`leaked[]` の提示、`lock-release`、`.dispatch-loop/` を残す旨と手動削除手順
7. **フォールバック表**（spec §4.1 の 18 行）: 各 AskUserQuestion 箇所がループでどう解決されるか
8. **ラベル遷移表**（spec §3.6）と **cleanup 遷移表**（spec §3.8.2）
9. **unattended の原文の所在**: 差し替え文面は自分で書き起こさず、`references/unattended/` の
   3 ファイル（`review-block.md` / `code-review-block.md` / `phase-lines.md`）を**逐語で使う**。
   差し替え後に `AskUserQuestion` というリテラルが 1 つも残らないことを送信前に確認する
10. **中断時のチェックリスト**: `lock-release` を呼ぶ全経路の列挙

書式は既存の `guide-ja.md` に合わせ、表とコードブロック中心・散文は最小限にする。

- [ ] **Step 2: 内容の整合を確認する**

Run: `grep -c "AskUserQuestion" apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/loop-mode.md`
Expected: 「差し替え対象一覧」節の説明として現れる回数のみ（0 でなくてよい。この文書はレンダリング対象ではない）

Run: `grep -n "issue-fetch.sh\|batch-wait.sh\|loop-cleanup.sh" apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/loop-mode.md`
Expected: すべての呼び出しが `--state-file <path> <subcommand>` の完全形になっていること

- [ ] **Step 3: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/loop-mode.md
git commit -m "docs(cmux-team-dispatch-task): ループモードの手順書 references/loop-mode.md を追加"
```

---

### Task 11: unattended variant ブロックとドキュメント 4 ファイル同時更新

**Files:**
- Create: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/unattended/review-block.md`
- Create: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/unattended/code-review-block.md`
- Create: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/unattended/phase-lines.md`
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md`
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md`
- Modify: `apps/cmux-team-dispatch-task/README.md`
- Modify: `apps/cmux-team-dispatch-task/CLAUDE.md`
- Test: `apps/cmux-team-dispatch-task/test/test-loop-prompt.sh`（新規）

**Interfaces:**
- Consumes: Task 10 の `references/loop-mode.md`
- Produces:
  - `references/unattended/` に、loop モードで**そのまま貼り付ける**確定済みの文面（この 3 ファイルが unattended レンダリングの実体）
  - 親セッションがループを発動できる。通常 dispatch は active loop lock があるとき開始・cleanup を拒否する

**なぜファイルに置くのか:** プロンプト組み立ては LLM が行うため「レンダラの出力」を直接テストできない。そこで**置換後の文面そのものをファイルとして固定**し、テストでそのファイルに `AskUserQuestion` が 1 つも無いこと・7 つの差し替え対象をすべて覆っていることを機械的に検査する。SKILL.md はループ時にこれらを**逐語で使う**よう指示するだけにする。これにより「置換を実装しなくてもテストが通る」状態を避けられる。

**4 ファイル同時更新について:** `CLAUDE.md` の「ドキュメント整合の絶対ルール」により、SKILL.md を変えるコミットでは guide-ja.md / README.md / CLAUDE.md も同時に更新しなければならない。したがってドキュメント同期は別タスクに分けず、このタスクに含める。

- [ ] **Step 1: 失敗するテストを書く**

Create `apps/cmux-team-dispatch-task/test/test-loop-prompt.sh`:

```bash
#!/usr/bin/env bash
# unattended variant の文面と、ループ発動点・active loop lock ガードの検査。
#
# このテストが証明する範囲: references/unattended/ に置かれた「loop で逐語コピーする
# 文面」に対話質問が 1 つも残っていないこと、7 つの差し替え対象をすべて覆っていること、
# 非ループ側の文面が SKILL.md に元のまま残っていること。
# プロンプトの最終的な組み立ては LLM が行うため、その出力自体は静的には検査できない。
# だからこそ「貼り付ける原文」をファイルとして固定し、そこを機械的に検査する。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SK="$SCRIPT_DIR/../skills/cmux-team-dispatch-task"
SKILL="$SK/SKILL.md"
LOOP_REF="$SK/references/loop-mode.md"
UNATT="$SK/references/unattended"

fail=0
ok()  { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; fail=1; }
has() { if grep -Fq -- "$2" "$1"; then ok "$3"; else bad "$3 (missing: $2)"; fi; }
hasnt() { if grep -Fq -- "$2" "$1"; then bad "$3 (unexpected: $2)"; else ok "$3"; fi; }

# --- P1: unattended の文面に対話質問が 1 つも無い（要件 2 の中核） ---
for f in "$UNATT"/review-block.md "$UNATT"/code-review-block.md "$UNATT"/phase-lines.md; do
  [[ -f "$f" ]] || { bad "P1 $f が存在しない"; continue; }
  hasnt "$f" 'AskUserQuestion' "P1 $(basename "$f") に AskUserQuestion が無い"
done

# --- P2: 7 つの差し替え対象をすべて覆っている ---
has "$UNATT/review-block.md"      'round 3'            'P2-1 A-R round 3 の固定手順がある'
has "$UNATT/review-block.md"      'stalled'            'P2-2 A-R stalled の固定手順がある'
has "$UNATT/code-review-block.md" 'round 3'            'P2-3 B-R round 3 の固定手順がある'
has "$UNATT/code-review-block.md" 'stalled'            'P2-4 B-R stalled の固定手順がある'
has "$UNATT/phase-lines.md"       'PHASE A'            'P2-5 PHASE A の行が定義されている'
has "$UNATT/phase-lines.md"       'PHASE B'            'P2-6 PHASE B の行が定義されている'
has "$UNATT/phase-lines.md"       'EXEC_DEFAULT_HINT'  'P2-7 EXEC_DEFAULT_HINT の本文が定義されている'
has "$UNATT/phase-lines.md"       'VIOLATION'          'P2-8 VIOLATION 行が定義されている'

# --- P3: 実装者への伝播指示が入っている（spawn fallback / prewarm） ---
has "$UNATT/code-review-block.md" '--unattended'       'P3 spawn fallback へ --unattended を渡す指示がある'
has "$UNATT/code-review-block.md" '--timeout-sentinel' 'P3 spawn fallback へ sentinel を渡す指示がある'

# --- P4: 非ループ側は元の文面のまま（後方互換） ---
has "$SKILL" 'AskUserQuestion' 'P4 SKILL.md の通常モード文面は従来どおり質問分岐を持つ'
has "$SKILL" 'このまま進む' 'P4 A-R の 3 往復質問が SKILL.md に残っている'

# --- P5: ループ発動点と lock ガード ---
has "$SKILL" 'references/loop-mode.md'    'P5-1 SKILL.md がループ手順書を参照する'
has "$SKILL" '--loop'                     'P5-2 SKILL.md が --loop を唯一の機械的 entry point とする'
has "$SKILL" '.dispatch-loop/loop.lock.d' 'P5-3 SKILL.md に active loop lock ガードがある'
# ガードは「Step 1 の前」と「rm -rf .dispatch/ の前」の 2 箇所
[[ $(grep -c 'lock-check' "$SKILL") -ge 2 ]] \
  && ok 'P5-4 lock-check が 2 箇所に置かれている' \
  || bad 'P5-4 lock-check が 2 箇所に無い'

# --- P6: loop-mode.md が unattended ファイルを参照している ---
has "$LOOP_REF" 'references/unattended/' 'P6 loop-mode.md が unattended の原文を参照する'

[[ $fail -eq 0 ]] && echo '--- all tests passed ---' || echo '--- failures ---'
exit "$fail"
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `bash apps/cmux-team-dispatch-task/test/test-loop-prompt.sh`
Expected: P1・P2 が「ファイルが存在しない」で FAIL

- [ ] **Step 3a: unattended の原文ファイルを作る**

Create `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/unattended/review-block.md`:

現行 SKILL.md の `{{REVIEW_BLOCK}}` テンプレート全体をコピーし、質問分岐 2 箇所を置換したものを置く。
冒頭に次の 1 行を付ける（`AskUserQuestion` というリテラルを含めない）:

```text
UNATTENDED: no interactive user is attached to this session. Every decision point
below states its fixed outcome — follow it and record what you did in the document
you produce.
```

置換内容:

| 元の記述 | 置換後 |
|---|---|
| `N == 3 → summarize the unresolved findings and ask via AskUserQuestion: 1. このまま進む / 2. さらに修正` | `N == 3 → append the unresolved findings as a note at the end of the document and proceed to Phase B. Do not run another round.` |
| `The wait exited stalled (STALLED=1 …) → … ask via AskUserQuestion: 1. 再依頼する / 2. レビューを省略して Phase B へ進む` | `The wait exited stalled → re-check the verdict file once, then re-send the SAME round's request once with a fresh baseline. If it exits stalled again, skip the review, note the skipped review in the document, and proceed to Phase B.` |

Create `references/unattended/code-review-block.md`:

現行の `{{CODE_REVIEW_BLOCK}}` 全体をコピーし、質問分岐 2 箇所を置換する。加えて
**共通プロトコル a の `REQUEST_TEXT` に、spawn fallback を使う場合の指示を明記する**:

| 元の記述 | 置換後 |
|---|---|
| `Round 3 needs_work → ask via AskUserQuestion: 1. このまま PR 作成 / 2. さらに修正` | `Round 3 needs_work → note the unresolved findings in the PR body and create the PR. Do not run another round.` |
| `if you can ask the user interactively (AskUserQuestion), ask whether to proceed or run one more round; otherwise …` | `note the unresolved findings in the PR body and proceed.` |
| `if it stalls again, ask via AskUserQuestion if you can (再依頼 / レビュー省略して PR 作成); otherwise …` | `if it stalls again, skip the review, note that in the PR body, and create the PR.` |
| （追記） | `If prewarm.json is absent and you fall back to spawning via launch-workspace.sh --mode execute, you MUST also pass --unattended and --timeout-sentinel <the path given in this prompt>.` |

Create `references/unattended/phase-lines.md`:

レビューブロック以外の 5 箇所の 1 行置換を、対照表として置く。

| 対象 | 元の記述 | 置換後 |
|---|---|---|
| PHASE A（plan モード） | `Step 1: Phase B execution-model selection (per the block below — AskUserQuestion or default direct)` | `Step 1: Phase B execution-model selection (per the fixed path defined below)` |
| PHASE B 見出し直下 | `follow the Phase B flow resolved in this task prompt (AskUserQuestion or default direct)` | `follow the fixed Phase B path defined below` |
| PHASE B の Question template と `{{CODEX_OPTION_LINE}}` | 質問テンプレート全体 | 出力しない（loop では `exec_choice` が必ず確定しているので `{{EXEC_DEFAULT_HINT}}` の default-direct ブロックだけを出す） |
| `{{EXEC_DEFAULT_HINT}}` 本文 | `ExitPlanMode 後は AskUserQuestion をスキップし、直ちに <default> の既存 Phase B ブランチを実行してください。` | `ExitPlanMode 後は直ちに <default> の既存 Phase B ブランチを実行してください。新しい実行経路は作らないこと。` |
| VIOLATION 節 | `Follow the exact flow defined in this PHASE B block (either AskUserQuestion or the default-direct path); do not invent an execution model.` | `Follow the exact flow defined in this PHASE B block; do not invent an execution model.` |
| codex 設計 variant の PHASE B 冒頭 | `follow the Phase B flow resolved in this task prompt (AskUserQuestion or default direct)` | `follow the fixed Phase B path defined below` |

- [ ] **Step 3b: `SKILL.md` を更新する**

3-a. `SKILL.md` の frontmatter の `argument-hint` を更新:

```yaml
argument-hint: "<task1>, <task2>, ... [--layout split|claude-teams] [--no-grid] [--loop]"
```

3-b. `## Step 1: Parse and Prepare` の**直前**に、ループのディスパッチポイントを追加:

```markdown
---

## Loop Mode (GitHub issue 自動ループ)

**発動条件（これ以外では絶対にループへ入らない）:**

- `$ARGUMENTS` に `--loop` が含まれる、**または**
- ユーザーが「GitHub issue を自動で回す」「issue が無くなるまでループして」のように
  ループの実行そのものを明示的に要求している

タスクの説明文に issue 番号や issue の話題が含まれるだけでは発動しない。上の 2 条件に当たらない
入力は、この節を読まずに Step 1a へ直行すること（通常 dispatch の挙動は一切変わらない）。

発動したら、以降の手順は **`references/loop-mode.md`** に従う。Step 1c〜1g の質問群と
「Cleanup prompts」節は、ループモードでは同ファイルの一括設定質問と cleanup 遷移表で
解決済みなので**実行しない**。

## Active loop lock guard（通常 dispatch 側）

ループ実行中は `.dispatch/` をループが使っている。通常 dispatch の cleanup は
`rm -rf .dispatch/` を無条件で実行するため、ループの走行中に通常 dispatch を始めると
タスクの `status.json` / `prewarm.json` を消してしまう。そこで **Step 1 に入る前** と
**cleanup で `rm -rf .dispatch/` を実行する直前** の 2 箇所で次を確認する:

```bash
LOCK_OWNER=".dispatch-loop/loop.lock.d/owner.json"
if [[ -f "$LOCK_OWNER" ]]; then
  bash <this-skill-dir>/scripts/issue-fetch.sh \
    --state-file .dispatch-loop/loop-state.json lock-check || {
      echo "issue ループが実行中です。完了を待つか、ループを停止してから実行してください。" >&2
      # Step 1 前  → dispatch を開始しない
      # cleanup 前 → .dispatch/ の一括削除をスキップし、当該タスクのディレクトリのみ削除する
    }
fi
```

`.dispatch-loop/` が存在しない環境ではこの検査は素通りするため、ループを使わない利用者の
挙動は変わらない。これは「通常モードの挙動は不変」に対する 2 つ目の明示的な例外である
（1 つ目は codex の hook trust バイパス）。

---
```

3-c. 「Placeholder rules」節に `{{UNATTENDED_RENDER}}` の契約を追加する。`{{EXEC_DEFAULT_HINT}}` の項目の直後に挿入:

```markdown
- `{{UNATTENDED_RENDER}}` → **loop モードのときのみ有効なレンダリング規則**（通常モードでは
  何もしない = プロンプトは 1 バイトも変わらない）。loop では、生成される task file と
  typed `TASK_TEXT` に `AskUserQuestion` というリテラルが 1 つも残ってはならない。

  **文面を自分で書き起こしてはならない。** 確定済みの原文が次の 3 ファイルにあるので、
  該当箇所を**逐語でこれに差し替える**:

  | ファイル | 差し替える対象 |
  |---|---|
  | `references/unattended/review-block.md` | `{{REVIEW_BLOCK}}` 全体（A-R の 2 つの質問分岐を含む） |
  | `references/unattended/code-review-block.md` | `{{CODE_REVIEW_BLOCK}}` 全体（B-R の 2 つの質問分岐と、spawn fallback への `--unattended` / `--timeout-sentinel` 伝播指示を含む） |
  | `references/unattended/phase-lines.md` | レビューブロック以外の 5 箇所（PHASE A の Step 1 行 / PHASE B 見出し直下 / Question template と `{{CODEX_OPTION_LINE}}` / `{{EXEC_DEFAULT_HINT}}` 本文 / VIOLATION 行 / codex 設計 variant の PHASE B 冒頭） |

  差し替え後、`grep -c AskUserQuestion` が 0 であることを目視で確認してから送ること。
```

3-d. 該当箇所に `{{UNATTENDED_RENDER}}` プレースホルダを 1 行入れる（`{{EXEC_DEFAULT_HINT}}` の直前）。

3-e. active loop lock ガードの TOCTOU について（spec §10 の hardening 項目）。この検査は
check-only なので、「検査を通った直後にループが始まる」狭い窓が残る。窓を最小化するため、
ガードの記述に次の 1 文を添える:

```markdown
この検査は check-only であり、通過直後にループが開始される狭い競合窓が残る。窓を小さく
保つため、**Step 1 に入る直前**と **`rm -rf .dispatch/` の直前**という「その直後に破壊的操作を
行う位置」でのみ検査する（早い段階で一度だけ確認して以後信用する、という使い方をしない）。
ループと通常 dispatch の同時実行はそもそも非サポートである（`references/loop-mode.md` 参照）。
```

- [ ] **Step 3c: 残り 3 つのドキュメントを同時に更新する**

`CLAUDE.md` の「ドキュメント整合の絶対ルール」により、SKILL.md を変えるコミットでは
残り 3 ファイルも同じコミットで揃える。**これを別タスクに遅らせてはならない。**

**`references/guide-ja.md`:**

1. engine × MODE 起動表の codex 行すべてに `--dangerously-bypass-hook-trust` を追加（review 行は 4 点セット）
2. `launch-workspace.sh` のオプション一覧に `--unattended` / `--timeout-sentinel <path>` を追加
3. `prewarm-panes.sh` のオプション一覧に `--unattended` / `--timeout-sentinel <path>` を追加
4. 「ループモード」節を新設: `references/loop-mode.md` への参照、`.dispatch-loop/` の役割、
   `loop.task_timeout_min` / `loop.lock_lease_min`、通常 dispatch 側の active loop lock ガード
5. status protocol の節に、runner wrapper の `write_status` が既存 `pr_url` を引き継ぐことを追記

**`README.md`:**

1. Phase B のモデル表と review ペイン説明に `--dangerously-bypass-hook-trust` を追加
2. 「GitHub issue 自動ループ」節を新設: `--loop` での起動、一括設定質問の内容、バッチ方式、
   `dispatch/in-progress` / `dispatch/done` / `dispatch/failed` の意味、`.dispatch-loop/` に状態が残ること、
   同時実行の制約（ループ同士・ループと通常 dispatch のどちらも非サポート）
3. 「セキュリティ上の注意」節: hook trust バイパスが**通常 dispatch にも適用される**こと、
   その理由（worktree ごとに hooks.json のパスが変わるため trust gate が実質機能せず停止するだけ）、
   影響範囲（このプラグインが起動する codex セッションのみ）

**`CLAUDE.md`:**

1. 「ファイル構成」表に `issue-fetch.sh` / `batch-wait.sh` / `loop-cleanup.sh` /
   `references/loop-mode.md` / `references/unattended/` を追加
2. 項目 20 を次に差し替える:

```markdown
20. codex の engine × MODE 起動規則を確認: **全 5 経路（plan / superpowers / execute / standby / review）に `--dangerously-bypass-hook-trust`** が付くこと（codex 0.145 の hook trust は hooks.json の絶対パスをキーに信頼を記録するため、worktree ごとにパスが変わるこのプラグインでは毎回未信頼となり起動時に停止する。`--dangerously-bypass-approvals-and-sandbox` はこれをカバーしない別フラグ）。superpowers は bypass 付き、review は `--sandbox workspace-write` + `-c approval_policy='never'` + `--add-dir <STATUS_DIR>` + hook trust の 4 点セットで、sandbox 完全 off を使わず findings 書込先を許可すること
```

3. 項目 39 を更新し、`bash test/test-codex-review-sandbox.sh` の証明範囲
   （sandbox の writable root / denial / git diff のみ。`approval_policy` は静的検査で担保）を明記
4. 「メンテナンス手順」に項目 22 を追加:

```markdown
22. ループモード（GitHub issue 自動ループ）が SKILL.md / references/loop-mode.md / references/unattended/ / guide-ja.md / README.md / CLAUDE.md で一致しているか確認:
    - 発動は `--loop` が唯一の機械的 entry point。自然言語トリガでも Step L0-1 の確認を必ず通し、通常のタスク列挙入力は Step 1a へ直行すること
    - ロックは `.dispatch-loop/loop.lock.d` を `mkdir` で atomic 取得。owner.json 未生成のロックは stale ではなく in-flight として扱い奪わない。stale takeover は atomic rename の勝者のみ。liveness の正本は `owner.json.heartbeat` の 1 箇所。release は owner 一致時のみ。取得は Step L1 の最終確認後（質問回答待ちを lease に含めない）
    - `issue-fetch.sh fetch` は「候補が尽きた (exit 0 + [])」「claim 全滅 (exit 3)」「上限まで満杯で判定不能 (exit 4)」を厳密に区別する。取得クエリは dispatch 3 ラベルを negative search qualifier で除外し、未割当は `no:assignee`（`--assignee none` は存在しない値）。窓は `min(前回*2, 1000)` で拡張する
    - claim / release は「ラベルと state の片方だけが残る」状態を作らないこと。claim 後に state を書けなければラベルを補償的に外し、release ではラベルを外せない限り state record を消さない
    - `batch-wait.sh` の出力は `ALL_TERMINAL` / `WAITING` の 2 種類のみ。timeout の terminal 化は自身が行い、sentinel は `.dispatch-loop/timed-out/<slug>`（タスクディレクトリと一緒に消えないため late write を封じられる）。sentinel は `prewarm-panes.sh --timeout-sentinel` から**全 standby**へ、spawn fallback では `launch-workspace.sh --timeout-sentinel` へ必ず転送されること
    - `loop-cleanup.sh` は cleanup 前に完了検証を行い、落ちた `done` を `error` に降格する。WIP 保全（`--no-verify` コミット → `--binary` patch + 未追跡 tar → 基準コミットから作った clean な一時 worktree での `git apply --check`）は fail-closed で、どれか失敗したら worktree を温存する。`finalize` は破壊的処理の**前**に行い、失敗したら中断する
    - unattended の文面は `references/unattended/` の 3 ファイルが原文。loop ではこれを逐語で差し替え、`AskUserQuestion` を 1 つも残さないこと（`test/test-loop-prompt.sh` が検査する）
    - 通常 dispatch 側の active loop lock ガード（Step 1 冒頭 / `rm -rf .dispatch/` 直前の 2 箇所）が入っていること。これは hook trust バイパスと並ぶ「通常挙動不変」の 2 つ目の明示的例外
```

5. 「テスト方法」の E2E 節に spec §7 の手動チェックリスト 7 項目を追加

- [ ] **Step 4: テストが通ることを確認する**

Run: `bash apps/cmux-team-dispatch-task/test/test-loop-prompt.sh`
Expected: `--- all tests passed ---`

Run: `bash apps/cmux-team-dispatch-task/test/test-launch-workspace-codex.sh`
Expected: T7 の SKILL.md 静的検査が引き続き通ること

- [ ] **Step 5: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md \
        apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/unattended/ \
        apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md \
        apps/cmux-team-dispatch-task/README.md apps/cmux-team-dispatch-task/CLAUDE.md \
        apps/cmux-team-dispatch-task/test/test-loop-prompt.sh
git commit -m "feat(cmux-team-dispatch-task): ループ発動点・loop lock ガード・unattended 原文を追加しドキュメント 4 ファイルを同期"
```

---

### Task 12: `codex sandbox` 動的検査

**Files:**
- Create: `apps/cmux-team-dispatch-task/test/test-codex-review-sandbox.sh`

**Interfaces:**
- Consumes: Task 1 の review モード起動フラグ
- Produces: review ペインの sandbox 挙動の自動検証

**背景（spec §6.3）:** `codex sandbox` はモデルの tool approval を経由せず raw command を sandbox 内で実行する。したがってこのテストが証明するのは **writable root / denial / `git diff`** であり、`approval_policy='never'` の挙動は証明しない（そちらは生成コマンドの静的検査と CLI 契約で担保する）。この限定をコメントに明記すること。

- [ ] **Step 1: テストを書く**

Create `apps/cmux-team-dispatch-task/test/test-codex-review-sandbox.sh`:

```bash
#!/usr/bin/env bash
# review ペインが使う codex の sandbox 挙動の動的検査。
#
# 証明する範囲: workspace-write の writable root、--add-dir の効果、denial の発生、
#               worktree 内での git diff の成否。
# 証明しない範囲: -c approval_policy='never' が TUI で承認待ちを起こさないこと。
#   codex sandbox はモデルの tool approval を経由せず raw command を直接実行する
#   サブコマンドなので、approval policy の動的証明にはならない。approval_policy は
#   test-launch-workspace-codex.sh の静的 assert と codex CLI の契約で担保する。

set -euo pipefail

if ! command -v codex >/dev/null 2>&1; then
  echo 'SKIP: codex CLI が見つかりません'
  exit 0
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
REPO="$TMP/repo"; STATUS="$TMP/status/review"
mkdir -p "$REPO" "$STATUS"
git -C "$REPO" init -q -b main
git -C "$REPO" config user.email t@example.invalid
git -C "$REPO" config user.name t
echo a > "$REPO/a.txt"
git -C "$REPO" add . && git -C "$REPO" commit -qm init
echo b >> "$REPO/a.txt"

fail=0
ok()  { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; fail=1; }

cd "$REPO"

# S1: --add-dir 無しでは STATUS_DIR への書き込みが拒否される
if codex sandbox -c sandbox_mode=workspace-write -- \
     bash -c "touch '$STATUS/probe.txt'" >/dev/null 2>&1; then
  bad 'S1 --add-dir 無しで STATUS_DIR に書けてしまった'
else
  ok 'S1 --add-dir 無しでは STATUS_DIR への書き込みが拒否される'
fi

# S2: --add-dir 付きなら書ける
if codex sandbox -c sandbox_mode=workspace-write --add-dir "$STATUS" -- \
     bash -c "touch '$STATUS/probe.txt'" >/dev/null 2>&1 && [[ -f "$STATUS/probe.txt" ]]; then
  ok 'S2 --add-dir 付きなら STATUS_DIR に findings を書ける'
else
  bad 'S2 --add-dir 付きでも STATUS_DIR に書けない'
fi

# S3: worktree 内の git diff は成功する（レビューに必要）
if codex sandbox -c sandbox_mode=workspace-write -- git diff --stat >/dev/null 2>&1; then
  ok 'S3 sandbox 下でも git diff が成功する'
else
  bad 'S3 sandbox 下で git diff が失敗する'
fi

[[ $fail -eq 0 ]] && echo '--- all tests passed ---' || echo '--- failures ---'
exit "$fail"
```

- [ ] **Step 2: 実行して確認する**

Run: `bash apps/cmux-team-dispatch-task/test/test-codex-review-sandbox.sh`
Expected: codex がある環境では S1〜S3 が PASS、無い環境では `SKIP:` で exit 0

- [ ] **Step 3: コミット**

```bash
git add apps/cmux-team-dispatch-task/test/test-codex-review-sandbox.sh
git commit -m "test(cmux-team-dispatch-task): review ペインの codex sandbox 挙動を動的検査するテストを追加"
```

---

### Task 13: バージョン更新

**Files:**
- Modify: `apps/cmux-team-dispatch-task/.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`

**Interfaces:**
- Consumes: Task 1〜12 のすべて
- Produces: プラグイン版数の同期

**注:** ドキュメント 4 ファイル（SKILL.md / guide-ja.md / README.md / CLAUDE.md）の同期は
**Task 11 で完了している**。`CLAUDE.md` の「ドキュメント整合の絶対ルール」は「任意の 1 ファイルを
更新したら残り 3 ファイルも同時に更新する」ことを求めるため、同期を別タスクへ遅らせると
Task 11 のコミット時点で整合が崩れた状態になってしまう。このタスクは版数だけを扱う。

- [ ] **Step 1: バージョンを上げる**

```bash
jq '.version = "1.10.0"' apps/cmux-team-dispatch-task/.claude-plugin/plugin.json > /tmp/p.json \
  && mv /tmp/p.json apps/cmux-team-dispatch-task/.claude-plugin/plugin.json
jq '(.plugins[] | select(.name == "cmux-team-dispatch-task") | .version) = "1.10.0"' \
  .claude-plugin/marketplace.json > /tmp/m.json && mv /tmp/m.json .claude-plugin/marketplace.json
```

- [ ] **Step 2: 反映を確認する**

Run:
```bash
jq -r '.version' apps/cmux-team-dispatch-task/.claude-plugin/plugin.json
jq -r '.plugins[] | select(.name=="cmux-team-dispatch-task") | .version' .claude-plugin/marketplace.json
jq . apps/cmux-team-dispatch-task/.claude-plugin/plugin.json > /dev/null && echo "plugin.json OK"
jq . .claude-plugin/marketplace.json > /dev/null && echo "marketplace.json OK"
```
Expected: どちらの version も `1.10.0`、JSON 検証も両方 OK

- [ ] **Step 3: コミット**

```bash
git add apps/cmux-team-dispatch-task/.claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "chore(cmux-team-dispatch-task): issue ループ機能追加に伴い v1.10.0 へバンプ"
```

---

### Task 14: 最終検証

**Files:**
- 変更なし（検証のみ）

**Interfaces:**
- Consumes: Task 1〜13 のすべて
- Produces: 全テストが通ることの機械的な確認

**注:** 各コマンドの失敗を必ず記録し、1 つでも落ちたら非 0 で終了すること。
`... || echo "FAILED"` だけで済ませると、最後のコマンドが成功しただけでシェル全体が成功に
なってしまい「全テスト成功」を保証できない。

- [ ] **Step 1: 構文チェック**

```bash
rc=0
for f in apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/*.sh \
         apps/cmux-team-dispatch-task/test/*.sh; do
  bash -n "$f" || { echo "SYNTAX ERROR: $f"; rc=1; }
done
zsh -n apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh || rc=1
exit "$rc"
```

Expected: exit 0（`SYNTAX ERROR` の出力が無いこと）

- [ ] **Step 2: 全テストを実行する**

```bash
rc=0
for t in apps/cmux-team-dispatch-task/test/*.sh; do
  echo "=== $t ==="
  bash "$t" || { echo "TEST FAILED: $t"; rc=1; }
done
exit "$rc"
```

Expected: exit 0。各テストが `--- all tests passed ---`
（`test-codex-review-sandbox.sh` は codex 不在なら `SKIP:` で exit 0）

- [ ] **Step 3: ワークスペース全体のチェック**

Run: `pnpm check`
Expected: 成功。シェルスクリプト中心の変更なので影響は無いはずだが必ず確認する

- [ ] **Step 4: 未コミットの変更を確認する**

```bash
git status --short
```

Expected: このタスクの成果物として意図した変更のみ。
**`git add -A` は使わない** — この worktree には `.cmux-team-dispatch-task-run-*.sh` や
`.codex/hooks.json` などディスパッチ機構が生成した未追跡ファイルが存在し、`-A` はそれらを
巻き込む。意図した変更があれば**パスを明示して** stage する:

```bash
git add apps/cmux-team-dispatch-task docs/superpowers .claude-plugin/marketplace.json
git status --short   # 想定外の未追跡ファイルが stage されていないか再確認
git commit -m "<変更内容の要約>"
```

想定外の変更が残っている場合は、コミットせず内容を確認して人に報告すること。
