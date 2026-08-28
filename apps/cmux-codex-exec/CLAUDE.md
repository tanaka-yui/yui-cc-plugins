# cmux-codex-exec

plan を対話 codex にカレントdir で実装させ、完了を親が agmsg 経由で検知してレビューへ繋ぐプラグイン。

## 構成

- `commands/codex-exec.md` — `/codex-exec`（identity 解決 → bin → ターンを閉じて Monitor 待機 → レビュー案内）
- `skills/codex-exec/SKILL.md` — トリガー定義
- `bin/cmux-codex-exec` — plan 解決 + 対話 codex 起動 + token/agent 導出 + `--list-targets`（候補列挙）
- `bin/work-signal` — worktree の作業信号を出す停滞検知用スクリプト。
  `cmux-team-dispatch-task` の `scripts/work-signal.sh` と**同一内容のコピー**
  （dispatch 側の `test-work-signal.sh` の WS7 が同一性を検証する）

## 完了通知の仕組み

対話 codex は exit しないので、codex 自身に完了時 `send.sh` を撃たせる。親側の待ち受けは、
SessionStart hook が起動する常駐 agmsg Monitor ストリームが担う。親はターンを閉じて idle になり、
その `send.sh` が Monitor の 1 行として届くとそこで起きる（2026-08-21 に実測済み。根拠は
`docs/superpowers/specs/2026-08-21-agmsg-monitor-only-design.md`）。

完了メッセージは `DONE <token>: <plan名> 実装完了` だけである。かつて付けていた `agents=<N>` は、
並列を指示しなくなったので廃止した。

## 完了検知は agmsg Monitor の push、タイマーは保険

この方式には `--surface` による即時のペイン死亡検知が無い。代わりに単発の `sleep` background task を
1 本保険として張る。タイマーで起きたときの規則は次の 4 つで、詳細は `commands/codex-exec.md` の
Step 5 が正である:

1. **判断の前に永続記録を 1 回読む**。`history.sh <TEAM> <PARENT> 30 | grep -F "DONE <token>:" | tail -1`。**コロンまで含めて照合する**（token は surface 番号由来で `codex-review-4` は `codex-review-40` の前方一致になるため、裸の token では短い方の照合が長い方の完了に当たり、進行中を完了と誤報告する）。
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
| 並列実行 | **無効**（codex には指示しない。`--no-parallel` / `--agents` は削除済みで、渡すと非ゼロ終了） | — |

## codex に並列を指示しない理由

codex の子エージェントは shared local app-server daemon 上の別スレッドで走り、ペインには一切
映らない（覗けるのは `codex agents` という別 TUI）。ペインを見ている限り「4 体が動いている」のか
「1 体も動いていない」のか区別できず、これが「codex が動いているのか止まっているのか分からない」の
主因だった。したがってこのプラグインは並列を依頼しない。

**これは依頼しない限定であって、codex ができないという保証ではない。** collaboration tools は
`features.multi_agent_v2 = false` でも登録されたままである。codex-cli 0.149.1 で実測した:

- `codex features list` は `multi_agent` / `multi_agent_v2` とも `false`、
  `collaboration_modes` は `removed` / `true`
- それでも `codex debug prompt-input` の developer メッセージに
  `functions.collaboration.spawn_agent` / `wait_agent` / `list_agents` の説明と
  「There are 4 available concurrency slots」が含まれ、ペインでの `list_agents` 実呼び出しも成功する
- `multi_agent_v2.enabled=false` / `multi_agent.enabled=false` /
  `--disable multi_agent` / `--disable multi_agent_v2` / `--disable collaboration_modes` /
  `multi_agent_v2.non_code_mode_only=true` / `multi_agent_v2.wait_agent_enabled=false` /
  `multi_agent_v2.max_concurrent_threads_per_session=1` のいずれでもブロックは消えない

つまり設定でフォアグラウンド専用を強制する手段は無い。codex が自発的に spawn する余地は残るので、
黙り込んだセッションの検知は `bin/work-signal` が担う（下記）。

## 停滞検知と自動再開

対話 codex は終了しないので「ペインが生きている」は進捗の証拠にならない。タイマー起床時に
`bin/work-signal` を 1 回だけ呼び、HEAD のコミット / dirty パスの集合 / それらの mtime /
ペインの画面をハッシュ化して前回起床時と比較する。`changed=yes` なら動いていて黙っているだけ、
`changed=no` なら停滞、`changed=unknown` は画面が読めず判断不能（ペイン死亡の判定へ回す）。

停滞かつ seat が記録済みなら `dispatch-nudge:` を**1 回だけ**送って自動再開する。ポーリングループは
増やさない（契機は元からある単発タイマーの起床だけ）。

`bin/cmux-codex-exec` が起動プロンプトの冒頭で `codex-record-session.sh` を実行させているのは
このためである。`join.sh` は送信側の登録でしかなく、seat が無いペインへの nudge は
`send.sh` が成功しても未読で滞留する（`docs/notification-gaps.md` の R2）。

## 前提

- cmux セッション内（`CMUX_SOCKET_PATH`）、`codex` CLI on PATH、親が agmsg team 参加済み。

## テスト

```bash
bash apps/cmux-codex-exec/test/test-cmux-codex-exec.sh
```

- **E1**: plan パスと `send.sh` が prompt へ無傷で届き、prompt はちょうど 1 引数
- **E2**: `--list-targets` は cmux を呼ばずに plan を mtime 降順で TSV 出力する
- **E3**: 候補ゼロ（git リポジトリ外）でも空出力・終了コード 0 で終わる
- **E4**: prompt に並列実行の語彙が 1 つも入らない（否定的不変条件。再導入を防ぐ）
- **E5**: 削除済みフラグ `--no-parallel` / `--agents` は非ゼロ終了し、ペインを分割しない
- **E6**: 通知本文に `agents=` が入らず、prompt は常に 1 引数
- **E7**: 通知配線時だけ `codex-record-session.sh` で bridge seat を記録させ、
  `watch.sh` の自前起動を禁じる（seat が無いと親の nudge が未読で滞留する = R2）

monitor 専用化の静的検査（M1-M7）は review 側の `test-monitor-only.sh` が 2 プラグイン分を
まとめて担保する。`bin/work-signal` の同一性は dispatch 側の `test-work-signal.sh`（WS7）が見る。

## 関連プラグインとの境界

- `cmux-codex-review`: 本プラグインの後段。exec 完了後にカレントdirの未コミット変更をレビューさせる。
- `cmux-team-dispatch-task`: worktree 隔離の複数タスク並列。こちらは単発・カレントdir・plan1本の軽量フロー。

## 言語ルール

- **ドキュメント・コメント**: 日本語
- **コード（変数名・関数名・コマンド）**: 英語
- **`SKILL.md` / `commands/*.md` / `references/*.md`**: **英語必須**。日本語訳は `references/*-ja.md` に置く。
  詳細はルート `CLAUDE.md` の「Language convention」を参照。検証は `pnpm check:doc-lang`。
- **例外**: `SKILL.md` frontmatter の `description` は日本語可（起動トリガー語を残すため）。
