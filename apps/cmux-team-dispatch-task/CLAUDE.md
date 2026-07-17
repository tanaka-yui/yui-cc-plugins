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
| `~/.claude/cmux-team-dispatch-task/config.json` | グローバル設定（自動生成）。`shell_ready_ms.baseline_ms`（EMA 学習値）、`message_type`（通知トランスポート）、`prewarm`（standby pane 事前起動）、`design_runner` / `exec_choice`（質問の固定値） |
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
   - 異なる model (sonnet / codex) は **`launch-workspace.sh --mode execute` 経由で別 surface を spawn**。孫 surface の runner wrapper が status.json / `cmux wait-for` シグナル / 親通知を担当。Child は `.deferred` を作って exit (runner は `--defer-status` 付きで起動されており `.deferred` を検知して上書きをスキップ)。Phase B-R 有効時は `.deferred` 作成後も exit せずレビュアーとして待機し、approve 後に exit
   - sonnet は **`--skip-permissions` 必須** (auto mode が効かないため permission prompt でハング防止)
   - **codex 選択肢は `runners.json` に `engine: codex` の runner があるときのみ表示**（無い場合は option から除外）
   - 計画の受け渡しは `--plan-file <path>` で行う (`.cmux-team-dispatch-task-prompt.md` は書き換えず Phase A のものを温存)
9. `cmux send` で親に通知する箇所すべてに `cmux send-key return` がペアで発行されているか確認（runner / monitor 両方）
10. `runners.json` のスキーマ（`default` / `runners[].name|command|engine|review_model|exec_model|plan_effort|review_effort|exec_effort`）が SKILL.md Step 1f / guide-ja.md「子セッション runner 設定」/ `launch-workspace.sh` の `--runner` 解決ロジックの3か所で一致しているか確認。`review_model` は `engine: codex` の runner では design=claude タスクの Phase A-R/B-R レビューペイン（codex）用モデル、`engine: claude` の runner では design=codex タスクでレビュアー runner に選ばれたときに claude レビューペインへ渡すモデル（未設定時は `claude-opus-4-7[1m]` にフォールバック）であることを検証。`exec_model` は codex engine の execute / standby で `--model` 未指定時のみフォールバック適用され（明示 `--model` が優先）、review ペイン（常に `review_model` を明示）には適用されないことを検証。`plan_effort` / `review_effort` / `exec_effort`（codex engine の runner のみ、値: `minimal`|`low`|`medium`|`high`|`xhigh`）は codex セッションの reasoning effort を Phase A 設計 (plan/superpowers) / レビューペイン (review) / 実行系 (execute/standby) にそれぞれ `-c model_reasoning_effort='<値>'` として注入し、明示 `--effort` > runner フィールド > `config.toml` 既定の優先順位で解決されることを検証。特に `engine × MODE` の起動コマンド対応表（claude/codex × plan/superpowers/execute の6通り、codex 側は effort 注入込み）が SKILL.md と guide-ja.md で同一か検証。なお composed command は常に `zsh -ic "..."` で wrap される（`.zshrc` の関数 / env を読み込むため）
11. `launch-workspace.sh` の execute モード関連フラグ（`--mode execute` / `--plan-file` / `--model` / `--skip-permissions` / `--defer-status`）が SKILL.md / guide-ja.md / README.md の Phase B 説明と一致しているか確認。Child 側 (launch-session-splits.sh) が `--defer-status` を必ず付けて起動していること、孫側 (Phase B spawn) が `--mode execute` + `--plan-file` で起動していることを検証
12. `message_type`（`send-message` / `agmsg`）の解決フロー（Step 1g: config 優先 → agmsg インストール時のみ初回質問 → Yes/No とも永続化）が SKILL.md / guide-ja.md / README.md で一致しているか確認。agmsg モードでは monitor-dispatch.sh を起動しないこと、runner wrapper の親通知が `cmux send` + `send-key return`（wake）に**加えて** `send.sh <team> <from> parent`（inbox 記録）を送る dual-send であること（agmsg push は idle セッションを起こせないため cmux send は省略不可）、status.json / signal は不変であることを検証。子プロンプトの status protocol に「status.json 書き込み直後の必須完了通知（send.sh + cmux send の両チャネル）」が含まれること、Step 1g に AGMSG-DIRECTIVE 遵守(ディスパッチ実行中セッションの watcher 起動。ただし watcher は記録・返信用で wake 手段ではない旨の注記付き)が記載されていることを検証
13. pre-warm(`prewarm-panes.sh` / `--mode standby` の split・workspace 配置 / `.assigned-<name>` sentinel / prewarm.json スキーマ(`opus`・`sonnet`・`codex`・`review` + `delivery` + `engine`)/ signal 名 `<slug>-done`・`<slug>-sonnet-done`・`<slug>-codex-done`)が SKILL.md / guide-ja.md / README.md で一致しているか確認。prewarm.json の `engine` フィールドは `opus` が設計 runner の engine に追従（design=codex なら `codex`）、`sonnet` は常に `claude`、`codex` は常に `codex`、`review` は設計 engine の逆であることを検証。standby ペインは Phase A-R 無効時は縦積み(上 opus / 中 sonnet / 下 codex)、design=codex かつ Phase A-R 有効時は 2×2 グリッド（左上: design codex ペイン / 右上: claude レビューペイン `<slug>-opus`。詳細は項目 14）であること、standby wrapper が起動時・未 assigned exit 時に status.json を書かないこと、agmsg モードでは opus-1m も idle 起動し worktree への delivery 配線をペイン起動前に行うこと、Phase A / Phase B の指示送信が dual-send（常に `cmux send` + `send-key return`、prewarm.json の `delivery` 値が `agmsg` かつ watcher 生存時は加えて `send.sh` で inbox 記録）であること、Phase B の手順が「`.assigned-<name>` touch → 実行指示送信 → `.deferred` touch」の順であること、未使用側 pane は close せず開いたまま idle 維持する（常 4 ペイン）ことを検証
14. Phase A-R（設計セッションの plan/spec を逆 engine がレビュー）が SKILL.md / guide-ja.md / README.md / CLAUDE.md の 4 ファイルで一致しているか確認:
    - 有効化は設計 engine 別 2 系統（`REVIEW_ENABLED` / `REVIEW_ENABLED_CODEX_DESIGN`）: design=claude タスクは `engine: codex` runner の `review_model` が存在し `review_mode` が on に解決したとき `REVIEW_ENABLED=true`、design=codex タスクは `engine: claude` runner（レビュアー runner、`REVIEWER_RUNNER`）が存在し `review_mode` が on に解決したとき `REVIEW_ENABLED_CODEX_DESIGN=true`。`review_mode` 解決フロー自体は共通（project config 優先 → global → `"on"` / `"off"` は質問なしで恒久適用、未設定または `"ask"` なら対象 runner 存在時のみ dispatch のたびに 4 択質問[はい今回のみ / いいえ今回のみ / 常に有効 / 常に無効]、「常に〜」のみ永続化）
    - レビューポイント（plan モード: plan 後 1 回 / superpowers モード: spec 後 + plan 後の 2 回）、各ポイント最大 3 往復、approve は何ラウンド目でも即終了、3 往復 needs_work 時は AskUserQuestion（このまま進む / さらに修正）
    - verdict はファイル受け渡し（`<STATUS_DIR>/review/<point>-round-<N>.md` 末尾の `VERDICT: approve|needs_work`）。依頼配送は常に `cmux send` + `send-key return`、待機は常に 5 秒間隔・15 分チャンクのファイルポーリング + チャンク境界ごとのレビュアー pane 生存確認（`cmux read-screen --workspace/--surface` の画面差分。read-screen は非フォーカス workspace でも live な内容を返すため refresh 不要 — 実測確認済み。変化ありなら上限なしで待機継続、失敗・空出力は 10 秒間隔 3 回リトライし 2 回連続の境界で全失敗したときのみ pane 消滅扱い。チャンク境界では先に verdict を再確認する）（agmsg push / 返信 push は idle セッションを起こせないため配送・待機手段にしない）。prewarm.json の `review.delivery` が `agmsg` かつ ready sentinel 生存時は依頼文を `send.sh` で inbox にも記録する。stalled（1 チャンク画面変化なし / 2 回連続観測不能）時は verdict 最終確認 → 同一ラウンド 1 回再依頼（baseline 取り直し）→ AskUserQuestion
    - レビューペイン engine は常に設計の逆であること（design=claude → codex レビューペイン `<slug>-review` / design=codex → claude レビューペイン `<slug>-opus`）。prewarm 有効 + Phase A-R 有効時は 2×2 均等グリッド。design=claude: 左上 opus / 右上 codex review / 左下 sonnet / 右下 codex。design=codex: 左上 design codex / 右上 claude レビューペイン（`<slug>-opus`。A-R レビュアーと Phase B opus 1m 実装先の二役）/ 左下 sonnet / 右下 codex。無効時は現行縦積み。review ペインは standby wrapper の status 所有権なし（design=claude では `.assigned-<slug>-review` 非使用。design=codex の `<slug>-opus` ペインは Phase B で opus 1m が選ばれたときのみ `.assigned-<slug>-opus` が touch され実装者として status を持つ）、全レビューポイントで同一ペインを再利用し最終 approve 後も開いたまま idle 維持（常 4 ペイン。途中で close せず、最終の全タスク完了クリーンアップでまとめて close）。spawn 失敗時はレビューをスキップして Phase B へ
    - `launch-workspace.sh` の `--mode review` / `--standby-split-direction` / codex engine への `--model` 反映、`prewarm-panes.sh` の `--review-model`（design=claude、`--codex-runner` 必須）/ `--design-runner` + `--reviewer-runner`（design=codex、`--review-model` と相互排他）と prewarm.json `review` キーが SKILL.md の使用例・スキーマと一致
15. agmsg 配送の dual-send プロトコルが SKILL.md / guide-ja.md で一致しているか確認:
    - 指示を送る 5 箇所すべて（Phase A opus タスク / Phase B sonnet / Phase B codex / Phase A-R review 依頼 / Phase B-R コードレビュー依頼（実装者 → Child））で、配送が**常に** `cmux send` + `send-key return`（タイプ入力が唯一の wake 手段。agmsg push はバックグラウンド Bash の watcher に溜まるだけで idle セッションに注入されない）であること
    - 同 5 箇所で、送信直前に ready sentinel（`~/.agents/skills/agmsg/run/ready.<team>__<agent>`）の存在を確認し、生きているときだけ同一指示文を `send.sh` で inbox にも記録すること（inbox 記録時は指示文末尾に重複無視の注記を付ける）
    - `prewarm-panes.sh` が配線失敗（`CLAUDE_DELIVERY=cmux-send`）時に opus / sonnet の初期プロンプトを `/agmsg actas` なしの「直接タイプされる」文面に出し分けること。配線成功時のプロンプトも「タスクはタイプ入力で届く（inbox に同一コピーあり）」文面であり「agmsg message として届く」とは書かないこと
16. plan モードの遵守ゲート（ExitPlanMode hook）が SKILL.md / guide-ja.md / README.md / CLAUDE.md の 4 ファイルで一致しているか確認:
    - `launch-workspace.sh` が `--mode plan` かつ claude engine、かつ claude-teams レイアウト以外のときのみ worktree の `.claude/settings.local.json` に PostToolUse hook（matcher: `ExitPlanMode`、command: `zsh <skill-dir>/scripts/plan-approved-hook.sh`）を注入すること（既存 settings は jq マージ、worktree 再利用時は重複注入なし、失敗は警告のみで dispatch 続行）
    - `.claude/settings.local.json` と plan 保存先 `.claude/plans/` が repo 共有の `info/exclude` に追記されること（settings のマージ書き込みは tmp + mv のアトミック方式、hook command のスクリプトパスはクォート済み）
    - hook が worktree に残存し後続セッション（Phase B の execute 孫を含む）にも作用するが、plan モードを使わないため実害なし — と 4 ファイルで文書化されていること
    - MANDATORY MODEL SELECTION SEQUENCE の Phase A（plan モード）に「plan 冒頭に Step 0: Phase A-R（有効時）/ Step 1: Phase B を必須ステップとして記載」「plan が ExitPlanMode メッセージ内にしか無い場合は承認後最初にファイル保存」の指示、VIOLATION 節に PLAN-MODE TRAP が含まれること
    - `plan-approved-hook.sh` の出力が有効な JSON（`hookSpecificOutput.additionalContext`）であること
17. Phase B-R（実装後コードレビュー）が SKILL.md / guide-ja.md / README.md / CLAUDE.md の 4 ファイルで一致しているか確認:
    - 有効化条件は Phase A-R と完全に同一（design=claude は `REVIEW_ENABLED`、design=codex は `REVIEW_ENABLED_CODEX_DESIGN`。新 config キー無し）。Step 1g の質問文が「レビューモードを使いますか？（Phase A-R … / Phase B-R …）」の両フェーズ言及形であること
    - レビュアーの割り当ては統一ルール: レビュアーは常に実装者の逆 engine。実装者 engine == 設計 engine → review ペインがレビュー / 実装者 engine != 設計 engine → 設計セッション自身がレビュアーに転じる（`.deferred` touch 後も exit せず idle 待機、approve 書き込み後に exit）。設計 claude/codex × 実装者 opus 1m/sonnet/codex の 6 ケース:
      - design=claude, opus 1m（設計ペインで継続実装）→ codex レビューペインがレビュー（Phase A-R と同一ペイン・ポイント id `code`）
      - design=claude, sonnet → codex レビューペインがレビュー。設計 opus ペインは `.deferred` touch 後に exit する（**現行からの変更**: 旧仕様では設計 opus ペインがレビューしていた）
      - design=claude, codex → 設計 opus ペイン自身がレビュアーに転じる
      - design=codex, opus 1m → 設計 codex ペイン自身がレビュアーに転じる。実装は claude レビューペイン（`<slug>-opus`、opus 1m 実装先と A-R レビュアーの二役）が担う
      - design=codex, sonnet → 設計 codex ペイン自身がレビュアーに転じる。実装は sonnet standby が担う
      - design=codex, codex → claude レビューペイン（`<slug>-opus`）がレビュー。設計 codex ペインは `.deferred` touch 後に exit する
      - レビューペイン利用不可（Phase A-R spawn 失敗済み）→ 上記いずれのケースもレビュー省略
    - プロトコル: findings は `<STATUS_DIR>/review/code-round-<N>.md` 末尾の `VERDICT: approve|needs_work`、最大 3 往復、実装者の verdict 待ちは 5 秒間隔・15 分チャンクのファイルポーリング + レビュアー pane の read-screen 画面差分による生存確認（活動中は上限なしで待機。standby が実装者のケース。設計セッション自身が実装を継続するケースは Phase A-R Round loop の待ち方を流用）、stalled（1 チャンク画面変化なし / 2 回連続観測不能）は verdict 最終確認 → 同一ラウンド 1 回再依頼 → それでも stalled なら claude 実装者は AskUserQuestion（再依頼 / レビュー省略して PR 作成）、codex 実装者はレビュー省略を PR 本文に注記して続行
    - 3 往復 needs_work: claude 実装者は AskUserQuestion（このまま PR 作成 / さらに修正）、codex 実装者は PR 本文に注記して続行
    - status.json の done/error 遷移は従来どおり実装者ペインの wrapper が所有。実装者がレビューを依頼せず終了しても Child は idle のまま残り、最終クリーンアップで閉じる（孤児ガード用の追加機構は無い）
    - spawn 経路: Child が `<STATUS_DIR>/review/code-review.json`（`{reviewer_surface, reviewer_workspace, review_dir}`。`reviewer_workspace` は実装孫が別 workspace に spawn されるため、依頼配送の `cmux send` / `send-key` と read-screen 生存確認の両方で `--workspace` に使う。欠落時は `--workspace` 指定なしにフォールバック）を書き、`launch-workspace.sh --mode execute --review-config <path>` で孫を起動。wrapper が composed prompt にプロトコル（依頼は常に `cmux send` + ポーリング）を追記する。`--review-config` は execute モード専用で、usage コメント / SKILL.md / guide-ja.md の使用例が一致していること。REVIEW_INSTRUCTION（liveness 文言・reviewer_workspace 埋め込み・クォート非混入）は `bash test/test-launch-workspace-review-config.sh` の静的検査で検証すること
18. クロスエンジンレビューと codex effort が SKILL.md / guide-ja.md / README.md / CLAUDE.md の 4 ファイルで一致しているか確認:
    - 「レビュアーは常に相手方 engine」原則と B-R 6 ケース表（設計 claude/codex × 実装者 opus 1m/sonnet/codex）が一致
    - design=codex: Phase B は 3 択とも委譲（設計セッションは実装しない）。右上ペインは agent `<slug>-opus`・A-R レビュアー兼 opus 1m 実装先の二役、opus 1m 選択時のみ `.assigned-<slug>-opus` が touch され signal `<slug>-opus-done`
    - Step 1f のレビュアー runner 選択（claude runner 0 件 → 無効警告 / 1 件 → 自動 / 2 件以上 → 毎回質問）と `CLAUDE_REVIEW_MODEL` フォールバック（`claude-opus-4-7[1m]`）
    - effort の優先順位（明示 `--effort` > runner フィールド > config.toml 既定）と MODE 対応（plan_effort: plan/superpowers、review_effort: review、exec_effort: execute/standby）。prewarm の設計 codex ペインは standby 起動のため `--effort <plan_effort>` 明示
    - `prewarm-panes.sh` の `--design-runner` / `--reviewer-runner`（`--review-model` と相互排他）と prewarm.json の `engine` フィールド
19. `design_runner` / `exec_choice` の precedence（project config → global config → ask）と警告フォールバックが SKILL.md / guide-ja.md / README.md / CLAUDE.md で一致しているか確認。`design_runner` は有効 runner 名で switch / per-task 質問を両方省略し、`exec_choice` は有効値で Phase B の AskUserQuestion を default-direct に置換することを確認
20. codex の engine × MODE 起動規則を確認: superpowers は bypass 付き、review は `--sandbox workspace-write` + `-c approval_policy='never'` + `--add-dir <STATUS_DIR>` の3点セットで、sandbox 完全 off を使わず findings 書込先を許可すること

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
8. **モデル選択（動的表示）**: `exec_choice` が未設定または `"ask"` の子セッションは Phase A 完了後に AskUserQuestion を出すこと。**design=claude** タスクでは `runners.json` に `engine: codex` runner が無い場合は **opus 1m / sonnet の 2 択**、ある場合は **3 択 (opus 1m / sonnet / codex)** になること。固定値では質問を出さず既存の対応分岐へ直行すること
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
17. **agmsg モード**: monitor-dispatch.sh が起動しないこと。子が status.json に done/error を書いた**直後**に `[dispatch] task ... finished` が `cmux send` + `send-key return` で親に届き(親が idle のままでも届くこと — これがタイプ入力を wake 手段にする理由)、同一文が agmsg push として親の inbox にも記録されること。wrapper の exit 時通知で同じ通知が重複して届くことがあるのは正常。ディスパッチ実行中の親セッションで AGMSG-DIRECTIVE により watcher が起動していること。status.json は従来どおり遷移すること
18. **pre-warm**: workspace レイアウトで各タスク workspace が縦分割ペインになること(agmsg モード: 上 opus-1m[idle] / 中 sonnet / 下 codex、send-message モード: 上 opus[タスク実行中] / 中 sonnet / 下 codex。codex runner が無ければ縦2分割)。agmsg モードでは全ペインが idle 起動し、親からの dual-send(`.assigned-<slug>` touch 後の `cmux send` タイプ入力 + inbox 記録)で Phase A が開始されること。`prewarm: false` / split レイアウトでは起動しないこと。タスク未割り当てのまま workspace を閉じても status.json が汚れないこと
19. **Phase B prewarm 経路**: sonnet 選択 → 未使用側 (codex) standby pane は開いたまま idle 維持され、`.assigned-<slug>-sonnet` が touch され、待機 pane へ実行指示が送信され、実装完了 exit 時に standby wrapper が status.json を done にし `<slug>-sonnet-done` signal + 親通知が発火すること。opus 1m 選択 → 未使用側 standby pane(sonnet / codex)は開いたまま status.json が汚れないこと(常 4 ペイン維持。途中で close しない)。prewarm.json が無い場合は従来の spawn にフォールバックすること。実行指示の送信は dual-send であること(常に `cmux send` + `send-key return` が発行され、`delivery` 値が `agmsg` かつ watcher 生存時は加えて `send.sh` で inbox 記録 — タイプ入力だけで idle ペインが確実に起きること)。codex 配線失敗時に `delivery: "cmux-send"` へフォールバックすること
20. **Phase A-R 無効**: `review_model` 未設定または `review_mode: off` で、現行フローと完全一致すること（prewarm レイアウトも縦積みのまま。Phase A 直後は `exec_choice` の解決済み方式、すなわち質問または default-direct に従う）
21. **Phase A-R 有効 + prewarm（design=claude）**: 2×2 均等グリッドで 4 ペイン起動（左上 opus / 右上 review [idle codex, `--model <review_model>`] / 左下 sonnet / 右下 codex）。prewarm.json に `review` キーがあること（design=codex の場合は項目 33 を参照）
22. **レビューループ**: plan モードで plan 完成後に 1 回、superpowers モードで spec 後 + plan 後の 2 回レビューが走ること。needs_work → opus が修正して**同一ペイン**に再依頼（新ペインが生えない）。approve → レビューペインは開いたまま（close されず）Phase B の解決済み方式が走ること。3 往復 needs_work → AskUserQuestion（このまま進む / さらに修正）が出ること
23. **verdict プロトコル**: `.dispatch/<slug>/review/<point>-round-<N>.md` が生成され、末尾に `VERDICT:` 行があること。両モードともファイルポーリング(5 秒間隔・15 分チャンク + `cmux read-screen` 画面差分によるレビュアー生存確認。活動中は上限なしで待機し、レビュー中に 15 分超過しても再依頼が飛ばないこと。最終 sleep 中に書かれた verdict もチャンク境界の再確認で検知されること)で verdict を検知すること(agmsg push 待ちは idle セッションを起こせないため使わない)
24. **review_mode 解決**: config 未設定（または `"ask"`）+ `review_model` 付き runner ありで、dispatch のたびにタスク起動前に 4 択質問（はい今回のみ / いいえ今回のみ / 常に有効 / 常に無効）が出ること。「今回のみ」では config に書き込まれず次回も質問が出ること。「常に〜」で `"on"` / `"off"` が永続化され以後質問が出ないこと。`.dispatch/config.json` の `review_mode` がグローバルより優先されること
25. **status 非汚染**: レビューペインの存在が standby の `.assigned-*` / status.json に影響しないこと（途中で close せず開いたままでも汚染しないこと、レビューペイン spawn 直後に status.json が "launched" で上書きされないことを含む）。prewarm 無効時は最初のレビューポイントで `--mode review` のオンデマンド spawn が行われること
26. **exec_model**: codex runner に `exec_model` 設定時、Phase B の codex 実行（`--mode execute` spawn / prewarm codex standby）が `--model <exec_model>` 付きで起動すること。レビューペインは `review_model` のまま変わらないこと。`--model` 明示時は明示値が優先されること。`exec_model` 未設定なら従来どおり codex 側デフォルトで起動すること
27. **watcher 死亡時のフォールバック**: `delivery: "agmsg"` のタスクで宛先ペインの watcher を kill（ready sentinel が消える）した後に指示を送ると、inbox 記録がスキップされ `cmux send` のみで配送されること（watcher 生存時も `cmux send` は常に発行される — inbox 記録の有無だけが変わる）。配線失敗（`delivery: "cmux-send"`）タスクの opus / sonnet 初期プロンプトに `/agmsg actas` が含まれず、「typed directly into this pane」の文面になること。配線成功タスクの初期プロンプトは「task will arrive as a prompt typed into this pane（inbox に同一コピー）」の文面であること
28. **plan モード遵守ゲート**: plan モード子セッションで ExitPlanMode 承認後、ファイル編集前に Phase A-R（有効時）→ Phase B の task prompt 解決済み方式が走ること。worktree に `.claude/settings.local.json` が生成され、settings と `.claude/plans/` 配下の plan ファイルのどちらも `git status` に現れないこと。superpowers モードの worktree には hook が注入されないこと。既存の `.claude/settings.local.json` がある worktree では既存キーが保持されたままマージされること
29. **Phase B-R (design=claude, codex 実装)**: `review_mode: on` + codex 選択 → 実装者（codex standby）がコミット後・PR 作成前に設計 opus ペインへレビュー依頼し、Child が `review/code-round-1.md` に VERDICT を書くこと。needs_work → 実装者が修正して round 2 を依頼し**同じ opus セッション**がレビューすること。approve → PR が作成され、opus Child が exit すること。Child は `.deferred` touch 後も exit せず待機していること（sonnet 実装時のレビュアーはコードレビューペインに変わっている — 項目 36 を参照）
30. **Phase B-R (opus 1m 実装)**: `review_mode: on` + opus 1m 選択 → コミット後・PR 作成前にポイント id `code` の依頼が **Phase A-R と同一の codex レビューペイン**に送られること。レビューペイン spawn 失敗済みの場合はレビューが省略され PR 作成へ進むこと
31. **Phase B-R 無効 / spawn 経路**: `review_mode: off` では Child が従来どおり `.deferred` touch 後すぐ exit し、実行指示にレビュープロトコルが含まれないこと。prewarm 無効時は `--review-config` 付き spawn で孫の inner prompt に `MANDATORY CODE REVIEW` 文が入り、`review/code-review.json` が生成されること。3 往復 needs_work → claude 実装者は AskUserQuestion が出る / codex 実装者は PR 本文に未解決指摘が注記されること
32. **codex effort 注入**: codex runner に effort 3 フィールド設定時、composed command（`.cmux-team-dispatch-task-run-*.sh` 内）に `-c model_reasoning_effort='xhigh'`（plan/review）/ `'high'`（execute/standby）が入ること。未設定フィールドでは `-c` が付かないこと。`--effort` 明示時はそちらが優先されること
33. **design=codex ディスパッチ**: runner に codex を選んだタスクで 2×2 グリッドが 左上 design codex / 右上 claude レビューペイン（agent `<slug>-opus`、モデルはレビュアー runner の `review_model` または `claude-opus-4-7[1m]`）/ 左下 sonnet / 右下 codex になること。claude runner が 2 件以上あるときレビュアー選択質問が出ること
34. **design=codex の Phase A-R**: codex が書いた plan/spec を右上 claude ペインがレビューし、`review/<point>-round-<N>.md` の VERDICT で往復すること
35. **design=codex の Phase B**: 3 択すべてが委譲であること。opus 1m → `.assigned-<slug>-opus` touch + 右上ペインが実装 + 設計 codex ペインが B-R レビュー。sonnet → 設計 codex ペインが B-R レビュー。codex → 右下 standby が実装 + 右上 claude ペインが B-R レビュー
36. **design=claude の sonnet B-R 変更**: sonnet 実装時のコードレビューが codex レビューペインに依頼され（設計 opus ペインではなく）、設計 opus ペインは `.deferred` 後に exit すること
37. **design_runner default**: project config が global config より優先し、有効な runner 名では Step 1f の switch / per-task 質問が出ないこと。`"ask"` と未設定では既存の runner 数分岐を維持し、不正名は警告して質問へ戻ること
38. **exec_choice default**: `"sonnet"` を設定すると Phase A 完了後に AskUserQuestion を出さず sonnet standby/spawn の既存手順へ進むこと。`"ask"` と未設定は従来の質問を維持し、不正値または runner 未登録の `"codex"` は警告して質問へ戻ること
39. **codex 起動安全性**: superpowers は bypass で approval prompt を出さず、review は `--sandbox workspace-write` + `-c approval_policy='never'` + `--add-dir <STATUS_DIR>` で worktree 外の `<STATUS_DIR>/review/` に findings を書けること。`bash test/test-launch-workspace-codex.sh` の静的検査を実行すること
