# cmux-codex-exec 新規 + cmux-codex-review 完了通知 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** claude/superpowers の plan を対話 codex にカレントdir で実装させ、完了を親セッションが agmsg 経由で検知して wake する新プラグイン `cmux-codex-exec` を追加し、既存 `cmux-codex-review` を対話化＋完了通知対応にする。

**Architecture:** 各プラグインは cmux ペインで対話 codex を起動する bash スクリプト（bin）+ スラッシュコマンド + スキル。完了通知は「codex が最終アクションで agmsg `send.sh` を撃つ」→「親が起動した短命 watcher（`cmux-codex-wait`）が agmsg history を polling し token 検知で *exit*」→「その task 完了で harness が idle 親を wake」で実現する（agmsg monitor push は idle 親を起こせないことを実測済み）。

**Tech Stack:** bash / zsh, cmux CLI (`cmux new-split` / `cmux send`), codex CLI 0.144.x（対話 TUI + `-c` 上書き）, agmsg 1.1.8（`join.sh` / `send.sh` / `history.sh` / `whoami.sh`）, biome 2.4.9（JSON format）。

## Global Constraints

- 言語: ドキュメント・コメントは日本語、コード（変数名・関数名・CLI フラグ）は英語。
- codex デフォルト: model `gpt-5.6-sol` / reasoning effort `xhigh`。`-c model="..."` / `-c model_reasoning_effort="..."` で注入、`-m`/`-e` フラグで上書き可。
- codex は**対話型**で起動（`codex exec` / `codex review` サブコマンドは使わない）。plan 実装は `--dangerously-bypass-approvals-and-sandbox` を付与。
- 実行は**カレントディレクトリ**（worktree 隔離しない）。
- cmux 前提: `CMUX_SOCKET_PATH` 未設定なら bin は明示エラーで終了。
- agmsg 1.1.8 は未登録の from/to を拒否するため、送信元 codex agent は事前に `join.sh` で team 登録する。
- 通知 token はペインの surface 由来で決定的に導出（乱数・時刻を使わない）。
- watcher は agmsg 常駐 monitor とは別物で、**token 検知で exit する短命プロセス**であること（exit が wake トリガー）。history は非破壊読み取り（`inbox.sh` は既読化するので使わない）。
- biome: JSON は `lineWidth 120` / 2-space / 配列はインライン化。各 bin は `bash -n` を通す。
- バージョン同期: `apps/<name>/.claude-plugin/plugin.json` と `.codex-plugin/plugin.json` とルート `.claude-plugin/marketplace.json` を一致させる。

## File Structure

### 新規: `apps/cmux-codex-exec/`
- `bin/cmux-codex-exec` — plan 解決 + ペイン分割 + 対話 codex 起動 + token/agent 導出・出力
- `bin/cmux-codex-wait` — 短命 watcher（agmsg history polling → token 検知で exit）
- `commands/codex-exec.md` — `/codex-exec`: identity 解決 → codex agent pre-join → bin 実行 → watcher を background task 起動 → 待機
- `skills/codex-exec/SKILL.md` — トリガー定義
- `.claude-plugin/plugin.json` / `.codex-plugin/plugin.json` — マニフェスト（version 1.0.0）
- `CLAUDE.md` / `README.md`

### 修正: `apps/cmux-codex-review/`
- `bin/cmux-codex-review` — ヘッドレス `codex review` → 対話 codex のレビュープロンプトに変更 + 通知配線引数追加
- `bin/cmux-codex-wait` — 新規（exec と同一内容を内包）
- `commands/codex-review.md` — 親 identity 解決 + watcher 起動を追加
- `skills/codex-review/SKILL.md` — 対話化・通知を反映
- `.claude-plugin/plugin.json` / `.codex-plugin/plugin.json` — version 1.0.0 → 1.1.0
- `CLAUDE.md` / `README.md` — 更新

### 修正: ルート
- `.claude-plugin/marketplace.json` — cmux-codex-exec 追加 + cmux-codex-review を 1.1.0 に
- `install.sh` — cmux-codex-exec のインストール行追加

---

### Task 1: 短命 watcher `cmux-codex-wait`

**Files:**
- Create: `apps/cmux-codex-exec/bin/cmux-codex-wait`
- Test: `/tmp/cmux-plugin-tests/test-wait.sh`（scratchpad, 非コミット）

**Interfaces:**
- Consumes: agmsg `history.sh <team> <agent> <limit>`（既存。出力に本文文字列を含む行がある）
- Produces: 実行形式 `cmux-codex-wait <team> <agent> <token> [--timeout <sec>] [--interval <sec>]`。stdout に `status=done token=<token>`（exit 0）/ `status=timeout token=<token>`（exit 3）/ `status=error reason=<r>`（exit 2）。

- [ ] **Step 1: テストを書く（失敗させる）**

`/tmp/cmux-plugin-tests/test-wait.sh` を作成:

```bash
#!/usr/bin/env bash
set -uo pipefail
BIN="$(cd "$(dirname "$0")" >/dev/null; pwd)"  # placeholder, 下で上書き
BIN_PATH="/Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins/apps/cmux-codex-exec/bin/cmux-codex-wait"
TMP=$(mktemp -d)
mkdir -p "$TMP/.agents/skills/agmsg/scripts"
cat > "$TMP/.agents/skills/agmsg/scripts/history.sh" <<'STUB'
#!/usr/bin/env bash
# stub: $HOME/HIT が存在すれば token を含む行を出力
[[ -f "$HOME/HIT" ]] && echo "  ● [t] waker → me: DONE ${TOKEN_UNDER_TEST} done"
exit 0
STUB
chmod +x "$TMP/.agents/skills/agmsg/scripts/history.sh"

fail=0

# Case A: token 到達 → status=done exit0
: > "$TMP/HIT"
out=$(HOME="$TMP" TOKEN_UNDER_TEST="codex-exec-25" "$BIN_PATH" team me codex-exec-25 --timeout 5 --interval 1); rc=$?
[[ "$out" == status=done* && $rc -eq 0 ]] && echo "PASS A" || { echo "FAIL A: rc=$rc out=$out"; fail=1; }

# Case B: 未到達 → timeout exit3
rm -f "$TMP/HIT"
out=$(HOME="$TMP" TOKEN_UNDER_TEST="codex-exec-25" "$BIN_PATH" team me codex-exec-25 --timeout 1 --interval 1); rc=$?
[[ "$out" == status=timeout* && $rc -eq 3 ]] && echo "PASS B" || { echo "FAIL B: rc=$rc out=$out"; fail=1; }

exit $fail
```

- [ ] **Step 2: テスト失敗を確認**

Run: `mkdir -p /tmp/cmux-plugin-tests && bash /tmp/cmux-plugin-tests/test-wait.sh`
Expected: FAIL（bin 未作成のため実行不可）

- [ ] **Step 3: watcher を実装**

`apps/cmux-codex-exec/bin/cmux-codex-wait`:

```bash
#!/usr/bin/env bash
set -uo pipefail

# cmux-codex-wait — agmsg history を polling し、指定 token を含む完了メッセージが
# 届いたら status=done で exit する短命 watcher。background task として起動され、
# その exit が Claude Code の <task-notification> を発火して idle 親を wake する。
# agmsg 常駐 monitor と違い「完了して exit する」ことが wake の要。
#
# Usage: cmux-codex-wait <team> <agent> <token> [--timeout <sec>] [--interval <sec>]

AGMSG_HISTORY="$HOME/.agents/skills/agmsg/scripts/history.sh"

TEAM="${1:-}"; AGENT="${2:-}"; TOKEN="${3:-}"
[[ $# -ge 3 ]] && shift 3 || true
TIMEOUT=1800
INTERVAL=5
while [[ $# -gt 0 ]]; do
  case "$1" in
    --timeout)  TIMEOUT="$2"; shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    *) shift ;;
  esac
done

[[ -n "$TEAM" && -n "$AGENT" && -n "$TOKEN" ]] || { echo "status=error reason=usage"; exit 2; }
[[ -x "$AGMSG_HISTORY" ]] || { echo "status=error reason=no-agmsg"; exit 2; }

elapsed=0
while (( elapsed < TIMEOUT )); do
  if "$AGMSG_HISTORY" "$TEAM" "$AGENT" 30 2>/dev/null | grep -qF "$TOKEN"; then
    echo "status=done token=$TOKEN"
    exit 0
  fi
  sleep "$INTERVAL"
  elapsed=$(( elapsed + INTERVAL ))
done
echo "status=timeout token=$TOKEN"
exit 3
```

- [ ] **Step 4: 実行権限付与＋テスト通過を確認**

Run:
```bash
chmod +x /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins/apps/cmux-codex-exec/bin/cmux-codex-wait
bash -n /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins/apps/cmux-codex-exec/bin/cmux-codex-wait
bash /tmp/cmux-plugin-tests/test-wait.sh
```
Expected: `PASS A` と `PASS B` の両方、exit 0

- [ ] **Step 5: コミット**

```bash
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins
git add apps/cmux-codex-exec/bin/cmux-codex-wait
git commit -m "feat(cmux-codex-exec): 短命 watcher cmux-codex-wait を追加（token 検知で exit）"
```

---

### Task 2: `cmux-codex-exec` bin（plan 解決 + ペイン起動 + token 導出）

**Files:**
- Create: `apps/cmux-codex-exec/bin/cmux-codex-exec`
- Test: `/tmp/cmux-plugin-tests/test-exec.sh`（scratchpad, 非コミット）

**Interfaces:**
- Consumes: `cmux new-split <dir>`（出力 2 列目が surface ref）, `cmux send --surface <sf> <text>`。テスト時は環境変数 `CMUX_BIN` でスタブに差し替え可能。
- Produces: 実行形式 `cmux-codex-exec [plan-path] [-d dir] [-m model] [-e effort] [--team T] [--parent P] [--plan-mode inline|path]`。stdout に `surface=<sf>` / `token=codex-exec-<num>` / `codex_agent=cxexec-<num>` / `plan=<path>` の KEY=VALUE 行と、末尾に人間向け 1 行サマリ。

- [ ] **Step 1: テストを書く（失敗させる）**

`/tmp/cmux-plugin-tests/test-exec.sh`:

```bash
#!/usr/bin/env bash
set -uo pipefail
ROOT="/Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins"
BIN="$ROOT/apps/cmux-codex-exec/bin/cmux-codex-exec"
TMP=$(mktemp -d)
# stub cmux: new-split は "OK surface:25 workspace:9" 相当、send は送信内容を記録
mkdir -p "$TMP/bin"
cat > "$TMP/bin/cmux" <<'STUB'
#!/usr/bin/env bash
if [[ "$1" == "new-split" ]]; then echo "OK surface:25 workspace:9"; exit 0; fi
if [[ "$1" == "send" ]]; then printf 'SENT=[%s]\n' "$4" >> "$SENT_LOG"; exit 0; fi
STUB
chmod +x "$TMP/bin/cmux"
# plan ファイル
mkdir -p "$TMP/repo/docs/superpowers/plans"
echo "# サンプル plan" > "$TMP/repo/docs/superpowers/plans/2026-07-16-sample.md"

fail=0
export CMUX_SOCKET_PATH=/tmp/fake.sock
export SENT_LOG="$TMP/sent.log"

# Case A: plan 自動選択 + 通知配線あり
cd "$TMP/repo"
out=$(CMUX_BIN="$TMP/bin/cmux" "$BIN" --team myteam --parent parent); rc=$?
echo "$out" | grep -q "surface=surface:25" && \
echo "$out" | grep -q "token=codex-exec-25" && \
echo "$out" | grep -q "codex_agent=cxexec-25" && \
grep -q "codex --dangerously-bypass-approvals-and-sandbox" "$SENT_LOG" && \
grep -q 'model_reasoning_effort="xhigh"' "$SENT_LOG" && \
grep -q "send.sh myteam cxexec-25 parent" "$SENT_LOG" && \
grep -q "DONE codex-exec-25" "$SENT_LOG" \
  && echo "PASS A" || { echo "FAIL A: rc=$rc"; echo "$out"; cat "$SENT_LOG"; fail=1; }

# Case B: cmux 外 → エラー
out=$(unset CMUX_SOCKET_PATH; CMUX_BIN="$TMP/bin/cmux" "$BIN" 2>&1); rc=$?
[[ $rc -ne 0 && "$out" == *"cmux"* ]] && echo "PASS B" || { echo "FAIL B: rc=$rc out=$out"; fail=1; }

# Case C: plan 不在 → エラー
: > "$SENT_LOG"
cd "$TMP"; mkdir -p "$TMP/empty"; cd "$TMP/empty"
out=$(CMUX_BIN="$TMP/bin/cmux" "$BIN" 2>&1); rc=$?
[[ $rc -ne 0 && "$out" == *"plan"* ]] && echo "PASS C" || { echo "FAIL C: rc=$rc out=$out"; fail=1; }

exit $fail
```

- [ ] **Step 2: テスト失敗を確認**

Run: `bash /tmp/cmux-plugin-tests/test-exec.sh`
Expected: FAIL（bin 未作成）

- [ ] **Step 3: bin を実装**

`apps/cmux-codex-exec/bin/cmux-codex-exec`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# cmux-codex-exec — plan を対話 codex にカレントdir で実装させ、完了通知を配線する。
#
# 新しい cmux ペインで対話 codex を起動し、plan の実装を依頼する。--team/--parent が
# 与えられた場合、codex に「完了時に agmsg send.sh を撃つ」指示を注入する。親側の
# 完了検知は cmux-codex-wait（短命 watcher）が担う。
#
# Usage: cmux-codex-exec [plan-path] [options]
#   -d, --dir <right|down|left|up>  分割方向 (default: right)
#   -m, --model <model>             codex モデル (default: gpt-5.6-sol)
#   -e, --effort <effort>           reasoning effort (default: xhigh)
#   --team <team>                   通知先 agmsg team（--parent と対で有効）
#   --parent <agent>                通知先の親 agent 名
#   --plan-mode <inline|path>       plan をプロンプトへ全文埋め込むかパス参照か (default: path)

CMUX_BIN="${CMUX_BIN:-cmux}"

if [[ -z "${CMUX_SOCKET_PATH:-}" ]]; then
  echo "エラー: cmux 内でのみ使用可能です (CMUX_SOCKET_PATH 未設定)" >&2
  exit 1
fi

DIR="right"; MODEL="gpt-5.6-sol"; EFFORT="xhigh"
TEAM=""; PARENT=""; PLAN=""; PLAN_MODE="path"
while [[ $# -gt 0 ]]; do
  case "$1" in
    -d|--dir)    DIR="$2"; shift 2 ;;
    -m|--model)  MODEL="$2"; shift 2 ;;
    -e|--effort) EFFORT="$2"; shift 2 ;;
    --team)      TEAM="$2"; shift 2 ;;
    --parent)    PARENT="$2"; shift 2 ;;
    --plan-mode) PLAN_MODE="$2"; shift 2 ;;
    right|left|up|down) DIR="$1"; shift ;;
    *)           PLAN="$1"; shift ;;
  esac
done

# plan 解決: 引数優先、無ければ docs/superpowers/plans/ の最新 md
if [[ -z "$PLAN" ]]; then
  PLAN=$(ls -t docs/superpowers/plans/*.md 2>/dev/null | head -1 || true)
fi
[[ -n "$PLAN" && -f "$PLAN" ]] || { echo "エラー: plan が見つかりません (引数 or docs/superpowers/plans/*.md)" >&2; exit 1; }
PLAN_NAME=$(basename "$PLAN")

# ペイン分割し surface を得る
S=$("$CMUX_BIN" new-split "$DIR" | awk '{print $2}')
[[ -n "$S" ]] || { echo "エラー: ペイン分割に失敗しました" >&2; exit 1; }
SNUM=$(printf '%s' "$S" | grep -oE '[0-9]+' | head -1)
TOKEN="codex-exec-$SNUM"
CODEX_AGENT="cxexec-$SNUM"

# 完了通知指示（--team/--parent 両方あるときのみ注入）
NOTIFY=""
if [[ -n "$TEAM" && -n "$PARENT" ]]; then
  NOTIFY="

作業がすべて完了したら、最後に必ず次を1回だけ実行して完了を通知せよ:
~/.agents/skills/agmsg/scripts/send.sh $TEAM $CODEX_AGENT $PARENT 'DONE $TOKEN: $PLAN_NAME 実装完了'"
fi

# plan 本文 or パス参照
if [[ "$PLAN_MODE" == "inline" ]]; then
  TASK="以下の plan をこのリポジトリに実装せよ。

$(cat "$PLAN")"
else
  TASK="plan ファイル $PLAN を読み、このリポジトリに実装せよ。"
fi

PROMPT="$TASK$NOTIFY"
CMD="codex --dangerously-bypass-approvals-and-sandbox -c model=\"$MODEL\" -c model_reasoning_effort=\"$EFFORT\" '$PROMPT'"

"$CMUX_BIN" send --surface "$S" "$CMD
"

echo "surface=$S"
echo "token=$TOKEN"
echo "codex_agent=$CODEX_AGENT"
echo "plan=$PLAN"
echo "codex-exec 起動: $S (dir: $DIR / model: $MODEL / effort: $EFFORT / plan: $PLAN_NAME)"
```

- [ ] **Step 4: 実行権限付与＋テスト通過を確認**

Run:
```bash
chmod +x /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins/apps/cmux-codex-exec/bin/cmux-codex-exec
bash -n /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins/apps/cmux-codex-exec/bin/cmux-codex-exec
bash /tmp/cmux-plugin-tests/test-exec.sh
```
Expected: `PASS A` / `PASS B` / `PASS C`、exit 0

- [ ] **Step 5: コミット**

```bash
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins
git add apps/cmux-codex-exec/bin/cmux-codex-exec
git commit -m "feat(cmux-codex-exec): plan 解決 + 対話 codex 起動 + 完了通知配線の bin を追加"
```

---

### Task 3: `cmux-codex-exec` コマンド・スキル・マニフェスト・ドキュメント

**Files:**
- Create: `apps/cmux-codex-exec/commands/codex-exec.md`
- Create: `apps/cmux-codex-exec/skills/codex-exec/SKILL.md`
- Create: `apps/cmux-codex-exec/.claude-plugin/plugin.json`
- Create: `apps/cmux-codex-exec/.codex-plugin/plugin.json`
- Create: `apps/cmux-codex-exec/CLAUDE.md`
- Create: `apps/cmux-codex-exec/README.md`

**Interfaces:**
- Consumes: `bin/cmux-codex-exec`（`token=` / `codex_agent=` / `surface=` を出力）, `bin/cmux-codex-wait`, agmsg `whoami.sh` / `join.sh`。
- Produces: `/codex-exec` スラッシュコマンド。

- [ ] **Step 1: plugin.json を作成**

`apps/cmux-codex-exec/.claude-plugin/plugin.json`:

```json
{
  "name": "cmux-codex-exec",
  "description": "claude/superpowers の plan を対話 codex にカレントdir で実装させ、完了を親セッションが agmsg 経由で検知してレビューへ繋ぐプラグイン",
  "version": "1.0.0",
  "author": {
    "name": "tanaka-yui"
  },
  "license": "MIT",
  "repository": "https://github.com/tanaka-yui/yui-cc-plugins/apps/cmux-codex-exec"
}
```

- [ ] **Step 2: .codex-plugin/plugin.json を作成**

`apps/cmux-codex-exec/.codex-plugin/plugin.json`:

```json
{
  "name": "cmux-codex-exec",
  "version": "1.0.0",
  "description": "Implement a claude/superpowers plan with interactive codex in a new cmux pane; the parent session is woken via agmsg when it finishes.",
  "author": {
    "name": "tanaka-yui",
    "url": "https://github.com/tanaka-yui"
  },
  "repository": "https://github.com/tanaka-yui/yui-cc-plugins/apps/cmux-codex-exec",
  "license": "MIT",
  "keywords": ["cmux", "codex", "exec", "plan", "agmsg"],
  "interface": {
    "displayName": "cmux-codex-exec",
    "shortDescription": "Run a plan with codex in a new cmux pane.",
    "developerName": "tanaka-yui",
    "category": "Terminal",
    "capabilities": ["Terminal"]
  }
}
```

- [ ] **Step 3: コマンドを作成**

`apps/cmux-codex-exec/commands/codex-exec.md`:

````markdown
---
allowed-tools: Bash
description: "plan を対話 codex にカレントdir で実装させ、完了を agmsg 経由で待って通知する"
---

# /codex-exec

claude/superpowers が作成した plan を、新しい cmux ペインで**対話 codex**（gpt-5.6-sol / xhigh）に
実装させる。codex は完了時に agmsg で通知し、親（このセッション）は短命 watcher の完了で wake される。

## 手順

### Step 1: agmsg identity を解決

```bash
~/.agents/skills/agmsg/scripts/whoami.sh "$(pwd)" claude-code
```

- `agent=<parent> teams=<team,...>` が返れば PARENT / TEAM を記憶。複数 team なら使う team をユーザーに確認。
- `not_joined=true` / `suggest=true` なら、ユーザーに team 名と親 agent 名を尋ねて join:
  `~/.agents/skills/agmsg/scripts/join.sh <team> <parent> claude-code "$(pwd)"`

### Step 2: bin を実行して codex ペインを起動

`$ARGUMENTS`（任意の plan パスや `-d down` 等）に `--team <TEAM> --parent <PARENT>` を足して実行:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/cmux-codex-exec" $ARGUMENTS --team <TEAM> --parent <PARENT>
```

出力の `token=` / `codex_agent=` / `surface=` を記憶する。

### Step 3: 送信元 codex agent を team に pre-join

codex が完了通知（send.sh）を撃てるよう、`codex_agent` を team に登録する（agmsg 1.1.8 は未登録 from を拒否）:

```bash
~/.agents/skills/agmsg/scripts/join.sh <TEAM> <codex_agent> codex "$(pwd)"
```

### Step 4: 短命 watcher を background task で起動して待機

**Bash tool を `run_in_background: true` で** 次を起動する（token は Step 2 の出力値）:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/cmux-codex-wait" <TEAM> <PARENT> <token> --timeout 1800
```

起動したらこのターンを終える。watcher の完了通知（`<task-notification>`）で親が wake される。

### Step 5: wake 後の分岐

watcher task の出力を確認する:

- `status=done`: 「codex-exec 完了（plan: …）。未コミット変更を codex-review でレビューしますか?」とユーザーに確認。
  Yes なら `/codex-review`（cmux-codex-review）を起動。
- `status=timeout`: 「codex の完了を検知できませんでした。ペイン `<surface>` を確認してください」と伝える。
````

- [ ] **Step 4: スキルを作成**

`apps/cmux-codex-exec/skills/codex-exec/SKILL.md`:

```markdown
---
name: codex-exec
description: >-
  claude/superpowers が作成した plan を、新しい cmux ペインで対話 codex (gpt-5.6-sol / reasoning
  effort xhigh) にカレントディレクトリで実装させ、完了を親セッションが agmsg 経由で検知してレビューへ繋ぐ
  スキル。ユーザーが「この plan を codex に実装させて」「codex で plan を実行」「plan を回して終わったら教えて」
  「codex-exec」等と言ったとき、または書き上げた plan を独立した codex プロセスに実装させたいときに必ず使う。
  cmux セッション内 (CMUX_SOCKET_PATH) が前提。実装後は cmux-codex-review でのレビューへ繋ぐ。
---

# codex-exec

plan を独立した対話 codex に実装させ、完了を agmsg 経由で待って親を wake するスキル。

デフォルト: モデル `gpt-5.6-sol` / effort `xhigh` / カレントdir / 分割方向 right / plan は
`docs/superpowers/plans/` の最新（引数でパス指定可）。

## なぜこの構成か

実装を独立 codex に委ねると、設計した本人（このセッション）とは別視点で plan が具現化される。
完了検知に agmsg を使いつつ、idle 親を確実に起こすため「token 検知で exit する短命 watcher」を
background task として噛ませる（agmsg monitor push は idle 親を起こせないことを実測済み）。

## 前提

- cmux セッション内（`CMUX_SOCKET_PATH`）。
- `codex` CLI が PATH 上。
- 親が agmsg team 参加済み（未参加ならコマンドが join を案内）。

## 実行手順

`/codex-exec` コマンド（`commands/codex-exec.md`）の Step 1〜5 に従う。要点:

1. `whoami.sh` で親 identity（TEAM/PARENT）を解決（未参加なら join）。
2. `bin/cmux-codex-exec $ARGUMENTS --team <TEAM> --parent <PARENT>` でペイン起動、`token`/`codex_agent` を取得。
3. `join.sh <TEAM> <codex_agent> codex` で送信元を pre-join。
4. `bin/cmux-codex-wait <TEAM> <PARENT> <token> --timeout 1800` を **background task** で起動して待機。
5. wake 後、`status=done` ならレビュー可否を確認して `cmux-codex-review` へ、`status=timeout` ならペイン確認を促す。
```

- [ ] **Step 5: CLAUDE.md と README.md を作成**

`apps/cmux-codex-exec/CLAUDE.md`:

```markdown
# cmux-codex-exec

plan を対話 codex にカレントdir で実装させ、完了を親が agmsg 経由で検知してレビューへ繋ぐプラグイン。

## 構成

- `commands/codex-exec.md` — `/codex-exec`（identity 解決 → bin → watcher 起動 → 待機 → レビュー案内）
- `skills/codex-exec/SKILL.md` — トリガー定義
- `bin/cmux-codex-exec` — plan 解決 + 対話 codex 起動 + token/agent 導出
- `bin/cmux-codex-wait` — 短命 watcher（history polling → token 検知で exit → 親 wake）

## 完了通知の仕組み

対話 codex は exit しないので、codex 自身に完了時 `send.sh` を撃たせ、親は「token 検知で *exit* する
短命 watcher」を background task で回す。その exit が harness の `<task-notification>` を発火し idle 親を wake する。
agmsg 常駐 monitor push は idle 親を起こせない（実測済み）ため、この方式が必須。

## デフォルト

| 項目 | 値 | 上書き |
|------|-----|--------|
| model | `gpt-5.6-sol` | `-m` |
| effort | `xhigh` | `-e` |
| plan | `docs/superpowers/plans/` 最新 | 位置引数でパス指定 |
| 分割方向 | `right` | `down`/`left`/`up` or `-d` |
| 実行dir | カレント（worktree 隔離しない） | — |

## 前提

- cmux セッション内（`CMUX_SOCKET_PATH`）、`codex` CLI on PATH、親が agmsg team 参加済み。

## 関連プラグインとの境界

- `cmux-codex-review`: 本プラグインの後段。exec 完了後にカレントdirの未コミット変更をレビューさせる。
- `cmux-team-dispatch-task`: worktree 隔離の複数タスク並列。こちらは単発・カレントdir・plan1本の軽量フロー。
```

`apps/cmux-codex-exec/README.md`:

```markdown
# cmux-codex-exec

claude/superpowers が作成した plan を、新しい cmux ペインで**対話 codex**（gpt-5.6-sol / xhigh）に
カレントディレクトリで実装させるプラグイン。codex が完了すると親セッションが agmsg 経由で wake され、
確認のうえ `cmux-codex-review` でのレビューへ繋がる。

## 使い方

```
/codex-exec                                   # docs/superpowers/plans/ の最新 plan を実装
/codex-exec docs/superpowers/plans/foo.md     # plan をパス指定
/codex-exec down                              # 下に分割
```

## フロー

1. 親の agmsg identity を解決（未参加なら join を案内）
2. 新ペインで対話 codex が plan を実装
3. codex 完了 → agmsg 通知 → 親の短命 watcher が exit → 親が wake
4. 親が「レビューする?」と確認 → Yes で cmux-codex-review 起動

## 前提条件

- [cmux](https://github.com/anthropics/cmux) 内で実行（`CMUX_SOCKET_PATH`）
- `codex` CLI（`gpt-5.6-sol` / `xhigh` が使える認証済み環境）
- agmsg 参加済み（未参加ならコマンドが案内）

## インストール

```
/plugin marketplace add tanaka-yui/yui-cc-plugins
/plugin install cmux-codex-exec@yui-cc-plugins
```

## ライセンス

MIT
```

- [ ] **Step 6: 検証（JSON/biome）**

Run:
```bash
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins
python3 -m json.tool apps/cmux-codex-exec/.claude-plugin/plugin.json >/dev/null && echo OK1
python3 -m json.tool apps/cmux-codex-exec/.codex-plugin/plugin.json >/dev/null && echo OK2
npx --no-install biome check --write apps/cmux-codex-exec/.claude-plugin/plugin.json apps/cmux-codex-exec/.codex-plugin/plugin.json
```
Expected: `OK1` / `OK2`、biome が No errors（必要なら整形適用）

- [ ] **Step 7: コミット**

```bash
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins
git add apps/cmux-codex-exec/commands apps/cmux-codex-exec/skills apps/cmux-codex-exec/.claude-plugin apps/cmux-codex-exec/.codex-plugin apps/cmux-codex-exec/CLAUDE.md apps/cmux-codex-exec/README.md
git commit -m "feat(cmux-codex-exec): コマンド・スキル・マニフェスト・ドキュメントを追加"
```

---

### Task 4: `cmux-codex-review` bin の対話化＋通知配線＋watcher 内包

**Files:**
- Modify: `apps/cmux-codex-review/bin/cmux-codex-review`
- Create: `apps/cmux-codex-review/bin/cmux-codex-wait`
- Test: `/tmp/cmux-plugin-tests/test-review.sh`（scratchpad, 非コミット）

**Interfaces:**
- Consumes: `cmux new-split` / `cmux send`（`CMUX_BIN` でスタブ可）。
- Produces: 実行形式 `cmux-codex-review [dir] [--base B|--commit C|--uncommitted] [-m model] [-e effort] [--team T] [--reviewer R] [--parent P] [-- <instr>]`。stdout に `surface=` / `token=codex-review-<num>` と人間向けサマリ。通知引数なしなら通知配線せず対話 review 起動のみ（後方互換）。

- [ ] **Step 1: watcher を review 側にも配置**

Run:
```bash
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins
cp apps/cmux-codex-exec/bin/cmux-codex-wait apps/cmux-codex-review/bin/cmux-codex-wait
chmod +x apps/cmux-codex-review/bin/cmux-codex-wait
```

- [ ] **Step 2: テストを書く（失敗させる）**

`/tmp/cmux-plugin-tests/test-review.sh`:

```bash
#!/usr/bin/env bash
set -uo pipefail
ROOT="/Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins"
BIN="$ROOT/apps/cmux-codex-review/bin/cmux-codex-review"
TMP=$(mktemp -d); mkdir -p "$TMP/bin"
cat > "$TMP/bin/cmux" <<'STUB'
#!/usr/bin/env bash
if [[ "$1" == "new-split" ]]; then echo "OK surface:31 workspace:9"; exit 0; fi
if [[ "$1" == "send" ]]; then printf 'SENT=[%s]\n' "$4" >> "$SENT_LOG"; exit 0; fi
STUB
chmod +x "$TMP/bin/cmux"
export CMUX_SOCKET_PATH=/tmp/fake.sock
export SENT_LOG="$TMP/sent.log"
fail=0

# Case A: 通知なし（後方互換）→ 対話 codex のレビュープロンプト、通知コマンドなし
: > "$SENT_LOG"
out=$(CMUX_BIN="$TMP/bin/cmux" "$BIN"); rc=$?
grep -q 'codex ' "$SENT_LOG" && \
grep -qv 'codex review --uncommitted' "$SENT_LOG" && \
grep -q 'model_reasoning_effort="xhigh"' "$SENT_LOG" && \
! grep -q 'send.sh' "$SENT_LOG" && \
echo "$out" | grep -q "surface=surface:31" \
  && echo "PASS A" || { echo "FAIL A: rc=$rc"; cat "$SENT_LOG"; fail=1; }

# Case B: 通知配線あり → send.sh + token を注入
: > "$SENT_LOG"
out=$(CMUX_BIN="$TMP/bin/cmux" "$BIN" --team t --reviewer cxrev-31 --parent parent); rc=$?
grep -q "send.sh t cxrev-31 parent" "$SENT_LOG" && \
grep -q "DONE codex-review-31" "$SENT_LOG" && \
echo "$out" | grep -q "token=codex-review-31" \
  && echo "PASS B" || { echo "FAIL B: rc=$rc"; cat "$SENT_LOG"; fail=1; }

# Case C: --base 指定 → レビュープロンプトに main が入る
: > "$SENT_LOG"
out=$(CMUX_BIN="$TMP/bin/cmux" "$BIN" --base main); rc=$?
grep -q "main" "$SENT_LOG" && echo "PASS C" || { echo "FAIL C"; cat "$SENT_LOG"; fail=1; }

exit $fail
```

- [ ] **Step 3: テスト失敗を確認**

Run: `bash /tmp/cmux-plugin-tests/test-review.sh`
Expected: FAIL（bin がまだヘッドレス `codex review` のため Case A/B で不一致）

- [ ] **Step 4: bin を書き換え**

`apps/cmux-codex-review/bin/cmux-codex-review` を全置換:

```bash
#!/usr/bin/env bash
set -euo pipefail

# cmux-codex-review — 新しい cmux ペインで対話 codex にコードレビューさせる。
#
# デフォルトは gpt-5.6-sol / reasoning effort xhigh で未コミット変更をレビュー。
# --team/--reviewer/--parent 指定時は、codex に「レビュー提示後に agmsg send.sh を撃つ」
# 完了通知を注入する（親側の検知は cmux-codex-wait が担う）。cmux 内でのみ動作。
#
# Usage: cmux-codex-review [direction] [options] [-- <review instructions>]
#   -d, --dir <right|down|left|up>  分割方向 (default: right)
#   -m, --model <model>             codex モデル (default: gpt-5.6-sol)
#   -e, --effort <effort>           reasoning effort (default: xhigh)
#   --uncommitted                   未コミット変更をレビュー (default)
#   --base <branch>                 base ブランチとの差分をレビュー
#   --commit <sha>                  指定コミットの変更をレビュー
#   --team <team> --reviewer <name> --parent <agent>  完了通知の配線
#   --                              以降を追加レビュー指示として渡す

CMUX_BIN="${CMUX_BIN:-cmux}"

if [[ -z "${CMUX_SOCKET_PATH:-}" ]]; then
  echo "エラー: cmux 内でのみ使用可能です (CMUX_SOCKET_PATH 未設定)" >&2
  exit 1
fi

DIR="right"; MODEL="gpt-5.6-sol"; EFFORT="xhigh"
TARGET="uncommitted"; TARGET_ARG=""
TEAM=""; REVIEWER=""; PARENT=""; INSTRUCTIONS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -d|--dir)      DIR="$2"; shift 2 ;;
    -m|--model)    MODEL="$2"; shift 2 ;;
    -e|--effort)   EFFORT="$2"; shift 2 ;;
    --uncommitted) TARGET="uncommitted"; shift ;;
    --base)        TARGET="base"; TARGET_ARG="$2"; shift 2 ;;
    --commit)      TARGET="commit"; TARGET_ARG="$2"; shift 2 ;;
    --team)        TEAM="$2"; shift 2 ;;
    --reviewer)    REVIEWER="$2"; shift 2 ;;
    --parent)      PARENT="$2"; shift 2 ;;
    --)            shift; INSTRUCTIONS="$*"; break ;;
    right|left|up|down) DIR="$1"; shift ;;
    *)             INSTRUCTIONS="${INSTRUCTIONS:+$INSTRUCTIONS }$1"; shift ;;
  esac
done

# レビュー対象の説明文
case "$TARGET" in
  base)   TARGET_DESC="現在のブランチと $TARGET_ARG ブランチの差分" ;;
  commit) TARGET_DESC="コミット $TARGET_ARG の変更" ;;
  *)      TARGET_DESC="未コミットの変更 (git の staged / unstaged / untracked)" ;;
esac

REVIEW_INSTR="$TARGET_DESC をレビューし、問題点・改善点を具体的に指摘せよ。"
[[ -n "$INSTRUCTIONS" ]] && REVIEW_INSTR="$REVIEW_INSTR

追加指示: $INSTRUCTIONS"

# ペイン分割し surface を得る
S=$("$CMUX_BIN" new-split "$DIR" | awk '{print $2}')
[[ -n "$S" ]] || { echo "エラー: ペイン分割に失敗しました" >&2; exit 1; }
SNUM=$(printf '%s' "$S" | grep -oE '[0-9]+' | head -1)
TOKEN="codex-review-$SNUM"

# 完了通知指示（--team/--reviewer/--parent すべてあるときのみ）
if [[ -n "$TEAM" && -n "$REVIEWER" && -n "$PARENT" ]]; then
  REVIEW_INSTR="$REVIEW_INSTR

レビューの提示がすべて終わったら、最後に必ず次を1回だけ実行して完了を通知せよ:
~/.agents/skills/agmsg/scripts/send.sh $TEAM $REVIEWER $PARENT 'DONE $TOKEN: レビュー完了'"
fi

CMD="codex --dangerously-bypass-approvals-and-sandbox -c model=\"$MODEL\" -c model_reasoning_effort=\"$EFFORT\" '$REVIEW_INSTR'"

"$CMUX_BIN" send --surface "$S" "$CMD
"

echo "surface=$S"
echo "token=$TOKEN"
echo "codex-review 起動: $S (方向: $DIR / model: $MODEL / effort: $EFFORT / 対象: $TARGET${TARGET_ARG:+ $TARGET_ARG})"
```

- [ ] **Step 5: テスト通過を確認**

Run:
```bash
bash -n /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins/apps/cmux-codex-review/bin/cmux-codex-review
bash /tmp/cmux-plugin-tests/test-review.sh
```
Expected: `PASS A` / `PASS B` / `PASS C`、exit 0

- [ ] **Step 6: コミット**

```bash
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins
git add apps/cmux-codex-review/bin/cmux-codex-review apps/cmux-codex-review/bin/cmux-codex-wait
git commit -m "feat(cmux-codex-review): 対話 codex 化 + 完了通知配線 + watcher 内包"
```

---

### Task 5: `cmux-codex-review` のコマンド・スキル・ドキュメント・バージョン更新

**Files:**
- Modify: `apps/cmux-codex-review/commands/codex-review.md`
- Modify: `apps/cmux-codex-review/skills/codex-review/SKILL.md`
- Modify: `apps/cmux-codex-review/CLAUDE.md`
- Modify: `apps/cmux-codex-review/README.md`
- Modify: `apps/cmux-codex-review/.claude-plugin/plugin.json`
- Modify: `apps/cmux-codex-review/.codex-plugin/plugin.json`

**Interfaces:**
- Consumes: `bin/cmux-codex-review`（`token=`/`surface=` 出力）, `bin/cmux-codex-wait`, agmsg `whoami.sh`/`join.sh`。
- Produces: 更新された `/codex-review` コマンド（任意で完了通知を配線）。

- [ ] **Step 1: コマンドを更新**

`apps/cmux-codex-review/commands/codex-review.md` を全置換:

````markdown
---
allowed-tools: Bash
description: "agmsg inbox を確認し、新ペインで対話 codex (gpt-5.6-sol/xhigh) にコードレビューさせる"
---

# /codex-review

agmsg の受信箱を確認してから、新しい cmux ペインで**対話 codex** にコードレビューさせる。
モデル **gpt-5.6-sol**、effort **xhigh**、対象はデフォルトで**未コミット変更**。
親が agmsg team 参加済みなら、レビュー完了を親へ通知する配線も行う。

## 手順

### Step 1: agmsg identity を解決し inbox を確認（非ブロッキング）

```bash
if [ ! -d ~/.agents/skills/agmsg ]; then
  installer=$(ls ~/.claude/plugins/cache/fujibee-agmsg/agmsg/*/install.sh 2>/dev/null | head -1)
  [ -n "$installer" ] && bash "$installer" --cmd agmsg
fi
~/.agents/skills/agmsg/scripts/whoami.sh "$(pwd)" claude-code
```

- `agent=<parent> teams=<team,...>` が返れば PARENT / TEAM を記憶し、各 team の inbox を確認:
  `~/.agents/skills/agmsg/scripts/inbox.sh <team> <parent>`
- `not_joined=true` / 未インストールなら「agmsg 未参加のため通知はスキップ」と添えて Step 2 へ（レビュー起動は止めない）。

### Step 2: 通知を配線するか決める

- 親が team 参加済み: reviewer agent を pre-join し（送信元登録）、bin に通知引数を渡す。
  ```bash
  # surface 確定前なので reviewer 名は起動後に join する。まず起動:
  "${CLAUDE_PLUGIN_ROOT}/bin/cmux-codex-review" $ARGUMENTS --team <TEAM> --reviewer <REVIEWER> --parent <PARENT>
  ```
  `<REVIEWER>` は `cxrev-<n>` 等の一意名。bin 出力の `token=`/`surface=` を記憶。
  起動後すぐ reviewer を join:
  `~/.agents/skills/agmsg/scripts/join.sh <TEAM> <REVIEWER> codex "$(pwd)"`
- 未参加: 通知なしで起動（後方互換）:
  ```bash
  "${CLAUDE_PLUGIN_ROOT}/bin/cmux-codex-review" $ARGUMENTS
  ```

> reviewer 名は bin 起動前に決めた固定名（例 `cxrev-review`）でよい。surface 由来 token とは別に、
> reviewer agent 名は人間可読の固定名で pre-join しても send.sh は成立する。

### Step 3: 通知配線時のみ watcher を起動して待機

**Bash tool を `run_in_background: true` で**:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/cmux-codex-wait" <TEAM> <PARENT> <token> --timeout 1800
```

起動したらターンを終える。`status=done` で wake されたら「レビュー完了」を伝える。
`status=timeout` ならペイン `<surface>` の確認を促す。

### Step 4: 報告

bin の起動サマリ（surface / 方向 / model / effort / 対象）を 1 行で報告する。
````

- [ ] **Step 2: スキルを更新**

`apps/cmux-codex-review/skills/codex-review/SKILL.md` の本文を対話・通知反映に更新。
`起動される codex コマンド（参考）` セクションを次に置換:

```markdown
## 起動される codex コマンド（参考）

対話 codex にレビュープロンプトを渡して起動する（`codex review` サブコマンドは使わない）:

​```bash
codex --dangerously-bypass-approvals-and-sandbox \
  -c model="gpt-5.6-sol" -c model_reasoning_effort="xhigh" \
  '未コミットの変更をレビューし、問題点・改善点を具体的に指摘せよ。'
​```

`--team/--reviewer/--parent` 指定時は、プロンプト末尾に「レビュー提示後に `send.sh` で親へ完了通知せよ」を
注入する。親側は `bin/cmux-codex-wait` を background task で回して wake される。
```

また frontmatter の `description` 末尾に「対話型で起動し、完了を agmsg 経由で親へ通知できる」を追記する。

- [ ] **Step 3: CLAUDE.md / README.md を更新**

`apps/cmux-codex-review/CLAUDE.md` の「動作」を「対話 codex にレビュープロンプトを送る」に、
「関連プラグインとの境界」に `cmux-codex-exec`（前段）の行を追記。
`README.md` の「起動される codex コマンド」を対話プロンプト版に差し替え、`!cmux-codex-review` は
通知なしの対話レビュー起動である旨を明記。

- [ ] **Step 4: バージョンを 1.1.0 に更新**

`apps/cmux-codex-review/.claude-plugin/plugin.json` と `.codex-plugin/plugin.json` の `"version"` を
`"1.0.0"` → `"1.1.0"` に変更。

- [ ] **Step 5: 検証（JSON/biome）**

Run:
```bash
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins
python3 -m json.tool apps/cmux-codex-review/.claude-plugin/plugin.json >/dev/null && echo OK1
python3 -m json.tool apps/cmux-codex-review/.codex-plugin/plugin.json >/dev/null && echo OK2
npx --no-install biome check --write apps/cmux-codex-review/.claude-plugin/plugin.json apps/cmux-codex-review/.codex-plugin/plugin.json
```
Expected: `OK1` / `OK2`、biome OK

- [ ] **Step 6: コミット**

```bash
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins
git add apps/cmux-codex-review/commands apps/cmux-codex-review/skills apps/cmux-codex-review/CLAUDE.md apps/cmux-codex-review/README.md apps/cmux-codex-review/.claude-plugin apps/cmux-codex-review/.codex-plugin
git commit -m "feat(cmux-codex-review): 対話化・完了通知をコマンド/スキル/docs に反映、v1.1.0"
```

---

### Task 6: マーケットプレイス登録・install.sh・全体検証

**Files:**
- Modify: `.claude-plugin/marketplace.json`
- Modify: `install.sh`

**Interfaces:**
- Consumes: 全プラグインの plugin.json（name/version）。
- Produces: marketplace 定義に `cmux-codex-exec` を追加し `cmux-codex-review` を 1.1.0 に更新、install.sh に導入行追加。

- [ ] **Step 1: marketplace.json を更新**

`.claude-plugin/marketplace.json` の `cmux-codex-review` エントリの `"version"` を `"1.1.0"` にし、
`plugins` 配列末尾（`cmux-codex-review` の後）に追加:

```json
    {
      "name": "cmux-codex-exec",
      "description": "claude/superpowers の plan を対話 codex にカレントdir で実装させ、完了を親セッションが agmsg 経由で検知してレビューへ繋ぐプラグイン。",
      "source": "./apps/cmux-codex-exec",
      "version": "1.0.0",
      "license": "MIT",
      "category": "terminal",
      "tags": ["cmux", "codex", "exec", "plan", "agmsg"]
    }
```

- [ ] **Step 2: install.sh に導入行を追加**

`install.sh` の `cmux-codex-review@yui-cc-plugins` のインストール行直後に追加:

```bash
claude plugin install cmux-codex-exec@yui-cc-plugins
```

（`cmux-codex-review` の行が無い場合は、`cmux-team-dispatch-task` の後に review→exec の順で 2 行追加）

- [ ] **Step 3: 全体静的検証**

Run:
```bash
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins
for f in .claude-plugin/marketplace.json apps/cmux-codex-exec/.claude-plugin/plugin.json apps/cmux-codex-exec/.codex-plugin/plugin.json apps/cmux-codex-review/.claude-plugin/plugin.json apps/cmux-codex-review/.codex-plugin/plugin.json; do python3 -m json.tool "$f" >/dev/null && echo "OK $f" || echo "BAD $f"; done
for b in apps/cmux-codex-exec/bin/cmux-codex-exec apps/cmux-codex-exec/bin/cmux-codex-wait apps/cmux-codex-review/bin/cmux-codex-review apps/cmux-codex-review/bin/cmux-codex-wait; do bash -n "$b" && echo "OK $b"; done
bash -n install.sh && echo "OK install.sh"
npx --no-install biome check --write .claude-plugin/marketplace.json
```
Expected: すべて `OK`、biome OK

- [ ] **Step 4: bin ユニットテスト再実行（回帰確認）**

Run:
```bash
bash /tmp/cmux-plugin-tests/test-wait.sh && bash /tmp/cmux-plugin-tests/test-exec.sh && bash /tmp/cmux-plugin-tests/test-review.sh
```
Expected: 全 PASS、exit 0

- [ ] **Step 5: コミット**

```bash
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins
git add .claude-plugin/marketplace.json install.sh
git commit -m "chore: cmux-codex-exec をマーケットプレイス/インストールに登録、cmux-codex-review を v1.1.0 に同期"
```

---

### Task 7: 実機 E2E（cmux 内・任意・承認制）

**Files:** なし（動作確認のみ）

**Interfaces:** 全 bin / コマンド。

- [ ] **Step 1: 小さな plan で codex-exec を通す**

`docs/superpowers/plans/` に無害な小 plan（例: README に 1 行追記）を用意し、cmux 内で:
`/codex-exec` を実行 → 新ペインで対話 codex が起動し実装 → 完了通知 → 親 watcher が exit → 親 wake を観察。
Expected: 親が `status=done` で wake され、「レビューする?」の確認が出る。

- [ ] **Step 2: 続けて codex-review を通す**

確認に Yes → `/codex-review` が起動し、新ペインで対話 codex が未コミット変更をレビュー。
Expected: レビューが流れ、通知配線時は完了で親が再度 wake。

- [ ] **Step 3: 後片付け**

E2E 用に作った捨て plan / 変更を破棄し、pre-join した codex/reviewer agent を `reset.sh` で解除。

---

## Self-Review

**1. Spec coverage:**
- 完了通知アーキテクチャ（codex→send.sh→短命 watcher→exit→wake）→ Task 1（watcher）/ Task 2・4（codex への通知注入）/ コマンド Step 4（watcher を background task 起動）。✓
- token を surface 由来で決定的導出 → Task 2・4 の `SNUM` 抽出。✓
- レース安全（history 非破壊 polling）→ Task 1 watcher が `history.sh` を grep。✓
- フォールバック（timeout 30分）→ Task 1 の `--timeout 1800`、コマンド Step 5 の分岐。✓
- cmux-codex-exec 構成一式 → Task 2/3。✓
- cmux-codex-review 対話化＋通知＋後方互換 → Task 4（Case A が後方互換を検証）。✓
- 対象切替（--base/--commit）→ Task 4 Case C。✓
- 境界追記・version 同期・install → Task 3/5/6。✓
- エラーハンドリング（cmux 外 / plan 不在 / codex 未検知）→ Task 2 Case B/C、コマンド Step 5。✓

**2. Placeholder scan:** 各 code step に完全な内容を記載。TBD/TODO なし。テストは scratchpad に作成しコミット対象外（プラグインを汚さない）。✓

**3. Type consistency:**
- watcher 実行名 `cmux-codex-wait <team> <agent> <token>` は Task 1 定義とコマンド Step 4（exec/review）で一致。✓
- token 形式 `codex-exec-<num>` / `codex-review-<num>`、送信元名 `cxexec-<num>` / reviewer 固定名は bin 出力とコマンドの join/watcher 引数で一致。✓
- bin の `CMUX_BIN` スタブ差し替え口は Task 2/4 のテストと一致。✓
```
