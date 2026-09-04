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

# SK6b: request は固定 heredoc へ入れず、次の tool call へ実パスを渡す。
bad=""
grep -q "file-write tool.*\$REQ" "$S" || bad="$bad [file-write-request]"
grep -q "shell heredoc" "$S" || bad="$bad [request-collision-explained]"
step1=$(mktemp)
awk '/^## Step 1: Write the request down$/ { section=1; next }
     section && /^```bash$/ { block=1; next }
     block && /^```$/ { exit }
     block { print }' "$S" | sed 's/^SLUG=.*/SLUG=test/' > "$step1"
handoff=$(bash "$step1" 2>/dev/null); req_path="${handoff#request_file=}"
[[ "$handoff" == request_file=* && -n "$req_path" && -f "$req_path" ]] \
  || bad="$bad [printed-request-handoff]"
grep -q '<<' "$step1" && bad="$bad [request-heredoc]"
rm -f "$step1" "$req_path"
[[ -z "$bad" ]] && ok "SK6b REQ を安全に実パスで引き継ぐ" || fail "SK6b:$bad"

# SK6c: [C1]/[C2]/[C3] は別々の tool call でも空/null state で fail closed する。
#        旧実装は C1 が空の dispatch を表示し、C2 が空 handle の close を表示した。
extract_cleanup_block() {
  local label="$1" file="$2"
  awk -v label="$label" '$0 ~ "^\\[" label "\\]" { section=1; next }
       section && /^```bash$/ { block=1; next }
       block && /^```$/ { exit }
       block { print }' "$file"
}
scratch=$(mktemp -d); cleanup_state="$scratch/state"; mkdir -p "$cleanup_state"
printf '%s\n' '{}' > "$cleanup_state/workers.json"
printf '%s\n' '{}' > "$cleanup_state/integration-result.json"
export ORCA_STUB_DIR="$scratch/orca" ORCA_BIN="$P/test/lib/orca-stub.sh" SD="$cleanup_state"
mkdir -p "$ORCA_STUB_DIR"; : > "$ORCA_STUB_DIR/calls.log"
for label in C1 C2 C3; do
  block="$scratch/$label.sh"; extract_cleanup_block "$label" "$S" > "$block"
  out=$(bash "$block" 2>&1); rc=$?
  if [[ "$rc" -eq 0 || -s "$ORCA_STUB_DIR/calls.log" ]]; then
    bad="$bad [$label-not-self-contained]"
  fi
  : > "$ORCA_STUB_DIR/calls.log"
done

# SK6d: C3 は inventory=null を「端末 0 件」と取り違えず、実行しても rm を表示しない。
cleanup_repo="$scratch/repo"; mkdir -p "$cleanup_repo"
git -C "$cleanup_repo" init -q -b main .
printf '%s\n' seed > "$cleanup_repo/README.md"
git -C "$cleanup_repo" add -A
git -C "$cleanup_repo" -c user.email=t@e -c user.name=t commit -q -m seed
jq -nc --arg p "$cleanup_repo" \
  '{worktree_id:"wt_1",worktree_path:$p,worktree_created_by_this_run:true,worktree_terminals:null,
    design:{terminal:"term_w",dispatch:"ctx_w"}}' > "$cleanup_state/workers.json"
printf '%s\n' '{"merged":true}' > "$cleanup_state/integration-result.json"
printf '%s\n' '{"ok":true,"result":{"state":"retained"}}' > "$ORCA_STUB_DIR/orchestration_worker-release"
printf '%s\n' '{"ok":true,"result":{"terminal":{"handle":"term_w","worktreeId":"wt_1"}}}' \
  > "$ORCA_STUB_DIR/terminal_show"
printf '%s\n' '{"ok":true,"result":{"terminals":[{"handle":"term_w"}]}}' > "$ORCA_STUB_DIR/terminal_list"
block="$scratch/C3-null.sh"; extract_cleanup_block C3 "$S" > "$block"
out=$(bash "$block" 2>&1); rc=$?
if [[ "$rc" -eq 0 || "$out" == *'worktree rm'* || $(grep -c 'worktree rm' "$ORCA_STUB_DIR/calls.log") -ne 0 ]]; then
  bad="$bad [C3-null-inventory]"
fi
unset ORCA_STUB_DIR ORCA_BIN SD
rm -rf "$scratch"
[[ -z "$bad" ]] && ok "SK6c 各 cleanup block が空/null state で閉じる" || fail "SK6c:$bad"

# SK7: 片付けの安全条件（release の state 分類 / merged / clean / --force）
miss=""
for n in 'release_pending' 'release_unknown' 'retained' 'already_released' \
         'merged' 'dirty' '--force' 'worktreeId'; do
  grep -qi -- "$n" "$S" || miss="$miss [$n]"; done
[[ -z "$miss" ]] && ok "SK7 安全条件" || fail "SK7 欠落:$miss"

# SK7a: runner は permission prompt を飛ばすことを、dispatch 前に判断できる文書へ明記する。
grep -q 'claude --dangerously-skip-permissions' "$S" \
  && grep -q 'claude --dangerously-skip-permissions' "$G" \
  && ok "SK7a runner の権限無効化を開示" || fail "SK7a 権限無効化の開示なし"

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

# SK8d: 訳は正本の操作手順を省略しない。すべての bash block を順序どおり完全に写す。
#         本文は翻訳してよいが、実行するコマンドを別物にしてはいけない。
extract_bash_blocks() {
  awk '/^```bash$/ { in_block=1; next }
       in_block && /^```$/ { printf "\\034"; in_block=0; next }
       in_block { print }' "$1"
}
blocks_s=$(mktemp); blocks_g=$(mktemp)
extract_bash_blocks "$S" >"$blocks_s"; extract_bash_blocks "$G" >"$blocks_g"
if cmp -s "$blocks_s" "$blocks_g"; then
  ok "SK8d bash block が完全一致"
else
  fail "SK8d guide-ja.md が操作 block を省略または変更している"
fi
rm -f "$blocks_s" "$blocks_g"

# SK8e: 訳は順序付きの見出し・表構造を正本と共有し、訳だけの運用節を持たない。
# 見出しは翻訳の差を canonical name に写してから順序まで比較する。未知の見出しは
# unknown として残るため、改名・置換・追加を同じ構造と取り違えない。
normalise_headings() {
  local mode="$1" file="$2" line
  while IFS= read -r line; do
    case "$mode:$line" in
      skill:'# Orca Team Dispatch'|guide:'# Orca Team Dispatch') echo 'h1:orca-team-dispatch' ;;
      skill:'## Output Language'|guide:'## 出力言語') echo 'h2:output-language' ;;
      skill:'## Step 1: Write the request down'|guide:'## Step 1: 依頼を書き出す') echo 'h2:step-1' ;;
      skill:'## Step 2: Start'|guide:'## Step 2: 開始') echo 'h2:step-2' ;;
      skill:'## Step 3: Wait'|guide:'## Step 3: 待つ') echo 'h2:step-3' ;;
      skill:'## Step 4: Bring the result home'|guide:'## Step 4: 成果を持ち帰る') echo 'h2:step-4' ;;
      skill:'## Step 5: Give the user the exact cleanup commands'|guide:'## Step 5: ユーザーへ正確な片付けコマンドを渡す') echo 'h2:step-5' ;;
      skill:'## Known limitations'|guide:'## 既知の制限') echo 'h2:known-limitations' ;;
      skill:'## State on disk'|guide:'## ディスク上の状態') echo 'h2:state-on-disk' ;;
      *) printf 'unknown:%s\n' "$line" ;;
    esac
  done < <(grep -E '^#{1,2} ' "$file")
}
heading_structure_matches() {
  [[ "$(normalise_headings skill "$1")" == "$(normalise_headings guide "$2")" ]]
}
normalise_table_structure() {
  awk '
    /^\|/ {
      if (!in_table) { table += 1; in_table = 1; }
      fields = split($0, cell, "|");
      kind = (cell[2] ~ /^---/) ? "separator" : "row";
      printf "table:%d:%s:columns:%d\\n", table, kind, fields - 2;
      next
    }
    { in_table = 0 }
  ' "$1"
}
table_structure_matches() {
  [[ "$(normalise_table_structure "$1")" == "$(normalise_table_structure "$2")" ]]
}
if heading_structure_matches "$S" "$G" && table_structure_matches "$S" "$G" \
  && ! grep -q '対応セクションなし' "$G"; then
  ok "SK8e guide-ja.md の構造が正本と一致"
else
  fail "SK8e guide-ja.md の構造が正本と一致しない"
fi

# SK8f: 同じ見出し数でも、名前の差し替えは構造一致として受け入れてはいけない。
fixture_s=$(mktemp); fixture_g=$(mktemp)
printf '%s\n' '# Orca Team Dispatch' '## Output Language' '## Step 1: Write the request down' >"$fixture_s"
printf '%s\n' '# Orca Team Dispatch' '## 出力言語' '## Step 9: 置換された見出し' >"$fixture_g"
if heading_structure_matches "$fixture_s" "$fixture_g"; then
  fail "SK8f 同数の見出し drift を受け入れた"
else
  ok "SK8f 同数の見出し drift を拒否"
fi
rm -f "$fixture_s" "$fixture_g"

# SK8g: 訳だけに運用節を足しても、同じ構造として受け入れてはいけない。
fixture_s=$(mktemp); fixture_g=$(mktemp)
printf '%s\n' '# Orca Team Dispatch' '## Output Language' >"$fixture_s"
printf '%s\n' '# Orca Team Dispatch' '## 出力言語' '## Step 1: 依頼を書き出す' >"$fixture_g"
if heading_structure_matches "$fixture_s" "$fixture_g"; then
  fail "SK8g guide-only の運用節を受け入れた"
else
  ok "SK8g guide-only の運用節を拒否"
fi
rm -f "$fixture_s" "$fixture_g"

# SK9: **README は運用手順を持たない**（正本は 1 つ）
if grep -qE 'worker-release|worktree rm|terminal close|task-list --run' "$P/README.md"; then
  fail "SK9 README が片付け手順を重複して持っている"
else ok "SK9 README は非 normative"; fi

# SK10: doc-lang
node "$ROOT/scripts/check-doc-lang.mjs" apps/orca-team-dispatch-task >/dev/null 2>&1 \
  && ok "SK10 doc-lang" || fail "SK10 doc-lang"
echo "---"; echo "failures: $fails"; exit "$fails"
