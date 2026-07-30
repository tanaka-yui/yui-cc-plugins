# cfork

Claude Code の会話を新しい cmux ペインにフォークするプラグイン。

## 構成

- `commands/cfork.md` - /cfork スラッシュコマンド（LLM が1回の bash 実行で完結）
- `bin/cfork` - シェルスクリプト（!cfork で直接実行、LLM 不要で高速）
- `install.sh` - インストーラ
- `.claude-plugin/plugin.json` - Plugin マニフェスト

## 動作

1. cmux で新しいペインを分割（デフォルト: right）
2. 分割先ペインで `claude --continue --fork-session` を実行
3. 現在の会話コンテキストを引き継いだ新しい Claude セッションが起動

## 前提

- cmux セッション内でのみ動作（`CMUX_SOCKET_PATH` が必要）

## 言語ルール

- **ドキュメント・コメント**: 日本語
- **コード（変数名・関数名・コマンド）**: 英語
- **`SKILL.md` / `commands/*.md` / `references/*.md`**: **英語必須**。日本語訳は `references/*-ja.md` に置く。
  詳細はルート `CLAUDE.md` の「Language convention」を参照。検証は `pnpm check:doc-lang`。
- **例外**: `SKILL.md` frontmatter の `description` は日本語可（起動トリガー語を残すため）。
