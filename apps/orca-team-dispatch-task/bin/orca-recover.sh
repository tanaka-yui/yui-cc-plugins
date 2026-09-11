#!/usr/bin/env bash
# orca-recover.sh — 完了を託した worker が失われたときに、その所有権を回復する（spec 10-1 / F-e）。
#
# Usage: orca-recover.sh --status-dir <d> [--role <r>] [--dry-run]
# Exit:  0 = 判断して行動した（何もしないという判断を含む）/ 1 = 判断できない / 2 = 使用法エラー
#
# ★ **なぜ要るか。**O33 により **親は `worker_done` を代理送信できない。**したがって
#   「再送を促す」だけでは、元の agent process が消えたときに誰も送れない。これは失敗系
#   だけの問題ではなく、`completion.json = accepted` / `status.json = done` の後・
#   `worker_done` の前に worker が失われた **成功系にも同じく存在する**。
#
# ★ **回復するのは「durable intent を実行できる owner」であって、completion の
#   exactly-once journal ではない。**disk の intent（`status.json` の done / error）は
#   既にそこに在る。それを送れる誰かを取り戻す。
#
# ★ **fence が先。**旧 capability と新 capability が同時に lifecycle を進めてはならない。
#   だから `outcome_unknown` では replacement を作らない（O19）。

set -uo pipefail
die() { echo "orca-recover: $1" >&2; exit 2; }
log() { echo "orca-recover: $1" >&2; }
ORCA_BIN="${ORCA_BIN:-${ORCA_CLI_COMMAND:-/Applications/Orca.app/Contents/Resources/bin/orca}}"

SD="" ONLY_ROLE="" DRY=0
while [[ $# -gt 0 ]]; do case "$1" in
  --status-dir) [[ $# -ge 2 ]] || die '--status-dir requires a value'; SD="$2"; shift 2 ;;
  --role)       [[ $# -ge 2 ]] || die '--role requires a value'; ONLY_ROLE="$2"; shift 2 ;;
  --dry-run)    DRY=1; shift ;;
  *) die "unknown option: $1" ;; esac; done
[[ -n "$SD" ]] || die "--status-dir is required"
[[ -r "$SD/workers.json" && -r "$SD/run.json" ]] || die "cannot read the dispatch state in $SD"

PH=$(jq -r '.parent_handle // empty' "$SD/run.json" 2>/dev/null)
[[ -n "$PH" ]] || die "no parent handle recorded"

CMP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/skills/orca-team-dispatch-task/scripts/completion.sh"

# ★ **回復に入る前に「誰か待っているか」を言う。**待機は最大 24 時間常駐するので外から
#   止められることがあり（`orca-wait.sh` の beat）、止まったままだと worker は生きている
#   のに誰も受理を返さない。そのとき要るのは replacement ではなく **待機の起動し直し**で
#   ある。**役ごとの判断は変えない** — 見落とさせないために言うだけである。
WLIVE="$SD/wait.json"
if [[ ! -f "$WLIVE" ]]; then
  log "no wait has stamped this status dir; if a worker is alive, start orca-wait.sh before recovering"
else
  wl_beat=$(jq -r '.beat // empty' "$WLIVE" 2>/dev/null || echo "")
  wl_win=$(jq -r '.window_ms // empty' "$WLIVE" 2>/dev/null || echo "")
  [[ "$wl_win" =~ ^[0-9]+$ ]] || wl_win=300000
  if [[ "$wl_beat" =~ ^[0-9]+$ ]]; then
    # ★ 沈黙 3 窓ぶんで「居ない」とみなす。1 窓は待ちの上限そのものなので、2 窓では
    #   正常な 1 回の待ちを死んだと呼びかねない
    wl_max=$(( wl_win / 1000 * 3 )); [[ "$wl_max" -ge 60 ]] || wl_max=60
    wl_age=$(( $(date +%s) - wl_beat ))
    [[ "$wl_age" -lt "$wl_max" ]] \
      || log "no wait has answered for ${wl_age}s (its window is $(( wl_win / 1000 ))s); start orca-wait.sh again before recovering"
  fi
fi

rc_all=0
while IFS= read -r role; do
  [[ -z "$ONLY_ROLE" || "$ONLY_ROLE" == "$role" ]] || continue
  did=$(jq -r --arg r "$role" '.roles[$r].dispatch // empty' "$SD/workers.json")
  tid=$(jq -r --arg r "$role" '.roles[$r].task // empty' "$SD/workers.json")
  [[ -n "$did" && -n "$tid" ]] || continue
  rd="$SD/roles/$role"

  # ★ **その役に「まだ送るべきもの」があるか。**無いなら回復するものも無い。
  #   成功系は completion.json が settled でないこと、失敗系は status.json = error である。
  ph=$(bash "$CMP" --role-dir "$rd" phase 2>/dev/null || echo "")
  st=$(jq -r '.status // empty' "$rd/status.json" 2>/dev/null || echo "")
  if [[ "$ph" == settled ]]; then
    log "$role: already settled locally; nothing is owed"
    continue
  fi
  if [[ -z "$ph" && "$st" != error ]]; then
    log "$role: nothing is owed yet (phase '${ph:-none}', status '${st:-none}')"
    continue
  fi

  SHRC=0; SHOW=""
  SHOW=$("$ORCA_BIN" orchestration worker-show --dispatch "$did" --json 2>/dev/null) || SHRC=$?
  if [[ "$SHRC" -ne 0 ]] || ! jq -e '.ok == true and (.result | type == "object")' <<<"$SHOW" >/dev/null 2>&1; then
    log "$role: cannot read the worker state for dispatch '$did'; not deciding anything"
    rc_all=1; continue
  fi
  state=$(jq -r '.result.worker.state // empty' <<<"$SHOW")
  dstatus=$(jq -r '.result.dispatch.status // empty' <<<"$SHOW")

  case "$dstatus" in
    completed|failed|settled|terminated)
      # ★ **Orca 側が既に terminal。送らない。**ローカルを合わせて終わる。
      if [[ "$DRY" -eq 1 ]]; then echo "$role: reconcile (orca is terminal)"; continue; fi
      if [[ -n "$ph" && "$ph" != settled ]]; then
        bash "$CMP" --role-dir "$rd" reconcile >/dev/null 2>&1 \
          || log "$role: could not reconcile the local record to settled"
      fi
      log "$role: Orca already settled this dispatch; reconciled locally"
      continue ;;
  esac

  case "$state" in
    active|ready|starting|idle)
      # ★ **生きているなら nudge するだけ。**replacement を作ると、旧 capability と
      #   新 capability が同時に lifecycle を進めうる。
      if [[ "$DRY" -eq 1 ]]; then echo "$role: nudge"; continue; fi
      "$ORCA_BIN" orchestration send --to "dispatch:$did" --type status \
        --subject "completion-nudge: $role" \
        --body "your completion is still owed; continue from your completion record" \
        --from "$PH" --json >/dev/null 2>&1 \
        && log "$role: nudged the live worker" \
        || { log "$role: could not nudge dispatch '$did'"; rc_all=1; }
      # ★ **nudge も届くだけでは起こせない。**`orchestration send` はメールボックスに
      #   入れるだけである（実測 2026-09-10: nudge が効かず、端末への直接入力で解けた）。
      #   **ベストエフォート** — 起こせないことは「回復できなかった」ではないので rc を汚さない。
      bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/orca-wake.sh" \
        --workers "$SD/workers.json" --role "$role" >/dev/null 2>&1 \
        || log "$role: could not wake its terminal; the nudge may sit unread"
      continue ;;
    failed|stopped)
      # ★ **失われたことが証明された。**同じ Task へ replacement を作る。
      #   `task-create` は走らせない — Task は既に在る。
      if [[ "$DRY" -eq 1 ]]; then echo "$role: replace"; continue; fi
      wt=$(jq -r --arg r "$role" '.roles[$r].worktree_id // empty' "$SD/workers.json")
      agent=$(jq -r --arg r "$role" '.roles[$r].agent // "claude"' "$SD/workers.json")
      model=$(jq -r --arg r "$role" '.roles[$r].model // empty' "$SD/workers.json")
      effort=$(jq -r --arg r "$role" '.roles[$r].effort // empty' "$SD/workers.json")
      [[ -n "$wt" ]] || { log "$role: no worktree recorded; refusing to place a replacement"; rc_all=1; continue; }
      args=(--task "$tid" --worktree "id:$wt" --retry-of "$did" --agent "$agent" --from "$PH")
      if [[ -n "$model" ]]; then
        args+=(--model "$model"); [[ -n "$effort" ]] && args+=(--effort "$effort")
      fi
      WRC=0; WJ=$("$ORCA_BIN" orchestration worker-start "${args[@]}" --json 2>/dev/null) || WRC=$?
      nd=$(jq -r '.result.dispatchId // empty' <<<"$WJ" 2>/dev/null || echo "")
      nh=$(jq -r 'first(.result.effects[]? | select(.kind == "terminal" and .role == "agent") | .id) // empty' \
             <<<"$WJ" 2>/dev/null || echo "")
      if [[ "$WRC" -ne 0 || "$(jq -r '.result.state // empty' <<<"$WJ")" != ready || -z "$nd" ]]; then
        log "$role: could not start a replacement (rc=$WRC); the old resources are KEPT"
        rc_all=1; continue
      fi
      # ★ **generation を上げる。**旧 generation の accepted は nonce 照合で落ちる。
      gen=$(jq -r --arg r "$role" '.roles[$r].generation // 1' "$SD/workers.json")
      gen=$(( gen + 1 ))
      tmp=$(mktemp "$SD/.workers.XXXXXX") || { log "mktemp failed"; rc_all=1; continue; }
      jq -c --arg r "$role" --arg d "$nd" --arg h "$nh" --argjson g "$gen" \
        '.roles[$r] += {dispatch:$d, terminal:$h, generation:$g, retained:false}' \
        "$SD/workers.json" > "$tmp" && mv -f "$tmp" "$SD/workers.json" \
        || { rm -f "$tmp"; log "$role: the replacement started as $nd but could not be recorded"; rc_all=1; continue; }
      # 旧試行の完了記録は捨てる。新しい worker は新しい nonce で offer し直す
      rm -f "$rd/completion.json"
      log "$role: replaced dispatch $did with $nd (generation $gen)"
      continue ;;
    *)
      # ★ `outcome_unknown` を含め、**確認できないものでは replacement を作らない**（O19）。
      log "$role: the worker state is '${state:-unknown}'; not replacing anything. Inspect with:"
      log "  $ORCA_BIN orchestration worker-show --dispatch $did --json"
      rc_all=1; continue ;;
  esac
done < <(jq -r '.roles | keys[]' "$SD/workers.json" 2>/dev/null)

exit "$rc_all"
