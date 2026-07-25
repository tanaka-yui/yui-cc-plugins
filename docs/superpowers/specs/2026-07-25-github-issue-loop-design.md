# cmux-team-dispatch-task GitHub issue 自動ループ設計

- 対象プラグイン: `apps/cmux-team-dispatch-task`
- 作成日: 2026-07-25
- 改訂: round 1 レビュー反映（2026-07-25）
- ステータス: 設計確定（実装計画は別途 `.claude/plans/github-issue-loop.md`）

## 1. 目的とスコープ

現行の cmux-team-dispatch-task は「ユーザーが渡したタスク一覧を一度だけ並列ディスパッチする」ワンショット型である。これを **GitHub issue を自動取得し、対象 issue がなくなるまで回し続ける loop モード** に拡張する。

本設計が満たす要件:

| 要件 | 内容 |
|------|------|
| 要件 1 | `gh issue list` で対象 issue を自動取得してタスク化し、バッチ単位で対象がなくなるまで繰り返す。二重ディスパッチを防ぐ |
| 要件 2 | ループ中に `AskUserQuestion` が一切発生しない。通常（非ループ）モードの挙動は不変 |
| 要件 3 | ループ開始前に必要な設定をまとめて質問し、以後ループ中は再質問しない |
| 要件 4 | codex 子セッション／standby ペインが承認待ちで停止しないことを全経路で保証する |

**非スコープ**（意図的に含めない。制約として §11 に明記する）:

- スロット方式（1 件完了ごとに次を投入）の並列制御 — バッチ方式を採用する
- ループ設定の永続化（config.json への保存）— 毎ループ開始時に質問する
- `claude-teams` / `split` レイアウトでのループ — workspace レイアウト固定
- **同一リポジトリに対する複数ループの並行実行** — GitHub ラベルでは原子的な claim を実現できないため、リポジトリ単位で単一オーケストレータを前提とし、ローカルロックで検出して拒否する
- レビューペインへの `--allow-unix-socket` 付与 — 現仕様でレビューペインは cmux CLI を使わない

## 2. 設計判断のサマリ

| 論点 | 決定 | 理由 |
|------|------|------|
| 駆動主体 | 親 Claude セッションが回す | 既存アーキテクチャをそのまま利用でき、新規スクリプトが最小で済む |
| 設計フェーズの無人化 | plan モード固定 + `--dangerously-skip-permissions` | superpowers の brainstorming は承認ゲートを持ち無人実行と本質的に相容れない。設計品質は Phase A-R レビューで担保する |
| 二重防止 | GitHub ラベル 3 種（`in-progress` / `done` / `failed`）+ ローカル状態ファイル + リポジトリ単位ロック | ラベルは可視性と durable な処理済みマーク、ローカル状態はラベル操作失敗時の保険、ロックは並行ループの禁止 |
| 並列制御 | バッチ方式（N 件同時 → 全完了 → 次バッチ） | 既存の「全タスク完了検知 → 集計」フローをバッチ単位で再利用できる |
| バッチ完了待ち | **`monitor-dispatch.sh` を使わず、親が当該バッチの slug 集合だけを status.json でポーリング** | 既存 monitor は `.dispatch/*` を全件走査するため、前バッチの残骸や非ループ dispatch が混ざると永久待機する |
| バッチ間 cleanup | status × integration の遷移表に従って決定的に実行する（§3.7） | 「必ず片付ける」だけでは merge 失敗時と調査用保持の扱いが決まらない |
| integration strategy | ループ開始前に 1 回選択 | ローカルブランチを削除してよいかがこれで決まる |
| error 時 | スキップして継続 | 大量 issue を回す目的に沿う。`dispatch/failed` ラベルで再取得されない |
| 上限 | 最大バッチ数を設定質問に含める | フィルタ条件の誤りによる暴走を防ぐ |
| ループ発動 | **明示 opt-in のみ**（`--loop` フラグ、または Step L0 の開始確認を通過したとき） | 通常のタスク文に issue の話題が混ざってもループへ誤分類しない |
| ドキュメント配置 | `references/loop-mode.md` に分離 | SKILL.md は既に 130KB / 2286 行。非ループ利用者の読み込み量を増やさない |

## 3. アーキテクチャ

### 3.1 全体フロー

```
Step L0  プリフライト（設定質問より前。失敗ならループを開始しない）
  L0-1  発動確認: --loop フラグが無い場合は「ループモードで開始しますか」を 1 問確認する
          （このゲートを通らない限りループには入らない = 非ループ挙動の保護）
  L0-2  依存検査: runners.json / gh auth status / issue が有効 / jq / cmux
  L0-3  ロック取得: .dispatch/loop.lock に {pid, host, started_at} を書く。
          既存ロックの pid が生存していれば「別のループが実行中」としてエラー終了
  L0-4  stale 検査: .dispatch/ に既存の <slug>/ ディレクトリがあればエラー終了し、
          手動整理を促す（前回ループや非ループ dispatch の残骸を混ぜないため）
  L0-5  reconciliation: 既存 loop-state.json に status=claimed のまま残る issue があれば
          ラベルを外して release し、状態から除去する
  L0-6  ラベル整備: dispatch/in-progress, dispatch/done, dispatch/failed を
          gh label list で確認し、無いものだけ gh label create する（失敗は fatal）
Step L1  ループ設定の一括質問（AskUserQuestion 最大 3 コール）
         ── ここから先、ループが終わるまで一切質問しない ──
Step L2  バッチループ（batch = 1, 2, ...）:
  L2-1  issue-fetch.sh --limit <concurrency> --batch <N>
          → 候補取得 → 除外 → claim（dispatch/in-progress 付与 + status=claimed 記録）
          → タスク JSON を出力
          → exit 0 かつ [] なら「対象 issue なし」で Step L3 へ
          → exit 3（候補はあったが claim が 1 件も成立しなかった）なら
            警告を出し、ループを中断して Step L3 へ（無限空回りを防ぐ）
  L2-2  既存 Step 1b / Step 2 の手順でタスクプロンプトを構築
          （plan モードのテンプレート + {{UNATTENDED_BLOCK}} を焼き込む）
  L2-3  workspace レイアウト + pre-warm で一斉起動（既存 Step 2 をそのまま利用）
          - 起動に成功した slug は issue-fetch.sh --mark-dispatched <n> で status=dispatched に
          - 起動に失敗した slug は issue-fetch.sh --release <n> で claim を解放し、
            そのバッチの待機対象から外す
  L2-4  そのバッチで dispatched になった slug 集合だけを対象に、全件が terminal state
          (done / error) になるまで status.json をポーリングする
          （タスク単位タイムアウト超過は timeout として打ち切る）
  L2-5  Template B で結果報告 → loop-cleanup.sh でバッチ cleanup
  L2-6  batch++ → 最大バッチ数チェック → L2-1 へ
Step L3  ループ全体サマリ（Template C を batch 列付きに拡張）+ .dispatch/loop.lock を解放
```

### 3.2 コンポーネント一覧

**新規ファイル（3 点）**

| ファイル | 責務 | 依存 |
|---|---|---|
| `skills/cmux-team-dispatch-task/references/loop-mode.md` | ループ手順の SoT。L0〜L3、一括設定質問の文面、フォールバック表、ラベル遷移表、cleanup 遷移表 | なし（ドキュメント） |
| `skills/cmux-team-dispatch-task/scripts/issue-fetch.sh` | issue の取得 / 除外 / claim / release / mark-dispatched / reconcile と `loop-state.json` の管理 | `gh`, `jq`, `git` |
| `skills/cmux-team-dispatch-task/scripts/loop-cleanup.sh` | バッチ終了処理（pane close / worktree / branch / issue ラベル / 状態記録） | `cmux`, `gh`, `jq`, `git` |

**変更ファイル**

| ファイル | 変更内容 |
|---|---|
| `skills/cmux-team-dispatch-task/SKILL.md` | ループ発動のディスパッチポイント（約 10 行）＋ Step 1c–1g / cleanup 節への「loop モードでは `references/loop-mode.md` の一括設定で解決済み」注記。手順本体は重複させない |
| `skills/cmux-team-dispatch-task/scripts/launch-workspace.sh` | ① codex 全経路に `--dangerously-bypass-hook-trust` を追加（要件 4）② **`--unattended` フラグを追加**し、`--mode execute` の `REVIEW_INSTRUCTION` に含まれる AskUserQuestion フォールバックを非対話版へ差し替える |
| `skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh` | `--unattended` フラグを追加。指定時、設計ペイン（claude opus standby）に `--skip-permissions` を付与する |
| `skills/cmux-team-dispatch-task/references/guide-ja.md` | ループモード節の追加、engine × MODE 起動表の更新、`--unattended` の説明 |
| `README.md` | ループモードの利用者向け説明、codex 起動フラグ表の更新、hook trust バイパスの注記 |
| `CLAUDE.md` | メンテナンス手順に項目追加、項目 20 / 39 の更新、E2E テスト項目の追加 |
| `.claude-plugin/plugin.json` / ルート `.claude-plugin/marketplace.json` | version 1.9.0 → 1.10.0 |
| `test/test-launch-workspace-codex.sh` | hook trust バイパスと `--unattended` の静的検査を追加（claude 側の非付与 assert は全 5 モードへ拡張） |
| `test/test-issue-fetch.sh`（新規） | 除外フィルタ・claim/release の状態遷移の検査（`gh` はスタブ化） |
| `test/test-codex-review-sandbox.sh`（新規） | `codex sandbox` を使った動的検査（§7） |

`monitor-dispatch.sh` は**変更しない**。ループモードでは使用しないため（§3.6）。

### 3.3 新規スクリプトの CLI 契約

**`issue-fetch.sh`**

```
issue-fetch.sh --state-file <path> <subcommand> [options]

subcommand:
  fetch     候補取得 → 除外 → claim → タスク JSON 出力
              --limit <N>            claim する上限件数（必須）
              --batch <N>            記録するバッチ番号（必須）
              --labels <a,b>         カンマ区切りのラベルフィルタ
              --assignee <@me|none>  省略時はフィルタなし
              --state <open|all>     既定 open
              --dry-run              claim も状態更新もせず候補だけ出力
  mark-dispatched --issue <n>   status を claimed → dispatched に更新
  release         --issue <n>   dispatch/in-progress を外し、状態から当該 issue を除去
  reconcile                     status=claimed のまま残る全 issue を release する
  finalize        --issue <n> --status <done|error|timeout> [--pr-url <url>] [--message <s>]
                                最終結果を記録する（ラベル遷移は loop-cleanup.sh が行う）

--state-file  .dispatch/loop-state.json のパス（必須。無ければ初期化して作る）

stdout: fetch のみタスク JSON 配列（§3.4 のスキーマ）。他は無出力
exit  : 0 = 正常（fetch の 0 件を含む）
        1 = 致命的失敗（gh / jq 不在、認証エラー、loop-state.json 破損）
        3 = fetch で候補は存在したが claim が 1 件も成立しなかった
stderr: [fetch] / [claim] / [release] / [warn] のログ
```

`fetch` は候補 0 件（exit 0 + `[]`）と claim 全滅（exit 3）を**明確に区別する**。前者はループの正常終了、後者は権限・通信の異常であり、同じ扱いにすると無限に空回りする。

**`loop-cleanup.sh`**

```
loop-cleanup.sh --state-file <path> --batch <N> --integration <pr|merge>
                [--dispatch-dir <path>] [--repo-root <path>] [--agmsg-team <team>]

--state-file    .dispatch/loop-state.json のパス（必須）
--batch         cleanup 対象のバッチ番号（必須。loop-state.json の batches から slug 群を引く）
--integration   pr | merge（必須）
--dispatch-dir  既定 <repo-root>/.dispatch
--repo-root     既定 git rev-parse --show-toplevel
--agmsg-team    指定時、対象 slug の agmsg agent を leave.sh で除籍する

stdout: バッチ結果サマリ JSON {batch, done, error, timeout, merged, conflicted, leaked}
exit  : 0 = 正常（個別の失敗は警告扱いでループを止めない）
        1 = 致命的失敗（loop-state.json 破損）
```

`leaked` は削除に失敗した worktree / branch の一覧。`loop-state.json.leaked[]` にも追記し、Step L3 のサマリで手動整理対象として提示する。

いずれも「個別 issue / タスクの失敗はループを止めない」を原則とし、致命的な前提崩れのときだけ非 0 で終了する。

### 3.4 データ構造

**`.dispatch/loop-state.json`**

```json
{
  "started_at": "2026-07-25T10:00:00Z",
  "filter": { "labels": ["enhancement"], "assignee": "@me", "state": "open" },
  "config": {
    "concurrency": 3, "max_batches": 5, "integration": "pr",
    "design_runner": "claude", "exec_choice": "sonnet", "review_mode": "on",
    "task_timeout_min": 90
  },
  "batches": [
    { "n": 1, "issues": [12, 13], "started_at": "...", "finished_at": "..." }
  ],
  "issues": {
    "12": { "slug": "issue-12-fix-login", "status": "done", "pr_url": "https://…", "batch": 1 },
    "13": { "slug": "issue-13-add-cache", "status": "error", "message": "…", "batch": 1 }
  },
  "leaked": []
}
```

`issues` のキーは issue 番号（文字列）。`status` の遷移は次のとおり:

```
claimed ──(launch 成功)──> dispatched ──> done | error | timeout
   └──(launch 失敗 / reconcile)──> レコード削除（release）
```

書き込みは常に **同一ディレクトリの一時ファイル + `mv`（atomic replace）** で行う。親セッションが単独の writer であるため排他は不要だが、途中で落ちても壊れた JSON を残さないことを保証する。

このファイルは **バッチ間 cleanup では削除しない**。ループ終了後も結果を辿れるよう残し、Step L3 では削除手順を表示するだけで自動削除はしない。

**`.dispatch/loop.lock`**

```json
{ "pid": 12345, "host": "yui-mbp", "started_at": "2026-07-25T10:00:00Z" }
```

Step L0-3 で作成し、Step L3 で削除する。既存ロックがあり `kill -0 <pid>` が通る場合はループを開始しない。pid が死んでいれば stale として上書きする。

**タスク JSON（`issue-fetch.sh fetch` の stdout）**

```json
[
  { "number": 12, "slug": "issue-12-fix-login", "title": "Fix login redirect",
    "url": "https://github.com/owner/repo/issues/12", "body": "…" }
]
```

`slug` は `issue-<number>-<title を lowercase・ハイフン化したもの>` を 30 文字で切り詰めた値。`[A-Za-z0-9._-]` のみを残す（`launch-workspace.sh` の workspace 名バリデーションに合わせる）。

### 3.5 issue 取得と二重ディスパッチ防止

**ラベル体系（3 種）**

| ラベル | 意味 | 付与タイミング | 除去タイミング |
|---|---|---|---|
| `dispatch/in-progress` | claim 済み・作業中 | claim 時 | 完了時に `done` / `failed` へ付け替え、または release 時 |
| `dispatch/done` | ディスパッチ完了（PR 作成済み or merge 済み） | タスク done 時 | 付けたまま残す（durable な処理済みマーク） |
| `dispatch/failed` | 失敗・要調査 | タスク error / timeout / merge conflict 時 | 付けたまま残す |

`dispatch/done` を残すことが、**PR がマージされるまで issue が open のままでも再ディスパッチされない**ことの保証になる。整合性のため、integration = `merge` で merge が成功した場合はさらに `gh issue close --reason completed` を実行する（`Closes #N` を持つ PR が存在しないため）。

**取得クエリ**

```bash
gh issue list --state "$STATE" [--label "$LABEL"] [--assignee "$ASSIGNEE"] \
  --limit $((LIMIT * 4)) --json number,title,body,url,labels
```

取得件数に余裕（`LIMIT * 4`）を持たせ、除外後に `LIMIT` 件を確保する。

**除外条件（jq で適用）**

1. `dispatch/in-progress` / `dispatch/done` / `dispatch/failed` のいずれかを持つ issue
2. `loop-state.json` の `issues` に既に登録されている番号

**claim（着手マーク）**

```bash
gh issue edit "$n" --add-label dispatch/in-progress
```

- ラベルの存在確認と作成は Step L0-6 で行う。`gh label list --json name` で列挙し、無いものだけ `gh label create` する。**`|| true` では潰さない** — 認証・権限・通信エラーを「既に存在」と誤認しないため、作成失敗はループ開始を止める
- **claim に失敗した issue はそのバッチから除外する**（ラベルが付かないまま起動すると次バッチで再取得され、無限に同じ issue を拾い続ける）
- claim 成功と同時に `loop-state.json.issues["<n>"] = {slug, status: "claimed", batch: N}` を書く
- 候補が 1 件以上あったのに claim が 1 件も成立しなかった場合は exit 3 を返す（§3.3）

**claim 後・起動前の失敗の扱い**

| 事象 | 対応 |
|---|---|
| プロンプト構築 / worktree 作成 / pane 起動が失敗 | `issue-fetch.sh release --issue <n>` でラベルを外し状態から除去。そのバッチの待機対象に含めない |
| 親セッションが claim 後に落ちた | 次回ループの Step L0-5 reconciliation が `status=claimed` を検出して release する |
| バッチの一部だけ起動成功 | 成功分のみ `mark-dispatched` して待機。失敗分は release 済みなので待機対象に含まれず、タイムアウト待ちも発生しない |

**完了時のラベル更新（`loop-cleanup.sh`）**

| タスク結果 | ラベル操作 | issue 状態 |
|---|---|---|
| `done`（integration = pr） | `in-progress` を外し `dispatch/done` を付与 | open のまま（PR の `Closes #N` でマージ時に閉じる） |
| `done`（integration = merge、merge 成功） | `in-progress` を外し `dispatch/done` を付与 | `gh issue close --reason completed` |
| `done`（integration = merge、merge conflict） | `in-progress` を外し `dispatch/failed` を付与 + コンフリクト報告コメント | open のまま |
| `error` / `timeout` | `in-progress` を外し `dispatch/failed` を付与 + 失敗コメント | open のまま |

ラベル操作の失敗は警告のみでループを止めない（`loop-state.json` が同一ループ内の保険として機能する）。

### 3.6 バッチ待機とタイムアウト

**`monitor-dispatch.sh` はループモードでは使用しない。** 既存 monitor は `--dispatch-dir` 配下の `*/status.json` を全件走査し、1 件でも terminal でなければ完了しないため、前バッチで保持した failed ディレクトリ、cleanup に失敗した残骸、あるいは同じリポジトリで実行された非ループ dispatch の痕跡が 1 件でもあると次バッチの待機が永久に終わらない。

代わりに、親セッションが **そのバッチで `dispatched` になった slug 集合だけ**を対象にポーリングする:

```bash
for slug in "${BATCH_SLUGS[@]}"; do
  st=$(jq -r '.status // "unknown"' ".dispatch/$slug/status.json" 2>/dev/null)
  …
done
```

- 完了通知（`[dispatch] task "<slug>" finished`）は runner wrapper から `cmux send` + `send-key return` で両トランスポートとも届くため、親は通知でも起こされる。ただし**待機の正となるのは status.json のポーリング**とする
- Step L0-4 の stale 検査により、ループ開始時点で `.dispatch/<slug>/` が存在しないことは保証済み

**タスク単位のタイムアウト**: 無人実行では応答のない子を永久に待てないため、タスクあたりの上限時間を設ける。

- 既定値 90 分。`<project>/.dispatch/config.json` → `~/.claude/cmux-team-dispatch-task/config.json` の順で `loop.task_timeout_min` を解決する（設定質問には含めない）
- 超過したタスクは `timeout` として扱い、`status.json` を `error` に書き換えたうえで cleanup と `dispatch/failed` 付与を行う

### 3.7 バッチ間 cleanup（`loop-cleanup.sh`）

**cleanup 遷移表（これが SoT）** — バッチ内の各 slug について、結果と integration に応じて決定的に処理する。

| # | タスク結果 | integration | merge 試行 | worktree | branch `feat/<slug>` | `.dispatch/<slug>` |
|---|---|---|---|---|---|---|
| 1 | `done` | `pr` | しない | 削除 | 削除（リモートに push 済み） | 削除 |
| 2 | `done` | `merge` | する → 成功 | 削除 | 削除 | 削除 |
| 3 | `done` | `merge` | する → conflict | **温存** | **温存** | **温存** |
| 4 | `error` / `timeout` | 両方 | しない | 削除 | **温存**（作業内容は branch に残る） | **温存**（status.json / result.md を調査用に残す） |

設計方針:

- **worktree は #3 以外すべて削除する**。失敗タスクの成果物はブランチに残るため（`git log feat/<slug>` で追える）、worktree を残す必要はない。これにより `.worktrees/` が失敗数に比例して無制限に増えることを防ぐ
- **`--keep-failed` フラグは設けない**。保持の要否は上表で一意に決まる
- `.dispatch/<slug>` は失敗時のみ残す（status.json と result.md のみの軽量ディレクトリ）。Step L0-4 の stale 検査があるため、次回ループ開始時にユーザーが必ず気付く

**実行順序**（各 slug ごと）:

1. `.dispatch/<slug>/prewarm.json` の全 `surface_id` を `cmux close-surface`
2. `.dispatch/<slug>/status.json` の `workspace_id` を `cmux close-workspace`
3. integration = `merge` かつ結果が `done` の場合、**worktree を削除する前に** 親で `git merge "feat/<slug>" --no-edit` を試みる
   - 成功 → 手順 4 へ進む
   - conflict → `git merge --abort` して worktree・branch とも温存し、`dispatch/failed` を付与してこの slug の cleanup を終了（#3）
4. 上表に従い `git worktree remove ".worktrees/<slug>" --force`
5. 上表に従い `git branch -D "feat/<slug>"`
6. `issue-fetch.sh finalize` 相当の記録を `loop-state.json.issues["<n>"]` に書く。手順 4/5 が失敗した場合は `loop-state.json.leaked[]` に追記する
7. 上表に従い `rm -rf ".dispatch/<slug>"`
8. `agmsg` モードのときは `leave.sh <team> <slug>` / `-sonnet` / `-codex` / `-review` / `-opus` を実行して team から除籍する

pane close を最初に行うのは既存 cleanup と同じ理由（ペインを閉じないと worktree が掴まれたまま `git worktree remove` に失敗する）。merge を worktree 削除より**前**に置いたのは、conflict 時に worktree を温存する契約と順序を整合させるためである。

## 4. 要件 2 — AskUserQuestion 全廃

### 4.1 全 18 箇所の解決マッピング

| # | 箇所 | 現行 | loop モードでの解決 |
|---|---|---|---|
| 1 | Step 1a タスク収集 | 質問 | `issue-fetch.sh fetch` の出力に置換 |
| 2 | Step 1c brainstorming 選択 | 質問 | plan モード固定（質問なし） |
| 3 | Step 1d layout | 質問 | workspace 固定（pre-warm / standby が workspace 前提。設定質問にも含めない） |
| 4 | Step 1e integration strategy | 質問 | 設定質問コール② で 1 回 |
| 5 | Step 1f runner switch / per-task runner | 質問 | 設定質問コール②（design runner）で 1 回。全タスク同一 runner |
| 6 | Step 1f first-run setup（runners.json 対話生成） | 対話ループ | **プリフライト Step L0-2 で検査**し、`runners.json` 不在ならループを開始せずエラー終了 |
| 7 | Step 1f cross-engine reviewer 選択 | 質問 | claude engine runner が 1 件なら自動採用、2 件以上なら設定質問コール③ で 1 回 |
| 8 | Step 1g message_type | 初回のみ質問 | config 未設定時のみ設定質問コール③ に含める（1 回・従来どおり永続化） |
| 9 | Step 1g review_mode | 毎 dispatch 質問 | 設定質問コール② で 1 回。ループ中は固定 |
| 10 | 完了時 Wait-and-merge の Option A/B | 質問 | integration = `merge` なら常に merge（Option A）。conflict は §3.7 #3 の遷移で自動処理 |
| 11 | 完了時 cleanup 3 問 | 質問 | §3.7 の cleanup 遷移表で決定的に処理 |
| 12 | Phase A-R 3 往復 needs_work | 子が質問 | 「このまま進む」を自動選択。未解決指摘を文書末尾に注記 |
| 13 | Phase A-R stalled | 子が質問 | 同一ラウンドの再依頼 1 回（従来どおり）→ なお stalled なら「レビュー省略して Phase B へ」を自動選択 |
| 14 | Phase B 実行モデル選択 | 子が質問 | 設定質問コール② の exec runner を `{{EXEC_DEFAULT_HINT}}` に焼き込む（**既存の default-direct 経路をそのまま利用**） |
| 15 | Phase B exec_choice 永続化確認 | 子が質問 | 14 により `exec_choice` が確定するため発生しない |
| 16 | Phase B-R 3 往復 needs_work | 子が質問 | 「このまま PR 作成」を自動選択。未解決指摘を PR 本文に注記 |
| 17 | Phase B-R stalled | 子が質問 | 「レビュー省略して PR 作成」を自動選択 |
| 18 | brainstorming / ExitPlanMode の暗黙の承認ゲート | 承認待ちで停止 | plan モード固定 + `--dangerously-skip-permissions` により承認プロンプト自体が出ない（§4.4） |

### 4.2 `{{UNATTENDED_BLOCK}}`（プロンプト経路）

12 / 13 / 16 / 17 は子セッションのプロンプトに焼き込まれた `{{REVIEW_BLOCK}}` / `{{CODE_REVIEW_BLOCK}}` の中にある。これらのブロック本体を書き換えるのではなく、**新しいプレースホルダ `{{UNATTENDED_BLOCK}}` を追加し、その中で AskUserQuestion 分岐だけを上書きする**方式を採る。

```text
=== UNATTENDED MODE ===
This session runs unattended as part of an automated issue loop.
You MUST NOT call AskUserQuestion for any reason. Whenever a block above
tells you to ask the user, take the fixed fallback below instead and note
what you did in the document / PR body you produce.

  - Phase A-R, round 3 still needs_work → take "このまま進む":
      append the unresolved findings as a note to the document and continue.
  - Phase A-R, the wait exits stalled twice → take "レビューを省略して Phase B へ進む".
  - Phase B-R, round 3 still needs_work → take "このまま PR 作成":
      note the unresolved findings in the PR body and continue.
  - Phase B-R, the wait exits stalled twice → take "レビュー省略して PR 作成".
  - Any other decision point not covered above → pick the option that lets the
    task reach a terminal state (done / error) without user input, and record
    the decision in result.md.
When you delegate implementation in Phase B, propagate this constraint:
  - pre-warm path → include the same UNATTENDED MODE text in REQUEST_TEXT.
  - spawn fallback → pass --unattended to launch-workspace.sh --mode execute.
=== END UNATTENDED MODE ===
```

- 挿入位置: `{{REVIEW_BLOCK}}` の直前
- **非ループ時は空文字列**を代入する。したがって通常モードのプロンプトは 1 バイトも変わらない

### 4.3 `launch-workspace.sh --unattended`（spawn 経路）

プロンプト経路だけでは要件 2 を満たせない。Phase B で `prewarm.json` が無い場合（`prewarm: false` / split レイアウト / pre-warm 失敗）、実装者は `launch-workspace.sh --mode execute` で spawn され、その inner prompt は plan file と `REVIEW_INSTRUCTION` から**新規に構築される**。元のタスクプロンプト（したがって `{{UNATTENDED_BLOCK}}`）は読まれない。現行の `REVIEW_INSTRUCTION` は round 3 / stalled 時に「可能なら AskUserQuestion で聞け」と明記しているため、この経路ではループ中に質問が発生し得る。

**修正**: `launch-workspace.sh` に `--unattended` フラグを追加する。

| 対象 | `--unattended` 無し（既定・現行どおり） | `--unattended` 付き |
|---|---|---|
| `REVIEW_INSTRUCTION` の round 3 needs_work | 「AskUserQuestion で聞け、聞けなければ PR 本文に注記して進め」 | 「PR 本文に未解決指摘を注記して進め」（質問部分を削除） |
| `REVIEW_INSTRUCTION` の stalled | 「AskUserQuestion で聞け（再依頼 / 省略）」 | 「レビューを省略し、その旨を PR 本文に注記して進め」 |
| claude engine の execute | 呼び出し側の `--skip-permissions` に従う | `--dangerously-skip-permissions` を強制付与 |
| codex engine の execute | 現行どおり bypass | 変更なし（既に非対話） |

`--unattended` は `--mode execute` および `--mode standby` で有効とし、他のモードで指定された場合は警告して無視する。ループモードの子プロンプトは、spawn fallback を使う際に必ずこのフラグを渡すよう指示する（§4.2 の末尾 2 行）。

回帰テストでは、pre-warm on/off × claude/codex × review 有無の組合せで、生成される runner script に `AskUserQuestion` の文字列が残らないことを検査する。

### 4.4 暗黙の承認ゲートの解消

現行の既定経路（`message_type: agmsg` + `prewarm: true`）では、設計ペインは `launch-workspace.sh --mode plan` ではなく **`--mode standby`** で起動され、`--skip-permissions` が付いていない（`prewarm-panes.sh` の opus standby 起動）。タスクは後から typed prompt で届く。

そのため「plan モード固定 + skip-permissions」は次の 2 点で実現する:

1. `prewarm-panes.sh` に `--unattended` フラグを追加し、指定時は設計ペイン（claude opus standby）の起動に `--skip-permissions` を渡す。sonnet standby には既に付いており、codex 系は bypass フラグで解決済み
2. 設計ペインへ送る `TASK_TEXT` の Mode を常に `plan` にする。プロンプトファイルには plan モード用テンプレート（`{{UNATTENDED_BLOCK}}` 込み）を書き込む

pre-warm を使わない経路（`prewarm: false`）では `launch-workspace.sh --mode plan` が使われ、これは既に `--dangerously-skip-permissions` を付与しているため追加変更は不要。

## 5. 要件 3 — ループ開始前の一括設定質問

`AskUserQuestion` は 1 コールあたり最大 4 問という制約があるため、3 コールに分割する。Step L0-1 の発動確認は、これらより前に行う独立した 1 問である。

### コール① 対象 issue

| # | 質問 | 選択肢 |
|---|---|---|
| 1 | 対象にする issue のラベル | `gh label list` から動的生成（`dispatch/*` を除いた上位 3 件）+ 「フィルタなし」+ Other（自由入力でカンマ区切り指定可） |
| 2 | assignee フィルタ | 自分 (`@me`) / 未アサインのみ / 指定なし |
| 3 | 1 バッチの並列実行数 | 2 / 3 / 5 |
| 4 | 最大バッチ数 | 3 / 5 / 10 / 無制限 |

`state` は `open` 固定（クローズ済み issue をディスパッチする意味がないため質問しない）。

### コール② 実行構成

| # | 質問 | 選択肢 |
|---|---|---|
| 1 | design runner（子セッションのランタイム） | `runners.json` の `runners[]` から動的生成（label = `name`, description = `command (engine)`） |
| 2 | exec runner（Phase B 実行モデル） | opus 1m / sonnet / codex（`engine: codex` runner がある場合のみ 3 択目を表示） |
| 3 | レビュー機能（Phase A-R / Phase B-R） | 有効 / 無効 |
| 4 | integration strategy | PR per task / Wait and merge |

### コール③ 補完・最終確認

該当する項目のみを出す。すべて不要なら最終確認 1 問だけになる。

| # | 質問 | 出す条件 |
|---|---|---|
| 1 | 通知トランスポート（`message_type`） | config 未設定 かつ agmsg インストール済み。回答は従来どおり global config に永続化 |
| 2 | reviewer runner（design=codex 時の claude 側レビュアー） | design runner が codex engine かつ claude engine runner が 2 件以上 かつ レビュー有効 |
| 3 | この設定でループを開始しますか | 常に（開始 / 設定をやり直す） |

「設定をやり直す」を選んだ場合はコール① から再実行する。**この最終確認を通過した時点でループ設定は確定し、以後ループが終わるまで一切質問しない。**

確定した設定は `loop-state.json.config` / `.filter` に記録し、ループ全体を通してそこから読む。

## 6. 要件 4 — codex 承認待ちの解消

### 6.1 監査結果

codex を起動しうる全経路を精査した。`prewarm-panes.sh` と `launch-session-splits.sh` は自前で codex を起動せず、すべて `launch-workspace.sh` に委譲しているため、独立した漏れは存在しない。

| # | 経路 | 現行フラグ | 判定 |
|---|---|---|---|
| 1 | `launch-workspace.sh` codex × plan | `--dangerously-bypass-approvals-and-sandbox` | 対応済み |
| 2 | `launch-workspace.sh` codex × superpowers | `--dangerously-bypass-approvals-and-sandbox` | 対応済み |
| 3 | `launch-workspace.sh` codex × execute | `--dangerously-bypass-approvals-and-sandbox` | 対応済み |
| 4 | `launch-workspace.sh` codex × standby（pre-warm 経由） | `--dangerously-bypass-approvals-and-sandbox` | 対応済み |
| 5 | `launch-workspace.sh` codex × review | `--sandbox workspace-write` + `-c approval_policy='never'` + `--add-dir <STATUS_DIR>` | 対応済み（§6.3 で実測検証） |
| — | **上記 5 経路すべてに共通** | **hook trust のバイパスが無い** | **未対応 — 要修正** |

### 6.2 未対応項目: codex hook trust

codex 0.145.0 は、プロジェクトローカルのフック定義に対して信頼確認を行う。信頼状態は `~/.codex/config.toml` の以下の形式で永続化される:

```toml
[hooks.state."<hooks.json の絶対パス>:<event>:<i>:<j>"]
trusted_hash = "sha256:…"
```

キーが **hooks.json の絶対パスを含む**ことが問題になる。agmsg の `delivery.sh set monitor codex <worktree>` は worktree ごとに新しい `<worktree>/.codex/hooks.json` を生成するため、ディスパッチのたびにパスが変わり、常に未信頼と判定される。結果、codex セッションは起動直後に hook trust の承認待ちで停止する。

`--dangerously-bypass-approvals-and-sandbox` はコマンド実行の承認とサンドボックスを無効化するだけで、hook trust には作用しない。`codex --help` でも両者は別項目として定義されている:

```
--dangerously-bypass-approvals-and-sandbox
    Skip all confirmation prompts and execute commands without sandboxing.
--dangerously-bypass-hook-trust
    Run enabled hooks without requiring persisted hook trust for this invocation.
```

**修正**: `launch-workspace.sh` の codex 分岐 5 箇所すべてに `--dangerously-bypass-hook-trust` を追加する。review モードは従来の 3 点セットから 4 点セットになる。

```
codex × plan        : <cmd> [-c effort] --dangerously-bypass-hook-trust --dangerously-bypass-approvals-and-sandbox '/plan …'
codex × superpowers : <cmd> [-c effort] --dangerously-bypass-hook-trust --dangerously-bypass-approvals-and-sandbox '$superpowers:brainstorming …'
codex × execute     : <cmd> [-c effort] [--model X] --dangerously-bypass-hook-trust --dangerously-bypass-approvals-and-sandbox '…'
codex × standby     : <cmd> [-c effort] [--model X] --dangerously-bypass-hook-trust --dangerously-bypass-approvals-and-sandbox ['…']
codex × review      : <cmd> [-c effort] --model <review_model> --dangerously-bypass-hook-trust --sandbox workspace-write -c approval_policy='never' --add-dir <STATUS_DIR>
```

claude engine の分岐には付与しない（claude には存在しないフラグのため）。

### 6.3 review モードの実測検証

review ペインは唯一 sandbox を残す経路のため、`codex sandbox -c sandbox_mode=workspace-write --log-denials` を worktree 内で実行して挙動を確認した。

| 検証項目 | 結果 | 評価 |
|---|---|---|
| `git status` / `git diff main...HEAD` | 成功（denial なし） | worktree の git 実体がリポジトリ側にあってもレビューに支障なし |
| `<STATUS_DIR>` への書き込み（`--add-dir` なしの状態） | `file-write-create` 拒否 | サンドボックスが確実に効いていることの確認。実際は `--add-dir <STATUS_DIR>` があるため findings の書き込みは成功する |
| `approval_policy='never'` | 拒否は即エラーとして model に返る | 承認待ちにならない＝停止しない |
| ネットワークアクセス | `workspace_write` 既定で無効 | レビューペインはネットワークを必要としない |
| `cmux` CLI | unix socket が `network-outbound` で拒否され失敗 | **現仕様でレビューペインは cmux を使わない**（findings をファイルに書くだけ）ため実害なし |

最後の項目について `--allow-unix-socket` の追加を検討したが、必要としない機能に権限を与えることになるため**採用しない**。将来レビューペインから cmux を呼ぶ必要が生じた場合に再検討する。

この検証手順は `test/test-codex-review-sandbox.sh` として自動化する（§7）。

### 6.4 追加検討したが採用しない項目

| 項目 | 判断 |
|---|---|
| `-c sandbox_workspace_write.network_access=true` | レビューペインはネットワーク不要。付けない |
| `--add-dir ~/.agents/skills/agmsg` | レビューペインは agmsg `send.sh` を呼ばない（findings はファイル受け渡し）。付けない |
| `--allow-unix-socket ~/.local/state/cmux` | §6.3 のとおり不要 |

### 6.5 非ループ挙動への影響 — 明示的な例外

「通常モードの挙動は不変」という要件 2 の後段に対し、**hook trust バイパスは意図的な例外**である。プロンプト内容は変わらないが、codex の**起動コマンドは全モードで変わる**。ここで曖昧にせず、例外として承認可能な形に整理しておく。

**なぜループ限定にしないのか**: hook trust の承認待ちは worktree ごとに新しいパスが生成される構造上、非ループの単発 dispatch でも必ず発生する。ループ限定にすると単発 dispatch の codex 経路が停止したままになり、要件 4 の「全 mode / 全 script を監査し漏れを直す」という指示に反する。

**リスクと軽減**:

| 観点 | 評価 |
|---|---|
| 何を迂回するか | このプラグインが生成した worktree 内の `.codex/hooks.json` に対する信頼確認のみ。グローバルの `~/.codex/hooks.json` も含まれるが、これはユーザー自身の設定である |
| フックの出所 | worktree 内のフックは agmsg の `delivery.sh` が生成したもので、コマンドは `~/.agents/skills/agmsg/scripts/session-start.sh` 等の固定パス。第三者が注入する経路は、そのリポジトリに push できる権限を既に持つ場合に限られる |
| 元々の防御力 | 承認プロンプトは毎回パスが変わるため常に「初見」として表示され、無人・半自動のディスパッチでは実質的にゲートとして機能していない（停止するだけ） |
| 影響範囲 | `launch-workspace.sh` が起動する codex セッションのみ。ユーザーが手で叩く `codex` には影響しない |

この判断は README / CLAUDE.md にも明記し、利用者が把握したうえで使えるようにする。

## 7. テストと検証

| 種別 | 内容 |
|---|---|
| 構文 | 変更した全シェルスクリプトに `bash -n`、`launch-workspace.sh` は `zsh -n` も実行 |
| 既存回帰 | `bash test/test-launch-workspace-codex.sh`、`bash test/test-launch-workspace-review-config.sh` |
| 静的検査（拡張） | `test-launch-workspace-codex.sh` に追加: ① codex 全 5 モードで `--dangerously-bypass-hook-trust` が付くこと ② **claude 全 5 モード**（plan / superpowers / execute / standby / review）で付かないこと ③ `--unattended` 付きの execute で生成 runner に `AskUserQuestion` の文字列が現れないこと ④ `--unattended` 無しでは現行文言が保たれること（後方互換スナップショット） |
| 動的検査（新規） | `test/test-codex-review-sandbox.sh` — 一時 worktree を作り、`codex sandbox` で ⓐ `--add-dir` 付きで `STATUS_DIR/review/` に書けること ⓑ `--add-dir` 無しでは拒否され、かつ**承認待ちにならず即座に失敗する**こと ⓒ `git diff` が成功することを検査する。`codex` 不在の環境では skip する |
| 新規ユニット | `test/test-issue-fetch.sh` — `gh` をスタブ化し、除外フィルタ / claim 失敗時の除外 / claim 全滅時の exit 3 / release / reconcile の状態遷移を検査 |
| ワークスペース全体 | ルートで `pnpm check` |
| E2E（手動チェックリスト） | `CLAUDE.md` のテスト方法節に追加: ① 実 hook を持つ worktree で codex ペインが trust prompt を出さずに起動すること ② ループが 2 バッチ以上回り、バッチ間で worktree / workspace が確実に片付くこと ③ ループ中に一度も AskUserQuestion が出ないこと ④ 非ループ dispatch の挙動が従来どおりであること |

hook trust の「実 TUI を起動して prompt が出ないこと」の検査は対話セッションを要するため自動化せず、E2E 手動チェックリストに置く。sandbox 側の検証は `codex sandbox` サブコマンドで非対話に実施できるため自動化する。

## 8. ドキュメント整合

`CLAUDE.md` の「ドキュメント整合の絶対ルール」に従い、以下 4 ファイルを同時に更新する:

1. `skills/cmux-team-dispatch-task/SKILL.md`
2. `skills/cmux-team-dispatch-task/references/guide-ja.md`
3. `README.md`
4. `CLAUDE.md`

同期対象:

- engine × MODE 起動表（`--dangerously-bypass-hook-trust` の追加）
- `launch-workspace.sh --unattended` / `prewarm-panes.sh --unattended` の仕様
- loop モードの存在と参照先（`references/loop-mode.md`）
- `loop.task_timeout_min` config キー
- hook trust バイパスが非ループにも及ぶこと（§6.5）
- `CLAUDE.md` メンテナンス手順への新項目追加（ループモードの整合検証）と、項目 20 / 39 の更新

バージョンは機能追加のため minor バンプ: `apps/cmux-team-dispatch-task/.claude-plugin/plugin.json` を 1.9.0 → 1.10.0 とし、ルート `.claude-plugin/marketplace.json` の対応 version も同期する。

## 9. リスクと軽減策

| リスク | 軽減策 |
|---|---|
| 親セッションのコンテキストがバッチを重ねるほど肥大する | バッチごとの報告は Template B のみに絞り、詳細は `loop-state.json` に書いて画面に出さない。最大バッチ数の上限も安全弁として機能する |
| ラベル付与に失敗した issue を無限に拾い続ける | claim 失敗時はそのバッチから除外し状態にも登録しない。候補があったのに claim 全滅なら exit 3 でループを中断する（§3.3） |
| 親が claim 後に落ちて issue が回収不能になる | `status=claimed` と `dispatched` を区別し、次回ループの Step L0-5 reconciliation で claimed を release する |
| 子セッションが応答せず永久に待つ | タスク単位タイムアウト（既定 90 分）で `timeout` 扱いにし、cleanup して次へ進む |
| 前バッチの残骸で次バッチの待機が終わらない | `monitor-dispatch.sh` を使わず当該バッチの slug 集合のみをポーリングする（§3.6）。加えて Step L0-4 の stale 検査 |
| `--dangerously-skip-permissions` により意図しない破壊的操作が走る | worktree 隔離は従来どおり維持される。ループは Step L0-1 の明示 opt-in を通らないと開始しない |
| hook trust バイパスによるセキュリティ挙動の変化 | §6.5 に例外として明記し、README / CLAUDE.md にも記載する |
| Wait and merge でコンフリクトが頻発しループが空回りする | conflict 時は worktree・branch を温存して `dispatch/failed` にし、次バッチへ進む。`dispatch/failed` により再取得されない |
| worktree / branch の削除に失敗して漏れる | `loop-state.json.leaked[]` に記録し、Step L3 のサマリで手動整理対象として提示する |

## 10. 既知の未修正事項（本設計のスコープ外）

`skills/cmux-team-dispatch-task/scripts/launch-session-splits.sh` の 247 行目で、262 行目まで定義されない `GRID_APPLIED` を `--argjson grid_layout "$GRID_APPLIED"` として参照している。`set -u` 配下のため split レイアウト経路が unbound variable で失敗するはずである。ループモードは workspace レイアウト固定であり本件の影響を受けないため、今回は修正せず報告のみとする。

## 11. 制約

- **同一リポジトリに対するループの並行実行は非サポート**。`gh issue list` と `gh issue edit --add-label` は compare-and-set ではないため、2 つのループが同時に list すると同じ issue を両方が claim し得る。GitHub API だけでは原子的な所有権を実現できないため、リポジトリ単位で単一オーケストレータを前提とし、`.dispatch/loop.lock` による**同一マシン上の**検出のみを行う。別マシンからの同時実行は検出できないため、運用上の約束とする
- ループは `workspace` レイアウト + `prewarm: true` を推奨構成とする。`prewarm: false` でも動作するが、Phase B は spawn fallback となるため `--unattended` の伝播が必須である（§4.3）
- ループ中の子セッションは plan モード固定であり、brainstorming による設計探索は行わない
