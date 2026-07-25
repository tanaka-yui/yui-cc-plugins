# GitHub issue 自動ループ

`--loop` が唯一の機械的 entry point である。自然言語でループ実行を明示された場合も、開始前に確認する。通常の issue 言及だけでは発動しない。

## L0: read-only 確認

依存関係（`gh auth status`、`jq`、cmux、runners.json）を確認し、開始前に次を実行する。

```bash
bash scripts/issue-fetch.sh --state-file .dispatch-loop/loop-state.json lock-check
```

## L1–L3

開始前に、concurrency / max_batches / integration、design runner / execution choice / review、task_timeout_min / lock_lease_min を一括で確認する。設定確定後に `lock-acquire --lease-min <N>`、`init --config-json <json> --filter-json <json>`、`reconcile`、通常 dispatch の stale 痕跡検査、`ensure-labels` を順に実行する。`reconcile` が abort なら `lock-release` して中止する。

各バッチは `fetch --limit <N> --batch <N>` で claim し、各 issue を次の完全形で準備する。

```bash
bash scripts/render-loop-prompt.sh --slug "$SLUG" --issue "$N" --issue-title "$TITLE" --issue-url "$URL" --issue-body-file "$BODY" --plan-hint ".claude/plans/$SLUG.md" --exec-choice "$EXEC_CHOICE" --design-engine "$DESIGN_ENGINE" --review "$REVIEW" --status-dir "$REPO/.dispatch/$SLUG" --timeout-sentinel "$REPO/.dispatch-loop/timed-out/$SLUG" --team "$TEAM" --layout workspace --parent-workspace "$CMUX_WORKSPACE_ID" --skill-dir "$SKILL_DIR" > "$REPO/.worktrees/$SLUG/.cmux-team-dispatch-task-prompt.md"

bash scripts/prewarm-panes.sh --with-opus --message-type agmsg --agmsg-team "$TEAM" --cwd "$REPO/.worktrees/$SLUG" --slug "$SLUG" --status-dir "$REPO/.dispatch/$SLUG" --unattended --timeout-sentinel "$REPO/.dispatch-loop/timed-out/$SLUG" --parent-notify-workspace "$CMUX_WORKSPACE_ID"
```

起動後に `mark-dispatched` を実行する。`batch-wait.sh --state-file <path> --batch <N> --timeout-min <N>` は `ALL_TERMINAL` のときだけ待機完了であり、`WAITING` は再実行する。最後に `loop-cleanup.sh --state-file <path> --batch <N> --integration <pr|merge>` を実行する。exit 3/4、cleanup 失敗、ユーザー中断を含む全中断経路で `lock-release` を呼ぶ。

`fetch` の `[]` は正常終了、exit 3 は claim 全滅、exit 4 は exhaustion unknown なのでいずれも次の batch を開始しない。フォールバックは claude design→opus、execution→sonnet、review→off の順に固定し、質問はしない。label は claim 時 `dispatch/in-progress`、完了検証後に `dispatch/done`、失敗・timeout・conflict は `dispatch/failed` へ遷移する。cleanup は成功時のみ worktree/branch/.dispatch を削除し、merge conflict、保全失敗、terminal label 失敗ではすべて温存する。

ループ制御状態は `.dispatch-loop/` に残す。`leaked[]` と stale lock は手動確認後に削除する。ラベルは in-progress → done/failed の順に遷移し、terminal ラベルを先に付ける。
