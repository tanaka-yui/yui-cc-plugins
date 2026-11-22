# 途中で導入しても漏れなく拾う Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** intake に既存 Issue の取り込みの値 `active` を足し、orca の Project の同期と auto-ready を `active` のリポジトリで広げて、途中から導入しても Ready と人が `slack-thread` を付けた Backlog を漏らさない。

**Architecture:** 管理の印（`from-slack` / `slack-thread`）の約束は変えない。手で作った Issue は intake が取り込んで印を持たせる。orca は intake の設定を読んで `active` のリポジトリを知り、その範囲だけで Project の同期を印の無い Issue へ広げ、auto-ready を印付きの古い Backlog とステータスの無い Issue へ広げる。ステータスの無い Issue は orca が Backlog ラベルを付けて普通の Backlog の Issue にしてから判定に回す（ラベルの遷移・判定の適用・向き先の質問を変えずに済む）。

**Tech Stack:** TypeScript（node の型除去で直接実行）、node --test、gh のスタブ（orca: `test/lib/auto-fixture.ts`、intake: `test/helpers.ts` の fake gh）、biome。

**Spec:** `docs/superpowers/specs/2026-11-21-auto-pick-unmanaged-issues-design.md`

## Global Constraints

- TypeScript で `any` / `unknown` / `class` を使わない。固定値は `lib/defaults.ts`（intake）・`lib/status.ts` か対応する lib（orca）に定数で置く。
- コメント・コミット・CLAUDE.md・README は日本語。SKILL.md と references の英語版に日本語を書かない。SKILL.md を変えたら同じ commit で `references/guide-ja.md` も変える（`pnpm check:doc-lang`）。
- intake の今の `thread` / `skip` の動きを変えない。orca の広げた動きは intake の `existing` が `active` のリポジトリだけに効く（下の「計画で決めたこと」1）。
- 管理の印の約束（`MANAGED_LABELS = ['from-slack', 'slack-thread']`）は変えない。
- 版: slack-issue-intake 0.9.2 → 0.10.0、orca-team-dispatch-task 3.20.0 → 3.21.0。plugin.json・`.codex-plugin/plugin.json`（orca だけ）・ルートの `.claude-plugin/marketplace.json` を揃える。
- 検証: orca は `cd apps/orca-team-dispatch-task && make test`、intake は `cd apps/slack-issue-intake && bash test/run-all.sh`、両方で `pnpm --filter <pkg> check`、ルートで `node scripts/check-shared-contracts.mjs` と `pnpm check:doc-lang`。

## 計画で決めたこと（設計書に無い判断。最終報告で人に伝える）

1. orca の広げた動き（Project の同期を印の無い Issue へ・auto-ready を印付きの古い Backlog とステータスの無い Issue へ）は、intake の `existing` が `active` のリポジトリだけに効かせる。`thread` のリポジトリでは intake が古い Backlog の Issue にも `slack-thread` を付けるので、そこで広げると「人が印を付けていない Backlog を判定する」（設計の失敗条件）になるため。
2. ステータスの無い `slack-thread` の Issue は、orca が `Backlog` を付けてから判定に回す（設計の 7 の「Ready を付ける・外すラベルは無い」を、Backlog → Ready の普通の遷移に置き換える）。遷移・判定の適用・向き先の質問がステータス 1 つを前提にしているため。Slack にはその Issue の Backlog の知らせが 1 回出る。
3. 一覧の上限は `gh issue list --limit 1000`（gh が中でページを読む）にし、1000 件ちょうど返ったら tick の出力に 1 行出す。
4. 同じリポジトリを複数の intake のホームが `active` で扱うと、人が付けた `slack-thread` を両方が取り込み、管理の投稿が 2 つ出る。intake の README に「1 つのリポジトリを `active` にするのは 1 つのホームだけ」と書き、検出はしない。
5. `active` のリポジトリで、intake が自動で取り込んだ（Backlog 以外だった）Issue を人が後で Backlog に戻すと、orca の状態に記録が無ければ auto-ready の判定に回る（印を付けたのが intake か人かを区別しない）。CLAUDE.md に残す。

## Review Focus

1. `thread` / `skip` の intake のリポジトリで、orca の動きが変わらない（Project の同期が印の無い Issue に触らない・古い Backlog を判定しない）。→ Task 3 の AU189、Task 4 の AR11。
2. Project を読めなかった tick に、ステータスの無い Issue へ Backlog を付けない。→ Task 4 の AR12。
3. Project の上の Status が In progress の、ステータスの無い Issue に Backlog を付けない（次の同期が Status を Backlog に書き戻すのを防ぐ）。→ Task 4 の AR12。
4. 人が付けた `slack-thread` の Issue を、intake が 2 回取り込まない（DB に行があれば飛ばす）。→ Task 1 の AD17。
5. 状態に記録のある Issue（人が Backlog に戻した・止まった）を、`active` でも拾い直さない。→ Task 4 の AR10。

---

### Task 1: intake に `existing: 'active'` を足す

**Files:**
- Modify: `apps/slack-issue-intake/lib/defaults.ts`（`EXISTING_MODES`、`SETUP_TEXT.askExisting` の文面）
- Modify: `apps/slack-issue-intake/lib/config.ts:31`（`RepoSetting.existing`）と `loadConfig` の検査（`:90` 付近）
- Modify: `apps/slack-issue-intake/lib/commands/init.ts:143-148`（`--existing` の値）と `:256`（開始時刻の記録は `thread` だけのまま）
- Modify: `apps/slack-issue-intake/lib/commands/setup.ts:333-341`（質問の答え）
- Modify: `apps/slack-issue-intake/lib/adopt.ts:98`（対象のリポジトリ）と `consider`（`:113-131`）
- Modify: `apps/slack-issue-intake/README.md`（「スレッドで管理する Issue」）、`CLAUDE.md`、`skills/slack-issue-intake/SKILL.md` と `references/guide-ja.md`（Existing-issue policy の行）
- Modify: 版の 2 箇所（plugin.json、marketplace.json）→ 0.10.0
- Test: `apps/slack-issue-intake/test/adopt.test.ts`、`test/init.test.ts`、setup の質問のテストがあるファイル（`grep -l askExisting test/*.ts`）

**Interfaces:**
- Produces: `export const EXISTING_MODES = ['skip', 'thread', 'active'] as const` と `export const EXISTING_ACTIVE = 'active'`（`lib/defaults.ts`）。`RepoSetting.existing: (typeof EXISTING_MODES)[number]`。orca の Task 2 が `EXISTING_ACTIVE` の写しを持ち、`scripts/check-shared-contracts.mjs` が照合する。

- [ ] **Step 1: 失敗するテストを書く**

`test/adopt.test.ts` に足す（既存の AD2・AD3 の組み立てを真似る。設定は `existing: 'active'`）:

```ts
test('AD16 active は Backlog 以外のステータスの Issue を作られた時期を問わず取り込み、Backlog とステータス無しは取り込まない', ...)
// 開始時刻より前に作られた #1 Ready・#2 In progress・#3 Backlog・#4 ラベル無し・#5 Backlog と Ready の両方
// → 取り込みの行ができるのは #1・#2・#5 だけ（currentStatus が Backlog 以外）。#3・#4 は行も投稿も無い
test('AD17 active は人が付けた slack-thread の Issue を、DB に行が無ければ取り込み、行があれば飛ばす', ...)
// #6 Backlog+slack-thread（行なし）→ 投稿 1 つと行。次の poll では行があるので投稿は増えない
// #7 ラベル無し+slack-thread（行なし）→ 取り込む
// thread のリポジトリの #8 Backlog+slack-thread（行なし）→ 今までどおり取り込まない
test('AD18 active でも from-slack と PR は取り込まない', ...)
```

`test/init.test.ts` に足す:

```ts
test('IN20 --existing <repo>=active を受け付け、開始時刻は記録しない', ...)
// config.json の repos[].existing === 'active'。getMeta(db, adoptAfterKey(repo)) は null
// --existing acme/app=all は die で「--existing <repo>=<thread|active|skip>」を含む
```

setup の質問のテスト（既存の askExisting を使うテストのファイル）に足す: 答え `active` で `existing === 'active'`、`y` は今までどおり `thread`、`n` は `skip`。

- [ ] **Step 2: 失敗を確かめる**

Run: `cd apps/slack-issue-intake && node --test test/adopt.test.ts test/init.test.ts`
Expected: AD16〜AD18・IN20 が FAIL（`active` を設定が受け付けない）

- [ ] **Step 3: 実装する**

- `loadConfig` は `EXISTING_MODES.includes(r.existing)` で検査する。
- `init` の `--existing` は `EXISTING_MODES` のどれかを受け付け、エラー文を `--existing <repo>=<thread|active|skip> を確認してください` にする。開始時刻（`adoptAfterKey`）は `thread` だけが使うので `active` では書かない。
- setup の `askExisting` は `y / n / active` を受け付ける。文面例: `{repo} の Issue のうち Slack から作っていないものも、スレッドを立てて管理しますか（y=新しい Issue とステータス付きの古い Issue / active=Backlog 以外のステータスの Issue と slack-thread を付けた Issue / n=しない）`。badChoice の options も `y / active / n` にする。
- `adopt.ts`: 対象のリポジトリを `existing === 'thread' || existing === EXISTING_ACTIVE` にする。`consider(repo, issue, limit)` はリポジトリの設定を受け取り、`active` のときは次の規則にする（`thread` の規則は変えない）:
  - PR・`from-slack`・DB に行がある（`getAdopted`）→ 飛ばす。
  - `slack-thread` がある（DB に行が無い）→ 取り込む。
  - `currentStatus(labels)` が null でも `Backlog` でもない → 取り込む。
  - それ以外 → 飛ばす。
  - 開始時刻（`after`）は見ない。

`currentStatus` が複数のステータスのときに何を返すかは `lib/issue-status.ts` に従う（AD16 の #5 はそれで Backlog 以外になることを確かめる。違えば #5 の期待を実装に合わせず、「Backlog 以外のステータスを 1 つでも持つ」で判定する）。

- [ ] **Step 4: 通ることを確かめる**

Run: `cd apps/slack-issue-intake && bash test/run-all.sh && pnpm --filter @tanaka-yui/slack-issue-intake check`
Expected: すべて PASS

- [ ] **Step 5: 文書と版**

README の「スレッドで管理する Issue」に `active` の段落を足す（取り込む条件、Project で Ready にした手作りの Issue は orca の同期でラベルが付いてから取り込まれること、1 つのリポジトリを `active` にするのは 1 つのホームだけ）。SKILL.md の Existing-issue policy の行と guide-ja.md の対応する行、CLAUDE.md の adoptExisting の段落にも同じ要点を足す。版を 0.10.0 にする。

Run: `cd ../.. && pnpm check:doc-lang`
Expected: 違反なし

- [ ] **Step 6: Commit**

```bash
git add apps/slack-issue-intake .claude-plugin/marketplace.json
git commit -m "feat(slack-issue-intake): 既存 Issue の取り込みに active を足し、Backlog 以外の Issue と人が slack-thread を付けた Issue を管理する（0.10.0）"
```

---

### Task 2: orca が intake の `active` のリポジトリを知り、一覧を上限で切らない

**Files:**
- Modify: `apps/orca-team-dispatch-task/lib/intake-homes.ts`（`INTAKE_EXISTING_ACTIVE`）
- Modify: `apps/orca-team-dispatch-task/lib/auto-config.ts:191-213`（`intakeActiveRepos`）
- Modify: `apps/orca-team-dispatch-task/lib/auto-github.ts:45-85`（上限と `listUnlabeledThread`）
- Modify: `scripts/check-shared-contracts.mjs`（`EXISTING_ACTIVE` の照合）
- Test: `apps/orca-team-dispatch-task/test/unit/auto-config.test.ts`（無ければ auto-config を試しているファイル）、`test/unit/auto-queue.test.ts`

**Interfaces:**
- Consumes: intake の `EXISTING_ACTIVE = 'active'`（Task 1）。
- Produces:
  - `export const INTAKE_EXISTING_ACTIVE = 'active'`（`lib/intake-homes.ts`）
  - `export const intakeActiveRepos = (config: AutoConfig): Set<string>`（`intakeConfigs` のどれかで `existing === 'active'` のリポジトリ名。読めない設定は飛ばす。名前は設定に書かれたまま）
  - `export const AUTO_ISSUE_LIST_LIMIT = 1000`（`lib/auto-github.ts`）
  - `listReadyManaged(repo, pick, log?: (line: string) => void): ReadyIssue[] | null` — `--limit AUTO_ISSUE_LIST_LIMIT`。1 つの印の一覧が上限ちょうどなら `log` に 1 行（`<repo> の <pick> の Issue が <上限> 件を超えているかもしれません。超えた分は拾いません`）
  - `export const listUnlabeledThread = (repo: string, log?: (line: string) => void): ReadyIssue[] | null` — open で `slack-thread` が付き、ステータスラベルが 1 つも無い Issue。`gh issue list --repo <repo> --state open --label slack-thread --search '<STATUS_LABELS の各名前を -label:"<名前>" で並べたもの>' --limit AUTO_ISSUE_LIST_LIMIT --json number,title,labels,updatedAt,createdAt`。検索の遅れで残ったものを除くため、返った行のうちステータスラベルを持つものは捨てる

- [ ] **Step 1: 失敗するテストを書く**

```ts
test('AU186 intakeActiveRepos は active のリポジトリだけを返し、読めない設定を飛ばす', ...)
// intake 設定 A: [{name:'acme/app',existing:'active'},{name:'acme/web',existing:'thread'}]、B: 読めないパス
// → new Set(['acme/app'])
test('AU187 一覧は上限 1000 で読み、上限ちょうどなら 1 行出す。listUnlabeledThread はステータス付きの行を捨てる', ...)
// gh のスタブの呼び出しに '--limit 1000' がある。1000 行を返すと log に 1 行。
// listUnlabeledThread: 返った [#1 ラベル無し+slack-thread, #2 Ready+slack-thread] → [#1] だけ。呼び出しに -label:"Backlog" と -label:"Ready" がある
```

`scripts/check-shared-contracts.mjs` に、intake の `EXISTING_ACTIVE` と orca の `INTAKE_EXISTING_ACTIVE` が一致し、intake の `EXISTING_MODES` に含まれることの照合を足す。

- [ ] **Step 2: 失敗を確かめる**

Run: `cd apps/orca-team-dispatch-task && node --test test/unit/auto-queue.test.ts`（AU186 を置いたファイルも）
Expected: AU186・AU187 が FAIL

- [ ] **Step 3: 実装する**（上の Interfaces のとおり。既存の `listReadyManaged` の呼び出し 2 箇所は Task 4 で `log` を渡す）

- [ ] **Step 4: 通ることを確かめる**

Run: `make test && pnpm --filter @tanaka-yui/orca-team-dispatch-task check && node ../../scripts/check-shared-contracts.mjs`
Expected: すべて PASS（既存の一覧のテストが `--limit 100` を見ているなら 1000 に直す）

- [ ] **Step 5: Commit**

```bash
git add apps/orca-team-dispatch-task scripts/check-shared-contracts.mjs
git commit -m "feat(orca-team-dispatch-task): intake の active のリポジトリを読み、Issue の一覧を 1000 件まで読む"
```

---

### Task 3: Project の同期を `active` の印の無い Issue へ広げ、Todo の Issue の Status も揃える

**Files:**
- Modify: `apps/orca-team-dispatch-task/lib/auto-project.ts`（`decideProjectSync`・`projectItem`・`readProject`・`syncProjects`・`ProjectSyncContext`）
- Modify: `apps/orca-team-dispatch-task/lib/auto-tick.ts:1273-1282`、`bin/orca-auto.ts:363-370`（ctx に `active` と `statuses` を渡す）
- Test: `apps/orca-team-dispatch-task/test/unit/auto-project.test.ts`

**Interfaces:**
- Consumes: `intakeActiveRepos(config)`（Task 2）。
- Produces:
  - `ProjectSyncContext` に `active: ReadonlySet<string>`（印の無い Issue も同期するリポジトリ）と `statuses: Map<string, string>`（その tick で読めた Project の項目の `owner/repo#N` → Status。ステータス名でなければ `''`）を足す。`syncProjects` は読めた項目すべてを `statuses` に入れる（`touched` や `skip` の項目も）。
  - `readProject(ref: ProjectRef, repos: string[], active: ReadonlySet<string> = new Set()): ProjectRead | ProjectReadError` — `active` に入るリポジトリの項目は管理の印が無くても返す。
  - `decideProjectSync` の Status が `''` のときの規則:
    - 前回の組が無い → `record { status: '', label }`
    - 前回の組があり、`label !== ''` で `prev.label !== label` → `setStatus { status: label, label }`
    - それ以外 → `record { status: '', label }`（`record` は組が変わったときだけ書く既存の動き）

- [ ] **Step 1: 失敗するテストを書く**

AU127 の `decideProjectSync(ready, snapshot({ status: '' }))` の期待を `{ action: 'record', pair: { status: '', label: 'Ready' } }` に直し、足す:

```ts
// AU127 に追記
assert.deepEqual(decideProjectSync(undefined, snapshot({ status: '', label: '' })), { action: 'record', pair: { status: '', label: '' } })
assert.deepEqual(decideProjectSync({ status: '', label: '' }, snapshot({ status: '', label: 'Backlog' })), { action: 'setStatus', pair: same('Backlog') })
assert.deepEqual(decideProjectSync({ status: '', label: 'Ready' }, snapshot({ status: '', label: '' })), { action: 'record', pair: { status: '', label: '' } })

test('AU188 active のリポジトリでは印の無い Issue も同期し、Project の Ready をラベルにする', ...)
// active = {'acme/app'}。項目 #30 印なし・Status Ready・ラベル無し → issue edit 30 --add-label Ready。
// statuses.get('acme/app#30') === 'Ready'
test('AU189 active でないリポジトリでは印の無い Issue に触らず、statuses にも入れない', ...)
// active = 空。同じ項目 #30 → issue edit も mutation も呼ばない
test('AU190 Todo の Issue はラベルが変わったときだけ Status を書く', ...)
// 1 回目: Status Todo・ラベル無し → 書かずに組 {'' ,''} を記録。2 回目: ラベル Backlog → mutation で Backlog。
// 3 回目: ラベルそのまま → 何もしない
```

- [ ] **Step 2: 失敗を確かめる**

Run: `node --test test/unit/auto-project.test.ts`
Expected: AU127・AU188〜AU190 が FAIL

- [ ] **Step 3: 実装する**

`projectItem(node, repos, active)` は、`active` に入るリポジトリでは `MANAGED_LABELS` の条件を外す（リポジトリ名の照合は今の大文字小文字を無視する比べ方のまま、`active` の照合も同じにする）。`syncProjects` は `ctx.active` を `readProject` に渡し、読めた項目ごとに `ctx.statuses.set(item.key, item.status)` してから今の処理に入る。tick と judge-apply は `active: intakeActiveRepos(config)`、`statuses: new Map()` を渡す。

- [ ] **Step 4: 通ることを確かめる**

Run: `make test && pnpm --filter @tanaka-yui/orca-team-dispatch-task check`
Expected: すべて PASS（AU129b の時間の揺れは既知）

- [ ] **Step 5: Commit**

```bash
git add apps/orca-team-dispatch-task
git commit -m "feat(orca-team-dispatch-task): active のリポジトリでは印の無い Issue も Project と同期し、Todo の Issue もラベルが動いたら Status を揃える"
```

---

### Task 4: auto-ready を印付きの古い Backlog とステータスの無い Issue へ広げる（文書・版を含む）

**Files:**
- Modify: `apps/orca-team-dispatch-task/lib/auto-queue.ts:79-205`（`syncIssues` の auto-ready の一覧）と新しい関数 `markUnlabeledBacklog`
- Modify: `apps/orca-team-dispatch-task/lib/auto-tick.ts:1282-1283`（`syncProjects` と `syncIssues` の間で呼ぶ）
- Modify: `apps/orca-team-dispatch-task/skills/orca-team-dispatch-task/SKILL.md:254,299,301` と `references/guide-ja.md` の対応箇所、`README.md`、`CLAUDE.md`（C2c と auto-ready の節。「計画で決めたこと」1・2・5 を残す）
- Modify: 版の 3 箇所 → 3.21.0
- Test: `apps/orca-team-dispatch-task/test/unit/auto-ready.test.ts`、`test/unit/auto-tick*.test.ts`（tick の順番を試しているファイル）

**Interfaces:**
- Consumes: `intakeActiveRepos`・`listUnlabeledThread`・`listReadyManaged(…, log)`（Task 2）、`ProjectSyncContext.statuses` と `failed`（Task 3）。
- Produces:
  - `syncIssues(state, sources, active: ReadonlySet<string> = new Set(), log?: (line: string) => void)` — auto-ready の Backlog の行は、今の条件（`createdAt >= since`）か、`active.has(repo)` かつ `slack-thread` を持つなら拾う。ほかの条件（状態に記録が無い・Ready の候補でない・ステータスが Backlog だけ）は今のまま。`since` の初回の扱い（最初の tick は時刻を記録するだけ）も変えない。
  - `export const markUnlabeledBacklog = (sources: Array<{ repo: string; autoReady?: boolean; project: ProjectRef | null }>, active: ReadonlySet<string>, project: Pick<ProjectSyncContext, 'statuses' | 'failed' | 'touched'>, log: (line: string) => void): string[]` — `autoReady` で `active` の拾う元ごとに `listUnlabeledThread` を読み、次の Issue に `gh issue edit <N> --repo <repo> --add-label Backlog` を書いて、付けた key を返す:
    - 拾う元に `project` があるなら、その Project（`owner/number`）が `failed` に無く、key が `touched` に無く、`statuses.get(key)` が `undefined`（Project に載っていない）か `''` のもの。
    - `project` が無ければ全部。
    - 呼び出しごとに `canAutoCall('auto-ready')` を見て、尽きたら止める。書けなければ log に 1 行出して次へ。

- [ ] **Step 1: 失敗するテストを書く**

`test/unit/auto-ready.test.ts`（`lists` の hook に `--label slack-thread` の分岐を足す）:

```ts
test('AR10 active のリポジトリでは slack-thread の古い Backlog も拾い、記録のある Issue は拾い直さない', ...)
// since より前に作られた #1 Backlog+slack-thread → added。#2 Backlog+from-slack（古い）→ 拾わない。
// #1 を phase 'stopped' にした後の同期 → 拾い直さない
test('AR11 active でないリポジトリでは slack-thread の古い Backlog を拾わない', ...)
// 同じ #1 で active = 空 → added は空
test('AR12 markUnlabeledBacklog は Project の Status が無いか Todo の Issue だけに Backlog を付け、読めない Project では付けない', ...)
// project あり。statuses: #3 → ''、#4 → 'In progress'、#5 は無し（Project に載っていない）、#6 は touched。
// → issue edit 3 と 5 だけ（--add-label Backlog）。戻り値 ['acme/app#3','acme/app#5']
// failed に Project の鍵を入れると → issue edit を 1 つも呼ばない
// autoReady でない拾う元・active でないリポジトリ → listUnlabeledThread を呼ばない
test('AR13 tick は Project の同期のあと、Issue の同期の前に markUnlabeledBacklog を呼ぶ', ...)
// gh の呼び出しの順に、Project の graphql → --label slack-thread の一覧 → issue edit --add-label Backlog → Ready の一覧
```

- [ ] **Step 2: 失敗を確かめる**

Run: `node --test test/unit/auto-ready.test.ts`
Expected: AR10〜AR13 が FAIL

- [ ] **Step 3: 実装する**

`auto-tick.ts` では `const active = intakeActiveRepos(config)` を作って Task 3 の ctx にも渡し、`syncProjects(projectSync)` → `markUnlabeledBacklog(sources, active, projectSync, console.log)` → `syncIssues(state, sources, active, console.log)` の順にする。付けた Issue は次の tick の Backlog の一覧で拾われる（同じ tick では拾わない。検索の遅れがあるため）。`syncIssues` の 2 つの `listReadyManaged` には `log` を渡す。judge-apply（`bin/orca-auto.ts`）の `syncProjects` には `active` と `statuses: new Map()` を渡すだけで、`markUnlabeledBacklog` は呼ばない。

- [ ] **Step 4: 通ることを確かめる**

Run: `make test && pnpm --filter @tanaka-yui/orca-team-dispatch-task check`
Expected: すべて PASS

- [ ] **Step 5: 文書と版**

- SKILL.md 254 行の「It picks open Ready Issues carrying `from-slack` or `slack-thread`」の後ろに、intake の `active` のリポジトリでは手で作った Issue も intake が取り込んでから拾うことを足す。
- 299 行（Project）に、`active` のリポジトリでは印の無い項目も同期すること、Status が Todo や空でもラベルが変われば Status を書くことを足す。「A Status outside the eight status names … is left alone」はこの規則に合わせて直す。
- 301 行（auto-ready）に、`active` のリポジトリでは `slack-thread` の付いた古い Backlog の Issue も判定に回すこと、ステータスの無い `slack-thread` の Issue には Backlog を付けてから回すこと（Project の上で Status がステータス名なら付けない、Project を読めない tick は付けない）を足す。
- guide-ja.md の対応箇所、README の auto-ready と Project の節、CLAUDE.md の C2c と auto-ready の節も同じ要点で直す。
- 版を 3.21.0 にする（plugin.json・`.codex-plugin/plugin.json`・marketplace.json）。

Run: `cd ../.. && pnpm check:doc-lang && node scripts/check-shared-contracts.mjs && cd apps/orca-team-dispatch-task && make test`
Expected: すべて PASS（`test/test-docs.sh` が SKILL.md の文を固定していれば、その期待も同じ commit で直す）

- [ ] **Step 6: Commit**

```bash
git add apps/orca-team-dispatch-task .claude-plugin/marketplace.json
git commit -m "feat(orca-team-dispatch-task): intake の active のリポジトリで、slack-thread の古い Backlog とステータスの無い Issue も auto-ready に回す（3.21.0）"
```
