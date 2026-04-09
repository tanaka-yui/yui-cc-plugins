# cmux-team-dispatch-task 利用ガイド

## 概要

`cmux-team-dispatch-task` は、複数のタスクを並列で実行するオーケストレーションスキルです。
各タスクは独立した **git worktree + Claude Code セッション** で実行され、
親セッション（オーケストレータ）が全体を監視・統括します。

**親側ではプランニング/ブレストを行わず即座にディスパッチ** — 各子セッションが
並行して brainstorming/planning を実行します。

### 主な特徴

- 即座にディスパッチ — 親側のプランニングオーバーヘッドなし
- `.claude/agents/` ディレクトリを動的にスキャンし、利用可能な Agent タイプを自動発見
- 利用可能な Agent 一覧を子セッションに伝達し、各子セッションが最適な Agent を選択
- タスクごとに brainstorming スキルの使用を選択可能
- **3つのレイアウトモード**: split（ペイン分割）、workspace（別タブ）、claude-teams（Agent Teams）
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
/cmux-team-dispatch-task .claude/plans/notification.md, テストカバレッジを改善
```

プランファイルとインラインタスクを混在させることもできます。

### レイアウトモードの指定

```
/cmux-team-dispatch-task タスクA, タスクB --layout workspace
/cmux-team-dispatch-task タスクA, タスクB --layout claude-teams
/cmux-team-dispatch-task タスクA, タスクB --no-grid
```

デフォルトは `split` モードです。

---

## 3ステップフロー

### Step 1: Parse and Prepare

タスク収集、Agent ルーティング、レイアウト決定を1ステップで実行。
**ルーティング確認なし、プランニングモード選択なし、レイアウト質問なし。**

1. タスクを `$ARGUMENTS` から解析（なければ1回だけ質問）
2. `.claude/agents/` をスキャンして利用可能な Agent 一覧を収集
3. レイアウトをデフォルト split に設定（引数で override 可能）
4. **brainstorming タスク選択**: 唯一のユーザーインタラクション
   - 各タスクについて brainstorming スキルを使うか選択
   - 選択されたタスク → superpowers モード + MANDATORY EXECUTION SEQUENCE
   - 非選択タスク → plan モード
5. 情報表示のみで即座にディスパッチ:
   ```
   Dispatching 3 tasks (split mode):
     1. login-page-ui      [brainstorming]
     2. auth-api-endpoint   [plan]
     3. test-coverage       [brainstorming]
   Available agents: backend-coding, frontend-coding
   Launching...
   ```

### Step 2: Launch Sessions

レイアウトモードに応じてセッションを起動。

### Step 3: Monitor and Complete

通知ベースの監視 → 結果収集 → レポート生成 → マージ/クリーンアップ。

---

## アーキテクチャ

### 3つのレイアウトモード

| モード | 説明 | 推奨ケース |
|--------|------|-----------|
| **split** (デフォルト) | 現在の workspace 内でペイン分割（自動グリッド整列） | 2〜6個のタスク、全体を一望したい場合 |
| **workspace** | タスクごとに独立した cmux workspace を作成 | 長時間タスク、7個以上のタスク |
| **claude-teams** | `cmux claude-teams` で Agent Teams を使用 | ネイティブ通知/サイドバー連携 |

### split モード

各タスクが独立した split ペインで実行されます。

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

### workspace モード

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
│ worktree  │ │ worktree  │ │ worktree  │
└──────────┘ └──────────┘ └──────────┘
```

### claude-teams モード

`cmux claude-teams` を使い、1つの orchestrator が Agent Teams で teammate を生成。
各 teammate が cmux のネイティブ分割ペインとして表示されます。

```
┌──────────┬──────────┐
│ Orchest. │ Team-1   │
│          │          │
├──────────┼──────────┤
│ Team-2   │ Team-3   │
│          │          │
└──────────┴──────────┘
  (native Agent Teams, サイドバー通知あり)
```

**特徴:**
- `cmux claude-teams` が tmux shim を作成し、`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` を設定
- Claude の Agent tool + TeamCreate で teammate を生成
- teammate は `isolation: "worktree"` で自動的に git worktree を取得
- 各ペインはサイドバーにメタデータと通知が表示される

### 各レイヤーの役割

| レイヤー | 役割 |
|---------|------|
| **親セッション** | タスク収集、Agent 発見、brainstorming 選択、セッション起動、監視、レポート生成 |
| **子セッション/teammate** | Agent 選択、個別タスクの brainstorming・計画・実行。独立した Claude Code インスタンスとして動作 |
| **git worktree** | ブランチ分離。各タスクは `feat/<task-slug>` ブランチで作業 |
| **.dispatch/** | ファイルベースのステータス通信。子 → 親への進捗報告 |

---

## 利用可能エージェントの発見

### 自動発見

スキル実行時に `.claude/agents/` ディレクトリをスキャンし、各 `.md` ファイルの
frontmatter（`name`, `description`）を読み取ります。

### 子セッションへの委譲

親セッションは発見したエージェント一覧をプロンプトに埋め込み、各子セッションに渡します。
**親はエージェントの割り当てを行いません** — 各子セッションが自身のタスク内容に基づいて
最適なエージェントを選択し、そのガイドラインに従います。

プロンプトに埋め込まれる Available Agents ブロック:
```
=== AVAILABLE AGENTS ===
The following agent definitions are available in .claude/agents/.
Read the one that best matches your task and follow its guidelines.
If none are relevant, proceed without an agent.

- backend-coding (.claude/agents/backend-coding.md): ...
- frontend-coding (.claude/agents/frontend-coding.md): ...
=== END AVAILABLE AGENTS ===
```

`.claude/agents/` が空またはディレクトリが存在しない場合、このブロックは省略されます。

---

## brainstorming タスク選択

各タスクについて brainstorming スキルを使うかどうかを選択します。

### 選択結果とモード

| 選択 | 起動モード | 動作 |
|------|-----------|------|
| brainstorming あり | `--mode superpowers` | `superpowers:brainstorming` → `superpowers:writing-plans` → 実行 |
| brainstorming なし | `--mode plan` | Claude 組み込み `/plan` モード → 実行 |

### brainstorming タスクのプロンプト

brainstorming が選択されたタスクには、以下の強制指示がプロンプトの先頭に付加されます:

```
=== MANDATORY EXECUTION SEQUENCE ===
PHASE 1 — BRAINSTORMING (required, do this FIRST):
  Use the Skill tool to invoke "superpowers:brainstorming" immediately.
  Do NOT read any files, do NOT make any plans, do NOT write any code before
  completing brainstorming.

PHASE 2 — PLANNING (automatic transition from brainstorming):
  After brainstorming completes, write a structured implementation plan.

PHASE 3 — EXECUTION:
  After the plan is approved, execute it.

VIOLATION: If you start writing code without completing Phase 1 and Phase 2,
stop and use the Skill tool to invoke "superpowers:brainstorming".
=== END MANDATORY EXECUTION SEQUENCE ===
```

---

## split モードの動作

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

---

## プロンプトの受け渡し

子セッションへのプロンプトは **`.cmux-team-dispatch-task-prompt.md` ファイル経由** で渡されます。

### プロンプトファイルの構成順序

```
1. MANDATORY EXECUTION SEQUENCE（brainstorming タスクのみ）
2. AVAILABLE AGENTS ブロック（Agent が発見された場合）
3. タスク説明
4. ステータスプロトコル指示
```

ブレスト指示と Agent 情報がタスク説明より先に来るため、子セッションが最初にブレストを実行し、適切な Agent を選択できます。

### なぜファイル経由なのか

シェルエスケープの問題を完全に回避するためです。

### プロンプトファイルの場所

各 worktree のルートディレクトリ: `<worktree>/.cmux-team-dispatch-task-prompt.md`

---

## ランナースクリプト ラッパー

起動スクリプトは各 worktree に `.cmux-team-dispatch-task-run.sh` を生成します。

### ランナースクリプトが保証すること

1. `status.json` を `"executing"` に更新（絶対パス使用）
2. `claude` コマンドをインタラクティブに実行（claude-teams モードでは `cmux claude-teams` を使用）
   - superpowers モード: `--dangerously-skip-permissions` を**使用しない**（`AskUserQuestion` がバイパスされ brainstorming の対話フローが壊れるため）。ツール許可は env の `permissions.defaultMode: bypassPermissions` に依存
   - plan モード: `--dangerously-skip-permissions` を使用
3. Claude 終了後、`status.json` を `"done"` または `"error"` に更新
4. `cmux wait-for --signal <slug>-done` で完了をシグナル
5. `cmux notify` で親 workspace に通知
6. `cmux send` で親ターミナルにテキスト通知を送信

---

## ステータスプロトコル

### status.json

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

タスク完了時に子セッションが `.dispatch/<task-slug>/result.md` に書き出す成果物サマリー。

---

## 監視と完了

### 進捗確認方法

1. **通知ベースの監視（推奨）**:
   ランナースクリプトが `cmux send` で親ターミナルにメッセージを送信:
   ```
   [dispatch] task "<slug>" finished (status: done|error)
   ```
   親 Claude が自動的にタスク完了を検知します。

2. **バックグラウンドモニター（補助）**:
   `monitor-dispatch.sh` がステータスファイルの変化を監視。
   個別タスクが完了/エラーになるたびに `[dispatch] task "<slug>" finished` を親に送信し、
   全タスク完了時には `[dispatch-monitor]` 通知を送信。
   ```bash
   zsh <this-skill-dir>/scripts/monitor-dispatch.sh \
     --parent-surface "$CMUX_SURFACE_ID" \
     --parent-workspace "$CMUX_WORKSPACE_ID" \
     --layout <split|workspace|claude-teams> \
     --interval 10 \
     --debug \
     "$(pwd)/.dispatch"
   ```
   `--debug` フラグでシェルトレース (`set -x`) を有効化できる。

3. **ステータスファイルのポーリング（手動確認）**:
   ```bash
   cat .dispatch/*/status.json
   ```

4. **画面の直接読み取り**:
   - workspace モード: `cmux read-screen --workspace <workspace-id> --scrollback`
   - split モード: `cmux read-screen --workspace <parent-ws> --surface <child-surface-id> --scrollback`

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
3. マージ完了後、全クリーンアップを実行:
   ```bash
   for slug in <task-slugs>; do
     git worktree remove ".worktrees/$slug" --force 2>/dev/null
     git branch -D "feat/$slug" 2>/dev/null
   done
   rm -rf .dispatch/
   rmdir .worktrees 2>/dev/null
   ```

**マージしない場合:**

1. `.dispatch/` ディレクトリのみ削除
2. 手動クリーンアップのコマンドを表示

---

## superpowers 統合（Execution Handoff 第3選択肢）

`superpowers:writing-plans` でプランが完成すると、Execution Handoff として3つの実行方法から選択:

```
1. Subagent-Driven (推奨)   → superpowers:subagent-driven-development
2. Inline Execution          → superpowers:executing-plans
3. Parallel (cmux split)     → cmux-team-dispatch-task  ← THIS SKILL
```

### フロー

1. プランファイルからタスクを抽出
2. brainstorming 選択（プランから来た場合、brainstorming 完了済みなのでデフォルト「なし」）
3. レイアウト選択（デフォルト split、引数で override）
4. 起動・監視・完了

---

## トラブルシューティング

### セッションが応答しない場合

1. `cmux read-screen` で画面を確認
2. Claude がプロンプト待ちの場合は `cmux send` でコマンドを送信
3. セッションがクラッシュしている場合は workspace を閉じて再起動

### ステータスファイルが更新されない場合

1. ランナースクリプトが正しく生成されたか確認
2. `cmux read-screen` で直接画面を確認
3. Claude がまだ実行中の場合はシグナル未発火は正常

### worktree 作成に失敗する場合

- ブランチ `feat/<task-slug>` が既に存在する場合、自動的にチェックアウトを試みます
- 既存の worktree と衝突する場合は `git worktree list` で確認し、不要なものを削除してください

---

## 制約事項

- **cmux 必須**: `/Applications/cmux.app/` にインストールされている必要があります
- **claude-teams 必須**: claude-teams モードでは `cmux claude-teams` コマンドが必要
- **同時セッション数**: 3〜5 セッションが推奨
- **split モード制限**: 2〜6 タスクが推奨。7 以上は workspace モードを使用
- **ファイル競合**: 2つのタスクが同じファイルを変更してはいけません
- **完了シグナルは信頼性あり**: ランナースクリプトが `status.json` の更新とシグナル発火を保証
