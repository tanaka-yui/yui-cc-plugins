# ステータスラベルの共通化（orca-team-dispatch-task 部分 C1）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `--issue` が使う `dispatch/in-progress|done|failed` を、slack-issue-intake と共通のステータスラベル（spec 5.1）に置き換える。2 つのプラグインの定義が一致していることをルートで確かめる。

**Architecture:**
- ステータスラベルの定義は `lib/status.ts` に置く。slack-issue-intake の `lib/defaults.ts` の `STATUS_LABELS` と同じ値を写す。プラグインは別々にインストールされるため、共有のパッケージは作らない（spec 5.1）。
- `issue-fetch.ts`（検索、claim、取り消し、release、ラベルの作成）と `bin/orca-issue.ts` の `labelTerminal` で、名前を置き換える。
- ルートの `scripts/check-shared-contracts.mjs` で、次の 2 つを比べる。
  - 2 つの `STATUS_LABELS`
  - コメントの例 `orca-auto-comments.json` の 2 つの写し

**Tech Stack:** TypeScript（node の型除去で直接実行、実行時の npm 依存なし）、bash のテスト群（gh / orca の stub）、node --test。

**Spec:** `docs/superpowers/specs/2026-11-12-issue-auto-dispatch-design.md` の 5.1 と 6.1。

**部分 C の分け方:**
- C1: この計画。
- C2: `--auto` の本体と `make auto`。
- C3: `make setup`。環境の確認、並列数、automation の登録と有効化。

C1 の範囲外にするもの:
- 6.1 の「`--auto` を設定したリポジトリでは `--issue` が Ready も除外する」。`--auto` の設定は C2 で作るため、C2 で入れる。
- `--issue` がマーカー付きのコメントを書くこと（spec 5.4）。spec 6.1 は `--issue` に名前の置き換えだけを求めている（下の「私が決めたこと」）。

## Global Constraints

- ステータスラベルは `Backlog` / `Ready` / `Ready_Eng` / `In progress` / `In review` / `Pending` / `Done` / `Failed`。名前、slug、色、説明は slack-issue-intake の `lib/defaults.ts` の `STATUS_LABELS` と同じにする（並びも同じ）。
- `--issue` の検索で除外するもの（spec 6.1）:
  - `In progress` / `In review` / `Done` / `Failed` / `Ready_Eng` / `Pending` / `Backlog`
  - 古い `dispatch/in-progress` / `dispatch/done` / `dispatch/failed`
- 1 つの Issue に付けるステータスラベルは 1 つだけ（spec 5.1）。
- SKILL.md が正本で、`references/guide-ja.md` は見出しも内容も完全な写し（`test/test-docs.sh` の SK8*）。SKILL.md は英語だけで書く。
- `any` / `unknown` / `class` を書かない。実行時の npm 依存を増やさない。型だけの import は `import type`。
- 新しい `test/test-*.sh` を作ったら `test/run-all.sh` の SUITE に足す（この計画では作らない）。
- バージョンを 3.11.0 に上げる。対象は `.claude-plugin/plugin.json`、`.codex-plugin/plugin.json`、ルートの `.claude-plugin/marketplace.json`。
- gh-stub の `calls.log` は引数を `%q` で書く。`In progress` は `In\ progress` と記録されるので、テストでは `grep -qF -- '--add-label In\ progress'` の形で確かめる。

## 私が決めたこと

- **claim で Ready を外し、claim を戻すときは Ready も戻す。** 1 つの Issue のステータスラベルを 1 つにするため。claim した時点で Ready を外したかどうかを state の `issues[N].ready` に記録する。claim の取り消し、reconcile の release、`release` サブコマンドは、記録が true なら Ready を付け直す。
- **終端のラベルを動かすときは、古い `dispatch/in-progress` / `dispatch/done` / `dispatch/failed` も外す（失敗は無視する）。** 更新の前に claim された Issue が、更新のあとで終わる場合に、古いラベルと新しいラベルが両方残らないようにするため。
- **ラベルの作成（ensure-labels）は、名前を大文字小文字を区別せずに比べ、色と説明も付ける。** slack-issue-intake の `ensureLabels` と同じ。`ready` のようなラベルがすでにあると `gh label create Ready` が失敗するため。
- **`--issue` はマーカー付きのコメントを書かない。** そのため `--issue` の遷移は、Slack では人の変化として流れる。メンションはされず、「ステータスが … に変わりました」「完了しました」と書かれる。`--auto` のコメントは C2 で書く。

## Review Focus

1. **リポジトリに大文字小文字だけ違うラベル（`ready`、`done`）がすでにある。** ensure-labels はそれを作り直さずに通る。Task 2 の IF17 で確かめる。
2. **古い `dispatch/done` や `dispatch/failed` が付いた Issue。** `--issue` の検索から外れ、二度と拾われない。Task 2 の IF18 で確かめる。
3. **Ready が付いていた Issue の claim を戻したとき。** Ready が戻る。戻らないと、C2 の `--auto` がその Issue を二度と拾わない。Task 2 の IF19 で確かめる。
4. **古いラベルで claim された Issue が、更新のあとで終わったとき。** `dispatch/in-progress` が残らない。Task 3 の IS31 で確かめる。
5. **空白を含む名前（`In progress`、`In review`）の検索。** `-label:"In progress"` のように引用符で囲む。Task 1 の単体テストと Task 2 の IF18 で確かめる。

---

### Task 1: ステータスラベルの定義と、2 つのプラグインの一致の確認

**Files:**
- Create: `apps/orca-team-dispatch-task/lib/status.ts`
- Create: `apps/orca-team-dispatch-task/test/unit/status.test.ts`
- Create: `apps/orca-team-dispatch-task/test/fixtures/orca-auto-comments.json`（`apps/slack-issue-intake/test/fixtures/orca-auto-comments.json` をバイト単位で写す。C2 のテストが使う）
- Create: `scripts/check-shared-contracts.mjs`
- Modify: ルートの `package.json`（`check:contracts` を足し、`check` の最後にも足す）

**Interfaces:**
- Produces（`lib/status.ts`）:
  - `STATUS_LABELS: ReadonlyArray<{ name: string; slug: string; color: string; description: string }>`（slack-issue-intake と同じ値と並び）
  - `STATUS = { backlog: 'Backlog', ready: 'Ready', readyEng: 'Ready_Eng', inProgress: 'In progress', inReview: 'In review', pending: 'Pending', done: 'Done', failed: 'Failed' } as const`
  - `LEGACY_DISPATCH_LABELS: readonly string[] = ['dispatch/in-progress', 'dispatch/done', 'dispatch/failed']`
  - `ISSUE_EXCLUDED_LABELS: readonly string[]`（`Ready` 以外のステータスラベル 7 つと、`LEGACY_DISPATCH_LABELS`）
  - `searchExclusion(labels: readonly string[]): string`
    - 各ラベルを `-label:"<name>"` にして空白でつなぐ。
    - 例: `searchExclusion(['In progress', 'dispatch/done'])` は `'-label:"In progress" -label:"dispatch/done"'`。
- `scripts/check-shared-contracts.mjs`:
  - 2 つの `lib/status.ts` / `lib/defaults.ts` から `STATUS_LABELS` を import し、`node:util` の `isDeepStrictEqual` で比べる。
  - 2 つの JSON の写しを `readFileSync` で読み、バイト単位で比べる。
  - 違えば何が違うかを stderr に出して exit 1、同じなら `check-shared-contracts: OK`。

- [ ] **Step 1: 失敗するテストを書く**（`test/unit/status.test.ts`）
  - `STATUS_LABELS の名前と並び`: 名前の並びが `['Done', 'Failed', 'In review', 'Ready_Eng', 'In progress', 'Pending', 'Ready', 'Backlog']`。
  - `ISSUE_EXCLUDED_LABELS は Ready 以外の 7 つと古い 3 つ`:
    - 長さは 10。`'Ready'` を含まない。`'dispatch/failed'` を含む。
  - `searchExclusion は空白を含む名前を引用符で囲む`: 上の例のとおり。
- [ ] **Step 2: 走らせて失敗を見る**
  - Run: `cd apps/orca-team-dispatch-task && node --test 'test/unit/status.test.ts'`
  - Expected: FAIL（`lib/status.ts` が無い）。
  - 続けて、ルートで `node scripts/check-shared-contracts.mjs`。
  - Expected: スクリプトが無いので失敗する。
- [ ] **Step 3: 実装する**
  - `lib/status.ts`、fixture の写し、`scripts/check-shared-contracts.mjs`、ルートの `package.json` を作る。
  - `package.json` の `check` は `turbo run check && node scripts/check-doc-lang.mjs && node scripts/check-shared-contracts.mjs` にする。
- [ ] **Step 4: 走らせて通るのを見る**
  - Run: `node --test 'test/unit/status.test.ts'`、ルートで `node scripts/check-shared-contracts.mjs`、`pnpm --filter @tanaka-yui/orca-team-dispatch-task check`
  - Expected: PASS、`check-shared-contracts: OK`、型と biome もエラー無し。
  - 続けて、写した JSON の 1 文字を一時的に変えて `node scripts/check-shared-contracts.mjs` を走らせる。
  - Expected: exit 1。確かめたら元に戻す。
- [ ] **Step 5: コミット** `feat(orca-team-dispatch-task): slack-issue-intake と共通のステータスラベルを定義し、2 つの一致をルートで確かめる`

### Task 2: issue-fetch のラベルを置き換える

**Files:**
- Modify: `apps/orca-team-dispatch-task/skills/orca-team-dispatch-task/scripts/issue-fetch.ts`
  - 対象は次のとおり。
    - fetch の検索（:317）
    - claim（:368）と取り消し（:381）
    - reconcile の release（:441）
    - `release`（:565）
    - `ensure-labels`（:577-586）
    - 先頭のコメント（:23）
- Modify: `apps/orca-team-dispatch-task/test/test-issue-fetch.sh`（IF5 / IF7 / IF9 / IF11 / IF12 / IF13 の期待値と、新しい IF17-IF19）
- Modify: `apps/orca-team-dispatch-task/test/test-issue-loop.sh:66,79`、`test/test-e2e.sh:242,253`（ラベル名の期待値）

**Interfaces:**
- Consumes: Task 1 の `STATUS`、`STATUS_LABELS`、`ISSUE_EXCLUDED_LABELS`、`searchExclusion`。
- Produces: state の `issues[N]` に `ready: boolean` を足す。claim で Ready を外したときだけ true にする。

- [ ] **Step 1: 失敗するテストを書く**（`test/test-issue-fetch.sh`）
  - 既存のテストの期待値を置き換える。
    - `--add-label dispatch/in-progress` は `--add-label In\ progress` に、`--remove-label dispatch/in-progress` は `--remove-label In\ progress` にする。
    - IF9 は、`label_list` が `[{name:"In progress"}]` のとき、`label create` が 7 回になる。
  - `IF17 ensure-labels は大文字小文字だけ違う既存のラベルを作り直さず、色と説明を付けて作る`
    - `label_list` を `[{name:"ready"},{name:"done"}]` にする。
    - `label create` が 6 回で、`Ready` と `Done` は作らない。
    - calls.log に `--color` と `--description` がある。
  - `IF18 検索はステータスラベル 7 つと古い dispatch の 3 つを除外し、空白を含む名前を引用符で囲む`
    - `issue list` の argv（argv.log）の `--search` の値が、`-label:"In progress"`、`-label:"Backlog"`、`-label:"dispatch/done"` を含み、`-label:"Ready"` を含まない。
  - `IF19 Ready の付いた Issue は claim で Ready を外し、state を書けずに取り消すときは Ready を戻す`
    - `issue_list` の候補の labels を `[{name:"Ready"}]` にし、IF5 と同じく state を書けなくする。
    - calls.log に、`--add-label In\ progress --remove-label Ready` と、取り消しの `--remove-label In\ progress --add-label Ready` がある。
    - 成功する別の回では、`state.issues["N"].ready` が true になる。
    - そのあとの `release --issue N` で `--add-label Ready` が出る。
- [ ] **Step 2: 走らせて失敗を見る**
  - Run: `bash test/test-issue-fetch.sh`
  - Expected: 置き換えた期待値と IF17-IF19 が FAIL。
- [ ] **Step 3: 実装する**
  - claim は 1 回の `gh issue edit N --add-label "In progress"` で行う。候補の labels に Ready（大文字小文字を区別しない）があれば、同じ呼び出しに `--remove-label Ready` を足す。
  - 取り消しと release は `--remove-label "In progress"` で行う。`ready` が true なら同じ呼び出しに `--add-label Ready` を足す。
  - ensure-labels は `gh label create <name> --color <color> --description <description>` で作る。
  - 先頭のコメントの「移植で変えた点」に、ラベルの置き換えを 1 行足す。
- [ ] **Step 4: 走らせて通るのを見る**
  - Run: `bash test/test-issue-fetch.sh && bash test/test-issue-loop.sh && bash test/test-e2e.sh`
  - Expected: すべて ok。
- [ ] **Step 5: コミット** `feat(orca-team-dispatch-task): issue モードの claim と検索をステータスラベルに置き換える`

### Task 3: 終端のラベル、文書、バージョン

**Files:**
- Modify: `apps/orca-team-dispatch-task/bin/orca-issue.ts:105-128`（`labelTerminal` と、その上のコメントの名前）
- Modify: `apps/orca-team-dispatch-task/test/test-issue.sh`（:92、:108-109、:120、:133、:164、:178-184、:304、:309-314 の期待値と、新しい IS31）
- Modify: `apps/orca-team-dispatch-task/skills/orca-team-dispatch-task/SKILL.md:360,400` と `references/guide-ja.md:338,379`（`dispatch/failed` を `Failed` に、ステータスラベルの説明を 1 文足す）
- Modify: `apps/orca-team-dispatch-task/CLAUDE.md`（「issue モードの要点」に 1 項目足す。「関連プラグインのラベルと同じ定義を `lib/status.ts` に持ち、`scripts/check-shared-contracts.mjs` が一致を確かめる」）
- Modify: `apps/orca-team-dispatch-task/.claude-plugin/plugin.json`、`.codex-plugin/plugin.json`、ルートの `.claude-plugin/marketplace.json`（3.11.0）

**Interfaces:**
- Consumes: Task 1 の `STATUS`、`LEGACY_DISPATCH_LABELS`。
- `labelTerminal(issue: string, status: 'done' | 'failed'): boolean` の形は変えない。次の順に動かす。
  1. `Done` か `Failed` を付ける。失敗したら false を返す。
  2. 反対の終端のラベルを外す。rc は見ない。
  3. 古い `LEGACY_DISPATCH_LABELS` を外す。rc は見ない。
  4. 最後に `In progress` を外し、その rc を返す。終端を先に付ける理由は、今のコメントのとおり。

- [ ] **Step 1: 失敗するテストを書く**（`test/test-issue.sh`）
  - 既存の期待値を置き換える。`--add-label dispatch/done` は `--add-label Done` に、`dispatch/failed` は `Failed` に、`--remove-label dispatch/in-progress` は `--remove-label In\ progress` にする。
  - `IS31 終端では古い dispatch のラベルも外す`
    - `worker_done succeeded done` の回の ghlog に、`--remove-label dispatch/in-progress` と `--remove-label In\ progress` がある。
    - `--add-label Done` はそれらより前に出る（`grep -n` の行番号で比べる）。
- [ ] **Step 2: 走らせて失敗を見る**
  - Run: `bash test/test-issue.sh`
  - Expected: 置き換えた期待値と IS31 が FAIL。
- [ ] **Step 3: 実装する**
  - `labelTerminal` と文書と CLAUDE.md を直し、バージョンを 3.11.0 に上げる。
  - SKILL.md に足す文（英語）: `Issue mode moves the shared status labels (In progress, Done, Failed; the same set as slack-issue-intake) and still skips issues that carry the old dispatch/* labels.` guide-ja.md には同じ位置に訳を置く。
- [ ] **Step 4: 走らせて通るのを見る**
  - Run: `make test`（apps/orca-team-dispatch-task で）、`pnpm --filter @tanaka-yui/orca-team-dispatch-task check`、ルートで `pnpm check:doc-lang` と `node scripts/check-shared-contracts.mjs`
  - Expected: 全件 ok、型と biome もエラー無し、`check-doc-lang: OK`、`check-shared-contracts: OK`。
- [ ] **Step 5: コミット** `feat(orca-team-dispatch-task): 終端のラベルを Done / Failed にし、3.11.0 に上げる`
