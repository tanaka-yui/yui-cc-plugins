# agmsg セットアップガードの設計

対象: `apps/cmux-team-dispatch-task`

> 改訂 4。spec レビュー ラウンド 1〜3 の指摘を反映した。差分は末尾「改訂履歴」を参照。

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

3. **`delivery.sh set` は冪等。** 同一モードで 2 回実行して `settings.local.json` がバイト単位で
   一致することを確認した。

4. **`delivery.sh set` の出力は watcher の有無の根拠にならない。** `emit_monitor_directive` が
   ディレクティブを抑止する条件は `run/watch.<session_id>.pid` の存在と生存だけで、**project を見ない**。

5. **`watch.sh` は session_id を自前で正規化する**（`watch.sh:141`、`agmsg_normalize_instance_id`）。
   agent 種別ごとの ppid walk で祖先を探し、見つかれば `<sid>.<pid>` の composite にする。
   pidfile 名は正規化後の id で決まるため、**同一 session_id で 2 つ目の watcher を起動すると
   `watch.sh:165` が前の watcher を kill する**（意図的な重複排除、#66）。
   **argv からは bare / composite を判別できない**（正規化は `watch.sh` 内部で起きる）。
   判別できるのは **sentinel の中身**（`watch.sh:392` が正規化後 id をそのまま書く）と pidfile 名だけである。

6. **composite でなければ liveness guard が効かない。** `watch.sh:407` は
   `agmsg_instance_is_composite` でゲートされている。bare id の watcher は永久に自己終了しない。
   逆に composite なら `agmsg_instance_alive` が `_agmsg_pid_alive "$pid" || return 1` を**先に**通すので、
   `cc-instance.<pid>` の有無に関わらずその pid が死んだ時点で DEAD になり、watcher は自己終了する。
   評価はループ先頭なので、**遅延は最大 `AGMSG_WATCH_INTERVAL` 秒**である。

7. **bare id の ready sentinel は GC で消される。** `agmsg_instance_alive` の bare 分岐は
   `cc-instance.*` のどれとも一致しないので常に DEAD であり、`session-start.sh:224-228` が
   sentinel を無条件に削除する。このループは project でも team でも絞られず、agmsg 配線済みの
   claude セッションがどこかで起動 / `/clear` / resume するたびに走る。sentinel は起動時に
   1 回しか書かれない（`watch.sh:385-395`）ので、消えたら復活しない。
   → **watcher は composite でなければならない。すなわちペイン自身が自分のセッション id で起動するしかない。**

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

    | 経路 | 出力先 | 文言（`grep` の分類キー） | exit |
    |---|---|---|---|
    | `:267-271` held | stderr | `agmsg watch: cannot claim (held by other sessions): …` | 1 |
    | `:274-281` 未登録 | stdout | `agmsg watch: no registration for agent '…'` | 0 |
    | `:374-377` DB | stdout | `ERROR: cannot open message DB …` | 1 |
    | `:405-408` liveness guard | **出力なし** | — | 0 |

    3 つの文言はいずれも `watch.sh` 内で 1 箇所ずつしか出現しないので、分類キーとして一意である（実測 grep）。
    ほかに引数不足（`:56-59`）・不正 type（`:86-99`）・`ctrl:despawn`（`:467`）・シグナル（`:208`）も
    即終了しうるが、いずれも「上記以外」に落ちる。

11. **`watch.sh` の name フィルタは team を見ない**（`watch.sh:213`）。`ACTIVE_NAME` があるとき、
    同名 role が複数 team にあれば全部を claim しに行き、1 つでも他セッションが保持していれば
    `watch.sh:271` で exit 1 する。実測で `parent` は `dispatch-yui-cc-plugins` と `yui-cc-plugins` の
    2 team に登録されていた。claim できた team すべてに sentinel を書く（`watch.sh:385-394`）。

12. **`Monitor` が起動する broad watcher は 4 引数で name を持たない**（`delivery.sh:329` の
    `printf '%q %q %q %q'`）。実機の稼働プロセスでも確認した。
    **name で照合するプローブでは broad watcher を検出できない。**

13. **codex 型には watcher を起動する既定経路が無い。** `type.conf` が `monitor=no` で、
    `_delivery.sh` の `on_enable` はシェル関数の導入手順を印字する。

14. **`launch-workspace.sh` は `--mode standby` / `--mode review` で初期プロンプトを受け付ける**
    （`:723-726` / `:758-771` / `:789-796`）。第 2 位置引数であり `--prompt` フラグではない。
    ただしプロンプトは `zsh -ic "… '<prompt>' …"` に二重埋め込みされエスケープされないので、
    **`'` `"` `` ` `` `$` `!` `\` と改行を含まない 1 行**でなければならない。改行が入ると
    `wc -l < argv.log` でペイン数を数えている既存 8 件のアサーションが同時に壊れる
    （`test-prewarm-unattended.sh` U3/U4/U5/U6、`test-prewarm-all-codex.sh` AC1、
    `test-prewarm-layout.sh` PG1/PG2/PG3）。**プロンプト中のパスもクォートできない。**

15. **codex review ペインだけ sandbox が違う。** `--sandbox workspace-write -c approval_policy='never'`
    で起動される（`launch-workspace.sh:766-771`）。`watch.sh` は `~/.agents/skills/agmsg/run/` へ
    pidfile と sentinel を書き、DB も同ディレクトリ配下を読み書きするので既定では拒否され、
    `approval_policy=never` なので昇格も求められない。`test/test-codex-review-sandbox.sh` の S1 が
    「`--add-dir` 無しでは workspace 外への `touch` が拒否される」ことを検証している。

16. **`prewarm-panes.sh` の既存の配線呼び出しはディレクティブを漏らしている。**
    `prewarm-panes.sh:411,417` の `>&2 2>/dev/null` はリダイレクトが左から評価されるため
    **stdout を元の stderr に複製してから stderr を捨てる**。AGMSG-DIRECTIVE は `delivery.sh:332` の
    stdout なので、そのまま呼び出し元の **stderr** へ出ている（実測）。

17. **`send-prompt.sh` の sentinel パスはエンコードしていない。** `watch.sh` が実際に作るのは
    `agmsg_ready_path`（`actas-lock.sh:69`）＝ `[A-Za-z0-9._-]` 以外を `%XX` に変換したパスだが、
    `send-prompt.sh:146` は `ready.${TEAM}__${TO_AGENT}` の生連結である。
    `TEAM="dispatch-$(basename "$(git rev-parse --show-toplevel)")"` なので、リポジトリ名に空白や
    非 ASCII が入ると発火する。`$SLUG` は `prewarm-panes.sh:190` で `^[A-Za-z0-9._-]+$` に検証済みなので、
    **エンコードが効くのは team 名側だけ**である。

18. **`/clear` は watcher を失わせる。** `session-start.sh:249` は SessionStart のたびに
    `cc-instance.<pid>` を新しい INSTANCE_ID で上書きする。`/clear` は新しい session_id を採番するので、
    稼働中 watcher の token `<旧sid>.<pid>` は DEAD になり、`watch.sh:407` が exit して
    `cleanup()` が sentinel を消す。`/compact` は同一 session_id を保つので影響しない
    （`session-start.sh:253-257`）。

19. **`CODEX_THREAD_ID` は fresh codex では export されない。** agmsg 本体が 2 箇所で明言している
    （`drivers/types/codex/_session-start.sh:53-54`、`codex-bridge.js:977`）。
    `launch-workspace.sh` の codex ペインは素の起動なので通常は空である。
    `SKILL.md` Step 1g の `PARENT_ENGINE` 検出も同じ変数に依存しているので、
    **engine 誤検出と session id 欠落は同時に起きうる**（本 spec では扱わない既存の性質）。

20. **`agmsg_resolve_project` は呼び出し元によって team スコープが違う。**
    `join.sh:57` は team を渡すが `watch.sh:131` は渡さない（`resolve-project.sh:441-445` が
    「team-agnostic callers (whoami/actas/watch/reset) omit it」と明記）。食い違えば `PAIRS` が空になり
    `no registration` へ落ちる。`watch.sh:211` は `identities.sh` の失敗もチェックしていないので、
    同じ経路に落ちる。
    **engine 差**: claude-code は `run/proj.<agent_pid>.project` マーカーが常に勝ってメインリポジトリへ、
    codex はマーカーを書かないのでワークツリーのまま解決される（実測 17 件）。

21. **`git rev-parse --show-toplevel` はワークツリー内でワークツリー自身を返す**（実測）。
    メインリポジトリは `dirname "$(git -C "$P" rev-parse --path-format=absolute --git-common-dir)"` で導く。
    実機の稼働 watcher は**両方の綴りが混在**していた。

### 現状のロール別 watcher 実態

| ロール | 初期プロンプト | watcher | ready sentinel |
|---|---|---|---|
| parent (claude) | AGMSG-DIRECTIVE → Monitor | broad 購読 | **無し**（事実 2） |
| design (claude) | `/agmsg actas <slug>` | named | Monitor がある場合のみ |
| claude executor | `/agmsg actas <slug>-claude` | named | Monitor がある場合のみ |
| `<slug>-review` | **無し** | **無し** | **無し** |
| design (codex) / codex executor | **無し** | **無し** | **無し** |
| 非 prewarm 経路の子 | タスクプロンプトのみ | **無し** | **無し** |

`prewarm.json` の `delivery: "agmsg"` は「hook ファイルを書けた」以上の意味を持たない。

## 目的

1. agmsg が「インストールされている」ことではなく「このセッションで実際にセットアップ済みである
   （inbox watcher が動いている）」ことを判定できるようにする。
2. 未セットアップのとき、追従不能なディレクティブを出して先へ進むのをやめ、**その場でセットアップを
   行ってから継続する**。
3. claude / codex の両エンジン、および親・設計・実装・レビューの全ロールについて、agmsg を配線する
   すべての経路が **定義済みの終了状態**（watcher 稼働、または明示的に記録されたフォールバック）で
   終わるようにする。

## watcher の価値についての正確な記述

事実 9 のとおり、名前付き watcher は配信した行を既読にする。したがって watcher の価値は
**「未読の inbox 項目が増えること」ではない**。正確には次の 2 つである。

1. **`Monitor` ツールがあるハーネスでは、行がセッションのコンテキストへ実際に注入される。**
   これは本物の配送であり、既読化はその正しい帰結である。
2. **`Monitor` が無いハーネスでは、`send-prompt.sh` が inbox 記録を行うようになり、本文が
   `history.sh` から辿れるようになる。** ログとしての価値であって、未読通知ではない。

どちらの場合も wake はタイプ入力が担う。**watcher の欠如は配送の欠如ではない。**

## 非目的

- **watcher の欠如を致命的にしない。**
- **既存の watcher を置き換えない**（後述の中核方針 2）。
- **ready sentinel を watcher 無しで書かない。** sentinel の契約は `actas-lock.sh:63-68` で
  「present iff a live watcher is currently receiving for that role」と定義され、
  `spawn.sh:713` の `--wait-ready` がこの不変条件に依存している。
- **セッション途中の `/clear` / resume 後の再セットアップは対象外**（事実 18）。guard は初期プロンプトから
  1 回だけ走る。`Monitor` があるハーネスでは SessionStart が AGMSG-DIRECTIVE を再送するので復帰するが、
  無いハーネスではそのペインの watcher は戻らない。`SKILL.md` に既知の制限として書く。
- codex の bridge（`codex-bridge.js` / シェル shim）の導入・自動化。
- agmsg 本体（`~/.agents/skills/agmsg/`）への変更。
- delivery mode の変更（`monitor` 固定）。
- `SKILL.md` 全体のプレースホルダ統一（`<SKILL_DIR>` と `<this-skill-dir>` の混在）。
  本 spec が編集する箇所は周囲の表記（Step 1g 周辺は `<SKILL_DIR>`）に合わせる。
- `loop-cleanup.sh` の leave 列挙に `<slug>-claude` が無い既存の穴（`prewarm-panes.sh:438` は
  その名前で join している）。本設計はこのロールで actas ロックを握る watcher を起動するので影響は
  重くなるが、修正は別件とする。
- バージョン番号の更新、push、PR 作成。

## 検討したが採らなかった代替

**`actas-claim.sh` による事前 claim（改訂 2 の設計）。** これは照会ではなく本番の claim であり、
`actas_lock_claim` で実際にロックを取る（解放は held ロールバック時のみ）。watcher を得られずに
終わった経路でロックが残り、composite なのでペインが生きている限り有効なままになる。
その状態のロールは他セッションの broad 購読からも除外される（`watch.sh:235-246`）ため、
**watcher も無く他人からも受信できない**黒穴になる。agmsg には解放専用の CLI が無い
（`reset.sh` は登録ごと削除する）。`actas-lock.sh` を source する案は、同ファイルが `SKILL_DIR` と
`instance-id.sh` に依存するため stub 環境で素直に source できず採らない。

代わりに **`watch.sh` 自身の暗黙 claim（事実 2）に任せ、必要な情報はすべて watcher の起動結果から得る**
（事実 10 の分類）。

**既存 watcher の置換と復元（改訂 3 の手順 7）。** 削除した。中核方針 2 により置換自体が起きなくなり、
復元の必要が消えた。`ps` の argv 文字列を再実行する形は、Claude Code の Bash ツールが張る
ラッパーシェル（`eval '…' && pwd -P >| …`）を掴むと任意コード実行になるため、そもそも危険だった。

## 設計

### 中核方針

> **1. watcher は、そのロールのペイン自身が、自分のセッション id で起動する。**
> 他ペインの代理で watcher を起動する経路は作らない（事実 7・8）。
> 起動は `nohup … &` の 1 行で行い、サブシェルにも `setsid` にも包まない。
>
> **2. guard は既存の watcher を決して kill・置換・復元しない。**
> 何らかの watcher がこの (project, type) で生きていれば、guard は何もせず終了する。

方針 2 の帰結が重要である。`Monitor` があるペインには SessionStart 由来の broad watcher が既に
生きているので、guard は手を出さない。**その場合そのロールに sentinel は生まれず、`send-prompt.sh` は
現行どおり typed-only へ縮退する** — つまり `Monitor` が働いている限り現状と同じ挙動になる。
guard が価値を出すのは **watcher が 1 つも無いとき**、すなわち再現した障害そのものの状況だけである。

これは「注入する watcher（価値 1）を、注入しない watcher（価値 2）で置き換えない」という判断である。
価値 1 のほうが上位なので、置換は常に劣化になる。

方針 2 から、**guard が起動した watcher は定義上「読み手が居ない」**ことが導かれる
（読み手が居るなら watcher が既にあり、guard は起動しない）。これが `AGMSG_WATCH_INTERVAL` を
上げてよい根拠である。

### 1. 新スクリプト `scripts/ensure-agmsg-ready.sh`

```
ensure-agmsg-ready.sh --type <claude-code|codex> --name <agent> [--project <path>]
```

| フラグ | 既定 | 意味 |
|---|---|---|
| `--type` | 必須 | `claude-code` または `codex` |
| `--name` | 必須 | このセッションが名乗る agmsg agent 名。`^[A-Za-z0-9._-]+$` |
| `--project` | `$PWD` | プロジェクトパス。解決は `watch.sh` が内部で行う |

`--project` を省略可にしたのは、初期プロンプトが事実 14 の制約でパスをクォートできず、
空白入りパスを渡すと未知引数として exit 2 になるためである。ペインの cwd は必ずワークツリーなので、
省略が常に正しい値になる。

| 環境変数 | 既定 | 用途 |
|---|---|---|
| `AGMSG_DIR` | `$HOME/.agents/skills/agmsg/scripts` | agmsg スクリプトの場所 |
| `AGMSG_READY_DIR` | `$(dirname "${AGMSG_DIR}")/run` | sentinel と pidfile の場所。**明示指定を常に優先**（`:-` 付き） |
| `AGMSG_LOG_DIR` | `${TMPDIR:-$HOME/.cache}` | watcher のログの置き場。`TMPDIR` が空でも 1777 の `/tmp` に落ちない |
| `AGMSG_READY_TIMEOUT` | `15` | sentinel の出現を待つ上限秒数 |
| `AGMSG_WATCH_INTERVAL` | `30` | 起動する watcher へ export するポーリング間隔（`watch.sh:148` が env を最優先） |

フラグは 3 つだけにする。可変にする必要があるものは環境変数へ寄せ、stub 化手段を統一する。

session id: `--type claude-code` なら `$CLAUDE_CODE_SESSION_ID`、`--type codex` なら
`$CODEX_THREAD_ID` **のみ**を見る（他方の変数は参照しない）。**空なら guard 自身が
`agmsg-$(uuidgen | tr 'A-Z' 'a-z')` を 1 回生成して渡す。`-` は渡さない。**
`-` を渡すと `watch.sh` が起動ごとに別 uuid を採番し、同一ペインで guard が 2 回走ったときに
2 本目が 1 本目に held される（事実 19 のとおり codex では常にこの経路になる）。

#### 共通ルール: 正規化 id と composite 判定

3 箇所（手順 3・5・6）で使うので 1 つの関数に切り出す。

- **正規化 id の取得**: 第一に **sentinel の中身**（`watch.sh:392` が正規化後 id をそのまま書く）。
  sentinel がまだ無い場合は pidfile 名から復元する。剥がしは `session-start.sh:222` と同形にする。

  ```bash
  id=${f##*/}; id=${id#watch.}; id=${id%.pid}
  ```

- **composite 判定**は `agmsg_instance_is_composite`（`instance-id.sh:171-183`）の 3 条件を逐語で写す。
  (1) `.` を含む (2) 最後の `.` より前が**非空** (3) 最後の `.` より後が**全数字**。
  「末尾が `.<数字>`」だけでは (2) が漏れる。
- **owner の生存判定**は `agmsg_instance_alive` の 2 分岐を写す。
  - composite: 埋め込み pid が生存し、**かつ `$AGMSG_READY_DIR/cc-instance.<pid>` が存在する場合に限り**
    その内容が token と一致する。存在しなければ pid 生存だけで ALIVE
    （`instance-id.sh:418` の `[ -f "$f" ] || return 0`）。**codex は `cc-instance` を書かない**ので
    この分岐が効く。ここを bare 分岐の規則で書くと codex の生きた owner を必ず「死」と誤判定する。
  - bare: `$AGMSG_READY_DIR/cc-instance.*` のいずれかの内容が token と一致し、その pid が生存。

#### sentinel の探し方

guard は team を選ばない。`$AGMSG_READY_DIR/ready.*__<encoded name>` を glob し、
**1 件でも owner が生きていれば ready とみなす**。`<encoded name>` は設計 3 のエンコードを適用した値。
事実 11 のとおり `watch.sh` は claim できた全 team に sentinel を書くので、team を 1 つに決める操作は存在しない。

#### 処理

1. **インストール確認。** `$AGMSG_DIR/send.sh` が無ければ `reason=not-installed` で **exit 1**。
2. **ログの用意。** `LOG=$(umask 077; mktemp "$AGMSG_LOG_DIR/agmsg-watch-$NAME.XXXXXX")`。
   失敗したら `reason=log-unwritable` で **exit 0**（ログが取れないことは配線の失敗ではない）。
   - `mktemp` は `O_CREAT|O_EXCL` なので symlink 追従も既存上書きも原理的に起きず、`set -C` が不要になる。
   - **固定名にしない。** 固定名 + 「unlink しない」だと同名 2 回目が必ず失敗し、`--name parent` は
     全ディスパッチ共通なので 2 回目以降の親 guard が毎回失敗する。
   - `umask` は `$( )` の中に閉じる。**`nohup … &` をサブシェルに包んではならない**（事実 8）が、
     ログ生成だけのサブシェルは無関係で安全である。
3. **配線。** `delivery.sh set monitor <type> <project>` を実行し、stdout・stderr の両方を
   `>>"$LOG"` へ落とす。`/dev/null` ではない（AGMSG-DIRECTIVE と codex のシェル shim 手順を
   呼び出し元へ漏らさないが、事後解析はできる）。非ゼロ終了なら `reason=delivery-set-failed` で **exit 1**。
4. **既存 watcher のプローブ（2 パス）。** `$AGMSG_READY_DIR/watch.*.pid` を走査し、各 pid について
   `ps -ww -eo pid=,args=` の argv を判定する。**guard はパスを正規化しない**（受け取った文字列のまま
   比較する。macOS の `/var` と `/private/var` の食い違いを持ち込まないため）。

   共通条件（`instance-id.sh:351-370` の `agmsg_args_is_grok_watcher` と同じ流儀）:

   1. argv[0] または argv[1] が `$AGMSG_DIR/watch.sh` と**フルパスで一致**する
      （agmsg 本体も `watch.sh:171` / `session-start.sh:173` / `delivery.sh:622` の 3 箇所すべてで
      フルパス照合している）。Claude Code の Bash ツールが張るラッパーシェル
      （argv[0]=`/bin/zsh`, argv[1]=`-c`）はこの条件で落ちる
   2. `<type>` が位置引数として**厳密等価**で存在する
   3. project の位置引数が `--project` の値、またはメインリポジトリのパスと**厳密等価**である。
      メインリポジトリは `dirname "$(git -C "$PROJECT" rev-parse --path-format=absolute --git-common-dir)"`。
      `--show-toplevel` は使えない（事実 21）。`--path-format` を解さない古い git では
      `git -C "$PROJECT" rev-parse --git-common-dir` を `$PROJECT` 基準で絶対化する。
      **`--project` が git リポジトリでない場合はこの綴りを候補に加えないだけ**にする
      （`set -e` 下で死なせない。rc 128 を握り潰す）
   4. その pid が生存している

   - **パス A（自分のロール）**: 共通条件 ＋ 「`<name>` が位置引数として厳密等価で存在する」。
     一致したら `watcher=existing` で **exit 0**。共通ルールで正規化 id を取り composite かどうかを見て、
     bare なら `reason=bare-instance-id` を添える（**kill はしない**。中核方針 2）。
   - **パス B（他の誰か）**: 共通条件のみ（name は問わない）。一致したら
     `watcher=existing-other` で **exit 0**。broad watcher（事実 12）と、別ロール名の watcher が
     ここに入る。**このロールに sentinel は生まれないので、`send-prompt.sh` は typed-only へ縮退する。**
   - 一致が無ければ手順 5 へ。
   - 一致は無いが sentinel だけがある場合、共通ルールで owner の生存を確認し、
     **死んでいると確認できたときだけ** `rm -f` する。生きた別プロセスの sentinel を消すと、
     sentinel は再作成されないのでそのロールが永久に不可視になる。
   - `ps` が使えない（`command -v` ではなく**実際に 1 回叩いて出力が空でないこと**で判定する。
     guard は `ps` を裸で呼ぶ）→ **degraded**。プロセス照合を諦め、sentinel の owner 生存だけで
     パス A を判定する。パス B は判定できないので、**degraded では起動しない**
     （`watcher=none reason=degraded-probe` で exit 0）。置換事故を避ける fail-closed。
   - `ps` の argv は空白で分割されるため、**プロジェクトパスに空白があると検出できない**。
     その場合も起動しない側に倒れる（`agmsg_args_is_grok_watcher` と同じ fail-closed 方針）。
5. **起動。**

   ```bash
   AGMSG_WATCH_INTERVAL="${AGMSG_WATCH_INTERVAL:-30}" \
   nohup bash "$AGMSG_DIR/watch.sh" "$SID" "$PROJECT" "$TYPE" "$NAME" </dev/null >>"$LOG" 2>&1 &
   WATCH_PID=$!
   ```

   - **サブシェルで包まない / `setsid` を使わない / `bash -c` を挟まない**（事実 8。`bash -c` は
     `$!` が中間シェルの pid になり、kill しても watcher が孤児として残る）。
   - **fd 3 本すべてを付け替える。** どれかを呼び出し元のパイプに残すと、コマンド置換やツール実行が
     パイプの EOF を待って戻らなくなる（ペインのツール呼び出しがハングする）。逆に stderr だけ残すと、
     呼び出し元終了後の書き込みで watcher が SIGPIPE で無言死する（`watch.sh` に PIPE trap は無い）。
6. **待機。** 0.2 秒間隔で次を見る。上限は `AGMSG_READY_TIMEOUT` 秒。

   - **sentinel が出現** → もう一度 `WATCH_PID` の生存を確認する（`watch.sh` が sentinel を書いた
     直後に `:407` で exit し、EXIT trap が sentinel を消すレースがある）。生きていれば手順 7 へ。
   - **`WATCH_PID` が死んだ** → 待機を打ち切り、`$LOG` を**行頭アンカー付き**で分類する（事実 10）。
     `$LOG` には watcher が配信した inbox 本文そのものが入る（`watch.sh:469`）ので、全文 grep にすると
     `--loop` の GitHub issue 本文が分類器に食われる。

     | 行頭パターン | `reason` |
     |---|---|
     | `^agmsg watch: cannot claim` | `held-by-other-session` |
     | `^agmsg watch: no registration` | `not-registered` |
     | `^ERROR: cannot open message DB` | `db-unavailable` |
     | 上記以外（liveness guard は**空ログ**） | `watcher-exited` |

   - **時間切れ** → watcher を kill する（下記の安全規則）。kill 後、sentinel が存在しその owner が
     自分の起動した watcher のものなら削除する。`reason=start-timeout`。

   **kill の安全規則**（agmsg 本体と同水準にする）:

   1. 値域検証。`_agmsg_pid_valid`（`instance-id.sh:69-88`）と同じく `^[1-9][0-9]*$` かつ
      `2147483647` 以下。`kill 0` は呼び出し元のプロセスグループ全員に SIGTERM を送る。
   2. `$AGMSG_DIR/watch.sh` のフルパス cmdline 照合。guard は `$!` を `wait` しないので、
      watcher が早期に死ぬと pid は即座に再利用可能になる。
   3. **degraded（`ps` 不可）では kill しない**（fail-closed）。
   4. **SIGTERM のみ。`kill -9` は使わない。** `watch.sh:208` の `trap 'exit 0' INT TERM HUP` と
      EXIT trap の `cleanup()` が pidfile と sentinel を掃除する唯一の経路である。SIGKILL だと
      sentinel が残り、`send-prompt.sh:146` はそれを見て「生きている」と判断する。
   5. kill 後は上限 2 秒・0.1 秒間隔で `kill -0` が失敗するまで待ち、そのうえで sentinel の
      owner 照合をして削除する。
7. **composite 検証。** 共通ルールで正規化 id を取り、composite でなければ watcher を kill し
   （手順 6 と同じ安全規則）、sentinel を掃除して `reason=bare-instance-id` を出力する。
   bare へ落ちる経路は `ps` 不可・20 hops 超・プロセス階層の変更で残るので、
   「サブシェルを外したから composite になるはず」で済ませない。
   composite なら `watcher=started` を出力する。

#### 出力と終了コード

**全経路で必ず 1 行、同じ 7 キーを同じ順で出す。**

```
ensure-agmsg-ready: installed=<yes|no> wired=<yes|no> name=<a> watcher=<existing|existing-other|started|none> pid=<n|-> reason=<slug|-> log=<path|->
```

`wired` の定義は「手順 3 の `delivery.sh set` が成功したか」。**watcher の状態とは独立**である。
`log=` は手順 2 で `mktemp` に成功したときだけパス、それ以外は `-`。

| `reason` | installed | wired | watcher | pid | log | exit | stderr の手掛かり |
|---|---|---|---|---|---|---|---|
| `-` | yes | yes | `existing` / `existing-other` / `started` | pid | path | 0 | （出さない） |
| `not-installed` | no | no | none | - | - | **1** | `agmsg is not installed at <AGMSG_DIR>` |
| `log-unwritable` | yes | no | none | - | - | **0** | `cannot create a log under <AGMSG_LOG_DIR>` |
| `delivery-set-failed` | yes | no | none | - | path | **1** | `see <log>` |
| `not-registered` | yes | yes | none | - | path | **0** | `run join.sh for this role first; see <log>` |
| `held-by-other-session` | yes | yes | none | - | path | **0** | `run /agmsg drop <name> in the owning session, then retry` |
| `db-unavailable` | yes | yes | none | - | path | **0** | `see <log>` |
| `watcher-exited` | yes | yes | none | - | path | **0** | `see <log>` |
| `start-timeout` | yes | yes | none | - | path | **0** | `see <log>` |
| `bare-instance-id` | yes | yes | `existing` または none | pid または - | path | **0** | `see <log>` |
| `degraded-probe` | yes | yes | none | - | path | **0** | `ps is unavailable; not starting a watcher` |
| （exit 2） | - | - | - | - | - | **2** | usage メッセージ |

`not-registered` を exit 0 にしたのは、**その時点で `delivery.sh set` は成功しており配線はできている**
からである。exit 1 にすると (A) が `TEAM=""` と `AGMSG_INSTALLED=false` を立て、
**親ロール 1 つの登録不整合でディスパッチ全体が agmsg を捨てる**。
`not-registered` の意味は「未登録、または join 時と別 project へ解決された（事実 20）、
または `identities.sh` の解決失敗」である。

exit 2 の発生条件（いずれも `delivery.sh` / `watch.sh` を 1 度も呼ばずに終了する）:
必須 2 フラグの欠落 / 未知フラグ / `--type` が `claude-code` `codex` 以外 /
`--name` が `^[A-Za-z0-9._-]+$` に一致しない / `--project` が存在しないディレクトリ。

`--name` の検証は必須である。`--name` は sentinel パスでは設計 3 でエンコードされるが、
`$LOG` のファイル名には生連結されるので、`../../…` で `$AGMSG_LOG_DIR` の外へ抜けると
**watcher が inbox 本文をそのファイルへ追記し続ける**。到達経路は (C)（`<task-slug>` は
`prewarm-panes.sh:190` のゲートを通らない）。(A) は `parent` 固定、(B) は同ゲートを通るので安全。

**watcher を起動できなかったことは決して exit 1 にしない。**

### 2. 呼び出し箇所

#### (A) 親オーケストレーター — `SKILL.md` Step 1g

「AGMSG-DIRECTIVE が出たら従え」という散文を置き換える。
**rc の分岐はこの fenced block の中に書く**（テスト AG1 がブロックを抽出して実行するため）。

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
       *"watcher=none"*) echo "[warn] agmsg watcher not running ($AGMSG_STATE)" ;;
     esac ;;
  1) TEAM=""; AGMSG_INSTALLED=false
     echo "[warn] agmsg wiring failed ($AGMSG_STATE) — typed-only delivery with monitor-dispatch.sh" ;;
  *) echo "[error] ensure-agmsg-ready.sh usage error ($AGMSG_STATE)"; exit 1 ;;
esac
```

- **`|| AGMSG_RC=$?` の形が必須。** `set -e` 下では `V=$(cmd)` が非ゼロを返した時点でシェルが即終了し、
  `case` に到達しない。`||` が `set -e` を無効化する。
- **`join.sh` にも `|| true` が必須。** 同じ理由で、join が非ゼロを返すと guard に到達しない。
  `not-registered` の救済手順が「join.sh を先に実行せよ」である以上、join 失敗は現実的な経路である。
- rc 1 では `TEAM=""` に加えて **`AGMSG_INSTALLED=false`** を立てる。これが無いと Step 3 で
  `monitor-dispatch.sh` も起動せず、agmsg 記録も heartbeat も無い穴に落ちる。
  **`AGMSG_INSTALLED` の意味はここで「`send.sh` が存在するか」から「agmsg を使うか」へ広がる。**
  変数名は据え置き、`SKILL.md:520-521` の定義文を「agmsg を使うか。`send.sh` の存在で初期化し、
  配線に失敗したら `false` へ落とす」に書き換える。
- rc 2 は呼び出し側のバグなので停止する。rc 1 と同じ扱いにすると、フラグ名のタイポが
  「agmsg 無しで普通に動いた」ように見えて恒久化する。
- `Monitor` があるハーネスでは `watcher=existing-other`（SessionStart 由来の broad watcher）になり、
  guard は何もしない。**そのとき `ready.<team>__parent` は生まれず、親の inbox 記録は現行どおり
  行われない。** guard が sentinel を作るのは watcher が 1 つも無いときだけである。

#### (B) `prewarm-panes.sh` — 全ロールの初期プロンプトに guard を載せる

**prewarm は watcher を起動しない。** 配線に成功した各ロールの初期プロンプトへ guard の実行を含める。
事実 14 のとおり `launch-workspace.sh` は既に対応しているので、渡していなかった review ペインと
codex ペインにプロンプトを渡すだけでよい。

プロンプトは 1 行、`'` `"` `` ` `` `$` `!` `\` と改行を含まない。`--project` は渡さない。

**`<SKILL_DIR>` に空白が含まれる場合は guard を注入しない。** プロンプトはクォートできないので
`bash /Users/x/My Plugins/…` に分解され、bash が exit 127 で終わる（`ensure-agmsg-ready.sh` は
1 度も走らない）。プロンプトは「continue even if it exits non-zero」なので**全ロールが無言で
watcher 無しになる**。空白を検出したら注入せず `watcher: "none"` で記録し warn する。

**`<T>` の供給元**（6 ペインを網羅する）:

| ロール | agent 名 | `<T>` の供給元 | gate 変数 |
|---|---|---|---|
| design | `$SLUG` | `DESIGN_WIRING_TYPE`（`:427-428`） | `DESIGN_DELIVERY` |
| claude executor | `$SLUG-claude` | リテラル `claude-code` | `CLAUDE_DELIVERY` |
| codex executor | `$SLUG-codex` | リテラル `codex` | `CODEX_DELIVERY` |
| review | `$SLUG-review` | `REVIEW_WIRING_TYPE`（`:455-456`） | `REVIEW_DELIVERY` |

配線の粒度は engine（`wire_delivery` が `CLAUDE_DELIVERY` / `CODEX_DELIVERY` を立てる）だが、
**join の成否はロール別**なので記録は 4 変数に分かれる。
**現行の design ペインの gate は `CLAUDE_DELIVERY`（`:491`）だが記録は `DESIGN_DELIVERY`（`:690`）である。**
design join が失敗し claude executor join が成功する順序では両者が食い違うので、
gate を `DESIGN_DELIVERY` へ揃える（既存の潜在バグの修正）。

プロンプト全文（`<G>` = `bash <SKILL_DIR>/scripts/ensure-agmsg-ready.sh --type <T> --name <N> and continue even if it exits non-zero.`）:

| ロール | プロンプト |
|---|---|
| design | `Run <G> Then wait idle. Your task will arrive as a prompt typed into this pane; an identical copy may also be recorded in your agmsg inbox history (treat both as ONE task). Do not start any work until the task prompt arrives.` |
| executor（claude / codex 共通） | `Run <G> Then wait idle. Execution instructions will arrive as a prompt typed into this pane; an identical copy may also be recorded in your agmsg inbox history (treat both as ONE task). Do not start any work until the instructions arrive.` |
| review | `Run <G> Then wait idle. Review requests will arrive as a prompt typed into this pane; an identical copy may also be recorded in your agmsg inbox history (treat both as ONE request). Do not start any work until a request arrives.` |

現行文面の `— ignore the duplicate` は `(treat both as ONE task)` に統合した。
`may also be recorded` と条件付きにしたのは、中核方針 2 により sentinel が生まれない経路
（`watcher=existing-other`）が正規に存在するためである。

- **`/agmsg actas` は全ロールで載せない。** 理由は 3 つ。
  (1) `/agmsg actas` は `Monitor` の起動を指示するので、`Monitor` を持たないペインでは本 spec が
  直そうとしている停止そのものを引き起こす（レビュー中に実際に起きた）。
  (2) モデルが Bash ツールで代替起動すると、その呼び出しが watcher の生存中ずっと返らない
  （実機で観測。pid 15066 が pid 15088 の親のまま滞留）。
  (3) 機能的に不要である。ロックは `watch.sh` の暗黙 claim（事実 2）が取り、from 名は
  `send-prompt.sh --agmsg-from` が明示する。codex では加えて `$agmsg` の `$` が禁止文字である。
  既存テストで `/agmsg actas` を assert しているものは 0 件なので、除去で壊れる既存アサーションは無い。

あわせて事実 16 のディレクティブ漏れを直す。`wire_delivery` の実引数は `engine` であり `type` ではない
（関数内で `codex` / `claude-code` をリテラルで書き分けている）。

```bash
# 修正前: >&2 2>/dev/null  ← stdout を stderr に複製してから stderr を捨てている
# 修正後: >/dev/null 2>&1
```

`prewarm-panes.sh` は `set -euo pipefail` で走るので、新しい処理は既存の `wire_delivery` と同じく
`if …; then … else log … fi` で必ず飲み込む。

**`prewarm-panes.sh` はテスト 5 本が `$TMP/scripts/` へ複製して実行する。**
したがって「自スクリプトディレクトリから新しいファイルを source / 実行してはならない
（初期プロンプトへ**文字列として**埋め込むのは可）」を守る。
**guard の実在検査（`[[ -x … ]]`）も入れない** — guard を複製していないスイートで注入が消え、
PW3 が落ちる。

#### (C) 非 prewarm 経路 — `SKILL.md:793-812` の status protocol ブロック

`SKILL.md:792` は「append this block to **every** child prompt's status protocol section」であり、
prewarm の有無で切り替わらない。したがって**この行は `prewarm: false` のときだけ含める**と明記する。
prewarm ペインは (B) で guard を受け取っているので、(C) も適用すると guard が 2 回走り、
しかも `--name <task-slug>` 固定なので claude executor（`<slug>-claude`）や review（`<slug>-review`）で
**別ロールの actas ロックを取りに行く**。

```
（prewarm: false のときだけ）Before you start, run this once and continue even if it exits non-zero:
  bash <SKILL_DIR>/scripts/ensure-agmsg-ready.sh --type <CHILD_AGMSG_TYPE> --name <task-slug>
```

- `<team>` が空のときはこの行も落とす。
- `<CHILD_AGMSG_TYPE>` はタスクごとの `DESIGN_ENGINE` から解決する。親のランタイムや他ロールから
  推測してはならない（`SKILL.md:786-788` が同じ罠を既に警告している）。
- ファイル経由なので事実 14 の禁止文字制約は掛からない。

#### (D) codex review ペインの sandbox

事実 15 のとおり codex reviewer は `--sandbox workspace-write` なので既定では
`~/.agents/skills/agmsg/` へ書けない。`launch-workspace.sh` の `REVIEW_WRITABLE_FLAG` に
2 本目の `--add-dir` を足す。既存の埋め込み形式（シングルクォート、`[[ -n … ]]` ガード）に合わせ、
**agmsg 未インストール時は足さない**。

```bash
REVIEW_WRITABLE_FLAG=""
[[ -n "$STATUS_DIR" ]] && REVIEW_WRITABLE_FLAG+=" --add-dir '$STATUS_DIR'"
AGMSG_SKILL_DIR="$HOME/.agents/skills/agmsg"
[[ -d "$AGMSG_SKILL_DIR" ]] && REVIEW_WRITABLE_FLAG+=" --add-dir '$AGMSG_SKILL_DIR'"
```

現行は `[[ -n "$STATUS_DIR" ]]` の内側に `--add-dir` があるので、そこへ足すと `STATUS_DIR` 無しの
review ペインで agmsg 許可が落ちる。上記のように**独立した 2 本**にする。

これにより 4 ファイル契約の「**3 点セット**」が 4 点になる。ドキュメント表の該当 6 箇所を同期する。

### 3. `scripts/agmsg-path.sh`（新規、source 専用）

sentinel パスのエンコード（事実 17）を 1 箇所に置き、`ensure-agmsg-ready.sh` と `send-prompt.sh` の
両方が source する。規則は `actas-lock.sh:43-73` の `_actas_lock_encode` / `agmsg_ready_path` と同一で、
`[A-Za-z0-9._-]` 以外をバイト単位で `%XX` に変換する（`%` 自身も `%25`）。
**上流の規則が変わっても検出できない**ことを既知のトレードオフに書き、追跡点として
`actas-lock.sh:43-73` をコメントで引用する。

配置は `scripts/` 直下（`lib/` は作らない）。既存の source 専用ヘルパー `terminal-wait.sh` が
`scripts/` 直下にあり、`CLAUDE.md` のファイル構成表もそう記載している。

**`send-prompt.sh` 側の不変条件**（既存 SP スイートを壊さないため）:

- `AGMSG_SEND` は**そのまま維持する**。`AGMSG_DIR` へ寄せてはならない
  （`test-send-prompt.sh:70` は `AGMSG_SEND` と `AGMSG_READY_DIR` を個別に渡し `AGMSG_DIR` を設定しない）。
- `AGMSG_READY_DIR` の導出は `"${AGMSG_READY_DIR:-…}"` の形で**明示指定を常に優先**する。
- `send-prompt.sh` には現在 `SCRIPT_DIR` が無いので追加する。
- 既存フィクスチャの team/agent（`myteam` / `reviewer`）はエンコード対象文字を含まないので、
  **SP0-SP24 は無変更で通る**。
- **lib が読めなくても `send-prompt.sh` は die しない**（die は唯一の wake 手段の喪失を意味する）。
  読めないときは生連結にフォールバックする。

### 4. `prewarm.json` のスキーマ拡張

各ロールに `watcher` を 1 キー追加する（追加のみなので既存の `jq` 参照は壊れない）。

| `watcher` | 意味 |
|---|---|
| `guard-injected` | 配線に成功し、初期プロンプトに guard を載せた |
| `none` | 配線に失敗した、または `<SKILL_DIR>` に空白があるので guard を載せていない |

prewarm は watcher を起動しないので、このキーが表すのは「guard を載せたか」であって
「watcher が動いているか」ではない。`delivery` とは通常 1:1 対応する。
`prewarm.json` は Step 6 の 1 回の `jq -n` で書かれるので、**ロールごとに 4 変数へ退避して
`--arg` で渡す**。**`watch_pid` は導入しない。後始末も不要**（事実 6）。

### 5. 経路別のまとめ（本設計後）

現状の詳細は背景の「現状のロール別 watcher 実態」を参照。

| 起点 | 本設計後（セッション開始時点） |
|---|---|
| watcher が 1 つも無いペイン（＝再現した障害） | guard がバックグラウンド起動。sentinel あり |
| `Monitor` 由来の broad watcher が生きているペイン | `watcher=existing-other` で不介入。sentinel 無し（現状維持） |
| 同名ロールの named watcher が既にあるペイン | `watcher=existing` で不介入 |
| codex 子ペイン / review ペイン | 初期プロンプトの guard が起動（codex review は (D) の `--add-dir` が前提） |
| 非 prewarm 経路の子 | 子プロンプトの guard が起動 |
| ロールが他セッションに held | `watcher=none reason=held-by-other-session` ＋ 復旧手順 |
| 起動しても bare に落ちた | kill して `reason=bare-instance-id` |
| `ps` が使えない | 起動せず `reason=degraded-probe`（fail-closed） |
| 配線に失敗 | `delivery: "cmux-send"` ＋ `watcher: "none"`、親は `monitor-dispatch.sh` へ |
| セッション途中の `/clear` | **対象外**（非目的） |

## 既知のトレードオフ

1. **名前付き watcher は受信行を既読にする**（事実 9）。得られるのは `history.sh` から辿れる記録であって
   `/agmsg inbox` の未読項目ではない。

2. **`Monitor` が働いているロールには sentinel が生まれない。** 中核方針 2 により guard は
   broad watcher を置き換えないので、`send-prompt.sh` は現行どおり typed-only へ縮退する。
   注入（価値 1）を守るための意図的な選択であり、guard の効果は「watcher が無い状況」に限定される。

3. **同名ロールが複数 team にあると、`watch.sh` は全 team を claim する**（事実 11）。
   `parent` は実際に 2 team に登録されている。1 つでも他セッションが保持していれば
   `reason=held-by-other-session` になる。

4. **`watcher: "none"` でも `delivery` は `agmsg` のまま**（配線には成功しているため）。
   `send-prompt.sh` は sentinel を自分で確認するので、配送は自動的に typed-only へ縮退する。

5. **本プラグインが常駐プロセスを fork するようになる。** 台数は N タスクで最大 `3N+1`。
   `AGMSG_WATCH_INTERVAL=30` により同一 SQLite へのポーリングは既定の 1/6 に下がるが、ゼロではない。
   `CLAUDE.md`「関連プラグインとの境界」表の「永続プロセス: なし」を
   **「agmsg inbox watcher（ペインごと 1 プロセス、composite id を持ち、ペイン終了から最大
   `AGMSG_WATCH_INTERVAL` 秒で自己終了。pid 再利用時を除く）」**に書き換える。
   codex ペインでも自己終了は成立する（`instance-id.sh:404-411` の `[ -f "$f" ] || return 0` 経路）。

6. **エンコード規則を複製している**（設計 3）。上流の `_actas_lock_encode` が変わっても検出できない。

## テスト

### 共通の stub 契約とフィクスチャ要件

AR / PW の過半がここに依存するので、ヘルパーの契約として明文化する。

- **stub の配置**: agmsg 側のパスは `AGMSG_READY_DIR` の影響を受けない（`watch.sh:61-62` → `:144` が
  自分の配置から `SKILL_DIR/run` を算出する）。既定 `AGMSG_READY_DIR=$(dirname "$AGMSG_DIR")/run` が
  本物の挙動と一致するのは **stub を `<stub>/scripts/watch.sh` に置いた場合に限る**。平置きは不可。
- **`--name` はプロセス固有にユニーク化する**（例 `ar-$$-<case>`）。`ps` はグローバルなので、
  一般名を使うとユーザーの本物の watcher を掴んで緑になったり、実行環境依存でフレークする。
- **`AGMSG_READY_TIMEOUT=1` を既定で渡す。ただし AR9 群だけ `10` を渡し、`SECONDS` で経過 3 秒未満を
  assert する**（上限 1 秒では「即断」と「1 秒待って諦めた」を区別できない）。
- **出力は必ず 1 行・7 キーが同じ順**をヘルパーで毎ケース検証する。`reason` ごとの実値は上の表を SoT とする。
- **否定ケースの直前に正常系（AR6 と同一 stub 構成）を 1 回通し、stub のログが実際に書かれることを
  確認する。** 否定形アサーションは stub の設置漏れでも「ログが空」で全部 PASS する。
- **起動した stub watcher の pid を配列に記録し、EXIT trap で必ず kill する**
  （`test-runner-terminal-status.sh:20-36` の `cleanup_all` + `trap … EXIT` を流用）。
  リークした stub が次のテストの `ps` プローブに拾われると AR3 系が実行順依存になる。
- **AR3 群は `--project` を git リポジトリにする**（条件 3 が `git -C` を呼ぶ）。
  非 git のケースは「候補に加えないだけで死なない」ことを検証する。
- **`ps` の stub は「成功するが空出力」**（`exit 127` ではない）。guard が `ps` を裸で呼ぶことが前提。
- **pidfile は `$AGMSG_READY_DIR/watch.<id>.pid`**。`<id>` はテストが `AGMSG_STUB_INSTANCE_ID` で
  与え、bare / composite の両方を作れるようにする。
- **`timeout` / `gtimeout` は使わない**（`CLAUDE.md` 項目 23 で禁止。開発機には homebrew 版が実在するので、
  うっかり使うと「ここでは通るがクリーン環境で落ちる」テストになる）。ハング検出は
  **コマンド置換をバックグラウンドのサブシェル内で行い、`kill -0` を上限つきでポーリングする**形にする。
  `test-monitor-layout.sh:23-32` の `run_bounded` は出力を**ファイル**へ落とすので fd 漏れを検出できない
  （実測: 漏れ実装でも 1 秒で返る）。前例をそのまま流用しないこと。

### 新規 `apps/cmux-team-dispatch-task/test/test-agmsg-ready.sh`

| id | 検証内容 |
|---|---|
| AR1 | `send.sh` 不在 → `reason=not-installed` / exit 1 |
| AR2 | `mktemp` 不可 → `reason=log-unwritable` / **exit 0** |
| AR3 | 5 条件を満たす生存 `watch.sh` があるとき `watcher=existing` / exit 0、`watch.sh` を新規に呼ばない |
| AR3b | argv に `watch.sh` を含むが argv[0]/argv[1] が違うプロセス（zsh ラッパー）を誤判定しない |
| AR3c | `<slug>-claude` の watcher が生きているとき `--name <slug>` はパス A に一致せず、**パス B で `existing-other`** になる |
| AR3d | 別 project の同名 watcher を誤判定しない（条件 3） |
| AR3e | broad（4 引数・name 無し）watcher は `watcher=existing-other` になり、watcher を起動しない |
| AR3f | **ワークツリーで起動した guard が、メインリポジトリのパスで起動された watcher を検出する**（条件 3 の肯定側） |
| AR3g | 非 git な `--project` でも死なず、`--project` 綴りのみで照合する |
| AR4 | degraded（`ps` が空出力）→ `reason=degraded-probe` / exit 0、watcher を起動しない |
| AR5 | 生きた owner の sentinel を `rm -f` しない / 死んだ owner のものは削除する。composite と bare の両分岐（codex の `cc-instance` 無しケースを含む） |
| AR6 | 正常系: `watch.sh` を `<sid> <project> <type> <name>` の 4 引数で起動し、sentinel 出現後に `watcher=started pid=<n>` / exit 0。**pidfile 名が composite である** |
| AR6b | sentinel を書いた直後に exit する stub → 再確認で検知し `watcher=none` になる |
| AR7 | 印字した `pid=` が `watch.sh` 本体の pid である（中間シェルの pid でない） |
| AR8 | 起動した watcher が生きている間もコマンド置換 `$( )` が戻る。**バックグラウンドのサブシェル + `kill -0` ポーリング**で検証する |
| AR9a-d | 事実 10 の 4 経路が正しい `reason` に分類され、`AGMSG_READY_TIMEOUT=10` でも 3 秒未満で打ち切られる。分類は行頭アンカーで、inbox 本文に同じ文字列があっても誤分類しない |
| AR10 | pidfile 名が bare → SIGTERM で kill して `reason=bare-instance-id` / exit 0 |
| AR10b | 同ケースで sentinel が残らない |
| AR11 | sentinel も作らず終了もしない stub → `AGMSG_READY_TIMEOUT` で打ち切り、**SIGTERM で kill され**、`reason=start-timeout` / exit 0 |
| AR11b | timeout kill 後、**他人の sentinel は消さない** |
| AR12 | degraded では kill しない（fail-closed） |
| AR13 | `delivery.sh` が AGMSG-DIRECTIVE を印字しても標準出力へ漏れず、`$LOG` に残る |
| AR14 | session id: `claude-code` は `$CLAUDE_CODE_SESSION_ID` のみ、`codex` は `$CODEX_THREAD_ID` のみ。両方空なら guard が `agmsg-<uuid>` を生成し、`-` を渡さない。（`watch.sh` 側の採番挙動は stub では検証できない） |
| AR15a-e | exit 2 の 5 条件で rc==2 かつ `delivery.sh` / `watch.sh` が 1 度も呼ばれない。`--project` 条件は手動実行専用の防御である旨を注記 |
| AR16 | エンコードのゴールデンベクタ 4 本（下記）。`agmsg_ready_path` を source しない |
| AR17 | `reason` ごとに stderr の手掛かりが表のとおり 1 行出る（`-` のときは出ない） |
| AR18 | `$LOG` が 0600 で作られる。**同じ `--name` で 2 回連続実行しても 2 回目が失敗しない** |
| AR19 | `AGMSG_WATCH_INTERVAL` が watcher の環境へ export される |
| AR20 | 2 回目の guard 実行がパス A で `existing` になり、watcher を二重起動しない |

AR16 のゴールデンベクタ:

```
("dispatch-my repo",  "parent")   -> ready.dispatch-my%20repo__parent
("dispatch-a%b",      "parent")   -> ready.dispatch-a%25b__parent
("dispatch-日本",      "parent")   -> ready.dispatch-%E6%97%A5%E6%9C%AC__parent
("dispatch-ok_1.2-3", "x-review") -> ready.dispatch-ok_1.2-3__x-review   （無変換）
```

### 既存スイートへの回帰追加

`prewarm-panes.sh` を呼ぶケースは必ず先にワークツリーディレクトリを `mkdir -p` する。
slug は `pw1`…`pw8`（既存の `pg*` / `ov*` / `is*` と同じ「slug prefix = ブランチ prefix」規約）。

| id | 検証内容 |
|---|---|
| PW1 | 配線成功ロールの `prewarm.json` が `watcher: "guard-injected"`。かつ `[.. \| objects \| select(has("delivery")) \| has("watcher")] \| all`（書き忘れ検出）と `(.delivery == "agmsg") == (.watcher == "guard-injected")` の双条件 |
| PW2 | `delivery.sh` を失敗させる stub で **claude-code 型の全ロールが同時に** `watcher: "none"` になり、いずれの初期プロンプトにも guard が含まれない（既存 stub は `exit 0` 固定なので failure-injection stub を新規に作る） |
| PW3 | 6 ペイン（claude/codex × design/executor ＋ review 2 種）すべての初期プロンプトが `ensure-agmsg-ready.sh` を含み、`--type` が上の供給元表どおり |
| PW4 | どのペインの初期プロンプトにも `/agmsg actas` が現れない |
| PW5 | 初期プロンプトに禁止 6 文字が無く、**改行も無い**（`[[ $(printf '%s' "$p" \| wc -l) -eq 0 ]]`） |
| PW5b | **空白を含む一時ディレクトリから prewarm を起動すると guard が注入されず `watcher: "none"` になる**（開発機のパスに依存しない検査） |
| PW6 | `prewarm-panes.sh` の **stderr** に `AGMSG-DIRECTIVE` が現れない（stdout ではない。修正前でも stdout は空なので stdout を見ると回帰を守らない） |
| PW7 | `ensure-agmsg-ready.sh` が exit 1 でも prewarm が die せず `prewarm.json` を書く |
| PW8 | `--agmsg-team` 無しのとき初期プロンプトに guard を載せない |
| PW9 | design ペインの gate が `DESIGN_DELIVERY` である（design join だけ失敗させると design のプロンプトから guard が消える） |
| AG1 | `SKILL.md` の Step 1g ブロックを抽出して **`set -euo pipefail` 下で**実行し、rc 0/1/2 の 3 分岐と join 失敗時の継続を検証。抽出は **`TEAM="dispatch-` を awk のアンカー**にする（Step 1g 配下に bash フェンスが 6 個あり「Step 1g の fenced block」では特定できない。この文字列は SKILL.md 全体で 1 箇所）。**先に** `test-cleanup-close.sh:95` と同じ sed で `~/.agents` と `<SKILL_DIR>` を stub パスへ置換し、**そのうえで** `~/.agents` が 1 文字も残っていないことを assert してから `bash` に渡す（fail-closed）。stub は `git` / `join.sh` / `resolve-agmsg-type.sh` / `ensure-agmsg-ready.sh` の 4 つで、`git rev-parse --show-toplevel` の返り値も固定する |
| AG2 | 同ブロックが `--name parent` を渡し、`--session-id` を渡さない |
| AG3 | 非 prewarm 経路の子プロンプトブロックが guard 行を含み、**`prewarm: true` のときと `<team>` が空のときは落ちる** |
| AG4 | 同ブロックの `--type` がタスクごとの engine から解決されている |
| SP25 | `send-prompt.sh` がエンコード済み sentinel パスを参照する（AR16 と同じゴールデンベクタ）。**既存の SP1 とは別 id** |
| SP26 | `agmsg-path.sh` が読めなくても `send-prompt.sh` が die せず、生連結にフォールバックする |
| CR1 | codex review の起動コマンドに `--add-dir '<agmsg skill dir>'` が入る。**置き場所は `test/test-launch-workspace-codex.sh` の T5 群の隣**（`test-codex-review-sandbox.sh` は codex CLI を実起動する動的テストで、CI では SKIP されうるうえ `launch-workspace.sh` を読まない） |
| CR1b | `STATUS_DIR` が空でも agmsg 側の `--add-dir` は付く |

既存ヘルパー `assert_no_line_with`（`test-prewarm-unattended.sh:60-65`）には「grep 対象のファイルが
実在すること」のガードが無く、prewarm が早期に死んで argv.log が空でも PASS する。
ヘルパー側にガードを足す（U2 / U3 / U8 の 3 箇所は追加後も PASS することを確認済み）。

## ドキュメント

`apps/cmux-team-dispatch-task/CLAUDE.md` の 4 ファイル整合ルールに従い、同一コミットで更新する。
**追加だけでなく、変更後に偽になる既存記述の書き換えが必須。** 全 24 箇所。

| ファイル | 行 | 内容 |
|---|---|---|
| `skills/…/SKILL.md` | 514-528 | Step 1g の `AGMSG_INSTALLED` 定義（「agmsg を使うか」へ拡張）と guard の rc 分岐 |
| 同上 | 526 / 2201-2203 | `monitor-dispatch.sh` の起動条件に「配線失敗時も起動する」 |
| 同上 | 748-812 | 配線ブロックを guard 呼び出しへ置換。AGMSG-DIRECTIVE 遵守文を削除。`/clear` の既知の制限を追記 |
| 同上 | 793-812 | 子プロンプトの guard 行（`prewarm: false` 限定） |
| 同上 | 2737 | Reference 節 Delivery 要約の「MUST be followed」 |
| 同上 | 386 | engine × mode 起動コマンド表の codex review 行（`--add-dir` 2 本） |
| `skills/…/references/guide-ja.md` | 204 | Step 1g の訳 |
| 同上 | 513 | 「3点セットで指定する」→ 4 点 |
| 同上 | 767 | 「design / claude executor の初期プロンプトは `/agmsg actas` を含まない文面に切り替わる」 |
| 同上 | 1290 | 補足の Delivery 要約 |
| `README.md` | 239 付近 | 「`AGMSG-DIRECTIVE:` に従って watcher を起動する」 |
| 同上 | 373 | 「3点セット」の日本語 |
| `CLAUDE.md` | ファイル構成表 | `ensure-agmsg-ready.sh` と `agmsg-path.sh` の行を追加 |
| 同上 | 154（項目 12） | 「Step 1g に AGMSG-DIRECTIVE 遵守が記載されていること」→ guard の検証項目 |
| 同上 | 166（項目 15） | 「配線失敗時に **design / claude executor** の初期プロンプトを出し分ける」→ 全ロール＋`/agmsg actas` を載せない方針 |
| 同上 | 194（項目 20） | 「3点セット」→ 4 点 |
| 同上 | 215（項目 25） | 「レビューペインの … 3 点は不変」→ 4 点 |
| 同上 | 298（E2E 項目 17） | 「AGMSG-DIRECTIVE により watcher が起動していること」→ guard 経由 |
| 同上 | 308（E2E 項目 27） | 2 ロール限定の記述 |
| 同上 | 320（E2E 項目 39） | 「3点セット」→ 4 点 |
| 同上 | 「関連プラグインとの境界」表 | 「永続プロセス: なし」→ トレードオフ 5 の文言 |
| 同上 | メンテナンス手順 | `test-agmsg-ready.sh`（AR1-20）と PW1-9 / AG1-4 / SP25-26 / CR1-1b の id 群を登録 |
| `scripts/prewarm-panes.sh` | 584, 617 | 「codex は … 初期 prompt は常に無し」というコメント |
| `scripts/launch-workspace.sh` | 791 | 「agmsg モードでは `/agmsg actas <name>` + 待機指示を初期 prompt にする」というコメント |

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
```

全スイートが通り `check-doc-lang` が OK であること。`@tanaka-yui/token-meter` の
`noNonNullAssertion` 警告 4 件は既知のノイズ。

```bash
git worktree list
git branch --list 'feat/pg*' 'feat/is*' 'feat/ov*' 'feat/pw*'
```

## 改訂履歴

### 改訂 3 → 4（レビュー ラウンド 3 を反映）

| 改訂 3 | 改訂 4 | 理由 |
|---|---|---|
| 既存 watcher を置き換えて named 化する | **中核方針 2: 決して置き換えない。** パス B で `existing-other` を返す | `/agmsg actas` を外した結果、`Monitor` を持つ全ペインが起動側へ到達し、注入する watcher を注入しない watcher に置き換えていた。C3 の指摘は正しい |
| 手順 7「復元」 | **削除** | 置換が起きなくなり不要。`ps` の argv 再実行は zsh ラッパーを掴むと任意コード実行になる |
| `AGMSG_WATCH_INTERVAL=30` の根拠が「Monitor があれば起動しない」 | 「中核方針 2 により、起動するのは watcher が 1 つも無いときだけ」 | 旧根拠は事実 12 と矛盾していた。方針 2 を入れたことで結論だけが正しく残る |
| `$LOG` は固定名 + `set -C` + unlink しない | `mktemp` | 固定名 2 回目が必ず `log-unwritable` になり、`--name parent` は全ディスパッチ共通なので 2 回目以降の親 guard が毎回失敗した |
| composite 判定は pidfile 名から「末尾が `.<数字>`」 | sentinel の中身を第一とし、剥がしと 3 条件を逐語で明記。手順 4・6・7 の 3 箇所で共用 | 素直な実装（`${id##*.}`）は全件 bare 判定になり、起動した watcher を毎回 kill する |
| `existing` 経路に composite 検証なし | パス A でも判定し `reason=bare-instance-id` を添える（kill はしない） | bare の既存 watcher を「セットアップ済み」と報告していた |
| degraded は sentinel の owner 生存で判定して起動しうる | **degraded では起動しない**（fail-closed） | パス B を判定できないので置換事故を避けられない |
| owner 生存判定が bare 分岐の規則のみ | composite / bare の 2 分岐を明記 | codex は `cc-instance` を書かないので、生きた owner を必ず「死」と誤判定していた |
| session id が空なら `-` を渡す | guard が `agmsg-<uuid>` を 1 回生成 | 事実 19: codex では常に空。`-` だと起動ごとに別 uuid になり、2 回目が 1 回目に held される |
| `not-registered` は exit 1 | **exit 0**（`wired=yes`） | 親ロール 1 つの登録不整合でディスパッチ全体が agmsg を捨てていた |
| kill は値域検証のみ | cmdline 照合 ＋ SIGTERM 固定 ＋ degraded では kill しない ＋ 終了待ち | pid 再利用時に無関係なプロセスへ SIGTERM。`kill -9` は sentinel を残す |
| `--name` の検証なし | exit 2 の 5 つ目に追加 | `$LOG` のパスへ生連結されるので `../../` で外へ抜ける |
| 出力の実値が手順ごとに部分集合 | `reason` × 7 キー × exit code × stderr の 1 表 | 実装者が値を決められなかった |
| (C) は非 prewarm 経路と書くのみ | `prewarm: false` 限定を明記 | 対象ブロックは「every child prompt」なので prewarm ペインで guard が 2 回走り、誤った名前で別ロールのロックを取りに行っていた |
| プロンプト表が「同上」 | 3 種の全文 ＋ `<T>` 供給元と gate 変数の 4 行表 | 差分は末尾だけではなく、review 用の文面が存在しなかった |
| design の gate は現行のまま | `DESIGN_DELIVERY` へ揃える | 現行は gate が `CLAUDE_DELIVERY`、記録が `DESIGN_DELIVERY` で食い違う（既存の潜在バグ） |
| `<SKILL_DIR>` の空白は未対処 | 空白なら注入せず `watcher: "none"` | クォートできないので exit 127 になり、全ロールが無言で watcher 無しになる |
| `lib/agmsg-path.sh` | `scripts/agmsg-path.sh` | `scripts/` に `lib/` は存在せず、`terminal-wait.sh` が直下にある |
| `send-prompt.sh` の env 契約に言及なし | `AGMSG_SEND` 維持 / 明示指定優先 / die しない を不変条件に | 統一と読むと SP1/SP12/SP13/SP18 が全滅する |
| `check-doc-lang` を `apps/…` から実行 | リポジトリルートから | cwd が `apps/…` だと対象 0 件で無条件に OK（実測） |
| ドキュメント 15 行 | **24 行**（(D) が偽にする「3 点セット」6 箇所ほか） | `--add-dir` を足すと 4 ファイル契約の記述が偽になる |
| AR16 は `agmsg_ready_path` と一致 | ゴールデンベクタ 4 本 | `agmsg_ready_path` の source はテスト前提と設計 3 の棄却理由の両方に反する |
| AR8 は既存 idiom を流用 | バックグラウンドのサブシェル + `kill -0` | `run_bounded` は出力をファイルへ落とすので fd 漏れを検出できない（実測） |
| PW6 は stdout を見る | **stderr** | 事実 16 のとおり漏れるのは stderr 側。stdout を見ると修正前でも PASS する |
| CR1 は `test-codex-review-sandbox.sh` | `test-launch-workspace-codex.sh` の T5 群の隣 | 前者は codex CLI を実起動する動的テストで `launch-workspace.sh` を読まない |
| stub 契約なし | 共通の stub 契約とフィクスチャ要件を独立節に | AR の過半が依存していた |
| 行番号 3 件が 1 行ずれ | `delivery.sh:329` / `session-start.sh:253-257` / `spawn.sh:721` | 実測で確認 |

### 改訂 2 → 3（レビュー ラウンド 2 を反映）

起動形からサブシェルと `setsid` を排除し（bare id を決定的に生むため）、`actas-claim.sh` による
事前 claim を廃止した（解放 CLI が無く、watcher を得られない経路でロールが黒穴になるため）。
プローブをフルパス＋type＋project＋name の多条件 AND にし、`--project` を省略可にし、
`/agmsg actas` を全ロールから外した。

### 改訂 1 → 2（レビュー ラウンド 1 を反映）

prewarm による代理起動と `--detached`（`AGMSG_AGENT_PID=`）を廃止し、
「watcher はペイン自身が起動する」中核方針へ変更した。bare id の sentinel が
`session-start.sh` の GC で消されること（事実 7）と、他人の session id では即死すること（事実 6）が理由。
