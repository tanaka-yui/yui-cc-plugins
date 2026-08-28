# codex-exec

## Output Language

ユーザーへの質問・選択肢ラベル・表・進捗報告はすべて日本語で表示する。SKILL.md 本文が英語なのは記述の統一のためであり、ユーザーへの提示言語は変えない。

plan を独立した対話 codex に実装させ、完了を agmsg 経由で待って親を wake するスキル。

デフォルト: モデル `gpt-5.6-sol` / effort `xhigh` / カレントdir / 分割方向 right / plan は引数指定を優先し、
無指定なら `docs/superpowers/plans/` の候補をユーザーに確認する
（bin 単体実行時のフォールバックは従来どおり mtime 最新）。

## なぜこの構成か

実装を独立 codex に委ねると、設計した本人（このセッション）とは別視点で plan が具現化される。
完了検知そのものが agmsg の Monitor ストリーム: 親は SessionStart hook が起動した常駐 watcher を
持ち、そこに届くメッセージが idle 中でも親を起こす（2026-08-21 に実測済み。これに反する以前の
実測結果は、このハーネスが Monitor ツールを露出する前のものである）。

このプラグインは codex に並列実行を一切依頼しない。依頼した作業はすべて可視ペインの
フォアグラウンドで進む。

## 前提

- cmux セッション内（`CMUX_SOCKET_PATH`）。
- `codex` CLI が PATH 上。
- 親が agmsg team 参加済み（未参加ならコマンドが join を案内）。

## フォアグラウンド専用の実行

codex の子エージェントはペインでは動かない。shared local app-server daemon 上の別スレッドとして
走り、覗けるのは `codex agents` という別 TUI だけである。ペインを見ている限り「4 体が動いている」のか
「1 体も動いていない」のか区別できない。だからこのプラグインは並列を依頼するのをやめた。

これは**依頼しない**という限定であって、codex が**できない**という保証ではない。collaboration tools は
`features.multi_agent_v2 = false` でも登録されたままである（codex-cli 0.149.1 で実測。
`codex debug prompt-input` に `functions.collaboration.*` のブロックが残り、`list_agents` の実呼び出しも
成功する）。`multi_agent_v2.enabled=false` / `--disable multi_agent` / `--disable collaboration_modes` /
`non_code_mode_only=true` のいずれでも消えない。したがって codex が自発的に spawn する余地は残る。
黙り込んだセッションの検知は `bin/work-signal` の担当で、こちらの仕事ではない。

`--no-parallel` と `--agents` は削除した。渡すとペイン分割前に非ゼロ終了する。plan パスとして
黙って吸収されるより、消えたフラグだと分かる方が良い。

## 停滞検知と自動再開

対話 codex のペインは終了しないので、生存していること自体は何の証拠にもならない。タイマーで
起きたとき、ペインには答えられない問いに答えるのが `bin/work-signal` である。HEAD のコミット、
dirty なパスの集合、それらの mtime、ペインの画面をハッシュ化し、前回の起床時と比較する。
進捗があれば codex は動いていて黙っているだけ、1 回の起床を跨いで進捗が無ければ止まっている。

止まっていて、かつ到達可能なセッションには `dispatch-nudge:` を**ちょうど 1 通**送り、あとは
待ち続ける。ポーリングループは 1 本も増えない。検査の契機は元からある単発タイマーの起床だけである。

そのため `bin/cmux-codex-exec` は、起動した codex に作業開始前へ
`codex-record-session.sh` で bridge seat を記録させる。`join.sh` だけでは送信側の登録にしかならず、
seat の無いペインへの nudge は DB に書かれたまま誰にも読まれない
（`docs/notification-gaps.md` の R2）。`commands/codex-exec.md` の Step 5 は nudge の前に seat を
確認するので、「止まっている」と「止まっていて届かない」を混同せずに済む。

## 実行手順

`/codex-exec` コマンド（`commands/codex-exec.md`）の Step 0〜5 に従う。要点:

1. **plan を確定**: `$ARGUMENTS` に plan パスが無ければ `bin/cmux-codex-exec --list-targets` で
   候補を列挙し、**1 件でも** AskUserQuestion でユーザーに確認する（誤った plan の実行は
   リポジトリを書き換えるため）。0 件ならパスを尋ねる。詳細は `commands/codex-exec.md` の Step 0。
2. `whoami.sh` で親 identity（TEAM/PARENT）を解決（未参加なら join）。
3. `bin/cmux-codex-exec <PLAN> $ARGUMENTS --team <TEAM> --parent <PARENT>` でペイン起動、`token`/`codex_agent` を取得。
4. `join.sh <TEAM> <codex_agent> codex` で送信元を pre-join。
5. ターンを閉じる。完了は agmsg Monitor イベントとして届く。保険として単発の `sleep`
   background task を 1 本張り、その task id を覚えておく（`commands/codex-exec.md` の Step 4 参照）。
6. wake したら **`commands/codex-exec.md` の Step 5 に書かれたとおり**に従う。`token` の照合、
   完了時にタイマーを止める `TaskStop`、タイマーで起きたときに何かを判断する前に必ず行う
   `history.sh` の読み取り、ペイン消滅を断定する前の 1 回のリトライ、再武装の上限は、すべて
   コマンド側にしか書かれていない。このファイルから推測で補ってはならない。
