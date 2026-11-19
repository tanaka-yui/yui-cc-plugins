# slack-issue-intake: 「質問する」フォームと仕様の索引（knowledge）

2026-11-19。ユーザーとの対話で決めた設計。

## 1. 目的

Slack のチャンネルに 4 つ目のボタン「質問する」を足す。質問は Issue にせず、AI がスレッドで答える。
仕様の質問には、setup のときに AI がリポジトリのドキュメントを読んでまとめた索引（knowledge）から、すぐ答えられるようにする。

## 2. フォーム

- ボタンの題: `質問する`。workflowId: `issue_intake_question`。FORM_KINDS の 4 つ目（key: `question`）。
- 項目:
  - 質問の種類（必須・選択）: `仕様について` / `バグか仕様なのかわからない` / `その他`
  - 本文（必須・複数行）
  - 添付ファイル（任意）: ほかのフォームと同じ（`FORM_ATTACHMENTS_TITLE`、`MAX_FILES_PER_MESSAGE`）
  - リポジトリ（repos が `FORM_REPO_FIELD_MIN_REPOS` 以上のときだけ）: ほかのフォームと同じ
- 題（title）と優先度（priority）の欄は無い。
- 投稿の形は `renderKindMessage` を使う。種類を見分ける `*カテゴリ:*` の行は `質問` にし、質問の種類と本文はカテゴリ別の項目として書く。解析器（parse.ts）は質問の種類が 3 つのどれかでなければ invalid とする。題が無いので、内部の題は本文の先頭行から `MAX_TITLE_CHARS` で作る（Slack の表示と Issue に流用するとき用）。
- `workflows.featured.add` は 1 回 15 件まで（docs.slack.dev、2026-11-19 に確認）。4 つは収まる。setup の 8 段の「3 つのボタン」の判定は FORM_KINDS の数で判定する形にする。マニフェストが変わるので既存の環境は setup で deploy し直す。

## 3. 流れ（状態）

質問の submission も既存の表・状態機械を使う（新しい表は作らない）。種類は `fields.category`（= `質問`）と `categoryKey`（= `question`）で区別する。

1. `new` → Claude が `answer` を決める → apply がスレッドへ回答を投稿 → `waiting`（rounds を 1 増やす）。
2. スレッドに人の返信 → `answered` → Claude が再び決める:
   - `answer`: もう一度答える（rounds +1）。
   - `create`: 起票（下記 4）。質問の種類が `バグか仕様なのかわからない` で、Claude がバグと判断して起票を提案し、質問者が返信で起票を頼んだときだけ。
   - `close`: 解決した（お礼だけ・追加の質問なし）。短い締めの文を投稿して閉じる。
3. 回答の上限は 3 回（`MAX_ANSWER_ROUNDS = 3`）。上限に達した item は `mustClose: true` で work に出し、Claude は `close` を選ぶ。apply は `config.mention` の担当者にメンションし、人へ渡して閉じる。
4. 返信が来ないまま時間切れ（`timed_out`）になった質問は、Claude を起こさずに閉じる（質問に `mustCreate` は効かない）。
5. 閉じた質問は新しい終端状態 `closed`（Issue を持たない）。statusSync・adopt・report・retry は Issue を持たない行を扱わない（既存の `rejected` と同じ扱い）。

`validateDecisions` は種類ごとに許す action を変える:

| 種類 | 許す action |
|---|---|
| bug / feature / request | `ask` / `create`（今までどおり） |
| question | `answer` / `close` / `create`（`create` は質問の種類が `バグか仕様なのかわからない` のときだけ） |

## 4. 質問から起票するとき

- カテゴリはバグ。優先度は `priority: middle`。
- 題は decision の `title`（質問からの create では必須。`MAX_TITLE_CHARS` 以下）。
- 本文は今の create と同じ（summary / details / unresolved、元の投稿とスレッド）。
- 起票後の通知・ステータス同期は今の Issue と同じ。

## 5. 回答の decision

```json
{ "id": 21, "action": "answer", "message": "<日本語の回答>", "sources": ["docs/spec/billing.md"], "proposeIssue": false }
{ "id": 22, "action": "close", "message": "<日本語の締めの文>" }
{ "id": 23, "action": "create", "title": "<題>", "summary": "...", "details": "...", "unresolved": [] }
```

- `message`: 回答。メンションとリンクは書かない（apply が足す）。`ANSWER_MAX_CHARS` 以下。
- `sources`: 根拠にしたドキュメントの knowledge 内の相対パス（0 件以上、上限あり）。apply は knowledge の `meta.json` の commit で GitHub の permalink を作って回答の末尾に並べる。knowledge に無いパスは検査で弾く。
- `proposeIssue`: バグの可能性が高いと判断したとき true。apply が「起票してほしい場合はこのスレッドに返信してください」の定型文を足す。質問の種類が `バグか仕様なのかわからない` のときだけ true にできる。
- 根拠が knowledge に無いときは推測で答えず、「ドキュメントに見つからなかった」と答える。apply は `sources` が空の回答に `config.mention` の担当者へのメンションを足す。

## 6. knowledge（索引・写し・FAQ）

置き場はホームの下（どのリポジトリにも入らないので commit されない。プラグインのディレクトリは更新で入れ替わるので使わない）:

```
<home>/knowledge/<owner>/<repo>/
  INDEX.md      AI がまとめた全体像・話題→ファイルの対応表・用語集・各ドキュメントの要約
  index.json    INDEX.md の元データ（コードが検査した形）
  docs/...      ドキュメントの写し（リポジトリ内の相対パスを保つ）
  meta.json     { commit, builtAt, files }
  faq.jsonl     答えた質問と回答（作り直しでは消さない）
```

### 作り方（人がいるときだけ）

1. `git clone --depth 1` で一時ディレクトリに取る（`gh` の認証を使う）。
2. `claude -p` を読み取り専用（`--tools Read,Glob,Grep`、`--allowedTools Read,Glob,Grep`、`--permission-mode dontAsk`、`--strict-mcp-config`、cwd は clone）で走らせ、JSON を出させる: `{ overview, topics: [{ name, files }], glossary: [{ term, meaning }], docs: [{ path, title, summary, topics }] }`。orca-team-dispatch-task の `lib/setup-suggest.ts` の形を写す（import しない。プラグインは別々に入る）。
3. コードが検査する: パスは clone の中の通常ファイル（realpath が clone の内側、symlink でない）、拡張子はドキュメント（md / mdx / txt / rst / adoc）、件数・1 ファイルの大きさ・合計の大きさに上限。外れたものは捨てて 1 行知らせる。
4. 通ったファイルを `maskSecrets` に通して `docs/` に写し、`INDEX.md` と `index.json`・`meta.json` を書く。古い `docs/` と置き換えるのは全部書けたあと（途中で失敗したら前の版を残す）。
5. clone を消す。

作る時期:

- `make setup` の新しい段（フォームの段の前）。
- `make slack-form` の開始時。
- `make knowledge <名前>`（索引だけを作り直す）。

### 読み方（無人）

- collect は質問の item に `knowledge` を付ける: そのリポジトリの `INDEX.md`・`faq.jsonl` の場所と、knowledge が無い・古い（作った日時）こと。
- 無人の Claude に新しく許すのは `Read(/<home>/knowledge/**)` だけ。今の封じ込め（run ディレクトリの外を読まない・決定ファイルしか書かない）を保つ。生きたリポジトリは読ませない（Slack の投稿は信頼できない入力なので、`.env` などを読ませて回答で漏らす経路を作らない）。
- knowledge の中身も信頼できない材料として扱う（指示として読まない）と procedure に書く。
- 許可が変わるので権限の指紋も変わる。既存の環境は setup の 9 段（承認）で一度承認し直す（マニフェストの変更で setup の再実行がどのみち要る）。

### FAQ

- apply が `answer` を投稿できたら、`{ at, repo, questionKind, question, answer, sources, permalink }` を `faq.jsonl` に足す（maskSecrets を通す）。件数の上限を超えたら古い順に捨てる。
- 回答の前に Claude は `INDEX.md` と `faq.jsonl` を読み、`docs/` の該当ファイルを開く。

## 7. 変更する場所（見込み）

- `lib/defaults.ts`: FORM_KINDS に question、質問の種類、上限、文言。
- `lib/types.ts`: CategoryKey・State（`closed`）・StoredDecision（answer / close / create の title）。
- `lib/form.ts` / `lib/form-message.ts`: 題と優先度の無い種類、選択の項目。
- `lib/parse.ts`: 質問の解析。
- `lib/work.ts` / `lib/commands/collect.ts`: 質問の item、`mustClose`、knowledge の場所、時間切れの質問は閉じる。
- `lib/decisions.ts`: 種類ごとの action の検査、sources の検査。
- `lib/commands/apply.ts`: answer / close の投稿、質問からの create、FAQ の追記。
- `lib/db.ts`: `closed`。
- `lib/permissions.ts`: knowledge の Read。
- 新規 `lib/knowledge.ts` と `lib/commands/knowledge.ts`、Makefile の `knowledge`。
- `lib/commands/setup.ts`（新しい段）、`lib/commands/form.ts`（4 つ目のボタン・開始時の作り直し）。
- `skills/slack-issue-intake/references/procedure.md` と `procedure-ja.md`、SKILL.md と guide-ja.md、README、CLAUDE.md。
- バージョン: plugin.json・.codex-plugin（あれば）・marketplace.json。
