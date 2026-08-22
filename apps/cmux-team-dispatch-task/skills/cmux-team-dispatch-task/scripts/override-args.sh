#!/usr/bin/env bash
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/config-lib.sh"
usage() { echo "usage: override-args.sh --roles <resolved.json> [--runners <path>] --pending <role>.<field>=<value> ..." >&2; exit 2; }
drop() { echo "[warn] override-args: dropping the whole override for role '$1' ($2: $3)" >&2; }
ROLES_FILE=''; RUNNERS_FILE=''; PENDING=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --roles) [[ $# -ge 2 ]] || usage; ROLES_FILE="$2"; shift 2 ;;
    --runners) [[ $# -ge 2 ]] || usage; RUNNERS_FILE="$2"; shift 2 ;;
    --pending) [[ $# -ge 2 ]] || usage; PENDING+=("$2"); shift 2 ;;
    *) usage ;;
  esac
done
[[ -n "$ROLES_FILE" && -r "$ROLES_FILE" ]] || usage
[[ -n "$RUNNERS_FILE" ]] || RUNNERS_FILE="$(dispatch_runners_file)"
[[ -r "$RUNNERS_FILE" ]] || usage
ROLES_DOC=$(cat "$ROLES_FILE") || usage
RUNNERS_DOC=$(cat "$RUNNERS_FILE") || usage
jq -e -s 'length == 1 and (.[0].roles | type == "object")' >/dev/null 2>&1 <<< "$ROLES_DOC" || usage
jq -e -s 'length == 1 and (.[0] | type == "object")' >/dev/null 2>&1 <<< "$RUNNERS_DOC" || usage
runner_engine() {
  jq -r --arg n "$1" 'first((.runners? // [])[] | select(.name? == $n) | .engine? // empty) // empty' \
    <<< "$RUNNERS_DOC"
}
for p in "${PENDING[@]}"; do
  [[ "$p" == *=* ]] || usage
  k="${p%%=*}"; v="${p#*=}"; [[ -n "$v" ]] || continue
  r="${k%%.*}"; f="${k#*.}"
  case "$r" in design|design_review|exec|exec_review) ;; *) usage ;; esac
  case "$f" in runner|model|effort) ;; *) usage ;; esac
  printf -v "VALUE_${r}_${f}" '%s' "$v"
done
pending_present() { local n="VALUE_${1}_${2}"; [[ -n "${!n+x}" ]]; }
pending_value() { local n="VALUE_${1}_${2}"; printf '%s' "${!n}"; }
for role in design design_review exec exec_review; do
  found=0
  for f in runner model effort; do pending_present "$role" "$f" && found=1; done
  [[ $found -eq 1 ]] || continue
  runner="$(pending_present "$role" runner && pending_value "$role" runner || jq -r --arg r "$role" '.roles[$r].runner // empty' <<< "$ROLES_DOC")"
  engine="$(runner_engine "$runner")"
  [[ -n "$engine" ]] || { drop "$role" runner 'not registered'; continue; }
  model="$(pending_present "$role" model && pending_value "$role" model || jq -r --arg r "$role" '.roles[$r].model // empty' <<< "$ROLES_DOC")"
  if [[ -z "$model" ]] && dispatch_model_required "$role" "$engine"; then drop "$role" model 'required model is missing'; continue; fi
  if [[ -n "$model" ]] && ! dispatch_valid_model "$model"; then drop "$role" model 'invalid for engine'; continue; fi
  if [[ "$engine" == codex ]]; then case "$model" in opus\[1m\]|sonnet|fable) drop "$role" model 'Claude model alias for codex'; continue;; esac; fi
  effort="$(pending_present "$role" effort && dispatch_normalize_effort "$(pending_value "$role" effort)" || jq -r --arg r "$role" '.roles[$r].effort // empty' <<< "$ROLES_DOC")"
  dispatch_valid_effort "$effort" "$engine" || { drop "$role" effort 'invalid for engine'; continue; }
  for f in runner model effort; do
    pending_present "$role" "$f" || continue
    v="$(pending_value "$role" "$f")"; [[ "$f" == effort ]] && v="$effort"
    printf '%s\0%s\0' --set "$role.$f=$v"
  done
done
