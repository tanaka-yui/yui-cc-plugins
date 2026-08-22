#!/usr/bin/env bash
# execute モードの「成功パスの完了報告」の回帰テスト。
#
# 守っている不変条件:
#   EC1. execute の inner prompt に report-status.sh の呼び出しが含まれる
#        (成功時に status.json を終端へ遷移させるのは子の責務。wrapper の exit
#         経路だけに頼ると、セッションが終了しない engine で status が
#         executing のまま固まり親に通知が届かない)
#   EC2. codex 向けの終了指示が「自分でセッションを終わらせろ」という実行不能な
#        要求を含まない (codex に /exit 相当は無く、quit/shutdown サブコマンドも
#        無いため、モデルには実行手段が存在しない)
#   EC3. 追加した文言に ' " ` ! \ が混入しない (inner prompt は
#        zsh -ic "... '<prompt>' ..." の内側に素で置かれる)
#   EC4. report-status.sh は既存の workspace_id / surface_id / pr_url を保存する
#
# 背景: codex 実装ペインが終了指示に従わず idle 残留し、spawn 経路では
# status.json が executing のまま親が永久に待つ事故があった。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_SCRIPTS="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts"
LAUNCH="$SKILL_SCRIPTS/launch-workspace.sh"
REPORT="$SKILL_SCRIPTS/report-status.sh"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/repo" "$TMP/status"

# agmsg send.sh の stub。--status-dir を渡す launch は agmsg 識別子を要求するので
# (配送は agmsg send.sh の 1 本だけで、タイプ入力への fallback が無い)、
# 実体の存在チェックを通すためにこれを AGMSG_SEND として export する。
mkdir -p "$TMP/bin"
printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/bin/agmsg-send.sh"
chmod +x "$TMP/bin/agmsg-send.sh"
export AGMSG_SEND="$TMP/bin/agmsg-send.sh"
git -C "$TMP/repo" init -q
git -C "$TMP/repo" config user.email test@example.invalid
git -C "$TMP/repo" config user.name test
touch "$TMP/repo/.gitkeep"
git -C "$TMP/repo" add .gitkeep
git -C "$TMP/repo" commit -qm init
echo "plan" > "$TMP/plan.md"

cat > "$TMP/bin/cmux" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  list-workspaces) ;;
  new-workspace) echo 'workspace:1' ;;
  list-pane-surfaces) echo 'surface:2' ;;
  rename-workspace|rename-tab|notify|send|send-key|wait-for|identify) ;;
  *) echo "unexpected cmux command: $*" >&2; exit 1 ;;
esac
STUB
chmod +x "$TMP/bin/cmux"

cat > "$TMP/runners.json" <<'JSON'
{
  "default": "codex",
  "runners": [
    { "name": "codex", "command": "codex", "engine": "codex" },
    { "name": "claude", "command": "claude", "engine": "claude" }
  ]
}
JSON

fail=0

runner_for() {
  local runner="$1" name="$2"
  CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" bash "$LAUNCH" \
    --cwd "$TMP/repo" --mode execute --runner "$runner" --plan-file "$TMP/plan.md" \
    --agmsg-team demo-team --agmsg-from "$name" \
    --status-dir "$TMP/status" --no-parallel "$name" 2>/dev/null \
    | jq -r '.runner_file'
}

codex_runner=$(runner_for codex ec-codex)
claude_runner=$(runner_for claude ec-claude)

# --- EC1: 両 engine の inner prompt に report-status.sh の呼び出しがある ---
ec1=1
for f in "$codex_runner" "$claude_runner"; do
  if [[ -z "$f" || ! -f "$f" ]]; then
    echo "  runner script が生成されていない: $f"; ec1=0; continue
  fi
  grep -Fq 'report-status.sh' "$f" || { echo "  report-status.sh の呼び出しが無い: $(basename "$f")"; ec1=0; }
done
if [[ $ec1 -eq 1 ]]; then
  echo "PASS EC1: execute の inner prompt に report-status.sh の呼び出しがある"
else
  echo "FAIL EC1: 成功パスの完了報告が子に指示されていない"; fail=1
fi

# --- EC2: codex に実行不能な自己終了要求を出していない ---
if [[ -f "$codex_runner" ]] && grep -Fq 'end this codex session' "$codex_runner"; then
  echo "FAIL EC2: codex に実行不能な自己終了要求が残っている"; fail=1
else
  echo "PASS EC2: codex 向けに実行不能な自己終了要求を出していない"
fi

# --- EC3: 追加文言に禁止文字が混入しない ---
ec3=1
for f in "$codex_runner" "$claude_runner"; do
  [[ -f "$f" ]] || continue
  seg=$(grep -o 'MANDATORY COMPLETION REPORT.*do not skip it\.' "$f" | head -1)
  if [[ -z "$seg" ]]; then
    echo "  完了報告の文面を抽出できない: $(basename "$f")"; ec3=0; continue
  fi
  case "$seg" in
    *\'*|*\"*|*\`*|*'!'*|*\\*)
      echo "  禁止文字が混入: $(basename "$f")"; ec3=0 ;;
  esac
done
if [[ $ec3 -eq 1 ]]; then
  echo "PASS EC3: 完了報告の文面に禁止文字が混入しない"
else
  echo "FAIL EC3: 禁止文字が混入している"; fail=1
fi

# --- EC4: report-status.sh は既存フィールドを保存する ---
if [[ ! -f "$REPORT" ]]; then
  echo "FAIL EC4: report-status.sh が存在しない"; fail=1
else
  cat > "$TMP/status/status.json" <<'JSON'
{"status":"executing","workspace_id":"workspace:9","surface_id":"surface:9","pr_url":"https://example.invalid/pr/1","message":"before","timestamp":"2026-01-01T00:00:00Z"}
JSON
  bash "$REPORT" "$TMP/status" done finished the work >/dev/null 2>&1
  got=$(jq -r '[.status, .workspace_id, .surface_id, .pr_url, .message] | @tsv' "$TMP/status/status.json" 2>/dev/null)
  want=$(printf 'done\tworkspace:9\tsurface:9\thttps://example.invalid/pr/1\tfinished the work')
  if [[ "$got" == "$want" ]]; then
    echo "PASS EC4: report-status.sh は既存フィールドを保存して status を更新する"
  else
    echo "FAIL EC4: got=[$got] want=[$want]"; fail=1
  fi
fi

exit $fail
