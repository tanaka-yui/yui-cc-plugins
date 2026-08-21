# agmsg monitor 専用化 — 引き継ぎ（次セッションでの議論用）

作成: 2026-08-22
状態: **`feat/dispatch-monitor-only` を merge せず保留中**。`main` は codex 系 2 プラグインの
v2.0.0 のみ取り込み済み。

## この文書の目的

3 プラグイン（`cmux-team-dispatch-task` / `cmux-codex-review` / `cmux-codex-exec`）の配送・待機を
**agmsg monitor の push 1 本**へ統一する作業が、実装・レビュー・E2E まで一通り終わった。
merge するか、どこまで直してから merge するかを次セッションで議論するための材料をまとめる。

関連文書:

- 設計: `docs/superpowers/specs/2026-08-21-agmsg-monitor-only-design.md`（**実測結果表と
  「E2E が見つけた欠陥」節が本体**）
- 実装計画: `docs/superpowers/plans/2026-08-21-agmsg-monitor-only-codex-plugins.md`（完了・merge 済み）
  / `docs/superpowers/plans/2026-08-21-agmsg-monitor-only-dispatch.md`（完了・未 merge）
- 前提逆転の履歴: `docs/superpowers/specs/2026-08-12-delivery-verification-results.md`
- 作業ログ（git-ignored）: `.superpowers/sdd/2026-08-21-agmsg-monitor-only-dispatch/progress.md`

---

## 1. 何が終わったか

### merge 済み（`main`）

`cmux-codex-review` / `cmux-codex-exec` を **v2.0.0** へ。完了待ちのポーリング watcher
（`bin/cmux-codex-wait` 89 行 × 2 コピー）を削除し、親はターンを閉じて Monitor イベントで起きる形に
した。E2E で実証済み（親が idle から Monitor の 1 行で起床、token 一致）。

### 未 merge（`feat/dispatch-monitor-only`、17 コミット）

`cmux-team-dispatch-task` を **v2.0.0** へ。9 タスクの計画を完走し、個別レビュー 9 回・fix ラウンド
6 回・最終ブランチレビュー 1 回・fix wave 1 回・残余修正 1 回を経ている。

**削除**: `send-prompt.sh`（タイプ入力配送）/ `monitor-dispatch.sh`（status.json の 10 秒ポーリング）/
`ensure-agmsg-ready.sh`（505 行の watcher 起動 guard）/ `batch-wait.sh`（loop mode のバッチ待ち）/
`agmsg-path.sh` と対応テスト 5 本。

**新設**: `verify-agmsg-ready.sh` / `test-delivery-callsites.sh` / `test-skill-script-refs.sh` /
`test-agmsg-guard-block.sh` / `test-doc-stale-vocab.sh`。

規模は 3 プラグイン合計で約 +3,700 / −4,400 行。

### 確立した規律（D1-D5）

- **D1**: 待機ループを 1 つも作らない。時間ベースは**単発タイマー**のみ（親 90 分 / verdict 30 分）
- **D2**: タイマーはエンジン中立に書く。**ただし codex は自分宛の遅延タイマーを張れない**（下記 2 参照）
- **D3**: 再武装は 3 回上限。無人ループでは AskUserQuestion に落とさない
- **D4**: **起きたら永続記録を読む**。`history.sh` を使い `inbox.sh` は使わない（盗られた row は
  既読になる）。照合は接尾の区切りまで含める（`DONE <token>:` のコロン、`[ready] <slug>$` の行末）
- **D5**: **起動プロンプトにクォート文字を置けない**（`zsh -ic "claude ... 'PROMPT'"` の二重引用構造）
- fallback は作らない。agmsg 不在・watcher 不在は fail-fast

---

## 2. 実測で分かったこと（議論の土台）

この設計は過去 2 回、前提の取り違えで方向を誤っている。今回は**すべての判断を計測 ID に紐付けた**。

| ID | 検証内容 | 結果 |
|----|---------|------|
| B1 | Monitor イベントは idle な claude セッションを起こすか | **pass** |
| B2 | ターンを持っていないペインは受信できるか | fail（制約。初回ターンが必須） |
| B5 | `ready.<team>__<agent>` sentinel は存在するか | **存在しない**（agmsg 1.2.1）。副産物として**現行の inbox 記録は一度も発火していなかった**ことが判明 |
| V2a/V2b | codex は seat 記録が無いと受信できるか | 記録前 fail / 記録後 pass |
| T1 | バックグラウンドの単発 sleep はセッションを起こすか | pass（60 秒で 1 回のみ実測） |
| D-E2E | dispatch の実ペインで readiness / 配送 / 完了通知が成立するか | **pass** |
| **D-T2** | **codex は自分宛の遅延メッセージでタイマーを張れるか** | **fail** |

**D-T2 が最大の発見**。`( sleep N; send.sh ... ) &` も `setsid nohup bash -c '...' &` も codex の
ターン終了で消える。**codex の待機者には保険が存在しない。**

---

## 3. 残っている穴（**次セッションの主要議題**）

### 3-1. codex 待機者に保険が無い（Critical・未解決）

Phase A-R の design ペイン / Phase B-R の実装者 / 親オーケストレータのいずれかが codex のとき、
`review-verdict` や完了通知が 1 通失われると**永久に眠る**。親が claude なら 90 分タイマーが最後に
拾うが、**all-Codex 構成では誰も拾わない**。

**現状の対処（merge 前にやったこと）**: 動かない手段の指示を 7 箇所から削除し、「**この engine には
保険が無い**」という事実に置き換えた。待機に入る前に相手の生存を確認させ、親へ「保険なしの待機に
入る」と 1 通報告させる。`--unattended` × codex 親は `prewarm-panes.sh` で `die`。

**未解決なのは穴そのもの。** 議論すべき選択肢:

- **timer broker（レビュアー推奨）**: codex 待機者は自分でタイマーを張らず、`timer-request:` を
  **claude の親**へ送る。親は実証済みの `run_in_background` + `TaskStop` を持つので、期限で
  `review-timer:` を送り返す。**実測済みの唯一の機構を再利用できる**のが利点。制約は「親が claude
  であること」が前提化される点
- **サンドボックス外で張る**: `launch-workspace.sh` は codex のプロセスツリー外なので supervisor に
  載せれば生き残る見込み。ただし「ラウンド番号が起動時に未定」「再武装が外から不可能」という
  噛み合わせの悪さがあり、**実測しないと分からない**（D-T2 と同じ失敗を繰り返さないこと）
- **all-Codex 構成を非対応と明記する**

### 3-2. read cursor 排他が実装されていない（Important・計画と実装の乖離）

spec は「親は自分の (team, agent) ペアに対する排他を保持するか、競合 unfiltered watcher が居ない
ことを確認する」を**要件**として書いているが、実装されたのは「起きたら `history.sh` を読む」という
**事後の緩和策だけ**。

背景: agmsg の read cursor は (team, agent) 単位で 1 つしかなく、**同じチェックアウトで 2 つ目の
セッションを開くと、先に poll した方が row を取り他方は何も見ない**（`watch.sh:619-626`）。
dispatch は単一の `parent` identity を `[ready]` / `dispatch-notify` / `review-verdict` の全部に
使い回すので、どのメッセージでも消費されうる。

レビュアーの推奨は「検出だけ足す」（`run/watch.*.filter` を走査して競合を警告、10 行程度）。
**spec 側の記述も実装に合わせて直す必要がある。**

### 3-3. 既存バグ（このブランチで修正済み、記録のため）

`prewarm-panes.sh` の検証と runner 解決が非対称で、`--codex-runner` だけを渡すと**検証を通過して
runner が空になり claude にフォールバック**していた（`main` と同一コード）。monitor 専用化で
「モデルが違うペイン」から「**永久に到達不能なペイン**」へ深刻度が上がったため、このブランチで直した。

### 3-4. その他の park 項目

spec の「後続の課題（別 PR）」に記録済み: `render-loop-prompt.sh` の `send.sh` ハードコード /
`prewarm.json` の `wired` が常に真の定数 / prewarm の死んだ条件 9 箇所 /
`test-runner-terminal-status.sh` が 84 秒 / `guide-ja.md` のタイムアウト粒度の重複 /
CS7 が `review-block.md` を素通し。

---

## 4. 挙動の変化（ユーザーが知るべきこと）

- **タイムアウト検知の粒度が粗くなった**。旧 `batch-wait.sh` は 5 秒間隔で `claimed_at` を見ていたが、
  新設計は 90 分固定タイマーの起床時にしか評価しない。`loop.task_timeout_min` を 90 分未満に
  設定しても検知は次の起床までずれる
- **agmsg が必須になった**。不在なら fail-fast で停止する（従来はタイプ入力で動いた）
- **`--parent-notify-surface` を削除**した（`--parent-notify-workspace` は `cmux notify` のために残存）
- **`--unattended` × codex 親は die** する

---

## 5. この工程で得られた教訓（設計に効く）

1. **静的検査が全部緑でも、実際に動かすまで分からない欠陥がある。** 個別レビュー 9 回を通った後の
   E2E で 3 件、最終レビューでさらに 3 件見つかった。**E2E を省略しないこと。**
2. **ポーリングは消えたのではなく移動しうる。** 親から全部消しても、子に「待て」とだけ言うと
   子が `inbox.sh` のポーリングループを再発明した（実測）。「ポーリングするな」と明示が要る。
3. **検査を足すと、その検査に対する検査が要る。** この工程で「検出器が自分の検出文字列を含んで
   恒久 FAIL」「現役フラグを退役語彙に入れて正しい記述を FAIL」「検査が履歴を消す方向へ誘導」
   「新テストが誤った挙動を期待値として固定」が実際に起きた。**否定検査には最初から
   『否定文・履歴・検出器自身は免除』を設計に入れる。**
4. **1 箇所直したら同型を全経路で探す。** codex 親の判定を Step 1g で直したのに、起床経路に同じ
   欠陥が残っていた（最終レビューが発見）。
5. **動かないと分かった手段を指示に残すのは、手段が無いと書くより悪い。** 待機者は保険がある
   つもりで眠る。

---

## 6. 次セッションでの再開方法

```bash
git checkout feat/dispatch-monitor-only   # 17 コミット、テストは全 green
```

- 全裁定と各タスクの完了コミットは `.superpowers/sdd/2026-08-21-agmsg-monitor-only-dispatch/progress.md`
  に残っている（git-ignored。消さないこと）
- テストは分割して走らせる（直列で 2 分を超える。`test-runner-terminal-status.sh` が 84 秒）
- **merge 判断の争点は 3-1（codex 待機者の保険）と 3-2（read cursor 排他）の 2 点**。
  どちらも「このまま merge して後続 PR」か「merge 前に直す」かの選択

## 7. 決めてほしいこと

1. **3-1 をどうするか**: timer broker を実装するか / all-Codex を非対応と明記するか / 現状（事実を
   書くだけ）で merge するか
2. **3-2 をどうするか**: 検出を足すか / spec の要件記述を実装に合わせて下げるか
3. **merge の形**: `main` へローカルマージか、PR を作るか
