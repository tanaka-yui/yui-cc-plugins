# orca-team-dispatch-task

Orca の worktree で 1 つのタスクを worker に実行させ、成果を親ブランチへ取り込む。

## できること

1 タスク・1 worker。起動 → 完了待ち → merge。

## 範囲と制限

Stage 1 は 1 ロールで、レビュー・PR・ループ・設定・**自動片付け**を持たない。
**制限の一覧と片付け手順の正本は skill 側にある** —
`skills/orca-team-dispatch-task/SKILL.md` の "Known limitations" と Step 5
（日本語は `references/guide-ja.md`）。ここでは繰り返さない。

## 使い方

Claude Code で「orca でこのタスクを実行して」のように話しかける。
