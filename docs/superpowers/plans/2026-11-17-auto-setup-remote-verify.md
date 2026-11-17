# --auto の make setup（C3b）遠くのマシンでの確認 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `make setup` の確認の段で、遠くのマシンでも確認コマンドを走らせて確認済みにし、最大メモリとディスクの増え方を測って並列数の推奨に使い、AI（`claude -p`）に確認コマンドの案を出させる。

**Architecture:** 確認は 1 本の node スクリプト（base64 で包んで `node -e`）で行い、このマシンでは `spawnSync`、遠くでは C3a の `probeRemote` と同じく Orca の端末で走らせて目印つきの JSON を読む。測った値はマシンの組に `measure` として持ち、`setup-lanes.ts` の推奨値の計算に渡す。AI の案は `lib/setup-suggest.ts` が `claude -p` を読み取りの道具だけで起こして作る。

**Tech Stack:** TypeScript（node で型を除いて直接実行。Node 22.18 以上、実行時の npm 依存なし）、node:test、bash のテスト（`test/run-all.sh`）、gh-stub / orca-stub。

**Spec:** `docs/superpowers/specs/2026-11-17-auto-setup-remote-verify-design.md`（前提は C3a の `docs/superpowers/specs/2026-11-17-auto-setup-design.md` と、`apps/orca-team-dispatch-task/CLAUDE.md` の「C3a: make setup」）

パスは `apps/orca-team-dispatch-task/` からの相対（`docs/` と `scripts/` はリポジトリのルートから）。

## Global Constraints

- TypeScript で `any` / `unknown` / `class` を使わない。`erasableSyntaxOnly`（enum・namespace・引数プロパティ不可）。型だけの import は `import type`。実行時の npm 依存を足さない。
- tick・判定・振り分け・後片付けの振る舞いを変えない（設計書「やらないこと」）。
- 道具のインストール・sudo・swap を作らない。
- 確認のために checkout を汚さない・ブランチを残さない（一時 worktree を切って消す）。
- `apps/slack-issue-intake` に一切触れない（親の checkout にユーザーの未コミットの変更がある）。版（plugin.json・.codex-plugin・marketplace.json）を上げない。push しない。
- `git add` はファイルを名指しする。タスクごとに commit する。
- 既存テストの期待値・答えの列を書き換えたら、理由を result.md に書く（Task 1 と Task 5 で予告したもの以外も）。
- 検証（`apps/orca-team-dispatch-task` で。pnpm は mise の shim で動かない）: `../../node_modules/.bin/tsc --noEmit -p .`（worktree に node_modules が無ければ C3a と同じく親の道具を絶対パスで、`--typeRoots <親>/apps/orca-team-dispatch-task/node_modules/@types` を付ける）、`../../node_modules/.bin/biome check ./bin ./lib ./skills ./test`、`bash test/run-all.sh < /dev/null`（最後の行が `ALL GREEN`）。ルートで `node scripts/check-doc-lang.mjs` と `node scripts/check-shared-contracts.mjs`。
- Orca・gh・claude の応答は stub で確かめる。本物の端末・automation・Orca の登録を作らない。本物の `~/.claude` に書かない。実機での確かめは親が行う。
- コメント・commit メッセージ・ユーザーへの表示は日本語、識別子は英語。`SKILL.md` と `references/*.md`（`-ja` 以外）は英語のみで、変えたら `guide-ja.md` / `-ja.md` も同じ commit で変える。

## Review Focus

- **確認コマンドに引用符・`$`・日本語が入る**: base64 で包むので、そのまま 1 文字も変わらずに走る → Task 1 の SV3。
- **確認コマンドが標準入力を読む（`cat` など）**: 入力は閉じてあるので待たずに終わる → Task 1 の SV4。
- **出力が多いコマンドのあとで、目印が読み取りの範囲から押し出されない／端末の折り返しで目印の行が割れる**: 目印は最後に出し、割れても読める → Task 1 の SV2、Task 2 の SV6。
- **遠くで時間切れ**: 端末を閉じ、確認済みにせず、残りうる一時ディレクトリの場所を見せる → Task 2 の SV7、Task 5 の SU36。
- **AI の案が空・壊れた JSON・claude が無い**: setup は止まらず、手で入れる流れに戻る → Task 4 の SG2〜SG4、Task 5 の SU35。

---

### Task 1: 確認のスクリプトと、このマシンでの確認

**Files:**
- Create: `lib/setup-verify.ts`
- Modify: `lib/setup-host.ts`（`runVerifyLocal` を削り、`lib/setup-verify.ts` のものに置き換える）、`lib/auto-setup.ts`（import 先と戻り値の使い方だけ）
- Test: `test/unit/setup-verify.test.ts`、`test/unit/setup-host.test.ts`（SU18 の `runVerifyLocal` の比較を `ok` / `failed` の欄だけに直す。SU19e はそのまま新しい関数で通す）

**Interfaces:**
- Produces:
  - `export type VerifyResult = { ok: boolean; failed: string | null; exitCode: number | null; peakMemoryMb: number | null; diskGrowthMb: number | null; missingTools: string[]; platform: string | null; tmpPath: string | null }`
  - `export const VERIFY_BEGIN = '@@orca-auto-verify:begin@@'`、`VERIFY_END = '@@orca-auto-verify:end@@'`、`VERIFY_TMP = '@@orca-auto-verify:tmp@@'`
  - `export const verifyCommand = (commands: string[], tools: string[]): string` — `node -e "eval(Buffer.from('<base64>','base64').toString('utf8'))"` の形（`probeCommand` と同じ包み方）。入力はスクリプトに JSON で埋め込む。
  - `export const parseVerifyOutput = (text: string): VerifyResult | null` — 改行を取り除いてから `VERIFY_BEGIN` と `VERIFY_END` の間を JSON として読む。`tmpPath` は `VERIFY_TMP` の直後から次の `@@` までで、結果の JSON にも入れる（時間切れで END が無いときのため Task 2 は `VERIFY_TMP` だけを別に読む）。
  - `export const runVerifyLocal = (checkout: string, commands: string[], tools: string[]): VerifyResult` — `verifyCommand` を `cwd: checkout` で走らせる。stdout はパイプで受けて `parseVerifyOutput`、stderr は端末へ（`inherit`）。読めなければ `{ ok: false, failed: '確認のスクリプト', ... }`。SIGINT を無視する今の作りは残す。

スクリプトの中身（設計書 1 の順。ここに書いたものが決まり。ほかは作る人が決める）:
1. 最初に `git worktree prune`、一時ディレクトリを `os.tmpdir()` の下に作り、`VERIFY_TMP + path + '@@'` を **stdout** に 1 行出す。`git worktree add --detach <tmp> HEAD`。
2. 確認コマンドを順に走らせる。`/usr/bin/time` があれば `[-l]`（darwin）／`[-v]`（linux）を前に付け、`/bin/sh -c <command>`。`cwd` は一時ディレクトリ、`stdio` は `['ignore', <stderr へ>, 'pipe']`（コマンドの stdout も stderr へ流す。stdout は目印だけにする）、`env` に `GIT_PAGER=cat`・`PAGER=cat`。受けた stderr は端末へそのまま流してから、最大 RSS を読む（darwin: `(\d+)\s+maximum resident set size` はバイト、linux: `Maximum resident set size \(kbytes\):\s*(\d+)`）。全コマンドの最大値を MB（切り上げ）で持つ。読めなければ null。
3. 最初に失敗したコマンドで止め、`failed` と `exitCode` を入れる。
4. 走らせる前と後で一時ディレクトリの `du -sk` を取り、差を MB（切り上げ、0 未満は 0）にする。取れなければ null。
5. `tools` を `command -v` で引き、無いものを `missingTools` に入れる。
6. `finally` で `git worktree remove --force <tmp>`、ディレクトリを消し、`git worktree prune`。
7. 最後に `VERIFY_BEGIN + JSON + VERIFY_END` を stdout に 1 行出す。

- [ ] **Step 1: Write the failing tests** in `test/unit/setup-verify.test.ts`（一時ディレクトリに `git init` と空のコミットを作る。`setup-host.test.ts` の `git` の助けを写してよい）

```ts
test('SV1 runs commands in a throwaway worktree and measures', () => {
  // commands: ['dd if=/dev/zero of=big bs=1048576 count=3 2>/dev/null', 'true']
  // tools: ['sh', 'definitely-not-a-tool-xyz']
  // assert r.ok === true, r.failed === null, r.missingTools deepEqual ['definitely-not-a-tool-xyz']
  // assert r.diskGrowthMb >= 3
  // if existsSync('/usr/bin/time') assert typeof r.peakMemoryMb === 'number' && r.peakMemoryMb > 0
  // assert `git worktree list` has 1 line and `git status --porcelain` is '' afterwards
  // assert r.tmpPath is a string and existsSync(r.tmpPath) === false
})
test('SV2 stops at the first failure and the marker survives wrapping and noise', () => {
  // commands: ['seq 1 5000', 'exit 3', 'touch never'] -> ok false, failed 'exit 3', exitCode 3, 'never' not created
  // parseVerifyOutput(`noise\n${VERIFY_BEGIN}{"ok":tr\nue,"failed":null,...}${VERIFY_END}\n`) -> ok true
  // parseVerifyOutput('no marker') -> null; parseVerifyOutput(`${VERIFY_BEGIN}{bad${VERIFY_END}`) -> null
})
test('SV3 quotes, dollars and Japanese survive the base64 wrapping', () => {
  // command: `test "$(printf '%s' 'a"b$c 日本')" = 'a"b$c 日本'` -> ok true
  // verifyCommand(...) contains no single quote except the two around the base64
})
test('SV4 a command reading stdin finishes at once', () => {
  // command: 'cat' -> ok true (stdin is closed)
})
```

- [ ] **Step 2: Run to verify they fail**
Run: `node --test test/unit/setup-verify.test.ts`
Expected: FAIL（`lib/setup-verify.ts` が無い）

- [ ] **Step 3: Implement `lib/setup-verify.ts`** as the Interfaces block says, and switch `lib/auto-setup.ts` and `test/unit/setup-host.test.ts` (SU18/SU19e) to the new `runVerifyLocal(checkout, commands, [])`. Remove the old one from `lib/setup-host.ts`.

- [ ] **Step 4: Run to verify they pass**
Run: `node --test test/unit/setup-verify.test.ts test/unit/setup-host.test.ts test/unit/setup-run.test.ts`、tsc、biome
Expected: PASS、rc 0

- [ ] **Step 5: 全体の検査のあと commit**
`git commit -m "feat(orca-team-dispatch-task): make setup の確認を一時 worktree のスクリプトにし、最大メモリとディスクの増え方を測る"`

### Task 2: 遠くのマシンでの確認

**Files:**
- Modify: `lib/setup-verify.ts`
- Test: `test/unit/setup-verify.test.ts`

**Interfaces:**
- Consumes: `verifyCommand`、`parseVerifyOutput`、`VERIFY_TMP`（Task 1）。`runOrca` / `receiptOk`（`lib/orca.ts`）、`sleepSeconds` / `envCount`（`lib/sys.ts`）。
- Produces:
  - `export const VERIFY_REMOTE_TIMEOUT_MS = 30 * 60 * 1000`（テストでは `ORCA_AUTO_VERIFY_TIMEOUT_MS` で上書き。`envCount` で読む）
  - `export type RemoteVerify = { result: VerifyResult | null; timedOut: boolean; tmpPath: string | null }`
  - `export const verifyRemote = (id: string, selector: string, commands: string[], tools: string[], onWait: (minutes: number) => void): RemoteVerify`
    - `terminal create --environment <id> --worktree <selector> --title orca-auto-verify --command <verifyCommand> --json`。handle が取れなければ `{ result: null, timedOut: false, tmpPath: null }`（close しない）。
    - `terminal read --environment <id> --terminal <h> --limit 400 --json` を、`ORCA_AUTO_PROBE_INTERVAL_MS`（既定 1000）より長い間隔で繰り返す。間隔は既定 5000 ms（`ORCA_AUTO_VERIFY_INTERVAL_MS` で上書き）。読めた tail を `''` でつないで `parseVerifyOutput`。途中で見えた `VERIFY_TMP` の値を覚えておく。
    - 経過が 1 分増えるたびに `onWait(分)` を 1 回呼ぶ。
    - 上限を超えたら `{ result: null, timedOut: true, tmpPath }`。
    - どの終わり方でも、handle があれば `terminal close --environment <id> --terminal <h> --json` を必ず呼ぶ（`try / finally`）。

- [ ] **Step 1: Write the failing tests**（orca-stub で。`setup-host.test.ts` の SU16b/c の組み方を写す）

```ts
test('SV5 remote verify passes the selector and environment and closes the terminal', () => {
  // respond terminal_create {ok:true,result:{terminal:{handle:'t1'}}}
  // respond terminal_read tail: [`${VERIFY_TMP}/tmp/x@@`, ...2000 noise lines..., marker JSON ok:true peakMemoryMb:512]
  // r = verifyRemote('env-1', 'id:repo-1', ['true'], [], () => {})
  // assert r.result?.ok === true, r.result?.peakMemoryMb === 512, r.timedOut === false
  // argv log: create has --environment env-1 --worktree id:repo-1; close called with --environment env-1 --terminal t1
})
test('SV6 a marker split across tail rows is read', () => {
  // tail rows split VERIFY_BEGIN and the JSON across 3 elements -> result read
})
test('SV7 timeout closes the terminal and reports the temp path', () => {
  // ORCA_AUTO_VERIFY_TIMEOUT_MS=50, ORCA_AUTO_VERIFY_INTERVAL_MS=10, tail only has VERIFY_TMP line
  // -> timedOut true, result null, tmpPath '/tmp/x', close called
})
test('SV8 create failure returns without closing', () => {
  // terminal_create.rc = 1 -> { result: null, timedOut: false, tmpPath: null }, no 'terminal close' in calls
})
```

- [ ] **Step 2: Run to verify they fail** — `node --test test/unit/setup-verify.test.ts` → FAIL（`verifyRemote` が無い）
- [ ] **Step 3: Implement `verifyRemote`** as above.
- [ ] **Step 4: Run to verify they pass** — 同じコマンドと tsc・biome → PASS
- [ ] **Step 5: 全体の検査のあと commit** — `feat(orca-team-dispatch-task): make setup の確認を遠くのマシンの Orca の端末で走らせる`

### Task 3: 測った値の持ち方と、並列数の推奨

**Files:**
- Modify: `lib/auto-hosts.ts`（組の型と `parseHosts` の検査）、`lib/setup-lanes.ts`、`lib/setup-draft.ts`（必要なら `configJsonFromDraft` が `measure` を落とさないことだけ）
- Test: `test/unit/auto-hosts.test.ts`、`test/unit/setup-lanes.test.ts`、`test/unit/setup-draft.test.ts`

**Interfaces:**
- Produces:
  - `export type RepoMeasure = { peakMemoryMb: number; diskGrowthMb: number; measuredAt: string }`（`lib/auto-hosts.ts`）
  - `HostConfig['repos'][r]` を `{ selector: string; verified: boolean; measure: RepoMeasure | null }` にする。`parseHosts`: `measure` が無い・null → null。`peakMemoryMb` は 1 以上の整数、`diskGrowthMb` は 0 以上の整数、`measuredAt` は空でなく `Date.parse` が NaN でない。それ以外の形 → `{ ok: false }`。
  - `export type WorktreeCost = { memoryMb: number; diskMb: number; source: 'measured' | 'default' }`（`lib/setup-lanes.ts`）
  - `export const SETUP_MEASURE_MARGIN = 2`
  - `export const worktreeCost = (measures: Array<RepoMeasure | null>): WorktreeCost` — null を除いた組の最大値に `SETUP_MEASURE_MARGIN` を掛けて切り上げ。メモリは `SETUP_WORKTREE_MEMORY_MB` を、ディスクは 1 を下限にする（測った値が小さすぎて推奨が膨らみすぎないよう、メモリだけ今の定数を下限にする。私の判断）。1 つも無ければ `{ SETUP_WORKTREE_MEMORY_MB, SETUP_WORKTREE_DISK_MB, 'default' }`。
  - `recommendLanes(spec: HostSpec, cost?: WorktreeCost): number` — 引数を足すだけ。無ければ今の定数（既存の呼び出しと SU3/SU4 はそのまま通る）。

- [ ] **Step 1: Write the failing tests**

```ts
// auto-hosts.test.ts
test('SV9 measure parses, defaults to null, and rejects bad shapes', () => {
  // pair without measure -> measure null; with {peakMemoryMb:900,diskGrowthMb:0,measuredAt:'2026-11-17T00:00:00Z'} -> kept
  // peakMemoryMb 0, diskGrowthMb -1, 1.5, measuredAt 'x' -> parseHosts ok false
})
// setup-lanes.test.ts
test('SV10 worktree cost uses the measured maximum with margin and a memory floor', () => {
  // worktreeCost([null]) -> { memoryMb: 4096, diskMb: 5120, source: 'default' }
  // worktreeCost([{peakMemoryMb:3000,diskGrowthMb:700,...}, {peakMemoryMb:1000,diskGrowthMb:900,...}, null])
  //   -> { memoryMb: 6000, diskMb: 1800, source: 'measured' }
  // worktreeCost([{peakMemoryMb:100,diskGrowthMb:0,...}]) -> { memoryMb: 4096, diskMb: 1, source: 'measured' }
  // recommendLanes({cpus:12,memoryTotalMb:32768,diskFreeMb:40518,...}, {memoryMb:6000,diskMb:1800,source:'measured'}) -> 4
})
// setup-draft.test.ts
test('SV11 measure survives draft and config round trips', () => {
  // draftFromConfig -> configJsonFromDraft keeps hosts[].repos[r].measure deepEqual
})
```

- [ ] **Step 2: Run to verify they fail** — `node --test test/unit/auto-hosts.test.ts test/unit/setup-lanes.test.ts test/unit/setup-draft.test.ts` → FAIL
- [ ] **Step 3: Implement** the type, parse, `worktreeCost` and the optional parameter. Add `measure: null` wherever tsc requires it in existing test values (behavior unchanged; record in result.md).
- [ ] **Step 4: Run to verify they pass** — 同じコマンド、tsc、biome → PASS
- [ ] **Step 5: 全体の検査のあと commit** — `feat(orca-team-dispatch-task): マシンの組に測った値を持ち、並列数の推奨に使う`

### Task 4: AI による確認コマンドの案

**Files:**
- Create: `lib/setup-suggest.ts`
- Test: `test/unit/setup-suggest.test.ts`

**Interfaces:**
- Produces:
  - `export type VerifySuggestion = { commands: string[]; tools: string[]; notes: string }`
  - `export const SUGGEST_TIMEOUT_MS = 10 * 60 * 1000`（`ORCA_AUTO_SUGGEST_TIMEOUT_MS` で上書き）
  - `export const SUGGEST_TOOLS = 'Read,Glob,Grep'`
  - `export const suggestVerify = (checkout: string, judge: { model: string; effort: string }): VerifySuggestion | { error: string }`
    - 実行するもの: `process.env.ORCA_AUTO_CLAUDE_BIN || 'claude'`（テスト専用の環境変数。CLAUDE.md の「テスト専用」に足す）。
    - 引数: `['-p', <prompt>, '--output-format', 'json', '--model', judge.model, '--effort', judge.effort, '--allowedTools', SUGGEST_TOOLS, '--permission-mode', 'dontAsk']`。`cwd: checkout`、stdin は `ignore`、`timeout: SUGGEST_TIMEOUT_MS`、`killSignal: 'SIGKILL'`。
    - prompt（英語。文面は作る人が決めてよいが次を必ず含める）: 読むファイルの例（設計書 3 の列）、言語を決め打ちしないこと、ファイルを書き換えないこと、「build・test・lint を副作用なく人の入力なしで走らせるコマンド」、答えは JSON 1 つ `{"commands":[...],"tools":[...],"notes":"..."}` だけ。
    - 読み方: stdout を JSON として読み、`result` の文字列から最初の `{` と最後の `}` の間を JSON として読む。`commands` と `tools` は空でない文字列の配列（空配列は許す）、`notes` は文字列（無ければ `''`）。
    - 失敗の形: 起動できない（ENOENT）、非 0 で終わった、時間切れ、JSON が読めない、形が違う → `{ error: <日本語の短い理由> }`。

- [ ] **Step 1: Write the failing tests**（一時ディレクトリに stub の実行ファイルを書き、`ORCA_AUTO_CLAUDE_BIN` で指す。stub は引数と `pwd` をファイルに書き、決めた stdout を出す）

```ts
test('SG1 suggestion is read from the result text and claude is restricted to read-only tools', () => {
  // stub prints {"type":"result","result":"Here:\n{\"commands\":[\"npm test\"],\"tools\":[\"node\",\"npm\"],\"notes\":\"n\"}"}
  // suggestVerify(checkout, {model:'m1', effort:'high'}) deepEqual {commands:['npm test'],tools:['node','npm'],notes:'n'}
  // logged args contain '-p', '--model','m1', '--effort','high', '--allowedTools','Read,Glob,Grep', '--permission-mode','dontAsk'
  // logged pwd is checkout (realpath)
})
test('SG2 broken or mis-shaped JSON is an error', () => {
  // result 'no json' -> 'error' in r; result '{"commands":"npm test"}' -> 'error' in r
})
test('SG3 non-zero exit and missing binary are errors', () => {
  // stub exits 1 -> error; ORCA_AUTO_CLAUDE_BIN=/nonexistent -> error
})
test('SG4 timeout is an error', () => {
  // ORCA_AUTO_SUGGEST_TIMEOUT_MS=200, stub sleeps 5 -> error, returns in < 3 s
})
```

- [ ] **Step 2: Run to verify they fail** — `node --test test/unit/setup-suggest.test.ts` → FAIL
- [ ] **Step 3: Implement `lib/setup-suggest.ts`**
- [ ] **Step 4: Run to verify they pass** — 同じコマンド、tsc、biome → PASS
- [ ] **Step 5: 全体の検査のあと commit** — `feat(orca-team-dispatch-task): make setup で AI に確認コマンドの案を出させる`

### Task 5: 確認の段に組み込み、説明を直す

**Files:**
- Modify: `lib/auto-setup.ts`（`verify` と `lanes`、組を作る `pickHosts` で `measure` を引き継ぐ所）
- Modify: `skills/orca-team-dispatch-task/SKILL.md`・`references/guide-ja.md`（`make setup` の説明に、遠くの確認と AI の案を 1〜2 行足す）、`CLAUDE.md`（「C3b は未実装」の 2 か所を直し、「C3b: make setup の遠くの確認」の節を足す。テスト専用の環境変数 `ORCA_AUTO_CLAUDE_BIN`・`ORCA_AUTO_VERIFY_TIMEOUT_MS`・`ORCA_AUTO_VERIFY_INTERVAL_MS`・`ORCA_AUTO_SUGGEST_TIMEOUT_MS` を書く）
- Test: `test/unit/setup-run.test.ts`

**Interfaces:**
- Consumes: `runVerifyLocal`・`verifyRemote`・`VerifyResult`（Task 1・2）、`RepoMeasure`・`worktreeCost`・`recommendLanes(spec, cost)`（Task 3）、`suggestVerify`（Task 4）。

段 7 の流れ（リポジトリごと。設計書 4。表示の文言はここに書いたものを使う。数値の書き方は作る人が決める）:
1. `${repo} の確認コマンドを AI に割り出させますか`（既定: そのリポジトリの `verify` が空なら yes）。yes なら `AI に割り出させています…` を出して `suggestVerify(r.checkout, judge)`。`judge` は今の設定の `judge`（無ければ `parseAutoConfig` が補う既定値。`base` が無いときは既定値）。成功なら案の `commands`・`tools`・`notes` を表示、失敗なら `AI の案を作れませんでした: <理由>` を出して続ける。
2. 確認コマンドの質問の既定値は、案の `commands`（あれば）、無ければ今の `r.verify`。案が 3 件で既存が 1 件など長さが違っても、案の列を `i` 番目の既定にし、列の外は `-`。
3. インフラ・CI の質問は C3a のまま。
4. このマシンの確認は C3a のまま（`runVerifyLocal(r.checkout, commands, tools)`、`tools` はこの回の案の `tools`、案が無ければ `[]`）。
5. 遠くの組（`host.id !== LOCAL_HOST` で `host.repos[repo]` があるもの）ごとに `${repo} を ${host.name} で走らせて確かめますか`（既定: C3a の「変わっていない組」なら no、そうでなければ yes。コマンドが空なら聞かない）。yes なら `verifyRemote(host.id, pair.selector, commands, tools, (m) => say(`${host.name} で確認中（${m} 分）`))`。
6. 結果の表示（このマシンと遠くで同じ形）: 通れば `${where}: 通りました（最大メモリ <n|不明> MB、ディスク +<n|不明> MB）`、失敗なら `${where}: ${failed} が失敗しました`、時間切れなら `${where}: 時間内に終わりませんでした`（`tmpPath` があれば `一時ディレクトリが残っていれば消してください: <path>` も）、`missingTools` が空でなければ `${where}: 足りない道具: a, b`。`where` はマシンの名前（hosts の無い形では `このマシン`）。
7. 組の `verified` と `measure`: 走らせた組は結果で決める（`measure` は `peakMemoryMb` が読めたときだけ `{ peakMemoryMb, diskGrowthMb: diskGrowthMb ?? 0, measuredAt: now }`、ほかは null）。走らせなかった組は、C3a の「変わっていない組」なら前の `verified` と `measure` を保ち、変わっていれば `false` と null。全体の `repos[r].verified` は C3a のまま（このマシンの結果だけで決める）。
8. `pickHosts` で組を作り直すとき、`measure` を `verified` と同じ条件で前の値から写す（C3a の SU30d / SU30e の規則に揃える）。

段 8: マシンごとに `const cost = worktreeCost(Object.values(host.repos).map((p) => p.measure))` を求め、推奨値を `recommendLanes(host.spec, cost)` にし、表示に `1 worktree: メモリ ${cost.memoryMb} MB・ディスク ${cost.diskMb} MB（${cost.source === 'measured' ? '測った値' : '既定値'}）` を足す。

既存テストの答えの列: 段 7 に AI の質問が 1 つ増え（確認コマンドが空のリポジトリ）、遠くの組を持つ試験では組ごとの質問が増える。既存の setup-run の試験は、増えた質問に `n`（AI）と既定（遠く）で答えるように列だけ直す。期待値は変えない（変えたら理由を result.md に）。

- [ ] **Step 1: Write the failing tests**（`setup-run.test.ts`。`prepare()` の組み方を使う。遠くのマシンは `host_list` に environment の行を足し、`terminal_create` / `terminal_read` を orca-stub で返す。C3a の SU30h の組み方を写してよい）

```ts
test('SU34 AI suggestion becomes the default commands and is accepted with Enter', () => {
  // ORCA_AUTO_CLAUDE_BIN=stub printing commands ['echo ok'] tools ['sh']
  // answers: ... AI 'y', commands Enter, Enter(-) ...
  // config.repos['acme/app'].verify deepEqual ['echo ok']; stub log has '--allowedTools' 'Read,Glob,Grep'
})
test('SU35 AI failure falls back to manual entry', () => {
  // ORCA_AUTO_CLAUDE_BIN=/nonexistent -> output contains 'AI の案を作れませんでした'; typed command is saved
})
test('SU36 remote pair is verified through the terminal and measured', () => {
  // hosts: local + env-1 (both handle acme/app); terminal_read returns marker ok peakMemoryMb 3000 diskGrowthMb 700
  // after save: env-1 pair verified true, measure {peakMemoryMb:3000,diskGrowthMb:700,measuredAt:<string>}
  // lanes output for env-1 contains '測った値'
  // variant: marker ok:false failed 'npm test' -> pair verified false, measure null, output has 'npm test が失敗しました'
  // variant: ORCA_AUTO_VERIFY_TIMEOUT_MS=50 with no marker -> output has '時間内に終わりませんでした', pair verified false
})
test('SU37 Enter rerun skips the remote check and keeps verified and measure', () => {
  // second run with all-Enter answers: no new 'terminal create' in orca argv log; config deepEqual first run except automation
})
test('SU38 changing the remote selector drops verified and measure until checked again', () => {
  // second run answers a different selector for env-1, answers 'n' to the remote check -> verified false, measure null
})
```

- [ ] **Step 2: Run to verify they fail** — `node --test test/unit/setup-run.test.ts` → FAIL（新しい質問が無い）
- [ ] **Step 3: Implement** the step changes above, then fix the answer lists of existing setup-run tests.
- [ ] **Step 4: Run to verify they pass** — `node --test test/unit/setup-run.test.ts`、`bash test/test-docs.sh`、tsc、biome、ルートの 2 つの検査 → PASS
- [ ] **Step 5: 全体の検査のあと commit** — `feat(orca-team-dispatch-task): make setup の確認の段で遠くのマシンを確かめ、AI の案と測った値を使う`

## 終わりに（worker）

result.md に、タスクごとの commit と検査の結果、計画からずれた点、既存テストの期待値・答えの列を変えた理由、実機で見ないと分からない点（設計書の「未確認」に足すもの）を書く。
