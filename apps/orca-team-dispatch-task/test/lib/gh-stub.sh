#!/usr/bin/env bash
# gh CLI のスタブ。orca-stub.sh と同じ構え。
#   応答: $GH_STUB_DIR/<サブコマンドを _ で連結>   終了鍵: 同名 + .rc
#   副作用: 同名 + .hook（実行可能なら応答前に走る）
#   argv: calls.log に **1 コール 1 行**（%q で escape）
set -uo pipefail
: "${GH_STUB_DIR:?gh-stub: GH_STUB_DIR is required}"
mkdir -p "$GH_STUB_DIR"
printf '%q ' "$@" >> "$GH_STUB_DIR/calls.log"; printf '\n' >> "$GH_STUB_DIR/calls.log"
key=""
for a in "$@"; do
  case "$a" in --*) break ;; esac
  # 数値の位置引数（issue 番号など）は key に混ぜない
  case "$a" in ''|*[!0-9]*) key="${key:+${key}_}$a" ;; *) break ;; esac
done
# 副作用: 同名 + .hook（実行可能なら応答前に走る）。orca-stub.sh と同じ構え。
[[ -x "$GH_STUB_DIR/$key.hook" ]] && "$GH_STUB_DIR/$key.hook" "$@"
[[ -f "$GH_STUB_DIR/$key" ]] && cat "$GH_STUB_DIR/$key"
[[ -f "$GH_STUB_DIR/$key.rc" ]] && exit "$(cat "$GH_STUB_DIR/$key.rc")"
exit 0
