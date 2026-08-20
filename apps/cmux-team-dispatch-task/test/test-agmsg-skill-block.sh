#!/usr/bin/env bash
# Extracts the Step 1g block from SKILL.md and executes it to verify the rc branching.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/SKILL.md"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
fail=0; bad() { echo "FAIL: $1" >&2; fail=1; }

# TEAM="dispatch- appears exactly once in SKILL.md, so it is a unique anchor.
# "the fenced block under Step 1g" cannot identify it (there are 6 bash fences underneath).
awk '/TEAM="dispatch-/{f=1} f{print} f&&/^```$/{exit}' "$SKILL" | sed '/^```/d' > "$TMP/block.raw"
[[ -s "$TMP/block.raw" ]] || bad 'AG1 could not extract the Step 1g block'

mkdir -p "$TMP/skill/scripts" "$TMP/agmsg"
# Substitute first, then assert not a single ~/.agents survives (fail-closed).
sed -e "s|~/.agents/skills/agmsg/scripts|$TMP/agmsg|g" \
    -e "s|<SKILL_DIR>|$TMP/skill|g" "$TMP/block.raw" > "$TMP/block.sh"
grep -q '~/.agents' "$TMP/block.sh" && bad 'AG1 the extracted block still touches the real agmsg'

cat > "$TMP/agmsg/join.sh" <<'STUB'
#!/usr/bin/env bash
exit "${JOIN_RC:-0}"
STUB
cat > "$TMP/skill/scripts/resolve-agmsg-type.sh" <<'STUB'
#!/usr/bin/env bash
echo claude-code
STUB
cat > "$TMP/git" <<'STUB'
#!/usr/bin/env bash
[[ "$1" == rev-parse ]] && { echo /tmp/demo-repo; exit 0; }
exit 0
STUB
chmod +x "$TMP/agmsg/join.sh" "$TMP/skill/scripts/resolve-agmsg-type.sh" "$TMP/git"

make_guard() {  # <rc> <state>
  cat > "$TMP/skill/scripts/ensure-agmsg-ready.sh" <<STUB
#!/usr/bin/env bash
echo "\$*" > "$TMP/guard.argv"
echo '$2'
exit $1
STUB
  chmod +x "$TMP/skill/scripts/ensure-agmsg-ready.sh"
}

run_block() {  # pass any extra env through unchanged
  ( cd "$TMP" && PATH="$TMP:$PATH" bash -c "set -euo pipefail; source '$TMP/block.sh'; \
     echo \"TEAM=\$TEAM AGMSG_INSTALLED=\${AGMSG_INSTALLED:-unset}\"" ) 2>&1
}

# AG1-a: rc 0 / started -> no warning
make_guard 0 'ensure-agmsg-ready: installed=yes wired=yes name=parent watcher=started pid=1 reason=- log=-'
out=$(run_block); [[ "$out" == *"[warn]"* ]] && bad 'AG1 rc0/started must not warn'
[[ "$out" == *"TEAM=dispatch-demo-repo"* ]] || bad 'AG1 rc0 must keep TEAM'

# AG1-b: rc 0 / none -> warn, TEAM kept
make_guard 0 'ensure-agmsg-ready: installed=yes wired=yes name=parent watcher=none pid=- reason=start-timeout log=-'
out=$(run_block); [[ "$out" == *"[warn]"* ]] || bad 'AG1 rc0/none must warn'
[[ "$out" == *"TEAM=dispatch-demo-repo"* ]] || bad 'AG1 rc0/none must keep TEAM'

# AG1-c: rc 0 / existing-other -> warn
make_guard 0 'ensure-agmsg-ready: installed=yes wired=yes name=parent watcher=existing-other pid=9 reason=- log=-'
out=$(run_block); [[ "$out" == *"[warn]"* ]] || bad 'AG1 rc0/existing-other must warn'

# AG1-d: rc 1 -> TEAM cleared + AGMSG_INSTALLED=false
make_guard 1 'ensure-agmsg-ready: installed=no wired=no name=parent watcher=none pid=- reason=not-installed log=-'
out=$(run_block)
[[ "$out" == *"TEAM= "* || "$out" == *"TEAM="$'\n'* || "$out" == *"TEAM= AGMSG_INSTALLED=false"* ]] \
  || bad 'AG1 rc1 must clear TEAM'
[[ "$out" == *"AGMSG_INSTALLED=false"* ]] || bad 'AG1 rc1 must set AGMSG_INSTALLED=false'

# AG1-e: rc 2 -> stop
make_guard 2 'ensure-agmsg-ready: installed=no wired=no name=- watcher=none pid=- reason=usage log=-'
out=$(run_block); [[ "$out" == *"[error]"* ]] || bad 'AG1 rc2 must error out'

# AG1-f: join failure still reaches the guard
make_guard 0 'ensure-agmsg-ready: installed=yes wired=yes name=parent watcher=started pid=1 reason=- log=-'
out=$(JOIN_RC=1 run_block); [[ -f "$TMP/guard.argv" ]] || bad 'AG1 join failure must not abort the block'

# AG2: --name parent is passed and --session-id is not
grep -Fq -- '--name parent' "$TMP/guard.argv" || bad 'AG2 --name parent'
grep -Fq -- '--session-id' "$TMP/guard.argv" && bad 'AG2 must not pass --session-id'

# AG3 / AG4: the child prompt's guard line
grep -q 'prewarm: false' "$SKILL" || bad 'AG3 the child guard line must be gated on prewarm: false'
grep -q 'ensure-agmsg-ready.sh --type <CHILD_AGMSG_TYPE> --name <task-slug>' "$SKILL" \
  || bad 'AG4 the child guard line must resolve --type per task'

[[ $fail -eq 0 ]] && echo '--- all tests passed ---' || echo '--- failures ---'
exit "$fail"
