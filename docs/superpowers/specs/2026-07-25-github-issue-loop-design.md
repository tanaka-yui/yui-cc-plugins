# cmux-team-dispatch-task GitHub issue 自動ループ設計

- 対象プラグイン: `apps/cmux-team-dispatch-task`
- 作成日: 2026-07-25
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

**非スコープ**（意図的に含めない）:

- スロット方式（1 件完了ごとに次を投入）の並列制御 — バッチ方式を採用する
- ループ設定の永続化（config.json への保存）— 毎ループ開始時に質問する
- `claude-teams` / `split` レイアウトでのループ — workspace レイアウト固定
- レビューペインへの `--allow-unix-socket` 付与 — 現仕様でレビューペインは cmux CLI を使わない

## 2. 設計判断のサマリ

| 論点 | 決定 | 理由 |
|------|------|------|
| 駆動主体 | 親 Claude セッションが回す | 既存アーキテクチャをそのまま利用でき、新規スクリプトが最小で済む |
| 設計フェーズの無人化 | plan モード固定 + `--dangerously-skip-permissions` | superpowers の brainstorming は承認ゲートを持ち無人実行と本質的に相容れない。設計品質は Phase A-R レビューで担保する |
| 二重防止 | GitHub ラベル + ローカル状態ファイルの併用 | ラベルは可視性と機械間共有、ローカル状態はラベル付与失敗時の保険 |
| 並列制御 | バッチ方式（N 件同時 → 全完了 → 次バッチ） | 既存の「全タスク完了検知 → 集計」フローをバッチ単位で再利用できる |
| バッチ間 cleanup | 次バッチ開始前に worktree と cmux workspace を必ず片付ける | ペイン／worktree の無限増殖を防ぐ |
| integration strategy | ループ開始前に 1 回選択 | ローカルブランチを削除してよいかがこれで決まる |
| error 時 | スキップして継続 | 大量 issue を回す目的に沿う。`dispatch/failed` ラベルで再取得されない |
| 上限 | 最大バッチ数を設定質問に含める | フィルタ条件の誤りによる暴走を防ぐ |
| ドキュメント配置 | `references/loop-mode.md` に分離 | SKILL.md は既に 130KB / 2286 行。非ループ利用者の読み込み量を増やさない |

## 3. アーキテクチャ

### 3.1 全体フロー

```
Step L0  プリフライト検査（設定質問より前に実行し、失敗ならループを開始しない）
           - ~/.claude/cmux-team-dispatch-task/runners.json が存在するか
           - gh auth status が通り、リポジトリで issue が有効か
           - dispatch/in-progress / dispatch/failed ラベルを冪等に作成できるか
Step L1  ループ設定の一括質問（AskUserQuestion 最大 3 コール）
         ── ここから先、ループが終わるまで一切質問しない ──
Step L2  バッチループ（batch = 1, 2, ...）:
  L2-1  issue-fetch.sh --limit <concurrency>
          → 対象 issue を取得し claim（dispatch/in-progress 付与）してタスク JSON を出力
          → 0 件なら Step L3 へ
  L2-2  既存 Step 1b / Step 2 の手順でタスクプロンプトを構築
          （plan モードのテンプレート + {{UNATTENDED_BLOCK}} を焼き込む）
  L2-3  workspace レイアウト + pre-warm で一斉起動（既存 Step 2 をそのまま利用）
  L2-4  バッチ内の全タスクが terminal state (done/error) になるまで待機
          （既存 Step 3 の通知受信 / status.json ポーリング。タスク単位のタイムアウトあり）
  L2-5  Template B で結果報告 → loop-cleanup.sh でバッチ cleanup
  L2-6  batch++ → 最大バッチ数チェック → L2-1 へ
Step L3  ループ全体サマリ（Template C を batch 列付きに拡張）
```

### 3.2 コンポーネント一覧

**新規ファイル（3 点）**

| ファイル | 責務 | 依存 |
|---|---|---|
| `skills/cmux-team-dispatch-task/references/loop-mode.md` | ループ手順の SoT。L1〜L3、一括設定質問の文面、フォールバック表 | なし（ドキュメント） |
| `skills/cmux-team-dispatch-task/scripts/issue-fetch.sh` | 次バッチの issue 取得 → 除外フィルタ → claim → タスク JSON 出力 → `loop-state.json` 更新 | `gh`, `jq`, `git` |
| `skills/cmux-team-dispatch-task/scripts/loop-cleanup.sh` | バッチ終了処理（pane close / worktree 削除 / branch 処理 / issue ラベル更新 / 状態記録） | `cmux`, `gh`, `jq`, `git` |

**変更ファイル**

| ファイル | 変更内容 |
|---|---|
| `skills/cmux-team-dispatch-task/SKILL.md` | ループ発動のディスパッチポイント（約 10 行）＋ Step 1c–1g / cleanup 節への「loop モードでは `references/loop-mode.md` の一括設定で解決済み」注記。手順本体は重複させない |
| `skills/cmux-team-dispatch-task/scripts/launch-workspace.sh` | codex 全経路に `--dangerously-bypass-hook-trust` を追加（要件 4） |
| `skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh` | `--unattended` フラグを追加。指定時、設計ペイン（claude opus standby）に `--skip-permissions` を付与する |
| `skills/cmux-team-dispatch-task/references/guide-ja.md` | ループモード節の追加、engine × MODE 起動表の更新 |
| `README.md` | ループモードの利用者向け説明、codex 起動フラグ表の更新 |
| `CLAUDE.md` | メンテナンス手順に項目追加、項目 20 / 39 の更新 |
| `.claude-plugin/plugin.json` / ルート `.claude-plugin/marketplace.json` | version 1.9.0 → 1.10.0 |
| `test/test-launch-workspace-codex.sh` | hook trust バイパスの静的検査を追加 |
| `test/test-issue-fetch.sh`（新規） | 除外フィルタ jq ロジックの検査 |

### 3.3 新規スクリプトの CLI 契約

**`issue-fetch.sh`**

```
issue-fetch.sh --state-file <path> --limit <N>
               [--labels <a,b>] [--assignee <@me|none|"">] [--state <open|all>]
               [--batch <N>] [--dry-run]

--state-file  .dispatch/loop-state.json のパス（必須。無ければ初期化して作る）
--limit       claim してタスク化する上限件数（必須）
--labels      カンマ区切りのラベルフィルタ（省略時はラベル指定なし）
--assignee    @me / none（未アサインのみ）/ 省略（指定なし）
--state       既定 open
--batch       loop-state.json に記録するバッチ番号（既定: 既存バッチ数 + 1）
--dry-run     claim も loop-state.json 更新も行わず、対象候補だけを出力する

stdout: タスク JSON 配列（3.4 のスキーマ）。対象 0 件なら []
exit  : 0 = 正常（0 件を含む） / 1 = gh・jq 実行エラー等の致命的失敗
stderr: [fetch] / [claim] / [warn] のログ
```

**`loop-cleanup.sh`**

```
loop-cleanup.sh --state-file <path> --batch <N> --integration <pr|merge>
                [--dispatch-dir <path>] [--repo-root <path>]
                [--agmsg-team <team>] [--keep-failed]

--state-file    .dispatch/loop-state.json のパス（必須）
--batch         cleanup 対象のバッチ番号（必須。loop-state.json の batches から slug 群を引く）
--integration   pr = branch 削除 / merge = 親へ merge を試みてから削除（必須）
--dispatch-dir  既定 <repo-root>/.dispatch
--repo-root     既定 git rev-parse --show-toplevel
--agmsg-team    指定時、対象 slug の agmsg agent を leave.sh で除籍する
--keep-failed   error / timeout のタスクの .dispatch/<slug> と worktree を残す（既定 on）

stdout: バッチ結果サマリ JSON {batch, done, error, timeout, merged, conflicted}
exit  : 0 = 正常（個別の失敗は警告扱いでループを止めない）
```

いずれも「個別 issue / タスクの失敗はループを止めない」を原則とし、致命的な前提崩れ（`gh` 不在・`loop-state.json` 破損）のときだけ非 0 で終了する。

### 3.4 データ構造

**`.dispatch/loop-state.json`**

```json
{
  "started_at": "2026-07-25T10:00:00Z",
  "filter": {
    "labels": ["enhancement"],
    "assignee": "@me",
    "state": "open"
  },
  "config": {
    "concurrency": 3,
    "max_batches": 5,
    "integration": "pr",
    "design_runner": "claude",
    "exec_choice": "sonnet",
    "review_mode": "on",
    "task_timeout_min": 90
  },
  "batches": [
    { "n": 1, "issues": [12, 13], "started_at": "...", "finished_at": "..." }
  ],
  "issues": {
    "12": { "slug": "issue-12-fix-login", "status": "done", "pr_url": "https://…", "batch": 1 },
    "13": { "slug": "issue-13-add-cache", "status": "error", "message": "…", "batch": 1 }
  }
}
```

`issues` のキーは issue 番号（文字列）。`status` は `dispatched` / `done` / `error` / `timeout` のいずれか。

このファイルは **バッチ間 cleanup では削除しない**。ループ終了後もユーザーが結果を辿れるよう `.dispatch/loop-state.json` に残す（Step L3 で削除手順を表示するだけで、自動削除はしない）。

**タスク JSON（`issue-fetch.sh` の stdout）**

```json
[
  { "number": 12, "slug": "issue-12-fix-login", "title": "Fix login redirect",
    "url": "https://github.com/owner/repo/issues/12", "body": "…" }
]
```

`slug` は `issue-<number>-<title を lowercase・ハイフン化したもの>` を 30 文字で切り詰めた値。`[A-Za-z0-9._-]` のみを残す（`launch-workspace.sh` の workspace 名バリデーションに合わせる）。

### 3.5 issue 取得と二重ディスパッチ防止

**取得クエリ**

```bash
gh issue list --state "$STATE" [--label "$LABEL"] [--assignee "$ASSIGNEE"] \
  --limit $((LIMIT * 4)) --json number,title,body,url,labels
```

取得件数に余裕（`LIMIT * 4`）を持たせ、除外後に `LIMIT` 件を確保する。

**除外条件（jq で適用）**

1. `dispatch/in-progress` または `dispatch/failed` ラベルを持つ issue
2. `loop-state.json` の `issues` に既に登録されている番号

**claim（着手マーク）**

```bash
gh issue edit "$n" --add-label dispatch/in-progress
```

- `dispatch/in-progress` / `dispatch/failed` ラベルはプリフライト（Step L0）で `gh label create ... || true` により冪等に作成する
- **claim に失敗した issue はそのバッチから除外する**（ラベルが付かないまま起動すると次バッチで再取得され、無限に同じ issue を拾い続けるため）
- claim 成功と同時に `loop-state.json.issues["<n>"] = {slug, status: "dispatched", batch: N}` を書く

**完了時のラベル更新（`loop-cleanup.sh`）**

| タスク結果 | ラベル操作 | 補足 |
|---|---|---|
| `done` | `dispatch/in-progress` を除去 | PR 本文の `Closes #<n>` により issue は PR マージ時に閉じる |
| `error` / `timeout` | `dispatch/in-progress` を除去し `dispatch/failed` を付与 + 失敗コメント投稿 | 次バッチ以降で再取得されない |

ラベル操作の失敗は警告のみでループを止めない（`loop-state.json` 側が保険として機能する）。

### 3.6 バッチ待機とタイムアウト

- `message_type: agmsg`（`monitor-dispatch.sh` を使わないモード）: 子から `cmux send` + `send-key return` で届く `[dispatch] task "<slug>" finished` を受けてカウントし、併せて `.dispatch/<slug>/status.json` を確認する
- `message_type: send-message`: バッチ起動ごとに `monitor-dispatch.sh` を起動し、「全 N タスク完了」通知を受けたら停止する。バッチ間 cleanup で `.dispatch/<slug>/` が消えるため `--resume` は不要

**タスク単位のタイムアウト**: 無人実行では応答のない子を永久に待つわけにいかないため、タスクあたりの上限時間を設ける。

- 既定値 90 分。`<project>/.dispatch/config.json` → `~/.claude/cmux-team-dispatch-task/config.json` の順で `loop.task_timeout_min` を解決する（設定質問には含めない）
- 超過したタスクは `timeout` として扱い、`status.json` を `error` に書き換えたうえで cleanup と `dispatch/failed` 付与を行う

### 3.7 バッチ間 cleanup（`loop-cleanup.sh`）

対象バッチの各 slug について、この順序で実行する:

1. `.dispatch/<slug>/prewarm.json` の全 `surface_id` を `cmux close-surface`
2. `.dispatch/<slug>/status.json` の `workspace_id` を `cmux close-workspace`
3. `git worktree remove ".worktrees/<slug>" --force`
4. ブランチ処理:
   - integration = `pr`: リモートに push 済みなので `git branch -D "feat/<slug>"`
   - integration = `merge`: 親で `git merge "feat/<slug>" --no-edit` を試み、成功したら `git branch -D`。**コンフリクト時は `git merge --abort` してブランチと worktree を温存し、その issue を `dispatch/failed` にしてループは継続する**
5. `loop-state.json.issues["<n>"]` に最終結果（status / pr_url / message）を記録
6. `rm -rf ".dispatch/<slug>"`（`error` / `timeout` のタスクは調査用に残す）
7. `agmsg` モードのときは `leave.sh <team> <slug>` / `-sonnet` / `-codex` / `-review` / `-opus` を実行して team から除籍する

close → worktree → branch の順序は既存 cleanup と同じ理由（ペインを先に閉じないと worktree が掴まれたままになる）。

## 4. 要件 2 — AskUserQuestion 全廃

### 4.1 全 18 箇所の解決マッピング

| # | 箇所 | 現行 | loop モードでの解決 |
|---|---|---|---|
| 1 | Step 1a タスク収集 | 質問 | `issue-fetch.sh` の出力に置換 |
| 2 | Step 1c brainstorming 選択 | 質問 | plan モード固定（質問なし） |
| 3 | Step 1d layout | 質問 | workspace 固定（pre-warm / standby が workspace 前提。設定質問にも含めない） |
| 4 | Step 1e integration strategy | 質問 | 設定質問コール② で 1 回 |
| 5 | Step 1f runner switch / per-task runner | 質問 | 設定質問コール②（design runner）で 1 回。全タスク同一 runner |
| 6 | Step 1f first-run setup（runners.json 対話生成） | 対話ループ | **プリフライト（Step L0、設定質問より前）で検査**し、`runners.json` 不在ならループを開始せずエラー終了。ループ中には原理的に発生しない |
| 7 | Step 1f cross-engine reviewer 選択 | 質問 | claude engine runner が 1 件なら自動採用、2 件以上なら設定質問コール③ で 1 回 |
| 8 | Step 1g message_type | 初回のみ質問 | config 未設定時のみ設定質問コール③ に含める（1 回・従来どおり永続化） |
| 9 | Step 1g review_mode | 毎 dispatch 質問 | 設定質問コール② で 1 回。ループ中は固定 |
| 10 | 完了時 Wait-and-merge の Option A/B | 質問 | integration = `merge` なら常に merge（Option A）。コンフリクトは自動スキップ |
| 11 | 完了時 cleanup 3 問 | 質問 | バッチ間 cleanup で固定（pane close = yes / worktree remove = yes / branch delete = integration に従う） |
| 12 | Phase A-R 3 往復 needs_work | 子が質問 | 「このまま進む」を自動選択。未解決指摘を文書末尾に注記 |
| 13 | Phase A-R stalled | 子が質問 | 同一ラウンドの再依頼 1 回（従来どおり）→ なお stalled なら「レビュー省略して Phase B へ」を自動選択 |
| 14 | Phase B 実行モデル選択 | 子が質問 | 設定質問コール② の exec runner を `{{EXEC_DEFAULT_HINT}}` に焼き込む（**既存の default-direct 経路をそのまま利用**） |
| 15 | Phase B exec_choice 永続化確認 | 子が質問 | 14 により `exec_choice` が確定するため発生しない |
| 16 | Phase B-R 3 往復 needs_work | 子が質問 | 「このまま PR 作成」を自動選択。未解決指摘を PR 本文に注記 |
| 17 | Phase B-R stalled | 子が質問 | 「レビュー省略して PR 作成」を自動選択 |
| 18 | brainstorming / ExitPlanMode の暗黙の承認ゲート | 承認待ちで停止 | plan モード固定 + `--dangerously-skip-permissions` により承認プロンプト自体が出ない（4.3 参照） |

### 4.2 `{{UNATTENDED_BLOCK}}` プレースホルダ

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
=== END UNATTENDED MODE ===
```

- 挿入位置: `{{REVIEW_BLOCK}}` の直前
- **非ループ時は空文字列**を代入する。したがって通常モードのプロンプトは 1 バイトも変わらない
- Phase B の実行担当ペイン（sonnet / codex standby）へ送る `REQUEST_TEXT` にも同じ趣旨の 1 文を追記する（Phase B-R のフォールバックは実装者側が実行するため）

### 4.3 暗黙の承認ゲートの解消

現行の既定経路（`message_type: agmsg` + `prewarm: true`）では、設計ペインは `launch-workspace.sh --mode plan` ではなく **`--mode standby`** で起動され、`--skip-permissions` が付いていない（`prewarm-panes.sh` の opus standby 起動）。タスクは後から typed prompt で届く。

そのため「plan モード固定 + skip-permissions」は次の 2 点で実現する:

1. `prewarm-panes.sh` に `--unattended` フラグを追加し、指定時は設計ペイン（claude opus standby）の起動に `--skip-permissions` を渡す。sonnet standby には既に付いており、codex 系は bypass フラグで解決済み
2. 設計ペインへ送る `TASK_TEXT` の Mode を常に `plan` にする。プロンプトファイルには plan モード用テンプレート（`{{UNATTENDED_BLOCK}}` 込み）を書き込む

pre-warm を使わない経路（`prewarm: false`）では `launch-workspace.sh --mode plan` が使われ、これは既に `--dangerously-skip-permissions` を付与している（`launch-workspace.sh` の claude plan 分岐）ため追加変更は不要。

## 5. 要件 3 — ループ開始前の一括設定質問

`AskUserQuestion` は 1 コールあたり最大 4 問という制約があるため、3 コールに分割する。

### コール① 対象 issue

| # | 質問 | 選択肢 |
|---|---|---|
| 1 | 対象にする issue のラベル | `gh label list` から動的生成（上位 3 件）+ 「フィルタなし」+ Other（自由入力で複数ラベルをカンマ区切り指定可） |
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
| 5 | `launch-workspace.sh` codex × review | `--sandbox workspace-write` + `-c approval_policy='never'` + `--add-dir <STATUS_DIR>` | 対応済み（6.3 で実測検証） |
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

### 6.4 追加検討したが採用しない項目

| 項目 | 判断 |
|---|---|
| `-c sandbox_workspace_write.network_access=true` | レビューペインはネットワーク不要。付けない |
| `--add-dir ~/.agents/skills/agmsg` | レビューペインは agmsg `send.sh` を呼ばない（findings はファイル受け渡し）。付けない |
| `--allow-unix-socket ~/.local/state/cmux` | 6.3 のとおり不要 |

## 7. テストと検証

| 種別 | 内容 |
|---|---|
| 構文 | 変更した全シェルスクリプトに `bash -n`（`.sh` は bash shebang）、`launch-workspace.sh` は `zsh -n` も実行 |
| 既存回帰 | `bash test/test-launch-workspace-codex.sh`、`bash test/test-launch-workspace-review-config.sh` |
| 新規静的検査 | `test-launch-workspace-codex.sh` に hook trust の assert を追加（codex 5 モードで付与されること、claude 3 モードで付与されないこと） |
| 新規ユニット | `test/test-issue-fetch.sh` — 固定の issue JSON と `loop-state.json` を与え、除外フィルタが期待どおり動くことを検査（`gh` はスタブ化） |
| ワークスペース全体 | ルートで `pnpm check` |
| E2E（手動） | CLAUDE.md のテスト方法節に「ループモード」の確認項目を追加 |

## 8. ドキュメント整合

`CLAUDE.md` の「ドキュメント整合の絶対ルール」に従い、以下 4 ファイルを同時に更新する:

1. `skills/cmux-team-dispatch-task/SKILL.md`
2. `skills/cmux-team-dispatch-task/references/guide-ja.md`
3. `README.md`
4. `CLAUDE.md`

同期対象:

- engine × MODE 起動表（`--dangerously-bypass-hook-trust` の追加）
- loop モードの存在と参照先（`references/loop-mode.md`）
- `prewarm-panes.sh --unattended` フラグ
- `loop.task_timeout_min` config キー
- `CLAUDE.md` メンテナンス手順への新項目追加（ループモードの整合検証）と、項目 20 / 39 の更新

バージョンは機能追加のため minor バンプ: `apps/cmux-team-dispatch-task/.claude-plugin/plugin.json` を 1.9.0 → 1.10.0 とし、ルート `.claude-plugin/marketplace.json` の対応 version も同期する。

## 9. リスクと軽減策

| リスク | 軽減策 |
|---|---|
| 親セッションのコンテキストがバッチを重ねるほど肥大する | バッチごとの報告は Template B のみに絞り、詳細は `loop-state.json` に書いて画面に出さない。最大バッチ数の上限も安全弁として機能する |
| ラベル付与に失敗した issue を無限に拾い続ける | claim 失敗時はそのバッチから除外し、`loop-state.json` にも登録しない → 次バッチで再取得されるが、ラベル API が復旧しない限り毎回除外されるだけで新規起動はしない |
| 子セッションが応答せず永久に待つ | タスク単位タイムアウト（既定 90 分）で `timeout` 扱いにし、cleanup して次へ進む |
| `--dangerously-skip-permissions` により意図しない破壊的操作が走る | worktree 隔離は従来どおり維持される。ループはユーザーが明示的に開始するものであり、開始前の最終確認質問で設定内容を提示する |
| Wait and merge でコンフリクトが頻発しループが空回りする | コンフリクト時はブランチと worktree を温存して `dispatch/failed` にし、次バッチへ進む。ユーザーは後からまとめて解決できる |

## 10. 既知の未修正事項（本設計のスコープ外）

`skills/cmux-team-dispatch-task/scripts/launch-session-splits.sh` の 247 行目で、262 行目まで定義されない `GRID_APPLIED` を `--argjson grid_layout "$GRID_APPLIED"` として参照している。`set -u` 配下のため split レイアウト経路が unbound variable で失敗するはずである。ループモードは workspace レイアウト固定であり本件の影響を受けないため、今回は修正せず報告のみとする。
