# --auto の複数リポジトリの Issue（C2b2、短い設計）

## 目的と理由

`--auto` は、実装するリポジトリが 2 つ以上の Issue を判定のあと Ready_Eng に回している（`bin/orca-auto.ts` の
`targets.length > 1`）。API とクライアントを合わせて変えるような Issue も、自動で消化できるようにする。
元の設計（`2026-11-12-issue-auto-dispatch-design.md` 6.3・6.6、`2026-11-13-auto-dispatch-additions-design.md` 5 章・8.1・8.3）の
「1 つの役が複数の worktree を担当する」を実装する部分。

## 前提の確かめ（2026-11-17、Orca 1.4.257）

- 1 つの worker が、自分の worktree の外にある 2 つ目の worktree に書き、commit し、push できる。このMac の codex と claude、
  Mac M2max の codex（`worker-start --on`）で確かめた。このMac の codex のセッションの記録では、Orca は codex を
  `danger-full-access`（sandbox なし）で起こしていた（M2max のセッションの記録は読んでいないが、`writable_roots` を足さずに通った）。
  **この機能は、Orca が codex を sandbox なしで起こすことに頼る。**Orca がこれを変えたら、2 つ目の worktree に書けなくなりうる。
- 親は遠くのマシンにも `worktree create --environment <名前> --repo <selector>` で worktree を作れる（親が遠くの git を打たずに済む）。
- merge 済みの PR の `headRefOid` は、merge のあとの push でも head branch の削除でも動かない。

## 決めたこと（ユーザー）

- **1 つの役が全リポジトリを受け持つ。**役（design / design_review / exec / exec_review）の数は今と同じで、各役がリポジトリの数だけ
  worktree を持つ。リポジトリごとに別の dispatch を並べる形は採らない（リポジトリ間の整合を誰も通して見ないため）。
- **1 つの Issue のリポジトリは 2 つまで。**3 つ以上は今までどおり Ready_Eng（判定の指示 `auto-judge.md` の記述に合わせる）。
- **merge の順番は判定役が書いた `targets` の順。**判定役は依存の順（例: API を先、クライアントをあと）に並べる。途中で merge できなければ、
  残りの PR は残して In review にし、`partial-merge` のコメント（既に共有の fixture にある）でどれが merge 済みかを書く。
- **全リポジトリを同じ 1 台で動かす。**その Issue の全リポジトリが確認済み（`verified`）のマシンにだけ振り分ける。
- **レビュー役は 1 人で全リポジトリの差分を見る。**

## 私が決めたこと（直してよい）

- `targets` に同じリポジトリが重なっていたら、判定の適用で重複を除く。
- 1 つ目のリポジトリ（`targets[0]`）を「主」とする。status dir、まとめ役の端末、`run.json` は主のリポジトリの checkout に置く（今と同じ場所）。
- 各役の 1 つ目の worktree は今と同じく `worker-start` が作る。2 つ目は、親がその役を起こす前に `worktree create`（遠くなら `--environment`）で
  同じマシンに作り、記録してから worker に渡す。worker への指示文は、リポジトリごとの worktree の path・branch・base を並べる。
- 記録は役ごとに、リポジトリごとの worktree・branch・base を持つ形を足す。**1 リポジトリの dispatch と旧い記録は今の形のまま読める**こと
  （記録の形を変えた版で、動いている 1 リポジトリの Issue を壊さない）。
- worker の完了の封筒（mail の merge_ready / worker_done）は、リポジトリごとの `{repo, branch, head}` の一覧を運べる版を足す。1 リポジトリは
  今の版 1 のまま受け付ける。親はリポジトリごとに branch と origin の head を照合する。
- PR はリポジトリごとに 1 つ作り、作れていないものだけを作り直す。CI はリポジトリごとの `ci` の設定でその PR を見る。merge はすべての PR が
  merge できる状態（CI・レビュー・衝突なし）になってから、`targets` の順に行う。すべて merge できたら今と同じ `ai-merged` と Done。
- 前の世代の PR を閉じる処理（`handoverPrs`）は、リポジトリを照合して閉じる（今の `prs[0]` との比較だと別のリポジトリの今の PR を閉じうる）。
- 空きの数え方は「役の数 × リポジトリの数」。空きのディスクと checkout の dirty の確かめ、既定の branch の取得は、全リポジトリについて行う。
- 後片付けは (役, リポジトリ) ごとに行う。保存済みの証明（origin の祖先・受理した head）はそのリポジトリの checkout で見る。人が操作した
  worktree の保持も (役, リポジトリ) ごと。一部だけ merge された Issue は、merge されたリポジトリの branch だけを merge 済みとして扱う。
- Issue のコメント（started / failed）の branch は、共有の fixture の鍵を変えずに、複数のときはリポジトリ名を添えて並べる
  （slack-issue-intake との約束を変えないため。計画で intake 側の読み方を確かめる）。
- 続きの世代（前の世代の branch から始める）の材料は、リポジトリごとの前の branch を持つ。

## しないこと

- 3 つ以上のリポジトリ、リポジトリごとに別のマシンへ分けること。
- `--issue`（file transport）と手で書く dispatch の複数リポジトリ（`--auto` だけ）。
- GitHub Project の同期（C2c）と `make setup`（C3）。

## 考えた案

- A. 1 つの役が全リポジトリの worktree を持つ（選ばれた）: 合わせて変える修正を 1 人が通して作り、レビューも 1 回で全体を見る。記録・封筒・
  後片付けの形を広く変える。
- B. リポジトリごとに別の dispatch を同じ Run に並べる: 今の「1 役 1 worktree」と `orca-wait` の複数の status dir をそのまま使えるが、
  リポジトリ間の整合を誰も通して見ない。

## 回帰で固定すること

- 判定: 2 つは自動で進み、3 つ以上は Ready_Eng（AU25/AU26 の期待値が変わる）。
- 起動: 全リポジトリを確認済みのマシンにだけ置く、空きは役 × リポジトリで数える、2 つ目の worktree を作って記録してから起こす。
- 封筒: 版 2 の一覧を受け付け、リポジトリごとに branch と origin の head を照合する。版 1 は今のまま。
- 仕上げ: PR をリポジトリごとに作る、CI をリポジトリごとに見る、`targets` の順に merge する、途中の失敗で `partial-merge` と In review。
- 後片付け: (役, リポジトリ) ごとの保存の証明と保持、一部 merge。
- 1 リポジトリの Issue と旧い記録の振る舞いは変わらない（既存のテストの期待値を変えない。変えたら理由を残す）。
- 実機: このMac と M2max で、2 リポジトリの Issue を 1 件ずつ、判定から PR・merge（または In review）・後片付けまで通す。
