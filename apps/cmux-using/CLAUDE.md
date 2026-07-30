# cmux-using 開発ガイド

cmux ターミナル操作のための Claude Code スキルパッケージ。
サブエージェント操作パターンを中心に、実践的なノウハウを構造化して提供する。

## ファイル構成

| ファイル | 役割 |
|---------|------|
| `skills/cmux-using/SKILL.md` | メインスキル定義（AI が読む） |
| `commands/cmux.md` | `/cmux` スラッシュコマンド |
| `commands/cfork.md` | `/cfork` 会話フォークコマンド |
| `bin/cmux-grid` | ペインをグリッドレイアウトに整列するスクリプト |
| `.claude-plugin/plugin.json` | Plugin マニフェスト |
| `.claude-plugin/marketplace.json` | Marketplace カタログ |
| `install.sh` | インストーラ |
| `README.md` | 人間向けガイド |
| `CLAUDE.md` | この開発ガイド |
| `LICENSE` | MIT ライセンス |
| `.gitignore` | Git 除外設定 |

## 言語ルール

- **ドキュメント・コメント**: 日本語
- **コード（変数名・関数名・コマンド）**: 英語
- **`SKILL.md` / `commands/*.md` / `references/*.md`**: **英語必須**。日本語訳は `references/*-ja.md` に置く。
  詳細はルート `CLAUDE.md` の「Language convention」を参照。検証は `pnpm check:doc-lang`。
- **例外**: `SKILL.md` frontmatter の `description` は日本語可（起動トリガー語を残すため）。

## SKILL.md の編集ルール

- **約200行を目標**とする（簡潔さ優先）
- ブラウザ操作は **5行以内**（`cmux browser --help` 参照の案内のみ）
- **サブエージェント操作パターン**が中核セクション（~50行）
- **send の改行ルール**は3層強調を維持する:
  1. 専用セクションで詳細説明
  2. サブエージェントパターン内で実例
  3. 「よくあるミス」テーブルで再強調
- テーブル形式・コード例を多用し、散文は最小限に

## メンテナンス手順

1. `cmux --help` の出力と SKILL.md のコマンド一覧を突き合わせて整合性を確認
2. 新しい cmux コマンドが追加されたら SKILL.md を更新
3. SKILL.md の行数が200行を大幅に超えていないか確認

## テスト方法

```bash
# インストール状態を確認
bash install.sh --check

# インストール実行
bash install.sh

# アンインストール
bash install.sh --uninstall
```
