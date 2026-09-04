# orca-team-dispatch-task — cmux 版ワークフローを Orca ネイティブの上に再構築する

作成: 2026-09-04
改訂: 2026-09-04 (spec2 round 4 で承認。詳細は 0 節の改訂履歴)
状態: **設計。承認済み（Phase A-R spec checkpoint）。未実装。**
      Phase 0 contract spike は実施済み（U1-U4 / U6 解決、U5 のみ未測定・非ブロッカー）。
対象: 新規プラグイン `apps/orca-team-dispatch-task`
移植元: `apps/cmux-team-dispatch-task` 3.9.0
実測環境: Orca 1.4.196 (`/Applications/Orca.app/Contents/Resources/bin/orca`)

## 0. 改訂履歴

| rev | 変更 |
|---|---|
| 初版 (627a5b5) | 設計の骨子 |
| rev2 (20c6746) | Phase A-R round 1 の findings 1-8 を反映。**8 節のスクリプト分類を全面的に作り直し**（親の訂正「バイトではなく判断を再利用せよ」を受け、14 本を個別監査した）。**5 節のライフサイクルを 1 本の状態機械へ統一**。**9 節に per-role status dir と二相コミットを導入**。**11 節に terminal cleanup の decision table を追加**。**6-6 に Delivery ack の順序契約を追加**。**15 節に Phase 0 contract spike を新設**。loop / setup / reset / override の節を追加 |
| rev3 (3ed9528) | Phase A-R round 2 の findings 1-5 を反映。**5-5 に 4 つの入力（role_status_dir / dispatch_root / review_dir / send_command）の分離を追加**（per-role dir が recovery 層を壊していた）。**5-1 に `assignment_state` を導入**（Task 注入と disk publish の race）。**6-5 の `emitted-ledger.json` を永久 tombstone から再 emit レート制限へ**（wake 消失）。**10 節を全面改稿し design も二相コミットを通す / crash 境界 5 行 / remediation の状態再オープンを定義**。**12 節を全面改稿し Delivery 台帳を Run 単位へ移して mixed batch を routing、issue ごとの durable journal を導入**（「worktree の有無で進捗が一意」は不成立） |
| rev4 (a94f93c) | Phase A-R round 3 の findings 1-3 と文書整合 3 件を反映。**5-1 に `starting` の親側 sweep（4 crash 境界）と generation ごとの role dir archive を追加**。**10 節を `completion.json` の 5 phase journal へ作り直し、`worker_done` の exactly-once 回復と sentinel 内部の crash gap を閉じた**。**12-1 に index.json の write-ahead publish 順序と routing 不能の quarantine を追加**。6-5 に親の再開時 drain を追加。15 節に U3 の acceptance criterion 4 点を追加 |
| rev5 (13ac04f) | Phase A-R round 4 の findings 1-5 と clarification 1 件を反映。**5-1 に mutation identity の 2 分割（`local_operation_id` / `orca_request_id`）と U6 分岐を追加** — round 3 版の「送信前に Orca request id を write-ahead する」は初回に request id を渡すフラグが存在せず実装不能だった。**generation transition を `.generation-transition` による durable transaction 化**（複数 `mv` の途中 crash）。**12-1 の write-ahead 順序を journal 先頭へ並べ替え、index / workers を materialized view と再定義**。**quarantine に mailbox 非依存の自己再駆動と bounded backoff を追加**。**失敗系も `failure_prepared` → `worker_done_pending` → `settled` の journal を通す**。`starting_at` を時刻源として明記し、watcher escalation は best-effort、親 sweep が correctness path と位置づけ |
| rev6 (63c4214) | **親の裁定 1-3（2026-09-04）と Phase 0 spike の実測を反映。**配送規律を **at-least-once + `task_id`+`dispatch_id` による冪等消費**へ転換し、request identity の write-ahead / `worker_done_pending` / 失敗系 journal / quarantine 機構を撤回した（round 4 findings 1 と 5 が消滅）。spike 実測を O21〜O26 として記録し、**U3 の測定で round 3 finding 3 と round 4 finding 4 も消滅**。U1 / U2 は repo 登録が取り消せないため未測定であることを理由つきで明記 |
| rev7 (84988b0) | spec round 5 の findings 1-8 と文書整合 7 件を反映。**spike 第 2 回を実施し U1 / U2 / U4 を解決**（O27-O37）。U1 = yes（worker 間 dispatch 送信）、U2 = yes（非 exec wrapper でも `agentIdentity` が付く）。**`worker_done` が `--dispatch-capability` を要求する事実（O33）と、`worker-stop` が reused terminal を閉じない事実（O34）を新たに発見**。5-1 に送信側の収束規則と handler 別 dedup key、`recovery-tick.sh` の停止条件の単一定義、generation transition の freeze 契約と src/dst 衝突の安全化を追加。12-1 の launch WAL に caller 生成 identity（`launch_id` / `start_id`）を導入。10-5 の remediation を active / settled の 2 経路へ分離。preflight に `--from` の明示解決を追加。**「repo 登録は取り消せない」は誤りだったと訂正**（O35） |
| rev8 (d21d85c) | spec2 round 1 の findings 1-5 と文書整合 8 件を反映。**6-4b に worker lifecycle コマンドの正本を新設**（O33 の capability を含む identity 一式を preamble から一組で取る / adapter は lifecycle に使わない / preamble は世代ごとに使い捨てる）。**5-2 の preflight 本文に親 handle の確定と `--from` の明示を実装**（改訂履歴だけ先行して本文が追従していなかった）。**5-6 の canonical command に `--from` と `--retry-request` を追加**。**generation transition に `commit_target` を持たせ `starting` 固定を解消**。**失敗系に `status.json = error` を durable intent として与えた**。**cleanup table に `stop_unknown` の 4 行を追加**。10 節の無条件再送を 5-1 の inspection-first 収束規則へ統一 |
| rev9 (67aa173) | spec2 round 2 の findings 1-5 を反映。**capability / preamble の寿命を generation 単位から Dispatch 単位へ訂正**（経路 A は新 preamble が届かないので旧 tuple を無効化すると worker が capability を失う）。**`check` に `--from` が存在しない CLI 不一致を修正し、adapter の sender 解決を `ORCA_TERMINAL_HANDLE` からの明示取得 + 取得不能なら exit 1 に変更**。**durable intent を実行できる owner の回復契約を 4 分岐で新設**（O33 により親は代理送信できないため、worker 消失時に誰が送るかが未定義だった。成功系にも同じ穴があった）。**`commit_target` を対象 role の complete post-state と定義し、step 6 が他 role の同時更新を巻き戻さないことを明記**。10-1 相 7 の「rc 0 のときだけ settled」を inspection 込みへ統一。cleanup table を分断していた散文を表の後ろへ移動 |
| 本版 | spec2 round 3 の findings 1-3 を反映。**6-2 の adapter 本文と 6-5 の check 疑似コードを実際に更新**（前ラウンドは 5-2 の表とテストだけが更新され正本が旧記述のまま残っていた）。**12-1 に owner replacement 専用の WAL branch を新設**（通常の 11 段は `task-create` を含むので同じ Task への replacement に適用すると不要な Task を作る。generation を上げず disk intent を archive しないことも明記）。失敗系の旧説明 2 箇所を 10-2 の正本への参照へ置換 |

## 1. 解こうとしている問題

`cmux-team-dispatch-task` は「4 ロール（design / design_review / exec / exec_review）が
Phase A → A-R → B → B-R を回して PR まで到達する」というドメインを持つ。その価値はドメイン側に
あるが、実装の大半は **cmux が提供しない配線を手で作った層** である — agmsg による配送、
`[ready]` 自己申告による readiness、runner wrapper による終了通知、2×2 ペイン配置、90 分単発タイマー。

Orca はこれらをネイティブで持っている。同じドメインを Orca の上に置き直せば、手作りの
transport / lifecycle 層をまるごと落とせる。

移植の指針は 2 つ:

1. **ドメインロジックは残し、手作りの transport と lifecycle は捨てる。** 1 対 1 移植はしない。
2. **再利用するのはスクリプトが符号化している「判断」であって、そのバイト列ではない。**
   cmux 時代の artifact を、ファイルを byte 一致に保つためだけに温存しない。

指針 2 は親からの明示的な訂正である（2026-09-04T05:13:38Z）。初版はこれを逆に設計しており、
Phase A-R round 1 の finding 1 で否決された。

## 2. 確認済みの事実

実測またはコード読解で裏が取れたものだけを挙げる。未実測は 15 節に分ける。

### 2-1. Orca 側

| ID | 内容 | 根拠 |
|----|------|------|
| O1 | `orca` は PATH に無い。実体は `/Applications/Orca.app/Contents/Resources/bin/orca`（bash script） | `ls -la` 実測 |
| O2 | Orca app は起動中（appVersion 1.4.196）だが `runtime.state = graph_not_ready` / `connectionState = workspace-window-closed` | `orca status --json` 実測 |
| O3 | O2 の状態でも orchestration RPC は通る。`run-list` は成功し、`task-list` は `run_required` を正しく返す | 実測 |
| O4 | `worker-start` は **ready のときだけ exit 0**。failed / outcome_unknown は exit 1 で、JSON に `stage` / `failedStage` / `effects` / `residualResources` / 復旧コマンドが載る | `worker-start --help` Notes |
| O5 | `--model` は Claude / Codex / Cursor の opaque model id を取る。`--effort` は `--model` を要求する。**両者とも `--terminal` と併用できない** | `worker-start --help` Notes |
| O6 | `terminal create --command <text>` は任意のコマンド文字列を取る。`worker-start --terminal <handle>` で既存端末を supervised worker にできる（`--worktree` の併記が必要） | `terminal create --help` / `worker-start --help` Notes |
| O7 | `send --to` が取るのは `run:<id>` / `dispatch:<id>` / legacy_handle とグループアドレス | `send --help` usage |
| O8 | `--type` は `status` / `dispatch` / `worker_done` / `merge_ready` / `escalation` / `handoff` / `decision_gate` / `question` / `heartbeat` の 9 種**固定**。任意ラベルを型にできない | `send --help` Notes |
| O9 | 有効な `worker_done` は Task と Dispatch を**自動で completed にする**。続けて `task-update --status completed` を呼んではならない | ガイド Messaging 節 |
| O10 | `check --wait` の stdout は JSON 1 文書ちょうど。keepalive 行は **stderr**。`2>&1` で混ぜるとパーサが壊れる | `check --help` |
| O11 | `check` は bound Run の最古の**未 ack** Delivery（最大 50 通）を返し、`--ack <delivery_id>` まで同じ batch を replay する。**全 message を処理してから ack せよ** | `check --help` Notes / ガイド Messaging 節 |
| O12 | dispatch された worker は既定で sub-worker を dispatch できない（`nested_worker_depth_exceeded`）。深さは**コマンドを発行した端末**から数え、`run-create` してもリセットされない | ガイド「How deep workers can nest」 |
| O13 | `worker-release` は **reused または pre-existing の端末を閉じない**。setup 端末・設定タブ・ユーザーが引き取った端末・identity 未証明のものも同様。冪等で `already_released` を返す。`release_pending` / `release_unknown` では `terminal close` で代用してはならない | `worker-release --help` Notes / ガイド |
| O14 | `worker-show` の `observation.agentWait` は 3 値を区別する。値あり = 人間待ち、`null` = 見たが待っていない、**フィールド不在 = 見ていない**（「待っていない」ではない）。**待っている worker は healthy であって failed ではない** | `worker-show --help` Notes |
| O15 | `dispatch --inject` で作った Dispatch は **unsupervised**。`worker-stop` / `worker-abandon` はそのプロセスを閉じない | ガイド |
| O16 | orchestration は Settings > Experimental で有効化が必要 | ガイド Preconditions |
| O17 | `skills get orchestration` と `--full` の出力は同一（440 行、diff 空） | 実測 |
| O18 | Orca に workspace 概念は無い。`--no-parent` は Orca の lineage だけを決め、git の base は `--base-branch` が別に決める | `orca --help` / ガイド |
| O19 | `worker-start` の非 0 は 2 種を含む。`failed` / `stopped` は `--retry-of` + 明示 placement で replacement、`outcome_unknown` は receipt の recovery action に従い `worker-stop` で再検査するか `worker-abandon`（資源が生存し得ることを受け入れる）。**無条件の削除は認められていない** | ガイド Recovery 節 |
| O21 | **`--retry-request <caller 生成 id>` は初回呼び出しで受け付けられ、その id が operation identity として確立する。**`orca orchestration run-create --objective "…" --retry-request spike-1788501727-98882 --json` → `result.mutation = {"requestId":"spike-1788501727-98882","replayed":false}`。同じ id で再実行 → `{"replayed":true}` かつ `run.id` は同一（Run は重複しない）。`request-show --request spike-1788501727-98882 --json` → `{"state":"completed","method":"orchestration.runCreate","receipt":{…}}` | Phase 0 spike 実測（2026-09-04） |
| O22 | **`check` の consuming 読みは message を `--peek` から隠さない。**3 通送って `check --peek` → `count=3` / `read=0`、`check --json` → `deliveryId=delivery_b4618940d9e6` / `count=3` / `read` は依然 0、直後の `check --peek` → **`count=3` のまま**。`check --ack delivery_b4618940d9e6` の後は peek も check も `count=0`。**cursor を進めるのは ack だけ** | Phase 0 spike 実測 |
| O23 | ack しない限り `check` は同じ Delivery を replay する。連続 2 回の `check --json` がともに `deliveryId=delivery_fb8315632097` / 同一 message を返した | Phase 0 spike 実測（O11 の確認） |
| O24 | `check --json` の `result` キーは `acknowledged` / `cancelled` / `connectionLost` / `count` / `deliveryId` / `messages` / `mutation` / `replayed` / `runId` / `timedOut`。`--peek` は `acknowledged` / `count` / `messages` / `runId` のみで **`deliveryId` を返さない**。message のフィールドは `id` / `run_id` / `delivery_contract` / `from_handle` / `to_handle` / `subject` / `body` / `type` / `priority` / `thread_id` / `payload` / `read` / `sequence` / `created_at` / `delivered_at` / `sender_pane_key` | Phase 0 spike 実測 |
| O25 | `workspace-window-closed`（O2）でも orchestration の読み書きと `run-create` は動く。ただし `worktree create` は**登録済み repo を要求する**。このマシンで Orca に登録されている repo は `influencer-platform` の 1 件だけで、`yui-cc-plugins` は未登録（`--repo name:yui-cc-plugins` → `repo_not_found`）。**`orca repo` に `remove` サブコマンドは無い**ので、repo 登録は取り消せない | Phase 0 spike 実測 |
| O26 | `run-create` は `coordinator_handle` を「現在の端末」に束縛する。cmux シェルから実行したところ、Orca が唯一の live 端末（influencer-platform の `✳ Claude Code`）を coordinator として束縛した。**呼び出し元が Orca 端末でないとき、束縛先は意図しない端末になり得る** | Phase 0 spike 実測（副作用として観測） |
| O27 | **`--types` は返る batch を絞らない。**wake 条件にしか効かない。status×2 + merge_ready×1 + status×1 を送り `check --types merge_ready --json` → `count=4`（非一致 3 通を含む全件）。続けて `check --types worker_done --json`（一致 0 件）→ **同じ `deliveryId` で同じ 4 件**。ガイドの「型フィルタは waiter が起きる条件を決めるが、返る Delivery は最古の full batch のまま」を確認 | Phase 0 spike 実測 |
| O28 | **orchestration の mutation は sender terminal を要求する。**`task-create` を `--from` 無しで実行 → `{"code":"no_active_sender_terminal","message":"Pass --from <terminal-handle> or run the command inside a live Orca terminal with ORCA_TERMINAL_HANDLE set."}`。**これが O26 の正確な原因である** — 候補端末が 1 つだけのときは暗黙にそれが選ばれ、複数あると拒否される | Phase 0 spike 実測 |
| O29 | `worker-start --terminal` は端末が**認識されたエージェントを実行していること**を要求する。`bash` 端末に対して → `{"code":"agent_unconfigured","message":"Terminal … is not running a recognized agent."}`。判定は `terminal list` の `agentIdentity`（実 Claude Code = `"claude"` / bash = `null`） | Phase 0 spike 実測 |
| O30 | **`agentIdentity` はコマンド文字列ではなく実行中プロセスから検出される。**次の 3 通りすべてが `agentIdentity: "claude"` かつ title `✳ Claude Code` になった: (a) `--command "claude"`、(b) `--command "bash wrapper.sh"` で wrapper が `exec claude`、(c) **同じく wrapper だが `exec` せず `claude &` + `trap` で watcher を回収する形**。**したがって S6 の runner wrapper 設計（5-5 の非 exec 形）は成立する** | Phase 0 spike 実測 |
| O31 | **U2 = yes。**`worker-start --task <t> --terminal <wrapper 端末> --worktree <wt> --from <coord> --json` → exit 0、`{"state":"ready","stage":"input_accepted","dispatchId":"ctx_22efecad4b84"}`。`effects` に `{"kind":"worktree","action":"reused"}` | Phase 0 spike 実測 |
| O32 | **U1 = yes。**supervised worker A の端末から worker B の Dispatch へ送れる。`send --from <A の handle> --to dispatch:ctx_61d8349a5b91 --type status` → ok、`to_handle: "dispatch:ctx_61d8349a5b91"`。B 側の `check --terminal <B> --peek` → `count=1` で当該 message を受信。**D3（worker 間直接レビュー）の土台が確認された** | Phase 0 spike 実測 |
| O33 | **`worker_done` は preamble 由来の capability トークンを要求する。**`--task-id` / `--dispatch-id` / `--outcome` を揃えても `--dispatch-capability` が無いと → `{"code":"dispatch_capability_invalid","message":"The Dispatch capability is missing. Pass --dispatch-capability <token> from your dispatch preamble."}`。**実際に dispatch されたペインだけが自分の Task を完了できる。**外部からの偽装も、外部からの二重送信の実測もできない | Phase 0 spike 実測 |
| O34 | **`worker-stop` は `terminal create` + `worker-start --terminal` で作った端末を閉じない。**→ `{"state":"stop_unknown","alreadySettled":false,"processAction":"none","lastError":"The worker terminal is external; no terminal was closed."}`。明示的な `terminal close --terminal <handle>` は成功した。**O13 の「reused / pre-existing は閉じない」が `worker-release` だけでなく `worker-stop` にも及ぶ** | Phase 0 spike 実測 |
| O35 | **repo 登録は取り消せる。**`orca repo` に `remove` は無いが、`project setup-delete --setup <setup-id>` の Notes に「Repo-backed setups remove the registered repo compatibility record」とあり、実行後 `repo list` が 2 件から 1 件へ戻ることを確認した。**round 5 時点の「repo 登録は取り消せない」という私の記述は、`orca repo --help` だけを見た誤りだった** | Phase 0 spike 実測 |
| O36 | `worktree create` は `workspace-window-closed`（O2）でも動く。`--repo name:yui-cc-plugins --name orca-spike-tmp --no-parent --setup skip` → ok、`worktree.id` は `<repo-id>::<path>` 形式、branch は `refs/heads/<git user>/<name>`。**U4 はこれで解消** | Phase 0 spike 実測 |
| O37 | mutation の失敗応答は `error.data` に `orchestrationRequestId` と `originalCommand`（argv 配列）を含む。**成功応答の `result.mutation.requestId` と合わせ、request id は「応答が返れば」必ず得られる** | Phase 0 spike 実測 |
| O20 | codex の interactive session では `--add-dir` が seatbelt policy に届かない。`-c sandbox_workspace_write.writable_roots=[...]`（single-quoted TOML literal 形式なら `zsh -ic` を通る）は効く | 親が 3 プローブで実測（2026-09-04T05:11:29Z）。2026-09-03 spec 9-1 節 F7 の root cause |

### 2-2. 移植元（cmux 版）側 — 14 本の個別監査

親の初期リストは「検証済みの棚卸しではなく出発点」である（親の訂正）。全 14 本を
cmux 時代の artifact（`prewarm.json` / `workspace_id` / `surface_id` / `.deferred` /
`.assigned-*` / `phase-b-deliver.sh`）と 4 位置引数 send への依存で監査した結果:

| script | prewarm | wsp/surf | .deferred | .assigned | phase-b | send4 | 判定 |
|---|---|---|---|---|---|---|---|
| `completion-gate.sh` | 4 | 0 | 4 | 3 | 3 | 7 | **改変（大）** |
| `prewarm-snapshot.sh` | 2 | 8 | 0 | 0 | 0 | 0 | **改変（スキーマ）** |
| `config-lib.sh` | 1c | 2 | 0 | 0 | 0 | 0 | **改変（小）** |
| `report-status.sh` | 0 | 1c | 1 | 0 | 0 | 0 | **改変（小）** |
| `recovery-tick.sh` | 0 | 0 | 0 | 0 | 0 | 6 | **改変（小）** |
| `review-request.sh` | 0 | 0 | 0 | 0 | 1c | 3 | **改変（小）** |
| `issue-fetch.sh` | 1 | 0 | 0 | 0 | 0 | 0 | **改変（小）** |
| `review-state.sh` | 0 | 0 | 0 | 0 | 1c | 0 | **byte 一致** |
| `record-pr.sh` | 0 | 0 | 0 | 0 | 0 | 0 | **byte 一致** |
| `escalate.sh` | 0 | 0 | 0 | 0 | 0 | 0 | **byte 一致** |
| `config-resolve.sh` | 0 | 0 | 0 | 0 | 0 | 0 | **byte 一致** |
| `config-edit.sh` | 0 | 0 | 0 | 0 | 0 | 0 | **byte 一致** |
| `override-args.sh` | 0 | 0 | 0 | 0 | 0 | 0 | **byte 一致** |
| `parallel-directive.sh` | 0 | 0 | 0 | 0 | 0 | 0 | **byte 一致** |

`c` はコメント内のみの出現。

| ID | 内容 | 根拠 |
|----|------|------|
| C1 | `prewarm-snapshot.sh` はトップレベル `workspace_id` を必須にし `dispatch_valid_workspace_id`（`^workspace:[0-9]+$`）で検証、各 role に `surface_id` を必須にし `dispatch_valid_surface_id` で検証、未知のトップレベルキーを拒否する。**Orca 形状の snapshot は必ず拒否される** | `prewarm-snapshot.sh:14-19,29-50` / `config-lib.sh:32-33` |
| C2 | `completion-gate.sh` の `expected_exec_agent()` は `$STATUS_DIR/prewarm.json` を読み、`delegation_recorded()` は `.deferred` と `.assigned-<exec agent>` の両方を要求し、`DELEGATE_HINT` は `phase-b-deliver.sh` を名指しする | `completion-gate.sh:303-325` |
| C3 | `completion-gate.sh` は design / exec で `.assigned-$AGENT` が無ければ**無条件に allow** する。marker を廃止するとこの 2 ロールの gate が常時 no-op になる | `completion-gate.sh:365` |
| C4 | `completion-gate.sh` の最終 block reason は `report-status.sh` と親宛 `dispatch-notify:` を指示し、`worker_done` を指示しない | `completion-gate.sh:462` |
| C5 | `report-status.sh` の V2 ガードは `DISPATCH_GATE_ROLE=design` かつ `.deferred` 存在で `done` を拒否する（実コード） | `report-status.sh:53-55` |
| C6 | `recovery-tick.sh` は disk の `status` が `done` / `error` なら `record_clear` して即 exit する（回復を止める） | `recovery-tick.sh:75-78` |
| C7 | `recovery-tick.sh` は `.send-command` から読んだパスを **4 位置引数で実行する** | `recovery-tick.sh:51-52` |
| C8 | `review-request.sh` は `AGMSG_SEND` を **4 位置引数で実行する**。`--to` を `^[A-Za-z0-9._-]+$` で検証するので `dispatch:<id>` を直接渡せない | `review-request.sh:25,44,76` |
| C9 | `completion-gate.sh` は `.send-command` の値を**文面に埋めるだけ**で実行しない | `completion-gate.sh:106-109,146-151` |
| C10 | `issue-fetch.sh` は完了判定の evidence に `prewarm.json` の存在を数える。`CMUX` 変数（69 行目）は代入のみで一度も参照されない死んだ変数 | `issue-fetch.sh:306` / `grep -n CMUX` |
| C11 | 権限バイパスと Stop hook の注入先は **worktree 内のファイル**であり CLI フラグではない | cmux `CLAUDE.md` 項目 25 / 33 |
| C12 | gate identity を hook の command 文字列に焼き込むと、同 engine の 2 ロール目が 1 ロール目のゲートを実行する。**runner wrapper の env export が唯一の手段** | cmux `CLAUDE.md` 項目 33 |

## 3. 決定事項

### 3-1. 親から確定済みとして受領した事項

| # | 内容 |
|---|------|
| D1 | Orca ネイティブの上に構築する。1 対 1 移植はしない |
| D2 | nested depth 1 の制約（O12）により、**親が全 worker を所有する**。design は Phase B を dispatch できず、plan パスを載せた `worker_done` を返し、**親が Phase B の Task を作って exec へ dispatch する** |
| D3 | レビューは追加 Task を作らず、**worker 間の直接 `send` / `check`** で行う |
| D4 | **（親により訂正）** 再利用するのはスクリプトが符号化した判断であってバイト列ではない。cmux 時代の artifact を byte 一致のためだけに温存しない。スキーマや marker が Orca に無いなら改変し、spec に明記する |
| D5 | 維持するドメイン契約: 4 ロール / Phase A・A-R・B・B-R / `<point>-round-<N>.md` + `-request.md` + `-abort.md` と末尾 `VERDICT:` 行 / 5 ラウンド上限 / `integration.json` と PR プロトコル / GitHub issue ループ |
| D6 | 捨てる: `launch-workspace.sh` / `prewarm-panes.sh` の cmux 形態、agmsg 配線、`loop-cleanup.sh` の cmux 部分、2×2 レイアウト、workspace close 経路 |

**D4 が保存を要求する「判断」**（親の列挙をそのまま採用する）: disk-only 規則 /
依頼側と reviewer 側の非対称性 / 「request が findings より新しい = 回答待ち」条件 /
abort ファイルによる reviewer の解放 / 自動再開への防衛と lease ファイル /
escalation sentinel / 既定で無制限の block。**変えるのは cmux 時代の artifact を名指ししている箇所だけ。**

### 3-2. 本 spec で決める事項

| # | 論点 | 決定 |
|---|------|------|
| S1 | 3 本が実行する send の argv 形をどうするか | **`bin/orca-send.sh` を境界に置く。** 根拠は byte 一致ではなく、`recovery-tick.sh`（C7）と `review-request.sh`（C8）が send を**パラメータとして受け取る設計**になっており、そこへ Orca の argv を直書きするより adapter を挿すほうが変更が小さいこと。加えて `--to` がロール名のまま保てる（dispatch id は Phase B で変わるが、ロール名は不変） |
| S2 | `<to>` の解決 | `<status-dir>/addressbook.json`（親が書き、子は読むだけ）が **active な Dispatch だけ**を載せる。Dispatch 交代時は原子的に更新する |
| S3 | ラベル | `--type` は 9 種固定（O8）なので、メッセージクラスは `--subject` のラベルで表す |
| S4 | 親の受信 | Monitor は **ack しない**。`--peek` を wake 信号として使い、ledger で重複 emit を抑える。**ack は親が前景で「全 message を処理した後」に行う**（O11） |
| S5 | runner wrapper | 残す。gate identity の export（C12）と `recovery-tick.sh` の watcher だけ。status 書き込みと親通知は全廃 |
| S6 | worker 起動 | `terminal create --command "bash <runner>"` → `terminal wait --for tui-idle` → `worker-start --task <id> --terminal <handle> --worktree <wt>`。model / effort は自前で argv に組む（O5 で `--terminal` と併用不可のため） |
| S7 | 状態の置き場所 | **ロールごとに独立した status dir** を持つ。Orca Task = 親から見える状態、`<status-dir>/roles/<role>/status.json` = そのロールの gate が読むディスク上の真実。**共有しない**ので F4 の失敗クラスが構造的に消える |
| S8 | worktree | 親が `worktree create --no-parent --name <slug> --base-branch <base> --setup run` で先に作る |
| S9 | 配置 | 同一 worktree に 4 端末。2×2 の等分割は要求しない |
| S10 | 完了の確定 | **二相コミット。** worker は成果を検証可能にしてから `merge_ready` を送り、親が disk と PR を検証して受理を返し、その後に worker が `worker_done` を送る（10 節） |
| S11 | 「タスク未着」の disk 信号 | `.assigned-*` を廃し、**`workers.json` の `assignment_state`**（`starting` / `active` / `failed` / `unknown`）で表す。`dispatch` キーの有無だけでは Task 注入と publish の race を閉じられない（round 2 finding 2） |

## 4. アーキテクチャ — cmux から Orca への対応

| cmux 版 | Orca 版 | 備考 |
|---|---|---|
| workspace（1 タスク = 1 workspace） | worktree（1 タスク = 1 worktree） | O18 |
| surface（ペイン） | terminal handle | |
| 2×2 固定配置 | 同一 worktree の 4 端末（配置は問わない） | S9 |
| agmsg team | Run | 1 ディスパッチ = 1 Run |
| agmsg agent 名 | `dispatch:<id>`（addressbook が解決） | S2 |
| `[ready]` 自己申告 | `worker-start` の receipt | O4。readiness が親から観測できる |
| `verify-agmsg-ready.sh` / `verify-roles-ready.sh` / `prune-not-ready.sh` | 廃止 | 同上 |
| `prewarm.json` | `<status-dir>/workers.json` | スキーマは別物（5-7） |
| 共有 `status.json` | **ロール別** `roles/<role>/status.json` | S7 |
| `.assigned-<agent>` | `workers.json` の `assignment_state` | S11 |
| `.deferred` | **廃止**（design が委譲しなくなる） | D2 |
| `dispatch-notify:` 完了通知 | `merge_ready` → 親の受理 → `worker_done` | S10 |
| 90 分単発タイマー + 再武装 | `check --wait --timeout-ms` のローリング待機 | 親も worker もターンを閉じずに待てる |
| pane close + signal 終了ガード | 11 節の cleanup decision table | O13 により `worker-release` だけでは閉じない |
| `cmux read-screen` | `worker-read` / `worker-show` | O14 の 3 値を区別する |

## 5. ライフサイクル（単一の状態機械）

初版は Phase B の Task モデルが節ごとに矛盾していた（round 1 finding 2）。本節が唯一の情報源である。

### 5-1. 状態遷移

```
[T0] 親: preflight → run-create
[T1] 親: worktree create → prepare-worktree → runner script ×4 生成
[T2] 親: terminal create ×4 → terminal wait --for tui-idle ×4
        （Task も Dispatch も無い。workers.json に assignment_state も無い）
[T3] 親: integration.json / .send-command / addressbook.json(空) / .wiring を publish
        ★ Task 注入より前に必ず完了させる（round 1 finding 7）
[T4a] 親: review 2 ロールを先に起動する。各ロールについて:
        task-create
        → workers.json へ {task, assignment_state:"starting"} を原子的に書く ★注入より前
        → worker-start --terminal
        → ready receipt で {dispatch, assignment_state:"active", generation:1} へ更新
        → addressbook へ dispatch:<id> を追加
[T4b] 親: design を起動する（review のアドレスが publish 済みであることが前提）
        task-create → starting を publish → worker-start → active へ更新
        → .wiring 削除
        ※ exec は端末だけ。workers.json の exec に task も dispatch も無い
[T5] design: Phase A → Phase A-R（design_review と直接 send/check）→ plan 保存
        → completion.json=prepared(nonce) → merge_ready → merge_ready_sent → ターンを閉じる
[T5b] 親: plan ファイルの実在を検証 → accepted(nonce) を design の active Dispatch へ
[T5c] design: accepted → report-status.sh done
        → worker_done --outcome succeeded --report-path <plan> (at-least-once)
        → settled を書き Delivery を ack
[T6] 親: design の worker_done を受理 → 11 節で design の端末を accounted にする
        → render-phase-b-spec.sh → task-create
        → workers.json の exec を {task, assignment_state:"starting"} へ ★注入より前
        → worker-start --task --terminal <exec>
        → ready receipt で {dispatch, assignment_state:"active", generation:1} へ更新
        → addressbook へ exec を追加
[T7] exec: Phase B → Phase B-R（exec_review と直接 send/check）→ commit
        → (pr) push → gh pr create → record-pr.sh
        → completion.json=prepared(nonce) → merge_ready → merge_ready_sent → ターンを閉じる
[T8] 親: result.md 実在 / result_missing / pr_url / gh pr view を検証
        受理 → accepted(nonce) を同じ active Dispatch へ
        不受理 → 同じ active Dispatch へ remediation を送る（10-5 へ）
[T9] exec: accepted → report-status.sh done → worker_done (at-least-once)
        → settled を書き ack
[T10] 親: review ロールへ終了を通知 → 各 review ロールも 10-4 の相を通る
[T11] 親: 11 節の cleanup decision table で全 Dispatch / terminal を accounted にする
        → worktree rm → branch → .dispatch 掃き出し
```

**exec が T4b で Task も Dispatch も持たない**ことが D2 の要求（親が Phase B の Task を作る）を
満たす。初版の「生涯 1 Dispatch + follow-up メール」は D2 の Phase B Task を消すため撤回した。

**T4a を T4b より先に置く**のは、design が起動直後に `review-request.sh` を送り得るためである。
その時点で design_review のアドレスが addressbook に publish 済みでなければ、依頼が宛先不明で
落ちる（round 2 finding 2）。

#### `assignment_state` — Task 注入と disk publish の race を閉じる（round 2 finding 2）

`worker-start` は Task を端末へ**注入してから** ready で親へ返る。したがって
「Task は worker に届いたが、親が `dispatch` キーをまだ書いていない」区間が必ず存在する。
`dispatch` キーの有無だけを「タスク到着」の信号にすると、この区間の Stop hook が
**受領済みの worker を未着と誤判定して allow する**。危険なのはこの向きであって、
「Dispatch はあるが Task spec が未達」ではない。

そこで **`worker-start` を呼ぶ前に** `task` と `assignment_state: "starting"` を原子的に
disk へ materialize し、ready receipt を得てから `dispatch` と `assignment_state: "active"`
へ遷移させる。gate の解釈:

| workers.json の状態 | gate の判定 |
|---|---|
| role キーに `assignment_state` が無い | 配線前。`.wiring` があれば静かに allow |
| `"starting"` | **allow しない。**「タスクが今まさに届いた可能性がある。プロンプトを読み直して続行せよ。本当に何も無ければ待て。terminal status を書くな」と block する |
| `"active"` | 通常の判定 1-7 |
| `"failed"` / `"unknown"` | O19 の復旧中。allow（処理は親が持つ） |

`worker-start` が `failed` / `outcome_unknown` を返したときは O19 に従って
`assignment_state` をそれぞれへ落とす。**disk 上の状態を rollback しない**
（資源が生存し得るため。11 節）。

`generation` は remediation（10-3）で増える。gate と `recovery-tick.sh` は generation の変化を
「前の試行の終端状態は無効」と読む。

review ロールの Task は「このタスクの Phase A-R / B-R を担当する」というレビュー期間全体を
覆う 1 つの Task とする。

#### 配送規律 — at-least-once + 冪等消費（親の裁定 1 / 2026-09-04）

round 3/4 版は「mutation を送る前に durable な identity を write-ahead し、exactly-once を
自前で作る」設計だった。**これは撤回する。**この系にその層の exactly-once は要らない。

理由は 3 つあり、どれも独立している。

1. **Orca が既に効果を keying している。**有効な `worker_done`（active な taskId + dispatchId）は
   Task と Dispatch を自動で completed にする（O9）。既に completed な Dispatch への 2 通目は
   2 つ目の効果ではない。**dedup key は送信前に手元にあるデータ**であって、応答から学ぶものではない
2. **Orca 自身の文書化された回復手順は replay identity ではなく state inspection である。**
   `request-show` の `absent` は「何も起きなかった証拠ではない。affected state を inspect してから
   retry を判断せよ」（実測 O21 の Notes）。`--retry-request` は**応答を受け取って request id を
   実際に持っている**場合のための、より狭い機構である
3. **移植元が逆の選択を意図的にしており、それが機能している。**cmux 版は「同じ完了通知が
   複数回届くのは正常。冪等に扱い status ファイルを信じよ」と明記する。2026-09-02 に
   カタログ化された 9 件の本番障害に、**重複通知は 1 件も含まれない**

したがって:

| 項目 | 規律 |
|---|---|
| 送信 | **at-least-once。**ただし送信前に state inspection を行う（下記） |
| 消費の冪等化 | **handler ごとに logical key を分ける**（下記） |
| ローカルの真実 | disk（`status.json` ほか）。cmux 版の `status.json` と同じ位置づけ |
| 撤回するもの | request identity の write-ahead、`worker_done_pending` phase、それを支えるためだけに存在した journal phase |
| 残すもの | `completion.json` のうち**自分のファイルのローカル crash 回復に本当に関わる部分**だけ |

#### 送信側の収束規則（round 5 finding 1）

O9 が保証するのは「completed 後の同じ送信が**2 つ目の状態効果にならない**」ことだけであり、
その送信が exit 0 で返るか、stale として非 0 で拒否されるかは保証していない。したがって
「無条件に再送してよい」は導けない。**O33 のとおり `worker_done` は preamble 由来の
capability を要求するため、外部から二重送信を実測することもできない。**
そこで、2 回目の rc が何であっても正しく収束する規則を置く。

1. `accepted` から再開したら、**送信の前に** `dispatch-show --task` / `worker-show --dispatch` を見る
2. 期待する outcome で既に terminal なら、**再送せず**ローカルに `settled` を書いて Delivery を ack する
3. active と確認できたときだけ送る
4. 送信が非 0 で返ったときも state inspection を行う。既に terminal なら成功相当へ収束、
   active なら bounded retry、unknown なら O19 / escalation
5. **親は `worker_done` を受けても、`completion.json = settled` の durable 化または
   親 sweep による同等の reconciliation を確認するまで reused terminal を明示 close しない。**
   しないと親の受信と worker の相 7 が競合し、`accepted` Delivery が未 ack のまま端末が閉じる

これは exactly-once journal の復活ではない。**at-least-once transport を採る場合にも
必要な、送信側の収束規則**である。

#### dedup key は handler ごとに分ける（round 5 finding 1）

`task_id` + `dispatch_id` だけでは粗すぎる。同一 Dispatch から `status` / `merge_ready` /
`worker_done` / `escalation` が**正当に複数届く**からである。message id は再送のたびに
変わるので logical duplicate の key にもならない。

| message | logical key |
|---|---|
| `worker_done` | `type` + `task_id` + `dispatch_id` + `outcome` |
| `merge_ready` | `type` + `task_id` + `dispatch_id` + `generation` + `nonce` |
| `accepted` | `type` + `task_id` + `dispatch_id` + `nonce` |
| `status` / `heartbeat` | message id（重複しても害が無い） |

**実測との関係**（O21）: `--retry-request` に caller 生成 id を渡す方式は**実際には動く**。
それでも採らないのは、上の理由 1 と 3 が実装可能性とは独立に成立するからである。
O21 は事実として記録するが、設計はこれに依存しない。

**この転換で解消される round 4 findings**:

- **finding 5（`--outcome failed` が journal を迂回する）は消滅する。**迂回すべき
  exactly-once journal がそもそも無くなる。**ただし失敗系にも durable intent は要る** —
  手順の正本は 10-2 の「失敗の出口」である（`result.md` → `report-status.sh error` →
  inspection → send）。ここでは繰り返さない
- **finding 1 は消滅する。**送信前に identity を得る必要が無い
- finding 2（generation transition）と finding 3（journal の write-ahead 順序）は**残る**が、
  request identity を持たない分だけ小さくなる。どちらも「自分の disk ファイルの
  ローカル crash 回復」に属するので、裁定 1 が残せと言っている側である

#### `starting` の所有者は親である（round 3 finding 1）

`assignment_state: starting` は通常起動の race を閉じるが、**親が receipt を disk へ
反映する前に落ちると gate が無期限 block する**。gate の block は recovery 機構ではない。
`starting` が滞留したときの所有者は worker ではなく親である。

覆うべき crash 境界:

| # | 位置 | 残る状態 |
|---|---|---|
| 1 | `starting` publish 直後、`worker-start` 呼び出し前 | Task はあるが Dispatch 無し |
| 2 | `worker-start` が Orca 側で成立、親が receipt を反映する前 | Dispatch はあるが disk は `starting` |
| 3 | `worker-start` が failed / outcome_unknown を返し、親が state を更新する前 | disk は `starting` |
| 4 | `worker-start` の応答自体を失った | 成否が不明 |

**親の起動時・再開時に `starting` を必ず sweep する**（6-5 の drain と同じ位置）。

1. journal の `launching` から slug / role / task_id / terminal / generation /
   spec fingerprint を読む
2. `dispatch-show --task <task_id>` / `worker-show` / `request-show --request <start_id>` で
   実際の成否を判定する（`start_id` は 12-1 の WAL が保持している）
3. 成立済み → `active` を publish（index にも `dispatch_id` を追加）/
   確定 failed → `failed` / outcome_unknown → O19 の経路へ
4. **判断は観測から行う。**12-1 の `launch_id` / `start_id` による収束規則に従う
   （`request-show` → `task-list` / `dispatch-show`）。**「重複起動は端末が 1 つ余るだけ」
   という旧記述は削除した** — 本設計は `--terminal` で既存 handle を使うので新しい端末は
   作られず、重複呼び出しの挙動も未実測である（12-1）

`recovery-tick.sh` は `starting` が `DISPATCH_STARTING_DEADLINE`（既定 10 分）を超えたら
親へ escalation を送る。**起点は `workers.json` の `starting_at`**（親が publish 時に書く
durable timestamp）であり、ファイルの mtime に暗黙依存しない（round 4 finding 6）。

**これは best-effort の発見補助であって correctness path ではない。**
correctness path は親の起動時・再開時 sweep である（round 4 finding 6）。理由は 2 つ:
T2 で端末と watcher を先に起動するので crash 境界 1 でも watcher は通常動いているが、
agent が終了すれば watcher も終わるし、親自体が停止していれば escalation を mailbox へ
積んでも sweep を実行する主体がいない。

#### generation transition は durable な transaction にする（round 3 finding 1 / round 4 finding 2）

`generation` を `workers.json` に持つだけでは、remediation 後の新試行が旧試行の
`.escalated` / `.gate-*` / nudge record / wait lease を現在のものとして読み得る。
そこで **generation を上げるときに role dir の transient set をまとめて archive** する。

```
roles/<role>/attempt-<n>/     ← 旧 generation の一式
  status.json  result.md  completion.json  .escalated  .gate-*  .gate-nudge-*
```

**ただし `mkdir` + 複数 `mv` は原子的ではない。**途中で落ちると
「`status.json` は移ったが旧 `completion.json=settled` は live role dir に残る」
「`.gate-*` が一部だけ残る」「旧 `result.md` と新 Task が混在する」といった状態になり、
再開時に「archive の続き」か「初期化済み」かも判別できない。したがって transaction にする。

```
1. 親が transition record を publish する（durable。先に書く）
     roles/<role>/.generation-transition
     {from:n, to:n+1, phase:"archiving",
      manifest:[...実ファイル名の全列挙...],
      commit_target:{...対象 role の **complete post-state**...}}
      ★ commit_target は「対象 role の完全な事後状態」である（patch ではない）。
        下の例示は変化する field の略記であり、record 自体は complete である。
        5-7 の role entry が持つ terminal / agent / runner / engine / model /
        effort / wired も含めた全 field を持つ（spec2r2 finding 5）
2. **他の writer を凍結する**（round 5 finding 4）:
     - gate は .generation-transition があるあいだ block する（旧終端状態も新 Task も採用しない）
     - **recovery-tick.sh も最上位で no-op にする。**gate が Stop で block しても
       runner watcher は 15 秒ごとに tick を回し、.escalated / nudge / lease を
       書き得る。移動済みの artifact が同名で再生成されると、archive 完了後も
       旧 generation の artifact が live dir に残る
3. manifest を 1 件ずつ mv する。各 mv は idempotent に:
     src のみ → mv / dst のみ → 済み / どちらも無し → 元から不在
     **両方ある → 内容を比較する**（round 5 finding 4）。同一 filesystem の atomic mv の
     正常な replay なら通常は両方にならない。両方は destination collision、旧 writer に
     よる src 再生成、あるいは内容の相違を意味し得る。**hash と型が一致するときだけ
     src を除去し、異なるなら削除せず transition を止めて escalation する**
4. manifest 全件の完了後に phase を "initializing" へ
5. 新 status.json に {"generation": n+1} を書く
6. **最新の workers.json を読み直し、他 role をそのまま保持したうえで、対象 role だけを
   commit_target で atomic に置換する**（spec2r2 finding 5）。
   record に full snapshot を持って丸ごと書き戻すと、transition 中に別 role が
   更新されていた場合にその更新を巻き戻す
     ★ starting 固定にしない（spec2 finding 4）。commit_target は 10-5 の 2 経路で異なる:
       経路 A (active rejection): {task: 既存, dispatch: 既存,
                                   assignment_state:"active", generation:n+1}
       経路 B (settled やり直し): {task: <new>, assignment_state:"starting",
                                   generation:n+1, starting_at:<now>}
7. .generation-transition を削除する
```

親の起動時 sweep（5-1）が `.generation-transition` を見つけたら **phase から再開する**。
`commit_target` も読むこと — from/to/phase だけを見ると、active 経路の transition を
`starting` へ誤復旧させる（spec2 finding 4）。

**manifest は実ファイル名を全列挙する**（glob を再評価しない）。列挙を取り違えると
落とし漏れが出る。round 3 版で `result.md` が 10-5 の列挙から落ちていたのがその例で、
そのまま実装すると stale な `result.md` を新試行が検証対象にできてしまった。
**manifest は 1 箇所（この節）で定義し、10-5 は参照するだけにする。**

個々の artifact に generation を埋め込む案は採らない。埋め込みは全 artifact の書き手を
変える必要があり、byte 一致で残すスクリプトを巻き込む。

### 5-2. Preflight（`bin/orca-preflight.sh`）

1. `ORCA_BIN`（既定 O1 のパス）が実行可能か
2. `orca status --json` の `ok` かつ `runtime.reachable`（O2 / O16）
3. `orca orchestration run-list --json` が成功するか（O3。副作用の無い読み取りで実験機能を確かめる）
4. `git rev-parse --show-toplevel` が通るか
5. **親自身の端末 handle（`parent_handle`）を確定する**（O26 / O28）
   - `ORCA_TERMINAL_HANDLE` が環境にあればそれを使う
   - 無ければ `terminal list --json` から特定する
   - `terminal show --terminal <handle>` で実在を確認する
   - **確定できなければ dispatch を止める。**暗黙の current-terminal 推定へ落ちない

exit 0 / 1（`ready=no reason=<slug>` を stdout）/ 2（使用法）。**rc=2 を「Orca が居ない」と報告しない。**

#### `--from` はすべての mutation に明示する（O28 / round 5 finding 8 / spec2 finding 2）

O28 のとおり mutation は sender terminal を要求し、候補が 1 つなら暗黙に選ばれ、
複数あると `no_active_sender_terminal` で拒否される。O26 の誤束縛はこの暗黙解決が原因だった。

**フラグ名は CLI ごとに違う**（spec2r2 finding 2。実測で確認した）。
`check` に `--from` は**存在しない** — selector は `--terminal` である。
`send` / `reply` / `run-create` / `task-create` / `worker-start` は `--from` を持つ。

| 呼び出し | 必須 |
|---|---|
| `run-create` | `--from <parent_handle>`。**応答の `coordinator_handle` が一致しなければ止める** |
| `task-create` | `--from <parent_handle>` + `--retry-request <launch_id>`（12-1） |
| `worker-start` | `--from <parent_handle>` + `--retry-request <start_id>`（12-1） |
| 親が送る `send` / `reply` | `--from <parent_handle>` |
| 親の `check`（drain / ack / wait） | **`--terminal <parent_handle>`。`--from` を渡すと引数エラーになる** |

`parent_handle` は `<status-dir>/run.json` へ保存する。**再開時も曖昧な推定へ戻らない。**

### 5-3. worktree（S8）

```
orca worktree create --repo <selector> --name <slug> --no-parent \
  --base-branch <repo default base> --setup run --json
```

base はリポジトリ既定 base。現在のフィーチャブランチを base にするのはユーザーが
スタック作業を明示的に求めたときだけ。返る `<repo-id>::<path>` の完全形を以後の
`--worktree` に使う。ブランチ名は `feat/<slug>` を維持する。

### 5-4. worktree の準備（`bin/prepare-worktree.sh`）

端末は作らない。C11 のとおり worktree 内のファイルを書く。

| 対象 | 内容 | 条件 |
|---|---|---|
| `.claude/settings.local.json` | `permissions.defaultMode: "bypassPermissions"` をマージ | claude engine |
| 同上 | PostToolUse hook（`ExitPlanMode` → `plan-approved-hook.sh`） | claude engine かつ plan モードの design |
| `.claude/settings.local.json` / `.codex/hooks.json` | Stop hook = `completion-gate.sh`。既存 gate entry を除去してから 1 本足す | 全ロール |
| `.git/info/exclude` | `.claude/settings.local.json` / `.claude/plans/` / runner script / `.dispatch-handoff.json` | 常時 |
| `.dispatch-handoff.json` | **role-keyed schema**（下記）。4 ロールが 1 worktree を共有するので単数の `role` / `status_dir` では表せない | 常時（ベストエフォート） |

```json
{
  "dispatch_root": "/abs/.dispatch/<slug>",
  "review_dir":    "/abs/.dispatch/<slug>/review",
  "run_id":        "run_abc",
  "addressbook":   "/abs/.dispatch/<slug>/addressbook.json",
  "send_command":  "/abs/<plugin>/bin/orca-send.sh",
  "roles": {
    "design":        {"status_dir": "/abs/.dispatch/<slug>/roles/design",        "agent": "slug"},
    "design_review": {"status_dir": "/abs/.dispatch/<slug>/roles/design_review", "agent": "slug-design-review"},
    "exec":          {"status_dir": "/abs/.dispatch/<slug>/roles/exec",          "agent": "slug-exec"},
    "exec_review":   {"status_dir": "/abs/.dispatch/<slug>/roles/exec_review",   "agent": "slug-exec-review"}
  }
}
```

`completion-gate.sh` の fail-open 経路（identity が env にも引数にも無いとき）はこのファイルを
読んで `.gate-open` を記録する。role が解決できないので、記録先は `dispatch_root` 直下とする。

書き込みは同一ディレクトリの `mktemp` + `mv`。権限バイパスの確認は `jq -e` による
ファイル実体判定で行い、確認できなければ `--dangerously-skip-permissions` へフォールバックする。

**codex ロールには O20 の対策を入れる。** `--add-dir` は interactive codex の seatbelt に届かない。
review dir とロール別 status dir は `-c sandbox_workspace_write.writable_roots=[...]`
（single-quoted TOML literal 形式）で渡す。これは cmux 版 `launch-workspace.sh` の
`--add-dir` 経路の置き換えであり、F7 の恒久対応である。

### 5-5. runner wrapper（S5）

`<worktree>/.orca-team-dispatch-task-run-<role>.sh`。

#### 4 つの入力を別物として扱う（round 2 finding 1）

per-role status dir を導入すると、**ロール固有の状態**と**タスク共有のメタデータ**が
別のディレクトリに分かれる。移植元のスクリプトは両者が同一 root にある前提で書かれているため、
role dir を 1 つ渡すだけでは動かない。実測で確認した破綻点:

| 参照箇所 | 前提 | role dir を渡すと |
|---|---|---|
| `recovery-tick.sh:21-22` | `$status_dir/.send-command` | `roles/<role>/.send-command` を探して見つからず、`send_to` が常に失敗する（nudge と escalation が黙って届かない） |
| `recovery-tick.sh:100` | `review_select_active "$status_dir"` | `review-state.sh:22,28` が `$sd/review/*.md` を読むため `roles/<role>/review/` を走査し、実在する共有 review を一度も見ない |
| `completion-gate.sh:355` | `review_select_active "$STATUS_DIR" "$GATE_POINT"` | 同上 |
| `completion-gate.sh:107` | `$STATUS_DIR/.send-command` | 同上に見つからず、最終 reason の通知コマンドが欠落する |

したがって次の **4 つを別々の入力**として明示する。

| 入力 | 値 | 用途 |
|---|---|---|
| `role_status_dir` | `<status-dir>/roles/<role>` | `status.json` / `result.md` / `completion.json` / `.escalated` / `.gate-*` / `attempt-<n>/` |
| `dispatch_root` | `<status-dir>` | `review_select_active` に渡す root（`review-state.sh` は自分で `/review` を足す） |
| `review_dir` | `<status-dir>/review` | `review-request.sh --review-dir` |
| `send_command` | `<plugin>/bin/orca-send.sh` | `recovery-tick.sh --send-command` / gate の reason |

`recovery-tick.sh` は既に `--send-command` を受け取る（`:16`）ので、runner が**明示的に渡す**。
`.send-command` フォールバックには依存しない。加えて `--dispatch-root` を新設し、
`review_select_active` へはそれを渡す。`completion-gate.sh` にも同じ `--dispatch-root` を足す。
**これにより `review-state.sh` は byte 一致のまま残せる**（root を受け取る契約が変わらないため）。

保険として、親は `.send-command` を dispatch root と**各 role dir の両方**へ書く。
どちらのフォールバックが効いても同じ値に解決される。

```sh
#!/usr/bin/env bash
export DISPATCH_GATE_ROLE=<role>
export DISPATCH_GATE_AGENT=<slug>[-<role>]
export DISPATCH_GATE_STATUS_DIR=<status-dir>/roles/<role>   # role_status_dir
export DISPATCH_DISPATCH_ROOT=<status-dir>                  # dispatch_root
export DISPATCH_REVIEW_DIR=<status-dir>/review              # review_dir
export DISPATCH_GATE_TEAM=<run-id>
export DISPATCH_WORKERS_FILE=<status-dir>/workers.json
export AGMSG_SEND=<plugin>/bin/orca-send.sh                 # send_command
export ORCA_ADDRESSBOOK=<status-dir>/addressbook.json

<agent argv> &
AGENT_PID=$!
( while kill -0 "$AGENT_PID" 2>/dev/null; do
    sleep 15
    bash <skill>/scripts/recovery-tick.sh \
      --status-dir "$DISPATCH_GATE_STATUS_DIR" \
      --dispatch-root "$DISPATCH_DISPATCH_ROOT" \
      --send-command "$AGMSG_SEND" \
      --role "$DISPATCH_GATE_ROLE" --agent "$DISPATCH_GATE_AGENT" \
      --team "$DISPATCH_GATE_TEAM" >/dev/null 2>&1
  done ) &
WATCHER_PID=$!
trap 'kill "$WATCHER_PID" 2>/dev/null' EXIT INT TERM
wait "$AGENT_PID"
```

初版は `exec <agent argv>` としており、watcher が agent 終了後に残る可能性があった
（round 1 finding 4）。**agent を `exec` せず PID を持ち、watcher の生存を agent PID に
結び付け、`trap` で回収する。** 回帰テストで「agent 終了後に watcher が残らない」を固定する。

cmux 版 wrapper から削除するもの: `status.json` の書き込み / 親への通知（exit 時・watcher 経由の両方）/
signal 終了ガード / `cmux wait-for` / `cmux notify`。すべて Orca lifecycle と S10 が担う。

codex の goal 継続対策 `-c features.goals=false` は agent argv に維持する。

### 5-6. 端末の作成と supervised worker 化（S6）

```
orca terminal create --worktree id:<wt> --title <slug>-<role> \
  --command "bash .orca-team-dispatch-task-run-<role>.sh" --json
orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 120000 --json
orca orchestration worker-start --task <task_id> --terminal <handle> --worktree id:<wt> \
  --from <parent_handle> --retry-request <start_id> --json
```

`dispatch --inject` は使わない（O15 で unsupervised になる）。
`worker-start` の非 0 は O19 の分岐で扱う（11 節）。**無条件の rollback はしない。**

### 5-7. `workers.json`

`prewarm.json` の後継。スキーマは別物なので `prewarm-snapshot.sh` を
**`workers-snapshot.sh` として改変**する（C1）。検証の**構え**（1 回だけ読み、文書全体を検証し、
以後はローカル値からだけ抽出する）は保存する。

```json
{
  "run_id": "run_abc",
  "worktree_id": "<repo-id>::/path/to/.worktrees/slug",
  "review_mode": "on",
  "design":        {"terminal":"term_1","task":"task_1","dispatch":"disp_1","assignment_state":"active","generation":1,"agent":"slug","runner":"claude","engine":"claude","model":"opus[1m]","effort":"xhigh","wired":true},
  "design_review": {"terminal":"term_2","task":"task_2","dispatch":"disp_2","assignment_state":"active","generation":1,"agent":"slug-design-review","runner":"codex","engine":"codex","model":"gpt-5.6-sol","effort":"xhigh","wired":true},
  "exec":          {"terminal":"term_3","agent":"slug-exec","runner":"codex","engine":"codex","model":"gpt-5.6-terra","effort":"high","wired":true},
  "exec_review":   {"terminal":"term_4","task":"task_4","dispatch":"disp_4","assignment_state":"active","generation":1,"agent":"slug-exec-review","runner":"claude","engine":"claude","model":"opus[1m]","effort":"xhigh","wired":true}
}
```

**`assignment_state` が「そのロールにタスクが届いたか」を表す**（S11 / round 2 finding 2）。
T4b 時点の exec は `task` も `dispatch` も `assignment_state` も持たない。T6 で親が
`starting` → `active` の順に原子的に追加する。

`.wiring` sentinel は維持する（F6 の再発防止）。起動済み端末の Stop hook は
`workers.json` の publish より前に発火するため、gate の「`.wiring` があれば静かに allow」分岐を保存する。

## 6. メッセージング

### 6-1. addressbook（S2）

```json
{
  "run": "run_abc",
  "agents": {
    "slug":               "dispatch:disp_1",
    "slug-design-review": "dispatch:disp_2",
    "slug-exec-review":   "dispatch:disp_4",
    "parent":             "run:run_abc"
  }
}
```

**active な Dispatch だけを載せる。** T4 時点で `slug-exec` は載らない。T6 で追加し、
settle したロールは削除する。更新は同一ディレクトリの `mktemp` + `mv` で原子的に行う。
未登録の宛先への送信は adapter が exit 1（未配送）にする — settled な Dispatch へ
送って黙って失うより、送信側に見えるエラーにする。

### 6-2. adapter（`bin/orca-send.sh`）

```
orca-send.sh <team> <from> <to> <body>
```

1. `<team>` を Run id として扱い、addressbook の `run` と照合する
2. **sender handle を自分で解決する**（spec2r3 finding 1）。`<from>` の論理 agent 名を
   terminal handle として使わない。`ORCA_TERMINAL_HANDLE`（Orca が端末へ入れる。O28）
   または runner が明示 export した env から**自分の terminal handle** を取り、
   `--from` に渡す。**取得できなければ Orca の暗黙推定へ落ちず exit 1** —
   O28 のとおり候補が 1 つのときは誤った端末へ暗黙束縛され得るためである。
   lifecycle message の preamble identity（6-4b）とは**別契約**である
3. `<to>` を addressbook で解決する。未登録なら exit 1
4. `<body>` 先頭のラベルを切り出して `--subject` に、残りを `--body` に載せる
5. `orca orchestration send --from <自分の handle> --to <addr> --subject <label> --body <rest> --type status --json`
6. 非 0 終了は**未配送**

exit: 0 / 1（未配送）/ 2（使用法）。

### 6-3. ラベル

| label | 送信元 → 送信先 | `--type` |
|---|---|---|
| `review-plan:` | design → design_review | `status` |
| `review-code:` | exec → exec_review | `status` |
| `review-verdict:` | review ロール → 依頼元 | `status` |
| `abort-reviewer:` | 依頼元 → review ロール | `status` |
| `dispatch-notify:` | 子 → 親（進捗報告） | `status` |
| `dispatch-nudge:` | 親 → 停滞した子 | `status` |
| `phase-b-exec:` | 親 → exec | Task spec として注入（6-4）。**adapter は使わない**（6-4b） |
| 完了申告 | 子 → 親 | `merge_ready`（S10） |
| 完了確定 | 子 → 親 | `worker_done` |

`phase-a-task:` は廃止する。Phase A の指示は design の Task spec そのものになる。

### 6-4. Phase A / Phase B の指示配送

Phase A は `task-create --spec` に入れる。`worker-start` が preamble + TASK ブロックを注入し、
その時点でペインは ready である（O4）ため、別途の指示メッセージは不要である。

Phase B も同じ形をとる。親が `render-phase-b-spec.sh` で spec を組み、`task-create` してから
`worker-start --task <id> --terminal <exec handle> --worktree <wt>` を呼ぶ（T6）。
**親が spec を手書きすることを禁止する** — reviewer の agent 名 / review dir / round ファイル規約 /
PR 手順 / parallel directive は helper の出力にしか存在せず、手書きすると情報ごと消える
（cmux 版で 2026-08-31 に実測された事故クラス）。

### 6-4b. worker lifecycle コマンドの正本（spec2 finding 1）

**worker が送る lifecycle message の argv はここだけで定義する。**他の節はここを参照する。

worker は **現在の injected preamble が与えた identity 一式**を使う。
`workers.json` などの disk metadata から個別に再構成してはならない — preamble は
`--from` の正しい値も含めて一組で与えられる（`send --help`: 「injected preambles
include the correct `--from` value」）。

| 値 | 出所 |
|---|---|
| task id | preamble |
| dispatch id | preamble |
| **dispatch capability** | preamble（O33。これが無いと `dispatch_capability_invalid`） |
| `--from` handle | preamble |
| outcome / subject / body / files-modified / report-path | 処理結果から足す |

```
# 完了（成功・失敗とも）
orca orchestration send --type worker_done \
  --task-id <task_id> --dispatch-id <dispatch_id> \
  --dispatch-capability <preamble の token> --from <preamble の handle> \
  --outcome succeeded|failed \
  --subject "<short status>" --body "<何をして何が残ったか>" \
  [--files-modified "a,b"] [--report-path <path>] --json

# 成果の申告（10-1 の相 2）
orca orchestration send --type merge_ready \
  --task-id <task_id> --dispatch-id <dispatch_id> \
  --dispatch-capability <preamble の token> --from <preamble の handle> \
  --subject "merge_ready: <slug>/<role>#<generation>" \
  --payload '{"generation":<n>,"nonce":"<nonce>"}' --json
```

`merge_ready` の `generation` と `nonce` は**親の routing / dedup が要求する**（5-1 の
handler 別 key）ので、`--payload` に載せる。`--subject` にも
`<slug>/<role>#<generation>` を入れて人間可読にする。

**adapter（`bin/orca-send.sh`）は lifecycle には使えない。**adapter は常に
`--type status` を送るので（6-2）、`worker_done` と `merge_ready` には使わない。
adapter が扱うのは `review-plan:` / `review-code:` / `review-verdict:` /
`abort-reviewer:` / `dispatch-notify:` / `dispatch-nudge:` の 6 ラベルだけである。

#### identity 一式の寿命は **Dispatch** であって generation ではない（spec2r2 finding 1）

stale 判定の key は **Dispatch identity** である。generation ではない。

| 状況 | 現在の preamble identity 一式 |
|---|---|
| 10-5 **経路 A**（active rejection。generation は上がるが Dispatch は同一） | **そのまま有効。**新しい preamble は届かない（`task-create` も `worker-start` も ready receipt も無い）ので、旧 tuple を無効化すると worker は capability を 1 つも持たなくなり `merge_ready` も最終 `worker_done` も送れなくなる |
| 10-5 **経路 B** / replacement / その他 **新しい Dispatch を作る経路** | **交換する。**新しい preamble が与えた一式だけを使い、旧 Dispatch の capability を使わない |

**generation を跨いでも Dispatch が同じなら同じ tuple を使い続ける。**
「世代ごとに使い捨てる」という round 1 版の記述は誤りだったので撤回する。

`heartbeat` も exact-Dispatch signal なので同じ扱いを要するが、**本設計では使わない**
（親は `check --wait` で待つので heartbeat を必要としない）。将来使うならこの節へ足す。

### 6-5. 親の受信と ack の順序（S4 / finding 3）

**Monitor は ack しない。** ack は「Delivery の全 message を処理したこと」の宣言であり（O11）、
emit は処理ではない。

```
Monitor（背景・wake 信号。ack は一切しない）:
  loop:
    out = check --terminal <parent_handle> --wait --peek \
            --types worker_done,escalation,question,merge_ready,status \
            --timeout-ms 600000 --json      # stdout のみ。2>&1 禁止（O10）
    now = 現在時刻
    for m in out.messages:
      if m.id in <run-dir>/processed.json:        # 唯一の tombstone は親が書く
        continue
      e = <run-dir>/emitted-ledger.json[m.id]
      if e is None:
        emit 1 行; ledger[m.id] = {first_emitted: now, last_emitted: now}
      elif now - e.last_emitted >= REEMIT_INTERVAL:   # 既定 120 秒
        emit 1 行; e.last_emitted = now              # at-least-once の再 emit
      # それ以外は rate limit により黙る（永久抑止ではない）

親（起動時・再開時に必ず 1 回。wake を待たない）:
  drain: `check --terminal <parent_handle> --json` で未 ack Delivery を処理し切る。**停止条件は 2 つ**（round 5 finding 6）:
         (a) check が空を返した、または
         (b) 最古の batch が一時 routing-blocked になった
         → (b) では **その drain pass を終了**し、Monitor の rate-limited 再 emit と
           親 sweep へ戻る。同じ batch を即座に引き直すと tight loop になる
         ★ Monitor の wake に依存しない reconciliation

親（前景・各 wake で）:
  out = check --terminal <parent_handle> --json   # 最古の未 ack batch を消費読み
  <run-dir>/deliveries/<delivery_id>.json へ batch 全体を保存   ★ 先に永続化
  for m in out.messages:                     # 目的の label 以外も捨てずに処理する
    if m.id in <run-dir>/processed.json: continue
    route(m) → <slug>/<role>                 # 12-1。routing 不能なら ack しない
    handle(m)                                # 冪等。message id / task id / dispatch id で識別
    <run-dir>/processed.json へ m.id を追記（原子的置換）
  ★ lifecycle message が 1 通でも未処理なら ack しない（次の check で同じ batch が返る。O23）
  check --terminal <parent_handle> --ack <delivery_id> --json   # 全部処理してから
```

**`emitted-ledger.json` は再 emit のレート制限であって tombstone ではない**（round 2 finding 3）。
O22 により message は ack まで `--peek` に現れ続けるので、ledger が無いと毎ループ再 emit してしまう。
逆に永久抑止にすると wake が消える。したがってレート制限が正しい。
emit した直後・親が foreground check に入る前にプロセスやターンが失われると、
Delivery は Orca 側に未 ack で残るのに Monitor は二度と emit せず、**wake が永久に消失する**。
message は失われていないが、外から見れば永久待機と区別がつかない。

したがって ledger は **tombstone ではなく再 emit のレート制限**とする。

- ledger のエントリは `{id, first_emitted, last_emitted}`
- 再 emit の条件: `peek` にまだ現れている **かつ** `processed.json` に無い
  **かつ** `last_emitted` から `AGMSG_REEMIT_INTERVAL`（既定 120 秒）以上経過している
- **唯一の tombstone は親が書く `processed.json`** である。Monitor は自分で永久抑止しない
- 配送は at-least-once になる。重複は `processed.json` が吸収する

- crash-before-ack: 再起動後に同じ batch が replay されるが、`processed.json` により
  handler は再実行されない。ack だけがやり直される
- **emit 後・foreground check 前の crash**: `processed.json` に入っていないので
  再 emit 間隔の経過後に Monitor がもう一度 wake を出す
- crash-after-ack: 処理は済んでいる。`deliveries/` に batch が残るので事後検証できる
- **冪等性を要求する handler**: Phase B の Task 作成（task id で識別）/ `reply` /
  `worker-release` / cleanup

worker 側の待機も同じ規律に従う:

```
check --terminal <自分の handle> --wait --types status --timeout-ms 600000 --json
  → batch 全体を処理（目的外の message も捨てない）
  → 次の待機は check --terminal <自分の handle> --ack <previous delivery_id> --wait ...
    で 1 コールにまとめる
```

**どの起床でも先に findings ファイルを読み直す**（失われうるのはメッセージだけ）。
`review-verdict:` が来たのに `VERDICT:` 行が無ければ `needs_work` 扱い。
タイムアウトは verdict ではない。

cmux 版の「claude 待機者だけが safety timer を張れる / codex 待機者には保険が無い」という
非対称性は消える。`check --wait` は engine 非依存である。ただし Bash tool の timeout 上限
（600 秒）を超える `--timeout-ms` を前景で使ってはならない。

## 7. レビュー（Phase A-R / B-R）

D3 のとおり追加 Task を作らず、worker 間の直接 `send` / `check` で行う。
depth 制限（O12）は dispatch にかかり send にはかからない。

依頼は `review-request.sh`（改変版）への 1 コールで行う。ファイル書き込みと送信を
まとめて行い、送信に失敗したら書いたファイルを削除する契約を保存する — これが F1 の
非再発根拠であり、gate が「待機」を見る唯一の材料である。

review dir は**タスク単位で共有**する（`<status-dir>/review/`）。ロール別 status dir（S7）の
外に置く。依頼側と reviewer の両方が読み書きするためである。gate は `DISPATCH_REVIEW_DIR`
から読む（5-5 で runner が export する）。

**codex reviewer の書き込み権限**は 5-4 の `writable_roots` で与える（O20）。
これが無いと reviewer は findings を書けず、依頼元が代筆する運用（本ディスパッチで
実際に発生した）になる。恒久対応として `writable_roots` を採用する。

## 8. スクリプトの分類

### 8-1. byte 一致で持ち込む 7 本

`review-state.sh` / `record-pr.sh` / `escalate.sh` / `config-resolve.sh` / `config-edit.sh` /
`override-args.sh` / `parallel-directive.sh`

2-2 の監査で cmux 時代の artifact への実コード依存が 0 と確認されたものだけである。
`review-state.sh` と `parallel-directive.sh` の `phase-b-deliver.sh` 言及はコメント内のみ。

`review-state.sh` を byte 一致で残せるのは、**呼び出し側が `dispatch_root` を渡す**からである
（round 2 finding 1）。同スクリプトは受け取った root に自分で `/review` を足す
（`review-state.sh:22,28`）ので、per-role status dir を渡してはならない。

### 8-2. 改変して持ち込む 9 本

| script | 改変内容 |
|---|---|
| `completion-gate.sh` | `prewarm.json` → `workers.json`（`DISPATCH_WORKERS_FILE`）。「タスク未着」判定を `.assigned-*` から `assignment_state` へ（C3 / S11 / round 2 finding 2）。`--dispatch-root` を新設し `review_select_active` へはそれを渡す。send command の取得元を `DISPATCH_GATE_STATUS_DIR` ではなく引数 / `AGMSG_SEND` / role dir の `.send-command` の順にする（round 2 finding 1）。`completion.json` があれば phase を問わず allow（10-3）。generation は role dir の archive で分離されるので、gate は現 role dir だけを見ればよい（5-1）。`.deferred` 分岐を削除（D2）。`DELEGATE_HINT` を削除。最終 reason の完了手順を `report-status.sh` + `merge_ready`（S10）へ。liveness 案内を `worker-show` へ。review dir を `DISPATCH_REVIEW_DIR` から読む。**判定 1-7 の論理と block/allow の非対称性は保存する** |
| `prewarm-snapshot.sh` → `workers-snapshot.sh` | スキーマを 5-7 の形へ。検証の構えは保存 |
| `config-lib.sh` | config home を `orca-team-dispatch-task` へ。`dispatch_valid_workspace_id` / `dispatch_valid_surface_id` を `dispatch_valid_terminal_handle` / `dispatch_valid_dispatch_id` / `dispatch_valid_run_id` へ置換 |
| `report-status.sh` | V2 ガード（`.deferred`）を**削除**する。per-role status dir（S7）により design が他ロールの status を書く経路が構造的に無くなるため、ガードが守るべき不変条件そのものが消える。V1（`pr_url`）と V3（`result_missing`）は保存 |
| `recovery-tick.sh` | `--dispatch-root` を新設し `review_select_active` へはそれを渡す（round 2 finding 1）。`--send-command` は runner が明示的に渡す。**停止条件の定義は 10-3 にある。ここでは繰り返さず参照する**（spec2 finding 3 / finding 6）。`starting` が既定 10 分を超えたら親へ escalation を送る（5-1）。generation transition 中は最上位で no-op にする（5-1） |
| `review-request.sh` | `AGMSG_SEND` の既定値を `orca-send.sh` へ。ラベル選択（`code` → `review-code:` / それ以外 → `review-plan:`）と補償ロジックは保存 |
| `issue-fetch.sh` | evidence の `prewarm.json` を `workers.json` へ（C10）。死んだ `CMUX` 変数を削除する（byte 一致を守る理由が無くなったため） |
| `review-gate.sh` | surface / workspace の検証を terminal / dispatch の検証へ |
| `work-signal.sh` | 画面成分を `cmux read-screen` から `worker-read --source terminal` へ。**画面成分を落とさない**（落とすと「ずっと読んで考えていた」セッションを停滞と誤判定する）。`worker-show` の `agentWait` は停止判定に使わない（O14） |

### 8-3. 新規 7 本

| ファイル | 役割 |
|---|---|
| `bin/orca-preflight.sh` | 5-2 |
| `bin/orca-send.sh` | 6-2 |
| `bin/orca-worker-launch.sh` | 5-3〜5-6 を 1 コールに。T1-T4 の順序と rollback 境界を持つ |
| `bin/prepare-worktree.sh` | 5-4 |
| `bin/resolve-integration.sh` | 9-2（finding 7） |
| `bin/render-phase-b-spec.sh` | 6-4 |
| `bin/orca-cleanup.sh` | 11 節 |

### 8-4. 上流ドリフトの検出

byte 一致 7 本は `test-upstream-sync.sh` が cmux 版との一致を検査する。
改変 9 本は**改変時点の上流ハッシュを記録**し、上流が動いたら
`test-upstream-drift.sh` が赤くなる。ドリフトは自動追従せず、人が差分を見て
「Orca 版にも要るか」を判断する。**byte 一致を守るために cmux artifact を温存しない**（D4）。

## 9. 状態の置き場所

### 9-1. per-role status directory（S7）

```
.dispatch/
  .run/<run_id>/                # ★ Delivery 台帳は Run 単位（round 2 finding 5）
    deliveries/<delivery_id>.json   # batch 全体の永続化
    processed.json                  # 処理済み message id（唯一の tombstone）
    emitted-ledger.json             # Monitor の再 emit レート制限
    index.json                      # task_id / dispatch_id → <slug> の routing 表
    journal.json                    # issue/タスクごとの durable state（12 節）
  <slug>/
    workers.json            # 親が書く。role → terminal / task / dispatch /
                            #   assignment_state / generation
    addressbook.json        # 親が書く。active Dispatch だけ
    run.json                # 親が書く。Run id
    .send-command           # 親が書く（dispatch root 側）
    .wiring                 # 配線中の sentinel
    review/                 # タスク単位で共有（7 節）
    roles/
      design/        status.json  result.md  .send-command  .escalated
                     completion.json  .gate-*
                     attempt-<n>/  ← 旧 generation の一式を archive
      design_review/ 同上
      exec/          同上 + integration.json
      exec_review/   同上
```

**共有 `status.json` が無くなることで F4 の失敗クラスが構造的に消える。**
cmux 版はこれを `.deferred` + V2 ガード + 「review ロールに `.assigned-*` を作らない」規約 +
「`--mode review` の runner は status を書かない」の 4 層で防いでいた。per-role dir は
その 4 層すべてを 1 つの構造で置き換える。

`report-status.sh` / `record-pr.sh` / `escalate.sh` は `<status-dir>` 相対なので、
role_status_dir を渡すだけで動く（`record-pr.sh` は exec の、`escalate.sh` は呼び出し元ロールの role dir）。
**`recovery-tick.sh` は例外である** — `dispatch_root` と `send_command` も要る（5-5）。
`completion-gate.sh` も同じく 4 入力すべてを要求する。

### 9-2. `integration.json` の生成契約（finding 7）

`bin/resolve-integration.sh` が親側で:

1. `git remote get-url origin` を解決する。**origin が無い / 複数候補がある / GitHub 形式でない**
   場合は exit 1 で dispatch を止める（推測しない）
2. `owner/repo` を厳格に抽出する
3. `base` = リポジトリ既定 base、`head` = `feat/<slug>`、`issue` = loop モードでのみ
4. JSON schema を検証してから `roles/exec/integration.json` へ原子的に書く

**T3 で書く。Task 注入（T4）より前である。** `worker-start` は Task を直ちに注入するため、
順序を逆にすると worker が `integration.json` の無い期間に動ける。`report-status.sh` の V1 は
ファイル不在時に fail-open なので、順序が唯一の防衛線になる。

`integration=merge` のときも `{"integration":"merge"}` を必ず書く — 不在を「merge のことだろう」と
推測させない。

## 10. 完了の二相コミット（S10 / round 1 finding 5 / round 2 finding 4）

初版は `report-status.sh done` → `worker_done` の順としていた。これは split-brain を作る:
`worker_done` の配送に失敗すると disk は `done`、Task/Dispatch は active のまま残り、
gate は停止を許し（判定 1）、`recovery-tick.sh:75-78` も `done` を見て回復を止め、
親は永久に待つ。逆に worker が `worker_done` を先に送ると Orca が先に settle し、
親が検証に失敗しても同じ Dispatch へ修正を返せない。

### 10-1. 全ロール共通のプロトコル

**design も含めて全ロールがこれを通る**（round 2 finding 4a）。初版は design だけ
`status.json = done` から直接 `worker_done` を送っており、split-brain が design に残っていた。

| 相 | 実行者 | 内容 | disk |
|---|---|---|---|
| 1 | worker | 成果を検証可能な状態にする（exec は `record-pr.sh` まで） | — |
| 2 | worker | `completion.json` を `prepared`(nonce) で書く → `merge_ready`(nonce) を親へ → `merge_ready_sent` へ → **ターンを閉じる** | `completion.json` |
| 3 | 親 | 検証する。design = plan ファイルの実在。exec = `result.md` 実在 / `result_missing` / `pr_url` / `gh pr view` による PR 実在 | — |
| 4a | 親 | 受理 → `accepted`(同じ nonce) を **active な** Dispatch へ | — |
| 4b | 親 | 不受理 → 同じ active Dispatch へ remediation を送る（相 1 へ戻る） | — |
| 5 | worker | nonce 一致を確認 → `accepted` を書く → `report-status.sh <role-dir> done <要約>`（exec は V1 が `pr_url` を要求） | `completion.json = accepted` / `status.json = done` |
| 6 | worker | **5-1 の inspection-first 収束規則に従って** `worker_done --outcome succeeded` を送る（argv は 6-4b） | — |
| 7 | worker | **成立を確認できた後**（rc 0、**または** 送信前 / 非 0 後の inspection で Orca が terminal と分かったとき）に `settled` を書き、当該 Delivery を ack。`completion.json` は**削除しない**（完了記録かつ nonce の保管場所） | `completion.json = settled` |

#### 失敗の出口（裁定 1 で簡素化。durable intent は持つ）

**失敗の出口は塞がない。**親の受理も要求しない。ただし at-least-once である以上、
**crash 後に「まだ送るべきものがある」と思い出すための durable state が要る**
（spec2 finding 3）。`result.md` を書くだけでは「失敗 report は準備済みだが
`worker_done failed` は未確定」という状態を一意に表せない。

新しい journal は作らない。**既存の `status.json` をローカル権威として使う。**

```
1. result.md に理由を書く
2. status.json へ report-status.sh <role-dir> error <理由>   ★ durable intent
   （`status = error` が「失敗 outcome を送る意図がある」ことの記録になる）
3. 5-1 の inspection-first 収束規則
4. active なら worker_done --outcome failed（argv は 6-4b）
5. terminal なら送らず完了扱い
6. unknown なら O19
```

#### durable intent を実行できる owner の回復（spec2r2 finding 3）

O33 により **親は `worker_done` を代理送信できない**。したがって「再送を促す」だけでは、
元の agent process が消えた場合に誰も送れない。これは失敗系だけの問題ではなく、
`completion.json = accepted` / `status.json = done` の後・`worker_done` の前に worker が
失われた**成功系にも同じく存在する**。

**親 sweep が正しさの主体**なので、次の分岐まで親が所有する。

| 観測 | 行動 |
|---|---|
| 元 Dispatch が active で worker が到達可能 | exact Dispatch へ nudge する。worker は**同じ current preamble**（6-4b。経路 A なら generation を跨いでも同一）で 5-1 の inspection-first 規則を続ける |
| `worker-show` が `failed` / `stopped` を証明 | 同じ Task に `worker-start --retry-of <old-dispatch>` + **明示 placement**（`--terminal` / `--worktree` / `--from`）で replacement を作る。新しい worker は**新しい preamble**を得て、disk の intent（`status.json` の `done` / `error`）を読み、期待 outcome を報告する。更新順は **12-1 の owner replacement WAL branch** に従う（通常の 11 段ではない。`task-create` を走らせない） |
| active だが process / authority を確認できない、または `outcome_unknown` | O19 に従い fence して再検査、または `worker-abandon` して `retained`。**旧 capability と新 capability が同時に lifecycle を進めないことを保証する**（fence が先） |
| Orca 側が既に terminal | **送らない。**ローカルを reconcile して終わる |

これは completion の exactly-once journal を復活させる話ではない。
**durable intent を実行できる owner を回復する契約**である。

round 4 finding 5 は「失敗系が completion journal を迂回すると settled 済み Dispatch へ
`recovery-tick.sh` が nudge を送り続ける」と指摘した。**裁定 1 でこの finding は消滅する** —
迂回すべき exactly-once journal がそもそも無くなり、`recovery-tick.sh` は
`worker-show` で Dispatch が settled であることを確認できれば outcome を問わず回復を止める。

ただし**新しい journal を作らないことと、durable intent を持たないことは別である**。
失敗系も `result.md` → **`report-status.sh <role-dir> error <理由>`** → inspection →
送信、の順を通る（10-2 の失敗の出口）。`status.json = error` が
「失敗 outcome を送る意図がある」ことの唯一の durable な記録である。

### 10-2. `completion.json` — ローカル crash 回復のためだけの小さな journal

裁定 1 により、この journal は **exactly-once のためではなく、自分の disk ファイルの
crash 回復のため**だけに存在する。`worker_done_pending` と request identity の記録は撤回した。

```json
{"phase":"prepared|merge_ready_sent|accepted|settled","generation":1,"nonce":"…"}
```

| phase | 書く時点 | 次の副作用 |
|---|---|---|
| `prepared` | 成果を検証可能にした直後（exec は `record-pr.sh` まで） | `merge_ready` を送る |
| `merge_ready_sent` | 送信が 0 で返った直後 | 親の `accepted` を待つ（ターンを閉じる） |
| `accepted` | nonce 一致の `accepted` を受けた直後 | `report-status.sh done` → `worker_done` |
| `settled` | `worker_done` の成立を**確認できた**直後（rc 0、または inspection で Orca が terminal と分かったとき） | Delivery を ack |

**失敗系は `completion.json` を通さない。**ただし手順の正本は 10-2 の「失敗の出口」であり、
`result.md` → **`report-status.sh <role-dir> error <理由>`（durable intent）** →
5-1 の inspection-first 収束規則 → send の順を通る。ここでは繰り返さない。
`recovery-tick.sh` は outcome を問わず、Dispatch が settled になったことを
`worker-show` で確認できれば回復を止める（停止条件の唯一の定義は 10-3）。

### 10-3. crash 境界（すべて at-least-once の再送で閉じる）

| crash の位置 | phase | 回復 |
|---|---|---|
| `prepared` 書き込み前 | 無し | 未完了。worker は作業を続ける |
| `prepared` 直後 | `prepared` | **`merge_ready` を再送してよい。**親の消費は handler 別 key（5-1）で冪等なので重複は害にならない |
| `merge_ready` 送信後 | `merge_ready_sent` | 親が `accepted` を送る。未 ack なので replay される（O23） |
| `accepted` 受領後、`done` 書き込み前 | `accepted` | `accepted` の replay で再実行。`report-status.sh` は冪等 |
| `done` 後、`worker_done` 送信前 | `accepted` | 5-1 の収束規則に従って送る |
| **`worker_done` 成立後、`settled` 書き込み前** | `accepted` | **5-1 の収束規則に入る。**送信前に `dispatch-show` / `worker-show` を見て、既に terminal なら**再送せず** `settled` を書いて ack する。rc 0 を取り直す必要は無い（spec2 finding 3） |
| `settled` 書き込み後、ack 前 | `settled` | `accepted` の replay を nonce 照合で no-op にして ack する |

gate は `completion.json` があれば phase を問わず **allow** する。
#### `recovery-tick.sh` の停止条件（唯一の定義。round 5 finding 2）

8-2 と 10-1 で条件が食い違っていたので、ここに一本化する。他の節はこれを参照する。

| worker の outcome | 回復を止める条件 |
|---|---|
| succeeded | `completion.json.phase == settled`。**または** Orca 側が terminal（`worker-show` が settled）であることを確認し、ローカルを `settled` へ reconcile したとき |
| failed | **Orca 側の terminal state（failed / completed）を確認したとき。**失敗系は `completion.json` を作らないので、disk の phase では判定できない |
| outcome_unknown | **止めない。**O19 の経路へ |

失敗系の `worker_done` の応答喪失・非 0 も、上の「送信側の収束規則」に入る。

### 10-4. review ロールの完了

review ロールも同じ相を通す。親の検証内容は「担当した全ラウンドの
`<point>-round-<N>.md` に `VERDICT:` 行がある」ことである。**例外にしない** —
例外にすると review 成果の受理時点が未定義のまま端末が閉じられ、findings の欠落に
誰も気づかない。

### 10-5. remediation は 2 経路ある（round 5 finding 5）

round 4 版は 1 本の手順に混ぜていた。**active な Dispatch への差し戻しと、settled 後の
やり直しは別物である。**前者で新 Task を作ると、二相コミットが「同じ active Dispatch へ
修正を返せる」ために存在した意味が失われ、direct message には存在しない ready receipt を
待つことになる。

#### 経路 A — active rejection（親が相 4b で不受理にした）

`task_id` と `dispatch_id` は**維持する**。

1. generation transition（5-1）を実行するが、**commit target は
   `{task: 既存のまま, dispatch: 既存のまま, assignment_state: "active", generation: n+1}`**
2. index の既存 mapping の `generation` を更新する（新 mapping は作らない）
3. 既存の active Dispatch へ remediation メッセージを送る
4. **`task-create` / `worker-start` / ready receipt は無い**

#### 経路 B — settled 後のやり直し（違反 `worker_done` 後の修正を含む）

1. generation transition を実行し、commit target は
   `{task: <new>, assignment_state: "starting", generation: n+1}`
2. 12-1 の write-ahead 順序で新 `task_id` を journal → index → workers の順に publish
3. `worker-start --task <remediation> --terminal <handle>`
4. ready receipt で `{dispatch, assignment_state: "active"}` と index の `dispatch_id` を publish

**generation transaction の step 6 を常に `starting` に固定してはならない。**
commit target を 2 経路で持つ。

**どちらの経路でも worktree は検証が通るまで削除しない。**

## 11. Cleanup の decision table（round 1 finding 4）

O13 により **`worker-release` は reused / pre-existing terminal を閉じない。**
S6 の二段構えで作った 4 端末はこの分類に入るので、初版の「release が閉じるので
signal 降格事故が消える」は成立しない。

| Dispatch の状態 | 端末の出自 | 行動 |
|---|---|---|
| active + healthy | — | 待機を続ける。`agentWait` を停止判定に使わない（O14） |
| `failed` / `stopped` | — | `worker-start --retry-of <id>` + 明示 placement（`--terminal` / `--worktree`）で replacement |
| `outcome_unknown` | — | receipt の recovery action に従い `worker-stop` で再検査、または `worker-abandon`（資源が生存し得ることを受け入れる）。**無条件削除はしない**（O19） |
| settled | Orca が作った | `worker-release` |
| settled | reused（本設計の 4 端末） | `worker-release` を先に呼ぶ（`retained` / `no_owned_resource` が返る）。**出力保全を確認したうえで** `worker-show` で dispatch / handle / worktree の identity を再検証し、明示的に `terminal close --terminal <handle>` |
| `stopped` / **`stop_unknown`** + reused + **再利用する** | reused | exact な handle / worktree / agent identity を再検証してから、新しい Dispatch へ明示的に再割当する |
| `stopped` / **`stop_unknown`** + reused + **終了する** | reused | Dispatch が fence 済みであること、対象 terminal の identity、`processAction: "none"` を確認してから明示的に `terminal close`。**O34 で実測したとおり `worker-stop` は external terminal を閉じないので、close は別途必要である** |
| authority / resource が依然不明 | — | `worker-abandon` して `retained` とし、**worktree を削除しない** |
| `failed` / `stopped` で retry しない出口 | — | 明示的に「この試行は終了。replacement を作らない」と記録し、上の 2 行のどちらかで端末を account する |
| `release_pending` / `release_unknown` | — | **`terminal close` で代用しない。** receipt の recovery action に従う |
| ユーザーがデバッグ保持を要求 | — | `worker-retain`。黙って skip しない |

**`worker-stop` の非 0 / unknown 応答で、固定順序のまま `terminal close` へ進んではならない。**
receipt と `worker-show` を再確認してから上の表の行を選ぶ（spec2 finding 5）。
O34 の実測値（`state: stop_unknown` / `processAction: "none"` /
`lastError: "The worker terminal is external; no terminal was closed."`）は
「fence は効いたが端末は生きている」を意味するのであって、失敗ではない。

**全 Dispatch と全 terminal が上記のいずれかで accounted になってから** worktree を除去する。
その後に branch 削除、最後に `.dispatch` の掃き出し（`config.json` は残す）。

`orca-cleanup.sh` は各段階を stderr へ 1 行ずつ出す（途中で SIGTERM されても
どこまで終わったかが一意に決まるようにする。cmux 版 F9 の教訓）。再実行は冪等にする。

## 12. issue ループモード（round 1 finding 8 / round 2 finding 5）

`references/loop-mode.md` を正本とする。

### 12-1. Run 単位の Delivery と routing（round 2 finding 5）

1 バッチ = 1 Run に複数 issue の worktree が同居する。Run mailbox の Delivery batch は
**最大 50 message で issue を横断して混ざり**、ack は batch 全体に対して 1 回しかない。
台帳をタスク単位（`<slug>/`）に置くと、片方の issue が batch 全体を ack して
他方の message を失わせる。

したがって **Delivery 台帳は Run 単位に置く**（9-1 のレイアウト）。これはループ専用の
特別扱いではなく、単一タスクのディスパッチでも同じ構造を使う（issue が 1 つになるだけ）。

親の受信ループ（6-5）は次のように拡張する。

1. consuming `check` → `deliveries/<delivery_id>.json` へ batch 全体を保存
2. batch の各 message を `index.json` で `task_id` / `dispatch_id` → `<slug>` に routing する
3. **その issue の handler を実行**し、`processed.json` に message id を記録する
4. **batch の全 message が処理済みになってから** `--ack` する
5. issue A が成功し issue B の handler が落ちた場合、ack しない。replay で
   `processed.json` により A は再実行されず、B だけがやり直される

#### index.json の write-ahead publish 順序（round 3 finding 3）

速い worker は、親が `dispatch_id` の mapping を書く前に `merge_ready` / `worker_done` /
`escalation` を送れる。したがって **`task_id` の mapping を Task 注入より前に publish** し、
**message は `task_id` だけで routing できる**ようにする。

write-ahead の順序（5-1 の T4a / T4b / T6 / 10-5 すべてに適用する）。
round 3 版は `task-create` → `index` → `journal` の順で、**外部副作用と routing 表更新が
journal より先**だった。それでは「journal を起点に収束する」が成立しない（round 4 finding 3）。
journal を先頭に置き直す。

```
 1. journal: launch_planned
      {slug, role, generation, spec_fingerprint, launch_id}     ★ 副作用の前
      launch_id は呼び出し側生成の UUID（O21 で初回受理を実測済み）
 2. task-create --retry-request <launch_id> --task-title "<slug>/<role>#<generation>"
 3. journal: task_created {task_id}                    ← receipt を確定してから
 4. index.json:  task_id → {slug, role, generation}    ← journal から派生
 5. workers.json: {task, assignment_state:"starting", starting_at}   ← journal から派生
 6. journal: worker_start_pending {start_id}            ★ 副作用の前
      start_id も呼び出し側生成の UUID
 7. worker-start --retry-request <start_id>
 8. journal: worker_started {dispatch_id}
 9. workers.json: {dispatch, assignment_state:"active"}
10. index.json:  dispatch_id → {slug, role, generation}
11. journal: active
```

**launch 系だけは caller 生成 identity を使う**（round 5 finding 3）。裁定 1 が撤回したのは
**completion 層**の重い exactly-once journal であって、launch 層ではない。launch には
`task_id` がまだ存在せず、裁定 1 の根拠（`task_id`+`dispatch_id` が送信前に手元にある）が
成立しないため、O21 の caller 生成 id が唯一の一意解決手段になる。WAL に 2 行足すだけで、
completion 層の機構は復活させない。

**`journal.json` が durable source of truth、`index.json` と `workers.json` は
そこから導出される materialized view である。**round 3 版は index を「authoritative」と
書いたが、journal から再構成できる以上それは誤りだった。index は runtime の routing
authority ではあっても durable な真実ではない。

再開時の収束:

| 落ちた位置 | journal の最終 entry | sweep の判断 |
|---|---|---|
| 1 と 2 の間 | `launch_planned` | `request-show --request <launch_id>` で成否を確定する。`completed` なら receipt から `task_id` を採る。`absent` は「起きなかった証拠ではない」ので `task-list` も照会し、`task-title` の `<slug>/<role>#<generation>` で一意に特定する |
| 2 の応答喪失 | `launch_planned` | 同上。**`spec_fingerprint` は内容一致であって operation identity ではない**ので、これだけでは 0/1/複数を一意に解けない（round 5 finding 3）。`launch_id` と `task-title` の 2 系統で解く |
| 3〜5 の間 | `task_created` | index / workers を journal から再 publish する |
| 6 と 7 の間 | `worker_start_pending` | `request-show --request <start_id>` と `dispatch-show --task` で判定する。**本設計は `--terminal` で既存 handle を使うので「端末が 1 つ余るだけ」という round 4 版の記述は誤りだった**（新しい端末は作られない）。同一 Task / terminal への重複呼び出しの挙動は未実測なので、identity で回避する |
| 7 の応答喪失 | `worker_start_pending` | 同上 |
| 8〜10 の間 | `worker_started` | index / workers を journal から再 publish する |

#### owner replacement の WAL branch（spec2r3 finding 2）

10-2 の「`failed` / `stopped` を証明したら `worker-start --retry-of`」は**同じ Task への
replacement** であって新規 launch ではない。上の 11 段をそのまま適用すると
`task-create` が走って**不要な Task を作る**。専用 branch を定義する。

```
 1. journal: replacement_planned                              ★ 副作用の前
      {task_id, old_dispatch_id, expected_outcome, placement:{terminal, worktree},
       start_id, generation}   ← generation は据え置き（下記）
 2. 旧 Dispatch が lifecycle authority を失ったことを確認する
      worker-show が failed / stopped を証明、または fence（worker-stop / worker-abandon）
      が成立したこと。**fence RPC の結果自体が unknown なら新 Dispatch を作らない**
 3. addressbook から旧 Dispatch を active 宛先として外す
 4. workers.json を replacement の starting として publish する
 5. worker-start --task <same-task> --retry-of <old_dispatch_id> \
      --retry-request <start_id> --terminal <handle> --worktree <wt> --from <parent_handle>
 6. receipt 後: journal → workers → index → addressbook を新 Dispatch へ収束させる
```

各 crash 境界は `start_id` の `request-show` と `dispatch-show` / `worker-show` の
inspection で再開する（12-1 の通常経路と同じ規律）。

**generation を上げない。`status.json` と `completion.json` を archive しない。**
これは成果の review をやり直す経路ではなく、**既に確定した disk intent を別の owner が
実行する経路**である。generation transition を通して intent を archive すると、
新しい worker が読むべき状態（`status.json = done|error` と `completion.json = accepted`）が
current role dir から消えてしまう。intent は current role dir に残したまま owner だけを
差し替える。

**旧新 capability の排他は step 2 の fence が担保する。**fence の成立を確認するまで
step 5 へ進まないので、2 つの Dispatch が同時に lifecycle を進めることはない。

#### routing 不能を tombstone にしない（round 3 finding 3 / round 4 finding 4）

routing に失敗した message を即 `processed.json` へ落としてはならない。起動直後の
正当な `worker_done` を tombstone 化すると、Orca 上では Task が settled なのに
親は Phase B にも cleanup にも進まず、replay も二度と起きない。

段階を踏む。

1. `index.json` を読み直す（親の別処理が publish した直後かもしれない）
2. `task-list` / `dispatch-show` で Orca 側の実体を照会する
3. journal の `launch_planned` / `task_created` / `worker_start_pending` と突き合わせる
4. **一時的な publish race と判定できたら、その batch を ack しない**。次の `check` で
   同じ Delivery が返るので（O23）、そこで再 routing を試みる
5. 真に foreign / malformed と確定した message だけを diagnostic として
   `processed.json` へ落とし、その batch を ack してよい

**routing 不能な lifecycle message が 1 通でもあるあいだは batch を ack しない。**

##### 未 ack が再駆動そのものである（Phase 0 spike で解消）

round 4 finding 4 は「quarantine を再処理する契機が無い」ことを問題にし、
mailbox 非依存の backoff timer を要求した。**Phase 0 の実測でこれは不要になった。**

O22 / O23 のとおり、**cursor を進めるのは ack だけ**である。routing できない message を
含む batch を ack しなければ、`check` は次回も同じ Delivery を返す。したがって
「後で再処理する契機」は**次の `check` そのもの**であり、別の timer も ledger も要らない。

- routing 不能な lifecycle message があれば **ack しない**
- 次の `check`（Monitor の wake、親の起動時 drain、他の message の到着、いずれでも）で
  同じ batch が返るので、そこで index を読み直して再 routing を試みる
- 再試行のたびに index / journal / Orca inspection で解決を試みる
- **真に foreign / malformed と確定した message だけ**を diagnostic として記録し、
  その batch を ack してよい

`<run-dir>/quarantine/` も `next_retry_at` も `retry_count` も置かない。
**未 ack であること自体が retry 状態である。**

親の起動時 drain（6-5）は、この replay を必ず 1 回引くための入口として残す。

### 12-2. issue ごとの durable state

「worktree の有無で進捗が一意に決まる」という初版の主張は**成立しない**
（round 2 finding 5）。worktree の不在は「まだ作っていない」と「cleanup 済み」の
両方を意味する。並行実行を許す以上、完了集合が issue 順の prefix になる保証も無い。

したがって `journal.json` に issue ごとの durable state を持つ。

```
not_started → launching → active → verifying → cleanup_pending → completed
                  ↓          ↓         ↓              ↓
                failed    failed   remediating     retained
```

| state | 意味 |
|---|---|
| `not_started` | Task も worktree も無い |
| `launching` | worktree / 端末 / Task を作っている最中（T1-T4b） |
| `active` | worker が作業中 |
| `verifying` | `merge_ready` を受け、親が検証中（10 節の相 3） |
| `remediating` | 不受理で差し戻した（10-5） |
| `cleanup_pending` | 全ロールが settled。11 節の cleanup が未完 |
| `completed` | cleanup まで完了 |
| `retained` | ユーザー要求または `outcome_unknown` で資源を残した |
| `failed` | 復旧不能。worktree は残す |

**進捗の真実は journal であって worktree の有無ではない。**
再開時は journal を読んで state ごとに続きから始める。

**cleanup だけ**を逐次・順序固定にする。すなわち「ある issue の cleanup を開始する前に、
前件の cleanup 結果を durable に `completed` / `retained` / `failed` のいずれかへ落とす」。
**issue の実行そのものは従来どおり並行である**（12-3 の worktree 群）。cleanup を並行にすると
どこまで終わったかが集合演算になり、再開が難しくなるため、後片付けだけを直列化する。

### 12-3. 対応表

| loop の概念 | Orca | 備考 |
|---|---|---|
| issue 1 件 | worktree 1 つ + Task（ロール分） | Run はバッチ全体で 1 つ |
| バッチ | 同一 Run 内の並行 worktree 群 | 同時実行数は親が決める。Orca はスケジュールしない |
| owner lock（`.dispatch-loop/loop.lock.d`） | 変更なし | |
| timeout sentinel | 親の wake 時 reconciliation | `worker-show` で dispatch 状態を再導出する |
| WIP 保全 | 変更なし | `git stash` ではなく WIP commit |
| label 遷移 | `gh` 経由。変更なし | |
| 失敗時 | 11 節の decision table（`retain` / `abandon`） | worktree は検証が通るまで残す |

## 13. Setup / Reset / Override モード（finding 8）

移植元にある独立モードで、`config-*.sh` をコピーするだけでは入口の解析・質問・
永続化契約が再現されない。次を維持する。

- `--setup` / `--reset [runners|config|all]` / `--override` / `--loop` の**相互排他**。
  複数指定は両方を名指ししてエラー。いずれも Step 1a のタスク解析へ落ちてはならない
- `--setup` / `--reset` は**ディスパッチしない**。worktree / Task / 端末を作らない
- config の書き込みは `config-edit.sh` だけを通す。allowlist は `review_mode` /
  `runner.<role>.{runner,model,effort}` / unset 専用キー
- first-run setup: `runners.json` が無ければ starter registry か custom かを聞く。
  registry は name / command / engine のみ。model / effort は config のロール tuple にだけ書く
- `--override` は in-memory・当該ディスパッチ限り。`config-edit.sh` を呼ばない。
  pending tuple を runner 変更後の engine で再検証し、2 回目も不正ならそのロールの変更を**全体破棄**する
- Orca 固有の追加: `runner` は Orca の `--agent` 相当だが、S6 により argv へ組むので
  registry の `command` がそのまま使える。値域検証は engine 別 effort allowlist を維持する

## 14. F1〜F6 の非再発根拠

| ID | cmux 版での事象 | Orca 版での機構 |
|---|---|---|
| F1 | レビュー依頼がディスクに materialize されず、gate が待機を認識できずに `error` を書いた | `review-request.sh`（改変版。補償ロジックは保存）が書き込みと送信をまとめる。7 節。**加えて** codex reviewer の書き込み権限を `writable_roots`（O20）で実際に与える — cmux 版はここが壊れていた（F7） |
| F2 | push も PR 作成もせずに `done` を書いた | `report-status.sh` の V1 を保存し、`integration.json` を Task 注入より前に publish する（9-2）。完了は二相コミットで、親が PR 実在を検証してからでないと確定しない（10 節） |
| F3 | 3 remote 環境で fork へ push し fork 内 PR を作った | `resolve-integration.sh` が親側で origin を厳格解決し、曖昧なら dispatch を止める。子は remote を選ばない。`record-pr.sh` が指定リポジトリ上の実在を検証する |
| F4 | 委譲済みの design ペインが exec の terminal status を上書きした | **per-role status dir（S7）により共有 `status.json` が存在しない。** D2 で design が委譲もしなくなる。cmux 版の 4 層防御を 1 つの構造が置き換える |
| F5 | `result.md` を書いたと報告しながら実ファイルが無かった | `report-status.sh` の V3（`result_missing`）を保存。**加えて**親が相 2 で `result.md` の実在を検証してからでないと受理しない（10 節） |
| F6 | 配線中に発火した Stop hook が「prewarm.json が無い」を親へ連投した | 防壁は 2 層である。(1) 端末はあるが Task がまだ無い区間は `.wiring` sentinel + gate の「静かに allow」（参照先を `workers.json` へ差し替え）。(2) **Task 注入中の区間は `assignment_state: starting` とその block 判定が主要な防壁**（5-1 / round 2 finding 2）。`.wiring` だけでは注入中の誤判定を閉じられない。加えて T3 の publish が Task 注入より前なので window 自体が短い |
| F7 | codex reviewer が review dir へ書けない | O20 の root cause に基づき `-c sandbox_workspace_write.writable_roots=[...]` を使う（5-4）。`--add-dir` は使わない |

**Orca 化そのものが消す failure mode**:

| 事象 | 消える理由 |
|---|---|
| readiness が確立しないペインへ配送し未読で滞留する | `worker-start` が ready のときだけ exit 0（O4） |
| 競合 watcher が通知を食う（`sharing=`） | 消費者が親 1 つ。Run mailbox は ack まで replay（O11） |
| 90 分タイマーの連続 kill で backstop が消える | タイマーを張らない（6-5） |
| codex 待機者に safety timer が無い | `check --wait` は engine 非依存 |

## 15. Phase 0 — contract spike（実施済み）

親の裁定 2（2026-09-04）で bounded な実測が許可され、2 回に分けて実施した。
結果は 2-1 節へ **O21〜O37** として「確認済みの事実」に移してある。

| ID | 結果 |
|---|---|
| U1 | **解決 = yes（O32）。**supervised worker の端末から他 worker の `dispatch:<id>` へ送れる。受信も確認。**D3 の土台が立った** |
| U2 | **解決 = yes（O29 / O30 / O31）。**`terminal create --command "bash runner.sh"` + `worker-start --terminal` は成立する。ただし端末が**認識されたエージェントを実行していること**が条件で、判定は `agentIdentity`。**検出は実行中プロセスからなので、`exec` しない wrapper（5-5 の形）でも認識される** |
| U3 | **解決（O22 / O23 / O24 / O27）。**cursor を進めるのは ack だけ。`--types` は返る batch を絞らず wake 条件にしか効かない |
| U4 | **解決（O36）。**`workspace-window-closed` でも `worktree create` は動く |
| U6 | **解決（O21）。**caller 生成 id は初回で idempotency key として機能する。**launch 層でのみ採用する**（12-1） |
| U5 | **未測定。非ブロッカー。**`worker_done --report-path` の親側での見え方。O33 のとおり `worker_done` は preamble 由来の capability を要するため、外部からは送れない。`--body` の規約行（`PLAN: <path>`）という fallback が設計済み |

### 測れなかったもの

**`worker_done` の二重送信時の 2 回目の rc**（round 5 finding 1）。O33 のとおり
`worker_done` は `--dispatch-capability` を要求し、実際に dispatch されたペインだけが
送れる。外部から偽装も二重送信もできないため、実エージェントを完走させない限り測れない。

**この設計はその答えに依存しない。**5-1 の「送信側の収束規則」は、2 回目が
exit 0 でも stale 非 0 でも正しく収束する形にしてある（送信前に state inspection を行い、
既に terminal なら送らない）。実装フェーズで実エージェントが完走したときに観測して
fact row へ追加すればよい。

### spike の残留物と後片付け

2 回目の spike は次を作り、**すべて回収した**。

| 作ったもの | 回収方法 | 検証 |
|---|---|---|
| repo 登録（yui-cc-plugins） | `project setup-delete --setup <id>`（O35） | `repo list` が 2 → 1 |
| worktree（orca-spike-tmp） | `worktree rm --force` | `worktree list` が 2 → 1、ディレクトリも消滅 |
| 端末 6 つ | `terminal close`（**`worker-stop` では閉じない。O34**） | `terminal list` が 7 → 1（ユーザーの元の端末のみ） |
| git ブランチ | `worktree rm` が同時に処理 | `git branch -a` に残存なし |
| Task 2 / Dispatch 2 | `worker-stop` で fence | — |

**回収できない残留物は Run `run_aa8c318af020` 1 つだけ**である（`run-delete` が無い）。
mailbox は drain 済み。

**round 5 時点の記述の訂正**: 「`orca repo` に `remove` が無いので repo 登録は
取り消せない」は誤りだった（O35）。`orca repo --help` だけを見て結論を出し、
`project setup-delete` の Notes を確認していなかった。**依存する primitive を
CLI で確認してから設計する**という規律を、私自身が破っていた例である。

## 16. ファイル構成

```
apps/orca-team-dispatch-task/
  .claude-plugin/plugin.json          # 1.0.0
  .codex-plugin/plugin.json
  CLAUDE.md                           # 日本語
  README.md                           # 日本語
  LICENSE
  bin/                                # 新規 7 本 (8-3)
  skills/orca-team-dispatch-task/
    SKILL.md                          # 英語必須
    references/guide-ja.md            # SKILL.md と見出し 1:1
    references/loop-mode.md / -ja.md
    references/setup-mode.md / -ja.md
    references/unattended/*.md
    scripts/                          # byte 一致 7 本 (8-1) + 改変 9 本 (8-2)
                                      #   + plan-approved-hook.sh
  test/
```

ルート `.claude-plugin/marketplace.json` に同 version で登録する。

### 16-1. 正本先行の原則（親の観察 2026-09-04）

**変更は、正本（normative section）そのものが変わって初めて完了とする。**
改訂履歴とテスト表は正本に**従う**ものであって、先行してはならない。

この規則を `apps/orca-team-dispatch-task/CLAUDE.md` の「ドキュメント整合の絶対ルール」に
含める。移植元の同名セクションが 4 ファイルの一致を要求しているのと同じ位置づけである。

**根拠は実測された事故 4 件である。**

| 事故 | 内容 |
|---|---|
| cmux F2 / R3 | `SKILL.md:201` が「PR per task → 子プロンプトに push と `gh pr create` を含める」と**宣言していたが実装が存在しなかった**。2026-09-02 に issue #79 が push も PR 作成もせず `done` を書いた |
| cmux F9 / R13 | `references/loop-mode.md:164-167` が「cleanup が `close-surface` する」と書いていたが、`loop-cleanup.sh` は `leave.sh` しか呼んでいなかった |
| 本設計 spec2 round 2 | preflight の親 handle 確定を「実装した」と改訂履歴とテスト表に書いたが、**5-2 の本文は 4 項目のまま**だった |
| 本設計 spec2 round 3 | adapter の sender 解決を「変更した」と書いたが、**6-2 の本文は「`<from>` を無視する」のまま**だった |

4 件とも**レビュアーが実際に読みに行ったことでしか検出されていない**。宣言と実装の乖離は
それ自体では何も壊さないので、動かして気づくことができない。

**運用ルール**:

1. 変更するときは**正本を先に書き換える**。改訂履歴とテスト表はその後で追随させる
2. 置換編集を行ったら**反映されたことを検証する**。「編集したつもり」を報告しない
3. レビュー依頼で「〜を実装した」と書くときは、**正本の該当箇所を引用できる状態**にする
4. `test-skill-script-refs.sh` と同様に、**正本と実装の乖離を機械的に検出できる箇所は
   テストにする**（例: SKILL.md が参照するスクリプトの実在、`--help` の出力と
   使用例の一致）

**これは文書の綺麗さの話ではない。**cmux 版の F2 は、宣言だけがあって実装が無かったために
成果物（PR）が失われた事故である。

**SKILL.md の章立て**（移植元の 3 ステップ構造を維持する）:

1. Output Language ブロック（規約どおり一字一句）
2. Display Format Conventions（Template A / B / C。Box drawing。移植元と同一）
3. Loop / Setup / Reset / Override Mode の委譲節
4. Step 1: Parse and Prepare（1a 収集 / 1b agent 発見 / 1c brainstorming 選択 /
   1d 統合戦略 / 1e ロール解決 / 1f preflight / 1g override / 1h サマリ）
5. Step 2: Launch（5 節の T0-T4）
6. Step 3: Monitor and Complete（6-5 の受信規律、10 節の二相コミット、
   11 節の cleanup、Template C）
7. Status Protocol Reference（9 節）
8. superpowers Execution Handoff Integration
9. Constraints

## 17. テスト

プレーン bash、`test/` 配下、PASS / FAIL 行を出して失敗数で exit する。
**このマシンは高負荷なのでテストをバックグラウンド実行しない。**前景でバッチに分けて走らせる。

| ファイル | 検査 |
|---|---|
| `test-upstream-sync.sh` | byte 一致 7 本が cmux 版と一致 |
| `test-upstream-drift.sh` | 改変 9 本の上流ハッシュが記録値と一致（ドリフト検出。自動追従しない） |
| `test-completion-gate.sh` | 判定 1-7 を Orca artifact 名で再検証。**F4**（ロール別 dir で他ロールの status を書けない）、**F6**（`.wiring` 中の静かな allow、参照先が `workers.json`）、`assignment_state` の 4 値それぞれの判定（特に `starting` が allow にならないこと）、`completion.json` の 4 phase すべてで allow、**旧 generation の `done` / escalation / wait lease / nudge が archive され新試行を開放・停止・即時 escalation しないこと**（round 3 finding 1） |
| `test-workers-snapshot.sh` | 5-7 スキーマの受理と、cmux 形状 / 未知キー / `dispatch` 型不正の拒否 |
| `test-orca-send.sh` | 4 位置引数、addressbook 解決、未登録 `to` で exit 1、ラベル抽出、`orca` スタブへの argv 検証、**扱うのは 6 ラベルだけで `worker_done` / `merge_ready` には使われないこと**（6-4b）。**`ORCA_TERMINAL_HANDLE` から handle を取って `--from` に渡すこと、handle が無ければ暗黙推定へ落ちず exit 1 になること、sender handle が `workers.json` の当該 role の terminal と一致すること**（spec2r2 finding 2） |
| `test-orca-preflight.sh` | exit 0/1/2 の分離。`orca` 不在 / `status` 非 ok / `run-list` 失敗。**5 番目の項目（親 handle の確定）を含む 5 項目すべて**。handle を確定できないとき dispatch を止めること、`run-create --from <handle>` の応答の `coordinator_handle` が一致しないとき止めること、`parent_handle` が `run.json` に保存され再開時に推定へ戻らないこと、**親の `check` が `--terminal` を使い `--from` を渡さないこと**（O26 / O28 / spec2r2 finding 2） |
| `test-generation-transition.sh` | 5-1 の transaction。**`commit_target` が対象 role の complete post-state であり、step 6 が最新 `workers.json` の他 role を保持して対象 role だけを置換すること**（transition 中の別 role の更新を巻き戻さないこと。非 transition field も失わないこと。spec2r2 finding 5）、**親 sweep が `commit_target` を読み active 経路を `starting` へ誤復旧しないこと**（spec2 finding 4）、`.generation-transition` があるあいだ gate が block し **`recovery-tick.sh` も no-op になること**（freeze）、**移動済み artifact を watcher が再生成したケース**、**dst に内容の異なる既存ファイルがあるケースで削除せず escalation すること**、manifest の各 `mv` 直後の crash から phase 再開できること、`mv` が src のみ / dst のみ / 両方 / 不在の 4 状態で冪等なこと、manifest 全件完了前に新 `status.json` と `generation:n+1` を publish しないこと（round 4 finding 2） |
| `test-replacement-wal.sh` | 12-1 の replacement branch。**`task-create` を走らせないこと**、fence が unknown なら新 Dispatch を作らないこと、旧 Dispatch が addressbook から外れること、**generation を上げず `status.json` / `completion.json` を archive しないこと**（新 worker が intent を読めること）、6 段の各 crash から `start_id` で再開できること（spec2r3 finding 2） |
| `test-intent-owner.sh` | 10-2 の 4 分岐（active + 到達可能 → nudge / `failed`・`stopped` → `--retry-of` で replacement し新 preamble が disk intent を読む / `outcome_unknown` → fence 先行で旧新 capability が同時に進まない / Orca が既に terminal → 送らず reconcile）。**成功系（`accepted` 後に worker 消失）でも同じ分岐が働くこと**（spec2r2 finding 3） |
| `test-starting-sweep.sh` | 5-1 の crash 境界 4 種（`starting` publish 後 / receipt 反映前 / failed 反映前 / 応答喪失）で親の sweep が `dispatch-show` / `worker-show` / `request-show` から state を再導出すること。**`task-create` の応答喪失で `launch_id` と `task-title` の 2 系統から一意に解決すること**。**同じ mutation を新規実行せず `request-show` と `--retry-request <launch_id>` / `<start_id>` を使うこと**。`starting` 滞留で `recovery-tick.sh` が親へ escalation を送ること |
| `test-run-index.sh` | 12-1 の write-ahead 順序 11 段のどこで落ちても journal から収束すること。**`task-create` の応答喪失で Task を重複作成しないこと**（`launch_id` の `request-show` + `task-title` の 2 系統）。`task_id` だけで routing できること |
| `test-routing-retry.sh` | routing 不能な lifecycle message を含む batch を **ack しない**こと、次の `check` で同じ Delivery が返って再 routing されること（O23）、**drain が routing-blocked で pass を終了し tight loop にならないこと**（round 5 finding 6）、`--types` を指定しても batch 全件が返るので全件処理すること（O27）、真に foreign な message だけ diagnostic 記録のうえ ack してよいこと |
| `test-worker-launch.sh` | T1-T4b の順序（**integration.json publish が Task 注入より前**、**review 2 ロールが design より先**）、`assignment_state: starting` が `worker-start` の**前**に disk へ出ること、`--terminal` に `--worktree` を併記、`--model` と `--terminal` を併用しない（O5）、`worker-start` の `failed` / `outcome_unknown` で O19 の分岐に入り**無条件削除しない**、`.wiring` の生成と削除。**`worker-start` スタブが Task 注入直後・receipt 返却前に Stop hook を発火するケース**（round 2 finding 2） |
| `test-recovery-wiring.sh` | role dir と dispatch root が分かれた状態で `recovery-tick.sh` が review wait を認識し、nudge と escalation を送れること（round 2 finding 1）。`--send-command` / `--dispatch-root` を渡さない旧呼び出しでは失敗することも固定する |
| `test-delivery-ack.sh` | crash-before-ack で handler が再実行されない、crash-after-ack、無関係 message が先頭、複数 message batch、emit と ack の順序、**emit/ledger 更新後・foreground check 前の crash で再 emit されること**、emit 直前/直後の crash（round 2 finding 3）、**issue 横断の mixed batch と handler 部分失敗**（round 2 finding 5） |
| `test-lifecycle-argv.sh` | 6-4b の正本。`--dispatch-capability` 欠落で `dispatch_capability_invalid` になること、capability / from / task / dispatch が preamble の一組と一致すること、**寿命は Dispatch 単位**であること（**経路 A では generation を跨いで同じ current Dispatch tuple を使える** / **経路 B では旧 Dispatch tuple を拒否する**。spec2r2 finding 1）、`merge_ready` の payload に `generation` と `nonce` が載ること、adapter が lifecycle に使われないこと（spec2 finding 1） |
| `test-two-phase-commit.sh` | **送信側の収束規則**（`accepted` からの再開で送信前に `dispatch-show` / `worker-show` を見る、既に terminal なら再送しない、非 0 応答でも inspection して収束する）、**handler 別 dedup key の 4 種**、**失敗系が `result.md` → `status.json = error`（durable intent）→ inspection → `worker_done failed` を通ること**。crash 位置で期待値を分ける（spec2r2 finding 4）: **`status.json = error` より前の crash → intent は未確定なので nudge / replacement で作業を再開して intent を確定する** / **error 書き込み後の crash → failed outcome へ収束する**、settled 後に nudge/escalation が止まること、**design も相 1-7 を通ること**、**review ロールも 10-4 の相を通ること**、10-3 の crash 境界 7 行それぞれ（**`worker_done` 成立後・`settled` 前は inspection-first で再送しない** — 既に terminal なら rc 0 を取り直さず `settled` へ進む）、`settled` 後・ack 前の `accepted` replay が nonce 照合で no-op になること、消費の冪等化が `task_id`+`dispatch_id` を key にしていること、10-5 の remediation で role dir が `attempt-<n>/` へ archive され旧 `done` が gate を開けないこと |
| `test-integration-resolve.sh` | 3 remote、origin 不在、GitHub 形式でない origin、PR 不在、`merge` でも必ず書く |
| `test-cleanup.sh` | 11 節の decision table 全行（**`stop_unknown` の実 JSON 形と、close してよい条件**を含む。spec2 finding 5）。**reused terminal は `worker-stop` / `worker-release` では閉じず（O34）明示的な `terminal close` が要ること**、**親が `completion.json = settled` を確認するまで reused terminal を close しないこと**（round 5 finding 1）、`release_pending` で close を代用しない、全 accounted 後にのみ worktree 除去、再実行の冪等性、中断後の再開 |
| `test-runner-wrapper.sh` | agent 終了後に watcher が残らない（`trap` 回収）、gate identity の export、codex に `features.goals=false` |
| `test-loop.sh` | issue → worktree/Task の対応、lock-check、**`journal.json` の state 遷移**、routing 不能 message を捨てないこと、cleanup が逐次で「前件が durable に落ちてから次」になること、中断した cleanup の journal からの再開（round 2 finding 5） |
| `test-modes.sh` | `--setup` / `--reset` / `--override` / `--loop` の相互排他、ディスパッチしないこと、override の whole-role discard、`review_mode=off/on` のロール数 |
| `test-skill-script-refs.sh` | SKILL.md が参照する全スクリプトが実在 |
| `test-doc-lang.sh` | `pnpm check:doc-lang` 相当をプラグイン単体でも検査 |

## 18-1. 段階的な出荷計画（named follow-ups）

本 spec は完成形を記述している。**実装は縦に切り、各段階が「ユーザーが呼べて実際に動く」
状態で終わる**（親の受け入れ基準 2026-09-04）。

> **判定基準**: ある段階が完了したとき、ユーザーが skill を呼んで Orca 上で
> 何かが dispatch され terminal state へ到達するのを見られるか。見られないなら
> その段階は何も出荷していない。**SKILL.md も launch driver も無いプラグインを
> marketplace へ登録するのは、登録しないより悪い** — 存在しない機能を宣伝するからである。
> これは cmux 版が 2 回捕まった defect class と同じである（`SKILL.md:201` が
> 実装の無い PR パイプラインを宣言し、`loop-mode.md` が走らない cleanup を宣言していた）。

### Stage 1 — 最小の実働 dispatch

**範囲**: `review_mode=off` / `integration=merge` / **1 ロール**（`design` のみ）/
loop なし / setup・reset・override なし。

ユーザーが skill を呼ぶと、preflight → Run 作成 → worktree → 端末 1 つ →
Task → Dispatch → worker が作業 → 完了の確定 → 親が受信 → cleanup まで通る。

**marketplace への登録は Stage 1 の最後**に行う。SKILL.md と launch driver が
揃うまで登録しない。

### Stage 2 以降（named follow-ups）

Stage 1 の完了後に、独立した spec の follow-up として順に実装する。
**各 follow-up も「完了時点で動く」単位で切る。**

| # | follow-up | 本 spec の該当節 | 「動く」の定義 |
|---|---|---|---|
| F-a | **Phase B の委譲**（design → 親 → exec の 2 ロール） | 5-1 T5-T9 / 6-4 | design の plan を親が受け取り exec が実装まで進む |
| F-b | **レビュー 2 ロール**（Phase A-R / B-R） | 7 / 6-2 の adapter / `review-request.sh` / `review-gate.sh` | verdict のやり取りが 1 往復通る |
| F-c | **PR 統合** | 9-2 / `resolve-integration.sh` / `record-pr.sh` | PR が origin 上に作られ `pr_url` が記録される |
| F-d | **二相コミットの完全形** | 10 全体 | `merge_ready` → 親の検証 → `accepted` → `worker_done` が通る |
| F-e | **generation transition と owner replacement** | 5-1 の transaction / 10-5 / 12-1 の replacement branch | 不受理からの差し戻しと worker 消失からの回復が通る |
| F-f | **issue ループ** | 12 | issue 1 件が自動で dispatch され cleanup まで通る |
| F-g | **setup / reset / override** | 13 | 各モードが対話で設定を変更できる |

**Stage 1 は F-d の簡易形を含む**: 1 ロールなので親の検証は「`result.md` が実在すること」
だけで足り、`accepted` の往復も 1 回で済む。完全形（nonce / 4 phase / crash 境界 7 行）は
F-d で入れる。**簡易形であることを SKILL.md にも明記し、宣言と実装を乖離させない**（16-1）。

## 18. 本 spec が扱わないもの

- cmux 版の変更。ただし **O20 の root cause は cmux 版 F7 の恒久対応でもある**ので、
  cmux 側へ反映するかは親の判断とする（本 spec の範囲外）
- `--on <saved-environment>` によるリモート worker
- Orca の `gate-create` / `gate-resolve`。5 ラウンド上限到達時は親の対話に残す
- nested worker depth を 2 に上げる運用（D2 が既定の 1 で成立するように設計してある）
- `orca linear` 連携
