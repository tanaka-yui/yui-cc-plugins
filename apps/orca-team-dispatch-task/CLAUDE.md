# orca-team-dispatch-task 開発ガイド

Orca の worktree で N タスクを worker に並列実行させるプラグイン。

## 正本先行の原則

**「このソフトウェアは X をする」と書く前に、X を真にするコードを書く。**
回帰は `test/test-docs.sh` が固定する（参照先の実在 / 未実装の非宣言 / 文の単一 owner）。

## ユーザー向けの文の owner

**SKILL.md が正本。**`references/guide-ja.md` は見出しも内容も完全な写し。
`README.md` は能力の要約だけで、recovery / cleanup の手順を持たない。
3 つが別々の言い方をしていたら、それは drift である。

## 構成

入口はすべて TypeScript。`bin/orca-start.ts`（worktree + Task を用意し、`worker-start` で Orca に
端末起動を依頼する。端末自体は Orca が作る）/ `bin/orca-wait.ts`（`worker_done` を待つ。
成功 0 / 失敗 5）/ `bin/orca-wake.ts`（役の端末へ 1 行入力してアイドルな worker を起こす）/
`bin/orca-stop.ts`（役の停止と停滞の時計の数え直し）/ `bin/orca-merge.ts`（成果を親ブランチへ。
**資源は消さない**）/ `bin/orca-cleanup.ts`（Step 5 の判定 `plan`、Step 6 の実行 `run`、後片付けのモードの `auto` / `sweep`）/
`skills/.../scripts/report-status.ts`（worker が status を書く口）/
`skills/.../scripts/config-resolve.ts` と `config-edit.ts`（設定の入口）。設定の定義は `lib/config.ts`。
SKILL.md の block が読む状態は `bin/orca-state.ts`（wait-stamp / design-status / integration / mailbox /
accounts。読むだけ）、issue モードの実行の前後は `bin/orca-issue-loop.ts`（start / claim / reconcile /
release）が受け持つ。issue の state file の場所と除外は `lib/issue.ts`（`orca-issue.ts` と共有）。

## TypeScript（node）で書く部分

設計は `docs/superpowers/specs/2026-09-23-orca-ts-migration-design.md`。**SKILL.md の複数行の bash
ブロックは、呼び出し側のシェル（mac も WSL も zsh）で実行される。**2026-09-23 に、zsh が
`for ROLE in $ROLES` を単語に分けず、Step 5 の [C1] が誤停止した。判定は文書に書かず、入口の
1 行呼び出しにする（P1 で Step 5 / Step 6 を `bin/orca-cleanup.ts` に、P2 で残りの入口を全部 .ts に、P3 で SKILL.md の残りのブロックを入口の 1 行呼び出しに移した）。

- 実行は `node <path>.ts`（型除去で直接走らせる。**Node 22.18 以上**）。プラグインはファイルの
  まま入り `npm install` は走らないので、**実行時の npm 依存はゼロ**（`node:` の組み込みだけ）。
  `typescript` はルート、`@types/node`（22.15.3。下限の 22 系に合わせる）はこの package の
  devDependencies で、どちらも型検査専用
- `tsconfig.json` の `erasableSyntaxOnly` は enum / namespace / 引数プロパティを弾く（node の
  型除去が扱えない）。`verbatimModuleSyntax` は型だけの import に `import type` を強いる
  （付け忘れると node が実行時に SyntaxError で落ちる）
- `lib/` は入口から import する共通部品。`orca.ts` は Orca CLI を**標準入力を渡さずに**呼ぶ
  （`bash <<EOF` で流したとき、途中の CLI がスクリプトの残りを読んで判定を黙って飛ばした）。
  `any` / `unknown` / `class` は書かない。JSON は `lib/json.ts` の `Json` 型と `asObject` などで絞る
- **`runOrca` は `orchestration` の呼び出しに `--full` を足す。**Orca 1.4.246 は既定を簡潔表示にし、worker-show の
  `result.worker` / `result.dispatch` / `observation` と worker-list の `workerState` / `resource` が消えた
  （2026-11-02、logi-app の待機が生きている design の state を '' と読んで exit 4 で止まった）。この plugin の
  読み取りはすべて `--full` の形で書く。worker の state は `lib/orca.ts` の `workerState` で読み、簡潔表示の
  `result.state` にも落ちる。回帰は `test-wait.sh` の WT133 と `test/unit/orca.test.ts`
- **Orca が自動で出す `escalation`（「Worker stopped [on an error] without reporting」）で待機を止めない。**worker_done を
  送らずにターンを終えるたびに来る（ask_via=terminal の design は尋ねるたびに、スリープで API が切れたときは on an
  error の方）。2026-11-02、logi-app で「cannot handle (type='escalation')」の exit 1 になり、未読が queue に残った。
  dispatch は開いたままなので、`orca-wait.ts` は 1 行言って batch ごと既読にし待ち続ける。人待ちは awaiting-user.json、
  黙った worker は停滞（exit 8）が受け持つ。**起床はしない** — 端末で人が答えを打っている最中かもしれない。
  回帰は `test-wait.sh` の WT134-136
- **worker が Run 宛てに送る `status` でも待機を止めない。**payload を持たないのが普通で、2026-11-03 の logi-app で
  design が依頼者からの追加依頼を知らせたとき「handles only worker_done」の exit 1 になり、`pending-batch.json` の
  batch を読み直すたびに同じ所で止まった。件名と本文を表示して既読にし、待ち続ける。送り主は payload の dispatchId か
  `from_handle` と workers.json の terminal で引く。`_orcaLifecycleRejection` を持つ status（Orca の拒否通知）は
  今までどおり拒否の分岐が受け持つ。回帰は `test-wait.sh` の WT4e と WT147-149
- C2b のmail受理は、このfollowUpを二度起こさないため `accepting` → `accepted` の2段で親が記録する。返事の前にaccepting、okかつmessage.idが返ればaccepted。送信結果が不明なら同じ受理をすぐ再送せず、workerのdispatch inboxに同じnonceの受理があるかを確認する。読めない・100件で全件と言えないときは保留する。WT161b〜dが送信失敗・送る前の中断・inbox不明を固定する。
- **Orca は終わった dispatch に `status` / `dispatch` / `handoff` が届くと、followUpOf の新しい dispatch を作って同じ
  worktree に worker を起動し直す**（Orca 1.4.246 の orchestration.send。`bUe` が対象 type）。2026-11-03 の logi-app で、
  pending-batch.json を読み直した待機が merge_ready にもう一度 completion-accepted を送り、worker_done を送り終えた役に
  followUp ができた。その worker の escalation は「does not know」の exit 1 になり、次の待機も同じ batch で止まった。
  `orca-wait.ts` は (1) completion.json が同じ nonce で accepted / settled の merge_ready には返事をしない、(2) 知らない
  dispatch は worker-show の `result.dispatch.followUpOf` を辿り、知っている役に行き着けばその役の `follow_ups` に
  記録して読み流す（決着は元の dispatch が運ぶので followUp の worker_done では記録しない）。`orca-cleanup.ts` は
  `follow_ups` を `superseded` と同じく記録済みとして数える。回帰は `test-wait.sh` の WT150-153 と `test-cleanup.sh` の CL27b
- **衝突を親が手で直して merge したら、`orca-merge.ts` をもう一度走らせて記録する。**3.10.13 の logi-app で、手で merge
  したタスクの integration-result.json が merged:false のまま残り、`orca-cleanup.ts plan` が worktree も record も
  offer しなかった。`orca-merge.ts` はブランチが親ブランチの祖先なら merge を打たずに merged:true を記録し、衝突の
  案内でこの手順を言う。plan は祖先かどうかで merged とみなさない（record を消す根拠は orca-merge.ts の記録だけ）が、
  祖先なら記録のコマンドを理由に添える。回帰は `test-merge.sh` の MG23-25 と `test-cleanup.sh` の CL15c
- **親の `orchestration check` には必ず `--run <run.json の run_id>` を付ける**（orca-wait.ts の 4 箇所と orca-state.ts の
  mailbox）。`--run` の無い check は親端末の「bound Run」= その端末が最後に作った Run を返す。2026-11-04 の
  freelance-jp-app で、同じ親端末から 2 つ目の Run を起動すると、1 つ目の待機が 2 つ目の Run の merge_ready を読んで
  「does not know」で止まり、pending-batch.json を誤った status dir に残し、自分の Run の merge_ready を拾えなくなった。
  それでも別の Run の batch が来たら（runId が違う）、この Run の pending-batch.json に混ぜず `foreign-batch-<run_id>.json`
  に残して exit 1 にする。回帰は `test-wait.sh` の WT138 / WT154-155 と `test-state.sh` の OS7
- **Run を暗黙に決める呼び出しを残さない。`task-create` と `worker-start` には必ず `--run <run.json の run_id>` を付ける**
  （`orca-start.ts` の新規・`--resume`・`--phase exec`、`orca-recover.ts` の置き換え）。`--run` の無い呼び出しは、Orca が
  親端末の current の Run（その端末が最後に作った Run）に載せる。2026-11-10（3.10.16）、developer-auth の `--phase exec` が、
  あとから同じ端末で作った terraform-infra の Run に exec と exec_review を作った。developer-auth の待機には exec の通知が
  一度も届かず、terraform-infra の待機は知らない dispatch の escalation で exit 1 になった。Orca 1.4.255 は、親の pane が
  coordinate している Run なら current でなくても `--run` を受け付ける（`getCoordinatedRun`）。**`run-use` で束縛を移さない**
  — run-use はその端末が coordinate する他の Run の束縛を外し、そちらの受信箱を止める。続きの段は `run-show` で記録した Run の
  `coordinator_handle` が親端末かを worktree を作る前に確かめ、task-create の `result.task.run_id` と worker-start の
  `result.runId` が記録した Run と違えば worker を起こさず・記録せずに止まる（receipt に Run が無ければ `--run` に頼る）。
  `orca-recover.ts` は worker-show の `result.dispatch.runId` が違う役に何もしない。`send --to dispatch:<id>` は dispatch
  自身の Run を使い、worker 側の `check` は worker の端末で決まるので `--run` は要らない。回帰は `test-start.sh` の
  ST119-124 と `test-recover.sh` の RC49-51
- **既にある Run に作るときは、current の Run と比べない。**`--run` を受けた新規の起動（Step 2 の 2 タスク目以降と
  Issue モードのバッチ内の 2 件目以降）も、続きの段と同じく `run-show` の `coordinator_handle` が親端末かだけを見る
  （`orca-start.ts` の `coordinates`）。current と比べていた版は、間に同じ端末で別の Run を作ると「this terminal is
  bound to Run ...」で相乗りを拒んだ。`run-current` で確かめるのは、今 `run-create` した Run だけ。回帰は
  `test-start.sh` の ST24-26b / ST108 と `test-issue.sh` の IS30
- **Orca の consuming check は返した batch をその場で既読にする**（Orca 1.4.246。`--ack` は要らない）。「ack する
  まで batch は queue の先頭に残る」を前提にした待機は、止まった batch を失っていた。2026-11-02 の logi-app で、
  待機ループの `check --wait`（これも consuming）が返して捨てた batch の merge_ready が、返事なしに既読になり、
  worker が 1 時間返事を待った。待つのは `--peek --wait` にし、drain が受け取った batch は各 status dir の
  `pending-batch.json` に残して、処理し切ってから消す。次の drain（起動し直した待機も）は Orca より先にそれを読む。
  止まった batch は `--peek` に出ないので、`orca-state.ts mailbox` と待機の案内はそのファイルと
  `orchestration inbox --terminal run:<run_id>` を示す。escalation の taskId が空のときは dispatch id だけで引く。
  回帰は `test-wait.sh` の WT137-141 と `test-state.sh` の OS7b
- **worker_done だけを失った役は、待機が Orca と親の記録から決着させる**（`orca-wait.ts` の `recoverLost`）。3.10.8 /
  3.10.9 が捨てた worker_done はもう届かず、待機は猶予（3 周）のあと `is 'succeeded'` で exit 4 を繰り返した
  （2026-11-03、logi-app の oms-operations-history の design と design_review）。記録するのは 3 つが揃ったときだけ:
  Orca が worker を succeeded・dispatch を completed と言う、親がその役を受理している（completion.json が accepted か
  settled）、受信箱（`--peek`）にその worker_done が残っていない。failed や未受理は今までどおり 4。記録と保持は
  drain と同じ `settleEntry` を通す。回帰は `test-wait.sh` の WT142-146
- スクリプト間の呼び出しは `lib/sys.ts` の `runNode` で子プロセスにする。起床の失敗で配送を
  覆さないなど、bash 版の分離を保つため、import して同じプロセスで呼ばない
- worker への指示文は `node <path>.ts` で completion / report-status / orca-send を呼ぶ
- 共通部品は `lib/sys.ts`（子プロセス・PATH・sleep・時刻）、`lib/config.ts`（設定の定義）、
  `lib/dispatch.ts`（`startIncomplete`）
- 入口は stdout をまとめて書き、`process.exitCode` で終える。`process.exit` は使用法の誤り
  （`die`）と `issue-fetch.ts` の `fatal` で使う — パイプへの書き込みが途中で切れうる
- 型検査と lint は `pnpm --filter @tanaka-yui/orca-team-dispatch-task check`。単体テストは
  `node --test 'test/unit/*.test.ts'`（**ディレクトリを渡すと node はそれをモジュールとして読んで
  失敗する**）で、`test/run-all.sh` が最後に走らせる
- `orca-cleanup.ts plan` は計画を `<repo>/.dispatch/cleanup-<run_id>.json` に書き、`run` は
  **その計画の提示しか実行しない**。argv が計画を書いたときの形と違えば（`--force` の追加など）
  計画ごと拒む。`worker-release` のあとは `worker-list` から state を読み直す（receipt の `ok` だけ
  では「閉じた」と言えない。実測 O43）。回帰は `test/test-cleanup.sh`
- **Orca が端末を閉じない理由は `ownershipState: user_owned`（ユーザーが操作した端末）で見る。**`retainedReason` は
  Step 3 の worker-retain が付けた `user_requested` のままのことがある（2026-09-23 と 24 に 4 Run の design で実測。
  `user_takeover` だけを保持扱いにしていた版は、run がそのタスクの残りを 1 つも実行しなかった）。plan はその release を
  提示せず、run の読み直しでも保持として worktree へ進む（判定は `lib/orca.ts` の `userOwned`）。**失敗が止めるのは
  依存する手順だけ** — 端末の失敗はその役の worktree と記録を、worktree の失敗は記録を止め、ほかの役の端末と
  worktree は続ける。回帰は `test/test-cleanup.sh` の CL31-CL36 と `test/test-docs.sh` の SK28

- **後片付けのモード `cleanup`（end / pr_created / pr_merged）。**PR のタスクは
  integration-result.json が merged:false なので、従来の Step 5 は worktree と記録を提示しなかった。
  `--pr-saved` は (1) integration が pr で pr_url があること、(2) integration_role の branch の
  手元の SHA と `git ls-remote origin` の SHA の一致を確認し、そのタスクを保存済みとして判定する。
  plan には同じ Run の残っている status dir を全部渡す（欠けると [C7] が記録に無い retained と読み、Run ごと止まる）。
  保存済みのタスクでも、ユーザーが操作した端末（user_owned / user_takeover）の worktree は提示せず、
  何かが残るタスクの記録も提示しない。worktree を消すとその端末を尋ねずに閉じ、Orca はその worker を
  retained と言い続けるので、記録を消すと次の plan が ghost と読むためである。
  run も、release の読み直しでユーザーの保持が分かった役の worktree と記録は実行しない（plan のあとの
  操作は従来の release が ok を返す経路。CL33）。計画の pr_saved は信じず、readPlan で提示の種類に
  かかわらず 2 条件を確かめ直す。removeRecord は (1) と [C5] だけを再確認する（worktree rm が branch を
  消しうる。[C4]）。auto / sweep は pr_saved と判定したタスクにだけ承認を出す（plan は merged と無関係に
  端末の release を提示するため）。head branch を merge で消すリポジトリでは pr_merged が何も片付けない。
  PR の headRefOid と比べる代案は未確認で、採用していない。回帰は test-config.sh の CF53〜54、
  test-start.sh の ST138〜140、test-cleanup.sh の CL40〜CL52（CL40b/c・CL41b・CL43b〜f・CL44b〜d・
  CL46b・CL47b・CL48b/c を含む）、test-docs.sh の SK38。

- **SKILL.md の bash block に判定を書かない。**置いてよいのはコメント、ガード `: "${VAR:?...}"`、入口の
  呼び出し（`node "$PLUGIN/..."` / `"$ORCA_BIN" ...` / `gh repo view`）だけ。block の間で shell 変数を運ばせ
  ない（Bash ツールは tool call を跨いで変数を持たない）— 値は入口が `key=value` で印字し、次の block が
  ガード付きの変数か `"<... printed by ...>"` で受ける。repo root・state file・層のファイルは入口が自分で決める。
  例外は冒頭の PLUGIN / ORCA_BIN の定義、Step 1 の依頼ファイル、切り離した待機の 3 つ。
  **ガードの文言に `'` を書かない** — bash は `"${VAR:?...'...}"` の `'` を引用の開始と読み、block 全体が構文
  エラーになる（2026-09-24、Step 2 と Step 3.5 で見つけた。zsh は通すので気づかれなかった）。
  **`${VAR:+--flag "$VAR"}` を書かない** — zsh は 1 語にし、入口は `unknown option` で落ちる（同日、Step 2 と
  I3。空の値は入口が「渡されていない」と同じに扱う）。回帰は `test-docs.sh` の SK26（判定を書かない）と
  SK27（各 block を bash と zsh で走らせ、入口に届く argv が一致する）

## 設定層に runner レジストリが無い理由

cmux 版の `runner` は `runners.json` に登録した**名前**で、それを engine（claude|codex）へ
写していた。名前と engine を分けていたのは「同じ engine で別アカウントの runner」を作るため
だが、**Orca ではそれが作れない**（実測）:

- `orchestration worker-start` の flag は `agent` / `model` / `effort` / `terminal` 等で、
  アカウント指定口が無い
- `account` 名前空間は `add` と `list` の 2 つだけ。全 234 コマンドを機械可読スキーマ
  (`agent-context --json`) で洗っても active を選ぶコマンドは無い。active は
  `account list` の `activeAccountIdsByRuntime` にランタイム単位で出るが、書くのは GUI だけ

よって runner 名を作る動機が消え、**`--agent <id>` がそのまま runner 兼 engine** になる。
`runners.json` と `config-edit.ts --runners` / `--engine` は移植しない。

**agent の allowlist は閉じない。**スキーマが `--agent` の値として名指しするのは claude と
codex だけだが、未知の値も警告付きで通す（Orca が agent を増やしたときにここを直さずに
設定できる状態を保つため）。判定できないもの（未知 agent の effort）は Orca に委ね、
誤りは `worker-start` の失敗として見える。

**未設定のフィールドはロールごとの既定 tuple で埋める**（`lib/config.ts` の `DEFAULT_TUPLES`。
design / exec_review = claude・`claude-opus-5-5[1m]`・max、design_review = codex・gpt-6-astra・xhigh、
exec = codex・gpt-6.1-sol・high）。Opus は `opus[1m]` alias だと provider によって古い版を指すので
フルネームで固定する。**既定の model / effort は、解決した agent が既定 agent と一致するときだけ
使う** — agent だけ変えた設定に別 agent 用の model を混ぜないため。その場合は flag ごと渡さず
Orca 側の既定に委ねる。回帰は `test/test-config.sh` の CF1 / CF1b と `test/test-start.sh` の ST31 が固定する。

## WSL2 の path 境界

Orca 本体は Windows 側に居るので、**CLI 境界で path 形式が変わる**（実測）。送りは
`wslpath -w`（Linux path のままだと `repo_not_found`）、受けは `wslpath -u`（receipt の
path は UNC で返り、bash の `-d` も `git -C` も解釈できない）。変換するのは
`orca-start.ts` の repo selector と worktree path だけ。**worktree id と terminal handle
は変換しない**（実測: `\` を含む id はそのまま通る）。`orca-merge.ts` は branch ベース
なので無関係。判定は `ORCA_ORCHESTRATION_COMPATIBILITY_HOST_KIND=wsl` **かつ** `wslpath`
の存在の両方。`ORCA_BIN` の既定は `$ORCA_CLI_COMMAND`（WSL2 では PATH 上の `orca-ide`）へ
フォールバックする。回帰は `test/test-start.sh` の ST28*/ST29 が固定する。

**worker の helper は env の `ORCA_BIN` に頼らない。**2026-10-20 の実測: WSL2 の codex
（`shell_environment_policy.inherit = "core"`）は `ORCA_BIN` も `ORCA_CLI_COMMAND` も shell に渡さず、
`orca-send.ts` / `completion.ts` の `orcaBin()` が macOS の app bundle の path に落ちて exit 1 になった。
design_review の判定と exec のレビュー依頼が届かず、実装は未レビューのまま受理された。そこで指示文は
直接の CLI 呼び出しと同じく、helper の呼び出しにも親が解決した値を `ORCA_BIN=<実値> node ...` で焼き込む
（`orca-start.ts` の `qNode`）。回帰は `test-start.sh` の ST113。

## 配送は起床ではない

**`orchestration send` はメールボックスに入れるだけで、ターンを終えた worker を起こさない。**
2026-09-10 の実測: 1 Run の 4 worker 全員が `completion-accepted` と `review-verdict` を
未読のまま停止し、`terminal send` で端末へ直接入力して初めて動き出した。`orca-recover.ts`
の nudge も `orchestration send` なので同じく効かなかった。**この 1 つの事実から、対策は
2 層になる。**

- **層 1（源）: worker にターンを閉じさせない。**旧 STATUS PROTOCOL は merge_ready の
  あとに「End your turn here」「When you are woken」と書いていた。起こす者が居ないので、
  これは「止まれ」と書いてあるのと同じだった。いまは `completion.ts await` を呼び直させる
  （1 回 10 分ブロック / 出力は `accepted` `remediation` `waiting` の 3 つ。期限は無い）。
  **`waiting` は「まだ来ていない」であって「来ない」ではない** — ここを give-up にすると
  元に戻る。回帰は `test-start.sh` の ST66-69 と `test-completion.sh` の CM17-26
- **層 2（保険）: 親が端末を叩く。**`orca-wait.ts` は受理・差し戻しを送った直後に
  `orca-wake.ts` を呼び、さらに待機ループの各周回で **`merge_ready_sent` のまま返事を
  待っている役だけ**を 30 分間隔で叩き直す。**働いている worker には打たない** — 人の
  入力欄に文字列を撃ち込むことになる。`orca-send.ts`（worker 間）と `orca-recover.ts`
  （nudge）も同じ `orca-wake.ts` を通す。回帰は `test-wake.sh` / `test-wait.sh` の WT60-65

**起床の失敗で配送の成否を覆してはならない。**配送は送信側の exit code で確定しており、
`orca-send.ts` の呼び出し側はその値で「書いた依頼ファイルを消す」補償を決める。だから
`orca-wake.ts` は独立した script で、呼び出し側は rc を握り潰す。「止まっている」と
「止まっていて届かない」を別の結論として報告するのも同じ理由で、端末が記録されていない
役は 1 で返して**何も打たない**（cmux 版の seat 未記録と同じ切り分け）。

**issue モードの「wake 駆動を持ち込まない」と矛盾しない。**あちらは**親**の駆動方式の話
（`orca-wait.ts` がブロックして待てるので、cmux 版の単発 safety timer と timeout sentinel
は要らない）で、こちらは**子**を起こす話である。

## 子は待ち続け、止めるのはユーザー

**子は待機に期限を持たない。**2026-09-23 の実測: design が brainstorm でユーザーの回答を
待つ間に、reviewer が「1 時間依頼なし」で自分から終了し、そのタスクはレビューされなかった。
子は待っている相手の事情（人の回答待ちなど）を知らないので、「来ない」を判断できない。
reviewer・依頼側のレビュー待ち・`completion.ts await` のどれも、自分から待機をやめる経路を
持たない（回帰は `test-start.sh` の ST67 / ST89 / ST90、`test-completion.sh` の CM22 / CM22b /
CM27b）。

**停滞を見つけるのは親、止めるかを決めるのはユーザー。**`orca-wait.ts` はタスク単位で
「子が書くもの」（status / result / completion / spec / plan / review / worktree の変更と commit）の
最終変化時刻を見て、`--stall-after-min`（既定 120）を越えたら exit 8 で抜ける。**親が書く
ファイル（`wait.json` / `.woken` / `received.json` / `questions.json` / `stall.json`）は
数えない** — 数えると親の鼓動で常に「変化あり」になる。人を待っている間（`agentWait` と
質問の取り次ぎ）は `human.json` に時刻を残して時計を戻す。`questions.json` は答えた時刻を
持たないので、取り次ぎ済みとして通した時点（人が答えた直後）でも戻す。止めるのは
`orca-stop.ts` で、**記録してから Orca に止めさせる**（Orca が決着済みと言えば worker-release、
そうでなければ worker-stop。**端末を直接閉じない** — 手で閉じた端末は user_takeover として残り、
Step 5 を Run ごと止める。回帰は test-stop.sh の SP14-17）。`--issue` は `--on-stall report` で
止まらずに記録だけ残す（回帰は `test-wait.sh` の WT80-92、`test-recover.sh` の RC16）。

**`agentWait` はターンを終えて端末で人を待つ状態を拾わない**（2026-09-24、logi-app の実測: 端末に質問を書いて
`❯` で待つ design の worker-show は `state=ready`・`agentWait=null`）。そこで `ask_via=terminal` の worker は
尋ねる前に `awaiting-user.ts` で `roles/design/awaiting-user.json` を書き、待機はそれが**タスクで子が最後に書いた
もの**である間を人待ちとして扱う（`workerLastChange` は human.json を含めない — 含めると 2 周目から最新でなくなる）。
消す手順は無く、答えのあとの書き込みで自然に外れる。劣化は 2 方向: 答えのあと何も書かずに黙ると停滞が見つからず、
worktree の無関係なファイルが動くと印が外れて今までどおり exit 8 になる。どちらも誤って止めはしない。
**止めた・決着した役の印は数えない**（止めた design の印が最新のまま残ると、reviewer が決着しない限り停滞が
二度と知らされない）。**催促の行は回答欄に入れない** — 判定は `lib/awaiting.ts` の `awaitingSince` 1 箇所に置き、
`orca-wake.ts` は印が最新の役に打たない。打ち直しが `merge_ready_sent` の役だけでも足りなかった: 最終レビューで、
reviewer を止めたときの `review-skipped:` の起床（orca-stop → orca-send → orca-wake）が答えを待つ design に
打ち込む経路が見つかった。メッセージはメールボックスに残り、答えを受けた worker が読む（回帰は `test-wait.sh` の
WT114-118、`test-wake.sh` の WK10 / WK11、`test-stop.sh` の SP20）

**停滞の判定は `workers.json` をその都度読む。**期待集合は知らない dispatch の message が
来たときしか読み直さないので、それを使うと `--phase exec` で足された exec が最初の message
まで見えない。成果を載せる役（`integration_role`）が起動されていなければ決着していないとし、
`unstarted_role` として知らせる（Step 3.5 の飛ばし。起動済みの役が全部決着してから）。
**待っている全タスクがそうなったら、停滞の閾値を待たずに exit 9（段の終わり）で返す。**停滞にだけ任せていた版は、
`--stall-after-min 240` の呼び出しで design と design_review の worker_done を受けたあと 1 時間 25 分、何も log に
出さなかった（2026-10-11）。ほかのタスクが働いている間は返さず、1 回だけ log に出す。全役が決着したのに集約できない
理由（status.json と receipt の食い違い）も 1 回だけ log に出す（回帰は `test-wait.sh` の WT95 / WT127-132）。
決着済みの reviewer も、依頼側が待つ間は停滞の行に残す。作る役（計画役の design を含む）を
止めたか計画役が失敗したタスクは、exec を待たずに失敗で決着する。**止めたら相方へ知らせる** —
reviewer を止めたら（決着済みでも）依頼側へ `review-skipped:`、作る役を止めたら reviewer へ
`abort-reviewer:`。どちらも自分からは待機を抜けないので、知らせないと永久に待つ
（回帰は WT94-101、`test-stop.sh` の SP7 / SP9-13）。

親の `--max-waits` の既定 288（5 分 × 288 = 24 時間）は残す。子の期限と揃える意味は
無くなり、24 時間ごとに exit 3 で状況を報告して呼び直す区切りになった。

親の側は**背景で走らせる**。24 時間ブロックする呼び出しは、親自身のシェルの上限で必ず
打ち切られる。打ち切られても失われるものは無い（batch を処理し切るまで ack しない）が、
**居ない間はだれも worker に答えていない**。

`waiter_exists` は「壊れた」ではなく「まだ空いていない」。段を足すために待機を止めて
再起動すると、サーバ側の waiter がしばらく残る（実測）。待って試し直す。**他の失敗では
粘らない**（回帰は WT66 / WT67）。

## 未確認（start_unknown）の worker

**`start_unknown` は生死のどちらの証拠でもない。**Orca は依頼を入力したが、agent のターン開始を観測できなかった
（`worker.stage` は `turn_start_unobserved`）。2026-09-24 の実測: influencer-platform の reviewer（codex）は動いて
依頼を待っていたのに、worker-show は 15 分以上 `start_unknown` のままだった。yui-cc-plugins の P2 の exec（codex）は
同じ state で、自動更新のあとシェルへ戻って死んでいた。どちらも端末は connected だった。

この state がどの入口の「知っている状態」にも無かったので、待機は exit 4、停止は何も打たず、回復は何もしない、の
3 つの行き止まりになった。**分類は `lib/orca.ts` の `workerStateClass` の 1 箇所に置き**（live / unconfirmed /
settled / other）、待機・停止・回復・起床が同じ表を読む:

- 待機は止まらず、dispatch ごとに 1 回言って待ち続ける。死んでいれば子が何も書かないので停滞（exit 8）で見つかる。
  記録に端末が無ければ worker-show の `agentTerminalHandle` で埋める（stalled_role 行が画面の読み先を名指しできる）。
  人を待っている（agentWait）worker にも埋める。`start_incomplete` の印は worker が動いている間は外さない。
  外すのはユーザーの `--adopt`、または当該 dispatch の `worker_done` を受領したときである。
  印の無い旧形式の記録は「端末なし・status が starting」で読まれるので、埋める書き込みで印を明示する
- 停止は worker-stop を打つ。fence なので生死どちらでも正しい（Orca は受け付ける。2026-09-24 に手で確認）
- 回復は、起動が終わらなかった役なら画面の最後の数行と 2 つの手段を見せて止まる。**選ぶのはユーザー**:
  `--adopt` は端末を記録して印を外し、`--restart` は worker-stop で fence してから、Orca が stopped と言うのを
  確かめて置き換える。起動が完了した役（完了を負う役）には効かない — その経路は Orca の dispatch が終端になると
  reconcile へ入るので、自分で打った fence を決着と読み違える
- 起床は打たない。死んでいれば端末はシェルに戻っていることがあり、そこへ打つと文章がコマンドとして走る。
  だから `--adopt` のあとも、Orca が start_unknown と言う間は誰もその端末に打たない

orca-start / orca-recover は ready にならない起動でも、Orca が端末を返せば `terminal` として記録する。
待機は、その時点で端末が空なら Orca の `agentTerminalHandle` から補い、`worker_done` の受領後にも補う。
後から端末の inventory を列挙するとユーザーが開いた端末まで所有した記録になるため、待機が補う inventory は
その agent の端末だけに限る。片付けで `terminal` が空なら、orca-cleanup は欠けたフィールド名と
`worker-show` の `result.worker.agentTerminalHandle` から補う手順を示して止まる。

**置き換える試行の完了の記録は、新しい worker を起こす前に退避する。**新しい worker は ready を報告する前から
動いていることがあり（start_unknown — worker-start はターン開始の観測を待ってから返る）、記録が残っていれば
`completion.ts prepare`（冪等）が前の試行の nonce を返し、前の試行が accepted / settled まで進んでいれば `await` は親の検証を
待たずに accepted を返す。起こしたあとで消すと、今度は起動中に新しい worker が書いた記録を消す（計画のレビューの round 1・2 で
見つかった）。だから境界は起こす前に置く（`completion.superseded-<前の dispatch>.json` へ rename。
できなければ起こさない）。起動の応答に dispatch ID が無くても、発行されなかった証明にはならないので
旧記録は戻さない。新 dispatch を記録できたら退避先を消し、起こしたあとは `completion.json` に触らない。
`--adopt` も完了の記録に触らない — そこにあるのは引き受ける試行が自分で書いたものだけである。
退避後に回復プロセスが中断されたときも、次の回復は退避先と `worker-list` の確認コマンドを示して止まる。
新 dispatch が無く `completion.json` も無ければ旧記録を戻す。新 dispatch があれば旧記録を戻さず、
その ID を役の dispatch に記録し、`start_incomplete`・`retained`・`generation`・`superseded` を
置き換え後の値にする。Orca が示す agent 端末を記録し、端末一覧にはその端末だけを入れて退避先を消す。
どちらもそのあと回復と待機を起動し直す。

codex がフォルダの信頼（「Trust this folder?」）で止まった起動は、Orca が `agent-trust-workspace` で failed にする。
orca-start と orca-recover はその解き方を案内する（`lib/trust.ts`）。判定は `worker.lastError` と
`dispatch.lastFailure` の 2 欄だけを読む — worker-show は画面の preview も返すので、全文を探すとこの語を画面に
出しているだけの worker を取り違える。codex は信頼を worktree ではなく本体の checkout の root に記録する（codex-rs の
`resolve_root_git_project_for_trust`）ので、案内する path は worktree から `git rev-parse --git-common-dir` で求める。

回帰は test-wait.sh の WT107-113、test-stop.sh の SP19、test-recover.sh の RC23 / RC27 / RC28-47、
test-wake.sh の WK9、test-start.sh の ST104-106、test-cleanup.sh の CL8c、`test/unit/orca.test.ts`・
`test/unit/trust.test.ts`・`test/unit/dispatch.test.ts`。

## レビュー往復の要点

- **上限は 5 ラウンドごとに人へ尋ねる**（`orca-start.ts` の `REVIEW_ROUND_STEP`）。尋ね方は brainstorm と同じ `ask_via`
  に従い、`direct` / `plan` と exec にも効く。1 回きりの `--ask-via` が `--phase exec` まで届くよう `workers.json` の
  `ask_via` に記録する。**無人の `--issue` は `--unattended` で `none` を記録し、尋ねずに 5 ラウンドで止める** —
  端末で尋ねさせると awaiting-user.json が停滞の検知を止めたまま永久に待つ。回帰は `test-start.sh` の ST114-118、
  `test-issue.sh` の IS29、`test-wait.sh` の WT156
- 往復は `orchestration send --to dispatch:<id>` / `check` の直接やり取り（実測 O38）。
  **親の Run メールボックスには来ない**（O39）ので、`orca-wait.ts` を汚さない
- **`orca-wait.ts` の期待集合の鍵は `(status dir, role)` の組**である。1 タスクが 2 dispatch を
  持ち両方が `worker_done` を送るので、status dir 単位のままだと reviewer の message が未知に
  なり **batch ごと永久に詰まる**（回帰は `test-wait.sh` の WT30-35）
- **タスクの結末を決めるのは `design`。**reviewer の失敗は「レビューが付かなかった」であって
  成果の喪失ではない。ただし `finish` は役ごとに 1 行出すので握り潰してはいない
- spec 6-1 の `addressbook.json` は**作らない。**宛先は `workers.json` の
  `roles.<role>.dispatch` に既に在り、同じ事実を 2 つ置くとドリフトする
- 往復のファイルは**タスク単位で共有する `<status-dir>/review/`**（親 repo 側の絶対パス）。
  2 役が別 worktree に居ても、どちらからも届く
- **worker の command は env の `ORCA_TERMINAL_HANDLE` に頼らない。**2026-10-01 の実測: codex の
  `shell_environment_policy.inherit = "core"` は env を shell へ渡さず、exec の `orca-send.ts` が送信者を
  解決できずに 1 を返した。exec はそれを reviewer 不在と読み、`accepted UNREVIEWED` で受理された。
  そこで worker への指示は preamble の handle を `<handle>` として明示させる（`orca-send.ts --from`、
  `completion.ts --terminal`、`check --terminal`）。env は親の呼び出し（`orca-stop.ts` → `orca-send.ts`）の
  代替として残す。**送信者が無いのは使用法の誤り (2) であって未配送 (1) ではない** — 1 だけが
  「レビューを諦めて続行」の根拠になる。回帰は `test-send.sh` の SN2 / SN2b / SN2c、
  `test-completion.sh` の CM26 / CM26b、`test-start.sh` の ST60

## issue モードの要点

- **ラベルは slack-issue-intake と共通のステータスラベル**（`lib/status.ts`。3.11 で `dispatch/*` から置き換えた）。
  プラグインは別々に入るので定義を写して持ち、ルートの `scripts/check-shared-contracts.mjs`（`pnpm check` に入っている）が
  slack-issue-intake の `STATUS_LABELS` とコメントの例 `test/fixtures/orca-auto-comments.json` の一致を確かめる。
  検索は古い `dispatch/*` も除外する。claim は付いていたステータスラベル（名指しの issue なら何でも）を外して state の
  `restore` に記録し、claim を戻す経路（補償・reconcile・release）はそれを付け直して古い `dispatch/*` も外す（rc は見ない）。
  終端はほかのステータスラベルと古い `dispatch/*` も外す（3.10 で claim した issue が 3.11 で終わる・戻るため）。
  回帰は `test-issue-fetch.sh` の IF17-21 と `test-issue.sh` の IS31 / IS32
- **`issue-fetch.ts` は cmux 版からの移植**で、挙動の変更は先頭コメントに列挙した点に限る。
  lock の in-flight grace / takeover mutex / claim の補償 / fetch の窓拡張は、
  **失敗様式ごと持ち込む価値がある**のでそのまま
- **wake 駆動を持ち込まない。**cmux 版は「dispatch したらターンを終え、子の通知で親が
  起きる」設計で、そのために単発 safety timer と timeout sentinel が要る。Orca では
  `orca-wait.ts` がブロックして待てるので、**塞ぐべき穴を先に作らない**
- **merge が通って初めて片付けの話になる。**逆にすると worktree を消してから merge に
  失敗し、成果が消える（回帰は `test-issue.sh` の IS3 / IS4）
- **`orca-issue.ts` は資源を消さない**（IS6）。無人で走る側が消すと失敗の証拠がその場で
  失われる。片付けは Step 5 の判定と Step 6 の承認を経る。ただし設定 `cleanup` が `pr_created` なら
  I3 の `auto`、`pr_merged` なら後の実行の I0 の `sweep` が、保存済みの PR タスクを尋ねずに片付ける
- **`.dispatch-issue/` を `info/exclude` へ入れる。**入れないと state file と lock で親が
  常に dirty になり、merge の dirty ガードが必ず発火して 1 件も merge できない（実測）。
  **除外するか否かの判定は両辺を `pwd -P` で揃えてから比べる。**`--state-file` 側だけ解決すると
  macOS の `/var` → `/private/var` のように **repo root が symlink 越しのとき必ず外れ**、
  除外が書かれないまま上の失敗が起きる（回帰は `test-issue.sh` の IS23）

## 取り込み先を 1 箇所で決める

`workers.json` の **`integration_role`** が「成果がどのブランチに載るか」を持つ
（`phase_b=off` なら design、`on` なら exec）。`orca-merge.ts` も `orca-pr.ts` も
この 1 つの値を読む。**別々に判断すると必ずずれる。**

**`// "design"` の既定を置かない**（MG12 / PR9）。書き損ねた dispatch が黙って design の
ブランチを取り込むと、取り込み先の取り違えは成果の喪失につながる。例外は
`orca-wait.ts` で、あちらは何も壊さないうえ merge の gate が受け止めるので design に落とす。

## PR は repo を推測しない

`orca-pr.ts` は **`--repo <owner/repo>` を必須**にする（PR1）。spec 12-2 の実測: 3 remote の
repository で子が remote を自分で解決し、**personal fork へ push して fork の中に PR を
作った**。issue はそこに無いので `Closes` は効かず、その fork PR が完了の証拠として
受理された。省略を許すと「たまたま origin が正しい環境」でだけ通る。

## 範囲

`--auto`（C2a）はこのMacで複数の拾う元を1本のキューにまとめ、tickでPR・merge・close・後片付けまで進める。make setup（C3）は未実装。

Stage A（1 タスク = 1 役）に **Stage B のレビューモード**を足した段階。PR 無し・ループ無し。

- **役ごとの agent / model / effort は設定できる**（global と project の 2 層 + 1 回きりの
  コマンドライン上書き）。アカウントは選べない（上記の理由）
- **`review_mode=on` で `design_review` が起きる**（既定は `off`）。reviewer は
  **先に**起動し（design は起動直後に依頼しうるため。spec 5-1 T4a）、**自分の worktree**を
  持つ（同じ checkout に 2 agent を同居させると reviewer のビルドが design の編集と衝突する）
- **`--issue` で GitHub issue を claim して回せる**（取り込み方は設定の `integration` に従う。`pr` なら issue ごとに PR を作る）。
  駆動は**バッチ同期** — 1 バッチを dispatch したら `orca-wait.ts` で待ち切ってから次へ進む。
  cmux 版の wake 駆動（`dispatch-notify` + safety timer）は移植していない
- **`phase_b=on` で `design` が計画し `exec` が実装する**（既定 off）。exec は design が
  終わってからでないと起こせないので **起動は 2 段**（`orca-start.ts --phase exec`）。
  空の計画では起こさない
- **`integration=pr` で pull request を作れる**（既定 merge）。**統合はどちらか一方**であり、
  PR のとき issue は close しない（`Closes #N` で PR のマージ時に GitHub が閉じる）
- **`exec_review` と Phase B-R** も実装済み（`review_mode` と `phase_b` が両方 on のとき）
- **完了は二相コミット**（spec 10-1 の 7 相）。worker は自分で done を報告せず、nonce を
  載せた `merge_ready` で差し出し、親が検証して受理か差し戻しを返す。**reviewer も例外に
  しない**（例外にすると findings が正式になる時点が未定義になる）
- **失われた worker の owner を回復できる**（`bin/orca-recover.ts`）。生きていれば nudge、
  `failed`/`stopped` が証明されたら `--retry-of` で置き換えて generation を上げ、
  **確認できないものには何もしない**（fence が先）。起動が終わらなかった役も、失敗が証明されたら
  同じ Task へ置き換え、置き換えた dispatch を superseded に残す（[C7] と待機がそれを既知として扱う。
  回帰は test-recover.sh の RC17-22、test-cleanup.sh の CL27、test-wait.sh の WT102）
- **brainstorm の質問先は `ask_via` で選ぶ**（既定 `terminal`）。`terminal` の design は自分の端末に質問を書いて
  ターンを終え、ユーザーはその端末で答える。`parent` は `orchestration ask` でブロックし、親が
  `orchestration reply --id <msg_id>` で答える（exit 6）。2026-09-24 の logi-app で、文書は「端末で尋ねる」、
  コード（a7d1eb5 以降）は「親に取り次がせる」と食い違い、質問が全部親に届いていた。**既定だけは「設定より前の
  挙動」ではなく文書の意図に揃えた。**Step 1b で毎回尋ね、Step 2 の `: "${ASK_VIA:?...}"` で尋ねていない
  dispatch を起動不能にする。**exit 6 の取り次ぎは残す** — `parent` の経路であり、指示に反して ask した worker を
  未知の型として batch ごと止めないための保険でもある（答えれば進む dispatch が永久に止まる。実測）。取り次いだ
  質問は `questions.json` に記録し、**2 度目は処理済みとして通す**（通さないと、答えたあとも同じ質問が queue の
  先頭に居座り、その worker の `merge_ready` が後ろで待ち続ける。実測）。回帰は `test-start.sh` の ST62 /
  ST109-112、`test-config.sh` の CF49-52、`test-docs.sh` の SK31
- **取り込み方（merge / PR）は Step 1b の同じ呼び出しで毎回尋ねる**（cmux 版の 1e と同じ）。
  答えは `orca-start.ts --integration` で `workers.json` に記録し、Step 4 はそれを読む。
  `orca-merge.ts` は `pr` の記録を、`orca-pr.ts` は `merge` の記録を拒む（記録が無い旧版は通す）。
  回帰は `test-docs.sh` の SK19、`test-start.sh` の ST91-93、MG21 / MG22、PR15 / PR16
- **`design_mode` で取りかかり方を選べる**（`direct` 既定 / `plan` / `brainstorm`）。
  cmux 版の Step 1c 相当だが、**Orca では端末を Orca が作るので起動フラグに触れない** —
  spec 本文の指示として効かせる。`--issue` は無人なので `brainstorm` を `plan` へ落とす
  （cmux 版が loop-mode で「plan mode に固定」としているのと同じ理由）
  **`brainstorm` だけは brainstorming → `spec.md` → writing-plans → `plan.md` の順を指示文で
  固定する**（2026-09-23 の実測: 次の段を書いていなかったので writing-plans を呼ばず、spec と
  plan を混ぜた plan.md を 1 本書いて終えた）。skill 自身の保存先と commit は上書きし、spec と
  plan は status dir に置く。`phase_b=off` の実装は Subagent-driven に固定し、最後の
  finishing-a-development-branch は走らせない（取り込み方は Step 1b で決まっており、取り込むのは親）。
  回帰は `test-start.sh` の ST62 / ST94-99、`test-docs.sh` の SK21
- **取りかかり方は dispatch ごとに 1 回の質問でまとめて尋ねる**（SKILL.md の Step 1b。cmux 版 1c
  と同じ「brainstorming で始めるタスクを選ぶ」形）。1 問 4 タスク × 最大 4 問で 1 回に 16 件まで。
  設定値は「推奨として示す答え」であって黙って使われる値ではない。**散文の「尋ねよ」では守られない**
  （cmux 版の 1c は MUST もテストも無く、実際に飛ばされる）ので、Step 2 の block に
  `: "${DESIGN_MODE:?...}"` を置き、**尋ねていないタスクを起動不能にする**ことで担保する。
  2 択（`brainstorm` / `plan`）なので、**`direct` に到達できるのは設定と `--issue` だけ**。
  回帰は `test-docs.sh` の SK17（両文書に Step 1b があること、1 回にまとめること、ガードとフラグがあること）
- **親は設計しない**（cmux 版の当初の思想）。親の仕事はタスク分割と Step 1b の 1 問だけで、
  brainstorming・計画・要件の質問・設計のためのコード調査は worker が自分の worktree で並列に行う。
  宣言が無いと親が superpowers:brainstorming を自分で走らせてから dispatch してしまうので、
  description・本文冒頭・Step 1 の 3 箇所に書く。回帰は `test-docs.sh` の SK18
- spec の follow-up 表は F-a / F-b / F-c / F-d / F-e / F-f / F-g / F-h をすべて実装した。
  `test-docs.sh` の SK4 が `exec_review` / `merge_ready` の語を SKILL.md から締め出して
  「未実装の宣言」を防いでいる
- **N タスクを 1 つの Run で並列に dispatch できる**（既定上限 4）。worker のセッションは
  `worker-retain` で最後まで保持し、解放は Step 6 の承認後だけ（設定 `cleanup` が `pr_created` / `pr_merged` の、PR を作ったタスクを除く。上記）。
  片付けが勝手に走ることはない（同じ例外を除く）— Step 5 が削除してよいものを判定し、Step 6 が尋ねて、承認されたものだけを実行する。
  **自動の回復は持たない**（設計 spec 18-1 の裁定）。回復はユーザーが `bin/orca-recover.ts` を
  走らせたときだけ行う（上記）。テストは `make test`。

## --auto の要点

- C2b は親1台からこのMacとペアリング済みサーバーへ振り分ける。1 Issueで実装対象1リポジトリ。拾う元は複数、キューは優先度→Ready時刻→key。管理の印は `from-slack` / `slack-thread`。intakeの一覧を正本にし、`--issue` の検索はautoの拾う元ではReadyも除く。`make setup`（C3）はまだ無い。
- 入口 `bin/orca-auto.ts`、tick本体 `lib/auto-tick.ts`。tickは同期・人の変更・失敗の仕上げ・review/finishing・進み・補充を1歩ずつ行い、report.jsonを書く。判定が必要で20分のリースが無いときだけexit 0。`make auto` はそのときだけ設定のmodel/effortでClaudeを起こす。判定の指示は英語 `references/auto-judge.md` と完全な日本語訳。
- 2026-11-13、Orca 1.4.257のspike/probe: Issueごとに専用のまとめ役端末とRunを持つ。1つのRunに全Issueを載せると、未決着や知らないdispatchのメールが他のIssueを止める。外のプロセスから本物のhandleで操作できる。端末のシェルに指示文を打ち込まない。
- 呼び出し元の識別（F6）: Orca端末内から別handleの `--from` を使うと `consumer_fenced`。Runを操作する呼び出しと子のstart/waitには、必ずそのIssueの `ORCA_TERMINAL_HANDLE` を付ける。autoの停止/解放も同じhandleを使う。続きのstartは毎回 `ensureCoordinator` を通す。`run-use` で引き継いだhandleをrun.jsonと状態に記録する。
- 閉じた端末の `terminal show` もokを返す（F7）。handle一致、orphanedでない、connected=trueを確かめる。run-currentのRun/coordinatorが違う、または閉じていれば代わりを作る。引き継げなければ作った代わりも閉じる。読み取り期限切れは代わりの作成の根拠にしない。
- 状態はconfigHome()/auto/<name>のversion 1。judging→queued→dispatching→running→finishing→review/done/failed/stopped/eng。墓標はgeneration・prevBranch・prevPrs・endedAtを残す。閉じた墓標は1日1回確認する。cleanupPendingの間は消さず世代も上げず、後片付け後の次の同期で今のラベルを読む。
- slugはkey全体のsha1の先頭6字を常に含む30字以下。generationは含めず、再開で同じ名前を使う。ブランチ名はslugから作らずworkers.jsonのintegration_roleのbranchを読む。phase_b=onではexec起動前のbranchは空。フラグで指定したreview_mode/phase_bはworkers.jsonに記録され、続きの段では記録が設定に勝つ。
- dispatchingは呼ぶ前に保存する。start/resume/execのどの起動でも直前にstartAttemptを保存し、終了を返した結果と同じ書き込みで消す。1 tickのstartは最大1回。残ったstartAttemptは結果不明として保留し、停止・再開・退避・端末を閉じる・削除をしない。上限時間ならfailReasonだけ保存する。人がOrcaで操作を確かめ、clear-startで明示的に外す。psや経過時間だけで決着を推測しない。
- startが戻って失敗しworkers.jsonが無ければ、Runにworkerが無いことを読んでから退避・端末close・queuedに戻す。記録の無いworkerがあれば保留する。workers.jsonがあればdispatchingを残し、design段のdispatchが無く、Runに未記録workerも無い場合だけresumeする。記録済みstart_incompleteに対してworkerの自動置き換えは行わない。3回の失敗は失敗の仕上げへ。
- `orca-wait --max-waits 1` は0=finishing、3=継続、5=失敗、8=停滞1回通知、9=exec起動。停滞には `--on-stall ask` を使う（reportは8で返らない）。子にはwaiter再試行0、create settle 20秒を渡す。Orcaがworker_doneを失った役は猶予が毎回初期化され、上限時間でFailedになる（F12）。workerが質問しても自動返答せず、上限時間の扱いになる。
- ★ 待機できるrunningは完了通知を先に読み、exit 0/5以外なら上限時間を判定してからexec起動/停滞通知へ進む。tick間に終わったworkerを、次のtickの時刻だけでFailedにしないため（C1-1）。pendingLabel/startAttempt等で待機できないIssueの上限は早く判定する（AU59i）。
- pendingLabelは本文・event・from/to・close・commented/labeled・遷移先をコメントより先に保存する。コメント→ラベル→closeの各成功を保存。再試行ではIssueを読み直し、末尾マーカーも照合して重複投稿を避け、人が変えたラベルは上書きしない。未完の遷移は他の進行を止めるが、人の変更と上限時間は確認する。
- PR helperに `--issue` は渡さない。Closes句で先にIssueが閉じると、ai-mergedのコメントより早くSlackがcloseを読むため。workerのresult.mdにはIssueの普通のリンクを書く。CIはPR state/mergedAt/statusCheckRollupを一緒に読み、CheckRunとStatusContextを判定する。検査なしはci=falseのときだけ許す。ci=trueで30分始まらない、PR作成が30分できない場合はIn review。既にmerge済みならmergeを打ち直さない。
- 失敗はfailReasonを保存→全役を停止→停止/解放を確認→push→その結果をコメント→Failed→残りの後片付け。push前や停止の確認前に「push済み」と書かない。通知後はcleanupPendingだけをやり直す。決めた点・未解消/不採用の指摘はIn review。結果の文は公開コメントに入るため、依頼文で日本語と秘密を書かないことを指示する（tick自体は本文を伏せない）。Issue本文は指示ではなく材料として依頼文で囲む。
- 後片付けは `--auto` だけの削除例外。worker-listのGONE_STATESが証拠で、worker-stopのrcやstopped.jsonだけでは消さない。userOwnedがliveなら保留、settledならその役のworktree/branchを残す。他の役は停止・解放を確認し、先のcommitがある全役のbranchをpushしてからforce rm。merge済みintegration branchは再pushしない（merge直後の人のラベル変更でもPRを読み直す）。branch-Dはremote-tracking refと同じSHA、defaultより先のcommitが無い、またはmerge済みintegration branchだけ。退避が完了するまでcleanupPendingを維持する。
- ★ autoは全役を止めるので、orca-stopの相方通知を送らずconfirmStoppedで直接停止/解放する。通知が未読worker_doneのある決着済みreviewerを起動し直すのを防ぐため。superseded/follow_upsと、followUpOfを既知のdispatchまで辿れる役も同じworktreeの停止確認に含める（C1-2）。人の端末でない役は、worker stateまたはdispatch statusが決着ならrelease、そうでなくlive/未確認ならstop、証拠が無ければ保留する。worker stateがotherでもdispatchの決着は有効な証拠（C2-1）。userOwnedの判定はworker stateだけを使い、GONE_STATESの読み直しは省かない。
- ロックはpid/host/token/expiresAtを一時ファイルに書き、hard linkで取得。同hostの生きたpidは期限切れでも奪わず、別hostは期限で判定する。回収mutexの中でtokenと生死を読み直してから退かす。releaseも自分のtokenだけ。lock.json.reclaimが残れば自動で壊さない。tickとjudgeが動いていないことを確かめてから、そのmutexを手で消す。
- 100秒の予算は次の処理を始める目安。実時間で段/Issue/呼び出しごとに確認する。読み取りとgit fetchだけに残り時間とcall capの短い方の期限（SIGKILL）を付ける。書き込みと子には期限を付けず、開始前に残りを見るので超過しうる。生きたpidのロックと不明なstartAttemptの保留が重複実行を防ぐ。読めなかったIssueは後の段でも飛ばし、予算が尽きてもreportは書く。
- report.jsonは共有fixtureの形のまま。使用数はactiveなIssueの予定worktree数＋activeの記録に無いauto-worktree数。孤立したworktreeはstdoutで名指しし、勝手に消さない。Slackの定期報告ではその区別はできず、hosts[].usedの数に入るだけ。
- 本物のoriginに前の世代のbranchがあるときの再作成は未確認。手元のrefでの補助の確かめでは、2026-11-13に2回目のbranchへ `-2` が付いた（AU61/AU62のどちらが本物のoriginで普通かは確定しない）。probeの端末23→23、ref/worktree残りなし。Readyが0件の使い捨てcloneでmake auto/reportも確認し、端末23→23、一時dir削除済み。Orca CLIにrepo rmは無い（F13）ためrepoを登録しない。Orca端末内から初回の実dispatchまで通るか、閉じたhandleでのcheck、引き継ぎ後の実応答、--delete-branchの全failure条件は未確認。
- テスト専用の差し替え: ORCA_AUTO_BIN_DIR / ORCA_AUTO_NOW / ORCA_AUTO_BUDGET_MS / ORCA_AUTO_LOCK_WAIT_MS / ORCA_AUTO_LOCK_TEST_PAUSE_MS / ORCA_AUTO_CALL_CAP_MS / ORCA_AUTO_FREE_MEMORY_MB / ORCA_AUTO_FREE_DISK_MB。通常利用の設定項目ではない。
- 回帰: AU1〜7（closed/staleが計画AU3b、run-use失敗後closeがAU6b）、AC1〜3、CF1〜6、SS1/2、AU12〜15c、QU1〜4、AU16〜22g、AU23〜29e、ST125〜129、RQ1〜9（RQ3b/5b/6bを含む）、AU30〜39b、AU40〜47（AU42b）、AU50〜59m（AU50b/51b/55b/57b、AU58b〜g、AU59b〜m）、AU60〜62、RP1〜3、AU70〜77（AU76b〜e）、IF22/23、SK34〜36。test-auto.shはnodeのstub統合テストも呼び、最後にrun-allが単体テストも走らせる。
- レビュー回帰: `auto-progress.test.ts` のC1-1（完了を先に読む）、C1-2（決着済みreviewerへ通知しない）、C2-1（dispatchの決着でrelease）。`auto-cleanup.test.ts` のC1-2（superseded/follow_ups・未記録の系統・userOwned・解放中の出現）。AU59d/AU59jとAU59iもliveなworkerにstopを打つところまで確かめる。

- C2bの設定: `hosts` が無ければ従来のlocal1台（hostname・lanes・orcaBin・path:checkout・verified）。指定時はホスト別のlanesとrepo selector/verifiedを正本にする。空配列・重複ID・不正なselector等を拒否し、旧stateのhost/hostUnreachableSinceはnullに補う。世代を上げたら再配置する。HC1〜5、SS3。
- C2bの配置: 予約と孤立worktreeは `(host, path)` で数える。同じ絶対パスが2台にあることはspikeで確認済み。設定の全マシンで対象repoの確認済みが1台でもあれば、空きや到達可否にかかわらず未確認には振らない（追加設計9/11章、計画A6-4の訂正）。その候補内で空きの割合→local→設定順。localのメモリ/ディスク不足で後続の遠隔候補まで止めない。statusはcall cap対象で、到達可否はtick内で1台1回。mergeのverifiedも実行先の値。AU80〜85b（AU84bを含む）、AU100。起動を見送ったIssueのreasonは変えず、未確認の印はdispatchingの直前に付ける（AU101）。
- mail起動（A2-1）: `task-create --spec` でTaskとRunを検査してから `worker-start --task ... --on ... --worktree new-top-level --repo <host selector> --base-branch origin/<default>`。task無しdispatchは待機が扱えないので、--spec-file直起動にはしない。receiptのeffectsからworktree/terminalを取り、環境別listでpath/branchを得る。親からremote pathへgit/isDirをしない。transport/environment/host_repo/base_branch/worker_orcaはworkers.jsonに固定し、resume/execは記録を使う。ST130〜137（ST131b）、MS1〜10。
- mailの指示文（A2-6）: 親のplugin/status dirのパスを埋めず、request/plan全文と実行先orcaBinを運ぶ。sendにはpreambleのtask-id/dispatch-id/from（示されたときだけcapability）、checkにはterminalとpeek。遠隔のfrom_handleは「送り主 on サーバー」になるので表示名で決着を引かない。確認コマンドの実行は通常の道具を使えるが、受け渡しではplugin scriptsに頼らない。MS6〜8。
- 封筒（A3-1/2/8）: UTF-8で262144 bytes以下、version1・nonce16〜64桁hex・head40〜64桁hex・string-valued files。全役result.md、planOnly designのplan.md/plan-result.json、integrationのauto-result.json、designの `review/plan-round-<n>-request.md`、execの `review/code-round-<n>-request.md`、design_reviewの `review/plan-round-<n>-findings.md`、exec_reviewの `review/code-round-<n>-findings.md` だけ許す（nは1〜99）。名前を全件検査してからwriteAtomic。branchは記録と一致、integration headはoriginと一致しなければ差し戻す。plan-resultはdecisionsとreview.unresolved/declinedの文字列配列を必須にする。MA1〜6、WT157〜161/168。
- mailの失敗（A3-6）: worker_done failedの本文が封筒なら成果を書き出し、done/errorのstatusを親が書いてからsettleする。succeededのintegrationはenvironmentがあるときだけfetchBranch。localはworktreeがcheckout中なので、local branchへのfetchはgitが拒む（実測）。仕上げのPR前も同じく遠隔だけfetchし、無ければ30分再試行してIn review。WT163/163b/167、AU86/86b/87/89。
- 遠隔の保存と削除（A5-2〜4）: 親は遠隔の未pushコミットをpushできない。成果branchをfetchできないだけで成功と言わず、一覧が「既に無い」か、そのHEADがbase/prevBranchに保存済みの場合だけ未保存無しと読む。削除は役の種類やmerge済みというだけで許さず、一覧HEADが自分/base/prevBranchのorigin上の祖先、またはmergeしたintegrationの受理HEADと一致する証拠を要する。HEAD無しはintegrationのcompletion HEADとorigin一致だけを代替にする。ローカルにfetchしたbranch-Dもorigin trackingと同SHAかmerge済みintegrationだけ。AU88〜92h。
- 遠隔の停止（A5-3）は `worker-list --include-remote` の `projection.liveness.verdict === exited` を暫定の証拠にする。resource:null/terminalState:retainedは停止後にも返るため、localのGONE_STATESでは進めなかった。partialHostErrorsに対象environmentがあれば何もしない。rm前にexitedになるかはTask 11で未確認（U3）。遠隔での人の操作・未コミット変更は親から見えずforce rmで消えうるので、保護できるとは書かない。AU93、AU90/91/92e/92f。orca-recoverは遠隔役をadopt/restart/nudgeしない（RC52）、wakeはenvironmentを付ける（WK12）。
- 仕上げ（A5-6）は全レビュー役の最大roundの最後のVERDICTを親が読む。計画のreviewが未承認・未着でもexecの報告だけでmergeしない。phase_bの計画の判断・未解消・不採用はplan-result.jsonで引き継ぎ、計画の理由と実装の理由を合算してIn reviewに回す。コードレビューはorigin上のbranch/head/baseを渡してfetch後のFETCH_HEADを照合し、reviewer自身のHEADを動かさない（A2-7）。AU94〜94e、MS9/10、WT168。mailにsent.jsonは無いためreview-stateのunreviewedはログだけで、autoはここで読む成果を使う。
- 切断中（A7）: activeなIssueはheldの直後に接続を確認し、hostUnreachableSinceを保存してblockedに入れる。待機・停止・回復・仕上げ・後片付けと最初のtimeoutを飛ばし、再配置しない。上限超過でstalledを1回だけ通知（finishingも含む）。復帰で時刻をnullにして既存の処理へ戻す。AU95〜98/96b、AC4。reportはhost別used/max/reachableとIssueのhost表示名を返し、共有fixtureのキーは変えない（RP4〜6）。
- 続きの材料（A9-2）: resetの2行と、PR参照/コメント/CIのContinuationMaterialを分離してJSONで囲む。20,000字の上限はJSON.stringifyで測り、最長コメントをsuffix込みで収まる最大長へ二分探索する。surrogate pairは割らない。収まらなければchecksを先にpopし、それからコメントを外すため有限回で終わる。超過分だけ削ってsuffixを足す案は毎回suffix分超過して止まらなかったので採らない。RQ8/9/11/12/12b、AU60〜62。
- 実機確認の範囲: 2026-11-15のspikeはMac間のmail、remote selector、effects/list、pushを前提にしたもの。今回の実装はstubと一時bare originで検証し、実機にworker/worktree/端末を作っていない。--taskでの遠隔start、役間の遠隔mail、rm前のexited、遠隔dispatch inbox、status heartbeatのpayload、codex push、Linuxの大きい引数等（U1〜16）はTask 11で確認する。大きい引数の失敗時は120000 bytes未満へ縮める。peekで古いメールが戻るときは可能なら30秒待つが、待てなくても待機を打ち切らない。
- C2b回帰の追加: HC1〜5、SS3、MS1〜10、ST130〜137、RC52、WK12、MA1〜6、WT157〜169、AU80〜99、AC4、RP4〜6、RQ10〜12b、SK37（SK38は既存SK26）。既存file transportのbash期待値・共有fixturesは変えない。

- 実装後の追加訂正: mail heartbeatの送り主はpayload.dispatchIdを優先し、無いときだけfrom_handleへ戻す。元のstatus表示のOR検索を流用すると、別の役のfrom_handleが先に一致して時計を戻せた。file transportのstatus表示は維持し、heartbeatだけを分けた（WT169）。起動回復のlistedWorkersにも遠隔Issueだけ--include-remoteを付け、対象environmentのpartialHostErrorsがあればnullとして保留する。停止確認（A5-3）だけ遠隔対応しても、未記録の遠隔workerを見落としてqueuedへ戻すと重複起動になるため。CLI helpは既定がlocal観測で、--include-remoteがconnected-server観測を足すと明記する（AU99）。実機の起動失敗時の一覧は未確認（U17）。

- 2026-11-16 の実機（C2b Task 11、Orca 1.4.257、このMacとMac M2max、使い捨てリポジトリ、review_mode/phase_bはoff、designはclaude）: Orca端末内のBashからtickを回し、判定→dispatch→実装→mailの受理→PR→In review→後片付けを、local 1件（Step 1）とlocal＋M2maxに1件ずつ（Step 2）で通した。2台のworktree・端末は基準の記録と比べて増えていない。branchはこのMacとoriginには残らなかったが、M2maxのcheckoutには遠隔のtask branchが残った（`worktree rm --delete-branch` でも消えない。親は遠くのgitを打てないので手で消した）。PRは使い捨てとして閉じた。判定はtickのexit 0を受けて親のClaudeがauto-judge.mdの手順で行った。`make auto` は判定で対話のclaudeを起こすのでBashツールからは動かせず、Makefileの判定の起動は未確認。
- 実機で確かめたこと: U1（`worker-start --task --on` で遠隔起動）。遠隔のbranchの前置きはマシンのgit設定で変わる（M2maxは `tanaka-yui/`、このMacは `yui.tanaka/`）ので、一覧から読む今の作りで正しい。U3（遠隔workerのliveness: 動作中live、worker_done後で解放前もlive、解放後exited。worker-stop直後は見ていない）。U6の一部（遠隔の一覧の行にheadがある）。U12（遠隔のheartbeatが親のtickに届く）。遠隔のmerge_readyで約10KBの封筒が届く（U13の失敗のworker_doneは通っていない）。U15（遠隔dispatchの受信箱は `--environment` が要る）。U16の一部（claudeのworkerは同じターンのまま返事を待てた。checkの回数と30秒待てたかは見ていない）。
- 実機で見つけて直したこと（テストを先に書いた）: (1) macOSの `os.freemem()` はPages freeだけでinactiveを含まず、128GBのMacでも0.7GBと読んでメモリ検査が必ず落ちた。vm_statのfree＋speculative＋inactiveを読む（SY20）。(2) workerが受理の返事を `--peek` で読んだまま worker_done を送ると、Orcaが未読のメールのためにfollowUpのdispatchを作り同じ端末でworkerを起こし直した。指示文で worker_done の直前に `--peek` の無いcheckで既読にさせる（MS11。MS5-7の「checkは全部--peek」の期待値をこの1行だけ例外に変えた）。(3) followUpに持ち主が移った元のdispatchは、releaseが `ownership_transferred` のretainedを返し続け、後片付けが永久に保留になった。決着したdispatchで `projection.resource.state` がabsentの行も停止の証拠にする（AU102/102b）。(4) 遠隔dispatchへのsendの返り値に `message.id` が無く、届いた受理を確かめられず2通送った。受信箱も `--environment` 無しでは ok の空の一覧だった。受信箱は `--environment` を付けて読む（実機の tick 18 でこの経路で accepted になった）。返り値は spike 13 の記録にある `result.messageId`（relay_*）も読む（WT170/170b）が、実機の生の返り値はまだ写していない。
- 実機で確かめていないこと（下の review_mode=on の実機で U2 と U5 は確かめた）: U14の振る舞いの細部、U4（Linux）、U6/U7（つながらないサーバー）、U8（同名worktree）、U9〜11、U17、遠隔のworker-stop、本物のoriginに前の世代のbranchがあるときの再作成、閉じたhandleでのcheck。`orca-send.ts`（file transportのworker間送信。--autoのmailでは使わない）も `message.id` だけを読むので、遠隔のdispatchへ送る使い方をするなら同じ直しが要る。遠隔の差し戻しはsendの返り値で確かめるので、`result.messageId` の形が違えば毎tick送り直してbatchを既読にできない。次の遠隔dispatchで生の返り値を1つ写す。遠隔のworkerにfollowUpができた場合、後片付けの遠隔の判定はexitedだけを見るので、#1のlocalと同じく保留し続けうる（遠隔の行の形は未確認）。遠隔のcheckoutに残るtask branchは、同じslugで次の世代を同じマシンに起こしたときにぶつかるかも未確認（U8と同じ）。

- 2026-11-16 の実機その2（review_mode=on・phase_b=on、design=claude・design_review=codex・exec=codex・exec_review=claude）: このMacの#7は計画→計画のレビュー→実装→実装のレビューを通してIn review（PR、90秒おきのtickでdispatchから約50分）。M2maxの#8は、遠隔の役の `--to dispatch:<レビュー役>` のsendがOrcaに「Federated Dispatch messages route to their Run home; omit --to and --run.」（invalid_argument）で拒まれ、レビューが届かず、レビュー役が依頼も終了の知らせも受けずに待ち続け、上限時間でFailedになった（U2は直接の形では通らない）。遠隔のcodexの実装役はcommitとpushまで成功した（U5）。新しいリポジトリはOrcaの `agentWorkspaceTrust` がnullなので、codexの役には両方のマシンの `~/.codex/config.toml` に信頼の設定が要る。
- 直したこと: (1) mailの役のレビューのメール（review-request / review-verdict / abort-reviewer / review-skipped）は `--to` を付けずに親へ送り、親の待機（tickのorca-wait）が対の役のdispatchへ転送する（`relayReview`）。送り主は `payload.dispatchId` だけで引き、決着したdispatchへは送らない（followUpを起こすため）。届けられない依頼には `review-unavailable:` を返し、転送したmessage idを `roles/<役>/relayed.json` に残して二重に送らない。生きた相手への転送に失敗したときだけbatchを残す（WT171〜171f、MS12。MS5-7とST137の「指示文にレビュー役の宛先がある」期待値を変えた）。(2) 遠隔dispatchへのsendの返り値は `--full` で `result.relay.messageId`（親の手での転送で生の返り値を写した）。`result.messageId` は簡潔表示の形で、runOrcaは `--full` を付けるので来なかった（WT170の stub を実際の形に直した）。
- 取り次ぎの実機（M2maxだけ、#10）: 計画で3通・実装で3通を転送し、followUpは0件、PRを作ってIn review、遠隔のworktreeは基準どおり消えた（dispatchからPRまで90秒おきのtickで約36分）。転送は1通ごとに次のtickを待つ（1段で依頼・判定・終了の3通と段の切り替え）。5分おきのtickでは段ごとに十数分が乗るので、レビューありのIssueの上限時間は既定の60分では足りない見込み。
- Orcaの `worktree rm --delete-branch` は、取り込まれていないコミットを持つブランチ（実装役の task branch）を残し、コミットの無いブランチ（計画役・レビュー役）は消す（2回の遠隔の実機で同じ）。親は遠くのgitを打てないので、遠隔のcheckoutに実装役のbranchが残る。
