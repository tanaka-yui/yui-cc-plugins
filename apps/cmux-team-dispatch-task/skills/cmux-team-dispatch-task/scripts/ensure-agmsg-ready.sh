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

# --- 共通ルール ---
# 正規化 id は pidfile 名そのもの。剥がしは session-start.sh:221 と同形。
guard_normalized_id_from_pidfile() {
  local id=${1##*/}; id=${id#watch.}; id=${id%.pid}; printf '%s' "$id"
}

# agmsg_instance_is_composite (instance-id.sh:171-183) の 3 条件を逐語で写す。
guard_is_composite() {
  local token="$1" pid prefix
  case "$token" in *.*) ;; *) return 1 ;; esac
  pid="${token##*.}"; prefix="${token%.*}"
  [[ -n "$prefix" ]] || return 1
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  return 0
}

# _agmsg_pid_alive_local (instance-id.sh:112-139) と同じ意味論。
# 素の kill -0 は「シグナルを送れるか」であって生存判定ではない。EPERM を
# 「死」と読むと、注入中の watcher を kill したり生きた sentinel を消したりする。
guard_pid_alive() {
  local pid="$1" err stat
  case "$pid" in ''|*[!0-9]*|0*) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null && return 0
  err="$(export LC_ALL=C; kill -0 "$pid" 2>&1)" && return 0
  case "$err" in
    *[Nn]'o such process'*) ;;
    *) return 0 ;;   # EPERM とその他は生存
  esac
  stat="$(ps -o stat= -p "$pid" 2>/dev/null | tr -d ' ')"
  [[ -n "$stat" ]] || return 1
  case "$stat" in Z*) return 1 ;; esac
  return 0
}

guard_args() { ps -ww -p "$1" -o args= 2>/dev/null; }

# argv[0] または argv[1] が $AGMSG_DIR/watch.sh とフルパスで等価であること。
# agmsg 本体より厳しいが、Claude Code の Bash ツールが張るラッパーシェル
# (argv[0]=/bin/zsh, argv[1]=-c) を確実に落とすために意図的にそうする。
guard_is_watcher() {
  local args a1 a2
  args="$(guard_args "$1")"; [[ -n "$args" ]] || return 2   # 2 = 判定不能
  # shellcheck disable=SC2086
  set -f; set -- $args; set +f
  a1="${1:-}"; a2="${2:-}"
  [[ "$a1" == "$AGMSG_DIR/watch.sh" || "$a2" == "$AGMSG_DIR/watch.sh" ]]
}

# 名前スロット = watch.sh を 1 番目に数えた 5 番目のトークン。
# 「argv のどこかに含まれる」だと型引数 (claude-code/codex) やパスの
# 1 コンポーネントが --name と一致して誤ヒットする。
guard_name_slot() {
  local args; args="$(guard_args "$1")"; [[ -n "$args" ]] || return 1
  # shellcheck disable=SC2086
  set -f; set -- $args; set +f
  local i=0 t
  for t in "$@"; do
    i=$((i + 1))
    if [[ "$t" == "$AGMSG_DIR/watch.sh" ]]; then
      shift $((i - 1)); printf '%s' "${5:-}"; return 0
    fi
  done
  return 1
}

# --- 手順 5: 候補の判定 ---
# 自分の起動が壊しうるのは「正規化 id が自分と同じ watcher」だけ (watch.sh:165-179)。
# 正規化 id は必ず $SID か $SID.<pid> になるので、この 2 形だけを見る。
CAND_PID=""; CAND_KIND=""
for f in "$AGMSG_READY_DIR"/watch.*.pid; do
  [[ -f "$f" ]] || continue
  id="$(guard_normalized_id_from_pidfile "$f")"
  case "$id" in
    "$SID") ;;
    "$SID".*) [[ "${id#"$SID".}" =~ ^[0-9]+$ ]] || continue ;;
    *) continue ;;
  esac
  p="$(head -1 "$f" 2>/dev/null || true)"
  guard_pid_alive "$p" || continue
  # bare は自分の起動 (composite の pidfile) と衝突しないので候補にしない。
  # かつ bare は永久に自己終了しないので、候補に数えると恒久ブロックになる。
  if ! guard_is_composite "$id"; then
    hint "a watcher with a bare instance id is running for this role (pid $p); it will never self-terminate - kill it manually"
    continue
  fi
  guard_is_watcher "$p"; rc=$?
  [[ $rc -eq 1 ]] && continue                      # watcher ではない
  if [[ $rc -eq 2 ]]; then                          # argv 不明 → 名前を判定できない
    CAND_PID="${CAND_PID:-$p}"; CAND_KIND=other; continue
  fi
  if [[ "$(guard_name_slot "$p" || true)" == "$NAME" ]]; then
    CAND_PID="$p"; CAND_KIND=mine; break
  fi
  CAND_PID="${CAND_PID:-$p}"; CAND_KIND="${CAND_KIND:-other}"
done

if [[ -n "$CAND_KIND" ]]; then
  PID="$CAND_PID"
  [[ "$CAND_KIND" == mine ]] && WATCHER=existing || WATCHER=existing-other
  emit; exit 0
fi

# --- 手順 6: stale sentinel の掃除 ---
# 生きた watcher の sentinel を消すと再作成されない (watch.sh:385-395 は起動時 1 回のみ)
# ので、pidfile の pid が生きているものは絶対に消さない。
for s in "$AGMSG_READY_DIR"/ready.*__"$(agmsg_encode_component "$NAME")"; do
  [[ -f "$s" ]] || continue
  t="$(head -1 "$s" 2>/dev/null || true)"
  if [[ -n "$t" && -f "$AGMSG_READY_DIR/watch.$t.pid" ]] \
     && guard_pid_alive "$(head -1 "$AGMSG_READY_DIR/watch.$t.pid" 2>/dev/null || true)"; then
    continue
  fi
  rm -f "$s"
done

# --- 手順 7-9 は Task 5 で実装する。暫定: 常に起動して待つ ---
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
