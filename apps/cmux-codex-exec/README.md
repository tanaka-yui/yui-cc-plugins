# cmux-codex-exec

claude/superpowers が作成した plan を、新しい cmux ペインで**対話 codex**（gpt-5.6-sol / xhigh）に
カレントディレクトリで実装させるプラグイン。codex が完了すると親セッションが agmsg 経由で wake され、
確認のうえ `cmux-codex-review` でのレビューへ繋がる。

## 使い方

```
/codex-exec                                   # plan 候補を提示して確認してから実装
/codex-exec docs/superpowers/plans/foo.md     # plan をパス指定
/codex-exec down                              # 下に分割
```

codex には並列実行を指示しない。作業はすべて可視ペインのフォアグラウンドで進む。codex の
子エージェントは shared local app-server daemon 上の別スレッドで走りペインに映らないため、
「4 体が動いている」のか「1 体も動いていない」のかを見分けられなくなるからである。
`--no-parallel` / `--agents` は削除済みで、渡すとペイン分割前に非ゼロ終了する。

## フロー

1. 実装する plan を確定（無指定なら候補を提示して確認）
2. 親の agmsg identity を解決（未参加なら join を案内）
3. 新ペインで対話 codex が plan を実装（すべて可視ペインのフォアグラウンド）
4. codex 完了 → agmsg 通知 → 親の常駐 Monitor イベントとして届き、親が wake
5. 親が「レビューする?」と確認 → Yes で cmux-codex-review 起動

タイマーで起きたときは `bin/work-signal` で「動いていて黙っている」のか「止まっている」のかを
切り分ける。止まっていて到達可能なら `dispatch-nudge:` を 1 回だけ送って自動再開する
（ポーリングは増やさず、契機は元からある単発タイマーの起床だけ）。

## 前提条件

- [cmux](https://github.com/anthropics/cmux) 内で実行（`CMUX_SOCKET_PATH`）
- `codex` CLI（`gpt-5.6-sol` / `xhigh` が使える認証済み環境）
- agmsg 参加済み（未参加ならコマンドが案内）

## インストール

```
/plugin marketplace add tanaka-yui/yui-cc-plugins
/plugin install cmux-codex-exec@yui-cc-plugins
```

## テスト

```bash
bash apps/cmux-codex-exec/test/test-cmux-codex-exec.sh
```

stub の cmux / codex を使い、`cmux send` が送る文字列をペインのシェルと同じように再パースして
codex の実引数を検証する。守っている不変条件は E1（plan パスと `send.sh` が prompt へ無傷で届き、
prompt は 1 引数）、E2（`--list-targets` は cmux 無しで plan を mtime 降順に列挙）、E3（候補ゼロでも
空出力・終了コード 0 で終わる）。

## ライセンス

MIT
