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
#   E4. 既定でプロンプトに並列実行ディレクティブが入り、prompt は 1 引数のまま
#   E5. --no-parallel でディレクティブを一切注入しない
#   E6. .codex/agents/*.toml があれば agent_type 候補が載り、無ければフォールバック文言になる
#   E7. description に ' が含まれても prompt は 1 引数のまま
#   E8. 通知配線時、send.sh の本文に agents= が入る
#   E9. --agents の不正値は非ゼロ終了し、ペインを分割しない

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

# --- E4: 既定で並列実行ディレクティブが入り、prompt は 1 引数のまま ---
CMUX_BIN="$TMP/bin/cmux" "$BIN" "$TMP/my-plan.md" >/dev/null 2>&1
reparse
if [[ "$(argc)" == "6" ]] \
  && prompt | grep -q 'spawn_agent' \
  && prompt | grep -q 'wait_agent' \
  && prompt | grep -q '最大 4 体'; then
  echo "PASS E4: 既定で並列実行ディレクティブが prompt に入る、argc=6"
else
  echo "FAIL E4: argc=$(argc) / prompt=[$(prompt)]"
  fail=1
fi

# --- E5: --no-parallel でディレクティブを注入しない ---
CMUX_BIN="$TMP/bin/cmux" "$BIN" "$TMP/my-plan.md" --no-parallel >/dev/null 2>&1
reparse
if [[ "$(argc)" == "6" ]] && ! prompt | grep -q 'spawn_agent'; then
  echo "PASS E5: --no-parallel でディレクティブ非注入、argc=6"
else
  echo "FAIL E5: argc=$(argc) / prompt=[$(prompt)]"
  fail=1
fi

# --- E6: .codex/agents/*.toml があれば agent_type 候補が載る / 無ければフォールバック文言 ---
AGENTREPO="$TMP/agentrepo"
mkdir -p "$AGENTREPO/.codex/agents"
cp "$TMP/my-plan.md" "$AGENTREPO/plan.md"
cat > "$AGENTREPO/.codex/agents/my-coder.toml" <<'TOML'
description = "Implements backend code"
developer_instructions = """
body
"""
TOML
(cd "$AGENTREPO" && CMUX_BIN="$TMP/bin/cmux" "$BIN" plan.md >/dev/null 2>&1)
reparse
has_type=0
prompt | grep -q 'my-coder — Implements backend code' && has_type=1

NOAGENT="$TMP/noagent"
mkdir -p "$NOAGENT"
cp "$TMP/my-plan.md" "$NOAGENT/plan.md"
(cd "$NOAGENT" && CMUX_BIN="$TMP/bin/cmux" "$BIN" plan.md >/dev/null 2>&1)
reparse
has_fallback=0
prompt | grep -q 'agent_type の定義が無い' && has_fallback=1

if [[ $has_type -eq 1 && $has_fallback -eq 1 ]]; then
  echo "PASS E6: agent_type 候補の列挙とフォールバック文言が切り替わる"
else
  echo "FAIL E6: has_type=$has_type / has_fallback=$has_fallback"
  fail=1
fi

# --- E7: description に ' が含まれても prompt は 1 引数のまま ---
cat > "$AGENTREPO/.codex/agents/quoter.toml" <<'TOML'
description = "It's a quality checker"
TOML
(cd "$AGENTREPO" && CMUX_BIN="$TMP/bin/cmux" "$BIN" plan.md >/dev/null 2>&1)
reparse
if [[ "$(argc)" == "6" ]] && prompt | grep -q "It's a quality checker"; then
  echo "PASS E7: description の ' がエスケープされ、argc=6 のまま"
else
  echo "FAIL E7: argc=$(argc) / prompt=[$(prompt)]"
  fail=1
fi

# --- E8: 通知配線時、send.sh の本文に agents= が入る ---
CMUX_BIN="$TMP/bin/cmux" "$BIN" "$TMP/my-plan.md" --team t --parent parent >/dev/null 2>&1
reparse
if prompt | grep -q '実装完了 agents=' && prompt | grep -q 'spawn した子エージェントの総数'; then
  echo "PASS E8: 通知本文に agents= と置換指示が入る"
else
  echo "FAIL E8: prompt=[$(prompt)]"
  fail=1
fi

# --- E8b: --no-parallel では agents= を付けない ---
CMUX_BIN="$TMP/bin/cmux" "$BIN" "$TMP/my-plan.md" --no-parallel --team t --parent parent >/dev/null 2>&1
reparse
if prompt | grep -q '実装完了' && ! prompt | grep -q 'agents='; then
  echo "PASS E8b: --no-parallel では通知本文に agents= を付けない"
else
  echo "FAIL E8b: prompt=[$(prompt)]"
  fail=1
fi

# --- E9: --agents の不正値は非ゼロ終了し、ペインを分割しない ---
rm -f "$TMP/split.log"
bad=0
SPLIT_LOG="$TMP/split.log" CMUX_BIN="$TMP/bin/cmux" "$BIN" "$TMP/my-plan.md" --agents 9 >/dev/null 2>&1 && bad=1
SPLIT_LOG="$TMP/split.log" CMUX_BIN="$TMP/bin/cmux" "$BIN" "$TMP/my-plan.md" --agents abc >/dev/null 2>&1 && bad=1
if [[ $bad -eq 0 && ! -f "$TMP/split.log" ]]; then
  echo "PASS E9: --agents の不正値を拒否し、ペインを分割しない"
else
  echo "FAIL E9: bad=$bad / split.log=$( [[ -f "$TMP/split.log" ]] && echo exists || echo none )"
  fail=1
fi

[[ $fail -eq 0 ]] && echo "--- すべて PASS ---" || echo "--- FAIL あり ---"
exit $fail
