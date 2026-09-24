#!/usr/bin/env bash
# 文書が実行可能な正本であり、**ユーザー向けの文の owner が 1 つ**であることを検査する。
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"; P="$ROOT/apps/orca-team-dispatch-task"
S="$P/skills/orca-team-dispatch-task/SKILL.md"; G="$P/skills/orca-team-dispatch-task/references/guide-ja.md"
fails=0; ok() { echo "PASS: $1"; }; fail() { echo "FAIL: $1"; fails=$((fails+1)); }
[[ -f "$S" && -f "$G" ]] && ok "SK1 SKILL.md と guide-ja.md" || { fail "SK1"; echo "failures: 1"; exit 1; }
grep -q '^## Output Language$' "$S" \
  && grep -q 'All user-facing questions, option labels, tables, and progress reports MUST be' "$S" \
  && ok "SK2 Output Language" || fail "SK2"

# SK3: 参照する bin/*.sh と bin/*.ts が実在する
miss=""; while IFS= read -r r; do [[ -f "$P/$r" ]] || miss="$miss $r"; done \
  < <(grep -oE 'bin/[A-Za-z0-9._-]+\.(sh|ts)' "$S" | sort -u)
[[ -z "$miss" ]] && ok "SK3 参照先が実在" || fail "SK3 実在しない参照:$miss"

# SK4: **まだ実装していないものを宣言しない**
#      spec の follow-up を実装し終えたので、残る禁止語は `journal` だけである。
#      **`journal` は残す** — spec 10-2 の裁定どおり exactly-once の journal は作らない
#      (`completion.json` は crash 回復のためだけの記録である)。**この語が SKILL.md に
#      現れたら、撤回した設計へ戻ろうとしている合図である。**
bad=""; for w in journal; do
  grep -q -- "$w" "$S" && bad="$bad [$w]"; done
[[ -z "$bad" ]] && ok "SK4 未実装を宣言しない" || fail "SK4 未実装の宣言:$bad"

# SK5: **bare orca を書かない** (O1)。文書の中でも
if grep -nE '(^|[^_A-Za-z/$])orca (orchestration|terminal|worktree) ' "$S" "$G" >/dev/null 2>&1; then
  fail "SK5 bare orca を書いている ($(grep -nE '(^|[^_A-Za-z/$])orca (orchestration|terminal|worktree) ' "$S" "$G" | head -2))"
else ok "SK5 常に \$ORCA_BIN 経由"; fi

# SK6: **placeholder を見せない。**片付けの値は orca-cleanup.ts が state から埋め、selector の id: も
#      そちらが付ける（test-cleanup.sh の CL3 が argv を固定する）。文書には release を実行する行も、
#      raw な worktree id も置かない
bad=""
grep -q '<the worker terminal>' "$S" && bad="$bad [placeholder]"
grep -q '"$ORCA_BIN" orchestration worker-release' "$S" && bad="$bad [release-executed]"
grep -qE 'worktree rm --worktree \$WT( |$)' "$S" && bad="$bad [raw-id]"
[[ -z "$bad" ]] && ok "SK6 片付けの値は文書に置かない" || fail "SK6:$bad"
# SK6b: request は固定 heredoc へ入れず、次の tool call へ実パスを渡す。
bad=""
grep -q "file-write tool.*\$REQ" "$S" || bad="$bad [file-write-request]"
grep -q "shell heredoc" "$S" || bad="$bad [request-collision-explained]"
step1=$(mktemp)
awk '/^## Step 1: Write the request down$/ { section=1; next }
     section && /^```bash$/ { block=1; next }
     block && /^```$/ { exit }
     block { print }' "$S" | sed 's/^SLUG=.*/SLUG=test/' > "$step1"
handoff=$(bash "$step1" 2>/dev/null); req_path="${handoff#request_file=}"
[[ "$handoff" == request_file=* && -n "$req_path" && -f "$req_path" ]] \
  || bad="$bad [printed-request-handoff]"
grep -q '<<' "$step1" && bad="$bad [request-heredoc]"
rm -f "$step1" "$req_path"
[[ -z "$bad" ]] && ok "SK6b REQ を安全に実パスで引き継ぐ" || fail "SK6b:$bad"

# SK6n: ★ **Issue モードの block も、前の block の変数が無ければ fail closed する。**
#        `$SCRIPTS` が空のまま素通しすると `/issue-fetch.ts` を黙って叩き、何も起きて
#        いないのに成功したように見える。cleanup の SK6c と同じ不変条件である。
bad=""
issec=$(mktemp)
awk '/^## Issue mode$/{s=1} s&&/^## Step 1:/{exit} s' "$S" > "$issec"
nth_block() { awk -v n="$1" '/^```bash$/{b++; if(b==n){f=1; next}} f&&/^```$/{exit} f{print}' "$issec"; }
probe=$(mktemp -d)
# ★ **I0 以外のすべての block を検査する。**block を足したときに検査から漏れないよう、
#    数え上げは節そのものから取る（数を書き写すと必ずずれる）。
nblocks=$(grep -c '^```bash$' "$issec")
[[ "$nblocks" -ge 5 ]] || bad="$bad [issue-blocks-shrank:$nblocks]"
for ((n = 2; n <= nblocks; n++)); do
  blk="$probe/i$n.sh"; nth_block "$n" > "$blk"
  # block が無ければ検査対象も無い（節を減らしたときに黙って緩まないよう明示する）
  [[ -s "$blk" ]] || { bad="$bad [I$n-missing]"; continue; }
  # ★ **前段の変数を使う block だけが対象。**何も引き継がない block（その場で値を
  #   決めるだけのもの）には守るべきものが無い。使っているのに守っていないものを捕まえる。
  grep -qE '\$\{?(SCRIPTS|STATE|PLUGIN|NUM|SLUG|REQ)\b' "$blk" || continue
  out=$(env -u SCRIPTS -u STATE -u NUM -u SLUG -u REQ -u PLUGIN bash "$blk" 2>&1); rc=$?
  # ★ **「非 0 で終わった」では足りない。**変数が空のまま絶対パスを組み立てて
  #   `/bin/orca-issue.sh` を叩き、たまたま存在しなくて落ちるのも非 0 である。
  #   **ガード自身が発火したこと**（`: "${VAR:?...}"` の message）を要求する。
  if [[ "$rc" -eq 0 || "$out" != *'run the'* ]]; then
    bad="$bad [I$n-not-fail-closed]"
  fi
done
rm -rf "$probe" "$issec"
[[ -z "$bad" ]] && ok "SK6n Issue モードの block が fail closed" || fail "SK6n:$bad"

# SK7: 片付けの安全条件（release の state 分類 / merged / clean / --force）
miss=""
for n in 'release_pending' 'release_unknown' 'retained' 'already_released' \
         'merged' 'dirty' '--force' 'worktreeId'; do
  grep -qi -- "$n" "$S" || miss="$miss [$n]"; done
[[ -z "$miss" ]] && ok "SK7 安全条件" || fail "SK7 欠落:$miss"

# SK8: **運用規則の ID 集合が SKILL.md と guide-ja.md で一致する。**
#      件数比較だと中身を入れ替えても通るので、安定 ID を突き合わせる
ids_s=$(grep -oE '\[C[0-9]+\]' "$S" | sort -u | tr '\n' ' ')
ids_g=$(grep -oE '\[C[0-9]+\]' "$G" | sort -u | tr '\n' ' ')
[[ -n "$ids_s" && "$ids_s" == "$ids_g" ]] && ok "SK8 規則 ID が一致 ($ids_s)" \
  || fail "SK8 規則 ID が不一致 (S=[$ids_s] G=[$ids_g])"

# SK8b: **提示する CLI サブコマンドの集合も一致する**（訳が要約に化けるのを防ぐ）
cli_s=$(grep -oE '(orchestration [a-z-]+|terminal (show|close)|worktree rm)' "$S" | sort -u | tr '\n' ' ')
cli_g=$(grep -oE '(orchestration [a-z-]+|terminal (show|close)|worktree rm)' "$G" | sort -u | tr '\n' ' ')
[[ -n "$cli_s" && "$cli_s" == "$cli_g" ]] && ok "SK8b CLI 集合が一致" \
  || fail "SK8b CLI 集合が不一致 (S=[$cli_s] G=[$cli_g])"

# SK8c: 制限の件数も一致する
ns=$(awk '/^## Known limitations$/,/^## State on disk$/' "$S" | grep -c '^| .* | .* |$')
ng=$(awk '/^## 既知の制限$/,/^## ディスク上の状態$/' "$G" | grep -c '^| .* | .* |$')
[[ "$ns" -eq "$ng" && "$ns" -ge 6 ]] && ok "SK8c 制限が $ns 件で一致" || fail "SK8c 件数 (S=$ns G=$ng)"

# SK8d: 訳は正本の操作手順を省略しない。すべての bash block を順序どおり完全に写す。
#         本文は翻訳してよいが、実行するコマンドを別物にしてはいけない。
extract_bash_blocks() {
  awk '/^```bash$/ { in_block=1; next }
       in_block && /^```$/ { printf "\\034"; in_block=0; next }
       in_block { print }' "$1"
}
blocks_s=$(mktemp); blocks_g=$(mktemp)
extract_bash_blocks "$S" >"$blocks_s"; extract_bash_blocks "$G" >"$blocks_g"
if cmp -s "$blocks_s" "$blocks_g"; then
  ok "SK8d bash block が完全一致"
else
  fail "SK8d guide-ja.md が操作 block を省略または変更している"
fi
rm -f "$blocks_s" "$blocks_g"

# SK8e: 訳は順序付きの見出し・表構造を正本と共有し、訳だけの運用節を持たない。
# 見出しは翻訳の差を canonical name に写してから順序まで比較する。未知の見出しは
# unknown として残るため、改名・置換・追加を同じ構造と取り違えない。
normalise_headings() {
  local mode="$1" file="$2" line
  while IFS= read -r line; do
    case "$mode:$line" in
      skill:'# Orca Team Dispatch'|guide:'# Orca Team Dispatch') echo 'h1:orca-team-dispatch' ;;
      skill:'## Output Language'|guide:'## 出力言語') echo 'h2:output-language' ;;
      skill:'## Configuration'|guide:'## 設定') echo 'h2:configuration' ;;
      skill:'## Issue mode'|guide:'## Issue モード') echo 'h2:issue-mode' ;;
      skill:'## Step 1: Write the request down'|guide:'## Step 1: 依頼を書き出す') echo 'h2:step-1' ;;
      skill:'## Step 1b: Ask how each task starts'|guide:'## Step 1b: 各タスクの取りかかり方を尋ねる') echo 'h2:step-1b' ;;
      skill:'## Step 2: Start'|guide:'## Step 2: 開始') echo 'h2:step-2' ;;
      skill:'## Step 3: Wait'|guide:'## Step 3: 待つ') echo 'h2:step-3' ;;
      # Step 3.5 は phase_b=on のときだけの段であり、訳側の題は自由に付けられる。
      # 固定文字列で綴じると、訳を書いた瞬間に unknown 同士の不一致で落ちる。
      skill:'## Step 3.5: '*|guide:'## Step 3.5: '*) echo 'h2:step-3-5' ;;
      skill:'## Step 4: Bring the result home'|guide:'## Step 4: 成果を持ち帰る') echo 'h2:step-4' ;;
      skill:'## Step 5: Give the user the exact cleanup commands'|guide:'## Step 5: ユーザーへ正確な片付けコマンドを渡す') echo 'h2:step-5' ;;
      skill:'## Step 6: Ask once, then run what the user approves'|guide:'## Step 6: 一度だけ尋ね、承認されたものを実行する') echo 'h2:step-6' ;;
      skill:'## Known limitations'|guide:'## 既知の制限') echo 'h2:known-limitations' ;;
      skill:'## State on disk'|guide:'## ディスク上の状態') echo 'h2:state-on-disk' ;;
      *) printf 'unknown:%s\n' "$line" ;;
    esac
  done < <(grep -E '^#{1,2} ' "$file")
}
heading_structure_matches() {
  [[ "$(normalise_headings skill "$1")" == "$(normalise_headings guide "$2")" ]]
}
normalise_table_structure() {
  awk '
    /^\|/ {
      if (!in_table) { table += 1; in_table = 1; }
      fields = split($0, cell, "|");
      kind = (cell[2] ~ /^---/) ? "separator" : "row";
      printf "table:%d:%s:columns:%d\\n", table, kind, fields - 2;
      next
    }
    { in_table = 0 }
  ' "$1"
}
table_structure_matches() {
  [[ "$(normalise_table_structure "$1")" == "$(normalise_table_structure "$2")" ]]
}
if heading_structure_matches "$S" "$G" && table_structure_matches "$S" "$G" \
  && ! grep -q '対応セクションなし' "$G"; then
  ok "SK8e guide-ja.md の構造が正本と一致"
else
  fail "SK8e guide-ja.md の構造が正本と一致しない"
fi

# SK8f: 同じ見出し数でも、名前の差し替えは構造一致として受け入れてはいけない。
fixture_s=$(mktemp); fixture_g=$(mktemp)
printf '%s\n' '# Orca Team Dispatch' '## Output Language' '## Step 1: Write the request down' >"$fixture_s"
printf '%s\n' '# Orca Team Dispatch' '## 出力言語' '## Step 9: 置換された見出し' >"$fixture_g"
if heading_structure_matches "$fixture_s" "$fixture_g"; then
  fail "SK8f 同数の見出し drift を受け入れた"
else
  ok "SK8f 同数の見出し drift を拒否"
fi
rm -f "$fixture_s" "$fixture_g"

# SK8g: 訳だけに運用節を足しても、同じ構造として受け入れてはいけない。
fixture_s=$(mktemp); fixture_g=$(mktemp)
printf '%s\n' '# Orca Team Dispatch' '## Output Language' >"$fixture_s"
printf '%s\n' '# Orca Team Dispatch' '## 出力言語' '## Step 1: 依頼を書き出す' >"$fixture_g"
if heading_structure_matches "$fixture_s" "$fixture_g"; then
  fail "SK8g guide-only の運用節を受け入れた"
else
  ok "SK8g guide-only の運用節を拒否"
fi
rm -f "$fixture_s" "$fixture_g"

# SK9: **README は運用手順を持たない**（正本は 1 つ）
if grep -qE 'worker-release|worktree rm|terminal close|task-list --run' "$P/README.md"; then
  fail "SK9 README が片付け手順を重複して持っている"
else ok "SK9 README は非 normative"; fi

# SK9b: release_unknown は手動 ack せず、receipt/result を確認したうえでだけ手動統合できる。
#       元の親端末の queue は残るため、次回 dispatch は別の Orca terminal から開始する。
if grep -q 'do not proceed to Step 4' "$S" \
   && grep -q 'Step 4 へ進まない' "$G" \
   && grep -q '\$SD/received.json' "$S" \
   && grep -q '\$SD/roles/design/result.md' "$S" \
   && grep -q 'manual integration does not unblock that queue' "$S" \
   && grep -q 'ORCA_TERMINAL_HANDLE' "$S" \
   && grep -q '手動統合で queue は解消されない' "$G" \
   && grep -q 'ORCA_TERMINAL_HANDLE' "$G" \
   && awk '/^## Known limitations$/,/^## State on disk$/' "$S" | grep -q 'release_unknown' \
   && awk '/^## 既知の制限$/,/^## ディスク上の状態$/' "$G" | grep -q 'release_unknown' \
   && awk '/^## Known limitations$/,/^## State on disk$/' "$S" \
      | grep -q 'stays unacknowledged and blocks its parent terminal' \
   && awk '/^## 既知の制限$/,/^## ディスク上の状態$/' "$G" \
      | grep -q 'acknowledge されないまま親 terminal の queue を block' \
   && ! grep -q 'A `release_unknown` batch' "$S" \
   && ! grep -q 'leave the original parent queue' "$S" \
   && ! grep -q '元の親 queue は blocked のまま' "$G"; then
  ok "SK9b release_unknown の成果導線と親端末制限を明示"
else
  fail "SK9b release_unknown の成果導線または親端末制限が不足"
fi

# SK9c: C3 は C2 の shell 変数を受け取らず、自身で terminal identity を証明する。
if ! grep -q 'IDENTITY_OK.*comes from \[C2\]' "$S" \
   && ! grep -q 'IDENTITY_OK.*\[C2\] の結果' "$G"; then
  ok "SK9c C3 の identity 証明は独立"
else
  fail "SK9c C3 が C2 の変数を要求している"
fi

# SK12: Step 6 は Step 5 の印字だけを実行する。順序・停止条件・非改変・**尋ねない条件**を
#       正本と訳の両方で明示すること。
miss=""
grep -q '^## Step 6: Ask once, then run what the user approves$' "$S" || miss="$miss [step6-heading]"
grep -q '^## Step 6: 一度だけ尋ね、承認されたものを実行する$' "$G" || miss="$miss [step6-heading-ja]"
grep -q 'exactly as Step 5 printed it' "$S" || miss="$miss [verbatim]"
grep -q 'Step 5 が印字したとおりに実行する' "$G" || miss="$miss [verbatim-ja]"
grep -q 'terminal, then worktree, then dispatch record' "$S" || miss="$miss [order]"
grep -q '端末 → worktree → dispatch 記録 の順' "$G" || miss="$miss [order-ja]"
grep -q 'it counted only when `.ok == true`' "$S" || miss="$miss [receipt-gate]"
grep -q 'there is nothing to approve' "$S" || miss="$miss [no-print-no-ask]"
grep -q 'Never offer an action Step 5 declined to print' "$S" || miss="$miss [no-extra-option]"
awk '/^## Step 6: /,/^## Known limitations$/' "$S" | grep -q -- '--force' || miss="$miss [no-force]"
awk '/^## Step 6: /,/^## 既知の制限$/' "$G" | grep -q -- '--force' || miss="$miss [no-force-ja]"
[[ -z "$miss" ]] && ok "SK12 Step 6 の実行規則" || fail "SK12:$miss"

# SK14: N 並列の契約が両文書に明記されている
bad=""
for f in "$S" "$G"; do
  grep -q -- '--run' "$f" || bad="$bad [--run:$(basename "$f")]"
  grep -q -- '--status-dir' "$f" || bad="$bad [--status-dir:$(basename "$f")]"
done
for pat in released retained already_released release_pending release_unknown; do
  grep -q "$pat" "$S" || bad="$bad [$pat]"
done
[[ -z "$bad" ]] && ok "SK14 N 並列と release state の契約" || fail "SK14:$bad"

# SK15: 上限 4 タスクと質問の割り方が両文書にある。Step 1b は 1 回にまとめたので、上限の理由は Step 6 だけ
grep -q 'at most four tasks at once' "$S" && grep -q 'Step 6 asks one question per task' "$S" \
  && ! grep -q 'Step 1b and Step 6 each ask' "$S" \
  && grep -q '一度に 4 タスクまで' "$G" && grep -q 'Step 6 がタスクごとに 1 問' "$G" \
  && ! grep -q 'Step 1b と Step 6 がそれぞれタスクごとに 1 問' "$G" \
  && ok "SK15 質問の割り方" || fail "SK15"

# SK17: 取りかかり方は設定から黙って読まれず、dispatch ごとにタスク単位で尋ねられる。
#       散文の「尋ねよ」は守られないので、Step 2 のガードが省略を実行不能にすることまで固定する。
bad=""
grep -q '^## Step 1b: Ask how each task starts' "$S" || bad="$bad [step-1b:SKILL]"
grep -q '^## Step 1b: 各タスクの取りかかり方を尋ねる' "$G" || bad="$bad [step-1b:guide]"
step1b_s=$(sed -n '/^## Step 1b: /,/^## Step 2: /p' "$S")
step1b_g=$(sed -n '/^## Step 1b: /,/^## Step 2: /p' "$G")
for section in "$step1b_s" "$step1b_g"; do
  grep -q 'brainstorm' <<<"$section" || bad="$bad [brainstorm]"
  grep -q '`plan`'     <<<"$section" || bad="$bad [plan]"
  grep -q 'superpowers:brainstorming' <<<"$section" || bad="$bad [superpowers]"
  grep -q 'direct'     <<<"$section" || bad="$bad [direct]"
  grep -q -- '--issue' <<<"$section" || bad="$bad [issue]"
  grep -q 'multiSelect' <<<"$section" || bad="$bad [multiSelect]"
done
# 取りかかり方は 1 回の AskUserQuestion にまとめて尋ねる（cmux 版 1c と同じ形）。タスクごとの 1 問へ戻さない
grep -q 'one `AskUserQuestion` call' <<<"$step1b_s" || bad="$bad [one-call:SKILL]"
grep -q 'four tasks per question' <<<"$step1b_s" || bad="$bad [four-per-q:SKILL]"
grep -q '1 回の `AskUserQuestion`' <<<"$step1b_g" || bad="$bad [one-call:guide]"
grep -q '1 問に 4 タスクまで' <<<"$step1b_g" || bad="$bad [four-per-q:guide]"
grep -q 'once for every task' <<<"$step1b_s" && bad="$bad [per-task:SKILL]"
for f in "$S" "$G"; do
  grep -q 'DESIGN_MODE:?' "$f" || bad="$bad [guard:$(basename "$f")]"
  grep -q -- '--design-mode "\$DESIGN_MODE"' "$f" || bad="$bad [flag:$(basename "$f")]"
done
[[ -z "$bad" ]] && ok "SK17 取りかかり方を 1 回にまとめて尋ねる" || fail "SK17:$bad"

# SK18: 親は設計しない（cmux 版の当初の思想）。宣言が description・本文・訳の全部にある
bad=""
sed -n '/^---$/,/^---$/p' "$S" | grep -q '親は設計しない' || bad="$bad [description]"
grep -q '^\*\*No parent-side design\.\*\*' "$S" || bad="$bad [body:SKILL]"
grep -q '^\*\*親は設計しない。\*\*' "$G" || bad="$bad [body:guide]"
step1_s=$(sed -n '/^## Step 1: /,/^## Step 1b: /p' "$S")
grep -q 'superpowers:brainstorming' <<<"$step1_s" || bad="$bad [step1-no-brainstorm]"
[[ -z "$bad" ]] && ok "SK18 親は設計せずすぐ dispatch する" || fail "SK18:$bad"

# SK19: 取り込み方は Step 1b の同じ呼び出しで毎回尋ね、Step 2 のガードが省略を実行不能にする。
#       Step 4 は記録された値を読む（cmux 版の 1e と同じく、設定は推奨であって省く理由ではない）
bad=""
step1b_s=$(sed -n '/^## Step 1b: /,/^## Step 2: /p' "$S")
step1b_g=$(sed -n '/^## Step 1b: /,/^## Step 2: /p' "$G")
for section in "$step1b_s" "$step1b_g"; do
  grep -q 'Wait and merge' <<<"$section" || bad="$bad [wait-and-merge]"
  grep -q 'PR per task' <<<"$section" || bad="$bad [pr-per-task]"
  grep -q 'INTEGRATION' <<<"$section" || bad="$bad [integration-var]"
done
for f in "$S" "$G"; do
  grep -q 'INTEGRATION:?' "$f" || bad="$bad [guard:$(basename "$f")]"
  grep -q -- '--integration "\$INTEGRATION"' "$f" || bad="$bad [flag:$(basename "$f")]"
  sed -n '/^## Step 4: /,/^## Step 5: /p' "$f" | grep -q "jq -r '.integration" \
    || bad="$bad [step4-reads-record:$(basename "$f")]"
done
[[ -z "$bad" ]] && ok "SK19 取り込み方を毎回尋ねて記録する" || fail "SK19:$bad"

# SK20: 停滞は exit 8 で知らされ、止めるかどうかはユーザーが決める。無人の --issue は尋ねない
bad=""
for f in "$S" "$G"; do
  grep -q '^| 8 |' "$f" || bad="$bad [exit8:$(basename "$f")]"
  grep -q 'orca-stop.ts" --status-dir "\$SD" --snooze' "$f" || bad="$bad [snooze:$(basename "$f")]"
  grep -q 'orca-stop.ts" --status-dir "\$SD" --role "\$ROLE"' "$f" || bad="$bad [stop:$(basename "$f")]"
  grep -q -- '--on-stall report' "$f" || bad="$bad [issue-report:$(basename "$f")]"
  grep -q 'stopped.json' "$f" || bad="$bad [state:$(basename "$f")]"
done
[[ -z "$bad" ]] && ok "SK20 停滞はユーザーが決める" || fail "SK20:$bad"

# SK21: brainstorm は brainstorming → spec.md → writing-plans の順で、両文書の表がそう言う
bad=""
for f in "$S" "$G"; do
  grep -q 'superpowers:writing-plans' "$f" || bad="$bad [writing-plans:$(basename "$f")]"
  grep -q 'superpowers:subagent-driven-development' "$f" || bad="$bad [sdd:$(basename "$f")]"
  grep -q 'spec.md' "$f" || bad="$bad [spec:$(basename "$f")]"
done
[[ -z "$bad" ]] && ok "SK21 brainstorm は writing-plans まで進む" || fail "SK21:$bad"

# SK22: 停滞と止めた役の後始末が両文書にある。切り離した待機は exit 8 で黙って終わらない
bad=""
for f in "$S" "$G"; do
  b=$(basename "$f")
  grep -q -- '--on-stall report >> "\$SD/wait.log"' "$f" || bad="$bad [detached-report:$b]"
  grep -q 'unstarted_role' "$f" || bad="$bad [unstarted:$b]"
  sed -n '/^## Step 3\.5: /,/^## Step 4: /p' "$f" | grep -q 'roles/design/stopped.json' \
    || bad="$bad [3.5-stopped:$b]"
  sed -n '/^## Step 3: /,/^### /p' "$f" | grep -q 'orca-pr.ts' || bad="$bad [manual-pr:$b]"
done
grep -q 'go to Step 3.5,$' "$S" && grep -q '^then run the same wait again' "$S" || bad="$bad [rerun:SKILL]"
grep -q 'そのあと同じ待機をもう一度走らせて' "$G" || bad="$bad [rerun:guide]"
grep -q 'past four stalled tasks' "$S" || bad="$bad [four:SKILL]"
grep -q '4 つを超えたら' "$G" || bad="$bad [four:guide]"
[[ -z "$bad" ]] && ok "SK22 停滞と止めた役の後始末" || fail "SK22:$bad"

# SK23: 片付けの判定と実行は orca-cleanup.ts が持つ（設計 4-3）。Step 5 / Step 6 / I4 はそれを呼び、
#       文書に残すのは判定の意味（ユーザーにどう言うか）だけ。両文書で同じ
bad=""
for f in "$S" "$G"; do
  b=$(basename "$f")
  step5=$(awk '/^## Step 5: /{s=1} /^## Step 6: /{s=0} s' "$f")
  step6=$(awk '/^## Step 6: /{s=1; print; next} s && /^## /{exit} s' "$f")
  i4=$(awk '/^### I4\. /{s=1; print; next} s && /^##/{exit} s' "$f")
  grep -qF 'node "$PLUGIN/bin/orca-cleanup.ts" plan --status-dir' <<<"$step5" || bad="$bad [step5-plan:$b]"
  grep -qF 'node "$PLUGIN/bin/orca-cleanup.ts" run --plan' <<<"$step6" || bad="$bad [step6-run:$b]"
  grep -qF 'orca-cleanup.ts plan' <<<"$i4" || bad="$bad [i4-plan:$b]"
  # 判定を文書の bash block へ戻さない（呼び出し側のシェルで走るため。設計 1 章）。
  # block に置いてよいのは PLUGIN のガードと orca-cleanup.ts の呼び出し（とその続きの行）だけ
  extra=$(printf '%s\n%s\n' "$step5" "$step6" | awk '/^```bash$/{k=1; next} k && /^```$/{k=0} k' \
    | grep -vE '^[[:space:]]*(#|$)' \
    | grep -vE '^: "\$\{PLUGIN:\?|^node "\$PLUGIN/bin/orca-cleanup\.ts" (plan|run) |^[[:space:]]+--(status-dir|approve) ')
  [[ -z "$extra" ]] || bad="$bad [logic-in-block:$b]"
  for id in C1 C2 C3 C4 C5 C7; do grep -qF "[$id]" <<<"$step5" || bad="$bad [$id:$b]"; done
  grep -qF '[C6]' <<<"$step6" || bad="$bad [C6:$b]"
  grep -q 'Node 22.18' <<<"$step5" || bad="$bad [node-floor:$b]"
done
[[ -z "$bad" ]] && ok "SK23 片付けは orca-cleanup.ts を呼び、判定の意味を両文書に残す" || fail "SK23:$bad"

# SK24: 文書の bash block は呼び出し側のシェルで走る（mac も WSL も zsh）。zsh は `$VAR` を単語に
#       分けないので、`for <var> in $<VAR>` は値全体を 1 語として回る（2026-09-23 の [C1] 誤停止。設計 3-5）
word_split_loops() {
  awk '/^```bash$/{k=1; next} k && /^```$/{k=0} k' "$1" \
    | grep -nE 'for[[:space:]]+[A-Za-z_][A-Za-z0-9_]*[[:space:]]+in[[:space:]]+\$\{?[A-Za-z_]'
}
bad=""
for f in "$S" "$G"; do
  hits=$(word_split_loops "$f") && bad="$bad [$(basename "$f"): $hits]"
done
# 検査そのものが効くこと。regex を緩めたり壊したりしたら、ここで落ちる
probe=$(mktemp)
printf '%s\n' '```bash' 'for ROLE in $ROLES; do :; done' '```' '```bash' 'for d in "${SDS[@]}"; do :; done' '```' > "$probe"
[[ "$(word_split_loops "$probe" | wc -l)" -eq 1 ]] || bad="$bad [checker]"
rm -f "$probe"
[[ -z "$bad" ]] && ok "SK24 bash block は単語分割に頼らない" || fail "SK24:$bad"

# SK16: 消えた記述が残っていない
! grep -q 'run-design.sh' "$S" && ! grep -q 'run-design.sh' "$G" \
  && ! grep -q 'dangerously-skip-permissions' "$S" \
  && ok "SK16 消えた経路の記述が残っていない" || fail "SK16"

# SK10: コピーした plugin の本番呼び出しを plugin cwd から実行する。checker を直接呼ぶだけでは、
#       SK10 自身の cwd / ROOT 解決が壊れた回帰を検出できない。
if [[ "${DOC_LANG_REGRESSION:-}" != 1 ]]; then
  regression_root=$(mktemp -d)
  regression_root=$(cd "$regression_root" && pwd -P)
  mkdir -p "$regression_root/apps" "$regression_root/scripts"
  cp -R "$P" "$regression_root/apps/orca-team-dispatch-task"
  cp "$ROOT/scripts/check-doc-lang.mjs" "$regression_root/scripts/check-doc-lang.mjs"
  regression_skill="$regression_root/apps/orca-team-dispatch-task/skills/orca-team-dispatch-task/SKILL.md"
  printf '%s\n' 'これは一時的な SK10 回帰検証です。' >> "$regression_skill"
  regression_out=$(cd "$regression_root/apps/orca-team-dispatch-task" \
    && DOC_LANG_REGRESSION=1 bash test/test-docs.sh 2>&1)
  regression_rc=$?
  rm -rf "$regression_root"
  if [[ "$regression_rc" -ne 0 && "$regression_out" == *"FAIL: SK10 doc-lang"* \
     && "$regression_out" == *"failures: 1"* ]]; then
    ok "SK10 回帰: plugin cwd の本番呼び出しが日本語混入を検出"
  else
    fail "SK10 回帰: plugin cwd の本番呼び出しが日本語混入を検出できない"
  fi
fi

APP_FILTER="${P#"$ROOT"/}"
(cd "$ROOT" && node "$ROOT/scripts/check-doc-lang.mjs" "$APP_FILTER") >/dev/null 2>&1 \
  && ok "SK10 doc-lang" || fail "SK10 doc-lang"
echo "---"; echo "failures: $fails"; exit "$fails"
