#!/usr/bin/env bash
# verify-agmsg-ready.sh — agmsg readiness を確認する。watcher は起動しない。
#
# 判定は agmsg 1.2.1 の実測 (spec 2026-08-21 の B5) に従う:
#   --self                        自セッション: run/watch.<session-id>*.pid が生きているか
#   --codex --team <t> --name <a>  codex ペイン: run/codex-bridge.<t>.<a>.thread が非空か
#   --parent --team <t>           親セッション: engine を見て上の 2 つを選び分ける
#
# --parent が存在する理由は、engine 分岐を呼び出し側に書かせないためである。親の engine は
# 設定項目ではなく実行時のセッションそのもの (CODEX_THREAD_ID の有無) で決まるので、分岐を
# SKILL.md / guide-ja.md / CLAUDE.md へ書き写すと 3 箇所が同時にずれる。実際、無条件の
# --self は codex 親で必ず rc 2 になり、「rc 2 = 判定不能なので停止」という規約と噛み合って
# codex 親のディスパッチを最初の起床で自滅させていた。分岐をここへ畳むとその事故は
# 構造的に起きなくなる。--team はどちらの engine でも必須にしてある: claude 側では使わない
# 引数だが、必須にしておかないと「claude では通るが codex では usage error になる呼び出し」
# を書けてしまい、engine 分岐を消した意味が無くなる。
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
#   verify-agmsg-ready.sh --parent --team <team> [--session-id <id>]
#
# Output: ready=yes|no reason=<slug>
#         --parent はさらに sharing=<N>|unknown を付ける (下記)
# Exit:   0 = ready / 1 = not ready / 2 = usage error
#
# sharing= は read cursor の競合を報告する。read cursor は (team, agent) 単位で 1 つしか
# 無く、同じペアを購読する watcher が 2 つあると先に poll した方が row を取り、他方は何も
# 見ない。取られた row は既読になるので inbox は「新着なし」と正直に答える。dispatch は
# 単一の parent identity を [ready] / dispatch-notify / review-verdict の全部に使い回すので、
# どのメッセージでも消えうる。
#
# agmsg 自身も同じ検出を持つ (watch.sh の #683) が、その警告は watch_log 経由で **stderr**
# へ出る。Monitor tool がイベント化するのは stdout だけなので、親セッションには届かない。
# だからここで数え直す。
#
# sharing は到達可能かどうかの判定を変えない (exit code に影響しない)。競合していても自分が
# row を取る可能性は残るので、止めるのは過剰である。unknown は 0 ではなく「判定できなかった」
# の意味で、0 と偽らないために別の値にしてある。

set -uo pipefail

AGMSG_RUN_DIR="${AGMSG_RUN_DIR:-$HOME/.agents/skills/agmsg/run}"

die() { echo "ready=no reason=usage detail=$1" >&2; exit 2; }

MODE=""; TEAM=""; NAME=""; SESSION_ID="${CLAUDE_CODE_SESSION_ID:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --self)       MODE="self";  shift ;;
    --codex)      MODE="codex"; shift ;;
    --parent)     MODE="parent"; shift ;;
    --team)       [[ $# -ge 2 ]] || die "--team requires a value"; TEAM="$2"; shift 2 ;;
    --name)       [[ $# -ge 2 ]] || die "--name requires a value"; NAME="$2"; shift 2 ;;
    --session-id) [[ $# -ge 2 ]] || die "--session-id requires a value"; SESSION_ID="$2"; shift 2 ;;
    *)            die "unknown argument: $1" ;;
  esac
done

# --parent は engine を見て self / codex のどちらかへ落とす。分岐はここ 1 箇所だけ。
if [[ "$MODE" == parent ]]; then
  [[ -n "$TEAM" ]] || die "--parent requires --team"
  [[ -z "$NAME" ]] || die "--parent takes no --name (the parent agent is always 'parent')"
  if [[ -n "${CODEX_THREAD_ID:-}" ]]; then
    MODE="codex"; NAME="parent"
  else
    MODE="self"
  fi
  REPORT_SHARING=1
fi

# 生きている watcher の pidfile パスを stdout へ返す。見つからなければ非ゼロ。
find_live_watcher() {
  local f pid
  shopt -s nullglob
  # watch.sh の pidfile は <session-id> そのままか、composite の <session-id>.<pid> で
  # 命名される。両方を候補にする。
  for f in "$AGMSG_RUN_DIR/watch.$SESSION_ID.pid" "$AGMSG_RUN_DIR/watch.$SESSION_ID."*.pid; do
    [[ -f "$f" ]] || continue
    pid=$(cat "$f" 2>/dev/null || echo "")
    # pidfile の存在だけでは足りない。SIGKILL された watcher は EXIT trap を飛ばして
    # pidfile を残すので、プロセスの生存まで確認する。
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      printf '%s\t%s\n' "$f" "$pid"
      return 0
    fi
  done
  return 1
}

# 生存判定に裸の kill -0 を使わない。裸の形は EPERM (別ユーザー / サンドボックスの
# プロセス) を「死んでいる」と読むので、signal できない競合 watcher を数え落とす。
# 数え落とす方向の誤りは、報告すべき競合を黙って隠すという最悪の向きになる。
pid_alive() { ps -p "$1" -o pid= >/dev/null 2>&1; }

# 同一プロジェクトで live な unfiltered watcher の数を stdout へ返す。数えられないときは
# unknown。判定条件は agmsg watch.sh:279-337 と同じにしてある。
count_sharing() { # $1 = 自分の pidfile パス
  local own_pidfile="$1" own_filter own_role own_project
  own_filter="${own_pidfile%.pid}.filter"
  # filter が無いのは、この機能より前の watcher か、起動直後の窓に入ったかのどちらか。
  # どちらも「自分がどのプロジェクトの何を購読しているか」を答えられないので 0 と言えない。
  [[ -f "$own_filter" ]] || { echo unknown; return; }
  own_role=$(sed -n '1p' "$own_filter" 2>/dev/null || true)
  own_project=$(sed -n '2p' "$own_filter" 2>/dev/null || true)
  [[ -n "$own_project" ]] || { echo unknown; return; }
  # 自分が名前で filter 済みなら、購読しているのは自分のペアだけなので競合しようがない。
  [[ "$own_role" == unfiltered ]] || { echo 0; return; }

  local n=0 pf other_pid other_filter other_role other_project
  shopt -s nullglob
  for pf in "$AGMSG_RUN_DIR"/watch.*.pid; do
    [[ -f "$pf" ]] || continue
    [[ "$pf" == "$own_pidfile" ]] && continue
    other_pid=$(cat "$pf" 2>/dev/null || echo "")
    [[ "$other_pid" =~ ^[0-9]+$ ]] || continue
    pid_alive "$other_pid" || continue
    other_filter="${pf%.pid}.filter"
    # filter が無い watcher は、どのプロジェクトを見ているか聞けない。install を共有する
    # 無関係なプロジェクトまで警告してしまうので数えない (agmsg も同じ扱い)。
    [[ -f "$other_filter" ]] || continue
    other_role=$(sed -n '1p' "$other_filter" 2>/dev/null || true)
    other_project=$(sed -n '2p' "$other_filter" 2>/dev/null || true)
    # RUN_DIR は install 単位、購読は project 単位。別プロジェクトの watcher とはペアを
    # 共有しない。
    [[ "$other_project" == "$own_project" ]] || continue
    [[ "$other_role" == unfiltered ]] || continue
    n=$((n + 1))
  done
  echo "$n"
}

# --parent のときだけ sharing= を付ける。--self / --codex の出力契約は変えない。
sharing_suffix() { # $1 = sharing の値
  [[ "${REPORT_SHARING:-0}" == 1 ]] || return 0
  printf ' sharing=%s' "$1"
}

case "$MODE" in
  self)
    [[ -n "$SESSION_ID" ]] || die "--session-id is required when CLAUDE_CODE_SESSION_ID is unset"
    if found=$(find_live_watcher); then
      pidfile="${found%%$'\t'*}"
      pid="${found##*$'\t'}"
      echo "ready=yes reason=watch-pid-alive pid=$pid$(sharing_suffix "$(count_sharing "$pidfile")")"
      exit 0
    fi
    echo "ready=no reason=no-live-watcher session=$SESSION_ID$(sharing_suffix unknown)"
    exit 1
    ;;
  codex)
    [[ -n "$TEAM" && -n "$NAME" ]] || die "--codex requires both --team and --name"
    thread_file="$AGMSG_RUN_DIR/codex-bridge.$TEAM.$NAME.thread"
    # codex の受信は bridge seat 経由で、watcher の read cursor とは別経路である。
    # 競合が起きるかどうかは実測していないので、0 とは言わず unknown のままにする。
    if [[ -s "$thread_file" ]]; then
      echo "ready=yes reason=seat-recorded$(sharing_suffix unknown)"
      exit 0
    fi
    echo "ready=no reason=no-seat team=$TEAM name=$NAME$(sharing_suffix unknown)"
    exit 1
    ;;
  *)
    die "one of --self, --codex or --parent is required"
    ;;
esac
