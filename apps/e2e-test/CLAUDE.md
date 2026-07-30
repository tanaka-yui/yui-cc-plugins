# CLAUDE.md (e2e-test)

This plugin provides the `e2e-test` skill. The skill body is at `skills/e2e-test/SKILL.md`.

## 言語ルール

- **ドキュメント・コメント**: 日本語
- **コード（変数名・関数名・コマンド）**: 英語
- **`SKILL.md` / `commands/*.md` / `references/*.md`**: **英語必須**。日本語訳は `references/*-ja.md` に置く。
  詳細はルート `CLAUDE.md` の「Language convention」を参照。検証は `pnpm check:doc-lang`。
- **例外**: `SKILL.md` frontmatter の `description` は日本語可（起動トリガー語を残すため）。
