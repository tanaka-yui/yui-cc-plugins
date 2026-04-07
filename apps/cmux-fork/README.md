# cfork

Claude Code の会話を新しい cmux ペインにフォーク（ブランチ）するプラグイン。

現在の会話コンテキストを維持したまま、新しいペインで Claude を起動します。
思考の分岐や並列作業に便利です。

## 使い方

### スラッシュコマンド（LLM 経由）

```
/cfork          # 右に分割してフォーク
/cfork down     # 下に分割してフォーク
```

### シェルスクリプト（直接実行、高速）

```
!cfork          # 右に分割してフォーク
!cfork down     # 下に分割してフォーク
```

## 前提条件

- [cmux](https://github.com/anthropics/cmux) がインストール済みで、cmux セッション内で実行すること
- `CMUX_SOCKET_PATH` 環境変数が設定されていること（cmux 内では自動設定）

## インストール

### 方法 1: Plugin インストール（推奨）

```bash
claude /plugin install tanaka-yui/cfork
```

### 方法 2: スクリプトインストール

```bash
git clone https://github.com/tanaka-yui/yui-cc-plugins/cfork.git
cd cfork
bash install.sh
```

### 方法 3: 手動インストール

```bash
# スラッシュコマンド
cp commands/cfork.md ~/.claude/commands/

# シェルスクリプト
cp bin/cfork ~/.local/bin/
chmod +x ~/.local/bin/cfork
```

## ライセンス

MIT
