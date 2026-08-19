# agmsg セットアップガードの設計

対象: `apps/cmux-team-dispatch-task`

> 改訂 3。spec レビュー ラウンド 1・2 の指摘を反映した。
> 差分は末尾「改訂履歴」を参照。

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
   ディレクティブを抑止する条件は `run/watch.<session_id>.pid` の存在と生存だけで、
   **project を見ない**。

5. **`watch.sh` は session_id を自前で正規化する**（`watch.sh:141`、`agmsg_normalize_instance_id`）。
   agent 種別ごとの ppid walk で祖先を探し、見つかれば `<sid>.<pid>` の composite にする。
   pidfile 名は正規化後の id で決まるため、**同一 session_id で 2 つ目の watcher を起動すると
   `watch.sh:165` が前の watcher を kill する**（意図的な重複排除、#66）。
   **argv からは bare / composite を判別できない**（正規化は `watch.sh` 内部で起きる）。
   判別できるのは sentinel の中身と pidfile 名だけである。

6. **composite でなければ liveness guard が効かない。** `watch.sh:407` は
   `agmsg_instance_is_composite` でゲートされている。bare id の watcher は永久に自己終了しない。
   逆に composite なら `agmsg_instance_alive` が
   `_agmsg_pid_alive "$pid" || return 1` を**先に**通すので、`cc-instance.<pid>` の有無に関わらず
   その pid が死んだ時点で DEAD になり、watcher は自己終了する。

7. **bare id の ready sentinel は GC で消される。** `agmsg_instance_alive` の bare 分岐は
   `cc-instance.*` のどれとも一致しないので常に DEAD であり、`session-start.sh:224-228` が
   sentinel を無条件に削除する。

   ```
   session-start.sh:224  for f in "$RUN_DIR"/ready.*; do
   session-start.sh:226    rd_sid=$(cat "$f" 2>/dev/null || true)
   session-start.sh:227    { [ -n "$rd_sid" ] && actas_lock_sid_alive "$rd_sid"; } || rm -f "$f"
   ```

   このループは project でも team でも絞られず、agmsg 配線済みの claude セッションがどこかで
   起動 / `/clear` / resume するたびに走る。sentinel は起動時に 1 回しか書かれない
   （`watch.sh:385-395`）ので、消えたら復活しない。`send-prompt.sh` は sentinel の存在だけで
   inbox 記録を分岐するので、**プロセスは生きているのに送信側からは死んで見える**。

   → **watcher は composite でなければならない。すなわち、そのロールのペイン自身が、
   自分のセッション id で起動するしかない。**

8. **`( cmd & echo $! )` の形は決定的に bare を生む**（実測 3/3、レビュアー側でも 5/5）。
   サブシェルが `echo $!` の直後に終了するため、バックグラウンドプロセスは即座に pid 1 へ
   再親付けされ、`agmsg_agent_pid` の `$$` からの ppid ウォーク（`resolve-project.sh:305-307`）が
   失敗して bare フォールバックに落ちる。

   ```
   ( nohup bash probe & echo $! )   → ppid_at_start=1        （3/3）
   nohup bash probe & P=$!          → ppid_at_start=<自シェル> （3/3、その親は claude）
   ```

   **`setsid` は使えない。** この macOS に存在せず（実測）、util-linux 版はセッションを切るので
   ppid ウォークを確実に破壊する。`nohup` + バックグラウンド起動のみを使う。

9. **名前付き watcher は配信した行を既読にする**（`watch.sh:478` の `mark_read`）。
   スキップ条件は `[ -z "$ACTIVE_NAME" ]`、つまり broad watcher 専用である（`watch.sh:343`）。
   `inbox.sh` は `read_at IS NULL` しか表示しないので、名前付き watcher が動いているロールでは
   受信メッセージは `/agmsg inbox` に現れず、`history.sh` でのみ辿れる。

10. **`watch.sh` が sentinel を作らずに終了する経路は 4 つある。** 実測した出力先と終了コード:

    | 経路 | 出力先 | 文言 | exit |
    |---|---|---|---|
    | `:267-271` held | stderr | `agmsg watch: cannot claim (held by other sessions): …` | 1 |
    | `:274-281` 未登録 | stdout | `agmsg watch: no registration for agent '…'` | 0 |
    | `:374-377` DB | stdout | `ERROR: cannot open message DB …` | 1 |
    | `:405-408` liveness guard | **出力なし** | — | 0 |

    stdout と stderr を同一ファイルへ落とせば、文言で分類できる（liveness guard だけは空ログ）。

11. **`watch.sh` の name フィルタは team を見ない**（`watch.sh:213`）。`ACTIVE_NAME` があるとき、
    同名 role が複数 team にあれば全部を claim しに行き、1 つでも他セッションが保持していれば
    `watch.sh:271` で exit 1 する。実測で `parent` は `dispatch-yui-cc-plugins` と
    `yui-cc-plugins` の 2 team に登録されていた。
    しかも `watch.sh:165-179` の pidfile 奪取は claim より**前**に走るので、claim 失敗時は
    「既存の watcher を殺した上で自分も起動しない」結果になりうる。

12. **`Monitor` が起動する broad watcher は 4 引数で name を持たない。**
    `delivery.sh:326` の `printf '%q %q %q %q'` が生成するのは `<watch.sh> <sid> <project> <type>` である。
    実機の稼働プロセスでも確認した。**name で照合するプローブでは broad watcher を検出できない。**

13. **codex 型には watcher を起動する既定経路が無い。** `type.conf` が `monitor=no` で、
    `_delivery.sh` の `on_enable` はシェル関数の導入手順を印字する。これも実行中セッションが
    追従できない指示である。

14. **`launch-workspace.sh` は `--mode standby` / `--mode review` で初期プロンプトを受け付ける**
    （`:723-726` / `:758-771` / `:789-796`）。第 2 位置引数であり `--prompt` フラグではない。
    `prewarm-panes.sh` が review ペインと codex ペインに渡していないだけである。
    ただしプロンプトは `zsh -ic "… '<prompt>' …"` に二重埋め込みされエスケープされないので、
    **`'` `"` `` ` `` `$` `!` `\` と改行を含まない 1 行**でなければならない。
    改行が入ると `wc -l < argv.log` でペイン数を数えている既存 8 件のアサーションが同時に壊れる
    （`test-prewarm-unattended.sh` U3/U4/U5/U6、`test-prewarm-all-codex.sh` AC1、
    `test-prewarm-layout.sh` PG1/PG2/PG3）。

15. **codex review ペインだけ sandbox が違う。** `--sandbox workspace-write -c approval_policy='never'`
    で起動される（`launch-workspace.sh:766-771`）。`watch.sh` は `~/.agents/skills/agmsg/run/` へ
    pidfile と sentinel を書き、DB も同ディレクトリ配下を読み書きするので、
    **既定では拒否され、`approval_policy=never` なので昇格も求められない**。
    この端末で動いているのは `~/.codex/config.toml` の `writable_roots` に列挙されているからで、
    リポジトリ管理外のローカル設定である。`test/test-codex-review-sandbox.sh` の S1 が
    「`--add-dir` 無しでは workspace 外への `touch` が拒否される」ことを検証している。

16. **`prewarm-panes.sh` の既存の配線呼び出しはディレクティブを漏らしている。**

    ```
    prewarm-panes.sh:411,417   bash "$AGMSG_DIR/delivery.sh" set monitor <type> "$CWD" >&2 2>/dev/null
    ```

    リダイレクトは左から評価されるので **stdout を元の stderr に複製してから stderr を捨てる**。
    AGMSG-DIRECTIVE は `delivery.sh:332` の stdout なので、そのまま呼び出し元へ出ている。

17. **`send-prompt.sh` の sentinel パスはエンコードしていない。** `watch.sh` が実際に作るのは
    `agmsg_ready_path`（`actas-lock.sh:69`）＝ `[A-Za-z0-9._-]` 以外を `%XX` に変換したパスだが、
    `send-prompt.sh:146` は `ready.${TEAM}__${TO_AGENT}` の生連結である。

    ```
    agmsg_ready_path "dispatch-my repo" parent → …/run/ready.dispatch-my%20repo__parent
    send-prompt.sh:146 の生連結               → …/run/ready.dispatch-my repo__parent
    ```

    `TEAM="dispatch-$(basename "$(git rev-parse --show-toplevel)")"` なので、リポジトリ名に空白や
    非 ASCII が入ると発火する。`$SLUG` は `prewarm-panes.sh:190` で `^[A-Za-z0-9._-]+$` に検証済みなので、
    **エンコードが効くのは team 名側だけ**である。

18. **`/clear` は watcher を失わせる。** `session-start.sh:249` は SessionStart のたびに
    `cc-instance.<pid>` を新しい INSTANCE_ID で上書きする。`/clear` は新しい session_id を採番するので、
    稼働中 watcher の token `<旧sid>.<pid>` は DEAD になり、`watch.sh:407` が exit して
    `cleanup()` が sentinel を消す。`/compact` は同一 session_id を保つので影響しない
    （`session-start.sh:252`）。

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

- **watcher の欠如を致命的にしない。** watcher を起動できないときにディスパッチを止める修正は、
  バグそのものより悪い。
- **ready sentinel を watcher 無しで書く案は採らない。** sentinel の契約は `actas-lock.sh:63-68` で
  「present iff a live watcher is currently receiving for that role」と定義され、
  `spawn.sh:713` の `--wait-ready` がこの不変条件に依存している。他ツールの名前空間に偽の不変条件を
  書き込むことになるので採用しない。
- **セッション途中の `/clear` / resume 後の再セットアップは対象外**（事実 18）。guard は初期
  プロンプトから 1 回だけ走る。`Monitor` があるハーネスでは SessionStart が AGMSG-DIRECTIVE を
  再送するので復帰するが、無いハーネスではそのペインの watcher は戻らない。
  `SKILL.md` に既知の制限として書く。
- codex の bridge（`codex-bridge.js` / シェル shim）の導入・自動化。
- agmsg 本体（`~/.agents/skills/agmsg/`）への変更。本リポジトリの管理外。
- delivery mode の変更（`monitor` 固定）。
- `SKILL.md` 全体のプレースホルダ統一（`<SKILL_DIR>` 21 箇所 / `<this-skill-dir>` 9 箇所の混在）。
  本 spec が編集する箇所は周囲の表記に合わせる。
- バージョン番号の更新、push、PR 作成。

## 検討したが採らなかった代替

**`actas-claim.sh` による事前 claim。** 改訂 2 では手順 3 で `actas-claim.sh` を呼び、
プロジェクト解決・完全一致照合・`not_registered` 検出・事実 11 の最悪ケース回避をまとめて得ていた。
しかしこれは照会ではなく**本番の claim** であり、`actas_lock_claim` で実際にロックを取る
（解放は held ロールバック時のみ）。watcher を得られずに終わった経路（未登録・DB 不可・timeout）で
ロックが残り、composite なのでペインが生きている限り有効なままになる。その状態のロールは
他セッションの broad 購読からも除外される（`watch.sh:235-246`）ため、**watcher も無く他人からも
受信できない**黒穴になる。agmsg には解放専用の CLI が無く（`reset.sh` は登録ごと削除する）、
`actas-lock.sh` を source するのは本リポジトリの「agmsg の内部に触れない」規約に反する。

代わりに、**`watch.sh` 自身の暗黙 claim（事実 2）に任せ、必要な情報はすべて watcher の
起動結果から得る**（事実 10 の 4 経路の分類）。これで claim の解放義務が消え、
`identities.sh` のパス解決問題（`identities.sh` は `agmsg_resolve_project` を呼ばない）にも
触れずに済む。

## 設計

### 中核方針

> **watcher は、そのロールのペイン自身が、自分のセッション id で起動する。
> 他ペインの代理で watcher を起動する経路は作らない。
> 起動は `nohup … &` の 1 行で行い、サブシェルにも `setsid` にも包まない。**

事実 7・8 から、これ以外に GC を生き延びる watcher は存在しない。

### 1. 新スクリプト `scripts/ensure-agmsg-ready.sh`

```
ensure-agmsg-ready.sh --type <claude-code|codex> --name <agent> [--project <path>]
```

| フラグ | 既定 | 意味 |
|---|---|---|
| `--type` | 必須 | `claude-code` または `codex`。`resolve-agmsg-type.sh` の出力 |
| `--name` | 必須 | このセッションが名乗る agmsg agent 名 |
| `--project` | `$PWD` | プロジェクトパス。解決は `watch.sh` が内部で行う |

`--project` を省略可にしたのは、(B)(C) の初期プロンプトが事実 14 の制約でパスをクォートできず、
空白入りパスを渡すと未知引数として exit 2 になるためである。ペインの cwd は必ずワークツリーなので、
省略が常に正しい値になる。

環境変数:

| 変数 | 既定 | 用途 |
|---|---|---|
| `AGMSG_DIR` | `$HOME/.agents/skills/agmsg/scripts` | agmsg スクリプトの場所 |
| `AGMSG_READY_DIR` | `$(dirname "$AGMSG_DIR")/run` | ready sentinel の場所。`AGMSG_DIR` から導出するので、テストで片方だけ差し替えて本物の `run/` を読む事故が起きない |
| `AGMSG_LOG_DIR` | `${TMPDIR:-/tmp}` | watcher のログの置き場 |
| `AGMSG_READY_TIMEOUT` | `15` | sentinel の出現を待つ上限秒数 |

`--mode` / `--no-start` / `--team` / `--session-id` / `--detached` / `--timeout` / `--log-dir` は
設けない。呼び出し箇所が無い、または誤用しかできない。可変にする必要があるものは環境変数へ寄せ、
`AGMSG_DIR` / `AGMSG_READY_DIR` と同じ stub 化手段に統一する。

session id はフラグでは受け取らず環境から取る。`--type claude-code` なら
`$CLAUDE_CODE_SESSION_ID`、`--type codex` なら `$CODEX_THREAD_ID`。**type と変数の対応は固定で、
他方の変数は参照しない。** どちらも空なら `-`（`watch.sh` の「session id 無し」sentinel）を渡す
（`watch.sh:46,122` が `agmsg-<uuid>` を自前で採番する）。

#### 処理

1. **インストール確認。** `$AGMSG_DIR/send.sh` が無ければ
   `installed=no … reason=not-installed` を出力し **exit 1**。
2. **配線。** `delivery.sh set monitor <type> <project>` を実行する（冪等、事実 3）。
   標準出力・標準エラーの両方を `$LOG` へ追記する。**`/dev/null` ではない** — 事実 4 の
   AGMSG-DIRECTIVE と codex のシェル shim 手順を呼び出し元へ漏らさないが、事後解析はできる。
   非ゼロ終了なら `wired=no … reason=delivery-set-failed` を出力し **exit 1**。
3. **既存 watcher のプローブ。** `$AGMSG_READY_DIR/watch.*.pid` を走査し、各 pidfile の pid について
   `ps -ww -eo pid=,args=` の argv を次の **4 条件すべて**で判定する
   （`instance-id.sh:351-370` の `agmsg_args_is_grok_watcher` と同じ流儀）。

   1. argv[0] または argv[1] が `$AGMSG_DIR/watch.sh` と**フルパスで一致**する
      （agmsg 本体も `watch.sh:171` / `session-start.sh:173` / `delivery.sh:622` の 3 箇所すべてで
      フルパス照合している）
   2. `<type>` が位置引数として**厳密等価**で存在する
   3. `<name>` が位置引数として**厳密等価**で存在する（`grep` / `case` パターンでの実装を禁じる。
      `<slug>` が `<slug>-claude` にヒットする）
   4. project の位置引数が `--project` の値、または `--project` 内で
      `git rev-parse --show-toplevel` した値と**厳密等価**である
      （agmsg が実際に使うのはこの 2 つの綴りだけ。ワークツリー / メインリポジトリの両方に対応する）
   5. その pid が生存している

   - 4 条件すべてを満たす生存プロセスが見つかった → `watcher=existing pid=<n>` を出力し **exit 0**。
     既存 watcher には触らない。
   - **broad（name 無し）watcher は構造的に検出できない**（事実 12）。これは意図であり、
     手順 4 で named watcher を起動すると `watch.sh:165-179` の pidfile 共有により置換される。
     トレードオフ 2 に接続する。
   - `ps` の argv は空白で分割されるため、**プロジェクトパスに空白があると検出できない**。
     その場合は「起動する」側に倒れる（fail-closed）。`agmsg_args_is_grok_watcher` と同じ方針。
   - `ps` が使えない（`command -v` ではなく**実際に 1 回叩いて出力が空でないこと**で判定する。
     サンドボックスはバイナリを残したまま出力を空にすることがある）→ **degraded**。
     sentinel の中身（owner instance id、`watch.sh:392`）を読み、その id が
     `$AGMSG_READY_DIR/cc-instance.*` のいずれかの内容と一致し、かつその pid が生きていれば
     `watcher=existing`、そうでなければ stale として次へ進む。**sentinel の有無だけで判定しない。**
   - 見つからず sentinel だけがある場合も、上と同じ owner 生存確認を行う。
     **死んでいると確認できたときだけ** `rm -f` する。生きた別プロセスの sentinel を消すと、
     sentinel は再作成されないのでそのロールが永久に不可視になる。
4. **起動。**

   ```bash
   PRE_WATCHERS=$(...)   # 手順 3 で見た、この (project, type) の生存 watcher の argv 一覧
   umask 077
   set -C                                   # noclobber: 先置きされた symlink を掴まない
   : > "$LOG" || { ...reason=log-unwritable...; }
   set +C
   nohup bash "$AGMSG_DIR/watch.sh" "$SID" "$PROJECT" "$TYPE" "$NAME" </dev/null >>"$LOG" 2>&1 &
   WATCH_PID=$!
   ```

   - **サブシェルで包まない**（事実 8）。`( … & echo $! )` は決定的に bare id を生む。
   - **`setsid` を使わない**（事実 8）。
   - **`bash -c` を挟まない。** `$!` が中間シェルの pid になり、kill しても watcher が孤児として残る。
   - **fd 3 本すべてを付け替える。** どれかを呼び出し元のパイプに残すと、コマンド置換やツール実行が
     パイプの EOF を待って戻らなくなる（(B)(C) の経路でペインのツール呼び出しがハングする）。
     逆に stderr だけ残すと、呼び出し元終了後の書き込みで watcher が SIGPIPE で無言死する
     （`watch.sh` に PIPE trap は無い）。
   - `$LOG` は `$AGMSG_LOG_DIR/agmsg-watch-<name>.log`。**unlink しない**（watcher が fd を握ったまま
     不可視で伸び続けるため）。`umask 077` と `set -C` は `$LOG` の生成だけに掛け、watcher が作る
     pidfile / sentinel / WAL には波及させない。
5. **待機。** 0.2 秒間隔で次を見る。上限は `AGMSG_READY_TIMEOUT` 秒。

   - **sentinel が出現** → もう一度 `WATCH_PID` の生存を確認する（`watch.sh` が sentinel を書いた
     直後に `:407` で exit し、EXIT trap が sentinel を消すレースがある）。生きていれば手順 6 へ。
   - **`WATCH_PID` が死んだ** → 待機を打ち切り、`$LOG` の内容で分類する（事実 10）。

     | ログに含まれる文字列 | `reason` |
     |---|---|
     | `cannot claim` | `held-by-other-session` |
     | `no registration` | `not-registered` |
     | `cannot open message DB` | `db-unavailable` |
     | 上記以外（liveness guard は**空ログ**） | `watcher-exited` |

     `not-registered` は `wired=no` で **exit 1**（呼び出し元が `join.sh` を先に実行する契約。
     ただしプロジェクト解決の食い違いでも同じ経路に落ちるので、`$LOG` に解決先が残る）。
     それ以外は `wired=yes watcher=none` で **exit 0**。
   - **時間切れ** → `WATCH_PID` を kill する。kill する前に
     `[[ "$WATCH_PID" =~ ^[1-9][0-9]*$ ]]` を必ず通す（`kill 0` は呼び出し元のプロセスグループ全員に
     SIGTERM を送る。agmsg 本体も `instance-id.sh:69-71` でこの値域を明示的に拒否している）。
     kill 後、sentinel が存在しその中身が自分の起動した watcher のものなら削除する。
     `watcher=none reason=start-timeout` で **exit 0**。
6. **composite 検証。** 起動した pid を含む `$AGMSG_READY_DIR/watch.*.pid` を探し、ファイル名から
   正規化後の id を復元する。末尾が `.<数字>` でなければ **bare** である（事実 5・6・7）。
   bare のときは watcher を kill し（手順 5 と同じ pid 検証を通す）、sentinel を掃除して
   `watcher=none reason=bare-instance-id` を出力し **exit 0**。
   bare へ落ちる経路は `ps` 不可・20 hops 超・プロセス階層の変更で残るので、
   「サブシェルを外したから composite になるはず」で済ませない。
   composite なら `watcher=started pid=<n>` を出力し **exit 0**。
7. **復元。** 手順 5・6 で watcher を得られなかったとき、`PRE_WATCHERS` に記録した argv のうち
   現在死んでいるものを同じ argv で起動し直す。事実 11 のとおり `watch.sh` は claim より前に
   pidfile を奪うので、「既存の broad watcher を殺したうえで自分も起動しない」状態になりうる。
   復元があれば、guard はどの経路でも**呼び出し前より悪い状態にしない**。
   復元した場合は `watcher=restored` を出力する。

#### 出力

**全経路で必ず 1 行、同じ 7 キーを同じ順で出す。**未設定は `-`。

```
ensure-agmsg-ready: installed=<yes|no> wired=<yes|no> name=<a> watcher=<existing|started|restored|none> pid=<n|-> reason=<slug|-> log=<path|->
```

`reason` の値域: `-` / `not-installed` / `delivery-set-failed` / `not-registered` /
`held-by-other-session` / `db-unavailable` / `watcher-exited` / `start-timeout` /
`bare-instance-id` / `log-unwritable`。

`team=` は出さない。`watch.sh` は claim できた**全 team** の sentinel を書く（`watch.sh:385-394`）ので、
guard が team を 1 つ選ぶという操作自体が存在しない。

`reason` が `-` 以外のときは、**stderr に 1 行だけ**人間向けの手掛かりを出す。

| `reason` | stderr の手掛かり |
|---|---|
| `not-registered` | `run join.sh for this role first; see <log>` |
| `held-by-other-session` | `run /agmsg drop <name> in the owning session, then retry` |
| `db-unavailable` / `watcher-exited` / `start-timeout` / `bare-instance-id` | `see <log>` |

#### 終了コード

| exit | 意味 | 呼び出し元の扱い |
|---|---|---|
| 0 | agmsg を配線できた（watcher の状態は問わない） | `delivery: "agmsg"` |
| 1 | 配線できない（未インストール / `set` 失敗 / 未登録） | agmsg 無しの経路へフォールバック |
| 2 | 使用法エラー | die |

**watcher を起動できなかったことは決して exit 1 にしない。**

exit 2 の発生条件: 必須 2 フラグ（`--type` / `--name`）の欠落 / 未知フラグ /
`--type` が `claude-code` `codex` 以外 / `--project` が存在しないディレクトリ。
この 4 つのいずれでも `delivery.sh` と `watch.sh` を 1 度も呼ばずに終了する。

### 2. 呼び出し箇所

#### (A) 親オーケストレーター — `SKILL.md` Step 1g

「`delivery.sh set` を実行し、AGMSG-DIRECTIVE が出たら従え」という散文を置き換える。
**rc の分岐はこの fenced block の中に書く**（テスト AG1 がブロックを抽出して実行するため。
分岐が散文にあると 1 つも検証できない）。

```bash
TEAM="dispatch-$(basename "$(git rev-parse --show-toplevel)")"
PARENT_ENGINE="claude"
[[ -n "${CODEX_THREAD_ID:-}" ]] && PARENT_ENGINE="codex"
PARENT_AGMSG_TYPE=$(bash <SKILL_DIR>/scripts/resolve-agmsg-type.sh --engine "$PARENT_ENGINE") || exit 1
~/.agents/skills/agmsg/scripts/join.sh "$TEAM" parent "$PARENT_AGMSG_TYPE" "$(pwd)" >/dev/null 2>&1
AGMSG_RC=0
AGMSG_STATE=$(bash <SKILL_DIR>/scripts/ensure-agmsg-ready.sh \
  --type "$PARENT_AGMSG_TYPE" --name parent --project "$(pwd)") || AGMSG_RC=$?
case "$AGMSG_RC" in
  0) case "$AGMSG_STATE" in
       *"watcher=none"*) echo "[warn] agmsg watcher not running ($AGMSG_STATE) — inbox records are disabled for this dispatch" ;;
     esac ;;
  1) TEAM=""; AGMSG_INSTALLED=false
     echo "[warn] agmsg wiring failed ($AGMSG_STATE) — falling back to typed-only delivery with monitor-dispatch.sh" ;;
  *) echo "[error] ensure-agmsg-ready.sh usage error ($AGMSG_STATE)"; exit 1 ;;
esac
```

- **`|| AGMSG_RC=$?` の形が必須。** `set -e` 下では `V=$(cmd)` が非ゼロを返した時点でシェルが即終了し、
  `case` に到達しない。`||` が `set -e` を無効化する。
- rc 1 では `TEAM=""` に加えて **`AGMSG_INSTALLED=false`** を立てる。これが無いと Step 3 で
  `monitor-dispatch.sh` も起動せず、agmsg 記録も heartbeat も無い穴に落ちる。
- rc 2 は使用法エラー＝呼び出し側のバグなので停止する。rc 1 と同じ扱いにすると、フラグ名のタイポが
  「agmsg 無しで普通に動いた」ように見えて恒久化する。
- `--name parent` を渡すので watcher は named になり、`ready.<team>__parent` が生成される。
  これにより子の完了通知が親の inbox へ記録され、`history.sh` から辿れるようになる
  （事実 9 のとおり未読としては現れない）。

#### (B) `prewarm-panes.sh` — 全ロールの初期プロンプトに guard を載せる

**prewarm は watcher を起動しない。** 配線に成功した各ロールの初期プロンプトへ guard の実行を含める。
事実 14 のとおり `launch-workspace.sh` は既に対応しているので、渡していなかった review ペインと
codex ペインにプロンプトを渡すだけでよい。

プロンプトは 1 行、`'` `"` `` ` `` `$` `!` `\` と改行を含まない（事実 14）。
`--project` は渡さない（既定の `$PWD` がワークツリーになる。m3 対策）。

| ロール | プロンプト（`<T>` は `claude-code` または `codex`、`<N>` は agent 名） |
|---|---|
| design | `Run bash <SKILL_DIR>/scripts/ensure-agmsg-ready.sh --type <T> --name <N> and continue even if it exits non-zero. Then wait idle. Your task will arrive as a prompt typed into this pane; an identical copy is also recorded in your agmsg inbox history (treat both as ONE task). Do not start any work until the task prompt arrives.` |
| executor | 同上（末尾を execution instructions 版に差し替え） |
| review | 同上（`<N>` = `<slug>-review`） |

- **`/agmsg actas` は載せない**（claude ペースを含む全ロール）。理由は 3 つ。
  (1) `/agmsg actas` は `Monitor` の起動を指示するので、`Monitor` を持たないペインでは本 spec が
  直そうとしている停止そのものを引き起こす（レビュー中に実際に起きた）。
  (2) モデルが Bash ツールで代替起動すると、その呼び出しが watcher の生存中ずっと返らない
  （実機で観測。pid 15066 が pid 15088 の親のまま滞留）。
  (3) 機能的に不要である。ロックは `watch.sh` の暗黙 claim（事実 2）が取り、from 名は
  `send-prompt.sh --agmsg-from` が明示するので、セッションレベルの FROM 設定に依存しない。
  codex ペースでは加えて `$agmsg` の `$` が事実 14 の禁止文字である。
- 配線失敗（`delivery: "cmux-send"`）のロールには guard を載せない。
  ただし `wire_delivery` は engine 単位のグローバル（`CLAUDE_DELIVERY` / `CODEX_DELIVERY`）を立てるので、
  **粒度は engine であってロールではない**。claude-code 型の全ロールが同時に落ちる。

あわせて事実 16 のディレクティブ漏れを直す。`wire_delivery` の実引数は `engine` であり
`type` ではない点に注意する（関数内で `codex` / `claude-code` をリテラルで書き分けている）。

```bash
# 修正前: >&2 2>/dev/null  ← stdout を stderr に複製してから stderr を捨てている
# 修正後: >/dev/null 2>&1
```

`prewarm-panes.sh` は `set -euo pipefail` で走るので、新しい呼び出しは既存の `wire_delivery` と同じく
`if …; then … else log … fi` で必ず飲み込む。裸で呼んで非ゼロを返させると、agmsg 配線失敗の瞬間に
prewarm ごと die して非目的を構造的に破る。

#### (C) 非 prewarm 経路 — `SKILL.md` の子プロンプト（`793-812` の status protocol ブロック）

`prewarm: false` のとき子は `launch-workspace.sh` が
`.cmux-team-dispatch-task-prompt.md` へ焼き込んだタスクプロンプトだけを持ち、watcher は誰も起動しない。
このブロックに 1 行足す。**ファイル経由なので事実 14 の禁止文字制約は掛からない。**

```
Before you start, run this once and continue even if it exits non-zero:
  bash <SKILL_DIR>/scripts/ensure-agmsg-ready.sh --type <CHILD_AGMSG_TYPE> --name <task-slug>
```

- `<team>` が空のときはこの行も落とす。
- `<CHILD_AGMSG_TYPE>` はタスクごとの `DESIGN_ENGINE` から解決する。親のランタイムや他ロールから
  推測してはならない（`SKILL.md:786-788` が同じ罠を既に警告している）。

#### (D) codex review ペインの sandbox

事実 15 のとおり、codex reviewer は `--sandbox workspace-write` なので既定では
`~/.agents/skills/agmsg/` へ書けない。`launch-workspace.sh` の `REVIEW_WRITABLE_FLAG` に
`--add-dir "$HOME/.agents/skills/agmsg"` を足す。**事実 14 の「`launch-workspace.sh` の変更は不要」は
この 1 点だけ例外になる。** `STATUS_DIR` を許可しているのと同じ理由（レビューペインが正当に
必要とする workspace 外の書き込み先）である。

### 3. `scripts/lib/agmsg-path.sh`（新規）

sentinel パスのエンコード（事実 17）を 1 箇所に置き、`ensure-agmsg-ready.sh` と `send-prompt.sh` の
両方が source する。`AGMSG_READY_DIR` は agmsg 側のパス計算には影響しない（`agmsg_ready_path` は
`actas-claim.sh` / `watch.sh` が自分の配置から算出する `SKILL_DIR` を使う）ので、
**本リポジトリ側で同じエンコード規則を再実装する**のが唯一の手段である。
`actas-lock.sh` の source は `SKILL_DIR` と `instance-id.sh` に依存するため採らない。

規則: `[A-Za-z0-9._-]` 以外をバイト単位で `%XX` に変換する（`%` 自身も `%25`）。
`actas-lock.sh:43-73` の `_actas_lock_encode` / `agmsg_ready_path` と同一。

### 4. `prewarm.json` のスキーマ拡張

各ロールに `watcher` を 1 キー追加する（追加のみなので既存の `jq` 参照は壊れない）。

| `watcher` | 意味 |
|---|---|
| `guard-injected` | 配線に成功し、初期プロンプトに guard を載せた |
| `none` | 配線に失敗したので guard を載せていない |

prewarm は watcher を起動しないので、このキーが表すのは「guard を載せたか」であって
「watcher が動いているか」ではない。値名をそのとおりにする。
`delivery` とは 1:1 対応するが、`delivery` は「hook を書けたか」、`watcher` は「guard を載せたか」で
軸が違うので分けて記録する。**`watch_pid` は導入しない。後始末も不要**
（ペインが起動した watcher は composite id を持ち、ペイン終了で自己終了する。事実 6）。

### 5. エンジン別・ロール別のまとめ

| 起点 | 現状 | 本設計後（セッション開始時点） |
|---|---|---|
| 親が claude、`Monitor` あり | broad watcher。sentinel 無し | named watcher へ置換。sentinel あり |
| 親が claude、`Monitor` なし | **watcher 無し（再現した障害）** | guard がバックグラウンド起動 |
| 親が codex | シェル shim 手順を印字。watcher 無し | guard がバックグラウンド起動。手順はログへ |
| claude 子ペイン、`Monitor` あり | named watcher | guard が `watcher=existing` で不介入 |
| claude 子ペイン、`Monitor` なし | **watcher 無し** | guard がバックグラウンド起動 |
| codex 子ペイン | **watcher 無し** | 初期プロンプトの guard が起動 |
| review ペイン | **watcher 無し** | 初期プロンプトの guard が起動（codex は (D) の `--add-dir` が前提） |
| 非 prewarm 経路の子 | **watcher 無し** | 子プロンプトの guard が起動 |
| ロールが他セッションに held | 記録なし | `watcher=none reason=held-by-other-session` ＋ 復旧手順。既存 watcher は復元される |
| 起動しても bare に落ちた | 記録なし | kill して `watcher=none reason=bare-instance-id` |
| 配線に失敗 | `delivery: "cmux-send"` | 同左 ＋ `watcher: "none"`、親は `monitor-dispatch.sh` へ |
| セッション途中の `/clear` | Monitor 経路は SessionStart で復帰 | **対象外**（非目的） |

## 既知のトレードオフ

1. **名前付き watcher は受信行を既読にする**（事実 9）。`Monitor` があるハーネスでは正しい挙動だが、
   無いハーネスでは「誰も読まないログへ流しつつ DB 行を既読にする」ことになる。得られるのは
   `history.sh` から辿れる記録であって `/agmsg inbox` の未読項目ではない。

2. **親の購読が `parent` 宛だけに絞られる。** 手順 3 は broad watcher を検出しない（事実 12）ので、
   親では必ず手順 4 が走り、pidfile 共有により既存の broad watcher が置換される。
   ディスパッチ中の親の役割は `parent` なので意図した挙動だが、`SKILL.md` に副作用として明記する。

3. **同名ロールが複数 team にあると、`watch.sh` は全 team を claim する**（事実 11）。
   `parent` は実際に 2 team に登録されている。1 つでも他セッションが保持していれば watcher は
   起動せず、手順 7 が置換前の watcher を復元して `reason=held-by-other-session` を返す。

4. **`watcher: "none"` でも `delivery` は `agmsg` のまま**（配線には成功しているため）。
   `send-prompt.sh` は sentinel を自分で確認するので、そのロールへの配送は自動的に typed-only へ
   縮退する。呼び出し元が `watcher` で分岐する必要はない。

5. **本プラグインが常駐プロセスを fork するようになる。** これまで watcher の起動は
   ハーネス（`Monitor`）の責任だったが、本設計では同梱スクリプトが `nohup` で起動する。
   台数は N タスクで最大 `3N+1`（親・design・executor・review）で、既定 5 秒間隔で同一 SQLite を
   ポーリングする。`send-prompt.sh:141-144` のコメント自身が「`send.sh` は共有 SQLite で固まりうる」
   と警告している。`CLAUDE.md`「関連プラグインとの境界」表の「永続プロセス: なし」を
   **「agmsg inbox watcher（ペインごと 1 プロセス、ペイン終了で自己終了）」に書き換える。**

## テスト

### 新規 `apps/cmux-team-dispatch-task/test/test-agmsg-ready.sh`

`watch.sh` / `delivery.sh` / `send.sh` を stub 化し、`AGMSG_DIR` / `AGMSG_READY_DIR` /
`AGMSG_LOG_DIR` / `AGMSG_READY_TIMEOUT` を差し替える。
**本物の `~/.agents/skills/agmsg/` に一切触れないこと**を各ケースの前提とする
（`git worktree add` の事故と同じクラス）。

共通ヘルパーの契約:

- **`--name` はプロセス固有にユニーク化する**（例 `ar-$$-<case>`）。`ps` はグローバルなので、
  `parent` のような一般名を使うとユーザーの本物の watcher を掴んで緑になったり、
  同名の本物 watcher が生きていると `existing` に落ちて FAIL する実行環境依存のフレークになる。
- **`AGMSG_READY_TIMEOUT=1` を全ケースで渡す**（AR11 のみ検証対象にする）。既定 15 秒のまま
  sentinel が出ないケースを複数回すとスイートが数分伸びる。
- **出力は必ず 1 行・7 キーが同じ順**をヘルパーで毎ケース検証する。
- **否定ケースの直前に正常系（AR7 と同一 stub 構成）を 1 回通し、stub のログが実際に書かれることを
  確認する。** 否定形アサーションは stub の設置漏れや `AGMSG_DIR` の指し間違いでも「ログが空」で
  全部 PASS してしまう。
- **ハングは自前 watchdog で検出する。`timeout` / `gtimeout` は使わない**
  （`CLAUDE.md` 項目 23 で禁止。開発機には homebrew 版が実在するので「ここでは通るがクリーン環境で
  落ちる」テストになる）。前例は `test-monitor-layout.sh:23-32` と
  `test-runner-terminal-status.sh:30-32`（`kill -0` を上限つきでポーリング）。

| id | 検証内容 |
|---|---|
| AR1 | `send.sh` 不在 → `installed=no reason=not-installed` / exit 1 |
| AR2 | `delivery.sh set` 失敗 → `reason=delivery-set-failed` / exit 1 |
| AR3 | 4 条件を満たす生存 `watch.sh` があるとき `watcher=existing` / exit 0、`watch.sh` を新規に呼ばない |
| AR3b | argv に `watch.sh` を含むが argv[0]/argv[1] が違うプロセスを誤判定しない |
| AR3c | `<slug>-claude` の watcher が生きているとき `--name <slug>` が `existing` にならない（厳密等価） |
| AR3d | 別 project の同名 watcher を `existing` と誤判定しない（条件 4） |
| AR3e | broad（4 引数・name 無し）watcher は検出されず、手順 4 へ進む |
| AR4 | degraded（`ps` が空出力）でも sentinel の中身の owner 生存を確認する。生きていれば `existing`、死んでいれば起動 |
| AR5 | 生きた owner の sentinel を `rm -f` しない |
| AR6 | 正常系: `watch.sh` を `<sid> <project> <type> <name>` の 4 引数で起動し、sentinel 出現後に `watcher=started pid=<n>` / exit 0 |
| AR7 | 印字した `pid=` が `watch.sh` 本体の pid である（中間シェルの pid でない） |
| AR8 | 起動した watcher が生きている間もコマンド置換 `$( )` が戻る（fd が呼び出し元のパイプを掴んでいない）。watchdog つき |
| AR9a-d | 事実 10 の 4 経路（`cannot claim` / `no registration` / `cannot open message DB` / **空ログ**）が正しい `reason` に分類され、`--timeout` を待たずに打ち切られる。`no registration` のみ exit 1 |
| AR10 | pidfile 名が bare（末尾が `.<数字>` でない）→ kill して `reason=bare-instance-id` / exit 0 |
| AR11 | sentinel も作らず終了もしない stub → `AGMSG_READY_TIMEOUT` で打ち切り、**プロセスが実際に kill され**、`reason=start-timeout` / exit 0 |
| AR12 | 手順 7 の復元: 起動前に生存していた watcher が死んだまま終わる経路で、同じ argv が起動し直され `watcher=restored` になる |
| AR13 | `delivery.sh` が AGMSG-DIRECTIVE を印字しても標準出力へ漏れず、`$LOG` に残る |
| AR14 | session id: `claude-code` は `$CLAUDE_CODE_SESSION_ID` のみ、`codex` は `$CODEX_THREAD_ID` のみを見る（逆の変数だけ設定された環境で拾わない）。両方空なら `-` |
| AR15a-d | exit 2 の 4 条件（必須フラグ欠落 / 未知フラグ / 不正な `--type` / 存在しない `--project`）で rc==2 かつ `delivery.sh` / `watch.sh` が 1 度も呼ばれない |
| AR16 | パーセントエンコードが必要な team 名（空白入り）で、guard が参照する sentinel パスが `agmsg_ready_path` と一致する |
| AR17 | `reason` ごとに stderr の手掛かりが 1 行出る（`-` のときは出ない） |
| AR18 | `$LOG` が `umask 077` で作られ、先置き symlink を掴まない（`set -C`）。watcher の生存中に unlink されない |

### 既存スイートへの回帰追加

`prewarm-panes.sh` を呼ぶケースは必ず先にワークツリーディレクトリを `mkdir -p` する。
slug の prefix は `pw` に統一し（`pw1`…`pw8`）、検証ゲートのブランチ列挙を `feat/pw*` にする。

| id | 検証内容 |
|---|---|
| PW1 | 配線成功ロールの `prewarm.json` が `watcher: "guard-injected"`、かつ `[.. \| objects \| select(has("delivery")) \| (.delivery == "agmsg") == (.watcher == "guard-injected")] \| all` |
| PW2 | `delivery.sh` を失敗させる stub を入れると **claude-code 型の全ロールが同時に** `watcher: "none"` になり、いずれの初期プロンプトにも guard が含まれない（既存 stub は `exit 0` 固定なので failure-injection stub を新規に作る） |
| PW3 | design / executor / review / codex の全ペインの初期プロンプトが `ensure-agmsg-ready.sh` を含む |
| PW4 | どのペインの初期プロンプトにも `/agmsg actas` が現れない |
| PW5 | 初期プロンプトに `'` `"` `` ` `` `$` `!` `\` が 1 文字も無く、**改行も無い**（`[[ $(printf '%s' "$p" \| wc -l) -eq 0 ]]`）。パスに空白も無い |
| PW6 | `delivery.sh set` の呼び出しが `>/dev/null 2>&1` で、stdout が呼び出し元へ漏れない |
| PW7 | `ensure-agmsg-ready.sh` が exit 1 でも prewarm が die せず `prewarm.json` を書く |
| PW8 | `--agmsg-team` 無しのとき初期プロンプトに guard を載せない |
| AG1 | `SKILL.md` の Step 1g fenced block を抽出して **`set -euo pipefail` 下で**実行し、rc 0/1/2 の 3 分岐が仕様どおり（`test-cleanup-close.sh` の抽出＋stub 検査の流儀）。抽出後のスクリプトに `~/.agents` が 1 文字も残っていないことを**先に assert してから** `bash` に渡す（fail-closed）。stub は `git` / `join.sh` / `resolve-agmsg-type.sh` / `ensure-agmsg-ready.sh` の 4 つ。`git rev-parse --show-toplevel` の返り値も stub で固定する |
| AG2 | 同ブロックが `--name parent` を渡し、`--session-id` を渡さない |
| AG3 | 非 prewarm 経路の子プロンプトブロックが guard 行を含み、`<team>` が空のときは落ちる |
| AG4 | 同ブロックの `--type` がタスクごとの engine から解決されている（親や他ロールから推測していない） |
| SP25 | `send-prompt.sh` がエンコード済み sentinel パスを参照する（空白入り team 名で `agmsg_ready_path` と一致）。**既存の SP1 とは別 id** |
| CR1 | codex review ペインの起動コマンドに `--add-dir <agmsg skill dir>` が入る |

既存ヘルパー `assert_no_line_with`（`test-prewarm-unattended.sh:60-65`）には
「grep 対象のファイルが実在すること」のガードが無く、prewarm が早期に死んで argv.log が空でも
PASS する。ヘルパー側にガードを足す（U2 / U3 / U8 の 3 箇所は追加後も PASS することを確認済み）。

## ドキュメント

`apps/cmux-team-dispatch-task/CLAUDE.md` の 4 ファイル整合ルールに従い、同一コミットで更新する。
**追加だけでなく、変更後に偽になる既存記述の書き換えが必須。**

| ファイル | 行 | 内容 |
|---|---|---|
| `skills/…/SKILL.md` | 514-528 | Step 1g の `AGMSG_INSTALLED` 判定に guard の rc 分岐を追加 |
| 同上 | 526 / 2201-2203 | `monitor-dispatch.sh` の起動条件に「配線失敗時も起動する」を追加 |
| 同上 | 748-812 | 配線ブロックを guard 呼び出しへ置換。AGMSG-DIRECTIVE 遵守文を削除。`/clear` の既知の制限を追記 |
| 同上 | **793-812** | 非 prewarm 経路の子プロンプト（status protocol ブロック）に guard 行を追加 |
| 同上 | 2737 | Reference 節 Delivery 要約の「MUST be followed」を削除 |
| `skills/…/references/guide-ja.md` | 204 | Step 1g の訳 |
| 同上 | 1290 | 補足の Delivery 要約に同一文 |
| `README.md` | 239 付近 | 「`AGMSG-DIRECTIVE:` に従って watcher を起動する」の書き換え |
| `CLAUDE.md` | 154（項目 12） | 「Step 1g に AGMSG-DIRECTIVE 遵守が記載されていること」→ guard の検証項目へ差し替え |
| 同上 | 166（項目 15） | 「配線失敗時に **design / claude executor** の初期プロンプトを出し分ける」→ 全ロール＋`/agmsg actas` を載せない方針へ差し替え |
| 同上 | 298（E2E 項目 17） | 「AGMSG-DIRECTIVE により watcher が起動していること」→ guard 経由へ差し替え |
| 同上 | 308（E2E 項目 27） | 同上（2 ロール限定の記述） |
| 同上 | 「関連プラグインとの境界」表 | 「永続プロセス: なし」→「agmsg inbox watcher（ペインごと 1 プロセス、ペイン終了で自己終了）」 |
| 同上 | メンテナンス手順 | `test-agmsg-ready.sh`（AR1-18）と PW/AG/SP25/CR1 の id 群を登録する。既存の全 id 群（MT1-3 / CS1-3 / SP0-24 / PG1-3 / OV1-9 …）と同じ扱い |
| `scripts/prewarm-panes.sh` | 584, 617 | 「codex は idle でも agmsg push を受けられる保証が無いため初期 prompt は常に無し」というコメントが偽になる。書き換える |

制約:

- `SKILL.md` と `*-ja.md` 以外の `references/*.md` に日本語文字を 1 文字も書かない
  （`node scripts/check-doc-lang.mjs` が hard gate）
- `SKILL.md` / `references/**/*.md` に `cmux send` / `cmux send-key` のリテラルを入れない
  （`test/test-send-prompt-callsites.sh` の CS3）
- パスのプレースホルダは**編集箇所の周囲で既に使われている方に合わせる**（Step 1g 周辺は `<SKILL_DIR>`）
- シェルスクリプトは bash 3.2 互換。`set -u` 下で空になりうる配列は `${arr[@]+"${arr[@]}"}` で展開する
- コメントとコミットメッセージは日本語、識別子は英語

## 検証ゲート

```bash
cd apps/cmux-team-dispatch-task
for t in test/*.sh; do printf '%-46s ' "$t"; if bash "$t" >/dev/null 2>&1; then echo OK; else echo FAILED; fi; done
bash test/test-send-prompt-callsites.sh
node ../../scripts/check-doc-lang.mjs apps/cmux-team-dispatch-task
cd <repo root> && pnpm check
```

全スイートが通り `check-doc-lang` が OK であること。`@tanaka-yui/token-meter` の
`noNonNullAssertion` 警告 4 件は既知のノイズ。

実行後に残骸が無いことも確認する。

```bash
git worktree list
git branch --list 'feat/pg*' 'feat/is*' 'feat/ov*' 'feat/pw*'
```

## 改訂履歴

### 改訂 2 → 3（レビュー ラウンド 2 を反映）

| 改訂 2 | 改訂 3 | 理由 |
|---|---|---|
| `( … & echo $! )` で起動 | サブシェルを外し `nohup … & PID=$!` | 事実 8: サブシェルは決定的に bare id を生む（実測 3/3） |
| `setsid` を主形式 | 使わない | macOS に存在せず、util-linux 版は ppid ウォークを壊す |
| 起動後の composite 検証なし | 手順 6 で必須 | bare へ落ちる経路は `ps` 不可などで残る |
| 手順 3 で `actas-claim.sh` | 廃止。`watch.sh` の暗黙 claim に任せる | claim は本番の取得で解放 CLI が無く、watcher を得られない経路でロールが黒穴になる |
| 手順 4 は name だけで照合 | フルパス＋type＋project＋name の 4 条件 AND | 別プロジェクトの同名ロールを誤認し、`grep` 実装では `<slug>-claude` にヒットした |
| 「`Monitor` のケースがここに入る」 | broad は検出できないと明記 | 事実 12: `Monitor` の watcher は 4 引数で name を持たない |
| degraded は sentinel の有無だけ | owner の生存を確認 | stale sentinel を `existing` と誤判定していた |
| stale sentinel を無条件 `rm -f` | owner が死んでいると確認できたときだけ | 生きた別プロセスの sentinel を消すと永久に不可視になる |
| 置換に失敗しても復元しない | 手順 7 で復元 | 事実 11: pidfile 奪取は claim より前なので、既存 watcher を殺して自分も起動しない状態になりうる |
| `--timeout` / `--log-dir` フラグ | 環境変数へ | 呼び出し箇所ゼロ。YAGNI |
| `$debuglog` と `$log` が別 | `$LOG` に統一。unlink しない | 未定義の変数だった。watcher が握ったまま unlink すると不可視で肥大する |
| `--project` 必須 | `$PWD` 既定 | 初期プロンプトはパスをクォートできず、空白入りで exit 2 になる |
| `/agmsg actas` を claude ペインに載せる | 全ロールで載せない | `Monitor` 指示による停止（レビュー中に実際に発生）とブロッキング Bash 起動を温存するため |
| codex review も一括で guard | (D) で `--add-dir` を追加 | 事実 15: codex reviewer だけ sandbox が `workspace-write` |
| `AGMSG_STATE=$(...)` | `|| AGMSG_RC=$?` | `set -e` 下では代入が非ゼロで即終了し `case` に到達しない |
| rc 分岐が散文 | fenced block 内に `case` を焼き込む | AG1 が抽出実行で検証できるようにするため |
| 禁止文字 6 種 | 改行も禁止 | 既存 8 件のペイン数アサーションが `wc -l` で数えている |
| `teams=<n>` を条件付きで出力 | 廃止。7 キー固定 | 「全経路で同じキー」という出力契約と矛盾していた |
| `watcher: "pane"` | `"guard-injected"` | prewarm が記録できるのは「guard を載せたか」だけ |
| ドキュメント 11 箇所 | 14 箇所＋テスト id 登録 | 4 ファイル整合ルールの取りこぼし |
| `/clear` に言及なし | 非目的に明記 | `/clear` は watcher を失わせ、guard は 1 回しか走らない |

### 改訂 1 → 2（レビュー ラウンド 1 を反映）

prewarm による代理起動と `--detached`（`AGMSG_AGENT_PID=`）を廃止し、
「watcher はペイン自身が起動する」中核方針へ変更した。bare id の sentinel が
`session-start.sh` の GC で消されること（事実 7）と、他人の session id では即死すること（事実 6）が理由。
あわせて `watch_pid` の回収と kill、合成 session id、`identities.sh` の直接参照を削除した。
