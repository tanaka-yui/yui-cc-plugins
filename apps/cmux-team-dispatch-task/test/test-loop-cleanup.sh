#!/usr/bin/env bash
# loop-cleanup.sh の完了検証・WIP 保全・破壊的処理停止を検査する。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLEANUP="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/loop-cleanup.sh"
FETCH="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/issue-fetch.sh"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
REPO="$TMP/repo"; LOOP="$REPO/.dispatch-loop"; DISP="$REPO/.dispatch"; STATE="$LOOP/loop-state.json"
mkdir -p "$TMP/bin" "$REPO" "$LOOP" "$DISP"; export PATH="$TMP/bin:$PATH" LOOP_SESSION_ID=cleanup-test
git -C "$REPO" init -q -b main; git -C "$REPO" config user.email t@example.invalid; git -C "$REPO" config user.name t
echo base > "$REPO/base"; git -C "$REPO" add .; git -C "$REPO" commit -qm init
cat > "$TMP/bin/gh" <<'EOF'
#!/usr/bin/env bash
case "$*" in *'pr view'*|*'pr list'*) exit 1;; *) printf '%s\n' "$*" >> "${GH_LOG:?}"; exit 0;; esac
EOF
chmod +x "$TMP/bin/gh"; export GH_LOG="$TMP/gh.log"
bash "$FETCH" --state-file "$STATE" lock-acquire --lease-min 30 >/dev/null
fail=0; check() { if eval "$1"; then echo "PASS: $2"; else echo "FAIL: $2"; fail=1; fi; }
pass() { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; fail=1; }
make_task() { local slug="$1"; git -C "$REPO" worktree add -q "$REPO/.worktrees/$slug" -b "feat/$slug"; mkdir -p "$DISP/$slug"; echo "$slug" > "$REPO/.worktrees/$slug/$slug.txt"; git -C "$REPO/.worktrees/$slug" add .; git -C "$REPO/.worktrees/$slug" commit -qm work; }
state() { jq -n --arg i "$1" --arg s "$2" --arg slug "$3" '{issues:{($i):{slug:$slug,status:$s,batch:1}},batches:[{n:1,issues:[$i|tonumber]}],leaked:[]}' > "$STATE"; }
run() { bash "$CLEANUP" --state-file "$STATE" --batch 1 --integration "$1" --repo-root "$REPO" ${2:+--agmsg-team "$2"}; }

# C1: PR 未確認の done は error 化し branch/worktree を残す。
make_task unverified; echo '{"status":"done"}' > "$DISP/unverified/status.json"; state 1 done unverified; out=$(run pr)
check '[[ $(jq -r .unverified <<<"$out") -eq 1 && $(jq -r ".issues[\"1\"].status" "$STATE") == error ]]' 'C1 PR 未確認の done を error に降格する'
check '[[ -d "$REPO/.worktrees/unverified" ]] && git -C "$REPO" show-ref --verify -q refs/heads/feat/unverified' 'C1 worktree と branch を温存する'

# commit を失敗させ、patch/tar フォールバックを必ず通す。
REAL_GIT=$(command -v git); cat > "$TMP/bin/git" <<EOF
#!/usr/bin/env bash
for a in "\$@"; do [[ "\$a" == commit && -n "\${FAIL_GIT_COMMIT:-}" ]] && exit 1; done
exec "$REAL_GIT" "\$@"
EOF
chmod +x "$TMP/bin/git"
# C2: 未追跡内容を tar に保全してから削除する。
make_task untracked; echo new > "$REPO/.worktrees/untracked/new.txt"; echo '{"status":"error"}' > "$DISP/untracked/status.json"; state 2 error untracked; FAIL_GIT_COMMIT=1 run pr >/dev/null
check '[[ -s "$DISP/untracked/wip-untracked.tar.gz" ]] && gzip -cd "$DISP/untracked/wip-untracked.tar.gz" | grep -q new.txt' 'C2 未追跡ファイルを tar に保全する'
check '[[ ! -d "$REPO/.worktrees/untracked" ]]' 'C2 保全成功後に worktree を削除する'
# C3: binary patch は clean worktree に apply 可能。
make_task binary; printf '\000\001old' > "$REPO/.worktrees/binary/blob"; git -C "$REPO/.worktrees/binary" add blob; git -C "$REPO/.worktrees/binary" commit -qm binary; printf '\000\002new' > "$REPO/.worktrees/binary/blob"; echo '{"status":"error"}' > "$DISP/binary/status.json"; state 3 error binary; FAIL_GIT_COMMIT=1 run pr >/dev/null
check 'grep -q "GIT binary patch" "$DISP/binary/wip.patch"' 'C3 binary patch を保全する'
V="$TMP/verify"; git -C "$REPO" worktree add --detach -q "$V" feat/binary; check 'git -C "$V" apply --check --binary "$DISP/binary/wip.patch"' 'C3 clean worktree で patch を検証する'; git -C "$REPO" worktree remove "$V" --force
# C4: merge conflict は温存する。
make_task conflict; echo main > "$REPO/base"; git -C "$REPO" add base; git -C "$REPO" commit -qm main; echo branch > "$REPO/.worktrees/conflict/base"; git -C "$REPO/.worktrees/conflict" add base; git -C "$REPO/.worktrees/conflict" commit -qm branch; echo '{"status":"done"}' > "$DISP/conflict/status.json"; state 4 done conflict; out=$(run merge)
check '[[ $(jq -r .conflicted <<<"$out") -eq 1 && -d "$REPO/.worktrees/conflict" ]]' 'C4 merge conflict 時は worktree を温存する'
check 'git -C "$REPO" show-ref --verify -q refs/heads/feat/conflict' 'C4 merge conflict 時は branch を温存する'
# C5: fallback の失敗は leaked に記録し worktree を残す。
make_task unsalvageable; echo x > "$REPO/.worktrees/unsalvageable/x"; echo '{"status":"error"}' > "$DISP/unsalvageable/status.json"; state 5 error unsalvageable; chmod 500 "$DISP/unsalvageable"; FAIL_GIT_COMMIT=1 run pr >/dev/null || true; chmod 700 "$DISP/unsalvageable"
check '[[ -d "$REPO/.worktrees/unsalvageable" && $(jq ".leaked|length" "$STATE") -ge 1 ]]' 'C5 保全失敗を leaked として温存する'
# C6: state の timeout は後着 done より優先する。
make_task timeout; echo '{"status":"done","pr_url":"https://x/pr"}' > "$DISP/timeout/status.json"; state 6 timeout timeout; run pr >/dev/null
check '[[ $(jq -r ".issues[\"6\"].status" "$STATE") == timeout ]] && git -C "$REPO" show-ref --verify -q refs/heads/feat/timeout' 'C6 timeout を done に戻さない'
# C7: finalize 失敗なら worktree を削除しない（fetch を一時的に失敗させる）。
make_task finfail; echo '{"status":"error"}' > "$DISP/finfail/status.json"; state 7 error finfail; mv "$FETCH" "$FETCH.saved"; printf '#!/usr/bin/env bash\nexit 1\n' > "$FETCH"; chmod +x "$FETCH"; set +e; run pr >/dev/null 2>&1; rc=$?; set -e; mv "$FETCH.saved" "$FETCH"
check '[[ $rc -ne 0 && -d "$REPO/.worktrees/finfail" ]]' 'C7 finalize 失敗時は破壊的処理を停止する'
# C8: terminal label 失敗なら worktree を削除しない。
make_task labelfail; echo '{"status":"done","pr_url":"https://x/pr"}' > "$DISP/labelfail/status.json"; state 8 done labelfail
printf '#!/usr/bin/env bash\ncase "$*" in *"--add-label"*) exit 1;; *"pr view"*) exit 0;; *) exit 0;; esac\n' > "$TMP/bin/gh"; chmod +x "$TMP/bin/gh"; run pr >/dev/null
check '[[ -d "$REPO/.worktrees/labelfail" && $(jq ".leaked|length" "$STATE") -ge 1 ]]' 'C8 terminal label 失敗時は温存する'
# merge 成功時は issue close、正常 cleanup では agmsg leave を呼ぶ。
printf '#!/usr/bin/env bash\ncase "$*" in *"pr view"*) exit 0;; *) printf "%s\\n" "$*" >> "$GH_LOG"; exit 0;; esac\n' > "$TMP/bin/gh"; chmod +x "$TMP/bin/gh"; mkdir -p "$HOME/.agents/skills/agmsg/scripts"; make_task merged; echo '{"status":"done"}' > "$DISP/merged/status.json"; state 9 done merged; out=$(run merge demo)
check '[[ $(jq -r .merged <<<"$out") -eq 1 ]] && grep -Fq "gh issue close \"\$issue\" --reason completed" "$CLEANUP"' 'merge 完了時に gh issue close --reason completed を呼ぶ'
check '[[ ! -d "$REPO/.worktrees/merged" ]]' '正常 cleanup を完了する'
bash "$FETCH" --state-file "$STATE" lock-release >/dev/null 2>&1 || true

# C9-C12: prewarm.json の実在 role だけを leave し、workspace と snapshot を検証する。
. "$SCRIPT_DIR/lib/cleanup-harness.sh"
ROLE_DISPATCH="$CLEANUP_HARNESS_ROOT/dispatch"
mkdir -p "$ROLE_DISPATCH/t"
write_prewarm() { # $1=review mode
  local review_mode="$1"
  mkdir -p "$ROLE_DISPATCH/t"
  jq -n --arg mode "$review_mode" '{
    workspace_id:"workspace:1",review_mode:$mode,
    design:{surface_id:"s1",agent:"t",runner:"ccf",engine:"claude",model:"opus[1m]",effort:"xhigh",wired:true},
    exec:{surface_id:"s2",agent:"t-exec",runner:"cx",engine:"codex",effort:"high",wired:true}}
    + (if $mode == "on" then {
      design_review:{surface_id:"s3",agent:"t-design-review",runner:"cx",engine:"codex",model:"gpt-5.6-sol",effort:"xhigh",wired:true},
      exec_review:{surface_id:"s4",agent:"t-exec-review",runner:"ccf",engine:"claude",model:"opus[1m]",effort:"high",wired:true}}
      else {} end)' > "$ROLE_DISPATCH/t/prewarm.json"
}

write_prewarm off
cleanup_stub_workspace 'workspace:1'
run_cleanup_for_slug t "$ROLE_DISPATCH" >/dev/null
check '[[ $(grep -c "leave.sh" "$CLEANUP_HARNESS_CALLS" 2>/dev/null || true) == 2 ]]' 'C9 review=off は実在 2 role だけ leave する'

write_prewarm on
cleanup_stub_workspace 'workspace:1'
run_cleanup_for_slug t "$ROLE_DISPATCH" done merge >/dev/null
# close-surface / close-workspace が同じログへ加わるようになったため、重複チェックは
# leave.sh の行だけへ絞る (close 呼び出し自体は LC-C1 で別途検査する)。
check '[[ ! -d "$ROLE_DISPATCH/t" ]] && [[ $(grep -c "leave.sh" "$CLEANUP_HARNESS_CALLS" 2>/dev/null || true) == 4 ]] && [[ $(grep "leave.sh" "$CLEANUP_HARNESS_CALLS" | sort | uniq | wc -l | tr -d " ") == 4 ]]' 'C10 done が prewarm を削除しても snapshot 済みの実在 4 role を各 1 回 leave する'

write_prewarm on
jq '.design.agent = "t-exec"' "$ROLE_DISPATCH/t/prewarm.json" > "$ROLE_DISPATCH/t/bad.json"
mv "$ROLE_DISPATCH/t/bad.json" "$ROLE_DISPATCH/t/prewarm.json"
cleanup_stub_workspace 'workspace:1'
run_cleanup_for_slug t "$ROLE_DISPATCH" >/dev/null
check '[[ $(grep -c "leave.sh" "$CLEANUP_HARNESS_CALLS" 2>/dev/null || true) == 0 ]]' 'C11 invalid snapshot では leave しない'

rm -f "$ROLE_DISPATCH/t/prewarm.json"
cleanup_stub_workspace 'workspace:1'
run_cleanup_for_slug t "$ROLE_DISPATCH" >/dev/null
check '[[ $(grep -c "leave.sh" "$CLEANUP_HARNESS_CALLS" 2>/dev/null || true) == 0 ]]' 'C12 prewarm 欠落でも cleanup は継続し旧 agent を合成しない'

# ハーネスの正常系 1 タスク実行 (review on、実在 4 role が揃った状態)。
write_prewarm on
cleanup_stub_workspace 'workspace:1'
run_cleanup_for_slug t "$ROLE_DISPATCH" >/dev/null

# LC-C1: タスクごとに close-surface と close-workspace を呼ぶ。
# ドキュメント (loop-mode.md) は cleanup が閉じると書いていたが、実装は leave.sh だけを
# 呼んでいた。5 分でタイムアウトした 2026-09-02 の batch 2 では、workspace が開いたまま
# 残った。閉じるのが cleanup の責任であることを、ここで実装側に固定する。
# (ハーネスの正常系 1 タスク実行のあとに評価する)
# 1 行 grep -q だけだと、単一の決め打ち surface しか閉じない実装や、
# awk 'NF && !seen[$0]++' の重複排除を失った実装も素通りしてしまう。この fixture
# (review_mode=on, s1-s4 の 4 role 分固定 surface) では実在 4 role が重複なく
# 1 回ずつ閉じられることまで見る (C10 が leave.sh 側で行う検査の close-surface 版)。
close_raw=$(grep -c '^cmux close-surface ' "$CLEANUP_HARNESS_CALLS" 2>/dev/null || echo 0)
close_uniq=$(grep '^cmux close-surface ' "$CLEANUP_HARNESS_CALLS" | sort | uniq | wc -l | tr -d ' ')
if grep -q "^cmux close-surface .*--workspace " "$CLEANUP_HARNESS_CALLS" \
   && grep -q "^cmux close-workspace " "$CLEANUP_HARNESS_CALLS" \
   && [[ "$close_raw" == 4 ]] && [[ "$close_uniq" == "$close_raw" ]]; then
  pass "LC-C1: cleanup が surface と workspace を閉じる (実在 4 role を重複無く各 1 回)"
else
  bad "LC-C1: close 呼び出しが無いか件数不正 (raw=$close_raw uniq=$close_uniq): $(cat "$CLEANUP_HARNESS_CALLS")"
fi

# LC-C2: 各タスクの段階が stderr に出る。どこまで終わったかが外から分かること。
if grep -qE '^\[step\] ' "$CLEANUP_HARNESS_STDERR"; then
  pass "LC-C2: 段階ログが出る"
else
  bad "LC-C2: 段階ログが無い"
fi

# LC-C3: verify_done の PR 検索に --repo が入る。
# 入っていないと gh は現在の remote 設定から推測し、fork 側の PR を完了の証拠として拾う。
if grep -q 'gh pr list --repo' \
   "$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/loop-cleanup.sh"; then
  pass "LC-C3: verify_done が --repo を渡す"
else
  bad "LC-C3: gh pr list に --repo が無い"
fi

[[ $fail -eq 0 ]] && echo '--- all tests passed ---' || exit 1
