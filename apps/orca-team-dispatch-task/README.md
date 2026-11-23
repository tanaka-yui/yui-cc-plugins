# orca-team-dispatch-task

Orca の worktree で N タスクを worker に並列実行させ、成果を親ブランチへ取り込む。

## できること

複数タスクを 1 つの Orca Run にまとめて dispatch し（既定上限 4）、起動 → 全件の完了待ち →
merge を行う。worker のセッションは完了後もその場で保持され、片付けは確認してから、
承認されたものだけを行う（設定 `cleanup` で、PR を作ったタスクを PR の作成直後か merge のあとに尋ねずに片付けることもできる）。
起動後と進捗の報告のたびに、タスク・役ごとの端末へ飛ぶ `orca terminal switch` コマンドを表で示す（`--auto` は `status` に出す）。

`--auto` は複数リポジトリのReadyを1本のキューにまとめ、判定・dispatch・PRのmergeまたは確認依頼まで進める。
`make auto-setup` が登録する Orca の automation が定期的に回し、report.jsonをSlack側へ渡す。このMacとペアリング済みサーバーへ空き・確認結果で振り分け、メールとoriginへのpushで成果を受け渡す。対象は1件2リポジトリまで（3つ以上はReady_Eng）。
リポジトリごとに `baseBranch`（普段の向き先）と `branches`（候補）を持てる。候補が 2 つ以上あると、`base:<branch>` ラベル→判定→（不明なら）`needs-base` で Backlog に戻して尋ねる、の順で Issue ごとの向き先を決め、普段の向き先以外への merge は必ず人に回し、merge 後は `<向き先> → <baseBranch>` の戻しの PR を作る（merge はしない）。
拾う元ごとに auto-ready（`autoReady`）を有効にすると、Backlog の Issue も判定し、自動で対応できるものを Ready に、難しいものを Ready_Eng にする。auto-ready で Ready にした Issue の PR は、既定では AI が merge せず人の確認に回す。拾う元に `autoMerge` を有効にすると、ほかの条件がそろえば AI が merge する（普段の向き先以外へは merge しない）。
slack-issue-intake の `existing` を `active` にしたリポジトリでは、GitHub で手で作った Issue も intake が取り込んでから拾い、Project の同期も Slack の印の無い Issue まで揃え、auto-ready は人が `slack-thread` を付けた古い Backlog の Issue と、ステータスラベルの無い Issue（先に Backlog を付ける）も判定する。`active` では `slack-thread` を人の印と見るので、`thread` から `active` に切り替えると、`thread` のあいだに intake が `slack-thread` を付けた Issue（古い Backlog のものも含む）が判定に回る。AI に判定させたくない Issue は `slack-thread` を外すか、先に `autoReady` を切ること。1 つのリポジトリは 1 つの intake のホームだけで扱い、ホームごとに `thread` と `active` を混ぜないこと（`thread` と書いた設定が 1 つでもあれば、orca はそのリポジトリを `active` として扱わず、リポジトリ名を 1 行出す）。
判定と結果は Issue の世代ごとに履歴へ残り、食い違いが異なる 3 件の Issue でたまったリポジトリは判定の AI が振り返って短い規則にする。規則と似た過去の事例は、次の判定の材料になる（データは `auto/<name>/learn/`、有効な規則は `status` に出る）。新しい規則は Slack（slack-issue-intake の学びの知らせ）のスレッドに「取り消し <番号>」と返信すれば、次の tick で取り下げる。`make auto-setup` で「はい」と答えた端末では、どのリポジトリでも成り立つ学びを yui-cc-plugins の改善の Issue（`judge-learning` のラベル付き）にする。AI が書いた題と本文は公開リポジトリに出るので、まず下書きとして Slack（slack-issue-intake の学びの知らせ。報告先のチャンネルを設定したときだけ全文を出す）と `status` に全文を出し、人が承認してから Issue を作る（Slack のスレッドに「公開 <番号>」、または `orca-auto.ts learn-publish --name <名前> --rule <規則の id>`）。その PR も AI が merge せず、人が merge する。
このモードだけは停止・解放とpushを確認してから資源を片付ける。使い方はskillのAuto modeを参照。
設定は `make auto-setup <name>` で行い、終えたあとにマシンだけ・`review_mode` と `phase_b` だけを変えるときは `make hosts <name>` / `make roles <name>` を使う。Issue を実装するリポジトリだけを追加・変更・削除するときは `make repos <name>` を使う（一覧から 1 件ずつ選ぶ。判定の権限の承認もやり直す）。

worker の役ごとのモデル・取りかかり方などの既定・判定役のモデル・worktree を作る場所は、`make setup <name>` で設定し直せる（`--auto` を使わない手動の dispatch の設定もここ）。

## 範囲と制限

計画役と実装役を分けたり（`phase_b`）、レビュー役を付けたり（`review_mode`）、成果を pull request で届けたり（`integration`）、PR を作ったタスクを PR の作成直後か merge のあとに尋ねずに片付けたり（`cleanup`）できる。`--issue` で GitHub issue を claim して回せる。`review_mode=on` にすると、成果を作る役とは別に**レビュー役**が
起きて、作る前に計画を 1 往復レビューする（既定は `off`）。役ごとの agent / model / effort は
`config.json`（global と project の 2 層）で設定でき、`--setup` で対話的に書ける。
**agent がどのアカウントでサインインするかは選べない** — Orca の CLI にアクティブな
アカウントを選ぶ口が無いため、切り替えは Orca アプリ側で行う。
**通常のdispatchと `--issue` では、片付けが勝手に走ることはない**（設定 `cleanup` を `pr_created` か `pr_merged` にしたときの、PR を作ったタスクを除く）。確認してから、承認されたものだけを片付ける。
どの手順も `node` で TypeScript を直接走らせるので、**Node 22.18 以上**が要る（`jq` は要らない）。
通常のdispatchと `--issue` のworkerは待機に期限を持たず、進んでいないタスクは待ち続けるか止めるかをユーザーに尋ねる。
通常のdispatchでは取り込み方（merge / PR）をdispatchの前に毎回尋ねる。
**制限の一覧と片付け手順の正本は skill 側にある** —
`skills/orca-team-dispatch-task/SKILL.md` の "Known limitations" と Step 5 / Step 6
（日本語は `references/guide-ja.md`）。ここでは繰り返さない。

## 前提

- **Orca アプリとその CLI。**CLI は `$ORCA_BIN` → `$ORCA_CLI_COMMAND` → macOS のアプリ同梱パスの順に探す。
  WSL2 では Orca が export する `orca-ide`（PATH 上）を使い、path の Windows / Linux 形式の変換はスクリプトが行う
- **Node 22.18 以上**（実行時の npm 依存は無い）
- `--issue` を使うときは **`gh`**（認証済み）
- worker に codex を使う repository は、初回に codex のフォルダ信頼が要る（起動時に案内が出る）

## 使い方

Claude Code で「orca でこのタスクを実行して」のように話しかけるか、skill を直接呼ぶ。

| 呼び方 | 動作 |
|--------|------|
| `/orca-team-dispatch-task <タスクの説明>` | タスクに分割して dispatch する。設定が 1 つも無ければ最初に 1 度だけ尋ねる |
| `/orca-team-dispatch-task --setup` | 役ごとの agent / model / effort と各設定を対話的に書く（dispatch しない） |
| `/orca-team-dispatch-task --reset` | 選んだ層の役ごとの tuple（`roles`）だけを消す（dispatch しない） |
| `/orca-team-dispatch-task --issue` | 条件（label / assignee / 同時数 / バッチ数）を 1 度尋ね、GitHub issue をバッチで claim して回す |
| `/orca-team-dispatch-task --issue <N>` | 指定した issue 1 件だけを回す（何も尋ねない） |

**親は設計しない。**親がするのはタスク分割と、dispatch 前の 1 回の質問（各タスクの取りかかり方・
取り込み方・brainstorm の質問先）だけで、brainstorming・計画・コード調査は各 worker が自分の
worktree で並列に行う。

## 設定

| ファイル | 層 |
|---------|----|
| `~/.claude/config/orca-team-dispatch-task/config.json` | global |
| `<repo>/.dispatch/config.json` | project（global を上書き） |

値は「1 回きりの上書き → project → global → 既定」の順にフィールド単位で決まる。主な設定:

| 設定 | 既定 | 概要 |
|------|------|------|
| `review_mode` | `off` | `on` でレビュー役を付ける |
| `phase_b` | `off` | `on` で計画役（`design`）と実装役（`exec`）を分ける |
| `integration` | `merge` | `pr` で merge の代わりに pull request を作る |
| `setup` | `skip` | `run` で worktree の setup hook を走らせる |
| `design_mode` | `direct` | `plan` は着手前に方針を記録、`brainstorm` は人と対話して `spec.md` → `plan.md` を書いてから作る |
| `ask_via` | `terminal` | `brainstorm` の質問先。`terminal` は worker 自身の端末で尋ね、`parent` は親セッションに取り次がせる |

`design_mode` と取り込み方は設定値を黙って使わず、dispatch ごとに推奨値として示して尋ねる
（`--issue` は無人なので設定値を使い、`brainstorm` は `plan` に落とす）。
役ごとの既定 tuple と各設定の詳細は SKILL.md の "Configuration" が正本。

## 状態の置き場所

タスクごとの状態は `<repo>/.dispatch/<slug>/`、`--issue` の state と lock は `<repo>/.dispatch-issue/` に
置かれる。どちらも repository の `info/exclude` に入るので `git status` には出ない。
中身の一覧は SKILL.md の "State on disk" を参照。

## 開発

開発ガイドは [CLAUDE.md](CLAUDE.md)。テストと型検査は `make` で走らせる（この directory で実行。
repository root からは `make -C apps/orca-team-dispatch-task <target>`）:

```bash
make            # target の一覧を表示
make test       # 全テスト (bash のテスト群 + node --test の単体テスト)
make test-unit  # lib/ の単体テストだけ
make check      # 型チェックと biome
```
