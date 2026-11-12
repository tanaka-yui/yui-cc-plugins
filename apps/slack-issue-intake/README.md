# slack-issue-intake

## 概要

Slack のワークフローのフォームから GitHub Issue を起票する Claude Code プラグインです。常駐サーバーは不要です。

フォームはカテゴリごとに 3 つあり、チャンネルの入力欄の所にボタンが並びます。押したボタンでカテゴリが決まり、カテゴリに合った項目だけを聞きます。

| ボタン | カテゴリ別の項目 | 共通の項目 |
|---|---|---|
| バグを報告 | 事象（必須・複数行）、エラーログ（任意・複数行）、対応策（任意・複数行）、画面のURL（任意）、ソースコードのパス（任意） | タイトル（必須）、優先度（必須）、添付ファイル（任意） |
| 要望を送る | 現在（必須・複数行）、理想（必須・複数行）、画面のURL（任意）、ソースコードのパス（任意） | 同上 |
| 新機能を提案 | 仕様（必須・複数行） | 同上 |

チャンネルへの投稿は、項目名を太字にし、複数行の値をコードブロックで囲みます。0.2 までの 1 つのフォーム（`本文:` の形）の投稿も、そのまま読み取ります。

## 仕組み

```text
Slack のフォーム → チャンネル投稿
  ↓ N分ごと
Orca precheck: poll（モデルなし）
  ├─ 判断待ちなし → Claude を起動せず終了
  └─ 判断待ちあり → Claude: procedure → collect → 判断を decisions.json → apply
                                        ↓
                        必要ならスレッドで確認 → Issue 作成 → URL を返信
```

新規・返信済み・期限切れの判断だけに Claude を使い、質問の投稿・作成・通知の再試行は CLI が進めます。聞き返しは2回まで、各3問以内、回答待ちは72時間です。

## 必要なもの

- Slack の有料プランと、そこでアプリを作れる権限（アプリは社内向けのカスタムアプリで、配布しません）
- Slack CLI（公開版）。`slack login` でログイン済みであること。`make setup` で使います。使えない場合は「Slack CLI を使わないセットアップ」で進めます
- 同じ Mac の Node 24.15 以上
- 対象リポジトリの push 権限（WRITE 以上）があるアカウントで認証済みの GitHub CLI（gh）
- 起動中の Orca と Claude Code

## セットアップ

先に `claude plugin marketplace update yui-cc-plugins` を実行し、`claude plugin install slack-issue-intake@yui-cc-plugins` で入れます。そのあと、プラグインのディレクトリで次を実行します。

```bash
make setup
```

プラグインのディレクトリは、このリポジトリでは `apps/slack-issue-intake`、プラグインとして入れた場合は `~/.claude/plugins/cache/yui-cc-plugins/slack-issue-intake/<版>` です。make が使えないときは `node bin/slack-issue-intake.ts setup` でも同じです。

質問に答えるだけで、アプリの作成から automation の有効化まで進みます。質問を読むので、ターミナルで実行してください。Claude のシェルや、入力をつながない環境では動きません（終了コード 2）。

> **未確認**: この手順は、本物の Slack ではまだ試していません（2026-11-12 時点）。次の8点は実環境で確かめる必要があります。
>
> 1. フォーム付きのマニフェスト（組み込みの open_form と send_message だけのワークフロー）を、`slack deploy` が受け付けるか。
> 2. deploy フックにボットのトークンが渡ってくるか。
> 3. `slack trigger create --trigger-def <JSON>` で、このアプリのボタンを作れるか。
> 4. ボットが `conversations.join` で公開チャンネルに参加できるか。
> 5. `send_message` の `message` で、`*…*` が太字に、``` で囲んだ値がコードブロックになるか。
> 6. `workflows.featured.add` に 3 つのボタンの ID を `,` でつないで渡し、3 つとも入力欄の所に出るか。
> 7. 0.2 から上げたとき、`workflows.featured.remove` と `slack trigger delete` で古い 1 つのボタンを外して消せるか。
> 8. ワークフロー `issue_intake_form` を消したマニフェストを deploy したとき、0.2 の古いボタン（トリガー）が残るか消えるか。
>
> 動かなかったときは、止まった理由が画面に出ます。下の「うまくいかないとき」を見るか、「Slack CLI を使わないセットアップ」に切り替えてください。

### 聞かれること

8段で進みます。画面には `[n/8]` の見出しが出ます。済んでいる段は「済み」と出て飛ばします。

| 段 | 内容 | あなたがすること |
|---|---|---|
| 1 | 事前の確認 | なし。Node、gh（ログイン済み）、Orca、Slack CLI（ログイン済み）を確かめます |
| 2 | Slack アプリを作ってトークンを登録する | まず既存のアプリ ID を聞かれます。新しく作るなら空のまま Enter、作成済みのアプリを使うならその ID（A で始まる）を入力します。Slack CLI がワークスペースを聞いたら、使うものを選びます。アプリの作成（または更新）とインストールは自動です。トークンは Slack CLI から受け取って保存します |
| 3 | チャンネルを決める | チャンネル名（`#issue-intake` の形でも可）か ID を入力します。公開チャンネルにはボットが自分で参加します。プライベートチャンネルは、Slack で `/invite @Issue Intake` を送ってから Enter を押します |
| 4 | リポジトリと確認の間隔を決める | `owner/name` と、確認の間隔（分、既定は5）を入力します。公開リポジトリのときは、内容が公開されることを確認して y を答えます。2回目以降は今の設定を表示し、間隔だけ聞き直します |
| 5 | 設定を保存して automation を登録する（init） | なし。automation は無効で登録されます |
| 6 | フォームのボタンを置く（form） | なし。チャンネルのおすすめワークフローになり、メンバーには入力欄の所に 3 つのボタン（「バグを報告」「要望を送る」「新機能を提案」）が出ます |
| 7 | Claude に許す操作を承認する（permissions） | 表示された内容を確認し、y を答えます |
| 8 | automation を有効にする（enable） | 受け継ぐ許可があれば、その一覧を確認して y を答えます |

入力した内容が合わないときは、理由を表示して聞き直します。承認で n を答えると、その段では何も変えずに止まります。

2段目で作るアプリは、通常の権限に加えて channels:read、groups:read、chat:write.public、channels:join、bookmarks:write を持ちます。チャンネル名の検索、フォームの内容の投稿、公開チャンネルへの参加、ボタンをおすすめワークフローにすること（workflows.featured.add）に使います。`make manifest` で、このマニフェストを表示できます。

### 途中で止まったとき

もう一度 `make setup` を実行します。済んだ段は飛ばし、止まった段から再開します。

- アプリとトークンがそろっていれば、deploy はやり直しません。ただし、プラグインの更新でマニフェストが変わったときは、次の実行でもう一度 deploy します。
- 設定と automation が登録済みなら、チャンネルとリポジトリは聞きません。送り先は変えられません。今の設定を表示し、確認の間隔だけ今の値を既定にして聞き直します。Enter ならそのまま、別の値を入れると init で automation を書き換えます（公開リポジトリなら、もう一度確認します）。
- Slack CLI のプロジェクト（`~/.slack-issue-intake-slack-app/`）にアプリの記録が無いときは、2段目で既存のアプリ ID を聞きます。プロジェクトを消した、別の端末で作った、などのときは、そのアプリの ID（https://api.slack.com/apps の Basic Information）を入力すると、`slack app link` でつないで同じアプリを更新します。空のまま Enter を押すと、もう1つアプリができます。
- 設定は保存されたが automation の登録（Orca）で失敗していたときは、保存済みのチャンネルとリポジトリで init をやり直します。公開リポジトリなら、もう一度確認します。
- ボタンが作成済みで、おすすめワークフローにしてあれば、作り直しません。前の版で関連ページ（ブックマーク）に「Issue を起票」を足していた場合、それは押すとブラウザが開いてしまうので、Slack で手で削除してください。
- 権限が承認済みなら7段は飛ばし、8段では聞き直さずに enable をやり直します。前回 Orca での有効化に失敗していても、ここで有効になります。

終了コードは、失敗が 1、入力がないときが 2 です。

Slack CLI で作ったアプリが無く、`node bin/slack-issue-intake.ts set-token` でトークンだけ登録してある場合は、手作業で作ったアプリとして進みます。このときボタンは作らないので、6段で「Workflow Builder で手で作る」を案内します。

### 終わったあとの確かめ方

チャンネルの入力欄の所に出る 3 つのボタンのどれかを押してフォームを1件送り、数分後に次を実行します。

```bash
node bin/slack-issue-intake.ts inspect --raw
```

いま送った投稿の行に `marker=yes`、`parse=ok`、`reporter=U…`、添付の数と同じ `files=` が出ていれば完成です。このフォームの投稿はアプリ自身のボットが書くので、`bot=yes` と出ます。添付なしでも送れるかも試してください。

### うまくいかないとき

| 症状 | 対処 |
|---|---|
| `Slack CLI が見つかりません` で止まる | Slack CLI を入れて `slack login` を実行してから再実行します。入れられないときは「Slack CLI を使わないセットアップ」に進みます |
| `slack deploy に失敗しました` で止まる | 上に出ている Slack CLI の出力を確かめます。マニフェストを受け付けない場合は、「Slack CLI を使わないセットアップ」に進みます |
| `トークンを受け取れませんでした` で止まる | deploy フックにトークンが渡りませんでした。アプリの OAuth & Permissions から Bot User OAuth Token をコピーし、`node bin/slack-issue-intake.ts set-token` で登録してから、もう一度 `make setup` を実行します |
| チャンネルに参加できない | Slack で対象チャンネルに `/invite @Issue Intake` を送ってから再実行します |
| `このアプリにはチャンネル名で探す権限がありません` と出る | 手作業で作ったアプリは、チャンネル名で探す権限がありません。チャンネル名 → 詳細の最下部にある ID を入力します |
| `Slack CLI でフォームのボタンを作れませんでした` | 括弧の中の理由を控え、「Workflow Builder で手で作る」でフォームを作ります |
| `ボタンをチャンネルの入力欄に出せません` | ボタン自体はできています。ブラウザで Slack の管理画面を開き、ワークフローの一覧から「バグを報告」「要望を送る」「新機能を提案」のそれぞれについて（アプリ Issue Intake）、詳細を開いて右上のメニューから「おすすめアプリに追加」を選びます。チャンネルの入力欄の所に 3 つのボタンが出ないときは、チャンネルの「ワークフロー」タブ →「ワークフローを目立たせる」で 3 つを選び、「注目」を押します |
| `ボットにはボタンを入力欄に出す権限がありません（restricted_action）` | ボットのトークンでは入力欄にボタンを出せませんでした。setup はそのまま先へ進み、最後に同じ手順をもう一度表示します。ブラウザで Slack の管理画面を開き、ワークフローの一覧から「バグを報告」「要望を送る」「新機能を提案」のそれぞれについて（アプリ Issue Intake）、詳細を開いて右上のメニューから「おすすめアプリに追加」を選びます。チャンネルの入力欄の所に 3 つのボタンが出ないときは、チャンネルの「ワークフロー」タブ →「ワークフローを目立たせる」で 3 つを選び、「注目」を押します |
| `トークンのワークスペースが設定と違います` | 別のワークスペースのトークンが登録されています。このアプリのトークンで `node bin/slack-issue-intake.ts set-token` をやり直します |
| `Slack に deploy 済みのアプリが、今のフォームの定義と違います` | プラグインを更新したあとに `make slack-form` だけを実行した場合です。`make setup` を実行して deploy し直してください。6 段目でボタンも置きます |
| `以前の 1 つのボタンは、新しい 3 つのボタンが入力欄の所に出るまで残します` | ボットでは新しいボタンをおすすめにできなかったので、0.2 のボタンを残しています。画面で 3 つを注目にしてから `make slack-form` をもう一度実行すると、古いボタンを外して消します |
| `以前の 1 つのボタン（…）を消せませんでした` | 新しい 3 つのボタンは使えます。一時的な失敗なので、次に `make slack-form` か `make setup` を実行したときにもう一度消します。ボタンがもう無い場合は、消えたものとして扱います |
| 入力欄の所のボタンが消えた | ブラウザで Slack の管理画面を開き、ワークフローの一覧から「バグを報告」「要望を送る」「新機能を提案」のそれぞれについて（アプリ Issue Intake）、詳細を開いて右上のメニューから「おすすめアプリに追加」を選びます。チャンネルの入力欄の所に 3 つのボタンが出ないときは、チャンネルの「ワークフロー」タブ →「ワークフローを目立たせる」で 3 つを選び、「注目」を押します。`make slack-form` は記録済みなので付け直しません |
| `inspect` で `parse=invalid` になる | `problems=` に、足りない項目や合わない選択肢が出ます。手で作った場合は、テンプレートと選択肢の文字を見直します |

### 0.2 からの更新

0.3 でフォームは 1 つからカテゴリごとの 3 つになりました。プラグインを更新したら `make setup` を実行します。

1. 2 段目で、3 つのワークフローを持つマニフェストを deploy し直します。
2. 6 段目で 3 つのボタンを作っておすすめにし、そのあとで 0.2 の 1 つのボタンを外して消します。チャンネルから新しいボタンが出る前に古いボタンを消すことはしません。
3. ボットでおすすめにできない環境では、古いボタンを残したまま先へ進みます。画面で 3 つを注目にしてから `make slack-form` を実行すると、古いボタンを片付けます。

deploy（2 段目）から 6 段目までの間、古いボタンは押しても動かないことがあります（Slack の実際の動きは未確認）。`make slack-form` だけを先に実行すると、deploy し直すよう案内して止まります。0.2 の形（`本文:`）で投稿済みのものは、そのまま読み取ります。

### 送り先を変えたあとの片付け

送り先（チャンネル、リポジトリ）を変えるには、automation を止め、ホームを退避して `make setup` をやり直します。同じアプリを使い続け、トークンは deploy で取り直します。古いチャンネルのボタンは自動では消えないので、手で片付けます。

1. `slack trigger list --app deployed` で古いボタンの ID（`Ft…`）を調べ、`slack trigger delete --trigger-id <ID> --app deployed` で消します。Slack CLI のプロジェクトは `~/.slack-issue-intake-slack-app/` にあります（`SLACK_ISSUE_INTAKE_HOME` を変えているときは、そのホームの隣の `<ホーム>-slack-app`）。このディレクトリで実行します。
2. 古いチャンネルの「ワークフロー」タブで、3 つのワークフローそれぞれの 3 つのドットアイコン →「注目から外す」を選びます（トリガーを消していれば消えています）。

## Slack CLI を使わないセットアップ

Slack CLI が使えないとき、または `make setup` の途中でフォームやマニフェストが受け付けられなかったときの手順です。skill `/slack-issue-intake` から進めるか、`node bin/slack-issue-intake.ts guide` で次の案内を表示します。

Slack CLI にログインしているなら、この手順の代わりに `make setup` を使えます。
1. https://api.slack.com/apps の Create New App → From a manifest で社内向けカスタムアプリを作り、ワークスペースにインストールします。配布しません。有料プランが必要です。

マニフェスト:
```json
{
  "display_information": {
    "name": "Issue Intake"
  },
  "features": {
    "bot_user": {
      "display_name": "Issue Intake",
      "always_online": false
    }
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "channels:history",
        "groups:history",
        "chat:write",
        "files:read",
        "users:read",
        "usergroups:read"
      ]
    }
  },
  "settings": {
    "org_deploy_enabled": false,
    "socket_mode_enabled": false,
    "token_rotation_enabled": false
  }
}
```
2. アプリの設定の OAuth & Permissions を開き、Bot User OAuth Token（xoxb- で始まる文字列）をコピーします。続けて `node bin/slack-issue-intake.ts set-token` を実行します（skill で進めているときは Claude が実行します）。
「slack-issue-intake」という題の入力ウィンドウが開くので、⌘V で貼り付けて OK を押します。入力欄はパスワード用と同じで、貼った文字は見えません。「saved token=」で始まる行が出れば登録できています。
トークンは Claude との会話やコマンドの引数に書かないでください。会話に貼るとモデルに送られて記録にも残り、引数に書くとシェルの履歴に残ります。ウィンドウが開かず fallback=clipboard と出たときは、トークンをコピーした状態で `node bin/slack-issue-intake.ts set-token --from-clipboard` を実行します。
3. 対象チャンネルで /invite @Issue Intake を実行します。
4. Workflow Builder で、チャンネルのボタンから開始するワークフローを、次の3つ作ります。それぞれ「フォームで情報を収集」と「チャンネルへメッセージを送信」を追加し、テンプレートの {…} にフォームの変数を差し込みます。添付ファイルの変数も付けます。カテゴリはワークフローごとに決まっているので、フォームでは聞きません。

「バグを報告」
- タイトル: 短い回答、必須
- 優先度: リスト選択、必須（critical / high / middle / low）
- 事象: 長い回答、必須
- エラーログ: 長い回答、任意
- 対応策: 長い回答、任意
- 画面のURL: 短い回答、任意
- ソースコードのパス: 短い回答、任意
- 添付ファイル: アップロード、任意、複数可。1ファイルだけなら任意のアップロードの質問を3つ並べます。
「チャンネルへメッセージを送信」のテンプレート:

~~~text
[issue-intake]
*タイトル:* {タイトル}
*カテゴリ:* バグ
*優先度:* {優先度}
*起票者:* {フォームを送信した人}

*事象:*
```
{事象}
```

*エラーログ:*
```
{エラーログ}
```

*対応策:*
```
{対応策}
```

*画面のURL:* {画面のURL}

*ソースコードのパス:* {ソースコードのパス}
~~~

「要望を送る」
- タイトル: 短い回答、必須
- 優先度: リスト選択、必須（critical / high / middle / low）
- 現在: 長い回答、必須
- 理想: 長い回答、必須
- 画面のURL: 短い回答、任意
- ソースコードのパス: 短い回答、任意
- 添付ファイル: アップロード、任意、複数可。1ファイルだけなら任意のアップロードの質問を3つ並べます。
「チャンネルへメッセージを送信」のテンプレート:

~~~text
[issue-intake]
*タイトル:* {タイトル}
*カテゴリ:* 要望
*優先度:* {優先度}
*起票者:* {フォームを送信した人}

*現在:*
```
{現在}
```

*理想:*
```
{理想}
```

*画面のURL:* {画面のURL}

*ソースコードのパス:* {ソースコードのパス}
~~~

「新機能を提案」
- タイトル: 短い回答、必須
- 優先度: リスト選択、必須（critical / high / middle / low）
- 仕様: 長い回答、必須
- 添付ファイル: アップロード、任意、複数可。1ファイルだけなら任意のアップロードの質問を3つ並べます。
「チャンネルへメッセージを送信」のテンプレート:

~~~text
[issue-intake]
*タイトル:* {タイトル}
*カテゴリ:* 新機能
*優先度:* {優先度}
*起票者:* {フォームを送信した人}

*仕様:*
```
{仕様}
```
~~~

公開したら、チャンネルの「ワークフロー」タブ →「ワークフローを目立たせる」で3つすべてを選び、「注目」を押します。メンバーには入力欄の所にボタンが出ます。
5. チャンネル名 → 詳細の最下部からチャンネルIDを控えます。
6. `node bin/slack-issue-intake.ts init --channel <ID> --repo <owner/name> --every 5` を実行します。automation は無効で登録されます。
7. `node bin/slack-issue-intake.ts permissions --show` で内容を確認し、承認してから `node bin/slack-issue-intake.ts permissions --apply` を実行します。
8. `node bin/slack-issue-intake.ts enable` を実行します。受け継ぐ許可があれば内容を確認し、承認したときだけ `--accept-inherited` を付けます。
Orca の Claude 起動引数へ --permission-mode や --allowedTools など許可を広げるものを入れないでください。
最初の実行で bypass モードになっていないことを確認してください。bypass なら automation を無効にし、既定引数の --dangerously-skip-permissions を外してください。

### Workflow Builder で手で作る

上の手順 4 の詳しい版です。Slack の画面の文言は言語設定などで変わるため、英語の表示名を括弧に添えています。

1. ワークスペース名 → ツール → Workflow Builder を開き、新しいワークフローを作ります（バグ・要望・新機能の 3 つ。以下をそれぞれ行います）。開始のきっかけには、Slack のリンクから始める（From a link in Slack）を選びます。
2. フォームで情報を集めるステップ（Collect info in a form）を足し、質問を作ります。ワークフローはカテゴリごとに 3 つ作り、質問は上の手順 4 のとおりにします。カテゴリはワークフローで決まるので、フォームでは聞きません。質問の名前は一字一句このとおりにします。文字が違うと投稿を読み取れず、ボットが理由をスレッドに返します。添付ファイルは複数可にします。1個しか受けられない場合は、任意のアップロードの質問を3つ並べます。
3. チャンネルにメッセージを送るステップ（Send a message to a channel）を足し、送り先に対象チャンネルを選びます。メッセージには、上の手順 4 のそのカテゴリのテンプレートをそのまま使い、`{…}` の所にフォームの変数を差し込みます。添付ファイルの変数もメッセージに付けます。
4. 3 つとも公開（Publish）したら、チャンネルの「ワークフロー」タブ →「ワークフローを目立たせる」で 3 つすべてを選び、「注目」を押します。メンバーには入力欄の所にボタンが並びます。
5. 1件送り、`node bin/slack-issue-intake.ts inspect --raw` で `marker=yes`、`parse=ok`、`reporter=U…`、添付の数と同じ `files=` を確かめます。

## 動作確認

1. Orca の既定の Claude 起動引数に --permission-mode や --allowedTools など許可を広げるものがないことを確認します。
2. enable 前は automation が無効、precheck が `<launcher> poll` であることを確かめます。
3. `node bin/slack-issue-intake.ts enable` のあとに `orca automations run <id>` で最初の回を動かし、permission mode が bypass ではなく、手順外の操作が拒否されることを確認します。bypass なら `orca automations edit <id> --disabled` で止め、既定引数から --dangerously-skip-permissions を外してから試し直します。
4. `make setup` でフォームを作った場合は、チャンネルの入力欄の所に出るボタンからフォームのダイアログが開けることを確かめます。添付付きで送った投稿を `node bin/slack-issue-intake.ts inspect --raw` で見て、marker=yes、parse=ok、起票者の ID、添付の数だけの files があることを確認します。投稿者はこのアプリのボット（bot=yes）です。添付なしでも送れることも確かめます。
5. フォームから添付2個以上を投稿し、`node bin/slack-issue-intake.ts inspect --raw` で marker=yes、parse=ok、起票者と添付数を確認します。API 上の text / blocks、files / file permalink の形は実環境で未確認です。Workflow Builder で作った場合、1質問で1ファイルだけなら任意アップロードを3質問にします。
6. 明確なバグ報告で、ラベル・添付リンク付きの Issue とスレッドの URL を確認します。曖昧な投稿には質問が届き、人が返信したら次の回で拾うことを確認します。Bot トークンの conversations.replies が対象チャンネルで読めるかもここで確認します。
7. 不正なカテゴリは理由を返信し、何も投稿しない15分間は skipped_precheck だけで Claude が起動しないことを確かめます。
8. user の allow を追加すると permissions=changed で止まることを確認し、一覧を承認して `node bin/slack-issue-intake.ts enable --accept-inherited` で戻します。

## 運用

`init` は、安定パス `~/.slack-issue-intake/bin/slack-issue-intake` を作ります。運用ではこちらを使います。`node bin/slack-issue-intake.ts …` と同じ働きで、プラグインを更新してもパスは変わりません。以下のコマンドは、どちらの形でも実行できます。

- `~/.slack-issue-intake/bin/slack-issue-intake status`: 件数、返信待ち、失敗、リース、読み取り位置、直近の poll、権限の状態。
- `~/.slack-issue-intake/bin/slack-issue-intake retry --id N`: 失敗を直前の状態へ戻す。メタデータの一時取得失敗も連続10回で failed になり、状態とエラーを確認できます。作成開始時刻・アカウント・作成中の印は残ります。
- `~/.slack-issue-intake/bin/slack-issue-intake inspect [--limit N] [--raw]`: 状態を変えず最新の投稿の解析結果を確認。
- `~/.slack-issue-intake/bin/slack-issue-intake form`（`make slack-form`）: フォームのボタンを作り、チャンネルのおすすめワークフローにする（入力欄の所にボタンが出る）。`make setup` の6段目が実行します。`~/.slack-issue-intake/bin/slack-issue-intake form --manifest`（`make manifest`）はフォーム付きのマニフェストを表示します。
- `~/.slack-issue-intake/bin/slack-issue-intake set-token`: トークンを登録し直す。開いたウィンドウに貼り付けます（文字は伏せ字）。`--from-clipboard` はクリップボードから、`--from-stdin` は人がつないだパイプから読みます。
- `~/.slack-issue-intake/bin/slack-issue-intake permissions --show` → 承認して `~/.slack-issue-intake/bin/slack-issue-intake permissions --apply` → `~/.slack-issue-intake/bin/slack-issue-intake enable`。継承した allow / additionalDirectories があると明示承認が必要です。
- 停止: `orca automations edit <id> --disabled`。

権限が変わると changed または unsafe で止まり、設定を直して enable をやり直します。`creating … inflight=` がある間は送り手の終了と待機時間を待ちます。印を消して作り直してはいけません。
`poll` は仕事あり0、仕事なし・処理中・権限不備1、未設定2、Slack の致命エラー3です。45秒の予算を各外部呼び出しへ渡します。手動 Run now は precheck を通りません。collect は自分で同期します。

## 制約

- 添付バイナリは GitHub に上げません。Issue には Slack の file permalink を載せます。Slack にログインした人だけが開けます。画像5MB、テキスト・JSON 1MBまでを判断用にダウンロードします。各メッセージ10ファイルまで、Issue のリンク一覧は50件までです。本文全体の60,000文字に収まらないときは、リンクを途中で切らず末尾から省き、省略件数を表示します。
- Mac 1台で、Orca が開き Mac が起きている間だけ動きます。停止中の履歴は起床後にページ単位で追いつきます。init より前は拾いません。
- precheck の結果は Orca の実行履歴に skipped_precheck として溜まります。5分間隔なら1日288行です。
- クラッシュの間合いによって Slack の返信がまれに重複します。
- 送り先は1組（チャンネル、repo、ワークスペース、gh のログイン名）で固定します。変更する場合は automation を止め、ホームを退避して設定し直します。
- Issue 作成後の返信同期、クローズ通知、Webhook、常駐プロセス、複数の送り先は対象外です。

## 重複防止の保証の範囲

1. すべての送り手が同じ Mac で動くこと。
2. 要求を送りうる親と gh の子がすべて止まってから90秒以内に、GitHub がすでに受け取った要求を処理し終えること。
3. 運用中に gh のアカウントを変えないこと（変わったら作成を止めます）。

送り手の PID と起動時刻を保存し、生きている間は作り直しません。すべて止まったと初めて確認した時刻から90秒待ち、一覧の全ページを作者と最後の行のマーカーで照合します。子は身元を DB に記録してから go を送るゲートを通ります。応答を失っても、次の処理は一覧で採用します。

## セキュリティ

Claude は run ごとの work.json と添付を読み、decisions.json だけに判断を書きます。送り先・タイトル・ラベルと副作用は CLI が管理します。投稿・返信・添付内の指示には従いません。
project は dontAsk と disableBypassPermissionsMode、実行コマンドとファイルの限定 allow、外部操作の deny を持ちます。user には secrets.json の Read / Edit の deny を足します。token は0600、ホームは0700で保存し、外部文字列は保存・出力前に伏せます。
enable は必要な設定、local 設定の不在、managed モード、秘密ファイルの deny を検査します。project 全体と user / managed の permissions 全体の指紋を保存し、poll は毎回検査と指紋の一致を確認します。allow だけでなく deny やモードの変化でも止まります。
hook と mod による承認は検査・指紋の対象外です。Orca が加える既定引数も読み取れないため、許可を広げる引数がないことが前提です。--dangerously-skip-permissions を拒む設定が実際に dontAsk を保つかは初回の動作確認で確かめます。

## テスト

```bash
bash test/run-all.sh
pnpm --filter @tanaka-yui/slack-issue-intake check
```

Slack、gh、Orca をローカルの試験用サーバー・実行ファイルへ差し替えます。実サービスには接続しません。受け入れ確認は上の「動作確認」を実環境で行います。
