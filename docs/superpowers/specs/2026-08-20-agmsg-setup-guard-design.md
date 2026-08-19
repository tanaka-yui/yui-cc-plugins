# agmsg セットアップガードの設計

対象: `apps/cmux-team-dispatch-task`

> 改訂 2。spec レビュー ラウンド 1（`.dispatch/agmsg-setup-guard/review/spec-round-1.md`）で
> 中核メカニズム 2 つが成立しないことが実証されたため、設計を作り直した。
> 改訂 1 との差分は末尾「改訂 1 からの変更」を参照。

## 背景

### 再現した障害

ディスパッチが agmsg を配線するとき、スキルは次を実行する。

```bash
~/.agents/skills/agmsg/scripts/delivery.sh set monitor claude-code "$(pwd)"
```

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
宣言した直後にターンを終了し、9 分間無応答だった。ディレクティブを送らない旨を明示して
再送したところ正常に完走した。**同じ抜け穴が親・設計・レビューの全ペインで発火する。**

### 調査で確定した事実

すべて実機で確認した。行番号は確認時点のもの。

1. **`watch.sh` は `Monitor` ツール無しでも動く。** バックグラウンドの素のプロセスとして起動でき、
   pidfile と ready sentinel を通常どおり生成する。`watch.sh` のヘッダー自身が
   「also works standalone as `tail -f` for inbox」と明言している。

2. **ready sentinel は `watch.sh` に role 名（第 4 引数 = `ACTIVE_NAME`）を渡したときだけ書かれる**
   （`watch.sh:385`）。role 名なしの broad 購読では生成されない。
   actas ロックの claim は同じ条件だが別のガード（`watch.sh:241` / `:249`）である。

3. **`delivery.sh set` は冪等。** 同一モードで 2 回実行して `settings.local.json` がバイト単位で
   一致することを確認した。

4. **`delivery.sh set` の出力は watcher の有無の根拠にならない。** `emit_monitor_directive` が
   ディレクティブを抑止する条件は `run/watch.<session_id>.pid` の存在と生存だけで、
   **project を見ない**。別プロジェクトを対象に `set` しても、そのセッションに watcher があれば
   ディレクティブは出ない。

5. **`watch.sh` は session_id を自前で正規化する**（`watch.sh:141`、`agmsg_normalize_instance_id`）。
   agent 種別ごとの ppid walk で祖先を探し、見つかれば `<sid>.<pid>` の composite にする。
   pidfile 名は正規化後の id で決まるため、**同一 session_id で 2 つ目の watcher を起動すると
   `watch.sh:165` が前の watcher を kill する**（意図的な重複排除、#66）。

6. **claude セッションの中から、そのセッションのものではない session_id で claude-code 型の
   watcher を起動すると即座に自己終了する。** 正規化で親 claude の pid が composite に入る一方、
   `agmsg_instance_alive` は composite に対して `run/cc-instance.<pid>` の中身がその token と
   **完全に一致する**ことまで要求する（`instance-id.sh:413-421`）。親の cc-instance には親自身の
   token が入っているので不一致となり「死んでいる」と判定され、`watch.sh:407` の liveness guard が
   最初のループで exit する。

7. **`AGMSG_AGENT_PID=`（空文字）を export すると bare id に固定できる**（`resolve-project.sh` の
   `agmsg_agent_pid`）。実測で確認した。**しかしこれは使えない。** bare id は
   `agmsg_instance_alive` に対して常に「死んでいる」ため、`session-start.sh:224-228` の GC
   ループが **ready sentinel を無条件に削除する**。

   ```
   session-start.sh:224  for f in "$RUN_DIR"/ready.*; do
   session-start.sh:226    rd_sid=$(cat "$f" 2>/dev/null || true)
   session-start.sh:227    { [ -n "$rd_sid" ] && actas_lock_sid_alive "$rd_sid"; } || rm -f "$f"
   ```

   このループは project でも team でも絞られず、**agmsg 配線済みの claude セッションが
   どこかで起動 / `/clear` / resume するたび**に走る。sentinel は `watch.sh:385-395` で起動時に
   1 回しか書かれないので、消えたら復活しない。`send-prompt.sh` は sentinel の存在だけで
   inbox 記録を分岐するので、**プロセスは生きているのに送信側からは死んで見える**状態になる。

   → **ready sentinel を GC から守れる owner は「生きた agmsg インスタンス id」だけである。**
   すなわち **watcher はそのロールのペイン自身が、自分のセッション id で起動するしかない。**

8. **名前付き watcher は配信した行を既読にする**（`watch.sh:478` の `mark_read`）。
   スキップ条件は `[ -z "$ACTIVE_NAME" ]`、つまり **broad watcher 専用**である
   （`watch.sh:343`。「その role 自身の watcher が read state を所有する」という設計意図）。
   `inbox.sh` は `read_at IS NULL` しか表示しないので、名前付き watcher が動いているロールでは
   受信メッセージは `/agmsg inbox` に現れず、`history.sh` でのみ辿れる。

9. **`identities.sh` はプロジェクトパスを解決しない。** `resolve-project.sh` を source するが
   `agmsg_resolve_project` を呼ばず、`agmsg_project_sql_in_list`（綴り variant の展開のみ）しか
   使わない（`identities.sh:24,27`）。解決は呼び出し元の責務であり、`join.sh` / `actas-claim.sh` /
   `watch.sh` / `whoami.sh` は全員が事前に `agmsg_resolve_project` を通している。
   実測: `identities.sh <worktree> claude-code` は空、`identities.sh <main repo> claude-code` は 10 行。

10. **登録パスの解決結果は agent type に依存する。** `agmsg_resolve_project` の優先順は
    (1) `run/proj.<agent_pid>.project` マーカー → (2) 祖先ウォーク → (3) git-common-dir → (4) 生の pwd。
    claude-code は親セッションの SessionStart が書いたマーカーが効いて **メインリポジトリ**で登録され、
    codex はマーカーが無いので **ワークツリーのまま**登録される。

11. **`actas-claim.sh` が上記をすべて吸収する。** `actas-claim.sh <project> <type> <name> <session_id>` は
    内部で `agmsg_resolve_project` と `agmsg_normalize_instance_id` を通し、`<name>` が登録されている
    **全 team** に対してロックを claim する（1 つでも held ならロールバックして中止）。
    出力と終了コードは `status=ok team=<t> [team=<t2> …]` / 0、`status=held team=<t> owner=<sid>` / 1、
    `status=not_registered` / 2。

12. **`watch.sh` の name フィルタは team を見ない**（`watch.sh:213`）。`ACTIVE_NAME` があるとき、
    同名 role が複数 team にあれば全部を claim しに行き、1 つでも他セッションが保持していれば
    `watch.sh:271` で **exit 1**（hard fail）する。実測で `parent` は
    `dispatch-yui-cc-plugins` と `yui-cc-plugins` の 2 team に登録されていた。
    しかも `watch.sh:165-179` の pidfile 奪取は claim より**前**に走るので、claim 失敗時は
    「既存の watcher を殺した上で自分も起動しない」最悪の結果になる。
    → 事前に `actas-claim.sh` で claim できることを確かめてから起動する必要がある。

13. **codex 型には watcher を起動する既定経路が無い。** `type.conf` が `monitor=no` で、
    `_delivery.sh` の `on_enable` はシェル関数の導入手順（「プロファイルに追記してシェルを
    再起動せよ」）を印字する。これも実行中セッションが追従できない指示である。

14. **`launch-workspace.sh` は `--mode standby` / `--mode review` で初期プロンプトを受け付ける。**
    claude / codex の両分岐に `${PROMPT_TEXT:+ '$PROMPT_TEXT'}` 相当の処理があり
    （`launch-workspace.sh:723-726, 758-771, 789-796`）、`prewarm-panes.sh` が review ペインと
    codex ペインに渡していないだけである。**`launch-workspace.sh` の変更は不要。**
    ただしプロンプトは `zsh -ic "… '<prompt>' …"` に二重埋め込みされエスケープされないので、
    **`'` `"` `` ` `` `$` `!` `\` を含まない 1 行**でなければならない（`parallel-directive.sh` の PD4 と同じ制約）。

15. **`prewarm-panes.sh` の既存の配線呼び出しはディレクティブを漏らしている。**

    ```
    prewarm-panes.sh:411,417   bash "$AGMSG_DIR/delivery.sh" set monitor <type> "$CWD" >&2 2>/dev/null
    ```

    リダイレクトは左から評価されるので **stdout を元の stderr に複製してから stderr を捨てる**。
    AGMSG-DIRECTIVE は `delivery.sh:332` の stdout なので、そのまま呼び出し元へ出ている。

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
2. 未セットアップのとき、追従不能なディレクティブを出して先へ進むのをやめ、**その場で
   セットアップを行ってから継続する**。
3. claude / codex の両エンジン、および親・設計・実装・レビューの全ロールについて、agmsg を
   配線するすべての経路が **定義済みの終了状態**（watcher 稼働、または明示的に記録された
   フォールバック）で終わるようにする。

## watcher の価値についての正確な記述

事実 8 のとおり、名前付き watcher は配信した行を既読にする。したがって watcher の価値は
**「未読の inbox 項目が増えること」ではない**。正確には次の 2 つである。

1. **`Monitor` ツールがあるハーネスでは、行がセッションのコンテキストへ実際に注入される。**
   これは本物の配送であり、既読化はその正しい帰結である。
2. **`Monitor` が無いハーネスでは、`send-prompt.sh` が inbox 記録を行うようになり、
   本文が `history.sh` から辿れるようになる。** ログとしての価値であって、未読通知ではない。

どちらの場合も wake はタイプ入力が担う。**watcher の欠如は配送の欠如ではない。**
この認識は非目的「watcher の欠如を致命的にしない」の根拠でもある。

## 非目的

- **watcher の欠如を致命的にしない。** watcher を起動できないときにディスパッチを止める修正は、
  バグそのものより悪い。
- **ready sentinel を watcher 無しで書く案は採らない。** `send-prompt.sh` は sentinel の存在しか
  見ないので、sentinel だけ書けば inbox 記録は成立し、しかも未読のまま残る（事実 8 の回避）。
  だが sentinel の契約は `actas-lock.sh:63-68` で「present iff a live watcher is currently
  receiving for that role」と定義されており、`spawn.sh:713` の `--wait-ready` がこの不変条件に
  依存している。**他ツールの名前空間に偽の不変条件を書き込むことになるので採用しない。**
- codex の bridge（`codex-bridge.js` / シェル shim）の導入・自動化。bridge はシェル shim 経由で
  起動し直した codex セッションでしか動かず、ディスパッチが起動する codex ペインは対象外である。
- agmsg 本体（`~/.agents/skills/agmsg/`）への変更。本リポジトリの管理外。
- delivery mode の変更（`monitor` 固定）。
- バージョン番号の更新、push、PR 作成。

## 設計

### 中核方針

> **watcher は、そのロールのペイン自身が、自分のセッション id で起動する。
> 他ペインの代理で watcher を起動する経路は作らない。**

事実 6・7 から、これ以外に GC を生き延びる watcher は存在しない。この方針の帰結として、
改訂 1 にあった「prewarm による headless 起動」「`--detached`」「`watch_pid` の回収と kill」
「合成 session id」はすべて不要になる。

### 1. 新スクリプト `scripts/ensure-agmsg-ready.sh`

```
ensure-agmsg-ready.sh --project <path> --type <claude-code|codex> --name <agent>
                      [--timeout <sec>] [--log-dir <path>]
```

| フラグ | 既定 | 意味 |
|---|---|---|
| `--project` | 必須 | このセッションのプロジェクトパス（解決は `actas-claim.sh` が行う） |
| `--type` | 必須 | `claude-code` または `codex`。`resolve-agmsg-type.sh` の出力 |
| `--name` | 必須 | このセッションが名乗る agmsg agent 名 |
| `--timeout` | `15` | ready sentinel の出現を待つ上限秒数 |
| `--log-dir` | 無し（一時ファイルを使い、終了時に消す） | watcher の出力を残す先 |

環境変数 `AGMSG_DIR`（既定 `$HOME/.agents/skills/agmsg/scripts`）と `AGMSG_READY_DIR`
（既定 `$HOME/.agents/skills/agmsg/run`）で参照先を差し替えられる。`send-prompt.sh` と同じ
変数名・同じ既定値にそろえ、テストの stub 化にも使う。

session id は環境から取る。`--type claude-code` なら `$CLAUDE_CODE_SESSION_ID`、
`--type codex` なら `$CODEX_THREAD_ID`。どちらも空なら `-`（`watch.sh` の「無し」sentinel）を渡す。
**フラグでは受け取らない** — 他セッションの id を渡す使い方は事実 6 により常に誤りだからである。

`--mode` / `--no-start` / `--team` / `--session-id` / `--detached` は設けない
（改訂 1 から削除。呼び出し箇所が無い、または誤用しかできないため）。

#### 処理

1. `$AGMSG_DIR/send.sh` が無ければ `installed=no` を出力し **exit 1**。
2. `delivery.sh set monitor <type> <project>` を実行する（冪等、事実 3）。
   **`>>"$debuglog" 2>&1` でデバッグログへ落とす**（`/dev/null` ではない。事実 4 の
   AGMSG-DIRECTIVE と codex のシェル shim 手順を呼び出し元へ漏らさないが、事後解析はできる）。
   非ゼロ終了なら `wired=no reason=delivery-set-failed` を出力し **exit 1**。
3. `actas-claim.sh <project> <type> <name> <session-id>` を実行する（事実 11）。
   - rc 2 = `not_registered` → `wired=no reason=not-registered` を出力し **exit 1**
     （呼び出し元が `join.sh` を先に実行する契約）。
   - rc 1 = `held` → `wired=yes watcher=none reason=held-by-other-session owner=<sid>` を出力し
     **exit 0**。復旧手順（当該セッションで `/agmsg drop <name>`）を stderr に 1 行出す。
     **ここで watcher を起動してはならない**（事実 12: 起動すると既存 watcher を殺して自分も死ぬ）。
   - rc 0 → `status=ok team=<t> …` の**最初の** `team=` を採用する。
     2 つ以上あれば `teams=<n>` として出力に載せる（`watch.sh` はどのみち全 team を購読する）。
4. **既存 watcher の判定。** `ps -eo pid=,args=` を走査し、
   `watch.sh` が実行対象（argv[0] または argv[1] の basename）で、かつ最後の位置引数が `<name>` に
   一致する生存プロセスを探す（`instance-id.sh` の `agmsg_args_is_grok_watcher` と同じ流儀）。
   - 見つかった → `watcher=existing pid=<n>` を出力し **exit 0**。
     `Monitor` が動いているケースがここに入る。既存 watcher には触らない。
   - 見つからず、sentinel だけがある → **stale sentinel**（SIGKILL / クラッシュの残骸）。
     `rm -f` して手順 5 へ進む。`spawn.sh:722` が起動前に必ず `rm -f` するのと同じ作法。
   - `ps` が使えない環境では sentinel の有無だけで判定する（degraded）。
5. **起動。** 次の形で detach する。

   ```
   ( umask 077; setsid nohup bash "$AGMSG_DIR/watch.sh" "$SID" "$PROJECT" "$TYPE" "$NAME" \
       </dev/null >"$log" 2>&1 & echo $! )
   ```

   - **fd 3 本すべてを付け替える。** stdin/stdout/stderr のいずれかを呼び出し元のパイプに
     残すと、コマンド置換やツール実行がパイプの EOF を待って戻らなくなる（(C) の経路で
     ペインのツール呼び出しがハングする）。逆に stderr だけ残すと、呼び出し元終了後の
     stderr 書き込みで watcher が SIGPIPE で無言死する（`watch.sh` に PIPE trap は無い）。
   - `setsid` が無ければ `nohup` + `disown`。
   - `bash "$AGMSG_DIR/watch.sh"` を直接起動する（`bash -c` を挟むと `$!` が中間シェルの pid に
     なり、kill しても watcher が孤児として残る）。
6. **待機。** 0.2 秒間隔で次の 3 つを見る。上限は `--timeout` 秒。
   - sentinel が出現 → `watcher=started pid=<n>` を出力し **exit 0**
   - **起動した pid が死んだ** → 待機を打ち切る。`watch.sh` は sentinel を作らずに即 exit する
     経路を 3 つ持つ（`:271` held / `:274-281` 未登録 / `:407-409` liveness guard）ので、
     全経路で 15 秒待つのは無駄である。ログの内容で `reason` を分類する。
     | ログに含まれる文字列 | `reason` |
     |---|---|
     | `cannot claim` | `held-by-other-session` |
     | `no registration` | `not-registered` |
     | `cannot open message DB` | `db-unavailable` |
     | 上記以外 | `watcher-exited` |
     いずれも `watcher=none` で **exit 0**。
   - 時間切れ → 起動した pid を kill し `watcher=none reason=start-timeout` で **exit 0**。

#### 出力

**全経路で必ず 1 行、同じキーを同じ順で出す。**未設定は `-`。

```
ensure-agmsg-ready: installed=<yes|no> wired=<yes|no> team=<t|-> name=<a> watcher=<existing|started|none> pid=<n|-> reason=<slug|->
```

`reason` の値域: `-` / `not-installed` / `delivery-set-failed` / `not-registered` /
`held-by-other-session` / `db-unavailable` / `watcher-exited` / `start-timeout`。

#### 終了コード

| exit | 意味 | 呼び出し元の扱い |
|---|---|---|
| 0 | agmsg を配線できた（watcher の状態は問わない） | `delivery: "agmsg"` |
| 1 | 配線できない（未インストール / `set` 失敗 / 未登録） | agmsg 無しの経路へフォールバック |
| 2 | 使用法エラー | die |

**watcher を起動できなかったことは決して exit 1 にしない。**

exit 2 の発生条件を明示する: 必須 3 フラグの欠落 / 未知フラグ / `--type` が
`claude-code` `codex` 以外 / `--timeout` が正の整数でない。この 4 つのいずれでも
`delivery.sh` と `watch.sh` を 1 度も呼ばずに終了する。方針は `send-prompt.sh` の
`die()` および `resolve-agmsg-type.sh` の usage エラーと同じ。

### 2. 呼び出し箇所

#### (A) 親オーケストレーター — `SKILL.md` Step 1g

「`delivery.sh set` を実行し、AGMSG-DIRECTIVE が出たら従え」という散文を置き換える。

```bash
TEAM="dispatch-$(basename "$(git rev-parse --show-toplevel)")"
PARENT_ENGINE="claude"
[[ -n "${CODEX_THREAD_ID:-}" ]] && PARENT_ENGINE="codex"
PARENT_AGMSG_TYPE=$(bash <this-skill-dir>/scripts/resolve-agmsg-type.sh --engine "$PARENT_ENGINE") || exit 1
~/.agents/skills/agmsg/scripts/join.sh "$TEAM" parent "$PARENT_AGMSG_TYPE" "$(pwd)"
AGMSG_STATE=$(bash <this-skill-dir>/scripts/ensure-agmsg-ready.sh \
  --project "$(pwd)" --type "$PARENT_AGMSG_TYPE" --name parent)
AGMSG_RC=$?
```

分岐:

| `AGMSG_RC` | 対応 |
|---|---|
| 0 | `TEAM` を保持して続行。`AGMSG_STATE` の `watcher=` が `none` なら Step 1f のサマリー表の下に `[warn] agmsg watcher not running (reason=<r>) — inbox records are disabled for this dispatch` を出す |
| 1 | `TEAM=""` かつ **`AGMSG_INSTALLED=false`**。後者が無いと Step 3 で `monitor-dispatch.sh` も起動せず、agmsg 記録も heartbeat も無い穴に落ちる |
| 2 | 使用法エラー。呼び出し側のバグなので `[error]` を出して停止する。1 と同じ扱いにすると、フラグ名のタイポが「agmsg 無しで普通に動いた」ように見えて恒久化する |

`--name parent` を渡すので watcher は named になり、`ready.<team>__parent` が生成される。
これにより子の完了通知が親の inbox へ記録され、`history.sh` から辿れるようになる
（事実 8 のとおり未読としては現れない）。

`--session-id` は渡さない。type に応じて環境から取るので codex 親でも正しく動く。

#### (B) `prewarm-panes.sh` — 全ロールの初期プロンプトに guard を載せる

**prewarm は watcher を起動しない。** 代わりに、配線に成功した各ロールの初期プロンプトへ
guard の実行を含める。事実 14 のとおり `launch-workspace.sh` は既に対応しているので、
渡していなかった review ペインと codex ペインにプロンプトを渡すだけでよい。

プロンプトは 1 行、`'` `"` `` ` `` `$` `!` `\` を含まない（事実 14）。

| ロール | プロンプト |
|---|---|
| design (claude) | `/agmsg actas <slug> then run bash <this-skill-dir>/scripts/ensure-agmsg-ready.sh --project <cwd> --type claude-code --name <slug> and continue even if it exits non-zero. Then wait idle. Your task will arrive as a prompt typed into this pane; an identical copy is also recorded in your agmsg inbox (treat both as ONE task). Do not start any work until the task prompt arrives.` |
| claude executor | 同上（`<slug>-claude`、文面は execution instructions 版） |
| design (codex) / codex executor | `Run bash <this-skill-dir>/scripts/ensure-agmsg-ready.sh --project <cwd> --type codex --name <name> and continue even if it exits non-zero. Then wait idle. …` |
| review | reviewer engine に応じて上の claude 版 / codex 版（`<slug>-review`） |

- codex ペインには `/agmsg actas` を付けない。codex の skill 起動 prefix は `$` で、事実 14 の
  禁止文字に該当する。guard 内の `actas-claim.sh` がロックの claim を行うので機能的に足りる。
- 配線失敗（`delivery: "cmux-send"`）のロールには現行どおり guard も `actas` も含めない。
- **`/agmsg actas` と guard の順序**は claude ペインでは actas を先にする。ただし
  「先に guard を走らせると `held` になる」という改訂 1 の説明は誤りだった。
  `actas-claim.sh:49` と `watch.sh:141` は同じ関数で同じ token を導出するので
  `actas_lock_claim` は `ok` を返す（`actas-lock.sh:123-125`）。actas を先にする理由は
  「`Monitor` があるハーネスで watcher を 2 回起動する無駄を避ける」ことだけであり、
  正しさの要件ではない。

あわせて事実 15 のディレクティブ漏れを直す。

```bash
# 修正前: >&2 2>/dev/null  ← stdout を stderr に複製してから stderr を捨てている
# 修正後:
bash "$AGMSG_DIR/delivery.sh" set monitor "$type" "$CWD" >/dev/null 2>&1
```

`prewarm-panes.sh` は `set -euo pipefail` で走るので、guard に関わる新しい呼び出しは
既存の `wire_delivery` と同じく `if …; then … else log … fi` で必ず飲み込む。裸で呼んで
非ゼロを返させると、agmsg 配線失敗の瞬間に prewarm ごと die して非目的を構造的に破る。

#### (C) 非 prewarm 経路 — `SKILL.md` の子プロンプト

`prewarm: false` のとき子は `launch-workspace.sh` が焼き込んだタスクプロンプトだけを持ち、
watcher は誰も起動しない。`SKILL.md` が子プロンプトへ付けている status protocol ブロックに
1 行足す。

```
Before you start, run this once and continue even if it exits non-zero:
  bash <this-skill-dir>/scripts/ensure-agmsg-ready.sh --project <cwd> --type <type> --name <task-slug>
```

`<team>` が空のときはこの行も落とす。

### 3. `prewarm.json` のスキーマ拡張

各ロールのオブジェクトに `watcher` を 1 キー追加する（既存キーは不変。追加のみなので
既存の `jq` 参照は壊れない）。**`watch_pid` は導入しない**（prewarm は watcher を起動しないため）。

```json
{
  "design": { "…": "…", "delivery": "agmsg",     "watcher": "pane" },
  "review": { "…": "…", "delivery": "cmux-send", "watcher": "none" }
}
```

| `watcher` | 意味 |
|---|---|
| `pane` | 配線に成功し、初期プロンプトに guard を載せた。ペインが自分で watcher を起動する |
| `none` | 配線に失敗したので guard を載せていない。inbox 記録は行われない |

`delivery` が `agmsg` なら `watcher` は `pane`、`cmux-send` なら `none` で 1:1 に対応する。
冗長に見えるが、`delivery` は「hook を書けたか」、`watcher` は「inbox 記録が成立しうるか」という
別の軸であり、将来どちらかだけが変わりうるので分けて記録する。

**後始末は不要。** ペインが起動した watcher は composite id を持つのでペイン終了時に自己終了する。
`watch_pid` を回収して kill する仕組みは持たない（改訂 1 から削除）。

### 4. `send-prompt.sh` の sentinel パスのエンコード修正

`watch.sh` が実際に作る sentinel は `agmsg_ready_path`（`actas-lock.sh:69`）で
`[A-Za-z0-9._-]` 以外をパーセントエンコードしたパスである。一方 `send-prompt.sh` は
`ready.${TEAM}__${TO_AGENT}` と生連結しており、エンコードしていない。

`TEAM="dispatch-$(basename "$(git rev-parse --show-toplevel)")"` なので、リポジトリ名に空白や
非 ASCII が入ると両者が食い違い、**watcher が動いていても inbox 記録が永久にスキップされる**。
本 spec は sentinel を「セットアップ済みの証拠」として使う設計なので、この不整合を同じコミットで
直す。`ensure-agmsg-ready.sh` と `send-prompt.sh` の双方が同じエンコード関数を使う。

### 5. エンジン別・ロール別のまとめ

| 起点 | 現状 | 本設計後 |
|---|---|---|
| 親が claude、`Monitor` あり | broad watcher。sentinel 無し | named watcher。sentinel あり |
| 親が claude、`Monitor` なし | **watcher 無し（再現した障害）** | guard がバックグラウンド起動 |
| 親が codex | シェル shim 手順を印字。watcher 無し | guard がバックグラウンド起動。手順はデバッグログへ |
| claude 子ペイン、`Monitor` あり | named watcher | 変更なし（guard は `watcher=existing`） |
| claude 子ペイン、`Monitor` なし | **watcher 無し** | guard がバックグラウンド起動 |
| codex 子ペイン | **watcher 無し** | 初期プロンプトの guard が起動 |
| review ペイン | **watcher 無し** | 初期プロンプトの guard が起動 |
| 非 prewarm 経路の子 | **watcher 無し** | 子プロンプトの guard が起動 |
| ロールが他セッションに held | 記録なし | `watcher=none reason=held-by-other-session` ＋ 復旧手順 |
| 配線に失敗 | `delivery: "cmux-send"` | 同左 ＋ `watcher: "none"` |

## 既知のトレードオフ

1. **名前付き watcher は受信行を既読にする**（事実 8）。`Monitor` があるハーネスでは正しい挙動だが、
   無いハーネスでは「誰も読まないログへ流しつつ DB 行を既読にする」ことになる。得られるのは
   `history.sh` から辿れる記録であって、`/agmsg inbox` の未読項目ではない。
   これを避ける唯一の方法は watcher 無しで sentinel だけを書くことだが、非目的のとおり採らない。

2. **親の購読が `parent` 宛だけに絞られる。** 同じセッションが既に `/agmsg actas <別 role>` で
   動いていた場合、pidfile を共有するのでその watcher は置き換えられる。ディスパッチ中の親の
   役割は `parent` なので意図した挙動だが、`SKILL.md` に副作用として明記する。

3. **同名ロールが複数 team にあると、全 team を claim する**（事実 12）。`parent` は実際に 2 team に
   登録されている。1 つでも他セッションが保持していれば guard は watcher を起動せず
   `reason=held-by-other-session` を返す。手順 3 で `actas-claim.sh` を先に走らせているので、
   既存 watcher を殺してから失敗する最悪ケースは起きない。

4. **`watcher: "none"` でも `delivery` は `agmsg` のまま**（配線には成功しているため）。
   `send-prompt.sh` は sentinel を自分で確認するので、そのロールへの配送は自動的に
   typed-only へ縮退する。呼び出し元が `watcher` で分岐する必要はない。

## テスト

### 新規 `apps/cmux-team-dispatch-task/test/test-agmsg-ready.sh`

agmsg スクリプト群を stub 化し `AGMSG_DIR` / `AGMSG_READY_DIR` を差し替える。
`identities.sh` / `actas-claim.sh` / `watch.sh` の stub は本リポジトリに前例が無いので新規に作る。
**本物の `~/.agents/skills/agmsg/run/` と本物の DB に触れないよう、両変数の差し替えを
全ケースで必ず行う**（`git worktree add` の事故と同じクラスの危険）。

共通ヘルパーで「出力は必ず 1 行」「7 キーが常に同じ順で揃う」を毎ケース検証する。

| id | 検証内容 |
|---|---|
| AR1 | `send.sh` 不在 → `installed=no` / exit 1 |
| AR2 | `delivery.sh set` 失敗 → `reason=delivery-set-failed` / exit 1 |
| AR3 | `actas-claim.sh` rc 2 → `reason=not-registered` / exit 1 |
| AR4 | `actas-claim.sh` rc 1 → `reason=held-by-other-session` / **exit 0**、`watch.sh` を呼ばない、復旧手順が stderr に出る |
| AR5 | 生存中の `watch.sh … <name>` があるとき `watcher=existing` / exit 0、`watch.sh` を新規に呼ばない |
| AR6 | sentinel はあるが watcher プロセスが無い（stale）→ sentinel を削除して起動し直す |
| AR7 | 正常系: `watch.sh` を `<sid> <project> <type> <name>` の 4 引数で起動し、sentinel 出現後に `watcher=started pid=<n>` / exit 0 |
| AR8 | `watch.sh` が sentinel を作らず即 exit → `--timeout` を待たずに打ち切り、ログ内容に応じた `reason` を返して **exit 0** |
| AR9 | `watch.sh` が sentinel も作らず終了もしない → `--timeout` で打ち切り、**プロセスが実際に kill され**、`reason=start-timeout` / exit 0 |
| AR10 | `delivery.sh` が AGMSG-DIRECTIVE を印字しても標準出力へ漏れない（`--log-dir` 指定時はログに残る） |
| AR11 | session id: `claude-code` は `$CLAUDE_CODE_SESSION_ID`、`codex` は `$CODEX_THREAD_ID`、両方空なら `-` |
| AR12 | 起動した watcher が生きている間もコマンド置換 `$( )` が戻る（fd が呼び出し元のパイプを掴んでいない） |
| AR13 | 印字した `pid=` が `watch.sh` 本体の pid である（中間シェルの pid でない） |
| AR14a–d | exit 2 の 4 条件（必須フラグ欠落 / 未知フラグ / 不正な `--type` / 不正な `--timeout`）で rc==2 かつ `delivery.sh` / `actas-claim.sh` / `watch.sh` が 1 度も呼ばれない |
| AR15 | パーセントエンコードが必要な team 名（空白入り）で、guard が参照する sentinel パスと `watch.sh` が作るパスが一致する |

### 既存スイートへの回帰追加

| id | 検証内容 |
|---|---|
| PW1 | 配線成功ロールの `prewarm.json` に `watcher: "pane"` が入る |
| PW2 | 配線失敗ロールは `watcher: "none"` で、初期プロンプトに guard も `actas` も含まれない |
| PW3 | claude ペインの初期プロンプトが `/agmsg actas` の**後**に `ensure-agmsg-ready.sh` を含む |
| PW4 | codex ペインと review ペインに初期プロンプトが渡り、guard を含む |
| PW5 | 初期プロンプトに `'` `"` `` ` `` `$` `!` `\` が 1 文字も含まれない（`parallel-directive.sh` の PD4 と同型） |
| PW6 | `delivery.sh set` の呼び出しが `>/dev/null 2>&1` で、stdout が呼び出し元へ漏れない |
| PW7 | `ensure-agmsg-ready.sh` が exit 1 でも prewarm が die せず `prewarm.json` を書く |
| PW8 | `--agmsg-team` 無しのとき `ensure-agmsg-ready.sh` を 1 度も呼ばない |
| AG1 | `SKILL.md` の Step 1g ブロックを抽出して実行し、rc 0/1/2 の 3 分岐が仕様どおり（`test-cleanup-close.sh` の「SKILL.md からブロックを抽出して bash で実行する」流儀を踏襲） |
| AG2 | 同ブロックが `--name parent` を渡し、`--session-id` を渡さない |
| SP1 | `send-prompt.sh` がエンコード済み sentinel パスを参照する（空白入り team 名で `watch.sh` の作るパスと一致） |

否定的アサーションは grep 対象のファイルが実在することを先に確認する。
既存ヘルパー `assert_no_line_with`（`test-prewarm-unattended.sh:60-65`）にはそのガードが無く、
prewarm が早期に死んで argv.log が空でも PASS するので、ヘルパー側にガードを足す。

`prewarm-panes.sh` を呼ぶテストは必ず先にワークツリーディレクトリを `mkdir -p` する
（実リポジトリに対して `git worktree add` が走るとブランチとワークツリー登録が残る。
本リポジトリで 2 回発生している）。

## ドキュメント

`apps/cmux-team-dispatch-task/CLAUDE.md` の 4 ファイル整合ルールに従い、同一コミットで更新する。
**追加だけでなく、変更後に偽になる既存記述の書き換えが必須。**

| ファイル | 行 | 内容 |
|---|---|---|
| `skills/…/SKILL.md` | 514-528 | Step 1g の `AGMSG_INSTALLED` 判定に guard の rc 分岐を追加 |
| 同上 | 526 / 2201-2203 | `monitor-dispatch.sh` の起動条件に「配線失敗時も起動する」を追加 |
| 同上 | 748-812 | Step 1g の配線ブロックを guard 呼び出しへ置換。AGMSG-DIRECTIVE 遵守文を削除 |
| 同上 | 780-791 | 非 prewarm 経路の子プロンプトに guard 行を追加 |
| 同上 | 2737 | Reference 節 Delivery 要約の「MUST be followed」を削除 |
| `skills/…/references/guide-ja.md` | 204 | Step 1g の訳 |
| 同上 | 1290 | 補足の Delivery 要約に同一文 |
| `README.md` | 239 付近 | 「`AGMSG-DIRECTIVE:` に従って watcher を起動する」の書き換え |
| `CLAUDE.md` | 154（項目 12） | 「Step 1g に AGMSG-DIRECTIVE 遵守が記載されていること」→ guard の検証項目へ差し替え |
| 同上 | 298（E2E 項目 17） | 「AGMSG-DIRECTIVE により watcher が起動していること」→ guard 経由へ差し替え |
| 同上 | 「関連プラグインとの境界」表 | 「永続プロセス: なし」は本設計後も真（watcher はペインのセッションに束縛され、ペイン終了で自己終了する）。**変更不要**だが確認する |

制約:

- `SKILL.md` と `*-ja.md` 以外の `references/*.md` に日本語文字を 1 文字も書かない
  （`node scripts/check-doc-lang.mjs` が hard gate）
- `SKILL.md` / `references/**/*.md` に `cmux send` / `cmux send-key` のリテラルを入れない
  （`test/test-send-prompt-callsites.sh` の CS3）
- パスのプレースホルダは `<this-skill-dir>`（`CLAUDE.md`「SKILL.md の編集ルール」）
- シェルスクリプトは bash 3.2 互換。`set -u` 下で空になりうる配列は
  `${arr[@]+"${arr[@]}"}` で展開する
- コメントとコミットメッセージは日本語、識別子は英語

## 検証ゲート

```bash
cd apps/cmux-team-dispatch-task
for t in test/*.sh; do printf '%-46s ' "$t"; if bash "$t" >/dev/null 2>&1; then echo OK; else echo FAILED; fi; done
cd <repo root> && pnpm check
```

全スイートが通り `check-doc-lang` が OK であること。`@tanaka-yui/token-meter` の
`noNonNullAssertion` 警告 4 件は既知のノイズ。

実行後に残骸が無いことも確認する。新規テストで使う slug の prefix も列挙対象に加える。

```bash
git worktree list
git branch --list 'feat/pg*' 'feat/is*' 'feat/ov*' 'feat/ar*'
```

## 改訂 1 からの変更

| 改訂 1 | 改訂 2 | 理由 |
|---|---|---|
| prewarm が他ロールの watcher を代理起動 | 各ペインが自分で起動 | 事実 7: bare id の sentinel は GC に消される。事実 6: 他人の sid では即死する |
| `--detached` / `AGMSG_AGENT_PID=` | 削除 | 同上 |
| `watch_pid` の記録と cleanup での kill | 削除 | 代理起動が無くなり不要 |
| 合成 session id | 削除 | 同上 |
| 手順 3 で `identities.sh` を直接引く | `actas-claim.sh` に置換 | 事実 9: `identities.sh` はパスを解決しないので worktree パスでは常に空。あわせて厳密照合・team 解決・held 事前検出も得られる |
| 手順 4 は sentinel の有無だけ | `ps` による watcher 生存確認＋stale sentinel の削除 | stale sentinel を `existing` と誤判定していた |
| 手順 7 は timeout まで待つ | プロセス死で即打ち切り＋ログで分類 | `watch.sh` の即 exit 経路 3 つで 15 秒を空費していた |
| `delivery.sh` の出力を `/dev/null` へ | デバッグログへ | 復旧手順（`/agmsg drop`）と bare fallback 警告が消えていた |
| `--mode` / `--no-start` / `--team` / `--session-id` | 削除 | 呼び出し箇所が無い、または誤用しかできない |
| detach の fd 指定なし | `</dev/null >log 2>&1` ＋ `setsid` を明記 | 呼び出し元のハングと watcher の SIGPIPE 死 |
| 「watcher の価値は inbox 記録」 | 事実 8 を踏まえて正確化 | named watcher は受信行を既読にする |
| ドキュメント 4 箇所 | 10 箇所を行番号つきで列挙 | 変更後に偽になる既存記述の取りこぼし |
| 親の rc 分岐は `|| TEAM=""` のみ | rc 0/1/2 を書き分け、rc 1 は `AGMSG_INSTALLED=false` も立てる | exit 2 の握り潰しと、agmsg も monitor も無い穴 |
| — | `send-prompt.sh` の sentinel エンコード修正を追加 | guard と `send-prompt.sh` が別のパスを見ていた |
