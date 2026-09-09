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

`bin/orca-start.sh`（worktree + Task を用意し、`worker-start` で Orca に端末起動を依頼する。
端末自体はこのプラグインではなく Orca が作る）/ `bin/orca-wait.sh`
（`worker_done` を待つ。成功 0 / 失敗 5）/ `bin/orca-merge.sh`（成果を親ブランチへ。
**資源は消さない**）/ `skills/.../scripts/report-status.sh`（worker が status を書く口。移植）/
`skills/.../scripts/config-{lib,resolve,edit}.sh`（設定層。後述）。

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
`runners.json` と `config-edit.sh --runners` / `--engine` は移植しない。

**agent の allowlist は閉じない。**スキーマが `--agent` の値として名指しするのは claude と
codex だけだが、未知の値も警告付きで通す（Orca が agent を増やしたときにここを直さずに
設定できる状態を保つため）。判定できないもの（未知 agent の effort）は Orca に委ね、
誤りは `worker-start` の失敗として見える。

**model と effort に自動既定を持たない。**未設定なら flag ごと渡さず、Orca 側の既定に委ねる。
既定を捏造すると、設定していない利用者の dispatch が黙って変わる。回帰は `test/test-config.sh`
の CF1 と `test/test-start.sh` の ST31 が固定する。

## WSL2 の path 境界

Orca 本体は Windows 側に居るので、**CLI 境界で path 形式が変わる**（実測）。送りは
`wslpath -w`（Linux path のままだと `repo_not_found`）、受けは `wslpath -u`（receipt の
path は UNC で返り、bash の `-d` も `git -C` も解釈できない）。変換するのは
`orca-start.sh` の repo selector と worktree path だけ。**worktree id と terminal handle
は変換しない**（実測: `\` を含む id はそのまま通る）。`orca-merge.sh` は branch ベース
なので無関係。判定は `ORCA_ORCHESTRATION_COMPATIBILITY_HOST_KIND=wsl` **かつ** `wslpath`
の存在の両方。`ORCA_BIN` の既定は `$ORCA_CLI_COMMAND`（WSL2 では PATH 上の `orca-ide`）へ
フォールバックする。回帰は `test/test-start.sh` の ST28*/ST29 が固定する。

## レビュー往復の要点

- 往復は `orchestration send --to dispatch:<id>` / `check` の直接やり取り（実測 O38）。
  **親の Run メールボックスには来ない**（O39）ので、`orca-wait.sh` を汚さない
- **`orca-wait.sh` の期待集合の鍵は `(status dir, role)` の組**である。1 タスクが 2 dispatch を
  持ち両方が `worker_done` を送るので、status dir 単位のままだと reviewer の message が未知に
  なり **batch ごと永久に詰まる**（回帰は `test-wait.sh` の WT30-35）
- **タスクの結末を決めるのは `design`。**reviewer の失敗は「レビューが付かなかった」であって
  成果の喪失ではない。ただし `finish` は役ごとに 1 行出すので握り潰してはいない
- spec 6-1 の `addressbook.json` は**作らない。**宛先は `workers.json` の
  `roles.<role>.dispatch` に既に在り、同じ事実を 2 つ置くとドリフトする
- 往復のファイルは**タスク単位で共有する `<status-dir>/review/`**（親 repo 側の絶対パス）。
  2 役が別 worktree に居ても、どちらからも届く

## issue モードの要点

- **`issue-fetch.sh` は cmux 版からの移植**で、変えたのは 4 点だけ（先頭コメントに列挙）。
  lock の in-flight grace / takeover mutex / claim の補償 / fetch の窓拡張は、
  **失敗様式ごと持ち込む価値がある**のでそのまま
- **wake 駆動を持ち込まない。**cmux 版は「dispatch したらターンを終え、子の通知で親が
  起きる」設計で、そのために単発 safety timer と timeout sentinel が要る。Orca では
  `orca-wait.sh` がブロックして待てるので、**塞ぐべき穴を先に作らない**
- **merge が通って初めて片付けの話になる。**逆にすると worktree を消してから merge に
  失敗し、成果が消える（回帰は `test-issue.sh` の IS3 / IS4）
- **`orca-issue.sh` は資源を消さない**（IS6）。無人で走る側が消すと失敗の証拠がその場で
  失われる。片付けは Step 5 の判定と Step 6 の承認を経る
- **`.dispatch-issue/` を `info/exclude` へ入れる。**入れないと state file と lock で親が
  常に dirty になり、merge の dirty ガードが必ず発火して 1 件も merge できない（実測）

## 取り込み先を 1 箇所で決める

`workers.json` の **`integration_role`** が「成果がどのブランチに載るか」を持つ
（`phase_b=off` なら design、`on` なら exec）。`orca-merge.sh` も `orca-pr.sh` も
この 1 つの値を読む。**別々に判断すると必ずずれる。**

**`// "design"` の既定を置かない**（MG12 / PR9）。書き損ねた dispatch が黙って design の
ブランチを取り込むと、取り込み先の取り違えは成果の喪失につながる。例外は
`orca-wait.sh` で、あちらは何も壊さないうえ merge の gate が受け止めるので design に落とす。

## PR は repo を推測しない

`orca-pr.sh` は **`--repo <owner/repo>` を必須**にする（PR1）。spec 12-2 の実測: 3 remote の
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
  駆動は**バッチ同期** — 1 バッチを dispatch したら `orca-wait.sh` で待ち切ってから次へ進む。
  cmux 版の wake 駆動（`dispatch-notify` + safety timer）は移植していない
- **`phase_b=on` で `design` が計画し `exec` が実装する**（既定 off）。exec は design が
  終わってからでないと起こせないので **起動は 2 段**（`orca-start.sh --phase exec`）。
  空の計画では起こさない
- **`integration=pr` で pull request を作れる**（既定 merge）。**統合はどちらか一方**であり、
  PR のとき issue は close しない（`Closes #N` で PR のマージ時に GitHub が閉じる）
- **`exec_review` と Phase B-R** も実装済み（`review_mode` と `phase_b` が両方 on のとき）
- **完了は二相コミット**（spec 10-1 の 7 相）。worker は自分で done を報告せず、nonce を
  載せた `merge_ready` で差し出し、親が検証して受理か差し戻しを返す。**reviewer も例外に
  しない**（例外にすると findings が正式になる時点が未定義になる）
- **失われた worker の owner を回復できる**（`bin/orca-recover.sh`）。生きていれば nudge、
  `failed`/`stopped` が証明されたら `--retry-of` で置き換えて generation を上げ、
  **確認できないものには何もしない**（fence が先）
- **`design_mode` で取りかかり方を選べる**（`direct` 既定 / `plan` / `brainstorm`）。
  cmux 版の Step 1c 相当だが、**Orca では端末を Orca が作るので起動フラグに触れない** —
  spec 本文の指示として効かせる。`--issue` は無人なので `brainstorm` を `plan` へ落とす
  （cmux 版が loop-mode で「plan mode に固定」としているのと同じ理由）
- spec の follow-up 表は F-a / F-b / F-c / F-d / F-e / F-f / F-g / F-h をすべて実装した。
  `test-docs.sh` の SK4 が `exec_review` / `merge_ready` の語を SKILL.md から締め出して
  「未実装の宣言」を防いでいる
**N タスクを 1 つの Run で並列に dispatch できる**（既定上限 4）。worker のセッションは
`worker-retain` で最後まで保持し、解放は Step 6 の承認後だけ。片付けが勝手に走ることは
ない — Step 5 が削除してよいものを判定し、Step 6 が尋ねて、承認されたものだけを実行する。
recovery 機構は意図的に持たない（設計 spec 18-1 の裁定）。テストは `bash test/run-all.sh`。
