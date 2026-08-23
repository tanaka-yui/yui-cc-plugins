# agmsg 側へ報告したい所見

作成: 2026-08-23
対象: agmsg 1.2.1（`~/.agents/skills/agmsg`）

cmux-team-dispatch-task の調査中に見つけた、**agmsg 内部に原因がある** 2 件。dispatch 側では
回避策しか打てないので、upstream へ報告する材料としてまとめる。dispatch 側の対応は
v3.4.0 / v3.5.0 で入れた（後述）。

---

## F1. codex セッションへ「Monitor tool を起動せよ」と指示している

### 事象

`scripts/session-start.sh:365-372` は agent type で分岐せず、常にこの文面を出力する。

```
AGMSG monitor mode: invoke the Monitor tool now with the following parameters,
before any other action in this session.

  command: <watch.sh> <instance> <project> <type>
```

しかし codex には Monitor tool が無い（`types/codex/type.conf` の `monitor=no`）。
`.codex/hooks.json` の SessionStart も `session-start.sh 'codex' <project>` を呼ぶので、
codex セッションはこの指示を受け取る。

### 実害

指示に従おうとした codex セッションが、代替として **`watch.sh` をバックグラウンド端末で
起動した**。実観測（2026-08-22）:

```
kill $(cat ~/.agents/skills/agmsg/run/watch.<sid>.pid) \
  && ~/.agents/skills/agmsg/scripts/watch.sh <sid> "$(pwd)" codex <agent>
```

`watch.sh` は配信した row を、モデルがそれを読んだかどうかに関係なく既読にする。codex
セッションが idle（＝ターンを取っていない）のとき、届いたメッセージは**配信され、既読になり、
誰にも読まれずに消える**。`inbox.sh` は DB に残っていないので「新着なし」と正直に答える。

このとき `review-plan:` 2 通が失われ、依頼側のペインは応答を待ち続けた。

### 提案

`monitor=no` の type には Monitor 指示を出さない。codex には bridge 経路の説明を出すか、
少なくとも「自分で watcher を起動しないこと」を明示する。現状の文面は、Monitor を持たない
エージェントに対して**能動的に有害な行動を教えている**。

---

## F2. bridge launcher の失敗が完全に不可視

### 事象

`scripts/drivers/types/codex/codex-monitor.sh:240`:

```bash
"$launcher_cmd" codex "$PROJECT" "$SOCKET_URL" "$$" >/dev/null 2>&1 3>&- 4>&- &
```

launcher は detach され、**stdout と stderr の両方が捨てられる**。launcher 自身が
`run/codex-bridge.<key>.log` を作るのは処理がある程度進んだあとなので、それより前に失敗すると
**ログも pid も thread ファイルも何も残らない**。

### 実害

実ディスパッチで bridge が一度も attach していなかったが、原因を特定する手がかりが 1 つも
無かった。確認できたのは次の状態だけである。

| 確認項目 | 結果 |
|---|---|
| `delivery.sh status codex <project>` | `mode: monitor`（＝シムは monitor へ回す条件を満たす） |
| シムの分岐（実際の argv で実行） | `codex-monitor.sh` へ回る |
| app-server | 起動している（`run/codex-app-server.*.log` に実作業のログ） |
| `run/codex-bridge.<team>.<agent>.*` | **1 つも無い**（log / pid / thread のいずれも） |

`.pid` と `.thread` は EXIT trap で削除されない（死んだ pid のファイルが残っている実例あり）
ため、「今無い＝当時も作られなかった」と判断できる。

### 提案

launcher の出力を `run/codex-bridge-launcher.<key>.log` などへ落とす。あるいは
`codex-monitor.sh` 側で launcher の起動失敗だけでも記録する。現状は「動かなかったこと」しか
分からず、「なぜ動かなかったか」を調べる入口が存在しない。

---

## F3（小）. `codex-monitor.sh` の delivery 再設定がプロジェクトを解決する

`codex-monitor.sh:231` は `delivery.sh set monitor codex "$PROJECT"` を
`AGMSG_RESOLVE_PROJECT=0` なしで呼ぶ。dispatch は worktree を独立プロジェクトとして登録する
ようになった（v3.5.0）ので、ここで解決が走るとメインリポジトリ側へ設定が付き、登録先と
配送モードの付け先がずれうる。実害は未観測だが、`$PROJECT` は呼び出し側が明示的に渡した
パスなので、書き戻すときも同じパスを使うのが筋だと思われる。

---

## dispatch 側で入れた対応

upstream が直るまでの回避であり、根本原因には触れていない。

| 版 | 対応 |
|---|---|
| v3.4.0 | codex ロールの起動プロンプトで **watcher の自前起動を明示的に禁じる**（F1 の実害を止める。取りこぼしが「消える」から「未読で残る」に変わる） |
| v3.5.0 | `verify-roles-ready.sh` で **codex seat の有無を readiness 判定に畳み込む**（F2 の結果として seat が無いまま進むのを止める） |

dispatch は codex を正しく起動している（シムの分岐まで実測で確認済み）ので、F2 の原因は
dispatch 側には無い。
