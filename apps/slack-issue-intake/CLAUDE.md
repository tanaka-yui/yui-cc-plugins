# slack-issue-intake 開発ガイド

## 構成

bin が入口と安定パスのランチャー、lib が取得・状態・副作用・管理コマンド、skills が対話と無人の手順、test が模擬 Slack / gh / Orca を使う検証です。実行時依存はありません。

## 手順と状態の正本

無人手順の正本は `skills/slack-issue-intake/references/procedure.md`。変更時は procedure-ja.md、lib/permissions.ts、CA9 を揃えます。Claude が書くのは今回の decisions.json だけです。Slack / GitHub へ送るのは apply と poll です。
状態遷移は lib/db.ts と設計書の6.5節に対応します。起動できる設定かの検査と権限の指紋を分け、poll の毎回で両方を確認します。

## リースとフェンシング

状態、履歴区間、cursor、作成中の印はフェンス付きの比較更新で書きます。副作用の直前は renewLease。setInflightChild だけは持ち主 PID を条件に記録し、リース喪失後も送り手の身元を残します。
Issue の作成は、持ち主と子がすべて止まったと確認するまで再開しません。停止を初めて確認した時刻から90秒待ち、一覧の全ページで作者と最終行のマーカーを照合します。子はゲートで待ち、DB に身元を書いてから go を送ります。書く前に親が死ねば gh は起動されません。

## run のディレクトリ

各 run は連番付き台帳に登録してから作成します。消せるのは自分の runId と、台帳で自分より前の連番だけです。後から登録された run は消しません。Issue 本文の一時ファイルも台帳に登録した独立の run/runs/UUID に置きます。強制終了で残ったものは、次の collect が前の連番として片付けます。古い処理は新しいファイルを壊せません。

## 締め切り・ランチャー・定数

すべての Slack / gh 呼び出しへ deadline を渡します。残り時間がなければ呼びません。poll の予算は45秒です。
ランチャーは dev-digest の bin/launch.ts を元にし、lib を読みません。定数の写しと LAUNCHER_VERSION の重複だけを認め、LA2 で一致を確かめます。固定値は lib/defaults.ts にまとめます。添付リンクだけで上限に達する場合は、リンクを丸ごと省いて件数を示します。必須の骨組みすら収まらなければ送信せず失敗を記録します。

## セットアップのウィザード

`make setup`（`setup` サブコマンド、lib/commands/setup.ts）は8段で、済んだ段は飛ばして再開します。設定と automation がそろっていれば、送り先は変えずに今の設定を見せて間隔だけ聞き直し、変わったときだけ `init --every` で automation を書き換えます。プロジェクトにアプリの記録が無いときは既存のアプリ ID を聞き、入力されたら `slack app link --app <ID> --environment deployed`（チームが分かれば `--team`）でつないでから deploy します（Slack CLI は名前でアプリを探せないため）。文言は lib/defaults.ts の SETUP_TEXT と MSG_FORM_* で、README の節名「Slack CLI を使わないセットアップ」「Workflow Builder で手で作る」を指します。名前を変えるときは両方を揃えます。入力は端末だけを読み、子のコマンドには stdin を渡しません。
Slack CLI のプロジェクトはホームの隣の `<ホーム>-slack-app`（既定 `~/.slack-issue-intake-slack-app/`、0700）に置きます。Slack CLI が `.slack/apps.json` にアプリ ID を書くので、プラグインのディレクトリ（更新で入れ替わる）にもホーム（退避で一緒に動く）にも置きません。`.slack/hooks.json` と form-trigger-<種類>.json は毎回書き直します（setup の毎回と form の開始時。プラグインの更新でパスが変わるため）。`.slack/config.json` は Slack CLI が書いた項目を残して manifest.source だけを local にし、apps.json は読むだけです。
トークンは deploy フックで受け取ります。Slack CLI がインストール後に `SLACK_BOT_TOKEN` を入れてフックを起こすので、`slack-hook deploy` は最初にマニフェストの指紋（SHA-256）を残し、トークンを secrets.json に保存します。setup は deploy の前に指紋を消すので、deploy のあとに指紋が無ければフックまで進まなかった（アプリが無い）とみなし、set-token ではなく deploy の失敗を示します。設定があれば、そのチームを `--team` に渡します。指紋が変わると次の setup で deploy し直します。実装上の動きで、約束された仕様ではありません。受け取れなければ set-token への案内で止まります。
`slack deploy` には `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` / `SLACK_USER_TOKEN` を除いた環境を渡します。Slack CLI は環境に既にある値を上書きせず使うので、残すと別のトークンを保存してしまいます。
`form`（make slack-form）は `slack trigger create` でカテゴリごとの3つのボタン（FORM_KINDS の順）、`slack trigger access` で使える人（チャンネルのメンバー）、ボットのトークンの workflows.featured.add（bookmarks:write）でチャンネルのおすすめワークフローにして入力欄の所にボタンを出し、ID を meta（form_trigger_id:<種類> など）に残して再実行で重ねません。0.2 の1つのボタン（キーが form_trigger_id のまま）は、3つをおすすめにしたあとで workflows.featured.remove と slack trigger delete で片付けます。消せなければ印を残して次の実行でやり直し、見つからない（not found）ものは消えたとみなします。おすすめが手作業の印（manual）の間は、新しいボタンが出るまで古いボタンを残します。deploy 済みの指紋が今のマニフェストと違えば、ボタンを作らず make setup へ案内して exit 2 で止まります。setup の6段は、3つのボタンとおすすめがそろい、古い印が無い（または manual の）ときだけ済みにします。bookmarks.add で関連ページに足したリンクは Slack が外部リンクとして扱いブラウザを開くので使いません。`form --manifest`（make manifest）は guide のマニフェストに、組み込みの open_form と send_message だけのワークフロー3つ、`org_deploy_enabled: true`、FORM_EXTRA_SCOPES を足して出します。通常のマニフェストは変えません。
投稿の形は lib/form-message.ts の1か所で作り、ワークフローと手で作る手順のテンプレートが共有します。解析器は新しい形（太字の項目名、コードブロック）と 0.2 の `本文:` の形の両方を読み、カテゴリ別の項目を「項目名:」の行と値にして本文に入れます。このワークフローは自分のボットとして投稿します。poll と inspect は自分の投稿でもマーカーで始まるものを受け付け、起票者は本文のメンションだけから取ります。自分の返信は常にスレッド内なので履歴には出ません。
Slack CLI の呼び先の差し替えは SLACK_ISSUE_INTAKE_SLACK_CLI（テスト専用）です。実環境では未確認の点（deploy の受理、フックへのトークン、trigger create、conversations.join、投稿の太字とコードブロック、3つのおすすめ、0.2 のボタンの片付け）があり、README に書いてあります。

## 試験と秘密

テスト専用の差し替えは SLACK_ISSUE_INTAKE_HOME、SLACK_ISSUE_INTAKE_API_BASE（loopback のみ）、SLACK_ISSUE_INTAKE_CLAUDE_HOME。Orca の呼び先には ORCA_BIN を使えます。本番の設定手順にテスト変数を使いません。
外部文字列を出力・保存する前に maskSecrets を通します。トークンを argv に置きません。実テストは `bash test/run-all.sh`、型と lint はワークスペースの check です。実サービスへの受け入れ確認は README に分けています。

添付・名前のメタデータ取得は成功と失敗を区別します。一時失敗はその件を skipped にし、記録済みの files・transcript・名前を空で確定しません。連続スキップは attempts に数え、MAX_ACTION_ATTEMPTS で failed にして lastError を残します。取得が成功したら回数をリセットします。恒久的に見えない名前は以前の値か不明、見えない添付はその1件だけを除外して進めます。認証などの致命エラーは縮退せず停止します。--now は検証済みの loopback API を使う試験環境だけで受け付けます。

プロセスの身元を読む ps は UTC / C ロケールで実行します。実行元の TZ の違いを PID の再利用と取り違えません。
