#!/usr/bin/env bash
# --setup / --reset の doc 回帰テスト。
#
# 守っている不変条件:
#   SU1. SKILL.md がフラグ・委譲先・書き込みスクリプトを明記している
#   SU2. frontmatter の argument-hint に --setup と --reset がある
#   SU3. setup-mode.md が対象 3 種・書き込み先 2 レイヤー・役割キー 5 つを列挙している
#   SU4. setup-mode.md / setup-mode-ja.md に .dispatch/ の削除が現れない (reset は非破壊)
#   SU5. 原子的書き込みと未知キー保持の契約が書かれている (改行に強い平坦化で照合)
#   SU6. --setup / --reset が --loop と排他かつループ稼働中は拒否される
#   SU7. cleanup が .dispatch/config.json を残す (project config レイヤーの生存)
#   SU8. 英語 doc と日本語 doc の見出しが 1:1 で対応している
#   SU9. config-edit.sh が存在し実行可能で、usage を出せる
#   SU10. setup-mode.md が S3-M と選択肢生成規則を記載する
#   SU11. setup-mode.md が runners-edit.sh の契約を記載する
#   SU12. 候補プールの codex *_effort 行に max が無い（claude 行は max を持つ）
#   SU13. SKILL.md / guide-ja.md / README.md が両スクリプトを名指しする
#   SU14. runners-edit.sh の usage と doc の I/F が双方向で一致する
#   SU15. setup-mode-ja.md が S3-M の日本語 needle を持つ
#   SU16. setup-mode.md / setup-mode-ja.md が S7 の温存 3 文と呼び出し順を保つ

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SK="$SCRIPT_DIR/../skills/cmux-team-dispatch-task"
SKILL="$SK/SKILL.md"
SETUP_EN="$SK/references/setup-mode.md"
SETUP_JA="$SK/references/setup-mode-ja.md"
GUIDE="$SK/references/guide-ja.md"
EDIT="$SK/scripts/config-edit.sh"
REDIT="$SK/scripts/runners-edit.sh"
fail=0

bad() { echo "FAIL $1"; fail=1; }
ok() { echo "PASS $1"; }

for f in "$SKILL" "$SETUP_EN" "$SETUP_JA" "$GUIDE" "$EDIT" "$REDIT"; do
  [[ -f "$f" ]] || { echo "FAIL: 必須ファイルが無い: $f"; exit 2; }
done

need() {
  local file="$1" label="$2"; shift 2
  local needle miss=0
  for needle in "$@"; do
    grep -Fq -- "$needle" "$file" || { echo "  missing: $needle"; miss=1; }
  done
  if [[ $miss -eq 0 ]]; then ok "$label"; else bad "$label"; fi
}

# SU1
need "$SKILL" 'SU1: SKILL.md がフラグと委譲先を明記する' \
  '--setup' '--reset' 'references/setup-mode.md' 'scripts/config-edit.sh' \
  '## Setup Mode' '## Reset Mode'

# SU2
hint=$(grep -m1 '^argument-hint:' "$SKILL" || true)
if grep -Fq -- '--setup' <<<"$hint" && grep -Fq -- '--reset' <<<"$hint"; then
  ok 'SU2: argument-hint に --setup と --reset がある'
else
  bad "SU2: argument-hint (got: $hint)"
fi

# SU3
need "$SETUP_EN" 'SU3: setup-mode.md が対象・レイヤー・役割キーを列挙する' \
  '--reset runners' '--reset config' '--reset all' \
  '~/.claude/cmux-team-dispatch-task/config.json' '<repo>/.dispatch/config.json' \
  'runners.json' \
  'design_runner' 'review_runner' 'exec_choice' 'review_mode' 'prewarm'

# SU4: reset は .dispatch/ を消さない
for f in "$SETUP_EN" "$SETUP_JA"; do
  if grep -Eq 'rm -rf[[:space:]]+\.dispatch|find[[:space:]]+\.dispatch' "$f"; then
    bad "SU4: $(basename "$f") に .dispatch/ の削除が現れる"
  else
    ok "SU4: $(basename "$f") は .dispatch/ を削除しない"
  fi
done

# SU5: 改行に強い平坦化で契約を照合する
en_flat=$(tr '\n' ' ' < "$SETUP_EN" | tr -s ' ')
for needle in \
  'merges instead of replacing' \
  'shell_ready_ms' \
  'writer-specific' \
  'mktemp "$CONFIG.XXXXXX"' \
  'only when jq succeeded' \
  'single atomic move' \
  'Never hand-assemble a jq invocation'
do
  grep -Fq -- "$needle" <<<"$en_flat" || bad "SU5: 書き込み契約 ($needle)"
done
ok 'SU5: 原子的書き込みとマージの契約'

# 三値セマンティクス (固定値 / "ask" / キー削除)
for needle in 'a fixed value' 'the key absent' 'persistence options stay hidden'; do
  grep -Fq -- "$needle" <<<"$en_flat" || bad "SU5: 三値セマンティクス ($needle)"
done
ok 'SU5: 三値セマンティクスの明記'

# SU6: 排他とロック拒否
for needle in 'mutually exclusive' 'lock-check'; do
  grep -Fq -- "$needle" <<<"$en_flat" || bad "SU6: 排他/ロック ($needle)"
done
grep -Fq -- 'issue-fetch.sh --state-file .dispatch-loop/loop-state.json lock-check' "$SETUP_EN" \
  || bad 'SU6: preflight の lock-check コマンド'
skill_flat=$(tr '\n' ' ' < "$SKILL" | tr -s ' ')
grep -Fq -- 'mutually exclusive with `--loop`' <<<"$skill_flat" \
  || bad 'SU6: SKILL.md の --loop 排他'
grep -Fq -- 'never reach Step 1a' <<<"$skill_flat" \
  || bad 'SU6: SKILL.md がフラグをタスクとして扱わない旨'
ok 'SU6: 排他・ロック拒否・タスク誤認防止'

# SU7: cleanup が project config を残す
for f in "$SKILL" "$GUIDE"; do
  n=$(grep -Fc -- 'find .dispatch -mindepth 1 -maxdepth 1 ! -name config.json -exec rm -rf {} +' "$f" || true)
  if [[ "$n" -ge 2 ]]; then
    ok "SU7: $(basename "$f") の cleanup が config.json を残す ($n 箇所)"
  else
    bad "SU7: $(basename "$f") の cleanup 掃き出しが $n 箇所しかない (2 箇所必要)"
  fi
  grep -Eq '^[[:space:]]*rm -rf \.dispatch/[[:space:]]*$' "$f" \
    && bad "SU7: $(basename "$f") に素の rm -rf .dispatch/ が残っている"
done

# SU8: 英日の見出しが 1:1
en_headings=$(grep -c '^#\{1,3\} ' "$SETUP_EN")
ja_headings=$(grep -c '^#\{1,3\} ' "$SETUP_JA")
if [[ "$en_headings" == "$ja_headings" ]]; then
  ok "SU8: setup-mode の見出し数が一致する ($en_headings)"
else
  bad "SU8: 見出し数 en=$en_headings ja=$ja_headings"
fi
need "$GUIDE" 'SU8: guide-ja.md にセットアップ/リセットの節がある' \
  '## セットアップモード' '## リセットモード' 'setup-mode-ja.md'

# SU9: config-edit.sh が動く
out=$(bash "$EDIT" 2>&1); rc=$?
if [[ $rc -eq 2 ]] && grep -q 'Usage: config-edit.sh' <<<"$out"; then
  ok 'SU9: config-edit.sh が引数なしで usage を出して exit 2'
else
  bad "SU9: config-edit.sh の usage (rc=$rc)"
fi

# 平坦化テキスト。長い needle は doc の折り返しをまたぐので生ファイルでは一致しない。
# 行・行番号を要するアサーション（SU12 / SU14 逆方向 / SU15 の #### / SU16 の行順）だけは
# 生ファイルを使う。
ja_flat=$(tr '\n' ' ' < "$SETUP_JA" | tr -s ' ')

need_flat() {
  local hay="$1" label="$2"; shift 2
  local needle miss=0
  for needle in "$@"; do
    grep -Fq -- "$needle" <<<"$hay" || { echo "  missing: $needle"; miss=1; }
  done
  if [[ $miss -eq 0 ]]; then ok "$label"; else bad "$label"; fi
}

# SU10
need_flat "$en_flat" 'SU10: setup-mode.md が S3-M と選択肢生成規則を記載する' \
  'S3-M' \
  'plan_model' 'review_model' 'exec_model' 'plan_effort' 'review_effort' 'exec_effort' \
  "edit an existing runner's models and efforts" \
  'keep (' 'back to the default (' \
  'unset (not review-capable)' 'unset it (not review-capable)' \
  'no longer be chosen as the reviewer' \
  'it is the current review_runner' 'contains a single quote' \
  'gpt-5.6-sol' 'the role keys only' 'pick option 2 or 3 to reach them' \
  'mkdir -p .dispatch' 'shadows the global layer' \
  '[[:cntrl:]]' 'padded with whitespace' 'only through option 2'

# SU11
need_flat "$en_flat" 'SU11: setup-mode.md が runners-edit.sh の契約を記載する' \
  'runners-edit.sh' 'mktemp "$RUNNERS.XXXXXX"' \
  'exits 2 when the file is absent' 'First-run setup' \
  'runners-edit.sh takes --runners and --name, then one of --set / --unset (optionally with --dry-run), --get, or --show.' \
  'last-write-wins' 'replaces a symlink with a regular file'
# 改題そのもの。needle は I/F 段落が持つので、改題の有無とは独立してしまう。
su11h_pass=1
grep -Fq -- '## All field-level writes go through the edit scripts' "$SETUP_EN" \
  || { echo '  EN の改題後の見出しが無い'; su11h_pass=0; }
grep -Fq -- '## All writes go through `config-edit.sh`' "$SETUP_EN" \
  && { echo '  EN に旧見出しが残っている'; su11h_pass=0; }
if [[ $su11h_pass == 1 ]]; then ok 'SU11: setup-mode.md が改題されている'; else bad 'SU11: 改題'; fi

# SU12: codex の候補プール行に max が無い（正アンカー + 負アサーション + 正のコントロール）
CLAUDE_POOL='| claude `*_effort` | `max` / `xhigh` / `high` / `medium` / `low` |'
CODEX_POOL='| codex `*_effort` | `xhigh` / `high` / `medium` / `low` / `minimal` |'
su12_pass=1
for f in "$SETUP_EN" "$SETUP_JA"; do
  if [[ ! -r "$f" ]]; then echo "  unreadable: $f"; su12_pass=0; continue; fi
  n_codex=$(grep -Fc -- "$CODEX_POOL" "$f"); rc=$?
  if [[ $rc -ge 2 ]]; then echo "  grep error on $f"; su12_pass=0; continue; fi
  [[ "$n_codex" == 1 ]] || { echo "  codex pool row count=$n_codex in $(basename "$f")"; su12_pass=0; }
  grep -F -- "$CODEX_POOL" "$f" | grep -Fq -- 'max' && { echo "  max leaked into the codex pool row in $(basename "$f")"; su12_pass=0; }
  n_claude=$(grep -Fc -- "$CLAUDE_POOL" "$f"); rc=$?
  if [[ $rc -ge 2 ]]; then echo "  grep error on $f"; su12_pass=0; continue; fi
  [[ "$n_claude" == 1 ]] || { echo "  claude pool row count=$n_claude in $(basename "$f")"; su12_pass=0; }
  grep -F -- "$CLAUDE_POOL" "$f" | grep -Fq -- 'max' || { echo "  claude pool row lost max in $(basename "$f")"; su12_pass=0; }
done
if [[ $su12_pass == 1 ]]; then ok 'SU12: codex の候補プール行に max が無い（claude 行は max を持つ）'; else bad 'SU12'; fi

# SU14: runners-edit.sh が動き、usage の 7 フラグと doc の記述が双方向で一致する
su14_pass=1
[[ -x "$REDIT" ]] || { echo '  runners-edit.sh に実行ビットが無い'; su14_pass=0; }
usage=$(bash "$REDIT" 2>&1); rc=$?
[[ $rc -eq 2 ]] || { echo "  usage rc=$rc"; su14_pass=0; }
grep -q 'Usage: runners-edit.sh' <<<"$usage" || { echo '  usage 行が無い'; su14_pass=0; }
# 部分一致だと単数形タイポ --runner が --runners に当たって生存するので語境界を要求する
# 語境界が必須。--set は --setup に食われ（setup-mode.md に --setup が既に 7 箇所ある）、
# --runner は --runners に食われる。
for fl in --runners --name --set --unset --get --show --dry-run; do
  grep -Eq -- "(^|[^a-z-])${fl}([^a-z-]|\$)" <<<"$usage" || { echo "  usage に $fl が無い"; su14_pass=0; }
  grep -Eq -- "(^|[^a-z-])${fl}([^a-z-]|\$)" "$SETUP_EN" || { echo "  setup-mode.md に $fl が無い"; su14_pass=0; }
done
# 逆方向: code fence の内側にある runners-edit.sh 実行行（と \ 継続行）に、
# usage に無いフラグが現れない。fence の外（散文の対比行）は対象にしない
# — §3.1 は runners-edit.sh の I/F 段落を config-edit.sh の本文の後ろへ追記させるので、
#   「runners-edit.sh takes --runners where config-edit.sh takes --config」のような
#   対比行が書かれやすく、ファイル全体を走査すると正しい doc が誤 FAIL する。
doc_flags=$(awk '
  /^[[:space:]]*```/ { fence = !fence; inln = 0; next }
  !fence { next }
  /runners-edit\.sh/ { inln = 1 }
  inln { print }
  inln && !/\\$/ { inln = 0 }
' "$SETUP_EN" | grep -o -- '--[a-z][a-z-]*' | sort -u)
if [[ -z "$doc_flags" ]]; then
  echo '  code block 内に runners-edit.sh の実行行が無い（fail-open 禁止）'
  su14_pass=0
fi
for fl in $doc_flags; do
  grep -Eq -- "(^|[^a-z-])${fl}([^a-z-]|\$)" <<<"$usage" \
    || { echo "  doc の $fl が usage に無い"; su14_pass=0; }
done
if [[ $su14_pass == 1 ]]; then ok 'SU14: runners-edit.sh の usage と doc の I/F が双方向で一致'; else bad 'SU14'; fi

# SU15
need_flat "$ja_flat" 'SU15: setup-mode-ja.md が S3-M の日本語 needle を持つ' \
  'S3-M' \
  'plan_model' 'review_model' 'exec_model' 'plan_effort' 'review_effort' 'exec_effort' \
  '登録済み runner の model / effort を編集' \
  '変更なし（現在:' '既定に戻す（' \
  '未設定（レビュアーに選べません）' '未設定に戻す（レビュアーに選べません）' \
  'レビュアーに選べなくなります' \
  '現在の review_runner なので' "名前に ' を含むため" \
  'gpt-5.6-sol' '役割キーのみ' '2 か 3 を選ぶと到達できます' \
  'mkdir -p .dispatch' 'グローバルより優先されることをユーザーに伝える' \
  '選択肢 2 経由のみ' '選択肢 1 / 3 の First-run setup は値を検証しない' \
  '前後に空白' 'runners-edit.sh' 'mktemp "$RUNNERS.XXXXXX"' \
  'symlink は通常ファイルに置き換わり'

# 改題そのもの（EN と対称）
su15h2_pass=1
grep -Fq -- '## フィールド単位の書き込みは全て edit スクリプトを通す' "$SETUP_JA" \
  || { echo '  JA の改題後の見出しが無い'; su15h2_pass=0; }
grep -Fq -- '## 書き込みは全て `config-edit.sh` を通す' "$SETUP_JA" \
  && { echo '  JA に旧見出しが残っている'; su15h2_pass=0; }
if [[ $su15h2_pass == 1 ]]; then ok 'SU15: setup-mode-ja.md が改題されている'; else bad 'SU15: 改題'; fi

# SU15 の #### 検査（生ファイル）: 個数一致 / 6 個以上 / 8 見出しが同順
su15h_pass=1
en_h4=$(grep -c '^#### ' "$SETUP_EN")
ja_h4=$(grep -c '^#### ' "$SETUP_JA")
[[ "$en_h4" == "$ja_h4" ]] || { echo "  #### 個数 en=$en_h4 ja=$ja_h4"; su15h_pass=0; }
[[ "$en_h4" -ge 6 ]] || { echo "  #### が $en_h4 個しかない"; su15h_pass=0; }
check_order() {
  local file="$1"; shift
  local prev=0 ln
  for h in "$@"; do
    ln=$(grep -Fn -- "$h" "$file" | head -1 | cut -d: -f1)
    [[ -n "$ln" ]] || { echo "  見出しが無い: $h"; return 1; }
    [[ "$ln" -gt "$prev" ]] || { echo "  見出しの順序が違う: $h"; return 1; }
    prev="$ln"
  done
  return 0
}
check_order "$SETUP_EN" \
  '#### M1. Which runner' \
  '#### M2. Three model questions in one call' \
  '#### M3. Three effort questions in one call' \
  '#### Why by dimension rather than by role' \
  '#### Building the options' \
  '#### Deriving the codex model candidates' \
  '#### Warning when a codex review_model is unset' \
  '#### Free-text answers' || su15h_pass=0
check_order "$SETUP_JA" \
  '#### M1. どの runner か' \
  '#### M2. model 3 問（1 コール）' \
  '#### M3. effort 3 問（1 コール）' \
  '#### 役割単位ではなく次元単位にした理由' \
  '#### 選択肢の組み立て' \
  '#### codex model 候補の導出' \
  '#### codex review_model を unset するときの警告' \
  '#### 自由入力の扱い' || su15h_pass=0
if [[ $su15h_pass == 1 ]]; then ok 'SU15: #### が英日で同数・6 個以上・同順'; else bad 'SU15: #### 構造'; fi

# SU16: S7 の温存 3 文（平坦化）と S7 節内の呼び出し順（生ファイル）
need_flat "$en_flat" 'SU16: setup-mode.md が S7 の温存 3 文を保つ' \
  'so the whole result lands in a single atomic move.' \
  'For the project destination, `mkdir -p .dispatch` first.' \
  'tell the user it now shadows the global layer'
need_flat "$ja_flat" 'SU16: setup-mode-ja.md が S7 の温存 3 文を保つ' \
  '結果全体が単一の mv で反映されるようにする。' \
  'プロジェクト宛なら先に `mkdir -p .dispatch` する。' \
  'このリポジトリではグローバルより優先されることをユーザーに伝える。'

su16o_pass=1
# awk は `### S7.` から次の `## ` までを取る。現物は直後が `## R:` なので巻き込まない。
check_s7_order() {
  local file="$1" head="$2" s7 r c
  s7=$(awk -v h="$head" 'index($0, h) == 1 {f=1} f && /^## / && index($0, h) != 1 {exit} f' "$file")
  r=$(grep -n 'runners-edit\.sh' <<<"$s7" | head -1 | cut -d: -f1)
  c=$(grep -n 'config-edit\.sh' <<<"$s7" | head -1 | cut -d: -f1)
  [[ -n "$r" && -n "$c" && "$r" -lt "$c" ]]
}
check_s7_order "$SETUP_EN" '### S7.' || { echo '  setup-mode.md の S7 で runners-edit が先に来ていない'; su16o_pass=0; }
check_s7_order "$SETUP_JA" '### S7.' || { echo '  setup-mode-ja.md の S7 で runners-edit が先に来ていない'; su16o_pass=0; }
if [[ $su16o_pass == 1 ]]; then ok 'SU16: S7 節内で runners-edit.sh が config-edit.sh より前'; else bad 'SU16: S7 の順序'; fi

if [[ $fail -eq 0 ]]; then
  echo '--- all tests passed ---'
else
  echo '--- failures ---'
fi
exit "$fail"
