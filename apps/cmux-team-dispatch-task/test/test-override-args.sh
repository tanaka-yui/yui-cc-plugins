#!/usr/bin/env bash
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OA="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/override-args.sh"
fail=0; bad() { echo "FAIL $1"; fail=1; }; ok() { echo "PASS $1"; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
printf '%s\n' '{"default":"ccf","runners":[{"name":"ccf","command":"ccf","engine":"claude"},{"name":"cx","command":"codex","engine":"codex"}]}' > "$TMP/runners.json"
printf '%s\n' '{"review_mode":"on","roles":{"design":{"runner":"ccf","engine":"claude","model":"opus[1m]","effort":"xhigh"},"design_review":{"runner":"ccf","engine":"claude","model":"opus[1m]","effort":"xhigh"},"exec":{"runner":"ccf","engine":"claude","model":"sonnet","effort":"high"},"exec_review":{"runner":"ccf","engine":"claude","model":"opus[1m]","effort":"high"}}}' > "$TMP/roles.json"
args() { OUT=(); while IFS= read -r -d '' a; do OUT+=("$a"); done < <(bash "$OA" --roles "$TMP/roles.json" --runners "$TMP/runners.json" "$@" 2>"$TMP/err"); }
has() { printf '%s\n' "${OUT[@]-}" | grep -qFx -- "$1"; }
args --pending design.runner=cx --pending design.model=gpt-5.6-sol --pending design.effort=xhigh
{ has '--set' && has 'design.runner=cx' && has 'design.model=gpt-5.6-sol' && has 'design.effort=xhigh'; } && ok 'OA1' || bad "OA1: ${OUT[*]}"
for bad_case in model effort runner; do
  case "$bad_case" in
    model) drop=(--pending exec.runner=cx --pending 'exec.model=opus[1m]') ;;
    effort) drop=(--pending exec.runner=cx --pending exec.effort=max --pending exec.model=gpt-5.6-sol) ;;
    runner) drop=(--pending exec.runner=nope) ;;
  esac
  case "$bad_case" in
    effort) args --pending design.model=KEPT "${drop[@]}" ;;
    *) args --pending design.model=KEPT "${drop[@]}" --pending exec.effort=medium ;;
  esac
  if has 'design.model=KEPT' && ! printf '%s\n' "${OUT[@]-}" | grep -q '^exec\.' && grep -qi 'dropping the whole override' "$TMP/err"; then ok "OA5-$bad_case"; else bad "OA5-$bad_case: ${OUT[*]-}"; fi
done
args --pending design.model=
printf '%s\n' "${OUT[@]-}" | grep -q '^design\.model=' && bad 'OA6' || ok 'OA6'
args --pending 'design.model=gpt 5 sol'
has 'design.model=gpt 5 sol' && ok 'OA7' || bad "OA7: ${OUT[*]-}"
exit $fail
