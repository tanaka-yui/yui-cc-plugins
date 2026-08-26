# cmux-team-dispatch-task 開発ガイド

cmux ワークスペースを活用した並列タスクディスパッチスキル。
各タスクに独立した git worktree + Claude Code セッションを割り当て、親セッションがオーケストレーションを行う。

## ファイル構成

| ファイル | 役割 |
|---------|------|
| `skills/cmux-team-dispatch-task/SKILL.md` | メインスキル定義（3ステップワークフロー） |
| `skills/cmux-team-dispatch-task/references/guide-ja.md` | 日本語リファレンスガイド |
| `skills/cmux-team-dispatch-task/scripts/launch-workspace.sh` | ワークスペース/スプリット起動スクリプト |
| `skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh` | 解決済み 4 ロールの prewarm、agmsg 配線、2/4 ペイン固定配置、prewarm.json 生成 |
| `skills/cmux-team-dispatch-task/scripts/verify-agmsg-ready.sh` | agmsg の到達性を**確認するだけ**の read-only チェッカー。`--self`（claude セッションの watcher）/ `--codex --team <t> --name <n>`（codex の bridge seat）を持ち、exit 0 = 到達可能 / 1 = 到達不能 / 2 = 使用法エラー。stdout は `ready=yes|no reason=<slug> …`。watcher を起動しない（起動するのは SessionStart hook が要求する `Monitor` tool 自身） |
| `skills/cmux-team-dispatch-task/scripts/report-status.sh` | 子セッションが status.json を終端へ遷移させる入口（既存フィールドを保存。クォート不要なので inner prompt から安全に呼べる） |
| `skills/cmux-team-dispatch-task/scripts/terminal-wait.sh` | シェル起動検知と `shell_ready_ms` 学習を行う共通ヘルパー（source 専用） |
| `skills/cmux-team-dispatch-task/scripts/parallel-directive.sh` | 子セッションへ渡す並列実行ディレクティブの生成（文面の単一情報源） |
| `skills/cmux-team-dispatch-task/scripts/config-lib.sh` | config パス、4 ロール、engine 別既定値と値検証の共通関数（source 専用） |
| `skills/cmux-team-dispatch-task/scripts/config-resolve.sh` | 4 レイヤーを `(role, field)` 単位で合成し roles.json を出力する resolver |
| `skills/cmux-team-dispatch-task/scripts/config-edit.sh` | config.json への唯一の書き込み口（キー/値検証・置換ではなくマージ・writer 固有 mktemp + jq 成功時のみ mv） |
| `skills/cmux-team-dispatch-task/scripts/prewarm-snapshot.sh` | normative child prompt が source する prewarm.json 共通 validator（完全な in-memory document を 1 引数で検証） |
| `skills/cmux-team-dispatch-task/scripts/prune-not-ready.sh` | 非 ready optional review role の surface ownership を検証して回収・snapshot prune |
| `skills/cmux-team-dispatch-task/scripts/review-gate.sh` | Phase B-R の canonical review config を all-or-nothing で発行 |
| `skills/cmux-team-dispatch-task/scripts/phase-b-deliver.sh` | 検証済み exec tuple と任意の review config から Phase B request を組み立て、1 回配送 |
| `skills/cmux-team-dispatch-task/scripts/render-loop-prompt.sh` | 検証済み prewarm snapshot の 4 ロール tuple から無人 prompt を生成 |
| `skills/cmux-team-dispatch-task/scripts/loop-cleanup.sh` | 検証済み prewarm snapshot に存在する 4 ロールの surface / agent だけを cleanup |
| `skills/cmux-team-dispatch-task/references/setup-mode.md` | `--setup` / `--reset` の実行時 SoT（英語） |
| `skills/cmux-team-dispatch-task/references/setup-mode-ja.md` | 同上の日本語版 |
| `~/.claude/config/cmux-team-dispatch-task/config.json` | グローバル設定。`review_mode` と `runner.<role>.{runner,model,effort}`、および `shell_ready_ms` 等の第三者キーを保持 |
| `~/.claude/config/cmux-team-dispatch-task/runners.json` | runtime registry。各 record は name / command / engine のみ、top-level default は初回 config 生成時だけ使用 |
| `<project>/.dispatch/config.json` | プロジェクト固有の field-level override。cleanup の掃き出し対象から除外される |
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

- ロールは `design` / `design_review` / `exec` / `exec_review` の固定 4 つ。各 tuple は
  runner / model / effort / engine で構成する。`review_mode=off` では review 2 ロールを解決しない。
- 各 `(role, field)` の precedence は `--override` → project config → global config →
  組み込み既定値。layer 全体ではなく field ごとに合成する。`runners.json` は runtime registry で、
  role 値を持たない。
- runner 名と registry engine、model の安全な文字列、engine 別 effort allowlist を検証する。
  active ロールの runner が未設定、runner が未登録、または codex review role の model が欠ける
  場合は resolver が exit 2 で fail-fast し、ペインを作らない。壊れた JSON 等は別の非 0 とする。
- Phase A-R は `design_review`、Phase B は常に `exec`、Phase B-R は `exec_review` が担当する。
  design は実装指示を送ったら `.deferred` を作って終了し、review role へ転じない。engine 比較で
  reviewer を推測する分岐も、実装 engine を質問する分岐も無い。
- prewarm は常時有効。`review_mode=off` は design / exec の 2 ペイン、`on` は 4 ロールの 2×2。
  `prewarm.json` のロールキーもこの 4 つだけで、readiness に失敗した review ロールは回収成功後に
  `prune-not-ready.sh` で key を prune する。design / exec の readiness 失敗は dispatch を止める。
- 必須 role の launch failure は、当該 `prewarm-panes.sh` 呼び出しが作成・join・launch した
  worktree / branch / team member / surface だけを rollback し、再利用資源は保持する。
- すべての roles.json / prewarm.json consumer は検証済みスナップショット契約に従う。内容を
  1 回だけ読み、document 全体を検証し、以後はローカル値からだけ抽出する。cleanup は snapshot の
  workspace_id と現在の workspace を照合し、固定 4 ロールキーだけを close / leave する。
- destructive prune と review config consumer は strict な `workspace:<digits>` / `surface:<digits>`、
  workspace 一致、active surface の一意性と live ownership を shell 構築前に検証する。review dir は
  status dir 直下の canonical non-symlink directory、config はその中の regular JSON に限定する。
- `--override` は 4 ロールの pending tuple を `override-args.sh` で検証し、config / registry へ
  書き戻さない。review ロールは `review_mode=on` の場合だけ選択肢へ出す。

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
| 永続プロセス | 各ペインの agmsg watcher（claude は SessionStart hook が要求する `Monitor` tool 自身、codex は bridge）。このスキルは watcher を起動せず `verify-agmsg-ready.sh` で生存を確認するだけ。watcher は自分の liveness token が stale になれば自己終了するが、SIGKILL で pane が落ちると EXIT trap が走らず pidfile / seat が残るため、その場合の掃除は手動になる | なし |

**重複を避ける**: cmux-using 固有の機能（基本 cmux 操作）を含めない。

## メンテナンス手順

1. `launch-workspace.sh --help` の出力と SKILL.md の使用例を突き合わせて整合性を確認
2. Child 起動に `launch-workspace.sh` を直接使うこと（`--defer-status` 必須）を SKILL.md・guide-ja.md の使用例と突き合わせて整合性を確認
3. `verify-agmsg-ready.sh --help` の出力（`--self` / `--codex --team <t> --name <n>` / `--session-id` と exit 0/1/2）と SKILL.md Step 1g・Step 3 の使用例を突き合わせて整合性を確認。**監視スクリプトはもう存在しない**ので、それに相当する検査項目（定期通知 / 再開フラグ / ディスパッチ dir の指定）は無い
4. ステータスプロトコル（status.json スキーマ、`pr_url` を含む）が SKILL.md と guide-ja.md で一致しているか確認
   - クリーンアップは親セッション側で全タスク完了後にまとめて 3 問（workspace / worktree / branch）聞く方式。`status.json` には保存しない
5. superpowers 連携セクション（"superpowers Execution Handoff Integration"）が superpowers プラグインの最新仕様と整合しているか確認
6. `terminal-wait.sh` の config スキーマ（`shell_ready_ms.baseline_ms` / `samples` / `updated_at`）が guide-ja.md の説明と一致しているか確認
7. Display Format Conventions（Template A/B/C）が SKILL.md / guide-ja.md / 子セッションプロンプト埋め込みの `PROGRESS REPORTING FORMAT` の3か所で完全一致しているか確認（カラム数・順序・幅・Mode 略称）
8. Phase B の固定委譲フローが **SKILL.md / guide-ja.md / README.md / CLAUDE.md の 4 ファイル**で完全一致しているか確認:
   - dispatch 中に runner / engine の質問を出さず、`roles.json.roles.exec` の解決済み tuple だけを使う
   - Phase A 完了後は常に `exec` ペインへ `phase-b-exec:` を配送し、design は `.deferred` を作って終了する
   - 計画の受け渡しは `--plan-file <path>` で行い、executor の runner / model / effort は config 解決値を渡す
9. 配送が agmsg `send.sh` の 1 回呼び出しに一本化され、`cmux send` / `cmux send-key` の直書きが残っていないことを確認（`launch-workspace.sh` / `prewarm-panes.sh` / `parallel-directive.sh` / `render-loop-prompt.sh` の実装、および SKILL.md / `references/` 配下の全 `.md` の指示文）。回帰は `bash test/test-delivery-callsites.sh` で検証する: **CS1 = 4 スクリプトに `cmux send` / `cmux send-key` の直書きが残らない**（`send-key` 無しの一方通行の `cmux send` も配送事故になるため両方を検出する）、CS2 = `launch-workspace.sh` が agmsg `send.sh` を解決して実行する、**CS3 = SKILL.md と `references/**/*.md`**（訳の `guide-ja.md` と、`render-loop-prompt.sh` が子タスクプロンプトへ連結する `references/unattended/*.md` を含む）に直書きが残らない、**CS4 = 削除済み 6 スクリプトへの参照が PENDING 表の箇所以外に残らない**（表に無いファイルに 1 件でも出れば FAIL、表にあるのに 0 件でも「猶予は不要になった」で FAIL するラチェット）、CS5 = verdict 待ちのポーリング指示が残らない、CS6 = レビュー依頼文に `review-verdict:` の通知指示がある、CS7 = verdict を待つ側に単発タイマーの指示がある。CS1 は対象ファイルが読めない、または grep が status 2 以上を返すときも FAIL にして fail-open させない。訳や無人ループ用ブロックが原文から遅れて旧文面を残す事故を防ぐため、対象をこれら全部に広げてある
   - **CS5 は日本語を検出しない**（英語の語彙だけを走査する）。`guide-ja.md` / `README.md` / `CLAUDE.md` の日本語側に旧ポーリング記述や退役済みスクリプト名が残っても CS5 は赤くならない — 実際に v2.0.0 の移行で `guide-ja.md` の旧記述だけが丸ごと取り残された。日本語文書の旧語彙は `bash test/test-doc-stale-vocab.sh`（DS1-DS3）で別に固定する（項目 45）
   - **免除は行番号ではなくマーカーで行う**: シェルへのコマンド打鍵（TUI へのメッセージ配送ではない）など正当な `cmux send` は、直前 3 行以内（ドキュメントは同一行または直前行）に `send-prompt-exempt:` を含むコメントを置いたときだけ検査から外れる。新しい出現は必ずレビューを通る。**スクリプトのコメント行はマーカー判定より前に無条件で除外される。** したがってコメント中の `cmux send` 言及に付ける `send-prompt-exempt:` は、レビュー済みの意図を残す注釈であって現行 CS1 の load-bearing な条件ではない。マーカーが load-bearing なのは非コメント行の直書き（`launch-workspace.sh:1085-1088`）に対してだけ
10. 4 ロールの runner / model / effort / engine が `config-resolve.sh` の出力だけから読まれ、別箇所で再導出されないこと。design_review / exec_review は独立し、Codex review role は model 必須、Claude は組み込み model を使えること。
11. Phase B は `phase-b-deliver.sh` が検証済み `prewarm.json.exec` の固定 tuple から agent / engine を使い、同 agent へ `phase-b-exec:` を 1 通送るだけで、新しい execute session を起動しないことを SKILL.md / guide-ja.md / README.md / CLAUDE.md で一致させる。送信前の assignment marker、送信成功後の `.deferred`、実装者用 parallel directive、terminal status と `dispatch-notify:`、engine 別の終了規則を依頼文に含める。`launch-workspace.sh --mode execute` は launcher 単体の回帰用経路として残るが dispatch の Phase B からは呼ばない
12. **`message_type` 廃止と agmsg 必須化の判定**が SKILL.md / guide-ja.md / README.md / CLAUDE.md で一致しているか確認。通知トランスポートの質問も config キーも存在しないこと。`launch-workspace.sh` / `prewarm-panes.sh` が `--message-type` を `was removed` を含む die で拒否し、agmsg 配線は `--agmsg-team` / `--agmsg-from` で行われること。**agmsg は劣化モードの無い必須要件**であること（詳細は項目 17）。**監視は単発タイマーの wake で状態を再導出する方式**であり、監視スクリプトも定期通知も再開フラグも存在しないこと:
    - 起床のたびに `.dispatch/*/status.json` を全部読んで状態を**再導出**し、記憶に頼らないこと。自分自身の受信チャネルも毎回 `verify-agmsg-ready.sh --parent --team "$TEAM"` で再検証すること。**呼び出し側で engine 分岐を書かないこと** — 分岐はスクリプトの中にあり、無条件 `--self` は codex 親で必ず rc=2 になって「rc=2 は判定不能なので停止」規約と噛み合いディスパッチが最初の起床で自滅する（`test-agmsg-guard-block.sh` の GB7/GB8 と `test-verify-agmsg-ready.sh` の VR10 が固定）。同じ呼び出しが返す `sharing=<N>|unknown` は read cursor の競合数で、到達可能かの判定は変えないので正の数のときだけ 1 行警告し `0` / `unknown` では何も言わないこと。（親の watcher は `watch.sh` の自己終了や `/compact` との競合でディスパッチ途中に死にうる。死ねば全通知が黙って失われ、残るのはタイマーだけになる）
    - タイマーは **90 分固定の単発**（`sleep` 1 回。ループ禁止）で、ペイン起動直後・`[ready]` を待つ**前**に武装すること。ただし**張れるのは claude 親だけ**である: codex は `run_in_background` を持たず、代替の「自分宛の遅延メッセージ」も 2026-08-21 の実測（D-T2）でターン終了と同時に消えた。したがって **codex 親には 90 分タイマーが存在せず、張ったふりをする指示を書いてはならない**。Step 1g はその事実をユーザーへ明示し、`prewarm-panes.sh` は `--unattended` × codex 親を die で拒否すること。`loop.task_timeout_min` はこのタイマーには届かない（loop モードの起床時 reconciliation 専用）
    - 再武装は**同一ラウンドで 3 回上限**。上限を使い切ったら `cmux read-screen` の抜粋を添えて報告し、無人ループでは AskUserQuestion に落とさずスキップ／エラー扱いにすること
    - **Completion で必ずタイマーを止める**こと（claude 親は `TaskStop`。codex 親は何も武装していないので止めるものが無い）。止め忘れると 90 分後に無関係な会話へ発火し、再武装分岐に落ちるのでディスパッチのたびに 1 つずつ残る
    - タイマーで起きたら**判断の前に永続記録を読む**こと: `status.json` の再導出に加え、`[ready]` の確認は `history.sh <team> parent N` を使い **`inbox.sh` は使わない**（競合 watcher に消費された row は既読になり `inbox.sh` は「新着なし」と正直に答える）。照合は `[ready] <slug>` を**行末までアンカー**して行う（アンカーが無いと slug `api` が `[ready] api-v2` で満たされ、報告していないタスクが ready に見える）
    - **タイムアウト検知の粒度が粗くなった**旨が 4 ファイルに書かれていること: 旧 loop 待機スクリプトは 5 秒間隔で `claimed_at` を見ていたが、現行はタイマー起床時にしか評価しないため、`loop.task_timeout_min` を 90 分未満にしても検知は次の起床までずれる（ポーリング全廃の意図した代償）
    - 子プロンプトの status protocol に「status.json 書き込み直後の必須完了通知（本文接頭辞 `dispatch-notify:` の `send.sh` 1 回呼び出し）」が含まれること
    - 回帰は `bash test/test-message-type-removed.sh`（MT1-MT3）、`bash test/test-delivery-callsites.sh`（CS5-CS7）、`bash test/test-verify-agmsg-ready.sh`（VR1-VR8）で検証する
13. prewarm.json が `workspace_id` / `review_mode` と `design` / `design_review` / `exec` / `exec_review` の固定ロールキーだけを持つこと。off は design / exec の 2 キー、on は通常 4 キーで、launch/readiness に失敗した review key だけが省略される。各 role object は surface_id / agent / runner / engine / model（必要時）/ effort / wired を持ち、全 consumer が内容を 1 回だけ読む検証済み snapshot 契約に従うこと。
14. Phase A-R（設計セッションの plan/spec を `design_review` がレビュー）が4ファイルで一致しているか確認:
    - `design_review` の解決済み tuple を使い、他ロールの engine から reviewer を推測しない。readiness 失敗時だけ Phase A-R を省略する
    - レビューポイント（plan モード: plan 後 1 回 / superpowers モード: spec 後 + plan 後の 2 回）、各ポイント最大 5 往復、approve は何ラウンド目でも即終了、5 往復 needs_work 時は AskUserQuestion（このまま進む / さらに修正）
    - verdict の**記録**はファイル（`<STATUS_DIR>/review/<point>-round-<N>.md` 末尾の `VERDICT: approve|needs_work`）、**起床**はメッセージ。依頼配送は本文接頭辞 `review-plan:` の agmsg `send.sh` 1 回呼び出しで、宛先はレビューペインの **agent 名**（`REVIEW_PANE_AGENT`）であり surface ID ではない。依頼文には「findings ファイルを書いた直後に `review-verdict:` を依頼元へ 1 通送る」ことを必ず含める。待機側はポーリングせず、ターンを閉じる。`phase-a-review-wait.sh` が実配送 prompt を生成し、waiter engine は timer の有無、reviewer engine は liveness 検査を独立に決める。Codex reviewer は `verify-agmsg-ready.sh --codex`、Claude reviewer は検証済み workspace / surface への `cmux read-screen`（1 回 retry）を使う。**claude 待機者だけが単発 safety timer（`sleep $((30 * 60))` 1 回。ループ禁止。Bash tool の `run_in_background`）を武装できる**。**codex 待機者には保険が無く、張ったふりをしてはならない**（自分宛の遅延タイマーは D-T2 で不発と実測）— 待機に入る前に依頼相手の到達性を確認し、「保険の無い待機に入った」ことを親へ `dispatch-notify:` で 1 通報告すること。claude 待機者は verdict を処理したらタイマーを止める（`TaskStop`）。メッセージの識別は接頭辞 **＋ round id の部分一致**で行い、行全体の完全一致にしない。**どの起床でも先に findings ファイルを読み直す**（失われうるのはメッセージだけ）。`review-verdict:` メッセージが来たのに verdict 行が無ければ `needs_work` 扱い、**verdict 行の無いタイマー起床は verdict ではない**。タイマーが verdict 無しで発火したら reviewer engine 別の liveness を確認 → 作業中なら同じタイマーを再武装（同一ラウンド最大 3 回）→ そうでなければ同一ラウンド 1 回再依頼して再武装 → それでも出ない、または 3 回使い切ったら AskUserQuestion
    - design と同じ engine を許可し、同一 `design_review` ペインを全ポイントで再利用する。launch/readiness 失敗時は警告して Phase B へ
15. **配送の agmsg `send.sh` 一本化**が SKILL.md / guide-ja.md / README.md / CLAUDE.md で一致しているか確認:
    - 指示を送る全箇所（Phase A design タスク `phase-a-task` / Phase B claude executor・codex executor・codex 設計 variant の委譲 `phase-b-exec` / Phase A-R review 依頼 `review-plan` / Phase B-R コードレビュー依頼 `review-code` / レビュアー → 依頼元の verdict 通知 `review-verdict` / レビュアーへの abort 通知 `abort-reviewer`（実装者からも runner wrapper の `notify_reviewer_once` からも同じ label を使う。`dispatch-abort` は廃止）/ 親への完了・abort 通知 `dispatch-notify`）が **agmsg `send.sh` の 1 回呼び出し**になっており、`cmux send` + `cmux send-key return` の 2 行ペアが残っていないこと。label は上記のとおり固定（1 メッセージクラス = 1 label）で、**フラグではなく本文の接頭辞**（`<label>: <本文>`）であること。退役した監視ループ用の label が残っていないこと
    - 契約が 4 ファイルで一致すること: 宛先は **agmsg の agent 名**であり surface / workspace ID ではない（`REVIEWER_SURFACE` などの surface 値は `cmux read-screen` の生存確認専用で、配送先に使わない）/ ペインは `[ready] <name>` を報告してはじめて到達可能で、それ以前に送ったメッセージは inbox に未読で残る / 回避すべき長さ制限も outbox も無く本文はそのまま渡す / Enter 検証も再送も無く、`send.sh` は共有 SQLite DB へ書くか非ゼロ終了するかのどちらかで、**非ゼロ終了は未配送**なので必ず報告する
    - Phase A-R は `design_review`、Phase B-R は `exec_review` の agent を宛先に使い、surface id は liveness 確認以外へ使わないこと
    - **`prewarm-panes.sh` に配線されない variant は存在しない**こと: `--agmsg-team` が必須、`launch-workspace.sh` は `--status-dir` があるとき `--agmsg-team` / `--agmsg-from` が必須、`join.sh` / `delivery.sh set` の失敗はペインを 1 つも作る前に die。4 ロールとも同じ形のプロンプト（readiness 確立句 + 「idle で待て。タスクは agmsg メッセージで届く」）で起動し、「タイプ入力で届く」とは書かないこと。`/agmsg actas` は現行プロトコルに存在しない
    - **readiness 確立句は散文で、引用符を 1 文字も含まない**こと（`zsh -ic "claude ... '<prompt>'"` に入り `launch-workspace.sh` はエスケープしないため。またコマンドとして書くと zsh が `[ready]` を glob 展開して `no matches found` で落ちる）。文面の単一情報源は `prewarm-panes.sh` の `readiness_clause()`
    - 回帰は `bash test/test-delivery-callsites.sh`（CS1-CS7）、`bash test/test-launch-workspace-codex.sh`（LW1-LW2）、`bash test/test-prewarm-layout.sh`（PW1-PW10）、`bash test/test-launch-workspace-review-config.sh`（PR/T 系）で検証する
16. plan モードの遵守ゲート（ExitPlanMode hook）が SKILL.md / guide-ja.md / README.md / CLAUDE.md の 4 ファイルで一致しているか確認:
    - `launch-workspace.sh` が `--mode plan` かつ claude engine のときのみ worktree の `.claude/settings.local.json` に PostToolUse hook（matcher: `ExitPlanMode`、command: `zsh <skill-dir>/scripts/plan-approved-hook.sh`）を注入すること（既存 settings は jq マージ、worktree 再利用時は重複注入なし、失敗は警告のみで dispatch 続行）
    - `.claude/settings.local.json` と plan 保存先 `.claude/plans/` が repo 共有の `info/exclude` に追記されること（settings のマージ書き込みは tmp + mv のアトミック方式、hook command のスクリプトパスはクォート済み）
    - hook が worktree に残存し後続セッション（prewarm 済み exec を含む）にも作用するが、plan モードを使わないため実害なし — と 4 ファイルで文書化されていること
    - MANDATORY MODEL SELECTION SEQUENCE の Phase A（plan モード）に「plan 冒頭に Step 0: Phase A-R（有効時）/ Step 1: Phase B を必須ステップとして記載」「plan が ExitPlanMode メッセージ内にしか無い場合は承認後最初にファイル保存」の指示、VIOLATION 節に PLAN-MODE TRAP が含まれること
    - `plan-approved-hook.sh` の出力が有効な JSON（`hookSpecificOutput.additionalContext`）であること
17. Phase B-R（実装後コードレビュー）が SKILL.md / guide-ja.md / README.md / CLAUDE.md の 4 ファイルで一致しているか確認:
    - `review_mode=on` かつ ready な `exec_review` が存在するときだけ有効。`review-gate.sh` は canonical `code-review.json` path だけを all-or-nothing で出力し、親が exact path を design task prompt の `REVIEW_CONFIG_PATH` literal へ埋め込み、`phase-b-deliver.sh --review-config` が消費する。親 shell の変数継承や launcher 引数にはしない
    - 実装者は `exec_review` agent へ `review-code:` を送り、reviewer は `<STATUS_DIR>/review/code-round-N.md` の末尾に `VERDICT: approve` または `VERDICT: needs_work` を書いてから `review-verdict:` を返す。最大 5 ラウンドで、第 6 ラウンドは開始しない。round 5 が needs_work なら未解決指摘を PR 本文へ記録して進む
    - design / design_review を code reviewer に使わない。exec_review launch/readiness 失敗は gate だけを省略し、stale `code-review.json` を残さない
18. review の 2 ロールが独立していることを 4 ファイルで確認する。`design_review` は plan/spec だけ、`exec_review` は code だけを担当し、各 tuple は `(role, field)` 合成で解決する。同一 engine を許可するが、他ロールとの engine 関係から値を導出しない。
19. `(role, field)` precedence が `--override` → project config → global config → 組み込み既定値で一致すること。各 layer の runner / model / effort を field 単位で合成し、合成後に runner 登録・engine・model・effort を検証する。active role が解決不能なら setup で修正可能な exit 2 とし、壊れた JSON 等の読取失敗と分けて fail-fast する。
20. codex の engine × MODE 起動規則を確認: superpowers は bypass 付き、review は `--sandbox workspace-write` + `-c approval_policy='never'` に加えて `--add-dir <canonical-status-dir>/review` / `--add-dir <AGMSG_SKILL_DIR>/run` / `--add-dir <AGMSG_SKILL_DIR>/db` の3本の `--add-dir` を条件付きで併用し、findings 以外の status 領域へ書き込ませないこと。review dir は symlink を拒否して status dir 直下への containment を証明する。`run/` と `db/` は `-d` 判定の前に launcher 側で作る。回帰は `bash test/test-launch-workspace-codex.sh` の CR1/CR1b/CR1c/CR1d/CR1e で検証する

    **トラストバウンダリ（`--add-dir <AGMSG_SKILL_DIR>/{run,db}`）**: この付与は「このディスパッチ限り」ではなく**マシン全体の agmsg 状態への書き込み許可**である。`run/` には全セッション・全プロジェクトの watcher pidfile / codex bridge seat / actas lock が同居し、`db/` は全 team 共有の 1 つの SQLite DB **に加えて** agmsg のマシン全体設定 `config.yaml`（実体は `delivery.monitor.poll_interval` と `delivery.turn.check_interval` の 2 キーだけで、読むのは `scripts/config.sh` のみ。spawn 系の設定は `db/` の外の `~/.agmsg/config/spawn_options.yaml` にある）と、外部ストレージドライバの opt-in allowlist `trusted-plugins`（`storage.sh` が `.` でソースするファイルの信頼リスト）も置かれる。したがって無人・承認なしの codex reviewer は、他ディスパッチの sentinel を消す / 任意の `from` を騙るメッセージを inbox へ書く（inbox の本文は他エージェントへテキストとして注入されるので**プロジェクト境界を越えるプロンプトインジェクション経路**になる）ことが原理上できる。guard を注入する以上この付与は機能上必須であり、`scripts/`（そこは全ペインの guard が実行するコード）を除外していることが**主要な**緩和策である。

    ただしそれが唯一ではない。`trusted-plugins` を書けてもコード実行に至らない理由は「`AGMSG_PLUGIN_DIRS` が既定で未設定だから」**ではない**（`driver-registry.sh:47` の `printf 'external\t%s\n' "$root/plugins"` は env と無関係に**常に**列挙されるので、この説明は成立しない）。正しい理由は次の 3 点:

    1. `agmsg_storage_load`（`storage.sh:369-395`）が `.` でソースするのは `$base/storage/$name.sh` **だけ**で、`$base` は「builtin = `$root/scripts/drivers`」「external = `$root/plugins`」「`AGMSG_PLUGIN_DIRS` で追加された dir」の 3 種に限られる。付与している `run/` と `db/` はそのどれでもない。
    2. `trusted-plugins` は**パス注入の経路ではなく、既に base 配下に実在するファイルに対する yes/no ゲート**にすぎない。`agmsg_driver_is_trusted` は `<axis>/<name>\t<絶対パス>` の完全一致を要求するので、信頼リストが名指しできる場所へファイルを置けない。
    3. ドライバ**名**も `db/` ではなく `${AGMSG_CONFIG:-$HOME/.agents/agmsg/config.json}` から解決される（`storage.sh:341-343`）。付与の外なので名前も選べない。

    したがって**守るべき不変条件は「external base が `run/` と `db/` の下に無いこと」**であり、「`AGMSG_PLUGIN_DIRS` が未設定であること」ではない。上流が external base を 1 つ増やしたときに再確認すべき対象が全く違うので、この区別を落とさないこと。実運用の到達性は低い**残存リスク**であって、開いた攻撃経路ではない。範囲を狭める案は agmsg 側が per-session のディレクトリを持たない限り成立しない
21. Phase B 実装セッションの **完了報告と engine 別の終了指示** を SKILL.md / guide-ja.md の base / Phase B-R 拡張 `REQUEST_TEXT` の両方で確認する。prewarm standby は execute launcher prompt を読まないため、依頼文自身が `report-status.sh <status-dir> done <要約>` と親宛 `dispatch-notify:`、実装者用 parallel directive を持つ。Phase B-R 拡張時は reviewer 用 parallel directive も保持する。Claude は完了報告後に `/exit`、Codex は自分で終了せず idle のまま待ち、親が final cleanup で pane を閉じる。status の終端遷移と親通知はセッション終了に依存させない。回帰は `bash test/test-launch-workspace-codex.sh`（T5b/T5c/T6b/T7/T14/T15/PL8-PL10）で検証する

22. runner wrapper の **signal 終了ガード**が SKILL.md / guide-ja.md / README.md / CLAUDE.md の 4 ファイルで一致しているか確認: 子プロセスの終了コードが 128 以上（signal 由来。SIGHUP=129 / SIGKILL=137 / SIGTERM=143）**かつ** `status.json` が既に terminal（`done` / `error`）のときだけ、status 書き込みと親通知の両方をスキップすること。`executing` のまま kill されたケース、および signal 以外の異常終了（exit 1 等）は従来どおり `error` を報告すること（ガードを広げすぎない）。最終クリーンアップの pane close で完了済みタスクが `error` に降格し偽通知が飛ぶ事故の再発防止であり、回帰は `bash test/test-runner-signal-exit.sh`（S1–S6、生成された runner script を実際に実行する動的テスト）で検証する
23. **error パスの通知**が SKILL.md / guide-ja.md / README.md / CLAUDE.md の 4 ファイルで一致しているか確認:
    - runner wrapper が子の書いた終端 status を上書きしないこと（`PREV_STATUS` が `error` なら常に保持、`done` は正常終了時のみ保持、`done` + 非ゼロ終了は保守的に `error`）。親通知のラベルは終了コードではなく確定 status から導出すること
    - status.json watcher が子プロセスと並行して走り、15 秒間隔（`CMUX_DISPATCH_WATCH_INTERVAL` で上書き可）で終端遷移を検知して通知すること。抑止条件は exit パスと同一（timeout sentinel / `.deferred` / 未 assigned standby / 他 pane の `.assigned-*`）で、poll のたびに再評価すること
    - 通知処理は `notify_parent()` / `notify_parent_once()` に一本化し、watcher と exit パスの両方が同じ関数を呼ぶこと。配送は `parent` agmsg agent 宛の `send.sh` 1 回呼び出しだけで、`--agmsg-team` / `--agmsg-from` が無い launch は `--status-dir` 付きなら `launch-workspace.sh` が die して弾くこと。marker `.notified-<slug>` は存在の有無ではなく通知済み status 文字列を保持し、通知が成功したときだけ更新すること（非ゼロ終了では更新しないので次の poll で再試行される）
    - 実装者の ABORT/ESCALATION プロトコル（findings 記録 → レビュアー通知 → status.json → 親通知 → セッション終了）が prewarm 経路と spawn 経路の両方に入り、unattended 文面にも同じ手順があること
    - design wrapper は `phase-b-exec:` の配送成功後に `.deferred` を検知し、prewarm 済み exec が書いた終端状態を上書きしないこと
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
    - codex engine には**一切注入しない**こと。フォールバックフラグも codex には付けないこと（`BYPASS_INJECTION_OK` は claude 限定ブロックの内側でしか 0 にならないため、実際の担保は claude 側の判定にあり、フラグ合成側の `RUNNER_ENGINE == "claude"` ガードは多重防御。P19 が判別できるのは新警告が出ないことの側のみ）。codex の `--dangerously-bypass-approvals-and-sandbox` とレビューペインの `--sandbox workspace-write` + `-c approval_policy='never'` + 最大 3 本の `--add-dir`（`<STATUS_DIR>/review` / `<AGMSG_SKILL_DIR>/run` / `<AGMSG_SKILL_DIR>/db`。後者 2 本は値域検証を通り、かつ実在するときだけ付く fail-closed）は不変（項目 20 / 39）
    - loop の `UNATTENDED=1 && RUNNER_ENGINE == claude → SKIP_PERMISSIONS=1` と `prewarm-panes.sh --unattended` が不変であること
    - `AskUserQuestion` が対話的に残る根拠（permission gate と対話 UI は別レイヤー / `--dangerously-skip-permissions` と `bypassPermissions` は公式ドキュメント上等価）と、`skipDangerousModePermissionPrompt` をユーザー設定に置く必要があることが README と guide-ja.md の両方に書かれていること
    - `ensure_claude_exclusions` の呼び出しは `|| true` を付けること。`launch-workspace.sh` は `set -euo pipefail` で走るため、bare 呼び出しだと `info/exclude` を解決できない cwd（非 git など）で launch ごと死ぬ
    - 回帰は `bash test/test-launch-workspace-permissions.sh` の P1〜P30（全 MODE 注入 / codex 非対象 / 既存キー保持 / 冪等 / 正常系では superpowers にフラグを足さない / info/exclude 追記 / `--skip-permissions` との共存 / 非 git cwd でも launch が成功 / 判定失敗の 3 ケース A・B・C でのフォールバック / superpowers は `--skip-permissions` を読まない（P14）/ standby の prompt 有無の両分岐 / plan と `--skip-permissions` 既付与での二重付与なし / 正常系で誤発火しない（P20）/ worktree 再利用の短絡では発火しない / `--unattended` との共存 / ログ値のサニタイズの回帰（P26 / P26b、root では skip）/ review 単独ケースでの `*)` ワイルドカードの担保（P27）/ `jq -e -s` による複数 JSON ドキュメント連結の誤判定防止（P28）/ review + `--skip-permissions` の二重付与なし（P29）/ サニタイズより切り詰めを先に行う順序と切り詰め窓の拡大方向の担保（P30、chmod 不要で root でも走る））と `bash test/test-prewarm-design-permissions.sh`（DB1-DB2: 設計ペインと claude executor の `--skip-permissions` 非対称。本項目の変更に対する回帰ではなく既存カバレッジ負債の返済。`launch-workspace.sh` をスタブへ差し替えるため下記の警告文言は登場しない）で検証する。警告文言 `permission bypass not confirmed` と `added the CLI permission flag` は `test-launch-workspace-permissions.sh` だけが持つテスト定数なので、変えたら同ファイルを更新すること

26. **レイアウトの workspace 固定**が `launch-workspace.sh` / `prewarm-panes.sh` / `SKILL.md` / `guide-ja.md` / `README.md` / `CLAUDE.md` で一致しているか確認:
    - `launch-workspace.sh` が `--layout` / `--split-from` / `--split-direction` / `--parent-workspace` を、メッセージに `was removed` を含む明示的な die で拒否すること。composed command に `claude-teams` が現れないこと
    - SKILL.md / guide-ja.md に `{{LAYOUT}}` / `LAYOUT_MODE` / `LAYOUT=split` が残っておらず、起動例に削除済みの split 系フラグが残っていないこと。最終クリーンアップは workspace を閉じる 1 経路に統一すること
    - stdout JSON と初期 `status.json` の `layout` が定数 `"workspace"` のまま残り、`split_from` / `split_direction` キーは出力されないこと
    - `launch-session-splits.sh` / `cmux-grid.sh` が存在せず、README の移行注記以外の利用手順に削除済みレイアウトへの参照が残らないこと
    - workspace 内の配置は 2 パターンだけ: `review_mode=off` は design の下に exec を置く 2 ペイン、`on` は上段 design / design_review、下段 exec / exec_review の 2×2・4 ペイン。3 ペイン構成や engine 別 executor 候補を作らない
    - 回帰は `bash test/test-launch-workspace-layout.sh` と `bash test/test-prewarm-layout.sh`（PG1-PG3 ほか）で検証すること（監視スクリプトが消えたので、その layout 固定を見ていたテストも一緒に消えている）

27. **タスク内の並列実行**が SKILL.md / guide-ja.md / README.md / CLAUDE.md の 4 ファイルで一致しているか確認:
    - 文面の単一情報源は `scripts/parallel-directive.sh`。`--engine <claude|codex>` × `--mode <plan|superpowers|execute|review>` で 1 行を出力し、`--agents <N>`（2〜8、既定 4）で同時実行の上限を変える。`standby` モードは存在せず、standby ペインには `--mode execute` を渡す
    - **出力に `'` `"` `` ` `` `$` `!` `\` を 1 文字も含めてはならない**。composed command は `zsh -ic "... '<prompt>' ..."` で二重に引用され、`launch-workspace.sh` はエスケープしない（`-i` は対話モードなので history 展開が効き `!` も特殊文字になる）。回帰は `bash test/test-parallel-directive.sh` の PD4 で検証する
    - superpowers への譲歩文（subagent-driven-development の「実装者は同時に 1 体」を上書きしない旨）は engine / mode で出し分けず常に出力する。codex も `superpowers:brainstorming` 前置でパイプラインを辿るため
    - **適用範囲の一文（「調査と検証にだけ適用する」）は同時編集の禁止文より前に置き、直前の並列化ディレクティブに係らせる**。禁止文の後ろに置くと最近接先行詞が禁止文になり「同時編集の禁止は調査と検証にだけ適用される = 実装中は同時に編集してよい」と読めてしまい、guardrail が防ぎたい事故そのものを許可する
    - **分散を許すのは読み取り専用の検証だけ**。auto-fix / write モード（formatter・linter の write フラグ）はファイルと共有ビルドキャッシュを書き換えるため逐次に走らせる旨を execute モードの文面に含める
    - `launch-workspace.sh` が注入するのは plan / superpowers / execute の起動プロンプトだけ。standby / review は readiness 確立句だけで起動するので、並列ディレクティブは親が agmsg `send.sh` で送るテキストに含める。execute では `EXIT_INSTRUCTION` を必ず最後に残すこと
    - **注入点は 5 箇所**（起動プロンプト / Phase B 実行指示 / Phase A-R レビュー依頼 / Phase B-R レビュー依頼（prewarm 経路）/ Phase B-R レビュー依頼（spawn 経路））。この 5 行の表が SKILL.md と guide-ja.md で一致し、かつ**全行が実在すること**を確認する。特に prewarm 経路は、レビューペイン自身が `--mode review` 起動でディレクティブを持たないため、「共通プロトコル a」の拡張 REQUEST_TEXT に `--mode review`（engine は実装者の逆）のディレクティブを含め、実装者がレビュー依頼文へ転記する形でしか届かない
    - **レビュアー宛ディレクティブを引用するときは宛先を語彙で明示する**。engine は `reviewer_engine` の明示値を使い、実装者との関係から計算しない
    - Phase B-R の spawn 経路は `review/code-review.json` の `reviewer_engine`（`claude` / `codex`）から依頼文へ埋め込む。欠落時（旧スキーマ）は注入しない。`--no-parallel` は起動プロンプト専用のスイッチで、レビュー依頼文の注入判定には使わない
    - **`--no-parallel` はテスト基盤としても load-bearing**。`test/test-launch-workspace-review-config.sh` が起動プロンプト側の注入を止めてレビュー依頼文側の注入だけを切り分けるために渡している（`PARALLEL EXECUTION` が見つかったら必ずレビュー依頼文由来と言える状態を作っている）。フラグを削るなら同等の切り分け手段を別途用意すること
    - `--agents` / `--no-parallel` は `launch-workspace.sh` のスクリプトレベルのフラグで、SKILL.md の起動例はどちらも渡さない。対応する `config.json` キーも無い。README にはスキルが公開していない旨と、手動起動が唯一の手段である旨を書く
    - 回帰は `bash test/test-parallel-directive.sh`（PD1-PD7）、`bash test/test-launch-workspace-codex.sh`（PL1-PL10）、`bash test/test-launch-workspace-review-config.sh`（PR1-PR3）で検証する

28. **設定の明示 setup / reset**が SKILL.md / guide-ja.md / README.md / CLAUDE.md の 4 ファイルで一致しているか確認:
    - `--setup` と `--reset [runners|config|all]` は引数レベルのフラグで、実行時 SoT は `references/setup-mode.md`（日本語版 `setup-mode-ja.md`）。SKILL.md 側は `## Setup Mode` / `## Reset Mode` の短い委譲節だけを持ち、詳細を二重管理しない。`argument-hint` にも両方を書く
    - **どちらもディスパッチしない**。タスク・worktree・workspace・ペインを作らず、`.dispatch/` / worktree / `feat/*` ブランチを削除しない（削除はディスパッチ末尾の Cleanup prompts の担当）。`--setup` / `--reset` が Step 1a のタスク解析へ落ちてタスク名として扱われないこと。`--loop` とも互いとも排他で、issue ループの lock-check が生きている間は両方とも拒否すること
    - config の書き込みは **`scripts/config-edit.sh` だけ**を通す。allowlist は `review_mode`、`runner.<role>.runner`、`runner.<role>.model`、`runner.<role>.effort`、unset 専用の `runner.<role>` / `runner`。未知キー・不正値は exit 2、壊れた JSON は exit 1 で元ファイルを保持する
    - config target では最初に `review_mode` と 4 ロールの multiSelect を聞き、選んだロールごとに runner / model / effort を 1 コールで聞く。runner 変更後の engine で pending tuple 全体を再検証し、2 回目も不正ならそのロールの変更全体を破棄する
    - registry target の S3 は runner を追加 / registry を作り直す / そのままの 3 択。model / effort は config のロール tuple にだけ書く
    - `--reset runners` は registry だけを作り直し、両 config を変更しない。`--reset config` は選んだ layer に `--unset review_mode --unset runner` を 1 回適用する。`--reset all` は両 layer の 2 キーを消して registry と初期 global config を再生成する
    - **`.dispatch/config.json` はプロジェクト config レイヤーであってディスパッチの生成物ではない**。cleanup の一括削除は `find .dispatch -mindepth 1 -maxdepth 1 ! -name config.json -exec rm -rf {} +` で `config.json` だけを残すこと（素の `rm -rf .dispatch/` に戻すとプロジェクト config が毎回消える）。この掃き出しも従来どおり直前の lock-check ガードの内側に置くこと
    - setup-mode.md / setup-mode-ja.md の入口表、pending tuple、S7 の原子的書き込み契約を英日で同期する。回帰は `test-config-edit.sh` / `test-setup-skill.sh` / `test-input-validation.sh` で検証する

44. **`--override`**が SKILL.md / guide-ja.md / README.md / CLAUDE.md で一致しているか確認:
    - `argument-hint` に `--override` があり、`--loop` / `--setup` / `--reset` との排他が
      4 ファイルすべてで同じ理由（`--loop` は無人実行で対話できない）とともに書かれていること
    - 4 ロールを対象とし、review 2 ロールは `review_mode=on` の場合だけ表示する。Call 3 は role ごとに runner / model / effort を聞く
    - pending tuple は runner 変更後の engine で 3 次元を再検証し、不正な次元だけを再質問する。2 回目も不正なら role 全体を破棄する
    - 受理値は `override-args.sh` を通してから `config-resolve.sh --set` へ渡す。precedence は override → project → global → built-in。config / registry へ書き戻さず `config-edit.sh` を呼ばない
    - 回帰は `bash test/test-override.sh` と `bash test/test-override-args.sh` で検証する

45. **readiness の 3 要件と fail-fast** が SKILL.md / guide-ja.md / README.md / CLAUDE.md で一致しているか確認。ペインが配送先になれるのは次の 3 つが揃ったときだけである:
    1. team に join 済み（`join.sh <team> <name> <type> <cwd>`）
    2. そのプロジェクトが monitor モード（`delivery.sh set monitor <type> <cwd>`）
    3. ペインが初回ターンを 1 回持った — claude なら Monitor tool が起動して `run/watch.<session_id>.pid` が出る、codex なら bridge が起動して `run/codex-bridge.<team>.<agent>.thread` に seat が記録される
    <!-- stale-vocab-exempt: ready.<team>__<agent> — 次の行は「その sentinel は実在しない」という否定の事実 (spec B5) を固定するためのもの。名前を出さないと何が実在しないのか書けない。 -->
    - **claude 子の readiness は親から観測できない**。`run/watch.<session_id>.pid` は session id キーで、親はその session id を知らない。`ready.<team>__<agent>` sentinel は agmsg 1.2.1 の `watch.sh` に書くコードが無く実在しない（`docs/superpowers/specs/2026-08-21-agmsg-monitor-only-design.md` の B5）。したがって **`[ready] <name>` の自己申告が唯一の手段**であり、「親の watcher が生きていれば inbox にも記録される」という旧記述は成立しないので 4 ファイルのどこにも書かないこと
    - codex 子だけは team/agent キーなので親から観測でき、`verify-agmsg-ready.sh --codex --team <t> --name <agent>` で「seat 未記録」と「ペイン死亡」を切り分けられる
    - readiness が確立しないペインへは**配送せず fail-fast する**。`prewarm-panes.sh` は `--agmsg-team` 必須でペインを作る前に die し、`launch-workspace.sh` は `--status-dir` / `--review-config` があるとき `--agmsg-team` / `--agmsg-from` を必須にする。`--parent-notify-workspace` / `--parent-notify-surface` はこの die 条件に**入れない**（`cmux notify` 専用の別機構）
    - 回帰は `bash test/test-verify-agmsg-ready.sh`（VR1-VR8）、`bash test/test-agmsg-guard-block.sh`、`bash test/test-prewarm-layout.sh`、`bash test/test-launch-workspace-review-config.sh`（T11 = `--parent-notify-*` だけでは die しない）で検証する

46. **公開・実行時ドキュメントの旧語彙**が残っていないことを `bash test/test-doc-stale-vocab.sh`（DS1-DS3）で確認する。対象は日本語 3 ファイルに加え、英語の `SKILL.md` と `references/unattended/*.md`、通知履歴である。DS1 は退役済みスクリプト名、DS2 は旧設定・旧ロール・旧分岐の語彙、DS3 は対象と needle のラチェットを固定する。**意図的な履歴記述**は行内・直前行の `stale-vocab-exempt:` マーカーで除外する（`docs/notification-gaps.md` の履歴表がその用途）

47. **退役候補（まだ削除していない死んだコード）** を把握しておくこと。どれも動作には影響しないが、次に触るときに一緒に消せるよう記録する:
    - registry の model / effort を直接編集していた旧スクリプトと setup / override の writer 分岐は削除済み。role tuple の更新経路は `config-edit.sh` / `config-resolve.sh` / `override-args.sh` だけを維持する
    - `--parent-notify-surface` はこの表からは外れた: `launch-workspace.sh` / `prewarm-panes.sh` とも `was removed` を含む die で明示的に拒否するようになり、`NOTIFY_SURFACE` / `NOTIFY_SF` への読み手なし配線は無くなった。SKILL.md の起動例にも残っていない。`--parent-notify-workspace` は `cmux notify --workspace` のために引き続き必須で現役
    - `prewarm-panes.sh` の `[[ -n "$AGMSG_TEAM" ]]` 分岐: `--agmsg-team` 必須化（引数パース直後の die）以降、後続 9 箇所のこの条件は**常に真**。挙動を変えない純粋なリファクタなので、まとめて外すのは別タスクで行う。die の直後と 9 箇所それぞれに 1 行コメントを置いてある
    - **現地コメントは必ず本項目を参照させること**（`# 退役候補 (CLAUDE.md 項目 47)`）。参照が無いと、次に読んだ人が「消し忘れ」なのか「意図して残した」のか判別できず、勝手に消すか永遠に残すかのどちらかになる

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
10. **委譲実行 (claude)**:
    - 待機中の `exec` ペインに実行指示が送られ、設定された runner / model / effort で Phase B が始まること
    - Child が `<STATUS_DIR>/.deferred` を touch して exit すること
    - Child の runner wrapper が `.deferred` を検知し、`status.json` を上書きせず exit すること
    - prewarm 済み Claude exec が terminal status と `dispatch-notify:` を書いてから `/exit` すること
11. **委譲実行 (codex)**: prewarm 済み Codex exec が `phase-b-exec:` を受け、terminal status と `dispatch-notify:` を書いたあと idle のまま待つこと。自分で session を終了せず、親の final cleanup が pane を閉じること
12. **単発タイマーの wake で状態を再導出する**: ペイン起動直後に 90 分の単発タイマーが 1 つだけ武装されること（ループでないこと）。タイマーで起きたら `.dispatch/*/status.json` を全部読み直して状態を再導出し、`[ready]` の確認は `history.sh <team> parent N` で行い（`inbox.sh` を使わないこと）、`[ready] <slug>` を行末までアンカーして照合すること。再武装は 3 回上限で、上限に達したら `cmux read-screen` の抜粋付きで報告すること。Completion でタイマーが止まること（止め忘れると 90 分後に無関係な会話へ発火する）
13. **長文と貼り付け事故が起きないこと**: 完了通知も長いレビュー依頼文も親／レビュアーの inbox に丸ごと 1 メッセージとして着き、input box に何も残らないこと（agmsg 配送は TUI の貼り付け判定を受けないため、outbox 退避も Enter 再送も不要になっている）
14. **自分の watcher が死んだときの検知**: ディスパッチ中に親の agmsg watcher を kill すると、次の起床（またはタイマー発火）の `verify-agmsg-ready.sh --self` が `ready=no` / exit 1 を返し、親が「通知が来ないことは子についての情報ではない」と報告すること
15. **重複通知の冪等性**: 子自身の通知・status.json watcher・runner wrapper の exit 時通知で同じ完了が複数回届いても、`status.json` を信頼して 1 件として扱い、Template B が二重に出ないこと
16. **message_type 廃止**: 通知トランスポートの質問が一切出ないこと。`config.json` に `message_type` を書いても無視されること。`launch-workspace.sh` / `prewarm-panes.sh` に `--message-type` を渡すと `was removed` で即座に失敗すること
17. **agmsg 不在・watcher 不在は fail-fast**: `~/.agents/skills/agmsg/scripts/send.sh` が無い状態でスキルを起動するとディスパッチが始まらずエラー報告で止まること。claude 親で Monitor watcher が無い（`verify-agmsg-ready.sh --self` が exit 1）ときも、codex 親で bridge seat が未記録（`--codex --team <t> --name parent` が exit 1）のときも同様に止まること。**使用法エラー（exit 2）を「watcher が無い」と報告しない**こと。また、**ペインは `[ready] <name>` を送ってはじめて配送対象になる**こと: `[ready]` 前にタスクを送らず、`[ready]` の起床で初めて Phase A タスクが配送されること（`[ready]` をポーリングで待たないこと）
18. **pre-warm**: `review_mode=off` は `design` / `exec` の 2 ペイン、`review_mode=on` は `design` / `design_review` / `exec` / `exec_review` の 4 ペインだけを起動すること。`prewarm.json` はこのロールキーだけを持ち、全 consumer が同じ検証済みスナップショットを読むこと
19. **Phase B 経路**: `prewarm.json.exec` の固定ペインへ `phase-b-exec:` を配送し、design ペインは `.deferred` を作って終了すること
20. **レビュー無効**: `review_mode=off` では review 2 ロールを解決・起動せず、レビュー質問も出さないこと
21. **Phase A-R 有効**: `design_review` が Phase A-R だけを担当すること。launch または readiness で同ロールが脱落した場合は警告して Phase A-R だけを省略し、config を書き換えないこと
22. **レビューループ**: plan モードで plan 完成後に 1 回、superpowers モードで spec 後 + plan 後の 2 回レビューが `design_review` で走ること。needs_work は設計セッションが修正して同じ `design_review` へ再依頼する。Phase B-R は別の `exec_review` が担当すること
23. **verdict プロトコル**: `.dispatch/<slug>/review/<point>-round-<N>.md` が生成され、末尾に `VERDICT:` 行があること。**待機側はポーリングせず**、レビュアーが findings ファイルを書いた直後に送る `review-verdict:` メッセージで起床すること。待機側が単発 safety timer を 1 つだけ武装していること（ループでないこと）。verdict を処理したらタイマーが止まること。`review-verdict:` メッセージが来たのに verdict 行が無ければ `needs_work` 扱い、**verdict 行の無いタイマー起床は verdict として扱われない**こと
24. **review_mode 解決**: project → global → built-in の順で `on` / `off` を解決し、dispatch 中に質問や永続化を行わないこと
25. **status 非汚染**: prewarm 済み review ペインの存在が他ロールの `.assigned-*` / status.json に影響しないこと。review pane は status 所有者にならず、ready にならない review role は回収・prune 後に当該 gate だけを省略すること
26. **ロール別 model / effort**: 4 ロールの各 field が override → project → global → built-in で独立に合成され、解決した runner の engine に対して検証・注入されること
27. **readiness が確立しないペインには配送せず fail-fast する**: `prewarm-panes.sh` を `--agmsg-team` 無しで呼ぶとペインを 1 つも作らずに die すること。`launch-workspace.sh` を `--status-dir` 付き・`--agmsg-*` 無しで呼んでも die すること（`--parent-notify-*` だけでは die しないこと — こちらは `cmux notify` 専用の別機構）。`join.sh` / `delivery.sh set` が失敗したときも worktree 作成前に落ちて孤児 worktree / team member を残さないこと。`[ready]` を送らないペインへメッセージを送っても inbox に未読で残るだけで誰も起きないので、親は `[ready]` を待ってから送ること
28. **plan モード遵守ゲート**: plan モード子セッションで ExitPlanMode 承認後、ファイル編集前に Phase A-R（有効時）→ Phase B の task prompt 解決済み方式が走ること。worktree に `.claude/settings.local.json` が生成され、settings と `.claude/plans/` 配下の plan ファイルのどちらも `git status` に現れないこと。superpowers モードの worktree には hook が注入されないこと。既存の `.claude/settings.local.json` がある worktree では既存キーが保持されたままマージされること
29. **Phase B-R fixed**: 実装 runner / engine にかかわらず `exec_review` が code review を担当し、`design_review` と design pane は code reviewer にならないこと
31. **Phase B-R gate**: `review_mode=off` または `exec_review` が launch / readiness 後に残らない場合、`review-gate.sh` は stdout と `code-review.json` の両方を省略すること。Phase B は同じ prewarm 済み exec へ配送され、review protocol だけを含めないこと
32. **effort 注入（両 engine）**: 各ロールの解決済み effort が claude / codex の allowlist で検証され、対応する起動フラグへ注入されること
33. **完走ゲート**: 4 ロールとも Stop hook (`completion-gate.sh`) が注入され、判定がディスクだけを読むこと。**「待って良い状態」を block しない**こと — タスク未着（`design`/`exec` は `.assigned-<agent>` 無し、review ロールは `review/*round*.md` 無し）と verdict 待ち（依頼側で `VERDICT:` 行が無い）は停止を許す。レビュアーは同じ「`VERDICT:` 行が無い」状態で逆に block する（自分がまだ書いていない意味だから）。連続 block に**既定の上限は無い**こと — 有限の上限は「まだ終わっていない長いタスク」を殺す（上限に達した block はカウンタを保持したまま諦め、カウンタを消せるのは判定 1-5 の allow だけなので、実装中の exec はどの allow にも二度と当たらず以後永久に毎ターン停止する。2026-08-25 に実ペインで観測）。`DISPATCH_GATE_MAX_BLOCKS` に正の数を入れたときだけ上限が働き、カウンタは `<status-dir>/.gate-blocks-<role>` と**ロールごとに分ける**こと（4 ロールが 1 つの status dir を共有するので、1 ファイルだと「4 ペイン合計で上限」になる）。上限有効時は**上限到達でカウンタを消さない**こと（消すと即座に再武装され「上限まで block → 1 回休み」を繰り返す）。**ロールを hook の command に焼き込まない**こと — 4 ロールは 1 worktree を共有し engine ごとの hook ファイルは 1 本なので、焼き込むと 2 ロール目が 1 ロール目のゲートを実行する（2026-08-25 実測: `exec_review` が `design` のゲートで動いた）。値は runner script が `DISPATCH_GATE_ROLE` / `DISPATCH_GATE_AGENT` / `DISPATCH_GATE_STATUS_DIR` / `DISPATCH_GATE_TEAM` として export し、gate が引数の無いときに読むこと（command 内の `'$VAR'` は hook 実行時にも展開されないので代替にならない）。**identity が揃わなければ fail-open** で `exit 0` かつ stdout 無出力にすること（Claude Code の Stop hook では `exit 2` は blocking error であって no-op ではない）。注入は**既存のゲート entry を除去してから 1 本足す**こと — これで worktree 再利用の二重注入と 3.6.0 以前の焼き込み entry の migration が同時に片づく。ベストエフォートで、`.codex/hooks.json` は agmsg の entry とマージし `info/exclude` に入ること
34. **4 ロールすべて codex のディスパッチ**: review 有効時も 4 ロールそれぞれの固定ペインが起動し、claude ペインが 0 件であること
35. **同一Codex Phase A-R**: codex design の plan/spec を codex `design_review` ペインがレビューできること
36. **fixed Phase B**: codex `exec` ペインへ委譲し、codex `exec_review` ペインが B-R を担当すること
37. **review role 脱落**: launch または readiness で脱落した review role を警告・回収・prune し、その role の gate だけを省略すること。design / exec の脱落とは混同しないこと
39. **codex 起動安全性**: superpowers は bypass で approval prompt を出さず、review は `--sandbox workspace-write` + `-c approval_policy='never'` に加え `--add-dir <STATUS_DIR>/review` / `--add-dir <AGMSG_SKILL_DIR>/run` / `--add-dir <AGMSG_SKILL_DIR>/db` の3本だけを条件付きで併用すること
40. **pane close の誤通知**: 全タスク完了後のクリーンアップで standby / 実装ペインを閉じたとき、`[dispatch] task ... finished (status: error)` が親へ飛ばないこと、`status.json` の `done` が保持されること。`executing` 中の pane を閉じた場合は従来どおり `error` 通知が飛ぶこと。`bash test/test-runner-signal-exit.sh` の動的検査を実行すること
41. **タスク内の並列実行**: plan / superpowers / execute で起動した子セッションのプロンプトに `PARALLEL EXECUTION, mandatory` が含まれること。codex には `spawn_agent`、claude には Task サブエージェントの指示が届くこと。standby / review の起動コマンドには含まれず、親が送る実行指示・レビュー依頼側に含まれること。`--no-parallel` で起動プロンプトから消えること
42. **最終クリーンアップの pane close**: `cmux close-surface --workspace` が、検証済み `prewarm.json` に記録された 2 または 4 ロールの surface だけを閉じること
43. **`--setup` / `--reset`**: どちらもディスパッチしないこと。config target は `review_mode` と 4 ロールを multiSelect し、各ロールの runner / model / effort を 1 コールで質問すること。registry target は追加 / 作り直す / そのままの 3 択だけで、model / effort を編集しないこと。config の更新は `config-edit.sh` だけを使い、reset は `review_mode` と `runner` の 2 キーを消すこと
45. **`--override`**: タスク一覧 → 対象タスク → 役割 → runner/model/effort の順に質問が出て、
    review 有効時だけ review 2 ロールを表示し、各ロールの runner / model / effort を 1 コールで質問すること。pending tuple を再検証し、override → project → global → built-in の順で field ごとに合成すること。dispatch 後に両 `config.json` と registry が変化せず、`config-edit.sh` を呼ばないこと
46. **readiness と fail-fast**: agmsg 未インストール、または親の watcher / bridge seat が無い状態でスキルを起動すると、ペインを 1 つも作らずエラーで止まること。ペインは `[ready] <name>` を送ってはじめて配送対象になり、親は `[ready]` の起床で初めて Phase A タスクを送ること（`[ready]` をポーリングしないこと）。claude 子の readiness は親から観測できず `[ready]` が唯一の手段であること、codex 子は `verify-agmsg-ready.sh --codex` で seat を確認できることを実機で確かめる
# GitHub issue 自動ループの保守

`--loop` の仕様は `skills/cmux-team-dispatch-task/references/loop-mode.md` を正本とする。loop CLI、プロンプト、起動フラグを変更するときは SKILL.md、guide-ja.md、README.md、CLAUDE.md を同時に更新し、`.dispatch-loop/` の owner lock と timeout sentinel の契約を維持する。renderer header は `design` / `design_review` / `exec` / `exec_review` の解決済み tuple を一度だけ出し、review 無効時に review fields を要求しない。timeout sentinel と cleanup は検証済み `prewarm.json` に生成された role だけを対象にする。
