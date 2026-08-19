# agmsg セットアップガードの設計

対象: `apps/cmux-team-dispatch-task`

> 改訂 5。spec レビュー ラウンド 1〜4 の指摘を反映した。差分は末尾「改訂履歴」を参照。

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

12. **`Monitor` が起動する broad watcher は位置引数 4 個で name を持たない**
    （`delivery.sh:329` の `printf '%q %q %q %q'`）。実機でも確認した。

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
| `AGMSG_READY_DIR` | `${AGMSG_READY_DIR:-$(dirname "$AGMSG_DIR")/run}` | sentinel と pidfile の場所。**明示指定を常に優先** |
| `AGMSG_LOG_DIR` | `${TMPDIR:-$HOME/.cache}/agmsg` | watcher のログの置き場 |
| `AGMSG_READY_TIMEOUT` | `15` | guard が sentinel の出現を待つ上限秒数 |
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

これが唯一のテスト隔離手段である。`AGMSG_READY_DIR` を stub へ差し替えれば、本物の watcher は
構造的に候補へ入らない。`ps` 全走査を選ぶと `AGMSG_READY_DIR` の差し替えが効かなくなり、
テストがマシン状態依存になる。

#### 共通ルール

**正規化 id の取得**: 候補は pidfile 経由でしか得ないので、**正規化 id は pidfile 名そのもの**である。
剥がしは `session-start.sh:222` と同形にする。

```bash
id=${f##*/}; id=${id#watch.}; id=${id%.pid}
```

**自セッションの候補かの判定**: `$id` が `$SID` と等しい、または `$SID.` で始まり残りが全数字。

**composite 判定**は `agmsg_instance_is_composite`（`instance-id.sh:171-183`）の 3 条件を逐語で写す。
(1) `.` を含む (2) 最後の `.` より前が**非空** (3) 最後の `.` より後が**全数字**。

**watcher プロセスの同定**（pid 再利用への防御）: `ps -ww -p <pid> -o args=` を取り、
argv[0] または argv[1] が `$AGMSG_DIR/watch.sh` と**フルパスで等価**であること。
これは agmsg 本体（`watch.sh:171` ほかは部分文字列照合）より**厳しい**が、Claude Code の Bash ツールが
張るラッパーシェル（argv[0]=`/bin/zsh`, argv[1]=`-c`）を確実に落とすために意図的にそうする。
`agmsg_args_is_grok_watcher` から採るのは **fail-closed の方針**（空白分割・位置引数照合）だけである。
**guard はパスを正規化しない**（受け取った文字列のまま比較する。macOS の `/var` と `/private/var` を
持ち込まない）。

#### 処理

1. **引数検証。** 次のいずれかで **exit 2**（`delivery.sh` / `watch.sh` を 1 度も呼ばない）。
   必須 2 フラグの欠落 / 未知フラグ / `--type` が `claude-code` `codex` 以外 /
   `--name` が `^[A-Za-z0-9._-]+$` に一致しない / `--project` が存在しないディレクトリ /
   **`AGMSG_EXPECTED_NAME` が設定されていて `--name` と一致しない**。

   `AGMSG_EXPECTED_NAME` は `prewarm-panes.sh` と `launch-workspace.sh` がペイン起動時に
   そのロール名で export する。事実 2 のとおり名前付き起動は actas ロックを暗黙 claim するので、
   **モデルが動的に `--name` を組み立てられると兄弟ロールや `parent` のロックを奪える**
   （`--loop` は GitHub issue 本文を子のタスクプロンプトにするので、そこへ
   「`--name parent` でも実行せよ」を仕込む経路が実在する）。未設定なら現状どおり通す（手動実行を壊さない）。

2. **インストール確認。** `$AGMSG_DIR/send.sh` が無ければ `reason=not-installed` で **exit 1**。

3. **ログの用意。** `mkdir -p "$AGMSG_LOG_DIR"`（失敗は無視）してから
   `LOG=$(umask 077; mktemp "$AGMSG_LOG_DIR/agmsg-watch-$NAME.XXXXXX")`。
   失敗したら **`LOG=/dev/null` にフォールバックして続行する**（`reason=log-unwritable` を添える）。
   ログが取れないことは配線の失敗ではないので、配線も起動もスキップしない。
   `mktemp` は `O_CREAT|O_EXCL` なので symlink 追従も既存上書きも起きず、`set -C` は不要。
   `umask` は `$( )` に閉じる（**`nohup … &` をサブシェルに包んではならない**が、ログ生成だけの
   サブシェルは無関係で安全である）。

4. **配線。** `delivery.sh set monitor <type> <project>` を実行し、stdout・stderr の両方を `>>"$LOG"` へ
   落とす（AGMSG-DIRECTIVE と codex のシェル shim 手順を呼び出し元へ漏らさない）。
   非ゼロ終了なら `reason=delivery-set-failed` で **exit 1**。

5. **候補の判定。** `$AGMSG_READY_DIR/watch.*.pid` を列挙し、共通ルールで
   「自セッションの候補」かつ「pid が生存」かつ「watcher プロセスとして同定できる」ものを集める。
   `ps` が使えず同定できない場合は**候補として扱う**（起動しない側に倒す。fail-closed）。

   - 候補があり、その argv に `<name>` が位置引数として厳密等価で含まれる → `watcher=existing`。
     正規化 id が bare なら `reason=bare-existing` を添える（**kill はしない**。中核方針 2）。**exit 0**。
   - 候補はあるが `<name>` を含まない（broad、またはこのセッションの別ロール）→
     `watcher=existing-other`。**exit 0**。
   - 候補が無い → 手順 6 へ。

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

   - **sentinel が出現** → `WATCH_PID` の生存を再確認する（`watch.sh` が sentinel を書いた直後に
     `:407` で exit し、EXIT trap が sentinel を消すレースがある）。生きていれば手順 9 へ。
     死んでいれば下の分類器へ落とす。
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

   1. 値域検証。`^[1-9][0-9]*$` かつ `2147483647` 以下（`instance-id.sh:69-88` と同じ。
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

10. **正常系のログ削除。** `watcher` が `started` / `existing` / `existing-other` かつ `reason` が
    診断を要さない値のとき、`$LOG` を `rm -f` して `log=-` を返す。watcher が `>>` で開き続けている fd は
    生きるので出力は unlink 済み inode へ落ち、ディスクを食わない。
    **`$LOG` には inbox 本文が入る**ので、診断が要らないときに平文で残さない。

#### 出力

**全経路で必ず 1 行、次の 7 キーをこの順で出す。**

```
ensure-agmsg-ready: installed=<yes|no> wired=<yes|no> name=<a|-> watcher=<existing|existing-other|started|none> pid=<n|-> reason=<slug|-> log=<path|->
```

`-` を許すキーは `name` / `pid` / `reason` / `log` の 4 つだけ。`installed` / `wired` / `watcher` は
必ず値域内の値を取る。`wired` の定義は「手順 4 の `delivery.sh set` が成功したか」。

| `reason` | installed | wired | name | watcher | pid | log | exit | stderr |
|---|---|---|---|---|---|---|---|---|
| `-` | yes | yes | name | `existing` / `existing-other` / `started` | pid | `-` | 0 | （出さない） |
| `not-installed` | no | no | name | none | - | - | **1** | `agmsg is not installed at <AGMSG_DIR>` |
| `log-unwritable` | yes | yes | name | 通常どおり | 通常どおり | - | **0** | `cannot create a log under <AGMSG_LOG_DIR>; diagnostics disabled` |
| `delivery-set-failed` | yes | no | name | none | - | path | **1** | `see <log>` |
| `bare-existing` | yes | yes | name | `existing` | pid | `-` | **0** | `the existing watcher has a bare instance id; it will not self-terminate` |
| `not-registered` | yes | yes | name | none | - | path | **0** | `run join.sh for this role first; see <log>` |
| `held-by-other-session` | yes | yes | name | none | - | path | **0** | `run /agmsg drop <name> in the owning session, then retry` |
| `db-unavailable` | yes | yes | name | none | - | path | **0** | `see <log>` |
| `watcher-exited` | yes | yes | name | none | - | path | **0** | `see <log>` |
| `start-timeout` | yes | yes | name | none | - | path | **0** | `see <log>` |
| `bare-started` | yes | yes | name | none | - | path | **0** | `see <log>` |
| `orphan-watcher` | yes | yes | name | none | pid | path | **0** | `watcher <pid> did not stop; kill it manually. see <log>` |
| （exit 2） | no | no | `--name` の値、無ければ `-` | none | - | - | **2** | usage メッセージ |

`log-unwritable` は他の `reason` と**併記されない**（`reason` は 1 値）。ログが作れなかった場合、
その後の経路で本来 `reason` が付くケースでは**後者を優先し**、`log=-` から診断不可を読み取れるようにする。

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
AGMSG_STATE=$(bash <SKILL_DIR>/scripts/ensure-agmsg-ready.sh \
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
- rc 2 は呼び出し側のバグなので停止する。
- `Monitor` があるハーネスでは `watcher=existing-other` になり、そのとき
  `ready.<team>__parent` は生まれず親の inbox 記録は行われない（現状維持）。warn で可視化する。

#### (B) `prewarm-panes.sh` — 全ロールの初期プロンプトに guard を載せる

**prewarm は watcher を起動しない。** 配線に成功した各ロールの初期プロンプトへ guard の実行を含める。
事実 14 のとおり `launch-workspace.sh` は既に対応しているので、渡していなかった review ペインと
codex ペインにプロンプトを渡すだけでよい。プロンプトは 1 行、禁止 6 文字と改行を含まない。

`launch-workspace.sh` は各ペインの起動時に `AGMSG_EXPECTED_NAME=<そのロールの agent 名>` を
composed command へ export する（`--agmsg-from` は既に渡っているので、その値をそのまま使う）。

**`<SKILL_DIR>` に空白が含まれる場合は guard を注入しない。** プロンプトはクォートできないので
`bash /Users/x/My Plugins/…` に分解され bash が exit 127 で終わる。空白を検出したら注入せず
`watcher: "none"` で記録し warn する。

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
AGMSG_SKILL_DIR="$HOME/.agents/skills/agmsg"
[[ -d "$AGMSG_SKILL_DIR/run" ]] && REVIEW_WRITABLE_FLAG+=" --add-dir '$AGMSG_SKILL_DIR/run'"
[[ -d "$AGMSG_SKILL_DIR/db" ]]  && REVIEW_WRITABLE_FLAG+=" --add-dir '$AGMSG_SKILL_DIR/db'"
```

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

sentinel パスのエンコード（事実 17）を 1 箇所に置き、`ensure-agmsg-ready.sh` と `send-prompt.sh` の
両方が source する。規則は `actas-lock.sh:43-73` の `_actas_lock_encode` / `agmsg_ready_path` と同一で、
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
| `none` | 配線に失敗した、または `<SKILL_DIR>` に空白があるので guard を載せていない |

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

5. **本プラグインが常駐プロセスを fork するようになる。** 台数は N タスクで最大 `3N+1`。
   `CLAUDE.md`「関連プラグインとの境界」表の「永続プロセス: なし」を
   **「agmsg inbox watcher（ペインごと 1 プロセス。composite id のときペイン終了から最大
   `AGMSG_WATCH_INTERVAL` 秒で自己終了する。ペインが SIGKILL された場合は `cleanup()` が走らず
   pidfile と sentinel が残る）」**に書き換える。
   guard 側は `kill -0` しか見ないので、**この最大 30 秒の窓で死にかけの watcher を掴みうる**。
   孤児の GC は非目的。

6. **エンコード規則を複製している**（設計 3）。上流の `_actas_lock_encode` が変わっても検出できない。

7. **`ready.*__<encoded name>` の glob は原理的に曖昧である。** `_` は無変換なので、team `a__b` /
   name `c` と team `a` / name `b__c` は同じパスになる。実害は無い — glob の結果は必ず
   pidfile と照合してから使う（手順 6・8-5）ので、誤ヒットしても削除も待機も起きない。

8. **`ps` を PATH 経由で呼ぶ。** agmsg 本体も `compat.sh` / `instance-id.sh` で同様にしており、
   テストからの stub 化もこれに依存する。PATH を汚染できる攻撃者は guard より前に別の手段を持つ。

## テスト

### 共通の stub 契約とフィクスチャ要件

- **stub の配置**: agmsg 側のパスは `AGMSG_READY_DIR` の影響を受けない（`watch.sh:61-62` → `:144` が
  自分の配置から `SKILL_DIR/run` を算出する）。したがって **stub は `<stub>/scripts/watch.sh` に置く**。
- **fixture watcher の起動形**: 必ず `bash "$AGMSG_DIR/watch.sh" <sid> <project> <type> [<name>]`。
  共通ルールのフルパス等価照合がこの形でしか成立しない。
- **stub watcher の擬似コード**（`AGMSG_STUB_MODE` で分岐）:

  ```
  alive              : 名前付き(5 引数)なら ready.<team>__<name> に $AGMSG_STUB_INSTANCE_ID を書き、
                       watch.<$AGMSG_STUB_INSTANCE_ID>.pid に $$ を書き、sleep 300
  sentinel-then-exit : sentinel を書いた直後に exit 0
  no-sentinel        : sentinel を書かず sleep 300
  held               : stderr に 'agmsg watch: cannot claim (held by other sessions): x' を出し exit 1
  unregistered       : stdout に "agmsg watch: no registration for agent 'x'" を出し exit 0
  db-error           : stdout に 'ERROR: cannot open message DB /x' を出し exit 1
  silent-exit        : 何も出さず exit 0
  ```

  `<team>` は guard が team を選ばないので stub が任意に決めてよい。
- **`--name` はプロセス固有にユニーク化する**（例 `ar-$$-<case>`）。
- **`AGMSG_READY_TIMEOUT=1` を既定で渡す。ただし AR9 群だけ `10` を渡し、`SECONDS` で経過 3 秒未満を
  assert する**（上限 1 秒では「即断」と「1 秒待って諦めた」を区別できない）。
- **ケース間の状態リセット**: 各ケースの先頭で `$AGMSG_READY_DIR` を空にし、
  起動した fixture watcher の pid を配列へ記録して **EXIT trap で必ず kill する**
  （`test-runner-terminal-status.sh:20-36` の `cleanup_all` を流用）。これが無いと AR20 と AR3/AR6 が両立しない。
- **出力は必ず 1 行・7 キーが同じ順・値域どおり**をヘルパーで毎ケース検証する。上の表が SoT である。
- **否定ケースの直前に正常系（AR6 と同一 stub 構成）を 1 回通し、stub のログが書かれることを確認する。**
- **`timeout` / `gtimeout` は使わない**（`CLAUDE.md` 項目 23）。ハング検出は
  **コマンド置換をバックグラウンドのサブシェル内で行い、`kill -0` を上限つきでポーリングする**形にする。
  `test-monitor-layout.sh` の `run_bounded` は出力をファイルへ落とすので fd 漏れを検出できない（実測）。

### 新規 `apps/cmux-team-dispatch-task/test/test-agmsg-ready.sh`

| id | 検証内容 |
|---|---|
| AR1 | `send.sh` 不在 → `reason=not-installed` / exit 1 |
| AR2 | `AGMSG_LOG_DIR` に作成不能なパスを渡す → `reason=log-unwritable` かつ **watcher は起動する** / exit 0 |
| AR2b | `TMPDIR` を unset しても `log-unwritable` にならない（`mkdir -p` が効く） |
| AR3 | 自セッションの pidfile に一致し `<name>` を含む生存 watcher → `watcher=existing`、`watch.sh` を新規に呼ばない |
| AR3b | argv[0]/argv[1] が `$AGMSG_DIR/watch.sh` でないプロセス（zsh ラッパー）は候補にしない |
| AR3c | **別セッション**の同名 watcher は候補にせず起動を試みる（→ stub `held` で `held-by-other-session`） |
| AR3d | `<slug>-claude` の watcher（同一セッション）は `existing-other` になる |
| AR3e | broad（4 引数）watcher（同一セッション）は `existing-other` になり起動しない |
| AR3f | pidfile 名が `$SID.<数字>` の形でも候補になる（composite 形の受理） |
| AR3g | `ps` が空出力のとき候補として扱い、起動しない（fail-closed） |
| AR4 | 候補の pid が死んでいれば候補にせず起動する |
| AR5 | sentinel の中身 `T` に対し `watch.$T.pid` の pid が生きていれば削除しない / 無い・死んでいれば削除する |
| AR6 | 正常系: `watch.sh` を 4 引数で起動し、sentinel 出現後に `watcher=started pid=<n>` / exit 0。pidfile 名が composite。**`log=-` になりログファイルが残らない** |
| AR6b | `sentinel-then-exit` stub → 再確認で検知し分類器へ落ちて `watcher=none` |
| AR7 | 印字した `pid=` が `watch.sh` 本体の pid である |
| AR8 | 起動した watcher が生きている間もコマンド置換 `$( )` が戻る。バックグラウンドのサブシェル + `kill -0` ポーリングで検証 |
| AR9a-d | 事実 10 の 4 経路が正しい `reason` に分類され、`AGMSG_READY_TIMEOUT=10` でも 3 秒未満で打ち切られる。inbox 本文に同じ文字列があっても行頭アンカーで誤分類しない |
| AR10 | pidfile 名が bare → SIGTERM で kill して `reason=bare-started`、sentinel が残らない |
| AR11 | `no-sentinel` stub → `AGMSG_READY_TIMEOUT` で打ち切り、SIGTERM で kill、`reason=start-timeout`。**他人の sentinel は消さない** |
| AR12 | 手順 8 の kill 時点で `ps` が空出力 → kill せず `reason=orphan-watcher`、stderr に pid が出る |
| AR13 | `delivery.sh` が AGMSG-DIRECTIVE を印字しても標準出力へ漏れず、`$LOG` に残る（異常系で `log=path` のとき） |
| AR14 | `delivery.sh set` が非ゼロ → `reason=delivery-set-failed` / exit 1、`watch.sh` を呼ばない |
| AR15 | session id: `claude-code` は `$CLAUDE_CODE_SESSION_ID` のみ、`codex` は `$CODEX_THREAD_ID` のみ。両方空なら `agmsg-<uuid>` を生成し `-` を渡さない |
| AR16a-f | exit 2 の 6 条件（必須フラグ欠落 / 未知フラグ / 不正 `--type` / 不正 `--name` / 存在しない `--project` / `AGMSG_EXPECTED_NAME` 不一致）で rc==2 かつ `delivery.sh` / `watch.sh` を呼ばない |
| AR17 | エンコードのゴールデンベクタ 4 本（下記）。`agmsg_ready_path` を source しない |
| AR18 | `reason` ごとに stderr の手掛かりが表のとおり 1 行出る（`-` のときは出ない） |
| AR19 | `$LOG` が 0600 で作られる。同じ `--name` で 2 回連続実行しても 2 回目が失敗しない |
| AR20 | `AGMSG_WATCH_INTERVAL` が watcher の環境へ export される |
| AR21 | 2 回目の guard 実行が `existing` になり、watcher を二重起動しない |

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
| PW2 | `delivery.sh` を失敗させる stub で claude-code 型の全ロールが同時に `watcher: "none"` になり、guard が注入されない |
| PW3 | claude 構成と all-codex 構成の 2 回で、design / executor / review の全ペインが guard を含み `--type` が供給元表どおり |
| PW4 | どのペインの初期プロンプトにも `/agmsg actas` が現れない |
| PW5 | 禁止 6 文字と改行が無い（`[[ $(printf '%s' "$p" \| wc -l) -eq 0 ]]`） |
| PW5b | 空白を含む一時ディレクトリから prewarm を起動すると guard が注入されず `watcher: "none"` になる |
| PW6 | `prewarm-panes.sh` の **stderr** に `AGMSG-DIRECTIVE` が現れない（stdout ではない） |
| PW7 | `ensure-agmsg-ready.sh` が exit 1 でも prewarm が die せず `prewarm.json` を書く |
| PW8 | `--agmsg-team` 無しのとき guard を載せない |
| PW9 | design ペインの gate が `DESIGN_DELIVERY` である |
| PW10 | 各ペインの composed command に `AGMSG_EXPECTED_NAME=<そのロール>` が入る |
| AG1 | `SKILL.md` の Step 1g ブロックを **`TEAM="dispatch-` を awk のアンカー**にして抽出し（Step 1g 配下に bash フェンスが 6 個ある。この文字列は SKILL.md 全体で 1 箇所）、**先に** `test-cleanup-close.sh:95` と同じ sed で `~/.agents` と `<SKILL_DIR>` を stub パスへ置換し、**そのうえで** `~/.agents` が残っていないことを assert してから `set -euo pipefail` 下で実行。rc 0（`started` / `none` / `existing-other` の 3 サブ分岐）/ rc 1 / rc 2 と join 失敗時の継続を検証。stub は `git` / `join.sh` / `resolve-agmsg-type.sh` / `ensure-agmsg-ready.sh` の 4 つ |
| AG2 | 同ブロックが `--name parent` を渡し、`--session-id` を渡さない |
| AG3 | 非 prewarm 経路の子プロンプトブロックが guard 行を含み、`prewarm: true` のときと `<team>` が空のときは落ちる |
| AG4 | 同ブロックの `--type` がタスクごとの engine から解決されている |
| SP25 | `send-prompt.sh` がエンコード済み sentinel パスを参照する（AR17 と同じゴールデンベクタ）。既存 SP1 とは別 id |
| SP26 | `agmsg-path.sh` が読めなくても `send-prompt.sh` が die せず生連結にフォールバックする |
| CR1 | codex review の起動コマンドに agmsg `run` と `db` の `--add-dir` が入り、**`scripts` は入らない**。置き場所は `test/test-launch-workspace-codex.sh` の T5 群の隣（`test-codex-review-sandbox.sh` は codex CLI を実起動する動的テストで `launch-workspace.sh` を読まない） |
| CR1b | `STATUS_DIR` が空でも agmsg 側の `--add-dir` は付く |

既存ヘルパー `assert_no_line_with`（`test-prewarm-unattended.sh:60-65`）には「grep 対象のファイルが
実在すること」のガードが無い。ガードを足す（U2 / U3 / U8 は追加後も PASS することを確認済み）。
**ファイルが実在しても中身が空なら同じ vacuous pass が起きる**ので、否定形を使う PW ケースでは
「argv.log の行数が期待値と一致する」を先に assert する。

## ドキュメント

`apps/cmux-team-dispatch-task/CLAUDE.md` の 4 ファイル整合ルールに従い、同一コミットで更新する。
**1 行 = 1 参照。** 全 31 行。

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
| 16 | 同上 | 767 | 「design / claude executor の初期プロンプト」→ 全ロール |
| 17 | 同上 | 837-838 | 「パスのエンコードは不要」 |
| 18 | 同上 | 911-912 | `monitor-dispatch.sh` の起動条件 |
| 19 | 同上 | 1290 | 補足の Delivery 要約 |
| 20 | `README.md` | 200-203 | `monitor-dispatch.sh` の起動条件 |
| 21 | 同上 | 212-213 | 「エンコードは不要」 |
| 22 | 同上 | 239 付近 | 「`AGMSG-DIRECTIVE:` に従って watcher を起動する」 |
| 23 | 同上 | 373 | 「3点セット」の内訳 |
| 24 | `CLAUDE.md` | ファイル構成表 | `ensure-agmsg-ready.sh` と `agmsg-path.sh` の行を追加 |
| 25 | 同上 | 154（項目 12） | AGMSG-DIRECTIVE 遵守 → guard の検証項目。**回帰は `test-agmsg-ready.sh`（AR1-21）と AG1-4** |
| 26 | 同上 | 165（項目 15） | 「エンコードは不要」＋ ready sentinel 段落。**回帰は SP25-26** |
| 27 | 同上 | 166（項目 15） | 「design / claude executor の初期プロンプト」→ 全ロール。**回帰は PW1-10** |
| 28 | 同上 | 194（項目 20） | 「3点セット」の内訳。**回帰は CR1/CR1b** |
| 29 | 同上 | 215（項目 25） | 「3 点は不変」 |
| 30 | 同上 | 298 / 308 / 320（E2E 17 / 27 / 39） | E2E 手順の書き換え |
| 31 | 同上 | 「関連プラグインとの境界」表 | 「永続プロセス: なし」→ トレードオフ 5 の文言 |

加えて `docs/notification-gaps.md` に 2 行足す。修正したパターンへ
「agmsg watcher が起動せず inbox 記録が全ロールで落ちる（`SKILL.md` の AGMSG-DIRECTIVE 依存）→ guard を追加」、
未解決へ「`/clear` 後に watcher が戻らない（`Monitor` 非搭載ハーネス）」。
`CLAUDE.md:26` がこのファイルを正本と定めている。

コード内コメントの更新: `prewarm-panes.sh:584,617`（「codex は初期 prompt 無し」）、
`launch-workspace.sh:791`（「`/agmsg actas <name>` + 待機指示を初期 prompt にする」）。

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
for t in apps/cmux-team-dispatch-task/test/*.sh; do printf '%-56s ' "$t"; if bash "$t" >/dev/null 2>&1; then echo OK; else echo FAILED; fi; done
bash apps/cmux-team-dispatch-task/test/test-send-prompt-callsites.sh
node scripts/check-doc-lang.mjs apps/cmux-team-dispatch-task
pnpm check
git worktree list
git branch --list 'feat/pg*' 'feat/is*' 'feat/ov*' 'feat/pw*'
```

`@tanaka-yui/token-meter` の `noNonNullAssertion` 警告 4 件は既知のノイズ。

## 改訂履歴

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
