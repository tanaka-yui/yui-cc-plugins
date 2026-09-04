#!/usr/bin/env bash
# orca CLI のスタブ。
#   応答: $ORCA_STUB_DIR/<サブコマンドを _ で連結>  終了鍵: 同名 + .rc
#   副作用: 同名 + .hook（実行可能なら応答前に走る）
#   argv: calls.log に **1 コール 1 行**（%q で escape）。
#         argv.log には同じ argv を **生のまま** 0x1f 区切りで残す（値そのものを取り出す用）
set -uo pipefail
: "${ORCA_STUB_DIR:?orca-stub: ORCA_STUB_DIR is required}"
mkdir -p "$ORCA_STUB_DIR"
# ★ %q が load-bearing。--spec は複数行なので、素の "$*" だと 1 コールが複数行になり
#   grep ... | head -1 が本文を失う
printf '%q ' "$@" >> "$ORCA_STUB_DIR/calls.log"; printf '\n' >> "$ORCA_STUB_DIR/calls.log"
printf '%s\037' "$@" >> "$ORCA_STUB_DIR/argv.log"; printf '\n' >> "$ORCA_STUB_DIR/argv.log"
key=""
for a in "$@"; do case "$a" in --*) break ;; esac; key="${key:+${key}_}$a"; done
[[ -x "$ORCA_STUB_DIR/$key.hook" ]] && "$ORCA_STUB_DIR/$key.hook" "$@" >/dev/null 2>&1
[[ -f "$ORCA_STUB_DIR/$key" ]] && cat "$ORCA_STUB_DIR/$key" || printf '{"ok":true,"result":{}}\n'
[[ -f "$ORCA_STUB_DIR/$key.rc" ]] && exit "$(cat "$ORCA_STUB_DIR/$key.rc")"
exit 0
