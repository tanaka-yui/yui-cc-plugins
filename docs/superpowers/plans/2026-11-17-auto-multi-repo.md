# orca-team-dispatch-task `--auto` 複数リポジトリの Issue（C2b2）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `--auto` で、実装するリポジトリが 2 つの Issue を、1 つの役（design / design_review / exec / exec_review）がリポジトリごとの worktree を持つ形で、判定から PR・merge（または In review）・後片付けまで進める。

**Architecture:** 1 つ目のリポジトリ（`targets[0]`）を「主」として、今の 1 リポジトリの記録（`workers.json` の最上位と `roles[<role>]` の worktree・branch）をそのまま主の記録に使う。2 つ目のリポジトリは、`workers.json` の最上位の `repos`（全リポジトリの一覧）と、役ごとの `roles[<role>].extra[<owner/name>]`（2 つ目の worktree）に足す。親（`orca-start.ts`）は役を起こす前に 2 つ目の worktree を `worktree create` で同じマシンに作って記録し、worker への指示文に並べる。読み手はすべて新しい関数 `repoTargets` / `roleWorktrees` を通して「リポジトリごとの組」を読み、`repos` が無い記録は今の 1 リポジトリとして読む。

**Tech Stack:** TypeScript（node が型除去で直接実行。Node 22.18 以上。実行時の npm 依存なし）、gh、git、Orca CLI 1.4.257、bash のテスト（`test/lib/orca-stub.sh` / `gh-stub.sh`）と `node --test`（`test/lib/auto-fixture.ts` / `auto-runtime-fixture.ts`。`auto-fixture.ts` には既に 2 つ目のリポジトリ `other/api`・`checkout2` がある）。

**Spec:** `docs/superpowers/specs/2026-11-17-auto-multi-repo-design.md`（以下「設計」）。元の設計は `docs/superpowers/specs/2026-11-12-issue-auto-dispatch-design.md` 6.6 と表の「複数リポジトリの PR を順に merge する途中で、残りが merge できなかった」、`docs/superpowers/specs/2026-11-13-auto-dispatch-additions-design.md` 5 章・8.1・8.3。C2a・C2b の決まりは `apps/orca-team-dispatch-task/CLAUDE.md` の「--auto の要点」とコードが正本。

## 前提の確かめ（設計の「前提の確かめ」の要約）

- worker は自分の worktree の外の 2 つ目の worktree に書き、commit し、push できる（このMac の codex・claude、M2max の codex）。Orca は codex を `danger-full-access` で起こす。
- 親は `orca worktree create --name <n> --repo <selector> --base-branch <ref> --setup <run|skip> --json`（遠くなら `--environment <id>`）で worktree を作れる。receipt の `result.worktree` に `id`（`<repo id>::<path>`）・`path`・`branch`（`refs/heads/...`）・`head`・`displayName`（= `--name`）がある。2026-11-17 に `--no-parent` 付きで、このMac と `--environment "Mac M2max"` の両方で同じ形を確かめた。削った実物を `test/fixtures/orca-worktree-create.json` に置いた（stub はこれをもとに答える）。

## Global Constraints

- TypeScript で `any`・`unknown`・`class` を使わない（ユーザーの決まり）。node の型除去で直接実行し、実行時の npm 依存を足さない。
- 正本先行: SKILL.md・README に書く前に、それを真にするコードとテストを書く。SKILL.md が正本、`references/guide-ja.md` は完全な写し（同じコミット）。SKILL.md の bash block に判定を書かない。
- Claude 向けの指示文書（SKILL.md 本文、`references/*.md`、worker への指示文）は英語。日本語は `*-ja.md` だけ。`node scripts/check-doc-lang.mjs` を通す。
- **1 リポジトリの Issue と、`repos` の無い旧い記録の振る舞いを変えない。**既存のテストの期待値を書き換えたら、それは計画からのずれとして result.md に理由とともに書く（AU25/AU26 は設計どおり変わる。下の Task 3）。
- `--issue`（file transport）と手で行う dispatch は対象外。`--repos-file` は `--transport mail` と一緒のときだけ受け付ける。
- 共有の fixture（`test/fixtures/orca-auto-comments.json`、`test/fixtures/auto-report.json`）の形を変えない。slack-issue-intake は変えない（コメントの `branch` は intake が読んでいないことを確かめた: `apps/slack-issue-intake/lib` に `branch` の読み取りは無い）。
- マシンと worktree は `(host, path)` の組で呼ぶ。遠くの `worktree` 呼び出しには `--environment <id>` を付ける。1 つの Issue の全リポジトリは同じ 1 台。
- Issue はどこでも `owner/repo#番号` で呼ぶ。リポジトリは `owner/name` で呼ぶ。
- 確認できていない変更・インフラのリポジトリの変更を AI が merge しない（全リポジトリについて）。
- 版は上げない・push しない。`git add` はファイルを名指しする。`apps/slack-issue-intake` に触れない（親の checkout にユーザーの未コミットの変更がある）。
- 型検査と lint は `apps/orca-team-dispatch-task` で `../../node_modules/.bin/tsc --noEmit -p .` と `../../node_modules/.bin/biome check ./bin ./lib ./skills ./test`（worktree に node_modules が無ければ親の checkout の道具を絶対パスで、`--typeRoots` 付き）。テストは `bash test/run-all.sh < /dev/null`。ルートで `node scripts/check-doc-lang.mjs` と `node scripts/check-shared-contracts.mjs`。
- 実機の Orca の worker・worktree・端末を作る確かめと本物の GitHub の PR の読み書きは、Task 1〜6 ではしない（stub で確かめる）。実機は Task 7（親が行う）。

## Review Focus

1. **2 つ目の worktree を作れたのに worker を起こせなかった／途中で落ちた**: 作った worktree が記録に残り、後片付け（`autoCleanup`）と空きの数え方（`capacityOf` の持ち主の判定）がそれを自分のものとして扱う。持ち主のいない worktree として数え続けない。→ Task 1 の ST143、Task 3 の AU106、Task 5 の AU121。
2. **一部の PR だけ merge された**: merge 済みのリポジトリの branch だけを merge 済みとして消し、merge されていないリポジトリの branch と worktree は保存を証明できる場合だけ消す。`partial-merge` のコメントで merge 済み／未 merge を名指しし、In review に回す。→ Task 4 の AU114、Task 5 の AU120。
3. **merge の途中で人が残りの PR を merge した／閉じた**: 次の tick で PR の状態を読み直し、MERGED は merge し直さず、CLOSED は In review の理由にする。→ Task 4 の AU115。
4. **worker が版 1 の封筒（1 つの branch）しか返さない、または片方のリポジトリの head が origin と違う**: 受理せず差し戻す。batch を止めない（exit 1 にしない）。→ Task 2 の WT173・WT174。
5. **前の世代と今の世代でリポジトリが違う**（続きの世代で判定が targets を変えた）: 前の世代の PR は同じリポジトリの今の PR に引き継いで閉じ、今の PR が無いリポジトリの前の PR は閉じずに理由に書く。→ Task 4 の AU117。

---

## ファイルの構成

| ファイル | 役目 |
|---|---|
| `lib/multi-repo.ts`（新） | `RepoTarget` / `RoleWorktree` の型、`repoTargets`、`roleWorktrees`、`readReposFile`、`resultFileOf` |
| `bin/orca-start.ts` | `--repos-file` の受け付け、`repos` の記録、2 つ目の worktree の作成と `roles[<role>].extra` の記録、指示文への受け渡し |
| `lib/mail-spec.ts` | `MailSpecInput.extraRepos` と、複数の worktree・版 2 の封筒の指示文 |
| `lib/mail-artifacts.ts` | 封筒の版 2（`heads`）の検査 |
| `bin/orca-wait.ts` | 版 2 の封筒の照合（リポジトリごとの branch と origin の head）、`completion.json` の `heads`、成功のあとのリポジトリごとの fetch |
| `bin/orca-auto.ts`、`references/auto-judge.md`（と `-ja.md`） | 2 つまで自動、3 つ以上は Ready_Eng。`targets` は merge の順 |
| `lib/auto-state.ts`、`lib/auto-queue.ts` | `branches` / `prevBranches` の追加と検査・引き継ぎ |
| `lib/auto-tick.ts` | 補充（全リポジトリの置き場所・空き・dirty・既定 branch・`--repos-file`）、持ち主の判定、仕上げ（PR ごと・順の merge・`partial-merge`）、失敗・後片付けの呼び出し |
| `lib/auto-request.ts`、`lib/auto-github.ts` | 依頼文の全リポジトリの確認コマンド、続きの世代のリポジトリごとの reset |
| `bin/orca-pr.ts` | `repos` のある記録で `--repo` に対応するリポジトリの PR を作り、結果をリポジトリごとのファイルに書く |
| `lib/auto-comment.ts` | `branches`（複数の branch の表示） |
| `lib/auto-cleanup.ts` | `pushBranches` / `autoCleanup` をリポジトリごとに。`merged` を merge 済みのリポジトリの一覧に |
| `lib/awaiting.ts` | 停滞の判定で 2 つ目の worktree の変更も数える |
| SKILL.md / guide-ja.md / README.md / CLAUDE.md | 文書（Task 6） |

## 記録の形（全タスクの約束）

`workers.json`（複数リポジトリの dispatch だけに足す。1 リポジトリでは書かない）:

```json
{
  "host_repo": "<主の selector>", "base_branch": "origin/<主の既定>", "integration_branch": "<主の既定>",
  "repos": [
    { "repo": "acme/api", "checkout": "/path/api", "host_repo": "path:/path/api", "base_branch": "origin/main", "integration_branch": "main" },
    { "repo": "acme/web", "checkout": "/path/web", "host_repo": "path:/path/web", "base_branch": "origin/develop", "integration_branch": "develop" }
  ],
  "roles": {
    "design": {
      "worktree_id": "...", "worktree_path": "<主の worktree>", "branch": "<主の branch>", "environment": "<任意>",
      "extra": { "acme/web": { "worktree_id": "...", "worktree_path": "...", "branch": "..." } }
    }
  }
}
```

- `repos[0]` は主で、最上位の `host_repo` / `base_branch` / `integration_branch` と `run.json` の `repo_root`（= `repos[0].checkout`）に一致する。
- `checkout` は**この Mac の** checkout（親の git が使う）。`host_repo` は worker のマシンの selector。

`lib/multi-repo.ts` の型と関数（Task 1 が作り、Task 2〜5 が使う）:

```ts
export type RepoTarget = { repo: string; checkout: string; hostRepo: string; baseBranch: string; integrationBranch: string }
export type RoleWorktree = { repo: string; checkout: string; worktreeId: string; worktreePath: string; branch: string; primary: boolean }
// repos が無ければ、run.json の repo_root と最上位の値から 1 件を返す。そのときの repo は常に ''（integration-result などは読まない）
export const repoTargets = (workers: JsonObject | null, repoRoot: string): RepoTarget[]
// 主（roles[role] の値）を先頭に、extra を repos の順に返す。path の無い組は返さない
export const roleWorktrees = (workers: JsonObject | null, repoRoot: string, role: string): RoleWorktree[]
// --repos-file の JSON（2 件、repo/checkout/host_repo/base_branch が空でない文字列、repo が重複しない）を読む。不正なら null
export const readReposFile = (path: string): Array<{ repo: string; checkout: string; host_repo: string; base_branch: string }> | null
// 複数リポジトリの PR の結果ファイル: integration-result.<owner>--<name>.json。1 リポジトリは integration-result.json
export const resultFileOf = (statusDir: string, repo: string | null): string
```

封筒の版 2（Task 2 が受け付け、Task 1 の指示文が書かせる）:

```json
{"version":2,"nonce":"<16〜64 桁 hex>","heads":[{"repo":"acme/api","branch":"<b>","head":"<40〜64 桁 hex>"},{"repo":"acme/web","branch":"<b>","head":"<hex>"}],"files":{"result.md":"..."}}
```

`IssueState` に足す鍵（Task 3）: `branches: Record<string, string>`（リポジトリ → 成果の branch。1 リポジトリでは `{}`）、`prevBranches: Record<string, string>`。旧い状態は `{}` で補う。

---

### Task 1: 記録の形と起動（2 つ目の worktree と指示文）

**Files:**
- Create: `apps/orca-team-dispatch-task/lib/multi-repo.ts`
- Modify: `apps/orca-team-dispatch-task/bin/orca-start.ts`（引数の解析 1230-1300 付近、`workers.json` の初期化 1533-1552 付近、`launchMailRole` 597-759）
- Modify: `apps/orca-team-dispatch-task/lib/mail-spec.ts`
- Test: `apps/orca-team-dispatch-task/test/unit/multi-repo.test.ts`（新。`test/run-all.sh` の単体テストは `test/unit/*.test.ts` を全部読む）、`test/unit/mail-spec.test.ts`、`test/test-start.sh`

**Interfaces:**
- Produces: 上の「記録の形」と `lib/multi-repo.ts` の 4 関数。`MailSpecInput.extraRepos: Array<{ repo: string; worktreePath: string; branch: string; baseBranch: string }>`（1 リポジトリでは `[]`）。`orca-start.ts --repos-file <path>`。

- [ ] **Step 1: 失敗するテストを書く**
  - `multi-repo.test.ts`:
    - MR1 `repoTargets` は `repos` が無い記録で 1 件（`repo` = `''`、`checkout` = repoRoot、`hostRepo` = 最上位の `host_repo`、`baseBranch` = `base_branch`、`integrationBranch` = `integration_branch`）。`integration-result.json` に `repo` があっても `repo` は `''` のまま。
    - MR2 `repos` が 2 件の記録で 2 件を順に返す。
    - MR3 `roleWorktrees(workers, root, 'design')` は主を先頭（`primary: true`）に、`extra['acme/web']` を 2 番目（`checkout` は `repos` の `acme/web` の checkout）に返す。`extra` に `repos` に無いリポジトリがあれば返さない。
    - MR4 `readReposFile` は 2 件の正しい JSON を返し、1 件・3 件・重複・空の値・JSON でないものは null。
    - MR5 `resultFileOf(dir, null)` は `<dir>/integration-result.json`、`resultFileOf(dir, 'acme/web')` は `<dir>/integration-result.acme--web.json`。
  - `mail-spec.test.ts`:
    - MS13 `extraRepos` が 1 件の exec の指示文は、`acme/web` の worktree の path・branch・base を含み、「`git -C <path>` で各 worktree に手順 1 と 3 を行う」こと、封筒が `"version":2` と `heads` であることを含む。
    - MS14 `extraRepos` が 1 件の exec の code review の依頼は、リポジトリごとに `repo:` / `branch:` / `head:` / `base:` の 4 行の組を書かせる。
    - MS15 `extraRepos` が 1 件の exec_review の指示文は、リポジトリごとに自分のその worktree で `git -C <path> fetch origin +refs/heads/<branch>` して `FETCH_HEAD` を照合させる。
    - MS16 `extraRepos: []` の指示文は今と 1 文字も変わらない（今の MS1〜12 の期待値で固定）。
  - `test-start.sh`:
    - ST141 `--transport mail --repos-file F`（2 件）で、`workers.json` に `repos` が F の順で入り、最上位の値と `run.json` の `repo_root` が `repos[0]` と一致する。
    - ST142 各役について、`worker-start` より前に `worktree create --name <役の名前> --repo <repos[1].host_repo> --base-branch <repos[1].base_branch> --setup <setup> --json` が 1 回呼ばれ（`--on` のあるときは `--environment <id>` 付き）、receipt の id・path・branch（`refs/heads/` を外す）が `roles[<role>].extra['<repos[1].repo>']` に入る。
    - ST143 2 つ目の `worktree create` が失敗したら、その役の `task-create` と `worker-start` を呼ばず、exit は今の「起動できない」と同じ、作れた worktree（前の役のもの）は記録に残る。
    - ST143b 2 つ目の worktree を作れたあと記録を書けなかった（`roleUpdate` の失敗を stub で起こす）ときは、その役を起こさず、作った worktree の id と path を消すコマンドとともに log に出す（Resources are KEPT）。
    - ST143c `--resume` で、`extra['<repos[1].repo>']` が既に記録された役は `worktree create` を呼ばずに記録を使い、記録の無い役だけ作る（ST143 の途中で止まった dispatch の続き）。
    - ST144 `--repos-file` を `--transport mail` 無しで渡すと使用法の誤り。`--resume` / `--phase exec` で渡すと今の `--transport` と同じく拒む（記録の値を使う）。`--phase exec` は記録の `repos` から exec・exec_review の 2 つ目の worktree を作る。
    - ST145 `--repos-file` 無しの mail の起動は、`worktree create` を呼ばず、`workers.json` に `repos` も `extra` も書かない（ST130〜137 の期待値のまま）。

- [ ] **Step 2: 走らせて失敗を見る**
  Run: `node --test test/unit/multi-repo.test.ts test/unit/mail-spec.test.ts; bash test/test-start.sh < /dev/null`
  Expected: MR1〜5 は `multi-repo.ts` が無いので失敗、MS13〜15 と ST141〜144 が失敗、MS16 と ST145 は通る。

- [ ] **Step 3: 実装する**
  - `lib/multi-repo.ts` に上の 4 関数。`readReposFile` は 2 件ちょうど（設計の上限）。
  - `orca-start.ts`: `--repos-file` を `mailFlags` と同じ扱いの値として受け、`readReposFile` で読む（null なら die）。`repos[0]` の `checkout` / `host_repo` / `base_branch` が `--repo-root` / `--host-repo` / `--base-branch` と違えば die。`integration_branch` は各 checkout の HEAD の branch（今の主の決め方と同じ）。`workers.json` の初期化で `repos` を書く。
  - `launchMailRole`: `extra` に既に記録があればそれを使う（`--resume`。ST143c）。記録が無く `repos` が 2 件のとき、`task-create` の前に `repos[1]` の worktree を `worktree create`（名前は主と同じ `name`、`--setup context.setup`、`--no-parent`、遠くなら `--environment <environment>`）で作り、`roleUpdate` で `extra` に書いてから指示文を作る。`renderMailSpec` に `extraRepos` を渡す。
  - `mail-spec.ts`: `extraRepos` が空でないときだけ、(1) 作業の段落に「This task spans N repositories」と、リポジトリごとの path・branch・base の一覧、(2) 手順 1・3 を各 worktree に `git -C <path>` で行うこと、(3) code review の依頼の 4 行の組、(4) reviewer の fetch と照合をリポジトリごとの自分の worktree で行うこと、(5) 手順 5 の封筒を版 2 の `heads`（全リポジトリ。主を先頭）にすること、を足す。空なら今の文のまま。

- [ ] **Step 4: 走らせて通るのを見る**
  Run: `node --test test/unit/multi-repo.test.ts test/unit/mail-spec.test.ts && bash test/test-start.sh < /dev/null`
  Expected: 全部 PASS（`failures: 0`）。

- [ ] **Step 5: コミット**（このタスクで変えたファイルを名指しで `git add` する）
  ```bash
  git add apps/orca-team-dispatch-task/lib/multi-repo.ts apps/orca-team-dispatch-task/bin/orca-start.ts apps/orca-team-dispatch-task/lib/mail-spec.ts apps/orca-team-dispatch-task/test/unit/multi-repo.test.ts apps/orca-team-dispatch-task/test/unit/mail-spec.test.ts apps/orca-team-dispatch-task/test/test-start.sh
  git commit -m "feat(orca-team-dispatch-task): --auto の複数リポジトリの dispatch で役ごとに 2 つ目の worktree を作って記録する"
  ```

### Task 2: 封筒の版 2 と親の受理

**Files:**
- Modify: `apps/orca-team-dispatch-task/lib/mail-artifacts.ts`（`Envelope`・`parseEnvelope`）
- Modify: `apps/orca-team-dispatch-task/bin/orca-wait.ts`（`mailOffer` 744-815 付近、成功のあとの fetch 1234-1242 付近）
- Test: `test/unit/mail-artifacts.test.ts`、`test/test-wait.sh`

**Interfaces:**
- Consumes: `repoTargets`、`roleWorktrees`（Task 1）。
- Produces: `export type EnvelopeHead = { repo: string; branch: string; head: string }`、`Envelope = { nonce: string; version: 1 | 2; heads: EnvelopeHead[]; files: Record<string, string> }`（版 1 は `heads: [{ repo: '', branch, head }]` に読み替える）。`completion.json` に `heads: Record<string, string>`（リポジトリ → head。複数リポジトリだけ）を足し、`head` は主の head のまま。

- [ ] **Step 1: 失敗するテストを書く**
  - `mail-artifacts.test.ts`:
    - MA7 版 2 の `heads` が 2 件の封筒を読み、`version: 2` と 2 件を返す。
    - MA8 版 2 で `heads` が空・`repo` が空・`head` が hex でない・`repo` が重複する封筒は `{ error }`。
    - MA9 版 1 の封筒は今と同じに読め、`heads` は 1 件（`repo: ''`）。
  - `test-wait.sh`（複数リポジトリの status dir を fixture で作る。`repos` 2 件、design に `extra`）:
    - WT172 版 2 の封筒で、両リポジトリの branch が記録と一致し、成果の役（integration_role）の両 head がそれぞれの checkout の `ls-remote origin` の値と一致すれば受理し、`completion.json` に `heads` が 2 件入る。
    - WT173 複数リポジトリの dispatch に版 1 の封筒が来たら差し戻す（理由に `version 2` を含む）。batch は既読にして exit 1 にしない。
    - WT174 2 つ目のリポジトリの head が origin と違えば差し戻す（理由にそのリポジトリ名）。
    - WT175 受理のあと、遠くの役（`environment` あり）の成果は、両リポジトリの checkout へ `fetchBranch` する（stub の git の呼び出しで 2 回）。
    - WT176 1 リポジトリの dispatch は今のまま（WT157〜171f の期待値のまま）。

- [ ] **Step 2: 走らせて失敗を見る**
  Run: `node --test test/unit/mail-artifacts.test.ts; bash test/test-wait.sh < /dev/null`
  Expected: MA7・MA8 と WT172〜175 が失敗。

- [ ] **Step 3: 実装する**
  - `parseEnvelope`: `version` が 1 なら今の検査で `heads` 1 件、2 なら `heads` を検査。今の呼び出し側の `envelope.branch` / `envelope.head` は `heads[0]` に置き換える。
  - `mailOffer`: 期待するリポジトリの組を `roleWorktrees(workers, repoRoot, role)` で作る。2 件以上なら版 2 を要求し、`heads` のリポジトリの集合が期待と一致、各 branch が記録と一致、成果の役なら各 head が `remoteHead(<その checkout>, branch)` と一致することを確かめる。合わなければ今の差し戻しと同じ経路で、最初に合わなかった理由を返す。1 件なら今の検査のまま（版 2 は拒む）。
  - 受理の記録に `heads` を足す。成功のあとの `fetchBranch` を `roleWorktrees` の組ごとに行う。

- [ ] **Step 4: 走らせて通るのを見る**
  Run: `node --test test/unit/mail-artifacts.test.ts && bash test/test-wait.sh < /dev/null`
  Expected: 全部 PASS。

- [ ] **Step 5: コミット**（このタスクで変えたファイルを名指しで `git add` する）
  ```bash
  git add apps/orca-team-dispatch-task/lib/mail-artifacts.ts apps/orca-team-dispatch-task/bin/orca-wait.ts apps/orca-team-dispatch-task/test/unit/mail-artifacts.test.ts apps/orca-team-dispatch-task/test/test-wait.sh
  git commit -m "feat(orca-team-dispatch-task): 複数リポジトリの dispatch の完了を版 2 の封筒でリポジトリごとに照合する"
  ```

### Task 3: 判定・状態・補充

**Files:**
- Modify: `apps/orca-team-dispatch-task/bin/orca-auto.ts`（143、159）
- Modify: `apps/orca-team-dispatch-task/lib/auto-state.ts`、`lib/auto-queue.ts`
- Modify: `apps/orca-team-dispatch-task/lib/auto-tick.ts`（`capacityOf` 255-290、`refill` 292-440、`branchOf` の使い所 129・184、exec の起動 520-524）
- Modify: `apps/orca-team-dispatch-task/lib/auto-request.ts`（`buildRequest`）、`lib/auto-github.ts`（`continuationOf`）
- Modify: `apps/orca-team-dispatch-task/lib/awaiting.ts`（`workerLastChange`）
- Test: `test/unit/auto-judge.test.ts`、`auto-state.test.ts`、`auto-queue.test.ts`、`auto-dispatch.test.ts`、`auto-request.test.ts`、`auto-continuation.test.ts`、`test/test-wait.sh`（停滞）

**Interfaces:**
- Consumes: `orca-start.ts --repos-file`（Task 1）、`roleWorktrees`（Task 1）。
- Produces: `IssueState.branches` / `prevBranches`。`buildRequest(issue, body, repos: Array<{ name: string; options: AutoConfig['repos'][string] }>, roles, continuation)`（第 3 引数を配列に。1 リポジトリは 1 件）。補充が書く `--repos-file` は `autoDir(name)/requests/<slug>-g<gen>.repos.json`。

- [ ] **Step 1: 失敗するテストを書く**
  - `auto-judge.test.ts`:
    - AU25/AU26 の期待値を変える（**計画からのずれではなく設計どおり。result.md に書く**）: `targets: ['acme/app', 'other/api']` は `queued`（Ready_Eng にしない）。
    - AU103 3 つの targets は Ready_Eng で、理由に「3 つ以上のリポジトリ」を含む。
    - AU103b 同じリポジトリを 2 回含む targets（`['acme/app', 'acme/app']`）は、判定の適用で重複を除いて 1 件として扱う（2 つ目の worktree を作らない）。
  - `auto-state.test.ts` / `auto-queue.test.ts`:
    - AU104 `branches` / `prevBranches` の無い旧い状態は `{}` で読み、文字列でない値の状態は不正として拒む。
    - AU104b 新しい世代では `prevBranches` に前の `branches`（空なら前の `prevBranches`）を引き継ぎ、`branches` を `{}` にする（今の `prevBranch` と同じ規則）。
  - `auto-dispatch.test.ts`（fixture の `acme/app` と `other/api` の 2 つを targets に持つ Issue）:
    - AU105 両方のリポジトリを `verified` で持つマシンがあれば、それだけを候補にする。片方しか持たない（`hosts[].repos` に無い）マシンには置かない。どのマシンも両方を持たなければ「この Issue を入れられるマシンがありません」。
    - AU105b 両方を `verified` で持つマシンが無いときは、両方を `hosts[].repos` に持つマシンを候補にし、今の 1 リポジトリと同じく理由に「（確認が通っていないマシンで実装）」を足す（仕上げで「確認できないリポジトリです。」になり AI は merge しない）。
    - AU106 必要な worktree は「役の数 × 2」で数え、`issue.worktrees` と `chosen.used` に入る。`capacityOf` は `roles[*].extra[*].worktree_path` も持ち主のある worktree として数える（持ち主のいない worktree に数えない）。
    - AU107 どちらかの checkout が dirty なら補充しない。既定 branch の取得と `fetch`・`checkout -B` を両方の checkout で行う。
    - AU108 起動の引数に `--repos-file <path>` が入り、その JSON の 2 件が targets の順・それぞれの `checkout`・`host_repo`（そのマシンの selector）・`base_branch`（`origin/<その既定>`）を持つ。`--repo-root` と `--host-repo` と `--base-branch` は 1 件目の値。
    - AU109 1 リポジトリの Issue の起動の引数は今のまま（`--repos-file` を含まない。AU80 の期待値のまま）。
  - `auto-request.test.ts`:
    - RQ13 2 件の `repos` の依頼文は、リポジトリごとの見出しの下に確認コマンドを並べ、どちらかが `infra` ならインフラの段落を入れる。1 件なら今の文のまま（RQ1〜12 の期待値）。
  - `auto-continuation.test.ts`:
    - AU110 `prevBranches` が 2 件の続きの世代は、リポジトリごとに `git -C <その worktree>` で fetch と reset をする指示を出す（worktree の path は分からないので、指示は「the worktree for <repo>」と名指しする）。`prevBranch` だけの旧い状態は今の 1 行。
  - `test-wait.sh`:
    - WT177 2 つ目の worktree（local）の変更・commit も停滞の時計を戻す（`workerLastChange` が `extra` の path も見る）。

- [ ] **Step 2: 走らせて失敗を見る**
  Run: `node --test test/unit/auto-judge.test.ts test/unit/auto-state.test.ts test/unit/auto-queue.test.ts test/unit/auto-dispatch.test.ts test/unit/auto-request.test.ts test/unit/auto-continuation.test.ts; bash test/test-wait.sh < /dev/null`
  Expected: AU25/AU26（新しい期待値）、AU103〜AU108（AU103b・AU105b を含む）、AU110、RQ13、WT177 が失敗。AU109 は通る。

- [ ] **Step 3: 実装する**
  - `orca-auto.ts`: 判定を適用する前に targets の重複を除く（順は最初の出現のまま）。`targets.length > 1` を `targets.length > 2` に、理由の文を「（3 つ以上のリポジトリの Issue は自動実行の対象外です）」に。
  - `auto-state.ts` / `auto-queue.ts`: 2 つの鍵の型・検査・既定・世代の引き継ぎ。
  - `refill`: 全 targets の `repos` 設定があること、候補のマシンが全 targets を持ち（verified の絞り込みは全 targets が verified のマシン。無ければ全 targets を持つマシンにして未確認の印を付ける。AU105b）、全 checkout の空きディスク・dirty・既定 branch を確かめる。status dir・まとめ役は 1 件目の checkout。2 件のときだけ `--repos-file` を書いて渡す。`required` は役の数 × targets の数。
  - `capacityOf` の `owned` に `extra` の path を足す（環境は役の `environment`）。
  - `branchOf` を使う所（started のコメントと `issue.branch` の記録）で、2 件のときは `branches` に `roleWorktrees(workers, root, integration_role)` のリポジトリ → branch を入れる。`issue.branch` は主の branch のまま。
  - `buildRequest` の第 3 引数を配列に、`continuationOf` は `prevBranches` が 2 件以上ならリポジトリごとの指示。
  - `workerLastChange` は `roleWorktrees` の local の path を全部見る。

- [ ] **Step 4: 走らせて通るのを見る**
  Run: 上と同じコマンド。
  Expected: 全部 PASS。続けて `bash test/run-all.sh < /dev/null` が ALL GREEN。

- [ ] **Step 5: コミット**（変えたファイルを名指しする）
  ```bash
  git commit -m "feat(orca-team-dispatch-task): --auto が 2 つのリポジトリの Issue を両方を確認済みのマシンに置いて起動する"
  ```

### Task 4: 仕上げ（PR ごと・順の merge・一部の merge）

**Files:**
- Modify: `apps/orca-team-dispatch-task/bin/orca-pr.ts`
- Modify: `apps/orca-team-dispatch-task/lib/auto-tick.ts`（`finish` 636-790、`handoverPrs` 610-628）
- Modify: `apps/orca-team-dispatch-task/lib/auto-comment.ts`
- Test: `test/test-pr.sh`、`test/unit/auto-finish.test.ts`、`test/unit/auto-continuation.test.ts`、`test/unit/auto-comment.test.ts`

**Interfaces:**
- Consumes: `repoTargets`、`roleWorktrees`、`resultFileOf`（Task 1）、`IssueState.branches`（Task 3）。
- Produces: `CommentInput.branches?: Array<{ repo: string; branch: string }>`。`orca-pr.ts --repo <owner/name>` は `repos` のある記録でその組の PR を作る。

- [ ] **Step 1: 失敗するテストを書く**
  - `test-pr.sh`:
    - PR17 `repos` のある記録で `--repo acme/web` を渡すと、`acme/web` の checkout で、成果の役の `extra['acme/web'].branch` を `repos[1].integration_branch` に向けて push と `gh pr create` をし、結果を `integration-result.acme--web.json` に書く（`integration-result.json` には書かない）。
    - PR18 `repos` のある記録で、`repos` に無い `--repo` は止まる（理由を結果ファイルに書かない、exit 1）。
    - PR19 `integration-result.acme--web.json` に `pr_url` があれば作り直さずに 0（今の `integration-result.json` と同じ）。1 つ目のリポジトリの結果ファイルが別にあっても 2 つ目を作る。
  - `auto-comment.test.ts`:
    - AC5 `branches` が 2 件の started は「ブランチ: `b1`（acme/api）、`b2`（acme/web）」、failed は同じ行の後ろに「（push 済み）」。`branch` だけの入力は今と同じ（共有の fixture のまま）。
  - `auto-finish.test.ts`（2 つの targets の Issue。`targets` の順は `other/api`、`acme/app`）:
    - AU111 PR が無ければ、targets の順にリポジトリごとに `orca-pr.ts --repo <r>` を呼び、`issue.prs` を targets の順で 2 件にする。1 件だけ作れたら、作れた分を保存して次の tick で残りだけを作る。
    - AU112 どちらかの PR の checks が pending なら待つ。`ci: true` のリポジトリの PR だけ「CI が始まりません」の判定に入れる。
    - AU113 両方が merge できる状態なら、targets の順に `gh pr merge` を打ち、両方の成功で `ai-merged`（`prs` 2 件）と Done。
    - AU113b 最初の merge の前に、全 PR の `mergeable`（`gh pr view --json mergeable`）を読む。どれかが `CONFLICTING` なら 1 つも merge せず、理由「<repo>#<n> が衝突しています。」で In review。`UNKNOWN` なら merge せずに次の tick で読み直す。
    - AU114 1 つ目の merge が通り 2 つ目が失敗したら、`partial-merge` のコメント（`mergedPrs` に 1 つ目、`unmergedPrs` に 2 つ目と理由「merge できませんでした」）で In review。1 つ目が失敗したら今と同じ「PR を merge できませんでした。」の needs-review。
    - AU115 既に MERGED の PR は merge し直さない。片方が CLOSED なら理由「PR が閉じられています。」で In review（今の文）。
    - AU116 `確認できないリポジトリです。` と `インフラの変更は確認が必要です。` は、どちらかのリポジトリが当てはまれば理由に入る。
  - `auto-continuation.test.ts`:
    - AU117 前の世代の PR は、同じリポジトリの今の PR へ引き継いで閉じる。今の PR の無いリポジトリの前の PR は閉じず、in-review の理由に「前の世代の PR が残っています: <repo>#<n>」を入れる。1 リポジトリの Issue は AU61/AU62 の期待値のまま。

- [ ] **Step 2: 走らせて失敗を見る**
  Run: `bash test/test-pr.sh < /dev/null; node --test test/unit/auto-comment.test.ts test/unit/auto-finish.test.ts test/unit/auto-continuation.test.ts`
  Expected: PR17〜19、AC5、AU111〜117 が失敗。

- [ ] **Step 3: 実装する**
  - `orca-pr.ts`: `workers.json` に `repos` があれば、`--repo` と一致する組の `checkout` を root、`roleWorktrees` のその組の branch を branch、`integrationBranch` を base、`resultFileOf(statusDir, repo)` を結果ファイルにする。`repos` が無ければ今のまま。
  - `finish`: `repoTargets` の順に PR を作る（`issue.prs` に無いリポジトリだけ）。状態は全 PR を読み、merge の前に全 PR の `mergeable` を読む（AU113b）。merge は targets の順で、既に MERGED の PR は飛ばす。`partial-merge` は `transition(issue, 'partial-merge', { mergedPrs, unmergedPrs }, STATUS.inProgress, STATUS.inReview, false, 'review', tick.save)`。
  - `handoverPrs`: 前の PR と同じリポジトリの今の PR を探す。無ければ閉じずに理由へ。
  - `auto-comment.ts`: `branches` の表示。

- [ ] **Step 4: 走らせて通るのを見る**
  Run: 上と同じコマンド。続けて `bash test/run-all.sh < /dev/null`。
  Expected: 全部 PASS、ALL GREEN。`node scripts/check-shared-contracts.mjs`（ルート）も OK。

- [ ] **Step 5: コミット**（このタスクで変えたファイルを名指しで `git add` する）
  ```bash
  git commit -m "feat(orca-team-dispatch-task): 複数リポジトリの Issue の PR をリポジトリごとに作り、判定役の順に merge し、途中の失敗は一部の merge として In review にする"
  ```

### Task 5: 失敗の仕上げと後片付け

**Files:**
- Modify: `apps/orca-team-dispatch-task/lib/auto-cleanup.ts`（`pushBranches` 70-109、`autoCleanup` 217-325）
- Modify: `apps/orca-team-dispatch-task/lib/auto-tick.ts`（`clean` 536-552、`finishFailure` 559-594）
- Test: `test/unit/auto-cleanup.test.ts`、`test/unit/auto-progress.test.ts`（失敗の仕上げ）

**Interfaces:**
- Consumes: `repoTargets`、`roleWorktrees`（Task 1）、`completion.json` の `heads`（Task 2）、`CommentInput.branches`（Task 4）。
- Produces: `pushBranches(statusDir, skipRepos: string[], remote: Record<string, RemoteRow>, prevBranches: Record<string, string>): { pushed: boolean; reasons: string[] }` と `autoCleanup(statusDir, archiveDir, generation, mergedRepos: string[], prevBranches: Record<string, string>)`。checkout は記録（`repoTargets`）から引く（引数から外す）。1 リポジトリでは `repoTargets` の 1 件の `repo` が `''` なので、呼び出し側は merge 済みなら `['']` を渡す。`remote` の鍵は `<role>\t<repo>`。

- [ ] **Step 1: 失敗するテストを書く**
  - `auto-cleanup.test.ts`（2 リポジトリの記録）:
    - AU118 `pushBranches` は local の役の両リポジトリの branch を、それぞれの checkout から push する。同じ branch 名が 2 つのリポジトリにあっても両方を push する（鍵は (repo, branch)）。
    - AU119 遠くの役の 2 つ目の worktree の保存の証明は、そのリポジトリの checkout と `completion.json` の `heads[<repo>]` で見る。証明できなければその worktree を残し、記録を退避しない。
    - AU120 `mergedRepos: ['other/api']` のとき、`other/api` の成果の branch は merge 済みとして消し、`acme/app` の branch は origin と同じ SHA のときだけ消す（それ以外は「保存を証明できないためブランチを残しました」）。
    - AU121 全役の主と 2 つ目の worktree を `worktree rm`（遠くは `--environment`）し、全部消えたら status dir を退避する。人が操作した端末の役は、その役の両リポジトリの worktree を残す。
    - AU122 1 リポジトリの記録（PR が作られて `integration-result.json` に `repo` がある状態を含む）で `mergedRepos: ['']` を渡すと、成果の branch を merge 済みとして消す。そのほかは今の期待値のまま（AU58*・AU88〜93・AU102/102b・C1-2）。呼び出しの形が変わる既存のテストは、引数の書き換えだけで期待値を変えない。
  - `auto-progress.test.ts`:
    - AU123 2 リポジトリの Issue の失敗の仕上げは、両リポジトリの branch を push してから、failed のコメントに `branches` 2 件と「push 済み」を書く。片方の push が失敗したら「push できていません」。

- [ ] **Step 2: 走らせて失敗を見る**
  Run: `node --test test/unit/auto-cleanup.test.ts test/unit/auto-progress.test.ts`
  Expected: AU118〜121、AU123 が失敗。

- [ ] **Step 3: 実装する**
  - `pushBranches` / `autoCleanup` を `roleWorktrees` の組ごとに回す。`kept` は役の単位のまま（1 つの役の端末が全リポジトリの worktree を使うので、人が操作した役は全リポジトリを残す）。
  - `clean`: PR の状態を読み、MERGED の PR のリポジトリを `mergedRepos` に。1 リポジトリ（`repos` の無い記録）は `repoTargets` の `repo` が常に `''` なので、今の `prs.every(MERGED)` が真なら `['']`、偽なら `[]` を渡す。`finishFailure` は `pushBranches` の結果と `branches` をコメントへ。

- [ ] **Step 4: 走らせて通るのを見る**
  Run: 上と同じコマンド。続けて `bash test/run-all.sh < /dev/null`。
  Expected: 全部 PASS、ALL GREEN。

- [ ] **Step 5: コミット**（このタスクで変えたファイルを名指しで `git add` する）
  ```bash
  git commit -m "feat(orca-team-dispatch-task): 複数リポジトリの Issue の push と後片付けを (役, リポジトリ) ごとに行う"
  ```

### Task 6: 文書

**Files:**
- Modify: `apps/orca-team-dispatch-task/skills/orca-team-dispatch-task/SKILL.md`（`--auto` の節と既知の制限。今の「Multiple targets go to Ready_Eng until C2b2」254・1355 付近）
- Modify: `.../references/guide-ja.md`（同じ箇所。235・1292 付近）
- Modify: `.../references/auto-judge.md` と `auto-judge-ja.md`（5 行目: 2 つまで自動、3 つ以上は Ready_Eng、`targets` は依存の順 = merge の順）
- Modify: `apps/orca-team-dispatch-task/README.md`（能力の要約に 1 行）、`apps/orca-team-dispatch-task/CLAUDE.md`（「--auto の要点」に C2b2 の段落: 記録の形、封筒の版 2、置き場所、merge の順、一部の merge、回帰の番号。501 行付近の「C2b2 まで」を直す）
- Test: `test/test-docs.sh`

- [ ] **Step 1: 失敗するテストを書く**
  - SK39: SKILL.md と guide-ja.md の両方に、2 つまで自動（3 つ以上は Ready_Eng）、merge は判定役の `targets` の順、途中の失敗は一部の merge で In review、全リポジトリを同じマシンで動かすことの 4 点がある。`auto-judge.md` と `-ja.md` に「three or more」と merge の順の記述がある。SKILL.md・guide-ja.md・auto-judge.md に「until C2b2」が無い。

- [ ] **Step 2: 走らせて失敗を見る**
  Run: `bash test/test-docs.sh < /dev/null`
  Expected: SK39 が失敗。

- [ ] **Step 3: 文書を書く**（SKILL.md を正本に、guide-ja.md を完全な写しに。既知の制限の行数を両方で揃える。SK8c）

- [ ] **Step 4: 走らせて通るのを見る**
  Run: `bash test/test-docs.sh < /dev/null && bash test/run-all.sh < /dev/null`、ルートで `node scripts/check-doc-lang.mjs && node scripts/check-shared-contracts.mjs`
  Expected: 全部 PASS / OK。

- [ ] **Step 5: コミット**（このタスクで変えたファイルを名指しで `git add` する）
  ```bash
  git commit -m "docs(orca-team-dispatch-task): --auto の複数リポジトリの Issue を説明する"
  ```

### Task 7: 実機（親が行う。worker には任せない）

**前提:** 2 つ目の使い捨てリポジトリ（`orca-auto-e2e` と別の GitHub リポジトリ）を、このMac と Mac M2max に clone して Orca に登録し、`--auto` の設定の `sources[].related` と `repos`・`hosts[].repos` に足す。`orca-auto-e2e` と 2 つ目の両方を触る小さい Issue（例: 両方の README に同じ 1 行を足す）を `from-slack`・`Ready`・`priority: low` で 1 件。

- [ ] Step 1: このMac で 1 件を、判定（targets 2 件）→ 起動（各役 2 つの worktree）→ 受理（版 2）→ PR 2 件 → targets の順の merge → Done → 後片付け（両方の worktree と branch が消える）まで通す。worktree・端末の数を基準の記録と比べる。
- [ ] Step 2: M2max で 1 件を同じく通す（遠くの 2 つ目の worktree を `--environment` で作る経路）。
- [ ] Step 3: 2 つ目の PR だけ merge できない状態（例: 2 つ目のリポジトリにブランチ保護）で `partial-merge` と In review を確かめる（できなければ未確認として残す）。
- [ ] Step 4: 結果を `apps/orca-team-dispatch-task/CLAUDE.md` に書き、使い捨ての PR・branch を片付ける。
