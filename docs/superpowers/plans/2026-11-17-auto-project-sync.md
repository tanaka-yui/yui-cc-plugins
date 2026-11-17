# --auto の GitHub Project の Status とラベルの同期（C2c） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `--auto` の tick と `judge-apply` のたびに、拾う元に登録した GitHub Project の Status と Issue のステータスラベルを両方向で揃える。

**Architecture:** 新しい `lib/auto-project.ts` に、Project を読む処理（`gh api graphql`）、前回の組と今の値から何をするかを決める純粋な関数、書き込みをまとめた `syncProjects` を置く。設定は `sources[].project`、前回の組は状態ファイルの新しい欄 `projectSync` に持つ。`runTick` は `syncIssues` の前と報告を書く前の 2 回、`judge-apply` は終わりに 1 回呼ぶ。

**Tech Stack:** TypeScript 6（node が型を除いて直接実行。Node 22.18 以上）、`node --test`、gh CLI、テストは `test/lib/gh-stub.sh` の差し替え。

**Spec:** `docs/superpowers/specs/2026-11-17-auto-project-sync-design.md`

## Global Constraints

- TypeScript で `any` / `unknown` / `class` を使わない。実行時の npm 依存を足さない。
- コメント・コミットメッセージは日本語、識別子は英語。`SKILL.md` は英語のみで、変えたら `references/guide-ja.md` も同じ commit で変える。
- 対象は管理している Issue だけ: `MANAGED_LABELS`（`lib/status.ts`。`from-slack` / `slack-thread`）のどれかが付いているもの。archive された項目は対象外。開いているかどうかは問わない。
- Status の名前は、大文字小文字を区別せずに `STATUS_LABELS` の 8 つと比べる。8 つのどれでもない Status（`Todo`、空）のときは何もせず、前回の組も書き換えない。
- 両方が変わったら時刻があとのほうに合わせ、同じ秒ならラベルに合わせる。
- 権限が無い、または Project が読めないときは tick の出力に 1 行書いて同期を飛ばす。tick は止めない。`tick.errors` にも数えない。
- 検証のコマンド（`apps/orca-team-dispatch-task` で）: `../../node_modules/.bin/tsc --noEmit -p .`、`../../node_modules/.bin/biome check ./bin ./lib ./skills ./test`、`bash test/run-all.sh < /dev/null`（pnpm は mise の shim で動かないことがあるので直接呼ぶ）。

## Review Focus

- `--auto` 自身のラベルの付け替えが途中（`state.issues[key].pendingLabel` がある）の Issue には触らない。同期が途中の付け替えと競り合うと、ラベルが 2 つ付いたり古い値に戻ったりする → Task 2 の AU129 で固定。
- 写す先の値が Project の Status の選択肢に無い → その Issue を飛ばし、出力に 1 行書く。前回の組は書き換えない → AU129。
- 項目が 100 件を超える Project → ページを送って全部読む → AU128。
- Project に、拾う元でないリポジトリの Issue や管理していない Issue が入っている → 触らない → AU128。
- 2 つの拾う元が同じ Project を登録している → Project は 1 回だけ読み、両方のリポジトリの Issue を揃える。読めないときの 1 行も、tick の 2 回の同期を通して 1 回だけ → AU129。

---

## File Structure

| ファイル | 役割 |
|---|---|
| `lib/auto-config.ts`（変更） | `sources[].project` を読む |
| `lib/auto-state.ts`（変更） | `AutoState.projectSync` を足し、古い状態ファイルでは `{}` にする |
| `lib/auto-project.ts`（新規） | Project を読む、決める、書く |
| `lib/auto-tick.ts`（変更） | tick の 2 か所で `syncProjects` を呼ぶ |
| `bin/orca-auto.ts`（変更） | `judge-apply` の終わりで `syncProjects` を呼ぶ |
| `test/unit/auto-config.test.ts`、`test/unit/auto-state.test.ts`、`test/unit/auto-project.test.ts`（新規）、`test/unit/auto-tick.test.ts`、`test/unit/auto-judge.test.ts` | テスト |
| `skills/orca-team-dispatch-task/SKILL.md`、`references/guide-ja.md`、`CLAUDE.md` | 説明 |

---

### Task 1: 設定の `project` と状態ファイルの `projectSync`

**Files:**
- Modify: `apps/orca-team-dispatch-task/lib/auto-config.ts`
- Modify: `apps/orca-team-dispatch-task/lib/auto-state.ts`
- Test: `apps/orca-team-dispatch-task/test/unit/auto-config.test.ts`, `apps/orca-team-dispatch-task/test/unit/auto-state.test.ts`

**Interfaces:**
- Produces:
  - `export type ProjectRef = { owner: string; number: number }`（`lib/auto-config.ts`）
  - `AutoConfig['sources'][number]` に `project: ProjectRef | null` を足す
  - `export type ProjectPair = { status: string; label: string }`（`lib/auto-state.ts`。どちらも `STATUS_LABELS` の正式な名前。`label` は付いていなければ `''`）
  - `AutoState` に `projectSync: Record<string, ProjectPair>` を足す（鍵は `owner/repo#N`）

- [ ] **Step 1: 失敗するテストを書く**

`auto-config.test.ts` に `AU125 source project is optional and validated`:
- `project` が無い拾う元 → `readAutoConfig('main')?.sources[0]?.project` が `null`
- `{ owner: 'acme', number: 3 }` → そのまま読める
- `{ owner: '', number: 3 }`、`{ owner: 'acme', number: 0 }`、`{ owner: 'acme', number: 1.5 }`、`{ owner: 'acme' }`、`'acme/3'` → `readAutoConfig` が `null`

`auto-state.test.ts` に `AU126 projectSync defaults and is validated`:
- `projectSync` の無い状態ファイル → `readState('main').projectSync` が `{}`
- `{ 'acme/app#1': { status: 'Ready', label: '' } }` → そのまま読める
- `projectSync: []`、`{ 'acme/app#1': { status: 1, label: '' } }` → `readState` が `/状態ファイルが壊れています/` で throw
- 新しい状態（ファイルが無いとき）の既定値にも `projectSync: {}` が入る

- [ ] **Step 2: 落ちることを確かめる**

Run: `node --test test/unit/auto-config.test.ts test/unit/auto-state.test.ts`
Expected: AU125 と AU126 が FAIL

- [ ] **Step 3: 実装する**

`readAutoConfig` の拾う元の読み込みで `project` を検査する（`owner` は空でない文字列、`number` は 1 以上の整数。不正なら設定全体が `null`）。`readState` は `projectSync` が無ければ `{}` を入れ、あれば各値が `{ status: string, label: string }` かを確かめる。`AutoState` を作っているほかの箇所（テストの fixture を含む）も型が通るように直す。

- [ ] **Step 4: 通ることを確かめる**

Run: `node --test test/unit/auto-config.test.ts test/unit/auto-state.test.ts && ../../node_modules/.bin/tsc --noEmit -p .`
Expected: PASS、型エラーなし

- [ ] **Step 5: Commit**

```bash
git add lib/auto-config.ts lib/auto-state.ts test/unit/auto-config.test.ts test/unit/auto-state.test.ts
git commit -m "feat(orca-team-dispatch-task): --auto の拾う元に Project を登録でき、前回の Status とラベルを状態ファイルに持てるようにする"
```

---

### Task 2: `lib/auto-project.ts`（読む・決める・書く）

**Files:**
- Create: `apps/orca-team-dispatch-task/lib/auto-project.ts`
- Test: `apps/orca-team-dispatch-task/test/unit/auto-project.test.ts`

**Interfaces:**
- Consumes: Task 1 の `ProjectRef`、`ProjectPair`、`AutoState.projectSync`、`AutoConfig['sources']`
- Produces:
  - `export const AUTO_PROJECT_MAX_PAGES = 10`
  - `export type ProjectItem = { itemId: string; key: string; repo: string; number: number; labels: string[]; label: string; labelAt: string; status: string; statusAt: string }`
    - `label`: 付いているステータスラベルのうち `STATUS_LABELS` の並びで最初のもの。無ければ `''`
    - `labelAt`: timeline のステータスラベルの付け外しのうち最も新しい `createdAt`。無ければ `''`
    - `status`: 8 つの正式な名前に直した Status。8 つのどれでもない・空なら `''`
  - `export type ProjectRead = { projectId: string; fieldId: string; options: Record<string, string>; items: ProjectItem[] }`（`options` は正式な名前 → option id。8 つにあたる選択肢だけ）
  - `export const readProject = (ref: ProjectRef, repos: string[]): ProjectRead | { error: string }` — `items` は `repos` の Issue で、管理していて、archive されていないものだけ
  - `export type SyncDecision = { action: 'skip' } | { action: 'record'; pair: ProjectPair } | { action: 'setLabel'; pair: ProjectPair } | { action: 'setStatus'; pair: ProjectPair }`
  - `export const decideProjectSync = (prev: ProjectPair | undefined, item: ProjectItem): SyncDecision`
  - `export type ProjectSyncContext = { sources: AutoConfig['sources']; state: AutoState; save: () => void; log: (line: string) => void; failed: Set<string> }`（`failed` は読めなかった Project の `owner/number`。同じ tick の 2 回目では読まず、1 行も書かない）
  - `export const syncProjects = (ctx: ProjectSyncContext): void`

`decideProjectSync` の規則（上から順に最初に当たったもの）:

| 条件 | 結果 |
|---|---|
| `item.status === ''` | `skip` |
| `item.label === item.status` | `record {status, label}` |
| `item.label === ''` で、Status が前回から変わった（前回なしを含む） | `setLabel {status, label: status}` |
| `item.label === ''` | `record {status, label: ''}` |
| Status だけ変わった | `setLabel {status, label: status}` |
| ラベルだけ変わった | `setStatus {status: label, label}` |
| 両方変わった（前回なしを含む） | `labelAt >= statusAt` なら `setStatus`、そうでなければ `setLabel`（時刻は ISO 文字列のまま比べ、`''` は最古） |
| どちらも変わっていない | `skip` |

- [ ] **Step 1: 決める関数の失敗するテストを書く**

`AU127 decideProjectSync follows the table`: 上の表の行ごとに 1 つずつ、`item` を作る小さな関数で組み立てて `assert.deepEqual` する。少なくとも次を含める:
- `prev` なし、`status: 'Ready'`、`label: 'Backlog'`、`labelAt: '2026-11-17T01:55:42Z'`、`statusAt: '2026-11-17T01:55:41Z'` → `{ action: 'setStatus', pair: { status: 'Backlog', label: 'Backlog' } }`
- 同じで `labelAt === statusAt` → `setStatus`（同じ秒はラベル）
- `prev {Ready, Ready}`、`status: 'Pending'`、`label: 'Ready'` → `setLabel {Pending, Pending}`
- `prev {Ready, Ready}`、`status: 'Ready'`、`label: 'In review'` → `setStatus {In review, In review}`
- `prev {Ready, Ready}`、`status: ''` → `skip`
- `prev {Ready, Ready}`、`status: 'Ready'`、`label: ''` → `record {Ready, ''}`
- `prev {Ready, ''}`、`status: 'Done'`、`label: ''` → `setLabel {Done, Done}`

- [ ] **Step 2: 落ちることを確かめる**

Run: `node --test test/unit/auto-project.test.ts`
Expected: FAIL（モジュールが無い）

- [ ] **Step 3: `decideProjectSync` を実装して通す**

Run: `node --test test/unit/auto-project.test.ts`
Expected: AU127 PASS

- [ ] **Step 4: 読む処理の失敗するテストを書く**

`test/lib/auto-fixture.ts` の `fixture()` を使い、`f.respond('api_graphql', ...)` で応答を差し替える。応答の形は設計書の問い合わせのとおり（`data.repositoryOwner.projectV2.{id, field, items}`）。`AU128 readProject reads items, labels and times`:
- `acme/app#1`（`from-slack`、ラベル `Ready`、timeline に `Backlog` を付けた 01:00:00Z と外した 01:00:05Z、`Ready` を付けた 01:00:04Z、`from-slack` を付けた 01:10:00Z）、Status の名前 `ready`（小文字） → `label: 'Ready'`、`labelAt: '2026-11-17T01:00:05Z'`（ステータスラベル以外の付け外しは数えない）、`status: 'Ready'`
- 管理していない Issue、`isArchived: true` の項目、`repos` に無いリポジトリの Issue、Issue でない項目（`DraftIssue`）→ `items` に入らない
- 選択肢 `Todo`・`in progress`・`Done` → `options` は `{ 'In progress': id, Done: id }`
- 1 ページ目が `hasNextPage: true, endCursor: 'c1'` → 2 ページ目を `after` に `c1` を付けて読み、両方の項目が入る（stub の hook で、引数に `c1` があれば 2 ページ目を返す）
- `hasNextPage` が `AUTO_PROJECT_MAX_PAGES` ページを超えて続く → `{ error }`
- gh が rc 1 で stderr に `INSUFFICIENT_SCOPES` → `{ error }` で、文言に `gh auth refresh -s project` を含む
- `projectV2: null`（番号違い） → `{ error }`

- [ ] **Step 5: 落ちることを確かめ、`readProject` を実装して通す**

GraphQL は設計書の問い合わせに、Project の `id` と `field(name:"Status"){ ... on ProjectV2SingleSelectField { id options { id name } } }` を足したもの。`gh api graphql -f query=... -f owner=... -F number=... [-f after=...]` で呼ぶ。gh の呼び出しは `lib/auto-github.ts` の `github` を使う。各ページの前に `canAutoCall('Project 同期')` を確かめ、false なら `{ error }` を返す。

Run: `node --test test/unit/auto-project.test.ts`
Expected: AU127、AU128 PASS

- [ ] **Step 6: 書く処理の失敗するテストを書く**

`AU129 syncProjects writes labels and Status and records pairs`。`api_graphql` の hook で、引数に `updateProjectV2ItemFieldValue` があれば書き込みとして calls に残して `{"data":{...}}` を返し、無ければ読み込みの応答を返す。
- `setLabel` → `gh issue edit 1 --repo acme/app --add-label Pending --remove-label Ready` が呼ばれ（外すのは今付いているステータスラベルのうち新しい値以外。無ければ `--remove-label` を付けない）、`state.projectSync['acme/app#1']` が `{Pending, Pending}`、`save` が呼ばれる
- `setStatus` → mutation が `projectId`・`itemId`・`fieldId` と `options['In review']` の id を持って呼ばれ、組が記録される
- 書き込みが rc 1 → 組は前のまま
- `options` に写す先が無い → 何も書かず、`log` に `acme/app#1` と値の名前を含む 1 行。組は前のまま
- `state.issues['acme/app#1'].pendingLabel` がある → 何も書かず、組も書き換えない
- `record` → 書き込みは無く、組だけ記録される
- 2 つの拾う元が同じ `{owner, number}` → `api_graphql` の読み込みは 1 回で、両方のリポジトリの Issue が対象になる
- 読み込みが失敗 → `log` に 1 行、`failed` に `acme/3` が入る。同じ `ctx` でもう一度呼ぶと、読み込みも `log` も増えない
- `project: null` の拾う元しか無い → gh を呼ばない

- [ ] **Step 7: 落ちることを確かめ、`syncProjects` を実装して通す**

ラベルの書き込みは `github(['issue', 'edit', String(number), '--repo', repo, '--add-label', label, ...remove])`。Status の書き込みは `updateProjectV2ItemFieldValue(input:{projectId, itemId, fieldId, value:{singleSelectOptionId}})`。読み込みは Project ごとに 1 回、拾う元の `{owner, number}` でまとめる。

Run: `node --test test/unit/auto-project.test.ts && ../../node_modules/.bin/tsc --noEmit -p . && ../../node_modules/.bin/biome check ./lib ./test`
Expected: PASS、型と biome のエラーなし

- [ ] **Step 8: Commit**

```bash
git add lib/auto-project.ts test/unit/auto-project.test.ts
git commit -m "feat(orca-team-dispatch-task): GitHub Project の Status とステータスラベルを揃える処理を足す"
```

---

### Task 3: tick と judge-apply から呼び、説明を書く

**Files:**
- Modify: `apps/orca-team-dispatch-task/lib/auto-tick.ts`（`runTick`）
- Modify: `apps/orca-team-dispatch-task/bin/orca-auto.ts`（`judge-apply` の終わり）
- Modify: `apps/orca-team-dispatch-task/skills/orca-team-dispatch-task/SKILL.md`、`references/guide-ja.md`、`apps/orca-team-dispatch-task/CLAUDE.md`
- Test: `apps/orca-team-dispatch-task/test/unit/auto-tick.test.ts`、`apps/orca-team-dispatch-task/test/unit/auto-judge.test.ts`

**Interfaces:**
- Consumes: Task 2 の `syncProjects(ctx: ProjectSyncContext)`
- Produces: なし

呼ぶ場所:
- `runTick`: `pendingLabel` の再試行のループのあと、`syncIssues` の前に 1 回。Project で変えた Status がここでラベルになり、続く `syncIssues` が人の変更として読む。もう 1 回は `refill(tick)` のあと、報告を書く前。2 回とも同じ `failed` の Set を使う。`sources` は `syncIssues` に渡しているのと同じ、`pickSources` で絞った拾う元。`log` は `console.log`。
- `judge-apply`: 判定を全部処理したあと、終了コードを返す前に 1 回（`judge-apply` が付けた Ready_Eng を Status に写すため）。`sources` は `pickSources` で絞った拾う元。

- [ ] **Step 1: 失敗するテストを書く**

`auto-tick.test.ts` に `AU130 tick syncs the Project before and after the queue`。拾う元 `acme/app` に `project: { owner: 'acme', number: 3 }` を足し、`api_graphql` に Status `Pending`・ラベル `Ready`・前回の組 `{Ready, Ready}` の項目を返させる:
- gh の calls で、`api graphql` の読み込みが `issue list` より前に 1 回、あとに 1 回ある
- `issue edit 1 --repo acme/app --add-label Pending --remove-label Ready` が `issue list` より前にある
- `project` の無い設定では `api graphql` を呼ばない
- `api_graphql.rc` を 1 にすると、tick の出力に Project の 1 行がちょうど 1 回出て、tick は最後の `auto: judge=` の行まで進む

`auto-judge.test.ts` に `AU131 judge-apply syncs the Project after applying decisions`: `route: 'eng'` の判定を当てたあと、`api graphql` の読み込みが `issue edit`（Ready_Eng の付け替え）より後にある。

- [ ] **Step 2: 落ちることを確かめる**

Run: `node --test test/unit/auto-tick.test.ts test/unit/auto-judge.test.ts`
Expected: AU130、AU131 FAIL

- [ ] **Step 3: 2 か所で `syncProjects` を呼ぶ**

- [ ] **Step 4: 通ることを確かめる**

Run: `node --test test/unit/auto-tick.test.ts test/unit/auto-judge.test.ts`
Expected: PASS

- [ ] **Step 5: 説明を書く**

- `SKILL.md` の `### Configuration and prerequisites`: 設定の例の拾う元に `"project": { "owner": "acme", "number": 3 }` を足し、その下に英語の段落を 1 つ足す。内容: 任意であること、tick の初めと終わりと `judge-apply` のあとに両方向で揃えること、両方が変わったら新しいほう（同じ秒ならラベル）、8 つ以外の Status では何もしないこと、管理している Issue だけで Project への追加はしないこと、gh に `project` の権限が要ること（`gh auth refresh -s project`）、Status の選択肢は自分で足すこと（C3 の setup が来るまで）。
- `references/guide-ja.md`: 同じ場所に同じ内容の日本語。
- `CLAUDE.md`: `--auto` の節に、同期が `syncIssues` の前に走る理由（Project の変更を人の変更として読ませるため）と、ラベルを動かす箇所ごとに Status を書かず tick の終わりにまとめて写す理由を 1 行ずつ。

- [ ] **Step 6: 全体を確かめる**

Run: `../../node_modules/.bin/tsc --noEmit -p . && ../../node_modules/.bin/biome check ./bin ./lib ./skills ./test && bash test/run-all.sh < /dev/null && (cd ../.. && node scripts/check-doc-lang.mjs && node scripts/check-shared-contracts.mjs)`
Expected: すべて成功。run-all の各 suite が `failures: 0`、最後に `ALL GREEN`

- [ ] **Step 7: Commit**

```bash
git add lib/auto-tick.ts bin/orca-auto.ts test/unit/auto-tick.test.ts test/unit/auto-judge.test.ts skills/orca-team-dispatch-task/SKILL.md skills/orca-team-dispatch-task/references/guide-ja.md CLAUDE.md
git commit -m "feat(orca-team-dispatch-task): --auto の tick と判定のあとで Project の Status とラベルを揃える"
```
