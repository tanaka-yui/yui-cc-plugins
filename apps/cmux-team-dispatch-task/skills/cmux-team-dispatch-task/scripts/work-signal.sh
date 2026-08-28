#!/usr/bin/env bash
set -uo pipefail

# work-signal.sh — worktree の「作業が生む信号」を 1 行で出し、前回値との変化を返す。
#
# 対話 codex は作業を終えても終了しないので、ペインの生存では進捗を判定できない
# (commands/codex-review.md の "The pane is alive is not evidence of progress")。
# 報告ではなく作業そのものが残す痕跡を見ることで、「喋っていない」と「動いていない」を
# 切り分ける。これは単発タイマーの起床時に 1 回だけ呼ぶ想定で、ポーリングループを作らない。
#
# Usage: work-signal.sh <worktree> --state <file> [--surface <id>]
#   <worktree>      検査対象の作業ディレクトリ
#   --state <file>  前回の signal を保持するファイル。比較後にこのファイルを更新する
#   --surface <id>  ペインの画面内容も信号に含める (任意)
#
# 出力 (1 行):
#   signal=<hash> commit=<iso8601|none> mtime=<epoch|none> screen=<ok|unavailable|skipped> changed=<first|yes|no|unknown>
# exit: 0 = 判定できた / 1 = worktree を読めない / 2 = 使用法エラー
#
# 信号は次の 4 つを合成する。どれか 1 つでも動けば changed=yes になる:
#   1. HEAD のコミット hash と author date  — コミットが進んだ
#   2. git status --porcelain の全文        — dirty なパスの集合が変わった
#   3. dirty な各パスの mtime               — 同じファイルを編集し続けた場合を拾う
#   4. --surface 指定時はペインの画面内容   — 書き込みの無い長時間の調査を拾う
# 3 が要るのは、既に modified なファイルを再編集しても 2 が変わらないため。
# 逆に 2 が要るのは、新しいファイルに触れた瞬間を 3 だけでは取りこぼすため。
# 4 が要るのは、1-3 だけだと「90 分ずっと読んで考えていた」セッションを停滞と誤判定し、
# 作業中のエージェントを突ついてしまうため。対話 codex の画面は思考中に更新され続け、
# idle になると静止するので、この誤検知に対する有効な打ち消しになる。
#
# --surface を渡したのに read-screen が失敗したときは changed=unknown を返し、state も
# 更新しない。画面成分が欠けた信号は前回値と必ず食い違うので、素直に比較すると
# 「ペインが死んだ」を「動いている」と読み違える。判断不能を判断不能のまま返し、
# ペイン死亡の断定は呼び出し側の既存手順 (1 回リトライしてから判定) に任せる。
# state を更新しないのは、欠けた成分を含む値を次回の基準にしないため。

usage() {
  echo "usage: work-signal.sh <worktree> --state <file> [--surface <id>]" >&2
  exit 2
}

WORKTREE=""; STATE=""; SURFACE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --state) [[ $# -ge 2 ]] || usage; STATE="$2"; shift 2 ;;
    --surface) [[ $# -ge 2 ]] || usage; SURFACE="$2"; shift 2 ;;
    -h|--help) usage ;;
    -*) echo "work-signal: unknown argument: $1" >&2; usage ;;
    *) [[ -z "$WORKTREE" ]] || { echo "work-signal: too many positional arguments" >&2; usage; }
       WORKTREE="$1"; shift ;;
  esac
done
[[ -n "$WORKTREE" && -n "$STATE" ]] || usage

[[ -d "$WORKTREE" ]] || { echo "work-signal: not a directory: $WORKTREE" >&2; exit 1; }
git -C "$WORKTREE" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || { echo "work-signal: not a git worktree: $WORKTREE" >&2; exit 1; }

# macOS (BSD) と Linux (GNU) で stat のフラグが違う。どちらでも動く 1 ファイル用ヘルパー。
if stat -f %m . >/dev/null 2>&1; then
  mtime_of() { stat -f %m "$1" 2>/dev/null; }
else
  mtime_of() { stat -c %Y "$1" 2>/dev/null; }
fi

# 1. HEAD。コミットが 1 つも無い worktree では空になる
HEAD_INFO=$(git -C "$WORKTREE" log -1 --format='%H %aI' 2>/dev/null || true)
COMMIT_ISO="none"
[[ -n "$HEAD_INFO" ]] && COMMIT_ISO="${HEAD_INFO#* }"

# 2. dirty の集合
PORCELAIN=$(git -C "$WORKTREE" status --porcelain 2>/dev/null || true)

# 3. dirty な各パスの mtime。最新値も報告用に持っておく
NEWEST=""
MTIMES=""
while IFS= read -r line; do
  [[ -n "$line" ]] || continue
  # porcelain の各行は "XY <path>"。rename は "R  old -> new" なので新しい方を採る
  path="${line:3}"
  [[ "$path" == *" -> "* ]] && path="${path##* -> }"
  # パスに空白が含まれる場合 porcelain は "..." で囲む
  if [[ "$path" == '"'*'"' ]]; then
    path="${path:1:${#path}-2}"
  fi
  full="$WORKTREE/$path"
  # 削除されたパスは stat できない。存在するものだけ数える
  [[ -e "$full" ]] || continue
  m=$(mtime_of "$full")
  [[ -n "$m" ]] || continue
  MTIMES="$MTIMES$path:$m"$'\n'
  if [[ -z "$NEWEST" || "$m" -gt "$NEWEST" ]]; then NEWEST="$m"; fi
done <<< "$PORCELAIN"

# 4. 画面内容 (任意)。cmux が無い / read-screen が失敗するときは空成分にして続行する
SCREEN=""
SCREEN_STATE="skipped"
if [[ -n "$SURFACE" ]]; then
  CMUX_BIN="${CMUX_BIN:-cmux}"
  if command -v "$CMUX_BIN" >/dev/null 2>&1 \
    && SCREEN=$("$CMUX_BIN" read-screen --surface "$SURFACE" 2>/dev/null) && [[ -n "$SCREEN" ]]; then
    SCREEN_STATE="ok"
  else
    SCREEN=""
    SCREEN_STATE="unavailable"
  fi
fi

if command -v shasum >/dev/null 2>&1; then
  SIGNAL=$(printf '%s\n%s\n%s\n%s' "$HEAD_INFO" "$PORCELAIN" "$MTIMES" "$SCREEN" | shasum -a 256 | cut -d' ' -f1)
else
  SIGNAL=$(printf '%s\n%s\n%s\n%s' "$HEAD_INFO" "$PORCELAIN" "$MTIMES" "$SCREEN" | sha256sum | cut -d' ' -f1)
fi

# 画面成分を要求されたのに取れなかった場合は比較そのものが無意味なので、判断不能を返す
if [[ "$SCREEN_STATE" == "unavailable" ]]; then
  printf 'signal=%s commit=%s mtime=%s screen=%s changed=unknown\n' \
    "$SIGNAL" "$COMMIT_ISO" "${NEWEST:-none}" "$SCREEN_STATE"
  exit 0
fi

CHANGED="first"
if [[ -f "$STATE" ]]; then
  PREV=$(cat "$STATE" 2>/dev/null || true)
  if [[ "$PREV" == "$SIGNAL" ]]; then CHANGED="no"; else CHANGED="yes"; fi
fi

# state の更新は書き込み先ディレクトリ内の mktemp + mv で原子的に行う。共有名の
# "$STATE.tmp" は 4 ロールが同じ status dir を共有するので衝突しうる。
STATE_DIR=$(dirname "$STATE")
mkdir -p "$STATE_DIR" 2>/dev/null || { echo "work-signal: cannot create state dir: $STATE_DIR" >&2; exit 1; }
TMP=$(mktemp "$STATE_DIR/.work-signal.XXXXXX") || { echo "work-signal: cannot create temp file" >&2; exit 1; }
printf '%s' "$SIGNAL" > "$TMP" && mv "$TMP" "$STATE" || {
  rm -f "$TMP"; echo "work-signal: cannot write state: $STATE" >&2; exit 1
}

printf 'signal=%s commit=%s mtime=%s screen=%s changed=%s\n' \
  "$SIGNAL" "$COMMIT_ISO" "${NEWEST:-none}" "$SCREEN_STATE" "$CHANGED"
