# cmux-team-dispatch-task Codex-only 実行構成 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** plan/review/implementation を役割別 Codex model へ割り当て、review_mode=on でも Claude process を一切起動しない選択可能な実行構成を追加する。

**Architecture:** `design_runner` / `review_runner` / `exec_choice` を独立に解決し、`launch-workspace.sh` が plan/review/exec role から `plan_model` / `review_model` / `exec_model` を選ぶ。prewarm は解決済み role だけを起動し、明示 `review_runner` は同一 engine を許可する。`review_runner` 未設定時は既存 cross-engine resolver を互換経路として維持する。

**Tech Stack:** bash 3.2、zsh、jq、cmux CLI、agmsg、Markdown skill protocol、pnpm 10.33.0

**Spec:** `docs/superpowers/specs/2026-08-15-codex-only-dispatch-design.md`

## Global Constraints

- all-Codex 実運用値は plan/brainstorm=`gpt-5.6-sol`、review=`gpt-5.6-sol`、implementation=`gpt-5.6-terra`、`review_mode="on"`、`exec_choice="codex"`
- all-Codex 固定構成では `claude` command、`--model sonnet` pane、claude-engine reviewer、agmsg `claude-code` child wiring を0件にする
- `review_runner` 未設定時は v1.17.0 の cross-engine 設定を新しい必須 key なしで動かす
- macOS bash 3.2 互換を維持し、`set -u` 下の空配列は `${arr[@]+"${arr[@]}"}` で展開する
- `SKILL.md` と `references/*.md`（`*-ja.md` を除く）は英語、guide-ja/README/CLAUDE.md は日本語で書く
- SKILL.md / guide-ja.md / README.md / CLAUDE.md の仕様記述は同一 commit 内で同期する
- 配送は `send-prompt.sh` の1回呼び出しを維持し、生の `cmux send` / `send-key` を追加しない
- Phase A-R/B-R の verdict、5秒 polling、15分 liveness chunk、最大5 round、label は変更しない
- `.agents/plugins/marketplace.json` は編集しない
- 他の作業者の変更を戻さず、各 commit 前に `git status --short` と staged diff を確認する

## File Map

### Runtime scripts

- `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh`
  - runner role/model/effort 解決、Codex command composition、engine-neutral wrapper status
- `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh`
  - role-aware pane selection、same-engine review validation、new prewarm.json
- `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/render-loop-prompt.sh`
  - unattended prompt へ実 design/review/exec role を渡す

### Protocol and docs

- `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md`
- `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md`
- `apps/cmux-team-dispatch-task/README.md`
- `apps/cmux-team-dispatch-task/CLAUDE.md`
- `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/loop-mode.md`
- `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/loop-mode-ja.md`
- `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/unattended/phase-block-claude.md`
- `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/unattended/phase-block-codex.md`
- `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/unattended/review-block.md`
- `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/unattended/code-review-block.md`

### Tests

- Modify: `apps/cmux-team-dispatch-task/test/test-launch-workspace-codex.sh`
- Create: `apps/cmux-team-dispatch-task/test/test-prewarm-all-codex.sh`
- Modify: `apps/cmux-team-dispatch-task/test/test-prewarm-unattended.sh`
- Create: `apps/cmux-team-dispatch-task/test/test-codex-only-skill.sh`
- Modify: `apps/cmux-team-dispatch-task/test/test-loop-prompt.sh`
- Modify: `apps/cmux-team-dispatch-task/test/test-cleanup-close.sh`
- Modify: `apps/cmux-team-dispatch-task/test/test-launch-workspace-review-config.sh`

### Release files

- `apps/cmux-team-dispatch-task/.claude-plugin/plugin.json`
- `apps/cmux-team-dispatch-task/.codex-plugin/plugin.json`
- `.claude-plugin/marketplace.json`

---

### Task 1: role-specific Codex model resolver

**Files:**
- Modify: `apps/cmux-team-dispatch-task/test/test-launch-workspace-codex.sh`
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh:1-431,704-779`

**Interfaces:**
- Consumes: existing `runners.json` runner object and `--mode`
- Produces: optional `--role plan|review|exec`; runner fields `plan_model`, `review_model`, `exec_model`; `MODEL_ROLE`; resolved `MODEL`
- Priority: explicit `--model` > field for `MODEL_ROLE` > CLI default
- Default mapping: plan/superpowers→plan, review→review, execute/standby→exec

- [ ] **Step 1: add failing runner fixture and assertions**

Extend the codex runner in `test-launch-workspace-codex.sh`:

```json
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
}
```

Add assertions after the five runner files are resolved:

```bash
assert_contains "$plan_runner" "--model 'gpt-5.6-sol'" 'MR1 plan uses plan_model'
assert_contains "$superpowers_runner" "--model 'gpt-5.6-sol'" 'MR2 superpowers uses plan_model'
assert_contains "$review_runner" "--model 'gpt-5.6-sol'" 'MR3 review uses review_model'
assert_contains "$execute_runner" "--model 'gpt-5.6-terra'" 'MR4 execute uses exec_model'
assert_contains "$standby_runner" "--model 'gpt-5.6-terra'" 'MR5 standby defaults to exec role'

plan_standby=$(runner_for_flags standby --role plan)
assert_contains "$plan_standby" "--model 'gpt-5.6-sol'" 'MR6 plan standby uses plan_model'
assert_not_contains "$plan_standby" "--model 'gpt-5.6-terra'" 'MR6 plan standby excludes exec_model'

explicit_plan=$(runner_for_flags plan --model gpt-5.6-terra)
assert_contains "$explicit_plan" "--model 'gpt-5.6-terra'" 'MR7 explicit model wins'
```

- [ ] **Step 2: run the focused test and confirm the intended failure**

Run:

```bash
cd apps/cmux-team-dispatch-task
bash test/test-launch-workspace-codex.sh
```

Expected: MR1/MR2 fail because plan/superpowers omit `--model`; MR6 fails because `--role` is unknown.

- [ ] **Step 3: parse and validate `--role`**

In `launch-workspace.sh`, initialize `MODEL_ROLE=""`, parse `--role`, and derive the default after mode validation:

```bash
if [[ -z "$MODEL_ROLE" ]]; then
  case "$MODE" in
    plan|superpowers) MODEL_ROLE="plan" ;;
    review) MODEL_ROLE="review" ;;
    execute|standby) MODEL_ROLE="exec" ;;
  esac
elif [[ "$MODE" != "standby" ]]; then
  case "$MODE:$MODEL_ROLE" in
    plan:plan|superpowers:plan|review:review|execute:exec) ;;
    *) die "--role '$MODEL_ROLE' conflicts with --mode '$MODE'" ;;
  esac
fi
```

Validate the argument with `[[ "$MODEL_ROLE" =~ ^(plan|review|exec)$ ]]` before any cmux call.

- [ ] **Step 4: resolve all model and effort fields by the same role**

Read these fields from `RUNNER_JSON`:

```bash
RUNNER_PLAN_MODEL=$(echo "$RUNNER_JSON" | jq -r '.plan_model // empty')
RUNNER_REVIEW_MODEL=$(echo "$RUNNER_JSON" | jq -r '.review_model // empty')
RUNNER_EXEC_MODEL=$(echo "$RUNNER_JSON" | jq -r '.exec_model // empty')
```

When engine is codex and `MODEL` is empty, resolve both `MODEL` and `EFFORT` in one case:

```bash
case "$MODEL_ROLE" in
  plan)
    [[ -z "$MODEL" ]] && MODEL="$RUNNER_PLAN_MODEL"
    [[ -z "$EFFORT" ]] && EFFORT="$RUNNER_PLAN_EFFORT"
    ;;
  review)
    [[ -z "$MODEL" ]] && MODEL="$RUNNER_REVIEW_MODEL"
    [[ -z "$EFFORT" ]] && EFFORT="$RUNNER_REVIEW_EFFORT"
    ;;
  exec)
    [[ -z "$MODEL" ]] && MODEL="$RUNNER_EXEC_MODEL"
    [[ -z "$EFFORT" ]] && EFFORT="$RUNNER_EXEC_EFFORT"
    ;;
esac
```

- [ ] **Step 5: pass Codex model flags in plan and superpowers commands**

Build `CODEX_MODEL_FLAG` once before the engine/mode branch and include it in all Codex modes:

```bash
CODEX_MODEL_FLAG=""
[[ -n "$MODEL" ]] && CODEX_MODEL_FLAG=" --model '$MODEL'"
```

The plan and superpowers command order must be `command`, `effort`, `model`, `hook-trust`, `sandbox/bypass`, then `prompt`:

```text
command effort model hook-trust sandbox/bypass prompt
```

- [ ] **Step 6: run focused tests**

```bash
cd apps/cmux-team-dispatch-task
bash test/test-launch-workspace-codex.sh
bash test/test-launch-workspace-layout.sh
bash test/test-launch-workspace-permissions.sh
```

Expected: all pass, including MR1-MR7 and existing sandbox/hook/parallel assertions.

- [ ] **Step 7: inspect and commit**

```bash
git diff --check
git diff -- apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh \
  apps/cmux-team-dispatch-task/test/test-launch-workspace-codex.sh
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh \
  apps/cmux-team-dispatch-task/test/test-launch-workspace-codex.sh
git commit -m "feat(cmux-team-dispatch-task): Codex の役割別モデルを解決する"
```

---

### Task 2: all-Codex prewarm topology

**Files:**
- Create: `apps/cmux-team-dispatch-task/test/test-prewarm-all-codex.sh`
- Modify: `apps/cmux-team-dispatch-task/test/test-prewarm-unattended.sh`
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh`

**Interfaces:**
- Consumes: Task 1 `launch-workspace.sh --role`; `--design-runner`; generic `--reviewer-runner`; `--exec-choice`
- Produces: `prewarm.json` with `design`, optional `review`, and `executors` object
- all-Codex output: three unique codex panes using plan/review/exec roles

- [ ] **Step 1: write the failing all-Codex prewarm test**

Create `test-prewarm-all-codex.sh`. Stub launch-workspace and agmsg, then configure one runner:

```bash
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
      "exec_model": "gpt-5.6-terra"
    }
  ]
}
JSON
```

Record every launch and agmsg call. Run:

```bash
ARGV_LOG="$TMP/argv.log" AGMSG_LOG="$TMP/agmsg.log" \
AGMSG_DIR="$TMP/agmsg" RUNNERS_CONFIG_PATH="$TMP/runners.json" \
bash "$PREWARM" --with-design --agmsg-team demo-team \
  --cwd "$TMP/repo" --slug demo --status-dir "$TMP/status" \
  --design-runner codex --reviewer-runner codex \
  --codex-runner codex --exec-choice codex > "$TMP/result.json"
```

Assert:

```bash
[[ $(wc -l < "$TMP/argv.log" | tr -d ' ') == 3 ]] || bad 'AC1 exactly three panes'
grep -F -- '--runner codex' "$TMP/argv.log" | grep -Fq -- '--role plan' || bad 'AC2 design role'
grep -F -- '--mode review' "$TMP/argv.log" | grep -Fq -- '--runner codex' || bad 'AC3 review role'
grep -F -- '--runner codex' "$TMP/argv.log" | grep -Fq -- '--role exec' || bad 'AC4 exec role'
grep -Fq -- '--model sonnet' "$TMP/argv.log" && bad 'AC5 no sonnet pane'
grep -Fq -- ' claude-code ' "$TMP/agmsg.log" && bad 'AC6 no claude-code wiring'
jq -e '.design.engine == "codex" and .review.engine == "codex" and
  .executors.codex.engine == "codex" and (.executors.sonnet == null)' \
  "$TMP/status/prewarm.json" >/dev/null || bad 'AC7 role-aware prewarm.json'
```

- [ ] **Step 2: run both prewarm tests and confirm failure**

```bash
cd apps/cmux-team-dispatch-task
bash test/test-prewarm-all-codex.sh
bash test/test-prewarm-unattended.sh
```

Expected: all-Codex test fails because same-engine reviewer is rejected, sonnet is unconditional, and `--exec-choice` is unknown.

- [ ] **Step 3: make reviewer runner generic**

In `prewarm-panes.sh`:

- remove `REVIEWER_ENGINE == claude` validation
- resolve `REVIEWER_ENGINE`, `REVIEW_MODEL`, `REVIEW_EFFORT` from the selected runner
- require a codex reviewer to have `review_model`
- preserve the Claude fallback `opus[1m]`
- launch review with `--runner "$REVIEWER_RUNNER" --mode review`; let Task 1 resolve the model

Keep `--review-model` as a legacy design=claude compatibility input, but new role-aware callers use `--reviewer-runner`.

- [ ] **Step 4: make executor creation conditional**

Parse `--exec-choice`. Use booleans:

```bash
START_SONNET=0
START_CODEX=0
case "$EXEC_CHOICE" in
  "") START_SONNET=1; [[ -n "$CODEX_RUNNER" ]] && START_CODEX=1 ;;
  ask) START_SONNET=1; [[ -n "$CODEX_RUNNER" ]] && START_CODEX=1 ;;
  sonnet) START_SONNET=1 ;;
  codex) [[ -n "$CODEX_RUNNER" ]] || die "exec_choice=codex requires --codex-runner"; START_CODEX=1 ;;
  "opus 1m") ;;
  *) die "invalid --exec-choice '$EXEC_CHOICE'" ;;
esac
```

For design=codex + `opus 1m`, start a Claude executor only when a Claude runner was resolved; this branch is not entered by all-Codex.

- [ ] **Step 5: launch role-specific design/review/exec panes**

- design codex standby: pass `--role plan --runner "$DESIGN_RUNNER"`
- codex executor standby: pass `--role exec --runner "$CODEX_RUNNER"`
- review: pass the generic reviewer runner
- sonnet: execute its block only when `START_SONNET=1`

Rename internal comments and output variables from opus-specific names to design-role names while keeping `--with-opus` as a backward-compatible alias. Add `--with-design` as the documented name; both set `WITH_DESIGN=1`.

- [ ] **Step 6: write the new prewarm JSON**

Build this object and omit absent roles:

```json
{
  "design": {"surface_id":"surface:1","agent":"demo","runner":"codex","engine":"codex","role":"plan","delivery":"agmsg"},
  "review": {"surface_id":"surface:2","agent":"demo-review","runner":"codex","engine":"codex","role":"review","delivery":"agmsg"},
  "executors": {
    "codex": {"surface_id":"surface:3","agent":"demo-codex","runner":"codex","engine":"codex","role":"exec","delivery":"agmsg"}
  }
}
```

- [ ] **Step 7: update unattended sentinel assertions**

Change `test-prewarm-unattended.sh` to assert sentinel forwarding only for panes actually requested. Add a fixed-codex case and retain an ask case that creates the legacy candidate set. Add one compatibility assertion proving legacy `--with-opus` and documented `--with-design` produce the same design-role request.

- [ ] **Step 8: run focused tests**

```bash
cd apps/cmux-team-dispatch-task
bash test/test-prewarm-all-codex.sh
bash test/test-prewarm-unattended.sh
bash test/test-launch-workspace-codex.sh
```

Expected: all pass; AC1-AC7 prove the negative no-Claude/no-sonnet contract.

- [ ] **Step 9: inspect and commit**

```bash
git diff --check
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh \
  apps/cmux-team-dispatch-task/test/test-prewarm-all-codex.sh \
  apps/cmux-team-dispatch-task/test/test-prewarm-unattended.sh
git commit -m "feat(cmux-team-dispatch-task): all-Codex prewarm を追加する"
```

---

### Task 3: independent review_runner and engine-neutral prompt protocol

**Files:**
- Create: `apps/cmux-team-dispatch-task/test/test-codex-only-skill.sh`
- Modify: `apps/cmux-team-dispatch-task/test/test-launch-workspace-review-config.sh`
- Modify: `apps/cmux-team-dispatch-task/test/test-cleanup-close.sh`
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md:179-645,707-1515,1638-1810,2051-2226`
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md`
- Modify: `apps/cmux-team-dispatch-task/README.md`
- Modify: `apps/cmux-team-dispatch-task/CLAUDE.md`

**Interfaces:**
- Consumes: Task 2 `prewarm.json`; runner registry
- Produces: `REVIEW_POLICY=fixed|legacy`; `REVIEW_RUNNER`, `REVIEW_ENGINE`, `REVIEW_MODEL`; fixed-review Phase A-R/B-R prompt
- Fixed policy: one dedicated review pane reviews both phases regardless of implementer engine
- Legacy policy: existing cross-engine assignment remains available when `review_runner` is absent

- [ ] **Step 1: write static failing tests for config and prompt invariants**

Create `test-codex-only-skill.sh` with helpers that fail when a file is missing. Pin these strings and exclusions:

```bash
assert_contains "$SKILL" 'review_runner' 'CO1 review_runner config exists'
assert_contains "$SKILL" 'plan_model' 'CO2 plan_model schema exists'
assert_contains "$SKILL" '.executors.codex' 'CO3 executor schema is role-based'
assert_contains "$SKILL" 'fixed review runner' 'CO4 fixed review policy exists'
assert_not_contains "$SKILL" 'reviewer is ALWAYS the opposite engine' 'CO5 no opposite-engine invariant'
assert_not_contains "$SKILL" 'review pane is ALWAYS the opposite' 'CO5 no topology invariant'
assert_contains "$SKILL" '--exec-choice "$EXEC_CHOICE"' 'CO6 prewarm receives fixed choice'
assert_contains "$SKILL" '--runner "$DESIGN_RUNNER"' 'CO7 design spawn uses resolved runner'
assert_contains "$SKILL" '--runner "$REVIEW_RUNNER"' 'CO8 review spawn uses resolved runner'
assert_contains "$SKILL" '--runner "$EXEC_RUNNER"' 'CO9 exec spawn uses resolved runner'
```

Flatten the prompt text and assert the all-Codex example contains all three model names and the five config keys. Assert every non-prewarm spawn fallback passes its resolved runner, so the all-Codex path never reaches the launch script's hardcoded Claude default.

- [ ] **Step 2: run the new test and confirm failure**

```bash
cd apps/cmux-team-dispatch-task
bash test/test-codex-only-skill.sh
```

Expected: CO1-CO6 fail against v1.17.0 protocol.

- [ ] **Step 3: add `review_runner` resolution and first-run UI**

In SKILL.md Step 1f/1g specify exact precedence:

```text
project review_runner → global review_runner → legacy automatic resolver
```

Validation:

- runner name must exist
- `ask` is valid and stops fallback
- codex candidate requires non-empty `review_model`
- claude candidate may fallback to `opus[1m]`
- same engine as design is allowed
- an invalid project/global runner invalidates only that layer and continues to the next layer
- `review_mode=on` with no review-capable runner warns and disables review only for that task
- a failed review-pane spawn warns, skips that quality gate, and continues to Phase B
- an unavailable fixed `exec_choice` invalidates only that config layer and resumes the existing fallback chain

First-run custom setup asks for `plan_model` on codex runners, then offers review behavior: legacy automatic / every dispatch / fixed runner. Persist only `ask` or a fixed runner name with the existing atomic `mktemp` + `mv` update; legacy automatic leaves the key absent.

- [ ] **Step 4: replace design-engine inference with resolved role values**

Prompt placeholders must receive:

```text
DESIGN_RUNNER / DESIGN_ENGINE / PLAN_MODEL
REVIEW_POLICY / REVIEW_RUNNER / REVIEW_ENGINE / REVIEW_MODEL / REVIEW_PANE_AGENT
EXEC_CHOICE / EXEC_RUNNER / EXEC_ENGINE / EXEC_MODEL
```

Phase A text says resolved design runner/model, not `always opus`. Phase A-R builds `PARALLEL` with `REVIEW_ENGINE`.

- [ ] **Step 5: define fixed Phase B-R behavior**

When `REVIEW_POLICY=fixed`:

1. all delegated implementers write `code-review.json` using fixed review pane surface/workspace
2. `reviewer_runner` and `reviewer_engine` are explicit JSON fields
3. the same review pane handles all code rounds
4. design pane touches `.deferred` and exits after delegation; it never becomes reviewer
5. same-engine codex implementer/reviewer is valid

When `REVIEW_POLICY=legacy`, retain the six current design/implementation combinations, but write the resolver result into the same JSON fields and remove prose claiming the engine is inherently opposite.

- [ ] **Step 6: update prewarm and cleanup prompt paths**

Change child prompt lookups:

```bash
DESIGN_SURFACE=$(jq -r '.design.surface_id // empty' "$PREWARM_FILE")
REVIEW_SURFACE=$(jq -r '.review.surface_id // empty' "$PREWARM_FILE")
CODEX_SURFACE=$(jq -r '.executors.codex.surface_id // empty' "$PREWARM_FILE")
SONNET_SURFACE=$(jq -r '.executors.sonnet.surface_id // empty' "$PREWARM_FILE")
```

For final cleanup, use unique surfaces:

```bash
jq -r '.. | objects | .surface_id? // empty' ".dispatch/$slug/prewarm.json" \
  | awk 'NF && !seen[$0]++'
```

For agmsg leave, enumerate `.. | objects | .agent? // empty` and de-duplicate the same way.

- [ ] **Step 7: update review-config runtime test**

Add `reviewer_runner:"codex"` and `reviewer_engine:"codex"` to the fixture in `test-launch-workspace-review-config.sh`. Assert the generated request uses codex review parallel wording because of the explicit JSON field, without computing the opposite of implementer engine.

- [ ] **Step 8: synchronize the four specification documents**

Update SKILL.md, guide-ja.md, README.md, CLAUDE.md in this same task/commit. Each must include:

- `plan_model` / `review_model` / `exec_model`
- independent `review_runner`
- missing-key legacy behavior
- same-engine review support
- role-aware prewarm schema
- fixed `exec_choice` pane suppression
- all-Codex config example
- non-prewarm design/review/exec spawn fallback using resolved runners

- [ ] **Step 9: run focused protocol checks**

```bash
cd apps/cmux-team-dispatch-task
bash test/test-codex-only-skill.sh
bash test/test-launch-workspace-review-config.sh
bash test/test-cleanup-close.sh
bash test/test-send-prompt-callsites.sh
cd ../..
pnpm check:doc-lang
```

Expected: all pass and English/Japanese document rules remain satisfied.

- [ ] **Step 10: inspect and commit**

```bash
git diff --check
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md \
  apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md \
  apps/cmux-team-dispatch-task/README.md apps/cmux-team-dispatch-task/CLAUDE.md \
  apps/cmux-team-dispatch-task/test/test-codex-only-skill.sh \
  apps/cmux-team-dispatch-task/test/test-launch-workspace-review-config.sh \
  apps/cmux-team-dispatch-task/test/test-cleanup-close.sh
git commit -m "feat(cmux-team-dispatch-task): review runner を独立して解決する"
```

---

### Task 4: unattended loop, cleanup, and notification neutrality

**Files:**
- Modify: `apps/cmux-team-dispatch-task/test/test-loop-prompt.sh`
- Modify: `apps/cmux-team-dispatch-task/test/test-cleanup-close.sh`
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/render-loop-prompt.sh`
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh:818-1066`
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/unattended/phase-block-claude.md`
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/unattended/phase-block-codex.md`
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/unattended/review-block.md`
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/unattended/code-review-block.md`
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/loop-mode.md`
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/loop-mode-ja.md`
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md`
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md`
- Modify: `apps/cmux-team-dispatch-task/README.md`
- Modify: `apps/cmux-team-dispatch-task/CLAUDE.md`

**Interfaces:**
- Consumes: Task 3 resolved role fields and prewarm schema
- Produces: unattended prompt that names actual engines; engine-neutral wrapper variables/status; data-driven cleanup

- [ ] **Step 1: add failing all-Codex loop assertions**

Extend `test-loop-prompt.sh` with a call using:

```bash
--design-runner codex --design-engine codex \
--review-runner codex --review-engine codex \
--exec-choice codex --exec-runner codex --exec-engine codex
```

Assert output contains `Review engine: codex` and excludes:

```text
Claude design pane
claude reviewer
selected sonnet
reviewer is always the opposite
```

- [ ] **Step 2: add failing wrapper neutrality assertions**

In `test-launch-workspace-codex.sh`, assert the generated codex runner contains:

```bash
assert_contains "$execute_runner" 'SESSION_EXIT=$?' 'EN1 generic exit variable'
assert_contains "$execute_runner" 'runner session starting' 'EN2 generic starting status'
assert_not_contains "$execute_runner" 'Claude session starting' 'EN3 no Claude status label'
```

Run both tests and verify these assertions fail before implementation.

- [ ] **Step 3: pass actual role fields through render-loop-prompt.sh**

Add required CLI fields for design/review/exec runner and engine. Print them once in the deterministic prompt header. Keep `--review-model` and review pane agent. Validation must reject missing review role fields only when review is on.

- [ ] **Step 4: make unattended phase/review blocks role-based**

- phase files describe only design engine CLI behavior
- review-block uses the printed review runner/engine
- code-review-block reads the fixed review pane and `reviewer_engine`
- no block derives reviewer as the other engine
- all-Codex prompt never mentions launching a Claude/sonnet pane

- [ ] **Step 5: rename wrapper process variables and status messages**

In the generator, rename the command holder to `SESSION_CMD`; interpolate its value into the generated runner exactly where `${CLAUDE_CMD}` is currently interpolated. The generated runner itself must contain the exit handling below:

```bash
SESSION_EXIT=0
zsh -ic "resolved runner command"
SESSION_EXIT=$?
```

Replace `CLAUDE_EXIT` references with `SESSION_EXIT`. Change only generic wrapper messages to `runner session starting/completed`; retain user-facing engine names where the instruction truly differs by CLI behavior.

- [ ] **Step 6: make cleanup and agmsg leave data-driven**

Update SKILL/guide/README/CLAUDE cleanup examples to enumerate unique `surface_id` and `agent` values recursively from prewarm.json. Preserve `--workspace` on every close-surface call and the workspace-name fallback.

- [ ] **Step 7: synchronize loop and four primary docs**

Update loop-mode.md/ja and all four primary documents in the same commit. Add the all-Codex unattended example and state that only instantiated roles receive timeout sentinel and cleanup operations.

- [ ] **Step 8: run focused tests**

```bash
cd apps/cmux-team-dispatch-task
bash test/test-loop-prompt.sh
bash test/test-loop-skill.sh
bash test/test-cleanup-close.sh
bash test/test-launch-workspace-codex.sh
bash test/test-runner-signal-exit.sh
bash test/test-send-prompt-callsites.sh
cd ../..
pnpm check:doc-lang
```

Expected: all pass; existing legacy loop cases remain covered.

- [ ] **Step 9: inspect and commit**

```bash
git diff --check
git add apps/cmux-team-dispatch-task/test/test-loop-prompt.sh \
  apps/cmux-team-dispatch-task/test/test-cleanup-close.sh \
  apps/cmux-team-dispatch-task/test/test-launch-workspace-codex.sh \
  apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/render-loop-prompt.sh \
  apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh \
  apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/unattended/phase-block-claude.md \
  apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/unattended/phase-block-codex.md \
  apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/unattended/review-block.md \
  apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/unattended/code-review-block.md \
  apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/loop-mode.md \
  apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/loop-mode-ja.md \
  apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md \
  apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md \
  apps/cmux-team-dispatch-task/README.md apps/cmux-team-dispatch-task/CLAUDE.md
git commit -m "refactor(cmux-team-dispatch-task): 実行経路を role ベースに統一する"
```

---

### Task 5: release, full verification, cachebuster, reinstall, and push

**Files:**
- Modify: `apps/cmux-team-dispatch-task/.claude-plugin/plugin.json`
- Modify: `apps/cmux-team-dispatch-task/.codex-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`
- Do not modify: `.agents/plugins/marketplace.json`

**Interfaces:**
- Consumes: Tasks 1-4 passing implementation
- Produces: version `1.18.0`, Codex cachebuster install, pushed commits

- [ ] **Step 1: run every plugin test before release metadata changes**

```bash
cd apps/cmux-team-dispatch-task
for test_file in test/test-*.sh; do
  echo "RUN $test_file"
  bash "$test_file" || exit 1
done
```

Expected: every test exits 0.

- [ ] **Step 2: run repository checks**

```bash
cd ../..
pnpm check
pnpm check:doc-lang
pnpm format
pnpm sort-package
sed -n '1,110p' apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh
```

Expected: the four checks exit 0. `pnpm check` includes Turbo checks and doc language validation. The script currently has no `--help` handler, so compare its usage header's role/model options with SKILL.md instead of adding unrelated CLI behavior. Compare SKILL.md headings with `references/guide-ja.md`; record any intentional language-only heading difference.

- [ ] **Step 3: set base version 1.18.0**

Update both plugin manifests to `1.18.0`. Update only the `cmux-team-dispatch-task` entry in `.claude-plugin/marketplace.json` with a structured jq transform:

```bash
tmp_file=$(mktemp .claude-plugin/marketplace.json.XXXXXX)
jq '(.plugins[] | select(.name == "cmux-team-dispatch-task") | .version) = "1.18.0"' \
  .claude-plugin/marketplace.json > "$tmp_file"
mv "$tmp_file" .claude-plugin/marketplace.json
```

Confirm `.agents/plugins/marketplace.json` is absent from `git diff --name-only`.

- [ ] **Step 4: validate base release metadata and commit**

```bash
jq -e '.version == "1.18.0"' apps/cmux-team-dispatch-task/.claude-plugin/plugin.json
jq -e '.version == "1.18.0"' apps/cmux-team-dispatch-task/.codex-plugin/plugin.json
jq -e '.plugins[] | select(.name == "cmux-team-dispatch-task" and .version == "1.18.0")' \
  .claude-plugin/marketplace.json
git diff --check
git add apps/cmux-team-dispatch-task/.claude-plugin/plugin.json \
  apps/cmux-team-dispatch-task/.codex-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "release(cmux-team-dispatch-task): v1.18.0"
```

- [ ] **Step 5: apply the Codex cachebuster helper**

Run from the plugin-creator skill root:

```bash
cd /Users/yui/.codex/skills/.system/plugin-creator
python3 scripts/update_plugin_cachebuster.py \
  /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins/apps/cmux-team-dispatch-task
```

Confirm the Codex version matches regex `^1[.]18[.]0[+]codex[.]local-[0-9]{8}-[0-9]{6}$` and contains exactly one `+codex.` suffix.

- [ ] **Step 6: validate and reinstall from the existing local marketplace**

```bash
cd /Users/yui/.codex/skills/.system/plugin-creator
python3 scripts/validate_plugin.py \
  /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins/apps/cmux-team-dispatch-task

marketplace_name=$(python3 scripts/read_marketplace_name.py \
  --marketplace-path /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins/.agents/plugins/marketplace.json)
codex plugin list
codex plugin add "cmux-team-dispatch-task@$marketplace_name"
```

Expected: the marketplace is local and points at this repository; reinstall succeeds without editing marketplace.json.

- [ ] **Step 7: run an actual all-Codex cmux E2E against the reinstalled plugin**

Create a disposable repository and back up the two user-level plugin configuration files before changing them:

```bash
E2E_REPO=$(mktemp -d /private/tmp/cmux-team-dispatch-codex-e2e.XXXXXX)
E2E_BACKUP=$(mktemp -d /private/tmp/cmux-team-dispatch-config-backup.XXXXXX)
E2E_CONFIG_DIR="$HOME/.claude/cmux-team-dispatch-task"
mkdir -p "$E2E_CONFIG_DIR" "$E2E_REPO/.dispatch"
[[ ! -f "$E2E_CONFIG_DIR/config.json" ]] || cp -p "$E2E_CONFIG_DIR/config.json" "$E2E_BACKUP/config.json"
[[ ! -f "$E2E_CONFIG_DIR/runners.json" ]] || cp -p "$E2E_CONFIG_DIR/runners.json" "$E2E_BACKUP/runners.json"
git -C "$E2E_REPO" init
git -C "$E2E_REPO" config user.name codex-e2e
git -C "$E2E_REPO" config user.email codex-e2e@example.invalid
```

Use `apply_patch` with the resolved `$E2E_REPO` path to create `.dispatch/config.json`:

```json
{
  "design_runner": "codex",
  "review_runner": "codex",
  "exec_choice": "codex",
  "review_mode": "on",
  "prewarm": true
}
```

Use `apply_patch` with the resolved `$E2E_CONFIG_DIR` path to write this temporary `runners.json`:

```json
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
    }
  ]
}
```

From a fresh Codex session rooted at `$E2E_REPO`, invoke the reinstalled `cmux-team-dispatch-task` skill with this exact task: `Create sum.sh with a shell function that adds two integers, add a shell test covering positive and negative integers, and run the test.` Let it complete Phase A → A-R → B → B-R. Inspect `cmux tree`, each pane command line, `.dispatch/*/prewarm.json`, and the descendant process table with `ps -axo pid,ppid,command`. Save this evidence under `$E2E_REPO/evidence/` and verify that:

- design/review command includes `gpt-5.6-sol`
- implementation command includes `gpt-5.6-terra`
- `review_mode=on` reaches review with no Claude runner registered
- child `claude` process count is 0
- child `--model sonnet` process count is 0

Immediately restore the exact pre-E2E user state:

```bash
if [[ -f "$E2E_BACKUP/config.json" ]]; then
  cp -p "$E2E_BACKUP/config.json" "$E2E_CONFIG_DIR/config.json"
else
  rm -f "$E2E_CONFIG_DIR/config.json"
fi
if [[ -f "$E2E_BACKUP/runners.json" ]]; then
  cp -p "$E2E_BACKUP/runners.json" "$E2E_CONFIG_DIR/runners.json"
else
  rm -f "$E2E_CONFIG_DIR/runners.json"
fi
```

- [ ] **Step 8: commit the intentional Codex-only cachebuster suffix**

```bash
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins
git diff --check
git add apps/cmux-team-dispatch-task/.codex-plugin/plugin.json
git commit -m "chore(cmux-team-dispatch-task): Codex cachebuster を更新する"
```

- [ ] **Step 9: final verification after cachebuster**

```bash
cd apps/cmux-team-dispatch-task
for test_file in test/test-*.sh; do bash "$test_file" || exit 1; done
cd ../..
pnpm check
pnpm check:doc-lang
git status --short
git log --oneline --decorate -8
```

Expected: tests/checks pass and worktree is clean.

- [ ] **Step 10: push and notify the parent workspace**

```bash
git push origin main
```

Then send one completion notification:

```bash
CMUX_BIN=/Applications/cmux.app/Contents/Resources/bin/cmux \
bash apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/send-prompt.sh \
  --to-workspace C459840B-AE9B-4A99-8966-172319F41663 \
  --label dispatch-notify \
  --outbox-dir /private/tmp/codex-only-dispatch-plugin/outbox \
  -- '[phase-a-task-3] 完了: all-Codex role 構成を実装・検証し、v1.18.0 cachebuster 再インストールと commit/push を完了しました。plan/review=gpt-5.6-sol、exec=gpt-5.6-terra、Claude process なしを確認済みです。'
```
