#!/usr/bin/env bash
set -euo pipefail

# parallel-directive.sh — 子セッションへ渡す並列実行ディレクティブを 1 行で出力する。
#
# launch-workspace.sh が plan / superpowers / execute の起動プロンプトへ連結するほか、
# 親セッションが cmux send で送る実行指示・レビュー依頼にも同じ文面を含めさせる
# (SKILL.md 参照)。文面が各所へ散らないための単一情報源。
#
# 出力は zsh -ic "... '<prompt>' ..." という二重引用の内側に素で置かれる。
# launch-workspace.sh はエスケープを一切行わないため、' " ` $ ! \ を 1 文字も
# 含めてはならない (-i は対話モードなので history 展開が効き ! も特殊文字になる)。
#
# Usage: parallel-directive.sh --engine <claude|codex> --mode <plan|superpowers|execute|review> [--agents <N>]
#   --agents <N>  同時に走らせる子エージェントの上限 2..8 (default: 4)
#
# standby モードは実行系なので、呼び出し側が --mode execute を渡すこと。

ENGINE=""; MODE=""; AGENTS=4
while [[ $# -gt 0 ]]; do
  case "$1" in
    --engine)
      [[ $# -ge 2 ]] || { echo "parallel-directive: --engine requires a value" >&2; exit 1; }
      ENGINE="$2"; shift 2
      ;;
    --mode)
      [[ $# -ge 2 ]] || { echo "parallel-directive: --mode requires a value" >&2; exit 1; }
      MODE="$2"; shift 2
      ;;
    --agents)
      [[ $# -ge 2 ]] || { echo "parallel-directive: --agents requires a value" >&2; exit 1; }
      AGENTS="$2"; shift 2
      ;;
    *) echo "parallel-directive: unknown argument: $1" >&2; exit 1 ;;
  esac
done

[[ "$ENGINE" == "claude" || "$ENGINE" == "codex" ]] \
  || { echo "parallel-directive: --engine must be claude or codex" >&2; exit 1; }
case "$MODE" in
  plan|superpowers|execute|review) ;;
  *) echo "parallel-directive: --mode must be plan, superpowers, execute or review" >&2; exit 1 ;;
esac
[[ "$AGENTS" =~ ^[2-8]$ ]] \
  || { echo "parallel-directive: --agents must be an integer from 2 to 8" >&2; exit 1; }

# engine ごとの並列化機構
if [[ "$ENGINE" == "codex" ]]; then
  MECHANISM="you MUST fan them out with spawn_agent and collect them with wait_agent"
else
  MECHANISM="you MUST fan them out by launching several Task subagents in a single message"
fi

# mode ごとの分担
case "$MODE" in
  plan|superpowers)
    PHASES="Before you design anything, split the investigation across read-only child agents and run them at the same time: blast radius, existing implementation patterns, test layout, and related documentation. Merge their findings before you start writing the plan."
    ;;
  execute)
    PHASES="Right after you read the plan, split the investigation across read-only child agents and run them at the same time: blast radius, existing implementation patterns, test layout, and related documentation. Merge their findings before you edit anything. Once the implementation is finished, split verification the same way: type checking, linting, tests, and documentation consistency."
    ;;
  review)
    PHASES="Give each review lens its own child agent and run them at the same time: correctness and bugs, security, design and readability, and test coverage. Gather what they report, drop the duplicates, and present one review ordered by severity."
    ;;
esac

# 逐次を守らせる禁止文と superpowers への譲歩。engine / mode で出し分けない。
# codex も superpowers パイプラインを辿る (launch-workspace.sh の codex superpowers は
# プロンプトに superpowers:brainstorming を前置する) ため、claude 限定にすると漏れる。
GUARDRAIL="File edits stay in the parent agent and stay sequential. Never let two child agents edit files in this worktree at the same time. This applies to investigation and verification only. It never overrides a skill that sequences implementation for you: if you are following superpowers subagent-driven-development, keep its one-implementer-at-a-time rule exactly as written."

printf '%s\n' "PARALLEL EXECUTION, mandatory: whenever two or more pieces of work are independent, ${MECHANISM} instead of doing them one after another. Run at most ${AGENTS} child agents at a time. ${PHASES} ${GUARDRAIL}"
