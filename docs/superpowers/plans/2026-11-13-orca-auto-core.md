# orca-team-dispatch-task `--auto` 本体（C2a: 1 台のマシン）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Orca の automation から数分おきに起動される `--auto` の親（tick）を作る。slack-issue-intake が管理する複数リポジトリの Ready の Issue を 1 本のキューにまとめ、難易度を判定し、この Mac の空きレーンへ `--issue` と同じ役の組み合わせで dispatch し、PR・merge・close・後片付けまで進める。報告の材料（report.json）も書く。

**Architecture:** tick は TypeScript だけで動く precheck（`bin/orca-auto.ts tick`）。待ち続けず、既存の部品を 1 歩ずつ呼ぶ: `orca-start.ts`（起動）、`orca-wait.ts --max-waits 1`（受理・exec の起動の合図・停滞）、`orca-stop.ts`（停止）、`orca-pr.ts`（PR）。**Issue ごとに「まとめ役の端末」と Run を 1 つずつ持つ**（下の spike と probe の結果）。Claude が要るのは難易度の判定だけで、tick が判定待ちを見つけたときだけ exit 0 で automation の agent を起こし、agent は `judge-list` / `judge-apply` で結果を返す。

**Tech Stack:** TypeScript（node が型除去で直接実行。Node 22.18 以上。実行時の npm 依存なし）、gh、git、Orca CLI 1.4.257、bash のテスト（`test/lib/orca-stub.sh` / `gh-stub.sh`）と `node --test`。

**Spec:** `docs/superpowers/specs/2026-11-12-issue-auto-dispatch-design.md` の 6 章（以下「元の設計」）と `docs/superpowers/specs/2026-11-13-auto-dispatch-additions-design.md`（以下「追加の設計」）。

## この計画の範囲（追加の設計 10 章「C2 は計画でさらに分ける」）

| 計画 | 内容 |
|---|---|
| **C2a（この計画）** | 1 台（この Mac）での本体。複数の拾う元・1 本のキュー・判定・役の組み合わせ・仕上げ・後片付け・続きからの再開・report.json・`make auto` |
| C2b | 複数マシン（`--on <environment>`、worktree の数での空き、遠くの worker の報告をメッセージで受ける）と、複数リポジトリにまたがる Issue（1 つの役が複数の worktree）。C2a の受け渡し（手元の status dir のファイル、手元のプラグインのパス）は、遠くのマシンのために C2b で置き換える |
| C2c | GitHub Project の Status とラベルの同期 |
| C3 | `make setup`（拾う元・関連リポジトリ・`--auto` 専用の checkout の用意と Orca への登録・ステータスラベルの作成・確認コマンド・並列数・役の組み合わせ・automation の登録と有効化） |

C2a の間、対象リポジトリが 2 つ以上と判定された Issue は Ready_Eng に回す（理由に「複数リポジトリの Issue は自動実行の対象外」と書く）。C2b でこの制限を外す。C2a の設定ファイルは C3 が書くが、この計画のテストは fixture の設定で動かす。

## spike と probe の結果（2026-11-13、Orca 1.4.257、macOS。計画の前に実施済み）

追加の設計 8.2 の「最初に小さく試す」は、計画を書く前に行った。ORCA_* の環境変数をすべて外したプロセス（automation の precheck と同じ条件）から試した。

**spike（Orca CLI を直接）**

1. `--from` / `--terminal` を渡さない orchestration の呼び出しは `no_active_sender_terminal` で失敗する。作り話の handle は `stable_pane_required` で失敗する。**handle は Orca が作った本物の端末のものが要る。**
2. `orca terminal create`（ただのシェル）の handle H を使えば、外のプロセスから `run-create --from H`、`worker-start --run R --from H`、`check --run R --terminal H`（読むと既読になる）、`check --peek [--wait]`、`inbox --terminal run:R` がすべて動く。
3. worker のメッセージは `run:R` の mailbox に入る。H のシェルには何も入力されない（起こしの行が打ち込まれる害は無かった）。
4. H を `terminal close` したあとも、`worker-start --run R --from H` は動き、worker のメッセージは `run:R` に届く。
5. 回復: 新しい端末 H2 で `run-use --id R --from H2` すると Run を引き継げる（consumer_generation が 1→2）。以後、古い H での `check` は `consumer_fenced` で拒まれる。H が閉じている間に届いたメッセージも H2 で読める。
6. `worker_done` は `--task-id` が無いと拒まれる（今の worker の指示は task id を渡しているので影響なし）。

**probe（このプラグインの入口を、ORCA_* の無い環境から `ORCA_TERMINAL_HANDLE=H` だけ付けて）**

7. `orca-start.ts --unattended --integration pr --design-mode plan` は動き、Run を作り（`run.json` の `parent_handle` が H）、design と design_review の 2 つの worker を **21 秒**で起動した。
8. Orca が付けるブランチ名は `<git の利用者の接頭辞>/<slug>`（例 `tanaka-yui/auto-probe`）、worktree は `~/orca/workspaces/<repo>/<slug>`。名前が重なると `-2` が付く（B2 の dispatch で実測）。**slug からブランチ名を組み立てず、`workers.json` の `roles.<役>.branch` を読む。**
9. `orca-wait.ts --max-waits 1 --timeout-ms 1000` は約 2 秒で終わり、決着が無ければ exit 3（行は出さない）。 11 分間に 40 回呼んでも害は無かった（worker は動き続けた）。決着したときの `outcome=` の行は、待機の前の `drainBatch` → `aggregate` → `finish` で出るので、`--max-waits 1` でも同じ（コードで確認。実機の決着までは待たなかった）。
10. コードを読んで分かったこと: orca-wait は**渡された status dir がすべて決着するまで**個々の `outcome=` 行を出さない（`aggregate` が 1 つでも未決着なら null）。また、期待していない dispatch のメッセージが mailbox にあると exit 1 で止まり、既読にしない。**だから全件を 1 つの Run に載せる形は使えない**（1 件の残りが全件を止める。元の設計 6.2 が避けたかった失敗）。Issue ごとに Run を分ければ、orca-wait をそのまま 1 件ずつ呼べる。

未確認: 遠くのマシン（`--on <environment>`）の worker のメッセージが手元の Run に届くか（C2b の最初のタスク）。同じ slug の worktree を、前の世代のブランチが remote にある状態で作り直したときのブランチ名（Task 10 で確かめる）。

## Global Constraints

- TypeScript で `any`・`unknown`・`class` を使わない（ユーザーの決まり）。node の型除去で直接実行し、実行時の npm 依存を足さない。
- 正本先行: 「X をする」と SKILL.md・README に書く前に、X を真にするコードとテストを書く。SKILL.md が正本、`references/guide-ja.md` は見出しも内容も完全な写し（同じコミットで更新）。SKILL.md の bash block に判定を書かない（コメント、`: "${VAR:?...}"` のガード、入口の呼び出しだけ）。
- Claude 向けの指示文書（SKILL.md 本文、`references/*.md`）は英語。日本語は `*-ja.md` だけ。`node scripts/check-doc-lang.mjs` を通す。
- orca-team-dispatch-task から Slack へ直接投稿しない（元の設計の非目標）。Slack への通知は slack-issue-intake が、ラベルとマーカーのコメントを読んで行う。
- ラベルを動かすときは**コメントを先に書き、そのあとでラベルを動かす**（元の設計 5.4）。マーカーは最終行に `<!-- orca-auto:<status の slug>:<generation>:<event> -->`。本文の形は `test/fixtures/orca-auto-comments.json` の例と一致させる。
- 1 つの Issue にステータスラベルは 1 つ（元の設計 5.1）。人が付けた Backlog / Pending / Ready_Eng / In review を AI が書き換えない（決まった遷移を除く）。
- Issue はどこでも `owner/repo#番号` で呼ぶ。状態ファイルのキー、slug に番号だけを使わない（追加の設計 5.2・9 章）。
- 確認できていない変更（確認コマンドが通らない、CI が落ちた・まだ始まっていない、結果の報告が読めない）と、インフラのリポジトリの変更を AI が merge しない。インフラでは `plan` / `apply` を走らせない。
- 秘密の値をログ、コメント、PR、report.json に出さない。
- 状態・ロック・report.json はリポジトリの外、`configHome()/auto/<name>/`（既定 `~/.claude/config/orca-team-dispatch-task/auto/<name>/`）に置く。`<name>` の既定は `main`。report.json の場所は slack-issue-intake の `REPORT_SOURCE_DIR` / `REPORT_SOURCE_FILE` と同じ約束。
- **`--auto` が実装に使う checkout は `--auto` 専用**（設定の `repos[].checkout`。C3 が clone して Orca に登録する）。人が作業している checkout を使わない。tick はこの checkout を default ブランチに合わせて書き換えてよいが、未コミットの変更があれば触らずにその Issue を止める（誰かが手を入れた印）。
- 版は上げない・push しない（ユーザーの指示: C2・C3 がすべて終わってから版を上げて main を push する）。
- コミットに `apps/slack-issue-intake/CLAUDE.md` のユーザーの未コミットの変更を混ぜない。`git add` はファイルを名指しする（`-A` / `.` を使わない）。
- 型検査と lint は `apps/orca-team-dispatch-task` で `../../node_modules/.bin/tsc --noEmit -p .` と `../../node_modules/.bin/biome check ./bin ./lib ./skills ./test`（この環境の pnpm は mise の shim で動かない）。テストは `bash test/run-all.sh < /dev/null`。ルートで `node scripts/check-doc-lang.mjs` と `node scripts/check-shared-contracts.mjs`。
- 新しい bash のテストの組は `test/run-all.sh` の `SUITE` に足す（足さないと run-all が失敗する）。

## Review Focus

1. **まとめ役の端末をユーザーが閉じた**: 次の tick は、その Issue だけ新しい端末を作って `run-use` し、その status dir の `run.json` の `parent_handle` を書き換えてから `orca-wait` を呼ぶ。古い handle のまま呼んで `consumer_fenced` で止まり続けない。→ Task 1 の AU3〜AU5。
2. **tick が重なった**（automation の実行中に人が `make auto`）: ロックが生きている間、2 つ目は何もせず exit 1（判定を起こさない）。同じ Issue を 2 回 dispatch しない。→ Task 3 の AU12。
3. **キューにいる間に人が Ready を外した**（Pending や Backlog に戻した）: その Issue はキューから消え、dispatch されない。判定の結果も捨てる。→ Task 4 の AU18。
4. **別のリポジトリで同じ番号**: `acme/app#7` と `acme/api#7` が同時に Ready でも、状態・slug が別になる。→ Task 4 の AU17、Task 7 の AU33。
5. **dispatch の途中で落ちた**（orca-start の途中、または成功後に状態を保存する前に締め切り）: 状態には orca-start を呼ぶ**前**に `dispatching` を記録する。次の tick は `workers.json` があり、どの役も `startIncomplete` でなければ running に進め、`startIncomplete` の役があれば `orca-start --resume` で続け、`workers.json` が無ければ queued に戻す。名前が `auto-` で始まる worktree で状態に無いものは report.json と stdout に「持ち主のいない worktree」と出し、消さない。→ Task 7 の AU34・AU35・AU38。

---

## ファイルの構成

| ファイル | 役目 |
|---|---|
| `lib/auto-paths.ts` | `autoDir(name)` とその下のファイル名（config / state / lock / report / judge / archive） |
| `lib/auto-config.ts` | `--auto` の設定の型と読み込み（C3 が書く。C2a は読むだけ） |
| `lib/auto-state.ts` | 状態ファイルの型、読み書き（`writeAtomic`）、ロック |
| `lib/auto-coordinator.ts` | Issue ごとのまとめ役の端末の用意・引き継ぎ・片付け |
| `lib/auto-comment.ts` | マーカー付きのコメント本文を作る（fixture と一致） |
| `lib/auto-github.ts` | gh の呼び出し（一覧、1 件の読み取り、コメント、ラベル、close、PR・CI・merge） |
| `lib/auto-queue.ts` | 優先度とキューの並べ替え（純粋な関数） |
| `lib/auto-request.ts` | worker への依頼文と、worker が書く `auto-result.json` の型と検査 |
| `lib/auto-cleanup.ts` | push → worker-release → worktree の削除 → ローカルのブランチの削除 → まとめ役の端末を閉じる → status dir の退避 |
| `lib/auto-report.ts` | report.json を作る |
| `bin/orca-auto.ts` | 入口。`tick` / `judge-list` / `judge-apply --file <f>` / `judge-model` / `status` |
| `skills/orca-team-dispatch-task/references/auto-judge.md`（と `-ja.md`） | 判定の手順（automation の agent と `make auto` の Claude が読む） |
| `lib/status.ts` | `MANAGED_LABELS`・`PRIORITY_LABELS`・`FEATURE_LABEL` を足す |
| `bin/orca-start.ts` | `--review-mode` / `--phase-b` の 1 回きりの上書きを足す |
| `skills/.../scripts/issue-fetch.ts` | `--auto` を設定したリポジトリでは `--issue` が Ready も除外する（元の設計 6.1） |
| `scripts/check-shared-contracts.mjs`（ルート） | 管理の印・優先度・新機能のラベル名の比べ合わせを足す |
| `test/test-auto.sh` | `orca-auto.ts` と auto の部品の bash テスト（stub を使う）。番号は AU1〜 |
| `test/unit/auto-*.test.ts` | 純粋な関数の単体テスト |
| `Makefile` | `auto` の target |

---

### Task 1: Issue ごとのまとめ役の端末

**Files:**
- Create: `lib/auto-paths.ts`、`lib/auto-coordinator.ts`、`test/test-auto.sh`
- Modify: `test/run-all.sh`（`SUITE` に `test-auto`）

**Interfaces:**
- Produces:
  - `autoDir(name: string): string` → `${configHome()}/auto/${name}`。`AUTO_FILES = { config: 'config.json', state: 'state.json', lock: 'lock.json', report: 'report.json', pending: 'judge/pending.json', decisions: 'judge/decisions.json', archive: 'archive' } as const`
  - `openCoordinator(worktreePath: string, slug: string): string | null` — `terminal create --worktree path:<worktreePath> --title orca-auto:<slug> --json` の handle。失敗で null。`worktreePath` は その Issue の `targets[0]` の `--auto` 専用の checkout（Orca に登録済み。C3）。
  - `ensureCoordinator(statusDir: string, worktreePath: string, slug: string): string | null` — `run.json` の `parent_handle` / `run_id` を読む。`orchestration run-current --from <handle> --json` の `result.run.id` が run_id かつ `coordinator_handle` が handle で、`terminal show --terminal <handle> --json` が ok なら handle を返す。どちらかが違えば `openCoordinator` → `run-use --id <run_id> --from <new>` → `run.json` の `parent_handle` だけを新しい handle に書き換えて（`writeAtomic`。`run_id` と `repo_root` はそのまま）返す。どの呼び出しが失敗しても null（その tick はその Issue を進めない）。
  - `closeCoordinator(statusDir: string): void` — `run.json` の handle を `terminal close`。失敗は無視（閉じていることが多い）。

- [ ] **Step 1: 失敗するテストを書く**（`test/test-auto.sh`。`ORCA_BIN` を `test/lib/orca-stub.sh` に向ける。入口はまだ無いので、`node --input-type=module -e` で部品を直接呼ぶ小さな driver をテストの中に書く）
  - AU1: `openCoordinator` → calls.log に `terminal create --worktree path:<p> --title orca-auto:<slug> --json`、戻り値が stub の handle。
  - AU2: 記録の handle が今も coordinator で端末も生きている → `terminal create` も `run-use` も呼ばない。
  - AU3: `terminal show` が `{"ok":false}`（閉じた）→ 新しい端末を作り `run-use --id <run_id> --from <新しい handle>`。
  - AU4: `run-current` の coordinator が別の handle（誰かが引き継いだ）→ AU3 と同じく引き継ぐ。
  - AU5: AU3 のあと `run.json` の `parent_handle` が新しい handle、`run_id` と `repo_root` が元のまま。
  - AU6: `run-use` が失敗 → null。`run.json` は書き換えない。
- [ ] **Step 2: 走らせて失敗を見る** — Run: `bash test/test-auto.sh` / Expected: `auto-coordinator.ts` が無いので AU1〜AU6 が FAIL。
- [ ] **Step 3: 実装する** — `runOrca` と `receiptOk` / `receiptObject`（`lib/orca.ts`）で呼ぶ。`run-current` の形は spike の出力（`result.run.id` / `result.run.coordinator_handle`）。
- [ ] **Step 4: 走らせて通るのを見る** — Run: `bash test/test-auto.sh && bash test/run-all.sh < /dev/null` / Expected: AU1〜AU6 PASS、ALL GREEN。
- [ ] **Step 5: コミット** — `git add lib/auto-paths.ts lib/auto-coordinator.ts test/test-auto.sh test/run-all.sh` / `git commit -m "feat(orca-team-dispatch-task): --auto の Issue ごとのまとめ役の端末を用意し、閉じられたら引き継ぐ"`

### Task 2: 2 つのプラグインの約束（管理の印・ラベル名・コメント）

**Files:**
- Create: `lib/auto-comment.ts`、`test/unit/auto-comment.test.ts`
- Modify: `lib/status.ts`、`scripts/check-shared-contracts.mjs`（ルート）、`test/unit/status.test.ts`

**Interfaces:**
- Produces:
  - `lib/status.ts`: `MANAGED_LABELS = ['from-slack', 'slack-thread'] as const`、`PRIORITY_LABELS = { critical: 'priority: critical', high: 'priority: high', middle: 'priority: middle', low: 'priority: low' } as const`、`FEATURE_LABEL = 'feature'`（slack-issue-intake の `LABEL_SPECS` と同じ名前）
  - `type AutoEvent = 'judged' | 'started' | 'needs-review' | 'partial-merge' | 'ai-merged' | 'human-merged' | 'failed' | 'stalled'`
  - `type CommentInput = { event: AutoEvent; generation: number; reason?: string; limitMinutes?: number; branch?: string; prs?: Array<{ repo: string; number: number; url: string }>; decisions?: string[]; summary?: string; mergedPrs?: Array<{ repo: string; number: number; url: string }>; unmergedPrs?: Array<{ repo: string; number: number; url: string; why: string }>; elapsedMinutes?: number; pushed?: boolean }`
  - `renderComment(input: CommentInput): { status: string; body: string }` — status はラベルの slug（`Ready_Eng` → `ready-eng`）。
  - `statusOfEvent(event: AutoEvent): string`（judged→Ready_Eng、started/stalled→In progress、needs-review/partial-merge→In review、ai-merged/human-merged→Done、failed→Failed）

- [ ] **Step 1: 失敗するテストを書く**
  - AC1: fixture の 8 件それぞれについて、本文から読める値（理由、上限、ブランチ、PR、決めた点、要約、経過）を `CommentInput` に入れて `renderComment` した `body` と `status` が fixture と完全に一致する（入力は各テストに直書き）。
  - AC2: `decisions` も理由の行も無い needs-review は throw（呼び出し側の誤り）。
  - AC3: 理由・要約の中の `<!--` と `-->` は全角に置き換えてから埋める（マーカーの偽装を防ぐ）。
  - `status.test.ts`: 3 つの定数の値。
  - ルート `check-shared-contracts.mjs`: intake の `SOURCE_LABEL`・`ADOPTED_LABEL` と orca の `MANAGED_LABELS`、intake の `LABEL_SPECS` に `PRIORITY_LABELS` の 4 つと `FEATURE_LABEL` があること。既存の「C2 で足す」コメントを消す。
- [ ] **Step 2: 走らせて失敗を見る** — Run: `node --test test/unit/auto-comment.test.ts test/unit/status.test.ts` と `node ../../scripts/check-shared-contracts.mjs` / Expected: FAIL。
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通るのを見る** — Expected: PASS、`check-shared-contracts: OK`。片方の定義を一時的に変えて exit 1 になることも確かめ、戻す。
- [ ] **Step 5: コミット** — ルートの `scripts/check-shared-contracts.mjs` も名指しで add。`git commit -m "feat(orca-team-dispatch-task): --auto のコメント本文とラベル名を slack-issue-intake との約束にそろえる"`

### Task 3: 設定・状態・ロック

**Files:**
- Create: `lib/auto-config.ts`、`lib/auto-state.ts`、`test/unit/auto-config.test.ts`、`test/unit/auto-state.test.ts`、`test/fixtures/auto-config.json`
- Modify: `test/test-auto.sh`

**Interfaces:**
- Produces:
  - 設定（`autoDir(name)/config.json`、version 1）:
    ```ts
    type AutoConfig = {
      version: 1; name: string; everyMinutes: number
      intakeConfig: string            // slack-issue-intake の config.json。既定 ~/.slack-issue-intake/config.json
      sources: Array<{ repo: string; related: string[]; pick: string }>   // pick の既定 'Ready'
      repos: Record<string, { checkout: string; verify: string[]; infra: boolean; verified: boolean; ci: boolean }>
      lanes: number                   // この Mac の最大 worktree 数（追加の設計 8.3）。既定 1
      roles: { review_mode: 'on' | 'off'; phase_b: 'on' | 'off' }
      limits: { defaultMinutes: number; maxMinutes: number; stallMinutes: number }  // 既定 60 / 240 / 30
      judge: { model: string; effort: string }   // 既定 'claude-opus-5-5[1m]' / 'high'
      minFreeMemoryMb: number; minFreeDiskMb: number  // 既定 4096 / 10240
    }
    readAutoConfig(name: string): AutoConfig | null   // 読めない・形が違う → null
    pickSources(config: AutoConfig): string[]
    ```
    `repos[].ci` は「そのリポジトリの PR には CI が走る」（C3 が CI の定義の有無から決める）。`pickSources` は slack-issue-intake の config の `repos[].name`（正本。追加の設計 11 章）のうち、`sources` に設定があるものを intake の順で返す。intake の config が読めなければ空。
  - 状態（`state.json`、version 1）:
    ```ts
    type Priority = 'critical' | 'high' | 'middle' | 'low'
    type Phase = 'judging' | 'queued' | 'dispatching' | 'running' | 'finishing' | 'review' | 'done' | 'failed' | 'stopped' | 'eng'
    type IssueState = {
      key: string /* owner/repo#N */; repo: string; number: number; title: string
      generation: number; phase: Phase; priority: Priority; category: string; readyAt: string
      targets: string[]; limitMinutes: number; reason: string
      slug: string; statusDir: string; branch: string; startedAt: string | null; stalledNotified: boolean
      prs: Array<{ repo: string; number: number; url: string }>; decisions: string[]
      finishingSince: string | null; cleanupPending: boolean; updatedAt: string
    }
    type AutoState = { version: 1; judgingSince: string | null; issues: Record<string, IssueState> }
    readState(name): AutoState   // 無ければ空の状態
    writeState(name, state): void  // writeAtomic
    takeLock(name, ttlMs): boolean; releaseLock(name): void
    ```
    - phase の意味: `judging` 判定待ち、`queued` 判定済み、`dispatching` orca-start の前に記録、`running` 実行中、`finishing` 決着して仕上げ中、`review` In review で PR を見張る、`done` / `failed` / `stopped`（人の変更で止めた）/ `eng`（Ready_Eng）は**墓標**。
    - **墓標は消さない**: generation・branch・prs を、Issue が閉じられるまで残す。人が Ready に戻したとき、generation を上げて前のブランチと PR から続けるため（Task 4・10）。
    - ロックは `{ pid, host, expiresAt }`。期限内で pid が生きていれば取れない。期限切れか pid が無ければ奪う。`ttlMs` は tick の予算（Task 11 の `AUTO_TICK_BUDGET_MS`）＋ 60 秒。

- [ ] **Step 1: 失敗するテストを書く**
  - CF1: fixture の設定を読み、欠けた項目に既定値が入る。CF2: `sources[].related` に `repos` に無いリポジトリがある → null。CF3: `lanes` が 1 未満・整数でない → null。CF4: `pickSources` は intake の repos と sources の共通部分を intake の順で返す。CF5: intake の config が無い → `[]`。
  - SS1: 状態の往復（書いて読むと同じ）。SS2: 壊れた JSON → throw（壊れた状態の上に新しく書いて履歴を失わない）。
  - AU12（`test-auto.sh`）: ロックを取った別プロセスが生きている間、`takeLock` は false。期限切れのロックは奪える。
- [ ] **Step 2〜4: 失敗を見る → 実装 → 通るのを見る** — Run: `node --test test/unit/auto-config.test.ts test/unit/auto-state.test.ts && bash test/test-auto.sh` / Expected: 先に FAIL、実装後に PASS。
- [ ] **Step 5: コミット** — `git commit -m "feat(orca-team-dispatch-task): --auto の設定・状態・ロックを持つ"`

### Task 4: 同期と 1 本のキュー

**Files:**
- Create: `lib/auto-github.ts`、`lib/auto-queue.ts`、`test/unit/auto-queue.test.ts`
- Modify: `test/test-auto.sh`

**Interfaces:**
- Consumes: Task 2 の `MANAGED_LABELS`・`PRIORITY_LABELS`・`FEATURE_LABEL`・`STATUS`、Task 3 の型。
- Produces:
  - `listReadyManaged(repo: string, pick: string): Array<{ number: number; title: string; labels: string[]; updatedAt: string }> | null` — `gh issue list --repo <repo> --state open --label <pick> --label <印> --limit 100 --json number,title,labels,updatedAt` を印ごとに 2 回（`--label` を重ねると AND。gh の仕様。Step 1 の AU19 で引数を固定する）。番号で重ねずに合わせる。どちらかが読めなければ null（その回はそのリポジトリの新しい候補を入れない）。
  - `viewIssue(repo: string, number: number): { state: 'OPEN' | 'CLOSED'; labels: string[]; title: string } | null` — `gh issue view <n> --repo <repo> --json state,labels,title`。**追跡中の Issue は一覧ではなく 1 件ずつ読む**（一覧の件数の上限や絞り込みで漏れたものを「人が変えた」と取り違えないため）。読めなければ null（その回はその Issue を変えない）。
  - `readyAtOf(repo, number): string` — `gh api repos/<repo>/issues/<n>/timeline --paginate` の最新の `labeled`（pick ラベル）の `created_at`。読めなければ Issue の updatedAt。
  - `priorityOf(labels: string[]): Priority`（`PRIORITY_LABELS`。無ければ middle）
  - `orderQueue(items: IssueState[]): IssueState[]` — critical → high → middle → low、同じなら readyAt の古い順、同じなら key の辞書順（決定的にするため）。
  - `syncIssues(state: AutoState, sources: Array<{ repo: string; pick: string }>): { added: string[]; dropped: string[]; humanChanged: string[] }`
    - 一覧の候補で、状態に無いもの → generation 1、phase `judging`。
    - 一覧の候補で、状態が墓標（done 以外: `failed` / `stopped` / `eng`、または `review`）のもの → generation を 1 上げて `judging`。**Ready_Eng を人が Ready に戻したものも判定し直す**（人がやらせると決めた印。ただし判定の手順書に「人が Ready_Eng から戻した」と渡し、判定は auto を選びやすくする。Task 5）。
    - 状態が `judging` / `queued` の Issue は `viewIssue` で読み、閉じた・pick ラベルが無い → 状態から消し `dropped` に入れる。
    - 状態が `running` / `dispatching` の Issue は `viewIssue` で読み、In progress が付いていない（`dispatching` で In progress をまだ付けていないものは除く）→ `humanChanged` に入れる（Task 8 が止めて片付ける）。閉じた → 同じく `humanChanged`。
    - 墓標の Issue は `viewIssue` で閉じていれば状態から消す。毎回全部を読まないよう、墓標は `updatedAt` から 1 日以上たったものだけ 1 日 1 回読む（読む件数を抑える。値は `AUTO_TOMBSTONE_CHECK_HOURS = 24`）。

- [ ] **Step 1: 失敗するテストを書く**
  - QU1: 優先度の順。QU2: 同じ優先度は readyAt の古い順。QU3: ラベルの無いものは middle と同じ順位。QU4: critical があとから来ても先頭。
  - AU16: gh stub の 2 つのリポジトリ（`acme/app`、`other/api`）の Ready の Issue が、1 回の sync で両方とも `judging` に入る。`from-slack` と `slack-thread` の両方が付いた Issue は 1 件。
  - AU17: `acme/app#7` と `other/api#7` が別の key で入る。
  - AU18: `judging` の Issue の Ready を外して（`issue view` の応答を Pending に）sync → 状態から消え、`dropped` に出る。
  - AU19: calls.log の `issue list` に `--label Ready --label from-slack` と `--label Ready --label slack-thread` の 2 回。管理の印の無い Ready の Issue（stub が返さない）は入らない。
  - AU20: `gh issue list` が失敗したリポジトリは、そのリポジトリの既存の状態を変えない。`issue view` が失敗した Issue も変えない。
  - AU21: 状態が `failed`（generation 1）の Issue が一覧に出た → generation 2 の `judging`。branch と prs は残る。
  - AU22: `running` の Issue の `issue view` が Pending → `humanChanged`。一覧に出ないだけ（view では In progress）なら何もしない。
- [ ] **Step 2〜4** — Run: `node --test test/unit/auto-queue.test.ts && bash test/test-auto.sh` / Expected: 先に FAIL、実装後に PASS。
- [ ] **Step 5: コミット** — `git commit -m "feat(orca-team-dispatch-task): 複数リポジトリの Ready を 1 本のキューに同期する"`

### Task 5: 難易度の判定（judge-list / judge-apply と手順書）

**Files:**
- Create: `bin/orca-auto.ts`（この Task では `judge-list` と `judge-apply` と `judge-model`）、`skills/orca-team-dispatch-task/references/auto-judge.md`、`skills/orca-team-dispatch-task/references/auto-judge-ja.md`
- Modify: `test/test-auto.sh`

**Interfaces:**
- Consumes: Task 2 の `renderComment`、Task 3、Task 4 の状態。
- Produces:
  - `orca-auto.ts judge-list [--name <n>]` — ロックを取り、状態の `judgingSince` を今にして保存（**判定のリース**。Task 11 の tick は、これが `AUTO_JUDGE_LEASE_MS = 20 * 60_000` より新しい間は判定のために exit 0 しない）。`judging` の Issue を JSON で stdout と `judge/pending.json` に出す:
    `{ issues: [{ key, generation, title, body, labels, category, returnedFromEng: boolean, related: string[] }], checkouts: Record<repo, path>, limits: { defaultMinutes, maxMinutes } }`。body は gh から読む。
  - 判定の結果のファイル（Claude が書く。`judge/decisions.json`）:
    ```json
    [{ "key": "acme/app#42", "generation": 1, "route": "auto", "targets": ["acme/app"], "limitMinutes": 60, "reason": "…" }]
    ```
    `route` は `"auto"` か `"eng"`。
  - `orca-auto.ts judge-apply --file <f> [--name <n>]` — ロックを取り、1 件ずつ検査して反映し、最後に `judgingSince` を null にする。
    - 検査: key と generation が `judging` の状態と一致、`targets` が空でなく `related` の部分集合、`limitMinutes` が 1 以上 maxMinutes 以下の整数、`reason` が空でない。合わない行は捨てて stderr に理由を出す（その Issue は `judging` のまま次の回にもう一度判定される）。
    - `route: "eng"`、`targets` が 2 つ以上（C2a の制限）、`targets` が 3 つ以上（元の設計 6.3）、カテゴリが新機能（`FEATURE_LABEL`。ただし `returnedFromEng` のときは除く: 人がやらせると決めたため）のどれか → Ready_Eng: コメント（event `judged`）→ ラベルを Ready から Ready_Eng に。phase `eng`。
    - `route: "auto"` → targets・limitMinutes・reason を入れ、phase `queued`。ラベルは Ready のまま（元の設計 6.4）。コメントは書かない（理由と上限は開始のコメントに書く。Task 7）。
    - exit: 0 = 全行を反映、1 = 捨てた行がある、2 = 使用法。
  - `orca-auto.ts judge-model [--name <n>]` — 設定の `judge.model` を 1 行で出す（`make auto` と C3 の automation の登録が使う。元の設計 6.3「判定の model と effort は設定で変えられる」）。
  - `references/auto-judge.md`（英語）: 判定の手順。`judge-list` を走らせる → 各 Issue の本文と、`checkouts` の関連リポジトリのコードを読む（読むだけ、書かない）→ 行き先・対象・上限・理由を決める → `decisions.json` を書く → `judge-apply` を走らせ、exit 1 なら理由を読んで直せる行だけ直して 1 回だけやり直す。Ready_Eng の基準（難しい、長くレーンを占める、新機能、3 リポジトリ以上。C2a では 2 リポジトリ以上）と、上限時間の決め方（maxMinutes を超えない。長く見積もるものは Ready_Eng の候補）、`returnedFromEng` は人がやらせると決めたものなので原則 auto、と書く。Slack に投稿しない、ラベルを直接動かさない、と書く。

- [ ] **Step 1: 失敗するテストを書く**
  - AU23: `judge-list` が `judging` 2 件を JSON で出し、`judge/pending.json` も同じ。`checkouts` に related の checkout がある。`judgingSince` が入る。
  - AU24: auto の判定 → phase `queued`、targets・limitMinutes・reason が入る。gh stub の calls.log に `issue edit` も `issue comment` も無い。`judgingSince` が null に戻る。
  - AU25: eng の判定 → `issue comment` が `issue edit --add-label Ready_Eng --remove-label Ready` より**先**、本文の最終行が `<!-- orca-auto:ready-eng:1:judged -->`。
  - AU26: `targets` が 2 つ → Ready_Eng、理由に「複数リポジトリ」を含む。
  - AU27: `limitMinutes` が maxMinutes を超える行・`related` に無い target・generation が古い行は捨てられ、exit 1、その Issue は `judging` のまま。
  - AU28: コメントの投稿が失敗したらラベルを動かさない（順番の約束）。
  - AU29: `returnedFromEng` の新機能を auto と判定 → Ready_Eng にせず `queued`。
- [ ] **Step 2〜4** — Run: `bash test/test-auto.sh` / Expected: 先に FAIL、実装後に PASS。`node ../../scripts/check-doc-lang.mjs apps/orca-team-dispatch-task` も OK。
- [ ] **Step 5: コミット** — `git commit -m "feat(orca-team-dispatch-task): --auto の難易度の判定を judge-list と judge-apply で受け取る"`

### Task 6: orca-start に役の組み合わせの上書きを足す

**Files:**
- Modify: `bin/orca-start.ts`、`test/test-start.sh`

**Interfaces:**
- Produces: `orca-start.ts … [--review-mode on|off] [--phase-b on|off]`。設定の 3 層より強い 1 回きりの上書き（`--agent` などと同じ扱い）。値の検査は `validToggle`。`--resume` と `--phase exec` では、記録済みの値と違えば使用法エラー（exit 2）。

- [ ] **Step 1: 失敗するテストを書く**（`test/test-start.sh` の既存の最大の番号の続き）
  - 設定が review_mode=off でも `--review-mode on` で design_review が起動される（stub の calls.log に 2 つの worker-start）。
  - `--phase-b on` で workers.json の `integration_role` が `exec`。
  - `--review-mode maybe` → exit 2。
- [ ] **Step 2〜4** — Run: `bash test/test-start.sh` / Expected: 先に FAIL、実装後に PASS。
- [ ] **Step 5: コミット** — `git commit -m "feat(orca-team-dispatch-task): orca-start で review_mode と phase_b を 1 回だけ上書きできるようにする"`

### Task 7: 補充（空いたレーンへ dispatch する）

**Files:**
- Create: `lib/auto-request.ts`、`test/unit/auto-request.test.ts`
- Modify: `bin/orca-auto.ts`（`tick` の補充の段）、`test/test-auto.sh`

**Interfaces:**
- Consumes: Task 1 の `openCoordinator`、Task 3・4・6。
- Produces:
  - `slugOf(key: string): string` — `auto-<owner>-<repo>-<N>`。英数字と `-` 以外は `-`、連続する `-` は 1 つ、全体を小文字、40 文字を超えるときは `<owner>-<repo>` の部分を切り詰めて末尾に key の sha1 の先頭 6 文字を付ける（決定的・一意）。**generation を含めない**（続きから再開するときに同じ名前を使うため。Task 10）。
  - `buildRequest(issue: IssueState, body: string, repo: AutoConfig['repos'][string], roles: AutoConfig['roles'], resultPath: string, continuation: string | null): string` — worker への依頼文（英語）。含めるもの: Issue の key・題・本文、確認コマンド（`verify` を 1 行ずつ。実装後に必ず全部走らせる）、人に尋ねない、sudo を使わない、インフラなら `fmt` / `validate` だけで `plan` / `apply` やクラウドの認証情報を使わない、`roles` が off/off なら PR を出す前に同じセッションの subagent でレビューさせる（`.claude/agents` にレビュー向けの agent があればそれ、無ければ組み込みの汎用 subagent。往復は `AUTO_REVIEW_ROUNDS = 3` 回まで）、integration role の `result.md`（orca-pr が PR の本文にする）に Issue へのリンク `owner/repo#N`・変更の要約・レビューの要点（指摘と対応）を書く、終わったら `resultPath` に `auto-result.json` を書く。
  - `type AutoResult = { decisions: string[]; summary: string; verify: { passed: boolean; ran: string[] }; review: { unresolved: string[]; declined: string[] }; envFailure: string | null }`、`readAutoResult(path: string): AutoResult | null`（形が違えば null）。
  - tick の補充の段:
    1. 空き = `lanes` − 動いている `auto-` の worktree の数（`orca worktree list --json` で名前が `auto-` で始まるもの）。1 件が使う worktree の数は `roleNames(review_mode, phase_b).length`（追加の設計 8.1・8.3）。空きが足りなければ入れない。
    2. この Mac の空きメモリ（`os.freemem()`）と、checkout のあるディスクの空き（`statfsSync`）が `minFreeMemoryMb` / `minFreeDiskMb` 未満なら、その回は入れない（元の設計 6.5）。
    3. `orderQueue` の `queued` の先頭から選ぶ。`repos[targets[0]].verified` が false でも選ぶ（C2a は 1 台なので、確認の通っていないリポジトリの Issue は checkout のあるこの Mac で実装し、仕上げで In review に回す。追加の設計 11 章の 1 つ目）。
    4. `--auto` 専用の checkout の用意: `git -C <checkout> status --porcelain` が空でなければ、その Issue は入れず stdout に理由を出す。`gh repo view <repo> --json defaultBranchRef` の default ブランチを `git fetch origin <default>` → `git checkout -B <default> origin/<default>`。
    5. `openCoordinator(checkout, slug)` → 状態を phase `dispatching`・slug・statusDir（`<checkout>/.dispatch/<slug>`）にして保存してから、`ORCA_TERMINAL_HANDLE=<handle> node orca-start.ts --request-file <f> --slug <slug> --objective "<key> <題>" --repo-root <checkout> --integration pr --unattended --design-mode plan --review-mode <…> --phase-b <…>` を呼ぶ（`--run` は渡さない。orca-start がこの端末の Run を作る。Issue ごとに Run を分ける理由は probe の 10）。
    6. 成功（exit 0 で `workers.json` があり、どの役も `startIncomplete` でない）→ `workers.json` の integration role の `branch` を状態に入れる → 開始のコメント（event `started`。理由・上限・ブランチ）→ ラベルを Ready から In progress に → phase `running`、`startedAt`。失敗 → phase を `queued` に戻し、stderr の理由を stdout に出す（資源は orca-start の決まりどおり残る）。
    7. 次の orca-start を呼ぶ前に、tick の残りが `AUTO_START_RESERVE_MS = 60_000` 未満なら補充をやめる（probe で 2 役の起動が 21 秒。4 役でも 60 秒に収まる見込み）。
    8. 前の tick が `dispatching` で落ちた Issue: `workers.json` が無い → `queued` に戻す（まとめ役の端末は閉じる）。ある → `startIncomplete` の役があれば `ORCA_TERMINAL_HANDLE=<run.json の handle> node orca-start.ts --slug <slug> --resume --repo-root <checkout>`、無ければ 6 の成功の処理。

- [ ] **Step 1: 失敗するテストを書く**（orca-start は、テスト専用の環境変数 `ORCA_AUTO_BIN_DIR` で差し替えた stub の node スクリプトにして、引数と環境を記録し、決めた status dir を作って返す）
  - RQ1〜RQ4（unit）: `slugOf` が決定的、`acme/app#7` と `other/api#7` で違う、長い名前で 40 文字以下、英数字以外を置き換える。RQ5: `buildRequest` に確認コマンドの全行・`resultPath`・インフラの禁止・`result.md` に `owner/repo#N` を書く指示が入る。RQ6: off/off のときだけ subagent のレビューの指示が入る。RQ7: `readAutoResult` が欠けた項目で null。
  - AU30: レーン 1・動いている `auto-` の worktree 0・queued 1 → `terminal create` のあと orca-start が 1 回、引数に `--integration pr --unattended --review-mode off --phase-b off --repo-root <checkout>`、`--run` が無く、環境に `ORCA_TERMINAL_HANDLE=<作った handle>`。成功後、状態の branch が workers.json の値、`issue comment`（started）が `issue edit --add-label In progress --remove-label Ready` より先。
  - AU31: 動いている `auto-` の worktree がレーンの数だけある → orca-start を呼ばない。
  - AU32: review_mode=on・phase_b=on（1 件 4 worktree）でレーン 3 → 入れない。
  - AU33: 同じ番号の 2 件 → 別の slug と status dir。
  - AU34: orca-start が exit 1 → phase queued に戻り、ラベルを動かさない。
  - AU35: `dispatching` のまま残った状態で、`workers.json` があり全役が起動済み → running に進めて started のコメントとラベル。`startIncomplete` の役がある → `--resume` の orca-start。`workers.json` が無い → queued に戻る。
  - AU36: checkout に未コミットの変更がある → 入れず、stdout に理由。
  - AU37: 空きメモリが下限未満（テスト専用の環境変数 `ORCA_AUTO_FREE_MEMORY_MB` で差し替え）→ 入れない。
  - AU38: 状態に無い `auto-` の worktree がある → stdout に「持ち主のいない worktree」、消さない。
- [ ] **Step 2〜4** — Run: `node --test test/unit/auto-request.test.ts && bash test/test-auto.sh` / Expected: 先に FAIL、実装後に PASS。
- [ ] **Step 5: コミット** — `git commit -m "feat(orca-team-dispatch-task): --auto の tick で空いたレーンへ dispatch する"`

### Task 8: 進み（受理・exec の起動・停滞・上限時間・人による変更）

**Files:**
- Modify: `bin/orca-auto.ts`（`tick` の進みの段）、`test/test-auto.sh`

**Interfaces:**
- Consumes: Task 1 の `ensureCoordinator`、Task 3・4・7。
- Produces: tick の進みの段。phase `running` の Issue ごとに:
  1. `ensureCoordinator(statusDir, checkout, slug)`。null ならその Issue はこの回は飛ばす。
  2. `orca-wait.ts --status-dir <d> --max-waits 1 --timeout-ms 1000 --stall-after-min <stallMinutes> --on-stall report` を **1 件ずつ**呼ぶ（Issue ごとに Run が別なので、ほかの Issue のメールで止まらない）。
     - exit 0 → phase `finishing`、`finishingSince`（Task 9）。
     - exit 5 → 失敗の仕上げ（Task 9）。
     - exit 9 → `ORCA_TERMINAL_HANDLE=<handle> node orca-start.ts --phase exec --slug <slug> --repo-root <checkout>`。
     - exit 8（停滞）→ `stalledNotified` が false なら stalled のコメントだけ書き（ラベルは In progress のまま）、true にする。
     - exit 3 → 何もしない（まだ動いている）。
     - exit 6 → `--unattended` では起きないはずなので、stdout に出して何もしない。
     - exit 1 / 4 → この回はこの Issue を決めず、stdout に出す（ほかの Issue は続ける）。
  3. `now − startedAt > limitMinutes` → 全役を `orca-stop.ts --status-dir <d> --role <role>` で止め、失敗の仕上げ（理由「上限時間（N 分）を超えました」）。
  4. Task 4 の `humanChanged` に入った Issue → 全役を止め、Task 9 の後片付け（push してから消す）を行い、phase `stopped`。コメントもラベルも書かない（人の変更を上書きしない）。

- [ ] **Step 1: 失敗するテストを書く**（orca-wait・orca-stop・orca-start は Task 7 と同じ `ORCA_AUTO_BIN_DIR` の stub にし、Issue ごとに決めた終了コードを返す）
  - AU40: running 2 件 → orca-wait が 2 回、それぞれ 1 つの `--status-dir` と `--max-waits 1`。
  - AU41: 片方が exit 0 → その Issue だけ finishing。もう片方が exit 4 でも、exit 0 のほうは finishing に進む。
  - AU42: exit 9 → `--phase exec` の orca-start が `ORCA_TERMINAL_HANDLE` 付き。
  - AU43: exit 8 → stalled のコメントが 1 回。次の tick で同じく exit 8 でもコメントは増えない。
  - AU44: 上限時間を超えた（`ORCA_AUTO_NOW` で時刻を差し替え）→ 全役の orca-stop → Failed のコメント（理由に上限時間）→ ラベル Failed。
  - AU45: 人が In progress を Pending に変えた → orca-stop、push、worktree の削除が呼ばれ、`issue comment` と `issue edit` は呼ばれない。phase `stopped`、branch は残る。
  - AU46: まとめ役の端末が閉じている → `ensureCoordinator` が引き継いでから orca-wait（calls.log で `run-use` が orca-wait より先）。
- [ ] **Step 2〜4** — Run: `bash test/test-auto.sh` / Expected: 先に FAIL、実装後に PASS。
- [ ] **Step 5: コミット** — `git commit -m "feat(orca-team-dispatch-task): --auto の tick で worker を 1 件ずつ 1 歩進め、停滞・上限時間・人の変更に応じる"`

### Task 9: 仕上げと後片付け

**Files:**
- Create: `lib/auto-cleanup.ts`
- Modify: `lib/auto-github.ts`、`bin/orca-auto.ts`（仕上げの段）、`test/test-auto.sh`

**Interfaces:**
- Consumes: Task 2・7・8。
- Produces:
  - finishing の Issue:
    1. `readAutoResult(<statusDir>/auto-result.json)`。PR が未作成なら `node orca-pr.ts --status-dir <d> --repo <targets[0]>`。**`--issue` は渡さない**: orca-pr は `--issue` があると本文に `Closes #N` を足し、merge の瞬間に GitHub が Issue を閉じる。そうすると ai-merged のコメントより先に slack-issue-intake が「閉じた」を読み、メンション付きの通知が出なくなる。Issue へのリンクとレビューの要点は worker が `result.md` に書く（Task 7）。close は tick が行う。PR の番号と URL を状態に入れる（`gh pr view <branch> --repo <r> --json number,url`）。
    2. CI: `gh pr checks <n> --repo <r> --json state`。pending を含む → 次の回にもう一度見る（元の設計 6.6）。**`repos[r].ci` が true で検査が 1 つも無い**ときも pending とみなす（CI がまだ始まっていない）。ただし `finishingSince` から `AUTO_CI_APPEAR_MINUTES = 30` 分たっても 1 つも無ければ、In review（理由「CI が始まりません」）。`ci` が false で検査が無い → CI 無しとして扱う（元の設計 6.6「CI が無いリポジトリでは確認コマンドが通れば merge してよい」）。
    3. merge してよい条件（すべて満たす）: 結果が読めた、`decisions`・`review.unresolved`・`review.declined` がすべて空、`verify.passed`、`envFailure` が null、CI が全部成功か CI 無し、リポジトリが `verified` で `infra` でない。
       - 満たす → `gh repo view --json squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed` で squash → merge → rebase の順に許された方法で `gh pr merge` → ai-merged のコメント（要約と PR）→ ラベル Done → `gh issue close`。phase `done`。merge が失敗したら needs-review（理由に merge できなかったこと）→ In review。
       - 満たさない → needs-review のコメント（決めた点、未解消・不採用の指摘、CI の失敗、確認できないリポジトリ、インフラ、結果が読めない、のうち当てはまるもの。理由の行が必ず 1 つ以上）→ ラベル In review。phase `review`。
    4. どちらでも後片付け。
  - 失敗の仕上げ（Task 8 から）: 結果の `envFailure` があれば理由に「環境が原因: …」を足す → failed のコメント（ブランチが push 済みかを書く）→ ラベル Failed → 後片付け。phase `failed`。
  - review の Issue: 毎回 `gh pr view <n> --repo <r> --json state,mergedAt`。merged → human-merged のコメント → ラベル Done → close。phase `done`。
  - `autoCleanup(statusDir: string, checkout: string, branch: string, archiveDir: string, generation: number): { ok: boolean; pushed: boolean; reasons: string[] }` — 順に: `branch` に default より先のコミットがあれば `git push origin <branch>`（失敗したらそこで止め、何も消さない）→ workers.json の全 dispatch に `orchestration worker-release --dispatch <id>` → 各役の worktree を `orca worktree rm --worktree path:<worktree_path> --delete-branch`（ローカルのブランチも消える。probe の片付けで確認済み）→ `closeCoordinator(statusDir)` → statusDir を `archiveDir/<slug>-g<generation>` へ移す。途中の失敗は reasons に入れ、次の回にもう一度呼べる（冪等）。後片付けが ok でない間は、Issue の phase を変えても `cleanupPending: true` を状態に持ち、毎回やり直す。

- [ ] **Step 1: 失敗するテストを書く**
  - AU50: 決めた点が空・確認が通った・CI 成功 → orca-pr（引数に `--issue` が無い）→ `gh pr merge --squash` → ai-merged のコメント → Done → close の順。
  - AU51: 決めた点が 1 つ → merge しない、needs-review のコメントに決めた点、In review。
  - AU52: CI が pending → 何もしない。CI が失敗 → In review、理由に CI。
  - AU53: `ci: true` で検査が 0 件 → 何もしない。30 分たっても 0 件 → In review、理由に「CI が始まりません」。`ci: false` で 0 件 → merge する。
  - AU54: インフラのリポジトリ → merge しない。
  - AU55: `auto-result.json` が無い → In review、理由に「結果の報告が読めない」。
  - AU56: squash が許されていない → `--merge`。
  - AU57: review の PR が人の手で merge された → human-merged のコメント → Done → close。
  - AU58: 後片付けの順（push → release → `worktree rm --delete-branch` → terminal close → 退避）。push が失敗 → それ以降を呼ばず、次の回にやり直す。
  - AU59: 失敗の仕上げで `envFailure` → コメントに「環境が原因」。
- [ ] **Step 2〜4** — Run: `bash test/test-auto.sh` / Expected: 先に FAIL、実装後に PASS。
- [ ] **Step 5: コミット** — `git commit -m "feat(orca-team-dispatch-task): --auto の成果を PR にして merge か確認に回し、push してから後片付けする"`

### Task 10: Ready に戻されたものを続きから行う

**Files:**
- Modify: `lib/auto-request.ts`、`lib/auto-github.ts`、`bin/orca-auto.ts`、`test/test-auto.sh`、`test/unit/auto-request.test.ts`

**Interfaces:**
- Consumes: Task 4 の generation の上げ方と墓標、Task 7 の `slugOf`、Task 9 の状態の `branch` と `prs`。
- Produces:
  - `continuationOf(issue: IssueState, since: string): string | null` — generation が 2 以上で前の世代のブランチがあるとき、前の世代の終わり（墓標の `updatedAt`）からあとに付いた PR のレビューコメント（`gh api repos/<r>/pulls/<n>/comments`）、PR と Issue のコメント（`gh api repos/<r>/issues/<n>/comments?since=`）、CI の結果（`gh pr checks`）を Markdown にまとめる。`<!-- orca-auto:` を含む自分のコメントは除く。
  - 依頼文の先頭に「前の世代のブランチ `<前の branch>` が origin にある。最初に `git fetch origin <前の branch>` と `git reset --hard origin/<前の branch>` をしてから、下のコメントと CI に応えて直す」と続きの材料を入れる。
  - dispatch のあと、新しい世代の integration role の branch が前の世代の branch と同じなら、orca-pr は同じブランチを push し、開いている PR をそのまま使う（`a pull request for <branch> already exists`）。**違う名前になった**（Orca が `-2` を付けた）ときは、orca-pr が新しい PR を作り、tick が前の PR に「<新しい PR> に引き継ぎました」とコメントして閉じる（人が開いている前の PR を残すと、どれが今の PR か分からなくなるため。元の設計 6.3 の「開いている PR をそのまま使う」が名前の都合で守れないときの代わり）。
  - 前の世代の PR が closed（merge されずに閉じられた）なら、orca-pr が同じブランチから新しい PR を作る（元の設計 6.3）。

- [ ] **Step 1: 失敗するテストを書く**
  - RQ8: generation 1 では続きの段落が無い。RQ9: generation 2 で PR のレビューコメント・Issue のコメント・CI の失敗が入り、自分のマーカーのコメントは入らない。
  - AU60: Failed の Issue が Ready に戻る → 判定 → dispatch で、slug が前の世代と同じ、依頼文に `git reset --hard origin/<前の branch>`。
  - AU61: 前の PR が開いていて、新しい branch が同じ名前 → 仕上げで新しい PR を作らず、状態の PR を使う。
  - AU62: 新しい branch が違う名前 → 新しい PR を作り、前の PR に引き継ぎのコメントをして `gh pr close`。
- [ ] **Step 2〜4** — Run: `node --test test/unit/auto-request.test.ts && bash test/test-auto.sh` / Expected: 先に FAIL、実装後に PASS。
- [ ] **Step 5: 実機で 1 回だけ確かめる** — 使い捨てのブランチを origin に push したリポジトリで、同じ slug の worktree を orca-start で作り直したときに Orca が付けるブランチ名を見る（前のローカルのブランチと worktree は消した状態で）。結果を ledger に書き、AU61 / AU62 のどちらが普通に起きるかを CLAUDE.md（Task 12）に書く。確かめたら worktree・ブランチ・端末を消す。
- [ ] **Step 6: コミット** — `git commit -m "feat(orca-team-dispatch-task): Ready に戻された Issue を前のブランチと PR から続ける"`

### Task 11: tick の通し・report.json・make auto・--issue との住み分け

**Files:**
- Create: `lib/auto-report.ts`、`test/unit/auto-report.test.ts`
- Modify: `bin/orca-auto.ts`（`tick` の組み立てと `status`）、`Makefile`、`skills/orca-team-dispatch-task/scripts/issue-fetch.ts`、`test/test-auto.sh`、`test/test-issue-fetch.sh`、`test/test-docs.sh`

**Interfaces:**
- Consumes: Task 1〜10。
- Produces:
  - `orca-auto.ts tick [--name <n>]` の順（追加の設計 8.2、元の設計 6.2）: ロック → 設定 → 同期（Task 4）→ review の監視と finishing（Task 9）→ 進み（Task 8）→ 補充（Task 7）→ report.json → ロックを外す。予算は `AUTO_TICK_BUDGET_MS = 100_000`（C3 は automation の precheck の時間切れを 120 秒で登録する）。段の前ごとに残りを見て、足りなければ以降の段を飛ばす（report.json だけは書く）。後片付けが残っている Issue（`cleanupPending`）は finishing の段でやり直す。
    - 最後の行に `auto: judge=<judging の数> dispatched=<n> finished=<n> errors=<n>` を出す。
    - exit: **0 = `judging` があり、判定のリース（`judgingSince`）が無いか `AUTO_JUDGE_LEASE_MS` より古い**（automation の agent を起こす）／ **1 = それ以外**（判定が要らない・判定中・エラー・ロック中。precheck は 0 以外で起動しない）／ 2 = 使用法。
  - `buildReport(config, state, used, now): AutoReport` — `test/fixtures/auto-report.json` と同じ形（version 1、name、updatedAt、everyMinutes、running、queue、hosts）。running は phase `running` / `finishing`（host は `os.hostname()`、startedAt、limitMinutes）、queue は `orderQueue` の順で `queued` だけ（`judging` は含めない）、hosts はこの Mac 1 件（used = 動いている `auto-` の worktree の数、max = lanes、reachable true）。書くのは `autoDir(name)/report.json`（`writeAtomic`）。題名はそのまま入れる（slack-issue-intake が表示時に `maskSecrets` を通す）。
  - `orca-auto.ts status [--name <n>]` — 状態の要約を人向けに出す（読むだけ）。
  - `Makefile`: `auto: ## --auto を 1 回まわす（NAME=main）。判定が要るときは Claude で判定する` — `node bin/orca-auto.ts tick --name $(NAME)` を走らせ、exit 0 のときだけ `claude --model "$$(node bin/orca-auto.ts judge-model --name $(NAME))" "Follow $(CURDIR)/skills/orca-team-dispatch-task/references/auto-judge.md for --auto name $(NAME)."` を起動する。exit 1 は成功として終える（判定が要らないだけ）。`NAME ?= main`。
  - `issue-fetch.ts`: そのリポジトリ（`gh repo view` の nameWithOwner）が、どれかの `--auto` の設定（`configHome()/auto/*/config.json`）の `sources[].repo` に入っていれば、検索の除外に `Ready` も足す（元の設計 6.1）。`--auto` の設定が 1 つも無ければ今のまま。

- [ ] **Step 1: 失敗するテストを書く**
  - RP1（unit）: 状態から作った report が fixture と同じ鍵と型を持つ（値は入力どおり）。RP2: `judging` は queue に入らない。RP3: queue の順が `orderQueue` と同じ。
  - AU70: `judging` が 1 件・リース無し → exit 0、最後の行 `auto: judge=1 …`。
  - AU71: `judging` が 1 件・リースが 5 分前 → exit 1。リースが 25 分前 → exit 0。
  - AU72: `judging` 0 → exit 1、report.json が書かれる。
  - AU73: ロック中 → exit 1、gh も orca も呼ばない。
  - AU74: 予算の残りが少ない（`ORCA_AUTO_BUDGET_MS` で差し替え）→ 補充を飛ばし、report.json は書く。
  - IF（`test-issue-fetch.sh` の既存の最大の番号の続き）: `--auto` の設定に入っているリポジトリでは検索に `-label:"Ready"` が入る。入っていないリポジトリでは入らない。
  - SK（`test-docs.sh` の既存の最大の番号の続き）: `make -n auto` の出力に `orca-auto.ts tick --name main` がある。
- [ ] **Step 2〜4** — Run: `node --test test/unit/auto-report.test.ts && bash test/test-auto.sh && bash test/test-issue-fetch.sh && bash test/test-docs.sh` / Expected: 先に FAIL、実装後に PASS。
- [ ] **Step 5: 実機で 1 回だけ確かめる** — 設定を 1 つ（自分のリポジトリの使い捨ての clone を `--auto` 専用の checkout として Orca に登録、lanes 1、Ready の Issue が無い状態）書いて `make auto` → exit 1 で終わり、report.json ができ、端末が増えないこと。確かめたら設定・状態・clone を消し、Orca から外す。結果を ledger に書く。
- [ ] **Step 6: コミット** — `git commit -m "feat(orca-team-dispatch-task): --auto の tick を通しで組み、報告の材料を書き、make auto を足す"`

### Task 12: 文書

**Files:**
- Modify: `skills/orca-team-dispatch-task/SKILL.md`、`skills/orca-team-dispatch-task/references/guide-ja.md`、`README.md`、`CLAUDE.md`（プラグインの）、`test/test-docs.sh`

**Interfaces:**
- Consumes: Task 1〜11 で真になったことだけ。

- [ ] **Step 1: 失敗するテストを書く**（`test-docs.sh` の SK の番号の続き）
  - SKILL.md と guide-ja.md の両方に `--auto` の節があり、`orca-auto.ts tick` / `judge-list` / `judge-apply` / `make auto` を参照し、参照先のファイルが実在する。
  - SKILL.md の `--auto` の bash block に判定（`if` / `case` / `&&` の分岐）が無い（既存の SK26 の検査の対象に含まれること）。
  - SKILL.md に「C3 で作る `make setup`」を実装済みと書いていない（未実装の非宣言）。
- [ ] **Step 2: 走らせて失敗を見る** — Run: `bash test/test-docs.sh` / Expected: FAIL。
- [ ] **Step 3: 書く**
  - SKILL.md: 冒頭の「Route on the arguments first」に `--auto` を足す。`## Auto mode` の節: 何をするか（1 本のキュー、判定、役の組み合わせ、仕上げ、後片付け、report.json）、設定のファイルと形（C3 の `make setup` が書く。今は手で書く、と正直に書く）、`--auto` 専用の checkout、`make auto`、automation の agent が読む `references/auto-judge.md`、資源を消す例外（`--auto` だけ。元の設計 6.6）、Issue ごとのまとめ役の端末（閉じても次の回で作り直す）、C2a の制限（この Mac だけ、対象リポジトリは 1 つ）。
  - guide-ja.md: 同じ見出しで完全な訳。
  - README.md: 能力の要約に 3〜4 行。
  - CLAUDE.md（プラグイン）: `## --auto の要点` に、tick 駆動と Issue ごとのまとめ役の端末（spike と probe の結果の要点と日付・版。1 つの Run に全件を載せない理由）、`orca-wait --max-waits 1` の終了コードの読み方、状態の phase と墓標、slug に generation を入れない理由とブランチ名を workers.json から読む理由、`dispatching` での回復、`--issue` を渡さない orca-pr、後片付けが資源を消す例外であること、回帰のテストの番号。「範囲」の節に `--auto`（C2a）を足す。
- [ ] **Step 4: 通るのを見る** — Run: `bash test/run-all.sh < /dev/null`、`../../node_modules/.bin/tsc --noEmit -p .`、`../../node_modules/.bin/biome check ./bin ./lib ./skills ./test`、ルートで `node scripts/check-doc-lang.mjs` と `node scripts/check-shared-contracts.mjs` / Expected: ALL GREEN、すべて OK。
- [ ] **Step 5: コミット** — `git commit -m "docs(orca-team-dispatch-task): --auto（1 台のマシン）の使い方と開発の要点を書く"`（版は上げない）
