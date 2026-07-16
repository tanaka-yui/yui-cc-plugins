# cmux-codex-exec

claude/superpowers が作成した plan を、新しい cmux ペインで**対話 codex**（gpt-5.6-sol / xhigh）に
カレントディレクトリで実装させるプラグイン。codex が完了すると親セッションが agmsg 経由で wake され、
確認のうえ `cmux-codex-review` でのレビューへ繋がる。

## 使い方

```
/codex-exec                                   # docs/superpowers/plans/ の最新 plan を実装
/codex-exec docs/superpowers/plans/foo.md     # plan をパス指定
/codex-exec down                              # 下に分割
```

## フロー

1. 親の agmsg identity を解決（未参加なら join を案内）
2. 新ペインで対話 codex が plan を実装
3. codex 完了 → agmsg 通知 → 親の短命 watcher が exit → 親が wake
4. 親が「レビューする?」と確認 → Yes で cmux-codex-review 起動

## 前提条件

- [cmux](https://github.com/anthropics/cmux) 内で実行（`CMUX_SOCKET_PATH`）
- `codex` CLI（`gpt-5.6-sol` / `xhigh` が使える認証済み環境）
- agmsg 参加済み（未参加ならコマンドが案内）

## インストール

```
/plugin marketplace add tanaka-yui/yui-cc-plugins
/plugin install cmux-codex-exec@yui-cc-plugins
```

## ライセンス

MIT
