# agmsg monitor 専用化 (codex-review / codex-exec) 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `cmux-codex-review` / `cmux-codex-exec` の完了待ちを、ポーリング watcher
(`bin/cmux-codex-wait`) から agmsg monitor の push 受信へ置き換える。

**Architecture:** 親 (claude) は codex ペインを起動したらターンを閉じる。codex の完了通知
(`send.sh`) は親の常駐 Monitor ストリームに 1 行として届き、それが親を起こす。ペイン死亡を
即時検知していた `--surface` liveness チェックは失われるので、代わりに単発の `sleep`
バックグラウンドタスク 1 本を保険として張る。

**Tech Stack:** bash / markdown (Claude Code plugin)。テストは repo 慣習どおり
`test/test-*.sh` の bash スクリプトで、不変条件に ID を振り PASS/FAIL を出力する。

**Spec:** `docs/superpowers/specs/2026-08-21-agmsg-monitor-only-design.md`

## Global Constraints

- 実測済みの前提: **Monitor イベントは idle な claude セッションを起こす** (spec の B1)。
  この 2 プラグインが待つのは親 (claude) だけなので、codex 側の seat 記録は**不要**
  (spec「cmux-codex-review / cmux-codex-exec」節)。
- `apps/*/skills/*/SKILL.md` と `apps/*/commands/*.md` は **英語必須**。日本語文字を
  1 文字も書かない。`SKILL.md` の frontmatter `description` だけ日本語可。
- `SKILL.md` を更新したら同じ commit で `skills/*/references/guide-ja.md` も更新する。
- `commands/*.md` には `## Output Language` ブロックを置かない。ユーザー提示箇所に
  `Respond to the user in Japanese.` の 1 行を含める。
- `CLAUDE.md` / `README.md` は日本語。
- 検証: `pnpm check:doc-lang` (= `node scripts/check-doc-lang.mjs`) が通ること。
- バージョンは 3 箇所同期: `apps/<name>/.claude-plugin/plugin.json`、
  `apps/<name>/.codex-plugin/plugin.json`、ルート `.claude-plugin/marketplace.json`。
- `bin/cmux-codex-wait` と `bin/codex-parallel-lib.sh` は 2 プラグインに**同一内容の
  コピー**として置く運用。前者は削除するが、**後者の同一性検査は引き継ぐ**
  (現在は削除対象の `test-cmux-codex-wait.sh` の W8 が担っている)。

---

### Task 1: 完了待ちを Monitor push に置き換える

**Files:**
- Create: `apps/cmux-codex-review/test/test-monitor-only.sh`
- Delete: `apps/cmux-codex-review/bin/cmux-codex-wait`
- Delete: `apps/cmux-codex-exec/bin/cmux-codex-wait`
- Delete: `apps/cmux-codex-review/test/test-cmux-codex-wait.sh`
- Modify: `apps/cmux-codex-review/commands/codex-review.md:114-131`
- Modify: `apps/cmux-codex-exec/commands/codex-exec.md:79-100`
- Modify: `apps/cmux-codex-review/skills/codex-review/SKILL.md` (Step 2 末尾の
  「pass this `token` and `surface` to `bin/cmux-codex-wait`」と Step 3)
- Modify: `apps/cmux-codex-exec/skills/codex-exec/SKILL.md` (Procedure の 5/6)
- Modify: `apps/cmux-codex-review/skills/codex-review/references/guide-ja.md`
- Modify: `apps/cmux-codex-exec/skills/codex-exec/references/guide-ja.md`
- Modify: `apps/cmux-codex-review/bin/cmux-codex-review:13` (ヘッダコメント)
- Modify: `apps/cmux-codex-exec/bin/cmux-codex-exec:8` (ヘッダコメント)
- Modify: `apps/cmux-codex-review/bin/codex-parallel-lib.sh:5`,
  `apps/cmux-codex-exec/bin/codex-parallel-lib.sh:5` (W8 の参照先を新テストへ)

**Interfaces:**
- Consumes: `bin/cmux-codex-review` / `bin/cmux-codex-exec` が stdout に出す
  `surface=<id>` と `token=<token>` (既存契約、変更しない)。
- Produces: `token` の意味が「watcher のマッチ用文字列」から「**親が Monitor の 1 行で
  どの依頼の完了かを識別するラベル**」に変わる。Task 2 はこの `token` を使う。

- [ ] **Step 1: 新テストを書く (失敗する状態)**

`apps/cmux-codex-review/test/test-monitor-only.sh` を作る。旧テストの W8 を M5 として
引き継ぐ点に注意する。

```bash
#!/usr/bin/env bash
# monitor 専用化の回帰テスト (静的検査)。
#
# 実行: bash apps/cmux-codex-review/test/test-monitor-only.sh
#
# 守っている不変条件:
#   M1. 両プラグインに bin/cmux-codex-wait が存在しない
#   M2. 両プラグインの .md / bin に cmux-codex-wait への参照が残っていない
#   M3. 両プラグインの commands/*.md に「ターンを閉じて Monitor イベントで起きる」
#       手順がある (agmsg monitor が唯一の完了検知経路であること)
#   M4. 両プラグインの commands/*.md に単発タイマー保険 (sleep) の手順がある
#       (--surface による即時 gone 検知を失う代償の受け皿。spec の R1)
#   M5. codex-parallel-lib.sh が review / exec 2 プラグインで同一内容
#       (削除する test-cmux-codex-wait.sh の W8 を引き継ぐ)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
REVIEW="$ROOT/apps/cmux-codex-review"
EXEC="$ROOT/apps/cmux-codex-exec"
fail=0

# --- M1: bin/cmux-codex-wait が存在しない ---
if [[ ! -e "$REVIEW/bin/cmux-codex-wait" && ! -e "$EXEC/bin/cmux-codex-wait" ]]; then
  echo "PASS M1: bin/cmux-codex-wait は両プラグインから削除済み"
else
  echo "FAIL M1: cmux-codex-wait が残っている"
  fail=1
fi

# --- M2: cmux-codex-wait への参照が残っていない ---
# grep の exit status 2 以上 (読めない等) も FAIL にして fail-open させない
hits=$(grep -rl "cmux-codex-wait" "$REVIEW" "$EXEC" 2>/dev/null); rc=$?
if [[ $rc -ge 2 ]]; then
  echo "FAIL M2: grep が status=$rc を返した (検査不能)"
  fail=1
elif [[ -z "$hits" ]]; then
  echo "PASS M2: cmux-codex-wait への参照なし"
else
  echo "FAIL M2: 参照が残っている:"
  printf '  %s\n' $hits
  fail=1
fi

# --- M3: Monitor push で起きる手順がある ---
for f in "$REVIEW/commands/codex-review.md" "$EXEC/commands/codex-exec.md"; do
  if grep -q "end the turn" "$f" && grep -qi "monitor" "$f"; then
    echo "PASS M3: $(basename "$f") に Monitor push で起きる手順がある"
  else
    echo "FAIL M3: $(basename "$f") に Monitor push の手順が無い"
    fail=1
  fi
done

# --- M4: 単発タイマー保険の手順がある ---
for f in "$REVIEW/commands/codex-review.md" "$EXEC/commands/codex-exec.md"; do
  if grep -q "wake-after" "$f" && grep -qE 'sleep [0-9$]' "$f"; then
    echo "PASS M4: $(basename "$f") にタイマー保険の手順がある"
  else
    echo "FAIL M4: $(basename "$f") にタイマー保険の手順が無い"
    fail=1
  fi
done

# --- M5: codex-parallel-lib.sh の同一性 (旧 W8 の引き継ぎ) ---
if diff -q "$REVIEW/bin/codex-parallel-lib.sh" "$EXEC/bin/codex-parallel-lib.sh" >/dev/null 2>&1; then
  echo "PASS M5: codex-parallel-lib.sh が 2 プラグインで同一"
else
  echo "FAIL M5: codex-parallel-lib.sh が乖離している"
  fail=1
fi

if [[ $fail -eq 0 ]]; then
  echo "--- all passed ---"
else
  echo "--- failures ---"
fi
exit $fail
```

- [ ] **Step 2: テストを実行して落ちることを確認**

Run: `bash apps/cmux-codex-review/test/test-monitor-only.sh`
Expected: FAIL M1 / FAIL M2 / FAIL M3 / FAIL M4 (M5 は PASS)、exit 1

- [ ] **Step 3: `bin/cmux-codex-wait` と旧テストを削除**

```bash
git rm apps/cmux-codex-review/bin/cmux-codex-wait \
       apps/cmux-codex-exec/bin/cmux-codex-wait \
       apps/cmux-codex-review/test/test-cmux-codex-wait.sh
```

- [ ] **Step 4: `commands/codex-review.md` の Step 3 を置き換える**

`apps/cmux-codex-review/commands/codex-review.md` の「### Step 3: Only when
notification is wired up, launch and wait on the watcher」見出しから、その節の末尾
(`- status=gone:` の行の終わり、`### Step 4: Report` の直前) までを、次で置き換える:

```markdown
### Step 3: Only when notification is wired up, end the turn and wait for the push

Do NOT run a watcher and do NOT poll. The parent session keeps a persistent agmsg
Monitor stream (started by the SessionStart hook), so codex's completion `send.sh`
arrives as one line in this session and wakes it even while idle.

Arm one single-shot safety timer so a codex pane that dies silently cannot leave this
session asleep forever. **Using the Bash tool with `run_in_background: true`**:

```bash
sleep $((60 * 60))   # --wake-after: 60 min safety net, not a deadline
```

Then end the turn. Two things can wake this session:

- **The Monitor event** — one line of the form
  `<ts> | <team> | <reviewer> → <parent> | DONE <token>: ...`. Match the `<token>`
  from Step 2 to confirm it is this review (several reviews may be in flight). Tell
  the user the review is complete. If the line also carries `agents=<N>`, report that
  number as how many child agents codex ran in parallel. Respond to the user in
  Japanese.
- **The timer task** — no completion arrived within the window. Check whether the pane
  is still alive with `cmux read-screen --surface <surface>`. If it is alive, re-arm
  the same timer and end the turn again. If read-screen fails, tell the user the
  review pane `<surface>` is gone and completion could not be detected. Respond to
  the user in Japanese.
```

- [ ] **Step 5: `commands/codex-exec.md` の Step 4-5 を置き換える**

`apps/cmux-codex-exec/commands/codex-exec.md` の「### Step 4: Launch the short-lived
watcher as a background task and wait」見出しから Step 5 の `status=gone` 分岐の終わり
までを、次で置き換える (Step 番号は維持し、後続の節番号は変えない):

```markdown
### Step 4: End the turn and wait for the push

Do NOT run a watcher and do NOT poll. The parent session keeps a persistent agmsg
Monitor stream (started by the SessionStart hook), so codex's completion `send.sh`
arrives as one line in this session and wakes it even while idle.

Arm one single-shot safety timer so a codex pane that dies silently cannot leave this
session asleep forever. **Using the Bash tool with `run_in_background: true`**:

```bash
sleep $((90 * 60))   # --wake-after: 90 min safety net, not a deadline
```

Then end the turn.

### Step 5: Branch after waking

- **Woken by the Monitor event** — one line of the form
  `<ts> | <team> | <codex_agent> → <parent> | DONE <token>: ...`. Match the `<token>`
  from Step 2 to confirm it is this run. Ask the user whether to review the
  uncommitted changes with codex-review, noting that codex-exec has finished
  (including which plan). If the line also carries `agents=<N>`, report that number as
  how many child agents codex ran in parallel. If yes, launch `/codex-review
  --uncommitted`. Respond to the user in Japanese.
- **Woken by the timer task** — no completion arrived within the window. Check whether
  the pane is still alive with `cmux read-screen --surface <surface>`. If it is alive,
  re-arm the same timer and end the turn again. If read-screen fails, tell the user
  the implementation pane `<surface>` is gone and completion could not be detected.
  Respond to the user in Japanese.
```

exec 側のタイマーが review 側より長い (90 分 / 60 分) のは、実装がレビューより長時間
になるため。どちらも締切ではなく保険なので、生存していれば無制限に再武装する。

- [ ] **Step 6: 両 SKILL.md を更新**

`apps/cmux-codex-review/skills/codex-review/SKILL.md` の Step 2 末尾:

- 旧: `The bin outputs surface= / token=. When notification wiring is enabled, pass
  this token and surface to bin/cmux-codex-wait to wait for completion (do not attach
  --timeout; ...)`
- 新: `The bin outputs surface= / token=. When notification wiring is enabled, the
  token identifies which request a completion line belongs to; the parent is woken by
  the agmsg Monitor stream, not by a watcher.`

同ファイル Step 3 (Report) の `(when notification wiring is enabled, run
cmux-codex-wait as a background task and wait for the wake)` を
`(when notification wiring is enabled, end the turn; the completion arrives as an
agmsg Monitor event, with one single-shot sleep task armed as a safety net)` に置換。

同ファイル末尾の `The parent session side is woken by running bin/cmux-codex-wait as a
background task.` を `The parent session is woken by the agmsg Monitor event carrying
that notification.` に置換。

`apps/cmux-codex-exec/skills/codex-exec/SKILL.md` の「Why this design」段落:

- 旧: `While using agmsg for completion detection, a "short-lived watcher that exits on
  token detection" is chained in as a background task to reliably wake the idle parent
  session (verified empirically that agmsg monitor push cannot wake an idle parent
  session).`
- 新: `Completion detection is the agmsg Monitor stream itself: the parent keeps a
  persistent watcher started by its SessionStart hook, and a message delivered through
  it wakes the parent even while idle (verified 2026-08-21; the earlier finding to the
  contrary predates this harness exposing the Monitor tool).`

同ファイル Procedure の 5. と 6. を次に置換:

```markdown
5. End the turn. The completion arrives as an agmsg Monitor event; arm one
   single-shot `sleep` background task as a safety net (see Step 4 of
   `commands/codex-exec.md`).
6. After waking on the completion line, confirm whether review is appropriate and
   hand off to `cmux-codex-review`; if the timer fired instead, check the pane with
   `cmux read-screen` and either re-arm or report that the pane is gone.
```

- [ ] **Step 7: 両 guide-ja.md を同じ内容で更新**

`skills/*/references/guide-ja.md` は SKILL.md と見出しが 1:1 対応する日本語訳。Step 6 で
変更した段落に対応する訳文を差し替える。`cmux-codex-wait` / 「短命 watcher」/「ポーリング」
の記述を、「親の常駐 Monitor ストリームが完了通知を受け取って親を起こす」「保険として
単発の sleep タスクを 1 本張る」に書き換える。

- [ ] **Step 8: bin のヘッダコメントと lib の参照先を更新**

```bash
# apps/cmux-codex-review/bin/cmux-codex-review:13
#   旧: 完了通知を注入する（親側の検知は cmux-codex-wait が担う）。cmux 内でのみ動作。
#   新: 完了通知を注入する（親側の検知は agmsg monitor の push が担う）。cmux 内でのみ動作。

# apps/cmux-codex-exec/bin/cmux-codex-exec:8
#   旧: # 完了検知は cmux-codex-wait（短命 watcher）が担う。
#   新: # 完了検知は親の常駐 agmsg monitor が担う（watcher もポーリングも無い）。

# apps/cmux-codex-{review,exec}/bin/codex-parallel-lib.sh:5 (2 ファイル同一に保つ)
#   旧: # 乖離は apps/cmux-codex-review/test/test-cmux-codex-wait.sh の W8 が検出する。
#   新: # 乖離は apps/cmux-codex-review/test/test-monitor-only.sh の M5 が検出する。
```

- [ ] **Step 9: テストを実行して通ることを確認**

Run:
```bash
bash apps/cmux-codex-review/test/test-monitor-only.sh
bash apps/cmux-codex-review/test/test-cmux-codex-review.sh
bash apps/cmux-codex-exec/test/test-cmux-codex-exec.sh
node scripts/check-doc-lang.mjs
```
Expected: 全て PASS / `check-doc-lang: OK`

- [ ] **Step 10: commit**

```bash
git add -A apps/cmux-codex-review apps/cmux-codex-exec
git commit -m "refactor(codex-review,codex-exec): 完了待ちを agmsg monitor の push に置き換え

ポーリング watcher の bin/cmux-codex-wait を両プラグインから削除し、親はターンを
閉じて Monitor イベントで起きる形にした。--surface による即時 gone 検知の代わりに
単発の sleep タスク 1 本を保険として張る。

codex-parallel-lib.sh の同一性検査 (旧 W8) は新テストの M5 として引き継いだ。"
```

---

### Task 2: CLAUDE.md / README.md を実態に合わせる

**Files:**
- Modify: `apps/cmux-codex-review/CLAUDE.md`
- Modify: `apps/cmux-codex-exec/CLAUDE.md`
- Modify: `apps/cmux-codex-review/README.md`
- Modify: `apps/cmux-codex-exec/README.md`
- Modify: `CLAUDE.md` (ルート。`apps/cmux-codex-exec` 行の説明)

**Interfaces:**
- Consumes: Task 1 が確定した「親は Monitor で起きる / タイマーは保険」という契約。
- Produces: なし (文書のみ)。

- [ ] **Step 1: 各 CLAUDE.md の該当記述を洗い出す**

Run: `grep -rn "cmux-codex-wait\|watcher\|ポーリング\|polling" apps/cmux-codex-review/CLAUDE.md apps/cmux-codex-exec/CLAUDE.md apps/cmux-codex-review/README.md apps/cmux-codex-exec/README.md CLAUDE.md`

- [ ] **Step 2: 記述を置き換える**

`cmux-codex-wait` / 「短命 watcher」/「ポーリング」を次の内容に統一する:

- 完了検知は親の常駐 agmsg monitor (SessionStart hook が起動する Monitor ツール)
- 親はターンを閉じて idle になり、Monitor イベントで起きる
- ペイン死亡の即時検知は無い。単発 `sleep` タスク 1 本が保険で、起きたら
  `cmux read-screen` で生存を確認して再武装するか、消滅を報告する
- 前提の根拠として
  `docs/superpowers/specs/2026-08-21-agmsg-monitor-only-design.md` を参照する

ルート `CLAUDE.md` の Apps 表の `apps/cmux-codex-exec` 行「完了を親が agmsg 経由で検知して
cmux-codex-review へ繋ぐ」は実態と合っているので**変更しない**。同表の
`apps/cmux-codex-review` 行「完了を agmsg 経由で親へ通知可」も同様。

- [ ] **Step 3: 検証**

Run: `node scripts/check-doc-lang.mjs`
Expected: `check-doc-lang: OK`

- [ ] **Step 4: commit**

```bash
git add -A apps/cmux-codex-review apps/cmux-codex-exec CLAUDE.md
git commit -m "docs(codex-review,codex-exec): 完了検知の説明を monitor push に更新"
```

---

### Task 3: バージョンを major bump して marketplace を同期

**Files:**
- Modify: `apps/cmux-codex-review/.claude-plugin/plugin.json`
- Modify: `apps/cmux-codex-review/.codex-plugin/plugin.json`
- Modify: `apps/cmux-codex-exec/.claude-plugin/plugin.json`
- Modify: `apps/cmux-codex-exec/.codex-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`

**Interfaces:**
- Consumes: Task 1 / Task 2 の変更が入った状態。
- Produces: なし。

- [ ] **Step 1: 現在のバージョンを確認**

Run: `jq -r '.version' apps/cmux-codex-review/.claude-plugin/plugin.json apps/cmux-codex-review/.codex-plugin/plugin.json apps/cmux-codex-exec/.claude-plugin/plugin.json apps/cmux-codex-exec/.codex-plugin/plugin.json; jq -r '.plugins[] | select(.name|test("codex-(review|exec)")) | "\(.name) \(.version)"' .claude-plugin/marketplace.json`

- [ ] **Step 2: major を 1 上げて 5 箇所に反映**

`bin` の削除と CLI フラグ (`--timeout` / `--interval` / `--liveness-interval` /
`--surface`) の消滅を含む破壊的変更なので major bump。両プラグインとも
`<major+1>.0.0` にし、4 つの plugin.json と marketplace.json の該当 2 エントリを同じ値に
揃える。

- [ ] **Step 3: 同期を検証**

Run:
```bash
for p in cmux-codex-review cmux-codex-exec; do
  a=$(jq -r '.version' "apps/$p/.claude-plugin/plugin.json")
  b=$(jq -r '.version' "apps/$p/.codex-plugin/plugin.json")
  c=$(jq -r --arg n "$p" '.plugins[] | select(.name==$n) | .version' .claude-plugin/marketplace.json)
  echo "$p: $a $b $c"
  [[ "$a" == "$b" && "$b" == "$c" ]] || echo "  MISMATCH"
done
```
Expected: 各プラグインで 3 値が一致し `MISMATCH` が出ないこと

- [ ] **Step 4: commit**

```bash
git add apps/cmux-codex-review/.claude-plugin apps/cmux-codex-review/.codex-plugin \
        apps/cmux-codex-exec/.claude-plugin apps/cmux-codex-exec/.codex-plugin \
        .claude-plugin/marketplace.json
git commit -m "release(codex-review,codex-exec): monitor 専用化に伴う major bump"
```

---

### Task 4: 実ペインでの E2E 確認

**Files:** なし (手動検証)

**Interfaces:**
- Consumes: Task 1-3 の全変更。
- Produces: 検証結果。spec の「テスト」節が E2E を必須としている根拠は、V1 が静的検査
  だけで前提の誤りを見逃した経緯 (spec の背景節)。

- [ ] **Step 1: プラグインを再読み込み**

Run: `bash install.sh` の後、Claude Code セッションで `/reload-plugins`

実行中のセッションは読み込み済みの旧 SKILL.md を保持し続ける。旧本文には削除済みの
`cmux-codex-wait` を呼ぶ手順が含まれるため、再読み込みしないと検証にならない。

- [ ] **Step 2: 通知配線ありでレビューを 1 本流す**

`/codex-review --uncommitted` を、agmsg に join 済みの状態で実行する。

- [ ] **Step 3: 観測項目を確認**

- 親が `cmux-codex-wait` を起動していないこと (background task は `sleep` の 1 本だけ)
- 親がターンを閉じて idle になること
- codex の完了後、親が **Monitor イベントの 1 行**で起き、`token` が一致すること
- 起こされた親がレビュー結果をユーザーへ日本語で報告すること

- [ ] **Step 4: 結果を spec へ追記して commit**

`docs/superpowers/specs/2026-08-21-agmsg-monitor-only-design.md` の「実測結果」表に
E2E の行を追加する (日付・観測・結果)。

```bash
git add docs/superpowers/specs/2026-08-21-agmsg-monitor-only-design.md
git commit -m "docs: codex 系プラグインの monitor 専用化 E2E 結果を追記"
```
