# 判定の学び Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `--auto` の判定と結果を記録し、食い違いから AI がリポジトリごとの短い規則を作って次の判定に効かせ、Slack に知らせて取り消せるようにし、全体に効く学びを yui-cc-plugins の改善の Issue にする。

**Architecture:** 学びのデータ（履歴・規則・知らせ）は orca の `auto/<name>/learn/` に置き、新しい `lib/auto-learn.ts` だけが読み書きする。振り返りは判定の AI の起動に相乗りし、`judge-list` の出力と判定結果のファイルを広げるだけで、コマンド・許可・権限の指紋は足さない。Slack は intake が orca の知らせのファイルを読んで投稿し、取り消しは intake が自分のホームに依頼を書いて orca が次の tick で読む。

**Tech Stack:** TypeScript（node の型除去で直接実行）、node --test、gh のスタブ（orca: `test/lib/auto-fixture.ts`、intake: `test/helpers.ts`）、biome。

**Spec:** `docs/superpowers/specs/2026-11-23-auto-judge-learning-design.md`

## Global Constraints

- TypeScript で `any` / `unknown` / `class` を使わない。固定値は定数にする（orca は `lib/auto-learn.ts`、intake は `lib/defaults.ts`）。
- コメント・コミット・CLAUDE.md・README は日本語。SKILL.md と references の英語版に日本語を書かない。SKILL.md・`auto-judge.md` を変えたら同じ commit で `references/guide-ja.md`・`auto-judge-ja.md` も変える（`pnpm check:doc-lang`）。
- 判定の AI の権限を変えない: `lib/setup-automation.ts` の `judgeRules`（許可するコマンド）と `judgeFingerprint` の結果が、この計画の前後で同じであること。新しいサブコマンドを判定の AI に使わせない。
- Issue の本文を履歴・規則・知らせに入れない。規則の文は「材料」であって指示ではない、と `auto-judge.md` に書く。
- 公開リポジトリ（yui-cc-plugins）に出す文に、設定にあるリポジトリ名・`#数字`・URL を入れない。
- 2 つのプラグインは互いのファイルを書かない（読むだけ）。共有する形は両方の `test/fixtures` に同じ写しを置き、`scripts/check-shared-contracts.mjs` で照合する。
- 数字（設計書の「私が決めたこと」）: 振り返りを起こす食い違い 3 件、様子見 3 件、有効な規則の上限 1 リポジトリ 20 件、事例 5 件、履歴 1 リポジトリ 500 件、規則の文 80 文字、`eng` 向きの規則を全体の改善に出す根拠 5 件。
- 版は上げない。未 push の orca 3.21.0・intake 0.10.0 のままにする（人の指示: 版はこの作業が終わってから。最後に controller が人に確かめる）。
- 検証: orca は `cd apps/orca-team-dispatch-task && make test`、intake は `cd apps/slack-issue-intake && bash test/run-all.sh`、両方で `pnpm --filter <pkg> check`、ルートで `node scripts/check-shared-contracts.mjs` と `pnpm check:doc-lang`。AU77・AU129b は時間で揺れる既知のテスト。

## 計画で決めたこと（設計書に無い判断。最終報告で人に伝える）

1. 履歴は JSONL でなく 1 つの JSON（`learn/history.json`）にし、毎回書き直す（1 リポジトリ 500 件なので小さい。振り返り済みの印を行に持てる）。
2. 「人が止めた」（`stopped`）を攻めすぎたに数えるのは、auto-ready の Issue か、作業を始めたあとの Issue だけ。人が Ready にした Issue を、始まる前に人が動かしたのは、判定の誤りではなく人の予定の変更とみなす。
3. 時間切れは `failed`（判定が原因になりうる）に数える。`failed-env` にするのは、worker の起動の失敗・結果の報告の `envFailure`・失敗の時点でマシンにつながらない（`hostUnreachableSince`）の 3 つ。設計書の「中継の待ちによる時間切れ」は、上限時間が中継の待ちを含んでいて切り分けられないため、`failed` に入れる。
4. 振り返りの材料に出した食い違いは、案が出なくても「振り返り済み」にする（同じ材料で毎回 AI を起こさないため）。
5. Slack の取り消しへの返事は、intake が依頼を書いた時点で「取り消しを受け付けました。次の確認で反映します」と返す（orca が取り下げたあとではない）。
6. 全体の改善の案（`global`）は、Issue を作らない端末でも AI が出せる。その場合は知らせに「全体に効きそうな学び」の 1 行だけ足す。

## Review Focus

1. 判定結果のファイルが今までどおりの配列でも通る（古い形の互換）。→ Task 3 の LN12。
2. 様子見の残っている規則を見せた Issue を `auto` にして `rules` を書かない判定は受け付けない。→ Task 3 の LN13。
3. 環境が原因の失敗では規則を取り下げず、食い違いにも数えない。→ Task 2 の LN7、Task 4 の LN17。
4. 規則の文や題名に仕込まれた改行・URL・コードブロックが、保存も Slack への投稿もされない。→ Task 1 の LN4、Task 6 の LE3。
5. 公開リポジトリへ出す文にリポジトリ名・`#数字`・URL が入っていたら Issue を作らない。→ Task 7 の LN24。

---

### Task 1: 学びのデータの置き場所と純粋な計算（`lib/auto-learn.ts`）

**Files:**
- Create: `apps/orca-team-dispatch-task/lib/auto-learn.ts`
- Test: `apps/orca-team-dispatch-task/test/unit/auto-learn.test.ts`

**Interfaces:**
- Produces（後の全タスクが使う。名前と形を変えない）:

```ts
export const LEARN_DIR = 'learn'
export const LEARN_FILES = { history: 'history.json', rules: 'rules.json', notices: 'notices.json' } as const
export const LEARN_REFLECT_MIN = 3
export const LEARN_PROBATION = 3
export const LEARN_RULES_MAX = 20
export const LEARN_CASES_MAX = 5
export const LEARN_HISTORY_MAX = 500
export const LEARN_TOPIC_MAX = 80
export const LEARN_NOTICES_MAX = 50
export type Route = 'auto' | 'eng'
export type Outcome = 'merged-ai' | 'merged-human' | 'failed' | 'failed-env' | 'stopped' | 'eng-kept' | 'eng-returned'
export type HistoryRow = {
  key: string; repo: string; generation: number; title: string; labels: string[]
  aiRoute: Route; route: Route; forced: string; reason: string
  autoReady: boolean; started: boolean; ruleIds: string[]
  outcome: Outcome; at: string; reflected: boolean
}
export type Rule = {
  id: string; repo: string; direction: Route; topic: string; evidence: string[]
  createdAt: string; probationLeft: number; status: 'active' | 'withdrawn'; withdrawnWhy: string
  global: { issue: string; prNotified: boolean } | null
}
export type NoticeKind = 'new' | 'support' | 'withdrawn' | 'graduated' | 'global-issue' | 'global-pr' | 'global-hint'
export type NoticeItem = { n: number; kind: NoticeKind; ruleId: string; direction: Route; text: string; evidence: string[]; url: string }
export type Notice = { id: number; repo: string; at: string; items: NoticeItem[] }
export type Mismatch = { id: string; kind: 'cautious' | 'aggressive'; key: string; title: string; labels: string[]; reason: string; outcome: Outcome }
export type LearnStore = { rules: Rule[]; nextRule: number; nextNotice: number }

export const learnDir = (name: string): string                       // join(autoDir(name), LEARN_DIR)
export const readHistory = (name: string): HistoryRow[]              // 無ければ []。壊れていれば throw
export const writeHistory = (name: string, rows: HistoryRow[]): void // リポジトリごとに新しい LEARN_HISTORY_MAX 件に切って書く
export const readStore = (name: string): LearnStore                  // 無ければ { rules: [], nextRule: 1, nextNotice: 1 }
export const writeStore = (name: string, store: LearnStore): void
export const readNotices = (name: string): Notice[]
export const appendNotice = (name: string, store: LearnStore, repo: string, items: Omit<NoticeItem, 'n'>[], at: string): Notice
//   items に n を 1 から振り、store.nextNotice を id にして進め、notices.json を新しい LEARN_NOTICES_MAX 件に切って書く。store は呼び出し側が writeStore する
//   項目ごとに `学び: <repo> [<kind>] <text>` を console.log に 1 行出す（Slack が無くても tick・judge-apply の出力で分かるように）
export const mismatchesOf = (rows: HistoryRow[], repo: string): Mismatch[]
export const activeRules = (store: LearnStore, repo: string): Rule[]
export const similarCases = (rows: HistoryRow[], repo: string, title: string, labels: string[], limit?: number): Array<{ title: string; route: Route; outcome: Outcome }>
export const topicProblem = (topic: string): string                  // 問題が無ければ ''
```

- `Mismatch.id` は `<key>@<generation>`（慎重すぎたは `eng` の行の世代）。
- `mismatchesOf` の規則（`reflected` の行は返さない。大文字小文字はそのまま比べる）:
  - 慎重すぎた: `aiRoute === 'eng'`・`forced === ''`・`outcome === 'eng-returned'` の行があり、同じ key の次の世代（`generation + 1`）の行の outcome が `merged-ai` か `merged-human`。
  - 攻めすぎた: `aiRoute === 'auto'` で、outcome が `failed`、または `stopped` かつ（`autoReady` か `started`）。
- `similarCases`: 同じリポジトリの行から、題名とラベルの語の重なりが 1 以上のものを、重なりの多い順（同じなら新しい順）に `limit`（既定 `LEARN_CASES_MAX`）件。語は、題名を英数字の並びと、それ以外の文字の 2 文字ずつ（bigram）に分け、ラベルは名前そのまま 1 語とする。この関数 1 つに閉じる（後で差し替えるため）。
- `topicProblem`: 空・`LEARN_TOPIC_MAX` 文字超・改行・バッククォート・`http://`・`https://` のどれかがあれば、その理由の日本語の 1 行を返す。

- [ ] **Step 1: 失敗するテストを書く**

```ts
test('LN1 履歴は無ければ空、書いて読み直せ、リポジトリごとに新しい 500 件に切る', ...)
// acme/app の行を 501 件 + other/api の行を 1 件書く → 読むと acme/app は新しい 500 件、other/api は 1 件
test('LN2 mismatchesOf は慎重すぎた・攻めすぎたを返し、強制・環境・振り返り済み・始まる前の人の変更を除く', ...)
// 返す: (a) eng・forced ''・eng-returned の #1@1 と #1@2 merged-ai → cautious '#1@1'
//       (b) auto・failed の #2@1 → aggressive  (c) auto・stopped・started の #3@1 → aggressive  (d) auto・stopped・autoReady の #4@1
// 返さない: forced '新機能' の eng-returned、次の世代が failed の eng-returned、auto・failed-env、auto・stopped で autoReady も started も false、reflected: true の行
test('LN3 similarCases は語の重なりの多い順に 5 件までで、重なりの無い行と別のリポジトリの行を出さない', ...)
// 題名 'ログイン画面の文言を直す'・ラベル ['bug'] に対し、'ログイン画面のボタンの文言' > '設定画面の文言' > ラベル bug だけ重なる行。'DB migration' は出ない
test('LN4 topicProblem は空・81 文字・改行・バッククォート・URL を断り、80 文字の日本語を通す', ...)
test('LN5 appendNotice は項目に 1 からの番号を振り、id を進め、新しい 50 件に切る', ...)
```

- [ ] **Step 2: 失敗を確かめる** — Run: `cd apps/orca-team-dispatch-task && node --test test/unit/auto-learn.test.ts` / Expected: FAIL（モジュールが無い）
- [ ] **Step 3: 実装する**（書き込みは `lib/fs.ts` の `writeAtomic`、読み込みは `readJson`。フォルダは無ければ作る）
- [ ] **Step 4: 通ることを確かめる** — Run: `node --test test/unit/auto-learn.test.ts && pnpm --filter @tanaka-yui/orca-team-dispatch-task check` / Expected: PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(orca-team-dispatch-task): 判定の学びの履歴・規則・知らせの置き場所と、食い違い・似た事例の計算を足す"`

---

### Task 2: 判定と結果を履歴に残す

**Files:**
- Modify: `apps/orca-team-dispatch-task/lib/auto-state.ts`（`IssueState.learn` と読み込みの検査）
- Modify: `apps/orca-team-dispatch-task/lib/auto-learn.ts`（`recordOutcome`）
- Modify: `apps/orca-team-dispatch-task/bin/orca-auto.ts`（judge-apply で `issue.learn` を入れる。`delete state.issues[...]` の前）
- Modify: `apps/orca-team-dispatch-task/lib/auto-queue.ts`（新しい世代を作る前、`delete state.issues[...]` の前、`makeIssue`）
- Modify: `apps/orca-team-dispatch-task/lib/auto-tick.ts`（世代が終わる箇所、`delete tick.state.issues[...]` の前）
- Modify: `apps/orca-team-dispatch-task/lib/auto-transition.ts`（遷移が終わったとき）
- Test: `apps/orca-team-dispatch-task/test/unit/auto-learn-record.test.ts`

**Interfaces:**
- Consumes: Task 1 の型・`readHistory`・`writeHistory`。
- Produces:
  - `IssueState.learn: { aiRoute: Route; forced: string; ruleIds: string[]; recorded: boolean } | null`（状態ファイルに無ければ null で読む。`makeIssue` と新しい世代は null）
  - `export const recordOutcome = (name: string, issue: IssueState, labels: string[], outcome: Outcome, at: string): boolean` — `issue.learn` が null か `recorded` なら何もしないで false。そうでなければ履歴に 1 行足し（`route` は `issue.phase === 'eng'` か outcome が `eng-*` なら `'eng'`、それ以外 `'auto'`。`started` は `issue.startedAt !== null`。`reflected: false`）、`issue.learn.recorded = true` にして true。状態の保存は呼び出し側。
- 結果の対応（この表のとおりに呼ぶ）:

| 出来事 | outcome |
|---|---|
| `ai-merged` の遷移が終わり `done` になった | `merged-ai` |
| `human-merged` の遷移が終わり `done` になった | `merged-human` |
| `failed` の遷移が終わった | 下の環境の条件なら `failed-env`、それ以外 `failed` |
| 人の変更で `stopped` になった（`humanStop`・`cancelTransition`・`syncIssues` と `watchReview` が `phase = 'stopped'` にする箇所・レビュー中に閉じられた） | `stopped` |
| `eng` の Issue が拾い直されて新しい世代になる（`syncIssues` の `from === 'eng'`）。世代を進める前に呼ぶ | `eng-returned` |
| `eng` の Issue が閉じられて記録から消える | `eng-kept` |
| 判定の前（`issue.learn` が null）に消える・止まる | 何も書かない |

- 環境の条件（`failed-env`）: 失敗の理由が worker の起動の失敗（`auto-tick.ts:237` の文）、結果の報告の `envFailure` がある、失敗の時点で `issue.hostUnreachableSince !== null`。判定に使う印は `failReason` の文字列比較でなく、失敗を記録する箇所で分かる真偽を `IssueState` に持たせる（例: `failEnv: boolean`。名前は任せる。新しい世代で false に戻す）。
- judge-apply は、受け付けた判定ごとに `issue.learn = { aiRoute: decision.route, forced, ruleIds: [], recorded: false }` を入れる。`forced` は CLI が向きを `eng` に変えた理由（`feature` なら `'新機能'`、対象が 3 つ以上なら `'3 リポジトリ以上'`、変えていなければ `''`）。`ruleIds` は Task 3 が入れる。
- ラベルは、その箇所で読んでいる Issue のラベル（`viewIssue` の結果など）を渡す。読んでいない箇所では `[]` でよい。

- [ ] **Step 1: 失敗するテストを書く**

```ts
test('LN6 recordOutcome は判定のある世代を 1 回だけ履歴に書く', ...)
// learn が null → false で履歴は空。learn あり → 1 行（key・generation・aiRoute・forced・autoReady・started・outcome・reflected:false）。2 回目は false
test('LN7 judge-apply は AI の向きと強制の理由を残し、失敗は環境が原因かどうかで failed と failed-env に分かれる', ...)
// 新機能の Issue を auto と判定 → state の learn は { aiRoute:'auto', forced:'新機能' }。
// worker の起動の失敗で failed になった Issue → 履歴の outcome は 'failed-env'。worker が失敗を報告（envFailure 無し）→ 'failed'
test('LN8 エンジニア行きから拾い直すと eng-returned を、閉じて消えると eng-kept を書く', ...)
test('LN9 人が merge した Issue は merged-human、AI が merge した Issue は merged-ai、人が止めた Issue は stopped を書く', ...)
```

既存のテストの仕組み（`test/lib/auto-fixture.ts`・`auto-runtime-fixture.ts`、`test/unit/auto-ready.test.ts` や tick を回すテスト）を真似る。

- [ ] **Step 2: 失敗を確かめる** — Run: `node --test test/unit/auto-learn-record.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装する** — `delete state.issues[...]` / `delete tick.state.issues[...]` の全箇所（`grep -n "delete .*issues\[" lib bin`）と、`phase = 'stopped'` にする全箇所を洗い、上の表に当てる。遷移の完了は `resumeTransition` の終わり（`issue.phase = pending.then` のあと）で `pending.event` を見る。`recordOutcome` に渡す `name` が届かない関数には、引数で渡す（グローバルを足さない）。
- [ ] **Step 4: 通ることを確かめる** — Run: `make test && pnpm --filter @tanaka-yui/orca-team-dispatch-task check` / Expected: PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(orca-team-dispatch-task): 判定と結果を Issue の世代ごとに履歴へ残す"`

---

### Task 3: 振り返りと、規則・事例を判定に渡す

**Files:**
- Modify: `apps/orca-team-dispatch-task/lib/auto-learn.ts`（`reflectDue`・`applyLearn`）
- Modify: `apps/orca-team-dispatch-task/bin/orca-auto.ts`（`judge-list` の出力、`judge-apply` の入力、`status`）
- Modify: `apps/orca-team-dispatch-task/lib/auto-tick.ts`（終了コード、学びの 1 行）
- Modify: `apps/orca-team-dispatch-task/skills/orca-team-dispatch-task/references/auto-judge.md` と `auto-judge-ja.md`
- Modify: `SKILL.md`・`references/guide-ja.md`（`--auto` の節に学びの段落）、`README.md`、`CLAUDE.md`
- Test: `apps/orca-team-dispatch-task/test/unit/auto-learn-judge.test.ts`

**Interfaces:**
- Consumes: Task 1・2。
- Produces:
  - `export const reflectDue = (rows: HistoryRow[], repos: string[]): string[]` — `mismatchesOf` が `LEARN_REFLECT_MIN` 件以上のリポジトリ。
  - `judge-list` の出力に足すもの:
    - 各 Issue に `learned: { rules: Array<{ id: string; direction: Route; topic: string; probation: boolean }>; cases: Array<{ title: string; route: Route; outcome: Outcome }> }`（`probation` は `direction === 'auto' && probationLeft > 0`）
    - 最上位に `reflect: Array<{ repo: string; mismatches: Mismatch[]; rules: Array<{ id: string; direction: Route; topic: string; evidence: string[] }> }>`（`reflectDue` のリポジトリだけ。無ければ `[]`）
    - `judge/pending.json` にも同じ内容が残る（`judge-apply` が、見せた食い違いと様子見の規則を知るため）
  - 判定結果のファイルは、今までの配列か、`{ decisions: [...今までの行...], learn: [...案...] }` のどちらか。
  - 判定の行に足す項目: `rules: string[]`（`auto` にした理由で頼った `auto` 向きの規則の id。頼っていなければ `[]`）。`judge-list` がその Issue に `probation: true` の規則を見せていて、向きが `auto` なのに `rules` が配列でなければ、その行を断る（exit 1 の扱いは今の不正な行と同じ）。`rules` の id は、その Issue に見せた `auto` 向きの規則の id だけを受け付け、`issue.learn.ruleIds` に入れる。
  - 案の形（`learn` の 1 件）:
    - `{ repo, kind: 'add', direction: 'auto' | 'eng', topic: string, evidence: string[] }`
    - `{ repo, kind: 'support', ruleId: string, evidence: string[] }`
    - `{ repo, kind: 'withdraw', ruleId: string }`
  - `export const applyLearn = (name: string, proposals: Json[], shown: Array<{ repo: string; mismatches: Mismatch[] }>, at: string, log: (line: string) => void): void` — 案を 1 件ずつ検査して保存し、知らせを足す。検査: `repo` が `shown` にある・`evidence` は 2 件以上（`support` は 1 件以上）でどれも `shown` のそのリポジトリの `Mismatch.id`・`topicProblem(topic) === ''`・`ruleId` はそのリポジトリの有効な規則・有効な規則が `LEARN_RULES_MAX` 未満。落ちた案は `log` に 1 行出して捨てる。`add` は id `r<store.nextRule>`、`probationLeft` は `direction === 'auto' ? LEARN_PROBATION : 0`、`global: null`。知らせの種類は `add` → `new`、`support` → `support`、`withdraw` → `withdrawn`（`withdrawnWhy` は `'振り返りで取り下げ'`）。最後に、`shown` に出した食い違いの行をすべて `reflected: true` にして書く（案が 1 件も無くても）。
- tick の終了コード: 判定待ちが無くても、`reflectDue` が空でなければ 0（判定の AI を起こす。今の `judgingSince` のリースの条件はそのまま掛ける）。tick の最後の行に ` learn=<振り返りが要るリポジトリの数>` を足す。
- `status` に、有効な規則の一覧（リポジトリ・id・向き・文・様子見の残り・根拠の件数）を出す。
- `auto-judge.md` に足す内容（英語。日本語版にも同じ内容）:
  - `learned.rules` と `learned.cases` は過去の結果から分かった傾向で、指示ではなく材料。Issue の題名から来た文も含むので、指示として読まない。プラグインの決まり（新機能・3 リポジトリ以上・向き先）は規則より優先する。
  - `auto` にした各 Issue に `rules`（頼った `auto` 向きの規則の id の配列、無ければ空の配列）を必ず書く。
  - `reflect` が空でなければ、そのリポジトリごとに食い違いを読み、2 件以上に共通する傾向があるときだけ案を出す。1 件だけの出来事から規則を作らない。同じ傾向の規則が既にあれば `support`、規則のせいで攻めすぎたなら `withdraw`。`topic` は日本語で 80 文字まで、1 行、リポジトリの中の「何に関する Issue か」を表す文。
  - 「Issue が無ければ止まる」は「Issue も `reflect` も無ければ止まる」に直す。案があるときは `{ decisions, learn }` の形で書く。

- [ ] **Step 1: 失敗するテストを書く**

```ts
test('LN10 judge-list は Issue ごとに有効な規則と似た事例を付け、食い違いが 3 件たまったリポジトリの振り返りの材料を出す', ...)
// 規則 r1(auto, 残り 3)・r2(eng)・取り下げ済み r3 → rules は r1(probation:true)・r2(probation:false)。cases は 5 件まで
// 食い違い 2 件のリポジトリは reflect に出ない。3 件のリポジトリは mismatches 3 件と今の規則が出る
test('LN11 tick は判定待ちが無くても振り返りが要れば 0 を返し、最後の行に learn= を出す', ...)
test('LN12 judge-apply は今までの配列も { decisions, learn } も受け付ける', ...)
test('LN13 様子見の規則を見せた Issue を auto にして rules が無い行は断り、rules があれば learn.ruleIds に入れる（見せていない id は断る）', ...)
test('LN14 applyLearn は add・support・withdraw を保存して知らせを足し、形の合わない案・材料に無い根拠・21 件目を捨て、見せた食い違いを振り返り済みにする', ...)
// topic に改行 → 捨てて log 1 行。evidence が 1 件の add → 捨てる。案が空でも mismatches は reflected:true になり、次の reflectDue は空
test('LN15 judgeRules と judgeFingerprint は変わらない', ...)
// lib/setup-automation.ts の judgeRules(config, launcher).allow（名前は実物に合わせる）に learn を含むコマンドが無いこと
```

- [ ] **Step 2: 失敗を確かめる** — Run: `node --test test/unit/auto-learn-judge.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確かめる** — Run: `make test && pnpm --filter @tanaka-yui/orca-team-dispatch-task check && cd ../.. && pnpm check:doc-lang` / Expected: PASS（`test/test-docs.sh` が `auto-judge.md` や SKILL.md の文を固定していれば、その期待も直す）
- [ ] **Step 5: Commit** — `git commit -m "feat(orca-team-dispatch-task): 食い違いがたまったら判定の AI が振り返り、規則と似た事例を次の判定の材料にする"`

---

### Task 4: 様子見（新しい `auto` 向きの規則で自動にした Issue は人が確認する）

**Files:**
- Modify: `apps/orca-team-dispatch-task/lib/auto-learn.ts`（`onProbation`・`settleRules`）
- Modify: `apps/orca-team-dispatch-task/lib/auto-tick.ts`（merge の関門の理由。`reasons.push` が並ぶ箇所）
- Modify: `apps/orca-team-dispatch-task/lib/auto-learn.ts` の `recordOutcome`（結果を書いたあとに `settleRules` を呼ぶ）
- Modify: SKILL.md・guide-ja.md・CLAUDE.md（様子見の段落）
- Test: `apps/orca-team-dispatch-task/test/unit/auto-learn-probation.test.ts`

**Interfaces:**
- Consumes: Task 1〜3（`issue.learn.ruleIds`、`LearnStore`、`appendNotice`）。
- Produces:
  - `export const onProbation = (store: LearnStore, ruleIds: string[]): boolean` — `ruleIds` のどれかが有効で `probationLeft > 0`。
  - `export const settleRules = (name: string, row: HistoryRow, at: string): void` — `row.ruleIds` の有効で様子見の残っている規則について: outcome が `merged-human` なら `probationLeft` を 1 減らし、0 になったら知らせ `graduated`。outcome が `failed`、または `stopped` かつ（`autoReady` か `started`）なら取り下げ（`withdrawnWhy` は `'様子見の Issue が失敗または人が止めた'`）て知らせ `withdrawn`。`failed-env`・`merged-ai`・それ以外は何もしない。
  - merge の関門: `issue.learn` があり `onProbation(store, issue.learn.ruleIds)` なら、理由 `新しい学びで自動にした Issue なので、merge の前に人が確認します。` を足す（ほかの理由と同じく In review に回る）。

- [ ] **Step 1: 失敗するテストを書く**

```ts
test('LN16 様子見の規則に頼った Issue は条件がそろっても AI が merge せず、理由を付けて人の確認に回る。様子見を終えた規則なら merge する', ...)
test('LN17 人が merge すると残りが 1 減り、3 件目で graduated の知らせが出る。失敗か人が止めると規則を取り下げ、環境が原因の失敗では何も変えない', ...)
```

- [ ] **Step 2: 失敗を確かめる** — Run: `node --test test/unit/auto-learn-probation.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確かめる** — Run: `make test && pnpm --filter @tanaka-yui/orca-team-dispatch-task check && cd ../.. && pnpm check:doc-lang` / Expected: PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(orca-team-dispatch-task): 新しい学びで自動にした Issue は最初の 3 件だけ人が確認し、失敗したら規則を取り下げる"`

---

### Task 5: 共有の形と、orca が取り消しの依頼を読む

**Files:**
- Create: `apps/orca-team-dispatch-task/test/fixtures/learn-notices.json`、`apps/orca-team-dispatch-task/test/fixtures/learn-cancels.json`（intake にも同じ写しを同じ名前で置く）
- Modify: `scripts/check-shared-contracts.mjs`（2 つの fixture の一致、orca の `readNotices` が notices の fixture を読めること）
- Modify: `apps/orca-team-dispatch-task/lib/auto-learn.ts`（`applyCancels`）
- Modify: `apps/orca-team-dispatch-task/lib/auto-tick.ts`（tick の始めのほうで呼ぶ）
- Test: `apps/orca-team-dispatch-task/test/unit/auto-learn-cancel.test.ts`

**Interfaces:**
- Produces（intake の Task 6 が使う。形を変えない）:
  - 知らせ: `<auto/<name>>/learn/notices.json` = `{ "version": 1, "notices": Notice[] }`（Task 1 の `Notice`）。intake は、定期報告の材料のパス（`report.source` = `<auto/<name>>/report.json`）と同じフォルダの `learn/notices.json` を読む。
  - 取り消しの依頼: `<intake のホーム>/learn-cancels.json` = `{ "version": 1, "cancels": Array<{ noticeId: number; n: number; ruleId: string; at: string }> }`。orca は `config.intakeConfigs` の各パスの親フォルダからこの名前のファイルを読む。
  - `export const LEARN_CANCELS_FILE = 'learn-cancels.json'`（orca `lib/auto-learn.ts`）。intake は `lib/defaults.ts` に同じ値の定数を持ち、`check-shared-contracts.mjs` が照合する。
  - `export const applyCancels = (name: string, homes: string[], at: string, log: (line: string) => void): number` — 各ホームの依頼を読み、`ruleId` が有効な規則なら取り下げ（`withdrawnWhy` は `'Slack で取り消し'`）て知らせ `withdrawn` を足す。既に取り下げ済み・知らない id は黙って飛ばす（依頼は残り続けるので、何度読んでも同じ結果にする）。読めないファイルは `log` に 1 行。戻り値は取り下げた数。

- [ ] **Step 1: 失敗するテストを書く**

```ts
test('LN18 applyCancels は有効な規則だけを取り下げて知らせを 1 回足し、同じ依頼を 2 回読んでも 2 回目は何もしない。壊れたファイルは 1 行出して続ける', ...)
test('LN19 fixture の learn-notices.json は readNotices で読め、learn-cancels.json は applyCancels が読める', ...)
```

- [ ] **Step 2: 失敗を確かめる** — Run: `node --test test/unit/auto-learn-cancel.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装する**（fixture は規則 2 件の知らせ 1 つと、取り消し 1 件。intake 側の写しもこのタスクで置く）
- [ ] **Step 4: 通ることを確かめる** — Run: `make test && node ../../scripts/check-shared-contracts.mjs` / Expected: PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(orca-team-dispatch-task): 学びの知らせと取り消しの依頼の形を決め、取り消しの依頼を tick で読む"`

---

### Task 6: intake が学びを Slack に知らせ、返信の取り消しを受け付ける

**Files:**
- Create: `apps/slack-issue-intake/lib/learn.ts`
- Modify: `apps/slack-issue-intake/lib/defaults.ts`（文面・定数・meta の鍵）、`lib/commands/poll.ts`（`postReport` のあとで呼ぶ）
- Modify: `apps/slack-issue-intake/README.md`、`CLAUDE.md`、`skills/slack-issue-intake/SKILL.md` と `references/guide-ja.md`
- Test: `apps/slack-issue-intake/test/learn.test.ts`

**Interfaces:**
- Consumes: Task 5 の 2 つの形と fixture、intake の `postMessage`・`postThread`・`fetchReplies`（`lib/slack-api.ts`）、`getMeta`・`writeMetaFenced`（`lib/db.ts`）、`repoSetting`（`lib/config.ts`）。
- Produces:
  - `export const LEARN_CANCELS_FILE = 'learn-cancels.json'`、`export const LEARN_NOTICES_PATH = 'learn/notices.json'`（`lib/defaults.ts`）
  - `export const syncLearn = async (ctx: DriveContext): Promise<{ posted: number; cancelled: number; errors: string[] }>`
- 動き:
  - `config.report.source` が無ければ何もしない。あれば同じフォルダの `learn/notices.json` を読む（無ければ何もしない。壊れていれば errors に 1 行）。
  - そのホームのリポジトリ（`repoSetting` で照合）の知らせだけを扱う。
  - まだ投稿していない知らせ（id が meta の「最後に投稿した id」より大きい）を、id の小さい順に定期報告のチャンネル（`report.channel ?? config.channel`）へトップレベルで投稿し、meta に「最後に投稿した id」と「id → ts」を残す。1 回の poll で 5 件まで。
  - 投稿の文面（`defaults.ts` に置く。`{…}` を埋める）:

```
🧠 判定の学び（{repo}）
{n}. {text}（{kind の言い方}）
   根拠: {evidence を空白で並べたもの}
取り消すときは、このスレッドに「取り消し 1」のように番号を返信してください
```

    `kind` の言い方: `new` で `direction` が `auto` → `今後は自動で進めます。最初の 3 件は人が確認します`、`new` で `eng` → `今後はエンジニアに回します`、`support` → `根拠が増えました`、`withdrawn` → `取り下げました`、`graduated` → `様子見を終えました`、`global-issue` → `全体の改善として Issue を作りました {url}`、`global-pr` → `改善の PR ができました {url}`、`global-hint` → `全体に効きそうな学びです`。取り消しの案内の行は、`new` か `support` の項目がある知らせにだけ付ける。`text`・`evidence` は Slack の記法を無効にして出す（`lib/slack-text.ts` の `escapeMrkdwn`）。根拠の行は、`evidence` が空なら出さない。
  - 取り消し: 投稿済みの知らせのうち新しい 20 件のスレッドの返信を読み、本文が `取り消し <番号>`（前後の空白と全角数字を許す）に合う返信ごとに、その知らせの `n === 番号` の項目の `ruleId` を `<ホーム>/learn-cancels.json` に足す（同じ `noticeId`・`n` は 1 回だけ）。足したら、そのスレッドに `取り消しを受け付けました。次の確認で反映します` と返信する。番号が無い・項目が `new` でも `support` でもない返信は無視する。自分の返信は読まない（処理済みの返信の ts を meta に残す）。
  - リースと締め切りの扱いは `postReport` と同じ（`valid()` の形を真似る）。Claude は起こさない。
- poll の結果の行に `learn=<投稿数>/<取り消し数>` を足す。

- [ ] **Step 1: 失敗するテストを書く**

```ts
test('LE1 まだ投稿していない学びの知らせを定期報告のチャンネルへ投稿し、次の poll では投稿し直さない。ほかのホームのリポジトリの知らせは出さない', ...)
test('LE2 スレッドの「取り消し 1」で learn-cancels.json に依頼を 1 回だけ書き、受け付けの返信をする。番号の無い項目・関係ない返信は無視する', ...)
test('LE3 規則の文と根拠は Slack の記法を無効にして出す（<!channel> や *太字* がそのまま効かない）', ...)
test('LE4 report.source が無い・notices.json が無いときは何もしない。壊れた notices.json は errors に 1 行', ...)
```

- [ ] **Step 2: 失敗を確かめる** — Run: `cd apps/slack-issue-intake && node --test test/learn.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確かめる** — Run: `bash test/run-all.sh && pnpm --filter @tanaka-yui/slack-issue-intake check && cd ../.. && node scripts/check-shared-contracts.mjs && pnpm check:doc-lang` / Expected: PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(slack-issue-intake): 判定の学びを定期報告のチャンネルに知らせ、スレッドの返信で取り消しを受け付ける"`

---

### Task 7: 全体に効く学びを yui-cc-plugins の改善の Issue にする

**Files:**
- Modify: `apps/orca-team-dispatch-task/lib/auto-config.ts`（`learn.issueRepo`）、`lib/setup-draft.ts`、`lib/auto-setup.ts`（質問）
- Modify: `apps/orca-team-dispatch-task/lib/auto-learn.ts`（`globalProblems`・`proposeGlobal`・`notifyGlobalPrs`）
- Modify: `apps/orca-team-dispatch-task/bin/orca-auto.ts`（`judge-list` の `reflect` と全体の案の材料、`judge-apply` の `global` の案）
- Modify: `apps/orca-team-dispatch-task/lib/auto-tick.ts`（merge の関門の理由、`notifyGlobalPrs`）
- Modify: `auto-judge.md`・`auto-judge-ja.md`、SKILL.md・guide-ja.md、README、CLAUDE.md
- Test: `apps/orca-team-dispatch-task/test/unit/auto-learn-global.test.ts`、setup の質問を試しているテストのファイル

**Interfaces:**
- Consumes: Task 1〜5。
- Produces:
  - 設定: `AutoConfig.learn: { issueRepo: string | null }`（無ければ `{ issueRepo: null }`。値は `owner/name` の形だけ受け付ける）。
  - `export const LEARN_PLUGIN_REPO = 'tanaka-yui/yui-cc-plugins'`、`export const LEARN_LABEL = 'judge-learning'`、`export const LEARN_GLOBAL_ENG_EVIDENCE = 5`、`export const LEARN_GLOBAL_BODY_MAX = 2000`、`export const LEARN_GLOBAL_TITLE_MAX = 80`（`lib/auto-learn.ts`）
  - setup の質問（`make auto-setup` の段。拾う元の段の近く）: `判定の学びを、<LEARN_PLUGIN_REPO> の改善の Issue として出しますか（y/n）`、既定は今の設定（無ければ n）。`y` のとき `gh api repos/<LEARN_PLUGIN_REPO> --jq .permissions.push` が `true` でなければ、`書き込む権限が無いので出せません` と出して n にする。`y` なら続けて 1 行: `同じリポジトリを拾う --auto は 1 台だけにしてください。<LEARN_PLUGIN_REPO> を拾う元に入れた --auto が、改善の Issue を実装します`。この質問は拾う元を変えない。
  - `judge-list` の最上位に `global: { enabled: boolean; candidates: Array<{ ruleId: string; repo: string; direction: Route; topic: string; evidenceCount: number }> }`。`candidates` は、有効・`global === null`・（`auto` 向きなら `probationLeft === 0`、`eng` 向きなら根拠が `LEARN_GLOBAL_ENG_EVIDENCE` 件以上）の規則。`candidates` が空でなく判定待ちも振り返りも無いときは、それだけでは AI を起こさない（次に起きたときに一緒に見る）。
  - 案の形に足す 1 つ: `{ kind: 'global', ruleId: string, title: string, body: string }`。
  - `export const globalProblems = (title: string, body: string, repos: string[]): string[]` — 題が空・`LEARN_GLOBAL_TITLE_MAX` 超、本文が空・`LEARN_GLOBAL_BODY_MAX` 超、題か本文に `repos` のどれか（`owner/name` の全体、または `/` の後ろの名前。大文字小文字を無視）・`#` に数字が続く並び・`http://`・`https://` がある。それぞれ日本語の 1 行。
  - `export const proposeGlobal = (name: string, config: AutoConfig, proposal: { ruleId: string; title: string; body: string }, at: string, log: (line: string) => void): void` — 規則が `candidates` の条件に合わなければ捨てる。`globalProblems`（`repos` は `config.repos` の鍵と `config.sources` の `repo`・`related`）に 1 つでも掛かれば、作らずに `log` に 1 行。`config.learn.issueRepo` が null なら、Issue を作らずに知らせ `global-hint`（`text` は題）を足し、`rule.global = { issue: '', prNotified: true }` にする。null でなければ、`LEARN_LABEL` のラベルを無ければ作り（`ensureStatusLabels` と同じやり方）、ステータスのラベルも無ければ作り、`gh issue create --repo <issueRepo> --title <title> --body <body> --label Ready --label slack-thread --label judge-learning` で作って、`rule.global = { issue: '<issueRepo>#<番号>', prNotified: false }` にし、知らせ `global-issue`（`url` は Issue の URL）を足す。作れなければ `log` に 1 行出して規則は変えない（次の振り返りでまた出せる）。
  - `export const notifyGlobalPrs = (name: string, state: AutoState, at: string): void` — `rule.global` があり `prNotified === false` の規則ごとに、`state.issues[rule.global.issue]` が `review` で PR があれば、知らせ `global-pr`（`url` は最初の PR の URL）を足して `prNotified = true`。tick の終わりに呼ぶ。
  - merge の関門: Issue に `LEARN_LABEL` のラベルがあれば、理由 `判定の基準を変える PR は人が merge します。` を足す。ラベルは、関門がその tick で読んだ Issue のラベルを使う（読んでいなければ `viewIssue` で読む。読めなければ merge しない）。
- `auto-judge.md` に足す内容: `global.candidates` の規則のうち、リポジトリの事情でなく、どのリポジトリでも成り立つ判定の基準だと言えるものだけ、`global` の案を出す。題と本文は英語で、一般化した規則と件数だけを書き、リポジトリ名・Issue の番号・題名・本文・URL を書かない。本文には `skills/orca-team-dispatch-task/references/auto-judge.md` のどの段落をどう直すかを書く。

- [ ] **Step 1: 失敗するテストを書く**

```ts
test('LN20 設定の learn.issueRepo は無ければ null、owner/name 以外を断る', ...)
test('LN21 setup の質問は権限があれば y を受け付けて issueRepo を残し、権限が無ければ断って null のまま、拾う元は変えない', ...)
test('LN22 judge-list の global.candidates は様子見を終えた auto の規則と根拠 5 件以上の eng の規則だけで、既に出した規則を除く', ...)
test('LN23 proposeGlobal は Ready・slack-thread・judge-learning を付けて Issue を作り、規則に Issue の key を残して知らせを足す。issueRepo が null なら Issue を作らず global-hint を足す', ...)
test('LN24 題か本文にリポジトリ名・#数字・URL があれば Issue を作らず 1 行出し、規則は変えない', ...)
// 'acme/app'・'app の修正'・'#41'・'https://example.com' のそれぞれで gh issue create が呼ばれない
test('LN25 judge-learning の Issue は条件がそろっても AI が merge せず人の確認に回り、PR ができたら global-pr の知らせを 1 回だけ足す', ...)
```

- [ ] **Step 2: 失敗を確かめる** — Run: `node --test test/unit/auto-learn-global.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確かめる** — Run: `make test && pnpm --filter @tanaka-yui/orca-team-dispatch-task check && cd ../.. && pnpm check:doc-lang && node scripts/check-shared-contracts.mjs` / Expected: PASS。LN15（`judgeRules` と `judgeFingerprint` が変わらない）が通ったままであること。
- [ ] **Step 5: Commit** — `git commit -m "feat(orca-team-dispatch-task): 全体に効く学びを yui-cc-plugins の改善の Issue にし、判定の基準を変える PR は人が merge する"`

---

### Task 8: 改善の Issue を公開する前に、人が Slack で全文を読んで承認する

実行中に足したタスク。自動のセキュリティレビューが、Task 7 の「AI が書いた題と本文を、検査だけで公開リポジトリに出す」作りに、検査のすり抜けを 4 回続けて見つけた。4 回目の直しの担当が洗い出した残りの抜け道（語の一部の短い名前・owner だけ・区切り違い・一覧に無い名前・GitHub の表示で名前になる綴り・NFKC で揃わない文字・符号化）は、言葉の検査では塞げない。そこで、公開の前に人が全文を読んで承認する段を足す。検査（`globalProblems`）は残し、下書きを作るときと公開するときの両方で掛ける。

**Files:**
- Modify: `apps/orca-team-dispatch-task/lib/auto-learn.ts`（下書き・公開の依頼・公開）
- Modify: `apps/orca-team-dispatch-task/bin/orca-auto.ts`（`status` に下書きを出す。人が使う `learn-publish`）
- Modify: `apps/orca-team-dispatch-task/lib/auto-tick.ts`（公開の依頼を読む）
- Modify: 両プラグインの `test/fixtures/learn-notices.json`・`learn-cancels.json`（同じ写し）、`scripts/check-shared-contracts.mjs`
- Modify: `apps/slack-issue-intake/lib/learn.ts`・`lib/defaults.ts`（下書きの表示、「公開 <番号>」の返信）
- Modify: 文書（orca: SKILL.md・guide-ja.md・`auto-judge.md`・`auto-judge-ja.md`・README・CLAUDE.md。intake: README・SKILL.md・guide-ja.md・CLAUDE.md）と、設計書 `docs/superpowers/specs/2026-11-23-auto-judge-learning-design.md` の 6 節（承認の段を足したことを書く）
- Test: `apps/orca-team-dispatch-task/test/unit/auto-learn-global.test.ts`、`apps/slack-issue-intake/test/learn.test.ts`

**Interfaces:**
- Consumes: Task 5〜7（`proposeGlobal`・`applyCancels`・`globalProblems`・`appendNotice`・intake の `syncLearn`）。
- Produces:
  - `Rule.global` の形を `{ issue: string; prNotified: boolean; draft: { title: string; body: string } | null } | null` にする（保存済みのファイルに `draft` が無ければ null で読む）。
  - 知らせの種類に `global-draft` を足す。`NoticeItem` に `body: string` を足す（`global-draft` だけ本文を入れ、ほかは `''`。保存済みの知らせに無ければ `''` で読む）。
  - 取り消しの依頼のファイル（`learn-cancels.json`）の 1 件に `action: 'cancel' | 'publish'` を足す（無ければ `'cancel'` で読む）。ファイル名と定数は変えない。
  - `proposeGlobal`: `issueRepo` が null でないとき、Issue を作らない。`globalProblems` を通った案を下書きとして残し（`rule.global = { issue: '', prNotified: false, draft: { title, body } }`）、知らせ `global-draft`（`text` は題、`body` は本文）を足す。`issueRepo` が null のときは今までどおり `global-hint`。
  - `export const publishGlobal = (name: string, config: AutoConfig, ruleId: string, at: string, log: (line: string) => void): boolean` — 規則に下書きがあり、まだ Issue が無いときだけ動く。`globalProblems` をもう一度掛け（設定が変わっているかもしれないため）、通れば Task 7 の作り方（ラベルを確かめて `gh issue create --label Ready --label slack-thread --label judge-learning`）で Issue を作り、`rule.global = { issue: '<issueRepo>#<番号>', prNotified: false, draft: null }` にして知らせ `global-issue` を足す。作れなければ下書きを残して false（次の依頼・次の tick でやり直せる）。検査に落ちたら下書きを捨て（`{ issue: '', prNotified: true, draft: null }`）、1 行出す。
  - `applyCancels`: `action === 'publish'` の依頼は、その `ruleId` に下書きがあれば `publishGlobal` を呼ぶ。下書きが無い・Issue が既にある依頼は黙って飛ばす（依頼は残り続けるので、何度読んでも同じ結果にする）。`action === 'cancel'` で、その規則に下書きがあれば、規則は取り下げずに下書きだけ捨てる（`{ issue: '', prNotified: true, draft: null }`。知らせは足さない）。下書きの無い規則への `cancel` は今までどおり規則を取り下げる。
  - 人が端末で公開する道: `orca-auto learn-publish --name <名前> --rule <規則の id>`（`publishGlobal` を呼ぶ。判定の AI に許すコマンドには足さない。LN15 が通ったままであること）。`status` は下書きのある規則に題と本文を出す。
  - intake（`lib/learn.ts`）:
    - `global-draft` の項目は、番号・題・本文を出す（本文は `escapeMrkdwn` を掛け、装飾を無効にした投稿のまま）。その知らせの最後に `公開してよければ、このスレッドに「公開 1」のように番号を返信してください。出さないなら「取り消し 1」と返信してください` を付ける。
    - 返信 `公開 <番号>`（前後の空白と全角数字を許す）は、その番号の項目が `global-draft` のときだけ、`learn-cancels.json` に `action: 'publish'` の依頼を足し（同じ `noticeId`・`n`・`action` は 1 回だけ）、`公開を受け付けました。次の確認で Issue を作ります` と返信する。`global-draft` の項目への `取り消し <番号>` は `action: 'cancel'` の依頼を足す（今の取り消しと同じ返事）。
    - 受け付けの返事のやり直し（`acked`）は、`cancel` と `publish` を別々に数える。
- `auto-judge.md`: 全体の改善の案は、すぐには公開されず、人が Slack で全文を読んで承認したあとに Issue になる、と書く。題と本文の書き方（一般化した規則と件数だけ）は変えない。

- [ ] **Step 1: 失敗するテストを書く**

```ts
// orca（auto-learn-global.test.ts）
test('LN26 proposeGlobal は issueRepo があっても Issue を作らず、下書きと global-draft の知らせ（題と本文）を残す', ...)
// gh issue create が呼ばれない。rule.global.draft に題と本文。知らせの item.kind === 'global-draft'、item.body === 本文
test('LN27 公開の依頼で publishGlobal が Issue を作り、下書きを消して global-issue の知らせを足す。同じ依頼を 2 回読んでも Issue は 1 つ', ...)
test('LN28 公開のときにもう一度検査を掛け、落ちたら Issue を作らず下書きを捨てる。gh が失敗したら下書きを残す', ...)
test('LN29 下書きへの取り消しは下書きだけを捨て、規則は有効のまま。下書きの無い規則への取り消しは今までどおり取り下げる', ...)
test('LN30 learn-publish は下書きを公開し、judgeRules と judgeFingerprint は変わらない', ...)

// intake（learn.test.ts）
test('LE7 global-draft の知らせは題と本文と公開の案内を出し、「公開 1」で action publish の依頼を 1 回だけ書いて受け付けを返す', ...)
test('LE8 global-draft でない項目への「公開 1」は無視し、global-draft への「取り消し 1」は action cancel の依頼を書く', ...)
```

- [ ] **Step 2: 失敗を確かめる** — Run: `node --test test/unit/auto-learn-global.test.ts`（orca）、`node --test test/learn.test.ts`（intake） / Expected: 新しいテストが FAIL
- [ ] **Step 3: 実装する**（Task 7 の LN23 の「Issue を作る」期待は、下書き → 公開の 2 段に直す）
- [ ] **Step 4: 通ることを確かめる** — Run: orca `make test` と check、intake `bash test/run-all.sh` と check、ルートで `node scripts/check-shared-contracts.mjs` と `pnpm check:doc-lang` / Expected: すべて PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(orca-team-dispatch-task,slack-issue-intake): 改善の Issue は人が Slack で全文を読んで承認してから公開する"`
