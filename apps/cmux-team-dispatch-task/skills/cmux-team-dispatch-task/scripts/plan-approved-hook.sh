#!/usr/bin/env zsh
# ExitPlanMode PostToolUse hook — plan モード子セッション専用。
#
# 標準 plan モードでは ExitPlanMode 承認直後に「プランを実行せよ」という強い
# システム指示が recency 優先で入り、プロンプト焼き込みの MANDATORY MODEL
# SELECTION SEQUENCE (Phase A-R / Phase B) がスキップされることがある。
# この hook は承認直後のタイミングで additionalContext を注入し、
# ファイル編集前に Phase A-R (有効時) → Phase B を強制的に再想起させる。
#
# launch-workspace.sh が --mode plan + claude engine のときのみ、worktree の
# .claude/settings.local.json にこのスクリプトを登録する。
# stdin の hook 入力 JSON は使用しないため読み捨てる。

cat <<'EOF'
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "[cmux-team-dispatch-task] The plan was just approved. STOP — do NOT edit any files yet. First: (1) save the plan to a file if not saved, (2) re-read the MANDATORY MODEL SELECTION SEQUENCE in .cmux-team-dispatch-task-prompt.md and execute Phase A-R (if the REVIEW block is present) then Phase B (model selection via AskUserQuestion) NOW."
  }
}
EOF
