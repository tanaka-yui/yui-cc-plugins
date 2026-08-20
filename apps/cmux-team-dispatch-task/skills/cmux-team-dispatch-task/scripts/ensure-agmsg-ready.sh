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

AGMSG_DIR="${AGMSG_DIR:-$HOME/.agents/skills/agmsg/scripts}"
# AGMSG_DIR は比較に使うので絶対パス化する (~ を残さない)
case "$AGMSG_DIR" in "~"*) AGMSG_DIR="$HOME${AGMSG_DIR#\~}" ;; esac
AGMSG_READY_DIR="${AGMSG_READY_DIR:-$(dirname "$AGMSG_DIR")/run}"
AGMSG_LOG_DIR="${AGMSG_LOG_DIR:-${TMPDIR:-$HOME/.cache}/agmsg}"
AGMSG_READY_TIMEOUT="${AGMSG_READY_TIMEOUT:-15}"
# 値域検証。set -u 下の算術評価は非数値を変数名として再帰評価するので、検証しないと
# `deadline=$(( AGMSG_READY_TIMEOUT * 5 ))` が unbound variable でシェルごと落ちる。
# その時点で watcher は起動済みなので、無出力 rc 0 のまま孤児化する。
# 0 / 負値も seq の降順展開で直感に反する待機になるため既定値へ倒す。
# 先頭ゼロ (`0*`) も弾く。bash 算術は先頭ゼロを 8 進として解釈するので、`08` は
# 「value too great for base」で `deadline=$(( ... ))` ごと落ち (コマンド置換の
# サブシェル内なので親は死なず deadline が未設定のまま待機 0 回になる)、`010` は
# 無言で 10 ではなく 8 秒になる。`0*` は `0` 単体も包含する。guard_pid_valid と同形。
case "$AGMSG_READY_TIMEOUT" in ''|0*|*[!0-9]*) AGMSG_READY_TIMEOUT=15 ;; esac
# 桁数上限。全桁数字でも 20 桁のような値は `deadline=$(( ... * 5 ))` で 64bit 算術が
# ラップし、続く `seq 1 "$deadline"` がメモリを食い潰して xrealloc の致命エラーになる。
# 致命エラーは EXIT trap すら走らせないので、1 行契約がこの入力だけで破れる。
# 4 桁 (9999 秒) あれば現実の待機時間はすべて表現できる。
[[ "${#AGMSG_READY_TIMEOUT}" -le 4 ]] || AGMSG_READY_TIMEOUT=15
AGMSG_WATCH_INTERVAL="${AGMSG_WATCH_INTERVAL:-30}"

TYPE=""; NAME=""; PROJECT="$PWD"
INSTALLED=no; WIRED=no; WATCHER=none; PID="-"; REASON="-"; LOG="-"

EMITTED=0
emit() {  # 常にこれ 1 回だけで出力する
  EMITTED=1
  printf 'ensure-agmsg-ready: installed=%s wired=%s name=%s watcher=%s pid=%s reason=%s log=%s\n' \
    "$INSTALLED" "$WIRED" "${NAME:--}" "$WATCHER" "$PID" "$REASON" "$LOG"
}
# 「全経路で必ず 1 行」の構造的な安全網。emit を通らずにシェルが落ちた場合だけ発火する
# (emit 済みなら EMITTED=1 なので二重出力にはならない)。
# bash 3.2 はサブシェルで EXIT trap をリセットするので、`$( )` / `( )` / `&` のいずれでも
# 二重出力にはならない (実測済み)。
# この trap は SIGTERM / SIGHUP でも発火する。ペインを閉じた / ツール呼び出しを中断した
# ケースがそれで、REASON が初期値 `-` のまま emit すると「reason=- なのに watcher=none」
# という出力表に無い行になる。専用の reason=interrupted を立て、起動済みなら孤児 watcher の
# pid も出して手動 kill できるようにする。
#
#   reason=interrupted: シグナルで guard 自身が中断された。watcher=none。
#     pid は起動済みなら孤児 watcher の pid、未起動なら `-`。log は残す (削除しない)。
#     正常な emit を通った経路では REASON が必ず `-` 以外か EMITTED=1 なので発火しない。
#
# 3 つの代入を `REASON == "-"` の 1 ブロックにまとめてあるのは意図的である:
#   - WATCHER=none を強制しないと、WATCHER=started を立てた後 (手順 10 の rm -f 中など) に
#     シグナルを受けたときに `watcher=started reason=interrupted` という出力表に無い行が出る。
#   - REASON が既に別の値 (log-unwritable など) のときに PID を上書きすると、
#     `watcher=none pid=<n> reason=log-unwritable` という orphan-watcher 専用の組合せを
#     偽造してしまい、その reason の分類も失われる。
#   - PID は「今も生きている本物の watcher」に限る。guard_stop_watcher の 2 秒待機中に
#     シグナルを受けると、自分が既に SIGTERM を送った pid を「手動 kill せよ」と案内して
#     しまい、pid 周回で無関係なプロセスを殺させうる。
# WATCH_PID が未設定の間は関数定義前でも短絡するので、`command not found` は起きない。
trap '[[ $EMITTED -eq 1 ]] || { \
      if [[ "$REASON" == "-" ]]; then \
        REASON=interrupted; WATCHER=none; \
        if [[ -n "${WATCH_PID:-}" ]] && guard_pid_alive "$WATCH_PID" \
           && guard_is_watcher "$WATCH_PID"; then PID="$WATCH_PID"; fi; \
      fi; \
      emit; }' EXIT
hint() { printf 'ensure-agmsg-ready: %s\n' "$1" >&2; }
die_usage() {
  # 値域検証より前の die_usage 経路 (未知フラグ / 不正 --type) でも未検証の NAME を
  # 印字しないよう、ここで必ず落とす。改行入りの値は 1 行契約を破り、
  # 正常終了行に見える偽装行を作れてしまう。
  case "$NAME" in *[!A-Za-z0-9._-]*|'') NAME="" ;; esac
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
# 通らない値を name= に出さないのは die_usage 側の責務 (どの経路からでも効く)。
[[ "$NAME" =~ ^[A-Za-z0-9._-]+$ ]] || die_usage
[[ -d "$PROJECT" ]] || die_usage
# AGMSG_EXPECTED_NAME はセキュリティ境界ではなく、配線ミスの早期検出である。
if [[ -n "${AGMSG_EXPECTED_NAME:-}" && "$AGMSG_EXPECTED_NAME" != "$NAME" ]]; then die_usage; fi

# --- 手順 2: インストール確認 ---
if [[ ! -f "$AGMSG_DIR/send.sh" ]]; then
  REASON=not-installed; hint "agmsg is not installed at $AGMSG_DIR"; emit; exit 1
fi
INSTALLED=yes

# AGMSG_DIR に空白があると既存 watcher を一切検出できない。guard_is_watcher /
# guard_name_slot は `ps -o args=` の出力を `set -- $args` で単語分割してトークン等値
# 比較するので、`$AGMSG_DIR/watch.sh` 自体が複数トークンへ割れて必ず不一致になる。
# 帰結は「毎回 watcher=started で新しい watcher が増える」という**正常に見える**壊れ方
# なので、せめて診断できるよう hint を 1 行出す (prewarm-panes.sh が SCRIPT_DIR に
# 対して行っているのと同じ検出)。空白は現実の agmsg インストール先には現れないため、
# 正常系の stderr 0 行という契約はこの検出で壊れない。
case "$AGMSG_DIR" in
  *[[:space:]]*)
    hint "AGMSG_DIR contains whitespace ($AGMSG_DIR); existing watchers cannot be detected and a duplicate will be started on every call" ;;
esac

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

# _agmsg_pid_valid (instance-id.sh:69-99) と同じ値域検証。
# `^[1-9][0-9]*$` かつ 2147483647 以下。上限が必要なのは、INT32_MAX を超える pid に対して
# kill(1) が ESRCH ではなく引数エラーを返すためで、下の「No such process 以外は生存」
# という読み方だと巨大 pid が永久に alive と判定されてしまう。pid は pidfile 由来の
# 非信頼値なので、両呼び出し元 (生存判定と kill) からこの 1 箇所を通す。
guard_pid_valid() {
  local pid="$1"
  case "$pid" in ''|0*|*[!0-9]*) return 1 ;; esac
  [[ "${#pid}" -le 10 ]] || return 1
  [[ "$pid" -le 2147483647 ]] || return 1
  return 0
}

# _agmsg_pid_alive_local (instance-id.sh:112-139) と同じ意味論。
# 素の kill -0 は「シグナルを送れるか」であって生存判定ではない。EPERM を
# 「死」と読むと、注入中の watcher を kill したり生きた sentinel を消したりする。
guard_pid_alive() {
  local pid="$1" err stat
  guard_pid_valid "$pid" || return 1
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
    hint "a watcher with a bare instance id is running for this role (pid $p); it will never self-terminate — kill it manually"
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

# 正常系 (started / existing / existing-other) のログ削除。REASON が付いた実行では
# 事後解析のためにログを残す。LOG_PATH が /dev/null のときは絶対に削除しない — root では
# /dev/null が消え、非 root では rm が rc 1 を返す。
guard_drop_log() {
  [[ "$LOG_PATH" != /dev/null && "$REASON" == "-" ]] || return 0
  rm -f "$LOG_PATH"; LOG="-"
}

# --name は上の値域検証で [A-Za-z0-9._-]+ に限定済みで、agmsg-path.sh の
# agmsg_encode_component はその文字集合を素通しする = ここでは恒等写像である。
# したがってエンコーダを呼ぶ必要は無い。むしろ agmsg-path.sh を source すると、
# それが読めない環境 (権限・削除) で関数が未定義になり READY_ENC が空になる。
# 空だと手順 6/8/9 の glob `ready.*__$READY_ENC` が一切マッチせず、guard は自分で
# 起動した健全な watcher を start-timeout で殺してしまう (B1 と同じ自滅経路)。
# team 側は wildcard で扱うので agmsg_ready_path も不要であり、依存ごと持たない。
READY_ENC="$NAME"

if [[ -n "$CAND_KIND" ]]; then
  PID="$CAND_PID"
  [[ "$CAND_KIND" == mine ]] && WATCHER=existing || WATCHER=existing-other
  guard_drop_log
  emit; exit 0
fi

# --- 手順 6: stale sentinel の掃除 ---
# 生きた watcher の sentinel を消すと再作成されない (watch.sh:385-395 は起動時 1 回のみ)
# ので、pidfile の pid が生きているものは絶対に消さない。
for s in "$AGMSG_READY_DIR"/ready.*__"$READY_ENC"; do
  [[ -f "$s" ]] || continue
  t="$(head -1 "$s" 2>/dev/null || true)"
  # 中身を読めない = 判定不能であって stale ではない。watch.sh は `> "$_rp"` で書くので
  # 「存在するが空」の窓が実在し、ここで消すと生きた watcher の sentinel を永久に失う。
  [[ -n "$t" ]] || continue
  if [[ -f "$AGMSG_READY_DIR/watch.$t.pid" ]] \
     && guard_pid_alive "$(head -1 "$AGMSG_READY_DIR/watch.$t.pid" 2>/dev/null || true)"; then
    continue
  fi
  rm -f "$s"
done

# --- 手順 7: 起動 ---
# サブシェルで包まない / setsid を使わない / bash -c を挟まない。
# サブシェルは echo $! の直後に終了するのでプロセスが pid 1 へ再親付けされ、
# agmsg の ppid ウォークが失敗して bare id になる (実測 3/3)。
# fd 3 本すべてを付け替える。呼び出し元のパイプを 1 本でも残すと、
# コマンド置換が EOF を待って戻らなくなる。
AGMSG_WATCH_INTERVAL="$AGMSG_WATCH_INTERVAL" \
nohup bash "$AGMSG_DIR/watch.sh" "$SID" "$PROJECT" "$TYPE" "$NAME" </dev/null >>"$LOG_PATH" 2>&1 &
WATCH_PID=$!

# 起動した watcher の正規化 id を pidfile から復元する。
# 手順 5 と同じ session-id フィルタを必ず先に通す。pid 値だけで照合すると、SIGKILL で
# ペインが落ちて EXIT trap が走らずに残った**他ロールの stale pidfile**が、たまたま
# $WATCH_PID と同じ pid 番号を持っていたときにそちらを「自分」と誤認する
# (macOS の pid は周回し、run/ には残骸が蓄積する)。誤認すると sentinel の中身と
# 一致しないまま時間切れになり、guard_stop_watcher が**健全な自分の watcher を
# SIGTERM で殺す**うえ、guard_clean_my_sentinels も誤った id で掃除に失敗する。
guard_my_norm_id() {
  local f id p
  for f in "$AGMSG_READY_DIR"/watch.*.pid; do
    [[ -f "$f" ]] || continue
    id="$(guard_normalized_id_from_pidfile "$f")"
    # 手順 5 と同じ厳密形にする。`$SID.<任意>` まで受理すると、`s22.0abc` のような
    # 数字でない suffix を持つ decoy pidfile (glob 順で純数字より前に来る) が
    # 「自分」として通り、B1 と同じ形で健全な watcher を殺せてしまう。
    case "$id" in
      "$SID") ;;
      "$SID".*) [[ "${id#"$SID".}" =~ ^[0-9]+$ ]] || continue ;;
      *) continue ;;
    esac
    p="$(head -1 "$f" 2>/dev/null || true)"
    [[ "$p" == "$WATCH_PID" ]] || continue
    printf '%s' "$id"; return 0
  done
  return 1
}

# SIGTERM のみ。kill -9 は watch.sh の trap を飛ばして sentinel と pidfile を残す。
guard_stop_watcher() {
  local i
  # kill 規則 1: 値域検証 (`kill 0` は呼び出し元のプロセスグループ全員へ SIGTERM を送る)
  guard_pid_valid "$WATCH_PID" || return 1
  guard_is_watcher "$WATCH_PID" || return 1     # 判定不能 (rc 2) でも kill しない
  # ジョブ表から外してから撃つ。外さないと bash が非対話でも
  # `line N: <pid> Terminated: 15  AGMSG_WATCH_INTERVAL=... nohup bash ...` を stderr へ出し、
  # spec が「see <log>」1 行と定めた stderr に内部変数込みのコマンドラインが混ざる。
  # `wait` でも吸えるが、SIGTERM を無視する watcher で無限に待つので使わない
  # (この関数は 2 秒で諦める契約)。
  disown "$WATCH_PID" 2>/dev/null || true
  kill -TERM "$WATCH_PID" 2>/dev/null || true
  for i in $(seq 1 20); do
    guard_pid_alive "$WATCH_PID" || return 0
    sleep 0.1
  done
  return 1
}

guard_clean_my_sentinels() {   # 自分の正規化 id を持つ sentinel だけ消す
  local s t; local mine="$1"
  # 手順 6 と同じクォート形にする。文字列変数を未クォート展開すると、glob だけでなく
  # ディレクトリ部分まで単語分割され、空白入りパスで 1 件もマッチしなくなる。
  for s in "$AGMSG_READY_DIR"/ready.*__"$READY_ENC"; do
    [[ -f "$s" ]] || continue
    t="$(head -1 "$s" 2>/dev/null || true)"
    [[ "$t" == "$mine" ]] && rm -f "$s"
  done
}

classify_from_log() {
  if grep -q '^agmsg watch: cannot claim' "$LOG_PATH" 2>/dev/null; then
    REASON=held-by-other-session
    hint "run /agmsg drop $NAME in the owning session, then retry"
  elif grep -q '^agmsg watch: no registration' "$LOG_PATH" 2>/dev/null; then
    REASON=not-registered; hint "run join.sh for this role first; see $LOG"
  elif grep -q '^ERROR: cannot open message DB' "$LOG_PATH" 2>/dev/null; then
    REASON=db-unavailable; hint "see $LOG"
  else
    REASON=watcher-exited; hint "see $LOG"
  fi
}

# --- 手順 8: 待機 ---
deadline=$(( AGMSG_READY_TIMEOUT * 5 ))
mine=""; done_ok=""
# 反復数を `$(seq 1 "$deadline")` から取らない。seq が失敗する (PATH の差し替え・rc 127)
# だけで反復 0 回になり、健全な watcher を即 kill する / pidfile-missing と誤分類する、
# という先頭ゼロ timeout と同じ壊れ方をする。算術ループなら外部コマンドに依存しない。
iter=0
while [[ $iter -lt $deadline ]]; do
  iter=$((iter + 1))
  mine="$(guard_my_norm_id || true)"
  if [[ -n "$mine" ]]; then
    for s in "$AGMSG_READY_DIR"/ready.*__"$READY_ENC"; do
      [[ -f "$s" ]] || continue
      # sentinel の中身が自分の正規化 id と一致することまで確認する。
      # 存在だけを見ると、他セッションの生きた sentinel を掴んで偽の started を返す。
      [[ "$(head -1 "$s" 2>/dev/null || true)" == "$mine" ]] && { done_ok=1; break; }
    done
  fi
  [[ -n "$done_ok" ]] && break
  guard_pid_alive "$WATCH_PID" || { classify_from_log; WATCHER=none; emit; exit 0; }
  sleep 0.2
done

if [[ -z "$done_ok" ]]; then
  if [[ -z "$mine" ]]; then
    if ! guard_pid_alive "$WATCH_PID"; then
      classify_from_log; WATCHER=none; emit; exit 0
    fi
    # 待機の全期間を通して自分の pidfile が一度も見つからなかった。bare とは違い、
    # AGMSG_READY_DIR の指し違いや $SID の不正でも起きる。ここで kill すると
    # 健全な watcher を毎回殺すので、mine 不明のときは絶対に kill しない。
    REASON=pidfile-missing; WATCHER=none
    hint "no pidfile under $AGMSG_READY_DIR; it must match \$(dirname AGMSG_DIR)/run"
    emit; exit 0
  fi
  if guard_stop_watcher; then
    guard_clean_my_sentinels "$mine"
    REASON=start-timeout; hint "see $LOG"
  else
    REASON=orphan-watcher; PID="$WATCH_PID"
    hint "watcher $WATCH_PID did not stop; kill it manually. see $LOG"
  fi
  WATCHER=none; emit; exit 0
fi

# sentinel を書いた直後に watch.sh が exit するレースがあるので再確認する
if ! guard_pid_alive "$WATCH_PID"; then
  classify_from_log; WATCHER=none; emit; exit 0
fi

# --- 手順 9: composite 検証 ---
# done_ok が真の時点で mine は必ず非空 (手順 8 のループが mine 判定と同一反復で
# done_ok を立てて break するため)。pidfile 不在の分岐は手順 8 側で処理済み。
if ! guard_is_composite "$mine"; then
  # kill 規則 6: kill を諦めた / 2 秒以内に死ななかった場合は bare-started ではなく
  # orphan-watcher。自己終了しない watcher が残るので、手動 kill 用に pid を出す。
  if guard_stop_watcher; then
    guard_clean_my_sentinels "$mine"
    REASON=bare-started; hint "see $LOG"
  else
    REASON=orphan-watcher; PID="$WATCH_PID"
    hint "watcher $WATCH_PID did not stop; kill it manually. see $LOG"
  fi
  WATCHER=none; emit; exit 0
fi

WATCHER=started; PID="$WATCH_PID"

# --- 手順 10: 正常系のログ削除 ---
guard_drop_log
emit
exit 0
