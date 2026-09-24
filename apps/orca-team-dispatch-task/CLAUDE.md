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
**資源は消さない**）/ `bin/orca-cleanup.ts`（Step 5 の判定 `plan` と Step 6 の実行 `run`）/
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
exec = codex・gpt-6-sol・high）。Opus は `opus[1m]` alias だと provider によって古い版を指すので
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

**停滞の判定は `workers.json` をその都度読む。**期待集合は知らない dispatch の message が
来たときしか読み直さないので、それを使うと `--phase exec` で足された exec が最初の message
まで見えない。成果を載せる役（`integration_role`）が起動されていなければ決着していないとし、
`unstarted_role` として知らせる（Step 3.5 の飛ばし。起動済みの役が全部決着してから）。
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

## レビュー往復の要点

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

## issue モードの要点

- **`issue-fetch.ts` は cmux 版からの移植**で、挙動の変更は先頭コメントに列挙した点に限る。
  lock の in-flight grace / takeover mutex / claim の補償 / fetch の窓拡張は、
  **失敗様式ごと持ち込む価値がある**のでそのまま
- **wake 駆動を持ち込まない。**cmux 版は「dispatch したらターンを終え、子の通知で親が
  起きる」設計で、そのために単発 safety timer と timeout sentinel が要る。Orca では
  `orca-wait.ts` がブロックして待てるので、**塞ぐべき穴を先に作らない**
- **merge が通って初めて片付けの話になる。**逆にすると worktree を消してから merge に
  失敗し、成果が消える（回帰は `test-issue.sh` の IS3 / IS4）
- **`orca-issue.ts` は資源を消さない**（IS6）。無人で走る側が消すと失敗の証拠がその場で
  失われる。片付けは Step 5 の判定と Step 6 の承認を経る
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

Stage A（1 タスク = 1 役）に **Stage B のレビューモード**を足した段階。PR 無し・ループ無し。

- **役ごとの agent / model / effort は設定できる**（global と project の 2 層 + 1 回きりの
  コマンドライン上書き）。アカウントは選べない（上記の理由）
- **`review_mode=on` で `design_review` が起きる**（既定は `off`）。reviewer は
  **先に**起動し（design は起動直後に依頼しうるため。spec 5-1 T4a）、**自分の worktree**を
  持つ（同じ checkout に 2 agent を同居させると reviewer のビルドが design の編集と衝突する）
- **`--issue` で GitHub issue を claim して回せる**（merge のみ。PR は作らない）。
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
- **worker の質問は親が答えられる**（exit 6）。`brainstorm` の worker は `orchestration ask`
  でブロックし、親は `orchestration reply --id <msg_id>` で答える。**未知の型として batch を
  止めてはならない** — 答えれば進む dispatch が永久に止まる（実測）。取り次いだ質問は
  `questions.json` に記録し、**2 度目は処理済みとして通す**。通さないと、答えたあとも同じ
  質問が queue の先頭に居座り、その worker の `merge_ready` が後ろで待ち続ける（実測）
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
**N タスクを 1 つの Run で並列に dispatch できる**（既定上限 4）。worker のセッションは
`worker-retain` で最後まで保持し、解放は Step 6 の承認後だけ。片付けが勝手に走ることは
ない — Step 5 が削除してよいものを判定し、Step 6 が尋ねて、承認されたものだけを実行する。
recovery 機構は意図的に持たない（設計 spec 18-1 の裁定）。テストは `bash test/run-all.sh`。
