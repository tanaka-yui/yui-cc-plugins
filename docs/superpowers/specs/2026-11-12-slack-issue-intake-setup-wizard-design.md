# slack-issue-intake: make setup ウィザードの設計

## 目的

いまのセットアップは、Slack の画面でアプリを作り、トークンをコピーし、チャンネル ID を探し、そのあと init・form・permissions・enable を順に実行する。画面とコマンドを何度も行き来するうえ、文書がコマンドを `set-token` のように略して書いているため、何を実行すればよいのか分かりにくい。

これを、プラグインのディレクトリで `make setup` を1回実行し、聞かれたことに順に答えるだけで終わる形にする。Slack CLI にログイン済みなら、Slack の画面を開かずに済むようにする。

## ゴール

1. `make setup`（中身は `node bin/slack-issue-intake.ts setup`）の1コマンドで、セットアップを最初から最後まで進められる。入力は、チャンネル名、リポジトリ、確認の間隔、承認の y/N だけにする。
2. Slack CLI にログイン済みなら、次を Slack の画面なしで済ませる。
   - アプリの作成とインストール
   - トークンの登録
   - チャンネル ID の解決
   - 公開チャンネルへのボットの参加
   - フォームのボタンの作成、使える人の設定、ブックマーク
3. 途中で止まっても、もう一度 `make setup` を実行すれば、済んだ段を飛ばして続きから進む。
4. Claude に許す操作と、受け継ぐ許可は、これまでどおり人が内容を見て承認する。ウィザードは内容を表示し、y/N で確かめる。既定は N。
5. トークンを画面・ログ・コマンドの引数・会話のどこにも出さない。
6. README を `make setup` を前提に書き直す。コマンドは略さず `node bin/slack-issue-intake.ts …` の形で書く。

## やらないこと

- Claude（skill）からウィザードを動かすこと。ウィザードは対話式なので、人がターミナルで実行する。skill は、ターミナルで `make setup` を実行するよう勧め、できない場合はこれまでの手順で進める。
- Slack CLI が無い環境での自動化。その場合は README の手作業の手順（通常のマニフェストと Workflow Builder）を使う。
- Slack CLI へのログインの代行。ログインしていなければ `slack login` を案内して止まる。
- セットアップ後の送り先の変更（今の制約のまま）。ホームを退避して `make setup` をやり直すと、同じアプリを使い続け、トークンは deploy で取り直す。古いチャンネルのボタンとブックマークは自動では消さない。README に、`slack trigger delete` とブックマークの削除で片付ける手順を書く。（作る人の判断）
- Windows。

## 失敗とみなすこと（動いても不可）

- トークンが画面、ログ、引数、会話に出る。
- 再実行で Slack アプリが2つ目できる。
- 人が内容を見ないまま、Claude への許可や受け継ぐ許可が承認される。
- ログイン中のワークスペースが複数あるのに、ウィザードが勝手に1つを選ぶ。

## 前提と制約

- 実行時の依存は増やさない。Node 24.15 以上、TypeScript の型除去でそのまま実行する。`any`・`unknown`・`class` は使わない。固定値は `lib/defaults.ts` にまとめる。
- Slack の画面なしで進められるのは、Slack CLI（公開版）がログイン済みのときだけ。
- 2026-11-12 時点で、本物の Slack ではまだ試していない。次の4点は実環境で確かめる必要があり、README に未確認として書く。
  1. フォーム付きのマニフェスト（組み込みの open_form と send_message だけのワークフロー、`function_runtime` なし）を、`slack deploy` が受け付けるか。
  2. deploy フックにボットのトークンが渡ってくるか。
  3. `slack trigger create --trigger-def <JSON>` でこのアプリのボタンを作れるか。
  4. ボットが `conversations.join` で公開チャンネルに参加できるか。

## 決めたこと

### Slack CLI でアプリを作る仕組み

Slack CLI は、プロジェクトの `.slack/hooks.json` に書かれたフックを使ってアプリを扱う。この仕組みに乗せるため、ウィザードはホームに Slack CLI 用のプロジェクトを作る。

- **置き場所:** ホームの隣の `~/.slack-issue-intake-slack-app/`（権限 0700）。`SLACK_ISSUE_INTAKE_HOME` でホームを変えたときは、その隣の `<ホーム>-slack-app` にする。（作る人の判断）
  - Slack CLI は、アプリの ID を `.slack/apps.json` に書く。これが消えると、次の deploy で2つ目のアプリができる。
  - プラグインのディレクトリには置けない。更新で入れ替わるからである。
  - ホームの中にも置かない。送り先を変えるときの手順（ホームを退避して設定し直す）で、一緒に退避されてしまうからである。
- **ウィザードが毎回書き直すファイル:**
  - `.slack/hooks.json`: 下の3つのフックを書く。コマンドには、今の node と、今のプラグインの `bin/slack-issue-intake.ts` を絶対パスで入れる。プラグインを更新しても、次の実行で正しいパスになる。
  - `.slack/config.json`: `{"manifest":{"source":"local"}}`
  - `form-trigger.json`: ボタンの定義（後述）
- **Slack CLI が書くファイル:** `.slack/apps.json`（`apps.<チーム ID>.app_id`、`team_id` など）。ウィザードは読むだけで、消さない。
- **フック:** 新しいサブコマンド `slack-hook` が受け持つ。
  - `get-hooks`: フックの一覧を JSON で返す。hooks.json と同じ内容にする。
  - `get-manifest`: フォーム付きのマニフェストを返す。今の `form --manifest` と同じ中身で、マニフェストは1か所で作る。
  - `deploy`: 環境変数 `SLACK_BOT_TOKEN` を読み、`xoxb-` の形なら secrets.json に保存し、伏せた形（`saved token=xoxb-***`）だけを表示する。無ければ、何も保存せずに失敗で終わる。

### トークンの受け取り

`slack deploy --app deployed --skip-update` を、上のプロジェクトのディレクトリで、入出力をそのまま端末につないで実行する。Slack CLI は、マニフェストからアプリを作ってインストールしたあとに deploy フックを実行する。このとき、ボットのトークンを自分の環境変数に入れてからフックを起動するので、フックはその値を受け取れる。

- これは Slack CLI の実装上の動きで、約束された仕様ではない。フックがトークンを受け取れなかったときは、ウィザードは「トークンを受け取れませんでした」と表示する。続けて、アプリの設定画面からコピーして `set-token` で登録する手順を示して止まる。
- Slack CLI は、すでに `SLACK_BOT_TOKEN` が環境にあると、それを上書きせずに使い続ける。そのまま実行すると、別のトークンを保存してしまう。そこで `slack deploy` には、`SLACK_BOT_TOKEN`・`SLACK_APP_TOKEN`・`SLACK_USER_TOKEN` を取り除いた環境を渡す。
- ワークスペースは、ウィザードでは選ばない。ログイン中のワークスペースが複数あれば、Slack CLI が自分で選択肢を出す。2回目以降は `.slack/apps.json` のチーム ID を `--team` に渡し、同じアプリを更新する。
- deploy したときのマニフェストの指紋（SHA-256）をプロジェクトのディレクトリに残す。プラグインの更新で権限が増えるなどしてマニフェストが変わったら、次の `make setup` でもう一度 deploy する。こうすればアプリの設定と権限が今の版に追いつく。

### フォームのボタン

ボタンは、ボットのトークンではなく Slack CLI で作る。これまでの `workflows.triggers.create` をボットのトークンで呼ぶ方法は、公式資料に無いため使わない。

- 作成: `slack trigger create --trigger-def form-trigger.json --app deployed --team <チーム ID> --skip-update --no-color`
  - `form-trigger.json` の中身は `{"type":"shortcut","name":<FORM_TITLE>,"description":…,"workflow":"#/workflows/issue_intake_form","inputs":{"interactivity":{"value":"{{data.interactivity}}"},"channel_id":{"value":<チャンネル ID>},"user_id":{"value":"{{data.user_id}}"}}}`
  - 出力から `https://slack.com/shortcuts/Ft…/…` を探し、URL とボタンの ID（`Ft…`）を取り出す。
- 使える人: `slack trigger access --trigger-id <ID> --channels <チャンネル ID> --grant --include-app-collaborators=false --app deployed --team <チーム ID> --skip-update --no-color`。フラグをすべて渡し、Slack CLI に質問させない。
- ブックマーク: これまでどおり、ボットのトークンで `bookmarks.add` を呼ぶ。
- 作ったボタンとブックマークの ID は、今の meta のキーに残す。再実行では作り直さない。
- これを `form` コマンド（`make slack-form`）の中身にする。Slack CLI のプロジェクト（`.slack/apps.json`）が無いときは、「make setup で作ったアプリが見つかりません」と表示する。あわせて、Workflow Builder で作る方法を案内する。

### マニフェストの権限

フォーム付きのマニフェストで追加する権限を変える。

- 外す: `triggers:write`（ボタンは Slack CLI が開発者の権限で作るので、ボットには要らない）
- 加える: `channels:join`（公開チャンネルにボットが自分で参加するため）
- 残す: `channels:read`、`groups:read`（チャンネル名から ID を調べるため）、`bookmarks:write`

通常のマニフェスト（手作業の手順で使うもの）は変えない。

### ウィザードの流れ

各段の頭に `[n/8] 見出し` を表示する。済んでいる段は「済み」と表示して飛ばす。

1. **事前の確認。** 次を確かめ、足りないものがあれば直し方を表示して止まる。
   - Node の版
   - gh が入っていて、ログイン済みか
   - Orca を呼べるか
   - Slack CLI が見つかるか。`~/.slack/bin/slack` を優先し、無ければ PATH の `slack` を `slack _fingerprint` の値で本物か確かめる。
   - Slack CLI にログインしているか（`slack auth list`）
2. **アプリを作ってトークンを登録する。** 上の「トークンの受け取り」のとおり。トークンが登録済みで `.slack/apps.json` もあり、マニフェストの指紋も同じなら飛ばす。トークンだけがある場合（手作業の手順で作ったアプリ）は作らずに進み、6 で Workflow Builder を案内する。
3. **チャンネルを決める。** チャンネル名（`#` は付けても付けなくてもよい）か、チャンネル ID を入力してもらう。
   - ボットのトークンで `conversations.list` を全ページ引き、名前から ID を探す。アーカイブ済みは除く。
   - 公開チャンネルで、ボットがまだメンバーでなければ `conversations.join` で参加する。
   - 見つからなければ、プライベートチャンネルの可能性がある。「Slack で `/invite @Issue Intake` を送ってから Enter を押してください」と表示し、Enter のあとにもう一度探す。
4. **リポジトリと間隔を決める。** `owner/name` と確認の間隔（既定 5 分。60 の約数だけ）を入力してもらう。gh で、リポジトリの有無、Issues が有効か、push 権限があるかを先に確かめる。公開リポジトリなら、Issue の内容が公開されることを示して y/N で確かめ、y なら init に `--allow-public` を付ける。
5. **init を実行する。** 集めた値で `init --channel … --repo … --every …` を子プロセスとして実行し、出力はそのまま表示する。設定がすでにあれば 3〜5 を飛ばす。
6. **フォームのボタンを置く。** `form` を子プロセスとして実行する。
7. **Claude に許す操作を承認する。** `permissions --show` の出力を表示する。続けて「この内容で許可しますか？ [y/N]」と聞き、y なら `permissions --apply` を実行する。N なら、何も変えずに止まる。
8. **automation を有効にする。** 受け継ぐ許可（`inheritedGrants()`）があれば一覧を表示し、y/N で承認を確かめる。承認されたら `enable --accept-inherited`、受け継ぐ許可が無ければ `enable` を実行する。

7・8 を飛ばすかは、`permissionStatus()` の結果で決める。

| 結果 | 動き |
|---|---|
| `accepted` | 7・8 とも済みとして飛ばす |
| `not-accepted` または `changed` | 7 を飛ばし、8 を実行する |
| `unsafe` | 7 から実行する |

最後に、チャンネルの「Issue を起票」から1件送って確かめる方法を表示する。確かめには `node bin/slack-issue-intake.ts inspect --raw` を使う。

### 入力の読み方

- 質問は標準出力に出し、答えは標準入力から1行ずつ同期で読む。読んでいる間は、子プロセス（Slack CLI など）と入力を取り合わない。
- 入力が尽きたら、「入力がありません。ターミナルで make setup を実行してください」と表示して止まる（終了コード 2）。Claude Code の `!` など、端末につながっていない環境から実行した場合もこれに当たる。端末かどうかは別に判定しない。テストでは、答えを標準入力に流し込む。

### 既存のコマンドの呼び方

init・form・permissions・enable は、子プロセス（`node bin/slack-issue-intake.ts <コマンド>`）として呼ぶ。今のコマンドは `process.exitCode` と標準出力で結果を返すので、子プロセスにすれば手を入れずに使える。リポジトリの確認、受け継ぐ許可、権限の状態だけは、ウィザードが lib の関数（`repoInfo`、`inheritedGrants`、`permissionStatus`）を直接呼んで判断する。

### テスト用の差し替え

- Slack CLI の場所は、環境変数 `SLACK_ISSUE_INTAKE_SLACK_CLI` で差し替えられる。Orca の `ORCA_BIN` と同じ扱いにする。
- テストでは、偽の Slack CLI を使う。偽物は次を真似て、受け取った引数と、トークン用の環境変数があったかどうかを記録する。
  - `_fingerprint`、`auth list`
  - `deploy`: hooks.json の get-manifest を実行してマニフェストを受け取り、`.slack/apps.json` を書き、`SLACK_BOT_TOKEN` を付けて deploy フックを実行する。
  - `trigger create`、`trigger access`
- Slack の API は今の偽サーバーを使う。`conversations.list`、`conversations.join`、`conversations.info` を足す。

## 文書の変更

- **README:**
  - 「セットアップ」を `make setup` を中心に書き直す。どこで実行するか、何を聞かれるか、途中で止まったときの再開、終わったあとの確かめ方、うまくいかないときの表を載せる。
  - これまでの手順は「Slack CLI を使わないセットアップ」として残す。guide の出力と、Workflow Builder の詳しい手順を載せる。
  - 前回足した「フォームの作り方」の make の手順（`make manifest` を画面に貼る方法）は、`make setup` に置き換わるので消す。
  - すべての節で、コマンドを略さず書く。セットアップ中は `node bin/slack-issue-intake.ts …`、運用では init が作る `~/.slack-issue-intake/bin/slack-issue-intake …` を使う。後者が前者と同じ働きをすることを明記する。
- **guide の出力（`lib/guide.ts`）:** Slack CLI を使わない手順として、コマンドを略さず書く。手順の先頭で、Slack CLI があれば `make setup` を使えることを示す。フォーム付きのマニフェストに関する記述（`form --manifest` と `form` の段）は外す。
- **SKILL.md と guide-ja.md:**
  - init の冒頭で、ターミナルで `make setup` を実行するよう勧める。
  - form の節を、Slack CLI で作る形に直す。
- **アプリの CLAUDE.md:** 「フォームの自動作成」を「セットアップのウィザード」に書き換える。Slack CLI のプロジェクトの置き場所、トークンの受け取り方、環境変数を取り除く理由、テスト用の差し替えを書く。
- **Makefile:** `setup` を足し、`help` の先頭に置く。`slack-form` と `manifest` は残す。

## 作る人に任せること

- サブコマンドとモジュールの分け方、関数名、表示の細かい文言
- `conversations.list` のページの大きさ
- 偽の Slack CLI の書き方
- テストの粒度（上のゴールと「失敗とみなすこと」は、それぞれテストで押さえる）
