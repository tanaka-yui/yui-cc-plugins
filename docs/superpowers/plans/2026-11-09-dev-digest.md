# dev-digest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 毎朝、AWS / Google Cloud / JVN / X / dev.to / GitHub Releases の新着を集めて Claude が日本語で要約し、Slack に「全体 1 通 + 監視リポジトリごとに 1 通」で送り、履歴を SQLite に残して後で検索できるプラグイン `apps/dev-digest` を作る。

**Architecture:** 取得・既読管理・Slack 送信・Orca への登録は TypeScript のスクリプト（node の型除去で直接実行、実行時の npm 依存ゼロ）が担い、要約・まとめ・関連判定・X の閲覧は Orca automation が起動した Claude が担う。状態はすべて `~/.dev-digest/` に置き、automation のプロンプトは安定パスのランチャーを呼ぶだけの固定文にする。

**Tech Stack:** Node（型除去 / `node:sqlite` の FTS5 trigram / 組み込み `fetch`）、TypeScript 6（型検査のみ）、biome 2.4.9、Orca CLI（`repo add` / `automations` / 内蔵ブラウザ）、Slack Incoming Webhook、macOS `osascript`。

**Spec:** `docs/superpowers/specs/2026-11-09-dev-digest-design.md`

## Global Constraints

- 場所は `apps/dev-digest`。package 名 `@tanaka-yui/dev-digest`、`"type": "module"`、`private: true`
- 実行時の npm 依存ゼロ。`node:` 組み込みだけ。`@types/node` は `24.19.2`（プラグインの Node 下限 `>=24.15.0` に合わせる）
- 実行は `node <path>.ts`。`tsconfig.json` は `apps/orca-team-dispatch-task/tsconfig.json` と同じ設定（`erasableSyntaxOnly` / `verbatimModuleSyntax` / `noUncheckedIndexedAccess` / `strict`）
- `any` / `unknown` / `class` / `enum` / `namespace` を書かない。JSON は `lib/json.ts` の `Json` 型と `asObject` などで絞る
- 型だけの import は `import type`。相対 import は `.ts` 拡張子付き
- 値のハードコードは `lib/defaults.ts` の 1 箇所に集める（フィード URL・既定タグ・上限値・自動化名・プロンプト文）
- 秘密（Webhook URL）は stdout / stderr / 生成する JSON / automation 設定 / Claude の設定ファイルのどこにも平文で出さない。出すときは `maskWebhook` を通す
- 状態のルートは `DEV_DIGEST_HOME`（既定 `~/.dev-digest`）。テストは必ず一時ディレクトリを `DEV_DIGEST_HOME` に渡す
- Orca CLI は `ORCA_BIN`（既定: `ORCA_CLI_COMMAND`、無ければ `orca`）で呼び、**標準入力を渡さない**（`stdio: ['ignore', 'pipe', 'pipe']`）
- 入口は stdout をまとめて書き `process.exitCode` で終える。`process.exit` は使用法の誤り（`die`）だけ
- 文書の言語: `SKILL.md` / `references/*.md` は英語（`*-ja.md` を除く）、SKILL.md 冒頭に `## Output Language` ブロックを一字一句、`references/guide-ja.md` は SKILL.md と見出し 1:1 の訳。`CLAUDE.md` / `README.md` / コミットメッセージは日本語
- 版: `apps/dev-digest/.claude-plugin/plugin.json` とルート `.claude-plugin/marketplace.json` の `version` を `0.1.0` で揃える。`.codex-plugin` は作らない（spec §7: 毎朝の実行は Claude だけ）
- テスト: 単体は `node --test 'test/unit/*.test.ts'`、結合は `test/*.test.ts` を同じく `node --test` で。`test/run-all.sh` が両方を走らせる。`pnpm --filter @tanaka-yui/dev-digest check` と `pnpm check`（doc-lang 含む）が通ること

## Review Focus

1. **巨大な初回フィード** — JVN の 2 フィードは各 500 件、AWS What's New は約 100 件。初めて取得したソースの 24 時間より古い項目は送らない（Task 5 `CO2`）。新しく setup したリポジトリの Releases（過去の全リリース）も同じ規則で溢れない（Task 5 `CO3`）
2. **Slack の失敗で既読が進む** — 送れなかった送り先の項目は翌朝に再送される。全体は 200・リポジトリ宛ては 500 のとき、全体だけ送信済みになる（Task 7 `PB3`）
3. **Webhook URL の漏れ** — Slack が 4xx の本文に URL を含めて返す・`fetch` の例外メッセージに URL が入る・設定の一覧表示、のどれでも平文が stdout / stderr に出ない（Task 7 `PB5`、Task 8 `SW3`、Task 10 `RP4`）
4. **フィードの壊れた XML・CDATA・実体参照** — `&amp;lt;` の二重エスケープ、CDATA の中の `<`、閉じタグの無い要素で解析が例外を投げずに、読めた項目だけ返す（Task 3 `FD5` / `FD6`）
5. **AI が digest.json に項目を書き漏らす** — pending にあって digest.json の notes にも groups にも無い項目は、元のタイトルとリンクのまま全体の通知に載る（「全部載せる」）（Task 7 `PB2`）

---

## File Structure

```
apps/dev-digest/
  .claude-plugin/plugin.json
  package.json  tsconfig.json  README.md  CLAUDE.md  LICENSE（orca-team-dispatch-task からコピー）
  bin/
    dev-digest.ts        サブコマンドの入口（lib/commands/* へ振り分け）
    launch.ts            自己完結のランチャー（init が ~/.dev-digest/bin/ へコピーする。lib を import しない）
  lib/
    json.ts  cli.ts      orca-team-dispatch-task の同名ファイルをコピー（プラグインは別々に入るので共有しない）
    defaults.ts          定数とフィード一覧（ハードコードの唯一の置き場）
    paths.ts             DEV_DIGEST_HOME と配下のパス
    severity.ts          深刻度の型と比較
    config.ts            Config / RepoConfig の型・読み書き・検証・ソース一覧の組み立て
    secrets.ts           secrets.json の読み書き・伏せ字
    input.ts             秘密の入力（osascript ダイアログ / クリップボード / stdin）
    feed.ts              RSS 2.0 / Atom / RSS 1.0(RDF) の解析
    db.ts                node:sqlite のスキーマと操作
    pending.ts           pending.json の組み立て
    digest.ts            digest.json の型と検証
    slack.ts             メッセージの組み立て・分割・送信
    orca.ts              Orca CLI の呼び出し
    permissions.ts       Claude の permission ルールの提案と適用
    commands/            1 サブコマンド = 1 ファイル。各ファイルは `run(argv: string[]): Promise<number>` を export
      init.ts  permissions.ts  set-webhook.ts  repo.ts  procedure.ts
      collect.ts  ingest-x.ts  pending.ts  publish.ts  search.ts
  skills/dev-digest/
    SKILL.md
    references/guide-ja.md
    references/morning.md      毎朝の手順書（procedure が表示する。英語）
    references/morning-ja.md   任意の訳
  test/
    run-all.sh
    fixtures/                  実フィードを数件に縮めたもの（aws-whats-new.xml, gcp-release-notes.xml, jvndb_new.rdf, devto.xml, releases.atom, broken.xml）
    helpers.ts                 一時 HOME・ローカル HTTP サーバ・偽の orca
    unit/*.test.ts
    *.test.ts                  結合テスト
```

サブコマンドの入口は `node <plugin>/bin/dev-digest.ts <command> [flags]`。ユーザーと automation は `~/.dev-digest/bin/dev-digest <command>` で呼ぶ（ランチャー経由）。

---

### Task 1: スパイク — automation から Claude が無人で動き、Orca ブラウザで X を読めるか

コードは残さない（`apps/dev-digest/` を作らない）。結果を spec の末尾に「§13 スパイクの結果」として追記してコミットする。**ここで X が読めない、または Claude が確認ダイアログ / フォルダの信頼ダイアログで止まるとわかったら、以降のタスクに進まずユーザーに報告する。**

ユーザーの作業が要るので、各ステップでユーザーに頼む内容を日本語で伝える。

- [ ] **Step 1: 作業フォルダを Orca に登録する**

Run: `mkdir -p /tmp/dd-spike/run && orca repo add --path /tmp/dd-spike/run --kind folder --json`
記録: 返った JSON の id のフィールド名と値、2 回目に実行したときの応答（既に登録済みのときのエラーコード）、`orca repo list --json` での見え方、`orca automations create --workspace` に渡す selector の形（`folder:<id>` か `id:<id>` か）

- [ ] **Step 2: ユーザーに Orca のブラウザで X にログインしてもらう**

ユーザーへの依頼: 「Orca の内蔵ブラウザで x.com にログインし、AI 関連の人を集めたリストの URL を教えてください」

- [ ] **Step 3: 一時的な automation を作って走らせる**

`/tmp/dd-spike/run/.claude/settings.json` に allow ルール `Bash(orca tab:*)` `Bash(orca snapshot:*)` `Bash(orca scroll:*)` `Bash(orca goto:*)` `Bash(orca wait:*)` `Bash(orca get:*)` `Write(/tmp/dd-spike/run/**)` を書き、次で作成・実行する:

```bash
orca automations create --name dd-spike --trigger daily --time 06:00 --timezone Asia/Tokyo \
  --provider claude --workspace <Step 1 の selector> --fresh-session --disabled \
  --prompt "Open <リストURL> with 'orca tab create --url', read the newest 10 posts using 'orca snapshot' and 'orca scroll', and write them as JSON (id, url, author, text, postedAt) to /tmp/dd-spike/run/x.json. Then run 'curl -s -o /dev/null -w %{http_code} https://dev.to/feed' and append the status to /tmp/dd-spike/run/net.txt." --json
orca automations run <id> --json
```

- [ ] **Step 4: 結果を確かめる**

Run: `orca automations runs --id <id> --json` と `cat /tmp/dd-spike/run/x.json /tmp/dd-spike/run/net.txt`
合格: x.json にポストが 10 件、net.txt に `200`、実行がダイアログ（permission / フォルダの信頼）で止まっていない。止まった場合は Orca の端末画面（`orca terminal read` 等）で何に止まったかを記録する。
あわせて記録: X の snapshot でポストの ID・投稿者・時刻・本文がどの要素に出るか、Claude Code の permission ルールで home 配下のパスを書く正しい形（`~/...` か `//abs/...` か。claude-code-guide に尋ねて確かめる）、`orca automations create` の `--json` 出力の id のフィールド名、`--missed-run-grace-minutes` を付けたときの挙動。

- [ ] **Step 5: 後始末とコミット**

Run: `orca automations remove <id> --json`、Step 1 の folder を `orca worktree rm --worktree "id:<id>"` で外す、`rm -rf /tmp/dd-spike`
spec に §13 を追記して:

```bash
git add docs/superpowers/specs/2026-11-09-dev-digest-design.md
git commit -m "docs(dev-digest): automation から Orca ブラウザで X を読めるかのスパイク結果を記録する"
```

---

### Task 2: パッケージの骨組みと基礎部品（defaults / paths / severity / config）

**Files:**
- Create: `apps/dev-digest/package.json`, `tsconfig.json`, `.claude-plugin/plugin.json`, `LICENSE`, `lib/json.ts`, `lib/cli.ts`（orca-team-dispatch-task からコピー）, `lib/defaults.ts`, `lib/paths.ts`, `lib/severity.ts`, `lib/config.ts`, `test/run-all.sh`
- Modify: `.claude-plugin/marketplace.json`（末尾に dev-digest を追加。`category: "productivity"`, `tags: ["digest","slack","rss","orca"]`）, `install.sh`（`claude plugin install dev-digest@yui-cc-plugins` を追加）
- Test: `test/unit/severity.test.ts`, `test/unit/config.test.ts`

**Interfaces:**
- Produces:
  - `lib/defaults.ts`:
    - `PLUGIN_ID = 'dev-digest@yui-cc-plugins'`, `AUTOMATION_NAME = 'dev-digest'`, `DEFAULT_TIMEZONE = 'Asia/Tokyo'`
    - `AUTOMATION_PROMPT = 'Run `~/.dev-digest/bin/dev-digest procedure` and follow the printed instructions exactly. Never read ~/.dev-digest/secrets.json.'`（`~` は init が実パスに置き換える）
    - `BUILTIN_FEEDS: readonly FeedSource[]` — id / url / section / trackUpdates / scope:
      `aws-whats-new` `https://aws.amazon.com/about-aws/whats-new/recent/feed/` aws false global、
      `aws-news-blog` `https://aws.amazon.com/blogs/aws/feed/` aws false global、
      `gcp-release-notes` `https://cloud.google.com/feeds/gcp-release-notes.xml` gcp **true** global、
      `gcp-blog` `https://cloudblog.withgoogle.com/rss/` gcp false global、
      `devto` `https://dev.to/feed` devto false global、
      `jvn-new` `https://jvndb.jvn.jp/ja/rss/jvndb_new.rdf` jvn false global、
      `jvn-updated` `https://jvndb.jvn.jp/ja/rss/jvndb.rdf` jvn false global
    - JVN の 2 フィードは同じ脆弱性（同じ `rdf:about`）を載せるので、項目は **`storeAs: 'jvn'`** の 1 つの source_id で DB に入れる（取得と失敗の記録は各フィードの id のまま）。他のフィードの `storeAs` は自分の id。`jvndb.rdf`（更新）を取るのは、後から深刻度が上がった項目を拾うため（Task 4 `DB3`）。本文の変化では再送しない
    - `DEFAULT_DEVTO_TAGS = ['aws', 'googlecloud', 'ai', 'security']`, `DEFAULT_X_HASHTAGS = ['#AI', '#LLM', '#生成AI']`（判断。init で提示して変えられる）
    - `BASELINE_HOURS = 24`, `EXCERPT_CHARS = 500`, `MAX_MESSAGE_CHARS = 3500`, `FETCH_TIMEOUT_MS = 20000`, `X_MAX_POSTS_LIST = 50`, `X_MAX_POSTS_PER_HASHTAG = 20`, `LAUNCHER_VERSION = 1`
    - `devtoTagFeed(tag: string): FeedSource`（id `devto-tag:<tag>`, url `https://dev.to/feed/tag/<tag>`）、`releasesFeed(github: string): FeedSource`（id `releases:<owner/repo>`, url `https://github.com/<owner/repo>/releases.atom`, section `releases`, scope `repo`）
  - `lib/paths.ts`: `digestHome(): string`（`DEV_DIGEST_HOME` か `~/.dev-digest`）、`homePaths(home: string): { config: string; reposDir: string; secrets: string; db: string; binDir: string; launcher: string; launcherScript: string; runDir: string }`（launcher = `bin/dev-digest`、launcherScript = `bin/launch.ts`、runDir = `run`）
  - `lib/severity.ts`: `type Severity = 'low' | 'medium' | 'high' | 'critical'`、`SEVERITIES`、`parseSeverity(text: string): Severity | null`、`atLeast(value: Severity | null, threshold: Severity): boolean`（null は `low`）、`maxSeverity(values: Severity[]): Severity | null`
  - `lib/config.ts`:
    - `type Section = 'jvn' | 'aws' | 'gcp' | 'x' | 'devto' | 'releases'`
    - `type FeedSource = { id: string; storeAs: string; url: string; section: Section; trackUpdates: boolean; scope: 'global' | 'repo' }`
    - `type Config = { version: 1; schedule: { trigger: 'daily' | 'weekdays'; time: string; timezone: string }; jvnMinSeverity: Severity; devtoTags: string[]; x: { listUrl: string | null; hashtags: string[] }; orca: { workspaceSelector: string | null; automationId: string | null }; pluginRoot: string }`
    - `type WatchPackage = { name: string; ecosystem: string; github: string | null }`
    - `type RepoConfig = { slug: string; displayName: string; path: string; addedAt: string; jvnMinSeverity: Severity | null; devtoTags: string[]; watch: { languages: string[]; packages: WatchPackage[]; cloudServices: string[]; keywords: string[] } }`
    - `parseConfig(value: Json): Config | string`（string は誤りの説明）、`parseRepoConfig(value: Json): RepoConfig | string`
    - `loadConfig(home: string): Config | null`、`saveConfig(home: string, config: Config): void`、`loadRepos(home: string): RepoConfig[]`、`saveRepo(home: string, repo: RepoConfig): void`、`removeRepo(home: string, slug: string): boolean`
    - `slugToFile(slug: string): string`（`owner/repo` → `owner__repo.json`）
    - `type ResolvedSource = FeedSource & { repoSlugs: string[] }`、`buildSources(config: Config, repos: RepoConfig[]): ResolvedSource[]` — BUILTIN_FEEDS + 全体タグ（global）+ 各リポジトリのタグと Releases（repo）。同じ url は 1 つにまとめ repoSlugs を合併する。全体タグとリポジトリタグが同じ url なら scope は global

- [ ] **Step 1: 失敗するテストを書く**

`test/unit/severity.test.ts`:
- `SV1 parseSeverity は大文字小文字を問わない`: `parseSeverity('Critical') === 'critical'`, `parseSeverity('HIGH') === 'high'`, `parseSeverity('none') === null`
- `SV2 atLeast はしきい値以上だけ true`: `atLeast('high','high')`, `atLeast('critical','high')` が true、`atLeast('medium','high')`, `atLeast(null,'medium')` が false、`atLeast(null,'low')` が true
- `SV3 maxSeverity`: `maxSeverity(['medium','critical','high']) === 'critical'`, `maxSeverity([]) === null`

`test/unit/config.test.ts`:
- `CF1 parseConfig は既知の形を通し、jvnMinSeverity の誤りを説明する`: 正しい Config が同値で返る、`jvnMinSeverity: 'urgent'` で `'jvnMinSeverity'` を含む文字列
- `CF2 saveRepo / loadRepos / removeRepo の往復`: 一時 HOME で `owner/repo` を保存 → `repos/owner__repo.json` が存在 → loadRepos が 1 件 → removeRepo が true → 0 件
- `CF3 buildSources は同じ URL を 1 つにまとめる`: repo A と B が両方 `keycloak/keycloak` を持つとき `releases:keycloak/keycloak` は 1 件で `repoSlugs` が `['a/a','b/b']`
- `CF4 全体タグと同じリポジトリタグは global のまま`: 全体 `aws`、repo のタグ `aws` → `devto-tag:aws` は scope `global`、repoSlugs に repo を含む
- `CF5 github が null のパッケージは Releases を作らない`

- [ ] **Step 2: 失敗を確かめる**

Run: `cd apps/dev-digest && node --test 'test/unit/*.test.ts'`
Expected: FAIL（モジュールが無い）

- [ ] **Step 3: 実装する**

`package.json` の scripts は orca-team-dispatch-task と同じ 6 本（対象ディレクトリ `./bin ./lib ./skills ./test`）、`devDependencies: { "@types/node": "24.19.2" }`、`engines: { "node": ">=24.15.0" }`。`run-all.sh` は `node --test 'test/unit/*.test.ts' 'test/*.test.ts'` を走らせ、失敗で非 0。設定ファイルは `JSON.stringify(value, null, 2)` + 改行、書き込みは一時ファイル → rename。ディレクトリは `0o700` で作る。

- [ ] **Step 4: 通ることを確かめる**

Run: `cd apps/dev-digest && node --test 'test/unit/*.test.ts' && pnpm install && pnpm --filter @tanaka-yui/dev-digest check`
Expected: PASS、check はエラー 0

- [ ] **Step 5: コミット**

```bash
git add apps/dev-digest .claude-plugin/marketplace.json install.sh pnpm-lock.yaml
git commit -m "feat(dev-digest): パッケージの骨組みと設定・深刻度の部品を追加する"
```

---

### Task 3: フィードの解析（RSS 2.0 / Atom / RSS 1.0 RDF）

**Files:**
- Create: `lib/feed.ts`, `test/fixtures/{aws-whats-new.xml,gcp-release-notes.xml,jvndb_new.rdf,devto.xml,releases.atom,broken.xml}`
- Test: `test/unit/feed.test.ts`

fixtures は実フィード（spec §3 の URL）を `curl` で取り、各 3 件に縮める。jvndb_new.rdf は `severity="Critical"` の項目と、`sec:cvss` を 2 つ（v2 と v3）持つ項目と、cvss の無い項目を 1 件ずつ含める。

**Interfaces:**
- Consumes: `Severity`, `maxSeverity`, `parseSeverity`（Task 2）、`EXCERPT_CHARS`
- Produces: `type FeedItem = { guid: string; url: string; title: string; summary: string; author: string | null; publishedAt: string | null; updatedAt: string | null; severity: Severity | null; products: string[] }`、`parseFeed(xml: string): FeedItem[]`、`contentHash(item: FeedItem): string`（title + summary + updatedAt の sha256。`node:crypto`）

- [ ] **Step 1: 失敗するテストを書く**

- `FD1 RSS 2.0`: aws fixture で 3 件、`guid` は `<guid>`、無ければ `<link>`。`publishedAt` は `pubDate` を ISO 8601 に直したもの
- `FD2 Atom`: releases fixture で `guid` は `<id>`、`url` は `<link rel="alternate" href>`（rel 無しも alternate とみなす）、`updatedAt` は `<updated>`。gcp fixture も読める
- `FD3 RDF と JVN の深刻度`: jvndb fixture で guid は `rdf:about`、Critical の項目は `severity === 'critical'`、cvss 2 つの項目は高い方、cvss 無しは `null`。`products` は `sec:cpe` の `product` 属性（例 `['SS1','SS1クラウド','rocoeyes']`）
- `FD4 summary はタグを除き実体を戻して EXCERPT_CHARS で切る`: `&lt;ul&gt;&lt;li&gt;` を含む description から `<` が残らない、`&#13;` は空白、長さ ≤ 500
- `FD5 CDATA と二重エスケープ`: `<description><![CDATA[a < b &amp; c]]></description>` → `'a < b & c'`、`&amp;lt;` → `'<'` として 1 段だけ戻した結果が要約に残らない（タグとして除かれる）
- `FD6 壊れた XML でも投げない`: broken.xml（閉じタグ欠け・途中で切れた末尾）で例外を投げず、完全な項目だけを返す（fixture の完全な 2 件）
- `FD7 contentHash は本文が変われば変わる`

- [ ] **Step 2: 失敗を確かめる** — Run: `node --test test/unit/feed.test.ts` / Expected: FAIL

- [ ] **Step 3: `parseFeed` を実装する**

汎用の XML パーサは書かない。`<item ...>…</item>` / `<entry ...>…</entry>` の区間を正規表現で切り出し、区間の中で必要な要素だけを取り出す（名前空間の接頭辞付き `dc:date` `dcterms:issued` `dcterms:modified` `sec:cvss` `sec:cpe` を含む）。閉じが見つからない区間は捨てる。日付は `new Date(text)` が NaN なら null。

- [ ] **Step 4: 通ることを確かめる** — Run: `node --test test/unit/feed.test.ts` / Expected: PASS

- [ ] **Step 5: コミット** — `git commit -m "feat(dev-digest): RSS / Atom / RDF のフィードを解析する"`

---

### Task 4: DB（スキーマ・取り込み・送信記録・検索）

**Files:**
- Create: `lib/db.ts`
- Test: `test/unit/db.test.ts`

**Interfaces:**
- Consumes: `FeedItem`, `contentHash`（Task 3）、`Severity`, `atLeast`
- Produces:
  - `type Db = DatabaseSync`、`openDb(file: string): Db`（`PRAGMA user_version` でマイグレーション。スキーマは下記）
  - `type UpsertResult = 'new' | 'updated' | 'unchanged'`、`upsertItem(db: Db, sourceId: string, item: FeedItem, trackUpdates: boolean, now: string): UpsertResult`
  - `hasSource(db: Db, sourceId: string): boolean`、`markBaseline(db: Db, sourceId: string, cutoff: string): number`（その source で `publishedAt` が null か cutoff より前の項目を baseline=1 にし、件数を返す）
  - `startRun(db: Db, now: string): { runId: number; previousIncomplete: { runId: number; startedAt: string } | null }`、`recordFailure(db: Db, runId: number, sourceId: string, reason: string): void`、`runFailures(db: Db, runId: number): Array<{ sourceId: string; reason: string }>`、`finishRun(db: Db, runId: number, now: string): void`、`latestRun(db: Db): { runId: number; startedAt: string; finishedAt: string | null } | null`、`lastXIngest(db: Db): string | null`
  - `type Destination = 'global' | `repo:${string}``
  - `type StoredItem = { id: number; revision: number; sourceId: string; guid: string; url: string; title: string; summary: string; author: string | null; publishedAt: string | null; severity: Severity | null; products: string[]; firstSeenAt: string; updated: boolean }`（updated = revision > 1）
  - `undelivered(db: Db, destination: Destination, sourceIds: string[], since: string | null): StoredItem[]`（baseline=0、その revision に対する delivery が無い、`firstSeenAt >= since`）
  - `recordDelivery(db: Db, rows: Array<{ itemId: number; revision: number; destination: Destination; status: 'sent' | 'irrelevant'; runId: number }>, now: string): void`（1 トランザクション）
  - `saveNote(db: Db, itemId: number, revision: number, note: { summaryJa: string; tags: string[]; groupKey: string | null }): void`（FTS も更新）
  - `type SearchQuery = { text: string | null; since: string | null; until: string | null; sections: Section[]; repo: string | null; minSeverity: Severity | null; limit: number }`、`type SearchHit = StoredItem & { summaryJa: string | null; tags: string[]; deliveredTo: Destination[] }`、`search(db: Db, query: SearchQuery, sectionOf: (sourceId: string) => Section): SearchHit[]`

スキーマ（判断）:
- `items(id INTEGER PRIMARY KEY, source_id TEXT, guid TEXT, url, title, summary, author, published_at, updated_at, severity, products TEXT /*JSON*/, content_hash, revision INTEGER, baseline INTEGER DEFAULT 0, first_seen_at, last_changed_at, UNIQUE(source_id, guid))`
- `notes(item_id, revision, summary_ja, tags TEXT, group_key, PRIMARY KEY(item_id, revision))`
- `deliveries(item_id, revision, destination, status, run_id, at, PRIMARY KEY(item_id, revision, destination))`
- `runs(id INTEGER PRIMARY KEY, started_at, finished_at)`、`run_failures(run_id, source_id, reason)`
- `items_fts USING fts5(title, summary, summary_ja, tags, products, tokenize='trigram')`（rowid = items.id）

- [ ] **Step 1: 失敗するテストを書く**（`:memory:` で）
- `DB1 初回は new、同じものは unchanged`
- `DB2 trackUpdates の source だけ本文の変化で revision が上がる`: gcp 相当で本文を変えると `'updated'`・revision 2、trackUpdates=false では `'unchanged'`・revision 1
- `DB3 深刻度は trackUpdates に関係なく上書きされ、revision は上がらない`: severity を `high` → `critical` に変えた再取り込みで `severity === 'critical'`、revision 1
- `DB4 markBaseline は cutoff より古い項目と日付無しを除外する`: 3 件（2 日前・1 時間前・null）で cutoff=24 時間前 → 戻り値 2、`undelivered` は 1 時間前の 1 件だけ
- `DB5 undelivered は送り先ごと`: global に sent を記録した項目は `repo:a/a` ではまだ返る
- `DB6 revision が上がると再び undelivered になる`
- `DB7 startRun は前回の未完了を返す`: startRun → finishRun せずに startRun → `previousIncomplete.runId` が 1 回目
- `DB8 search は日本語の部分一致と期間・深刻度で絞る`: title `Keycloak における認証回避の脆弱性` を `text:'認証回避'` と `text:'keycloak'` で 1 件、`minSeverity:'critical'` で severity high の項目は返らない、`since` より前は返らない。3 文字未満の `text`（例 `'AI'`）は LIKE で title / summary / summary_ja を探す

- [ ] **Step 2: 失敗を確かめる** — Run: `node --test test/unit/db.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装する**（`node:sqlite` の `DatabaseSync`、prepared statement。`ExperimentalWarning` は入口で `process.removeAllListeners('warning')` せず、そのまま許容する）
- [ ] **Step 4: 通ることを確かめる** — Expected: PASS
- [ ] **Step 5: コミット** — `git commit -m "feat(dev-digest): 履歴・既読・送信記録の SQLite を追加する"`

---

### Task 5: collect と ingest-x

**Files:**
- Create: `lib/commands/collect.ts`, `lib/commands/ingest-x.ts`, `bin/dev-digest.ts`（サブコマンドの振り分け。未知のコマンドは使用法を出して `die`）, `test/helpers.ts`
- Test: `test/collect.test.ts`

**Interfaces:**
- Consumes: Task 2〜4 のすべて
- Produces:
  - `dev-digest collect [--now <ISO>]`: config と repos を読み、`startRun` → `buildSources` の全 url を並列に `fetch`（`FETCH_TIMEOUT_MS`、User-Agent `dev-digest`）→ `parseFeed` → 初めての source なら全件を入れたあと `markBaseline(cutoff = now - BASELINE_HOURS)` → 取得失敗は `recordFailure` して続ける。stdout は `key=value` 行: `run_id=<n>`、`previous_incomplete=<startedAt|none>`、`x_since=<lastXIngest|none>`、`new=<n>`、`updated=<n>`、`failed=<sourceId,...|none>`。config が無ければ exit 2 で「init を先に」
  - `dev-digest ingest-x --file <path>` または `--failed <reason>`: file は `{ posts: Array<{ id: string; url: string; author: string; text: string; postedAt: string; via: string }> }`。source_id は `x`（scope global、section x、trackUpdates false）、guid は id、title は text の先頭 80 文字、summary は text。初めての x なら collect と同じ baseline。`--failed` は最新の run に `recordFailure('x', reason)`。stdout `new=<n>`
  - `test/helpers.ts`: `tempHome(): string`、`startServer(routes: Record<string, { status: number; body: string; type?: string }>): Promise<{ url: string; requests: Array<{ path: string; body: string }>; close(): Promise<void> }>`、`runCli(args: string[], env: Record<string, string>): { code: number; stdout: string; stderr: string }`（`spawnSync('node', [bin/dev-digest.ts, ...args])`）、`writeConfig(home, overrides)`

DB の操作（`upsertItem` / `hasSource` / `markBaseline`、Task 6 の `undelivered`）に渡す source id は常に `storeAs`。

フィード URL をテストで差し替えるため、`buildSources` の後に環境変数 `DEV_DIGEST_FEED_BASE`（テスト専用。設定されていれば各 url の origin をこの値に置き換える）を collect で適用する。

- [ ] **Step 1: 失敗するテストを書く**（ローカル HTTP サーバで fixtures を配る）
- `CO1 collect は全ソースを取り込み key=value を出す`: stdout に `run_id=1`、`new=` が 0 より大きい
- `CO2 初めてのソースの 24 時間より古い項目は送らない`: `--now` を fixture の最新日時の 1 時間後にして collect → `undelivered(global)` には 24 時間以内の項目だけ
- `CO3 後から足したリポジトリの Releases も溢れない`: 1 回 collect した後に repo を足し、releases.atom（過去 3 件、うち 1 件が 24 時間以内）で collect → repo 宛ての undelivered の Releases は 1 件
- `CO4 1 ソースの 500 は全体を止めない`: aws を 500 にしても exit 0、`failed=aws-whats-new`、他のソースは入る
- `CO5 2 回目の collect で同じ項目は new にならない`: 2 回目は `new=0`
- `CO6 ingest-x は同じ id を二重に入れない、--failed は失敗として残る`
- `CO7 JVN の新着と更新の両方に載る脆弱性は 1 件として入る`: 同じ `rdf:about` を両 fixture に入れる → items の source_id `jvn` に 1 件、更新側で severity が critical に上がっていれば DB の severity が critical

- [ ] **Step 2〜4:** 失敗を確かめる → 実装 → Run: `node --test test/collect.test.ts` / Expected: PASS
- [ ] **Step 5: コミット** — `git commit -m "feat(dev-digest): フィードを取得して新着を記録する collect と X の取り込みを追加する"`

---

### Task 6: pending.json と digest.json の検証

**Files:**
- Create: `lib/pending.ts`, `lib/digest.ts`, `lib/commands/pending.ts`
- Test: `test/unit/digest.test.ts`, `test/pending.test.ts`

**Interfaces:**
- Consumes: `undelivered`, `latestRun`, `runFailures`, `buildSources`, `loadRepos`, `atLeast`
- Produces:
  - `type PendingEntry = { id: number; revision: number; section: Section; sourceId: string; title: string; url: string; summary: string; author: string | null; publishedAt: string | null; severity: Severity | null; products: string[]; updated: boolean }`
  - `type PendingRepo = { slug: string; displayName: string; watch: RepoConfig['watch']; candidateIds: number[]; ownIds: number[] }`
  - `type PendingFile = { runId: number; generatedAt: string; previousIncomplete: string | null; items: PendingEntry[]; globalIds: number[]; repos: PendingRepo[]; failures: Array<{ sourceId: string; reason: string }> }`
  - `buildPending(db: Db, config: Config, repos: RepoConfig[], now: string): PendingFile` — 規則:
    - `globalIds`: scope global の source の undelivered(global)。jvn section は `atLeast(severity, config.jvnMinSeverity)` のものだけ
    - repo の `ownIds`: その repo が repoSlugs に入る scope repo の source の undelivered(repo:slug, since = repo.addedAt)
    - repo の `candidateIds`: scope global の source の undelivered(repo:slug, since = repo.addedAt)。jvn は `repo.jvnMinSeverity ?? config.jvnMinSeverity` 以上だけ
    - `items` は上の id の和集合（重複なし）
  - `dev-digest pending`: `runDir/pending.json` に書き、stdout に `file=<path>`、`items=<n>`、`repos=<n>`
  - `type DigestNote = { id: number; summaryJa: string; tags: string[] }`、`type DigestGroup = { key: string; titleJa: string; summaryJa: string; itemIds: number[] }`、`type DigestFile = { runId: number; notes: DigestNote[]; groups: DigestGroup[]; repos: Array<{ slug: string; itemIds: number[] }> }`
  - `validateDigest(value: Json, pending: PendingFile): { ok: true; digest: DigestFile } | { ok: false; errors: string[] }` — runId 一致、全 id が pending にある、repo の itemIds ⊆ その repo の candidateIds ∪ ownIds、group の itemIds は 1 件以上、1 つの id は 2 つの group に入らない

- [ ] **Step 1: 失敗するテストを書く**
- `PD1 JVN は全体のしきい値で globalIds を絞る`: critical と high の JVN、config=critical → globalIds に high が無い
- `PD2 リポジトリのしきい値が全体を上書きする`: repo.jvnMinSeverity=high → その repo の candidateIds に high がある
- `PD3 repo.addedAt より前に見つかった項目は repo に出さない`
- `PD4 Releases は ownIds に入り globalIds に入らない`
- `DG1 validateDigest は runId の不一致を拒む`、`DG2 candidate 外の id を repo に書くと拒む`、`DG3 同じ id を 2 つの group に入れると拒む`、`DG4 notes が欠けていても ok`（欠けは publish が補う）

- [ ] **Step 2〜4:** Run: `node --test test/unit/digest.test.ts test/pending.test.ts` / Expected: PASS
- [ ] **Step 5: コミット** — `git commit -m "feat(dev-digest): AI に渡す pending.json と AI の digest.json の検証を追加する"`

---

### Task 7: Slack のメッセージと publish

**Files:**
- Create: `lib/secrets.ts`, `lib/slack.ts`, `lib/commands/publish.ts`
- Test: `test/unit/slack.test.ts`, `test/unit/secrets.test.ts`, `test/publish.test.ts`

**Interfaces:**
- Consumes: `PendingFile`, `DigestFile`, `validateDigest`, `recordDelivery`, `saveNote`, `finishRun`
- Produces:
  - `lib/secrets.ts`: `type Secrets = { global: string | null; repos: Record<string, string> }`、`loadSecrets(file: string): Secrets`（無ければ空）、`saveWebhook(file: string, target: 'global' | string, url: string): void`（mode `0o600`。既存ファイルも chmod）、`isWebhookUrl(text: string): boolean`（`^https://hooks\.slack\.com/services/\S+$`）、`maskWebhook(url: string): string`（`https://hooks.slack.com/services/T***/…`。形が違えば `***`）、`maskSecrets(text: string, secrets: Secrets): string`（既知の URL と `hooks.slack.com/services/` 以降のパスをすべて伏せる）、`webhookFor(secrets: Secrets, slug: string | null): { url: string; viaGlobal: boolean } | null`
  - `lib/slack.ts`:
    - `renderGlobal(pending: PendingFile, digest: DigestFile, date: string): string[]` — 行の配列。見出し `☀️ <M/D> 開発速報（全体・<n> 件）`、`previousIncomplete` があれば先頭に `⚠️ 前回（<M/D>）の実行は完了しませんでした`、セクション順 `jvn` `aws` `gcp` `x` `devto`（見出し `🚨 脆弱性（JVN <しきい値> 以上）` `☁️ AWS` `☁️ Google Cloud` `🤖 X` `📰 dev.to`）、末尾に failures を `⚠️ 取得できなかったソース: <sourceId>（<reason>）`
    - group の置き場所: group 内で section が `jvn` `aws` `gcp` `releases` の最初の項目の section。無ければ `x`、それも無ければ `devto`。group の行は `• <titleJa> — <summaryJa>` の下に公式項目のリンク、X の項目は `言及: @a, @b ほか <n> 人` として各リンク付きで 1 行。group に入った項目は単独の行を出さない
    - note の無い項目は `• <title>（要約なし）` と url で出す（**全部載せる**）。updated の項目は先頭に `【追記】`。JVN は `CVSS <severity>` を付ける
    - `renderRepo(pending: PendingFile, digest: DigestFile, slug: string, date: string, viaGlobal: boolean): string[] | null` — 見出し `📦 [<displayName>] 関連（<n> 件）`。対象は digest の repo.itemIds ∪ ownIds。0 件なら null
    - `splitMessages(lines: string[], maxChars: number): string[]` — 行の途中で切らない。1 行が maxChars を越えるときだけその行を `…` で切る。2 通目以降の先頭に `（続き <k>/<n>）`
    - `escapeMrkdwn(text: string): string`（`&` `<` `>` を実体に）、リンクは `<url|title>`
    - `postWebhook(url: string, text: string): Promise<{ ok: boolean; status: number; error: string | null }>`（例外は捕まえ、error は呼び出し側で `maskSecrets` する）
  - `dev-digest publish --file <path>`: pending.json（`runDir`）と digest.json を読み検証（誤りは一覧を出して exit 3、何も送らない）→ notes を `saveNote` → 全体: `webhookFor(null)` が無ければ exit 2 → `splitMessages(renderGlobal(...), MAX_MESSAGE_CHARS)` を順に送る。全部 ok なら globalIds を `sent` で記録 → repo ごと: webhook は `webhookFor(slug)`（無ければ全体の webhook）、送れたら `itemIds ∪ ownIds` を `sent`、candidateIds の残りを `irrelevant` で記録。0 件の repo は送らずに candidateIds を `irrelevant` で記録 → 全送り先が ok なら `finishRun`。stdout は送り先ごとに `sent <destination> messages=<n>` か `failed <destination> status=<n> error=<masked>`、1 つでも失敗で exit 1

- [ ] **Step 1: 失敗するテストを書く**
- `SL1 splitMessages は行を割らず、続き番号を付ける`: 3500 を越える 100 行 → 各要素 ≤ 3500、連結すると全行が順に揃う、2 通目が `（続き 2/` で始まる
- `SL2 group は公式ソースのセクションに置かれ、X の言及が 1 行にまとまる`: aws 1 件 + x 3 件の group → AWS セクションに group、X セクションにその 3 件が出ない、`言及: @a, @b ほか 1 人`
- `SL3 note の無い項目は要約なしで出る`（Review Focus 5）
- `SL4 escapeMrkdwn`: `a<b>&c` → `a&lt;b&gt;&amp;c`
- `SC1 maskWebhook / maskSecrets`: `https://hooks.slack.com/services/T0/B0/xyz` は出力に `B0/xyz` を含まない、文章の途中に埋まった URL も伏せる
- `SC2 saveWebhook は 0600 で書く`: `statSync(file).mode & 0o777 === 0o600`
- `PB1 publish は全体 1 通とリポジトリ 1 通を送り送信済みを記録する`（ローカルサーバを webhook にする。secrets.json にサーバの URL を `https://hooks.slack.com/services/...` 形式で書けないため、テストでは環境変数 `DEV_DIGEST_WEBHOOK_OVERRIDE`（テスト専用。設定されていれば送信先 URL の origin を置き換える）で差し替える）
- `PB2 digest.json に書かれなかった pending 項目も全体に載る`（Review Focus 5）
- `PB3 全体 200・repo 500 なら全体だけ送信済み`（Review Focus 2）: 2 回目の pending で repo の項目だけが残る、exit 1、`finishRun` されない
- `PB4 検証に落ちた digest では何も送らない`: サーバへのリクエスト 0、exit 3
- `PB5 Slack が URL を含む 400 を返しても平文が出ない`（Review Focus 3）: 応答本文に webhook URL を入れる → stdout / stderr に `B0/xyz` が無い

- [ ] **Step 2〜4:** Run: `node --test test/unit/slack.test.ts test/unit/secrets.test.ts test/publish.test.ts` / Expected: PASS
- [ ] **Step 5: コミット** — `git commit -m "feat(dev-digest): 全体とリポジトリごとの Slack 通知を送る publish を追加する"`

---

### Task 8: Webhook の入力（set-webhook）

**Files:**
- Create: `lib/input.ts`, `lib/commands/set-webhook.ts`
- Test: `test/set-webhook.test.ts`

**Interfaces:**
- Consumes: `saveWebhook`, `isWebhookUrl`, `maskWebhook`, `loadRepos`
- Produces:
  - `readSecret(mode: 'dialog' | 'clipboard' | 'stdin', prompt: string): string | null` — dialog: `osascript -e 'display dialog "<prompt>" default answer "" with hidden answer with title "dev-digest"' -e 'text returned of result'`（キャンセルは null）。clipboard: darwin `pbpaste` / WSL `powershell.exe -NoProfile -Command Get-Clipboard` / それ以外 `wl-paste` → `xclip -o -selection clipboard`。stdin: 標準入力の全文。どれも trim
  - `dev-digest set-webhook --target <global|owner/repo> [--from-clipboard | --from-stdin]`: 既定は darwin なら dialog、それ以外は clipboard。target が global でも既知の slug でもなければ exit 2。値が `isWebhookUrl` でなければ「Slack の Incoming Webhook URL ではありません」と出して exit 1（値は出さない）。保存したら `saved target=<target> url=<maskWebhook>`。dialog が使えない（osascript が無い・失敗）ときは exit 4 と `fallback=clipboard` を出す（SKILL がクリップボード方式の案内に切り替える）

- [ ] **Step 1: 失敗するテストを書く**（`--from-stdin` で）
- `SW1 正しい URL を保存し伏せて表示する`: stdout に `saved target=global`、`B0/xyz` を含まない、secrets.json の global に保存
- `SW2 URL でない値は保存しない`: `hello` → exit 1、secrets.json が無い
- `SW3 誤った値も stdout / stderr に出さない`: `https://example.com/secret-token` → exit 1、出力に `secret-token` が無い（Review Focus 3）
- `SW4 未登録の slug は拒む`: exit 2

- [ ] **Step 2〜4:** Run: `node --test test/set-webhook.test.ts` / Expected: PASS
- [ ] **Step 5: 手で dialog を確かめる** — ユーザーに `! node apps/dev-digest/bin/dev-digest.ts set-webhook --target global` を DEV_DIGEST_HOME を一時ディレクトリにして実行してもらい、伏せ字のダイアログが出て保存されることを確かめる
- [ ] **Step 6: コミット** — `git commit -m "feat(dev-digest): Webhook URL を会話に出さずに登録する set-webhook を追加する"`

---

### Task 9: init（設定・ランチャー・Orca 登録）と permissions

**Files:**
- Create: `bin/launch.ts`, `lib/orca.ts`, `lib/permissions.ts`, `lib/commands/init.ts`, `lib/commands/permissions.ts`, `lib/commands/procedure.ts`, `skills/dev-digest/references/morning.md`, `test/fixtures/fake-orca.ts`
- Test: `test/init.test.ts`, `test/unit/launch.test.ts`

Task 1 の §13 で確かめた selector の形・JSON のフィールド名・permission のパスの書き方に従う。

**Interfaces:**
- Consumes: `loadConfig`, `saveConfig`, `homePaths`, `openDb`, defaults
- Produces:
  - `lib/orca.ts`: `orcaBin(): string`、`runOrca(args: string[]): { ok: boolean; json: Json | null; stderr: string }`（`--json` を付けて呼ぶ。stdin は ignore）
  - `bin/launch.ts`（自己完結・lib を import しない）: `resolvePluginRoot(home: string, claudeHome: string): string | null` — `<claudeHome>/plugins/installed_plugins.json` の `plugins['dev-digest@yui-cc-plugins']` の `scope: 'user'` の `installPath`（ディレクトリが在るとき）→ 無ければ `<home>/config.json` の `pluginRoot`（在るとき）→ null。main は `node <root>/bin/dev-digest.ts ...argv` を `stdio: 'inherit'` で起動し、env に `DEV_DIGEST_LAUNCHER_VERSION=<LAUNCHER_VERSION>` を足し、子の exit code で終える。null なら「dev-digest プラグインが見つかりません。init をやり直してください」で exit 2
  - `bin/dev-digest.ts` は `DEV_DIGEST_LAUNCHER_VERSION` が設定されていて `LAUNCHER_VERSION` と違えば stderr に「ランチャーが古い版です。init を再実行してください」を 1 行出す（処理は続ける）
  - `dev-digest init --time <HH:MM> --trigger <daily|weekdays> --jvn-min-severity <s> --x-list <url|none> --x-hashtags <csv> --devto-tags <csv> [--dry-run]`:
    1. `homePaths` のディレクトリを `0o700` で作り、config を保存（既存なら schedule など指定分だけ更新し `orca` の id は保つ）、`openDb`
    2. `bin/launch.ts` を `launcherScript` にコピーし、`launcher` に `#!/bin/sh\nexec node "<launcherScript の絶対パス>" "$@"\n` を `0o755` で書く。`pluginRoot` にこのプラグインの root を記録
    3. `runDir` を `orca repo add --path <runDir> --kind folder` で登録（登録済みの応答なら `orca repo list` から path で引く）→ `orca.workspaceSelector` を保存
    4. automationId が無ければ `orca automations create --name dev-digest --trigger <trigger> --time <time> --timezone Asia/Tokyo --provider claude --workspace <selector> --fresh-session --enabled --prompt <AUTOMATION_PROMPT（~ を実パスに）>`、あれば `orca automations edit <id> --trigger --time --timezone --prompt`
    5. stdout: `config=<path>`、`launcher=<path>`、`workspace=<selector>`、`automation=<id> (created|updated)`、`webhook_global=<registered|missing>`
    `--dry-run` は Orca を呼ばずに呼ぶはずの argv を `orca: <args>` で出す
  - `lib/permissions.ts`: `proposedRules(home: string): { project: { file: string; allow: string[] }; user: { file: string; deny: string[] } }` — project = `<runDir>/.claude/settings.json` に allow（ランチャーの実行、Task 1 で確かめた orca のブラウザ系コマンド、runDir の Read / Write / Edit）、user = `~/.claude/settings.json` に deny（secrets.json の Read / Edit）。`applyRules(file: string, key: 'allow' | 'deny', rules: string[]): number`（既存の JSON を保ち、`permissions[key]` に無いものだけ足し、足した数を返す）
  - `dev-digest permissions --show | --apply`: `--show` は足すルールと書き込み先を表示（秘密を含まない）、`--apply` は書いて `added project=<n> user=<n>`
  - `dev-digest procedure`: `skills/dev-digest/references/morning.md` を読み、`{{DEV_DIGEST}}` をランチャーの絶対パス、`{{RUN_DIR}}` を runDir、`{{X_LIST}}` `{{X_HASHTAGS}}` `{{X_MAX_POSTS_LIST}}` `{{X_MAX_POSTS_PER_HASHTAG}}` を config / defaults の値に置き換えて表示する
  - `references/morning.md`（英語）の手順: 1) `{{DEV_DIGEST}} collect` 2) X: `x_since` より新しいポストを、リストから最大 `{{X_MAX_POSTS_LIST}}` 件・各ハッシュタグの最新検索から最大 `{{X_MAX_POSTS_PER_HASHTAG}}` 件、Orca ブラウザ（`orca tab create --url` / `snapshot` / `scroll`）で読み `{{RUN_DIR}}/x.json` に書いて `ingest-x --file`。読めなければ `ingest-x --failed "<理由>"` 3) `pending` 4) `{{RUN_DIR}}/pending.json` を読み、全項目に 1〜2 文の日本語の要約とタグ、似た話題の group（ソースをまたぐ）、各 repo の関係する candidateIds を `digest.json` に書く（形式を例示）5) `publish --file {{RUN_DIR}}/digest.json`。検証の誤りが出たら直して再実行 6) 結果を 1 行で報告。**禁止: `~/.dev-digest/secrets.json` を読む・開く・grep する、Webhook URL を探す**

- [ ] **Step 1: 失敗するテストを書く**（`ORCA_BIN=node test/fixtures/fake-orca.ts` 相当。偽の orca は argv を `$FAKE_ORCA_LOG` に追記し、`repo add` / `automations create` / `automations edit` / `repo list` に Task 1 で記録した形の JSON を返す）
- `IN1 init は設定・ランチャー・workspace・automation を作る`: launcher が実行可能、config に workspaceSelector と automationId、偽 orca のログに `automations create` と `--timezone Asia/Tokyo` と `--provider claude`
- `IN2 2 回目の init は edit になり create しない`
- `IN3 automation のプロンプトに secrets も Webhook も含まない`: 事前に secrets.json に URL を入れておき、偽 orca のログに `hooks.slack.com` が無い
- `IN4 permissions --apply は既存の設定を保ち、重複を足さない`: 既存の allow 1 件 → 足した後も残る、2 回目は `added project=0 user=0`
- `LA1 resolvePluginRoot は installed_plugins.json を優先し、無ければ config の pluginRoot`: 一時ディレクトリで両方の場合と、installPath のディレクトリが消えていて pluginRoot に落ちる場合
- `IN5 procedure は置き換え後に {{ が残らない`

- [ ] **Step 2〜4:** Run: `node --test test/init.test.ts test/unit/launch.test.ts` / Expected: PASS
- [ ] **Step 5: コミット** — `git commit -m "feat(dev-digest): 設定・ランチャー・Orca automation を作る init と permission の提案を追加する"`

---

### Task 10: リポジトリの登録（repo）と履歴の検索（search）

**Files:**
- Create: `lib/commands/repo.ts`, `lib/commands/search.ts`
- Test: `test/repo.test.ts`, `test/search.test.ts`

**Interfaces:**
- Consumes: `saveRepo`, `loadRepos`, `removeRepo`, `loadSecrets`, `maskWebhook`, `search`
- Produces:
  - `dev-digest repo slug --path <dir>`: `git -C <dir> remote get-url origin` から `owner/repo`（https / ssh 両形式、`.git` を除く）、remote が無ければ `basename`。stdout `slug=<slug>`
  - `dev-digest repo save --file <candidate.json>`: candidate は `RepoConfig` から `addedAt` を除いた形。既存の slug なら `addedAt` を保ち差分（追加・削除されたパッケージ名）を `added=` `removed=` で出す。新規なら `addedAt = now`
  - `dev-digest repo list`: 1 行 1 件 `<slug>\t<path>\twebhook=<maskWebhook|global>\tjvn=<s>\tpackages=<n>`
  - `dev-digest repo show --slug <s>`: repo の JSON（秘密を含まない）
  - `dev-digest repo remove --slug <s>`: repos から消し secrets の repos[slug] も消す
  - `dev-digest search [--q <text>] [--since <YYYY-MM-DD>] [--until <YYYY-MM-DD>] [--section <csv>] [--repo <slug>] [--min-severity <s>] [--limit <n, 既定 50>]`: `SearchHit[]` を JSON で stdout

- [ ] **Step 1: 失敗するテストを書く**
- `RP1 slug は https と ssh の remote から owner/repo を作る`（一時 git repo で `git remote add origin git@github.com:o/r.git` と `https://github.com/o/r.git`）
- `RP2 remote の無いディレクトリは basename`
- `RP3 save の 2 回目は addedAt を保ち差分を出す`
- `RP4 list は Webhook を伏せる`（Review Focus 3）: 出力に URL の末尾が無い
- `SE1 search は q・期間・section・repo で絞った JSON を返す`: 2 件入れて `--q keycloak --section jvn` で 1 件、`--repo a/a` は repo:a/a に送った項目だけ

- [ ] **Step 2〜4:** Run: `node --test test/repo.test.ts test/search.test.ts` / Expected: PASS
- [ ] **Step 5: コミット** — `git commit -m "feat(dev-digest): 監視リポジトリの登録と履歴の検索を追加する"`

---

### Task 11: SKILL.md・文書・実機での通し確認

**Files:**
- Create: `skills/dev-digest/SKILL.md`, `skills/dev-digest/references/guide-ja.md`, `skills/dev-digest/references/morning-ja.md`, `README.md`, `CLAUDE.md`
- Modify: ルート `CLAUDE.md` の Apps 表に `apps/dev-digest` の行を追加（「Plugin (skill + TS scripts) / TypeScript (node で直接実行) / 毎朝の開発速報を Slack に送り、履歴を SQLite に残す」）、「Plugin-specific guidance」に `apps/dev-digest/CLAUDE.md` を追加

**SKILL.md の内容**（英語。frontmatter の `description` は日本語可で、トリガー語「開発速報」「dev-digest」「毎朝のダイジェスト」「リポジトリを監視」「履歴を検索」を含める）:
- `## Output Language` ブロック（一字一句）
- 冒頭で `PLUGIN` を `${CLAUDE_PLUGIN_ROOT}` で定義し、CLI は `node "$PLUGIN/bin/dev-digest.ts"`
- **init**: AskUserQuestion で 時刻 / daily か weekdays / JVN のしきい値（既定 critical）/ X のリスト URL / ハッシュタグ（既定を提示）/ dev.to タグ（既定を提示）を尋ねる → `init` → `set-webhook --target global`（exit 4 なら「URL をクリップボードにコピーして `! <launcher> set-webhook --target global --from-clipboard` を実行してください」と案内して待つ）→ `permissions --show` の内容を見せて承認されたら `--apply` → Orca のブラウザで X にログインするよう案内 → 承認されたら `orca automations run <id>`
- **setup**（対象リポジトリで）: `repo slug` → 依存定義・compose・Dockerfile・Helm・k8s・Terraform を読んで候補を作る（直接依存とインフラの OSS だけ。GitHub の owner/repo を推定）→ 表で見せて追加・削除 → JVN のしきい値を尋ねる → candidate JSON を `run/` ではなく一時ファイルに書いて `repo save` → `set-webhook --target <slug>`（登録しない選択も可。その場合は全体に送る）
- **search**: 質問から期間・section・repo・しきい値・語を決めて `search` を呼び、結果を表で答える。リンクを付ける
- **list / remove**
- **禁止**: `~/.dev-digest/secrets.json` を読む・開く・grep する、Webhook URL をユーザーに尋ねる・会話に書く
- 毎朝の手順は SKILL.md に書かず `references/morning.md` を正本にする（procedure がそれを出す）

- [ ] **Step 1: 文書を書く**（guide-ja.md は SKILL.md と見出し 1:1。README はできること・前提（Orca・Node 24.15 以上・Slack Incoming Webhook）・init / setup / search の使い方・秘密の扱いの限界（spec §8 の「限界」を言い換えずに要約）。CLAUDE.md はこのプラグイン固有の約束: ランチャーと LAUNCHER_VERSION、テスト専用の環境変数 3 つ、秘密を出さない規則と `maskSecrets` を通す場所、morning.md が毎朝の手順の正本）
- [ ] **Step 2: 検査を通す** — Run: `pnpm check && cd apps/dev-digest && bash test/run-all.sh` / Expected: `check-doc-lang: OK`、全テスト PASS
- [ ] **Step 3: 実機で通す**（ユーザーと一緒に）— `bash install.sh` か `claude plugin marketplace update yui-cc-plugins && claude plugin install dev-digest@yui-cc-plugins` → このリポジトリで `/dev-digest` の init → setup → `orca automations run <id>` → Slack に全体 1 通とこのリポジトリの 1 通が届く、`~/.dev-digest/bin/dev-digest search --q aws --limit 5` が結果を返す、会話のログに Webhook URL が出ていない
- [ ] **Step 4: コミット**

```bash
git add apps/dev-digest CLAUDE.md
git commit -m "feat(dev-digest): skill と文書を追加し、0.1.0 にする"
```
