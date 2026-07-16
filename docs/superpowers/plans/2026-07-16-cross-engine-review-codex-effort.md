# クロスエンジンレビュー + codex effort 指定 実装計画 (cmux-team-dispatch-task v1.7.0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** cmux-team-dispatch-task に「レビュアーは常に相手方 engine」原則（A-R/B-R クロスレビュー）と codex の役割別 reasoning effort 指定を実装する。

**Architecture:** spec は `docs/superpowers/specs/2026-07-16-cross-engine-review-codex-effort-design.md`。SKILL.md がエンジン的 SoT で、guide-ja.md / README.md / CLAUDE.md が同期ミラー。シェルスクリプト 2 本（`launch-workspace.sh` / `prewarm-panes.sh`）がコマンド組み立てとペイン起動を担う。

**Tech Stack:** bash (macOS bash 3.2 互換必須), jq, cmux CLI, codex CLI (`-c model_reasoning_effort=...`)

## Global Constraints

- 対象ディレクトリ: `apps/cmux-team-dispatch-task/`（リポジトリルート: `/Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins`）
- **4 ファイル整合の絶対ルール**: SKILL.md / references/guide-ja.md / README.md / CLAUDE.md の機能仕様記述は完全一致させる（プラグイン CLAUDE.md「ドキュメント整合の絶対ルール」）
- 言語: ドキュメント・コメント・コミットメッセージは日本語、コード（変数名・フラグ）は英語
- bash は macOS 3.2 互換: `set -u` 下の空配列展開は `${arr[@]+"${arr[@]}"}` イディオム必須
- effort の許容値: `minimal` | `low` | `medium` | `high` | `xhigh`
- 既存デフォルト定数: `OPUS_MODEL="claude-opus-4-7[1m]"` / `SONNET_MODEL="claude-sonnet-4-6"`（prewarm-panes.sh:41-42）
- composed command は常に `zsh -ic "..."` で wrap される。inner の `'...'` を壊すクォートを追加しないこと
- シェルにテストランナーは無い。各タスクの検証は `bash -n`（構文）+ `grep` アサーション + 最終タスクの整合チェック。実挙動は CLAUDE.md の E2E チェックリスト（cmux セッション内での手動実行）に委ねる
- バージョン: 作業ツリーの v1.6.4（未コミット）を確定させた上で、本実装で **1.7.0** に上げる。`apps/cmux-team-dispatch-task/.claude-plugin/plugin.json` と ルート `.claude-plugin/marketplace.json` の両方を同期

## 用語（全タスク共通）

- **設計 engine / design runner**: Step 1f でタスクに割り当てた runner の engine。`claude`（現行デフォルト）または `codex`
- **design=codex タスク**: 設計 runner が `engine: codex` のタスク。Phase A（設計）を codex セッションが行う
- **レビューペイン**: 2×2 グリッド右上のペイン。engine は常に設計 engine の逆
  - design=claude → codex セッション（`review_model` 例 `gpt-5.6-sol`）、agent 名 `<slug>-review`（現行どおり）
  - design=codex → claude セッション（レビュアー runner の `review_model`、fallback `claude-opus-4-7[1m]`）、agent 名 `<slug>-opus`（A-R レビュアー兼 Phase B opus 1m 実装先の二役）
- **B-R レビュアー統一ルール**: 実装者と同じ engine → レビューペインがレビュー / 実装者と設計が逆 engine → 設計ペイン（YOU）がレビュー。展開すると:

| 設計 | Phase B 実装者 | B-R レビュアー | 備考 |
|------|--------------|---------------|------|
| claude | opus 1m（同一セッション続行） | codex レビューペイン | 現行どおり |
| claude | sonnet | codex レビューペイン | **現行変更**（旧: 設計 opus ペイン） |
| claude | codex | 設計 opus ペイン | 現行どおり |
| codex | opus 1m（右上 claude ペインに委譲） | 設計 codex ペイン | 新規 |
| codex | sonnet | 設計 codex ペイン | 新規 |
| codex | codex（右下 standby に委譲） | 右上 claude ペイン | 新規 |

---

### Task 0: ベースライン確定（未コミット v1.6.4 の処置）

**Files:**
- 確認のみ: `git status --short`

作業ツリーには前作業（v1.6.4: dual-send ドキュメント精緻化 + バージョン 1.6.3→1.6.4）の未コミット変更が 8 ファイルに残っている。worktree 分離で実装する場合、未コミット変更は worktree に引き継がれないため、開始前に必ず確定させる。

- [ ] **Step 1: 未コミット差分の確認**

Run: `git -C /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins status --short`
Expected: `apps/cmux-team-dispatch-task/` 配下と `.claude-plugin/marketplace.json` に `M` が並ぶ（内容は v1.6.4 の dual-send 記述変更）

- [ ] **Step 2: v1.6.4 としてコミット**

差分内容が上記（dual-send 精緻化・バージョン 1.6.4）と一致することを `git diff` で確認した上で:

```bash
git add .claude-plugin/marketplace.json apps/cmux-team-dispatch-task/
git commit -m "docs(cmux-team-dispatch-task): v1.6.4 — dual-send（cmux send 常発 + agmsg inbox 記録）の記述を全ドキュメント・スクリプトコメントで精緻化"
```

差分内容が説明と食い違う場合はコミットせずユーザーに確認すること。

- [ ] **Step 3: クリーン確認**

Run: `git status --short`
Expected: 出力なし（`docs/` の計画ファイル以外）

---

### Task 1: spec の微修正（実装で判明した 2 点の追記）

**Files:**
- Modify: `docs/superpowers/specs/2026-07-16-cross-engine-review-codex-effort-design.md`

計画立案時に spec の 2 箇所が実装と整合しないことが判明した。実装前に spec を直す。

1. **`--effort` フラグが必要**: prewarm 経路の設計 codex ペインは `--mode standby` で idle 起動されるため、MODE からの内部解決では `exec_effort` が当たってしまう。`launch-workspace.sh` に明示 `--effort <value>` フラグを追加し、prewarm-panes.sh が設計ペインに `plan_effort` の値を明示で渡す。優先順位: 明示 `--effort` > runner フィールド（MODE 対応） > 無指定（config.toml 既定）
2. **design=codex 時の右上ペイン命名**: agent 名は `<slug>-opus`（`<slug>-review` ではない）。Phase B opus 1m 委譲時の sentinel は `.assigned-<slug>-opus`、signal は `<slug>-opus-done`。prewarm.json 上のキーは役割どおり `review` を維持し `agent: "<slug>-opus"` / `engine: "claude"` を記録する

- [ ] **Step 1: spec のセクション 3 を修正**

「新しい CLI フラグは追加せず、`--runner` と `--mode` から内部解決する。」の段落を次に置換:

```markdown
原則は `--runner` と `--mode` からの内部解決とするが、prewarm 経路の設計 codex ペインは
`--mode standby` で idle 起動される（MODE 解決では exec_effort が当たる）ため、明示
`--effort <value>` フラグを `launch-workspace.sh` に追加する。優先順位:
明示 `--effort` > runner フィールド（MODE 対応表） > 無指定（config.toml 既定）。
prewarm-panes.sh は設計 codex ペイン起動時に runner の `plan_effort` を `--effort` で明示する。
```

- [ ] **Step 2: spec のセクション 5 に右上ペイン命名を追記**

「右上ペインは `--mode standby` 相当で起動する」の段落末尾に追記:

```markdown
design=codex 時の右上ペインの agent 名は `<slug>-opus`（A-R レビュアー兼 opus 1m 実装先）。
Phase B opus 1m 委譲時の sentinel は `.assigned-<slug>-opus`、完了 signal は `<slug>-opus-done`。
prewarm.json のキーは役割どおり `review` を維持し、`agent: "<slug>-opus"` /
`engine: "claude"` を記録する。
```

- [ ] **Step 3: コミット**

```bash
git add docs/superpowers/specs/2026-07-16-cross-engine-review-codex-effort-design.md
git commit -m "docs(spec): --effort 明示フラグと design=codex 右上ペイン命名 (<slug>-opus) を追記"
```

---

### Task 2: launch-workspace.sh — effort 解決と注入

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh`

**Interfaces:**
- Produces: `--effort <value>` CLI フラグ（後続タスクの prewarm-panes.sh / SKILL.md が使用）。codex engine の全 composed command に ` -c model_reasoning_effort='<value>'` が `$RUNNER_COMMAND` 直後に入る

- [ ] **Step 1: usage コメントに `--effort` を追記**

`--model <model>` の説明ブロック（35 行目付近）の直後に追加:

```bash
#   --effort <value>                   codex engine の reasoning effort
#                                      (minimal|low|medium|high|xhigh)。
#                                      -c model_reasoning_effort='<value>' として注入される。
#                                      未指定時は runner の plan_effort / review_effort /
#                                      exec_effort を MODE (plan,superpowers / review /
#                                      execute,standby) に応じて適用。どちらも無ければ
#                                      フラグを付けず codex 側 config.toml の既定に任せる。
#                                      claude engine では無視 (警告のみ)
```

- [ ] **Step 2: 引数パースに `--effort` を追加**

`--model` の case 節（159-161 行目付近）の直後に追加。変数初期化部（`MODEL=""` がある辺り）に `EFFORT=""` も追加:

```bash
    --effort)
      [[ $# -lt 2 ]] && die "--effort requires a value"
      EFFORT="$2"; shift 2 ;;
```

- [ ] **Step 3: runner 解決に effort フィールドを追加**

`RUNNER_EXEC_MODEL=$(echo "$RUNNER_JSON" | jq -r '.exec_model // empty')`（325 行目付近）の直後に追加。あわせて初期値ブロック（`RUNNER_EXEC_MODEL=""` の並び）に 3 変数の空初期化を追加:

```bash
  RUNNER_PLAN_EFFORT=$(echo "$RUNNER_JSON" | jq -r '.plan_effort // empty')
  RUNNER_REVIEW_EFFORT=$(echo "$RUNNER_JSON" | jq -r '.review_effort // empty')
  RUNNER_EXEC_EFFORT=$(echo "$RUNNER_JSON" | jq -r '.exec_effort // empty')
```

- [ ] **Step 4: effort の最終解決と検証を追加**

exec_model フォールバックブロック（332-339 行目付近）の直後に追加:

```bash
# effort 解決: codex engine のみ。優先順位: 明示 --effort > runner フィールド (MODE 対応) > 無指定
# 無指定なら -c フラグを付けず codex 側デフォルト (config.toml) に任せる
CODEX_EFFORT_FLAG=""
if [[ "$RUNNER_ENGINE" == "codex" ]]; then
  if [[ -z "$EFFORT" ]]; then
    case "$MODE" in
      plan|superpowers) EFFORT="$RUNNER_PLAN_EFFORT" ;;
      review)           EFFORT="$RUNNER_REVIEW_EFFORT" ;;
      execute|standby)  EFFORT="$RUNNER_EXEC_EFFORT" ;;
    esac
  fi
  if [[ -n "$EFFORT" ]]; then
    [[ "$EFFORT" =~ ^(minimal|low|medium|high|xhigh)$ ]] \
      || die "invalid --effort '$EFFORT' (must be minimal|low|medium|high|xhigh)"
    CODEX_EFFORT_FLAG=" -c model_reasoning_effort='$EFFORT'"
    log "runner" "applying reasoning effort=$EFFORT (codex $MODE)"
  fi
elif [[ -n "$EFFORT" ]]; then
  log "warn" "--effort is only meaningful with codex engine; ignoring"
fi
```

- [ ] **Step 5: codex の全 CORE_CMD に `$CODEX_EFFORT_FLAG` を注入**

codex engine ブロック（523-548 行目付近）の 4 分岐すべてで `$RUNNER_COMMAND` の直後に挿入:

```bash
    if [[ "$MODE" == "execute" ]]; then
      CODEX_MODEL_FLAG=""
      [[ -n "$MODEL" ]] && CODEX_MODEL_FLAG=" --model '$MODEL'"
      CORE_CMD="$RUNNER_COMMAND$CODEX_EFFORT_FLAG$CODEX_MODEL_FLAG --dangerously-bypass-approvals-and-sandbox '$PROMPT_TEXT'"
    elif [[ "$MODE" == "standby" || "$MODE" == "review" ]]; then
      CODEX_MODEL_FLAG=""
      [[ -n "$MODEL" ]] && CODEX_MODEL_FLAG=" --model '$MODEL'"
      if [[ -n "$PROMPT_TEXT" ]]; then
        CORE_CMD="$RUNNER_COMMAND$CODEX_EFFORT_FLAG$CODEX_MODEL_FLAG --dangerously-bypass-approvals-and-sandbox '$PROMPT_TEXT'"
      else
        CORE_CMD="$RUNNER_COMMAND$CODEX_EFFORT_FLAG$CODEX_MODEL_FLAG --dangerously-bypass-approvals-and-sandbox"
      fi
    elif [[ "$MODE" == "superpowers" ]]; then
      CORE_CMD="$RUNNER_COMMAND$CODEX_EFFORT_FLAG '\$superpowers:brainstorming $PROMPT_TEXT'"
    else
      CORE_CMD="$RUNNER_COMMAND$CODEX_EFFORT_FLAG --dangerously-bypass-approvals-and-sandbox '/plan $PROMPT_TEXT'"
    fi
```

（既存コメント行はそのまま残す。変更は `$CODEX_EFFORT_FLAG` の挿入のみ）

- [ ] **Step 6: 構文チェックと注入確認**

```bash
bash -n apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh
grep -c 'CODEX_EFFORT_FLAG' apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh
```

Expected: `bash -n` はエラーなし。grep カウントは 8 以上（定義 2 + 代入 1 + 注入 5）

- [ ] **Step 7: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh
git commit -m "feat(cmux-team-dispatch-task): launch-workspace.sh に codex reasoning effort 注入 (--effort / runner の plan_effort・review_effort・exec_effort) を追加"
```

---

### Task 3: prewarm-panes.sh — design-runner / reviewer-runner / engine 情報

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh`

**Interfaces:**
- Consumes: Task 2 の `--effort` フラグ
- Produces: `--design-runner <name>` / `--reviewer-runner <name>` フラグ。prewarm.json 各ペインに `engine` フィールド。design=codex 時の右上ペイン agent 名 `<slug>-opus`

- [ ] **Step 1: ヘッダコメントを更新**

ファイル先頭コメント（1-35 行目）に以下を反映:
- 2×2 グリッドの説明に design=codex variant を追記: 「`--design-runner`（codex engine）有り: 左上 design codex / 右上 claude review (`<slug>-opus`) / 左下 sonnet / 右下 codex」
- Usage 両モードのオプション列に `[--design-runner <name>] [--reviewer-runner <name>]` を追加
- 内部処理の 3/4.5/5 に design=codex 分岐の説明を追記

- [ ] **Step 2: 引数パース・検証を追加**

変数初期化（55-66 行目付近）に追加:

```bash
DESIGN_RUNNER=""
REVIEWER_RUNNER=""
DESIGN_ENGINE="claude"
DESIGN_PLAN_EFFORT=""
CLAUDE_REVIEW_MODEL=""
RUNNERS_CONFIG_PATH="${RUNNERS_CONFIG_PATH:-$HOME/.claude/cmux-team-dispatch-task/runners.json}"
```

case 文（`--codex-runner` の後）に追加:

```bash
    --design-runner)
      [[ $# -lt 2 ]] && die "--design-runner requires a runner name"
      DESIGN_RUNNER="$2"; shift 2 ;;
    --reviewer-runner)
      [[ $# -lt 2 ]] && die "--reviewer-runner requires a runner name"
      REVIEWER_RUNNER="$2"; shift 2 ;;
```

Validation ブロック（113-140 行目付近）に追加:

```bash
# design=codex / reviewer の解決。runner の engine と model/effort を runners.json から引く
if [[ -n "$DESIGN_RUNNER" ]]; then
  [[ -f "$RUNNERS_CONFIG_PATH" ]] || die "runners.json not found at $RUNNERS_CONFIG_PATH (required for --design-runner)"
  DESIGN_ENGINE=$(jq -r --arg n "$DESIGN_RUNNER" '.runners[]? | select(.name == $n) | .engine // "claude"' "$RUNNERS_CONFIG_PATH")
  [[ -n "$DESIGN_ENGINE" ]] || die "design runner '$DESIGN_RUNNER' not found in $RUNNERS_CONFIG_PATH"
  DESIGN_PLAN_EFFORT=$(jq -r --arg n "$DESIGN_RUNNER" '.runners[]? | select(.name == $n) | .plan_effort // empty' "$RUNNERS_CONFIG_PATH")
fi
if [[ -n "$REVIEWER_RUNNER" ]]; then
  [[ "$DESIGN_ENGINE" == "codex" ]] || die "--reviewer-runner requires a codex-engine --design-runner"
  [[ -n "$REVIEW_MODEL" ]] && die "--reviewer-runner and --review-model are mutually exclusive"
  REVIEWER_ENGINE=$(jq -r --arg n "$REVIEWER_RUNNER" '.runners[]? | select(.name == $n) | .engine // "claude"' "$RUNNERS_CONFIG_PATH")
  [[ "$REVIEWER_ENGINE" == "claude" ]] || die "reviewer runner '$REVIEWER_RUNNER' must be claude engine"
  CLAUDE_REVIEW_MODEL=$(jq -r --arg n "$REVIEWER_RUNNER" '.runners[]? | select(.name == $n) | .review_model // empty' "$RUNNERS_CONFIG_PATH")
  [[ -z "$CLAUDE_REVIEW_MODEL" ]] && CLAUDE_REVIEW_MODEL="$OPUS_MODEL"
fi
if [[ "$DESIGN_ENGINE" == "codex" && -n "$REVIEW_MODEL" ]]; then
  die "--review-model is for claude-design tasks; use --reviewer-runner when the design runner is codex"
fi
```

- [ ] **Step 3: agmsg 配線を design=codex に対応させる**

Step 2 ブロック（172-209 行目付近）を変更:
- `--with-opus` 時の join: `DESIGN_ENGINE == codex` なら codex standby と同じフォールバック付き join（type `codex`、失敗時 `claude-code` で再 join し `cmux-send` 記録）で `$SLUG` を join し、成功時 `delivery.sh set monitor codex` の結果を `CLAUDE_DELIVERY` ではなく専用の `DESIGN_DELIVERY` に記録する。claude 設計時は現行どおり（`DESIGN_DELIVERY="$CLAUDE_DELIVERY"` を設定）
- レビューペイン join（200-208 行目）: `REVIEWER_RUNNER` 経路では `join.sh "$AGMSG_TEAM" "$SLUG-opus" claude-code "$CWD"` にし、成功時 `REVIEW_DELIVERY="$CLAUDE_DELIVERY"`。codex 経路（`REVIEW_MODEL` 有り）は現行どおり `$SLUG-review` / type `codex`

- [ ] **Step 4: 設計ペイン起動（Step 3）を design=codex に対応させる**

`--with-opus` の opus standby 起動（215-238 行目付近）を分岐:

```bash
if [[ "$DESIGN_ENGINE" == "codex" ]]; then
  # design=codex: 設計ペインは codex idle standby (初期 prompt なし — codex は
  # slash command での actas ができないため、タスクは常に typed prompt で届く)
  log "prewarm" "launching codex design workspace for $SLUG"
  EFFORT_FLAGS=()
  [[ -n "$DESIGN_PLAN_EFFORT" ]] && EFFORT_FLAGS=(--effort "$DESIGN_PLAN_EFFORT")
  OPUS_RESULT=$(bash "$SCRIPT_DIR/launch-workspace.sh" \
    --cwd "$CWD" \
    --mode standby \
    --defer-status \
    --runner "$DESIGN_RUNNER" \
    ${EFFORT_FLAGS[@]+"${EFFORT_FLAGS[@]}"} \
    --status-dir "$STATUS_DIR" \
    ${NOTIFY_FLAGS[@]+"${NOTIFY_FLAGS[@]}"} \
    --message-type agmsg --agmsg-team "$AGMSG_TEAM" --agmsg-from "$SLUG" \
    "$SLUG") || die "failed to launch codex design workspace"
else
  # 現行の opus standby 起動 (OPUS_PROMPT の組み立て含め変更なし)
  ...existing code...
fi
```

（`...existing code...` は既存の OPUS_PROMPT 組み立てと launch-workspace.sh 呼び出しをそのまま else 側に移す。WORKSPACE / OPUS_SURFACE / BASE_SURFACE のパースは分岐の外に共通化してよい）

注意: codex design 起動時は `--model` を渡さない（設計は codex 側デフォルトモデル。effort のみ `plan_effort` を明示）。

- [ ] **Step 5: レビューペイン起動（Step 5.5）を engine 分岐にする**

トリガー条件を `[[ -n "$REVIEW_MODEL" || -n "$REVIEWER_RUNNER" ]]` に変更し、内部を分岐:

```bash
if [[ -n "$REVIEW_MODEL" || -n "$REVIEWER_RUNNER" ]]; then
  if [[ -n "$REVIEWER_RUNNER" ]]; then
    # design=codex: claude レビューペイン (A-R レビュアー兼 Phase B opus 1m 実装先の二役)
    log "prewarm" "launching claude review pane for $SLUG (reviewer runner: $REVIEWER_RUNNER)"
    REVIEW_PANE_NAME="$SLUG-opus"
    REVIEW_RUNNER_FLAGS=(--runner "$REVIEWER_RUNNER" --model "$CLAUDE_REVIEW_MODEL" --skip-permissions)
  else
    log "prewarm" "launching codex review pane for $SLUG"
    REVIEW_PANE_NAME="$SLUG-review"
    REVIEW_RUNNER_FLAGS=(--runner "$CODEX_RUNNER" --model "$REVIEW_MODEL")
  fi
  REVIEW_RESULT=$(bash "$SCRIPT_DIR/launch-workspace.sh" \
    --cwd "$CWD" \
    --mode review \
    --standby-in "$WORKSPACE" \
    --standby-split-from "$BASE_SURFACE" \
    --standby-split-direction right \
    "${REVIEW_RUNNER_FLAGS[@]}" \
    --status-dir "$STATUS_DIR" \
    ${NOTIFY_FLAGS[@]+"${NOTIFY_FLAGS[@]}"} \
    "$REVIEW_PANE_NAME") || die "failed to launch review pane"
  REVIEW_SURFACE=$(echo "$REVIEW_RESULT" | jq -r '.surface_id // empty')
  [[ -n "$REVIEW_SURFACE" ]] || die "failed to parse review pane output"
fi
```

codex standby ペインの split 方向条件（`[[ -n "$REVIEW_MODEL" ]] && CODEX_DIRECTION_FLAGS=...`）も `[[ -n "$REVIEW_MODEL" || -n "$REVIEWER_RUNNER" ]]` に変更（2×2 グリッドの成立条件が変わるため）。

- [ ] **Step 6: prewarm.json に engine を追加**

Step 6 の jq（328-340 行目付近）を置換。design=codex 時は review キーの agent が `<slug>-opus` になる:

```bash
REVIEW_AGENT_SUFFIX="-review"
REVIEW_ENGINE="codex"
if [[ -n "$REVIEWER_RUNNER" ]]; then
  REVIEW_AGENT_SUFFIX="-opus"
  REVIEW_ENGINE="claude"
fi
PREWARM_JSON=$(jq -n \
  --arg os "$OPUS_SURFACE" \
  --arg ss "$SONNET_SURFACE" \
  --arg cs "$CODEX_SURFACE" \
  --arg rs "$REVIEW_SURFACE" \
  --arg slug "$SLUG" \
  --arg de "$DESIGN_ENGINE" \
  --arg dd "$DESIGN_DELIVERY" \
  --arg dc "$CLAUDE_DELIVERY" \
  --arg dx "$CODEX_DELIVERY" \
  --arg dr "$REVIEW_DELIVERY" \
  --arg ras "$REVIEW_AGENT_SUFFIX" \
  --arg re "$REVIEW_ENGINE" \
  '(if $os != "" then {opus: {surface_id: $os, agent: $slug, engine: $de, delivery: $dd}} else {} end)
   + {sonnet: {surface_id: $ss, agent: ($slug + "-sonnet"), engine: "claude", delivery: $dc}}
   + (if $cs != "" then {codex: {surface_id: $cs, agent: ($slug + "-codex"), engine: "codex", delivery: $dx}} else {} end)
   + (if $rs != "" then {review: {surface_id: $rs, agent: ($slug + $ras), engine: $re, delivery: $dr}} else {} end)')
```

（`DESIGN_DELIVERY` は Step 3 で必ず設定されるようにする — claude 設計時は `CLAUDE_DELIVERY` と同値）

- [ ] **Step 7: 構文チェック**

```bash
bash -n apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh
grep -n 'design-runner\|reviewer-runner\|DESIGN_ENGINE\|-opus' apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh | head -20
```

Expected: `bash -n` エラーなし。新フラグ・分岐が確認できる

- [ ] **Step 8: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh
git commit -m "feat(cmux-team-dispatch-task): prewarm-panes.sh に --design-runner / --reviewer-runner (design=codex の claude レビューペイン) と prewarm.json engine 情報を追加"
```

---

### Task 4: SKILL.md — スキーマ / Step 1f / Step 1g

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md`（205-250 行付近のスキーマ、253-296 行付近の Step 1f、330-376 行付近の Step 1g）

**Interfaces:**
- Produces: `REVIEWER_RUNNER` / `CLAUDE_REVIEW_MODEL` / `REVIEW_ENABLED_CODEX_DESIGN` という名前の Step 1f/1g 出力（Task 5, 6 のプロンプト構築・prewarm 呼び出しが参照）

- [ ] **Step 1: runners.json schema を拡張**

schema JSON を次に置換:

```json
{
  "default": "claude",
  "runners": [
    { "name": "claude",  "command": "claude",  "engine": "claude", "review_model": "claude-opus-4-7[1m]" },
    { "name": "ccenec",  "command": "ccenec",  "engine": "claude" },
    { "name": "codex",   "command": "codex",   "engine": "codex",  "review_model": "gpt-5.6-sol", "exec_model": "gpt-5.6-terra",
      "plan_effort": "xhigh", "review_effort": "xhigh", "exec_effort": "high" }
  ]
}
```

Field meanings の `review_model` 項を次に置換し、effort 3 項を追加:

```markdown
- `review_model` (optional):
  - `engine: codex` の runner: design=claude のタスクで Phase A-R/B-R のレビューペイン
    (codex) に渡すモデル名。未設定ならそのタスクのレビューは無効
  - `engine: claude` の runner: design=codex のタスクでレビュアー runner に選ばれたとき、
    claude レビューペインに渡すモデル名。未設定時は `claude-opus-4-7[1m]` にフォールバック
- `plan_effort` / `review_effort` / `exec_effort` (optional, `engine: codex` の runner のみ,
  値: `minimal`|`low`|`medium`|`high`|`xhigh`): codex セッションの reasoning effort。
  それぞれ Phase A 設計 (plan / superpowers) / レビューペイン (review) / 実行系
  (execute / standby) に `-c model_reasoning_effort='<値>'` として注入される。
  未設定なら `-c` フラグを付けず `~/.codex/config.toml` の既定に任せる
```

- [ ] **Step 2: First-run setup のカスタム登録質問に項目を追加**

既存の `review_model` / `exec_model` 質問（281-284 行付近）を次に置換:

```markdown
   - **review_model** (free text) — engine が `codex` のとき: Phase A-R/B-R レビュー用モデル
     (例 `gpt-5.6-sol`)。engine が `claude` のとき: design=codex タスクのレビュアーに
     選ばれた場合のモデル (例 `claude-opus-4-7[1m]`)。空回答で省略可
   - **exec_model** (free text, engine が `codex` のときのみ質問, 例 `gpt-5.6-terra`) —
     Phase B 実行系 (execute / standby) 用モデル。空回答で省略可 (codex 側デフォルトを使用)
   - **plan_effort / review_effort / exec_effort** (choice: 空 / minimal / low / medium /
     high / xhigh。engine が `codex` のときのみ質問) — 設計 / レビュー / 実行の
     reasoning effort。空回答で省略可 (codex 側 config.toml の既定を使用)
```

- [ ] **Step 3: Step 1f にレビュアー runner 選択を追加**

Step 1f 末尾（「Each task receives a `runner` field...」の後）に追加:

```markdown
4. **Cross-engine reviewer** — `engine: codex` の runner が設計に割り当てられたタスクが
   1 つでもある場合、claude 側レビュアー runner を決める（design=codex のレビューは
   claude が担うため）:
   - claude engine の runner が 0 件 → 警告し、codex 設計タスクの Phase A-R / B-R は無効
   - 1 件 → その runner を黙って採用
   - 2 件以上 → AskUserQuestion で毎 dispatch 選択:
     > codex 設計タスクのレビュアー (claude 側) に使う runner を選んでください
     options = claude engine runners (label = `name`, description = `command` + 設定済み `review_model`)
   選ばれた runner 名を `REVIEWER_RUNNER` とし、その `review_model`（未設定なら
   `claude-opus-4-7[1m]`）を `CLAUDE_REVIEW_MODEL` として Step 1g / Step 2 に渡す。
```

- [ ] **Step 4: Step 1g の REVIEW_ENABLED を設計 engine 別に分岐**

質問発火条件（354 行付近）の「`REVIEW_MODEL` non-empty →」を「`REVIEW_MODEL` non-empty **または** codex 設計タスクが存在し `REVIEWER_RUNNER` が解決済み →」に変更。質問文は現行のまま。

REVIEW_ENABLED 計算（366-376 行付近）を次に置換:

```bash
# REVIEW_ENABLED はタスクの設計 engine ごとに決まる (review_mode の解決は共通):
#   design=claude のタスク → review_model 付き codex runner が存在 (REVIEW_MODEL 非空)
#   design=codex のタスク  → claude engine runner が存在 (REVIEWER_RUNNER 非空)
REVIEW_ENABLED=false                 # design=claude タスク用
[[ -n "$REVIEW_MODEL" && "$REVIEW_MODE" == "on" ]] && REVIEW_ENABLED=true
REVIEW_ENABLED_CODEX_DESIGN=false    # design=codex タスク用
[[ -n "$REVIEWER_RUNNER" && "$REVIEW_MODE" == "on" ]] && REVIEW_ENABLED_CODEX_DESIGN=true
```

- [ ] **Step 5: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md
git commit -m "docs(cmux-team-dispatch-task): SKILL.md — runners.json スキーマ (claude review_model / codex effort 3 種) と Step 1f/1g のクロスエンジンレビュー解決を追加"
```

---

### Task 5: SKILL.md — engine×MODE 表 / prewarm 呼び出し / レイアウト記述

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md`（229-249 行付近の invocation table、1088-1142 行付近の prewarm 節）

- [ ] **Step 1: engine × MODE invocation table を effort 込みに更新**

codex の 3 行を次に置換（`[-c ...]` は該当 effort が解決されたときのみ付く）:

```markdown
| codex  | plan        | `<command> [-c model_reasoning_effort='<plan_effort>'] --dangerously-bypass-approvals-and-sandbox '/plan Read and follow the task in .cmux-team-dispatch-task-prompt.md'` |
| codex  | superpowers | `<command> [-c model_reasoning_effort='<plan_effort>'] '$superpowers:brainstorming Read and follow the task in .cmux-team-dispatch-task-prompt.md'`   |
| codex  | execute     | `<command> [-c model_reasoning_effort='<exec_effort>'] [--model <exec_model>] --dangerously-bypass-approvals-and-sandbox 'Read and execute the plan at <plan-file>'` |
```

表下の説明段落に追記:

```markdown
codex engine の reasoning effort は明示 `--effort` > runner フィールド (plan_effort:
plan/superpowers, review_effort: review, exec_effort: execute/standby) > 無指定
(config.toml 既定) の優先で解決され、`-c model_reasoning_effort='<値>'` として
`<command>` 直後に注入される。prewarm の設計 codex ペインは `--mode standby` で
起動されるため、`prewarm-panes.sh` が `--effort <plan_effort>` を明示して渡す。
```

- [ ] **Step 2: prewarm レイアウト記述を design=codex 対応に更新**

「**Phase A-R enabled**: 2×2 even grid」の段落（1093-1096 行付近）を次に置換:

```markdown
- **Phase A-R enabled**: 2×2 even grid。レビューペインは常に設計 engine の逆:
  - design=claude (現行): top-left: opus / top-right: codex review pane (idle,
    `--model <review_model>`, agent `<slug>-review`) / bottom-left: sonnet /
    bottom-right: codex
  - design=codex: top-left: design codex (idle, `--effort <plan_effort>`) /
    top-right: claude review pane (idle, reviewer runner + `--model
    <CLAUDE_REVIEW_MODEL>` + `--skip-permissions`, agent `<slug>-opus` — A-R
    レビュアー兼 Phase B opus 1m 実装先の二役) / bottom-left: sonnet /
    bottom-right: codex (exec_model / exec_effort)
  どちらも review pane は standby wrapper の status 所有権なしで起動する
  (design=codex の右上のみ、Phase B で opus 1m が選ばれたときに
  `.assigned-<slug>-opus` が touch され実装者として status を持つ)。
```

- [ ] **Step 3: prewarm-panes.sh 呼び出し例を更新**

send-message / agmsg 両方の呼び出し例（1105-1136 行付近）のオプション列に追加:

```bash
  [--design-runner <design-runner-name>] \
  [--reviewer-runner <reviewer-runner-name>] \
```

「Pass `--review-model` only when ...」の段落を次に置換:

```markdown
Flag selection per task:
- design=claude: pass `--review-model "$REVIEW_MODEL"` only when Phase A-R is
  enabled (`REVIEW_ENABLED`). It requires `--codex-runner`.
- design=codex: ALWAYS pass `--design-runner <runner>`. Pass
  `--reviewer-runner "$REVIEWER_RUNNER"` only when `REVIEW_ENABLED_CODEX_DESIGN`
  is true. `--review-model` must NOT be passed (mutually exclusive).
```

- [ ] **Step 4: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md
git commit -m "docs(cmux-team-dispatch-task): SKILL.md — effort 注入の invocation table と design=codex の prewarm レイアウト / 呼び出しフラグを追記"
```

---

### Task 6: SKILL.md — プロンプトテンプレートのクロスエンジン化

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md`（536-950 行付近: MANDATORY MODEL SELECTION SEQUENCE / placeholder rules / REVIEW_BLOCK / CODE_REVIEW_BLOCK）

これが本実装の中核。子プロンプトに焼き込むテンプレートを設計 engine で出し分ける。

- [ ] **Step 1: placeholder rules に設計 engine 分岐を追加**

placeholder rules 節（`{{REVIEW_BLOCK}}` の説明の前）に追加:

```markdown
- テンプレートはタスクの設計 runner の engine で出し分ける:
  - design=claude → 従来どおり（PHASE A は "always opus"、PHASE B の SAME MODEL は
    `/model claude-opus-4-7[1m]`）
  - design=codex → PHASE A / PHASE B セクションを下の「codex 設計 variant」に差し替える
- `{{REVIEW_MODEL}}` → design=claude: Step 1g の `REVIEW_MODEL` / design=codex:
  `CLAUDE_REVIEW_MODEL`
- `{{REVIEW_RUNNER_NAME}}`（旧 `{{CODEX_RUNNER_NAME}}` を改名）→ design=claude:
  codex runner の `name` / design=codex: `REVIEWER_RUNNER`
- `{{REVIEW_PANE_AGENT}}` → design=claude: `<task-slug>-review` / design=codex:
  `<task-slug>-opus`
```

- [ ] **Step 2: PHASE A / PHASE B の codex 設計 variant を追加**

既存テンプレートの直後に、design=codex 用の差し替えブロックを追加:

````markdown
**codex 設計 variant**（design=codex のタスクでは PHASE A / PHASE B を以下に差し替える）:

```
PHASE A — Planning / Brainstorming (THIS codex session):
  Produce the plan in THIS session. Do NOT switch models mid-session.
  - superpowers mode: brainstorm, then write a plan file
  - plan mode: use /plan; the approved plan MUST list Step 0 (Phase A-R, when the
    block exists below) and Step 1 (Phase B selection) BEFORE any implementation
    step, and be saved to a file (e.g. .claude/plans/<task-slug>.md) as the FIRST
    action after approval.
  Remember the plan file path — every Phase B choice hands it off via --plan-file.

PHASE B — Execution model selection (REQUIRED before any code change):
  After Phase A (and Phase A-R when present) completes, ask via AskUserQuestion:
    Q: "実行フェーズで使用するモデルを選択してください"
    Options:
      1. opus 1m  — 高品質・長コンテキスト (推奨: 大規模・複雑な実装)
      2. sonnet   — 高速・低コスト (推奨: 中規模・パターン化された実装)
      3. codex    — <exec_model> で実行 (推奨: 定型実装・別視点が欲しいとき)

  ALL three choices DELEGATE to a pre-warmed pane — THIS session never implements.
  Common delegation steps (X = chosen pane key in prewarm.json: "review" for
  opus 1m / "sonnet" / "codex"; NAME = the pane's agent name from prewarm.json):
    1. Leave the unused standby panes OPEN and idle — do NOT close them.
    2. touch "<EXISTING_STATUS_DIR>/.assigned-<NAME>"
    3. Send the execution request to the pane's surface_id. Delivery is ALWAYS
       the typed prompt (cmux send + send-key return); when the pane's delivery
       is "agmsg" AND its ready sentinel exists, ALSO record the request in its
       inbox first (same dual-send rules as the claude variant).
       REQUEST_TEXT: same as the claude variant (execute the plan at
       <PLAN_FILE_PATH>, code-review protocol block when Phase B-R is enabled,
       exit instruction).
    4. touch "<EXISTING_STATUS_DIR>/.deferred"
    5. THEN follow the CODE REVIEW block below for your post-delegation role
       (reviewer or idle).
  Pane-specific notes:
    [opus 1m] target = prewarm.json .review (the claude pane, agent <task-slug>-opus).
      Its model is already <CLAUDE_REVIEW_MODEL> — do not pass /model commands.
    [sonnet]  target = prewarm.json .sonnet (same as the claude variant sonnet branch).
    [codex]   target = prewarm.json .codex (exec_model / exec_effort are baked in
      at pane launch).
  IF prewarm.json is absent (prewarm off / split layout), fall back to spawning
  via launch-workspace.sh --mode execute exactly as the claude variant does
  (opus 1m fallback: --model 'claude-opus-4-7[1m]' --skip-permissions with the
  reviewer runner's command via --runner <REVIEWER_RUNNER>).
```
````

- [ ] **Step 3: REVIEW_BLOCK をレビュアー中立に書き換え**

`{{REVIEW_BLOCK}}` テンプレート（688-780 行付近）の変更点:
- 見出し「Plan/Spec review by codex」→「Plan/Spec review by the counterpart engine」
- 「a plain codex session」→「a plain review session (engine is the opposite of this session's)」
- spawn fallback の `--runner {{CODEX_RUNNER_NAME}}` → `--runner {{REVIEW_RUNNER_NAME}}`、名前 `<task-slug>-review` → `{{REVIEW_PANE_AGENT}}`。claude レビュアー時は `--skip-permissions` を追加する旨を 1 行追記:
  ```
  (when the reviewer engine is claude, append --skip-permissions to the spawn)
  ```
- ready sentinel パスの `<task-slug>-review` → `{{REVIEW_PANE_AGENT}}`
- AskUserQuestion 文言 2 箇所「codex レビュー」→「レビュー」（engine 非依存に）

- [ ] **Step 4: CODE_REVIEW_BLOCK を統一ルールに書き換え**

`{{CODE_REVIEW_BLOCK}}`（786-870 行付近）の分岐を次の構造に置換（プロトコル本体 — REQUEST_TEXT 拡張版 / round loop / タイムアウト / 3 往復時の扱い — は現行文面を維持し、割り当てだけ変える）:

```markdown
Reviewer assignment (unified rule): the reviewer is ALWAYS the opposite engine
of the implementer. Physically:
  - implementer engine == design engine → the review pane reviews
    (REVIEWER_SURFACE = prewarm.json .review.surface_id)
  - implementer engine != design engine → the DESIGN session (YOU) reviews
    (REVIEWER_SURFACE = your own $CMUX_SURFACE_ID)

[design=claude]
  - "opus 1m" (you implement) → the review pane reviews your code: run the SAME
    Round loop as PHASE A-R with point id "code" (現行の opus 1m 節をそのまま使用)
  - "sonnet" → the review pane reviews. REQUEST_TEXT の <REVIEWER_SURFACE> は
    prewarm.json .review.surface_id。YOU (the design pane) は .deferred touch 後
    に exit する (レビュアー役なし — 従来の Phase B-R 以前の挙動に戻る)
  - "codex" → YOU become the code reviewer (現行の sonnet/codex 節の b〜e を使用。
    REQUEST_TEXT の <REVIEWER_SURFACE> = your own $CMUX_SURFACE_ID)

[design=codex]
  - "opus 1m" / "sonnet" → YOU (the design codex session) become the code
    reviewer (b〜e と同じプロトコル: .deferred 後 exit せず idle 待機 → round
    ごとに findings を書く → approve 後 exit)
  - "codex" (standby) → the claude review pane reviews. REQUEST_TEXT の
    <REVIEWER_SURFACE> = prewarm.json .review.surface_id。YOU は .deferred touch
    後に exit する
  - review pane unavailable (spawn 失敗済み) → レビュー省略 (現行と同じ)
```

現行の「[IF "sonnet" or "codex" was chosen — YOU become the code reviewer]」の b〜e 項は「YOU become the code reviewer」共通プロトコルとして残し、a 項（REQUEST_TEXT 拡張版）は Placeholder values の `<REVIEWER_SURFACE>` 説明を上記ルール参照に変える。

- [ ] **Step 5: 一貫性 grep**

```bash
grep -n 'CODEX_RUNNER_NAME' apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md
grep -c 'REVIEW_RUNNER_NAME\|REVIEW_PANE_AGENT' apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md
```

Expected: 旧 `CODEX_RUNNER_NAME` の残存 0 件（改名漏れなし）。新 placeholder が複数箇所

- [ ] **Step 6: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md
git commit -m "docs(cmux-team-dispatch-task): SKILL.md — codex 設計 variant と REVIEW/CODE_REVIEW_BLOCK のクロスエンジン統一ルールを実装"
```

---

### Task 7: guide-ja.md 同期

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md`

- [ ] **Step 1: Task 4-6 で SKILL.md に加えた変更を洗い出す**

Run: `git log --oneline -4 && git diff HEAD~3 -- apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md | head -400`

- [ ] **Step 2: guide-ja.md の対応セクションを同期**

SKILL.md の変更点を、guide-ja.md の既存対応セクション（「子セッション runner 設定」/ engine × MODE 表 / Phase A-R 節 / Phase B-R 節 / pre-warm 節 / モデル選択フロー節）へ日本語で反映する。同期必須項目:
1. runners.json スキーマ（claude の `review_model` / codex の effort 3 フィールド + フォールバック規則）
2. engine × MODE 表の `-c model_reasoning_effort` 注入と `--effort` の優先順位
3. Step 1f のレビュアー runner 選択（0/1/2+ 件の分岐）
4. Step 1g の `REVIEW_ENABLED` / `REVIEW_ENABLED_CODEX_DESIGN` 分岐
5. クロスレビュー原則の宣言と B-R レビュアー 6 ケース表（本計画冒頭の表をそのまま掲載）
6. design=codex の 2×2 レイアウト（右上 = claude, agent `<slug>-opus`, 二役）
7. prewarm-panes.sh の新フラグと prewarm.json `engine` フィールド
8. design=opus + sonnet 実装の B-R レビュアー変更（現行変更である旨明記）

- [ ] **Step 3: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md
git commit -m "docs(cmux-team-dispatch-task): guide-ja.md をクロスエンジンレビュー + effort 指定に同期"
```

---

### Task 8: README.md 同期

**Files:**
- Modify: `apps/cmux-team-dispatch-task/README.md`

- [ ] **Step 1: README の該当セクションを同期**

README はユーザー向け要約。以下を反映（Task 7 と同じ内容の要約版）:
1. runners.json 設定例（スキーマ JSON をそのまま掲載している箇所を新スキーマに差し替え）
2. レビューモード説明: 「レビュアーは常に相手方 engine」原則と 6 ケース表
3. codex effort 設定（plan/review/exec の 3 フィールドと `-c model_reasoning_effort` 注入）
4. design=codex 時のレイアウトと Phase B（3 択すべて委譲）

- [ ] **Step 2: コミット**

```bash
git add apps/cmux-team-dispatch-task/README.md
git commit -m "docs(cmux-team-dispatch-task): README.md をクロスエンジンレビュー + effort 指定に同期"
```

---

### Task 9: CLAUDE.md 同期（メンテナンス項目 + E2E 項目）

**Files:**
- Modify: `apps/cmux-team-dispatch-task/CLAUDE.md`

- [ ] **Step 1: 既存メンテナンス項目の更新**

- 項目 10（runners.json スキーマ）: フィールド列挙を `name|command|engine|review_model|exec_model|plan_effort|review_effort|exec_effort` に更新し、「`review_model` は claude engine では design=codex 用レビューモデル（fallback `claude-opus-4-7[1m]`）」「effort 3 フィールドは codex engine のみ・`-c model_reasoning_effort` 注入・明示 `--effort` が優先」を追記
- 項目 13（pre-warm）: prewarm.json スキーマに `engine` フィールド追加、design=codex 時のペイン構成（左上 design codex / 右上 claude `<slug>-opus`）を追記
- 項目 14（Phase A-R）: 有効化条件を設計 engine 別 2 系統（`REVIEW_ENABLED` / `REVIEW_ENABLED_CODEX_DESIGN`）に更新、レビューペイン engine が常に設計の逆であることを追記
- 項目 17（Phase B-R）: レビュアー割り当てを統一ルール + 6 ケース表に差し替え（sonnet 実装 → レビューペイン、が現行からの変更である旨を明記）

- [ ] **Step 2: 新メンテナンス項目 18 を追加**

```markdown
18. クロスエンジンレビューと codex effort が SKILL.md / guide-ja.md / README.md / CLAUDE.md の 4 ファイルで一致しているか確認:
    - 「レビュアーは常に相手方 engine」原則と B-R 6 ケース表（設計 claude/codex × 実装者 opus 1m/sonnet/codex）が一致
    - design=codex: Phase B は 3 択とも委譲（設計セッションは実装しない）。右上ペインは agent `<slug>-opus`・A-R レビュアー兼 opus 1m 実装先の二役、opus 1m 選択時のみ `.assigned-<slug>-opus` が touch され signal `<slug>-opus-done`
    - Step 1f のレビュアー runner 選択（claude runner 0 件 → 無効警告 / 1 件 → 自動 / 2 件以上 → 毎回質問）と `CLAUDE_REVIEW_MODEL` フォールバック（`claude-opus-4-7[1m]`）
    - effort の優先順位（明示 `--effort` > runner フィールド > config.toml 既定）と MODE 対応（plan_effort: plan/superpowers、review_effort: review、exec_effort: execute/standby）。prewarm の設計 codex ペインは standby 起動のため `--effort <plan_effort>` 明示
    - `prewarm-panes.sh` の `--design-runner` / `--reviewer-runner`（`--review-model` と相互排他）と prewarm.json の `engine` フィールド
```

- [ ] **Step 3: E2E テスト項目を追加**

E2E チェックリスト末尾（31 の後）に追加:

```markdown
32. **codex effort 注入**: codex runner に effort 3 フィールド設定時、composed command（`.cmux-team-dispatch-task-run-*.sh` 内）に `-c model_reasoning_effort='xhigh'`（plan/review）/ `'high'`（execute/standby）が入ること。未設定フィールドでは `-c` が付かないこと。`--effort` 明示時はそちらが優先されること
33. **design=codex ディスパッチ**: runner に codex を選んだタスクで 2×2 グリッドが 左上 design codex / 右上 claude レビューペイン（agent `<slug>-opus`、モデルはレビュアー runner の `review_model` または `claude-opus-4-7[1m]`）/ 左下 sonnet / 右下 codex になること。claude runner が 2 件以上あるときレビュアー選択質問が出ること
34. **design=codex の Phase A-R**: codex が書いた plan/spec を右上 claude ペインがレビューし、`review/<point>-round-<N>.md` の VERDICT で往復すること
35. **design=codex の Phase B**: 3 択すべてが委譲であること。opus 1m → `.assigned-<slug>-opus` touch + 右上ペインが実装 + 設計 codex ペインが B-R レビュー。sonnet → 設計 codex ペインが B-R レビュー。codex → 右下 standby が実装 + 右上 claude ペインが B-R レビュー
36. **design=claude の sonnet B-R 変更**: sonnet 実装時のコードレビューが codex レビューペインに依頼され（設計 opus ペインではなく）、設計 opus ペインは `.deferred` 後に exit すること
```

- [ ] **Step 4: コミット**

```bash
git add apps/cmux-team-dispatch-task/CLAUDE.md
git commit -m "docs(cmux-team-dispatch-task): CLAUDE.md にクロスエンジンレビュー + effort のメンテナンス項目 18 と E2E 32-36 を追加"
```

---

### Task 10: バージョン 1.7.0 + 最終整合チェック

**Files:**
- Modify: `apps/cmux-team-dispatch-task/.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`

- [ ] **Step 1: バージョンを 1.7.0 に更新**

`apps/cmux-team-dispatch-task/.claude-plugin/plugin.json` の `"version": "1.6.4"` → `"1.7.0"`。
`.claude-plugin/marketplace.json` の cmux-team-dispatch-task エントリの `"version": "1.6.4"` → `"1.7.0"`。

- [ ] **Step 2: JSON / シェル構文の最終確認**

```bash
jq . apps/cmux-team-dispatch-task/.claude-plugin/plugin.json > /dev/null && echo plugin-ok
jq . .claude-plugin/marketplace.json > /dev/null && echo marketplace-ok
bash -n apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh && echo lw-ok
bash -n apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh && echo pw-ok
```

Expected: 4 つの ok

- [ ] **Step 3: 4 ファイル整合 grep**

以下のキーワードが 4 ドキュメント（SKILL.md / guide-ja.md / README.md / CLAUDE.md）すべてに存在することを確認:

```bash
D=apps/cmux-team-dispatch-task
for f in $D/skills/cmux-team-dispatch-task/SKILL.md $D/skills/cmux-team-dispatch-task/references/guide-ja.md $D/README.md $D/CLAUDE.md; do
  echo "== $f"
  grep -c 'plan_effort' "$f"; grep -c 'model_reasoning_effort' "$f"; grep -c -- '-opus' "$f"
done
```

Expected: 全ファイルで各カウント 1 以上。0 のファイルがあれば該当タスクに戻って同期漏れを修正

- [ ] **Step 4: コミット**

```bash
git add apps/cmux-team-dispatch-task/.claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "chore(cmux-team-dispatch-task): v1.7.0 — クロスエンジンレビュー + codex effort 指定"
```

- [ ] **Step 5: E2E 実施をユーザーに引き継ぎ**

E2E 項目 32-36 は cmux セッション内での実ディスパッチが必要（codex CLI・実 API を使用）。実装完了報告時に「E2E 32-36 は手動確認が必要」と明記してユーザーに引き継ぐこと。

---

## Self-Review 結果

- **Spec coverage**: 原則宣言(Task 6)・スキーマ(Task 4)・effort 注入(Task 2)・A-R クロスレビュー(Task 3, 4, 6)・4 ペインロールスワップ/B-R 6 ケース(Task 3, 6)・prewarm 変更(Task 3, 5)・フォールバック(Task 3 検証 / Task 6 REVIEW_BLOCK 維持文面)・ドキュメント/バージョン(Task 7-10)・検証(各タスク + Task 10) — 全セクションにタスクあり
- **Placeholder scan**: `...existing code...`（Task 3 Step 4）は「既存コードを else 側へ移動」という明示指示であり生成対象ではない — 許容。他に TBD/TODO なし
- **Type consistency**: 変数名 `CODEX_EFFORT_FLAG` / `DESIGN_ENGINE` / `REVIEWER_RUNNER` / `CLAUDE_REVIEW_MODEL` / `REVIEW_ENABLED_CODEX_DESIGN`、placeholder `{{REVIEW_RUNNER_NAME}}` / `{{REVIEW_PANE_AGENT}}`、agent 名 `<slug>-opus` / sentinel `.assigned-<slug>-opus` / signal `<slug>-opus-done` — タスク間で一貫
