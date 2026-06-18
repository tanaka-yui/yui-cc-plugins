# token-meter

Claude Code の hook 経由で 3 つの圧縮プラグイン (rtk / caveman / headroom) の効きを観測し、
JSONL に記録・集計するための計測機構プラグイン。

## できること

- 3 圧縮プラグインを **並行有効化** したまま、各プラグインの効きを定量的に観測
- tool 別 ON/OFF / plugin 別 ON/OFF を切り替えて A/B 比較
- 当日累計、tool 別 / plugin 別の token ボリュームと圧縮効果を表示
- 設定ファイル 1 つ追加で観測対象 plugin を拡張可能

## セットアップ

```bash
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins
git pull
cd apps/token-meter
make setup
# Claude Code を再起動
```

`make setup` は以下を行います:
- pnpm install (workspace 依存)
- rtk / caveman / headroom のインストール (未導入の場合のみ)
- `~/.claude/settings.json` に hook を安全に append (既存 hook と共存、バックアップあり)
- `~/.claude/token-meter/` の作成と state.json 初期化

## 使い方

| コマンド | 役割 |
|---|---|
| `/token-measure list` | tool 別観測実績一覧 |
| `/token-measure on\|off [tool]` | 計測機構全体 / tool 別 ON/OFF |
| `/token-plugins list` | 圧縮 plugin 一覧と効果 |
| `/token-plugins on\|off <name>` | plugin の ON/OFF |
| `/token-stats --since 7d` | 期間集計レポート |
| `/token-clear --before 30d` | 古いログを削除 |
| `make status` | 現在の状態 (CLI) |
| `make doctor` | 健全性チェック |

## アンインストール

```bash
make uninstall   # settings.json から hook を除去 (ログは残る)
make purge       # ~/.claude/token-meter/ を完全削除
```

## ログ形式

`~/.claude/token-meter/logs/YYYY-MM-DD.jsonl` に 1 イベント 1 行で追記。
スキーマは `lib/types.ts` の `LogRecord` を参照。

```jsonl
{"kind":"pre","ts":"...","session":"a1b2","tool":"Read","input_tokens":18,"input_bytes":54}
{"kind":"post.compress","ts":"...","session":"a1b2","tool":"mcp__headroom__compress","label":"headroom","input_tokens":4521,"output_tokens":612,"ratio":0.135}
```

## ライセンス

MIT
