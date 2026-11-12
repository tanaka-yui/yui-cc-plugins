#!/usr/bin/env bash
# PR 統合。**repo を推測しないこと**と、**中身の無い PR を作らないこと**が全部である。
set -uo pipefail
P="$(cd "$(dirname "$0")/.." && pwd)"
fails=0; ok() { echo "PASS: $1"; }; fail() { echo "FAIL: $1"; fails=$((fails+1)); }

setup() {
  W=$(mktemp -d); GH_STUB_DIR="$W/gh"; mkdir -p "$GH_STUB_DIR"; : > "$GH_STUB_DIR/calls.log"
  BIN="$W/bin"; mkdir -p "$BIN"
  { echo '#!/usr/bin/env bash'; printf 'exec %q "$@"\n' "$P/test/lib/gh-stub.sh"; } > "$BIN/gh"
  chmod +x "$BIN/gh"; export GH_STUB_DIR; OLD_PATH="$PATH"; PATH="$BIN:$PATH"; export PATH
  printf 'https://github.com/o/r/pull/1\n' > "$GH_STUB_DIR/pr_create"

  # bare な remote を用意して push が本当に通るようにする
  REMOTE_DIR="$W/remote.git"; git init -q --bare -b main "$REMOTE_DIR"
  R="$W/repo"; git init -q -b main "$R"
  printf 'seed\n' > "$R/README.md"; git -C "$R" add -A
  git -C "$R" -c user.email=t@e -c user.name=t commit -q -m seed
  git -C "$R" remote add origin "$REMOTE_DIR"
  git -C "$R" push -q origin main
  git -C "$R" branch -q work
  git -C "$R" -c user.email=t@e -c user.name=t \
    commit -q --allow-empty -m "work commit" 2>/dev/null || true
  # work ブランチに 1 コミット載せる
  WTW="$W/wt"; git -C "$R" worktree add -q "$WTW" work >/dev/null 2>&1
  printf 'done\n' > "$WTW/WORK.md"; git -C "$WTW" add -A
  git -C "$WTW" -c user.email=t@e -c user.name=t commit -q -m "the work"

  SD="$R/.dispatch/s"; mkdir -p "$SD/roles/design"
  printf '{"run_id":"run_x","parent_handle":"term_p","repo_root":"%s"}\n' "$R" > "$SD/run.json"
  jq -nc '{run_id:"run_x",integration_branch:"main",integration_role:"design",
    roles:{design:{task:"task_x",dispatch:"ctx_x",branch:"work"}}}' > "$SD/workers.json"
  printf 'Fix the thing\n\nmore detail\n' > "$SD/request.md"
  echo '{"status":"done"}' > "$SD/roles/design/status.json"
  printf 'changed WORK.md\n' > "$SD/roles/design/result.md"
}
teardown() { PATH="$OLD_PATH"; export PATH; rm -rf "$W"; unset GH_STUB_DIR; }
pr() { node "$P/bin/orca-pr.ts" --status-dir "$SD" "$@"; }
ghlog() { cat "$GH_STUB_DIR/calls.log"; }

# PR1: ★ **`--repo` は必須。**省略を許すと「たまたま origin が正しい環境」でだけ通り、
#      fork を持つ環境で静かに壊れる（spec 12-2 の実測: fork の中に PR を作り、issue が
#      そこに無いので Closes が効かなかった）。
setup
pr >/dev/null 2>&1
[[ $? -eq 2 ]] && [[ ! -s "$GH_STUB_DIR/calls.log" ]] \
  && ok "PR1 --repo が無ければ何もしない" || fail "PR1"
teardown

# PR2: gh pr create に **必ず --repo が渡る**。base と head も記録から引く。
setup
pr --repo o/r >/dev/null 2>&1; rc=$?
l=$(ghlog)
[[ "$rc" -eq 0 ]] \
  && grep -q -- '--repo o/r' <<<"$l" \
  && grep -q -- '--base main' <<<"$l" \
  && grep -q -- '--head work' <<<"$l" \
  && ok "PR2 --repo / --base / --head を明示して作る" || fail "PR2 (rc=$rc) $l"
teardown

# PR3: ★ **push に失敗したら PR を作らない。**中身の無い PR は誤解を生むだけである。
setup
git -C "$R" remote set-url origin "$W/does-not-exist.git"
pr --repo o/r >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 1 ]] && ! grep -q 'pr create' <(ghlog) \
  && [[ "$(jq -r '.merged' "$SD/integration-result.json")" == false ]] \
  && ok "PR3 push できなければ PR を作らない" || fail "PR3 (rc=$rc)"
teardown

# PR4: pr_url を記録し、**merged は false のまま**（PR は取り込みではない）。
setup
out=$(pr --repo o/r 2>/dev/null)
[[ "$out" == 'https://github.com/o/r/pull/1' ]] \
  && [[ "$(jq -r '.pr_url' "$SD/integration-result.json")" == "$out" ]] \
  && [[ "$(jq -r '.merged' "$SD/integration-result.json")" == false ]] \
  && [[ "$(jq -r '.integration' "$SD/integration-result.json")" == pr ]] \
  && ok "PR4 pr_url を記録し merged は false" || fail "PR4 ($out)"
teardown

# PR5: ★ **同じ成果に 2 つの PR を作らない。**再実行は記録済みの URL を返す。
setup
pr --repo o/r >/dev/null 2>&1
: > "$GH_STUB_DIR/calls.log"
out=$(pr --repo o/r 2>/dev/null); rc=$?
[[ "$rc" -eq 0 && "$out" == 'https://github.com/o/r/pull/1' ]] \
  && ! grep -q 'pr create' <(ghlog) \
  && ok "PR5 再実行は作り直さず既存 URL を返す" || fail "PR5 (rc=$rc out=$out)"
teardown

# PR6: ★ --issue があれば本文に `Closes #N` を入れる。**`--repo` を必須にしたのはこれを
#      効かせるためである** — issue が別 repository にあると効かない。
#      本文は一時ファイルで渡され消えるので、stub 側で写しを取って中身を検査する。
setup
cat > "$GH_STUB_DIR/pr_create.hook" <<'HOOK'
#!/usr/bin/env bash
prev=""
for a in "$@"; do [[ "$prev" == --body-file ]] && cp "$a" "$GH_STUB_DIR/body.txt"; prev="$a"; done
HOOK
chmod +x "$GH_STUB_DIR/pr_create.hook"
pr --repo o/r --issue 42 >/dev/null 2>&1
body=$(cat "$GH_STUB_DIR/body.txt" 2>/dev/null)
[[ "$body" == *'changed WORK.md'* ]] && [[ "$(tail -1 <<<"$body")" == 'Closes #42' ]] \
  && ok "PR6 本文に result と Closes #N が入る" || fail "PR6 ($body)"
teardown

# PR6b: --issue が無ければ Closes 行を入れない（無関係な issue を閉じない）。
setup
cat > "$GH_STUB_DIR/pr_create.hook" <<'HOOK'
#!/usr/bin/env bash
prev=""
for a in "$@"; do [[ "$prev" == --body-file ]] && cp "$a" "$GH_STUB_DIR/body.txt"; prev="$a"; done
HOOK
chmod +x "$GH_STUB_DIR/pr_create.hook"
pr --repo o/r >/dev/null 2>&1
# ★ **ファイルが無いことを「Closes が無い」と読まない。**写しが取れていなければ検査は
#   成立していない（実際に一度、hook 未実装のまま偽の PASS になった）。
[[ -s "$GH_STUB_DIR/body.txt" ]] && ! grep -q '^Closes #' "$GH_STUB_DIR/body.txt" \
  && ok "PR6b --issue 無しなら Closes を書かない" || fail "PR6b"
teardown

# PR7: ★ **成果が無いブランチで PR を作らない。**status が done でなければ止まる。
setup
echo '{"status":"executing"}' > "$SD/roles/design/status.json"
pr --repo o/r >/dev/null 2>&1
[[ $? -eq 1 ]] && ! grep -q 'pr create' <(ghlog) \
  && ok "PR7 done でなければ PR を作らない" || fail "PR7"
teardown

# PR8: ★ **base に無いコミットが 1 つも無ければ PR を作らない。**空の PR を作って
#      「届いた」と言わない。
setup
git -C "$R" branch -q nothing-new main
jq -c '.roles.design.branch = "nothing-new"' "$SD/workers.json" > "$SD/w" && mv "$SD/w" "$SD/workers.json"
pr --repo o/r >/dev/null 2>&1
[[ $? -eq 1 ]] && ! grep -q 'pr create' <(ghlog) \
  && ok "PR8 差分が無ければ PR を作らない" || fail "PR8"
teardown

# PR9: integration_role を推測しない（merge と同じ厳しさ。取り違えると別の成果を出す）。
setup
jq -c 'del(.integration_role)' "$SD/workers.json" > "$SD/w" && mv "$SD/w" "$SD/workers.json"
pr --repo o/r >/dev/null 2>&1
[[ $? -eq 1 ]] && ! grep -q 'pr create' <(ghlog) \
  && ok "PR9 integration_role を推測しない" || fail "PR9"
teardown

# PR10: 不正な --repo は使用法エラー（2）。
setup
pr --repo notaslug >/dev/null 2>&1
[[ $? -eq 2 ]] && ok "PR10 owner/repo でなければ 2" || fail "PR10"
teardown

# PR11: ★ **base が remote に無ければ、そう言って止まる。**無いまま gh を呼ぶと
#       `Base ref must be a branch` という GraphQL のエラーになり、**何が悪いのか
#       読めない**（実機で発見: ローカルだけの一時ブランチから dispatch していた）。
setup
jq -c '.integration_branch = "never-pushed"' "$SD/workers.json" > "$SD/w" && mv "$SD/w" "$SD/workers.json"
git -C "$R" branch -q never-pushed main
out=$(pr --repo o/r 2>&1); rc=$?
[[ "$rc" -eq 1 && "$out" == *'does not exist on origin'* ]] \
  && ! grep -q 'pr create' <(ghlog) \
  && ok "PR11 base が remote に無ければ理由を言って止まる" || fail "PR11 (rc=$rc) $out"
teardown

# PR12: ★ **`gh` が stderr に警告を出しても、成功は成功である。**`2>&1` で受けると
#       URL の前に警告が付き、**PR は作られたのに失敗として記録され、URL も残らない**。
#       そのとき再実行は **2 つ目の PR を作る**（実機で発見:
#       `Warning: 4 uncommitted changes`）。
setup
cat > "$GH_STUB_DIR/pr_create.hook" <<'HOOK'
#!/usr/bin/env bash
echo "Warning: 4 uncommitted changes" >&2
HOOK
chmod +x "$GH_STUB_DIR/pr_create.hook"
out=$(pr --repo o/r 2>/dev/null); rc=$?
[[ "$rc" -eq 0 && "$out" == 'https://github.com/o/r/pull/1' ]] \
  && [[ "$(jq -r '.pr_url' "$SD/integration-result.json")" == 'https://github.com/o/r/pull/1' ]] \
  && ok "PR12 stderr の警告を失敗と読まない" || fail "PR12 (rc=$rc out=$out)"
teardown

# PR13: ★ **記録が無くても、既に PR が在るなら成功として拾う。**自分の記録は失われうる
#       （実測: 最初の試行が stderr の警告で失敗扱いになり、PR は在るのに URL を記録
#       できなかった）。そこで諦めると、その dispatch は永久に失敗のままになる。
setup
printf '1\n' > "$GH_STUB_DIR/pr_create.rc"
printf '[{"url":"https://github.com/o/r/pull/9"}]\n' > "$GH_STUB_DIR/pr_list"
out=$(pr --repo o/r 2>/dev/null); rc=$?
[[ "$rc" -eq 0 && "$out" == 'https://github.com/o/r/pull/9' ]] \
  && [[ "$(jq -r '.pr_url' "$SD/integration-result.json")" == 'https://github.com/o/r/pull/9' ]] \
  && ok "PR13 既存 PR を GitHub に訊いて拾う" || fail "PR13 (rc=$rc out=$out)"
teardown

# PR14: 既存も無ければ、やはり失敗である（作れていないのに成功と言わない）。
setup
printf '1\n' > "$GH_STUB_DIR/pr_create.rc"
printf '[]\n' > "$GH_STUB_DIR/pr_list"
pr --repo o/r >/dev/null 2>&1
[[ $? -eq 1 ]] && [[ "$(jq -r '.pr_url // "none"' "$SD/integration-result.json")" == none ]] \
  && ok "PR14 既存も無ければ失敗のまま" || fail "PR14"
teardown

# PR15: ★ **merge と記録された dispatch で PR を作らない。**
setup; jq -c '.integration = "merge"' "$SD/workers.json" > "$SD/w" && mv "$SD/w" "$SD/workers.json"
out=$(pr --repo o/r 2>&1); rc=$?
[[ "$rc" -eq 1 && "$out" == *'orca-merge.ts'* ]] && ! ghlog | grep -q 'pr create' \
  && ok "PR15 merge の dispatch で PR を作らない" || fail "PR15 (rc=$rc out=$out)"; teardown

# PR16: pr と記録されていれば今までどおり作る
setup; jq -c '.integration = "pr"' "$SD/workers.json" > "$SD/w" && mv "$SD/w" "$SD/workers.json"
pr --repo o/r >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 0 ]] && ghlog | grep -q 'pr create' \
  && ok "PR16 pr の dispatch は PR を作る" || fail "PR16 (rc=$rc)"; teardown

# PR17-PR21: ★ **PR がマージされたら、再実行で取り込みを記録する。**記録しないと片付けが worktree も record も
#   offer しない（3.10.17、slack-issue-intake。案内の orca-merge.ts は pr を拒んだ）。証拠は GitHub の MERGED と、
#   PR の head がローカルのブランチの先端を含むこと。**確かめられなければ記録に触らない**（pr_url を消さない）
opened() { setup; pr --repo o/r >/dev/null 2>&1; : > "$GH_STUB_DIR/calls.log"; }
view() { printf '{"state":"%s","headRefOid":"%s"}\n' "$1" "$2" > "$GH_STUB_DIR/pr_view"; }
tip() { git -C "$R" rev-parse refs/heads/work; }

# PR17: MERGED で head がブランチの先端なら merged:true を記録し、URL も PR の記録も保つ
opened; view MERGED "$(tip)"
out=$(pr --repo o/r 2>/dev/null); rc=$?
res=$(cat "$SD/integration-result.json")
[[ "$rc" -eq 0 && "$out" == 'https://github.com/o/r/pull/1' ]] \
  && [[ "$(jq -r '[.merged, .integration, .pr_url, .branch, .base, .repo] | join(" ")' <<<"$res")" \
        == 'true pr https://github.com/o/r/pull/1 work main o/r' ]] \
  && grep -qF -- 'pr view --repo o/r --json state\,headRefOid https' <(ghlog) && ! grep -q 'pr create' <(ghlog) \
  && ok "PR17 マージ済みの PR を merged と記録する" || fail "PR17 (rc=$rc out=$out res=$res) $(ghlog)"
teardown

# PR18: OPEN / CLOSED なら merged:false のまま、URL を返して成功（PR はある）
bad=""
for st in OPEN CLOSED; do
  opened; view "$st" "$(tip)"
  out=$(pr --repo o/r 2>&1 >/dev/null); rc=$?
  [[ "$rc" -eq 0 && "$(jq -r '.merged' "$SD/integration-result.json")" == false \
     && "$(jq -r '.pr_url' "$SD/integration-result.json")" == 'https://github.com/o/r/pull/1' \
     && "$out" == *"is $st, not merged"* ]] || bad="$bad [$st rc=$rc]"
  teardown
done
[[ -z "$bad" ]] && ok "PR18 マージされていない PR は記録を変えない" || fail "PR18:$bad"

# PR19: gh が状態を返さなければ記録に触らない（stop で pr_url を消さない）
opened; printf '1\n' > "$GH_STUB_DIR/pr_view.rc"; before=$(cat "$SD/integration-result.json")
out=$(pr --repo o/r 2>&1 >/dev/null); rc=$?
[[ "$rc" -eq 0 && "$(cat "$SD/integration-result.json")" == "$before" && "$out" == *'could not read the state'* ]] \
  && ok "PR19 状態を読めなければ記録に触らない" || fail "PR19 (rc=$rc out=$out)"
teardown

# PR20: ★ PR に載らなかったコミットがブランチにあれば記録しない（squash でも効くよう、祖先ではなく PR の head と比べる）
opened; head=$(tip)
git -C "$WTW" -c user.email=t@e -c user.name=t commit -q --allow-empty -m "after the PR"
view MERGED "$head"
out=$(pr --repo o/r 2>&1 >/dev/null); rc=$?
[[ "$rc" -eq 0 && "$(jq -r '.merged' "$SD/integration-result.json")" == false \
   && "$out" == *'has commits the pull request did not carry'* ]] \
  && ok "PR20 PR に載らないコミットがあれば merged と記録しない" || fail "PR20 (rc=$rc out=$out)"
teardown

# PR21: 記録した repo と違う --repo では記録しない（PR の在る repo にしか訊かない）
opened; view MERGED "$(tip)"
out=$(pr --repo o/other 2>&1 >/dev/null); rc=$?
[[ "$rc" -eq 0 && "$(jq -r '.merged' "$SD/integration-result.json")" == false \
   && "$out" == *'was opened on o/r, not o/other'* ]] && ! grep -q 'pr view' <(ghlog) \
  && ok "PR21 別の repo を渡されたら記録しない" || fail "PR21 (rc=$rc out=$out)"
teardown

echo "failures: $fails"; [[ "$fails" -eq 0 ]]
