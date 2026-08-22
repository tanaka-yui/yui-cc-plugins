#!/usr/bin/env bash
# SKILL.md の $AGMSG_SEND 束縛の回帰テスト。
#
# 守っている不変条件:
#   AB1. SKILL.md が $AGMSG_SEND を使うより前に AGMSG_SEND へ代入している
#   AB2. 代入値が agmsg の send.sh を指している
#   AB3. helper は空の --send-command を usage error で拒否する
#   AB4. 束縛が無い環境でも normative な helper 呼び出しが成立する
#
# 既存テストがこれを取りこぼしたのは、テスト側が自分で AGMSG_SEND を export して
# いたためである（`test-launch-workspace-layout.sh` など）。テストハーネスが用意する
# 変数と、SKILL.md が本文中で定義する変数は別物なので、ここでは SKILL.md の記述
# そのものを検査する。実際に v3.0.0 開発中、SKILL.md は send.sh の存在を確認するだけで
# 変数へ束縛しないまま `--send-command "$AGMSG_SEND"` を渡しており、review 有効時の
# 通常ディスパッチが helper の exit 2 で停止する状態だった。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/SKILL.md"
WAIT_HELPER="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/phase-a-review-wait.sh"
fail=0

bad() { echo "FAIL $1"; fail=1; }
ok() { echo "PASS $1"; }

[[ -f "$SKILL" ]] || { echo "FAIL: SKILL.md が無い: $SKILL"; exit 2; }

# AB1: 代入が最初の使用より前にあること
ASSIGN_LN=$(grep -nE '^[[:space:]]*AGMSG_SEND=' "$SKILL" | head -1 | cut -d: -f1)
USE_LN=$(grep -nF '$AGMSG_SEND' "$SKILL" \
  | grep -vE '^[0-9]+:[[:space:]]*#' \
  | grep -vE '^[0-9]+:[[:space:]]*AGMSG_SEND=' \
  | head -1 | cut -d: -f1)

if [[ -z "$USE_LN" ]]; then
  ok 'AB1: SKILL.md は $AGMSG_SEND を使っていない（束縛の必要なし）'
elif [[ -z "$ASSIGN_LN" ]]; then
  bad "AB1: \$AGMSG_SEND を $USE_LN 行で使うのに代入が無い（空文字へ展開され helper が exit 2 になる）"
elif (( ASSIGN_LN < USE_LN )); then
  ok "AB1: 代入 ($ASSIGN_LN) が最初の使用 ($USE_LN) より前にある"
else
  bad "AB1: 最初の使用 ($USE_LN) が代入 ($ASSIGN_LN) より前にある"
fi

# AB2: 代入値が send.sh を指していること
if [[ -n "$ASSIGN_LN" ]]; then
  ASSIGN_LINE=$(sed -n "${ASSIGN_LN}p" "$SKILL")
  if grep -qF 'agmsg/scripts/send.sh' <<< "$ASSIGN_LINE"; then
    ok 'AB2: AGMSG_SEND は agmsg の send.sh を指している'
  else
    bad "AB2: AGMSG_SEND の代入値が send.sh でない: $ASSIGN_LINE"
  fi
fi

# AB3 / AB4: helper 側の契約
if [[ ! -f "$WAIT_HELPER" ]]; then
  echo "SKIP AB3/AB4: phase-a-review-wait.sh が無い"
else
  common_args=(
    --waiter-engine claude --reviewer-engine codex
    --team t --waiter-agent w --reviewer-agent r
    --reviewer-workspace workspace:1 --reviewer-surface surface:1
    --findings-path /tmp/f.md
  )

  # AB3: 空の --send-command は usage error (2)
  set +e
  env -u AGMSG_SEND bash "$WAIT_HELPER" "${common_args[@]}" --send-command '' >/dev/null 2>&1
  rc=$?
  set -e 2>/dev/null || true
  if [[ "$rc" -eq 2 ]]; then
    ok 'AB3: 空の --send-command を usage error (exit 2) で拒否する'
  else
    bad "AB3: 空の --send-command が exit $rc になった（2 を期待）"
  fi

  # AB4: 束縛が済んでいれば AGMSG_SEND 未 export の環境でも成立する
  set +e
  out=$(env -u AGMSG_SEND bash "$WAIT_HELPER" "${common_args[@]}" \
    --send-command /path/to/send.sh 2>&1)
  rc=$?
  set -e 2>/dev/null || true
  if [[ "$rc" -eq 0 && -n "$out" ]]; then
    ok 'AB4: 解決済みパスを渡せば AGMSG_SEND 未 export の環境でも wait protocol を生成する'
  else
    bad "AB4: normative な helper 呼び出しが exit $rc になった: $out"
  fi
fi

exit "$fail"
