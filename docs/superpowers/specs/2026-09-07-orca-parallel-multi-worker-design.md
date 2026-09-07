# orca-team-dispatch-task — 並列 dispatch と多役チームへの拡張（Stage A）

作成: 2026-09-07
状態: **設計。未実装。**
対象: `apps/orca-team-dispatch-task` 1.1.0 → 2.0.0
先行 spec: `docs/superpowers/specs/2026-09-04-orca-team-dispatch-task-design.md`（Stage 1）
移植元: `apps/cmux-team-dispatch-task` 3.9.0
実測環境: Orca 1.4.197 (`/Applications/Orca.app/Contents/Resources/bin/orca`, command schema v1 / 234 commands)

## 0. 改訂履歴

| rev | 変更 |
|---|---|
| 初版 (5ff3333) | Stage A（並列 dispatch 基盤）を決める。Stage B（レビュー協調）/ Stage C（役ごとの agent 設定）/ Stage D は範囲外として節を分けて記録するだけに留める |
| rev2 (25d6e6b) | 自己矛盾を 3 件訂正。`roles` 化に伴い `orca-merge.sh` の identity 読み出し 2 行が追随すること、`test-merge` は fixture だけ直して期待値が変わらないこと、`orca-stub.sh` 自体は汎用実装なので変更不要であることを明記 |
| 本版 | **実機で U1 / U2 を解決し、N20〜N23 を追加。**U1 は (a)（`--agent claude` は権限プロンプトを出さない）。U2 は `result.effects[]` から取る。**9-1 の中核主張（coordinator-owned な端末の release は `released` を返す）を実測で確認した** |

## 1. 解こうとしている問題

`orca-team-dispatch-task` 1.1.0 は **1 タスク・1 役（`design`）・1 worker** しか扱えない。移植元の `cmux-team-dispatch-task` は 1 タスクを 4 役（`design` / `design_review` / `exec` / `exec_review`）のチームで実行し、複数タスクを並列に走らせる。この差を埋める。

ユーザーの要求を確認した結果、**目的はチーム構成と並列実行であって、cmux の 2×2 ペインレイアウトではない**ことが確定した（2026-09-07 のやりとり）。この確認が設計を大きく変える。3 節に詳述する。

Stage A の到達点は次のとおり:

> **N 個のタスクを 1 つの Run 上で並列に dispatch し、増えうる `(task, dispatch)` の集合を取りこぼさず待ち、dispatch ごとに確実に片付ける。**

この時点で役はまだ `design` の 1 つだが、複数 worker の起動・待機・資源会計という最も壊れやすい層が確定するため、単体で実用になる（cmux の review off 相当）。

## 2. 確認済みの事実

`orca agent-context --json`（command schema v1）と `orca skills get orchestration`（Orca 同梱の公式ガイド）から確認した。実機での worker 起動は伴わない机上確認である。実測が要る項目は 11 節に分離した。

### 2-1. Run / Task / Dispatch

- **N1** `A Run is the namespace/inbox, a Task is the work item, and a Dispatch assigns one Task attempt to a terminal.` — **1 つの Run が複数の Task を持てる**。並列化のために Run を分ける必要も、親端末を分ける必要もない
- **N2** `Create the Run and every independent Task first, then start all independent workers before waiting.` — 「全部作ってから全部起動し、それから待つ」が公式の推奨順序
- **N3** `check --wait returns one bounded Delivery, not every future completion. Process every message, acknowledge it, then keep waiting until every expected Dispatch settles.` — 集約待機は公式の想定どおり
- **N4** coordinator の `check` は束縛された Run の最古の FIFO Delivery（最大 50 メッセージ）を返し、`--ack <delivery_id>` まで同じ batch を replay する。**Stage 1 の「ack = batch 全件を処理した宣言」という不変条件は N 並列でもそのまま成立する**
- **N5** `task-create` は `--deps <json_array>` と `--parent <task_id>` を持つ。Task の DAG は Orca 側の機能である（Stage B で使う）
- **N6** Task status は `pending` / `ready` / `dispatched` / `completed` / `failed` / `blocked`。有効な `worker_done` は Task と Dispatch を自動的に completed にする（`task-update` を続けて呼んではならない）

### 2-2. worker の起動と配置

- **N7** `worker-start --task <t> --worktree <selector> --agent <agent> [--model <id>] [--effort <level>]` が正規の supervised 経路。**`current` と既存 worktree は fresh agent terminal を作り、setup を再実行しない**
- **N8** `For parallel work, create one fresh agent terminal per worker in the same required worktree.` — 1 worktree に複数 worker を並べるのが公式の並列手順
- **N9** `--effort` は `--model` を要求し、**どちらも `--terminal` とは併用できない**。`--model` / `--effort` は fresh agent terminal にのみ適用され、receipt の `launch.requested` / `launch.effective` に報告される
- **N10** 既知の TUI agent id には少なくとも `claude` / `codex` / `cursor` がある（`account add --agent claude|codex`、`worktree create --agent codex`、group address `@claude` / `@codex` / `@cursor` / `@opencode` / `@gemini` / `@droid` / `@grok`）。**cmux の `runners.json` が持つ `ccf` のような任意コマンドは `--agent` 経路では使えない**
- **N11** dispatch された worker は **sub-worker を dispatch できない**（`nested_worker_depth_exceeded`。既定の nested worker depth は 1）。深さは Run ではなく**コマンドを発行した端末**から数えるので、worker が `run-create` してから `worker-start` しても回避できない。**役の連鎖は必ず親が駆動する**

### 2-3. 端末の所有権と解放

- **N12** `After processing each accepted worker_done, choose the terminal's next owner before you acknowledge the Delivery.` 次の Task があれば `worker-start --task <next> --terminal <handle>` で**片付け責任ごと新しい Dispatch へ移す**。無ければ `worker-release`
- **N13** `worker-release` は settled な worker の **その Dispatch が所有する端末だけ**を閉じる。閉じる前に inspectable な出力アーカイブを保存するので、閉じた後も `worker-read` は読める。**setup 端末 / 設定タブ / 再利用または既存の端末 / ユーザーが操作を引き取った端末 / identity を証明できないものは決して閉じない**。冪等で、再呼び出しは `already_released` を返す
- **N14** `worker-retain --dispatch <id>` は**プロセスにもファイルにも触らない**。「解放しない」という durable な例外を記録するだけで、後から `worker-release` を呼べば例外が消えて解放される
- **N15** `worker-list [--run <run_id>] [--terminal-state active|reclaimable|retained|release_pending|release_unknown|released]` が **Orca 側の実際の端末状態**を返す。`Terminal state is process accounting and is reported separately from Task status; a completed Task can still own a live terminal.`

### 2-4. 実機で確認した事実（2026-09-07。Orca 1.4.197 / probe worktree で 1 回）

- **N20** `worker-start --task <t> --worktree id:<wt> --agent claude` は **権限プロンプトを出さずにファイルを書いた**。`worker-show` の `observation.agentWait` は `null` のまま、指示したファイルが実際に生成された。**U1 は (a) で確定**であり、`--dangerously-skip-permissions` を自前で渡す必要はない
- **N21** 端末 handle は `result.worker.*` には**無い**。`result.effects[]` の中の `{"kind":"terminal","role":"agent","action":"created","id":"term_…"}` から取る。jq で書けば `.result.effects[] | select(.kind == "terminal" and .role == "agent") | .id`。`worker-list` の `workers[].agentTerminalHandle` も同じ値を返すので、こちらは第 2 の経路として使える
- **N22** **`worker-release` は Orca が作った端末に対して `released` を返した**（Stage 1 の `--terminal` 経路では常に `retained` だった）。2 回目の呼び出しは `already_released`。**9-1 の分類はこの実測に基づく**
- **N23** `worker-retain` の receipt は `{"ok":true,"result":{"dispatchId":…,"state":"retained","reason":"user_requested","processAction":"none","archive":null}}`。`worker-list --run <id> [--terminal-state <s>]` は `{"result":{"workers":[…],"counts":{…}}}` を返し、各要素は `dispatchId` / `taskId` / `agentTerminalHandle` / `terminalState` と `resource.{ownershipState,releaseState,retainedReason,worktreeId}` を持つ。**`[C7]` が読む `.result.workers[].dispatchId` は実在する**
- `launch.requested` / `launch.effective` は `{"agent":"claude","model":null,"effort":null}` の形で receipt に載る（N9 / U5 の検証点）

### 2-5. Stage 1 実装の現状（変更の起点）

- **N16** `bin/orca-start.sh` は `terminal create --command "bash $SD/run-design.sh"` で**自分で端末を作り**、その handle を `worker-start --terminal` に渡している。runner の中身は `exec claude --dangerously-skip-permissions` の決め打ち
- **N17** その結果、`worker-release` は N13 の「再利用または既存の端末は閉じない」に該当して常に `retained` を返す。**現行 SKILL.md Step 3 の「Orca reports it `retained` and does not close it」は `--terminal` 経路の副作用であって、設計された保持ではない**
- **N18** `bin/orca-wait.sh` は `worker_done` を受けたら**無条件に `worker-release` してから ack** する。この順序のままレビューを足すと、指摘が返る前に design のセッションが失われる
- **N19** `bin/orca-merge.sh` は `$SD/received.json` に自分の receipt があるかで取り込みを判断する。receipt がタスクごとに分かれていれば **判断ロジックは無改修で成立する**。ただし identity の読み出しに `.design.task` / `.design.dispatch` を使っているため、`workers.json` の形を変えるならこの 2 行は追随する（6 節）

## 3. 決定事項

### 3-1. ユーザーから確定済みとして受領した事項（2026-09-07）

| # | 決定 |
|---|---|
| D1 | cmux 同等（4 役・レビュー・役ごとのモデル選択）まで到達することを目標とする |
| D2 | **3 段階に分割する**（Stage A / B / C）。まず Stage A の spec を書く |
| D3 | **パネル（2×2 レイアウト）にこだわりはない。**1 dispatch で 4 役の agent が動き、複数 dispatch できれば目的を達する |
| D4 | 複数 dispatch とは **複数タスクの同時実行**である（順番に複数回ではない） |
| D5 | Stage A は **1 タスク = `design` 1 worker**。4 役の事前起動はしない |
| D6 | worker のセッションは**最後まで保持し、片付けのときに一括で閉じる** |
| D7 | **使わなくなったコード・ファイルは同じ commit で消す** |

### 3-2. 本 spec で決める事項

| # | 決定 | 根拠 |
|---|---|---|
| D8 | 端末は Orca に作らせる（`worker-start --agent`）。`terminal create` + runner 生成 + `tui-idle` 待ちは削除する | D3 でレイアウト制御が不要になり、N9 により `--model` / `--effort` が使えるようになる |
| D9 | 全タスクを **1 つの Run** に載せる。親端末は 1 つ | N1 / N4 |
| D10 | `.dispatch/<slug>/` のレイアウトを**変えない**。バッチ台帳は作らない | N19（merge を無改修に保つ）。台帳を作ると「台帳とディスクと Orca の三者が食い違ったとき誰が正か」を決める必要が生じ、Stage A が膨らむ。中断後の正は N15 で取れる |
| D11 | 保持（`worker-retain`）は **`orca-wait.sh` が ack の前に**行う。起動時には行わない | N12 が決定点を `worker_done` 処理直後と定めている。誰も release しない以上、起動時の保持は無意味 |
| D12 | **`worker-release` を呼べるのは Step 6（ユーザー確認後）だけ** | D6。Stage 1 の「解放権限は片付けだけが持つ」性質を維持する |
| D13 | 1 回の dispatch で扱うタスク数の**既定上限は 4**。上限は skill 側（Step 1）の規則であり、`orca-start.sh` にフラグは足さない。5 件以上のときは skill が件数と起動されるセッション数を提示してユーザーの明示的な承認を取る | Stage B で 4 役に増えると最大 16 セッションになる。`AskUserQuestion` の 1 コール最大 4 問という制約とも一致する（9-4）。上限をスクリプトに持たせないのは、判断がユーザーとの対話であって起動処理の責任ではないため |
| D14 | Stage A の agent は `claude` 固定。`--model` / `--effort` は渡さない | 役ごとの設定は Stage C の範囲。Stage A で入れると検証対象が二重になる |

## 4. 段階分け

| Stage | 範囲 | 状態 |
|---|---|---|
| **A** | N タスク並列 dispatch / 集約待機 / dispatch ごとの保持と片付け。役は `design` のみ | **本 spec** |
| B | レビュー協調。`design` → `design_review` → `exec` → `exec_review` の逐次起動、差し戻し、`--deps` と `gate-create`、端末所有権の引き継ぎ | 未着手 |
| C | 役ごとの agent / model / effort 設定。`--agent` 経路（N10 の既知 agent）を既定とし、任意コマンドが要るときの逃げ道を定義する | 未着手 |
| D | （必要なら）PR 連携・ループモードなど cmux の残り機能 | 未定 |

Stage B は N11 により **必ず親が駆動する**。「design が終わったら design が design_review を起動する」は実装不能である。

## 5. アーキテクチャ

**方針は「既存の 1 タスク経路を N 本並べる」。**ファイル配置と既存スクリプトの契約を可能な限り変えない。

| 段階 | Stage 1 (1.1.0) | Stage A |
|---|---|---|
| Step 1 | リクエストを 1 件書く | **N 件書く**（タスクごとに slug と request ファイル） |
| Step 2 | `orca-start.sh` を 1 回 | **N 回呼ぶ。**1 回目が Run を作って `run_id` を印字し、2 回目以降は `--run <id>` で同じ Run に相乗りする |
| Step 3 | `orca-wait.sh --status-dir <d>` | `orca-wait.sh --status-dir <d1> --status-dir <d2> …` の**集約待機** |
| Step 4 | `orca-merge.sh --status-dir <d>` | **成功したタスクごとに 1 回ずつ。**スクリプトは無改修 |
| Step 5 / 6 | `design` 1 役ぶんを判定・確認・実行 | **タスク × 役でループ**し、加えて Orca 側の実状態（N15）と突き合わせる |

Step 1 でタスクが 5 件以上になったときは、skill が件数と起動されるセッション数を提示して明示的な承認を取る（D13）。承認が無ければ 4 件までに絞る。

worktree は**タスクごとに 1 つ**。1 タスク内の 4 役（Stage B）はその worktree を共有する（N8）。

`orca-start.sh` は逐次に N 回呼ぶ。並行呼び出しはしない — worktree 作成と Run 束縛の確認が互いに干渉しうるうえ、失敗時の巻き戻し範囲が曖昧になるため。

## 6. 状態レイアウト

タスクごとに Stage 1 と同じディレクトリを作り、その中の `run.json` が同じ `run_id` を指すだけにする（D10）。

```
<repo>/.dispatch/<slug>/
  run.json              { run_id, parent_handle, repo_root }   ← 全タスクで run_id が同一
  request.md
  workers.json
  received.json         ← このタスク宛の receipt だけを積む
  integration-result.json
  roles/design/{status.json, result.md}
```

`workers.json` だけ 1 箇所変える。Stage 1 の `design: { terminal, task, dispatch }` を `roles` の下へ移し、Stage B で役を足せる形にする:

```json
{
  "run_id": "...",
  "worktree_id": "...",
  "worktree_path": "...",
  "branch": "...",
  "integration_branch": "...",
  "worktree_created_by_this_run": true,
  "worktree_terminals": ["term_..."],
  "roles": {
    "design": { "task": "...", "dispatch": "...", "terminal": "...", "retained": false }
  }
}
```

`retained` は「この dispatch に対して `worker-retain` を実行済みか」。片付けで Orca 側の実状態と突き合わせる材料になる。

この形にする理由:

1. **`orca-merge.sh` の判断ロジックが無改修で通る**（N19）。`received.json` / `integration-result.json` / `roles/design/{status.json,result.md}` の意味も位置も変わらないため、受理条件（status が done / receipt が succeeded / `result.md` が非空 / branch と clean checkout）はそのまま成立する。**追随するのは identity の読み出し 2 行だけ**（`.design.task` → `.roles.design.task`、`.design.dispatch` → `.roles.design.dispatch`）
2. **Step 5 の `[C5]`（status dir が `.dispatch` 直下にあることの証明）もそのまま通る。**バッチ用の中間ディレクトリを挟まないため
3. **1 タスクだけの dispatch は Stage 1 とバイト単位で同じ状態になる。**既存テストの期待値を壊さない

## 7. 起動（`bin/orca-start.sh`）

### 7-1. 変えること

**(a) 端末を自分で作らない（D8）**

```
削除: RUNNER="$SD/run-design.sh" の生成と chmod
削除: terminal create --worktree id:$WT_ID --title "$SLUG-design" --command "bash $RUNNER"
削除: terminal wait --terminal $H --for tui-idle --timeout-ms 120000
変更: worker-start --task $TID --terminal $H --worktree id:$WT_ID --from $PH
   →  worker-start --task $TID --worktree "id:$WT_ID" --agent claude --from $PH
```

端末 handle は receipt から取る。**推測しない。**取得できなければ「資源は残す」と印字して停止する（Stage 1 の `kept` と同じ扱い）。

**(b) 順序が変わる**

`worktree → task-create → worker-start` になり、端末は `worker-start` が作る。したがって「Task 作成前の巻き戻し」(`cleanup_before_task`) の対象から端末が消え、**この呼び出しが作った worktree だけ**になる。

**(c) `--run <run_id>` を追加**

省略時のみ `run-create`（Stage 1 と同じ）。指定時は `run-current` で **自分がその Run に束縛されていること**を確認してから進む。Stage 1 の「Run が自分に束縛されたか確かめる」ガード（O26）は維持する。

**(d) `worker-retain` はここでは呼ばない（D11）**

### 7-2. 変えないこと

slug の fail-closed 検証、`.dispatch/` の `info/exclude` 追加、worktree の再利用判定（**列挙の失敗を「不在」と読まない**）、再利用時の clean 検査、`--repo` を受け付けず親 checkout を exact path selector で指すこと、書き込み失敗時に identity を出して止める `write` / `postwrite` の failpoint 設計 — **すべて Stage 1 のまま**。

## 8. 待機（`bin/orca-wait.sh`）

### 8-1. インターフェース

```bash
orca-wait.sh --status-dir <d1> --status-dir <d2> ... [--max-waits <n>] [--timeout-ms <n>]
```

各ディレクトリから `(slug, task, dispatch, parent_handle, run_id)` を読む。**`parent_handle` と `run_id` が全件一致しなければ使用法エラー（exit 2）。**別 Run のものを混ぜて待つことを禁じる。

### 8-2. drain

期待集合 `EXPECT = { (task_id, dispatch_id) → status_dir }` を作り、batch の各メッセージを次のように扱う:

| メッセージ | 扱い |
|---|---|
| `worker_done` かつ `(task, dispatch)` が `EXPECT` に属する | そのタスクの `received.json` に receipt を積む |
| 未知の型 / 未知の `(task, dispatch)` / lifecycle rejection / 矛盾する outcome / 重複 receipt | **ack しない。**診断を出して exit 1 |

Stage 1 の fail-closed をそのまま集合へ拡大しただけである。「ack = batch 全件を処理した宣言」は変わらない（N4）。

### 8-3. ack の前に所有者を決める（N12 / D11）

batch を全件処理できたら、**ack の前に**、その batch で settle した dispatch すべてに `worker-retain` を実行する。

- retain の receipt が `.ok == true` でなければ **ack しない**（transport 扱い、exit 4）
- 成功したら `workers.json` の `roles.<role>.retained` を `true` にする
- **`worker-release` はここでは一切呼ばない**（D12）

Stage B は同じ位置に「保持したまま次の役を起動する」を足すだけになる。

### 8-4. 終了判定

全 status-dir について「`roles/design/status.json` が終端」かつ「積んだ receipt と結論が一致」なら終了する。

| 条件 | exit |
|---|---|
| 全タスク succeeded | 0 |
| 全タスク終端、**1 件以上** failed | 5 |
| 未終端が残ったまま `--max-waits` 到達 | 3 |
| batch を処理できない | 1 |
| transport 不明 / どれかの worker が不健全 | 4 |
| 使用法エラー | 2 |

exit 5 は「全部失敗」ではない。**どのタスクが成功したかは各 `status.json` と `received.json` にあるので、Step 4 は成功したタスクだけ `orca-merge.sh` を呼ぶ。**

`healthy()` は全 dispatch に対して `worker-show` を回し、1 つでも不健全なら exit 4。`observation.agentWait` が非 null の worker は **healthy** として扱う（人の入力待ちは失敗ではない）。`check --wait` の keepalive が stderr に出るため stdout と混ぜない、という Stage 1 の扱いを維持する。

## 9. 片付け（SKILL.md Step 5 / Step 6）

### 9-1. release state の読み方が変わる

N16 / N17 のとおり、Stage 1 で常に `retained` が返っていたのは `--terminal` 経路の副作用である。新設計では端末が coordinator-owned になるため、正常系は `released` になる。**これは N22 で実測済み**（`--agent` で起こした worker の release が `released`、2 回目が `already_released`）。

| release state | 意味 | 扱い |
|---|---|---|
| `released` | Orca が閉じた | 完了。`terminal close` は**不要**。何も印字しない |
| `retained` | Orca が閉じることを**拒んだ**（ユーザーが操作を引き取った / identity を証明できない / 設定タブ等。N13） | 現行 `[C2]` と同じ証明（handle と worktreeId が記録と一致）を通ったときだけ `terminal close` を提示。証明できなければ**残すと報告** |
| `already_released` | 冪等な再呼び出し | 完了 |
| `release_pending` / `release_unknown` | 未確定 | 現行 `[C1]`。**そこで止める。**worktree も dispatch 記録も触らない |

### 9-2. 新規ブロック `[C7]` — Orca 実状態との突合

**タスクの資源を消す前に、自前の記録ではなく Orca に聞く**（N15）。

```
worker-list --run <run_id> --terminal-state retained --json
```

- **記録に無い保持中 dispatch が出てきたら、その Run の worktree は 1 つも削除しない。**一覧をユーザーに見せて止まる
- 記録どおりなら次へ

`worker-retain` は durable な例外を記録する（N14）ので、スキルが中断されると保持が残る。この突合が「前回の残骸を知らずに踏み潰す」ことを防ぐ。

### 9-3. `[C3]` の条件追加

`[C4]`（`worktree rm` はブランチ削除も試み、証明できないものは残す。`--force` を足さない）は**変更しない**。

worktree 削除の条件に **「そのタスクの全役が `released` か `already_released`、または証明済みで閉じた」**を足す。既存の `MERGED` / `OWNED` / clean / `IDENTITY_OK` / `ACCOUNTED` は据え置き。`ACCOUNTED`（worktree 内の端末集合 ⊆ 記録した集合）は、記録側に全役の端末を入れれば役が増えても成立する。三値（yes / no / unknown）のうち `unknown` は削除を authorise しない、という性質も維持する。

### 9-4. Step 6 の質問の割り方

`AskUserQuestion` は **1 コールあたり最大 4 問・1 問あたり最大 4 選択肢**である。N タスク × 3 アクションを 1 問に詰めると入らない。

- **タスク数 ≤ 4（D13 の既定）→ タスクごとに 1 問。**`header` に slug、選択肢は Step 5 が実際に印字したものだけ（端末の解放 / worktree の削除 / dispatch 記録の削除）、multiSelect。**Step 5 が 1 つも印字しなかったタスクは質問から除く**（そのタスクについては、何を何故残すのかを Step 5 の理由で伝えるだけにする）
- **ユーザーの承認で 4 を超えたとき（D13）→ 1 問に落とす。**選択肢は「全タスクの端末」「全タスクの worktree」「全タスクの dispatch 記録」の 3 つで、いずれも **Step 5 が少なくとも 1 タスクで印字したアクションだけ**を出す。粒度は粗くなるが、質問が破綻するよりよい
- どちらの形でも、**Step 5 が拒否した対象を選択肢に出さない**という `[C6]` の規則は変わらない

実行順は **タスク内では 端末 → worktree → dispatch 記録**（Stage 1 のまま）、**タスク間は slug 昇順**で決定的にする。1 つのコマンドが失敗したらそこで止め、残りには手を付けない — `[C6]` の規則をそのまま維持する。

## 10. テスト戦略

`test/lib/orca-stub.sh`（サブコマンド別スタブ + `.rc` + `calls.log`）と `test/run-all.sh` の枠組みはそのまま使う。

### 10-1. スタブの更新

**`test/lib/orca-stub.sh` 自体は変更しない。**応答はサブコマンド名をキーにしたファイルから読む汎用実装なので、`orchestration worker-retain` / `orchestration worker-list` は fixture を置くだけで応答する（fixture が無ければ既定の `{"ok":true,"result":{}}` が返る）。

変えるのは各テストファイルの fixture である:

- **追加**: `orchestration_worker-start` の receipt に**生成された端末 handle** を載せる。`orchestration_worker-retain` / `orchestration_worker-list` の fixture
- **削除**: `test-start.sh` の `terminal_create` fixture（D7）。`orca-start.sh` が呼ばなくなるので、残すと呼ばれない経路をテストが支えることになる

### 10-2. スイート別

| スイート | 追加する検証 |
|---|---|
| `test-start` | `--run <id>` 指定時に **`run-create` を呼ばない** / 束縛確認に失敗したら停止 / worker-start の receipt から端末 handle が取れなければ「資源は残す」と印字して停止 / 巻き戻し対象が **worktree だけ** / **`calls.log` に `terminal create` が 1 度も現れない** |
| `test-wait` | **主戦場。** 2 タスクの `worker_done` が 1 batch に同居 → 両方の `received.json` へ正しく振り分け・`worker-retain` を 2 回・`ack` は 1 回 / 未知の dispatch が混ざったら **ack も retain もしない** / retain の receipt が ok でなければ ack しない / 1 成功 1 失敗で exit 5 かつ両方の receipt が正しい / `parent_handle` または `run_id` 不一致で exit 2 / **`worker-release` が 1 度も呼ばれない** |
| `test-merge` | **fixture の `workers.json` を `roles` 形に直すだけで、期待値は 1 件も変わらないこと。**受理条件を変えていないことの回帰証明（MG10「merge しても資源を消さない」を含む）。期待値を書き換えたくなったら、それは設計が意図せず壊れた合図である |
| `test-report-status` | 変更なし |
| `test-docs` | `[C7]` を含む規則 ID 集合の一致 / SKILL.md ⇔ `guide-ja.md` の bash ブロックのバイト一致・見出し順序 / **Step 6 の質問分割ルール（≤4 はタスクごと、超過は一括）**が両文書に明記 / **release state の 4 分類**が文書化されている / 制限表の件数一致 |
| `test-e2e` | N=2 の並列シナリオをスタブ上で通す（起動 → 集約待機 → 片方だけ merge → 片付け提示） |

### 10-3. 「消したコードが戻らない」ことの固定（D7）

Stage A で丸ごと消える `.sh` は無いが、`orca-start.sh` 内の runner 生成と `terminal create` 経路は消える。**`calls.log` に現れないこと**をテストで縛る。Stage B / C で不要になるファイルが出たら同じ commit で削除し、`run-all.sh` の `SUITE` からも落とす（`run-all.sh` は「`test/test-*.sh` にあるのに `SUITE` に無い」を検出するので、逆漏れは既に守られている）。

## 11. 未検証事項とリスク

| # | 内容 | 影響 | 扱い |
|---|---|---|---|
| ~~U1~~ | **解決済み（N20）。**`--agent claude` は権限プロンプトを出さない。**(a) を採用する** | — | 実測 1 回。別 agent（`codex` / `cursor`）は Stage C で同じ確認を行う |
| ~~U2~~ | **解決済み（N21）。**端末 handle は `result.effects[]` の `kind=="terminal" and role=="agent"` の `.id` | — | — |
| U3 | 同一 worktree に複数 worker を並べたとき（Stage B）の checkout 競合 | Stage B | Stage A では 1 worktree 1 worker なので発生しない |
| U4 | 保持した端末が死んでいる場合（ユーザーが閉じた / アプリ再起動 / クラッシュ） | Stage B の差し戻しで、文脈が消えた端末へ投げる | Stage B で `worker-show` による生存と identity の確認を必須にする。**失われていたら黙って新しい端末を作らない** |
| U5 | `--model` / `--effort` が実際に効いたかは receipt の `launch.effective` でしか判らない（N9）。接続先 worker server が launch-preference 非対応だと無視される | Stage C | Stage C で `launch.requested` と `launch.effective` の一致を検証する |

## 12. 明示的にやらないこと

- **`terminal split` を使わない。**D3 によりレイアウト要件が消えたため、分割方向の意味・新ペインの handle・worktree 継承といった未検証事項をまとめて回避する
- **バッチ台帳を作らない**（D10）
- **役を事前起動しない**（D5）。cmux が 4 ペインを事前に用意する唯一の理由はレイアウトを後から組み直せないことであり、パネルを捨てた時点でその理由は消えた。N タスク並列では 3N 個の待機セッションが無駄になる
- **`orca-wait.sh` から `worker-release` を呼ばない**（D12）
- **recovery 機構を作らない。**Stage 1 の裁定（先行 spec 18-1）を引き継ぐ。中断後の復旧は N15 による Orca 側の実状態の提示までとし、自動復旧はしない
- **cmux の `runners.json` 抽象を移植しない**（Stage C で N7 / N10 のネイティブ機能を使う。U1 が (b) に倒れた場合のみ再検討する）
