# 後片付けのモード（cleanup）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** orca-team-dispatch-task に設定 `cleanup`（`end` / `pr_created` / `pr_merged`）を足し、PR を作ったタスクを、PR を作った直後か merge のあとに尋ねずに片付ける。

**Architecture:** 値はほかの切り替えと同じ層で解決し、dispatch の開始時に `workers.json` に記録する。片付けは今の `orca-cleanup.ts plan` / `run` をそのまま使う。PR のタスクを「保存済み」とみなす入力（`--pr-saved`）を plan に足し、その上に 2 つの入口を足す。`auto` は Step 4 の PR の直後に、`sweep` は Step 1 の前に、尋ねずに走る。

**Tech Stack:** TypeScript（node の型除去で直接実行、Node 22.18 以上、実行時の npm 依存なし）、bash のテスト（orca-stub.sh・gh-stub.sh）。

**Spec:** `docs/superpowers/specs/2026-11-16-dispatch-cleanup-mode-design.md`

## Global Constraints

- TypeScript で `any` / `unknown` / `class` を使わない。実行時の npm 依存を足さない。
- 既定は `end`。`end` のときと、記録の無い旧い dispatch の動きを変えない（既存のテストの期待値を書き換えたら、計画からのずれとして result.md に書く）。
- `integration=merge` のタスクは設定にかかわらず `end`。`--auto`（`--transport mail` で起こした dispatch）は対象外。
- 片付けは `plan` が提示したものだけを実行する。人が操作した端末など、今の Step 5 が残すものは、どのモードでも残す。
- `CLOSED`（merge されずに閉じた）と `OPEN` の PR のタスクは自動で消さない。gh が読めないときは何もせず 1 行言い、dispatch を止めない。
- SKILL.md が正本で、`references/guide-ja.md` は見出しも内容も完全な写し（同じコミットで直す）。SKILL.md の bash block に判定を書かない（入口の 1 行呼び出しだけ）。
- 版は上げない・push しない。`git add` はファイルを名指しする。`apps/slack-issue-intake` に触れない。
- 型検査と lint は `apps/orca-team-dispatch-task` で `../../node_modules/.bin/tsc --noEmit -p .` と `../../node_modules/.bin/biome check ./bin ./lib ./skills ./test`、テストは `bash test/run-all.sh < /dev/null`、ルートで `node scripts/check-doc-lang.mjs` と `node scripts/check-shared-contracts.mjs`。

## Review Focus

- 同じ Run にほかのタスクが残っているときの `auto` / `sweep`: 片付けるのは対象の slug だけで、ほかのタスクの worker を「記録に無い retained」と誤って読んで全体を止めない（plan には同じ Run の残っている status dir を全部渡し、承認は対象の slug だけ）。CL44 で固定する。
- PR を作ったあとに worker が足したコミット: ブランチの HEAD が origin と違えば保存済みとみなさない。CL41 で固定する。
- `--auto` の status dir（`transport: mail`）が対象の repo の `.dispatch/` にある場合: `sweep` も `auto` も触らない。CL51 で固定する。
- Step 5 に、`auto` / `sweep` が消したタスクの status dir を渡すと MISSING で止まる。SKILL.md の Step 5 で「残っている status dir だけを渡す」と書き、SK38 で固定する。
- gh の失敗や PR の URL の欠け: 何もせずに続ける。CL49 / CL50 で固定する。

---

### Task 1: 設定 `cleanup` の解決と記録

**Files:**
- Modify: `apps/orca-team-dispatch-task/lib/config.ts`（`TOGGLES` と `TOGGLE_KEYS`）
- Modify: `apps/orca-team-dispatch-task/bin/orca-start.ts`（`--cleanup` の 1 回きりの上書き、`workers.json` の初期値）
- Test: `apps/orca-team-dispatch-task/test/test-config.sh`、`apps/orca-team-dispatch-task/test/test-start.sh`

**Interfaces:**
- Produces: `TOGGLES.cleanup = { values: ['end', 'pr_created', 'pr_merged'], fallback: 'end' }`。`workers.json` の最上位の `cleanup: 'end' | 'pr_created' | 'pr_merged'`。

- [ ] **Step 1: 失敗するテストを書く**
  - CF53: `config-edit.ts --layer global --set cleanup=pr_merged` のあと、`config-resolve.ts` の出力の `cleanup` が `pr_merged`。何も設定しなければ `end`。
  - CF54: `--set cleanup=later` は拒まれ、ファイルは変わらない。
  - ST138: 設定 `cleanup=pr_created` で新規の dispatch を起こすと `workers.json` の `.cleanup` が `pr_created`。`--cleanup pr_merged` を渡すとそちらが勝つ。
  - ST139: `--integration merge` で起こすと、設定が `pr_merged` でも `.cleanup` は `end`。`--transport mail`（`--auto` の起動）でも `end`。
  - ST140: `--resume` / `--phase exec` に `--cleanup` を渡すと使用法の誤りで止まる（`--integration` と同じ。記録した値を保つ）。
- [ ] **Step 2: 走らせて失敗を見る** — `bash test/test-config.sh < /dev/null` と `bash test/test-start.sh < /dev/null`。CF53〜54・ST138〜140 が FAIL。
- [ ] **Step 3: 実装** — `TOGGLES` に `cleanup` を足し、`TOGGLE_KEYS` に入れる。`orca-start.ts` は `--integration` と同じ形で `--cleanup` を受け、解決した値を `workers.json` の初期値に `cleanup` として書く。解決した `integration` が `merge` のとき、または `--transport mail` のときは `end` を書く。続きの段は記録を変えない。
- [ ] **Step 4: 走らせて通るのを見る** — 同じ 2 つと、全体の `bash test/run-all.sh < /dev/null`。
- [ ] **Step 5: コミット** — `git add apps/orca-team-dispatch-task/lib/config.ts apps/orca-team-dispatch-task/bin/orca-start.ts apps/orca-team-dispatch-task/test/test-config.sh apps/orca-team-dispatch-task/test/test-start.sh && git commit -m "feat(orca-team-dispatch-task): 後片付けのモード cleanup を設定と記録に足す"`

### Task 2: plan の `--pr-saved`

**Files:**
- Modify: `apps/orca-team-dispatch-task/bin/orca-cleanup.ts`（`planCommand` の引数、`planTask` の `merged` の判定）
- Test: `apps/orca-team-dispatch-task/test/test-cleanup.sh`

**Interfaces:**
- Produces: `orca-cleanup.ts plan --status-dir <dir>... [--pr-saved <dir>]...`。`--pr-saved` に名指しした dir のタスクは、次の 2 つが揃えば「保存済み」として、worktree と記録を今の merge 済みのタスクと同じ条件で提示する。(1) `integration-result.json` の `integration` が `pr` で `pr_url` が空でない。(2) `workers.json` の `integration_role` の branch について、`run.json` の `repo_root` での `git rev-parse refs/heads/<branch>` と `git ls-remote origin refs/heads/<branch>` の SHA が一致する。揃わなければ、今の「not merged」の理由に加えて、欠けた方の理由を残す（`the pull request is not recorded` / `the branch has commits that are not on origin`）。

- [ ] **Step 1: 失敗するテストを書く**
  - CL40: `integration-result.json` が `{"merged":false,"integration":"pr","pr_url":"https://github.com/o/r/pull/1",...}` で branch が origin と一致する。`--pr-saved` を付けると worktree と記録の offer が出て、付けなければ出ない（今どおり）。
  - CL41: ローカルの branch に origin に無いコミットがあると、`--pr-saved` を付けても worktree と記録を残し、理由に `the branch has commits that are not on origin` が入る。
  - CL42: `pr_url` が無いと残し、理由に `the pull request is not recorded` が入る。
  - CL43: `--pr-saved` に `--status-dir` に無い dir を渡すと使用法の誤り（何も書かない）。
- [ ] **Step 2: 走らせて失敗を見る** — `bash test/test-cleanup.sh < /dev/null`。CL40〜43 が FAIL。
- [ ] **Step 3: 実装** — `planCommand` に `pr-saved`（multiple）を足す。`planTask(dir, workers, listed, prSaved: boolean)` にし、`merged` を「`integration-result.json` の merged、または prSaved で (1)(2) が揃う」にする。`git ls-remote` は `run.json` の `repo_root` で走らせる。worktree の他の条件（dirty・端末の照合など）は変えない。
- [ ] **Step 4: 走らせて通るのを見る** — `bash test/test-cleanup.sh < /dev/null` と全体。
- [ ] **Step 5: コミット** — `git commit -m "feat(orca-team-dispatch-task): plan に PR を保存済みとみなす --pr-saved を足す"`（test-cleanup.sh と orca-cleanup.ts を名指し）

### Task 3: `orca-cleanup.ts auto`（PR を作ったら）

**Files:**
- Modify: `apps/orca-team-dispatch-task/bin/orca-cleanup.ts`
- Test: `apps/orca-team-dispatch-task/test/test-cleanup.sh`

**Interfaces:**
- Consumes: Task 1 の `workers.json.cleanup`、Task 2 の `plan --pr-saved`。
- Produces: `orca-cleanup.ts auto --status-dir <dir>`。終了コードは、片付けた・何もしなかったが 0、片付けの一部が失敗したら 1、使用法の誤りは 2。

- [ ] **Step 1: 失敗するテストを書く**
  - CL44: 同じ Run・同じ `.dispatch/` に 2 タスク（a と b）。a は `cleanup=pr_created` で PR があり保存済み、b は merge も PR も無い。`auto --status-dir a` は、a の端末の解放・worktree の削除・記録の削除を実行し、b には何もしない（b の worker を記録に無い retained と読んで止まらない）。
  - CL45: `cleanup` が `end` か `pr_merged`、または記録が無いときは、何も実行せず `cleanup mode is <値>; nothing to do` を 1 行言って 0。
  - CL46: plan が残したもの（例: 人が操作した端末）は実行せず、その理由を 1 行ずつ表示する。
  - CL47: `transport: mail` の dir には何もしない。
- [ ] **Step 2: 走らせて失敗を見る** — CL44〜47 が FAIL。
- [ ] **Step 3: 実装** — `auto` は対象の dir の `workers.json` を読み、`cleanup` が `pr_created` で `transport` が `mail` でないときだけ進む。同じ `.dispatch/` の下で `run.json` の `run_id` が同じ、残っている status dir を全部集めて plan の `--status-dir` に渡し、対象の dir だけを `--pr-saved` にする。計画ファイルから、対象の slug の offer がある種類だけを `--approve <slug>:<kind>` にして `run` を同じプロセスの関数として呼ぶ。plan の出力の kept は表示する。
- [ ] **Step 4: 走らせて通るのを見る** — test-cleanup.sh と全体。
- [ ] **Step 5: コミット** — `git commit -m "feat(orca-team-dispatch-task): PR を作ったタスクを尋ねずに片付ける orca-cleanup.ts auto を足す"`

### Task 4: `orca-cleanup.ts sweep`（PR が merge されたら）

**Files:**
- Modify: `apps/orca-team-dispatch-task/bin/orca-cleanup.ts`
- Test: `apps/orca-team-dispatch-task/test/test-cleanup.sh`（gh は `test/lib/gh-stub.sh`）

**Interfaces:**
- Consumes: Task 3 の、同じ Run の dir を集めて plan と run を呼ぶ部分（関数として共有する）。
- Produces: `orca-cleanup.ts sweep`。repo root は cwd の git から決める。終了コードは常に 0（掃除の失敗で dispatch を止めない）。使用法の誤りだけ 2。

- [ ] **Step 1: 失敗するテストを書く**
  - CL48: `.dispatch/` に `cleanup=pr_merged` で `pr_url` があるタスクが 2 つ。gh の `pr view <url> --json state` が一方は `MERGED`、他方は `OPEN`。`MERGED` の方だけが片付き、`OPEN` の方には何もしない。
  - CL49: `CLOSED` なら何もしない。gh が失敗したら、何もせず `could not read <url>; left as is` を 1 行言って 0。
  - CL50: `pr_url` の無いタスク、`cleanup` が無い旧い記録、`cleanup=end` / `pr_created` のタスクは見ない（gh も呼ばない）。
  - CL51: `transport: mail` の dir は見ない。
  - CL52: `.dispatch/` が無い repo では何もせず 0。
- [ ] **Step 2: 走らせて失敗を見る** — CL48〜52 が FAIL。
- [ ] **Step 3: 実装** — `.dispatch/*/workers.json` を読み、条件に合うタスクだけ gh で状態を読む。`MERGED` のタスクを Run ごとにまとめ、Task 3 の部分で plan（`MERGED` のタスクを `--pr-saved`）と run（`MERGED` のタスクの offer だけを承認）を呼ぶ。
- [ ] **Step 4: 走らせて通るのを見る** — test-cleanup.sh と全体。
- [ ] **Step 5: コミット** — `git commit -m "feat(orca-team-dispatch-task): merge された PR のタスクを次の dispatch の始めに片付ける orca-cleanup.ts sweep を足す"`

### Task 5: 文書

**Files:**
- Modify: `apps/orca-team-dispatch-task/skills/orca-team-dispatch-task/SKILL.md`、`references/guide-ja.md`（同じ形で）、`apps/orca-team-dispatch-task/README.md`（能力の要約 1 行）、`apps/orca-team-dispatch-task/CLAUDE.md`（設計の要点と回帰の番号）
- Test: `apps/orca-team-dispatch-task/test/test-docs.sh`

- [ ] **Step 1: 失敗するテストを書く**
  - SK38: SKILL.md と guide-ja.md の両方に、Configuration の表の `cleanup` の行（`end` / `pr_created` / `pr_merged`）、Step 1 の前の `orca-cleanup.ts" sweep` の 1 行呼び出し、Step 4 の PR の block のあとの `orca-cleanup.ts" auto --status-dir "$SD"` の呼び出し、Step 5 の「`auto` / `sweep` が消したタスクの status dir は渡さない」の文、`--auto` は対象外の文がある。SKILL.md 側に日本語を書かない（既存の SK10 / doc-lang が見る）。
- [ ] **Step 2: 走らせて失敗を見る** — `bash test/test-docs.sh < /dev/null`。SK38 が FAIL。
- [ ] **Step 3: 書く** — 上の 5 か所を SKILL.md に英語で書き、guide-ja.md に同じ見出しで訳す。`--issue` の I3 の pass 3 にも、PR を作れた Issue ごとに同じ `auto` を呼ぶ 1 行を足す。README は能力の要約だけ。CLAUDE.md には、PR のタスクを今まで Step 5 が片付けなかった理由（not merged）と `--pr-saved` の 2 条件、同じ Run の dir を全部 plan に渡す理由を書く。
- [ ] **Step 4: 走らせて通るのを見る** — test-docs.sh、ルートの `node scripts/check-doc-lang.mjs`、全体。
- [ ] **Step 5: コミット** — `git commit -m "docs(orca-team-dispatch-task): 後片付けのモードを説明する"`
