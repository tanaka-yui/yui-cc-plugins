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
[[ $fail -eq 0 ]] && echo '--- all tests passed ---' || exit 1
