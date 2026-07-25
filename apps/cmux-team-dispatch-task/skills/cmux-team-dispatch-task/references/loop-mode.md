# GitHub issue 自動ループ

`--loop` が唯一の機械的 entry point である。自然言語でループ実行を明示された場合は開始確認を行い、通常の issue 言及だけでは発動しない。ここは loop モードの実行時 SoT である。

## L0: read-only 確認

`gh auth status`、`jq`、cmux、runners.json を確認する。`runners.json` が無い場合は first-run setup を開始せず、エラーで終了する。開始前に次を実行する。

```bash
bash scripts/issue-fetch.sh --state-file .dispatch-loop/loop-state.json lock-check
```

ロックが生きている場合は開始しない。`--loop` 指定が無い自然言語発動だけは、ここより前に「ループを開始するか」の一問を確認する。

## L1: 開始前の一括設定（3 コール）

この設定は `AskUserQuestion` の一回あたり最大四問という制限に合わせ、必ず次の三コールで取得する。コール③の最終確認を通過したら、設定を `loop-state.json.config` と `.filter` に保存し、ループ終了まで追加の質問はしない。

### コール①: 対象 issue

1. **対象にする issue のラベル**
   - `gh label list` から動的生成する `dispatch/*` 以外の上位三件: それぞれ「このラベルを持つ open issue だけを対象にする」
   - **フィルタなし**: 「ラベルで絞り込まない」
   - **Other**: 「カンマ区切りのラベルを自由入力する」
2. **assignee フィルタ**
   - **自分 (`@me`)**: 「自分に割り当てられた issue のみ」
   - **未アサインのみ (`no:assignee`)**: 「担当者のいない issue のみ」
   - **指定なし**: 「assignee で絞り込まない」
3. **1 バッチの並列実行数 (concurrency)**
   - **2**: 「リソース消費を抑える」
   - **3**: 「標準的な並列度」
   - **5**: 「より多くを同時に処理する」
4. **最大バッチ数 (max_batches)**
   - **3**: 「短い実行で止める」
   - **5**: 「標準の上限」
   - **10**: 「長めに処理する」
   - **無制限**: 「対象 issue がなくなるまで続ける」

`state` は open 固定であり、質問しない。

### コール②: 実行構成

1. **design runner（子セッションのランタイム）**
   - `runners.json` の `runners[]` を動的に列挙する: label は `name`、説明は `command (engine)`。
2. **exec runner（Phase B 実行モデル）**
   - **opus 1m**: 「高い推論量で実装する」
   - **sonnet**: 「標準の実装モデル」
   - **codex**: 「codex engine runner が存在する場合だけ表示する」
3. **レビュー機能（Phase A-R / Phase B-R）**
   - **有効**: 「設計・実装のレビューを行う」
   - **無効**: 「レビューを省略して進める」
4. **integration strategy**
   - **PR per task**: 「issue ごとに PR を作成する」
   - **Wait and merge**: 「検証済みの変更を待機後に merge する」

### コール③: 補完と最終確認

該当する質問だけを出し、不要なら最終確認一問だけにする。

1. **通知トランスポート (`message_type`)**（config 未設定かつ agmsg が利用可能な場合）
   - 利用可能な transport を列挙し、選択値は従来どおり global config に永続化する。
2. **reviewer runner**（design runner が codex、claude engine runner が二件以上、かつレビュー有効の場合）
   - claude engine の runner を動的に列挙し、「codex 設計をレビューする runner」として選ぶ。
3. **この設定でループを開始しますか**
   - **開始**: 「上記設定を確定して実行する」
   - **設定をやり直す**: 「コール①へ戻る」

## 質問箇所の決定表（§4.1）

| # | 元の質問箇所 | loop モードでの解決方法 |
|---:|---|---|
| 1 | Step 1a タスク収集 | `issue-fetch.sh ... fetch` の出力で解決する。 |
| 2 | Step 1c brainstorming 選択 | plan モード固定。 |
| 3 | Step 1d layout | workspace 固定。 |
| 4 | Step 1e integration strategy | コール②で事前設定する。 |
| 5 | Step 1f runner switch / per-task runner | コール②の design runner を全 task 共通で使う。 |
| 6 | Step 1f first-run setup（runners.json 対話生成） | L0 で検査し、無ければ開始せずエラー終了する。 |
| 7 | Step 1f cross-engine reviewer 選択 | claude runner 一件なら自動採用、二件以上ならコール③で事前設定する。 |
| 8 | Step 1g message_type 初回設定 | config 未設定時だけコール③で事前設定し、従来どおり永続化する。 |
| 9 | Step 1g review_mode | コール②で事前設定し、ループ中は固定する。 |
| 10 | 完了時 Wait-and-merge の Option A/B | integration=merge なら常に merge。conflict は cleanup 遷移表で自動処理する。 |
| 11 | 完了時 cleanup の三問 | cleanup 遷移表で決定的に処理する。 |
| 12 | Phase A-R の三往復 `needs_work` | 未解決指摘を文書末尾へ注記し、Phase B へ進む。 |
| 13 | Phase A-R reviewer stalled | 同一 round を一回再依頼し、再度 stalled ならレビューを省略して Phase B へ進む。 |
| 14 | Phase B 実行モデル選択 | コール②の exec runner を `EXEC_DEFAULT_HINT` に焼き込む。 |
| 15 | Phase B exec_choice 永続化確認 | #14 により発生しない。 |
| 16 | Phase B-R の三往復 `needs_work` | 未解決指摘を PR 本文へ注記し、PR を作成する。 |
| 17 | Phase B-R reviewer stalled | レビューを省略した旨を PR 本文へ注記し、PR を作成する。 |
| 18 | brainstorming / ExitPlanMode の暗黙の承認ゲート | plan モード固定と `--dangerously-skip-permissions` で承認プロンプトを出さない。 |

## L2: 初期化・dispatch・待機

設定確定後、`lock-acquire --lease-min <lock_lease_min>`、`init --config-json <json> --filter-json <json>`、`reconcile`、通常 dispatch の stale 痕跡検査、`ensure-labels` の順に実行する。`reconcile` が abort なら `lock-release` して中止する。

各 batch は `fetch --limit <concurrency> --batch <N>` で claim する。`fetch` の `[]`、exit 3（claim 全滅）、exit 4（exhaustion unknown）はいずれも次 batch を開始せず終了する。各 issue を `render-loop-prompt.sh` と `prewarm-panes.sh --unattended` で準備し、起動後に `mark-dispatched` する。

`batch-wait.sh --state-file <path> --batch <N> --timeout-min <task_timeout_min>` は `ALL_TERMINAL` の場合だけ完了であり、`WAITING` は再実行する。`--timeout-sentinel` がある task は後着の status を受け入れない。

## L3: cleanup と終了

各 batch 後に `loop-cleanup.sh --state-file <path> --batch <N> --integration <pr|merge>` を実行する。ラベルは claim 時の `dispatch/in-progress` から、完了検証後の `dispatch/done`、または failed/timeout/conflict の `dispatch/failed` へ、terminal を先に付けて遷移する。

成功時だけ worktree、branch、task の `.dispatch` を削除する。merge conflict、WIP 保全失敗、terminal label 失敗、PR 未検証ではすべて温存する。merge では検証済みの issue を `gh issue close --reason completed` で閉じ、正常 cleanup 時だけ agmsg の `leave.sh` で team から除籍する。`leaked[]` と stale lock は手動確認後に削除する。

exit 3/4、cleanup 失敗、ユーザー中断を含む全中断経路で `lock-release` を呼ぶ。以後のフォールバックは質問ではなく、確定済み config を用いる。設定されていない任意値だけは仕様の既定値（design=opus、exec=sonnet、review は設定値、layout=workspace）を使う。
