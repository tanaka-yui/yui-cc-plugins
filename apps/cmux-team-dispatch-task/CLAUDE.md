# cmux-team-dispatch-task 開発ガイド

cmux ワークスペースを活用した並列タスクディスパッチスキル。
各タスクに独立した git worktree + Claude Code セッションを割り当て、親セッションがオーケストレーションを行う。

## ファイル構成

| ファイル | 役割 |
|---------|------|
| `skills/cmux-team-dispatch-task/SKILL.md` | メインスキル定義（3ステップワークフロー） |
| `skills/cmux-team-dispatch-task/references/guide-ja.md` | 日本語リファレンスガイド |
| `skills/cmux-team-dispatch-task/scripts/launch-workspace.sh` | ワークスペース/スプリット起動スクリプト |
| `skills/cmux-team-dispatch-task/scripts/launch-session-splits.sh` | 複数セッション一括起動ラッパー（superpowers 連携用） |
| `skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh` | pre-warm standby ペイン一括起動ラッパー(縦分割 / Phase A-R 有効時は 2×2 グリッド・agmsg 配線・prewarm.json 生成) |
| `skills/cmux-team-dispatch-task/scripts/monitor-dispatch.sh` | 完了通知の監視スクリプト（子 → 親通知＋全完了検知） |
| `skills/cmux-team-dispatch-task/scripts/cmux-grid.sh` | split モード用グリッドレイアウト整列スクリプト |
| `skills/cmux-team-dispatch-task/scripts/terminal-wait.sh` | シェル起動検知と `shell_ready_ms` 学習を行う共通ヘルパー（source 専用） |
| `~/.claude/cmux-team-dispatch-task/config.json` | グローバル設定（自動生成）。`shell_ready_ms.baseline_ms`（EMA 学習値）、`message_type`（通知トランスポート）、`prewarm`（standby pane 事前起動） |
| `~/.claude/cmux-team-dispatch-task/runners.json` | 子セッション runtime 一覧（初回セットアップで生成）。SKILL.md Step 1f で読込 |
| `<project>/.dispatch/config.json` | プロジェクト固有の上書き（手動配置）。存在時はグローバルより優先 |
| `.claude-plugin/plugin.json` | Plugin マニフェスト |
| `README.md` | 人間向けガイド |
| `CLAUDE.md` | この開発ガイド |
| `LICENSE` | MIT ライセンス |

## ドキュメント整合の絶対ルール

以下の **4 ファイル**で記述される機能仕様（Phase A/B モデル選択フロー、`runners.json` スキーマ、レイアウトモード、ステータスプロトコル、Display Format Conventions など）は **完全に一致** させる:

1. `skills/cmux-team-dispatch-task/SKILL.md` — エンジン的 SoT (single source of truth)
2. `skills/cmux-team-dispatch-task/references/guide-ja.md` — 日本語リファレンスガイド
3. `README.md` — ユーザー向け公開ドキュメント
4. `CLAUDE.md` (このファイル) — 開発ガイド

**任意の 1 ファイルを更新したら必ず残り 3 ファイルも同時に更新すること。** 下の「メンテナンス手順」の各項目はこの 4 ファイル整合性の検証手順である。整合が崩れている状態で commit / PR を出してはならない。

## 言語ルール

- **ドキュメント・コメント**: 日本語
- **コード（変数名・関数名・コマンド）**: 英語

## SKILL.md の編集ルール

- **3ステップワークフローの構造を維持する**（Parse & Prepare [1a-1f] → Launch Sessions → Monitor & Complete）
- `<this-skill-dir>` はスキルランタイムで SKILL.md の所在ディレクトリに解決される — パスはこのプレースホルダーを基準にする
- **ステータスプロトコル**（status.json / result.md）の仕様変更時は guide-ja.md も同期する
- **スクリプトのオプション追加**時は SKILL.md 内の使用例とスクリプト本体の `usage()` を同期する
- テーブル形式・コード例を多用し、散文は最小限に
- **Display Format Conventions（Template A/B/C）を変更したら、子セッションプロンプトに埋め込む `PROGRESS REPORTING FORMAT` のテーブルと guide-ja.md の Template も合わせて変更する**
- **デフォルトレイアウトは workspace**。`split` を使うのは `--layout split` が明示された場合のみ
- **モデル選択フロー（MANDATORY MODEL SELECTION SEQUENCE）の改変時** は SKILL.md / guide-ja.md / README.md / CLAUDE.md（このファイル）の **4 ファイル**を同時に更新する

## 関連プラグインとの境界

| 観点 | cmux-team-dispatch-task | cmux-team | cmux-using |
|------|------------------------|-----------|-----------|
| 対象 | 独立タスクの並列ディスパッチ | 4層マルチエージェントオーケストレーション | 汎用的な cmux 操作 |
| 実行単位 | 独立したタスク群 | Master→Manager→Conductor→Agent | 単一操作 |
| 隔離 | git worktree（タスクごと） | git worktree（Agent ごと） | なし |
| 永続プロセス | なし（スキルのみ） | daemon（Manager） | なし |

**重複を避ける**: cmux-team 固有の機能（4層管理、daemon）や cmux-using 固有の機能（基本 cmux 操作）を含めない。

## メンテナンス手順

1. `launch-workspace.sh --help` の出力と SKILL.md の使用例を突き合わせて整合性を確認
2. `launch-session-splits.sh --help` の出力と SKILL.md・guide-ja.md の使用例を突き合わせて整合性を確認
3. `monitor-dispatch.sh --help` の出力（特に `--heartbeat-interval` / `--resume` / `--dispatch-dir`）と SKILL.md Step 3 の使用例を突き合わせて整合性を確認
4. ステータスプロトコル（status.json スキーマ、`pr_url` を含む）が SKILL.md と guide-ja.md で一致しているか確認
   - クリーンアップは親セッション側で全タスク完了後にまとめて 3 問（workspace / worktree / branch）聞く方式。`status.json` には保存しない
5. superpowers 連携セクション（"superpowers Execution Handoff Integration"）が superpowers プラグインの最新仕様と整合しているか確認
6. `terminal-wait.sh` の config スキーマ（`shell_ready_ms.baseline_ms` / `samples` / `updated_at`）が guide-ja.md の説明と一致しているか確認
7. Display Format Conventions（Template A/B/C）が SKILL.md / guide-ja.md / 子セッションプロンプト埋め込みの `PROGRESS REPORTING FORMAT` の3か所で完全一致しているか確認（カラム数・順序・幅・Mode 略称）
8. モデル選択フロー（MANDATORY MODEL SELECTION SEQUENCE）が **SKILL.md / guide-ja.md / README.md / CLAUDE.md の 4 ファイル**で完全一致しているか確認:
   - 同一 model (opus 1m) は **現セッション継続** (`/model claude-opus-4-7[1m]`)
   - 異なる model (sonnet / codex) は **`launch-workspace.sh --mode execute` 経由で別 surface を spawn**。孫 surface の runner wrapper が status.json / `cmux wait-for` シグナル / 親通知を担当。Child は `.deferred` を作って exit (runner は `--defer-status` 付きで起動されており `.deferred` を検知して上書きをスキップ)
   - sonnet は **`--skip-permissions` 必須** (auto mode が効かないため permission prompt でハング防止)
   - **codex 選択肢は `runners.json` に `engine: codex` の runner があるときのみ表示**（無い場合は option から除外）
   - 計画の受け渡しは `--plan-file <path>` で行う (`.cmux-team-dispatch-task-prompt.md` は書き換えず Phase A のものを温存)
9. `cmux send` で親に通知する箇所すべてに `cmux send-key return` がペアで発行されているか確認（runner / monitor 両方）
10. `runners.json` のスキーマ（`default` / `runners[].name|command|engine|review_model|exec_model`）が SKILL.md Step 1f / guide-ja.md「子セッション runner 設定」/ `launch-workspace.sh` の `--runner` 解決ロジックの3か所で一致しているか確認。`exec_model` は codex engine の execute / standby で `--model` 未指定時のみフォールバック適用され（明示 `--model` が優先）、review ペイン（常に `review_model` を明示）には適用されないことを検証。特に `engine × MODE` の起動コマンド対応表（claude/codex × plan/superpowers/execute の6通り）が SKILL.md と guide-ja.md で同一か検証。なお composed command は常に `zsh -ic "..."` で wrap される（`.zshrc` の関数 / env を読み込むため）
11. `launch-workspace.sh` の execute モード関連フラグ（`--mode execute` / `--plan-file` / `--model` / `--skip-permissions` / `--defer-status`）が SKILL.md / guide-ja.md / README.md の Phase B 説明と一致しているか確認。Child 側 (launch-session-splits.sh) が `--defer-status` を必ず付けて起動していること、孫側 (Phase B spawn) が `--mode execute` + `--plan-file` で起動していることを検証
12. `message_type`（`send-message` / `agmsg`）の解決フロー（Step 1g: config 優先 → agmsg インストール時のみ初回質問 → Yes/No とも永続化）が SKILL.md / guide-ja.md / README.md で一致しているか確認。agmsg モードでは monitor-dispatch.sh を起動しないこと、runner wrapper の親通知が `send.sh <team> <from> parent` に切り替わること、status.json / signal は不変であることを検証。子プロンプトの status protocol に「status.json 書き込み直後の必須完了 push」が含まれること、Step 1g に AGMSG-DIRECTIVE 遵守(ディスパッチ実行中セッションの watcher 起動)が記載されていることを検証
13. pre-warm(`prewarm-panes.sh` / `--mode standby` の split・workspace 配置 / `.assigned-<name>` sentinel / prewarm.json スキーマ(`opus`・`sonnet`・`codex` + `delivery`)/ signal 名 `<slug>-done`・`<slug>-sonnet-done`・`<slug>-codex-done`)が SKILL.md / guide-ja.md / README.md で一致しているか確認。standby ペインは縦積み(上 opus / 中 sonnet / 下 codex)であること、standby wrapper が起動時・未 assigned exit 時に status.json を書かないこと、agmsg モードでは opus-1m も idle 起動し worktree への delivery 配線をペイン起動前に行うこと、Phase A / Phase B の指示送信が prewarm.json の `delivery` 値(`agmsg` / `cmux-send`)で分岐すること、Phase B の手順が「未使用側 pane を close → `.assigned-<name>` touch → 実行指示送信 → `.deferred` touch」の順であることを検証
14. Phase A-R（codex plan/spec レビュー）が SKILL.md / guide-ja.md / README.md / CLAUDE.md の 4 ファイルで一致しているか確認:
    - 有効化 3 条件（`engine: codex` runner / runner の `review_model` / `review_mode` が on に解決）と `review_mode` 解決フロー（project config 優先 → global → `"on"` / `"off"` は質問なしで恒久適用、未設定または `"ask"` なら `review_model` 付き runner 存在時のみ dispatch のたびに 4 択質問[はい今回のみ / いいえ今回のみ / 常に有効 / 常に無効]、「常に〜」のみ永続化）
    - レビューポイント（plan モード: plan 後 1 回 / superpowers モード: spec 後 + plan 後の 2 回）、各ポイント最大 3 往復、approve は何ラウンド目でも即終了、3 往復 needs_work 時は AskUserQuestion（このまま進む / さらに修正）
    - verdict はファイル受け渡し（`<STATUS_DIR>/review/<point>-round-<N>.md` 末尾の `VERDICT: approve|needs_work`）。依頼配送は prewarm.json の `review.delivery` で分岐（`agmsg` → send.sh + push 待ち / `cmux-send` → cmux send + 5 秒間隔・15 分タイムアウトのファイルポーリング）。タイムアウト時は同一ラウンド 1 回再依頼 → AskUserQuestion
    - prewarm 有効 + Phase A-R 有効時は 2×2 均等グリッド（左上 opus / 右上 review / 左下 sonnet / 右下 codex）、無効時は現行縦積み。review ペインは standby wrapper の status 所有権なし（`.assigned-<slug>-review` 非使用）、全レビューポイントで同一ペインを再利用し最終 approve 後に close。spawn 失敗時はレビューをスキップして Phase B へ
    - `launch-workspace.sh` の `--mode review` / `--standby-split-direction` / codex engine への `--model` 反映、`prewarm-panes.sh` の `--review-model`（`--codex-runner` 必須）と prewarm.json `review` キーが SKILL.md の使用例・スキーマと一致
15. agmsg 配送の watcher 生存チェックが SKILL.md / guide-ja.md で一致しているか確認:
    - agmsg で指示を送る 4 箇所すべて（Phase A opus タスク / Phase B sonnet / Phase B codex / Phase A-R review 依頼）で、送信直前に ready sentinel（`~/.agents/skills/agmsg/run/ready.<team>__<agent>`）の存在を確認し、無ければ `cmux-send` に倒すこと
    - `prewarm-panes.sh` が配線失敗（`CLAUDE_DELIVERY=cmux-send`）時に opus / sonnet の初期プロンプトを `/agmsg actas` なしの「直接タイプされる」文面に出し分けること
16. plan モードの遵守ゲート（ExitPlanMode hook）が SKILL.md / guide-ja.md / README.md / CLAUDE.md の 4 ファイルで一致しているか確認:
    - `launch-workspace.sh` が `--mode plan` かつ claude engine のときのみ worktree の `.claude/settings.local.json` に PostToolUse hook（matcher: `ExitPlanMode`、command: `zsh <skill-dir>/scripts/plan-approved-hook.sh`）を注入すること（既存 settings は jq マージ、worktree 再利用時は重複注入なし、失敗は警告のみで dispatch 続行）
    - `.claude/settings.local.json` が repo 共有の `info/exclude` に追記されること
    - MANDATORY MODEL SELECTION SEQUENCE の Phase A（plan モード）に「plan 冒頭に Step 0: Phase A-R（有効時）/ Step 1: Phase B を必須ステップとして記載」「plan が ExitPlanMode メッセージ内にしか無い場合は承認後最初にファイル保存」の指示、VIOLATION 節に PLAN-MODE TRAP が含まれること
    - `plan-approved-hook.sh` の出力が有効な JSON（`hookSpecificOutput.additionalContext`）であること

## テスト方法

```bash
# plugin.json が有効な JSON か確認
cat .claude-plugin/plugin.json | jq .

# スキルディレクトリ構造の確認
ls -R skills/cmux-team-dispatch-task/

# スクリプトの実行権限確認
ls -la skills/cmux-team-dispatch-task/scripts/
```

### E2E テスト（cmux セッション内で実行）

1. 2つ以上の独立タスクを指定してスキルを発動
2. **デフォルト挙動**: `--layout` フラグなしで workspace モードが選択されること
3. workspace モード: 各タスクが別タブで起動すること
4. split モード（`--layout split` 明示時）: 各タスクが同一ワークスペース内のペインで起動すること
5. `.dispatch/*/status.json` が更新されること
6. 完了シグナルが正しく発火すること
7. **テーブル表示**: Step 1f の Template A、Step 3 の Template B、最終レポートの Template C が Box drawing 文字で出力されること（Mode 列が `superpwr` / `plan` で含まれていること）
8. **モデル選択（動的表示）**: 子セッションが Phase A 完了後に AskUserQuestion を必ず出すこと。`runners.json` に `engine: codex` runner が無い場合は **opus 1m / sonnet の 2 択**、ある場合は **3 択 (opus 1m / sonnet / codex)** になること
9. **同一 model (opus 1m)**: 選択時に `/model claude-opus-4-7[1m]` が実行され、同 surface 内で実装が継続されること
10. **異なる model (sonnet)**:
    - Child セッションが `launch-workspace.sh --mode execute --plan-file <path> --model claude-sonnet-4-6 --skip-permissions ...` を呼ぶこと
    - `LAYOUT=workspace` → 新 workspace が立ち上がり、`claude --model claude-sonnet-4-6 --dangerously-skip-permissions 'Read and execute the plan at <path>. ... run /exit ...'` が runner script (`bash .cmux-team-dispatch-task-run-<slug>-exec.sh`) でラップされて起動すること (inner prompt 末尾に `/exit` 指示が付与されること、runner ファイル名は workspace 名で unique 化されること)
    - `LAYOUT=split` → 同 workspace 内に新 split が右に追加され、上記と同じ runner-wrapped コマンドで起動すること
    - Child が `<STATUS_DIR>/.deferred` を touch して exit すること
    - Child の runner wrapper が `.deferred` を検知し、`status.json` を上書きせず exit すること
    - 孫の Claude が PR 作成後に自動で `/exit` を発火して TUI を閉じること (これにより runner wrapper が完了処理に到達する)
    - 孫の runner wrapper が完了時に `status.json` を `done` に遷移させ、`cmux wait-for --signal <slug>-exec-done` 発火、親に `[dispatch] task "<slug>-exec" finished (status: done)` を送ること
11. **異なる model (codex)**: Child が `launch-workspace.sh --mode execute --runner <codex-runner> ...` を呼び、`runners.json` の codex runner で新 surface が起動。`--dangerously-bypass-approvals-and-sandbox` 付きで実行し、`external_migration` により親 claude session を引き継ぐこと（`cmux codex install-hooks` が前提）。完了通知フローは sonnet と同じ
12. **monitor heartbeat**: `monitor-dispatch.sh` から60秒おきに `[dispatch-monitor] alive | loop=N | ...` が親に届くこと
13. **Enter 自動押下**: 親が claude TUI でも、完了通知が input box に残らず自動で読み取られること（`cmux send` の後に `cmux send-key return` が発行される）
14. **死亡検知**: monitor を `kill` した直後に `[dispatch-monitor] DIED ...` メッセージが親に届くこと
15. **`--resume`**: 既存の `.dispatch/` がある状態で monitor を `--resume` 起動 → 完了済みは skip、未完了のみ監視継続すること
16. **message_type 解決**: config 未設定 + agmsg インストール済みで初回質問が出て、Yes/No どちらでも `~/.claude/cmux-team-dispatch-task/config.json` に永続化されること。config 設定済みなら質問が出ないこと
17. **agmsg モード**: monitor-dispatch.sh が起動しないこと。子が status.json に done/error を書いた**直後**に agmsg push で `[dispatch] task ... finished` が親に届くこと(子セッションが idle のままでも届くこと)。wrapper の exit 時 push で同じ通知が重複して届くことがあるのは正常。ディスパッチ実行中の親セッションで AGMSG-DIRECTIVE により watcher が起動していること。status.json は従来どおり遷移すること
18. **pre-warm**: workspace レイアウトで各タスク workspace が縦分割ペインになること(agmsg モード: 上 opus-1m[idle] / 中 sonnet / 下 codex、send-message モード: 上 opus[タスク実行中] / 中 sonnet / 下 codex。codex runner が無ければ縦2分割)。agmsg モードでは全ペインが idle 起動し、親からの agmsg 送信(`.assigned-<slug>` touch 後)で Phase A が開始されること。`prewarm: false` / split レイアウトでは起動しないこと。タスク未割り当てのまま workspace を閉じても status.json が汚れないこと
19. **Phase B prewarm 経路**: sonnet 選択 → 未使用側 (codex) standby pane が先に close され、`.assigned-<slug>-sonnet` が touch され、待機 pane へ実行指示が送信され、実装完了 exit 時に standby wrapper が status.json を done にし `<slug>-sonnet-done` signal + 親通知が発火すること。opus 1m 選択 → 未使用側 standby pane(sonnet / codex)が close され status.json が汚れないこと(agmsg モードでは opus ペイン自身は close されず、そのまま実行を継続する)。prewarm.json が無い場合は従来の spawn にフォールバックすること。実行指示の送信は prewarm.json の `delivery` 値で分岐すること(`agmsg` → `send.sh`、`cmux-send` → `cmux send` + `send-key return`)。codex 配線失敗時に `delivery: "cmux-send"` へフォールバックすること。codex の `delivery: "agmsg"`(配線成功)経路では、agmsg で送った実行指示が idle codex セッションに実際に消費されることを実機で確認すること(未消費で inbox に滞留する場合は codex を常に `cmux-send` に倒す)
20. **Phase A-R 無効**: `review_model` 未設定または `review_mode: off` で、現行フローと完全一致すること（prewarm レイアウトも縦積みのまま。Phase A 直後に Phase B の質問が出る）
21. **Phase A-R 有効 + prewarm**: 2×2 均等グリッドで 4 ペイン起動（左上 opus / 右上 review [idle codex, `--model <review_model>`] / 左下 sonnet / 右下 codex）。prewarm.json に `review` キーがあること
22. **レビューループ**: plan モードで plan 完成後に 1 回、superpowers モードで spec 後 + plan 後の 2 回レビューが走ること。needs_work → opus が修正して**同一ペイン**に再依頼（新ペインが生えない）。approve → レビューペインが close され Phase B の質問が出ること。3 往復 needs_work → AskUserQuestion（このまま進む / さらに修正）が出ること
23. **verdict プロトコル**: `.dispatch/<slug>/review/<point>-round-<N>.md` が生成され、末尾に `VERDICT:` 行があること。agmsg モードでは `[review] <point> round <N> done` push で子が再開し、send-message モードではファイルポーリングで検知すること
24. **review_mode 解決**: config 未設定（または `"ask"`）+ `review_model` 付き runner ありで、dispatch のたびにタスク起動前に 4 択質問（はい今回のみ / いいえ今回のみ / 常に有効 / 常に無効）が出ること。「今回のみ」では config に書き込まれず次回も質問が出ること。「常に〜」で `"on"` / `"off"` が永続化され以後質問が出ないこと。`.dispatch/config.json` の `review_mode` がグローバルより優先されること
25. **status 非汚染**: レビューペインの存在・close が standby の `.assigned-*` / status.json に影響しないこと（レビューペイン spawn 直後に status.json が "launched" で上書きされないことを含む）。prewarm 無効時は最初のレビューポイントで `--mode review` のオンデマンド spawn が行われること
26. **exec_model**: codex runner に `exec_model` 設定時、Phase B の codex 実行（`--mode execute` spawn / prewarm codex standby）が `--model <exec_model>` 付きで起動すること。レビューペインは `review_model` のまま変わらないこと。`--model` 明示時は明示値が優先されること。`exec_model` 未設定なら従来どおり codex 側デフォルトで起動すること
27. **watcher 死亡時のフォールバック**: `delivery: "agmsg"` のタスクで宛先ペインの watcher を kill（ready sentinel が消える）した後に指示を送ると、agmsg push ではなく `cmux send` で配送されること。配線失敗（`delivery: "cmux-send"`）タスクの opus / sonnet 初期プロンプトに `/agmsg actas` が含まれず、「typed directly into this pane」の文面になること
28. **plan モード遵守ゲート**: plan モード子セッションで ExitPlanMode 承認後、ファイル編集前に Phase A-R（有効時）→ Phase B の質問が出ること。worktree に `.claude/settings.local.json` が生成され `git status` に現れないこと。superpowers モードの worktree には hook が注入されないこと。既存の `.claude/settings.local.json` がある worktree では既存キーが保持されたままマージされること
