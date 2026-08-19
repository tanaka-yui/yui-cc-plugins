# agmsg セットアップガードの設計

対象: `apps/cmux-team-dispatch-task`

## 背景

### 再現した障害

ディスパッチが agmsg を配線するとき、スキルは次を実行する。

```bash
~/.agents/skills/agmsg/scripts/delivery.sh set monitor claude-code "$(pwd)"
```

その出力は次を含む。

```
Future sessions: SessionStart hook will auto-launch the watcher.

AGMSG-DIRECTIVE: For this running session, invoke the Monitor tool now with:
  command: /Users/…/watch.sh <session-id> <repo> claude-code
  description: agmsg inbox stream
  persistent: true
```

**このディレクティブを受け取ったオーケストレーターのセッションには `Monitor` ツールが無かった。**
よって指示は追従不能で、watcher は起動しなかった。セッション開始時の `SessionStart` hook も
同一のディレクティブを出しており、そちらも同じ理由で無視された。

`SKILL.md` は現在このディレクティブを「follow it（従え）」と書いているだけで、
ツールを持たないハーネス向けのフォールバックが存在しない。

### 調査で確定した事実

いずれも本ワークツリー上で実測した。

1. **`watch.sh` は `Monitor` ツール無しでも動く。** バックグラウンドの素のプロセスとして
   起動でき、pidfile と ready sentinel を通常どおり生成する。`watch.sh` のヘッダー自身が
   「also works standalone as `tail -f` for inbox: any agent runtime that can read stdout
   can consume it」と明言している。失われるのはストリーム出力がセッションのコンテキストへ
   注入されることだけで、これは元々 idle セッションを起こせない（本プラグインのドキュメントが
   既に述べているとおり、agmsg push は inbox 記録専用で wake 手段ではない）。
   したがって watcher の価値は **inbox 記録と ready sentinel** であり、
   バックグラウンド watcher はその価値を丸ごと提供する。

2. **ready sentinel は `watch.sh` に role 名（第 4 引数 = actas 名）を渡したときだけ書かれる。**
   `watch.sh:385` の `if [ -n "$ACTIVE_NAME" ]` が sentinel 書き込みと actas ロックの
   claim の両方を支配している。role 名なしの broad 購読では sentinel が生成されない。

3. **`delivery.sh set` は冪等。** 同一モードで 2 回実行して `settings.local.json` が
   バイト単位で一致することを確認した。ヘッダーにも「Re-running with the same mode is a
   no-op」と明記されている。

4. **`delivery.sh set` の出力は watcher の有無の根拠にならない。** `emit_monitor_directive`
   が「既に watcher が動いている」と判断してディレクティブを抑止する条件は
   `run/watch.<session_id>.pid` の存在と生存だけで、**project を見ない**。別プロジェクトを
   対象に `set` しても、そのセッションに watcher があればディレクティブは出ない。

5. **`watch.sh` は session_id を自前で正規化する（`watch.sh:141`）。** `agmsg_normalize_instance_id`
   が agent 種別ごとの ppid walk で祖先プロセスを探し、見つかれば `<sid>.<pid>` の composite に
   する。composite になると `watch.sh:407` の liveness guard が効き、その pid が死んだ時点で
   watcher が自己終了する。祖先が見つからなければ bare id のままで、liveness guard は
   働かない（＝自己終了しない）。
   - **pidfile は正規化後の id で決まるため、同一 session_id で複数の watcher を起動すると
     `watch.sh:165` が「同一セッションの重複起動」とみなして前の watcher を kill する。**

6. **claude セッションの中から、そのセッションのものではない session_id で claude-code 型の
   watcher を起動すると即座に自己終了する。** 正規化で親 claude の pid が composite に入る一方、
   `agmsg_instance_alive` は composite に対して `run/cc-instance.<pid>` の中身が
   **その token と完全一致する**ことまで要求する（`instance-id.sh:413-421`）。親 claude の
   cc-instance には親自身の token が入っているので不一致となり「死んでいる」と判定され、
   `watch.sh:407` の liveness guard が最初のループで exit する。
   したがって **prewarm が親セッションから他ロールの claude-code 型 watcher を素直に起動する
   ことはできない**（同じ session_id を使えば pidfile が衝突し、違う session_id を使えば即死する）。

7. **`AGMSG_AGENT_PID` は agmsg 公式の環境変数オーバーライドである**（`resolve-project.sh` の
   `agmsg_agent_pid`）。**空文字を明示的に export すると ppid walk を行わず bare sid に固定する。**
   実測でも `agmsg: instance-id falling back to bare session_id …` のログとともに bare 化を確認した。
   bare id は composite ではないので liveness guard が働かず watcher は生き続け、かつ
   `agmsg_instance_alive`（bare 版）は `cc-instance.*` のどれとも一致しないため
   **その id が握る actas ロックは常に stale 扱い＝いつでも再取得可能**になる。
   これが事実 6 の制約を回避する唯一の正攻法である。

8. **登録のプロジェクトパスは呼び出し元の祖先エージェントのプロジェクトへ解決される。**
   `join.sh` にワークツリーのパスを渡しても、`agmsg_resolve_project` が git-common-dir を
   辿ってメインリポジトリのパスで登録する（実測）。`identities.sh` / `watch.sh` も同じ解決を
   行うので整合するが、**パスを渡す側は「渡した文字列がそのまま保存される」と仮定してはならない**。

9. **codex 型には watcher を起動する既定経路が無い。** `type.conf` が `monitor=no` で、
   `_delivery.sh` の `on_enable` は Monitor ディレクティブではなくシェル関数の導入手順
   （「プロファイルに追記してシェルを再起動せよ」）を印字する。これも実行中セッションが
   追従できない指示であり、claude 側と同じ形の抜け穴になっている。

### 現状のロール別 watcher 実態

| ロール | 初期プロンプト | watcher | ready sentinel |
|---|---|---|---|
| parent (claude) | AGMSG-DIRECTIVE → Monitor | broad 購読 | **無し** |
| design (claude) | `/agmsg actas <slug>` | named | Monitor がある場合のみ |
| claude executor | `/agmsg actas <slug>-claude` | named | Monitor がある場合のみ |
| `<slug>-review` | **無し** | **無し** | **無し** |
| design (codex) / codex executor | **無し** | **無し** | **無し** |

結果として `prewarm.json` の `delivery: "agmsg"` は「hook ファイルを書けた」以上の意味を
持たない。inbox 記録が成立するかどうかとは無関係である。とくに parent は broad 購読の
ため sentinel が無く、子の完了通知は `send-prompt.sh` の判定で inbox 記録がスキップされ、
**一度も親の inbox に残っていない**。

## 目的

1. agmsg が「インストールされている」ことではなく「このセッションで実際にセットアップ
   済みである（inbox watcher が動く／動かせる）」ことを判定できるようにする。
2. インストール済みだが未セットアップのとき、追従不能なディレクティブを出して先へ進むのを
   やめ、**その場でセットアップを行ってから継続する**。
3. claude / codex の両エンジン、および親・設計・実装・レビューの全ロールについて、agmsg を
   配線するすべての経路が **定義済みの終了状態**（watcher 稼働、または明示的に記録された
   フォールバック）で終わるようにする。

## 非目的

- **watcher の欠如を致命的にしない。** 配送はタイプ入力が担っており、watcher は inbox 記録を
  足すだけである。watcher を起動できないときにディスパッチを止める修正は、バグそのものより
  悪い。
- codex の bridge（`codex-bridge.js` / シェル shim）を導入・自動化すること。bridge は
  シェル shim 経由で起動し直した codex セッションでしか動かず、ディスパッチが起動する
  codex ペインは対象外である。本設計は bridge を使わず `watch.sh` を直接使う。
- agmsg 本体（`~/.agents/skills/agmsg/`）への変更。本リポジトリの管理外である。
- delivery mode の変更（`monitor` のまま）。codex に対して `turn` モードの方が実効的では
  ないかという論点はあるが、配送セマンティクスの変更であり本 spec の範囲外。
- バージョン番号の更新、push、PR 作成。

## 設計

### 1. 新スクリプト `scripts/ensure-agmsg-ready.sh`

agmsg 配線の単一の入口。冪等で、何度呼んでも安全。

```
ensure-agmsg-ready.sh --project <path> --type <claude-code|codex> --name <agent>
                      [--team <team>] [--session-id <id>] [--mode <monitor|turn|both|off>]
                      [--detached] [--timeout <sec>] [--log-dir <path>] [--no-start]
```

| フラグ | 既定 | 意味 |
|---|---|---|
| `--project` | 必須 | 対象プロジェクト（ワークツリー）のパス |
| `--type` | 必須 | agmsg agent type。`resolve-agmsg-type.sh` の出力を渡す |
| `--name` | 必須 | このロールの agmsg agent 名。ready sentinel の生成に必要 |
| `--team` | `identities.sh` から解決 | チーム名 |
| `--session-id` | type に応じて `$CLAUDE_CODE_SESSION_ID` / `$CODEX_THREAD_ID`。どちらも空なら `-` | watcher の所有者 id |
| `--mode` | `monitor` | `delivery.sh set` に渡すモード |
| `--detached` | off | watcher をこのセッションから切り離して起動する（後述） |
| `--timeout` | `15` | ready sentinel の出現を待つ秒数 |
| `--log-dir` | `${TMPDIR:-/tmp}` | detach した watcher の stdout 退避先 |
| `--no-start` | off | 判定のみ行い watcher を起動しない |

環境変数 `AGMSG_DIR`（既定 `$HOME/.agents/skills/agmsg/scripts`）と `AGMSG_READY_DIR`
（既定 `$HOME/.agents/skills/agmsg/run`）で参照先を差し替えられる。`send-prompt.sh` と
同じ変数名・同じ既定値にそろえ、テストからの stub 化にも使う。

**`--session-id` と `--detached` の意味（事実 5〜7 に対応）**

| モード | 使う場面 | 起動の仕方 | 結果 |
|---|---|---|---|
| 既定（セッション束縛） | 自分自身のロールの watcher を、自分のセッションの中から起動する | `watch.sh <自分の session_id> …` | composite id になり、セッション終了で watcher も自己終了する。actas ロックの所有者が `/agmsg actas` と一致するので競合しない |
| `--detached` | 他ロールの watcher を代理で起動する（prewarm） | `AGMSG_AGENT_PID= watch.sh <一意な synthetic id> …` | bare id に固定され、即死せず動き続ける。ロックは常に stale 扱いなので、後からそのペインが `actas` しても弾かれない。**自己終了しないので呼び出し元が pid を回収して kill する義務を負う** |

`--detached` を使うときは `--session-id` をロールごとに必ず一意にする（事実 5 の pidfile 衝突）。

処理:

1. `$AGMSG_DIR/send.sh` が無ければ `installed=no wired=no reason=not-installed` を印字し
   **exit 1**。
2. `delivery.sh set <mode> <type> <project>` を実行する（冪等）。
   **標準出力・標準エラーはともに握り潰す。** これが「追従不能な指示を外へ出さない」ことの
   実装であり、AGMSG-DIRECTIVE も codex のシェル shim 手順も呼び出し元へ伝播しない。
   失敗したら `wired=no reason=delivery-set-failed` を印字し **exit 1**。
3. `identities.sh <project> <type>` の出力から `--name` に一致する行を探す（`--team` が
   与えられていればその team に絞る）。**この確認は `--team` の有無にかかわらず必ず行う。**
   見つからなければ `wired=no reason=not-registered` を印字し **exit 1**
   （呼び出し元が `join.sh` を先に実行する契約）。未登録のまま `watch.sh` を起動すると
   「no registration … nothing to do」で即 exit するだけで、`--timeout` 秒を無駄に待つ。
4. `~/.agents/skills/agmsg/run/ready.<team>__<name>` が既に存在すれば
   `watcher=existing` を印字し **exit 0**（重複起動しない）。
   - sentinel のパスは `send-prompt.sh` が既に直接参照している同じ規約を使う。
     team / agent 名のエンコードも同じ（`[A-Za-z0-9._-]` 以外はパーセントエンコード）。
5. `--no-start` なら `watcher=none reason=not-started` を印字し **exit 0**。
6. `watch.sh "<session-id または ->" <project> <type> <name>` を detach 起動し、stdout を
   `<log-dir>/agmsg-watch-<team>__<name>.log` へ退避する。`--detached` のときは
   `AGMSG_AGENT_PID=` を export した環境で起動する（事実 7）。
7. ready sentinel の出現を 0.2 秒間隔で `--timeout` 秒までポーリングする。
   - 出現 → `watcher=started pid=<n>` を印字し **exit 0**
   - 出現せず → 起動したプロセスを kill し `watcher=none reason=start-timeout` を印字して
     **exit 0**

標準出力は 1 行の `key=value` 形式にする。

```
ensure-agmsg-ready: installed=yes wired=yes team=<t> name=<a> mode=monitor watcher=started pid=12345 reason=-
```

**終了コードは「agmsg を配線できたか」だけを表す。**

| exit | 意味 | 呼び出し元の扱い |
|---|---|---|
| 0 | 配線済み（watcher の有無は問わない） | `delivery: "agmsg"` |
| 1 | 配線不可（未インストール / `set` 失敗 / 未登録） | `delivery: "cmux-send"` にフォールバック |
| 2 | 使用法エラー | die |

watcher を起動できなかったことは **決して exit 1 にしない**。これが非目的に挙げた
「watcher の欠如を致命的にしない」の実装上の担保である。

### 2. 呼び出し箇所

#### (A) 親オーケストレーター — `SKILL.md` Step 1g

現行の「`delivery.sh set` を実行し、AGMSG-DIRECTIVE が出たら従え」という散文を置き換える。

```bash
TEAM="dispatch-$(basename "$(git rev-parse --show-toplevel)")"
PARENT_ENGINE="claude"
[[ -n "${CODEX_THREAD_ID:-}" ]] && PARENT_ENGINE="codex"
PARENT_AGMSG_TYPE=$(bash <SKILL_DIR>/scripts/resolve-agmsg-type.sh --engine "$PARENT_ENGINE") || exit 1
~/.agents/skills/agmsg/scripts/join.sh "$TEAM" parent "$PARENT_AGMSG_TYPE" "$(pwd)"
bash <SKILL_DIR>/scripts/ensure-agmsg-ready.sh \
  --project "$(pwd)" --type "$PARENT_AGMSG_TYPE" --name parent --team "$TEAM" || TEAM=""
```

`--session-id` は渡さない。既定で type に応じて `$CLAUDE_CODE_SESSION_ID` /
`$CODEX_THREAD_ID` を拾うので、codex 親でも正しい id が使われる。ここで
`--session-id "${CLAUDE_CODE_SESSION_ID:-}"` と明示すると codex 親のとき空文字で
既定を潰してしまう。

- `--name parent` を渡すため watcher は named になり、`ready.<team>__parent` が生成される。
  これにより **子の完了通知が親の inbox にも記録されるようになる**（現在は記録されていない）。
- `Monitor` ツールの有無に依存しない。ツールがあってブロード watcher が既に動いている
  セッションでは、`watch.sh` 自身の重複起動処理により旧 watcher が置き換わる。
  この場合 `Monitor` タスクは終了するので、`SKILL.md` は「`agmsg inbox stream` という
  `Monitor` タスクが残っていたら `TaskStop` してよい」と補足する（これは `Monitor` が
  存在するときにのみ意味を持つ指示であり、常に追従可能）。
- exit 1 のときは `TEAM` を空にする。以降 `--agmsg-*` フラグが落ち、既存の typed-only
  経路にそのまま乗る。

#### (B) `prewarm-panes.sh` — actas を実行しないロール

`<slug>-review`、codex design、codex executor は初期プロンプトを持たず `/agmsg actas` を
実行しないため、これらのロールの watcher は誰も起動しない。prewarm がワークツリー配線の
直後に headless watcher を起動する。

```bash
ensure_watcher() {   # role_key type name
  local out
  out=$(bash "$SCRIPT_DIR/ensure-agmsg-ready.sh" \
    --project "$CWD" --type "$2" --name "$3" --team "$AGMSG_TEAM" \
    --detached --session-id "agmsg-prewarm-$SLUG-$1" \
    --log-dir "$STATUS_DIR" 2>/dev/null) || return 1
  ...
}
```

- **`--detached` が必須。** 事実 6 のとおり、これを付けずに claude-code 型の watcher を
  親セッションから起動すると即座に自己終了してしまう。
- **`--session-id` はロールごとに一意にする。** 事実 5 のとおり、同一 session_id で複数の
  watcher を起動すると `watch.sh` が前の watcher を kill してしまう。
- 起動結果（`watcher` と `pid`）を `prewarm.json` の各ロールへ記録する。
- 失敗しても die しない。既存の `wire_delivery` と同じフォールバック方針に揃える。

claude design / claude executor は **prewarm 側で起動しない**。これらのペインは (C) の経路で
自分自身のセッションに束縛された watcher を起動できる。そちらは自己終了するので kill 義務が
生じず、actas ロックの所有者も `/agmsg actas` と一致して意味のある排他になる。prewarm が
先に detached watcher を立てると、(C) の guard は手順 4 で sentinel を見つけて何もしなくなり、
**kill 義務つきで排他としても機能しない watcher に置き換わってしまう**。劣る方を選ぶ理由が無い。

#### (C) claude design / claude executor — 初期プロンプト

`/agmsg actas <name>` の**直後**に guard を走らせる 1 文を追加する。

```
/agmsg actas <name>, then run:
  bash <SKILL_DIR>/scripts/ensure-agmsg-ready.sh --project <cwd> --type claude-code --name <name>
to confirm the inbox watcher is actually running (it starts one in the background when this
harness has no Monitor tool). Then wait idle. …
```

- `Monitor` が使えたときは手順 4 で `watcher=existing` になり何もしない。
- 使えなかったときだけバックグラウンド watcher が立つ。
- **`--detached` は付けない。** 既定の `--session-id`（`$CLAUDE_CODE_SESSION_ID`）で起動すると
  `watch.sh` が自セッションの composite id へ正規化するので、`/agmsg actas` が claim した
  ロックの所有者と一致して競合せず、ペイン終了時に watcher も自己終了する。
- **順序が load-bearing。** guard を先に走らせると、guard の watcher がロックを握った状態で
  `/agmsg actas` が走り `status=held` になる。`/agmsg actas` を先に実行すること。

配線失敗時（`CLAUDE_DELIVERY=cmux-send`）のプロンプトは現行どおり `/agmsg actas` も guard も
含まない「直接タイプされる」文面のままにする。

### 3. `prewarm.json` のスキーマ拡張

各ロールのオブジェクトに 2 キーを追加する（既存キーは不変。追加のみなので既存の
`jq` 参照は壊れない）。

```json
{
  "design":  { "…": "…", "delivery": "agmsg", "watcher": "pane",     "watch_pid": null },
  "review":  { "…": "…", "delivery": "agmsg", "watcher": "started",  "watch_pid": 12345 },
  "executors": {
    "claude": { "…": "…", "delivery": "agmsg", "watcher": "pane",    "watch_pid": null },
    "codex":  { "…": "…", "delivery": "agmsg", "watcher": "started", "watch_pid": 12346 }
  }
}
```

| `watcher` | 意味 |
|---|---|
| `pane` | ペイン自身が `/agmsg actas` + guard で起動する（claude design / claude executor） |
| `existing` | prewarm が確認した時点で既に稼働していた |
| `started` | prewarm が headless watcher を起動した。`watch_pid` に pid |
| `none` | 起動できなかった。`delivery` は `agmsg` のままだが inbox 記録は行われない |

これが要件「すべてのパスが定義済みの終了状態で終わる」の記録面である。

### 4. 後始末

事実 7 のとおり、`--detached` で起動した watcher は instance-id が bare のままなので
自己終了しない。`SKILL.md` の最終クリーンアップ（ペインを閉じ worktree / branch を尋ねる節）で、
ペインを閉じる前に `prewarm.json` の `watch_pid` を列挙して kill する。

```bash
jq -r '.. | objects | .watch_pid? // empty' "$STATUS_DIR/prewarm.json" 2>/dev/null \
  | while read -r p; do kill "$p" 2>/dev/null || true; done
```

claude 型の watcher（`watcher: "pane"`）は composite id を持つのでペイン終了時に自己終了し、
この一覧には現れない。

### 5. エンジン別のまとめ

| 起点 | 現状 | 本設計後 |
|---|---|---|
| 親が claude、Monitor あり | broad watcher。sentinel 無し | named watcher に置換。sentinel あり |
| 親が claude、Monitor なし | **watcher 無し（再現した障害）** | バックグラウンド named watcher |
| 親が codex | シェル shim 手順を印字。watcher 無し | バックグラウンド named watcher。shim 手順は握り潰す |
| claude 子ペイン、Monitor あり | named watcher | 変更なし（guard は no-op） |
| claude 子ペイン、Monitor なし | **watcher 無し** | guard がバックグラウンド起動 |
| codex 子ペイン | **watcher 無し** | prewarm が headless watcher を起動 |
| review ペイン | **watcher 無し** | prewarm が headless watcher を起動 |
| 起動に失敗したケース | 記録なし | `prewarm.json` に `watcher: "none"` として記録 |

## 既知のトレードオフ

1. **`--detached` の watcher は自己終了しない。** bare id にすることで即死（事実 6）と
   ロック占有の両方を避けている代償として、liveness guard が働かない。呼び出し元が
   `prewarm.json` の `watch_pid` を回収して kill する義務を負う。kill を忘れると
   5 秒ポーリングのプロセスが 1 ロールにつき 1 つ残る。
   なお actas ロックは常に stale 扱いなので、後から人間がそのペインで `/agmsg actas` を
   実行しても `held` では弾かれない。

2. **親の購読が `parent` 宛だけに絞られる。** named watcher は role を 1 つに限定する。
   同じセッションが既に `/agmsg actas <別 role>` で動いていた場合、その watcher は
   pidfile を共有するため置き換えられ、以後の受信は `parent` 宛だけになる。
   ディスパッチは `join.sh … parent` で明示的に parent role を作っており、
   ディスパッチ中の親の役割は `parent` なので、これは意図した挙動である。
   `SKILL.md` にはこの副作用を明記する。

3. **`watcher: "none"` でも `delivery` は `agmsg` のまま。** `delivery` は「配線できたか」、
   `watcher` は「inbox 記録が成立するか」を表す別の軸である。`send-prompt.sh` は
   sentinel を自分で確認するので、`watcher: "none"` のロールへの配送は自動的に
   typed-only に縮退する。呼び出し元が `watcher` で分岐する必要はない。

## テスト

新規 `apps/cmux-team-dispatch-task/test/test-agmsg-ready.sh`。既存の prewarm スイートと
同じ流儀で agmsg スクリプト群を stub 化し、`AGMSG_DIR` / `AGMSG_READY_DIR` を差し替える。

| id | 検証内容 |
|---|---|
| AR1 | `send.sh` が無いとき `installed=no` を印字し exit 1 |
| AR2 | `delivery.sh set` が失敗したとき `reason=delivery-set-failed` で exit 1 |
| AR3 | `identities.sh` に `--name` が無いとき `reason=not-registered` で exit 1 |
| AR4 | ready sentinel が既にあるとき `watcher=existing` で exit 0、`watch.sh` を呼ばない |
| AR5 | sentinel が無いとき `watch.sh` を `<sid> <project> <type> <name>` の 4 引数で起動し、sentinel 出現後に `watcher=started` で exit 0 |
| AR6 | `watch.sh` が sentinel を作らないとき timeout し、`watcher=none reason=start-timeout` で **exit 0**（致命的にしない） |
| AR7 | `delivery.sh` が AGMSG-DIRECTIVE を印字しても標準出力へ漏れない |
| AR8 | `--no-start` で `watch.sh` を起動しない |
| AR9 | `--detached` のとき `watch.sh` の環境に `AGMSG_AGENT_PID` が空で export される |
| AR10 | `--detached` を付けないとき `AGMSG_AGENT_PID` を export しない |
| AR11 | `--session-id` 省略時、type に応じて `$CLAUDE_CODE_SESSION_ID` / `$CODEX_THREAD_ID` を使い、どちらも空なら `-` を渡す |

既存スイートへの回帰追加:

| id | 検証内容 |
|---|---|
| PW1 | `prewarm.json` の review / codex ロールに `watcher` と `watch_pid` が入る |
| PW2 | claude design / claude executor は `watcher: "pane"` で prewarm が watcher を起動しない |
| PW3 | claude design / claude executor の初期プロンプトが `/agmsg actas` の**後**に `ensure-agmsg-ready.sh` を含む |
| PW4 | 配線失敗（`delivery: "cmux-send"`）のとき初期プロンプトに `actas` も guard も含まれない |
| PW5 | headless watcher の `--session-id` がロールごとに異なる |

`prewarm-panes.sh` を呼ぶテストは必ず先にワークツリーディレクトリを `mkdir -p` する
（実リポジトリに対して `git worktree add` が走るとブランチとワークツリー登録が残る。
本リポジトリで 2 回発生している）。否定的アサーションは、grep 対象のファイルが実在することを
先に確認する。

## ドキュメント

`apps/cmux-team-dispatch-task/CLAUDE.md` の 4 ファイル整合ルールに従い、同一コミットで
更新する。

1. `skills/cmux-team-dispatch-task/SKILL.md` — Step 1g の `AGMSG_INSTALLED` 判定、
   `join.sh` / `delivery.sh set` ブロック、AGMSG-DIRECTIVE を要求する一文の置換
2. `skills/cmux-team-dispatch-task/references/guide-ja.md` — 同じ節の訳
3. `README.md` — 利用者向けの説明
4. `apps/cmux-team-dispatch-task/CLAUDE.md` — メンテナンス手順に項目を追加

制約:

- `SKILL.md` と `*-ja.md` 以外の `references/*.md` に日本語文字を 1 文字も書かない
  （`node scripts/check-doc-lang.mjs` が hard gate）
- `SKILL.md` / `references/**/*.md` に `cmux send` / `cmux send-key` のリテラルを
  入れない（`test/test-send-prompt-callsites.sh` の CS3）
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

実行後に残骸が無いことも確認する。

```bash
git worktree list
git branch --list 'feat/pg*' 'feat/is*' 'feat/ov*'
```
