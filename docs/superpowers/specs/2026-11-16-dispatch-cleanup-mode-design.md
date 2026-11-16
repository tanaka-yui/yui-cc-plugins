# orca-team-dispatch-task の後片付けのモード（短い設計）

## 目的と理由

並列や連続で dispatch すると、worker の端末・worktree・`.dispatch/<slug>` の記録が溜まり、Orca の一覧が見づらくなる。
今は Step 5 / Step 6 で毎回「片付けるか」を尋ねており、尋ねられるまで残る。PR を作る使い方では、PR を作ったあと
または merge されたあとに、尋ねずに片付けたい。

## 決めたこと（ユーザー）

- 設定で 3 つから選ぶ。
  - 最後（既定）: 今どおり、Step 5 で判定し Step 6 で尋ねる。
  - PR を作ったら: Step 4 で PR を作れたタスクを、尋ねずに片付ける。
  - PR が merge されたら: 片付けるのは次の dispatch の始め。記録の残る PR のうち merge 済みのものを片付ける（案 A）。
- 片付けるものは Step 6 が今扱う 3 つ（worker の端末、worktree、記録）。

## 私が決めたこと（直してよい）

- 設定のキーは `cleanup`、値は `end`（既定）/ `pr_created` / `pr_merged`。ほかの切り替え（`integration` など）と同じく、
  1 回きりの上書き → project → global の順に解決し、`config-edit.ts` で書け、Step 2 の `--cleanup` で 1 回だけ上書きできる。
- 値は dispatch の開始時に `workers.json` の `cleanup` に記録し、後の判定は記録を読む（設定を後で変えても、
  前の dispatch の扱いは変わらない）。記録の無い旧い dispatch は `end`。
- `integration=merge` のタスクは PR が無いので、設定にかかわらず `end`。
- `--issue` も同じ扱い（`integration=pr` の Issue ごとに PR を作るので、`pr_created` は I3 で PR を作れた直後、
  `pr_merged` は次の実行の始め）。
- `--auto` は対象外。すでに PR を作った直後に尋ねずに片付けており（成果のブランチは origin に保存済み）、
  `pr_merged` にすると逆に worktree が増えるため。文書にそう書く。
- 片付けの中身は Step 5 の判定（`orca-cleanup.ts plan`）をそのまま使い、その計画が提示したものだけを、尋ねずに
  `run` で実行する。人が操作した端末・merge も PR も無い branch など、今 Step 5 が残すものは、モードにかかわらず残す。
  残ったものは 1 行ずつ表示する。
- `pr_merged` の掃除は `orca-cleanup.ts sweep` という新しい入口で、SKILL.md の Step 1 の前に 1 行で呼ぶ。
  `.dispatch/` の下で `cleanup=pr_merged` を記録し、`integration-result.json` に `pr_url` があるタスクだけを見る。
  `gh pr view <url> --json state` が `MERGED` なら片付ける。`CLOSED`（merge されずに閉じた）と `OPEN` は残す。
  gh が読めないときは何もせず、1 行言って dispatch を続ける（掃除の失敗で dispatch を止めない）。
- 同じ Run にまだ動いているタスクがあっても、片付けるのはその slug の資源だけ（今の `plan` / `run` は slug 単位）。

## しないこと

- branch の削除の規則は変えない（今の Step 6 のまま）。
- 定期的な掃除のコマンドや Orca automation の登録は作らない（案 B は選ばれなかった）。
- `CLOSED` の PR のタスクを自動では消さない（成果が merge されていないため）。

## 考えた案

- A. 次の dispatch の始めに掃除する（選ばれた）: 仕組みが増えず、使うたびに減る。次の dispatch までは残る。
- B. 掃除のコマンド（`make sweep`）を足し、手か automation で回す: 決まった間隔で消えるが、登録の手間がある。
- C. A と B の両方。

## 回帰で固定すること

- 3 つの値の解決と記録（config と start のテスト）、`integration=merge` での `end` への落とし込み。
- `pr_created`: PR を作れたタスクだけが尋ねずに片付き、作れなかったタスクは残る。
- `pr_merged`: `MERGED` だけを片付け、`OPEN` / `CLOSED` / gh の失敗では何もしない。旧い記録は `end`。
- Step 5 の判定が残すもの（人が操作した端末など）は、どのモードでも残る。
- SKILL.md と guide-ja.md の対応（Configuration の表、Step 1 / Step 4 / Step 6）と `test-docs.sh`。
