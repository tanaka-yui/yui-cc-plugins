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

各 run は連番付き台帳に登録してから作成します。消せるのは自分の runId と、台帳で自分より前の連番だけです。後から登録された run は消しません。Issue 本文の一時ファイルも独立した run/runs/UUID に置きます。古い処理は新しいファイルを壊せません。

## 締め切り・ランチャー・定数

すべての Slack / gh 呼び出しへ deadline を渡します。残り時間がなければ呼びません。poll の予算は45秒です。
ランチャーは dev-digest の bin/launch.ts を元にし、lib を読みません。定数の写しと LAUNCHER_VERSION の重複だけを認め、LA2 で一致を確かめます。固定値は lib/defaults.ts にまとめます。

## 試験と秘密

テスト専用の差し替えは SLACK_ISSUE_INTAKE_HOME、SLACK_ISSUE_INTAKE_API_BASE（loopback のみ）、SLACK_ISSUE_INTAKE_CLAUDE_HOME。Orca の呼び先には ORCA_BIN を使えます。本番の設定手順にテスト変数を使いません。
外部文字列を出力・保存する前に maskSecrets を通します。トークンを argv に置きません。実テストは `bash test/run-all.sh`、型と lint はワークスペースの check です。実サービスへの受け入れ確認は README に分けています。
