#!/usr/bin/env bash
set -uo pipefail
root=$(git rev-parse --show-toplevel) || exit 1
cd "$root" || exit 1
fail() { echo "VERIFY FAIL: $1" >&2; exit 1; }
find apps/cmux-e2e -name '*.sh' -print0 | xargs -0 -n1 bash -n || fail 'bash -n'
for f in apps/cmux-e2e/skills/cmux-e2e/scripts/*.sh apps/cmux-e2e/test/stub/cmux; do
  [[ -x "$f" ]] || fail "$f is not executable"
done
for test_file in apps/cmux-e2e/test/test-*.sh; do bash "$test_file" || fail "$test_file"; done
node scripts/check-doc-lang.mjs apps/cmux-e2e || fail 'doc language'
[[ "$(jq -r .version apps/cmux-e2e/.claude-plugin/plugin.json)" == 1.0.0 ]] || fail 'Claude version'
[[ "$(jq -r .version apps/cmux-e2e/.codex-plugin/plugin.json)" == 1.0.0 ]] || fail 'Codex version'
[[ "$(jq -r '.plugins[]|select(.name=="cmux-e2e")|.version' .claude-plugin/marketplace.json)" == 1.0.0 ]] || fail 'marketplace version'
[[ -z "$(git diff main...HEAD -- apps/e2e-test)" ]] || fail 'apps/e2e-test changed'
echo 'VERIFY OK'
