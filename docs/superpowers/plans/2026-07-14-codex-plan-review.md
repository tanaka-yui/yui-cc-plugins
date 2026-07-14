# Phase A-R (codex plan/spec レビュー) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** cmux-team-dispatch-task の Phase A（opus の plan/spec 作成）と Phase B（実行モデル選択）の間に、codex（`review_model`、例: gpt-5.6-sol）による approve までのレビューループ **Phase A-R** を新設する。

**Architecture:** レビューは専用ペイン（prewarm 有効時は 2×2 グリッドの右上、無効時はオンデマンド split）で走る素の codex セッション。verdict は `<STATUS_DIR>/review/<point>-round-<N>.md` 末尾の `VERDICT:` 行によるファイル受け渡し。依頼配送は prewarm.json の `review.delivery` で agmsg / cmux-send に分岐。このプラグインの「エンジン」は SKILL.md のプロンプト指示なので、実装の主体は SKILL.md 編集 + 2 スクリプトの拡張 + 3 ドキュメント同期。

**Tech Stack:** bash (macOS bash 3.2 互換), jq, cmux CLI, markdown (SKILL.md プロンプトエンジン)

**Spec:** `docs/superpowers/specs/2026-07-14-codex-plan-review-design.md`（全要件の SoT。各タスク実装前に必読）

## Global Constraints

- **4 ファイル整合ルール**: モデル選択フロー改変は SKILL.md / guide-ja.md / README.md / CLAUDE.md を**同時に**一致させる（`apps/cmux-team-dispatch-task/CLAUDE.md` 冒頭の絶対ルール）。Task 3-8 がこれを分担するが、**Task 8 完了まで push / PR 禁止**。
- **言語**: ドキュメント・コメント・コミットメッセージは日本語、コード（変数名・フラグ）は英語。
- **bash 3.2 互換**: 空になりうる配列の展開は `${arr[@]+"${arr[@]}"}` イディオム必須（prewarm-panes.sh:130-132 のコメント参照）。`set -euo pipefail` 維持。
- **後方互換**: `review_model` 未設定 / `review_mode: off` のとき、全ファイルの挙動・レイアウトは現行と完全一致。
- **standby wrapper 規約**: レビューペインは `.assigned-<name>` を**一切 touch しない**。これにより wrapper は exit 時に status.json を書かない（launch-workspace.sh:527 の既存ガード）。
- 有効化 3 条件: ① runners.json に `engine: "codex"` runner ② その runner に `review_model` ③ config の `review_mode: "on"`。
- レビューポイント: plan モード = `plan` の 1 点 / superpowers モード = `spec` + `plan` の 2 点。各ポイント最大 3 往復、approve は何ラウンド目でも即終了。
- 作業ディレクトリ: リポジトリルート。パスは `apps/cmux-team-dispatch-task/` 配下。

---

### Task 1: launch-workspace.sh — `--mode review` / `--standby-split-direction` / codex `--model`

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh`

**Interfaces:**
- Consumes: 既存の `--mode standby` 実装（standby と同一の wrapper 挙動を review が継承する）
- Produces: `--mode review`（standby と同じ配置・wrapper 挙動。`.assigned-<name>` 非使用前提）、`--standby-split-direction right|down`（default: down。standby/review の split 方向）、codex engine への `--model '<X>'` 付与（standby/review モードのみ）。Task 2 と SKILL.md の `{{REVIEW_BLOCK}}`（Task 4）がこれらを呼ぶ。

- [ ] **Step 1: ヘッダー usage コメントを更新**

9 行目付近 `--mode plan|superpowers|execute|standby` の行とその説明を以下に置換（standby 説明の直後に review と direction を追記）:

```bash
#   --mode plan|superpowers|execute|standby|review  Claude launch mode (default: plan).
```

standby の説明ブロック（`wrapper は <STATUS_DIR>/.assigned-<workspace-name> が存在するときだけ exit 時に status.json を更新する` の行）の直後に追加:

```bash
#                                      review = Phase A-R レビューペイン用モード。挙動は standby と
#                                      同一 (.assigned-<name> が無い限り wrapper は status.json を
#                                      書かない) だが、レビューペインは .assigned を一切使わない
#                                      前提のモード。codex engine では --model を反映する
#   --standby-split-direction right|down  standby/review split 配置の分割方向 (default: down)
```

- [ ] **Step 2: 引数パースを拡張**

`--mode` の validation（117-118 行）を置換:

```bash
      [[ "$MODE" == "plan" || "$MODE" == "superpowers" || "$MODE" == "execute" || "$MODE" == "standby" || "$MODE" == "review" ]] \
        || die "--mode must be 'plan', 'superpowers', 'execute', 'standby', or 'review'"
```

同 115 行の die メッセージも `"--mode requires plan, superpowers, execute, standby, or review"` に変更。

変数初期化部（87 行 `STANDBY_SPLIT_FROM=""` の直後）に追加:

```bash
STANDBY_SPLIT_DIRECTION="down"
```

`--standby-split-from` の case（126-129 行）の直後に case を追加:

```bash
    --standby-split-direction)
      [[ $# -lt 2 ]] && die "--standby-split-direction requires right or down"
      STANDBY_SPLIT_DIRECTION="$2"
      [[ "$STANDBY_SPLIT_DIRECTION" == "right" || "$STANDBY_SPLIT_DIRECTION" == "down" ]] \
        || die "--standby-split-direction must be 'right' or 'down'"
      shift 2 ;;
```

- [ ] **Step 3: モード別 validation / 分岐に review を追加**

以下の 7 箇所で `"$MODE" == "standby"` の条件に review を加える（`.deferred` / `.assigned` まわりのロジックは無変更）:

1. 227 行 `elif [[ "$MODE" == "standby" ]]; then` → `elif [[ "$MODE" == "standby" || "$MODE" == "review" ]]; then`（die メッセージ内の `--mode is standby` は `--mode is standby/review` に）
2. 240 行 `if [[ -n "$MODEL" && "$MODE" != "execute" && "$MODE" != "standby" ]]` → `&& "$MODE" != "review"` を追加
3. 341 行 `if [[ "$MODE" == "execute" || "$MODE" == "standby" ]]; then`（prompt file skip）→ `|| "$MODE" == "review"` を追加
4. 371 行 `if [[ "$MODE" == "standby" ]]; then`（PROMPT_TEXT passthrough）→ `|| "$MODE" == "review"` を追加
5. 465 行 `[[ "$MODE" == "standby" ]] && STANDBY_FLAG=1` → `[[ "$MODE" == "standby" || "$MODE" == "review" ]] && STANDBY_FLAG=1`
6. 578 行 `if [[ "$MODE" == "standby" && -n "$STANDBY_IN" ]]; then`（split 配置）→ `if [[ ( "$MODE" == "standby" || "$MODE" == "review" ) && -n "$STANDBY_IN" ]]; then`
7. 657 行 `if [[ -n "$STATUS_DIR" && "$MODE" != "standby" ]]; then`（初期 launched status 書き込み）→ `&& "$MODE" != "review"` を追加。**これを忘れるとレビューペイン spawn が子タスクの status.json を "launched" で上書きする（クリティカル）**

- [ ] **Step 4: split 方向を可変にする**

584 行の standby split 作成を置換:

```bash
  log "cmux" "creating standby pane (split $STANDBY_SPLIT_DIRECTION from $STANDBY_SPLIT_FROM) in $STANDBY_IN"
  SPLIT_OUTPUT=$("$CMUX" new-split "$STANDBY_SPLIT_DIRECTION" \
    --workspace "$STANDBY_IN" \
    --surface "$STANDBY_SPLIT_FROM" 2>/dev/null) || die "failed to create standby split pane"
```

- [ ] **Step 5: codex engine に --model を反映（standby/review のみ）**

codex 分岐の standby ブロック（410-417 行）を置換:

```bash
    elif [[ "$MODE" == "standby" || "$MODE" == "review" ]]; then
      # codex standby/review: prompt なしで idle 起動。実行指示の配送は prewarm.json の delivery 値に
      # 従う (agmsg 配線成功時は agmsg、それ以外・send-message モードは cmux send)。
      # review ペインは --model (review_model) を反映する
      CODEX_MODEL_FLAG=""
      [[ -n "$MODEL" ]] && CODEX_MODEL_FLAG=" --model '$MODEL'"
      if [[ -n "$PROMPT_TEXT" ]]; then
        CORE_CMD="$RUNNER_COMMAND$CODEX_MODEL_FLAG --dangerously-bypass-approvals-and-sandbox '$PROMPT_TEXT'"
      else
        CORE_CMD="$RUNNER_COMMAND$CODEX_MODEL_FLAG --dangerously-bypass-approvals-and-sandbox"
      fi
```

claude 分岐の standby ブロック条件（435 行）も `elif [[ "$MODE" == "standby" || "$MODE" == "review" ]]; then` に変更（本体は無変更 — CLAUDE_EXTRA_FLAGS が既に --model を処理）。

- [ ] **Step 6: 構文と validation の検証**

```bash
bash -n apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh
# Expected: 出力なし (exit 0)

S=apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh
bash "$S" --mode review test-review 2>&1 | grep -- '--cwd is required'
# Expected: "Error: --cwd is required when --mode is standby/review ..." が出る (validation は cmux チェックより先)

bash "$S" --mode review --standby-split-direction sideways --cwd /tmp x 2>&1 | grep 'must be'
# Expected: "--standby-split-direction must be 'right' or 'down'"

bash "$S" --mode banana x 2>&1 | grep 'review'
# Expected: die メッセージに 'review' が含まれる
```

- [ ] **Step 7: Commit**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh
git commit -m "feat(cmux-team-dispatch-task): launch-workspace.sh に --mode review / --standby-split-direction / codex --model を追加"
```

---

### Task 2: prewarm-panes.sh — `--review-model` と 2×2 グリッド

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh`

**Interfaces:**
- Consumes: Task 1 の `--mode review` / `--standby-split-direction right` / codex `--model`
- Produces: `--review-model <model>` フラグ（`--codex-runner` 必須）。設定時: 2×2 グリッド（opus 右に review、sonnet 右に codex）+ prewarm.json に `review: {surface_id, agent: "<slug>-review", delivery}` キー。未設定時: 現行の縦積みと同一

- [ ] **Step 1: ヘッダーと引数パース**

ヘッダーコメント 2-3 行目を更新:

```bash
# Pre-warm standby panes: タスク workspace に standby ペイン群を事前起動する
# (--review-model 無し: 縦積み 上 opus / 中 sonnet / 下 codex。
#  --review-model 有り: 2×2 グリッド 左上 opus / 右上 codex review / 左下 sonnet / 右下 codex)
```

Usage コメントの両モード例に `[--review-model <model>]` を `[--codex-runner <name>]` の直後の行として追加。内部処理コメントの 4-5 を更新:

```bash
#   4. sonnet / codex を split で配置 (--review-model 有りなら 2×2、無しなら縦積み)
#   4.5 (--review-model 時) codex review ペインを opus の右に split 配置
#   5. <STATUS_DIR>/prewarm.json を書き込む (review キーは --review-model 時のみ)
```

変数初期化（56 行 `CODEX_RUNNER=""` の直後）:

```bash
REVIEW_MODEL=""
```

`--codex-runner` の case（80-82 行）の直後に case を追加:

```bash
    --review-model)
      [[ $# -lt 2 ]] && die "--review-model requires a model name"
      REVIEW_MODEL="$2"; shift 2 ;;
```

Validation セクション（110 行 `--status-dir is required` の直後）に追加:

```bash
if [[ -n "$REVIEW_MODEL" && -z "$CODEX_RUNNER" ]]; then
  die "--review-model requires --codex-runner"
fi
```

- [ ] **Step 2: agmsg 配線に review を追加**

Step 2 セクションの `CODEX_DELIVERY="cmux-send"`（157 行）の直後に:

```bash
REVIEW_DELIVERY="cmux-send"
```

agmsg ブロック内、codex 配線の if ブロック（172-185 行）の直後（`fi` の内側、`MESSAGE_TYPE == agmsg` ブロックの末尾）に追加:

```bash
  if [[ -n "$REVIEW_MODEL" ]]; then
    # review ペインも codex セッション。delivery 配線 (delivery.sh set) は worktree × type 単位
    # なので codex standby の結果を共有する。join は agent 名の登録のために別途必要
    if bash "$AGMSG_DIR/join.sh" "$AGMSG_TEAM" "$SLUG-review" codex "$CWD" >&2 2>/dev/null; then
      REVIEW_DELIVERY="$CODEX_DELIVERY"
    else
      log "agmsg" "review join failed (shim not installed?); falling back to cmux-send"
    fi
  fi
```

- [ ] **Step 3: codex standby の split 方向を分岐**

Step 5 の codex 起動（250-259 行）で、`--standby-split-from "$SONNET_SURFACE"` の直後の行に方向フラグを条件付きで加える。配列で組む:

```bash
  CODEX_DIRECTION_FLAGS=()
  [[ -n "$REVIEW_MODEL" ]] && CODEX_DIRECTION_FLAGS=(--standby-split-direction right)
  log "prewarm" "launching codex standby pane for $SLUG"
  CODEX_RESULT=$(bash "$SCRIPT_DIR/launch-workspace.sh" \
    --cwd "$CWD" \
    --mode standby \
    --standby-in "$WORKSPACE" \
    --standby-split-from "$SONNET_SURFACE" \
    ${CODEX_DIRECTION_FLAGS[@]+"${CODEX_DIRECTION_FLAGS[@]}"} \
    --runner "$CODEX_RUNNER" \
    --status-dir "$STATUS_DIR" \
    ${NOTIFY_FLAGS[@]+"${NOTIFY_FLAGS[@]}"} \
    ${AGMSG_FLAGS_CODEX[@]+"${AGMSG_FLAGS_CODEX[@]}"} \
    "$SLUG-codex") || die "failed to launch codex standby pane"
```

（geometry: sonnet は BASE から down → 2 行。codex は sonnet から right → 下段 2 分割。review は BASE から right → 上段 2 分割。cmux new-split は対象ペインを半分にするので 4 象限は均等になる）

- [ ] **Step 4: review ペイン起動（新 Step 5.5）**

Step 5 の codex ブロック（`fi`、262 行）の直後・Step 6 の前に追加:

```bash
# --- Step 5.5: codex review ペイン (--review-model 時のみ、opus の右に split 配置) ---
# standby と同じ wrapper だが .assigned-<slug>-review は誰も touch しない前提 —
# close しても status.json を汚さない。初期 prompt は codex standby と同じく常に無し。

REVIEW_SURFACE=""

if [[ -n "$REVIEW_MODEL" ]]; then
  log "prewarm" "launching codex review pane for $SLUG"
  REVIEW_RESULT=$(bash "$SCRIPT_DIR/launch-workspace.sh" \
    --cwd "$CWD" \
    --mode review \
    --standby-in "$WORKSPACE" \
    --standby-split-from "$BASE_SURFACE" \
    --standby-split-direction right \
    --runner "$CODEX_RUNNER" \
    --model "$REVIEW_MODEL" \
    --status-dir "$STATUS_DIR" \
    ${NOTIFY_FLAGS[@]+"${NOTIFY_FLAGS[@]}"} \
    "$SLUG-review") || die "failed to launch codex review pane"
  REVIEW_SURFACE=$(echo "$REVIEW_RESULT" | jq -r '.surface_id // empty')
  [[ -n "$REVIEW_SURFACE" ]] || die "failed to parse review pane output"
fi
```

- [ ] **Step 5: prewarm.json に review キーを追加**

Step 6 の PREWARM_JSON 組み立て（267-276 行）を置換:

```bash
PREWARM_JSON=$(jq -n \
  --arg os "$OPUS_SURFACE" \
  --arg ss "$SONNET_SURFACE" \
  --arg cs "$CODEX_SURFACE" \
  --arg rs "$REVIEW_SURFACE" \
  --arg slug "$SLUG" \
  --arg dc "$CLAUDE_DELIVERY" \
  --arg dx "$CODEX_DELIVERY" \
  --arg dr "$REVIEW_DELIVERY" \
  '(if $os != "" then {opus: {surface_id: $os, agent: $slug, delivery: $dc}} else {} end)
   + {sonnet: {surface_id: $ss, agent: ($slug + "-sonnet"), delivery: $dc}}
   + (if $cs != "" then {codex: {surface_id: $cs, agent: ($slug + "-codex"), delivery: $dx}} else {} end)
   + (if $rs != "" then {review: {surface_id: $rs, agent: ($slug + "-review"), delivery: $dr}} else {} end)')
```

- [ ] **Step 6: 検証**

```bash
bash -n apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh
# Expected: 出力なし (exit 0)

P=apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh
bash "$P" --review-model gpt-5.6-sol --cwd /tmp --slug x --status-dir /tmp/x --workspace w --base-surface s 2>&1 | grep 'requires --codex-runner'
# Expected: "Error: --review-model requires --codex-runner"

# prewarm.json 組み立ての jq 式を単体検証:
jq -n --arg os "" --arg ss "surface:2" --arg cs "surface:3" --arg rs "surface:4" \
  --arg slug demo --arg dc agmsg --arg dx cmux-send --arg dr cmux-send \
  '(if $os != "" then {opus: {surface_id: $os, agent: $slug, delivery: $dc}} else {} end)
   + {sonnet: {surface_id: $ss, agent: ($slug + "-sonnet"), delivery: $dc}}
   + (if $cs != "" then {codex: {surface_id: $cs, agent: ($slug + "-codex"), delivery: $dx}} else {} end)
   + (if $rs != "" then {review: {surface_id: $rs, agent: ($slug + "-review"), delivery: $dr}} else {} end)'
# Expected: sonnet/codex/review の 3 キーを持つ JSON。review.agent == "demo-review"
```

- [ ] **Step 7: Commit**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh
git commit -m "feat(cmux-team-dispatch-task): prewarm-panes.sh に --review-model を追加 — 2×2 グリッドと prewarm.json review キー"
```

---

### Task 3: SKILL.md — runners.json `review_model` と config `review_mode` 解決

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md`（Step 1f: 192-281 行付近 / Step 1g: 283-363 行付近）

**Interfaces:**
- Produces: 親セッションが計算する変数 `REVIEW_MODEL` / `CODEX_RUNNER_NAME` / `REVIEW_MODE` / `REVIEW_ENABLED`。Task 4 の placeholder 焼き込みと Task 5 の prewarm 呼び出しが参照する

- [ ] **Step 1: runners.json スキーマに review_model を追記**

Step 1f の schema 例（207-216 行）の codex 行を置換:

```json
    { "name": "codex",   "command": "codex",   "engine": "codex",  "review_model": "gpt-5.6-sol" }
```

Field meanings リスト（218-222 行）の `engine` の直後に追加:

```markdown
- `review_model` (optional, `engine: codex` の runner のみ): Phase A-R (plan/spec レビュー)
  でレビューペインに渡すモデル名。未設定なら Phase A-R は無効
```

- [ ] **Step 2: First-run setup に review_model 質問を追加**

First-run setup のカスタム手順 3（266-274 行）のフィールドリストに追加:

```markdown
   - **engine** (choice: `claude` / `codex`)
   - **review_model** (free text, engine が `codex` のときのみ質問, 例 `gpt-5.6-sol`) —
     plan/spec レビュー (Phase A-R) 用モデル。空回答で省略可
```

- [ ] **Step 3: Step 1g に review_mode 解決ブロックを追加**

Step 1g の agmsg 配線説明（318 行 `**When message_type is agmsg ...**` ブロック）の**前**、config 永続化コード（316 行）の直後に追加:

````markdown
**Resolve review mode (`review_mode`)** — same precedence pattern as `message_type`:

1. ALWAYS resolve `REVIEW_MODEL` from runners.json first (it is needed by step 3's
   `REVIEW_ENABLED` computation regardless of whether the question fires):

   ```bash
   REVIEW_MODEL=$(jq -r '[.runners[] | select(.engine == "codex" and .review_model != null)] | .[0].review_model // empty' \
     ~/.claude/cmux-team-dispatch-task/runners.json 2>/dev/null)
   ```

2. Read `review_mode` from `<project>/.dispatch/config.json`, falling back to
   `~/.claude/cmux-team-dispatch-task/config.json`:

   ```bash
   REVIEW_MODE=$(jq -r '.review_mode // empty' .dispatch/config.json 2>/dev/null)
   [[ -z "$REVIEW_MODE" ]] && REVIEW_MODE=$(jq -r '.review_mode // empty' \
     ~/.claude/cmux-team-dispatch-task/config.json 2>/dev/null)
   ```

   If set (`"on"` / `"off"`), use it silently — do NOT ask.

   If unset:
   - `REVIEW_MODEL` empty → treat as `off`. Do NOT write config (so the question
     fires once a review_model gets configured later).
   - `REVIEW_MODEL` non-empty → ask via AskUserQuestion:
     > plan/spec の codex レビュー (Phase A-R) を有効にしますか？ (Phase A の成果物を codex (`<review_model>`) が approve するまでレビューします)
     Persist BOTH answers (Yes → `"on"`, No → `"off"`) to the global config with the
     same jq merge pattern as `message_type` above (key: `review_mode`).

3. Compute the final flag used by prompt construction (Step 2) and pre-warm:

   ```bash
   # REVIEW_ENABLED: codex runner + review_model + review_mode=on の 3 条件
   REVIEW_ENABLED=false
   [[ -n "$CODEX_CMD" && -n "$REVIEW_MODEL" && "$REVIEW_MODE" == "on" ]] && REVIEW_ENABLED=true
   ```

   (`CODEX_CMD` / `CODEX_RUNNER_NAME` は placeholder rules 節と同じ jq クエリで得る)
````

- [ ] **Step 4: 検証**

```bash
grep -n "review_model\|review_mode\|REVIEW_ENABLED" apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md | head -20
# Expected: Step 1f (schema + field + first-run) と Step 1g (解決フロー) にヒット
```

- [ ] **Step 5: Commit**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md
git commit -m "feat(cmux-team-dispatch-task): SKILL.md Step 1f/1g に review_model スキーマと review_mode 解決フローを追加"
```

---

### Task 4: SKILL.md — `{{REVIEW_BLOCK}}` (Phase A-R) の挿入

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md`（MANDATORY MODEL SELECTION SEQUENCE: 469-640 行付近）

**Interfaces:**
- Consumes: Task 1 の `--mode review` CLI、Task 3 の `REVIEW_ENABLED` / `REVIEW_MODEL` / `CODEX_RUNNER_NAME`
- Produces: 子プロンプトに焼き込まれる Phase A-R の完全な指示テキスト。ファイルプロトコル `<STATUS_DIR>/review/<point>-round-<N>.md` + `VERDICT:` 行

- [ ] **Step 1: テンプレート導入文とプレースホルダー列挙を更新**

469-473 行の説明を置換:

```markdown
3. **Mandatory Model Selection Sequence** (append to EVERY task prompt, regardless of mode).

   This block contains placeholders the parent fills before sending: `{{LAYOUT}}`,
   `{{CODEX_OPTION_LINE}}`, `{{CODEX_BEHAVIOR_BLOCK}}`, `{{REVIEW_BLOCK}}`. See the
   placeholder rules immediately below this template.
```

- [ ] **Step 2: テンプレート本体に Phase A-R 挿入点を追加**

PHASE A ブロック末尾（486 行 `Remember the path of the plan file you wrote — Phase B may hand it off.`）と PHASE B 見出し（488 行）の間に 1 行追加:

```
{{REVIEW_BLOCK}}
```

- [ ] **Step 3: placeholder rules に REVIEW_BLOCK の定義を追加**

Placeholder rules 節の `{{TEAM}}` ルール（575-579 行）の直後に追加:

`````markdown
- `{{REVIEW_BLOCK}}` → **Phase A-R enabled のときのみ**（Step 1g の `REVIEW_ENABLED` が true）、
  以下のブロック全体（`{{REVIEW_MODEL}}` → Step 1g の `REVIEW_MODEL`、`{{CODEX_RUNNER_NAME}}` →
  codex runner の `name` に置換して）を焼き込む。disabled のときは空文字列:

  ````
  PHASE A-R — Plan/Spec review by codex (REQUIRED between Phase A and Phase B):
    Review model: {{REVIEW_MODEL}} (runs in a dedicated review pane — a plain codex
    session with NO status.json ownership; NEVER touch .assigned-<task-slug>-review)

    Review points (run the round loop below at EACH point, in order):
      - plan mode:        one point  — id "plan" (after the plan is written)
      - superpowers mode: two points — id "spec" (after the brainstorming design doc),
                          then id "plan" (after the implementation plan)

    Setup (before the first point only):
      mkdir -p "<EXISTING_STATUS_DIR>/review"
      REVIEW_SURFACE=$(jq -r '.review.surface_id // empty' "<EXISTING_STATUS_DIR>/prewarm.json" 2>/dev/null)
      REVIEW_DELIVERY=$(jq -r '.review.delivery // "cmux-send"' "<EXISTING_STATUS_DIR>/prewarm.json" 2>/dev/null)
      IF REVIEW_SURFACE is empty (prewarm off / split layout), spawn the pane once:
        RESULT=$(zsh <SKILL_DIR>/scripts/launch-workspace.sh \
          --cwd "$PWD" --mode review \
          --standby-in "$CMUX_WORKSPACE_ID" --standby-split-from "$CMUX_SURFACE_ID" \
          --standby-split-direction right \
          --runner {{CODEX_RUNNER_NAME}} --model '{{REVIEW_MODEL}}' \
          --status-dir "<EXISTING_STATUS_DIR>" \
          <task-slug>-review)
        REVIEW_SURFACE=$(echo "$RESULT" | jq -r '.surface_id // empty')
        REVIEW_DELIVERY="cmux-send"
      IF the spawn fails: warn the user, SKIP Phase A-R entirely, and continue to
      Phase B — review is a quality gate, not a dispatch blocker.
      The SAME pane is reused across all points and rounds (it keeps review context).

    Round loop (at point <point>, N = 1, 2, 3):
      1. Compose the request text:
           "Review the <point> document at <ABSOLUTE_DOC_PATH>.
            Reference material: <related file paths — e.g. the spec path when reviewing the plan>.
            This is round <N> (max 3)."
         For N >= 2 append:
           "Previous findings: <EXISTING_STATUS_DIR>/review/<point>-round-<N-1>.md.
            The document was revised in response — check whether concerns were
            addressed (rebuttals are inline below) and look for new issues.
            <your rebuttals to findings you rejected, with reasons>"
         Always append the protocol:
           "Write your findings as markdown to
            <EXISTING_STATUS_DIR>/review/<point>-round-<N>.md.
            The LAST line of that file MUST be exactly 'VERDICT: approve' or
            'VERDICT: needs_work'. approve = the document is ready to implement."
      2. Send the request and wait, branching on REVIEW_DELIVERY:
         IF "agmsg":
           Append to the request: "After writing the file, notify me:
             ~/.agents/skills/agmsg/scripts/send.sh $TEAM <task-slug>-review <task-slug> '[review] <point> round <N> done'"
           ~/.agents/skills/agmsg/scripts/send.sh "$TEAM" <task-slug> <task-slug>-review "<request text>"
           # $TEAM is the TEAM value given above — do NOT re-derive it
           Then END YOUR TURN and idle-wait for the '[review]' push. When it
           arrives, verify the verdict file exists and continue at step 3.
         ELSE ("cmux-send"):
           cmux send --surface "$REVIEW_SURFACE" "<request text>"
           cmux send-key --surface "$REVIEW_SURFACE" return
           Wait by polling the verdict file (5s interval, 15 min timeout):
             F="<EXISTING_STATUS_DIR>/review/<point>-round-<N>.md"
             for i in $(seq 1 180); do
               [[ -f "$F" ]] && grep -qE '^VERDICT: (approve|needs_work)$' "$F" && break
               sleep 5
             done
      3. Read the verdict:
           VERDICT=$(grep -oE 'VERDICT: (approve|needs_work)' "<EXISTING_STATUS_DIR>/review/<point>-round-<N>.md" 2>/dev/null | tail -1)
         - "VERDICT: approve" → this point is done. Move to the next point; after
           the LAST point, close the pane and proceed to Phase B:
             cmux close-surface --surface "$REVIEW_SURFACE"
         - "VERDICT: needs_work" → read the findings. Apply the ones you judge
           valid to the document; collect reasons for the ones you reject (they
           go into the next round's request as rebuttals). Then:
             N < 3  → run round N+1.
             N == 3 → summarize the unresolved findings and ask via AskUserQuestion:
               Q: "codex レビューで 3 往復しても approve が出ませんでした。残りの指摘: <要約>。どうしますか？"
                 1. このまま進む — 残指摘を文書に注記して Phase B へ
                 2. さらに修正 — もう 1 往復レビューを続ける
               "このまま進む" → append the unresolved findings as a note in the
               document, close the pane if this was the last point, and move on.
               "さらに修正" → run one more round; on another needs_work, re-ask.
         - Verdict file missing or has no VERDICT line (timeout) → re-send the
           SAME round's request once. If it times out again, ask via AskUserQuestion:
             Q: "codex レビューが応答しません。どうしますか？"
               1. 再依頼する
               2. レビューを省略して Phase B へ進む
             Option 2 → cmux close-surface --surface "$REVIEW_SURFACE", continue.

    VIOLATION: When this block is present, do NOT start Phase B before every
    review point reached approve or an explicit user decision was made.
  ````
`````

- [ ] **Step 4: 検証**

```bash
grep -c "{{REVIEW_BLOCK}}" apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md
# Expected: 2 (テンプレート挿入点 + placeholder rules 定義)

grep -n "PHASE A-R" apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md | head -3
# Expected: placeholder rules 内の Phase A-R ブロックにヒット

# VERDICT プロトコルの grep 式が実際に動くことをサンドボックスで確認:
mkdir -p /tmp/review-test && printf '# findings\n\nVERDICT: needs_work\n' > /tmp/review-test/plan-round-1.md
grep -oE 'VERDICT: (approve|needs_work)' /tmp/review-test/plan-round-1.md | tail -1
# Expected: "VERDICT: needs_work"
```

- [ ] **Step 5: Commit**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md
git commit -m "feat(cmux-team-dispatch-task): MANDATORY MODEL SELECTION SEQUENCE に Phase A-R ({{REVIEW_BLOCK}}) を追加"
```

---

### Task 5: SKILL.md — Pre-warm セクションの 2×2 対応

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md`（Pre-warm Standby Panes: 749-837 行付近）

**Interfaces:**
- Consumes: Task 2 の `--review-model` / prewarm.json `review` キー、Task 3 の `REVIEW_ENABLED` / `REVIEW_MODEL`

- [ ] **Step 1: レイアウト説明を更新**

760-763 行の段落を置換:

```markdown
When layout is `workspace` AND `PREWARM` is `true`, standby panes are placed
inside each task workspace. Layout depends on Phase A-R (Step 1g `REVIEW_ENABLED`):

- **Phase A-R disabled** (current behavior): vertical stack — top: opus /
  middle: sonnet / bottom: codex (codex only when `runners.json` has an
  `engine: "codex"` runner).
- **Phase A-R enabled**: 2×2 even grid — top-left: opus / top-right: codex
  review pane (idle, `--model <review_model>`) / bottom-left: sonnet /
  bottom-right: codex. The review pane is a plain codex session with NO
  standby-wrapper status ownership (`.assigned-<slug>-review` is never touched).

Everything is delegated to `prewarm-panes.sh`; do not create panes manually.
```

- [ ] **Step 2: 両モードの呼び出し例に --review-model を追加**

send-message モードの例（770-778 行）と agmsg モードの例（788-797 行）の両方で、`[--codex-runner <codex-runner-name>]` の直後の行に追加:

```bash
  [--review-model "$REVIEW_MODEL"] \
```

その直後（agmsg 例の後）に注記を追加:

```markdown
Pass `--review-model` only when Phase A-R is enabled (`REVIEW_ENABLED` from
Step 1g). It requires `--codex-runner`.
```

- [ ] **Step 3: prewarm.json スキーマ例を更新**

822-832 行のスキーマ説明と JSON を置換:

````markdown
prewarm.json schema (written by `prewarm-panes.sh`; `opus` only in agmsg mode,
`codex` only when a codex runner exists, `review` only when `--review-model`
was passed; `delivery` is `"agmsg"` or `"cmux-send"` depending on whether
delivery wiring succeeded):

```json
{
  "opus":   { "surface_id": "surface:N", "agent": "<slug>",        "delivery": "agmsg" },
  "sonnet": { "surface_id": "surface:N", "agent": "<slug>-sonnet", "delivery": "agmsg" },
  "codex":  { "surface_id": "surface:N", "agent": "<slug>-codex",  "delivery": "cmux-send" },
  "review": { "surface_id": "surface:N", "agent": "<slug>-review", "delivery": "cmux-send" }
}
```
````

- [ ] **Step 4: 検証**

```bash
grep -n "review-model\|2×2\|top-right" apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md | head
# Expected: Pre-warm セクション内にヒット (レイアウト説明 / 2 呼び出し例 / スキーマ)
```

- [ ] **Step 5: Commit**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md
git commit -m "feat(cmux-team-dispatch-task): SKILL.md Pre-warm セクションを 2×2 グリッド + review キーに対応"
```

---

### Task 6: guide-ja.md の同期

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md`

**Interfaces:**
- Consumes: Task 3-5 で SKILL.md に入った内容（SoT）。用語・値・フロー順序は SKILL.md と完全一致させる

- [ ] **Step 1: 冒頭の必須モデル選択フロー概要（19 行付近）を更新**

「子セッションは Plan/Brainstorming を opus で実行後、実行フェーズに入る前に必ず…」の文に Phase A-R を追記:

```markdown
- **必須モデル選択フロー**: 子セッションは Plan/Brainstorming を opus で実行後（Phase A-R 有効時は
  codex レビューの approve 後）、実行フェーズに入る前に必ず `opus 1m` / `sonnet` / `codex`（codex runner
  登録時のみ）から実行モデルを選択する
- **Phase A-R（codex plan/spec レビュー）**: `runners.json` の codex runner に `review_model` があり
  config の `review_mode` が `on` のとき、Phase A の成果物（plan モード: plan / superpowers モード:
  spec と plan）を専用ペインの codex がレビューする。approve まで最大 3 往復、超過時はユーザー判断
```

- [ ] **Step 2: 「子セッション runner 設定（runners.json）」セクション（539 行付近）にスキーマと review_model 説明を追加**

schema 例の codex 行を以下に置換:

```json
    { "name": "codex",   "command": "codex",   "engine": "codex",  "review_model": "gpt-5.6-sol" }
```

フィールド説明リストの `engine` の直後に追加:

```markdown
- `review_model`（任意、`engine: codex` の runner のみ）: Phase A-R（plan/spec レビュー）で
  レビューペインに渡すモデル名。未設定なら Phase A-R は無効
```

初回セットアップ（カスタム登録）のフィールドリストに追加:

```markdown
   - **review_model**（自由入力、engine が `codex` のときのみ質問、例 `gpt-5.6-sol`）—
     plan/spec レビュー（Phase A-R）用モデル。空回答で省略可
```

- [ ] **Step 3: config セクション（489-501 行付近）に review_mode を追加**

`prewarm` の説明の後に追加:

```markdown
- `review_mode`: Phase A-R（codex plan/spec レビュー）の有効/無効（`"on"` / `"off"`）。未設定かつ
  `review_model` 付き codex runner が存在する場合のみ初回質問し、Yes/No どちらもグローバル config に
  永続化する。プロジェクト側 `.dispatch/config.json` がグローバルより優先
```

config JSON 例（495 行付近）にも `"review_mode": "on",` を追加。

- [ ] **Step 4: Pre-warm セクション（205-288 行付近）を SKILL.md Task 5 と同内容に更新**

レイアウト説明（縦積み / 2×2 の分岐）、両呼び出し例への `[--review-model "$REVIEW_MODEL"]` 追加、prewarm.json スキーマへの `review` キー追加。日本語で:

```markdown
レイアウトが `workspace` かつ `PREWARM` が `true` のとき、standby ペインの配置は Phase A-R の
有効/無効で分岐する:

- **Phase A-R 無効**（現行どおり）: 縦積み — 上: opus / 中: sonnet / 下: codex（codex は
  `engine: "codex"` runner 登録時のみ）
- **Phase A-R 有効**: 2×2 均等グリッド — 左上: opus / 右上: codex レビューペイン（idle、
  `--model <review_model>`）/ 左下: sonnet / 右下: codex。レビューペインは standby wrapper の
  status 所有権を持たない素の codex セッション（`.assigned-<slug>-review` は誰も touch しない）
```

- [ ] **Step 5: モデル選択フローのセクション（Phase A/B を説明している箇所）に Phase A-R の説明を追加**

`grep -n "Phase A\|Phase B" apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md` で該当セクションを特定し、Phase A と Phase B の間に日本語で挿入:

```markdown
### Phase A-R — codex plan/spec レビュー（review_mode: on のときのみ）

Phase A の成果物を専用ペインの codex（`review_model`）がレビューする。Phase B より前に必ず完了させる。

- **レビューポイント**: plan モード = plan 完成後の 1 回 / superpowers モード = spec（design doc）
  完成後と plan 完成後の 2 回
- **ラウンドループ**（各ポイント最大 3 往復）: 依頼 → codex が
  `<STATUS_DIR>/review/<point>-round-<N>.md` に指摘を書き、末尾に `VERDICT: approve` または
  `VERDICT: needs_work` を記す → approve なら次へ / needs_work なら opus が妥当な指摘を反映
  （反論は次ラウンドの依頼文に理由付きで返す）して再依頼
- **依頼配送**: prewarm.json の `review.delivery` で分岐。`agmsg` → `send.sh` で送信しターンを
  終えて push 待ち / `cmux-send` → `cmux send` + verdict ファイルポーリング（5 秒間隔・15 分
  タイムアウト）
- **3 往復で approve が出ない** → 残指摘を要約して AskUserQuestion（このまま進む / さらに修正）
- **タイムアウト・verdict 不正** → 同一ラウンドを 1 回だけ再依頼。それでも失敗なら
  AskUserQuestion（再依頼 / レビュー省略して Phase B へ）
- **ペイン寿命**: 全ポイントで同一ペインを再利用（文脈保持）。最終 approve（またはユーザー判断）
  後に `cmux close-surface` で閉じる。spawn 失敗時はレビューをスキップして Phase B へ（警告表示）
- **prewarm 無効 / split レイアウト時**: 最初のレビューポイントで
  `launch-workspace.sh --mode review --standby-split-direction right` によりオンデマンド spawn
```

- [ ] **Step 6: 検証と Commit**

```bash
grep -c "Phase A-R" apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md
# Expected: 4 以上 (概要 / config / prewarm / モデル選択フロー)
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md
git commit -m "docs(cmux-team-dispatch-task): guide-ja.md に Phase A-R を同期"
```

---

### Task 7: README.md の同期

**Files:**
- Modify: `apps/cmux-team-dispatch-task/README.md`

**Interfaces:**
- Consumes: Task 3-5 の SKILL.md 内容（SoT）と Task 6 の日本語表現（README も日本語）

- [ ] **Step 1: 「モデル選択フロー (Phase B)」セクション（178 行付近）に Phase A-R を追加**

セクション見出しを `## モデル選択フロー (Phase A-R / Phase B)` に変更し、冒頭に Task 6 Step 5 と同じ趣旨の要約（ユーザー向けに簡潔化した版）を追加:

```markdown
### Phase A-R — codex plan/spec レビュー（オプション）

`runners.json` の codex runner に `review_model`（例: `gpt-5.6-sol`）を設定し、config の
`review_mode` を `on` にすると、Phase A で opus が書いた plan/spec を codex が専用ペインで
レビューする。approve が出るまで opus が修正 → 再レビューを繰り返す（各ポイント最大 3 往復。
超過時はユーザーに「このまま進む / さらに修正」を確認）。

- plan モード: plan 完成後に 1 回 / superpowers モード: spec と plan で計 2 回
- 指摘と verdict は `.dispatch/<slug>/review/<point>-round-<N>.md`（末尾 `VERDICT:` 行）で受け渡し
- 無効化はいつでも config の `review_mode: "off"` で可能（runners.json はそのまま残せる）
```

- [ ] **Step 2: 「Pre-warm standby panes」セクション（199 行付近）にレイアウト分岐を追記**

以下を追加:

```markdown
standby ペインの配置は Phase A-R の有効/無効で分岐する:

- **Phase A-R 無効**（現行どおり）: 縦積み — 上: opus / 中: sonnet / 下: codex（codex は
  `engine: "codex"` runner 登録時のみ）
- **Phase A-R 有効**: 2×2 均等グリッド — 左上: opus / 右上: codex レビューペイン（idle、
  `--model <review_model>`）/ 左下: sonnet / 右下: codex。レビューペインは status.json の
  所有権を持たず、`.assigned-<slug>-review` も使わない
```

- [ ] **Step 3: runners.json / config を説明している箇所に review_model / review_mode を追記**

`grep -n "runners.json\|message_type" apps/cmux-team-dispatch-task/README.md` で該当箇所を特定し:

runners.json の schema 例（あれば）の codex 行を置換:

```json
    { "name": "codex",   "command": "codex",   "engine": "codex",  "review_model": "gpt-5.6-sol" }
```

「メッセージトランスポート（message_type）」セクション（158 行付近）の config 例に `"review_mode": "on",` を追加し、設定の説明として追記:

```markdown
- `review_mode`: Phase A-R（codex plan/spec レビュー）の有効/無効（`"on"` / `"off"`）。未設定かつ
  `review_model` 付き codex runner が存在する場合のみ初回に質問され、回答が永続化される。
  プロジェクト側 `.dispatch/config.json` がグローバルより優先
```

- [ ] **Step 4: 検証と Commit**

```bash
grep -c "Phase A-R\|review_model\|review_mode" apps/cmux-team-dispatch-task/README.md
# Expected: 5 以上
git add apps/cmux-team-dispatch-task/README.md
git commit -m "docs(cmux-team-dispatch-task): README に Phase A-R を同期"
```

---

### Task 8: CLAUDE.md の同期（メンテナンス手順 + E2E）

**Files:**
- Modify: `apps/cmux-team-dispatch-task/CLAUDE.md`

- [ ] **Step 1: メンテナンス手順に項目 14 を追加**

既存の項目 13（pre-warm 検証）の直後に追加:

```markdown
14. Phase A-R（codex plan/spec レビュー）が SKILL.md / guide-ja.md / README.md / CLAUDE.md の 4 ファイルで一致しているか確認:
    - 有効化 3 条件（`engine: codex` runner / runner の `review_model` / config の `review_mode: "on"`）と `review_mode` 解決フロー（project config 優先 → global → 未設定なら `review_model` 付き runner 存在時のみ初回質問 → Yes/No とも永続化）
    - レビューポイント（plan モード: plan 後 1 回 / superpowers モード: spec 後 + plan 後の 2 回）、各ポイント最大 3 往復、approve は何ラウンド目でも即終了、3 往復 needs_work 時は AskUserQuestion（このまま進む / さらに修正）
    - verdict はファイル受け渡し（`<STATUS_DIR>/review/<point>-round-<N>.md` 末尾の `VERDICT: approve|needs_work`）。依頼配送は prewarm.json の `review.delivery` で分岐（`agmsg` → send.sh + push 待ち / `cmux-send` → cmux send + 5 秒間隔・15 分タイムアウトのファイルポーリング）。タイムアウト時は同一ラウンド 1 回再依頼 → AskUserQuestion
    - prewarm 有効 + Phase A-R 有効時は 2×2 均等グリッド（左上 opus / 右上 review / 左下 sonnet / 右下 codex）、無効時は現行縦積み。review ペインは standby wrapper の status 所有権なし（`.assigned-<slug>-review` 非使用）、全レビューポイントで同一ペインを再利用し最終 approve 後に close。spawn 失敗時はレビューをスキップして Phase B へ
    - `launch-workspace.sh` の `--mode review` / `--standby-split-direction` / codex engine への `--model` 反映、`prewarm-panes.sh` の `--review-model`（`--codex-runner` 必須）と prewarm.json `review` キーが SKILL.md の使用例・スキーマと一致
```

- [ ] **Step 2: E2E テストに項目 20-25 を追加**

既存の項目 19 の直後に追加:

```markdown
20. **Phase A-R 無効**: `review_model` 未設定または `review_mode: off` で、現行フローと完全一致すること（prewarm レイアウトも縦積みのまま。Phase A 直後に Phase B の質問が出る）
21. **Phase A-R 有効 + prewarm**: 2×2 均等グリッドで 4 ペイン起動（左上 opus / 右上 review [idle codex, `--model <review_model>`] / 左下 sonnet / 右下 codex）。prewarm.json に `review` キーがあること
22. **レビューループ**: plan モードで plan 完成後に 1 回、superpowers モードで spec 後 + plan 後の 2 回レビューが走ること。needs_work → opus が修正して**同一ペイン**に再依頼（新ペインが生えない）。approve → レビューペインが close され Phase B の質問が出ること。3 往復 needs_work → AskUserQuestion（このまま進む / さらに修正）が出ること
23. **verdict プロトコル**: `.dispatch/<slug>/review/<point>-round-<N>.md` が生成され、末尾に `VERDICT:` 行があること。agmsg モードでは `[review] <point> round <N> done` push で子が再開し、send-message モードではファイルポーリングで検知すること
24. **review_mode 解決**: config 未設定 + `review_model` 付き runner ありで初回質問が出て、Yes/No どちらも config.json に永続化されること。`.dispatch/config.json` の `review_mode` がグローバルより優先されること
25. **status 非汚染**: レビューペインの存在・close が standby の `.assigned-*` / status.json に影響しないこと（レビューペイン spawn 直後に status.json が "launched" で上書きされないことを含む）。prewarm 無効時は最初のレビューポイントで `--mode review` のオンデマンド spawn が行われること
```

- [ ] **Step 3: 検証と Commit**

```bash
grep -c "Phase A-R" apps/cmux-team-dispatch-task/CLAUDE.md
# Expected: 2 以上
git add apps/cmux-team-dispatch-task/CLAUDE.md
git commit -m "docs(cmux-team-dispatch-task): CLAUDE.md に Phase A-R のメンテナンス手順と E2E 項目を追加"
```

---

### Task 9: バージョン bump と最終整合チェック

**Files:**
- Modify: `apps/cmux-team-dispatch-task/.claude-plugin/plugin.json`（version: `1.3.1` → `1.4.0`）
- Modify: `.claude-plugin/marketplace.json`（cmux-team-dispatch-task の version を `1.4.0` に同期）

- [ ] **Step 1: バージョンを 1.4.0 に上げる**

`plugin.json` の `"version": "1.3.1"` → `"1.4.0"`。`marketplace.json` の cmux-team-dispatch-task エントリも `"1.4.0"` に。

```bash
jq '.version' apps/cmux-team-dispatch-task/.claude-plugin/plugin.json
jq '.plugins[] | select(.name == "cmux-team-dispatch-task") | .version' .claude-plugin/marketplace.json
# Expected: 両方 "1.4.0"
```

- [ ] **Step 2: 4 ファイル整合の最終チェック**

```bash
# 主要キーワードが 4 ファイルすべてに存在すること
for f in apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md \
         apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md \
         apps/cmux-team-dispatch-task/README.md \
         apps/cmux-team-dispatch-task/CLAUDE.md; do
  echo "== $f"
  for kw in "Phase A-R" "review_model" "review_mode" "review"; do
    printf '  %-14s %s\n' "$kw" "$(grep -c "$kw" "$f")"
  done
done
# Expected: すべてのファイルで各キーワード 1 以上

# VERDICT / round ファイル名 / delivery 分岐の表記ゆれがないこと
grep -rn "round-<N>\|VERDICT:" apps/cmux-team-dispatch-task --include="*.md" | grep -v "point>-round-<N>" | grep "round-<N>"
# Expected: 出力なし (<point>-round-<N> 形式のみ)

# スクリプト最終確認
bash -n apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh
bash -n apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh
# Expected: 出力なし

# repo 全体のチェック (turbo)
pnpm check
# Expected: pass (このプラグインは TS を含まないが、regression 確認)
```

- [ ] **Step 3: Commit**

```bash
git add apps/cmux-team-dispatch-task/.claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "chore(cmux-team-dispatch-task): version bump 1.4.0 (Phase A-R codex plan/spec レビュー)"
```

---

## 実機 E2E（実装完了後・cmux セッション内で手動）

自動テストランナーが無いプラグインのため、CLAUDE.md E2E 項目 20-25（Task 8）を cmux 実機で確認する。最重要は:

1. `review_model` + `review_mode: on` + prewarm で 2×2 グリッドが立つこと（項目 21）
2. plan モードのディスパッチで Phase A 完了後にレビュー依頼が review ペインに届き、`VERDICT: needs_work` → 修正 → `VERDICT: approve` → ペイン close → Phase B 質問、が一巡すること（項目 22-23）
3. `review_mode: off` で従来動作に戻ること（項目 20）
4. agmsg モードで review への依頼が実際に消費されること。滞留する場合は prewarm-panes.sh の review join を常に cmux-send に倒す（スペックのエラーハンドリング表・E2E 19 と同方針）
