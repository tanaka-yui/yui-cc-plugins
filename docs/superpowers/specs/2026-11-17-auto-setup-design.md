# --auto の `make setup`（C3a）の設計

元の設計は `2026-11-12-issue-auto-dispatch-design.md` の 6.8 と、`2026-11-13-auto-dispatch-additions-design.md` の 5.1・5.4・6.1・6.2。C3 は 2 つに分け、この文書は前半の C3a。2026-11-17 にユーザーが分け方（C3a / C3b）と作り方（ターミナルの対話 CLI）を選んだ。

## 目的

今の `--auto` は、`~/.claude/config/orca-team-dispatch-task/auto/<名前>/config.json` を手で書き、Orca の automation も手で登録しないと動かない。`make setup` の質問に答えるだけで、設定の作成から automation の有効化までを済ませ、`--auto` を動かし始められるようにする。

## やること / やらないこと

やること（C3a）:

- 前提の確認、拾う元と関連リポジトリ、Project、ステータスラベル、マシンの選択とスペックの測定、マシンごとのリポジトリの置き場所と認証、リポジトリごとの確認コマンド（人が入力する）、並列数、レビューモード、間隔、automation の登録と有効化。
- 段は途中から再開できる。済んだ段は飛ばす。もう一度 `make setup` を走らせると、今の値を既定にして段をやり直せる。

やらないこと（C3b に回す）:

- AI にリポジトリを読ませて確認コマンドを割り出すこと、build の最大メモリとディスクの増え方を測ること、足りない道具を入れること。
- sudo を AI に許すかの質問、swap を作ること。今の worker への依頼は sudo を使わないと決め打ちしている（`lib/auto-request.ts`、`lib/mail-spec.ts`）。sudo が効くのは道具を入れるときと swap を作るときだけで、どちらも C3b の仕事。
- 遠くのマシンで確認コマンドを走らせて確認済みにすること。

やらないこと（この設計の外）:

- slack-issue-intake の setup（B2 で済み）。
- SSH の接続先（`orca host list` の `kind: ssh`）。元の設計 9 章の非目標。
- organization をまたぐ Project。

失敗とみなすこと:

- setup が、すでにある設定・Project の Status の選択肢・automation を、人の確認なしに消したり上書きしたりすること。
- automation に版つきのプラグインのパスを焼き込み、プラグインを更新すると動かなくなること。
- 有効化のときに見せた権限と、実際に書いた権限が違うこと。

## やり方の比較

| やり方 | 長所 | 短所 |
|---|---|---|
| **A. ターミナルの対話 CLI（採用）** | 元の設計の `make setup` のとおり。slack-issue-intake の `lib/commands/setup.ts` と同じ形（番号つきの段、途中から再開、automation は無効で登録してから有効にする）。Claude を使わないのでトークンがかからない。stub でテストしやすい | 自由な入力の解釈はできない |
| B. スキルの対話（`--auto-setup`） | 曖昧な答えにも対応できる | Claude のセッションが要る。段の再開や順序が Claude 任せになる |
| C. フラグだけの非対話コマンド | 最小で、スクリプトに組み込める | マシン選びやスペックの提示など、見て決める段に向かない |

## 設計

### 入口

- `make setup NAME=<名前>`（既定は `main`）。中身は `node bin/orca-auto.ts setup --name <名前>`。ターミナルで対話する。標準入力が端末でなければ、何も書かずに終える。
- 段の見出しは `[n/N] <段の名前>`（slack-issue-intake と同じ）。
- 答えは段ごとに、`auto/<名前>/setup.json`（下書き）へすぐ書く。`config.json` は「設定を保存する」段で一度だけ、`readAutoConfig` が読める形になったときに atomic に書く。中断しても、次の `make setup` は下書きから続ける。
- すでに `config.json` があれば、その値を各段の既定にする。値を変えない段は Enter で進める。

### 段

段の分け方と順番の細部は作る人に任せる。中身は次のとおり。

1. **前提の確認**: node（22.18 以上）、git、gh（ログイン済み）、orca（`$ORCA_BIN` か `ORCA_CLI_COMMAND`、無ければ macOS の app の中の CLI。SKILL.md の解決のしかたと同じ）。
2. **拾う元**: slack-issue-intake の設定のリポジトリ一覧（`intakeConfig`、既定は `~/.slack-issue-intake/config.json`）を読み、その中から拾う元を選ぶ。拾う条件（既定は `Ready`）。
3. **関連リポジトリ**: 拾う元ごとに、実装する可能性のあるリポジトリの組（拾う元自身を含めてよい）。リポジトリごとの情報（`repos`）は 1 回だけ持つ。全リポジトリについて、このマシンの専用の checkout のパス（`repos[r].checkout`）を聞き、`origin` が `owner/name` を指すこと、未コミットの変更が無いことを確かめる（下の「決めたこと」）。
4. **Project**（任意）: 拾う元ごとに `owner` と番号を聞く。登録したら次を行う。
   - gh の権限に `project` があるか（`gh auth status` のスコープ）。無ければ `gh auth refresh -h github.com -s project` を案内し、その段を止める（あとでやり直せる）。
   - Project の Status の選択肢に、ステータス 8 つがあるか。名前は大文字小文字を区別せずに比べる。足りなければ、足す選択肢を見せて確認してから足す。`updateProjectV2Field` は選択肢を丸ごと置き換えるので、今ある選択肢は id・名前・色・説明をそのまま渡して残す（2026-11-17 の C2c の下調べで確かめた形）。
   - GitHub の組み込みの workflow（項目を足したら Todo、閉じたら Done など）は、同期と食い違うので止めるよう案内する（setup は workflow を変えない）。
5. **ステータスラベル**: 拾う元のすべてのリポジトリに、ステータスラベル 8 つが無ければ作る。今の `ensure-labels`（`bin/orca-issue-loop.ts`）と同じ処理を使う。
6. **マシン**: `orca host list --json` の `kind: local` と `kind: environment` を並べ、使うものを選ぶ。選んだマシンごとに:
   - **接続の確認**: `orca status`（遠くは `--environment <id>`）が通るか。通らなければ、そのマシンを外すか聞く。
   - **スペックの測定**: CPU 数、メモリの総量と空き、swap、ディスクの空き。このマシンは node の `os` で直接測る。遠くのマシンは、そこで Orca の端末を作って node の 1 行を走らせ、出力を読む（そのマシンに node が要る）。使い終わった端末は閉じる。測った値は設定のそのマシンの欄に、測った時刻と一緒に保存する。swap が 0 なら注意を出す。
   - **リポジトリの置き場所**: 関連リポジトリごとに、そのマシンでの専用の checkout を確かめる。このマシンは段 3 の checkout を使い、Orca に登録されていなければ `orca repo add` する。遠くのマシンは `orca repo list --environment` から選ぶか、パスを聞いて `orca repo add --environment` する。セレクタは今の設定の形（このマシンは `path:`、遠くは `id:`）で持つ。置き場所が無いリポジトリは、そのマシンでは扱わない（`hosts[].repos` に入れない）。
   - **gh と git の認証**: このマシンは `gh auth status`。遠くのマシンは、スペックの測定と同じ端末で `gh auth status` を走らせる。通らなければ、そのマシンを外すか、ログインしてから段をやり直すかを聞く。
7. **リポジトリごとの確認**: 実装するリポジトリごとに次を聞く。
   - 確認コマンド（`verify`。複数可）。
   - インフラかどうか（`infra`）。既定は、checkout に `*.tf` があれば「はい」。
   - CI があるか（`ci`）。既定は、checkout に `.github/workflows/` があれば「はい」。
   - このマシンで確認コマンドを走らせるか。走らせるなら、checkout から一時的な git worktree を切ってそこで走らせ、終わったら消す（専用の checkout を汚さないため。build の生成物が残ると、未コミットの変更として dispatch が止まる）。全部通れば、このマシンのそのリポジトリを `verified: true` にする。遠くのマシンは `verified: false` のまま（C3b で扱う）。
8. **並列数**: マシンごとに推奨値を出し、人が確定する。
   ```text
   推奨 = max(1, min(
     floor((メモリの総量 − 予備) ÷ 1 worktree 分のメモリ),
     floor(ディスクの空き ÷ 1 worktree 分のディスク),
     CPU 数
   ))
   ```
   予備・1 worktree 分のメモリ・1 worktree 分のディスクは定数に置く（値は作る人が決める）。C3b で build の最大メモリを測るようになったら、1 worktree 分のメモリをその値で置き換える。並列数は worktree の数で数えることと、1 件が何個使うか（off/off は 1、on/off と off/on は 2、on/on は 4、対象リポジトリが 2 つならその倍）を一緒に見せる。
9. **レビューモード**: `review_mode` と `phase_b`。既定は今の `--auto` の設定、無ければ dispatch の設定（`config-resolve.ts` が返す値）。
10. **設定を保存する**: 下書きを `config.json` の形にし、変わるところを見せて確認してから書く。
11. **automation の登録**: 間隔を聞く（既定 5 分。選べる値は slack-issue-intake と同じ 1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60）。Orca の automation を**無効の状態で**登録する。すでに登録した automation があれば（id を設定に持つ）、作り直さずに `automations edit` する。
12. **有効化**: 判定の Claude に与える権限を見せ、承認されたら書いて有効にする。

### automation の中身

- **名前**: `orca-auto-<名前>`。
- **前処理（precheck）**: 安定したパスのランチャーで `tick --name <名前>`。tick は判定が要るときだけ 0 を返すので、Orca はそのときだけ Claude を起動する（Orca の precheck は 0 で続け、それ以外は飛ばす）。時間切れ（`--precheck-timeout`）は tick の予算（`AUTO_TICK_BUDGET_MS` = 100 秒）より長くする。値は作る人が決める。
- **起動するもの**: provider は `claude`。判定のモデルと effort（`judge.model` / `judge.effort`）は `--extra-agent-args` で渡す。毎回新しいセッション（`--fresh-session`）。
- **プロンプト**: `references/auto-judge.md` に従って判定させる。手で Run now したときは precheck を通らないので、判定するものが無ければ何もせずに終わる、とも書く。
- **作業場所**: `auto/<名前>/` を Orca にフォルダとして登録し（slack-issue-intake と同じ `repo add --kind folder`）、そこを `--workspace` にする。
- **版つきのパスを焼き込まない**: slack-issue-intake の `bin/launch.ts` と同じく、安定したパス（`~/.claude/config/orca-team-dispatch-task/bin/` の下）にランチャーを置き、実行のたびに今のプラグインの場所を `installed_plugins.json` から解決して `bin/orca-auto.ts` を起動する。プロンプトが指す `auto-judge.md` の場所も、ランチャーのサブコマンドで解決する（プロンプトに版つきのパスを書かない）。

### 判定の Claude の権限

slack-issue-intake の `lib/permissions.ts` と同じ考え方で、作業場所の `.claude/settings.json` に許可と拒否を書く。

- 許可: ランチャーの `judge-list --name <名前>` と `judge-apply --name <名前> --file <decisionsFile>`、判定の材料と結果のファイルの読み書き、関連リポジトリの checkout の読み取り（判定はコードを読むが変えない）。
- 拒否と、bypass を止める設定は slack-issue-intake と同じ形。
- 有効化の段で、書く内容をそのまま見せる。承認されなければ有効にしない。

### 決めたこと（私の判断。レビュー役の問いへの答え）

- **automation が動いている最中のやり直し**: 「設定を保存する」段では tick のロックを取る（`takeLockWait`。取れなければ待つか止めるかを聞く）。`state.json` で終わっていない Issue（`done` / `failed` / `stopped` / `eng` 以外）が使っているマシン・リポジトリ・拾う元を外す変更は、どの Issue が使っているかを見せて断る（その Issue が終わってからやり直してもらう）。automation は無効にしない。
- **権限が承認のあとに変わったとき**: slack-issue-intake の `poll` と同じく、有効化の段で承認した権限の指紋を設定に持ち、automation の precheck（ランチャー経由の tick）で作業場所の `.claude/settings.json` の指紋と比べる。違えば 1 行書いて 0 以外で終わり、Claude を起動しない。`make auto` の tick はこの確かめをしない（作業場所の設定が無いため）。ランチャーから呼ぶときだけ確かめる印（フラグか環境変数）は作る人が決める。
- **このマシンの checkout は必須**: tick の後片付け（push、ブランチの削除、ディスクの空き）と判定の `checkouts` はこのマシンの checkout を使い、`readAutoConfig` も全リポジトリに求める。そのため「関連リポジトリ」の段で、マシンの選択とは別に、全リポジトリのこのマシンでの checkout を聞く。このマシンを worker に選ばなくても聞く。
- **遠くのマシンの `orcaBin`**: スペックの測定と同じ端末で `$ORCA_CLI_COMMAND`、`command -v orca`、macOS の app の中の CLI の順に探し、見つけた値を見せて確定してもらう。見つからなければ人に聞く。
- **判定の手順書の呼び方**: `auto-judge.md` の決め打ちの `node <plugin>/bin/orca-auto.ts judge-list` をやめ、「プロンプトが示す `judge-list` と `judge-apply` のコマンドを使う」形に書き換える。automation のプロンプトはランチャーのコマンドを、`make auto` のプロンプトは今の `node <plugin>/bin/orca-auto.ts` のコマンドを示す。SKILL.md・guide-ja.md・`test/test-docs.sh` も揃える。
- **Project の段で止まったとき**: gh に `project` の権限が無い、または Status の選択肢を足すのを人が断ったときは、その拾う元を Project なしで下書きに残し、後の段へ進む。最後のまとめに「Project は登録していない。権限を足して（または選択肢を足して）から `make setup` をやり直す」と出す。

## 作る人に任せること

- 段の分け方と順番の細部、下書きの形、段の文言。
- スペックの測定の 1 行と、遠くの端末の出力の読み方・片付け方（元の設計でも builder に任せた）。
- 並列数の定数の値、precheck の時間切れの値。
- slack-issue-intake から写すもの（プロンプトの読み取り、ランチャー、権限）をどこまで共通の形にするか。プラグインは別々に入るので、共有のパッケージは作らない（`lib/status.ts` と同じく写して持つ）。

## 実機での確かめ

1. このマシンと Mac M2max を選び、使い捨ての orca-auto-e2e と orca-auto-e2e-2、使い捨ての Project（`tanaka-yui/projects/1`）で `make setup` を最後まで進める。できた `config.json` を `readAutoConfig` が読め、`make auto NAME=<名前>` が動く。
2. 途中で止めて `make setup` をやり直すと、済んだ段から続く。
3. Status の選択肢が足りない Project（新しく作った使い捨て）で、今ある選択肢を残したまま 8 つが足される。
4. automation が無効で登録され、有効化のあと precheck の tick が走り、判定が要るときだけ Claude が起動する。
5. gh の `project` の権限を外した状態で、Project の段が案内を出して止まる（C2c で未確認だった権限不足のエラーの実物もここで見る）。
