#!/usr/bin/env bash
# 全テストを走らせ、1 件でも失敗したら非 0 で終わる。
set -uo pipefail
cd "$(dirname "$0")/.."
# node --test は一致しない glob で失敗するので、実在するファイルに一致する glob だけ渡す
globs=()
for g in 'test/unit/*.test.ts' 'test/*.test.ts'; do
  compgen -G "$g" >/dev/null && globs+=("$g")
done
[[ ${#globs[@]} -gt 0 ]] || { echo "no tests found"; exit 1; }
node --test "${globs[@]}"
