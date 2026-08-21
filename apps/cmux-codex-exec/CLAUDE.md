# cmux-codex-exec

plan を対話 codex にカレントdir で実装させ、完了を親が agmsg 経由で検知してレビューへ繋ぐプラグイン。

## 構成

- `commands/codex-exec.md` — `/codex-exec`（identity 解決 → bin → ターンを閉じて Monitor 待機 → レビュー案内）
- `skills/codex-exec/SKILL.md` — トリガー定義
- `bin/cmux-codex-exec` — plan 解決 + 対話 codex 起動 + token/agent 導出 + `--list-targets`（候補列挙）
- `bin/codex-parallel-lib.sh` — 並列実行ディレクティブの生成（`.codex/agents/*.toml` の検出含む）。
  `cmux-codex-review` 側と**同一内容のコピー**（`test-monitor-only.sh` の M5 が同一性を検証する）

## 完了通知の仕組み

対話 codex は exit しないので、codex 自身に完了時 `send.sh` を撃たせる。親側の待ち受けは、
SessionStart hook が起動する常駐 agmsg Monitor ストリームが担う。親はターンを閉じて idle になり、
その `send.sh` が Monitor の 1 行として届くとそこで起きる（2026-08-21 に実測済み。根拠は
`docs/superpowers/specs/2026-08-21-agmsg-monitor-only-design.md`）。

並列実行時は codex が完了メッセージ末尾に `agents=<N>` を付け、agmsg Monitor の行にそのまま乗って
親へ届く。指示が守られていなければ `agents=` が付かないので、親側で気づける。

## 完了検知は agmsg Monitor の push、タイマーは保険

この方式には `--surface` による即時のペイン死亡検知が無い。代わりに単発の `sleep` background task を
1 本保険として張る。タイマーで起きたときの規則は次の 4 つで、詳細は `commands/codex-exec.md` の
Step 5 が正である:

1. **判断の前に永続記録を 1 回読む**。`history.sh <TEAM> <PARENT> 30 | grep -F <token> | tail -1`。
   **`inbox.sh` は使わない**（盗られた row は既読マークされるため）。最も新しい一致を採る
2. **ペイン消滅を断定する前に `cmux read-screen` を 1 回リトライする**
3. **再武装に上限を設ける**（既定 3 回）。上限に達したら `read-screen` を添えて報告する
4. **完了を受け取ったらタイマーを止める**（`TaskStop`）

親が Monitor ストリームを実際に持っているかは、配線前に preflight で確認する
（`run/watch.<session_id>.*.pid`）。`join.sh` は登録だけで、`delivery.sh set monitor` が書く
SessionStart hook は実行中のセッションには発火しないため、新規 join の直後は決定的に Monitor が
無い。その場合は通知配線をスキップし、タイマーも張らずにその場で報告する（agmsg 未インストール /
ユーザーが join を辞退した場合も同じ）。

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

monitor 専用化の静的検査（M1-M6）は review 側の `test-monitor-only.sh` が 2 プラグイン分を
まとめて担保する。

## 関連プラグインとの境界

- `cmux-codex-review`: 本プラグインの後段。exec 完了後にカレントdirの未コミット変更をレビューさせる。
- `cmux-team-dispatch-task`: worktree 隔離の複数タスク並列。こちらは単発・カレントdir・plan1本の軽量フロー。

## 言語ルール

- **ドキュメント・コメント**: 日本語
- **コード（変数名・関数名・コマンド）**: 英語
- **`SKILL.md` / `commands/*.md` / `references/*.md`**: **英語必須**。日本語訳は `references/*-ja.md` に置く。
  詳細はルート `CLAUDE.md` の「Language convention」を参照。検証は `pnpm check:doc-lang`。
- **例外**: `SKILL.md` frontmatter の `description` は日本語可（起動トリガー語を残すため）。
