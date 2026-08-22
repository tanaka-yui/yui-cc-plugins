#!/usr/bin/env bash
# --setup / --reset 4-role runtime SoT regression tests.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SK="$SCRIPT_DIR/../skills/cmux-team-dispatch-task"
SETUP_EN="$SK/references/setup-mode.md"
SETUP_JA="$SK/references/setup-mode-ja.md"
EDIT="$SK/scripts/config-edit.sh"
RESOLVE="$SK/scripts/config-resolve.sh"
fail=0
bad() { echo "FAIL $1"; fail=1; }
ok() { echo "PASS $1"; }
for f in "$SETUP_EN" "$SETUP_JA" "$EDIT" "$RESOLVE"; do
  [[ -f "$f" ]] || { echo "FAIL: required file is missing: $f"; exit 2; }
done

flat() { tr '\n' ' ' < "$1" | tr -s ' '; }
need_flat() {
  local file="$1" label="$2" needle text miss=0
  shift 2; text="$(flat "$file")"
  for needle in "$@"; do
    grep -Fq -- "$needle" <<<"$text" || { echo "  missing: $needle"; miss=1; }
  done
  [[ $miss -eq 0 ]] && ok "$label" || bad "$label"
}

# SU10: destination and 4-role questions, including the five-runner threshold.
need_flat "$SETUP_EN" 'SU10: English setup flow has 4-role questions' \
  'global config.json' 'project config.json' 'runners.json' 'review_mode' 'multi-select' \
  'design' 'design_review' 'exec' 'exec_review' 'runner / model / effort' \
  'five or more' 'first four' 'Other'
need_flat "$SETUP_JA" 'SU10: 日本語 setup flow has 4-role questions' \
  'グローバル config.json' 'プロジェクト config.json' 'runners.json' 'review_mode' '複数選択' \
  'design' 'design_review' 'exec' 'exec_review' 'runner / model / effort' \
  '5 件以上' '先頭 4 件' 'Other'
need_flat "$SETUP_EN" 'SU10b: English registry setup is registry-only' \
  'registry-only setup flow' 'never invokes normal First-run' 'never writes an initial' \
  'Do not invoke normal First-run' 'config.json remains unchanged'
need_flat "$SETUP_JA" 'SU10b: 日本語 registry setup is registry-only' \
  'registry-only setup flow' 'normal First-run を呼ばず' '初期 `config.json` も書かない' \
  '`config-edit.sh` も呼ばない' '`config.json` は unchanged のまま'

# SU11: pending tuple handling and all three negative cases.
for f in "$SETUP_EN" "$SETUP_JA"; do
  need_flat "$f" "SU11: $(basename "$f") documents pending tuples" \
    'pending tuple' 'runner' 'model' 'effort' 'engine' 're-ask' 'second' 'unchanged' \
    'config.json remains unchanged' 'unknown runner' 'invalid model' 'invalid effort'
done

# S3-M and its deleted script must never return.
for f in "$SETUP_EN" "$SETUP_JA"; do
  if grep -Eq 'S3-M|runners-edit\.sh|plan_model|review_model|exec_model|plan_effort|review_effort|exec_effort' "$f"; then
    bad "SU12: $(basename "$f") contains removed S3-M vocabulary"
  else
    ok "SU12: $(basename "$f") removes S3-M"
  fi
done

# Stable row ids make the English/Japanese entry-contract table exactly comparable.
table_rows() { awk '/<!-- entry-contract:start -->/{on=1; next} /<!-- entry-contract:end -->/{on=0} on && /^\| `/{n=split($0, a, "`"); op=""; for (i=4; i<=n; i+=2) op=a[i]; print "`" a[2] "`|`" op "`"}' "$1"; }
expected_rows=$'`first-run`|`create-initial`\n`setup-config`|`one-config-edit`\n`reset-config-global`|`unset-two-keys`\n`reset-config-project`|`unset-two-keys`\n`reset-runners`|`no-config-write`\n`reset-all`|`unset-both-then-create-initial`'
en_rows="$(table_rows "$SETUP_EN")"; ja_rows="$(table_rows "$SETUP_JA")"
if [[ "$en_rows" == "$expected_rows" && "$ja_rows" == "$expected_rows" ]]; then
  ok 'SU13: entry contracts have the same six rows in the same order'
else
  bad "SU13: entry-contract row mismatch (en=[$en_rows] ja=[$ja_rows])"
fi
need_flat "$SETUP_EN" 'SU14: English reset-all contract is explicit' \
  '`--reset all`' 'both configuration layers' 'normal-mode First-run' 'initial configuration'
need_flat "$SETUP_JA" 'SU14: 日本語 reset-all contract is explicit' \
  '`--reset all`' '両方の設定レイヤー' '通常モードの First-run' '初期 config'

# S7 has one writer and retains the mandated wording in each language.
need_flat "$SETUP_EN" 'SU15: English S7 has one config-edit write' \
  'config-edit.sh' '--unset review_mode --unset runner' 'exactly ONE' 'single atomic move' \
  'mkdir -p .dispatch' 'shadows the global layer'
need_flat "$SETUP_JA" 'SU15: 日本語 S7 has one config-edit write' \
  'config-edit.sh' '--unset review_mode --unset runner' 'ちょうど 1 回' '結果全体が単一の mv で反映されるようにする。' \
  'プロジェクト宛なら先に `mkdir -p .dispatch` する。' 'このリポジトリではグローバルより優先されることをユーザーに伝える。'

# Dynamic checks execute documented side-effect sequences. The static checks above bind
# those sequences to the instructions; LLM-driven interactive prompts are not testable.
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
G_DIR="$TMP/global"; P_DIR="$TMP/project"
setup_fixture() {
  rm -rf "$G_DIR" "$P_DIR"; mkdir -p "$G_DIR" "$P_DIR/.dispatch"
  printf '%s\n' '{"shell_ready_ms":{"baseline_ms":7},"loop":{"task_timeout_min":45},"review_mode":"on","runner":{"design":{"runner":"ccf"},"design_review":{"runner":"ccf"},"exec":{"runner":"ccf"},"exec_review":{"runner":"ccf"}}}' > "$G_DIR/config.json"
  printf '%s\n' '{"runner":{"design":{"model":"fable"}}}' > "$P_DIR/.dispatch/config.json"
}
sha() { shasum -a 256 "$1" 2>/dev/null | cut -d' ' -f1; }
write_registry() { printf '%s\n' '{"default":"ccf","runners":[{"name":"ccf","command":"ccf","engine":"claude"}]}' > "$G_DIR/runners.json"; }
write_initial_config() {
  local args=(--config "$G_DIR/config.json" --set review_mode=on) role
  for role in design design_review exec exec_review; do args+=(--set "runner.$role.runner=ccf"); done
  bash "$EDIT" "${args[@]}" >/dev/null
}
resolve_rc() { DISPATCH_CONFIG_HOME="$G_DIR" bash "$RESOLVE" --project-root "$P_DIR" >/dev/null 2>&1; echo $?; }

setup_fixture; write_registry; p_before=$(sha "$P_DIR/.dispatch/config.json")
bash "$EDIT" --config "$G_DIR/config.json" --unset review_mode --unset runner >/dev/null
[[ "$(jq -r 'has("review_mode") or has("runner")' "$G_DIR/config.json")" == false && "$(jq -r '.loop.task_timeout_min' "$G_DIR/config.json")" == 45 && "$(sha "$P_DIR/.dispatch/config.json")" == "$p_before" ]] \
  && ok 'SU16: reset config (global) preserves project and third-party keys' || bad 'SU16'
[[ "$(resolve_rc)" == 2 ]] \
  && ok 'SU16b: reset config (global) alone makes resolve fail fast' || bad 'SU16b'

setup_fixture; g_before=$(sha "$G_DIR/config.json")
bash "$EDIT" --config "$P_DIR/.dispatch/config.json" --unset review_mode --unset runner >/dev/null
[[ "$(jq -r 'has("runner")' "$P_DIR/.dispatch/config.json")" == false && "$(sha "$G_DIR/config.json")" == "$g_before" ]] \
  && ok 'SU17: reset config (project) preserves global' || bad 'SU17'

setup_fixture; g_before=$(sha "$G_DIR/config.json"); p_before=$(sha "$P_DIR/.dispatch/config.json")
rm -f "$G_DIR/runners.json"; write_registry
[[ "$(sha "$G_DIR/config.json")" == "$g_before" && "$(sha "$P_DIR/.dispatch/config.json")" == "$p_before" ]] \
  && ok 'SU18: reset runners leaves both configs byte-identical' || bad 'SU18'

rm -rf "$G_DIR" "$P_DIR"; mkdir -p "$G_DIR" "$P_DIR/.dispatch"; write_registry; write_initial_config
[[ "$(resolve_rc)" == 0 ]] && ok 'SU19a: first run resolves successfully' || bad 'SU19a'
initial_ok=1
for role in design design_review exec exec_review; do
  [[ "$(jq -r --arg role "$role" '.runner[$role].runner' "$G_DIR/config.json")" == ccf ]] || initial_ok=0
done
[[ "$(jq -r '.runner.design | has("model") or has("effort")' "$G_DIR/config.json")" == false && ! -e "$P_DIR/.dispatch/config.json" && $initial_ok -eq 1 ]] \
  && ok 'SU19b: first run writes global defaults only' || bad 'SU19b'

setup_fixture
for config in "$G_DIR/config.json" "$P_DIR/.dispatch/config.json"; do
  bash "$EDIT" --config "$config" --unset review_mode --unset runner >/dev/null
done
rm -f "$G_DIR/runners.json"; write_registry; write_initial_config
[[ "$(resolve_rc)" == 0 && "$(jq -r 'has("runner")' "$P_DIR/.dispatch/config.json")" == false && "$(jq -r '.shell_ready_ms.baseline_ms' "$G_DIR/config.json")" == 7 ]] \
  && ok 'SU20: reset all clears both layers, reinitializes global, and resolves' || bad 'SU20'

setup_fixture; write_registry
for config in "$G_DIR/config.json" "$P_DIR/.dispatch/config.json"; do
  bash "$EDIT" --config "$config" --unset review_mode --unset runner >/dev/null
done
[[ "$(resolve_rc)" == 2 ]] && ok 'SU21: reset config fails fast until setup restores roles' || bad 'SU21'

[[ $fail -eq 0 ]] && echo '--- all tests passed ---' || echo '--- failures ---'
exit "$fail"
