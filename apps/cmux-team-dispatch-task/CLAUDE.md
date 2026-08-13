# cmux-team-dispatch-task 開発ガイド

cmux ワークスペースを活用した並列タスクディスパッチスキル。
各タスクに独立した git worktree + Claude Code セッションを割り当て、親セッションがオーケストレーションを行う。

## ファイル構成

| ファイル | 役割 |
|---------|------|
| `skills/cmux-team-dispatch-task/SKILL.md` | メインスキル定義（3ステップワークフロー） |
| `skills/cmux-team-dispatch-task/references/guide-ja.md` | 日本語リファレンスガイド |
| `skills/cmux-team-dispatch-task/scripts/launch-workspace.sh` | ワークスペース/スプリット起動スクリプト |
| `skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh` | pre-warm standby ペイン一括起動ラッパー(縦分割 / Phase A-R 有効時は 2×2 グリッド・agmsg 配線・prewarm.json 生成) |
| `skills/cmux-team-dispatch-task/scripts/monitor-dispatch.sh` | 完了通知の監視スクリプト（子 → 親通知＋全完了検知） |
| `skills/cmux-team-dispatch-task/scripts/send-prompt.sh` | 全メッセージ配送の単一入口（常にタイプ入力 + watcher 生存時は agmsg inbox にも記録 / 長文の outbox 退避 / Enter 検証と再送） |
| `skills/cmux-team-dispatch-task/scripts/terminal-wait.sh` | シェル起動検知と `shell_ready_ms` 学習を行う共通ヘルパー（source 専用） |
| `skills/cmux-team-dispatch-task/scripts/parallel-directive.sh` | 子セッションへ渡す並列実行ディレクティブの生成（文面の単一情報源） |
| `~/.claude/cmux-team-dispatch-task/config.json` | グローバル設定（自動生成）。`shell_ready_ms.baseline_ms`（EMA 学習値）、`prewarm`（standby pane 事前起動）、`review_mode`、`design_runner` / `exec_choice`（質問の固定値。未設定時は質問の「常に〜」回答から永続化可能）。**`message_type` は v1.16.0 で廃止**（書いても読まれない） |
| `~/.claude/cmux-team-dispatch-task/runners.json` | 子セッション runtime 一覧（初回セットアップで生成）。SKILL.md Step 1f で読込 |
| `<project>/.dispatch/config.json` | プロジェクト固有の上書き（手動配置）。存在時はグローバルより優先 |
| `.claude-plugin/plugin.json` | Plugin マニフェスト |
| `README.md` | 人間向けガイド |
| `docs/notification-gaps.md` | 通知欠落・無限待機パターンの一覧（修正済み / 未解決） |
| `CLAUDE.md` | この開発ガイド |
| `LICENSE` | MIT ライセンス |

## ドキュメント整合の絶対ルール

以下の **4 ファイル**で記述される機能仕様（Phase A/B モデル選択フロー、`runners.json` スキーマ、レイアウトモード、ステータスプロトコル、Display Format Conventions など）は **完全に一致** させる:

1. `skills/cmux-team-dispatch-task/SKILL.md` — エンジン的 SoT (single source of truth)
2. `skills/cmux-team-dispatch-task/references/guide-ja.md` — 日本語リファレンスガイド
3. `README.md` — ユーザー向け公開ドキュメント
4. `CLAUDE.md` (このファイル) — 開発ガイド

**任意の 1 ファイルを更新したら必ず残り 3 ファイルも同時に更新すること。** 下の「メンテナンス手順」の各項目はこの 4 ファイル整合性の検証手順である。整合が崩れている状態で commit / PR を出してはならない。

なお SKILL.md は英語、guide-ja.md は日本語で、**見出しは 1:1 対応**させる（ルート `CLAUDE.md`「Language convention」）。SKILL.md に節を足したら guide-ja.md にも対応する節を足すこと。SKILL.md に対応節が無い日本語の解説は guide-ja.md 末尾の「補足」にまとめる。

## 言語ルール

- **ドキュメント・コメント**: 日本語
- **コード（変数名・関数名・コマンド）**: 英語
- **`SKILL.md` / `commands/*.md` / `references/*.md`**: **英語必須**。日本語訳は `references/*-ja.md` に置く。
  詳細はルート `CLAUDE.md` の「Language convention」を参照。検証は `pnpm check:doc-lang`。
- **例外**: `SKILL.md` frontmatter の `description` は日本語可（起動トリガー語を残すため）。

## SKILL.md の編集ルール

- **3ステップワークフローの構造を維持する**（Parse & Prepare [1a-1f] → Launch Sessions → Monitor & Complete）
- `<this-skill-dir>` はスキルランタイムで SKILL.md の所在ディレクトリに解決される — パスはこのプレースホルダーを基準にする
- **ステータスプロトコル**（status.json / result.md）の仕様変更時は guide-ja.md も同期する
- **スクリプトのオプション追加**時は SKILL.md 内の使用例とスクリプト本体の `usage()` を同期する
- テーブル形式・コード例を多用し、散文は最小限に
- **Display Format Conventions（Template A/B/C）を変更したら、子セッションプロンプトに埋め込む `PROGRESS REPORTING FORMAT` のテーブルと guide-ja.md の Template も合わせて変更する**
- **レイアウトは常に workspace**。各タスクは独立した workspace で実行する
- **モデル選択フロー（MANDATORY MODEL SELECTION SEQUENCE）の改変時** は SKILL.md / guide-ja.md / README.md / CLAUDE.md（このファイル）の **4 ファイル**を同時に更新する

## 関連プラグインとの境界

| 観点 | cmux-team-dispatch-task | cmux-using |
|------|------------------------|-----------|
| 対象 | 独立タスクの並列ディスパッチ | 汎用的な cmux 操作 |
| 実行単位 | 独立したタスク群 | 単一操作 |
| 隔離 | git worktree（タスクごと） | なし |
| 永続プロセス | なし（スキルのみ） | なし |

**重複を避ける**: cmux-using 固有の機能（基本 cmux 操作）を含めない。

## メンテナンス手順

1. `launch-workspace.sh --help` の出力と SKILL.md の使用例を突き合わせて整合性を確認
2. Child 起動に `launch-workspace.sh` を直接使うこと（`--defer-status` 必須）を SKILL.md・guide-ja.md の使用例と突き合わせて整合性を確認
3. `monitor-dispatch.sh --help` の出力（特に `--heartbeat-interval` / `--resume` / `--dispatch-dir`）と SKILL.md Step 3 の使用例を突き合わせて整合性を確認
4. ステータスプロトコル（status.json スキーマ、`pr_url` を含む）が SKILL.md と guide-ja.md で一致しているか確認
   - クリーンアップは親セッション側で全タスク完了後にまとめて 3 問（workspace / worktree / branch）聞く方式。`status.json` には保存しない
5. superpowers 連携セクション（"superpowers Execution Handoff Integration"）が superpowers プラグインの最新仕様と整合しているか確認
6. `terminal-wait.sh` の config スキーマ（`shell_ready_ms.baseline_ms` / `samples` / `updated_at`）が guide-ja.md の説明と一致しているか確認
7. Display Format Conventions（Template A/B/C）が SKILL.md / guide-ja.md / 子セッションプロンプト埋め込みの `PROGRESS REPORTING FORMAT` の3か所で完全一致しているか確認（カラム数・順序・幅・Mode 略称）
8. モデル選択フロー（MANDATORY MODEL SELECTION SEQUENCE）が **SKILL.md / guide-ja.md / README.md / CLAUDE.md の 4 ファイル**で完全一致しているか確認:
   - 同一 model (opus 1m) は **現セッション継続** (`/model opus[1m]`)
   - 異なる model (sonnet / codex) は **`launch-workspace.sh --mode execute` 経由で別 surface を spawn**。孫 surface の runner wrapper が status.json / `cmux wait-for` シグナル / 親通知を担当。Child は `.deferred` を作って exit (runner は `--defer-status` 付きで起動されており `.deferred` を検知して上書きをスキップ)。Phase B-R 有効時は `.deferred` 作成後も exit せずレビュアーとして待機し、approve 後に exit
   - sonnet は **`--skip-permissions` 必須** (auto mode が効かないため permission prompt でハング防止)
   - **codex 選択肢は `runners.json` に `engine: codex` の runner があるときのみ表示**（無い場合は option から除外）
   - 計画の受け渡しは `--plan-file <path>` で行う (`.cmux-team-dispatch-task-prompt.md` は書き換えず Phase A のものを温存)
9. 配送が `scripts/send-prompt.sh` に一本化され、`cmux send` / `cmux send-key` の直書きが残っていないことを確認（`launch-workspace.sh` / `monitor-dispatch.sh` / `prewarm-panes.sh` / `parallel-directive.sh` の実装、および SKILL.md / `references/` 配下の全 `.md` の指示文。`send-prompt.sh` 自身が唯一の例外）。回帰は `bash test/test-send-prompt-callsites.sh` で検証する: **CS1 = 4 スクリプトに `cmux send` / `cmux send-key` の直書きが残らない**（`send-key` 無しの一方通行の `cmux send` も配送事故になるため両方を検出する）、CS2 = `launch-workspace.sh` と `monitor-dispatch.sh` の両スクリプトが `send-prompt.sh` を呼ぶ、**CS3 = SKILL.md と `references/**/*.md`**（訳の `guide-ja.md` と、`render-loop-prompt.sh` が子タスクプロンプトへ連結する `references/unattended/*.md` を含む）に直書きが残らない。CS1 は対象ファイルが読めない、または grep が status 2 以上を返すときも FAIL にして fail-open させない。訳や無人ループ用ブロックが原文から遅れて旧文面を残す事故を防ぐため、対象をこれら全部に広げてある
   - **免除は行番号ではなくマーカーで行う**: シェルへのコマンド打鍵（TUI へのメッセージ配送ではない）など正当な `cmux send` は、直前 3 行以内（ドキュメントは同一行または直前行）に `send-prompt-exempt:` を含むコメントを置いたときだけ検査から外れる。新しい出現は必ずレビューを通る。**スクリプトのコメント行はマーカー判定より前に無条件で除外される。** したがってコメント中の `cmux send` 言及に付ける `send-prompt-exempt:` は、レビュー済みの意図を残す注釈であって現行 CS1 の load-bearing な条件ではない。マーカーが load-bearing なのは非コメント行の直書き（`launch-workspace.sh:1085-1088`）に対してだけ
10. `runners.json` のスキーマ（`default` / `runners[].name|command|engine|review_model|exec_model|plan_effort|review_effort|exec_effort`）が SKILL.md Step 1f / guide-ja.md「子セッション runner 設定」/ `launch-workspace.sh` の `--runner` 解決ロジックの3か所で一致しているか確認。`review_model` は `engine: codex` の runner では design=claude タスクの Phase A-R/B-R レビューペイン（codex）用モデル、`engine: claude` の runner では design=codex タスクでレビュアー runner に選ばれたときに claude レビューペインへ渡すモデル（未設定時は `opus[1m]` にフォールバック）であることを検証。`exec_model` は codex engine の execute / standby で `--model` 未指定時のみフォールバック適用され（明示 `--model` が優先）、review ペイン（常に `review_model` を明示）には適用されないことを検証。`plan_effort` / `review_effort` / `exec_effort`（codex engine の runner のみ、値: `minimal`|`low`|`medium`|`high`|`xhigh`）は codex セッションの reasoning effort を Phase A 設計 (plan/superpowers) / レビューペイン (review) / 実行系 (execute/standby) にそれぞれ `-c model_reasoning_effort='<値>'` として注入し、明示 `--effort` > runner フィールド > `config.toml` 既定の優先順位で解決されることを検証。特に `engine × MODE` の起動コマンド対応表（claude/codex × plan/superpowers/execute の6通り、codex 側は effort 注入込み）が SKILL.md と guide-ja.md で同一か検証。なお composed command は常に `zsh -ic "..."` で wrap される（`.zshrc` の関数 / env を読み込むため）
11. `launch-workspace.sh` の execute モード関連フラグ（`--mode execute` / `--plan-file` / `--model` / `--skip-permissions` / `--defer-status`）が SKILL.md / guide-ja.md / README.md の Phase B 説明と一致しているか確認。Child が `launch-workspace.sh` を直接呼び `--defer-status` を必ず付けて起動していること、孫側 (Phase B spawn) が `--mode execute` + `--plan-file` で起動していることを検証
12. **`message_type` 廃止後の判定**が SKILL.md / guide-ja.md / README.md / CLAUDE.md で一致しているか確認。通知トランスポートの質問も config キーも存在せず、agmsg を使うかは `~/.agents/skills/agmsg/scripts/send.sh` の存在**だけ**で決まること。`launch-workspace.sh` / `prewarm-panes.sh` が `--message-type` を `was removed` を含む die で拒否し、agmsg 配線は `--agmsg-team` の有無で決まること。agmsg インストール時は monitor-dispatch.sh を起動しないこと、status.json / signal は不変であることを検証。子プロンプトの status protocol に「status.json 書き込み直後の必須完了通知（`send-prompt.sh --label dispatch-notify` の 1 回呼び出し）」が含まれること、Step 1g に AGMSG-DIRECTIVE 遵守(ディスパッチ実行中セッションの watcher 起動。ただし watcher は記録・返信用で wake 手段ではない旨の注記付き)が記載されていることを検証。回帰は `bash test/test-message-type-removed.sh`（MT1-MT3）で検証する
13. pre-warm(`prewarm-panes.sh` / `--mode standby` の split・workspace 配置 / `.assigned-<name>` sentinel / prewarm.json スキーマ(`opus`・`sonnet`・`codex`・`review` + `delivery` + `engine`)/ signal 名 `<slug>-done`・`<slug>-sonnet-done`・`<slug>-codex-done`)が SKILL.md / guide-ja.md / README.md で一致しているか確認。prewarm.json の `engine` フィールドは `opus` が設計 runner の engine に追従（design=codex なら `codex`）、`sonnet` は常に `claude`、`codex` は常に `codex`、`review` は設計 engine の逆であることを検証。standby ペインは Phase A-R 無効時は縦積み(上 opus / 中 sonnet / 下 codex)、design=codex かつ Phase A-R 有効時は 2×2 グリッド（左上: design codex ペイン / 右上: claude レビューペイン `<slug>-opus`。詳細は項目 14）であること、standby wrapper が起動時・未 assigned exit 時に status.json を書かないこと、agmsg インストール時は opus-1m も idle 起動し worktree への delivery 配線をペイン起動前に行うこと、Phase A / Phase B の指示送信が `send-prompt.sh` の 1 回呼び出し（label は `phase-a-task` / `phase-b-exec`。常にタイプ入力し、宛先の ready sentinel 生存時のみ inbox にも記録。呼び出し元は prewarm.json の `delivery` 値で分岐しない）であること、Phase B の手順が「`.assigned-<name>` touch → 実行指示送信 → `.deferred` touch」の順であること、未使用側 pane は close せず開いたまま idle 維持する（常 4 ペイン）ことを検証
14. Phase A-R（設計セッションの plan/spec を逆 engine がレビュー）が SKILL.md / guide-ja.md / README.md / CLAUDE.md の 4 ファイルで一致しているか確認:
    - 有効化は設計 engine 別 2 系統（`REVIEW_ENABLED` / `REVIEW_ENABLED_CODEX_DESIGN`）: design=claude タスクは `engine: codex` runner の `review_model` が存在し `review_mode` が on に解決したとき `REVIEW_ENABLED=true`、design=codex タスクは `engine: claude` runner（レビュアー runner、`REVIEWER_RUNNER`）が存在し `review_mode` が on に解決したとき `REVIEW_ENABLED_CODEX_DESIGN=true`。`review_mode` 解決フロー自体は共通（project config 優先 → global → `"on"` / `"off"` は質問なしで恒久適用、未設定または `"ask"` なら対象 runner 存在時のみ dispatch のたびに 4 択質問[はい今回のみ / いいえ今回のみ / 常に有効 / 常に無効]、「常に〜」のみ永続化）
    - レビューポイント（plan モード: plan 後 1 回 / superpowers モード: spec 後 + plan 後の 2 回）、各ポイント最大 5 往復、approve は何ラウンド目でも即終了、5 往復 needs_work 時は AskUserQuestion（このまま進む / さらに修正）
    - verdict はファイル受け渡し（`<STATUS_DIR>/review/<point>-round-<N>.md` 末尾の `VERDICT: approve|needs_work`）。依頼配送は `send-prompt.sh --label review-plan` の 1 回呼び出し、待機は常に 5 秒間隔・15 分チャンクのファイルポーリング + チャンク境界ごとのレビュアー pane 生存確認（`cmux read-screen --workspace/--surface` の画面差分。read-screen は非フォーカス workspace でも live な内容を返すため refresh 不要 — 実測確認済み。変化ありなら上限なしで待機継続、失敗・空出力は 10 秒間隔 3 回リトライし 2 回連続の境界で全失敗したときのみ pane 消滅扱い。チャンク境界では先に verdict を再確認する）（agmsg push / 返信 push は idle セッションを起こせないため配送・待機手段にしない）。ready sentinel 生存時は依頼文が inbox にも記録される（判定は `send-prompt.sh` が行うので呼び出し元は `review.delivery` で分岐しない）。stalled（1 チャンク画面変化なし / 2 回連続観測不能）時は verdict 最終確認 → 同一ラウンド 1 回再依頼（baseline 取り直し）→ AskUserQuestion
    - レビューペイン engine は常に設計の逆であること（design=claude → codex レビューペイン `<slug>-review` / design=codex → claude レビューペイン `<slug>-opus`）。prewarm 有効 + Phase A-R 有効時は 2×2 均等グリッド。design=claude: 左上 opus / 右上 codex review / 左下 sonnet / 右下 codex。design=codex: 左上 design codex / 右上 claude レビューペイン（`<slug>-opus`。A-R レビュアーと Phase B opus 1m 実装先の二役）/ 左下 sonnet / 右下 codex。無効時は現行縦積み。review ペインは standby wrapper の status 所有権なし（design=claude では `.assigned-<slug>-review` 非使用。design=codex の `<slug>-opus` ペインは Phase B で opus 1m が選ばれたときのみ `.assigned-<slug>-opus` が touch され実装者として status を持つ）、全レビューポイントで同一ペインを再利用し最終 approve 後も開いたまま idle 維持（常 4 ペイン。途中で close せず、最終の全タスク完了クリーンアップでまとめて close）。spawn 失敗時はレビューをスキップして Phase B へ
    - `launch-workspace.sh` の `--mode review` / `--standby-split-direction` / codex engine への `--model` 反映、`prewarm-panes.sh` の `--review-model`（design=claude、`--codex-runner` 必須）/ `--design-runner` + `--reviewer-runner`（design=codex、`--review-model` と相互排他）と prewarm.json `review` キーが SKILL.md の使用例・スキーマと一致
15. **配送の `send-prompt.sh` 一本化**が SKILL.md / guide-ja.md / README.md / CLAUDE.md で一致しているか確認:
    - 指示を送る全箇所（Phase A opus タスク `phase-a-task` / Phase B sonnet・codex・codex 設計 variant の委譲 `phase-b-exec` / Phase A-R review 依頼 `review-plan` / Phase B-R コードレビュー依頼 `review-code` / レビュアーへの abort 通知 `abort-reviewer`（実装者からも runner wrapper の `notify_reviewer_once` からも同じ label を使う。`dispatch-abort` は廃止）/ 親への完了・abort 通知 `dispatch-notify` / `monitor-dispatch.sh` の heartbeat・全完了・DIED 通知 `dispatch-monitor`）が **`send-prompt.sh` の 1 回呼び出し**になっており、`cmux send` + `cmux send-key return` の 2 行ペアが残っていないこと。label は上記のとおり固定（1 メッセージクラス = 1 label）
    - `send-prompt.sh` の契約が 4 ファイルで一致すること: **常にタイプ入力する**（idle セッションを起こせる唯一の手段）/ `--agmsg-*` の 3 引数が揃い宛先の ready sentinel が存在するときだけ**追加で** inbox に記録する（wake 手段ではなく、失敗しても配送の成否と終了コードに影響しない。**記録は必ずタイプ入力の後**に行う — `send.sh` は共有 SQLite DB への書き込みで固まりうるが macOS には `timeout` / `gtimeout` が無いため、先に走らせると唯一の wake 手段に到達できず dispatch がデッドロックする）/ 400 文字超は `<outbox-dir>/<label>-<seq>.md` へ退避しポインタ 1 行だけをタイプする / Enter 後に `cmux read-screen` で入力欄が空になったことを確認し最大 3 回まで再送する（確認が働くのは**宛先が 0 桁目に `❯` / `>` のプロンプト行を描画している場合**。該当行が無いペイン — codex レビューペインなど — は検証なしで配送済み扱いになるので、4 ファイルとも無条件の保証として書かない）/ 観測不能は失敗ではなく配送済み扱い（二重配送の防止）
    - **ready sentinel は wake 能力の証明にならない**旨が書かれていること（watcher プロセスの生存しか示さず、idle セッションへ注入できる仕組みの下でも素のバックグラウンドシェルの下でも同じ sentinel が書かれる。検証結果は `docs/superpowers/specs/2026-08-12-delivery-verification-results.md`）。呼び出し元は prewarm.json の `delivery` 値で分岐しない（sentinel の確認は `send-prompt.sh` 自身が行う）
    - `prewarm-panes.sh` が配線失敗（`CLAUDE_DELIVERY=cmux-send`）時に opus / sonnet の初期プロンプトを `/agmsg actas` なしの「直接タイプされる」文面に出し分けること。配線成功時のプロンプトも「タスクはタイプ入力で届く（inbox に同一コピーあり）」文面であり「agmsg message として届く」とは書かないこと
    - 回帰は `bash test/test-send-prompt-callsites.sh`（CS1-CS3）と `bash test/test-send-prompt.sh`（SP0a-SP0d / SP1-SP24）で検証する
16. plan モードの遵守ゲート（ExitPlanMode hook）が SKILL.md / guide-ja.md / README.md / CLAUDE.md の 4 ファイルで一致しているか確認:
    - `launch-workspace.sh` が `--mode plan` かつ claude engine のときのみ worktree の `.claude/settings.local.json` に PostToolUse hook（matcher: `ExitPlanMode`、command: `zsh <skill-dir>/scripts/plan-approved-hook.sh`）を注入すること（既存 settings は jq マージ、worktree 再利用時は重複注入なし、失敗は警告のみで dispatch 続行）
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
    - プロトコル: findings は `<STATUS_DIR>/review/code-round-<N>.md` 末尾の `VERDICT: approve|needs_work`、最大 5 往復、実装者の verdict 待ちは 5 秒間隔・15 分チャンクのファイルポーリング + レビュアー pane の read-screen 画面差分による生存確認（活動中は上限なしで待機。standby が実装者のケース。設計セッション自身が実装を継続するケースは Phase A-R Round loop の待ち方を流用）、stalled（1 チャンク画面変化なし / 2 回連続観測不能）は verdict 最終確認 → 同一ラウンド 1 回再依頼 → それでも stalled なら claude 実装者は AskUserQuestion（再依頼 / レビュー省略して PR 作成）、codex 実装者はレビュー省略を PR 本文に注記して続行
    - 5 往復 needs_work: claude 実装者は AskUserQuestion（このまま PR 作成 / さらに修正）、codex 実装者は PR 本文に注記して続行
    - status.json の done/error 遷移は従来どおり実装者ペインの wrapper が所有。実装者がレビューを依頼せず終了しても Child は idle のまま残り、最終クリーンアップで閉じる（孤児ガード用の追加機構は無い）
    - spawn 経路: Child が `<STATUS_DIR>/review/code-review.json`（`{reviewer_surface, reviewer_workspace, review_dir}`。`reviewer_workspace` は実装孫が別 workspace に spawn されるため、依頼配送の `send-prompt.sh --to-workspace` と read-screen 生存確認の両方に使う。欠落時は `--workspace` 指定なしにフォールバック）を書き、`launch-workspace.sh --mode execute --review-config <path>` で孫を起動。wrapper が composed prompt にプロトコル（依頼は `send-prompt.sh` の 1 回呼び出し + ポーリング）を追記する。`--review-config` は execute モード専用で、usage コメント / SKILL.md / guide-ja.md の使用例が一致していること。REVIEW_INSTRUCTION（liveness 文言・reviewer_workspace 埋め込み・クォート非混入）と ABORT_REVIEW_STEP / ABORT_PARENT_STEP の `send-prompt.sh` 呼び出しは `bash test/test-launch-workspace-review-config.sh` の静的検査（PR1-PR3 / AB1-AB5）で検証すること
18. クロスエンジンレビューと codex effort が SKILL.md / guide-ja.md / README.md / CLAUDE.md の 4 ファイルで一致しているか確認:
    - 「レビュアーは常に相手方 engine」原則と B-R 6 ケース表（設計 claude/codex × 実装者 opus 1m/sonnet/codex）が一致
    - design=codex: Phase B は 3 択とも委譲（設計セッションは実装しない）。右上ペインは agent `<slug>-opus`・A-R レビュアー兼 opus 1m 実装先の二役、opus 1m 選択時のみ `.assigned-<slug>-opus` が touch され signal `<slug>-opus-done`
    - Step 1f のレビュアー runner 選択（claude runner 0 件 → 無効警告 / 1 件 → 自動 / 2 件以上 → 毎回質問）と `CLAUDE_REVIEW_MODEL` フォールバック（`opus[1m]`）
    - effort の優先順位（明示 `--effort` > runner フィールド > config.toml 既定）と MODE 対応（plan_effort: plan/superpowers、review_effort: review、exec_effort: execute/standby）。prewarm の設計 codex ペインは standby 起動のため `--effort <plan_effort>` 明示
    - `prewarm-panes.sh` の `--design-runner` / `--reviewer-runner`（`--review-model` と相互排他）と prewarm.json の `engine` フィールド
19. `design_runner` / `exec_choice` の precedence（project config → global config → ask）と警告フォールバックが SKILL.md / guide-ja.md / README.md / CLAUDE.md で一致しているか確認。`design_runner` は有効 runner 名で switch / per-task 質問を両方省略し、`exec_choice` は有効値で Phase B の AskUserQuestion を default-direct に置換することを確認。**未設定と明示 `"ask"` の区別**も確認: 未設定（全レイヤー未設定または不正）では永続化オプション付きの質問（design_runner は switch 質問 4 択、exec_choice はモデル選択直後の永続化確認 1 問）、明示 `"ask"` では従来質問のみで永続化オプションなし（キー削除 = 未設定に戻り再表示、`"ask"` 書き換え = 非表示 — 2 つの戻し方の違いが 4 ファイルで明記されていること）。不正値の検証は **project / global のレイヤーごと**で、不正なレイヤーだけ警告して無視し次へフォールバックする（project の不正値が global の「常に〜」を遮蔽しない）こと。「常に〜」の永続化は `review_mode` と同じ jq merge でグローバル config のみに書き込み（project config には書かない）、一時ファイルは **writer 固有の mktemp + 同一ディレクトリ mv**（共有 `$CONFIG.tmp` は並列書き込みで壊れるため禁止）であること。exec_choice の永続化確認は子セッションが書くため並列時はファイル全体の last-write-wins であること
20. codex の engine × MODE 起動規則を確認: superpowers は bypass 付き、review は `--sandbox workspace-write` + `-c approval_policy='never'` + `--add-dir <STATUS_DIR>` の3点セットで、sandbox 完全 off を使わず findings 書込先を許可すること
21. Phase B 実装セッションの **exit 指示が engine 対応** であることを SKILL.md / guide-ja.md の**両経路**で確認: claude(opus/sonnet) は「run /exit」、codex は「end this codex session immediately … Do NOT run /exit」。(a) spawn 経路（`--mode execute`）は `launch-workspace.sh` の `EXIT_INSTRUCTION`（`RUNNER_ENGINE` で分岐）が焼き込む、(b) prewarm standby 経路は親→standby へ `send-prompt.sh` で送る `REQUEST_TEXT` に含める。codex の prewarm block（`{{CODEX_BEHAVIOR_BLOCK}}` step 3）は sonnet branch とは別 branch のため **base `REQUEST_TEXT` を独自に定義** しなければならない（未定義だと実行指示が空になり、`/exit` 誤用だと codex が TUI に idle 残留して runner wrapper が完了通知に到達しない）。**Phase B-R 有効時は「共通プロトコル a」の拡張 `REQUEST_TEXT` が base を上書きする。したがって拡張側にも (1) engine 別の exit 指示（codex は `END THE CODEX SESSION ITSELF` / `do NOT run /exit`）と (2) 完了通知（`send-prompt.sh --label dispatch-notify` の 1 回呼び出し）の両方を必ず持たせること。** 旧仕様は末尾が engine 中立の 1 文（`run /exit (claude) or end the session (codex)`）で通知にも触れていなかったため、Phase B-R を有効にした瞬間に codex 用の強い指示が失われ、実装完了後も codex が TUI に idle 残留 → wrapper の完了通知に到達せず、standby は task prompt を読まないので子側の必須通知も存在せず、**親に一切通知が届かない**という事故が実際に発生した。standby ペインが受け取るのはタイプ入力で届いた `REQUEST_TEXT` だけであり、「finish per the instructions below」に対応する status protocol は存在しない点に注意。回帰は `bash test/test-launch-workspace-codex.sh`（T5b/T5c/T6b/T7/T14/T15）で検証

22. runner wrapper の **signal 終了ガード**が SKILL.md / guide-ja.md / README.md / CLAUDE.md の 4 ファイルで一致しているか確認: 子プロセスの終了コードが 128 以上（signal 由来。SIGHUP=129 / SIGKILL=137 / SIGTERM=143）**かつ** `status.json` が既に terminal（`done` / `error`）のときだけ、status 書き込みと親通知の両方をスキップすること。`executing` のまま kill されたケース、および signal 以外の異常終了（exit 1 等）は従来どおり `error` を報告すること（ガードを広げすぎない）。最終クリーンアップの pane close で完了済みタスクが `error` に降格し偽通知が飛ぶ事故の再発防止であり、回帰は `bash test/test-runner-signal-exit.sh`（S1–S6、生成された runner script を実際に実行する動的テスト）で検証する
23. **error パスの通知**が SKILL.md / guide-ja.md / README.md / CLAUDE.md の 4 ファイルで一致しているか確認:
    - runner wrapper が子の書いた終端 status を上書きしないこと（`PREV_STATUS` が `error` なら常に保持、`done` は正常終了時のみ保持、`done` + 非ゼロ終了は保守的に `error`）。親通知のラベルは終了コードではなく確定 status から導出すること
    - status.json watcher が子プロセスと並行して走り、15 秒間隔（`CMUX_DISPATCH_WATCH_INTERVAL` で上書き可）で終端遷移を検知して通知すること。抑止条件は exit パスと同一（timeout sentinel / `.deferred` / 未 assigned standby / 他 pane の `.assigned-*`）で、poll のたびに再評価すること
    - 通知処理は `notify_parent()` / `notify_parent_once()` に一本化し、watcher と exit パスの両方が同じ関数を呼ぶこと。marker `.notified-<slug>` は存在の有無ではなく通知済み status 文字列を保持し、通知が成功したときだけ更新すること
    - 実装者の ABORT/ESCALATION プロトコル（findings 記録 → レビュアー通知 → status.json → 親通知 → セッション終了）が prewarm 経路と spawn 経路の両方に入り、unattended 文面にも同じ手順があること
    - workspace レイアウトの Child 起動にも `--defer-status` を渡すこと。これが無いと、Phase B で実行を別 surface へ移譲した Child の wrapper が孫の書いた終端状態を上書きしてしまう
    - `timeout` / `gtimeout` を使わず、`bash test/test-runner-terminal-status.sh` と `bash test/test-runner-signal-exit.sh` で回帰を検証し、既知の未解決パターンは `docs/notification-gaps.md` を参照すること
24. **codex hook 互換性の preflight** が `launch-workspace.sh` / `README.md` / ルート `CLAUDE.md`（「Codex hook 互換性」節）で一致しているか確認:
    - `launch-workspace.sh` の `warn_if_codex_incompatible_hooks()` が `${CODEX_HOME:-$HOME/.codex}/config.toml` を **read-only** で検査し、`[plugins."security-guidance@claude-plugins-official"]` が `enabled = true` のときだけ `log "warn"` すること。**config を書き換えず、dispatch も止めない**
    - 呼び出しは `RUNNER_ENGINE == "codex"` のときだけ。config が無い / セクションが無い場合は未インストールとみなし警告しない（誤警告ゼロが要件）
    - 回帰は `bash test/test-launch-workspace-codex.sh` の H1〜H4（有効時に警告 / 無効時は無警告 / config 無しで無警告 / claude engine では無警告）で検証する。警告文言を変えたら `HOOK_WARN` も同時に更新すること
    - 恒久的な直し方（`~/.codex/config.toml` の `enabled = false`、repo 内では `bash scripts/codex-hook-compat.sh disable`）は README とルート `CLAUDE.md` の両方に書く。SKILL.md / guide-ja.md は対象外 — 子セッションの振る舞いを変えない `launch-workspace.sh` 内部の診断ログだから

25. **permission prompt 抑止の settings 注入**が `launch-workspace.sh` / `SKILL.md` / `guide-ja.md` / `README.md` で一致しているか確認:
    - `launch-workspace.sh` の Step 2a が `RUNNER_ENGINE == "claude"` のときだけ、MODE を問わず worktree の `.claude/settings.local.json` に `permissions.defaultMode: "bypassPermissions"` をマージすること。既に同値なら書き込まずスキップ（worktree 再利用時の二重注入なし）、失敗は警告のみで dispatch を止めないこと
    - 書き込みは `merge_claude_settings` ヘルパー経由で、一時ファイルは**同一ディレクトリの `mktemp` + `mv`**（共有名 `$FILE.tmp` は prewarm の並列書き込みで壊れるため禁止）。同ヘルパーは plan モードの ExitPlanMode hook 注入からも使われ、両者が同じ `settings.local.json` に共存すること
    - `info/exclude` への `.claude/settings.local.json` / `.claude/plans/` 追記が `ensure_claude_exclusions` に一本化され、plan モード限定ではなく claude engine の全 MODE で走ること
    - codex engine には**一切注入しない**こと。codex の `--dangerously-bypass-approvals-and-sandbox` とレビューペインの `--sandbox workspace-write` + `-c approval_policy='never'` + `--add-dir <STATUS_DIR>` は不変（項目 20 / 39）
    - loop の `UNATTENDED=1 && RUNNER_ENGINE == claude → SKIP_PERMISSIONS=1` と `prewarm-panes.sh --unattended` が不変であること
    - `AskUserQuestion` が対話的に残る根拠（permission gate と対話 UI は別レイヤー / `--dangerously-skip-permissions` と `bypassPermissions` は公式ドキュメント上等価）と、`skipDangerousModePermissionPrompt` をユーザー設定に置く必要があることが README と guide-ja.md の両方に書かれていること
    - `ensure_claude_exclusions` の呼び出しは `|| true` を付けること。`launch-workspace.sh` は `set -euo pipefail` で走るため、bare 呼び出しだと `info/exclude` を解決できない cwd（非 git など）で launch ごと死ぬ
    - 回帰は `bash test/test-launch-workspace-permissions.sh` の P1〜P11（全 MODE 注入 / codex 非対象 / 既存キー保持 / 冪等 / superpowers にフラグを足さない / info/exclude 追記 / `--skip-permissions` との共存 / 非 git cwd でも launch が成功）で検証する

26. **レイアウトの workspace 固定**が `launch-workspace.sh` / `monitor-dispatch.sh` / `SKILL.md` / `guide-ja.md` / `README.md` / `CLAUDE.md` で一致しているか確認:
    - `launch-workspace.sh` が `--layout` / `--split-from` / `--split-direction` / `--parent-workspace` を、メッセージに `was removed` を含む明示的な die で拒否すること。composed command に `claude-teams` が現れないこと
    - `monitor-dispatch.sh` が `--layout` / `--parent-surface` を同様に拒否し、親通知を常に `--workspace` 宛へ送ること。DIED 通知の再起動例に削除済みフラグを含めないこと
    - SKILL.md / guide-ja.md に `{{LAYOUT}}` / `LAYOUT_MODE` / `LAYOUT=split` が残っておらず、起動例に削除済みの split 系フラグが残っていないこと。最終クリーンアップは workspace を閉じる 1 経路に統一すること
    - stdout JSON と初期 `status.json` の `layout` が定数 `"workspace"` のまま残り、`split_from` / `split_direction` キーは出力されないこと
    - `launch-session-splits.sh` / `cmux-grid.sh` が存在せず、README の移行注記以外の利用手順に削除済みレイアウトへの参照が残らないこと
    - 回帰は `bash test/test-launch-workspace-layout.sh` と `bash test/test-monitor-layout.sh` で検証すること

27. **タスク内の並列実行**が SKILL.md / guide-ja.md / README.md / CLAUDE.md の 4 ファイルで一致しているか確認:
    - 文面の単一情報源は `scripts/parallel-directive.sh`。`--engine <claude|codex>` × `--mode <plan|superpowers|execute|review>` で 1 行を出力し、`--agents <N>`（2〜8、既定 4）で同時実行の上限を変える。`standby` モードは存在せず、standby ペインには `--mode execute` を渡す
    - **出力に `'` `"` `` ` `` `$` `!` `\` を 1 文字も含めてはならない**。composed command は `zsh -ic "... '<prompt>' ..."` で二重に引用され、`launch-workspace.sh` はエスケープしない（`-i` は対話モードなので history 展開が効き `!` も特殊文字になる）。回帰は `bash test/test-parallel-directive.sh` の PD4 で検証する
    - superpowers への譲歩文（subagent-driven-development の「実装者は同時に 1 体」を上書きしない旨）は engine / mode で出し分けず常に出力する。codex も `superpowers:brainstorming` 前置でパイプラインを辿るため
    - **適用範囲の一文（「調査と検証にだけ適用する」）は同時編集の禁止文より前に置き、直前の並列化ディレクティブに係らせる**。禁止文の後ろに置くと最近接先行詞が禁止文になり「同時編集の禁止は調査と検証にだけ適用される = 実装中は同時に編集してよい」と読めてしまい、guardrail が防ぎたい事故そのものを許可する
    - **分散を許すのは読み取り専用の検証だけ**。auto-fix / write モード（formatter・linter の write フラグ）はファイルと共有ビルドキャッシュを書き換えるため逐次に走らせる旨を execute モードの文面に含める
    - `launch-workspace.sh` が注入するのは plan / superpowers / execute の起動プロンプトだけ。standby / review はプロンプト無しで起動するので、指示は親が `send-prompt.sh` で送るテキストに含める。execute では `EXIT_INSTRUCTION` を必ず最後に残すこと
    - **注入点は 5 箇所**（起動プロンプト / Phase B 実行指示 / Phase A-R レビュー依頼 / Phase B-R レビュー依頼（prewarm 経路）/ Phase B-R レビュー依頼（spawn 経路））。この 5 行の表が SKILL.md と guide-ja.md で一致し、かつ**全行が実在すること**を確認する。特に prewarm 経路は、レビューペイン自身が `--mode review` 起動でディレクティブを持たないため、「共通プロトコル a」の拡張 REQUEST_TEXT に `--mode review`（engine は実装者の逆）のディレクティブを含め、実装者がレビュー依頼文へ転記する形でしか届かない
    - **他 engine 宛のディレクティブを引用するときは宛先を語彙で明示する**（`Also include this in the message to the reviewer, addressed to the reviewer and not to you:` … `End of the message to the reviewer.`）。実装者のプロンプトにはレビュアー向け（逆 engine）のディレクティブが同居するため、位置だけを境界にすると claude 実装者が `spawn_agent` を自分宛と誤読する。`launch-workspace.sh` の `REVIEWER_PARALLEL` と SKILL.md の共通プロトコル a の両方で同じマーカーを使うこと
    - Phase B-R の spawn 経路は `review/code-review.json` の `reviewer_engine`（`claude` / `codex`）から依頼文へ埋め込む。欠落時（旧スキーマ）は注入しない。`--no-parallel` は起動プロンプト専用のスイッチで、レビュー依頼文の注入判定には使わない
    - **`--no-parallel` はテスト基盤としても load-bearing**。`test/test-launch-workspace-review-config.sh` が起動プロンプト側の注入を止めてレビュー依頼文側の注入だけを切り分けるために渡している（`PARALLEL EXECUTION` が見つかったら必ずレビュー依頼文由来と言える状態を作っている）。フラグを削るなら同等の切り分け手段を別途用意すること
    - `--agents` / `--no-parallel` は `launch-workspace.sh` のスクリプトレベルのフラグで、SKILL.md の起動例はどちらも渡さない。`config.json` のキーも無い（`design_runner` / `exec_choice` / `review_mode` と違い precedence chain を持たない）。README にはスキルが公開していない旨と、手動起動が唯一の手段である旨を書く
    - 回帰は `bash test/test-parallel-directive.sh`（PD1-PD7）、`bash test/test-launch-workspace-codex.sh`（PL1-PL10）、`bash test/test-launch-workspace-review-config.sh`（PR1-PR3）で検証する

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
2. **レイアウト**: 常に workspace であること
3. workspace モード: 各タスクが別タブで起動すること
5. `.dispatch/*/status.json` が更新されること
6. 完了シグナルが正しく発火すること
7. **テーブル表示**: Step 1f の Template A、Step 3 の Template B、最終レポートの Template C が Box drawing 文字で出力されること（Mode 列が `superpwr` / `plan` で含まれていること）
8. **モデル選択（動的表示）**: `exec_choice` が未設定または `"ask"` の子セッションは Phase A 完了後に AskUserQuestion を出すこと。**design=claude** タスクでは `runners.json` に `engine: codex` runner が無い場合は **opus 1m / sonnet の 2 択**、ある場合は **3 択 (opus 1m / sonnet / codex)** になること。固定値では質問を出さず既存の対応分岐へ直行すること
9. **同一 model (opus 1m)**: 選択時に `/model opus[1m]` が実行され、同 surface 内で実装が継続されること
10. **異なる model (sonnet)**:
    - Child セッションが `launch-workspace.sh --mode execute --plan-file <path> --model sonnet --skip-permissions ...` を呼ぶこと
    - 新 workspace が立ち上がり、`claude --model sonnet --dangerously-skip-permissions 'Read and execute the plan at <path>. ... run /exit ...'` が runner script (`bash .cmux-team-dispatch-task-run-<slug>-exec.sh`) でラップされて起動すること (inner prompt 末尾に `/exit` 指示が付与されること、runner ファイル名は workspace 名で unique 化されること)
    - Child が `<STATUS_DIR>/.deferred` を touch して exit すること
    - Child の runner wrapper が `.deferred` を検知し、`status.json` を上書きせず exit すること
    - 孫の Claude が PR 作成後に自動で `/exit` を発火して TUI を閉じること (これにより runner wrapper が完了処理に到達する)
    - 孫の runner wrapper が完了時に `status.json` を `done` に遷移させ、`cmux wait-for --signal <slug>-exec-done` 発火、親に `[dispatch] task "<slug>-exec" finished (status: done)` を送ること
11. **異なる model (codex)**: Child が `launch-workspace.sh --mode execute --runner <codex-runner> ...` を呼び、`runners.json` の codex runner で新 surface が起動。`--dangerously-bypass-approvals-and-sandbox` 付きで実行し、`external_migration` により親 claude session を引き継ぐこと（`cmux codex install-hooks` が前提）。完了通知フローは sonnet と同じ
12. **monitor heartbeat**: `monitor-dispatch.sh` から60秒おきに `[dispatch-monitor] alive | loop=N | ...` が親に届くこと
13. **Enter 自動押下と長文の詰まり解消**: 親が claude TUI でも、完了通知や長い指示文が input box に残らず自動で読み取られること（`send-prompt.sh` が Enter を押したあと `cmux read-screen` で入力欄が空になったことを確認し、残っていれば最大 3 回まで再送する。400 文字超は outbox へ退避されポインタ 1 行だけがタイプされる）
14. **死亡検知**: monitor を `kill` した直後に `[dispatch-monitor] DIED ...` メッセージが親に届くこと
15. **`--resume`**: 既存の `.dispatch/` がある状態で monitor を `--resume` 起動 → 完了済みは skip、未完了のみ監視継続すること
16. **message_type 廃止**: 通知トランスポートの質問が一切出ないこと。`config.json` に `message_type` を書いても無視されること。`launch-workspace.sh` / `prewarm-panes.sh` に `--message-type` を渡すと `was removed` で即座に失敗すること
17. **agmsg インストール時**: monitor-dispatch.sh が起動しないこと。子が status.json に done/error を書いた**直後**に `[dispatch] task ... finished` が `send-prompt.sh` のタイプ入力で親に届き(親が idle のままでも届くこと — これがタイプ入力を唯一の wake 手段にする理由)、親の watcher が生きていれば同一文が inbox にも記録されること。wrapper の exit 時通知で同じ通知が重複して届くことがあるのは正常。ディスパッチ実行中の親セッションで AGMSG-DIRECTIVE により watcher が起動していること。status.json は従来どおり遷移すること
18. **pre-warm**: 各タスク workspace が縦分割ペインになること(agmsg インストール時: 上 opus-1m[idle] / 中 sonnet / 下 codex、未インストール時: 上 opus[タスク実行中] / 中 sonnet / 下 codex。codex runner が無ければ縦2分割)。agmsg インストール時は全ペインが idle 起動し、親からの `send-prompt.sh --label phase-a-task`(`.assigned-<slug>` touch 後)で Phase A が開始されること。`prewarm: false` では起動しないこと。タスク未割り当てのまま workspace を閉じても status.json が汚れないこと
19. **Phase B prewarm 経路**: sonnet 選択 → 未使用側 (codex) standby pane は開いたまま idle 維持され、`.assigned-<slug>-sonnet` が touch され、待機 pane へ実行指示が送信され、実装完了 exit 時に standby wrapper が status.json を done にし `<slug>-sonnet-done` signal + 親通知が発火すること。opus 1m 選択 → 未使用側 standby pane(sonnet / codex)は開いたまま status.json が汚れないこと(常 4 ペイン維持。途中で close しない)。prewarm.json が無い場合は従来の spawn にフォールバックすること。実行指示の送信が `send-prompt.sh --label phase-b-exec` の 1 回呼び出しであること(常にタイプ入力が行われ、宛先 watcher 生存時のみ inbox にも記録される — タイプ入力だけで idle ペインが確実に起きること)。codex 配線失敗時に `delivery: "cmux-send"` へフォールバックすること
20. **Phase A-R 無効**: `review_model` 未設定または `review_mode: off` で、現行フローと完全一致すること（prewarm レイアウトも縦積みのまま。Phase A 直後は `exec_choice` の解決済み方式、すなわち質問または default-direct に従う）
21. **Phase A-R 有効 + prewarm（design=claude）**: 2×2 均等グリッドで 4 ペイン起動（左上 opus / 右上 review [idle codex, `--model <review_model>`] / 左下 sonnet / 右下 codex）。prewarm.json に `review` キーがあること（design=codex の場合は項目 33 を参照）
22. **レビューループ**: plan モードで plan 完成後に 1 回、superpowers モードで spec 後 + plan 後の 2 回レビューが走ること。needs_work → opus が修正して**同一ペイン**に再依頼（新ペインが生えない）。approve → レビューペインは開いたまま（close されず）Phase B の解決済み方式が走ること。5 往復 needs_work → AskUserQuestion（このまま進む / さらに修正）が出ること
23. **verdict プロトコル**: `.dispatch/<slug>/review/<point>-round-<N>.md` が生成され、末尾に `VERDICT:` 行があること。両モードともファイルポーリング(5 秒間隔・15 分チャンク + `cmux read-screen` 画面差分によるレビュアー生存確認。活動中は上限なしで待機し、レビュー中に 15 分超過しても再依頼が飛ばないこと。最終 sleep 中に書かれた verdict もチャンク境界の再確認で検知されること)で verdict を検知すること(agmsg push 待ちは idle セッションを起こせないため使わない)
24. **review_mode 解決**: config 未設定（または `"ask"`）+ `review_model` 付き runner ありで、dispatch のたびにタスク起動前に 4 択質問（はい今回のみ / いいえ今回のみ / 常に有効 / 常に無効）が出ること。「今回のみ」では config に書き込まれず次回も質問が出ること。「常に〜」で `"on"` / `"off"` が永続化され以後質問が出ないこと。`.dispatch/config.json` の `review_mode` がグローバルより優先されること
25. **status 非汚染**: レビューペインの存在が standby の `.assigned-*` / status.json に影響しないこと（途中で close せず開いたままでも汚染しないこと、レビューペイン spawn 直後に status.json が "launched" で上書きされないことを含む）。prewarm 無効時は最初のレビューポイントで `--mode review` のオンデマンド spawn が行われること
26. **exec_model**: codex runner に `exec_model` 設定時、Phase B の codex 実行（`--mode execute` spawn / prewarm codex standby）が `--model <exec_model>` 付きで起動すること。レビューペインは `review_model` のまま変わらないこと。`--model` 明示時は明示値が優先されること。`exec_model` 未設定なら従来どおり codex 側デフォルトで起動すること
27. **watcher 死亡時のフォールバック**: `delivery: "agmsg"` のタスクで宛先ペインの watcher を kill（ready sentinel が消える）した後に指示を送ると、inbox 記録がスキップされタイプ入力のみで配送されること（watcher 生存時もタイプ入力は常に行われる — inbox 記録の有無だけが変わる）。`send.sh` 自体が失敗した場合も配送は継続し終了コードは 0 のままであること。配線失敗（`delivery: "cmux-send"`）タスクの opus / sonnet 初期プロンプトに `/agmsg actas` が含まれず、「typed directly into this pane」の文面になること。配線成功タスクの初期プロンプトは「task will arrive as a prompt typed into this pane（inbox に同一コピー）」の文面であること
28. **plan モード遵守ゲート**: plan モード子セッションで ExitPlanMode 承認後、ファイル編集前に Phase A-R（有効時）→ Phase B の task prompt 解決済み方式が走ること。worktree に `.claude/settings.local.json` が生成され、settings と `.claude/plans/` 配下の plan ファイルのどちらも `git status` に現れないこと。superpowers モードの worktree には hook が注入されないこと。既存の `.claude/settings.local.json` がある worktree では既存キーが保持されたままマージされること
29. **Phase B-R (design=claude, codex 実装)**: `review_mode: on` + codex 選択 → 実装者（codex standby）がコミット後・PR 作成前に設計 opus ペインへレビュー依頼し、Child が `review/code-round-1.md` に VERDICT を書くこと。needs_work → 実装者が修正して round 2 を依頼し**同じ opus セッション**がレビューすること。approve → PR が作成され、opus Child が exit すること。Child は `.deferred` touch 後も exit せず待機していること（sonnet 実装時のレビュアーはコードレビューペインに変わっている — 項目 36 を参照）
30. **Phase B-R (opus 1m 実装)**: `review_mode: on` + opus 1m 選択 → コミット後・PR 作成前にポイント id `code` の依頼が **Phase A-R と同一の codex レビューペイン**に送られること。レビューペイン spawn 失敗済みの場合はレビューが省略され PR 作成へ進むこと
31. **Phase B-R 無効 / spawn 経路**: `review_mode: off` では Child が従来どおり `.deferred` touch 後すぐ exit し、実行指示にレビュープロトコルが含まれないこと。prewarm 無効時は `--review-config` 付き spawn で孫の inner prompt に `MANDATORY CODE REVIEW` 文が入り、`review/code-review.json` が生成されること。5 往復 needs_work → claude 実装者は AskUserQuestion が出る / codex 実装者は PR 本文に未解決指摘が注記されること
32. **codex effort 注入**: codex runner に effort 3 フィールド設定時、composed command（`.cmux-team-dispatch-task-run-*.sh` 内）に `-c model_reasoning_effort='xhigh'`（plan/review）/ `'high'`（execute/standby）が入ること。未設定フィールドでは `-c` が付かないこと。`--effort` 明示時はそちらが優先されること
33. **design=codex ディスパッチ**: runner に codex を選んだタスクで 2×2 グリッドが 左上 design codex / 右上 claude レビューペイン（agent `<slug>-opus`、モデルはレビュアー runner の `review_model` または `opus[1m]`）/ 左下 sonnet / 右下 codex になること。claude runner が 2 件以上あるときレビュアー選択質問が出ること
34. **design=codex の Phase A-R**: codex が書いた plan/spec を右上 claude ペインがレビューし、`review/<point>-round-<N>.md` の VERDICT で往復すること
35. **design=codex の Phase B**: 3 択すべてが委譲であること。opus 1m → `.assigned-<slug>-opus` touch + 右上ペインが実装 + 設計 codex ペインが B-R レビュー。sonnet → 設計 codex ペインが B-R レビュー。codex → 右下 standby が実装 + 右上 claude ペインが B-R レビュー
36. **design=claude の sonnet B-R 変更**: sonnet 実装時のコードレビューが codex レビューペインに依頼され（設計 opus ペインではなく）、設計 opus ペインは `.deferred` 後に exit すること
37. **design_runner default**: project config が global config より優先し、有効な runner 名では Step 1f の switch / per-task 質問が出ないこと。runner 数分岐（1件は黙って採用・質問なし）は維持しつつ、**未設定**では runner 2 件以上の switch 質問が 4 択（いいえ今回のみ / はい今回のみ / 常に既定 runner / 常に固定 runner を選ぶ）になり「常に〜」でグローバル config に永続化されること。明示 `"ask"` では従来の 2 択のみで永続化オプションが出ないこと。不正名は該当レイヤーのみ警告して無視され（project 不正 → global へフォールバック）、全レイヤー不正・未設定なら 4 択になること
38. **exec_choice default**: `"sonnet"` を設定すると Phase A 完了後に AskUserQuestion を出さず sonnet standby/spawn の既存手順へ進むこと。**未設定**（全レイヤー未設定、または不正値・runner 未登録の `"codex"` が警告付きで無視された結果）ではモデル選択の直後に永続化確認（今回のみ / 常にこの選択 / 常に毎回選ぶ[= `"ask"` を保存]）が 1 問出て、「常に〜」でグローバル config に永続化されること（回答は今回の Phase B 分岐に影響しない。書き込みは writer 固有 mktemp + mv）。project に不正値・global に有効値がある場合は global の値が使われること。明示 `"ask"` ではモデル質問のみで永続化確認が出ないこと
39. **codex 起動安全性**: superpowers は bypass で approval prompt を出さず、review は `--sandbox workspace-write` + `-c approval_policy='never'` + `--add-dir <STATUS_DIR>` で worktree 外の `<STATUS_DIR>/review/` に findings を書けること。`bash test/test-launch-workspace-codex.sh` の静的検査を実行すること
40. **pane close の誤通知**: 全タスク完了後のクリーンアップで standby / 実装ペインを閉じたとき、`[dispatch] task ... finished (status: error)` が親へ飛ばないこと、`status.json` の `done` が保持されること。`executing` 中の pane を閉じた場合は従来どおり `error` 通知が飛ぶこと。`bash test/test-runner-signal-exit.sh` の動的検査を実行すること
41. **タスク内の並列実行**: plan / superpowers / execute で起動した子セッションのプロンプトに `PARALLEL EXECUTION, mandatory` が含まれること。codex には `spawn_agent`、claude には Task サブエージェントの指示が届くこと。standby / review の起動コマンドには含まれず、親が送る実行指示・レビュー依頼側に含まれること。`--no-parallel` で起動プロンプトから消えること
# GitHub issue 自動ループの保守

`--loop` の仕様は `skills/cmux-team-dispatch-task/references/loop-mode.md` を正本とする。loop CLI、プロンプト、起動フラグを変更するときは SKILL.md、guide-ja.md、README.md、CLAUDE.md を同時に更新し、`.dispatch-loop/` の owner lock と timeout sentinel の契約を維持する。
