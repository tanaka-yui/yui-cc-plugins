#!/usr/bin/env bash
# 文書が実行可能な正本であり、**ユーザー向けの文の owner が 1 つ**であることを検査する。
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"; P="$ROOT/apps/orca-team-dispatch-task"
S="$P/skills/orca-team-dispatch-task/SKILL.md"; G="$P/skills/orca-team-dispatch-task/references/guide-ja.md"
fails=0; ok() { echo "PASS: $1"; }; fail() { echo "FAIL: $1"; fails=$((fails+1)); }
[[ -f "$S" && -f "$G" ]] && ok "SK1 SKILL.md と guide-ja.md" || { fail "SK1"; echo "failures: 1"; exit 1; }
grep -q '^## Output Language$' "$S" \
  && grep -q 'All user-facing questions, option labels, tables, and progress reports MUST be' "$S" \
  && ok "SK2 Output Language" || fail "SK2"

# SK3: 参照する bin/*.sh が実在する
miss=""; while IFS= read -r r; do [[ -f "$P/$r" ]] || miss="$miss $r"; done \
  < <(grep -oE 'bin/[A-Za-z0-9._-]+\.sh' "$S" | sort -u)
[[ -z "$miss" ]] && ok "SK3 参照先が実在" || fail "SK3 実在しない参照:$miss"

# SK4: **Stage 1 に無いものを宣言しない**
bad=""; for w in review_mode merge_ready nonce journal remediation design_review exec_review; do
  grep -q -- "$w" "$S" && bad="$bad [$w]"; done
[[ -z "$bad" ]] && ok "SK4 未実装を宣言しない" || fail "SK4 未実装の宣言:$bad"

# SK5: **bare orca を書かない** (O1)。文書の中でも
if grep -nE '(^|[^_A-Za-z/$])orca (orchestration|terminal|worktree) ' "$S" "$G" >/dev/null 2>&1; then
  fail "SK5 bare orca を書いている ($(grep -nE '(^|[^_A-Za-z/$])orca (orchestration|terminal|worktree) ' "$S" "$G" | head -2))"
else ok "SK5 常に \$ORCA_BIN 経由"; fi

# SK6: **placeholder を見せない。**片付け手順は state から値を埋め、selector は id: を付ける
bad=""
grep -q '<the worker terminal>' "$S" && bad="$bad [placeholder]"
grep -q 'worker-release --dispatch "\$DID"' "$S" || bad="$bad [release]"
# selector は id: 接頭辞つきで、**%q で引用して**表示する（空白を含む path でも copy-paste 可）
grep -q '"id:\$WT"' "$S" || bad="$bad [id-prefix]"
grep -q "worktree rm --worktree %q" "$S" || bad="$bad [quoted-selector]"
grep -qE 'worktree rm --worktree \$WT( |$)' "$S" && bad="$bad [raw-id]"
grep -q 'terminal close --terminal %q' "$S" || bad="$bad [quoted-terminal]"
[[ -z "$bad" ]] && ok "SK6 値入り・id: 付き・引用済みの片付けコマンド" || fail "SK6:$bad"

# SK7: 片付けの安全条件（release の state 分類 / merged / clean / --force）
miss=""
for n in 'release_pending' 'release_unknown' 'retained' 'already_released' \
         'merged' 'dirty' '--force' 'worktreeId'; do
  grep -qi -- "$n" "$S" || miss="$miss [$n]"; done
[[ -z "$miss" ]] && ok "SK7 安全条件" || fail "SK7 欠落:$miss"

# SK7b: **列挙できないことを「0 個」にしない** (round 4 finding 1)。
#       gate は unknown を持ち、rc と schema を検査していること
miss=""
grep -q 'ACCOUNTED=unknown' "$S" || miss="$miss [unknown-state]"
grep -q 'terminals | type == "array"' "$S" || miss="$miss [schema-check]"
grep -q 'ACCOUNTED" == yes' "$S" || miss="$miss [gate-requires-yes]"
# 旧 fail-open の形が残っていないこと
grep -q 'LEFT:-\[\]' "$S" && miss="$miss [fail-open-default]"
[[ -z "$miss" ]] && ok "SK7b 列挙失敗で gate が閉じる" || fail "SK7b:$miss"

# SK8: **運用規則の ID 集合が SKILL.md と guide-ja.md で一致する。**
#      件数比較だと中身を入れ替えても通るので、安定 ID を突き合わせる
ids_s=$(grep -oE '\[C[0-9]+\]' "$S" | sort -u | tr '\n' ' ')
ids_g=$(grep -oE '\[C[0-9]+\]' "$G" | sort -u | tr '\n' ' ')
[[ -n "$ids_s" && "$ids_s" == "$ids_g" ]] && ok "SK8 規則 ID が一致 ($ids_s)" \
  || fail "SK8 規則 ID が不一致 (S=[$ids_s] G=[$ids_g])"

# SK8b: **提示する CLI サブコマンドの集合も一致する**（訳が要約に化けるのを防ぐ）
cli_s=$(grep -oE '(orchestration [a-z-]+|terminal (show|close)|worktree rm)' "$S" | sort -u | tr '\n' ' ')
cli_g=$(grep -oE '(orchestration [a-z-]+|terminal (show|close)|worktree rm)' "$G" | sort -u | tr '\n' ' ')
[[ -n "$cli_s" && "$cli_s" == "$cli_g" ]] && ok "SK8b CLI 集合が一致" \
  || fail "SK8b CLI 集合が不一致 (S=[$cli_s] G=[$cli_g])"

# SK8c: 制限の件数も一致する
ns=$(awk '/^## Known limitations$/,/^## State on disk$/' "$S" | grep -c '^| .* | .* |$')
ng=$(awk '/^## 既知の制限$/,/^## ディスク上の状態$/' "$G" | grep -c '^| .* | .* |$')
[[ "$ns" -eq "$ng" && "$ns" -ge 6 ]] && ok "SK8c 制限が $ns 件で一致" || fail "SK8c 件数 (S=$ns G=$ng)"

# SK9: **README は運用手順を持たない**（正本は 1 つ）
if grep -qE 'worker-release|worktree rm|terminal close|task-list --run' "$P/README.md"; then
  fail "SK9 README が片付け手順を重複して持っている"
else ok "SK9 README は非 normative"; fi

# SK10: doc-lang
node "$ROOT/scripts/check-doc-lang.mjs" apps/orca-team-dispatch-task >/dev/null 2>&1 \
  && ok "SK10 doc-lang" || fail "SK10 doc-lang"
echo "---"; echo "failures: $fails"; exit "$fails"
