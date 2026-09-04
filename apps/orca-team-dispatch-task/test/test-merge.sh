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
  jq -nc --arg w "$WT" '{run_id:"run_x",worktree_id:"wt_1",worktree_path:$w,branch:"orca/s",
    integration_branch:"main",design:{terminal:"term_w",task:"task_x",dispatch:"ctx_x"}}' > "$SD/workers.json"
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
setup; jq -c 'del(.branch)' "$SD/workers.json" > "$SD/w"; mv "$SD/w" "$SD/workers.json"
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

echo "---"; echo "failures: $fails"; exit "$fails"
