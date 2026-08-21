# GitHub issue 自動ループ

`--loop` が唯一の機械的 entry point である。自然言語でループ実行を明示された場合は開始確認を行い、通常の issue 言及だけでは発動しない。ここは loop モードの実行時 SoT である。

## L0: read-only 確認

`gh auth status`、`jq`、cmux、runners.json を確認する。`runners.json` が無い場合は first-run setup を開始せず、エラーで終了する。開始前に次を実行する。

```bash
bash scripts/issue-fetch.sh --state-file .dispatch-loop/loop-state.json lock-check
```

ロックが生きている場合は開始しない。`--loop` 指定が無い自然言語発動だけは、ここより前に「ループを開始するか」の一問を確認する。

`--loop` は `--override` とも排他である。これは方針ではなく構造上の制約で、
`--override` はタスクごとに質問を出すのに対し、無人の issue ループには答える人がいない。
ループ実行は常に解決済みの設定をそのまま使う。

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
3. **1 バッチの並列実行数 (concurrency)** — 既定は 5。先頭の選択肢を既定として提示する
   - **5（推奨）**: 「標準の並列度」
   - **3**: 「リソース消費を抑える」
   - **8**: 「高スペック機で多めに処理する」
   - **Other**: 「1〜10 の整数を自由入力する」

   回答は 1〜10 の整数として検証し、範囲外・非整数ならこの質問だけを再提示する。
   concurrency は **タスク数であってペイン数ではない**。prewarm 有効時は design、任意の
   review、解決済み実行 choice が許可する executor という、実際に生成する role だけを起動する。
   ペイン数は構成ごとに異なり、たとえば review 有効の all-Codex 固定構成は固定4ペインではなく
   3ペインである。worktree は1タスクにつき1個増える。上限10はこのリソース増幅を踏まえた
   安全弁であり、それ以上を求められても引き上げない。
4. **最大バッチ数 (max_batches)**
   - **3**: 「短い実行で止める」
   - **5**: 「標準の上限」
   - **10**: 「長めに処理する」
   - **無制限**: 「対象 issue がなくなるまで続ける」

`state` は open 固定であり、質問しない。

### コール②: 実行構成

1. **design runner（子セッションのランタイム）**
   - `runners.json` の `runners[]` を動的に列挙する: label は `name`、説明は `command (engine)`。
2. **exec runner（Phase B 実行 engine）**
   - **claude**: 「実行 role が design role の model / effort と完全一致するときは
     in-session、それ以外は claude executor ペインへ委譲する」
   - **codex**: 「codex engine runner が存在する場合だけ表示する」
3. **レビュー機能（Phase A-R / Phase B-R）**
   - **有効**: 「設計・実装のレビューを行う」
   - **無効**: 「レビューを省略して進める」
4. **integration strategy**
   - **PR per task**: 「issue ごとに PR を作成する」
   - **Wait and merge**: 「検証済みの変更を待機後に merge する」

### コール③: 補完と最終確認

該当する質問だけを出し、不要なら最終確認一問だけにする。

1. **reviewer runner**（レビュー有効で、固定 review runner がまだ解決されていない場合）
   - review-capable runner を動的に列挙する。design と同じ engine も許可し、下流で engine 関係を
     再計算せず、解決済み review runner/engine を保持する。
2. **この設定でループを開始しますか**
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
| 7 | Step 1f reviewer 選択 | project/global の固定 review runner を優先し、未解決なら legacy policy またはコール③の review-capable runner で解決する。 |
| 8 | Step 1g review_mode | コール②で事前設定し、ループ中は固定する。 |
| 9 | 完了時 Wait-and-merge の Option A/B | integration=merge なら常に merge。conflict は cleanup 遷移表で自動処理する。 |
| 10 | 完了時 cleanup の三問 | cleanup 遷移表で決定的に処理する。 |
| 11 | Phase A-R の五往復 `needs_work` | 未解決指摘を文書末尾へ注記し、Phase B へ進む。 |
| 12 | Phase A-R reviewer stalled | 同一 round を一回再依頼し、再度 stalled ならレビューを省略して Phase B へ進む。 |
| 13 | Phase B 実行モデル選択 | コール②の exec runner を `EXEC_DEFAULT_HINT` に焼き込む。 |
| 14 | Phase B exec_choice 永続化確認 | #13 により発生しない。 |
| 15 | Phase B-R の五往復 `needs_work` | 未解決指摘を PR 本文へ注記し、PR を作成する。 |
| 16 | Phase B-R reviewer stalled | レビューを省略した旨を PR 本文へ注記し、PR を作成する。 |
| 17 | brainstorming / ExitPlanMode の暗黙の承認ゲート | plan モード固定と `--dangerously-skip-permissions` で承認プロンプトを出さない。 |

## L2: 初期化・dispatch・待機

設定確定後、`lock-acquire --lease-min <lock_lease_min>`、`init --config-json <json> --filter-json <json>`、`reconcile`、通常 dispatch の stale 痕跡検査、`ensure-labels` の順に実行する。`reconcile` が abort なら `lock-release` して中止する。

各 batch は `fetch --limit <concurrency> --batch <N>` で claim する。`fetch` の `[]`、exit 3（claim 全滅）、exit 4（exhaustion unknown）はいずれも次 batch を開始せず終了する。各 issue を `render-loop-prompt.sh` と `prewarm-panes.sh --unattended` で準備し、起動後に `mark-dispatched` する。

prompt renderer には解決済み role tuple を渡す: `--design-runner` / `--design-engine`、レビュー有効時だけ `--review-runner` / `--review-engine` / `--review-model` / `--review-pane-agent`、および `--exec-runner` / `--exec-engine`。all-Codex 固定無人タスクの role 引数例:

```bash
--design-runner codex --design-engine codex \
--review on --review-runner codex --review-engine codex \
--review-model gpt-5.6-sol --review-pane-agent <slug>-review \
--exec-choice codex --exec-runner codex --exec-engine codex
```

ペインを埋めるためだけに別 engine/model を追加しない。timeout sentinel は `prewarm.json` に実在する role にだけ渡す。

スクリプトで待たない。batch を dispatch したらターンを閉じる。各子の `dispatch-notify` メッセージがこのセッションを起こす。起きるたびに `.dispatch/*/status.json` から loop state file を再導出し（Step 3 が説明する再導出と同じ手順）、各 issue の terminal status と `pr_url` を `issue-fetch.sh --state-file <path> heartbeat` を先に呼んでから書き込む — こうすることで lock owner チェックを書き込みより先に必ず通す。

batch が完了するのは、その中の全 issue が terminal status になったときだけ。まだなら再びターンを閉じる。Step 3 で armed した単発 safety timer が「一度も報告しない子」をカバーする: そのタイマーの wake で、`claimed_at` が `task_timeout_min` より古い issue はすべて `timeout` になり、旧スクリプトが行っていたのと同じ sentinel（`<loop-dir>/timed-out/<slug>`）書き込みと `status.json` 書き込みを行う。`--timeout-sentinel` がある task は後着の status を受け入れない。

## L3: cleanup と終了

各 batch 後に `loop-cleanup.sh --state-file <path> --batch <N> --integration <pr|merge>` を実行する。ラベルは claim 時の `dispatch/in-progress` から、完了検証後の `dispatch/done`、または failed/timeout/conflict の `dispatch/failed` へ、terminal を先に付けて遷移する。

成功時だけ worktree、branch、task の `.dispatch` を削除する。merge conflict、WIP 保全失敗、terminal label 失敗、PR 未検証ではすべて温存する。merge では検証済みの issue を `gh issue close --reason completed` で閉じ、正常 cleanup 時だけ agmsg の `leave.sh` で team から除籍する。`leaked[]` と stale lock は手動確認後に削除する。

cleanup は sparse な `prewarm.json` に実在する `surface_id` / `agent` を再帰列挙して重複除去する。`close-surface` には必ず task workspace を渡し、`status.json` に `workspace_id` が無ければ workspace 名で引き直す。`prewarm.json` に無い role へ cleanup / timeout 操作を送らない。

exit 3/4、cleanup 失敗、ユーザー中断を含む全中断経路で `lock-release` を呼ぶ。以後のフォールバックは質問ではなく、確定済み config を用いる。設定されていない任意値だけは仕様の既定値（concurrency=5、design=claude、exec=claude、review は設定値、layout=workspace）を使う。
