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

# SK4: **まだ実装していないものを宣言しない**
#      `review_mode` と `design_review` は実装したのでこの集合から外した。
#      **`exec_review` と `merge_ready` は残す** — Phase B 委譲 (spec の F-a) と
#      二相コミット (F-d) は未実装であり、宣言を防ぐガードが要る。
bad=""; for w in merge_ready nonce journal remediation exec_review; do
  grep -q -- "$w" "$S" && bad="$bad [$w]"; done
[[ -z "$bad" ]] && ok "SK4 未実装を宣言しない" || fail "SK4 未実装の宣言:$bad"

# SK5: **bare orca を書かない** (O1)。文書の中でも
if grep -nE '(^|[^_A-Za-z/$])orca (orchestration|terminal|worktree) ' "$S" "$G" >/dev/null 2>&1; then
  fail "SK5 bare orca を書いている ($(grep -nE '(^|[^_A-Za-z/$])orca (orchestration|terminal|worktree) ' "$S" "$G" | head -2))"
else ok "SK5 常に \$ORCA_BIN 経由"; fi

# SK6: **placeholder を見せない。**片付け手順は state から値を埋め、selector は id: を付ける
bad=""
grep -q '<the worker terminal>' "$S" && bad="$bad [placeholder]"
# Step 5 は release を **実行せず**、Step 6 が実行するコマンドとして印字する (CR-1)
grep -q 'worker-release --dispatch %q' "$S" || bad="$bad [release-printed]"
grep -q '"$ORCA_BIN" orchestration worker-release' "$S" && bad="$bad [release-executed]"
# selector は id: 接頭辞つきで、**%q で引用して**表示する（空白を含む path でも copy-paste 可）
grep -q '"id:\$WT"' "$S" || bad="$bad [id-prefix]"
grep -q "worktree rm --worktree %q" "$S" || bad="$bad [quoted-selector]"
grep -qE 'worktree rm --worktree \$WT( |$)' "$S" && bad="$bad [raw-id]"
grep -q "worker-release --dispatch %q --json" "$S" || bad="$bad [quoted-dispatch]"
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
bad=""
scratch=$(mktemp -d); cleanup_state="$scratch/state"; mkdir -p "$cleanup_state"
printf '%s\n' '{}' > "$cleanup_state/workers.json"
printf '%s\n' '{}' > "$cleanup_state/integration-result.json"
export ORCA_STUB_DIR="$scratch/orca" ORCA_BIN="$P/test/lib/orca-stub.sh" SD="$cleanup_state"
mkdir -p "$ORCA_STUB_DIR"; : > "$ORCA_STUB_DIR/calls.log"
for label in C1 C2 C3 C5 C7; do
  block="$scratch/$label.sh"; extract_cleanup_block "$label" "$S" > "$block"
  out=$(bash "$block" 2>&1); rc=$?
  if [[ "$rc" -eq 0 || -s "$ORCA_STUB_DIR/calls.log" ]]; then
    bad="$bad [$label-not-self-contained]"
  fi
  : > "$ORCA_STUB_DIR/calls.log"
done

# Step 5 は **mutate せずに** 分類する。release state は worker-list の非破壊 receipt から読む。
wl_fixture() {   # $1=releaseState
  jq -nc --arg s "$1" \
    '{ok:true,result:{workers:[{dispatchId:"ctx_w",taskId:"task_w",agentTerminalHandle:"term_w",
       terminalState:$s,resource:{ownershipState:$s,releaseState:$s,retainedReason:null,
       terminalHandle:"term_w",worktreeId:"wt_1"}}],counts:{}}}' \
    > "$ORCA_STUB_DIR/orchestration_worker-list"
}
printf '%s\n' '{"run_id":"run_x","parent_handle":"term_p"}' > "$cleanup_state/run.json"

# SK6d: C3 は inventory=null を「端末 0 件」と取り違えず、理由を示して rm を表示しない。
cleanup_repo="$scratch/repo"; mkdir -p "$cleanup_repo"
git -C "$cleanup_repo" init -q -b main .
printf '%s\n' seed > "$cleanup_repo/README.md"
git -C "$cleanup_repo" add -A
git -C "$cleanup_repo" -c user.email=t@e -c user.name=t commit -q -m seed
jq -nc --arg p "$cleanup_repo" \
  '{roles:{design:{terminal:"term_w",dispatch:"ctx_w",retained:false,
      worktree_id:"wt_1",worktree_path:$p,worktree_created_by_this_run:true,worktree_terminals:null}}}' > "$cleanup_state/workers.json"
printf '%s\n' '{"merged":true}' > "$cleanup_state/integration-result.json"
wl_fixture retained
printf '%s\n' '{"ok":true,"result":{"terminal":{"handle":"term_w","worktreeId":"wt_1"}}}' \
  > "$ORCA_STUB_DIR/terminal_show"
printf '%s\n' '{"ok":true,"result":{"terminals":[{"handle":"term_w"}]}}' > "$ORCA_STUB_DIR/terminal_list"
block="$scratch/C3-null.sh"; extract_cleanup_block C3 "$S" > "$block"
out=$(bash "$block" 2>&1); rc=$?
if [[ "$rc" -ne 0 || "$out" != *'not offering to remove the design worktree:'* \
   || "$out" != *'the terminals in that worktree could not be listed, so nothing is proven'* \
   || "$out" == *'worktree rm'* || $(grep -c 'worktree rm' "$ORCA_STUB_DIR/calls.log") -ne 0 ]]; then
  bad="$bad [C3-null-inventory]"
fi

# SK6e: すべての先行確認が通っても、未記録 terminal があれば C3 は削除を提案しない。
#        これが ACCOUNTED=yes を破壊的 gate に要求する実行上の証明である。
#        併せて **C3 が worker-release を呼ばない**（分類は非破壊）ことも固定する。
jq -nc --arg p "$cleanup_repo" \
  '{roles:{design:{terminal:"term_w",dispatch:"ctx_w",retained:false,
      worktree_id:"wt_1",worktree_path:$p,worktree_created_by_this_run:true,worktree_terminals:["term_w"]}}}' > "$cleanup_state/workers.json"
printf '%s\n' '{"merged":true}' > "$cleanup_state/integration-result.json"
wl_fixture retained
printf '%s\n' '{"ok":true,"result":{"terminal":{"handle":"term_w","worktreeId":"wt_1"}}}' \
  > "$ORCA_STUB_DIR/terminal_show"
printf '%s\n' '{"ok":true,"result":{"terminals":[{"handle":"term_w"},{"handle":"term_foreign"}]}}' \
  > "$ORCA_STUB_DIR/terminal_list"
: > "$ORCA_STUB_DIR/calls.log"
block="$scratch/C3-unaccounted.sh"; extract_cleanup_block C3 "$S" > "$block"
out=$(bash "$block" 2>&1); rc=$?
if [[ "$rc" -ne 0 || "$out" != *'not offering to remove the design worktree:'* \
   || "$out" != *'a terminal in that worktree is not one we recorded'* \
   || "$out" == *'worktree rm'* || $(grep -c 'worktree rm' "$ORCA_STUB_DIR/calls.log") -ne 0 ]] \
   || ! grep -q 'worker-list' "$ORCA_STUB_DIR/calls.log" \
   || ! grep -q 'terminal show' "$ORCA_STUB_DIR/calls.log" \
   || ! grep -q 'terminal list' "$ORCA_STUB_DIR/calls.log" \
   || grep -q 'worker-release' "$ORCA_STUB_DIR/calls.log"; then
  bad="$bad [C3-unaccounted-terminal]"
fi

# SK6f: cleanup は各 Orca receipt の rc、ok、result schema を検査する。失敗 receipt に
# 古い成功 state が残っていても、破壊的コマンドを表示してはならない。
jq -nc --arg p "$cleanup_repo" \
  '{roles:{design:{terminal:"term_w",dispatch:"ctx_w",retained:false,
      worktree_id:"wt_1",worktree_path:$p,worktree_created_by_this_run:true,worktree_terminals:["term_w"]}}}' > "$cleanup_state/workers.json"
printf '%s\n' '{"merged":true}' > "$cleanup_state/integration-result.json"
printf '%s\n' '{"ok":false,"error":"unavailable","result":{"workers":[]}}' \
  > "$ORCA_STUB_DIR/orchestration_worker-list"
printf '%s\n' 7 > "$ORCA_STUB_DIR/orchestration_worker-list.rc"
printf '%s\n' '{"ok":true,"result":{"terminal":{"handle":"term_w","worktreeId":"wt_1"}}}' \
  > "$ORCA_STUB_DIR/terminal_show"
printf '%s\n' '{"ok":true,"result":{"terminals":[{"handle":"term_w"}]}}' > "$ORCA_STUB_DIR/terminal_list"
block="$scratch/C1-state-receipt.sh"; extract_cleanup_block C1 "$S" > "$block"
out=$(bash "$block" 2>&1); rc=$?
if [[ "$rc" -eq 0 || "$out" != *'could not read the release state; do not close anything'* \
   || "$out" == *'worker-show'* ]]; then
  bad="$bad [C1-state-failed-receipt]"
fi
block="$scratch/C2-state-receipt.sh"; extract_cleanup_block C2 "$S" > "$block"
out=$(bash "$block" 2>&1); rc=$?
if [[ "$rc" -eq 0 || "$out" == *'worker-release --dispatch'* ]]; then
  bad="$bad [C2-state-failed-receipt]"
fi
block="$scratch/C3-state-receipt.sh"; extract_cleanup_block C3 "$S" > "$block"
out=$(bash "$block" 2>&1); rc=$?
if [[ "$rc" -eq 0 || "$out" == *'worktree rm'* ]]; then
  bad="$bad [C3-state-failed-receipt]"
fi
rm -f "$ORCA_STUB_DIR/orchestration_worker-list.rc"

# SK6f2: receipt は ok でも **この dispatch が Orca の報告に無い**なら分類できない。止まる。
printf '%s\n' '{"ok":true,"result":{"workers":[{"dispatchId":"ctx_other"}],"counts":{}}}' \
  > "$ORCA_STUB_DIR/orchestration_worker-list"
out=$(bash "$scratch/C1-state-receipt.sh" 2>&1); rc=$?
[[ "$rc" -ne 0 && "$out" == *'could not read the release state'* ]] || bad="$bad [C1-dispatch-absent]"
out=$(bash "$scratch/C2-state-receipt.sh" 2>&1); rc=$?
[[ "$rc" -ne 0 && "$out" != *'worker-release --dispatch'* ]] || bad="$bad [C2-dispatch-absent]"
out=$(bash "$scratch/C3-state-receipt.sh" 2>&1); rc=$?
[[ "$rc" -ne 0 && "$out" != *'worktree rm'* ]] || bad="$bad [C3-dispatch-absent]"

# SK6g: `release_unknown` は **止まる**合図であり、C1 だけが exit 0 で受け取る。
#        C1 は報告された worker entry と inspection command を出し、C2 / C3 は何も提示しない。
wl_fixture release_unknown
: > "$ORCA_STUB_DIR/calls.log"
block="$scratch/C1-release-unknown.sh"; extract_cleanup_block C1 "$S" > "$block"
out=$(bash "$block" 2>&1); rc=$?
if [[ "$rc" -ne 0 || "$out" != *'"releaseState":"release_unknown"'* \
   || "$out" != *'orchestration worker-show --dispatch ctx_w --json'* \
   || "$out" == *'could not read the release state'* ]] \
   || grep -q 'worker-release' "$ORCA_STUB_DIR/calls.log"; then
  bad="$bad [C1-release-unknown]"
fi
out=$(bash "$scratch/C2-state-receipt.sh" 2>&1); rc=$?
[[ "$rc" -ne 0 && "$out" == *'does not authorise C2'* ]] || bad="$bad [C2-release-unknown]"
out=$(bash "$scratch/C3-state-receipt.sh" 2>&1); rc=$?
[[ "$rc" -ne 0 && "$out" == *'does not authorise C3'* && "$out" != *'worktree rm'* ]] \
  || bad="$bad [C3-release-unknown]"

# SK6g2: **通常経路の C1 は exit 1 で「止まれ」と言わない。**`expected:` で始まる 1 行だけを出し、
#         inspection command は出さない。読み手はそのまま [C2] へ進む。
for st in retained released already_released active reclaimable; do
  wl_fixture "$st"
  out=$(bash "$scratch/C1-state-receipt.sh" 2>&1); rc=$?
  if [[ "$rc" -eq 0 || "$out" != expected:* || "$out" == *'worker-show'* ]]; then
    bad="$bad [C1-normal-$st]"
  fi
done

printf '%s\n' '{"ok":false,"error":"stale","result":{"terminal":{"handle":"term_w","worktreeId":"wt_1"}}}' \
  > "$ORCA_STUB_DIR/terminal_show"
wl_fixture retained
block="$scratch/C2-show-receipt.sh"; extract_cleanup_block C2 "$S" > "$block"
out=$(bash "$block" 2>&1); rc=$?
if [[ "$rc" -eq 0 || "$out" == *'worker-release --dispatch'* ]]; then
  bad="$bad [C2-show-failed-receipt]"
fi
block="$scratch/C3-show-receipt.sh"; extract_cleanup_block C3 "$S" > "$block"
out=$(bash "$block" 2>&1); rc=$?
if [[ "$rc" -eq 0 || "$out" == *'worktree rm'* ]]; then
  bad="$bad [C3-show-failed-receipt]"
fi

printf '%s\n' '{"ok":true,"result":{"terminal":{"handle":"term_w","worktreeId":"wt_1"}}}' \
  > "$ORCA_STUB_DIR/terminal_show"
printf '%s\n' '{"ok":false,"error":"stale","result":{"terminals":[{"handle":"term_w"}]}}' \
  > "$ORCA_STUB_DIR/terminal_list"
block="$scratch/C3-list-receipt.sh"; extract_cleanup_block C3 "$S" > "$block"
out=$(bash "$block" 2>&1); rc=$?
if [[ "$rc" -ne 0 || "$out" != *'not offering to remove the design worktree:'* \
   || "$out" != *'the terminals in that worktree could not be listed, so nothing is proven'* \
   || "$out" == *'worktree rm'* ]]; then
  bad="$bad [C3-list-failed-receipt]"
fi

# SK6h/SK6i/SK6j: 端末が既に閉じている（`released` / `already_released`）なら C2 は提示せず、
#        C3 は「show できないこと」を identity の証明として扱う。両 state を同じ表で回す。
printf '%s\n' '{"ok":true,"result":{"terminals":[{"handle":"term_w"}]}}' > "$ORCA_STUB_DIR/terminal_list"
block="$scratch/C2-released.sh"; extract_cleanup_block C2 "$S" > "$block"
c3_block="$scratch/C3-released.sh"; extract_cleanup_block C3 "$S" > "$c3_block"
for st in released already_released; do
  wl_fixture "$st"
  # 端末は既に閉じている。show は引けない
  printf '%s\n' '{"ok":false,"error":"gone"}' > "$ORCA_STUB_DIR/terminal_show"
  printf '%s\n' 7 > "$ORCA_STUB_DIR/terminal_show.rc"
  : > "$ORCA_STUB_DIR/calls.log"
  out=$(bash "$block" 2>&1); rc=$?
  if [[ "$rc" -ne 0 || "$out" != *'Orca already closed the design terminal; nothing to close'* \
     || "$out" == *'worker-release --dispatch'* ]]; then
    bad="$bad [C2-$st]"
  fi
  : > "$ORCA_STUB_DIR/calls.log"
  out=$(bash "$c3_block" 2>&1); rc=$?
  if [[ "$rc" -ne 0 || "$out" != *'worktree rm --worktree id:wt_1 --json'* \
     || "$out" == *'could not verify the terminal identity'* ]]; then
    bad="$bad [C3-$st-show-gone]"
  fi
  # 端末がまだ見えて記録と一致するなら、identity は証明され削除も提示される
  rm -f "$ORCA_STUB_DIR/terminal_show.rc"
  printf '%s\n' '{"ok":true,"result":{"terminal":{"handle":"term_w","worktreeId":"wt_1"}}}' \
    > "$ORCA_STUB_DIR/terminal_show"
  : > "$ORCA_STUB_DIR/calls.log"
  out=$(bash "$c3_block" 2>&1); rc=$?
  if [[ "$rc" -ne 0 || "$out" != *'worktree rm --worktree id:wt_1 --json'* ]]; then
    bad="$bad [C3-$st-show-live]"
  fi
done

# SK6l: **identity の脚を実行で固定する。**端末は生きているが記録と違う worktree を報告する。
#        C3 は理由を述べて rm を出さず、C2 も close を提示しない。この fixture が無いと
#        `IDENTITY_OK=no` → `IDENTITY_OK=yes` の改変がスイート全体を緑のまま通ってしまう。
rm -f "$ORCA_STUB_DIR/terminal_show.rc"
wl_fixture retained
printf '%s\n' '{"ok":true,"result":{"terminal":{"handle":"term_w","worktreeId":"wt_other"}}}' \
  > "$ORCA_STUB_DIR/terminal_show"
printf '%s\n' '{"ok":true,"result":{"terminals":[{"handle":"term_w"}]}}' > "$ORCA_STUB_DIR/terminal_list"
: > "$ORCA_STUB_DIR/calls.log"
out=$(bash "$c3_block" 2>&1); rc=$?
if [[ "$rc" -ne 0 || "$out" != *'not offering to remove the design worktree:'* \
   || "$out" != *'the terminal identity did not match our state'* \
   || "$out" == *'worktree rm'* ]]; then
  bad="$bad [C3-identity-mismatch]"
fi
out=$(bash "$block" 2>&1); rc=$?
if [[ "$rc" -ne 0 || "$out" != *'the design terminal no longer matches our state; leave it alone'* \
   || "$out" == *'worker-release --dispatch'* ]]; then
  bad="$bad [C2-identity-mismatch]"
fi

# SK6k: **1 つの Run に 2 タスクを載せ、文書どおりの順で通しで走らせる。**Step 5 は
#        release を **1 度も呼ばない**（CR-1）。C2 は release コマンドを *印字* し、
#        C3 は判定に到達し、C7 は Run 全体を通す。block 単体のテストではこの経路を踏めない。
# SK6m: ★ **cleanup は roles を走査する。**レビューモードでは 1 タスクに 2 役が居るので、
#        design だけを見ると **reviewer の端末と worktree が取り残される**。
#        片方が merge 済みでも、もう片方の checkout が dirty なら**その役だけ**提示しない。
two_roles_state() {   # $1=design の dirty(yes/no) $2=review の dirty(yes/no)
  jq -nc --arg dp "$cleanup_repo" --arg rp "$rv_repo" \
    '{roles:{
       design:       {terminal:"term_d",dispatch:"ctx_d",retained:false,
                      worktree_id:"wt_d",worktree_path:$dp,
                      worktree_created_by_this_run:true,worktree_terminals:["term_d"]},
       design_review:{terminal:"term_r",dispatch:"ctx_r",retained:false,
                      worktree_id:"wt_r",worktree_path:$rp,
                      worktree_created_by_this_run:true,worktree_terminals:["term_r"]}}}' \
    > "$cleanup_state/workers.json"
}
rv_repo="$scratch/rv"; mkdir -p "$rv_repo"
git -C "$rv_repo" init -q -b main .
printf '%s\n' seed > "$rv_repo/README.md"
git -C "$rv_repo" add -A
git -C "$rv_repo" -c user.email=t@e -c user.name=t commit -q -m seed
jq -nc '{ok:true,result:{workers:[
   {dispatchId:"ctx_d",terminalState:"retained",resource:{releaseState:"retained",terminalHandle:"term_d",worktreeId:"wt_d"}},
   {dispatchId:"ctx_r",terminalState:"retained",resource:{releaseState:"retained",terminalHandle:"term_r",worktreeId:"wt_r"}}],counts:{}}}' \
  > "$ORCA_STUB_DIR/orchestration_worker-list"
cat > "$ORCA_STUB_DIR/terminal_show.hook" <<'HOOK'
#!/usr/bin/env bash
for a in "$@"; do case "$prev" in --terminal) t="$a" ;; esac; prev="$a"; done
w=wt_d; [ "$t" = term_r ] && w=wt_r
printf '{"ok":true,"result":{"terminal":{"handle":"%s","worktreeId":"%s"}}}\n' "$t" "$w" \
  > "$ORCA_STUB_DIR/terminal_show"
HOOK
chmod +x "$ORCA_STUB_DIR/terminal_show.hook"
cat > "$ORCA_STUB_DIR/terminal_list.hook" <<'HOOK'
#!/usr/bin/env bash
for a in "$@"; do case "$prev" in --worktree) w="$a" ;; esac; prev="$a"; done
h=term_d; [ "$w" = "id:wt_r" ] && h=term_r
printf '{"ok":true,"result":{"terminals":[{"handle":"%s"}]}}\n' "$h" > "$ORCA_STUB_DIR/terminal_list"
HOOK
chmod +x "$ORCA_STUB_DIR/terminal_list.hook"
printf '%s\n' '{"merged":true}' > "$cleanup_state/integration-result.json"
two_roles_state

: > "$ORCA_STUB_DIR/calls.log"
out=$(bash "$scratch/C2-state-receipt.sh" 2>&1)
if [[ "$(grep -c 'worker-release --dispatch ctx_d' <<<"$out")" -ne 1 \
   || "$(grep -c 'worker-release --dispatch ctx_r' <<<"$out")" -ne 1 ]]; then
  bad="$bad [C2-two-roles]"
fi

: > "$ORCA_STUB_DIR/calls.log"
out=$(bash "$scratch/C3-state-receipt.sh" 2>&1)
if [[ "$(grep -c 'worktree rm --worktree id:wt_d' <<<"$out")" -ne 1 \
   || "$(grep -c 'worktree rm --worktree id:wt_r' <<<"$out")" -ne 1 ]]; then
  bad="$bad [C3-two-roles]"
fi

# reviewer の checkout だけ dirty にする → **その役だけ**提示されない
printf '%s\n' dirt > "$rv_repo/dirty.txt"
: > "$ORCA_STUB_DIR/calls.log"
out=$(bash "$scratch/C3-state-receipt.sh" 2>&1)
if [[ "$out" != *'worktree rm --worktree id:wt_d'* \
   || "$out" == *'worktree rm --worktree id:wt_r'* \
   || "$out" != *'not offering to remove the design_review worktree:'* \
   || "$out" != *'the worker checkout has uncommitted changes'* ]]; then
  bad="$bad [C3-per-role-dirty]"
fi
rm -f "$rv_repo/dirty.txt" "$ORCA_STUB_DIR/terminal_show.hook" "$ORCA_STUB_DIR/terminal_list.hook"


unset SD
two=$(mktemp -d); two=$(cd "$two" && pwd -P)
two_repo="$two/repo"; mkdir -p "$two_repo"
git -C "$two_repo" init -q -b main .
printf '%s\n' seed > "$two_repo/README.md"; git -C "$two_repo" add -A
git -C "$two_repo" -c user.email=t@e -c user.name=t commit -q -m seed
for t in a b; do
  d="$two/.dispatch/task-$t"; mkdir -p "$d"
  printf '%s\n' '{"run_id":"run_x","parent_handle":"term_p"}' > "$d/run.json"
  jq -nc --arg p "$two_repo" --arg w "wt_$t" --arg h "term_$t" --arg c "ctx_$t" \
    '{roles:{design:{terminal:$h,dispatch:$c,retained:true,
      worktree_id:$w,worktree_path:$p,worktree_created_by_this_run:true,worktree_terminals:[$h]}}}' > "$d/workers.json"
  printf '%s\n' '{"merged":true}' > "$d/integration-result.json"
done
export ORCA_STUB_DIR="$two/orca"; mkdir -p "$ORCA_STUB_DIR"
jq -nc '{ok:true,result:{workers:[
   {dispatchId:"ctx_a",taskId:"task_a",agentTerminalHandle:"term_a",terminalState:"retained",
    resource:{ownershipState:"retained",releaseState:"retained",retainedReason:"user_requested",
              terminalHandle:"term_a",worktreeId:"wt_a"}},
   {dispatchId:"ctx_b",taskId:"task_b",agentTerminalHandle:"term_b",terminalState:"retained",
    resource:{ownershipState:"retained",releaseState:"retained",retainedReason:"user_requested",
              terminalHandle:"term_b",worktreeId:"wt_b"}}],counts:{retained:2}}}' \
  > "$ORCA_STUB_DIR/orchestration_worker-list"
cat > "$ORCA_STUB_DIR/terminal_show.hook" <<'HOOK'
#!/usr/bin/env bash
h=""; while [[ $# -gt 0 ]]; do [[ "$1" == --terminal ]] && h="$2"; shift; done
case "$h" in
  term_a) w=wt_a ;; term_b) w=wt_b ;; *) w=unknown ;;
esac
printf '{"ok":true,"result":{"terminal":{"handle":"%s","worktreeId":"%s"}}}\n' "$h" "$w" \
  > "$ORCA_STUB_DIR/terminal_show"
HOOK
cat > "$ORCA_STUB_DIR/terminal_list.hook" <<'HOOK'
#!/usr/bin/env bash
w=""; while [[ $# -gt 0 ]]; do [[ "$1" == --worktree ]] && w="$2"; shift; done
case "$w" in
  id:wt_a) h=term_a ;; id:wt_b) h=term_b ;; *) h=term_unknown ;;
esac
printf '{"ok":true,"result":{"terminals":[{"handle":"%s"}]}}\n' "$h" \
  > "$ORCA_STUB_DIR/terminal_list"
HOOK
chmod +x "$ORCA_STUB_DIR/terminal_show.hook" "$ORCA_STUB_DIR/terminal_list.hook"
: > "$ORCA_STUB_DIR/calls.log"
for l in C1 C2 C3 C5 C7; do extract_cleanup_block "$l" "$S" > "$two/$l.sh"; done
sed -i.bak 's|^SDS=("\$SD")|SDS=("$SD" "'"$two/.dispatch/task-b"'")|' "$two/C7.sh"
two_offered=""
for t in a b; do
  d="$two/.dispatch/task-$t"
  out=$(SD="$d" bash "$two/C1.sh" 2>&1); rc=$?
  [[ "$rc" -ne 0 && "$out" == expected:* ]] || bad="$bad [two-C1-$t]"
  out=$(SD="$d" bash "$two/C2.sh" 2>&1); rc=$?
  [[ "$rc" -eq 0 && "$out" == *"orchestration worker-release --dispatch ctx_$t --json"* ]] \
    || bad="$bad [two-C2-$t]"
  two_offered="$two_offered$out"
  out=$(SD="$d" bash "$two/C3.sh" 2>&1); rc=$?
  [[ "$rc" -eq 0 && "$out" == *"worktree rm --worktree id:wt_$t --json"* ]] || bad="$bad [two-C3-$t]"
  out=$(SD="$d" bash "$two/C5.sh" 2>&1); rc=$?
  [[ "$rc" -eq 0 && "$out" == "rm -rf $d" ]] || bad="$bad [two-C5-$t]"
done
out=$(SD="$two/.dispatch/task-a" bash "$two/C7.sh" 2>&1); rc=$?
[[ "$rc" -eq 0 && "$out" == *'every retained worker in this Run is one we recorded'* ]] \
  || bad="$bad [two-C7]"
# ★ CR-1 の核心。Step 5 は **どの block でも release を実行しない**
grep -q 'worker-release' "$ORCA_STUB_DIR/calls.log" && bad="$bad [two-step5-released]"
# Step 6 が尋ねる選択肢に端末の release が含まれること
[[ "$two_offered" == *'worker-release --dispatch ctx_a --json'* \
   && "$two_offered" == *'worker-release --dispatch ctx_b --json'* ]] \
  || bad="$bad [two-step6-no-terminal-option]"
rm -rf "$two"

unset ORCA_STUB_DIR ORCA_BIN SD
rm -rf "$scratch"
[[ -z "$bad" ]] && ok "SK6c 各 cleanup block が空/null/失敗 receipt で閉じる" || fail "SK6c:$bad"

# SK6n: ★ **Issue モードの block も、前の block の変数が無ければ fail closed する。**
#        `$SCRIPTS` が空のまま素通しすると `/issue-fetch.sh` を黙って叩き、何も起きて
#        いないのに成功したように見える。cleanup の SK6c と同じ不変条件である。
bad=""
issec=$(mktemp)
awk '/^## Issue mode$/{s=1} s&&/^## Step 1:/{exit} s' "$S" > "$issec"
nth_block() { awk -v n="$1" '/^```bash$/{b++; if(b==n){f=1; next}} f&&/^```$/{exit} f{print}' "$issec"; }
probe=$(mktemp -d)
for n in 2 3 4; do
  blk="$probe/i$n.sh"; nth_block "$n" > "$blk"
  out=$(env -u SCRIPTS -u STATE -u NUM -u SLUG -u REQ -u PLUGIN bash "$blk" 2>&1); rc=$?
  # 未設定なら **非 0 で止まる**こと。/issue-fetch.sh を叩いていないこと
  if [[ "$rc" -eq 0 || "$out" == *'/issue-fetch.sh: No such file'* ]]; then
    bad="$bad [I$n-not-fail-closed]"
  fi
done
rm -rf "$probe" "$issec"
[[ -z "$bad" ]] && ok "SK6n Issue モードの block が fail closed" || fail "SK6n:$bad"

# SK7: 片付けの安全条件（release の state 分類 / merged / clean / --force）
miss=""
for n in 'release_pending' 'release_unknown' 'retained' 'already_released' \
         'merged' 'dirty' '--force' 'worktreeId'; do
  grep -qi -- "$n" "$S" || miss="$miss [$n]"; done
[[ -z "$miss" ]] && ok "SK7 安全条件" || fail "SK7 欠落:$miss"

# SK7b: **列挙できないことを「0 個」にしない** (round 4 finding 1)。
#       ACCOUNTED は yes / no / unknown を保ち、yes 以外では削除を提示しないこと
miss=""
grep -q '.ok == true and (.result.terminals | type == "array")' "$S" || miss="$miss [ok-and-schema-check]"
grep -q 'the terminals in that worktree could not be listed, so nothing is proven' "$S" \
  || miss="$miss [unknown-diagnostic]"
grep -q 'ACCOUNTED=unknown' "$S" || miss="$miss [unknown-state]"
grep -q '&& "$ACCOUNTED" == yes' "$S" || miss="$miss [gate-requires-yes]"
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
      skill:'## Configuration'|guide:'## 設定') echo 'h2:configuration' ;;
      skill:'## Issue mode'|guide:'## Issue モード') echo 'h2:issue-mode' ;;
      skill:'## Step 1: Write the request down'|guide:'## Step 1: 依頼を書き出す') echo 'h2:step-1' ;;
      skill:'## Step 2: Start'|guide:'## Step 2: 開始') echo 'h2:step-2' ;;
      skill:'## Step 3: Wait'|guide:'## Step 3: 待つ') echo 'h2:step-3' ;;
      skill:'## Step 4: Bring the result home'|guide:'## Step 4: 成果を持ち帰る') echo 'h2:step-4' ;;
      skill:'## Step 5: Give the user the exact cleanup commands'|guide:'## Step 5: ユーザーへ正確な片付けコマンドを渡す') echo 'h2:step-5' ;;
      skill:'## Step 6: Ask once, then run what the user approves'|guide:'## Step 6: 一度だけ尋ね、承認されたものを実行する') echo 'h2:step-6' ;;
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

# SK9b: release_unknown は手動 ack せず、receipt/result を確認したうえでだけ手動統合できる。
#       元の親端末の queue は残るため、次回 dispatch は別の Orca terminal から開始する。
if grep -q 'do not proceed to Step 4' "$S" \
   && grep -q 'Step 4 へ進まない' "$G" \
   && grep -q '\$SD/received.json' "$S" \
   && grep -q '\$SD/roles/design/result.md' "$S" \
   && grep -q 'manual integration does not unblock that queue' "$S" \
   && grep -q 'ORCA_TERMINAL_HANDLE' "$S" \
   && grep -q '手動統合で queue は解消されない' "$G" \
   && grep -q 'ORCA_TERMINAL_HANDLE' "$G" \
   && awk '/^## Known limitations$/,/^## State on disk$/' "$S" | grep -q 'release_unknown' \
   && awk '/^## 既知の制限$/,/^## ディスク上の状態$/' "$G" | grep -q 'release_unknown' \
   && awk '/^## Known limitations$/,/^## State on disk$/' "$S" \
      | grep -q 'stays unacknowledged and blocks its parent terminal' \
   && awk '/^## 既知の制限$/,/^## ディスク上の状態$/' "$G" \
      | grep -q 'acknowledge されないまま親 terminal の queue を block' \
   && ! grep -q 'A `release_unknown` batch' "$S" \
   && ! grep -q 'leave the original parent queue' "$S" \
   && ! grep -q '元の親 queue は blocked のまま' "$G"; then
  ok "SK9b release_unknown の成果導線と親端末制限を明示"
else
  fail "SK9b release_unknown の成果導線または親端末制限が不足"
fi

# SK9c: C3 は C2 の shell 変数を受け取らず、自身で terminal identity を証明する。
if ! grep -q 'IDENTITY_OK.*comes from \[C2\]' "$S" \
   && ! grep -q 'IDENTITY_OK.*\[C2\] の結果' "$G"; then
  ok "SK9c C3 の identity 証明は独立"
else
  fail "SK9c C3 が C2 の変数を要求している"
fi

# SK11: [C5] は merge 済みのときだけ dispatch 記録の削除を提示し、記録でない場所や
#       .dispatch の外では fail closed する。**破壊コマンドを印字しないことまで見る。**
bad=""
c5_scratch=$(mktemp -d); c5_scratch=$(cd "$c5_scratch" && pwd -P)
c5_block="$c5_scratch/C5.sh"; extract_cleanup_block C5 "$S" > "$c5_block"
c5_sd="$c5_scratch/.dispatch/demo"; mkdir -p "$c5_sd"
printf '%s\n' '{}' > "$c5_sd/run.json"
printf '%s\n' '{}' > "$c5_sd/workers.json"

printf '%s\n' '{"merged":false}' > "$c5_sd/integration-result.json"
out=$(SD="$c5_sd" bash "$c5_block" 2>&1); rc=$?
if [[ "$rc" -ne 0 || "$out" != *'not offering to remove the dispatch record:'* \
   || "$out" != *'the work is not merged yet'* || "$out" == *'rm -rf'* ]]; then
  bad="$bad [C5-unmerged]"
fi

printf '%s\n' '{"merged":true}' > "$c5_sd/integration-result.json"
out=$(SD="$c5_sd" bash "$c5_block" 2>&1); rc=$?
if [[ "$rc" -ne 0 || "$out" != "rm -rf $c5_sd" ]]; then
  bad="$bad [C5-merged]"
fi

c5_outside="$c5_scratch/not-dispatch/demo"; mkdir -p "$c5_outside"
printf '%s\n' '{}' > "$c5_outside/run.json"
printf '%s\n' '{}' > "$c5_outside/workers.json"
printf '%s\n' '{"merged":true}' > "$c5_outside/integration-result.json"
out=$(SD="$c5_outside" bash "$c5_block" 2>&1); rc=$?
if [[ "$rc" -eq 0 || "$out" == *'rm -rf'* ]]; then bad="$bad [C5-outside-dispatch]"; fi

c5_bare="$c5_scratch/.dispatch/bare"; mkdir -p "$c5_bare"
printf '%s\n' '{"merged":true}' > "$c5_bare/integration-result.json"
out=$(SD="$c5_bare" bash "$c5_block" 2>&1); rc=$?
if [[ "$rc" -eq 0 || "$out" == *'rm -rf'* ]]; then bad="$bad [C5-not-a-record]"; fi
rm -rf "$c5_scratch"
[[ -z "$bad" ]] && ok "SK11 [C5] は merge 済みの dispatch 記録だけを提示" || fail "SK11:$bad"

# SK12: Step 6 は Step 5 の印字だけを実行する。順序・停止条件・非改変・**尋ねない条件**を
#       正本と訳の両方で明示すること。
miss=""
grep -q '^## Step 6: Ask once, then run what the user approves$' "$S" || miss="$miss [step6-heading]"
grep -q '^## Step 6: 一度だけ尋ね、承認されたものを実行する$' "$G" || miss="$miss [step6-heading-ja]"
grep -q 'exactly as Step 5 printed it' "$S" || miss="$miss [verbatim]"
grep -q 'Step 5 が印字したとおりに実行する' "$G" || miss="$miss [verbatim-ja]"
grep -q 'terminal, then worktree, then dispatch record' "$S" || miss="$miss [order]"
grep -q '端末 → worktree → dispatch 記録 の順' "$G" || miss="$miss [order-ja]"
grep -q 'it counted only when `.ok == true`' "$S" || miss="$miss [receipt-gate]"
grep -q 'there is nothing to approve' "$S" || miss="$miss [no-print-no-ask]"
grep -q 'Never offer an action Step 5 declined to print' "$S" || miss="$miss [no-extra-option]"
awk '/^## Step 6: /,/^## Known limitations$/' "$S" | grep -q -- '--force' || miss="$miss [no-force]"
awk '/^## Step 6: /,/^## 既知の制限$/' "$G" | grep -q -- '--force' || miss="$miss [no-force-ja]"
[[ -z "$miss" ]] && ok "SK12 Step 6 の実行規則" || fail "SK12:$miss"

# SK13: [C7] は記録に無い保持中 dispatch を見つけたら止める
c7_scratch=$(mktemp -d); c7="$c7_scratch/C7.sh"
extract_cleanup_block C7 "$S" > "$c7"
c7_sd=$(mktemp -d)
echo '{"run_id":"run_x","parent_handle":"term_p","repo_root":"/tmp"}' > "$c7_sd/run.json"
echo '{"roles":{"design":{"dispatch":"ctx_w","retained":true}}}' > "$c7_sd/workers.json"

ORCA_STUB_DIR=$(mktemp -d); export ORCA_STUB_DIR ORCA_BIN="$P/test/lib/orca-stub.sh"
printf '%s\n' '{"ok":true,"result":{"workers":[{"dispatchId":"ctx_w"}]}}' \
  > "$ORCA_STUB_DIR/orchestration_worker-list"
out=$(SD="$c7_sd" bash "$c7" 2>&1); rc=$?
[[ "$rc" -eq 0 ]] && ok "SK13a 記録どおりなら通す" || fail "SK13a (rc=$rc out=$out)"

printf '%s\n' '{"ok":true,"result":{"workers":[{"dispatchId":"ctx_w"},{"dispatchId":"ctx_ghost"}]}}' \
  > "$ORCA_STUB_DIR/orchestration_worker-list"
out=$(SD="$c7_sd" bash "$c7" 2>&1); rc=$?
[[ "$rc" -ne 0 && "$out" == *ctx_ghost* ]] && ok "SK13b 記録に無い保持で止まる" \
  || fail "SK13b (rc=$rc out=$out)"

printf '%s\n' '{"ok":false,"error":"unavailable"}' > "$ORCA_STUB_DIR/orchestration_worker-list"
out=$(SD="$c7_sd" bash "$c7" 2>&1); rc=$?
[[ "$rc" -ne 0 ]] && ok "SK13c 列挙できなければ止まる" || fail "SK13c (rc=$rc out=$out)"

# SK13d/e: SDS は Run 全体の記録を作るための入力である。同じ Run の兄弟を足せば ghost 判定が
#          狭まらず、**別 Run の dir を混ぜたら既知集合が広がって本物の ghost を隠す**ので止まる。
c7_sib=$(mktemp -d)
echo '{"run_id":"run_x","parent_handle":"term_p","repo_root":"/tmp"}' > "$c7_sib/run.json"
echo '{"roles":{"design":{"dispatch":"ctx_sib","retained":true}}}' > "$c7_sib/workers.json"
c7_other=$(mktemp -d)
echo '{"run_id":"run_y","parent_handle":"term_q","repo_root":"/tmp"}' > "$c7_other/run.json"
echo '{"roles":{"design":{"dispatch":"ctx_other","retained":true}}}' > "$c7_other/workers.json"
with_sds() {   # $1=追加する status dir → SDS を 2 件にした C7 を stdout
  sed 's|^SDS=("\$SD")|SDS=("$SD" "'"$1"'")|' "$c7"
}
printf '%s\n' '{"ok":true,"result":{"workers":[{"dispatchId":"ctx_w"},{"dispatchId":"ctx_sib"}]}}' \
  > "$ORCA_STUB_DIR/orchestration_worker-list"
with_sds "$c7_sib" > "$c7_scratch/C7-sib.sh"
out=$(SD="$c7_sd" bash "$c7_scratch/C7-sib.sh" 2>&1); rc=$?
[[ "$rc" -eq 0 && "$out" == *'every retained worker in this Run is one we recorded'* ]] \
  && ok "SK13d 同じ Run の兄弟を SDS に足すと ghost にならない" || fail "SK13d (rc=$rc out=$out)"

: > "$ORCA_STUB_DIR/calls.log"
with_sds "$c7_other" > "$c7_scratch/C7-other.sh"
out=$(SD="$c7_sd" bash "$c7_scratch/C7-other.sh" 2>&1); rc=$?
if [[ "$rc" -ne 0 && "$out" == *'does not belong to Run run_x'* ]] \
   && ! grep -q 'worker-list' "$ORCA_STUB_DIR/calls.log"; then
  ok "SK13e 別 Run の dir を SDS に混ぜたら止まる"
else
  fail "SK13e (rc=$rc out=$out)"
fi
rm -rf "$c7_sib" "$c7_other"
rm -rf "$c7_sd" "$c7_scratch" "$ORCA_STUB_DIR"; unset ORCA_BIN

# SK14: N 並列の契約が両文書に明記されている
bad=""
for f in "$S" "$G"; do
  grep -q -- '--run' "$f" || bad="$bad [--run:$(basename "$f")]"
  grep -q -- '--status-dir' "$f" || bad="$bad [--status-dir:$(basename "$f")]"
done
for pat in released retained already_released release_pending release_unknown; do
  grep -q "$pat" "$S" || bad="$bad [$pat]"
done
[[ -z "$bad" ]] && ok "SK14 N 並列と release state の契約" || fail "SK14:$bad"

# SK15: 上限 4 タスクと質問の割り方が両文書にある
grep -q 'at most four tasks at once' "$S" && grep -q 'one question per task' "$S" \
  && grep -q '一度に 4 タスクまで' "$G" && grep -q 'タスクごとに 1 問' "$G" \
  && ok "SK15 質問の割り方" || fail "SK15"

# SK16: 消えた記述が残っていない
! grep -q 'run-design.sh' "$S" && ! grep -q 'run-design.sh' "$G" \
  && ! grep -q 'dangerously-skip-permissions' "$S" \
  && ok "SK16 消えた経路の記述が残っていない" || fail "SK16"

# SK10: コピーした plugin の本番呼び出しを plugin cwd から実行する。checker を直接呼ぶだけでは、
#       SK10 自身の cwd / ROOT 解決が壊れた回帰を検出できない。
if [[ "${DOC_LANG_REGRESSION:-}" != 1 ]]; then
  regression_root=$(mktemp -d)
  regression_root=$(cd "$regression_root" && pwd -P)
  mkdir -p "$regression_root/apps" "$regression_root/scripts"
  cp -R "$P" "$regression_root/apps/orca-team-dispatch-task"
  cp "$ROOT/scripts/check-doc-lang.mjs" "$regression_root/scripts/check-doc-lang.mjs"
  regression_skill="$regression_root/apps/orca-team-dispatch-task/skills/orca-team-dispatch-task/SKILL.md"
  printf '%s\n' 'これは一時的な SK10 回帰検証です。' >> "$regression_skill"
  regression_out=$(cd "$regression_root/apps/orca-team-dispatch-task" \
    && DOC_LANG_REGRESSION=1 bash test/test-docs.sh 2>&1)
  regression_rc=$?
  rm -rf "$regression_root"
  if [[ "$regression_rc" -ne 0 && "$regression_out" == *"FAIL: SK10 doc-lang"* \
     && "$regression_out" == *"failures: 1"* ]]; then
    ok "SK10 回帰: plugin cwd の本番呼び出しが日本語混入を検出"
  else
    fail "SK10 回帰: plugin cwd の本番呼び出しが日本語混入を検出できない"
  fi
fi

APP_FILTER="${P#"$ROOT"/}"
(cd "$ROOT" && node "$ROOT/scripts/check-doc-lang.mjs" "$APP_FILTER") >/dev/null 2>&1 \
  && ok "SK10 doc-lang" || fail "SK10 doc-lang"
echo "---"; echo "failures: $fails"; exit "$fails"
