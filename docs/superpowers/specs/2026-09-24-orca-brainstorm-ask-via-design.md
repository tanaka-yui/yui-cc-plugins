# orca-team-dispatch-task: brainstorm の質問先を選べるようにする（`ask_via`）

## 1. 背景

SKILL.md は brainstorm の design が「自分の端末を見ている人」と要件を詰めると書いている（Configuration の表、
Step 1、Step 1b の表）。一方、`bin/orca-start.ts` の brainstorm 指示は a7d1eb5（3.8.0）以降
「`orchestration ask` で尋ねよ。親が人へ取り次ぐ」と指示しており、Known limitations も同じことを書いている。
結果として logi-app の dispatch では brainstorming の質問が全部 exit 6 で親に届き、親が AskUserQuestion で
中継していた。

**実測（2026-09-24、logi-app の fulfill-port）**: design が端末に「設計 3/3 はこの内容で承認いただけますか？」と
書いてターンを終え `❯` で待っている間、`worker-show` は `state=ready`・`stage=input_accepted`・
`observation.agentWait=null` だった。**Orca の `agentWait` は「ターンを終えて端末で人を待つ」状態を拾わない。**
2026-09-23 の spec（unbounded-wait）4-2 の「要実測」はこれで否定された。端末で質問させると、答えを待つ間も
停滞の時計が進み、120 分で exit 8 になる。

## 2. 決定

- brainstorm の質問先を設定 `ask_via` で選ぶ。`terminal`（既定）は各 worker の端末で直接尋ね、`parent` は
  今の `orchestration ask` → exit 6 の取り次ぎ
- Step 1b で毎回尋ね、設定値を推奨として示す（integration と同じ扱い。答えは dispatch 内の全タスクに効く）
- 端末で待つ間の停滞判定は、**worker が申告する印**で行う
- exit 6 の取り次ぎのコードは、`parent` の経路と、指示に反して ask した worker への保険として残す
- 完了ハンドシェイク（merge_ready 〜 worker_done）とレビュー往復は変えない

## 3. 設定 `ask_via`

- `lib/config.ts` の `TOGGLES` に `ask_via: { values: ['terminal', 'parent'], fallback: 'terminal' }` を足し、
  `TOGGLE_KEYS` にも入れる。`config-resolve.ts` は `--ask-via` を受け、解決結果の JSON に `ask_via` を出す。
  `config-edit.ts` の set / unset は toggle 共通の経路に乗る
- **既定は `terminal`。**他の toggle は「設定が生まれる前の挙動」を既定にしているが、ここは文書が意図していた
  挙動を既定にする。この例外を SKILL.md の設定表に明記する
- 効くのは `design_mode=brainstorm` の `design` だけ。`direct` / `plan` と他の役の指示は変わらない
- `--issue` は brainstorm を plan へ落とすので無関係。Step 1b が無いのも今までどおり
- `workers.json` には記録しない。wait は値を知らなくても両経路を扱える（5 章）

### Step 1b と Step 2

- Step 1b の 1 回の `AskUserQuestion` に単一選択の質問を 1 つ足す: brainstorm のタスクがどこで質問するか。
  答えは「各 worker の端末」「親（オーケストレータ）経由」の 2 つ。設定値を推奨として示す
- 固定の質問が 2 つ（integration と ask_via）になるので、最初の呼び出しに載るタスクの質問は 2 問（8 タスク）。
  それを越えるタスクは続く呼び出しで尋ねる
- Step 2 の block に `: "${ASK_VIA:?set ASK_VIA to the Step 1b answer: terminal or parent}"` を置き、
  `orca-start.ts --ask-via "$ASK_VIA"` を渡す。`orca-start.ts` は `--design-mode` と同じく config-resolve への
  上書きとして渡し、`--resume` でも受け付ける。`--phase exec` は design の指示を作らないので値を使わない

## 4. worker への指示（`bin/orca-start.ts`）

- `ask_via=parent`: 今の文面（「Ask through `orchestration ask` ...」の段落）のまま
- `ask_via=terminal`: その段落を次の趣旨の英文に差し替える
  - この端末は人が見ている。答えが必要なとき（brainstorming の各質問と、書いた spec のレビュー依頼）は、
    まず `node <scripts/awaiting-user.ts> --role-dir <roleDir>` を実行し、返答の最後に質問を書いてターンを
    終える。答えはこの端末に次に打ち込まれるメッセージとして届く。質問は 1 回に 1 つ
  - `orchestration ask` は使わない。この dispatch では親は質問を取り次がない
  - **ターンを終えて待ってよいのはここだけ。**STATUS PROTOCOL の C 以降と、レビューの verdict 待ちでは、
    それぞれの手順どおりターン内で待ち続ける
  - 誰も答えなくてもよい。答えるか止めるかは見ている人が決める
- STATUS PROTOCOL の I 項（「`ask` はこのタスクが指示したときだけ」）はそのまま。terminal では brainstorm の
  節が ask を禁じるので矛盾しない

## 5. 人待ちの印と wait の判定

### 印: `skills/orca-team-dispatch-task/scripts/awaiting-user.ts`

- Usage: `node awaiting-user.ts --role-dir <dir>`。`<dir>/awaiting-user.json` に `{"asked_at": <epoch 秒>}` を
  原子的に書く。exit 0 = 書いた / 1 = 書けなかった / 2 = 使用法エラー
- `status.json` は流用しない。merge / pr / recover / Step 3.5 の起動判定が読んでおり、値を増やすと
  それぞれの判定に波及する
- **印を消す手順は無い。**判定は「印がそのタスクで worker が最後に書いたものか」で行うので、答えのあとに
  spec.md・plan.md・commit・ファイル変更・status などが書かれれば印は自動的に古くなる。次の質問で書き直される

### wait（`bin/orca-wait.ts`）

- `taskLastChange` を分ける
  - `workerLastChange(statusDir)`: 子が書くものすべて（今の対象に各役の `awaiting-user.json` を足し、
    `human.json` を除く）
  - `taskLastChange(statusDir)`: `max(workerLastChange, human.json の mtime)`（今と同じ値の意味）
- `awaitingUser(statusDir)`: 各役の印のうち最も新しい mtime が 0 より大きく、`workerLastChange` 以上なら、
  その役を返す（無ければ null）
- `checkStall` の各タスクで、決着判定のあと `awaitingUser` が役を返したら `markHuman` を呼んでから時計を
  計算する。agentWait と同じく、人を待つ間は停滞にならない
- 印を初めて見たとき（その役の印の mtime ごとに 1 回）、
  `<role> of <slug> is waiting for an answer in its terminal <handle>` を log に出す。記憶は State に持つ
- 劣化: 答えのあと worker が何も書かずに黙り続けると、印が最新のまま残って停滞が見つからない。逆に
  worktree の無関係なファイル（ログなど）が更新されると印が古いと判定され、今と同じく 120 分で exit 8 になる。
  どちらも worker を誤って止めることはない（止める判断は人がする）
- exit 6 の取り次ぎ（`question` 型・`questions.json`）は変えない

### 催促の行と回復

- wait が打ち直すのは `merge_ready_sent` の役だけ、recover の nudge は completion が始まった役か status=error の
  役だけ
- **（実装後の最終レビューで訂正）**`orca-send` の起床は design がレビューを依頼したあとだけ、という当初の見立ては
  誤りだった。ユーザーが reviewer を止めると、orca-stop が `review-skipped:` を design へ送り、orca-send が
  orca-wake で design の入力欄に 1 行を打つ。そこで判定を `lib/awaiting.ts` の `awaitingSince` に移し、
  **orca-wake は印が最新の役に打たない**（メッセージはメールボックスに残る）。orca-wait も同じ関数を使い、
  止めた・決着した役の印は数えない

## 6. 文書

SKILL.md が正本。`references/guide-ja.md` に見出しと内容を写す。

- Configuration: 設定表に `ask_via` の行を足し（既定の例外を明記）、design_mode の brainstorm の説明を
  `ask_via` に従う書き方にする
- Choosing how `design` starts: 「`brainstorm` needs a person」の段落に 2 経路を書く
- Step 1: 「with the user in its own terminal」を ask_via に応じた書き方にする
- Step 1b: ask_via の質問・容量（固定 2 問 + タスク 2 問）・表の brainstorm 行
- Step 2: ガードと `--ask-via`
- Step 3: exit 表の 6（`parent`、または指示に反して ask した worker）と 8（端末の印も「人を待つ役」）、exit 6 の
  説明段落、端末で待つ worker とその log 行
- Known limitations: 質問の行を 2 経路で書き直す
- State on disk: `roles/<role>/awaiting-user.json`
- プラグインの CLAUDE.md: 「worker の質問は親が答えられる（exit 6）」の項を ask_via の 2 経路と exit 6 を残す
  理由に書き換え、「子は待ち続け」の節に印の判定と agentWait の実測を足す
- README.md: 能力の要約に該当する記述があれば 1 行だけ直す

## 7. テスト

- `test-config.sh`: ask_via の既定が terminal / 不正値の拒否 / `--ask-via` の上書き
- `test-start.sh`: brainstorm × terminal の指示文に awaiting-user.ts と「ターンを終えてよいのはここだけ」が入り
  「Ask through `orchestration ask`」が入らない / brainstorm × parent は今の文面 / plan・direct は ask_via で
  変わらない / `--ask-via` の値の検証
- `test-wait.sh`: 印が最新なら human.json が更新され exit 8 にならない / 印のあとに子の書き込みがあれば
  exit 8 / 印があり completion の無い役には wake を打たない
- `test-report-status.sh`: awaiting-user.ts が印を書く・使用法エラー
- `test-docs.sh`: SK17 を ask_via の質問と Step 2 のガードまで広げ、SK21 の表の文面を合わせる
- 検証: `bash test/run-all.sh`、`pnpm --filter @tanaka-yui/orca-team-dispatch-task check`、`pnpm check:doc-lang`

## 8. バージョン

3.9.2 → 3.10.0。`.claude-plugin/plugin.json`・`.codex-plugin/plugin.json`・ルートの `marketplace.json` を揃える。
