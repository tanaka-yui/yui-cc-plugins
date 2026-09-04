# Orca Team Dispatch

## Output Language の訳

ユーザーへ提示する質問・選択肢ラベル・表・進捗報告はすべて日本語で描画する。
SKILL.md 本文が英語なのは規約による統一であって、表示言語を変えるものではない。

Orca CLI は PATH に無い。**ユーザーへ見せるコマンドも含め、常に `$ORCA_BIN` 経由で呼ぶ。**

## Step 1: 依頼を書き出す

worker は依頼をファイルから読む。**逐語で写す。要約しない** —
ここで要約すると、ユーザーが実際に出した指示が失われる。

## Step 2: 開始

exit 1 は worker が起動しなかったことを意味する。「資源は保持した (KEPT)」とあれば
Task は既に実在する。**何も削除せず**、表示された inspection コマンドを実行する。

## Step 3: 待つ

先にユーザーへ伝える: worker が終わると、この skill は ack の前に dispatch を release する。
端末はこちらで `terminal create` して `worker-start` へ渡した再利用端末なので、Orca は
`retained` を返して閉じない — 端末と worktree が Step 5 の片付けまで残るのはそのためであって、
この skill が retention を要求したからではない。

exit code がプロトコルそのものである。

| exit | 意味 | すること |
|---|---|---|
| 0 | 成功で完了 | `result.md` を読んでユーザーへ報告し Step 4 へ |
| 5 | 失敗で完了 | `result.md` を読んで何が失敗したか伝え、Step 5 へ。**merge しない** |
| 3 | 実行中 | 進捗を報告して呼び直す |
| 4 | worker が停止・起動失敗 | 調べて報告する。**何も削除しない** |
| 1 | この版が扱えない message が届いた | ack していないので何も失われていない。下の復旧手順に従う |

exit 1 では batch が未 ack のまま残るので、待ち直しても同じ batch が返って前に進まない。
復旧は意図的に手動である: 既定の `check`（`--peek` ではない）で deliveryId を得て、
中の message を自分で処理し、**その exact な batch を `--ack` してから** `orca-wait.sh` を
呼び直す。何が届いて何をしたかをユーザーへ見せてから ack する。

## Step 4: 成果を持ち帰る

**exit 0 のときだけ。**dispatch を始めたときに居たブランチへ merge する。
worker が成功を報告し、`result.md` が非空で、checkout がそのブランチのままで、
clean であること。どれか欠ければ拒否する。コンフリクトのときは merge を中断して
何も消さないので、解決方法をユーザーへ伝える。

## Step 5: 片付けの exact なコマンドをユーザーへ渡す

**この版は何も消さない。**値を埋めたコマンドを表示して、ユーザーに判断させる。
**placeholder を見せない。**`worker-release` を実行し、**その `state` で分類する** —
exit code だけでは端末を閉じてよいかは決まらない。

- **[C1]** `release_pending` / `release_unknown` は**そこで止まる**。exit 0 は
  「閉じてよい」の証明ではない。receipt と `worker-show --dispatch` を見せ、
  端末も worktree も意図的に残していると伝える
- **[C2]** `retained` / `already_released` のときだけ端末が手元に残る。
  **handle と worktreeId が記録した state と一致することを確かめてから**閉じる。
  一致しなければ、もう誰か他の所有物である
- **[C3]** worktree の削除は破壊的なので、**条件が実際に揃ったときだけコマンドを出す**。
  条件は「merge 済み」「**この dispatch が作った worktree である**」「checkout が
  読めてかつ clean」「[C2] の identity が一致した」「**その worktree に残る端末が
  すべて記録済みのものである**」の 5 つ。**再利用した worktree は決して削除対象に
  しない** — 元からこちらのものではない。selector には `id:` の接頭辞が要る。
  **端末を列挙できなかったときは「0 個」ではなく「判断不能」であり、コマンドを出さない。**
  worker が失敗した場合は `merged` が false なので削除は提示されない（意図した動作）
- **[C4]** `worktree rm` はブランチ削除も試みる。**merge 済みと証明できないブランチは
  Orca が残す**ので、ブランチが残るのは異常ではなく合図である。
  dirty なファイルをユーザーが見て失ってよいと判断するまで `--force` を足さない

## 既知の制限

**黙って回避しない。**該当する場面ではユーザーへ伝える。

| 制限 | ユーザーがすること |
|---|---|
| 何も自動では片付けない | Step 5 のコマンドを実行する |
| セッションが途中で落ちても自動回復しない | `task-list --run <run_id>` と `worker-show --dispatch <id>` で調べ、Step 5 の要領で片付ける |
| worker が報告せずに止まると待ちが時間切れになる | 同じ inspection。状態は `.dispatch/<slug>/` にある |
| worker は質問できない | 代わりに `result.md` に理由を書いて失敗で閉じるよう指示してある。読んで投げ直す |
| runner は固定で設定できない | まだ無い |
| setup hook を要する repo は対象外 | worktree は setup を skip して作る |

## ディスク上の状態

`.dispatch/<slug>/`: `request.md` / `run.json` / `workers.json` / `received.json` /
`integration-result.json` / `run-design.sh` / `roles/design/{status.json,result.md}`。
手で再開・片付けするのに必要なものはすべてここにある。`.dispatch/` は repo の
`info/exclude` へ入れるので、ユーザーの `git status` には現れない。

SKILL.md がユーザーへ提示する CLI はこの 8 つで、この訳もそれに一致する:
`orchestration worker-release` / `orchestration worker-show` / `orchestration task-list` /
`orchestration check` / `terminal show` / `terminal list` / `terminal close` / `worktree rm`。

---

## 補足（SKILL.md に対応セクションなし）

### なぜ recovery 機構も自動片付けも無いのか

親の裁定（2026-09-04）による。**一度も走っていない系のために crash recovery を
設計しても、直せるのは想像した failure mode だけである。**自動片付けも
「閉じてよいか」の identity 検証を伴うので、同じ理由で後回しにした（spec 18-1 の F-i）。
