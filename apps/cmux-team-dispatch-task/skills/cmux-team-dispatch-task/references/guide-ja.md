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
- **必須モデル選択フロー**: 子セッションは Plan/Brainstorming を opus で実行後、実行フェーズに入る前に必ず `opus 1m` / `sonnet` を選ばせる（`runners.json` に `engine: codex` runner がある場合のみ `codex` も追加）。同一 model なら現セッション継続、異なる model なら `launch-workspace.sh --mode execute` 経由で孫 surface を spawn (runner script でラップされ完了通知が確実に親に伝播)。元 Child は `.deferred` を書いて exit する
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

### Template A — 起動前タスク一覧（Step 1h / セッション起動報告）

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

タスク収集、Agent ルーティング、レイアウト決定、統合戦略決定、子 runner 設定を1ステップで実行。
ディスパッチ前に最大5つのユーザーインタラクション: brainstorming 選択、レイアウト選択、統合戦略選択、子 runner 選択（`runners.json` 初回セットアップ含む）、メッセージトランスポート選択（初回のみ）。

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
6. **(1f)** **子セッション runner 選択**（詳細は「子セッション runner 設定（runners.json）」セクション）:
   - `runners.json` 不在 → 初回セットアップで生成
   - runners 1 件 → 自動でその runner を全タスクに適用（切替確認スキップ）
   - runners 2 件以上 → 切替確認 → タスクごとに選択 or デフォルト適用
7. **(1g)** **メッセージトランスポート解決**（`message_type`、初回のみ質問）:

   子 → 親の通知手段を決める。`send-message`（現行の cmux send、default）/ `agmsg`
   （[agmsg](https://github.com/fujibee/agmsg) によるエージェント間メッセージング）。

   - config（`.dispatch/config.json` > `~/.claude/cmux-team-dispatch-task/config.json`）に
     `message_type` があればそれを使い、質問しない
   - 未設定 + agmsg インストール済み（`~/.agents/skills/agmsg/scripts/send.sh` が存在）
     → AskUserQuestion で確認し、**Yes / No どちらの回答もグローバル config に永続化**
   - 未設定 + agmsg 未インストール → `send-message`（config には書かない）

   agmsg モード時は dispatch 前に team を配線する:

   ```bash
   TEAM="dispatch-$(basename "$(git rev-parse --show-toplevel)")"
   ~/.agents/skills/agmsg/scripts/join.sh "$TEAM" parent claude-code "$(pwd)"
   ~/.agents/skills/agmsg/scripts/delivery.sh set monitor claude-code "$(pwd)"
   ```

   各 launch に `--message-type agmsg --agmsg-team "$TEAM" --agmsg-from <slug>` を付与し、
   worktree 作成後に子 agent を join する。子プロンプトには「親 (`parent`) へ
   `send.sh` で直接質問・進捗報告できる」旨を追記する。

8. **(1h)** Template A（Display Format Conventions）で情報表示し、即座にディスパッチ:
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

### Pre-warm Standby Panes（workspace レイアウトのみ）

config から `prewarm` を読む（`message_type` と同じ優先順位。デフォルト `true`）:

```bash
PREWARM=$(jq -r '.prewarm // empty' .dispatch/config.json 2>/dev/null)
[[ -z "$PREWARM" ]] && PREWARM=$(jq -r '.prewarm // "true"' \
  ~/.claude/cmux-team-dispatch-task/config.json 2>/dev/null)
[[ -z "$PREWARM" ]] && PREWARM=true
```

レイアウトが `workspace` かつ `PREWARM` が `true` のとき、各タスク workspace 内に standby ペイン
を縦積みで起動する（上: opus / 中: sonnet / 下: codex — codex は `runners.json` に
`engine: "codex"` runner が登録されている場合のみ）。ペイン作成はすべて `prewarm-panes.sh` に
委譲し、手動で作成しないこと。

**send-message モード** — opus セッションはすでにワークスペース起動時にタスクプロンプト付きで
起動済み。その下に sonnet/codex ペインを追加する（その起動の出力 JSON から `workspace_id` /
`surface_id` を取得）:

```bash
bash <this-skill-dir>/scripts/prewarm-panes.sh \
  --workspace <workspace-id> --base-surface <surface-id> \
  --cwd "<repo-root>/.worktrees/<task-slug>" \
  --slug <task-slug> \
  --status-dir "$(pwd)/.dispatch/<task-slug>" \
  [--codex-runner <codex-runner-name>] \
  --parent-notify-workspace "$CMUX_WORKSPACE_ID" \
  --parent-notify-surface "$CMUX_SURFACE_ID"
```

**agmsg モード** — 通常のワークスペース起動（タスクプロンプト付き起動）は行わない。代わりに
すべてのペイン（opus-1m を含む）がタスクメッセージなしのアイドル状態で起動し、Phase A の
タスクは後から agmsg 経由で配送される。`prewarm-panes.sh` が worktree を作成し、agmsg delivery
配線（join + `delivery.sh set`。いずれのペインが起動するより前に行う）を済ませてから opus-1m の
standby workspace を起動し、その下に sonnet/codex を積む:

```bash
RESULT=$(bash <this-skill-dir>/scripts/prewarm-panes.sh \
  --with-opus \
  --cwd "<repo-root>/.worktrees/<task-slug>" \
  --slug <task-slug> \
  --status-dir "$(pwd)/.dispatch/<task-slug>" \
  [--codex-runner <codex-runner-name>] \
  --message-type agmsg --agmsg-team "$TEAM" \
  --parent-notify-workspace "$CMUX_WORKSPACE_ID" \
  --parent-notify-surface "$CMUX_SURFACE_ID")
```

続けて Phase A のタスクを opus ペインへ配送する:

1. タスクプロンプト全体（PROGRESS REPORTING FORMAT と MANDATORY MODEL SELECTION SEQUENCE
   ブロックを含む）を `<repo-root>/.worktrees/<task-slug>/.cmux-team-dispatch-task-prompt.md`
   に書き込む。
2. `touch .dispatch/<task-slug>/.assigned` — これ以降、opus standby wrapper が status.json
   遷移の所有権を持つ（`--defer-status` 付きで起動しているため、Phase B へのハンドオフが
   必要な場合でも `.deferred` でこれを抑止できる）。
3. タスクを送信する。`.dispatch/<task-slug>/prewarm.json` の `.opus.delivery` を確認:
   - `"agmsg"` →
     `~/.agents/skills/agmsg/scripts/send.sh "$TEAM" parent <task-slug> "Read and follow the task in .cmux-team-dispatch-task-prompt.md. Mode: <plan|superpowers> — for superpowers invoke the superpowers:brainstorming skill first; for plan produce a structured plan before implementing."`
     （slash command は agmsg push 経由では発火できないため、モードは `/plan` のようなコマンド
     ではなくメッセージ本文として伝える。）
   - `"cmux-send"`（配線失敗時） →
     `cmux send --surface <opus-surface> "<同じテキスト>"` に続けて
     `cmux send-key --surface <opus-surface> return`。

`prewarm-panes.sh` が書き出す prewarm.json のスキーマ（`opus` は agmsg モード時のみ、`codex` は
codex runner が存在する場合のみ、`delivery` は配線が成功したかどうかに応じて `"agmsg"` または
`"cmux-send"`）:

```json
{
  "opus":   { "surface_id": "surface:N", "agent": "<slug>",        "delivery": "agmsg" },
  "sonnet": { "surface_id": "surface:N", "agent": "<slug>-sonnet", "delivery": "agmsg" },
  "codex":  { "surface_id": "surface:N", "agent": "<slug>-codex",  "delivery": "cmux-send" }
}
```

split / claude-teams レイアウトと `prewarm: false` はこのセクションを完全にスキップする —
Phase B はオンデマンドの `--mode execute` spawn にフォールバックし、agmsg モードの opus
セッションも従来どおりプロンプト埋め込みのワークスペース起動にフォールバックする。

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

`message_type` / `prewarm` も同じ config ファイル（`.dispatch/config.json` /
`~/.claude/cmux-team-dispatch-task/config.json`）に並べて保持される:

```json
{
  "message_type": "agmsg",
  "prewarm": true,
  "shell_ready_ms": { "baseline_ms": 1200, "samples": 5, "updated_at": "..." }
}
```

- `message_type`: 子 → 親の通知トランスポート。`"send-message"`（default）| `"agmsg"`
- `prewarm`: workspace レイアウト時の standby ペイン事前起動（縦積み: 上 opus / 中 sonnet / 下 codex）。agmsg モードでは opus-1m も idle 起動し Phase A タスクを agmsg で配送する。`true`（default）| `false`

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

## 子セッション runner 設定（runners.json）

親セッションは常に親の `claude` を使い、子セッションは `runners.json` で定義されたいずれかの runtime（`claude` の別アカウント、`codex` バイナリ、`.zshrc` の zsh 関数など）で起動できます。SKILL.md の Step 1f で配置・選択されます。

### 配置場所

- `~/.claude/cmux-team-dispatch-task/runners.json`
- 環境変数 `RUNNERS_CONFIG_PATH` で上書き可能（テスト用）

### スキーマ（最小）

```json
{
  "default": "claude",
  "runners": [
    { "name": "claude",  "command": "claude",  "engine": "claude" },
    { "name": "ccenec",  "command": "ccenec",  "engine": "claude" },
    { "name": "codex",   "command": "codex",   "engine": "codex"  }
  ]
}
```

| フィールド | 意味 |
|----------|------|
| `default` | 切替確認で「No」を選んだとき／runner 1 件のときに全タスクへ適用される runner 名 |
| `runners[].name` | AskUserQuestion の選択肢ラベル兼一意 ID |
| `runners[].command` | 実際に実行するコマンド／関数名 |
| `runners[].engine` | `claude` または `codex`。MODE 別の起動引数組み立てを切替（下表参照） |

### engine × MODE 起動コマンド対応表

固定プロンプトテキスト (plan / superpowers): `Read and follow the task in .cmux-team-dispatch-task-prompt.md`
execute モードのプロンプトテキスト: `Read and execute the plan at <plan-file>` (`--plan-file` で指定)

| engine | MODE        | 組み立てコマンド |
|--------|-------------|----------------|
| claude | plan        | `<command> --dangerously-skip-permissions '/plan <PROMPT>'` |
| claude | superpowers | `<command> '<PROMPT>'` |
| claude | execute     | `<command> [--model <X>] [--dangerously-skip-permissions] '<EXEC_PROMPT>'` |
| codex  | plan        | `<command> --dangerously-bypass-approvals-and-sandbox '/plan <PROMPT>'` |
| codex  | superpowers | `<command> '$superpowers:brainstorming <PROMPT>'` |
| codex  | execute     | `<command> --dangerously-bypass-approvals-and-sandbox '<EXEC_PROMPT>'` |

上記全体は常に `zsh -ic "..."` で wrap され、`~/.zshrc` のユーザー定義関数（`ccenec` 等）と env（proxy 認証 / PATH 等）が子セッションで読み込まれます。

**execute モードの使い所**: Phase B (実装フェーズ) で sonnet / codex などの別モデルに切り替える場面。Child セッションが `launch-workspace.sh --mode execute --plan-file <path> [--model <X>] [--skip-permissions]` を呼び出して別 surface を spawn し、自分は `<STATUS_DIR>/.deferred` を作成して exit する。execute モードでは `.cmux-team-dispatch-task-prompt.md` を書き換えず、Phase A のものを温存する。

`claude-teams` レイアウトは runner 設定を無視し常に `cmux claude-teams`（親の claude アカウント）で起動します。

### 初回セットアップ

`runners.json` が存在しない状態で SKILL を発動すると、Step 1f で初回セットアップが起動します:

1. AskUserQuestion で **starter テンプレ（claude のみ）** か **カスタム** を選択
2. starter テンプレ選択時は claude のみが書き出されます
3. カスタム選択時は AskUserQuestion ループで `name / command / engine` を 1 件ずつ収集、最後に「もう 1 件追加？」を繰り返し確認
4. 完了後、`~/.claude/cmux-team-dispatch-task/` ディレクトリが無ければ作成され、runners.json が書き出されます

### タスクごとの runner 切替

- runners が **1 件**: 切替確認は出ず自動でその runner を全タスクに割当
- runners が **2 件以上**: 「子セッションごとにランタイム/モデルを切り替えますか？」を確認
  - **No**: `default` runner を全タスクに割当
  - **Yes**: タスクごとに AskUserQuestion で選択

選ばれた runner 名は `launch-session-splits.sh` の入力 JSON 各タスクに optional `"runner": "<name>"` として渡され、`launch-workspace.sh --runner <name>` に伝播します。

### 既存 Phase B モデル選択との関係

子セッション内で実装フェーズ前に行う Phase B モデル選択（`opus 1m` / `sonnet` / 条件付き `codex`）とは**レイヤーが異なる**:

- **Step 1f (本セクション)**: 子セッションを *どの runtime で起動するか* を親が決める（起動時）
- **Phase B**: 起動済みの子 claude セッションが *どのモデルで実装フェーズに入るか* を決める（起動後）

なお Phase B の `codex` 選択肢は `runners.json` に `engine: codex` runner が登録されている場合にのみ表示される。`engine: codex` で子を起動した場合、Phase B の codex 選択肢は意味を失います（既に codex で動いているため）。

---

## ランナースクリプト ラッパー

起動スクリプトは各 worktree に `.cmux-team-dispatch-task-run-<workspace-name>.sh` を生成します。ファイル名に workspace 名を含めることで、Child (`<slug>`) と Phase B grandchild (`<slug>-exec`) が同じ worktree を共有する場面でも runner ファイル同士が衝突しません (実行中のスクリプトを上書きすると bash が undefined 挙動になります)。

### ランナースクリプトが保証すること

1. `status.json` を `"executing"` に更新（絶対パス使用）
2. `claude` コマンドをインタラクティブに実行（claude-teams モードでは `cmux claude-teams` を使用）
3. Claude 終了後、`status.json` を `"done"` または `"error"` に更新
4. `cmux wait-for --signal <slug>-done` で完了をシグナル
5. `cmux notify` で親 workspace に通知
6. `cmux send` でテキスト通知 → 続けて `cmux send-key --surface <id> return` を発行（親が claude TUI の場合に input box でテキストが滞留するのを防ぐため、送信と Enter は必ずペアで実行する）

- **message_type=agmsg 時**: 親へのテキスト通知は `cmux send` ペアの代わりに
  `~/.agents/skills/agmsg/scripts/send.sh <team> <from> parent "<msg>"` で送信される
  （`cmux notify` と `cmux wait-for --signal` は両モード共通）
- **standby wrapper（`--mode standby`）**: 起動時に status.json を書かず、exit 時も
  `<STATUS_DIR>/.assigned` が存在するときだけ done/error に遷移させる（`.deferred` の逆向き）。
  signal 名は `<workspace-name>-done`（例: `login-page-ui-sonnet-done`）

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

### message_type による監視方式の違い

- `send-message`: 従来どおり `monitor-dispatch.sh` を起動（heartbeat / DIED 検知 / 全完了通知）
- `agmsg`: `monitor-dispatch.sh` を**起動しない**。完了通知は agmsg のリアルタイム push で届く
  （親が Step 1g で delivery mode `monitor` を設定済み）。長時間通知が無い場合は
  `.dispatch/*/status.json` を手動ポーリングで確認する。`[dispatch-monitor]` 系の
  heartbeat / DIED メッセージはこのモードには存在しない

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

  # pre-warm standby ペインが残っていれば閉じる（Phase B で未使用のまま残るケース）
  if [[ "$close_all" == "true" && -f ".dispatch/$slug/prewarm.json" ]]; then
    for sf in $(jq -r '.[].surface_id' ".dispatch/$slug/prewarm.json" 2>/dev/null); do
      cmux close-surface --surface "$sf" 2>/dev/null || true
    done
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

agmsg モード時は、最終整理の際に子 agent を team から除籍する:

```bash
for slug in <task-slugs>; do
  ~/.agents/skills/agmsg/scripts/leave.sh "$TEAM" "$slug" 2>/dev/null || true
  ~/.agents/skills/agmsg/scripts/leave.sh "$TEAM" "$slug-sonnet" 2>/dev/null || true
  ~/.agents/skills/agmsg/scripts/leave.sh "$TEAM" "$slug-codex" 2>/dev/null || true
done
```

親 (`parent`) は repo 固定 team に残す（次回 dispatch で再利用）。

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

子セッションのプロンプトには `MANDATORY MODEL SELECTION SEQUENCE` が必ず含まれており、以下の二段階で動作する。

### Phase A: Plan / Brainstorming（常に opus）

- superpowers モード: `superpowers:brainstorming` → `superpowers:writing-plans`
- plan モード: 組み込み `/plan`
- このフェーズでは **モデル切り替えを禁止** する。常に opus を使う。

### Phase B: 実装フェーズのモデル選択（auto mode でも必須）

Phase A 完了後、コード変更を始める前に必ず `AskUserQuestion` で以下を聞く:

| 選択肢 | 表示条件 | 動作 |
|--------|---------|------|
| **opus 1m** | 常時 | Phase A と **同一 model** 扱い。`/model claude-opus-4-7[1m]` で切り替え、**現セッションで実装続行**。`prewarm.json` が存在する場合、未使用の standby ペインを閉じる（`.opus` は除外。下記「opus 1m 選択時の close ループ」参照） |
| **sonnet** | 常時 | **異なる model**。まず `prewarm.json` を確認し、pre-warm 済み standby ペインがあればそちらへ実行指示を送信、無ければ `launch-workspace.sh --mode execute` で spawn（下記参照） |
| **codex** | `runners.json` に `engine: codex` の runner が **1 件以上ある時のみ** | **異なる model**。sonnet と同様に `prewarm.json` を確認し、pre-warm 済み standby ペインがあればそちらへ実行指示を送信、無ければ `launch-workspace.sh --mode execute --runner <codex-runner>` で spawn |

#### opus 1m 選択時の close ループ

`prewarm.json` が存在する場合、実装を続行する前に未使用の standby ペインを全て閉じる。
`.opus` キーは除外する（agmsg モードではそれが自身のセッションの surface であるため）:

```bash
for sf in $(jq -r 'to_entries[] | select(.key != "opus") | .value.surface_id' \
  "<EXISTING_STATUS_DIR>/prewarm.json"); do
  cmux close-surface --surface "$sf"
done
```

#### pre-warm 済み standby ペインがある場合（sonnet / codex 共通の分岐）

`<EXISTING_STATUS_DIR>/prewarm.json` の `.sonnet.surface_id` / `.codex.surface_id` が非空なら:

1. 使わなかった方の standby ペイン（codex 選択時は sonnet standby、sonnet 選択時は codex standby）を
   `cmux close-surface` で閉じる（`.assigned` を touch する **前** に行う — sonnet/codex の wrapper は
   同じ `.assigned` を共有するため、touch 後に閉じると未使用側 wrapper が誤って status.json に
   error を書くレースが発生する）。`.assigned` の無い standby は閉じても status.json を汚さない
2. `touch "<EXISTING_STATUS_DIR>/.assigned"` — 完了処理（status.json done/error 遷移 + `<slug>-sonnet-done` /
   `<slug>-codex-done` シグナル + 親通知）の所有権を standby wrapper に渡す
3. 実行指示（`Read and execute the plan at <PLAN_FILE_PATH>. ... 完了後は /exit`）を送信する。
   `prewarm.json` の `.sonnet.delivery` / `.codex.delivery` を確認して分岐する:
   - `"agmsg"`（`prewarm-panes.sh` が worktree に delivery 配線済み）→
     `~/.agents/skills/agmsg/scripts/send.sh "$TEAM" <task-slug> <task-slug>-sonnet|-codex "$REQUEST_TEXT"`
   - `"cmux-send"`（send-message モード、または配線失敗時）→
     `cmux send --surface "$SURFACE" "$REQUEST_TEXT"` に続けて
     `cmux send-key --surface "$SURFACE" return`
4. `touch "<EXISTING_STATUS_DIR>/.deferred"` してこのセッションを exit

#### prewarm.json が無い場合（従来の spawn フォールバック、split レイアウト / prewarm off）

「異なる model」が選ばれた場合の spawn 手順 (Child セッション側の動作):

```bash
# Phase A の Child が以下を実行
zsh <skill-dir>/scripts/launch-workspace.sh \
  --cwd "$PWD" \
  --mode execute \
  --plan-file <PLAN_FILE_PATH> \
  --model claude-sonnet-4-6 \
  --skip-permissions \
  --status-dir "<EXISTING_STATUS_DIR>" \
  --layout <LAYOUT> \
  --parent-notify-workspace <PARENT_WORKSPACE_ID> \
  [--parent-notify-surface <PARENT_SURFACE_ID>] \
  [--split-from <SURFACE_ID> --parent-workspace <WS_ID>]  # split のみ
  <task-slug>-exec

# spawn 完了後、自身は移譲シグナルを書いて exit
touch "<EXISTING_STATUS_DIR>/.deferred"
```

codex の場合は `--model` / `--skip-permissions` の代わりに `--runner <codex-runner-name>` を使う（他は同じ形）。

孫セッションの runner wrapper が `status.json` を `done`/`error` に遷移させ、`cmux wait-for --signal <task-slug>-exec-done` を発火し、親に `[dispatch] task ... finished` を送る。Child は `--defer-status` 付きで起動されているため `.deferred` センチネルを検知して status 上書きをスキップする (これにより孫の通知が握り潰されない)。

### 前提条件

- codex オプションを使う場合、`runners.json` に `engine: "codex"` の runner を 1 件以上登録しておく必要がある (Step 1f の初回セットアップで追加可能)
- 加えて `cmux codex install-hooks` をマシンで一度実行しておく必要がある
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
- **message_type**: 通知トランスポートは config (`message_type`) で `send-message` (default) / `agmsg` を切替。agmsg モードでは monitor-dispatch.sh を起動しない (status.json は両モードで不変)。agmsg のインストール判定は `~/.agents/skills/agmsg/scripts/send.sh` の存在。
- **Pre-warm standby panes**: workspace レイアウト + config `prewarm: true` (default) のとき、`prewarm-panes.sh` が各タスク workspace 内に standby ペインを縦に積む (上: opus / 中: `<slug>-sonnet` / 下: `<slug>-codex` — codex runner 登録時のみ)。agmsg モードでは opus-1m ペインも idle 起動し (`--with-opus`)、worktree への delivery 配線 (join + `delivery.sh set`) をペイン起動前に行ったうえで、Phase A タスクは親から agmsg で送る。standby wrapper は `<STATUS_DIR>/.assigned` が存在するときだけ exit 時に status.json を遷移させる。signal 名は opus が `<slug>-done`、他は `<slug>-sonnet-done` / `<slug>-codex-done`。Phase B の実行指示は prewarm.json の `delivery` 値で分岐する: `"agmsg"` なら `send.sh`、`"cmux-send"` (send-message モード / 配線失敗時) なら `cmux send` + `send-key return`。
