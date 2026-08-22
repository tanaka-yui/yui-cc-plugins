#!/usr/bin/env bash
# D6 のパスヘルパーが全 consumer へ届いていることの検査。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
S="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts"
LAUNCH="$S/launch-workspace.sh"
fail=0
bad() { echo "FAIL $1"; fail=1; }
ok() { echo "PASS $1"; }

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/repo" "$TMP/status"
printf '#!/bin/sh\nexit 0\n' > "$TMP/bin/cmux"; chmod +x "$TMP/bin/cmux"
printf '#!/bin/sh\nexit 0\n' > "$TMP/bin/agmsg-send.sh"; chmod +x "$TMP/bin/agmsg-send.sh"

# 他はすべて妥当な呼び出しで、--runner だけ実在しない名前にする。
probe() {
  AGMSG_SEND="$TMP/bin/agmsg-send.sh" CMUX_BIN="$TMP/bin/cmux" "$@" bash "$LAUNCH" \
    --cwd "$TMP/repo" --mode plan --runner definitely-not-a-runner \
    --agmsg-team demo --agmsg-from probe --status-dir "$TMP/status" \
    probe-ws prompt 2>&1
}

# CP1: 既定 base が使われる
out=$(probe env DISPATCH_CONFIG_HOME="$TMP/h")
if grep -q "$TMP/h/runners.json" <<<"$out"; then
  ok 'CP1: DISPATCH_CONFIG_HOME 由来の runners.json を見る'
else
  bad "CP1: 期待するパスがメッセージに無い: $out"
fi

# CP2: 個別 override
out=$(probe env DISPATCH_CONFIG_HOME="$TMP/h" RUNNERS_CONFIG_PATH="$TMP/x/runners.json")
if grep -q "$TMP/x/runners.json" <<<"$out"; then
  ok 'CP2: RUNNERS_CONFIG_PATH の個別 override が効く'
else
  bad "CP2: $out"
fi

# CP3: terminal-wait.sh の config パス
out=$(DISPATCH_CONFIG_HOME="$TMP/h" bash -c ". '$S/terminal-wait.sh' >/dev/null 2>&1; \
      printf '%s' \"\$TERMINAL_WAIT_GLOBAL_CONFIG\"")
[[ "$out" == "$TMP/h/config.json" ]] \
  && ok 'CP3: terminal-wait.sh が DISPATCH_CONFIG_HOME を使う' || bad "CP3: $out"

# CP4: 旧パスの残骸
if grep -rn '\.claude/cmux-team-dispatch-task' "$S" >/dev/null 2>&1; then
  bad "CP4: 旧パスの参照が残っている: $(grep -rln '\.claude/cmux-team-dispatch-task' "$S" | tr '\n' ' ')"
else
  ok 'CP4: 旧パスの参照が無い'
fi

# CP5: terminal-wait.sh の temp が config と同じディレクトリに作られる
grep -q 'mktemp "\$TERMINAL_WAIT_GLOBAL_CONFIG\.XXXXXX"\|mktemp "\$CONFIG\.XXXXXX"' \
  "$S/terminal-wait.sh" \
  && ok 'CP5: terminal-wait.sh が同一ディレクトリの mktemp を使う' \
  || bad 'CP5: 引数なし mktemp のままで、別 FS だと mv が atomic にならない'

exit $fail
