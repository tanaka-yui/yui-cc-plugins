#!/usr/bin/env bash
# verify-agmsg-ready.sh — agmsg readiness を確認する。watcher は起動しない。
#
# 判定は agmsg 1.2.1 の実測 (spec 2026-08-21 の B5) に従う:
#   --self                        自セッション: run/watch.<session-id>*.pid が生きているか
#   --codex --team <t> --name <a>  codex ペイン: run/codex-bridge.<t>.<a>.thread が非空か
#
# claude ペインの readiness は親から観測できない (シグナルが session id キーで、親は子の
# session id を知らない)。その経路はここでは扱わず、子からの `[ready] <name>` 自己申告を
# 待つ。--codex だけが「他ペインを観測できる」経路である。
#
# `delivery.sh status` は使わない。実測 (V2b) で bridge プロセスが実在し配信も成功して
# いる状況で `not running` と報告したため、判定条件にすると動作中のペインを誤って
# 不通と断定する。
#
# Usage:
#   verify-agmsg-ready.sh --self [--session-id <id>]
#   verify-agmsg-ready.sh --codex --team <team> --name <agent>
#
# Output: ready=yes|no reason=<slug>
# Exit:   0 = ready / 1 = not ready / 2 = usage error

set -uo pipefail

AGMSG_RUN_DIR="${AGMSG_RUN_DIR:-$HOME/.agents/skills/agmsg/run}"

die() { echo "ready=no reason=usage detail=$1" >&2; exit 2; }

MODE=""; TEAM=""; NAME=""; SESSION_ID="${CLAUDE_CODE_SESSION_ID:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --self)       MODE="self";  shift ;;
    --codex)      MODE="codex"; shift ;;
    --team)       [[ $# -ge 2 ]] || die "--team requires a value"; TEAM="$2"; shift 2 ;;
    --name)       [[ $# -ge 2 ]] || die "--name requires a value"; NAME="$2"; shift 2 ;;
    --session-id) [[ $# -ge 2 ]] || die "--session-id requires a value"; SESSION_ID="$2"; shift 2 ;;
    *)            die "unknown argument: $1" ;;
  esac
done

case "$MODE" in
  self)
    [[ -n "$SESSION_ID" ]] || die "--session-id is required when CLAUDE_CODE_SESSION_ID is unset"
    # watch.sh の pidfile は <session-id> そのままか、composite の <session-id>.<pid> で
    # 命名される。両方を候補にする。
    shopt -s nullglob
    for f in "$AGMSG_RUN_DIR/watch.$SESSION_ID.pid" "$AGMSG_RUN_DIR/watch.$SESSION_ID."*.pid; do
      [[ -f "$f" ]] || continue
      pid=$(cat "$f" 2>/dev/null || echo "")
      # pidfile の存在だけでは足りない。SIGKILL された watcher は EXIT trap を飛ばして
      # pidfile を残すので、プロセスの生存まで確認する。
      if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
        echo "ready=yes reason=watch-pid-alive pid=$pid"
        exit 0
      fi
    done
    echo "ready=no reason=no-live-watcher session=$SESSION_ID"
    exit 1
    ;;
  codex)
    [[ -n "$TEAM" && -n "$NAME" ]] || die "--codex requires both --team and --name"
    thread_file="$AGMSG_RUN_DIR/codex-bridge.$TEAM.$NAME.thread"
    if [[ -s "$thread_file" ]]; then
      echo "ready=yes reason=seat-recorded"
      exit 0
    fi
    echo "ready=no reason=no-seat team=$TEAM name=$NAME"
    exit 1
    ;;
  *)
    die "one of --self or --codex is required"
    ;;
esac
