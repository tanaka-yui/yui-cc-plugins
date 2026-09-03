#!/usr/bin/env bash
# review-request.sh — レビュー依頼をディスクへ materialize してから 1 回だけ送る。
#
# completion-gate.sh の「レビュー待ちなら停止を許す」判定はディスクだけを読み、その材料は
# <point>-round-<N>-request.md である。書き込みと送信を別々の手順として指示すると、実測で
# 4/7 の頻度で書き込みだけが落ちた (2026-09-02 の loop 運用。親が明示的に指示し直しても再発)。
# 落ちた側は gate から待機に見えないので判定 7 に落ち、その文面が提示する唯一の出口 error を
# 取って、進行中のレビューごと中断される。
#
# 本文は stdin で受ける。--body-file にすると「先にファイルを書く」という、いま落ちている
# 手順がそのまま残る。位置引数は、複数行かつ引用符を含む依頼文が zsh -ic "..." の内側で
# 壊れるため使わない。
#
# Usage:
#   review-request.sh --review-dir <dir> --point <name> --round <N> \
#                     --team <team> --from <agent> --to <agent> < body
#
# Exit: 0 = 書いて送った / 1 = 送信失敗 (request ファイルは削除済み) / 2 = 使用法エラー
set -uo pipefail

die() { echo "review-request: $1" >&2; exit 2; }
fail() { echo "review-request: $1" >&2; exit 1; }

REVIEW_DIR=''; POINT=''; ROUND=''; TEAM=''; FROM=''; TO=''
AGMSG_SEND="${AGMSG_SEND:-$HOME/.agents/skills/agmsg/scripts/send.sh}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --review-dir) [[ $# -ge 2 ]] || die '--review-dir requires a value'; REVIEW_DIR="$2"; shift 2 ;;
    --point)      [[ $# -ge 2 ]] || die '--point requires a value';      POINT="$2";      shift 2 ;;
    --round)      [[ $# -ge 2 ]] || die '--round requires a value';      ROUND="$2";      shift 2 ;;
    --team)       [[ $# -ge 2 ]] || die '--team requires a value';       TEAM="$2";       shift 2 ;;
    --from)       [[ $# -ge 2 ]] || die '--from requires a value';       FROM="$2";       shift 2 ;;
    --to)         [[ $# -ge 2 ]] || die '--to requires a value';         TO="$2";         shift 2 ;;
    *) die "unknown option: $1" ;;
  esac
done

[[ "$POINT" =~ ^[A-Za-z0-9._-]+$ ]] || die 'point must match [A-Za-z0-9._-]+'
[[ "$ROUND" =~ ^[1-5]$ ]] || die 'round must be 1..5'
[[ "$TEAM" =~ ^[A-Za-z0-9._-]+$ ]] || die 'team must match [A-Za-z0-9._-]+'
[[ "$FROM" =~ ^[A-Za-z0-9._-]+$ ]] || die 'from must match [A-Za-z0-9._-]+'
[[ "$TO"   =~ ^[A-Za-z0-9._-]+$ ]] || die 'to must match [A-Za-z0-9._-]+'
[[ -n "$REVIEW_DIR" && -d "$REVIEW_DIR" && ! -L "$REVIEW_DIR" ]] \
  || die 'review-dir must be an existing non-symlink directory'
[[ -f "$AGMSG_SEND" ]] || die "send.sh not found at $AGMSG_SEND"

# 本文は stdin から一括で読む。空 (空白のみを含む) なら何も書かずに終わる — 空の依頼を
# ディスクへ残すと、gate はそれを正当な待機として読んでしまう。
BODY=$(cat) || die 'cannot read the request body from stdin'
[[ -n "${BODY//[[:space:]]/}" ]] || die 'the request body on stdin is empty'

TARGET="$REVIEW_DIR/$POINT-round-$ROUND-request.md"
if [[ -e "$TARGET" || -L "$TARGET" ]]; then
  [[ -f "$TARGET" && ! -L "$TARGET" ]] || die 'request target must be a regular non-symlink file'
fi

# 一時名は先頭ドット + .md 以外の接尾辞にする。review_select_active は review/*.md を走査
# するので、書きかけの一時ファイルがそこへ現れてはならない。
TMP=$(mktemp "$REVIEW_DIR/.$POINT-round-$ROUND-request.XXXXXX") || fail 'mktemp failed'
if ! printf '%s\n' "$BODY" > "$TMP"; then
  rm -f "$TMP"; fail 'cannot write the request file'
fi
mv -- "$TMP" "$TARGET" || { rm -f "$TMP"; fail "cannot publish $TARGET"; }

# code だけが固定名で、Phase B-R の point である (phase-b-deliver.sh と
# launch-workspace.sh に焼き込まれている)。design 側の checkpoint 名は固定ではなく
# (superpowers モードは spec と plan の 2 点、無人ループは design)、SKILL.md は
# ファイル名を規定していない。したがって code 以外はすべて設計側のレビュー依頼である。
if [[ "$POINT" == code ]]; then PREFIX='review-code: '; else PREFIX='review-plan: '; fi

# 送れなかったらファイルを消す。残すと「始まっていない待機」を gate が待機として読み、
# 相手が居ないまま WAIT_MINUTES を丸ごと溶かす。
if ! bash "$AGMSG_SEND" "$TEAM" "$FROM" "$TO" "$PREFIX$BODY"; then
  rm -f "$TARGET"
  fail "delivery to $TO failed; the request file was removed so the gate does not read a wait that never started"
fi
