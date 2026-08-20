# cmux-team-dispatch-task 開発ガイド

cmux ワークスペースを活用した並列タスクディスパッチスキル。
各タスクに独立した git worktree + Claude Code セッションを割り当て、親セッションがオーケストレーションを行う。

## ファイル構成

| ファイル | 役割 |
|---------|------|
| `skills/cmux-team-dispatch-task/SKILL.md` | メインスキル定義（3ステップワークフロー） |
| `skills/cmux-team-dispatch-task/references/guide-ja.md` | 日本語リファレンスガイド |
| `skills/cmux-team-dispatch-task/scripts/launch-workspace.sh` | ワークスペース/スプリット起動スクリプト |
| `skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh` | design / review / executors の role-aware prewarm と agmsg 配線・prewarm.json 生成 |
| `skills/cmux-team-dispatch-task/scripts/monitor-dispatch.sh` | 完了通知の監視スクリプト（子 → 親通知＋全完了検知） |
| `skills/cmux-team-dispatch-task/scripts/send-prompt.sh` | 全メッセージ配送の単一入口（常にタイプ入力 + watcher 生存時は agmsg inbox にも記録 / 長文の outbox 退避 / Enter 検証と再送） |
| `skills/cmux-team-dispatch-task/scripts/report-status.sh` | 子セッションが status.json を終端へ遷移させる入口（既存フィールドを保存。クォート不要なので inner prompt から安全に呼べる） |
| `skills/cmux-team-dispatch-task/scripts/terminal-wait.sh` | シェル起動検知と `shell_ready_ms` 学習を行う共通ヘルパー（source 専用） |
| `skills/cmux-team-dispatch-task/scripts/parallel-directive.sh` | 子セッションへ渡す並列実行ディレクティブの生成（文面の単一情報源） |
| `skills/cmux-team-dispatch-task/scripts/config-edit.sh` | config.json への唯一の書き込み口（キー/値検証・置換ではなくマージ・writer 固有 mktemp + jq 成功時のみ mv） |
| `skills/cmux-team-dispatch-task/references/setup-mode.md` | `--setup` / `--reset` の実行時 SoT（英語） |
| `skills/cmux-team-dispatch-task/references/setup-mode-ja.md` | 同上の日本語版 |
| `~/.claude/cmux-team-dispatch-task/config.json` | グローバル設定（自動生成）。`shell_ready_ms.baseline_ms`、`prewarm`、`review_mode`、`design_runner` / `review_runner` / `exec_choice`。「常に〜」の回答・`--setup` / `--reset`・手動編集の 3 経路で変更される。**`message_type` は v1.16.0 で廃止** |
| `~/.claude/cmux-team-dispatch-task/runners.json` | 子セッション runtime 一覧（初回セットアップで生成）。SKILL.md Step 1f で読込。`--setup` / `--reset runners` からも再生成される |
| `<project>/.dispatch/config.json` | プロジェクト固有の上書き（手動配置または `--setup` で書き込み）。存在時はグローバルより優先。ディスパッチ末尾の cleanup の掃き出し対象から唯一除外される |
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

### role 解決の現行契約

- `design_runner` / `review_runner` / `exec_choice` は独立。`review_runner` は project → global →
  key 未設定時だけ legacy cross-engine resolver。固定/`"ask"` は同一 engine を許可する。
- codex runner の role model は `plan_model` / `review_model` / `exec_model`。all-Codex 例は
  `gpt-5.6-sol` / `gpt-5.6-sol` / `gpt-5.6-terra` と config
  `{"design_runner":"codex","review_runner":"codex","exec_choice":"codex","review_mode":"on","prewarm":true}`。
- `plan_model` / `review_model` / `exec_model` と 3 つの effort は **engine 中立**（claude / codex
  どちらの runner でも同じフィールド名で解決される）。既定は claude model が plan/review
  `opus[1m]` / exec `sonnet`（codex model は既定なし、codex 側デフォルトに委ねる）、effort は
  両 engine 共通で plan/review `xhigh` / exec `high`。effort の allowlist は engine 別
  （claude `low|medium|high|xhigh|max`、codex `minimal|low|medium|high|xhigh`）で、claude は
  `--effort <v>`、codex は `-c model_reasoning_effort='<v>'` を注入する。
- `exec_choice` は `claude` / `codex` / `ask` の engine 選択。旧値 `"opus 1m"` / `"sonnet"` は
  不正値として警告され当該レイヤーを無効化する（移行なし。`--reset config` で作り直す）。
- 固定 review は1つの専用ペインが Phase A-R/B-R を担当する。設計ペインは実装委譲後
  `.deferred` を作って exit し、レビュアーへ転じない。`code-review.json` には
  `reviewer_runner` / `reviewer_engine` を明示する。reviewer 解決は `REVIEW_POLICY=legacy` の
  ときだけ `DESIGN_ENGINE == EXEC_ENGINE` なら専用 review ペイン、異なれば設計セッションという
  単純規則で決まる（`fixed` policy は常に専用 review ペイン）。
- `review_mode=on` でも reviewer 不在なら警告してそのタスクだけ review off。review spawn 失敗も
  gate をスキップして Phase B へ進む。config は書き換えない。
- prewarm.json の `executors` キーは `claude` / `codex` の最大 2 つ。claude executor の agmsg
  agent は `<slug>-claude`。固定 `exec_choice` は未選択ペインを抑止し、解決済み executor は
  generic `--exec-runner` で渡す。unset/ask は executor candidate 専用の `--claude-runner` /
  `--codex-runner` を渡し、review runner から推測しない。**in-session 条件**
  （`EXEC_ENGINE == DESIGN_ENGINE && EXEC_MODEL == PLAN_MODEL && EXEC_EFFORT == PLAN_EFFORT`、
  既定値を埋めた後で判定）が成立するときは `executors` が `{}` になり、実装ペインを一切起動
  せず設計セッションが in-session で実装する。review spawn/output 失敗は join 済み member を
  即 leave して `review` を省略し、design/executor を保持して続行する。all-Codex 固定構成は3ペイン。
- claude design の prewarm standby 起動は `--runner "$DESIGN_RUNNER"` を渡す（過去に欠落していた
  defect の修正。これが無いと claude runner の `plan_model` / `plan_effort` が design ペインへ
  届かなかった）。
- non-prewarm の design/review/exec は `--runner "$DESIGN_RUNNER"` /
  `--runner "$REVIEW_RUNNER"` / `--runner "$EXEC_RUNNER"` を必ず渡す。不正・利用不能な project/global 値はそのレイヤーだけ
  無効化する。初回設定の永続化は writer 固有 `mktemp` + 同一directory `mv` を使う。
- Step 1f の対話的な runner 切替質問は AskUserQuestion の4択上限を守る。未設定時は永続化2案を
  「runner 設定を保存」の追加2択へまとめ、4番を `runners.json` reset にする。明示 `"ask"` は
  いいえ / はい / reset の3択。reset は `RUNNERS_JSON` だけを削除し、review 方針の質問と永続化を
  スキップする reset mode で初回セットアップを即時実行する。project/global config は変更せず、
  Step 1f の runner 解決を再開する。
- cleanup は prewarm.json の `.. | objects | .surface_id? // empty` と `.agent?` を列挙し、
  `awk 'NF && !seen[$0]++'` で重複除去する。`close-surface` は `--workspace` 必須で、ID欠落時は
  workspace名の `[slug]` を正規表現でなくリテラル一致してフォールバックする。timeout sentinel /
  cleanup / agmsg leave は実在roleだけに送る。
- 無人loop rendererにはdesign/review/execの解決済みrunner/engineを渡す。review fieldsはreview有効時だけ
  必須。同一engine reviewを許可し、all-Codex固定例でclaude executorを起動・指示しない。
- `--override` は dispatch 1 回限りのタスク別上書き。precedence は
  `--override` > project config > global config > `runners.json` の役割フィールド > 既定値。
  **config へ書き戻さない**（`config-edit.sh` を呼ばない）。`--loop` / `--setup` / `--reset`
  と排他で、Step 1a のタスク解析に落ちてはならない。上書きは Step 1g-2 で解決値
  （`PLAN_MODEL` / `PLAN_EFFORT` / `REVIEW_MODEL` / `REVIEW_EFFORT` / `EXEC_MODEL` /
  `EXEC_EFFORT` と各 runner / engine）を置き換え、`prewarm-panes.sh` へは
  `--design-model` / `--design-effort` / `--reviewer-model` / `--reviewer-effort` /
  `--exec-model` / `--exec-effort` で渡る
- `REVIEW_EFFORT` は review 役割の effort。runner の `review_effort` → 既定 `xhigh`。
  substitution tuple の `{{REVIEW_EFFORT}}` として子へ渡る

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
   - Phase B の選択肢は engine 選択（`claude` / `codex`）のみ。**in-session 条件**
     （`EXEC_ENGINE == DESIGN_ENGINE && EXEC_MODEL == PLAN_MODEL && EXEC_EFFORT == PLAN_EFFORT`、
     既定値を埋めた後で判定）が成立するときだけ **現セッション継続**（`.deferred` を作らない）
   - in-session が不成立のときは **`launch-workspace.sh --mode execute` 経由で別 surface を spawn**（prewarm 経由なら待機中の executor pane へ配送）。孫 surface の runner wrapper が status.json / `cmux wait-for` シグナル / 親通知を担当。Child は `.deferred` を作って exit (runner は `--defer-status` 付きで起動されており `.deferred` を検知して上書きをスキップ)。Phase B-R 有効時は `.deferred` 作成後も exit せずレビュアーとして待機し、approve 後に exit
   - claude executor spawn は **`--skip-permissions` 必須** (auto mode が効かないモデルでも permission prompt でハング防止)
   - **claude 選択肢は claude runner があるときのみ、codex 選択肢は `runners.json` に `engine: codex` の runner があるときのみ表示**（片方しか無ければ option から除外し、両方無ければ質問自体を省略）
   - 計画の受け渡しは `--plan-file <path>` で行う (`.cmux-team-dispatch-task-prompt.md` は書き換えず Phase A のものを温存)
9. 配送が `scripts/send-prompt.sh` に一本化され、`cmux send` / `cmux send-key` の直書きが残っていないことを確認（`launch-workspace.sh` / `monitor-dispatch.sh` / `prewarm-panes.sh` / `parallel-directive.sh` の実装、および SKILL.md / `references/` 配下の全 `.md` の指示文。`send-prompt.sh` 自身が唯一の例外）。回帰は `bash test/test-send-prompt-callsites.sh` で検証する: **CS1 = 4 スクリプトに `cmux send` / `cmux send-key` の直書きが残らない**（`send-key` 無しの一方通行の `cmux send` も配送事故になるため両方を検出する）、CS2 = `launch-workspace.sh` と `monitor-dispatch.sh` の両スクリプトが `send-prompt.sh` を呼ぶ、**CS3 = SKILL.md と `references/**/*.md`**（訳の `guide-ja.md` と、`render-loop-prompt.sh` が子タスクプロンプトへ連結する `references/unattended/*.md` を含む）に直書きが残らない。CS1 は対象ファイルが読めない、または grep が status 2 以上を返すときも FAIL にして fail-open させない。訳や無人ループ用ブロックが原文から遅れて旧文面を残す事故を防ぐため、対象をこれら全部に広げてある
   - **免除は行番号ではなくマーカーで行う**: シェルへのコマンド打鍵（TUI へのメッセージ配送ではない）など正当な `cmux send` は、直前 3 行以内（ドキュメントは同一行または直前行）に `send-prompt-exempt:` を含むコメントを置いたときだけ検査から外れる。新しい出現は必ずレビューを通る。**スクリプトのコメント行はマーカー判定より前に無条件で除外される。** したがってコメント中の `cmux send` 言及に付ける `send-prompt-exempt:` は、レビュー済みの意図を残す注釈であって現行 CS1 の load-bearing な条件ではない。マーカーが load-bearing なのは非コメント行の直書き（`launch-workspace.sh:1085-1088`）に対してだけ
10. `runners.json` の `plan_model` / `review_model` / `exec_model` と対応 effort が role 単位で一致すること。plan/superpowers/design standby は plan、Phase A-R/B-R は review、execute/executor standby は exec を使う。明示 `--model` / `--effort` が runner field より優先する。codex reviewer は `review_model` 必須、claude reviewer は `opus[1m]` fallback。
11. `launch-workspace.sh` の execute モード関連フラグ（`--mode execute` / `--plan-file` / `--model` / `--skip-permissions` / `--defer-status`）が SKILL.md / guide-ja.md / README.md の Phase B 説明と一致しているか確認。Child が `launch-workspace.sh` を直接呼び `--defer-status` を必ず付けて起動していること、孫側 (Phase B spawn) が `--mode execute` + `--plan-file` で起動していることを検証
12. **`message_type` 廃止後の判定**が SKILL.md / guide-ja.md / README.md / CLAUDE.md で一致しているか確認。通知トランスポートの質問も config キーも存在せず、agmsg を使うかは `~/.agents/skills/agmsg/scripts/send.sh` の存在**だけ**で決まること。`launch-workspace.sh` / `prewarm-panes.sh` が `--message-type` を `was removed` を含む die で拒否し、agmsg 配線は `--agmsg-team` の有無で決まること。agmsg インストール時は monitor-dispatch.sh を起動しないこと、status.json / signal は不変であることを検証。子プロンプトの status protocol に「status.json 書き込み直後の必須完了通知（`send-prompt.sh --label dispatch-notify` の 1 回呼び出し）」が含まれること、Step 1g に AGMSG-DIRECTIVE 遵守(ディスパッチ実行中セッションの watcher 起動。ただし watcher は記録・返信用で wake 手段ではない旨の注記付き)が記載されていることを検証。回帰は `bash test/test-message-type-removed.sh`（MT1-MT3）で検証する
13. prewarm.json が `design` / 任意の `review` / `executors`（キーは `claude` / `codex` の最大2つ、in-session 成立時は `{}`）の role-aware schema で、固定 `exec_choice` が未選択 pane を抑止すること。all-Codex 固定構成は3ペインで claude executor wiring が0件。配送順序と未assigned時のstatus非汚染は維持する。
14. Phase A-R（設計セッションの plan/spec を解決済み review runner がレビュー）が4ファイルで一致しているか確認:
    - `REVIEW_POLICY=fixed|legacy`、`REVIEW_RUNNER / REVIEW_ENGINE / REVIEW_MODEL` を独立解決し、`REVIEW_ENABLED` は engine 別に分けない。reviewer 不在時はそのタスクだけ無効化する
    - レビューポイント（plan モード: plan 後 1 回 / superpowers モード: spec 後 + plan 後の 2 回）、各ポイント最大 5 往復、approve は何ラウンド目でも即終了、5 往復 needs_work 時は AskUserQuestion（このまま進む / さらに修正）
    - verdict はファイル受け渡し（`<STATUS_DIR>/review/<point>-round-<N>.md` 末尾の `VERDICT: approve|needs_work`）。依頼配送は `send-prompt.sh --label review-plan` の 1 回呼び出し、待機は常に 5 秒間隔・15 分チャンクのファイルポーリング + チャンク境界ごとのレビュアー pane 生存確認（`cmux read-screen --workspace/--surface` の画面差分。read-screen は非フォーカス workspace でも live な内容を返すため refresh 不要 — 実測確認済み。変化ありなら上限なしで待機継続、失敗・空出力は 10 秒間隔 3 回リトライし 2 回連続の境界で全失敗したときのみ pane 消滅扱い。チャンク境界では先に verdict を再確認する）（agmsg push / 返信 push は idle セッションを起こせないため配送・待機手段にしない）。ready sentinel 生存時は依頼文が inbox にも記録される（判定は `send-prompt.sh` が行うので呼び出し元は `review.delivery` で分岐しない）。stalled（1 チャンク画面変化なし / 2 回連続観測不能）時は verdict 最終確認 → 同一ラウンド 1 回再依頼（baseline 取り直し）→ AskUserQuestion
    - fixed runner は設計と同じ engine を許可し、同一専用ペインを全ポイントで再利用する。spawn 失敗時は警告して Phase B へ
    - `launch-workspace.sh` の `--mode review` / `--standby-split-direction` / codex engine への `--model` 反映、`prewarm-panes.sh` の `--review-model`（design=claude、`--codex-runner` 必須）/ `--design-runner` + `--reviewer-runner`（design=codex、`--review-model` と相互排他）と prewarm.json `review` キーが SKILL.md の使用例・スキーマと一致
15. **配送の `send-prompt.sh` 一本化**が SKILL.md / guide-ja.md / README.md / CLAUDE.md で一致しているか確認:
    - 指示を送る全箇所（Phase A design タスク `phase-a-task` / Phase B claude executor・codex executor・codex 設計 variant の委譲 `phase-b-exec` / Phase A-R review 依頼 `review-plan` / Phase B-R コードレビュー依頼 `review-code` / レビュアーへの abort 通知 `abort-reviewer`（実装者からも runner wrapper の `notify_reviewer_once` からも同じ label を使う。`dispatch-abort` は廃止）/ 親への完了・abort 通知 `dispatch-notify` / `monitor-dispatch.sh` の heartbeat・全完了・DIED 通知 `dispatch-monitor`）が **`send-prompt.sh` の 1 回呼び出し**になっており、`cmux send` + `cmux send-key return` の 2 行ペアが残っていないこと。label は上記のとおり固定（1 メッセージクラス = 1 label）
    - `send-prompt.sh` の契約が 4 ファイルで一致すること: **常にタイプ入力する**（idle セッションを起こせる唯一の手段）/ `--agmsg-*` の 3 引数が揃い宛先の ready sentinel が存在するときだけ**追加で** inbox に記録する（wake 手段ではなく、失敗しても配送の成否と終了コードに影響しない。**記録は必ずタイプ入力の後**に行う — `send.sh` は共有 SQLite DB への書き込みで固まりうるが macOS には `timeout` / `gtimeout` が無いため、先に走らせると唯一の wake 手段に到達できず dispatch がデッドロックする）/ 400 文字超は `<outbox-dir>/<label>-<seq>.md` へ退避しポインタ 1 行だけをタイプする / Enter 後に `cmux read-screen` で入力欄が空になったことを確認し最大 3 回まで再送する（確認が働くのは**宛先が 0 桁目に `❯` / `>` のプロンプト行を描画している場合**。該当行が無いペイン — codex レビューペインなど — は検証なしで配送済み扱いになるので、4 ファイルとも無条件の保証として書かない）/ 観測不能は失敗ではなく配送済み扱い（二重配送の防止）
    - **ready sentinel は wake 能力の証明にならない**旨が書かれていること（watcher プロセスの生存しか示さず、idle セッションへ注入できる仕組みの下でも素のバックグラウンドシェルの下でも同じ sentinel が書かれる。検証結果は `docs/superpowers/specs/2026-08-12-delivery-verification-results.md`）。呼び出し元は prewarm.json の `delivery` 値で分岐しない（sentinel の確認は `send-prompt.sh` 自身が行う）
    - `prewarm-panes.sh` が配線失敗（`CLAUDE_DELIVERY=cmux-send`）時に design / claude executor の初期プロンプトを `/agmsg actas` なしの「直接タイプされる」文面に出し分けること。配線成功時のプロンプトも「タスクはタイプ入力で届く（inbox に同一コピーあり）」文面であり「agmsg message として届く」とは書かないこと
    - 回帰は `bash test/test-send-prompt-callsites.sh`（CS1-CS3）と `bash test/test-send-prompt.sh`（SP0a-SP0d / SP1-SP24）で検証する
16. plan モードの遵守ゲート（ExitPlanMode hook）が SKILL.md / guide-ja.md / README.md / CLAUDE.md の 4 ファイルで一致しているか確認:
    - `launch-workspace.sh` が `--mode plan` かつ claude engine のときのみ worktree の `.claude/settings.local.json` に PostToolUse hook（matcher: `ExitPlanMode`、command: `zsh <skill-dir>/scripts/plan-approved-hook.sh`）を注入すること（既存 settings は jq マージ、worktree 再利用時は重複注入なし、失敗は警告のみで dispatch 続行）
    - `.claude/settings.local.json` と plan 保存先 `.claude/plans/` が repo 共有の `info/exclude` に追記されること（settings のマージ書き込みは tmp + mv のアトミック方式、hook command のスクリプトパスはクォート済み）
    - hook が worktree に残存し後続セッション（Phase B の execute 孫を含む）にも作用するが、plan モードを使わないため実害なし — と 4 ファイルで文書化されていること
    - MANDATORY MODEL SELECTION SEQUENCE の Phase A（plan モード）に「plan 冒頭に Step 0: Phase A-R（有効時）/ Step 1: Phase B を必須ステップとして記載」「plan が ExitPlanMode メッセージ内にしか無い場合は承認後最初にファイル保存」の指示、VIOLATION 節に PLAN-MODE TRAP が含まれること
    - `plan-approved-hook.sh` の出力が有効な JSON（`hookSpecificOutput.additionalContext`）であること
17. Phase B-R（実装後コードレビュー）が SKILL.md / guide-ja.md / README.md / CLAUDE.md の 4 ファイルで一致しているか確認:
    - 有効化条件は Phase A-R と同じ `REVIEW_ENABLED`。Step 1g の質問文は両フェーズへ言及する
    - fixed policy は Phase A-R と同じ専用ペインが全実装をレビューし、設計ペインは `.deferred` 後に exit。legacy policy は `DESIGN_ENGINE == EXEC_ENGINE`（in-session か delegated かは問わない）なら専用 review ペイン、異なれば設計セッション自身という単純規則で決まる:
      - design=claude, EXEC_ENGINE=claude（in-session 継続でも `<slug>-claude` executor 委譲でも）→ codex レビューペインがレビュー（Phase A-R と同一ペイン・ポイント id `code`）。delegated のときは設計 claude ペインは `.deferred` touch 後に exit する
      - design=claude, EXEC_ENGINE=codex → 設計 claude ペイン自身がレビュアーに転じる
      - design=codex, EXEC_ENGINE=claude → 設計 codex ペイン自身がレビュアーに転じる。実装は専用 claude executor ペイン（`<slug>-claude`）が担い、A-R の専用レビューペイン（`<slug>-review`）とは兼用しない
      - design=codex, EXEC_ENGINE=codex（in-session 継続でも codex standby 委譲でも）→ claude レビューペイン（`<slug>-review`）がレビュー。delegated のときは設計 codex ペインは `.deferred` touch 後に exit する
      - レビューペイン利用不可（Phase A-R spawn 失敗済み）→ 上記いずれのケースもレビュー省略
    - プロトコル: findings は `<STATUS_DIR>/review/code-round-<N>.md` 末尾の `VERDICT: approve|needs_work`、最大 5 往復、実装者の verdict 待ちは 5 秒間隔・15 分チャンクのファイルポーリング + レビュアー pane の read-screen 画面差分による生存確認（活動中は上限なしで待機。standby が実装者のケース。設計セッション自身が実装を継続するケースは Phase A-R Round loop の待ち方を流用）、stalled（1 チャンク画面変化なし / 2 回連続観測不能）は verdict 最終確認 → 同一ラウンド 1 回再依頼 → それでも stalled なら claude 実装者は AskUserQuestion（再依頼 / レビュー省略して PR 作成）、codex 実装者はレビュー省略を PR 本文に注記して続行
    - 5 往復 needs_work: claude 実装者は AskUserQuestion（このまま PR 作成 / さらに修正）、codex 実装者は PR 本文に注記して続行
    - status.json の done/error 遷移は従来どおり実装者ペインの wrapper が所有。実装者がレビューを依頼せず終了しても Child は idle のまま残り、最終クリーンアップで閉じる（孤児ガード用の追加機構は無い）
    - spawn 経路: Child は fixed なら専用 review tuple、legacy なら `DESIGN_ENGINE == EXEC_ENGINE` 規則で解決した design/review pane tuple を解決し、同じ pane の surface/workspace/runner/engine を `<STATUS_DIR>/review/code-review.json` に書く。review surface が空なら `--review-config` を省略して gate だけを skip する。`launch-workspace.sh --mode execute --review-config <path>` は孫 prompt にプロトコルを追記し、REVIEW_INSTRUCTION と ABORT 手順は `bash test/test-launch-workspace-review-config.sh` で検証する
18. 独立 review runner と role model/effort（engine 中立）が SKILL.md / guide-ja.md / README.md / CLAUDE.md の 4 ファイルで一致しているか確認:
    - fixed policy の同一 engine support と legacy policy の `DESIGN_ENGINE == EXEC_ENGINE` 規則が明確に区別される
    - design=codex: Phase B は claude/codex の2択とも解決済み executor へ委譲（in-session 条件成立時を除き設計セッションは実装しない）。fixed/legacy policy のどちらも review は専用 `<slug>-review`、claude executor は専用 `<slug>-claude` を使って兼用しない。legacy policy が維持するのは `DESIGN_ENGINE == EXEC_ENGINE` の単純規則だけ
    - `review_runner` の project → global → legacy precedence、codex `review_model` 必須、claude `opus[1m]` fallback、レイヤー単位invalid化
    - `plan_model` / `review_model` / `exec_model` と対応 effort は **engine 中立**。effort の優先順位（明示 `--effort` > runner フィールド > 既定値）と role 対応（plan_effort: plan/superpowers、review_effort: review、exec_effort: execute/standby）。既定値は model が claude: plan/review `opus[1m]` / exec `sonnet`（codex model は既定なし）、effort が両 engine 共通で plan/review `xhigh` / exec `high`。**未設定でも既定値が埋まり、claude には `--effort`、codex には `-c model_reasoning_effort='<v>'` が必ず注入される**（effort flag を省略する経路は無い）。prewarm の設計ペインは `--role plan --runner <design runner>` で起動し、`launch-workspace.sh` が `plan_model` / `plan_effort` を解決する（claude / codex 両分岐とも `--runner` を渡す）
    - `prewarm-panes.sh` の `--design-runner` / `--reviewer-runner` / 固定 choice 用 `--exec-runner` / unset・ask 候補専用 `--claude-runner`・`--codex-runner` と prewarm.json の runner/engine フィールド。review runner を executor candidate に流用しない
    - 回帰は `bash test/test-role-models.sh`（RM1-RM17: claude/codex 両 runner の役割別 model/effort 解決、既定値、明示指定の優先、allowlist）と `bash test/test-in-session.sh`（役割設定が完全一致したときに prewarm の実装ペインが起動せず `executors` が `{}` になること）で検証する
19. `design_runner` / `exec_choice` の precedence（project config → global config → ask）と警告フォールバックが SKILL.md / guide-ja.md / README.md / CLAUDE.md で一致しているか確認。`design_runner` は有効 runner 名で switch / per-task 質問を両方省略し、`exec_choice` は有効値で Phase B の AskUserQuestion を default-direct に置換することを確認。**未設定と明示 `"ask"` の区別**も確認: 未設定（全レイヤー未設定または不正）では永続化オプション付きの質問（design_runner は switch 質問 4 択: いいえ / はい / 設定保存 / runners reset、exec_choice はモデル選択直後の永続化確認 1 問）、明示 `"ask"` の design_runner は 3 択（いいえ / はい / reset）、exec_choice は従来のモデル質問のみで、どちらも永続化オプションなし（キー削除 = 未設定に戻り再表示、`"ask"` 書き換え = 非表示 — 2 つの戻し方の違いが 4 ファイルで明記されていること）。reset mode は review 方針の永続化も省略して両 config を保持すること。不正値の検証は **project / global のレイヤーごと**で、不正なレイヤーだけ警告して無視し次へフォールバックする（project の不正値が global の「常に〜」を遮蔽しない）こと。「常に〜」の永続化は `review_mode` と同じ jq merge でグローバル config のみに書き込み（project config には書かない）、一時ファイルは **writer 固有の mktemp + 同一ディレクトリ mv**（共有 `$CONFIG.tmp` は並列書き込みで壊れるため禁止）であること。exec_choice の永続化確認は子セッションが書くため並列時はファイル全体の last-write-wins であること。設定経路は「常に〜」の回答・`--setup`・手動編集の 3 通りで、書き込みは全経路とも `scripts/config-edit.sh` を通すこと（項目 28）
20. codex の engine × MODE 起動規則を確認: superpowers は bypass 付き、review は `--sandbox workspace-write` + `-c approval_policy='never'` + `--add-dir <STATUS_DIR>` の3点セットで、sandbox 完全 off を使わず findings 書込先を許可すること
21. Phase B 実装セッションの **完了報告と exit 指示** を SKILL.md / guide-ja.md の**両経路**で確認。まず spawn 経路（`--mode execute`）には `COMPLETION_INSTRUCTION` があり、子が停止前に `scripts/report-status.sh <status-dir> done <要約>` を実行する。**status.json を終端へ動かすのはこの呼び出しであり、セッション終了ではない** — codex には自セッションを終わらせる手段が無い（`/exit` は効かず quit/shutdown サブコマンドも無い）ので、終了に依存した設計は codex では成立しない。exit 指示は engine 別で claude は「run /exit」、codex は「停止して idle のまま待て（自分で終了しようとするな）」。回帰は `bash test/test-execute-completion.sh`（EC1-EC4）。(a) spawn 経路（`--mode execute`）は `launch-workspace.sh` の `EXIT_INSTRUCTION`（`RUNNER_ENGINE` で分岐）が焼き込む、(b) prewarm standby 経路は親→standby へ `send-prompt.sh` で送る `REQUEST_TEXT` に含める。codex の prewarm block（`{{CODEX_BEHAVIOR_BLOCK}}` step 3）は claude executor branch とは別 branch のため **base `REQUEST_TEXT` を独自に定義** しなければならない（未定義だと実行指示が空になり、`/exit` 誤用だと codex が TUI に idle 残留して runner wrapper が完了通知に到達しない）。**Phase B-R 有効時は「共通プロトコル a」の拡張 `REQUEST_TEXT` が base を上書きする。したがって拡張側にも (1) engine 別の exit 指示（codex は `END THE CODEX SESSION ITSELF` / `do NOT run /exit`）と (2) 完了通知（`send-prompt.sh --label dispatch-notify` の 1 回呼び出し）の両方を必ず持たせること。** 旧仕様は末尾が engine 中立の 1 文（`run /exit (claude) or end the session (codex)`）で通知にも触れていなかったため、Phase B-R を有効にした瞬間に codex 用の強い指示が失われ、実装完了後も codex が TUI に idle 残留 → wrapper の完了通知に到達せず、standby は task prompt を読まないので子側の必須通知も存在せず、**親に一切通知が届かない**という事故が実際に発生した。standby ペインが受け取るのはタイプ入力で届いた `REQUEST_TEXT` だけであり、「finish per the instructions below」に対応する status protocol は存在しない点に注意。回帰は `bash test/test-launch-workspace-codex.sh`（T5b/T5c/T6b/T7/T14/T15）で検証

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
    - `launch-workspace.sh` の Step 2a が `RUNNER_ENGINE == "claude"` のときだけ、MODE を問わず worktree の `.claude/settings.local.json` に `permissions.defaultMode: "bypassPermissions"` をマージすること。既に同値なら書き込まずスキップ（worktree 再利用時の二重注入なし）、失敗時は `permission bypass not confirmed` を警告し、フォールバックしたうえで dispatch は止めないこと。claude engine では注入の成否（書き込み成功・スキップ・失敗のどれか）に関わらず無条件に `jq -e` でファイル実体を判定して `bypassPermissions` を確認できなければ、`plan`（組み立て箇所でリテラル付与済み）と、`--skip-permissions` が `CLAUDE_EXTRA_FLAGS` 経由で届く MODE（`execute` / `standby` / `review` で、かつ呼び出し元が実際に `--skip-permissions` を渡したとき。`execute` / `standby` は claude engine での `--unattended` でも同様に免除されるが、`--unattended` を受け付けない `review` はこの免除の対象外で `--skip-permissions` のみが効く）を除いて `--dangerously-skip-permissions` へフォールバックすること。`superpowers` は `--skip-permissions` を受け取らないため、その有無に関わらずフォールバックを付けること。判定に `merge_claude_settings` の戻り値を使ってはならない（`settings.local.json` がディレクトリのとき `mv` が成功を報告する）
    - 書き込みは `merge_claude_settings` ヘルパー経由で、一時ファイルは**同一ディレクトリの `mktemp` + `mv`**（共有名 `$FILE.tmp` は prewarm の並列書き込みで壊れるため禁止）。同ヘルパーは plan モードの ExitPlanMode hook 注入からも使われ、両者が同じ `settings.local.json` に共存すること。また、新しい警告文にフラグのリテラル `--dangerously-skip-permissions` を含めないこと（テストが composed command のフラグを数えるとき警告文にマッチして空虚な PASS になる）。agmsg の `delivery.sh set` は同じ `settings.local.json` を read-modify-write するので、`prewarm-panes.sh` の Step 2 が全 launch より前に走る順序を崩さないこと（崩すと注入が巻き戻り、判定は Step 2a で終わっているため検出できない）
    - `info/exclude` への `.claude/settings.local.json` / `.claude/plans/` 追記が `ensure_claude_exclusions` に一本化され、plan モード限定ではなく claude engine の全 MODE で走ること
    - codex engine には**一切注入しない**こと。フォールバックフラグも codex には付けないこと（`BYPASS_INJECTION_OK` は claude 限定ブロックの内側でしか 0 にならないため、実際の担保は claude 側の判定にあり、フラグ合成側の `RUNNER_ENGINE == "claude"` ガードは多重防御。P19 が判別できるのは新警告が出ないことの側のみ）。codex の `--dangerously-bypass-approvals-and-sandbox` とレビューペインの `--sandbox workspace-write` + `-c approval_policy='never'` + `--add-dir <STATUS_DIR>` は不変（項目 20 / 39）
    - loop の `UNATTENDED=1 && RUNNER_ENGINE == claude → SKIP_PERMISSIONS=1` と `prewarm-panes.sh --unattended` が不変であること
    - `AskUserQuestion` が対話的に残る根拠（permission gate と対話 UI は別レイヤー / `--dangerously-skip-permissions` と `bypassPermissions` は公式ドキュメント上等価）と、`skipDangerousModePermissionPrompt` をユーザー設定に置く必要があることが README と guide-ja.md の両方に書かれていること
    - `ensure_claude_exclusions` の呼び出しは `|| true` を付けること。`launch-workspace.sh` は `set -euo pipefail` で走るため、bare 呼び出しだと `info/exclude` を解決できない cwd（非 git など）で launch ごと死ぬ
    - 回帰は `bash test/test-launch-workspace-permissions.sh` の P1〜P30（全 MODE 注入 / codex 非対象 / 既存キー保持 / 冪等 / 正常系では superpowers にフラグを足さない / info/exclude 追記 / `--skip-permissions` との共存 / 非 git cwd でも launch が成功 / 判定失敗の 3 ケース A・B・C でのフォールバック / superpowers は `--skip-permissions` を読まない（P14）/ standby の prompt 有無の両分岐 / plan と `--skip-permissions` 既付与での二重付与なし / 正常系で誤発火しない（P20）/ worktree 再利用の短絡では発火しない / `--unattended` との共存 / ログ値のサニタイズの回帰（P26 / P26b、root では skip）/ review 単独ケースでの `*)` ワイルドカードの担保（P27）/ `jq -e -s` による複数 JSON ドキュメント連結の誤判定防止（P28）/ review + `--skip-permissions` の二重付与なし（P29）/ サニタイズより切り詰めを先に行う順序と窓幅の担保（P30、chmod 不要で root でも走る））と `bash test/test-prewarm-design-permissions.sh`（DB1-DB2: 設計ペインと claude executor の `--skip-permissions` 非対称。本項目の変更に対する回帰ではなく既存カバレッジ負債の返済。`launch-workspace.sh` をスタブへ差し替えるため下記の警告文言は登場しない）で検証する。警告文言 `permission bypass not confirmed` と `added the CLI permission flag` は `test-launch-workspace-permissions.sh` だけが持つテスト定数なので、変えたら同ファイルを更新すること

26. **レイアウトの workspace 固定**が `launch-workspace.sh` / `monitor-dispatch.sh` / `SKILL.md` / `guide-ja.md` / `README.md` / `CLAUDE.md` で一致しているか確認:
    - `launch-workspace.sh` が `--layout` / `--split-from` / `--split-direction` / `--parent-workspace` を、メッセージに `was removed` を含む明示的な die で拒否すること。composed command に `claude-teams` が現れないこと
    - `monitor-dispatch.sh` が `--layout` / `--parent-surface` を同様に拒否し、親通知を常に `--workspace` 宛へ送ること。DIED 通知の再起動例に削除済みフラグを含めないこと
    - SKILL.md / guide-ja.md に `{{LAYOUT}}` / `LAYOUT_MODE` / `LAYOUT=split` が残っておらず、起動例に削除済みの split 系フラグが残っていないこと。最終クリーンアップは workspace を閉じる 1 経路に統一すること
    - stdout JSON と初期 `status.json` の `layout` が定数 `"workspace"` のまま残り、`split_from` / `split_direction` キーは出力されないこと
    - `launch-session-splits.sh` / `cmux-grid.sh` が存在せず、README の移行注記以外の利用手順に削除済みレイアウトへの参照が残らないこと
    - **workspace 内のペイン配置は 2 行のグリッド**であること: design = メイン surface、review = design から `right` split、実装ペイン = 1 つ目が design から `down` split・2 つ目以降が直前の実装ペインから `right` split。実装 2 件 + review でちょうど 2×2 になる。2 つ目以降の実装ペインを `down`（direction 省略）で積むと左カラムが 3 段になり 2×2 が崩れるので、`prewarm-panes.sh` の実装ペイン起動は必ず `set_exec_split_flags` が組み立てた `EXEC_SPLIT_FLAGS` を渡し、起動後に `EXEC_LAST_SURFACE` を更新すること（claude executor / codex executor の 2 箇所すべて）。実際に v1.18.0 の role ベース化で codex 側の `--standby-split-direction right` が落ち、design/claude executor/codex が縦 3 段に積まれる退行が発生した
    - 回帰は `bash test/test-launch-workspace-layout.sh`、`bash test/test-monitor-layout.sh`、`bash test/test-prewarm-layout.sh`（PG1-PG3）で検証すること

27. **タスク内の並列実行**が SKILL.md / guide-ja.md / README.md / CLAUDE.md の 4 ファイルで一致しているか確認:
    - 文面の単一情報源は `scripts/parallel-directive.sh`。`--engine <claude|codex>` × `--mode <plan|superpowers|execute|review>` で 1 行を出力し、`--agents <N>`（2〜8、既定 4）で同時実行の上限を変える。`standby` モードは存在せず、standby ペインには `--mode execute` を渡す
    - **出力に `'` `"` `` ` `` `$` `!` `\` を 1 文字も含めてはならない**。composed command は `zsh -ic "... '<prompt>' ..."` で二重に引用され、`launch-workspace.sh` はエスケープしない（`-i` は対話モードなので history 展開が効き `!` も特殊文字になる）。回帰は `bash test/test-parallel-directive.sh` の PD4 で検証する
    - superpowers への譲歩文（subagent-driven-development の「実装者は同時に 1 体」を上書きしない旨）は engine / mode で出し分けず常に出力する。codex も `superpowers:brainstorming` 前置でパイプラインを辿るため
    - **適用範囲の一文（「調査と検証にだけ適用する」）は同時編集の禁止文より前に置き、直前の並列化ディレクティブに係らせる**。禁止文の後ろに置くと最近接先行詞が禁止文になり「同時編集の禁止は調査と検証にだけ適用される = 実装中は同時に編集してよい」と読めてしまい、guardrail が防ぎたい事故そのものを許可する
    - **分散を許すのは読み取り専用の検証だけ**。auto-fix / write モード（formatter・linter の write フラグ）はファイルと共有ビルドキャッシュを書き換えるため逐次に走らせる旨を execute モードの文面に含める
    - `launch-workspace.sh` が注入するのは plan / superpowers / execute の起動プロンプトだけ。standby / review はプロンプト無しで起動するので、指示は親が `send-prompt.sh` で送るテキストに含める。execute では `EXIT_INSTRUCTION` を必ず最後に残すこと
    - **注入点は 5 箇所**（起動プロンプト / Phase B 実行指示 / Phase A-R レビュー依頼 / Phase B-R レビュー依頼（prewarm 経路）/ Phase B-R レビュー依頼（spawn 経路））。この 5 行の表が SKILL.md と guide-ja.md で一致し、かつ**全行が実在すること**を確認する。特に prewarm 経路は、レビューペイン自身が `--mode review` 起動でディレクティブを持たないため、「共通プロトコル a」の拡張 REQUEST_TEXT に `--mode review`（engine は実装者の逆）のディレクティブを含め、実装者がレビュー依頼文へ転記する形でしか届かない
    - **レビュアー宛ディレクティブを引用するときは宛先を語彙で明示する**。engine は `reviewer_engine` の明示値を使い、実装者との関係から計算しない
    - Phase B-R の spawn 経路は `review/code-review.json` の `reviewer_engine`（`claude` / `codex`）から依頼文へ埋め込む。欠落時（旧スキーマ）は注入しない。`--no-parallel` は起動プロンプト専用のスイッチで、レビュー依頼文の注入判定には使わない
    - **`--no-parallel` はテスト基盤としても load-bearing**。`test/test-launch-workspace-review-config.sh` が起動プロンプト側の注入を止めてレビュー依頼文側の注入だけを切り分けるために渡している（`PARALLEL EXECUTION` が見つかったら必ずレビュー依頼文由来と言える状態を作っている）。フラグを削るなら同等の切り分け手段を別途用意すること
    - `--agents` / `--no-parallel` は `launch-workspace.sh` のスクリプトレベルのフラグで、SKILL.md の起動例はどちらも渡さない。`config.json` のキーも無い（`design_runner` / `exec_choice` / `review_mode` と違い precedence chain を持たない）。README にはスキルが公開していない旨と、手動起動が唯一の手段である旨を書く
    - 回帰は `bash test/test-parallel-directive.sh`（PD1-PD7）、`bash test/test-launch-workspace-codex.sh`（PL1-PL10）、`bash test/test-launch-workspace-review-config.sh`（PR1-PR3）で検証する

28. **設定の明示 setup / reset**が SKILL.md / guide-ja.md / README.md / CLAUDE.md の 4 ファイルで一致しているか確認:
    - `--setup` と `--reset [runners|config|all]` は引数レベルのフラグで、実行時 SoT は `references/setup-mode.md`（日本語版 `setup-mode-ja.md`）。SKILL.md 側は `## Setup Mode` / `## Reset Mode` の短い委譲節だけを持ち、詳細を二重管理しない。`argument-hint` にも両方を書く
    - **どちらもディスパッチしない**。タスク・worktree・workspace・ペインを作らず、`.dispatch/` / worktree / `feat/*` ブランチを削除しない（削除はディスパッチ末尾の Cleanup prompts の担当）。`--setup` / `--reset` が Step 1a のタスク解析へ落ちてタスク名として扱われないこと。`--loop` とも互いとも排他で、issue ループの lock-check が生きている間は両方とも拒否すること
    - 書き込みは **`scripts/config-edit.sh` だけ**を通す。`--set <key>=<value>` / `--unset <key>` は 1 回の呼び出しで単一の jq 式に合成され 1 回の `mv` で反映される。扱えるキーは役割 5 つ（`design_runner` / `review_runner` / `exec_choice` / `review_mode` / `prewarm`）のみで、未知キー・範囲外の値は exit 2。**置換ではなくマージ**であり `terminal-wait.sh` 所有の `shell_ready_ms` を消さないこと。壊れた JSON では exit 1 で元ファイルを保持すること
    - `--setup` は三値（固定値 / `"ask"` / キー削除）をすべて指定できること。書き込み先はグローバルとプロジェクトから選び、**プロジェクトへ書くのは「永続化はグローバル config のみ」規約の唯一の例外**（ユーザーが明示選択した場合に限る）。AskUserQuestion は 1 コール 4 問・各 4 択の上限を守り、runner 一覧が 5 件以上のときは先頭 4 件＋「Other」自由入力に逃がすこと
    - `--reset runners` は `RUNNERS_JSON` だけを削除して reset mode の初回セットアップへ入り、両 `config.json` を変更しない。`--reset config` は役割 5 キーだけを unset し、他のキーを残すこと
    - **`.dispatch/config.json` はプロジェクト config レイヤーであってディスパッチの生成物ではない**。cleanup の一括削除は `find .dispatch -mindepth 1 -maxdepth 1 ! -name config.json -exec rm -rf {} +` で `config.json` だけを残すこと（素の `rm -rf .dispatch/` に戻すとプロジェクト config が毎回消える）。この掃き出しも従来どおり直前の lock-check ガードの内側に置くこと
    - 回帰は `bash test/test-config-edit.sh`（CE1-CE11）と `bash test/test-setup-skill.sh`（SU1-SU9）、cleanup ガードは `bash test/test-loop-skill.sh` で検証する

44. **`--override`**が SKILL.md / guide-ja.md / README.md / CLAUDE.md で一致しているか確認:
    - `argument-hint` に `--override` があり、`--loop` / `--setup` / `--reset` との排他が
      4 ファイルすべてで同じ理由（`--loop` は無人実行で対話できない）とともに書かれていること
    - config への書き込み経路を持たないこと。`--override` の説明中に `config-edit.sh` を
      **呼び出す**記述が無いこと（「Never call `config-edit.sh` here」のように呼ばない旨を
      説明のために言及するのは正しい記述であり違反ではない）
    - `prewarm-panes.sh` の 6 フラグ名が SKILL.md の記述と一致すること
    - 回帰は `bash test/test-override.sh`（OV1-OV9）で検証する

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
8. **モデル選択（動的表示）**: `exec_choice` が未設定または `"ask"` の子セッションは Phase A 完了後に AskUserQuestion を出すこと。選択肢は engine 選択（`claude` / `codex`）で、claude runner が無ければ `claude` を、`engine: codex` runner が無ければ `codex` を除外すること（両方無ければ質問自体を省略）。固定値では質問を出さず既存の対応分岐へ直行すること
9. **in-session 実行**: `EXEC_ENGINE == DESIGN_ENGINE && EXEC_MODEL == PLAN_MODEL && EXEC_EFFORT == PLAN_EFFORT`（既定値を埋めた後で判定）が成立するとき、`.deferred` を作らず同 surface 内で実装が継続されること
10. **委譲実行 (claude)**:
    - prewarm 経路: 待機中の claude executor pane（`prewarm.json.executors.claude`）に実行指示が送られること。prewarm 無効時は Child セッションが `launch-workspace.sh --mode execute --plan-file <path> --runner <claude-runner> [--model <exec_model>] --skip-permissions ...` を呼ぶこと
    - 新 workspace が立ち上がり、`claude [--model <exec_model>] --dangerously-skip-permissions 'Read and execute the plan at <path>. ... run /exit ...'` が runner script (`bash .cmux-team-dispatch-task-run-<slug>-exec.sh`) でラップされて起動すること (inner prompt 末尾に `/exit` 指示が付与されること、runner ファイル名は workspace 名で unique 化されること)
    - Child が `<STATUS_DIR>/.deferred` を touch して exit すること
    - Child の runner wrapper が `.deferred` を検知し、`status.json` を上書きせず exit すること
    - 孫の Claude が PR 作成後に自動で `/exit` を発火して TUI を閉じること (これにより runner wrapper が完了処理に到達する)
    - 孫の runner wrapper が完了時に `status.json` を `done` に遷移させ、`cmux wait-for --signal <slug>-exec-done` 発火、親に `[dispatch] task "<slug>-exec" finished (status: done)` を送ること
11. **委譲実行 (codex)**: Child が `launch-workspace.sh --mode execute --runner <codex-runner> ...` を呼び、`runners.json` の codex runner で新 surface が起動。`--dangerously-bypass-approvals-and-sandbox` 付きで実行し、`external_migration` により親 claude session を引き継ぐこと（`cmux codex install-hooks` が前提）。完了通知フローは claude executor と同じ
12. **monitor heartbeat**: `monitor-dispatch.sh` から60秒おきに `[dispatch-monitor] alive | loop=N | ...` が親に届くこと
13. **Enter 自動押下と長文の詰まり解消**: 親が claude TUI でも、完了通知や長い指示文が input box に残らず自動で読み取られること（`send-prompt.sh` が Enter を押したあと `cmux read-screen` で入力欄が空になったことを確認し、残っていれば最大 3 回まで再送する。400 文字超は outbox へ退避されポインタ 1 行だけがタイプされる）
14. **死亡検知**: monitor を `kill` した直後に `[dispatch-monitor] DIED ...` メッセージが親に届くこと
15. **`--resume`**: 既存の `.dispatch/` がある状態で monitor を `--resume` 起動 → 完了済みは skip、未完了のみ監視継続すること
16. **message_type 廃止**: 通知トランスポートの質問が一切出ないこと。`config.json` に `message_type` を書いても無視されること。`launch-workspace.sh` / `prewarm-panes.sh` に `--message-type` を渡すと `was removed` で即座に失敗すること
17. **agmsg インストール時**: monitor-dispatch.sh が起動しないこと。子が status.json に done/error を書いた**直後**に `[dispatch] task ... finished` が `send-prompt.sh` のタイプ入力で親に届き(親が idle のままでも届くこと — これがタイプ入力を唯一の wake 手段にする理由)、親の watcher が生きていれば同一文が inbox にも記録されること。wrapper の exit 時通知で同じ通知が重複して届くことがあるのは正常。ディスパッチ実行中の親セッションで AGMSG-DIRECTIVE により watcher が起動していること。status.json は従来どおり遷移すること
18. **pre-warm**: `prewarm.json` の role-aware な `design` / `review` / `executors`（`executors` のキーは `claude` / `codex` の最大 2 つ）と実ペインが一致すること。ペインが 2 行グリッド（上段 design / review、下段に実装ペインを横並び）で配置され、実装 2 件 + review のときに 2×2 に見えること。固定 `exec_choice` では未選択 executor を作らず、all-Codex 構成では設計・レビュー・codex executor の3ペインだけを起動すること。in-session 条件（`EXEC_ENGINE == DESIGN_ENGINE && EXEC_MODEL == PLAN_MODEL && EXEC_EFFORT == PLAN_EFFORT`、既定値を埋めた後で判定）が成立するタスクは `executors` が `{}` になり実装ペインが 1 つも起動しないこと。agmsg インストール時は design を含む起動済みペインが idle で待ち、親からの `send-prompt.sh --label phase-a-task`（`.assigned-<slug>` touch 後）で Phase A が始まること。`prewarm: false` では起動しないこと。未割当ペインが status.json を汚さないこと。claude design standby の起動が `--runner "$DESIGN_RUNNER"` を渡し、claude runner の `plan_model` / `plan_effort` が design ペインへ届くこと
19. **Phase B prewarm 経路**: `prewarm.json.executors.claude` / `.executors.codex` を使い、固定 choice では未選択 pane が存在しないこと。`.assigned-<slug>-claude` / `.assigned-<slug>-codex` → `phase-b-exec` 配送 → `.deferred` の順と status/signal/通知は維持する
20. **Phase A-R 無効**: `review_mode: off`、または `review_mode: on` でも capable reviewer を解決できないタスクだけ review を省略すること。後者では警告し config を書き換えず、Phase A 直後は `exec_choice` の解決済み方式に従う
21. **Phase A-R 有効 + prewarm**: 解決済み `review_runner` の専用 `review` ペインがあり、design と同一Codex engine でも Phase A-R/B-R に再利用できること。spawn 失敗時はその quality gate だけを警告・省略し Phase B へ進むこと
22. **レビューループ**: plan モードで plan 完成後に 1 回、superpowers モードで spec 後 + plan 後の 2 回レビューが走ること。needs_work → 設計セッションが修正して**同一ペイン**に再依頼（新ペインが生えない）。approve → レビューペインは開いたまま（close されず）Phase B の解決済み方式が走ること。5 往復 needs_work → AskUserQuestion（このまま進む / さらに修正）が出ること
23. **verdict プロトコル**: `.dispatch/<slug>/review/<point>-round-<N>.md` が生成され、末尾に `VERDICT:` 行があること。両モードともファイルポーリング(5 秒間隔・15 分チャンク + `cmux read-screen` 画面差分によるレビュアー生存確認。活動中は上限なしで待機し、レビュー中に 15 分超過しても再依頼が飛ばないこと。最終 sleep 中に書かれた verdict もチャンク境界の再確認で検知されること)で verdict を検知すること(agmsg push 待ちは idle セッションを起こせないため使わない)
24. **review_mode 解決**: config 未設定（または `"ask"`）+ `review_model` 付き runner ありで、dispatch のたびにタスク起動前に 4 択質問（はい今回のみ / いいえ今回のみ / 常に有効 / 常に無効）が出ること。「今回のみ」では config に書き込まれず次回も質問が出ること。「常に〜」で `"on"` / `"off"` が永続化され以後質問が出ないこと。`.dispatch/config.json` の `review_mode` がグローバルより優先されること
25. **status 非汚染**: レビューペインの存在が standby の `.assigned-*` / status.json に影響しないこと（途中で close せず開いたままでも汚染しないこと、レビューペイン spawn 直後に status.json が "launched" で上書きされないことを含む）。prewarm 無効時は最初のレビューポイントで `--mode review` のオンデマンド spawn が行われること
26. **exec_model**: `exec_model` は **claude / codex 両 runner** で有効。claude runner に設定時（既定は `sonnet`）、codex runner に設定時（既定なし、codex 側デフォルト）のどちらも、Phase B の実行（`--mode execute` spawn / prewarm standby）が `--model <exec_model>` 付きで起動すること。レビューペインは `review_model` のまま変わらないこと。`--model` 明示時は明示値が優先されること
27. **watcher 死亡時のフォールバック**: `delivery: "agmsg"` のタスクで宛先ペインの watcher を kill（ready sentinel が消える）した後に指示を送ると、inbox 記録がスキップされタイプ入力のみで配送されること（watcher 生存時もタイプ入力は常に行われる — inbox 記録の有無だけが変わる）。`send.sh` 自体が失敗した場合も配送は継続し終了コードは 0 のままであること。配線失敗（`delivery: "cmux-send"`）タスクの design / claude executor 初期プロンプトに `/agmsg actas` が含まれず、「typed directly into this pane」の文面になること。配線成功タスクの初期プロンプトは「task will arrive as a prompt typed into this pane（inbox に同一コピー）」の文面であること
28. **plan モード遵守ゲート**: plan モード子セッションで ExitPlanMode 承認後、ファイル編集前に Phase A-R（有効時）→ Phase B の task prompt 解決済み方式が走ること。worktree に `.claude/settings.local.json` が生成され、settings と `.claude/plans/` 配下の plan ファイルのどちらも `git status` に現れないこと。superpowers モードの worktree には hook が注入されないこと。既存の `.claude/settings.local.json` がある worktree では既存キーが保持されたままマージされること
29. **Phase B-R fixed**: 実装 runner/engine にかかわらず Phase A-R と同じ専用 review pane が `code` をレビューし、設計paneは `.deferred` 後にexitすること
30. **Phase B-R legacy**: `review_runner` key 未設定時のみ `DESIGN_ENGINE == EXEC_ENGINE` の単純規則（一致なら専用 review ペイン、不一致なら設計セッション自身）が動作し、resolver結果を `reviewer_runner` / `reviewer_engine` に書くこと
31. **Phase B-R 無効 / spawn 経路**: `review_mode: off` では Child が従来どおり `.deferred` touch 後すぐ exit し、実行指示にレビュープロトコルが含まれないこと。prewarm 無効時は `--review-config` 付き spawn で孫の inner prompt に `MANDATORY CODE REVIEW` 文が入り、`review/code-review.json` が生成されること。5 往復 needs_work → claude 実装者は AskUserQuestion が出る / codex 実装者は PR 本文に未解決指摘が注記されること
32. **effort 注入（両 engine）**: effort 3 フィールドは **claude / codex 両 runner** で有効。codex runner では composed command（`.cmux-team-dispatch-task-run-*.sh` 内）に `-c model_reasoning_effort='xhigh'`（plan/review 既定）/ `'high'`（execute/standby 既定）が入ること。claude runner では同じ既定値で `--effort <v>` が付くこと。**未設定フィールドでも既定値（plan/review `xhigh`、exec `high`）が適用され、flag が付くこと** — 旧仕様の「未設定なら `-c` を付けない」は誤りで、既定値を埋めたうえで注入する。`--effort` 明示時はそちらが優先されること。allowlist は engine 別（claude `low|medium|high|xhigh|max`、codex `minimal|low|medium|high|xhigh`）で、範囲外の値はレイヤーごとに警告して無視すること
33. **all-Codex ディスパッチ**: design/review/exec が codex、model が `gpt-5.6-sol` / `gpt-5.6-sol` / `gpt-5.6-terra`、prewarm は3ペインのみで claude executor が0件であること
34. **同一Codex Phase A-R**: codex design の plan/spec を codex review pane がレビューできること
35. **fixed Phase B**: codex exec paneへ委譲し、同じcodex review paneがB-Rを担当すること
36. **review spawn失敗**: 警告して当該gateだけ省略し、Phase B/PRへ進むこと
37. **design_runner default / runners reset**: project config が global config より優先し、有効な runner 名では Step 1f の switch / per-task 質問が出ないこと。runner 数分岐（1件は黙って採用・質問なし）は維持する。**未設定**では runner 2 件以上の switch 質問を4択（いいえ今回のみ / はい今回のみ / runner 設定を保存 / runners.json reset）とし、保存の追加2択（常に既定 / 常に固定）だけをグローバル config に永続化する。明示 `"ask"` は3択（いいえ / はい / reset）で永続化オプションを出さない。不正名は該当レイヤーのみ警告して無視され（project 不正 → global へフォールバック）、全レイヤー不正・未設定なら4択になること。reset は `RUNNERS_JSON` のみ削除し、review 方針の質問と永続化をスキップする reset mode で初回セットアップを行う。project/global config を変更せず、Step 1f 解決を再開すること
38. **exec_choice default**: 値域は `claude` / `codex` / `ask` の engine 選択であり、旧値 `"opus 1m"` / `"sonnet"` は不正値としてそのレイヤーだけ無効化されること（移行はしない）。固定値の runner が利用不能な場合も同様にそのレイヤーだけ無効化し、project → global → interactiveへ進むこと。未設定/`"ask"` の既存質問と atomic persistence は維持する
39. **codex 起動安全性**: superpowers は bypass で approval prompt を出さず、review は `--sandbox workspace-write` + `-c approval_policy='never'` + `--add-dir <STATUS_DIR>` で worktree 外の `<STATUS_DIR>/review/` に findings を書けること。`bash test/test-launch-workspace-codex.sh` の静的検査を実行すること
40. **pane close の誤通知**: 全タスク完了後のクリーンアップで standby / 実装ペインを閉じたとき、`[dispatch] task ... finished (status: error)` が親へ飛ばないこと、`status.json` の `done` が保持されること。`executing` 中の pane を閉じた場合は従来どおり `error` 通知が飛ぶこと。`bash test/test-runner-signal-exit.sh` の動的検査を実行すること
41. **タスク内の並列実行**: plan / superpowers / execute で起動した子セッションのプロンプトに `PARALLEL EXECUTION, mandatory` が含まれること。codex には `spawn_agent`、claude には Task サブエージェントの指示が届くこと。standby / review の起動コマンドには含まれず、親が送る実行指示・レビュー依頼側に含まれること。`--no-parallel` で起動プロンプトから消えること
42. **最終クリーンアップの pane close**: `cmux close-surface` の呼び出しに `--workspace` が付いていることを確認する。付けないと `surface:N` ref が親の `$CMUX_WORKSPACE_ID` に対して解決され、必ず `Surface ref not found` で失敗する（`2>/dev/null || true` で握り潰されるため無言で残る）。また `workspace_id` は `status.json` だけに依存してはならない — 子セッション自身が書く done/error は 3 フィールドの `echo` で `workspace_id` / `surface_id` を消し、runner wrapper がそれを書き戻すのはセッション終了時だけなので、codex TUI が終了指示を無視して idle 残留すると永久に欠落する。欠落時は `cmux workspace list` を slug 名（`[<slug>]`）で引いてフォールバックすること。この 2 つが揃って欠けていたため、ディスパッチ終了後に pane が閉じられないまま `git worktree remove` が生きている codex の cwd を消し、codex TUI が `failed to refresh skills: ... failed to reload config: No such file or directory` を出し続ける事故が起きた。回帰は `bash test/test-cleanup-close.sh`（CL1-CL2）で検証する
43. **`--setup` / `--reset`**: どちらもディスパッチが起動しないこと。`--setup` で現在の設定表 → 書き込み先/対象 → 役割キー → 差分確認の順に進み、書き込み後も `shell_ready_ms` が残ること。プロジェクトを選んで `.dispatch/config.json` を作り、1 件ディスパッチして cleanup まで通しても**生き残る**こと。`--reset config` は役割 5 キーだけ消し worktree / ブランチ / `.dispatch/` の他の中身を消さないこと。`--reset` 単体で対象メニューが出ること。`--reset runners` で `runners.json` が再生成され両 config.json が変わらないこと。`--setup --loop` の同時指定が排他エラーになること
45. **`--override`**: タスク一覧 → 対象タスク → 役割 → runner/model/effort の順に質問が出て、
    各質問の先頭が「変更なし（現在: <解決値>）」であること。上書きした内容がサマリー表の
    直後にブロックとして表示されること。dispatch 後に両 `config.json` が変化していないこと。
    `--override --loop` が排他エラーになること
# GitHub issue 自動ループの保守

`--loop` の仕様は `skills/cmux-team-dispatch-task/references/loop-mode.md` を正本とする。loop CLI、プロンプト、起動フラグを変更するときは SKILL.md、guide-ja.md、README.md、CLAUDE.md を同時に更新し、`.dispatch-loop/` の owner lock と timeout sentinel の契約を維持する。renderer headerはdesign/review/execの解決済みrunner/engineを一度だけ出し、review無効時にreview fieldsを要求しない。timeout sentinelとcleanupは`prewarm.json`に生成されたroleだけを対象にする。
