# cmux-codex-exec

plan を対話 codex にカレントdir で実装させ、完了を親が agmsg 経由で検知してレビューへ繋ぐプラグイン。

## 構成

- `commands/codex-exec.md` — `/codex-exec`（identity 解決 → bin → watcher 起動 → 待機 → レビュー案内）
- `skills/codex-exec/SKILL.md` — トリガー定義
- `bin/cmux-codex-exec` — plan 解決 + 対話 codex 起動 + token/agent 導出 + `--list-targets`（候補列挙）
- `bin/cmux-codex-wait` — 短命 watcher（history polling → token 検知で exit → 親 wake）

## 完了通知の仕組み

対話 codex は exit しないので、codex 自身に完了時 `send.sh` を撃たせ、親は「token 検知で *exit* する
短命 watcher」を background task で回す。その exit が harness の `<task-notification>` を発火し idle 親を wake する。
agmsg 常駐 monitor push は idle 親を起こせない（実測済み）ため、この方式が必須。

## デフォルト

| 項目 | 値 | 上書き |
|------|-----|--------|
| model | `gpt-5.6-sol` | `-m` |
| effort | `xhigh` | `-e` |
| plan | 位置引数。無指定ならコマンド層が `--list-targets` の候補を確認（bin 単体では mtime 最新） | 位置引数でパス指定 |
| 分割方向 | `right` | `down`/`left`/`up` or `-d` |
| 実行dir | カレント（worktree 隔離しない） | — |

## 前提

- cmux セッション内（`CMUX_SOCKET_PATH`）、`codex` CLI on PATH、親が agmsg team 参加済み。

## テスト

```bash
bash apps/cmux-codex-exec/test/test-cmux-codex-exec.sh
```

- **E1**: plan パスと `send.sh` が prompt へ無傷で届き、prompt はちょうど 1 引数
- **E2**: `--list-targets` は cmux を呼ばずに plan を mtime 降順で TSV 出力する
- **E3**: 候補ゼロ（git リポジトリ外）でも空出力・終了コード 0 で終わる

## 関連プラグインとの境界

- `cmux-codex-review`: 本プラグインの後段。exec 完了後にカレントdirの未コミット変更をレビューさせる。
- `cmux-team-dispatch-task`: worktree 隔離の複数タスク並列。こちらは単発・カレントdir・plan1本の軽量フロー。
