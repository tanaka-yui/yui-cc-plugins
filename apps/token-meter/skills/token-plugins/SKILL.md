---
name: token-plugins
description: >
  Use when the user invokes `/token-plugins` or asks to list, install, enable,
  or disable a compression plugin (rtk / caveman / headroom). Wraps each
  plugin's enable/disable mechanism behind a unified interface.
---

# token-plugins: 圧縮 plugin の制御

`apps/token-meter/lib/plugins.ts` の `COMPRESSION_PLUGINS` を読み込み、
各 plugin の `enable()` / `disable()` / `isEnabled()` / `isInstalled()` を呼び分ける。

## 引数仕様

| サブコマンド | 動作 |
|---|---|
| `list` | plugin 一覧 + インストール済み / 有効 / 最近 7 日の効果 |
| `on <name>` | `COMPRESSION_PLUGINS.find(p => p.name === <name>).enable()` |
| `off <name>` | 同 `disable()` |
| `install <name>` | `make install-<name>` を呼ぶ |
| `status <name>` | 1 plugin の詳細 (インストール先 / 設定パス / 観測実績) |

## 実装手順

1. `bun -e "import { COMPRESSION_PLUGINS } from '$HOME/.claude/token-meter/lib/plugins.ts'; ..."` で plugin リストを取得。
2. `list` は JSONL から `kind === 'post.rtk'` と `kind === 'post.compress'` を集計して saved_tokens を計算。
3. `on` / `off` は async なので `await p.enable()` する。
4. `install` は `cd $HOME/.claude/token-meter && make install-<name>` を実行。

## 出力形式

spec §6.2 の表形式 (installed/enabled は ✓/✗)。

## 注意

- plugin によっては `enable()` が `.claude.json` を書換えるため Claude Code 再起動が必要 (headroom)。`on`/`off` 実行後はその旨を表示する。
- caveman の session flag パスは将来変わる可能性がある (spec §15)。
