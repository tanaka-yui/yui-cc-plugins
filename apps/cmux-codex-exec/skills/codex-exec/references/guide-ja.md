# codex-exec

## Output Language

ユーザーへの質問・選択肢ラベル・表・進捗報告はすべて日本語で表示する。SKILL.md 本文が英語なのは記述の統一のためであり、ユーザーへの提示言語は変えない。

plan を独立した対話 codex に実装させ、完了を agmsg 経由で待って親を wake するスキル。

デフォルト: モデル `gpt-5.6-sol` / effort `xhigh` / カレントdir / 分割方向 right / plan は引数指定を優先し、
無指定なら `docs/superpowers/plans/` の候補をユーザーに確認する
（bin 単体実行時のフォールバックは従来どおり mtime 最新）。

## なぜこの構成か

実装を独立 codex に委ねると、設計した本人（このセッション）とは別視点で plan が具現化される。
完了検知に agmsg を使いつつ、idle 親を確実に起こすため「token 検知で exit する短命 watcher」を
background task として噛ませる（agmsg monitor push は idle 親を起こせないことを実測済み）。

## 前提

- cmux セッション内（`CMUX_SOCKET_PATH`）。
- `codex` CLI が PATH 上。
- 親が agmsg team 参加済み（未参加ならコマンドが join を案内）。

## 実行手順

`/codex-exec` コマンド（`commands/codex-exec.md`）の Step 0〜5 に従う。要点:

1. **plan を確定**: `$ARGUMENTS` に plan パスが無ければ `bin/cmux-codex-exec --list-targets` で
   候補を列挙し、**1 件でも** AskUserQuestion でユーザーに確認する（誤った plan の実行は
   リポジトリを書き換えるため）。0 件ならパスを尋ねる。詳細は `commands/codex-exec.md` の Step 0。
2. `whoami.sh` で親 identity（TEAM/PARENT）を解決（未参加なら join）。
3. `bin/cmux-codex-exec <PLAN> $ARGUMENTS --team <TEAM> --parent <PARENT>` でペイン起動、`token`/`codex_agent` を取得。
4. `join.sh <TEAM> <codex_agent> codex` で送信元を pre-join。
5. `bin/cmux-codex-wait <TEAM> <PARENT> <token> --surface <surface>` を **background task** で起動して待機
   （`--timeout` は付けない。既定は無制限で、打ち切りはペインの生存で判断する）。
6. wake 後、`status=done` ならレビュー可否を確認して `cmux-codex-review` へ、`status=gone` ならペイン確認を促す。
