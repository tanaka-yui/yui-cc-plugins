#!/usr/bin/env bash
# orca-wake.sh — 役の端末へ 1 行入力して、アイドルな worker を起こす。
#
# ★ **なぜ在るのか。**`orchestration send` はメールボックスに入れるだけで、ターンを
#   終えた worker を起こさない（実測 2026-09-10: 1 Run の 4 worker 全員が
#   `completion-accepted` と `review-verdict` を未読のまま停止し、`terminal send` で
#   直接入力して初めて動き出した）。`orchestration send` の nudge も同じ理由で効かない。
#
# ★ **配送と起床は別の事実である。**だから別の script に分けてある。配送は送信側の
#   exit code で確定しており、起こせなかったことでそれを覆してはならない — 呼び出し側は
#   ここの rc を握り潰してよい（握り潰すのが正しい場面のほうが多い）。
#
# ★ **「止まっている」と「止まっていて届かない」を別の結論にする**（cmux 版の seat 未記録と
#   同じ切り分け）。端末が記録されていない役は 1 で返し、何も打たない。
#
# Usage: orca-wake.sh --workers <workers.json> --role <role> [--text <text>]
# Exit:  0 = 入力した / 1 = 起こせなかった / 2 = 使用法エラー

set -uo pipefail
die() { echo "orca-wake: $1" >&2; exit 2; }
log() { echo "orca-wake: $1" >&2; }
ORCA_BIN="${ORCA_BIN:-${ORCA_CLI_COMMAND:-/Applications/Orca.app/Contents/Resources/bin/orca}}"
need2() { [[ "$2" -ge 2 ]] || die "$1 requires a value"; }

# 既定の本文。**手順そのものを書かない** — worker は自分のタスク指示に完全な手順を
# 持っている。ここで別版の手順を書くと、指示が 2 つになってドリフトする。
#
# ★ **1 行でなければならない。**`--enter` は末尾に Enter を足すだけなので、本文の中に
#   改行があるとそこで送信され、残りが次の入力として撃ち込まれる。
TEXT="A message is waiting in your mailbox. Read it the way your task instructions say (--peek, never --ack) and continue from where you stopped."

WF="" ROLE=""
while [[ $# -gt 0 ]]; do case "$1" in
  --workers) need2 "$1" $#; WF="$2";   shift 2 ;;
  --role)    need2 "$1" $#; ROLE="$2"; shift 2 ;;
  --text)    need2 "$1" $#; TEXT="$2"; shift 2 ;;
  *) die "unknown option: $1" ;; esac; done
[[ -n "$WF" && -n "$ROLE" ]] || die "--workers and --role are required"
[[ -r "$WF" ]] || { log "cannot read $WF; nothing was typed"; exit 1; }

TH=$(jq -r --arg r "$ROLE" '.roles[$r].terminal // empty' "$WF" 2>/dev/null || echo "")
[[ -n "$TH" ]] || { log "role '$ROLE' has no terminal recorded; it cannot be woken"; exit 1; }

# ★ **終端した dispatch を叩かない。**閉じた worker の端末に入力しても意味が無く、
#   人がその端末を引き取っていれば、その人の入力欄に文字列を撃ち込むことになる。
#   状態が読めないときも打たない — 生死の分からないものには触らない。
DID=$(jq -r --arg r "$ROLE" '.roles[$r].dispatch // empty' "$WF" 2>/dev/null || echo "")
if [[ -n "$DID" ]]; then
  SHOW=$("$ORCA_BIN" orchestration worker-show --dispatch "$DID" --json 2>/dev/null) || SHOW=""
  jq -e '.ok == true and (.result | type == "object")' <<<"$SHOW" >/dev/null 2>&1 || {
    log "cannot read the worker state for dispatch '$DID'; nothing was typed"; exit 1; }
  case "$(jq -r '.result.dispatch.status // empty' <<<"$SHOW")" in
    completed|failed|settled|terminated)
      log "dispatch '$DID' is already terminal; nothing was typed"; exit 1 ;;
  esac
  # ★ 許容集合は `healthy()` と同じ。**settle 済みの worker-show は 'succeeded' を返す**
  #   ので、「失敗でなければ生きている」とは読めない。
  case "$(jq -r '.result.worker.state // empty' <<<"$SHOW")" in
    active|ready|starting|idle) ;;
    *) log "the worker for dispatch '$DID' is not running; nothing was typed"; exit 1 ;;
  esac
fi

RC=0
OUT=$("$ORCA_BIN" terminal send --terminal "$TH" --text "$TEXT" --enter --json 2>/dev/null) || RC=$?
# ★ rc だけでは足りない。**receipt の ok を確かめる** — 実測で「rc 0 かつ ok:false」の
#   応答形が在る（orca-send.sh と同じ構え）。
if [[ "$RC" -ne 0 ]] || ! jq -e '.ok == true' <<<"$OUT" >/dev/null 2>&1; then
  log "could not type into the terminal of role '$ROLE' (rc=$RC)"; exit 1
fi
log "woke role '$ROLE' (terminal $TH)"
