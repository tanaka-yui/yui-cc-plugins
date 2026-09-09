# orca-team-dispatch-task 残る follow-up（F-h / F-b 残り / F-d / F-e）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** spec の follow-up 表を最後まで実装する。残りは **F-h**（repo setup hook）・**F-b の残り半分**（`exec_review` と Phase B-R）・**F-d**（完了の二相コミット）・**F-e**（generation transition と owner replacement）。

**Spec:** `docs/superpowers/specs/2026-09-04-orca-team-dispatch-task-design.md` の 10 節全体（F-d）・10-5 と 12-1 の replacement branch（F-e）・7 節と 10-4（F-b 残り）・11 節（F-h）。

**前段:** Stage A / F-g / F-b（design 側）/ F-f / F-a / F-c は実装済み。

## 順序と理由

| # | follow-up | 先にやる理由 |
|---|---|---|
| 1 | **F-h** setup hook | 独立。他のどれにも依存されない。小さい |
| 2 | **F-b 残り** `exec_review` | F-a（exec 役）の上に載る。レビュー機構は design 側で動いており、役を 1 つ増やすだけ |
| 3 | **F-d** 二相コミット | **全役の完了手順を置き換える。**F-b 残りより後にしないと、`exec_review` を古い手順で書いてすぐ書き直すことになる |
| 4 | **F-e** generation transition | F-d の `completion.json` と nonce の上にしか成立しない |

## F-d の範囲を痩せさせない

spec は「簡易二相コミット」節を**撤回**している。理由もそこに書かれている: nonce 一致の
selector・Delivery の ack 順序・差し戻し後の再送経路・判断待ちの再発見の 4 つが必ず付いて
くるので、簡易形にしても解ける failure mode は想像したものだけになる。

したがって **F-d は 10-1 の 7 相をそのまま実装する。**相を減らさない。

## 既定を変えない — ただし F-d は例外である

F-g / F-b / F-a / F-c は「設定しなければ今までどおり」を守った。**F-d は守れない。**
二相コミットは worker の完了手順そのものであり、片方だけ通す worker が混ざると親の
検証が成立しない。よって **F-d は全 dispatch に一斉に効く。**

その代わり、**F-d の前後で外から見える結末は変わらない**ことをテストで固定する
（`status.json` と `received.json` と exit code の意味は同じ）。

## Global Constraints

- Orca CLI は PATH に無いことがある。**常に `$ORCA_BIN`** 経由で呼ぶ
- `SKILL.md` は英語のみ。日本語は `references/guide-ja.md` にだけ（`check-doc-lang.mjs`）
- bash ブロックはバイト一致（SK8d）、`[Cn]` の ID 集合（SK8）・制限表の行数（SK8c）・H2 の並び（SK8e）も一致
- **`test-docs.sh` の SK4 の禁止語は本計画で順に外す。**`exec_review` は F-b 残りで、`merge_ready` / `nonce` / `remediation` は F-d / F-e で。**外すのは実装した回の commit だけ**であり、まとめて外さない
- 完了条件は毎回 `bash test/run-all.sh` が **ALL GREEN**、`node scripts/check-doc-lang.mjs apps/orca-team-dispatch-task` が OK
- version は 3 箇所同期
- コミットメッセージは日本語。末尾に `Claude-Session: https://claude.ai/code/session_01EYLFvy1d56wB4ZwoNroYrx`
- **作業ブランチを離れたままコミットしない**

---

### Task 1: F-h — repo setup hook

現在は `worktree create --setup skip` 決め打ちで、「setup hook を要する repository は対象外」と
制限表に書いてある。設定で `run` を選べるようにする。

**Files:** `scripts/config-{lib,resolve,edit}.sh` / `bin/orca-start.sh` / `test/test-config.sh` / `test/test-start.sh` / `SKILL.md` / `guide-ja.md`

- [ ] **Step 1: `setup` 設定（`skip` 既定 / `run`）**

```bash
# CF34: setup の既定は skip（現行の挙動）
# CF35: run を選ぶと worktree create に --setup run が渡る
# CF36: setup は skip/run 以外を警告して落とす
# ST55: 既定では --setup skip のまま
```

- [ ] **Step 2: setup が失敗したら worker を起こさない**

setup が失敗した worktree で作業させると、依存の無いまま実装して**なぜ失敗したか分からない
成果**ができる。`worktree create` の receipt の setup 状態を見て、失敗なら起動しない。

```bash
# ST56: setup が失敗した receipt では worker-start を呼ばない
```

---

### Task 2: F-b 残り — `exec_review` と Phase B-R

**Files:** `scripts/config-lib.sh` / `bin/orca-start.sh` / `test/test-{config,start,wait}.sh` / 文書

- [ ] **Step 1: 役を足す**

`review_mode=on` かつ `phase_b=on` のとき `exec_review` を起こす。**`phase_b=off` では
起こさない** — レビューする実装役が居ない。

```bash
# CF37: review_mode=on かつ phase_b=on でのみ exec_review が増える
# CF38: review_mode=on / phase_b=off では exec_review を起こさない
# ST57: exec_review は exec より先に起きる（依頼先が居ないと詰まる。T4a と同じ理由）
```

- [ ] **Step 2: Phase B-R の往復**

design 側と同じラベル方式（`review-code:` / `review-verdict:`）。exec の spec に
往復手順を載せ、`review-plan:` ではなく `review-code:` を使う（spec 6-3 のラベル表）。

```bash
# ST58: exec の spec は review-code: を使い、design は review-plan: のまま
# WT38: 1 タスク 4 dispatch でも取りこぼさない
```

---

### Task 3: F-d — 完了の二相コミット

**10-1 の 7 相をそのまま実装する。**

**Files:** `bin/orca-start.sh`（全役の spec）/ `bin/orca-wait.sh`（相 3/4a/4b）/ `scripts/report-status.sh` / `test/*`

- [ ] **Step 1: `completion.json` と nonce**

```json
{"phase":"prepared|merge_ready_sent|accepted|settled","generation":1,"nonce":"…"}
```

- [ ] **Step 2: worker 側の相 1〜2、5〜7 を spec に載せる**

- [ ] **Step 3: 親側の相 3（検証）・4a（受理）・4b（差し戻し）**

検証内容は役ごとに違う（10-1 の表）。design = plan の実在、exec = `result.md` と
（`integration=pr` なら）`pr_url`、review 役 = 担当ラウンドの findings に `VERDICT:` 行。

- [ ] **Step 4: crash 境界（10-3）を回帰で固定する**

```bash
# CM1: prepared 直後の crash → merge_ready の再送は害にならない
# CM2: accepted 受領後・done 前の crash → accepted の replay で再実行できる
# CM3: worker_done 成立後・settled 前 → 再送せず settled を書いて ack
# CM4: 失敗系は completion.json を通さない（status.json = error が唯一の durable intent）
# CM5: F-d の前後で外から見える結末が変わらない
```

---

### Task 4: F-e — generation transition と owner replacement

**Files:** `bin/orca-wait.sh` / 新規 `bin/orca-recover.sh` / `test/*`

- [ ] **Step 1: 親 sweep が owner を回復する（10-1 の表）**

| 観測 | 行動 |
|---|---|
| active で到達可能 | exact Dispatch へ nudge |
| `failed` / `stopped` を証明 | `worker-start --retry-of` で replacement。**`task-create` を走らせない** |
| active だが確認できない / `outcome_unknown` | fence して再検査、または `worker-abandon` して `retained` |
| Orca 側が既に terminal | 送らない。ローカルを reconcile して終わる |

- [ ] **Step 2: generation を上げる**

replacement は generation を +1 し、**旧 capability と新 capability が同時に lifecycle を
進めないことを保証する**（fence が先）。

```bash
# RC1: active で到達可能なら nudge だけ（replacement を作らない）
# RC2: failed が証明されたら retry-of で replacement を作り、task-create は呼ばない
# RC3: outcome_unknown では replacement を作らない（O19）
# RC4: Orca 側が terminal ならローカルを reconcile して終わる
# RC5: replacement は generation を上げ、旧 generation の accepted を nonce 不一致で捨てる
```

---

## この計画で扱わないもの

- Orca の `gate-create` / `gate-resolve`
- nested worker depth を 2 に上げる運用
- `orca linear` 連携
- リモート worker（`--on <saved-environment>`）
