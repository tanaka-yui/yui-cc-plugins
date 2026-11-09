# dev-digest

毎朝、Orca の automation が開発ニュースのフィードと X の投稿を集め、Claude が要約して Slack に届ける。
送ったものはローカルの SQLite の履歴に残り、この skill で検索できる。この skill が扱うのは対話の側
（`init` / `setup` / `search` / `list` / `remove`）。毎朝の実行そのものはここに書かない。正本は
`references/morning.md` で、`procedure` サブコマンドがこのマシンの値に置き換えて表示する。

CLI は `node "$PLUGIN/bin/dev-digest.ts" <subcommand>` で呼ぶ（`PLUGIN` は `${CLAUDE_PLUGIN_ROOT}`）。
各ブロックは書かれたとおりに実行し、ブロックの間でシェル変数を運ばない。

## Output Language の訳

ユーザーに見せる質問・選択肢のラベル・表・進捗報告はすべて日本語で表示する。この文書は一貫性のために英語で
書かれているが、ユーザーに見せる言語は変えない。

## 厳守するルール（秘密）

- **`~/.dev-digest/secrets.json` を読まない・開かない・cat しない・grep しない。**ファイル・環境変数・履歴の
  どこでも Slack Webhook URL を探さない。
- **Webhook URL をチャットでユーザーに尋ねない。会話にも書かない。**URL は非表示のダイアログかクリップボードから
  CLI を通って `secrets.json` に入るだけ。入力には `set-webhook` を使う。
- コマンドの出力に Webhook URL らしきものがあっても、繰り返さない。

## 依頼に応じた振り分け

- 引数なし、または開発速報の設定を始めたい: **init**。
- 今のリポジトリを監視したい: **setup**。
- 過去の速報について聞かれた: **search**。
- 監視中のリポジトリの一覧や、監視をやめたい: **list / remove**。

設定がまだ無ければ（`search` や `procedure` が init を促す）、**init** から始める。

## init

1. AskUserQuestion で 1 回にまとめて尋ねる（日本語で）: 実行時刻（HH:MM）と `daily` / `weekdays`、JVN の
   報告しきい値（既定 `critical`）、X のリスト URL（`https://x.com/` で始まること。リストを使わないなら `none`）、
   X のハッシュタグ（既定 `#AI` `#LLM` `#生成AI` を提示）、dev.to のタグ（既定 `aws` `googlecloud` `ai`
   `security` を提示）。
2. init を実行する。初回は 6 つのフラグがすべて要り、2 回目以降は指定したものだけ更新する。`--dry-run` は
   何も書かずに Orca の呼び出しだけを見せる。init は `~/.dev-digest/`（設定・SQLite の履歴・作業フォルダ
   `run/`）を作り、安定パスのランチャー `~/.dev-digest/bin/dev-digest` を置き、作業フォルダを Orca に登録し、
   `dev-digest` automation を作成または更新する。無人の毎朝の実行は `node "$PLUGIN/..."` ではなくランチャーを
   呼ぶので、プラグインを更新しても automation は動き続ける。出力は `launcher=` `automation=`
   `webhook_global=registered|missing`。exit 1 は Orca への登録の失敗で、理由を見せて止まる。
3. `webhook_global=missing` なら全体の Webhook を登録する。macOS では非表示の入力ダイアログが出る。exit 4 と
   `fallback=clipboard` はダイアログが出せなかったという意味（クリップボードの
   モードでそれ無しの exit 4 は、クリップボードに読める内容が無かったという意味）。ユーザーに Slack の Incoming Webhook URL を
   クリップボードにコピーさせ、このセッションで `!` を付けて
   `! ~/.dev-digest/bin/dev-digest set-webhook --target global --from-clipboard` を実行してもらい、終わるのを待つ。
   終わっても URL はクリップボードに残るので、消すように伝える。exit 1 は入力のキャンセルか Slack の
   Incoming Webhook URL でなかったことで、何も保存されていない。
4. 権限のルールを見せて、適用する前に尋ねる（`permissions --show`）。`project` の一覧は作業フォルダでの無人の
   実行に許す操作: ランチャーの `procedure` / `collect` / `pending`（引数なしの完全一致）、`ingest-x:*`、
   `publish:*`、`x-open:*`、`orca tab close` / `snapshot` / `scroll`、作業フォルダの読み取り、`x.json` と
   `digest.json` だけへの書き込みと編集。project の allow は**置き換える**。`user` の一覧は、どのセッションも
   `secrets.json` を Read / Edit できないようにする deny で、user の設定には**足すだけ**。ユーザーが承認して
   から `permissions --apply` を実行する。
5. ユーザーに、Orca の内蔵ブラウザで X に 1 回ログインするよう伝える（毎朝の実行はそのログインを使う）。
   認証情報は尋ねない。
6. 最初の実行をユーザーが承認したら、init が出した automation を `orca automations run <automation id>` で実行する。
   `orca` が PATH に無ければ `ORCA_CLI_COMMAND` か `/Applications/Orca.app/Contents/Resources/bin/orca` を使う。
   そのあと Slack を確認するよう伝える。

## setup

監視したいリポジトリの中で実行する。`init` が済んでいること。

1. slug を求める（`repo slug --path "$(pwd -P)"`。`origin` の `owner/repo`、無ければフォルダ名）。slug の規則:
   英数字で始まり、`owner/repo` の形で、`__` を含まない。あとで `repo save` が拒んだら、ユーザーに伝えて別の
   slug を決める。
2. 依存の定義を読んで候補を作る。対象は、プロジェクトの**直接依存**（package.json、go.mod、pyproject.toml /
   requirements、Cargo.toml、Gemfile、pom.xml / build.gradle など）と**インフラの OSS**（docker-compose の image、
   Dockerfile の `FROM`、Helm chart、Kubernetes manifest、Terraform provider）。間接依存は除く。それぞれの GitHub
   `owner/repo` を推定する（不明なら `null`）。`languages`、`cloudServices`（`aws`、`gcp` など）、ニュースに
   一致させる価値のある `keywords` も集める。
3. 候補を表（名前・エコシステム・GitHub owner/repo）で見せ、GitHub の訂正と行の追加・削除を受ける。このリポジトリの
   JVN のしきい値（`critical` / `high` / `medium` / `low`、全体の設定に従うなら `null`）と dev.to のタグ（csv。空でも
   よい）を尋ねる。
4. candidate の JSON を **`~/.dev-digest/run/` の外の一時ファイル**（例: `mktemp -d` の下）に書く。`devtoTags` は
   小文字の英数字だけ。`addedAt` は CLI が決めるので書かない。そして `repo save --file <一時ファイル>`。出力は
   `slug=` `created=` `added=` `removed=`（パッケージ名）で、追加・削除した名前を報告する。検証エラーなら、名指し
   された欄を直して再実行する。
5. このリポジトリ専用の Slack チャンネルを使うか尋ねる。使うなら `set-webhook --target <slug>`（exit 4 と
   クリップボードの代替手順は init と同じ）。使わなければ、このリポジトリの項目は全体に送られる。終わったら
   一時ファイルを消す。

## search

質問から絞り込みを決めて `search` を呼ぶ。フラグはすべて任意: `--q`、`--since` / `--until`（YYYY-MM-DD。設定の
タイムゾーン）、`--section`（`jvn|aws|gcp|x|devto|releases` の csv）、`--repo`、`--min-severity`、`--limit`（既定 50）。
3 文字未満の語は全文検索の索引ではなく部分一致（title・summary・日本語の要約）で探すので、短い語でも使える。出力は項目の
JSON 配列（`title` `url` `sourceId` `publishedAt` `severity` `summaryJa` `tags` `deliveredTo` など）で、`[]` は
履歴なし。表（日付・セクション/ソース・タイトル・要約）で答え、タイトルはすべて `url` へのリンクにする。使った
絞り込みも書く。

## list / remove

`repo list`（1 リポジトリ 1 行のタブ区切り: slug、path、Webhook の伏せた値か `global`、JVN のしきい値、
パッケージ数）、`repo show --slug <slug>`、`repo remove --slug <slug>`。`remove` はリポジトリの設定と専用の
Webhook を消す。実行前にユーザーに確認し、履歴は残ることを伝える。
