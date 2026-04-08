# cmux-team-dispatch-task 利用ガイド

## 概要

`cmux-team-dispatch-task` は、複数のタスクを並列で実行するオーケストレーションスキルです。
各タスクは独立した **git worktree + Claude Code セッション** で実行され、
親セッション（オーケストレータ）が全体を監視・統括します。

### 主な特徴

- `.claude/agents/` ディレクトリを動的にスキャンし、利用可能な Agent タイプを自動発見
- タスク内容に応じて最適な Agent（frontend-coding, backend-coding 等）を自動ルーティング
- superpowers プラグインまたは Claude の `/plan` モードで計画を立てた後に実行
- **2つのレイアウトモード**: workspace（別タブ）と split（ペイン分割）
- `.dispatch/` ディレクトリを介したステータス通信で進捗を追跡
- プロンプトはファイル経由で渡すため、シェルエスケープの問題なし

---

## 使い方

### 基本的な呼び出し

```
/cmux-team-dispatch-task ログインページUIを実装, 認証APIエンドポイントを追加
```

### 引数なし（対話モード）

```
/cmux-team-dispatch-task
```

タスクを聞かれるので、改行またはカンマ区切りで入力します。

### プランファイルを指定

```
/cmux-team-dispatch-task .claude/plans/feature-a.md, .claude/plans/feature-b.md
```

`.claude/plans/` 内の `.md` ファイルはプランファイルとして自動認識されます。

### 混合指定

```
/cmux-team-dispatch-task .claude/plans/notification.md, テストカバレッジを改善 [backend]
```

プランファイルとインラインタスクを混在させることもできます。
`[frontend]`, `[backend]` などのタグで Agent を明示的に指定できます。

---

## アーキテクチャ

### workspace モード（デフォルト）

各タスクが独立した cmux workspace（タブ）で実行されます。

```
┌──────────────────────────────────────────────┐
│           親セッション（オーケストレータ）           │
└──────┬──────────┬──────────┬─────────────────┘
       │          │          │
       ▼          ▼          ▼
┌──────────┐ ┌──────────┐ ┌──────────┐
│ workspace │ │ workspace │ │ workspace │
│  task-1   │ │  task-2   │ │  task-3   │
│           │ │           │ │           │
│ worktree: │ │ worktree: │ │ worktree: │
│ feat/     │ │ feat/     │ │ feat/     │
│ task-1    │ │ task-2    │ │ task-3    │
└──────────┘ └──────────┘ └──────────┘
```

### split モード

同一 workspace 内でペインを分割し、全タスクを一覧表示します。
全タスク起動後、自動的にグリッドレイアウトに整列されます。

```
┌──────────┬──────────┐
│  親      │ task-1   │
│(orchest.)│          │
├──────────┼──────────┤
│ task-2   │ task-3   │
│          │          │
└──────────┴──────────┘
  (4サーフェス → 2×2 グリッド、自動整列)
```

### 各レイヤーの役割

| レイヤー | 役割 |
|---------|------|
| **親セッション** | タスク収集、Agent 発見、ルーティング、セッション起動、監視、レポート生成 |
| **子セッション** | 個別タスクの計画・実行。独立した Claude Code インスタンスとして動作 |
| **git worktree** | ブランチ分離。各タスクは `feat/<task-slug>` ブランチで作業 |
| **.dispatch/** | ファイルベースのステータス通信。子 → 親への進捗報告 |

---

## レイアウトモード選択

| モード | 説明 | 推奨ケース |
|--------|------|-----------|
| **workspace** | タスクごとに独立した cmux workspace を作成 | 長時間タスク、5個以上のタスク、画面スペースが必要な作業 |
| **split** | 現在の workspace 内でペイン分割（自動グリッド整列） | 短時間タスク、2〜6個のタスク、全体を一望したい場合 |

### split モードの動作

1. 最初の子タスク: 親ペインの右側に分割 (`cmux new-split right`)
2. 以降の子タスク: 前の子ペインの下に分割 (`cmux new-split down`)
3. 全タスク起動後、`cmux-grid.sh` が自動実行され、親を含む全サーフェスをグリッドに整列
4. 各ペインは独立した git worktree + Claude Code セッション
5. `--no-grid` で従来のリニアレイアウトを維持可能

### split モードでの起動チェーン

```
親 surface:1 → split right → child-1 surface:5
                              → split down → child-2 surface:7
                                             → split down → child-3 surface:9
```

各起動スクリプトの JSON 出力から `surface_id` を取得し、次の `--split-from` に渡します。

全起動完了後、`cmux-grid.sh` が自動実行され、全サーフェスをグリッドに整列:

```
3 タスク + 親 = 4 サーフェス → 2×2 グリッド
5 タスク + 親 = 6 サーフェス → 3×2 グリッド
```

---

## Agent ルーティング

### 自動発見

スキル実行時に `.claude/agents/` ディレクトリをスキャンし、各 `.md` ファイルの
frontmatter（`name`, `description`）を読み取ります。

例:
```
.claude/agents/
├── frontend-coding.md   → React, UI, renderer 関連タスクに使用
└── backend-coding.md    → API, IPC, database 関連タスクに使用
```

### ルーティング優先順位

1. **明示的タグ**: `[frontend]`, `[backend]` 等がタスクに含まれていれば、そのまま使用
2. **キーワードマッチング**: タスクの説明文と Agent の `description` を照合
3. **汎用**: マッチしない場合は Agent ヒントなし（汎用モード）

### フロントエンドのシグナル

React, component, UI, CSS, page, renderer, Tailwind, styling, form, modal, dialog

### バックエンドのシグナル

API, endpoint, IPC, database, service, handler, main process, NeDB, authentication, migration

---

## 計画モード選択

各セッションの起動時に、以下のいずれかを選択します:

### superpowers モード

- `superpowers` プラグインがインストールされている場合に使用可能
- まず `superpowers:brainstorming` でコンテキスト探索・設計を行い、その後 `superpowers:writing-plans` に遷移して構造化されたプランを作成
- ブレインストーミング → 計画 → レビュー → 実行のフルワークフロー

### plan モード

- Claude Code の組み込み `/plan` モードを使用
- よりシンプルで高速な計画プロセス
- 小規模なタスクに適している

---

## プロンプトの受け渡し

子セッションへのプロンプトは **`.cmux-team-dispatch-task-prompt.md` ファイル経由** で渡されます。

### なぜファイル経由なのか

シェルエスケープの問題を完全に回避するためです。
JSON（`{`, `"`, `$` 等の特殊文字を含む）をシェルコマンドに直接埋め込むと、
`cmux send` を通過する際に文字が壊れます。

### 動作の流れ

1. 起動スクリプトがプロンプト全文を `<worktree>/.cmux-team-dispatch-task-prompt.md` に書き出す
2. cmux 経由で送信する Claude コマンドは静的な文字列のみ:
   ```
   claude '/plan Read and follow the task in .cmux-team-dispatch-task-prompt.md'
   ```
3. Claude がファイルを読み込み、タスクを実行

### プロンプトファイルの場所

各 worktree のルートディレクトリ: `<worktree>/.cmux-team-dispatch-task-prompt.md`
（worktree 削除時に自動的にクリーンアップされます）

---

## ランナースクリプト ラッパー

起動スクリプトは各 worktree に `.cmux-team-dispatch-task-run.sh` を生成します。
`claude ...` を直接ターミナルに送信する代わりに、`bash .cmux-team-dispatch-task-run.sh` を送信します。

### ランナースクリプトが保証すること

1. `status.json` を `"executing"` に更新（絶対パス使用）
2. `claude` コマンドをインタラクティブに実行
3. Claude 終了後（理由を問わず）、`status.json` を `"done"` または `"error"` に更新
4. `cmux wait-for --signal <slug>-done` で完了をシグナル
5. オプションで `cmux notify` で親 workspace に通知
6. `cmux send` で親ターミナルにテキスト通知を送信（親 Claude のユーザー入力として配信）

これにより、Claude がプロンプト内のステータス報告指示に従わなくても、
完了が必ず報告されます。

### シグナル名

各タスクのシグナル名は `<task-slug>-done` です。
起動スクリプト出力 JSON の `signal_name` フィールドで確認できます。

---

## ステータスプロトコル

### status.json

各子セッションが `.dispatch/<task-slug>/status.json` に書き出すステータスファイル:

```json
{
  "status": "launched",
  "workspace_id": "workspace:3",
  "surface_id": "surface:5",
  "message": "Claude session launched in plan mode (workspace layout)",
  "timestamp": "2026-04-07T16:00:00Z"
}
```

### ステータス一覧

| ステータス | 意味 | 書き込み元 |
|-----------|------|-----------|
| `launched` | セッション起動完了、Claude ロード中 | 起動スクリプト |
| `planning` | 計画フェーズ中 | 子セッション（任意） |
| `executing` | Claude 起動中 / 実装中 | ランナースクリプト / 子セッション |
| `done` | 全作業完了 | ランナースクリプト / 子セッション |
| `error` | エラー / 異常終了 | ランナースクリプト / 子セッション |

### result.md

タスク完了時に子セッションが `.dispatch/<task-slug>/result.md` に書き出す成果物サマリー:

```markdown
# タスク名

## Changes Made
- 変更されたファイルと内容の一覧

## Test Results
- テストの合否サマリー

## Commits
- <hash> <commit message>
```

### 親オーケストレータへの通知タイミング

1. **実行開始時**: 計画が完了し実装に移る直前に `status.json` を `executing` に更新
2. **完了時**: 全作業完了後に `status.json` を `done` に更新し、`result.md` を作成

---

## 監視と完了

### 進捗確認方法

親オーケストレータは以下の方法で進捗を確認:

1. **通知ベースの監視（推奨）**:
   各子セッションの Claude プロセスが終了すると、ランナースクリプトが
   `cmux send` で親ターミナルに直接テキストメッセージを送信します:
   ```
   [dispatch] task "<slug>" finished (status: done|error)
   ```
   このメッセージは親 Claude のユーザー入力として表示されるため、
   親セッションは自動的にタスク完了を検知して処理を進めます。

   **動作の流れ:**
   - タスク起動後、バックグラウンドモニターを起動してターンを終了
   - 子タスクが完了すると `[dispatch]` メッセージが届く
   - 親 Claude がメッセージを受信し、`status.json` を確認
   - 全タスク完了後、Step 8 の完了処理に進む

2. **バックグラウンドモニター（補助）**:
   `monitor-dispatch.sh` をバックグラウンドで起動し、ステータスファイルの
   変化を監視します。全タスク完了時に `[dispatch-monitor]` メッセージで通知:
   ```bash
   bash <this-skill-dir>/scripts/monitor-dispatch.sh \
     --parent-surface "$CMUX_SURFACE_ID" \
     --parent-workspace "$CMUX_WORKSPACE_ID" \
     --layout <split|workspace> \
     "$(pwd)/.dispatch"
   ```

3. **ステータスファイルのポーリング（手動確認）**:
   ```bash
   cat .dispatch/*/status.json
   ```

4. **画面の直接読み取り**:
   - workspace モード: `cmux read-screen --workspace <workspace-id> --scrollback`
   - split モード: `cmux read-screen --workspace <parent-ws> --surface <child-surface-id> --scrollback`

### 完了レポート

全タスク完了後、親が統合レポートを生成:
- 各タスクの `result.md` を収集
- 変更内容のサマリー
- 未マージブランチの一覧
- 次のアクション（マージ、PR 作成、クリーンアップ）の提案

### マージとクリーンアップ

全タスク完了後、ユーザーにマージするか確認します:

**マージする場合:**

1. 各 worktree の未コミット変更をコミット
2. 現在のブランチに順次マージ:
   ```bash
   for slug in <task-slugs>; do
     git merge "feat/$slug" --no-edit || echo "CONFLICT in feat/$slug"
   done
   ```
3. マージ競合があれば解決を案内
4. マージ完了後、全クリーンアップを実行:
   ```bash
   # worktree 削除
   for slug in <task-slugs>; do
     git worktree remove ".worktrees/$slug" --force 2>/dev/null
   done
   # ブランチ削除
   for slug in <task-slugs>; do
     git branch -D "feat/$slug" 2>/dev/null
   done
   # dispatch ディレクトリ削除
   rm -rf .dispatch/
   # worktrees ディレクトリ削除（空の場合）
   rmdir .worktrees 2>/dev/null
   ```
5. `git log --oneline` でマージ結果を表示

**マージしない場合:**

1. `.dispatch/` ディレクトリのみ削除:
   ```bash
   rm -rf .dispatch/
   ```
2. ユーザーに手動クリーンアップのコマンドを表示:
   ```
   Worktree は手動でクリーンアップしてください:

   # worktree 一覧
   git worktree list

   # 個別削除
   git worktree remove .worktrees/<task-slug>
   git branch -D feat/<task-slug>

   # 一括削除
   for slug in <slugs>; do
     git worktree remove ".worktrees/$slug" --force
     git branch -D "feat/$slug"
   done
   rmdir .worktrees 2>/dev/null
   ```

---

## トラブルシューティング

### セッションが応答しない場合

1. `cmux read-screen` で画面を確認
   - workspace モード: `cmux read-screen --workspace <id>`
   - split モード: `cmux read-screen --workspace <parent-ws> --surface <surface-id>`
2. Claude がプロンプト待ち（`❯`）で止まっている場合は、`cmux send` でコマンドを送信
3. セッションがクラッシュしている場合は workspace を閉じて再起動

### workspace の手動削除

```bash
# workspace 一覧を確認
cmux list-workspaces

# 特定の workspace を閉じる
cmux close-workspace --workspace <workspace-id>
```

### ステータスファイルが更新されない場合

ランナースクリプト（`.cmux-team-dispatch-task-run.sh`）がセッション終了時に自動的に
`status.json` を更新します。ステータスが `launched` のまま変わらない場合:

1. ランナースクリプトが正しく生成されたか確認: `ls <worktree>/.cmux-team-dispatch-task-run.sh`
2. `cmux read-screen` で直接画面を確認
3. Claude がまだ実行中（セッション未終了）の場合はシグナル未発火は正常
4. ランナースクリプト自体がエラーの場合は画面にエラーメッセージが表示されます

### シグナルがタイムアウトする場合

`cmux wait-for <slug>-done --timeout N` がタイムアウトする場合:

1. 子セッションがまだ実行中の可能性があります — `cmux read-screen` で確認
2. タイムアウト値を大きくして再試行
3. `status.json` を直接確認して現在のステータスを取得

### worktree 作成に失敗する場合

- ブランチ `feat/<task-slug>` が既に存在する場合、自動的にチェックアウトを試みます
- 既存の worktree と衝突する場合は `git worktree list` で確認し、不要なものを削除してください

### プロンプトファイルが見つからない場合

子セッションが `.cmux-team-dispatch-task-prompt.md` を見つけられない場合:
- worktree のルートディレクトリにいるか確認 (`pwd`)
- ファイルの存在を確認: `ls .cmux-team-dispatch-task-prompt.md`
- split モードの場合、`cd` が正しく実行されたか確認

---

## superpowers 統合（Execution Handoff 第3選択肢）

### 概要

`superpowers:writing-plans` でプランが完成すると、Execution Handoff として実行方法の選択肢が提示されます。
本スキルは **第3選択肢「Parallel (cmux split)」** として統合されます。

```
プラン完成後の実行選択肢:

1. Subagent-Driven (推奨)   → superpowers:subagent-driven-development
   逐次実行、タスクごとに subagent、2段階レビュー

2. Inline Execution          → superpowers:executing-plans
   同一セッションでバッチ実行、チェックポイントあり

3. Parallel (cmux split)     → cmux-team-dispatch-task split モード  ← NEW
   各タスクを cmux split ペインで並列実行、独立した worktree
```

### 使い分け基準

| 選択肢 | 向いているケース |
|--------|-----------------|
| Subagent-Driven | タスク間に依存あり、レビュー重視、コスト節約 |
| Inline Execution | シンプルなプラン、対話的実行、単一セッション希望 |
| **Parallel (cmux)** | **独立タスク3個以上、速度重視、全セッションを画面で一望** |

### フロー

```
┌─────────────────────────────────────────────────┐
│  superpowers:writing-plans でプラン完成           │
│  → Execution Handoff: "3. Parallel (cmux split)" │
└──────────────┬──────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────┐
│  プランファイルからタスクを抽出                     │
│  → tasks.json を構築                              │
│    [{"slug":"...", "prompt":"...", "agent":"..."}] │
└──────────────┬──────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────┐
│  launch-session-splits.sh を実行                  │
│  → cmux split ペインで各タスクを並列起動            │
└──────────────┬──────────────────────────────────┘
               │
               ▼
┌──────────┬──────────┐
│  親      │ task-1   │  superpowers モードで実行
│(監視)    │          │
├──────────┼──────────┤  自動グリッド整列
│ task-2   │ task-3   │  各ペインが独立した worktree
│          │          │  TDD 等のスキルが自然に発動
└──────────┴──────────┘
               │
               ▼
┌─────────────────────────────────────────────────┐
│  親セッションが監視（Step 7）→ 完了処理（Step 8）  │
│  → シグナル待機 → 結果収集 → マージ/クリーンアップ  │
└─────────────────────────────────────────────────┘
```

### 便利スクリプト: launch-session-splits.sh

プランのタスクを一括で split ペインに起動するラッパースクリプトです。

```bash
# タスク JSON をファイルで渡す場合
bash .claude/skills/cmux-team-dispatch-task/scripts/launch-session-splits.sh \
  --mode superpowers \
  --tasks-file /tmp/plan-tasks.json

# タスク JSON をインラインで渡す場合
bash .claude/skills/cmux-team-dispatch-task/scripts/launch-session-splits.sh \
  --mode superpowers \
  --tasks '[{"slug":"login-ui","prompt":"Implement login page...","agent":"frontend-coding"},{"slug":"auth-api","prompt":"Add auth endpoint...","agent":"backend-coding"}]'

# 全タスクの完了を待機する場合
bash .claude/skills/cmux-team-dispatch-task/scripts/launch-session-splits.sh \
  --mode superpowers \
  --tasks-file /tmp/plan-tasks.json \
  --wait --wait-timeout 3600

# グリッドレイアウトを無効にする場合（リニアレイアウトを維持）
bash .claude/skills/cmux-team-dispatch-task/scripts/launch-session-splits.sh \
  --mode superpowers \
  --tasks-file /tmp/plan-tasks.json \
  --no-grid
```

#### タスク JSON フォーマット

```json
[
  {
    "slug": "login-page-ui",
    "prompt": "Implement Task 1 from the plan: Login page UI component...",
    "agent": "frontend-coding"
  },
  {
    "slug": "auth-api-endpoint",
    "prompt": "Implement Task 2 from the plan: Authentication API...",
    "agent": "backend-coding"
  },
  {
    "slug": "integration-tests",
    "prompt": "Implement Task 3 from the plan: E2E test suite..."
  }
]
```

| フィールド | 必須 | 説明 |
|-----------|------|------|
| `slug` | Yes | タスクの短い識別子（小文字、ハイフン、最大30文字） |
| `prompt` | Yes | 子セッションに渡すプロンプト全文 |
| `agent` | No | `.claude/agents/` のエージェント名。省略で汎用モード |

#### 出力 JSON

```json
{
  "parent_workspace": "workspace:1",
  "parent_surface": "surface:1",
  "task_count": 3,
  "tasks": [
    {"slug": "login-page-ui", "surface_id": "surface:5", "signal_name": "login-page-ui-done", ...},
    {"slug": "auth-api-endpoint", "surface_id": "surface:7", "signal_name": "auth-api-endpoint-done", ...},
    {"slug": "integration-tests", "surface_id": "surface:9", "signal_name": "integration-tests-done", ...}
  ]
}
```

### プランファイルからタスク JSON を構築する

`superpowers:writing-plans` のプランファイルは `### Task N: <name>` の形式です。
各 Task ヘッダーを1つのタスクとして抽出し、tasks.json を構築します:

1. `### Task N: <name>` → slug を生成（小文字、スペースをハイフンに、最大30文字）
2. ヘッダーから次のヘッダーまでの全テキスト → prompt に設定
3. キーワードマッチングで agent を決定（Step 3 と同じロジック）
4. ステータスプロトコル指示をプロンプトに追記

### 通常の cmux-team-dispatch-task との違い

| 項目 | 通常（Step 1-8） | superpowers 統合 |
|------|----------------|-----------------|
| タスクの入力元 | ユーザー入力または CLI 引数 | プランファイルから抽出 |
| 計画モード | ユーザーが選択（plan/superpowers） | 常に `superpowers`（brainstorming 完了済み） |
| レイアウトモード | ユーザーが選択（workspace/split） | 常に `split` |
| 使用ステップ | 全て（1-8） | Step 5-8 のみ（1-4 は事前決定） |
| Agent ルーティング | キーワードマッチング | 同じロジック |

---

## 制約事項

- **cmux 必須**: `/Applications/cmux.app/` にインストールされている必要があります
- **同時セッション数**: システムリソースに依存しますが、通常 3〜5 セッションが推奨
- **split モード制限**: 自動グリッド整列により均等なペインサイズを実現。2〜6 タスクが推奨。7 以上はペインが小さくなるため workspace モードを使用してください。`--no-grid` でリニアレイアウトに戻せます
- **ファイル競合**: 2つのタスクが同じファイルを変更してはいけません。競合の可能性がある場合は順次実行にしてください
- **完了シグナルは信頼性あり**: ランナースクリプトが `status.json` の更新と `cmux wait-for --signal <slug>-done` の発火を保証します。プロンプト内のステータス指示は実行中の中間更新用（ベストエフォート）です
- **ランナースクリプト**: `.cmux-team-dispatch-task-run.sh` は各 worktree に生成されます。worktree 削除時に自動的にクリーンアップされます
