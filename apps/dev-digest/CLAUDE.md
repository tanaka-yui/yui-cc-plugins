# dev-digest 開発ガイド

毎朝の開発速報を Slack に送り、履歴を SQLite に残すプラグイン。ルート CLAUDE.md と重複する規約は書かない。

## 構成

入口は `bin/dev-digest.ts`（サブコマンドは `lib/commands/*.ts` を動的 import）。実行は `node <path>.ts`
（型除去。Node 24.15 以上、実行時の npm 依存なし）。サブコマンドは init / permissions / set-webhook /
procedure / collect / ingest-x / pending / publish / x-open / repo / search。テストは
`cd apps/dev-digest && bash test/run-all.sh`、型検査と lint は `pnpm --filter @tanaka-yui/dev-digest check`。

## 毎朝の手順の正本は references/morning.md

無人の朝の実行は `procedure` が表示する `skills/dev-digest/references/morning.md` に従う。automation の prompt は
「`procedure` を実行して従え」の 1 行だけで、手順を prompt に焼き込まない。手順を変えるときは morning.md を直し、
`morning-ja.md`（読むための訳）と、`lib/permissions.ts` の許可ルールが手順の使う操作とずれていないかを揃える。
SKILL.md は対話側（init / setup / search / list / remove）だけを持ち、朝の手順を複製しない。
SKILL.md を直したら `references/guide-ja.md` も同じ commit で直す。

## ランチャー

automation にプラグインの版付きパスを焼き込まないため、init が `bin/launch.ts` を `~/.dev-digest/bin/launch.mts` に
コピーし、安定パスの sh（`~/.dev-digest/bin/dev-digest`）から呼ぶ。ランチャーは実行のたびに今のプラグインの場所を
解決して `bin/dev-digest.ts` を起動する。無人の朝の実行はこのランチャーだけを呼ぶ。

**`bin/launch.ts` は `lib/` を import しない**（コピー先に `lib/` が無い）。そのため `LAUNCHER_VERSION` などの定数を
`lib/defaults.ts` と `bin/launch.ts` に二重に持つ。これは許した重複で、`test/unit/launch.test.ts` の LA2 が一致を
固定する。**ランチャーの挙動を変えたら `LAUNCHER_VERSION` を上げる**。コピー済みの古い版は `bin/dev-digest.ts` が
警告して続け、init の再実行で直る。

## テスト専用の環境変数

次の環境変数はテストのためだけにある。本番の設定や手順に使わない。

- `DEV_DIGEST_HOME`: `~/.dev-digest` の置き場所を差し替える（`lib/paths.ts`）
- `DEV_DIGEST_FEED_BASE`: フィードの取得先を差し替える（`lib/defaults.ts`）
- `DEV_DIGEST_WEBHOOK_OVERRIDE`: Slack の送り先を差し替える。**loopback（127.0.0.1 / [::1] / localhost）だけ**を
  受け付ける。外へ向けられると secrets.json の中身を送り出す口になるため
- `DEV_DIGEST_CLAUDE_HOME`: Claude の設定ディレクトリ（`~/.claude`）を差し替える。`permissions` とランチャーが読む

## 秘密を出さない規則

Webhook URL を stdout / stderr / 子プロセスの argv / 会話のどこにも出さない。**秘密に触れうる行はすべて
`maskSecrets`（`lib/secrets.ts`）を通してから出す**。`publish` の標準出力・標準エラー・検証エラーがその例で、
Slack の応答本文や例外のメッセージに URL が含まれうるので、出す前に伏せる。Webhook の表示は `maskWebhook` だけ
を使う。新しいコマンドが秘密に近い値を出すなら、まずこの経路に載せる。

`secrets.json` を Claude に読ませない（skill / morning.md / automation の prompt に明記し、init の
`permissions --apply` が user 設定へ Read / Edit の deny を足す）。限界は README のとおり: シェルを使える AI の
読み取りは技術的に完全には防げない。

## 無人の実行の許可ルール

朝の実行は信用できないフィードと X の本文を読むので、**許可ルールが封じ込めの本体**である。`permissions` が提示する
project の allow は、置き換えで毎回作り直し（古い広い許可を残さない）、手順が使う操作だけにする:

- ランチャーの `procedure` / `collect` / `pending`（引数なしの完全一致）、`ingest-x:*`、`publish:*`、`x-open:*`
- `orca tab close` / `snapshot` / `scroll`（開く操作は `x-open` に限る。`x-open` は設定から x.com の URL を
  組み立て、`https://x.com/` で始まらない URL を開かない）
- `Read(<runDir>/**)`、`Write` / `Edit` は `x.json` と `digest.json` だけ（`CLAUDE.md` などに指示を残させない）

allow を許可リストとして効かせるのは、同じ設定の `permissions.defaultMode: "dontAsk"`（`PROJECT_PERMISSION_MODE`）で
ある。`auto` などでは allow に無い操作も自動で承認されうる。user の設定のモードには触れない（project の設定が優先
される）。封じ込めは実際の朝の実行で確かめる（allow に無い操作が拒まれること）。

**user の allow も朝の実行に効く。**allow は全スコープで合わさり、dontAsk はどの allow にも合わない操作だけを拒む。
だから封じ込めの範囲は「project の allow ＋ user の allow」で、文書で「project の allow だけ」と言ってはならない。
user の allow は書き換えず（ユーザーの設定を壊さない）、`permissions --show` が `inherited` として読んで見せる
（`inheritedAllow`）。回帰は `test/unit/permissions.test.ts` の PM8 と `test/init.test.ts` の IN4。

user には `secrets.json` の Read / Edit の deny を**足すだけ**にして、ほかの設定を壊さない。手順で使う操作を
増やしたら、同じ commit で `lib/defaults.ts` の定数・`lib/permissions.ts`・morning.md・README の説明を揃える。
残るリスク: `orca snapshot --page <id>` は id を推測されると別のタブを読め、`orca tab close --page <id>` は id が
分かれば X 以外のタブも閉じられる。
