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

本タスクの worktree は `4f9679a` / plugin v1.8.2 を基準に作られていたが、`origin/main` は `2cafd40` / v1.10.2 で 43 コミット先行していた。差分には本件と隣接する `ac6aecc「Phase B-R 有効時に完了通知が届かない不具合を修正」` が含まれる。

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

#### N1: runner wrapper が子の書いた `error` を `done` に上書きする（最重要）

`launch-workspace.sh:787-791`:

```bash
if [[ $CLAUDE_EXIT -eq 0 ]]; then
  write_status "done" "Claude session completed (exit 0)"   # PREV_STATUS を参照していない
else
  write_status "error" "Claude session exited with code $CLAUDE_EXIT"
fi
```

親通知の `STATUS_LABEL` も `launch-workspace.sh:805-808` で **`CLAUDE_EXIT` から導出**されており、`status.json` を参照しない。signal 終了（`>=128`）には `PREV_STATUS` ガード（`:778-785`）があるのに、**正常終了パスには無い**。

したがって「status.json に error を書いてセッションを終える」という abort プロトコルを追加しても、**wrapper が `done` に握り潰す**。N1 を直さない限り、他のすべての修正が無効化される。

#### N2: 無人ループ用の確定文面に abort 経路が無い

`references/unattended/code-review-block.md` と `review-block.md` は stall 時の再依頼と「Do not ask a human question」しか定めておらず、実装者が abort した場合の記述が無い。

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

既存の signal ガード（`:778-785`）はそのまま残す。役割が異なるためである（あちらは「終端 status 到達後に pane を閉じられた場合、通知そのものを抑止する」）。

### 4.2 `status.json` watcher（H4 / H5 の構造的 backstop）

`${CLAUDE_CMD}`（`:743`）の**実行前**にバックグラウンドプロセスとして起動し、`status.json` を定期 poll する。

- **poll 間隔**: 15 秒（`monitor-dispatch.sh` の既定 10 秒より軽くする。人間の体感遅延として十分）
- **発火条件**: `status` が `done` または `error`
- **抑止条件**（exit パスと**同一**の所有権判定を流用する。`.deferred` / `.assigned-*` はセッション実行中に作られるため、**poll のたびに再評価する**）
  - timeout sentinel が存在する（ループモードで `batch-wait.sh` が terminal 化済み）
  - `DEFER_STATUS=1` かつ `$STATUS_DIR/.deferred` が存在する（実行を別 surface へ移譲済み）
  - `STANDBY=1` かつ `$STATUS_DIR/.assigned-$SLUG` が存在しない（実装を引き受けていない standby）
- **発火時の動作**（exit パスと同順）
  1. `cmux wait-for --signal <slug>-done`
  2. 親通知（agmsg `send.sh` による inbox 記録 + `cmux send` + `send-key return`）
  3. `$STATUS_DIR/.notified-$SLUG` を touch
  4. watcher 自身を終了
- **exit パスとの重複抑止**: exit パスは通知前に `.notified-$SLUG` の存在を確認し、あればスキップする。`$SLUG` は pane ごとに一意（`<task-slug>` / `<task-slug>-sonnet` / `<task-slug>-codex` …）なので、同じ `STATUS_DIR` を共有する別 pane の通知を取り違えて抑止することはない
- **後始末**: `${CLAUDE_CMD}` から復帰した時点で watcher の PID を `kill` する

**実装上の要点**: 通知処理は `notify_parent()` シェル関数に切り出し、watcher と exit パスの**両方から呼ぶ**。片方だけ更新される乖離（CLAUDE.md 項目 21 が扱った退行と同型）を構造的に防ぐため。

抑止条件を exit パスと共有することで、「未使用 standby が status.json を汚さない」「`.deferred` した Child が孫の完了を横取りしない」という既存の所有権モデルは変わらない。

### 4.3 watcher が解決するもの / しないもの

- 解決する: 実装者が `error` を書いて **idle 残留**しても親に届く（H4）。agmsg モードで親に検知手段が無い問題（H5）。プロンプト指示を LLM が無視した場合の backstop（H1 / H2 の実効性）
- 解決しない: レビュアーの無期限 idle（H3 / H7）。これはプロンプト層の abort プロトコルで扱う

## 5. プロンプト層の設計

### 5.1 ABORT / ESCALATION プロトコル（H2 の修正）

`SKILL.md` の `{{CODE_REVIEW_BLOCK}}` 内「共通プロトコル a」に追加する。配置は成功パスの (a)(b)（`SKILL.md:1183` 以降）より**上**とし、「これがそれ以外のすべてに優先する」と明記する。停止を決めた時点で必ず読む位置に置くためである。

発動条件は「作業を完了せずに停止すると判断したすべての場合」— blocking error、設計上の矛盾、plan が誤りだという判断、単純な断念を含む。

実行順序（すべて必須）:

1. `<STATUS_DIR>/review/code-round-<現在の N>.md` に理由を書き、**最終行を `VERDICT: needs_work`** にする。レビュー未依頼なら `N=1`。これが**レビュアーを待機ループから解放する**唯一の手段である
2. レビュアーへ両チャネルで `[abort] <一行理由>` を送る（`send.sh` による inbox 記録 + `cmux send` + `send-key return`）
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

`launch-workspace.sh` の `REVIEW_INSTRUCTION` / `EXIT_INSTRUCTION`（`:538-573`）にも abort 節を焼き込む。prewarm 経路（親 → standby への `REQUEST_TEXT`）だけを直すと、`--mode execute` の spawn 経路だけ古い挙動が残る。これは CLAUDE.md 項目 21 が扱った「2 経路のうち片方だけ直る」退行と同型である。

### 5.5 無人ループ用文面の同期（N2 の修正）

`references/unattended/code-review-block.md` に abort 経路の確定文面を追加する。ループモードのプロンプトは `render-loop-prompt.sh` がこのファイルから生成するため、ここを直さないと無人ループでは abort プロトコルが存在しないままになる。

## 6. ドキュメントとバージョン

### 6.1 派生パターン一覧（新規ファイル）

`apps/cmux-team-dispatch-task/docs/notification-gaps.md` を新規作成する。

**新規ファイルにする理由**: `CLAUDE.md` は既に 185 行・番号付きルール 21 項目あり、そこへ 10 行規模の表を直接入れると「退行防止ルールの索引」という性格が薄まる。パターン一覧は参照頻度が低く分量が多い資料なので分離し、`CLAUDE.md` からはリンクで参照する。

各行に以下を記載する: パターン ID / 症状 / 根拠 `file:line` / 影響 / 今回の対応（修正 or 記録のみ）/ 判断理由。

### 6.2 4 ファイル整合

`CLAUDE.md` の「ドキュメント整合の絶対ルール」に従い、以下を同期する。

- `SKILL.md` — 5 章の変更本体
- `references/guide-ja.md` — status protocol / Phase B-R / runner wrapper の説明に abort プロトコルと watcher を反映
- `README.md` — 完了通知の説明に「error でも通知される」「exit しなくても通知される」を反映
- `CLAUDE.md` — ファイル構成表に `docs/notification-gaps.md` を追加。番号付きルールに**項目 22** を追加（error 時通知の必須化 / 終端 status の sticky 化 / watcher の存在と抑止条件 / 通知処理を関数共有すること）

### 6.3 バージョン

`apps/cmux-team-dispatch-task/.claude-plugin/plugin.json` を **1.10.2 → 1.11.0** に上げ、ルートの `.claude-plugin/marketplace.json` の対応 version も同期する。watcher は新規の振る舞いを追加するため patch ではなく minor とする。

## 7. 検証

- `pnpm check`
- 変更したシェルスクリプトに `bash -n`（`launch-workspace.sh` は zsh で実行されるが heredoc で生成される runner は bash なので、生成物側も構文検査する）
- 既存テストの回帰確認: `test/test-launch-workspace-codex.sh` / `test/test-launch-workspace-review-config.sh` / `test/test-runner-signal-exit.sh`
- **新規** `test/test-runner-terminal-status.sh` — `test-runner-signal-exit.sh` の cmux stub 基盤を流用した**動的**テスト（静的な文言一致では N1 のような挙動バグを検出できないため）
  1. `status.json` に `error` を置き stub を exit 0 で終了 → `done` に降格せず、親通知が `status: error` であること
  2. stub が終了しない状態で `status.json` を `error` にする → watcher が親通知を発火すること
  3. `.deferred` あり / 未 assigned standby では watcher が発火**しない**こと
- プロンプト文面の静的検査は `test/test-launch-workspace-codex.sh` の既存パターンに倣い、`EXIT_INSTRUCTION` / `REVIEW_INSTRUCTION` に abort 節が含まれ、codex 分岐に `/exit` が混入していないことを検査する

## 8. 今回は修正せず記録に留めるもの

| パターン | 判断理由 |
|---|---|
| H6 の狭い窓（`.deferred` 済だが実装者が起動しない） | 検知には deadline が必要で、それはループモードの `batch-wait.sh` の責務。通常 dispatch に別のタイムアウト機構を持ち込むのは過剰実装になる |
| H7 のレビュアー側 stall 検知の一般化 | abort 通知でレビュアーは解放される。「idle なレビュアーを外部から起こす」汎用機構は新チャネルの発明にあたり、「新しい通知チャネルを発明しない」という制約に反する |
| 送信失敗の検知（`cmux send` の戻り値確認） | 現行は `2>/dev/null || true` で握り潰している。watcher が status.json 経由で backstop するため、送信失敗単体での即死は起きない。個別のリトライ機構は過剰 |

## 9. リスクと緩和

| リスク | 緩和 |
|---|---|
| watcher が「早すぎる完了通知」を出す（子が `done` を書いた後まだ後処理中） | 現行のプロンプト指示自体が「status.json 書き込み直後に通知せよ」なので挙動は同一。`SKILL.md:1811-1815` が既に「重複通知は正常、status.json を真とする」と定めている |
| watcher プロセスの残留 | `${CLAUDE_CMD}` 復帰時に `kill`。runner script は pane と寿命を共にするため、pane 消滅時は道連れになる |
| `done` の sticky 化で、子が `done` を書いた後の失敗を見逃す | exit code ≠ 0 のときは従来どおり `error` を書く（4.1 の表）。見逃すのは「子が done を書き、かつ正常終了した」場合のみで、これは正常系である |
| 4 ファイル整合が崩れる | `CLAUDE.md` 項目 22 として検証手順を明文化し、以後の変更で参照させる |

