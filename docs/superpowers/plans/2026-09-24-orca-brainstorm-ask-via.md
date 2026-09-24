# brainstorm の質問先 `ask_via` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** brainstorm の design worker が、要件の質問と spec のレビュー依頼を既定で自分の端末で行うようにする。今までの親経由（`orchestration ask` → exit 6）は設定 `ask_via=parent` で選べるように残す。

**Architecture:** 設定の toggle に `ask_via`（terminal|parent）を足し、`orca-start.ts` が brainstorm の指示文をそれで切り替える。terminal の worker は質問のたびに `awaiting-user.ts` で印を書き、`orca-wait.ts` はその印がタスクで最新の子の書き込みである間、人を待っているとみなして停滞の時計を戻す。

**Tech Stack:** TypeScript を node の型除去で実行（Node 22.18+、実行時の npm 依存なし）。テストは bash のスクリプトと Orca CLI のスタブ（`test/lib/orca-stub.sh`）で行う。

**Spec:** `docs/superpowers/specs/2026-09-24-orca-brainstorm-ask-via-design.md`

作業ディレクトリは `apps/orca-team-dispatch-task/`。以下のパスはすべてそこからの相対パスで書く（ルートのファイルは `../../` で示す）。

## Global Constraints

- `any` / `unknown` / `class` / enum / namespace を書かない。JSON は `lib/json.ts` の `Json` と `asObject` などで絞る。型だけの import には `import type` を使う
- 入口は `process.exitCode` で終える。`process.exit` は使用法の誤り（`die`）だけに使う
- `SKILL.md`・`references/*.md`（`*-ja.md` を除く）・`commands/*.md` に日本語の文字を書かない。`guide-ja.md` は SKILL.md の見出しと内容をそのまま写す。bash block は一字一句同じにする（SK8d）
- SKILL.md の bash block に判定を書かない。書いてよいのはガード `: "${VAR:?...}"` と入口の呼び出しだけ。ガードの文言に `'` を書かない。`${VAR:+--flag "$VAR"}` も書かない
- コード中のコメント・コミットメッセージ・CLAUDE.md は日本語で書く。識別子と CLI フラグは英語にする
- biome: single quote、セミコロンは必要な所だけ、行幅 120
- `ask_via` の既定は `terminal`。値は `terminal` と `parent` の 2 つ
- バージョンは 3.9.2 → 3.10.0

## Review Focus

1. **worker が印を書いたあとに無関係な子の書き込みがあった場合**（例: worktree の未コミットのログ更新）。印は効かず、今までどおり 120 分で exit 8 になるべき。→ Task 4 の WT115
2. **人が何時間も答えない場合**（印が古くても最新のまま）。停滞にしてはならない。→ Task 4 の WT116
3. **印があり completion がまだ無い役**。wait の起こし直しが催促の行を回答欄へ打ち込んではならない。→ Task 4 の WT117
4. **`--ask-via` に不正な値が渡された場合**。資源を何も作らずに失敗するべき。→ Task 3 の ST112
5. **`plan` / `direct` に `--ask-via terminal` を渡した場合**。指示文が変わってはならない。→ Task 3 の ST111

---

### Task 1: 設定 toggle `ask_via`

**Files:**
- Modify: `lib/config.ts`（`TOGGLES` と `TOGGLE_KEYS`、直前の既定値コメント）
- Modify: `skills/orca-team-dispatch-task/scripts/config-resolve.ts`（Usage コメント、`flagToToggle`、`requirement`、`resolved`）
- Modify: `skills/orca-team-dispatch-task/scripts/config-edit.ts:12`（扱えるキーのコメントだけ）
- Test: `test/test-config.sh`

**Interfaces:**
- Produces: `config-resolve.ts` が受け取る `--ask-via <terminal|parent>` と、出力 JSON のトップレベル `ask_via`（文字列。常に `terminal` か `parent`）。`config-edit.ts --set ask_via=<v>` / `--unset ask_via`

- [ ] **Step 1: 失敗するテストを書く**

`test/test-config.sh` の CF48 の直後、末尾の `echo "---"` の前に追加する:

```bash
# --- ask_via (brainstorm の質問先) ---
av_() { node "$RESOLVE" --project-root "$PR" "$@" 2>/dev/null | jq -r '.ask_via'; }

# CF49: 既定は terminal（brainstorm の worker は自分の端末で尋ねる。文書が意図していた挙動）
setup
[[ "$(av_)" == terminal ]] && ok "CF49 ask_via の既定は terminal" || fail "CF49 ($(av_))"
teardown

# CF50: parent を選べる。1 回きりの上書きは両方の層より強い
setup
echo '{"ask_via":"parent"}' > "$G"
[[ "$(av_)" == parent && "$(av_ --ask-via terminal)" == terminal ]] \
  && ok "CF50 ask_via の選択と 1 回きりの上書き" || fail "CF50"
teardown

# CF51: 2 値以外は警告して落とす。不正な上書きは使用法の誤り
setup
echo '{"ask_via":"slack"}' > "$G"
err=$(node "$RESOLVE" --project-root "$PR" 2>&1 >/dev/null)
node "$RESOLVE" --project-root "$PR" --ask-via slack >/dev/null 2>&1; rc=$?
[[ "$(av_)" == terminal && "$err" == *"ignoring invalid ask_via 'slack'"* && "$rc" -eq 2 ]] \
  && ok "CF51 不正な ask_via を落とす" || fail "CF51 (rc=$rc err=$err)"
teardown

# CF52: config-edit が ask_via を書き、ask_via だけの利用者にも S0 を二度と尋ねない
setup
node "$EDIT" --config "$G" --set ask_via=parent >/dev/null 2>&1
[[ "$(jq -r '.ask_via' "$G")" == parent \
   && "$(node "$RESOLVE" --project-root "$PR" 2>/dev/null | jq -r '.configured')" == true ]] \
  && ok "CF52 config-edit が ask_via を扱う" || fail "CF52"
teardown
```

- [ ] **Step 2: テストを走らせて失敗を確かめる**

Run: `bash test/test-config.sh 2>&1 | grep -E 'CF49|CF50|CF51|CF52'`
Expected: 4 件とも `FAIL`（`ask_via` が `null` になる / `unknown option` になる / config-edit が不明なキーとして拒む）

- [ ] **Step 3: 実装する**

`lib/config.ts` の既定値コメントに 1 行足し、`TOGGLES` と `TOGGLE_KEYS` に加える:

```ts
//   ask_via     … terminal（brainstorm の design は自分の端末で尋ね、ターンを終えて答えを待つ。parent は
//                 `orchestration ask` で親に取り次がせる。**既定だけ例外** — 設定より前のコードは parent だったが、
//                 文書が意図していた terminal を既定にする）
export const TOGGLES = {
  review_mode: { values: ['on', 'off'], fallback: 'off' },
  phase_b: { values: ['on', 'off'], fallback: 'off' },
  integration: { values: ['merge', 'pr'], fallback: 'merge' },
  setup: { values: ['skip', 'run'], fallback: 'skip' },
  design_mode: { values: ['direct', 'plan', 'brainstorm'], fallback: 'direct' },
  ask_via: { values: ['terminal', 'parent'], fallback: 'terminal' },
} as const
export type Toggle = keyof typeof TOGGLES
export const TOGGLE_KEYS: Toggle[] = ['review_mode', 'phase_b', 'integration', 'setup', 'design_mode', 'ask_via']
```

`config-resolve.ts`:
- Usage コメントの `[--design-mode <direct|plan|brainstorm>]` の次の行に `//                               [--ask-via <terminal|parent>]` を足す
- `flagToToggle` に `'--ask-via': 'ask_via',` を足す
- `requirement` に `ask_via: 'terminal or parent',` を足す
- `const designMode = resolveToggle('design_mode')` の次に `const askVia = resolveToggle('ask_via')` を足す
- `resolved` の `design_mode: designMode,` の次に `ask_via: askVia,` を足す

`config-edit.ts:12` のコメントを `//   review_mode / phase_b / integration / setup / design_mode / ask_via   set / unset` にする（set/unset は `isToggle` の共通経路なのでコードは変えない）。

- [ ] **Step 4: テストを走らせて通ることを確かめる**

Run: `bash test/test-config.sh 2>&1 | tail -3 && pnpm --filter @tanaka-yui/orca-team-dispatch-task check`
Expected: `failures: 0`。型検査と biome も通る

- [ ] **Step 5: Commit**

```bash
git add lib/config.ts skills/orca-team-dispatch-task/scripts/config-resolve.ts skills/orca-team-dispatch-task/scripts/config-edit.ts test/test-config.sh
git commit -m "feat(orca-dispatch): brainstorm の質問先を選ぶ設定 ask_via を足す"
```

---

### Task 2: 人待ちの印を書く入口 `awaiting-user.ts`

**Files:**
- Create: `skills/orca-team-dispatch-task/scripts/awaiting-user.ts`
- Test: `test/test-report-status.sh`

**Interfaces:**
- Produces: `node awaiting-user.ts --role-dir <dir>`。`<dir>/awaiting-user.json` に `{"asked_at": <epoch 秒>}` を原子的に書く。exit 0 = 書いた / 1 = 書けなかった / 2 = 使用法の誤り。Task 3 は指示文でこの path を、Task 4 はファイル名 `awaiting-user.json` を使う

- [ ] **Step 1: 失敗するテストを書く**

`test/test-report-status.sh` の末尾の `echo "---"` の前に追加する:

```bash
# AW1: 端末で人に尋ねる worker が、答えを待つ印を書く（orca-wait が停滞の時計を戻す根拠）
AW="$P/skills/orca-team-dispatch-task/scripts/awaiting-user.ts"
node "$AW" --role-dir "$SD/roles/design" >/dev/null 2>&1; rc=$?
jq -e '.asked_at | type == "number"' "$SD/roles/design/awaiting-user.json" >/dev/null 2>&1 && [[ "$rc" -eq 0 ]] \
  && ok "AW1 答えを待つ印を書く" || fail "AW1 (rc=$rc)"
# AW2: 引数が無い・未知のオプションは使用法の誤り
node "$AW" >/dev/null 2>&1; a=$?
node "$AW" --bogus x >/dev/null 2>&1; b=$?
[[ "$a" -eq 2 && "$b" -eq 2 ]] && ok "AW2 使用法の誤り" || fail "AW2 (a=$a b=$b)"
# AW3: 書けない場所では 1（黙って成功しない）
node "$AW" --role-dir /dev/null/x >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 1 ]] && ok "AW3 書けなければ 1" || fail "AW3 (rc=$rc)"
```

- [ ] **Step 2: テストを走らせて失敗を確かめる**

Run: `bash test/test-report-status.sh 2>&1 | grep AW`
Expected: 3 件とも `FAIL`（スクリプトが無い）

- [ ] **Step 3: 実装する**

`skills/orca-team-dispatch-task/scripts/awaiting-user.ts`:

```ts
// 端末でユーザーに尋ね、ターンを終えて答えを待つ直前に worker が呼ぶ（ask_via=terminal の brainstorm）。
//
// Usage: node awaiting-user.ts --role-dir <dir>
// Exit: 0 = 書いた / 1 = 書けなかった / 2 = 使用法エラー
//
// ★ **Orca の agentWait はこの待ちを拾わない**（実測 2026-09-24、logi-app: 端末に質問を書いて `❯` で待つ
//   design の worker-show は state=ready・agentWait=null だった）。印が無いと、答えを待つ間も停滞の時計が
//   進み、120 分で exit 8 になる。orca-wait.ts は、この印がそのタスクで子が最後に書いたものである間、
//   人を待っているとみなす
// ★ status.json を流用しない。merge / pr / recover / Step 3.5 の起動判定が読んでおり、値を増やすと波及する
// ★ 消す手順は持たない。答えのあとの書き込み（spec / plan / commit / status など）で自然に古くなる
import { die, log } from '../../../lib/cli.ts'
import { writeAtomic } from '../../../lib/fs.ts'
import { nowSeconds } from '../../../lib/sys.ts'

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const NAME = 'awaiting-user'

const main = (argv: string[]): number => {
  const [flag = '', roleDir = '', ...rest] = argv
  if (flag !== '--role-dir' || roleDir === '' || rest.length > 0) return die(NAME, 'usage: --role-dir <dir>')
  try {
    mkdirSync(roleDir, { recursive: true })
  } catch {
    log(NAME, `cannot create the role directory: ${roleDir}`)
    return 1
  }
  const file = join(roleDir, 'awaiting-user.json')
  if (!writeAtomic(file, `${JSON.stringify({ asked_at: nowSeconds() })}\n`)) {
    log(NAME, `failed to write ${file}`)
    return 1
  }
  return 0
}

process.exitCode = main(process.argv.slice(2))
```

- [ ] **Step 4: テストを走らせて通ることを確かめる**

Run: `bash test/test-report-status.sh 2>&1 | tail -3 && pnpm --filter @tanaka-yui/orca-team-dispatch-task check`
Expected: `failures: 0`、check も通る

- [ ] **Step 5: Commit**

```bash
git add skills/orca-team-dispatch-task/scripts/awaiting-user.ts test/test-report-status.sh
git commit -m "feat(orca-dispatch): 端末で答えを待つ印を書く awaiting-user.ts を足す"
```

---

### Task 3: `orca-start.ts` の `--ask-via` と brainstorm の指示文

**Files:**
- Modify: `bin/orca-start.ts`（Usage コメント 1-6 行目、`Context` 型、`renderSpec` の brainstorm 部分 360-390 行目付近、引数解析 900-945 行目付近、`overrides` 1030 行目付近、`mode` 1046 行目付近、`context` 1199-1212 行目付近）
- Test: `test/test-start.sh`

**Interfaces:**
- Consumes: Task 1 の `config-resolve.ts --ask-via` と出力の `ask_via`。Task 2 の `skills/orca-team-dispatch-task/scripts/awaiting-user.ts --role-dir <dir>`
- Produces: `orca-start.ts --ask-via <terminal|parent>`（どの phase でも、`--resume` でも受け付ける）。Task 5 の文書がこのフラグを載せる

- [ ] **Step 1: 失敗するテストを書く**

(a) `test/test-start.sh` の ST62 は親経由の文面を固定しているので、parent を明示するように直す。設定行を次にし、コメントの 3 行目以降を置き換える:

```bash
# ST62: brainstorm × ask_via=parent は superpowers の skill を名指しし、**質問の出し方まで指定する**。
#       worker は質問を印字して止まるのではなく `orchestration ask` を使い、親は
#       `orchestration reply` で答える。既定の terminal は ST109 が固定する
setup
mkdir -p "$ORCA_DISPATCH_CONFIG_HOME"; printf '%s\n' '{"design_mode":"brainstorm","ask_via":"parent"}' > "$ORCA_DISPATCH_CONFIG_HOME/config.json"
```

（アサーションの行は変えない。）

(b) 末尾の `echo "---"` の前（ST108 の if ブロックのあと）に追加する:

```bash
# ── brainstorm の質問先（ask_via）──────────────────────────────────────
# ★ 2026-09-24 の logi-app: 指示文が `orchestration ask` を指示していたので、brainstorming の質問が全部
#   exit 6 で親に届き、親が中継していた。文書の意図は「worker の端末で直接尋ねる」だった
bs_only() { mkdir -p "$ORCA_DISPATCH_CONFIG_HOME"
            printf '%s\n' '{"design_mode":"brainstorm"}' > "$ORCA_DISPATCH_CONFIG_HOME/config.json"; }

# ST109: 既定（terminal）は端末で尋ね、印を書いてからターンを終える。ask は使わせない
setup; bs_only; start >/dev/null 2>&1; sp=$(spec); miss=""
[[ "$sp" == *'Ask the user in this terminal'* ]] || miss="$miss [terminal]"
[[ "$sp" == *'awaiting-user.ts'* ]] || miss="$miss [marker]"
[[ "$sp" == *"--role-dir $R/.dispatch/s/roles/design"* ]] || miss="$miss [role-dir]"
[[ "$sp" == *'only place where you end your turn to wait'* ]] || miss="$miss [only-here]"
[[ "$sp" == *'Do not use `orchestration ask`'* ]] || miss="$miss [no-ask]"
[[ "$sp" == *'Ask through `orchestration ask`'* ]] && miss="$miss [parent-text]"
[[ "$sp" == *'one question at a time'* ]] || miss="$miss [one-at-a-time]"
[[ -z "$miss" ]] && ok "ST109 brainstorm × terminal は端末で尋ねる" || fail "ST109:$miss"; teardown

# ST110: --ask-via parent は 1 回きりの上書きとして今の文面に戻す
setup; bs_only; start --ask-via parent >/dev/null 2>&1; sp=$(spec); miss=""
[[ "$sp" == *'Ask through `orchestration ask`'* ]] || miss="$miss [parent-text]"
[[ "$sp" == *'awaiting-user.ts'* ]] && miss="$miss [marker]"
[[ "$sp" == *'Ask the user in this terminal'* ]] && miss="$miss [terminal]"
[[ -z "$miss" ]] && ok "ST110 --ask-via parent は親経由で尋ねる" || fail "ST110:$miss"; teardown

# ST111: ★ **ask_via は brainstorm の design にだけ効く。**plan と direct の指示文は変わらない
bad=""
for mode in plan direct; do
  setup; start --design-mode "$mode" --ask-via terminal >/dev/null 2>&1; sp=$(spec)
  [[ "$sp" == *'awaiting-user.ts'* || "$sp" == *'Ask the user in this terminal'* ]] && bad="$bad [$mode]"
  teardown
done
[[ -z "$bad" ]] && ok "ST111 ask_via は plan と direct を変えない" || fail "ST111:$bad"

# ST112: 不正な値では何も作らない（設定の解決で止まる）
setup; start --ask-via slack >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 1 ]] && ! grep -q 'worktree create\|worker-start' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST112 不正な ask_via で何も作らない" || fail "ST112 (rc=$rc)"; teardown
```

- [ ] **Step 2: テストを走らせて失敗を確かめる**

Run: `bash test/test-start.sh 2>&1 | grep -E 'ST62|ST109|ST110|ST111|ST112'`
Expected: ST62 は、既定がまだ無く parent の文面のままなので PASS。ST109・ST110・ST111・ST112 は `FAIL`（`unknown option: --ask-via`、または文面が無い）

- [ ] **Step 3: 実装する**

1. Usage コメントの 4 行目を `//        [--phase design|exec] [--design-mode direct|plan|brainstorm] [--ask-via terminal|parent] [--integration merge|pr]` にし、5 行目の `--resume` の行を `[--design-mode ...] [--ask-via ...]` にする
2. `Context` 型の `designMode: string` の次に `askVia: string` を足す
3. 引数解析で `let designMode = ''` の次に `let askVia = ''` を足す。受け付けるフラグの配列の `'--design-mode',` の次に `'--ask-via',` を足す。`if (flag === '--design-mode') designMode = value` の次に `if (flag === '--ask-via') askVia = value` を足す
4. `overrides` の `if (designMode !== '') ...` の次に `if (askVia !== '') overrides.push('--ask-via', askVia)` を足す（検証は config-resolve に任せる。不正値は resolve の失敗として rc 1 になる。ST93 と同じ経路）
5. `const mode = string(config.design_mode) || 'direct'` の次に `const askVia = string(config.ask_via) || 'terminal'` を足す。ただし 3 の `askVia` と名前がぶつかるので、ここは `const ask = ...` とし、`context` に `askVia: ask,` を足す
6. `renderSpec` の先頭の `const qReportStatus = ...` の次に `const qAwaiting = shellQuote(join(SCRIPTS, 'awaiting-user.ts'))` を足す
7. `renderSpec` の brainstorm 部分（`if (context.designMode === 'brainstorm') {` の中）で、`approach` のテンプレートにある「`**Ask through \`orchestration ask\`...`」から「`...stop the dispatch.`」までの 2 段落を、次の変数 `asking` に置き換える。`afterPlan` の定義の次に書く:

```ts
    // ★ 2026-09-24: 質問の出し方は ask_via で決める。terminal（既定）は worker 自身の端末で尋ね、印を書いてから
    //   ターンを終える（Orca の agentWait はこの待ちを拾わないので、印が orca-wait の停滞の時計を戻す）。
    //   ターンを終えてよいのはここだけ — 完了の申告以降とレビューの verdict 待ちはターン内で待ち続ける
    const asking =
      context.askVia === 'parent'
        ? `**Ask through \`orchestration ask\`, not by printing a question and stopping.** The parent
relays it to a person and sends their answer back; a question you only print is read by
nobody. Ask one question at a time, as the skill does: each call blocks until someone answers.
The skill's request for the user to review the written spec goes through the same call.

If nobody ever answers, that call is where you will be waiting — that is expected, and the
person watching decides whether to answer or to stop the dispatch.`
        : `**Ask the user in this terminal.** A person is watching it. Whenever you need an answer —
each question the brainstorming skill asks, and its request for the user to review the
written spec — first record that you are waiting:

     node ${qAwaiting} --role-dir ${qRoleDir}

then put the question at the end of your reply and end your turn. The answer arrives as the
next message typed into this terminal. Ask one question at a time, as the skill does.

Do not use \`orchestration ask\`: in this dispatch the parent does not relay questions.

**This is the only place where you end your turn to wait.** From step C of the STATUS
PROTOCOL on, and while you wait for a review verdict, keep waiting inside your turn as
those steps say.

If nobody answers, that is expected: the person watching decides whether to answer or to
stop the dispatch.`
```

`approach` のテンプレートは、置き換えた 2 段落の位置に `${asking}` を置く。前後の空行はそのまま残す（`${afterPlan}` の後の空行、`${asking}` の後の空行、`If either skill is not installed ...` の段落）。

- [ ] **Step 4: テストを走らせて通ることを確かめる**

Run: `bash test/test-start.sh 2>&1 | tail -3 && pnpm --filter @tanaka-yui/orca-team-dispatch-task check`
Expected: `failures: 0`（ST62・ST94-99 を含む既存テストも通る）、check も通る

- [ ] **Step 5: Commit**

```bash
git add bin/orca-start.ts test/test-start.sh
git commit -m "feat(orca-dispatch): brainstorm の worker を既定で自分の端末で尋ねさせる"
```

---

### Task 4: `orca-wait.ts` が端末の人待ちを停滞にしない

**Files:**
- Modify: `bin/orca-wait.ts`（`taskLastChange` 216-252 行目付近、`markHuman` の近く、`checkStall` 329-360 行目付近、`State` 型 29-43 行目、State の初期化 995-1010 行目付近）
- Test: `test/test-wait.sh`

**Interfaces:**
- Consumes: Task 2 の `<statusDir>/roles/<role>/awaiting-user.json`（中身は読まず、mtime だけを使う）
- Produces: log 行 `orca-wait: <role> of <slug> is waiting for an answer in its terminal <handle>`（stderr、印の mtime ごとに 1 回）。Task 5 の文書がこの文言を引用する

- [ ] **Step 1: 失敗するテストを書く**

`test/test-wait.sh` の末尾の `echo "---"` の前に追加する。`old`・`STALL`・`typed` は既存の定義を使う（どれもファイルの前半で定義済み）:

```bash
# ── 端末で人の答えを待つ役（ask_via=terminal の brainstorm）──
# ★ Orca の agentWait はターンを終えて端末で待つ状態を拾わない（実測 2026-09-24、logi-app）。
#   worker が書く awaiting-user.json が、タスクで子が最後に書いたものである間は人を待っているとみなす
marker() { echo '{"asked_at":1}' > "$SD/roles/design/awaiting-user.json"; }

# WT114: 印が最新なら停滞ではない。human.json を残し、どの端末が待っているかを 1 回だけ言う
setup; old "$SD/run.json" "$SD/roles/design/status.json"; marker
err=$(ORCA_STALL_AFTER_SECONDS=$STALL node "$P/bin/orca-wait.ts" --status-dir "$SD" --max-waits 2 \
        --timeout-ms 1 2>&1 >/dev/null); rc=$?
b=$(basename "$SD")
n=$(grep -c "design of $b is waiting for an answer in its terminal term_w" <<<"$err")
[[ "$rc" -eq 3 && "$n" -eq 1 && "$(jq -r '.last_human_at' "$SD/human.json" 2>/dev/null)" =~ ^[0-9]+$ ]] \
  && ok "WT114 端末で答えを待つ役は停滞ではない" || fail "WT114 (rc=$rc n=$n)"; teardown

# WT115: ★ 印のあとに子の書き込みがあれば印は古い。今までどおり停滞として知らせる
setup; marker; old "$SD/run.json" "$SD/roles/design/awaiting-user.json"
touch -t 202001010100 "$SD/roles/design/status.json"
ORCA_STALL_AFTER_SECONDS=$STALL w >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 8 ]] && ok "WT115 印より新しい書き込みがあれば停滞" || fail "WT115 (rc=$rc)"; teardown

# WT116: ★ 答えに何時間かかっても停滞にしない（印が古くても、最新である限り人を待っている）
setup; marker; old "$SD/run.json" "$SD/roles/design/status.json" "$SD/roles/design/awaiting-user.json"
ORCA_STALL_AFTER_SECONDS=$STALL w >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 3 ]] && ok "WT116 古い印でも最新なら停滞ではない" || fail "WT116 (rc=$rc)"; teardown

# WT117: ★ 答えを待つ役（completion がまだ無い）には催促の行を打たない。打てば回答欄に入る
setup; marker; echo '{"ok":true,"result":{}}' > "$ORCA_STUB_DIR/terminal_send"
ORCA_WAKE_INTERVAL_SECONDS=0 node "$P/bin/orca-wait.ts" --status-dir "$SD" \
  --max-waits 2 --timeout-ms 1 >/dev/null 2>&1
[[ "$(typed)" -eq 0 ]] && ok "WT117 答えを待つ役は叩かない" || fail "WT117 (typed=$(typed))"; teardown
```

- [ ] **Step 2: テストを走らせて失敗を確かめる**

Run: `bash test/test-wait.sh 2>&1 | grep -E 'WT11[4-7]'`
Expected: WT114 は FAIL（rc=8、log が無い）。WT116 は FAIL（rc=8）。WT115 と WT117 は今のコードでも PASS する（回帰の固定のため）

- [ ] **Step 3: 実装する**

1. `taskLastChange` を `workerLastChange` に改名する。役ごとのファイル一覧を `['status.json', 'result.md', 'completion.json', 'awaiting-user.json']` にし、status dir 直下の一覧を `['spec.md', 'plan.md']` にする（`human.json` を外す）。直前のコメントに次を足す:

```ts
// ★ 子の最後の書き込み。**human.json は含めない** — 親が毎周書くので、含めると awaiting-user.json が
//   2 周目から「最新」でなくなる。awaiting-user.json は子が書くので含める
```

2. その直後に `taskLastChange` と `awaitingUser` を置く:

```ts
// 停滞の時計の起点。人とのやりとり（human.json）は親が書くが、4-2 の例外として数える
const taskLastChange = (statusDir: string): number =>
  Math.max(workerLastChange(statusDir), fileMtime(join(statusDir, 'human.json')))
// ★ **端末で人の答えを待つ役。**Orca の agentWait はターンを終えて端末で待つ状態を拾わない（実測 2026-09-24、
//   logi-app: state=ready・agentWait=null）。ask_via=terminal の worker は尋ねる前に awaiting-user.json を書く。
//   それがタスクで子が最後に書いたものである間は人を待っている。答えのあとに何か書けば自然に外れる
const awaitingUser = (statusDir: string): { role: string; at: number } | null => {
  let roles: string[] = []
  try {
    roles = readdirSync(join(statusDir, 'roles'))
  } catch {
    return null
  }
  const latest = workerLastChange(statusDir)
  let found: { role: string; at: number } | null = null
  for (const role of roles) {
    const at = fileMtime(join(statusDir, 'roles', role, 'awaiting-user.json'))
    if (at > 0 && at >= latest && (found === null || at > found.at)) found = { role, at }
  }
  return found
}
```

3. `State` 型の `unconfirmedSeen: Set<string>` の次に `awaitingSeen: Map<string, number>` を足し、初期化の `unconfirmedSeen: new Set(),` の次に `awaitingSeen: new Map(),` を足す

4. `markHuman` の直後に置く:

```ts
// 端末で待っている役を、印ごとに 1 回だけ言う（exit 3 の進捗報告で、親がどの端末に答えるかを伝えられるように）
const noteAwaiting = (state: State, statusDir: string, asking: { role: string; at: number }): void => {
  const key = `${statusDir}|${asking.role}`
  if (state.awaitingSeen.get(key) === asking.at) return
  state.awaitingSeen.set(key, asking.at)
  const terminal = string(get(read(statusDir, 'workers.json'), 'roles', asking.role, 'terminal')) || 'none'
  log(NAME, `${asking.role} of ${basename(statusDir)} is waiting for an answer in its terminal ${terminal}`)
}
```

5. `checkStall` の `if (taskSettled(statusDir)) continue` の直後に次を足す（`let last = taskLastChange(statusDir)` より前）:

```ts
    const asking = awaitingUser(statusDir)
    if (asking !== null) {
      markHuman(statusDir)
      noteAwaiting(state, statusDir, asking)
    }
```

- [ ] **Step 4: テストを走らせて通ることを確かめる**

Run: `bash test/test-wait.sh 2>&1 | tail -3 && pnpm --filter @tanaka-yui/orca-team-dispatch-task check`
Expected: `failures: 0`（WT84-101 を含む既存の停滞テストも通る）、check も通る

- [ ] **Step 5: Commit**

```bash
git add bin/orca-wait.ts test/test-wait.sh
git commit -m "feat(orca-dispatch): 端末で答えを待つ worker を停滞とみなさない"
```

---

### Task 5: 文書・文書テスト・バージョン

**Files:**
- Modify: `skills/orca-team-dispatch-task/SKILL.md`
- Modify: `skills/orca-team-dispatch-task/references/guide-ja.md`
- Modify: `CLAUDE.md`（プラグインのもの）
- Modify: `README.md`（該当があれば）
- Modify: `test/test-docs.sh`（SK27 の envs、新しい SK31）
- Modify: `.claude-plugin/plugin.json`、`.codex-plugin/plugin.json`、`../../.claude-plugin/marketplace.json`

**Interfaces:**
- Consumes: Task 1 の `ask_via`、Task 3 の `--ask-via`、Task 2 の `awaiting-user.json`、Task 4 の log 行

- [ ] **Step 1: 失敗する文書テストを書く**

(a) SK27 の `envs=(...)` の 2 行目を `DESIGN_MODE=plan ASK_VIA=terminal INTEGRATION=merge ROLE=design TERM_HANDLE=term_x AGENT=claude` にする。

(b) SK30 の直後に追加する:

```bash
# SK31: brainstorm の質問先（ask_via）は Step 1b で毎回尋ね、Step 2 のガードが省略を実行不能にする。
#       2026-09-24 の logi-app: 文書は「端末で尋ねる」、コードは「親に取り次がせる」と食い違っていた
bad=""
for f in "$S" "$G"; do
  n=$(basename "$f")
  sed -n '/^## Step 1b: /,/^## Step 2: /p' "$f" | grep -q 'ASK_VIA' || bad="$bad [step1b:$n]"
  grep -q 'ASK_VIA:?' "$f" || bad="$bad [guard:$n]"
  grep -q -- '--ask-via "\$ASK_VIA"' "$f" || bad="$bad [flag:$n]"
  grep -q '^| `ask_via` |' "$f" || bad="$bad [config-row:$n]"
  grep -q 'awaiting-user.json' "$f" || bad="$bad [marker:$n]"
  grep -q 'is waiting for an answer in its terminal' "$f" || bad="$bad [log-line:$n]"
done
grep -q 'Under `brainstorm` it uses `orchestration ask`' "$S" && bad="$bad [old-limitation]"
[[ -z "$bad" ]] && ok "SK31 brainstorm の質問先を毎回尋ねる" || fail "SK31:$bad"
```

- [ ] **Step 2: テストを走らせて失敗を確かめる**

Run: `bash test/test-docs.sh 2>&1 | grep -E 'SK27|SK31'`
Expected: SK31 は FAIL。SK27 は PASS（まだどの block も ASK_VIA を使っていない）

- [ ] **Step 3: SKILL.md を直す**（英語のみ。以下の文面をそのまま使う）

1. **Configuration の設定表**: `design_mode` の行の `brainstorm` の説明にある「works the request through with whoever is watching its terminal」を「works the request through with a person — in its own terminal or through you, as `ask_via` says —」にする。表の最後に次の行を足す:

```markdown
| `ask_via` | `terminal` — a `brainstorm` design asks its questions, and its request to review the written spec, in its own terminal and waits there for the answer | `parent` — it asks through `orchestration ask`, and the wait exits 6 so that you relay the question. **The one default that is not the old behaviour**: `terminal` is what these documents always described |
```

表の直前の文「**both default to what a dispatch did before they existed**」はそのまま残す。例外は行の中で言っている。

2. **Choosing how `design` starts**: 「**`brainstorm` needs a person.**」段落の直後に次の段落を足す:

```markdown
**`ask_via` decides where that person is.** With `terminal`, the worker writes each question
into its own terminal and ends its turn; whoever answers types into that terminal, and nothing
goes through you. Before it ends such a turn it runs `awaiting-user.ts`, which leaves
`roles/design/awaiting-user.json`: while that is the newest thing the task's workers wrote,
the wait counts the task as waiting on a person, never as stalled. With `parent`, the worker
asks through `orchestration ask` and the wait exits 6 so that you can relay it.
```

その次の段落「A `brainstorm` worker is told not to stall if nobody answers, and to say so in `result.md` rather than inventing its own version of the skill when it is not installed.」は次の文に置き換える:

```markdown
A `brainstorm` worker waits for as long as nobody answers — whether to answer or to stop it is
the user's decision — and when a skill is not installed it says so in `result.md` rather than
inventing its own version of it.
```

3. **Step 1**: 「does all of that with the user in its own terminal.」を「does all of that with the user, in its own terminal or through you as `ask_via` says.」にする

4. **Step 1b**:
   - 冒頭の config-resolve の説明「they are the `design_mode` and `integration` fields of what this prints」を「they are the `design_mode`, `integration` and `ask_via` fields of what this prints」にする
   - 「three when the integration question below shares it」を「two, since the integration and `ask_via` questions below share it」にする
   - 表の `brainstorm` 行の「settle the open questions with whoever is watching its terminal」を「settle the open questions with the user where `ask_via` says」にする
   - 取り込み方の段落の最後の文「Because this question takes one of the four places in the call, the first call carries at most three task questions — twelve tasks.」を削り、その段落のあと（「Keep each task's answer as ...」の前）に次の 2 段落を足す:

```markdown
**The same call also asks where `brainstorm` tasks ask their questions.** Add one single-select
question with two answers: **In each worker's terminal** — the worker writes its questions,
and its request to review the written spec, into its own terminal and waits there, so you
answer each task in its terminal — and **Through the parent** — the worker asks through
`orchestration ask`, the wait exits 6, and the question is relayed here. Mark the configured
`ask_via` as the recommendation. Keep the answer as `ASK_VIA`, `terminal` or `parent`, and pass
it in Step 2 for every task; it changes nothing for a task started on `plan`.

Because these two questions take two of the four places in the call, the first call carries at
most two task questions — eight tasks.
```

5. **Step 2 の block**: `: "${INTEGRATION:?...}"` の次の行に `: "${ASK_VIA:?set ASK_VIA to the Step 1b answer: terminal or parent}"` を足す。呼び出しの 2 行目を `  --design-mode "$DESIGN_MODE" --ask-via "$ASK_VIA" --integration "$INTEGRATION" \` にする。block の後の段落「`DESIGN_MODE`, `INTEGRATION` and `RUN` are among them」を「`DESIGN_MODE`, `ASK_VIA`, `INTEGRATION` and `RUN` are among them」にする。`--resume` の例の `--design-mode "$DESIGN_MODE"` の後ろに ` --ask-via "$ASK_VIA"` を足す

6. **Step 3**:
   - exit 表の 6 の行を次にする:

```markdown
| 6 | A worker asked a person through `orchestration ask` and is blocked on the answer — under `ask_via=parent`, or a worker that asked that way although it was not told to | Relay the question to the user verbatim, run the `reply` command the wait printed with their answer, then run the same wait again. Nothing failed; the worker resumes on the reply |
```

   - exit 表の 8 の行の「none of its roles is waiting on a person」を「none of its roles is waiting on a person — through Orca's own observation or its `awaiting-user.json`」にする
   - 「On exit 6 nothing has gone wrong.」の段落の前に次の段落を足す:

```markdown
A `brainstorm` worker under `ask_via=terminal` asks in its own terminal, so its questions never
reach this wait. The wait logs `<role> of <slug> is waiting for an answer in its terminal
<handle>` once per question; when you report progress on exit 3, tell the user which terminals
are waiting for them. Nothing is typed into a worker that is waiting for an answer: the wait
re-types only into a worker holding an unanswered completion.
```

7. **Known limitations**: 質問の行を次にする:

```markdown
| A worker asks a person only when its `design_mode` told it to, and it waits until someone answers | Under `direct` and `plan` it is told to fail with a reason in `result.md` instead; read it and dispatch again. Under `brainstorm` with `ask_via=terminal` it asks in its own terminal and waits there: answer it in that terminal. With `ask_via=parent` it uses `orchestration ask`, the wait exits 6 with the question and the `reply` command, and the worker resumes only once you run that command |
```

8. **State on disk**: 「`roles/<role>/stopped.json` for a role the user stopped,」の後に「`roles/design/awaiting-user.json` when a `brainstorm` design last asked in its terminal,」を足す

- [ ] **Step 4: guide-ja.md を同じ位置で直す**（bash block は SKILL.md と一字一句同じにする）

1. 65 行目の design_mode の行: 「その端末を見ている人と依頼を詰める」を「`ask_via` に従い、自分の端末かあなた経由で人と依頼を詰める」にする。表の最後に足す:

```markdown
| `ask_via` | `terminal` — `brainstorm` の design は質問と、書いた spec のレビュー依頼を自分の端末で行い、そこで答えを待つ | `parent` — `orchestration ask` で尋ね、待機が終了コード 6 で抜けてあなたが質問を取り次ぐ。**既定が以前の挙動でない唯一の設定**: `terminal` はこれらの文書が一貫して書いてきた挙動である |
```

2. 「`brainstorm` には人が要る」段落の直後に足す:

```markdown
**その人がどこに居るかは `ask_via` が決める。**`terminal` では、worker は質問を自分の端末に書いてターンを
終える。答える人はその端末に打ち込み、あなたを経由するものは無い。そのようなターンを終える前に worker は
`awaiting-user.ts` を実行して `roles/design/awaiting-user.json` を残す。それがタスクの worker が最後に書いた
ものである間、待機はそのタスクを人待ちとして数え、停滞とはしない。`parent` では、worker は
`orchestration ask` で尋ね、待機が終了コード 6 で抜けてあなたが取り次ぐ。
```

198-199 行目の段落を次にする:

```markdown
`brainstorm` の worker は、誰も答えない間はいつまでも待つ（答えるか止めるかはユーザーが決める）。skill が
入っていなければ、自分流の代替を発明せず `result.md` にそう書く。
```

3. 387 行目: 「それを自分の端末でユーザーと行う。」を「それを `ask_via` に従い、自分の端末かあなた経由でユーザーと行う。」にする

4. Step 1b:
   - 冒頭の config-resolve の説明で `design_mode` と `integration` を挙げている箇所に `ask_via` を加える
   - 421 行目の「（下の取り込み方の質問と同じ呼び出しに入れるときは 3 問）」を「（下の取り込み方と `ask_via` の質問が同じ呼び出しに入るので 2 問）」にする
   - 427 行目の表の「端末を見ている人と未解決の論点を詰め」を「`ask_via` が示す場所でユーザーと未解決の論点を詰め」にする
   - 443 行目付近の「入るタスクの質問は 3 問、12 タスクまでになる。」を含む文を削り、SKILL.md の 4 と同じ位置に足す:

```markdown
**同じ呼び出しで、`brainstorm` のタスクがどこで質問するかも尋ねる。**2 つの答えを持つ単一選択の質問を
1 つ足す: **各 worker の端末** — worker は質問と、書いた spec のレビュー依頼を自分の端末に書いてそこで待つので、
各タスクにはその端末で答える — と **親経由** — worker は `orchestration ask` で尋ね、待機が終了コード 6 で
抜けて、ここで取り次ぐ。設定の `ask_via` を推奨として示す。答えは `ASK_VIA`（`terminal` か `parent`）として
持ち、Step 2 で全タスクに渡す。`plan` で始めるタスクには何も変えない。

この 2 問が呼び出しの 4 枠のうち 2 つを使うので、最初の呼び出しに入るタスクの質問は 2 問、8 タスクまでになる。
```

5. Step 2: bash block を SKILL.md と同じにする（ガード行と `--ask-via "$ASK_VIA"`）。block の後の文で `DESIGN_MODE` を挙げている箇所に `ASK_VIA` を加え、`--resume` の例に ` --ask-via "$ASK_VIA"` を足す

6. Step 3:
   - 591 行目の 6 の行を次にする:

```markdown
| 6 | worker が `orchestration ask` で人へ質問し、回答待ちでブロックしている — `ask_via=parent` のとき、または指示されていないのにその方法で尋ねた worker | 質問をそのままユーザーへ取り次ぎ、待機が出力した `reply` コマンドに回答を入れて実行し、同じ待機をもう一度走らせる。失敗ではない。worker は reply で再開する |
```

   - 592 行目の「そのどの役も人を待っていない」を「そのどの役も人を待っていない（Orca 自身の観測でも `awaiting-user.json` でも）」にする
   - 596 行目の「終了コード 6 では何も壊れていない。」の段落の前に足す:

```markdown
`ask_via=terminal` の `brainstorm` の worker は自分の端末で尋ねるので、その質問がこの待機に届くことは無い。
待機は質問ごとに 1 回、`<role> of <slug> is waiting for an answer in its terminal <handle>` を log に出す。
終了コード 3 で進捗を報告するときは、どの端末がユーザーの答えを待っているかを伝える。答えを待っている
worker には何も打ち込まない — 待機が打ち直すのは、返事の無い完了の申告を抱えた worker だけである。
```

7. 1058 行目の既知の制限の行を次にする:

```markdown
| worker が人へ尋ねるのは `design_mode` がそう指示したときだけで、誰かが答えるまで待つ | `direct` と `plan` では代わりに `result.md` へ理由を書いて失敗として終了するよう指示してある。読んで再度 dispatch する。`brainstorm` で `ask_via=terminal` なら自分の端末で尋ねてそこで待つので、その端末で答える。`ask_via=parent` なら `orchestration ask` を使い、待機が終了コード 6 で質問と `reply` コマンドを出す。worker が再開するのはそのコマンドを実行したときだけである |
```

8. ディスク上の状態: `stopped.json` の説明の後に「`brainstorm` の design が最後に端末で尋ねたときの `roles/design/awaiting-user.json`、」を足す

- [ ] **Step 5: プラグインの CLAUDE.md と README を直す**

1. `CLAUDE.md` の範囲の節にある「**worker の質問は親が答えられる**（exit 6）。」の項を、次に置き換える:

```markdown
- **brainstorm の質問先は `ask_via` で選ぶ**（既定 `terminal`）。`terminal` の design は自分の端末に質問を書いて
  ターンを終え、ユーザーはその端末で答える。`parent` は `orchestration ask` でブロックし、親が
  `orchestration reply --id <msg_id>` で答える（exit 6）。2026-09-24 の logi-app で、文書は「端末で尋ねる」、
  コード（a7d1eb5 以降）は「親に取り次がせる」と食い違い、質問が全部親に届いていた。**既定だけは「設定より前の
  挙動」ではなく文書の意図に揃えた。**Step 1b で毎回尋ね、Step 2 の `: "${ASK_VIA:?...}"` で尋ねていない
  dispatch を起動不能にする。**exit 6 の取り次ぎは残す** — `parent` の経路であり、指示に反して ask した worker を
  未知の型として batch ごと止めないための保険でもある。取り次いだ質問は `questions.json` に記録し、**2 度目は
  処理済みとして通す**（通さないと、答えたあとも同じ質問が queue の先頭に居座り、その worker の `merge_ready` が
  後ろで待ち続ける。実測）。回帰は `test-start.sh` の ST62 / ST109-112、`test-config.sh` の CF49-52、
  `test-docs.sh` の SK31
```

2. 「子は待ち続け、止めるのはユーザー」の節の「人を待っている間（`agentWait` と質問の取り次ぎ）は `human.json` に時刻を残して時計を戻す。」の直後に足す:

```markdown
**`agentWait` はターンを終えて端末で人を待つ状態を拾わない**（2026-09-24、logi-app の実測: 端末に質問を書いて
`❯` で待つ design の worker-show は `state=ready`・`agentWait=null`）。そこで `ask_via=terminal` の worker は
尋ねる前に `awaiting-user.ts` で `roles/design/awaiting-user.json` を書き、待機はそれが**タスクで子が最後に書いた
もの**である間を人待ちとして扱う（`workerLastChange` は human.json を含めない — 含めると 2 周目から最新でなくなる）。
消す手順は無く、答えのあとの書き込みで自然に外れる。劣化は 2 方向: 答えのあと何も書かずに黙ると停滞が見つからず、
worktree の無関係なファイルが動くと印が外れて今までどおり exit 8 になる。どちらも誤って止めはしない。
催促の行が回答欄に入らないのは、打ち直しが `merge_ready_sent` の役だけだからである（回帰は `test-wait.sh` の
WT114-117）
```

3. `README.md` に brainstorm の質問や exit 6 を説明する記述があれば、「brainstorm の worker は既定で自分の端末で質問する（`ask_via`）」という趣旨の 1 行に直す。無ければ触らない（`grep -n 'brainstorm\|ask' README.md` で確かめる）

- [ ] **Step 6: バージョンを 3.10.0 にする**

`.claude-plugin/plugin.json`・`.codex-plugin/plugin.json`・`../../.claude-plugin/marketplace.json` の orca-team-dispatch-task のエントリの `"version": "3.9.2"` を `"version": "3.10.0"` にする。

- [ ] **Step 7: すべてのテストと検査を走らせる**

Run:
```bash
bash test/run-all.sh 2>&1 | tail -15
pnpm --filter @tanaka-yui/orca-team-dispatch-task check
(cd ../.. && pnpm check:doc-lang)
```
Expected: run-all で failures が全部 0（SK8/SK8b/SK8c/SK8d/SK17/SK19/SK27/SK31 を含む）。check と doc-lang も成功する

- [ ] **Step 8: Commit**

```bash
git add skills/orca-team-dispatch-task/SKILL.md skills/orca-team-dispatch-task/references/guide-ja.md CLAUDE.md README.md test/test-docs.sh .claude-plugin/plugin.json .codex-plugin/plugin.json ../../.claude-plugin/marketplace.json
git commit -m "docs(orca-dispatch): brainstorm の質問先 ask_via を文書に書き、3.10.0 にする"
```
