# orca-team-dispatch-task

Orca の worktree で N タスクを worker に並列実行させ、成果を親ブランチへ取り込む。

## できること

複数タスクを 1 つの Orca Run にまとめて dispatch し（既定上限 4）、起動 → 全件の完了待ち →
merge を行う。worker のセッションは完了後もその場で保持され、片付けは確認してから、
承認されたものだけを行う。

## 範囲と制限

Stage A は 1 ロールで、レビュー・PR・ループ・設定を持たない。
**片付けが勝手に走ることはない。**確認してから、承認されたものだけを片付ける。
**制限の一覧と片付け手順の正本は skill 側にある** —
`skills/orca-team-dispatch-task/SKILL.md` の "Known limitations" と Step 5 / Step 6
（日本語は `references/guide-ja.md`）。ここでは繰り返さない。

## 使い方

Claude Code で「orca でこのタスクを実行して」のように話しかける。
