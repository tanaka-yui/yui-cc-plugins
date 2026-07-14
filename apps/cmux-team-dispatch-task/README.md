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
- **ターミナル起動待機の自動学習**: 子セッションのシェル初期化時間を計測して `~/.claude/cmux-team-dispatch-task/config.json` に EMA で永続化し、次回以降の最大待機時間を適応的に決定（`sh: command not found` を防止）。詳細は [guide-ja.md](skills/cmux-team-dispatch-task/references/guide-ja.md#ターミナル起動待機の自動学習)

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

クリーンアップ意思は `status.json` には記録されない。親セッションがディスパッチ完了時に
`AskUserQuestion` で「ワークスペース閉鎖 / worktree 削除 / ブランチ削除」の 3 問をまとめて聞き、
回答を全タスクに適用する。子セッションは質問も削除も行わない（子が自分の worktree を掴んだまま
親が削除を試みて失敗するのを防ぐため）。

## メッセージトランスポート（message_type）

子 → 親の完了通知は config の `message_type` で切り替えられる:

| 値 | 通知手段 | monitor ループ |
|----|---------|---------------|
| `send-message`（default） | `cmux send` + `cmux send-key return` | `monitor-dispatch.sh` を起動（heartbeat / 死活監視） |
| `agmsg` | [agmsg](https://github.com/fujibee/agmsg) `send.sh`（リアルタイム push） | 起動しない（沈黙時は status.json を手動確認） |

config は `~/.claude/cmux-team-dispatch-task/config.json`（`<project>/.dispatch/config.json` が優先）。
未設定で agmsg がインストール済みの場合、初回 dispatch 時に一度だけ質問し、回答を config に永続化する。
agmsg モードの team 名は `dispatch-<repo-name>`、親の agent 名は `parent`。
status.json / result.md / `cmux wait-for` signal は両モードで不変。

agmsg モードの完了通知は2段構え: 子セッションが status.json 書き込み直後に自分で送る必須 push と、
runner wrapper の exit 時 push(バックストップ)。idle のまま開いている TUI セッションは exit
しないため、wrapper だけに頼ると通知されない(このため子プロンプトに必須 push が埋め込まれる)。
また、ディスパッチを実行しているセッション自身は `delivery.sh set` が出力する
`AGMSG-DIRECTIVE:` に従って watcher を起動する(SessionStart hook は次回セッションから有効)。

## モデル選択フロー (Phase B)

各子セッションは Phase A (計画 / brainstorming) 完了後、**実装フェーズで使うモデル**を `AskUserQuestion` で必ず聞きます。Phase A は常に opus で動作するため、選んだ model が opus と同一かどうかで動作が分岐します。

| 選択肢 | 表示条件 | 動作 |
|--------|---------|------|
| **opus 1m** | 常時 | Phase A と **同一 model**。`/model claude-opus-4-7[1m]` で切替後、**現セッションで実装続行** |
| **sonnet** | 常時 | **異なる model**。`launch-workspace.sh --mode execute` で子 surface を spawn し、`claude --model claude-sonnet-4-6 --dangerously-skip-permissions 'Read and execute the plan at <path>'` を runner script でラップして起動 |
| **codex** | `~/.claude/cmux-team-dispatch-task/runners.json` に `engine: codex` runner がある時のみ | **異なる model**。`launch-workspace.sh --mode execute --runner <codex-runner>` で spawn し、codex を `--dangerously-bypass-approvals-and-sandbox` 付きで起動。`external_migration` により親 claude セッションを引き継ぐ |

「異なる model」が選ばれた場合の挙動:

- Child セッションが `launch-workspace.sh --mode execute --plan-file <path> [--model <X>] [--skip-permissions]` を呼び、新 surface (workspace or split) で実装を開始
- 新 surface (孫セッション) は runner script でラップされ、完了時に `status.json` を `done`/`error` に遷移させ、親に `[dispatch] task ... finished` を送信
- 孫の inner prompt 末尾には自動で「PR 作成後 `/exit` でセッションを閉じる」指示が付与される。これが無いと孫 Claude/Codex が PR 作成後も TUI で idle 待機してしまい、runner wrapper の完了処理に到達できず status.json が `executing` 固定になる
- Runner script ファイル名は workspace 名を含む (`.cmux-team-dispatch-task-run-<workspace-name>.sh`)。Child と Phase B 孫が同じ worktree を共有しても runner ファイル同士が衝突しない
- Child は spawn 完了後 `<STATUS_DIR>/.deferred` を作成して exit する (Child の runner wrapper は `--defer-status` で起動されており、`.deferred` を検知すると status 上書きをスキップして孫の通知を握り潰さない)
- sonnet では Claude Code の auto mode (`bypassPermissions`) が効かないため、`--dangerously-skip-permissions` を付けて permission prompt によるハングを防いでいる

codex オプションを使う場合は事前に `cmux codex install-hooks` の実行が必要です。

### Pre-warm standby panes(workspace レイアウト時)

config `prewarm: true`(default)のとき、`prewarm-panes.sh` が各タスクの workspace 内に
standby ペインを縦に積んで事前起動する(上: opus / 中: sonnet / 下: codex — codex は
`runners.json` に codex runner があるときのみ)。Phase B で sonnet / codex が選ばれたら
待機中のペインに実行指示を送るだけで済み、セッション起動を待たない。

- send-message モード: opus は従来どおりタスクプロンプト付きで起動し、sonnet / codex のみ
  idle 起動。実行指示は `cmux send` で注入する。
- agmsg モード: opus-1m を含む全ペインをメッセージ未指定(idle)で起動する。
  `prewarm-panes.sh` が worktree への agmsg delivery 配線(join + `delivery.sh set`)を
  ペイン起動前に行い、Phase A の初期タスクも Phase B の実行指示も agmsg で配送する
  (配線に失敗したペインは `cmux send` にフォールバック。prewarm.json の `delivery` 値で分岐)。

split / claude-teams レイアウトや `prewarm: false` では従来の on-demand spawn。

## アカウント切り替えとセッション共有 (claude-link.sh)

`runners.json` で複数の Claude アカウント (`CLAUDE_CONFIG_DIR`) を切り替えて子セッションを起動する運用を想定し、**認証 (`.claude.json`) は各アカウントに分離したまま、skills / plugins / sessions / history を `~/.claude` から共有する** ためのセットアップユーティリティ `scripts/claude-link.sh` を同梱しています。

たとえば runner ごとに別アカウント（例: 個人 / 業務 / codex 専用）を切り替えると、デフォルトでは新アカウント側で `projects/` `sessions/` `history.jsonl` が空となり過去の会話を resume できません。`claude-link.sh` は対象リソースを symlink で `~/.claude` に張ることでこれを解消します。

### 共有 / 分離されるリソース

| 区分 | 対象 |
|------|------|
| **共有** (symlink) | `skills/` `plugins/` `commands/` `agents/` `CLAUDE.md` `settings.json` `config/` `keybindings.json` `projects/` `sessions/` `todos/` `history.jsonl` `tasks/` |
| **分離** (アカウント私有) | `.claude.json` (認証) / `.claude.json.backup` / `settings.local.json` / `backups/` / `cache/` / `shell-snapshots/` / `session-env/` / `paste-cache/` / `mcp-needs-auth-cache*.json` / `policy-limits.json` / `statistics/` / `file-history/` / `debug/` / `ide/` |

### 使い方

```bash
# 1. dry-run で挙動を確認
bash apps/cmux-team-dispatch-task/scripts/claude-link.sh myaccount --dry-run

# 2. 実行（既存ファイルは ~/.claude-config/myaccount/.pre-link-backup-<TS>/ にバックアップされてから symlink に置換される）
bash apps/cmux-team-dispatch-task/scripts/claude-link.sh myaccount

# オプション
#   --base-dir DIR    アカウント config 親ディレクトリ（デフォルト: ~/.claude-config）
#   --source DIR      共有元（デフォルト: ~/.claude の realpath）
#   --dry-run         変更なしでプランのみ表示
```

実行後、スクリプトが標準エラーに `cc<short>()` シェル関数を出力します。これを `~/.zshrc` に貼り付けると、アカウント切替コマンドとして利用できます:

```zsh
ccmyaccount() {
  unset ANTHROPIC_API_KEY
  unset ANTHROPIC_BASE_URL
  export CLAUDE_CONFIG_DIR=~/.claude-config/myaccount
  ~/.local/bin/claude "$@"
}
```

### `runners.json` との連携

`~/.claude/cmux-team-dispatch-task/runners.json` の runner `command` に上記関数を組み込めば、その runner で起動する子セッションは別認証で動きつつ、履歴・skills・plugins を共有できます:

```json
{
  "default": "claude-default",
  "runners": [
    { "name": "claude-default", "command": "claude", "engine": "claude" },
    { "name": "claude-myaccount", "command": "ccmyaccount", "engine": "claude" }
  ]
}
```

子セッションの起動コマンドは常に `zsh -ic "..."` でラップされるため、`.zshrc` で定義した関数がそのまま使えます。

### ロールバック

リンク化を取り消したい場合は、対象アカウントディレクトリに作られたバックアップから手動で復元します:

```bash
cd ~/.claude-config/<account>
rm skills plugins commands agents CLAUDE.md settings.json config keybindings.json \
   projects sessions todos history.jsonl tasks 2>/dev/null
mv .pre-link-backup-<TS>/* .
rmdir .pre-link-backup-<TS>
```

### 注意点

- 既存ファイル / ディレクトリは `~/.claude-config/<account>/.pre-link-backup-<TS>/` にバックアップされてから symlink に置換されます
- 認証情報 (`.claude.json`) は **絶対に共有されません**。各アカウントで個別にログインしてください
- macOS の BSD `readlink` には `-f` が無いため、スクリプトは `python3` で realpath を解決します（macOS / Linux 共通動作）
- `--dry-run` を付ければ実行前にプランを確認できます

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
