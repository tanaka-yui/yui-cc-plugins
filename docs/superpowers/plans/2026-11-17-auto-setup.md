# --auto の `make setup`（C3a） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `make setup NAME=<名前>` のターミナルの対話で、`--auto` の設定（`auto/<名前>/config.json`）の作成から Orca の automation の登録と有効化までを済ませる。

**Architecture:** 段ごとの処理を小さな lib に分け（下書き、Project、マシン、automation と権限、並列数）、`lib/auto-setup.ts` が段を順に回す。答えは段ごとに `auto/<名前>/setup.json` へ書き、`config.json` は保存の段で一度だけ atomic に書く。automation には安定したパスのランチャーを登録し、実行のたびに今のプラグインを解決する。お手本は slack-issue-intake の `lib/commands/setup.ts`・`lib/prompt.ts`・`lib/automation.ts`・`lib/permissions.ts`・`bin/launch.ts`（共有のパッケージは作らず、写して持つ）。

**Tech Stack:** TypeScript 6（node が型を除いて直接実行。Node 22.18 以上）、`node --test`、gh CLI、Orca CLI、テストは `test/lib/gh-stub.sh` と `test/lib/orca-stub.sh` の差し替え。

**Spec:** `docs/superpowers/specs/2026-11-17-auto-setup-design.md`

## Global Constraints

- TypeScript で `any` / `unknown` / `class` を使わない。実行時の npm 依存を足さない。
- コメント・コミットメッセージ・ユーザーへの表示は日本語、識別子は英語。`SKILL.md` と `references/*.md`（`-ja` 以外）は英語のみで、変えたら対応する `-ja.md` も同じ commit で変える。
- 設定・Project の Status の選択肢・automation を、人の確認なしに消したり上書きしたりしない。
- automation の precheck とプロンプトに版つきのプラグインのパスを書かない。
- 有効化の段で見せた権限と、実際に書く権限は同じ値（同じ関数の戻り値）にする。
- SSH の接続先（`orca host list` の `kind: ssh`）は選択肢に出さない。
- 検証のコマンド（`apps/orca-team-dispatch-task` で）: `../../node_modules/.bin/tsc --noEmit -p .`、`../../node_modules/.bin/biome check ./bin ./lib ./skills ./test`、`bash test/run-all.sh < /dev/null`。ルートで `node scripts/check-doc-lang.mjs` と `node scripts/check-shared-contracts.mjs`。

## Review Focus

- **すでに `config.json` がある状態でのやり直し**: 今の値が各段の既定になり、Enter だけで全段を進めると `config.json` の中身（キーの並び以外）が変わらない → Task 6 の SU30。
- **動いている Issue が使うマシン・リポジトリ・拾う元を外す**: どの Issue が使っているかを見せて保存を断り、`config.json` を変えない → Task 2 の SU9 と Task 6 の SU32。
- **Status の選択肢に `in progress`（小文字）や `Todo` がある Project**: 大文字小文字を区別せずに一致を見て足さず、`Todo` などほかの選択肢は id・色・説明を保ったまま残る → Task 3 の SU13。
- **途中で入力が尽きる（Ctrl-D）・中断する**: 下書きにそこまでの答えが残り、`config.json` と automation は変わらない。次の実行はその段から続く → Task 6 の SU31。
- **ランチャー経由の tick で権限が承認のあとに変わっている**: 1 行書いて 0 以外で終わり、Claude を起動しない。`make auto` の tick（ランチャーを通らない）は確かめない → Task 5 の SU25。

---

## File Structure

| ファイル | 役割 |
|---|---|
| `lib/auto-config.ts`、`lib/auto-hosts.ts`（変更） | `hosts[].spec` と `automation` を読む |
| `lib/setup-lanes.ts`（新規） | 並列数の推奨値（純粋な関数と定数） |
| `lib/setup-draft.ts`（新規） | 下書きの型、読み書き、設定との相互変換、動いている Issue との衝突 |
| `lib/setup-prompt.ts`（新規） | 端末の 1 行ずつの読み取り（slack-issue-intake の `lib/prompt.ts` の写し） |
| `lib/setup-project.ts`（新規） | gh の `project` 権限、Status の選択肢を足す |
| `lib/auto-github.ts`（変更） | `ensureStatusLabels(repo)` |
| `lib/setup-host.ts`（新規） | マシンの一覧、接続、スペック、`orcaBin`、gh の認証、リポジトリの登録 |
| `lib/setup-automation.ts`（新規） | ランチャーの設置、automation の引数、判定の Claude の権限と指紋 |
| `bin/orca-auto-launch.ts`（新規） | 安定したパスに写すランチャーの元 |
| `lib/auto-setup.ts`（新規） | 段を順に回す |
| `bin/orca-auto.ts`（変更） | `setup`・`judge-doc` のコマンド、ランチャー経由の tick の権限の確かめ |
| `Makefile`、`skills/.../references/auto-judge.md`・`-ja.md`、`SKILL.md`、`guide-ja.md`、`test/test-docs.sh`、`CLAUDE.md` | 入口と説明 |
| `test/unit/setup-*.test.ts`（新規） | テスト（ID は `SU<n>`） |

---

### Task 1: 設定の新しい欄と並列数の推奨値

**Files:**
- Modify: `lib/auto-config.ts`、`lib/auto-hosts.ts`
- Create: `lib/setup-lanes.ts`
- Test: `test/unit/auto-config.test.ts`、`test/unit/auto-hosts.test.ts`、`test/unit/setup-lanes.test.ts`

**Interfaces:**
- Produces:
  - `export type HostSpec = { cpus: number; memoryTotalMb: number; memoryFreeMb: number; swapTotalMb: number; diskFreeMb: number; measuredAt: string }`（`lib/auto-hosts.ts`）
  - `HostConfig` に `spec: HostSpec | null` を足す（無ければ `null`）
  - `AutoConfig` に `automation: { id: string; acceptedFingerprint: string | null } | null` を足す（無ければ `null`）
  - `export const SETUP_RESERVE_MEMORY_MB`、`SETUP_WORKTREE_MEMORY_MB`、`SETUP_WORKTREE_DISK_MB`（値は作る人が決める）
  - `export const recommendLanes = (spec: HostSpec): number`
  - `export const worktreesPerIssue = (roles: AutoConfig['roles'], targets: 1 | 2): number`（off/off 1、on/off と off/on 2、on/on 4、targets 2 なら倍）

- [ ] **Step 1: 失敗するテストを書く**
  - `SU1 hosts spec is optional and validated`: `spec` の無いマシン → `spec: null`。正しい `spec` → そのまま。`cpus: 0`、`memoryTotalMb: '1'`、`measuredAt` が無い → `readAutoConfig` が `null`。
  - `SU2 automation is optional and validated`: 無い → `null`。`{ id: 'a1', acceptedFingerprint: null }` と文字列の指紋 → 読める。`id: ''` → `null`。
  - `SU3 recommendLanes`: メモリ・ディスク・CPU のそれぞれが一番小さい制約になる 3 例で、式（`max(1, min(floor((総量 − 予備) ÷ 1 worktree 分), floor(ディスクの空き ÷ 1 worktree 分), CPU 数))`）どおりの値。メモリが予備より少ない → 1。
  - `SU4 worktreesPerIssue`: 4 つの組み合わせ × targets 1/2 の 8 例。
- [ ] **Step 2: 落ちることを確かめる** — Run: `node --test test/unit/auto-config.test.ts test/unit/auto-hosts.test.ts test/unit/setup-lanes.test.ts` / Expected: SU1〜SU4 が FAIL
- [ ] **Step 3: 実装する。** `parseHosts` と `readAutoConfig` に欄を足す。`AutoConfig`・`HostConfig` を作っているほかの箇所（`hostsOf` の既定値、テストの fixture）も型が通るように直す。
- [ ] **Step 4: 通ることを確かめる** — Run: 同上 ＋ `../../node_modules/.bin/tsc --noEmit -p .` / Expected: PASS、型エラーなし
- [ ] **Step 5: Commit** — `feat(orca-team-dispatch-task): --auto の設定にマシンのスペックと automation を持てるようにし、並列数の推奨値を出す`

---

### Task 2: 下書き

**Files:**
- Create: `lib/setup-draft.ts`
- Test: `test/unit/setup-draft.test.ts`

**Interfaces:**
- Consumes: Task 1 の `HostSpec`、`AutoConfig`
- Produces:
  - `export type SetupDraft = { version: 1; name: string; done: string[]; values: { intakeConfig?: string; sources?: Array<{ repo: string; related: string[]; pick: string; project: ProjectRef | null }>; repos?: AutoConfig['repos']; hosts?: Array<{ id: string; name: string; lanes: number; orcaBin: string; repos: Record<string, { selector: string; verified: boolean }>; spec: HostSpec | null }>; roles?: AutoConfig['roles']; everyMinutes?: number; automation?: { id: string; acceptedFingerprint: string | null } } }`（`done` は済んだ段の id。段の id は Task 6 が決める）
  - `export const readDraft = (name: string): SetupDraft | null`（無い・壊れている → `null`）、`export const writeDraft = (draft: SetupDraft): void`（`auto/<名前>/setup.json` に atomic に書く）
  - `export const draftFromConfig = (config: AutoConfig): SetupDraft`（全段を済みにはしない。値だけ埋める）
  - `export const configJsonFromDraft = (draft: SetupDraft, base: JsonObject | null): JsonObject | null`（`base` は今の `config.json` の生の中身。下書きに無いキー（`limits`、`judge`、`minFreeMemoryMb` など）は `base` の値を残す。結果が `readAutoConfig` の検査を通らない形なら `null`）
  - `export const inUseConflicts = (state: AutoState, next: JsonObject): string[]`（終わっていない Issue（phase が `done` / `failed` / `stopped` / `eng` 以外）が使っているマシン（`issue.host`）・リポジトリ（`issue.targets`）・拾う元（`issue.repo`）が `next` から消えるなら、`<key> が <マシン|リポジトリ|拾う元> <名前> を使っています` の行を返す）

- [ ] **Step 1: 失敗するテストを書く**
  - `SU5 draft round trip`: `writeDraft` → `readDraft` で同じ値。壊れた JSON → `null`。
  - `SU6 draftFromConfig then configJsonFromDraft keeps the config`: 今の fixture の設定（`hosts` あり・なしの 2 つ）から作って戻すと、`readAutoConfig` で読んだ値が元と同じ。
  - `SU7 base keys survive`: `base` に `limits: { defaultMinutes: 20, maxMinutes: 40, stallMinutes: 10 }` と `judge` があれば残る。
  - `SU8 invalid draft gives null`: 関連リポジトリに `repos` に無いものがある → `null`。
  - `SU9 inUseConflicts`: `running` の `acme/app#1`（host `env-1`、targets `['acme/app']`）がある状態で、`env-1` を外す・`acme/app` を `repos` から外す・拾う元 `acme/app` を外す → それぞれ 1 行。同じ Issue が `done` なら行なし。
- [ ] **Step 2: 落ちることを確かめる** — Run: `node --test test/unit/setup-draft.test.ts` / Expected: FAIL（モジュールが無い）
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確かめる** — Run: 同上 / Expected: PASS
- [ ] **Step 5: Commit** — `feat(orca-team-dispatch-task): make setup の下書きと、設定との相互変換を足す`

---

### Task 3: Project とステータスラベル

**Files:**
- Create: `lib/setup-project.ts`
- Modify: `lib/auto-github.ts`
- Test: `test/unit/setup-project.test.ts`

**Interfaces:**
- Consumes: `lib/status.ts` の `STATUS_LABELS`、C2c の `lib/auto-project.ts` の問い合わせの形
- Produces:
  - `export const ghHasProjectScope = (): boolean | null`（`gh auth status` の出力のスコープに `project` があるか。読めなければ `null`）
  - `export type StatusOptions = { fieldId: string; options: Array<{ id: string; name: string; color: string; description: string }> }`
  - `export const readStatusOptions = (ref: ProjectRef): StatusOptions | { error: string }`
  - `export const missingStatusOptions = (current: StatusOptions): string[]`（8 つのうち、大文字小文字を区別せずに一致する選択肢が無いものの名前。`STATUS_LABELS` の並び）
  - `export const addStatusOptions = (current: StatusOptions, missing: string[]): boolean`（`updateProjectV2Field` の `singleSelectOptions` に、今ある選択肢を id・名前・色・説明そのままで先に並べ、足すものを後ろに並べる。足すものの色は `STATUS_LABELS` の色に近い Project の色名、説明は `STATUS_LABELS` の説明）
  - `export const ensureStatusLabels = (repo: string): boolean`（`lib/auto-github.ts`。`gh label list --repo` で大文字小文字を区別せずに見て、無いものだけ `gh label create --repo` する。`issue-fetch.ts` の `ensure-labels` と同じ判定）

- [ ] **Step 1: 失敗するテストを書く**（gh は `f.respond` / `f.hook` で差し替える。GraphQL は C2c と同じく `--raw-field` / `--field` で呼ぶので鍵は `api_graphql`）
  - `SU10 ghHasProjectScope`: スコープ行に `'project'` がある → `true`、無い → `false`、rc 1 → `null`。
  - `SU11 readStatusOptions`: 選択肢を読む。`projectV2: null` → `{ error }`。
  - `SU12 missingStatusOptions`: 既定の `Todo`・`In Progress`・`Done` → `Done` と `In progress` は足さず、残り 6 つを `STATUS_LABELS` の並びで返す。
  - `SU13 addStatusOptions keeps existing options`: mutation の引数に、今ある `Todo`（id・色・説明）がそのまま先頭にあり、足すものが後ろにある。rc 1 → `false`。
  - `SU14 ensureStatusLabels`: `ready` と `done` がある → 残り 6 つだけ `label create --repo acme/app` が呼ばれる。
- [ ] **Step 2: 落ちることを確かめる** — Run: `node --test test/unit/setup-project.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確かめる** — Run: 同上 / Expected: PASS
- [ ] **Step 5: Commit** — `feat(orca-team-dispatch-task): make setup の Project の Status の選択肢とステータスラベルを揃える処理を足す`

---

### Task 4: マシン

**Files:**
- Create: `lib/setup-host.ts`
- Test: `test/unit/setup-host.test.ts`

**Interfaces:**
- Consumes: Task 1 の `HostSpec`、`lib/orca.ts` の `runOrca` / `orcaBin`、`lib/auto-hosts.ts` の `LOCAL_HOST` / `envArgs`
- Produces:
  - `export type HostChoice = { id: string; name: string; kind: 'local' | 'environment' }`
  - `export const listHostChoices = (): HostChoice[] | null`（`orca host list --json` の `kind: local` と `kind: environment` だけ）
  - `export const hostReachable = (id: string): boolean`（`orca status` に `envArgs(id)` を付けて通るか）
  - `export const measureLocal = (now: string): HostSpec`（node の `os` と `statfs`）
  - `export type RemoteProbe = { spec: HostSpec | null; orcaBin: string | null; ghAuthOk: boolean | null }`
  - `export const probeRemote = (id: string, worktreeSelector: string, now: string): RemoteProbe`（そのマシンに Orca の端末を作り、node の 1 行で `HostSpec` の値・`$ORCA_CLI_COMMAND` / `command -v orca` / macOS の app の中の CLI の順に見つけた orca・`gh auth status` の成否を JSON 1 行で出させ、端末を読んでから閉じる。読めなければ各値が `null`。端末を作る worktree は、そのマシンに登録されたリポジトリのセレクタ）
  - `export const listRemoteRepos = (id: string): Array<{ id: string; path: string }> | null`（`orca repo list --environment`）
  - `export const addRepo = (id: string, path: string): string | null`（`orca repo add`。遠くは `--environment`。成功ならセレクタ（このマシンは `path:<path>`、遠くは `id:<repo id>`））
  - `export const checkoutProblem = (repo: string, path: string): string | null`（絶対パスか、git の checkout か、`origin` が `owner/name` を指すか、未コミットの変更が無いか。問題なしなら `null`）
  - `export const repoDefaults = (checkout: string): { infra: boolean; ci: boolean }`（`*.tf` があれば infra、`.github/workflows/` があれば ci）
  - `export const runVerifyLocal = (checkout: string, commands: string[]): { ok: boolean; failed: string | null }`（checkout の HEAD から一時的な git worktree を切り、そこで順に走らせ、最初に落ちたコマンドを返す。成否にかかわらず worktree を消し、checkout に変更を残さない）

- [ ] **Step 1: 失敗するテストを書く**（Orca は `orca-stub.sh` の応答と hook で差し替える）
  - `SU15 listHostChoices drops ssh`: local・ssh・environment の 3 行 → local と environment の 2 つ。
  - `SU16 measureLocal`: 値がすべて正の整数（`swapTotalMb` は 0 以上）で、`measuredAt` が渡した時刻。
  - `SU17 probeRemote reads one JSON line and closes the terminal`: `terminal create --environment env-1` → `terminal read` が JSON 1 行を含む出力 → 値が入り、`terminal close` が呼ばれる。出力に JSON が無い → 値は `null` で、`terminal close` は呼ばれる。
  - `SU18 checkoutProblem`: 相対パス、git でない、`origin` が違う、未コミットの変更あり → それぞれ文言あり。正しい checkout → `null`。
  - `SU19 addRepo selector`: このマシン → `path:<path>`、遠く → 受理の repo id から `id:<id>`。
  - `SU19b repoDefaults and runVerifyLocal`: `main.tf` と `.github/workflows/ci.yml` がある checkout → `{ infra: true, ci: true }`、無い → 両方 `false`。`['true', 'false']` → `{ ok: false, failed: 'false' }`、`['true']` → `{ ok: true, failed: null }`。どちらのあとも `git -C <checkout> worktree list` が 1 行だけで、`git status --porcelain` が空。
- [ ] **Step 2: 落ちることを確かめる** — Run: `node --test test/unit/setup-host.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装する。** `terminal read` の出力は端末の表示なので、JSON の行は印（例: 行頭の固定の接頭辞）を付けて探す。端末の出力を待つ回数と間隔は定数に置く。
- [ ] **Step 4: 通ることを確かめる** — Run: 同上 / Expected: PASS
- [ ] **Step 5: Commit** — `feat(orca-team-dispatch-task): make setup のマシンの確認とスペックの測定を足す`

---

### Task 5: automation、ランチャー、判定の権限

**Files:**
- Create: `lib/setup-automation.ts`、`bin/orca-auto-launch.ts`
- Modify: `bin/orca-auto.ts`（`judge-doc` のコマンド、ランチャー経由の tick の権限の確かめ）、`Makefile`（`auto` のプロンプト）、`skills/orca-team-dispatch-task/references/auto-judge.md`・`auto-judge-ja.md`、`test/test-docs.sh`
- Test: `test/unit/setup-automation.test.ts`

**Interfaces:**
- Consumes: Task 1 の `AutoConfig['automation']`
- Produces:
  - `export const LAUNCHER_ENV = 'ORCA_AUTO_LAUNCHER_VERSION'`、`export const LAUNCHER_VERSION = 1`（`bin/orca-auto-launch.ts` は lib を import せず写しを持つ。一致はテストで確かめる。slack-issue-intake の LA2 と同じ）
  - `export const launcherPaths = (): { dir: string; launcher: string; script: string }`（`<configHome()>/bin/orca-auto` と `<configHome()>/bin/launch.mts`）
  - `export const installLauncher = (): boolean`（`bin/orca-auto-launch.ts` を `script` に写し、`launcher` に `exec node <script> "$@"` のシェルを書いて実行可能にする）
  - `export const automationName = (name: string): string`（`orca-auto-<名前>`）
  - `export const registerWorkspace = (name: string): boolean`（`auto/<名前>/` を `orca repo add --path <dir> --kind folder` で登録する。登録済みなら何もしない。slack-issue-intake の `repoAddArgs` と同じ）
  - `export const automationPrompt = (launcher: string, name: string): string`（`Run \`<launcher> judge-doc --name <名前>\` and follow the printed instructions exactly. If it reports nothing to judge, stop.`）
  - `export const AUTO_PRECHECK_TIMEOUT_SECONDS`（`AUTO_TICK_BUDGET_MS` の 100 秒より長い値。作る人が決める）
  - `export const createAutomationArgs = (config: AutoConfig, launcher: string, workspace: string): string[]`（`automations create --name … --trigger <cron> --provider claude --workspace path:<auto/<名前>> --fresh-session --disabled --precheck '<launcher> tick --name <名前>' --precheck-timeout … --extra-agent-args=--model <judge.model> --effort <judge.effort> --prompt …`。cron は slack-issue-intake の `cronFor` と同じ）
  - `export const editAutomationArgs = (id: string, config: AutoConfig, launcher: string, workspace: string): string[]`、`export const enableAutomationArgs = (id: string): string[]`
  - `export type JudgeRules = { file: string; allow: string[]; deny: string[]; defaultMode: 'dontAsk'; disableBypassPermissionsMode: 'disable' }`
  - `export const judgeRules = (config: AutoConfig, launcher: string): JudgeRules`（`file` は `auto/<名前>/.claude/settings.json`。allow は `Bash(<launcher> judge-doc --name <名前>)`、`Bash(<launcher> judge-list --name <名前>)`、`Bash(<launcher> judge-apply --name <名前> --file <decisionsFile>)`、`Read(/<auto/<名前>>/**)`、各 `repos[r].checkout` の `Read(/<checkout>/**)`、`Write` と `Edit` の `/<decisionsFile>`。deny は slack-issue-intake の `RUN_DENY_RULES` の写し）
  - `export const applyJudgeRules = (rules: JudgeRules): boolean`、`export const judgeRulesProblems = (config: AutoConfig, launcher: string): string[]`（書いた内容が `judgeRules` と違う、`settings.local.json` がある、managed の defaultMode が `dontAsk` 以外）、`export const judgeFingerprint = (config: AutoConfig): string | null`（slack-issue-intake の `permissionFingerprint` と同じく、project と user と managed の権限の正規形の sha256）
  - `orca-auto.ts judge-doc --name <名前>`: `auto-judge.md` の本文と、その後ろに `## Commands` として、その呼び方での `judge-list` と `judge-apply` の正確なコマンドを出す（`LAUNCHER_ENV` があればランチャーの形、無ければ `node <plugin>/bin/orca-auto.ts` の形）
  - `orca-auto.ts tick`: `LAUNCHER_ENV` があり、設定の `automation.acceptedFingerprint` があるときだけ、`judgeRulesProblems` が空で `judgeFingerprint` が一致するかを確かめる。違えば `判定の権限が承認したときと違います。make setup をやり直してください` の 1 行を出して 1 で終わる（tick の本体を走らせない）

- [ ] **Step 1: 失敗するテストを書く**
  - `SU20 launcher constants match`: `bin/orca-auto-launch.ts` の `LAUNCHER_VERSION`・プラグイン id（`orca-team-dispatch-task@yui-cc-plugins`）・環境変数の名前が lib の値と一致する。
  - `SU21 launcher resolves the installed plugin`: 偽の `installed_plugins.json`（`ORCA_DISPATCH_CONFIG_HOME` と Claude の home を一時ディレクトリに向ける）で `installLauncher` → `launcher status --name main` が今の checkout の `bin/orca-auto.ts` を `LAUNCHER_ENV` 付きで起動する。プラグインが見つからない → 0 以外。
  - `SU22 automation args have no versioned path`: `createAutomationArgs` の全要素に、プラグインの checkout のパスが含まれない。`--disabled`、`--precheck-timeout` が 100 より大きい、`--extra-agent-args=--model <model> --effort <effort>` がある。
  - `SU23 judgeRules`: allow に 3 つのコマンド、`decisionsFile` の Write/Edit、各 checkout の Read がある。`applyJudgeRules` のあと `judgeRulesProblems` が空。allow を 1 つ足して書き換える → 問題の行が出る。
  - `SU24 judge-doc prints commands for the caller`: `LAUNCHER_ENV` あり → `## Commands` にランチャーの `judge-list --name main` と `judge-apply --name main --file <decisionsFile>`。無し → `node …/bin/orca-auto.ts judge-list --name main`。
  - `SU25 tick refuses changed permissions only via the launcher`: `acceptedFingerprint` を設定し、`LAUNCHER_ENV` 付きで settings を書き換えてから tick → 1 で終わり、gh の `issue list` が呼ばれない。`LAUNCHER_ENV` 無し（`make auto` の形）→ 今までどおり走る。指紋が一致 → 走る。
- [ ] **Step 2: 落ちることを確かめる** — Run: `node --test test/unit/setup-automation.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装する。** `auto-judge.md` の `node <plugin>/bin/orca-auto.ts judge-list …` と `judge-apply …` を「`## Commands` に出る `judge-list` / `judge-apply` を使う」に書き換え、`auto-judge-ja.md` も揃える。`Makefile` の `auto` のプロンプトを `Run \`node $(CURDIR)/bin/orca-auto.ts judge-doc --name $(NAME)\` and follow the printed instructions exactly.` にする。`test/test-docs.sh` の `auto-judge` の固定（581 行目付近と 670 行目付近）を新しい文言に合わせる。
- [ ] **Step 4: 通ることを確かめる** — Run: `node --test test/unit/setup-automation.test.ts && bash test/test-docs.sh < /dev/null` / Expected: PASS、`failures: 0`
- [ ] **Step 5: Commit** — `feat(orca-team-dispatch-task): --auto の automation のランチャーと、判定の Claude の権限を足す`

---

### Task 6: 段を回す `make setup` と説明

**Files:**
- Create: `lib/auto-setup.ts`、`lib/setup-prompt.ts`
- Modify: `bin/orca-auto.ts`（`setup` のコマンド）、`Makefile`（`setup` の target）、`skills/orca-team-dispatch-task/SKILL.md`、`references/guide-ja.md`、`CLAUDE.md`
- Test: `test/unit/setup-run.test.ts`

**Interfaces:**
- Consumes: Task 1〜5 のすべて
- Produces:
  - `export type Prompter = { ask: (question: string, fallback?: string) => string | null; confirm: (question: string) => boolean | null }`、`export const createPrompter = (fd: number, out: (text: string) => void): Prompter`（`lib/setup-prompt.ts`。slack-issue-intake の写し）
  - `export const SETUP_STEPS: ReadonlyArray<{ id: string; title: string }>`（段の id と見出し。設計書の段 1〜12 を、作る人が決めた分け方で並べる）
  - `export const runSetup = (name: string, prompter: Prompter, out: (text: string) => void): number`（0: 最後まで済んだ、1: 失敗、2: 入力が尽きた）
  - `orca-auto.ts setup --name <名前>`: 標準入力が端末でなければ、テスト専用の `ORCA_AUTO_TEST_STDIN=1` が無いかぎり 2 で終える（何も書かない）
  - `make setup`: `node bin/orca-auto.ts setup --name $(NAME)`

段を回す規則:
- 段の見出しは `[n/N] <見出し>`。済んだ段は `… 済み` と出して飛ばすが、`config.json` がすでにあり、かつ下書きが無いときは、全段を既定値つきで聞き直す（やり直し）。
- 答えはその段の終わりに `writeDraft` する。`config.json` は保存の段だけが書く。書く前に `configJsonFromDraft` の結果と今の `config.json` の差を見せて確認し、`takeLockWait` で tick のロックを取り、`inUseConflicts` が空でなければ行を見せて書かずに 1 で終える。
- 前提の確認の段は node（22.18 以上）・git・gh（`gh auth status` が通る）・orca（`orcaBin()`）を見て、足りなければ何が足りないかを出して 1 で終える。
- 拾う元の段は `intakeConfig`（既定 `~/.slack-issue-intake/config.json`）のリポジトリ一覧から選ばせる。レビューモードの段の既定は、今の `--auto` の設定、無ければ `config-resolve.ts` が返す `review_mode` / `phase_b`。
- マシンの段は swap が 0 なら注意を出す。並列数の段は `recommendLanes` の値と `worktreesPerIssue` の表を見せて確定させる。
- Project を登録した拾う元があれば、組み込みの workflow を止める案内を出す（setup は workflow を変えない）。
- Project の段で gh に `project` 権限が無い、または選択肢を足すのを断ったら、その拾う元を `project: null` で下書きに残して進み、最後のまとめに出す。
- automation は、下書きか設定に `automation.id` があれば `editAutomationArgs`、無ければ `createAutomationArgs` で無効のまま作り、id を下書きと設定に書く。有効化の段で `judgeRules` をそのまま見せ、承認されたら `applyJudgeRules` → `judgeFingerprint` を `acceptedFingerprint` として設定に書く → `enableAutomationArgs`。承認されなければ無効のまま 0 で終える（まとめに出す）。

- [ ] **Step 1: 失敗するテストを書く**（`ORCA_AUTO_TEST_STDIN=1` で答えを流し込み、gh と Orca は stub。fixture の intake 設定に `acme/app`）
  - `SU26 non-tty refuses`: 端末でない標準入力・`ORCA_AUTO_TEST_STDIN` 無し → 2、`setup.json` も `config.json` もできない。
  - `SU27 fresh setup writes config and a disabled automation`: 最初から最後まで答える → `config.json` を `readAutoConfig` が読め、`automations create` に `--disabled` があり、設定に `automation.id`。有効化を承認 → `.claude/settings.json` ができ、`acceptedFingerprint` が入り、`automations edit <id> --enabled` が呼ばれる。
  - `SU28 decline enable keeps it disabled`: 有効化で「いいえ」→ `--enabled` が呼ばれず、`acceptedFingerprint` は `null`。
  - `SU29 project scope missing keeps going`: `gh auth status` に `project` が無い → その拾う元は `project: null` で保存され、まとめに `gh auth refresh -h github.com -s project` を含む行。
  - `SU30 rerun with Enter keeps the config`: `config.json` がある状態で、すべて Enter → `readAutoConfig` の値が変わらず、`automations create` は呼ばれず `automations edit <id>` が呼ばれる。
  - `SU31 input ends midway`: 段 3 の途中で入力が尽きる → 2、`setup.json` の `done` に段 1・2 があり、`config.json` はできない。もう一度流し込むと段 3 から始まる（段 1・2 は `… 済み`）。
  - `SU32 in-use host blocks save`: `state.json` に `running` の Issue（host `env-1`）がある状態で `env-1` を外す → 1、`config.json` は変わらない、出力にその Issue の key。
- [ ] **Step 2: 落ちることを確かめる** — Run: `node --test test/unit/setup-run.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確かめる** — Run: 同上 / Expected: PASS
- [ ] **Step 5: 説明を書く**
  - `SKILL.md` の `### Configuration and prerequisites`: 「`make setup` はまだ無い」の文を、`make setup NAME=<name>` の説明に置き換える（段の一覧、途中から再開できること、確認コマンドは人が入力し、このマシンだけ走らせて確認済みにすること、automation は無効で登録してから権限を承認して有効にすること、ランチャーの場所、ランチャー経由の tick は権限が変わると止まること）。手で書く設定の例は残す。
  - `references/guide-ja.md`: 同じ内容の日本語。
  - `CLAUDE.md`: `--auto` の節に、C3a の要点（段の lib の分け方、下書きと `config.json` の書き分け、ランチャーの写しと一致の確かめ、判定の権限の指紋はランチャー経由の tick だけが確かめる理由、`ORCA_AUTO_TEST_STDIN` はテスト専用）。
- [ ] **Step 6: 全体を確かめる** — Run: `../../node_modules/.bin/tsc --noEmit -p . && ../../node_modules/.bin/biome check ./bin ./lib ./skills ./test && bash test/run-all.sh < /dev/null && (cd ../.. && node scripts/check-doc-lang.mjs && node scripts/check-shared-contracts.mjs)` / Expected: すべて成功、`ALL GREEN`
- [ ] **Step 7: Commit** — `feat(orca-team-dispatch-task): --auto の make setup を足す`
