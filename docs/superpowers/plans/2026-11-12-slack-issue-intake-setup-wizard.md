# slack-issue-intake: make setup ウィザード 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `make setup` を1回実行して質問に答えるだけで、Slack アプリの作成からトークン登録、init、フォームのボタン、権限の承認、有効化までが済むようにする。

**Architecture:**
- Slack CLI 用のプロジェクトを、ホームの隣（`<ホーム>-slack-app`）に生成する。`slack deploy` の deploy フックが、ボットのトークンを受け取って保存する。
- ボタンは `slack trigger create` / `slack trigger access` で作る。
- ウィザード（`setup`）は8段を順に進め、既存の init・form・permissions・enable を子プロセスとして呼ぶ。

**Tech Stack:** Node 24.15+（TypeScript の型除去で直接実行）、node:test、Slack CLI（公開版）、Slack Web API、gh、Orca CLI

**Spec:** `docs/superpowers/specs/2026-11-12-slack-issue-intake-setup-wizard-design.md`

## Global Constraints

- **作業場所:** すべて `apps/slack-issue-intake` の中で行う。実行時の npm 依存は足さない。
- **コードの書き方:**
  - `any`・`unknown`・`class` は使わない。
  - 固定値は `lib/defaults.ts` にまとめる。
  - 外部の文字列を出力・保存する前に `maskSecrets` を通す。
- **言語:** 識別子は英語にする。コメント、利用者向けの文言、README、CLAUDE.md は日本語で書く。`SKILL.md` は英語で書き、`references/guide-ja.md` に同じ見出しの訳を置く。
- **トークン:** 画面・ログ・argv に出さない。表示は `maskToken` の形（`xoxb-***`）だけにする。
- **テスト:**
  - テスト専用の差し替えは、既存の `SLACK_ISSUE_INTAKE_HOME`、`SLACK_ISSUE_INTAKE_API_BASE`、`SLACK_ISSUE_INTAKE_CLAUDE_HOME`、`ORCA_BIN` に、新しく `SLACK_ISSUE_INTAKE_SLACK_CLI` を加える。
  - 実際の Slack・GitHub には接続しない。
- **確認のコマンド:**
  - 全テスト: `bash test/run-all.sh`
  - 型と lint: `MISE_PNPM_VERSION=10.33.0 pnpm --filter @tanaka-yui/slack-issue-intake check`
  - 文書の言語: `MISE_PNPM_VERSION=10.33.0 pnpm check:doc-lang`（リポジトリのルートで実行）
- **コミット:** ユーザーの指示があるまでしない。各タスクの最後はコミットではなく、テストの通過で区切る。

## Review Focus

1. シェルにすでに `SLACK_BOT_TOKEN` が入っている（別の Slack プロジェクトの値など）。保存されるのは、今回 deploy したアプリのトークンでなければならない。（タスク 2 の SC2、タスク 5 の SU1）
2. チャンネル名の書き方の違い。先頭の `#` や全角の `＃`、大文字、前後の空白、チャンネル ID の直接入力は、すべて同じチャンネルとして解決する。（タスク 4 の CH1、CH3）
3. チャンネルが多いワークスペース。目的のチャンネルが `conversations.list` の2ページ目以降にあっても見つける。同名のアーカイブ済みチャンネルは対象にしない。（タスク 4 の CH2）
4. 完了後や途中で失敗したあとの再実行。アプリ・ボタン・ブックマークを重ねて作らない。済んだ承認を聞き直さない。（タスク 5 の SU2、SU7）
5. `slack deploy` は成功したのに、フックがトークンを受け取れなかった。この場合は init へ進まず、set-token の手順を示して止まる。（タスク 5 の SU4）

---

### Task 1: マニフェストの権限、ボタンの定義、Slack CLI のフック

**Files:**
- Modify: `lib/defaults.ts`（FORM_EXTRA_SCOPES、定数の追加と削除）
- Modify: `lib/form.ts`（`triggerParams` と `permissionParams` を外し、`triggerDefinition` を足す）
- Create: `lib/slack-cli.ts`（このタスクでは、プロジェクトのパスとフックの定義だけ）
- Create: `lib/commands/slack-hook.ts`
- Modify: `bin/slack-issue-intake.ts`（`'slack-hook'` を COMMANDS に追加）
- Test: `test/unit/form.test.ts`（FM1・FM4 を更新）、`test/unit/slack-cli.test.ts`（SC3・SC4）、`test/slack-hook.test.ts`（SH1〜SH3）

**Interfaces:**
- Produces:
  - `FORM_EXTRA_SCOPES = ['channels:read', 'groups:read', 'channels:join', 'bookmarks:write']`。`triggers:write` は外す。`FORM_TRIGGER_PERMISSION` は旧関数が使っているので、タスク 3 で消す。
  - `SLACK_APP_DIR_SUFFIX = '-slack-app'`、`TRIGGER_DEF_FILE = 'form-trigger.json'`、`MANIFEST_HASH_FILE = 'manifest.sha256'`、`SLACK_HOOK_TOKEN_ENV = 'SLACK_BOT_TOKEN'`
  - `triggerDefinition(channel: string): JsonObject`（`lib/form.ts`）: `{ type: 'shortcut', name: FORM_TITLE, description: FORM_DESCRIPTION, workflow: '#/workflows/issue_intake_form', inputs: { interactivity: { value: '{{data.interactivity}}' }, channel_id: { value: channel }, user_id: { value: '{{data.user_id}}' } } }`。inputs は JSON 文字列ではなくオブジェクトのまま持つ。
  - `type SlackProject = { dir: string; hooks: string; config: string; apps: string; triggerDef: string; manifestHash: string }`
  - `slackProject(home: string): SlackProject`: `dir = resolve(home) + SLACK_APP_DIR_SUFFIX`、`hooks = dir/.slack/hooks.json`、`config = dir/.slack/config.json`、`apps = dir/.slack/apps.json`、`triggerDef = dir/form-trigger.json`、`manifestHash = dir/manifest.sha256`
  - `hooksInterface(): JsonObject`: `{ runtime: 'node', hooks: { 'get-hooks': C('get-hooks'), 'get-manifest': C('get-manifest'), deploy: C('deploy') } }`。`C(x)` は `${shellQuote(process.execPath)} ${shellQuote(<pluginRoot>/bin/slack-issue-intake.ts)} slack-hook ${x}` とする。
  - `writeProject(project: SlackProject): void`: dir と `.slack` を 0700 で作る。`hooks.json` に `hooksInterface()` を、`config.json` に `{ manifest: { source: 'local' } }` を書く（毎回上書き）。
  - `slack-hook` サブコマンドは、次の3つを受け持つ。
    - `get-hooks`: `hooksInterface()` を JSON で出力する。
    - `get-manifest`: `renderFormManifest()` を出力する。
    - `deploy`: `process.env.SLACK_BOT_TOKEN` が `isBotToken` を満たせば `saveToken` する。表示は `saved token=${maskToken(t)}` だけにして exit 0。満たさなければ何も保存せず、stderr に `Slack CLI からボットのトークンを受け取れませんでした` を出して exit 1。

- [ ] **Step 1: 失敗するテストを書く**

```ts
// test/unit/form.test.ts
test('FM1 …', () => {
  // 既存の検査に加えて
  assert.deepEqual(get(form, 'oauth_config', 'scopes', 'bot'), [...SLACK_BOT_SCOPES, 'channels:read', 'groups:read', 'channels:join', 'bookmarks:write'])
  assert.ok(!renderFormManifest().includes('triggers:write'))
})
test('FM4 ボタンは設定のチャンネルへ固定し、押した人と操作の文脈を渡す', () => {
  const d = triggerDefinition(CHANNEL)
  assert.equal(d.type, 'shortcut'); assert.equal(d.name, FORM_TITLE)
  assert.equal(d.workflow, `#/workflows/${FORM_WORKFLOW_ID}`)
  assert.deepEqual(d.inputs, { interactivity: { value: '{{data.interactivity}}' }, channel_id: { value: CHANNEL }, user_id: { value: '{{data.user_id}}' } })
  // ワークフローの required と inputs のキーが一致する（今の FM4 と同じ確認）
})
// test/unit/slack-cli.test.ts
test('SC3 Slack CLI のプロジェクトはホームの隣に置き、ホームの中には置かない', () => {
  const p = slackProject('/x/.slack-issue-intake/')
  assert.equal(p.dir, '/x/.slack-issue-intake-slack-app')
  assert.equal(p.apps, '/x/.slack-issue-intake-slack-app/.slack/apps.json')
})
test('SC4 hooks.json は絶対パスのフックを書き、get-hooks の出力と同じになる', () => {
  // writeProject(slackProject(tempHome())) → hooks.json を読む
  // hooks['deploy'] が process.execPath と '<pluginRoot>/bin/slack-issue-intake.ts' と 'slack-hook deploy' を含む
  // runCli(['slack-hook', 'get-hooks'], {}) の stdout を JSON にしたものと deepEqual
  // config.json が { manifest: { source: 'local' } }、dir の権限が 0o700
})
// test/slack-hook.test.ts
test('SH1 deploy フックは環境変数のボットトークンを保存し、伏せた形だけを表示する', () => {
  const r = runCli(['slack-hook', 'deploy'], { SLACK_ISSUE_INTAKE_HOME: home, SLACK_BOT_TOKEN: 'xoxb-111-secret' })
  assert.equal(r.code, 0); assert.equal(r.stdout, 'saved token=xoxb-***\n')
  assert.equal(loadToken(homePaths(home).secrets), 'xoxb-111-secret')
  assert.ok(!`${r.stdout}${r.stderr}`.includes('111-secret'))
})
test('SH2 トークンが無いか xoxb- でなければ、何も保存せずに失敗する', () => {
  // SLACK_BOT_TOKEN なし → code 1、SLACK_BOT_TOKEN='xoxp-1' → code 1、どちらも secrets.json が無い
})
test('SH3 get-manifest はフォーム付きのマニフェストをそのまま返す', () => {
  assert.equal(runCli(['slack-hook', 'get-manifest'], {}).stdout, `${renderFormManifest()}\n`)
})
```

- [ ] **Step 2: 失敗を確かめる**

Run: `node --test test/unit/form.test.ts test/unit/slack-cli.test.ts test/slack-hook.test.ts`
Expected: FAIL（`triggerDefinition`・`slackProject` が無い、`slack-hook` が使用法エラー）

- [ ] **Step 3: 上の Interfaces どおりに実装する**

`lib/commands/form.ts` は、まだ `triggerParams` / `permissionParams` を使っている。このタスクでは import を外さず、タスク 3 で書き換える。型検査を通すため、`lib/form.ts` に旧関数を残してもよい。その場合は、タスク 3 の最後で必ず消す。

- [ ] **Step 4: 通過を確かめる**

Run: `node --test test/unit/form.test.ts test/unit/slack-cli.test.ts test/slack-hook.test.ts`
Expected: PASS

### Task 2: Slack CLI の呼び出し

**Files:**
- Modify: `lib/slack-cli.ts`
- Modify: `lib/defaults.ts`
- Create: `test/fixtures/fake-slack-cli.ts`
- Modify: `test/helpers.ts`（`fakeSlackCli`、`slackCliCalls`、`seedSlackApp`）
- Test: `test/unit/slack-cli.test.ts`（SC1・SC2・SC5）、`test/slack-cli.test.ts`（SC6・SC7）

**Interfaces:**
- Consumes: タスク 1 の `SlackProject`、`slackProject`、`writeProject`、`triggerDefinition`
- Produces（すべて `lib/slack-cli.ts`）:
  - 定数（`lib/defaults.ts`）:
    - `SLACK_CLI_ENV = 'SLACK_ISSUE_INTAKE_SLACK_CLI'`
    - `SLACK_CLI_STANDARD_PATH: readonly string[] = ['.slack', 'bin', 'slack']`
    - `SLACK_CLI_FINGERPRINT = 'd41d8cd98f00b204e9800998ecf8427e'`
    - `SLACK_CLI_LOGGED_OUT_TEXT = 'You are not logged in'`
    - `SLACK_APP_ENVIRONMENT = 'deployed'`
    - `SLACK_TOKEN_ENV_NAMES: readonly string[] = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_USER_TOKEN']`
    - `SHORTCUT_URL_PATTERN = /https:\/\/[a-z0-9.-]*slack\.com\/shortcuts\/(Ft[0-9A-Z]+)\/[0-9A-Za-z]+/`
  - `findSlackCli(): string | null`: 次の順に探す。
    1. `process.env[SLACK_CLI_ENV]`（実行可能なら、そのまま使う）
    2. `join(homedir(), ...SLACK_CLI_STANDARD_PATH)`（実行可能なら、そのまま使う）
    3. PATH 上の `slack`。`slack _fingerprint` の出力が `SLACK_CLI_FINGERPRINT` と一致したときだけ使う。
  - `slackLoggedIn(bin: string): boolean`: `auth list --skip-update` が exit 0 で、出力に `SLACK_CLI_LOGGED_OUT_TEXT` を含まないとき true。
  - `deployedApp(project: SlackProject): { appId: string; teamId: string } | null`: `apps.json` の `apps` にある最初の項目の `app_id` と `team_id`。無い・壊れているときは null。
  - `manifestHash(): string`（`renderFormManifest()` の SHA-256 の16進）、`readDeployedHash(project): string | null`、`saveDeployedHash(project, hash: string): void`
  - `deployEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv`: `SLACK_TOKEN_ENV_NAMES` だけを取り除いた写しを返す。
  - `runDeploy(bin: string, project: SlackProject, teamId: string | null): number`: `[bin, 'deploy', '--app', 'deployed', '--skip-update', ...(teamId ? ['--team', teamId] : [])]` を実行する。`cwd: project.dir`、`stdio: 'inherit'`、`env: deployEnv(process.env)` とし、終了コードを返す。
  - `writeTriggerDef(project: SlackProject, channel: string): void`: `triggerDefinition(channel)` を `project.triggerDef` に書く。
  - `parseShortcutUrl(output: string): { triggerId: string; url: string } | null`
  - `createTrigger(bin, project, teamId): { ok: true; triggerId: string; url: string } | { ok: false; error: string }`: `['trigger', 'create', '--trigger-def', project.triggerDef, '--app', 'deployed', '--team', teamId, '--skip-update', '--no-color']` を実行する。stdin は ignore、stdout と stderr は pipe でつなぐ。error は `maskSecrets` したうえで、stderr、stdout、`exit N` の順に、最初に空でないものを使う。
  - `grantTriggerAccess(bin, project, teamId, triggerId, channel): { ok: true } | { ok: false; error: string }`: `['trigger', 'access', '--trigger-id', triggerId, '--channels', channel, '--grant', '--include-app-collaborators=false', '--app', 'deployed', '--team', teamId, '--skip-update', '--no-color']`
- テスト用の偽物（`test/fixtures/fake-slack-cli.ts` と、`test/helpers.ts` の `fakeSlackCli(dir) → { path, log, env: { SLACK_ISSUE_INTAKE_SLACK_CLI: path, FAKE_SLACK_CLI_LOG: log } }`）:
  - 記録: 1行ごとに `{ argv, cwd, hadBotToken, triggerDef? }` を書く。
  - `_fingerprint`: 指紋を出力する。
  - `auth list`: `FAKE_SLACK_CLI_LOGGED_OUT` があれば未ログインの文言を、無ければ `acme T0… ` の行を出力する。
  - `deploy`: 次の順に本物を真似る。
    1. cwd の `.slack/hooks.json` の get-manifest を `sh -c` で実行し、JSON として読めなければ exit 1。
    2. `.slack/apps.json` を書く（あれば app_id を保つ）。
    3. deploy フックを実行する。本物と同じく、`SLACK_BOT_TOKEN` がすでにあればその値のまま渡す。無ければ `xoxb-fake-deployed` を入れて渡す。`FAKE_SLACK_CLI_NO_TOKEN` があれば入れない。
  - `trigger create`: `--trigger-def` の JSON を記録する。`Trigger successfully created!` の行に続けて `https://slack.com/shortcuts/Ft0FAKE001/abc123` を出力する。`FAKE_SLACK_CLI_TRIGGER_FAIL` があれば stderr に出して exit 1。
  - `trigger access`: 記録して exit 0。
  - `seedSlackApp(home, teamId)`: `writeProject` のあと `apps.json` を書く（タスク 3 のテスト用）。

- [ ] **Step 1: 失敗するテストを書く**

```ts
// test/unit/slack-cli.test.ts
test('SC1 parseShortcutUrl は前後の行があっても URL とボタンの ID を取り出し、無ければ null', () => {
  const out = '⚡ Trigger successfully created!\n   Issue を起票 Ft0ABC123 (shortcut)\n   https://slack.com/shortcuts/Ft0ABC123/0a1b2c\n'
  assert.deepEqual(parseShortcutUrl(out), { triggerId: 'Ft0ABC123', url: 'https://slack.com/shortcuts/Ft0ABC123/0a1b2c' })
  assert.equal(parseShortcutUrl('no url'), null)
})
test('SC2 deployEnv はトークンの環境変数だけを取り除く', () => {
  const env = deployEnv({ PATH: '/bin', SLACK_BOT_TOKEN: 'xoxb-1', SLACK_APP_TOKEN: 'xapp-1', SLACK_USER_TOKEN: 'xoxp-1', SLACK_ISSUE_INTAKE_HOME: '/h' })
  assert.deepEqual(env, { PATH: '/bin', SLACK_ISSUE_INTAKE_HOME: '/h' })
})
test('SC5 deployedApp は apps.json のアプリを返し、無いか壊れていれば null', () => { /* 3通り */ })
// test/slack-cli.test.ts（偽の Slack CLI）
test('SC6 runDeploy は手元の SLACK_BOT_TOKEN を渡さず、フックが今のアプリのトークンを保存する', () => {
  // 環境に SLACK_BOT_TOKEN='xoxb-from-shell' を置いたまま、子プロセスで runDeploy を実行する
  // （テスト用の小さな node スクリプト。process.env を変えるため）
  // 記録の deploy 行で hadBotToken === false、loadToken === 'xoxb-fake-deployed'、apps.json がある
})
test('SC7 findSlackCli は差し替え、標準の場所、PATH の順に探し、PATH の slack は指紋が合うときだけ使う', () => {
  // 子プロセスで HOME=空の一時ディレクトリにして確かめる:
  // (a) 差し替えあり → その場所 (b) 差し替えなし・PATH に指紋の違う slack → null (c) 指紋が合う slack → その場所
})
```

- [ ] **Step 2: 失敗を確かめる**

Run: `node --test test/unit/slack-cli.test.ts test/slack-cli.test.ts`
Expected: FAIL（関数が無い）

- [ ] **Step 3: 上の Interfaces どおりに実装する**（子プロセスは `spawnSync`。stdin を ignore するのは `createTrigger` と `grantTriggerAccess`。`runDeploy` だけは Slack CLI の質問に答えられるよう、端末につなぐ）

- [ ] **Step 4: 通過を確かめる**

Run: `node --test test/unit/slack-cli.test.ts test/slack-cli.test.ts`
Expected: PASS

### Task 3: form を Slack CLI で作る形に書き換える

**Files:**
- Modify: `lib/commands/form.ts`、`lib/defaults.ts`（`MSG_FORM_REFUSED`、`MSG_FORM_NO_APP`）、`lib/form.ts`（旧関数を削除）
- Test: `test/form.test.ts`（FO1〜FO5 を書き直す）

**Interfaces:**
- Consumes: タスク 2 の `findSlackCli`、`deployedApp`、`writeTriggerDef`、`createTrigger`、`grantTriggerAccess`、`slackProject`、テスト用の `fakeSlackCli`・`seedSlackApp`
- Produces: `form` の動き（タスク 5 が子プロセスとして呼ぶ）。
  - 前提が欠けたときは exit 2 で止まる。
    - `openRuntime` が失敗したとき（設定やトークンが無い）
    - `deployedApp` が null のとき。stderr に `MSG_FORM_NO_APP` を出す。文言は「make setup で作ったアプリが見つかりません。フォームは README の「Workflow Builder で手で作る」の手順で作ってください」。
    - `findSlackCli` が null のとき
  - `app.teamId` か `auth.test` のチームが設定と違えば、「トークンのワークスペースが設定と違います」で exit 1。
  - ボタンが meta に無ければ作る。`writeTriggerDef` → `createTrigger` の順に呼び、作ったらすぐ meta の `FORM_META_TRIGGER_ID` と `FORM_META_URL` に記録する。失敗したら `MSG_FORM_REFUSED`（`{error}` 入り）で exit 1。文言は「Slack CLI でフォームのボタンを作れませんでした（{error}）。フォームは README の「Workflow Builder で手で作る」の手順で作ってください」。
  - `grantTriggerAccess` は毎回呼ぶ。
  - ブックマークは今のまま。出力も今と同じ `trigger=/url=/channel=/bookmark=` にする。

- [ ] **Step 1: 失敗するテストを書く**（今の FO1〜FO5 を次のとおり置き換える）

```ts
test('FO1 Slack CLI でボタンを作り、チャンネルのメンバーに限って使えるようにし、ブックマークを置く。再実行で重ねない', async (t) => {
  // seedSlackApp(home, TEAM_ID) と fakeSlackCli を使う
  // trigger create の argv に '--trigger-def'、'--app'、'deployed'、'--team'、TEAM_ID、'--skip-update'、'--no-color' がある
  // 記録した triggerDef.inputs.channel_id が { value: CHANNEL }
  // trigger access の argv に '--trigger-id' 'Ft0FAKE001' '--channels' CHANNEL '--grant' '--include-app-collaborators=false'
  // bookmarks.add の params が { channel_id: CHANNEL, title: FORM_TITLE, type: 'link', link: 'https://slack.com/shortcuts/Ft0FAKE001/abc123' }
  // 再実行: create 1回、bookmarks.add 1回、access 2回
})
test('FO2 Slack CLI がボタンを作れなければ、Workflow Builder の手順へ案内して何も残さない', …)  // FAKE_SLACK_CLI_TRIGGER_FAIL: code 1、stderr に 'Workflow Builder'、access と bookmark なし、meta なし
test('FO3 ブックマークだけ失敗したら URL を示し、再実行ではボタンを作り直さずにブックマークだけ足す', …)  // 今の FO3 と同じ確認
test('FO4 トークンのワークスペースが設定と違えば何も作らない', …)  // 今の FO4 と同じ。trigger create が0回
test('FO5 --manifest は設定なしで出し、make setup のアプリが無ければ案内して止まる', …)  // --manifest は今と同じ。seedSlackApp なし → code 2、stderr に 'make setup'
```

- [ ] **Step 2: 失敗を確かめる**

Run: `node --test test/form.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装する。** `workflows.triggers.create` と `workflows.triggers.permissions.set` の呼び出しを消す。`lib/form.ts` の `triggerParams` と `permissionParams`、`lib/defaults.ts` の `FORM_TRIGGER_PERMISSION` も消す。

- [ ] **Step 4: 通過を確かめる**

Run: `node --test test/form.test.ts test/unit/form.test.ts`
Expected: PASS。続けて `MISE_PNPM_VERSION=10.33.0 pnpm --filter @tanaka-yui/slack-issue-intake check` が通る（使われない import や関数が残っていない）。

### Task 4: チャンネル名から ID を解決する

**Files:**
- Create: `lib/channels.ts`
- Modify: `lib/defaults.ts`（`CHANNEL_PAGE_SIZE = 200`）
- Test: `test/channels.test.ts`

**Interfaces:**
- Consumes: `SlackClient`、`SlackFailure`（`lib/slack-api.ts`）、`CHANNEL_ID_PATTERN`
- Produces:
  - `type Channel = { id: string; name: string; isPrivate: boolean; isMember: boolean }`
  - `normalizeChannelName(input: string): string`: 前後の空白、先頭の `#` / `＃` を除き、小文字にする。
  - `findChannel(slack, input, deadline): Promise<{ ok: true; channel: Channel | null } | SlackFailure>`
    - 正規化した値が `CHANNEL_ID_PATTERN` に合う場合は、`conversations.info` を呼ぶ（入力は大文字に戻す）。
    - それ以外は `conversations.list` を全ページ引き、名前が一致するものを返す。引数は `types=public_channel,private_channel`、`exclude_archived=true`、`limit=200`、`cursor` とする。
    - 一致が無ければ `channel: null`。
  - `joinChannel(slack, channelId, deadline): Promise<{ ok: true } | SlackFailure>`: `conversations.join`

- [ ] **Step 1: 失敗するテストを書く**

```ts
test('CH1 先頭の # や全角の ＃、大文字、前後の空白を除いて名前をそろえる', () => {
  assert.equal(normalizeChannelName(' #Issue-Intake '), 'issue-intake')
  assert.equal(normalizeChannelName('＃issue-intake'), 'issue-intake')
})
test('CH2 2ページ目のチャンネルも見つけ、アーカイブ済みを除くよう頼む', async (t) => {
  // 1ページ目: 別名 + next_cursor 'c2'、2ページ目: { id: 'C0TARGET01', name: 'issue-intake', is_private: false, is_member: false }
  // 結果 channel が { id: 'C0TARGET01', name: 'issue-intake', isPrivate: false, isMember: false }
  // requests[0].params に types / exclude_archived: 'true' / limit: '200'、requests[1].params.cursor === 'c2'
})
test('CH3 チャンネル ID を入れたら conversations.info で確かめる', …)  // 'c0target01' でも info の channel=C0TARGET01、list は呼ばない
test('CH4 見つからなければ channel は null、Slack のエラーはそのまま返す', …)  // missing_scope など
test('CH5 joinChannel は conversations.join を呼ぶ', …)
```

- [ ] **Step 2: 失敗を確かめる** — Run: `node --test test/channels.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装する**（ページ送りは `response_metadata.next_cursor` が空になるまで）
- [ ] **Step 4: 通過を確かめる** — Run: `node --test test/channels.test.ts` / Expected: PASS

### Task 5: 入力の読み取りとウィザード本体

**Files:**
- Create: `lib/prompt.ts`、`lib/commands/setup.ts`
- Modify: `bin/slack-issue-intake.ts`（`setup` を追加）、`Makefile`（`setup` ターゲットを先頭に置き、help の1行目にする）、`lib/defaults.ts`（`SETUP_STEPS = 8`、`NODE_MIN_VERSION = [24, 15]`、表示の文言）
- Test: `test/unit/prompt.test.ts`（PR1）、`test/setup.test.ts`（SU1〜SU9）

**Interfaces:**
- Consumes:
  - タスク 1〜4 の関数
  - 既存の関数: `loadToken`、`loadConfig`、`findGhPath`、`createGh`、`ghAuthOk`、`repoInfo`、`runOrca`、`permissionStatus`、`inheritedGrants`、`createSlackClient`、`isAllowedEvery`、`REPO_PATTERN`、`LABEL_WRITE_PERMISSIONS`、`MSG_PUSH_REQUIRED`
- Produces:
  - `type Prompter = { ask: (question: string, fallback?: string) => string | null; confirm: (question: string) => boolean | null }`
  - `createPrompter(fd: number, out: (text: string) => void): Prompter`
    - `ask`: `question`（fallback があれば ` [fallback]` を付けて）と `: ` を出し、1行を同期で読む。空なら `fallback ?? ''`、入力が尽きていれば null を返す。読み残しは次の呼び出しへ持ち越す。`EAGAIN` は少し待って読み直す。
    - `confirm`: `${question} [y/N]: ` を出し、`y` か `yes`（大小を問わない）なら true、それ以外は false、入力が尽きていれば null を返す。
  - `setup` の動き（設計書の「ウィザードの流れ」どおり）:
    - 各段の見出しは `[n/8] 見出し` の形にする。済んだ段は `済み` と表示する。
    - 終了コード: 0 は完了。1 は失敗、または承認しなかったとき。2 は入力が尽きたとき（stderr に「入力がありません。ターミナルで make setup を実行してください」）。
    - 自分のコマンドは `spawnSync(process.execPath, [<pluginRoot>/bin/slack-issue-intake.ts, ...args], { stdio: ['ignore', 'inherit', 'inherit'] })` で呼ぶ。0 以外が返ったら、その終了コードで止まる。
    - 2段目: トークンがあり、`deployedApp` があり、`readDeployedHash === manifestHash()` なら飛ばす。トークンはあるがアプリが無ければ、手作業のアプリとして deploy せずに進む（6段目で Workflow Builder を案内する）。それ以外は `writeProject` → `runDeploy(bin, project, app?.teamId ?? null)` の順に呼ぶ。そのあとトークンが無ければ、set-token の手順を示して exit 1。成功したら `saveDeployedHash` する。
    - 3〜5段目は、設定ファイルがあれば飛ばす。
      - 3段目: 見つからないときは「Slack で `/invite @Issue Intake` を送ってから Enter」と示し、もう一度読む。そのときの既定値は前の入力にする。公開チャンネルでメンバーでなければ `joinChannel` を呼ぶ。
      - 4段目: 公開リポジトリは `confirm` で確かめ、承認されたら init に `--allow-public` を付ける。
    - 7・8段目の飛ばし方は、設計書の表どおり。8段目は、受け継ぐ許可があるときだけ一覧（`maskSecrets` 済み）を出して `confirm` で聞き、承認されたら `enable --accept-inherited` を実行する。

- [ ] **Step 1: 失敗するテストを書く**

```ts
// test/unit/prompt.test.ts
test('PR1 1行ずつ読み、既定値・y/N・入力の終わりを扱う', () => {
  // 一時ファイル 'acme/app\n\n y \nYES\nn\n' を開いた fd で createPrompter
  // ask('Q') === 'acme/app'、ask('Q', '5') === '5'、confirm === true、confirm === true、confirm === false、ask('Q') === null
  // out に 'Q: ' と 'Q [5]: ' と ' [y/N]: ' が渡る
})
// test/setup.test.ts（fakeGh・fakeOrca・fakeSlackCli・startSlack・SLACK_ISSUE_INTAKE_CLAUDE_HOME。PATH の先頭に gh の偽物）
// 偽の Slack API: auth.test、conversations.list（2ページ。目的の 'issue-intake' は2ページ目、公開・非メンバー）、
//   conversations.join、conversations.history（init の確認）、bookmarks.add
test('SU1 質問に答えるだけで、アプリ・トークン・設定・ボタン・承認・有効化までそろう', …)
  // 環境に SLACK_BOT_TOKEN='xoxb-from-shell' を置き、入力 '#Issue-Intake\nacme/app\n\ny\n'
  // code 0、stdout に '[1/8]' と '[8/8]'
  // deploy は1回で hadBotToken === false、argv に '--team' が無い（ワークスペースは Slack CLI に選ばせる）
  // loadToken === 'xoxb-fake-deployed'。出力に 'xoxb-fake-deployed' を含まない
  // conversations.join の channel === 'C0TARGET01'。loadConfig の channel === 'C0TARGET01'、repo === 'acme/app'、everyMinutes === 5
  // triggerDef.inputs.channel_id.value === 'C0TARGET01'。bookmarks.add が1回
  // config.acceptedPermissions が null でない。orca の記録の最後が automations edit auto-1 --enabled
test('SU2 もう一度実行すると、済んだ段を飛ばしてアプリ・ボタン・ブックマークを重ねない', …)  // 入力 '' でも code 0、deploy・trigger create・bookmarks.add はどれも1回、stdout に '済み'
test('SU3 マニフェストが変わっていれば、同じチームを指定して deploy し直す', …)  // manifest.sha256 を書き換えて再実行 → 2回目の deploy の argv に '--team' TEAM_ID
test('SU4 フックがトークンを受け取れなければ、set-token の手順を示して止まる', …)  // FAKE_SLACK_CLI_NO_TOKEN → code 1、stderr に 'set-token'、設定ファイルなし
test('SU5 Slack CLI が無い・未ログインなら、何も作らずに止まる', …)  // (a) HOME=空、PATH=gh だけ、差し替えなし → code 1、'Slack CLI' (b) FAKE_SLACK_CLI_LOGGED_OUT → code 1、'slack login'、deploy なし
test('SU6 見つからないチャンネルはボットの招待を待ち、Enter のあとに探し直す', …)
  // 'secret'（is_private: true, is_member: true）は2回目の conversations.list から現れる
  // 入力 'secret\n\nacme/app\n\ny\n' → stdout に '/invite @Issue Intake'、join なし、channel === 'G0SECRET01'
test('SU7 承認しなければ何も変えずに止まり、次の実行で承認から再開する', …)
  // 入力 '#issue-intake\nacme/app\n\nn\n' → code 1、permissionStatus === 'unsafe'、--enabled なし
  // 続けて入力 'y\n' → code 0、deploy は合わせて1回
test('SU8 入力が途中で尽きたら、ターミナルで実行するよう示して止まる', …)  // 入力 '' → code 2、stderr に 'ターミナルで make setup'
test('SU9 公開リポジトリは内容が公開されると示して確かめ、承認したら --allow-public で init する', …)  // FAKE_GH_VISIBILITY=PUBLIC、入力 '#issue-intake\nacme/app\ny\n\ny\n' → code 0、設定あり
```

- [ ] **Step 2: 失敗を確かめる** — Run: `node --test test/unit/prompt.test.ts test/setup.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装する**（ウィザードは管理用のリースを持たない。子のコマンドがそれぞれ取るため、親が持つと止まる）
- [ ] **Step 4: 通過を確かめる** — Run: `bash test/run-all.sh` / Expected: 全件 PASS

### Task 6: 文書

**Files:**
- Modify: `lib/guide.ts`、`README.md`、`skills/slack-issue-intake/SKILL.md`、`skills/slack-issue-intake/references/guide-ja.md`、`CLAUDE.md`（アプリ）、`test/unit/docs.test.ts`

**Interfaces:**
- Consumes: タスク 5 の `make setup`。タスク 1 の `FORM_EXTRA_SCOPES`。
- Produces（文書の内容。設計書の「文書の変更」どおり）:
  - `renderGuide()`: Slack CLI を使わない手順にする。
    - 1行目に「Slack CLI にログインしているなら、この手順の代わりに make setup を使えます。」を置く。
    - 手順は8段（アプリ、トークン、招待、Workflow Builder、チャンネル ID、init、permissions、enable）。form の段と、フォーム付きのマニフェストの記述は外す。
    - コマンドはすべて、バッククォートで囲んだ `node bin/slack-issue-intake.ts …` の形にする。
  - README は次の構成にする。
    - 「必要なもの」: Slack CLI（ログイン済み）を足す。
    - 「セットアップ」: `make setup` を中心に書く。実行する場所、聞かれること（8段の表）、再開の仕方、終わったあとの確かめ方（`node bin/slack-issue-intake.ts inspect --raw`）、未確認の4点、うまくいかないときの表、送り先を変えたあとの片付け（`slack trigger delete` とブックマーク）を載せる。
    - 「Slack CLI を使わないセットアップ」: `renderGuide()` の出力と、Workflow Builder の詳しい手順を載せる。
    - 前回の「フォームの作り方」の make の手順は消す。
    - 動作確認・運用: コマンドを略さない。運用では `~/.slack-issue-intake/bin/slack-issue-intake …` を使い、`node bin/slack-issue-intake.ts …` と同じ働きであることを書く。
  - SKILL.md の init の冒頭に、次の1文を入れる。英語で書き、guide-ja.md に訳を置く。
    > Recommend that the user run `make setup` in a terminal from the plugin directory; it is interactive and cannot run in the agent's shell.

    form の節は、Slack CLI で作る形に直す。
  - アプリの CLAUDE.md の「フォームの自動作成」を「セットアップのウィザード」に書き換える。

- [ ] **Step 1: 失敗するテストを書く**

```ts
test('DO4 README の案内は guide の出力そのもので、make setup とフォームの権限を載せる', () => {
  assert.ok(readme.includes(renderGuide()))
  assert.ok(readme.includes('make setup'))
  for (const scope of FORM_EXTRA_SCOPES) assert.ok(readme.includes(scope))
  for (const target of ['setup', 'slack-form', 'manifest']) assert.match(makefile, new RegExp(`^${target}:`, 'm'))
  assert.ok(!renderGuide().includes('form --manifest'))
})
```

- [ ] **Step 2: 失敗を確かめる** — Run: `node --test test/unit/docs.test.ts` / Expected: FAIL
- [ ] **Step 3: 文書を書き直す**（README の日本語は natural-japanese の lint と `--reading-load` で確かめる）
- [ ] **Step 4: 通過を確かめる**
  - `bash test/run-all.sh` が全件 PASS
  - `MISE_PNPM_VERSION=10.33.0 pnpm --filter @tanaka-yui/slack-issue-intake check` が通る
  - `MISE_PNPM_VERSION=10.33.0 pnpm check:doc-lang` が OK
  - `git diff --check` が空
