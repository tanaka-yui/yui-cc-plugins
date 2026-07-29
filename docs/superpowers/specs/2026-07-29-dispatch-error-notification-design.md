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

## 4. スクリプト層の設計（`launch-workspace.sh` の runner wrapper）

runner wrapper は `launch-workspace.sh:691-827` の heredoc で生成される。以下 2 点を変更する。

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

既存の signal ガード（`:778-785`）は 4.5 で役割を再定義する（status 上書き抑止のみに限定し、通知可否は 4.3 の marker 比較へ一本化する）。

### 4.2 `status.json` watcher（H4 / H5 の構造的 backstop）

`${CLAUDE_CMD}`（`:743`）の**実行前**にバックグラウンドプロセスとして起動し、`status.json` を定期 poll する。

- **poll 間隔**: 15 秒（`monitor-dispatch.sh` の既定 10 秒より軽くする。人間の体感遅延として十分）
- **発火条件**: `status` が `done` または `error`
- **抑止条件**（exit パスと**同一**の所有権判定を流用する。`.deferred` / `.assigned-*` はセッション実行中に作られるため、**poll のたびに再評価する**）
  - timeout sentinel が存在する（ループモードで `batch-wait.sh` が terminal 化済み）
  - `DEFER_STATUS=1` かつ `$STATUS_DIR/.deferred` が存在する（実行を別 surface へ移譲済み）
  - `STANDBY=1` かつ `$STATUS_DIR/.assigned-$SLUG` が存在しない（実装を引き受けていない standby）
  - `DEFER_STATUS=1` かつ `$SLUG` 以外の `$STATUS_DIR/.assigned-*` が存在する（**新規**。`.assigned` → `.deferred` の窓で設計 pane と実装 pane の watcher が二重所有になるのを防ぐ。4.4 参照）
- **発火時の動作**
  1. `cmux wait-for --signal <slug>-done`
  2. 親通知（`notify_parent()`。4.3 参照）
  3. 通知が**成功したときだけ** `$STATUS_DIR/.notified-$SLUG` に**通知した status 文字列を書き込む**
  4. レビュアー wake（4.7。親通知とは独立した state で、成否は 3 に影響しない）
  5. watcher 自身を終了
- **停止**: 4.3 の協調停止プロトコルによる（`kill` は最後の手段）
- **marker のライフサイクル**: wrapper 起動時（`${CLAUDE_CMD}` 実行前）に `$STATUS_DIR/.notified-$SLUG` と `.notified-reviewer-$SLUG` を**削除**する。runner script は pane 起動ごとに 1 回だけ実行されるため pane 世代はこれで分離される。**dispatch 世代**の分離は 4.8 で別途扱う

### 4.3 通知 claim の設計（重複通知・訂正通知・送信失敗）

**参加者を 2 つに限定し、協調停止で交代する**。exit パスは watcher が自発的に終了したことを確認してから通知判断を行うため、判断時点で同時に走る参加者はいない。check-then-act のレースはこれで構造的に消える。ロックは導入しない。

**協調停止プロトコル**（`kill` で in-flight の副作用を切断しないため）

1. exit パスは `$STATUS_DIR/.stop-watcher-$SLUG` を作成する
2. watcher は**中断可能な境界でのみ**この sentinel を確認する。境界とは「poll ループの先頭」「リトライ待機の前後」であり、`cmux send` → `send-key return` → marker 書き込みの 3 つは**分割しない 1 単位**として扱い、その途中では停止しない
3. exit パスは watcher の終了を最大 30 秒待つ（`wait` をタイムアウト付きで行う）
4. 30 秒経っても終了しない場合のみ `kill` + `wait` する。この状況は通知が失敗し続けている場合に限られ、そのとき marker は未更新なので exit パスが同じ遷移を再送する

これにより round 2 Finding 2 の 2 つの窓が閉じる。

- `cmux send` 成功／`send-key return` 前に中断 → 起きない（分割しない単位のため）。仮に強制 `kill` になった場合も、その時点では通知が 30 秒以上失敗し続けている状況であり、exit パスが `send-key return` の再送から入る（下記「部分配信」参照）
- 配信済みだが marker 未更新で中断 → `kill` 経路でのみ起こり得るが、結果は同一遷移の重複通知であり `SKILL.md:1811-1815` が許容する範囲に収まる

`.notified-$SLUG` は空ファイルではなく、**最後に通知に成功した status 文字列**（`done` / `error`）を保持する。判定は存在チェックではなく**内容比較**とする。

```
最終 status != marker の内容  →  通知する（通知成功後に marker を更新）
最終 status == marker の内容  →  スキップする
```

これにより次が保証される。

- watcher が `done` を通知したあと子が非ゼロ終了し、4.1 により最終 status が `error` に確定した場合、marker（`done`）と最終 status（`error`）が食い違うため、exit パスが**訂正の `error` 通知を送る**。存在チェックのみの旧設計はこの訂正を抑止していた
- `$SLUG` は pane ごとに一意（`<task-slug>` / `<task-slug>-sonnet` / `<task-slug>-codex` …）なので、同じ `STATUS_DIR` を共有する別 pane の marker を取り違えることはない

**保証範囲**: 「同一遷移の二重通知が起こらない」のは **1 つの wrapper 内の watcher と exit パスの間**に限る。子プロンプト自身の必須完了通知（`SKILL.md:566-580`）は marker を更新しないため、システム全体では同一 status の重複通知が従来どおり発生し得る。これは `SKILL.md:1811-1815` が明示的に許容している既存仕様であり、本設計は変更しない。

**`notify_parent()` の成否判定**: wake に必要な `cmux send` と `send-key return` を**一組**として扱い、両方成功したときだけ 0 を返す。agmsg `send.sh` は inbox 記録専用で idle な親を起こせないため、その失敗は成否に含めない（警告ログのみ）。現行 `:817-825` はすべて `|| true` で握り潰しているので、ここは戻り値を見る形に変更する。

**部分配信のリトライ**: `cmux send` が成功して `send-key return` だけ失敗した場合、**`send-key return` のみ**を再送する。文面を再送すると親の input box で連結した prompt になるためである。

**送信失敗時のリトライ**: watcher は**子プロセスが生きている限り、通知に成功するまでリトライを続ける**（10 秒 → 30 秒 → 60 秒でバックオフし 60 秒で頭打ち）。有限回で諦めない理由は、本件の観測事象そのものが「子が exit しない」ケースであり、その状況では exit パスによる再試行が永久に来ないためである。停止は 4.3 の協調停止 sentinel によってのみ行う。

### 4.4 所有権移譲との整合（H6 / 二重所有）

現行の Phase B 手順は `.assigned-<NAME>` touch → 実行指示送信 → `.deferred` touch の順である（`SKILL.md:748-775`, `:851-859`, `:1281-1310`、CLAUDE.md 項目 13）。watcher を常時走らせると、この間に

- 設計 pane の watcher: `.deferred` が無いため通知可能
- 実装 pane の watcher: `.assigned-$SLUG` があるため通知可能

という二重所有の窓が生じる。exit-only モデルでは設計 pane が `.deferred` 後に exit するため表面化しなかった競合である。

**2 段で塞ぐ**。

1. **スクリプト側**: `DEFER_STATUS=1` の wrapper は、`$SLUG` 以外の `.assigned-*` が存在する時点で「所有権を他 pane へ渡した」と見なして watcher を抑止する（4.2 の新規抑止条件）。`.deferred` の作成を待たない
2. **プロンプト側**: Phase B の手順を「`.assigned` touch → 実行指示送信 → **送信成功を確認** → `.deferred` touch」に変更する。送信に失敗した場合は `.deferred` を作らず、設計 pane が所有者のまま error を報告して停止する

2 により H6（送信失敗後に誰も終端遷移を所有しない窓）は deadline を持ち込まずに解消する。この点について Section 8 の旧判断は誤りだったので撤回し、本設計内で扱う。

**前提となる既存バグの修正**: 上記 1 は `DEFER_STATUS=1` を前提にするが、**workspace レイアウトの通常起動は `--defer-status` を渡していない**（`SKILL.md:1464-1474` の起動例、既定値は `launch-workspace.sh:136` の `DEFER_STATUS=0`）。`--defer-status` を渡しているのは `launch-session-splits.sh:208`（split）と `prewarm-panes.sh:312,336`（prewarm 設計ペイン）だけである。

これは watcher とは無関係に**現行でも存在する不整合**である。`SKILL.md:809` は「Child session (THIS surface) was launched with `--defer-status`」と書いているが、prewarm 無効の workspace 起動ではそれが成立せず、Child が `.deferred` を作って exit しても自分の wrapper が `status.json` を上書きしてしまう。

したがって **workspace レイアウトの Child 起動例にも `--defer-status` を追加**する（`SKILL.md` / `guide-ja.md` / `README.md` / `CLAUDE.md` の 4 ファイルと起動テスト）。`DEFER_STATUS` の gate 自体は外せない — 孫（`--mode execute`、`--defer-status` なし）が親 Child の作った `.deferred` を見て自分の status 書き込みを飛ばしてしまうのを防ぐために load-bearing だからである。

### 4.5 signal 終了ガードの再構成

現行の signal ガード（`launch-workspace.sh:778-785`）は `exit>=128` かつ terminal status のとき **status 更新と通知の両方を抑止**して `exit 0` する。watcher 導入後は次の欠落経路が生じる。

1. 子が `error` を書く → 2. 最初の poll 前に子が signal 終了 → 3. wrapper が watcher を kill → 4. signal ガードが通知ごと抑止して exit

これは 4.6 の保証に反する。そこで**「status を上書きしない」と「通知しない」を分離**する。

- signal ガードの役割は **status の上書き抑止のみ**に限定する（4.1 の sticky 規則に吸収される）
- 通知するか否かは **4.3 の marker 内容比較に一本化**する

これにより「最終クリーンアップで pane を閉じただけ（通知済み）」は marker 一致でスキップされ、「未通知のまま signal 終了」は通知される。`test-runner-signal-exit.sh` が守っている「pane close 時に偽 `error` 通知を出さない」性質は、4.1 の sticky 化で status が `done` のまま保たれ、marker も `done` のままなので維持される。

### 4.6 watcher が解決するもの / しないもの

- 解決する: 実装者が `error` を書いて **idle 残留**しても親に届く（H4）。agmsg モードで親に検知手段が無い問題（H5）。プロンプト指示を LLM が無視した場合の backstop（H1 / H2 の実効性）
- 部分的に解決する: レビュアーの解放（H3 / H7）。5.2 の構造的経路で扱う

**実装上の要点**: 通知処理は `notify_parent()` シェル関数に切り出し、watcher と exit パスの**両方から呼ぶ**。片方だけ更新される乖離（CLAUDE.md 項目 21 が扱った退行と同型）を構造的に防ぐため。

### 4.7 レビュアー wake の delivery state（親通知から独立）

5.2 の構造的レビュアー解放は、**親通知とは完全に独立した delivery state** として扱う。

| | 親通知 | レビュアー wake |
|---|---|---|
| marker | `.notified-$SLUG`（内容 = 通知済み status） | `.notified-reviewer-$SLUG`（内容 = 通知済み status） |
| 対象 | terminal status すべて（`done` / `error`） | terminal status が **`error` のときのみ** |
| リトライ | 子が生きている限り無期限（4.3） | 10 秒間隔で最大 3 回 |
| 失敗時 | marker を更新しない（exit パスが引き継ぐ） | marker を更新せず**警告ログのみ**。親通知の成否には影響しない |

**順序**: 親通知 →（成功可否にかかわらず）レビュアー wake。親通知が最優先である。

**相互に妨げないこと**（round 2 Finding 6 の要求）

- レビュアー wake の失敗は親通知の marker を汚さない（別ファイルのため）
- 既に exit 済みのレビュアー surface への送信失敗が、親通知 claim を永久に妨げることはない
- `code-review.json` が存在しない・壊れている・`reviewer_surface` が空のいずれでも、**レビュアー wake をスキップして親通知は成功扱いとする**。レビュアーがそもそも居ない構成（Phase B-R 無効、レビューペイン spawn 失敗）が正常系だからである

**`code-review.json` の整備**: 現行は spawn フォールバックでのみ書かれる（`SKILL.md:796-800` が sonnet 分岐、`:1328-1332` が codex 分岐。`--review-config` の受け渡しは `:792` / `:1326`）。prewarm 経路でも同じ内容を書くようにし、Phase B-R の 6 ケースそれぞれで `reviewer_surface` / `reviewer_workspace` が実際のレビュアーを指すことを検証する（CLAUDE.md 項目 17 の 6 ケース表と対応させる）。

### 4.8 dispatch 世代の初期化

4.2 の marker 削除は **pane 世代**の分離しかしない。同じ `.dispatch/<slug>/` を再利用して**新しい dispatch** を始めると、前回の `status.json`（terminal）・`.assigned-*`・`.deferred`・`review/code-review.json` が残り、次のような誤動作が起こり得る（round 2 Finding 5）。

- 旧 `error` と旧 `.assigned-<slug>-sonnet` が残った状態で sonnet standby を起動すると、wrapper は自分の marker だけ消して旧 assignment を所有権と解釈し、**旧 `error` を即座に通知**する
- 旧 `code-review.json` が残っていると、既に存在しない surface へ `[abort]` を誤送信する

通常はディスパッチ終了時の最終 housekeeping が `.dispatch` を消すため発生しないが、クリーンアップ前に落ちた場合に残る。

**対応**: 親が Step 2 で各タスクを起動する直前に、既存の `.dispatch/<task-slug>/` から `status.json` / `.assigned-*` / `.deferred` / `.notified-*` / `.stop-watcher-*` / `review/code-review.json` を削除する（`mkdir -p` の直後）。ディスパッチディレクトリのライフサイクルは既に親が一元所有しているので、責務の置き場所として自然である。

run ID による世代管理は採らない。参加者すべてに ID を伝播させる必要があり、親が起動直前に初期化するだけで同じ保証が得られるため、過剰実装と判断した。

## 5. プロンプト層の設計

### 5.1 ABORT / ESCALATION プロトコル（H2 の修正）

`SKILL.md` の `{{CODE_REVIEW_BLOCK}}` 内「共通プロトコル a」に追加する。配置は成功パスの (a)(b)（`SKILL.md:1183` 以降）より**上**とし、「これがそれ以外のすべてに優先する」と明記する。停止を決めた時点で必ず読む位置に置くためである。

発動条件は「作業を完了せずに停止すると判断したすべての場合」— blocking error、設計上の矛盾、plan が誤りだという判断、単純な断念を含む。

実行順序（すべて必須）:

1. `<STATUS_DIR>/review/code-round-<現在の N>.md` に理由を書き、**最終行を `VERDICT: needs_work`** にする。レビュー未依頼なら `N=1`。これは**記録**であり、レビュアーはこのファイルを poll していない（`SKILL.md:1221-1225` が明示的に「Do not poll or busy-wait」としている）ため、これ単体ではレビュアーは解放されない。親および後続の調査のための証跡として書く
2. レビュアーへ両チャネルで `[abort] <一行理由>` を送る（`send.sh` による inbox 記録 + `cmux send` + `send-key return`）。**typed の `cmux send` + `send-key return` がレビュアーを実際に起こす唯一の経路**である
3. `status.json` に `status: "error"`、`message` に理由を書く
4. 親へ両チャネルで `[dispatch] task <slug> finished (status: error)` を送る
5. セッション自体を終了する（wrapper の backstop も発火させるため）

**「`status.json` を書くことは通知ではない」**旨を明記する。あのファイルは親だけがポーリングする対象で、待機中のレビュアーには一切届かないためである。

5 の終了指示は **engine 別**に書き分ける（claude は `/exit`、codex は「セッション自体を終了せよ、`/exit` は使うな」）。engine 中立の 1 文にすると CLAUDE.md 項目 21 が防いだ退行を再発させる。

### 5.2 orphan guard の拡張（H3 の修正）

共通プロトコル e（`SKILL.md:1237-1240`）を次のように限定する。

- **現行**: 実装者がレビューを依頼せず終わったら idle のままで acceptable
- **変更後**: 上記は**実装者がレビュー未依頼のまま正常完了した場合のみ**に限定する。`[abort] ...` を受け取った場合は待機を打ち切り、abort 理由を親へ両チャネルで報告してから exit する

**構造的なレビュアー解放（プロンプトに依存しない経路）**

5.1 step 2 は実装者の LLM が指示に従うことを前提にしている。今回の事故はまさにその前提が崩れたケースなので、スクリプト側にも経路を用意する。

- Phase B の prewarm 経路でも `<STATUS_DIR>/review/code-review.json`（`{reviewer_surface, reviewer_workspace, review_dir}`）を書く。現行は spawn フォールバックでしか書いていない（`SKILL.md:796-800` が sonnet 分岐、`:1328-1332` が codex 分岐）
- runner wrapper の watcher は、terminal status が `error` のときに親通知に加えて、`code-review.json` が存在すればレビュアー surface へ `[abort] <status.json の message>` を `cmux send` + `send-key return` で送る。この delivery state は親通知と独立している（4.7）

`cmux send` は**既に使っている通知チャネル**なので、これは新チャネルの発明ではない。Section 8 の旧記述（「外部から起こすと新チャネルになる」）は不正確だったため撤回する。

なおレビュアーが `.deferred` 済みで status を所有しないことは変わらない。watcher が送るのは wake のための typed メッセージだけで、status.json の所有権モデルには触れない。

### 5.3 status protocol の error 分岐（H1 の修正）

`SKILL.md:1394-1395`（Wait and merge）と `:1434-1435`（PR per task）の 2 箇所の error 分岐に、done 分岐と同じ必須完了通知を明記する。`SKILL.md:566-580` の agmsg ブロックが done/error 双方をカバーしていることに依存させず、error 分岐自体を自己完結させる。

### 5.4 spawn 経路の同期（片経路退行の防止）

`launch-workspace.sh` の `REVIEW_INSTRUCTION` / `EXIT_INSTRUCTION`（`:538-573`）にも abort 節を焼き込む。prewarm 経路（親 → standby への `REQUEST_TEXT`）だけを直すと、`--mode execute` の spawn 経路だけ古い挙動が残る。これは CLAUDE.md 項目 21 が扱った「2 経路のうち片方だけ直る」退行と同型である。

### 5.5 無人ループ用文面の同期（N2 の修正）

`apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/unattended/code-review-block.md` に abort 経路の確定文面を追加する。ループモードのプロンプトは `render-loop-prompt.sh` がこのファイルから生成するため、ここを直さないと無人ループでは abort プロトコルが存在しないままになる。

以降この spec では、`references/` で始まる相対パスはすべて `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/` からの相対とする。

### 5.6 Phase B の所有権移譲手順（4.4 のプロンプト側）

Phase B の 3 分岐（sonnet / codex / design=codex の委譲共通手順）すべてで、手順を次の順序に統一する。

1. `.assigned-<NAME>` を touch する
2. 実行指示を送る（`cmux send` + `send-key return`。agmsg 配線が生きていれば inbox 記録も）
3. **各コマンドの成否を確認する**。`cmux send` は成功したが `send-key return` が失敗した場合は、**`send-key return` のみ**を再送する（文面の再送は親／実装ペインの input box で prompt を連結させるため禁止）
4. 両方成功した場合のみ `.deferred` を touch する
5. 最終的に失敗した場合は **`.deferred` を作らず、`.assigned-<NAME>` も削除しない**。設計セッション自身が `status.json` に `error`（message は handoff 失敗の内容）を書き、親へ両チャネルで通知して停止する

**5 で rollback しない理由**（round 2 Finding 4）: `cmux send` が成功した時点で実行指示は実装ペインの input box に載っており、agmsg 記録も残り得る。その後 Enter が何らかの経路で入れば実装が始まってしまうため、`.assigned-<NAME>` を消して所有権を戻すと「実装は進むが誰も所有していない」状態を作る。所有権を残したまま親へ error を報告すれば、

- 実装ペインが結局起動しなかった場合 → 親は既に error を受け取っている
- 実装ペインが遅れて起動して完走した場合 → その wrapper が `status.json` を `done` に上書きし、marker 差分により**訂正通知**が親へ届く（4.3）

のいずれでも安全側に倒れる。重複通知は許容されるが、通知の欠落は許容されない、という本設計の一貫した優先順位に従う。

**spawn フォールバック経路**（`SKILL.md:779-802` sonnet / `:1314-1336` codex / `:868-871` design=codex）には `.assigned-*` が存在しないため、上記の 1・5 は適用しない。代わりに **`launch-workspace.sh` が終了コード 0 を返したときだけ `.deferred` を作る**。失敗時は Child が所有者のまま `error` を書いて親へ通知する。

該当箇所は `SKILL.md:734-796`（sonnet）、`:1242-1310`（codex）、`:841-865`（design=codex の共通委譲手順）である。

## 6. ドキュメントとバージョン

### 6.1 派生パターン一覧（新規ファイル）

`apps/cmux-team-dispatch-task/docs/notification-gaps.md` を新規作成する。

**新規ファイルにする理由**: `CLAUDE.md` は既に 191 行・番号付きルール 22 項目あり、そこへ 10 行規模の表を直接入れると「退行防止ルールの索引」という性格が薄まる。パターン一覧は参照頻度が低く分量が多い資料なので分離し、`CLAUDE.md` からはリンクで参照する。

各行に以下を記載する: パターン ID / 症状 / 根拠 `file:line` / 影響 / 今回の対応（修正 or 記録のみ）/ 判断理由。

### 6.2 4 ファイル整合

`CLAUDE.md` の「ドキュメント整合の絶対ルール」に従い、以下を同期する。

- `SKILL.md` — 5 章の変更本体
- `references/guide-ja.md` — status protocol / Phase B-R / runner wrapper の説明に abort プロトコルと watcher を反映
- `README.md` — 完了通知の説明に「error でも通知される」「exit しなくても通知される」を反映
- `CLAUDE.md` — ファイル構成表に `docs/notification-gaps.md` を追加。番号付きルールの末尾は現在 **22**（signal 終了ガード）なので、新規ルールは**項目 23** とする（error 時通知の必須化 / 終端 status の sticky 化 / watcher の存在と抑止条件 / marker の内容比較・協調停止・世代管理 / 親通知とレビュアー wake の独立性 / 通知処理を関数共有すること / Phase B の送信成否確認と rollback しない契約 / workspace 起動の `--defer-status`）

なお 4.4 の `--defer-status` 追加は起動フラグの変更なので、`SKILL.md` の起動例・`guide-ja.md`・`README.md`・`CLAUDE.md` 項目 11（execute モード関連フラグの整合確認）にも反映する。

### 6.3 バージョン

| ファイル | 現行 | 変更後 | 備考 |
|---|---|---|---|
| `apps/cmux-team-dispatch-task/.claude-plugin/plugin.json` | 1.10.2 | **1.11.0** | watcher は新規の振る舞いを追加するため patch ではなく minor |
| ルート `.claude-plugin/marketplace.json` の該当エントリ | 1.10.2 | **1.11.0** | plugin.json と同期（CLAUDE.md 冒頭の規約） |
| `apps/cmux-team-dispatch-task/.codex-plugin/plugin.json` | 1.3.0 | **1.4.0** | 変更する skill は Codex surface からも参照されるため独立 stream として minor を上げる |
| ルート `.agents/plugins/marketplace.json` | — | 変更なし | エントリに version フィールドが無く、`source.path` によるローカル参照のみのため同期対象外 |

## 7. 検証

- `pnpm check`
- 変更したシェルスクリプトに `bash -n`（`launch-workspace.sh` は zsh で実行されるが heredoc で生成される runner は bash なので、生成物側も構文検査する）
- 既存テストの回帰確認: `test/test-launch-workspace-codex.sh` / `test/test-launch-workspace-review-config.sh` / `test/test-runner-signal-exit.sh`
- **新規** `test/test-runner-terminal-status.sh` — `test-runner-signal-exit.sh` の cmux stub 基盤を流用した**動的**テスト（静的な文言一致では N1 のような挙動バグを検出できないため）。cmux stub は `send` / `send-key` の呼び出しを記録するだけでなく、**指定した回数だけ失敗を返せる**ようにして送信失敗経路を再現する

  | # | シナリオ | 期待 |
  |---|---|---|
  | 1 | `status.json` に `error` を置き stub を exit 0 で終了 | `done` に降格しない。親通知が `status: error` |
  | 2 | stub が終了しないまま `status.json` を `error` にする | watcher が親通知を発火する |
  | 3a | `DEFER_STATUS=1` で自分の `.assigned-$SLUG` のみ | watcher が発火する |
  | 3b | 3a の状態に他 pane の `.assigned-*` を追加 | watcher が発火**しない** |
  | 3c | `.deferred` あり / 未 assigned standby | watcher が発火**しない** |
  | 4 | watcher が `done` 通知後に stub が exit 1 | 最終 `error` が**訂正通知**として親へ届く |
  | 5a | `cmux send` を失敗させたまま stub を exit させる | marker が確定せず、exit パスが同じ遷移を再通知する |
  | 5b | **stub を終了させないまま**最初の数回を失敗させ、その後 stub を成功に戻す | watcher が諦めずリトライを続け、復旧後に通知が届く |
  | 5c | `cmux send` 成功・`send-key` のみ失敗 | 再送されるのは `send-key` のみで、文面は二重送信されない |
  | 6 | terminal status 書き込み直後、最初の poll 前に signal 終了 | 通知が失われない |
  | 7 | stub を `send` と `send-key` の間／`send-key` と marker 更新の間で停止させ、その状態で exit パスと競合させる | 協調停止により通知単位が分割されない。強制 `kill` 経路でも通知が欠落しない |
  | 8 | 旧 `status.json`（terminal）・旧 `.assigned-*`・旧 `.deferred`・旧 `code-review.json`・旧 `.notified-*` が残った directory で再実行 | 親側の初期化（4.8）後は旧状態を通知しない |
  | 9 | wrapper の正常終了・signal 終了の双方 | watcher プロセスが残留しない |
  | 10a | `code-review.json` が有効 / 存在しない / `reviewer_surface` が空 | 前者のみレビュアーへ `[abort]` が飛び、後 2 者はスキップして**親通知は成功扱い** |
  | 10b | レビュアーへの送信のみ失敗させる | 親通知の marker は確定し、レビュアー wake の失敗は警告に留まる |

- 起動フラグの静的検査: `SKILL.md` / `guide-ja.md` / `README.md` の workspace レイアウト起動例に `--defer-status` が含まれること（4.4）。prewarm の各 branch・spawn フォールバックについても `.deferred` 作成条件が仕様どおりであること

- プロンプト文面の静的検査は `test/test-launch-workspace-codex.sh` の既存パターンに倣い、`EXIT_INSTRUCTION` / `REVIEW_INSTRUCTION` に abort 節が含まれ、codex 分岐に `/exit` が混入していないことを検査する

## 8. 今回は修正せず記録に留めるもの

Round 1 レビューを受けて、旧版で除外していた H6 と送信失敗の 2 件は**撤回**し、本設計内で扱うこととした（H6 → 4.4 / 5.6、送信失敗 → 4.3）。またレビュアー解放も「新チャネルの発明」という理由が不正確だったため撤回し、5.2 で構造的経路を用意する。

残る除外は次のとおり。

| パターン | 判断理由 |
|---|---|
| 実装者が沈黙したまま `status.json` すら書かない場合の検知 | terminal 遷移が存在しないため watcher も発火できない。検知には deadline が必要で、それはループモードの `batch-wait.sh`（`--timeout-min`）の責務。通常 dispatch に別のタイムアウト機構を持ち込むのは過剰実装であり、既存の「レビュアー側 15 分 stall 判定」も重複する |
| `agmsg send.sh` 失敗時のリトライ | agmsg push は inbox 記録専用で idle セッションを起こせない（`SKILL.md:1803-1810`）。wake は `cmux send` が担うため、記録の失敗は警告ログに留める |

## 9. リスクと緩和

| リスク | 緩和 |
|---|---|
| watcher が「早すぎる完了通知」を出す（子が `done` を書いた後まだ後処理中） | 現行のプロンプト指示自体が「status.json 書き込み直後に通知せよ」なので挙動は同一。`SKILL.md:1811-1815` が既に「重複通知は正常、status.json を真とする」と定めている。加えて 4.3 の marker 内容比較により、後続で status が `error` に変わった場合は**訂正通知が届く**（旧設計はこれを抑止していた） |
| watcher プロセスの残留 | 協調停止 sentinel → 最大 30 秒待機 → `kill` + `wait`（4.3）。runner script は pane と寿命を共にするため、pane 消滅時も道連れになる。テスト 9 で検証する |
| 通知が失敗し続ける間 watcher が生き続ける | リトライは 60 秒間隔で頭打ちにする。停止は協調停止 sentinel で確実に行え、pane 消滅時は道連れになるため、無限に残ることはない |
| `done` の sticky 化で、子が `done` を書いた後の失敗を見逃す | exit code ≠ 0 のときは従来どおり `error` を書く（4.1 の表）。見逃すのは「子が done を書き、かつ正常終了した」場合のみで、これは正常系である |
| 4 ファイル整合が崩れる | `CLAUDE.md` 項目 23 として検証手順を明文化し、以後の変更で参照させる |
| watcher が 15 秒ごとに `jq` を起動する負荷 | 1 pane あたり 4 秒に 1 回未満。既存の `monitor-dispatch.sh` は 10 秒間隔で全タスクを走査しており、それより軽い |

