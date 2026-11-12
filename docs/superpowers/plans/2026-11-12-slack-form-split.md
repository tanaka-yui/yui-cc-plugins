# Slack フォームのカテゴリ別分割 実装計画（部分 A）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** slack-issue-intake のフォームを、バグ・要望・新機能の 3 つのボタン（ワークフロー）に分け、カテゴリごとの項目を集め、項目名を太字・複数行の値をコードブロックにした投稿を出し、それを今どおり Issue にできるようにする。

**Architecture:** カテゴリごとのフォーム定義（`FORM_KINDS`）を `lib/defaults.ts` に 1 か所で持ち、マニフェストのワークフロー、投稿のテンプレート、手で作る手順、解析器のすべてがそこから作られる。解析器は新しい形と古い形（`本文:`）の両方を読み、カテゴリ別の項目を「項目名:\n値」を空行で区切った 1 つの文字列にして `SubmissionFields.body` に入れる。これで DB、work、Issue 本文の組み立ては変えずに済む。

**Tech Stack:** TypeScript（Node 24.15 以上の型除去で直接実行。実行時の npm 依存なし）、`node --test`、Slack 組み込み関数 `open_form` / `send_message`、Slack CLI（trigger create / access / delete）、Slack Web API（`workflows.featured.add` / `workflows.featured.remove`）。

**Spec:** `docs/superpowers/specs/2026-11-12-issue-auto-dispatch-design.md` の 4 章（部分 A）

## Global Constraints

- 作業ディレクトリは `apps/slack-issue-intake`。テストは `bash test/run-all.sh`、型と lint はリポジトリのルートで `pnpm --filter @tanaka-yui/slack-issue-intake check`（無ければ `pnpm check`）。
- 実行時の依存は `node:` の組み込みだけ。`any` / `unknown` 型、`class` を使わない（`Error` の継承を除く）。
- 固定値は `lib/defaults.ts` に置く。文言（日本語）も同じ。
- `skills/**/references/*.md`（`-ja.md` 以外）と `SKILL.md` 本文に日本語を書かない。変えたら `*-ja.md` も同じコミットで直す。`pnpm check:doc-lang` が通ること。
- 手順書 `procedure.md` を変えたら、`procedure-ja.md`、`lib/permissions.ts`、テスト CA9 をそろえる（プラグインの CLAUDE.md）。
- 外部の文字列を出力・保存する前に `maskSecrets` を通す。Slack / gh の呼び出しには deadline を渡す。副作用の直前に `guard()`（`renewLease`）を呼ぶ。
- 版数は `0.3.0` にし、`apps/slack-issue-intake/.claude-plugin/plugin.json` とルートの `.claude-plugin/marketplace.json` の両方を同期する。
- フォームの題は `open_form` の制約（半角 24、日本語は 1 字を 3 と数える）、項目の題は 25 字以内。
- 3 つのワークフローの ID は `issue_intake_bug` / `issue_intake_request` / `issue_intake_feature`。
- 項目名（ユーザーが決めたもの）: 事象、エラーログ、対応策、画面のURL、ソースコードのパス、現在、理想、仕様。共通はタイトル、優先度、添付ファイル。

## Review Focus

1. **0.2.x からの更新**: meta に古い 1 つのトリガー（キー `form_trigger_id`）が残っている状態で `form` を実行したとき、新しい 3 つのボタンが出てから古いボタンが外れ、チャンネルからボタンが消える時間がないこと。古いトリガーの削除に失敗しても `form` は exit 0 で終わり、次の実行でやり直すこと（Task 3 の FO8 / FO9）。
2. **値に ``` を含む投稿**: エラーログに ``` が混ざって枠が崩れても、解析は落ちず、次の既知の項目名の行までを値として読むこと（Task 1 の PA17）。
3. **更新前に投稿された古い形**: `本文:` の形はそのまま読めること（Task 1 で PA1〜PA10 を変えずに通す）。
4. **空の任意項目**: 空の枠が来ても問題にせず、本文の文字列にも入れないこと（Task 1 の PA11）。
5. **Slack が太字とコードブロックを rich_text に変えた場合**: 平らにした文字列（`*` が無く、``` が独立した行）でも読めること（Task 1 の PA14）。

---

### Task 1: カテゴリ別の項目定義と解析器

**Files:**
- Modify: `lib/types.ts`（型の追加）
- Modify: `lib/defaults.ts`（`FORM_ITEM_LABELS`、`FORM_KINDS` の追加）
- Modify: `lib/parse.ts`
- Modify: `test/fixtures/slack-messages.ts`（`kindText` の追加）
- Test: `test/unit/parse.test.ts`

**Interfaces:**
- Produces（`lib/types.ts`）:
  ```ts
  export type FormItem = { readonly name: string; readonly label: string; readonly long: boolean; readonly required: boolean }
  export type FormKind = {
    readonly key: CategoryKey          // 'bug' | 'request' | 'feature'
    readonly category: Category        // 'バグ' | '要望' | '新機能'
    readonly workflowId: string
    readonly title: string             // フォームの題とボタンの名前
    readonly items: readonly FormItem[]
  }
  ```
- Produces（`lib/defaults.ts`）:
  - `FORM_ITEM_LABELS = { symptom: '事象', errorLog: 'エラーログ', workaround: '対応策', screenUrl: '画面のURL', sourcePath: 'ソースコードのパス', current: '現在', ideal: '理想', spec: '仕様' } as const`
  - `FORM_KINDS: readonly FormKind[]`。順番と中身:
    | key | category | workflowId | title | items（name / long / required） |
    |---|---|---|---|---|
    | bug | バグ | issue_intake_bug | バグを報告 | symptom 長 必須、error_log 長 任意、workaround 長 任意、screen_url 短 任意、source_path 短 任意 |
    | request | 要望 | issue_intake_request | 要望を送る | current 長 必須、ideal 長 必須、screen_url 短 任意、source_path 短 任意 |
    | feature | 新機能 | issue_intake_feature | 新機能を提案 | spec 長 必須 |
- Produces（`lib/parse.ts`）:
  - `formKindByCategory(category: string): FormKind | undefined` — NFKC で正規化して `FORM_KINDS` の `category` と照合する。
  - `renderSections(sections: readonly { label: string; value: string }[]): string` — 値が空でないものだけを `${label}:\n${value}` にし、`\n\n` でつなぐ。
  - `parseSubmission` の型は変えない。`kind: 'ok'` の `fields.body` に、新しい形では `renderSections` の結果、古い形では今どおりの本文が入る。

- [ ] **Step 1: テスト用の投稿を作る関数を足す**

`test/fixtures/slack-messages.ts` に `kindText(category: string, values: Record<string, string>, o?: { title?: string; priority?: string; reporter?: string }): string` を足す。Task 2 の `renderKindMessage` と同じ形（下）を手で組み立てる。`values` のキーは項目名（日本語のラベル）。`values` に無い項目は空にする。

```text
[issue-intake]
*タイトル:* <title>
*カテゴリ:* <category>
*優先度:* <priority>
*起票者:* <reporter>

*事象:*
```
<値>
```

*画面のURL:* <値>
```

複数行の項目は `*ラベル:*` の次の行から ``` で囲み、1 行の項目は `*ラベル:* 値` にする。項目の前に空行を 1 行入れる。カテゴリから項目の並びを引くには `FORM_KINDS` を使う。

- [ ] **Step 2: 失敗するテストを書く**

`test/unit/parse.test.ts` の PA1〜PA10 は変えずに残し、次を足す。

```ts
test('PA11 バグの新しい形を読み、空の任意項目は本文に入れない', () => {
  const r = parseSubmission(kindText('バグ', { 事象: '白くなる\n2行目', 画面のURL: 'https://e.x/a' }), null)
  assert.deepEqual(r, {
    kind: 'ok',
    fields: {
      title: 'ログインできない', fullTitle: 'ログインできない', category: 'バグ', priority: 'high',
      body: '事象:\n白くなる\n2行目\n\n画面のURL:\nhttps://e.x/a',
      reporterId: 'U012AB3CD',
    },
  })
})
test('PA12 要望の必須項目が無ければ項目名で挙げる', () => {
  const r = parseSubmission(kindText('要望', {}), null)
  assert.ok(r.kind === 'invalid' && r.problems.includes('現在がありません') && r.problems.includes('理想がありません'))
})
test('PA13 コードブロックの中の項目名らしい行は値のまま', () => {
  const r = parseSubmission(kindText('要望', { 現在: '理想: 偽物\nタイトル: 偽物', 理想: 'x' }), null)
  assert.ok(r.kind === 'ok' && r.fields.body === '現在:\n理想: 偽物\nタイトル: 偽物\n\n理想:\nx' && r.fields.title === 'ログインできない')
})
test('PA14 rich_text を平らにした形（* なし、``` が独立行）も読む', () => {
  const text = kindText('新機能', { 仕様: 'A\nB' }).replaceAll('*', '')
  const r = parseSubmission(text, null)
  assert.ok(r.kind === 'ok' && r.fields.body === '仕様:\nA\nB' && r.fields.category === '新機能')
})
test('PA15 1 行に ```値``` と書かれた値も読む', () => {
  const text = kindText('新機能', { 仕様: 'X' }).replace('*仕様:*\n```\nX\n```', '*仕様:*\n```X```')
  const r = parseSubmission(text, null)
  assert.ok(r.kind === 'ok' && r.fields.body === '仕様:\nX')
})
test('PA16 カテゴリが不正で本文の行も無ければ、カテゴリの問題だけを挙げる', () => {
  const r = parseSubmission(kindText('バグ', { 事象: 'x' }).replace('*カテゴリ:* バグ', '*カテゴリ:* その他'), null)
  assert.deepEqual(r.kind === 'invalid' && r.problems, ['カテゴリが「バグ / 新機能 / 要望」のどれでもありません'])
})
test('PA17 値に ``` が混ざって枠が崩れても落ちず、次の項目名の行までを値にする', () => {
  const r = parseSubmission(kindText('バグ', { 事象: 'a', エラーログ: 'x ``` y\nz', 画面のURL: 'u' }), null)
  assert.ok(
    r.kind === 'ok' && r.fields.body.startsWith('事象:\na\n\nエラーログ:\n') && r.fields.body.endsWith('画面のURL:\nu'),
  )
})
```

- [ ] **Step 3: テストが失敗することを確かめる**

Run: `node --test test/unit/parse.test.ts`
Expected: PA11〜PA17 が FAIL（`kindText` は Step 1 で足したので import は通る）。PA1〜PA10 は PASS。

- [ ] **Step 4: 型と定数を足し、`lib/parse.ts` を書き換える**

`FormItem` / `FormKind` を `lib/types.ts` に、`FORM_ITEM_LABELS` / `FORM_KINDS` を `lib/defaults.ts` に足す（`defaults.ts` から `types.ts` へは `import type` だけにする）。

解析の手順（シグネチャとテストだけでは決まらないので書く）:

```text
各行（マーカーの次から）について:
  1. 今の項目が複数行で、行に ``` が含まれる場合:
       ``` を取り除いた残りが空でなければ値に足す。``` の個数が奇数なら「枠の中」を反転する。次の行へ。
  2. 枠の中なら、行をそのまま今の項目の値に足す。次の行へ。
     ただし、行が * 付きの項目名（`*<その種類の項目名>:*`）で始まるなら、枠が崩れたとみなして枠を閉じ、3 へ進む（PA17）。
     * の無い項目名の行は値のまま（PA13）。
  3. 行の先頭の * を外し、最初の : か ： で分ける。ラベルの * と空白を外し、NFKC で正規化する。値の先頭の * と空白を外す。
     分けられなければ、今の項目があればその値に行を足す。次の行へ。
  4. ラベルが「本文」なら、今どおり残りの行をすべて本文にして終わる（古い形）。
  5. まだどの項目も始まっていず、ラベルがタイトル / カテゴリ / 優先度 / 起票者なら、その値を記録する。
  6. ラベルが FORM_KINDS のどれかの項目名なら、その項目を始める（同じ行の値があれば最初の値にする）。
  7. どれでもなく今の項目があれば、行をその値に足す。
```

- カテゴリで `FormKind` を選ぶ。その種類に無い項目名は捨てる。
- 値は前後の空行を削る。
- 問題の挙げ方: タイトル、カテゴリ、優先度を今どおりの順で確かめる。古い形なら続けて本文、新しい形ならその種類の必須項目を `items` の順で `PROBLEM_MISSING` で挙げる。本文の行も無く、カテゴリも不正なら、項目の問題は挙げない（PA16）。
- 新しい形の `body` は `renderSections` で作る（並びは `items` の順）。

- [ ] **Step 5: テストが通ることを確かめる**

Run: `node --test test/unit/parse.test.ts`
Expected: PA1〜PA17 がすべて PASS。

- [ ] **Step 6: 全テストを走らせる**

Run: `bash test/run-all.sh`
Expected: FM3 だけが FAIL してよい（フォームはまだ 1 つのまま。Task 2 で直す）。それ以外は PASS。

- [ ] **Step 7: Commit**

```bash
git add lib/types.ts lib/defaults.ts lib/parse.ts test/fixtures/slack-messages.ts test/unit/parse.test.ts
git commit -m "feat(slack-issue-intake): カテゴリ別の項目定義と、新しい投稿の形を読む解析器を足す"
```

---

### Task 2: 3 つのワークフローを持つマニフェストと投稿のテンプレート

**Files:**
- Modify: `lib/form.ts`
- Modify: `lib/defaults.ts`（`FORM_WORKFLOW_ID` と `FORM_TITLE` を消す。`FORM_FEATURE_STEPS` の `{title}` の使い方）
- Test: `test/unit/form.test.ts`

**Interfaces:**
- Consumes: Task 1 の `FormKind`、`FORM_KINDS`、`FORM_ITEM_LABELS`、`parseSubmission`、`kindText`。
- Produces（`lib/form.ts`）:
  - `type Slot = 'title' | 'priority' | 'reporter' | string`（`string` は項目の `name`）。
  - `renderKindMessage(kind: FormKind, slot: (name: Slot) => string): string` — 投稿の形（Task 1 Step 1 の形。カテゴリは `kind.category` をそのまま書く）。ワークフローと手で作る手順の両方がこれを使う。
  - `renderWorkflowMessage(kind: FormKind): string` — `slot` に `{{steps.0.fields.<name>}}`、起票者は `<@{{inputs.user_id}}>` を渡す。
  - `formWorkflow(kind: FormKind): JsonObject` — `open_form` の題は `kind.title`。項目の並びは タイトル、優先度、`kind.items`、添付ファイル。`required` は `['title', 'priority', ...必須の items の name]`。複数行の項目は `long: true`。
  - `formManifestObject(): JsonObject` — `workflows` に `FORM_KINDS` の 3 つを `workflowId` で入れる。今の `issue_intake_form` は入れない。
  - `triggerDefinition(channel: string, kind: FormKind): JsonObject` — `name` は `kind.title`、`workflow` は `#/workflows/${kind.workflowId}`。
  - `featuredParams(channel: string, triggerIds: readonly string[]): Record<string, string>` — `trigger_ids` は `,` でつなぐ。
  - `featureSteps(): string` — `{title}` を 3 つの題を `、` でつないだものに置き換える。

- [ ] **Step 1: 失敗するテストを書く**

`test/unit/form.test.ts` の FM1〜FM4 を次の内容に書き換え、FM5 を足す。

- FM1: `formManifestObject()` の `workflows` のキーが `['issue_intake_bug', 'issue_intake_request', 'issue_intake_feature']`。どれも `steps` の `function_id` が `['slack#/functions/open_form', 'slack#/functions/send_message']`。権限と `org_deploy_enabled` の確認は今のまま。
- FM2: 3 つすべてで、題が `FORM_TITLE_MAX_UNITS` 以内、項目の題が `FORM_FIELD_TITLE_MAX_CHARS` 以内。バグの `required` が `['title', 'priority', 'symptom']`、要望が `['title', 'priority', 'current', 'ideal']`、新機能が `['title', 'priority', 'spec']`。`error_log` は `long: true`、`screen_url` は `long` なし。添付の `maxItems` は `MAX_FILES_PER_MESSAGE`。どのフォームにもカテゴリを選ぶ項目が無い。
- FM3: 3 つすべてで、`send_message` の `message` が `renderWorkflowMessage(kind)` と一致する。変数を埋めた文字列が `kindText` と同じになり、`parseSubmission` が `kind: 'ok'` で、カテゴリが `kind.category` になる。
- FM4: `triggerDefinition(CHANNEL, kind)` の `workflow` が `#/workflows/${kind.workflowId}`、`name` が `kind.title`。`inputs` は今のまま。
- FM5: `featuredParams(CHANNEL, ['Ft0A', 'Ft0B'])` が `{ channel_id: CHANNEL, trigger_ids: 'Ft0A,Ft0B' }`。

- [ ] **Step 2: テストが失敗することを確かめる**

Run: `node --test test/unit/form.test.ts`
Expected: FAIL（`issue_intake_bug` が無い、`renderWorkflowMessage` の引数が違う）。

- [ ] **Step 3: `lib/form.ts` を書き換える**

上の Interfaces のとおりにする。`FORM_WORKFLOW_ID` と `FORM_TITLE` は消し、使っている所を `FORM_KINDS` に置き換える。`FORM_DESCRIPTION` と `FORM_SUBMIT_LABEL` は 3 つで共通に使う。

- [ ] **Step 4: テストが通ることを確かめる**

Run: `node --test test/unit/form.test.ts test/unit/parse.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/form.ts lib/defaults.ts test/unit/form.test.ts
git commit -m "feat(slack-issue-intake): フォームをバグ・要望・新機能の 3 つのワークフローに分ける"
```

---

### Task 3: 3 つのボタンを置く form コマンドと、古いボタンの片付け

**Files:**
- Modify: `lib/slack-cli.ts`（`triggerDef` の扱い、`createTrigger`、`deleteTrigger` の追加）
- Modify: `lib/db.ts`（`deleteMeta` の追加）
- Modify: `lib/defaults.ts`（`TRIGGER_DEF_FILE` を `TRIGGER_DEF_PREFIX = 'form-trigger-'` に、メタのキーの作り方）
- Modify: `lib/commands/form.ts`
- Modify: `lib/commands/setup.ts`（`formDone`）
- Modify: `test/fixtures/fake-slack-cli.ts`
- Test: `test/form.test.ts`、`test/setup.test.ts`、`test/unit/slack-cli.test.ts`（`triggerDef` を参照していれば）

**Interfaces:**
- Consumes: Task 2 の `triggerDefinition(channel, kind)`、`featuredParams(channel, ids)`、`featureSteps()`、Task 1 の `FORM_KINDS`。
- Produces:
  - `lib/defaults.ts`: `formMetaKey(base: string, kind: FormKind): string` は `${base}:${kind.key}` を返す。`FORM_META_TRIGGER_ID` / `FORM_META_URL` は、キーの元の名前と、0.2.x の古いキーとして両方に使う。`FORM_META_FEATURED` には、おすすめにしたトリガー ID を `FORM_KINDS` の順に `,` でつないだものを入れる（手作業の印 `FORM_FEATURED_MANUAL` は今のまま）。
  - `lib/slack-cli.ts`:
    - `SlackProject` から `triggerDef` を外す。代わりに `triggerDefPath(project: SlackProject, kind: FormKind): string`（`<dir>/form-trigger-<key>.json`）。
    - `writeTriggerDef(project: SlackProject, channel: string, kind: FormKind): string` は書いたパスを返す。
    - `createTrigger(bin: string, project: SlackProject, teamId: string, defPath: string)`（引数のほかは今のまま）。
    - `deleteTrigger(bin: string, project: SlackProject, teamId: string, triggerId: string): { ok: true } | CliFailure` は `trigger delete --trigger-id <id> --app deployed --team <team> --skip-update --no-color` を実行する。
  - `lib/db.ts`: `deleteMeta(db: Db, key: string): void`。
  - `form` の標準出力: `trigger.<key>=<id>` と `url.<key>=<url>` を `FORM_KINDS` の順に出し、続けて `channel=` と `featured=` を出す。

- [ ] **Step 1: 偽の Slack CLI を広げる**

`test/fixtures/fake-slack-cli.ts`:

- `trigger create` は、`--trigger-def` の `workflow` の末尾の `_` より後ろの先頭 3 文字を大文字にして、`Ft0FAKE<それ>` を ID にする（bug → `Ft0FAKEBUG`、request → `Ft0FAKEREQ`、feature → `Ft0FAKEFEA`、古い form → `Ft0FAKEFOR`）。URL は `https://slack.com/shortcuts/<ID>/abc123`。
- `trigger delete` を記録する。`FAKE_SLACK_CLI_DELETE_FAIL` があれば、その文字列を stderr に出して exit 1。

- [ ] **Step 2: 失敗するテストを書く**

`test/form.test.ts`:

- FO1 を書き換える: `trigger create` が 3 回で、それぞれの `triggerDef.workflow` が 3 つのワークフローを指す。`trigger access` が 3 つの ID それぞれに 1 回。`workflows.featured.add` が 1 回で、`trigger_ids` が `'Ft0FAKEBUG,Ft0FAKEREQ,Ft0FAKEFEA'`。メタの `form_trigger_id:bug` などに各 ID、`FORM_META_FEATURED` に 3 つをつないだもの。再実行では `trigger create` と `featured.add` が増えない。
- FO3 / FO6（2 つある）/ FO7 は、ID とメタのキーを新しいものにそろえる。
- FO8（新規）: メタに古いキー `form_trigger_id = Ft0FAKEFOR` と `form_url` を入れてから `form` を実行する。新しい 3 つの `featured.add` が **先に**呼ばれ、そのあとに `workflows.featured.remove`（`{ channel_id, trigger_ids: 'Ft0FAKEFOR' }`）と `trigger delete --trigger-id Ft0FAKEFOR` が呼ばれる。古いキーは 2 つとも消える。exit 0。
- FO9（新規）: FO8 と同じ準備で `FAKE_SLACK_CLI_DELETE_FAIL=not found` にする。exit 0、stderr に古いボタンを消せなかった旨が出る。古いキーは残る。再実行で `trigger delete` がもう一度呼ばれる。

`test/setup.test.ts`: SU1 / SU2 / SU22 の `trigger create` の回数（3）、メタのキー、`featured` の値を新しいものにそろえる。

- [ ] **Step 3: テストが失敗することを確かめる**

Run: `node --test test/form.test.ts test/setup.test.ts`
Expected: FAIL。

- [ ] **Step 4: 実装する**

- `form` は `FORM_KINDS` の順に、メタに ID と URL が無いものだけ `writeTriggerDef` → `createTrigger` で作り、すぐにメタへ書く（今の 1 つ分と同じ順番と `guard()` の位置）。そのあと 3 つすべてに `grantTriggerAccess` を呼ぶ。
- おすすめ: メタの `FORM_META_FEATURED` が 3 つの ID をつないだものと違えば、`featuredParams(channel, ids)` で 1 回だけ呼ぶ。`restricted_action` のときの扱いは今のまま。
- 古いボタンの片付けは、おすすめの段が終わったあと（成功か手作業の印のあと）にする。`workflows.featured.remove` は失敗しても無視する（すでに外れている場合があるため）。`trigger delete` が通ったら、古い 2 つのキーを `deleteMeta` で消す。通らなければ stderr に知らせて exit 0 のまま終わり、キーは残す。文言は `lib/defaults.ts` に `MSG_FORM_LEGACY_DELETE_FAILED` として置く。
- `setup.ts` の `formDone` は、3 つすべての `form_trigger_id:<key>` と `FORM_META_FEATURED` があり、かつ古いキー `form_trigger_id` が無いときだけ true にする（古いボタンが残っていれば 6 段目で `form` をもう一度走らせて片付けるため）。

- [ ] **Step 5: テストが通ることを確かめる**

Run: `bash test/run-all.sh`
Expected: すべて PASS。

- [ ] **Step 6: Commit**

```bash
git add lib/slack-cli.ts lib/db.ts lib/defaults.ts lib/commands/form.ts lib/commands/setup.ts test/fixtures/fake-slack-cli.ts test/form.test.ts test/setup.test.ts test/unit/slack-cli.test.ts
git commit -m "feat(slack-issue-intake): form で 3 つのボタンを置き、0.2 の 1 つのボタンを片付ける"
```

---

### Task 4: 手で作る手順、手順書、README、版数

**Files:**
- Modify: `lib/guide.ts`（`renderTemplate`、`renderGuide` の 4 段目）
- Modify: `README.md`
- Modify: `skills/slack-issue-intake/references/procedure.md`、`procedure-ja.md`
- Modify: `lib/permissions.ts`（procedure の変更で必要なら）
- Modify: `CLAUDE.md`（プラグインの開発ガイド）
- Modify: `.claude-plugin/plugin.json`、ルートの `.claude-plugin/marketplace.json`
- Test: `test/unit/docs.test.ts`、`test/collect-apply.test.ts`（CA9）

**Interfaces:**
- Consumes: Task 2 の `renderKindMessage(kind, slot)`。
- Produces: `renderTemplate(kind: FormKind): string` — `slot` に `{<ラベル>}` を渡す（タイトルは `{タイトル}`、優先度は `{優先度}`、起票者は `{フォームを送信した人}`）。

- [ ] **Step 1: 失敗するテストを書く**

`test/unit/docs.test.ts`:

- DO1: `FORM_KINDS` の 3 つすべてで、README が `renderTemplate(kind)` を含む。
- DO4: README が `renderGuide()` を含む（今のまま）。加えて、`renderGuide()` が 3 つの題と、3 つの `renderTemplate(kind)` を含む。

- [ ] **Step 2: テストが失敗することを確かめる**

Run: `node --test test/unit/docs.test.ts`
Expected: FAIL。

- [ ] **Step 3: `lib/guide.ts` を直す**

`renderGuide` の 4 段目を、ワークフローを 3 つ作る手順にする。種類ごとに次を書く。

- ボタンの名前（`kind.title`）。
- フォームの項目（タイトル: 短い回答・必須、優先度: リスト選択・必須、各項目: 複数行なら長い回答・1 行なら短い回答、必須か任意、添付ファイル: 今の説明のまま）。
- 「チャンネルへメッセージを送信」に入れるテンプレート `renderTemplate(kind)`。

「ワークフローを目立たせる」で 3 つとも注目にすることも書く。

- [ ] **Step 4: README を直す**

- `node bin/slack-issue-intake.ts guide` の出力で、README の該当の節を置き換える。
- 「未確認」の一覧に次を足す: `send_message` の `message` で `*…*` が太字に、``` がコードブロックになるか。`workflows.featured.add` に 3 つの ID を `,` でつないで渡せるか。
- フォームの説明（ボタンが 3 つ、項目の表）を、設計書 4.2 の表のとおりにする。

- [ ] **Step 5: 手順書を直す**

`procedure.md` の `details` の指示を、カテゴリ別の項目に合わせて英語で書き直す。

- bug: the symptom, the error log, the workaround tried, the screen URL and the source path given in the submission, plus the steps or conditions to reproduce, the expected behavior and the environment as far as they are known.
- request: the current behavior and the ideal behavior, plus the screen URL and the source path when given.
- feature: the specification, plus the goal and the background.

`procedure-ja.md` に同じ変更の訳を入れる。CA9 と `lib/permissions.ts` が手順書の内容を固定していれば、それに合わせる。

- [ ] **Step 6: 開発ガイドと版数を直す**

- `CLAUDE.md`（プラグイン）の form の説明を直す。`form-trigger.json` → `form-trigger-<key>.json`、ワークフローが 3 つ、古いボタンの片付け、`formDone` の条件。
- 版数を `0.3.0` にする（`plugin.json` と `marketplace.json`）。

- [ ] **Step 7: 全体の確認**

Run: `bash test/run-all.sh`
Expected: すべて PASS。

Run（リポジトリのルートで）: `pnpm check`
Expected: 型、biome、`check:doc-lang` がすべて通る。

- [ ] **Step 8: Commit**

```bash
git add lib/guide.ts README.md skills/slack-issue-intake/references/procedure.md skills/slack-issue-intake/references/procedure-ja.md lib/permissions.ts CLAUDE.md .claude-plugin/plugin.json ../../.claude-plugin/marketplace.json test/unit/docs.test.ts test/collect-apply.test.ts
git commit -m "docs(slack-issue-intake): 3 つのフォームの手順と手順書を直し、0.3.0 に上げる"
```

---

## 計画で決めたこと（設計書からの補い）

- 設計書 4.4 の「`SubmissionFields.body` を項目の配列に置き換える」は、**`body` の文字列に「項目名:\n値」を空行区切りで入れる形**で満たす。DB に保存済みの行、work のファイル、Issue 本文の組み立て（`issue-body.ts`）を変えずに済み、Issue の「元の投稿」にも項目名が見出しとして残るため。設計書 4.5 の「項目ごとの見出し」もこれで満たす。
- 古いボタンの片付けは、新しい 3 つのおすすめが済んでから行う。チャンネルからボタンが消える時間を作らないため。
