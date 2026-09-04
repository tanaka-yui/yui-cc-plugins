#!/usr/bin/env bash
# orca-wait.sh — 自分の worker の worker_done を待つ。
# 実測 (spec 6-5): cursor を進めるのは ack だけ (O22/O23) / --types は batch を絞らない (O27)
#                  keepalive は stderr、2>&1 で混ぜない (O10) / selector は --terminal
# **ack は「batch 全件を処理した」の宣言である** (O11)。処理できない message が 1 つでも
# あれば ack しない。Stage 1 の親は worker_done しか処理できないので、それ以外が来たら
# 診断を出して止まる（Task spec 側で ask / escalation を禁じてある）。
# **ledger も再 emit も pending replay も無い**（Stage 1。spec 18-1）。
# Usage: orca-wait.sh --status-dir <d> [--max-waits <n>] [--timeout-ms <n>]
# Exit: 0 成功 / 5 失敗 / 1 受信失敗 / 2 使用法 / 3 時間切れ / 4 worker が不健全
set -uo pipefail
die() { echo "orca-wait: $1" >&2; exit 2; }
log() { echo "orca-wait: $1" >&2; }
ORCA_BIN="${ORCA_BIN:-/Applications/Orca.app/Contents/Resources/bin/orca}"
need2() { [[ "$2" -ge 2 ]] || die "$1 requires a value"; }
SD="" MAXW=12 TMO=300000
while [[ $# -gt 0 ]]; do case "$1" in
  --status-dir) need2 "$1" $#; SD="$2";   shift 2 ;;
  --max-waits)  need2 "$1" $#; MAXW="$2"; shift 2 ;;
  --timeout-ms) need2 "$1" $#; TMO="$2";  shift 2 ;;
  *) die "unknown option: $1" ;;
esac; done
[[ -n "$SD" ]] || die "--status-dir is required"
[[ -r "$SD/run.json" && -r "$SD/workers.json" ]] || die "cannot read the dispatch state in $SD"
PH=$(jq -r '.parent_handle' "$SD/run.json")
TID=$(jq -r '.design.task // empty' "$SD/workers.json")
DID=$(jq -r '.design.dispatch // empty' "$SD/workers.json")
[[ -n "$PH" && -n "$TID" && -n "$DID" ]] || die "the dispatch identity is incomplete"
RECV="$SD/received.json"; [[ -f "$RECV" ]] || printf '[]\n' > "$RECV"
write() {
  local t
  t=$(mktemp "$SD/.tmp.XXXXXX") || return 1
  printf '%s\n' "$2" > "$t" && mv -f "$t" "$1" || { rm -f "$t"; return 1; }
}

drain() {   # 0 = batch を処理し切った / 1 = 処理できないものがあった（ack しない）
  local out res n i m d t tid did oc REL RST
  out=$("$ORCA_BIN" orchestration check --terminal "$PH" --json 2>/dev/null) || return 1
  res=$(jq -c '.result // {}' <<<"$out" 2>/dev/null) || return 1
  n=$(jq -r '.messages | length // 0' <<<"$res" 2>/dev/null || echo 0)
  [[ "$n" -gt 0 ]] || return 0
  d=$(jq -r '.deliveryId // empty' <<<"$res")
  for ((i = 0; i < n; i++)); do
    m=$(jq -c ".messages[$i]" <<<"$res")
    t=$(jq -r '.type // empty' <<<"$m")
    tid=$(jq -r '.payload.taskId // empty' <<<"$m")
    did=$(jq -r '.payload.dispatchId // empty' <<<"$m")
    # ★ **処理できない message は捨てない。**捨てて ack すると cursor だけ進んで内容が消える
    if [[ "$t" != worker_done ]] || [[ "$tid" != "$TID" || "$did" != "$DID" ]]; then
      log "batch $d carries a message this version cannot handle (type='$t' task='$tid' dispatch='$did')"
      log "it is NOT acknowledged, so nothing is lost. Inspect with:"
      log "  $ORCA_BIN orchestration check --terminal $PH --peek --json"
      return 1
    fi
    oc=$(jq -r '.payload.outcome // empty' <<<"$m")
    case "$oc" in
      succeeded|failed) ;;
      *) log "worker_done has outcome '${oc:-none}'"; return 1 ;;
    esac
    # 冪等: 同じ (task, dispatch, outcome) は 1 度だけ。message id は再送で変わる
    if ! jq -e --arg k "worker_done|$tid|$did|$oc" 'index($k) != null' "$RECV" >/dev/null 2>&1; then
      write "$RECV" "$(jq --arg k "worker_done|$tid|$did|$oc" '. + [$k]' "$RECV")" || return 1
    fi
    # ★ **ack より前に owner を決める** (Orca guide)。accepted な worker_done のあとは
    #   `worker-release` が既定であり、retain は「ユーザーが明示的にデバッグ保持を依頼した
    #   場合」の例外である。この版はその依頼を取らないので release を使う。
    #   この端末は terminal create 済みの external/reused なので、release は閉じずに
    #   `retained` を返す — 手動 cleanup まで残るのはそのためであって、retain の結果ではない。
    #   **exit 0 は「完了した」の証明ではない。**pending / unknown では ack しない
    REL=$("$ORCA_BIN" orchestration worker-release --dispatch "$DID" --json 2>/dev/null)
    RST=$(jq -r '.result.state // empty' <<<"$REL" 2>/dev/null || echo "")
    case "$RST" in
      retained|already_released) ;;
      *)
        log "worker-release reported '${RST:-none}'; not acknowledging (it will be retried)"
        return 1
        ;;
    esac
  done
  [[ -z "$d" ]] || "$ORCA_BIN" orchestration check --terminal "$PH" --ack "$d" --json >/dev/null 2>&1 || {
    log "ack failed; the batch will replay"
    return 1
  }
  return 0
}
outcome_of() {   # 受信済みと status が一致した結論を返す。無ければ空
  local st oc
  st=$(jq -r '.status // empty' "$SD/roles/design/status.json" 2>/dev/null || echo "")
  case "$st" in
    done) oc=succeeded ;;
    error) oc=failed ;;
    *) return 1 ;;
  esac
  jq -e --arg k "worker_done|$TID|$DID|$oc" 'index($k) != null' "$RECV" >/dev/null 2>&1 || return 1
  printf '%s' "$oc"
}
finish() {
  local oc="$1"
  echo "outcome=$oc"
  [[ "$oc" == succeeded ]] && exit 0 || exit 5
}
healthy() {   # **人の入力待ちは healthy である**（CLI help）
  local show st wait
  show=$("$ORCA_BIN" orchestration worker-show --dispatch "$DID" --json 2>/dev/null) || return 1
  jq -e . <<<"$show" >/dev/null 2>&1 || return 1
  wait=$(jq -r '.result.observation.agentWait // empty' <<<"$show")
  [[ -n "$wait" && "$wait" != null ]] && return 0
  st=$(jq -r '.result.worker.state // empty' <<<"$show")
  case "$st" in
    active|ready|starting|idle) return 0 ;;
    *) log "the worker is '$st'"; return 1 ;;
  esac
}

drain || exit 1
oc=$(outcome_of) && finish "$oc"
n=0
while :; do
  "$ORCA_BIN" orchestration check --terminal "$PH" --wait --timeout-ms "$TMO" --json >/dev/null 2>&1 || true
  drain || exit 1
  oc=$(outcome_of) && finish "$oc"
  healthy || exit 4
  n=$((n + 1))
  [[ "$n" -lt "$MAXW" ]] || { log "reached --max-waits ($MAXW); inspect and decide"; exit 3; }
done
