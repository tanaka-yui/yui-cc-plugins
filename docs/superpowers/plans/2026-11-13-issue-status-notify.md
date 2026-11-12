# ステータスの通知（slack-issue-intake 部分 B）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** slack-issue-intake が起票時に Backlog を付け、Issue のステータスラベルと開閉の変化を、poll の毎回で元の Slack スレッドへ知らせる。メンション先のグループは `make setup` で入力する。

**Architecture:** poll は今の取り込み（sync）のあとに、残り時間があれば `statusSync` を走らせる。`gh api` で `from-slack` の Issue を更新日時の昇順に読み、DB の新しい表 `issue_status` と比べて、変わったものだけを `postThread` で書き込む。AI が変えたかどうかは、Issue のコメントの最終行のマーカー（spec 5.4）で見分ける。Claude は起動しない（poll の終了コードと agent_work は変えない）。

**Tech Stack:** TypeScript（Node 24.15 以上の型除去で直接実行）、node:sqlite、gh CLI、Slack Web API、node --test。

**Spec:** `docs/superpowers/specs/2026-11-12-issue-auto-dispatch-design.md` の 5 章（部分 B）。

## Global Constraints

- ステータスラベルは `Backlog` / `Ready` / `Ready_Eng` / `In progress` / `In review` / `Pending` / `Done` / `Failed` の 8 つ（spec 5.1）。名前はこのとおりに書く。
- マーカーは、コメントの空でない最終行が `<!-- orca-auto:<status>:<generation>:<event> -->`（spec 5.4）。
- 前からある `from-slack` の Issue には Backlog を付けない。最初に見たときは記録するだけで、通知しない（spec 5.3）。
- メンションは `<!subteam^ID>`。空のまま進めたらメンションしない（spec 5.5）。
- ボットの権限に `usergroups:read` を足す（spec 5.5。Slack の公式ドキュメントで、usergroups.list に必要な bot scope と確認済み）。
- poll の予算は 45 秒（`POLL_DEADLINE_MS`）。すべての gh / Slack の呼び出しに deadline を渡す（プラグインの CLAUDE.md）。
- 外へ出す文字列は `maskSecrets` を通す。Slack へ出すコメント本文は `escapeMrkdwn` も通す。
- 書き込みは poll のリースの下で、フェンス付き（`leaseValid` を確かめるトランザクション）で行う。
- 文言は `lib/defaults.ts` に置く。コード上の名前は英語、コメント・文言・コミットメッセージは日本語。
- `*-ja.md` 以外の指示文書（SKILL.md、references/procedure.md）に日本語を書かない。SKILL.md を変えたら、同じコミットで guide-ja.md も変える。
- `apps/slack-issue-intake/CLAUDE.md` の未コミットのユーザーの変更は、コミットに入れない（自分の変更を足すときは `git add -p` で自分の部分だけを入れる）。
- バージョンは 0.4.0（`.claude-plugin/plugin.json` とルートの `.claude-plugin/marketplace.json`）。

## 私が決めたこと（spec が builder に任せた点、または spec に無い点）

- **ラベルの色と説明**: Task 1 の表のとおり。
- **マーカーの `<status>`**: ラベル名ではなく slug で書く（`backlog` `ready` `ready-eng` `in-progress` `in-review` `pending` `done` `failed`）。ラベル名には空白があるため。
- **`<event>`**: `judged` `started` `needs-review` `partial-merge` `ai-merged` `human-merged` `failed` `stalled` の 8 つ。
- **コメント本文の書式**: 決めない。slack-issue-intake は本文を項目に分けて読まない。マーカーの行を除いた本文を、Slack 向けに変換してそのまま載せる。部分 C との約束は、例を `test/fixtures/orca-auto-comments.json` に置いて固定する。部分 C は同じファイルを自分の fixtures に写す。2 つの写しとラベルの定義が一致するかの確認（ルートのテスト）は、部分 C で足す。
- **マーカーを信じる条件**: 次の 2 つがそろったときだけ。そろわなければ「人が変えた」とみなす。
  - 書いた人が、リポジトリの OWNER / MEMBER / COLLABORATOR か、config の `github.login` である。公開リポジトリでは誰でもコメントできるため。
  - マーカーの status が、今のステータスラベルと一致する。
- **ステータスラベルが 2 つ以上付いているとき**: Done > Failed > In review > Ready_Eng > In progress > Pending > Ready > Backlog の順で先にあるものを使う。
- **閉じた Issue**: Done が無くても「完了しました」と知らせる（spec の表の「close」）。開き直されたときは、ふつうのステータスの変化として知らせる。
- **最初の記録（baseline）**:
  - slack-issue-intake が作った Issue は、作った同じトランザクションで `issue_status` に行を入れる。Backlog を付けたなら Backlog、付けていなければ null で入れる。
  - 行が無い Issue（前からあるもの）は、見つけたときに記録だけする。
  - 読む位置（`status_cursor`）が無い最初の回は、`since` を付けずに全件を昇順で読む。締め切りで止まれば、次の回で続きから読む。
- **同じ通知を二度出さないこと**: Slack に書いたあとで、フェンス付きで行を更新する。書いた直後にプロセスが落ちたときだけ、同じ通知が 1 回重なりうる（許す）。
- **書けなかったとき**:
  - `thread_not_found` のときは、通知を諦めて記録だけ進める。
  - それ以外の失敗は、その Issue で止める（`status_cursor` は進めない）。同じ Issue で `STATUS_MAX_ATTEMPTS`（5）回失敗したら、通知を諦めて記録を進める。
- **poll との関係**:
  - 取り込みのあと、残り時間が `STATUS_MIN_REMAINING_MS`（10 秒）以上あるときだけ走らせる。
  - 致命エラーやリースの喪失のあとは走らせない。
  - ステータスの処理の失敗は `errors` と `partial` に入れるが、終了コードと `agent_work` は変えない。
  - 出力行の最後に `notified=N` を足す。
- **ラベルの更新（0.3 からの更新）**:
  - `init` は `ensureLabels` が通ったら、ラベル名の一覧の指紋を meta `labels_hash` に残す。
  - `setup` の 5 段は、指紋が今と違えば init をやり直す。
  - 起票は、指紋が一致するときだけ Backlog を付ける。更新した直後、setup の前の poll でも起票が失敗しないようにするため（`gh issue create` は無いラベルで失敗する）。
  - `ensureLabels` は、既存のラベル名を大文字と小文字を区別せずに比べる。
- **メンション先の保存**:
  - config に `mention: { asked: boolean; groupId: string | null; handle: string | null }` を足す。無い古い config は `{ asked: false, groupId: null, handle: null }` として読む。
  - 書くのは新しいサブコマンド `mention` だけ（admin のリースの下）。`init` は `base.mention` を引き継ぐ。
  - グループは `usergroups.list` の handle（先頭の `@` は外す）か name で探す。`S` で始まる ID は探さずにそのまま受け付ける。
  - 権限が無い、ユーザーグループが無いプランなど、一覧を読めないときは、ID を入れるか空で進むよう案内する。
  - `usergroups.list` は poll では呼ばない（poll では `missing_scope` が致命エラーになるため）。
- **setup の段**: 9 段にする。5 段（init）の次に、6 段「通知でメンションするグループを決める」を入れる。フォームは 7、承認は 8、有効化は 9 になる。

## Review Focus

1. **0.3 から更新した直後**（ラベルが無く、setup をまだ実行していない）の poll でも、起票が失敗しない（Backlog を付けない）。Task 1 の GH11 / PO27 で確かめる。
2. **公開リポジトリで、関係ない人がマーカー付きのコメントを書いた**ときは、メンションも本文の転載もしない。Task 3 の IS3 と Task 5 の ST4 で確かめる。
3. **取り込みが予算を使い切った回**（PO16 の形）でも、ステータスの処理は締め切りを越えず、終了コードを変えない。次の回で続きを読む。Task 5 の ST8 で確かめる。
4. **メンションを設定していない**（空で進めた、または 0.3 の config のまま）ときは、`<!subteam^` を出さない。Task 5 の ST2 で確かめる。
5. **値に `<!channel>`、`<@U…>`、`&`、トークンらしい文字列を含むコメント**は、Slack でメンションにならず、秘密が伏せられる。Task 3 の IS4 で確かめる。

---

### Task 1: ステータスラベルと起票時の Backlog

**Files:**
- Modify: `apps/slack-issue-intake/lib/defaults.ts`（`STATUS_LABELS`、`LABEL_SPECS`、`META_LABELS_HASH`）
- Modify: `apps/slack-issue-intake/lib/github.ts`（`ensureLabels` の比較、`labelsHash`）
- Modify: `apps/slack-issue-intake/lib/issue-body.ts`（`issueLabels`）
- Modify: `apps/slack-issue-intake/lib/drive.ts:148`（Backlog を付けるかの判定）
- Modify: `apps/slack-issue-intake/lib/commands/init.ts`（`labels_hash` を残す）
- Modify: `apps/slack-issue-intake/lib/commands/setup.ts`（指紋が違えば 5 段で init をやり直す）
- Modify: `apps/slack-issue-intake/test/fixtures/fake-gh.ts`（`FAKE_GH_KNOWN_LABELS` があれば、無いラベルの issue create を失敗させる）
- Test: `test/unit/github.test.ts`、`test/unit/issue-body.test.ts`、`test/init.test.ts`、`test/poll.test.ts`、`test/setup.test.ts`

**Interfaces:**
- Produces:
  - `STATUS_LABELS: ReadonlyArray<{ name: string; slug: string; color: string; description: string }>`。並びは上の優先順（Done, Failed, In review, Ready_Eng, In progress, Pending, Ready, Backlog）。
  - `STATUS_BACKLOG = 'Backlog'`、`META_LABELS_HASH = 'labels_hash'`。
  - `labelsHash(): string`（`LABEL_SPECS` の名前を並べた SHA-256）。
  - `issueLabels(fields: SubmissionFields, withStatus: boolean): string[]`。

| ラベル | slug | 色 | 説明 |
|---|---|---|---|
| Backlog | backlog | ededed | 起票直後。人の判断待ち |
| Ready | ready | 0e8a16 | やる。AI が拾う対象 |
| Ready_Eng | ready-eng | 5319e7 | エンジニアが対応する |
| In progress | in-progress | 1d76db | AI が実装中 |
| In review | in-review | fbca04 | PR を出して人の判断待ち |
| Pending | pending | c2e0c6 | 後回し |
| Done | done | 0e8a16 | 完了 |
| Failed | failed | b60205 | AI が失敗した |

- [ ] **Step 1: 失敗するテストを書く**
  - `GH11 ensureLabels は既存のラベル名を大文字小文字を区別せずに比べ、ステータスラベル8つを作る`:
    - `FAKE_GH_LABELS` に `backlog` と元の 8 つを入れる。
    - `label create` の引数に `Backlog` が無く、`Ready` から `Failed` までの 7 つがあることを確かめる。
  - `IB10 issueLabels は withStatus のときだけ Backlog を足す`:
    - `issueLabels(fields, true)` に `'Backlog'` を含む。
    - `issueLabels(fields, false)` は今までどおりの 3 つ。
  - `IN13 init はラベルを確かめたあと labels_hash を残す`:
    - init のあと、DB の meta `labels_hash` が `labelsHash()` と等しい。
  - `PO27 labels_hash が今と違えば Backlog を付けずに起票し、一致すれば付ける`:
    - `FAKE_GH_KNOWN_LABELS` を元の 8 つにして poll する。作成は成功し、`--label Backlog` が無い。
    - meta を一致させた別のホームでは `--label Backlog` が有る。
  - `SU24 labels_hash が今と違えば、間隔が同じでも 5 段で init をやり直す`:
    - 出力に `[5/9]` が「済み」でなく出て、init が呼ばれる（fake-gh のログに `label list`）。
- [ ] **Step 2: 走らせて失敗を見る**
  - Run: `cd apps/slack-issue-intake && node --test test/unit/github.test.ts test/unit/issue-body.test.ts test/init.test.ts test/poll.test.ts test/setup.test.ts`
  - Expected: 上の 5 件が FAIL（`labelsHash` が無い、Backlog が無いなど）。
- [ ] **Step 3: 実装する**
  - 内容は Interfaces と表のとおり。
  - drive は `getMeta(db, META_LABELS_HASH) === labelsHash()` で `withStatus` を決める。
  - setup の 5 段: `existing.orca.automationId` があっても、DB の meta が `labelsHash()` と違えば `reinit` を呼ぶ。
  - SU24 の `[5/9]` は Task 4 で段の数が 9 になってから通る。この Task では `[5/${SETUP_STEPS}]` で書き、Task 4 で数を直す。
- [ ] **Step 4: 走らせて通るのを見る**
  - Run: `bash test/run-all.sh` と `pnpm --filter ./apps/slack-issue-intake check`
  - Expected: 全件 PASS。型と biome もエラー無し。
- [ ] **Step 5: コミット** `feat(slack-issue-intake): ステータスラベル8つを用意し、確かめたあとの起票に Backlog を付ける`

### Task 2: `issue_status` の表と、起票と同時の記録

**Files:**
- Modify: `apps/slack-issue-intake/lib/db.ts`（表、読み書き）
- Modify: `apps/slack-issue-intake/lib/drive.ts`（作成と、マーカーでの採用の 2 か所の `success`）
- Test: `test/unit/db.test.ts`、`test/poll.test.ts`

**Interfaces:**
- Produces（db.ts）:
  - `type IssueStatusRow = { issueNumber: number; status: string | null; state: 'open' | 'closed'; lastCommentId: number; seenUpdatedAt: string | null; attempts: number }`
  - `getIssueStatus(db: Db, issueNumber: number): IssueStatusRow | null`
  - `saveIssueStatus(db: Db, token: string, row: IssueStatusRow, now: string): boolean`（フェンス付きの upsert）
  - `transitionWithStatus(db: Db, token: string, id: number, from: State, patch: SubmissionPatch, seed: IssueStatusRow, now: string): boolean`
    - `transition` と、`issue_status` への `INSERT OR IGNORE` を、1 つのトランザクションで行う。
  - `trackedIssues(db: Db): Map<number, { channel: string; ts: string; reporterId: string | null }>`
    - `issue_number` を持つ submissions。
  - `issue_status` の列: `issue_number INTEGER PRIMARY KEY, status TEXT, state TEXT NOT NULL, last_comment_id INTEGER NOT NULL, seen_updated_at TEXT, attempts INTEGER NOT NULL, updated_at TEXT NOT NULL`。

- [ ] **Step 1: 失敗するテストを書く**
  - `DB9 saveIssueStatus はリースが無効なら書かず false、有効なら upsert`
  - `DB10 transitionWithStatus は状態が違えば submissions も issue_status も変えない`
  - `PO6` に足す: 作成のあと `getIssueStatus(db, 42)` が `{ status: 'Backlog', state: 'open', lastCommentId: 0 }`。
    - meta を一致させた場合。一致しなければ status は null。
  - `PO21b` に足す: マーカーで既存の Issue を採用したときも、行ができる。
- [ ] **Step 2: 走らせて失敗を見る**
  - Run: `node --test test/unit/db.test.ts test/poll.test.ts`
  - Expected: FAIL（関数が無い、行が無い）。
- [ ] **Step 3: 実装する**
  - drive の 2 か所の `success({ state: 'notifying', … })` を `transitionWithStatus` に替える。
  - seed の status は、`issueLabels` に Backlog を入れたかどうかで決める。
- [ ] **Step 4: 走らせて通るのを見る**
  - Run: `bash test/run-all.sh`
  - Expected: 全件 PASS。
- [ ] **Step 5: コミット** `feat(slack-issue-intake): Issue のステータスを記録する表を足し、起票と同時に最初の状態を残す`

### Task 3: ステータスとマーカーの読み取り、通知文の組み立て（副作用なし）

**Files:**
- Create: `apps/slack-issue-intake/lib/issue-status.ts`
- Create: `apps/slack-issue-intake/test/fixtures/orca-auto-comments.json`（部分 C と共有する例）
- Modify: `apps/slack-issue-intake/lib/defaults.ts`（`STATUS_EVENTS`、`MSG_STATUS_*`、`STATUS_COMMENT_MAX_CHARS = 3000`、`TRUSTED_ASSOCIATIONS`）
- Test: `test/unit/issue-status.test.ts`

**Interfaces:**
- Produces（issue-status.ts）:
  - `currentStatus(labelNames: string[]): string | null`
    - 大文字と小文字を区別せず、`STATUS_LABELS` の並びで最初に当たったラベルの正しい名前を返す。
  - `parseMarker(body: string): { slug: string; generation: number; event: string } | null`
  - `isTrusted(comment: { authorAssociation: string; login: string }, botLogin: string): boolean`
  - `slackifyComment(body: string): string`
    - マーカーの行を除き、`maskSecrets`、`escapeMrkdwn` を通す。
    - `**x**` は `*x*` に、`[t](https://…)` は `<https://…|t>` にする。
    - `STATUS_COMMENT_MAX_CHARS` で切る。
  - `type StatusChange = { from: { status: string | null; state: string }; to: { status: string | null; state: string }; marker: { event: string; body: string } | null }`
  - `renderStatusMessage(change: StatusChange, issueUrl: string, mention: string): string | null`
    - null は「知らせない」。
    - mention は `'<!subteam^S…> '` か `''`。
- `STATUS_EVENTS: Record<string, { mention: boolean; template: string }>`:

| event | mention | 文言（`{issue}` は Issue の URL、`{comment}` は変換した本文） |
|---|---|---|
| judged | あり | `エンジニアの対応が必要と判断しました（Ready_Eng）\n{issue}\n\n{comment}` |
| needs-review | あり | `確認をお願いします（In review）\n{issue}\n\n{comment}` |
| partial-merge | あり | `一部のリポジトリだけ merge できました。確認をお願いします（In review）\n{issue}\n\n{comment}` |
| ai-merged | あり | `AI が修正を merge して完了にしました（Done）\n{issue}\n\n{comment}` |
| human-merged | なし | `PR が merge されたので完了にしました（Done）\n{issue}` |
| failed | あり | `AI の対応が失敗しました（Failed）\n{issue}\n\n{comment}` |
| stalled | あり | `AI の作業が進んでいません\n{issue}\n\n{comment}` |
| started | なし | 下のふつうの変化と同じ |

- マーカーが無い（人が変えた）ときの文言:
  - 閉じた、または Done になった: `MSG_STATUS_DONE = '完了しました\n{issue}'`
  - それ以外の変化: `MSG_STATUS_CHANGED = 'ステータスが {from} から {to} に変わりました\n{issue}'`
  - ステータスが無いときは `MSG_STATUS_NONE = '（なし）'` を当てる。開き直しは `{to}` に `開き直し` を当てる。
- 決まり:
  - status も state も変わらず、マーカーも無いときは null を返す。
  - マーカーがあり、変化が無く、event が `stalled` のときだけ stalled の文を返す。

- [ ] **Step 1: 失敗するテストを書く**（fixture の例を読み込んで使う）
  - fixture には、8 つの event それぞれについて `{ event, status, body }` を 1 件ずつ入れる。body は、最終行がマーカーの日本語のコメント。
  - `IS1 currentStatus は大文字小文字を無視し、2つあれば優先順で選ぶ`
    - `['ready', 'Done']` は `'Done'`。`['bug']` は null。
  - `IS2 parseMarker は最終行だけを読み、形が違えば null`
    - 例の body はすべて読める。マーカーの後ろに空でない行があれば null。`in progress`（空白入り）は null。
  - `IS3 isTrusted は OWNER/MEMBER/COLLABORATOR か bot の login だけ`
    - `NONE` と `CONTRIBUTOR` は false。
  - `IS4 slackifyComment はメンションを無効にし、秘密を伏せ、リンクと太字を Slack の形にし、長さを切る`
    - 入力 `'<!channel> <@U1> a&b **太字** [PR](https://github.com/o/r/pull/1) xoxb-123-secret\n<!-- orca-auto:done:1:ai-merged -->'`。
    - 出力に `&lt;!channel&gt;`、`*太字*`、`<https://github.com/o/r/pull/1|PR>` を含む。
    - `xoxb-123-secret` とマーカーの行は含まない。
  - `IS5 renderStatusMessage は event ごとの文言とメンションを返す`
    - fixture の 8 件それぞれについて、mention の有無が表どおり。
    - `human-merged` と `started` は、mention を渡しても先頭に付かない。
  - `IS6 マーカー無しの変化は、閉じた・Done なら完了、それ以外はふつうの変化、変化なしは null`
- [ ] **Step 2: 走らせて失敗を見る**
  - Run: `node --test test/unit/issue-status.test.ts`
  - Expected: FAIL（モジュールが無い）。
- [ ] **Step 3: 実装する**（Interfaces のとおり）
- [ ] **Step 4: 走らせて通るのを見る**
  - Run: `node --test test/unit/issue-status.test.ts` と `pnpm --filter ./apps/slack-issue-intake check`
  - Expected: PASS。
- [ ] **Step 5: コミット** `feat(slack-issue-intake): ステータスとコメントのマーカーを読み、スレッドへの通知文を組み立てる`

### Task 4: メンションするグループ（config、`mention` サブコマンド、setup の 6 段）

**Files:**
- Modify: `apps/slack-issue-intake/lib/config.ts`（`mention` を足す。無ければ既定値で読む）
- Modify: `apps/slack-issue-intake/lib/commands/init.ts`（`base.mention` を引き継ぐ）
- Create: `apps/slack-issue-intake/lib/commands/mention.ts`
- Modify: `apps/slack-issue-intake/bin/slack-issue-intake.ts`（`COMMANDS` に `mention`）
- Modify: `apps/slack-issue-intake/lib/defaults.ts`
  - `SLACK_BOT_SCOPES` に `'usergroups:read'` を足す。
  - `USERGROUP_ID_PATTERN = /^S[A-Z0-9]{8,}$/`、`SETUP_STEPS = 9` にする。
  - `SETUP_TEXT.stepMention`、`askMention`、`MSG_MENTION_*` を足す。
- Modify: `apps/slack-issue-intake/lib/commands/setup.ts`（6 段を足し、後ろの段の番号をずらす）
- Test: `test/unit/config.test.ts`（新規。既存の config のテストがあればそこへ）、`test/mention.test.ts`（新規）、`test/init.test.ts`、`test/setup.test.ts`、`test/unit/automation.test.ts`（GU1 の scope）

**Interfaces:**
- Consumes: 既存の `loadConfig` / `saveConfig`、`acquireLease(db, 'admin', …)`、`SlackClient.call`。
- Produces:
  - `Config['mention']: { asked: boolean; groupId: string | null; handle: string | null }`
  - `mentionPrefix(config: Config): string`（config.ts）。`groupId` があれば `'<!subteam^ID> '`、無ければ `''`。
  - CLI: `mention --group <handle|@handle|name|ID>` と `mention --none`。
    - 成功したら `mention=<ID>` か `mention=none` を出して exit 0。
    - 見つからない、または一覧を読めないときは、案内を stderr に出して exit 1。
    - config が無ければ exit 2。

- [ ] **Step 1: 失敗するテストを書く**
  - `CF1 mention の無い 0.3 の config は asked:false として読め、保存して読み直すと値が残る`
  - `IN14 init をやり直しても mention が消えない`
  - `ME1 handle（@ 付きも可）と name で usergroups.list から ID を引いて保存する`
    - 偽の Slack が `{ usergroups: [{ id: 'S0DEV0001', handle: 'dev-member', name: 'Dev Member' }] }` を返す。
    - `--group @dev-member` と `--group 'Dev Member'` の両方で、config が `{ asked: true, groupId: 'S0DEV0001', handle: 'dev-member' }` になる。
  - `ME2 S で始まる ID は一覧を呼ばずに保存し、--none は asked:true でグループ無し`
  - `ME3 missing_scope や見つからないときは exit 1 で、ID を入れる案内を出し、config を変えない`
  - `SU25 6段: mention.asked が false なら聞き、空なら --none、名前なら --group を呼ぶ。asked なら済み`
    - 入力の列に、グループ名の行を足す。失敗（exit 1）したら、もう一度聞く。
  - 既存の SU テストの `[n/8]` を、新しい番号の `[n/9]` に直す。
  - `GU1` の scope の一覧に `'usergroups:read'` を足す。
- [ ] **Step 2: 走らせて失敗を見る**
  - Run: `node --test test/unit/*.test.ts test/mention.test.ts test/init.test.ts test/setup.test.ts`
  - Expected: 新しいテストが FAIL。
- [ ] **Step 3: 実装する**
  - `mention` は init と同じく admin のリースを取る。保存の直前に config が読み始めと同じかを確かめる（`MSG_CONFIG_CHANGED`）。
  - setup の 6 段は、手作業のアプリでも聞く。
  - `SETUP_TEXT.finished` は変えない。
- [ ] **Step 4: 走らせて通るのを見る**
  - Run: `bash test/run-all.sh` と `pnpm --filter ./apps/slack-issue-intake check`
  - Expected: 全件 PASS。form のテスト（マニフェストの指紋）は、scope が増えても `seedSlackApp` が今の指紋を保存するので通る。
- [ ] **Step 5: コミット** `feat(slack-issue-intake): 通知でメンションするグループを setup で入力し、config に残す`

### Task 5: poll でステータスの変化をスレッドへ知らせる

**Files:**
- Create: `apps/slack-issue-intake/lib/status-sync.ts`
- Modify: `apps/slack-issue-intake/lib/commands/poll.ts`（sync のあとに呼び、`notified=` を出す）
- Modify: `apps/slack-issue-intake/lib/defaults.ts`
  - `STATUS_MIN_REMAINING_MS = 10_000`、`STATUS_MAX_ATTEMPTS = 5`、`STATUS_CURSOR_OVERLAP_SECONDS = 60`、`META_STATUS_CURSOR = 'status_cursor'` を足す。
- Modify: `apps/slack-issue-intake/test/fixtures/fake-gh.ts`
  - `sort=updated` のとき、`since` で絞って `updated_at` の昇順に返す。
  - `repos/<repo>/issues/<n>/comments` の分岐を足し、state ファイルの Issue の `comments`（`id`、`body`、`created_at`、`author_association`、`user.login`）を返す。
  - `FAKE_GH_API_FAIL_PATH` を含む API 呼び出しを失敗させる。
- Test: `test/status-sync.test.ts`（新規、poll を通して試す）

**Interfaces:**
- Consumes:
  - Task 2: `trackedIssues`、`getIssueStatus`、`saveIssueStatus`。
  - Task 3: `currentStatus`、`parseMarker`、`isTrusted`、`slackifyComment`、`renderStatusMessage`。
  - Task 4: `mentionPrefix`。
  - 既存: `postThread`、`renewLease`、`setMeta`。
- Produces:
  - `statusSync(ctx: DriveContext): Promise<{ notified: number; errors: string[] }>`
- 1 回の流れ:
  1. 一覧を読む。`gh api 'repos/<repo>/issues?labels=from-slack&state=all&sort=updated&direction=asc&per_page=100&page=N[&since=<status_cursor − 60 秒>]'`。pull request は飛ばす。
  2. 1 件ずつ、次のように扱う。
     - DB に無い Issue は飛ばす。
     - 行が無ければ、記録だけする（lastCommentId は 0）。
     - `updated_at` が行の `seenUpdatedAt` 以下なら飛ばす。
     - それ以外は、コメントを `?since=<seenUpdatedAt>&per_page=100` でページの終わりまで読み、id が `lastCommentId` より大きいものを見る。
  3. 信じられるマーカーのうち最新のもの、ラベル、開閉から `StatusChange` を作り、文があれば書き込む。
  4. 書けたら行を保存し、`status_cursor` をその Issue の `updated_at` へ進める。保存も前進もフェンス付き。
- 呼び出しの前ごとに、締め切りとリースを確かめる。締め切りなら、そこで止めて `errors` に入れる。

- [ ] **Step 1: 失敗するテストを書く**
  - 共通の準備: submission 1 件（issue 42、スレッドあり）、state ファイルの Issue 42、偽の Slack は `chat.postMessage` を記録する。
  - `ST1 最初の回は記録だけで書き込まず、次の回で Backlog→Ready を人の変化としてメンション無しで書く`
    - 1 回目は、行の無い前からの Issue で試す。
    - スレッドへの書き込みの `thread_ts` が、submission の ts。
  - `ST2 judged のマーカー付きで Ready_Eng になれば、グループのメンションとコメント本文を書く。mention 未設定ならメンション無し`
  - `ST3 ai-merged はメンションあり、human-merged はメンション無しで、どちらも完了を書く。Done 無しで閉じても完了を書く`
  - `ST4 信じられない人のマーカーや、ラベルと合わないマーカーは、人の変化として扱う`
    - 本文を転載しない。メンションしない。
  - `ST5 ラベルが変わらず、新しい stalled のマーカーがあれば止まっていると書き、同じコメントで二度書かない`
  - `ST6 thread_not_found なら記録を進めて次へ。ほかの失敗は STATUS_MAX_ATTEMPTS 回で諦める`
  - `ST7 gh の失敗は partial になるが、終了コードは idle の 1 のまま、取り込みも進む`
    - `result=idle` で、`errors=` が 1 以上、`partial=true`。
    - 同じ回の新しい投稿は取り込まれ、`result=work` になる。
  - `ST8 締め切りで止まった回は status_cursor を処理済みの所までしか進めず、次の回で続きを知らせる`
    - `--deadline-ms` を小さくする。または、`FAKE_GH_SLEEP_ON` を `api repos` にして遅くする。
  - `ST9 残り時間が STATUS_MIN_REMAINING_MS より少なければ、ステータスの処理を呼ばない`
    - gh のログに `sort=updated` が無い。
- [ ] **Step 2: 走らせて失敗を見る**
  - Run: `node --test test/status-sync.test.ts`
  - Expected: FAIL（`notified=` が無い、書き込みが無い）。
- [ ] **Step 3: 実装する**
  - poll では、`report.fatal` か `report.leaseLost` のときと、残りが `STATUS_MIN_REMAINING_MS` 未満のときは呼ばない。
  - 結果の `errors` は既存の errors に足し、`partial` にする。終了コードは今の決め方のまま。
- [ ] **Step 4: 走らせて通るのを見る**
  - Run: `bash test/run-all.sh` と `pnpm --filter ./apps/slack-issue-intake check`
  - Expected: 全件 PASS。既存の PO テストも通る（出力行の末尾に `notified=0` が増えるだけ）。
- [ ] **Step 5: コミット** `feat(slack-issue-intake): poll でステータスの変化を見つけ、元のスレッドへ知らせる`

### Task 6: 文書とバージョン

**Files:**
- Modify: `apps/slack-issue-intake/README.md`
  - 概要に「ステータスの通知」の節を足す。ラベルの表と、通知の表（spec 5.3）を入れる。
  - 「聞かれること」に 6 段を足し、段の番号を直す。
  - 「Slack CLI を使わないセットアップ」の scope に `usergroups:read` を足す。
  - 「0.3 からの更新」の節を足す。make setup で、deploy のやり直し、ラベルの作成、グループの入力が行われる。
  - 「うまくいかないとき」に、mention の失敗の行を足す。
  - 未確認の一覧に足す。`usergroups.list` の応答、`<!subteam^>` の表示、大文字と小文字だけ違うラベルへの付与、コメントの `author_association`。
- Modify: `apps/slack-issue-intake/CLAUDE.md`
  - 「ステータスの通知」の段落を足す。表、マーカーを信じる条件、baseline、labels_hash、poll との関係。
  - setup の段の数を 9 にする。
  - ユーザーの未コミットの変更とは `git add -p` で分ける。
- Modify: `apps/slack-issue-intake/skills/slack-issue-intake/SKILL.md` と `references/guide-ja.md`
  - setup の段の数か段の一覧が書かれていれば直す。mention サブコマンドを足す。
  - SKILL.md は英語だけで書く。
- Modify: `apps/slack-issue-intake/.claude-plugin/plugin.json` と `.claude-plugin/marketplace.json` を 0.4.0 にする。
- Test: `test/unit/docs.test.ts`
  - `DO5 README は 8 つのステータスラベル名と usergroups:read と「0.3 からの更新」を含む`

- [ ] **Step 1: 失敗するテストを書く**（DO5）
- [ ] **Step 2: 走らせて失敗を見る**
  - Run: `node --test test/unit/docs.test.ts`
  - Expected: DO5 が FAIL。
- [ ] **Step 3: 文書とバージョンを直す**
- [ ] **Step 4: 走らせて通るのを見る**
  - Run: `bash test/run-all.sh`、`pnpm --filter ./apps/slack-issue-intake check`、`pnpm check:doc-lang`
  - Expected: 全件 PASS、`check-doc-lang: OK`。
- [ ] **Step 5: コミット** `docs(slack-issue-intake): ステータスの通知とメンション先の設定を書き、0.4.0 に上げる`
