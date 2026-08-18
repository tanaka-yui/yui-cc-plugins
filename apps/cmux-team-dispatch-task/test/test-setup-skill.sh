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

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SK="$SCRIPT_DIR/../skills/cmux-team-dispatch-task"
SKILL="$SK/SKILL.md"
SETUP_EN="$SK/references/setup-mode.md"
SETUP_JA="$SK/references/setup-mode-ja.md"
GUIDE="$SK/references/guide-ja.md"
EDIT="$SK/scripts/config-edit.sh"
fail=0

bad() { echo "FAIL $1"; fail=1; }
ok() { echo "PASS $1"; }

for f in "$SKILL" "$SETUP_EN" "$SETUP_JA" "$GUIDE" "$EDIT"; do
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

if [[ $fail -eq 0 ]]; then
  echo '--- all tests passed ---'
else
  echo '--- failures ---'
fi
exit "$fail"
