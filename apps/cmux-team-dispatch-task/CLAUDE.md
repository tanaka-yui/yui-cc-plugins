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
| `~/.claude/cmux-team-dispatch-task/config.json` | グローバル学習値（自動生成）。`shell_ready_ms.baseline_ms` を EMA で更新 |
| `~/.claude/cmux-team-dispatch-task/runners.json` | 子セッション runtime 一覧（初回セットアップで生成）。SKILL.md Step 1f で読込 |
| `<project>/.dispatch/config.json` | プロジェクト固有の上書き（手動配置）。存在時はグローバルより優先 |
| `.claude-plugin/plugin.json` | Plugin マニフェスト |
| `README.md` | 人間向けガイド |
| `CLAUDE.md` | この開発ガイド |
| `LICENSE` | MIT ライセンス |

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
- **モデル選択フロー（MANDATORY MODEL SELECTION SEQUENCE）の改変時** は SKILL.md / guide-ja.md / 子セッションプロンプトの3か所を同時に更新する

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
8. モデル選択フロー（MANDATORY MODEL SELECTION SEQUENCE）が SKILL.md / guide-ja.md で同じ選択肢（opus 1m / sonnet / codex）と挙動を記述しているか確認
9. `cmux send` で親に通知する箇所すべてに `cmux send-key return` がペアで発行されているか確認（runner / monitor 両方）
10. `runners.json` のスキーマ（`default` / `runners[].name|command|engine|use_zsh`）が SKILL.md Step 1f / guide-ja.md「子セッション runner 設定」/ `launch-workspace.sh` の `--runner` 解決ロジックの3か所で一致しているか確認。特に `engine × MODE` の起動コマンド対応表（claude/codex × plan/superpowers の4通り）が SKILL.md と guide-ja.md で同一か検証

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
8. **モデル選択**: 子セッションが Phase A 完了後に AskUserQuestion で opus 1m / sonnet / codex の3択を必ず出すこと
9. **codex 引き継ぎ**: codex を選択すると同一 workspace に split pane が生成され、`codex` コマンド実行で claude session が引き継がれること（`cmux codex install-hooks` が前提）
10. **monitor heartbeat**: `monitor-dispatch.sh` から60秒おきに `[dispatch-monitor] alive | loop=N | ...` が親に届くこと
11. **Enter 自動押下**: 親が claude TUI でも、完了通知が input box に残らず自動で読み取られること（`cmux send` の後に `cmux send-key return` が発行される）
12. **死亡検知**: monitor を `kill` した直後に `[dispatch-monitor] DIED ...` メッセージが親に届くこと
13. **`--resume`**: 既存の `.dispatch/` がある状態で monitor を `--resume` 起動 → 完了済みは skip、未完了のみ監視継続すること
