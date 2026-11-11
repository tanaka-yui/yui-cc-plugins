# account-failover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude / Codex のセッションが利用上限で止まったら、Orca の別アカウントへ切り替え、同じペインで同じ会話を resume して作業を続けさせる Orca プラグイン `apps/account-failover` を作る。

**Architecture:** Orca プラグイン（`trusted-worker`）の worker が `agent.status.changed` を購読する。working 以外になったペインの画面を `terminal.read` で読み、limit の文言で判定する。判定したら、環境変数 `ORCA_TERMINAL_HANDLE` を手がかりにエージェントのプロセスを `ps` で特定し、session ID を解決する。プロセスだけを終わらせ、`orca account select` で次のアカウントへ切り替える。最後に、残ったシェルへ `terminal.sendText` で resume コマンドを打ち込む。判定・アカウント選択・コマンド組み立ては純粋関数にし、OS / Orca への副作用は `Deps` 経由で注入してテストする。

**Tech Stack:** TypeScript（Orca が読み込み時に変換。ビルド不要）、Orca plugin API（`orca/worker`、`orca/testing`）、`node:child_process` / `node:fs`、biome 2.4.9、GNU Make。

**Spec:** `docs/superpowers/specs/2026-11-11-account-failover-design.md`

## Global Constraints

- 置き場所は `apps/account-failover`。プラグイン id は `account-failover`（`orca-` 始まりは不可）。初版のバージョンは `0.1.0`。
- マニフェストは `orca-plugin.json`: `manifestVersion: 2`、`execution: "trusted-worker"`、`pluginApi: 1`、`main: "src/worker.ts"`、`engines.orca: ">=1.4.248"`、`publisher` は書かない。
- TypeScript で `any` / `unknown` を使わない（外部 JSON は型ガード関数で絞る）。`class` を使わない。
- biome（lineWidth 120、single quote、semicolons asNeeded）。`pnpm --filter @tanaka-yui/account-failover check` が通ること。
- テストは `orca plugin test .`（`*.test.ts` を `node:test` で実行）。
- ドキュメント・コメント・コミットメッセージは日本語。コード識別子は英語。
- Claude Code プラグインではないので、`.claude-plugin/marketplace.json` には載せない。
- 同じセッションを 2 プロセスで resume しない。古いプロセスが消えたことを確認してから resume コマンドを送る。
- ペインは閉じない（ターミナルハンドルを保つ）。orca-team-dispatch-task は変更しない。
- 乗り換え先には `system` も含める。並びは `orca account list --json` の順で、各種類とも managed の accounts を先に、`system` を最後にする。
- 引き継ぎに失敗したら、新しい空のセッションを作らずに、通知して止める。

## Review Focus

1. **85% 警告の誤検知:** `You've used 85% of your session limit · resets 3:45pm` は limit ではない。乗り換えてはならない（Task 2 のテスト）。
2. **スクロールバックに残った古い limit 表示:** 解除後に再開し、working → done を繰り返したペインで、昔の limit 行が画面の上に残っていても乗り換えてはならない。判定は末尾の数行だけで行う（Task 2 のテスト）。
3. **同じペインの状態変化イベントが連続して届く:** 乗り換えは 1 回だけ実行する（Task 6 のテスト）。
4. **乗り換え直後に新しいアカウントでもすぐ limit になる:** 同じペインで 1 時間に 3 回を超えて乗り換えない。超えたら通知して止める（Task 6 のテスト）。
5. **全アカウントが上限で、解除時刻が読めない:** 無限ループせず、既定の待ち時間のあとに再判定する（Task 3 と Task 6 のテスト）。

---

## ファイル構成

```
apps/account-failover/
  orca-plugin.json        マニフェスト（Task 1）
  package.json            @tanaka-yui/account-failover（Task 1）
  tsconfig.json           .orca/types/tsconfig.json を extends（Task 1）
  .gitignore              node_modules/ と .orca/（Task 1）
  Makefile                help / types / check / test / validate / dev / install（Task 1）
  bin/install.sh          approval_required を扱うインストール（Task 1）
  CLAUDE.md               プラグイン固有の開発ガイド（Task 7）
  docs/spike-findings.md  Task 0 の検証結果（Task 0）
  src/
    types.ts              共有型（Task 1）
    config.ts             定数（Task 1。以降のタスクで追記）
    limit-detect.ts       画面からの limit 判定と解除時刻（Task 2）
    accounts.ts           account list の解釈と次アカウントの選択（Task 3）
    agent-process.ts      ps / sessions ファイル / lsof の解析（Task 4）
    resume-command.ts     resume コマンドの組み立てと Codex の記録の引き継ぎ（Task 5）
    failover.ts           乗り換えの手順・直列化・ループ防止・待機（Task 6）
    system-deps.ts        Deps の実装（child_process / fs / Orca host）（Task 7）
    worker.ts             activate: イベント購読と配線（Task 7）
    *.test.ts             各モジュールのテスト
```

変更する既存ファイル: `install.sh`（Task 1）、ルート `CLAUDE.md` の Apps 表（Task 7）、`README.md`（Task 7）。

---

### Task 0: 前提の検証（spike）

コードはコミットしない。結果を `apps/account-failover/docs/spike-findings.md` に書いてコミットする。**項目 1 か 2 が成り立たなければ、ここで止めてユーザーに報告する**（設計の (a) 案が崩れるため）。検証用の使い捨てプラグインは scratchpad で `orca plugin create <dir> --template hook` から作る。

**Files:**
- Create: `apps/account-failover/docs/spike-findings.md`

- [ ] **Step 1: ペインが残るか確認する。** `orca agent launch` で Claude と Codex を起動し、それぞれのエージェントのプロセスに `kill -TERM <pid>` を送る。ペインのシェルが残り、`orca terminal send --terminal <handle> --text 'echo ok' --enter` が通るかを確認する。orca-team-dispatch-task の worker 起動経路（`apps/orca-team-dispatch-task/bin/orca-start.ts`）で起動したペインでも同じことを確認する。
  - 参考: このセッションでは、`claude` の親プロセスは `-/bin/zsh -l` だった。
- [ ] **Step 2: worker から子プロセスを起動できるか確認する。** 使い捨てプラグインの worker で、`node:child_process` の `execFile` を使って `orca account list --json`・`ps`・`lsof` を実行し、結果を `orca.log` に出す。`orca plugin dev watch` でログを確認する。worker の `process.env` に `PATH`、`ORCA_CLI_BIN_DIR`、`ORCA_USER_DATA_PATH`、`HOME` が入っているかも記録する。
- [ ] **Step 3: イベントの中身を確認する。** 同じ worker で `agent.status.changed` を全件 `orca.log` に出す。次の 3 点を記録する。
  - focused でない workspace のエージェントの分も届くか。
  - `terminalId` が、プロセスの環境変数 `ORCA_TERMINAL_HANDLE`（例: `term_616dca4c-...`）と同じ値か。
  - エージェントが応答を終えたときの `state`（Claude / Codex それぞれ）。
- [ ] **Step 4: Claude の resume を確認する。** 次の両方で起動できるかを確認する。
  - 別のアカウント: `CLAUDE_CONFIG_DIR='<別アカウントの home>' claude --resume '<jsonl の絶対パス>' '<prompt>'`
  - system: `env -u CLAUDE_CONFIG_DIR claude --resume '<path>' '<prompt>'`
  
  起動したら、会話が引き継がれ、prompt が最初のメッセージとして送られることを確認する。アカウントが 1 つしかない場合は system と managed の間で確かめる。
- [ ] **Step 5: Codex を確認する。** 次の 3 点を確かめる。
  - **記録の場所:** 実行中の codex の pid に `lsof -p <pid> -Fn` を実行し、開いている `rollout-*.jsonl` のパスを記録する。
  - **resume:** その rollout を別アカウントの `CODEX_HOME/sessions/` の同じ相対パスへコピーし、`CODEX_HOME='<別 home>' codex resume <session-id> '<prompt>'` で会話が引き継がれるか確認する。
    - 引き継がれない場合は、`thread_history_1.sqlite` が必要かどうかを調べて記録する。
  - **limit の文言:** `grep -rhoE "[^\"]{0,80}(usage limit|rate limit)[^\"]{0,120}" ~/.codex/sessions "$HOME/Library/Application Support/orca/codex-accounts"/*/home/sessions | sort | uniq -c | sort -rn | head` と `strings "$(command -v codex)" | grep -iE "usage limit|try again" | head` で、Codex が出す limit の文言を実物から集める。

  記録には、そのまま正規表現にできる完全な文言を残す。
- [ ] **Step 6: Claude の limit 表示を確認する。** `~/.claude/projects` の jsonl から `You've hit your` を grep し、実際の文言（区切り文字 `·` の有無、タイムゾーン表記の有無）を記録する。
- [ ] **Step 7: 参考情報を集める。** 必須ではない。次の 2 点を確認して記録する。
  - `orca plugin install` に、GitHub の tree URL でサブフォルダを指定できるか。
  - `~/Library/Application Support/orca/rate-limit-pty-cwd` と `codex-session-backfill` が何に使われているか（使えそうな既存機能か）。
- [ ] **Step 8: Commit**

```bash
git add apps/account-failover/docs/spike-findings.md
git commit -m "docs(account-failover): 前提の検証結果を記録する"
```

---

### Task 1: プラグインの土台とインストール

**Files:**
- Create: `apps/account-failover/{orca-plugin.json,package.json,tsconfig.json,.gitignore,Makefile,bin/install.sh}`
- Create: `apps/account-failover/src/{types.ts,config.ts,worker.ts,worker.test.ts}`
- Modify: `install.sh`（末尾の完了メッセージの前）

**Interfaces:**
- Produces（`src/types.ts`）:

```ts
export type AgentKind = 'claude' | 'codex'
export type LimitHit = { agent: AgentKind; reason: string; resetsAt: number | null } // epoch ms
export type AccountRef = { agent: AgentKind; id: string; home: string; isSystem: boolean } // id は 'system' か uuid
export type Cooldown = { agent: AgentKind; accountId: string; until: number }
export type AccountPick = { kind: 'switch'; account: AccountRef } | { kind: 'wait'; until: number; account: AccountRef } | { kind: 'none' }
export type AgentProcess = { pid: number; agent: AgentKind; command: string; home: string; terminalHandle: string }
export type SessionRef = { agent: AgentKind; sessionId: string; cwd: string; transcriptPath: string }
```

- [ ] **Step 1: マニフェストを書く。** `orca-plugin.json` に Global Constraints の値を書く。
  - `contributes.events`: `[{ "on": "agent.status.changed" }]`
  - `contributes.statusBarItems`: `[{ "id": "account-failover", "text": "failover: idle", "icon": "refresh" }]`
  - `capabilities`: `agent:read`、`terminal:read`、`terminal:send`、`notifications:show`、`workspace:read`
  - `author.name`: `tanaka-yui`
- [ ] **Step 2: package.json / tsconfig / .gitignore / Makefile を書く。**
  - **package.json:** name は `@tanaka-yui/account-failover`、`private: true`、`type: module`。scripts は次のとおり。
    - `check`: `orca plugin types . >/dev/null && tsc --noEmit && biome check ./src ./orca-plugin.json`
    - `check:fix` / `format` / `format:fix` / `lint` / `lint:fix`: 他の app と同じ形にする。
    - `test`: `orca plugin test .`
  - **tsconfig.json:** template と同じく `"extends": "./.orca/types/tsconfig.json"` と `"include": ["src"]`。
  - **.gitignore:** `node_modules/` と `.orca/`。
  - **Makefile:** `apps/token-meter/Makefile` と同じ `help` 形式にする。ターゲットは次のとおり。
    - `types`: `orca plugin types .`
    - `check`: `pnpm --filter @tanaka-yui/account-failover check`
    - `test`: `orca plugin test .`
    - `validate`: `orca plugin validate .`
    - `dev`: `orca plugin dev watch .`
    - `install`: `bash bin/install.sh`
- [ ] **Step 3: `bin/install.sh` を書く。**
  - `orca plugin install "$PLUGIN_DIR" --json` を実行する。
  - **exit 0 のとき:** 完了と表示する。
  - **exit 3（approval_required / approval_stale）のとき:**
    1. 出力された、付与する権限と再実行コマンドを表示する。
    2. 出力から `--approve` の値（fingerprint）を取り出す。
    3. 端末なら `[y/N]` で確認し、y のときだけ `--approve <fingerprint>` を付けて再実行する。端末でないなら案内を出して exit 1 にする。
  - **それ以外の exit のとき:** 出力をそのまま表示して失敗する。
  - **インストール済みのとき:** 同じコマンドで更新されるかは Task 0 の Step 7 の結果に従う。更新されない場合は `orca plugin update <key>` を使う。
- [ ] **Step 4: ルートの `install.sh` に追記する。** token-meter のセットアップの後に、見出し `=== account-failover (Orca プラグイン) のインストール ===` を追加する。`command -v orca` が成功したときだけ `make -C "${REPO_DIR}/apps/account-failover" install` を実行し、失敗しても全体は止めない（`|| echo` で案内を出す）。
- [ ] **Step 5: 最小の worker とテストを書く。**
  - `src/worker.ts`: `export default function activate(orca: OrcaWorkerApi): void` は、ひとまず `orca.log('account-failover activated')` だけ。
  - `src/config.ts`: 空の定数ファイル。
  - `src/worker.test.ts`: `test('activates and logs', ...)`。`mountWorker(main)` のあと、`worker.logs` に `'account-failover activated'` が含まれることを確かめる。
- [ ] **Step 6: 検証する。** 実行するのは `cd apps/account-failover && make validate test check`。期待する結果は 3 つとも exit 0 で、テストが 1 件 PASS すること。
- [ ] **Step 7: Commit** — `feat(account-failover): Orca プラグインの土台とインストール手順を追加する`

---

### Task 2: limit の判定

**Files:**
- Create: `apps/account-failover/src/limit-detect.ts`、`src/limit-detect.test.ts`
- Modify: `src/config.ts`

**Interfaces:**
- Consumes: `AgentKind`, `LimitHit`（Task 1）
- Produces: `detectLimit(agent: AgentKind, lines: readonly string[], now: Date): LimitHit | null`、`parseResetTime(text: string, now: Date): number | null`

- [ ] **Step 1: 失敗するテストを書く。**`now` には `new Date(2026, 10, 11, 10, 0)`（ローカル時刻、水曜）を使う。
  - **`detects claude session limit`:**
    - 入力の末尾が `You've hit your session limit · resets 3:45pm` のとき。
    - 期待する結果は `{ agent: 'claude', reason: 'session', resetsAt: new Date(2026,10,11,15,45).getTime() }`。
  - **`detects claude weekly limit with weekday`:**
    - 入力は `You've hit your weekly limit · resets Mon 12:00am`。
    - 期待する `resetsAt` は `new Date(2026,10,16,0,0).getTime()`。
  - **`detects claude model limit`:**
    - 入力は `You've hit your Opus limit · resets 3:45pm`。
    - 期待する `reason` は `'Opus'`。
  - **`reset time already passed today rolls to tomorrow`:**
    - `now` は 16:00、入力は `resets 3:45pm`。
    - 期待する `resetsAt` は翌日の 15:45。
  - **`ignores 85% warning`:**
    - 入力は `You've used 85% of your session limit · resets 3:45pm`。
    - 期待する結果は `null`。
  - **`ignores limit line outside the tail`:**
    - limit 行の後ろに、空でない行が `LIMIT_TAIL_LINES` 行以上続くとき。
    - 期待する結果は `null`。
  - **`detects codex usage limit`:**
    - 入力は、Task 0 の Step 5 で記録した Codex の実際の文言。
    - 期待する結果は `agent: 'codex'`。解除時刻が文言に含まれるなら、その時刻を `resetsAt` にする。
  - **`claude text does not match for codex agent`:**
    - Claude の文言を `agent: 'codex'` で渡したとき。
    - 期待する結果は `null`。
- [ ] **Step 2: テストを走らせ、失敗することを確認する。** 実行するのは `cd apps/account-failover && orca plugin test .`。期待する結果は FAIL（`detectLimit` が未定義）。
- [ ] **Step 3: 実装する。**
  - **`config.ts` に足す定数:**
    - `LIMIT_TAIL_LINES = 15`
    - `CLAUDE_LIMIT_PATTERN = /You've hit your (.+?) limit\s*[·•-]?\s*resets\s+(.+)$/`。区切り文字は Task 0 の Step 6 の実物に合わせて調整する。
    - `CODEX_LIMIT_PATTERNS`: Task 0 の Step 5 の実物から作る。
  - **`detectLimit`:** 空行を除いた末尾 `LIMIT_TAIL_LINES` 行だけを見る。
  - **`parseResetTime`:** 次の 3 つの形式を受け付け、末尾の余計な文字列（タイムゾーン表記など）は無視する。読めない場合は `null` を返す。
    - `h:mm(am|pm)`
    - `<Mon..Sun> h:mm(am|pm)`
    - Codex の文言の形式（Task 0 で確定したもの）
- [ ] **Step 4: テストを走らせ、通ることを確認する。** 実行するのは同じコマンド。期待する結果は PASS。
- [ ] **Step 5: Commit** — `feat(account-failover): 画面の文言から limit と解除時刻を判定する`

---

### Task 3: アカウントの選択

**Files:**
- Create: `apps/account-failover/src/accounts.ts`、`src/accounts.test.ts`
- Modify: `src/config.ts`

**Interfaces:**
- Consumes: `AgentKind`, `AccountRef`, `Cooldown`, `AccountPick`（Task 1）
- Produces:
  - `parseAccountList(json: string, agent: AgentKind, orcaUserData: string, homeDir: string): AccountRef[]`
  - `pickNextAccount(accounts: readonly AccountRef[], currentHome: string, cooldowns: readonly Cooldown[], now: number): AccountPick`
  - `cooldownFor(hit: LimitHit, accountId: string, now: number): Cooldown`

- [ ] **Step 1: 失敗するテストを書く。** fixture は、`orca account list --json` の実際の形を元にした `result.claude` / `result.codex` にする（email は `a@example.com` などに置き換える）。
  - **`lists managed accounts then system for claude`:**
    - claude の accounts には `home` があり、system の home は `result.claude.systemDefaultHome`。
    - 期待する結果は `[{ id: '<uuid>', home: '<home>', isSystem: false }, { id: 'system', home: '/Users/x/.claude', isSystem: true }]`。
  - **`derives codex homes`:**
    - managed の home は `<orcaUserData>/codex-accounts/<id>/home`、system の home は `<homeDir>/.codex`。
  - **`omits system when it has no auth`:**
    - codex の `systemDefault.hasAuth` が false のとき、system は含めない。
  - **`picks the account after the current one`:**
    - 現在が accounts[0] の home のとき、期待する結果は `{ kind: 'switch', account: accounts[1] }`。
    - 末尾の次は先頭に戻る。
  - **`skips accounts on cooldown`:**
    - accounts[1] の cooldown が `until > now` のとき、accounts[2] を選ぶ。
    - 候補が現在のアカウントだけになった場合も、`switch` を返さない。
  - **`waits for earliest reset when all are cooling`:**
    - 全アカウントが cooldown 中のとき。
    - 期待する結果は `{ kind: 'wait', until: <最小の until>, account: <そのアカウント> }`。
  - **`unknown reset time uses default cooldown`:**
    - `cooldownFor({ resetsAt: null, ... }, id, now)` の結果の `until` が `now + UNKNOWN_RESET_COOLDOWN_MS` になる。
  - **`returns none when there is only one account`:**
    - 期待する結果は `{ kind: 'none' }`。
- [ ] **Step 2: テストを走らせ、失敗することを確認する。** 実行するのは `orca plugin test .`。期待する結果は FAIL。
- [ ] **Step 3: 実装する。**
  - `config.ts` に足す定数: `UNKNOWN_RESET_COOLDOWN_MS = 30 * 60_000`、`RESET_GRACE_MS = 60_000`。
  - `cooldownFor` の `until` は `resetsAt + RESET_GRACE_MS`。
  - JSON は型ガード関数で絞る（`unknown` の型注釈は使わない。`JSON.parse` の戻りは、型ガードの引数型 `JsonValue`（自前で定義した再帰型）で受ける）。
- [ ] **Step 4: テストを走らせ、通ることを確認する。** 期待する結果は PASS。
- [ ] **Step 5: Commit** — `feat(account-failover): 次に使うアカウントを cooldown を考慮して選ぶ`

---

### Task 4: エージェントのプロセスとセッションの特定

**Files:**
- Create: `apps/account-failover/src/agent-process.ts`、`src/agent-process.test.ts`

**Interfaces:**
- Consumes: `AgentKind`, `AgentProcess`, `SessionRef`（Task 1）
- Produces（すべて純粋関数。OS の呼び出しは Task 7 の `system-deps.ts` が担う）:
  - `PS_ARGS = ['-E', '-ww', '-Ao', 'pid=,command=']`
    - 環境変数付きでコマンドラインを出す。macOS の `ps -E` は環境変数をコマンドの後ろに付ける。
  - `findAgentProcess(psOutput: string, terminalHandle: string, agent: AgentKind, homeDir: string): AgentProcess | null`
    - 次の 2 条件を満たすプロセスを選ぶ。
      - コマンドの先頭のトークンの basename が `claude` / `codex` である。
      - `ORCA_TERMINAL_HANDLE=<handle>` を含む。
    - `home` は環境変数 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` から取る。値が無ければ `<homeDir>/.claude` / `<homeDir>/.codex` にする。
      - 値にはスペースを含むパス（`Application Support`）が入る。そのため、値は次の `KEY=` の手前までを取る。
    - `command` には、環境変数を除いたコマンドライン部分を入れる。
    - 候補が複数あるときは、pid が最大のもの（最新のもの）を選ぶ。
  - `parseClaudeSessionFile(json: string, pid: number): { sessionId: string; cwd: string } | null`
    - `<home>/sessions/<pid>.json` の中身を受け取る。`pid` が一致しないときは null を返す。
  - `claudeTranscriptPath(projectEntries: readonly string[], home: string, sessionId: string): string | null`
    - `projectEntries` は `<home>/projects/*/<sessionId>.jsonl` の存在確認を通ったパスの一覧。1 件のときだけそのパスを返す。
  - `parseCodexRollout(lsofOutput: string, home: string): { sessionId: string; rolloutPath: string } | null`
    - `lsof -p <pid> -Fn` の `n` 行のうち、`<home>/sessions/` 配下の `rollout-*-<uuid>.jsonl` を拾う。`sessionId` は末尾の uuid。

- [ ] **Step 1: 失敗するテストを書く。** fixture は実物の出力の形で作る。
  - **`finds claude process by terminal handle`:**
    - ps の出力に 2 プロセスがあり、それぞれの handle は異なる。
    - `CLAUDE_CONFIG_DIR` は `/Users/x/Library/Application Support/orca/claude-profiles/u1/home`（スペースを含む）。
    - 期待する結果では、`home` がそのパス全体になる。
  - **`defaults claude home when env is absent`:**
    - 期待する `home` は `/Users/x/.claude`。
  - **`ignores processes of other agents and handles`**
  - **`parses claude session file`:**
    - 入力は `{"pid":38467,"sessionId":"0d9a...","cwd":"/repo",...}`。
    - 期待する結果は `{ sessionId: '0d9a...', cwd: '/repo' }`。
    - pid が一致しないときは `null`。
  - **`transcript path requires exactly one match`:**
    - 0 件のときも 2 件のときも `null`。
  - **`parses codex rollout from lsof`:**
    - lsof の `n` 行が `n<home>/sessions/2026/11/11/rollout-2026-11-11T10-00-00-<uuid>.jsonl`。
    - 期待する `sessionId` は `<uuid>`。
- [ ] **Step 2: テストを走らせ、失敗することを確認する。** 期待する結果は FAIL。
- [ ] **Step 3: 実装する。**
- [ ] **Step 4: テストを走らせ、通ることを確認する。** 期待する結果は PASS。
- [ ] **Step 5: Commit** — `feat(account-failover): ペインのハンドルからエージェントのプロセスと session を特定する`

---

### Task 5: resume コマンドと Codex の記録の引き継ぎ

**Files:**
- Create: `apps/account-failover/src/resume-command.ts`、`src/resume-command.test.ts`
- Modify: `src/config.ts`

**Interfaces:**
- Consumes: `AgentProcess`, `SessionRef`, `AccountRef`（Task 1）
- Produces:
  - `keptFlags(agent: AgentKind, command: string): string[]`
  - `buildResumeCommand(proc: AgentProcess, session: SessionRef, target: AccountRef, prompt: string): string`
  - `codexRolloutTarget(rolloutPath: string, fromHome: string, toHome: string): string`
  - `RESUME_PROMPT`（`config.ts`）

- [ ] **Step 1: 失敗するテストを書く。**
  - **`keeps whitelisted claude flags`:**
    - 入力は `claude --model opus --effort high --permission-mode acceptEdits --dangerously-skip-permissions --resume old "fix bug"`。
    - 期待する結果は `['--model','opus','--effort','high','--permission-mode','acceptEdits','--dangerously-skip-permissions']`。
  - **`keeps whitelisted codex flags`:**
    - 入力は `codex -m gpt-6-astra -c model_reasoning_effort=xhigh --sandbox workspace-write -a never "task"`。
    - 期待する結果は `['-m','gpt-6-astra','-c','model_reasoning_effort=xhigh','--sandbox','workspace-write','-a','never']`。
  - **`claude resume for managed account`:**
    - 期待する結果は `CLAUDE_CONFIG_DIR='<home>' claude --model opus --resume '<transcriptPath>' '<prompt>'`。
    - パスと prompt はシングルクォートで囲み、中の `'` は `'\''` にエスケープする。
  - **`claude resume for system account`:**
    - 期待する結果は `env -u CLAUDE_CONFIG_DIR claude ... --resume '<path>' '<prompt>'`。
  - **`codex resume for managed and system`:**
    - managed のとき: `CODEX_HOME='<home>' codex resume <flags> <sessionId> '<prompt>'`
    - system のとき: `env -u CODEX_HOME codex resume ...`
    - フラグの位置（`resume` の前か後か）は Task 0 の Step 5 の結果に従う。
  - **`maps rollout path into target home`:**
    - 入力は `/a/home/sessions/2026/11/11/r.jsonl` で、from は `/a/home`、to は `/b/home`。
    - 期待する結果は `/b/home/sessions/2026/11/11/r.jsonl`。
- [ ] **Step 2: テストを走らせ、失敗することを確認する。** 期待する結果は FAIL。
- [ ] **Step 3: 実装する。**
  - 残すフラグのホワイトリストは、次のとおり `config.ts` に置く。
    - Claude: `--model` / `--effort` / `--permission-mode`（値あり）、`--dangerously-skip-permissions`（値なし）
    - Codex: `-m` / `--model` / `-c` / `--config` / `-s` / `--sandbox` / `-a` / `--ask-for-approval`（値あり）、`--full-auto` / `--dangerously-bypass-approvals-and-sandbox`（値なし）
  - ホワイトリストにした理由は、ps のコマンドラインは引数の境界が失われ、prompt などの空白を含む引数を復元できないため。
  - `RESUME_PROMPT` は `'Your previous turn was interrupted by a usage limit. The session has been resumed on another account. Continue the task from where you left off.'`。
- [ ] **Step 4: テストを走らせ、通ることを確認する。** 期待する結果は PASS。
- [ ] **Step 5: Commit** — `feat(account-failover): 起動時の設定を保った resume コマンドを組み立てる`

---

### Task 6: 乗り換えの手順

**Files:**
- Create: `apps/account-failover/src/failover.ts`、`src/failover.test.ts`
- Modify: `src/config.ts`

**Interfaces:**
- Consumes: Task 2〜5 の全関数
- Produces:

```ts
export type StatusEvent = { terminalId?: string; state: 'working' | 'blocked' | 'waiting' | 'done' }
export type Deps = {
  readTerminal(terminalId: string): Promise<string[]>
  sendText(terminalId: string, text: string): Promise<boolean>
  listProcesses(): Promise<string>                       // ps PS_ARGS の出力
  readFile(path: string): Promise<string | null>
  globTranscripts(home: string, sessionId: string): Promise<string[]>
  lsof(pid: number): Promise<string>
  copyFile(from: string, to: string): Promise<void>      // 親ディレクトリも作る
  signal(pid: number, sig: 'SIGTERM' | 'SIGKILL'): void
  isAlive(pid: number): boolean
  accountListJson(): Promise<string>
  selectAccount(agent: AgentKind, accountId: string): Promise<void>
  notify(title: string, body: string): Promise<void>
  status(text: string): Promise<void>
  log(message: string): void
  now(): number
  sleep(ms: number): Promise<void>
  schedule(ms: number, fn: () => void): void
  homeDir: string
  orcaUserData: string
}
export type Failover = { onStatus(event: StatusEvent): Promise<void> }
export function createFailover(deps: Deps): Failover
```

`onStatus` の手順は次のとおり。

1. **対象を絞る。** `state === 'working'` または `terminalId` が無いときは何もしない。
2. **limit を判定する。** `readTerminal` の結果に対して、Claude と Codex の両方で `detectLimit` を試す。どちらも null なら終わり。
3. **処理中のペインを避ける。** 同じペインが処理中（in-flight の Set に入っている）なら何もしない。
4. **ループを防ぐ。** そのペインの直近 `LOOP_WINDOW_MS` の乗り換え回数が `MAX_FAILOVERS_PER_WINDOW` に達していたら、通知して終わる。
5. **全ペインで直列にする。** 以降は全体で 1 本の Promise チェーンに並べる。アカウント選択がホスト全体に効くため。
6. **プロセスとセッションを特定する。** `findAgentProcess` → session を解決する（Claude は sessions ファイルと transcript、Codex は lsof）。どこかで失敗したら、通知して終わる。
7. **cooldown を記録してアカウントを選ぶ。** `cooldownFor` で、現在のアカウントの cooldown を記録する。そのうえで `pickNextAccount` を呼ぶ。
   - 結果が `none` なら、通知して終わる。
   - 結果が `wait` なら、`schedule(until - now)` で同じ `onStatus` を再実行するよう予約する。再実行時は画面をもう一度判定し、limit が消えていれば何もしない。そのうえで status を出して終わる。
8. **古いプロセスを止める。** `signal(SIGTERM)` を送る。`KILL_POLL_MS` ごとに `isAlive` を確かめ、`KILL_TIMEOUT_MS` を過ぎたら `SIGKILL` を送ってもう一度待つ。それでも生きていれば、通知して終わる（resume しない）。
9. **アカウントを切り替える。** `selectAccount` を呼ぶ。Codex の場合は、`codexRolloutTarget` の場所へ記録をコピーする。
10. **resume する。** `SHELL_SETTLE_MS` 待ってから、`sendText(buildResumeCommand(...))` を送る。続けて、通知と status を出し、乗り換え回数を記録する。

- [ ] **Step 1: 失敗するテストを書く。** Deps はテスト内のフェイクで作る。呼び出しはすべて記録し、時刻は手で進める。
  - **`claude happy path`:**
    - limit の画面、ps の出力、sessions ファイル、transcript 1 件、アカウント 2 件を用意する。
    - 期待する呼び出しの順序は `signal(SIGTERM)` → `selectAccount('claude', <次の id>)` → `sendText`（Claude の resume コマンド）→ `notify`。
  - **`codex happy path copies rollout before resume`:**
    - `copyFile` が `selectAccount` の後、`sendText` の前に呼ばれる。
  - **`ignores working state and non-limit screens`:**
    - 期待する結果は、`signal` / `selectAccount` / `sendText` が 1 回も呼ばれないこと。
  - **`handles duplicate events for one terminal once`:**
    - `onStatus` を同時に 2 回呼ぶ。
    - 期待する結果は、`selectAccount` が 1 回だけ呼ばれること。
  - **`stops after max failovers in window`:**
    - 同じペインで 4 回 limit にする。
    - 期待する結果は、`selectAccount` が 3 回だけ呼ばれ、4 回目は `notify` だけになること。
  - **`waits until reset when all accounts cool down`:**
    - 期待する結果は、`schedule` が `until - now` で予約されること。
    - 予約を発火させたとき、画面が limit のままなら乗り換えが起き、limit が消えていれば何も起きない。
  - **`does not resume when the process survives SIGKILL`:**
    - `isAlive` が常に true のとき。
    - 期待する結果は、`sendText` が呼ばれず、`notify` だけになること。
  - **`does not resume when the session cannot be resolved`:**
    - transcript が 0 件のとき。
    - 期待する結果は、`signal` も `sendText` も呼ばれないこと（プロセスを殺す前に中断する）。
- [ ] **Step 2: テストを走らせ、失敗することを確認する。** 期待する結果は FAIL。
- [ ] **Step 3: 実装する。**
  - `config.ts` に足す定数: `LOOP_WINDOW_MS = 60 * 60_000`、`MAX_FAILOVERS_PER_WINDOW = 3`、`KILL_POLL_MS = 200`、`KILL_TIMEOUT_MS = 10_000`、`SHELL_SETTLE_MS = 1_000`。
  - セッションの解決は、手順 8 でプロセスを殺すより前に済ませる。
- [ ] **Step 4: テストを走らせ、通ることを確認する。** 期待する結果は PASS。
- [ ] **Step 5: Commit** — `feat(account-failover): limit で止まったセッションを別アカウントで resume する手順を実装する`

---

### Task 7: 実環境への配線とドキュメント

**Files:**
- Create: `apps/account-failover/src/system-deps.ts`、`apps/account-failover/CLAUDE.md`
- Modify: `apps/account-failover/src/worker.ts`、`src/worker.test.ts`、ルートの `CLAUDE.md`（Apps 表）、`README.md`

**Interfaces:**
- Consumes: `Deps`, `createFailover`（Task 6）、`PS_ARGS`（Task 4）
- Produces: `createSystemDeps(orca: OrcaWorkerApi): Deps`

- [ ] **Step 1: 失敗するテストを書く。** `src/worker.test.ts` に `forwards agent status events to failover` を追加する。
  - `mountWorker(main, { host: mockHost({ capabilities: [...], results: { 'terminal.read': { lines: ['ok'], truncated: false } } }) })` でマウントする。
  - `worker.emit('agent.status.changed', { workspaceId: 'w', paneKey: 'p', terminalId: 't1', state: 'done', receivedAt: 0 })` を送る。
  - 期待する結果は、`worker.host.callsOf('terminal.read')` が 1 件になり、`terminal.sendText` は 0 件になること。
- [ ] **Step 2: テストを走らせ、失敗することを確認する。** 期待する結果は FAIL。
- [ ] **Step 3: 実装する。**
  - **`system-deps.ts`:**
    - `execFile` を使う（`orca` は、`ORCA_CLI_BIN_DIR` があれば絶対パスで呼ぶ）。
    - ファイル操作は `node:fs/promises`、プロセス操作は `process.kill` を使う。
    - `orcaUserData` は `ORCA_USER_DATA_PATH` から取る。無ければ `<homedir>/Library/Application Support/orca` にする。Task 0 の Step 2 で worker の環境に何が入っているかを確かめてから決める。
  - **`worker.ts`:** `orca.events.on('agent.status.changed', e => failover.onStatus(e))`。
- [ ] **Step 4: 自動テストを走らせ、通ることを確認する。** 実行するのは `cd apps/account-failover && make test check validate`。期待する結果は、すべて PASS かつ exit 0。
- [ ] **Step 5: 実環境で手動確認する。**
  1. `make dev` を起動する。
  2. Claude のペインで、limit 画面の文言を出力する（`printf "You've hit your session limit · resets 3:45pm\n"` を、エージェントの代わりに `cat` を走らせたペインで流す、など）。そのうえで `orca plugin dev emit . agent.status.changed --data '{...そのペインの terminalId...}'` を発火させる。
  3. ログで判定から resume までが流れることを確認する。
  4. 本物の Claude セッションでも次を確認する。
     - プロセスが入れ替わり、同じハンドルのまま新しいアカウントの `CLAUDE_CONFIG_DIR` で動いていること（`ps -E`）。
     - 会話が続いていること。
  
  結果は `docs/spike-findings.md` の末尾に追記する。
- [ ] **Step 6: ドキュメントを書く。**
  - **`apps/account-failover/CLAUDE.md`:** プラグイン固有の事項だけを日本語で書く。
    - 判定〜resume の流れ
    - ペインを保つ理由（dispatch のハンドル）
    - フラグのホワイトリストの理由
    - Task 0 で確定した文言と、その更新方法
    - Make のターゲット
  - **ルートの `CLAUDE.md`:** Apps 表に 1 行を追加する（種類は `Orca plugin (trusted-worker)`、言語は `TypeScript (Orca が変換)`）。テストの節に `cd apps/account-failover && make test` を追加する。
  - **`README.md`:** インストール方法を追記する。
- [ ] **Step 7: Commit** — `feat(account-failover): worker を実環境に配線し、ドキュメントを追加する`
