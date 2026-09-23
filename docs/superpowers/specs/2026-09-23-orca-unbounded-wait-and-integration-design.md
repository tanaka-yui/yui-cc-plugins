# orca-team-dispatch-task — 子の待機上限の撤廃と親の停滞監視 / 取り込み方の事前質問

作成: 2026-09-23
状態: **設計。未実装。**
対象: `apps/orca-team-dispatch-task` 3.5.1 → 3.6.0

## 1. 解こうとしている問題

### A. 子が自分の判断で待機をやめる

2026-09-23 の実行で、reviewer が「1 時間待って依頼なし」で終了し、そのタスクのレビューは実施されなかった。
依頼側の design は `brainstorm` でユーザーの回答を待っていただけで、止まってはいなかった。
reviewer には、相手が人を待っていることを知る手段が無く、自分の時計だけで「来ない」と判断した。

子の側には、待ち時間の上限が 3 つある（すべて `bin/orca-start.sh` の指示文と `completion.sh` にある）。

| 役 | 上限 | 場所 |
|---|---|---|
| reviewer | 空振り 6 回（1 時間）で終了する | `orca-start.sh` REVIEW LOOP step 1 |
| 依頼側（design / exec）のレビュー待ち | 1 時間で依頼を送り直し、さらに 1 時間でレビューを飛ばす | `orca-start.sh` REVIEW PROTOCOL step 6 |
| 完了の返事待ち | 24 時間で `expired` を返す | `completion.sh` の `await_deadline` |

**子は、自分が待っている相手の事情を知らない。**だから子に「来ない」を判断させない。
判断に必要な情報（どの役が人を待っているか、タスク全体が動いているか）を持つのは親だけである。

### B. 取り込み方を dispatch の前に尋ねない

取り込み方（merge / PR）は設定の `integration`（既定 merge）で決まり、dispatch の前に尋ねていない。
移植元の `cmux-team-dispatch-task` は Step 1e で毎回尋ねる。

## 2. 決定事項（2026-09-23 のやりとり）

| 論点 | 決定 |
|---|---|
| 子の待機 | 上限を撤廃する。子が自分から待機をやめる経路を残さない |
| 停滞を止めるかの判断 | **ユーザーに尋ねる。**親は自分では止めない |
| 停滞の判定 | **タスク単位の無変化時間。**タスクの全役をまとめて見る |
| 止める範囲 | **役を選んで止める。**reviewer だけ止めたときは依頼側をレビュー無しで進ませる |
| `--issue` での停滞 | **止めずに待ち続け、記録だけ残す** |
| 取り込み方 | Step 1b の同じ `AskUserQuestion` 呼び出しで毎回尋ねる |

## 3. 設計 A-1: 子の待ち方

### 3-1. reviewer（`orca-start.sh` REVIEW LOOP）

- step 1 の「空振り 6 回で step 5 へ」を削除する
- 待機ループを抜けるのは、subject が `abort-reviewer:` の message を受けたときだけ
- 空振りしたら同じターンで待ち直す、という指示は残す

### 3-2. 依頼側のレビュー待ち（`orca-start.sh` REVIEW PROTOCOL）

- step 6（1 時間で再送、さらに 1 時間で skip）を削除する
- 待機を抜けるのは次の 2 つだけ
  - subject が `review-verdict:` の message（今までどおり）
  - subject が `review-skipped:` の message（**新規**。親が reviewer を止めたときに送る）
- `review-skipped:` を受けたら、`result.md` に「reviewer が親によって止められたため、この round はレビューされていない」と書き、レビュー無しで先へ進む。step 7 の `abort-reviewer:` は送らない（reviewer はもう居ない）
- step 5 の「round 2 で打ち切り」は残す（待機の上限ではなく、往復回数の上限なので）
- step 2 の「送れなかったらレビュー無しで進む」も残す（待機ではなく配送の失敗なので）

### 3-3. 完了の返事待ち（`completion.sh`）

- `sent` が書く `await_deadline` と、`await` の `expired` 判定を削除する
- `await` の出力は `accepted` / `remediation <理由>` / `waiting` の 3 つになる
- STATUS PROTOCOL step E から `expired` の項を削除する
- 「non-zero exit なら 1 回試し直し、それでも駄目なら `expired` と同じ扱い」は、「1 回試し直し、それでも駄目なら `result.md` に書いて `report-status.sh error` で止まる」に変える。これは待機の上限ではなく、mailbox を読めないという故障である
- 環境変数 `ORCA_AWAIT_TOTAL_SECONDS` を削除する

### 3-4. 親の `--max-waits`

`orca-wait.sh --max-waits 288`（5 分 × 288 = 24 時間）は残す。意味が変わる。

- 旧: 子の 24 時間と揃えた「待つのをやめる期限」
- 新: 24 時間ごとに exit 3 で状況を報告し、親が呼び直すための区切り

`orca-issue.sh` は exit 3 で issue を失敗にする（`fail_out`）。これは変えない。
子は待ち続けるが、資源は残り、Step 5 / 6 の片付けで閉じられる。

## 4. 設計 A-2: 親の停滞監視

### 4-1. 何を「変化」とみなすか

`orca-wait.sh` は周回ごと（`--timeout-ms` 既定 5 分）に、タスクごとの**最終変化時刻**を求める。
見るのは**子が書くものだけ**である。

- `<status-dir>/roles/<role>/status.json` / `result.md` / `completion.json`
- `<status-dir>/plan.md`
- `<status-dir>/review/*`
- 各役の worktree の `HEAD` の commit 時刻
- 各役の worktree の未 commit の変更ファイル（`git status --porcelain` に出るもの）の更新時刻

**親が書くもの（`wait.json` / `roles/*/.woken` / `received.json` / `questions.json` / `stall.json`）は数えない。**
数えると、親の鼓動だけで常に「変化あり」になり、停滞を検知できない。

時刻の取得は GNU / BSD の `stat` の差を避けるため、既存の書き方（`find -newer` や `date -r` を使わず、
`git log -1 --format=%ct` と、ファイルの更新時刻を返す 1 つのヘルパー）に揃える。
ヘルパーは実装時に GNU と BSD の両方で動く形を 1 箇所に置く。

### 4-2. 人を待っている間は対象外

次のいずれかが成り立つ周回では、その時点を「変化あり」として扱う（時計を戻す）。

- タスクのどれかの役が、`worker-show` の `result.observation.agentWait` を持つ（人の入力待ち。`healthy()` が既に見ている値）
- そのタスクの `orchestration ask` を、この周回で取り次いだ（exit 6 で抜ける直前）か、取り次ぎ済みとして通した（人が答えたあとの呼び直し）

2 つ目は `questions.json` の更新ではなく、**`<status-dir>/human.json` の `last_human_at`** に記録する。
`questions.json` は取り次いだ id の配列で「いつ答えたか」を持たないので、
答えるまでに 3 時間かかると、呼び直した直後に停滞と判定してしまう。
「取り次ぎ済みとして通した」時点は、人が答えた直後なので、ここで時計を戻せばこれを避けられる。
`human.json` は親が書くが、人とのやりとりを表す記録なので、4-1 の除外の例外として数える。

**要実測**: Claude の worker が brainstorm で入力欄の回答を待っている状態を、`agentWait` が拾うかどうか。
拾わない場合、その間も停滞の時計は進み、120 分後にユーザーへ尋ねることになる。
これは「待ち続ける」と答えれば済む劣化であり、誤って止めることは無い（止める判断は人がする）。

今回の事例（design が brainstorm でユーザーの回答を待ち、reviewer が待機していた）は、
design 側の `agentWait` でタスク全体が「変化あり」になり、停滞とみなされない。

### 4-3. しきい値と検知時の動き

- 最終変化時刻から `--stall-after-min`（既定 120）分を超えたタスクを停滞とみなす
- `$SD/stall.json` に `snoozed_at` があれば、`max(最終変化時刻, snoozed_at)` から数える
- `--on-stall ask`（既定）: 停滞タスクが 1 つでもあれば **exit 8** で抜ける。抜ける前に、停滞したタスクごとに 1 行と、その役ごとに 1 行を出す

  ```
  stalled task=<slug> status_dir=<sd> idle_min=<n>
  stalled_role task=<slug> role=<role> phase=<completion の phase か status> terminal=<handle>
  ```

- `--on-stall report`: 抜けない。log に同じ行を出し、`$SD/stall.json` に `{"detected_at": <epoch>, "idle_min": <n>}` を書いて待ち続ける。同じ停滞で毎周 log を出さないよう、`detected_at` がある間は再出力しない
- **ack 済みの batch を処理し終えてから判定する。**drain の途中で抜けて batch を取りこぼさない

### 4-4. 親（SKILL.md Step 3）

exit 表に exit 8 の行を足す。

1. 停滞タスクの各役について `"$ORCA_BIN" terminal read --terminal <handle> --screen --json` で画面を読む
2. 1 回の `AskUserQuestion` で、タスクごとに「待ち続ける」か「止める役」を尋ねる（止める役は複数選択）
3. 答えに応じて実行する
   - 待ち続ける: `bash "$PLUGIN/bin/orca-stop.sh" --status-dir "$SD" --snooze`（`stall.json` に `snoozed_at` を書く）
   - 止める: 役ごとに `bash "$PLUGIN/bin/orca-stop.sh" --status-dir "$SD" --role <role>`
4. 同じ `--status-dir` の組で wait を呼び直す

`--issue`（I3）は `orca-wait.sh` に `--on-stall report` を渡す。無人の間は何も止めない。
人が戻ってきたとき、`stall.json` の `detected_at` を見て、上の 1〜3 を行える。

### 4-5. `bin/orca-stop.sh`（新規）

```
orca-stop.sh --status-dir <sd> --role <role>
orca-stop.sh --status-dir <sd> --snooze
```

止まっている子が協力してくれる前提は置かない。`--role` の処理は次の順で行う。

1. その役に receipt（`received.json` の worker_done）が既にあれば、何もせず 0 で終わる（決着済み）
2. `roles/<role>/stopped.json` に `{"stopped_at": <epoch>, "by": "user"}` を書く。**書けなければ端末を閉じずに失敗する**（記録の無い停止は、`orca-wait.sh` からは worker の消失に見え、exit 4 と recovery に回ってしまう）
3. `workers.json` の `roles.<role>.terminal` を `"$ORCA_BIN" terminal close` で閉じる。閉じられなくても 2 の記録は残し、その旨を出して非 0 で終わる
4. 止めた役が `design_review` なら `design` へ、`exec_review` なら `exec` へ、`orca-send.sh` で `review-skipped: stopped by the user` を送る（`orca-send.sh` は `orca-wake.sh` で起こす）。送れなかったことは出力するが、1〜3 は覆さない

`--snooze` は `stall.json` に `snoozed_at` を書き、`detected_at` を消す。
**`--role` も 2 のあとに同じことをする。**止めた直後はタスクの最終変化時刻がまだ古いので、
数え直さないと、次の周回で同じタスクがすぐ exit 8 に戻ってしまう。

### 4-6. `orca-wait.sh` の stopped の扱い

- `stored_outcome` を経由するすべての判定（`healthy` / `rewake_stalled` / `aggregate` / `finish`）で、`stopped.json` のある役を**決着済み、outcome=stopped** として扱う
- `healthy` は stopped の役に `worker-show` をかけない（閉じた端末は `stopped` や `failed` を返し、exit 4 になるため）
- `aggregate`: `integration_role` の役が stopped ならタスクは failed。reviewer が stopped でもタスクは failed にしない
- `finish` の行は `outcome=stopped` と出す。reviewer が stopped のタスクには、既存の `review=unreviewed` が付く
- **batch に stopped の役からの message が残っていても、未知の型として止めない。**閉じる直前に送られた `merge_ready` / `worker_done` はありうる。receipt は記録し、`merge_ready` には返事をしない（相手はもう居ない）

### 4-7. `orca-recover.sh`

`stopped.json` のある役には何もしない。「ユーザーが止めた」と出して 0 で終わる。
置き換えると、ユーザーが止めた役が生き返る。

### 4-8. merge の gate

変えない。reviewer を止めたタスクは `review-state.sh` で `unreviewed` になり、
`orca-merge.sh` は既存の gate で拒否する。`--allow-unreviewed` を付けるかどうかは、今までどおりユーザーが決める。

## 5. 設計 B: 取り込み方の事前質問

### 5-1. Step 1b

- 同じ `AskUserQuestion` 呼び出しに、質問を 1 つ加える: 「完了したタスクの取り込み方」→ Wait and merge / PR per task
- 設定の `integration` を推奨の答えとして示す。設定があっても毎回尋ねる
- この質問が 1 枠使うので、1 回の呼び出しに入るタスクの質問は 3 問（12 件）まで。13 件目からは次の呼び出しで尋ねる
- 答えは全タスク共通の 1 つの値とし、`INTEGRATION` として Step 2 に渡す

### 5-2. `orca-start.sh`

- `--integration merge|pr` を受け取り、`workers.json` に `integration` として記録する
- 値の検査は `config-lib.sh` の `dispatch_valid_integration` を使う
- `--phase exec` と `--resume` は、記録済みの `integration` を引き継ぐ（受け取らない）
- `--integration` を省略したときは、設定の値を記録する（`--issue` 経由の呼び出しと、既存の呼び出しを壊さないため）

### 5-3. SKILL.md Step 2

`: "${INTEGRATION:?set INTEGRATION to the Step 1b answer: merge or pr}"` を置き、`--integration "$INTEGRATION"` を渡す。
`DESIGN_MODE` と同じく、**尋ねていない dispatch を起動不能にする**ことで Step 1b を担保する。

### 5-4. Step 4 / `orca-merge.sh` / `orca-pr.sh`

- Step 4 は `workers.json` の `integration` を読んで、merge か PR かを選ぶ
- `orca-merge.sh` は `integration` が `pr` と記録されていれば拒否する。`orca-pr.sh` は `merge` と記録されていれば拒否する。**記録が無い古い status dir はどちらも通す**（今までどおり）
- `orca-issue.sh` は変えない（設定の値で動く）

## 5b. 設計 C: brainstorm の design worker を brainstorming → writing-plans の順にする

### 起きたこと（2026-09-23、influencer-platform の Run `run_786b0578f3dc`）

`design_mode=brainstorm` / `phase_b=on` の design worker が `superpowers:brainstorming` だけを呼び、
`superpowers:writing-plans` を一度も呼ばずに、spec と plan を混ぜた `plan.md`（872 行）を 1 本書いて終えた。
原因は `orca-start.sh` の design 役の指示文である。

1. brainstorm の指示に writing-plans へ進むことが書かれていない
2. `phase_b=on` の「PLAN ONLY / commit nothing / plan.md 以外に触れるな」が、skill の「spec を docs に書いて commit」「plan を docs に保存」と衝突し、worker は指示を優先して skill の手順を飛ばした
3. 「ask once」が brainstorming の「1 問ずつ尋ねる」と衝突した

### 決定

**writing-plans を呼ぶのは `brainstorm` のときだけ。**`direct`（`--issue` の既定）と `plan` は、`phase_b` によらず今のまま。

| `design_mode` | `phase_b=off` | `phase_b=on` |
|---|---|---|
| `direct` / `plan` | 今のまま | 今のまま |
| `brainstorm` | brainstorming → `<status-dir>/spec.md` → writing-plans で `<status-dir>/plan.md` → `superpowers:subagent-driven-development` で実装し、このブランチに commit | brainstorming → `spec.md` → writing-plans で `plan.md`。そこで終える。commit しない |

- skill 自身の保存先（`docs/superpowers/specs|plans`）と commit の手順は、指示文で上書きする。spec と plan は status dir に置き、merge に混ぜない
- writing-plans の最後の「実行方法をユーザーに尋ねる」は飛ばさせる。`phase_b=off` は **Subagent-driven に固定**（ユーザーの決定）、`phase_b=on` は計画を書いたら終える（作るのは exec）
- 「ask once」を消し、「skill のとおり 1 問ずつ `orchestration ask` で尋ねる」にする。共通の STATUS PROTOCOL の I も同じく直す。子の待機に期限が無くなったので、1 回にまとめる理由が無い
- skill が無いときは `result.md` に書いて続ける（今の縮退を writing-plans にも当てる）
- exec 役は「plan が作るものを決める。`spec.md` があれば plan の元になった設計として読む」。exec の起動ガード（`plan.md` が非空）と design の完了判定は変えない（`spec.md` は任意）

## 6. 文書

- SKILL.md と `references/guide-ja.md`: Step 1b（質問の追加）/ Step 2（ガードとフラグ）/ Step 3（exit 8 の行と、停滞時の手順）/ Step 4（記録された値で選ぶ）/ I3（`--on-stall report`）
- CLAUDE.md: 「待つのは 24 時間」の節を「子は待ち続け、止めるのはユーザー」に書き直す。構成の節に `orca-stop.sh` を足す
- README.md: 能力の要約に 1 行ずつ

## 7. テスト

| ファイル | 追加・変更 |
|---|---|
| `test-start.sh` | 指示文から待機上限の文言が消えていること / `review-skipped:` の扱いが書かれていること / `--integration` の記録と引き継ぎ |
| `test-completion.sh` | `expired` を返さないこと / `await_deadline` を書かないこと（CM17-26 を更新） |
| `test-wait.sh` | 停滞で exit 8 / `agentWait` と未回答の質問で時計が戻ること / 親が書くファイルを数えないこと / `snoozed_at` からの数え直し / `--on-stall report` で抜けないこと / stopped の集約（作る役なら failed、reviewer なら failed にしない）/ stopped の役に `worker-show` をかけないこと |
| `test-stop.sh`（新規） | 記録してから閉じること / 記録に失敗したら閉じないこと / reviewer を止めたとき依頼側へ `review-skipped:` を送ること / 決着済みなら何もしないこと / `--snooze` |
| `test-recover.sh` | stopped の役に何もしないこと |
| `test-merge.sh` / `test-pr.sh` | 記録された `integration` と違う方を拒否すること / 記録が無ければ通すこと |
| `test-docs.sh` | Step 1b に取り込み方の質問と `INTEGRATION` のガードがあること / Step 3 に exit 8 があること / SKILL.md と guide-ja の同期 |

## 8. 範囲外

- 親が自分の判断で子を止めること（ユーザーが「尋ねる」を選んだ）
- 端末の出力量による停滞判定（待機ループ中の子も出力を出し続けるので、判定に使えない）
- 「相手が居ない待機」の即時検知（無変化時間で拾う）
- タスクごとに取り込み方を変えること（cmux 版と同じく、dispatch 全体で 1 つ）
