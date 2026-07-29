# dispatch の error / abort 時に通知が欠落する問題の設計

対象: `apps/cmux-team-dispatch-task`（基準バージョン v1.10.2 / `origin/main` = `2cafd40`）

## 1. 背景と観測された事象

直近の dispatch で以下が実測された。

- 実装側（codex 実装ペイン）が**コードレビューを一度も依頼せず** `status.json` に `error` を書いて停止した。
- `status.json` は**親が監視するチャネル**であり、レビュアー役の claude セッション宛ではないため、レビュアーには何も届かなかった。
- レビュアー宛のチャネル（`cmux send --surface` / agmsg inbox）には何も届かず、`review/code-round-1.md` も生成されなかった。
- 実装自体は 11 コミット完了し、typecheck / build もすべて通過していた。**PR 作成の直前で止まっていた**。
- つまり「レビューで止められた」のではなく、**実装者が自己判断で設計上の矛盾を見つけ、レビューに出す前にエスカレーションした**状態だった。

結果として、待っている全員（親セッション・round loop で待機中のレビュアー）が無期限に待ち続け、dispatch 全体が宙吊りになった。

## 2. 調査で確定した事実

### 2.1 ワークツリーのベースずれ（前提の訂正）

本タスクの worktree は `4f9679a` / plugin v1.8.2 を基準に作られていたが、`origin/main` は `2cafd40` / v1.10.2 で 42 コミット先行していた（`git rev-list --count 4f9679a..origin/main` = 42）。差分には本件と隣接する `ac6aecc「Phase B-R 有効時に完了通知が届かない不具合を修正」` が含まれる。

調査・設計・実装はすべて **v1.10.2 を基準**とする（ブランチは `origin/main` へ fast-forward 済み）。`ac6aecc` により**成功パスの完了通知は修正済み**であり、本設計が扱うのは **error / abort パス**である。

### 2.2 仮説の検証結果

| # | 仮説 | 判定 | 根拠 |
|---|------|------|------|
| H1 | error 分岐に完了通知が複製されていない | **一部 true** | `SKILL.md:1394-1395, 1434-1435` の error 分岐は `status.json` 書き込みのみ。ただし agmsg モードでは `SKILL.md:566-580` の必須通知が done/error 双方を明記しており、**設計 Child 自身は救われている** |
| H2 | 共通プロトコル a は成功パスの通知しか定義していない | **true（本命）** | `SKILL.md:1183`「After the PR is created …」以降にのみ (a)(b) が存在。さらに `SKILL.md:1185-1187, 1215-1216` が「standby は task prompt を読んでいないため他の status protocol は適用されない」と明記しており、実装者に error 経路の通知手段が構造的に存在しない |
| H3 | レビュアーの orphan guard が実装者 error 時に永久 idle になる | **true** | `SKILL.md:1237-1240`「if the implementer finishes without ever requesting a review, you simply stay idle — that is acceptable」 |
| H4 | codex が error 自己停止時にセッションを終了せず wrapper backstop が発火しない | **true** | 終了指示は成功パスにのみ存在（`SKILL.md:1197-1201`）。wrapper は `launch-workspace.sh:743-744` で子プロセスを待ってブロックするため、idle 残留＝通知に到達しない |
| H5 | agmsg モードでは親側に沈黙検知手段が無い | **true** | `SKILL.md:1803-1815`。monitor 非起動。「長時間来なければ手動 poll」とあるが、**idle な親を poll に向かわせる契機が存在しない** |
| H6 | `.assigned` / `.deferred` の組合せで誰も終端遷移を所有しない状態があり得る | **狭い範囲で true** | `launch-workspace.sh:758-770` の所有権判定自体は健全。ただし Phase B 手順が「`.assigned` touch → 指示送信 → `.deferred` touch」であり、**送信が失敗しても `.deferred` が打たれる**ため、実装者が起動しないまま誰も終端遷移しない窓が残る |
| H7 | 待機ループの stall 判定が error idle を検知できない | **true、かつ想定より悪い** | 15 分 stall 判定は**実装者 → レビュアー待ち**（`SKILL.md:1153-1172`）にのみ存在。**レビュアー側の待機（`SKILL.md:1221-1240`）には stall 検知が一切無い**（無期限 idle） |

### 2.3 H1–H7 に無かった新規パターン

#### N1: runner wrapper が子の書いた `error` を `done` に上書きする（二次欠陥）

**位置づけ**: N1 は今回の観測事象の**直接原因ではない**。codex が idle 残留している間、wrapper は `launch-workspace.sh:743` の子プロセス待ちでブロックしており `:787-791` に到達しないためである。N1 が顕在化するのは「子が `error` を書いた**うえで正常終了した**」場合であり、本設計が 5.1 で追加する ABORT プロトコル（`error` を書いてセッションを終了する）を通すと**必ず**その経路を通る。つまり N1 は、本設計の修正そのものを無効化する**二次欠陥**である。

`launch-workspace.sh:787-791`:

```bash
if [[ $CLAUDE_EXIT -eq 0 ]]; then
  write_status "done" "Claude session completed (exit 0)"   # PREV_STATUS を参照していない
else
  write_status "error" "Claude session exited with code $CLAUDE_EXIT"
fi
```

親通知の `STATUS_LABEL` も `launch-workspace.sh:805-808` で **`CLAUDE_EXIT` から導出**されており、`status.json` を参照しない。signal 終了（`>=128`）には `PREV_STATUS` ガード（`:778-785`）があるのに、**正常終了パスには無い**。

したがって「status.json に error を書いてセッションを終える」という abort プロトコルを追加しても、**wrapper が `done` に握り潰す**。N1 を直さない限り、5 章の修正が無効化される。

#### N2: 無人ループ用の確定文面に abort 経路が無い

`apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/unattended/code-review-block.md` と同ディレクトリの `review-block.md` は stall 時の再依頼と「Do not ask a human question」しか定めておらず、実装者が abort した場合の記述が無い。

## 3. 設計方針

「通知は**セッション終了**に依存する」という現行の唯一の構造的経路を、「通知は **`status.json` の終端遷移**に依存する」へ変える。プロンプト指示は補助（abort 理由の伝達とレビュアーの解放）に降格させる。

```
         [従来]                              [変更後]
 子が exit ─→ wrapper ─→ 親通知      status.json が terminal ─→ watcher ─→ 親通知
   ↑ idle 残留で断絶                        ↑ exit しなくても発火
                                     子が exit ─→ wrapper ─→ 親通知（既存・重複可）
```

制約として、**新しい通知チャネルは発明しない**。既存の 2 チャネル（agmsg `send.sh` による inbox 記録 + `cmux send` / `send-key return` による wake）を error パスにも確実に通すだけとする。既存の設計思想（親が cleanup を一元所有する / 子は破壊的操作をしない / agmsg push は idle セッションを起こせない）も変更しない。

### 3.1 スコープの確定（レビュー 4 往復を経ての判断）

本設計は codex レビューと 4 往復した。その過程で「`cmux send` の上に exactly-once に近い配信を作る」方向へ設計が膨らみ、往復ごとに新しい欠陥が生まれた（round 3 で導入した `timeout 10 cmux …` は、対象 macOS に `timeout` / `gtimeout` が存在しないため**全通知を失敗させる**致命的欠陥だった）。

そこで**スコープを次のコアに確定**する。

| 含める | 含めない（8 章に未解決として記録） |
|---|---|
| 終端 status の sticky 化（4.1） | handoff 失敗時の transactional な所有権移譲 |
| exit に依存しない親通知（4.2 / 4.3） | 配信 phase の永続化による exactly-once 配信 |
| 所有権の二重化防止と `--defer-status` の欠落修正（4.4） | `cmux` コマンドの timeout / hang 対策 |
| signal ガードは現行維持（4.5） | dispatch 世代の PID 排他制御 |
| レビュアー wake（best-effort。4.6） | 沈黙する実装者の deadline 検知 |
| プロンプト層の ABORT プロトコル（5 章） | |

**判断根拠**: 除外した項目が指摘する配信の弱さ（部分配信・連結・hang）は、**現行コードに既に存在する**。現行の exit パスは `cmux send … || true` を 1 回試すだけでリトライも成否確認も無い（`launch-workspace.sh:817-825`）。本設計はそこにリトライと exit 非依存の発火を足すだけなので、**どの失敗モードも現行より悪化しない**。一方、除外した機能は cmux 側の配信保証に踏み込むもので、このスキルの責務を超える。

したがって本設計が主張する保証は次の 1 点に絞る。

> **子が `status.json` に終端状態を書けば、セッションが終了しなくても、親への通知が試みられ続ける。**

「必ず届く」ではなく「試み続ける」である。届かない場合の残余リスクは 8 章に列挙する。

## 4. スクリプト層の設計（`launch-workspace.sh` の runner wrapper）

runner wrapper は `launch-workspace.sh:691-827` の heredoc で生成される。

### 4.1 終端 status の sticky 化（N1 の修正）

`:787-791` を、既に `:778-781` で取得済みの `PREV_STATUS` を参照する形に変更する。

| `PREV_STATUS` | exit code | 結果 | 理由 |
|---|---|---|---|
| `error` | 任意 | **`error` と子の message を保持**（上書きしない） | error の握り潰しを禁止する。2.3 N1 のとおり本設計の ABORT プロトコルは必ずこの経路を通る |
| `done` | 0 | **`done` と子の message を保持** | 子が書いた変更サマリを `Claude session completed (exit 0)` で潰さない |
| `done` | ≠0 | `error` を書く（現行どおり） | done 宣言後のクラッシュは保守的に error 扱いとし、親に調査させる |
| それ以外 | 0 | `done` を書く（現行どおり） | |
| それ以外 | ≠0 | `error` を書く（現行どおり） | |

親通知の `STATUS_LABEL`（`:805-808`）は `CLAUDE_EXIT` からではなく、**上表で確定した status から導出**する。

### 4.2 `status.json` watcher（H4 / H5 の構造的 backstop）

`${CLAUDE_CMD}`（`:743`）の**実行前**にバックグラウンドプロセスとして起動し、`status.json` を 15 秒間隔で poll する。

**抑止条件**（exit パスと同一の所有権判定を流用。`.deferred` / `.assigned-*` はセッション実行中に作られるため poll のたびに再評価する）

- timeout sentinel が存在する（ループモードで `batch-wait.sh` が terminal 化済み）
- `DEFER_STATUS=1` かつ `$STATUS_DIR/.deferred` が存在する
- `STANDBY=1` かつ `$STATUS_DIR/.assigned-$SLUG` が存在しない
- `DEFER_STATUS=1` かつ `$SLUG` 以外の `$STATUS_DIR/.assigned-*` が存在する（**新規**。4.4 参照）

**発火**: status が `done` / `error` で、かつ marker の内容と異なるとき。

**marker のライフサイクル**: wrapper 起動時（`${CLAUDE_CMD}` 実行前）に `$STATUS_DIR/.notified-$SLUG` / `.notified-reviewer-$SLUG` / `.stop-watcher-$SLUG` を削除する。runner script は pane 起動ごとに 1 回だけ実行されるため、これで pane 世代が分離される。

### 4.3 通知 claim とリトライ

`.notified-$SLUG` は空ファイルではなく、**最後に通知に成功した status 文字列**を保持する。判定は存在チェックではなく**内容比較**とする。

```
最終 status != marker の内容  →  通知する（成功後に marker を更新）
最終 status == marker の内容  →  スキップする
```

これにより、watcher が `done` を通知した後に 4.1 で最終 status が `error` に確定した場合、exit パスが**訂正の `error` 通知**を送る。

**`notify_parent()` の成否判定**: wake に必要な `cmux send` と `send-key return` を一組として扱い、両方成功したときだけ 0 を返す。agmsg `send.sh` は inbox 記録専用で idle な親を起こせないため、その失敗は成否に含めない（警告ログのみ）。現行 `:817-825` はすべて `|| true` で握り潰しているので、戻り値を見る形に変更する。

**リトライ**: 失敗しても marker を更新しない。watcher は**次の poll（15 秒後）に同じ判定へ戻る**ので、子が生きている限り再試行が続く。専用のバックオフループや phase ファイルは持たない — 再試行の単位を poll 周期に一致させることで、状態は marker 1 つで済み、強制中断されても次の poll が引き継ぐ。

**部分配信について**: `cmux send` が成功して `send-key return` が失敗した場合、次の poll では文面から送り直される。これは相手の input box で文面が連結し得るが、**現行の exit パスと同じ挙動**であり（現行はそもそも 1 回も再試行しない）、本設計はここを改善対象としない。8 章に記録する。

**停止**: exit パスは `$STATUS_DIR/.stop-watcher-$SLUG` を作成し、watcher の終了を最大 20 秒待ってから `kill` + `wait` する。watcher は poll ループの先頭で sentinel を確認する。強制 `kill` になった場合の最悪ケースは同一遷移の重複通知であり、`SKILL.md:1811-1815` が明示的に許容している。

**保証範囲**: 「同一遷移の二重通知が起こらない」のは 1 つの wrapper 内の watcher と exit パスの間に限る。子プロンプト自身の必須完了通知（`SKILL.md:566-580`）は marker を更新しないため、システム全体では同一 status の重複通知が従来どおり発生し得る。

### 4.4 所有権の二重化防止と `--defer-status` の欠落

Phase B の手順は `.assigned-<NAME>` touch → 実行指示送信 → `.deferred` touch の順である（`SKILL.md:740-802`, `:1275-1336`, `:837-871`、CLAUDE.md 項目 13）。watcher を常時走らせると、この間に設計 pane と実装 pane の watcher が同時に通知可能になる。

**対応**: `DEFER_STATUS=1` の wrapper は、`$SLUG` 以外の `.assigned-*` が存在する時点で「所有権を他 pane へ渡した」と見なして watcher を抑止する。`.deferred` の作成を待たない。

**前提となる既存バグの修正**: 上記は `DEFER_STATUS=1` を前提にするが、**workspace レイアウトの通常起動は `--defer-status` を渡していない**（`SKILL.md:1464-1474` の起動例、既定値は `launch-workspace.sh:136` の `DEFER_STATUS=0`）。渡しているのは `launch-session-splits.sh:208`（split）と `prewarm-panes.sh:312,336`（prewarm 設計ペイン）だけである。

これは watcher とは無関係に**現行でも存在する不整合**である。`SKILL.md:809` は「Child session (THIS surface) was launched with `--defer-status`」と書いているが、prewarm 無効の workspace 起動ではそれが成立せず、Child が `.deferred` を作って exit しても自分の wrapper が `status.json` を上書きしてしまう。

したがって **workspace レイアウトの Child 起動例にも `--defer-status` を追加**する。`DEFER_STATUS` の gate 自体は外せない — 孫（`--mode execute`、`--defer-status` なし）が親 Child の作った `.deferred` を見て自分の status 書き込みを飛ばしてしまうのを防ぐために load-bearing だからである。

**Phase B の手順自体は変更しない**。round 2〜4 で検討した「送信成否による所有権移譲の契約」は、`cmux send` の終了コードが配信の有無を一意に示さないため安全に定義できないことが判明した（round 4 Finding 1・2）。8 章に未解決として記録する。

### 4.5 signal 終了ガードは変更しない

現行の signal ガード（`launch-workspace.sh:778-785`）は `exit>=128` かつ terminal status のとき status 更新と通知の両方を抑止して `exit 0` する。当初はこれを「status 上書き抑止のみ」に限定し、通知可否を marker 比較へ一本化する案だったが、**既存の回帰テストを壊す**ことが判明したため採用しない。

`test/test-runner-signal-exit.sh` の S1（`test-runner-signal-exit.sh:97-100`）は「`done` の pane を最終クリーンアップで close したとき、status を降格せず**親通知も送らない**」ことを検証している。marker は wrapper 起動時に削除されるため（4.2）、通知可否を marker 比較だけに委ねると marker 未設定 → 通知あり、となり S1 が失敗する。

この抑止は妥当でもある。`PREV_STATUS` が terminal ということは、子が生存中に終端状態を書いたということであり、通知責任は既にその時点の書き手（子自身の必須通知、または本設計の watcher）にある。クリーンアップ時に全 pane が改めて通知すると、親は終了直前に重複通知の束を受け取ることになる。

**したがってガードはそのまま残す**。4.1 の sticky 化により status 降格はいずれにせよ起きなくなるので、ガードの status 抑止部分は冗長になるが無害である。

残る窓（子が終端状態を書いた直後、最初の poll 前に signal 終了した場合にこの wrapper からは通知されない）は 8 章 U8 として記録する。現行と同じ挙動であり、悪化はしない。

### 4.6 レビュアー wake（best-effort）

terminal status が `error` のとき、watcher は親通知に加えてレビュアー surface へ `[abort] <status.json の message>` を送る。

- 対象は `<STATUS_DIR>/review/code-review.json` が存在し `reviewer_surface` が読める場合のみ。存在しない・壊れている・空のいずれでも**スキップし、親通知は成功扱いとする**（レビュアーが居ない構成が正常系のため）
- 専用 marker `.notified-reviewer-$SLUG` を持ち、親通知の marker とは独立する。失敗しても親通知の claim を妨げない
- リトライは親通知と同じく poll 周期で継続する
- prewarm 経路でも `code-review.json` を書くようにする。現行は spawn フォールバックでのみ書かれる（`SKILL.md:796-800` sonnet / `:1328-1332` codex）

**保証の水準**: これは best-effort である。`cmux send` が届かない状況ではレビュアーは解放されない。プロンプト層（5.1 step 2）の `[abort]` typed 送信が主経路であり、本項はそれを LLM が実行しなかった場合の補助にすぎない。

### 4.7 watcher が解決するもの / しないもの

- 解決する: 実装者が `error` を書いて **idle 残留**しても親への通知が試みられ続ける（H4 / H5）。プロンプト指示を LLM が無視した場合の backstop（H1 / H2 の実効性）
- 部分的に解決する: レビュアーの解放（H3）。4.6 のとおり best-effort
- 解決しない: 実装者が `status.json` すら書かずに沈黙する場合（H7 の残り）。terminal 遷移が無いので発火条件を満たさない

**実装上の要点**: 通知処理は `notify_parent()` シェル関数に切り出し、watcher と exit パスの**両方から呼ぶ**。片方だけ更新される乖離（CLAUDE.md 項目 21 が扱った退行と同型）を構造的に防ぐため。

## 5. プロンプト層の設計

以降 `references/` で始まる相対パスは `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/` からの相対とする。

### 5.1 ABORT / ESCALATION プロトコル（H2 の修正）

`SKILL.md` の `{{CODE_REVIEW_BLOCK}}` 内「共通プロトコル a」に追加する。配置は成功パスの (a)(b)（`SKILL.md:1183` 以降）より**上**とし、「これがそれ以外のすべてに優先する」と明記する。停止を決めた時点で必ず読む位置に置くためである。

発動条件は「作業を完了せずに停止すると判断したすべての場合」— blocking error、設計上の矛盾、plan が誤りだという判断、単純な断念を含む。

実行順序（すべて必須）:

1. `<STATUS_DIR>/review/code-round-<現在の N>.md` に理由を書き、**最終行を `VERDICT: needs_work`** にする。レビュー未依頼なら `N=1`。これは**記録**であり、レビュアーはこのファイルを poll していない（`SKILL.md:1221-1225` が明示的に「Do not poll or busy-wait」としている）ため、これ単体ではレビュアーは解放されない
2. レビュアーへ両チャネルで `[abort] <一行理由>` を送る。**typed の `cmux send` + `send-key return` がレビュアーを実際に起こす唯一の経路**である
3. `status.json` に `status: "error"`、`message` に理由を書く
4. 親へ両チャネルで `[dispatch] task <slug> finished (status: error)` を送る
5. セッション自体を終了する（wrapper の backstop も発火させるため）

**「`status.json` を書くことは通知ではない」**旨を明記する。あのファイルは親だけがポーリングする対象で、待機中のレビュアーには一切届かないためである。

5 の終了指示は **engine 別**に書き分ける（claude は `/exit`、codex は「セッション自体を終了せよ、`/exit` は使うな」）。engine 中立の 1 文にすると CLAUDE.md 項目 21 が防いだ退行を再発させる。

### 5.2 orphan guard の拡張（H3 の修正）

共通プロトコル e（`SKILL.md:1237-1240`）を次のように限定する。

- **現行**: 実装者がレビューを依頼せず終わったら idle のままで acceptable
- **変更後**: 上記は**実装者がレビュー未依頼のまま正常完了した場合のみ**に限定する。`[abort] ...` を受け取った場合は待機を打ち切り、abort 理由を親へ両チャネルで報告してから exit する

### 5.3 status protocol の error 分岐（H1 の修正）

`SKILL.md:1394-1395`（Wait and merge）と `:1434-1435`（PR per task）の 2 箇所の error 分岐に、done 分岐と同じ必須完了通知を明記する。`SKILL.md:566-580` の agmsg ブロックが done/error 双方をカバーしていることに依存させず、error 分岐自体を自己完結させる。

### 5.4 spawn 経路の同期（片経路退行の防止）

`launch-workspace.sh` の `REVIEW_INSTRUCTION` / `EXIT_INSTRUCTION`（`:538-573`）にも abort 節を焼き込む。prewarm 経路（親 → standby への `REQUEST_TEXT`）だけを直すと `--mode execute` の spawn 経路だけ古い挙動が残る。CLAUDE.md 項目 21 が扱った「2 経路のうち片方だけ直る」退行と同型である。

### 5.5 無人ループ用文面の同期（N2 の修正）

`references/unattended/code-review-block.md` に abort 経路の確定文面を追加する。ループモードのプロンプトは `render-loop-prompt.sh` がこのファイルから生成するため、ここを直さないと無人ループでは abort プロトコルが存在しないままになる。

## 6. ドキュメントとバージョン

### 6.1 派生パターン一覧（新規ファイル）

`apps/cmux-team-dispatch-task/docs/notification-gaps.md` を新規作成する。

**新規ファイルにする理由**: `CLAUDE.md` は既に 191 行・番号付きルール 22 項目あり、そこへこの規模の表を直接入れると「退行防止ルールの索引」という性格が薄まる。パターン一覧は参照頻度が低く分量が多い資料なので分離し、`CLAUDE.md` からはリンクで参照する。

各行に以下を記載する: パターン ID / 症状 / 根拠 `file:line` / 影響 / 今回の対応（修正 or 記録のみ）/ 判断理由。**8 章の未解決パターンもすべてここに転記する** — codex レビュー 4 往復で判明した配信保証の限界は、本タスクの成果物 2（派生パターンの洗い出し）そのものである。

### 6.2 4 ファイル整合

`CLAUDE.md` の「ドキュメント整合の絶対ルール」に従い、以下を同期する。

- `SKILL.md` — 5 章の変更本体
- `references/guide-ja.md` — status protocol / Phase B-R / runner wrapper の説明に abort プロトコルと watcher を反映
- `README.md` — 完了通知の説明に「error でも通知される」「exit しなくても通知が試みられる」を反映
- `CLAUDE.md` — ファイル構成表に `docs/notification-gaps.md` を追加。番号付きルールの末尾は現在 **22**（signal 終了ガード）なので、新規ルールは**項目 23** とする（error 時通知の必須化 / 終端 status の sticky 化 / watcher の存在と抑止条件 / marker の内容比較 / 親通知とレビュアー wake の marker 分離 / 通知処理を関数共有すること / workspace 起動の `--defer-status`）

`--defer-status` の追加は起動フラグの変更なので、`CLAUDE.md` 項目 11（execute モード関連フラグの整合確認）にも反映する。

### 6.3 バージョン

| ファイル | 現行 | 変更後 | 備考 |
|---|---|---|---|
| `apps/cmux-team-dispatch-task/.claude-plugin/plugin.json` | 1.10.2 | **1.11.0** | watcher は新規の振る舞いを追加するため patch ではなく minor |
| ルート `.claude-plugin/marketplace.json` の該当エントリ | 1.10.2 | **1.11.0** | plugin.json と同期（CLAUDE.md 冒頭の規約） |
| `apps/cmux-team-dispatch-task/.codex-plugin/plugin.json` | 1.3.0 | **1.4.0** | 変更する skill は Codex surface からも参照されるため独立 stream として minor を上げる |
| ルート `.agents/plugins/marketplace.json` | — | 変更なし | エントリに version フィールドが無く `source.path` によるローカル参照のみのため同期対象外 |

## 7. 検証

- `pnpm check`
- 変更したシェルスクリプトに `bash -n`（`launch-workspace.sh` は zsh で実行されるが、heredoc で生成される runner は bash なので生成物側も構文検査する）
- 既存テストの回帰確認: `test/test-launch-workspace-codex.sh` / `test/test-launch-workspace-review-config.sh` / `test/test-runner-signal-exit.sh`
- **新規** `test/test-runner-terminal-status.sh` — `test-runner-signal-exit.sh` の cmux stub 基盤を流用した**動的**テスト（静的な文言一致では N1 のような挙動バグを検出できないため）。stub は `send` / `send-key` を記録するだけでなく、**指定回数だけ失敗を返せる**ようにする

  | # | シナリオ | 期待 |
  |---|---|---|
  | 1 | `status.json` に `error` を置き stub を exit 0 で終了 | `done` に降格しない。親通知が `status: error` |
  | 2 | stub が終了しないまま `status.json` を `error` にする | watcher が親通知を発火する |
  | 3a | `DEFER_STATUS=1` で自分の `.assigned-$SLUG` のみ | watcher が発火する |
  | 3b | 3a に他 pane の `.assigned-*` を追加 | watcher が発火**しない** |
  | 3c | `.deferred` あり / 未 assigned standby | watcher が発火**しない** |
  | 4 | watcher が `done` 通知後に stub が exit 1 | 最終 `error` が**訂正通知**として親へ届く |
  | 5 | stub を終了させないまま最初の数回の `send` を失敗させ、その後成功に戻す | watcher が諦めず、復旧後に通知が届く |
  | 6 | terminal status 書き込み直後、最初の poll 前に signal 終了 | 既存 S1 と同じく status は保持され通知は送られない（U8 として既知。現行と同挙動） |
  | 7 | 同一遷移を watcher と exit の双方が観測 | 通知は 1 回だけ |
  | 8 | `.notified-*` が残った status directory で再実行 | wrapper 起動時に削除され、新しく通知される |
  | 9 | wrapper の正常終了・signal 終了の双方 | watcher プロセスが残留しない |
  | 10 | `code-review.json` が有効 / 存在しない / `reviewer_surface` が空 | 前者のみ `[abort]` が飛び、後 2 者はスキップして**親通知は成功扱い** |
  | 11 | レビュアーへの送信だけを失敗させる | 親通知の marker は確定し、レビュアー wake は次の poll で再試行される |

- 起動フラグの静的検査: `SKILL.md` / `guide-ja.md` / `README.md` の workspace レイアウト起動例に `--defer-status` が含まれること（4.4）
- プロンプト文面の静的検査: `test/test-launch-workspace-codex.sh` の既存パターンに倣い、`EXIT_INSTRUCTION` / `REVIEW_INSTRUCTION` に abort 節が含まれ、codex 分岐に `/exit` が混入していないこと
- **`timeout` / `gtimeout` に依存しないこと**を確認する（対象 macOS に存在しない。round 4 Finding 4）

## 8. 未解決として記録するパターン

以下は本設計では解決しない。すべて `docs/notification-gaps.md` に根拠付きで転記する。

| # | パターン | 根拠 | 判断理由 |
|---|---|---|---|
| U1 | 実装者が `status.json` すら書かず沈黙する | 2.2 H7、`SKILL.md:1153-1172` と `:1221-1240` | terminal 遷移が無いので watcher も発火できない。検知には deadline が必要で、それを持つのはループモードの `batch-wait.sh --timeout-min` だけ。**通常 dispatch では親もレビュアーも無期限に待つ**（15 分 stall 判定は実装者 → レビュアー方向にしか無い） |
| U2 | handoff 失敗時の所有権移譲 | round 4 Finding 1、`SKILL.md:751-774` ほか | `cmux send` の終了コードは配信の有無を一意に示さない。agmsg 記録は `cmux send` より**先**に行われるため「送信失敗＝何も届いていない」とは言えない。安全な rollback 条件を定義できないので、Phase B の手順は現行のまま据え置く |
| U3 | spawn フォールバックの起動確認 | round 4 Finding 2、`launch-workspace.sh:865-881`, `:90` | `new-workspace --command` が runner を起動した**後**に rename / surface 取得 / status 生成が失敗し得るため、非ゼロ終了は「未起動」を意味しない。runner 側の起動 acknowledgement が必要だが本設計の範囲外 |
| U4 | 部分配信（`send` 成功・`send-key` 失敗）による input box での文面連結 | round 4 Finding 5、`launch-workspace.sh:817-825` | 現行も 1 回きりの `\|\| true` で同じ問題を持つ。安全な回復には「相手の input box を壊さずに outcome 不明を解消する cmux 操作」が要るが、それは cmux 側の機能である |
| U5 | `cmux` コマンドの hang | round 4 Finding 4 | 対象 macOS に `timeout` / `gtimeout` が無い。`perl -e alarm` 等の代替は可能だが、外部依存を増やす割に現行より改善しないため見送る |
| U6 | dispatch 世代の排他（旧 wrapper 生存・stale PID 再利用） | round 4 Finding 6 | `kill -0` による PID 検査は TOCTOU と PID 再利用に耐えない。正しくは親側の排他 lock と generation token が要るが、通常は最終 cleanup が `.dispatch` を消すため発生頻度が低い |
| U7 | agmsg `send.sh` 失敗時のリトライ | `SKILL.md:1803-1810` | agmsg push は inbox 記録専用で idle セッションを起こせない。wake は `cmux send` が担うため、記録の失敗は警告ログに留める |
| U8 | 終端状態を書いた直後・最初の poll 前に signal 終了すると、この wrapper からは通知されない | 4.5、`launch-workspace.sh:778-785`、`test/test-runner-signal-exit.sh:97-100` | signal ガードの通知抑止は既存の回帰テストが守っている挙動。窓は最大 15 秒で、現行と同じ挙動のため悪化しない |

## 9. リスクと緩和

| リスク | 緩和 |
|---|---|
| watcher が「早すぎる完了通知」を出す（子が `done` を書いた後まだ後処理中） | 現行のプロンプト指示自体が「status.json 書き込み直後に通知せよ」なので挙動は同一。`SKILL.md:1811-1815` が「重複通知は正常、status.json を真とする」と定めている。4.3 の marker 内容比較により、後続で `error` に変わった場合は訂正通知が届く |
| watcher プロセスの残留 | 協調停止 sentinel → 最大 20 秒待機 → `kill` + `wait`。runner script は pane と寿命を共にするため pane 消滅時も道連れになる。テスト 9 で検証 |
| `done` の sticky 化で、子が `done` を書いた後の失敗を見逃す | exit code ≠ 0 のときは従来どおり `error` を書く（4.1 の表）。見逃すのは「子が done を書き、かつ正常終了した」場合のみで、これは正常系である |
| 4 ファイル整合が崩れる | `CLAUDE.md` 項目 23 として検証手順を明文化し、以後の変更で参照させる |
| watcher が 15 秒ごとに `jq` を起動する負荷 | 既存の `monitor-dispatch.sh` は 10 秒間隔で全タスクを走査しており、それより軽い |
| 8 章の未解決パターンが忘れられる | `docs/notification-gaps.md` に根拠付きで残し、`CLAUDE.md` から参照する |
