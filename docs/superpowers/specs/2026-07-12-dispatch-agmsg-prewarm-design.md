# cmux-team-dispatch-task: agmsg トランスポート対応 + sonnet/codex pre-warm tab 設計

- 日付: 2026-07-12
- 対象: `apps/cmux-team-dispatch-task`
- ステータス: 承認済み（実装前）

## 背景と目的

現行の dispatch では、子 → 親の通知が `cmux send` + `cmux send-key return` のペア発行に依存し、
さらに `monitor-dispatch.sh` のポーリングループが heartbeat / 死活監視 / 全完了検知を担っている。
また Phase B（実装フェーズ）で sonnet / codex を選ぶと `launch-workspace.sh --mode execute` で
別 surface を都度 spawn するため起動が重い。

本設計は次の 2 機能を追加する:

1. **`message_type` config** — 通知トランスポートを `send-message`（現行 cmux send）と
   `agmsg`（[agmsg](https://github.com/fujibee/agmsg) による SQLite ベースのエージェント間メッセージング）から選択可能にする。
   agmsg モードでは monitor ループを廃止し、親は agmsg monitor mode のリアルタイム push で通知を受ける。
2. **pre-warm tab** — workspace レイアウト時、各タスクの workspace 内に sonnet（+ codex）の
   セッションを tab として事前起動しておき、Phase B の実装依頼を「メッセージ送信 1 回」にする。
   依頼送信は message_type に応じて `cmux send` / `agmsg send` の両対応。

## 決定事項（ブレインストーミング結果）

| 論点 | 決定 |
|------|------|
| agmsg モード時の monitor-dispatch.sh | **起動しない**（ループ廃止）。status.json は残すので沈黙時は手動ポーリングで確認 |
| pre-warm の発動条件 | **config 制御（default: on）+ workspace レイアウト限定**。split / claude-teams は従来の on-demand spawn |
| アーキテクチャ | **トランスポート抽象化 + runner wrapper 維持**。exit ベースの確実な完了検知を pre-warm でも維持 |
| agmsg spawn.sh の利用 | しない（tmux / OS terminal 前提で cmux workspace/tab 統合が失われるため） |

## 機能 1: message_type config とトランスポート抽象化

### Config スキーマ

- グローバル: `~/.claude/cmux-team-dispatch-task/config.json` に `message_type` キーを追加
  （既存 `shell_ready_ms` と同居）。値: `"send-message"` | `"agmsg"`
- プロジェクト上書き: `<project>/.dispatch/config.json` の `message_type` が優先（既存の優先規則を踏襲）

### 解決フロー（SKILL.md Step 1 に「1g. Resolve Message Transport」を挿入、既存 1g は 1h に繰り下げ）

1. config に `message_type` があればそれを使う。**質問しない**
2. なければ agmsg インストール判定: `~/.agents/skills/agmsg/scripts/send.sh` が存在するか
   （plugin cache のみで bootstrap 未実行の場合は「未インストール」扱い）
3. インストール済み → AskUserQuestion「agmsg を通知トランスポートに使いますか？」
   → **Yes / No どちらの回答もグローバル config に書き込む**（No を永続化しないと毎 dispatch 質問が出るため）
4. 未インストール → `send-message` を使用し、config には**書き込まない**
   （後日 agmsg を導入したら質問が発火する）

### トランスポート実装

- `launch-workspace.sh` に `--message-type <send-message|agmsg>` と `--agmsg-team <team> --agmsg-from <agent>` を追加。
  生成される runner wrapper の親通知コードが切り替わる:
  - `send-message`: 現行どおり `cmux send` + `cmux send-key return` のペア発行
  - `agmsg`: `~/.agents/skills/agmsg/scripts/send.sh <team> <from> parent "[dispatch] task \"<slug>\" finished (status: done|error)"`
- **agmsg の配線**（agmsg モード時、dispatch 開始前に親が実施）:
  - team 名: `dispatch-<repo-name>`（repo 固定。dispatch ごとに team を増殖させない）
  - 親: `join.sh <team> parent claude-code "$(pwd)"` で join し、`delivery.sh set monitor` で push 受信を確保
  - 子: 親が launch 前に `join.sh <team> <slug> ...` で登録（子セッション自身は join を意識しない。wrapper が send.sh を叩くだけ）
  - 子 prompt の status protocol に「進捗・質問は agmsg send で親（`parent`）に送れる」旨を追記し、
    エージェント間の直接会話を可能にする
- `monitor-dispatch.sh`: agmsg モードでは**起動しない**。SKILL.md Step 3 を message_type で分岐:
  - `send-message`: 現行どおり monitor 起動（heartbeat / DIED 検知 / 全完了通知）
  - `agmsg`: wrapper からの agmsg push を待つ。長い沈黙時は `.dispatch/*/status.json` を手動ポーリング
- **不変条件**: status.json / result.md / `cmux wait-for` signal は両モードで変更しない
  （クリーンアップ・レポート生成・E2E の基盤）

## 機能 2: pre-warm tab と Phase B 変更

### Config と発動条件

- `config.json` に `prewarm` キーを追加（`true` | `false`、default `true`）
- workspace レイアウト時のみ有効。split / claude-teams では従来フロー
- codex tab は `runners.json` に `engine: "codex"` の runner がある場合のみ起動
  （現行の Phase B codex 表示条件と同一）

### 起動方法（Step 2 拡張）

各タスク workspace の作成直後、親が同 workspace 内に tab を追加する:

1. `launch-workspace.sh` に **`--mode standby`** を新設。`--standby-in <workspace-id>` で
   既存 workspace に `cmux new-surface --type terminal` で tab を作成し、`rename-tab` で
   `<slug>-sonnet` / `<slug>-codex` と命名。`wait_for_shell` 後に
   `cd <worktree> && bash .cmux-team-dispatch-task-run-<slug>-sonnet.sh` を send
   （runner ファイル名は既存の workspace 名 unique 化規則に乗る）
2. **standby wrapper**（既存 wrapper の変種）:
   - 起動コマンド: sonnet → `claude --model claude-sonnet-4-6 --dangerously-skip-permissions`、
     codex → `codex --dangerously-bypass-approvals-and-sandbox`
   - `send-message` モード: prompt なしで起動し idle TUI で待機。実行指示は後から `cmux send` で注入
   - `agmsg` モード: 初期 prompt に「team `dispatch-<repo>` に `<slug>-sonnet` として join し、
     monitor mode で実装依頼メッセージを待て」を渡して起動
   - **exit 時**: `<STATUS_DIR>/.assigned` sentinel が**存在するときだけ** status.json を done/error に遷移させ、
     signal を発火し親に通知。存在しなければ何も書かずに終了
     （未使用 tab を閉じても status を汚さない — 現行 `.deferred` の逆向きの仕組み）
   - signal 名は既存の `<workspace-name>-done` 規則に従い `<slug>-sonnet-done` / `<slug>-codex-done`
   - **codex standby の制約**: agmsg では idle 状態の codex セッションは Monitor による push 受信ができない
     （agmsg README の codex caveat）。そのため codex standby への実装依頼の注入は
     **agmsg モードでも `cmux send` + `send-key return` で行う**。agmsg は codex → 親の完了通知
     （wrapper の send.sh 呼び出し）にのみ使用する
3. 親は起動結果を `.dispatch/<slug>/prewarm.json` に書く:

   ```json
   {
     "sonnet": { "surface_id": "surface:N", "agent": "<slug>-sonnet" },
     "codex":  { "surface_id": "surface:M", "agent": "<slug>-codex" }
   }
   ```

   prompt file は launch 時点で確定済みのため、後から確定する surface ID はこのファイル経由で子に渡す。

### Phase B（MANDATORY MODEL SELECTION SEQUENCE）の変更

AskUserQuestion（opus 1m / sonnet / codex）は現行のまま維持。選択後の動作のみ変更:

- **opus 1m** → 現行どおり `/model` で現セッション継続。`prewarm.json` があれば
  不要になった standby tab を `cmux close-surface` で閉じる（`.assigned` なしで exit → status 無汚染）
- **sonnet / codex** → `prewarm.json` を読み、該当 tab があれば:
  1. `touch <STATUS_DIR>/.assigned`（standby wrapper に完了処理の所有権を渡す）
  2. 実行指示を送信:
     - `send-message`: `cmux send --surface <sf> 'Read and execute the plan at <path>. …（/exit 指示を含む）'` + `send-key return`
     - `agmsg`（sonnet のみ）: `send.sh <team> <slug> <slug>-sonnet "EXECUTE: Read and execute the plan at <path> …（/exit 指示を含む）"`
     - `agmsg` + codex: 上記 codex caveat のため実行指示は `cmux send` で注入（完了通知のみ agmsg）
  3. 使わない側の standby tab（例: sonnet 選択時の codex tab）を `cmux close-surface`
  4. 従来どおり `.deferred` を touch して child は exit
- `prewarm.json` がない場合（split / prewarm off）→ 従来の `launch-workspace.sh --mode execute` spawn にフォールバック

### クリーンアップと信頼性

- 実行指示 prompt に `/exit` 指示を含める点は現行 execute モードと同じ。
  standby セッションの exit → wrapper が status.json を done に遷移、という exit ベースの完了検知保証は現行と同一
- 親の end-of-dispatch cleanup で、`prewarm.json` に記録された surface が残っていれば
  Q1（Pane/Workspace close）の回答に従い閉じる
- agmsg モード時は cleanup で `leave.sh` により `<slug>` / `<slug>-sonnet` / `<slug>-codex` を team から除籍

## ドキュメント・テスト

- CLAUDE.md の絶対ルールに従い **SKILL.md / guide-ja.md / README.md / CLAUDE.md（プラグイン側）の 4 ファイルを同期更新**:
  - Step 1 への 1g（message transport 解決）挿入と番号繰り下げ
  - Step 2 への pre-warm 起動手順追加
  - Phase B（MANDATORY MODEL SELECTION SEQUENCE）の prewarm 分岐
  - Step 3 の message_type 分岐（agmsg モードは monitor 非起動）
  - config スキーマ（`message_type` / `prewarm`）の記載
  - メンテナンス手順・E2E テスト項目に prewarm / message_type / `.assigned` sentinel の検証項目を追加
- E2E 追加観点:
  - message_type 未指定 + agmsg インストール済み → 質問が出て回答が config に永続化されること
  - message_type 指定済み → 質問が出ないこと
  - agmsg モードで monitor-dispatch.sh が起動しないこと・完了通知が agmsg push で届くこと
  - workspace レイアウトで sonnet（+ codex）tab が事前起動されること
  - Phase B sonnet 選択 → `.assigned` → 実行指示送信 → standby exit 時に status.json が done になること
  - opus 1m 選択 / 非選択側 tab が close-surface され status.json が汚れないこと
  - split レイアウト / prewarm off で従来の on-demand spawn にフォールバックすること

## スコープ外

- agmsg 自体の変更（agmsg リポジトリには手を入れない）
- claude-teams レイアウトへの prewarm / agmsg 適用
- monitor-dispatch.sh の機能拡張（send-message モードでは現行のまま）
