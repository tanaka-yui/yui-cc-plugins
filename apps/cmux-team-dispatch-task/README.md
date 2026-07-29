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
| `agmsg` | `cmux send` + `send-key return`（wake）に加えて [agmsg](https://github.com/fujibee/agmsg) `send.sh` で inbox にも記録（dual-send） | 起動しない（沈黙時は status.json を手動確認） |

config は `~/.claude/cmux-team-dispatch-task/config.json`（`<project>/.dispatch/config.json` が優先）。
未設定で agmsg がインストール済みの場合、初回 dispatch 時に一度だけ質問し、回答を config に永続化する。
agmsg モードの team 名は `dispatch-<repo-name>`、親の agent 名は `parent`。
status.json / result.md / `cmux wait-for` signal は両モードで不変。

**agmsg push は inbox 記録専用で、idle セッションを起こせない**(watcher はバックグラウンド
Bash として動き、その stream 出力はプロセスが終了するまで注入されない)。このため指示・完了通知の
wake は常に `cmux send` + `send-key return` が担い、agmsg 配線が生きているときは同一文を
inbox にも記録する(dual-send)。agmsg モードの完了通知は2段構え: 子セッションが status.json
書き込み直後に自分で送る必須通知(send.sh + cmux send の両方)と、runner wrapper の exit 時通知
(バックストップ。同じく両チャネル)。idle のまま開いている TUI セッションは exit
しないため、wrapper だけに頼ると通知されない(このため子プロンプトに必須通知が埋め込まれる)。
また、ディスパッチを実行しているセッション自身は `delivery.sh set` が出力する
`AGMSG-DIRECTIVE:` に従って watcher を起動する(SessionStart hook は次回セッションから有効)。

config にはもう一つ `review_mode` フィールドがある（`"on"` / `"off"` / `"ask"`）。`"on"` / `"off"`
は Phase A-R（plan/spec クロスレビュー、後述）と Phase B-R（実装後コードレビュー、後述）を
質問なしで恒久的に有効/無効にする。未設定または
`"ask"` のときは、`review_model` 付き codex runner が存在するか、codex 設計タスクのクロスエンジン
レビュアーが解決済みの場合のみ **dispatch のたびに**レビューを
使うか質問される（はい[今回のみ] / いいえ[今回のみ] / 常に有効 / 常に無効 — 「常に〜」を選んだときだけ
config に永続化）。プロジェクト側 `.dispatch/config.json` がグローバル config より優先される点は
`message_type` と同じ。

同じ config には、毎回の選択を固定する `design_runner` と `exec_choice` も設定できます。
手動編集に加えて、`review_mode` と同様に**質問への回答から永続化**もできます（「常に〜」を
選んだときだけグローバル config に書き込み）。プロジェクトの `.dispatch/config.json` が
グローバル config より優先されます。

```json
{
  "design_runner": "claude",
  "exec_choice": "sonnet"
}
```

- `design_runner`: `runners[].name` を指定すると Step 1f の switch / per-task 質問を省略し、全タスクに適用します。
  **未設定**なら runner 2 件以上のときの switch 質問が 4 択（いいえ[今回のみ] / はい[今回のみ] /
  常に既定 runner / 常に固定 runner を選ぶ）になり、「常に〜」で永続化されます。
- `exec_choice`: `"opus 1m"` / `"sonnet"` / （codex runner 登録時のみ）`"codex"` を指定すると Phase B の質問を省略し、既存の同じ実行分岐へ直行します。
  **未設定**なら子セッションがモデル選択の直後に永続化確認（今回のみ / 常にこの選択 / 常に毎回選ぶ）を 1 問出し、「常に〜」で永続化されます。
- どちらも明示 `"ask"` なら従来どおり質問のみ（永続化オプションは出ません）。「常に〜」からの戻し方は 2 通りで意味が異なります: `"ask"` へ書き換えると質問のみ、キーを削除すると未設定に戻り永続化オプションが再表示されます。
- 不正値は project / global のレイヤーごとに検証され、不正なレイヤーだけ警告付きで無視してもう一方へフォールバックします（project の不正値が global に保存した「常に〜」を遮蔽しません）。

## モデル選択フロー (Phase A-R / Phase B / Phase B-R)

**クロスエンジンレビュー原則**: Phase A-R / Phase B-R のレビュアーは常に**実装者（または設計者）の
相手方 engine**。design=claude のタスクはレビューを codex が、design=codex のタスクはレビューを
claude が担う（詳細は下記 Phase A-R / Phase B-R 参照）。

### Phase A-R — plan/spec クロスレビュー（オプション）

`runners.json` の codex runner に `review_model`（例: `gpt-5.6-sol`）を設定し、config の
`review_mode` を `on` にすると、Phase A の成果物（plan/spec）を相手方 engine の専用ペインが
レビューする。approve が出るまで設計セッションが修正 → 再レビューを繰り返す（各ポイント最大 3 往復。
超過時はユーザーに「このまま進む / さらに修正」を確認）。

- plan モード: plan 完成後に 1 回 / superpowers モード: spec と plan で計 2 回
- 指摘と verdict は `.dispatch/<slug>/review/<point>-round-<N>.md`（末尾 `VERDICT:` 行）で受け渡し
- 使うかどうかは dispatch のたびに質問される（「常に有効/常に無効」を選べば以後は質問なし。
  毎回質問に戻すには config の `review_mode` を `"ask"` にするか削除する）
- 無効化はいつでも config の `review_mode: "off"` で可能（runners.json はそのまま残せる）

`runners.json` のスキーマ（レビュー / effort 関連フィールド抜粋。全フィールドは
[リファレンスガイド](skills/cmux-team-dispatch-task/references/guide-ja.md)の
「子セッション runner 設定（runners.json）」節を参照）:

```json
{
  "default": "claude",
  "runners": [
    { "name": "claude", "command": "claude", "engine": "claude", "review_model": "opus[1m]" },
    { "name": "codex",  "command": "codex",  "engine": "codex",  "review_model": "gpt-5.6-sol", "exec_model": "gpt-5.6-terra",
      "plan_effort": "xhigh", "review_effort": "xhigh", "exec_effort": "high" }
  ]
}
```

| フィールド | 意味 |
|----------|------|
| `runners[].review_model` | レビューペインに渡すモデル名。`engine: codex` runner: design=claude タスクのレビューペイン用（未設定ならそのタスクのレビューは無効）。`engine: claude` runner: design=codex タスクのレビュアーに選ばれたときのモデル（未設定なら `opus[1m]`） |
| `runners[].exec_model` | （`engine: codex` の runner のみ）Phase B 実行系（execute / standby ペイン）で `--model` 未指定時にフォールバック適用。review ペインには適用されない。未設定なら codex 側デフォルト（`~/.codex/config.toml`） |
| `runners[].plan_effort` / `review_effort` / `exec_effort` | （`engine: codex` の runner のみ。値: `minimal`\|`low`\|`medium`\|`high`\|`xhigh`）codex セッションの reasoning effort。それぞれ設計（plan/superpowers）/ レビュー / 実行（execute/standby）に `-c model_reasoning_effort='<値>'` として注入される。優先順位: **明示 `--effort` > runner フィールド > 無指定**（`~/.codex/config.toml` の既定） |

agmsg モードでの指示配送（Phase A タスク / Phase B 実行指示 / Phase A-R レビュー依頼 / Phase B-R コードレビュー依頼）は
**常に `cmux send`（ペインへの直接タイプ）+ `send-key return` で行う** — agmsg push 単独では
idle なペインは起きないため、push は配送手段ではなく inbox 記録である。送信直前に宛先ペインの
watcher 生存（agmsg の ready sentinel）を確認し、生きているときだけ同一指示文を `send.sh` で
inbox にも記録する。配線に失敗したペインの初期プロンプトは「指示は直接タイプされる」文面に
切り替わるため、agmsg の watcher 障害でディスパッチがハングすることはない。

各子セッションは Phase A (計画 / brainstorming) 完了後、`exec_choice` が未設定または `"ask"` なら**実装フェーズで使うモデル**を `AskUserQuestion` で聞きます。固定値なら質問を省略し、同じ既存分岐を実行します。Phase A は**設計 runner の engine**（`opus` または codex）で動作し、選んだ model がその engine と同一かどうかで動作が分岐します。下表は **design=claude**（Phase A を opus が担当する現行どおりのタスク）の挙動です。

| 選択肢 | 表示条件 | 動作 |
|--------|---------|------|
| **opus 1m** | 常時 | Phase A と **同一 model**。`/model opus[1m]` で切替後、**現セッションで実装続行** |
| **sonnet** | 常時 | **異なる model**。`launch-workspace.sh --mode execute` で子 surface を spawn し、`claude --model sonnet --dangerously-skip-permissions 'Read and execute the plan at <path>'` を runner script でラップして起動 |
| **codex** | `~/.claude/cmux-team-dispatch-task/runners.json` に `engine: codex` runner がある時のみ | **異なる model**。`launch-workspace.sh --mode execute --runner <codex-runner>` で spawn し、codex を `--dangerously-bypass-approvals-and-sandbox` 付きで起動。runner に `exec_model`（例: `gpt-5.6-terra`）があれば `--model` として適用（レビューペインの `review_model` とは独立）。`external_migration` により親 claude セッションを引き継ぐ |

Codex の起動方針は mode ごとに分離されています。`superpowers` / `plan` / `execute` / `standby` は
approval prompt を防ぐため bypass を使います。一方で review ペインは sandbox を完全 off にせず、
`--sandbox workspace-write`、`-c approval_policy='never'`、`--add-dir <STATUS_DIR>` を併用します。
これにより approval prompt を出さず、worktree 外の `.dispatch/<slug>/review/` への findings 書込みだけを
許可します。

「異なる model」が選ばれた場合の挙動:

- Child セッションが `launch-workspace.sh --mode execute --plan-file <path> [--model <X>] [--skip-permissions]` を呼び、新 surface (workspace or split) で実装を開始
- 新 surface (孫セッション) は runner script でラップされ、完了時に `status.json` を `done`/`error` に遷移させ、親に `[dispatch] task ... finished` を送信
- 孫の inner prompt 末尾には自動で「PR 作成後 `/exit` でセッションを閉じる」指示が付与される。これが無いと孫 Claude/Codex が PR 作成後も TUI で idle 待機してしまい、runner wrapper の完了処理に到達できず status.json が `executing` 固定になる
- Runner script ファイル名は workspace 名を含む (`.cmux-team-dispatch-task-run-<workspace-name>.sh`)。Child と Phase B 孫が同じ worktree を共有しても runner ファイル同士が衝突しない
- Child は spawn 完了後 `<STATUS_DIR>/.deferred` を作成して exit する (Child の runner wrapper は `--defer-status` で起動されており、`.deferred` を検知すると status 上書きをスキップして孫の通知を握り潰さない)。**Phase B-R 有効時は exit せず**、コードレビュアーとして idle 待機し、approve を書いた後に exit する
- sonnet では Claude Code の auto mode (`bypassPermissions`) が効かないため、`--dangerously-skip-permissions` を付けて permission prompt によるハングを防いでいる

codex オプションを使う場合は事前に `cmux codex install-hooks` の実行が必要です。

#### design=codex のタスク

設計 runner が `engine: codex` のタスクでは Phase A をその codex セッション自身が担う
（`--effort <plan_effort>` の reasoning effort で起動済み。セッション途中でモデルは切り替えない）。
Phase B の 3 択（**opus 1m / sonnet / codex**）は**すべて pre-warm ペインへ委譲**し、この codex
セッション自身は実装しない。opus 1m を選んだ場合は下記レイアウトの右上ペイン（`<slug>-opus`、
Phase A-R レビュアーと実装先の二役）が実装する。prewarm.json が無い（prewarm off / split）場合は
`launch-workspace.sh --mode execute` へフォールバックする。

### Phase B-R — 実装後コードレビュー（オプション）

`review_mode` が `on` のとき（Phase A-R と同一条件）、実装完了後・**PR 作成前**に
コードレビューを挟む。approve が出るまで実装者が修正 → 再依頼を繰り返すため、PR は常に
レビュー済みになる。

- レビュアーは**常に実装者の相手方 engine**（クロスエンジン原則）。物理配置は「実装者 engine ==
  設計 engine ならレビューペインがレビュー」「実装者 engine != 設計 engine なら設計セッション
  自身がレビュー」で決まる。設計 engine × Phase B 選択の 6 ケース:

  | 設計 engine | Phase B 選択 | 実装者 | レビュアー |
  |------------|-------------|-------|-----------|
  | claude | opus 1m | 現セッション（opus, in-session） | codex レビューペイン |
  | claude | sonnet | sonnet standby | codex レビューペイン |
  | claude | codex | codex standby | 現セッション（設計 claude） |
  | codex | opus 1m | claude review ペイン（`<slug>-opus`） | 現セッション（設計 codex） |
  | codex | sonnet | sonnet standby | 現セッション（設計 codex） |
  | codex | codex | codex standby | claude review ペイン |

  > design=claude + sonnet 実装のレビュアーは旧仕様では設計 opus ペインが担っていたが、
  > クロスエンジン原則により現行は **codex レビューペイン**が担う。

- 指摘と verdict は `.dispatch/<slug>/review/code-round-<N>.md`（末尾 `VERDICT:` 行）で受け渡し。
  最大 3 往復・verdict 待ちは 5 秒間隔ポーリング + 15 分ごとのレビュアー pane 生存確認
  （`cmux read-screen` の画面差分）。レビュアーが活動している限り上限なしで待機し、
  無反応（stalled）のときのみ再依頼 1 回 → フォールバック — Phase A-R と同一プロトコル
- 3 往復で approve が出ない場合、claude 実装者は AskUserQuestion（このまま PR 作成 / さらに修正）、
  codex 実装者は未解決指摘を PR 本文に注記して続行
- prewarm 無効 / split レイアウトでは `launch-workspace.sh --mode execute --review-config <path>`
  が孫の prompt にレビュープロトコルを注入する

### plan モードの Phase A-R / B 遵守ゲート

標準 plan モードでは ExitPlanMode 承認直後に子セッションがそのまま実装へ進み、Phase A-R /
Phase B がスキップされることがあります。対策として `launch-workspace.sh` が plan モード +
claude engine の worktree（claude-teams レイアウトは hook 注入対象外）に `.claude/settings.local.json`（ExitPlanMode の PostToolUse
hook、`scripts/plan-approved-hook.sh` を呼ぶ）を注入し、承認直後に「ファイル編集前に
Phase A-R（有効時）→ Phase B を実行せよ」という指示を機械的に再注入します。あわせて子への
プロンプトで、plan 冒頭に Phase A-R / B を必須ステップとして記載させます。hook はベスト
エフォートで、書き込みに失敗しても dispatch は止まりません。`.claude/settings.local.json`
と plan 保存先 `.claude/plans/` は repo 共有の `info/exclude` に追記され、タスクブランチに
コミットされません。hook は worktree に残存するため同一 worktree を再利用する後続セッション
（Phase B の execute 孫を含む）にも作用しますが、それらは plan モードを使わないため実害は
ありません。

### Pre-warm standby panes(workspace レイアウト時)

config `prewarm: true`(default)のとき、`prewarm-panes.sh` が各タスクの workspace 内に
standby ペインを事前起動する。Phase B で sonnet / codex が選ばれたら待機中のペインに
実行指示を送るだけで済み、セッション起動を待たない。

standby ペインの配置は Phase A-R の有効/無効で分岐する:

- **Phase A-R 無効**（現行どおり）: 縦積み — 上: opus / 中: sonnet / 下: codex（codex は
  `engine: "codex"` runner 登録時のみ）
- **Phase A-R 有効**: 2×2 均等グリッド。レビューペインは常に**設計 engine の逆**:
  - **design=claude**（現行）: 左上 opus / 右上 codex レビューペイン（idle、
    `--model <review_model>`）/ 左下 sonnet / 右下 codex
  - **design=codex**: 左上 design codex（idle、`--effort <plan_effort>`）/ 右上 claude
    レビューペイン（idle、reviewer runner + `--model <CLAUDE_REVIEW_MODEL>` +
    `--skip-permissions`、agent `<slug>-opus` — Phase A-R レビュアーと Phase B opus 1m
    実装先の二役）/ 左下 sonnet / 右下 codex（`exec_model` / `exec_effort`）

  どちらもレビューペインは standby wrapper の status.json 所有権を持たずに起動する
  （design=codex の右上ペインのみ、Phase B で opus 1m が選ばれたときに実装者として
  status.json の所有権を持つ）

**ペインは常時 4 枚を維持する**: Phase B で実装モデルを選んでも未使用の standby ペインは閉じず、
レビューも approve 後に閉じない。全ペインは idle のまま残り（未 assigned の standby は status.json を
汚さない）、最終の全タスク完了クリーンアップ（「Close all child panes?」）でまとめて閉じる。

- send-message モード: opus は従来どおりタスクプロンプト付きで起動し、sonnet / codex のみ
  idle 起動。実行指示は `cmux send` で注入する。
- agmsg モード: opus-1m を含む全ペインをメッセージ未指定(idle)で起動する。
  `prewarm-panes.sh` が worktree への agmsg delivery 配線(join + `delivery.sh set`)を
  ペイン起動前に行い、Phase A の初期タスクも Phase B の実行指示も dual-send で配送する
  (常に `cmux send` + `send-key return`。prewarm.json の `delivery` 値が `"agmsg"` かつ
  watcher 生存時は加えて `send.sh` で inbox にも記録)。

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

## 制約事項

- **cmux 必須**: `/Applications/cmux.app/` にインストールされている必要があります
- **claude-teams モード**: `cmux claude-teams` コマンドが必要
- **同時セッション数**: 3〜5 セッションが推奨
- **split モード制限**: 2〜6 タスクが推奨。7 以上は workspace モードを使用。`--no-grid` でリニアレイアウトを維持可能
- **ファイル競合**: 2つのタスクが同じファイルを変更してはいけません。競合の可能性がある場合は順次実行にしてください
- **完了シグナルは信頼性あり**: ランナースクリプトが `status.json` の更新、`cmux wait-for --signal` の発火、`cmux send` による親ターミナルへの通知を保証。加えて `monitor-dispatch.sh` も個別タスク完了時に `[dispatch]` 通知を親に送信
- **pane を閉じても誤通知しない**: 最終クリーンアップの `cmux close-surface` / `close-workspace` で子プロセスは signal 終了（終了コード 128+N）する。`status.json` が既に `done` / `error` なら wrapper は status 書き込みと親通知の両方をスキップするため、完了済みタスクが `error` に降格したり偽の `[dispatch] ... (status: error)` が飛んだりしない。まだ `executing` の pane を kill した場合は本当の中断なので従来どおり `error` を報告する

## 詳細ガイド

詳細な利用方法・トラブルシューティングについては [リファレンスガイド](skills/cmux-team-dispatch-task/references/guide-ja.md) を参照してください。

## ライセンス

[MIT](LICENSE)
# GitHub issue 自動ループ

`--loop` を指定すると、GitHub issue を claim してバッチ単位で処理する。詳細は skill の `references/loop-mode.md` を参照する。ループ中は `.dispatch-loop/` のロックにより通常 dispatch を保護する。Codex runner は hook trust 確認を無人で通すため `--dangerously-bypass-hook-trust` を使用する。

## Phase B-R 有効時の完了通知について

Phase B-R（実装後コードレビュー）を有効にすると、実装ペインへ送る指示文が拡張版に差し替わります。
この拡張版には **engine 別の終了指示**（codex は `/exit` ではなくセッション自体を終了）と
**親への完了通知**（agmsg + `cmux send` + `send-key return`）の両方が含まれます。

実装ペインは指示文しか読んでいないため、この 2 つが指示文の中に無いと、実装が完了しても
セッションが終了せず、親に通知が届きません。カスタマイズする場合はこの 2 点を落とさないでください。

完了通知は status.json の終端遷移で発火します。runner wrapper は子セッションと並行して
status.json watcher を走らせており、子が `done` / `error` を書けばセッションが終了しなくても
親へ通知を試みます（15 秒間隔。`CMUX_DISPATCH_WATCH_INTERVAL` で変更可）。子が書いた終端
status は sticky で、`done` の後に非ゼロ終了したときだけ保守的に `error` へ訂正します。通知済み
marker は成功した status 文字列を保持し、親通知と reviewer wake は別に管理します。

watcher は timeout sentinel、`.deferred`、未 assigned standby、他 pane の `.assigned-*` を
所有権の抑止条件として poll ごとに再評価します。停止時は ABORT/ESCALATION（findings 記録、
reviewer wake、error status、親通知、セッション終了）の 5 手順を実行してください。workspace レイアウトの Child 起動にも `--defer-status` を渡す。これが無いと、Phase B で実行を別 surface へ移譲した Child の wrapper が、孫の書いた終端状態を上書きしてしまいます。

ただし子が status.json を書かないまま沈黙した場合は検知できません。既知の配信上の限界と通知
欠落パターンは [`docs/notification-gaps.md`](docs/notification-gaps.md) にまとめています。
