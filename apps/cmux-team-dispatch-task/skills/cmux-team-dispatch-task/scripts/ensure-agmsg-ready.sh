#!/usr/bin/env bash
set -uo pipefail

# ensure-agmsg-ready.sh — このセッションで agmsg の inbox watcher が動いていることを保証する。
#
# 背景: delivery.sh set は「Monitor ツールを呼べ」という AGMSG-DIRECTIVE を印字するが、
# その ツールを持たないハーネスでは追従不能で watcher が起動しない。本スクリプトは
# watcher の有無を自分で判定し、無ければ nohup で起動する。
# 詳細は docs/superpowers/specs/2026-08-20-agmsg-setup-guard-design.md を参照。
#
# 出力は常に 1 行 7 キー。exit 0 = 配線できた / 1 = 配線できない / 2 = 使用法エラー。
# **watcher を起動できなかったことは決して exit 1 にしない。**

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/agmsg-path.sh"

AGMSG_DIR="${AGMSG_DIR:-$HOME/.agents/skills/agmsg/scripts}"
# AGMSG_DIR は比較に使うので絶対パス化する (~ を残さない)
case "$AGMSG_DIR" in "~"*) AGMSG_DIR="$HOME${AGMSG_DIR#\~}" ;; esac
AGMSG_READY_DIR="${AGMSG_READY_DIR:-$(dirname "$AGMSG_DIR")/run}"
AGMSG_LOG_DIR="${AGMSG_LOG_DIR:-${TMPDIR:-$HOME/.cache}/agmsg}"
AGMSG_READY_TIMEOUT="${AGMSG_READY_TIMEOUT:-15}"
AGMSG_WATCH_INTERVAL="${AGMSG_WATCH_INTERVAL:-30}"

TYPE=""; NAME=""; PROJECT="$PWD"
INSTALLED=no; WIRED=no; WATCHER=none; PID="-"; REASON="-"; LOG="-"

emit() {  # 常にこれ 1 回だけで出力する
  printf 'ensure-agmsg-ready: installed=%s wired=%s name=%s watcher=%s pid=%s reason=%s log=%s\n' \
    "$INSTALLED" "$WIRED" "${NAME:--}" "$WATCHER" "$PID" "$REASON" "$LOG"
}
hint() { printf 'ensure-agmsg-ready: %s\n' "$1" >&2; }
die_usage() {
  REASON=usage
  hint "usage: ensure-agmsg-ready.sh --type <claude-code|codex> --name <agent> [--project <path>]"
  emit
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --type)    [[ $# -ge 2 ]] || die_usage; TYPE="$2"; shift 2 ;;
    --name)    [[ $# -ge 2 ]] || die_usage; NAME="$2"; shift 2 ;;
    --project) [[ $# -ge 2 ]] || die_usage; PROJECT="$2"; shift 2 ;;
    *) die_usage ;;
  esac
done

[[ -n "$TYPE" && -n "$NAME" ]] || die_usage
[[ "$TYPE" == claude-code || "$TYPE" == codex ]] || die_usage
# --name は $LOG のファイル名へ生連結されるので値域を必ず検証する。
# 通らない値は name= にも出さない (1 行契約が壊れるため)。
if ! [[ "$NAME" =~ ^[A-Za-z0-9._-]+$ ]]; then NAME=""; die_usage; fi
[[ -d "$PROJECT" ]] || die_usage
# AGMSG_EXPECTED_NAME はセキュリティ境界ではなく、配線ミスの早期検出である。
if [[ -n "${AGMSG_EXPECTED_NAME:-}" && "$AGMSG_EXPECTED_NAME" != "$NAME" ]]; then die_usage; fi

# --- 手順 2: インストール確認 ---
if [[ ! -f "$AGMSG_DIR/send.sh" ]]; then
  REASON=not-installed; hint "agmsg is not installed at $AGMSG_DIR"; emit; exit 1
fi
INSTALLED=yes

# --- 手順 3: ログの用意 ---
mkdir -p "$AGMSG_LOG_DIR" 2>/dev/null || true
LOG_PATH="$(umask 077; mktemp "$AGMSG_LOG_DIR/agmsg-watch-$NAME.XXXXXX" 2>/dev/null || true)"
if [[ -z "$LOG_PATH" ]]; then
  LOG_PATH=/dev/null
  REASON=log-unwritable
  hint "cannot create a log under $AGMSG_LOG_DIR; diagnostics disabled"
else
  LOG="$LOG_PATH"
fi

# --- 手順 4: 配線 ---
# stdout も stderr もログへ落とす。/dev/null ではないのは、AGMSG-DIRECTIVE と codex の
# シェル shim 手順を呼び出し元へ漏らさずに事後解析だけは残すため。
if ! bash "$AGMSG_DIR/delivery.sh" set monitor "$TYPE" "$PROJECT" >>"$LOG_PATH" 2>&1; then
  REASON=delivery-set-failed; hint "see $LOG"; emit; exit 1
fi
WIRED=yes

# --- session id ---
SID=""
[[ "$TYPE" == claude-code ]] && SID="${CLAUDE_CODE_SESSION_ID:-}"
[[ "$TYPE" == codex ]] && SID="${CODEX_THREAD_ID:-}"
if [[ -z "$SID" ]]; then
  # "-" は渡さない。watch.sh に採番させると起動ごとに別 uuid になり、
  # 同一ペインで 2 回走ったとき 2 本目が 1 本目に held される。
  if command -v uuidgen >/dev/null 2>&1; then
    SID="agmsg-$(uuidgen | tr 'A-Z' 'a-z')"
  else
    SID="agmsg-$$-$(date +%s)"
  fi
fi
[[ "$SID" =~ ^[A-Za-z0-9._-]+$ ]] || SID="agmsg-$$"

# --- 手順 5-9 は Task 4 / Task 5 で実装する。暫定: 常に起動して待つ ---
AGMSG_WATCH_INTERVAL="$AGMSG_WATCH_INTERVAL" \
nohup bash "$AGMSG_DIR/watch.sh" "$SID" "$PROJECT" "$TYPE" "$NAME" </dev/null >>"$LOG_PATH" 2>&1 &
WATCH_PID=$!

deadline=$(( AGMSG_READY_TIMEOUT * 5 ))
found=""
for _ in $(seq 1 "$deadline"); do
  if compgen -G "$AGMSG_READY_DIR/ready.*__$(agmsg_encode_component "$NAME")" >/dev/null 2>&1; then
    found=1; break
  fi
  sleep 0.2
done
if [[ -n "$found" ]]; then
  WATCHER=started; PID="$WATCH_PID"
else
  WATCHER=none; [[ "$REASON" == "-" ]] && REASON=watcher-exited; hint "see $LOG"
fi
emit
exit 0
