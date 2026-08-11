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

並列化は codex の裁量に任せない。起動プロンプトには「独立して進められる作業が2件以上あるときは
必ず `spawn_agent` で並列化し、`wait_agent` で回収せよ」という義務指示を載せる。並列化するのは
読み取り専用の調査と実装後の検証だけで、ファイル編集は親エージェントの逐次実行のままにする。
このプラグインは worktree を分離せずカレントディレクトリで動くため、同時書き込みは互いを
壊してしまうからである。

## 前提

- cmux セッション内（`CMUX_SOCKET_PATH`）。
- `codex` CLI が PATH 上。
- 親が agmsg team 参加済み（未参加ならコマンドが join を案内）。

## 並列実行

プロンプトには同時実行の上限（既定 4）を含む並列化ディレクティブが載り、最後に「何を spawn したか」の
サマリー表を出させる。`agent_type` の候補はカレントディレクトリの `.codex/agents/*.toml` から検出し、
description つきで列挙する。1 つも無ければ「agent_type は省略せよ」と伝える。

| 引数 | 意味 |
|------|------|
| `--no-parallel` | ディレクティブを注入しない（従来どおりの挙動） |
| `--agents <N>` | 同時実行の上限。2〜8 の整数のみ。それ以外はペイン分割前に非ゼロ終了（default: 4） |

通知配線がある場合、codex は完了メッセージに `agents=<N>` を付け、`bin/cmux-codex-wait` が
`status=done token=<token> agents=<N>` として親へ返す。

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
