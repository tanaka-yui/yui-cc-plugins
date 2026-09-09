# orca-team-dispatch-task `--issue` モード（spec の F-f）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GitHub issue を claim して dispatch し、成果を親ブランチへ取り込み、ラベルを遷移させて片付けるまでを `--issue` で回す。cmux 版の `--loop` を **`--issue` に改名して**移植する。

**Architecture:** issue の claim / lock / journal は cmux 版 `issue-fetch.sh` をほぼそのまま持ち込む（cmux 依存は 4 箇所しかない）。**駆動はバッチ同期**にする — 1 バッチを dispatch したら `orca-wait.sh` で待ち切り、merge と cleanup を済ませてから次のバッチへ進む。

**Tech Stack:** bash + jq + `gh`、Orca CLI（`$ORCA_BIN`）、テストは自作の bash ランナーと `test/lib/orca-stub.sh` + `gh` のスタブ

**Spec:** `docs/superpowers/specs/2026-09-04-orca-team-dispatch-task-design.md` の 12 節（issue ループ）と 11 節（cleanup decision table）。cmux 側の正本は `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/loop-mode.md`。

**前段:** Stage A（並列 dispatch）/ F-g（agent・model・effort の設定）/ F-b（レビューモード）は実装済み。

## 名前

`--loop` ではなく **`--issue`** にする。`--issue <N>` は**その 1 件だけ**を dispatch する（claim → dispatch → merge → ラベル遷移 → cleanup）。引数なしの `--issue` が繰り返しモードである。

## cmux 版から意図的に変える 3 点

### 1. 駆動をバッチ同期にする（wake 駆動をやめる）

cmux 版は「dispatch したらターンを終え、子の `dispatch-notify` で親が起きる」設計で、そのために単発 safety timer・`heartbeat`・timeout sentinel・再導出が要る。**Orca ではこれを持たない。**

- `orca-wait.sh` が `check --wait` で**ブロックして待てる**（Stage A で実証済み）。タイムアウトは `--timeout-ms` と `--max-waits` で有界である
- wake 駆動は「1 つ落とした `dispatch-notify` でジョブが黙って消える」という失敗様式を持ち込む。cmux 側はそれを safety timer で塞いだが、**塞ぐべき穴を先に作らない**
- 代償は「1 バッチの中の遅い 1 件が全体を待たせる」こと。これは受け入れる。並行数はバッチ内で効いている

### 2. integration は `merge` だけを実装する

PR 統合は spec の **F-c** であり未実装である。`gh pr create` / `record-pr.sh` / fork 誤爆対策（`--repo` スコープ）を持たないまま `--integration pr` を宣言してはならない。**`--issue` は当面 merge 専用**で、質問もしない。

### 3. spec 12-2 の 8 状態は採らない

`verifying` / `remediating` / `retained` は二相コミット（F-d）と generation transition（F-e）の状態であり、どちらも未実装である。**動かす経路の無い状態を journal に持たない。**採るのは `issue-fetch.sh` が既に持つ `claimed` → `dispatched` → 終端（`done` / `failed`）だけである。

## Global Constraints

- Orca CLI は PATH に無いことがある。**常に `$ORCA_BIN`** 経由で呼ぶ
- `SKILL.md` は英語のみ。日本語は `references/guide-ja.md` にだけ書く（`check-doc-lang.mjs`）
- SKILL.md と `guide-ja.md` の **bash ブロックはバイト一致**（SK8d）。`[Cn]` の ID 集合（SK8）・制限表の行数（SK8c）・H2 の並び（SK8e。新しい H2 は `normalise_headings()` に登録）も一致させる
- **`test-docs.sh` の SK4 の禁止語（`merge_ready` / `exec_review` / `nonce` / `journal` / `remediation`）を緩めてはならない。**本計画はそのどれも実装しない。`journal` の語も使わない（state file と呼ぶ）
- 完了条件は毎回 `bash test/run-all.sh` が **ALL GREEN**、`node scripts/check-doc-lang.mjs apps/orca-team-dispatch-task` が OK
- version は 3 箇所同期
- コミットメッセージは日本語。末尾に `Claude-Session: https://claude.ai/code/session_01EYLFvy1d56wB4ZwoNroYrx`

---

### Task 1: `issue-fetch.sh` を移植する — **完了**

**Files:**
- Create: `skills/orca-team-dispatch-task/scripts/issue-fetch.sh`（cmux 版から 4 箇所だけ変更）
- Create: `test/test-issue-fetch.sh`
- Modify: `test/run-all.sh`

**cmux 版からの差分は次の 4 点だけである。**それ以外は byte 一致で持ち込む（lock の in-flight grace、takeover mutex、claim の補償、`fetch` の窓拡張と exhaustion 判定は**そのまま**）。

| 箇所 | 変更 |
|---|---|
| `CMUX="${CMUX_BIN:-...}"` | **削除**（死んだ変数） |
| `reconcile` の `prewarm.json` 痕跡 | `workers.json` へ |
| `reconcile` の `$REPO_ROOT/.worktrees/$slug` 痕跡 | **`workers.json` の `roles[].worktree_path` が実在するか**へ。Orca の worktree は repo の外に作られるので固定パスで探せない |
| `gh label create --description` の文言 | `orca-team-dispatch-task issue mode` |

- [x] **Step 1: 先に赤いテストを書く**

```bash
# IF1: lock は生きている間 lock-check を通さない / lease 切れなら通す
# IF2: owner.json が壊れていても grace の間は in-flight として守る
# IF3: fetch は claim に失敗した issue を除外し、state 記録に失敗したら claim を取り消す
# IF4: fetch は候補が尽きたと確認できなければ exit 4（黙って空を返さない）
# IF5: claim が 1 件も成立しなければ exit 3
# IF6: reconcile は **workers.json** と worktree_path の実在を痕跡として見る
# IF7: reconcile は dispatched のまま残る issue があれば abort
# IF8: ensure-labels は 3 ラベルを冪等に作る
```

- [x] **Step 2: 移植して 4 点だけ変える**

**上流ドリフト検出のため、変更点を先頭コメントに列挙する。**cmux 版が動いたら人が差分を見て判断する（spec 8-4）。

---

### Task 2: `bin/orca-issue.sh` — 1 件を最後まで運ぶ — **完了**

**1 issue を claim 済みの状態から受け取り、dispatch → wait → merge → ラベル遷移 → cleanup まで運ぶ。**バッチの繰り返しは SKILL.md 側が行う。

**Files:**
- Create: `apps/orca-team-dispatch-task/bin/orca-issue.sh`
- Create: `apps/orca-team-dispatch-task/test/test-issue.sh`

**Interfaces:**

```
orca-issue.sh --state-file <p> --issue <N> --slug <s> --request-file <f> --run <run_id>
```

- [x] **Step 1: 成功経路の順序を固定する**

**merge が成功して初めて cleanup してよい**（spec 18-1 の裁定）。順序を逆にすると成果が消える。

1. `orca-start.sh`（既存）
2. `issue-fetch.sh mark-dispatched`
3. `orca-wait.sh`（ブロック）
4. `orca-merge.sh` — **失敗したら cleanup へ進まない**
5. `gh issue edit --add-label dispatch/done --remove-label dispatch/in-progress`、`gh issue close --reason completed`
6. `issue-fetch.sh finalize --status done`
7. cleanup（Step 5 の判定を通す）

- [x] **Step 2: 失敗経路を「保持」に倒す**

```bash
# IS1: merge conflict なら worktree もブランチも記録も残し、ラベルは dispatch/failed
# IS2: worker が failed なら merge を試みない
# IS3: ラベル遷移に失敗したら cleanup しない（何が起きたか分からないまま消さない）
# IS4: 成功時だけ cleanup が走り、issue が close される
# IS5: **cleanup は逐次**。前件が終端に落ちるまで次を始めない（spec 12-2）
```

---

### Task 3: SKILL.md に `--issue` を書く — **完了**

**Files:**
- Modify: `SKILL.md` / `references/guide-ja.md`（新 H2 とバイト一致の bash ブロック）
- Modify: `test/test-docs.sh`（`normalise_headings()` に `h2:issue-mode` を登録）

- [x] **Step 1: 冒頭の振り分けに `--issue` を足す**

現在は「`--setup` / `--reset` は設定、それ以外は dispatch」。ここに `--issue` を足す。

- [x] **Step 2: 質問を 1 コールに収める**

cmux 版は 3 コール（AskUserQuestion の 4 問上限のため）だったが、**integration を尋ねない**（merge 固定）ので減る。尋ねるのは label / assignee / 並列数 / 最大バッチ数の 4 つで、**1 コールに収まる**。

- 並列数は 1〜10 の整数。**上限 10 は資源増幅に対する安全弁であり、要求されても上げない**（cmux 版と同じ理由。1 issue が worktree 1〜2 個 + worker 1〜2 本になる）
- `review_mode` は尋ねない。**設定から解決したものをバッチ全体で共通に使う**（無人実行に尋ねる相手は居ない）

- [x] **Step 3: 制限を書く**

- PR 統合は無い（merge のみ）
- crash からの自動再開は無い。`reconcile` が claim の残骸を検出して release するところまで
- **1 バッチの遅い 1 件が全体を待たせる**

---

### Task 4: E2E（stub）— **完了**

**Files:**
- Modify: `test/test-e2e.sh`
- Create: `test/lib/gh-stub.sh`

- [x] **Step 1: `gh` をスタブして 1 issue を通す**

claim → dispatch → wait → merge → ラベル遷移 → cleanup を stub で 1 本通し、**ラベルの遷移順**（`in-progress` → `terminal` を経て `done`）と **merge が cleanup より前**であることを固定する。

---

## 実装で分かったこと（計画に無かったもの）

- **`.dispatch-issue/` を `info/exclude` へ入れないと 1 件も merge できない。**state file と
  lock で親が常に dirty になり、`orca-merge.sh` の dirty ガードが必ず発火する。`.dispatch/`
  と同じ理由なので同じ扱いにした。SKILL.md の I0 と `orca-issue.sh` の両方で入れる
- **文書の bash ブロックは前の block の変数を前提にできない。**`$SCRIPTS` が空のまま
  素通しすると `/issue-fetch.sh` を黙って叩き、何も起きていないのに成功して見える。
  cleanup の SK6c と同じく **fail closed** にし、SK6n で固定した（変異で歯を確認済み）
- **ラベルを動かせなかったときに state を嘘で上書きしない**という分岐が要った（IS5）。
  `dispatched` のまま残せば次の `reconcile` が痕跡を見て止まる

## 実機実行の結果（2026-09-09）— **完了**

`tanaka-yui/yui-cc-plugins` の issue #8 を使い、I0 → I2 → claim → dispatch → wait →
merge → ラベル遷移 → close まで実機で通した。merge は使い捨てブランチ `tmp/issue-live` へ
着地させ、作業ブランチは汚していない。

**stub では出なかった 3 つの欠陥が出た。**どれも `gh` のスタブが「存在しないラベル」や
「既に付いている反対ラベル」を再現しないために隠れていた。

| | 症状 | 修正 |
|---|---|---|
| 1 | `orca-issue.sh` が **`terminal` という名前のラベル**を付けようとし、存在しないので `gh issue edit` が落ち、**全 issue の遷移が失敗**した。cmux 版の `terminal` は「終端ラベル」を指す**変数名**であってラベル名ではない — 移植時の読み違い | `dispatch/<done\|failed>` を付けてから `dispatch/in-progress` を外す形へ。IS2 / E24 が `terminal` ラベルを付けないことも固定 |
| 2 | 1 度失敗して再実行した issue に **`dispatch/done` と `dispatch/failed` が同時に付く**。人が結末を読めない | 反対の終端ラベルも外す。IS9 |
| 3 | 成功時の `finalize` が **前回の失敗理由を `message` に残す**（`finalize` は空 message を無視する） | 成功時に message を明示して上書き。IS10 |

**設計どおりに動いたことも確かめた。**ラベル遷移に失敗した 1 回目は
`the state is left as dispatched` で止まり、資源を残した（IS5 の実機版）。merge 済みに
なった状態で `[C3]` / `[C5]` は削除を提案し、未 merge のときは理由付きで却下していた —
ガードが両方向に効いている。

**O43 が実際に噛んだ。**Run を使い回したため `[C7]` が「記録に無い保持中 worker」として
前段の rv-live ペア（既に解放済みで端末も worktree も不在）を挙げ、Run 全体の片付けを
止めた。制限表に書いたとおりの挙動である。

## 単件経路の実機実行（issue #9）— **完了**

`--issue <N>` を I0 → I1a → dispatch → merge → ラベル遷移 → close まで実機で通した
（exit 0）。**前段の 3 つの修正がすべて実機で効いていることも確かめた:**

- 1 度目の実行が親の dirty で merge に失敗し、`dispatch/failed` が付いた状態から
  再 claim したので、issue には `dispatch/in-progress` と `dispatch/failed` が同時に
  付いていた。**成功後のラベルは `dispatch/done` の 1 つだけ**になった（IS9 の実機版）
- state の `message` も `merged and closed` に上書きされた（IS10 の実機版）
- `terminal` という名前のラベルは 1 度も現れなかった（IS2 の実機版）

**新しい Run を使ったので `[C7]` は通った**（`every retained worker in this Run is one we
recorded`）。O43 は Run を使い回さなければ踏まない、という記述の裏が取れた。

失敗経路も実機で確認できた。親が dirty のとき `orca-merge.sh` が止め、`orca-issue.sh` は
`dispatch/failed` を付けて資源を残し rc=1 で終えた。

## バッチ並列の実機実行（issue #10 / #11）— **完了**

**計画になかった欠陥をここで見つけた。**I1 は「同時に扱う issue 数」を尋ねているのに、
I3 は `orca-issue.sh` を 1 件ずつ呼んでおり、**dispatch と wait を抱えたその 1 コールが
ブロックするので 1 件ずつ直列にしか走らなかった。**ユーザーが何を選んでも挙動が変わらない
= 質問そのものが嘘という状態だった。Stage A が作った「N タスクを 1 Run に載せて 1 回で
待つ」形が使われていなかった。

`--phase dispatch|finish|all` に分け、I3 を 3 パス（全件 dispatch → 1 回で待つ →
全件 finish）へ書き換えた。実機で issue #10 / #11 を 1 バッチで通した:

- 2 件が **同じ Run (`run_956feeaa10d5`)** を共有し、待たずに戻った
- **`orca-wait.sh` 1 回**で 2 件とも回収 (`role=design` の行が 2 本、exit 0)
- 両方 merge され、`dispatch/done` が付いて close された

### 実機でさらに 3 件出た

| | 症状 | 修正 |
|---|---|---|
| 1 | `--phase dispatch` が `orca-start.sh` の stdout を stderr へ複製しており、呼び出し側が **進捗のために `2>&1` で受けると `run_id=` が 2 行**になる。`--run` に改行入りの値が渡り **2 件目が起動しなかった** | 診断行だけ通す (IS15) |
| 2 | 親が dirty なことが **finish まで分からない**。merge の dirty ガードは finish で初めて発火するので、必ず merge できない仕事に worker を 1 本使う | dispatch 時に警告。**止めはしない**（間に commit されうる）(IS16) |
| 3 | finish phase は Run を知らないので **空の `run_id=` を印字**していた。受け取った側が `--run ""` を組み立てて壊れる | 空の値を印字しない (IS17) |

`[C7]` は 2 件とも記録済みなので通った。

## 未了

- なし（本計画の範囲では）

## この計画で扱わないもの

- **F-c**（PR 統合）。`--integration pr` は宣言しない
- **F-a**（`exec` 役 / Phase B 委譲）、**F-d**（二相コミット）、**F-e**（generation transition）
- wake 駆動（`dispatch-notify` / safety timer / timeout sentinel）
- spec 12-2 の `verifying` / `remediating` / `retained` 状態
- Linear 連携
