---
name: codex-exec
description: >-
  claude/superpowers が作成した plan を、新しい cmux ペインで対話 codex (gpt-5.6-sol / reasoning
  effort xhigh) にカレントディレクトリで実装させ、完了を親セッションが agmsg 経由で検知してレビューへ繋ぐ
  スキル。ユーザーが「この plan を codex に実装させて」「codex で plan を実行」「plan を回して終わったら教えて」
  「codex-exec」等と言ったとき、または書き上げた plan を独立した codex プロセスに実装させたいときに必ず使う。
  cmux セッション内 (CMUX_SOCKET_PATH) が前提。実装後は cmux-codex-review でのレビューへ繋ぐ。
---

# codex-exec

plan を独立した対話 codex に実装させ、完了を agmsg 経由で待って親を wake するスキル。

デフォルト: モデル `gpt-5.6-sol` / effort `xhigh` / カレントdir / 分割方向 right / plan は
`docs/superpowers/plans/` の最新（引数でパス指定可）。

## なぜこの構成か

実装を独立 codex に委ねると、設計した本人（このセッション）とは別視点で plan が具現化される。
完了検知に agmsg を使いつつ、idle 親を確実に起こすため「token 検知で exit する短命 watcher」を
background task として噛ませる（agmsg monitor push は idle 親を起こせないことを実測済み）。

## 前提

- cmux セッション内（`CMUX_SOCKET_PATH`）。
- `codex` CLI が PATH 上。
- 親が agmsg team 参加済み（未参加ならコマンドが join を案内）。

## 実行手順

`/codex-exec` コマンド（`commands/codex-exec.md`）の Step 1〜5 に従う。要点:

1. `whoami.sh` で親 identity（TEAM/PARENT）を解決（未参加なら join）。
2. `bin/cmux-codex-exec $ARGUMENTS --team <TEAM> --parent <PARENT>` でペイン起動、`token`/`codex_agent` を取得。
3. `join.sh <TEAM> <codex_agent> codex` で送信元を pre-join。
4. `bin/cmux-codex-wait <TEAM> <PARENT> <token> --timeout 3600` を **background task** で起動して待機。
5. wake 後、`status=done` ならレビュー可否を確認して `cmux-codex-review` へ、`status=timeout` ならペイン確認を促す。
