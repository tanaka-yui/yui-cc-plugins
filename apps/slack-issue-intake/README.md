# slack-issue-intake

## 概要

Slack のワークフローのフォームから GitHub Issue を起票する Claude Code プラグインです。常駐サーバーは不要です。

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

Slack の有料プランと社内向けカスタムアプリ（配布しない）、同じ Mac の Node 24.15+、対象リポジトリの push 権限（WRITE 以上）があるアカウントで認証済みの GitHub CLI（gh）、起動中の Orca と Claude Code が必要です。

## セットアップ

先に `claude plugin marketplace update yui-cc-plugins` を実行し、`claude plugin install slack-issue-intake@yui-cc-plugins` で入れます。skill `/slack-issue-intake` から進めるか、`node <plugin>/bin/slack-issue-intake.ts guide` で以下の案内を表示します。フォームの作り方は、下の「フォームの作り方」に順を追って書いてあります。

1. https://api.slack.com/apps の Create New App → From a manifest で社内向けカスタムアプリを作り、ワークスペースにインストールします。配布しません。有料プランが必要です。
フォームも自動で作る場合は、下のマニフェストの代わりに form --manifest（make manifest）の出力を使います。フォームのワークフローと、ボタンを置くための権限（channels:read、groups:read、triggers:write、bookmarks:write）が加わります。作成済みのアプリは App Manifest の画面で置き換えて保存し、再インストールします。

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
        "users:read"
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
2. アプリの設定の OAuth & Permissions を開き、Bot User OAuth Token（xoxb- で始まる文字列）をコピーします。続けて set-token を実行します（skill で進めているときは Claude が実行します）。
「slack-issue-intake」という題の入力ウィンドウが開くので、⌘V で貼り付けて OK を押します。入力欄はパスワード用と同じで、貼った文字は見えません。「saved token=」で始まる行が出れば登録できています。
トークンは Claude との会話やコマンドの引数に書かないでください。会話に貼るとモデルに送られて記録にも残り、引数に書くとシェルの履歴に残ります。ウィンドウが開かず fallback=clipboard と出たときは、トークンをコピーした状態で set-token --from-clipboard を実行します。
3. 対象チャンネルで /invite @Issue Intake を実行します。
4. フォームを手で作る場合（上のマニフェストで作ったとき、または 7 の form が失敗したとき）は、Workflow Builder でチャンネルのボタンから開始するワークフローを作り、「フォームで情報を収集」を追加します。
- タイトル: 短い回答、必須
- カテゴリ: リスト選択、必須（バグ / 新機能 / 要望）
- 優先度: リスト選択、必須（critical / high / middle / low）
- 本文: 長い回答、必須
- 添付ファイル: アップロード、任意、複数可。1ファイルだけなら任意のアップロードの質問を3つ並べます。
次に「チャンネルへメッセージを送信」を追加し、以下のテンプレートの {…} にフォームの変数を差し込みます。添付ファイルの変数も付けます。

```text
[issue-intake]
タイトル: {タイトル}
カテゴリ: {カテゴリ}
優先度: {優先度}
起票者: {フォームを送信した人}
本文:
{本文}
```
5. チャンネル名 → 詳細の最下部からチャンネルIDを控えます。
6. init --channel <ID> --repo <owner/name> --every 5 を実行します。automation は無効で登録されます。
7. フォーム付きのマニフェストで作った場合は form（make slack-form）を実行し、対象チャンネルにフォームのボタン（ブックマーク）を置きます。
8. permissions --show で内容を確認し、承認してから permissions --apply を実行します。
9. enable を実行します。受け継ぐ許可があれば内容を確認し、承認したときだけ --accept-inherited を付けます。
Orca の Claude 起動引数へ --permission-mode や --allowedTools など許可を広げるものを入れないでください。
最初の実行で bypass モードになっていないことを確認してください。bypass なら automation を無効にし、既定引数の --dangerously-skip-permissions を外してください。

## フォームの作り方

フォームは、フォーム付きのマニフェストでアプリを作り、init のあとに `make slack-form` を実行すれば、対象チャンネルのボタン（ブックマーク「Issue を起票」）として付きます。Workflow Builder の画面で組み立てる必要はありません。

初めて作るときは「make で作る」の 1〜7 を順に進めます。途中で止まったら「うまくいかないとき」を、make で作れなかったら「Workflow Builder で手で作る」を開いてください。

> **未確認**: make で作る方法は、本物の Slack ではまだ試していません（2026-11-12 時点）。以下の画面の動きは想定です。特に、ボタンを作る Slack の API（`workflows.triggers.create`）は公式のリファレンスに載っておらず、ボットのトークンで受け付けられるかが分かっていません。

### 用意するもの

- 有料プランの Slack ワークスペースと、そこでアプリを作ってインストールできる権限
- Issue を受け付けるチャンネルと、Issue を作る GitHub リポジトリ
- このプラグイン。コマンドはすべてプラグインのディレクトリで実行します。このリポジトリでは `apps/slack-issue-intake`、プラグインとして入れた場合は `~/.claude/plugins/cache/yui-cc-plugins/slack-issue-intake/<版>` です。

### make で作る

1. **フォーム付きのマニフェストをコピーする。**

   ```bash
   make manifest | pbcopy
   ```

   make が無い環境では `node bin/slack-issue-intake.ts form --manifest | pbcopy` でも同じです。このマニフェストは、通常のものにフォームのワークフローと4つの権限を足したものです。足す権限は channels:read、groups:read、triggers:write、bookmarks:write です。

2. **マニフェストからアプリを作る。** https://api.slack.com/apps で Create New App → From an app manifest を選びます。ワークスペースを選んで Next を押し、JSON タブの中身を消してコピーした内容を貼り、Next → Create と進みます。フォームのワークフローは、このときアプリと一緒に登録されます。

   「Issue Intake」アプリを作成済みなら、新しく作らずに、そのアプリの App Manifest の画面で JSON を置き換えて保存します。

3. **インストールしてトークンを登録する。** アプリの設定の Install App で Install to Workspace を押し、許可します。作成済みのアプリは権限が増えたので、同じ画面でインストールし直します（Reinstall to Workspace）。

   インストールが済むと、OAuth & Permissions の画面に Bot User OAuth Token（`xoxb-` で始まる長い文字列）が出ます。このツールがチャンネルの投稿を読み、ボットとして返信するための鍵です。これをコピーしてから、次のコマンドを実行します。

   ```bash
   node bin/slack-issue-intake.ts set-token
   ```

   「slack-issue-intake」という題の小さなウィンドウが開きます。入力欄に ⌘V で貼り付けて OK を押します。入力欄はパスワード用と同じで、貼った文字は見えません。ターミナルに `saved token=xoxb-***` と出れば登録できています。トークンは `~/.slack-issue-intake/secrets.json` に、ほかのユーザーには読めない権限で保存されます。

   ウィンドウを使わずに、コピーした状態で `set-token --from-clipboard` を実行しても登録できます。クリップボードから直接読み込みます。

   トークンは Claude との会話やコマンドの引数に書かないでください。会話に貼るとモデルに送られて記録にも残り、引数に書くとシェルの履歴に残ります。skill で進めているときは、Claude が set-token を実行して同じウィンドウを開きます。

4. **ボットをチャンネルに招待し、チャンネル ID を控える。** 対象チャンネルで `/invite @Issue Intake` を実行します。ボットがチャンネルにいないと、フォームの投稿もブックマークの追加もできないためです。チャンネル ID（`C` で始まる）は、チャンネル名 → 詳細の最下部にあります。

5. **init で送り先を設定する。**

   ```bash
   node bin/slack-issue-intake.ts init --channel C0123456789 --repo owner/name --every 5
   ```

   ボタンを押したときの投稿先は、ここで設定したチャンネルになります。そのため、ボタンは init のあとでないと作れません。init は gh の認証やリポジトリの権限も確かめるので、止まったら表示された理由を直してから再実行します。

6. **チャンネルにボタンを置く。**

   ```bash
   make slack-form
   ```

   `url=https://slack.com/shortcuts/…` が出れば成功です。チャンネル上部のブックマークに「Issue を起票」が付く想定です。押せるのはこのチャンネルのメンバーだけです。何度実行しても、ボタンとブックマークは増えません。

7. **試しに1件送って確かめる。** ブックマークの「Issue を起票」を押すと、フォームが開く想定です。項目はタイトル、カテゴリ（バグ / 新機能 / 要望）、優先度（critical / high / middle / low）、本文、添付ファイル（任意、10個まで）の5つです。送ると、Issue Intake の名前で次のような投稿がチャンネルに出ます。

   ```text
   [issue-intake]
   タイトル: ログインできない
   カテゴリ: バグ
   優先度: high
   起票者: @送った人
   本文:
   ログイン画面でパスワードを入れても先に進めません。
   ```

   投稿を読めているかは inspect で確かめます。

   ```bash
   node bin/slack-issue-intake.ts inspect --raw
   ```

   いま送った投稿の行に `marker=yes`、`parse=ok`、`reporter=U…`、添付の数と同じ `files=` が出ていれば完成です。添付なしでも送れるかも試してください。このあとは「セットアップ」の手順 8・9（permissions と enable）に進みます。

### うまくいかないとき

| 症状 | 対処 |
|---|---|
| アプリを作る画面がマニフェストを受け付けない | 通常のマニフェスト（「セットアップ」の手順 1）でアプリを作り、フォームは「Workflow Builder で手で作る」で作ります |
| `set-token` が「Bot User OAuth Token（xoxb-）ではありません。何も保存していません」で止まる | コピーした値が Bot User OAuth Token ではありません。OAuth & Permissions の Bot User OAuth Token をコピーし直して、もう一度実行します |
| `set-token` が `fallback=clipboard` と出て終わる | 入力ウィンドウを開けませんでした。トークンをコピーした状態で `set-token --from-clipboard` を実行します |
| `make slack-form` が「設定がありません」「トークンがありません」で止まる | set-token と init が済んでいません。「make で作る」の手順 3〜5 を先に進めます |
| 「Slack がフォームのボタンの作成を受け付けませんでした（missing_scope …）」 | アプリのマニフェストが通常のもののままです。手順 2 で置き換え、手順 3 でインストールし直してから再実行します |
| 同じ表示で、括弧の中が missing_scope 以外 | このボットのトークンではボタンを作れません。「Workflow Builder で手で作る」に切り替えます。括弧の中の詳細は、原因を調べるときに使うので控えておきます |
| 「ブックマークを追加できません（…）」 | ボタン自体はできています。表示された URL を、チャンネルのブックマークに手で追加します |
| 「トークンのワークスペースが設定と違います」 | 別のワークスペースのトークンが登録されています。このアプリのトークンで set-token をやり直します |
| ブックマークを消してしまった | `make slack-form` をもう一度実行すると `url=` が出るので、それを手でブックマークに追加します。自動では付け直しません |
| inspect で `parse=invalid` になる | `problems=` に、足りない項目や合わない選択肢が出ます。手で作った場合は、テンプレートと選択肢の文字を見直します |

### Workflow Builder で手で作る

make で作れなかったときや、通常のマニフェストでアプリを作ったときの方法です。インストールとトークンの登録、招待、init は「make で作る」の手順 3〜5 と同じです。Slack の画面の文言は言語設定などで変わるため、英語の表示名を括弧に添えています。

1. ワークスペース名 → ツール → Workflow Builder を開き、新しいワークフローを作ります。開始のきっかけには、Slack のリンクから始める（From a link in Slack）を選びます。
2. フォームで情報を集めるステップ（Collect info in a form）を足し、次の5つの質問を作ります。選択肢は一字一句このとおりにします。文字が違うと投稿を読み取れず、ボットが理由をスレッドに返します。

   | 質問 | 形式 | 必須 | 選択肢 |
   |---|---|---|---|
   | タイトル | 短い回答 | 必須 | ― |
   | カテゴリ | リストから選択 | 必須 | バグ / 新機能 / 要望 |
   | 優先度 | リストから選択 | 必須 | critical / high / middle / low |
   | 本文 | 長い回答 | 必須 | ― |
   | 添付ファイル | ファイルのアップロード | 任意 | 複数可。1個しか受けられない場合は、任意のアップロードの質問を3つ並べます |

3. チャンネルにメッセージを送るステップ（Send a message to a channel）を足し、送り先に対象チャンネルを選びます。メッセージには次のテンプレートをそのまま使い、`{…}` の所にフォームの変数を差し込みます。添付ファイルの変数もメッセージに付けます。

   ```text
   [issue-intake]
   タイトル: {タイトル}
   カテゴリ: {カテゴリ}
   優先度: {優先度}
   起票者: {フォームを送信した人}
   本文:
   {本文}
   ```

4. 公開（Publish）したら、ワークフローのリンクをコピーし、チャンネルのブックマークに追加します。
5. 「make で作る」の手順 7 と同じく、1件送って inspect で確かめます。

## 動作確認

1. Orca の既定の Claude 起動引数に --permission-mode や --allowedTools など許可を広げるものがないことを確認します。
2. enable 前は automation が無効、precheck が `<launcher> poll` であることを確かめます。
3. enable 後に `orca automations run <id>` で最初の回を動かし、permission mode が bypass ではなく、手順外の操作が拒否されることを確認します。bypass なら `orca automations edit <id> --disabled` で止め、既定引数から --dangerously-skip-permissions を外してから試し直します。
4. フォーム付きのマニフェストを使った場合は、次の順に確かめます。どこかで失敗したら、通常のマニフェストに戻して Workflow Builder で作ります。
   1. アプリの作成（または App Manifest の保存）でマニフェストが受け付けられること。
   2. `make slack-form` が `url=` を出し、チャンネルのブックマークからフォームが開けること。
   3. 添付付きで送った投稿を `inspect --raw` で見て、marker=yes、parse=ok、起票者の ID、添付の数だけの files があること。投稿者はこのアプリのボット（bot=yes）です。添付なしでも送れることも確かめます。
5. フォームから添付2個以上を投稿し、`inspect --raw` で marker=yes、parse=ok、起票者と添付数を確認します。API 上の text / blocks、files / file permalink の形は実環境で未確認です。Workflow Builder で作った場合、1質問で1ファイルだけなら任意アップロードを3質問にします。
6. 明確なバグ報告で、ラベル・添付リンク付きの Issue とスレッドの URL を確認します。曖昧な投稿には質問が届き、人が返信したら次の回で拾うことを確認します。Bot トークンの conversations.replies が対象チャンネルで読めるかもここで確認します。
7. 不正なカテゴリは理由を返信し、何も投稿しない15分間は skipped_precheck だけで Claude が起動しないことを確かめます。
8. user の allow を追加すると permissions=changed で止まることを確認し、一覧を承認して enable --accept-inherited で戻します。

## 運用

安定パスは `~/.slack-issue-intake/bin/slack-issue-intake`。以後はこのコマンドで操作できます。

- `status`: 件数、返信待ち、失敗、リース、読み取り位置、直近の poll、権限の状態。
- `retry --id N`: 失敗を直前の状態へ戻す。メタデータの一時取得失敗も連続10回で failed になり、状態とエラーを確認できます。作成開始時刻・アカウント・作成中の印は残ります。
- `inspect [--limit N] [--raw]`: 状態を変えず最新の投稿の解析結果を確認。
- `form`（`make slack-form`）: フォームのボタンとブックマークを置く。`form --manifest`（`make manifest`）はフォーム付きのマニフェストを表示。
- `set-token`: トークンを登録し直す。開いたウィンドウに貼り付けます（文字は伏せ字）。`--from-clipboard` はクリップボードから、`--from-stdin` は人がつないだパイプから読みます。
- `permissions --show` → 承認して `permissions --apply` → `enable`。継承した allow / additionalDirectories があると明示承認が必要です。
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
