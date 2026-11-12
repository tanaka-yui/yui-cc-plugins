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

先に `claude plugin marketplace update yui-cc-plugins` を実行し、`claude plugin install slack-issue-intake@yui-cc-plugins` で入れます。skill `/slack-issue-intake` から進めるか、`node <plugin>/bin/slack-issue-intake.ts guide` で以下の案内を表示します。

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
2. Bot User OAuth Token は会話へ貼らず set-token の隠し入力で登録します。
3. 対象チャンネルで /invite @Issue Intake を実行します。
4. Workflow Builder でチャンネルのボタンから開始するワークフローを作り、「フォームで情報を収集」を追加します。
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
7. permissions --show で内容を確認し、承認してから permissions --apply を実行します。
8. enable を実行します。受け継ぐ許可があれば内容を確認し、承認したときだけ --accept-inherited を付けます。
Orca の Claude 起動引数へ --permission-mode や --allowedTools など許可を広げるものを入れないでください。
最初の実行で bypass モードになっていないことを確認してください。bypass なら automation を無効にし、既定引数の --dangerously-skip-permissions を外してください。


## 動作確認

1. Orca の既定の Claude 起動引数に --permission-mode や --allowedTools など許可を広げるものがないことを確認します。
2. enable 前は automation が無効、precheck が `<launcher> poll` であることを確かめます。
3. enable 後に `orca automations run <id>` で最初の回を動かし、permission mode が bypass ではなく、手順外の操作が拒否されることを確認します。bypass なら `orca automations edit <id> --disabled` で止め、既定引数から --dangerously-skip-permissions を外してから試し直します。
4. フォームから添付2個以上を投稿し、`inspect --raw` で marker=yes、parse=ok、起票者と添付数を確認します。API 上の text / blocks、files / file permalink の形は実環境で未確認です。1質問で1ファイルだけなら任意アップロードを3質問にします。
5. 明確なバグ報告で、ラベル・添付リンク付きの Issue とスレッドの URL を確認します。曖昧な投稿には質問が届き、人が返信したら次の回で拾うことを確認します。Bot トークンの conversations.replies が対象チャンネルで読めるかもここで確認します。
6. 不正なカテゴリは理由を返信し、何も投稿しない15分間は skipped_precheck だけで Claude が起動しないことを確かめます。
7. user の allow を追加すると permissions=changed で止まることを確認し、一覧を承認して enable --accept-inherited で戻します。

## 運用

安定パスは `~/.slack-issue-intake/bin/slack-issue-intake`。以後はこのコマンドで操作できます。

- `status`: 件数、返信待ち、失敗、リース、読み取り位置、直近の poll、権限の状態。
- `retry --id N`: 失敗を直前の状態へ戻す。メタデータの一時取得失敗も連続10回で failed になり、状態とエラーを確認できます。作成開始時刻・アカウント・作成中の印は残ります。
- `inspect [--limit N] [--raw]`: 状態を変えず最新の投稿の解析結果を確認。
- `set-token`: 隠し入力で登録。会話に値を貼りません。必要に応じて --from-clipboard / --from-stdin（人が操作するパイプ）を使えます。
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
