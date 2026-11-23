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
accounts / terminals。読むだけ）、issue モードの実行の前後は `bin/orca-issue-loop.ts`（start / claim / reconcile /
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
- **bash のテストでパイプの右に `grep -q` を置かない。`grep -c >/dev/null` にする。**どのテストも `set -o pipefail` で、
  `grep -q` は一致で先に終わるので、左の出力が 4096 バイトを超えると左が SIGPIPE（141）で落ち、パイプ全体が失敗になる。
  2026-11-22、Step 1b の節が 4597 バイトになって SK31 が毎回落ち、SK10（複製で `failures: 1` を期待する）も巻き添えで落ちた。
  `-c` は入力を最後まで読む（出力先が /dev/null でも GNU grep は早く終わらない）
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
  端末の release を提示するため）。sweep は `gh pr view --json state,headRefOid <url>` で読み、MERGED の PR では
  (2) を「origin と一致、または手元の SHA が PR の headRefOid と一致」にする（merge で head branch を消す
  リポジトリでも片付くように。merge された PR の head が手元と同じなら、手元の成果は全部 merge 済み）。
  headRefOid が無い・40〜64 桁の小文字の hex でないときは origin だけで判定する。判定に使った head は計画の
  `pr_head` に書き、readPlan は今の手元の SHA と比べ直す（plan のあとに手元の branch が動けば計画ごと拒む）。
  `plan --pr-saved` と auto は head を読まず origin だけで判定する（PR を作った直後は head branch が origin にある）。
  merge のあとの push で headRefOid は進まない（2026-11-17、gh 2.103.0、使い捨てリポジトリの PR を squash merge →
  head branch へ 1 コミット push → head branch を削除。3 回読んでどの時点も `{"headRefOid":"<merge 時の head>","state":"MERGED"}`
  のままで、origin の branch は push 後の SHA だった）。merge 済みの PR の headRefOid は merge の時点の head に固定される。
  回帰は test-config.sh の CF53〜54、test-start.sh の ST138〜140、test-cleanup.sh の CL40〜CL57
  （CL40b/c・CL41b・CL43b〜f・CL44b〜d・CL46b・CL47b・CL48b/c・CL53b/c を含む）、test-docs.sh の SK38。

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

## 端末へ飛ぶ表

**Orca に端末や worktree を開くリンクは無い**（2026-11-20、Orca.app の `orca://` が扱うのは `pair` と
`skills/share` だけ）。そこで飛び先は `orca terminal switch --terminal <handle>` のコマンドで示す。表は
`lib/terminals.ts` の 1 箇所で作り、`orca-state.ts terminals`（Step 2 のあとと進捗の報告）・`orca-wait.ts`
（質問の取り次ぎと端末で答えを待つ役の行）・`orca-auto.ts status` が使う。**handle はそれを発行したサーバーのもの**
なので、workers.json の役に `environment` があれば `--environment` を付ける。端末が記録されていない役には
コマンドを出さない（推測しない）。表は読むだけで Orca を呼ばない — switch はユーザーの見ている端末を変えるので、
親が打つのはユーザーが頼んだときだけ。`report.json` は slack-issue-intake と共有の形なので表を足さない。
回帰は `test-state.sh` の OS11、`test-wait.sh` の WT41c / WT114b、`test-auto.sh` の AU142、`test/unit/terminals.test.ts`。

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
design / exec_review = claude・`claude-opus-5-5[1m]`・max、design_review = codex・gpt-6.2-astra・xhigh、
exec = codex・gpt-6.2-sol・high）。Opus は `opus[1m]` alias だと provider によって古い版を指すので
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

- **上限は 5 ラウンドごとに人へ尋ねる**（`lib/config.ts` の `REVIEW_ROUND_STEP`。`--auto` の取り次ぎの余裕もこの値を読む）。尋ね方は brainstorm と同じ `ask_via`
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

`--auto`（C2a）はこのMacで複数の拾う元を1本のキューにまとめ、tickでPR・merge・close・後片付けまで進める。C3a（make auto-setup）は実装済み。C3b（make auto-setup の遠くの確認・AI の案・測定）も実装済み。道具のインストール・sudo・swap はまだ無い。

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

- C2b は親1台からこのMacとペアリング済みサーバーへ振り分ける。1 Issueで実装対象2リポジトリまで、3つ以上はReady_Eng。拾う元は複数、キューは優先度→Ready時刻→key。管理の印は `from-slack` / `slack-thread`。intakeの一覧を正本にし、`--issue` の検索はautoの拾う元ではReadyも除く。C3a（`make auto-setup`）は実装済み。C3b（make auto-setup の遠くの確認・AI の案・測定）も実装済み。道具のインストール・sudo・swap はまだ無い。
- 入口 `bin/orca-auto.ts`、tick本体 `lib/auto-tick.ts`。tickは同期・人の変更・失敗の仕上げ・review/finishing・進み・補充を1歩ずつ行い、report.jsonを書く。判定が必要で20分のリースが無いときだけexit 0。automation はそのときだけ設定のmodel/effortでClaudeを起こす。**`make auto` は 2026-11-22 に消した** — automation の precheck と同じことを手で 1 回するだけで、開発用の checkout の版で走り、ランチャーの権限の確認を通らず、判定を対話の claude で起こす点で automation とずれていた。手で 1 回だけ回すなら `node bin/orca-auto.ts tick`（判定は次の定期実行が起こす）。`judge-model` / `judge-effort` も `make auto` 専用だったので消した（automation は `--extra-agent-args` で渡す）。判定の指示は英語 `references/auto-judge.md` と完全な日本語訳。
- 2026-11-13、Orca 1.4.257のspike/probe: Issueごとに専用のまとめ役端末とRunを持つ。1つのRunに全Issueを載せると、未決着や知らないdispatchのメールが他のIssueを止める。外のプロセスから本物のhandleで操作できる。端末のシェルに指示文を打ち込まない。
- 呼び出し元の識別（F6）: Orca端末内から別handleの `--from` を使うと `consumer_fenced`。Runを操作する呼び出しと子のstart/waitには、必ずそのIssueの `ORCA_TERMINAL_HANDLE` を付ける。autoの停止/解放も同じhandleを使う。続きのstartは毎回 `ensureCoordinator` を通す。`run-use` で引き継いだhandleをrun.jsonと状態に記録する。
- 閉じた端末の `terminal show` もokを返す（F7）。handle一致とconnected=trueを確かめる。orphanedは見ない（Orca 1.4.259のCLIが作った端末は生きたまま約20秒でorphaned:trueになる。閉じた端末はconnected:false。2026-11-17の実機）。run-currentのRun/coordinatorが違う、または閉じていれば代わりを作り、引き継げたら古い端末を閉じる。引き継げなければ作った代わりも閉じる。読み取り期限切れは代わりの作成の根拠にしない。AU2b/AU5b/AU6。
- 状態はconfigHome()/auto/<name>のversion 1。judging→queued→dispatching→running→finishing→review/done/failed/stopped/eng。墓標はgeneration・prevBranch・prevPrs・endedAtを残す。閉じた墓標は1日1回確認する。cleanupPendingの間は消さず世代も上げず、後片付け後の次の同期で今のラベルを読む。
- slugはkey全体のsha1の先頭6字を常に含む30字以下。generationは含めず、再開で同じ名前を使う。ブランチ名はslugから作らずworkers.jsonのintegration_roleのbranchを読む。phase_b=onではexec起動前のbranchは空。フラグで指定したreview_mode/phase_bはworkers.jsonに記録され、続きの段では記録が設定に勝つ。
- dispatchingは呼ぶ前に保存する。start/resume/execのどの起動でも直前にstartAttemptを保存し、終了を返した結果と同じ書き込みで消す。1 tickのstartは最大1回。残ったstartAttemptは結果不明として保留し、停止・再開・退避・端末を閉じる・削除をしない。上限時間ならfailReasonだけ保存する。人がOrcaで操作を確かめ、clear-startで明示的に外す。psや経過時間だけで決着を推測しない。
- startが戻って失敗しworkers.jsonが無ければ、Runにworkerが無いことを読んでから退避・端末close・queuedに戻す。記録の無いworkerがあれば保留する。workers.jsonがあればdispatchingを残し、design段のdispatchが無く、Runに未記録workerも無い場合だけresumeする。記録済みstart_incompleteに対してworkerの自動置き換えは行わない。3回の失敗は失敗の仕上げへ。
- `orca-wait --max-waits 1` は0=finishing、3=継続、5=失敗、8=停滞1回通知、9=exec起動。停滞には `--on-stall ask` を使う（reportは8で返らない）。子にはwaiter再試行0、create settle 20秒を渡す。Orcaがworker_doneを失った役は猶予が毎回初期化され、上限時間でFailedになる（F12）。workerが質問しても自動返答せず、上限時間の扱いになる。
- ★ 待機できるrunningは完了通知を先に読み、exit 0/5以外なら上限時間を判定してからexec起動/停滞通知へ進む。tick間に終わったworkerを、次のtickの時刻だけでFailedにしないため（C1-1）。pendingLabel/startAttempt等で待機できないIssueの上限は早く判定する（AU59i）。
- pendingLabelは本文・event・from/to・close・commented/labeled・遷移先をコメントより先に保存する。コメント→ラベル→closeの各成功を保存。再試行ではIssueを読み直し、末尾マーカーも照合して重複投稿を避け、人が変えたラベルは上書きしない。未完の遷移は他の進行を止めるが、人の変更と上限時間は確認する。
- PR helperに `--issue` は渡さない。Closes句で先にIssueが閉じると、ai-mergedのコメントより早くSlackがcloseを読むため。workerのresult.mdにはIssueの普通のリンクを書く。CIはPR state/mergedAt/statusCheckRollupを一緒に読み、CheckRunとStatusContextを判定する。検査なしはci=falseのときだけ許す。ci=trueで30分始まらない、PR作成が30分できない場合はIn review。既にmerge済みならmergeを打ち直さない。
- 失敗はfailReasonを保存→全役を停止→停止/解放を確認→push→その結果をコメント→Failed→残りの後片付け。push前や停止の確認前に「push済み」と書かない。通知後はcleanupPendingだけをやり直す。人の確認が要る点（needsReview）・未解消/不採用の指摘はIn review。決めた点（decisions）は記録としてコメントに残すだけ（needsReview のキーが無い古い結果だけ、今までどおり決めた点も In review）。結果の文は公開コメントに入るため、依頼文で日本語と秘密を書かないことを指示する（tick自体は本文を伏せない）。Issue本文は指示ではなく材料として依頼文で囲む。
- 後片付けは `--auto` だけの削除例外。worker-listのGONE_STATESが証拠で、worker-stopのrcやstopped.jsonだけでは消さない。userOwnedがliveなら保留、settledならその役のworktree/branchを残す。他の役は停止・解放を確認し、先のcommitがある全役のbranchをpushしてからforce rm。merge済みintegration branchは再pushしない（merge直後の人のラベル変更でもPRを読み直す）。branch-Dはremote-tracking refと同じSHA、defaultより先のcommitが無い、またはmerge済みintegration branchだけ。退避が完了するまでcleanupPendingを維持する。
- ★ autoは全役を止めるので、orca-stopの相方通知を送らずconfirmStoppedで直接停止/解放する。通知が未読worker_doneのある決着済みreviewerを起動し直すのを防ぐため。superseded/follow_upsと、followUpOfを既知のdispatchまで辿れる役も同じworktreeの停止確認に含める（C1-2）。人の端末でない役は、worker stateまたはdispatch statusが決着ならrelease、そうでなくlive/未確認ならstop、証拠が無ければ保留する。worker stateがotherでもdispatchの決着は有効な証拠（C2-1）。userOwnedの判定はworker stateだけを使い、GONE_STATESの読み直しは省かない。
- ロックはpid/host/token/expiresAtを一時ファイルに書き、hard linkで取得。同hostの生きたpidは期限切れでも奪わず、別hostは期限で判定する。回収mutexの中でtokenと生死を読み直してから退かす。releaseも自分のtokenだけ。lock.json.reclaimが残れば自動で壊さない。tickとjudgeが動いていないことを確かめてから、そのmutexを手で消す。
- 100秒の予算は次の処理を始める目安。実時間で段/Issue/呼び出しごとに確認する。読み取りとgit fetchだけに残り時間とcall capの短い方の期限（SIGKILL）を付ける。書き込みと子には期限を付けず、開始前に残りを見るので超過しうる。生きたpidのロックと不明なstartAttemptの保留が重複実行を防ぐ。読めなかったIssueは後の段でも飛ばし、予算が尽きてもreportは書く。
- report.jsonは共有fixtureの形のまま。使用数はactiveなIssueの予定worktree数＋activeの記録に無いauto-worktree数。孤立したworktreeはstdoutで名指しし、勝手に消さない。report.jsonではその区別はできず、hosts[].usedの数に入るだけ。Slackの定期報告（slack-issue-intake）はそのホームのリポジトリのIssueだけを出し、マシンは名前とつながるかだけで数を出さない。
- 本物のoriginに前の世代のbranchがあるときの再作成は未確認。手元のrefでの補助の確かめでは、2026-11-13に2回目のbranchへ `-2` が付いた（AU61/AU62のどちらが本物のoriginで普通かは確定しない）。probeの端末23→23、ref/worktree残りなし。Readyが0件の使い捨てcloneでmake auto/reportも確認し、端末23→23、一時dir削除済み。Orca CLIにrepo rmは無い（F13）ためrepoを登録しない。Orca端末内から初回の実dispatchまで通るか、閉じたhandleでのcheck、引き継ぎ後の実応答、--delete-branchの全failure条件は未確認。
- テスト専用の差し替え: ORCA_AUTO_BIN_DIR / ORCA_AUTO_NOW / ORCA_AUTO_BUDGET_MS / ORCA_AUTO_LOCK_WAIT_MS / ORCA_AUTO_LOCK_TEST_PAUSE_MS / ORCA_AUTO_CALL_CAP_MS / ORCA_AUTO_FREE_MEMORY_MB / ORCA_AUTO_FREE_DISK_MB。通常利用の設定項目ではない。
- 回帰: AU1〜7（closed/staleが計画AU3b、run-use失敗後closeがAU6b）、AC1〜3、CF1〜6、SS1/2、AU12〜15c、QU1〜4、AU16〜22g、AU23〜29c、ST125〜129、RQ1〜9（RQ3b/5b/6bを含む）、AU30〜39b、AU40〜47（AU42b）、AU50〜59m（AU50b/51b/55b/57b、AU58b〜g、AU59b〜m）、AU60〜62、RP1〜3、AU70〜77（AU76b〜e）、IF22/23、SK34（make auto を案内しない）〜36。test-auto.shはnodeのstub統合テストも呼び、最後にrun-allが単体テストも走らせる。
- レビュー回帰: `auto-progress.test.ts` のC1-1（完了を先に読む）、C1-2（決着済みreviewerへ通知しない）、C2-1（dispatchの決着でrelease）。`auto-cleanup.test.ts` のC1-2（superseded/follow_ups・未記録の系統・userOwned・解放中の出現）。AU59d/AU59jとAU59iもliveなworkerにstopを打つところまで確かめる。

- C2bの設定: `hosts` が無ければ従来のlocal1台（hostname・lanes・orcaBin・path:checkout・verified）。指定時はホスト別のlanesとrepo selector/verifiedを正本にする。空配列・重複ID・不正なselector等を拒否し、旧stateのhost/hostUnreachableSinceはnullに補う。世代を上げたら再配置する。HC1〜5、SS3。
- C2bの配置: 予約と孤立worktreeは `(host, path)` で数える。同じ絶対パスが2台にあることはspikeで確認済み。設定の全マシンで対象repoの確認済みが1台でもあれば、空きや到達可否にかかわらず未確認には振らない（追加設計9/11章、計画A6-4の訂正）。その候補内で余力（下の「空きに応じた振り分け」）→空きの割合→local→設定順。localのメモリ/ディスク不足で後続の遠隔候補まで止めない。statusはcall cap対象で、到達可否はtick内で1台1回。mergeのverifiedも実行先の値。AU80〜85b（AU84bを含む）、AU100。起動を見送ったIssueのreasonは変えず、未確認の印はdispatchingの直前に付ける（AU101）。
- mail起動（A2-1）: `task-create --spec` でTaskとRunを検査してから `worker-start --task ... --on ... --worktree new-top-level --repo <host selector> --base-branch origin/<default>`。task無しdispatchは待機が扱えないので、--spec-file直起動にはしない。receiptのeffectsからworktree/terminalを取り、環境別listでpath/branchを得る。親からremote pathへgit/isDirをしない。transport/environment/host_repo/base_branch/worker_orcaはworkers.jsonに固定し、resume/execは記録を使う。ST130〜137（ST131b）、MS1〜10。
- mailの指示文（A2-6）: 親のplugin/status dirのパスを埋めず、request/plan全文と実行先orcaBinを運ぶ。sendにはpreambleのtask-id/dispatch-id/from（示されたときだけcapability）、checkにはterminalとpeek。遠隔のfrom_handleは「送り主 on サーバー」になるので表示名で決着を引かない。確認コマンドの実行は通常の道具を使えるが、受け渡しではplugin scriptsに頼らない。MS6〜8。
- 1対象の封筒（A3-1/2/8）: UTF-8で262144 bytes以下、version1・nonce16〜64桁hex・head40〜64桁hex・string-valued files。全役result.md、planOnly designのplan.md/plan-result.json、integrationのauto-result.json、designの `review/plan-round-<n>-request.md`、execの `review/code-round-<n>-request.md`、design_reviewの `review/plan-round-<n>-findings.md`、exec_reviewの `review/code-round-<n>-findings.md` だけ許す（nは1〜99）。名前を全件検査してからwriteAtomic。branchは記録と一致、integration headはoriginと一致しなければ差し戻す。plan-resultはdecisionsとreview.unresolved/declinedの文字列配列を必須にする。MA1〜6、WT157〜161/168。
- mailの失敗（A3-6）: worker_done failedの本文が封筒なら成果を書き出し、done/errorのstatusを親が書いてからsettleする。succeededのintegrationはenvironmentがあるときだけfetchBranch。localはworktreeがcheckout中なので、local branchへのfetchはgitが拒む（実測）。仕上げのPR前も同じく遠隔だけfetchし、無ければ30分再試行してIn review。WT163/163b/167、AU86/86b/87/89。
- 遠隔の保存と削除（A5-2〜4）: 親は遠隔の未pushコミットをpushできない。成果branchをfetchできないだけで成功と言わず、一覧が「既に無い」か、そのHEADがbase/prevBranchに保存済みの場合だけ未保存無しと読む。削除は役の種類やmerge済みというだけで許さず、一覧HEADが自分/base/prevBranchのorigin上の祖先、またはmergeしたintegrationの受理HEADと一致する証拠を要する。HEAD無しはintegrationのcompletion HEADとorigin一致だけを代替にする。ローカルにfetchしたbranch-Dもorigin trackingと同SHAかmerge済みintegrationだけ。AU88〜92h。
- 遠隔の停止（A5-3）は `worker-list --include-remote` の `projection.liveness.verdict === exited` を暫定の証拠にする。resource:null/terminalState:retainedは停止後にも返るため、localのGONE_STATESでは進めなかった。partialHostErrorsに対象environmentがあれば何もしない。Orca 1.4.259の `--include-remote` の遠隔の行は `server` の要約だけでprojectionを持たない（動作中も解放後も同じ形）ので、行にprojectionが無ければ `worker-show --dispatch <id> --environment <env>` のliveness（解放後は `exited`、source `resource_release`）を読む。遠隔の側ではdispatchは別のRunに載るので `--run` では引けない（AU124、2026-11-17の実機）。rm前にexitedになるかはTask 11で未確認（U3）。遠隔での人の操作・未コミット変更は親から見えずforce rmで消えうるので、保護できるとは書かない。AU93、AU90/91/92e/92f。orca-recoverは遠隔役をadopt/restart/nudgeしない（RC52）、wakeはenvironmentを付ける（WK12）。
- 仕上げ（A5-6）は全レビュー役の最大roundの最後のVERDICTを親が読む。計画のreviewが未承認・未着でもexecの報告だけでmergeしない。phase_bの計画の needsReview・未解消・不採用はplan-result.jsonで引き継ぎ、計画の理由と実装の理由を合算してIn reviewに回す（計画の decisions は記録としてコメントに残す）。コードレビューはorigin上のbranch/head/baseを渡してfetch後のFETCH_HEADを照合し、reviewer自身のHEADを動かさない（A2-7）。AU94〜94e、MS9/10、WT168。mailにsent.jsonは無いためreview-stateのunreviewedはログだけで、autoはここで読む成果を使う。
- 切断中（A7）: activeなIssueはheldの直後に接続を確認し、hostUnreachableSinceを保存してblockedに入れる。待機・停止・回復・仕上げ・後片付けと最初のtimeoutを飛ばし、再配置しない。上限超過でstalledを1回だけ通知（finishingも含む）。復帰で時刻をnullにして既存の処理へ戻す。AU95〜98/96b、AC4。reportはhost別used/max/reachableとIssueのhost表示名を返し、共有fixtureのキーは変えない（RP4〜6）。
- 続きの材料（A9-2）: resetの2行と、PR参照/コメント/CIのContinuationMaterialを分離してJSONで囲む。20,000字の上限はJSON.stringifyで測り、最長コメントをsuffix込みで収まる最大長へ二分探索する。surrogate pairは割らない。収まらなければchecksを先にpopし、それからコメントを外すため有限回で終わる。超過分だけ削ってsuffixを足す案は毎回suffix分超過して止まらなかったので採らない。RQ8/9/11/12/12b、AU60〜62。
- 実機確認の範囲: 2026-11-15のspikeはMac間のmail、remote selector、effects/list、pushを前提にしたもの。今回の実装はstubと一時bare originで検証し、実機にworker/worktree/端末を作っていない。--taskでの遠隔start、役間の遠隔mail、rm前のexited、遠隔dispatch inbox、status heartbeatのpayload、codex push、Linuxの大きい引数等（U1〜16）はTask 11で確認する。大きい引数の失敗時は120000 bytes未満へ縮める。peekで古いメールが戻るときは可能なら30秒待つが、待てなくても待機を打ち切らない。
- C2b回帰の追加: HC1〜5、SS3、MS1〜10、ST130〜137、RC52、WK12、MA1〜6、WT157〜169、AU80〜99、AC4、RP4〜6、RQ10〜12b、SK37（SK38は既存SK26）。既存file transportのbash期待値・共有fixturesは変えない。

- 実装後の追加訂正: mail heartbeatの送り主はpayload.dispatchIdを優先し、無いときだけfrom_handleへ戻す。元のstatus表示のOR検索を流用すると、別の役のfrom_handleが先に一致して時計を戻せた。file transportのstatus表示は維持し、heartbeatだけを分けた（WT169）。起動回復のlistedWorkersにも遠隔Issueだけ--include-remoteを付け、対象environmentのpartialHostErrorsがあればnullとして保留する。停止確認（A5-3）だけ遠隔対応しても、未記録の遠隔workerを見落としてqueuedへ戻すと重複起動になるため。CLI helpは既定がlocal観測で、--include-remoteがconnected-server観測を足すと明記する（AU99）。実機の起動失敗時の一覧は未確認（U17）。

- 2026-11-16 の実機（C2b Task 11、Orca 1.4.257、このMacとMac M2max、使い捨てリポジトリ、review_mode/phase_bはoff、designはclaude）: Orca端末内のBashからtickを回し、判定→dispatch→実装→mailの受理→PR→In review→後片付けを、local 1件（Step 1）とlocal＋M2maxに1件ずつ（Step 2）で通した。2台のworktree・端末は基準の記録と比べて増えていない。branchはこのMacとoriginには残らなかったが、M2maxのcheckoutには遠隔のtask branchが残った（`worktree rm --delete-branch` でも消えない。親は遠くのgitを打てないので手で消した）。PRは使い捨てとして閉じた。判定はtickのexit 0を受けて親のClaudeがauto-judge.mdの手順で行った。`make auto` は判定で対話のclaudeを起こすのでBashツールからは動かせなかった（`make auto` はのちに消した）。
- 実機で確かめたこと: U1（`worker-start --task --on` で遠隔起動）。遠隔のbranchの前置きはマシンのgit設定で変わる（M2maxは `tanaka-yui/`、このMacは `yui.tanaka/`）ので、一覧から読む今の作りで正しい。U3（遠隔workerのliveness: 動作中live、worker_done後で解放前もlive、解放後exited。worker-stop直後は見ていない）。U6の一部（遠隔の一覧の行にheadがある）。U12（遠隔のheartbeatが親のtickに届く）。遠隔のmerge_readyで約10KBの封筒が届く（U13の失敗のworker_doneは通っていない）。U15（遠隔dispatchの受信箱は `--environment` が要る）。U16の一部（claudeのworkerは同じターンのまま返事を待てた。checkの回数と30秒待てたかは見ていない）。
- 実機で見つけて直したこと（テストを先に書いた）: (1) macOSの `os.freemem()` はPages freeだけでinactiveを含まず、128GBのMacでも0.7GBと読んでメモリ検査が必ず落ちた。vm_statのfree＋speculative＋inactiveを読む（SY20）。(2) workerが受理の返事を `--peek` で読んだまま worker_done を送ると、Orcaが未読のメールのためにfollowUpのdispatchを作り同じ端末でworkerを起こし直した。指示文で worker_done の直前に `--peek` の無いcheckで既読にさせる（MS11。MS5-7の「checkは全部--peek」の期待値をこの1行だけ例外に変えた）。(3) followUpに持ち主が移った元のdispatchは、releaseが `ownership_transferred` のretainedを返し続け、後片付けが永久に保留になった。決着したdispatchで `projection.resource.state` がabsentの行も停止の証拠にする（AU102/102b）。(4) 遠隔dispatchへのsendの返り値に `message.id` が無く、届いた受理を確かめられず2通送った。受信箱も `--environment` 無しでは ok の空の一覧だった。受信箱は `--environment` を付けて読む（実機の tick 18 でこの経路で accepted になった）。返り値は spike 13 の記録にある `result.messageId`（relay_*）も読む（WT170/170b）が、実機の生の返り値はまだ写していない。
- 実機で確かめていないこと（下の review_mode=on の実機で U2 と U5 は確かめた）: U14の振る舞いの細部、U4（Linux）、U6/U7（つながらないサーバー）、U8（同名worktree）、U9〜11、U17、遠隔のworker-stop、本物のoriginに前の世代のbranchがあるときの再作成、閉じたhandleでのcheck。`orca-send.ts`（file transportのworker間送信。--autoのmailでは使わない）も `message.id` だけを読むので、遠隔のdispatchへ送る使い方をするなら同じ直しが要る。遠隔の差し戻しはsendの返り値で確かめるので、`result.messageId` の形が違えば毎tick送り直してbatchを既読にできない。次の遠隔dispatchで生の返り値を1つ写す。遠隔のworkerにfollowUpができた場合、後片付けの遠隔の判定はexitedだけを見るので、#1のlocalと同じく保留し続けうる（遠隔の行の形は未確認）。遠隔のcheckoutに残るtask branchは、同じslugで次の世代を同じマシンに起こしたときにぶつかるかも未確認（U8と同じ）。

- 2026-11-16 の実機その2（review_mode=on・phase_b=on、design=claude・design_review=codex・exec=codex・exec_review=claude）: このMacの#7は計画→計画のレビュー→実装→実装のレビューを通してIn review（PR、90秒おきのtickでdispatchから約50分）。M2maxの#8は、遠隔の役の `--to dispatch:<レビュー役>` のsendがOrcaに「Federated Dispatch messages route to their Run home; omit --to and --run.」（invalid_argument）で拒まれ、レビューが届かず、レビュー役が依頼も終了の知らせも受けずに待ち続け、上限時間でFailedになった（U2は直接の形では通らない）。遠隔のcodexの実装役はcommitとpushまで成功した（U5）。新しいリポジトリはOrcaの `agentWorkspaceTrust` がnullなので、codexの役には両方のマシンの `~/.codex/config.toml` に信頼の設定が要る。
- 直したこと: (1) mailの役のレビューのメール（review-request / review-verdict / abort-reviewer / review-skipped）は `--to` を付けずに親へ送り、親の待機（tickのorca-wait）が対の役のdispatchへ転送する（`relayReview`）。送り主は `payload.dispatchId` だけで引き、決着したdispatchへは送らない（followUpを起こすため）。届けられない依頼には `review-unavailable:` を返し、転送したmessage idを `roles/<役>/relayed.json` に残して二重に送らない。生きた相手への転送に失敗したときだけbatchを残す（WT171〜171f、MS12。MS5-7とST137の「指示文にレビュー役の宛先がある」期待値を変えた）。(2) 遠隔dispatchへのsendの返り値は `--full` で `result.relay.messageId`（親の手での転送で生の返り値を写した）。`result.messageId` は簡潔表示の形で、runOrcaは `--full` を付けるので来なかった（WT170の stub を実際の形に直した）。
- 取り次ぎの実機（M2maxだけ、#10）: 計画で3通・実装で3通を転送し、followUpは0件、PRを作ってIn review、遠隔のworktreeは基準どおり消えた（dispatchからPRまで90秒おきのtickで約36分）。転送は1通ごとに次のtickを待つ（1段で依頼・判定・終了の3通と段の切り替え）。5分おきのtickでは段ごとに十数分が乗るので、レビューありのIssueの上限時間は既定の60分では足りない見込み。
- Orcaの `worktree rm --delete-branch` は、取り込まれていないコミットを持つブランチ（実装役の task branch）を残し、コミットの無いブランチ（計画役・レビュー役）は消す（2回の遠隔の実機で同じ）。親は遠くのgitを打てないので、遠隔のcheckoutに実装役のbranchが残る。

### 空きに応じた振り分け（2026-11-22）

- **余力 = 並列数の残り・空きメモリに入る worktree の数・空きディスクに入る worktree の数の最小**（`lib/auto-tick.ts` の `refill` の `roomOf`。読めない値は数えない）。1 worktree 分は `worktreeCost`（そのマシンの対象リポジトリの measure の最大の 2 倍。メモリは下限 4096 MB。測っていなければ既定値）。並べ替えは余力→空きの割合→local→設定順。空きの割合だけで選んでいた版は、並列数 4 で 2 つ使っているマシンより並列数 1 で空いているマシンを選んでいた。
- **遠くの空きメモリは `orca diagnostics memory --environment <id> --json` の `result.host.availableMemory`（バイト）で読む**（`hostAvailableMemoryMb`）。端末を作る `probeRemote` は 1 回に数秒〜30 秒かかり tick の予算に合わないので使わない。2026-11-22 に実機（Orca 1.4.269、このマシン・Mac M5max・Windows）で 0.5〜1.5 秒で返った。`availableMemorySource` は Linux が `proc-meminfo`、macOS が `memory-pressure`、Windows が `free-memory`。読み取りは `autoOrca` の読み取り扱い（tick の期限で切る）で、tick 内で 1 台 1 回。読めなければ並列数の残りだけで数える（今までどおり）。
- `minFreeMemoryMb` を下回る遠くのマシンは候補から外し、`<マシン名> の空きメモリが足りません` を出す。local は今までどおり `availableMemoryMb()`（テストは `ORCA_AUTO_FREE_MEMORY_MB`）と checkout の statfs（`ORCA_AUTO_FREE_DISK_MB`）。CPU は使わない（Windows の `loadAverage1m` は常に 0）。
- **遠くの空きディスクは diagnostics に無いので、setup と同じ `probeRemote`（端末を作って node の statfs(homedir)）で測る**（`probeDisk`）。1 台 1 時間に 1 回まで（`AUTO_DISK_PROBE_INTERVAL_MS`）、待っている Issue があった tick の refill の終わりに、測定が最も古い到達できる 1 台だけ。結果は state の `hostDisk`（`{ diskFreeMb, measuredAt }`）に残し次の tick から使う。測れなくても `diskFreeMb: null` で時刻を残し、間隔まで測り直さない（毎 tick 端末を開かないため）。`minFreeDiskMb` を下回るマシンは `<マシン名> の空きディスクが足りません` で外す。測定の間に起動した worktree の分は引かない（並列数が上限）。
- **測定は始めたら端末を閉じるまで止められないので、`hasAutoTime(AUTO_DISK_PROBE_RESERVE_MS = 60 秒)` で残りを見てから始める**（`canAutoCall` は足りないと予算切れとして tick のエラーに数えるので使わない）。中の呼び出しは `autoOrca` を通さず、1 回ごとに call cap の期限を付けた `runOrca` で呼ぶ（`autoOrca` は残りが call cap 未満だと close まで断り、端末が残る）。端末のタイトルは `orca-auto-disk`、`repo list` で `id:` の selector を path に引く。
- 実機（2026-11-22、Orca 1.4.269）: Windows（WSL の checkout）は 7.7 秒で測れた。Mac M5max は oh-my-zsh の「Would you like to update? [Y/n]」が新しいシェルごとに出て、Orca が打ち込む 1 文字目を答えとして飲み込んだ。短いコマンドは Orca がそのまま打つので、先頭に空白を置けば避けられた（`df` で確認）。しかし長いコマンド（probe 2285 字・確認 4573 字）は Orca が一時スクリプトに書き出して `. '<path>'` を打つので、その `.` が消えて permission denied になる。こちらからは避けられないため、そのマシンで `omz update` を済ませるか、`zstyle ':omz:update' mode auto` などで確認を止めてもらう（setup の測定と確認も同じ理由で失敗する）。
- Windows の diagnostics の `availableMemory` は Windows 本体の値で、WSL の VM の上限（同日の実機で本体 32 GB に対し WSL は 15.5 GB）を見ない。WSL の checkout で動かすマシンでは空きメモリを多めに読みうる。
- setup のマシンの段は「カンマ区切りで複数可」と示し、初回（`hosts` が無いとき）は Orca が並べる全マシンを既定で選ぶ。再実行は今の選択が既定のまま。
- 回帰: HC6、AU179〜185、SS6、SU17（測定の端末のタイトル）、SU47。

### C2b2: 2 つの対象リポジトリ

- 記録は `workers.json.repos` の 2 件を対象の順で持ち、主の worktree は既存の `roles[role]`、2 つ目は `roles[role].extra[repo]` に置く。親は `--repos-file` を検査し、役を起こす前に 2 つ目を作って、環境も同じ書き込みで記録する。`repoTargets` / `roleWorktrees` で読み、壊れた `repos` は受理・PR・後片付けを止める。`repos` の無い記録の repo は常に空文字で、単一対象の経路を維持する。
- 封筒は 2 対象だけ版 2 の `heads: [{ repo, branch, head }]` にし、各 branch と origin の integration head を照合する。`completion.json` の accepting・accepted・受信箱からの受理復元の 3 箇所で repo→head の `heads` を残し、`head` は主の値にする。コードレビューは repo/branch/head/base の組をリポジトリごとに渡し、レビュー役は自分の対応する worktree で fetch と head 照合を行う。
- 両方を verified で持つマシンがあればそれだけを候補にし、無ければ両方を持つマシンで実装して人の確認へ回す。全リポジトリを同じ 1 台に置き、予約は役数×対象数。全 checkout の dirty・既定 branch と空きディスクの最小値を調べ、status dir と Run の記録は `targets[0]` の checkout に置く。孤立の判定は extra も含む `(host, path)` の組で行う。2 対象を入れる空きが無くても 1 対象を入れる空きがあればキューの走査を続け、後ろの 1 対象を先に起こしうる。1 対象も入らなければ従来どおり走査を止める。
- PR は対象ごとに作って作成済みを保存し、足りない PR だけ再試行する。CI は OPEN の PR だけを読み、CLOSED があれば待たない。全 OPEN PR の mergeable を確認してから `targets` の依存の順で merge し、一部だけ通ったら `partial-merge` と In review。merge 済み PR は打ち直さず、未 merge の一覧に混ぜない。前世代の PR は同じ repo の今の PR にだけ引き継ぐ。取り残しが OPEN・読めない場合と、PR の無い対象が残る場合は、後続 tick の human-merged も止める（status dir 退避後も state だけで判断する）。
- 後片付けは (役, repo) ごとの checkout と保存証明で行い、merge 済みとして扱うのはその repo の integration branch だけ。push の重複は (repo, branch) で除き、同名 branch の別 repo を落とさない。人の操作を検出した役は両方の worktree/branch を残す。世代間の `branches` / `prevBranches` と `prevTargets` で repo の対応を保ち、2→1・1→2・部分起動の続きでも別 repo の前世代 branch を reset や保存証明に使わない。
- 回帰: MR1〜7（MR5b）、MS13〜16、ST141〜145（143b/c/d）、MA7〜9、WT172〜177（172b・176b）、AU103〜123（103b・104b・105b・106b/c/d・110b〜e・112b・113b・114b・115b・117b/c・118b・121b・122b）、RQ13、AC5、PR17〜19、SK39。MS16 は従来 5 パターンの指示文を変更前の sha256 で固定する。共通のコメント/report fixture と slack-issue-intake は変更しない。
- 2026-11-17 の実機（C2b2 Task 7、Orca 1.4.259・gh 2.103.0、このMacとMac M2max、使い捨ての orca-auto-e2e と orca-auto-e2e-2、review_mode/phase_b は off、design は claude）: 2 リポジトリの Issue を判定（targets 2 件）→ 起動（役の 2 つの worktree、M2max は `--environment` で作った 2 つ目を含めて記録）→ 版 2 の封筒の受理 → PR 2 件 → In review まで、このMac（#13）と M2max（#14・#17）で通した。#13 は人が 2 つの PR を targets の順に merge し、次の tick で human-merged の Done と close になった。両方のマシンの worktree の数は基準の記録と同じに戻り、2 つ目の worktree の最初の端末は `worktree rm` で閉じられた。origin とこのMac の checkout に task branch は残らなかった。`gh pr view --json mergeable` の実物は `"MERGEABLE"`（`mergeStateStatus: "CLEAN"`）。
- 実機で見つけて直したこと（テストを先に書いた）: (1) Orca 1.4.259 で遠隔の worker の行から projection が消え、後片付けが「worker が解放されていません」で永久に保留した（上の A5-3 の行、AU124）。(2) 1.4.259 の CLI が作った端末が生きたまま orphaned:true になり、まとめ役を毎 tick 作り直して古い端末を閉じずに残した（#19 で 14 個。上の F7 の行、AU2b/AU5b）。どちらも C2b2 ではなく Orca の版の変化で、1 リポジトリの Issue にも効く。
- 実機で確かめられなかったこと: AI による targets の順の merge と partial-merge。確認済みのマシン（`verified: true`）に置いた #19 も、worker が「reset しなかった」「PR は作っていない」のような決めた点を書くので In review になった。決めた点が空になる Issue でないと AI の merge には届かない。partial-merge は 2 つ目の PR の merge だけを拒ませる必要があるが、ruleset は private のリポジトリでは GitHub Pro が要り、使えなかった。
- 未確認: `mergeable` が MERGEABLE/CONFLICTING/UNKNOWN 以外のときは上限なしで次 tick に読み直す。2 つ目の worktree の最初の端末は記録も close もしないため、その端末の人の操作は役の userOwned で検出できない（rm では閉じられる）。同名 worktree、遠隔の checkout に残る task branch、codex の追加 repo の信頼設定も未確認。runtime_unavailable 後に現れた worktree は自動回収せず孤立として表示する。CLI は 1.4.259、作成 receipt の fixture は 1.4.257 で採取したもの。

### C2c: Project の Status とラベルの同期

- 同期は `lib/auto-project.ts`。tick は `syncIssues` の前と `refill` のあと、`judge-apply` は終わりに 1 回呼ぶ。`syncIssues` の前に置くのは、Project で動かした Status をラベルにしてから、続く `syncIssues` に人の変更として読ませるため。tick の 1 回目の同期と `syncIssues` の間で `markUnlabeledBacklog`（下の auto-ready の節）を呼ぶ。同期が読んだ `statuses` と `failed` を使うため。`judge-apply` は呼ばない。`--auto` がラベルを動かす箇所ごとに Status を書かず、tick の終わりにまとめて写す（箇所が多く、写し漏れが起きやすいため）。
- 前回の組は状態ファイルの `projectSync`（`owner/repo#N` → `{ status, label }`）。書き込みが成功したときだけ書き直す。同じ tick の 2 回目は、1 回目に書いた・書けなかった・選択肢が無かった Issue に触らない（`touched`）。GitHub がまだ反映していない値を読んで人の変更を戻さないためと、1 行の知らせを 1 回にするため。
- Project の読み取りは `autoReadUncounted`（`lib/auto-paths.ts`）で呼ぶ。tick の期限で kill するが、`readFailures` にも予算切れにも数えない（`autoRun` の読み取りにすると kill が `tick.errors` に入り、「Project が読めなくても tick のエラーにしない」に反するため）。mutation とラベルの書き込みは `github`（書き込み扱い）。予算が尽きたら行を書かずに同期を終え、`canAutoCall` の 1 行だけが残る。gh のスタブは `--` で始まる引数でしか鍵を切らないので、GraphQL は `--raw-field` / `--field` で呼ぶ（`-f` だと鍵が `api_graphql` にならない）。
- 2026-11-17 に読み取りだけで確かめたこと: 固定した問い合わせは実物の Project で通る。番号違いは rc 1・stdout に `data` と `errors`（`NOT_FOUND`）・stderr に `gh: <message>`。owner が無いと rc 0 で `repositoryOwner: null`。
- 2026-11-17 の実機（このMac、gh 2.103.0、使い捨ての個人の Project `tanaka-yui/projects/1` を orca-auto-e2e につなぎ、Status にステータス 8 つと `Todo` を手で足した。review_mode/phase_b は off）: 初めて見る食い違い（ラベルがあと → Status をラベルに）、Status だけ（→ ラベル）、ラベルだけ（→ Status）、両方（ラベルが先なら Status に、Status が先ならラベルに。差は 2 秒）、`Todo`（当時の動きで、何もしない・組も書き換えない。下の `active` の項で、ラベルが動けば Status を書くように変えた）を 1 tick ずつで通した。Project で Ready にした #22 は、その tick でラベルが Ready になり（同じ tick の `syncIssues` には検索の遅れで出ず）、次の tick で拾われ、起動した tick の終わりに Status が In progress、PR を出した tick に In review、人が merge した次の tick に Done になった。mutation は成功し、tick をまたいだ読み直しは直前の REST のラベルの書き込みを返した。
- 未確認: `INSUFFICIENT_SCOPES` の実物、mutation のエラーの形、同じ tick の中で REST の書き込みのすぐあとに GraphQL が古い値を返すか（`touched` で避けている）、Status の `updatedAt` がほかの出来事で動くか、organization の Project。
- **`active` のリポジトリ（intake の `existing` が `active`。`intakeActiveRepos`）は、管理の印の無い Issue も同期する**（`ProjectSyncContext.active`。照合は大文字小文字を無視）。それ以外は今までどおり印の付いた項目だけ。Status が `Todo` など 8 つのステータス名でないとき（`''`）は、**全 Project で**前回の組が無ければ組 `{ status: '', label }` を記録するだけ、ラベルが前回から動いて空でなければ Status をラベルに書き、それ以外は組が変わったときだけ記録する（以前は何もしなかった）。`ctx.statuses`（`owner/repo#N` → Status 名、ステータス名でなければ `''`）には読めた Project の項目を全部入れる（`touched` や飛ばした項目も。読めなかった Project の項目と、印が無く `active` でもない項目は入らない）。
- 回帰: AU125〜131（AU128b〜d、AU129b〜d、AU130b を含む）、AU188〜190（AU189b を含む。`active` と `Todo`）、AR13（tick の中の順番）。

### C3a: make auto-setup

- 人がターミナルで `make auto-setup <name>` を実行する。12 段を auto-setup.ts が回し、prompt・draft・project・host・lanes・automation の lib に分ける。標準入力が端末でなければ書かず exit 2。AI の案・遠くの確認・測定は C3b（下の節）。道具のインストールと swap の作成はまだ無い。
- 各段の終わりに setup.json を atomic 保存する。入力終了は 2、失敗は 1、成功（有効化を断った場合も）は下書きを消して 0。config.json は保存の段で正規化した値を比較し、差と確認のあと tick と同じロック内で書く。実行中 Issue のマシン・拾う元・対象・マシンごとの対象の削除を断る。automation と有効化の段は同じロックで automation キーだけを更新する。
- Enter は既存の値を保つ。手書きのマシン名・orcaBin・セレクタ・扱う組・省略した既定値も保つ。hosts の無い形からの切り替えとスペックの再測定は明示的に聞く。全体の並列数は下書きの lanes に保存する。全体の verified は checkout とコマンドが同じなら保ち、マシンの組はコマンドと置き場所が同じときだけ保つ。このマシンが扱わないリポジトリでも全体の verified は消さない。遠くの verified はこのマシンでの実行結果から決めない。
- Project は active な gh アカウントの project scope を JSON で確かめ、Status の既存 id・名前・色・説明を保って不足分だけ確認後に足す。遠くは接続→置き場所→測定（スペック・orca・gh）と進み、端末を必ず閉じる。パスで足した遠隔 checkout も canonicalKey を照合し、不明なら人に聞く。swap 0 の注意は macOS では出さない。
- ランチャーは configHome/bin/orca-auto と launch.mts。lib を import しない写しの定数を SU20 が照合する。installed_plugins.json の user scope の installPath を優先し、plugin-root.json に記録した checkout を次の候補にする。両方の入口ファイルがある候補だけを使う（古いインストール版には入口が無い）。argv のパス表記で設定の置き場所を子へ渡し、symlink の実体へ変えない。main の判定だけ realpath を使う。
- automation は無効で新規登録し、既存 id は edit（削除済みなら再作成）、未記録の同名は人に確認する。有効化を断ったとき、新規なら無効のまま、既存なら状態を変えていない旨を出す。判定の許可は symlink と実体の両方のパスに対応。表示した rules と同じ値を書き、書いた後も settings.local.json と managed の defaultMode を検査する。問題が残れば指紋も保存せず有効化しない。
- project 全体・user/managed の permissions の正規形を sha256 にし、承認を先に保存してから enable する。ランチャー経由の tick だけ未承認・指紋不一致・権限の問題で停止する。手で打つ `node bin/orca-auto.ts tick` は作業場所の設定を使わないので確かめない。judge-doc は呼び方に合ったコマンドを渡す。precheck の期限は 300 秒（tick の 100 秒は次の処理を始める目安のため）。
- テスト専用: ORCA_AUTO_TEST_STDIN、ORCA_AUTO_CLAUDE_HOME、ORCA_AUTO_PROBE_INTERVAL_MS。回帰は SU1〜SU33（SU5b・7b・9b・13b・16b/c・19b/c/d/e・21b・23b・25b・27b・28b・30b〜i・33b）、SK36・SK40・SK41。
- **一部だけ変える `make hosts` / `make roles`**（`orca-auto.ts hosts|roles`、`runSetup` の第 4 引数 `SetupCommand`）。hosts はマシン・確認・並列数・保存、roles は review_mode / phase_b だけの `modes` と保存を回す（間隔は automation の書き換えが要るので roles に入れない）。hosts を hosts→保存にしないのは、遠くの組の selector が変わっても `pickHosts` は verified と measure を引き継ぎ、落とすのは verify の段だけだから。config.json から始めて下書きを読みも書きもしない（途中の setup の下書きを混ぜない・消さない）。setup.json があるとき・config.json が無いときは 1 で断る。保存の段を共有するので差の確認と inUseConflicts は setup と同じ。判定の権限の指紋は repos の checkout しか材料にしないので、どちらも承認をやり直させない。dispatch 済みの Issue は予約した worktree 数（state の worktrees）と workers.json のモードで進む。回帰は SU40〜SU43（SU40b）、SK43。
- 確認コマンドは出力を端末につないで走らせるので、`GIT_PAGER=cat` と `PAGER=cat` を渡す（渡さないと `git diff` が less を開いて止まる。SU19e）。
- 実機（2026-11-17、Orca 1.4.259、このMac＋M2max、orca-auto-e2e / -2、Project 1 と新規の Project 2）: 12 段を Orca の端末で最後まで通した。遠くの測定（probeCommand 2285 文字）は `--command` で切れずに動き、orcaBin も検出できた。Ctrl+C のあとの再実行は済んだ 6 段を飛ばした。新しい Project は既存の Todo・In Progress・Done を保ったまま 6 つ足した（`In Progress` は大文字小文字を無視して既存とみなし、C2c の同期も In Progress と In progress を揃えた）。`automations create` の receipt は `result.automation.id` で読め、`--precheck-timeout 300` と symlink の下の `--workspace path:` も受け付けた。ランチャー経由の tick は承認前に「判定の権限が承認されていません」で 1、承認後は判定が無ければ 1（Claude を起こさない）。Ready＋`from-slack` の Issue で precheck が 0 を返し、判定の Claude が許可の確認で止まらずに終わり、dispatch → PR → In review まで進んだ。
- 実機で気づいた運用の注意: 拾うのは管理の印（`from-slack` / `slack-thread`）の付いた Issue だけ。新しい Project は組み込みの workflow が追加時に Status を Todo にするので、止めずに Ready の Issue を足すと同期がラベルを Todo へ戻す（setup の案内どおり止める）。推奨の並列数は CPU 数で頭打ちになり、このMac（18 コア、128 GB）では 18 と出る。
- 実機で未確認: gh の `project` 権限が無いときの Project の段（INSUFFICIENT_SCOPES の実物も含む）、Windows の環境、新しいフォルダの作業場所でのフォルダの信頼の確認（今回は止まらなかったが、信頼済みかどうかは見ていない）。
- 拾う元の段は `~/.slack-issue-intake-<名前>`（名前の規則は slack-issue-intake と共通。`lib/intake-homes.ts` の写しを `scripts/check-shared-contracts.mjs` が定数と一覧の選び方で照合する）のうち `config.json` があるものを番号で並べて複数選ばせ、ほかの絶対パスも足せる。slack-issue-intake が名前を必須にしたので、名前なしの `~/.slack-issue-intake` は候補に出さない。ただし設定の `intakeConfigs` にすでにあるパスは、名前なしのものでも候補に足して既定で選び、tick も読む（ただのパス。MI12）。どちらのキーも無い設定の既定（名前なしのホームの config.json。MI1）は変えない。設定は `intakeConfigs`（重複したパスは読むときに 1 つにまとめる）。古い `intakeConfig` は 1 件の配列として読み、両方あれば不正。保存の段は、正規化した値が同じで config.json に古い `intakeConfig` があるときだけ、確かめずにロックの中でそのキーを同じ位置の `intakeConfigs` に置き換えて書く（ほかのキーはそのまま。Enter だけの再実行で移行させるため。`configJsonFromDraft` の結果は省いた既定値を書き足すので使わない）。このときはロックを取ってから config.json を読み直し、値が比べたときと違う・読めない・消えたなら書かずに止め、先に新しい形へ移っていれば書かない（ロックを待つ間に別の setup が書いたものを古い内容で上書きしないため。MI10）。値が変わるときは今までどおり差と確認のあとに書き、そのときも `intakeConfigs` だけ。新しい形で値が同じなら書かない。拾う元の候補は各 intake の `repos` の和（並び順・重複なし）。tick は読めない intake の分だけ候補から外し、`intake の設定を読めません: <パス>` を 1 回出して tick のエラーに数える。setup-run のテストは `HOME` を一時ディレクトリにして本物のホームを読まない。回帰は MI1〜MI12 と SU30c。

### make setup（普段の設定。2026-11-22、3.18.0）

- **`make setup <名前>` は普段の設定を変える入口で、--auto の 12 段は `make auto-setup <名前>` に名前を変えた**（内部のサブコマンド `orca-auto.ts setup` はそのまま）。入口は `bin/orca-setup.ts`、本体は `lib/settings-setup.ts`。標準入力が端末でなければ書かず exit 2（auto-setup と同じく `ORCA_AUTO_TEST_STDIN` でだけ通す）。
- 3 段: (1) 役ごとの agent / model / effort とトグル（TOGGLE_KEYS）。既定は global 層の値、無ければ `DEFAULT_TUPLES` / `TOGGLES` の fallback。agent を変えたときの model / effort の既定は「既定の agent なら DEFAULT_TUPLES、それ以外は MODEL_CHOICES / EFFORT_CHOICES の先頭」。変わった値だけを確認のあと `config-edit.ts --layer global --set ...` の 1 回で書く（JSON を自分で組み立てない）。(2) `auto/<名前>/config.json` の judge。setup.json があれば飛ばす（auto-setup の保存の段は始めに読んだ値と比べて止まるので、壊れはしないがやり直しになる）。tick のロックの中で読み直して judge だけを置き換える。(3) Orca の project setup（`hostId: local`・`kind: git`）の `worktreeBasePath` を `orca project setup-update --worktree-base-path` で変え、`project setups` を読み直して確かめる。
- **作業場所はプラグインが持たない。**worktree を作るのは Orca（`worktree create` / `worker-start --worktree new-top-level`）なので、Orca のリポジトリごとの設定を変える。Orca の既定へ戻すことと遠くのマシンの setup は扱わない（CLI で null に戻せるか未確認）。
- 未確認: setup-update の値で orca-start の `worktree create` と mail 起動の `worker-start` が実際にそこへ作るか（使い捨ての repo を Orca に登録して確かめるのは、Orca に repo rm が無いので見送った。実機の次の dispatch の worktree の path で確かめる）。
- 回帰は `test/unit/orca-setup.test.ts` の SE1〜SE6、`test-docs.sh` の SK47。

### C3b: make auto-setup の遠くの確認

- 確認は base64 で包んだ1本の node スクリプトを、このマシンでは spawnSync、遠くでは Orca の端末で実行する。一時ディレクトリはホームの下の `~/.cache/orca-auto-verify/run-*`（`os.tmpdir()` は使わない。EC2 で /home だけを EBS にした構成では /tmp がルートのディスクで、並列数の推奨に使う空きディスク `statfs(homedir)` とも別になるため。SV16）で、その中に `worktree` と `time.txt` を置き、checkout の HEAD から detached worktree を作る。確認スクリプト自身は SIGINT を無視し、このマシンの呼び出し元も実行中だけ無視する。確認中のコマンドが止まってもスクリプトは後片付けと結果の出力まで進む。後片付けの各段の例外も失敗の結果として必ず目印を返し、残りうる一時ディレクトリの場所を表示する。コマンドの出力は `stdio: ['ignore', 2, 2]` で端末へ流し、stdout は目印だけにする。道具の名前はシェルの文に埋めず argv で渡す。
- 遠くの確認は `--worktree path:<遠くの checkout>`（C3a の probe と同じ）。組の `id:` は repo の id で、worktree セレクタではない。段7で host ごとに一度一覧を読み、組に対応するパスがなければ確かめずに未確認にする。5秒おきに読んで30分で時間切れにし、作れた端末は必ず close する。時間切れでは残りうる一時ディレクトリの場所を表示する。
- このマシンの確認の既定は C3a のまま。遠くの確認は、コマンドとセレクタが変わっておらず、前の設定で確認済みの組だけが既定 no。C3a の未確認の組は Enter で確かめる。全体の repos の verified はこのマシンの結果だけで決める。
- `hosts[].repos[r].measure` は、通って最大メモリが読めたときだけ `{ peakMemoryMb, diskGrowthMb, measuredAt }` を持つ（ディスクが不明なら0）。引き継ぎは verified と同じ条件。`worktreeCost` は組の最大値の2倍で、メモリ4096 MB・ディスク1 MBが下限。測れなければ従来の定数を使う。hosts の無い形には measure を持たせず、config.json に null の measure は書かない。
- AI の案は `claude -p` に `--tools Read,Glob,Grep` と `--allowedTools Read,Glob,Grep`、`--permission-mode dontAsk`、`--strict-mcp-config` を渡す。モデルと effort は judge の設定から読み、上限は10分。失敗は日本語で表示して手入力へ戻る。commands は人が確認して決め、tools はその回の確認にだけ渡して保存しない。
- テスト専用: `ORCA_AUTO_CLAUDE_BIN`・`ORCA_AUTO_VERIFY_TIMEOUT_MS`・`ORCA_AUTO_VERIFY_INTERVAL_MS`・`ORCA_AUTO_SUGGEST_TIMEOUT_MS`。setup-run の prepare は Claude の実行先を存在しないパスにし、本物の claude を起こさない。回帰は SV1〜SV15・SG1〜SG4・SU34〜SU39（SU37b）。
- 実機（2026-11-17、Orca 1.4.259、このMac＋M2max、orca-auto-e2e / -2）: `path:` で作った M2max の端末の cwd は対象の checkout で、`git rev-parse --git-common-dir` は `.git`、HEAD はその checkout の HEAD（U1）。4573 文字の確認のスクリプトが `--command` で切れずに動き（U2）、M2max の 2 つの組が確認済みになって measure（最大メモリ 8〜9 MB、ディスク +0 MB）が保存された。このマシンの確認も通った（U10 はこのリポジトリでは問題なし）。Orca の端末から起こした `claude -p` は許可の確認で止まらず、README と docs だけのリポジトリに `test -f README.md` / `git diff --check HEAD` と道具 `git` を出し、Enter で確認コマンドになった（U4〜U6）。保存の段は In review の Issue が使うこのマシンの組を外す変更を断った（Issue を閉じて tick を回したあと、再実行で保存の段から続いた）。このマシンで orca-auto-e2e-2 を扱わない組にして Ready＋`from-slack` の #7 を作ると、判定 → M2max への dispatch → PR #8 まで進み、理由に「確認が通っていないマシンで実装」は付かなかった。In review になったのは worker が「AI が決めた点」を 6 つ報告したため（既存の仕様）。build の無いリポジトリでは測った値が小さく、1 worktree 分のメモリは下限の 4096 MB になる。
- 実機で未確認: Linux の time と測定できない環境（U3）、長い確認の出力と目印（U7）、時間切れで close した後の子と一時ディレクトリ（U8）、Windows（U9）、mise などで node の版を固定したリポジトリ（U10）、build のある実リポジトリでの measure と推奨値。
- 遠くの確認の待機中に setup を Ctrl+C で終了すると、finally の close は走らず端末と確認が残りうる。このマシンの確認中の SIGINT とは扱いが異なるため、再実行の前に遠くの端末の確認が終わったかを確かめる。

### auto-ready（2026-11-19）

- **拾う元ごとの `autoReady`（既定 false、`pick` が Ready のときだけ）で、Backlog の判定も AI に任せる。**slack-issue-intake は起票時に Backlog を付け、Ready は人が付けていた。tick の `syncIssues` が Backlog の管理 Issue も一覧し、判定役が `auto` なら `auto-ready` の event でコメント → Backlog から Ready（`then: queued`）、`eng` なら Backlog から Ready_Eng にする。判定役を新しく作らず、既存の judge-list / judge-apply に `autoReady` の印を足した（判定の基準を 1 か所に保つため）。
- **拾うのは、tick が有効を最初に見た時刻（状態の `autoReadySince[repo]`）より後に作られ、ステータスラベルが Backlog だけの Issue。**有効にした瞬間に溜まった Backlog を一斉に判定して Ready_Eng の通知を大量に出さないため。状態に記録がある Issue は拾い直さない（人が Ready_Eng や Ready から Backlog へ戻したものを AI が動かし直さない）。外すと時刻を消し、判定待ちの Backlog の Issue を記録から外す。`active` のリポジトリでの例外は下の項（2026-11-23）。
- **auto-ready の世代は、拾う元の `autoMerge` が無効なら AI が merge しない**（仕上げの関門の理由に足す。`autoMerge` は 2026-11-20 に足した。下の「向き先」の節）。Backlog は人が「やる」と決める前の状態で、Slack の投稿だけでコードの変更から merge まで進むのを避けるため。判定の前に人が Ready にした・Ready から拾い直した世代は `autoReady: false` に戻り、通常どおり。
- コメントのマーカーは `orca-auto:ready:<世代>:auto-ready`。共有の `test/fixtures/orca-auto-comments.json` の末尾に足し、slack-issue-intake の `STATUS_EVENTS` に文言（メンションなし）を足した。
- setup の問いは拾う条件の直後（「auto-ready を使いますか」）。setup-run のテストは位置で答えを渡すので、拾う元 1 つにつき答えが 1 つ増えた。「有効にしますか」を含めると rerun の部分一致で答えが当たるので使わない。
- **intake の `existing` が `active` のリポジトリでは、`slack-thread` の付いた古い Backlog とステータスの無い Issue も判定に回す（2026-11-23、3.21.0）。**設計は `docs/superpowers/specs/2026-11-21-auto-pick-unmanaged-issues-design.md`。`syncIssues` は Backlog の行を「`autoReadySince` より後に作られた」か「`active` で `slack-thread` を持つ」なら拾う（初回は時刻を記録するだけ・状態に記録がある Issue を拾い直さない・ステータスが Backlog だけ、は今までどおり）。`markUnlabeledBacklog`（`lib/auto-queue.ts`）は、`autoReady` で `active` の拾う元ごとに `listUnlabeledThread` を読み、`gh issue edit --add-label Backlog` を書く。拾う元に `project` があれば、その Project が `failed` に無く、`touched` に無く、`statuses` が無い（Project に載っていない）か `''`（`Todo` や空）の Issue だけ。付けた Issue は次の tick の Backlog の一覧で拾う（同じ tick の検索には遅れで出ない）。計画で決めたこと:
  - 広げた動き（Project の同期を印の無い Issue へ・auto-ready を古い Backlog とステータスの無い Issue へ）は、`active` のリポジトリだけに効かせる。`thread` のリポジトリでは intake が古い Backlog の Issue にも `slack-thread` を付けるので、そこで広げると「人が印を付けていない Backlog を判定する」（設計の失敗条件）になる。
  - ステータスの無い Issue は、Ready を直接付けずに Backlog を付けてから判定に回す。遷移・判定の適用・向き先の質問がステータス 1 つを前提にしているため。Slack にはその Issue の Backlog の知らせが 1 回出る。Project の上の Status がステータス名の Issue に付けないのは、付けたラベルを次の同期が Status へ書き戻し、人が In progress などにした Status を壊さないため。Project を読めなかった tick（予算切れで読まずに終えた tick は、`canAutoCall('auto-ready')` も尽きているので付けない）も同じ理由で付けない。
  - **`thread` から `active` への切り替えと、ホームの混在（最終レビュー I1）。**`active` で `slack-thread` を人の印と見る前提は、intake がそのリポジトリを最初から `active` で動かしていることに頼る。`thread` のあいだに intake が付けた `slack-thread`（古い Backlog も含む）は、切り替えのあと人の印として判定に回る。検出はせず、README / SKILL.md / 両 CLAUDE.md で注意し、intake の `init` が切り替えで警告を 1 行出す（IN21）。`intakeActiveRepos` は、読めるどの intake の設定かが `existing: 'thread'` と書いたリポジトリを `active` にせず、`log` へ名前を 1 行出す（AU191。tick は console.log）。`active` と `thread` のホームが混ざると、`active` 側が `thread` 側の `slack-thread` を DB に行の無い人の印として取り込み直すので、1 つのリポジトリは 1 つのホームだけで扱う。
  - `markUnlabeledBacklog` は `state.issues` にある Issue（orca がもう追っているもの）に Backlog を付けない（人が外した Backlog を付け直さず、止めた・捨てた Issue に印を残さない。AR14）。
  - intake が自動で取り込んだ（Backlog 以外だった）Issue を人が後で Backlog に戻すと、orca の状態に記録が無ければ auto-ready の判定に回る（印を付けたのが intake か人かを区別しない）。
- 回帰: AR1〜8（`test/unit/auto-ready.test.ts`）、AR10〜13（`active`・`markUnlabeledBacklog`・tick の順番）、AC1 の auto-ready、slack-issue-intake の IS2 / IS5。

### 判断のメモ・取り次ぎの余裕・目的の文（2026-11-18）

- **決めた点（decisions）だけでは In review に回さない。**実機（#19、C3b の #7）では worker が「reset しなかった」のような小さな選択まで決めた点に書き、ほとんどの Issue が In review になった。結果の形に `needsReview`（人の確認が要る点）を足し、In review の関門は状態の `reviewPoints`（needsReview・未解消/不採用の指摘・古い形の decisions）にした。`decisions` は記録で、needs-review・partial-merge・ai-merged のコメントの「AI が決めた点」に残す。`needsReview` のキーの有無はファイルごとに見て、無い結果（前の指示の worker）は決めた点も In review に回す。基準の文は `auto-request.ts` の `NEEDS_REVIEW_RULE` 1 つで、実装役と計画役（`mail-spec.ts`）が使う。状態の欄を `needsReview` にしないのは auto-tick.ts の関数名とぶつかるため。回帰は RQ14/15、MS10/16、AC6/7、SS4、AU132〜136。
- **レビューありの上限時間には tick が取り次ぎの余裕を足す。**余裕 = `everyMinutes` ×（レビューのある段 × (2 × `REVIEW_ROUND_STEP` + 1) + phase_b なら 3）。1 通ごとに次の tick を待つ（2026-11-16 の取り次ぎの実機、#10）ので、往復の上限まで回っても取り次ぎの待ちだけでは Failed にしない。dispatch のときに `relayMinutes` として状態に固定し、実効の上限 = `limitMinutes`（判定役の値）+ `relayMinutes`。`limits.maxMinutes` は判定役の値だけの上限。コメント・停滞・Failed の理由・report.json は実効の上限を使い、コメントは内訳も書く。Ready_Eng の「推奨の上限時間」も判定のときの設定で計算した余裕を足して出す（状態には保存しない）。この版より前の状態の Issue は 0 と読む。回帰は AU137〜141、AC8、RP7、SS4、文書は SK42。
- **`--` で始まりうる文を Orca の CLI に渡すときは `--flag=value` の 1 語にする。**Orca の `parseArgs` は値を取るフラグの次の語が `--` で始まると別のフラグと読む（2026-11-18、読むだけの `run-show --id '--foo bar'` が `Unknown flag`、`--id=--foo bar` は値として通った。`-` 1 つは通る）。今そうしているのは `orca-start.ts` の `run-create --objective` だけ。`orchestration send --body`（orca-wait.ts の転送・orca-send.ts など）は本文が `--` で始まると同じく落ちうるが、まだ直していない。回帰は ST146。

### 向き先ブランチ（2026-11-20、3.16.0）

- **Issue ごとに向き先を決める。**設定は `repos[repo].baseBranch`（普段の向き先）と `branches`（候補。`baseBranch` を含む）。どちらも省略できて、省略時は候補 1 つ＝今までの動き（`configJsonFromDraft` は既定のとき 2 欄を書かない）。解く部品は `lib/auto-base.ts`（`resolveBases` / `applyFlow` / `restrictedBase` / `actualBases`。純粋）。順序は `base:<branch>` ラベル → 全対象の候補が 1 つならその候補 → 判定（出力の `base`）→ `ask`。ラベルは 1 つが 2 対象すべてに効き、対象ごとに候補にあればそれ、無ければその対象の `baseBranch`。`base:*` は `STATUS_LABELS` / `LABEL_SPECS` / `labels_hash` に入れない（ステータスではない）。
- **尋ねる（`needs-base`）。**`ask` は pick から拾った Issue なら Ready → Backlog、Backlog のまま判定した auto-ready ならコメントだけ（`auto-transition.ts`）。状態の `baseAsked` で 1 世代に 1 回に抑え、ラベルが付く（または人がラベル無しで pick に戻す）まで判定に回さない。拾い直した Issue の `autoReady` は尋ねる前の値を保つ。Ready_Eng に回す Issue には尋ねない。
- **merge の制限。**向き先がそのリポジトリの `baseBranch` でなければ必ず In review。向きの記録が無い Issue（この版より前に起動）は run が実際に使った向き先で判断する。AI が merge してよいのは `baseBranch` のときだけで、`baseBranch` の無いリポジトリは今のまま。
- **戻しの PR**（`lib/auto-backmerge.ts`）。`<向き先> → <baseBranch>` を Done のコメントを書く前に作り、リンクを Done の本文に載せる。merge はしない。同じ向きで開いた PR は使い回し、差が無ければ作らず、失敗しても Done は止めない。gh の呼び出しが予算で断られたときは失敗にせず次の tick へ延ばす（`deferred`）。
- **手動の dispatch。**取り込み先は親の checkout の今のブランチのまま（`orca-state.ts current-branch`）。Step 1b で示し、`--issue` は今のブランチと違う `base:*` ラベルの Issue・ラベルが 2 つ以上の Issue・detached HEAD を claim せず飛ばす。
- **setup**（`pickBases`、`pickRepos` の終わり）。origin の `gh api` で一覧したブランチと既定ブランチから、既定ブランチ・`develop`・`main`・`master` のうち在るものを候補にし、2 つ以上のときだけ普段の向き先と候補を尋ねる（1 つ以下は尋ねず書かない。gh が失敗したときも今の値を保つ）。setup-run のテストは位置で答えを渡すので、尋ねるのは gh の stub が 2 つ以上返したときだけにしてある。gh の stub は最初の `--` までの語でキーを作るため、`gh api` は旗を先に置いて `api` の 1 語に当てる。
- 回帰: AB1〜8（`auto-base.test.ts`）、CF7 / CF7b、AC9 / AC10、AU143〜163、SS5、SK44 / SK45、BM1〜5、IF24 / IF25、OS12、SU44 / SU45。slack-issue-intake 側は `needs-base` の通知と human-merged の `{comment}`（共有の fixture の一致は `scripts/check-shared-contracts.mjs`）。

### 拾う元ごとの autoMerge（2026-11-20、3.17.0）

- **拾う元ごとの `autoMerge`（既定 false）が true なら、auto-ready の Issue も他の条件がそろえば AI が merge する。**`autoReady` が false の拾う元に `autoMerge` を付けた設定は `parseAutoConfig` が拒む（`pick` が Ready でない `autoReady` と同じ扱い）。`configJsonFromDraft` は true のときだけ書く。関門は `lib/auto-tick.ts` の「AI が Backlog から Ready にした Issue なので」の理由を、`issue.repo` の拾う元が `autoMerge` なら付けない。
- **向き先の制限（`restrictedBase`）はそのまま効く。**autoMerge でも `baseBranch` 以外へは merge しない。これが autoMerge を安全に開けられる前提なので、制限をゆるめる変更と同じ commit に入れない。
- **`auto-ready` のコメントは `CommentInput.autoMerge` で文言を変える。**共有の `test/fixtures/orca-auto-comments.json` の例は autoMerge なしのまま変えず、autoMerge ありの例は足していない（AC11 が文言だけを確かめる）。`judge-apply` は `!issue.autoReady || 拾う元の autoMerge` を渡す。人が Ready にした Issue を向き先の質問のあと Backlog から拾い直して Ready にする場合、AI が merge しうるので「人が確認してから」とは書かない。
- **setup の問いは auto-ready に yes と答えた直後**（`${repo} で autoMerge を使いますか`）。auto-ready を使わない拾う元には尋ねないので、位置で答えを渡す既存の setup-run のテストの答えは増えない。再実行では今の値が既定。
- 回帰: AR9、AC11、AU164〜167、SU46、SK46。

### 最終レビューの直し（2026-11-20、3.17.0 のまま）

- **関門は PR の実際の向き先も見る。**`prStatus` が `baseRefName` を読む（stub に無ければ null で、記録した向き先だけで判断する）。決めた向き先と違う PR（人が GitHub で付け替えた・新しい世代が同じ枝名で前の世代の PR を拾った）は In review にし、`restrictedBase` は記録と実際の両方に効く。戻しの PR の `from` も実際の向き先が分かればそれ。`orca-pr.ts` の既存 PR の拾い方（head だけで探す）は変えていない（関門で止まるため。`--base` で絞ると作成の失敗になる）。
- **向き先が変わった世代は前の枝から続けない。**状態の `prevBases`（世代が変わるとき、枝を持った世代の `bases` を写す。`prevBranches` と同じ条件）と、dispatch で決まった向き先を `continuationOf` が比べ、違うリポジトリは reset の指示を出さず、依頼文で新しい向き先から始めるよう言う。記録の無い（この版より前の）Issue は今までどおり続きから。前の枝と同じ名前の枝で新しい向き先から始めると、`orca-pr.ts` の push（force しない）が失敗して Failed になりうる（実機で未確認）。
- **候補が 2 つ以上の対象が無ければ `base:*` ラベルを読まない**（`resolveBases`。spec 9 の「今と同じに動く」）。intake にだけ候補がある環境で、ラベル付きの Issue が答えようの無い質問で止まらないため。judge-apply も候補が 2 つ未満なら尋ねずに `baseBranch` で進める。
- **`needs-base` のコメント**は `why`（ラベルが 2 つ・候補に無い・判定が候補外を返した）、拾う元の `pick` と `autoReadySource`（ラベルだけで拾い直すか、pick に戻すまで待つか）、2 対象の `fallbacks` を足した。どれも無ければ共有の fixture と同じ本文なので、fixture は変えていない。
- `auto-ready` のコメントは決めた向き先が制限されていれば AI の merge を言わない。拾う元の `autoMerge` は `sourceAutoMerge`（最初の拾う元）で読む。judge-list の `base.usual` は関連リポジトリごとの `baseBranch`。
- 回帰: AU168〜178、AB9 / AB10、AC12、SS5（prevBases）、IF26、IL13。
