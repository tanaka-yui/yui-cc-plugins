# orca-team-dispatch-task — TypeScript（node）への移行

作成: 2026-09-23
状態: **設計。未実装。**
対象: `apps/orca-team-dispatch-task` 3.6.0 以降
先行 spec: `docs/superpowers/specs/2026-09-23-orca-unbounded-wait-and-integration-design.md`

## 1. 解こうとしている問題

2026-09-23、influencer-platform の親セッションで、SKILL.md Step 5 の [C1] が誤停止した。
Orca 側は 4 役とも `retained`（正常）だったのに、`could not read the release state; do not close anything` で止まった。

- Claude Code の Bash ツールは、ユーザーのログインシェルで動く。mac も WSL も zsh である
- SKILL.md の `for ROLE in $ROLES; do`（C1 / C2 / C3）は、zsh では単語に分かれない。改行区切りの役名全体が 1 つの値になり、`.roles[$r].dispatch` が空になって fail closed した
- 回避のために `bash <<'EOF'` で流すと、途中の Orca CLI が標準入力（スクリプトの残り）を読んでしまい、判定を黙って飛ばして exit 0 で終わった
- 一方、`bash "$PLUGIN/bin/..."` でスクリプトを呼ぶ部分は、zsh から呼んでも正常に動いた

**壊れているのは「SKILL.md に書いたコードが、呼び出し側のシェルで実行される」部分である。**
SKILL.md から、呼び出し側のシェルに依存するコードを無くす。
あわせて、スクリプト本体も TypeScript に移す（ユーザーの決定）。

## 2. 決定事項（2026-09-23 のやりとり）

| 論点 | 決定 |
|---|---|
| 言語と実行系 | TypeScript を **node** で実行する（bun は、この環境ではグローバルに有効化されておらず、worker 側からも呼べる保証が無い） |
| 範囲 | `bin/*.sh` と `skills/*/scripts/*.sh` の全部、および SKILL.md の複数行ブロックの全部を TS にする |
| テスト | **既存の bash テストを残し、呼び出し先を `.ts` に替えて、TS 版の外からの動作確認に使う。**新しい共通部品だけは `node:test` で単体テストを書く |
| 進め方 | P1（土台と片付け）→ P2（残りのスクリプト）→ P3（SKILL.md の残りのブロック）。段階ごとに計画を分ける |
| Step 6 | 印字したコマンドをユーザー側のシェルに貼って実行するのをやめる。承認された操作をスクリプトが実行する |

## 3. 共通の設計（全段階）

### 3-1. 実行のしかた

- 呼び出しは `node "$PLUGIN/bin/<name>.ts" ...` の 1 行にする。worker への指示文の中でも `node <path>.ts` と書く
- Node の型除去（type stripping）で `.ts` を直接実行する。**前提は Node 22.18 以上**
  - 手元で確認: Node v24.15.0 で `node t.ts` が動き、`enum` はエラーになった
- `tsconfig` は `erasableSyntaxOnly: true` にする。`enum` / `namespace` / コンストラクタ引数のプロパティ化を書いた時点で弾く
- import は `.ts` の拡張子まで書く（`allowImportingTsExtensions: true`、`noEmit: true`）
- **実行時の npm 依存はゼロ**にする。プラグインはファイルのままインストールされ、`npm install` は走らないため、Node の組み込み（`node:child_process` / `node:fs` / `node:path` / `node:util` など）だけで書く。`typescript` と `@types/node` は型チェック用の開発時の依存に限る

### 3-2. 構成

```
apps/orca-team-dispatch-task/
  package.json      # @tanaka-yui/orca-team-dispatch-task, private, type: module
                    # scripts.check = tsc --noEmit && biome check ./bin ./lib ./skills ./test
  tsconfig.json     # strict, noEmit, erasableSyntaxOnly, allowImportingTsExtensions,
                    # module/moduleResolution: nodenext, types: ["node"]
  lib/              # 共通部品（入口からだけ import される）
    orca.ts         # Orca CLI 呼び出し
    json.ts         # Json 型と絞り込み
    fs.ts           # 原子的な書き込み、JSON の読み込み
    cli.ts          # 引数の解析、ログ、終了
  bin/*.ts          # 入口（1 ファイル 1 コマンド）
  skills/orca-team-dispatch-task/scripts/*.ts
  test/*.sh         # 既存の bash テスト（呼び出し先だけ .ts へ）
  test/unit/*.test.ts  # lib/ の単体テスト（node --test）
```

`pnpm-workspace.yaml` は `apps/*` を既に含むので、`package.json` を置けば turbo の `pnpm check` に乗る。

### 3-3. 共通部品

- `lib/orca.ts`
  - `orcaBin()`：今と同じ規則で解決する。`ORCA_BIN` → `ORCA_CLI_COMMAND` → `/Applications/Orca.app/Contents/Resources/bin/orca`
  - `runOrca(args: string[]): { rc: number; json: Json | null; stdout: string }`：`spawnSync` を `stdio: ['ignore', 'pipe', 'pipe']` で呼ぶ。**標準入力を渡さない**のは、`bash <<EOF` で起きた「CLI が標準入力を食う」問題を構造的に防ぐためである。stderr は捨てる（今の `2>/dev/null` と同じ）
  - receipt の `.ok == true` と `.result` の型の検査を 1 箇所に置く
- `lib/json.ts`
  - `type Json = string | number | boolean | null | Json[] | { [k: string]: Json }`
  - `JSON.parse` の結果は `Json` として受け、`asObject` / `asString` / `asArray` などの関数で絞り込む。**`any` / `unknown` は書かない**（ユーザーのコーディングルール）
- `lib/fs.ts`：同じディレクトリの一時ファイルに書き、`renameSync` で置き換える `writeAtomic`。読めなければ `null` を返す `readJson`
- `lib/cli.ts`
  - `node:util` の `parseArgs` の薄い包み
  - `log(name, msg)` は stderr に `<name>: <msg>` を出す（今の `orca-wait: ...` と同じ形）
  - `die(name, msg)` は exit 2
- `class` は使わない（ユーザーのコーディングルール）。エラーは戻り値で返す

### 3-4. 互換の規則

- 各入口のフラグ、終了コード、**テストが確かめている stdout / stderr の行**、書くファイルの形は、移す前の `.sh` と同じにする
- 移し替えの合格基準は「対応する bash テストの呼び出し先を `.ts` に替えて、全部通ること」である。テストの期待値は変えない（変える必要が出たら、その理由を計画に書く）
- 移し終えた `.sh` は削除する。**同じ振る舞いを 2 つ置かない**

### 3-5. zsh への回帰防止

- `test-docs.sh` に、SKILL.md と guide-ja.md の bash ブロックに `for <var> in $<VAR>` の形（呼び出し側のシェルで単語分割に頼る形）が無いことの検査を足す
- `zsh` が入っている環境では、`zsh -c` 経由で入口を呼んでも同じ結果になることを確かめるテストを足す（`zsh` が無ければ skip と出す）

## 4. P1: 土台と片付け（Step 5 / Step 6）

### 4-1. `bin/orca-cleanup.ts plan`（Step 5 の置き換え）

```
node "$PLUGIN/bin/orca-cleanup.ts" plan --status-dir <sd1> [--status-dir <sd2> ...]
```

- 渡すのは**その Run の全タスク**の status dir。今の [C7] の `SDS` と同じ要件で、兄弟を漏らすと ghost に見える
- 判定は今の [C1] / [C2] / [C3] / [C5] / [C7] と同じ条件で行う。条件・止まる理由・メッセージの文言は、今のブロックから移す
  - [C7]：Run 全体で 1 回。`worker-list --run <run> --terminal-state retained` の dispatch が、記録した dispatch に全部含まれること。各 status dir の `run_id` が同じ Run であること
  - [C1]：`release_pending` / `release_unknown` があればそのタスクは「停止」（inspection の argv も計画に載せる）
  - [C2]：`retained` / `active` / `reclaimable` / `not_requested` で、`terminal show` の handle と worktreeId が記録と一致するときだけ `worker-release --dispatch <id>` を提示する。`released` / `already_released` は「もう無い」
  - [C3]：merged、このディスパッチが作った worktree、clean、identity 一致、その worktree の端末が全部記録済み、のすべてが成り立つときだけ `worktree rm --worktree id:<id>` を提示する。成り立たない理由を全部挙げる
  - [C5]：merged で、`$SD` が `.dispatch` の直下の本物の status dir のときだけ、記録の削除を提示する
- 出力
  - **計画ファイル** `<repo>/.dispatch/cleanup-<run_id>.json` に書く。タスクごとに `offers`（`terminal` / `worktree` / `record`）、`kept`（残すものと理由）、`stopped`（止めた理由と inspection の argv）を持つ。各 offer は **argv の配列**で持ち、シェル文字列にしない
  - stdout には人向けの要約を出す。タスクごとに、提示できる操作、残すもの、理由を並べる
- 終了コード
  - 0：計画を作れた（提示する操作が無い場合も含む）
  - 1：Run 全体を止める（[C7] に該当した、記録や Orca の応答が読めない、別の Run の status dir が混じっている）。計画ファイルは書かない
  - 2：使用法の誤り
  - タスク単位の停止（[C1] など）は、そのタスクを `stopped` として計画に書き、ほかのタスクの判定は続ける
- **何も閉じない・消さない。**Orca に対しては読み取りのコマンド（`worker-list` / `terminal show` / `terminal list`）しか呼ばない

### 4-2. `bin/orca-cleanup.ts run`（Step 6 の置き換え）

```
node "$PLUGIN/bin/orca-cleanup.ts" run --plan <file> --approve <slug>:<terminal|worktree|record> [...]
```

- 計画ファイルにある offer のうち、承認されたものだけを実行する。**計画に無い操作は実行しない**（今の「Step 5 が印字したものだけを、印字どおりに」と同じ）。未知の `--approve` は使用法の誤り
- 順序：スラッグ順に、タスク内は 端末 → worktree → 記録
- `worker-release` / `worktree rm` は、計画の argv をそのまま `runOrca` で実行する。receipt が `.ok == true` でなければ、そのタスクの後続を止める。ほかのタスクには影響させない
- `worker-release` のあとは状態を読み直し、`releaseState: retained` / `retainedReason: user_takeover` なら「Orca が端末を保持したまま」と報告する（失敗扱いにはせず、worktree の段へは進める。今の Step 6 と同じ）
- 記録の削除は `fs.rmSync(sd, { recursive: true })` で行う。その直前に、[C5] と同じ「`.dispatch` の直下の status dir か」の検査をもう一度行う
- 最後に、タスクごとに「消したもの」「残したもの」を stdout に出す
- 終了コード：0 = 承認された操作を全部終えた / 1 = どれかが失敗した（失敗した操作と、残した後続を出力に書く）/ 2 = 使用法の誤り

### 4-3. SKILL.md / guide-ja.md

- Step 5 の [C1]〜[C7] の bash ブロックを、`plan` の 1 行ブロックに置き換える。各判定の意味の説明（ユーザーにどう言うか）は残す
- Step 6 は「`plan` の要約を見せ、1 回の `AskUserQuestion` で尋ね、承認された offer を `run` に渡す」にする。尋ね方の規則（タスクごとに 1 問、4 問まで、何も選ばないのも答え、提示されていない操作は出さない）は残す
- I4（`--issue` の終わり）の片付けも同じ呼び出しを使う

### 4-4. テスト

- `test-docs.sh` の片付けのテスト（SK6 系と、SK7 / SK9b / SK9c / SK11 / SK12 / SK13 のうち、SKILL.md のブロックを取り出して実行しているもの）は、新しい `test/test-cleanup.sh` に移す。同じスタブ、同じ状況で `orca-cleanup.ts plan` / `run` を叩き、**確かめる中身（どの状況で何を提示し、何で止まるか）は変えない**
- `test-docs.sh` には文書側の検査を残す: Step 5 / Step 6 が `orca-cleanup.ts` を呼ぶこと、判定の意味の説明が両文書にあること、3-5 の単語分割の検査
- `lib/` の単体テスト（`node --test test/unit/`）を足し、`test/run-all.sh` から呼ぶ

## 5. P2: 残りのスクリプトを 1 本ずつ移す（方針のみ。詳細は P2 の設計で詰める）

- 対象: `orca-wait` / `orca-start` / `orca-stop` / `orca-merge` / `orca-pr` / `orca-issue` / `orca-recover` / `orca-send` / `orca-wake` / `review-state`、`scripts/` の `completion` / `report-status` / `config-lib` / `config-resolve` / `config-edit` / `issue-fetch`
- 依存の少ないものから移す（`config-lib` → `config-resolve` → `review-state` → `orca-send` / `orca-wake` → ... → `orca-wait` / `orca-start`）
- worker が呼ぶもの（`completion` / `report-status` / `orca-send`）は、指示文の呼び出しも `node` に替える
- **実機で確かめること**: exec を担う codex の worker の sandbox から `node` が呼べるか。呼べなければ、worker 向けの 3 本だけ別の扱いを考える

## 6. P3: SKILL.md の残りのブロック（方針のみ）

S0、Step 1b〜4、Step 3.5、I0〜I4 の複数行ブロックを、入口の 1 行呼び出しにする。
ブロックの中で状態を読み分けている箇所（`wait.json` の年齢、`status.json` の確認など）は、小さな入口にまとめる。

## 7. 範囲外

- bun の採用（グローバルな有効化が前提になるため見送り）
- テストの TS への書き換え（既存の bash テストを外からの動作確認として使い続ける）
- 他のプラグイン（cmux 系など）の TS 化
