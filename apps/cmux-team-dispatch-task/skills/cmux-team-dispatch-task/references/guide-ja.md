# Team Dispatch

## Output Language

ユーザーへの質問・選択肢ラベル・表・進捗報告はすべて日本語で表示する。SKILL.md 本文が英語なのは記述の統一のためであり、ユーザーへの提示言語は変えない。

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

## ループモード（GitHub issue 自動ループ）

`--loop` は `references/loop-mode.md` の手順で GitHub issue をバッチ処理する。状態は `.dispatch-loop/`、タスク状態は `.dispatch/` に置く。`loop.task_timeout_min` と `loop.lock_lease_min` は timeout とロック lease を別に設定する。通常 dispatch は active loop lock があれば開始・一括 cleanup を拒否する。Codex 起動には全経路で `--dangerously-bypass-hook-trust` を付与する。runner wrapper は既存の `pr_url` を保持する。無人 prompt には解決済み design / 任意 review / exec の runner と engine を渡し、role 間の関係から再推測しない。all-Codex 固定構成は3つの codex role pane だけを起動する。timeout sentinel と cleanup は `prewarm.json` に実在する role だけを対象にする。

---

## セットアップモード（設定の明示構成）

`--setup` でのみ発動する。ディスパッチは一切行わず、タスク・worktree・workspace・ペインを作らない。役割キー（`design_runner` / `review_runner` / `exec_choice` / `review_mode` / `prewarm`）と `runners.json` レジストリを対話で構成し、ユーザーが選んだレイヤーへ書き込む。手順は [`references/setup-mode-ja.md`](setup-mode-ja.md)（英語版は `setup-mode.md`）。

## リセットモード（設定のリセット）

`--reset` でのみ発動する。対象は任意で指定できる: `--reset runners`（レジストリ）、`--reset config`（役割キー）、`--reset all`。対象未指定なら質問する。ディスパッチは行わず、`.dispatch/`・worktree・ブランチは決して削除しない（それはディスパッチ末尾の Cleanup prompts の担当）。手順は [`references/setup-mode-ja.md`](setup-mode-ja.md)。

両モードとも書き込みは `scripts/config-edit.sh` だけを通す。置換ではなくマージするため、他コンポーネントが所有するキー（`shell_ready_ms`）が生き残る。`--loop` とも互いとも排他で、issue ループがロックを保持している間はどちらも実行を拒否する。どちらもタスク記述ではないため、Step 1a のタスク解析に到達させてはならない。

---

## Step 1: 解析と準備

タスク収集、Agent ルーティング、統合戦略決定、子 runner 設定を1ステップで実行。
ディスパッチ前に brainstorming、統合戦略、design/review runner、レビューモードを解決する。`review_runner`
未設定時だけ既存互換の自動 resolver を使う。メッセージトランスポートの質問は**存在しない** — 1g を参照。

### 1a. タスク収集

タスクを `$ARGUMENTS` から解析（なければ1回だけ質問）

### 1b. 利用可能な Agent の発見（自動）

`.claude/agents/` をスキャンして利用可能な Agent 一覧を収集

### 1c. Brainstorming 対象タスクの選択

**brainstorming タスク選択**:
- 各タスクについて brainstorming スキルを使うか選択
- 選択されたタスク → superpowers モード + MANDATORY EXECUTION SEQUENCE
- 非選択タスク → plan モード

### 1d. レイアウト

レイアウトは常に `workspace`。各タスクは独立した cmux workspace（サイドバー項目）で起動する。選択質問やレイアウト指定フラグはない。

### 1e. 統合戦略の選択

**統合戦略選択**:
- **PR per task** — 各子タスクがブランチを push して GitHub PR を作成。親は PR を監視
- **Wait and merge** (デフォルト) — 全タスク完了後に親がローカルマージ

### 1f. 子セッション runner の設定

**子セッション runner 選択**（詳細は「子セッション runner 設定（runners.json）」セクション。本ガイドでは「補足」に移設）:
- `runners.json` 不在 → 初回セットアップで生成
- runners 1 件 → 自動でその runner を全タスクに適用（切替確認スキップ）
- runners 2 件以上かつ `design_runner` 未設定 → 4 択（デフォルト適用 / タスクごとに選択 /
  設定保存 / `runners.json` reset）。明示 `"ask"` → 設定保存を除く 3 択。固定 runner 名 → 質問なし
- **独立レビュアー解決**: project `review_runner` → global `review_runner` → key 未設定時の
  legacy 自動 resolver。固定/`"ask"` は同一 engine を許可する。codex 候補は `review_model` 必須、
  claude 候補は `opus[1m]` fallback。不正な project/global 値はそのレイヤーだけ無効化する。

### 1g. 配送・レビューモード・実行既定の解決

**通知トランスポートの質問は無く、`message_type` という config キーも無い。**
agmsg は `~/.agents/skills/agmsg/scripts/send.sh` が存在すれば必ず配線され、無ければ
agmsg 配線なしでそのままディスパッチする。質問も永続化も行わない。

```bash
AGMSG_INSTALLED=false
[[ -f ~/.agents/skills/agmsg/scripts/send.sh ]] && AGMSG_INSTALLED=true
```

`monitor-dispatch.sh` は **agmsg が未インストールのときだけ** 起動する（Step 3）。
`--message-type` は `launch-workspace.sh` / `prewarm-panes.sh` から削除済みで、渡すと
`was removed` を含むメッセージで die する。

**配送規約（本スキルが送るすべてのメッセージに適用）**: 配送は必ず
`scripts/send-prompt.sh` の 1 回呼び出しで行い、生の `cmux send` は使わない: <!-- send-prompt-exempt: 禁止事項の記述であって配送指示ではない -->

```bash
# --to-surface <id> はペイン宛。宛先が workspace 全体（親）のときは
# --to-workspace <id> を使う。どちらか一方が必須。
bash <SKILL_DIR>/scripts/send-prompt.sh \
  --to-surface <TARGET_SURFACE> \
  --agmsg-team "$TEAM" --agmsg-to <TARGET_AGENT> --agmsg-from <YOUR_AGENT_NAME> \
  --label <label> --outbox-dir <STATUS_DIR>/outbox \
  -- '<message text>'
```

- **必ず宛先ペインへタイプ入力する**。idle セッションを起こせるのはタイプ入力だけなので、
  この半分は省略できない
- `--agmsg-*` の 3 引数が揃い、かつ宛先の ready sentinel
  （`~/.agents/skills/agmsg/run/ready.<team>__<agent>`）が存在するときは、必ずタイプ入力を
  終えたあとに **同一本文を agmsg inbox にも記録する**。この記録は wake 手段ではなく、
  agmsg の失敗は配送の成否にも終了コードにも影響しない。固まった agmsg 書き込みが唯一の
  wake 手段を塞げないよう、順序は常にタイプ入力が先。`$TEAM` が空のときは 3 フラグごと省略する
- 400 文字を超える本文は `<outbox-dir>/<label>-<seq>.md` に書き出し、1 行のポインタだけを
  タイプする。長文が貼り付け判定されて入力欄に詰まる事故を止めているのがこれ
- タイプ後に Enter を押し、`cmux read-screen` で入力欄が空になったことを確認する。
  残っていれば最大 3 回まで Enter を再送してから失敗を報告する。この確認は**宛先が 0 桁目に
  `❯`（または `>`）のプロンプト行を描画している場合に働く**（その最終行を入力欄とみなすため）。
  該当行が無いペインは、画面を観測できない場合と同様に検証なしで配送済みとして扱う
  （呼び出し元が再送して二重配送するのを防ぐため）
- 終了コード: 0 = 配送成功 / 1 = 配送失敗 / 2 = 使用法エラー

`<label>` は呼び出し箇所ごとの outbox ファイルをまとめる識別子。次の値を使う:

| 呼び出し箇所 | label |
|-------------|-------|
| design ペインへの Phase A タスク投入 | `phase-a-task` |
| standby ペインへの Phase B 実行指示 | `phase-b-exec` |
| Phase A-R の plan/spec レビュー依頼 | `review-plan` |
| Phase B-R のコードレビュー依頼 | `review-code` |
| レビュアーへの abort 通知（実装者・runner wrapper のどちらから送る場合も） | `abort-reviewer` |
| 親への完了 / abort 通知 | `dispatch-notify` |
| `monitor-dispatch.sh` の heartbeat / 全完了 / DIED 通知 | `dispatch-monitor` |

**agmsg インストール済み（`AGMSG_INSTALLED=true`）のときは dispatch 前に team を配線する**:

```bash
TEAM="dispatch-$(basename "$(git rev-parse --show-toplevel)")"
PARENT_ENGINE="claude"
[[ -n "${CODEX_THREAD_ID:-}" ]] && PARENT_ENGINE="codex"
PARENT_AGMSG_TYPE=$(bash <SKILL_DIR>/scripts/resolve-agmsg-type.sh --engine "$PARENT_ENGINE") || exit 1
~/.agents/skills/agmsg/scripts/join.sh "$TEAM" parent "$PARENT_AGMSG_TYPE" "$(pwd)"
~/.agents/skills/agmsg/scripts/delivery.sh set monitor "$PARENT_AGMSG_TYPE" "$(pwd)"
```

`PARENT_AGMSG_TYPE` は現在の親オーケストレーター runtime に合わせる。Codex は
`CODEX_THREAD_ID` を設定するため all-Codex では `codex`、Claude Code 互換経路では
`claude-code` になる。子 runner から親 type を推測してはならない。

未インストールなら `TEAM` は空のままこのブロックごとスキップし、以降の `--agmsg-*` も
すべて省略する。配送はタイプ入力だけで従来どおり成立する。

`delivery.sh set` が `AGMSG-DIRECTIVE:` 行を出力することがある — この行が起動する
SessionStart hook は次回以降のセッションにしか効かないため、この directive こそが
**現セッション**で delivery を有効化する手段である。出力にこの行があれば、タスクを
起動する前に必ず従うこと（指示どおり Monitor tool を呼び出す）。ただし watcher は
記録・返信用のチャネルであり wake 手段ではない: watcher の stream 出力は idle
セッションには注入されない。だからこそ `send-prompt.sh` は常にタイプ入力も行う。

各 launch には `--agmsg-team "$TEAM" --agmsg-from <slug>` を付与し、
pre-warm 無効時は worktree 作成後に子 agent を次のように join する（pre-warm 有効時は
`prewarm-panes.sh` が role ごとの engine を使って join 済みなので、この手動 join を省略する）:

```bash
CHILD_AGMSG_TYPE=$(bash <SKILL_DIR>/scripts/resolve-agmsg-type.sh --engine "$DESIGN_ENGINE") || exit 1
~/.agents/skills/agmsg/scripts/join.sh "$TEAM" <task-slug> "$CHILD_AGMSG_TYPE" "<repo-root>/.worktrees/<task-slug>"
```

`CHILD_AGMSG_TYPE` はタスクごとに解決済みの `DESIGN_ENGINE` から決め、親 runtime や別 role
から推測しない。子プロンプトには「親 (`parent`) へ
`send.sh` で直接質問・進捗報告できる」旨に加えて、次の**必須完了通知**のブロックを追記する:

```
You can message the parent directly at any time (questions, progress):
  ~/.agents/skills/agmsg/scripts/send.sh <team> <task-slug> parent "<message>"

MANDATORY completion notification: immediately after writing done/error to
status.json, notify the parent yourself with ONE send-prompt.sh call:
  bash <SKILL_DIR>/scripts/send-prompt.sh --to-workspace <PARENT_WORKSPACE_ID> \
    --agmsg-team <team> --agmsg-to parent --agmsg-from <task-slug> \
    --label dispatch-notify --outbox-dir <STATUS_DIR>/outbox \
    -- "[dispatch] task \"<task-slug>\" finished (status: <done|error>)"
Drop the three --agmsg-* flags when <team> is empty. send-prompt.sh types the
message into the parent pane (the only thing that wakes an idle parent) and,
when the parent's agmsg watcher is alive, also records the same text in its
inbox — that record is a log, not a wake mechanism. Do NOT rely on session
exit either: the runner wrapper notifies on exit as a backstop, but an idle
TUI session never exits, and when agmsg is installed no monitor loop is
running, so without this call the parent may never be informed.
```

### 1h. サマリー表示と実行

Template A（Display Format Conventions）で情報表示し、即座にディスパッチ:
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

---

## Step 2: セッションの起動

レイアウトモードに応じてセッションを起動。

### Prompt File Approach（プロンプトの受け渡し）

子セッションへのプロンプトは **`.cmux-team-dispatch-task-prompt.md` ファイル経由** で渡されます。

**プロンプトファイルの構成順序**:

```
1. MANDATORY EXECUTION SEQUENCE（brainstorming タスクのみ）
2. AVAILABLE AGENTS ブロック（Agent が発見された場合）
3. タスク説明
4. ステータスプロトコル指示
```

ブレスト指示と Agent 情報がタスク説明より先に来るため、子セッションが最初にブレストを実行し、適切な Agent を選択できます。

**なぜファイル経由なのか**: シェルエスケープの問題を完全に回避するためです。

**プロンプトファイルの場所**: 各 worktree のルートディレクトリ: `<worktree>/.cmux-team-dispatch-task-prompt.md`

### Runner Script Wrapper（ランナースクリプト ラッパー）

起動スクリプトは各 worktree に `.cmux-team-dispatch-task-run-<workspace-name>.sh` を生成します。ファイル名に workspace 名を含めることで、Child (`<slug>`) と Phase B grandchild (`<slug>-exec`) が同じ worktree を共有する場面でも runner ファイル同士が衝突しません (実行中のスクリプトを上書きすると bash が undefined 挙動になります)。

**ランナースクリプトが保証すること**:

1. `status.json` を `"executing"` に更新（絶対パス使用）
2. `claude` コマンドをインタラクティブに実行
3. Claude 終了後、`status.json` を `"done"` または `"error"` に更新
4. `cmux wait-for --signal <slug>-done` で完了をシグナル
5. `cmux notify` で親 workspace に通知
6. `[dispatch] task ... finished (status: ...)` のテキスト通知を
   `scripts/send-prompt.sh`（`--label dispatch-notify`）経由で親へ配送する。タイプ入力
   したうえで Enter が効いたことを確認するので、親が claude TUI でも input box に
   テキストが滞留しない。`--agmsg-team` / `--agmsg-from` が渡されていて親の watcher が
   生きているときは、同一文が親の agmsg inbox にも記録される

- **agmsg 配線時の親通知**: `send-prompt.sh` がタイプ入力に**加えて**
  `~/.agents/skills/agmsg/scripts/send.sh <team> <from> parent "<msg>"` でも送信する
  （inbox 記録専用 — idle な親は agmsg では起きないため、wake を担うタイプ入力は
  常に実行される。`cmux notify` と `cmux wait-for --signal` は agmsg の有無によらず共通）
- **standby wrapper（`--mode standby`）**: 起動時に status.json を書かず、exit 時も
  `<STATUS_DIR>/.assigned-<workspace-name>` が存在するときだけ done/error に遷移させる
  （`.deferred` の逆向き。ロール別ファイルにすることで同じ STATUS_DIR を共有する
  claude/codex 等の standby 同士が互いの割り当てを誤検知しない）。
  signal 名は `<workspace-name>-done`（例: `login-page-ui-claude-done`）
- **signal 終了ガード**: 最終クリーンアップで pane を閉じる（`cmux close-surface` /
  `close-workspace`）と子プロセスは signal 由来の終了コード（128+N。SIGHUP=129 /
  SIGKILL=137 / SIGTERM=143）を返す。このとき `status.json` が既に terminal
  （`done` / `error`）なら wrapper は status 書き込みも親通知も行わない。
  これにより、完了済みタスクが pane を閉じただけで `error` に降格したり、
  偽の `[dispatch] task ... finished (status: error)` が親へ飛んだりしない。
  まだ `executing` の pane を kill した場合は本当の中断なので従来どおり
  `error` を書いて通知する

シグナル名は `<task-slug>-done` で、起動スクリプトの出力 JSON の `signal_name` フィールドで返されます。

### Building the Task Prompt（子セッションのモデル選択フロー（必須））

子セッションのプロンプトには `MANDATORY MODEL SELECTION SEQUENCE` が必ず含まれており、以下の段階で動作する
（Phase A-R は `review_mode: on` のときのみ Phase A と Phase B の間に挟まり、同条件で
Phase B-R が実装完了後・PR 作成前に挟まる）。プロンプトテンプレートはタスクの**設計 engine**
（Step 1f で割り当てた runner の engine）で出し分けられ、design=claude は従来どおり、design=codex は
「codex 設計 variant」に差し替わる。

子プロンプトの `MANDATORY MODEL SELECTION SEQUENCE` 冒頭には `OUTPUT LANGUAGE:` 指示が3行埋め込まれており、子セッションのユーザー向け出力（質問・選択肢・表・進捗報告）もすべて日本語で表示するよう指示している（本ガイド冒頭の Output Language 節と同じ方針。SKILL.md 側のテンプレート自体は英語で書かれているが、提示言語には影響しない）。

**Phase A: Plan / Brainstorming（設計 engine で実行）**

- superpowers モード: `superpowers:brainstorming` → `superpowers:writing-plans`
- plan モード: 組み込み `/plan`。提示する plan の冒頭に、実装ステップより前の必須ステップと
  して「Step 0: Phase A-R 解決済み runner レビュー（有効時）」「Step 1: Phase B 実行モデル選択
  （AskUserQuestion）」を必ず記載する。承認された plan の実行は Phase A-R / Phase B から
  始まり、コード変更からは始まらない
- plan モードで plan が ExitPlanMode メッセージ内にしか存在しない場合、承認後の最初の作業
  としてファイル（例: worktree 内 `.claude/plans/<task-slug>.md`）に保存する（Phase B の
  `--plan-file` 受け渡しに必要）
- このフェーズでは **モデル切り替えを禁止** する。`DESIGN_RUNNER / DESIGN_ENGINE / PLAN_MODEL` を
  prompt に明示し、engine から model を推測しない。Codex design は `plan_model` / `plan_effort` を使う。

**codex 設計 variant（design=codex のタスク）**

設計 runner が `engine: codex` のタスクでは Phase A / Phase B が以下に差し替わる:

- **Phase A**: この codex セッション内で plan / spec を作成する（セッション途中でモデルを
  切り替えない）。plan モードは `/plan` を使い、承認された plan は Step 0（Phase A-R）/
  Step 1（Phase B）を実装ステップより前に列挙してファイル保存する
- **Phase B**: `claude` / `codex` の 2 択は基本的に pre-warm ペインへ委譲する — **この codex
  セッション自身は実装しない**。固定/legacy policy のどちらも、review は専用 `<slug>-review`、
  claude executor は専用 `<slug>-claude` を使って兼用しない。legacy policy が維持するのは従来の
  クロスエンジンレビュアー割り当て6ケースだけである。claude / codex をそれぞれ
  `prewarm.json.executors.<choice>` の解決済みペインへ送り、`.deferred` を touch する。
  **例外**: `prewarm.json` の `.executors` が空（`{}`）のとき——実行 role の engine / model /
  effort が設計 role と完全一致するとき——は委譲も `.deferred` も行わず、この codex セッション
  自身が実装する。
  prewarm.json が無い（prewarm off）場合は claude variant と同じく `launch-workspace.sh
  --mode execute --runner "$EXEC_RUNNER"` と解決済み `EXEC_MODEL` にフォールバックし、review
  runner を executor として流用しない

**Phase A-R — plan/spec レビュー（review_mode: on のときのみ）**

`review_runner` は project → global → legacy 自動解決の順で独立して解決する。固定名または `"ask"`
で選んだ runner は `REVIEW_POLICY=fixed` となり、設計と同じ engine でもよい。同じ専用ペインが
Phase A-R/B-R を通して使われる。key が両レイヤーに無い場合だけ v1.17.0 のクロスエンジン自動解決を
`REVIEW_POLICY=legacy` として維持する。どちらも `REVIEW_RUNNER / REVIEW_ENGINE / REVIEW_MODEL /
REVIEW_PANE_AGENT` を prompt に明示し、下流で engine の関係を再計算しない。`review_mode=on` でも
review-capable runner が無いタスクは警告してそのタスクだけ review を無効化し、config は書き換えない。

- **レビューポイント**: plan モード = plan 完成後の 1 回 / superpowers モード = spec（design doc）
  完成後と plan 完成後の 2 回
- **ラウンドループ**（各ポイント最大 5 往復）: 依頼 → 解決済みレビューペインが
  `<STATUS_DIR>/review/<point>-round-<N>.md` に指摘を書き、末尾に `VERDICT: approve` または
  `VERDICT: needs_work` を記す → approve なら次へ / needs_work なら設計セッションが妥当な指摘を反映
  （反論は次ラウンドの依頼文に理由付きで返す）して再依頼
- **依頼配送**: `send-prompt.sh`（`--label review-plan`）の 1 回呼び出しで依頼し、verdict はファイルポーリング
  （5 秒間隔・15 分チャンク。レビュアーが活動している限り**上限なし**で待機。依頼直後に
  `cmux read-screen --workspace/--surface` でレビューペイン画面の baseline を取得し、チャンク境界
  ごとに verdict を再確認 → 画面を再取得（`read-screen` は非フォーカス workspace でも live な内容を
  返すため refresh は不要 — 実測確認済み。失敗・空出力は 10 秒間隔で最大 3 回リトライ）して差分
  比較。変化あり = 作業中なので snapshot を更新して待機継続、変化なし = stalled、全リトライ失敗は
  観測失敗であり 2 回連続の境界で全失敗したときのみ stalled 扱い）で待つ —
  agmsg push 単独では idle なレビューペインは起きず、
  返信 push も idle 待ちのこのセッションを起こせないため。`send-prompt.sh` は依頼文を
  レビューペインへタイプ入力し、`--agmsg-to <review-agent>` の ready sentinel が生きていれば
  同一文を inbox にも記録し、400 文字超は outbox へ退避してポインタだけをタイプする
  （`<review-agent>` には解決済み `REVIEW_PANE_AGENT` を使う。現行トポロジーでは設計 engine に
  かかわらず専用 `<slug>-review` であり、`<slug>-claude` は Phase B の claude executor に限る。
  prewarm.json の `review.delivery` で分岐する必要はない — sentinel の確認は `send-prompt.sh`
  自身が送信直前に行う）
- **5 往復で approve が出ない** → 残指摘を要約して AskUserQuestion（このまま進む / さらに修正）
- **stalled（1 チャンク画面変化なし / 2 回連続観測不能）・verdict 不正** → verdict を最終確認
  してから同一ラウンドを 1 回だけ再依頼（baseline 取り直し）。それでも stalled なら
  AskUserQuestion（再依頼 / レビュー省略して Phase B へ）
- **ペイン寿命**: 全ポイントで同一ペインを再利用（文脈保持）。最終 approve（またはユーザー判断）
  後もレビューペインは開いたまま idle 維持し、途中で close しない。spawn 失敗時は警告して
  この quality gate をスキップし、dispatch を止めず Phase B へ進む
- **prewarm 無効時**: 最初のレビューポイントで
  `launch-workspace.sh --mode review --standby-split-direction right` によりオンデマンド spawn

**Phase B: 実装フェーズのモデル選択（auto mode でも必須）**

Phase A 完了後、コード変更を始める前に task prompt が解決した方式に従う。`exec_choice` が未設定または
`"ask"` なら `AskUserQuestion` で以下を聞き、固定値なら質問なしで対応する既存分岐を実行する。
**未設定**（明示 `"ask"` ではない）の場合のみ、選択の回答直後に永続化確認をもう 1 問出す
（今回のみ / 常にこの選択 [`exec_choice="<選択値>"` をグローバル config へ保存] / 常に毎回選ぶ
[`exec_choice="ask"` を保存し以後この確認を出さない]。回答は今回の分岐に影響せず選んだ engine で
直ちに続行。並列 child の同時書き込みは last-write-wins）。下表は **design=claude**
の挙動。**design=codex** のタスクでは両方の選択肢を pre-warm ペインへ委譲し現セッションでは実装
しない（上記「codex 設計 variant」参照、in-session 例外も同様に適用される）:

| 選択肢 | 表示条件 | 動作 |
|--------|---------|------|
| **claude** | 常時 | **in-session 判定**: 実行 role の engine / model / effort が設計 role と完全一致（`EXEC_ENGINE == DESIGN_ENGINE && EXEC_MODEL == PLAN_MODEL && EXEC_EFFORT == PLAN_EFFORT`）なら現セッション継続、そうでなければ解決済み claude executor へ委譲（`prewarm.json` を確認し、pre-warm 済み standby ペインがあればそちらへ実行指示を送信、無ければ `launch-workspace.sh --mode execute` で spawn。下記参照）。実在する未使用paneは最終cleanupまでidle維持 |
| **codex** | `runners.json` に `engine: codex` の runner が **1 件以上ある時のみ** | claude と同じ in-session 判定を適用する。in-session でなければ `prewarm.json` を確認し、pre-warm 済み standby ペインがあればそちらへ実行指示を送信、無ければ `launch-workspace.sh --mode execute --runner <codex-runner>` で spawn |

effort を判定条件に含めるのは、effort がセッション起動時に焼き込まれ後から変更できないため。
model だけを比較すると、実行フェーズが設計セッションの effort のまま走り `exec_effort` が
無視されてしまう。

**Codex の起動安全性**

`superpowers` / `plan` / `execute` / `standby` の Codex は approval prompt を防ぐため
`--dangerously-bypass-approvals-and-sandbox` を使う。一方、review ペインは sandbox を完全 off にせず
`--sandbox workspace-write`、`-c approval_policy='never'`、`--add-dir <STATUS_DIR>` を3点セットで指定する。
これにより approval prompt を抑止しつつ、worktree 外の `<STATUS_DIR>/review/` への findings 書込みだけを許可する。

**in-session 実行時のペイン**

`prewarm.json` に存在する未使用の standby/review ペインは **閉じずに
開いたまま idle 維持** する。固定 `exec_choice` では未選択 executor 自体を作らない。未 assigned pane は `.assigned-<name>` sentinel を
持たないため status.json を汚さない。全ペインは最終の全タスク完了クリーンアップでまとめて閉じる。

**pre-warm 済み executor ペインがある場合（claude / codex 共通の分岐）**

`<EXISTING_STATUS_DIR>/prewarm.json` の `.executors.claude.surface_id` /
`.executors.codex.surface_id` が非空なら:

1. `prewarm.json` に実在する未使用 pane は **閉じずに開いたまま idle
   維持** する。`.assigned-<name>` の無い standby は status.json を汚さないため、開いた
   ままでも観測に影響しない。全ペインは最終の全タスク完了クリーンアップでまとめて閉じる
2. `touch "<EXISTING_STATUS_DIR>/.assigned-<task-slug>-claude"`（claude 選択時）または
   `.assigned-<task-slug>-codex`（codex 選択時） — 完了処理（status.json done/error 遷移 +
   `<slug>-claude-done` / `<slug>-codex-done` シグナル + 親通知）の所有権を standby wrapper に渡す
3. 実行指示（`Read and execute the plan at <PLAN_FILE_PATH>. ...` + exit 指示。
   完了報告は `report-status.sh <status-dir> done <要約>` の呼び出しが担い、セッション終了には
   依存しない。exit 指示は engine で分ける — **claude は「run /exit」、codex は「停止して idle の
   まま待て」**。codex には自セッションを終わらせる手段が無い（`/exit` は効かず quit/shutdown
   サブコマンドも無い）ため、終了を前提にすると status が `executing` のまま固まる。完了報告を
   子の責務に切り出したことで、セッションが終わるかどうかと完了検知が分離されている
   （spawn 経路で `launch-workspace.sh` が焼き込む COMPLETION_INSTRUCTION と同じ）。
   **Phase B-R 有効時は「PR 作成前にコードレビュー approve を得る」プロトコル入りの拡張版**）を
   `send-prompt.sh` の 1 回呼び出しで送信する:

   ```bash
   bash <SKILL_DIR>/scripts/send-prompt.sh --to-surface "$SURFACE" \
     --agmsg-team "$TEAM" --agmsg-to <task-slug>-claude|-codex --agmsg-from <task-slug> \
     --label phase-b-exec --outbox-dir "<EXISTING_STATUS_DIR>/outbox" \
     -- "$REQUEST_TEXT"
   ```

   タイプ入力は常に行われ（idle なペインを起こせるのはこれだけ）、宛先の ready sentinel が
   生きていれば同一文が inbox にも記録される。400 文字超の指示は outbox へ退避され 1 行の
   ポインタだけがタイプされるので、長文が貼り付け判定されて入力欄に詰まることはない。
   `$TEAM` は親が Step 1g で解決した agmsg team 名をそのまま使う（子セッションは worktree 内で
   動作するため、worktree の basename から再導出すると誤った値になる）。`$TEAM` が空なら
   `--agmsg-*` の 3 フラグごと省略する。`prewarm.json` の `.executors.claude.delivery` /
   `.executors.codex.delivery` で分岐してはならない — sentinel の再確認は `send-prompt.sh` 自身が行う
4. `touch "<EXISTING_STATUS_DIR>/.deferred"`。Phase B-R 有効時は fixed/legacy resolver で
   surface/workspace/runner/engine の一貫した reviewer tuple を解決し、その surface が自分自身の
   場合だけレビュアーとして idle 待機する。固定 policy の設計ペインを含む、それ以外は exit する

**prewarm.json が無い場合（従来の spawn フォールバック、prewarm off）**

「異なる model」が選ばれた場合の spawn 手順 (Child セッション側の動作):

```bash
# Phase A の Child が以下を実行
zsh <skill-dir>/scripts/launch-workspace.sh \
  --cwd "$PWD" \
  --mode execute \
  --plan-file <PLAN_FILE_PATH> \
  --runner "$EXEC_RUNNER" \
  [--model "$EXEC_MODEL"] \
  --skip-permissions \
  --status-dir "<EXISTING_STATUS_DIR>" \
  --parent-notify-workspace <PARENT_WORKSPACE_ID> \
  [--parent-notify-surface <PARENT_SURFACE_ID>] \
  [--review-config "<EXISTING_STATUS_DIR>/review/code-review.json"]  # Phase B-R 有効時のみ
  <task-slug>-exec

# Phase B-R 有効時は、下記 Phase B-R resolver を実行してから配線ファイルを書く。
# fixed は専用 review surface + REVIEW_RUNNER/ENGINE。legacy は6ケースに従い、review pane を
# 選ぶケースでは REVIEW_SURFACE + REVIEW_RUNNER/ENGINE、design pane を選ぶケースでは
# CMUX_SURFACE_ID + DESIGN_RUNNER/ENGINE を組み合わせる。surface と runner/engine を混在させない:
#   mkdir -p "<EXISTING_STATUS_DIR>/review"
#   jq -n --arg s "$REVIEWER_SURFACE" --arg w "$REVIEWER_WORKSPACE" \
#     --arg r "$REVIEWER_RUNNER" --arg e "$REVIEWER_ENGINE" --arg d "<EXISTING_STATUS_DIR>/review" \
#     '{reviewer_surface: $s, reviewer_workspace: $w, review_dir: $d,
#       reviewer_runner: $r, reviewer_engine: $e}' > "<EXISTING_STATUS_DIR>/review/code-review.json"
# review pane spawn 失敗で REVIEWER_SURFACE が空なら --review-config を省略し、そのgateだけをskipする。

# spawn 完了後、自身は移譲シグナルを書く。Phase B-R 有効かつ YOU がレビュアーのケースは
# exit せずレビュアーとして待機、それ以外は exit
touch "<EXISTING_STATUS_DIR>/.deferred"
```

全選択肢で `EXEC_RUNNER / EXEC_ENGINE / EXEC_MODEL` の解決値を使う。Codex でも先頭 runner を
取り直さない。design/review/exec の non-prewarm spawn はそれぞれ `--runner "$DESIGN_RUNNER"` /
`--runner "$REVIEW_RUNNER"` / `--runner "$EXEC_RUNNER"` を必ず渡し、claude の既定値へ落とさない。

孫セッションの runner wrapper が `status.json` を `done`/`error` に遷移させ、`cmux wait-for --signal <task-slug>-exec-done` を発火し、親に `[dispatch] task ... finished` を送る。Child は `--defer-status` 付きで起動されているため `.deferred` センチネルを検知して status 上書きをスキップする (これにより孫の通知が握り潰されない)。

**Phase B-R — 実装後コードレビュー（review_mode: on のときのみ）**

実装完了（コミット済み）後・**PR 作成前**にコードレビューを挟む。有効化条件は Phase A-R と
完全に同一（新しい config キーは無い）。レビューポイント id は `code`、findings は
`<STATUS_DIR>/review/code-round-<N>.md`（末尾 `VERDICT: approve` / `VERDICT: needs_work`）、
最大 5 往復 — Phase A-R と同一プロトコル。

**レビュアー割り当て**: `REVIEW_POLICY=fixed` では Phase A-R と同じ専用 review pane が全実装を
レビューし、同一 engine の実装者/レビュアーも有効。設計ペインは委譲後 `.deferred` を touch して
exit し、レビュアーへ転じない。`REVIEW_POLICY=legacy` のときだけ次の従来配置を resolver 出力として使う:

- 実装者 engine == 設計 engine → **レビューペインがレビュー**（REVIEWER_SURFACE = prewarm.json
  `.review.surface_id`）
- 実装者 engine != 設計 engine → **設計セッション（YOU）がレビュー**（REVIEWER_SURFACE = 自身の
  `$CMUX_SURFACE_ID`）

legacy の設計 engine × Phase B 選択 6 ケース:

| 設計 engine | Phase B 選択 | 実装者 | レビュアー | REVIEWER_SURFACE |
|------------|-------------|-------|-----------|------------------|
| claude | claude, in-session | 現セッション（claude, in-session） | codex レビューペイン | prewarm.json `.review.surface_id` |
| claude | claude, 委譲 | claude executor standby | codex レビューペイン | prewarm.json `.review.surface_id` |
| claude | codex | codex standby | 現セッション（設計 claude, YOU） | 自身の `$CMUX_SURFACE_ID` |
| codex | claude | claude executor ペイン（agent `<slug>-claude`） | 現セッション（設計 codex, YOU） | 自身の `$CMUX_SURFACE_ID` |
| codex | codex, in-session | 現セッション（codex, in-session） | claude review ペイン（`<slug>-review`） | prewarm.json `.review.surface_id` |
| codex | codex, 委譲 | codex standby | claude review ペイン（`<slug>-review`） | prewarm.json `.review.surface_id` |

行の分岐原則は上の「実装者 engine == 設計 engine → レビューペインがレビュー / != → 設計セッション
（YOU）がレビュー」そのもの。in-session か委譲かは実装者の所在を変えるだけでレビュアー割り当てには
影響しない。

- **YOU がレビュアーのケース**: 設計セッション（Child）は `.deferred` を touch した後 exit せず
  idle 待機。実装者が各ラウンドでレビューを依頼（`send-prompt.sh --label review-code` の 1 回
  呼び出し。常にタイプ入力し、agmsg watcher 生存時は加えて inbox にも記録）し、実装者は verdict ファイルを
  ポーリング（5 秒間隔・15 分チャンク。レビュアー pane の read-screen 画面差分による生存確認付きで
  活動中は上限なしに待機 — Phase A-R と同一プロトコル）で待つ。設計セッションは round ごとに
  findings を書き、approve を書いた時点で exit する
- **レビューペインがレビューするケース**: in-session 実装（claude/codex いずれも）は Phase A-R の
  Round loop をポイント id `code` でもう 1 周（同一レビューペイン再利用、依頼文は「文書」でなく
  「ブランチの diff + plan 参照」）。委譲実装（claude executor standby / codex standby）は
  実装者が拡張版 REQUEST_TEXT でレビューペインへ依頼する。レビューペインが利用不可（Phase A-R
  spawn 失敗済み）ならレビュー省略
- **prewarm 経路のレビュー並列指示**: 拡張版 REQUEST_TEXT には実装者向け（`--mode execute`）に
  加えてレビュアー向け（`--mode review --engine "$REVIEW_ENGINE"`）のディレクティブも埋め込み、
  実装者がレビュー依頼文に転記する。レビューペインは `--mode review` で起動しており起動
  プロンプトにディレクティブを持たないため、これが prewarm 経路で唯一の注入点になる。
  引用部分の前後には宛先マーカー（`Also include this in the message to the reviewer` …
  `End of the message to the reviewer.`）を付け、実装者が自分宛と誤読しないようにする
- **修正責任**: needs_work の指摘は実装者自身が修正して再依頼する（却下する指摘は反論を
  次ラウンドの依頼文に添える）。approve 後に実装者が PR を作成する — PR は常にレビュー済みになる
- **5 往復で approve が出ない**: 実装者が claude セッションなら AskUserQuestion
  （このまま PR 作成 / さらに修正）。codex 実装者は対話質問ができないため、未解決指摘を
  **PR 本文に注記して続行**する
- **stalled（1 チャンク画面変化なし / 2 回連続観測不能）**: verdict を最終確認してから同一ラウンド
  を 1 回だけ再依頼（baseline 取り直し）。それでも stalled なら claude 実装者は AskUserQuestion
  （再依頼 / レビュー省略して PR 作成）、codex 実装者はレビューを省略し PR 本文に注記する
- **status.json 非汚染**: done/error 遷移の所有権は従来どおり実装者ペインの wrapper が持つ。
  レビュアーが設計セッション（YOU）のケースは `.deferred` 済みのため exit しても status.json を
  書かない
- **孤児ガードは不要**: 実装者がレビューを依頼せず終了しても設計セッションは idle のまま無害に
  残り、最終の全タスク完了クリーンアップで他ペインと一緒に閉じられる
- **spawn 経路（prewarm 無効）**: 設計セッションが `<STATUS_DIR>/review/code-review.json`
  （`{reviewer_surface, reviewer_workspace, review_dir, reviewer_runner, reviewer_engine}`。`reviewer_surface` は上表の REVIEWER_SURFACE =
  YOU がレビューするケースは自身の surface、レビューペインがレビューするケースはレビューペインの
  surface。`reviewer_workspace` はレビュアー側の workspace — 実装孫は別 workspace に spawn される
  ため、依頼配送（`send-prompt.sh --to-workspace`）と read-screen の生存確認はいずれもこの値を
  明示して行う）を書き、
  `launch-workspace.sh --mode execute --runner "$EXEC_RUNNER" --review-config <path>` で実装者を起動する。wrapper が
  composed prompt にレビュープロトコル（依頼は `send-prompt.sh` の 1 回呼び出し + ファイルポーリング）を追記する

### plan モードの遵守ゲート（ExitPlanMode hook）

標準 plan モードでは ExitPlanMode 承認直後に「プランを実行せよ」という強いシステム指示が
入り、上記シーケンスがスキップされることがある。これを防ぐため、`launch-workspace.sh` は
`--mode plan` かつ claude engine のときのみ、worktree の `.claude/settings.local.json` に
PostToolUse hook（matcher: `ExitPlanMode`、command:
`zsh <skill-dir>/scripts/plan-approved-hook.sh`）を注入する。hook は承認直後に「ファイル
編集前に Phase A-R（有効時）→ Phase B を実行せよ」という additionalContext を機械的に
再注入する。

- ベストエフォート: settings 書き込み・マージ失敗は警告のみで dispatch を止めない
  （プロンプト側の指示がフォールバック）。既存 settings.local.json は jq でマージし、
  worktree 再利用時に重複注入しない
- 誤コミット防止: `.claude/settings.local.json` と plan 保存先 `.claude/plans/` は repo 共有の
  `info/exclude` に追記される（plan ファイルは `--plan-file` のパス渡しで使う作業物であり、
  子の `git add -A` でタスクブランチにコミットさせない）
- hook は worktree の settings.local.json に残存するため、同一 worktree を再利用する後続
  セッション（Phase B の execute 孫を含む）にも作用する。それらは plan モードを使わないため
  実害はない
- superpowers モード / codex engine / execute・standby・review モードでは注入されない

### Launch: workspace モード（デフォルト）

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

### Pre-warm Standby Panes（workspace レイアウトのみ）

config から `prewarm` を読む（project config → global config の順。デフォルト `true`）:

```bash
PREWARM=$(jq -r '.prewarm // empty' .dispatch/config.json 2>/dev/null)
[[ -z "$PREWARM" ]] && PREWARM=$(jq -r '.prewarm // "true"' \
  ~/.claude/cmux-team-dispatch-task/config.json 2>/dev/null)
[[ -z "$PREWARM" ]] && PREWARM=true
```

レイアウトが `workspace` かつ `PREWARM` が `true` のときは、解決済み role のペインだけを起動する。
`design` は常に1件、`review` は有効時だけ、`executors` は `exec_choice` が固定なら選択済みの1件だけ、
未設定/`"ask"` なら提示する互換候補をすべて起動する。`executors` が保持できるキーは
`claude` / `codex` の最大2つで、Codex design では `CLAUDE_EXEC_RUNNER` を使う claude executor と、
`CODEX_EXEC_RUNNER` を使う Codex executor をそれぞれ作る。in-session 判定が成立するときは
`executors` が空（`{}`）になり executor ペインは 1 つも起動しない。固定 review は design と
同じ engine でもよい。

ペイン配置は 2 行のグリッド。design が workspace のメイン surface を持ち、review は design から
`right` split、実装ペインはその下の行に並ぶ（1 つ目は design から `down` split、2 つ目以降は
直前の実装ペインから `right` split）。実装 2 件 + review でちょうど 2×2 になり、固定
`EXEC_CHOICE` なら design の下に実装 1 件・その右に review という配置になる。

ペイン作成はすべて `prewarm-panes.sh` に委譲し、手動で作成しないこと。

**agmsg 未インストール（`$TEAM` が空）** — design セッションはすでにワークスペース起動時に
タスクプロンプト付きで起動済み。その下に claude/codex executor ペインを追加する（その起動の出力
JSON から `workspace_id` / `surface_id` を取得）:

```bash
bash <this-skill-dir>/scripts/prewarm-panes.sh \
  --workspace <workspace-id> --base-surface <surface-id> \
  --cwd "<repo-root>/.worktrees/<task-slug>" \
  --slug <task-slug> \
  --status-dir "$(pwd)/.dispatch/<task-slug>" \
  [--claude-runner "$CLAUDE_EXEC_RUNNER"] \
  [--codex-runner "$CODEX_EXEC_RUNNER"] \
  [--exec-runner "$EXEC_RUNNER"] \
  --design-runner "$DESIGN_RUNNER" \
  [--reviewer-runner "$REVIEW_RUNNER"] \
  --exec-choice "$EXEC_CHOICE" \
  --parent-notify-workspace "$CMUX_WORKSPACE_ID" \
  --parent-notify-surface "$CMUX_SURFACE_ID"
```

**agmsg インストール済み（`$TEAM` が非空）** — 通常のワークスペース起動（タスクプロンプト付き
起動）は行わない。代わりにすべてのペイン（design を含む）がタスクメッセージなしのアイドル状態で
起動し、Phase A のタスクは後から `send-prompt.sh` で配送される（常にタイプ入力し、agmsg 配線
生存時は inbox にも記録）。`prewarm-panes.sh` が worktree を作成し、agmsg delivery
配線（join + `delivery.sh set`。いずれのペインが起動するより前に行う）を済ませてから design の
standby workspace を起動し、その下に claude/codex executor を積む。配線に失敗したタスク
（`delivery: "cmux-send"` フォールバック）では、design / claude executor の初期プロンプトは
`/agmsg actas` を含まない「指示はこのペインに直接タイプされる」という文面に切り替わる
（不要な actas / watcher 起動を避けるため。配線成功時のプロンプトも「タスクはタイプ入力で
届く（inbox に同一コピーあり）」という文面で、agmsg push 単独で届くとは伝えない）:

```bash
RESULT=$(bash <this-skill-dir>/scripts/prewarm-panes.sh \
  --with-design \
  --cwd "<repo-root>/.worktrees/<task-slug>" \
  --slug <task-slug> \
  --status-dir "$(pwd)/.dispatch/<task-slug>" \
  [--claude-runner "$CLAUDE_EXEC_RUNNER"] \
  [--codex-runner "$CODEX_EXEC_RUNNER"] \
  [--exec-runner "$EXEC_RUNNER"] \
  --design-runner "$DESIGN_RUNNER" \
  [--reviewer-runner "$REVIEW_RUNNER"] \
  --exec-choice "$EXEC_CHOICE" \
  --agmsg-team "$TEAM" \
  --parent-notify-workspace "$CMUX_WORKSPACE_ID" \
  --parent-notify-surface "$CMUX_SURFACE_ID")
```

**タスクごとのフラグ選択**: `--design-runner "$DESIGN_RUNNER"` と
`--exec-choice "$EXEC_CHOICE"` は常に渡す。固定 choice は claude/codex のいずれでも
`--exec-runner "$EXEC_RUNNER"` を渡す。unset/ask は resolver が選んだ互換候補を
`--claude-runner "$CLAUDE_EXEC_RUNNER"` / `--codex-runner "$CODEX_EXEC_RUNNER"` で渡す。
Codex design の claude executor は review runner から推測しない。review 有効なら
`--reviewer-runner "$REVIEW_RUNNER"` を渡す。
固定 `exec_choice` の runner が利用不能なら、その config レイヤーだけを無効化して project → global →
interactive のフォールバックを続ける。

review pane の起動・出力解析が失敗した場合、`prewarm-panes.sh` は join 済み review member を即 leave
してから警告し、`review` key を省略して既に起動した design/executor を `prewarm.json` に保持したまま
Phase B を続行する。

通常のタスクプロンプト起動がこのモードでは走らないため、`prewarm-panes.sh` 自身がペイン作成
直後に初期 `"launched"` status.json（`workspace_id` / `surface_id` 込み）を書き出す。これにより
`.dispatch/<task-slug>/status.json` は即座に観測可能になる。

続けて Phase A のタスクを design ペインへ配送する:

1. タスクプロンプト全体（PROGRESS REPORTING FORMAT、MANDATORY MODEL SELECTION SEQUENCE、
   および Step 2 の agmsg ステータスプロトコルブロック — その必須完了通知
   （`send-prompt.sh` の 1 回呼び出し）が親への通知を担う — を含む）を
   `<repo-root>/.worktrees/<task-slug>/.cmux-team-dispatch-task-prompt.md`
   に書き込む。
2. `touch .dispatch/<task-slug>/.assigned-<task-slug>` — これ以降、design standby wrapper が
   status.json 遷移の所有権を持つ（`--defer-status` 付きで起動しているため、Phase B への
   ハンドオフが必要な場合でも `.deferred` でこれを抑止できる）。
3. タスクを `send-prompt.sh` の 1 回呼び出しで送信する（Step 1g の配送規約を参照）。
   slash command は agmsg 経由では発火できず、ここでタイプさせたいわけでもないので、
   モードは `/plan` のようなコマンドではなくメッセージ本文として伝える:

   ```bash
   TASK_TEXT="Read and follow the task in .cmux-team-dispatch-task-prompt.md. Mode: <plan|superpowers> — for superpowers invoke the superpowers:brainstorming skill first; for plan produce a structured plan before implementing."
   DESIGN_SURFACE=$(jq -r '.design.surface_id // empty' "$(pwd)/.dispatch/<task-slug>/prewarm.json")
   bash <this-skill-dir>/scripts/send-prompt.sh --to-surface "$DESIGN_SURFACE" \
     --agmsg-team "$TEAM" --agmsg-to <task-slug> --agmsg-from parent \
     --label phase-a-task --outbox-dir "$(pwd)/.dispatch/<task-slug>/outbox" \
     -- "$TASK_TEXT"
   ```

   `$TEAM` が空なら `--agmsg-*` の 3 フラグごと省略し、prewarm.json の `.design.delivery` で
   分岐してはならない — ready sentinel の確認は `send-prompt.sh` 自身が行う。その sentinel
   （`~/.agents/skills/agmsg/run/ready.<team>__<agent>`）は agmsg の watch.sh が
   そのロールを受信中の間だけ作成するファイル。team / agent 名は `[A-Za-z0-9._-]` の slug
   なのでパスのエンコードは不要。sentinel が判定するのは inbox 記録を行うかどうかだけであり、
   示しているのは「watcher プロセスが生きている」ことだけで「そのペインを起こせる」ことでは
   ない（idle セッションへ注入できる仕組みの下でも、注入できない素のバックグラウンドシェルの
   下でも、同じ sentinel が書かれる）。実際の配送はタイプ入力が担う。

`prewarm-panes.sh` が書き出す prewarm.json は role-aware で、実在ペインだけを含む。
参照は `.design` / `.review` / `.executors.claude|codex` を使う:

```json
{
  "design": { "surface_id": "surface:1", "agent": "<slug>", "runner": "codex", "engine": "codex", "role": "plan", "delivery": "agmsg" },
  "review": { "surface_id": "surface:2", "agent": "<slug>-review", "runner": "codex", "engine": "codex", "role": "review", "delivery": "agmsg" },
  "executors": {
    "codex": { "surface_id": "surface:3", "agent": "<slug>-codex", "runner": "codex", "engine": "codex", "role": "exec", "delivery": "agmsg" }
  }
}
```

all-Codex の例では plan/review/exec model がそれぞれ `gpt-5.6-sol` /
`gpt-5.6-sol` / `gpt-5.6-terra` で、3ペイン以外は起動しない。cleanup は
`.. | objects | .surface_id? // empty` と `.agent?` を `awk 'NF && !seen[$0]++'` で重複除去する。

`prewarm: false` はこのセクションを完全にスキップする —
Phase A/Phase A-R/Phase B はそれぞれオンデマンド起動時にも解決済み
`DESIGN_RUNNER` / `REVIEW_RUNNER` / `EXEC_RUNNER` を `--runner` で渡す。

## タスク内の並列実行

タスク同士は既に worktree 横断で並列に走っている。この節が扱うのは **1 タスクの中**の話で、
各子セッションに「独立した調査と検証は 1 件ずつ順にやらず、子エージェントへ分散させよ」と
指示する。

`scripts/parallel-directive.sh` がその文面の単一情報源である。

```
parallel-directive.sh --engine <claude|codex> --mode <plan|superpowers|execute|review> [--agents <N>]
```

- codex セッションには `spawn_agent` / `wait_agent` を、claude セッションには
  1 メッセージで複数の Task サブエージェントを起動することを指示する
- ファイル編集は常に親エージェントで逐次に保つ。実装の順序を制御するスキル
  （superpowers subagent-driven-development の「実装者は同時に 1 体」）は上書きしない
- 分散してよいのは**読み取り専用の検証だけ**。auto-fix / write モード
  （formatter や linter を write フラグ付きで走らせるもの）はファイルと共有ビルドキャッシュを
  書き換えるため、親エージェントで逐次に実行する
- `--agents` が同時実行の上限。2〜8 の整数のみで既定は 4
- `standby` モードは存在しない。standby ペインは実行系なので `--mode execute` を渡す
- `--agents` / `--no-parallel` は `launch-workspace.sh` のフラグ。このスキルは
  どちらも渡さないので、スキル経由のディスパッチには常に既定値が適用される

注入箇所:

| 対象 | 注入する側 |
|------|-----------|
| plan / superpowers / execute の起動プロンプト | `launch-workspace.sh`（`--no-parallel` で抑止） |
| standby ペインへ送る Phase B 実行指示 | このスキル（スクリプト経由） |
| Phase A-R のレビュー依頼 | このスキル（スクリプト経由） |
| Phase B-R のレビュー依頼（prewarm 経路） | このスキル（スクリプト経由） |
| Phase B-R のレビュー依頼（spawn 経路） | `launch-workspace.sh`（`review/code-review.json` の `reviewer_engine` から） |

ある engine 向けに生成したディレクティブを、別 engine のセッション宛のテキストの中に
埋め込むとき（実装者のプロンプトに同梱するレビュアー向けディレクティブがこれにあたる）は、
宛先を明示的にマークする。位置だけでは境界にならず、claude セッションに `spawn_agent` を
指示してもそのツールは存在しない。

## Step 3: 監視と完了

通知ベースの監視 → 結果収集 → レポート生成 → マージ/クリーンアップ。

### 通知ベースの監視（主経路）

**監視方法は agmsg がインストールされているかで決まる（Step 1g）:**

- agmsg 未インストール: 従来どおり `monitor-dispatch.sh` を起動（heartbeat / DIED 検知 / 全完了通知）
- agmsg インストール済み: `monitor-dispatch.sh` を**起動しない**。完了通知は
  `send-prompt.sh` がこのペインへタイプ入力するテキストとして届き、このセッションの watcher が
  生きていれば同一文が agmsg inbox にも記録される。実際に idle な親セッションを起こすのは
  タイプ入力の方で、inbox のコピーはログにすぎない。長時間通知が
  無い場合は `.dispatch/*/status.json` を手動ポーリングで確認する。`[dispatch-monitor]` 系の
  heartbeat / DIED メッセージはこの場合には存在しない。通知は3系統から届く: 子が
  status.json 書き込み直後に自分で送るもの（必須、Step 2 参照）、runner wrapper が子と並行して
  走らせる status.json watcher（セッションが終了しなくても terminal 遷移で発火する）、
  runner wrapper がセッション終了時に送るもの（バックストップ）。同じ完了通知が複数回
  届くのは正常な挙動であり、通知は冪等に扱い、status.json を信頼できる情報源とすること

1. **通知ベースの監視（推奨）**:
   ランナースクリプトが `send-prompt.sh` 経由で親ターミナルにメッセージを送信:
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
     --parent-workspace "$CMUX_WORKSPACE_ID" \
     --interval 10 \
     --heartbeat-interval 60 \
     --dispatch-dir "$(pwd)/.dispatch"
   ```

### バックグラウンドプロセスのヘルスチェック

モニターが死亡した場合は `--resume` で再起動できる（既に done/error のタスクは再通知されない）:
```bash
PID=$(cat .dispatch/.monitor.pid)
kill -0 "$PID" 2>/dev/null || zsh <this-skill-dir>/scripts/monitor-dispatch.sh \
  --parent-workspace "$CMUX_WORKSPACE_ID" \
  --dispatch-dir "$(pwd)/.dispatch" \
  --resume
```

### ステータスファイルのポーリング（手動確認）

3. **ステータスファイルのポーリング（手動確認）**:
   ```bash
   for f in .dispatch/*/status.json; do
     task_name=$(dirname "$f" | xargs basename)
     task_status=$(jq -r '.status' "$f" 2>/dev/null || echo "unknown")
     message=$(jq -r '.message' "$f" 2>/dev/null || echo "")
     echo "$task_name: $task_status - $message"
   done
   ```

### 画面の直接読み取り（オンデマンド）

4. **画面の直接読み取り**:
   - workspace モード: `cmux read-screen --workspace <workspace-id> --scrollback`

### When to Intervene（介入のタイミング）

- **ステータスが "error"**: エラーメッセージとセッション画面を確認し、リトライまたはエスカレーションを提案
- **長時間応答なし**: 通知が長時間来ない場合、ステータスファイルのポーリングや画面の直接読み取りで確認
- **ユーザーリクエスト**: ユーザーはいつでも特定のセッションの確認を依頼可能

### Completion（完了レポート）

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

### Integration and Cleanup（統合とクリーンアップ）

Step 1e で選択した統合戦略に応じて動作が異なります。

#### When integration strategy is "Wait and merge"

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

1. `.dispatch/` ディレクトリのみ削除。`config.json` はプロジェクト config レイヤーであって
   ディスパッチの生成物ではないため、唯一残す:
   ```bash
   if bash <this-skill-dir>/scripts/issue-fetch.sh --state-file .dispatch-loop/loop-state.json lock-check; then
     [[ -d .dispatch ]] && find .dispatch -mindepth 1 -maxdepth 1 ! -name config.json -exec rm -rf {} +
   else
     echo "<.dispatch/ の一括削除をスキップ: issue ループが実行中>" >&2
   fi
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

#### When integration strategy is "PR per task"

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

   すべて「保持」を選んだ場合は `.dispatch/` の掃き出し（`config.json` は残す）のみで、
   worktree とブランチは残る。
   手動で後から削除するコマンドは「Wait and merge の『マージしない場合』」と同じ。

### Cleanup prompts — 親セッションのクリーンアップ確認（両戦略共通）

すべての子セッションが `status: done` に到達した後、**親セッション** がまとめて 3 問聞き、
全タスクに同じ回答を適用する。子セッションは削除も質問も行わない。
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

  # status.json はこの id の信頼できる情報源ではない。子セッション自身が書く
  # done/error は 3 フィールドの echo なので workspace_id/surface_id を消す。
  # runner wrapper はセッション終了時にしか書き戻さず、codex TUI が終了指示を
  # 無視して idle 残留すると終了自体が起きない。workspace 名（prewarm-panes.sh が
  # slug を設定する）から引き直す。
  if [[ -z "$workspace_id" ]]; then
    workspace_id=$(cmux workspace list 2>/dev/null \
      | awk -v s="[$slug]" 'index($0, s) {print $1; exit}')
  fi

  # 1) タスクの workspace を先に閉じる
  if [[ "$close_all" == "true" && -n "$workspace_id" ]]; then
    cmux close-workspace --workspace "$workspace_id"
  fi

  # prewarm.json に実在する role pane を重複除去して閉じる
  # --workspace は必須。付けないと surface ref が親の $CMUX_WORKSPACE_ID に対して
  # 解決され、必ず "Surface ref not found" で失敗する。
  if [[ "$close_all" == "true" && -n "$workspace_id" && -f ".dispatch/$slug/prewarm.json" ]]; then
    for sf in $(jq -r '.. | objects | .surface_id? // empty' ".dispatch/$slug/prewarm.json" 2>/dev/null \
      | awk 'NF && !seen[$0]++'); do
      cmux close-surface --workspace "$workspace_id" --surface "$sf" 2>/dev/null || true
    done
  fi

  # 2) worktree を削除
  [[ "$remove_wt_all" == "true" ]] && git worktree remove ".worktrees/$slug" --force 2>/dev/null

  # 3) feature ブランチを削除
  [[ "$delete_br_all" == "true" ]] && git branch -D "feat/$slug" 2>/dev/null
done

# 4) 最終整理（回答に関わらず常に実行）。issue ループ稼働中は .dispatch/ を一括で消さない。
#    .dispatch/config.json は --setup が書くプロジェクト config レイヤーで、ディスパッチの
#    生成物ではないため掃き出し対象から外す。
if bash <this-skill-dir>/scripts/issue-fetch.sh --state-file .dispatch-loop/loop-state.json lock-check; then
  [[ -d .dispatch ]] && find .dispatch -mindepth 1 -maxdepth 1 ! -name config.json -exec rm -rf {} +
else
  echo "<.dispatch/ の一括削除をスキップ: issue ループが実行中>" >&2
fi
rmdir .worktrees 2>/dev/null
```

> pane/workspace → worktree → ブランチの順序は意図的。先に閉鎖することで worktree を
> 開いている shell が終了し、`git worktree remove` が確実に成功する。ブランチ削除は
> worktree 削除後に行う必要がある。
> 子セッション内で worktree を削除させると、親が削除を実行する時点ではまだ子プロセスが
> worktree を掴んだままで `git worktree remove` が失敗するため、すべて親側に集約している。

agmsg インストール時は、最終整理の際に子 agent を team から除籍する:

```bash
for slug in <task-slugs>; do
  while IFS= read -r agent; do
    [[ -n "$agent" ]] || continue
    ~/.agents/skills/agmsg/scripts/leave.sh "$TEAM" "$agent" 2>/dev/null || true
  done < <(jq -r '.. | objects | .agent? // empty' ".dispatch/$slug/prewarm.json" 2>/dev/null \
    | awk 'NF && !seen[$0]++')
done
```

親 (`parent`) は repo 固定 team に残す（次回 dispatch で再利用）。

---

## ステータスプロトコル

### status.json

```json
{
  "status": "launched",
  "workspace_id": "workspace:3",
  "surface_id": "surface:5",
  "message": "Runner session launched in plan mode (workspace layout)",
  "pr_url": "https://github.com/owner/repo/pull/123",
  "timestamp": "2026-04-07T16:00:00Z"
}
```

- `pr_url` は PR per task 戦略で PR 作成済みの場合のみ `done` で付与。
- クリーンアップ意思は `status.json` には記録しない。親がディスパッチ完了時に
  `AskUserQuestion` で一度だけ聞き（ワークスペース閉鎖 / worktree 削除 / ブランチ削除）、
  その回答を全タスクに適用する。子セッションは質問も削除も行わない。

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

## superpowers 統合（Execution Handoff 第3選択肢）

`superpowers:writing-plans` でプランが完成すると、Execution Handoff として3つの実行方法から選択:

```
1. Subagent-Driven (推奨)   → superpowers:subagent-driven-development
2. Inline Execution          → superpowers:executing-plans
3. Parallel (cmux)           → cmux-team-dispatch-task  ← THIS SKILL
```

### Parallel (cmux) を勧めるタイミング

（このセクションに対応する既存の日本語記述はありません。3つの実行オプションの使い分けの目安は SKILL.md の "When to Suggest Parallel (cmux)" 節の表を参照してください。）

### フロー

1. プランファイルからタスクを抽出
2. brainstorming 選択（プランから来た場合、brainstorming 完了済みなのでデフォルト「なし」）
3. レイアウト選択（デフォルト workspace、引数で override）
4. 起動・監視・完了

### プランからタスク JSON を組み立てる

（このセクションに対応する既存の日本語記述はありません。`superpowers:writing-plans` のプランファイルから `### Task N: <name>` 見出しをタスクとして抽出する手順は SKILL.md の "Building the Tasks JSON from a Plan" 節を参照してください。）

---

## 制約

- **cmux 必須**: `/Applications/cmux.app/` にインストールされている必要があります
- **同時セッション数**: 3〜5 セッションが推奨
- **ファイル競合**: 2つのタスクが同じファイルを変更してはいけません
- **完了シグナルは信頼性あり**: ランナースクリプトが `status.json` の更新とシグナル発火を保証。テキスト通知は `scripts/send-prompt.sh` 経由で配送され、タイプ後に Enter を押して `cmux read-screen` で入力欄が空になったことを確認するので、親 claude TUI の input box に滞留しない (確認が働くのは親が 0 桁目に `❯` / `>` のプロンプト行を描画している場合。該当行が無ければ検証なしで配送済み扱い)
- **codex 統合の前提**: `cmux codex install-hooks` 済みであること（`external_migration = true` と hooks がインストールされている）
- **配送**: 通知トランスポートの設定項目は無い。`message_type` は廃止され、`launch-workspace.sh` / `prewarm-panes.sh` の `--message-type` フラグも削除された (渡すと `was removed` で die する)。agmsg は `~/.agents/skills/agmsg/scripts/send.sh` が存在すれば必ず配線され、`monitor-dispatch.sh` は存在しないときだけ起動する (status.json はどちらでも不変)。すべてのメッセージは `scripts/send-prompt.sh` の 1 回呼び出しで配送する。**常に宛先ペインへタイプ入力し** (idle セッションを起こせるのはこれだけ)、`--agmsg-*` の 3 引数が揃い宛先の ready sentinel が存在するときは、タイプ入力を終えたあとに**同一本文を agmsg inbox にも記録する**（固まった agmsg 書き込みが唯一の wake 手段を塞がないよう順序は常にタイプ入力が先）。**agmsg push は inbox 記録専用で、idle セッションを起こせない**。ready sentinel が示すのは watcher プロセスの生存だけで、そのセッションを起こせることは示さない (idle セッションへ注入できる仕組みの下でも、注入できない素のバックグラウンドシェルの下でも、同じ sentinel が書かれる)。agmsg の失敗は配送の成否にも終了コードにも影響しない。400 文字超の本文は `<outbox-dir>/<label>-<seq>.md` へ書き出し 1 行のポインタだけをタイプするので、長文が貼り付け判定されて入力欄に詰まることはない。タイプ後は Enter を押し `cmux read-screen` で入力欄が空になったことを確認し、残っていれば最大 3 回 Enter を再送してから失敗を報告する。この確認は宛先が 0 桁目に `❯` (または `>`) のプロンプト行を描画している場合に働き、該当行が無いペインは画面を観測できない場合と同様に配送済み扱いにする (呼び出し元が再送して二重配送するのを防ぐため)。完了通知は2段構え: 子セッションが status.json 書き込み直後に送る必須通知 (Step 2 で子プロンプトに埋め込む) + runner wrapper の exit 時通知 (バックストップ)。idle TUI は exit しないため wrapper だけに頼ると通知されない。また Step 1g の `delivery.sh set` 出力に `AGMSG-DIRECTIVE:` 行があれば、ディスパッチ実行中のセッション自身の watcher 起動のため必ず従うこと。
- **Pre-warm role panes**: workspace レイアウト + config `prewarm: true` (default) のとき、`prewarm-panes.sh` が `design` / 任意の `review` / `exec_choice` が許可する実行 engine だけを起動する。`prewarm.json` の `executors` が保持できるキーは `claude` / `codex` の最大2つ。固定 `exec_choice` はもう一方の engine を抑止し、in-session 判定が成立するタスクは `executors` を空のまま保つ。model / effort は prewarm から `--model` / `--effort` として渡されることは無く、launcher 側の role fallback が解決する。

---

## 補足（SKILL.md に対応セクションなし）

以下は元の `guide-ja.md` に存在していた記述のうち、SKILL.md の 45 見出しに直接対応する節が
無いもの、または既存の別セクションへ委譲する形で本文中に短く要約されているものをそのまま
移設したものです。内容は削除・翻訳し直さず温存しています。

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
- **レイアウト**: 常に workspace（タスクごとに別タブ）
- **必須モデル選択フロー**: 子セッションは解決済み `DESIGN_RUNNER / PLAN_MODEL` で Plan/Brainstorming を実行後、`exec_choice` が未設定または `"ask"` なら選択し、固定値なら質問を省略する。委譲/spawn は必ず `EXEC_RUNNER / EXEC_MODEL` を使う
- **独立レビュー runner**: `review_runner` 固定時は同一 engine を許可し、Phase A-R/B-R を同じ専用ペインが担当。key 未設定時だけ従来クロスエンジン resolver を使う
- **Phase A-R（plan/spec レビュー）**: 解決済み review runner があり
  レビューを使うことを選んだとき（dispatch 前に毎回質問。config の `review_mode: "on"` / `"off"` で
  恒久設定も可）、Phase A の成果物（plan モード: plan / superpowers モード:
  spec と plan）を専用レビューペインがレビューする。approve まで最大 5 往復、超過時はユーザー判断
- **Phase B-R（実装後コードレビュー）**: `review_mode: on` のとき、実装完了後・PR 作成前に
  コードレビューを挟む。fixed は専用 review pane、legacy は既存6ケース。approve が出るまで実装者が修正（最大 5 往復）
- **統一表示フォーマット**: 子セッション一覧・進捗・最終サマリーは Box drawing 表（Template A/B/C）で常に同じレイアウト
- **堅牢なバックグラウンド監視**: `monitor-dispatch.sh` が heartbeat / 死亡通知 / `--resume` をサポート。配送は `send-prompt.sh` に一本化されており、長文は outbox へ退避し Enter の着弾も検証するので親 TUI に確実に届く
- **2つの統合戦略**: PR per task（子タスクごとに PR 作成）、Wait and merge（全タスク完了後にローカルマージ）
- `.dispatch/` ディレクトリを介したステータス通信で進捗を追跡
- プロンプトはファイル経由で渡すため、シェルエスケープの問題なし

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

### 設定（`--setup`）

```
/cmux-team-dispatch-task --setup
```

ディスパッチせずに設定だけを構成します。現在の設定（プロジェクト値 / グローバル値 / 解決値）と `runners.json` の一覧を表示したあと、書き込み先（グローバル / プロジェクト）と対象（役割キー / `runners.json` / 両方）を選び、役割キーごとに「固定値 / `"ask"` / 未設定に戻す / 変更しない」を指定します。最後に差分を確認してから 1 回の原子的な書き込みで反映します。

### 設定のリセット（`--reset`）

```
/cmux-team-dispatch-task --reset
/cmux-team-dispatch-task --reset runners
/cmux-team-dispatch-task --reset config
/cmux-team-dispatch-task --reset all
```

`runners` は `runners.json` を削除して初回セットアップをやり直し、`config` は役割キー 5 つだけを削除します（`shell_ready_ms` など他のキーは残ります）。対象を省略すると質問されます。`.dispatch/`・worktree・`feat/*` ブランチには一切触れません。

## アーキテクチャ

### レイアウト

レイアウトは常に `workspace`。タスクごとに独立した cmux workspace を作成する。

### 各レイヤーの役割

| レイヤー | 役割 |
|---------|------|
| **親セッション** | タスク収集、Agent 発見、brainstorming 選択、セッション起動、監視、レポート生成 |
| **子セッション/teammate** | Agent 選択、個別タスクの brainstorming・計画・実行。独立した Claude Code インスタンスとして動作 |
| **git worktree** | ブランチ分離。各タスクは `feat/<task-slug>` ブランチで作業 |
| **.dispatch/** | ファイルベースのステータス通信。子 → 親への進捗報告 |

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

## ターミナル起動待機の自動学習

<!-- send-prompt-exempt: TUI へのメッセージ配送ではなくシェルへのコマンド打鍵の説明 -->
子セッションのシェルが初期化される前に `cmux send` でコマンドを投入すると `sh` が失敗することがあります。これを避けるため、`launch-workspace.sh` は workspace 内の standby ペインでシェルプロンプトを検知してから実際のコマンドを送信します。検知にかかった実時間は config に記録され、次回以降の最大待機時間を適応的に決定します。

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

`prewarm` などのキーも同じ config ファイル（`.dispatch/config.json` /
`~/.claude/cmux-team-dispatch-task/config.json`）に並べて保持される（`message_type` は
廃止済みで、書いても読まれない）。役割キー 5 つを設定する経路は 3 通りある: ディスパッチ中の
「常に〜」の回答、`--setup`、手動編集。`--reset config` は役割キー 5 つだけを削除する。
どの経路も書き込みは `scripts/config-edit.sh` を通し、置換ではなくマージするため
`shell_ready_ms` のような他コンポーネント所有のキーは保持される:

```json
{
  "prewarm": true,
  "review_mode": "on",
  "design_runner": "codex",
  "review_runner": "codex",
  "exec_choice": "codex",
  "shell_ready_ms": { "baseline_ms": 1200, "samples": 5, "updated_at": "..." }
}
```

- `prewarm`: workspace レイアウト時の role pane 事前起動。固定 `exec_choice` では未選択 executor を抑止する。`true`（default）| `false`
- `review_mode`: Phase A-R（plan/spec レビュー）と Phase B-R（実装後コードレビュー）の制御（`"on"` / `"off"` / `"ask"`）。
  `"on"` / `"off"` は質問なしで恒久適用。未設定または `"ask"` のときは review-capable runner が
  解決済みの場合のみ **dispatch のたびに**使うかどうかを質問する（4択:
  はい[今回のみ] / いいえ[今回のみ] / 常に有効 / 常に無効。「常に〜」のみ `"on"` / `"off"` として
  グローバル config に永続化）。プロジェクト側 `.dispatch/config.json` がグローバルより優先
- `design_runner`: Step 1f の設計 runner 固定値。`runners[].name` に一致すれば runner 数にかかわらず
  switch / per-task 質問を両方省略して全タスクへ適用する。検証は **project / global のレイヤーごと**
  に行い、不正値は警告してそのレイヤーだけ無視して次へフォールバックする（project の不正値が
  global に保存済みの「常に〜」を遮蔽しない）。**未設定**（全レイヤー未設定または不正）は
  switch 質問が 4 択（いいえ[今回のみ] / はい[今回のみ] / runner 設定を保存 / runners.json reset）
  になる。保存の追加2択（常に既定 / 常に固定）のみグローバル config に `design_runner` を永続化する
  （`review_mode` と同じ writer 固有 mktemp + mv の jq merge）。明示 `"ask"` は 3 択（いいえ / はい /
  reset）で永続化オプションを再提示しない。reset は `RUNNERS_JSON` だけを削除し、両 config を保持して
  初回セットアップ後に Step 1f を再開する。戻し方は 2 通りで意味が異なる: `"ask"` へ書き換え =
  3 択のみ、キー削除 = 未設定に戻り 4 択が再表示
- `review_runner`: project → global → legacy 自動解決。固定 runner 名または `"ask"` は
  `REVIEW_POLICY=fixed`、両レイヤーに key が無い場合だけ `REVIEW_POLICY=legacy`。codex 候補は
  `review_model` 必須、claude 候補は `opus[1m]` fallback。同じ design engine も許可する。不正値は
  レイヤー単位で警告・無効化する
- `exec_choice`: Phase B の実行 engine 固定値。値は `"claude"` / `"codex"` / `"ask"` のみ
  （v1.20.0 より前の claude opus[1m] / sonnet を直接指定する値は廃止され、他の不正値と同様に
  そのレイヤーを無効化する）。`"claude"` / `"codex"` は AskUserQuestion を省略し既存の同じ分岐を実行する
  （`runners.json` に該当 engine の runner が無ければ固定値は無効）。検証は **project /
  global のレイヤーごと**に行い、選択 engine の runner が利用不能な固定値も警告してそのレイヤー
  だけ無視して次へフォールバックする。**未設定**（全レイヤー未設定または不正）はモデル選択の
  直後に子セッションが永続化確認（今回のみ / 常にこの選択 / 常に毎回選ぶ[= `"ask"` を保存]）を
  1 問出し、「常に〜」のみグローバル config に永続化する（writer 固有 mktemp + mv。並列 child の
  同時書き込みはファイル全体の last-write-wins）。明示 `"ask"` はモデル質問のみで永続化確認を
  出さない。戻し方は 2 通りで意味が異なる: `"ask"` へ書き換え = モデル質問のみ、キー削除 =
  未設定に戻り永続化確認が再表示

### トラブルシュート

| 症状 | 対処 |
|------|------|
| 初回起動で `sh: command not found` が出る | `max_wait=10000ms` でも足りないほど遅い環境。プロジェクト config で `baseline_ms` を大きく（例: 5000）設定する |
| 特定プロジェクトだけ恒常的に遅い | `<project>/.dispatch/config.json` に手動で上書き値を置く |
| 学習値をリセットしたい | `rm ~/.claude/cmux-team-dispatch-task/config.json` |
| config 壊れた疑い | `jq . ~/.claude/cmux-team-dispatch-task/config.json` で検証、壊れていれば削除 |

## 子セッション runner 設定（runners.json）

親セッションは起動元の runtime（Claude Code または Codex）を使い、子セッションは `runners.json` で定義されたいずれかの runtime（`claude` の別アカウント、`codex` バイナリ、`.zshrc` の zsh 関数など）で起動できます。SKILL.md の Step 1f で配置・選択されます。

### 配置場所

- `~/.claude/cmux-team-dispatch-task/runners.json`
- 環境変数 `RUNNERS_CONFIG_PATH` で上書き可能（テスト用）

### スキーマ（最小）

```json
{
  "default": "claude",
  "runners": [
    { "name": "claude", "command": "claude", "engine": "claude",
      "plan_model": "opus[1m]", "review_model": "opus[1m]", "exec_model": "fable",
      "plan_effort": "max", "review_effort": "xhigh", "exec_effort": "high" },
    { "name": "codex", "command": "codex", "engine": "codex",
      "plan_model": "gpt-5.6-sol", "review_model": "gpt-5.6-sol", "exec_model": "gpt-5.6-terra",
      "plan_effort": "xhigh", "review_effort": "xhigh", "exec_effort": "high" }
  ]
}
```

| フィールド | 意味 |
|----------|------|
| `default` | 切替確認で「No」を選んだとき／runner 1 件のときに全タスクへ適用される runner 名 |
| `runners[].name` | AskUserQuestion の選択肢ラベル兼一意 ID |
| `runners[].command` | 実際に実行するコマンド／関数名 |
| `runners[].engine` | `claude` または `codex`。MODE 別の起動引数組み立てを切替（下表参照） |
| `runners[].plan_model` / `review_model` / `exec_model` | （任意、**両 engine 共通**）その role のモデル。`launch-workspace.sh` が `--role` から解決する |
| `runners[].plan_effort` / `review_effort` / `exec_effort` | （任意、**両 engine 共通**）その role の reasoning effort。claude は `low`\|`medium`\|`high`\|`xhigh`\|`max` を受け付け `--effort <値>` として渡され、codex は `minimal`\|`low`\|`medium`\|`high`\|`xhigh` を受け付け `-c model_reasoning_effort='<値>'` として渡される |

未設定時の既定値:

| role | claude モデル | codex モデル | effort（両 engine 共通） |
|------|--------------|-------------|-------------------------|
| plan | `opus[1m]` | 未指定（codex 側の既定） | `xhigh` |
| review | `opus[1m]` | レビュアーに選ばれたときは必須 | `xhigh` |
| exec | `sonnet` | 未指定（codex 側の既定） | `high` |

model / effort どちらも解決順は同じ:
`--model` / `--effort` の明示指定 > runner の `<role>_model` / `<role>_effort` > 上表の既定値。

### engine × MODE 起動コマンド対応表

固定プロンプトテキスト (plan / superpowers): `Read and follow the task in .cmux-team-dispatch-task-prompt.md`
execute モードのプロンプトテキスト: `Read and execute the plan at <plan-file>` (`--plan-file` で指定)

| engine | MODE        | 組み立てコマンド |
|--------|-------------|----------------|
| claude | plan        | `<command> [--model <plan_model>] [--effort <plan_effort>] --dangerously-skip-permissions '/plan <PROMPT>'` |
| claude | superpowers | `<command> [--model <plan_model>] [--effort <plan_effort>] '<PROMPT>'` |
| claude | execute     | `<command> [--model <exec_model>] [--effort <exec_effort>] [--dangerously-skip-permissions] '<EXEC_PROMPT>'` |
| codex  | plan        | `<command> [-c model_reasoning_effort='<plan_effort>'] [--model <plan_model>] --dangerously-bypass-approvals-and-sandbox '/plan <PROMPT>'` |
| codex  | superpowers | `<command> [-c model_reasoning_effort='<plan_effort>'] [--model <plan_model>] '$superpowers:brainstorming <PROMPT>'` |
| codex  | execute     | `<command> [-c model_reasoning_effort='<exec_effort>'] [--model <exec_model>] --dangerously-bypass-approvals-and-sandbox '<EXEC_PROMPT>'` |

reasoning effort は両 engine とも **明示 `--effort` > runner フィールド（plan_effort:
plan/superpowers、review_effort: review、exec_effort: execute/standby）> 上表の既定値（plan/review
は `xhigh`、exec は `high`）** の優先で解決される。claude は `--effort <値>` として、codex は
`-c model_reasoning_effort='<値>'` として `<command>` 直後に注入される。prewarm の設計 codex ペインは
`--mode standby --role plan` で起動され、同じ role resolver が `plan_model` と `plan_effort` を
適用する。

上記全体は常に `zsh -ic "..."` で wrap され、`~/.zshrc` のユーザー定義関数（`ccenec` 等）と env（proxy 認証 / PATH 等）が子セッションで読み込まれます。

MODE によらず、解決された runner engine が `claude` のときは worktree の
`.claude/settings.local.json` に `permissions.defaultMode: "bypassPermissions"` を
注入する（`jq` でマージし、`mktemp` + `mv` でアトミックに置換。既に同値なら
スキップ）。これが、すべての起動経路に `--dangerously-skip-permissions` を足すことなく
通常（非 loop）ディスパッチから permission prompt を消している仕組み。

このモードでも `AskUserQuestion` は対話的なまま残る。permission システムが門番をするのは
ツール呼び出しであり、`AskUserQuestion` と `ExitPlanMode` は permission mode に関わらず
TUI セッションが描画する対話 UI だからである。非対話セッションだけが `PreToolUse` hook で
それらに答える必要がある。superpowers モードのブレスト対話が壊れないのはこのため。

bypass モード突入の確認ダイアログは `--dangerously-skip-permissions` でも
`defaultMode: "bypassPermissions"` でも出る。抑止する `skipDangerousModePermissionPrompt`
は project settings では無視されるので、ユーザー設定 `~/.claude/settings.json` に置くこと。

codex engine は影響を受けない。`.claude/settings.local.json` を読まないうえ、
`--dangerously-bypass-approvals-and-sandbox`（レビューペインは
`--sandbox workspace-write` + `-c approval_policy='never'`）で既に prompt が出ない。

**execute モードの使い所**: Phase B (実装フェーズ) で claude executor / codex などの別 engine へ委譲する場面。Child セッションが `launch-workspace.sh --mode execute --runner "$EXEC_RUNNER" --plan-file <path> [--model <X>] [--skip-permissions]` を呼び出して別 surface を spawn し、自分は `<STATUS_DIR>/.deferred` を作成して exit する。execute モードでは `.cmux-team-dispatch-task-prompt.md` を書き換えず、Phase A のものを温存する。codex engine では `--model` 未指定時に runner の `exec_model` がフォールバック適用される（execute / standby のみ。review は常に `review_model` を明示）。


### 初回セットアップ

`runners.json` が存在しない状態、runner 切替質問で reset を選んだ直後、`--reset runners` の直後、または `--setup` で `runners.json` を対象に選んだときは、初回セットアップが起動します:

1. AskUserQuestion で **starter テンプレ（claude のみ）** か **カスタム** を選択
2. starter テンプレ選択時は claude のみが書き出されます
3. カスタム選択時は AskUserQuestion ループで `name / command / engine` を 1 件ずつ収集、最後に「もう 1 件追加？」を繰り返し確認
   - **plan_model** / **review_model** / **exec_model**（**両 engine とも**質問する）。claude
     には `opus[1m]` / `sonnet` / `fable` に加え自由入力の「Other」を、codex には自由入力
     （例 `gpt-5.6-sol`）を提示する。空回答はスキーマ表の既定値を維持する: claude は
     `opus[1m]` / `opus[1m]` / `sonnet`、codex は codex 側デフォルトに委ねる。codex runner が
     review 可能であるためには `review_model` が引き続き必須
   - **plan_effort / review_effort / exec_effort**（**両 engine とも**質問する）。
     AskUserQuestion の上限内に収まるよう、既定値を中心にした 4 択を提示する:
     - claude の plan / review: `default (xhigh)` / `max` / `high` / Other
     - claude の exec: `default (high)` / `xhigh` / `max` / Other
     - codex の plan / review: `default (xhigh)` / `high` / `medium` / Other
     - codex の exec: `default (high)` / `xhigh` / `medium` / Other
4. 通常の初回セットアップでは review 方針（legacy 自動 / 毎回選ぶ / 固定 runner）を選ぶ。legacy は
   key を書かず、後二者だけ `review_runner: "ask"` または固定名を writer 固有 `mktemp` + `mv` で
   グローバル config に保存する。reset 直後のセットアップではこの質問と永続化をスキップし、
   project / global の両 `config.json` を変更しない
5. 完了後、`~/.claude/cmux-team-dispatch-task/` ディレクトリが無ければ作成され、runners.json が書き出されます

### タスクごとの runner 切替

- runners が **1 件**: 切替確認は出ず自動でその runner を全タスクに割当（永続化質問も出ない）
- runners が **2 件以上**: 「子セッションごとにランタイム/モデルを切り替えますか？」を確認。
  `design_runner` が**未設定**なら 4 択、明示 `"ask"` なら 3 択
  1. **いいえ (今回のみ)**: `default` runner を全タスクに割当（config には書かない）
  2. **はい (今回のみ)**: タスクごとに AskUserQuestion で選択（config には書かない）
  3. **未設定時: runner 設定を保存**: 2 択の追加質問を出す
     - **常に既定 runner を使う**: `default` runner を全タスクに割当 + グローバル config に
       `design_runner: "<default>"` を永続化
     - **常に固定 runner を選ぶ**: さらに `runners[]` から 1 つ選び、全タスクに割当 +
       グローバル config に `design_runner: "<name>"` を永続化
     明示 `"ask"` の 3 番は次の reset になる
  4. **`runners.json` を reset**（明示 `"ask"` では 3 番）: `RUNNERS_RESET=true` として
     `RUNNERS_JSON` だけを削除する。review 方針の質問と永続化をスキップする reset mode で
     初回セットアップを実行するため、project / global の両 `config.json` は変更されない。新しい
     registry の書き込み後、Step 1f の runner 解決を再開する

選ばれた runner 名は各タスクの起動時に `launch-workspace.sh --runner <name>` へ渡されます。

### 既存 Phase B モデル選択との関係

子セッション内で実装フェーズ前に行う Phase B の engine 選択（`claude` / 条件付き `codex`）とは
**レイヤーが異なる**:

- **Step 1f (本セクション)**: 子セッションを *どの runtime で起動するか* を親が決める（起動時）
- **Phase B**: 起動済みの design セッションが *どの解決済み execution role へ実装を委譲するか（または
  in-session 条件が成立して自ら実装するか）* を決める（起動後）。model / effort は Phase B の回答
  からは来ず、常に runner の role フィールド（Step 1f）から来る

なお Phase B の `codex` 選択肢は `runners.json` に `engine: codex` runner が登録されている場合にのみ表示され、`claude` 選択肢も `engine: claude` runner が登録されている場合にのみ表示される。片方の engine しか登録されていなければ質問自体が省略される。design が Codex の場合も、Phase B は専用 exec role へ委譲し（in-session 例外を除く）、`exec_model` / `exec_effort` を design role と独立して適用するため、この選択肢には意味がある。

## ステータス一覧

| ステータス | 意味 | 書き込み元 |
|-----------|------|-----------|
| `launched` | runner セッション起動完了、ロード中 | 起動スクリプト |
| `planning` | 計画フェーズ中 | 子セッション（任意） |
| `executing` | runner セッション起動中 / 実装中 | ランナースクリプト / 子セッション |
| `done` | 全作業完了 | ランナースクリプト / 子セッション |
| `error` | エラー / 異常終了 | ランナースクリプト / 子セッション |

## 子セッションのステータス報告手順

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

## 閉鎖対象

`close_all=true` のとき、子の workspace を `cmux close-workspace --workspace <id>` で閉じる。

## 前提条件

- codex オプションを使う場合、`runners.json` に `engine: "codex"` の runner を 1 件以上登録しておく必要がある (Step 1f の初回セットアップで追加可能)
- 加えて `cmux codex install-hooks` をマシンで一度実行しておく必要がある
- これにより `~/.codex/hooks.json` に SessionStart / Stop / UserPromptSubmit hooks が入り、`config.toml` に `[features] codex_hooks = true` / `external_migration = true` が追加される

## Phase B-R 有効時の実行指示と完了通知

Phase B-R を有効にすると、standby ペインへ送る `REQUEST_TEXT` は「共通プロトコル a」の拡張版に差し替わり、
engine 別の base `REQUEST_TEXT` を**上書きする**。そのため拡張版は次の 2 つを必ず自分で持つ必要がある。

| 要素 | 内容 |
|------|------|
| engine 別 exit 指示 | 完了報告は `report-status.sh` の呼び出しが担い、セッション終了には依存しない。exit 指示は claude が `run /exit`、codex は「停止して idle のまま待て」（codex には自セッションを終わらせる手段が無い）|
| 完了通知 | `send-prompt.sh --to-workspace <parent> --agmsg-team <team> --agmsg-to parent --agmsg-from <agent> --label dispatch-notify -- '<msg>'` の 1 回呼び出し。タイプ入力は idle な親を起こす唯一の手段なので省略不可（inbox 記録は watcher 生存時に追加される単なるログ） |

standby ペインはタイプ入力で届いた `REQUEST_TEXT` しか読んでいない（`.cmux-team-dispatch-task-prompt.md` は
未読）。したがって「status protocol は下に書いてある」という前提は成立せず、通知手順を拡張 `REQUEST_TEXT`
自身に書かないと子側の通知経路が丸ごと欠落する。この 2 点が同時に欠けると、実装が正常に完了しても
親には何も届かない。回帰テストは `test/test-launch-workspace-codex.sh` の T14 / T15。

### status.json watcher による完了通知

runner wrapper は子セッションと並行して status.json watcher を走らせ、終端 `done` / `error` を
15 秒間隔（`CMUX_DISPATCH_WATCH_INTERVAL` で変更可）で監視する。セッションが idle のままでも
親通知を試み、timeout sentinel、`.deferred`、未 assigned standby、他 pane の `.assigned-*` は
所有権の抑止条件として poll ごとに再評価する。`.notified-<slug>` は通知成功済みの status 文字列を
保持し、親通知と reviewer wake の marker は分離する。

子が書いた終端 status は sticky である。`error` は終了コードに関係なく message ごと保持し、
`done` は正常終了時だけ保持する。`done` 後に非ゼロ終了した場合だけ、保守的に `error` へ訂正する。
親通知のラベルは終了コードではなくこの確定 status から導出する。

停止時は ABORT/ESCALATION の 5 手順（findings 記録、reviewer wake、error status、親通知、engine 別
セッション終了）を必ず実行する。reviewer wake は `send-prompt.sh --label abort-reviewer`、親通知は
完了通知と同じ `send-prompt.sh --label dispatch-notify` を `status: error` で 1 回呼ぶだけであり、
別途 `send.sh` を呼んではならない（inbox 記録は `send-prompt.sh` が済ませている）。
`[abort]` を受けたレビュアーは待機を打ち切る。workspace レイアウトの Child 起動にも `--defer-status` を渡す。これが無いと、Phase B で実行を別 surface へ移譲した Child の wrapper が、孫の書いた終端状態を上書きしてしまう。
