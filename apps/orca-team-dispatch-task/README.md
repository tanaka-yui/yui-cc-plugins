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

## 使い方

Claude Code で「orca でこのタスクを実行して」のように話しかける。
