#!/usr/bin/env bash
# review ペインの codex sandbox を実 CLI で動的検査する。approval_policy の TUI 挙動は
# 証明対象外。
#
# F7: codex の対話セッションでは --add-dir が seatbelt policy に届かない。追加許可は
# -c sandbox_workspace_write.writable_roots でしか効かない。旧版はこのファイル自身が
# `codex sandbox --help` に --add-dir が無いと SKIP していたため、常に何も検証して
# いなかった。
#
# プローブ先を $HOME 配下に取るのは、workspace-write が TMPDIR と /tmp を既定で
# 書き込み可能にするため。mktemp -d の下で試すと S1 が常に「許可」になり、この
# テストは再び無意味になる。
set -euo pipefail
if ! command -v codex >/dev/null 2>&1; then echo 'SKIP: codex CLI が見つかりません'; exit 0; fi

TMP=$(mktemp -d)
# 既定の writable root の外側 (TMPDIR/tmp ではない場所)
OUT="$HOME/.cmux-dispatch-sandbox-test.$$"
trap 'rm -rf "$TMP" "$OUT"' EXIT
mkdir -p "$OUT"

REPO="$TMP/repo"; mkdir -p "$REPO"
git -C "$REPO" init -q -b main
git -C "$REPO" config user.email t@example.invalid
git -C "$REPO" config user.name t
echo a > "$REPO/a"; git -C "$REPO" add . && git -C "$REPO" commit -qm init
echo b >> "$REPO/a"
cd "$REPO"

fail=0
pass() { echo "PASS: $1"; }
bad()  { echo "FAIL: $1"; fail=1; }

# S1: 追加許可なしでは worktree 外へ書けない。これが「許可」になるならプローブ先が
# 既定の writable root に入っており、S2 は何も証明しない。
if codex sandbox -c sandbox_mode=workspace-write \
     -- bash -c "touch '$OUT/probe1'" >/dev/null 2>&1 && [[ -f "$OUT/probe1" ]]; then
  bad 'S1 denial (probe target is inside a default writable root; this test proves nothing)'
else
  pass 'S1 denial without writable_roots'
fi

# S2: launch-workspace.sh が組み立てるのと同じ単引用符付き TOML 配列で許可される
if codex sandbox -c sandbox_mode=workspace-write \
     -c "sandbox_workspace_write.writable_roots=['$OUT']" \
     -- bash -c "touch '$OUT/probe2'" >/dev/null 2>&1 && [[ -f "$OUT/probe2" ]]; then
  pass 'S2 writable_roots grants the findings directory'
else
  bad 'S2 writable_roots did not grant the findings directory'
fi

# S3: workspace-write のままでも worktree 内の git 操作は通る
if codex sandbox -c sandbox_mode=workspace-write -- git diff --stat >/dev/null 2>&1; then
  pass 'S3 git diff'
else
  bad 'S3 git diff'
fi

# S4: composed command は `zsh -ic "..."` に包まれる。単引用符の要素がその二重引用を
# 破らないことを実際に通して確かめる (F7 の修正形が壊れる主な経路)。
if zsh -ic "codex sandbox -c sandbox_mode=workspace-write -c \"sandbox_workspace_write.writable_roots=['$OUT']\" -- bash -c \"touch '$OUT/probe4'\"" >/dev/null 2>&1 \
   && [[ -f "$OUT/probe4" ]]; then
  pass 'S4 the quoted form survives the zsh -ic wrapper'
else
  bad 'S4 the quoted form did not survive the zsh -ic wrapper'
fi

[[ $fail -eq 0 ]] && echo '--- all tests passed ---'
exit "$fail"
