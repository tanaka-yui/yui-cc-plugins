#!/usr/bin/env bash
set -uo pipefail
P="$(cd "$(dirname "$0")/.." && pwd)"
fails=0; ok() { echo "PASS: $1"; }; fail() { echo "FAIL: $1"; fails=$((fails+1)); }
setup() {
  unset ORCA_TERMINAL_HANDLE
  W=$(mktemp -d); export W ORCA_DISPATCH_CONFIG_HOME="$W/config"
  export ORCA_BIN="$P/test/lib/orca-stub.sh" ORCA_STUB_DIR="$W/orca"
  mkdir -p "$ORCA_STUB_DIR" "$W/sd"; : > "$ORCA_STUB_DIR/calls.log"
  printf '{"run_id":"run_1","parent_handle":"term_c1","repo_root":"/repo"}' > "$W/sd/run.json"
  echo '{"ok":true,"result":{"terminal":{"handle":"term_new"}}}' > "$ORCA_STUB_DIR/terminal_create"
  echo '{"ok":true,"result":{"terminal":{"handle":"term_c1","orphaned":false,"connected":true}}}' > "$ORCA_STUB_DIR/terminal_show"
  echo '{"ok":true,"result":{"run":{"id":"run_1","coordinator_handle":"term_c1"}}}' > "$ORCA_STUB_DIR/orchestration_run-current"
}
teardown() { rm -rf "$W"; unset ORCA_BIN ORCA_STUB_DIR ORCA_DISPATCH_CONFIG_HOME; }
coord() { node --input-type=module -e "import { $1 } from '$P/lib/auto-coordinator.ts'; console.log($1($2))"; }
setup; out=$(coord openCoordinator "'/repo', 'auto-test'" 2>/dev/null)
[[ "$out" == term_new ]] && grep -Fq 'terminal create --worktree path:/repo --title orca-auto:auto-test --json' "$ORCA_STUB_DIR/calls.log" && ok AU1 || fail AU1; teardown
setup; out=$(coord ensureCoordinator "'$W/sd', '/repo', 'auto-test'" 2>/dev/null)
[[ "$out" == term_c1 ]] && ! grep -q 'terminal create' "$ORCA_STUB_DIR/calls.log" && ok AU2 || fail AU2; teardown
for variant in closed stale fenced null; do
  setup
  case "$variant" in
    closed) echo '{"ok":true,"result":{"terminal":{"handle":"term_c1","orphaned":true,"connected":false}}}' > "$ORCA_STUB_DIR/terminal_show" ;;
    stale) echo '{"ok":false,"error":{"code":"terminal_handle_stale"}}' > "$ORCA_STUB_DIR/terminal_show"; echo 1 > "$ORCA_STUB_DIR/terminal_show.rc" ;;
    fenced) echo '{"ok":true,"result":{"run":{"id":"run_1","coordinator_handle":"other"}}}' > "$ORCA_STUB_DIR/orchestration_run-current" ;;
    null) echo '{"ok":true,"result":{"run":null}}' > "$ORCA_STUB_DIR/orchestration_run-current" ;;
  esac
  out=$(coord ensureCoordinator "'$W/sd', '/repo', 'auto-test'" 2>/dev/null)
  [[ "$out" == term_new ]] && grep -Fq 'orchestration run-use --id run_1 --from term_new' "$ORCA_STUB_DIR/calls.log" && ok "AU3-4 $variant" || fail "AU3-4 $variant"
  node -e "const r=require('$W/sd/run.json');process.exit(r.parent_handle==='term_new'&&r.run_id==='run_1'&&r.repo_root==='/repo'?0:1)" && ok AU5 || fail AU5
  teardown
done
setup; echo '{"ok":false}' > "$ORCA_STUB_DIR/terminal_show"; echo 1 > "$ORCA_STUB_DIR/orchestration_run-use.rc"
out=$(coord ensureCoordinator "'$W/sd', '/repo', 'auto-test'" 2>/dev/null)
[[ "$out" == null ]] && grep -Fq 'terminal close --terminal term_new' "$ORCA_STUB_DIR/calls.log" && ok AU6 || fail AU6; teardown
setup
for action in run-current run-use; do
  printf '#!/bin/sh\nprintf "%%s\\n" "$ORCA_TERMINAL_HANDLE" >> "$W/env.log"\n' > "$ORCA_STUB_DIR/orchestration_$action.hook"
  chmod +x "$ORCA_STUB_DIR/orchestration_$action.hook"
done
echo '{"ok":true,"result":{"run":null}}' > "$ORCA_STUB_DIR/orchestration_run-current"
coord ensureCoordinator "'$W/sd', '/repo', 'auto-test'" >/dev/null 2>&1
[[ "$(cat "$W/env.log" 2>/dev/null)" == $'term_c1\nterm_new' ]] && ok AU7 || fail AU7; teardown
node --test "$P/test/unit/auto-state.test.ts" > /dev/null 2>&1 && ok "AU12-15 lock tests" || fail "AU12-15 lock tests"
node --test "$P/test/unit/auto-queue.test.ts" > /dev/null 2>&1 && ok "AU16-22 queue tests" || fail "AU16-22 queue tests"
node --test "$P/test/unit/auto-judge.test.ts" > /dev/null 2>&1 && ok "AU23-29 judge tests" || fail "AU23-29 judge tests"
echo "failures: $fails"; exit "$fails"
