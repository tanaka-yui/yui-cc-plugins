# orca-team-dispatch-task Phase B 委譲（F-a）と PR 統合（F-c）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 計画する役と実装する役を分け（**F-a**）、成果を merge ではなく pull request で届けられるようにする（**F-c**）。

**順序の理由:** **F-a を先にやる。**F-a は「成果がどのブランチに載るか」を変える（design から exec へ）。F-c はそのブランチを push して PR にするので、後から入れると F-c の中心を作り直すことになる。

**Tech Stack:** bash + jq + `gh`、Orca CLI（`$ORCA_BIN`）、テストは自作の bash ランナーと `orca-stub.sh` / `gh-stub.sh`

**Spec:** `docs/superpowers/specs/2026-09-04-orca-team-dispatch-task-design.md` の 5-1（T5-T9）・6-4（Phase B の指示配送）・9-2（`integration.json` の生成契約）。follow-up 表の **F-a** と **F-c**。

**前段:** Stage A / F-g（設定）/ F-b（レビュー）/ F-f（`--issue`）は実装済み。

## 既定を変えない

**`phase_b` も `integration` も既定は今までどおり。**設定していない利用者の dispatch は
1 ミリも変わらない。これは F-g・F-b・F-f で通した原則と同じである。

| 設定 | 既定 | `on` / 変更時 |
|---|---|---|
| `phase_b` | `off` — `design` が計画も実装もする（現行） | `on` — `design` は計画だけ、`exec` が実装する |
| `integration` | `merge` — 親ブランチへ取り込む（現行） | `pr` — ブランチを push して pull request を作る |

## 成果を載せるブランチを 1 箇所で決める

F-a は「どのブランチを取り込むか」を変える。**`orca-merge.sh` と PR 作成が別々に
判断すると必ずずれる**ので、`workers.json` に **`integration_role`** を持つ。

- `phase_b=off` → `design`
- `phase_b=on` → `exec`

`orca-merge.sh` は `.roles[.integration_role].branch` を取り込む。F-c の PR も同じ値を読む。

## Global Constraints

- Orca CLI は PATH に無いことがある。**常に `$ORCA_BIN`** 経由で呼ぶ
- `SKILL.md` は英語のみ。日本語は `references/guide-ja.md` にだけ（`check-doc-lang.mjs`）
- SKILL.md と `guide-ja.md` の **bash ブロックはバイト一致**（SK8d）。`[Cn]` の ID 集合（SK8）・制限表の行数（SK8c）・H2 の並び（SK8e）も一致させる
- **`test-docs.sh` の SK4 の禁止語のうち `exec_review` / `merge_ready` / `nonce` / `remediation` は緩めない。**本計画は `exec` 役を足すが、**`exec_review` と Phase B-R は範囲外**であり、二相コミット（F-d）も入れない
- 完了条件は毎回 `bash test/run-all.sh` が **ALL GREEN**、`node scripts/check-doc-lang.mjs apps/orca-team-dispatch-task` が OK
- version は 3 箇所同期
- コミットメッセージは日本語。末尾に `Claude-Session: https://claude.ai/code/session_01EYLFvy1d56wB4ZwoNroYrx`
- **作業ブランチを離れたままコミットしない**（本セッションで 1 度やった。一時ブランチ上の commit をブランチごと消しかけた）

---

## F-a: Phase B 委譲

### Task A1: `integration_role` を導入する（挙動を変えない）

**この Task では役を増やさない。**`workers.json` に `integration_role: "design"` を書き、
`orca-merge.sh` がそれ経由でブランチを引くようにするだけ。**挙動は 1 つも変わらない。**

**Files:** `bin/orca-start.sh` / `bin/orca-merge.sh` / `test/test-start.sh` / `test/test-merge.sh`

- [ ] **Step 1: 先にテストを書く**

```bash
# MG12: integration_role が無ければ **推測せず** 止まる（design を既定にしない）
# MG13: integration_role が指す役の branch を取り込む
# ST45: workers.json に integration_role が入る
```

**`// "design"` の既定を置かない。**置くと、F-a を入れたあとに `integration_role` を
書き損ねた dispatch が **黙って design のブランチを取り込む**。取り込み先の取り違えは
成果の喪失につながるので、`orca-merge.sh` の他の identity と同じく「無ければ止まる」。

### Task A2: `phase_b` 設定と `exec` 役

**Files:** `scripts/config-lib.sh` / `config-resolve.sh` / `config-edit.sh` / `test/test-config.sh`

- [ ] **Step 1: `phase_b` を `review_mode` と同じ構えで足す**

```bash
# CF26: phase_b の既定は off で、ロールは design（+ review_mode 次第）
# CF27: phase_b=on で exec が増え、integration_role が exec になる
# CF28: phase_b は on/off 以外を警告して落とす
# CF29: off でも exec の tuple は設定できる（on にする前に準備できる）
```

`dispatch_all_role_names` に `exec` を足し、`dispatch_role_names <review_mode> <phase_b>` が
起動する役を返す。**`exec_review` は足さない。**

### Task A3: design は計画し、exec が実装する

**Files:** `bin/orca-start.sh` / `bin/orca-wait.sh` / `test/test-start.sh` / `test/test-wait.sh`

- [ ] **Step 1: 起動を 2 段にする**

`exec` は **design が終わってから**起動する。design の計画が無いうちに実装させられない。

1. `design`（+ `design_review`）を起動 → 待つ
2. design が成功していれば `exec` を起動 → 待つ
3. design が失敗していれば **`exec` を起動しない**

**`orca-start.sh` は 1 段目までを担う。**2 段目は新しい口（`--phase exec`）にする。
`orca-issue.sh` の phase 分割と同じ理由で、**待ちを抱えたコマンドを増やさない**。

- [ ] **Step 2: 計画の受け渡し**

design は `<status-dir>/plan.md` に計画を書く。**親が spec を手書きしない**（spec の裁定）
ので、exec の spec も `render_spec` が生成し、その中で plan.md の絶対パスを名指しする。

```bash
# ST46: phase_b=on の design の spec は「実装するな、計画を plan.md へ書け」と言う
# ST47: exec の spec は plan.md の絶対パスを名指しする
# ST48: design が失敗していたら exec を起動しない
# ST49: plan.md が空なら exec を起動しない（空の計画で実装させない）
# WT36: exec の worker_done も期待集合に入る（1 タスク 3 dispatch）
```

- [ ] **Step 3: `integration_role` を exec にする**

Task A1 の 1 箇所だけが変わる。`orca-merge.sh` は触らない。

---

## F-c: PR 統合

### Task C1: `integration` 設定と `bin/orca-pr.sh`

**Files:** `scripts/config-{lib,resolve,edit}.sh` / `bin/orca-pr.sh` / `test/test-config.sh` / `test/test-pr.sh`

- [ ] **Step 1: repo を **呼び出し側が 1 度だけ解決する****

spec 12-2 の実測（2026-09-02）: 3 remote の repository で子が remote を自分で解決し、
**personal fork へ push して fork の中に PR を作った。**issue はそこに無いので
`Closes #NNN` は効かず、その fork PR が完了の証拠として受理された。

したがって **`orca-pr.sh` は `--repo <owner/repo>` を必須にする。**自分で `origin` を
見に行かない。`gh` に推測させない。

```bash
# PR1: --repo が無ければ何もしない（exit 2）
# PR2: gh pr create に必ず --repo が渡る
# PR3: push に失敗したら PR を作らない
# PR4: PR ができたら pr_url を integration-result.json に記録する
# PR5: 既に PR がある（冪等な再実行）なら作り直さず、その URL を返す
# PR6: --issue <N> が与えられたら本文に "Closes #<N>" を入れる
```

### Task C2: `orca-merge.sh` と `orca-issue.sh` を integration で分岐させる

**Files:** `bin/orca-issue.sh` / `SKILL.md` / `guide-ja.md` / `test/test-issue.sh`

- [ ] **Step 1: `integration=pr` なら merge しない**

**両方やらない。**PR を作ったうえで親へ merge すると、PR がレビューされる前に成果が
入ってしまう。`integration` はどちらか一方である。

```bash
# IS18: integration=pr なら orca-merge.sh を呼ばない
# IS19: integration=pr で PR ができたら dispatch/done へ遷移し issue を close **しない**
#       （PR がマージされて初めて閉じるべきである。Closes が効く）
# IS20: PR に失敗したら dispatch/failed で資源を残す
```

**`integration=pr` のとき issue を close しない**のが重要である。`Closes #N` を本文に
入れてあるので、**PR がマージされたときに GitHub が閉じる。**先に閉じると、PR が
却下されても issue は閉じたままになる。

### Task C3: 文書と制限

- [ ] **Step 1: `--issue` の質問に integration を戻す**

F-f では「merge 固定」として尋ねなかった。実装したので尋ねる。

- [ ] **Step 2: 制限表を更新する**

「`--issue` は merge する。PR を作らない」の行を消し、代わりに PR 経路の制限を書く
（fork を持つ repository で `--repo` を明示すること、close は PR のマージに任せること）。

---

## この計画で扱わないもの

- **F-b の残り半分**（`exec_review` と Phase B-R）
- **F-d**（二相コミット / `merge_ready`）、**F-e**（generation transition）
- PR のレビュー待ちや自動マージ
- Draft PR / reviewer 指定
