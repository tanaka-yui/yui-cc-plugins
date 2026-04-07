# yui-cc-plugins

cmux ターミナルマルチプレクサ向けツール集。

## インストール（プラグイン）

```bash
# マーケットプレイスを登録して個別インストール
/plugin marketplace add tanaka-yui/yui-cc-plugins
/plugin install cmux-fork@yui-cc-plugins
/plugin install cmux-using@yui-cc-plugins
/plugin install cmux-team@yui-cc-plugins

# または一括インストール
bash install.sh
```

---

## 一覧

### Plugins

| プラグイン | 概要 | 詳細 |
|-----------|------|------|
| cmux-fork | 会話を新しい cmux ペインにフォーク | [README](apps/cmux-fork/README.md) |
| cmux-using | cmux 操作スキル（サブエージェント起動・監視） | [README](apps/cmux-using/README.md) |
| cmux-team | マルチエージェント開発オーケストレーション | [README](apps/cmux-team/README.md) |

### Apps

| アプリ | 概要 | 詳細 |
|-------|------|------|
| cmux-remote | cmux ワークスペースを iPhone PWA からリモート閲覧 | [README](apps/cmux-remote/README.md) |

---

## cmux-remote のセットアップ

```bash
# 1. クライアントをビルド
cd apps/cmux-remote/client && bun install && bun run build

# 2. ブリッジサーバーを起動
cd apps/cmux-remote/server && bun install && bun run start
```

`http://localhost:3456` をブラウザで開き、iPhone のホーム画面に追加（PWA）。
