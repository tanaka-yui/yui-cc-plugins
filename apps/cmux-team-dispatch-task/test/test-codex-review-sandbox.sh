#!/usr/bin/env bash
# review pane の codex sandbox を動的検査する。approval_policy の TUI 挙動は証明対象外。
set -euo pipefail
if ! command -v codex >/dev/null 2>&1; then echo 'SKIP: codex CLI が見つかりません'; exit 0; fi
if ! codex sandbox --help 2>&1 | grep -q -- '--add-dir'; then
  echo 'SKIP: この codex sandbox には --add-dir がありません'
  exit 0
fi
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
REPO="$TMP/repo"; STATUS="$TMP/status/review"; mkdir -p "$REPO" "$STATUS"
git -C "$REPO" init -q -b main; git -C "$REPO" config user.email t@example.invalid; git -C "$REPO" config user.name t
echo a > "$REPO/a"; git -C "$REPO" add . && git -C "$REPO" commit -qm init; echo b >> "$REPO/a"; cd "$REPO"
fail=0
if codex sandbox -c sandbox_mode=workspace-write -- bash -c "touch '$STATUS/probe'" >/dev/null 2>&1; then echo 'FAIL: S1'; fail=1; else echo 'PASS: S1 denial'; fi
if codex sandbox -c sandbox_mode=workspace-write --add-dir "$STATUS" -- bash -c "touch '$STATUS/probe'" >/dev/null 2>&1 && [[ -f "$STATUS/probe" ]]; then echo 'PASS: S2 writable add-dir'; else echo 'FAIL: S2'; fail=1; fi
if codex sandbox -c sandbox_mode=workspace-write -- git diff --stat >/dev/null 2>&1; then echo 'PASS: S3 git diff'; else echo 'FAIL: S3'; fail=1; fi
[[ $fail -eq 0 ]] && echo '--- all tests passed ---'; exit "$fail"
