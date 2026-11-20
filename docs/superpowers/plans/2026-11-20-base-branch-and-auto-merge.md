# 向き先ブランチと autoMerge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 向き先ブランチを Issue ごとに始める前に決め（設定・`base:*` ラベル・判定・質問）、main への緊急修正のあとは戻しの PR を作り、拾う元ごとの `autoMerge` で auto-ready の Issue も develop まで AI が merge できるようにする。

**Architecture:** orca-team-dispatch-task に向き先を解く純粋な部品 `lib/auto-base.ts` を置き、judge-apply・refill・merge の関門・戻しの PR がそれを使う。slack-issue-intake とは `base:<branch>` ラベルと通知の event（`needs-base`、`human-merged` の本文）だけを共有し、設定は読み合わない。3 段（① 向き先 ② フォームの欄 ③ autoMerge）に分け、段ごとに版を上げて push する。

**Tech Stack:** TypeScript（node の型除去で直接実行・実行時の npm 依存なし）、bash のテスト、`node --test`、gh CLI、biome。

**Spec:** `docs/superpowers/specs/2026-11-20-base-branch-and-auto-merge-design.md`

## Global Constraints

- コード（識別子・CLI フラグ）は英語、コメント・コミットメッセージ・CLAUDE.md・README は日本語。
- `SKILL.md` と `references/*.md`（`-ja` 以外）に日本語を書かない。SKILL.md を変えたら `references/guide-ja.md` を同じ commit で変える。`auto-judge.md` を変えたら `auto-judge-ja.md` も。
- TypeScript で `any` / `unknown` / `class` を書かない。JSON は `lib/json.ts` の `asObject` などで絞る。
- orca の入口は `process.exitCode` で終え、`process.exit` は `die` だけ。SKILL.md の bash block に判定を書かない（入口の 1 行呼び出しだけ）。
- 共有の fixture `test/fixtures/orca-auto-comments.json` は 2 つのプラグインでバイト一致させる（`scripts/check-shared-contracts.mjs`）。
- ラベルの形は `base:<branch>`（`BASE_LABEL_PREFIX = 'base:'`）。ステータスラベルではない（`STATUS_LABELS`・`LABEL_SPECS`・`labels_hash` に入れない）。
- 新しい通知 event は `needs-base`（メンションあり、マーカーのステータス slug は `backlog`）。
- AI が merge してよいのは、そのリポジトリの設定の `baseBranch` が向き先のときだけ（`baseBranch` を設定していないリポジトリは今のまま）。
- 版: 段 1 で orca-team-dispatch-task 3.16.0・slack-issue-intake 0.8.0、段 2 で slack-issue-intake 0.9.0、段 3 で orca-team-dispatch-task 3.17.0。plugin.json・`.codex-plugin/plugin.json`（orca だけ）・ルート `.claude-plugin/marketplace.json` をそろえ、intake の `test/unit/docs.test.ts` DO6 の版も直す。
- 検証: orca は `cd apps/orca-team-dispatch-task && make test` と `pnpm --filter @tanaka-yui/orca-team-dispatch-task check`、intake は `cd apps/slack-issue-intake && bash test/run-all.sh` と `pnpm --filter @tanaka-yui/slack-issue-intake check`、ルートで `node scripts/check-doc-lang.mjs` と `node scripts/check-shared-contracts.mjs`。

## Review Focus

1. **`base:` ラベルの大文字小文字や前後の空白**（`Base:Main` など）— 人が手で付けるので、`base:` の接頭辞は大文字小文字を区別せずに読み、ブランチ名は候補と完全一致でだけ受け付ける（一致しなければ不明＝尋ねる）。Task 1 の AB6。
2. **尋ねたあと人が Issue を閉じた・別のステータスにした** — `baseAsked` の Issue が Backlog でも pick でもなくなったら、今までの「人の変更」と同じく止める（stopped）。黙って残さない。Task 3 の AU147。
3. **戻しの PR を作ろうとしたら同じ向きの PR が既に開いている／差分が無い** — 二度作らず既存のリンクを使う。差分が無ければ作らず、そのことをコメントに書く。Task 5 の BM2・BM3。
4. **版を上げる前から動いている Issue（`bases` の記録が無い）が merge の関門に来る** — 向き先の制限を掛けず今までどおりに動く（既定ブランチで動いていたもの）。Task 4 の AU151。
5. **手動の `--issue` で `base:*` ラベルが 2 つ付いた Issue** — claim せずに飛ばし理由を言う（どちらも信じない）。Task 6 の IF25。

---

## 段 1: 向き先の仕組み

### Task 1: 向き先を解く部品と設定

**Files:**
- Create: `apps/orca-team-dispatch-task/lib/auto-base.ts`
- Modify: `apps/orca-team-dispatch-task/lib/auto-config.ts`（`repos[repo]` に `baseBranch` / `branches`）
- Modify: `apps/orca-team-dispatch-task/lib/setup-draft.ts`（`repos` の書き出しで新しい欄を落とさない。今は verbatim なので確認だけ）
- Test: `apps/orca-team-dispatch-task/test/unit/auto-base.test.ts`、`test/unit/auto-config.test.ts`

**Interfaces:**
- Produces:
  - `BASE_LABEL_PREFIX = 'base:'`
  - `type RepoBranches = { baseBranch: string | null; branches: string[] }`（`AutoConfig['repos'][repo]` に足す 2 欄と同じ形。`branches` が空なら「候補 1 つ＝既定」）
  - `baseLabels(labels: string[]): string[]` — `base:` で始まる（大文字小文字を区別しない）ラベルの、接頭辞を除き前後の空白を落とした名前
  - `type BaseResolution = { kind: 'ok'; bases: Record<string, string | null> } | { kind: 'judge' } | { kind: 'ask'; why: string }`（`null` は「GitHub の既定ブランチ」）
  - `resolveBases(labels: string[], targets: string[], repos: Record<string, RepoBranches>): BaseResolution`
  - `applyFlow(flow: string, targets: string[], repos: Record<string, RepoBranches>): Record<string, string | null> | null` — 流れ（ブランチ名）を対象ごとに当てはめる。どの対象の候補にも無ければ `null`
  - `needsChoice(targets: string[], repos: Record<string, RepoBranches>): boolean` — 候補が 2 つ以上の対象があるか
  - `candidatesOf(targets: string[], repos: Record<string, RepoBranches>): string[]` — 対象の候補の和集合（重複なし・設定の順）
  - `restrictedBase(repo: string, base: string, repos: Record<string, RepoBranches>): boolean` — `baseBranch` が設定されていて、`base` がそれと違うなら true

規則（spec 4 章・7.1）: ラベル 0 個 → `needsChoice` が false なら `ok`（各対象 `baseBranch`、未設定なら `null`）、true なら `judge`。ラベル 1 個 → `applyFlow`、`null` なら `ask`。ラベル 2 個以上 → `ask`。

- [ ] **Step 1: 失敗するテストを書く**（`test/unit/auto-base.test.ts`）
  - AB1 `resolveBases([], ['o/a'], { 'o/a': { baseBranch: null, branches: [] } })` → `{ kind: 'ok', bases: { 'o/a': null } }`
  - AB2 ラベル無し・`{ baseBranch: 'develop', branches: ['develop', 'main'] }` → `{ kind: 'judge' }`
  - AB3 `['base:main']`、API `{develop,[develop,main]}` とクライアント `{main,[main]}` → `bases: { api: 'main', client: 'main' }`。`['base:develop']` → `{ api: 'develop', client: 'main' }`
  - AB4 `['base:release']`（どの候補にも無い）→ `kind: 'ask'`
  - AB5 `['base:main', 'base:develop']` → `kind: 'ask'`
  - AB6 `['Base: main ']` → `baseLabels` が `['main']`。`['base:Main']` は候補 `main` と一致しない → `ask`
  - AB7 `restrictedBase('o/a', 'main', { 'o/a': { baseBranch: 'develop', branches: ['develop','main'] } })` → true、`'develop'` → false、`baseBranch: null` → false
  - CF7（`auto-config.test.ts`）: `repos[r]` に `baseBranch: 'develop', branches: ['develop','main']` を持つ設定が読める。`branches` が `baseBranch` を含まない・空文字を含む・`baseBranch` が文字列でない設定は `null`。省略時は `{ baseBranch: null, branches: [] }`。`configJsonFromDraft(draftFromConfig(...))` を通しても 2 欄が残る

- [ ] **Step 2: 走らせて失敗を確かめる** — `cd apps/orca-team-dispatch-task && node --test test/unit/auto-base.test.ts test/unit/auto-config.test.ts` → FAIL（モジュールが無い）
- [ ] **Step 3: `lib/auto-base.ts` を実装し、`parseAutoConfig` の repos ループに 2 欄の検査を足す**（既存の `boolean` / `strings` の流儀。不正なら設定ごと `null`）
- [ ] **Step 4: 走らせて通るのを確かめる** — 同じコマンド → PASS、`pnpm --filter @tanaka-yui/orca-team-dispatch-task check` → エラーなし
- [ ] **Step 5: Commit** — `feat(orca-team-dispatch-task): 向き先ブランチを解く部品と設定の欄を足す`

### Task 2: 共有の通知 event（`needs-base`・戻しの PR の本文）

**Files:**
- Modify: `apps/orca-team-dispatch-task/lib/auto-comment.ts`（`AutoEvent` に `'needs-base'`、`statusOfEvent` で Backlog、`CommentInput` に `candidates?: string[]`・`fallback?: string`・`backPrs?: Array<{ repo: string; url: string }>`・`backFailures?: Array<{ repo: string; why: string }>`）
- Modify: 両方の `test/fixtures/orca-auto-comments.json`（末尾に `needs-base` を 1 件。バイト一致）
- Modify: `apps/slack-issue-intake/lib/defaults.ts`（`STATUS_EVENTS` に `needs-base`、`human-merged` の template に `{comment}`、`STATUS_EVENT_STALLED` を `STATUS_EVENTS_WITHOUT_CHANGE = ['stalled', 'needs-base']` に置き換え）
- Modify: `apps/slack-issue-intake/lib/issue-status.ts:72`（`STATUS_EVENTS_WITHOUT_CHANGE.includes(marker.event)`）
- Test: orca `test/unit/auto-comment.test.ts`、intake `test/unit/issue-status.test.ts`・`test/status-sync.test.ts`

**Interfaces:**
- Produces: `renderComment({ event: 'needs-base', generation, candidates, fallback })` の本文。`human-merged` / `ai-merged` の本文は `backPrs` があれば「<repo> へ取り込む PR: <url>」の行を、`backFailures` があれば「<repo> へ取り込む PR を作れませんでした: <why>」の行を足す（無ければ今と同じ本文。既存の fixture の例は変えない）。
- 文言（spec 7.2 で固定）: `needs-base` の本文は「向き先のブランチを決められませんでした。`base:<候補1>` か `base:<候補2>` のどちらかのラベルを付けてください。ラベルを付けずに Ready に戻すと <fallback> で進めます。」（候補は `candidates` を列挙）
- intake の `STATUS_EVENTS['needs-base'] = { mention: true, template: '向き先のブランチを教えてください\n{issue}\n\n{comment}' }`、`human-merged` は `'PR が merge されたので完了にしました（Done）\n{issue}\n\n{comment}'`

- [ ] **Step 1: 失敗するテストを書く**
  - AC9（orca）: `needs-base` の `{status: 'Backlog', body}` が fixture の 10 件目と一致し、マーカーが `<!-- orca-auto:backlog:<gen>:needs-base -->`
  - AC10（orca）: `human-merged` に `backPrs: [{ repo: 'o/a', url: 'https://github.com/o/a/pull/9' }]` を渡すと本文にその URL の行がある。`backFailures` の行も同様
  - intake IS2 の件数を 10 に、IS5 の `SLUG_TO_NAME` に `backlog`、IS8: ステータスが Backlog のまま `needs-base` のマーカーが来たら、メンション付きで template を埋めた文を返す
  - intake ST15（`status-sync.test.ts`）: Backlog の Issue に `needs-base` のコメントが付いた poll で、スレッドへ 1 回だけ書く（2 回目の poll では書かない）
- [ ] **Step 2: 走らせて失敗を確かめる** — `cd apps/orca-team-dispatch-task && node --test test/unit/auto-comment.test.ts`、`cd apps/slack-issue-intake && node --test test/unit/issue-status.test.ts test/status-sync.test.ts` → FAIL
- [ ] **Step 3: 実装する**（fixture は orca 側で生成した本文を両方へ同じバイトで書く）
- [ ] **Step 4: 走らせて通るのを確かめる** — 同じコマンドと、ルートで `node scripts/check-shared-contracts.mjs` → OK
- [ ] **Step 5: Commit** — `feat: 向き先の質問 needs-base の通知と、Done の本文に戻しの PR を載せる口を足す`

### Task 3: 判定で向き先を決め、迷えば尋ねる

**Files:**
- Modify: `apps/orca-team-dispatch-task/lib/auto-state.ts`（`IssueState` に `bases: Record<string, string | null>` と `baseAsked: boolean`。`readState` の移行は `bases ?? {}`・`baseAsked ?? false`、型違いは「状態ファイルが壊れています」）
- Modify: `apps/orca-team-dispatch-task/lib/auto-queue.ts`（`makeIssue` と世代の作り直しで `bases: {}`・`baseAsked: false`。`baseAsked` の Issue の扱い）
- Modify: `apps/orca-team-dispatch-task/bin/orca-auto.ts`（judge-list と judge-apply）
- Modify: `apps/orca-team-dispatch-task/lib/auto-tick.ts`（Backlog のまま尋ねるコメントを `notifyStalled` と同じ形で書く関数 `notifyNeedsBase`）
- Modify: `skills/orca-team-dispatch-task/references/auto-judge.md` と `auto-judge-ja.md`（5・11 行目付近）
- Test: `test/unit/auto-judge.test.ts`、`test/unit/auto-queue.test.ts`、`test/unit/auto-state.test.ts`、`test/test-docs.sh`

**Interfaces:**
- Consumes: Task 1 の `resolveBases` / `applyFlow` / `candidatesOf` / `needsChoice`、Task 2 の `needs-base`
- Produces: キューに入った Issue は `issue.bases` を持つ（対象ごと。`null` は既定）。Task 4 がそれを読む
- judge-list の各 Issue に `base: { labels: string[]; candidates: string[]; needed: boolean }` を足す（`needed` は `resolveBases` が `judge` のとき true）
- 判定の出力に `base`（文字列。候補のどれか、または `'ask'`）を足す。`needed` が true の Issue でだけ必須。それ以外の Issue では無視する
- judge-apply の順（spec 7.1・7.2、route の判定の後）:
  1. `toEng` なら向き先は扱わない（今と同じ）
  2. `resolveBases(今のラベル, targets, repos)` が `ok` → `issue.bases` に入れて進む
  3. `judge` → `decision.base` が候補にあれば `applyFlow`、`'ask'` か不正なら尋ねる。ただし `issue.baseAsked` が true（尋ねたあと人がラベル無しで Ready に戻した）なら尋ねず `applyFlow(各対象の baseBranch)` で進む
  4. `ask`（ラベルが不正）→ 尋ねる
- 尋ねる: `issue.baseAsked = true`。auto-ready の Issue（Backlog のまま判定）は `notifyNeedsBase`（ラベルを変えずにコメントだけ）、それ以外は `transition(issue, 'needs-base', { candidates, fallback }, STATUS.ready, STATUS.backlog, false, 'judging', save)`。`fallback` は先頭の対象の `baseBranch`（未設定なら「既定のブランチ」）
- `syncIssues` の扱い: `baseAsked` で Backlog に居る Issue は、判定に回さない（`base:*` が付いて `resolveBases` が `ok` になったら判定に回す）。auto-ready でない拾う元で人が Ready に戻したら判定に回す。Backlog でも Ready でもなくなったら今の「人の変更」と同じに止める。拾い直しでも `autoReady` は尋ねる前の値のまま

- [ ] **Step 1: 失敗するテストを書く**
  - AU143: 候補 2 つの対象で `decision.base: 'main'` → `issue.bases` が `{ 'o/a': 'main' }`、phase `queued`
  - AU144: `decision.base: 'ask'`（人が Ready にした Issue）→ Ready→Backlog のラベル変更と `needs-base` のコメント、`baseAsked` true、phase `judging`
  - AU145: auto-ready の Issue で `'ask'` → ラベルは変えずコメントだけ（`gh issue edit` を呼ばない）
  - AU146: `baseAsked` の Issue に `base:develop` が付いた → 次の judge-list に出る。付いていなければ出ない
  - AU147（Review Focus 2）: `baseAsked` の Issue が閉じられた・Pending にされた → `stopped`
  - AU148: `baseAsked` の Issue を人がラベル無しで Ready に戻した → judge-apply が `'ask'` を返しても尋ねず `baseBranch` で queued
  - AU149: `toEng` の Issue は `base` が無くても受け付け、尋ねない
  - AU150: `needed` の Issue で `base` が無い判定は破棄する（「判定を破棄しました」）
  - SS5（`auto-state.test.ts`）: `bases`/`baseAsked` の無い古い状態を読むと `{}`/`false`。型違いは例外
  - SK44（`test-docs.sh`）: `auto-judge.md` と `-ja` が `base` の出力と `ask` を説明している（固定の語を grep）
- [ ] **Step 2: 走らせて失敗を確かめる** — `node --test test/unit/auto-judge.test.ts test/unit/auto-queue.test.ts test/unit/auto-state.test.ts`、`bash test/test-docs.sh` → FAIL
- [ ] **Step 3: 実装する**（判定の指示には: 本番の障害・緊急・hotfix なら本番側、それ以外は普段の向き先、根拠がはっきりしなければ `ask`）
- [ ] **Step 4: 走らせて通るのを確かめる** — 同じコマンド → PASS
- [ ] **Step 5: Commit** — `feat(orca-team-dispatch-task): auto の判定で向き先を決め、迷えば base ラベルで尋ねる`

### Task 4: 決めた向き先で起動し、普段の向き先以外は AI が merge しない

**Files:**
- Modify: `apps/orca-team-dispatch-task/lib/auto-tick.ts`（`refill` 413-429 と merge の関門 900-944）
- Test: `test/unit/auto-dispatch.test.ts`、`test/unit/auto-finish.test.ts`

**Interfaces:**
- Consumes: `issue.bases`（Task 3）、`restrictedBase`（Task 1）
- refill: 対象ごとに `issue.bases[r.name] ?? null` が文字列ならそのブランチ、`null` なら今と同じ `defaultBranchRef`。実際に使ったブランチ名を `issue.bases[r.name]` に書き戻す（関門と戻しの PR が読む）。あとは今の `fetch` / `checkout -B` / `--base-branch origin/<b>` の流れのまま
- 関門: 対象ごとに `restrictedBase(repo, issue.bases[repo], repos)` なら理由「普段の向き先でない（<branch>）への merge は人が確認します。」を足す。`issue.bases[repo]` が無ければ足さない

- [ ] **Step 1: 失敗するテストを書く**
  - AU151（Review Focus 4）: `bases` の無い Issue は今と同じく既定ブランチで起動し、関門で向き先の理由が付かない
  - AU152: `bases: { 'o/a': 'main' }` → `git checkout -B main origin/main` と `--base-branch origin/main` が呼ばれる（`childCalls`）
  - AU153: `baseBranch: 'develop'` の設定で `bases` が `main` → 条件がそろっていても In review、理由に「普段の向き先でない（main）」
  - AU154: 同じ設定で `develop` → 今までどおり AI が merge（`ai-merged`）
- [ ] **Step 2: 走らせて失敗を確かめる** — `node --test test/unit/auto-dispatch.test.ts test/unit/auto-finish.test.ts` → FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 走らせて通るのを確かめる** — 同じコマンド → PASS
- [ ] **Step 5: Commit** — `feat(orca-team-dispatch-task): 決めた向き先から作業を始め、普段の向き先以外への merge は人に回す`

### Task 5: 戻しの PR

**Files:**
- Create: `apps/orca-team-dispatch-task/lib/auto-backmerge.ts`
- Modify: `apps/orca-team-dispatch-task/lib/auto-tick.ts`（`human-merged`（1047）と `ai-merged`（865・1003）の transition の前）
- Test: `test/unit/auto-backmerge.test.ts`、`test/unit/auto-finish.test.ts`

**Interfaces:**
- Consumes: `restrictedBase`、`issue.bases`、Task 2 の `backPrs` / `backFailures`
- Produces: `openBackMerge(repo: string, from: string, to: string, title: string, body: string): { kind: 'opened' | 'existing'; url: string } | { kind: 'no-diff' } | { kind: 'error'; why: string }`
  - まず `gh pr list --repo <repo> --base <to> --head <from> --state open --json url` で既存を探す（あれば `existing`）
  - 無ければ `gh pr create --repo <repo> --base <to> --head <from> --title <title> --body <body>`。失敗の出力に `No commits between` があれば `no-diff`、ほかは `error`（出力の 1 行目）
- 呼び出し: merge を見つけた段で、`restrictedBase` が true の対象ごとに `openBackMerge(repo, bases[repo], baseBranch, '<from> を <to> へ取り込む（<owner/repo#N>）', '<Issue の URL> と <PR の URL> の取り込み。')` を呼び、結果を `backPrs`（opened / existing）と `backFailures`（error。`no-diff` は「差分がありません」）に分けて transition の入力に足す。失敗しても Done へ進む

- [ ] **Step 1: 失敗するテストを書く**
  - BM1: 既存が無く作成が成功 → `{ kind: 'opened', url }`、`gh pr create` の引数が上の形
  - BM2（Review Focus 3）: 既存の PR がある → `existing`、`gh pr create` を呼ばない
  - BM3（Review Focus 3）: `No commits between` → `no-diff`
  - BM4: ほかの失敗 → `error`
  - AU155: `baseBranch: develop` で `bases: main` の Issue が人に merge された → `human-merged` のコメントに戻しの PR の URL、Done へ進む
  - AU156: 戻しの PR の作成が失敗しても Done へ進み、コメントに理由
  - AU157: `restrictedBase` が false の Issue では `gh pr list` も呼ばない
- [ ] **Step 2: 走らせて失敗を確かめる** — `node --test test/unit/auto-backmerge.test.ts test/unit/auto-finish.test.ts` → FAIL
- [ ] **Step 3: 実装する**（gh は `lib/auto-github.ts` の `github` を使う）
- [ ] **Step 4: 走らせて通るのを確かめる** — 同じコマンド → PASS
- [ ] **Step 5: Commit** — `feat(orca-team-dispatch-task): 普段の向き先以外へ merge されたら戻しの PR を作る`

### Task 6: 手動の dispatch と issue モード

**Files:**
- Modify: `apps/orca-team-dispatch-task/skills/orca-team-dispatch-task/scripts/issue-fetch.ts`（候補の絞り込み）
- Modify: `apps/orca-team-dispatch-task/bin/orca-state.ts`（`current-branch [--repo-root <p>]`: 親の checkout の今のブランチを `branch=<name>` で出す。detached なら exit 1）
- Modify: `SKILL.md` の Step 1b と Issue mode、`references/guide-ja.md`
- Test: `test/test-issue-fetch.sh`、`test/test-state.sh`、`test/test-docs.sh`

**Interfaces:**
- Consumes: `baseLabels`（Task 1。issue-fetch.ts は `../../../lib/auto-base.ts` を import してよい）
- issue-fetch: claim の前に候補を絞る。`baseLabels(候補のラベル)` が 1 つで今のブランチ（`git -C <repo root> symbolic-ref --short HEAD`）と違う、または 2 つ以上 → `note('skip', 'issue #<N> は向き先が <b> なので、今のブランチ <cur> では扱いません')` を出して候補から外す（claim に数えない）。0 個なら今までどおり
- SKILL.md Step 1b: 始め方を尋ねる前に `node "$PLUGIN/bin/orca-state.ts" current-branch` を呼び、「<branch> に取り込みます。別のブランチにしたいときは、checkout を切り替えてからやり直してください」とユーザーへ示す。親は checkout を切り替えない

- [ ] **Step 1: 失敗するテストを書く**
  - IF24: 今のブランチが develop で `base:main` の候補は claim されず、`[skip]` の行が出る。`base:develop` とラベル無しは claim される
  - IF25（Review Focus 5）: `base:main` と `base:develop` の両方が付いた候補は claim されない
  - OS12: `current-branch` が `branch=<name>` を出す。detached HEAD で exit 1。何も書かない
  - SK45: Step 1b が `orca-state.ts" current-branch` を呼び、checkout を切り替えないと書いている（SKILL.md と guide-ja.md の両方）
- [ ] **Step 2: 走らせて失敗を確かめる** — `bash test/test-issue-fetch.sh; bash test/test-state.sh; bash test/test-docs.sh` → FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 走らせて通るのを確かめる** — 同じコマンド → PASS
- [ ] **Step 5: Commit** — `feat(orca-team-dispatch-task): 手動の dispatch で取り込み先を示し、向き先の違う Issue を飛ばす`

### Task 7: setup で候補を尋ね、段 1 を出す

**Files:**
- Modify: `apps/orca-team-dispatch-task/lib/auto-setup.ts`（`pickRepos` の終わり）
- Modify: SKILL.md の Auto mode の Configuration、`guide-ja.md`、README、`apps/orca-team-dispatch-task/CLAUDE.md`、`apps/slack-issue-intake/README.md`（ステータスの通知の表に `needs-base` の行）・`CLAUDE.md`
- Modify: 版（orca 3.16.0、intake 0.8.0、marketplace、intake DO6）
- Test: `test/unit/setup-run.test.ts`

**Interfaces:**
- 候補の見つけ方: `github(['api', 'repos/<r>/branches', '--paginate', '--jq', '.[].name'])` の出力から、既定ブランチと `develop` / `main` / `master` のうち在るもの。2 つ以上見つかったときだけ「普段の向き先」（既定は develop が在れば develop、無ければ既定ブランチ）と「候補（カンマ区切り）」を尋ねる。1 つ以下なら尋ねず 2 欄を書かない（今の setup のテストの答えの位置がずれない）
- 再実行では今の値を既定として見せる

- [ ] **Step 1: 失敗するテストを書く**
  - SU44: gh の stub が `develop`・`main` を返す → 2 つを尋ね、設定に `baseBranch: 'develop', branches: ['develop', 'main']`
  - SU45: stub が `main` だけ → 尋ねず、設定に 2 欄が無い。既存の SU の答えはそのまま通る
- [ ] **Step 2: 走らせて失敗を確かめる** — `node --test test/unit/setup-run.test.ts` → FAIL
- [ ] **Step 3: 実装し、文書を書く**（SKILL.md: 設定の 2 欄、向き先の決め方、`needs-base`、戻しの PR、普段の向き先以外は人が merge。guide-ja.md も同じ commit）
- [ ] **Step 4: 全体の検証** — orca の `make test` と check、intake の `bash test/run-all.sh` と check、ルートで `node scripts/check-doc-lang.mjs` と `node scripts/check-shared-contracts.mjs` → すべて通る
- [ ] **Step 5: Commit して push** — `feat: 向き先ブランチを Issue ごとに決める（orca-team-dispatch-task 3.16.0 / slack-issue-intake 0.8.0）`、`git push origin main`

## 段 2: フォームの向き先の欄（slack-issue-intake）

### Task 8: 設定・setup・フォーム・起票

**Files:**
- Modify: `apps/slack-issue-intake/lib/config.ts`（`RepoSetting` に `branches?: string[]`、`loadConfig` で読んで写す、`formBranches(config): string[]`）
- Modify: `lib/commands/init.ts`（`--branches <repo>=<b1>,<b2>` を複数回受け、`base` から写す）
- Modify: `lib/commands/setup.ts`（`pickRepo` で追加したリポジトリと既定のリポジトリごとに、gh の `api repos/<r>/branches` で 2 つ以上見つかれば候補を尋ねる）
- Modify: `lib/defaults.ts`（`FIELD_LABELS.base = '向き先'`、`BASE_ANY = 'おまかせ'`、`SETUP_TEXT` の問い）、`lib/form-message.ts`・`lib/form.ts`・`lib/guide.ts`・`lib/slack-cli.ts`（`manifestHash` の入力に候補）
- Modify: `lib/parse.ts`（ヘッダの `向き先`）、`lib/types.ts`（`SubmissionFields.base?: string`）、`lib/issue-body.ts`（`issueLabels` が `base:<b>` を足す）、`lib/drive.ts`（`createIssue` の前に `gh label create base:<b> --repo <r> --force` を締め切りの中で）、`lib/commands/apply.ts`（質問からの起票で `base` を落とす）
- Modify: `test/fixtures/fake-gh.ts`（`api repos/<o>/<r>/branches` を `FAKE_GH_BRANCHES` で返す）
- Modify: README・CLAUDE.md・版 0.9.0・DO6
- Test: `test/unit/config.test.ts`、`test/init.test.ts`、`test/setup.test.ts`、`test/unit/form.test.ts`、`test/unit/parse.test.ts`、`test/unit/issue-body.test.ts`、`test/poll.test.ts`

**Interfaces:**
- 欄はワークフローの任意の選択（enum は `おまかせ` と `formBranches` の和集合、`required` に入れない）。候補が 2 つ以上のリポジトリがフォームの対象に無ければ欄を出さない（マニフェストも今と同じ）
- 解析: `向き先` の値が `おまかせ` か空なら `base` を持たない。選んだリポジトリの候補に無い値も `おまかせ` とみなす（spec 6 章の Claude の判断）
- `base:*` は `LABEL_SPECS` と `labelsHash` に入れない

- [ ] **Step 1: 失敗するテストを書く**
  - CF6: `branches` を持つ repos を読み書きでき、空文字や文字列でない値は拒む
  - IN19: `init --branches acme/app=develop,main` が設定に入り、再実行で消えない
  - SU29: fake-gh が `develop,main` を返すと候補を尋ねる。1 つなら尋ねない（既存の `FULL_INPUT` の setup はそのまま通る）
  - FM9: 候補があるとワークフローに `向き先` の選択（`おまかせ`・`develop`・`main`）が出て、`manifestHash` が変わる。候補が無ければ今と同じマニフェスト。「質問する」（`question`）のワークフローには候補があっても欄を出さない
  - PA25: `*向き先:* main` を読むと `fields.base === 'main'`。`おまかせ`・候補に無い値は `base` が無い
  - IB11: `issueLabels({ ...fields, base: 'main' }, true)` に `base:main` が入る
  - PO30: `base` のある投稿の起票で `label create base:main --force` を呼んでから `issue create` に `base:main` を渡す。`labels_hash` は変わらない
- [ ] **Step 2: 走らせて失敗を確かめる** — `cd apps/slack-issue-intake && bash test/run-all.sh` → FAIL（上の ID）
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 全体の検証** — `bash test/run-all.sh`、`pnpm --filter @tanaka-yui/slack-issue-intake check`、ルートで `node scripts/check-doc-lang.mjs` と `node scripts/check-shared-contracts.mjs` → 通る
- [ ] **Step 5: Commit して push** — `feat(slack-issue-intake): フォームに向き先の欄を足し、base ラベルを付けて起票する（0.9.0）`、`git push origin main`

## 段 3: autoMerge

### Task 9: 拾う元ごとの autoMerge

**Files:**
- Modify: `apps/orca-team-dispatch-task/lib/auto-config.ts`（`sources[]` に `autoMerge: boolean`、既定 false、`autoMerge && !autoReady` は `null`）、`lib/setup-draft.ts`（`autoMerge` が true のときだけ書き出す）
- Modify: `lib/auto-setup.ts`（`pickSources` で `autoReady` を使うと答えたあとに `autoMerge` を尋ねる）
- Modify: `lib/auto-tick.ts:935`（その Issue の拾う元の `autoMerge` が true なら理由を付けない）
- Modify: `lib/auto-comment.ts`（`auto-ready` の本文の「PR は人が確認してから merge します」を、`CommentInput.autoMerge?: boolean` が true のときは「条件がそろえば AI が merge します」にする）と `bin/orca-auto.ts` の呼び出し。共有の fixture は `auto-ready` の既存の例（autoMerge なし）を変えず、autoMerge ありの例は足さない
- Modify: `references/auto-judge.md` と `-ja` の 7 行目（autoReady の PR が必ず人の確認に回る記述を「拾う元の autoMerge が無効なら」に）、SKILL.md・guide-ja.md・README・CLAUDE.md、intake の README の 100 行目付近の一文
- Modify: 版 3.17.0
- Test: `test/unit/auto-config.test.ts`、`test/unit/auto-ready.test.ts`、`test/unit/auto-finish.test.ts`、`test/unit/setup-run.test.ts`、`test/test-docs.sh`

**Interfaces:**
- Consumes: `restrictedBase`（Task 4 の関門はそのまま効く。autoMerge でも main へは merge しない）

- [ ] **Step 1: 失敗するテストを書く**
  - AR8: `autoMerge: true` で `autoReady: false` の設定は `null`。`autoReady` と `autoMerge` が true の設定は読め、`configJsonFromDraft` を通しても残る
  - AU158: autoMerge の拾う元の auto-ready の Issue は、条件がそろえば `ai-merged`
  - AU159: autoMerge でも向き先が `baseBranch` でなければ In review（AU153 と同じ理由）
  - AU160: autoMerge が無効なら今までどおり「AI が Backlog から Ready にした Issue なので」の理由で In review
  - SU46: autoReady を使うと答えた拾う元でだけ autoMerge を尋ねる
  - SK46: `auto-judge.md` と `-ja` の autoReady の文が autoMerge に触れている（SK39/SK40 の固定の語を新しい文に合わせて直す）
- [ ] **Step 2: 走らせて失敗を確かめる** — `node --test test/unit/auto-config.test.ts test/unit/auto-ready.test.ts test/unit/auto-finish.test.ts test/unit/setup-run.test.ts`、`bash test/test-docs.sh` → FAIL
- [ ] **Step 3: 実装し、文書を書く**
- [ ] **Step 4: 全体の検証** — orca の `make test` と check、intake の `bash test/run-all.sh`、ルートの 2 つの検査 → 通る
- [ ] **Step 5: Commit して push** — `feat(orca-team-dispatch-task): 拾う元ごとの autoMerge で auto-ready の Issue も develop まで merge する（3.17.0）`、`git push origin main`
