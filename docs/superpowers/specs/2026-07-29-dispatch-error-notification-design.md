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
| `error` | 任意 | **`error` と子の message を保持**（上書きしない） | error の握り潰しを禁止する。今回の事故の直接原因 |
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
  4. watcher 自身を終了
- **後始末**: `${CLAUDE_CMD}` から復帰した時点で `kill "$WATCHER_PID"` に続けて **`wait "$WATCHER_PID"`** を実行し、watcher が確実に消滅してから exit パスの処理へ進む
- **marker のライフサイクル**: wrapper 起動時（`${CLAUDE_CMD}` 実行前）に `$STATUS_DIR/.notified-$SLUG` を**削除**する。runner script は pane 起動ごとに 1 回だけ実行されるため、これで世代が分離される

### 4.3 通知 claim の設計（重複通知・訂正通知・送信失敗）

**参加者を 2 つに限定して競合そのものを消す**。exit パスは 4.2 の `kill` + `wait` の後にのみ通知判断を行うため、その時点で watcher は存在しない。check-then-act のレースは「同時に走る参加者がいない」ことで構造的に消える。ロックは導入しない。

`.notified-$SLUG` は空ファイルではなく、**最後に通知に成功した status 文字列**（`done` / `error`）を保持する。判定は存在チェックではなく**内容比較**とする。

```
最終 status != marker の内容  →  通知する（通知成功後に marker を更新）
最終 status == marker の内容  →  スキップする
```

これにより次が保証される。

- watcher が `done` を通知したあと子が非ゼロ終了し、4.1 により最終 status が `error` に確定した場合、marker（`done`）と最終 status（`error`）が食い違うため、exit パスが**訂正の `error` 通知を送る**。存在チェックのみの旧設計はこの訂正を抑止していた
- 同一遷移の二重通知は起こらない
- `$SLUG` は pane ごとに一意（`<task-slug>` / `<task-slug>-sonnet` / `<task-slug>-codex` …）なので、同じ `STATUS_DIR` を共有する別 pane の marker を取り違えることはない

**`notify_parent()` の成否判定**: wake に必要な `cmux send` と `send-key return` を**一組**として扱い、両方成功したときだけ 0 を返す。agmsg `send.sh` は inbox 記録専用で idle な親を起こせないため、その失敗は成否に含めない（警告ログのみ）。現行 `:817-825` はすべて `|| true` で握り潰しているので、ここは戻り値を見る形に変更する。

**送信失敗時**: watcher は 10 秒間隔で最大 3 回リトライする。それでも失敗した場合は **marker を更新せずに** watcher を終了する。marker が更新されないため、exit パスが同じ遷移をもう一度通知しにいく。「watcher が失敗の当事者であるにもかかわらず marker で exit パスの再試行を封じる」ことは起きない。

### 4.4 所有権移譲との整合（H6 / 二重所有）

現行の Phase B 手順は `.assigned-<NAME>` touch → 実行指示送信 → `.deferred` touch の順である（`SKILL.md:748-775`, `:851-859`, `:1281-1310`、CLAUDE.md 項目 13）。watcher を常時走らせると、この間に

- 設計 pane の watcher: `.deferred` が無いため通知可能
- 実装 pane の watcher: `.assigned-$SLUG` があるため通知可能

という二重所有の窓が生じる。exit-only モデルでは設計 pane が `.deferred` 後に exit するため表面化しなかった競合である。

**2 段で塞ぐ**。

1. **スクリプト側**: `DEFER_STATUS=1` の wrapper は、`$SLUG` 以外の `.assigned-*` が存在する時点で「所有権を他 pane へ渡した」と見なして watcher を抑止する（4.2 の新規抑止条件）。`.deferred` の作成を待たない
2. **プロンプト側**: Phase B の手順を「`.assigned` touch → 実行指示送信 → **送信成功を確認** → `.deferred` touch」に変更する。送信に失敗した場合は `.deferred` を作らず、設計 pane が所有者のまま error を報告して停止する

2 により H6（送信失敗後に誰も終端遷移を所有しない窓）は deadline を持ち込まずに解消する。この点について Section 8 の旧判断は誤りだったので撤回し、本設計内で扱う。

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

- Phase B の prewarm 経路でも `<STATUS_DIR>/review/code-review.json`（`{reviewer_surface, reviewer_workspace, review_dir}`）を書く。現行は spawn フォールバックでしか書いていない（`SKILL.md:788-794`, `:1295-1299`）
- runner wrapper の watcher は、terminal status が `error` のときに親通知に加えて、`code-review.json` が存在すればレビュアー surface へ `[abort] <status.json の message>` を `cmux send` + `send-key return` で送る

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
3. **送信が成功したことを確認する**
4. 成功した場合のみ `.deferred` を touch する
5. 失敗した場合は `.deferred` を作らず、`.assigned-<NAME>` を削除し、設計 pane が所有者のまま `status.json` に `error` を書いて親へ通知し停止する

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
- `CLAUDE.md` — ファイル構成表に `docs/notification-gaps.md` を追加。番号付きルールの末尾は現在 **22**（signal 終了ガード）なので、新規ルールは**項目 23** とする（error 時通知の必須化 / 終端 status の sticky 化 / watcher の存在と抑止条件 / marker の内容比較と世代管理 / 通知処理を関数共有すること / Phase B の送信成功確認）

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
  | 3 | `.deferred` あり / 未 assigned standby / 他 pane の `.assigned-*` あり | watcher が発火**しない** |
  | 4 | watcher が `done` 通知後に stub が exit 1 | 最終 `error` が**訂正通知**として親へ届く |
  | 5 | `cmux send` または `send-key` を失敗させる | marker が確定せず、exit パスが同じ遷移を再通知する |
  | 6 | terminal status 書き込み直後、最初の poll 前に signal 終了 | 通知が失われない |
  | 7 | 同一遷移を watcher と exit の双方が観測 | 通知は 1 回だけ |
  | 8 | `.notified-*` が残った status directory で再実行 | 新しい世代として通知される（永久抑止されない） |
  | 9 | wrapper の正常終了・signal 終了の双方 | watcher プロセスが残留しない |

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
| watcher プロセスの残留 | `${CLAUDE_CMD}` 復帰時に `kill` + `wait`。runner script は pane と寿命を共にするため、pane 消滅時も道連れになる。テスト 9 で検証する |
| `done` の sticky 化で、子が `done` を書いた後の失敗を見逃す | exit code ≠ 0 のときは従来どおり `error` を書く（4.1 の表）。見逃すのは「子が done を書き、かつ正常終了した」場合のみで、これは正常系である |
| 4 ファイル整合が崩れる | `CLAUDE.md` 項目 23 として検証手順を明文化し、以後の変更で参照させる |
| watcher が 15 秒ごとに `jq` を起動する負荷 | 1 pane あたり 4 秒に 1 回未満。既存の `monitor-dispatch.sh` は 10 秒間隔で全タスクを走査しており、それより軽い |

