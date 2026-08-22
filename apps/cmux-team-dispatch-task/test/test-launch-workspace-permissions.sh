#!/usr/bin/env bash
# launch-workspace.sh が claude engine の worktree に注入する
# .claude/settings.local.json の permissions.defaultMode の回帰テスト。
# 検証項目: 全 MODE への注入 / codex engine 非対象 / 既存キー保持 / 冪等性 /
# 正常系では superpowers にフラグを足さないこと / info/exclude の追記 /
# 注入を確認できなかったときの --dangerously-skip-permissions へのフォールバック
# (3 ケース A・B・C、二重付与なし、正常系で誤発火しないこと、review 単独の *) 分岐) /
# 警告ログ値のサニタイズ (P26 / P26b、root では skip) /
# jq -e -s による複数 JSON ドキュメント連結の誤判定防止 (P28)。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCH="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/launch-workspace.sh"

TMP=$(mktemp -d)
trap 'chmod -R u+w "$TMP" 2>/dev/null || true; rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"

# agmsg send.sh の stub。--status-dir を渡す launch は agmsg 識別子を要求するので
# (配送は agmsg send.sh の 1 本だけで、タイプ入力への fallback が無い)、
# 実体の存在チェックを通すためにこれを AGMSG_SEND として export する。
mkdir -p "$TMP/bin"
printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/bin/agmsg-send.sh"
chmod +x "$TMP/bin/agmsg-send.sh"
export AGMSG_SEND="$TMP/bin/agmsg-send.sh"

cat > "$TMP/bin/cmux" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  list-workspaces) ;;
  new-workspace) echo 'workspace:1' ;;
  list-pane-surfaces) echo 'surface:2' ;;
  new-split) echo 'surface:3' ;;
  rename-workspace|rename-tab|notify|send|send-key|wait-for|identify) ;;
  *) echo "unexpected cmux command: $*" >&2; exit 1 ;;
esac
STUB
chmod +x "$TMP/bin/cmux"

cat > "$TMP/runners.json" <<'JSON'
{
  "default": "claude",
  "runners": [
    { "name": "claude", "command": "claude", "engine": "claude" },
    { "name": "codex", "command": "codex", "engine": "codex" }
  ]
}
JSON

fail=0

pass() { echo "PASS: $1"; }
bad()  { echo "FAIL: $1"; fail=1; }

new_repo() {
  local name="$1"
  local dir="$TMP/repo-$name"
  mkdir -p "$dir"
  git -C "$dir" init -q
  git -C "$dir" config user.email test@example.invalid
  git -C "$dir" config user.name test
  touch "$dir/.gitkeep"
  git -C "$dir" add .gitkeep
  git -C "$dir" commit -qm init
  echo "$dir"
}

run_launch() {
  CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" \
    bash "$LAUNCH" --agmsg-team demo-team --agmsg-from perm-probe "$@"
}

settings_of() { echo "$1/.claude/settings.local.json"; }

default_mode_of() {
  jq -r '.permissions.defaultMode // ""' "$(settings_of "$1")" 2>/dev/null || echo ""
}

WARN_NOT_CONFIRMED='permission bypass not confirmed'
WARN_FLAG_ADDED='added the CLI permission flag'

# composed command は runner script の単一行に載るので grep -c (行数) では二重付与を
# 検出できない。set -euo pipefail 下で 0 件を数えると落ちるので || true が要る。
# ファイル不在で 0 を返すと否定側が空虚に PASS するため、存在確認を先に置く。
# 戻り値は必ず文字列で比較すること (( )) に渡すと missing:... が unbound variable になる。
count_flag() {
  [[ -f "${1:-}" ]] || { echo "missing:${1:-<none>}"; return; }
  # 空白でトークン分割し、各トークンが (末尾の閉じ引用符を除いて) フラグと完全一致するかで
  # 数える。部分文字列一致では語境界を見ないので、直前の値 (--effort 'high' 等) と結合して
  # フラグが実質消えるタイポ (例: 先頭空白の欠落) を見逃す。かといって grep -o の非重複マッチで
  # 語境界だけを見ると、空白 1 個で隣接する二重付与 (5 箇所の splice はすべて無区切りで
  # 連結するため、実際の二重付与は必ずこの形になる) が境界文字を消費し合って 1 個と
  # 数えられてしまう。トークン化 + 完全一致ならどちらも正しく数える。
  { tr -s '[:space:]' '\n' < "$1" | grep -c -x -E -- '--dangerously-skip-permissions"?' || true; } \
    | tr -d ' '
}

# 既存の run_launch は stderr を捨てるので、警告を assert するケース用に別に用意する。
# 素朴に 2>&1 でマージすると stdout 先頭に [runner] が混ざり jq -r '.runner_file' が壊れる。
run_launch_err() {   # $1 = stderr の保存先, 以降 launch の引数
  local err="$1"; shift
  CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" \
    bash "$LAUNCH" --agmsg-team demo-team --agmsg-from perm-probe "$@" 2> "$err"
}

# 注入不能状態を作る 3 つのレシピ。いずれも chmod と違って root でも成立する。
break_a() { rm -rf "$1/.claude"; printf '' > "$1/.claude"; }                       # .claude が通常ファイル
break_b() { mkdir -p "$1/.claude"; printf '{ not json,,,\n' > "$1/.claude/settings.local.json"; }
break_c() { mkdir -p "$1/.claude/settings.local.json"; }                            # settings がディレクトリ

# 1 行に制御文字が含まれないことの macOS 可搬なアサート
has_no_ctrl() {
  [[ "$(printf '%s' "$1" | LC_ALL=C tr -d '\000-\037\177')" == "$1" ]]
}

# --- P1: claude engine + superpowers ---
repo=$(new_repo p1)
run_launch --cwd "$repo" --mode superpowers --runner claude \
  --status-dir "$TMP/status-p1" p1-task 'do something' >/dev/null
[[ "$(default_mode_of "$repo")" == "bypassPermissions" ]] \
  && pass 'P1 superpowers injects defaultMode=bypassPermissions' \
  || bad  'P1 superpowers injects defaultMode=bypassPermissions'

# --- P2: claude engine + plan で ExitPlanMode hook と共存する ---
repo=$(new_repo p2)
run_launch --cwd "$repo" --mode plan --runner claude \
  --status-dir "$TMP/status-p2" p2-task 'do something' >/dev/null
[[ "$(default_mode_of "$repo")" == "bypassPermissions" ]] \
  && pass 'P2a plan injects defaultMode' || bad 'P2a plan injects defaultMode'
if jq -e '.hooks.PostToolUse[] | select(.matcher == "ExitPlanMode")' \
     "$(settings_of "$repo")" >/dev/null 2>&1; then
  pass 'P2b plan keeps the ExitPlanMode hook'
else
  bad 'P2b plan keeps the ExitPlanMode hook'
fi

# --- P3: codex engine は注入しない ---
repo=$(new_repo p3)
run_launch --cwd "$repo" --mode superpowers --runner codex \
  --status-dir "$TMP/status-p3" p3-task 'do something' >/dev/null
[[ ! -f "$(settings_of "$repo")" ]] \
  && pass 'P3 codex engine writes no settings.local.json' \
  || bad  'P3 codex engine writes no settings.local.json'

# --- P4: 既存キーが保持される ---
repo=$(new_repo p4)
mkdir -p "$repo/.claude"
cat > "$(settings_of "$repo")" <<'JSON'
{ "env": { "FOO": "bar" }, "permissions": { "allow": ["Bash(ls:*)"] } }
JSON
run_launch --cwd "$repo" --mode superpowers --runner claude \
  --status-dir "$TMP/status-p4" p4-task 'do something' >/dev/null
if [[ "$(jq -r '.env.FOO' "$(settings_of "$repo")")" == "bar" \
   && "$(jq -r '.permissions.allow[0]' "$(settings_of "$repo")")" == "Bash(ls:*)" \
   && "$(default_mode_of "$repo")" == "bypassPermissions" ]]; then
  pass 'P4 existing keys survive the merge'
else
  bad 'P4 existing keys survive the merge'
fi

# --- P5: 冪等 (同じ worktree に 2 回実行しても内容が変わらない) ---
repo=$(new_repo p5)
run_launch --cwd "$repo" --mode superpowers --runner claude \
  --status-dir "$TMP/status-p5" p5-task 'do something' >/dev/null
first=$(cat "$(settings_of "$repo")" 2>/dev/null || echo '<missing>')
run_launch --cwd "$repo" --mode standby --runner claude \
  --status-dir "$TMP/status-p5" p5-standby >/dev/null
second=$(cat "$(settings_of "$repo")" 2>/dev/null || echo '<missing>')
if [[ "$first" == "$second" && "$first" != '<missing>' ]]; then
  pass 'P5 second launch is idempotent'
else
  bad 'P5 second launch is idempotent'
fi

# --- P6: superpowers に --dangerously-skip-permissions を足していない ---
repo=$(new_repo p6)
out=$(run_launch --cwd "$repo" --mode superpowers --runner claude \
  --status-dir "$TMP/status-p6" p6-task 'do something')
runner_file=$(jq -r '.runner_file' <<<"$out")
[[ "$(count_flag "$runner_file")" == "0" ]] \
  && pass 'P6 superpowers must not gain --dangerously-skip-permissions' \
  || bad  'P6 superpowers must not gain --dangerously-skip-permissions'

# --- P7: superpowers でも info/exclude に追記される ---
repo=$(new_repo p7)
run_launch --cwd "$repo" --mode superpowers --runner claude \
  --status-dir "$TMP/status-p7" p7-task 'do something' >/dev/null
exclude=$(git -C "$repo" rev-parse --path-format=absolute --git-path info/exclude)
if grep -qxF '.claude/settings.local.json' "$exclude" \
   && grep -qxF '.claude/plans/' "$exclude"; then
  pass 'P7 info/exclude gains both entries in superpowers mode'
else
  bad 'P7 info/exclude gains both entries in superpowers mode'
fi

# --- P8: execute モード ---
repo=$(new_repo p8)
run_launch --cwd "$repo" --mode execute --runner claude \
  --plan-file "$TMP/plan.md" --status-dir "$TMP/status-p8" p8-task >/dev/null
[[ "$(default_mode_of "$repo")" == "bypassPermissions" ]] \
  && pass 'P8 execute injects defaultMode' || bad 'P8 execute injects defaultMode'

# --- P9: standby + --skip-permissions (sonnet standby 相当) はフラグと共存する ---
repo=$(new_repo p9)
out=$(run_launch --cwd "$repo" --mode standby --runner claude \
  --model sonnet --skip-permissions --status-dir "$TMP/status-p9" p9-standby)
runner_file=$(jq -r '.runner_file' <<<"$out")
if [[ "$(default_mode_of "$repo")" == "bypassPermissions" ]] \
   && grep -Fq -- '--dangerously-skip-permissions' "$runner_file"; then
  pass 'P9 standby keeps the flag and gains the settings injection'
else
  bad 'P9 standby keeps the flag and gains the settings injection'
fi

# --- P10: review モード ---
repo=$(new_repo p10)
run_launch --cwd "$repo" --mode review --runner claude \
  --status-dir "$TMP/status-p10" p10-review >/dev/null
[[ "$(default_mode_of "$repo")" == "bypassPermissions" ]] \
  && pass 'P10 review injects defaultMode' || bad 'P10 review injects defaultMode'

# --- P11: info/exclude を解決できない cwd (非 git) でも launch が成功する ---
plain="$TMP/plain-dir"
mkdir -p "$plain"
if run_launch --cwd "$plain" --mode superpowers --runner claude \
     --status-dir "$TMP/status-p11" p11-task 'do something' >/dev/null 2>&1; then
  if [[ "$(default_mode_of "$plain")" == "bypassPermissions" ]]; then
    pass 'P11 non-git cwd still launches and gets the injection'
  else
    bad 'P11 non-git cwd still launches and gets the injection'
  fi
else
  bad 'P11 non-git cwd must not abort the launch'
fi

# --- P12: standby (prompt 引数あり) + 注入不能 A ---
# prewarm の設計ペインは "$SLUG" "$OPUS_PROMPT" の 2 位置引数で起動するので prompt 有りの
# 合成行を通る。prompt 無しのケースだけではこの行の splice 忘れを 1 件も検出できない。
repo=$(new_repo p12); break_a "$repo"
out=$(run_launch_err "$TMP/err-p12" --cwd "$repo" --mode standby --role design --runner claude \
  --status-dir "$TMP/status-p12" p12-standby 'agmsg actas p12 then wait idle')
runner_file=$(jq -r '.runner_file' <<<"$out")
if [[ "$(count_flag "$runner_file")" == "1" ]] \
   && grep -Fq -- "$WARN_FLAG_ADDED" "$TMP/err-p12" \
   && ! grep -Fq -- '--dangerously-skip-permissions' "$TMP/err-p12"; then
  pass 'P12 standby with prompt gains exactly one flag and logs the add'
else
  bad  'P12 standby with prompt gains exactly one flag and logs the add'
fi

# --- P13: superpowers + 注入不能 A ---
repo=$(new_repo p13); break_a "$repo"
out=$(run_launch --cwd "$repo" --mode superpowers --runner claude \
  --status-dir "$TMP/status-p13" p13-task 'do something')
[[ "$(count_flag "$(jq -r '.runner_file' <<<"$out")")" == "1" ]] \
  && pass 'P13 superpowers gains the fallback flag' \
  || bad  'P13 superpowers gains the fallback flag'

# --- P14: superpowers + 注入不能 A + --skip-permissions 明示 ---
# superpowers の合成箇所は SKIP_PERMISSIONS を読まないので、フォールバックは
# その値に関わらず 1 個だけ付く。case の superpowers アームが *) に落ちると 0 個になる。
repo=$(new_repo p14); break_a "$repo"
out=$(run_launch --cwd "$repo" --mode superpowers --runner claude --skip-permissions \
  --status-dir "$TMP/status-p14" p14-task 'do something')
[[ "$(count_flag "$(jq -r '.runner_file' <<<"$out")")" == "1" ]] \
  && pass 'P14 superpowers ignores --skip-permissions but takes the fallback once' \
  || bad  'P14 superpowers ignores --skip-permissions but takes the fallback once'

# --- P15: superpowers 正常系 + --skip-permissions 明示 ---
repo=$(new_repo p15)
out=$(run_launch --cwd "$repo" --mode superpowers --runner claude --skip-permissions \
  --status-dir "$TMP/status-p15" p15-task 'do something')
[[ "$(count_flag "$(jq -r '.runner_file' <<<"$out")")" == "0" ]] \
  && pass 'P15 superpowers keeps no flag when the injection succeeded' \
  || bad  'P15 superpowers keeps no flag when the injection succeeded'

# --- P16: standby (prompt なし) + 注入不能 A + --skip-permissions 明示 ---
# 二重付与の検出。P23 の弱い版で独自の検出力は無く、PERM_FALLBACK_FLAG の
# standby/review (prompt 無し分岐) への splice も担保しない
# (SKIP_PERMISSIONS=1 なので *) アームが偽になり PERM_FALLBACK_FLAG は空のまま)。
repo=$(new_repo p16); break_a "$repo"
out=$(run_launch --cwd "$repo" --mode standby --runner claude --skip-permissions \
  --status-dir "$TMP/status-p16" p16-standby)
[[ "$(count_flag "$(jq -r '.runner_file' <<<"$out")")" == "1" ]] \
  && pass 'P16 standby with --skip-permissions never doubles the flag' \
  || bad  'P16 standby with --skip-permissions never doubles the flag'

# --- P17: plan + 注入不能 A ---
# plan) ;; の単独削除、および付与ログの無条件出力の 2 種を単独検出する唯一のケース。
# 「plan アームの CORE_CMD へ PERM_FALLBACK_FLAG を単体で splice する」変異は、
# plan) ;; が残っている限り PERM_FALLBACK_FLAG が plan では常に空なので原理的に
# 検出不能な等価変異であり、この 2 種には含まれない (P17 が実際に捕まえるのは
# plan) ;; 削除 + plan アームへの splice という二重違反の形)。stderr の否定 assert を
# 落とさないこと。
repo=$(new_repo p17); break_a "$repo"
out=$(run_launch_err "$TMP/err-p17" --cwd "$repo" --mode plan --runner claude \
  --status-dir "$TMP/status-p17" p17-task 'do something')
if [[ "$(count_flag "$(jq -r '.runner_file' <<<"$out")")" == "1" ]] \
   && ! grep -Fq -- "$WARN_FLAG_ADDED" "$TMP/err-p17"; then
  pass 'P17 plan keeps one literal flag and logs no add'
else
  bad  'P17 plan keeps one literal flag and logs no add'
fi

# --- P18: execute + 注入不能 A + --skip-permissions なし ---
repo=$(new_repo p18); break_a "$repo"
out=$(run_launch --cwd "$repo" --mode execute --runner claude \
  --plan-file "$TMP/plan.md" --status-dir "$TMP/status-p18" p18-task)
[[ "$(count_flag "$(jq -r '.runner_file' <<<"$out")")" == "1" ]] \
  && pass 'P18 execute gains the fallback flag' \
  || bad  'P18 execute gains the fallback flag'

# --- P19: codex engine ---
# フラグ側は判別能力を持たない (BYPASS_INJECTION_OK が 0 になるのは claude 限定ブロックの
# 内側だけ) が、併記する「新警告が出ない」の側は読み直しを claude ブロックの外へ動かした
# 実装を実際に検出する。両方を必ず assert すること。
repo=$(new_repo p19); break_a "$repo"
out=$(run_launch_err "$TMP/err-p19" --cwd "$repo" --mode superpowers --runner codex \
  --status-dir "$TMP/status-p19" p19-task 'do something')
if [[ "$(count_flag "$(jq -r '.runner_file' <<<"$out")")" == "0" ]] \
   && ! grep -Fq -- "$WARN_NOT_CONFIRMED" "$TMP/err-p19"; then
  pass 'P19 codex takes neither the fallback nor the warning'
else
  bad 'P19 codex takes neither the fallback nor the warning'
fi

# --- P20: 正常系で誤発火しない ---
# standby / review / execute は元からフラグを持つ経路があるため、読み直しが常に失敗する
# 実装バグ (パス誤りなど) が composed command に現れず不可視になりうる。ここが唯一の砦。
for m in standby superpowers; do
  repo=$(new_repo "p20-$m")
  if [[ "$m" == "superpowers" ]]; then
    out=$(run_launch_err "$TMP/err-p20-$m" --cwd "$repo" --mode "$m" --runner claude \
      --status-dir "$TMP/status-p20-$m" "p20-$m" 'do something')
  else
    out=$(run_launch_err "$TMP/err-p20-$m" --cwd "$repo" --mode "$m" --runner claude \
      --status-dir "$TMP/status-p20-$m" "p20-$m")
  fi
  if [[ "$(count_flag "$(jq -r '.runner_file' <<<"$out")")" == "0" ]] \
     && ! grep -Fq -- "$WARN_NOT_CONFIRMED" "$TMP/err-p20-$m"; then
    pass "P20 $m stays unchanged when the injection succeeded"
  else
    bad  "P20 $m stays unchanged when the injection succeeded"
  fi
done

# --- P21: standby (prompt なし・--skip-permissions なし) + 注入不能 B ---
# PERM_FALLBACK_FLAG の standby/review (prompt 無し分岐) への splice の担保者。
# B は既存ファイルが不正 JSON でマージが拒否されるケース。
repo=$(new_repo p21); break_b "$repo"
out=$(run_launch_err "$TMP/err-p21" --cwd "$repo" --mode standby --runner claude \
  --status-dir "$TMP/status-p21" p21-standby)
if [[ "$(count_flag "$(jq -r '.runner_file' <<<"$out")")" == "1" ]] \
   && grep -Fq -- "$WARN_NOT_CONFIRMED" "$TMP/err-p21" \
   && ! jq -e . "$(settings_of "$repo")" >/dev/null 2>&1; then
  pass 'P21 invalid JSON takes the fallback and is left untouched'
else
  bad 'P21 invalid JSON takes the fallback and is left untouched'
fi

# --- P22: worktree 再利用 (CURRENT_DEFAULT_MODE 一致による短絡経路) ---
# prewarm は全ペインに同一 --cwd を渡すので 2 枚目以降は必ずここを通る実運用の主経路。
repo=$(new_repo p22)
run_launch --cwd "$repo" --mode superpowers --runner claude \
  --status-dir "$TMP/status-p22" p22-first 'do something' >/dev/null
out=$(run_launch_err "$TMP/err-p22" --cwd "$repo" --mode standby --runner claude \
  --status-dir "$TMP/status-p22" p22-standby)
if [[ "$(count_flag "$(jq -r '.runner_file' <<<"$out")")" == "0" ]] \
   && ! grep -Fq -- "$WARN_NOT_CONFIRMED" "$TMP/err-p22" \
   && grep -Fq -- 'defaultMode is already bypassPermissions' "$TMP/err-p22"; then
  pass 'P22 worktree reuse short-circuits without firing the fallback'
else
  bad 'P22 worktree reuse short-circuits without firing the fallback'
fi

# --- P23: standby + --unattended + 注入不能 A ---
# PERM_FALLBACK_FLAG のブロックが UNATTENDED の SKIP_PERMISSIONS=1 より前に置かれると
# *) が足した後にもう 1 個足されて 2 個になる。ブロック位置の担保。
repo=$(new_repo p23); break_a "$repo"
out=$(run_launch --cwd "$repo" --mode standby --runner claude --unattended \
  --status-dir "$TMP/status-p23" p23-standby)
[[ "$(count_flag "$(jq -r '.runner_file' <<<"$out")")" == "1" ]] \
  && pass 'P23 --unattended never doubles the flag' \
  || bad  'P23 --unattended never doubles the flag'

# --- P24: standby (prompt なし・--skip-permissions なし) + 注入不能 C ---
# PERM_FALLBACK_FLAG の standby/review (prompt 無し分岐) への splice の担保者かつ、
# settings.local.json がディレクトリのまま残る (break_c) 唯一のケース。
# 「P22 があるから P24 は冗長」という判断でこの穴を復活させないこと。単独担保者の列挙は
# ケースを足すたびに腐るので、この説明では挙げない。
repo=$(new_repo p24); break_c "$repo"
out=$(run_launch_err "$TMP/err-p24" --cwd "$repo" --mode standby --runner claude \
  --status-dir "$TMP/status-p24" p24-standby)
if [[ "$(count_flag "$(jq -r '.runner_file' <<<"$out")")" == "1" ]] \
   && grep -Fq -- "$WARN_NOT_CONFIRMED" "$TMP/err-p24"; then
  pass 'P24 directory settings takes the fallback despite merge returning 0'
else
  bad 'P24 directory settings takes the fallback despite merge returning 0'
fi

# --- P25: 非 git --cwd + 注入不能 A ---
# flag oracle としては P13 の重複。残す意味は「非 git でも launch が rc=0 で続き、
# 異常系でもフラグが付くこと」= P11 の異常系版。
# P11 の $TMP/plain-dir を再利用しないこと (P11 が .claude をディレクトリとして残すので
# break_a の printf が Is a directory で落ち、set -euo pipefail 下でスイートが停止する)。
plain25="$TMP/plain-dir-p25"
mkdir -p "$plain25"; break_a "$plain25"
if out=$(run_launch --cwd "$plain25" --mode superpowers --runner claude \
     --status-dir "$TMP/status-p25" p25-task 'do something' 2>/dev/null); then
  [[ "$(count_flag "$(jq -r '.runner_file' <<<"$out")")" == "1" ]] \
    && pass 'P25 non-git cwd still launches and gains the fallback' \
    || bad  'P25 non-git cwd still launches and gains the fallback'
else
  bad 'P25 non-git cwd must not abort the launch'
fi

# --- P26 / P26b: 読めるが別値のケース (chmod が要るので root では skip) ---
# 到達には「有効な JSON が読めるのに書き込みは失敗する」状態が要り、それを作れるのは
# chmod a-w だけ。uid 0 はモードビットを無視して mktemp が成功し、ファイルが
# bypassPermissions に上書きされて全 assert が落ちるため root では成立しない。
# 到達するのは merge_claude_settings の failed to create a temp file であって
# failed to create .../.claude ではない (既存ディレクトリへの mkdir -p は成功する)。
if [[ $EUID -eq 0 ]]; then
  echo 'SKIP: P26 / P26b need chmod a-w, which uid 0 ignores'
else
  # P26: ESC/OSC + 改行で偽の [permissions] injected 行を捏造しようとする payload。
  # 生の制御バイトを JSON に書くと jq が control characters must be escaped で失敗し、
  # 読み直しが "" を返して全アサーションが自明に PASS する。必ず \u エスケープで書く。
  repo=$(new_repo p26)
  mkdir -p "$repo/.claude"
  printf '%s' '{"permissions":{"defaultMode":"acceptEdits\u001b]0;PWNED\u0007\u000a[permissions] injected"}}' \
    > "$repo/.claude/settings.local.json"
  chmod a-w "$repo/.claude"
  out=$(run_launch_err "$TMP/err-p26" --cwd "$repo" --mode standby --runner claude \
    --status-dir "$TMP/status-p26" p26-standby)
  warn_line=$(grep -F -- "$WARN_NOT_CONFIRMED" "$TMP/err-p26" || true)
  # tr / grep は行単位なので改行の捏造は捕まえられない。警告が 1 行であることも見る。
  if [[ "$(count_flag "$(jq -r '.runner_file' <<<"$out")")" == "1" ]] \
     && [[ -n "$warn_line" ]] && has_no_ctrl "$warn_line" \
     && [[ "$(grep -ac "$WARN_NOT_CONFIRMED" "$TMP/err-p26" | tr -d ' ')" == "1" ]] \
     && ! grep -Fq -- '[permissions] injected' "$TMP/err-p26"; then
    pass 'P26 sanitizer strips control bytes and blocks the forged injected line'
  else
    bad 'P26 sanitizer strips control bytes and blocks the forged injected line'
  fi

  # P26b: サニタイズすると bypassPermissions へちょうど潰れる payload。
  # 判定をサニタイズ後の値で行う実装 (この設計が禁じている形) だけがここで落ちる。
  repo=$(new_repo p26b)
  mkdir -p "$repo/.claude"
  printf '%s' '{"permissions":{"defaultMode":"bypass\u001bPermissions"}}' \
    > "$repo/.claude/settings.local.json"
  chmod a-w "$repo/.claude"
  out=$(run_launch --cwd "$repo" --mode standby --runner claude \
    --status-dir "$TMP/status-p26b" p26b-standby)
  [[ "$(count_flag "$(jq -r '.runner_file' <<<"$out")")" == "1" ]] \
    && pass 'P26b a value that sanitizes to bypassPermissions still takes the fallback' \
    || bad  'P26b a value that sanitizes to bypassPermissions still takes the fallback'
fi

# --- P27: review + 注入不能 A + --skip-permissions なし ---
# launch-workspace.sh の case "$MODE" が *) を execute|standby のように MODE を列挙する形へ
# 書き換えられても検出できるよう、review 単独のケースを持つ。stderr も assert するのは、
# review 用に別アームを足してフラグは付けるがログは出さない形の退行も捕まえるため
# (P12 / P17 / P19 / P21 / P24 と同じ流儀)。
repo=$(new_repo p27); break_a "$repo"
out=$(run_launch_err "$TMP/err-p27" --cwd "$repo" --mode review --runner claude \
  --status-dir "$TMP/status-p27" p27-review)
if [[ "$(count_flag "$(jq -r '.runner_file' <<<"$out")")" == "1" ]] \
   && grep -Fq -- "$WARN_FLAG_ADDED" "$TMP/err-p27"; then
  pass 'P27 review gains the fallback flag and logs the add'
else
  bad  'P27 review gains the fallback flag and logs the add'
fi

# --- P28: settings.local.json が複数 JSON ドキュメントの連結 (jq -e -s の length == 1 の担保) ---
# .claude は書き込み可能なので merge_claude_settings は成功し、2 ドキュメントとも
# bypassPermissions へ上書きされる (先頭の acceptEdits はマージで消えるため fixture の
# 値そのものに判別力は無い)。それでもマージ後のファイルは依然 2 ドキュメントのままなので、
# 判定を落とすのは length == 1 の側である。chmod 不要なので root でも成立する。
repo=$(new_repo p28); mkdir -p "$repo/.claude"
printf '%s\n%s\n' '{"permissions":{"defaultMode":"acceptEdits"}}' \
                  '{"permissions":{"defaultMode":"bypassPermissions"}}' \
  > "$repo/.claude/settings.local.json"
out=$(run_launch_err "$TMP/err-p28" --cwd "$repo" --mode standby --runner claude \
  --status-dir "$TMP/status-p28" p28-standby)
if [[ "$(count_flag "$(jq -r '.runner_file' <<<"$out")")" == "1" ]] \
   && grep -Fq -- "$WARN_NOT_CONFIRMED" "$TMP/err-p28"; then
  pass 'P28 concatenated JSON documents take the fallback'
else
  bad  'P28 concatenated JSON documents take the fallback'
fi

# --- P29: review + 注入不能 A + --skip-permissions 明示 ---
# superpowers) アームを superpowers|review) に書き換えるミュータント (自然に起きうるスリップ)
# は review にも --skip-permissions の免除を誤って適用させ、二重付与になる。
repo=$(new_repo p29); break_a "$repo"
out=$(run_launch --cwd "$repo" --mode review --runner claude --skip-permissions \
  --status-dir "$TMP/status-p29" p29-review)
[[ "$(count_flag "$(jq -r '.runner_file' <<<"$out")")" == "1" ]] \
  && pass 'P29 review with --skip-permissions never doubles the flag' \
  || bad  'P29 review with --skip-permissions never doubles the flag'

# --- P30: 先頭 64 raw 文字が全部非英数の defaultMode (切り詰め順序の担保) ---
# サニタイズ先行へ戻すミュータントは全件素通りする。タイミング
# ではなく内容で判別する: 切り詰めが先なら先頭 64 文字 (すべて空白) だけがサニタイズに渡り
# 全滅して shown_len=0 になるが、サニタイズが先だと空白が全部落ちた後に残る
# "bypassPermissions" が truncate を素通りして shown_len=17 になる。
# 2 番目のドキュメントを裸の数値にすると jq が per-input エラーを出しつつ他の出力は
# 保持したまま終了コードだけ非 0 にするため、merge_claude_settings の merged 変数が
# 空になり (失敗として扱われ) 元のファイルが書き換えられずに残る。chmod は不要なので
# root でも成立する。
repo=$(new_repo p30); mkdir -p "$repo/.claude"
pad64=$(printf '%64s' '')
printf '{"permissions":{"defaultMode":"%sbypassPermissions"}}\n5\n' "$pad64" \
  > "$repo/.claude/settings.local.json"
out=$(run_launch_err "$TMP/err-p30" --cwd "$repo" --mode standby --runner claude \
  --status-dir "$TMP/status-p30" p30-standby)
if [[ "$(count_flag "$(jq -r '.runner_file' <<<"$out")")" == "1" ]] \
   && grep -Fq -- "defaultMode='' raw_len=81 shown_len=0" "$TMP/err-p30"; then
  pass 'P30 sanitizer runs after truncation, not before'
else
  bad  'P30 sanitizer runs after truncation, not before'
fi

[[ $fail -eq 0 ]] && echo '--- all tests passed ---' || echo '--- failures ---'
exit "$fail"
