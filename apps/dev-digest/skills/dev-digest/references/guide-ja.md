# dev-digest

毎朝、Orca の automation が開発ニュースのフィードと X の投稿を集め、Claude が要約して Slack に届ける。
送ったものはローカルの SQLite の履歴に残り、この skill で検索できる。この skill が扱うのは対話の側
（`init` / `setup` / `search` / `list` / `remove` / `categories`）。毎朝の実行そのものはここに書かない。正本は
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
- カテゴリを足す・消す・止める・戻す、除外ワードを変えたい: **categories**。

設定がまだ無ければ（`search` や `procedure` が init を促す）、**init** から始める。

## init

1. AskUserQuestion で 1 回にまとめて尋ねる（日本語で）: 実行時刻（HH:MM）と `daily` / `weekdays`、JVN の
   報告しきい値（既定 `critical`）、全体向け JVN のキーワード（任意。使っている製品・ベンダー名の csv。例:
   `Tomcat,PostgreSQL`。タイトルか製品名にどれかを含む項目だけを全体に送る。大文字小文字を区別しない部分一致。
   `none` かフラグ省略なら、しきい値以上をすべて送る。リポジトリ向けの通知には効かない）、X のリスト URL（`https://x.com/` で始まること。リストを使わないなら `none`）、
   X のハッシュタグ（既定 `#AI` `#LLM` `#生成AI` を提示）、dev.to のタグ（既定 `aws` `googlecloud` `ai`
   `security` を提示）。
2. init を実行する。初回は `--jvn-keywords` 以外の 6 つのフラグがすべて要り、2 回目以降は指定したものだけ更新する。`--dry-run` は
   何も書かずに Orca の呼び出しだけを見せる。init は `~/.dev-digest/`（設定・SQLite の履歴・作業フォルダ
   `run/`）を作り、安定パスのランチャー `~/.dev-digest/bin/dev-digest` を置き、作業フォルダを Orca に登録し、
   `dev-digest` automation を作成または更新する。無人の毎朝の実行は `node "$PLUGIN/..."` ではなくランチャーを
   呼ぶので、プラグインを更新しても automation は動き続ける。出力は `launcher=` `automation=`
   `webhook_global=registered|missing` `webhook_sections=<csv>|none`。exit 1 は Orca への登録の失敗で、理由を見せて
   止まる。
3. `webhook_global=missing` なら全体の Webhook を登録する。macOS では非表示の入力ダイアログが出る。exit 4 と
   `fallback=clipboard` はダイアログが出せなかったという意味（クリップボードの
   モードでそれ無しの exit 4 は、クリップボードに読める内容が無かったという意味）。ユーザーに Slack の Incoming Webhook URL を
   クリップボードにコピーさせ、このセッションで `!` を付けて
   `! ~/.dev-digest/bin/dev-digest set-webhook --target global --from-clipboard` を実行してもらい、終わるのを待つ。
   終わっても URL はクリップボードに残るので、消すように伝える。exit 1 は入力のキャンセルか Slack の
   Incoming Webhook URL でなかったことで、何も保存されていない。
4. 全体の通知のうち、カテゴリごとに Slack のチャンネルを分けるかを AskUserQuestion で 1 回尋ねる（日本語で、
   複数選択）。カテゴリは `category list` に出る有効なもの（**categories** を参照。組み込みの `jvn` `aws` `gcp`
   `x` `devto` と、追加したもの）。
   `webhook_sections` に出たものを選択済みにし、「分けない」も選べるようにする。専用チャンネルの無いカテゴリと
   警告（前回未完了・取得できなかったソース）は全体のチャンネルに残る。リポジトリ向けの通知には効かない。
   カテゴリをまたいでまとめた話題は、そのまとめが載るカテゴリのチャンネルへ行く。新しく選んだカテゴリごとに、
   手順 3 と同じやり方（クリップボードの代替手順も `--target section:<name>` で）で
   `set-webhook --target section:<カテゴリの id>` を実行して Webhook を登録する。`webhook_sections` に
   あるのに分けなくなったカテゴリは `set-webhook --target section:<name> --remove` で消す（そのカテゴリは全体の
   チャンネルに戻る。値は尋ねない）。
5. 権限のルールを見せて、適用する前に尋ねる（`permissions --show`）。`project` の一覧は作業フォルダでの無人の
   実行に許す操作: ランチャーの `procedure` / `collect` / `pending`（引数なしの完全一致）、`ingest-x:*`、
   `publish:*`、`x-open:*`、`orca tab close` / `snapshot` / `scroll`、作業フォルダの読み取り、`x.json` と
   `digest.json` だけへの書き込みと編集。project の allow は**置き換え**、作業フォルダの `permissions.defaultMode` を
   `dontAsk` にするので、allow に無い操作は尋ねずに拒まれる（`auto` などのモードでは allow に無い操作も自動で承認
   されうる）。作業フォルダの設定は user の設定より優先され、user の設定のモードは変えない。封じ込めはこのモードに
   頼るので、最初の実際の朝の実行で allow に無い操作が拒まれることを確かめるようユーザーに伝える。`inherited` の
   一覧は user の設定の allow。allow は全スコープのものが合わさり、`dontAsk` が拒むのはどの allow にも合わない操作
   だけなので、これらは無人の実行にも効く。封じ込めの範囲は project の一覧＋この一覧であって、project の一覧だけ
   ではない。dev-digest はこれを変えない。ユーザーに一覧を見せ、広いルール（例: `Bash(git commit:*)`、広い
   `Bash(...)` の接頭辞、`WebFetch`）があれば指摘する。外すかどうかはユーザーが自分の設定で決める。自分では外さない。
   `user` の一覧は、どのセッションも `secrets.json` を Read / Edit できないようにする deny で、user の設定には
   **足すだけ**。ユーザーが承認してから `permissions --apply` を実行する。
6. ユーザーに、Orca の内蔵ブラウザで X に 1 回ログインするよう伝える（毎朝の実行はそのログインを使う）。
   認証情報は尋ねない。
7. 最初の実行をユーザーが承認したら、init が出した automation を `orca automations run <automation id>` で実行する。
   `orca` が PATH に無ければ `ORCA_CLI_COMMAND` か `/Applications/Orca.app/Contents/Resources/bin/orca` を使う。
   そのあと Slack を確認するよう伝える。

## setup

監視したいリポジトリの中で実行する。`init` が済んでいること。

1. slug を求める（`repo slug --path "$(pwd -P)"`。`origin` の `owner/repo`、無ければフォルダ名）。slug の規則:
   英数字で始まり、`owner/repo` か 1 段の名前（`origin` が無いときのフォルダ名）で、`__` を含まない。あとで `repo save` が拒んだら、ユーザーに伝えて別の
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
タイムゾーン）、`--section`（`jvn|aws|gcp|x|devto|releases|feed` の csv。`feed` は追加したカテゴリのフィード）、`--repo`、`--min-severity`、`--limit`（既定 50）。
3 文字未満の語は全文検索の索引ではなく部分一致（title・summary・日本語の要約）で探すので、短い語でも使える。出力は項目の
JSON 配列（`title` `url` `sourceId` `publishedAt` `severity` `summaryJa` `tags` `deliveredTo` など）で、`[]` は
履歴なし。表（日付・セクション/ソース・タイトル・要約）で答え、タイトルはすべて `url` へのリンクにする。使った
絞り込みも書く。

## list / remove

`repo list`（1 リポジトリ 1 行のタブ区切り: slug、path、Webhook の伏せた値か `global`、JVN のしきい値、
パッケージ数）、`repo show --slug <slug>`、`repo remove --slug <slug>`。`remove` はリポジトリの設定と専用の
Webhook を消す。実行前にユーザーに確認し、履歴は残ることを伝える。

## categories

カテゴリは Slack の通知の見出しで、専用チャンネルに分ける単位でもある。2 種類ある:

- **組み込み**（`jvn` `aws` `gcp` `x` `devto`）: 決まった取得元から集める。消せないが、止める（取得も送信もしない。
  `x` を止めると朝の実行で X も読まない）・戻すことはできる。
- **追加したもの**: ユーザーが指定した RSS / Atom のフィードと、キーワードの片方または両方で集める。どの取得元の
  項目でも、タイトルか要約にキーワードのどれかを含めば（大文字小文字を区別しない部分一致）、取得元のカテゴリでは
  なくそのカテゴリに載る。複数の追加カテゴリに合うときは `category list` で先のものが勝つ。追加カテゴリには
  フィードかキーワードが 1 つ以上要る。

除外ワード: タイトルか要約にどれかを含む項目は送らない（大文字小文字を区別しない部分一致）。共通の一覧は全カテゴリ
とリポジトリ向けの通知にも効き、カテゴリごとの一覧はそのカテゴリに載る項目に効く。外した項目は記録され、
あとで語を変えても送らない。

同じ URL（host の大文字小文字・クエリ・`#` 以降・末尾の `/` の違いは無視）の項目は、送り先ごとに 1 回だけ送る
（実行をまたいでも）。同じ項目の更新（`【追記】`）は送る。設定は要らない。

まず今の状態を見せ（`category list`）、何を変えるか尋ねる（日本語で）。各行はタブ区切りで、id、`builtin` か
`custom`、`enabled` か `disabled`、追加カテゴリなら `title=` `feeds=` `keywords=`、全カテゴリに
`channel=split|global` と `exclude=`（空なら `none`）。最後の行は `exclude_common=`。表にして見せる。そのうえで
選ばれたものを実行する:

- 追加、または追加カテゴリの指定した欄だけの変更: `category set --id <id> --title "<見出し>" --feeds "<csv | none>"
  --keywords "<csv | none>"`（`none` で一覧を空にする）
- 追加カテゴリの削除（その除外ワードと専用チャンネルの Webhook も消す）: `category remove --id <id>`
- 組み込みのカテゴリを止める・戻す（専用チャンネルの Webhook は残す）: `category disable --id <...>` /
  `category enable --id <...>`
- 除外ワードの置き換え（`--id` 無しなら共通、ありならそのカテゴリ）: `category exclude [--id <id>] --words
  "<csv | none>"`

- `id` は英小文字・数字・ハイフンで、組み込みの名前（`jvn` `aws` `gcp` `x` `devto` `releases` `feed`）と重ねない。
  見出しから案を出して確かめる。
- フィードは `http` / `https` の URL。フィードの URL を推測しない。ユーザーに尋ねるか、見つけたものを確かめる。
- `remove` の前にユーザーに確認し、履歴は残ることを伝える。
- カテゴリを足したら、専用チャンネルにするか尋ねる。するなら init の手順 4 と同じく
  `set-webhook --target section:<id>` で登録する。
- 変更は次の朝の実行から効く。
