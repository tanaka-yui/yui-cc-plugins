#!/usr/bin/env bash
# issue モードの実行の前後（lock・単件の claim・整合・解放）。SKILL.md の I0 / I1a / I2 / I4 の block から移した
# 判定が block のときと同じに働くこと — lock が生きていれば始めない、載っている issue は claim し直さない、
# 親を dirty にしない — を確かめる。lock と claim そのものの失敗様式は test-issue-fetch.sh が持つ。
set -uo pipefail
P="$(cd "$(dirname "$0")/.." && pwd)"
LOOP="$P/bin/orca-issue-loop.ts"
fails=0; ok() { echo "PASS: $1"; }; fail() { echo "FAIL: $1"; fails=$((fails+1)); }

setup() {
  W=$(mktemp -d); R="$W/repo"; mkdir -p "$R"; git -C "$R" init -q -b main .
  echo seed > "$R/README.md"; git -C "$R" add -A
  git -C "$R" -c user.email=t@e -c user.name=t commit -q -m seed
  SF="$R/.dispatch-issue/state.json"
  GH_STUB_DIR="$W/gh"; mkdir -p "$GH_STUB_DIR"; : > "$GH_STUB_DIR/calls.log"; echo '[]' > "$GH_STUB_DIR/label_list"
  BIN="$W/bin"; mkdir -p "$BIN"
  { echo '#!/usr/bin/env bash'; printf 'exec %q "$@"\n' "$P/test/lib/gh-stub.sh"; } > "$BIN/gh"; chmod +x "$BIN/gh"
  ORCA_STUB_DIR="$W/orca"; mkdir -p "$ORCA_STUB_DIR"; : > "$ORCA_STUB_DIR/calls.log"
  echo '{"ok":true,"result":{"runtime":{"reachable":true}}}' > "$ORCA_STUB_DIR/status"
  export GH_STUB_DIR ORCA_STUB_DIR ORCA_BIN="$P/test/lib/orca-stub.sh" LOOP_SESSION_ID=sess-loop
  OLD_PATH="$PATH"; PATH="$BIN:$PATH"; export PATH
}
teardown() {
  PATH="$OLD_PATH"; export PATH
  rm -rf "$W"; unset GH_STUB_DIR ORCA_STUB_DIR ORCA_BIN LOOP_SESSION_ID
}
loop() { node "$LOOP" "$1" --repo-root "$R" "${@:2}"; }
issue_view() { jq -nc --arg t "$1" '{number:12,title:$t,body:"the body",url:"u12",labels:[]}' > "$GH_STUB_DIR/issue_view"; }

# IL1: 使用法の誤りは 2（できなかった 1 と区別する）。git の外で --repo-root を省いても 2
setup; bad=""
node "$LOOP" >/dev/null 2>&1; [[ $? -eq 2 ]] || bad="$bad [none]"
node "$LOOP" bogus --repo-root "$R" >/dev/null 2>&1; [[ $? -eq 2 ]] || bad="$bad [unknown]"
node "$LOOP" claim --repo-root "$R" >/dev/null 2>&1; [[ $? -eq 2 ]] || bad="$bad [claim-no-issue]"
node "$LOOP" claim --issue abc --repo-root "$R" >/dev/null 2>&1; [[ $? -eq 2 ]] || bad="$bad [claim-nan]"
node "$LOOP" start --issue 3 --repo-root "$R" >/dev/null 2>&1; [[ $? -eq 2 ]] || bad="$bad [issue-on-start]"
node "$LOOP" start --bogus >/dev/null 2>&1; [[ $? -eq 2 ]] || bad="$bad [flag]"
out=$(cd "$W" && node "$LOOP" start 2>&1); rc=$?
[[ "$rc" -eq 2 && "$out" == *'not in a git repo'* ]] || bad="$bad [no-git:$rc]"
[[ -z "$bad" ]] && ok "IL1 使用法の誤りは 2" || fail "IL1:$bad"; teardown

# IL2: start は lock を取り、state_file を印字し、.dispatch-issue/ を除外して親を dirty にしない
setup
out=$(loop start 2>/dev/null); rc=$?
EXF=$(git -C "$R" rev-parse --git-path info/exclude); case "$EXF" in /*) ;; ?*) EXF="$R/$EXF" ;; esac
[[ "$rc" -eq 0 && "$out" == "state_file=$SF" \
   && "$(jq -r .session_id "$R/.dispatch-issue/loop.lock.d/owner.json")" == sess-loop ]] \
  && grep -qxF '.dispatch-issue/' "$EXF" && [[ -z "$(git -C "$R" status --porcelain)" ]] \
  && ok "IL2 start は lock を取り、state を除外する" || fail "IL2 (rc=$rc out=$out)"; teardown

# IL3: ★ **lock が生きていれば始めない。**2 つのループが同じ issue を claim すると同じ worktree 名で衝突する
setup; loop start >/dev/null 2>&1
out=$(LOOP_SESSION_ID=sess-other node "$LOOP" start --repo-root "$R" 2>&1); rc=$?
[[ "$rc" -eq 1 && "$out" == *'an issue loop is already running'* \
   && "$(jq -r .session_id "$R/.dispatch-issue/loop.lock.d/owner.json")" == sess-loop ]] \
  && ok "IL3 生きている lock があれば始めない" || fail "IL3 (rc=$rc out=$out)"; teardown

# IL4: gh が無ければ何も取らない（node は実体へ張る。mise などの shim は PATH が無いと動かない）
setup
NOGH="$W/nogh"; mkdir -p "$NOGH"; ln -s "$(node -p process.execPath)" "$NOGH/node"
out=$(PATH="$NOGH" "$NOGH/node" "$LOOP" start --repo-root "$R" 2>&1); rc=$?
[[ "$rc" -eq 1 && "$out" == *'gh is not installed'* && ! -e "$R/.dispatch-issue/loop.lock.d" ]] \
  && ok "IL4 gh が無ければ何も取らない" || fail "IL4 (rc=$rc out=$out)"; teardown

# IL5: ★ **Orca に届かなければ lock を取らない。**届かないまま claim すると、各 issue の dispatch が
#      起動できずに失敗し、ラベルが dispatch/failed へ動く（SKILL.md の I0 は「確かめる」と書いていた）
setup; echo '{"ok":true,"result":{"runtime":{"reachable":false}}}' > "$ORCA_STUB_DIR/status"
out=$(loop start 2>&1); rc=$?
[[ "$rc" -eq 1 && "$out" == *'the Orca runtime is not reachable'* && ! -e "$R/.dispatch-issue/loop.lock.d" ]] \
  && ok "IL5 Orca に届かなければ始めない" || fail "IL5 (rc=$rc out=$out)"; teardown

# IL6: claim は名指しの issue を claim し、title と body を依頼ファイルへ書いて slug と一緒に印字する
setup; loop start >/dev/null 2>&1; issue_view 'Fix it now'
out=$(loop claim --issue 12 2>/dev/null); rc=$?
slug=$(sed -n 's/^slug=//p' <<<"$out"); req=$(sed -n 's/^request_file=//p' <<<"$out")
[[ "$rc" -eq 0 && "$slug" == issue-12-fix-it-now && -f "$req" && "$(cat "$req")" == $'Fix it now\n\nthe body' \
   && "$(jq -r '.issues["12"].status' "$SF")" == claimed \
   && "$(jq -c '[.config, .filter]' "$SF")" == '[{"concurrency":1},{"issue":"named"}]' ]] \
  && grep -q -- 'issue edit 12 --add-label dispatch/in-progress' "$GH_STUB_DIR/calls.log" \
  && ok "IL6 claim は依頼ファイルと slug を返す" || fail "IL6 (rc=$rc out=$out)"
[[ -n "$req" ]] && rm -rf "$(dirname "$req")"; teardown

# IL7: ★ **state に載っている issue は claim し直さない。**exit 1 で理由を言い、依頼ファイルを作らない
setup; loop start >/dev/null 2>&1; issue_view t
first=$(loop claim --issue 12 2>/dev/null | sed -n 's/^request_file=//p')
out=$(loop claim --issue 12 2>&1); rc=$?
[[ "$rc" -eq 1 && "$out" == *"issue #12 was not claimed; it is already recorded in $SF"* && "$out" != *request_file=* ]] \
  && ok "IL7 載っている issue は claim し直さない" || fail "IL7 (rc=$rc out=$out)"
[[ -n "$first" ]] && rm -rf "$(dirname "$first")"; teardown

# IL8: lock を取っていなければ claim しない（init が所有者を確かめる）。ラベルにも触らない
setup; issue_view t
out=$(loop claim --issue 12 2>&1); rc=$?
[[ "$rc" -eq 1 ]] && ! grep -q 'issue edit' "$GH_STUB_DIR/calls.log" \
  && ok "IL8 lock の無い claim は何もしない" || fail "IL8 (rc=$rc out=$out)"; teardown

# IL9: reconcile は init と ensure-labels のあとで整合させ、abort を JSON で返す（exit は 0。止めるのは親）
setup; loop start >/dev/null 2>&1; loop reconcile >/dev/null 2>&1
jq '.issues["3"] = {slug:"issue-3-x",status:"dispatched"}' "$SF" > "$SF.t" && mv "$SF.t" "$SF"
out=$(loop reconcile 2>/dev/null); rc=$?
[[ "$rc" -eq 0 && "$(jq -r .action <<<"$out")" == abort \
   && "$(jq -c '[.config, .filter]' "$SF")" == '[{"concurrency":5},{"state":"open"}]' ]] \
  && grep -q 'label list' "$GH_STUB_DIR/calls.log" \
  && ok "IL9 reconcile は abort を JSON で返す" || fail "IL9 (rc=$rc out=$out)"; teardown

# IL10: release は自分の lock だけを外す。STATE を block から運ばなくても解放できる（I4）
setup; loop start >/dev/null 2>&1
LOOP_SESSION_ID=sess-other node "$LOOP" release --repo-root "$R" >/dev/null 2>&1; other=$?
loop release >/dev/null 2>&1; mine=$?
[[ "$other" -eq 1 && "$mine" -eq 0 && ! -e "$R/.dispatch-issue/loop.lock.d" ]] \
  && ok "IL10 release は自分の lock だけを外す" || fail "IL10 ($other/$mine)"; teardown

# IL11: --state-file を渡せばそこを使う（repo の外なら除外は書かない）
setup; alt="$W/elsewhere/state.json"
out=$(node "$LOOP" start --repo-root "$R" --state-file "$alt" 2>/dev/null); rc=$?
[[ "$rc" -eq 0 && "$out" == "state_file=$alt" && -d "$W/elsewhere/loop.lock.d" && ! -e "$R/.dispatch-issue" ]] \
  && ok "IL11 --state-file を尊重する" || fail "IL11 (rc=$rc out=$out)"; teardown

# IL12: zsh から呼んでも同じ結果になる（設計 3-5。SKILL.md の I0〜I4 は呼び出し側のシェルで走る）
if command -v zsh >/dev/null 2>&1; then
  setup
  b=$(bash -c 'node "$1" start --repo-root "$2"' bash "$LOOP" "$R" 2>/dev/null); brc=$?
  node "$LOOP" release --repo-root "$R" >/dev/null 2>&1
  z=$(zsh -c 'node "$1" start --repo-root "$2"' zsh "$LOOP" "$R" 2>/dev/null); zrc=$?
  [[ "$brc" -eq 0 && "$zrc" -eq 0 && "$b" == "state_file=$SF" && "$z" == "$b" ]] \
    && ok "IL12 zsh から呼んでも同じ結果" || fail "IL12 ($brc/$zrc $b/$z)"; teardown
else
  echo "SKIP: IL12 zsh が無い"
fi
echo "---"; echo "failures: $fails"; exit "$fails"
