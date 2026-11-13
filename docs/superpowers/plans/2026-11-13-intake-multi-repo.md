# slack-issue-intake の複数リポジトリと定期報告（部分 B2）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** slack-issue-intake を、複数の organization・リポジトリへの起票、Slack から作っていない Issue の管理、`--auto` の定期報告の投稿に対応させる。

**Architecture:**
- config は 1 つの `repo` から `repos`（リポジトリごとの設定の一覧）と `defaultRepo` に広げる。0.4 の config も読めるようにする。
- DB は Issue を `(repo, 番号)` で持つ。submissions には `repo` 列を足し、`issue_status` は `(repo, issue_number)` を主キーにした表へ移す。
- 既存の Issue の管理は、新しい表 `adopted`（スレッドを立てた Issue）に持つ。通知の対象は「submissions の Issue」と「adopted の Issue」を合わせたもの。
- 定期報告は `--auto` が書く JSON を poll が読み、1 つの投稿を書き換え続け、1 日 1 回は新しい投稿にする。

**Tech Stack:** TypeScript（Node 24.15 以上の型除去で直接実行）、node:sqlite、gh CLI、Slack Web API、node --test。

**Spec:**
- `docs/superpowers/specs/2026-11-13-auto-dispatch-additions-design.md` の 5.3、7 章、10 章（以下「追加の設計」）
- 元の設計 `docs/superpowers/specs/2026-11-12-issue-auto-dispatch-design.md` の 5 章

## Global Constraints

- Issue はどこでも `owner/repo#番号` で呼ぶ。番号だけで Issue を探す・比べる所を残さない（追加の設計 9 章）。
- 管理の印のラベル（追加の設計 5.3）:
  - `from-slack`: フォームから起票したもの（今のまま）。
  - `slack-thread`（新規）: スレッドを立てて管理に入れたもの。
  - どちらも、受け付けるリポジトリすべてに作る。
- 既存の Issue の扱いは、リポジトリごとに `thread` か `skip`（追加の設計 7.3。ユーザーの決定）。
- 定期報告は、普段は 1 つの投稿を書き換え（`chat.update`）、1 日 1 回は新しい投稿にする（ユーザーの決定）。報告のチャンネルの既定は起票のチャンネル、1 日 1 回の時刻の既定は `09:00`。
- 自分のトップレベルの投稿を `[issue-intake]` で始めない。poll が自分の投稿でもマーカーで始まるものをフォームの投稿として受け付けるため。
- 外部へ出す文字列は `maskSecrets` を通す。Slack に出す Issue の題名は `escapeMrkdwn` も通す。DB の書き込みはリースの下でフェンス付き。すべての gh / Slack 呼び出しに deadline を渡す。
- `apps/slack-issue-intake/CLAUDE.md` のユーザーの未コミットの変更（`MSG_FORM\_*` のエスケープと末尾の改行）をコミットに入れない。この計画でこのファイルを変えるときは、HEAD の写しに自分の変更だけを当てて `git update-index` で stage する（C1 と同じ方法）。
- 型検査と lint は `../../node_modules/.bin/tsc --noEmit -p .` と `../../node_modules/.bin/biome check ./bin ./lib ./skills ./test`（この環境では pnpm が mise の shim で動かない）。テストは `bash test/run-all.sh`。
- バージョンは 0.5.0（plugin.json とルートの marketplace.json）。
- ワークフローの入力は、0.4.1 で入った v1 の形（`input_parameters` を名前ごとに `type` / `is_required`）を保つ。Slack CLI 4.13 の deploy は既存アプリのマニフェストにマージし、v1 として検証するため。

## 私が決めたこと（計画の段階）

- **config の形**:
  - `repos: Array<{ name: string; form: boolean; existing: 'thread' | 'skip' }>`
  - `defaultRepo: string`
  - `report: { channel: string | null; dailyAt: string; source: string | null }`
  - 0.4 の `repo: string` は、`repos: [{ name: repo, form: true, existing: 'skip' }]`、`defaultRepo: repo` として読む。保存は新しい形で書く。
  - `report` が無ければ `{ channel: null, dailyAt: '09:00', source: null }`。`channel: null` は起票のチャンネル、`source: null` は報告しないという意味。
- **送り先の変更**: チャンネルは今のとおり変えられない。リポジトリは足せるが、外せない（外すと、そのリポジトリの管理中の Issue の通知が宙に浮くため）。`defaultRepo` は一覧の中で変えられる。
- **init の引数**: `--repo` を複数回渡せるようにし（`parseArgs` の `multiple`）、`--default-repo` を足す。1 つだけなら `--default-repo` は省略可。
- **フォームのリポジトリの欄**: `form: true` のリポジトリが 2 つ以上あるときだけ、3 つのフォームそれぞれに任意の選択欄「リポジトリ」を足す。投稿には `*リポジトリ:* <値>` の 1 行を `*優先度:*` の次に足す。
  - 空なら `defaultRepo`。
  - 一覧に無い値は、不備として返信する（手で作ったフォームの打ち間違いのため）。
  - リポジトリの欄は config で変わるので、マニフェストとその指紋は config の一覧から作る。
  - deploy フックは、config があればその一覧で指紋を書く。
  - setup は、指紋が変わっていれば、init のあとにもう一度 deploy する。
- **既存の Issue の取り込みの順番**:
  1. DB に「立てる予定」の行を書く。
  2. Slack に投稿して ts を記録する。
  3. `slack-thread` を付ける。
  - 落ちても、次の poll が ts の無い行の投稿からやり直す。投稿の直後に落ちた場合だけ、同じ投稿が 1 回重なる。
  - 1 回の poll で立てる数は `ADOPT_MAX_PER_POLL = 5`。
  - 対象: 開いていて、`from-slack` も `slack-thread` も付いていない、pull request でない Issue のうち、次のどちらか。
    - そのリポジトリを `thread` にした時刻（meta `adopt_after:<repo>`）より後に作られたもの。
    - ステータスラベルが付いているもの。
- **報告の材料の JSON**（`--auto` との約束。両方のテストで同じ例を使う）:
  ```json
  { "version": 1, "name": "main", "updatedAt": "2026-11-13T05:30:00Z", "everyMinutes": 5,
    "running": [{ "issue": "orgA/app#42", "title": "ログインできない", "host": "Mac M2max", "startedAt": "2026-11-13T04:55:00Z", "limitMinutes": 60 }],
    "queue": [{ "issue": "orgA/app#51", "title": "決済が落ちる", "priority": "critical" }],
    "hosts": [{ "name": "Mac M2max", "used": 2, "max": 2, "reachable": true }] }
  ```
  - 例は `test/fixtures/auto-report.json` に置き、`apps/orca-team-dispatch-task/test/fixtures/auto-report.json` にも同じものを写す。`scripts/check-shared-contracts.mjs` が 2 つの一致を確かめる。
  - 古いとみなすのは、`updatedAt` から `everyMinutes × 3` 分を過ぎたとき。
  - 書き換えるかどうかは、描いた文の SHA-256 を meta `report_hash` に持って決める。文が変わらなければ `chat.update` を呼ばない。
- **1 日 1 回の判定**: その Mac のローカル時刻で `dailyAt` を過ぎていて、meta `report_day`（`YYYY-MM-DD`）が今日でなければ、新しく投稿する。`chat.update` が `message_not_found` を返したときも、新しく投稿する。
- **poll の中の順番**: 取り込み（sync）→ ステータスの通知 → 既存の Issue の取り込み → 定期報告。あとの 3 つは、残り時間が `STATUS_MIN_REMAINING_MS` 以上あるときだけ行い、失敗しても終了コードは変えない（部分 B と同じ）。
- **setup の段**: 10 段にする。4 段目でリポジトリの一覧と既定と各リポジトリの設定を聞き、7 段目に「定期報告」を足す。順番は次のとおり。
  1. 事前の確認
  2. アプリ
  3. チャンネル
  4. リポジトリと間隔
  5. init
  6. メンション
  7. 定期報告
  8. フォーム
  9. 承認
  10. 有効化

## Review Focus

1. **0.4 の config と DB のまま更新し、setup を走らせる前の poll。** 起票も通知もこれまでどおり動く。`repo` 列が空の古い行は `defaultRepo` とみなす。Task 1 の CF4 と Task 2 の DB11 で確かめる。
2. **別のリポジトリに同じ番号の Issue がある。** 通知もステータスの記録も取り違えない。Task 2 の DB12 と Task 4 の ST12 で確かめる。
3. **リポジトリの欄を空のまま送ったフォーム。** 既定の起票先に作られる。一覧に無い値を入れた手作りのフォームは、不備として返信される。Task 3 の PA22 と PO28 で確かめる。
4. **開いている古い Issue が数百あるリポジトリを `thread` にした。** ステータスラベルの付いたものだけが、1 回 5 件ずつ取り込まれる。Task 5 の AD2 で確かめる。
5. **報告の材料が古い（`--auto` が止まっている）、または投稿が人に消された。** 報告に「止まっています」と出る。消された投稿は新しく投稿し直す。Task 6 の RP3 と RP4 で確かめる。

---

### Task 1: config を複数リポジトリにし、init でリポジトリごとにラベルを作る

**Files:**
- Modify: `apps/slack-issue-intake/lib/config.ts`（`repos` / `defaultRepo` / `report`、0.4 の形の読み込み）
- Modify: `apps/slack-issue-intake/lib/commands/init.ts`
  - `--repo` を複数回、`--default-repo`。
  - 送り先の検査を「チャンネルは同じ、リポジトリは足すだけ」にする。
  - リポジトリごとの `repoInfo` / `ensureLabels` / `labels_hash:<repo>`。
  - `adopt_after:<repo>` を、そのリポジトリの `existing` が `thread` で、まだ記録が無いときに書く。
- Modify: `apps/slack-issue-intake/lib/defaults.ts`
  - `LABEL_SPECS` に `slack-thread` を足す（色 `6f42c1`、説明 `slack-issue-intake が Slack のスレッドで管理している Issue`）。
  - `ADOPTED_LABEL = 'slack-thread'`、`META_LABELS_HASH` をリポジトリ付きのキーにする関数 `labelsHashKey(repo: string): string`。
- Modify: `apps/slack-issue-intake/lib/drive.ts`（Backlog を付けるかの判定を `labelsHashKey(repo)` で行う）
- Modify: `apps/slack-issue-intake/lib/commands/status.ts`（`repo=` は一覧を `,` でつないで出す）
- Test: `test/unit/config.test.ts`、`test/init.test.ts`、`test/poll.test.ts`（PO27 の meta のキー）

**Interfaces:**
- Produces（`config.ts`）:
  - `type RepoSetting = { name: string; form: boolean; existing: 'thread' | 'skip' }`
  - `type ReportSetting = { channel: string | null; dailyAt: string; source: string | null }`
  - `Config` から `repo` を外し、`repos: RepoSetting[]`、`defaultRepo: string`、`report: ReportSetting` を足す。
  - `formRepos(config: Config): string[]`（`form: true` の名前）
  - `repoSetting(config: Config, name: string): RepoSetting | null`
- Produces（`defaults.ts`）: `ADOPTED_LABEL`、`labelsHashKey(repo: string): string`（`labels_hash:<repo>`）
- `loadConfig` の検査:
  - `repos` が空でない。
  - 名前が `REPO_PATTERN` に合い、重ならない。
  - `defaultRepo` が一覧にある。
  - `dailyAt` が `HH:MM`（00:00〜23:59）。
  - 違えば null（今の「読めない設定」と同じ扱い）。
- 0.4 の `labels_hash`（キーにリポジトリ無し）は、`defaultRepo` の指紋として読む（drive の判定で、新しいキーが無ければ古いキーも見る）。

- [ ] **Step 1: 失敗するテストを書く**
  - `CF4 0.4 の config（repo だけ）は repos 1 つと defaultRepo として読め、保存すると新しい形になる`
    - 読んだ値:
      - `repos` が `[{ name: 'acme/app', form: true, existing: 'skip' }]`
      - `defaultRepo` が `'acme/app'`
      - `report` が `{ channel: null, dailyAt: '09:00', source: null }`
    - 保存し直したファイルに `repo` キーが無く、`repos` がある。
  - `CF5 repos の名前の重複、defaultRepo が一覧に無い、dailyAt が 24:00 のときは読めない設定として null`
  - `IN15 --repo を 2 回渡すと両方のリポジトリでラベルを作り、それぞれの labels_hash を残す`
    - fake-gh のログに `label create` が両方の `--repo` で出る。
    - `getMeta(db, 'labels_hash:acme/app')` と `getMeta(db, 'labels_hash:acme/web')` が `labelsHash()`。
    - `--default-repo` を省くと、2 つ以上のときは exit 2。
  - `IN16 既存の設定にリポジトリを足すのは通り、外すのとチャンネルを変えるのは送り先の変更として止まる`
  - `IN17 existing が thread のリポジトリは、初めて足したときだけ adopt_after:<repo> を残す`
    - init に `--existing acme/web=thread`（後述）を渡す。2 回目の init では値が変わらない。
  - init の引数 `--existing <repo>=<thread|skip>`（複数回）と `--hide-form <repo>`（複数回）を足す。setup が渡す。
- [ ] **Step 2: 走らせて失敗を見る**
  - Run: `node --test test/unit/config.test.ts test/init.test.ts`
  - Expected: 新しいテストが FAIL。既存の init テストも、`repo` が無くなるので型か値で FAIL するものが出る。直すのは Step 3。
- [ ] **Step 3: 実装する**
  - `config.repo` を使う所（`grep -rn "config\.repo"`）をすべて直す。
    - drive の起票は Task 2 でリポジトリ別にする。この Task では `defaultRepo` を使う。
    - status-sync は Task 4 で直す。この Task では `defaultRepo` を使う。
  - `test/helpers.ts` の `setupHome` と、`test/unit/secrets.test.ts` の config の例を新しい形にする。
- [ ] **Step 4: 走らせて通るのを見る**
  - Run: `bash test/run-all.sh` と型と lint
  - Expected: 全件 PASS。
- [ ] **Step 5: コミット** `feat(slack-issue-intake): 受け付けるリポジトリを複数持てるようにし、リポジトリごとにラベルを作る`

### Task 2: DB を `(repo, 番号)` で持ち、起票を submission のリポジトリへ送る

**Files:**
- Modify: `apps/slack-issue-intake/lib/db.ts`
  - submissions に `repo TEXT` 列を足す（`ALTER TABLE ... ADD COLUMN`。列が無いときだけ）。
  - `issue_status` を、主キーが `(repo, issue_number)` の新しい表 `issue_status2` へ移す。
    - 古い表があれば、行を `defaultRepo` で写して古い表を消す。
    - 移し替えは `openDb` ではなく、config を持つ `openRuntime` で 1 回だけ行う（`migrateIssueStatus(db, defaultRepo)`）。
  - 新しい表 `adopted(repo TEXT, issue_number INTEGER, channel TEXT NOT NULL, ts TEXT, title TEXT NOT NULL, url TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(repo, issue_number))` を作る（Task 5 が使う）。
- Modify: `apps/slack-issue-intake/lib/runtime.ts`（移し替えを呼ぶ）
- Modify: `apps/slack-issue-intake/lib/types.ts`（`SubmissionFields` に `repo: string | null`）
- Modify: `apps/slack-issue-intake/lib/drive.ts`（起票と、マーカーでの採用の照合を `s.repo ?? config.defaultRepo` で行う）
- Modify: `apps/slack-issue-intake/lib/issue-body.ts`（マーカーは今のまま。リポジトリはマーカーに入れない。マーカーで探すのは、そのリポジトリの一覧の中だけなので）
- Test: `test/unit/db.test.ts`、`test/poll.test.ts`

**Interfaces:**
- Produces:
  - `Submission.repo: string | null`（null は `defaultRepo`）
  - `IssueStatusRow` に `repo: string` を足す。`getIssueStatus(db, repo, issueNumber)`。
  - `saveIssueStatus` / `transitionWithStatus` の行に `repo` を含める。
  - `trackedIssues(db: Db, defaultRepo: string): Map<string, TrackedIssue>`
    - キーは `owner/repo#番号`。submissions と、`adopted` の ts のある行を合わせる。
    - `TrackedIssue` に `repo: string`、`number: number` を足す。
  - `issueKey(repo: string, number: number): string`（`${repo}#${number}`）を `db.ts` に置く。
  - `migrateIssueStatus(db: Db, defaultRepo: string): void`

- [ ] **Step 1: 失敗するテストを書く**
  - `DB11 0.4 の DB（repo 列の無い submissions と古い issue_status）を開くと、列が足され、行が defaultRepo で移る`
    - 古い形の表を手で作った DB を `openRuntime` 相当で開く。
    - `getIssueStatus(db, 'acme/app', 42)` が元の値。古い表は無い。2 回開いても重ならない。
  - `DB12 別のリポジトリの同じ番号は別の行で、trackedIssues のキーも別`
  - `PO29 フォームで選ばれたリポジトリ（submission の repo）に起票し、Backlog の判定もそのリポジトリの指紋で行う`
    - `seedSubmission` に `repo: 'acme/web'` を渡す。fake-gh の `issue create` の `--repo` が `acme/web`。
- [ ] **Step 2: 走らせて失敗を見る**
  - Run: `node --test test/unit/db.test.ts test/poll.test.ts`
  - Expected: FAIL。
- [ ] **Step 3: 実装する**（Interfaces のとおり）
- [ ] **Step 4: 走らせて通るのを見る**
  - Run: `bash test/run-all.sh` と型と lint
  - Expected: 全件 PASS。
- [ ] **Step 5: コミット** `feat(slack-issue-intake): Issue をリポジトリと番号の組で持ち、選ばれたリポジトリへ起票する`

### Task 3: フォームのリポジトリの欄

**Files:**
- Modify: `apps/slack-issue-intake/lib/defaults.ts`
  - `FIELD_LABELS.repo = 'リポジトリ'`
  - `PROBLEM_REPO = 'リポジトリは次のどれかにしてください: {options}'`
- Modify: `apps/slack-issue-intake/lib/form-message.ts`（`renderKindMessage(kind, slot, withRepo: boolean)`。`withRepo` なら優先度の次に `*リポジトリ:* {slot('repo')}`）
- Modify: `apps/slack-issue-intake/lib/form.ts`
  - `formWorkflow(kind, repos: string[])`: 2 つ以上なら任意の `repo` の欄（`enum` は一覧）を足し、必須には入れない。
  - `formManifestObject(repos)`、`renderFormManifest(repos)`。
- Modify: `apps/slack-issue-intake/lib/slack-cli.ts`（`manifestHash(repos: string[])`）
- Modify: `apps/slack-issue-intake/lib/commands/slack-hook.ts`、`lib/commands/form.ts`、`lib/commands/setup.ts`（`formRepos(config)` を渡す。config が無ければ `[]`）
- Modify: `apps/slack-issue-intake/lib/parse.ts`
  - ヘッダーに `リポジトリ` を足す。
  - `parseSubmission(text, fallbackUserId, repos: readonly string[])`: 値が空なら `repo: null`、一覧にあれば `repo: <値>`、無ければ `PROBLEM_REPO` の不備。比べるときは大文字小文字を区別しない。
- Modify: `apps/slack-issue-intake/lib/guide.ts`（手で作る手順のテンプレート）
- Modify: `apps/slack-issue-intake/lib/sync.ts`（`parseSubmission` に、config の `repos` の名前を渡す）
- Test: `test/unit/parse.test.ts`、`test/unit/form.test.ts`、`test/poll.test.ts`、`test/form.test.ts`

- [ ] **Step 1: 失敗するテストを書く**
  - `FM6 form の一覧が 1 つならリポジトリの欄は無く、2 つ以上なら任意の選択欄が 3 つのフォームすべてに付く`
    - 欄の `enum` が一覧と同じ。`required` に `repo` が無い。
    - 投稿の文に `*リポジトリ:* {{steps.0.fields.repo}}` がある。
    - `input_parameters` は v1 の形のまま（`is_required`）。
  - `FM7 manifestHash はリポジトリの一覧で変わる`
  - `PA22 リポジトリの行が空なら repo は null、一覧にあれば正規の名前、無ければ不備`
    - `kindText` に `*リポジトリ:*` の行を足す引数を足す。
    - 大文字小文字だけ違う値（`ACME/Web`）は、一覧の名前（`acme/web`）に揃える。
  - `PO28 一覧に無いリポジトリの投稿は、Claude を起こさずに不備として返信する`
- [ ] **Step 2: 走らせて失敗を見る**
  - Run: `node --test test/unit/parse.test.ts test/unit/form.test.ts test/poll.test.ts`
  - Expected: FAIL。
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 走らせて通るのを見る**
  - Run: `bash test/run-all.sh` と型と lint
  - Expected: 全件 PASS。DO1 / DO4（README とガイドの一致）が落ちたら、README のガイドの節を `renderGuide()` の出力で更新する。
- [ ] **Step 5: コミット** `feat(slack-issue-intake): フォームで起票先のリポジトリを任意で選べるようにする`

### Task 4: ステータスの通知を全リポジトリに広げる

**Files:**
- Modify: `apps/slack-issue-intake/lib/status-sync.ts`
  - リポジトリごと、印のラベル（`from-slack` と `slack-thread`）ごとに一覧を読む。
  - 読む位置は meta `status_cursor:<repo>:<label>`。0.4 の `status_cursor` は `defaultRepo` の `from-slack` として読む。
  - Issue は `issueKey` で `trackedIssues` を引く。
  - コメントの API も、その Issue のリポジトリで呼ぶ。
- Modify: `apps/slack-issue-intake/lib/issue-status.ts`（通知の文の `{issue}` は URL のまま。変更なし）
- Modify: `apps/slack-issue-intake/test/fixtures/fake-gh.ts`（一覧の API を `repos/<repo>/issues` の `<repo>` で絞る。今は全件を返している）
- Test: `test/status-sync.test.ts`

- [ ] **Step 1: 失敗するテストを書く**
  - `ST12 別のリポジトリの同じ番号の Issue は、それぞれのスレッドへ書き、取り違えない`
    - submissions に `acme/app#42` と `acme/web#42` を作る。web の方だけラベルを Ready にする。
    - 書き込みは web の submission の `thread_ts` だけ。
  - `ST13 slack-thread の Issue（adopted の行）の変化も、そのスレッドへ書く`
    - `adopted` に行を直接入れ、その Issue のラベルを変える。
  - `ST14 0.4 の status_cursor を持つ DB では、defaultRepo の from-slack の位置として続きから読む`
- [ ] **Step 2: 走らせて失敗を見る**
  - Run: `node --test test/status-sync.test.ts`
  - Expected: FAIL。
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 走らせて通るのを見る**
  - Run: `bash test/run-all.sh` と型と lint
  - Expected: 全件 PASS。
- [ ] **Step 5: コミット** `feat(slack-issue-intake): ステータスの通知を受け付けるリポジトリすべてと、スレッドで管理する Issue に広げる`

### Task 5: Slack から作っていない Issue をスレッドで管理に入れる

**Files:**
- Create: `apps/slack-issue-intake/lib/adopt.ts`
- Modify: `apps/slack-issue-intake/lib/commands/poll.ts`（ステータスの通知のあとに呼ぶ。残り時間と終了コードの扱いは部分 B と同じ）
- Modify: `apps/slack-issue-intake/lib/defaults.ts`
  - `ADOPT_MAX_PER_POLL = 5`
  - `MSG_ADOPTED = '📌 この Issue をスレッドで管理します: {repo}#{number} {title}\n{url}\nステータス: {status}'`
  - `adoptAfterKey(repo: string): string`
- Test: `test/adopt.test.ts`（新規。poll を通して試す）

**Interfaces:**
- Consumes:
  - Task 2: `adopted` の表、`trackedIssues`、`saveIssueStatus`。
  - Task 1: `repoSetting`、`adoptAfterKey`、`ADOPTED_LABEL`。
  - 部分 B: `currentStatus`。
- Produces: `adoptExisting(ctx: DriveContext): Promise<{ adopted: number; errors: string[] }>`
- 流れ（リポジトリ `existing: 'thread'` ごと）:
  1. ts の無い `adopted` の行（前の回の途中で落ちたもの）から先に投稿する。
  2. `gh api 'repos/<repo>/issues?state=open&sort=created&direction=desc&per_page=100'` を読み、対象（「私が決めたこと」の条件）を選ぶ。pull request は除く。
  3. 1 件ずつ、次の順で進める。合計が `ADOPT_MAX_PER_POLL` に達したら止める。
     - フェンス付きで `adopted` に ts の無い行を入れる。
     - 起票のチャンネルにトップレベルで `MSG_ADOPTED` を投稿する。題名は `escapeMrkdwn` と `maskSecrets` を通す。
     - ts を記録する。
     - `gh issue edit <n> --repo <repo> --add-label slack-thread` を打つ。
     - `issue_status` に今のステータスを記録する。通知は出さない。
- 出力: poll の結果の行に `adopted=N` を足す。

- [ ] **Step 1: 失敗するテストを書く**
  - `AD1 thread のリポジトリで印の無い新しい Issue は、投稿と slack-thread で管理に入り、次のラベルの変化がそのスレッドへ書かれる`
  - `AD2 adopt_after より前の Issue は、ステータスラベルのあるものだけ、1 回 5 件まで取り込む`
    - 古い Issue 12 件のうち 7 件に Ready を付ける。
    - 1 回目は 5 件、2 回目は 2 件。ラベルの無い 5 件は取り込まない。
  - `AD3 skip のリポジトリと、from-slack / slack-thread の付いた Issue は取り込まない`
  - `AD4 投稿のあと ts を記録する前に落ちた行（ts の無い行）は、次の回に投稿し直す`
  - `AD5 自分の投稿は [issue-intake] で始まらず、poll がフォームの投稿として取り込まない`
- [ ] **Step 2: 走らせて失敗を見る**
  - Run: `node --test test/adopt.test.ts`
  - Expected: FAIL（モジュールが無い）。
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 走らせて通るのを見る**
  - Run: `bash test/run-all.sh` と型と lint
  - Expected: 全件 PASS。
- [ ] **Step 5: コミット** `feat(slack-issue-intake): Slack から作っていない Issue を、リポジトリの設定に応じてスレッドで管理に入れる`

### Task 6: `--auto` の定期報告を投稿する

**Files:**
- Create: `apps/slack-issue-intake/lib/report.ts`
- Create: `apps/slack-issue-intake/test/fixtures/auto-report.json`（「私が決めたこと」の例）
- Create: `apps/orca-team-dispatch-task/test/fixtures/auto-report.json`（同じ内容の写し）
- Modify: `scripts/check-shared-contracts.mjs`（`auto-report.json` の 2 つの写しを比べる。`slack-thread` のラベル名も、orca 側の C2 で定義ができたら比べる対象に足す、と注記する）
- Modify: `apps/slack-issue-intake/lib/slack-api.ts`（`updateMessage(c, channel, ts, text, deadline)` を足す。`chat.update`、`maskSecrets`）
- Modify: `apps/slack-issue-intake/lib/commands/poll.ts`（既存の Issue の取り込みのあとに呼ぶ）
- Modify: `apps/slack-issue-intake/lib/defaults.ts`（報告の文言、`REPORT_STALE_FACTOR = 3`、meta のキー `report_ts` / `report_day` / `report_hash`）
- Test: `test/unit/report.test.ts`、`test/report.test.ts`（poll を通して）

**Interfaces:**
- Produces:
  - `readReport(path: string): AutoReport | null`（形が違えば null）
  - `renderReport(report: AutoReport, now: Date): string`
    - 見出しの時刻、実行中、キュー、マシンの空きを書く。
    - 古ければ先頭に「⚠ `--auto` が止まっています（最後の更新 HH:MM）」を足す。
    - 題名は `escapeMrkdwn` を通す。
  - `postReport(ctx: DriveContext): Promise<{ posted: 'new' | 'updated' | 'unchanged' | 'off'; errors: string[] }>`
- 文の形（追加の設計 7.2 の例）:
  - 1 行目 `📋 自動実行の状況（M/D HH:MM）`
  - `実行中 N件`
    - 各行 `• <issue> <title> … <host>・<経過>分 / 上限<limit>分`
  - `キュー N件`
    - 各行 `<順>. [<priority>] <issue> <title>`。11 件目以降は `ほか N件`。
  - `空き: <name> <used>/<max>・…`
    - つながらないマシンは `<name> つながらない`。
  - `report.source` が null なら何もしない（`off`）。

- [ ] **Step 1: 失敗するテストを書く**
  - `RP1 renderReport は例の材料から、実行中・キュー・空きの行を書き、題名の < > & を無効にする`
  - `RP2 dailyAt を過ぎた最初の回は新しく投稿し、その日の以後の回は同じ投稿を書き換え、文が同じなら呼ばない`
    - `--now` を 08:55 → 09:05 → 09:10（材料を変える）→ 09:15（材料そのまま）の順で poll する。
    - 呼び出しは `chat.postMessage` → `chat.postMessage`（その日の最初）→ `chat.update` → なし。
    - 08:55 の 1 回目は、まだ投稿が無いので新しく投稿する。
  - `RP3 updatedAt が everyMinutes × 3 分より古ければ、止まっていると書く`
  - `RP4 chat.update が message_not_found なら、新しく投稿して ts を置き換える`
  - `RP5 材料のファイルが無い・壊れているときは投稿せず、errors に 1 つ入れるが終了コードは変えない`
  - ルートで `node scripts/check-shared-contracts.mjs` が OK。片方の写しを 1 文字変えると exit 1（確かめたら戻す）。
- [ ] **Step 2: 走らせて失敗を見る**
  - Run: `node --test test/unit/report.test.ts test/report.test.ts`
  - Expected: FAIL。
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 走らせて通るのを見る**
  - Run: `bash test/run-all.sh`、型と lint、ルートで `node scripts/check-shared-contracts.mjs`
  - Expected: 全件 PASS、OK。
- [ ] **Step 5: コミット** `feat(slack-issue-intake): --auto の定期報告を、1 つの投稿の書き換えと 1 日 1 回の新しい投稿で知らせる`

### Task 7: setup をリポジトリの一覧と定期報告に対応させる

**Files:**
- Modify: `apps/slack-issue-intake/lib/commands/setup.ts`
- Modify: `apps/slack-issue-intake/lib/defaults.ts`（`SETUP_STEPS = 10` と `SETUP_TEXT` の文言）
- Create: `apps/slack-issue-intake/lib/commands/report.ts`（`report --channel <ID|name|default> --daily-at HH:MM --source <path|none>`。admin のリースで config を書く。`mention` と同じ形）
- Modify: `apps/slack-issue-intake/bin/slack-issue-intake.ts`（`report` を足す）
- Test: `test/setup.test.ts`、`test/report-command.test.ts`（新規）

**Interfaces:**
- 4 段目（初回）:
  - リポジトリを 1 つずつ聞く。空の Enter で終わり、最初の 1 つは必須。
  - 2 つ以上なら、既定の起票先を聞く（既定は最初の 1 つ）。
  - リポジトリごとに次の 2 つを聞く。
    - フォームに出すか（既定は出す）。
    - Slack から作っていない Issue の扱い（`thread` / `skip`。既定は `skip`）。
  - そのあと間隔を聞く。
- 4 段目（2 回目以降）:
  - 今の設定を見せて「足すリポジトリ（空で終わり）」を聞く。足したものについては、上の 2 つを聞く。
  - 間隔は今のとおり聞く。
  - 足したもの、または間隔が変われば、5 段目で init をやり直す。
- 7 段目（定期報告）:
  - `report.source` が null で、まだ聞いていなければ（meta `report_asked`）聞く。
  - `~/.claude/config/orca-team-dispatch-task/auto/*/report.json` を探し、見つかったものを候補として見せる。無ければ「`--auto` を setup したあとで、`node bin/slack-issue-intake.ts report --source <path>` で有効にできます」と出して飛ばす。
  - 報告のチャンネル（空なら起票のチャンネル）と時刻（既定 `09:00`）を聞いて、`report` を呼ぶ。
- 8 段目（フォーム）の前に、マニフェストの指紋が `manifestHash(formRepos(config))` と違えば、2 段目と同じ手順で deploy し直す。
- 承認と有効化は 9・10 段目に番号をずらす。

- [ ] **Step 1: 失敗するテストを書く**
  - `SU26 初回にリポジトリを 2 つ答えると、既定・フォームに出すか・既存の扱いを聞いて、init に --repo / --default-repo / --existing / --hide-form を渡す`
  - `SU27 2 回目にリポジトリを足すと init をやり直し、フォームの欄が変わるので deploy し直してからボタンを置く`
    - fake の Slack CLI の deploy が 2 回目も呼ばれる。
  - `SU28 7 段目は report.json が見つかればチャンネルと時刻を聞いて report を呼び、見つからなければ案内して飛ばす`
  - `RC1 report --channel default --daily-at 08:30 --source <path> が config を書き、--daily-at 25:00 は exit 2`
  - 既存の SU テストの入力に、4 段目の追加の答えと 7 段目の答えを足す。`[n/9]` を `[n/10]` に直す。
- [ ] **Step 2: 走らせて失敗を見る**
  - Run: `node --test test/setup.test.ts test/report-command.test.ts`
  - Expected: FAIL。
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 走らせて通るのを見る**
  - Run: `bash test/run-all.sh` と型と lint
  - Expected: 全件 PASS。
- [ ] **Step 5: コミット** `feat(slack-issue-intake): setup でリポジトリの一覧と既存の Issue の扱い、定期報告を設定する`

### Task 8: 文書とバージョン

**Files:**
- Modify: `apps/slack-issue-intake/README.md`
  - 概要に、複数リポジトリ、フォームの欄、スレッドで管理する Issue、定期報告の節を足す。
  - 「聞かれること」を 10 段にする。
  - 「0.4 からの更新」の節を足す。make setup で、リポジトリの一覧と既存の Issue の扱い、定期報告を聞く。フォームの欄が増えるときは deploy し直す。
  - 未確認の一覧に足す（`chat.update` の権限と挙動、任意の select 欄を空で送ったときの投稿の値）。
- Modify: `apps/slack-issue-intake/CLAUDE.md`（「Global Constraints」の方法で stage する）
  - 複数リポジトリ、`(repo, 番号)`、`adopted`、定期報告と 2 つのプラグインの約束（`auto-report.json`、`slack-thread`）、setup の 10 段。
- Modify: `apps/slack-issue-intake/skills/slack-issue-intake/SKILL.md` と `references/guide-ja.md`（init の引数、`report` サブコマンド、運用の行）
- Modify: `apps/slack-issue-intake/.claude-plugin/plugin.json`、ルートの `.claude-plugin/marketplace.json`（0.5.0）
- Test: `test/unit/docs.test.ts`

- [ ] **Step 1: 失敗するテストを書く**
  - `DO6 README は slack-thread と「0.4 からの更新」と report サブコマンドを含み、版は 0.5.0`
- [ ] **Step 2: 走らせて失敗を見る**
  - Run: `node --test test/unit/docs.test.ts`
  - Expected: DO6 が FAIL。
- [ ] **Step 3: 文書とバージョンを直す**
- [ ] **Step 4: 走らせて通るのを見る**
  - Run: `bash test/run-all.sh`、型と lint、ルートで `node scripts/check-doc-lang.mjs` と `node scripts/check-shared-contracts.mjs`
  - Expected: 全件 PASS、両方 OK。
- [ ] **Step 5: コミット** `docs(slack-issue-intake): 複数リポジトリ・スレッドでの管理・定期報告を書き、0.5.0 に上げる`
