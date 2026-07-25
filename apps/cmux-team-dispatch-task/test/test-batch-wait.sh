#!/usr/bin/env bash
# batch-wait.sh の timeout terminal 化と全タスク待機を検査する。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WAIT="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/batch-wait.sh"
FETCH="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/issue-fetch.sh"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
LOOP="$TMP/repo/.dispatch-loop"; DISP="$TMP/repo/.dispatch"; STATE="$LOOP/loop-state.json"
mkdir -p "$LOOP" "$DISP/slug-a" "$DISP/slug-b"
fail=0
check() { if eval "$1"; then echo "PASS: $2"; else echo "FAIL: $2"; fail=1; fi; }
export LOOP_SESSION_ID=sess-w
bash "$FETCH" --state-file "$STATE" lock-acquire --lease-min 30 >/dev/null
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
jq -n --arg now "$now" '{issues:{"1":{slug:"slug-a",status:"dispatched",batch:1,claimed_at:$now},"2":{slug:"slug-b",status:"dispatched",batch:1,claimed_at:"2000-01-01T00:00:00Z"}},batches:[],leaked:[]}' > "$STATE"
echo '{"status":"executing"}' > "$DISP/slug-a/status.json"; echo '{"status":"executing"}' > "$DISP/slug-b/status.json"
run_wait() { DISPATCH_DIR="$DISP" bash "$WAIT" --state-file "$STATE" --batch 1 --timeout-min 60 --max-wait-sec "${1:-1}"; }
out=$(run_wait 1)
check '[[ "$out" == WAITING* ]]' 'W1 timeout 混在では ALL_TERMINAL を返さない'
check '[[ $(jq -r ".issues[\"2\"].status" "$STATE") == timeout ]]' 'W1 deadline 超過を timeout にする'
check '[[ $(jq -r ".status" "$DISP/slug-b/status.json") == error ]]' 'W1 status.json を error にする'
check '[[ -f "$LOOP/timed-out/slug-b" && ! -f "$DISP/slug-b/.timed-out" ]]' 'W2 sentinel は .dispatch-loop 配下'
rm -rf "$DISP/slug-b"; check '[[ -f "$LOOP/timed-out/slug-b" ]]' 'W3 タスク削除後も sentinel が残る'
echo '{"status":"done"}' > "$DISP/slug-a/status.json"; out=$(run_wait 1)
check '[[ "$out" == ALL_TERMINAL* ]]' 'W4 全件 terminal で ALL_TERMINAL'
old=$(jq -r '.heartbeat' "$LOOP/loop.lock.d/owner.json"); sleep 1; run_wait 1 >/dev/null; new=$(jq -r '.heartbeat' "$LOOP/loop.lock.d/owner.json")
check '[[ "$old" != "$new" ]]' 'W5 heartbeat が更新される'
# W6: 実際の runner 終了後に sentinel がある場合、削除済み status dir を復活させない。
LAUNCH="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/launch-workspace.sh"
mkdir -p "$TMP/bin" "$TMP/wt" "$DISP/slug-late"
cat > "$TMP/bin/cmux" <<'EOF'
#!/usr/bin/env bash
case "$1" in new-workspace) echo workspace:1;; list-pane-surfaces) echo surface:2;; esac
EOF
cat > "$TMP/bin/claude" <<'EOF'
#!/usr/bin/env bash
while [[ ! -f "$W6_BARRIER" ]]; do sleep 0.1; done
EOF
chmod +x "$TMP/bin/cmux" "$TMP/bin/claude"
res=$(PATH="$TMP/bin:$PATH" CMUX_BIN="$TMP/bin/cmux" bash "$LAUNCH" --cwd "$TMP/wt" --mode standby --status-dir "$DISP/slug-late" --timeout-sentinel "$LOOP/timed-out/slug-late" slug-late)
runner=$(jq -r '.runner_file' <<<"$res")
: > "$DISP/slug-late/.assigned-slug-late"; W6_BARRIER="$TMP/barrier" PATH="$TMP/bin:$PATH" bash "$runner" >/dev/null 2>&1 & pid=$!
sleep 1; mkdir -p "$LOOP/timed-out"; : > "$LOOP/timed-out/slug-late"; rm -rf "$DISP/slug-late"; : > "$TMP/barrier"; wait "$pid" || true
check '[[ ! -d "$DISP/slug-late" ]]' 'W6 sentinel が late write による status dir 復活を防ぐ'
bash "$FETCH" --state-file "$STATE" lock-release >/dev/null
[[ $fail -eq 0 ]] && echo '--- all tests passed ---' || echo '--- failures ---'
exit "$fail"
