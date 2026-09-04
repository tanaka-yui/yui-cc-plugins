# orca-team-dispatch-task — cmux 版ワークフローを Orca ネイティブの上に再構築する

作成: 2026-09-04
改訂: 2026-09-04 (Phase A-R round 1 の findings 1-8 を反映)
状態: **設計。未実装。Phase 0 contract spike が未実施。**
対象: 新規プラグイン `apps/orca-team-dispatch-task`
移植元: `apps/cmux-team-dispatch-task` 3.9.0
実測環境: Orca 1.4.196 (`/Applications/Orca.app/Contents/Resources/bin/orca`)

## 0. 改訂履歴

| rev | 変更 |
|---|---|
| 初版 (627a5b5) | 設計の骨子 |
| 本版 | Phase A-R round 1 の findings 1-8 を反映。**8 節のスクリプト分類を全面的に作り直し**（親の訂正「バイトではなく判断を再利用せよ」を受け、14 本を個別監査した）。**5 節のライフサイクルを 1 本の状態機械へ統一**。**9 節に per-role status dir と二相コミットを導入**。**11 節に terminal cleanup の decision table を追加**。**6-6 に Delivery ack の順序契約を追加**。**15 節に Phase 0 contract spike を新設**。loop / setup / reset / override の節を追加 |

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
| S11 | 「タスク未着」の disk 信号 | `.assigned-*` を廃し、**`workers.json` に当該ロールの `dispatch` キーがあるか**で表す。親が書くファイルなので gate は disk だけで判定できる |

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
| `.assigned-<agent>` | `workers.json` の `dispatch` キーの有無 | S11 |
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
        （この時点では Task も Dispatch も存在しない）
[T3] 親: integration.json / .send-command / addressbook.json(空) / .wiring を publish
        ★ Task 注入より前に必ず完了させる（finding 7）
[T4] 親: task-create ×3 (design / design_review / exec_review)
        worker-start --terminal ×3
        → workers.json に 3 ロールの dispatch を記録、addressbook を更新
        → .wiring 削除
        ※ exec は端末だけ存在し Dispatch を持たない（= gate から「未着」に見える）
[T5] design: Phase A → Phase A-R（design_review と直接 send/check）→ plan 保存
        → roles/design/status.json = done（report-status.sh）
        → worker_done --outcome succeeded --report-path <plan>
[T6] 親: design の worker_done を受理 → worker-release/close（11 節）
        → render-phase-b-spec.sh → task-create → worker-start --task --terminal <exec>
        → workers.json / addressbook を原子的に更新（exec の dispatch を追加）
[T7] exec: Phase B → Phase B-R（exec_review と直接 send/check）→ commit
        → (pr) push → gh pr create → record-pr.sh
        → roles/exec/status.json = done（report-status.sh。V1 が pr_url を要求）
        → merge_ready を親へ
[T8] 親: disk（result.md / result_missing / pr_url）と PR 実在を検証
        受理 → send --to dispatch:<exec> "accepted"
        不受理 → 同じ **active な** Dispatch へ remediation を送る（T7 へ戻る）
[T9] exec: 受理を受けて worker_done --outcome succeeded
[T10] 親: review ロールへ終了を通知 → 各 review ロールが worker_done
[T11] 親: 11 節の cleanup decision table で全 Dispatch / terminal を accounted にする
        → worktree rm → branch → .dispatch 掃き出し
```

**exec が T4 で Dispatch を持たない**ことが D2 の要求（親が Phase B の Task を作る）と
S11（gate の「未着」信号）を同時に満たす。初版の「生涯 1 Dispatch + follow-up メール」は
D2 の Phase B Task を消してしまうため撤回した。

review ロールが T4 で Dispatch を持つのは、Phase A-R が T5 の途中で始まるため、
その時点でアドレス可能でなければならないからである。review ロールの Task は
「このタスクの Phase A-R / B-R を担当する」というレビュー期間全体を覆う 1 つの Task とする。

### 5-2. Preflight（`bin/orca-preflight.sh`）

1. `ORCA_BIN`（既定 O1 のパス）が実行可能か
2. `orca status --json` の `ok` かつ `runtime.reachable`（O2 / O16）
3. `orca orchestration run-list --json` が成功するか（O3。副作用の無い読み取りで実験機能を確かめる）
4. `git rev-parse --show-toplevel` が通るか

exit 0 / 1（`ready=no reason=<slug>` を stdout）/ 2（使用法）。**rc=2 を「Orca が居ない」と報告しない。**

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
| `.dispatch-handoff.json` | `status_dir`（ロール別）/ `review_dir` / `run_id` / `addressbook` / `role` / `send_command` | 常時（ベストエフォート） |

書き込みは同一ディレクトリの `mktemp` + `mv`。権限バイパスの確認は `jq -e` による
ファイル実体判定で行い、確認できなければ `--dangerously-skip-permissions` へフォールバックする。

**codex ロールには O20 の対策を入れる。** `--add-dir` は interactive codex の seatbelt に届かない。
review dir とロール別 status dir は `-c sandbox_workspace_write.writable_roots=[...]`
（single-quoted TOML literal 形式）で渡す。これは cmux 版 `launch-workspace.sh` の
`--add-dir` 経路の置き換えであり、F7 の恒久対応である。

### 5-5. runner wrapper（S5）

`<worktree>/.orca-team-dispatch-task-run-<role>.sh`。

```sh
#!/usr/bin/env bash
export DISPATCH_GATE_ROLE=<role>
export DISPATCH_GATE_AGENT=<slug>[-<role>]
export DISPATCH_GATE_STATUS_DIR=<status-dir>/roles/<role>
export DISPATCH_GATE_TEAM=<run-id>
export DISPATCH_REVIEW_DIR=<status-dir>/review
export DISPATCH_WORKERS_FILE=<status-dir>/workers.json
export AGMSG_SEND=<plugin>/bin/orca-send.sh
export ORCA_ADDRESSBOOK=<status-dir>/addressbook.json

<agent argv> &
AGENT_PID=$!
( while kill -0 "$AGENT_PID" 2>/dev/null; do
    sleep 15
    bash <skill>/scripts/recovery-tick.sh --status-dir "$DISPATCH_GATE_STATUS_DIR" \
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
orca orchestration worker-start --task <task_id> --terminal <handle> --worktree id:<wt> --json
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
  "design":        {"terminal":"term_1","dispatch":"disp_1","task":"task_1","agent":"slug","runner":"claude","engine":"claude","model":"opus[1m]","effort":"xhigh","wired":true},
  "design_review": {"terminal":"term_2","dispatch":"disp_2","task":"task_2","agent":"slug-design-review","runner":"codex","engine":"codex","model":"gpt-5.6-sol","effort":"xhigh","wired":true},
  "exec":          {"terminal":"term_3","task":null,"agent":"slug-exec","runner":"codex","engine":"codex","model":"gpt-5.6-terra","effort":"high","wired":true},
  "exec_review":   {"terminal":"term_4","dispatch":"disp_4","task":"task_4","agent":"slug-exec-review","runner":"claude","engine":"claude","model":"opus[1m]","effort":"xhigh","wired":true}
}
```

**`dispatch` キーの有無が「そのロールにタスクが届いたか」を表す**（S11）。T4 時点の exec は
`dispatch` を持たない。T6 で親が原子的に追加する。

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
2. `<from>` は無視する（Orca が現在の端末から自動解決する）
3. `<to>` を addressbook で解決する。未登録なら exit 1
4. `<body>` 先頭のラベルを切り出して `--subject` に、残りを `--body` に載せる
5. `orca orchestration send --to <addr> --subject <label> --body <rest> --type status --json`
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
| `phase-b-exec:` | 親 → exec | Task spec として注入（6-5） |
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

### 6-5. 親の受信と ack の順序（S4 / finding 3）

**Monitor は ack しない。** ack は「Delivery の全 message を処理したこと」の宣言であり（O11）、
emit は処理ではない。

```
Monitor（背景・wake 信号）:
  loop:
    out = check --wait --peek --types worker_done,escalation,question,merge_ready,status \
            --timeout-ms 600000 --json      # stdout のみ。2>&1 禁止（O10）
    for m in out.messages:
      if m.id not in <status-dir>/.emitted-ledger:
        emit 1 行; ledger へ m.id を追記
親（前景・各 wake で）:
  out = check --json                         # 最古の未 ack batch を消費読み
  <status-dir>/deliveries/<delivery_id>.json へ batch 全体を保存
  for m in out.messages:                     # 目的の label 以外も捨てずに処理する
    if m.id in <status-dir>/processed.json: continue
    handle(m)                                # 冪等。message id / task id / dispatch id で識別
    processed.json へ m.id を追記（原子的置換）
  check --ack <delivery_id> --json           # ★ 全部処理してから
```

- crash-before-ack: 再起動後に同じ batch が replay されるが、`processed.json` により
  handler は再実行されない。ack だけがやり直される
- crash-after-ack: 処理は済んでいる。`deliveries/` に batch が残るので事後検証できる
- **冪等性を要求する handler**: Phase B の Task 作成（task id で識別）/ `reply` /
  `worker-release` / cleanup

worker 側の待機も同じ規律に従う:

```
check --wait --types status --timeout-ms 600000 --json
  → batch 全体を処理（目的外の message も捨てない）
  → 次の待機は check --ack <previous delivery_id> --wait ... で 1 コールにまとめる
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

### 8-2. 改変して持ち込む 9 本

| script | 改変内容 |
|---|---|
| `completion-gate.sh` | `prewarm.json` → `workers.json`（`DISPATCH_WORKERS_FILE`）。「タスク未着」判定を `.assigned-*` から `dispatch` キーの有無へ（C3 / S11）。`.deferred` 分岐を削除（D2）。`DELEGATE_HINT` を削除。最終 reason の完了手順を `report-status.sh` + `merge_ready`（S10）へ。liveness 案内を `worker-show` へ。review dir を `DISPATCH_REVIEW_DIR` から読む。**判定 1-7 の論理と block/allow の非対称性は保存する** |
| `prewarm-snapshot.sh` → `workers-snapshot.sh` | スキーマを 5-7 の形へ。検証の構えは保存 |
| `config-lib.sh` | config home を `orca-team-dispatch-task` へ。`dispatch_valid_workspace_id` / `dispatch_valid_surface_id` を `dispatch_valid_terminal_handle` / `dispatch_valid_dispatch_id` / `dispatch_valid_run_id` へ置換 |
| `report-status.sh` | V2 ガード（`.deferred`）を**削除**する。per-role status dir（S7）により design が他ロールの status を書く経路が構造的に無くなるため、ガードが守るべき不変条件そのものが消える。V1（`pr_url`）と V3（`result_missing`）は保存 |
| `recovery-tick.sh` | disk `done` で回復を止める分岐（C6）を、S10 の二相コミットに合わせて「`done` かつ受理済み」でのみ止めるよう変更する |
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
.dispatch/<slug>/
  workers.json            # 親が書く。ロール → terminal / dispatch / task
  addressbook.json        # 親が書く。active Dispatch だけ
  run.json                # 親が書く。Run id
  .send-command           # 親が書く。orca-send.sh のパス
  .wiring                 # 配線中の sentinel
  deliveries/             # 親: Delivery batch の永続化
  processed.json          # 親: 処理済み message id
  .emitted-ledger         # Monitor: emit 済み message id
  review/                 # タスク単位で共有（7 節）
  roles/
    design/       status.json  result.md  .escalated  .gate-*
    design_review/status.json  ...
    exec/         status.json  result.md  integration.json  ...
    exec_review/  status.json  ...
```

**共有 `status.json` が無くなることで F4 の失敗クラスが構造的に消える。**
cmux 版はこれを `.deferred` + V2 ガード + 「review ロールに `.assigned-*` を作らない」規約 +
「`--mode review` の runner は status を書かない」の 4 層で防いでいた。per-role dir は
その 4 層すべてを 1 つの構造で置き換える。

`report-status.sh` / `record-pr.sh` / `escalate.sh` / `recovery-tick.sh` はすべて
`<status-dir>` 相対なので、ロール別 dir を渡すだけで動く。

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

## 10. 完了の二相コミット（S10 / finding 5）

初版は `report-status.sh done` → `worker_done` の順としていたが、これは split-brain を作る。
`worker_done` の配送に失敗すると disk は `done`、Task/Dispatch は active のまま残り、
gate は停止を許し（判定 1）、`recovery-tick.sh` も `done` を見て回復を止め（C6）、
親は永久に待つ。逆に worker が手順を飛ばして `worker_done` を先に送ると Orca が先に settle し、
親が検証に失敗しても同じ Dispatch へ修正を返せない。

したがって完了を 2 相に分ける。

| 相 | 実行者 | 内容 |
|---|---|---|
| 1. 申告 | worker | `record-pr.sh`（PR 統合時）→ `report-status.sh <role-dir> done <要約>`（V1 が `pr_url` を要求）→ `send --type merge_ready` |
| 2. 検証 | 親 | `result.md` の実在と `result_missing`、`pr_url`、`gh pr view` による PR 実在を確認 |
| 3a. 受理 | 親 → worker | `send --to dispatch:<id> --subject "accepted:"`。**Dispatch はまだ active** |
| 3b. 不受理 | 親 → worker | 同じ active Dispatch へ remediation を送る。worker は修正して相 1 へ戻る |
| 4. 確定 | worker | `worker_done --outcome succeeded`。O9 で Task と Dispatch が completed になる |

`--outcome failed` は相 1 から直接送ってよい（失敗の出口を塞がない）。

相 1 の後・相 4 の前に worker が停止しようとしたとき、gate は **allow** する
（親の受理を待つのは正しい状態であり、worker には何もすることが無い）。
`recovery-tick.sh` の改変（8-2）はこの区間で回復を止めないようにするためのものである。

**worker が相 1 を飛ばして `worker_done` を送った場合**、親は検証に失敗しても
その Dispatch へ修正を返せない（settled）。この場合は同じ端末へ **remediation Task** を
起こす（`worker-start --task <remediation> --terminal <handle>`）。worktree は
検証が通るまで削除しない。

## 11. Cleanup の decision table（finding 4）

O13 により **`worker-release` は reused / pre-existing terminal を閉じない。**
S6 の二段構えで作った 4 端末はこの分類に入るので、初版の「release が閉じるので
signal 降格事故が消える」は成立しない。

| Dispatch の状態 | 端末の出自 | 行動 |
|---|---|---|
| active + healthy | — | 待機を続ける。`agentWait` を停止判定に使わない（O14） |
| `failed` / `stopped` | — | `worker-start --retry-of <id>` + 明示 placement（`--terminal` / `--worktree`）で replacement |
| `outcome_unknown` | — | receipt の recovery action に従い `worker-stop` で再検査、または `worker-abandon`（資源が生存し得ることを受け入れる）。**無条件削除はしない**（O19） |
| settled | Orca が作った | `worker-release` |
| settled | reused（本設計の 4 端末） | `worker-release` を先に呼ぶ（`retained` / `no_owned_resource` が返る想定 = U2）。**出力保全を確認したうえで** `worker-show` で dispatch / handle / worktree の identity を再検証し、明示的に `terminal close --terminal <handle>` |
| `release_pending` / `release_unknown` | — | **`terminal close` で代用しない。** receipt の recovery action に従う |
| ユーザーがデバッグ保持を要求 | — | `worker-retain`。黙って skip しない |

**全 Dispatch と全 terminal が上記のいずれかで accounted になってから** worktree を除去する。
その後に branch 削除、最後に `.dispatch` の掃き出し（`config.json` は残す）。

`orca-cleanup.sh` は各段階を stderr へ 1 行ずつ出す（途中で SIGTERM されても
どこまで終わったかが一意に決まるようにする。cmux 版 F9 の教訓）。再実行は冪等にする。

## 12. issue ループモード（finding 8）

`references/loop-mode.md` を正本とする。`issue-fetch.sh`（改変版）の subcommand と
Orca オブジェクトの対応を定義する。

| loop の概念 | Orca | 備考 |
|---|---|---|
| issue 1 件 | worktree 1 つ + Task 4 つ（ロール分） | Run はバッチ全体で 1 つ |
| バッチ | 同一 Run 内の並行 worktree 群 | 同時実行数は親が決める。Orca はスケジュールしない |
| owner lock（`.dispatch-loop/loop.lock.d`） | 変更なし | Orca は関与しない |
| timeout sentinel | 親の wake 時 reconciliation | `worker-show` で dispatch 状態を再導出する |
| WIP 保全 | 変更なし | `git stash` ではなく WIP commit |
| label 遷移 | `gh` 経由。変更なし | |
| 失敗時 | 11 節の decision table（`retain` / `abandon`） | worktree は検証が通るまで残す |

**cleanup の再開可能性**: `orca-cleanup.sh` は issue ごとに完結させる。
途中で中断しても「N 件は完全に終わり、N+1 件目が未着手」という切れ方になり、
どこまで終わったかが worktree の有無から一意に決まる。

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
| F6 | 配線中に発火した Stop hook が「prewarm.json が無い」を親へ連投した | `.wiring` sentinel を維持し、gate の「静かに allow」分岐を保存する。参照先を `workers.json` へ差し替える（8-2）。**T3 の publish が T4 の Task 注入より前**なので、window そのものが短くなる |
| F7 | codex reviewer が review dir へ書けない | O20 の root cause に基づき `-c sandbox_workspace_write.writable_roots=[...]` を使う（5-4）。`--add-dir` は使わない |

**Orca 化そのものが消す failure mode**:

| 事象 | 消える理由 |
|---|---|
| readiness が確立しないペインへ配送し未読で滞留する | `worker-start` が ready のときだけ exit 0（O4） |
| 競合 watcher が通知を食う（`sharing=`） | 消費者が親 1 つ。Run mailbox は ack まで replay（O11） |
| 90 分タイマーの連続 kill で backstop が消える | タイマーを張らない（6-5） |
| codex 待機者に safety timer が無い | `check --wait` は engine 非依存 |

## 15. Phase 0 — contract spike（finding 6）

round 1 の finding 6 は「U1-U3 を実測してから spec を確定せよ、未検証のままでは approve しない」
とする。**この spike はユーザーの起動中 Orca アプリに可視の状態（Run / Task / terminal）を作る**ため、
親の承認を得てから実行する。承認が得られない場合は、その制約を明記したうえで reviewer と再交渉する。

| ID | 測ること | 外れたときの影響 |
|---|---|---|
| U1 | worker A から worker B の `dispatch:<id>` へ `--type status` を送り、B の `check` で受信・ack できるか | D3（worker 間直接レビュー）の土台。外れると親が中継する設計へ変更（D3 の変更なので親の判断が要る） |
| U2 | `terminal create --command "bash <runner>"` で作った端末を `worker-start --terminal` が supervised にできるか。settle 後の `worker-release` receipt が `retained` / `no_owned_resource` になるか | S6 と 11 節の土台。外れると `worker-start --agent --model --effort` へ切り替えざるを得ず、gate identity（C12）の受け渡し手段を作り直す必要がある |
| U3 | `check --wait --json` の実 schema（`delivery_id` / `messages[]` / message id フィールド名）、`--types` フィルタと「最古の全 batch」の関係、`--peek` の unread cursor と `--ack` の unacked cursor の関係 | 6-5 の Monitor / 親 / worker の 3 ループすべての実装入力 |
| U4 | `graph_not_ready` / `workspace-window-closed`（O2）のままで `worktree create` / `terminal create` が動くか | 局所的。動かなければ preflight に「ワークスペースウィンドウが開いていること」を足し、`orca open` を案内する。**非ブロッカー** |
| U5 | `worker_done --report-path` が親の `check` にどう見えるか | 局所的。見えなければ `--body` の規約行（`PLAN: <path>`）へ退避する。**非ブロッカー** |

U1-U3 は spec 確定のブロッカー、U4 / U5 は非ブロッカーだが U1-U3 と同時に測る。
結果は 2-1 節の O 系へ「確認済みの事実」として移し、該当節を実測値へ書き換える。

spike の後片付け: 作った Run / Task / Dispatch / terminal / worktree は
11 節の decision table に従って回収し、`orchestration reset` は**使わない**
（他のディスパッチの状態を巻き込むため）。

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
| `test-completion-gate.sh` | 判定 1-7 を Orca artifact 名で再検証。**F4**（ロール別 dir で他ロールの status を書けない）、**F6**（`.wiring` 中の静かな allow、参照先が `workers.json`）、`dispatch` キー不在で「未着」allow、相 1 と相 4 のあいだの allow |
| `test-workers-snapshot.sh` | 5-7 スキーマの受理と、cmux 形状 / 未知キー / `dispatch` 型不正の拒否 |
| `test-orca-send.sh` | 4 位置引数、addressbook 解決、未登録 `to` で exit 1、ラベル抽出、`--from` を渡さないこと、`orca` スタブへの argv 検証 |
| `test-orca-preflight.sh` | exit 0/1/2 の分離。`orca` 不在 / `status` 非 ok / `run-list` 失敗 |
| `test-worker-launch.sh` | T1-T4 の順序（**integration.json publish が Task 注入より前**）、`--terminal` に `--worktree` を併記、`--model` と `--terminal` を併用しない（O5）、`worker-start` の `failed` / `outcome_unknown` で O19 の分岐に入り**無条件削除しない**、`.wiring` の生成と削除 |
| `test-delivery-ack.sh` | crash-before-ack で handler が再実行されない、crash-after-ack、無関係 message が先頭、複数 message batch、emit と ack の順序 |
| `test-two-phase-commit.sh` | 相 1 で `merge_ready`、親の不受理で同じ active Dispatch へ remediation、`worker_done` 先行時の remediation Task、`worker_done` 配送失敗で disk が `done` にならない |
| `test-integration-resolve.sh` | 3 remote、origin 不在、GitHub 形式でない origin、PR 不在、`merge` でも必ず書く |
| `test-cleanup.sh` | 11 節の decision table 全行。reused terminal で `worker-release` の後に `terminal close`、`release_pending` で close を代用しない、全 accounted 後にのみ worktree 除去、再実行の冪等性、中断後の再開 |
| `test-runner-wrapper.sh` | agent 終了後に watcher が残らない（`trap` 回収）、gate identity の export、codex に `features.goals=false` |
| `test-loop.sh` | issue → worktree/Task の対応、lock-check、中断した cleanup の再開 |
| `test-modes.sh` | `--setup` / `--reset` / `--override` / `--loop` の相互排他、ディスパッチしないこと、override の whole-role discard、`review_mode=off/on` のロール数 |
| `test-skill-script-refs.sh` | SKILL.md が参照する全スクリプトが実在 |
| `test-doc-lang.sh` | `pnpm check:doc-lang` 相当をプラグイン単体でも検査 |

## 18. 本 spec が扱わないもの

- cmux 版の変更。ただし **O20 の root cause は cmux 版 F7 の恒久対応でもある**ので、
  cmux 側へ反映するかは親の判断とする（本 spec の範囲外）
- `--on <saved-environment>` によるリモート worker
- Orca の `gate-create` / `gate-resolve`。5 ラウンド上限到達時は親の対話に残す
- nested worker depth を 2 に上げる運用（D2 が既定の 1 で成立するように設計してある）
- `orca linear` 連携
