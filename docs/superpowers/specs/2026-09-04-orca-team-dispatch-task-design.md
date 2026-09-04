# orca-team-dispatch-task — cmux 版ワークフローを Orca ネイティブの上に再構築する

作成: 2026-09-04
状態: **設計。未実装。**
対象: 新規プラグイン `apps/orca-team-dispatch-task`
移植元: `apps/cmux-team-dispatch-task` 3.9.0
実測環境: Orca 1.4.196 (`/Applications/Orca.app/Contents/Resources/bin/orca`)

## 1. 解こうとしている問題

`cmux-team-dispatch-task` は「4 ロール（design / design_review / exec / exec_review）が
1 つの worktree を共有し、Phase A → A-R → B → B-R を回して PR まで到達する」という
ドメインを持つ。その価値はドメイン側にあるが、実装の大半は **cmux が提供しない配線を
手で作った層** である — agmsg によるメッセージ配送、`[ready]` 自己申告による readiness、
`status.json` による状態機械、runner wrapper による終了通知、2×2 ペイン配置、
90 分単発タイマー。

Orca はこれらを**ネイティブで持っている**。同じドメインを Orca の上に置き直せば、
手作りの transport / lifecycle 層をまるごと落とせる。本 spec はその設計を確定する。

移植の指針は 1 つ: **ドメインロジックは残し、手作りの transport と lifecycle は捨てる。**
1 対 1 の移植は行わない。

## 2. 確認済みの事実

実測またはコード読解で裏が取れたものだけを挙げる。推測は 14 節に分ける。

### 2-1. Orca 側

| ID | 内容 | 根拠 |
|----|------|------|
| O1 | `orca` は PATH に無い。実体は `/Applications/Orca.app/Contents/Resources/bin/orca`（bash script, 1066 bytes） | `ls -la` 実測 |
| O2 | Orca app は起動中（pid 4128、appVersion 1.4.196）だが `runtime.state = graph_not_ready` / `connectionState = workspace-window-closed` | `orca status --json` 実測 |
| O3 | O2 の状態でも orchestration RPC は通る。`run-list` は成功し、`task-list` は `run_required` を正しく返す | `orca orchestration run-list --json` / `task-list --json` 実測 |
| O4 | `worker-start` は **ready のときだけ exit 0**。failed / outcome_unknown は exit 1 で、JSON に `stage` / `failedStage` / `effects` / `residualResources` / 復旧コマンドが載る | `worker-start --help` の Notes |
| O5 | `worker-start --model` は Claude / Codex / Cursor の opaque provider model id を取る。`--effort` は `--model` を要求する。**両者とも `--terminal` と併用できない** | `worker-start --help` の Notes |
| O6 | `terminal create --command <text>` は任意のコマンド文字列を取る。`worker-start --terminal <handle>` で既存端末を supervised worker にできる | `terminal create --help` の examples、orchestration ガイドの二段構え手順 |
| O7 | `send --to` が取るのは `run:<id>` / `dispatch:<id>` / legacy_handle とグループアドレス（`@all` `@idle` `@claude` `@codex` `@worktree:<id>` ほか） | `send --help` の usage と Notes |
| O8 | `--type` の値域は `status` / `dispatch` / `worker_done` / `merge_ready` / `escalation` / `handoff` / `decision_gate` / `question` / `heartbeat` の 9 種**固定**。任意ラベルを型にできない | `send --help` の Notes |
| O9 | 有効な `worker_done`（active な taskId + dispatchId）は **Task と Dispatch を自動で completed にする**。続けて `task-update --status completed` を呼んではならない | orchestration ガイド Messaging 節 |
| O10 | `check --wait` は一致するメッセージが来るか `--timeout-ms` が切れるまでブロックする。stdout は JSON 1 文書ちょうどで、keepalive 行は **stderr** に出る。`2>&1` で混ぜるとパーサが壊れる | `check --help` / ガイド Messaging 節 |
| O11 | `check` は bound Run の最古の未 ack Delivery（最大 50 通）を返し、`--ack <delivery_id>` まで**同じ batch を replay し続ける** | `check --help` の Notes |
| O12 | dispatch された worker は既定で sub-worker を dispatch できない。`nested_worker_depth_exceeded` で失敗する。深さは Run ではなく**コマンドを発行した端末**から数えるので、worker が `run-create` してもリセットされない | ガイド「How deep workers can nest」 |
| O13 | `worker-release` は settled な Dispatch の端末だけを閉じる。閉じる前に出力を archive するので `worker-read` は後からでも読める。冪等で、`already_released` を返す | `worker-release --help` の Notes |
| O14 | `worker-show --dispatch <id>` の `observation.agentWait` は「人間しか答えられないプロンプトで止まっている worker」を証拠つきで示す。**null は「見たが待っていない」、フィールド不在は「見ていない」** で、不在は「待っていない」を意味しない | `worker-show --help` の Notes |
| O15 | `orchestration dispatch --inject` で作った Dispatch は **unsupervised** で、`worker-stop` / `worker-abandon` はそのプロセスを閉じない。supervision が要るなら `worker-start --terminal <handle>` を使う | ガイド Preferred Supervised Worker Loop 節末尾 |
| O16 | orchestration は Settings > Experimental で有効化が必要。`orca status --json` が running runtime を示すことが前提 | ガイド Preconditions 節 |
| O17 | `skills get orchestration` と `skills get orchestration --full` の出力は**同一**（440 行 / 42500 bytes、diff 空） | 実測 |
| O18 | Orca に workspace 概念は無い。トップレベル単位は worktree で、`--parent-worktree` / `--no-parent` は Orca 上の lineage だけを決め、git の base は `--base-branch` が別に決める | `orca --help` Selectors / ガイド Full Handoffs 節 |

### 2-2. 移植元（cmux 版）側

| ID | 内容 | 根拠 |
|----|------|------|
| C1 | `recovery-tick.sh` は `.send-command` から読んだパスを **実際に実行する**: `bash "$send_command" "$team" "$agent" "$1" "$2"` | `recovery-tick.sh:51-52` |
| C2 | `completion-gate.sh` は `.send-command` の値を **reason の文面に埋めるだけ**で実行しない | `completion-gate.sh:106-109,146-151` |
| C3 | `review-request.sh` は `AGMSG_SEND`（環境変数で上書き可、既定 `~/.agents/skills/agmsg/scripts/send.sh`）を 4 位置引数で実行する | `review-request.sh:25,46,76` |
| C4 | C1 / C2 / C3 の 3 者はすべて **`<send> <team> <from|agent> <to> <body>` の 4 位置引数**という同一の呼び出し規約を使う | 上記 3 箇所 |
| C5 | `completion-gate.sh` の cmux 参照は**コメント 1 行だけ**（「cmux も使わない」という否定の記述）。実行コードに cmux は無い | `grep -nE '\bcmux\b\|CMUX_' completion-gate.sh` |
| C6 | `config-lib.sh` の cmux 参照は config ディレクトリ名 `~/.claude/config/cmux-team-dispatch-task` とコメントのみ | `config-lib.sh:16` ほか |
| C7 | `issue-fetch.sh:69` の `CMUX="${CMUX_BIN:-...}"` は **代入のみで一度も参照されない死んだ変数** | `grep -n CMUX issue-fetch.sh` が 69 行目 1 件のみ |
| C8 | `report-status.sh` / `review-state.sh` / `record-pr.sh` / `escalate.sh` / `config-resolve.sh` / `config-edit.sh` / `override-args.sh` / `prewarm-snapshot.sh` は cmux も agmsg も参照しない | 同 grep が 0 件 |
| C9 | `parallel-directive.sh` の agmsg 参照はコメント 2 行のみ | `parallel-directive.sh:6,8` |
| C10 | 権限バイパスと Stop hook の注入先は **worktree 内のファイル**（claude は `.claude/settings.local.json`、codex は `.codex/hooks.json`）であり、CLI フラグではない | `CLAUDE.md` 項目 25 / 項目 33 |
| C11 | gate の identity（`DISPATCH_GATE_ROLE` ほか）を hook の command 文字列に焼き込むと、同 engine の 2 ロール目が 1 ロール目のゲートを実行する。4 ロールが 1 worktree・1 hook ファイルを共有するため。runner wrapper の **export が唯一の手段** | `CLAUDE.md` 項目 33 / `completion-gate.sh:50-62` |
| C12 | `phase-b-deliver.sh` は **design ペイン（＝ dispatch された worker）が呼ぶ**スクリプトである | `SKILL.md:742` |

## 3. 決定事項

### 3-1. 親から確定済みとして受領した事項（再検討しない）

| # | 内容 |
|---|------|
| D1 | Orca ネイティブの上に構築する。1 対 1 移植はしない。agmsg / status.json 状態機械 / dispatch-notify / ペイン起動配線 / runner・model 選択 / signal ガードは、それぞれ orchestration send・check・reply・ask・inbox / task-* / worker_done / worker-start / `--agent --model --effort` / worker-stop・abandon・release・retain へ置き換える |
| D2 | 親（coordinator）が全 worker を所有する。O12 の深さ制限により、design worker は Phase B を dispatch できない。design は plan パスを載せた `worker_done` を返し、**親が** Phase B の Task を作って exec worker へ dispatch する。`phase-b-deliver.sh` / `.deferred` / `.assigned-*` は消える |
| D3 | レビューは追加の orchestration Task を作らず、**worker 間の直接 `send` / `check`** で行う（意図した簡素化） |
| D4 | 再利用（cmux 非依存）: `completion-gate.sh` `report-status.sh` `review-request.sh` `review-state.sh` `record-pr.sh` `escalate.sh` `recovery-tick.sh` `config-lib.sh` `config-resolve.sh` `config-edit.sh` `override-args.sh` `parallel-directive.sh` `issue-fetch.sh` `prewarm-snapshot.sh` |
| D5 | 維持するドメイン契約: 4 ロール / Phase A・A-R・B・B-R / `<point>-round-<N>.md` + `-request.md` + `-abort.md` と末尾 `VERDICT:` 行 / 5 ラウンド上限 / `integration.json` と PR プロトコル / GitHub issue ループ |
| D6 | 捨てる: `launch-workspace.sh` と `prewarm-panes.sh` の cmux 形態、agmsg 配線全般、`loop-cleanup.sh` の cmux 部分、2×2 レイアウト、workspace close 経路 |

### 3-2. 本 spec で決める事項

| # | 論点 | 決定 | 根拠 |
|---|------|------|------|
| S1 | 再利用 14 本の transport 境界をどう繋ぐか | **`bin/orca-send.sh` を 1 本置き、4 位置引数（C4）を Orca の `orchestration send` へ翻訳する。14 本は 1 文字も変えずにコピーする** | C1-C4。3 者が同一規約なので adapter 1 本で全部が繋がる。個別に書き換えると差分が 3 箇所に散り、上流追従が壊れる |
| S2 | `<to>` にどうやって Orca アドレスを渡すか | **`<status-dir>/addressbook.json`（親が書き、子は読むだけ）でロール名 → `dispatch:<id>` を解決する。adapter がこれを引く** | `review-request.sh:44` が `--to` を `^[A-Za-z0-9._-]+$` で検証するので `dispatch:<id>` を直接渡せない。`.send-command` / `integration.json` と同じ「親が status dir へ置き、子は読む」パターン |
| S3 | ラベル（`review-plan:` 等）を `--type` にするか | **しない。`--type status` 固定 + `--subject` にラベル、`--body` に本文。ただし完了報告だけは `--type worker_done`** | O8 の型は 9 種固定で拡張できない。`check --types` で型フィルタしても粒度が足りないので、識別は subject で行う |
| S4 | 親の受信をどう実装するか | **Monitor tool で「消費する `check --wait` ループ」を回し、1 メッセージ 1 行として emit したうえで ack する** | O10 / O11。`--peek` は ack しないので同じ行を無限に再 emit する。消費側を 1 つに絞れば二重読みが原理的に起きない |
| S5 | runner wrapper を残すか | **残す。ただし極小化する（gate identity の export と `recovery-tick.sh` の watcher だけ。status 書き込みと親通知は全廃）** | C11 により env export は代替不能。status 書き込みと通知は `worker_done` と O9 が担う |
| S6 | worker をどう起動するか | **`terminal create --command "bash <runner>"` → `terminal wait --for tui-idle` → `worker-start --task <id> --terminal <handle>`** の二段構え | O5 により `--terminal` は `--model` / `--effort` と併用不可。だが C10（worktree 内ファイル）と C11（env export）と codex の `-c features.goals=false` のために **custom argv が必須**。model / effort は cmux と同様に自前で argv へ組む |
| S7 | `status.json` を残すか | **残す。ただし役割を分ける — Orca Task = 親から見える状態、`status.json` = worker ローカルで gate が読むディスク上の真実** | D1 は「状態機械を task-* にする」と言うが、gate は設計原理として**ディスクだけ**を読む（`completion-gate.sh:5-8`）。毎ターン走る Stop hook に RPC を入れるのは退行。両者は同じものの二重管理ではなく、層が違う |
| S8 | worktree をどう作るか | **`worker-start --worktree new-top-level --name <slug> --setup run` を design ロールの起動で 1 回だけ使い、残り 3 ロールは `--worktree <その worktree>` を指す** ではなく、**親が `worktree create --no-parent --name <slug> --base-branch <base> --setup run` で先に作り、4 ロールとも `--terminal` 経由で同じ worktree に入る** | S6 が `--terminal` を要求するので、worker-start に worktree 作成を任せられない（作成フラグは `--terminal` と両立しない）。worktree 作成を独立させると rollback 境界も明確になる |
| S9 | 4 ロールの配置 | **同一 worktree に 4 端末。2×2 の等分割は要求しない** | Orca に workspace が無く、`terminal split` はあるが等分割の順序制約（cmux 版の設計上の要点）は Orca のタブモデルでは意味を持たない |

## 4. アーキテクチャ — cmux から Orca への対応

| cmux 版の概念 | Orca 版 | 備考 |
|---|---|---|
| workspace（タスク 1 個 = 1 workspace） | worktree（タスク 1 個 = 1 worktree） | O18。トップレベル単位が変わる |
| surface（ペイン） | terminal handle | |
| 4 ペインの 2×2 固定配置 | 同一 worktree の 4 端末（配置は問わない） | S9 |
| agmsg team | Run | 1 ディスパッチ = 1 Run |
| agmsg agent 名 | `dispatch:<id>` | S2 の addressbook が名前 → アドレスを解決 |
| `[ready] <name>` 自己申告 | `worker-start` の receipt | O4。**readiness が親から観測できる**ので自己申告が不要になる |
| `verify-agmsg-ready.sh` / `verify-roles-ready.sh` / `prune-not-ready.sh` | 廃止 | 上に同じ |
| `prewarm.json` | `<status-dir>/workers.json`（同形式の検証済みスナップショット） | `prewarm-snapshot.sh` の契約を流用。`surface_id` → `terminal_handle` + `dispatch_id` |
| `status.json` の親向け状態 | orchestration Task（`task-list`） | S7 |
| `status.json` のディスク実体 | そのまま残る | S7 |
| `dispatch-notify:` | `--type worker_done --outcome succeeded\|failed` | O9 で Task と Dispatch が自動完了 |
| 90 分単発 safety timer + 再武装カウンタ | `check --wait --timeout-ms` のローリング待機 | 親はターンを閉じずに待てる。タイマー・再武装・「codex 親にタイマーが無い」非対称性がすべて消える |
| runner / model / effort 選択 | `config-resolve.sh` の出力 → runner argv | S6 により `--agent` / `--model` / `--effort` は使わず argv に組む |
| pane close + signal 終了ガード（exit 128+） | `worker-release` | O13。settled 後にしか閉じないので降格事故が原理的に起きない |
| `cmux read-screen` による生存確認 | `worker-show` / `worker-read` | O14。`agentWait` の 3 値（値あり / null / 不在）を区別する |
| `work-signal.sh` による停滞検知 | `work-signal.sh` の改変コピー（画面成分を `worker-read --source terminal` へ差し替え） | 14 節参照。`worker-show` の `agentWait` は**停止判定に使わない**（O14: 待っている worker は healthy） |

## 5. 起動と配線

### 5-1. Preflight（`bin/orca-preflight.sh`）

ペインを 1 つも作る前に fail-fast する。cmux 版の Step 1g（agmsg 必須チェック）に相当する。

1. `ORCA_BIN`（既定 `/Applications/Orca.app/Contents/Resources/bin/orca`）が実行可能か（O1）
2. `orca status --json` の `ok == true` かつ `runtime.reachable == true`（O2 / O16）
3. `orca orchestration run-list --json` が成功するか（O3。orchestration 実験機能の有効性を、副作用の無い読み取りで確かめる）
4. `git rev-parse --show-toplevel` が通るか

exit 0 = 起動可 / 1 = 到達不能（理由を stdout の `ready=no reason=<slug>` で返す）/ 2 = 使用法エラー。
`verify-agmsg-ready.sh` と同じ exit 契約を踏襲する。**rc=2 を「Orca が居ない」と報告しない。**

nested depth（O12）は preflight で検査**しない**。親は root なので depth 1 で足り、
D2 により worker からの dispatch を最初から行わないため。

### 5-2. Run と Task

```
orca orchestration run-create --objective "<dispatch objective>" --json
```

ディスパッチ 1 回につき Run 1 つ。タスクごとではない。Run id を `<status-dir>/run.json` へ記録する。

タスクごとに Phase A の Task を作る:

```
orca orchestration task-create --task-title "<slug> Phase A" --spec "<phase-a task text>" --json
```

Phase B の Task は **Phase A の `worker_done` を受けてから**親が作る（D2）。
`--deps` は使わない — 依存を宣言しても Orca は worker を配置しないので、
親が順序を持つ以上、DAG に載せる利得が無い。

### 5-3. worktree の作成（S8）

```
orca worktree create --repo <selector> --name <slug> --no-parent \
  --base-branch <repo default base> --setup run --json
```

- `--no-parent` は Orca 上の lineage だけを決める。git の base は `--base-branch` で明示する（O18）
- base は「現在のフィーチャブランチ」ではなくリポジトリ既定 base を使う。
  スタック作業をユーザーが明示的に求めたときだけ現在ブランチを base にする
- 返る `id`（`<repo-id>::<path>` の完全形）を以後のすべての `--worktree` に使う。
  bare な repo id では新 worktree を指せない
- ブランチ名は cmux 版と同じ `feat/<slug>` を維持する（`integration.json` の `head` と PR 手順が依存する）

worktree 作成に失敗したらそのタスクは起動しない。作成できた後で必須ロールの起動に失敗したら、
**この呼び出しが作った worktree / ブランチ / 端末 / Dispatch だけ**を rollback する（再利用資源は保持）。
cmux 版 `prewarm-panes.sh` の rollback 契約をそのまま踏襲する。

### 5-4. worktree の準備（`bin/prepare-worktree.sh`）

`launch-workspace.sh` から **cmux に依存しない責務だけ**を取り出した新スクリプト。
端末は 1 つも作らない。C10 のとおり、ここで書くのは worktree 内のファイルである。

| 対象 | 内容 | 条件 |
|---|---|---|
| `.claude/settings.local.json` | `permissions.defaultMode: "bypassPermissions"` をマージ | claude engine の全ロール |
| `.claude/settings.local.json` | PostToolUse hook（matcher `ExitPlanMode`、command `zsh <skill>/scripts/plan-approved-hook.sh`） | claude engine かつ plan モードの design のみ |
| `.claude/settings.local.json` / `.codex/hooks.json` | Stop hook = `completion-gate.sh`。**既存 gate entry を除去してから 1 本足す** | 全ロール（engine 別の宛先） |
| `.git/info/exclude` | `.claude/settings.local.json` / `.claude/plans/` / runner script / `.dispatch-handoff.json` | 常時 |
| `.dispatch-handoff.json` | `status_dir` / `review_dir` / `review_config` / `run_id` / `addressbook` / `role` / `send_command` | 常時（ベストエフォート） |

書き込みは cmux 版と同じく **同一ディレクトリの `mktemp` + `mv`**。共有名の `.tmp` は並列書き込みで壊れる。
権限バイパスの確認は `merge_claude_settings` の戻り値ではなく `jq -e` によるファイル実体判定で行い、
確認できなければ `--dangerously-skip-permissions` へフォールバックする（cmux 版 `CLAUDE.md` 項目 25 をそのまま維持）。

### 5-5. runner wrapper（S5）

`<worktree>/.orca-team-dispatch-task-run-<role>.sh` を各ロール分生成する。
ロール名をファイル名に含めるのは、4 ロールが 1 worktree を共有するため（cmux 版と同じ理由）。

```sh
#!/usr/bin/env bash
export DISPATCH_GATE_ROLE=<role>
export DISPATCH_GATE_AGENT=<slug>[-<role>]
export DISPATCH_GATE_STATUS_DIR=<status-dir>
export DISPATCH_GATE_TEAM=<run-id>          # 再利用スクリプトの team 引数に相当
# recovery-tick を 15 秒間隔で回す watcher（ループはここだけ。判断は tick が持つ）
( while sleep 15; do
    bash <skill>/scripts/recovery-tick.sh --status-dir "$DISPATCH_GATE_STATUS_DIR" \
      --role "$DISPATCH_GATE_ROLE" --agent "$DISPATCH_GATE_AGENT" \
      --team "$DISPATCH_GATE_TEAM" >/dev/null 2>&1
  done ) &
exec <agent argv>
```

cmux 版 wrapper から**削除する**もの:

- `status.json` の `executing` / `done` / `error` 書き込み → Orca Task と `report-status.sh` が持つ
- 親への `dispatch-notify:` 送信（exit 時・watcher 経由の両方） → `worker_done`（O9）
- signal 終了ガード（exit ≥ 128 の分岐） → `worker-release`（O13）が settled 後にしか閉じないので不要
- `cmux wait-for --signal` / `cmux notify`

`exec` にするのは、wrapper 自身が status を書かなくなったので子の終了後に何もする必要が無いからである。
watcher は端末の終了とともに消える。

### 5-6. 端末の作成と supervised worker 化（S6）

ロールごとに:

```
orca terminal create --worktree id:<full-worktree-id> --title <slug>-<role> \
  --command "bash .orca-team-dispatch-task-run-<role>.sh" --json
orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 120000 --json
orca orchestration worker-start --task <task_id> --terminal <handle> \
  --worktree id:<full-worktree-id> --json
```

- `--terminal` で reuse するときは `--worktree` を渡す必要がある（`worker-start --help` の Notes）
- `worker-start` は ready のときだけ exit 0（O4）。非 0 なら `stage` / `effects` / `residualResources`
  を読んで報告する。**自動リトライはしない**
- `dispatch --inject` は使わない。O15 のとおり unsupervised になり、
  `worker-stop` / `worker-release` が効かなくなる

#### 1 ロール = 1 Task = 1 Dispatch（ロールの生涯にわたって）

`worker-start` は `--task` を要求するので、4 ロールとも起動時点で Task が要る。
これを「空の standby Task を作り、後で本番 Task へ差し替える」形にしてはならない。
`worker_done` は Dispatch を settle する（O9）ので、standby を即座に閉じると
`dispatch:<id>` が settled な Dispatch を指すことになり、S2 のアドレスが使えなくなる。

したがって **各ロールは生涯 1 つの Task と 1 つの Dispatch を持つ**。Task の spec はロールの
職務そのものを述べる:

| role | Task spec の内容 | `worker_done` を送る時点 |
|---|---|---|
| `design` | Phase A の設計そのもの（superpowers / plan、Phase A-R の依頼手順を含む） | plan を保存したとき。`--report-path <plan path>` を付ける |
| `design_review` | 「このタスクの Phase A-R を担当する。依頼は `review-plan:` で届く。findings を書いてから `review-verdict:` を返す」 | 最終ラウンドの verdict を返した後、または依頼元が abort したとき |
| `exec` | 「Phase B の実装を担当する。**指示は Phase A 完了後に follow-up メールで届く**。それまで idle で待つ」 | 実装・レビュー・PR まで終えたとき |
| `exec_review` | 「このタスクの Phase B-R を担当する。依頼は `review-code:` で届く」 | design_review と同じ |

Phase B の指示は **exec の既存 Dispatch への follow-up メール**として届く（6-5）。
新しい Task を作って端末を移し替える必要は無い。これによりアドレスが生涯不変になり、
「settled した Dispatch へ送ってしまう」事故が構造的に起きない。

### 5-7. `workers.json`（検証済みスナップショット）

`prewarm.json` の後継。`prewarm-snapshot.sh` の検証契約（1 回だけ読み、文書全体を検証し、
以後はローカル値からだけ抽出する）をそのまま維持する。

```json
{
  "run_id": "run_abc",
  "worktree_id": "<repo-id>::/path/to/.worktrees/slug",
  "review_mode": "on",
  "design":        {"terminal":"term_1","dispatch":"disp_1","task":"task_1","agent":"slug","runner":"claude","engine":"claude","model":"opus[1m]","effort":"xhigh","wired":true},
  "design_review": {"terminal":"term_2","dispatch":"disp_2","task":"task_2","agent":"slug-design-review","runner":"codex","engine":"codex","model":"gpt-5.6-sol","effort":"xhigh","wired":true},
  "exec":          {"terminal":"term_3","dispatch":"disp_3","task":"task_3","agent":"slug-exec","runner":"codex","engine":"codex","model":"gpt-5.6-terra","effort":"high","wired":true},
  "exec_review":   {"terminal":"term_4","dispatch":"disp_4","task":"task_4","agent":"slug-exec-review","runner":"claude","engine":"claude","model":"opus[1m]","effort":"xhigh","wired":true}
}
```

`workspace_id` → `run_id` + `worktree_id`、`surface_id` → `terminal` + `dispatch` + `task` に置き換わる。
ロールキーは固定 4 つのまま。`review_mode=off` は design / exec の 2 キーだけ。

`prewarm-panes.sh` の `.wiring` sentinel はそのまま必要である（F6 の再発防止）。
起動済み端末の Stop hook は `workers.json` の publish より前に発火するため、
`completion-gate.sh` の「`.wiring` があれば静かに allow」分岐を維持する。

## 6. メッセージング

### 6-1. アドレス解決（S1 / S2）

親が `<status-dir>/addressbook.json` を書く:

```json
{
  "run": "run_abc",
  "agents": {
    "slug":                    "dispatch:disp_1",
    "slug-design-review":      "dispatch:disp_2",
    "slug-exec":               "dispatch:disp_3",
    "slug-exec-review":        "dispatch:disp_4",
    "parent":                  "run:run_abc"
  }
}
```

`parent` が Run mailbox を指すのは、`worker_done` / `escalation` / `question` が
既定で owning Run へ流れる（O7 / ガイド Ownership 節）ことに合わせるためである。

### 6-2. adapter（`bin/orca-send.sh`）

```
orca-send.sh <team> <from> <to> <body>
```

cmux 版の agmsg `send.sh` と**同じ 4 位置引数**（C4）を取り、Orca へ翻訳する。
これにより `recovery-tick.sh`（C1、実際に実行する）、`review-request.sh`（C3、実際に実行する）、
`completion-gate.sh`（C2、文面に埋めるだけ）の 3 者が **1 文字も変えずに動く**。

処理:

1. `<team>` は Run id として扱う。addressbook の `run` と一致しなければ usage エラー
2. `<from>` は無視する。Orca は現在の端末から送信者を自動解決する（ガイド Messaging 節: 「他端末になりすます場合を除き `--from` は省略せよ」）
3. `<to>` を addressbook で解決する。未登録なら exit 1（未配送）
4. `<body>` の先頭ラベル（`review-plan: ` / `review-code: ` / `review-verdict: ` /
   `abort-reviewer: ` / `dispatch-notify: ` / `dispatch-nudge: ` / `phase-b-exec: `）を切り出し、
   `--subject` に載せる。残りが `--body`
5. `dispatch-notify:` かつ本文が終端状態を報告している場合を**特別扱いしない**。
   完了報告は worker が `worker_done` を直接送る経路に一本化する（6-4）。
   adapter 経由の `dispatch-notify:` は `--type status` で送る（通知であって lifecycle ではない）
6. `orca orchestration send --to <addr> --subject <label> --body <rest> --type status --json`
7. 非 0 終了は**未配送**。cmux 版と同じ契約を維持する

exit: 0 = 送信成功 / 1 = 送信失敗（未配送）/ 2 = 使用法エラー。

### 6-3. ラベル（S3）

`--type` は 9 種固定（O8）なので、メッセージクラスは **`--subject` のラベル**で表す。
cmux 版の「1 メッセージクラス = 1 label、label はフラグではなく本文の接頭辞」という契約は
「label は `--subject`」に読み替えて維持する。

| label | 送信元 → 送信先 | Orca `--type` |
|---|---|---|
| `phase-a-task:` | — | **廃止。**Phase A の指示は design の Task spec そのものになる（6-5） |
| `phase-b-exec:` | **親** → exec（D2 で design からではなくなった） | `dispatch`。adapter ではなく親が直接 `send --to dispatch:<id>` する（6-5） |
| `review-plan:` | design → design_review | `status` |
| `review-code:` | exec → exec_review | `status` |
| `review-verdict:` | review ロール → 依頼元 | `status` |
| `abort-reviewer:` | 依頼元 → review ロール | `status` |
| `dispatch-notify:` | 子 → 親（進捗・保険なし待機の報告） | `status` |
| `dispatch-nudge:` | 親 → 停滞した子 | `status` |
| 完了報告 | 子 → 親 | `worker_done` |

### 6-4. 完了報告

worker は cmux 版の `dispatch-notify:` の代わりに、自分の端末から 1 回だけ:

```
orca orchestration send --type worker_done \
  --subject "<short status>" --body "<何をして何が残ったか>" \
  --task-id <task_id> --dispatch-id <dispatch_id> \
  --outcome succeeded|failed --files-modified "a,b" --json
```

O9 により Task と Dispatch が自動で completed になる。**`task-update --status completed` を続けて呼ばない。**
失敗は `--outcome failed` で表す。散文にだけ書いてはならない。

`report-status.sh` はこの直前に呼ぶ。順序は cmux 版と同じく
「`record-pr.sh`（PR 統合時）→ `report-status.sh <dir> done <要約>` → `worker_done`」である。
`report-status.sh` の V1 ガード（`integration=pr` なのに `pr_url` が無ければ拒否）が
`worker_done` より前に効くことが重要で、順序を入れ替えると F2 の再発を許す。

### 6-5. Phase A タスクの配送

cmux 版は `[ready]` を待ってから `phase-a-task:` メッセージを送る。
Orca では **Task の spec 自身が指示になる**: `worker-start` が
「preamble + TASK ブロック」を注入し、その時点でペインは ready である（O4）。
したがって `phase-a-task:` の別送は不要で、Phase A の指示は `task-create --spec` に入れる。

Phase B は **exec の既存 Dispatch への follow-up メール**として届ける:

```
orca orchestration send --to dispatch:<exec dispatch id> \
  --subject "phase-b-exec: <slug>" --body "<render-phase-b-spec.sh の出力>" \
  --type dispatch --json
```

ガイドが明示している経路である — 「The follow-up is structured inbox mail, not prompt injection.
The worker's next `orchestration check` receives it」。新しい Task を作って端末を
移し替える経路（`worker-start --task <next> --terminal <handle>`）は**採らない**。
5-6 のとおりアドレスの生涯不変性を優先する。

**この経路が `phase-b-deliver.sh` を置き換える。** cmux 版が helper へ一本化していた理由
（設計ペインが引き継ぎ文を自作すると Phase B-R の配線が丸ごと消える）は Orca でも同じだが、
D2 により組み立てるのは親になったので、リスクの所在が変わる。
**親が Phase B の spec を組む単一情報源として `bin/render-phase-b-spec.sh` を置く**
（reviewer の agent 名 / review dir / round ファイル規約 / PR 手順 / parallel directive を含む）。
親が spec を手書きすることを禁止する契約は cmux 版から引き継ぐ。

### 6-6. 親の受信（S4）

親は Monitor tool で次を回す:

```sh
while :; do
  out=$("$ORCA" orchestration check --wait \
        --types worker_done,escalation,question,status \
        --timeout-ms 600000 --json 2>/dev/null) || continue
  printf '%s' "$out" | jq -c 'select(.result.messages != null) | .result.messages[]?
    | {id, type, subject, body, from}' 2>/dev/null
  did=$(printf '%s' "$out" | jq -r '.result.delivery_id // empty' 2>/dev/null)
  [ -n "$did" ] && "$ORCA" orchestration check --ack "$did" --json >/dev/null 2>&1
done
```

- **stdout だけをパースする。** keepalive は stderr に出るので `2>&1` は禁止（O10）
- `--timeout-ms` は 600000（10 分）。タイムアウトは失敗ではなくチェックポイントである（ガイド Messaging 節）。
  ループが即座に次の `--wait` に入るので、実質は無限待機になる
- ack は emit の**後**に行う（O11 の replay を止めるため）。消費者を Monitor 1 つに絞ることで
  cmux 版の `sharing=`（複数 watcher が同じ read cursor を食い合う）問題が構造的に消える
- **90 分タイマーは張らない。** 親は Monitor の行で起きる。cmux 版の
  「単発タイマー / 3 回まで再武装 / Completion で TaskStop」は全廃する

### 6-7. worker 側の待機

review verdict を待つ側（Phase A-R の design、Phase B-R の exec）は:

```
orca orchestration check --wait --types status --timeout-ms 600000 --json
```

を回し、`subject` が `review-verdict:` で round id を部分一致で含むものを探す。
**どの起床でも先に findings ファイルを読み直す**（失われうるのはメッセージだけ）。
`review-verdict:` が来たのに `VERDICT:` 行が無ければ `needs_work` 扱い。
タイムアウトは verdict ではない。

cmux 版の「claude 待機者だけが単発 safety timer を張れる / codex 待機者には保険が無い」
という非対称性は**消える**。`check --wait` は engine に依らず使えるブロッキング呼び出しなので、
codex 待機者も同じ保険を持つ。「保険の無い待機に入った」という親への報告も不要になる。

ただし Bash tool の timeout 上限（600 秒）を超える `--timeout-ms` を前景で使ってはならない。
待機は 600000 ms を上限としたローリングにする。

## 7. フェーズの流れ

```
親: preflight → run-create → タスクごとに:
      worktree create → prepare-worktree → runner 生成
      → 4 ロール分 (task-create standby → terminal create → wait tui-idle → worker-start)
      → workers.json / addressbook.json / integration.json / .send-command を publish、.wiring 解除
      → design の Phase A Task を worker-start で注入
      → Monitor で check --wait

design worker (Phase A):
      superpowers または plan で設計 → spec / plan を書く
      → Phase A-R: review-request.sh を 1 回呼ぶ（ファイル書き + 送信が原子的）
      → check --wait で verdict を待つ → approve まで最大 5 ラウンド
      → plan を .claude/plans/ へ保存
      → worker_done --outcome succeeded --report-path <plan path>

親 (D2):
      worker_done を受信 → plan パスを取得
      → render-phase-b-spec.sh で Phase B の spec を組む
      → task-create → worker-start --task <id> --terminal <exec handle>

exec worker (Phase B):
      実装 → commit
      → Phase B-R: review-request.sh --point code を 1 回呼ぶ
      → verdict を待つ → 最大 5 ラウンド
      → (integration=pr) git push -u origin <head> → gh pr create → record-pr.sh
      → report-status.sh <dir> done <要約>
      → worker_done --outcome succeeded

親:
      worker_done を受信 → Template C で最終レポート
      → 各 Dispatch に worker-release
      → cleanup（worktree / branch / .dispatch）
```

Phase A-R / B-R の worker 間送信は D3 のとおり Task を作らず `send` / `check` で行う。
depth 制限（O12）は dispatch にかかるのであって send にはかからないので、
worker が worker へ送ること自体は制限に触れない。

## 8. 再利用スクリプトの扱い

### 8-1. 1 文字も変えずにコピーする 14 本（D4）

`skills/orca-team-dispatch-task/scripts/` へ配置する。プラグインは独立にインストールされるため
参照ではなくコピーになる（`cmux-codex-exec` が `work-signal.sh` の同一コピーを持つのと同じ理由）。

同一性は **`test/test-upstream-sync.sh` が cmux 版との byte 一致を検査する**
（`test-work-signal.sh` の WS7 と同じ形）。上流が変わったら赤くなり、追従が必要だと分かる。

例外は `config-lib.sh` の config ディレクトリ名（C6: `~/.claude/config/cmux-team-dispatch-task`）である。
これだけは `orca-team-dispatch-task` へ変える必要があるため、**同一性検査から除外する 1 行として
明示的に allowlist する**。allowlist に載っていない差分が出たら FAIL。

`issue-fetch.sh:69` の死んだ `CMUX` 変数（C7）は**そのまま残す**。消すと byte 一致が崩れ、
上流追従の検査が使えなくなる。害は無い（一度も参照されない）。この判断は
コピー先の同一性検査コメントに記録する。

### 8-2. adapter で繋がる仕組み（S1）

| スクリプト | send の使い方 | Orca での繋ぎ方 |
|---|---|---|
| `recovery-tick.sh` | `.send-command` を**実行**（C1） | `.send-command` に `bin/orca-send.sh` のパスを書く |
| `review-request.sh` | `AGMSG_SEND` を**実行**（C3） | runner wrapper が `export AGMSG_SEND=<bin/orca-send.sh>` |
| `completion-gate.sh` | `.send-command` を**文面に埋める**（C2） | 同上。文面がそのまま正しい呼び出しになる |

`completion-gate.sh:294` の block reason が参照する `verify-agmsg-ready.sh` は Orca 版に存在しない。
これは **`.send-command` と同じ「文面に埋めるだけ」の文字列**なので実行はされないが、
存在しないスクリプトを案内するのは誤りである。ここは 8-1 の allowlist に載せる 2 つ目の差分とし、
`worker-show --dispatch <id>` への案内に置き換える。

### 8-3. 新規スクリプト

| ファイル | 役割 |
|---|---|
| `bin/orca-preflight.sh` | 5-1 |
| `bin/orca-send.sh` | 6-2 の adapter |
| `bin/orca-worker-launch.sh` | 5-3 〜 5-6 を 1 コールにまとめる（`prewarm-panes.sh` の後継）。rollback 境界を持つ |
| `bin/prepare-worktree.sh` | 5-4 |
| `bin/render-phase-b-spec.sh` | 6-5 |
| `bin/orca-cleanup.sh` | `worker-release` → `worktree rm` → branch 削除 → `.dispatch` 掃き出しの順で 1 タスク分を完結させる |
| `scripts/review-gate.sh` | cmux 版の**改変コピー**。`code-review.json` を all-or-nothing で発行する契約は維持し、surface / workspace の検証を terminal / dispatch の検証へ置き換える。byte 一致の対象外 |
| `scripts/work-signal.sh` | cmux 版の**改変コピー**。画面成分の取得を `cmux read-screen` から `worker-read --source terminal` へ置き換える（14 節の制約つき）。byte 一致の対象外 |

## 9. `status.json` と Orca Task の役割分担（S7）

| 情報 | 置き場所 | 読み手 |
|---|---|---|
| タスクが実行中か完了か（親が見る進捗表） | orchestration Task（`task-list --json`） | 親 |
| 完了の中身（要約・PR URL） | `result.md` / `status.json` の `pr_url` | 親（`worker_done` の後に読む） |
| gate が「止まって良いか」を判定する材料 | `status.json` / `.deferred` / review round ファイル / `.wiring` / `.escalated` | `completion-gate.sh`（worker ローカル、ディスクのみ） |
| PR 統合の宛先 | `integration.json`（親が書き、子は読むだけ） | `phase-b` spec / `report-status.sh` / `record-pr.sh` |

`completion-gate.sh` に Orca RPC を入れない理由: gate は Stop のたびに走る。
RPC は失敗・ハング・Run 未 bind で落ちうるうえ、gate の設計原理は「ディスクだけを読む」である
（`completion-gate.sh:5-8`）。ここに network を入れると、Orca 側の一過性障害が
全 worker の停止判定を狂わせる。

D2 により `.deferred` は消える（design が Phase B を委譲しなくなるため）が、
`report-status.sh` の V2 ガード（`DISPATCH_GATE_ROLE=design` かつ `.deferred` があれば `done` を拒否）
は 8-1 の byte 一致のため**コードとしては残る**。`.deferred` が作られないので発火しないだけである。
これは死んだ分岐ではなく、上流追従のための無害な残置であることを spec に記録する。

## 10. 完走ゲートと復旧

`completion-gate.sh` はそのまま使う。判定 1-7 の意味は変わらない。変わるのは 2 点だけ:

1. `.wiring` の生成・削除を `orca-worker-launch.sh` が担う（`prewarm-panes.sh` の代わり）
2. block reason 中の liveness 案内が `worker-show` に変わる（8-2）

`recovery-tick.sh` は runner wrapper の watcher から呼ばれる（5-5）。
これは Orca に「止まった worker を再開させる機構が無い」ため、実在するギャップを埋めている。
`worker-show` の `agentWait`（O14）は「人間しか答えられないプロンプトで止まっている」を教えるが、
**待っている worker は healthy であって failed ではない**とガイドが明言しているので、
これを停止判定に使ってはならない。停滞の判断は従来どおり `recovery-tick.sh` と作業信号が持つ。

codex の goal 継続対策（`-c features.goals=false`）は runner の argv に維持する。
S6 で custom argv を選んだので、この注入は cmux 版と同じ形で残せる。

## 11. 9 件の本番障害（F1〜F6）の非再発根拠

| ID | cmux 版での事象 | Orca 版で再発しない根拠 |
|---|---|---|
| F1 | レビュー依頼がディスクに materialize されず、gate が待機を認識できずに `error` を書いた | `review-request.sh` を byte 一致で再利用する（8-1）。ファイル書き込みと送信が 1 コマンドで原子的なまま。adapter 経由でも「send 失敗なら request ファイルを削除」の契約が保たれる |
| F2 | push も `gh pr create` もせずに `done` を書いた | `report-status.sh` の V1 ガードを byte 一致で再利用（8-1）。`integration.json` は親が書く（5-4 / 9 節）。順序（`record-pr.sh` → `report-status.sh` → `worker_done`）を 6-4 で固定する |
| F3 | 3 remote 環境で fork へ push し fork 内 PR を作った | PR 先は**親が `origin` から解決して `integration.json` へ書く**。子は remote を選ばない。`record-pr.sh` が指定リポジトリ上の PR 実在を検証する |
| F4 | 委譲済みの design ペインが exec の terminal status を上書きした | **D2 により design が委譲しなくなる**ので、そもそも design が exec の status を書く経路が無い。加えて `report-status.sh` の V2 ガードが残置される（9 節） |
| F6 | 配線中に発火した Stop hook が「prewarm.json が無い」を親へ連投した | `.wiring` sentinel を `orca-worker-launch.sh` が維持し、`completion-gate.sh` の「静かに allow」分岐をそのまま使う（5-7 / 10 節） |
| F5 | `result.md` を書いたと報告しながら実ファイルが無かった | `report-status.sh` の V3（`result_missing: true` を記録）を byte 一致で再利用。親は `worker_done` を額面どおり受け取らず、ディスクと PR 実在で裏を取る |

**Orca 化そのものが消す failure mode**（cmux 版で対策を要したが Orca では構造的に起きない）:

| 事象 | 消える理由 |
|---|---|
| readiness が確立しないペインへ配送し、メッセージが未読で滞留する | `worker-start` が ready のときだけ exit 0（O4）。自己申告に頼らない |
| 競合 watcher が `[ready]` / `dispatch-notify:` を食う（`sharing=`） | 消費者が Monitor 1 つ（S4）。Run mailbox は FIFO Delivery で ack まで replay（O11） |
| 最終 cleanup の pane close が完了済みタスクを `error` に降格させる | `worker-release` は settled 後にしか閉じない（O13） |
| 90 分タイマーが連続 kill され backstop が消える（F8） | タイマーを張らない（6-6） |
| codex 待機者に safety timer が無い | `check --wait` は engine 非依存（6-7） |

## 12. ファイル構成

```
apps/orca-team-dispatch-task/
  .claude-plugin/plugin.json
  .codex-plugin/plugin.json
  CLAUDE.md                              # 日本語。プラグイン固有事項のみ
  README.md                              # 日本語
  LICENSE
  bin/
    orca-preflight.sh
    orca-send.sh
    orca-worker-launch.sh
    prepare-worktree.sh
    render-phase-b-spec.sh
    orca-cleanup.sh
  skills/orca-team-dispatch-task/
    SKILL.md                             # 英語必須
    references/guide-ja.md               # 日本語（SKILL.md と見出し 1:1）
    references/loop-mode.md              # 英語
    references/loop-mode-ja.md
    references/setup-mode.md             # 英語
    references/setup-mode-ja.md
    references/unattended/*.md           # 英語
    scripts/                             # byte 一致 14 本 + review-gate.sh / work-signal.sh
                                         #   （改変コピー）+ plan-approved-hook.sh
  test/
    test-upstream-sync.sh                # 8-1 の byte 一致 + allowlist
    test-orca-send.sh
    test-orca-preflight.sh
    test-worker-launch.sh
    test-phase-b-spec.sh
    test-cleanup.sh
    test-skill-script-refs.sh
    test-doc-lang-refs.sh
```

ルート `.claude-plugin/marketplace.json` に同 version で登録する。初版は `1.0.0`。

**丸ごと捨てるもの**（D6）: `launch-workspace.sh` / `prewarm-panes.sh` / `phase-b-deliver.sh` /
`phase-a-review-wait.sh` / `verify-agmsg-ready.sh` / `verify-roles-ready.sh` /
`prune-not-ready.sh` / `resolve-agmsg-type.sh` / `terminal-wait.sh` / `loop-cleanup.sh` の cmux 部分。

**改変して持ち込むもの**（8-3 の表に記載。byte 一致の対象外）: `review-gate.sh` / `work-signal.sh`。

スクリプトは 3 分類に排他的に属する — byte 一致で再利用する 14 本（8-1）、改変コピー 2 本、
新規 6 本。どれにも属さないものは持ち込まない。

## 13. テスト

プレーン bash、`test/` 配下、PASS / FAIL 行を出して失敗数で exit する（既存規約）。

| ファイル | 検査 |
|---|---|
| `test-upstream-sync.sh` | 再利用 14 本が cmux 版と byte 一致。allowlist（`config-lib.sh` の config dir 名、`completion-gate.sh` の liveness 案内）以外の差分は FAIL。allowlist に載っているのに差分が 0 でも FAIL（ラチェット） |
| `test-orca-send.sh` | 4 位置引数の受理 / addressbook 解決 / 未登録 `to` で exit 1 / ラベル抽出 / `orca` スタブへの argv 検証 / `--from` を渡さないこと |
| `test-orca-preflight.sh` | exit 0/1/2 の分離。`orca` 不在・`status` 非 ok・`run-list` 失敗の 3 ケース |
| `test-worker-launch.sh` | 4 ロールの起動順 / `--terminal` 使用時に `--worktree` を渡すこと / `--model` と `--terminal` を併用しないこと（O5）/ `worker-start` 非 0 でロールバックし再利用資源を残すこと / `.wiring` の生成と削除 |
| `test-phase-b-spec.sh` | reviewer 名・review dir・round 規約・PR 手順・parallel directive がすべて spec に入ること。空の parallel directive で囲みごと落ちること |
| `test-cleanup.sh` | `worker-release` → `worktree rm` → branch → `.dispatch` の順。`.dispatch/config.json` が残ること |
| `test-skill-script-refs.sh` | SKILL.md が参照する全スクリプトが実在すること |
| `test-doc-lang-refs.sh` | `pnpm check:doc-lang` の対象で日本語が出ないこと（CI が本体だが、プラグイン単体でも検査する） |

**環境の制約**: このマシンは無関係な並行セッションで高負荷である。
テストは**バックグラウンド実行しない**。前景でバッチに分けて実行し、
各呼び出しがツールのタイムアウト内に返るようにする。

## 14. 未検証の前提とリスク

実装前に検証が必要なもの。ここを外すと設計の一部が成立しない。

| ID | 前提 | なぜ未検証か | 検証手順 | 外れたときの代替 |
|---|---|---|---|---|
| U1 | **worker が別の worker の `dispatch:<id>` へ `send` できる** | ガイドは `--to dispatch:<id>` を「coordinator guidance」と説明しており、worker 発の同アドレス送信を明示的に許可も禁止もしていない（O7） | Run を作り、2 端末を worker 化し、一方から他方の `dispatch:<id>` へ `--type status` を送って `check --peek` で着信を確認する | 親が中継する。design → 親 → design_review の 2 ホップ。D3 の「Task を作らない」は維持できるが、親の受信ループに中継分岐が増える |
| U2 | `worker-start --terminal <handle>` が、`terminal create --command "bash <runner>"` で作った端末を supervised worker にできる | O6 は二段構えの手順を示すが、示されているのは `dispatch --inject` 版であり、`worker-start --terminal` 版の実測例が無い | 1 端末で試し、`worker-show --dispatch <id>` が `supervised` を返すことを確認する | `worker-start --agent claude --model X --effort Y` に切り替え、gate identity を env ではなく **ロールごとに別 worktree** で分離する（コストが高い）か、gate の identity 解決に `.dispatch-handoff.json` の役割を拡張する |
| U3 | `check --wait --json` の出力に `delivery_id` と `messages[]` が 6-6 の想定した形で載る | 実際の Delivery を受け取っていない（Run を作っていないため） | U1 の検証中に同時に確認し、6-6 の jq 式を実測に合わせて確定する | jq 式を実測の形へ直すだけ。設計は変わらない |
| U4 | `orca status` が `graph_not_ready` / `workspace-window-closed`（O2）のままで `worktree create` / `terminal create` が動く | orchestration RPC は通った（O3）が、UI を伴う操作は試していない | Orca のワークスペースウィンドウを開いた状態と閉じた状態の両方で試す | preflight（5-1）の条件に「ワークスペースウィンドウが開いていること」を追加し、閉じていたら `orca open` を案内する |
| U5 | `worker_done` の `--report-path` に plan のパスを載せて親が読める | フィールドは存在する（`send --help`）が、親側でどう見えるかを実測していない | U1 の検証で `check` の返り値に `report_path` が載るか確認する | plan パスを `--body` に規約付きの 1 行（`PLAN: <path>`）として載せる |

`work-signal.sh` の画面成分の扱いも未確定である。cmux 版は
「画面成分を落とすと『90 分ずっと読んで考えていた』セッションを停滞と誤判定する」ため
必須としている。Orca では `cmux read-screen` の代わりに `worker-read --dispatch <id> --limit N` を使うが、
これは cursor を進める副作用があるため、停滞検知のたびに呼ぶと親の読み取り位置が動く。
**`--source terminal` で bounded な端末出力だけを取り、cursor を保存しない読み方**が可能かを
実装時に確認する。不可なら画面成分を落とし、代わりに `worker-show` の `agentWait` を第 4 成分に使う。

## 15. 本 spec が扱わないもの

- cmux 版の変更（本 spec は新規プラグインのみを対象とする）
- 再利用 14 本のロジック改善（byte 一致が上流追従の担保なので、改善は上流で行う）
- `--on <saved-environment>` によるリモート worker（Orca は対応しているが、本 spec の範囲外）
- Orca の `gate-create` / `gate-resolve`（decision gate）の利用。
  cmux 版の「5 ラウンド上限に達したら AskUserQuestion」は親の対話に残す。
  decision gate は無人ループでこそ有用だが、初版では扱わない
- nested worker depth を 2 に上げる運用（D2 が既定の 1 で成立するように設計してある）
- `orca linear` 連携
