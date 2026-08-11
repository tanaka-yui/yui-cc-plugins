# cmux-codex-exec

plan を対話 codex にカレントdir で実装させ、完了を親が agmsg 経由で検知してレビューへ繋ぐプラグイン。

## 構成

- `commands/codex-exec.md` — `/codex-exec`（identity 解決 → bin → watcher 起動 → 待機 → レビュー案内）
- `skills/codex-exec/SKILL.md` — トリガー定義
- `bin/cmux-codex-exec` — plan 解決 + 対話 codex 起動 + token/agent 導出 + `--list-targets`（候補列挙）
- `bin/cmux-codex-wait` — 短命 watcher（history polling → token 検知で exit → 親 wake）。
  `cmux-codex-review` 側と**同一内容のコピー**（回帰テストの W5 が同一性を検証する）
- `bin/codex-parallel-lib.sh` — 並列実行ディレクティブの生成（`.codex/agents/*.toml` の検出含む）。
  `cmux-codex-review` 側と**同一内容のコピー**（W8 が同一性を検証する）

## 完了通知の仕組み

対話 codex は exit しないので、codex 自身に完了時 `send.sh` を撃たせ、親は「token 検知で *exit* する
短命 watcher」を background task で回す。その exit が harness の `<task-notification>` を発火し idle 親を wake する。
agmsg 常駐 monitor push は idle 親を起こせない（実測済み）ため、この方式が必須。

並列実行時は codex が完了メッセージ末尾に `agents=<N>` を付け、`cmux-codex-wait` がそれを
`status=done token=... agents=<N>` として親へ転記する。指示が守られていなければ `agents=` が
付かないので、親側で気づける。

## watcher を壁時計で打ち切ってはいけない

`cmux-codex-wait` の `--timeout` 既定は **0（無制限）**。以前は 1800s で打ち切っていたが、codex の実装が
それを超えると、まだ生きている codex を見捨てて `status=timeout` で exit → 親が待機を畳み、**後から届く
完了通知では二度と wake しなかった**。`cmux-team-dispatch-task` の `monitor-dispatch.sh` と同じく
「時間ではなく生存」で判断する: `--surface <id>` を渡すと 60 秒ごとに `cmux read-screen` でペインの生存を
確認し、2 回連続で見つからなければ `status=gone`（exit 4）で親を起こす。コマンド層は `--timeout` を渡さない。

## デフォルト

| 項目 | 値 | 上書き |
|------|-----|--------|
| model | `gpt-5.6-sol` | `-m` |
| effort | `xhigh` | `-e` |
| plan | 位置引数。無指定ならコマンド層が `--list-targets` の候補を確認（bin 単体では mtime 最新） | 位置引数でパス指定 |
| 分割方向 | `right` | `down`/`left`/`up` or `-d` |
| 実行dir | カレント（worktree 隔離しない） | — |
| 並列実行 | 有効（調査・検証を `spawn_agent` で分割） | `--no-parallel` |
| 同時実行の上限 | `4`（2〜8） | `--agents <N>` |

## 前提

- cmux セッション内（`CMUX_SOCKET_PATH`）、`codex` CLI on PATH、親が agmsg team 参加済み。

## テスト

```bash
bash apps/cmux-codex-exec/test/test-cmux-codex-exec.sh
```

- **E1**: plan パスと `send.sh` が prompt へ無傷で届き、prompt はちょうど 1 引数
- **E2**: `--list-targets` は cmux を呼ばずに plan を mtime 降順で TSV 出力する
- **E3**: 候補ゼロ（git リポジトリ外）でも空出力・終了コード 0 で終わる
- **E4-E5**: 既定でディレクティブが入り `--no-parallel` で消える（prompt は常に 1 引数）
- **E6-E7**: `.codex/agents/*.toml` の候補列挙とフォールバック、description の `'` エスケープ
- **E8-E8b**: 通知本文の `agents=` が並列有無で切り替わる
- **E9**: `--agents` の不正値は非ゼロ終了し、ペインを分割しない

## 関連プラグインとの境界

- `cmux-codex-review`: 本プラグインの後段。exec 完了後にカレントdirの未コミット変更をレビューさせる。
- `cmux-team-dispatch-task`: worktree 隔離の複数タスク並列。こちらは単発・カレントdir・plan1本の軽量フロー。

## 言語ルール

- **ドキュメント・コメント**: 日本語
- **コード（変数名・関数名・コマンド）**: 英語
- **`SKILL.md` / `commands/*.md` / `references/*.md`**: **英語必須**。日本語訳は `references/*-ja.md` に置く。
  詳細はルート `CLAUDE.md` の「Language convention」を参照。検証は `pnpm check:doc-lang`。
- **例外**: `SKILL.md` frontmatter の `description` は日本語可（起動トリガー語を残すため）。
