# dev-digest

毎朝、開発ニュースを集めて Slack に届ける Claude Code プラグイン。Orca の automation が毎朝 Claude を無人で動かし、
要約と話題のまとめを作らせて送る。送ったものは SQLite の履歴に残り、あとから検索できる。

## できること

- 全体向けに 1 通: JVN（しきい値以上）/ AWS / Google Cloud / X / dev.to のセクション
- 監視リポジトリごとに 1 通: そのリポジトリが使う OSS の Releases と、関係する項目だけ（関係が 0 件なら送らない）
- 似た話題はソースをまたいで 1 つにまとめ、元のリンクは全部残す
- 取得に失敗したソースは全体の通知の末尾に書き、送れなかった送り先だけが翌朝に再送される
- 送った履歴を期間・セクション・リポジトリ・しきい値・語で検索する

## 前提

- Orca（内蔵ブラウザで X にログインしておく。automation と X の読み取りに使う）
- Node 24.15 以上（`node` が型除去で `.ts` を直接実行する。npm の依存は無い）
- Slack の Incoming Webhook URL（全体用に 1 つ。リポジトリ専用のチャンネルを使うなら、その分も）

## 使い方

プラグインを入れたら、Claude Code で `/dev-digest` か「開発速報を設定して」と話しかける。

- **init**: 実行時刻・毎日か平日か・JVN のしきい値・X のリスト URL（`https://x.com/` で始まるもの）・ハッシュタグ・
  dev.to のタグを決め、`~/.dev-digest/` と Orca の automation を作る。Webhook URL は非表示の入力ダイアログ
  （macOS）かクリップボードから登録する。続けて無人の実行に許す操作のルールを見せ、承認すると適用する。
  最後に Orca のブラウザで X にログインし、`orca automations run <id>` で最初の 1 回を動かせる
- **setup**: 監視したいリポジトリの中で実行する。直接依存とインフラの OSS（compose の image、Dockerfile の `FROM`、
  Helm、Kubernetes manifest、Terraform provider）から候補を作り、GitHub の owner/repo の訂正を受けて登録する。
  リポジトリ専用の Webhook も登録できる
- **search**: 「先月の AWS の Lambda の話は？」のように聞くと、履歴を検索して表とリンクで答える
- **list / remove**: 監視中のリポジトリの一覧と、監視の停止

毎朝の手順は `skills/dev-digest/references/morning.md`（日本語訳は `morning-ja.md`）が正本で、`procedure`
サブコマンドがこのマシンの値に置き換えて表示する。

## 秘密の扱いと、その限界

Webhook URL は Claude に読まれなければよい、という要件で作っている。

- 入力: macOS ではスクリプトが非表示のダイアログを出し、ユーザーが貼り付ける。出せない環境ではクリップボードから
  読む。どちらでも値は node のプロセスから `~/.dev-digest/secrets.json`（モード 0600）へ流れるだけで、標準出力・
  標準エラー・会話には出ない
- 出力: Webhook を表示するときは必ず伏せる（`https://hooks.slack.com/services/T***/…`）。エラーの文面も同じ
- 送信: Claude は送る本文を JSON に書くだけで、`publish` が `secrets.json` を自分で読んで送る
- skill の手順書は `secrets.json` を読まない・開かない・grep しないと書いている。init の `permissions --apply` は
  Claude Code の user 設定に `secrets.json` の Read / Edit の deny を足す

**限界**: シェルを使える AI がファイルを読むことは、技術的に完全には防げない。上の対策が保証するのは「通常の手順で
AI の目に触れない」ことと「うっかり読まない」ことまでである。macOS のキーチェーンに置く案もあるが、
`security find-generic-password -w` で同じく読めるので、優位は小さいと判断した。

**無人の実行の封じ込め**: 毎朝の実行は、信用できないフィードと X の本文を読む。本文に仕込まれた指示に従わされても
被害が広がらないよう、許可ルールで封じ込める。作業フォルダの allow はランチャーの朝のサブコマンド、
`orca tab close` / `snapshot` / `scroll`、作業フォルダの読み取り、`x.json` と `digest.json` だけへの書き込みに
絞る（`permissions --show` で確認できる）。

allow に無い操作が拒まれるのは、`permissions --apply` が作業フォルダの設定（`~/.dev-digest/run/.claude/settings.json`）
の `permissions.defaultMode` を `dontAsk` にするからである。`auto` などのモードでは allow に無い操作も自動で承認され
うるので、allow だけでは許可リストにならない。作業フォルダの設定は user の設定（`~/.claude/settings.json`）より
優先されるため、user の設定のモードは変えない。automation の起動のしかたでモードが上書きされると封じ込めは効かない。
**実際の朝の実行で、allow に無い操作が拒まれることを確かめること。**

**user の allow は朝の実行にも効く**: allow は user・project など全スコープのものが合わさる。dontAsk が拒むのは
「どのスコープの allow にも無い操作」だけなので、user の設定（`~/.claude/settings.json`）に書いた allow
（`Bash(git commit:*)` や `WebFetch(domain:...)` など）は、作業フォルダの朝の実行でもそのまま通る。封じ込めの範囲は
「作業フォルダの allow ＋ user の allow」であって、作業フォルダの allow だけではない。dev-digest は user の allow を
書き換えない。`permissions --show` の `inherited` にその一覧が出るので、無人の実行に許したくない広いルールが
あれば、ユーザーが自分で外すか、それを承知で使う。

**残るリスク**: `orca snapshot --page <id>` は、タブの id を推測されると別のタブを読めてしまう。
`orca tab close --page <id>` も同じで、id が分かれば X 以外のタブも閉じられる。Orca のブラウザで X 以外の
機密ページを開いたままにしないこと。

## 開発

`apps/dev-digest/CLAUDE.md` を読むこと。テストは `cd apps/dev-digest && bash test/run-all.sh`。
