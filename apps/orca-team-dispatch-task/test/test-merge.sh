#!/usr/bin/env bash
# 成果の merge。**受理の証拠が揃ったときだけ**取り込む。
set -uo pipefail
P="$(cd "$(dirname "$0")/.." && pwd)"
fails=0; ok() { echo "PASS: $1"; }; fail() { echo "FAIL: $1"; fails=$((fails+1)); }
setup() {
  R=$(mktemp -d); git -C "$R" init -q -b main .; echo seed > "$R/README.md"
  git -C "$R" add -A; git -C "$R" -c user.email=t@e -c user.name=t commit -q -m seed
  # worker の worktree は **repo の外**（中に置くと親が常に dirty になる。実測）
  WT=$(mktemp -d)/wt; git -C "$R" worktree add -q -b orca/s "$WT" >/dev/null 2>&1
  MARK="MARK-$$"; echo "$MARK" >> "$WT/README.md"; git -C "$WT" add -A
  git -C "$WT" -c user.email=t@e -c user.name=t commit -q -m work
  SD="$R/.dispatch/s"; mkdir -p "$SD/roles/design"
  printf '.dispatch/\n' >> "$R/.git/info/exclude"
  printf '{"run_id":"run_x","parent_handle":"term_p","repo_root":"%s"}\n' "$R" > "$SD/run.json"
  jq -nc --arg w "$WT" '{run_id:"run_x",integration_branch:"main",integration_role:"design",
    roles:{design:{terminal:"term_w",task:"task_x",dispatch:"ctx_x",retained:false,
      worktree_id:"wt_1",worktree_path:$w,branch:"orca/s"}}}' > "$SD/workers.json"
  echo '{"status":"done"}' > "$SD/roles/design/status.json"
  printf 'did the thing\n' > "$SD/roles/design/result.md"
  printf '["worker_done|task_x|ctx_x|succeeded"]\n' > "$SD/received.json"
}
teardown() { git -C "$R" worktree remove --force "$WT" >/dev/null 2>&1
             rm -rf "$R" "$(dirname "$WT")"; }
m() { bash "$P/bin/orca-merge.sh" --status-dir "$SD"; }
in_main() { git -C "$R" show main:README.md 2>/dev/null | grep -q "$MARK"; }

setup; bash "$P/bin/orca-merge.sh" --bogus >/dev/null 2>&1
[[ $? -eq 2 ]] && ok "MG1 使用法エラー" || fail "MG1"; teardown

# MG2: 証拠が揃えば merge し、成功を永続化する
setup; m >/dev/null 2>&1
in_main && jq -e '.merged == true and .branch == "orca/s"' "$SD/integration-result.json" >/dev/null 2>&1 \
  && ok "MG2 merge して永続化" || fail "MG2"; teardown

# MG3: **status が done でも、succeeded の worker_done が無ければ merge しない**
#      （status を書いた直後・worker_done 前に止まった worker を取り込まない）
setup; printf '[]\n' > "$SD/received.json"; m >/dev/null 2>&1
[[ $? -eq 1 ]] && ! in_main && ok "MG3 receipt 無しでは merge しない" || fail "MG3"; teardown

# MG4: **failed の receipt では merge しない**
setup; echo '{"status":"error"}' > "$SD/roles/design/status.json"
printf '["worker_done|task_x|ctx_x|failed"]\n' > "$SD/received.json"; m >/dev/null 2>&1
[[ $? -eq 1 ]] && ! in_main && ok "MG4 failed では merge しない" || fail "MG4"; teardown

# MG5: **result.md が無い / 空なら merge しない**
setup; rm -f "$SD/roles/design/result.md"; m >/dev/null 2>&1
[[ $? -eq 1 ]] && ! in_main && ok "MG5a result 欠落で merge しない" || fail "MG5a result 欠落で merge した"; teardown
setup; : > "$SD/roles/design/result.md"; m >/dev/null 2>&1
[[ $? -eq 1 ]] && ! in_main && ok "MG5b result.md を要求する" || fail "MG5b 空 result で merge した"; teardown

# MG6: **待機中に親の checkout が変わったら merge しない**（別ブランチへ成果を入れない）
setup; git -C "$R" checkout -q -b other; m >/dev/null 2>&1
[[ $? -eq 1 ]] && ok "MG6 別ブランチへ入れない" || fail "MG6 別ブランチへ merge した"; teardown

# MG7: branch を記録していなければ推測しない
setup; jq -c 'del(.roles.design.branch)' "$SD/workers.json" > "$SD/w"; mv "$SD/w" "$SD/workers.json"
m >/dev/null 2>&1
[[ $? -eq 1 ]] && ! in_main && ok "MG7 branch を推測しない" || fail "MG7"; teardown

# MG8: 親 checkout が dirty なら触らない
setup; echo local >> "$R/README.md"; m >/dev/null 2>&1
[[ $? -eq 1 ]] && ! in_main && ok "MG8 dirty な親を触らない" || fail "MG8"; teardown

# MG9: **conflict しても worktree もブランチも残す**（成果を失わない）
setup; echo c >> "$R/README.md"; git -C "$R" add -A
git -C "$R" -c user.email=t@e -c user.name=t commit -q -m c; m >/dev/null 2>&1
[[ $? -eq 1 ]] && [[ -d "$WT" ]] && git -C "$R" show-ref --quiet refs/heads/orca/s \
  && jq -e '.merged == false' "$SD/integration-result.json" >/dev/null 2>&1 \
  && ok "MG9 conflict で残す" || fail "MG9 conflict の扱い"; teardown

# MG10: **merge しても資源を消さない**（Stage 1 は片付けを自動化しない）。再実行も安全
setup; m >/dev/null 2>&1; m >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 0 ]] && in_main && [[ -d "$WT" ]] \
  && git -C "$R" show-ref --quiet refs/heads/orca/s \
  && ok "MG10 資源を消さず冪等" || fail "MG10 (rc=$rc)"; teardown

# MG11: receipt ledger に format 外の値があれば、succeeded の文字列があっても受理しない
setup; printf '[true,"worker_done|task_x|ctx_x|succeeded"]\n' > "$SD/received.json"; m >/dev/null 2>&1
[[ $? -eq 1 ]] && ! in_main && ok "MG11 receipt format を検証する" || fail "MG11"; teardown

# MG12: ★ **取り込む役を推測しない。**`// "design"` の既定を置くと、記録を書き損ねた
#       dispatch が黙って design のブランチを取り込む。取り込み先の取り違えは成果の
#       喪失につながるので、他の identity と同じく「無ければ止まる」。
setup; jq -c 'del(.integration_role)' "$SD/workers.json" > "$SD/w"; mv "$SD/w" "$SD/workers.json"
bash "$P/bin/orca-merge.sh" --status-dir "$SD" >/dev/null 2>&1
[[ $? -eq 1 ]] && ! in_main && ok "MG12 integration_role が無ければ止まる" || fail "MG12"; teardown

# MG13: integration_role が指す役のブランチと成果を見る（design 決め打ちではない）。
setup
git -C "$R" branch -q other-branch "orca/s"
jq -c '.integration_role = "other" | .roles.other = (.roles.design | .branch = "other-branch")' \
  "$SD/workers.json" > "$SD/w" && mv "$SD/w" "$SD/workers.json"
mkdir -p "$SD/roles/other"
echo '{"status":"done"}' > "$SD/roles/other/status.json"
printf 'other role result\n' > "$SD/roles/other/result.md"
bash "$P/bin/orca-merge.sh" --status-dir "$SD" >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 0 && "$(jq -r '.branch' "$SD/integration-result.json")" == other-branch ]] \
  && ok "MG13 integration_role の指す役を取り込む" || fail "MG13 (rc=$rc)"; teardown


# ── 無レビューの成果 ──────────────────────────────────────────────────────
# ★ **レビューを求めておいて verdict が 1 つも無い成果を黙って取り込まない。**
#   実測 2026-09-12: reviewer の verdict が未配送のまま捨てられ（3 Run 中 2 Run）、
#   無レビューの成果が succeeded のまま取り込み待ちになった。worker は差し戻さない
#   （spec 公認の離脱経路を塞ぐことになる）。人の承認を経るここで閉じる。
reviewed_setup() {
  setup
  upd=$(jq -c '.roles.design_review = {"terminal":"term_r","task":"task_x","dispatch":"ctx_r"}' \
          "$SD/workers.json"); printf '%s\n' "$upd" > "$SD/workers.json"
  mkdir -p "$SD/review"
}
# reviewer が verdict を **届けられた** 記録。findings がディスクに在ることとは別の事実である
delivered() { jq -nc '[{to:"design",subject:"review-verdict: round 1",message_id:"m1",at:1}]' \
                > "$SD/sent.json"; }

# MG14: reviewer が起きていて verdict が無ければ merge しない。理由と逃げ道を言う。
reviewed_setup; out=$(m 2>&1); rc=$?
[[ "$rc" -eq 1 ]] && ! in_main && [[ "$out" == *"no delivered verdict exists"* && "$out" == *"--allow-unreviewed"* ]] \
  && ok "MG14 無レビューは取り込まない" || fail "MG14 (rc=$rc out=$out)"; teardown

# MG15: verdict が在って届いていれば通常どおり取り込む。**正常な往復を止めない。**
reviewed_setup; printf 'looks fine\nVERDICT: approved\n' > "$SD/review/plan-round-1-findings.md"
delivered
m >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 0 ]] && in_main && ok "MG15 verdict が在れば取り込む" || fail "MG15 (rc=$rc)"; teardown

# MG16: **findings が在っても VERDICT 行が無ければ verdict ではない。**
reviewed_setup; printf 'I started reading and stopped\n' > "$SD/review/plan-round-1-findings.md"
m >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 1 ]] && ! in_main && ok "MG16 VERDICT 行の無い findings は verdict ではない" \
  || fail "MG16 (rc=$rc)"; teardown

# MG17: --allow-unreviewed を明示すれば取り込む。**既定では通らないことが要点である。**
reviewed_setup
bash "$P/bin/orca-merge.sh" --status-dir "$SD" --allow-unreviewed >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 0 ]] && in_main && ok "MG17 明示の override は通る" || fail "MG17 (rc=$rc)"; teardown

# MG18: reviewer が起きていなければ何も足さない（review_mode=off の既定を汚さない）。
setup; mkdir -p "$SD/review"; m >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 0 ]] && in_main && ok "MG18 reviewer 不在なら従来どおり" || fail "MG18 (rc=$rc)"; teardown

# MG19: ★ **findings が在っても、届いていなければレビューではない。**実測 2026-09-12:
#       依頼側が先に決着したため reviewer の verdict が受け取られず、findings だけが
#       ディスクに残った。ここを findings の有無で見ていると、届かなかったレビューを
#       「済み」と数えて無レビューの成果を取り込む。
reviewed_setup; printf 'needs work\nVERDICT: needs_work\n' > "$SD/review/plan-round-1-findings.md"
out=$(m 2>&1); rc=$?
[[ "$rc" -eq 1 ]] && ! in_main && [[ "$out" == *"no delivered verdict exists"* ]] \
  && ok "MG19 未配送の findings はレビューと数えない" || fail "MG19 (rc=$rc out=$out)"; teardown

# MG20: 配送記録が他の役宛なら、この役のレビューではない。
reviewed_setup; printf 'ok\nVERDICT: approved\n' > "$SD/review/plan-round-1-findings.md"
jq -nc '[{to:"exec",subject:"review-verdict: round 1",message_id:"m1",at:1}]' > "$SD/sent.json"
m >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 1 ]] && ! in_main && ok "MG20 別の役への配送は数えない" || fail "MG20 (rc=$rc)"; teardown

echo "---"; echo "failures: $fails"; exit "$fails"
