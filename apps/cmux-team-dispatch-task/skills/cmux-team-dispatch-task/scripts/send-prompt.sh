#!/usr/bin/env bash
set -uo pipefail

# send-prompt.sh — 子/親セッションへ 1 メッセージを配送する単一の入口。
#
# タイプ入力を唯一の wake 手段として常に実行する (dual-send)。agmsg は宛先の
# watcher が生きている (ready sentinel が存在する) ときだけ inbox への記録用に
# 追加送信するが、これは wake 手段ではなく記録専用であり、失敗しても配送の
# 成否には影響しない。ready sentinel は watcher プロセスの生存を示すだけで、
# そのセッションを起こせることは示さないため (Monitor ツール配下でも Bash
# watcher 配下でも同じ sentinel が書かれる)。
#
# 1KB 超の本文は Claude Code TUI に貼り付け判定され、デバウンス中の Enter が
# submit ではなく貼り付けバッファに吸われて入力欄に残る事故を起こすため、
# タイプ入力側だけ outbox にファイル化してポインタ 1 行を打つ。agmsg 側には
# 全文をそのまま渡す (inbox には貼り付け判定の問題が無いため)。
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

# --- agmsg: inbox 記録専用 (wake 手段ではない) ---
# agmsg の 3 引数が揃い、宛先の watcher が生きている (ready sentinel が存在する)
# ときだけ、タイプ入力の前に inbox へ全文を記録する。失敗しても配送失敗には
# しない (終了コードはタイプ入力経路の結果だけで決まる)。
if [[ -n "$TEAM" && -n "$TO_AGENT" && -n "$FROM_AGENT" ]] \
   && [[ -f "$AGMSG_READY_DIR/ready.${TEAM}__${TO_AGENT}" ]]; then
  bash "$AGMSG_SEND" "$TEAM" "$FROM_AGENT" "$TO_AGENT" "$TEXT" \
    || echo "send-prompt: agmsg record failed (non-fatal, typed delivery continues)" >&2
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

# 入力欄にテキストが残っていないかを確認する。TUI の貼り付けデバウンスに Enter が
# 吸われるとここで検出できる。read-screen が観測できない場合は配送失敗とみなさない
# (Phase A-R の生存確認と同じ扱い)。
probe="${PAYLOAD:0:30}"
attempt=0
while [[ $attempt -lt $RETRIES ]]; do
  screen=$("$CMUX_BIN" read-screen ${TARGET[@]+"${TARGET[@]}"} 2>/dev/null || true)
  [[ -n "$screen" ]] || exit 0                       # 観測失敗 = 配送失敗ではない
  # 画面から入力欄行 (❯/> 始まり) が 1 行も見つからない場合も、read-screen が空
  # 出力だった場合と同じ「観測失敗」として配送済み扱いにする (fail-open)。ここで
  # exit 1 にして呼び出し元に再送させると、実際には届いていたメッセージを二重に
  # 配送する事故につながるため、パース不能は失敗ではなく成功として扱う。
  input_line=$(printf '%s\n' "$screen" | grep -E '^[❯>]' || true)
  printf '%s' "$input_line" | grep -qF -- "$probe" || exit 0   # 入力欄は空(or未検出) = 送信済み扱い
  attempt=$((attempt + 1))
  sleep 1
  "$CMUX_BIN" send-key ${TARGET[@]+"${TARGET[@]}"} return || exit 1
done

echo "send-prompt: message still sitting in the input box after $RETRIES retries (label=$LABEL)" >&2
exit 1
