# cmux-team-dispatch-task: pre-warm 縦分割ペイン化 + agmsg 全面配送 設計

日付: 2026-07-14
対象: `apps/cmux-team-dispatch-task`

## 背景 / 目的

現行の pre-warm は、各タスク workspace に standby 用の「タブ」(`cmux new-surface`) として
`<slug>-sonnet` / `<slug>-codex` を idle 起動する。また Phase B の standby への実行指示は
「worktree に agmsg delivery 配線が無い」という理由で message_type に関わらず `cmux send` 固定、
Phase A の opus セッションは常にタスクプロンプト埋め込みで起動している。

これを次のとおり改善する:

1. **縦分割ペイン化(両モード共通)**: pre-warm パネルをタブではなく、タスク workspace 内の
   縦分割ペインにする。上: opus / 中: sonnet / 下: codex(codex runner 未登録時は縦2分割)。
2. **agmsg モードの全ペイン idle 起動**: opus-1m / sonnet / codex の3ペインすべてを
   タスクメッセージ未指定で起動し、Phase A の初期タスクも Phase B の実行指示も agmsg で配送する。
   これによりタスク未確定でも workspace 一式を事前起動できる。
3. **send-message モードは従来動作を維持**: opus はプロンプト付き起動、実行指示は `cmux send`。
   変わるのはペイン配置(タブ → 縦分割)のみ。

## 前提調査の結果

- agmsg の delivery 配線は project 相対ファイルへの hook 注入で行われる:
  claude-code → `<project>/.claude/settings.local.json`、codex → `<project>/.codex/hooks.json`。
  いずれも未追跡ファイルであり worktree の git 状態を汚さない。worktree 単位の配線は可能。
- agmsg には codex driver (shim) が存在する (`drivers/types/codex/`)。shim 未導入環境では
  配線に失敗しうるため、フォールバックが必要。
- SessionStart hook はセッション起動時に評価されるため、**配線はペイン起動前に行う必要がある**。
- 同一 worktree 内の複数 claude セッションの識別は agmsg の actas (`/agmsg actas <name>`) で行う。
  既存の agmsg standby フローで実績のあるパターン。

## アーキテクチャ

### 新規: `scripts/prewarm-panes.sh`

pre-warm 一式を1回の呼び出しで決定論的に完了するラッパー(`launch-session-splits.sh` と同格)。

```
# send-message モード (opus は通常フローで起動済み。sonnet / codex の split のみ追加)
prewarm-panes.sh \
  --workspace <workspace-id> --base-surface <surface-id> \
  --cwd <worktree> --slug <task-slug> \
  --status-dir <dir> \
  [--codex-runner <name>]

# agmsg モード (workspace 未作成の状態で呼ぶ。opus も standby 起動し workspace はスクリプトが作成)
prewarm-panes.sh \
  --with-opus \
  --cwd <worktree> --slug <task-slug> \
  --status-dir <dir> \
  [--codex-runner <name>] \
  --message-type agmsg --agmsg-team <team>
```

`--with-opus` と `--workspace`/`--base-surface` は排他。出力は作成した workspace / 各ペインの
surface_id を含む JSON(親はここから workspace_id を得る)。

内部処理:

1. worktree を create-or-reuse する(`launch-workspace.sh` と同じ
   `git worktree add` ロジック。agmsg 配線より先に worktree ディレクトリが必要なため)。
2. (agmsg 時) 各 agent の `join.sh` と、worktree への `delivery.sh set monitor <type> <worktree>`
   を **ペイン起動前に** 実行する。codex は codex type での配線を試行し、失敗しても die せず
   `cmux send` フォールバックとして記録する。
3. (`--with-opus` 時) `launch-workspace.sh --mode standby --layout workspace --cwd <worktree>
   --model 'claude-opus-4-7[1m]' --defer-status <slug>` で opus standby の workspace を作成する。
   メイン surface が opus ペインになる。
4. `launch-workspace.sh --mode standby --standby-in <workspace-id> --standby-split-from <surface>`
   を上→下の順に呼び、sonnet / codex の縦分割ペインを作成する。
5. `prewarm.json` を書き込む。

### 変更: `scripts/launch-workspace.sh`

standby モードの配置をタブ(`new-surface`)から次の2方式に変更する
(タブ配置のコードパスは削除。消費者は SKILL.md / prewarm-panes.sh のみ):

- **split 配置**: `--standby-in <workspace-id>` + `--standby-split-from <surface-id>`(新設)。
  指定 surface から `cmux new-split down` でペインを作成する(sonnet / codex 用)。
- **workspace 配置**: `--mode standby --layout workspace`。`cmux new-workspace --command <runner>`
  で新規 workspace を作成し、メイン surface で standby セッションを起動する
  (agmsg モードの opus ペイン用)。

## 起動フロー

### send-message モード(レイアウト変更のみ)

1. opus ペイン = workspace のメイン surface。従来どおりタスクプロンプト付きで起動
   (`new-workspace --command`)。
2. `prewarm-panes.sh` が sonnet / codex を縦分割で idle 起動。
3. 画面: 上 opus(実行中)/ 中 sonnet(idle)/ 下 codex(idle)。

### agmsg モード(全ペイン idle 起動)

1. 親は `prewarm-panes.sh --with-opus ...` を呼ぶ。スクリプトが worktree 作成 → agmsg 配線 →
   opus-1m standby workspace 作成(初期プロンプトは `/agmsg actas <slug>` + 待機指示のみ。
   タスクは含まない)までを行う。
2. 続けて同スクリプトが sonnet / codex を縦分割で standby 起動する(同じく actas + 待機)。
3. 親はタスクプロンプトを従来どおり `.cmux-team-dispatch-task-prompt.md` に書き、
   `send.sh $TEAM parent <slug> "Read and follow the task in .cmux-team-dispatch-task-prompt.md ..."`
   で Phase A を開始する。モード(plan / superpowers)は slash command ではなく
   メッセージ本文の指示として埋め込む(agmsg push は slash command を発火できないため)。

## prewarm.json スキーマ

```json
{
  "opus":   { "surface_id": "surface:N", "agent": "<slug>",        "delivery": "agmsg" },
  "sonnet": { "surface_id": "surface:N", "agent": "<slug>-sonnet", "delivery": "agmsg" },
  "codex":  { "surface_id": "surface:N", "agent": "<slug>-codex",  "delivery": "cmux-send" }
}
```

- `opus` キーは agmsg モードのみ存在する(send-message モードでは opus は通常起動のため記録不要)。
- `delivery` は配線結果。agmsg 配線に成功したペインは `"agmsg"`、失敗した場合(codex shim 未導入
  など)は `"cmux-send"`。Phase B はこの値で送信手段を選ぶ。

## Phase B の変更

現行の「standby への実行指示は message_type に関わらず常に `cmux send`」という制約を撤廃し、
`prewarm.json` の `delivery` 値で分岐する:

- `"agmsg"` → `send.sh $TEAM parent <slug>-sonnet "<実行指示>"`(codex も同様)
- `"cmux-send"` → 従来どおり `cmux send` + `cmux send-key return`

手順の骨格(未使用側 pane close → `.assigned` touch → 実行指示送信 → `.deferred` touch)は不変。

## ステータスプロトコル(agmsg モードの opus ペイン)

- opus standby は `--defer-status` 付き・workspace 名 `<slug>` で起動する。signal 名は従来どおり
  `<slug>-done`、runner script 名も従来と同一。
- 親が Phase A タスクを agmsg 送信する直前に `.dispatch/<slug>/.assigned` を touch する。
  opus の standby wrapper は exit 時に status.json を done/error に遷移させる
  (既存 standby セマンティクスの再利用)。
- Phase B で opus が sonnet / codex に実行を移譲する場合は従来どおり `.deferred` を touch して
  exit する。wrapper は status を書かない。
- タスク未割り当てのまま workspace を閉じた場合は `.assigned` が無いため status.json は汚れない
  (事前起動しても安全)。

## エラー処理・フォールバック

- `delivery.sh set` 失敗(codex shim 未導入など)→ die せず `delivery: "cmux-send"` として続行。
- agmsg 未インストールで `message_type: agmsg` → 既存の `die` を踏襲。
- `prewarm: false` / split / claude-teams レイアウト → pre-warm 全体をスキップ(従来どおり)。
  agmsg モードで prewarm が off の場合、opus は従来のプロンプト付き起動にフォールバックする
  (idle 起動は pre-warm 機能の一部として扱う)。

## テスト・ドキュメント同期

- 4ファイル整合ルールに従い SKILL.md / guide-ja.md / README.md / CLAUDE.md を同期する。
  CLAUDE.md のメンテナンス手順 13 と E2E テスト項目 18 / 19 を新仕様
  (縦分割ペイン・delivery 分岐・opus standby)に書き換える。
- E2E 追加観点:
  1. 縦3分割で起動すること(codex runner 無しなら縦2分割)。
  2. agmsg モードで全ペインが idle 起動し、親からの agmsg 送信で Phase A が開始されること。
  3. codex 配線失敗時に `delivery: "cmux-send"` へフォールバックし、Phase B の実行指示が
     `cmux send` で届くこと。
  4. タスク未割り当てのまま workspace を閉じても status.json が汚れないこと。
