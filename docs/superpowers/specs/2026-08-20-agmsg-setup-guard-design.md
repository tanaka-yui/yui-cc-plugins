# agmsg セットアップガードの設計

対象: `apps/cmux-team-dispatch-task`

> 改訂 6。spec レビュー ラウンド 1〜5 の指摘を反映した。差分は末尾「改訂履歴」を参照。

## 背景

### 再現した障害

ディスパッチが agmsg を配線するとき、スキルは `delivery.sh set monitor <type> <project>` を実行する。
その出力は次を含む。

```
AGMSG-DIRECTIVE: For this running session, invoke the Monitor tool now with:
  command: /Users/…/watch.sh <session-id> <repo> claude-code
```

**このディレクティブを受け取ったオーケストレーターのセッションには `Monitor` ツールが無かった。**
よって指示は追従不能で、watcher は起動しなかった。`SessionStart` hook も同一のディレクティブを
出しており、そちらも同じ理由で無視された。`SKILL.md` はこのディレクティブを「follow it」と
書いているだけで、ツールを持たないハーネス向けのフォールバックが存在しない。

この障害は本 spec のレビュー中にも再現した。レビュアーペインは「agmsg monitor を起動する」と
宣言した直後にターンを終了し、9 分間無応答だった。ディレクティブを送らない旨を明示して再送すると
正常に完走した。**同じ抜け穴が親・設計・レビューの全ペインで発火する。**

### 調査で確定した事実

すべて実機で確認した。行番号は確認時点のもの。

1. **`watch.sh` は `Monitor` ツール無しでも動く。** バックグラウンドの素のプロセスとして起動でき、
   pidfile と ready sentinel を通常どおり生成する。`watch.sh` のヘッダー自身が
   「also works standalone as `tail -f` for inbox」と明言している。

2. **ready sentinel は `watch.sh` に role 名（第 4 引数 = `ACTIVE_NAME`）を渡したときだけ書かれる**
   （`watch.sh:385`）。role 名なしの broad 購読では生成されない。
   actas ロックの暗黙 claim は同じ条件だが別のガード（`watch.sh:241` / `:249`）である。
   **名前付きで起動すれば `watch.sh` 自身がロックを claim する**ので、呼び出し元が事前に claim する必要は無い。

3. **`delivery.sh set` は冪等**（実測）。`monitor` / `both` では `kill_all_watchers` を呼ばない
   （呼ぶのは `turn` と `off` だけ。`delivery.sh:544-573`）ので、既存 watcher を壊さない。

4. **`delivery.sh set` の出力は watcher の有無の根拠にならない。** `emit_monitor_directive` が
   ディレクティブを抑止する条件は `run/watch.<session_id>.pid` の存在と生存だけで、**project を見ない**。

5. **`watch.sh` は session_id を自前で正規化する**（`watch.sh:141`、`agmsg_normalize_instance_id`）。
   agent 種別ごとの ppid walk で祖先を探し、見つかれば `<sid>.<pid>` の composite にする。
   **pidfile は正規化後の id で決まり**（`watch.sh:145`）、起動時に同名 pidfile の生存プロセスがあれば
   それを kill して奪う（`watch.sh:165-179`、意図的な重複排除 #66）。
   したがって **guard の起動が壊しうる相手は「正規化後 id が自分と同じ watcher」だけ**である。
   正規化後 id は必ず `<渡した session_id>` そのものか `<渡した session_id>.<pid>` になるので、
   **`run/watch.<SID>.pid` と `run/watch.<SID>.<数字>.pid` の 2 形だけを見れば足りる。**

6. **composite でなければ liveness guard が効かない。** `watch.sh:407` は
   `agmsg_instance_is_composite` でゲートされている。bare id の watcher は永久に自己終了しない。
   composite なら `agmsg_instance_alive` が `_agmsg_pid_alive "$pid" || return 1` を**先に**通すので、
   `cc-instance.<pid>` の有無に関わらずその pid が死んだ時点で DEAD になり自己終了する。
   評価はループ先頭なので、**遅延は最大 `AGMSG_WATCH_INTERVAL` 秒**である。
   **これが「watcher は composite でなければならない」の唯一の根拠である。**

7. **bare id の owner 生存判定は「常に DEAD」ではない**（実測）。`agmsg_instance_alive` の bare 分岐には
   upgrade-compat（`instance-id.sh:433-436`）があり、`cc-instance.<pid>` の内容が `<token>.<数字>` なら
   bare な `<token>` も ALIVE と判定される。実測: 生きたペイン pid 4745 に対し
   bare `f0b26dc7-…` も composite `f0b26dc7-….4745` も ALIVE、未知の bare は DEAD。
   したがって `session-start.sh:224-228` の sentinel GC が bare を消すのは
   (i) codex（`cc-instance` を書かない）と (ii) ペインが既に死んでいる場合である。
   **bare を避ける理由は GC ではなく事実 6 の自己終了である。**

8. **`( cmd & echo $! )` の形は決定的に bare を生む**（実測 3/3、レビュアー側でも 5/5）。
   サブシェルが `echo $!` の直後に終了するため、バックグラウンドプロセスは即座に pid 1 へ再親付けされ、
   `agmsg_agent_pid` の `$$` からの ppid ウォーク（`resolve-project.sh:305-307`）が失敗して
   bare フォールバックに落ちる。**`setsid` も使えない**（この macOS に存在せず、util-linux 版は
   セッションを切るので ppid ウォークを確実に破壊する）。

9. **名前付き watcher は配信した行を既読にする**（`watch.sh:478` の `mark_read`）。
   スキップ条件は `[ -z "$ACTIVE_NAME" ]`、つまり broad watcher 専用である（`watch.sh:343`）。
   `inbox.sh` は `read_at IS NULL` しか表示しないので、名前付き watcher が動いているロールでは
   受信メッセージは `/agmsg inbox` に現れず、`history.sh` でのみ辿れる。

10. **`watch.sh` が sentinel を作らずに終了する主要 4 経路。** 実測した出力先と終了コード:

    | 経路 | 出力先 | 行頭の分類キー | exit |
    |---|---|---|---|
    | `:267-271` held | stderr | `agmsg watch: cannot claim` | 1 |
    | `:274-281` 未登録 | stdout | `agmsg watch: no registration` | 0 |
    | `:374-377` DB | stdout | `ERROR: cannot open message DB` | 1 |
    | `:405-408` liveness guard | **出力なし** | — | 0 |

    3 つの文言はいずれも `watch.sh` 内で 1 箇所ずつしか出現しない（実測 grep）。
    ほかに引数不足（`:56-59`）・不正 type（`:86-99`）・`ctrl:despawn`（`:467`）・シグナル（`:208`）も
    即終了しうるが、いずれも「上記以外」に落ちる。

11. **`watch.sh` の name フィルタは team を見ない**（`watch.sh:213`）。`ACTIVE_NAME` があるとき、
    同名 role が複数 team にあれば全部を claim しに行き、1 つでも他セッションが保持していれば
    `watch.sh:271` で exit 1 する。実測で `parent` は 2 team に登録されていた。
    claim できた team すべてに sentinel を書く（`watch.sh:385-394`）。
    **別ロール名の watcher は購読集合が交わらないので、互いの受信を奪わない。**

12. **`Monitor` が起動する broad watcher は name を持たない**
    （`delivery.sh:329` の `printf '%q %q %q %q'` が出す 4 トークンは
    **watch.sh のパス自身を含む**ので、`watch.sh` から見た位置引数は 3 個である）。実機でも確認した。
    **本 spec は引数の個数を `watch.sh` の `$#` で数える: broad = 3、named = 4。**

13. **codex 型には watcher を起動する既定経路が無い。** `type.conf` が `monitor=no` で、
    `_delivery.sh` の `on_enable` はシェル関数の導入手順を印字する。

14. **`launch-workspace.sh` は `--mode standby` / `--mode review` で初期プロンプトを受け付ける**
    （`:316-323` / `:723-726` / `:761-765` / `:771` / `:789-796`）。第 2 位置引数である。
    ただしプロンプトは `zsh -ic "… '<prompt>' …"` に二重埋め込みされエスケープされないので、
    **`'` `"` `` ` `` `$` `!` `\` と改行を含まない 1 行**でなければならない。改行が入ると
    `wc -l < argv.log` でペイン数を数えている既存 9 件のアサーションが同時に壊れる。
    **プロンプト中のパスもクォートできない。**

15. **codex review ペインだけ sandbox が違う。** `--sandbox workspace-write -c approval_policy='never'`
    で起動される（`launch-workspace.sh:766-771`）。**人間の承認が一切挟まらない。**
    `watch.sh` が書くのは `~/.agents/skills/agmsg/` のうち **`run/` と `db/` だけ**で、
    `scripts/` は読み取り・実行のみである。`db/messages.db` は**全 team・全プロジェクト共通**である。

16. **`prewarm-panes.sh` の既存の配線呼び出しはディレクティブを漏らしている。**
    `prewarm-panes.sh:411,417` の `>&2 2>/dev/null` はリダイレクトが左から評価されるため
    **stdout を元の stderr に複製してから stderr を捨てる**。AGMSG-DIRECTIVE は `delivery.sh:332` の
    stdout なので、そのまま呼び出し元の **stderr** へ出ている（実測）。

17. **`send-prompt.sh` の sentinel パスはエンコードしていない。** `watch.sh` が実際に作るのは
    `agmsg_ready_path`（`actas-lock.sh:69`）＝ `[A-Za-z0-9._-]` 以外を `%XX` に変換したパスだが、
    `send-prompt.sh:146` は生連結である。`TEAM="dispatch-$(basename "$(git rev-parse --show-toplevel)")"`
    なので、リポジトリ名に空白や非 ASCII が入ると発火する。
    **agent 名側は 3 経路とも `^[A-Za-z0-9._-]+$` に検証済み**（`prewarm-panes.sh:190`、
    `launch-workspace.sh:367`、(A) は `parent` 固定）なので、**エンコードが効くのは team 名側だけ**である。
    `SKILL.md:2118-2119` と `guide-ja.md:837-838` は「エンコードは不要」と書いており、この記述が偽になる。

18. **`/clear` は watcher を失わせる。** `session-start.sh:249` は SessionStart のたびに
    `cc-instance.<pid>` を新しい INSTANCE_ID で上書きする。`/clear` は新しい session_id を採番するので、
    稼働中 watcher の token は DEAD になり `watch.sh:407` が exit して `cleanup()` が sentinel を消す。
    `/compact` は同一 session_id を保つので影響しない（`session-start.sh:253-257`）。

19. **`CODEX_THREAD_ID` は fresh codex では export されない。** agmsg 本体が 2 箇所で明言している
    （`drivers/types/codex/_session-start.sh:53-54`、`codex-bridge.js:977`）。
    `launch-workspace.sh` の codex ペインは素の起動なので通常は空である。
    `SKILL.md` Step 1g の `PARENT_ENGINE` 検出も同じ変数に依存する（本 spec では扱わない既存の性質）。

20. **`agmsg_resolve_project` は呼び出し元によって team スコープが違う。**
    `join.sh:57` は team を渡すが `watch.sh:131` は渡さない。食い違えば `PAIRS` が空になり
    `no registration` へ落ちる。`watch.sh:211` は `identities.sh` の失敗もチェックしていない。
    **engine 差**: claude-code は `run/proj.<agent_pid>.project` マーカーが常に勝ってメインリポジトリへ、
    codex はマーカーを書かないのでワークツリーのまま解決される（実測 17 件）。
    **この非対称のため、プロジェクトパスで watcher を同定してはならない**（同一リポジトリ配下の
    全ワークツリー・全ディスパッチの watcher が 1 つのバケツに入る。実測で確認）。
    **codex ロールで join と watch が食い違う懸念は実測で否定された**: 既存の codex 登録を全 team 分
    列挙すると、prewarm 経由で作られたものは軒並みワークツリーのパスで保存されている
    （`dispatch-influencer-platform` の `*-codex` / `*-review` など多数）。`join.sh` も `watch.sh` も
    同じ「マーカー無し → ワークツリー」の解決に落ちるので綴りは一致する。

### 現状のロール別 watcher 実態

| ロール | 初期プロンプト | watcher | ready sentinel |
|---|---|---|---|
| parent (claude) | AGMSG-DIRECTIVE → Monitor | broad 購読 | **無し**（事実 2） |
| design (claude) | `/agmsg actas <slug>` | named | Monitor がある場合のみ |
| claude executor | `/agmsg actas <slug>-claude` | named | Monitor がある場合のみ |
| `<slug>-review` | **無し** | **無し** | **無し** |
| design (codex) / codex executor | **無し** | **無し** | **無し** |
| 非 prewarm 経路の子 | タスクプロンプトのみ | **無し** | **無し** |

## 目的

1. agmsg が「インストールされている」ことではなく「このセッションで実際にセットアップ済みである
   （inbox watcher が動いている）」ことを判定できるようにする。
2. 未セットアップのとき、追従不能なディレクティブを出して先へ進むのをやめ、**その場でセットアップを
   行ってから継続する**。
3. claude / codex の両エンジン、および親・設計・実装・レビューの全ロールについて、agmsg を配線する
   すべての経路が **定義済みの終了状態**で終わるようにする。

## watcher の価値についての正確な記述

事実 9 のとおり、名前付き watcher は配信した行を既読にする。watcher の価値は次の 2 つである。

1. **`Monitor` があるハーネスでは、行がセッションのコンテキストへ実際に注入される。** 本物の配送であり、
   既読化はその正しい帰結である。
2. **`Monitor` が無いハーネスでは、`send-prompt.sh` が inbox 記録を行うようになり、本文が
   `history.sh` から辿れるようになる。** ログとしての価値であって未読通知ではない。

どちらの場合も wake はタイプ入力が担う。**watcher の欠如は配送の欠如ではない。**

## 非目的

- **watcher の欠如を致命的にしない。**
- **セッション途中の `/clear` / resume 後の再セットアップは対象外**（事実 18）。guard は初期プロンプトから
  1 回だけ走る。`SKILL.md` に既知の制限として書く。
- **ready sentinel を watcher 無しで書かない。** sentinel の契約は `actas-lock.sh:63-68` で
  「present iff a live watcher is currently receiving for that role」と定義され、
  `spawn.sh:713` の `--wait-ready` がこれに依存している。
- codex の bridge の導入・自動化。
- agmsg 本体（`~/.agents/skills/agmsg/`）への変更。
- delivery mode の変更（`monitor` 固定）。
- **孤児 watcher の GC を `loop-cleanup.sh` に足すこと。** ペインが SIGKILL されると `watch.sh:208` の
  trap が走らず pidfile と `ready.*` が残る（実機の `run/` に既に残骸がある）。本設計はこれを増やさないが
  減らしもしない。トレードオフ 5 に既知の制限として書く。
- `loop-cleanup.sh` の leave 列挙に `<slug>-claude` が無い既存の穴。
- `SKILL.md` 全体のプレースホルダ統一。編集箇所は周囲の表記に合わせる。
- バージョン番号の更新、push、PR 作成。

## 検討したが採らなかった代替

- **`actas-claim.sh` による事前 claim（改訂 2）**: 本番の claim であり解放 CLI が無いので、watcher を
  得られない経路でロールが黒穴になる。
- **prewarm による代理起動と `AGMSG_AGENT_PID=`（改訂 1）**: bare id を生み、事実 6 の自己終了が働かない。
- **既存 watcher の置換と復元（改訂 3 の手順 7）**: `ps` の argv 文字列を再実行する形は、Claude Code の
  Bash ツールが張るラッパーシェル（`eval '…' && pwd -P >| …`）を掴むと任意コード実行になる。
- **プロジェクトパスで watcher を同定する（改訂 4）**: 事実 20 のとおりスコープがリポジトリ全体に広がり、
  無関係な並行ディスパッチの watcher で全ロールの guard が抑止される（実測）。

## 設計

### 中核方針

> **1. watcher は、そのロールのペイン自身が、自分のセッション id で起動する。**
> 起動は `nohup … &` の 1 行で行い、サブシェルにも `setsid` にも包まない（事実 8）。
>
> **2. guard は「自分の起動が壊しうる watcher」が生きているときだけ何もせずに終わる。**
> 判定対象は事実 5 のとおり `run/watch.<SID>.pid` と `run/watch.<SID>.<数字>.pid` の 2 形だけである。
> それ以外の watcher（他ペイン・他ディスパッチ・他プロジェクト）は `watch.sh` の重複排除の対象外なので、
> guard の起動によって壊れない。**触らないし、待たない。**

方針 2 のスコープが **session id** であることが要点である。プロジェクトや型でスコープすると、
事実 20 により同一リポジトリ配下のあらゆる watcher が候補に入り、無関係な並行ディスパッチ 1 本で
全ロールの guard が抑止される。

方針 2 の帰結:

- `Monitor` が SessionStart 由来の broad watcher を立てているペインでは、その watcher の正規化 id は
  guard が渡す `$SID` と同一なので候補に入り、guard は何もしない。**注入する watcher（価値 1）を
  注入しない watcher（価値 2）で置き換えない。** そのロールに sentinel は生まれず、
  `send-prompt.sh` は現行どおり typed-only へ縮退する。
- **他セッションが同じロールの watcher を持っている場合は候補に入らない**ので guard は起動を試み、
  `watch.sh` の claim が `cannot claim` で失敗して `reason=held-by-other-session` と復旧手順が出る。
  これは正しい振る舞いである（旧ペインの watcher を「自分のもの」と誤認しない）。
  ただし `held` は保証されない。`actas_lock_claim`（`actas-lock.sh:140-183`）は owner が DEAD 判定なら
  **stale としてロックを奪う**。DEAD 判定は `agmsg_instance_alive` なので、owner の token が bare の場合
  （codex は `cc-instance` を書かない）や `cc-instance.<pid>` が別 token を指す場合（`/clear` 後の旧 watcher）は
  奪取が成立し、同一 (team, role) を 2 本が購読する split-brain になる。
  **これは agmsg 本体の性質であり本 spec は変更しない。**
- 「他プロジェクト・他ディスパッチの watcher は構造的に候補へ入らない」は正しいが、
  **同一 session_id を共有する兄弟プロセス（`instance-id.sh:4-7` の `--continue` / `--resume` 並走）は
  候補に残る**。「構造的に起きない」と言い切れるのは前者だけである。
- guard が watcher を起動するのは「**このセッションに watcher が 1 つも無いとき**」だけであり、
  その watcher の stdout は `$LOG` で誰も読まない。これが `AGMSG_WATCH_INTERVAL` を上げてよい根拠である。

### 1. 新スクリプト `scripts/ensure-agmsg-ready.sh`

```
ensure-agmsg-ready.sh --type <claude-code|codex> --name <agent> [--project <path>]
```

| フラグ | 既定 | 意味 |
|---|---|---|
| `--type` | 必須 | `claude-code` または `codex` |
| `--name` | 必須 | このセッションが名乗る agmsg agent 名。`^[A-Za-z0-9._-]+$` |
| `--project` | `$PWD` | プロジェクトパス。解決は `watch.sh` が内部で行う |

`--project` を省略可にしたのは、初期プロンプトが事実 14 の制約でパスをクォートできないためである。
ペインの cwd は必ずワークツリーなので、省略が常に正しい値になる。(A) だけは明示的に
`--project "$(pwd)"` を渡す（`SKILL.md` の他のコマンド例と同じ書き方に揃える。値は同じ）。

| 環境変数 | 既定 | 用途 |
|---|---|---|
| `AGMSG_DIR` | `$HOME/.agents/skills/agmsg/scripts` | agmsg スクリプトの場所。**比較前に絶対パス化する**（`~` を残さない） |
| `AGMSG_READY_DIR` | `${AGMSG_READY_DIR:-$(dirname "$AGMSG_DIR")/run}` | sentinel と pidfile の場所。**明示指定を常に優先**。ただし **`$(dirname "$AGMSG_DIR")/run` と一致していなければならない**（agmsg 本体はこの変数を読まず常に自分の `$SKILL_DIR/run` を使う） |
| `AGMSG_LOG_DIR` | `${TMPDIR:-$HOME/.cache}/agmsg` | watcher のログの置き場 |
| `AGMSG_READY_TIMEOUT` | `15` | guard が sentinel の出現を待つ上限秒数。**値域検証あり**: 全桁数字でない / 空 / 先頭ゼロ（`0*`。`0` 単体と `08` / `010` / `0000` を含む）/ 5 桁以上は既定 `15` へ倒す。先頭ゼロを弾くのは bash 算術が 8 進として読むため（`08` は「value too great for base」で `deadline` の算出ごと落ち、`010` は無言で 8 秒になる）。4 桁上限が要るのは 20 桁のような値が `deadline=$(( ... * 5 ))` で 64bit ラップし、待機が事実上無限になるため（旧実装ではさらに `seq 1 <巨大>` が xrealloc の致命エラーになり、EXIT trap すら走らず 0 行 rc 2 だった） |
| `AGMSG_WATCH_INTERVAL` | `30` | 起動する watcher へ export するポーリング間隔（`watch.sh:148` が env を最優先） |
| `AGMSG_EXPECTED_NAME` | 未設定 | 設定されていて `--name` と一致しなければ exit 2（後述） |

`AGMSG_READY_TIMEOUT` は guard 側の待機上限、`AGMSG_WATCH_INTERVAL` は watcher 側のポーリング間隔で、
役割が違う。前者は sentinel の出現待ちにしか使わない。

session id: `--type claude-code` なら `$CLAUDE_CODE_SESSION_ID`、`--type codex` なら
`$CODEX_THREAD_ID` **のみ**を見る。**空なら guard 自身が `agmsg-$(uuidgen | tr 'A-Z' 'a-z')` を
1 回生成して `$SID` とする。`-` は渡さない**（`-` を渡すと `watch.sh` が起動ごとに別 uuid を採番し、
同一ペインで guard が 2 回走ったときに 2 本目が 1 本目に held される。事実 19 のとおり codex では常にこの経路）。

#### テスト隔離の不変条件

> **候補集合は `$AGMSG_READY_DIR/watch.*.pid` に限られる。`ps` を全走査してはならない。**
> **かつ `AGMSG_READY_DIR` は `$(dirname "$AGMSG_DIR")/run` と一致していなければならない。**

`ps` 全走査を選ぶと `AGMSG_READY_DIR` の差し替えが効かなくなり、テストがマシン状態依存になる。

後半の条件が要るのは、**agmsg 本体が `AGMSG_READY_DIR` を読まないから**である
（`watch.sh:144` / `actas-lock.sh:36` / `resolve-project.sh:49` はいずれも自分の `$SKILL_DIR/run` を使う）。
隔離を成立させているのは 2 変数を**同じ stub ツリーへ揃えて渡すこと**であって、`AGMSG_READY_DIR`
単独ではない。片方だけ差し替えた実行では、guard は毎回「候補ゼロ → 起動 → 手順 9 で pidfile が
見つからない」に落ちる。環境変数表にも同じ注記を置く。

#### 共通ルール

**正規化 id の取得**: 候補は pidfile 経由でしか得ないので、**正規化 id は pidfile 名そのもの**である。
剥がしは `session-start.sh:221` と同形にする。

```bash
id=${f##*/}; id=${id#watch.}; id=${id%.pid}
```

**自セッションの候補かの判定**: `$id` が `$SID` と等しい、または `$SID.` で始まり残りが全数字。
`.` の後ろが自分の agent pid かまでは見ない。`instance-id.sh:4-7` のとおり `claude --continue` /
`--resume` の並走は同一 session_id を共有するので、**兄弟プロセスの pidfile も候補に残る**。
実害は限定的（名前が違えば `existing-other` に落ち、`watch.sh:213` の name フィルタで誤配送は起きない）だが、
そのロールは sentinel を得られない。

**生存判定**: `_agmsg_pid_alive_local`（`instance-id.sh:112-139`）と**同じ意味論**で行う。すなわち
`kill -0` の成功は生存、失敗はエラー文字列を見て **ESRCH（`no such process`）のときだけ死**、
EPERM とその他は生存とみなし、ESRCH のときだけ `ps -o stat=` で裏を取って `Z*` を死とする。
**素の `kill -0` の終了コードだけを読んではならない。** `instance-id.sh:36-38` が
「これが唯一使ってよい liveness チェックである。素の `kill -0` は『シグナルを送れるか』であって
生存判定ではない」と名指しで禁じており、サンドボックスは実際に EPERM を返す。
素の `kill -0` を使うと、(a) 手順 5 で生きた候補を「死」と誤判定して起動し、`watch.sh:167` が
**注入中の broad watcher を kill する**、(b) kill 規則 4 で「死んだ」と誤判定して
**生きた watcher の sentinel を消す** — どちらも中核方針 2 の直接違反になる。

**composite 判定**は `agmsg_instance_is_composite`（`instance-id.sh:171-183`）の 3 条件を逐語で写す。
(1) `.` を含む (2) 最後の `.` より前が**非空** (3) 最後の `.` より後が**全数字**。

**watcher プロセスの同定**（pid 再利用への防御）: `ps -ww -p <pid> -o args=` を取り、
argv[0] または argv[1] が `$AGMSG_DIR/watch.sh` と**フルパスで等価**であること。
これは agmsg 本体（`watch.sh:171` ほかは部分文字列照合）より**厳しい**が、Claude Code の Bash ツールが
張るラッパーシェル（argv[0]=`/bin/zsh`, argv[1]=`-c`）を確実に落とすために意図的にそうする。
`agmsg_args_is_grok_watcher` から採るのは **fail-closed の方針**（空白分割・位置引数照合）だけである。
**guard はパスを正規化しない**（受け取った文字列のまま比較する。macOS の `/var` と `/private/var` を
持ち込まない）。`$AGMSG_DIR` に `~` が残っている場合は一致しないので、**比較前に絶対パス化する**。

**名前スロットの照合**: `<name>` の一致判定は「argv のどこかに含まれる」ではなく
**空白分割後の 5 番目のトークン（`bash` / `watch.sh` / `sid` / `project` / `type` / `name` のうち
`watch.sh` を 1 番目に数えた `name` スロット）が `<name>` と等価**であることに固定する。
「どこかに含まれる」だと、broad watcher の型引数（`claude-code` / `codex`）や
プロジェクトパスの 1 コンポーネントが `--name` と一致して誤ヒットする。`$SLUG` が `codex` のタスクは実在しうる。

#### 処理

1. **引数検証。** 次のいずれかで **exit 2**（`delivery.sh` / `watch.sh` を 1 度も呼ばない）。
   必須 2 フラグの欠落 / 未知フラグ / `--type` が `claude-code` `codex` 以外 /
   `--name` が `^[A-Za-z0-9._-]+$` に一致しない / `--project` が存在しないディレクトリ /
   **`AGMSG_EXPECTED_NAME` が設定されていて `--name` と一致しない**。

   `AGMSG_EXPECTED_NAME` は **`launch-workspace.sh` だけ**が export する
   （`prewarm-panes.sh` は `launch-workspace.sh` を引数付きで呼ぶだけでシェルコマンドを組み立てないので、
   担当にできない）。手段は **runner script の heredoc に `export AGMSG_EXPECTED_NAME='<name>'` を
   1 行足す**（ヒアドキュメント内なので事実 14 の禁止文字制約は掛からない）。値は既に受け取っている
   `--agmsg-from` を使う。

   **これはセキュリティ境界ではない。** guard が読む env はモデルが完全に制御でき、
   `env -u AGMSG_EXPECTED_NAME …` でも `watch.sh` を直接叩いても回避できる。狙いは
   **実装バグや配線ミスでロール名がずれたときに早期に落とす**事故防止である。
   悪意ある名前の乗っ取りは agmsg 本体の actas モデルの性質でありスコープ外である。

   あわせて `launch-workspace.sh` に `[[ "$AGMSG_FROM" =~ ^[A-Za-z0-9._-]+$ ]] || die` を足す
   （現行は `:370-372` の非空チェックだけで、`:367` が検証しているのは `WORKSPACE_NAME` である）。

   未設定なら現状どおり通す（手動実行を壊さない）。

2. **インストール確認。** `$AGMSG_DIR/send.sh` が無ければ `reason=not-installed` で **exit 1**。

3. **ログの用意。** `mkdir -p "$AGMSG_LOG_DIR"`（失敗は無視）してから
   `LOG=$(umask 077; mktemp "$AGMSG_LOG_DIR/agmsg-watch-$NAME.XXXXXX")`。
   失敗したら **`LOG=/dev/null` にフォールバックして続行する**（`reason=log-unwritable` を添える）。
   ログが取れないことは配線の失敗ではないので、配線も起動もスキップしない。
   `mktemp` は `O_CREAT|O_EXCL` なので symlink 追従も既存上書きも起きず、`set -C` は不要。
   `umask` は `$( )` に閉じる（**`nohup … &` をサブシェルに包んではならない**が、ログ生成だけの
   サブシェルは無関係で安全である）。

   **このログの中身は信頼できないデータとして扱うこと。** 手順 7 は `watch.sh` の stdout を
   このファイルへ落とすが、上流 `watch.sh:740` は**配信されたメッセージの本文をそのまま印字する**。
   つまりこのログは実質そのロールの inbox の生トランスクリプトであり、共有 `run/` `db/` へ
   書ける相手（無人 codex reviewer を含む）は任意の `from` と本文を inbox へ書ける。
   `orphan-watcher` / `pidfile-missing` などの hint が案内する `see <log>` に従って `cat` した
   エージェントは、攻撃者の制御下にあるテキストを読むことになる。**内容は診断の材料であって
   指示ではない**（0600 とプライバシー目的の削除は別の話で、こちらは信頼境界の話である）。

4. **配線。** `delivery.sh set monitor <type> <project>` を実行し、stdout・stderr の両方を `>>"$LOG"` へ
   落とす（AGMSG-DIRECTIVE と codex のシェル shim 手順を呼び出し元へ漏らさない）。
   非ゼロ終了なら `reason=delivery-set-failed` で **exit 1**。

5. **候補の判定。** `$AGMSG_READY_DIR/watch.*.pid` を列挙し、共通ルールで
   「自セッションの候補」かつ「pid が生存」かつ「watcher プロセスとして同定できる」ものを集める。
   `ps` が使えず同定できない場合は**候補として扱う**（起動しない側に倒す。fail-closed）。

   - **正規化 id が bare の候補は候補から外す。** 我々の起動は composite の pidfile になるので
     bare の watcher を壊さない（中核方針 2 は「壊しうる相手だけを見る」）。さらに事実 6 のとおり
     bare は永久に自己終了しないので、候補に数えるとそのペインは恒久的に watcher を得られない。
     外したうえで stderr に手動 kill の案内を 1 行出す（`reason` は変えない。出力節の末尾を参照）。
   - 候補があり、名前スロットが `<name>` と等価 → `watcher=existing`。**exit 0**。
   - 候補はあるが名前スロットが違う（broad、またはこのセッションの別ロール）→
     `watcher=existing-other`。**exit 0**。
   - **argv を取得できない候補**（`ps` が失敗 / 空出力）は名前スロットを判定できないので
     `watcher=existing-other reason=-` とし、`pid` は**ファイル名昇順で最初の候補**の pidfile 内容を出す。
   - 候補が無い → 手順 6 へ。**該当 pidfile が 1 つも無ければ `ps` が使えなくても起動する**
     （fail-closed の実効範囲は「候補があるとき」に限られる）。

6. **stale sentinel の掃除。** `$AGMSG_READY_DIR/ready.*__<encoded name>` を glob し、各ファイルの中身
   `T` について **`$AGMSG_READY_DIR/watch.$T.pid` が存在せず、または存在してもその pid が死んでいる**
   ときだけ `rm -f` する。生きた watcher の sentinel を消すと sentinel は再作成されないので
   （`watch.sh:385-395` は起動時 1 回のみ）、そのロールが永久に不可視になる。
   **`agmsg_instance_alive` 相当の判定は使わない** — 事実 7 のとおり bare の生存を正しく判別できず、
   生きた watcher の sentinel を消す経路が残るためである。pidfile を根拠にすれば取り違えない。

7. **起動。**

   ```bash
   AGMSG_WATCH_INTERVAL="${AGMSG_WATCH_INTERVAL:-30}" \
   nohup bash "$AGMSG_DIR/watch.sh" "$SID" "$PROJECT" "$TYPE" "$NAME" </dev/null >>"$LOG" 2>&1 &
   WATCH_PID=$!
   ```

   - **サブシェルで包まない / `setsid` を使わない / `bash -c` を挟まない**（事実 8。`bash -c` は
     `$!` が中間シェルの pid になる）。
   - **fd 3 本すべてを付け替える。** どれかを呼び出し元のパイプに残すと、コマンド置換やツール実行が
     パイプの EOF を待って戻らなくなる。逆に stderr だけ残すと呼び出し元終了後の書き込みで
     watcher が SIGPIPE で無言死する（`watch.sh` に PIPE trap は無い）。

8. **待機。** 0.2 秒間隔、上限 `AGMSG_READY_TIMEOUT` 秒。

   - **sentinel が出現し、かつその中身が自分の watcher の正規化 id と一致** → `WATCH_PID` の生存を
     再確認する（`watch.sh` が sentinel を書いた直後に `:407` で exit し、EXIT trap が sentinel を
     消すレースがある）。生きていれば手順 9 へ。死んでいれば下の分類器へ落とす。

     **中身の一致確認が必須である。** 手順 6 が残すのは「pidfile があり pid が生きている」sentinel、
     すなわち**他セッションの生きた watcher の sentinel**である。存在だけを見ると、
     他セッションが同ロールを保持しているケースで即座にヒットし、我々の `watch.sh` が
     `:253` の claim 失敗で exit する**前**に `watcher=started reason=-` を返してしまう。
     結果そのロールは watcher 無しなのに正常終了が報告され、`held-by-other-session` の復旧手順が出ない。
     自分の正規化 id は手順 9 と同じ手続き（`watch.*.pid` から `WATCH_PID` を含むものを探す）で得るので、
     **手順 9 の pidfile 探索をここへ前倒しする**のが素直な実装である。
   - **`WATCH_PID` が死んだ** → `$LOG` を**行頭アンカー**で分類する（事実 10）。全文 grep にすると
     `$LOG` に入る inbox 本文（`watch.sh:469`）が分類器に食われる。
     `LOG=/dev/null` にフォールバックした場合は常に「上記以外」に落ちる。
     行頭アンカーで十分な根拠: `watch.sh:411-417` は本文の CR / LF をリテラル `\n` へ置換してから
     `<ts> | <team> | <from> → <to> | <body>` の 1 行として出すので、**inbox 本文が行頭に来ることは無い**。
     全文 grep だと本文中の同一文字列を拾うが、行頭アンカーなら拾わない。

     | 行頭パターン | `reason` |
     |---|---|
     | `^agmsg watch: cannot claim` | `held-by-other-session` |
     | `^agmsg watch: no registration` | `not-registered` |
     | `^ERROR: cannot open message DB` | `db-unavailable` |
     | 上記以外（liveness guard は空ログ） | `watcher-exited` |

   - **時間切れ** → 下の kill 規則で終了させ、`reason=start-timeout`。

   **kill 規則:**

   1. 値域検証。`^[1-9][0-9]*$` かつ `2147483647` 以下（`instance-id.sh:69-99` と同じ。
      `kill 0` は呼び出し元のプロセスグループ全員に SIGTERM を送る）。
   2. 共通ルールの watcher 同定（フルパス cmdline 照合）に通ること。
      **同定できない（`ps` が失敗した / 出力が空だった）ときは kill しない。**
   3. **SIGTERM のみ。`kill -9` は使わない。** `watch.sh:208` の `trap 'exit 0' INT TERM HUP` と
      EXIT trap の `cleanup()` が pidfile と sentinel を掃除する唯一の経路である。
   4. kill 後、上限 2 秒・0.1 秒間隔で `kill -0` が失敗するまで待つ。
   5. **`kill -0` の失敗を確認できたときだけ** sentinel を掃除する（手順 6 と同じ glob と条件）。
   6. 規則 2 で kill を諦めた場合、または規則 4 で 2 秒以内に死ななかった場合は
      `reason=orphan-watcher` とし、**stderr に pid と `$LOG` のパスを出して手動 kill を案内する**。
      sentinel は消さない（watcher が生きている可能性があるため）。

9. **composite 検証。** `$AGMSG_READY_DIR/watch.*.pid` から `WATCH_PID` を含むものを探し、
   共通ルールで正規化 id を取る。composite でなければ手順 8 の kill 規則で終了させ、
   `reason=bare-started` を返す。bare へ落ちる経路は `ps` 不可・20 hops 超・プロセス階層の変更で残るので、
   「サブシェルを外したから composite になるはず」で済ませない。
   composite なら `watcher=started`。

   **pidfile が 1 つも見つからない場合は「bare」ではない。** `AGMSG_READY_DIR` の指し違い
   （テスト隔離の不変条件を破った実行）や `$SID` に `/` が混ざって `watch.sh:181` の書き込みが
   失敗した場合に起きる。この分岐で kill してはならない — 自分が今起動した健全な watcher を
   毎回殺すことになる。**kill せずに `reason=pidfile-missing` を返す**（`watcher=none`、exit 0、
   stderr に `AGMSG_READY_DIR` の値を出す）。
   `bare-started` で kill するとそのロールは watcher ゼロになるが、bare watcher も配送自体は正常に行う。
   それでも kill するのは、自己終了しない leak を作らないための意図的な選択であり、
   失うのは inbox 記録だけで配送は typed-only へ縮退する。

10. **正常系のログ削除。** `watcher` が `started` / `existing` / `existing-other` かつ
    `reason ∈ {-, log-unwritable}` のとき、`$LOG` を `rm -f` して `log=-` を返す。
    **`$LOG` が `/dev/null` のときは削除しない。**

    このガードは必須である。`log-unwritable` は `LOG=/dev/null` にフォールバックしたうえで
    `watcher` が通常どおり付くので、ガードが無いと `rm -f /dev/null` が走る。
    root で動く CI / コンテナでは成功して `/dev/null` が通常ファイルになり、以後そのコンテナの
    あらゆるスクリプトが壊れる。非 root では `rm` が rc 1 を返し、`set -euo pipefail` 下で guard が
    そこで死んで「全経路で必ず 1 行出す」契約が破れる。**どちらもテストでは検出されない。**

    削除の目的は**平文の平置きを消すこと**である。`$LOG` には inbox 本文が入る（`watch.sh:469`）。
    ディスク使用量は減らない — POSIX では最後の fd が閉じるまで inode もデータブロックも解放されず、
    watcher はペイン終了まで開き続ける。`ls` にも `du` にも現れないので、事後解析が要るときは
    `lsof -p <pid>` を使う。

#### 出力

**全経路で必ず 1 行、次の 7 キーをこの順で出す。**

```
ensure-agmsg-ready: installed=<yes|no> wired=<yes|no> name=<a|-> watcher=<existing|existing-other|started|none> pid=<n|-> reason=<slug|-> log=<path|->
```

`-` を許すキーは `name` / `pid` / `reason` / `log` の 4 つだけ。`installed` / `wired` / `watcher` は
必ず値域内の値を取る。`wired` の定義は「手順 4 の `delivery.sh set` が成功したか」。

| `reason` | installed | wired | name | watcher | pid | log | exit | stderr |
|---|---|---|---|---|---|---|---|---|
| `-` | yes | yes | name | `existing` / `existing-other` / `started` | pid | `-` | 0 | （bare 候補を外したときと、`AGMSG_DIR` / project パスに空白があるときだけ 1 行、後述） |
| `not-installed` | no | no | name | none | - | - | **1** | `agmsg is not installed at <AGMSG_DIR>` |
| `log-unwritable` | yes | yes | name | 通常どおり | 通常どおり | - | **0** | `cannot create a log under <AGMSG_LOG_DIR>; diagnostics disabled` |
| `delivery-set-failed` | yes | no | name | none | - | path | **1** | `see <log>` |
| `pidfile-missing` | yes | yes | name | none | - | path | **0** | `no pidfile under <AGMSG_READY_DIR>; it must match $(dirname AGMSG_DIR)/run` |
| `not-registered` | yes | yes | name | none | - | path | **0** | `run join.sh for this role first; see <log>` |
| `held-by-other-session` | yes | yes | name | none | - | path | **0** | `run /agmsg drop <name> in the owning session, then retry` |
| `db-unavailable` | yes | yes | name | none | - | path | **0** | `see <log>` |
| `watcher-exited` | yes | yes | name | none | - | path | **0** | `see <log>` |
| `start-timeout` | yes | yes | name | none | - | path | **0** | `see <log>` |
| `bare-started` | yes | yes | name | none | - | path | **0** | `see <log>` |
| `orphan-watcher` | yes | yes | name | none | pid | path | **0** | `watcher <pid> did not stop; kill it manually. see <log>` |
| `interrupted` | 到達時点の値 | 到達時点の値 | name | none | **この呼び出しが起動し（`$WATCH_PID`）、今も生きている watcher のときだけ pid。それ以外は `-`** | path（手順 10 の `guard_drop_log` 後に撃たれると `-`） | **128+n** | （追加の行は出さない） |
| `usage` | no | no | `--name` が値域検証に通ったときだけ実値、通らなければ `-` | none | - | - | **2** | usage メッセージ |

exit 2 の行について 3 点。`reason` は文字列 `usage` である。`name` に**未検証の値をそのまま印字しない**
（`--name "a b"` や改行入りの値で「必ず 1 行」契約が壊れる）。`installed` / `wired` は
その時点で**未検査**だが `-` を許すキーではないので `no` と書く（「未検査を `no` で表す」）。

`log-unwritable` は他の `reason` と**併記されない**（`reason` は 1 値）。ログが作れなかった実行で
その後 `reason` が付くケースでは**後者を優先する**。このとき表の `log` 列が `path` となっている 6 行
（`delivery-set-failed` / `pidfile-missing` / `not-registered` / `watcher-exited` / `start-timeout` /
`bare-started` / `orphan-watcher`）は実際には `log=-` になり、stderr の `see <log>` も `see -` になる。
**`log` 列は「ログが作れた場合の値」を表す。**

`interrupted` は **EXIT trap 専用の値**である。SIGTERM / SIGHUP（ペインを閉じた・ツール呼び出しを
中断した）で guard 自身が死ぬと bash は EXIT trap を走らせるので、`REASON` が初期値 `-` のまま
emit すると「`reason=-` なのに `watcher=none`」という表に無い行になる。trap は `REASON` が `-` の
ときだけ `interrupted` を立て、**この呼び出しが起こした孤児 watcher** の pid も出す（手動 kill
できるようにするため）。`REASON` が既に付いている場合はその値を優先する。exit code は 128+n なので
Step 1g の `case` は `*)` に落ちる。

`interrupted` 行の `pid` 列は他の行より**狭い**。trap は次の 3 段でしか pid を出さない:

1. `WATCHER=none` と `PID="-"` を無条件に先置きする。手順 5 の `PID="$CAND_PID"`（既存 watcher の
   pid）は trap のガードの外側で代入されるので、これが無いと `watcher=none pid=<他人の生きた
   watcher>` になり、「自分が起こした孤児だから手動 kill せよ」と読ませてしまう。
2. `$WATCH_PID`（この呼び出しが起動した watcher）が**今も生きている**ときだけ候補にする。
   `guard_stop_watcher` の 2 秒待機中に撃たれても、SIGTERM で既に死んだ pid は出ない。
   生きているなら SIGTERM を無視する本物の孤児なので、報告するのが正しい。
3. `guard_is_watcher` が **rc 1（watcher ではないと確定）を返したときだけ**抑止する。
   rc 2（`ps` が使えず判定不能）では抑止しない。上流 `watch.sh:205-207` も「ps unavailable
   (Claude Code sandbox 等)」を想定して `kill -0` へフォールバックし displace 対象に**残す**側へ
   倒しており、guard の手順 5（rc 2 → `other` 扱い）と `guard_stop_watcher`（rc 2 → kill しない）も
   同じく「情報を捨てない / 撃たない」側である。ここだけ逆に倒すと sandbox 内で孤児 pid が
   どこにも出ず手動 kill できなくなる。

bare 候補を手順 5 で外したときは、`reason` を変えずに stderr へ 1 行だけ出す:
`a watcher with a bare instance id is running for this role (pid <n>); it will never self-terminate — kill it manually`。

`reason=-` の成功行に stderr が付きうる **2 例目**が `AGMSG_DIR` / project パスの空白検出である。
`guard_is_watcher` / `guard_name_slot` は `ps -o args=` を `set -- $args` で単語分割するので、
空白入りのパスはトークン等値比較を必ず外す。`AGMSG_DIR` 側は既存 watcher の識別が全滅して
毎回この役割の watcher を起こし直すことになり（上流 `watch.sh:223-238` の predecessor displace が
先住を SIGTERM するので**蓄積はしない**が、チャーンに加え、`guard_stop_watcher` も同じ
比較を通るため SIGTERM を送る前に return してしまい、start-timeout / bare-started の各経路では
`orphan-watcher`（誤警報ではなく正しい報告）として手動 kill を要求される — sentinel を正しく
書けた通常の成功経路は `guard_stop_watcher` を経由しないため `watcher=started` のまま影響しない）、
project 側は argv 位置がずれて自分の watcher が
`existing-other` に化ける。どちらも正常に見える壊れ方なので、回復手順つきの hint を 1 行出す。
既定の `AGMSG_DIR` にも通常のリポジトリパスにも空白は現れないため、通常運用では従来どおり
stderr 0 行である。回帰は AR33 / AR33b。

`not-registered` が exit 0 なのは、その時点で `delivery.sh set` が成功しており**配線はできている**ためである。
exit 1 にすると (A) が `TEAM=""` と `AGMSG_INSTALLED=false` を立て、
**親ロール 1 つの登録不整合でディスパッチ全体が agmsg を捨てる**。
`not-registered` の意味は「未登録、または join 時と別 project へ解決された（事実 20）、
または `identities.sh` の解決失敗」である。

**watcher を起動できなかったことは決して exit 1 にしない。**

### 2. 呼び出し箇所

#### (A) 親オーケストレーター — `SKILL.md` Step 1g

**rc の分岐はこの fenced block の中に書く**（AG1 がブロックを抽出して実行するため）。

```bash
TEAM="dispatch-$(basename "$(git rev-parse --show-toplevel)")"
PARENT_ENGINE="claude"
[[ -n "${CODEX_THREAD_ID:-}" ]] && PARENT_ENGINE="codex"
PARENT_AGMSG_TYPE=$(bash <SKILL_DIR>/scripts/resolve-agmsg-type.sh --engine "$PARENT_ENGINE") || exit 1
~/.agents/skills/agmsg/scripts/join.sh "$TEAM" parent "$PARENT_AGMSG_TYPE" "$(pwd)" >/dev/null 2>&1 || true
AGMSG_RC=0
AGMSG_STATE=$(env -u AGMSG_EXPECTED_NAME bash <SKILL_DIR>/scripts/ensure-agmsg-ready.sh \
  --type "$PARENT_AGMSG_TYPE" --name parent --project "$(pwd)") || AGMSG_RC=$?
case "$AGMSG_RC" in
  0) case "$AGMSG_STATE" in
       *"watcher=none"*)           echo "[warn] agmsg watcher not running ($AGMSG_STATE)" ;;
       *"watcher=existing-other"*) echo "[warn] agmsg inbox records are off for parent ($AGMSG_STATE)" ;;
     esac ;;
  1) TEAM=""; AGMSG_INSTALLED=false
     echo "[warn] agmsg wiring failed ($AGMSG_STATE) — typed-only delivery with monitor-dispatch.sh" ;;
  *) echo "[error] ensure-agmsg-ready.sh usage error ($AGMSG_STATE)"; exit 1 ;;
esac
```

- **`|| AGMSG_RC=$?` と `join.sh … || true` の両方が必須。** `set -e` 下では非ゼロを返した時点で
  シェルが即終了し、`case` に到達しない。
- rc 1 では `AGMSG_INSTALLED=false` も立てる。これが無いと Step 3 で `monitor-dispatch.sh` も
  起動せず、agmsg 記録も heartbeat も無い穴に落ちる。
  **`AGMSG_INSTALLED` の意味はここで「`send.sh` が存在するか」から「agmsg を使うか」へ広がる。**
  変数名は据え置き、定義文を書き換える。
- **`env -u AGMSG_EXPECTED_NAME` が必須。** ディスパッチされたペインの中から更にディスパッチを起動する
  入れ子運用（`--loop` の再入も同型）では、内側の親が外側のロール名を継承したまま `--name parent` で
  guard を呼び、不一致 → exit 2 → `case` の `*)` で **Step 1g が停止しディスパッチが 1 件も起動しない**。
  (B)(C) の子ペインは `launch-workspace.sh` が上書きするので影響を受けず、親だけが死ぬ。
- rc 2 は呼び出し側のバグなので停止する。
- `Monitor` があるハーネスでは `watcher=existing-other` になり、そのとき
  `ready.<team>__parent` は生まれず親の inbox 記録は行われない（現状維持）。warn で可視化する。

#### (B) `prewarm-panes.sh` — 全ロールの初期プロンプトに guard を載せる

**prewarm は watcher を起動しない。** 配線に成功した各ロールの初期プロンプトへ guard の実行を含める。
事実 14 のとおり `launch-workspace.sh` は既に対応しているので、渡していなかった review ペインと
codex ペインにプロンプトを渡すだけでよい。プロンプトは 1 行、禁止 6 文字と改行を含まない。

`launch-workspace.sh` は各ペインの起動時に `AGMSG_EXPECTED_NAME=<そのロールの agent 名>` を
composed command へ export する（`--agmsg-from` は既に渡っているので、その値をそのまま使う）。

**`<SKILL_DIR>` に空白またはシェルメタ文字（`'` `"` `` ` `` `$` `!` `\`）が含まれる場合は
guard を注入しない。** プロンプトはクォートできないので、空白は `bash /Users/x/My Plugins/…` に
分解され bash が exit 127 で終わる。メタ文字は composed command（`zsh -ic "… '<path>' …"`）の
二重引用を破って後続を別トークンにする（`-i` は対話モードなので history 展開が効き `!` も
特殊文字になる）。どちらも検出したら注入せず `watcher: "none"` で記録し warn する。

同じ検出は `--add-dir <AGMSG_SKILL_DIR>/{run,db}` と、その前段の `mkdir -p` にも掛かる
（**fail-closed**: メタ文字を見つけたら `--add-dir` もツリー作成も行わない）。この結果、
該当環境の codex reviewer ペインは guard が `reason=pidfile-missing` に落ちうる。
これはユーザーから見える挙動なので 4 ファイル同期の対象。回帰は CR1e / PW5c。

| ロール | agent 名 | `<T>` の供給元 | gate 変数 |
|---|---|---|---|
| design | `$SLUG` | `DESIGN_WIRING_TYPE`（`:427-428`） | `DESIGN_DELIVERY` |
| claude executor | `$SLUG-claude` | リテラル `claude-code` | `CLAUDE_DELIVERY` |
| codex executor | `$SLUG-codex` | リテラル `codex` | `CODEX_DELIVERY` |
| review | `$SLUG-review` | `REVIEW_WIRING_TYPE`（`:455-456`） | `REVIEW_DELIVERY` |

配線の粒度は engine（`wire_delivery` が `CLAUDE_DELIVERY` / `CODEX_DELIVERY` を立てる）だが、
**join の成否はロール別**なので記録は 4 変数に分かれる。
**現行の design ペインの gate は `CLAUDE_DELIVERY`（`:491`）だが記録は `DESIGN_DELIVERY`（`:690`）である。**
design join が失敗し claude executor join が成功する順序で食い違うので、gate を `DESIGN_DELIVERY` へ揃える
（既存の潜在バグの修正）。

プロンプト全文（`<G>` = `bash <SKILL_DIR>/scripts/ensure-agmsg-ready.sh --type <T> --name <N> and continue even if it exits non-zero.`）:

| ロール | プロンプト |
|---|---|
| design | `Run <G> Then wait idle. Your task will arrive as a prompt typed into this pane; an identical copy may also be recorded in your agmsg inbox history (treat both as ONE task). Do not start any work until the task prompt arrives.` |
| executor（claude / codex 共通） | `Run <G> Then wait idle. Execution instructions will arrive as a prompt typed into this pane; an identical copy may also be recorded in your agmsg inbox history (treat both as ONE task). Do not start any work until the instructions arrive.` |
| review | `Run <G> Then wait idle. Review requests will arrive as a prompt typed into this pane; an identical copy may also be recorded in your agmsg inbox history (treat both as ONE request). Do not start any work until a request arrives.` |

`may also be recorded` と条件付きにしたのは、中核方針 2 により sentinel が生まれない経路
（`watcher=existing-other`）が正規に存在するためである。

- **`/agmsg actas` は全ロールで載せない。** 理由は 3 つ。(1) `Monitor` の起動を指示するので、
  持たないペインでは本 spec が直そうとしている停止そのものを引き起こす（レビュー中に実際に起きた）。
  (2) モデルが Bash ツールで代替起動すると、その呼び出しが watcher の生存中ずっと返らない（実機で観測）。
  (3) 機能的に不要である（ロックは `watch.sh` の暗黙 claim が取り、from 名は `--agmsg-from` が明示する）。
  codex では加えて `$agmsg` の `$` が禁止文字である。既存テストで `/agmsg actas` を assert しているものは 0 件。

あわせて事実 16 のディレクティブ漏れを直す（`wire_delivery` の実引数は `engine` であり `type` ではない）。

```bash
# 修正前: >&2 2>/dev/null   修正後: >/dev/null 2>&1
```

`prewarm-panes.sh` は `set -euo pipefail` で走るので、新しい処理は既存の `wire_delivery` と同じく
`if …; then … else log … fi` で飲み込む。
**テスト 5 本が `$TMP/scripts/` へ複製して実行する**ので、自スクリプトディレクトリから新しいファイルを
source / 実行してはならない（初期プロンプトへ**文字列として**埋め込むのは可）。
**guard の実在検査（`[[ -x … ]]`）も入れない** — 複製していないスイートで注入が消え PW3 が落ちる。

#### (C) 非 prewarm 経路 — `SKILL.md:793-812` の status protocol ブロック

`SKILL.md:792` は「append this block to **every** child prompt」なので、**この行は `prewarm: false` の
ときだけ含める**と明記する。prewarm ペインは (B) で guard を受け取っており、(C) も適用すると
guard が 2 回走り、しかも `--name <task-slug>` 固定なので claude executor（`<slug>-claude`）や
review（`<slug>-review`）で**別ロールの actas ロックを取りに行く**。

```
（prewarm: false のときだけ）Before you start, run this once and continue even if it exits non-zero:
  bash <SKILL_DIR>/scripts/ensure-agmsg-ready.sh --type <CHILD_AGMSG_TYPE> --name <task-slug>
```

`<team>` が空のときはこの行も落とす。`<CHILD_AGMSG_TYPE>` はタスクごとの `DESIGN_ENGINE` から解決する
（`SKILL.md:786-788` が同じ罠を警告している）。ファイル経由なので禁止文字制約は掛からない。

#### (D) codex review ペインの sandbox

事実 15 のとおり codex reviewer は `--sandbox workspace-write` なので既定では
`~/.agents/skills/agmsg/` へ書けない。**必要最小の 2 ディレクトリだけ**を許可する。

```bash
REVIEW_WRITABLE_FLAG=""
[[ -n "$STATUS_DIR" ]] && REVIEW_WRITABLE_FLAG+=" --add-dir '$STATUS_DIR'"
AGMSG_SKILL_DIR="${AGMSG_SKILL_DIR:-$HOME/.agents/skills/agmsg}"
[[ -d "$AGMSG_SKILL_DIR/run" ]] && REVIEW_WRITABLE_FLAG+=" --add-dir '$AGMSG_SKILL_DIR/run'"
[[ -d "$AGMSG_SKILL_DIR/db" ]]  && REVIEW_WRITABLE_FLAG+=" --add-dir '$AGMSG_SKILL_DIR/db'"
```

`${AGMSG_SKILL_DIR:-…}` の形にするのは CR1 を hermetic に書けるようにするためである
（素の代入だと agmsg 未インストールの CI で `--add-dir` が 0 本になり、C3 の不変条件を守る唯一の
自動検査が vacuous に通る）。

`db/` を含める理由: agmsg の DB は WAL モードなので**読み取りだけでも `-shm` / `-wal` の作成が要り**、
権限が無いと `watch.sh:374` の healthcheck が `db-unavailable` で落ちる。理由を書かないと後任が外して壊す。

> **不変条件: `~/.agents/skills/agmsg/scripts` を書き込み許可に含めてはならない。**
> そこは本設計の guard が全ペインで実行し、`session-start.sh` 経由でマシン上の全 Claude Code
> セッションが起動時に触れるコードである。無人（`approval_policy=never`）の codex reviewer に
> 書き込み権を与えると、プロンプトインジェクション 1 回でサンドボックス外・別セッションの権限で
> 任意コードが走る。`db/` も全プロジェクト共通なので、許可は最小限に留める意味がある。

現行は `--add-dir` が `[[ -n "$STATUS_DIR" ]]` の内側にあるので、そこへ足すと `STATUS_DIR` 無しの
review ペインで agmsg 許可が落ちる。上記のように**独立させる**。
これにより 4 ファイル契約の「**3 点セット**」の内訳が変わる（`--sandbox workspace-write` /
`approval_policy='never'` / `--add-dir` が `<STATUS_DIR>` と agmsg `run` `db` の 3 本）。

### 3. `scripts/agmsg-path.sh`（新規、source 専用）

sentinel パスのエンコード（事実 17）を 1 箇所に置き、**`send-prompt.sh` が source する**。
当初は `ensure-agmsg-ready.sh` も source する設計だったが、guard の `--name` は
`^[A-Za-z0-9._-]+$` へ値域検証済みでエンコードが恒等写像になるうえ、読めない環境
（権限・削除）で `READY_ENC` が空になると自分の健全な watcher を殺す自滅経路になるため、
guard 側は依存ごと持たない（`READY_ENC="$NAME"` の直接代入。回帰は AR26）。
規則は `actas-lock.sh:43-73` の `_actas_lock_encode` / `agmsg_ready_path` と同一で、
`[A-Za-z0-9._-]` 以外をバイト単位で `%XX` に変換する（`%` 自身も `%25`）。追跡点として
`actas-lock.sh:43-73` をコメントで引用する。**`AGMSG_DIR` に依存しない**（純粋な文字列変換のみ）。

配置は `scripts/` 直下（`lib/` は作らない）。既存の source 専用ヘルパー `terminal-wait.sh` が
`scripts/` 直下にあり、`CLAUDE.md` のファイル構成表もそう記載している。

**`send-prompt.sh` 側の不変条件**（既存 SP スイートを壊さないため）:

- `AGMSG_SEND` は**そのまま維持する**（`test-send-prompt.sh:70` は `AGMSG_SEND` と `AGMSG_READY_DIR` を
  個別に渡し `AGMSG_DIR` を設定しない）。
- `AGMSG_READY_DIR` は `"${AGMSG_READY_DIR:-…}"` の形で**明示指定を常に優先**する。
- `send-prompt.sh` には現在 `SCRIPT_DIR` が無いので追加する。
- 既存フィクスチャの team/agent（`myteam` / `reviewer`）はエンコード対象文字を含まないので
  **SP0-SP24 は無変更で通る**。
- **lib が読めなくても die しない**（die は唯一の wake 手段の喪失を意味する）。生連結にフォールバックする。

### 4. `prewarm.json` のスキーマ拡張

各ロールに `watcher` を 1 キー追加する（追加のみ）。

| `watcher` | 意味 |
|---|---|
| `guard-injected` | 配線に成功し、初期プロンプトに guard を載せた |
| `none` | 配線に失敗した、または `<SKILL_DIR>` に空白・シェルメタ文字があるので guard を載せていない |

prewarm は watcher を起動しないので、このキーが表すのは「guard を載せたか」である。
**`watch_pid` は導入しない。** `prewarm.json` は Step 6 の 1 回の `jq -n` で書かれるので、
ロールごとに 4 変数へ退避して `--arg` で渡す。

### 5. 経路別のまとめ（本設計後）

| 起点 | 本設計後（セッション開始時点） |
|---|---|
| このセッションに watcher が 1 つも無い（＝再現した障害） | guard がバックグラウンド起動。sentinel あり |
| このセッションに `Monitor` 由来の broad watcher が生きている | `watcher=existing-other` で不介入。sentinel 無し（現状維持） |
| このセッションに同名ロールの named watcher が既にある | `watcher=existing` で不介入 |
| **他セッション**が同名ロールの watcher を持つ | 起動を試み、`reason=held-by-other-session` ＋ 復旧手順 |
| codex 子ペイン / review ペイン | 初期プロンプトの guard が起動（codex review は (D) の `--add-dir` が前提） |
| 非 prewarm 経路の子 | 子プロンプトの guard が起動 |
| 起動しても bare に落ちた | kill して `reason=bare-started` |
| kill できなかった | `reason=orphan-watcher` ＋ 手動 kill の案内 |
| 配線に失敗 | `delivery: "cmux-send"` ＋ `watcher: "none"`、親は `monitor-dispatch.sh` へ |
| セッション途中の `/clear` | **対象外**（非目的） |

## 既知のトレードオフ

1. **名前付き watcher は受信行を既読にする**（事実 9）。得られるのは `history.sh` から辿れる記録である。

2. **`Monitor` が働いているセッションには sentinel が生まれない。** 中核方針 2 により guard は
   自セッションの broad watcher を置き換えないので、`send-prompt.sh` は現行どおり typed-only へ縮退する。
   注入（価値 1）を守るための意図的な選択であり、guard の効果は「そのセッションに watcher が無い状況」に限定される。

3. **同名ロールが複数 team にあると、`watch.sh` は全 team を claim する**（事実 11）。
   `parent` は実際に 2 team に登録されている。1 つでも他セッションが保持していれば
   `reason=held-by-other-session` になる。

4. **`watcher: "none"` でも `delivery` は `agmsg` のまま**（配線には成功しているため）。
   `send-prompt.sh` は sentinel を自分で確認するので、配送は自動的に typed-only へ縮退する。

5. **本プラグインが常駐プロセスを fork するようになる。** 台数は N タスクで最大 **`4N+1`**
   （design 1 + executors 最大 2 + review 1 + 親 1）。
   `CLAUDE.md`「関連プラグインとの境界」表の「永続プロセス: なし」を
   **「agmsg inbox watcher（ペインごと 1 プロセス。composite id のときペイン終了から最大
   `AGMSG_WATCH_INTERVAL` 秒で自己終了する。ペインが SIGKILL された場合は `cleanup()` が走らず
   pidfile と sentinel が残る）」**に書き換える。
   guard は **watcher プロセスの生存しか見ない**（owner の生存は見ない）ので、
   **この最大 30 秒の窓で死にかけの watcher を掴みうる**。孤児の GC は非目的。
   `session-start.sh` の GC も hooks_file がプロジェクト相対なので、**使い捨ての worktree では
   二度と走らない**。残骸は手動で掃除するしかない。

6. **エンコード規則を複製している**（設計 3）。上流の `_actas_lock_encode` が変わっても検出できない。

7. **`ready.*__<encoded name>` の glob は原理的に曖昧である。** `_` は無変換なので、team `a__b` /
   name `c` と team `a` / name `b__c` は同じパスになる。実害は無い — glob の結果は必ず
   pidfile と照合してから使う（手順 6・8-5）ので、誤ヒットしても削除も待機も起きない。

8. **`ps` を PATH 経由で呼ぶ。** agmsg 本体も `compat.sh` / `instance-id.sh` で同様にしており、
   テストからの stub 化もこれに依存する。PATH を汚染できる攻撃者は guard より前に別の手段を持つ。
   なお `ps` が使えない環境（`watch.sh:162` が「Claude Code のサンドボックス」を名指ししている）では
   kill 規則 2 が常に「同定できない → kill しない」に落ちるので、`start-timeout` / `bare-started` の
   全経路が `reason=orphan-watcher` になる。無人ディスパッチでは手動 kill の案内を読む相手がいない。

9. **(B)(C) の guard 出力を誰も回収しない。** `prewarm.json` の `watcher` キーは「guard を載せたか」しか
   表さないので、親は子ロールが `existing-other` や `not-registered` に落ちたことを知る手段がない。
   親自身の結果（(A)）だけがサマリー表へ warn として出る。

10. **`AGMSG_LOG_DIR` は呼び出しユーザー専用ディレクトリでなければならない。** `mktemp` 自体は安全だが、
    手順 4 と 7 の `>>"$LOG"` はパス名で開き直すので、共有ディレクトリでは TOCTOU が残る。
    既定の `${TMPDIR:-$HOME/.cache}/agmsg` はこの条件を満たす。

11. **`uuidgen` に依存する。** 不在時は `$SID` が `agmsg-` になり（パイプなので rc は `tr` の 0 で
    `set -e` は発火しない）、agent pid を解決できないペインが 2 つあると正規化 id が衝突して互いを kill する。
    agmsg 本体は `compat_uuidgen` を使っているが、それは agmsg 内部なので本 spec からは呼ばない。
    実装では `command -v uuidgen` の確認を入れ、無ければ `agmsg-$$-$(date +%s)` 相当へ退避する。
    あわせて `$SID` が `^[A-Za-z0-9._-]+$` に一致することを確認する（`/` が混ざると
    `watch.sh:181` の pidfile 書き込みが失敗し `reason=pidfile-missing` へ落ちる）。

## テスト

### 共通の stub 契約とフィクスチャ要件

- **安全装置（最初に書く）**: このスイートはバックグラウンドプロセスを起動し `ps` 照合の結果に基づいて
  SIGTERM を送る、本リポジトリで初めての形である。冒頭で
  `[[ "$AGMSG_DIR" == "$TMP"/* && "$AGMSG_READY_DIR" == "$TMP"/* ]] || exit 2` をガードする。
  これが無いと `AGMSG_DIR` の渡し忘れで既定が実機パスに落ち、**開発者の本物の watcher を kill しうる**。
- **stub ツリーの形**: agmsg 側のパスは `AGMSG_READY_DIR` の影響を受けない（`watch.sh:61-62` → `:144` が
  自分の配置から `SKILL_DIR/run` を算出する）。したがって stub は
  **`$TMP/stub/scripts/{watch.sh,delivery.sh,send.sh}`** に置き、`AGMSG_DIR=$TMP/stub/scripts`
  `AGMSG_READY_DIR=$TMP/stub/run` を**必ず両方**渡す（不変条件どおり後者は前者から導ける値にする）。
  - `send.sh` は存在するだけでよい（手順 2 の存在確認のみ）。AR1 だけこれを消す。
  - `delivery.sh` は `AGMSG_STUB_DELIVERY_RC`（既定 0）で終了コードを変え、
    stdout に `AGMSG-DIRECTIVE: stub` を出す（AR13 / AR14 が依存する）。
- **fixture watcher の起動形**: 必ず `bash "$AGMSG_DIR/watch.sh" <sid> <project> <type> [<name>]`。
  共通ルールのフルパス等価照合がこの形でしか成立しない。**引数の数は `$#` で数える（broad = 3、named = 4）。**
- **stub watcher の擬似コード**（`AGMSG_STUB_MODE` で分岐）:

  ```
  先頭で常に: printf '%s|%s\n' "$AGMSG_WATCH_INTERVAL" "$*" >> "$AGMSG_STUB_LOG"
  書き込み先は常に $AGMSG_READY_DIR（本物の SKILL_DIR/run 算出は真似ない）

  alive              : $# -eq 4 なら $AGMSG_READY_DIR/ready.<team>__<name> に
                       $AGMSG_STUB_INSTANCE_ID を書き、watch.<$AGMSG_STUB_INSTANCE_ID>.pid に $$ を書き、
                       sleep 300
  sentinel-then-exit : sentinel を書いた直後に exit 0
  no-sentinel        : sentinel を書かず sleep 300
  held               : stderr に 'agmsg watch: cannot claim (held by other sessions): x' を出し exit 1
  unregistered       : stdout に "agmsg watch: no registration for agent 'x'" を出し exit 0
  db-error           : stdout に 'ERROR: cannot open message DB /x' を出し exit 1
  silent-exit        : 何も出さず exit 0
  decoy              : 本文行 '2026-01-01 | t | a → b | agmsg watch: cannot claim' を 1 行出してから
                       sentinel を書き sleep 300（AR9 の行頭アンカー検証用）
  ```

  `<team>` は guard が team を選ばないので stub が任意に決めてよい。
  `AGMSG_STUB_LOG` は呼び出し記録で、AR3 / AR14 / AR16 / AR20 / AR21 が依存する。
- **`$SID` の与え方**: 各ケースは `CLAUDE_CODE_SESSION_ID=ar-sid-<case>` を export し
  `--type claude-code` で実行する。fixture の pidfile 名は `AGMSG_STUB_INSTANCE_ID` で
  **bare（`ar-sid-<case>`）/ composite（`ar-sid-<case>.<pid>`）/ 別セッション（`other-sid.<pid>`）**の
  3 形を作り分ける。**AR15 だけは意図的に両 env を unset する。**
  これが無いと AR3 系と AR21 は fixture の pidfile 名を作れず、AR21 は SID が毎回変わるので
  実装が正しくても必ず watcher が 2 本立つ。
- **`--name` はプロセス固有にユニーク化する**（例 `ar-$$-<case>`）。
- **`AGMSG_READY_TIMEOUT=1` を既定で渡す。ただし AR9 群だけ `10` を渡し、`SECONDS` で経過 3 秒未満を
  assert する**（上限 1 秒では「即断」と「1 秒待って諦めた」を区別できない）。
- **ケース間の状態リセット**: 各ケースの先頭で `$AGMSG_READY_DIR` と `$AGMSG_STUB_LOG` を空にし、
  起動した fixture watcher の pid を配列へ記録して **EXIT trap で必ず kill する**
  （`test-runner-terminal-status.sh:20-36` の `cleanup_all` を流用）。これが無いと AR21 と AR3/AR6 が両立しない。
- **出力は必ず 1 行・7 キーが同じ順・値域どおり**をヘルパーで毎ケース検証する。上の表が SoT である。
- **否定ケースの直前に正常系（AR6 と同一 stub 構成）を 1 回通し、`$AGMSG_STUB_LOG` が書かれることを確認する。**
- **`timeout` / `gtimeout` は使わない**（`CLAUDE.md` 項目 23）。ハング検出は
  **コマンド置換をバックグラウンドのサブシェル内で行い、`kill -0` を上限つきでポーリングする**形にする。
  `test-monitor-layout.sh` の `run_bounded` は出力をファイルへ落とすので fd 漏れを検出できない（実測）。

### 新規 `apps/cmux-team-dispatch-task/test/test-agmsg-ready.sh`

| id | 検証内容 |
|---|---|
| AR1 | `send.sh` 不在 → `reason=not-installed` / exit 1 |
| AR2 | `$TMP/afile` を**通常ファイル**として作り `AGMSG_LOG_DIR=$TMP/afile/sub` を渡す（`mkdir -p` が効かず uid にも依存しない）→ `reason=log-unwritable` かつ **watcher は起動する** / exit 0 |
| AR2b | `TMPDIR` を unset しても `log-unwritable` にならない（`mkdir -p` が効く） |
| AR2c | AR2 の実行後に `/dev/null` がキャラクタデバイスのまま存在する（`rm -f /dev/null` が走らない） |
| AR3 | 自セッションの pidfile に一致し `<name>` を含む生存 watcher → `watcher=existing`、`watch.sh` を新規に呼ばない |
| AR3b | argv[0]/argv[1] が `$AGMSG_DIR/watch.sh` でないプロセス（zsh ラッパー）は候補にしない |
| AR3c | **別セッション**の同名 watcher は候補にせず起動を試みる（→ stub `held` で `held-by-other-session`） |
| AR3d | `<slug>-claude` の watcher（同一セッション）は `existing-other` になる |
| AR3e | broad（`$#` 3）watcher（同一セッション）は `existing-other` になり起動しない |
| AR3f | pidfile 名が `$SID.<数字>` の形でも候補になる（composite 形の受理） |
| AR3g | 候補があり `ps` が空出力 → `watcher=existing-other`、`pid` は最初の候補の pidfile の内容 |
| AR3h | **候補が 1 つも無ければ `ps` が空出力でも起動する**（fail-closed の範囲は候補があるときだけ） |
| AR3i | **composite かつ `<name>` 一致の候補で `watcher=existing` を返したあと、その pid が生存しており `ready.*` が減っていない**（中核方針 2 の違反検出。これが無いとパス A で kill を書いても全 AR が緑になる） |
| AR3j | **bare かつ `<name>` 一致の候補は候補から外して起動する**（その bare の pid は生存したまま、stderr に手動 kill の案内が 1 行） |
| AR3k | `--name codex` で broad watcher の型引数に誤ヒットしない（名前スロット固定の検証） |
| AR4 | 候補の pid が死んでいれば候補にせず起動する |
| AR4b | 生存判定が EPERM を「生存」と扱う（`kill -0` が rc 1 かつ `no such process` を含まない stub `kill` を PATH 先頭に置く） |
| AR5 | sentinel の中身 `T` に対し `watch.$T.pid` の pid が生きていれば削除しない / 無い・死んでいれば削除する |
| AR6 | 正常系: `watch.sh` を 4 引数で起動し、sentinel 出現後に `watcher=started pid=<n>` / exit 0。pidfile 名が composite。**`log=-` になりログファイルが残らない** |
| AR6b | `sentinel-then-exit` stub → 再確認で検知し分類器へ落ちて `watcher=none` |
| AR6c | **他セッションの生きた sentinel が先に存在する状態**で `held` stub を起動 → sentinel の中身が自分の正規化 id と違うので `started` にならず `reason=held-by-other-session` |
| AR6d | `AGMSG_READY_DIR` を `$(dirname "$AGMSG_DIR")/run` 以外にすると `reason=pidfile-missing` になり、**起動した watcher を kill しない** |
| AR7 | 印字した `pid=` が `watch.sh` 本体の pid である |
| AR8 | 起動した watcher が生きている間もコマンド置換 `$( )` が戻る。バックグラウンドのサブシェル + `kill -0` ポーリングで検証 |
| AR9a-d | 事実 10 の 4 経路が正しい `reason` に分類され、`AGMSG_READY_TIMEOUT=10` でも 3 秒未満で打ち切られる |
| AR9e | `decoy` stub（本文行に `agmsg watch: cannot claim` を含む）で誤分類しない（行頭アンカーの検証） |
| AR9f | `decoy-exit` stub（decoy 行を吐いて即 exit）でも `reason=watcher-exited`。`classify_from_log` の行頭アンカーが全文一致ではないことの直接検証 |
| AR10 | pidfile 名が bare → SIGTERM で kill して `reason=bare-started`、sentinel が残らない |
| AR10b | AR10 の kill 後、`ready.*` sentinel が 1 件も残らない |
| AR11 | `no-sentinel` stub → `AGMSG_READY_TIMEOUT` で打ち切り、SIGTERM で kill、`reason=start-timeout`。**他人の sentinel は消さない** |
| AR11b | AR11 と同じ実行で、事前に置いた**他ロールの** sentinel が削除されずに残る |
| AR12 | 手順 5 では `ps` が成功し、**手順 8 の照合時に空出力になる** stub → kill せず `reason=orphan-watcher`、stderr に pid が出る |
| AR13 | `delivery.sh` が AGMSG-DIRECTIVE を印字しても標準出力へ漏れず、`$LOG` に残る（異常系で `log=path` のとき） |
| AR14 | `delivery.sh set` が非ゼロ → `reason=delivery-set-failed` / exit 1、`watch.sh` を呼ばない |
| AR15 | session id: `claude-code` は `$CLAUDE_CODE_SESSION_ID` のみ、`codex` は `$CODEX_THREAD_ID` のみ。両方空なら `agmsg-<uuid>` を生成し `-` を渡さない |
| AR16a-f | exit 2 の 6 条件（必須フラグ欠落 / 未知フラグ / 不正 `--type` / 不正 `--name` / 存在しない `--project` / `AGMSG_EXPECTED_NAME` 不一致）で rc==2 かつ `delivery.sh` / `watch.sh` を呼ばない |
| AR17 | エンコードのゴールデンベクタ 4 本（下記）。`agmsg_ready_path` を source しない |
| AR18 | stderr の手掛かり: 文言が一意な `reason`（`not-installed` / `log-unwritable` / `pidfile-missing` / `not-registered` / `held-by-other-session` / `orphan-watcher`）は**完全一致**、`see <log>` 系は `log=` のパスが含まれることだけを assert。`reason=-` かつ bare 候補も無いときは 1 行も出さない |
| AR19 | **異常系（`held` stub）で `log=<path>` を得て**、そのファイルが 0600 で存在する。同じ `--name` で 2 回実行し、**2 回の `log=` が異なるパス**で両方 0600（正常系は手順 10 で消えるので 0600 を検証できない） |
| AR20 | `AGMSG_WATCH_INTERVAL` が watcher の環境へ export される |
| AR21 | 2 回目の guard 実行が `existing` になり、watcher を二重起動しない |
| AR22 | pid が衝突する**他ロールの** stale pidfile を「自分」と誤認しない（`guard_my_norm_id` の session-id フィルタ） |
| AR22b | 同一セッションの**非数値 suffix**（`<SID>.0abc`。glob 順で純数字より前）も「自分」と誤認しない |
| AR23 | 手順 8 の待機中の SIGTERM が `reason=interrupted` の 1 行になり、孤児 watcher の pid が出る |
| AR24 | 20 桁の `AGMSG_READY_TIMEOUT` でも rc 0・1 行・有限時間で戻る（4 桁上限） |
| AR25 | 先頭ゼロの `AGMSG_READY_TIMEOUT`（`08` / `0018` / `0000`）が既定値へ倒れ、stderr が空のまま `watcher=started` になる |
| AR26 | `agmsg-path.sh` が読めない場所へ guard をコピーしても `watcher=started`。guard は同 lib に依存しない |
| AR27 | 手順 10 の直前に撃たれても trap が `WATCHER=none` を強制する（`watcher=started reason=interrupted` を出さない） |
| AR28 | `log-unwritable` 確定後に撃たれても trap が `reason` を上書きせず、pid も偽造しない |
| AR29 | 既に exit した watcher の pid を孤児として名指ししない（trap の `guard_pid_alive`） |
| AR30 | `existing` 経路で撃たれても既存 watcher の pid を「自分の孤児」として名指ししない（`PID="-"` の先置き） |
| AR31 | `ps` が使えない環境（`guard_is_watcher` rc 2）でも生きた孤児 pid を落とさない |
| AR31b | SIGTERM を無視する watcher（`nosent-ignore-term`）で報告される pid が実在・生存している |
| AR31c | rc 1（watcher ではないと確定）は今も pid を抑止する（AR31 の rc 2 と対をなす回帰。R1 の対） |
| AR32 / AR32b | `seq` を rc 127 に差し替えても手順 8 と `guard_stop_watcher` の待機ループが 0 回にならない |
| AR33 / AR33b | 空白入りの `AGMSG_DIR` / project パスで回復手順つきの hint が stderr へ 1 行出る |
| AR34 | 起動前から在る**同一 SID・純数字 suffix**の残骸を「自分」と誤認しない（起動前スナップショット） |
| AR34b | 自分の watcher が同一 id の起動前 stale pidfile を正当に上書きしたケースでは `guard_my_norm_id` の fallback がその id を拾い `watcher=started` を返す（R8 の「安全側の半分」。AR34 は捨てる側だけを守る） |

AR17 のゴールデンベクタ:

```
("dispatch-my repo",  "parent")   -> ready.dispatch-my%20repo__parent
("dispatch-a%b",      "parent")   -> ready.dispatch-a%25b__parent
("dispatch-日本",      "parent")   -> ready.dispatch-%E6%97%A5%E6%9C%AC__parent
("dispatch-ok_1.2-3", "x-review") -> ready.dispatch-ok_1.2-3__x-review   （無変換）
```

### 既存スイートへの回帰追加

`prewarm-panes.sh` を呼ぶケースは必ず先にワークツリーディレクトリを `mkdir -p` する。
slug は `pw1`…`pw9`（既存の `pg*` / `ov*` / `is*` と同じ「slug prefix = ブランチ prefix」規約）。
**1 回の prewarm では 6 ペインを同時に作れない**（design の engine は 1 つ）ので、
PW3 は claude 構成と all-codex 構成の 2 回に分けて実行する。

| id | 検証内容 |
|---|---|
| PW1 | `watcher: "guard-injected"`。かつ `[.. \| objects \| select(has("delivery")) \| has("watcher")] \| all` と `(.delivery == "agmsg") == (.watcher == "guard-injected")` |
| PW1c | codex design ペインの初期プロンプトにも `ensure-agmsg-ready.sh` の guard 呼び出しが入る |
| PW2 | `delivery.sh` を失敗させる stub で claude-code 型の全ロールが同時に `watcher: "none"` になり、guard が注入されない |
| PW3 | claude 構成と all-codex 構成の 2 回で、design / executor / review の全ペインが guard を含み `--type` が供給元表どおり |
| PW4 | どのペインの初期プロンプトにも `/agmsg actas` が現れない |
| PW5 | 禁止 6 文字と改行が無い（`[[ $(printf '%s' "$p" \| wc -l) -eq 0 ]]`） |
| PW5b | 空白を含む一時ディレクトリから prewarm を起動すると guard が注入されず `watcher: "none"` になる |
| PW5c | シェルメタ文字（`'` `"` `` ` `` `$` `!` `\`）を含む `SCRIPT_DIR` でも同様に guard を注入しない（fail-closed） |
| PW6 | `prewarm-panes.sh` の **stderr** に `AGMSG-DIRECTIVE` が現れない（stdout ではない） |
| PW7 | `ensure-agmsg-ready.sh` が exit 1 でも prewarm が die せず `prewarm.json` を書く |
| PW8 | `--agmsg-team` 無しのとき guard を載せない |
| PW9 | design ペインの gate が `DESIGN_DELIVERY` である。**`AGMSG_STUB_JOIN_FAIL=<agent 名>` の join stub で design だけ失敗させる**（全 join 成功では `DESIGN_DELIVERY` と `CLAUDE_DELIVERY` が常に一致し、gate を差し替えても挙動が変わらないので PW9 は恒真になる） |
| PW10 | prewarm が各ペインへ `--agmsg-from <そのロール>` を渡す（argv 層。PW スイートは `launch-workspace.sh` を argv 記録スタブに置換するので composed command は生成されない） |
| PW10b | legacy `--review-model` 経路（`review_runner` key 未設定時の cross-engine resolver）でも review ペインへ `--agmsg-from` と guard 注入の両方が渡る |
| LW1 | `launch-workspace.sh` が生成する runner script に `export AGMSG_EXPECTED_NAME='<name>'` が入る（`test-launch-workspace-codex.sh` 側。runner ファイル層） |
| LW2 | `--agmsg-from` が `^[A-Za-z0-9._-]+$` に一致しないと die する |
| AG1 | `SKILL.md` の Step 1g ブロックを **`TEAM="dispatch-` を awk のアンカー**にして抽出し（Step 1g 配下に bash フェンスが 6 個ある。この文字列は SKILL.md 全体で 1 箇所）、**先に** `test-cleanup-close.sh:95` と同じ sed で `~/.agents` と `<SKILL_DIR>` を stub パスへ置換し、**そのうえで** `~/.agents` が残っていないことを assert してから `set -euo pipefail` 下で実行。rc 0（`started` / `none` / `existing-other` の 3 サブ分岐）/ rc 1 / rc 2 と join 失敗時の継続を検証。stub は `git` / `join.sh` / `resolve-agmsg-type.sh` / `ensure-agmsg-ready.sh` の 4 つ |
| AG2 | 同ブロックが `--name parent` を渡し、`--session-id` を渡さない |
| AG3 | 非 prewarm 経路の子プロンプトブロックが guard 行を含み、`prewarm: true` のときと `<team>` が空のときは落ちる |
| AG4 | 同ブロックの `--type` がタスクごとの engine から解決されている |
| SP25 | `send-prompt.sh` がエンコード済み sentinel パスを参照する（AR17 と同じゴールデンベクタ）。既存 SP1 とは別 id |
| SP26 | `agmsg-path.sh` が読めなくても `send-prompt.sh` が die せず生連結にフォールバックする。**このケースだけ `cp "$BIN" "$TMP/scripts/"` して lib の無いディレクトリから実行する**（`test-send-prompt.sh:70` は `bash "$BIN"` をその場で実行するので本物の lib を消せない） |
| CR1 | codex review の起動コマンドに agmsg `run` と `db` の `--add-dir` が入り、**`scripts` は入らない**。`AGMSG_SKILL_DIR=$TMP/fake` に `run` / `db` / `scripts` を作り、**2 本入ることと `scripts` が入らないことの両方**を assert する。置き場所は `test/test-launch-workspace-codex.sh` の T5 群の隣（`test-codex-review-sandbox.sh` は codex CLI を実起動する動的テストで `launch-workspace.sh` を読まない） |
| CR1b | `STATUS_DIR` が空でも agmsg 側の `--add-dir` は付く |
| CR1c | agmsg を新規インストールした直後（`run` / `db` 未作成）でも `launch-workspace.sh` 側が先に `mkdir -p` するので `--add-dir` が 2 本付く |
| CR1d | agmsg 未インストール（`$AGMSG_SKILL_DIR` 自体が無い）ならツリーを勝手に作らない |
| CR1e | `AGMSG_SKILL_DIR` にシェルメタ文字があれば `--add-dir` もツリー作成も行わない（fail-closed） |

既存ヘルパー `assert_no_line_with`（`test-prewarm-unattended.sh:60-65`）にガードを足す。
ただし `run_prewarm` は毎回 argv.log を truncate するので**「実在」ガードは恒真**である。
**「実在し、かつ 1 行以上」**に強化する（U2 / U3 / U8 は強化後も PASS することを確認済み）。
否定形を使う PW ケースでは「argv.log の行数が期待値と一致する」を先に assert する。

## ドキュメント

`apps/cmux-team-dispatch-task/CLAUDE.md` の 4 ファイル整合ルールに従い、同一コミットで更新する。
**1 行 = 1 参照。** 全 41 行。行番号は改訂 5 時点で照合済み。

| # | ファイル | 行 | 内容 |
|---|---|---|---|
| 1 | `skills/…/SKILL.md` | 514-528 | `AGMSG_INSTALLED` の定義（「agmsg を使うか」へ拡張） |
| 2 | 同上 | 526 | `monitor-dispatch.sh` の起動条件に「配線失敗時も起動する」 |
| 3 | 同上 | 2201-2203 | 同上 |
| 4 | 同上 | 748-812 | 配線ブロックを guard 呼び出しへ置換。AGMSG-DIRECTIVE 遵守文を削除 |
| 5 | 同上 | 748-812 | `/clear` の既知の制限を追記 |
| 6 | 同上 | 793-812 | 子プロンプトの guard 行（`prewarm: false` 限定） |
| 7 | 同上 | 2118-2119 | 「the path needs no encoding」→ team 名はエンコードが要る |
| 8 | 同上 | 2737 | Delivery 要約の「MUST be followed」 |
| 9 | 同上 | 386 | engine × mode 起動コマンド表の codex review 行（`--add-dir` 3 本） |
| 10 | `skills/…/references/guide-ja.md` | 130-143 | Step 1g 訳（`AGMSG_INSTALLED`） |
| 11 | 同上 | 137-138 | 同上 |
| 12 | 同上 | 141 | `monitor-dispatch.sh` の起動条件 |
| 13 | 同上 | 186-202 | Step 1g 訳（配線ブロック） |
| 14 | 同上 | 204-209 | Step 1g 訳（AGMSG-DIRECTIVE 段落） |
| 15 | 同上 | 513 | 「3点セット」の内訳 |
| 16 | 同上 | 766-767 | 「design / claude executor の初期プロンプト」→ 全ロール |
| 17 | 同上 | 837-838 | 「パスのエンコードは不要」 |
| 18 | 同上 | 911-912 | `monitor-dispatch.sh` の起動条件 |
| 19 | 同上 | 1290 | 補足の Delivery 要約 |
| 20 | `README.md` | 200-203 | `monitor-dispatch.sh` の起動条件 |
| 21 | 同上 | 212-213 | sentinel パスの綴り（エンコードの有無に触れていないが、綴りを示しているので同期対象） |
| 22 | 同上 | 239 付近 | 「`AGMSG-DIRECTIVE:` に従って watcher を起動する」 |
| 23 | 同上 | 373 付近 | codex review の sandbox 3 点の記述（`--add-dir` の内訳） |
| 24 | `SKILL.md` | 2127-2128 | `prewarm.json` のキー列挙（`watcher` を追加） |
| 25 | `SKILL.md` | 2137-2145 | `prewarm.json` の JSON リテラル |
| 26 | `guide-ja.md` | 846-854 | 同 JSON リテラルの訳 |
| 27 | `guide-ja.md` | 768-769 | 初期プロンプト文面の契約 |
| 28 | `CLAUDE.md` | ファイル構成表 | `ensure-agmsg-ready.sh` の行を追加 |
| 29 | 同上 | ファイル構成表 | `agmsg-path.sh` の行を追加 |
| 30 | 同上 | 154（項目 12） | AGMSG-DIRECTIVE 遵守 → guard の検証項目。**回帰は `test-agmsg-ready.sh`（AR1-AR34。AR15b / AR18 / AR3f は欠番）と AG1-4** |
| 31 | 同上 | 155（項目 13） | `prewarm.json` の role-aware schema に `watcher` を追加 |
| 32 | 同上 | 165（項目 15） | ready sentinel 段落（エンコード規則の追加） |
| 33 | 同上 | 166（項目 15） | 「design / claude executor の初期プロンプト」→ 全ロール。`CLAUDE_DELIVERY` gate literal も `DESIGN_DELIVERY` へ |
| 34 | 同上 | 167（項目 15） | 回帰行に **PW1-10 / LW1-2 / SP25-26** を追加 |
| 35 | 同上 | 194（項目 20） | codex review の sandbox 3 点の内訳。**回帰は CR1/CR1b/CR1c/CR1d/CR1e** |
| 36 | 同上 | 215（項目 25） | 「レビューペインの 3 点は不変」 |
| 37 | 同上 | 298（E2E 17） | agmsg インストール時の E2E 手順 |
| 38 | 同上 | 299（E2E 18） | pre-warm の E2E 手順（`watcher` キー） |
| 39 | 同上 | 308（E2E 27） | watcher 死亡時フォールバックの E2E 手順 |
| 40 | 同上 | 320（E2E 39） | codex 起動安全性の E2E 手順 |
| 41 | 同上 | 「関連プラグインとの境界」表 | 「永続プロセス: なし」→ トレードオフ 5 の文言 |

加えて `docs/notification-gaps.md` に 2 行足す。修正したパターン（現行 P1-P8）へ **P9** として
「agmsg watcher が起動せず inbox 記録が全ロールで落ちる（`SKILL.md` の AGMSG-DIRECTIVE 依存）→ guard を追加」、
未解決（現行 U1-U8）へ **U9** として「`/clear` 後に watcher が戻らない（`Monitor` 非搭載ハーネス）」。
`CLAUDE.md:27` がこのファイルを正本と定めている。

コード内コメントの更新: `prewarm-panes.sh:584,617`（「codex は初期 prompt 無し」）、
`launch-workspace.sh:791`（「`/agmsg actas <name>` + 待機指示を初期 prompt にする」）。

**agmsg 側の実装を引用するときのパス表記**: `instance-id.sh` / `actas-lock.sh` /
`resolve-project.sh` / `compat.sh` は実際には `~/.agents/skills/agmsg/scripts/lib/` 配下にある
（`watch.sh` / `delivery.sh` などは `scripts/` 直下）。本 spec の引用はファイル名だけで書いているので、
実装時に探す際はこの違いに注意する。

制約:

- `SKILL.md` と `*-ja.md` 以外の `references/*.md` に日本語文字を 1 文字も書かない
- `SKILL.md` / `references/**/*.md` に `cmux send` / `cmux send-key` のリテラルを入れない
- パスのプレースホルダは編集箇所の周囲に合わせる（Step 1g 周辺は `<SKILL_DIR>`）
- シェルスクリプトは bash 3.2 互換。`set -u` 下で空になりうる配列は `${arr[@]+"${arr[@]}"}` で展開する
- コメントとコミットメッセージは日本語、識別子は英語

## 検証ゲート

**すべてリポジトリルートから実行する。** `check-doc-lang.mjs:141` は `const root = process.cwd()` で
`join(root, 'apps')` を走査するので、`apps/cmux-team-dispatch-task` を cwd にすると
**対象 0 件で無条件に OK** を返す（実測）。

```bash
cd <repo root>
bash -n apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/ensure-agmsg-ready.sh
bash -n apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/agmsg-path.sh
rc=0
for t in apps/cmux-team-dispatch-task/test/*.sh; do
  printf '%-56s ' "$t"
  if bash "$t" >/dev/null 2>&1; then echo OK; else echo FAILED; rc=1; fi
done
node scripts/check-doc-lang.mjs apps/cmux-team-dispatch-task || rc=1
pnpm check || rc=1
git worktree list
git branch --list 'feat/pg*' 'feat/is*' 'feat/ov*' 'feat/pw*'
exit $rc
```

`for … done` ループは `rc` に反映させる。`FAILED` を印字するだけだとシェルの終了コードが 0 のままで、
ゲートが自動判定に使えない。新規シェル 2 本は `bash -n` も通す。
`test-send-prompt-callsites.sh` はループに含まれるので個別実行は不要。

`@tanaka-yui/token-meter` の `noNonNullAssertion` 警告 4 件は既知のノイズ。

## 改訂履歴

### 改訂 5 → 6（レビュー ラウンド 5 を反映）

レビュアーの総括は「**設計そのものに差し戻すべき点は無い。残るのは局所的な欠陥のみ**」だった。
以下はすべて 1〜3 行の局所修正である。

| 指摘 | 修正 |
|---|---|
| B1 `rm -f "$LOG"` が `LOG=/dev/null` を消す | 手順 10 に `/dev/null` ガード。root CI で `/dev/null` が消え、非 root では `set -e` で guard が死ぬ。**テストでは検出されない** |
| B2 素の `kill -0` は生存判定ではない | 共通ルールに `_agmsg_pid_alive_local` と同じ意味論（ESRCH のみ死）を明記。EPERM 誤判定は中核方針 2 の両方向の違反になる |
| B3 手順 8 が sentinel の存在しか見ない | **中身が自分の正規化 id と一致**することを要求。他セッションの sentinel で偽の `watcher=started` が出ていた |
| B4 `AGMSG_EXPECTED_NAME` の export 手段 | `launch-workspace.sh` の runner script heredoc に `export` を 1 行。担当が `prewarm-panes.sh` と両記だったのを解消。`--agmsg-from` の値域検証も追加 |
| B5 exit 2 行の実値 | `reason=usage`、`name` は検証に通ったときだけ実値、`installed`/`wired` は「未検査を `no` で表す」 |
| B6 `ps` 不能時の候補の分岐 | `existing-other` に固定し `pid` はファイル名昇順で最初の候補。候補ゼロなら `ps` 無しでも起動する旨も明記 |
| B7 `AGMSG_READY_DIR` の不変条件 | 「`$(dirname "$AGMSG_DIR")/run` と一致していなければならない」を追加。手順 9 に `pidfile-missing` 分岐（**kill しない**） |
| B8 `prewarm.json` の `watcher` キー | ドキュメント表に 5 行追加（`SKILL.md` 2 / `guide-ja.md` 1 / `CLAUDE.md` 2） |
| B9 `$SID` の与え方 | stub 契約に `CLAUDE_CODE_SESSION_ID=ar-sid-<case>` と 3 形の `AGMSG_STUB_INSTANCE_ID` |
| B10 `bare-existing` の AR 欠落 | bare 候補は候補から外して起動する設計へ変更（中核方針 2 は「壊しうる相手だけを見る」）。AR3i / AR3j を追加 |
| B11 stub 契約の欠落 3 件 | `delivery.sh` / `send.sh` stub、書き込み先を `$AGMSG_READY_DIR` に固定、`AGMSG_STUB_LOG` |
| B12 引数個数が 3 通り | `watch.sh` の `$#` で統一（broad = 3、named = 4）。事実 12 も補足 |
| M1 unlink とディスク | 「ディスク使用量は減らない。目的は平文の平置きを消すこと」に訂正 |
| M2 `AGMSG_EXPECTED_NAME` の根拠 | セキュリティ境界ではなく**配線ミスの早期検出**であると明記 |
| M3 継承で親が死ぬ | (A) を `env -u AGMSG_EXPECTED_NAME` に |
| M4 stale reclaim | `held` は保証されない旨を中核方針 2 の帰結に追記 |
| M5 「構造的に起きない」 | 兄弟プロセス（同一 session_id）は候補に残ると明記 |
| M6 bare の恒久ブロック | B10 と同じ修正で解消 |
| M7 名前スロット | 「argv のどこか」→ **5 番目のトークン**に固定。`--name codex` の誤ヒットを塞ぐ |
| M8 `AGMSG_SKILL_DIR` | `${…:-…}` にして CR1 を hermetic に |
| M9 SP26 / PW9 / AR19 のフィクスチャ | それぞれ実行方法を明記 |
| M10 AR の安全装置 | `[[ "$AGMSG_DIR" == "$TMP"/* ]]` ガードを契約の先頭に |
| M11 常駐プロセス上限 | `3N+1` → **`4N+1`** |
| M12 codex の登録パス | **実測で否定**。codex 登録はワークツリーパスで保存され `watch.sh` も同じ解決に落ちる |
| m1-m21 | 行番号 8 件、ドキュメント表の誤参照 2 行の差し替え、`lib/` パス表記、検証ゲートの終了コード、`bash -n`、`assert_no_line_with` の強化、AR2 / AR9 の作り方、トレードオフ 8-11 の追加 |

### 改訂 4 → 5（レビュー ラウンド 4 を反映）

| 改訂 4 | 改訂 5 | 理由 |
|---|---|---|
| プローブのスコープが (project, type) | **自セッションの pidfile（`watch.<SID>.pid` / `watch.<SID>.<数字>.pid`）** | 事実 20 によりスコープがリポジトリ全体へ広がり、無関係な並行ディスパッチの watcher 1 本で全ロールの guard が抑止されていた（実測）。事実 5 のとおり guard の起動が壊しうるのは自セッションの watcher だけである |
| `ps` の 4 条件 AND（type / project / name） | pidfile 起点 ＋ フルパス照合 ＋ name の有無 | project 綴りの受理・git-common-dir 導出・空白パスの fail-closed・degraded 拒否がすべて不要になった |
| 他ペインの watcher を `existing` と誤認しうる | session スコープなので構造的に起きない。他セッションのものは `held-by-other-session` で診断が出る | 旧ペインの watcher へメッセージが流れ続ける無言故障 |
| `--add-dir` に agmsg スキルディレクトリ全体 | **`run` と `db` のみ。`scripts` は不可を不変条件に** | 無人 codex reviewer にプロンプトインジェクションが入ると、全セッションが実行する `watch.sh` を書き換えられる |
| `log-unwritable` で配線をスキップし exit 0 | `mkdir -p` を先に行い、失敗しても `/dev/null` で**続行** | 「配線の失敗ではない」と言いながら配線していなかった。`~/.cache` 不在の環境では全環境的に発火する |
| `$LOG` は既定 `${TMPDIR:-$HOME/.cache}` | `${TMPDIR:-$HOME/.cache}/agmsg`。正常系は `rm -f` して `log=-` | inbox 本文が無期限に平文で残っていた |
| 出力表に `name` 列が無く exit 2 が値域外 | 7 キー全列 ＋ `-` を許すキーの明示 ＋ exit 2 の実値 | 表が全 AR の SoT なのに期待値が決まらなかった |
| `bare-instance-id` が 1 行 | `bare-existing`（kill しない）/ `bare-started`（kill する）に分割 | 1 行に畳むと中核方針 2 の違反が AR で素通しになる |
| 事実 7「bare は常に DEAD」 | upgrade-compat（`instance-id.sh:433-436`）を反映。**composite の根拠は事実 6 のみ** | claude-code の生きたペインでは bare も ALIVE（実測） |
| stale sentinel の判定に `agmsg_instance_alive` 相当 | **pidfile の pid 生存**を根拠にする | bare の生存を判別できず、生きた watcher の sentinel を消す経路が残っていた |
| kill 規則 3「degraded では kill しない」 | 「cmdline を同定できないときは kill しない」＋ `orphan-watcher` を新設 | 旧規則は到達不能で AR が vacuous。2 秒で死ななかった場合の挙動も未定義だった |
| `--name` の検証は文字集合のみ | `AGMSG_EXPECTED_NAME` を追加 | `--loop` の issue 本文経由でモデルに兄弟ロールや `parent` のロックを claim させられる |
| ドキュメント 24 箇所 | **31 行（1 行 = 1 参照）** ＋ `notification-gaps.md` ＋ コードコメント 3 箇所 | 「エンコードは不要」4 箇所（spec 自身が偽と証明した記述）、`monitor-dispatch.sh` の訳 3 箇所、`AGMSG_INSTALLED` の訳 2 箇所が漏れていた。テスト id は既存規約どおり番号付き項目へ紐づけた |
| stub 契約に sentinel 書き込みが無い | stub watcher の擬似コードと `AGMSG_STUB_MODE` の値域を明記 | AR の過半が実装者依存だった |
| テスト隔離の不変条件が暗黙 | 「候補集合は `$AGMSG_READY_DIR/watch.*.pid` に限る」を明記 | `ps` 全走査を選ばれると隔離が壊れる |
| PW3 が 1 回の prewarm で 6 ペイン | claude 構成と all-codex 構成の 2 回に分割 | design の engine は 1 つなので 1 回では作れない |
| ケース間のリセット規則が無い | `$AGMSG_READY_DIR` の初期化と EXIT trap での fixture kill を契約に | AR21 と AR3/AR6 が両立しなかった |

### 改訂 3 → 4（レビュー ラウンド 3 を反映）

中核方針 2（既存 watcher を置き換えない）を導入し、復元手順を削除した。`$LOG` を `mktemp` 化し、
composite 判定を 1 箇所に切り出し、`not-registered` を exit 0 にし、`check-doc-lang` を
リポジトリルート実行に直した。

### 改訂 2 → 3（レビュー ラウンド 2 を反映）

起動形からサブシェルと `setsid` を排除し、`actas-claim.sh` による事前 claim を廃止し、
`/agmsg actas` を全ロールから外した。

### 改訂 1 → 2（レビュー ラウンド 1 を反映）

prewarm による代理起動と `AGMSG_AGENT_PID=` を廃止し、「watcher はペイン自身が起動する」中核方針へ変更した。
