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
**資源は消さない**）/ `skills/.../scripts/report-status.sh`（worker が status を書く口。移植）。

## 範囲

Stage A は **1 タスク = 1 役（design）**。レビュー無し・PR 無し・ループ無し・設定無し。
**N タスクを 1 つの Run で並列に dispatch できる**（既定上限 4）。worker のセッションは
`worker-retain` で最後まで保持し、解放は Step 6 の承認後だけ。片付けが勝手に走ることは
ない — Step 5 が削除してよいものを判定し、Step 6 が尋ねて、承認されたものだけを実行する。
recovery 機構は意図的に持たない（設計 spec 18-1 の裁定）。テストは `bash test/run-all.sh`。
