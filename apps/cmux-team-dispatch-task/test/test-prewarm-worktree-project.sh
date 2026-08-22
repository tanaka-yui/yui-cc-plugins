#!/usr/bin/env bash
# worktree を agmsg の独立プロジェクトとして登録する。
#
# resolve-project.sh は既定で git worktree をメインリポジトリのルートへ解決する (#92)。
# その結果、子ペインも親も同じプロジェクトキーを共有し、無記名 watcher が (project, type) に
# 登録された全 agent 宛てを購読して read cursor を奪い合う。実害は「子の無記名 watcher が
# parent ペアを購読していたため [ready] が食われた」という形で出た。
#
# join / delivery を AGMSG_RESOLVE_PROJECT=0 で呼べば worktree パスのまま登録される。
# 以後 agmsg_ancestor_project は **inclusive** (start 自身を候補にする) なので worktree で
# 止まり、タスクごとに別プロジェクトキーになる。spawn.sh:357 が既に同じ形を使っている。
#
# 守っている不変条件:
#   WP1. join.sh は AGMSG_RESOLVE_PROJECT=0 付きで呼ばれる
#   WP2. delivery.sh も同じ扱い (登録先がずれると配送モードが別プロジェクトに付く)
#   WP3. 渡すパスは worktree (--cwd) であってリポジトリルートではない
#   WP4. 全 4 ロールに適用される

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail=0
pass() { echo "PASS $1"; }
bad() { echo "FAIL $1"; fail=1; }
. "$SCRIPT_DIR/lib/prewarm-harness.sh"
make_launch_stub ""

# 環境変数まで記録する stub に差し替える
for b in join.sh delivery.sh; do
  cat > "$TMP/bin/$b" <<'STUB'
#!/usr/bin/env bash
name=$(basename "$0")
printf '%s RESOLVE=%s ARGS=%s\n' "$name" "${AGMSG_RESOLVE_PROJECT:-unset}" "$*" >> "$ENV_LOG"
exit 0
STUB
  chmod +x "$TMP/bin/$b"
done
# harness は AGMSG_DIR=$TMP/bin を export 済みなので、そこへ置いた stub が使われる

: > "$TMP/env.log"
ENV_LOG="$TMP/env.log" CALLS_LOG="$TMP/calls.log" \
  bash "$PW" --with-design --cwd "$TMP/wt" --slug wp \
  --status-dir "$TMP/status" --agmsg-team team --roles "$ROLES_ON" >/dev/null 2>&1

joins=$(grep -c '^join.sh ' "$TMP/env.log" 2>/dev/null; true); joins=${joins:-0}
bad_resolve=$(grep '^join.sh ' "$TMP/env.log" 2>/dev/null | grep -cv 'RESOLVE=0'; true)
bad_resolve=${bad_resolve:-0}
if [[ "$joins" -ge 4 && "$bad_resolve" -eq 0 ]]; then
  pass "WP1/WP4 join.sh $joins 件すべてが AGMSG_RESOLVE_PROJECT=0 付き"
else
  bad "WP1/WP4 joins=$joins resolve未設定=$bad_resolve"
fi

dels=$(grep -c '^delivery.sh ' "$TMP/env.log" 2>/dev/null; true); dels=${dels:-0}
bad_del=$(grep '^delivery.sh ' "$TMP/env.log" 2>/dev/null | grep -cv 'RESOLVE=0'; true)
bad_del=${bad_del:-0}
if [[ "$dels" -ge 4 && "$bad_del" -eq 0 ]]; then
  pass "WP2 delivery.sh $dels 件すべてが AGMSG_RESOLVE_PROJECT=0 付き"
else
  bad "WP2 dels=$dels resolve未設定=$bad_del"
fi

if grep '^join.sh ' "$TMP/env.log" 2>/dev/null | grep -q -- "$TMP/wt"; then
  pass 'WP3 worktree のパスを渡している'
else
  bad 'WP3 worktree のパスが渡っていない'
fi

[[ $fail -eq 0 ]] && echo '--- all passed ---' || echo '--- failures ---'
exit $fail
