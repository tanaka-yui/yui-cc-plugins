# orca-team-dispatch-task `--auto` 複数マシン（C2b）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `--auto` の Issue を、この Mac だけでなく Orca にペアリング済みのサーバー（`--on <environment>`）にも振り分ける。worker とは手元のファイルとこの Mac のプラグインのパスを使わず、Orca のメッセージと origin への push だけで受け渡す。

**Architecture:** `--auto` の dispatch は、どのマシンでも「メールの受け渡し」（`transport: mail`）で動かす。worker への指示は、依頼文と計画を本文に埋め込み、`orca`・`git`・`gh` だけを使わせる。worker は成果のファイルを `merge_ready` の本文（JSON の封筒）で返し、ブランチは origin に push する。親（tick の中の `orca-wait`）は封筒を status dir に書き出してから、今までと同じ検査を通す。それ以外の部品（`orca-pr`、後片付け）は、origin から取ってきたローカルのブランチで今までどおり動く。`--issue` と手で行う dispatch は変えない（`transport` が無い記録は今までのファイルの受け渡し）。

**Tech Stack:** TypeScript（node が型除去で直接実行。Node 22.18 以上。実行時の npm 依存なし）、gh、git、Orca CLI 1.4.257、bash のテスト（`test/lib/orca-stub.sh` / `gh-stub.sh`）と `node --test`（`test/lib/auto-fixture.ts` / `auto-runtime-fixture.ts`）。

**Spec:** `docs/superpowers/specs/2026-11-13-auto-dispatch-additions-design.md` の 6 章（複数のマシン）・8 章（役の組み合わせと待ち続ける親がいないこと）・9 章・11 章（以下「追加の設計」）と、`docs/superpowers/specs/2026-11-12-issue-auto-dispatch-design.md` の 6 章（以下「元の設計」）。C2a の決まりは `apps/orca-team-dispatch-task/CLAUDE.md` の「--auto の要点」とコードが正本（C2a の計画 `docs/superpowers/plans/2026-11-13-orca-auto-core.md` は実装中に D1〜D25 でずれたので、根拠にしない）。

## この計画の範囲

| 計画 | 内容 |
|---|---|
| C2a（済み） | この Mac での本体 |
| **C2b（この計画）** | 複数のマシンへの振り分け。`--auto` の worker との受け渡しをメールと push に置き換える。C2a のレビューの持ち越し（続きの材料を信用しない材料として囲む） |
| C2b2（次の計画） | 複数リポジトリにまたがる Issue（1 つの役が複数の worktree）。この計画の間は今までどおり Ready_Eng に回す |
| C2c | GitHub Project の Status とラベルの同期 |
| C3 | `make setup`（マシンの選択・スペック測定・マシンごとの checkout の登録と確認・並列数・automation の登録） |

C2b2 を分けた理由: 1 つの worker が 2 つ目の worktree に書けるか（codex の sandbox を含む）を確かめておらず、`targets[0]`・`prs[0]`・1 リポジトリ 1 checkout・PR の merge の順番という別の前提の組に触れるため。追加の設計 10 章は C2 をさらに分けることを許している。

この計画の設定（`hosts`）は C3 が書く。この計画のテストは fixture の設定で動かす。`hosts` が無い設定は、C2a と同じ「この Mac 1 台」として読む。

## spike の結果（2026-11-15、Orca 1.4.257、この Mac → ペアリング済みの「Mac M2max」）

ORCA_* の環境変数をすべて外したプロセス（automation の precheck と同じ条件）から、この Mac で作った端末の handle H をまとめ役にして試した。使った worktree・ブランチ・端末は片付けた（Run が 3 つ資源なしで残る）。

1. `orchestration worker-start --spec-file F --task-title T --on "Mac M2max" --worktree new-top-level --repo id:<遠くの repo id> --name <名前> --base-branch origin/main --setup skip --agent claude --run R --from H --json --full` は 12 秒で ready。receipt の `effects` は `{kind:worktree, id:"<遠くの repo id>::<path>", name}`、`{kind:terminal, role:agent, id}`、`{kind:setup}`、`{kind:dispatch_input}`。**ブランチ名は receipt に無い。**
2. ブランチ名と HEAD は `worktree list --environment <env> --limit 1000 --json` の行（`id`・`path`・`branch: "refs/heads/<接頭辞>/<名前>"`・`head`）にある。この Mac の `worktree list` には遠くの行は出ない。
3. `--base-branch origin/main` は受け付けられ、遠くの worktree の HEAD は origin の main と同じだった（遠くの clone の origin/main が新しかったかは区別できていない。worker の最初の手順で fetch と比較をさせる）。
4. 遠くの worker の `status` と `worker_done` は、この Mac の `check --run R --terminal H` に届く。
5. 親から遠くの worker へ `send --to dispatch:<id> --from H --type status` は届く（`queuedFor: worker`）。worker は自分の `check --wait` で読めた。
6. ターンを終えた遠くの worker（`state ready`・`stage input_accepted`）は、2 通目のメールだけで動き出した。そのとき親には Orca の `escalation`（Worker stopped without reporting）も来た。
7. 遠くの端末への `terminal send` は、`--environment` が無いと `terminal_handle_stale`、付ければ ok。
8. 動いている遠くの worker への `worker-stop --dispatch D` は `state stopped`・`closed_agent_terminal`。そのあとの `worker-release` は `retained` を返したが、`worktree rm --environment <env> --worktree path:<p> --force --delete-branch` で worktree は消えた。
9. `worker-show --full` の `host.kind` は `remote`、`on` は environment の id、`server.serverName` は名前。
10. メールの本文は 64KB・256KB・600KB がそのまま届いた。1MB は OS の引数の上限で送れなかった（Orca の上限ではない）。
11. Orca CLI には遠くのマシンのファイルを読む口が無い（`terminal read` と `worker-read` だけ）。遠くの成果は、メールか git の push でしか親に届かない。
12. 遠くのマシンの repo の id はこの Mac と違う（`repo list --environment`）。2 台とも worktree は `/Users/yui/orca/workspaces/<repo>/<名前>` で、**同じ path が 2 台に同時にありうる。**
13. 遠くの Mac M2max には gh のログイン、node 26、このプラグインがあった。ただし追加の設計 11 章のとおり、worker はこのプラグインに頼らない（同じ絶対パスにプラグインがあると、遠くのファイルに書いて親には届かないまま「動いたように見える」）。

## Global Constraints

- TypeScript で `any`・`unknown`・`class` を使わない（ユーザーの決まり）。node の型除去で直接実行し、実行時の npm 依存を足さない。
- 正本先行: SKILL.md・README に書く前に、それを真にするコードとテストを書く。SKILL.md が正本、`references/guide-ja.md` は完全な写し（同じコミットで更新）。SKILL.md の bash block に判定を書かない。
- Claude 向けの指示文書（SKILL.md 本文、`references/*.md`、worker への指示文）は英語。日本語は `*-ja.md` だけ。`node scripts/check-doc-lang.mjs` を通す。
- orca-team-dispatch-task から Slack へ直接投稿しない。ラベルとマーカーのコメントの約束（`test/fixtures/orca-auto-comments.json`、`test/fixtures/auto-report.json`）の形を変えない（slack-issue-intake は変えない）。
- **`--issue` と手で行う dispatch の動きを変えない。**`workers.json` に `transport` が無い記録は、今までのファイルの受け渡しで扱う。既存の `test-start.sh`・`test-wait.sh`・`test-cleanup.sh`・`test-merge.sh`・`test-pr.sh` を変えずに通すことがその検査になる（既存のテストの期待値を書き換えたら、それは計画からのずれとして result に書く）。
- **メールの受け渡しの worker への指示文に、親のプラグインのパス、親の status dir のパス、`/Applications/Orca.app` を書かない**（Orca CLI はマシンの設定 `orcaBin` の値を書く）。
- **マシンと worktree は `(host, path)` の組で呼ぶ。**path だけで比べない（spike 12）。host はこの Mac が `local`、ペアリング済みのサーバーは environment の **id**（名前ではない。名前は変えられる）。
- 遠くのマシンの `terminal`・`worktree` の呼び出しには必ず `--environment <id>` を付ける。`orchestration` の呼び出し（Run はこの Mac にある）には付けない。
- Issue はどこでも `owner/repo#番号` で呼ぶ。
- 確認できていない変更（確認コマンドが通らない、CI が落ちた・まだ始まっていない、結果の報告が読めない、確認が通っていないマシンで作った）と、インフラのリポジトリの変更を AI が merge しない。
- 秘密の値をログ、コメント、PR、report.json に出さない。
- 版は上げない・push しない（ユーザーの指示: C2・C3 がすべて終わってから版を上げて main を push する）。
- コミットに `apps/slack-issue-intake/CLAUDE.md` のユーザーの未コミットの変更を混ぜない。`git add` はファイルを名指しする。
- 型検査と lint は `apps/orca-team-dispatch-task` で `../../node_modules/.bin/tsc --noEmit -p .` と `../../node_modules/.bin/biome check ./bin ./lib ./skills ./test`。テストは `bash test/run-all.sh < /dev/null`。ルートで `node scripts/check-doc-lang.mjs` と `node scripts/check-shared-contracts.mjs`。新しい bash のテストの組は `test/run-all.sh` の `SUITE` に足す。

## Review Focus

1. **同じ path が 2 台にある**（spike 12。slug に世代が無いので、この Mac の持ち主のいない worktree と M2max の動いている worktree が同じ path になる）: 空きの数え方・持ち主のいない worktree・`worktree rm`・`existsSync`・`git -C` が、別のマシンの worktree を自分のものと取り違えない。→ Task 1 の HC5、Task 6 の AU82、Task 5 の AU91。
2. **worker が動いているマシンにつながらなくなった**: その Issue をほかのマシンでやり直さない。報告は「つながらない」。上限時間を過ぎたら 1 回だけ知らせ（stalled のコメント）、つながりが戻ったら C2a の上限時間の処理をする。1 台がつながらなくても tick の予算を使い切らない。→ Task 7 の AU95〜AU98。
3. **ブランチが origin に無い**（push を忘れた・失敗した・遠くのマシンが落ちた）: 受理しない（差し戻し）。失敗の仕上げのコメントで「push 済み」と言わない。worktree を消さない。→ Task 3 の WT160、Task 5 の AU88・AU89。
4. **封筒が壊れている・大きすぎる・決まっていない名前のファイルを含む**（`../`、絶対パス、`workers.json`）: status dir の外にも、決まった名前以外にも書かない。batch を止めず（exit 1 にしない）差し戻す。→ Task 3 の MA3〜MA6、WT158。
5. **受理したあとに同じ `merge_ready` をもう一度読む**（`pending-batch.json` の読み直し）: 受理を 2 度送らない（送ると Orca が followUp の worker を起こす。CLAUDE.md）。親が `completion.json` を受理の返事を**送る前に**書く。→ Task 3 の WT161。

---

## ファイルの構成

| ファイル | 役目 |
|---|---|
| `lib/auto-hosts.ts`（新） | マシンの設定の型と読み込み、`hostsOf`、`envArgs`、`hostKey` |
| `lib/mail-spec.ts`（新） | メールの受け渡しの worker への指示文 `renderMailSpec` |
| `lib/mail-artifacts.ts`（新） | 封筒の検査と status dir への書き出し `materialize`、許すファイル名の表 |
| `lib/remote-branch.ts`（新） | `remoteHead`（ls-remote）と `fetchBranch`（origin からローカルのブランチへ） |
| `bin/orca-start.ts` | `--transport mail` の起動（worker-start が worktree を作る形）と記録 |
| `bin/orca-wait.ts` | メールの受け渡しの役の封筒・heartbeat・worker_done の扱い |
| `bin/orca-wake.ts` | 役の `environment` に `--environment` を付ける |
| `bin/orca-recover.ts` | `environment` を持つ役は置き換えずに止まる |
| `lib/awaiting.ts` | `heartbeat.json` を数え、`environment` を持つ役の worktree を読まない |
| `lib/auto-config.ts` / `lib/auto-state.ts` | `hosts` と `IssueState.host`・`hostUnreachableSince` |
| `lib/auto-tick.ts` | マシンごとの空き・振り分け・つながらないマシン・封筒の成果の取り込み |
| `lib/auto-cleanup.ts` | 遠くの worktree の削除、push の黙った成功の修正 |
| `lib/auto-report.ts` | マシンごとの `hosts` と `running[].host` |
| `lib/auto-request.ts` / `lib/auto-github.ts` | 「push しない」の行を外す、続きの材料を JSON で囲む |

---

### Task 1: マシンの設定と状態

**Files:**
- Create: `apps/orca-team-dispatch-task/lib/auto-hosts.ts`
- Modify: `apps/orca-team-dispatch-task/lib/auto-config.ts`、`lib/auto-state.ts`
- Test: `apps/orca-team-dispatch-task/test/unit/auto-hosts.test.ts`（新）、`test/unit/auto-state.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const LOCAL_HOST = 'local'
  export type HostConfig = {
    id: string                 // 'local' か environment の id
    name: string               // 表示名（report.json と知らせに使う）
    lanes: number              // worktree の数の上限（追加の設計 8.3）
    orcaBin: string            // そのマシンの worker が使う Orca CLI（指示文に書く）
    repos: Record<string, { selector: string; verified: boolean }>  // owner/repo → そのマシンの repo selector
  }
  export const hostsOf = (config: AutoConfig): HostConfig[]
  export const envArgs = (host: string): string[]          // 'local' → []、それ以外 → ['--environment', host]
  export const hostKey = (host: string, path: string): string  // `${host}\t${path}`
  ```
  `AutoConfig` に `hosts: HostConfig[] | null`（設定に無ければ null）。`IssueState` に `host: string | null`（dispatch の前は null）と `hostUnreachableSince: string | null`。
- `hostsOf`: `hosts` があればそれを返す。無ければ C2a と同じ 1 台: `{ id: 'local', name: os.hostname(), lanes: config.lanes, orcaBin: <orca-start と同じ解決の ORCA_BIN>, repos: { [r]: { selector: 'path:' + repos[r].checkout, verified: repos[r].verified } } }`。
- 読み込みの検査: `hosts[].id` は空でなく重ならない、`'local'` は高々 1 つ、`lanes` は 1 以上の整数、`orcaBin` は空でない、`repos` のキーは `config.repos` にある、`selector` は空でない。違えば `readAutoConfig` が null（C2a の他の項目と同じ）。

- [ ] **Step 1: 失敗するテストを書く**（`test/unit/auto-hosts.test.ts`）
  - HC1 `hosts` の無い C2a の設定 → `hostsOf` は 1 件で `id === 'local'`、`lanes === config.lanes`、`repos['acme/app'].selector === 'path:' + checkout`。
  - HC2 `hosts` に local と `env-1` の 2 件 → その順で返し、`env-1` の `repos` はその値のまま。
  - HC3 `hosts` の id の重複、`local` が 2 つ、`lanes: 0`、知らない repo のキー → それぞれ `readAutoConfig` が null。
  - HC4 `envArgs('local')` は `[]`、`envArgs('env-1')` は `['--environment', 'env-1']`。
  - HC5 `hostKey('local', '/p') !== hostKey('env-1', '/p')`。
  - SS3（`auto-state.test.ts`）`host` と `hostUnreachableSince` の無い C2a の状態ファイルを読むと、どちらも null で読める。
- [ ] **Step 2: 走らせて失敗を見る** — `node --test test/unit/auto-hosts.test.ts test/unit/auto-state.test.ts`。Expected: FAIL（モジュールが無い／フィールドが無い）。
- [ ] **Step 3: 実装する**（上の Interfaces）。
- [ ] **Step 4: 通るのを見る** — 同じコマンドが PASS。`bash test/run-all.sh < /dev/null` も ALL GREEN。
- [ ] **Step 5: コミット** — `git commit -m "feat(orca-team-dispatch-task): --auto のマシンの設定と状態を持つ"`（ファイルを名指しで add）。

### Task 2: メールの受け渡しで worker を起こす（orca-start）

**Files:**
- Create: `apps/orca-team-dispatch-task/lib/mail-spec.ts`
- Modify: `apps/orca-team-dispatch-task/bin/orca-start.ts`、`bin/orca-recover.ts`、`bin/orca-wake.ts`
- Test: `test/test-start.sh`（ST130〜ST139 を足す）、`test/unit/mail-spec.test.ts`（新）、`test/test-recover.sh`（RC52）、`test/test-wake.sh`（WK12）

**Interfaces:**
- orca-start の新しいフラグ（**`--transport mail` のときだけ受け付け、ほかのときは exit 2**）:
  `--transport mail`、`--on <environment id>`（省略 = この Mac）、`--host-repo <そのマシンの repo selector>`（必須）、`--base-branch <ref>`（必須。tick は `origin/<default>`）、`--worker-orca <path>`（必須）。`--transport` は新規の起動でだけ受け付け、`workers.json` の最上位に `transport: 'mail'`、`worker_orca`、`base_branch` を記録する。`--phase exec` と `--resume` は記録を読み、フラグを渡されたら exit 2。
- 役の起動（`transport: mail`）: `worktree create` を呼ばず、`orchestration worker-start --task <t> [--on <env>] --worktree new-top-level --repo <host-repo> --name <今と同じ名前> --base-branch <ref> --setup <設定> --agent … [--model … --effort …] --run <run> --from <parent> --json --full`。receipt の `effects[kind=worktree].id` と `effects[kind=terminal,role=agent].id` を読み、`worktree list [--environment <env>] --limit 1000 --json` でその id の行を探して `branch`（`refs/heads/` を外す）と `path` を得る。見つからなければ今の「起動が終わらなかった」の扱い（`start_incomplete`）。
- `workers.json` の役に足す: `environment: <env id> | null`、`worktree_id`、`worktree_path`、`branch`、`terminal`。今の fast-forward（`git -C <worktree>` 系）、startup の端末の close、`terminalHandles` は `transport: mail` では呼ばない（`worktree_terminals` は `[terminal]`）。
- `lib/mail-spec.ts`:
  ```ts
  export type MailSpecInput = {
    role: 'design' | 'design_review' | 'exec' | 'exec_review'
    orcaBin: string
    terminalNote: string        // 「your terminal handle is in the Orca preamble」相当の固定文
    request: string             // request.md の全文
    plan: string | null         // exec のときだけ plan.md の全文
    branchRule: string          // push 先: 'the branch this worktree is on'
    baseBranch: string          // 'origin/main' など
    integration: boolean        // この役が成果を載せる役か
    planOnly: boolean           // phase_b=on の design
    reviewer: string | null     // 依頼側: レビュー役の dispatch id（review_mode=on）
    reviewOf: 'plan' | 'code' | null  // レビュー役: 何をレビューするか
    reviewRounds: number        // REVIEW_ROUND_STEP（無人なので尋ねずに止める）
  }
  export const MAIL_ENVELOPE_MAX_BYTES = 262_144
  export const renderMailSpec = (input: MailSpecInput): string
  ```
  指示文が worker にさせること（英語で書く。順番も固定）:
  1. 最初に `git fetch origin` し、`git rev-parse HEAD` と `git rev-parse <baseBranch>` が違えば、作業ツリーがきれいなときだけ `git reset --hard <baseBranch>`（spike 3）。
  2. 進むたび（コミットのたび、レビューの往復のたび、成果のファイルを書き終えたとき）に `<orcaBin> orchestration send --type status --subject "heartbeat: <短い説明>" --body "-"`（宛先省略 = 親）。
  3. 成果を載せる役は、コミットのたびに `git push origin HEAD:refs/heads/<自分のブランチ>`。
  4. 成果のファイル（`result.md`、計画役なら `plan.md`、成果を載せる役なら依頼文が求める `auto-result.json`、レビュー役なら各ラウンドの `review/<plan|code>-round-<n>-findings.md`、依頼側なら `review/<plan|code>-round-<n>-request.md`）は、worktree の外の一時ディレクトリ（`mktemp -d`）に書く。worktree に置かない・コミットしない。
  5. 完了: `openssl rand -hex 8` で nonce を作り、封筒 `{"version":1,"nonce":"…","branch":"<自分のブランチ>","head":"<git rev-parse HEAD>","files":{"<名前>":"<中身>"}}` を一時ファイルに JSON で書き（`node` に頼らない。jq があれば jq、無ければ手で正しい JSON にする）、`<orcaBin> orchestration send --type merge_ready --subject "merge_ready: <nonce>" --body "$(cat <封筒>)"`。封筒が 256KB を超えるなら、長いファイルを要約して入れ直す。
  6. `<orcaBin> orchestration check --wait --timeout-ms 600000` を、`completion-accepted: <nonce>` か `completion-remediation: <nonce>` の件名が来るまで呼び直す（期限で諦めない。CLAUDE.md の「子は待ち続ける」）。差し戻しなら本文の理由を直して 5 からやり直す（新しい nonce）。
  7. 受理されたら `<orcaBin> orchestration send --type worker_done --outcome succeeded --subject "<要約>"`（失敗なら `--outcome failed`、理由は封筒の `result.md`）。
  8. レビューの往復（`reviewer` / `reviewOf` があるとき）: 依頼側は依頼の本文をそのまま `--to dispatch:<reviewer> --type status --subject "review-request: <plan|code> round <n>"` で送り、返事を自分の `check --wait` で待つ。レビュー役は届いた依頼の送り主（メッセージの `from` の dispatch）へ `--subject "review-verdict: <plan|code> round <n>"`・本文の最後の行が `VERDICT: approved` か `VERDICT: needs_work` で返す。`reviewRounds` で止め、未解消の指摘を `result.md` に書く。人に尋ねない。
  9. 人に尋ねない、`sudo` を使わない、秘密を書かない。
- `bin/orca-recover.ts`: 役に `environment` があれば、何もせず「遠くのマシンの役は置き換えません」と言って exit 1（`--retry-of` は場所を引き継がない。spike の `--help`）。
- `bin/orca-wake.ts`: 役に `environment` があれば `terminal send` に `--environment <id>` を付ける（spike 7）。

- [ ] **Step 1: 失敗するテストを書く**
  - MS1（`mail-spec.test.ts`）`renderMailSpec` の出力に、プラグインのルート（`PLUGIN` の実値）、`.dispatch/`、`/Applications/Orca.app`（`orcaBin: 'orca'` のとき）が含まれない。
  - MS2 依頼文の全文が含まれる。exec のときは計画の全文も含まれる。
  - MS3 `merge_ready: `、`completion-accepted: `、`completion-remediation: `、`worker_done --outcome` の語が含まれ、`node ` で始まる命令が無い。
  - MS4 `integration: false` のとき `git push` の手順が無い。
  - MS5 `reviewer: 'ctx_r'` の design に `dispatch:ctx_r` と `review-request: plan` が、`reviewOf: 'code'` のレビュー役に `review-verdict: code` と `VERDICT: ` がある。
  - ST130（`test-start.sh`）`--transport mail --on env-1 --host-repo id:R --base-branch origin/main --worker-orca orca` の起動で、stub の呼び出しに `worktree create` が無く、`worker-start` に `--on env-1 --worktree new-top-level --repo id:R --base-branch origin/main` があり、`worktree list --environment env-1` が呼ばれる。
  - ST131 `workers.json` に `transport: mail`、役の `environment: env-1`、`branch`（`refs/heads/` を外した値）、`worktree_path`、`terminal` が記録される。`git -C <worktree>` の呼び出しが無い（stub のログ）。
  - ST132 worker-start に渡した spec（`--spec-file` の中身）が MS1 の 3 つを含まない。
  - ST133 `--on` を省いた mail の起動（この Mac）でも `worktree create` は呼ばれず、`worktree list` に `--environment` が付かない。
  - ST134 receipt の worktree の id が一覧に無い → `start_incomplete` を記録し exit 1（今の「終わらない起動」と同じ文言）。
  - ST135 `--transport` 無しで `--on` / `--host-repo` / `--base-branch` / `--worker-orca` → exit 2。
  - ST136 `--phase exec` は記録の `transport` に従い、exec の spec に `plan.md` の全文が入る。`--phase exec --transport mail` → exit 2。
  - ST137 review_mode=on の mail の起動で、design の spec に先に起動した design_review の dispatch id が入る。
  - ST138 既存の ST1〜ST129 は変えずに通る（実行するだけ）。
  - RC52（`test-recover.sh`）`environment` を持つ役 → exit 1、`worker-start` を呼ばない。
  - WK12（`test-wake.sh`）`environment: env-1` の役への起床は `terminal send --environment env-1`。
- [ ] **Step 2: 走らせて失敗を見る** — `bash test/test-start.sh < /dev/null`、`node --test test/unit/mail-spec.test.ts`、`bash test/test-recover.sh < /dev/null`、`bash test/test-wake.sh < /dev/null`。Expected: 新しいテストだけ FAIL。
- [ ] **Step 3: 実装する**。`orca-stub.sh` に `worker-start` の `new-top-level` の receipt（上の spike 1 の形）と `worktree list --environment` の応答を足す。
- [ ] **Step 4: 通るのを見る** — 同じコマンドが PASS、`bash test/run-all.sh < /dev/null` が ALL GREEN。
- [ ] **Step 5: コミット** — `git commit -m "feat(orca-team-dispatch-task): --auto の worker をメールと push の受け渡しで起こせるようにする"`。

### Task 3: 封筒を受け取って検査する（orca-wait）

**Files:**
- Create: `apps/orca-team-dispatch-task/lib/mail-artifacts.ts`、`lib/remote-branch.ts`
- Modify: `apps/orca-team-dispatch-task/bin/orca-wait.ts`、`lib/awaiting.ts`
- Test: `test/unit/mail-artifacts.test.ts`（新）、`test/test-wait.sh`（WT157〜WT166）

**Interfaces:**
- `lib/mail-artifacts.ts`:
  ```ts
  export type Envelope = { nonce: string; branch: string; head: string; files: Record<string, string> }
  export const parseEnvelope = (body: string): Envelope | { error: string }
  export const allowedTarget = (role: string, name: string, integration: boolean, planOnly: boolean): string | null
  export const materialize = (statusDir: string, role: string, envelope: Envelope, integration: boolean, planOnly: boolean): string  // '' = 書けた、それ以外は差し戻しの理由
  ```
  許す名前と書き先（これ以外は差し戻し。書く前にすべて検査し、1 つでも駄目なら何も書かない）:

  | 役 | 名前 | 書き先（status dir からの相対） |
  |---|---|---|
  | すべて | `result.md` | `roles/<role>/result.md` |
  | design（`planOnly`） | `plan.md` | `plan.md` |
  | 成果を載せる役 | `auto-result.json` | `auto-result.json` |
  | design / exec | `review/<plan\|code>-round-<n>-request.md`（n は 1〜99） | 同じ |
  | design_review / exec_review | `review/<plan\|code>-round-<n>-findings.md` | 同じ |

  封筒の本文が `MAIL_ENVELOPE_MAX_BYTES` を超える、JSON でない、`version !== 1`、`nonce` が `^[0-9a-f]{16,64}$` でない、`files` の値が文字列でない → 理由を返す。
- `lib/remote-branch.ts`:
  ```ts
  export const remoteHead = (repoRoot: string, branch: string): string | null   // git -C repoRoot ls-remote origin refs/heads/<branch> の sha。無ければ null
  export const fetchBranch = (repoRoot: string, branch: string): boolean         // git -C repoRoot fetch origin +refs/heads/<b>:refs/heads/<b>
  ```
- orca-wait の `merge_ready`（`workers.json` の `transport === 'mail'` のときだけ。ほかは今のまま）:
  1. nonce は件名から読む（今と同じ）。無ければ今と同じ exit 1。
  2. `roles/<role>/completion.json` が同じ nonce で `accepted` / `settled` なら返事をしない（今と同じ。**この記録はメールの受け渡しでは親が書く**）。
  3. `parseEnvelope`。駄目なら差し戻し（exit 1 にしない）。封筒の nonce が件名と違えば差し戻し。
  4. 封筒の `branch` が記録の `roles.<role>.branch` と違えば差し戻し（ブランチ名は worker から受け取らない。spike 2 の一覧が正本）。
  5. `materialize`。理由があれば差し戻し。
  6. 成果を載せる役は `remoteHead(run.json の repo_root, branch) === envelope.head` でなければ差し戻し（「push されていない」）。
  7. `verifyRole`（今のまま）。
  8. 受理なら、**返事を送る前に** `completion.json` に `{ nonce, phase: 'accepted', head }` を書き、書けなければ batch を ack しない（exit 2 の扱い）。それから受理を送る。差し戻しなら `{ nonce, phase: 'remediated' }` を書いてから送る。
- `status` の件名が `heartbeat:` で始まり、送り主がメールの受け渡しの役なら、`roles/<role>/heartbeat.json` に `{ at }` を書いて既読にする（今の status の表示は 1 行に縮める）。
- `worker_done`（メールの受け渡しの役）: 記録の前に `roles/<role>/status.json` を `outcome` から `done` / `error` で書く（今の `settleDir` の検査がそのまま通る）。成果を載せる役が `succeeded` なら、続けて `fetchBranch(repo_root, branch)`。取れなければ 1 行言う（仕上げは Task 5 がもう一度試す）。
- `lib/awaiting.ts` の `workerLastChange`: `roles/*/heartbeat.json` を数える。役に `environment` があれば、その `worktree_path` に `existsSync` / `git -C` をしない（Review Focus 1）。

- [ ] **Step 1: 失敗するテストを書く**
  - MA1 正しい封筒 → `parseEnvelope` がそのまま返す。
  - MA2 design（planOnly）の `plan.md` と `result.md` → `materialize` が `plan.md` と `roles/design/result.md` に書き、`''` を返す。
  - MA3 `../x`、`/etc/x`、`workers.json`、`roles/exec/result.md`（別の役）、exec_review の `review/plan-round-1-request.md` → それぞれ理由を返し、何も書かない。
  - MA4 1 つ目は許す名前、2 つ目が駄目 → 1 つ目も書かれていない。
  - MA5 本文が 262,145 バイト → 理由「大きすぎる」。
  - MA6 nonce が `abc` → 理由。
  - WT157 mail の design が正しい封筒の merge_ready → `roles/design/result.md` ができ、受理が送られ、`completion.json` が `accepted`。
  - WT158 壊れた JSON の封筒 → 差し戻しが送られ、exit は 1 ではなく、batch は既読になる。
  - WT159 封筒の `branch` が記録と違う → 差し戻し。
  - WT160 成果を載せる役で ls-remote の sha が封筒の `head` と違う（または無い）→ 差し戻し「push されていない」。
  - WT161 受理したあと同じ batch を `pending-batch.json` から読み直す → 受理は 1 回しか送られない（stub の send の回数）。completion.json を書けない（読み取り専用の dir）とき → 受理を送らず ack しない。
  - WT162 `heartbeat:` の status → `heartbeat.json` が書かれ、待機は止まらない。
  - WT163 mail の worker_done succeeded → `status.json` が `done` になり、exit 0 で決着。`git fetch origin +refs/heads/<b>:refs/heads/<b>` が呼ばれる。
  - WT164 `environment: env-1` の役の `worktree_path` にこの Mac の別の repo があっても、停滞の判定がその git を読まない（その repo のコミットで時計が戻らない）。
  - WT165 `transport` の無い記録の merge_ready は今までどおり（既存の WT のどれかと同じ結果。新しいコードを通らない）。
  - WT166 既存の WT1〜WT156 は変えずに通る（実行するだけ）。
- [ ] **Step 2: 走らせて失敗を見る** — `node --test test/unit/mail-artifacts.test.ts`、`bash test/test-wait.sh < /dev/null`。
- [ ] **Step 3: 実装する**。
- [ ] **Step 4: 通るのを見る** — 同じコマンドと `bash test/run-all.sh < /dev/null`。
- [ ] **Step 5: コミット** — `git commit -m "feat(orca-team-dispatch-task): メールで届いた成果の封筒を検査して status dir に書き出す"`。

### Task 4: tick がメールの受け渡しで dispatch する

**Files:**
- Modify: `apps/orca-team-dispatch-task/lib/auto-tick.ts`、`lib/auto-request.ts`
- Test: `test/unit/auto-dispatch.test.ts`（AU80・AU81）、`test/unit/auto-request.test.ts`（RQ10）

**Interfaces:**
- Consumes: Task 1 の `hostsOf`、Task 2 の orca-start のフラグ。
- `refill` の orca-start の引数に足す: `--transport mail --base-branch origin/<default> --worker-orca <host.orcaBin> --host-repo <host.repos[target].selector>`、遠くのマシンなら `--on <host.id>`。`issue.host` に host の id を入れて、dispatch の前の保存（`dispatching`）と同じ書き込みで保存する。マシンの選び方は Task 6。この Task では `hostsOf` の先頭のマシンを使う。
- `buildRequest`: 「The parent creates the PR; do not push or create one yourself.」を「The parent creates the PR; do not create one yourself. Push only your own task branch, as the protocol says.」に変える。`resultPath` の引数を外し、成果の報告の節は「`auto-result.json` を封筒の files に入れる」と言う（封筒の手順は `renderMailSpec` が持つので、依頼文は名前と JSON の形だけを言う）。

- [ ] **Step 1: 失敗するテストを書く**
  - AU80 tick の起動の引数に `--transport mail`、`--base-branch origin/main`、`--worker-orca`、`--host-repo path:<checkout>` があり、`--on` は無い（hosts の無い設定）。`issue.host === 'local'`。
  - AU81 `hosts` の先頭が `env-1` の設定 → `--on env-1 --host-repo id:R` が付き、`issue.host === 'env-1'`。
  - RQ10 依頼文に `do not push` が無く、`auto-result.json` の形（`decisions`、`verify` など）があり、status dir のパスが無い。
- [ ] **Step 2: 走らせて失敗を見る** — `node --test test/unit/auto-dispatch.test.ts test/unit/auto-request.test.ts`。
- [ ] **Step 3: 実装する**。`auto-runtime-fixture.ts` の orca-start の stub は `--transport` を受け、`workers.json` に `transport: 'mail'` と役の `environment` を書くようにする。
- [ ] **Step 4: 通るのを見る** — 同じコマンドと `bash test/run-all.sh < /dev/null`。
- [ ] **Step 5: コミット** — `git commit -m "feat(orca-team-dispatch-task): --auto の dispatch をメールと push の受け渡しにする"`。

### Task 5: 成果のブランチと後片付けを遠くのマシンに合わせる

**Files:**
- Modify: `apps/orca-team-dispatch-task/lib/auto-tick.ts`（`finish`・`finishFailure`）、`lib/auto-cleanup.ts`
- Test: `test/unit/auto-finish.test.ts`（AU86・AU87）、`test/unit/auto-cleanup.test.ts`（AU88〜AU92）

**Interfaces:**
- Consumes: Task 3 の `remoteHead` / `fetchBranch`、Task 1 の `envArgs` / `hostKey`。
- `finish`: orca-pr を呼ぶ前に、成果を載せる役のブランチを `fetchBranch(checkout, branch)`。取れなければ orca-pr を呼ばず、C2a の「PR を作れない」と同じ扱い（`AUTO_PR_RETRY_MINUTES` で In review）。
- `pushBranches(statusDir, checkout)` の変更: 役のブランチがローカルに無いときは、まず `fetchBranch`。取れた → 今までどおり（push は同じ sha で何もしない）。origin にも無い → `pushed: false` とし、理由「<branch> は origin にもこの Mac にもありません」を返す（**今は理由なしに飛ばして pushed: true を返す。黙った成功を直す**）。
- `autoCleanup` の変更: 役の `environment` で `worktree list <envArgs> --limit 1000 --json` を読み、`hostKey(environment ?? 'local', path)` で行を探す。
  - 一覧が読めない・truncated → その回は `ok: false`（今も同じか確かめ、違えば直す）。
  - 行が無い → 「もう無い」として進む（今と同じ）。ただし `environment` のある役は、行が無いことを 1 行言う。
  - `worktree rm` に `envArgs` を付ける。
  - 遠くの worktree を消す条件: `confirmStopped` の証拠（今と同じ）に加えて、**その役のブランチが origin にあり、`remoteHead` が `completion.json` の `head` と同じか、その役に先のコミットが無い（成果を載せない役）**。満たさなければ消さずに残し、理由を返す（その回は `ok: false`、`cleanupPending` のまま）。
  - ローカルのブランチの `branch -D` は、`fetchBranch` で取ってきたもの（origin と同じ sha）だけ。
- 失敗の仕上げのコメント: `pushBranches` が `pushed: false` なら「push 済み」と書かない（今の `auto-comment.ts` の分岐がそれを受け取れるか確かめ、受け取れなければ足す）。

- [ ] **Step 1: 失敗するテストを書く**
  - AU86 成果のブランチがローカルに無く origin にある → `fetchBranch` のあとで orca-pr が呼ばれる。
  - AU87 origin にも無い → orca-pr を呼ばず、30 分で In review（`AUTO_PR_RETRY_MINUTES`）。
  - AU88 `pushBranches` で役のブランチがどこにも無い → `pushed: false` と理由（今のコードでは pushed: true になることを先に確かめる）。
  - AU89 その状態で失敗の仕上げ → コメントの本文に「push 済み」が無い。
  - AU90 `environment: env-1` の役 → `worktree list --environment env-1` と `worktree rm --environment env-1 --worktree path:<p> --force --delete-branch` が呼ばれる。
  - AU91 env-1 の役と同じ path の行がこの Mac の一覧にだけある → この Mac の worktree を消さない。
  - AU92 env-1 の成果を載せる役で origin の sha が `completion.json` の `head` と違う → 消さず、`cleanupPending` のまま、理由が出る。
- [ ] **Step 2: 走らせて失敗を見る** — `node --test test/unit/auto-finish.test.ts test/unit/auto-cleanup.test.ts`。
- [ ] **Step 3: 実装する**。
- [ ] **Step 4: 通るのを見る** — 同じコマンドと `bash test/run-all.sh < /dev/null`。
- [ ] **Step 5: コミット** — `git commit -m "fix(orca-team-dispatch-task): 遠くのマシンの成果を origin から取り、push と削除の黙った成功をなくす"`。

### Task 6: マシンごとの空きと振り分け

**Files:**
- Modify: `apps/orca-team-dispatch-task/lib/auto-tick.ts`（`capacity`・`refill`）
- Test: `test/unit/auto-dispatch.test.ts`（AU82〜AU85）、`test/unit/auto-tick.test.ts`

**Interfaces:**
- `capacity` を `capacityOf(tick, host: HostConfig): { used: number; readable: boolean; reachable: boolean }` にする。
  - `reachable`: `local` は常に true。遠くは `orca status --environment <id> --json` の `result.runtime.reachable === true`（読み取りなので C2a の call cap の期限を付ける）。
  - `used` = その host の active な Issue の `worktrees` の和 ＋ その host の一覧（`worktree list <envArgs>`）のうち、`displayName` が `auto-` で始まり、active な Issue の記録の `hostKey(役の environment ?? 'local', worktree_path)` に無いものの数。
  - 遠くのマシンが届かない、一覧が読めない → そのマシンはこの回使わない（ほかのマシンは使う）。
- `refill`: Issue ごとに候補のマシン = `repos` にその Issue の対象リポジトリを持ち、`reachable` で、`used + required <= lanes` のもの。候補のうち確認済み（`verified`）のマシンがあればそれだけに絞る（追加の設計 11 章）。空きの割合 `(lanes - used) / lanes` が大きい順、同じなら `local` を先、その次は設定の順。選んだマシンの `used += required`。
  - 確認済みのマシンが無く、確認していないマシンに入れたときは、`issue.reason` に「確認が通っていないマシンで実装」を入れ、仕上げで AI が merge しない（C2a の `verified: false` と同じ扱いになるよう、仕上げが読む値をそろえる）。
  - 空きメモリと空きディスクの確かめは `local` に入れるときだけ（追加の設計 6.3。遠くは並列数に頼る）。
  - 候補が 1 つも無い Issue は飛ばし、次の Issue を見る（今は「レーンが足りない」で break。重い Issue が軽い Issue を塞がないよう、マシンが無いときだけ continue にする。全マシンが満杯なら break）。

- [ ] **Step 1: 失敗するテストを書く**
  - AU82 local（lanes 1、使用 1）と env-1（lanes 2、使用 0）→ 次の Issue は env-1 へ。local の一覧に env-1 の worktree と同じ path の `auto-` 行があっても、env-1 の使用数に数えない。
  - AU83 env-1 が `reachable: false` → local へ。local も満杯なら dispatch しない。tick は exit 1 で終わる。
  - AU84 対象リポジトリを env-1 だけが確認済み → 空きの割合が local の方が大きくても env-1 へ。どちらも確認していない → 空きの割合で選び、`reason` に確認の文言が入る。
  - AU85 env-1 に入れるときは空きメモリの確かめをしない（`ORCA_AUTO_FREE_MEMORY_MB=0` でも env-1 へ入る）。local に入れるときは今までどおり止まる。
- [ ] **Step 2: 走らせて失敗を見る** — `node --test test/unit/auto-dispatch.test.ts`。
- [ ] **Step 3: 実装する**。
- [ ] **Step 4: 通るのを見る** — 同じコマンドと `bash test/run-all.sh < /dev/null`。
- [ ] **Step 5: コミット** — `git commit -m "feat(orca-team-dispatch-task): --auto の Issue を空いているマシンへ振り分ける"`。

### Task 7: つながらないマシン

**Files:**
- Modify: `apps/orca-team-dispatch-task/lib/auto-tick.ts`（`progress` の前）
- Test: `test/unit/auto-progress.test.ts`（AU95〜AU98）

**Interfaces:**
- tick の初めに、active な Issue が載っている遠くのマシンの `reachable` を読む（Task 6 の読み方。1 台につき 1 回）。
- 届かないマシンの Issue: `hostUnreachableSince` が null なら今の時刻を入れる。その回は `progress`（orca-wait）・人の変更による停止・上限時間による停止をしない。ほかのマシンでやり直さない。
- 届かないまま `startedAt + limitMinutes` を過ぎ、`stalledNotified` が false なら、C2a の `stalled` のコメント（本文の理由「<マシンの名前> につながりません」）を 1 回だけ書き、`stalledNotified = true`。ラベルは C2a の stalled と同じ（In progress のまま）。
- 届くようになったら `hostUnreachableSince = null`。そのあとは C2a のとおり（待機を先に読み、上限時間なら失敗の仕上げ）。

- [ ] **Step 1: 失敗するテストを書く**
  - AU95 env-1 が届かない → その Issue の orca-wait・orca-stop が呼ばれず、`hostUnreachableSince` が入り、phase は running のまま。ほかの Issue は進む。
  - AU96 届かないまま上限時間を過ぎる → stalled のコメントが 1 回だけ（2 回目の tick では書かない）。失敗にしない。
  - AU97 届くようになった次の tick → `hostUnreachableSince` が null、orca-wait が呼ばれ、上限時間を過ぎていれば C2a の失敗の仕上げ。
  - AU98 届かないマシンの `orca status` が call cap の期限で打ち切られても、tick は予算内で終わり report.json を書く。
- [ ] **Step 2: 走らせて失敗を見る** — `node --test test/unit/auto-progress.test.ts`。
- [ ] **Step 3: 実装する**。
- [ ] **Step 4: 通るのを見る** — 同じコマンドと `bash test/run-all.sh < /dev/null`。
- [ ] **Step 5: コミット** — `git commit -m "feat(orca-team-dispatch-task): つながらないマシンの Issue をやり直さずに待ち、上限で一度だけ知らせる"`。

### Task 8: report.json のマシン

**Files:**
- Modify: `apps/orca-team-dispatch-task/lib/auto-report.ts`、`lib/auto-tick.ts`（`buildReport` の呼び出し）
- Test: `test/unit/auto-report.test.ts`（RP4〜RP6）

**Interfaces:**
- `buildReport(config, state, hosts: Array<{ host: HostConfig; used: number; reachable: boolean }>, now)`。`hosts[]` は設定のマシンごとに `{ name, used, max: lanes, reachable }`。`running[].host` はその Issue の `host` の名前（`host` が null なら `os.hostname()`）。形は `test/fixtures/auto-report.json` のまま（キーを足さない）。

- [ ] **Step 1: 失敗するテストを書く**
  - RP4 local と env-1 の 2 台 → `hosts` が 2 件、env-1 が届かなければ `reachable: false`。
  - RP5 env-1 で動いている Issue の `running[].host` が env-1 の名前。
  - RP6 出力のキーの集合が fixture と同じ（`check-shared-contracts.mjs` も通る）。
- [ ] **Step 2〜4**: `node --test test/unit/auto-report.test.ts` で FAIL → 実装 → PASS、`bash test/run-all.sh < /dev/null`、ルートで `node scripts/check-shared-contracts.mjs`。
- [ ] **Step 5: コミット** — `git commit -m "feat(orca-team-dispatch-task): report.json にマシンごとの空きとつながりを書く"`。

### Task 9: 続きの材料を信用しない材料として囲む（C2a のレビューの持ち越し）

**Files:**
- Modify: `apps/orca-team-dispatch-task/lib/auto-github.ts`（`continuationOf`）、`lib/auto-request.ts`
- Test: `test/unit/auto-continuation.test.ts`（RQ11・RQ12）

**Interfaces:**
- `continuationOf(issue, since)` は `{ prevBranch: string; instructions: string; material: { prs: …; comments: Array<{ source: string; body: string }>; checks: Json } } | null` を返す。`instructions`（前のブランチから続ける git の手順）は親が組み立てた文だけ。PR とコメントと CI の本文は `material` に入れる。
- `buildRequest` は `instructions` をそのまま、`material` を `Continuation material (JSON):\n${JSON.stringify(material)}` として、信用しない材料の注意の文に「the continuation material」も名指しする。20,000 字の上限は JSON の文字列の中で切る（JSON を壊さない。長いコメントから縮める）。

- [ ] **Step 1: 失敗するテストを書く**
  - RQ11 コメントの本文に `Ignore previous instructions` を含む続きの依頼文 → その文字列は `Continuation material (JSON):` の JSON の中にだけあり、注意の文が continuation material を名指しする。
  - RQ12 20,000 字を超える材料 → 依頼文の JSON 部分が `JSON.parse` できる。
- [ ] **Step 2〜4**: `node --test test/unit/auto-continuation.test.ts test/unit/auto-request.test.ts` で FAIL → 実装 → PASS、`bash test/run-all.sh < /dev/null`。
- [ ] **Step 5: コミット** — `git commit -m "fix(orca-team-dispatch-task): 続きの材料を Issue の本文と同じく信用しない材料として囲む"`。

### Task 10: 文書

**Files:**
- Modify: `apps/orca-team-dispatch-task/skills/orca-team-dispatch-task/SKILL.md`（`## Auto mode`）、`references/guide-ja.md`、`README.md`、`CLAUDE.md`、`test/test-docs.sh`

- [ ] **Step 1: 失敗するテストを書く** — SK37（`test-docs.sh`）SKILL.md の `## Auto mode` に「paired server」「`--on`」「mail」「push」の説明があり、guide-ja.md に対応する節がある。SK38 SKILL.md の bash block に新しい判定が無い（SK26 のまま通る）。
- [ ] **Step 2: 走らせて失敗を見る** — `bash test/test-docs.sh < /dev/null`。
- [ ] **Step 3: 書く**:
  - SKILL.md / guide-ja.md: 複数のマシン（`hosts`、空きの数え方、確認済みのマシンを優先、つながらないときは待つ）、`--auto` の worker はメールと push で受け渡すこと、遠くのマシンの役は `orca-recover.ts` で置き換えないこと。既知の制限に「遠くの空きメモリは測らない」「複数リポジトリの Issue は Ready_Eng（C2b2 まで）」。
  - CLAUDE.md の「--auto の要点」: spike の結果の要点（1〜13 のうち実装が頼るもの）、`transport: mail` と `(host, path)` の決まり、封筒の許す名前、受理の記録を返事より先に書く理由、push の黙った成功を直した理由、回帰のテスト名。
  - README: 能力の要約に 1 行。
- [ ] **Step 4: 通るのを見る** — `bash test/test-docs.sh < /dev/null`、ルートで `node scripts/check-doc-lang.mjs`、`bash test/run-all.sh < /dev/null`。
- [ ] **Step 5: コミット** — `git commit -m "docs(orca-team-dispatch-task): --auto の複数マシンとメールの受け渡しを説明する"`。

### Task 11: 実機で通しで確かめる

C2a の初回の実 dispatch もまだ通っていない（C2a の result の未確認）。ここで両方を確かめる。

**前提（ユーザーに用意してもらう）:** 使い捨ての GitHub リポジトリ 1 つ（この Mac と Mac M2max の両方に clone して Orca に登録済み、`--auto` 専用の checkout）と、その Issue 2 件（`from-slack` と `Ready` と `priority: low` を付けた、1 行の README の修正のような小さいもの）。設定ファイルは worker が fixture をもとに手で書く（C3 がまだ無いため）。

- [ ] **Step 1: この Mac だけ** — `hosts` を local 1 台にした設定で、Orca の端末から `make auto NAME=probe` を Issue が Done になるか In review になるまで数分おきに繰り返す（判定の agent も起きる）。記録すること: 各 tick の stdout、Issue のコメントとラベルの順、PR、後片付けのあとに worktree・ブランチ・端末が残っていないこと。
- [ ] **Step 2: Mac M2max** — `hosts` を local（lanes 0 ではなく、2 件目を M2max に入れるため lanes 1）と M2max の 2 台にし、2 件を同時に Ready にする。1 件が M2max で動くこと、メールで成果が届くこと、遠くの worktree が後片付けで消えることを記録する。
- [ ] **Step 3: 片付け** — 設定・状態・使い捨てのブランチと PR を片付け、2 台の worktree・端末が増えていないことを確かめる。使い捨てのリポジトリと Orca への登録は残す（消すかはユーザーが決める）。
- [ ] **Step 4: 記録** — 結果を CLAUDE.md の「--auto の要点」に足し（確かめたこと・確かめられなかったこと）、コミット: `git commit -m "docs(orca-team-dispatch-task): --auto を 2 台の実機で通しで確かめた結果を書く"`。実機で確かめられなかったら、そう書く（作り話の結果を書かない）。
