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
| `skills/cmux-team-dispatch-task/scripts/monitor-dispatch.sh` | 完了通知の監視スクリプト（子 → 親通知＋全完了検知） |
| `skills/cmux-team-dispatch-task/scripts/cmux-grid.sh` | split モード用グリッドレイアウト整列スクリプト |
| `skills/cmux-team-dispatch-task/scripts/terminal-wait.sh` | シェル起動検知と `shell_ready_ms` 学習を行う共通ヘルパー（source 専用） |
| `~/.claude/cmux-team-dispatch-task/config.json` | グローバル設定（自動生成）。`shell_ready_ms.baseline_ms`（EMA 学習値）、`message_type`（通知トランスポート）、`prewarm`（standby tab 事前起動） |
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
10. `runners.json` のスキーマ（`default` / `runners[].name|command|engine`）が SKILL.md Step 1f / guide-ja.md「子セッション runner 設定」/ `launch-workspace.sh` の `--runner` 解決ロジックの3か所で一致しているか確認。特に `engine × MODE` の起動コマンド対応表（claude/codex × plan/superpowers/execute の6通り）が SKILL.md と guide-ja.md で同一か検証。なお composed command は常に `zsh -ic "..."` で wrap される（`.zshrc` の関数 / env を読み込むため）
11. `launch-workspace.sh` の execute モード関連フラグ（`--mode execute` / `--plan-file` / `--model` / `--skip-permissions` / `--defer-status`）が SKILL.md / guide-ja.md / README.md の Phase B 説明と一致しているか確認。Child 側 (launch-session-splits.sh) が `--defer-status` を必ず付けて起動していること、孫側 (Phase B spawn) が `--mode execute` + `--plan-file` で起動していることを検証
12. `message_type`（`send-message` / `agmsg`）の解決フロー（Step 1g: config 優先 → agmsg インストール時のみ初回質問 → Yes/No とも永続化）が SKILL.md / guide-ja.md / README.md で一致しているか確認。agmsg モードでは monitor-dispatch.sh を起動しないこと、runner wrapper の親通知が `send.sh <team> <from> parent` に切り替わること、status.json / signal は不変であることを検証
13. pre-warm（`--mode standby` / `--standby-in` / `.assigned` sentinel / prewarm.json スキーマ / signal 名 `<slug>-sonnet-done`）が SKILL.md / guide-ja.md / README.md で一致しているか確認。standby wrapper が起動時・未 assigned exit 時に status.json を書かないこと、standby（sonnet / codex とも）への実行指示が message_type に関わらず常に `cmux send` であること（standby の worktree には agmsg delivery 配線が無いため）、Phase B の手順が「未使用側 tab を close → `.assigned` touch → 実行指示送信 → `.deferred` touch」の順であることを検証

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
17. **agmsg モード**: monitor-dispatch.sh が起動しないこと。子の完了時に agmsg push で `[dispatch] task ... finished` が親に届くこと。status.json は従来どおり遷移すること
18. **pre-warm**: workspace レイアウトで各タスク workspace に `<slug>-sonnet` tab（codex runner があれば `<slug>-codex` tab も）が起動すること。`prewarm: false` / split レイアウトでは起動しないこと
19. **Phase B prewarm 経路**: sonnet 選択 → 未使用側 (codex) standby tab が先に close され、`.assigned` が touch され、待機 tab へ実行指示が（message_type に関わらず常に `cmux send` で）送信され、実装完了 exit 時に standby wrapper が status.json を done にし `<slug>-sonnet-done` signal + 親通知が発火すること。opus 1m 選択 → 全 standby tab が close され status.json が汚れないこと。prewarm.json が無い場合は従来の spawn にフォールバックすること
