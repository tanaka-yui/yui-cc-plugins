# cmux-team-dispatch-task

cmux ワークスペースを活用した並列タスクディスパッチプラグイン。
複数の独立したタスクを、それぞれ独自の git worktree + Claude Code セッションで同時実行する。

## 特徴

- **並列実行**: 2つ以上の独立タスクを同時にディスパッチ
- **git worktree 隔離**: 各タスクが独立したブランチ (`feat/<task-slug>`) で作業し、メインブランチを保護
- **Agent 自動発見**: `.claude/agents/` から利用可能なエージェントを動的にスキャンし、一覧を子セッションに伝達。各子セッションが自身のタスクに最適なエージェントを選択
- **brainstorming タスク選択**: タスクごとに superpowers モード（brainstorming + writing-plans）か plan モードかを選択可能
- **統合戦略の選択**: `PR per task`（各子タスクが push + `gh pr create`）または `Wait and merge`（全完了後に親でローカルマージ、デフォルト）
- **ステータス監視**: `.dispatch/` ディレクトリを介したファイルベースのステータス通信とシグナルによるリアルタイム進捗追跡
- **superpowers 連携**: Execution Handoff の第3選択肢「Parallel (cmux split)」として統合
- **プロンプトファイル経由**: シェルエスケープの問題を回避するため、プロンプトはファイル経由で子セッションに渡される

## レイアウトモード

| モード | 説明 | 推奨ケース |
|--------|------|-----------|
| **split** (デフォルト) | 現在の workspace 内でペイン分割（自動グリッド整列） | 2〜6個のタスク、全体を一望したい場合 |
| **workspace** | タスクごとに独立した cmux workspace を作成 | 長時間タスク、7個以上のタスク |
| **claude-teams** | `cmux claude-teams` で Agent Teams を使用 | ネイティブ通知、サイドバーメタデータ |

```
split mode:                  workspace mode:              claude-teams mode:
+----------+----------+     +----------+ +----------+    +----------+----------+
| Parent   | Child 1  |     | ws: t-1  | | ws: t-2  |   | Orchest. | Team-1   |
+----------+----------+     |          | |          |   +----------+----------+
| Child 2  | Child 3  |     +----------+ +----------+   | Team-2   | Team-3   |
+----------+----------+                                  +----------+----------+
(auto-grid)                  (separate tabs)              (native Agent Teams)
```

### Split モード（デフォルト）

同一 workspace 内でペインを分割。全タスク起動後、自動的にグリッドレイアウトに整列される。

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

### Workspace モード

各タスクが独立した cmux workspace（タブ）で実行される。

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

### Claude Teams モード

`cmux claude-teams` を使い、1つの orchestrator が Agent Teams で teammate を生成。

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

## 前提条件

- [cmux](https://github.com/anthropics/cmux) がインストール済み
- Claude Code が利用可能
- cmux セッション内で実行すること

## インストール

Claude Code のプラグインとしてインストール:

```bash
claude plugin add tanaka-yui/yui-cc-plugins/apps/cmux-team-dispatch-task
```

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

### 混合指定

```
/cmux-team-dispatch-task .claude/plans/notification.md, テストカバレッジを改善
```

プランファイルとインラインタスクを混在させることもできます。

## Agent 発見と委譲

`.claude/agents/` ディレクトリをスキャンし、各 `.md` ファイルの frontmatter（`name`, `description`）を読み取って利用可能な Agent 一覧を構築します。

この一覧は各子セッションのプロンプトに埋め込まれ、**各子セッションが自身のタスクに最適な Agent を選択**します。親セッションは Agent の割り当てを行いません。

`.claude/agents/` が空またはディレクトリが存在しない場合、Agent ブロックは省略されます。

## ステータスプロトコル

各子セッションが `.dispatch/<task-slug>/status.json` にステータスを書き出す:

| ステータス | 意味 |
|-----------|------|
| `launched` | セッション起動完了、Claude ロード中 |
| `planning` | 計画フェーズ中 |
| `executing` | 実装中 |
| `done` | 全作業完了 |
| `error` | エラー / 異常終了 |

完了時には `.dispatch/<task-slug>/result.md` に成果物サマリーが出力される。

`status.json` には以下の付加フィールドも含まれる:

- `pr_url`: PR per task 戦略で子セッションが PR を作成した場合、`done` 時に付与される
- `cleanup_preference`: 子セッションが `done` 時に書き込む `{ delete_worktree, close_surface }` の真偽値。親は per-task でこの意思に従ってワークスペース/ペインの閉鎖と worktree 削除を実行する（欠落時は親が対話確認）

## superpowers 統合

`superpowers:writing-plans` でプランが完成すると、Execution Handoff として実行方法の選択肢が提示される。本スキルは **第3選択肢「Parallel (cmux split)」** として統合:

| 選択肢 | 向いているケース |
|--------|-----------------|
| Subagent-Driven | タスク間に依存あり、レビュー重視、コスト節約 |
| Inline Execution | シンプルなプラン、対話的実行、単一セッション希望 |
| **Parallel (cmux)** | **独立タスク3個以上、速度重視、全セッションを画面で一望** |

## cmux-team との違い

| 観点 | cmux-team-dispatch-task | cmux-team |
|------|------------------------|-----------|
| アーキテクチャ | スキルのみ（軽量） | 4層 + daemon（フル機能） |
| 用途 | 独立タスクの並列実行 | 依存関係のあるチーム開発 |
| 永続プロセス | なし | Manager daemon |
| セットアップ | 不要 | `cmux-team start` が必要 |

## 制約事項

- **cmux 必須**: `/Applications/cmux.app/` にインストールされている必要があります
- **claude-teams モード**: `cmux claude-teams` コマンドが必要
- **同時セッション数**: 3〜5 セッションが推奨
- **split モード制限**: 2〜6 タスクが推奨。7 以上は workspace モードを使用。`--no-grid` でリニアレイアウトを維持可能
- **ファイル競合**: 2つのタスクが同じファイルを変更してはいけません。競合の可能性がある場合は順次実行にしてください
- **完了シグナルは信頼性あり**: ランナースクリプトが `status.json` の更新、`cmux wait-for --signal` の発火、`cmux send` による親ターミナルへの通知を保証。加えて `monitor-dispatch.sh` も個別タスク完了時に `[dispatch]` 通知を親に送信

## 詳細ガイド

詳細な利用方法・トラブルシューティングについては [リファレンスガイド](skills/cmux-team-dispatch-task/references/guide-ja.md) を参照してください。

## ライセンス

[MIT](LICENSE)
