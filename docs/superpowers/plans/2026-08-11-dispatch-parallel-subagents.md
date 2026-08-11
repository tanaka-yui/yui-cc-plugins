# cmux-team-dispatch-task 並列実行ディレクティブ 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `cmux-team-dispatch-task` が起動する子セッション（claude / codex の 5 モード）に「独立作業は並列化せよ」という指示を届け、1 タスク内の調査と検証を並列化させる。

**Architecture:** 文面の単一情報源として `scripts/parallel-directive.sh` を新設する。`launch-workspace.sh` は plan / superpowers / execute の起動プロンプトへ連結し、standby / review のペインは起動時プロンプトを持たないため、親セッションが `cmux send` で送る指示文に同じスクリプトの出力を含める（SKILL.md 側で指示）。

**Tech Stack:** bash（本体・テストとも）。ビルドツールもランタイム依存も無い。テストは stub の `cmux` を PATH に置いて `launch-workspace.sh` を実行し、生成された runner script を `grep` で検査する既存方式。

## Global Constraints

- 対象リポジトリは `/Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins`。
- **`parallel-directive.sh` の出力に `'` `"` `` ` `` `$` `!` `\` を 1 文字も含めてはならない。** 出力は `zsh -ic "... '<prompt>' ..."` という二重引用の内側に置かれ、`launch-workspace.sh` はエスケープを一切行わない。`-i` は対話モードなので history 展開が効き `!` も特殊文字になる。
- 出力は改行を含まない 1 行（末尾の改行のみ）。
- `--agents` の既定値は `4`、許容範囲は `2`〜`8` の整数。オフにする手段は `--no-parallel` のみ。
- 引数バリデーションの失敗は **cmux ペインを起動する前**に非ゼロ終了すること。
- superpowers への譲歩文（`subagent-driven-development` の逐次規則を上書きしない旨）は **engine / mode で出し分けず、常に出力する**。
- `launch-workspace.sh` が起動時プロンプトを組み立てるのは **plan / superpowers / execute の 3 モードだけ**。standby / review はプロンプト無し（または idle 待機文のみ）で起動するので、ディレクティブを起動プロンプトへ入れてはならない。
- `review/code-review.json` の `reviewer_engine` が欠落している場合（旧スキーマ）は**ディレクティブを埋め込まない**（後方互換）。
- **4 ファイル一致ルール**: `SKILL.md` / `references/guide-ja.md` / `README.md` / `CLAUDE.md` の機能仕様は完全一致させる。1 つ更新したら残り 3 つも同じ commit で更新する。
- 言語規約: `SKILL.md` / `references/*.md`（`*-ja.md` を除く）は**英語必須**。`CLAUDE.md` / `README.md` / `references/*-ja.md` は日本語。bash のコメントは日本語、識別子と CLI フラグは英語。`SKILL.md` と `guide-ja.md` は見出しを 1:1 対応させる。
- バージョン: `cmux-team-dispatch-task` を `1.13.0` → `1.14.0`。`apps/cmux-team-dispatch-task/.claude-plugin/plugin.json` / `apps/cmux-team-dispatch-task/.codex-plugin/plugin.json` / ルート `.claude-plugin/marketplace.json` の 3 箇所を同期する。

---

### Task 1: parallel-directive.sh とその回帰テスト

**Files:**
- Create: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/parallel-directive.sh`
- Test: `apps/cmux-team-dispatch-task/test/test-parallel-directive.sh`

**Interfaces:**
- Consumes: なし（最初のタスク）
- Produces: `parallel-directive.sh --engine <claude|codex> --mode <plan|superpowers|execute|review> [--agents <N>]` — 標準出力へ改行 1 つで終わる 1 行のディレクティブを出す。引数が不正なら stderr にメッセージを出して exit 1。Task 2 と Task 3 がこの CLI を呼ぶ。

- [ ] **Step 1: 失敗するテストを書く**

`apps/cmux-team-dispatch-task/test/test-parallel-directive.sh` を新規作成する。

```bash
#!/usr/bin/env bash
# parallel-directive.sh の回帰テスト。
#
# 守っている不変条件:
#   PD1. codex 向けは spawn_agent / wait_agent を指示する
#   PD2. claude 向けは Task サブエージェントを指示し、spawn_agent を含まない
#   PD3. 全 engine × 全 mode で superpowers の逐次規則を上書きしない旨を含む
#   PD4. 全 engine × 全 mode の出力に ' " ` $ ! \ が 1 文字も含まれない
#        (出力は zsh -ic "... '<prompt>' ..." の内側に素で置かれ、エスケープされない)
#   PD5. 全モードでファイル編集を逐次に保つ禁止文を含む
#   PD6. --agents が出力に反映され、2..8 以外はエラー終了する
#   PD7. 不正な --engine / --mode はエラー終了する

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/parallel-directive.sh"
[[ -f "$BIN" ]] || { echo "FAIL: スクリプトが見つからない: $BIN"; exit 2; }

fail=0
ENGINES=(claude codex)
MODES=(plan superpowers execute review)

emit() { bash "$BIN" --engine "$1" --mode "$2" ${3:+--agents "$3"}; }

# --- PD1: codex 向けは spawn_agent / wait_agent ---
o=$(emit codex execute)
if grep -q 'spawn_agent' <<<"$o" && grep -q 'wait_agent' <<<"$o"; then
  echo "PASS PD1: codex 向けは spawn_agent / wait_agent を指示する"
else
  echo "FAIL PD1: [$o]"; fail=1
fi

# --- PD2: claude 向けは Task サブエージェント、spawn_agent を含まない ---
o=$(emit claude execute)
if grep -q 'Task subagents' <<<"$o" && ! grep -q 'spawn_agent' <<<"$o"; then
  echo "PASS PD2: claude 向けは Task サブエージェントを指示し spawn_agent を含まない"
else
  echo "FAIL PD2: [$o]"; fail=1
fi

# --- PD3: superpowers 譲歩文が全 engine × 全 mode に入る ---
pd3=1
for e in "${ENGINES[@]}"; do
  for m in "${MODES[@]}"; do
    o=$(emit "$e" "$m")
    grep -q 'subagent-driven-development' <<<"$o" || { echo "  missing SDD clause: $e/$m"; pd3=0; }
    grep -q 'one-implementer-at-a-time' <<<"$o" || { echo "  missing one-implementer clause: $e/$m"; pd3=0; }
  done
done
if [[ $pd3 -eq 1 ]]; then
  echo "PASS PD3: 全 engine × 全 mode に superpowers 譲歩文が入る"
else
  echo "FAIL PD3: 譲歩文が欠けている組み合わせがある"; fail=1
fi

# --- PD4: 禁止文字が 1 文字も含まれない ---
pd4=1
for e in "${ENGINES[@]}"; do
  for m in "${MODES[@]}"; do
    o=$(emit "$e" "$m")
    if [[ "$o" == *\'* || "$o" == *\"* || "$o" == *\`* || "$o" == *\$* || "$o" == *'!'* || "$o" == *\\* ]]; then
      echo "  forbidden character in: $e/$m"
      pd4=0
    fi
    # 改行を含まない 1 行であること
    if [[ "$(printf '%s' "$o" | wc -l | tr -d ' ')" != "0" ]]; then
      echo "  multi-line output: $e/$m"
      pd4=0
    fi
  done
done
if [[ $pd4 -eq 1 ]]; then
  echo "PASS PD4: 全組み合わせでクォート・展開文字を含まない 1 行出力"
else
  echo "FAIL PD4: 禁止文字または改行が混入している"; fail=1
fi

# --- PD5: ファイル編集を逐次に保つ禁止文 ---
pd5=1
for e in "${ENGINES[@]}"; do
  for m in "${MODES[@]}"; do
    o=$(emit "$e" "$m")
    grep -q 'File edits stay in the parent agent and stay sequential' <<<"$o" || { echo "  missing guardrail: $e/$m"; pd5=0; }
  done
done
if [[ $pd5 -eq 1 ]]; then
  echo "PASS PD5: 全組み合わせでファイル編集の逐次維持を指示する"
else
  echo "FAIL PD5: 逐次維持の禁止文が欠けている組み合わせがある"; fail=1
fi

# --- PD6: --agents の反映と範囲チェック ---
o=$(emit codex execute 5)
bad=0
grep -q 'at most 5 child agents' <<<"$o" || bad=1
bash "$BIN" --engine codex --mode execute --agents 1 >/dev/null 2>&1 && bad=1
bash "$BIN" --engine codex --mode execute --agents 9 >/dev/null 2>&1 && bad=1
bash "$BIN" --engine codex --mode execute --agents abc >/dev/null 2>&1 && bad=1
if [[ $bad -eq 0 ]]; then
  echo "PASS PD6: --agents 5 が反映され 1 / 9 / abc は拒否される"
else
  echo "FAIL PD6: [$o]"; fail=1
fi

# --- PD7: 不正な --engine / --mode ---
bad=0
bash "$BIN" --engine gpt --mode execute >/dev/null 2>&1 && bad=1
bash "$BIN" --engine codex --mode standby >/dev/null 2>&1 && bad=1
bash "$BIN" --engine codex >/dev/null 2>&1 && bad=1
bash "$BIN" --mode execute >/dev/null 2>&1 && bad=1
if [[ $bad -eq 0 ]]; then
  echo "PASS PD7: 不正な engine / mode / 省略を拒否する"
else
  echo "FAIL PD7: 不正な引数が通ってしまった"; fail=1
fi

[[ $fail -eq 0 ]] && echo "--- すべて PASS ---" || echo "--- FAIL あり ---"
exit $fail
```

**注意**: `--mode standby` は PD7 で**拒否される**ことを検証している。standby は実行系なので、呼び出し側が `--mode execute` を渡す約束にしている（Task 4 の SKILL.md 側で明示する）。

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `bash apps/cmux-team-dispatch-task/test/test-parallel-directive.sh`
Expected: `FAIL: スクリプトが見つからない: .../parallel-directive.sh` で exit 2

- [ ] **Step 3: スクリプトを実装する**

`apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/parallel-directive.sh` を新規作成する。

```bash
#!/usr/bin/env bash
set -euo pipefail

# parallel-directive.sh — 子セッションへ渡す並列実行ディレクティブを 1 行で出力する。
#
# launch-workspace.sh が plan / superpowers / execute の起動プロンプトへ連結するほか、
# 親セッションが cmux send で送る実行指示・レビュー依頼にも同じ文面を含めさせる
# (SKILL.md 参照)。文面が各所へ散らないための単一情報源。
#
# 出力は zsh -ic "... '<prompt>' ..." という二重引用の内側に素で置かれる。
# launch-workspace.sh はエスケープを一切行わないため、' " ` $ ! \ を 1 文字も
# 含めてはならない (-i は対話モードなので history 展開が効き ! も特殊文字になる)。
#
# Usage: parallel-directive.sh --engine <claude|codex> --mode <plan|superpowers|execute|review> [--agents <N>]
#   --agents <N>  同時に走らせる子エージェントの上限 2..8 (default: 4)
#
# standby モードは実行系なので、呼び出し側が --mode execute を渡すこと。

ENGINE=""; MODE=""; AGENTS=4
while [[ $# -gt 0 ]]; do
  case "$1" in
    --engine) ENGINE="${2:-}"; shift 2 ;;
    --mode)   MODE="${2:-}"; shift 2 ;;
    --agents) AGENTS="${2:-}"; shift 2 ;;
    *) echo "parallel-directive: unknown argument: $1" >&2; exit 1 ;;
  esac
done

[[ "$ENGINE" == "claude" || "$ENGINE" == "codex" ]] \
  || { echo "parallel-directive: --engine must be claude or codex" >&2; exit 1; }
case "$MODE" in
  plan|superpowers|execute|review) ;;
  *) echo "parallel-directive: --mode must be plan, superpowers, execute or review" >&2; exit 1 ;;
esac
[[ "$AGENTS" =~ ^[2-8]$ ]] \
  || { echo "parallel-directive: --agents must be an integer from 2 to 8" >&2; exit 1; }

# engine ごとの並列化機構
if [[ "$ENGINE" == "codex" ]]; then
  MECHANISM="you MUST fan them out with spawn_agent and collect them with wait_agent"
else
  MECHANISM="you MUST fan them out by launching several Task subagents in a single message"
fi

# mode ごとの分担
case "$MODE" in
  plan|superpowers)
    PHASES="Before you design anything, split the investigation across read-only child agents and run them at the same time: blast radius, existing implementation patterns, test layout, and related documentation. Merge their findings before you start writing the plan."
    ;;
  execute)
    PHASES="Right after you read the plan, split the investigation across read-only child agents and run them at the same time: blast radius, existing implementation patterns, test layout, and related documentation. Merge their findings before you edit anything. Once the implementation is finished, split verification the same way: type checking, linting, tests, and documentation consistency."
    ;;
  review)
    PHASES="Give each review lens its own child agent and run them at the same time: correctness and bugs, security, design and readability, and test coverage. Gather what they report, drop the duplicates, and present one review ordered by severity."
    ;;
esac

# 逐次を守らせる禁止文と superpowers への譲歩。engine / mode で出し分けない。
# codex も superpowers パイプラインを辿る (launch-workspace.sh の codex superpowers は
# プロンプトに superpowers:brainstorming を前置する) ため、claude 限定にすると漏れる。
GUARDRAIL="File edits stay in the parent agent and stay sequential. Never let two child agents edit files in this worktree at the same time. This applies to investigation and verification only. It never overrides a skill that sequences implementation for you: if you are following superpowers subagent-driven-development, keep its one-implementer-at-a-time rule exactly as written."

printf '%s\n' "PARALLEL EXECUTION, mandatory: whenever two or more pieces of work are independent, ${MECHANISM} instead of doing them one after another. Run at most ${AGENTS} child agents at a time. ${PHASES} ${GUARDRAIL}"
```

実行権限を付ける:

```bash
chmod +x apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/parallel-directive.sh
```

- [ ] **Step 4: テストを実行して全 PASS を確認する**

Run: `bash apps/cmux-team-dispatch-task/test/test-parallel-directive.sh`
Expected: `PASS PD1` 〜 `PASS PD7` がすべて出て `--- すべて PASS ---`

- [ ] **Step 5: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/parallel-directive.sh \
        apps/cmux-team-dispatch-task/test/test-parallel-directive.sh
git commit -m "feat(cmux-team-dispatch-task): 並列実行ディレクティブの生成スクリプトを追加する"
```

---

### Task 2: launch-workspace.sh の起動プロンプトへ連結

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh`
- Test: `apps/cmux-team-dispatch-task/test/test-launch-workspace-codex.sh`

**Interfaces:**
- Consumes: Task 1 の `parallel-directive.sh --engine <claude|codex> --mode <plan|superpowers|execute|review> [--agents <N>]`
- Produces: `launch-workspace.sh` の新引数 `--no-parallel` / `--agents <N>`、およびシェル変数 `NO_PARALLEL`（0/1）と `MAX_AGENTS`（2〜8 の整数）。Task 3 が同じ 2 変数を `REVIEW_INSTRUCTION` の組み立てで使う。

- [ ] **Step 1: 失敗するテストを書く（PL1 / PL2 / PL3）**

`apps/cmux-team-dispatch-task/test/test-launch-workspace-codex.sh` を編集する。ファイル冒頭のコメント（`# launch-workspace.sh が Codex runner 向けに生成するコマンドの回帰テスト。` の次の行）に追記する。

```bash
# 並列実行ディレクティブ (PL1-PL5) もここで検証する。
```

既存の `review_runner=$(runner_for review)` 行の後ろで、`assert_contains "$superpowers_runner" ...` 群より前に、`--no-parallel` 版と `--agents` 検証用のヘルパーを追加する。

```bash
runner_for_flags() {
  local mode="$1"; shift
  local name="codex-$mode-flags"
  local output
  if [[ "$mode" == "execute" ]]; then
    output=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" bash "$LAUNCH" \
      --cwd "$TMP/repo" --mode "$mode" --runner codex --plan-file "$TMP/plan.md" --status-dir "$TMP/status" "$@" "$name")
  else
    output=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" bash "$LAUNCH" \
      --cwd "$TMP/repo" --mode "$mode" --runner codex --status-dir "$TMP/status" "$@" "$name" prompt)
  fi
  jq -r '.runner_file' <<<"$output"
}
```

ファイル末尾の `[[ $fail -eq 0 ]]` 行の直前に次を追加する。

```bash
# --- PL1: plan / superpowers / execute の起動プロンプトにディレクティブが入る ---
assert_contains "$plan_runner" 'PARALLEL EXECUTION, mandatory' 'PL1 codex plan で並列ディレクティブが入る'
assert_contains "$superpowers_runner" 'PARALLEL EXECUTION, mandatory' 'PL1 codex superpowers で並列ディレクティブが入る'
assert_contains "$execute_runner" 'PARALLEL EXECUTION, mandatory' 'PL1 codex execute で並列ディレクティブが入る'
assert_contains "$execute_runner" 'spawn_agent' 'PL1 codex には spawn_agent が届く'

# --- PL2: --no-parallel でディレクティブが入らない ---
np_execute=$(runner_for_flags execute --no-parallel)
assert_not_contains "$np_execute" 'PARALLEL EXECUTION, mandatory' 'PL2 --no-parallel でディレクティブ非注入'

# --- PL3: standby / review の起動プロンプトにはディレクティブを入れない ---
# (両モードはプロンプト無し / idle 待機文のみで起動し、指示は後から cmux send で届く)
assert_not_contains "$standby_runner" 'PARALLEL EXECUTION, mandatory' 'PL3 standby はディレクティブ非注入'
assert_not_contains "$review_runner" 'PARALLEL EXECUTION, mandatory' 'PL3 review はディレクティブ非注入'

# --- PL4: execute では EXIT_INSTRUCTION がディレクティブより後ろに来る ---
# (exit 指示の後ろに別の指示が続くと優先順位が曖昧になる)
pl4_line=$(grep -o 'PARALLEL EXECUTION, mandatory.*end this codex session' "$execute_runner" | head -1)
if [[ -n "$pl4_line" ]]; then
  echo 'PASS: PL4 exit 指示がディレクティブより後ろにある'
else
  echo 'FAIL: PL4 exit 指示がディレクティブより前にある、または片方が欠けている'
  fail=1
fi

# --- PL5: --agents の不正値は非ゼロ終了する ---
pl5_bad=0
CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" bash "$LAUNCH" \
  --cwd "$TMP/repo" --mode execute --runner codex --plan-file "$TMP/plan.md" \
  --agents 9 codex-agents-bad >/dev/null 2>&1 && pl5_bad=1
CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" bash "$LAUNCH" \
  --cwd "$TMP/repo" --mode execute --runner codex --plan-file "$TMP/plan.md" \
  --agents abc codex-agents-bad2 >/dev/null 2>&1 && pl5_bad=1
if [[ $pl5_bad -eq 0 ]]; then
  echo 'PASS: PL5 --agents の不正値を拒否する'
else
  echo 'FAIL: PL5 --agents の不正値が通ってしまった'
  fail=1
fi

# --- PL6: claude engine には Task サブエージェントの文面が届く ---
claude_exec_output=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" bash "$LAUNCH" \
  --cwd "$TMP/repo" --mode execute --runner claude --plan-file "$TMP/plan.md" claude-parallel)
claude_exec_runner=$(jq -r '.runner_file' <<<"$claude_exec_output")
assert_contains "$claude_exec_runner" 'Task subagents' 'PL6 claude execute には Task サブエージェント指示が届く'
assert_not_contains "$claude_exec_runner" 'spawn_agent' 'PL6 claude には spawn_agent が届かない'
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `bash apps/cmux-team-dispatch-task/test/test-launch-workspace-codex.sh`
Expected: `FAIL: PL1 codex plan で並列ディレクティブが入る (missing: PARALLEL EXECUTION, mandatory)` などが出て非ゼロ終了

- [ ] **Step 3: 引数を追加する**

`launch-workspace.sh` を編集する。

(a) ヘッダの Usage コメントで `--dangerously-skip-permissions` を説明している行（`#   --skip-permissions ...` の記述の直後）に追記する。

```bash
#   --no-parallel                      並列実行ディレクティブを起動プロンプトへ入れない
#   --agents <N>                       同時に走らせる子エージェントの上限 2..8 (default: 4)
```

(b) 既定値の初期化（`MODE="plan"` の近く、`MODEL=""` の行の直後）に追記する。

```bash
NO_PARALLEL=0
MAX_AGENTS=4
```

(c) 引数パースの `case` に 2 ケースを追加する。`--model)` のケースの直後に置く。

```bash
    --no-parallel) NO_PARALLEL=1; shift ;;
    --agents)      MAX_AGENTS="$2"; shift 2 ;;
```

(d) バリデーションを追加する。`--effort` の解決ブロックの直後、Step 2 のディレクトリ準備より前に置く。

```bash
# --agents はプロンプトへ埋め込まれる。範囲外・非数値は cmux ペインを起動する前に弾く
[[ "$MAX_AGENTS" =~ ^[2-8]$ ]] || die "--agents must be an integer from 2 to 8"
```

- [ ] **Step 4: ディレクティブを起動プロンプトへ連結する**

同じファイルで、`# execute モードでは計画ファイルを直接 inner prompt に埋め込む。` のコメントブロックの**直前**に次を挿入する。

```bash
# 並列実行ディレクティブ。plan / superpowers / execute の起動プロンプトにだけ連結する。
# standby / review はプロンプト無し (idle 待機文のみ) で起動し、実際の指示は後から
# cmux send で届くため、ここでは扱わない (SKILL.md 側が parallel-directive.sh を
# 実行して送信テキストに含める)。
PARALLEL_INSTRUCTION=""
if [[ $NO_PARALLEL -eq 0 ]] \
  && [[ "$MODE" == "plan" || "$MODE" == "superpowers" || "$MODE" == "execute" ]]; then
  PARALLEL_INSTRUCTION=$(bash "$SCRIPT_DIR/parallel-directive.sh" \
    --engine "$RUNNER_ENGINE" --mode "$MODE" --agents "$MAX_AGENTS")
fi
```

次に、execute モードの `PROMPT_TEXT` 組み立て行を差し替える。

変更前:
```bash
  PROMPT_TEXT="Read and execute the plan at $PLAN_FILE. ${REVIEW_INSTRUCTION}${ABORT_INSTRUCTION}${EXIT_INSTRUCTION}"
```

変更後（`EXIT_INSTRUCTION` は必ず最後に残す）:
```bash
  PROMPT_TEXT="Read and execute the plan at $PLAN_FILE. ${REVIEW_INSTRUCTION}${ABORT_INSTRUCTION}${PARALLEL_INSTRUCTION:+$PARALLEL_INSTRUCTION }${EXIT_INSTRUCTION}"
```

続く `else` ブランチの行も差し替える。

変更前:
```bash
  PROMPT_TEXT="Read and follow the task in .cmux-team-dispatch-task-prompt.md"
```

変更後:
```bash
  PROMPT_TEXT="Read and follow the task in .cmux-team-dispatch-task-prompt.md${PARALLEL_INSTRUCTION:+ $PARALLEL_INSTRUCTION}"
```

この `else` ブランチは standby / review でも通るが、その 2 モードでは `PARALLEL_INSTRUCTION` が空なので何も足されない。さらに直後の `if [[ "$MODE" == "standby" || "$MODE" == "review" ]]` が `PROMPT_TEXT="$PROMPT"` で上書きするため、二重に安全である。

- [ ] **Step 5: テストを実行して PL1〜PL6 が通ることを確認する**

Run: `bash apps/cmux-team-dispatch-task/test/test-launch-workspace-codex.sh`
Expected: 既存の T1〜T15 も含めてすべて PASS し `--- all tests passed ---`

- [ ] **Step 6: 他の launch-workspace 系テストが壊れていないことを確認する**

Run:
```bash
bash apps/cmux-team-dispatch-task/test/test-launch-workspace-permissions.sh
bash apps/cmux-team-dispatch-task/test/test-launch-workspace-layout.sh
bash apps/cmux-team-dispatch-task/test/test-launch-workspace-review-config.sh
```
Expected: 3 本とも PASS。特に `test-launch-workspace-review-config.sh` の T5（`REVIEW_INSTRUCTION` にクォート文字が混入していないこと）が通ること

- [ ] **Step 7: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh \
        apps/cmux-team-dispatch-task/test/test-launch-workspace-codex.sh
git commit -m "feat(cmux-team-dispatch-task): plan / superpowers / execute の起動プロンプトへ並列指示を注入する"
```

---

### Task 3: レビュー依頼文への注入（Phase B-R spawn 経路）

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh`
- Test: `apps/cmux-team-dispatch-task/test/test-launch-workspace-review-config.sh`

**Interfaces:**
- Consumes: Task 1 の `parallel-directive.sh`（`--mode review` で呼ぶ）、Task 2 が定義した `NO_PARALLEL` / `MAX_AGENTS`
- Produces: `review/code-review.json` の新キー `reviewer_engine`（値は `claude` または `codex`）。Task 4 の SKILL.md がこのキーを書く側を指示する

- [ ] **Step 1: 失敗するテストを書く（PR1 / PR2）**

`apps/cmux-team-dispatch-task/test/test-launch-workspace-review-config.sh` を編集する。ファイル冒頭のコメント 4 行目（`# read-screen への埋め込み（欠落時フォールバック含む）/ クォート文字の混入なし。`）を次に差し替える。

```bash
# read-screen への埋め込み（欠落時フォールバック含む）/ クォート文字の混入なし /
# reviewer_engine による並列レビュー指示の埋め込み（欠落時は非注入）。
```

既存の `code-review-legacy.json` を書き出すヒアドキュメントの直後に、`reviewer_engine` 付きの config を 2 つ追加する。

```bash
cat > "$TMP/status/review/code-review-codex-reviewer.json" <<JSON
{
  "reviewer_surface": "surface:99",
  "reviewer_workspace": "workspace:7",
  "reviewer_engine": "codex",
  "review_dir": "$TMP/status/review"
}
JSON

cat > "$TMP/status/review/code-review-claude-reviewer.json" <<JSON
{
  "reviewer_surface": "surface:99",
  "reviewer_workspace": "workspace:7",
  "reviewer_engine": "claude",
  "review_dir": "$TMP/status/review"
}
JSON
```

ファイル末尾の `[[ $fail -eq 0 ]]` 行の直前に次を追加する。

```bash
# --- PR1: reviewer_engine ありならレビュー依頼文に review モードのディレクティブが入る ---
codex_reviewer=$(runner_with_config claude "$TMP/status/review/code-review-codex-reviewer.json" review-cfg-codex-rev)
assert_contains "$codex_reviewer" 'PARALLEL EXECUTION, mandatory' 'PR1 reviewer_engine=codex でディレクティブが入る'
assert_contains "$codex_reviewer" 'spawn_agent' 'PR1 codex レビュアーには spawn_agent が届く'
assert_contains "$codex_reviewer" 'Give each review lens its own child agent' 'PR1 review モードの文面が使われる'

claude_reviewer=$(runner_with_config codex "$TMP/status/review/code-review-claude-reviewer.json" review-cfg-claude-rev)
assert_contains "$claude_reviewer" 'Task subagents' 'PR1 claude レビュアーには Task サブエージェント指示が届く'
assert_not_contains "$claude_reviewer" 'spawn_agent' 'PR1 claude レビュアーに spawn_agent は届かない'

# --- PR2: reviewer_engine 欠落 (旧スキーマ) では注入しない ---
assert_not_contains "$runner_file" 'PARALLEL EXECUTION, mandatory' 'PR2 reviewer_engine 欠落ではディレクティブ非注入'
assert_not_contains "$legacy_runner" 'PARALLEL EXECUTION, mandatory' 'PR2 旧スキーマではディレクティブ非注入'

# --- PR3: ディレクティブを足しても REVIEW_INSTRUCTION はクォートフリーのまま ---
pr3_segment=$(grep -o 'MANDATORY CODE REVIEW.*in the PR body and proceed\.' "$codex_reviewer" | head -1)
if [[ -z "$pr3_segment" ]]; then
  echo 'FAIL: PR3 review segment not extractable'
  fail=1
elif [[ "$pr3_segment" == *\'* || "$pr3_segment" == *\"* || "$pr3_segment" == *\`* ]]; then
  echo 'FAIL: PR3 review instruction contains quote characters'
  fail=1
else
  echo 'PASS: PR3 review instruction is quote-free with the directive'
fi
```

**注意**: `$runner_file` は既存テストが `code-review.json`（`reviewer_engine` なし）で作った runner なので、PR2 の 1 本目はそれを再利用している。Task 2 で execute モードに起動プロンプト用のディレクティブが入っているのに `assert_not_contains` が通るのは、この 4 本の呼び出しが `--no-parallel` を渡していないためではなく、**PR2 が検査しているのは同じ runner ファイルの中に `PARALLEL EXECUTION` が現れるかどうか**だからである。したがって **Step 3 の実装より前に、`runner_with_config` へ `--no-parallel` を足す必要がある**（下記 Step 2 参照）。

- [ ] **Step 2: `runner_with_config` を `--no-parallel` 付きにする**

Task 2 で execute モードの起動プロンプトにディレクティブが入るようになったため、そのままだと PR2 の `assert_not_contains` が起動プロンプト側のディレクティブを拾って必ず落ちる。このテストが検証したいのは**レビュー依頼文への注入**なので、起動プロンプト側を無効化して切り分ける。

`runner_with_config` の `bash "$LAUNCH"` 呼び出しに `--no-parallel` を足す。

変更前:
```bash
  output=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" bash "$LAUNCH" \
    --cwd "$TMP/repo" --mode execute --runner "$runner" --plan-file "$TMP/plan.md" \
    --status-dir "$TMP/status" --review-config "$config" "$name")
```

変更後:
```bash
  # --no-parallel で起動プロンプト側のディレクティブを止め、レビュー依頼文への
  # 注入だけを切り分けて検査する
  output=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" bash "$LAUNCH" \
    --cwd "$TMP/repo" --mode execute --runner "$runner" --plan-file "$TMP/plan.md" \
    --status-dir "$TMP/status" --review-config "$config" --no-parallel "$name")
```

これにより「`--no-parallel` を渡してもレビュー依頼文へは入る」という挙動になってしまうため、**実装側では `NO_PARALLEL` をレビュー依頼文の注入判定に使わない**。`--no-parallel` は起動プロンプト専用のスイッチとし、レビュー依頼文への注入は `reviewer_engine` の有無だけで決める。この切り分けは Step 4 の実装コメントにも書く。

- [ ] **Step 3: テストを実行して失敗を確認する**

Run: `bash apps/cmux-team-dispatch-task/test/test-launch-workspace-review-config.sh`
Expected: `FAIL: PR1 reviewer_engine=codex でディレクティブが入る (missing: PARALLEL EXECUTION, mandatory)` が出て非ゼロ終了

- [ ] **Step 4: `reviewer_engine` を読んで依頼文へ埋め込む**

`launch-workspace.sh` の `REVIEW_CONFIG` パースブロックを編集する。`REVIEWER_WORKSPACE=$(jq ...)` の直後に次を追加する。

```bash
    # レビュアーの engine。レビュアーは常に設計 engine の逆だが、その情報は親セッション
    # にしかないので review-config 経由で受け取る。欠落 (旧スキーマ) なら注入しない。
    REVIEWER_ENGINE=$(jq -r '.reviewer_engine // empty' "$REVIEW_CONFIG" 2>/dev/null) \
      || die "failed to parse review config at $REVIEW_CONFIG"
```

続いて `READ_SCREEN_CMD="$CMUX read-screen $TARGET_FLAGS"` の直後に次を追加する。

```bash
    # レビュアーに観点別の並列レビューをさせる指示。--no-parallel は起動プロンプト専用の
    # スイッチなのでここでは見ない。注入するかどうかは reviewer_engine の有無だけで決める。
    REVIEWER_PARALLEL=""
    case "$REVIEWER_ENGINE" in
      claude|codex)
        REVIEWER_PARALLEL=" $(bash "$SCRIPT_DIR/parallel-directive.sh" \
          --engine "$REVIEWER_ENGINE" --mode review --agents "$MAX_AGENTS")" ;;
      "") ;;
      *) log "warn" "review config has unknown reviewer_engine=$REVIEWER_ENGINE; skipping parallel directive" ;;
    esac
```

最後に `REVIEW_INSTRUCTION` の文字列の中、`From round 2 include your rebuttals to the findings you rejected, with reasons.` の直後（` (2) wait by polling` の直前）に `${REVIEWER_PARALLEL}` を挿入する。

変更前の該当部分:
```
From round 2 include your rebuttals to the findings you rejected, with reasons. (2) wait by polling
```

変更後:
```
From round 2 include your rebuttals to the findings you rejected, with reasons.${REVIEWER_PARALLEL} (2) wait by polling
```

- [ ] **Step 5: テストを実行して PR1〜PR3 が通ることを確認する**

Run: `bash apps/cmux-team-dispatch-task/test/test-launch-workspace-review-config.sh`
Expected: 既存の T1〜T6 も含めてすべて PASS し `--- all tests passed ---`

- [ ] **Step 6: 他のテストが壊れていないことを確認する**

Run:
```bash
bash apps/cmux-team-dispatch-task/test/test-parallel-directive.sh
bash apps/cmux-team-dispatch-task/test/test-launch-workspace-codex.sh
bash apps/cmux-team-dispatch-task/test/test-launch-workspace-permissions.sh
bash apps/cmux-team-dispatch-task/test/test-launch-workspace-layout.sh
```
Expected: 4 本とも PASS

- [ ] **Step 7: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh \
        apps/cmux-team-dispatch-task/test/test-launch-workspace-review-config.sh
git commit -m "feat(cmux-team-dispatch-task): reviewer_engine を受け取りレビュー依頼へ並列指示を注入する"
```

---

### Task 4: 親セッションが送る指示への注入とドキュメント同期

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md`
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md`
- Modify: `apps/cmux-team-dispatch-task/README.md`
- Modify: `apps/cmux-team-dispatch-task/CLAUDE.md`
- Modify: `apps/cmux-team-dispatch-task/.claude-plugin/plugin.json`
- Modify: `apps/cmux-team-dispatch-task/.codex-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`

**Interfaces:**
- Consumes: Task 1 の `parallel-directive.sh`、Task 3 が定義した `review/code-review.json` の `reviewer_engine` キー
- Produces: なし（最終タスク）

- [ ] **Step 1: SKILL.md の Phase B standby 実行指示にディレクティブを足す（英語）**

`SKILL.md` の sonnet standby 向け `REQUEST_TEXT` を組み立てている箇所（`REQUEST_TEXT="Read and execute the plan at <PLAN_FILE_PATH>. After all work is` で始まるブロック）を次に差し替える。standby は実行系なので `--mode execute` を渡す点に注意。

```
             PARALLEL=$(bash <SKILL_DIR>/scripts/parallel-directive.sh --engine claude --mode execute)
             REQUEST_TEXT="Read and execute the plan at <PLAN_FILE_PATH>. $PARALLEL After all work is
             committed/pushed and the PR is created (or all changes are merged per
             the plan), run /exit to close this session. Do not leave it idle."
             # standby is an execution pane, so pass --mode execute (the script has no
             # standby mode). The exit instruction MUST stay last.
             # IF the PHASE B-R block exists below, do NOT use this REQUEST_TEXT —
             # use the extended REQUEST_TEXT defined in that block instead (it inserts
             # the pre-PR code-review protocol).
```

- [ ] **Step 2: SKILL.md の CODEX_BEHAVIOR_BLOCK 側にも同じ処理を足す（英語）**

`{{CODEX_BEHAVIOR_BLOCK}}` の定義（`- \`{{CODEX_BEHAVIOR_BLOCK}}\` →` から始まり、`cmux send --surface "$CODEX_SURFACE" "$REQUEST_TEXT"` を含むブロック）の中で、`REQUEST_TEXT` を組み立てている行の直前に次を挿入する。

```
                   PARALLEL=$(bash <SKILL_DIR>/scripts/parallel-directive.sh --engine codex --mode execute)
```

そのうえで、そのブロックの `REQUEST_TEXT` に `$PARALLEL` を挿入する。**結果は Step 1 と同じ形にする** — すなわち次の 3 点を満たすこと。

1. 先頭は元々の作業指示（plan を読んで実装せよ、の文）のまま
2. その直後に ` $PARALLEL ` を置く
3. セッション終了の指示（codex 版なので `end this codex session ...` の系統。`/exit` ではない）を**必ず末尾に残す**

このブロックの `REQUEST_TEXT` は `grep -n 'CODEX_SURFACE' SKILL.md` で見つかる `cmux send --surface "$CODEX_SURFACE" "$REQUEST_TEXT"` の少し上で組み立てられている。編集前に該当ブロック全体を読み、元の文言を保ったまま `$PARALLEL` の 1 箇所だけを足すこと。**codex の終了指示を消したり `/exit` に書き換えたりしてはならない** — 過去にここで codex が TUI に idle 残留し、親へ通知が一切届かない事故が起きている（`CLAUDE.md` のメンテナンス手順 21 を参照）。

なお `{{CODE_REVIEW_BLOCK}}` が存在するときは拡張版 `REQUEST_TEXT` が base を上書きする。**拡張版にも同じ 3 点を満たす形で `$PARALLEL` を入れること。** 片方だけ直すと Phase B-R を有効にした瞬間に指示が失われる。

- [ ] **Step 3: SKILL.md の Phase A-R レビュー依頼にディレクティブを足す（英語）**

Round loop の「Always append the protocol:」ブロックの直後に、次のステップを追加する。

```
      1b. Append the parallel-review directive for the review pane engine. The
          reviewer is always the opposite engine of the design session, so pass
          the reviewer pane engine here (codex when the design session is claude,
          claude when the design session is codex):
            PARALLEL=$(bash <SKILL_DIR>/scripts/parallel-directive.sh --engine <reviewer-engine> --mode review)
            <request text>="<request text> $PARALLEL"
```

- [ ] **Step 4: SKILL.md の CODE_REVIEW_BLOCK に reviewer_engine を書かせる（英語）**

`{{CODE_REVIEW_BLOCK}}` の定義の中で `review/code-review.json` を `jq -n` で生成している箇所を、`reviewer_engine` を含む形に差し替える。

変更前:
```bash
          jq -n --arg s "$CMUX_SURFACE_ID" --arg w "$CMUX_WORKSPACE_ID" \
            --arg d "<EXISTING_STATUS_DIR>/review" \
            '{reviewer_surface: $s, reviewer_workspace: $w, review_dir: $d}' \
            > "<EXISTING_STATUS_DIR>/review/code-review.json"
```

変更後:
```bash
          # reviewer_engine lets launch-workspace.sh pick the right parallel-review
          # wording for the reviewer. It is this session engine, since this session
          # turns into the reviewer.
          jq -n --arg s "$CMUX_SURFACE_ID" --arg w "$CMUX_WORKSPACE_ID" \
            --arg d "<EXISTING_STATUS_DIR>/review" --arg e "<this-session-engine>" \
            '{reviewer_surface: $s, reviewer_workspace: $w, review_dir: $d, reviewer_engine: $e}' \
            > "<EXISTING_STATUS_DIR>/review/code-review.json"
```

同じ `jq -n` が SKILL.md 内の別の Phase B 分岐（sonnet 経路 / codex 経路）にも現れる場合は、**すべて**同じ形に差し替えること。`grep -n 'reviewer_surface: \$s' SKILL.md` で漏れがないか確認する。

- [ ] **Step 5: SKILL.md に「Parallel execution inside a task」節を追加する（英語）**

`MANDATORY MODEL SELECTION SEQUENCE` のテンプレート説明が終わった位置に、次の節を追加する。見出しは `guide-ja.md` と 1:1 対応させる。

```markdown
## Parallel execution inside a task

Tasks already run in parallel across worktrees. This section is about the work
*inside* one task: every child session is told to fan independent investigation
and verification out across child agents instead of doing them one at a time.

`scripts/parallel-directive.sh` is the single source of that wording:

```
parallel-directive.sh --engine <claude|codex> --mode <plan|superpowers|execute|review> [--agents <N>]
```

- codex sessions are told to use `spawn_agent` / `wait_agent`; claude sessions are
  told to launch several Task subagents in one message.
- File edits always stay sequential in the parent agent, and the directive never
  overrides a skill that sequences implementation (superpowers
  subagent-driven-development keeps its one-implementer-at-a-time rule).
- `--agents` caps concurrency. Integers 2-8 only; the default is 4.
- There is no `standby` mode — a standby pane is an execution pane, so pass
  `--mode execute` for it.

Where the directive is injected:

| Target | Injected by |
|--------|-------------|
| plan / superpowers / execute launch prompt | `launch-workspace.sh` (suppress with `--no-parallel`) |
| Phase B execution request sent to a standby pane | this skill, via the script |
| Phase A-R review request | this skill, via the script |
| Phase B-R review request (prewarm path) | this skill, via the script |
| Phase B-R review request (spawn path) | `launch-workspace.sh`, from `reviewer_engine` in `review/code-review.json` |
```

- [ ] **Step 6: guide-ja.md に対応節を追加する（日本語）**

`SKILL.md` に足した `## Parallel execution inside a task` に 1:1 対応する `## タスク内の並列実行` を、`guide-ja.md` の同じ位置に追加する。

```markdown
## タスク内の並列実行

タスク同士は既に worktree 横断で並列に走っている。この節が扱うのは **1 タスクの中**の話で、
各子セッションに「独立した調査と検証は 1 件ずつ順にやらず、子エージェントへ分散させよ」と
指示する。

`scripts/parallel-directive.sh` がその文面の単一情報源である。

```
parallel-directive.sh --engine <claude|codex> --mode <plan|superpowers|execute|review> [--agents <N>]
```

- codex セッションには `spawn_agent` / `wait_agent` を、claude セッションには
  1 メッセージで複数の Task サブエージェントを起動することを指示する
- ファイル編集は常に親エージェントで逐次に保つ。実装の順序を制御するスキル
  （superpowers subagent-driven-development の「実装者は同時に 1 体」）は上書きしない
- `--agents` が同時実行の上限。2〜8 の整数のみで既定は 4
- `standby` モードは存在しない。standby ペインは実行系なので `--mode execute` を渡す

注入箇所:

| 対象 | 注入する側 |
|------|-----------|
| plan / superpowers / execute の起動プロンプト | `launch-workspace.sh`（`--no-parallel` で抑止） |
| standby ペインへ送る Phase B 実行指示 | このスキル（スクリプト経由） |
| Phase A-R のレビュー依頼 | このスキル（スクリプト経由） |
| Phase B-R のレビュー依頼（prewarm 経路） | このスキル（スクリプト経由） |
| Phase B-R のレビュー依頼（spawn 経路） | `launch-workspace.sh`（`review/code-review.json` の `reviewer_engine` から） |
```

- [ ] **Step 7: README.md に利用者向けの説明を足す（日本語）**

`apps/cmux-team-dispatch-task/README.md` に次の節を追加する。既存の見出しレベルと文体に合わせること。

```markdown
## タスク内の並列実行

各子セッションは、独立した調査と検証を子エージェントへ分散させるよう指示される
（codex は `spawn_agent`、claude は Task サブエージェント）。ファイル編集は
親エージェントで逐次のままなので、同一 worktree での書き込み競合は起きない。

同時に走る子エージェントの上限は既定 4 で、`launch-workspace.sh` の `--agents <N>`
（2〜8）で変えられる。`--no-parallel` を渡すと起動プロンプトへの指示を止められる。

タスク自体も worktree 横断で並列に走るため、**トークン消費は「タスク数 × 子エージェント数」
で効いてくる**。小さな変更を大量にディスパッチするときは `--agents 2` か `--no-parallel`
を検討すること。
```

- [ ] **Step 8: CLAUDE.md にファイル構成・保守項目・テスト項目を足す（日本語）**

`apps/cmux-team-dispatch-task/CLAUDE.md` の「ファイル構成」表に 1 行追加する。

```markdown
| `skills/cmux-team-dispatch-task/scripts/parallel-directive.sh` | 子セッションへ渡す並列実行ディレクティブの生成（文面の単一情報源） |
```

「メンテナンス手順」の末尾に項目を追加する。番号は既存の最後の項目の次にする。

```markdown
27. **タスク内の並列実行**が SKILL.md / guide-ja.md / README.md / CLAUDE.md の 4 ファイルで一致しているか確認:
    - 文面の単一情報源は `scripts/parallel-directive.sh`。`--engine <claude|codex>` × `--mode <plan|superpowers|execute|review>` で 1 行を出力し、`--agents <N>`（2〜8、既定 4）で同時実行の上限を変える。`standby` モードは存在せず、standby ペインには `--mode execute` を渡す
    - **出力に `'` `"` `` ` `` `$` `!` `\` を 1 文字も含めてはならない**。composed command は `zsh -ic "... '<prompt>' ..."` で二重に引用され、`launch-workspace.sh` はエスケープしない（`-i` は対話モードなので history 展開が効き `!` も特殊文字になる）。回帰は `bash test/test-parallel-directive.sh` の PD4 で検証する
    - superpowers への譲歩文（subagent-driven-development の「実装者は同時に 1 体」を上書きしない旨）は engine / mode で出し分けず常に出力する。codex も `superpowers:brainstorming` 前置でパイプラインを辿るため
    - `launch-workspace.sh` が注入するのは plan / superpowers / execute の起動プロンプトだけ。standby / review はプロンプト無しで起動するので、指示は親が `cmux send` で送るテキストに含める。execute では `EXIT_INSTRUCTION` を必ず最後に残すこと
    - Phase B-R の spawn 経路は `review/code-review.json` の `reviewer_engine`（`claude` / `codex`）から依頼文へ埋め込む。欠落時（旧スキーマ）は注入しない。`--no-parallel` は起動プロンプト専用のスイッチで、レビュー依頼文の注入判定には使わない
    - 回帰は `bash test/test-parallel-directive.sh`（PD1-PD7）、`bash test/test-launch-workspace-codex.sh`（PL1-PL6）、`bash test/test-launch-workspace-review-config.sh`（PR1-PR3）で検証する
```

「テスト方法」の E2E テスト一覧の末尾に項目を追加する。

```markdown
41. **タスク内の並列実行**: plan / superpowers / execute で起動した子セッションのプロンプトに `PARALLEL EXECUTION, mandatory` が含まれること。codex には `spawn_agent`、claude には Task サブエージェントの指示が届くこと。standby / review の起動コマンドには含まれず、親が送る実行指示・レビュー依頼側に含まれること。`--no-parallel` で起動プロンプトから消えること
```

- [ ] **Step 9: バージョンを同期する**

`apps/cmux-team-dispatch-task/.claude-plugin/plugin.json` の `"version"` を `1.13.0` → `1.14.0`。
`apps/cmux-team-dispatch-task/.codex-plugin/plugin.json` の `"version"` を `1.13.0` → `1.14.0`。
ルート `.claude-plugin/marketplace.json` の `cmux-team-dispatch-task` を `1.14.0` に更新。

確認:

```bash
node -e "
const fs=require('fs');
const a=JSON.parse(fs.readFileSync('apps/cmux-team-dispatch-task/.claude-plugin/plugin.json','utf8')).version;
const b=JSON.parse(fs.readFileSync('apps/cmux-team-dispatch-task/.codex-plugin/plugin.json','utf8')).version;
const m=JSON.parse(fs.readFileSync('.claude-plugin/marketplace.json','utf8')).plugins.find(p=>p.name==='cmux-team-dispatch-task').version;
console.log(a,b,m);
"
```

Expected: `1.14.0 1.14.0 1.14.0`

- [ ] **Step 10: ドキュメント言語規約と全体チェックを走らせる**

Run:
```bash
node scripts/check-doc-lang.mjs apps/cmux-team-dispatch-task
pnpm check
```
Expected: いずれも違反なしで終了コード 0。`japanese-in-english-doc` が出たら、日本語を書いてよいのは `references/*-ja.md` / `CLAUDE.md` / `README.md` だけであることを思い出して該当箇所を英語に直す

- [ ] **Step 11: 全テストを再実行する**

Run:
```bash
bash apps/cmux-team-dispatch-task/test/test-parallel-directive.sh
bash apps/cmux-team-dispatch-task/test/test-launch-workspace-codex.sh
bash apps/cmux-team-dispatch-task/test/test-launch-workspace-review-config.sh
bash apps/cmux-team-dispatch-task/test/test-launch-workspace-permissions.sh
bash apps/cmux-team-dispatch-task/test/test-launch-workspace-layout.sh
```
Expected: 5 本ともグリーン

- [ ] **Step 12: コミット**

```bash
git add apps/cmux-team-dispatch-task .claude-plugin/marketplace.json
git commit -m "docs(cmux-team-dispatch-task): タスク内の並列実行を文書化しバージョンを同期する"
```

---

## 完了条件

次のすべてがグリーンであること。

```bash
bash apps/cmux-team-dispatch-task/test/test-parallel-directive.sh
bash apps/cmux-team-dispatch-task/test/test-launch-workspace-codex.sh
bash apps/cmux-team-dispatch-task/test/test-launch-workspace-review-config.sh
bash apps/cmux-team-dispatch-task/test/test-launch-workspace-permissions.sh
bash apps/cmux-team-dispatch-task/test/test-launch-workspace-layout.sh
node scripts/check-doc-lang.mjs apps/cmux-team-dispatch-task
pnpm check
```

加えて、`cmux-team-dispatch-task` のバージョンが 3 ファイルとも `1.14.0` で一致していること。
