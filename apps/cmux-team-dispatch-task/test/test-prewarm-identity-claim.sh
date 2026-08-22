#!/usr/bin/env bash
# ペインの identity claim。
#
# 起動直後のペインは **無記名 (unfiltered) の watcher** を持つ。SessionStart が
# role-filtered 指示を出せるのは「その sid が role の seat として記録済み」のときだけで、
# レコードを書く actas-claim.sh / codex-record-session.sh はどちらもペイン起動 *後* に
# 走るため、新規ペインでは構造上その経路が発動しない。無記名 watcher は (project, type) に
# 登録された全 agent 宛てを購読し、read cursor は (team, agent) ごとに 1 つしか無いので、
# 先に poll した watcher が row を取り他は二度と見られない。
#
# 2026-08-22 の実測: 1 ディスパッチで無記名 watcher が 8 本まで積み上がり、
# 競合警告が 14 回発火した (~/.agents/skills/agmsg/run/watch.*.log)。
#
# 守っている不変条件:
#   PI1. claude ロールは actas-claim.sh を自分の agent 名で呼ぶ
#   PI2. claim は [ready] 送信より **前** に置かれる (無記名の窓を閉じてから名乗る)
#   PI3. 無記名 Monitor を止めて agent 名付きで張り直す指示がある
#        (claim だけでは既に起動済みの無記名 watcher は無記名のまま)
#   PI4. status=held は停止条件として明示される (他セッションが同名を保持している)
#   PI5. codex ロールは actas-claim.sh を使わない (identity 経路が別)

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail=0
pass() { echo "PASS $1"; }
bad() { echo "FAIL $1"; fail=1; }
. "$SCRIPT_DIR/lib/prewarm-harness.sh"
make_launch_stub ""

: > "$TMP/calls.log"
CALLS_LOG="$TMP/calls.log" bash "$PW" --with-design --cwd "$TMP/wt" --slug pi \
  --status-dir "$TMP/status" --agmsg-team team --roles "$ROLES_ON" >/dev/null 2>&1

prompt_for() { # $1=role → その role の launch 行
  grep '^launch ' "$TMP/calls.log" | grep -F -- "--role $1 " | head -1
}

design=$(prompt_for design)
exec_review=$(prompt_for exec_review)
design_review=$(prompt_for design_review)

# --- PI1 ---
if [[ "$design" == *"actas-claim.sh"* && "$design" == *"pi"* ]]; then
  pass 'PI1 claude design が actas-claim.sh を呼ぶ'
else
  bad "PI1 actas-claim.sh が無い"
fi
if [[ "$exec_review" == *"actas-claim.sh"* && "$exec_review" == *"pi-exec-review"* ]]; then
  pass 'PI1 claude exec_review が自分の agent 名で claim する'
else
  bad 'PI1 exec_review の claim が無い / 名前が違う'
fi

# --- PI2: claim が [ready] より前 ---
claim_pos=$(awk -v s="$design" 'BEGIN{print index(s, "actas-claim.sh")}')
ready_pos=$(awk -v s="$design" 'BEGIN{print index(s, "[ready]")}')
if [[ "$claim_pos" -gt 0 && "$ready_pos" -gt 0 && "$claim_pos" -lt "$ready_pos" ]]; then
  pass 'PI2 claim が [ready] 送信より前にある'
else
  bad "PI2 順序が違う (claim=$claim_pos ready=$ready_pos)"
fi

# --- PI3: 無記名 Monitor を張り直す ---
if [[ "$design" == *"TaskStop"* ]] && [[ "$design" == *"fourth argument"* || "$design" == *"4th argument"* ]]; then
  pass 'PI3 無記名 Monitor を止めて agent 名付きで張り直す指示がある'
else
  bad 'PI3 Monitor の張り直し指示が無い (claim だけでは無記名のまま)'
fi

# --- PI4: held を停止条件として扱う ---
if [[ "$design" == *"status=held"* ]]; then
  pass 'PI4 status=held を停止条件として明示している'
else
  bad 'PI4 held の扱いが書かれていない'
fi

# --- PI5: codex は actas-claim を使わない ---
if [[ "$design_review" != *"actas-claim.sh"* && "$design_review" == *"codex-record-session.sh"* ]]; then
  pass 'PI5 codex ロールは actas-claim.sh を使わず codex-record-session.sh のまま'
else
  bad 'PI5 codex ロールの identity 経路が変わっている'
fi

[[ $fail -eq 0 ]] && echo '--- all passed ---' || echo '--- failures ---'
exit $fail
