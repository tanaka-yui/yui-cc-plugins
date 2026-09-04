# orca-team-dispatch-task 開発ガイド

Orca の worktree で 1 つのタスクを worker に実行させるプラグイン。

## 正本先行の原則

**「このソフトウェアは X をする」と書く前に、X を真にするコードを書く。**
回帰は `test/test-docs.sh` が固定する（参照先の実在 / 未実装の非宣言 / 文の単一 owner）。

## ユーザー向けの文の owner

**SKILL.md が正本。**`references/guide-ja.md` は見出しも内容も完全な写し。
`README.md` は能力の要約だけで、recovery / cleanup の手順を持たない。
3 つが別々の言い方をしていたら、それは drift である。

## 構成

`bin/orca-start.sh`（worktree + 端末 + Task + Dispatch）/ `bin/orca-wait.sh`
（`worker_done` を待つ。成功 0 / 失敗 5）/ `bin/orca-merge.sh`（成果を親ブランチへ。
**資源は消さない**）/ `skills/.../scripts/report-status.sh`（worker が status を書く口。移植）。

## 範囲

Stage 1 は 1 ロール・レビュー無し・PR 無し・ループ無し・設定無し・**自動片付け無し**。
recovery 機構は意図的に持たない（設計 spec 18-1 の裁定）。テストは `bash test/run-all.sh`。
