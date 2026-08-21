#!/usr/bin/env bash
# monitor-dispatch.sh のレイアウト固定 (workspace のみ) の回帰テスト。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MONITOR="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/monitor-dispatch.sh"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/dispatch/t1"
echo '{"status":"done","message":"x"}' > "$TMP/dispatch/t1/status.json"

fail=0
pass() { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; fail=1; }

RUN_OUT="$TMP/run.out"
run_bounded() {
  : > "$RUN_OUT"
  "$@" > "$RUN_OUT" 2>&1 </dev/null &
  local pid=$! waited=0 rc
  while kill -0 "$pid" 2>/dev/null && (( waited < 100 )); do
    sleep 0.1
    waited=$((waited + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    return 124
  fi
  wait "$pid"; rc=$?
  return $rc
}

for flag_pair in "--layout workspace" "--layout split" "--parent-surface surface:9"; do
  flag_name="${flag_pair%% *}"
  rc=0
  # shellcheck disable=SC2086
  run_bounded zsh "$MONITOR" $flag_pair --dispatch-dir "$TMP/dispatch" --interval 1 || rc=$?
  case "$rc" in
    0) bad "L5 '$flag_pair' was accepted (must be rejected)" ;;
    124) bad "L5 '$flag_pair' hung (must be rejected immediately)" ;;
    *)
      if grep -Fq -- "$flag_name" "$RUN_OUT" && grep -Fq 'was removed' "$RUN_OUT"; then
        pass "L5 '$flag_pair' is rejected by the explicit removed-option case"
      else
        bad "L5 '$flag_pair' exited $rc but not via the removed-option case: $(tr '\n' ' ' < "$RUN_OUT")"
      fi
      ;;
  esac
done

# L5b: 配送は agmsg send.sh へ一本化され、この monitor がまだ叩いている
# この monitor がまだ叩いている旧配送スクリプトは削除された。壊れたまま黙って走る
# (通知が全部 || true で消える) のは
# 容認しないので、起動時に配送スクリプトの不在を名指しして落ちることを固定する。
# この monitor が agmsg send.sh へ移行したら、このテストは「正常起動で exit 0」へ戻す。
rc=0
run_bounded zsh "$MONITOR" --parent-workspace workspace:1 \
  --dispatch-dir "$TMP/dispatch" --interval 1 --heartbeat-interval 0 || rc=$?
if [[ "$rc" -eq 124 ]]; then
  bad 'L5b delivery-script guard hung (must fail immediately)'
elif [[ "$rc" -ne 0 ]] && grep -Fq 'delivery script not found' "$RUN_OUT" \
     && grep -Fq 'migrated to agmsg send.sh' "$RUN_OUT"; then
  pass 'L5b 配送スクリプトが無いときは起動時に名指しして落ちる (無音の通知喪失を許さない)'
else
  bad "L5b 配送スクリプト不在を検出できていない (exit=$rc): $(tr '\n' ' ' < "$RUN_OUT")"
fi

if grep -Eq 'send[[:space:]]+--surface|--to-surface' "$MONITOR"; then
  bad 'L6 monitor must not send to a surface'
else
  pass 'L6 monitor must not send to a surface'
fi
if grep -Fq -- '--to-workspace "$PARENT_WORKSPACE"' "$MONITOR"; then
  pass 'L6 monitor notifies the parent workspace'
else
  bad 'L6 monitor notifies the parent workspace'
fi

died_line=$(grep -F 'DIED (exit=' "$MONITOR" || true)
if [[ -z "$died_line" ]]; then
  bad 'L7 DIED message not found'
elif [[ "$died_line" == *"--layout"* ]]; then
  bad 'L7 DIED re-launch hint must not contain --layout'
else
  pass 'L7 DIED re-launch hint must not contain --layout'
fi

if grep -q 'PARENT_SURFACE' "$MONITOR"; then
  bad 'L8a PARENT_SURFACE must be gone'
else
  pass 'L8a PARENT_SURFACE must be gone'
fi
if grep -q 'LAYOUT' "$MONITOR"; then
  bad 'L8b LAYOUT must be gone'
else
  pass 'L8b LAYOUT must be gone'
fi

[[ $fail -eq 0 ]] && echo '--- all tests passed ---' || echo '--- failures ---'
exit "$fail"
