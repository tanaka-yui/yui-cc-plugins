# ワークスペースごとの受付と、--auto の複数の intake 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** slack-issue-intake をワークスペースごとに名前つきのホームで設定できるようにし、orca-team-dispatch-task の `--auto` が複数の intake の設定ファイルを読んで 1 本のキューで処理できるようにする。

**Architecture:** slack-issue-intake は CLI の入口（`bin/slack-issue-intake.ts`）で `--name` を取り出してホームを決め、子のコマンドとランチャーには今のとおりホームを環境で渡す。automation の名前はホームの名前から作る。`--auto` は設定の `intakeConfigs`（配列）を読み、拾う元の候補を各 intake の `repos` の和にする。ホームの名前の規則は 2 つのプラグインの約束として `check-shared-contracts.mjs` で照合する。

**Tech Stack:** TypeScript（node で型を除いて直接実行、実行時の npm 依存なし）、node:test、bash のテスト。

**Spec:** `docs/superpowers/specs/2026-11-18-intake-multi-workspace-design.md`

パスは各プラグインのディレクトリ（`apps/slack-issue-intake/`・`apps/orca-team-dispatch-task/`）からの相対。`scripts/` はリポジトリのルート。

## Global Constraints

- TypeScript で `any` / `unknown` / `class` を使わない。`erasableSyntaxOnly`。型だけの import は `import type`。実行時の npm 依存を足さない。
- 名前を付けないときの振る舞い（ホーム `~/.slack-issue-intake`、automation の名前 `slack-issue-intake`、`--auto` の古い `intakeConfig`）を変えない。
- `SLACK_ISSUE_INTAKE_HOME` は今のままテスト専用。`--name` と両方あれば exit 2。
- 名前の規則: `/^[a-z0-9][a-z0-9-]{0,31}$/` に合い、かつ `-slack-app` で終わらない。
- **`apps/slack-issue-intake/CLAUDE.md` にはユーザーの未コミットの変更がある。このファイルは worktree の中で編集してよいが、親の checkout の変更とぶつからないよう、「セットアップのウィザード」の節の末尾に段落を 1 つ足すだけにする**（ほかの行を書き換えない）。
- 版を上げない。push しない。`git add` はファイルを名指しする。タスクごとに commit する。
- 検証: slack-issue-intake は `bash test/run-all.sh`、orca-team-dispatch-task は `bash test/run-all.sh < /dev/null`（最後の行が `ALL GREEN`）。型と lint は各プラグインで `../../node_modules/.bin/tsc --noEmit -p .` と `../../node_modules/.bin/biome check <そのプラグインの対象>`（worktree に node_modules が無ければ親の道具を絶対パスで、orca-team-dispatch-task は `--typeRoots` 付きで）。ルートで `node scripts/check-doc-lang.mjs` と `node scripts/check-shared-contracts.mjs`。pnpm は mise の shim で動かない。
- 本物の Slack・Orca・GitHub・`~/.slack-issue-intake*`・`~/.claude` に触れない（テストは一時ディレクトリと既存のテスト用の環境変数で閉じる）。
- `SKILL.md` と `references/*.md`（`-ja` 以外）は英語のみ。変えたら `guide-ja.md` / `-ja.md` も同じ commit で変える。

## Review Focus

- **`--name` が不正（空、大文字、`/` や `..` を含む、33 文字、`-slack-app` で終わる）**: ホームを作らずに exit 2 → Task 1 の MW2。
- **`--name` がサブコマンドの後ろ（`status --name ws2`）**: サブコマンド自身のオプションと混ざらない。共通のオプションはサブコマンドの前だけで受け付け、後ろにあればそのサブコマンドの引数として今までどおり扱う → Task 1 の MW3。
- **名前つきのホームで setup が子のコマンド（enable など）を起こす**: 子も同じホームを使う → Task 1 の MW4。
- **`--auto` の intake のうち 1 つが読めない**: ほかの intake の拾う元は動き続け、tick の出力に 1 回だけ出る → Task 3 の MA3。
- **古い設定（`intakeConfig` だけ）で setup を Enter だけでやり直す**: 同じ intake が既定で選ばれ、保存後は `intakeConfigs` だけになる → Task 3 の MA5。

---

### Task 1: slack-issue-intake の `--name`（名前つきのホーム）

**Files:**
- Modify: `apps/slack-issue-intake/lib/paths.ts`、`apps/slack-issue-intake/bin/slack-issue-intake.ts`、`apps/slack-issue-intake/lib/automation.ts`、`apps/slack-issue-intake/lib/defaults.ts`、`apps/slack-issue-intake/Makefile`
- Test: `apps/slack-issue-intake/test/unit/paths.test.ts`（無ければ作る）、`apps/slack-issue-intake/test/unit/automation.test.ts`、`apps/slack-issue-intake/test/setup.test.ts`

**Interfaces:**
- Produces（`lib/defaults.ts`。Task 3 と `check-shared-contracts.mjs` が写しと照合する）:
  - `export const INTAKE_HOME_DIRNAME = '.slack-issue-intake'`（今の `HOME_DIRNAME` と同じ値。`paths.ts` の `HOME_DIRNAME` はこれを使う）
  - `export const INTAKE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/`
  - `export const INTAKE_NAME_RESERVED_SUFFIX = '-slack-app'`
- Produces（`lib/paths.ts`）:
  - `export const intakeNameProblem = (name: string): string | null` — 規則に合わなければ日本語の理由。
  - `export const homeForName = (name: string | null): string` — null なら `join(homedir(), INTAKE_HOME_DIRNAME)`、名前があれば `join(homedir(), `${INTAKE_HOME_DIRNAME}-${name}`)`。
  - `export const nameOfHome = (home: string): string | null` — `basename(home)` が `${INTAKE_HOME_DIRNAME}-<名前>` で名前が規則に合えば名前、それ以外は null。
- Produces（`lib/automation.ts`）: automation の `--name` は `automationNameFor(home)` = 名前があれば `slack-issue-intake-<名前>`、無ければ `AUTOMATION_NAME`。
- `bin/slack-issue-intake.ts`: argv の先頭が `--name` なら次の値を取り出し（`--name=<値>` も可）、`intakeNameProblem` で検査する。不正、値が無い、`SLACK_ISSUE_INTAKE_HOME` が既にある → 理由を stderr に出して exit 2。通れば `process.env.SLACK_ISSUE_INTAKE_HOME = homeForName(name)` を入れてからサブコマンドを読む（子とランチャーへは今の仕組みで伝わる）。サブコマンドより後ろの `--name` は触らない。
- `Makefile`: `NAME ?=` を足し、`setup`・`manifest`・`slack-form` は `NAME` が空でなければ `--name '$(NAME)'` をサブコマンドの前に付ける。`help` に `NAME=<名前>` の説明を 1 行足す。

- [ ] **Step 1: Write the failing tests**

```ts
// test/unit/paths.test.ts
test('MW1 home and automation name follow the workspace name', () => {
  // homeForName(null) === join(homedir(), '.slack-issue-intake')
  // homeForName('ws2') === join(homedir(), '.slack-issue-intake-ws2')
  // nameOfHome(homeForName('ws2')) === 'ws2'; nameOfHome(homeForName(null)) === null; nameOfHome('/tmp/x') === null
  // automationNameFor(homeForName('ws2')) === 'slack-issue-intake-ws2'; automationNameFor('/tmp/x') === 'slack-issue-intake'
})
test('MW2 invalid names are rejected', () => {
  // for '', 'WS', 'a/b', '..', 'a'.repeat(33), '-a', 'foo-slack-app' -> intakeNameProblem !== null
  // for 'ws2', 'a', 'team-1', 'a'.repeat(32) -> null
})
// test/setup.test.ts（bin を spawnSync で起こす既存の組み方で）
test('MW3 --name before the subcommand selects the home; after it is left alone', () => {
  // SLACK_ISSUE_INTAKE_HOME を消し、HOME を一時ディレクトリにして `--name ws2 status` -> 一時 HOME/.slack-issue-intake-ws2 を読む（未設定の表示で exit は今の status と同じ）
  // `--name BAD status` -> exit 2, ホームのディレクトリは作られない
  // SLACK_ISSUE_INTAKE_HOME も --name もある -> exit 2
  // `status --name ws2` -> --name は status の引数として渡る（今の status の扱いのまま）
})
test('MW4 setup under a named home passes the same home to its children', () => {
  // 既存の setup の試験の stub で、--name ws2 setup を走らせ、enable / init の子が書いたファイルが .slack-issue-intake-ws2 の下にある
  // init が作る automation の --name 引数が slack-issue-intake-ws2（orca stub の argv で確かめる）
})
```

- [ ] **Step 2: Run to verify they fail** — `bash test/run-all.sh`（または対象の `node --test`）→ FAIL
- [ ] **Step 3: Implement** as the Interfaces block says.
- [ ] **Step 4: Run to verify they pass** — `bash test/run-all.sh`、tsc、biome → PASS
- [ ] **Step 5: Commit** — `feat(slack-issue-intake): --name でワークスペースごとのホームを選べるようにする`

### Task 2: slack-issue-intake の説明と skill

**Files:**
- Modify: `apps/slack-issue-intake/README.md`、`skills/slack-issue-intake/SKILL.md`、`skills/slack-issue-intake/references/guide-ja.md`、`apps/slack-issue-intake/CLAUDE.md`（Global Constraints の制限のとおり、段落を 1 つ足すだけ）
- Test: `apps/slack-issue-intake/test/unit/docs.test.ts`

決めること:
- README の「セットアップ」に、ワークスペースごとに `make setup NAME=<名前>` を走らせること、名前なしは今のホーム、automation は `slack-issue-intake-<名前>` で親の PC に 1 つずつできることを書く。
- SKILL.md: 対話の手順（status・retry・inspect・set-token・mention など CLI を呼ぶもの全部）の前に、ホームが 2 つ以上あれば（`~/.slack-issue-intake` と `~/.slack-issue-intake-<名前>` のうち `config.json` か `secrets.json` があるもの）どのワークスペースかを聞き、`node "$PLUGIN/bin/slack-issue-intake.ts" --name <名前> <subcommand>` の形で呼ぶ、と書く。1 つだけならそのまま。setup の案内は `make setup NAME=<名前>`。
- CLAUDE.md: 「セットアップのウィザード」の節の末尾に、`--name` と名前の規則、automation の名前、`SLACK_ISSUE_INTAKE_HOME` との排他を 1 段落で足す。

- [ ] **Step 1: Write the failing test** — `docs.test.ts` に `MW5`: SKILL.md に `--name <name>` と `make setup NAME=` が、guide-ja.md に `--name` と `make setup NAME=` が、README に `make setup NAME=` が含まれる。
- [ ] **Step 2: Run to verify it fails** → FAIL
- [ ] **Step 3: Write the docs**
- [ ] **Step 4: Run** — `bash test/run-all.sh`、ルートの `node scripts/check-doc-lang.mjs` → PASS
- [ ] **Step 5: Commit** — `docs(slack-issue-intake): ワークスペースごとの setup と --name を説明する`

### Task 3: `--auto` の複数の intake

**Files:**
- Modify: `apps/orca-team-dispatch-task/lib/auto-config.ts`、`lib/setup-draft.ts`、`lib/auto-setup.ts`（2 段目）、`lib/auto-tick.ts`（読めない intake の出力）、`skills/orca-team-dispatch-task/SKILL.md`・`references/guide-ja.md`（設定の例の `intakeConfig` を `intakeConfigs` に）、`CLAUDE.md`（C3a の節に 1 行）、`test/fixtures/auto-config.json`（`intakeConfigs` の形の例を足すなら別ファイルにし、既存の fixture は変えない）
- Create: `apps/orca-team-dispatch-task/lib/intake-homes.ts`
- Modify: `scripts/check-shared-contracts.mjs`
- Test: `test/unit/auto-config.test.ts`、`test/unit/intake-homes.test.ts`、`test/unit/setup-run.test.ts`、`test/unit/setup-draft.test.ts`

**Interfaces:**
- `AutoConfig` の `intakeConfig: string` を `intakeConfigs: string[]` に置き換える。`parseAutoConfig`: `intakeConfigs` が空でない文字列の配列ならそれ、無ければ `intakeConfig`（文字列）を `[intakeConfig]` に、どちらも無ければ今の既定のパス 1 つ、両方あれば null（不正）。
- `export const readIntakeRepos = (config: AutoConfig): { repos: string[]; unreadable: string[] }`（`lib/auto-config.ts`）— 設定の並び順で各 intake の `repos[].name` を集め、重複は最初の 1 つ。`repos` が配列として読めない intake はそのパスを `unreadable` に入れる。`pickSources(config)` は `readIntakeRepos(config).repos` のうち `config.sources` にあるものを返す（戻り値の型は今のまま）。
- tick: `syncIssues` を呼ぶ所（`lib/auto-tick.ts` の tick 本体）で、`readIntakeRepos(config).unreadable` の各パスについて `intake の設定を読めません: <パス>` を 1 回ずつ出す。
- `lib/intake-homes.ts`:
  - 写しの定数 `INTAKE_HOME_DIRNAME = '.slack-issue-intake'`、`INTAKE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/`、`INTAKE_NAME_RESERVED_SUFFIX = '-slack-app'`（slack-issue-intake の `lib/defaults.ts` と同じ値。`check-shared-contracts.mjs` が照合）。
  - `export const listIntakeConfigs = (home: string): string[]` — `home`（テストでは一時ディレクトリ、本番は `homedir()`）の直下で、`.slack-issue-intake` と `.slack-issue-intake-<名前>`（規則に合う名前）のうち `config.json` があるものの `config.json` の絶対パス。並びは名前なしが先、あとは名前の辞書順。
- 下書き: `values.intakeConfig?: string` を `values.intakeConfigs?: string[]` に置き換える（古い下書きの `intakeConfig` は読むときに配列にする）。`configJsonFromDraft` は `intakeConfigs` を書き、`intakeConfig` のキーを消す。
- setup の 2 段目:
  1. `listIntakeConfigs(homedir())` と、今の設定・下書きの `intakeConfigs` のうち一覧に無いものを合わせて番号で並べる。
  2. `intake の設定ファイルの番号`（複数可）を `choose` で聞く。既定は今の設定・下書きの `intakeConfigs` の番号、無ければ全部。
  3. `ほかの intake の設定ファイル（無ければ -）` を、`-` まで繰り返して絶対パスを足せる。読めないパスは理由を出して聞き直す。
  4. 拾う元の候補は選んだ intake の `repos` の和。あとは今の 2 段目と同じ。
- `check-shared-contracts.mjs`: slack-issue-intake の `INTAKE_HOME_DIRNAME`・`INTAKE_NAME_PATTERN.source`・`INTAKE_NAME_RESERVED_SUFFIX` と、orca-team-dispatch-task の `lib/intake-homes.ts` の同じ名前の値が一致することを足す。

- [ ] **Step 1: Write the failing tests**

```ts
// auto-config.test.ts
test('MA1 intakeConfigs and the legacy intakeConfig', () => {
  // {intakeConfigs:['/a','/b']} -> ['/a','/b']; {intakeConfig:'/a'} -> ['/a']; both -> null; {intakeConfigs:[]} -> null; {intakeConfigs:['']} -> null
})
test('MA2 sources are the union of intake repos in order', () => {
  // /a repos [x, y], /b repos [y, z]; sources x, y, z -> pickSources [x, y, z]; readIntakeRepos.repos [x, y, z]
})
test('MA3 an unreadable intake drops only its repos', () => {
  // /a ok [x], /missing -> readIntakeRepos {repos:[x], unreadable:['/missing']}; pickSources [x]
})
// intake-homes.test.ts
test('MA4 intake homes are listed by the shared naming rule', () => {
  // tmp: .slack-issue-intake/config.json, .slack-issue-intake-ws2/config.json, .slack-issue-intake-b/config.json,
  //      .slack-issue-intake-slack-app/ (no config), .slack-issue-intake-UP/config.json, .slack-issue-intake-c/ (no config)
  // -> [tmp/.slack-issue-intake/config.json, tmp/.slack-issue-intake-b/config.json, tmp/.slack-issue-intake-ws2/config.json]
})
// setup-run.test.ts（既存の prepare に HOME を一時ディレクトリにする差し替えを足すか、listIntakeConfigs の引数を差し替えられるようにする。どちらかは作る人が決める）
test('MA5 legacy config reruns with Enter and saves intakeConfigs', () => {
  // config.json に intakeConfig:'<f.raw.intakeConfig>' -> Enter だけの再実行 -> 保存後 intakeConfigs deepEqual [その path] で intakeConfig のキーは無い
})
test('MA6 two intakes can be picked and their repos offered', () => {
  // 2 つの intake（repos [acme/app] と [acme/api]）を選ぶ -> 拾う元の候補に両方が並び、両方選ぶと sources に 2 件
})
```

- [ ] **Step 2: Run to verify they fail** → FAIL
- [ ] **Step 3: Implement**、既存テストの答えの列を 2 段目の質問の変化に合わせて直す（期待値は変えない。変えたら result.md に理由）。`check-shared-contracts.mjs` も足す。
- [ ] **Step 4: Run** — `bash test/run-all.sh < /dev/null`、tsc、biome、ルートの 2 つの検査 → PASS
- [ ] **Step 5: Commit** — `feat(orca-team-dispatch-task): --auto で複数の intake の設定ファイルを読む`

## 終わりに（worker）

result.md に、タスクごとの commit と検査の結果、計画からずれた点、既存テストを変えた理由、実機で見ないと分からない点を書く。
