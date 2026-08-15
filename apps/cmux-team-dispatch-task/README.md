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
- **superpowers 連携**: Execution Handoff の第3選択肢「Parallel (cmux)」として統合
- **プロンプトファイル経由**: シェルエスケープの問題を回避するため、プロンプトはファイル経由で子セッションに渡される
- **ターミナル起動待機の自動学習**: 子セッションのシェル初期化時間を計測して `~/.claude/cmux-team-dispatch-task/config.json` に EMA で永続化し、次回以降の最大待機時間を適応的に決定（`sh: command not found` を防止）。詳細は [guide-ja.md](skills/cmux-team-dispatch-task/references/guide-ja.md#ターミナル起動待機の自動学習)

## レイアウト

レイアウトは常に `workspace`。各タスクは独立した cmux workspace（タブ）で実行される。

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

> **破壊的変更 (v1.13.0)**: `--layout split` と `--layout claude-teams` を削除しました。
> レイアウトは常に `workspace` です。あわせて split 専用の
> `launch-session-splits.sh` と `cmux-grid.sh` も削除しています。
> pre-warm は1ワークスペース内に解決済み role のペインだけを配置します。

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

### permission prompt の抑止

claude engine の子セッションを起動するとき、`launch-workspace.sh` は MODE を問わず
worktree の `.claude/settings.local.json` に次をマージする。

```json
{ "permissions": { "defaultMode": "bypassPermissions" } }
```

これにより通常（非 loop）ディスパッチでも permission prompt が出ない。`AskUserQuestion`
（ブレストの対話、Phase B のモデル選択、レビュー 5 往復後の判断）は permission gate とは
別レイヤーの対話 UI なので、対話的なまま残る。

**前提**: bypass モード突入時の確認ダイアログは `--dangerously-skip-permissions` でも
`defaultMode` でも表示される。これを抑止する `skipDangerousModePermissionPrompt` は
project settings では無視されるため、**ユーザー設定 `~/.claude/settings.json`** に
`"skipDangerousModePermissionPrompt": true` を置くこと。

注入先は最優先スコープの `settings.local.json` なので、リポジトリ側の
`.claude/settings.json` で `defaultMode` を別の値に上書きすることはできない。これは
意図した挙動で、opt-out 用の config キーは用意していない。

codex engine は対象外（`--dangerously-bypass-approvals-and-sandbox` と
レビューペインの `--sandbox workspace-write` で既に prompt が出ない）。

## ステータスプロトコル

各子セッションが `.dispatch/<task-slug>/status.json` にステータスを書き出す:

| ステータス | 意味 |
|-----------|------|
| `launched` | runner セッション起動完了、ロード中 |
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

## メッセージ配送（send-prompt.sh）

**通知トランスポートの設定項目は無い。** `message_type` は v1.16.0 で廃止され、
`launch-workspace.sh` / `prewarm-panes.sh` の `--message-type` フラグも削除された（渡すと
`was removed` を含むメッセージで die する）。[agmsg](https://github.com/fujibee/agmsg) は
`~/.agents/skills/agmsg/scripts/send.sh` が存在すれば自動で配線され、質問も永続化も行わない。

| agmsg | 通知手段 | monitor ループ |
|-------|---------|---------------|
| 未インストール | `send-prompt.sh`（タイプ入力のみ） | `monitor-dispatch.sh` を起動（heartbeat / 死活監視） |
| インストール済み | `send-prompt.sh`（タイプ入力 + watcher 生存時は inbox にも記録） | 起動しない（沈黙時は status.json を手動確認） |

agmsg 配線時の team 名は `dispatch-<repo-name>`、親の agent 名は `parent`。
status.json / result.md / `cmux wait-for` signal は agmsg の有無によらず不変。

配送はすべて `skills/cmux-team-dispatch-task/scripts/send-prompt.sh` の 1 回呼び出しに
一本化されている。このスクリプトは:

1. **必ず宛先ペインへタイプ入力する**。idle セッションを起こせるのはタイプ入力だけ
2. `--agmsg-team` / `--agmsg-to` / `--agmsg-from` が揃い、かつ宛先の ready sentinel
   （`~/.agents/skills/agmsg/run/ready.<team>__<agent>`）が存在するときは、**タイプ入力を
   終えたあとに** 同一本文を agmsg inbox にも記録する。agmsg の失敗は配送の成否にも終了コードにも
   影響しない。順序が固定なのは、`send.sh` が共有 SQLite DB への書き込みで固まっても、唯一の
   wake 手段であるタイプ入力を塞がせないため（macOS には `timeout` / `gtimeout` が無く強制打ち切り
   できない）。記録は単なるログで、受信側にも重複を無視させている
3. 400 文字を超える本文は `<outbox-dir>/<label>-<seq>.md` へ書き出し、1 行のポインタだけを
   タイプする。長文が Claude Code TUI に貼り付け判定され、直後の Enter がデバウンスに
   吸われて入力欄に残る事故を止めているのがこれ
4. タイプ後に Enter を押し、`cmux read-screen` で入力欄が空になったことを確認する。残っていれば
   最大 3 回まで Enter を再送してから失敗を報告する。この確認は**宛先が 0 桁目に `❯`（または `>`）
   のプロンプト行を描画している場合に働く**（その最終行を入力欄とみなす仕組みのため）。該当行が
   見つからないペインは、画面を観測できない場合と同様に検証なしで配送済みとして扱う（呼び出し元が
   再送して二重配送するのを防ぐため）

**agmsg push は inbox 記録専用で、idle セッションを起こせない**（watcher はバックグラウンド
Bash として動き、その stream 出力はプロセスが終了するまで注入されない）。ready sentinel が
示すのは **watcher プロセスの生存だけ**で、そのセッションを起こせることは示さない — idle
セッションへ注入できる仕組みの下でも、注入できない素のバックグラウンドシェルの下でも、
同じ sentinel が書かれるためである（検証結果は
`docs/superpowers/specs/2026-08-12-delivery-verification-results.md`）。

agmsg 配線時の完了通知は2段構え: 子セッションが status.json
書き込み直後に自分で送る必須通知と、runner wrapper の exit 時通知（バックストップ）。
idle のまま開いている TUI セッションは exit
しないため、wrapper だけに頼ると通知されない（このため子プロンプトに必須通知が埋め込まれる）。
また、ディスパッチを実行しているセッション自身は `delivery.sh set` が出力する
`AGMSG-DIRECTIVE:` に従って watcher を起動する（SessionStart hook は次回セッションから有効）。

config の `review_mode`（`"on"` / `"off"` / `"ask"`）は Phase A-R（plan/spec レビュー、後述）と
Phase B-R（実装後コードレビュー、後述）を質問なしで恒久的に有効/無効にする。未設定または
`"ask"` のときは、レビュー可能な runner が解決済みの場合のみ **dispatch のたびに**レビューを
使うか質問される（はい[今回のみ] / いいえ[今回のみ] / 常に有効 / 常に無効 — 「常に〜」を選んだときだけ
config に永続化）。プロジェクト側 `.dispatch/config.json` がグローバル config より優先される。

同じ config には、役割を独立して固定する `design_runner` / `review_runner` / `exec_choice` も設定できます。
手動編集に加えて、`review_mode` と同様に**質問への回答から永続化**もできます（「常に〜」を
選んだときだけグローバル config に書き込み）。プロジェクトの `.dispatch/config.json` が
グローバル config より優先されます。

```json
{
  "design_runner": "codex",
  "review_runner": "codex",
  "exec_choice": "codex",
  "review_mode": "on",
  "prewarm": true
}
```

- `design_runner`: `runners[].name` を指定すると Step 1f の switch / per-task 質問を省略し、全タスクに適用します。
  **未設定**なら runner 2 件以上のときの switch 質問が 4 択（いいえ[今回のみ] / はい[今回のみ] /
  常に既定 runner / 常に固定 runner を選ぶ）になり、「常に〜」で永続化されます。
- `review_runner`: project → global の順で解決します。runner 名は Phase A-R/B-R の固定レビュアー、
  `"ask"` は dispatch ごとの選択です。両方の key が未設定なら従来のクロスエンジン自動解決を使います。
  project/global の不正値はそのレイヤーだけ無効化して次へ進みます。codex 候補には空でない
  `review_model` が必要で、claude 候補は未設定時に `opus[1m]` へフォールバックします。同じ engine、
  同じ runner を design/review に指定しても有効です。
- `exec_choice`: `"opus 1m"` / `"sonnet"` / （codex runner 登録時のみ）`"codex"` を指定すると Phase B の質問を省略し、既存の同じ実行分岐へ直行します。
  **未設定**なら子セッションがモデル選択の直後に永続化確認（今回のみ / 常にこの選択 / 常に毎回選ぶ）を 1 問出し、「常に〜」で永続化されます。
- どちらも明示 `"ask"` なら従来どおり質問のみ（永続化オプションは出ません）。「常に〜」からの戻し方は 2 通りで意味が異なります: `"ask"` へ書き換えると質問のみ、キーを削除すると未設定に戻り永続化オプションが再表示されます。
- 不正値は project / global のレイヤーごとに検証され、不正なレイヤーだけ警告付きで無視してもう一方へフォールバックします（project の不正値が global に保存した「常に〜」を遮蔽しません）。

初回カスタム設定では codex runner の `plan_model` も収集し、review 方針を「従来の自動解決 /
毎回選ぶ / 固定 runner」から選びます。従来の自動解決は `review_runner` を書かず、後二者だけ
`"ask"` または runner 名をグローバル config へ保存します。保存は共有 `.tmp` ではなく writer 固有の
`mktemp "$CONFIG.XXXXXX"` を使い、jq 成功時だけ同一directoryで `mv` するアトミック更新です。

prewarm 無効時も role ごとに次の解決済み値を渡します:

```bash
launch-workspace.sh --mode plan --runner "$DESIGN_RUNNER"
launch-workspace.sh --mode review --runner "$REVIEW_RUNNER"
launch-workspace.sh --mode execute --runner "$EXEC_RUNNER"
```

## モデル選択フロー (Phase A-R / Phase B / Phase B-R)

`review_runner` を固定した場合、同じ専用レビューペインが Phase A-R と Phase B-R の全ラウンドを担当し、
実装者と同じ engine でも構いません。key 未設定時だけ、v1.17.0 のクロスエンジン割り当てを互換経路として
維持します。どちらの経路も解決後は runner/engine/model を明示値として扱い、engine の関係を再計算しません。

### Phase A-R — plan/spec クロスレビュー（オプション）

`runners.json` の review runner に `review_model`（例: `gpt-5.6-sol`）を設定し、config の
`review_mode` を `on` にすると、Phase A の成果物（plan/spec）を解決済みの専用ペインが
レビューする。approve が出るまで設計セッションが修正 → 再レビューを繰り返す（各ポイント最大 5 往復。
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
    { "name": "codex",  "command": "codex",  "engine": "codex",  "plan_model": "gpt-5.6-sol", "review_model": "gpt-5.6-sol", "exec_model": "gpt-5.6-terra",
      "plan_effort": "xhigh", "review_effort": "xhigh", "exec_effort": "high" }
  ]
}
```

| フィールド | 意味 |
|----------|------|
| `runners[].plan_model` | Phase A の plan / superpowers と prewarm design standby（`--role plan`）に渡すモデル名。未設定なら CLI 既定 |
| `runners[].review_model` | Phase A-R/B-R のレビューペインに渡すモデル名。codex review runner では必須、claude runner は未設定時に `opus[1m]` |
| `runners[].exec_model` | （`engine: codex` の runner のみ）Phase B 実行系（execute / standby ペイン）で `--model` 未指定時にフォールバック適用。review ペインには適用されない。未設定なら codex 側デフォルト（`~/.codex/config.toml`） |
| `runners[].plan_effort` / `review_effort` / `exec_effort` | （`engine: codex` の runner のみ。値: `minimal`\|`low`\|`medium`\|`high`\|`xhigh`）codex セッションの reasoning effort。それぞれ設計（plan/superpowers）/ レビュー / 実行（execute/standby）に `-c model_reasoning_effort='<値>'` として注入される。優先順位: **明示 `--effort` > runner フィールド > 無指定**（`~/.codex/config.toml` の既定） |

指示配送（Phase A タスク / Phase B 実行指示 / Phase A-R レビュー依頼 / Phase B-R コードレビュー依頼）は
すべて `send-prompt.sh` の 1 回呼び出しで行う。**常にペインへ直接タイプ入力し** — agmsg push 単独では
idle なペインは起きないため、push は配送手段ではなく inbox 記録である — 送信直前に宛先ペインの
watcher 生存（agmsg の ready sentinel）を確認し、生きているときだけ同一指示文を inbox にも
記録する。配線に失敗したペインの初期プロンプトは「指示は直接タイプされる」文面に
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

- Child セッションが `launch-workspace.sh --mode execute --plan-file <path> [--model <X>] [--skip-permissions]` を呼び、新しい workspace で実装を開始
- 新 surface (孫セッション) は runner script でラップされ、完了時に `status.json` を `done`/`error` に遷移させ、親に `[dispatch] task ... finished` を送信
- 孫の inner prompt 末尾には自動で「停止する前に `scripts/report-status.sh <status-dir> done <要約>` を実行せよ」という完了報告の指示が付与される。status.json を終端へ動かすのはこの呼び出しであってセッション終了ではないため、完了検知が TUI の閉鎖に依存しない。続く exit 指示は engine 別で、claude は `/exit`、**codex は「停止して idle のまま待て」**（codex には自セッションを終わらせる手段が無く、`/exit` は効かず quit/shutdown サブコマンドも無い）。codex ペインは最終クリーンアップで親が閉じるまで開いたままで正常
- Runner script ファイル名は workspace 名を含む (`.cmux-team-dispatch-task-run-<workspace-name>.sh`)。Child と Phase B 孫が同じ worktree を共有しても runner ファイル同士が衝突しない
- Child は spawn 完了後 `<STATUS_DIR>/.deferred` を作成して exit する (Child の runner wrapper は `--defer-status` で起動されており、`.deferred` を検知すると status 上書きをスキップして孫の通知を握り潰さない)。**Phase B-R 有効時は exit せず**、コードレビュアーとして idle 待機し、approve を書いた後に exit する
- sonnet では Claude Code の auto mode (`bypassPermissions`) が効かないため、`--dangerously-skip-permissions` を付けて permission prompt によるハングを防いでいる

codex オプションを使う場合は事前に `cmux codex install-hooks` の実行が必要です。

#### design=codex のタスク

設計 runner が `engine: codex` のタスクでは Phase A をその codex セッション自身が担う
（`--effort <plan_effort>` の reasoning effort で起動済み。セッション途中でモデルは切り替えない）。
Phase B の 3 択（**opus 1m / sonnet / codex**）は**すべて pre-warm ペインへ委譲**し、この codex
セッション自身は実装しない。固定 `review_runner` ではレビューペインと executor を兼用せず、
opus 1m も `prewarm.json.executors.opus` の解決済みペインが実装する。`review_runner` 未設定の
legacy policy だけは従来の兼用配置を維持する。prewarm.json が無い（prewarm off）場合は
`launch-workspace.sh --mode execute --runner "$EXEC_RUNNER"` へフォールバックする。

### Phase B-R — 実装後コードレビュー（オプション）

`review_mode` が `on` のとき（Phase A-R と同一条件）、実装完了後・**PR 作成前**に
コードレビューを挟む。approve が出るまで実装者が修正 → 再依頼を繰り返すため、PR は常に
レビュー済みになる。

- 固定 `review_runner` では Phase A-R と同じ専用レビューペインが全実装をレビューします。設計ペインは
  委譲後に `.deferred` を作って exit し、レビュアーへ転じません。同一Codex engine の実装者/レビュアーも
  正式にサポートします。`review_runner` 未設定の互換ポリシーだけは、従来の設計 engine × Phase B 選択の
  6 ケースを維持します:

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
  最大 5 往復・verdict 待ちは 5 秒間隔ポーリング + 15 分ごとのレビュアー pane 生存確認
  （`cmux read-screen` の画面差分）。レビュアーが活動している限り上限なしで待機し、
  無反応（stalled）のときのみ再依頼 1 回 → フォールバック — Phase A-R と同一プロトコル
- 5 往復で approve が出ない場合、claude 実装者は AskUserQuestion（このまま PR 作成 / さらに修正）、
  codex 実装者は未解決指摘を PR 本文に注記して続行
- `review/code-review.json` は `reviewer_runner` と `reviewer_engine` を明示し、実装者はここから実際の
  レビュアーを取得します。反対 engine は計算しません。prewarm 無効では
  `launch-workspace.sh --mode execute --runner <resolved-exec-runner> --review-config <path>`
  が孫の prompt にレビュープロトコルを注入する

### plan モードの Phase A-R / B 遵守ゲート

標準 plan モードでは ExitPlanMode 承認直後に子セッションがそのまま実装へ進み、Phase A-R /
Phase B がスキップされることがあります。対策として `launch-workspace.sh` が plan モード +
claude engine の worktree に `.claude/settings.local.json`（ExitPlanMode の PostToolUse
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

prewarm は解決済み role だけを起動し、`prewarm.json` の `design`、任意の `review`、
`executors` に実在ペインを記録する。固定 `exec_choice` では未選択 executor を起動しない。
固定 choice の opus/sonnet/codex はすべて generic `--exec-runner` で解決済み runner を受け渡し、
review runner から executor を推測しない。review pane の起動に失敗した場合は警告して `review` を
省略し、design/executor pane を保持したまま Phase B を続行する。
固定 review は解決済み `review_runner` を使うため、design と同じ engine でも有効。
all-Codex 固定構成は design/review/codex executor の3ペインだけで、sonnet pane、claude command、
agmsg `claude-code` 配線を作らない。未割り当てペインは status.json を汚さず、最終クリーンアップでは
`prewarm.json` の surface/agent を再帰列挙して重複除去し、実在するものだけを close/leave する。

- agmsg 未インストール: opus は従来どおりタスクプロンプト付きで起動し、sonnet / codex のみ
  idle 起動。実行指示は `send-prompt.sh` で注入する。
- agmsg インストール済み: opus-1m を含む全ペインをメッセージ未指定(idle)で起動する。
  `prewarm-panes.sh` が worktree への agmsg delivery 配線(join + `delivery.sh set`)を
  ペイン起動前に行い、Phase A の初期タスクも Phase B の実行指示も `send-prompt.sh` の
  1 回呼び出しで配送する(常にタイプ入力。宛先の ready sentinel 生存時は加えて inbox にも記録)。

`prewarm: false` では on-demand spawn。design/review/exec の全経路が解決済み runner を
`--runner` で渡し、all-Codex 構成が launch script の claude 既定値へフォールスルーすることはない。

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

`superpowers:writing-plans` でプランが完成すると、Execution Handoff として実行方法の選択肢が提示される。本スキルは **第3選択肢「Parallel (cmux)」** として統合:

| 選択肢 | 向いているケース |
|--------|-----------------|
| Subagent-Driven | タスク間に依存あり、レビュー重視、コスト節約 |
| Inline Execution | シンプルなプラン、対話的実行、単一セッション希望 |
| **Parallel (cmux)** | **独立タスク3個以上、速度重視、全セッションを画面で一望** |

## 制約事項

- **cmux 必須**: `/Applications/cmux.app/` にインストールされている必要があります
- **同時セッション数**: 3〜5 セッションが推奨
- **同時セッション数の上限**: 多数の workspace を同時に開くと端末資源を消費します
- **ファイル競合**: 2つのタスクが同じファイルを変更してはいけません。競合の可能性がある場合は順次実行にしてください
- **完了シグナルは信頼性あり**: ランナースクリプトが `status.json` の更新、`cmux wait-for --signal` の発火、`send-prompt.sh` による親ターミナルへの通知を保証。加えて `monitor-dispatch.sh` も個別タスク完了時に `[dispatch]` 通知を親に送信
- **pane を閉じても誤通知しない**: 最終クリーンアップの `cmux close-surface` / `close-workspace` で子プロセスは signal 終了（終了コード 128+N）する。`status.json` が既に `done` / `error` なら wrapper は status 書き込みと親通知の両方をスキップするため、完了済みタスクが `error` に降格したり偽の `[dispatch] ... (status: error)` が飛んだりしない。まだ `executing` の pane を kill した場合は本当の中断なので従来どおり `error` を報告する

## タスク内の並列実行

各子セッションは、独立した調査と検証を子エージェントへ分散させるよう指示される
（codex は `spawn_agent`、claude は Task サブエージェント）。ファイル編集は
親エージェントで逐次のままなので、同一 worktree での書き込み競合は起きない。
分散してよいのは**読み取り専用の検証だけ**で、auto-fix / write モード（formatter や
linter を write フラグ付きで走らせるもの）は親エージェントで逐次に実行させる。

同時に走る子エージェントの上限は既定 4。これを変える `--agents <N>`（2〜8）と、
起動プロンプトへの指示を止める `--no-parallel` は、いずれも
**`launch-workspace.sh` のスクリプトレベルのフラグ**である。スキルはこの 2 つを
公開しておらず（`design_runner` / `exec_choice` / `review_mode` のような `config.json`
キーも無い）、スキル経由のディスパッチは常に既定値で走る。値を変える現実的な手段は
今のところ `launch-workspace.sh` を手で呼ぶことだけ。

タスク自体も worktree 横断で並列に走るため、**トークン消費は「タスク数 × 子エージェント数」
で効いてくる**。小さな変更を大量にディスパッチするときはこの掛け算がコストを押し上げる点に
注意すること。スキル経由では抑えられないので、抑えたい場合は `launch-workspace.sh` を
手動で `--agents 2` または `--no-parallel` 付きで呼ぶ。

## Codex hook の互換性

codex ペインを起動するとき、`launch-workspace.sh` は `~/.codex/config.toml`（`CODEX_HOME` で上書き可）を読み取り専用で検査し、`claude-plugins-official` の **security-guidance** プラグインが有効なら次の警告を出します。

```
[warn] security-guidance plugin is enabled for codex; its hooks emit stdout keys codex rejects ...
```

このプラグインの hook は Claude Code の出力契約に合わせて stdout に `{"metrics": {...}}` を書きますが、codex の hook 出力スキーマは `additionalProperties: false` なので必ず拒否され、codex ペインには毎ターン `Stop hook (failed) / error: hook returned invalid stop hook JSON output` が出ます。環境変数の kill switch でも `metrics` は出るため回避できません。

警告は **dispatch を止めず、設定も書き換えません**。直すには codex 側でプラグインごと無効化します。`~/.codex/config.toml` を編集するか、codex の `/hooks` TUI から無効にしてください。

```toml
[plugins."security-guidance@claude-plugins-official"]
enabled = false
```

（このリポジトリで開発している場合は `bash scripts/codex-hook-compat.sh disable` で冪等に書き換えられます。`/hooks` TUI が同じファイルを自動保存するため、実行中の codex セッションを閉じてから走らせてください。）

security-guidance は hooks しか提供していない（skill / command なし）ため、無効化して失うのは「codex では元々動かない security review」だけです。

## 詳細ガイド

詳細な利用方法・トラブルシューティングについては [リファレンスガイド](skills/cmux-team-dispatch-task/references/guide-ja.md) を参照してください。

## ライセンス

[MIT](LICENSE)
# GitHub issue 自動ループ

`--loop` を指定すると、GitHub issue を claim してバッチ単位で処理する。詳細は skill の `references/loop-mode.md` を参照する。ループ中は `.dispatch-loop/` のロックにより通常 dispatch を保護する。Codex runner は hook trust 確認を無人で通すため `--dangerously-bypass-hook-trust` を使用する。

無人 prompt には解決済み design / 任意 review / exec の runner と engine をそのまま渡す。同一 engine の review も有効で、all-Codex 固定例（design/review/exec が codex）は3ペインだけを起動し、Claude/sonnet を補完起動しない。timeout sentinel は生成済みroleだけに渡す。cleanup/ agmsg leave は sparse な `prewarm.json` の `surface_id` / `agent` を再帰列挙して重複除去し、存在するroleだけを対象にする。`close-surface` は常に `--workspace` を伴い、`status.json` にworkspace IDが無い場合はworkspace名の `[slug]` をリテラル一致で引き直す。

## Phase B-R 有効時の完了通知について

Phase B-R（実装後コードレビュー）を有効にすると、実装ペインへ送る指示文が拡張版に差し替わります。
この拡張版には **engine 別の終了指示**（codex は `/exit` ではなくセッション自体を終了）と
**親への完了通知**（`send-prompt.sh --label dispatch-notify` の 1 回呼び出し）の両方が含まれます。

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
