#!/usr/bin/env bash

PW="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export DISPATCH_CONFIG_HOME="$TMP/home"
mkdir -p "$DISPATCH_CONFIG_HOME" "$TMP/wt" "$TMP/status"
cat > "$DISPATCH_CONFIG_HOME/runners.json" <<'JSON'
{"default":"ccf","runners":[{"name":"ccf","command":"ccf","engine":"claude"},
                            {"name":"cx","command":"codex","engine":"codex"}]}
JSON

ROLES_ON="$TMP/roles-on.json"
ROLES_OFF="$TMP/roles-off.json"
cat > "$ROLES_ON" <<'JSON'
{"review_mode":"on","roles":{
 "design":{"runner":"ccf","engine":"claude","model":"opus[1m]","effort":"xhigh"},
 "design_review":{"runner":"cx","engine":"codex","model":"gpt-5.6-sol","effort":"xhigh"},
 "exec":{"runner":"cx","engine":"codex","effort":"high"},
 "exec_review":{"runner":"ccf","engine":"claude","model":"opus[1m]","effort":"high"}}}
JSON
cat > "$ROLES_OFF" <<'JSON'
{"review_mode":"off","roles":{
 "design":{"runner":"ccf","engine":"claude","model":"opus[1m]","effort":"xhigh"},
 "exec":{"runner":"cx","engine":"codex","effort":"high"}}}
JSON

SCRIPTS_REAL="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts"
FAKE="$TMP/scripts"
mkdir -p "$FAKE" "$TMP/bin"
cp "$SCRIPTS_REAL/prewarm-panes.sh" "$SCRIPTS_REAL/config-lib.sh" "$FAKE/"
PW="$FAKE/prewarm-panes.sh"

make_launch_stub() { # $1=role to fail, empty means success
  cat > "$FAKE/launch-workspace.sh" <<STUB
#!/bin/sh
printf '%s\n' "launch \$*" >> "$TMP/calls.log"
if [ -n "$1" ]; then
  case "\$*" in *"--role $1"*) exit 1 ;; esac
fi
printf '{"surface_id":"s","workspace_id":"workspace:1"}\n'
STUB
  chmod +x "$FAKE/launch-workspace.sh"
}
make_launch_stub ""

for b in join.sh delivery.sh leave.sh send.sh; do
  printf '#!/bin/sh\nprintf "%%s\\n" "%s $*" >> "%s/calls.log"\nexit 0\n' "$b" "$TMP" > "$TMP/bin/$b"
  chmod +x "$TMP/bin/$b"
done
printf '#!/bin/sh\nprintf "%%s\\n" "cmux $*" >> "%s/calls.log"\nexit 0\n' "$TMP" > "$TMP/bin/cmux"
chmod +x "$TMP/bin/cmux"
export CMUX_BIN="$TMP/bin/cmux" AGMSG_DIR="$TMP/bin"

run_pw() {
  STATUS=$(mktemp -d "$TMP/status-case.XXXXXX")
  : > "$TMP/calls.log"
  bash "$PW" --with-design --cwd "$TMP/wt" --slug t --status-dir "$STATUS" \
    --agmsg-team team --roles "$1" "${@:2}" 2>&1
}

run_pw_roles() { run_pw "$1"; }
launch_count() { grep -c '^launch ' "$TMP/calls.log" 2>/dev/null || true; }
no_side_effects() {
  [[ ! -s "$TMP/calls.log" ]] && [[ ! -e "$STATUS/prewarm.json" ]] && [[ ! -e "$TMP/pwn" ]]
}
