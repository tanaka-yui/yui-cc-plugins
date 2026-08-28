#!/usr/bin/env bash
# cmux-codex-exec の回帰テスト。
#
# stub の cmux / codex を用意し、bin が `cmux send` でペインへ送る文字列を
# **ペインのシェルと同じように再パース**して、codex が実際に受け取る引数を検証する。
#
# 実行: bash apps/cmux-codex-exec/test/test-cmux-codex-exec.sh
#
# 守っている不変条件:
#   E1. plan を明示指定すると、そのパスが prompt へ無傷で届き、prompt は 1 引数
#   E2. --list-targets は cmux を呼ばずに plan 候補を mtime 降順で TSV 出力する
#   E3. 候補ゼロ（git リポジトリ外・plan ディレクトリ無し）でも空出力・終了コード 0 で終わる
#   E4. プロンプトに並列実行の語彙が 1 つも入らない（否定的不変条件）
#   E5. 削除済みフラグ --no-parallel / --agents は非ゼロ終了し、ペインを分割しない
#   E6. 通知配線時、send.sh の本文に agents= が入らず、prompt は 1 引数のまま
#   E7. 通知配線時、codex に bridge seat を記録させる指示が入り、watch.sh の自前起動を禁じる
#       (seat が無いと親からの nudge は未読で滞留する。notification-gaps の R2)
#       通知配線が無いときはこの指示も入らない
#
# E4-E6 が否定形なのは、codex に並列を指示しなくなったため。codex の子エージェントは
# app-server daemon 上の別スレッドで走りペインに一切映らないので、指示すると
# 「動いているのか止まっているのか」を判別できない状態を自分で作ることになる。
# 語彙が 1 つでも復活したら落ちる形にして、うっかりの再導入を防ぐ。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$SCRIPT_DIR/../bin/cmux-codex-exec"
[[ -x "$BIN" ]] || { echo "FAIL: bin が見つからない/実行不可: $BIN"; exit 2; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"

cat > "$TMP/bin/cmux" <<'STUB'
#!/usr/bin/env bash
if [[ "$1" == "new-split" ]]; then
  echo "split" >> "${SPLIT_LOG:-/dev/null}"
  echo "OK surface:31 workspace:9"; exit 0
fi
if [[ "$1" == "send" ]]; then printf '%s' "$4" > "$SENT_CMD"; exit 0; fi
STUB
chmod +x "$TMP/bin/cmux"

cat > "$TMP/bin/codex" <<'STUB'
#!/usr/bin/env bash
echo "$#" > "$CODEX_ARGC"
prompt=""; for a in "$@"; do prompt="$a"; done
printf '%s' "$prompt" > "$CODEX_PROMPT"
STUB
chmod +x "$TMP/bin/codex"

export CMUX_SOCKET_PATH=/tmp/fake.sock
export SENT_CMD="$TMP/sent.cmd"
fail=0

reparse() { env PATH="$TMP/bin:$PATH" CODEX_ARGC="$TMP/argc" CODEX_PROMPT="$TMP/prompt" bash -c "$(cat "$SENT_CMD")"; }
argc() { cat "$TMP/argc" 2>/dev/null || echo "?"; }
prompt() { cat "$TMP/prompt" 2>/dev/null || echo ""; }

# --- E1: plan の明示指定が prompt へ無傷で届き、prompt は 1 引数 ---
echo "plan body" > "$TMP/my-plan.md"
CMUX_BIN="$TMP/bin/cmux" "$BIN" "$TMP/my-plan.md" --team t --parent parent >/dev/null 2>&1
reparse
if [[ "$(argc)" == "6" ]] \
  && prompt | grep -q "$TMP/my-plan.md" \
  && prompt | grep -q "send.sh t "; then
  echo "PASS E1: plan パスと send.sh が prompt に無傷で到達、argc=6"
else
  echo "FAIL E1: argc=$(argc) / prompt=[$(prompt)]"
  fail=1
fi

# --- E2: --list-targets は cmux 無し・CMUX_SOCKET_PATH 無しで plan 候補を mtime 降順出力 ---
REPO="$TMP/repo"
mkdir -p "$REPO/docs/superpowers/plans"
git -C "$REPO" init -q >/dev/null 2>&1
git -C "$REPO" config user.email tester@example.com
git -C "$REPO" config user.name tester
echo "old" > "$REPO/docs/superpowers/plans/2026-01-01-old.md"
git -C "$REPO" add -A >/dev/null 2>&1
git -C "$REPO" commit -qm init >/dev/null 2>&1
echo "new" > "$REPO/docs/superpowers/plans/2026-01-02-new.md"
touch -t 202601010000 "$REPO/docs/superpowers/plans/2026-01-01-old.md"
touch -t 202601020000 "$REPO/docs/superpowers/plans/2026-01-02-new.md"
lt=$(cd "$REPO" && env -u CMUX_SOCKET_PATH CMUX_BIN=/nonexistent/cmux "$BIN" --list-targets 2>&1)
first=$(printf '%s\n' "$lt" | head -1)
if printf '%s' "$first" | grep -q "2026-01-02-new.md" \
  && printf '%s' "$first" | grep -q "plan / untracked" \
  && printf '%s\n' "$lt" | grep -q "2026-01-01-old.md.*plan / committed"; then
  echo "PASS E2: --list-targets が cmux 無しで plan を mtime 降順に列挙"
else
  echo "FAIL E2: [$lt]"
  fail=1
fi

# --- E3: 候補ゼロ（git リポジトリ外・plan ディレクトリ無し）でも空出力・終了コード 0 ---
NOGIT=$(mktemp -d)
lt3=$(cd "$NOGIT" && env -u CMUX_SOCKET_PATH CMUX_BIN=/nonexistent/cmux "$BIN" --list-targets 2>&1)
rc3=$?
rm -rf "$NOGIT"
if [[ $rc3 -eq 0 && -z "$lt3" ]]; then
  echo "PASS E3: git リポジトリ外でも --list-targets が空出力・終了コード 0"
else
  echo "FAIL E3: rc=$rc3 / lt=[$lt3]"
  fail=1
fi

# --- E4: プロンプトに並列実行の語彙が 1 つも入らない ---
CMUX_BIN="$TMP/bin/cmux" "$BIN" "$TMP/my-plan.md" >/dev/null 2>&1
reparse
e4=1
for word in spawn_agent wait_agent 並列実行 子エージェント agent_type; do
  if prompt | grep -q "$word"; then
    echo "  並列語彙が残っている: $word"
    e4=0
  fi
done
if [[ "$(argc)" == "6" && $e4 -eq 1 ]]; then
  echo "PASS E4: プロンプトに並列実行の語彙が入らない、argc=6"
else
  echo "FAIL E4: argc=$(argc) / prompt=[$(prompt)]"
  fail=1
fi

# --- E5: 削除済みフラグは非ゼロ終了し、ペインを分割しない ---
# 黙って無視されるより、消えたフラグだと分かる方が良い。arg parser の *) は位置引数
# （plan パス）へ落ちるので、存在しないパスとして plan 解決前に弾かれる。
rm -f "$TMP/split.log"
bad=0
SPLIT_LOG="$TMP/split.log" CMUX_BIN="$TMP/bin/cmux" "$BIN" "$TMP/my-plan.md" --no-parallel >/dev/null 2>&1 && bad=1
SPLIT_LOG="$TMP/split.log" CMUX_BIN="$TMP/bin/cmux" "$BIN" "$TMP/my-plan.md" --agents 4 >/dev/null 2>&1 && bad=1
if [[ $bad -eq 0 && ! -f "$TMP/split.log" ]]; then
  echo "PASS E5: 削除済みフラグを拒否し、ペインを分割しない"
else
  echo "FAIL E5: bad=$bad / split.log=$( [[ -f "$TMP/split.log" ]] && echo exists || echo none )"
  fail=1
fi

# --- E6: 通知本文に agents= が入らず、prompt は 1 引数のまま ---
# NOTIFY は 'DONE ...' の単一引用符を含むので、argc の検査がエスケープの回帰も兼ねる。
CMUX_BIN="$TMP/bin/cmux" "$BIN" "$TMP/my-plan.md" --team t --parent parent >/dev/null 2>&1
reparse
if [[ "$(argc)" == "6" ]] && prompt | grep -q '実装完了' && ! prompt | grep -q 'agents='; then
  echo "PASS E6: 通知本文に agents= が入らず argc=6 のまま"
else
  echo "FAIL E6: argc=$(argc) / prompt=[$(prompt)]"
  fail=1
fi

# --- E7: 受信配線 (bridge seat) の指示 ---
# join.sh は送信側の登録でしかないので、これが無いと親からの追撃指示が codex に届かない。
CMUX_BIN="$TMP/bin/cmux" "$BIN" "$TMP/my-plan.md" --team t --parent parent >/dev/null 2>&1
reparse
with_seat=0
prompt | grep -q 'codex-record-session.sh t cxexec-' \
  && prompt | grep -q 'watch.sh を自分で起動してはならない' && with_seat=1

CMUX_BIN="$TMP/bin/cmux" "$BIN" "$TMP/my-plan.md" >/dev/null 2>&1
reparse
without_seat=0
prompt | grep -q 'codex-record-session.sh' || without_seat=1

if [[ $with_seat -eq 1 && $without_seat -eq 1 ]]; then
  echo "PASS E7: 通知配線時だけ bridge seat の記録を指示し、watch.sh の自前起動を禁じる"
else
  echo "FAIL E7: with_seat=$with_seat / without_seat=$without_seat"
  fail=1
fi

[[ $fail -eq 0 ]] && echo "--- すべて PASS ---" || echo "--- FAIL あり ---"
exit $fail
