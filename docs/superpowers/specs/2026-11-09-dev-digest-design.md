# dev-digest 設計

毎朝、開発に関わる最新情報（クラウドのアップデート・脆弱性・AI 界隈の発言・技術記事）を集めて要約し、
Slack に送る。監視したいリポジトリごとに「関係する情報」も拾い、どのリポジトリの話かを付けて送る。
集めたものはローカルの SQLite に残し、あとで Claude に聞いて調べられるようにする。

この文書の「（判断）」は会話の中で筆者（Claude）が決めたもので、ユーザーが明示的に決めたものではない。
無印の決定はユーザーが決めたもの。

## 1. 目的と背景

- AWS のアップデートや脆弱性を、あとから気づくのではなく朝のうちに知りたい
- **優先度は付けない。新着は全部載せる**（ユーザー指定）
- 複数のリポジトリを監視する。各リポジトリが使う言語・ライブラリ・OSS（Keycloak のようなミドルウェアも含む）・
  クラウドのサービスに関係する情報を、リポジトリ名付きで知らせる
- あとで「先月の Keycloak の脆弱性は？」と Claude に聞いて答えられるよう、履歴を残す

### 非目標

- 重要度の判定・ランキング・フィルタによる間引き（JVN の深刻度のしきい値は除く）
- ベクトル検索・埋め込み（必要になったら後で足す。今回は作らない）
- 実行時刻の既定値の決定（ユーザーが `init` で答える）
- Web UI・ダッシュボード

### 反目標（動いても失敗とみなすもの）

- **Slack の Webhook URL を Claude が読む・表示する**。プロンプト・automation 設定・会話・
  スクリプトの stdout のどこにも平文で出してはならない（ユーザー指定: 「Claude に読み取られなければ OK」）
- 同じ記事やポストを翌朝以降にもう一度流す
- 1 つのソースの失敗（X のログイン切れなど）で全体の通知が止まる

## 2. 全体の形

```
[Orca automation（ユーザーが作成・時刻はユーザーが決める）]
        │ 短いプロンプト: 安定パスのランチャーが出す手順に従え
        ▼
[Claude が ~/.dev-digest/run/ のフォルダワークスペースで起動]
   1. collect   … スクリプトが RSS / Atom を全部取得し、SQLite に新着を入れる
   2. X         … AI が Orca 内蔵ブラウザで X のリスト・ハッシュタグ検索を読み、取り込みスクリプトへ渡す
   3. digest    … AI が新着を日本語で要約・似た話題をまとめ・各リポジトリとの関係を判定し、JSON に書く
   4. publish   … スクリプトが JSON を検証し、Slack へ送る（全体 1 通 + リポジトリごとに 1 通）
                  Webhook URL はスクリプトが secrets から自分で読む
```

- 取得・既読管理・送信は決定的なスクリプト、要約と関連判定は AI、という分担
- automation は 1 本だけ。毎朝 1 回、全ソースを 1 度取得し、全リポジトリ分をまとめて判定する（判断）

## 3. 情報源

### 全体向け（全員に送る）

| ソース | URL | 備考 |
|---|---|---|
| AWS What's New | `https://aws.amazon.com/about-aws/whats-new/recent/feed/` | 公式のサービス更新。dev.to にはこれが無いので直接取る |
| AWS News Blog | `https://aws.amazon.com/blogs/aws/feed/` | |
| Google Cloud リリースノート | `https://cloud.google.com/feeds/gcp-release-notes.xml` | Atom。日付ごとに 1 エントリで中に複数サービスの更新が入る |
| Google Cloud ブログ | `https://cloudblog.withgoogle.com/rss/` | |
| dev.to | `https://dev.to/feed`（最新 12 件）と、設定したタグの `https://dev.to/feed/tag/<tag>` | 全体向けのタグ一覧は設定で持つ。既定のタグは（判断）`aws` `googlecloud` `ai` `security` |
| JVN | `https://jvndb.jvn.jp/ja/rss/jvndb_new.rdf` | **JVN iPedia の新着**を使う（判断）。各項目の `sec:cvss` に `severity="Critical"` が付くので機械的に絞り込める。**送る深刻度のしきい値は選べる**（ユーザー指定: 「High 以上とか選べるように」。§4.1）。ユーザーは jvn.jp と言ったが、jvn.jp の RSS には深刻度の属性が無い |
| X | AI 関連の人を集めた **X のリスト**の URL、AI 関連のハッシュタグ | Orca 内蔵ブラウザで読む（§6）。リストを読む方式はユーザーが選んだ |

すべて 2026-11-09 に取得できることを確認済み（X を除く）。

### リポジトリ向け（そのリポジトリの通知に載せる）

- 監視対象の OSS / ライブラリの **GitHub Releases の Atom**（`https://github.com/<owner>/<repo>/releases.atom`）
- そのリポジトリが使う AWS / GCP サービスに関係する、全体向けソースの項目（AI が判定）
- JVN のうちそのリポジトリのしきい値以上で、そのリポジトリの OSS / ライブラリに関係するもの（AI が判定。製品名の一致を手がかりにする）
- dev.to のタグフィード（リポジトリ設定にタグがあれば）
- X のポストのうち関係するもの（AI が判定）

## 4. 保存場所と設定

すべて `~/.dev-digest/` に置く（ユーザー指定: 複数リポジトリを監視するので global のホームに隠しディレクトリ）。
リポジトリ側には何も置かない。

```
~/.dev-digest/
  config.json            全体設定（秘密を含まない。AI が読んでよい）
  repos/<slug>.json      リポジトリごとの監視対象（秘密を含まない。AI が読んでよい）
  secrets.json           Webhook URL（mode 600。AI は読まない・開かない）
  digest.db              SQLite（履歴・既読・送信記録）
  bin/dev-digest         安定パスのランチャー（§7）
  run/                   automation が動くフォルダワークスペース（作業ファイルはここ）
```

- `config.json`: 全体向けソースの一覧（dev.to のタグ、X のリスト URL、X のハッシュタグ）、
  Orca に登録した workspace / automation の id
- `repos/<slug>.json`: リポジトリ名（表示用）、リポジトリの絶対パス、監視対象（§5）、dev.to タグ。
  slug は git の remote の `owner/repo` から作る。remote が無ければディレクトリ名（判断）
- `secrets.json`: `global` と、slug ごとの Webhook URL。**リポジトリに Webhook が無ければ全体用の Webhook に
  `[repo名]` 付きで送る**（判断）
- automation のワークスペースを `~/.dev-digest` 直下ではなく `run/` にするのは、AI の作業ディレクトリに
  secrets を置かないため（判断。完全な防御ではない — §8）

### 4.1 JVN の深刻度のしきい値

- 選べる値は `critical` / `high` / `medium` / `low`（その値以上を送る）。深刻度の無い項目は `low` 扱いにする（判断）
- 全体のしきい値を `config.json` に持ち、`init` で尋ねる。既定は `critical`（最初の要望どおり）
- リポジトリごとに上書きできる（判断。関係するものは High から知りたい、という使い分けのため）。`setup` で尋ね、
  既定は全体の値。リポジトリ宛ての通知は、そのリポジトリのしきい値以上で、関係があるものを載せる
- しきい値を変えても、過去に送らなかった項目はさかのぼって送らない（判断）

## 5. setup（対象リポジトリで実行）

対象リポジトリで skill の setup を実行すると:

1. AI がリポジトリを読み、監視対象の候補を作る。読むもの: パッケージの依存定義（`package.json` / `go.mod` /
   `pyproject.toml` / `Gemfile` / `pom.xml` など）、`docker-compose*.yml` のイメージ、`Dockerfile` の `FROM`、
   Helm chart、Kubernetes マニフェスト、Terraform の provider と使っているリソースの種類
2. 候補を一覧にして示し、ユーザーが追加・削除する。候補は**直接依存とインフラの OSS に限る**（判断。
   推移的依存まで入れると毎朝の取得が数百件になる）
3. OSS / ライブラリごとに GitHub の `owner/repo` を AI が推定して記録する（例: keycloak → `keycloak/keycloak`）。
   推定なので一覧に表示し、ユーザーが直せるようにする。GitHub で見つからないものは Releases を取らず、
   名前だけを関連判定に使う
4. JVN の深刻度のしきい値を尋ねる（§4.1）
5. そのリポジトリ用の Webhook URL を登録する（§8 の方法。登録しないことも選べる）
6. `repos/<slug>.json` を書く

同じリポジトリでもう一度 setup すると、既存の設定を読んで差分を示し、更新する。
登録の一覧表示と削除もできる（細部は builder に任せる）。

## 6. X の取得

- Orca 内蔵ブラウザの既定プロファイル（`persist:orca-browser`）は全ワークスペースで共有される永続セッション。
  ユーザーが一度 Orca のブラウザで X にログインしておけば、automation の AI も同じログイン状態で開ける
  （ユーザーの指摘。プロファイルの共有は `orca tab profile list` で確認済み）
- AI は `orca tab create --url <リストの URL>` で開き、snapshot とスクロールでポスト（投稿者・本文・URL・時刻）を
  読み、前回までに取り込んだポストに当たるか、一定件数に達したら止める。ハッシュタグは X の検索（最新順）で同様に読む
- 読んだポストは取り込みスクリプトに JSON で渡して DB に入れる（ID で重複排除）
- ログインが切れている・画面が読めない場合は、X を空として扱い、通知の末尾に「X: 取得失敗（ログイン切れ？）」と書く
- **未検証。計画の最初のタスクとしてスパイクで確かめる**: automation が起動した新しいセッションから、
  `run/` のフォルダワークスペースで `orca tab create` した既定プロファイルのタブに、ログイン済みの X のリストが
  表示され、ポストを読み取れること。読めなければ X の方式をユーザーと決め直す

## 7. init（最初に 1 回）と automation

`init` は skill から実行する。Claude がユーザーに次を尋ねる:

- 実行時刻と曜日（毎日 / 平日）
- JVN の深刻度のしきい値（§4.1。既定 `critical`）
- X のリストの URL、X のハッシュタグ、全体向けの dev.to のタグ（既定値を提示）
- 全体用の Webhook URL（§8 の方法。質問としては尋ねない）

答えを引数にしてスクリプトが:

1. `~/.dev-digest/` を作り、`config.json` と `digest.db` を初期化する
2. `~/.dev-digest/run/` を `orca repo add --path <dir> --kind folder --json` で Orca に登録する（登録済みなら何もしない）。
   返った id を `config.json` に記録する
3. `orca automations create` で automation を作る。`--workspace` に上の workspace、`--provider claude`、
   `--timezone Asia/Tokyo`、`--trigger daily|weekdays` と `--time`、毎回新しいセッション
   （`--missed-run-grace-minutes` の値は builder に任せる）。作った id を `config.json` に記録する
4. 毎朝の Claude が確認ダイアログで止まらないよう、Claude Code の設定に許可ルール（ランチャーの実行、
   `orca` の実行、`~/.dev-digest/run/` への書き込み、フィードと Slack への取得・送信）と、`secrets.json` の
   読み取りを拒否するルールを足す。**足す前に内容を見せてユーザーに確認する**。どの設定ファイル（user / project）に
   書くか、Orca が automation で Claude をどの引数で起動するかの確認は builder に任せる
5. Orca のブラウザで X にログインするよう案内し、了承されたら `orca automations run <id>` で試しに 1 回走らせる

もう一度 `init` を実行すると、作り直さずに `orca automations edit` で時刻などを更新する。

**automation の登録はスクリプトが Orca CLI で行う**（ユーザーの要望: 登録をスクリプトで楽にしたい）。Claude の Bash ツールは対話型スクリプトに答えを打てないので、Claude が尋ねて
引数で渡す形にする（判断）。

### automation のプロンプトと安定パス

- automation に登録するプロンプトは短い固定文: 「`~/.dev-digest/bin/dev-digest procedure` を実行し、
  出力された手順に従え」。**プロンプトに Webhook URL・秘密・プラグインの版付きパスを入れない**
- プラグインのキャッシュのパスには版が入る（`…/plugins/cache/<marketplace>/<plugin>/<version>/`）ので、
  automation のプロンプトに焼き込むとプラグインの更新で壊れる。そこで `init` が `~/.dev-digest/bin/dev-digest` という
  ランチャーを置き、ランチャーが現在のプラグインの場所を解決して、そこにある朝の手順書を表示し、各スクリプトを呼ぶ
- **プラグインを更新しても、ユーザーが何もせずに automation が新しい版で動くこと**を要件にする。解決の方法
  （記録したパスが消えていたらキャッシュ内の最新版を探す、など）は builder に任せる
- **毎朝の実行は Claude だけを対象にする**（ユーザーが選んだ）。Codex は workspace-write の sandbox が
  ネットワークと `~/.dev-digest` への書き込みを塞ぎ、ファイル単位の読み取り拒否も無いため対象外。`.codex-plugin` は作らない

## 8. 秘密（Webhook URL）の扱い

ユーザーの要件は「Claude に読み取られなければ OK」。

- **入力**: macOS ではスクリプトが `osascript` の `display dialog … with hidden answer` で入力ダイアログを出し、
  ユーザーが貼り付ける。ダイアログが出せない環境（WSL など）では、ユーザーが URL をクリップボードにコピーし、
  Claude が示す `! node …` コマンドを実行するとスクリプトがクリップボードから読む。どちらでも値は
  **node のプロセス → `secrets.json`** とだけ流れ、stdout・stderr・会話には出ない
- **出力**: スクリプトが Webhook を表示するときは必ず伏せる（`https://hooks.slack.com/services/T***/…`）。
  エラー時も同じ（Slack の応答本文や例外のメッセージに URL が含まれうるので、出す前に伏せる）
- **送信**: AI は送る本文を JSON に書くだけ。`publish` が `secrets.json` を自分で読んで送る
- skill の手順書に「`secrets.json` を読まない・開かない・grep しない」と書く
- `init` が Claude Code の設定に `secrets.json` の読み取りを拒否する permission ルールを足す（§7 の 4。ユーザーの確認を経る）
- **限界**: シェルを使える AI がファイルを読むことを技術的に完全には防げない。上の対策は「通常の手順で AI の目に
  触れない」ことと「うっかり読まない」ことを保証するものだと、README に正直に書く。macOS のキーチェーンに
  置く案もあるが、`security find-generic-password -w` で同じく読めるので、優位は小さいと判断した（判断）

## 9. 毎朝の処理

1. **collect**: 全体向けのフィードと、全リポジトリの Releases・タグフィードを取得する（同じ URL は 1 回だけ）。
   RSS 2.0 / Atom / RSS 1.0（RDF）を解析し、`source + guid`（無ければ正規化した URL）で既知のものを除いて DB に入れる。
   取得に失敗したソースは記録して続ける
2. **X**: §6
3. **digest**: AI が未送信の項目を読み、次を JSON に書く
   - 各項目の日本語の要約（1〜2 行）と話題のタグ（例: `keycloak` `認証` `bedrock`）
   - 話題のまとまり: 同じ発表を複数の人が言及しているなど、似た項目を 1 つにまとめる。X 同士だけでなく、
     AWS の公式発表と X の言及のようにソースをまたいでまとめる。まとまりには元の項目のリンクを全部残す
   - 各項目・まとまりが関係するリポジトリ（slug）
4. **publish**: JSON を検証し、Slack に送る
   - 全体 1 通: セクションは JVN（しきい値以上）/ AWS / Google Cloud / X / dev.to（ユーザーが選んだ案 C）
   - リポジトリごとに 1 通: 見出しに `[repo名]`、関係する項目だけ。関係が 0 件のリポジトリには送らない（判断）
   - ソースごとの失敗は全体の通知の末尾に書く
   - Slack の長さの上限を越えるときは複数のメッセージに分ける（分け方は builder に任せる。取りこぼさないこと）
   - 送信済みは **項目 × 送り先** で記録する（判断）。全体は送れたがあるリポジトリ宛てが失敗した、という場合も、
     失敗した送り先の分だけが翌朝に再送される
   - 話題のまとまりは、まとまりの中の公式ソース（AWS / Google Cloud / JVN / Releases）のセクションに置く。
     公式ソースが無ければ X か dev.to のセクションに置く。まとまりに入った X のポストは X のセクションに重ねて
     出さず、まとまりの下に「言及: @a, @b ほか n 人」とリンクで並べる（判断。全部載せるの要件は、リンクが
     必ずどこかに出ることで満たす）

### 取得後に内容が変わった項目（判断）

- **JVN**: 初めはしきい値未満だった項目が後からしきい値以上に上がったら、その時点で新着として送る。
  DB にはしきい値未満の JVN 項目も保存しておき（履歴検索にも使う）、深刻度の変化を見る
- **Google Cloud リリースノート**: 日付ごとの 1 エントリが後から増えるので、本文のハッシュを記録し、
  変わったら増えた分を「追記」として送る
- **GitHub Releases** など、その他の編集は追わない

### AI の段階が失敗したとき（判断）

- 実行の開始と完了を DB に記録する。前回の実行が完了していなければ、次の朝の全体の通知の先頭に
  「前回（11/10）の実行は完了しませんでした」と書き、未送信の項目はそのまま今回に含める
- 実行が失敗したその朝に別の経路で知らせる仕組み（2 本目の automation など）は作らない

### 初回と間が空いたとき

- **初回**は DB が空なので、フィードの中身（AWS What's New だけで約 100 件）を全部流すことになる。
  初回だけは直近 24 時間の項目に限り、それより古いものは既読として記録する（判断）
- 前回の実行から日が空いたら、DB の既読をもとにその間の新着をまとめて送る。フィードから溢れた分は取れない（許容）

## 10. 履歴の検索

- DB は Node 組み込みの `node:sqlite`。FTS5 が使える（Node 24.15 で確認済み）
- 保存するもの: 取得した全項目（ソース・タイトル・URL・本文の抜粋・公開日時）、AI の要約と話題のタグ、
  関連リポジトリ、話題のまとまり、どの日のどの通知で送ったか
- skill に「履歴を検索する」使い方を足す。ユーザーが Claude に「先月の Keycloak の脆弱性は？」と聞くと、
  Claude が検索スクリプトを呼ぶ（期間・ソース・リポジトリ・深刻度で絞り込み、本文と要約とタグを全文検索）。
  結果は JSON で返し、Claude がそれを読んで答える（ユーザーが選んだ形）
- 列で絞り込める質問が主なので、ベクトル検索は作らない

## 11. 技術的な制約

- このリポジトリの新しいプラグイン `apps/dev-digest`（名前は判断）
- スクリプトは **TypeScript を node の型除去で直接実行**（ユーザー指定）。実行時の npm 依存はゼロ、`node:` の組み込みだけ
  （プラグインはファイルのまま入り `npm install` が走らないため）。RSS / Atom / RDF の解析も自前で書く
- リポジトリの Node は 26.13.0 に上げた（このセッションで実施。未コミット）。プラグインの実行に要る Node の下限は
  builder が決め、`@types/node` はその下限に合わせる（orca-team-dispatch-task の 22.15.3 をそのまま写さない）
- `tsconfig.json` は `erasableSyntaxOnly` と `verbatimModuleSyntax` を有効にする
- リポジトリの規約に従う: `SKILL.md` は英語で `## Output Language` ブロックを置き、`references/guide-ja.md` に訳を置く。
  `commands/*.md` を作るなら英語で `Respond to the user in Japanese.` を書く。`CLAUDE.md` / `README.md` は日本語。
  `.claude-plugin/plugin.json` とルートの `.claude-plugin/marketplace.json` の版を揃える。`pnpm check` が通ること
- CLAUDE.md（ユーザー全体）: `any` / `unknown` / `class` を使わない。値のハードコードを避ける（フィードの URL などは
  設定の既定値として 1 箇所に置く）
- 要約・通知は日本語

## 12. builder に任せること

- DB のスキーマ、JSON の形式、スクリプトの分け方と名前
- Slack のメッセージの見た目の細部（Block Kit か mrkdwn か、絵文字）
- X の読み取りの止めどころ（件数・時刻）
- `--missed-run-grace-minutes` の値、ランチャーがプラグインの場所を解決する方法
- テストの構成（フィード解析・重複排除・メッセージ分割・秘密の伏せ字は単体テストで固定すること。Slack と
  フィードはローカルの HTTP サーバで偽装する）

## 13. スパイクの結果（2026-11-09）

automation から起動した Claude が無人で最後まで動き、ログイン済みの X を読めることを確かめた（`#AI` の最新検索で 10 件）。

- `orca repo add --path <dir> --kind folder --json` は冪等。2 回目も同じ id（`result.repo.id`）を返す
- `orca automations create` は `--workspace path:<dir>` を受け付け、`result.automation.id` を返す。既定は
  `missedRunPolicy: run_once_within_grace`・`missedRunGraceMinutes: 720`。`automations run` は `result.runId` を返す
- フォルダの `.claude/settings.json` の allow ルールだけで、permission の確認もフォルダの信頼の確認も出ずに完走した。
  絶対パスのルールは先頭を `//` にする（`Write(//tmp/dd-spike/run/**)` が効いた）
- ネットワークは通る（`curl https://dev.to/feed` が 200）
- X の読み方: `orca tab create --url <url> --json` → `orca snapshot --page <id> --compact --urls`。最初の snapshot に約 15 件
  - ポストの id と URL: `/status/<数字>` へのリンクのうち、子に `time` を持つ最初のもの。投稿者はその URL の handle
  - 時刻: snapshot には相対時刻しか出ないので、id（Snowflake）から求める: `ms = (id >> 22) + 1288834974657`
  - 本文: ヘッダの後ろの generic。「Replying to」で始まる要素・「Quote」で始まる引用・カードやメディアは除く
- 片付け: フォルダのプロジェクトは `orca worktree rm` では外せず、`orca project setup-delete --setup <repoId> --force` で外す
