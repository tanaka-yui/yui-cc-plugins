# orca-team-dispatch-task

Orca の worktree で N タスクを worker に並列実行させ、成果を親ブランチへ取り込む。

## できること

複数タスクを 1 つの Orca Run にまとめて dispatch し（既定上限 4）、起動 → 全件の完了待ち →
merge を行う。worker のセッションは完了後もその場で保持され、片付けは確認してから、
承認されたものだけを行う。

## 範囲と制限

計画役と実装役を分けたり（`phase_b`）、レビュー役を付けたり（`review_mode`）、成果を pull request で届けたり（`integration`）できる。`--issue` で GitHub issue を claim して回せる。`review_mode=on` にすると、成果を作る役とは別に**レビュー役**が
起きて、作る前に計画を 1 往復レビューする（既定は `off`）。役ごとの agent / model / effort は
`config.json`（global と project の 2 層）で設定でき、`--setup` で対話的に書ける。
**agent がどのアカウントでサインインするかは選べない** — Orca の CLI にアクティブな
アカウントを選ぶ口が無いため、切り替えは Orca アプリ側で行う。
**片付けが勝手に走ることはない。**確認してから、承認されたものだけを片付ける。
どの手順も `node` で TypeScript を直接走らせるので、**Node 22.18 以上**が要る（`jq` は要らない）。
worker は待機に期限を持たず、進んでいないタスクは待ち続けるか止めるかをユーザーに尋ねる。
取り込み方（merge / PR）は dispatch の前に毎回尋ねる。
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

開発ガイドは [CLAUDE.md](CLAUDE.md)。テストと型検査:

```bash
bash test/run-all.sh                                        # この directory で実行
pnpm --filter @tanaka-yui/orca-team-dispatch-task check     # repository root で実行
```
