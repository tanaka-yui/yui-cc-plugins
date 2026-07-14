# plan モード子セッションの Phase A-R / Phase B 遵守ゲート — 設計

- 日付: 2026-07-15
- 対象: `apps/cmux-team-dispatch-task`
- ステータス: 承認済み

## 問題

`--mode plan` で起動された子セッション（claude engine）は、Claude Code 標準の plan モードで plan を作成する。plan 完成時に標準の ExitPlanMode 承認プロンプトが出て、ユーザーが承認すると子セッションは**そのまま実装に突入**し、`.cmux-team-dispatch-task-prompt.md` に焼き込まれた MANDATORY MODEL SELECTION SEQUENCE のうち以下がスキップされる:

- Phase A-R — codex による plan レビュー（有効時）
- Phase B — 実行モデル選択の AskUserQuestion

根本原因: ExitPlanMode 承認直後に「プランを実行せよ」という強いシステム指示が recency 優先で入り、セッション冒頭に焼き込んだプロンプト指示が負ける。現状の遵守機構はプロンプト焼き込みのみで、機械的な強制手段が存在しない。

## 決定事項

- 期待フロー: 標準の plan 承認プロンプトは残す。**承認後、ファイル編集より前に** Phase A-R（有効時）→ Phase B が必ず走ること
- 対象範囲: **claude runner のみ**（codex engine の plan モードは別件として切り分け）
- 採用アプローチ: **A + B 併用**（B が本命、A はフォールバック兼フロー整合）
- 不採用: 案 C（PreToolUse による Edit/Write ハード遮断）— 正当な書き込みまで塞ぐ許可リスト設計が複雑化し、sentinel 作成漏れでデッドロックのリスクがあるため

## 対策 A: plan 自体に Phase A-R / B を組み込ませる（プロンプト再構成）

SKILL.md の MANDATORY MODEL SELECTION SEQUENCE テンプレートに plan モード専用の指示を追加する:

1. **plan 作成時の必須ステップ指示**: Phase A の plan モード説明部に「作成する plan の冒頭に、実装ステップより前の必須ステップとして『Step 0: Phase A-R codex レビュー（有効時）』『Step 1: Phase B 実行モデル選択（AskUserQuestion）』を必ず記載せよ」を追記。承認された plan の実行そのものが Phase A-R / B から始まる構造にし、標準 plan モードの「承認→即実行」フローと整合させる。
2. **承認直後の再確認指示**: VIOLATION 節の近くに「ExitPlanMode の承認が下りても、ファイル編集を開始する前に必ず `.cmux-team-dispatch-task-prompt.md` の本シーケンスに戻り、Phase A-R（有効時）→ Phase B を完了せよ。plan をまだファイルに保存していなければ、承認後最初の作業として保存せよ」を追加。Phase B の execute 移譲は `--plan-file <path>` を要求するため、plan のファイル保存を明文化する。

変更対象はテンプレート文言のみ（対策 A 単体ではスクリプト変更なし）。

## 対策 B: ExitPlanMode hook による機械的注入

### 新規ファイル `skills/cmux-team-dispatch-task/scripts/plan-approved-hook.sh`

PostToolUse hook として呼ばれ、stdout に以下の JSON を出力する:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "[cmux-team-dispatch-task] The plan was just approved. STOP — do NOT edit any files yet. First: (1) save the plan to a file if not saved, (2) re-read the MANDATORY MODEL SELECTION SEQUENCE in .cmux-team-dispatch-task-prompt.md and execute Phase A-R (if the REVIEW block is present) then Phase B (model selection via AskUserQuestion) NOW."
  }
}
```

メッセージは**汎用**とし、dispatch ごとの REVIEW_ENABLED 状態を hook に焼き込まない。有効/無効の分岐は prompt.md 側の `{{REVIEW_BLOCK}}` 有無がそのまま担う。

### `launch-workspace.sh` の変更

worktree 作成後（Step 2 プロンプト書き込みの近く）に以下を追加:

1. 条件: `MODE == "plan"` かつ `RUNNER_ENGINE == "claude"` のときのみ
2. `$CWD/.claude/settings.local.json` に PostToolUse hook（matcher: `ExitPlanMode`、command: `zsh <skill-dir>/scripts/plan-approved-hook.sh` の絶対パス）を書き込む
   - 既存の settings.local.json がある場合は `jq` で `hooks.PostToolUse` 配列に追記マージ
   - マージ失敗時は警告ログを出して**スキップ**（hook はベストエフォート、dispatch を止めない — 対策 A がフォールバック）
3. 誤コミット防止: `git -C "$CWD" rev-parse --git-path info/exclude` で解決したパスに `.claude/settings.local.json` が未記載なら追記
   - `info/exclude` は worktree 間で共有されるためメインリポジトリ側でも ignore されるが、このファイルは元々ローカル専用（Claude Code 自身が gitignore を推奨）であり実害なしと判断

### スコープ外

- codex engine の plan モード
- split レイアウト特有の対応（hook は worktree 単位なので layout に依存しない）
- 案 C のハード遮断

## エラーハンドリング方針

hook 書き込み失敗・jq マージ失敗は警告ログのみで dispatch 続行する。品質ゲートであって起動ブロッカーにしない（Phase A-R の spawn 失敗時と同じ思想）。

## ドキュメント同期

MANDATORY MODEL SELECTION SEQUENCE 改変にあたるため、プラグインの絶対ルールに従い 4 ファイルを同時更新する:

- `skills/cmux-team-dispatch-task/SKILL.md` — テンプレート修正（対策 A）+ hook 機構の説明追記（SoT）
- `skills/cmux-team-dispatch-task/references/guide-ja.md` — 同内容の日本語リファレンス反映
- `README.md` — plan モードのフロー説明に Phase A-R / B 遵守の仕組みを追記
- `CLAUDE.md` — メンテナンス手順に hook の整合性検証項目、E2E テスト項目 28 を追加

E2E テスト項目 28（CLAUDE.md へ追加する内容）:

- plan モード子セッションで ExitPlanMode 承認後、ファイル編集前に Phase A-R（有効時）→ Phase B の質問が出ること
- worktree の `.claude/settings.local.json` が生成され、`git status` に現れないこと
- superpowers モードの挙動が不変であること（hook 注入は plan モードのみ）

## バージョン

挙動修正 + 新スクリプト追加のため **1.6.0**。`apps/cmux-team-dispatch-task/.claude-plugin/plugin.json` とルート `.claude-plugin/marketplace.json` を同期する。

## 検証方法

1. `plan-approved-hook.sh` の出力を `jq .` に通して JSON 妥当性を検証
2. `launch-workspace.sh --mode plan` をテスト用リポジトリで実行し、worktree に settings.local.json が正しく生成・マージされること、`git status` がクリーンであることを確認
3. E2E: plan モードで 1 タスク dispatch し、承認後に Phase A-R → Phase B の質問が出ることを確認
