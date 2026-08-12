#!/usr/bin/env bash
set -uo pipefail

# send-prompt.sh — 子/親セッションへ 1 メッセージを配送する単一の入口。
#
# 宛先ごとに agmsg push か タイプ入力かの「どちらか一方だけ」を選ぶ。
# 従来の cmux send + send-key return を無遅延で撃つ dual-send は、1KB 超の本文が
# Claude Code TUI に貼り付け判定され、デバウンス中の Enter が submit ではなく
# 貼り付けバッファに吸われて入力欄に残る事故を起こしていた。
#
# Usage: send-prompt.sh [--to-workspace <id>] [--to-surface <id>]
#                       [--agmsg-team <t>] [--agmsg-to <agent>] [--agmsg-from <name>]
#                       --label <label>
#                       [--outbox-dir <path>] [--threshold <n>] [--retries <n>] [--settle <sec>]
#                       [--] <text>
#
# Exit: 0 = 配送成功 / 1 = 配送失敗 / 2 = 使用法エラー

CMUX_BIN="${CMUX_BIN:-/Applications/cmux.app/Contents/Resources/bin/cmux}"
AGMSG_SEND="${AGMSG_SEND:-$HOME/.agents/skills/agmsg/scripts/send.sh}"
AGMSG_READY_DIR="${AGMSG_READY_DIR:-$HOME/.agents/skills/agmsg/run}"

die() { echo "send-prompt: $1" >&2; exit 2; }
fail() { echo "send-prompt: $1" >&2; exit 1; }

TO_WORKSPACE=""; TO_SURFACE=""
TEAM=""; TO_AGENT=""; FROM_AGENT=""
LABEL=""; OUTBOX_DIR=""
THRESHOLD=400; RETRIES=3; SETTLE=0.5
TEXT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --to-workspace) [[ $# -ge 2 ]] || die "--to-workspace requires a value"; TO_WORKSPACE="$2"; shift 2 ;;
    --to-surface)   [[ $# -ge 2 ]] || die "--to-surface requires a value";   TO_SURFACE="$2";   shift 2 ;;
    --agmsg-team)   [[ $# -ge 2 ]] || die "--agmsg-team requires a value";   TEAM="$2";         shift 2 ;;
    --agmsg-to)     [[ $# -ge 2 ]] || die "--agmsg-to requires a value";     TO_AGENT="$2";     shift 2 ;;
    --agmsg-from)   [[ $# -ge 2 ]] || die "--agmsg-from requires a value";   FROM_AGENT="$2";   shift 2 ;;
    --label)        [[ $# -ge 2 ]] || die "--label requires a value";        LABEL="$2";        shift 2 ;;
    --outbox-dir)   [[ $# -ge 2 ]] || die "--outbox-dir requires a value";   OUTBOX_DIR="$2";   shift 2 ;;
    --threshold)    [[ $# -ge 2 ]] || die "--threshold requires a value";    THRESHOLD="$2";    shift 2 ;;
    --retries)      [[ $# -ge 2 ]] || die "--retries requires a value";      RETRIES="$2";      shift 2 ;;
    --settle)       [[ $# -ge 2 ]] || die "--settle requires a value";       SETTLE="$2";       shift 2 ;;
    --) shift; TEXT="$*"; break ;;
    --*) die "unknown flag: $1" ;;
    *)  TEXT="$*"; break ;;
  esac
done

[[ -n "$LABEL" ]] || die "--label is required"
[[ "$LABEL" != *"/"* ]] || die "--label must not contain '/'"
[[ -n "$TEXT" ]] || die "message text is required"
[[ -n "$TO_WORKSPACE" || -n "$TO_SURFACE" ]] || die "--to-workspace or --to-surface is required"

# --- 経路選択 ---
# agmsg の 3 引数が揃い、宛先の watcher が生きている (ready sentinel が存在する)
# ときだけ agmsg 経路。sentinel は watcher プロセスの生存を示す。
route="typed"
if [[ -n "$TEAM" && -n "$TO_AGENT" && -n "$FROM_AGENT" ]] \
   && [[ -f "$AGMSG_READY_DIR/ready.${TEAM}__${TO_AGENT}" ]]; then
  route="agmsg"
fi

if [[ "$route" == "agmsg" ]]; then
  bash "$AGMSG_SEND" "$TEAM" "$FROM_AGENT" "$TO_AGENT" "$TEXT" && exit 0
  echo "send-prompt: agmsg push failed; falling back to typed delivery" >&2
fi

# --- タイプ入力経路 ---
# 閾値を超える本文はタイプさせない。TUI が貼り付けと判定して [Pasted text #N] に
# 畳み、直後の Enter を吸ってしまうため。全文はファイルへ退避し、パスだけを打つ。
PAYLOAD="$TEXT"
if [[ ${#TEXT} -gt $THRESHOLD ]]; then
  [[ -n "$OUTBOX_DIR" ]] || OUTBOX_DIR="${STATUS_DIR:-}/outbox"
  [[ "$OUTBOX_DIR" != "/outbox" ]] || die "--outbox-dir is required when STATUS_DIR is unset"
  mkdir -p "$OUTBOX_DIR" || fail "failed to create outbox dir: $OUTBOX_DIR"
  # 同一 label の既存ファイル数 + 1 を連番にする (過去の送信を上書きしない)
  seq_n=1
  while [[ -e "$OUTBOX_DIR/$LABEL-$seq_n.md" ]]; do
    seq_n=$((seq_n + 1))
  done
  OUTBOX_FILE="$OUTBOX_DIR/$LABEL-$seq_n.md"
  printf '%s' "$TEXT" > "$OUTBOX_FILE" || fail "failed to write outbox file: $OUTBOX_FILE"
  PAYLOAD="$LABEL: read $OUTBOX_FILE and follow every instruction in it."
fi

TARGET=()
[[ -n "$TO_WORKSPACE" ]] && TARGET+=(--workspace "$TO_WORKSPACE")
[[ -n "$TO_SURFACE" ]] && TARGET+=(--surface "$TO_SURFACE")

"$CMUX_BIN" send ${TARGET[@]+"${TARGET[@]}"} "$PAYLOAD" || exit 1
sleep "$SETTLE"
"$CMUX_BIN" send-key ${TARGET[@]+"${TARGET[@]}"} return || exit 1
exit 0
