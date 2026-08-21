# agmsg monitor 専用化 (cmux-team-dispatch-task) 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** dispatch の配送とすべての待機を agmsg monitor の push 1 本に統一し、タイプ入力
配送 (`send-prompt.sh`) とポーリング待機 (`monitor-dispatch.sh` / verdict ファイル /
`batch-wait.sh`) を全廃する。

**Architecture:** 全ペインは起動プロンプトの先頭で readiness を確立 (claude は Monitor
ツール起動、codex は seat 記録) し、`[ready] <name>` を親へ送ってから idle 待機する。以後の
配送は `send.sh` の 1 呼び出しのみ。親は待機ループを持たず、ターンを閉じて Monitor イベント
で起き、起きるたびに `.dispatch/*/status.json` から状態を再導出する。無反応の子を検出する
ためだけに単発 `sleep` タスク 1 本を保険として張る。

**Tech Stack:** bash / zsh / markdown (Claude Code plugin)。テストは repo 慣習どおり
`test/test-*.sh` の bash スクリプトで、不変条件に ID を振り PASS/FAIL を出力する。

**Spec:** `docs/superpowers/specs/2026-08-21-agmsg-monitor-only-design.md`

## Global Constraints

- 実測済みの前提 (spec の実測結果表):
  - **B1**: Monitor イベントは idle な claude セッションを起こす。
  - **B2**: ペインは初回ターンを 1 回持たないと受信できない。
  - **V2a/V2b**: codex は **seat 記録が無いと受信できない**。記録後は受信する。
  - **B5**: `ready.<team>__<agent>` sentinel は agmsg 1.2.1 に**存在しない**。readiness は
    claude が `run/watch.<session_id>.pid`、codex が
    `run/codex-bridge.<team>.<agent>.thread`。前者は session id キーなので**親から観測
    できない** → claude 子の readiness は `[ready]` 自己申告のみ。
- **fallback は作らない**。readiness が確立できない場合は fail-fast で理由を報告する。
  `AGMSG_INSTALLED` による true/false 二系統分岐は廃止し、agmsg は必須前提とする。
- `delivery.sh status` の出力は readiness 判定に使わない (V2b の時点で `not running` と
  報告しながら配信は成功していたため、fail-closed 条件にすると動作中のペインを誤判定する)。
- `apps/*/skills/*/SKILL.md` と `apps/*/commands/*.md` は **英語必須**。日本語文字を
  1 文字も書かない。`SKILL.md` を更新したら同じ commit で
  `skills/*/references/guide-ja.md` も更新する。
- `CLAUDE.md` / `README.md` / `docs/**` は日本語。
- 検証: `pnpm check:doc-lang` が通ること。
- `launch-workspace.sh` の runner wrapper はエスケープ済みヒアドキュメントで生成される
  (`\$VAR` は wrapper 実行時に展開、`$VAR` は生成時に展開)。**この使い分けを崩さない**。
- バージョンは 3 箇所同期: `apps/cmux-team-dispatch-task/.claude-plugin/plugin.json`、
  同 `.codex-plugin/plugin.json`、ルート `.claude-plugin/marketplace.json`。

---

### Task 1: `verify-agmsg-ready.sh` を新設する

**Files:**
- Create: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/verify-agmsg-ready.sh`
- Create: `apps/cmux-team-dispatch-task/test/test-verify-agmsg-ready.sh`

**Interfaces:**
- Consumes: なし (新規)。
- Produces: `verify-agmsg-ready.sh --self [--session-id <id>]` と
  `verify-agmsg-ready.sh --codex --team <team> --name <agent>`。stdout は
  `ready=yes|no reason=<slug>` の 1 行。exit 0 = ready / 1 = not ready / 2 = usage error。
  Task 2 (prewarm) と Task 4 (SKILL.md Step 1g / Step 3) がこれを呼ぶ。

- [ ] **Step 1: 失敗するテストを書く**

`apps/cmux-team-dispatch-task/test/test-verify-agmsg-ready.sh`:

```bash
#!/usr/bin/env bash
# verify-agmsg-ready.sh の回帰テスト。
#
# 実行: bash apps/cmux-team-dispatch-task/test/test-verify-agmsg-ready.sh
#
# 守っている不変条件:
#   VR1. --self: 生きている watch pid があれば ready=yes / exit 0
#   VR2. --self: pidfile はあるが pid が死んでいれば ready=no / exit 1
#        (プロセス生存まで見るのは、SIGKILL された watcher が pidfile を残すため)
#   VR3. --self: pidfile が無ければ ready=no / exit 1
#   VR4. --self: composite id (watch.<session>.<pid>.pid) でも一致する
#        (Monitor 起動時の session id は <uuid>.<pid> 形式で渡されることがある)
#   VR5. --codex: codex-bridge.<team>.<agent>.thread が非空なら ready=yes / exit 0
#   VR6. --codex: thread ファイルが無い / 空なら ready=no / exit 1
#        (V2a の未読滞留を検出する条件そのもの)
#   VR7. 引数不足・未知フラグは exit 2 (fail-fast。ready=yes を返さない)
#   VR8. delivery.sh を一切呼ばない (V2b で not running と誤報告した経路を使わない)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/verify-agmsg-ready.sh"
[[ -f "$BIN" ]] || { echo "FAIL: スクリプトが見つからない: $BIN"; exit 2; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export AGMSG_RUN_DIR="$TMP/run"
mkdir -p "$AGMSG_RUN_DIR"
fail=0

# --- VR1: 生きている pid ---
echo $$ > "$AGMSG_RUN_DIR/watch.sess-alive.pid"
out=$(bash "$BIN" --self --session-id sess-alive 2>&1); rc=$?
if [[ $rc -eq 0 ]] && printf '%s' "$out" | grep -q "ready=yes"; then
  echo "PASS VR1: 生きている watch pid で ready=yes"
else
  echo "FAIL VR1: rc=$rc out=[$out]"; fail=1
fi

# --- VR2: 死んでいる pid ---
# 存在し得ない pid を使う (99999 は既存の可能性があるため kill -0 で不在を確認)
dead=99999
while kill -0 "$dead" 2>/dev/null; do dead=$((dead + 1)); done
echo "$dead" > "$AGMSG_RUN_DIR/watch.sess-dead.pid"
out=$(bash "$BIN" --self --session-id sess-dead 2>&1); rc=$?
if [[ $rc -eq 1 ]] && printf '%s' "$out" | grep -q "ready=no"; then
  echo "PASS VR2: 死んだ pid で ready=no / exit 1"
else
  echo "FAIL VR2: rc=$rc out=[$out]"; fail=1
fi

# --- VR3: pidfile 無し ---
out=$(bash "$BIN" --self --session-id sess-missing 2>&1); rc=$?
if [[ $rc -eq 1 ]] && printf '%s' "$out" | grep -q "ready=no"; then
  echo "PASS VR3: pidfile 無しで ready=no / exit 1"
else
  echo "FAIL VR3: rc=$rc out=[$out]"; fail=1
fi

# --- VR4: composite id ---
echo $$ > "$AGMSG_RUN_DIR/watch.sess-comp.4242.pid"
out=$(bash "$BIN" --self --session-id sess-comp 2>&1); rc=$?
if [[ $rc -eq 0 ]] && printf '%s' "$out" | grep -q "ready=yes"; then
  echo "PASS VR4: composite id でも一致する"
else
  echo "FAIL VR4: rc=$rc out=[$out]"; fail=1
fi

# --- VR5: codex seat あり ---
echo "01a022a6-d7a8-7da2-80f5-6d2cfb32aed1" > "$AGMSG_RUN_DIR/codex-bridge.t1.agent1.thread"
out=$(bash "$BIN" --codex --team t1 --name agent1 2>&1); rc=$?
if [[ $rc -eq 0 ]] && printf '%s' "$out" | grep -q "ready=yes"; then
  echo "PASS VR5: seat 記録済みで ready=yes"
else
  echo "FAIL VR5: rc=$rc out=[$out]"; fail=1
fi

# --- VR6: codex seat 無し / 空 ---
: > "$AGMSG_RUN_DIR/codex-bridge.t1.empty.thread"
for name in noseat empty; do
  out=$(bash "$BIN" --codex --team t1 --name "$name" 2>&1); rc=$?
  if [[ $rc -eq 1 ]] && printf '%s' "$out" | grep -q "ready=no"; then
    echo "PASS VR6($name): seat 無し/空で ready=no / exit 1"
  else
    echo "FAIL VR6($name): rc=$rc out=[$out]"; fail=1
  fi
done

# --- VR7: 使用法エラー ---
for args in "" "--codex --team t1" "--self --bogus x"; do
  out=$(bash "$BIN" $args 2>&1); rc=$?
  if [[ $rc -eq 2 ]] && ! printf '%s' "$out" | grep -q "ready=yes"; then
    echo "PASS VR7([$args]): exit 2 で ready=yes を返さない"
  else
    echo "FAIL VR7([$args]): rc=$rc out=[$out]"; fail=1
  fi
done

# --- VR8: delivery.sh を呼ばない ---
if ! grep -q "delivery.sh" "$BIN"; then
  echo "PASS VR8: delivery.sh に依存しない"
else
  echo "FAIL VR8: delivery.sh を参照している"; fail=1
fi

if [[ $fail -eq 0 ]]; then echo "--- all passed ---"; else echo "--- failures ---"; fi
exit $fail
```

- [ ] **Step 2: テストを実行して落ちることを確認**

Run: `bash apps/cmux-team-dispatch-task/test/test-verify-agmsg-ready.sh`
Expected: `FAIL: スクリプトが見つからない`、exit 2

- [ ] **Step 3: スクリプトを実装する**

`apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/verify-agmsg-ready.sh`:

```bash
#!/usr/bin/env bash
# verify-agmsg-ready.sh — agmsg readiness を確認する。watcher は起動しない。
#
# 判定は agmsg 1.2.1 の実測 (spec 2026-08-21 の B5) に従う:
#   --self                        自セッション: run/watch.<session-id>*.pid が生きているか
#   --codex --team <t> --name <a>  codex ペイン: run/codex-bridge.<t>.<a>.thread が非空か
#
# claude ペインの readiness は親から観測できない (シグナルが session id キーで、親は子の
# session id を知らない)。その経路はここでは扱わず、子からの `[ready] <name>` 自己申告を
# 待つ。--codex だけが「他ペインを観測できる」経路である。
#
# `delivery.sh status` は使わない。実測 (V2b) で bridge プロセスが実在し配信も成功して
# いる状況で `not running` と報告したため、判定条件にすると動作中のペインを誤って
# 不通と断定する。
#
# Usage:
#   verify-agmsg-ready.sh --self [--session-id <id>]
#   verify-agmsg-ready.sh --codex --team <team> --name <agent>
#
# Output: ready=yes|no reason=<slug>
# Exit:   0 = ready / 1 = not ready / 2 = usage error

set -uo pipefail

AGMSG_RUN_DIR="${AGMSG_RUN_DIR:-$HOME/.agents/skills/agmsg/run}"

die() { echo "ready=no reason=usage detail=$1" >&2; exit 2; }

MODE=""; TEAM=""; NAME=""; SESSION_ID="${CLAUDE_CODE_SESSION_ID:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --self)       MODE="self";  shift ;;
    --codex)      MODE="codex"; shift ;;
    --team)       [[ $# -ge 2 ]] || die "--team requires a value"; TEAM="$2"; shift 2 ;;
    --name)       [[ $# -ge 2 ]] || die "--name requires a value"; NAME="$2"; shift 2 ;;
    --session-id) [[ $# -ge 2 ]] || die "--session-id requires a value"; SESSION_ID="$2"; shift 2 ;;
    *)            die "unknown argument: $1" ;;
  esac
done

case "$MODE" in
  self)
    [[ -n "$SESSION_ID" ]] || die "--session-id is required when CLAUDE_CODE_SESSION_ID is unset"
    # watch.sh の pidfile は <session-id> そのままか、composite の <session-id>.<pid> で
    # 命名される。両方を候補にする。
    shopt -s nullglob
    for f in "$AGMSG_RUN_DIR/watch.$SESSION_ID.pid" "$AGMSG_RUN_DIR/watch.$SESSION_ID."*.pid; do
      [[ -f "$f" ]] || continue
      pid=$(cat "$f" 2>/dev/null || echo "")
      # pidfile の存在だけでは足りない。SIGKILL された watcher は EXIT trap を飛ばして
      # pidfile を残すので、プロセスの生存まで確認する。
      if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
        echo "ready=yes reason=watch-pid-alive pid=$pid"
        exit 0
      fi
    done
    echo "ready=no reason=no-live-watcher session=$SESSION_ID"
    exit 1
    ;;
  codex)
    [[ -n "$TEAM" && -n "$NAME" ]] || die "--codex requires both --team and --name"
    thread_file="$AGMSG_RUN_DIR/codex-bridge.$TEAM.$NAME.thread"
    if [[ -s "$thread_file" ]]; then
      echo "ready=yes reason=seat-recorded"
      exit 0
    fi
    echo "ready=no reason=no-seat team=$TEAM name=$NAME"
    exit 1
    ;;
  *)
    die "one of --self or --codex is required"
    ;;
esac
```

- [ ] **Step 4: テストを実行して通ることを確認**

Run: `bash apps/cmux-team-dispatch-task/test/test-verify-agmsg-ready.sh`
Expected: VR1-VR8 すべて PASS、`--- all passed ---`、exit 0

- [ ] **Step 5: commit**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/verify-agmsg-ready.sh \
        apps/cmux-team-dispatch-task/test/test-verify-agmsg-ready.sh
git commit -m "feat(dispatch): agmsg readiness を確認する verify-agmsg-ready.sh を追加

watcher は起動せず確認だけ行う。判定は実測に従い、自セッションは
run/watch.<session-id>*.pid の生存、codex ペインは
run/codex-bridge.<team>.<agent>.thread の非空で見る。delivery.sh status は
動作中のペインを not running と誤報告するため使わない。"
```

---

### Task 2: prewarm のプロンプトを readiness 確立型に変える

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh:474-499`
  (`GUARD_INJECTABLE` / `guard_clause` / `OPUS_PROMPT`)
- Modify: 同 `:566-576` (`CLAUDE_EXEC_PROMPT`)
- Modify: 同 `:616-621` (`CODEX_EXEC_PROMPT`)
- Modify: 同 `:687-690` (`REVIEW_PROMPT`)
- Modify: 同 `prewarm.json` 生成部 (`delivery` / `watcher` キー)
- Delete: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/ensure-agmsg-ready.sh`
- Delete: `apps/cmux-team-dispatch-task/test/test-agmsg-ready.sh`
- Delete: `apps/cmux-team-dispatch-task/test/test-agmsg-skill-block.sh`
- Modify: `apps/cmux-team-dispatch-task/test/test-prewarm-layout.sh` (PW1-PW10 の
  `watcher` / `delivery` 期待値)
- Modify: `apps/cmux-team-dispatch-task/test/test-prewarm-all-codex.sh`,
  `test-prewarm-design-permissions.sh`, `test-prewarm-unattended.sh` (同キーを見る箇所)

**Interfaces:**
- Consumes: Task 1 の `verify-agmsg-ready.sh` (codex ペインの seat 確認に使う)。
- Produces: `prewarm.json` の各ロールオブジェクトが `delivery` / `watcher` の代わりに
  `"wired": true|false` を持つ。Task 4 の SKILL.md がこのキーを読む。
  各ペインの起動プロンプト先頭に readiness 確立句が入る。

- [ ] **Step 1: `guard_clause` を `readiness_clause` に置き換える**

`prewarm-panes.sh:474-483` の `GUARD_INJECTABLE` / `guard_clause` を次で置き換える。
シェルメタ文字ガードは維持するが、**fallback が無くなったので die にする**:

```bash
READINESS_INJECTABLE=1
case "$SCRIPT_DIR" in
  *[[:space:]]*|*[\'\"\`\$\!\\]*) READINESS_INJECTABLE=0 ;;
esac
[[ $READINESS_INJECTABLE -eq 0 ]] \
  && die "SCRIPT_DIR contains whitespace or shell metacharacters; the readiness clause cannot be composed safely and there is no typed fallback: $SCRIPT_DIR"

# readiness 確立句。エンジンごとに手段が違う (spec 2026-08-21 の B2 / V2a):
#   claude → Monitor ツールを起動する。これが無いと idle 中の受信ができない
#   codex  → seat を記録する。これが無いとメッセージは inbox に未読で滞留する
# どちらも最後に親へ [ready] を送る。親はこれを readiness の唯一の確認手段にする
# (claude 子の readiness は親から観測できないため。B5 / 制約 3)。
readiness_clause() {
  local wiring_type="$1" name="$2"
  if [[ "$wiring_type" == "codex" ]]; then
    printf 'FIRST run this so agmsg messages can reach you: bash %s/drivers/types/codex/codex-record-session.sh %s %s . THEN run this exact command: bash %s/send.sh %s %s parent "[ready] %s".' \
      "$AGMSG_DIR" "$AGMSG_TEAM" "$name" "$AGMSG_DIR" "$AGMSG_TEAM" "$name" "$name"
  else
    printf 'FIRST follow the AGMSG-DIRECTIVE printed by your SessionStart hook and invoke the Monitor tool right now — that is the only way work will reach you. THEN run this exact command: bash %s/send.sh %s %s parent "[ready] %s".' \
      "$AGMSG_DIR" "$AGMSG_TEAM" "$name" "$name"
  fi
}
```

- [ ] **Step 2: 4 ロールのプロンプト文面を agmsg 配送前提に書き換える**

`delivery` の分岐 (`== "agmsg"` / else) は廃止し、常に readiness 句を使う。
「typed into this pane」「typed directly into this pane」の文言を消す:

```bash
# :497 (design)
OPUS_PROMPT="$(readiness_clause "$DESIGN_WIRING_TYPE" "$SLUG") Then wait idle. Your task will arrive as an agmsg message. Do not start any work until it arrives."

# :574 (claude executor)
CLAUDE_EXEC_PROMPT="$(readiness_clause claude-code "$SLUG-claude") Then wait idle. Execution instructions will arrive as an agmsg message. Do not start any work until they arrive."

# :621 (codex executor)
CODEX_EXEC_PROMPT="$(readiness_clause codex "$SLUG-codex") Then wait idle. Execution instructions will arrive as an agmsg message. Do not start any work until they arrive."

# :690 (review)
REVIEW_PROMPT="$(readiness_clause "$REVIEW_WIRING_TYPE" "$SLUG-review") Then wait idle. Review requests will arrive as an agmsg message. Do not start any work until a request arrives."
```

codex executor / review は従来「配線失敗時はプロンプトを渡さず idle 起動」する分岐が
あった (`${CODEX_EXEC_PROMPT:+...}` / `${REVIEW_PROMPT:+...}`)。監視専用化では
プロンプト無し起動は readiness を確立できず**必ず不通になる**ので、この分岐を消して
常にプロンプトを渡す。

- [ ] **Step 3: `prewarm.json` のキーを差し替える**

`delivery` (`"agmsg"` / `"cmux-send"`) と `watcher` (`"guard-injected"` / `"none"`) の
2 キーは意味を失う。ロールごとに `"wired": true` を出す (join + `delivery.sh set monitor`
+ readiness 句注入がすべて成功したことを表す)。どれかが失敗した時点で `die` するので
`false` は出ない。

**このキーで分岐してはならない。** 既存の「呼び出し元は `prewarm.json` の `delivery` 値で
分岐しない」という規約をそのまま引き継ぐ。ペインが到達可能かの判断根拠は `[ready]` の
到着だけであり、`wired` は「親側の配線が済んだ」ことしか表さない (prewarm 時点では
ペインはまだ初回ターンを持っていないので、readiness は原理的に未確定である)。用途は
`prewarm.json` を読んだ人間・エージェントへの診断情報に限る。

- [ ] **Step 4: `ensure-agmsg-ready.sh` と専用テストを削除**

```bash
git rm apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/ensure-agmsg-ready.sh \
       apps/cmux-team-dispatch-task/test/test-agmsg-ready.sh \
       apps/cmux-team-dispatch-task/test/test-agmsg-skill-block.sh
```

- [ ] **Step 5: prewarm 系テストの期待値を更新**

`grep -rn "watcher\|delivery" apps/cmux-team-dispatch-task/test/test-prewarm-*.sh` で
該当アサーションを洗い出し、`"wired": true` を見る形に直す。あわせて次を追加する:

- PW11: 4 ロールすべての起動プロンプトに readiness 句 (`[ready]` を送る指示) が入る
- PW12: codex ロールの起動プロンプトに `codex-record-session.sh` が入る
- PW13: claude ロールの起動プロンプトに `Monitor` の起動指示が入る
- PW14: `SCRIPT_DIR` にシェルメタ文字があるとき `die` する (fail-fast。旧挙動の
  「プロンプト無しで起動」に落ちないこと)

- [ ] **Step 6: テストを実行**

Run:
```bash
for t in apps/cmux-team-dispatch-task/test/test-prewarm-*.sh; do echo "== $t"; bash "$t"; done
```
Expected: 全 PASS

- [ ] **Step 7: commit**

```bash
git add -A apps/cmux-team-dispatch-task
git commit -m "refactor(dispatch): prewarm のプロンプトを readiness 確立型にする

guard_clause (ensure-agmsg-ready.sh の呼び出し = nohup Bash watcher の起動) を
readiness_clause に置き換えた。claude は Monitor ツール起動、codex は seat 記録を
行い、どちらも親へ [ready] を送ってから idle 待機する。

配線失敗時にプロンプト無しで起動する分岐は、readiness を確立できず必ず不通に
なるため削除し、合成できない場合は die する。"
```

---

### Task 3: 配送を `send.sh` 1 本に統一する

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md:580-624`
  (delivery contract と label 表)
- Modify: 同 SKILL.md の各呼び出し箇所: `:905-909` (子の完了通知)、`:1198` / `:1295`
  (phase-b-exec)、`:1489` (review-plan)、`:1675` / `:1727` / `:1747` (review-code /
  abort-reviewer / dispatch-notify)、`:1834`、`:1880`
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh:1017-1080`
  (`notify_parent` / `notify_parent_once` / `notify_reviewer_once`)
- Modify: 同 `:770` (`REVIEW_INSTRUCTION`)、`:782` (`ABORT_REVIEW_STEP`)、
  `:786` (`ABORT_PARENT_STEP`)、`:749` (`SEND_TARGET_FLAGS`)、`:957` (`SEND_PROMPT`)
- Delete: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/send-prompt.sh`
- Delete: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/agmsg-path.sh`
- Delete: `apps/cmux-team-dispatch-task/test/test-send-prompt.sh`
- Modify: `apps/cmux-team-dispatch-task/test/test-send-prompt-callsites.sh` →
  rename して CS1-CS3 を強化 (下記 Step 4)

**Interfaces:**
- Consumes: Task 2 が保証する「各ペインは agmsg agent 名で到達できる」状態。
- Produces: 配送呼び出しの唯一の形
  `~/.agents/skills/agmsg/scripts/send.sh "$TEAM" <FROM> <TO> '<label>: <body>'`。
  Task 4 / Task 5 / Task 6 はこの形だけを使う。宛先は **surface / workspace id ではなく
  agmsg agent 名**である。

- [ ] **Step 1: SKILL.md の delivery contract を書き換える**

`SKILL.md:580` の `**Delivery contract (applies to EVERY message this skill sends).**`
から `- Exit codes: 0 = delivered, 1 = delivery failed, 2 = usage error.` までを、次で
置き換える:

```markdown
**Delivery contract (applies to EVERY message this skill sends).** All delivery goes
through one call to agmsg `send.sh` — never a `cmux send`: <!-- send-prompt-exempt: prohibition, not a delivery instruction -->

```bash
~/.agents/skills/agmsg/scripts/send.sh "$TEAM" <YOUR_AGENT_NAME> <TARGET_AGENT> '<label>: <message text>'
```

- The destination is an **agmsg agent name**, never a surface or workspace id. A pane
  becomes reachable only after it has reported `[ready] <name>` (Step 1g). Sending to a
  pane that never reported ready leaves the message unread in its inbox forever.
- There is no length limit to work around and no outbox: the inbox is not subject to
  the TUI's paste detection, so pass the full body as-is.
- There is no Enter verification and no re-send. `send.sh` either writes the message to
  agmsg's shared SQLite DB or exits non-zero. **A non-zero exit means the message was
  NOT delivered** — report it, never ignore it.
- `<label>` is a prefix on the message body, not a flag. The Monitor stream delivers one
  message as one line, and the parent identifies the kind of message from this prefix.
```

label 表からは `monitor-dispatch.sh` の行 (`dispatch-monitor`) を削除する。残る 6 つは
そのまま使う。

- [ ] **Step 2: SKILL.md の全呼び出し箇所を置き換える**

`grep -n "send-prompt.sh" SKILL.md` で洗い出し、各所を次の対応で書き換える。宛先が
surface/workspace id から agent 名に変わる点に注意する:

| label | FROM | TO |
|-------|------|-----|
| `phase-a-task` | `parent` | `<task-slug>` |
| `phase-b-exec` | `parent` | `<task-slug>-claude` または `<task-slug>-codex` |
| `review-plan` | `parent` | `<task-slug>-review` |
| `review-code` | `<task-slug>` (実装者) | `<task-slug>-review` |
| `abort-reviewer` | `<task-slug>` または runner wrapper | `<task-slug>-review` |
| `dispatch-notify` | `<task-slug>` | `parent` |

`--outbox-dir` / `--label` / `--to-surface` / `--to-workspace` / `--agmsg-*` の各フラグは
すべて消える。子プロンプトの必須完了通知 (`:905-909`) は次になる:

```
MANDATORY completion notification: immediately after writing done/error to
status.json, notify the parent yourself with ONE send.sh call:
  ~/.agents/skills/agmsg/scripts/send.sh <team> <task-slug> parent 'dispatch-notify: [dispatch] task "<task-slug>" finished (status: <done|error>)'
A non-zero exit means the parent was NOT told — retry once, then write the failure
into status.json's message field so the parent can see it when it re-derives state.
Do NOT rely on session exit: an idle TUI session never exits, and no monitor loop
is running, so without this call the parent is never informed.
```

- [ ] **Step 3: `launch-workspace.sh` の通知関数を書き換える**

`notify_parent` (`:1017`) は宛先解決 (`--to-workspace` / `--to-surface`) と outbox 引数を
すべて失い、`send.sh` の 1 呼び出しになる。wrapper 内で展開されるのは `\$` 側である点を
崩さないこと:

```bash
# 生成される wrapper 側のコード
notify_parent() {
  local status_label="\$1"
  local msg="dispatch-notify: [dispatch] task \\\"\$SLUG\\\" finished (status: \$status_label)"
  [[ -n "\$AGMSG_TEAM" && -n "\$AGMSG_FROM" ]] || return 1
  bash "\$AGMSG_SEND" "\$AGMSG_TEAM" "\$AGMSG_FROM" parent "\$msg"
}
```

`AGMSG_SEND` は生成時に `~/.agents/skills/agmsg/scripts/send.sh` の絶対パスへ解決して
wrapper に焼き込む (`:957` の `SEND_PROMPT` を置き換える)。`notify_parent_once` の
marker 更新ロジックと `notify_reviewer_once` も同じ形にし、宛先は
`\$SLUG-review` の agent 名にする。`SEND_TARGET_FLAGS` (`:749`) は不要になるので削除する。

- [ ] **Step 4: 呼び出し箇所検査を強化した新テストに置き換える**

`test-send-prompt-callsites.sh` を `test-delivery-callsites.sh` にリネームし、不変条件を
更新する:

- **CS1**: `launch-workspace.sh` / `prewarm-panes.sh` / `parallel-directive.sh` /
  `render-loop-prompt.sh` に**配送目的の** `cmux send` / `cmux send-key` が無い。
  コメント行は判定前に除外し、`send-prompt-exempt:` マーカーが直前 3 行以内にある行だけ
  除外する。grep が status 2 以上を返すときも FAIL にして fail-open させない
- **CS2**: `launch-workspace.sh` が `send.sh` を呼ぶ (旧 CS2 の `send-prompt.sh` /
  `monitor-dispatch.sh` の条件を差し替え)
- **CS3**: `SKILL.md` と `references/**/*.md` (訳の `guide-ja.md` と
  `references/unattended/*.md` を含む) に配送目的の `cmux send` が無い
- **CS4 (新規)**: `send-prompt.sh` / `agmsg-path.sh` / `monitor-dispatch.sh` /
  `ensure-agmsg-ready.sh` / `batch-wait.sh` への参照がスクリプト・文書のどこにも残らない

- [ ] **Step 5: 旧ファイルを削除**

```bash
git rm apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/send-prompt.sh \
       apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/agmsg-path.sh \
       apps/cmux-team-dispatch-task/test/test-send-prompt.sh
```

- [ ] **Step 6: テストを実行**

Run:
```bash
bash apps/cmux-team-dispatch-task/test/test-delivery-callsites.sh
bash apps/cmux-team-dispatch-task/test/test-launch-workspace-codex.sh
bash apps/cmux-team-dispatch-task/test/test-launch-workspace-permissions.sh
node scripts/check-doc-lang.mjs
```
Expected: 全 PASS / `check-doc-lang: OK`

CS4 は Task 4-6 が終わるまで `monitor-dispatch.sh` / `batch-wait.sh` の参照が残るため
落ちる。**この時点では CS4 の対象を `send-prompt.sh` と `agmsg-path.sh` の 2 つに限定し、
Task 6 の Step で残り 3 つを追加する。**

- [ ] **Step 7: commit**

```bash
git add -A apps/cmux-team-dispatch-task
git commit -m "refactor(dispatch): 配送を agmsg send.sh の 1 呼び出しに統一

send-prompt.sh と agmsg-path.sh を削除し、全 6 label の配送を send.sh へ移した。
宛先は surface/workspace id ではなく agmsg agent 名になり、outbox 退避・Enter 検証・
再送・ready sentinel 判定がすべて不要になった。

sentinel は agmsg 1.2.1 に存在せず (spec の B5)、inbox 記録の分岐は元から発火して
いなかったため、失うものは無い。"
```

---

### Task 4: `monitor-dispatch.sh` を削除し Step 3 を書き換える

**Files:**
- Delete: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/monitor-dispatch.sh`
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md:562-580`
  (`AGMSG_INSTALLED` の導入部)
- Modify: 同 `:799-860` (Step 1g の agmsg 配線ブロック)
- Modify: 同 `:2322-2424` (Step 3 の監視セクション全体)
- Modify: `apps/cmux-team-dispatch-task/test/test-message-type-removed.sh` (MT1-MT3。
  `AGMSG_INSTALLED` 二系統の検査を廃止し、agmsg 必須前提の検査に置き換え)
- Modify: `apps/cmux-team-dispatch-task/test/test-loop-cleanup.sh`,
  `test-cleanup-close.sh` (`.monitor.pid` / `.monitor.log` を掃除する箇所があれば削除)

**Interfaces:**
- Consumes: Task 1 の `verify-agmsg-ready.sh --self` と `--codex`、Task 3 の `send.sh`
  配送契約、Task 2 が各ペインに注入した readiness 句 (`[ready] <name>` の送信)。
  `prewarm.json` の `wired` キーでは**分岐しない**。
- Produces: Step 3 の新しい待機プロトコル (タイマー保険 + wake ごとの状態再導出)。
  Task 5 / Task 6 がこれに乗る。

- [ ] **Step 1: `AGMSG_INSTALLED` の二系統分岐を廃止する**

`SKILL.md:562-580` を次で置き換える:

```markdown
### 1g. Resolve Delivery, Review Mode and Execution Default

**agmsg is a hard requirement.** Every message and every wake in this skill rides the
agmsg Monitor stream; there is no typed fallback and no polling monitor. If agmsg is
missing, or this session has no live watcher, STOP and tell the user — do not launch a
degraded dispatch:

```bash
[[ -f ~/.agents/skills/agmsg/scripts/send.sh ]] || {
  echo "[error] agmsg is not installed; this skill cannot dispatch without it"; exit 1; }
bash <SKILL_DIR>/scripts/verify-agmsg-ready.sh --self || {
  echo "[error] this session has no live agmsg watcher — the Monitor tool must be running"
  echo "        (SessionStart hook starts it; re-run /clear or start a new session)"; exit 1; }
```

`--message-type` was removed from `launch-workspace.sh` and `prewarm-panes.sh`; passing
it now dies with a `was removed` message.
```

- [ ] **Step 2: Step 1g の配線ブロックを書き換える**

`SKILL.md:799-860` の `**When agmsg is installed (AGMSG_INSTALLED=true), wire the team
BEFORE launching...` から `send-prompt.sh always types the message in as well.` までを
次で置き換える:

```markdown
**Wire the team BEFORE launching (Step 2):**

```bash
TEAM="dispatch-$(basename "$(git rev-parse --show-toplevel)")"
PARENT_ENGINE="claude"
[[ -n "${CODEX_THREAD_ID:-}" ]] && PARENT_ENGINE="codex"
PARENT_AGMSG_TYPE=$(bash <SKILL_DIR>/scripts/resolve-agmsg-type.sh --engine "$PARENT_ENGINE") || exit 1
~/.agents/skills/agmsg/scripts/join.sh "$TEAM" parent "$PARENT_AGMSG_TYPE" "$(pwd)" >/dev/null 2>&1 || true
```

`PARENT_AGMSG_TYPE` must match the current orchestrator runtime. Codex sets
`CODEX_THREAD_ID`, so an all-Codex dispatch resolves to `codex`; Claude Code resolves to
`claude-code`. Do not derive the parent type from a child runner. `join.sh`'s `|| true`
exists because this section runs under `set -e` and re-joining an existing member is not
an error.

The parent's own readiness was already checked at the top of Step 1g
(`verify-agmsg-ready.sh --self`). Unlike the old guard, nothing here starts a watcher:
the Monitor tool the SessionStart hook asked for IS the watcher, and a `/clear` re-fires
that hook, so the watcher comes back on its own.

**Each pane reports its own readiness.** A pane is reachable only after it sends
`[ready] <name>` (the readiness clause `prewarm-panes.sh` injects into every launch
prompt does this). Wait for all expected `[ready]` lines before sending any task:

- A claude pane's readiness **cannot be observed from here** — its signal is keyed by a
  session id this session does not know. The `[ready]` line is the only confirmation.
- A codex pane can additionally be verified with
  `bash <SKILL_DIR>/scripts/verify-agmsg-ready.sh --codex --team "$TEAM" --name <agent>`.
  Use this when a codex pane's `[ready]` never arrives, to tell "seat not recorded"
  (fixable: ask the pane to re-run `codex-record-session.sh`) from "pane died".

When `prewarm: false`, the design pane gets no readiness clause from `prewarm-panes.sh`,
so include it in that child's own prompt instead:

```
FIRST follow the AGMSG-DIRECTIVE printed by your SessionStart hook and invoke the Monitor tool right now. THEN run: ~/.agents/skills/agmsg/scripts/send.sh <team> <task-slug> parent "[ready] <task-slug>"
```

For a codex design pane, replace the Monitor sentence with
`bash ~/.agents/skills/agmsg/scripts/drivers/types/codex/codex-record-session.sh <team> <task-slug>`.
```

- [ ] **Step 3: Step 3 の監視セクションを書き換える**

`SKILL.md:2322` の `## Step 3: Monitor and Complete` から
`### Polling Status Files (Manual Check)` の直前までを次で置き換える:

```markdown
## Step 3: Monitor and Complete

### Push-based Monitoring (the only mode)

There is no monitor script, no heartbeat, and no polling loop. This session keeps a
persistent agmsg Monitor stream, so every child message arrives as one line and wakes
this session even while idle. `.dispatch/*/status.json` is the source of truth; the
messages only tell you when to look.

**After launching all tasks:**

1. Arm one single-shot safety timer so a child that never starts cannot leave this
   session asleep forever. **Using the Bash tool with `run_in_background: true`**:

   ```bash
   sleep $((TASK_TIMEOUT_MIN * 60))
   ```

   `TASK_TIMEOUT_MIN` is the task timeout already resolved for this dispatch (default
   90). This is a safety net, not a deadline — a live-but-slow task re-arms it.

2. Report the launch summary using Template A with concrete surface IDs.
3. Tell the user: "Monitoring N tasks. Waiting for agmsg notifications."
4. **End your turn.** Do not block and do not poll.

### On every wake, re-derive state

You do not keep a monitoring loop, so treat each wake as stateless: read all of
`.dispatch/*/status.json` and decide from that, not from what you remember.

```bash
for f in .dispatch/*/status.json; do
  slug=$(basename "$(dirname "$f")")
  echo "$slug: $(jq -r '.status' "$f" 2>/dev/null || echo unknown) - $(jq -r '.message // ""' "$f" 2>/dev/null)"
done
```

Then branch on what woke you:

- **`[ready] <name>`** — that pane is now reachable. Once every expected pane has
  reported, send the tasks (Step 2's delivery). Nothing else to report to the user.
- **`dispatch-notify: [dispatch] task "X" finished`** — read that task's `status.json`
  and, when `done`, its `result.md`. Re-emit the full progress table (**Template B** —
  never a one-line free-form message). If every task is terminal, proceed to Completion
  (Template C). Otherwise tell the user how many remain and end your turn again.
  Receiving the same completion twice is normal: notifications come from the child
  itself, from the status.json watcher the runner wrapper runs alongside it, and from
  the wrapper at session exit. Treat them idempotently and trust status.json.
- **Any other child message** (a question, a progress note) — answer it by replying with
  `send.sh` to that child's agent name, then end your turn.
- **The timer task** — no message arrived within the window. Re-derive state, then for
  each non-terminal task decide: if its pane still shows activity
  (`cmux read-screen --surface <id>`), re-arm the same timer and end your turn; if a
  pane is gone or a `[ready]` never arrived, mark that task `error` with the reason and
  report it. Use `verify-agmsg-ready.sh --codex` on codex panes to separate "seat never
  recorded" from "pane died".
```

`### Background process health check` の節は丸ごと削除する (監視プロセスが存在しない)。

- [ ] **Step 4: `monitor-dispatch.sh` を削除**

```bash
git rm apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/monitor-dispatch.sh
```

`.monitor.pid` / `.monitor.log` を掃除するコードが cleanup 系スクリプト・テストに
残っていないか `grep -rn "\.monitor\." apps/cmux-team-dispatch-task` で確認して消す。

- [ ] **Step 5: テストを実行**

Run:
```bash
bash apps/cmux-team-dispatch-task/test/test-message-type-removed.sh
bash apps/cmux-team-dispatch-task/test/test-loop-cleanup.sh
bash apps/cmux-team-dispatch-task/test/test-cleanup-close.sh
bash apps/cmux-team-dispatch-task/test/test-delivery-callsites.sh
node scripts/check-doc-lang.mjs
```
Expected: 全 PASS / `check-doc-lang: OK`

- [ ] **Step 6: commit**

```bash
git add -A apps/cmux-team-dispatch-task
git commit -m "refactor(dispatch): monitor-dispatch.sh を削除し push ベースの待機にする

status.json のポーリングと heartbeat / DIED 通知を全廃した。親はターンを閉じて
Monitor イベントで起き、起きるたびに status.json から状態を再導出する。無反応の子を
拾うためだけに単発 sleep タスク 1 本を保険として張る。

agmsg 未インストールと watcher 不在は fail-fast にし、AGMSG_INSTALLED の
true/false 二系統分岐を廃止した。"
```

---

### Task 5: verdict 待ちのポーリングを push に置き換える

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md:1482-1520`
  (Phase A-R の待機ブロック)
- Modify: 同 Phase B-R の待機ブロック (`:1675` 付近。`grep -n "VERDICT" SKILL.md` で特定)
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh:770`
  (`REVIEW_INSTRUCTION` に埋め込まれた子側のポーリング手順)
- Modify: 同 `:782` (`ABORT_REVIEW_STEP` の「reviewer はこのファイルをポーリングしない」注記)

**Interfaces:**
- Consumes: Task 3 の `send.sh` 配送契約、Task 4 の「wake ごとに状態を再導出」プロトコル。
- Produces: verdict 待ちの新プロトコル。レビュアーは verdict ファイルを書いた**後**に
  依頼者へ agmsg を 1 通送る。待つ側はポーリングしない。

- [ ] **Step 1: レビュー依頼文に verdict 通知の指示を足す**

Phase A-R / Phase B-R のどちらの依頼文にも、末尾のプロトコル部分へ次を追加する
(現在は「verdict 行を書け」で終わっている):

```
After writing the file, notify the requester with ONE send.sh call:
  ~/.agents/skills/agmsg/scripts/send.sh <team> <your-agent-name> <requester-agent-name> 'review-verdict: <point>-round-<N> VERDICT: approve|needs_work'
The file is the record; this message is what wakes the requester. Without it the
requester never learns the review finished.
```

- [ ] **Step 2: Phase A-R の待機ブロックを置き換える**

`SKILL.md:1482` の `2. Send the request with ONE send-prompt.sh call, then wait by
polling the verdict file.` から、その `while true` ブロックと stalled 判定の終わりまでを
次で置き換える:

```markdown
      2. Send the request with ONE send.sh call, then end your turn:
           ~/.agents/skills/agmsg/scripts/send.sh "$TEAM" parent {{REVIEW_PANE_AGENT}} 'review-plan: <request text>'
         Do NOT poll the verdict file. The reviewer sends a `review-verdict:` message
         after writing it, and that message wakes this session.
      3. On waking with `review-verdict: <point>-round-<N> ...`, read
         `<EXISTING_STATUS_DIR>/review/<point>-round-<N>.md` and act on the verdict
         line at its end. The file is the source of truth; the message only says it is
         ready. If the message arrives but the file has no `VERDICT:` line, treat it as
         `needs_work` and say so in the next round's request.
      4. If the safety timer (Step 3) fires while you are waiting on a verdict, check
         the reviewer pane with `cmux read-screen --surface "$REVIEW_SURFACE"`. Still
         working → re-arm the timer and end your turn. Pane gone or idle with no
         verdict → re-send the request once for the same round, then fall back to
         AskUserQuestion.
```

- [ ] **Step 3: Phase B-R の待機ブロックを同じ形にする**

Phase B-R は**実装者 (子) がレビュアーを待つ**ので、待つ主体が親ではなく子である。
`launch-workspace.sh:770` の `REVIEW_INSTRUCTION` に埋め込まれた
`(2) wait by polling $REVIEW_DIR/code-round-N.md every 5 seconds ...` から
`immediately before any re-send or skip decision.` までを次で置き換える:

```
(2) then stop and wait. Do NOT poll the file. The reviewer sends you a review-verdict
message when the file is ready, and that message resumes you. If you are resumed with
no verdict line in the file, treat it as VERDICT: needs_work.
```

子が claude なら Monitor で起き、codex なら bridge で起きる。どちらも readiness を
確立済みである (Task 2) ことが前提。

- [ ] **Step 4: 静的検査を追加**

`test-delivery-callsites.sh` に不変条件を追加する:

- **CS5**: `SKILL.md` / `references/**/*.md` / `launch-workspace.sh` に verdict の
  ポーリング指示 (`polling`, `every 5 seconds`, `15-minute chunks`, `seq 1 180`) が
  残っていないこと
- **CS6**: レビュー依頼文に `review-verdict:` の通知指示が含まれること

- [ ] **Step 5: テストを実行**

Run:
```bash
bash apps/cmux-team-dispatch-task/test/test-delivery-callsites.sh
bash apps/cmux-team-dispatch-task/test/test-launch-workspace-codex.sh
node scripts/check-doc-lang.mjs
```
Expected: 全 PASS / `check-doc-lang: OK`

- [ ] **Step 6: commit**

```bash
git add -A apps/cmux-team-dispatch-task
git commit -m "refactor(dispatch): verdict 待ちをファイルポーリングから push に置き換え

Phase A-R / Phase B-R の 5 秒間隔・15 分チャンクのポーリングと、ペイン画面差分に
よる生存確認を削除した。レビュアーは verdict ファイルを書いた後に依頼者へ
review-verdict メッセージを 1 通送り、それが依頼者を起こす。"
```

---

### Task 6: loop mode の `batch-wait.sh` を削除する

**Files:**
- Delete: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/batch-wait.sh`
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/loop-mode.md:143`
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/loop-mode-ja.md`
  (対応する訳)
- Modify: `apps/cmux-team-dispatch-task/test/test-delivery-callsites.sh` (CS4 の対象拡張)

**Interfaces:**
- Consumes: Task 4 の「wake ごとに状態を再導出」プロトコルと単発タイマー。
- Produces: loop mode のバッチ完了判定。`issue-fetch.sh` の state ファイル更新は残す。

- [ ] **Step 1: `loop-mode.md:143` のバッチ待ちを書き換える**

`batch-wait.sh --state-file <path> --batch <N> --timeout-min <task_timeout_min>` を
呼ぶ記述を、次の push ベースの手順に置き換える:

```markdown
Do not wait with a script. After dispatching a batch, end your turn. Each child's
`dispatch-notify` message wakes you; on every wake, reconcile the loop state file from
`.dispatch/*/status.json` (the same re-derivation Step 3 describes) and write each
issue's terminal status and `pr_url` into it with `issue-fetch.sh --state-file <path>
heartbeat` first, so the lock owner check still runs before the write.

A batch is complete when every issue in it has a terminal status. Until then, end your
turn again. The single-shot safety timer armed in Step 3 covers a child that never
reports: on that wake, any issue whose `claimed_at` is older than `task_timeout_min`
becomes `timeout`, with the same sentinel (`<loop-dir>/timed-out/<slug>`) and
`status.json` write the old script performed.
```

- [ ] **Step 2: `loop-mode-ja.md` の対応箇所を同じ内容の日本語で更新**

- [ ] **Step 3: `batch-wait.sh` を削除**

```bash
git rm apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/batch-wait.sh
```

- [ ] **Step 4: CS4 の対象を 5 ファイルに拡張**

Task 3 Step 6 で 2 つに限定した CS4 の対象へ `monitor-dispatch.sh` /
`ensure-agmsg-ready.sh` / `batch-wait.sh` を追加し、参照が 1 つも残らないことを検査する。

- [ ] **Step 5: テストを実行**

Run:
```bash
bash apps/cmux-team-dispatch-task/test/test-delivery-callsites.sh
bash apps/cmux-team-dispatch-task/test/test-in-session.sh
bash apps/cmux-team-dispatch-task/test/test-override.sh
bash apps/cmux-team-dispatch-task/test/test-resolve-agmsg-type.sh
node scripts/check-doc-lang.mjs
```
Expected: 全 PASS / `check-doc-lang: OK`

- [ ] **Step 6: commit**

```bash
git add -A apps/cmux-team-dispatch-task
git commit -m "refactor(dispatch): loop mode の batch-wait.sh を削除

バッチ完了待ちのポーリングを廃止し、子の dispatch-notify で起きるたびに loop state
を status.json から再導出する形にした。timeout 判定は単発タイマーの wake で行う。"
```

---

### Task 7: 文書を実態に合わせる

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md`
  (Task 3-6 で変更した SKILL.md セクションの訳)
- Modify: `apps/cmux-team-dispatch-task/CLAUDE.md` (冒頭のスクリプト表、検証項目
  9 / 12 / 15 / 17 / 26 / 27)
- Modify: `apps/cmux-team-dispatch-task/README.md`
- Modify: `apps/cmux-team-dispatch-task/docs/notification-gaps.md`
- Modify: `docs/superpowers/specs/2026-08-12-delivery-verification-results.md`
- Modify: `CLAUDE.md` (ルート。Plugin-specific guidance の記述)

**Interfaces:**
- Consumes: Task 1-6 の確定した実装。
- Produces: なし (文書のみ)。

- [ ] **Step 1: `guide-ja.md` を SKILL.md と 1:1 で対応させる**

SKILL.md の変更セクション (delivery contract / Step 1g / Step 3 / Phase A-R / Phase B-R)
に対応する訳を差し替える。見出しの 1:1 対応を崩さない。

- [ ] **Step 2: `cmux-team-dispatch-task/CLAUDE.md` の検証項目を書き換える**

- 冒頭のスクリプト表から `monitor-dispatch.sh` / `send-prompt.sh` / `agmsg-path.sh` /
  `ensure-agmsg-ready.sh` の行を削除し、`verify-agmsg-ready.sh` の行を追加する
- **項目 9 / 15**: `send-prompt.sh` 一本化の記述を「配送は `send.sh` 一本化」に置き換え、
  回帰は `test-delivery-callsites.sh` (CS1-CS6) を指す
- **項目 12**: monitor heartbeat の検査を削除し、「単発タイマーの wake で状態を再導出
  する」検査に置き換える
- **項目 17**: `AGMSG_INSTALLED=true/false` の二系統検査を削除し、「agmsg 不在・watcher
  不在は fail-fast」「ペインは `[ready]` を送ってから配送対象になる」検査に置き換える。
  **「親の watcher が生きていれば inbox にも記録される」は agmsg 1.2.1 では成立しない
  (spec の B5) ので削除する**
- **項目 26**: `monitor-dispatch.sh` の layout 固定に関する行を削除する
- **項目 27**: watcher 死亡時のフォールバック検査を、「readiness が確立しないペインへは
  配送せず fail-fast する」検査に置き換える
- 新項目: **readiness 3 要件**と、claude 子の readiness が親から観測できないこと
  (`[ready]` 自己申告が唯一の手段) を検証項目として追加する

- [ ] **Step 3: `notification-gaps.md` を更新**

- U1 (子が沈黙する) を「解消: 単発タイマーの wake で検出」に移す
- U9 (`/clear` で watcher が戻らない) を「解消: SessionStart hook の再発火」に移す
- U2 / U4 (cmux send の部分配信) は配送経路が消えたので削除する
- 新規に R1 (codex ペイン死亡の即時検知の喪失) と R2 (codex の seat 喪失) を追加する

- [ ] **Step 4: `2026-08-12-delivery-verification-results.md` に追記**

**削除しない。** 末尾に「## 2026-08-21 の再検証で結論が逆転した」節を足し、
B1/B2/B5/V2a/V2b の結果と、V1 の fail 原因 (ハーネスに Monitor ツールが無かったこと) が
解消したことを書く。何がいつ変わったのかを残さないと、同じ取り違えが三度起きる。

- [ ] **Step 5: 検証**

Run: `node scripts/check-doc-lang.mjs`
Expected: `check-doc-lang: OK`

- [ ] **Step 6: commit**

```bash
git add -A apps/cmux-team-dispatch-task docs CLAUDE.md
git commit -m "docs(dispatch): monitor 専用化に合わせて検証項目と通知欠落一覧を更新

CLAUDE.md の検証項目 9/12/15/17/26/27 を書き換え、readiness 3 要件を新項目に
追加した。notification-gaps の U1/U9 を解消へ移し、R1/R2 を追加した。

2026-08-12 の検証結果ドキュメントには追記のみを行い、結論が逆転した経緯を残した。"
```

---

### Task 8: バージョンを major bump して marketplace を同期

**Files:**
- Modify: `apps/cmux-team-dispatch-task/.claude-plugin/plugin.json`
- Modify: `apps/cmux-team-dispatch-task/.codex-plugin/plugin.json` (存在する場合)
- Modify: `.claude-plugin/marketplace.json`

**Interfaces:**
- Consumes: Task 1-7 の全変更。
- Produces: なし。

- [ ] **Step 1: 現在のバージョンと `.codex-plugin` の有無を確認**

Run:
```bash
jq -r '.version' apps/cmux-team-dispatch-task/.claude-plugin/plugin.json
ls apps/cmux-team-dispatch-task/.codex-plugin/plugin.json 2>/dev/null || echo "(no .codex-plugin)"
jq -r '.plugins[] | select(.name=="cmux-team-dispatch-task") | .version' .claude-plugin/marketplace.json
```

現在は v1.22.0 系。スクリプト 5 本と CLI フラグの削除を含むので `2.0.0` にする。

- [ ] **Step 2: 存在する plugin.json すべてと marketplace.json を `2.0.0` に揃える**

- [ ] **Step 3: 同期を検証**

Run:
```bash
a=$(jq -r '.version' apps/cmux-team-dispatch-task/.claude-plugin/plugin.json)
c=$(jq -r '.plugins[] | select(.name=="cmux-team-dispatch-task") | .version' .claude-plugin/marketplace.json)
echo "$a / $c"; [[ "$a" == "$c" ]] || echo "MISMATCH"
[[ -f apps/cmux-team-dispatch-task/.codex-plugin/plugin.json ]] && \
  { b=$(jq -r '.version' apps/cmux-team-dispatch-task/.codex-plugin/plugin.json); echo "codex: $b"; [[ "$b" == "$a" ]] || echo "MISMATCH"; }
```
Expected: 値が一致し `MISMATCH` が出ないこと

- [ ] **Step 4: commit**

```bash
git add apps/cmux-team-dispatch-task/.claude-plugin .claude-plugin/marketplace.json
[[ -d apps/cmux-team-dispatch-task/.codex-plugin ]] && git add apps/cmux-team-dispatch-task/.codex-plugin
git commit -m "release(cmux-team-dispatch-task): v2.0.0 (agmsg monitor 専用化)"
```

---

### Task 9: 実ディスパッチでの E2E 確認

**Files:** なし (手動検証。結果は spec へ追記)

**Interfaces:**
- Consumes: Task 1-8 の全変更。
- Produces: 検証結果。spec が E2E を必須としている根拠は、V1 が静的検査だけで前提の
  誤りを見逃した経緯 (spec の背景節)。

- [ ] **Step 1: プラグインを再読み込み**

Run: `bash install.sh` の後、Claude Code セッションで `/reload-plugins`

実行中のセッションは読み込み済みの旧 SKILL.md を保持し続け、削除済みスクリプトを呼んで
失敗する。前回の実ディスパッチ E2E でも同じ事故が起きている。

- [ ] **Step 2: 2 タスク並列でディスパッチする**

設定: design=claude / exec=codex 固定、レビューモード有効、prewarm 有効。題材は
`docs/notification-gaps.md` の R1 / R2 の文面整備など、副作用の小さいもの 2 件。

- [ ] **Step 3: 観測項目を確認する**

- `.dispatch/*/outbox/` が **1 ファイルも生成されない**こと (配送が inbox 経由である証拠)
- 親の background task が `sleep` の 1 本だけであること (監視スクリプトが無いこと)
- 全ペインから `[ready] <name>` が届き、その**後で**タスクが配送されていること
- **codex ペインが実際にタスクを受信して着手すること** (V2a の未読滞留が起きないこと。
  seat 記録が効いている証拠であり、この E2E の最重要項目)
- Phase A-R / Phase B-R の verdict が `review-verdict:` メッセージで伝わること
- 完了通知で親が起き、Template B / Template C を出すこと
- **子 claude が Monitor イベントで起きること (B4 の未実施分をここで確認)**

- [ ] **Step 4: 結果を spec に追記して commit**

`docs/superpowers/specs/2026-08-21-agmsg-monitor-only-design.md` の実測結果表に E2E の
行を追加し、観測できなかった項目があれば残余リスクとして明記する。

```bash
git add docs/superpowers/specs/2026-08-21-agmsg-monitor-only-design.md
git commit -m "docs: dispatch の monitor 専用化 E2E 結果を追記"
```
