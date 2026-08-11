# cmux-codex-review

agmsg の受信箱を確認したうえで、新しい cmux ペインで **codex** によるコードレビューを起動するプラグイン。

モデルは **gpt-5.6-sol**、reasoning effort は **xhigh（extra high）**、対象はデフォルトで
**未コミット変更**。実装した本人のセッションとは独立した codex プロセスに、高リーズニングで
第三者レビューさせたいときに使う。

## 使い方

### スラッシュコマンド（agmsg 確認込み）

```
/codex-review              # 右に分割、gpt-5.6-sol/xhigh、未コミット変更をレビュー
/codex-review down         # 下に分割
/codex-review --base main  # main との差分をレビュー
/codex-review -- セキュリティ観点を重点的に   # カスタム指示付き
/codex-review --path docs/superpowers/specs/x-design.md  # 指定ファイルの内容をレビュー
/codex-review --no-parallel   # 並列化させず 1 エージェントでレビュー
/codex-review --agents 2      # 同時実行の子エージェントを 2 体までに絞る
```

並列実行は既定で有効で、観点別レビューと背景調査を同時に走らせるぶん消費トークンが逐次実行の 4〜5 倍程度に
増える。1 行の typo 修正のような小さな差分では `--no-parallel` か `--agents` で並列度を絞るとよい。

対象を指定せずに `/codex-review` を打った場合は、未コミット変更と
`docs/superpowers/{specs,plans}` の直近 md を候補として提示し、どれをレビューするか確認する。
brainstorming が spec を先にコミットするフローでも、対象がズレない。

### シェルスクリプト（直接実行、高速）

agmsg 確認をスキップし、通知なしの対話レビュー起動だけを行う:

```
!cmux-codex-review
!cmux-codex-review down --base main
!cmux-codex-review --list-targets     # 候補を TSV で列挙するだけ（cmux 外でも動く）
```

## 起動される codex コマンド

対話 codex にレビュープロンプトを渡して起動する（`codex review` サブコマンドは使わない）:

```bash
codex --sandbox workspace-write --ask-for-approval never \
  -c model="gpt-5.6-sol" -c model_reasoning_effort="xhigh" \
  '未コミットの変更をレビューし、問題点・改善点を具体的に指摘せよ。'
```

サンドボックスは `workspace-write`。完了通知（agmsg `send.sh`）が SQLite DB へ書き込むため、
`read-only` にすると通知が撃てなくなる。approval policy は `never`（無指定だと codex が
コマンド実行のたびに承認プロンプトで停止し、レビューが accept 待ちになる）。

## 前提条件

- [cmux](https://github.com/anthropics/cmux) 内で実行すること（`CMUX_SOCKET_PATH` が必要）
- `codex` CLI がインストール済みで、`gpt-5.6-sol` / `xhigh` が使える認証済み環境であること
- agmsg は任意（未参加・未インストールでもレビュー起動は動く）

## インストール

### Plugin インストール（推奨）

```bash
/plugin marketplace add tanaka-yui/yui-cc-plugins
/plugin install cmux-codex-review@yui-cc-plugins
```

### 手動インストール

```bash
cp commands/codex-review.md ~/.claude/commands/
cp bin/cmux-codex-review ~/.local/bin/
chmod +x ~/.local/bin/cmux-codex-review
```

## ライセンス

MIT
