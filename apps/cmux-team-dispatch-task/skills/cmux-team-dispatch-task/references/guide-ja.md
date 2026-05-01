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
- **3つのレイアウトモード**: workspace（デフォルト・別タブ）、split（ペイン分割）、claude-teams（Agent Teams）— ディスパッチ前に選択
- **必須モデル選択フロー**: 子セッションは Plan/Brainstorming を opus で実行後、実行フェーズに入る前に必ず opus 1m / sonnet / codex を選ばせる
- **統一表示フォーマット**: 子セッション一覧・進捗・最終サマリーは Box drawing 表（Template A/B/C）で常に同じレイアウト
- **堅牢なバックグラウンド監視**: `monitor-dispatch.sh` が heartbeat / 死亡通知 / `--resume` をサポート。`cmux send` の後に必ず `cmux send-key return` を発行して親 TUI に確実に届ける
- **2つの統合戦略**: PR per task（子タスクごとに PR 作成）、Wait and merge（全タスク完了後にローカルマージ）
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
/cmux-team-dispatch-task タスクA, タスクB --layout split
/cmux-team-dispatch-task タスクA, タスクB --layout claude-teams
/cmux-team-dispatch-task タスクA, タスクB --no-grid
```

デフォルトは `workspace` モードです（split を使う場合は明示的に指定）。

---

## 表示フォーマット規約（Display Format Conventions）

子セッション一覧、進捗報告、最終サマリーは **必ず** 以下の Box drawing 表で出力する。
ASCII 罫線（`-`, `+`, `|`）や自由記述レイアウトは禁止。詳細は SKILL.md の "Display Format Conventions" を参照。

### Template A — 起動前タスク一覧（Step 1f / セッション起動報告）

```
┌────┬──────────────────────────┬──────────┬────────────┬──────────────┐
│ #  │ Task                     │ Surface  │ Mode       │ Strategy     │
├────┼──────────────────────────┼──────────┼────────────┼──────────────┤
│ 1  │ login-page-ui            │ surf:5   │ superpwr   │ PR per task  │
└────┴──────────────────────────┴──────────┴────────────┴──────────────┘
```

### Template B — 実行中の進捗報告（Step 3 完了通知受信時に再描画）

```
┌────┬──────────────────────────┬──────────┬────────────┬───────────┬─────────────────────────┐
│ #  │ Task                     │ Surface  │ Mode       │ Status    │ Last message            │
├────┼──────────────────────────┼──────────┼────────────┼───────────┼─────────────────────────┤
│ 1  │ login-page-ui            │ surf:5   │ superpwr   │ executing │ implementing routes…    │
└────┴──────────────────────────┴──────────┴────────────┴───────────┴─────────────────────────┘
```

### Template C — 最終サマリー（全タスク terminal 状態到達時）

```
┌────┬──────────────────────────┬──────────┬────────────┬───────────┬─────────────────────────┐
│ #  │ Task                     │ Duration │ Mode       │ Status    │ Result / PR             │
├────┼──────────────────────────┼──────────┼────────────┼───────────┼─────────────────────────┤
│ 1  │ login-page-ui            │ 12m34s   │ superpwr   │ done      │ https://github.com/…    │
└────┴──────────────────────────┴──────────┴────────────┴───────────┴─────────────────────────┘
```

ルール:

- カラム幅は固定。長すぎる文字列は中央 `…` で省略
- Mode 列: `superpwr` = superpowers/brainstorming、`plan` = 組み込み /plan
- Status 列: `launched` / `executing` / `done` / `error` のみ
- 子セッション側にも Template B が `PROGRESS REPORTING FORMAT` として埋め込まれ、同じ表で進捗を返す

---

## 3ステップフロー

### Step 1: Parse and Prepare

タスク収集、Agent ルーティング、レイアウト決定、統合戦略決定を1ステップで実行。
ディスパッチ前に3つのユーザーインタラクション: brainstorming 選択、レイアウト選択、統合戦略選択。

1. **(1a)** タスクを `$ARGUMENTS` から解析（なければ1回だけ質問）
2. **(1b)** `.claude/agents/` をスキャンして利用可能な Agent 一覧を収集
3. **(1c)** **brainstorming タスク選択**:
   - 各タスクについて brainstorming スキルを使うか選択
   - 選択されたタスク → superpowers モード + MANDATORY EXECUTION SEQUENCE
   - 非選択タスク → plan モード
4. **(1d)** **レイアウトモード選択**（`--layout` フラグ指定時はスキップ）:
   - **workspace** (デフォルト) — タスクごとに独立した cmux workspace（推奨・長時間タスク・7個以上にも対応）
   - **split** — 現在の workspace 内でペイン分割（2〜6タスク・全体一望）
   - **claude-teams** — `cmux claude-teams` で Agent Teams を使用（サイドバー通知）
5. **(1e)** **統合戦略選択**:
   - **PR per task** — 各子タスクがブランチを push して GitHub PR を作成。親は PR を監視
   - **Wait and merge** (デフォルト) — 全タスク完了後に親がローカルマージ
6. **(1f)** Template A（Display Format Conventions）で情報表示し、即座にディスパッチ:
   ```
   Dispatching 3 tasks (workspace mode, PR per task):

   ┌────┬──────────────────────────┬──────────┬────────────┬──────────────┐
   │ #  │ Task                     │ Surface  │ Mode       │ Strategy     │
   ├────┼──────────────────────────┼──────────┼────────────┼──────────────┤
   │ 1  │ login-page-ui            │ pending  │ superpwr   │ PR per task  │
   │ 2  │ auth-api-endpoint        │ pending  │ plan       │ PR per task  │
   │ 3  │ test-coverage            │ pending  │ superpwr   │ PR per task  │
   └────┴──────────────────────────┴──────────┴────────────┴──────────────┘

   Available agents: backend-coding, frontend-coding
   Launching…
   ```

   Mode 略称: `superpwr` = superpowers/brainstorming、`plan` = 組み込み /plan モード。

### Step 2: Launch Sessions

レイアウトモードに応じてセッションを起動。

### Step 3: Monitor and Complete

通知ベースの監視 → 結果収集 → レポート生成 → マージ/クリーンアップ。

---

## アーキテクチャ

### 3つのレイアウトモード

| モード | 説明 | 推奨ケース |
|--------|------|-----------|
| **workspace** (デフォルト) | タスクごとに独立した cmux workspace を作成 | 大半のケース、長時間タスク、7個以上 |
| **split** | 現在の workspace 内でペイン分割（自動グリッド整列） | 2〜6個のタスク、全体を一望したい場合 |
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

1. 最初の子タスク: 親ペインの右側に分割 (`launch-workspace.sh --split-direction right`)
2. 以降の子タスク: 前の子ペインの下に分割 (`launch-workspace.sh --split-direction down`)
3. 全タスク起動後、自動グリッド整列が実行される
4. 各ペインは独立した git worktree + Claude Code セッション
5. `--no-grid` で従来のリニアレイアウトを維持可能

### split モードでの起動チェーン

```
親 surface:1 → split right → child-1 surface:5
                              → split down → child-2 surface:7
                                             → split down → child-3 surface:9
```

---

## ターミナル起動待機の自動学習

子セッションのシェルが初期化される前に `cmux send` でコマンドを投入すると `sh` が失敗することがあります。これを避けるため、`launch-workspace.sh` はすべてのレイアウトモード（workspace / split / claude-teams）でシェルプロンプトを検知してから実際のコマンドを送信します。検知にかかった実時間は config に記録され、次回以降の最大待機時間を適応的に決定します。

### 実装

- ヘルパー: `scripts/terminal-wait.sh`（`launch-workspace.sh` が source する）
- 検知方法: `cmux read-screen` の出力末尾を `[\$%#❯>]\s*$` でマッチ、100ms 間隔ポーリング
- 最大待機時間: `max(baseline_ms × 3, 10000ms)`。baseline 未設定時は 10 秒
- 学習則: 新サンプル `s` に対して EMA `baseline = 0.3·s + 0.7·baseline` を更新

### Config 保存場所と優先順位

1. **プロジェクト値**（手動配置、読み取り専用扱い）: `<project>/.dispatch/config.json`
2. **グローバル値**（自動生成・更新）: `~/.claude/cmux-team-dispatch-task/config.json`

プロジェクト値が存在すればそれを baseline として使用し、無ければグローバル値を使います。書き込み（学習結果の保存）は常にグローバル側に対して行われます。

### Config スキーマ

```json
{
  "shell_ready_ms": {
    "baseline_ms": 1200,
    "samples": [800, 1100, 1400, 1200, 1300],
    "updated_at": "2026-04-20T11:20:00Z"
  }
}
```

- `baseline_ms`: 次回の最大待機時間計算に使う基準値（ミリ秒）
- `samples`: 直近 5 件のリングバッファ（デバッグ用）
- `updated_at`: 最終更新 UTC ISO8601

### トラブルシュート

| 症状 | 対処 |
|------|------|
| 初回起動で `sh: command not found` が出る | `max_wait=10000ms` でも足りないほど遅い環境。プロジェクト config で `baseline_ms` を大きく（例: 5000）設定する |
| 特定プロジェクトだけ恒常的に遅い | `<project>/.dispatch/config.json` に手動で上書き値を置く |
| 学習値をリセットしたい | `rm ~/.claude/cmux-team-dispatch-task/config.json` |
| config 壊れた疑い | `jq . ~/.claude/cmux-team-dispatch-task/config.json` で検証、壊れていれば削除 |

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
3. Claude 終了後、`status.json` を `"done"` または `"error"` に更新
4. `cmux wait-for --signal <slug>-done` で完了をシグナル
5. `cmux notify` で親 workspace に通知
6. `cmux send` でテキスト通知 → 続けて `cmux send-key --surface <id> return` を発行（親が claude TUI の場合に input box でテキストが滞留するのを防ぐため、送信と Enter は必ずペアで実行する）

シグナル名は `<task-slug>-done` で、起動スクリプトの出力 JSON の `signal_name` フィールドで返されます。

---

## ステータスプロトコル

### status.json

```json
{
  "status": "launched",
  "workspace_id": "workspace:3",
  "surface_id": "surface:5",
  "message": "Claude session launched in plan mode (workspace layout)",
  "pr_url": "https://github.com/owner/repo/pull/123",
  "timestamp": "2026-04-07T16:00:00Z"
}
```

- `pr_url` は PR per task 戦略で PR 作成済みの場合のみ `done` で付与。
- クリーンアップ意思は `status.json` には記録しない。親がディスパッチ完了時に
  `AskUserQuestion` で一度だけ聞き（ワークスペース閉鎖 / worktree 削除 / ブランチ削除）、
  その回答を全タスクに適用する。子セッションは質問も削除も行わない。

### ステータス一覧

| ステータス | 意味 | 書き込み元 |
|-----------|------|-----------|
| `launched` | セッション起動完了、Claude ロード中 | 起動スクリプト |
| `planning` | 計画フェーズ中 | 子セッション（任意） |
| `executing` | Claude 起動中 / 実装中 | ランナースクリプト / 子セッション |
| `done` | 全作業完了 | ランナースクリプト / 子セッション |
| `error` | エラー / 異常終了 | ランナースクリプト / 子セッション |

### 子セッションのステータス報告手順

子セッションは以下の手順でステータスを報告します:

1. **計画開始 → 実行開始時**: `status.json` を `"executing"` に更新
2. **全作業完了時（Wait and merge）**:
   1. 変更を必ずコミットしてから完了報告する:
      ```bash
      git add -A
      git commit -m "<task-slug>: <変更の簡潔なサマリー>"
      ```
      論理的に独立した変更単位がある場合は、それぞれ別のコミットを作成する。
      **このステップを省略しないこと** — 未コミットの変更は worktree クリーンアップ時に失われます。
   2. `status.json` を `"done"` に更新（クリーンアップ意思は含めない。親が最後にまとめて聞く）:
      ```json
      {"status":"done","message":"...","timestamp":"..."}
      ```
   3. `result.md` に成果物サマリーを書き出す
3. **全作業完了時（PR per task）**:
   1. 変更をコミット（上記と同様）
   2. ブランチを push して PR を作成:
      ```bash
      git push -u origin feat/<task-slug>
      gh pr create --title "<task-slug>: <サマリー>" --body "<変更の説明>"
      ```
   3. `status.json` を `"done"` に更新（`pr_url` を含める。クリーンアップ意思は含めない）
   4. `result.md` に成果物サマリーを書き出す（`## Pull Request` セクションに PR URL を記載）
4. **ブロッキングエラー発生時**: `status.json` を `"error"` に更新

> 子セッションはクリーンアップ質問も削除も行いません。worktree / ブランチ / ペイン・ワークスペースの
> 削除確認はすべて親セッションが全タスク完了後にまとめて実施します（子が自分の worktree を
> 掴んだ状態で親が削除を試みて失敗するのを防ぐため）。

### result.md

タスク完了時に子セッションが `.dispatch/<task-slug>/result.md` に書き出す成果物サマリー。

```markdown
# <タスク名>

## Changes Made

- 変更したファイルと内容の一覧

## Test Results

- テストの合否サマリー

## Commits

- <hash> <コミットメッセージ>
```

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
   `--heartbeat-interval` 秒（デフォルト60秒）ごとに `[dispatch-monitor] alive | loop=N | tasks: …` を送信、
   全タスク完了時には `[dispatch-monitor] 全 N タスクが完了しました` を送信、
   異常終了時には `[dispatch-monitor] DIED` を親に送信する。
   stdout は `.dispatch/.monitor.log` に tee され、PID は `.dispatch/.monitor.pid` に書き出される。
   ```bash
   zsh <this-skill-dir>/scripts/monitor-dispatch.sh \
     --parent-surface "$CMUX_SURFACE_ID" \
     --parent-workspace "$CMUX_WORKSPACE_ID" \
     --layout <split|workspace|claude-teams> \
     --interval 10 \
     --heartbeat-interval 60 \
     --dispatch-dir "$(pwd)/.dispatch"
   ```

   モニターが死亡した場合は `--resume` で再起動できる（既に done/error のタスクは再通知されない）:
   ```bash
   PID=$(cat .dispatch/.monitor.pid)
   kill -0 "$PID" 2>/dev/null || zsh <this-skill-dir>/scripts/monitor-dispatch.sh \
     --parent-workspace "$CMUX_WORKSPACE_ID" \
     --layout workspace \
     --dispatch-dir "$(pwd)/.dispatch" \
     --resume
   ```
3. **ステータスファイルのポーリング（手動確認）**:
   ```bash
   for f in .dispatch/*/status.json; do
     task_name=$(dirname "$f" | xargs basename)
     task_status=$(jq -r '.status' "$f" 2>/dev/null || echo "unknown")
     message=$(jq -r '.message' "$f" 2>/dev/null || echo "")
     echo "$task_name: $task_status - $message"
   done
   ```

4. **画面の直接読み取り**:
   - workspace モード: `cmux read-screen --workspace <workspace-id> --scrollback`
   - split モード: `cmux read-screen --workspace <parent-ws> --surface <child-surface-id> --scrollback`

### 介入のタイミング

- **ステータスが "error"**: エラーメッセージとセッション画面を確認し、リトライまたはエスカレーションを提案
- **長時間応答なし**: 通知が長時間来ない場合、ステータスファイルのポーリングや画面の直接読み取りで確認
- **ユーザーリクエスト**: ユーザーはいつでも特定のセッションの確認を依頼可能

### 完了レポート

全タスクが終了ステータス（`"done"` または `"error"`）に到達すると、統合レポートを生成。
統合戦略（Step 1e で選択）によってテンプレートが異なる。

レポートは必ず Template C（Display Format Conventions）の表で始める。

**Wait and merge の場合:**

```
# Team Dispatch Report

┌────┬──────────────────────────┬──────────┬────────────┬───────────┬─────────────────────────┐
│ #  │ Task                     │ Duration │ Mode       │ Status    │ Result / PR             │
├────┼──────────────────────────┼──────────┼────────────┼───────────┼─────────────────────────┤
│ 1  │ login-page-ui            │ 12m34s   │ superpwr   │ done      │ feat/login-page-ui      │
│ 2  │ auth-api-endpoint        │ 08m02s   │ plan       │ done      │ feat/auth-api-endpoint  │
└────┴──────────────────────────┴──────────┴────────────┴───────────┴─────────────────────────┘

## Task Results

### 1. login-page-ui [brainstorming]
<.dispatch/login-page-ui/result.md の内容>

### 2. auth-api-endpoint [plan]
<.dispatch/auth-api-endpoint/result.md の内容>

## Worktree Branches
- feat/login-page-ui
- feat/auth-api-endpoint

## Next Steps
- Review and merge branches
- Run full test suite across all changes
- Clean up worktrees when done
```

**PR per task の場合:**

```
# Team Dispatch Report

┌────┬──────────────────────────┬──────────┬────────────┬───────────┬─────────────────────────┐
│ #  │ Task                     │ Duration │ Mode       │ Status    │ Result / PR             │
├────┼──────────────────────────┼──────────┼────────────┼───────────┼─────────────────────────┤
│ 1  │ login-page-ui            │ 12m34s   │ superpwr   │ done      │ https://github.com/…    │
│ 2  │ auth-api-endpoint        │ 08m02s   │ plan       │ done      │ https://github.com/…    │
└────┴──────────────────────────┴──────────┴────────────┴───────────┴─────────────────────────┘

## Task Results

### 1. login-page-ui [brainstorming]
<.dispatch/login-page-ui/result.md の内容>
PR: <PR URL from status.json>

### 2. auth-api-endpoint [plan]
<.dispatch/auth-api-endpoint/result.md の内容>
PR: <PR URL from status.json>

## Pull Requests
- login-page-ui: <PR URL>
- auth-api-endpoint: <PR URL>

## Next Steps
- Review and merge PRs on GitHub
- Clean up worktrees when done
```

### 統合とクリーンアップ

Step 1e で選択した統合戦略に応じて動作が異なります。

#### Wait and merge の場合

全タスク完了後、ユーザーにマージするか確認します:

**マージする場合:**

1. 各 worktree の未コミット変更をコミット
2. 現在のブランチに順次マージ:
   ```bash
   for slug in <task-slugs>; do
     git merge "feat/$slug" --no-edit || echo "CONFLICT in feat/$slug"
   done
   ```
3. コンフリクトが発生した場合、ユーザーの解決を支援
4. マージ完了後、**親セッションでまとめてクリーンアップ確認**（後述「親セッションのクリーンアップ確認」節）を実行。
   親が一度だけ「ワークスペース閉鎖 / worktree 削除 / ブランチ削除」を聞き、全タスクに適用する。
5. マージ結果を `git log --oneline` で表示

**マージしない場合:**

1. `.dispatch/` ディレクトリのみ削除:
   ```bash
   rm -rf .dispatch/
   ```
2. 手動クリーンアップのコマンドを表示:
   ```
   Worktrees are preserved for manual review. To clean up later:

   # worktree 一覧表示
   git worktree list

   # 個別の worktree とブランチを削除
   git worktree remove .worktrees/<task-slug>
   git branch -D feat/<task-slug>

   # 一括削除
   for slug in <task-slugs>; do
     git worktree remove ".worktrees/$slug" --force
     git branch -D "feat/$slug"
   done
   rmdir .worktrees 2>/dev/null
   ```

#### PR per task の場合

各子セッションが完了時に PR を作成済み。完了レポートに PR URL を含めて表示:

1. **PR 一覧と状態の表示**:
   ```bash
   for slug in <task-slugs>; do
     pr_url=$(jq -r '.pr_url // empty' ".dispatch/$slug/status.json" 2>/dev/null)
     if [[ -n "$pr_url" ]]; then
       pr_state=$(gh pr view "$pr_url" --json state -q '.state' 2>/dev/null || echo "unknown")
       echo "$slug: $pr_state - $pr_url"
     else
       echo "$slug: PR 未作成"
     fi
   done
   ```

2. **親セッションでまとめてクリーンアップ確認**（後述「親セッションのクリーンアップ確認」節）を実行。
   親が一度だけ「ワークスペース閉鎖 / worktree 削除 / ブランチ削除」を聞き、全タスクに適用する。

   すべて「保持」を選んだ場合は `rm -rf .dispatch/` のみで、worktree とブランチは残る。
   手動で後から削除するコマンドは「Wait and merge の『マージしない場合』」と同じ。

---

### 親セッションのクリーンアップ確認（両戦略共通）

すべての子セッションが `status: done` に到達した後、**親セッション** がまとめて 3 問聞き、
全タスクに同じ回答を適用する。子セッションは削除も質問も行わない。
`$LAYOUT_MODE` は Step 1d で選んだレイアウト名（`split` / `workspace` / `claude-teams`）。

`AskUserQuestion` で以下の 3 問を順に聞く:

```
Q1 header="Pane/Workspace"
   question="子セッションのペイン/ワークスペースをすべて閉じますか?"
   options: "はい、全て閉じる" / "いいえ、開いたままにする"
Q2 header="Worktree"
   question="タスクの worktree (.worktrees/<slug>) をすべて削除しますか?"
   options: "はい、全て削除" / "いいえ、残す"
Q3 header="Branch"
   question="feature ブランチ (feat/<slug>) をすべて削除しますか?"
   options: "はい、全て削除" / "いいえ、残す"
```

回答を `close_all` / `remove_wt_all` / `delete_br_all` の真偽値で保持し、以下を実行:

```bash
for slug in <task-slugs>; do
  status_file=".dispatch/$slug/status.json"
  workspace_id=$(jq -r '.workspace_id // empty' "$status_file")
  surface_id=$(jq -r '.surface_id // empty' "$status_file")

  # 1) pane / workspace を先に閉じる
  if [[ "$close_all" == "true" ]]; then
    case "$LAYOUT_MODE" in
      split)                  [[ -n "$surface_id"   ]] && cmux close-surface   --surface   "$surface_id"   ;;
      workspace|claude-teams) [[ -n "$workspace_id" ]] && cmux close-workspace --workspace "$workspace_id" ;;
    esac
  fi

  # 2) worktree を削除
  [[ "$remove_wt_all" == "true" ]] && git worktree remove ".worktrees/$slug" --force 2>/dev/null

  # 3) feature ブランチを削除
  [[ "$delete_br_all" == "true" ]] && git branch -D "feat/$slug" 2>/dev/null
done

# 4) 最終整理（回答に関わらず常に実行）
rm -rf .dispatch/
rmdir .worktrees 2>/dev/null
```

#### モード別の閉鎖対象

| `$LAYOUT_MODE`  | `close_all=true` で閉じる対象      | 使用する cmux コマンド                    |
|-----------------|----------------------------------|-------------------------------------------|
| `split`         | 子のペイン（子の `surface_id`）   | `cmux close-surface --surface <id>`       |
| `workspace`     | 子のワークスペース                 | `cmux close-workspace --workspace <id>`   |
| `claude-teams`  | team が紐づくワークスペース         | `cmux close-workspace --workspace <id>`   |

> pane/workspace → worktree → ブランチの順序は意図的。先に閉鎖することで worktree を
> 開いている shell が終了し、`git worktree remove` が確実に成功する。ブランチ削除は
> worktree 削除後に行う必要がある。
> 子セッション内で worktree を削除させると、親が削除を実行する時点ではまだ子プロセスが
> worktree を掴んだままで `git worktree remove` が失敗するため、すべて親側に集約している。

---

## superpowers 統合（Execution Handoff 第3選択肢）

`superpowers:writing-plans` でプランが完成すると、Execution Handoff として3つの実行方法から選択:

```
1. Subagent-Driven (推奨)   → superpowers:subagent-driven-development
2. Inline Execution          → superpowers:executing-plans
3. Parallel (cmux)           → cmux-team-dispatch-task  ← THIS SKILL
```

### フロー

1. プランファイルからタスクを抽出
2. brainstorming 選択（プランから来た場合、brainstorming 完了済みなのでデフォルト「なし」）
3. レイアウト選択（デフォルト workspace、引数で override）
4. 起動・監視・完了

---

## 子セッションのモデル選択フロー（必須）

子セッションのプロンプトには `MANDATORY MODEL SELECTION SEQUENCE` が必ず含まれており、以下の二段階で動作する:

### Phase A: Plan / Brainstorming（常に opus）

- superpowers モード: `superpowers:brainstorming` → `superpowers:writing-plans`
- plan モード: 組み込み `/plan`
- このフェーズでは **モデル切り替えを禁止** する。常に opus を使う。

### Phase B: 実装フェーズのモデル選択（auto mode でも必須）

Phase A 完了後、コード変更を始める前に必ず `AskUserQuestion` で以下を聞く:

| 選択肢 | 動作 |
|--------|------|
| **opus 1m** | 高品質・長コンテキスト（推奨: 大規模・複雑な実装）。`/model claude-opus-4-7[1m]` で切り替えて実行を継続 |
| **sonnet** | 高速・低コスト（推奨: 中規模・パターン化された実装）。`/model claude-sonnet-4-6` で切り替えて実行を継続 |
| **codex** | codex CLI に乗り換え。同じ workspace で右に split し、新ペインで `codex` を起動。`~/.codex/config.toml` の `external_migration = true` と `cmux codex install-hooks` で claude セッションが自動的に引き継がれる |

codex 選択時のコマンド例:

```bash
SURF=$(cmux new-split right | awk '{print $2}')
cmux send --surface "$SURF" "codex"
cmux send-key --surface "$SURF" return
# 以降は新ペインの codex で実装を継続。元の claude ペインは
# status.json の更新と cmux wait-for シグナル発火だけ担当する。
```

### 前提条件

- codex オプションを使う場合、事前に `cmux codex install-hooks` をマシンで一度実行しておく必要がある
- これにより `~/.codex/hooks.json` に SessionStart / Stop / UserPromptSubmit hooks が入り、`config.toml` に `[features] codex_hooks = true` / `external_migration = true` が追加される

---

## 制約事項

- **cmux 必須**: `/Applications/cmux.app/` にインストールされている必要があります
- **claude-teams 必須**: claude-teams モードでは `cmux claude-teams` コマンドが必要
- **同時セッション数**: 3〜5 セッションが推奨
- **split モード制限**: 2〜6 タスクが推奨。7 以上は workspace モードを使用
- **ファイル競合**: 2つのタスクが同じファイルを変更してはいけません
- **完了シグナルは信頼性あり**: ランナースクリプトが `status.json` の更新とシグナル発火を保証。`cmux send` の後は必ず `cmux send-key return` を発行し、親 claude TUI の input box に滞留しないようにしている
- **codex 統合の前提**: `cmux codex install-hooks` 済みであること（`external_migration = true` と hooks がインストールされている）
