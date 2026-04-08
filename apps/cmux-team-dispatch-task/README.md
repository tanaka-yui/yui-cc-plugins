# cmux-team-dispatch-task

cmux ワークスペースを活用した並列タスクディスパッチプラグイン。
複数の独立したタスクを、それぞれ独自の git worktree + Claude Code セッションで同時実行する。

## 特徴

- **並列実行**: 2つ以上の独立タスクを同時にディスパッチ
- **git worktree 隔離**: 各タスクが独立したブランチ (`feat/<task-slug>`) で作業し、メインブランチを保護
- **Agent ルーティング**: `.claude/agents/` から利用可能なエージェントを動的にスキャンし、タスクに最適なエージェントを自動割り当て
- **ステータス監視**: `.dispatch/` ディレクトリを介したファイルベースのステータス通信とシグナルによるリアルタイム進捗追跡
- **superpowers 連携**: Execution Handoff の第3選択肢「Parallel (cmux split)」として統合
- **プロンプトファイル経由**: シェルエスケープの問題を回避するため、プロンプトはファイル経由で子セッションに渡される

## レイアウトモード

| モード | 説明 | 推奨ケース |
|--------|------|-----------|
| **workspace** | タスクごとに独立した cmux workspace を作成 | 長時間タスク、5個以上のタスク、画面スペースが必要な作業 |
| **split** | 現在の workspace 内でペイン分割（自動グリッド整列） | 短時間タスク、2〜6個のタスク、全体を一望したい場合 |

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
│           │ │           │ │           │
│ worktree: │ │ worktree: │ │ worktree: │
│ feat/     │ │ feat/     │ │ feat/     │
│ task-1    │ │ task-2    │ │ task-3    │
└──────────┘ └──────────┘ └──────────┘
```

### Split モード

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
/cmux-team-dispatch-task .claude/plans/notification.md, テストカバレッジを改善 [backend]
```

プランファイルとインラインタスクを混在可能。`[frontend]`, `[backend]` 等のタグで Agent を明示的に指定できます。

## Agent ルーティング

`.claude/agents/` ディレクトリをスキャンし、各 `.md` ファイルの frontmatter（`name`, `description`）を読み取って自動マッチング。

**ルーティング優先順位:**

1. **明示的タグ**: `[frontend]`, `[backend]` 等がタスクに含まれていれば、そのまま使用
2. **キーワードマッチング**: タスクの説明文と Agent の `description` を照合
3. **汎用**: マッチしない場合は Agent ヒントなし（汎用モード）

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

- **cmux 必須**: cmux がインストールされている必要があります
- **同時セッション数**: 通常 3〜5 セッションが推奨
- **split モード制限**: 2〜6 タスクが推奨。7 以上は workspace モードを使用してください
- **ファイル競合**: 2つのタスクが同じファイルを変更してはいけません。競合の可能性がある場合は順次実行にしてください

## 詳細ガイド

詳細な利用方法・トラブルシューティングについては [リファレンスガイド](skills/cmux-team-dispatch-task/references/guide-ja.md) を参照してください。

## ライセンス

[MIT](LICENSE)
