#!/usr/bin/env bash
# cmux-codex-review の回帰テスト。
#
# stub の cmux / codex を用意し、bin が組み立てて `cmux send` でペインへ送る文字列を
# **ペインのシェルと同じように再パース**して、codex が実際に受け取る引数を検証する。
# 生文字列の grep では引用符崩れを検知できないため、この再パースが要。
#
# 実行: bash apps/cmux-codex-review/test/test-cmux-codex-review.sh
#
# 守っている不変条件:
#   D1. sandbox は workspace-write（read-only にすると完了通知の send.sh が
#       agmsg の SQLite DB へ書き込めず、親が永久に wake しない）
#   D2. 通知配線あり → プロンプトに send.sh と token が丸ごと届く
#   D3. 通知配線なし → send.sh を注入しない（後方互換）
#   D4. プロンプトは常にちょうど 1 引数として codex に渡る（引用符エスケープ）
#   D5. approval policy は never（指定しないと codex が承認プロンプトで停止し、
#       レビューが人間の accept 待ちになる）
#   D6. --path はファイル全文レビュー指示になり、パスが prompt へ無傷で届く
#   D7. 存在しない --path は非ゼロ終了し、ペインを分割しない
#   D8. --list-targets は cmux を呼ばずに候補を TSV 出力する（cmux 外でも動く）
#   D9. 候補ゼロ（git リポジトリ外）でも空出力・終了コード 0 で終わる
#   D10. 既定でプロンプトに並列実行ディレクティブが入り、prompt は 1 引数のまま
#   D11. --no-parallel でディレクティブを一切注入しない
#   D12. .codex/agents/*.toml があれば agent_type 候補が載り、無ければフォールバック文言になる
#   D13. description に ' が含まれても prompt は 1 引数のまま
#   D14. 通知配線時、send.sh の本文に agents= が入る
#   D15. --agents の不正値は非ゼロ終了し、ペインを分割しない

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$SCRIPT_DIR/../bin/cmux-codex-review"
[[ -x "$BIN" ]] || { echo "FAIL: bin が見つからない/実行不可: $BIN"; exit 2; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"

# stub cmux: new-split は surface を返し（SPLIT_LOG があれば呼び出しを記録）、send は送信文字列を記録
cat > "$TMP/bin/cmux" <<'STUB'
#!/usr/bin/env bash
if [[ "$1" == "new-split" ]]; then
  echo "split" >> "${SPLIT_LOG:-/dev/null}"
  echo "OK surface:31 workspace:9"; exit 0
fi
if [[ "$1" == "send" ]]; then printf '%s' "$4" > "$SENT_CMD"; exit 0; fi
STUB
chmod +x "$TMP/bin/cmux"

# stub codex: 受け取った引数の数と最後の引数(prompt)を記録
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

# 送信された CMD をペインのシェルとして再パースし、codex が受け取る argc / prompt を得る
reparse() { env PATH="$TMP/bin:$PATH" CODEX_ARGC="$TMP/argc" CODEX_PROMPT="$TMP/prompt" bash -c "$(cat "$SENT_CMD")"; }
argc() { cat "$TMP/argc" 2>/dev/null || echo "?"; }
prompt() { cat "$TMP/prompt" 2>/dev/null || echo ""; }

# --- D1: sandbox は workspace-write（read-only への逆戻りを禁止） ---
CMUX_BIN="$TMP/bin/cmux" "$BIN" >/dev/null 2>&1
if grep -q -- '--sandbox workspace-write' "$SENT_CMD" && ! grep -q -- '--sandbox read-only' "$SENT_CMD"; then
  echo "PASS D1: sandbox=workspace-write"
else
  echo "FAIL D1: sandbox が workspace-write でない → codex が完了通知の send.sh を撃てず親が wake しない"
  grep -o -- '--sandbox [a-z-]*' "$SENT_CMD"
  fail=1
fi

# --- D5: approval policy は never（承認プロンプトで停止させない） ---
CMUX_BIN="$TMP/bin/cmux" "$BIN" >/dev/null 2>&1
if grep -q -- '--ask-for-approval never' "$SENT_CMD"; then
  echo "PASS D5: approval policy=never"
else
  echo "FAIL D5: --ask-for-approval never が無い → codex が承認プロンプトで停止する"
  fail=1
fi

# --- D3 + D4: 通知配線なし（後方互換）。send.sh を注入せず、prompt は 1 引数 ---
CMUX_BIN="$TMP/bin/cmux" "$BIN" >/dev/null 2>&1
reparse
if [[ "$(argc)" == "9" ]] && ! prompt | grep -q 'send.sh' && prompt | grep -q 'レビュー'; then
  echo "PASS D3: 通知引数なし → send.sh 非注入、argc=9"
else
  echo "FAIL D3: argc=$(argc) / prompt=[$(prompt)]"
  fail=1
fi

# --- D2 + D4: 通知配線あり。send.sh と token が丸ごと届き、prompt は 1 引数 ---
out=$(CMUX_BIN="$TMP/bin/cmux" "$BIN" --team t --reviewer cxrev-review --parent parent 2>&1)
reparse
if [[ "$(argc)" == "9" ]] \
  && prompt | grep -q "send.sh t cxrev-review parent" \
  && prompt | grep -q "DONE codex-review-31" \
  && printf '%s' "$out" | grep -q "token=codex-review-31"; then
  echo "PASS D2: 通知配線 → send.sh + token が prompt に無傷で到達、argc=9"
else
  echo "FAIL D2: argc=$(argc) / prompt=[$(prompt)]"
  fail=1
fi

# --- 対象切替: --base がレビュー指示に反映される ---
CMUX_BIN="$TMP/bin/cmux" "$BIN" --base main >/dev/null 2>&1
reparse
if prompt | grep -q "main"; then
  echo "PASS: --base main が prompt に反映"
else
  echo "FAIL: --base main が prompt に無い / prompt=[$(prompt)]"
  fail=1
fi

# --- D6: --path 指定 → ファイル全文レビュー指示になり、prompt は 1 引数 ---
echo "spec body" > "$TMP/a-design.md"
echo "plan body" > "$TMP/b-plan.md"
CMUX_BIN="$TMP/bin/cmux" "$BIN" --path "$TMP/a-design.md" --path "$TMP/b-plan.md" >/dev/null 2>&1
reparse
if [[ "$(argc)" == "9" ]] \
  && prompt | grep -q "$TMP/a-design.md" \
  && prompt | grep -q "$TMP/b-plan.md" \
  && prompt | grep -q "読み"; then
  echo "PASS D6: --path 2 件が prompt に無傷で到達、argc=9"
else
  echo "FAIL D6: argc=$(argc) / prompt=[$(prompt)]"
  fail=1
fi

# --- D7: 存在しない --path は非ゼロ終了し、ペインを分割しない ---
rm -f "$TMP/split.log"
if ! SPLIT_LOG="$TMP/split.log" CMUX_BIN="$TMP/bin/cmux" "$BIN" --path "$TMP/does-not-exist.md" >/dev/null 2>&1 \
  && [[ ! -f "$TMP/split.log" ]]; then
  echo "PASS D7: 存在しない --path を拒否し、ペインを分割しない"
else
  echo "FAIL D7: 存在しないパスでペイン分割 or 正常終了した"
  fail=1
fi

# --- D8: --list-targets は cmux 無し・CMUX_SOCKET_PATH 無しで候補を TSV 出力する ---
REPO="$TMP/repo"
mkdir -p "$REPO/docs/superpowers/specs" "$REPO/docs/superpowers/plans"
git -C "$REPO" init -q >/dev/null 2>&1
git -C "$REPO" config user.email tester@example.com
git -C "$REPO" config user.name tester
echo "spec body" > "$REPO/docs/superpowers/specs/2026-01-01-a-design.md"
git -C "$REPO" add -A >/dev/null 2>&1
git -C "$REPO" commit -qm init >/dev/null 2>&1
echo "plan body" > "$REPO/docs/superpowers/plans/2026-01-02-b-plan.md"
lt=$(cd "$REPO" && env -u CMUX_SOCKET_PATH CMUX_BIN=/nonexistent/cmux "$BIN" --list-targets 2>&1)
if printf '%s\n' "$lt" | grep -q "^target.*uncommitted" \
  && printf '%s\n' "$lt" | grep -q "specs/2026-01-01-a-design.md.*spec / committed" \
  && printf '%s\n' "$lt" | grep -q "plans/2026-01-02-b-plan.md.*plan / untracked"; then
  echo "PASS D8: --list-targets が cmux 無しで候補を列挙"
else
  echo "FAIL D8: [$lt]"
  fail=1
fi

# --- D9: 候補ゼロ（git リポジトリ外）でも空出力・終了コード 0 で終わる ---
NOGIT=$(mktemp -d)
lt9=$(cd "$NOGIT" && env -u CMUX_SOCKET_PATH CMUX_BIN=/nonexistent/cmux "$BIN" --list-targets 2>&1)
rc9=$?
rm -rf "$NOGIT"
if [[ $rc9 -eq 0 && -z "$lt9" ]]; then
  echo "PASS D9: git リポジトリ外でも --list-targets が空出力・終了コード 0"
else
  echo "FAIL D9: rc=$rc9 / lt=[$lt9]"
  fail=1
fi

# --- 入力検証: -m/-e に危険な文字を渡すと拒否される ---
if ! CMUX_BIN="$TMP/bin/cmux" "$BIN" -e 'x";touch /tmp/PWNED_TEST;"' >/dev/null 2>&1 && [[ ! -f /tmp/PWNED_TEST ]]; then
  echo "PASS: --effort の不正な値を拒否"
else
  echo "FAIL: --effort の検証が効いていない"
  rm -f /tmp/PWNED_TEST
  fail=1
fi

# --- D10: 既定で並列実行ディレクティブが入り、prompt は 1 引数のまま ---
CMUX_BIN="$TMP/bin/cmux" "$BIN" >/dev/null 2>&1
reparse
if [[ "$(argc)" == "9" ]] \
  && prompt | grep -q 'spawn_agent' \
  && prompt | grep -q 'wait_agent' \
  && prompt | grep -q '最大 4 体'; then
  echo "PASS D10: 既定で並列実行ディレクティブが prompt に入る、argc=9"
else
  echo "FAIL D10: argc=$(argc) / prompt=[$(prompt)]"
  fail=1
fi

# --- D11: --no-parallel でディレクティブを注入しない ---
CMUX_BIN="$TMP/bin/cmux" "$BIN" --no-parallel >/dev/null 2>&1
reparse
if [[ "$(argc)" == "9" ]] && ! prompt | grep -q 'spawn_agent'; then
  echo "PASS D11: --no-parallel でディレクティブ非注入、argc=9"
else
  echo "FAIL D11: argc=$(argc) / prompt=[$(prompt)]"
  fail=1
fi

# --- D12: .codex/agents/*.toml があれば agent_type 候補が載る / 無ければフォールバック文言 ---
AGENTREPO="$TMP/agentrepo"
mkdir -p "$AGENTREPO/.codex/agents"
cat > "$AGENTREPO/.codex/agents/my-reviewer.toml" <<'TOML'
description = "Reviews backend code"
developer_instructions = """
body
"""
TOML
(cd "$AGENTREPO" && CMUX_BIN="$TMP/bin/cmux" "$BIN" >/dev/null 2>&1)
reparse
has_type=0
prompt | grep -q 'my-reviewer — Reviews backend code' && has_type=1

NOAGENT=$(mktemp -d)
(cd "$NOAGENT" && CMUX_BIN="$TMP/bin/cmux" "$BIN" >/dev/null 2>&1)
reparse
has_fallback=0
prompt | grep -q 'agent_type の定義が無い' && has_fallback=1
rm -rf "$NOAGENT"

if [[ $has_type -eq 1 && $has_fallback -eq 1 ]]; then
  echo "PASS D12: agent_type 候補の列挙とフォールバック文言が切り替わる"
else
  echo "FAIL D12: has_type=$has_type / has_fallback=$has_fallback"
  fail=1
fi

# --- D13: description に ' が含まれても prompt は 1 引数のまま ---
cat > "$AGENTREPO/.codex/agents/quoter.toml" <<'TOML'
description = "It's a quality checker"
TOML
(cd "$AGENTREPO" && CMUX_BIN="$TMP/bin/cmux" "$BIN" >/dev/null 2>&1)
reparse
if [[ "$(argc)" == "9" ]] && prompt | grep -q "It's a quality checker"; then
  echo "PASS D13: description の ' がエスケープされ、argc=9 のまま"
else
  echo "FAIL D13: argc=$(argc) / prompt=[$(prompt)]"
  fail=1
fi

# --- D14: 通知配線時、send.sh の本文に agents= が入る / --no-parallel では入らない ---
CMUX_BIN="$TMP/bin/cmux" "$BIN" --team t --reviewer cxrev-review --parent parent >/dev/null 2>&1
reparse
with_agents=0
prompt | grep -q 'レビュー完了 agents=' && prompt | grep -q 'spawn した子エージェントの総数' && with_agents=1

CMUX_BIN="$TMP/bin/cmux" "$BIN" --no-parallel --team t --reviewer cxrev-review --parent parent >/dev/null 2>&1
reparse
without_agents=0
prompt | grep -q 'レビュー完了' && ! prompt | grep -q 'agents=' && without_agents=1

if [[ $with_agents -eq 1 && $without_agents -eq 1 ]]; then
  echo "PASS D14: 通知本文の agents= が並列有無で切り替わる"
else
  echo "FAIL D14: with=$with_agents / without=$without_agents"
  fail=1
fi

# --- D15: --agents の不正値は非ゼロ終了し、ペインを分割しない ---
rm -f "$TMP/split.log"
bad=0
SPLIT_LOG="$TMP/split.log" CMUX_BIN="$TMP/bin/cmux" "$BIN" --agents 9 >/dev/null 2>&1 && bad=1
SPLIT_LOG="$TMP/split.log" CMUX_BIN="$TMP/bin/cmux" "$BIN" --agents abc >/dev/null 2>&1 && bad=1
if [[ $bad -eq 0 && ! -f "$TMP/split.log" ]]; then
  echo "PASS D15: --agents の不正値を拒否し、ペインを分割しない"
else
  echo "FAIL D15: bad=$bad / split.log=$( [[ -f "$TMP/split.log" ]] && echo exists || echo none )"
  fail=1
fi

[[ $fail -eq 0 ]] && echo "--- すべて PASS ---" || echo "--- FAIL あり ---"
exit $fail
