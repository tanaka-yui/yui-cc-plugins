# slack-issue-intake: ワークスペースごとの受付（名前つきのホーム）

対象: `apps/slack-issue-intake`。

## 目的

ユーザーは Slack のワークスペースをたくさん持っていて、ワークスペースごとに Slack アプリが違う。ワークスペースごとに slack-issue-intake を設定したい（2026-11-18 のユーザーの言葉: 「slack の workspace たくさんあるので、それごとに設定したい」）。

今は、トークン・設定・DB・Slack CLI のプロジェクトがホーム（`~/.slack-issue-intake`）に 1 つずつしか無い。2 つ目のワークスペースで `make setup` を走らせても、1 つ目のトークンがあるので「Slack アプリを作ってトークンを登録する … 済み」になり、入口が無い。

## やること

- **名前つきのホーム**: `make setup NAME=<名前>` で、ホームを `~/.slack-issue-intake-<名前>` にする。Slack CLI のプロジェクトは今の規則（ホームの隣の `<ホーム>-slack-app`）のまま `~/.slack-issue-intake-<名前>-slack-app` になる。
- **名前を付けないときは今のまま**: ホームは `~/.slack-issue-intake`。今の設定・automation・`--auto` の `intakeConfig` の既定はそのまま動く。
- **CLI の `--name <名前>`**: すべてのサブコマンドの前に置ける共通のオプションにする（`slack-issue-intake.ts --name ws2 status` の形）。ホームを決めるのはこの 1 か所。`SLACK_ISSUE_INTAKE_HOME` は今のままテスト専用で、`--name` と両方あれば失敗にする（どちらのホームか分からないため）。
- **名前の検査**: 英小文字・数字・`-` だけ、1〜32 文字、先頭は英小文字か数字（パスと automation の名前に入るため）。`-slack-app` で終わる名前は不可（下の `--auto` の節）。
- **Makefile**: `setup`・`manifest`・`slack-form` が `NAME` を受け取り、あれば `--name` を渡す。
- **automation の名前**: 名前つきのホームでは `slack-issue-intake-<名前>`、名前なしは今の `slack-issue-intake`。automation は設定に記録した id で引くので、名前は Orca の画面で見分けるため。
- **skill**: 状態・再実行・調べる・トークン登録などの対話の手順で、複数のホームがあるときはどのワークスペースかを聞き、`--name` を付けて呼ぶ。ホームの一覧は `~/.slack-issue-intake` と `~/.slack-issue-intake-*`（`-slack-app` で終わるものを除く）から作る。
- **文書**: README・SKILL.md・guide-ja.md・CLAUDE.md に、ワークスペースごとに `NAME` を付けて setup することを書く。

## automation の数（2026-11-18 のユーザーの質問への答え）

**ワークスペースごとに 1 つ**にする（私の判断）。automation は Orca が親の PC で動かすもので、PC は 1 台（ほかのマシンには要らない）。

- 1 つの automation で全部のワークスペースを回す形は採らない。poll の予算（45 秒）がワークスペースの数だけ積み上がって precheck の時間切れに近づくこと、1 つのワークスペースの失敗（トークン切れなど）が他を止めること、判定の Claude の権限と指紋をホームごとに分けている今の作りを崩すことが理由。
- automation が増えても、precheck は Slack を読むだけで、Claude は起票が要るときだけ起きる。費用は起票の数で決まり、automation の数ではほぼ増えない。

## `--auto`（orca-team-dispatch-task）: intake の設定ファイルを複数読む

2026-11-18 にユーザーが選んだ: 「`--auto` も automation も親の PC に 1 つ」にまとめ、全部のワークスペースから起票された Issue を 1 本のキューで処理する。PR は今のとおり、実装したリポジトリごとにそのリポジトリの default ブランチへ作る（ワークスペースは関係ない）。

今は `--auto` の設定の `intakeConfig`（文字列 1 つ）の `repos` だけが拾う元の候補になる。`--auto` が Issue を拾うかはラベル（`from-slack` / `slack-thread`）で決めていて、どのワークスペースから起票されたかは見ていないので、候補を複数の intake の和にすれば足りる。

- 設定に `intakeConfigs`（空でない文字列の配列）を足す。古い `intakeConfig`（文字列）も読み、`[intakeConfig]` とみなす。両方あれば設定ごと不正。setup が書くのは `intakeConfigs` だけ（古いキーは書き直しのときに消える）。
- 拾う元の候補は、各 intake の `repos[].name` の和（設定の並び順、重複は 1 つ）。読めない intake は、その分を候補から外し、tick の出力に `intake の設定を読めません: <パス>` を 1 回出す（1 つの intake の不調で全部を止めない。私の判断）。
- setup の 2 段目: intake のホームを探して番号で並べ、複数選ばせる。探すのは `~/.slack-issue-intake/config.json` と `~/.slack-issue-intake-<名前>/config.json`（名前の規則は上の名前の検査と同じ）。既定は前に選んだもの、初回は見つかったもの全部。続けて「ほかの intake の設定ファイル（無ければ -）」で絶対パスを足せる。前に選んだ拾う元のうち、どの intake にも無いものは今のとおり「選べません」と出す。
- ホームの名前の規則（`.slack-issue-intake` と `.slack-issue-intake-<名前>`、名前の文字の規則）は 2 つのプラグインの約束にする。`scripts/check-shared-contracts.mjs` で一致を確かめる。
- 名前に `-slack-app` で終わるものを許さない（Slack CLI のプロジェクトの置き場所 `<ホーム>-slack-app` と見分けられなくなるため。slack-issue-intake の名前の検査にも入れる）。

## やらないこと

- 1 つのホームで複数のワークスペースを扱うこと。
- 今のホーム（`~/.slack-issue-intake`）を名前つきのホームへ移すこと。
- `--auto` の拾い方（ラベル）・振り分け・PR の作り方の変更。

## 作り方

| 案 | 判断 |
|---|---|
| **名前つきのホーム（`--name`）** | **採用**。実行時はもともとホーム単位で閉じている（ランチャーは `<ホーム>/bin/` に置かれて自分の場所からホームを決める、automation は id で引く）ので、入口でホームを選ぶだけで済む |
| 1 つのホームに複数のワークスペース | DB・poll・権限・報告を全部ワークスペースで分け直すことになり大きい |
| `SLACK_ISSUE_INTAKE_HOME` を本番でも使う | テスト専用の約束を崩し、automation の名前も重なる |

## 実機での確かめ（親が行う）

1. `make setup NAME=<2 つ目のワークスペース>` で、新しいホームと Slack のプロジェクトができ、そのワークスペースのアプリがつながってトークンが保存される。1 つ目のホームの `secrets.json` は変わらない。
2. `slack-issue-intake-<名前>` の automation ができ、precheck がそのホームを読む。
3. 名前なしの `make setup` は今までどおり 1 つ目のホームを使う。
4. `--auto` の `make setup` の 2 段目で 2 つのホームが並び、両方を選ぶと、両方の intake の `repos` が拾う元の候補になる。

## 作る人に任せること

- `--name` の取り出し方（`bin/slack-issue-intake.ts` で argv から先に取り除くなど）、skill の聞き方の文面、テストの組み方。
