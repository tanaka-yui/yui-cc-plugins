# cmux-team-dispatch-task

cmux ワークスペースを活用した並列タスクディスパッチプラグイン。
複数の独立したタスクを、それぞれ独自の git worktree + 解決済み runner セッションで同時実行する。

## 特徴

- **並列実行**: 2つ以上の独立タスクを同時にディスパッチ
- **git worktree 隔離**: 各タスクが独立したブランチ (`feat/<task-slug>`) で作業し、メインブランチを保護
- **Agent 自動発見**: `.claude/agents/` から利用可能なエージェントを動的にスキャンし、一覧を子セッションに伝達。各子セッションが自身のタスクに最適なエージェントを選択
- **brainstorming タスク選択**: タスクごとに superpowers モード（brainstorming + writing-plans）か plan モードかを選択可能
- **統合戦略の選択**: `PR per task`（各子タスクが push + `gh pr create`）または `Wait and merge`（全完了後に親でローカルマージ、デフォルト）
- **ステータス監視**: `.dispatch/` ディレクトリを介したファイルベースのステータス通信とシグナルによるリアルタイム進捗追跡
- **superpowers 連携**: Execution Handoff の第3選択肢「Parallel (cmux)」として統合
- **プロンプトファイル経由**: シェルエスケープの問題を回避するため、プロンプトはファイル経由で子セッションに渡される
- **ターミナル起動待機の自動学習**: 子セッションのシェル初期化時間を計測して `~/.claude/config/cmux-team-dispatch-task/config.json` に EMA で永続化し、次回以降の最大待機時間を適応的に決定（`sh: command not found` を防止）。詳細は [guide-ja.md](skills/cmux-team-dispatch-task/references/guide-ja.md#ターミナル起動待機の自動学習)

## レイアウト

レイアウトは常に `workspace`。各タスクは独立した cmux workspace（タブ）で実行される。

各タスクの workspace 内は `review_mode` に応じた 2 パターンだけです。

| `review_mode=off`（2 ペイン） | `review_mode=on`（4 ペイン） |
|---|---|
| `design` | `design` ｜ `design_review` |
| `exec` | `exec` ｜ `exec_review` |

> **破壊的変更 (v1.13.0)**: `--layout split` と `--layout claude-teams` を削除しました。
> レイアウトは常に `workspace` です。あわせて split 専用の
> `launch-session-splits.sh` と `cmux-grid.sh` も削除しています。
> pre-warm は常時有効です。各タスクは独立した workspace と worktree を持ち、review が無効なら
> `design` / `exec`、有効なら 4 ロールすべてを配置します。

## 前提条件

- [cmux](https://github.com/anthropics/cmux) がインストール済み
- 選択した構成で使う CLI が利用可能（all-Codex 固定構成は Codex のみ。Claude role を選ぶ構成は Claude Code も必要）
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

### 設定（`--setup`）

```
/cmux-team-dispatch-task --setup
```

ディスパッチを行わずに設定だけを構成します。現在の global / project / 解決値と
`runners.json` を表示し、対象を global `config.json`、project `config.json`、
`runners.json` から選びます。config を選ぶと、最初に `review_mode` と編集するロール
（`design` / `design_review` / `exec` / `exec_review`、複数選択）を聞き、選んだロールごとに
runner / model / effort を 1 コールで聞きます。runner 変更後の engine で tuple 全体を再検証し、
無効な次元だけを再質問します。2 回目も無効ならそのロールの変更全体を破棄します。

`runners.json` を選んだ場合は runner の追加、registry の作り直し、変更なしの 3 択です。
最後に対象 1 ファイルの差分を確認し、config は全変更を 1 回の `config-edit.sh` 呼び出しで
原子的に反映します。

### 設定のリセット（`--reset`）

```
/cmux-team-dispatch-task --reset
/cmux-team-dispatch-task --reset runners
/cmux-team-dispatch-task --reset config
/cmux-team-dispatch-task --reset all
```

`runners` は registry だけを作り直し、両 `config.json` を変更しません。`config` は選んだ
layer から `review_mode` と `runner` の 2 キーだけを削除し、`shell_ready_ms` や `loop` など
他の所有者のキーを残します。`all` は両 config layer の 2 キーを消して registry と初期 global
config を作り直します。対象を省略すると質問されます。

`--setup` / `--reset` はどちらもディスパッチを行わず、`.dispatch/`・worktree・`feat/*`
ブランチには一切触れません。`--loop` / `--override` とも互いとも排他で、issue ループが
ロックを保持している間は実行を拒否します。

### タスク個別の一時上書き（`--override`）

```
/cmux-team-dispatch-task タスクA, タスクB --override
```

その dispatch に限って、タスクごとに design / design_review / exec / exec_review の runner / model / effort を
上書きします。難しいタスクだけ effort を上げる、実装だけ別 engine に投げる、といった
使い方を想定しています。

タスク一覧を見てから対象タスクを選び、次に上書きする役割を選び、選んだ役割の
runner / model / effort を答える流れです。各質問の先頭は必ず「変更なし（現在: <解決値>）」
なので、変えたい次元だけ触れば済みます。review の 2 ロールは `review_mode=on` のときだけ
表示されます。回答はロール単位の pending tuple として検証され、不整合な部分だけを再質問し、
2 回目も不正ならそのロールの上書き全体を破棄します。

**config にも `runners.json` にも一切書き戻しません。** 恒久的に変えたいときは `--setup` を使ってください。
無人実行の `--loop`、および `--setup` / `--reset` とは排他です（`--loop` は質問に答える人が
いないため）。

上書きした内容は起動前のサマリー表の直後に差分として表示されます。

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
（ブレストの対話、レビュー 5 往復後の判断）は permission gate とは
別レイヤーの対話 UI なので、対話的なまま残る。

**前提**: bypass モード突入時の確認ダイアログは `--dangerously-skip-permissions` でも
`defaultMode` でも表示される。これを抑止する `skipDangerousModePermissionPrompt` は
project settings では無視されるため、**ユーザー設定 `~/.claude/settings.json`** に
`"skipDangerousModePermissionPrompt": true` を置くこと。

注入先は最優先スコープの `settings.local.json` なので、リポジトリ側の
`.claude/settings.json` で `defaultMode` を別の値に上書きすることはできない。これは
意図した挙動で、opt-out 用の config キーは用意していない。

注入はベストエフォートで、戻り値も信用できない（`settings.local.json` がディレクトリだと
`mv` が temp をその中へ移して成功を報告する）。そのため起動スクリプトは claude engine では
注入の成否に関わらず無条件に `jq -e` でファイルを判定し、`permissions.defaultMode` が `bypassPermissions` になっていなければ
`permission bypass not confirmed` を含む警告を出したうえで、その起動にだけ
`--dangerously-skip-permissions` を足す。これが無いと、権限フラグを持たない設計ペインだけが
注入失敗時に素の権限で上がり、誰も見ていない状態で permission prompt に当たって止まる。
なおこのフォールバックも上記の確認ダイアログの前提を共有するので、
`skipDangerousModePermissionPrompt` をユーザー設定に置いていない環境では同じダイアログで
止まる点は変わらない。

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

## メッセージ配送（agmsg send.sh 一本）

**通知トランスポートの設定項目は無い。** `message_type` は v1.16.0 で廃止され、
`launch-workspace.sh` / `prewarm-panes.sh` の `--message-type` フラグも削除された（渡すと
`was removed` を含むメッセージで die する）。

**[agmsg](https://github.com/fujibee/agmsg) は v2.0.0 から必須要件**で、劣化モードは無い。
このスキルのすべてのメッセージとすべての起床は agmsg の Monitor ストリームに乗る。タイプ入力の
フォールバックも、ポーリング型の監視スクリプトも存在しない。次のどれかに当てはまると、
ディスパッチはペインを 1 つも作らずにエラーで止まる:

| 状況 | 検査 |
|------|------|
| `~/.agents/skills/agmsg/scripts/send.sh` が無い | ファイル存在チェック |
| claude 親に生きた watcher が無い | `verify-agmsg-ready.sh --self` が exit 1 |
| codex 親に bridge seat の記録が無い | `verify-agmsg-ready.sh --codex --team <t> --name parent` が exit 1 |

claude 親の watcher は SessionStart hook が要求する `Monitor` tool そのもので、`/clear` は
その hook を再発火させるので watcher は自力で戻る。codex 親には session id が無いため、
受信チャネルは bridge seat（`run/codex-bridge.<team>.<agent>.thread`）になる。codex セッション
から `--self` を呼ぶのは「watcher が無い」ではなく**使用法エラー**（exit 2）なので、両者は
別々に扱われる。

team 名は `dispatch-<repo-name>`、親の agent 名は `parent`。
status.json / result.md / `cmux wait-for` signal はこの変更でも不変。

配送はすべて agmsg `send.sh` の 1 回呼び出しに一本化されている:

```bash
~/.agents/skills/agmsg/scripts/send.sh "<team>" <from-agent> <to-agent> '<label>: <本文>'
```

1. 宛先は **agmsg の agent 名**であり、surface / workspace ID ではない。ペインは
   `[ready] <name>` を報告してはじめて到達可能になり、それ以前に送ったメッセージはその inbox に
   未読のまま残る
2. 回避すべき長さ制限も outbox も無い。inbox は TUI の貼り付け判定を受けないので、本文はそのまま
   丸ごと渡せる
3. Enter の検証も再送も無い。`send.sh` は agmsg の共有 SQLite DB へ書くか非ゼロで終了するかの
   どちらかで、**非ゼロ終了はメッセージが配送されなかったことを意味する**
4. メッセージ種別はフラグではなく本文の label 接頭辞で表す（`phase-a-task:` / `phase-b-exec:` /
   `review-plan:` / `review-code:` / `review-verdict:` / `review-timer:` / `dispatch-timer:` /
   `abort-reviewer:` / `dispatch-notify:`。**`review-timer:` / `dispatch-timer:` は予約のみで、
   現在これを送る箇所は無い**）

### ペインの readiness（3 要件）

ペインが配送先になれるのは次の 3 つが揃ったときだけである:

1. team に join 済み（`join.sh`）
2. そのプロジェクトが monitor モード（`delivery.sh set monitor`）
3. ペインが初回ターンを 1 回持った — claude なら `Monitor` tool が起動し、codex なら bridge の
   seat が記録される

**claude 子の readiness は親から観測できない**（watcher の pidfile が session id キーで、親は
その session id を知らないため）。したがって各ペインは初回ターンで `[ready] <name>` を親へ
自己申告する。親はこれを受け取ってから初めてタスクを配送する。codex 子だけは team/agent キー
なので、`verify-agmsg-ready.sh --codex` で「seat 未記録」と「ペイン死亡」を切り分けられる。

### 待機（ポーリングは全廃）

待機ループは 1 つも無い。時間ベースの仕組みは**単発タイマー**だけである。

| 待機者 | 起こすもの | 保険 |
|--------|-----------|------|
| 親（全タスクの完了待ち） | 子の `dispatch-notify:` メッセージ | claude 親のみ 90 分の単発タイマー。**codex 親には保険が無い** |
| Phase A-R の設計ペイン / Phase B-R の実装者 | レビュアーの `review-verdict:` メッセージ | claude 待機者のみ 30 分の単発タイマー。**codex 待機者には保険が無い** |

タイマーは `sleep` 1 回であってループではないが、**張れるのは claude だけ**である。codex は
`run_in_background` を持たず、代替として指示されていた「自分宛の遅延メッセージ」も 2026-08-21
の実測で不発だった（バックグラウンドのサブシェルで sleep してから自分へメッセージを送る
やり方も、その detached (`nohup`) 版も codex のターン終了で消える。D-T2）。したがって **codex の待機者には保険が存在せず、張ったふりをしてはならない** —
待機に入る前に依頼相手の到達性を確認し、「保険の無い待機に入った」ことを親へ 1 通報告する。
all-Codex の無人ループには backstop が 1 つも無いため、`prewarm-panes.sh --unattended` は
codex 親から呼ばれた時点で die する。`review-timer:` / `dispatch-timer:` label は予約のまま
残るが、現在これを送る箇所は無い。verdict は**ファイルが記録、メッセージが起床手段**で、
どの起床でも先に findings ファイルを読み直す（失われうるのはメッセージだけだから）。
**verdict 行の無いタイマー起床は `needs_work` ではない** — メッセージが来なかったという意味しか
持たない。再武装は同一ラウンドで 3 回までで、無人ループでは上限に達した時点で
AskUserQuestion に落とさずスキップ／エラー扱いにする。

タイマーで起きたときは、判断の前に**永続記録**を読む: `.dispatch/*/status.json` から状態を
再導出し、`[ready]` の確認には `history.sh` を使う（`inbox.sh` は使わない — 競合 watcher に
消費された row は既読になり「新着なし」と答えてしまう）。照合は `[ready] <slug>` を行末まで
アンカーして行う（アンカーが無いと slug `api` が `[ready] api-v2` で満たされる）。

> **既知の挙動変化（タイムアウト検知の粒度）**
> 旧 loop 待機スクリプトは 5 秒間隔で `claimed_at` を見ていたが、現行は 90 分の単発タイマーで
> 起きたときにしか評価しない。そのため `loop.task_timeout_min` を 90 分未満に設定しても、
> timeout の検知は次の起床までずれる。ポーリングを全廃したことの意図した代償である。

完了通知は2段構え: 子セッションが status.json 書き込み直後に自分で送る必須通知と、runner
wrapper の exit 時通知（バックストップ）。idle のまま開いている TUI セッションは exit しない
ため、wrapper だけに頼ると通知されない（このため子プロンプトに必須通知が埋め込まれる）。


## 4 ロール設定と解決

ロールは `design`、`design_review`、`exec`、`exec_review` の 4 つです。ディスパッチ時に
runner や実装 engine を質問する経路はなく、`config-resolve.sh` が各ロールの runner / model /
effort / engine を起動前に確定します。global config は
`~/.claude/config/cmux-team-dispatch-task/config.json`、project override は
`<repo>/.dispatch/config.json` です。

```json
{
  "review_mode": "on",
  "runner": {
    "design": { "runner": "claude", "model": "opus[1m]", "effort": "xhigh" },
    "design_review": { "runner": "codex", "model": "gpt-5.6-sol", "effort": "xhigh" },
    "exec": { "runner": "codex", "model": "gpt-5.6-terra", "effort": "high" },
    "exec_review": { "runner": "claude", "model": "opus[1m]", "effort": "xhigh" }
  }
}
```

`review_mode` は `on` / `off` だけです。各 `(role, field)` は次の 4 段を field 単位で合成します。

1. その dispatch 限りの `--override`
2. project `config.json`
3. global `config.json`
4. 組み込み既定値

project に model だけがあれば、runner と effort は global または組み込み値から補います。
runner 名、engine 別 effort、model の安全な文字列を検証し、codex の review ロールは model を
必須とします。active ロールの runner が未設定、runner が registry に無い、または必須 model が
無い場合は exit 2 で fail-fast し、ペインを 1 つも作りません。`review_mode=off` では review の
2 ロールを解決しません。

`runners.json` は runtime registry だけを持ちます。

```json
{
  "default": "claude",
  "runners": [
    { "name": "claude", "command": "claude", "engine": "claude" },
    { "name": "codex", "command": "codex", "engine": "codex" }
  ]
}
```

`default` は初回 global config 生成時だけ、4 ロールの runner 初期値として使われます。model と
effort は config のロール tuple または組み込み値から解決します。Claude の model 既定は design /
review が `opus[1m]`、exec が `sonnet`。Codex の design / exec は model 省略可ですが、2 つの
review ロールは model 必須です。effort 既定は design / review が `xhigh`、exec が `high` です。

## Phase A-R / Phase B / Phase B-R

Phase A の成果物は `design_review` がレビューし、Phase B の実装は常に `exec` へ委譲します。
design は実装指示の配送後に `.deferred` を作って終了し、レビュアーへ転じません。Phase B-R は
`exec_review` が担当します。review ロールは同じ engine でも構いませんが、他ロールの engine から
レビュアーを推測してはいけません。
Phase B は `phase-b-deliver.sh` が検証済み `prewarm.json.exec` の固定 tuple から agent / engine を使い、
同 agent へ `phase-b-exec:` を 1 通だけ送ります。新しい execute session は起動しません。

- `review_mode=off`: `design` と `exec` の 2 ペイン。Phase A-R / B-R は行いません。
- `review_mode=on`: 4 ペイン。Phase A-R は `design_review`、B-R は `exec_review` を再利用します。
- review ペインの launch/readiness だけが失敗した場合は、対応 gate だけを警告して省略します。
  design / exec の readiness 失敗は dispatch 全体を停止します。
- `review-gate.sh` は `prewarm.json` に `exec_review` が存在し、同ロールの `[ready]` を受信した
  場合だけ canonical な `review/code-review.json` path を stdout へ出します。この path は
  design task prompt の `REVIEW_CONFIG_PATH` literal として渡され、`phase-b-deliver.sh` の
  `--review-config` だけが消費します。親 shell の変数継承や launcher 引数にはしません。
- gate・delivery・launcher consumer は strict な `workspace:<digits>` / `surface:<digits>`、workspace
  一致、active surface の一意性と live ownership を検証します。review directory は status directory
  直下の non-symlink directory、config はその中の regular JSON に限定します。

Phase A-R の findings は `.dispatch/<slug>/review/<point>-round-<N>.md`、Phase B-R は
`.dispatch/<slug>/review/code-round-N.md` に記録し、末尾を `VERDICT: approve` または
`VERDICT: needs_work` にします。Phase B-R は最大 5 ラウンドで、第 6 ラウンドは開始しません。
round 5 が needs_work なら未解決指摘を PR 本文へ記録して進みます。レビュアーは書き込み直後に
`review-verdict:` を 1 通送信し、待機側はファイルをポーリングしません。

Codex review ペインは `--sandbox workspace-write` と `-c approval_policy='never'` に加え、
`--add-dir <canonical-status-dir>/review`、`--add-dir <AGMSG_SKILL_DIR>/run`、
`--add-dir <AGMSG_SKILL_DIR>/db` を条件付きで使います。findings 以外の status 領域は書き込み許可へ
含めません。

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
（prewarm 済みの exec ロールを含む）にも作用しますが、それらは plan モードを使わないため実害は
ありません。

### Pre-warm role panes

pre-warm は常時有効で、`prewarm-panes.sh --roles <STATUS_DIR>/roles.json` が解決済みロールを
起動します。配置は冒頭の 2/4 ペイン表で固定です。すべて idle で起動し、agmsg の join と
delivery 設定を終え、`[ready] <agent>` を親へ送ってから初めて配送対象になります。

`prewarm.json` は `workspace_id` / `review_mode` と、実在する
`design` / `design_review` / `exec` / `exec_review` キーだけを持ちます。各ロールに
surface_id / agent / runner / engine / model（必要な場合）/ effort / wired を記録します。
ready にならなかった review ロールは surface と team member を先に回収し、回収に成功した場合だけ
キーを削除します。`prune-not-ready.sh` は destructive call の前に workspace 一致、全 role surface
の一意性、対象 surface の live ownership を検証し、design / exec を prune 対象にできません。
必須 role の launch が失敗した場合、`prewarm-panes.sh` は今回作成・join・launch した worktree / branch /
member / surface だけを rollback し、再利用資源は残します。

全 consumer は**検証済みスナップショット契約**に従います。ファイル内容を 1 回だけ読み、document
全体を検証し、以後の抽出はそのローカル値だけから行います。cleanup は固定 4 ロール名を明示列挙し、
snapshot の `workspace_id` が現在の workspace と一致するときだけ close / leave します。

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

`~/.claude/config/cmux-team-dispatch-task/runners.json` の runner `command` に上記関数を組み込めば、その runner で起動する子セッションは別認証で動きつつ、履歴・skills・plugins を共有できます:

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
- **完了シグナルは信頼性あり**: ランナースクリプトが `status.json` の更新、`cmux wait-for --signal` の発火、`parent` agmsg agent 宛の `dispatch-notify:` 通知（agmsg `send.sh` の 1 回呼び出し）を保証。検証すべき Enter も詰まりうる input box も無く、非ゼロ終了なら notify marker を更新しないので次の poll で再試行される
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
公開しておらず（対応する `config.json` キーも無い）、スキル経由のディスパッチは常に
既定値で走る。値を変える現実的な手段は
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

無人 prompt には解決済みの 4 ロール tuple をそのまま渡す。同一 engine の review も有効で、
review 無効時は design / exec の 2 ペイン、有効時は 4 ペインを起動する。timeout sentinel は
`prewarm.json` に存在するロールだけへ渡す。cleanup / agmsg leave は検証済み snapshot の固定
4 ロールキーから対象を列挙し、`workspace_id` が現在の workspace と一致するときだけ実行する。

## Phase B-R 有効時の完了通知について

Phase B-R（実装後コードレビュー）を有効にすると、実装ペインへ送る指示文が拡張版に差し替わります。
base / 拡張版のどちらにも **engine 別の終了指示**（Claude は `/exit`、Codex は自分で終了せず
idle のまま待ち、親が final cleanup で pane を閉じる）と
**親への完了通知**（本文接頭辞 `dispatch-notify:` の agmsg `send.sh` 1 回呼び出し）の両方が含まれます。

prewarm 済み実装ペインは execute launcher の prompt を読まず、`phase-b-exec:` の指示文しか
読みません。したがって指示文自身が `report-status.sh`、`dispatch-notify:`、実装者・レビュアー用の
parallel directive、engine 別の終了規則を持つ必要があります。Codex に `/exit` や自己終了を要求しては
ならず、terminal status と親通知を書いたあと idle のまま待たせます。

完了通知は status.json の終端遷移で発火します。runner wrapper は子セッションと並行して
status.json watcher を走らせており、子が `done` / `error` を書けばセッションが終了しなくても
親へ通知を試みます（15 秒間隔。`CMUX_DISPATCH_WATCH_INTERVAL` で変更可）。子が書いた終端
status は sticky で、`done` の後に非ゼロ終了したときだけ保守的に `error` へ訂正します。通知済み
marker は成功した status 文字列を保持し、親通知と reviewer wake は別に管理します。

watcher は timeout sentinel、`.deferred`、未 assigned standby、他 pane の `.assigned-*` を
所有権の抑止条件として poll ごとに再評価します。停止時は ABORT/ESCALATION（findings 記録、
reviewer wake、error status、親通知、engine 別の終了規則）の 5 手順を実行してください。design は
`phase-b-exec:` の配送成功後に `.deferred` を作り、prewarm 済み exec の終端状態を上書きしません。

ただし子が status.json を書かないまま沈黙した場合は検知できません。既知の配信上の限界と通知
欠落パターンは [`docs/notification-gaps.md`](docs/notification-gaps.md) にまとめています。
