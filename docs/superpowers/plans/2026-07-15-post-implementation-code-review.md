# Phase B-R（実装後コードレビュー）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `review_mode` 有効時、実装完了後・PR 作成前にコードレビュー（sonnet/codex 実装 → 計画 opus ペイン、opus 1m 実装 → codex レビューペイン）を挟む Phase B-R を `cmux-team-dispatch-task` に追加する。

**Architecture:** 実装は「プロンプト焼き込み文書（SKILL.md の MANDATORY MODEL SELECTION SEQUENCE）への Phase B-R ブロック追加」が本体。コード変更は `launch-workspace.sh` への `--review-config` オプション 1 点のみ。残りは guide-ja.md / README.md / CLAUDE.md の 4 ファイル同期とバージョン bump。

**Tech Stack:** bash（launch-workspace.sh）、markdown（スキル定義・ドキュメント）、jq。

**Spec:** `docs/superpowers/specs/2026-07-15-post-implementation-code-review-design.md`

## Global Constraints

- **4 ファイル同期ルール**: SKILL.md / guide-ja.md / README.md / CLAUDE.md のモデル選択フロー記述は完全一致させる（apps/cmux-team-dispatch-task/CLAUDE.md「ドキュメント整合の絶対ルール」）
- **言語**: ドキュメント・コメントは日本語 / コード（変数名・フラグ）と子プロンプト焼き込みブロックは既存スタイルどおり英語
- **バージョン**: `apps/cmux-team-dispatch-task/.claude-plugin/plugin.json` と ルート `.claude-plugin/marketplace.json` を **1.6.2 → 1.6.3** に同期
- **有効化条件**: Phase A-R と同一（Step 1g の `REVIEW_ENABLED`）。新しい config キーは追加しない
- **共通語彙**（全タスクで表記統一）: フェーズ名 `Phase B-R` / レビューポイント id `code` / findings ファイル `<STATUS_DIR>/review/code-round-<N>.md`（最終行 `VERDICT: approve` or `VERDICT: needs_work`）/ 最大 3 往復 / verdict 待ちは 5 秒間隔・15 分タイムアウトのファイルポーリング / spawn 経路の配線ファイル `<STATUS_DIR>/review/code-review.json`（スキーマ `{reviewer_surface, review_dir}`）
- テストランナーは無い。各タスクの検証は `bash -n` / `jq .` / grep による表記整合チェック（E2E は cmux 実機でしか動かないため、CLAUDE.md の E2E 項目として文書化する）

---

### Task 1: launch-workspace.sh に `--review-config` を追加

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh`

**Interfaces:**
- Produces: `--review-config <path>` オプション。`<path>` は JSON `{"reviewer_surface": "surface:N", "review_dir": "/abs/path"}`。`--mode execute` 専用。指定時、composed prompt（inner prompt）の plan 文と EXIT_INSTRUCTION の間にコードレビュープロトコル（英語・クォート文字なし）が挿入される。Task 2 の spawn フォールバック手順と Task 3〜5 のドキュメントがこの仕様を参照する。

- [ ] **Step 1: ヘッダー usage コメントにオプションを追記**

`--defer-status` の説明ブロック（40 行目付近 `#                                      実行を移譲する Child セッション側で常に指定する` の直後）に追加:

```
#   --review-config <path>             (--mode execute 専用) Phase B-R コードレビュー配線
#                                      JSON ({reviewer_surface, review_dir}) のパス。指定時、
#                                      inner prompt に「PR 作成前にレビュアー surface へ
#                                      cmux send でレビュー依頼し、review_dir/code-round-<N>.md
#                                      の VERDICT をポーリングして approve までループする」
#                                      プロトコルを追記する
```

- [ ] **Step 2: 変数初期化と引数パースを追加**

変数初期化ブロック（`DEFER_STATUS=0` の直後）に `REVIEW_CONFIG=""` を追加。引数パースの `--defer-status)` ケースの直後に追加:

```bash
    --review-config)
      [[ $# -lt 2 ]] && die "--review-config requires a path argument"
      REVIEW_CONFIG="$2"
      shift 2
      ;;
```

- [ ] **Step 3: バリデーションを追加**

`# --model は execute/standby/review 向けの拡張...` のバリデーション（255 行目付近）の直後に追加:

```bash
# --review-config は execute 専用 (Phase B-R: PR 作成前コードレビューのプロトコル注入)
if [[ -n "$REVIEW_CONFIG" ]]; then
  [[ "$MODE" == "execute" ]] || die "--review-config is only valid with --mode execute"
  [[ -f "$REVIEW_CONFIG" ]] || die "review config file not found: $REVIEW_CONFIG"
fi
```

- [ ] **Step 4: execute モードの PROMPT_TEXT 組み立てにプロトコルを挿入**

現在の execute ブロック（447〜456 行付近）:

```bash
if [[ "$MODE" == "execute" ]]; then
  if [[ "$RUNNER_ENGINE" == "codex" ]]; then
    EXIT_INSTRUCTION="After all work is committed/pushed and the PR is created (or all changes are merged per the plan), end this codex session immediately so the wrapper script can finalize completion notification. Do not leave the session idle."
  else
    EXIT_INSTRUCTION="After all work is committed/pushed and the PR is created (or all changes are merged per the plan), run /exit to close this Claude session so the wrapper script can finalize completion notification. Do not leave the session idle."
  fi
  PROMPT_TEXT="Read and execute the plan at $PLAN_FILE. ${EXIT_INSTRUCTION}"
else
```

これを以下に変更する（EXIT_INSTRUCTION の 2 分岐は不変。REVIEW_INSTRUCTION を間に挿入）。
**注意: REVIEW_INSTRUCTION の文中にシングル/ダブルクォート文字を含めてはならない**（inner prompt は `'...'` で包まれ、さらに `zsh -ic "..."` で包まれるため）:

```bash
if [[ "$MODE" == "execute" ]]; then
  if [[ "$RUNNER_ENGINE" == "codex" ]]; then
    EXIT_INSTRUCTION="After all work is committed/pushed and the PR is created (or all changes are merged per the plan), end this codex session immediately so the wrapper script can finalize completion notification. Do not leave the session idle."
  else
    EXIT_INSTRUCTION="After all work is committed/pushed and the PR is created (or all changes are merged per the plan), run /exit to close this Claude session so the wrapper script can finalize completion notification. Do not leave the session idle."
  fi
  # Phase B-R: --review-config 指定時は PR 作成前のコードレビュープロトコルを inner prompt に注入する。
  # 文中にクォート文字を使わないこと (inner prompt の '...' と zsh -ic の "..." を壊さないため)
  REVIEW_INSTRUCTION=""
  if [[ -n "$REVIEW_CONFIG" ]]; then
    REVIEWER_SURFACE=$(jq -r '.reviewer_surface // empty' "$REVIEW_CONFIG" 2>/dev/null) \
      || die "failed to parse review config at $REVIEW_CONFIG"
    REVIEW_DIR=$(jq -r '.review_dir // empty' "$REVIEW_CONFIG" 2>/dev/null) \
      || die "failed to parse review config at $REVIEW_CONFIG"
    [[ -n "$REVIEWER_SURFACE" && -n "$REVIEW_DIR" ]] \
      || die "review config must contain reviewer_surface and review_dir"
    REVIEW_INSTRUCTION="MANDATORY CODE REVIEW: after all changes are committed and BEFORE creating the PR, you must get a code review approval. Round N starts at 1, max 3 rounds. Each round: (1) request the review by running: $CMUX send --surface $REVIEWER_SURFACE followed by: $CMUX send-key --surface $REVIEWER_SURFACE return -- the message must say: code review round N: review the committed changes on this branch against the plan at $PLAN_FILE and write findings to $REVIEW_DIR/code-round-N.md whose LAST line must be VERDICT: approve or VERDICT: needs_work. From round 2 include your rebuttals to the findings you rejected, with reasons. (2) wait by polling $REVIEW_DIR/code-round-N.md every 5 seconds up to 15 minutes for a VERDICT line. (3) On VERDICT: approve proceed to the PR. On VERDICT: needs_work apply the findings you judge valid, commit, and start round N+1. If round 3 still ends with needs_work, or the verdict file never appears after one re-send of the same round: if you can ask the user interactively via AskUserQuestion, ask whether to proceed to the PR or keep going; otherwise note the unresolved or skipped review in the PR body and proceed. "
  fi
  PROMPT_TEXT="Read and execute the plan at $PLAN_FILE. ${REVIEW_INSTRUCTION}${EXIT_INSTRUCTION}"
else
```

- [ ] **Step 5: 構文チェックと die パスの動作確認**

```bash
cd apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts
bash -n launch-workspace.sh
# 期待: 出力なし (exit 0)

bash launch-workspace.sh --review-config /tmp/nonexistent.json --mode plan test-ws "prompt" 2>&1 | head -1
# 期待: Error: --review-config is only valid with --mode execute

bash launch-workspace.sh --review-config /tmp/nonexistent.json --mode execute --plan-file /tmp/p.md test-ws 2>&1 | head -1
# 期待: Error: review config file not found: /tmp/nonexistent.json
```

- [ ] **Step 6: Commit**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh
git commit -m "feat(cmux-team-dispatch-task): launch-workspace.sh に --review-config を追加 (Phase B-R spawn 経路の配線)"
```

---

### Task 2: SKILL.md — Phase B-R ブロックと Phase B 分岐の更新

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md`

**Interfaces:**
- Consumes: Task 1 の `--review-config`（JSON スキーマ `{reviewer_surface, review_dir}`）
- Produces: プレースホルダー `{{CODE_REVIEW_BLOCK}}`（`REVIEW_ENABLED` 時のみ焼き込み）と、その本文 `PHASE B-R` ブロック。Task 3〜5 はこのブロックの用語・数値（`code` / `code-round-<N>.md` / 3 往復 / 5 秒・15 分）をそのまま転記する。

- [ ] **Step 1: Step 1g のレビューモード質問文を更新**

質問文（356 行付近）を置換。

旧:
```
     > plan/spec の codex レビュー (Phase A-R) を使いますか？ (Phase A の成果物を codex (`<review_model>`) が approve するまでレビューします)
```

新:
```
     > レビューモードを使いますか？ (Phase A-R: plan/spec を codex (`<review_model>`) が approve するまでレビュー / Phase B-R: 実装完了後・PR 作成前にコードレビュー)
```

- [ ] **Step 2: プレースホルダー一覧と MANDATORY シーケンス本文に `{{CODE_REVIEW_BLOCK}}` を追加**

(a) 「Building the Task Prompt」item 3 の説明文（532 行付近）:

旧:
```
   This block contains placeholders the parent fills before sending: `{{LAYOUT}}`,
   `{{CODEX_OPTION_LINE}}`, `{{CODEX_BEHAVIOR_BLOCK}}`, `{{REVIEW_BLOCK}}`. See the
   placeholder rules immediately below this template.
```

新:
```
   This block contains placeholders the parent fills before sending: `{{LAYOUT}}`,
   `{{CODEX_OPTION_LINE}}`, `{{CODEX_BEHAVIOR_BLOCK}}`, `{{REVIEW_BLOCK}}`,
   `{{CODE_REVIEW_BLOCK}}`. See the placeholder rules immediately below this template.
```

(b) シーケンス本文の `{{CODEX_BEHAVIOR_BLOCK}}` 行と `  Notes on the deferred completion mechanism:` の間（既存は空行 1 つ）に、次の 2 行を挿入:

```
{{CODE_REVIEW_BLOCK}}

```

- [ ] **Step 3: Phase B sonnet 分岐（prewarm 経路）を Phase B-R 対応に更新**

(a) REQUEST_TEXT 定義（`REQUEST_TEXT="Read and execute the plan at <PLAN_FILE_PATH>. After all work is` で始まる 3 行）の直後に、同じインデントで注記を追加:

```
             # IF the PHASE B-R block exists below, do NOT use this REQUEST_TEXT —
             # use the extended REQUEST_TEXT defined in that block instead (it inserts
             # the pre-PR code-review protocol).
```

(b) prewarm 経路 step 4 を置換。

旧:
```
        4. touch "<EXISTING_STATUS_DIR>/.deferred" then exit THIS session.
```

新:
```
        4. touch "<EXISTING_STATUS_DIR>/.deferred". IF the PHASE B-R block exists
           below, do NOT exit — switch to the reviewer role it defines. OTHERWISE
           exit THIS session.
```

（この行はシーケンス内に sonnet 分岐で 1 か所。`{{CODEX_BEHAVIOR_BLOCK}}` 内の同型行は Step 5 で更新する）

(c) sonnet spawn フォールバックの起動コマンド。

旧（該当ブロック末尾）:
```
          [--split-from <SURFACE_ID> --parent-workspace <WS_ID>]  # split layout のみ
          <task-slug>-exec
        touch "<EXISTING_STATUS_DIR>/.deferred" then exit THIS session.
```

新:
```
          [--split-from <SURFACE_ID> --parent-workspace <WS_ID>]  # split layout のみ
          [--review-config "<EXISTING_STATUS_DIR>/review/code-review.json"]  # PHASE B-R があるときのみ
          <task-slug>-exec
        IF the PHASE B-R block exists below, BEFORE the launch above write the
        reviewer wiring file (you are the reviewer):
          mkdir -p "<EXISTING_STATUS_DIR>/review"
          jq -n --arg s "$CMUX_SURFACE_ID" --arg d "<EXISTING_STATUS_DIR>/review" \
            '{reviewer_surface: $s, review_dir: $d}' \
            > "<EXISTING_STATUS_DIR>/review/code-review.json"
        touch "<EXISTING_STATUS_DIR>/.deferred". IF the PHASE B-R block exists below,
        do NOT exit — switch to the reviewer role it defines. OTHERWISE exit THIS session.
```

- [ ] **Step 4: `{{CODE_REVIEW_BLOCK}}` のプレースホルダールールを追加**

placeholder rules 節の `{{REVIEW_BLOCK}}` ルール（```` で囲まれた PHASE A-R ブロック）の終了直後・`- Read ~/.claude/cmux-team-dispatch-task/runners.json and check whether any runner` の前に、以下をまるごと挿入:

`````markdown
- `{{CODE_REVIEW_BLOCK}}` → **Phase A-R と同一条件**（Step 1g の `REVIEW_ENABLED` が true）のときのみ、
  以下のブロック全体を焼き込む。disabled のときは空文字列:

  ````
  PHASE B-R — Post-implementation code review (REQUIRED before the PR is created):
    Enabled together with Phase A-R. Review point id: "code". Findings file:
    <EXISTING_STATUS_DIR>/review/code-round-<N>.md — the LAST line MUST be exactly
    'VERDICT: approve' or 'VERDICT: needs_work'. Max 3 rounds.

    [IF "sonnet" or "codex" was chosen in Phase B — YOU become the code reviewer]
      This adjusts the Phase B branches above:
      a. Prewarm path only — REQUEST_TEXT: use this extended version instead
         (fill every <...> before sending):
           "Read and execute the plan at <PLAN_FILE_PATH>. After all changes are
            committed and BEFORE creating the PR, you MUST get a code review
            approval. Round N starts at 1, max 3 rounds. Each round:
            (1) send the review request. If <TEAM> is non-empty AND the file
                $HOME/.agents/skills/agmsg/run/ready.<TEAM>__<task-slug> exists, run:
                  ~/.agents/skills/agmsg/scripts/send.sh <TEAM> <your-agent-name> <task-slug> '<request text>'
                otherwise run:
                  /Applications/cmux.app/Contents/Resources/bin/cmux send --surface <REVIEWER_SURFACE> '<request text>'
                  /Applications/cmux.app/Contents/Resources/bin/cmux send-key --surface <REVIEWER_SURFACE> return
                where <request text> is: code review round N: review the committed
                changes on this branch against the plan at <PLAN_FILE_PATH>; write
                findings to <EXISTING_STATUS_DIR>/review/code-round-N.md whose LAST
                line must be VERDICT: approve or VERDICT: needs_work. From round 2
                append your rebuttals to the findings you rejected, with reasons.
            (2) wait by polling <EXISTING_STATUS_DIR>/review/code-round-N.md every
                5 seconds up to 15 minutes for a VERDICT line.
            (3) On VERDICT: approve, create the PR and finish per the instructions
                below. On VERDICT: needs_work, apply the findings you judge valid,
                commit, and start round N+1. If round 3 still ends with needs_work:
                if you can ask the user interactively (AskUserQuestion), ask whether
                to proceed or run one more round; otherwise note the unresolved
                findings in the PR body and proceed. If the verdict file never
                appears, re-send the same round once; on a second timeout, ask via
                AskUserQuestion if you can (再依頼 / レビュー省略して PR 作成);
                otherwise skip the review and note that in the PR body.
            After the PR is created (or all changes are merged per the plan), run
            /exit (claude) or end the session (codex). Do not leave it idle."
         Placeholder values: <REVIEWER_SURFACE> = your own $CMUX_SURFACE_ID (YOU are
         the reviewer), <TEAM> = the TEAM value given above (empty in send-message
         mode — then always use the cmux send path), <your-agent-name> =
         <task-slug>-sonnet or <task-slug>-codex (whichever standby you dispatched to).
      b. After touching .deferred (prewarm step 4 / spawn fallback): do NOT exit.
         Run mkdir -p "<EXISTING_STATUS_DIR>/review", then END YOUR TURN and
         idle-wait for the implementer's review requests (they arrive as an agmsg
         push or as text typed into this pane). Do not poll or busy-wait.
      c. When the round-N request arrives: review the implementation — the branch
         commits (git log) and the full diff against the branch point (e.g.
         git diff main...HEAD) — against the plan at <PLAN_FILE_PATH>. Judge
         correctness, plan conformance, and obvious quality issues. Write your
         findings as markdown to <EXISTING_STATUS_DIR>/review/code-round-<N>.md;
         the LAST line MUST be exactly 'VERDICT: approve' or 'VERDICT: needs_work'.
         approve = ready to become a PR. Consider the implementer's rebuttals —
         do not blindly repeat rejected findings.
      d. After writing needs_work → END YOUR TURN and idle-wait for the next round.
         After writing approve → exit THIS session (.deferred is already in place,
         so your wrapper stays silent; the implementer pane's wrapper owns status.json).
      e. Orphan guard: if the implementer finishes without ever requesting a review,
         you simply stay idle — that is acceptable. The parent closes all panes at
         the final all-tasks-complete cleanup, and status.json is still owned by the
         implementer's wrapper.

    [IF "opus 1m" was chosen in Phase B — the codex review pane reviews your code]
      After implementation is committed and BEFORE creating the PR, run the SAME
      Round loop as PHASE A-R once more with point id "code", reusing REVIEW_SURFACE
      and REVIEW_DELIVERY from the PHASE A-R Setup. Differences from a document round:
        - Request text: ask for a review of the committed changes on this branch
          (git log / git diff against the branch point) against the plan at
          <PLAN_FILE_PATH>, findings to <EXISTING_STATUS_DIR>/review/code-round-<N>.md.
        - Round 3 needs_work → ask via AskUserQuestion:
            Q: "コードレビューで 3 往復しても approve が出ませんでした。残りの指摘: <要約>。どうしますか？"
              1. このまま PR 作成 — 未解決指摘を PR 本文に注記して進む
              2. さらに修正 — もう 1 往復続ける（再度 needs_work なら再質問）
        - Review pane unavailable (the PHASE A-R Setup spawn failed and review was
          skipped) → skip this code review too and proceed to the PR — review is a
          quality gate, not a dispatch blocker.

    VIOLATION: When this block is present, do NOT create the PR before the code
    review reached approve or one of the explicit fallbacks above was taken.
  ````
`````

- [ ] **Step 5: `{{CODEX_BEHAVIOR_BLOCK}}` ルール内の同型 2 か所を更新**

(a) prewarm 経路 step 4。

旧:
```
              4. touch "<EXISTING_STATUS_DIR>/.deferred" then exit THIS session.
```

新:
```
              4. touch "<EXISTING_STATUS_DIR>/.deferred". IF the PHASE B-R block
                 exists below, do NOT exit — switch to the reviewer role it defines.
                 OTHERWISE exit THIS session.
```

(b) spawn フォールバック。

旧:
```
                  [--split-from <SURFACE_ID> --parent-workspace <WS_ID>]  # split layout のみ
                  <task-slug>-exec
              Then write the deferred sentinel and exit:
                touch "<EXISTING_STATUS_DIR>/.deferred"
```

新:
```
                  [--split-from <SURFACE_ID> --parent-workspace <WS_ID>]  # split layout のみ
                  [--review-config "<EXISTING_STATUS_DIR>/review/code-review.json"]  # PHASE B-R があるときのみ
                  <task-slug>-exec
              IF the PHASE B-R block exists below, BEFORE the launch above write the
              reviewer wiring file exactly as in the sonnet branch (mkdir -p the
              review dir, then jq -n {reviewer_surface: $CMUX_SURFACE_ID,
              review_dir: <EXISTING_STATUS_DIR>/review} > .../review/code-review.json).
              Then write the deferred sentinel:
                touch "<EXISTING_STATUS_DIR>/.deferred"
              IF the PHASE B-R block exists below, do NOT exit — switch to the
              reviewer role it defines. OTHERWISE exit.
```

- [ ] **Step 6: 検証**

```bash
cd apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task
grep -c "CODE_REVIEW_BLOCK" SKILL.md
# 期待: 3 以上 (テンプレート内 1 + プレースホルダー一覧 1 + ルール定義 1)
grep -n "PHASE B-R" SKILL.md | head
# 期待: ブロック本文と分岐注記がヒット
grep -n "code-round" SKILL.md | head
# 期待: PHASE B-R ブロック内で code-round-<N>.md / code-round-N.md 表記
grep -n "review-config" SKILL.md
# 期待: sonnet spawn / codex spawn の 2 経路でヒット
```

- [ ] **Step 7: Commit**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md
git commit -m "feat(cmux-team-dispatch-task): SKILL.md に Phase B-R (実装後コードレビュー) ブロックを追加"
```

---

### Task 3: guide-ja.md 同期

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md`

**Interfaces:**
- Consumes: Task 2 の Phase B-R 用語・数値（`code` / `code-round-<N>.md` / 3 往復 / 5 秒・15 分 / `code-review.json`）。内容はここに全文を示すのでタスク単体で完結する。

- [ ] **Step 1: 「主な特徴」と config 説明を更新**

(a) 19〜20 行付近の特徴 bullet（「必須モデル選択フロー」「Phase A-R（codex plan/spec レビュー）」）の Phase A-R bullet の直後に追加:

```
- **Phase B-R（実装後コードレビュー）**: `review_mode: on` のとき、実装完了後・PR 作成前に
  コードレビューを挟む。sonnet / codex 実装 → 計画を立てた opus ペインがレビュー、opus 1m
  実装 → codex レビューペインがレビュー。approve が出るまで実装者が修正（最大 3 往復）
```

(b) Config スキーマ節の `review_mode` 説明（536 行付近）。

旧（行頭から）:
```
- `review_mode`: Phase A-R（codex plan/spec レビュー）の制御（`"on"` / `"off"` / `"ask"`
```

新（同じ行の続きは保持したまま、括弧内だけ拡張）:
```
- `review_mode`: Phase A-R（codex plan/spec レビュー）と Phase B-R（実装後コードレビュー）の制御（`"on"` / `"off"` / `"ask"`
```

(c) 「子セッションのモデル選択フロー（必須）」冒頭の説明（1086 行付近）。

旧:
```
（Phase A-R は `review_mode: on` のときのみ Phase A と Phase B の間に挟まる）。
```

新:
```
（Phase A-R は `review_mode: on` のときのみ Phase A と Phase B の間に挟まり、同条件で
Phase B-R が実装完了後・PR 作成前に挟まる）。
```

- [ ] **Step 2: Phase B の prewarm 手順 3・4 と spawn フォールバックを更新**

(a) prewarm 分岐の手順 3 冒頭（1170 行付近）。

旧:
```
3. 実行指示（`Read and execute the plan at <PLAN_FILE_PATH>. ... 完了後は /exit`）を送信する。
```

新:
```
3. 実行指示（`Read and execute the plan at <PLAN_FILE_PATH>. ... 完了後は /exit`。
   **Phase B-R 有効時は「PR 作成前にコードレビュー approve を得る」プロトコル入りの拡張版**）を送信する。
```

(b) 手順 4（1181 行付近）。

旧:
```
4. `touch "<EXISTING_STATUS_DIR>/.deferred"` してこのセッションを exit
```

新:
```
4. `touch "<EXISTING_STATUS_DIR>/.deferred"`。Phase B-R 有効時は exit **せず**、レビュアー
   として idle 待機する（下記「Phase B-R」参照）。無効時はこのセッションを exit
```

(c) spawn フォールバックのコード例（1189〜1204 行付近）の `[--split-from ...]` 行の直後に 1 行追加し、末尾コメントを更新。

旧:
```bash
  [--split-from <SURFACE_ID> --parent-workspace <WS_ID>]  # split のみ
  <task-slug>-exec

# spawn 完了後、自身は移譲シグナルを書いて exit
touch "<EXISTING_STATUS_DIR>/.deferred"
```

新:
```bash
  [--split-from <SURFACE_ID> --parent-workspace <WS_ID>]  # split のみ
  [--review-config "<EXISTING_STATUS_DIR>/review/code-review.json"]  # Phase B-R 有効時のみ
  <task-slug>-exec

# Phase B-R 有効時は spawn 前にレビュー配線ファイルを書いておく (Child 自身がレビュアー):
#   mkdir -p "<EXISTING_STATUS_DIR>/review"
#   jq -n --arg s "$CMUX_SURFACE_ID" --arg d "<EXISTING_STATUS_DIR>/review" \
#     '{reviewer_surface: $s, review_dir: $d}' > "<EXISTING_STATUS_DIR>/review/code-review.json"

# spawn 完了後、自身は移譲シグナルを書く。Phase B-R 有効時は exit せずレビュアーとして待機、
# 無効時は exit
touch "<EXISTING_STATUS_DIR>/.deferred"
```

- [ ] **Step 3: 「### Phase B-R — 実装後コードレビュー（review_mode: on のときのみ）」セクションを新設**

spawn フォールバック節の末尾（「孫セッションの runner wrapper が `status.json` を…」の段落の後、`### 前提条件` の前）に挿入:

```markdown
### Phase B-R — 実装後コードレビュー（review_mode: on のときのみ）

実装完了（コミット済み）後・**PR 作成前**にコードレビューを挟む。有効化条件は Phase A-R と
完全に同一（新しい config キーは無い）。レビューポイント id は `code`、findings は
`<STATUS_DIR>/review/code-round-<N>.md`（末尾 `VERDICT: approve` / `VERDICT: needs_work`）、
最大 3 往復 — Phase A-R と同一プロトコル。

| Phase B の選択 | レビュアー | 仕組み |
|---------------|-----------|--------|
| sonnet / codex | **計画を立てた opus ペイン**（Child） | Child は `.deferred` を touch した後 exit せず idle 待機。実装者が各ラウンドでレビューを依頼（agmsg watcher 生存時は `send.sh`、それ以外は `cmux send`）し、verdict ファイルをポーリング（5 秒間隔・15 分タイムアウト）で待つ。approve を書いた Child はそこで exit |
| opus 1m | **codex レビューペイン**（Phase A-R と同一ペイン・`review_model`） | Phase A-R の Round loop をポイント id `code` でもう 1 周。依頼文が「文書」でなく「ブランチの diff + plan 参照」になる。ペインが利用不可（Phase A-R spawn 失敗済み）ならレビュー省略 |

- **修正責任**: needs_work の指摘は実装者自身が修正して再依頼する（却下する指摘は反論を
  次ラウンドの依頼文に添える）。approve 後に実装者が PR を作成する — PR は常にレビュー済みになる
- **3 往復で approve が出ない**: 実装者が claude セッションなら AskUserQuestion
  （このまま PR 作成 / さらに修正）。codex 実装者は対話質問ができないため、未解決指摘を
  **PR 本文に注記して続行**する
- **タイムアウト**: 同一ラウンドを 1 回だけ再依頼。それでも verdict が出なければレビューを
  省略し PR 本文に注記する
- **status.json 非汚染**: done/error 遷移の所有権は従来どおり実装者ペインの wrapper が持つ。
  レビュアー（Child）は `.deferred` 済みのため exit しても status.json を書かない
- **孤児ガードは不要**: 実装者がレビューを依頼せず終了しても Child は idle のまま無害に残り、
  最終の全タスク完了クリーンアップで他ペインと一緒に閉じられる
- **spawn 経路（prewarm 無効 / split）**: Child が `<STATUS_DIR>/review/code-review.json`
  （`{reviewer_surface, review_dir}`）を書き、`launch-workspace.sh --mode execute --review-config <path>`
  で起動する。wrapper が composed prompt にレビュープロトコル（依頼は常に `cmux send` +
  ファイルポーリング）を追記する
```

- [ ] **Step 4: 検証と Commit**

```bash
grep -n "Phase B-R" apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md | head
# 期待: 特徴 bullet / モデル選択フロー冒頭 / prewarm 手順 / spawn / 新セクションでヒット
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md
git commit -m "docs(cmux-team-dispatch-task): guide-ja.md に Phase B-R を同期"
```

---

### Task 4: README.md 同期

**Files:**
- Modify: `apps/cmux-team-dispatch-task/README.md`

**Interfaces:**
- Consumes: Task 2〜3 と同一の Phase B-R 用語・数値。

- [ ] **Step 1: review_mode 段落とセクション見出しを更新**

(a) 178 行付近。

旧:
```
config にはもう一つ `review_mode` フィールドがある（`"on"` / `"off"` / `"ask"`）。`"on"` / `"off"`
は Phase A-R（codex plan/spec レビュー、後述）を質問なしで恒久的に有効/無効にする。未設定または
```

新:
```
config にはもう一つ `review_mode` フィールドがある（`"on"` / `"off"` / `"ask"`）。`"on"` / `"off"`
は Phase A-R（codex plan/spec レビュー、後述）と Phase B-R（実装後コードレビュー、後述）を
質問なしで恒久的に有効/無効にする。未設定または
```

(b) セクション見出し（185 行付近）。

旧: `## モデル選択フロー (Phase A-R / Phase B)`
新: `## モデル選択フロー (Phase A-R / Phase B / Phase B-R)`

- [ ] **Step 2: Child exit の bullet を更新**

「異なる model」挙動の bullet（223 行付近）。

旧:
```
- Child は spawn 完了後 `<STATUS_DIR>/.deferred` を作成して exit する (Child の runner wrapper は `--defer-status` で起動されており、`.deferred` を検知すると status 上書きをスキップして孫の通知を握り潰さない)
```

新:
```
- Child は spawn 完了後 `<STATUS_DIR>/.deferred` を作成して exit する (Child の runner wrapper は `--defer-status` で起動されており、`.deferred` を検知すると status 上書きをスキップして孫の通知を握り潰さない)。**Phase B-R 有効時は exit せず**、コードレビュアーとして idle 待機し、approve を書いた後に exit する
```

- [ ] **Step 3: 「### Phase B-R — 実装後コードレビュー（オプション）」を新設**

`codex オプションを使う場合は事前に...` の行（226 行付近）の直後・`### plan モードの Phase A-R / B 遵守ゲート` の前に挿入:

```markdown
### Phase B-R — 実装後コードレビュー（オプション）

`review_mode` が `on` のとき（Phase A-R と同一条件）、実装完了後・**PR 作成前**に
コードレビューを挟む。approve が出るまで実装者が修正 → 再依頼を繰り返すため、PR は常に
レビュー済みになる。

- レビュアーは Phase B の選択で切り替わる: **sonnet / codex 実装 → 計画を立てた opus ペイン**
  （計画コンテキストを保持したまま「実装が計画どおりか」を見る）/ **opus 1m 実装 →
  codex レビューペイン**（Phase A-R と同一ペイン。自己レビューのバイアスを避ける。ペイン
  利用不可ならレビュー省略）
- 指摘と verdict は `.dispatch/<slug>/review/code-round-<N>.md`（末尾 `VERDICT:` 行）で受け渡し。
  最大 3 往復・verdict 待ちは 5 秒間隔・15 分タイムアウトのポーリング — Phase A-R と同一プロトコル
- 3 往復で approve が出ない場合、claude 実装者は AskUserQuestion（このまま PR 作成 / さらに修正）、
  codex 実装者は未解決指摘を PR 本文に注記して続行
- prewarm 無効 / split レイアウトでは `launch-workspace.sh --mode execute --review-config <path>`
  が孫の prompt にレビュープロトコルを注入する
```

- [ ] **Step 4: 検証と Commit**

```bash
grep -n "Phase B-R" apps/cmux-team-dispatch-task/README.md | head
git add apps/cmux-team-dispatch-task/README.md
git commit -m "docs(cmux-team-dispatch-task): README.md に Phase B-R を同期"
```

---

### Task 5: CLAUDE.md 同期（メンテナンス手順 + E2E 項目）

**Files:**
- Modify: `apps/cmux-team-dispatch-task/CLAUDE.md`

**Interfaces:**
- Consumes: Task 2〜4 と同一の Phase B-R 用語・数値。

- [ ] **Step 1: メンテナンス手順 8 の Child exit 記述を更新**

旧（項目 8 内の bullet）:
```
   - 異なる model (sonnet / codex) は **`launch-workspace.sh --mode execute` 経由で別 surface を spawn**。孫 surface の runner wrapper が status.json / `cmux wait-for` シグナル / 親通知を担当。Child は `.deferred` を作って exit (runner は `--defer-status` 付きで起動されており `.deferred` を検知して上書きをスキップ)
```

新:
```
   - 異なる model (sonnet / codex) は **`launch-workspace.sh --mode execute` 経由で別 surface を spawn**。孫 surface の runner wrapper が status.json / `cmux wait-for` シグナル / 親通知を担当。Child は `.deferred` を作って exit (runner は `--defer-status` 付きで起動されており `.deferred` を検知して上書きをスキップ)。Phase B-R 有効時は `.deferred` 作成後も exit せずレビュアーとして待機し、approve 後に exit
```

- [ ] **Step 2: メンテナンス手順に項目 17 を追加**

項目 16（plan モードの遵守ゲート）の直後に追加:

```markdown
17. Phase B-R（実装後コードレビュー）が SKILL.md / guide-ja.md / README.md / CLAUDE.md の 4 ファイルで一致しているか確認:
    - 有効化条件は Phase A-R と完全に同一（`REVIEW_ENABLED`。新 config キー無し）。Step 1g の質問文が「レビューモードを使いますか？（Phase A-R … / Phase B-R …）」の両フェーズ言及形であること
    - レビュアーの割り当て: sonnet / codex 実装 → 計画 opus ペイン（Child が `.deferred` touch 後 exit せず idle 待機、approve 書き込み後に exit）/ opus 1m 実装 → codex レビューペイン（Phase A-R と同一ペイン・ポイント id `code`）/ レビューペイン利用不可（Phase A-R spawn 失敗済み）→ レビュー省略
    - プロトコル: findings は `<STATUS_DIR>/review/code-round-<N>.md` 末尾の `VERDICT: approve|needs_work`、最大 3 往復、実装者の verdict 待ちは 5 秒間隔・15 分タイムアウトのファイルポーリング、タイムアウトは同一ラウンド 1 回再依頼 → それでも失敗なら claude 実装者は AskUserQuestion（再依頼 / レビュー省略して PR 作成）、codex 実装者はレビュー省略を PR 本文に注記して続行
    - 3 往復 needs_work: claude 実装者は AskUserQuestion（このまま PR 作成 / さらに修正）、codex 実装者は PR 本文に注記して続行
    - status.json の done/error 遷移は従来どおり実装者ペインの wrapper が所有。実装者がレビューを依頼せず終了しても Child は idle のまま残り、最終クリーンアップで閉じる（孤児ガード用の追加機構は無い）
    - spawn 経路: Child が `<STATUS_DIR>/review/code-review.json`（`{reviewer_surface, review_dir}`）を書き、`launch-workspace.sh --mode execute --review-config <path>` で孫を起動。wrapper が composed prompt にプロトコル（依頼は常に `cmux send` + ポーリング）を追記する。`--review-config` は execute モード専用で、usage コメント / SKILL.md / guide-ja.md の使用例が一致していること
```

- [ ] **Step 3: E2E テスト項目を追加**

E2E 項目 28 の直後に追加:

```markdown
29. **Phase B-R (sonnet / codex 実装)**: `review_mode: on` + sonnet（または codex）選択 → 実装者がコミット後・PR 作成前に opus Child へレビュー依頼し、Child が `review/code-round-1.md` に VERDICT を書くこと。needs_work → 実装者が修正して round 2 を依頼し**同じ opus セッション**がレビューすること。approve → PR が作成され、opus Child が exit すること。Child は `.deferred` touch 後も exit せず待機していること
30. **Phase B-R (opus 1m 実装)**: `review_mode: on` + opus 1m 選択 → コミット後・PR 作成前にポイント id `code` の依頼が **Phase A-R と同一の codex レビューペイン**に送られること。レビューペイン spawn 失敗済みの場合はレビューが省略され PR 作成へ進むこと
31. **Phase B-R 無効 / spawn 経路**: `review_mode: off` では Child が従来どおり `.deferred` touch 後すぐ exit し、実行指示にレビュープロトコルが含まれないこと。prewarm 無効時は `--review-config` 付き spawn で孫の inner prompt に `MANDATORY CODE REVIEW` 文が入り、`review/code-review.json` が生成されること。3 往復 needs_work → claude 実装者は AskUserQuestion が出る / codex 実装者は PR 本文に未解決指摘が注記されること
```

- [ ] **Step 4: 検証と Commit**

```bash
grep -n "Phase B-R" apps/cmux-team-dispatch-task/CLAUDE.md | head
git add apps/cmux-team-dispatch-task/CLAUDE.md
git commit -m "docs(cmux-team-dispatch-task): CLAUDE.md に Phase B-R のメンテナンス手順と E2E 項目を追加"
```

---

### Task 6: バージョン bump・spec 追随・最終整合チェック

**Files:**
- Modify: `apps/cmux-team-dispatch-task/.claude-plugin/plugin.json`（version 1.6.2 → 1.6.3）
- Modify: `.claude-plugin/marketplace.json`（cmux-team-dispatch-task の version 1.6.2 → 1.6.3）
- Modify: `docs/superpowers/specs/2026-07-15-post-implementation-code-review-design.md`（実装で確定した 2 点を追随）

**Interfaces:**
- Consumes: Task 1〜5 の全成果物。

- [ ] **Step 1: バージョンを 1.6.3 に同期**

`apps/cmux-team-dispatch-task/.claude-plugin/plugin.json` の `"version": "1.6.2"` と、ルート `.claude-plugin/marketplace.json` の cmux-team-dispatch-task エントリの `"version": "1.6.2"` をどちらも `"1.6.3"` に変更。

- [ ] **Step 2: spec を実装に追随させる（2 点）**

spec の「spawn 経路」節を実装どおりに修正:
- `code-review.json` のスキーマを `{ "reviewer_surface": "...", "review_dir": "..." }` に簡約（`team` / `reviewer_agent` / `delivery` は不要 — spawn 経路の孫は agmsg 未配線のため依頼は常に `cmux send` + ファイルポーリング）
- 「実行モデル別の詳細」の実装者 verdict 待ちを「ファイルポーリングのみ（agmsg push は使わない）」に統一

- [ ] **Step 3: 最終整合チェック**

```bash
jq . apps/cmux-team-dispatch-task/.claude-plugin/plugin.json > /dev/null && echo OK
jq . .claude-plugin/marketplace.json > /dev/null && echo OK
bash -n apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh && echo OK
# 4 ファイル整合: 主要キーワードが 4 ファイル全部に存在すること
for f in apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md \
         apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md \
         apps/cmux-team-dispatch-task/README.md \
         apps/cmux-team-dispatch-task/CLAUDE.md; do
  for kw in "Phase B-R" "code-round" "review-config"; do
    grep -q "$kw" "$f" || echo "MISSING: $kw in $f"
  done
done
# 期待: MISSING 出力なし
grep -o '"version": "[^"]*"' apps/cmux-team-dispatch-task/.claude-plugin/plugin.json
grep -A3 '"name": "cmux-team-dispatch-task"' .claude-plugin/marketplace.json | grep version
# 期待: どちらも 1.6.3
```

- [ ] **Step 4: Commit**

```bash
git add apps/cmux-team-dispatch-task/.claude-plugin/plugin.json .claude-plugin/marketplace.json \
  docs/superpowers/specs/2026-07-15-post-implementation-code-review-design.md
git commit -m "chore(cmux-team-dispatch-task): v1.6.3 — Phase B-R 追加のバージョン同期と spec 追随"
```

---

## E2E 検証（実装完了後・cmux 実機で手動）

自動テストでは検証できないため、CLAUDE.md に追加した E2E 項目 29〜31 を実機で確認する:

1. `review_mode: on` + sonnet 選択で、PR 作成前に opus Child がコードレビューを行い、approve 後に PR が作られること
2. `review_mode: on` + opus 1m 選択で、codex レビューペインに `code` ポイントの依頼が送られること
3. `review_mode: off` で現行フローと完全一致すること（Child 即 exit・レビュープロトコルなし）
