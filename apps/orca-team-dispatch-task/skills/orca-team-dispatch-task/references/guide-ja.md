## 出力言語

ユーザーへ提示する質問、選択肢ラベル、表、進捗報告はすべて日本語で表示する。
この SKILL.md 本文は規約上の統一のため英語で書かれているだけであり、ユーザーへの
表示言語を変えるものではない。

# Orca Team Dispatch

各タスクを専用の Orca worktree と専用の worker で、1 つの共有 Run 上で実行し、
成果を親へ持ち帰る。

```bash
PLUGIN="${CLAUDE_PLUGIN_ROOT:?the plugin root is not set; reinstall the plugin}"
ORCA_BIN="${ORCA_BIN:-/Applications/Orca.app/Contents/Resources/bin/orca}"
```

Orca CLI は PATH に無い。ユーザーへ見せるコマンドも含め、常に `$ORCA_BIN` 経由で呼ぶ。

## Step 1: 依頼を書き出す

dispatch するのは一度に 4 タスクまでとする。4 タスクは既に 4 本の agent セッションであり、
Step 6 はタスクごとに 1 問尋ねるが、`AskUserQuestion` が受け取れる質問は最大 4 問である。
ユーザーがそれ以上を望むときは、タスク件数と起動するセッション本数を示し、4 を超える前に
明示的な同意を得る。

worker は依頼をファイルから読む。逐語で写し、要約しない。要約するとユーザーが実際に
出した指示が失われる。これはタスクごとに 1 回行い、タスクごとに固有の slug と固有の
依頼ファイルを与える。

```bash
SLUG=<lowercase, digits and hyphens, 1-30 chars>
REQ=$(mktemp)
# Use the coding environment's file-write tool to write the user's request verbatim to "$REQ".
# Do not use a shell heredoc: a request may contain REQUEST (or any delimiter) on its own line.
printf 'request_file=%s\n' "$REQ"
```

表示された `request_file` path を file-write tool へ渡す。shell 変数は tool call を跨がないため、
Step 2 を別 call で実行するときは、その正確な path を `REQ` へ設定する。

## Step 2: 開始

これをタスクごとに 1 回実行する。**最初の呼び出しが Run を作って `run_id` を印字し、以降の
呼び出しはその同じ `run_id` を `--run` で渡す。こうして全タスクが 1 つの Run と 1 つの親
mailbox を共有する。**並列にではなく、順番に呼ぶ。

```bash
: "${REQ:?set REQ to the exact request_file path printed in Step 1}"
RUN="${RUN:-}"   # empty for the first task; the printed run_id for every task after it
OUT=$(bash "$PLUGIN/bin/orca-start.sh" --request-file "$REQ" --slug "$SLUG" \
        --objective "<one line naming the outcome>" ${RUN:+--run "$RUN"}) || { echo "$OUT"; exit 1; }
SD=$(sed -n 's/^status_dir=//p' <<<"$OUT")
RUN=$(sed -n 's/^run_id=//p' <<<"$OUT")
printf 'status_dir=%s\nrun_id=%s\n' "$SD" "$RUN"
```

ここでも shell 変数は tool call を跨がない。全タスクの `status_dir` と 1 つの `run_id` を
印字された値のまま控える。Step 3、Step 4、Step 5 はいずれもその正確な値を必要とする。

exit 1 はそのタスクの worker が起動しなかったことを意味する。メッセージに resources are KEPT と
あれば Task はすでに実在する。何も削除せず、表示された inspection コマンドを実行する。すでに
起動済みのタスクは影響を受けない。通常どおり Step 3 で待つ。

## Step 3: 待つ

先にユーザーへ伝える。worker が終わると、この skill はメッセージを acknowledge する前に
その端末を retain する。ここでは何も解放しない。端末、worktree、dispatch 記録はいずれも、
Step 5 が削除してよいものを判定し、Step 6 がユーザーへ尋ねるまで残る。保持は意図的である。
後段の stage が同じセッションへ review の指摘を送り返すためである。

1 回の呼び出しで全タスクを待つ。タスクは 1 つの Run と 1 つの親 mailbox を共有するので、
1 度の drain ですべてが settle する。`--status-dir` をタスクごとに 1 つ渡す。

```bash
# One --status-dir per task, in Step 2's order. Repeat the flag for every further task.
bash "$PLUGIN/bin/orca-wait.sh" --status-dir "<task 1 status_dir printed by Step 2>" \
                               --status-dir "<task 2 status_dir printed by Step 2>"
```

| Exit | 意味 | すること |
|---|---|---|
| 0 | すべての worker が成功を報告して完了 | 各タスクの `$SD/roles/design/result.md` を読み、ユーザーへ伝えて全タスクを Step 4 へ進める |
| 5 | 1 件以上の worker が失敗を報告 | 各 `result.md` を読み、どのタスクがなぜ失敗したかを伝える。Step 4 へ進めるのは成功したタスクだけで、Step 5 は全タスクに行う。**失敗したタスクを merge しない** |
| 3 | まだ実行中 | 進捗を報告してから、同じ `--status-dir` の組でもう一度呼ぶ |
| 4 | worker が停止・失敗した、または Orca transport を検証できない | 調べてユーザーへ伝える。何も削除しない。release transport failure の前に receipt が保存されていれば canonical wait を再実行し、batch を手で復旧しない |
| 1 | batch が未対応・矛盾、receipt を読めない・書けない、または release が完了していない | acknowledge していない。手動 acknowledge はせず、下の状態別の手順に従う |

**判断の根拠は exit code であって出力の文字列ではない。**集約行の前に、待機は
`task=... dispatch=... status_dir=... outcome=...` の行をタスクごとに 1 行印字する。一部だけ
失敗したときは、それらの行に両方の outcome が同時に現れる。どのタスクが失敗したかを名指しする
ためにその行を使い、成功判定を出力中の `outcome=` の検索で行ってはならない。

exit 1 では **自分で `--ack` を実行しない**。まず error を読む。`worker_done` の receipt は release
前に記録されるため、`release_pending` は安全に再試行できる。`orca-wait.sh` を再実行すると release を
再試行してから acknowledge を判断する。`release_unknown` は異なり、再試行しても前回の release 結果を
証明できない。端末と worktree を保持して acknowledge せず、**Step 4 へ進まない**。記録済み receipt と
result をユーザーと確認する。成功した worker outcome が示されていれば、ユーザーは下の手動統合コマンドを
明示的に選べるが、それで batch を acknowledge することはない。acknowledge されない batch はこの親端末の
queue の先頭に残り、手動統合で queue は解消されない。後続の dispatch は別の Orca terminal を開き、そこで
この skill を呼び出して開始する。`orca-start.sh` に親端末を指定する flag はなく、実行した Orca terminal の
`ORCA_TERMINAL_HANDLE` を読むため、新しい terminal の handle が使われる。blocked な handle をコピーまたは
設定してはならない。未対応・矛盾 batch または不正 receipt は cursor を進めずに確認して、ユーザーの指示を待つ。

```bash
PH=$(jq -r '.parent_handle // empty' "$SD/run.json")
[[ -n "$PH" ]] || { echo "missing parent handle; do not acknowledge anything" >&2; exit 1; }
"$ORCA_BIN" orchestration check --terminal "$PH" --peek --json
# Retry the canonical wait only when its error said release_pending.
# For release_unknown, do not retry or use normal Step 4; never ack by hand.
```

`release_unknown` のときだけ、前の inspection の後で記録済み outcome と result をユーザーへ見せる。
ユーザーが成功した result を統合すると明示的に決めた場合、次の安全な merge コマンドを実行できる。receipt、
status、result、branch、clean checkout の通常の guard はすべて実行し、blocked な batch を acknowledge しない。

```bash
cat "$SD/received.json"
sed -n '1,240p' "$SD/roles/design/result.md"
# Only after the user has inspected both files and chosen manual integration:
bash "$PLUGIN/bin/orca-merge.sh" --status-dir "$SD"
```

確認したメッセージと、それが `release_pending`、`release_unknown`、未対応・矛盾メッセージのどれかを
ユーザーへ見せる。transport/health の失敗は exit 4 であり、batch を手作業で復旧する合図ではない。

## Step 4: 成果を持ち帰る

成功したタスクごとに 1 回、`SD` へそのタスクの `status_dir` を設定して実行する。exit 0 なら
全タスクが対象である。exit 5 なら、自身の `task=...` 行が `outcome=succeeded` で終わっていた
タスクだけが対象である。

```bash
bash "$PLUGIN/bin/orca-merge.sh" --status-dir "$SD"
```

dispatch を始めたときにいたブランチへ worker のブランチを merge する。worker が成功を
報告していること、`result.md` が空でないこと、checkout が開始時のブランチのままであること、
checkout が clean であることのすべてを満たさなければ拒否する。競合時は merge を中断して
すべてを残すので、ユーザーへ解決方法を伝える。タスクは順番に merge して結果をそれぞれ報告する。
あるタスクが拒否されても、他のタスクについては何も意味しない。

## Step 5: ユーザーへ正確な片付けコマンドを渡す

この step は何も削除しない。削除してよいものを判定し、実際の値を埋めたコマンドを表示する。
placeholder を見せない。実行してよいかは Step 6 がユーザーへ尋ねる。

release は自分で実行し、その結果の state で分類する。exit code だけでは端末を閉じてよいか
判断できない。

各 cleanup block は別の tool call である。[C1]、[C2]、[C3]、[C5] はタスクごとに 1 回、`SD` へ
そのタスクの正確な `status_dir` を設定して実行する。[C7] は Run 全体について、いずれかの削除の
前に 1 回だけ実行する。各 block は state を自分で読み直し、state がなければ fail closed する。
作り物の handle、dispatch、worktree id を代入してはならない。

[C1] `release_pending` または `release_unknown`: そのタスクは **ここで止まる。**exit 0 は何かを
閉じる権限ではない。receipt と次の inspection コマンドをユーザーへ見せ、端末と worktree は
意図的に保持していると伝える。

```bash
: "${SD:?set SD to the exact status_dir printed in Step 2}"
ORCA_BIN="${ORCA_BIN:-/Applications/Orca.app/Contents/Resources/bin/orca}"
DID=$(jq -r '.roles.design.dispatch // empty' "$SD/workers.json" 2>/dev/null)
[[ -n "$DID" && -n "$ORCA_BIN" ]] || {
  echo "required cleanup state is missing; do not close or remove anything" >&2
  exit 1
}
RELRC=0; REL=$("$ORCA_BIN" orchestration worker-release --dispatch "$DID" --json 2>/dev/null) || RELRC=$?
jq -e '.ok == true and (.result | type == "object")' <<<"$REL" >/dev/null 2>&1 || {
  echo "could not confirm the release; do not close anything" >&2
  exit 1
}
STATE=$(jq -r '.result.state // empty' <<<"$REL" 2>/dev/null)
if [[ "$STATE" == release_unknown ]]; then
  printf '%s\n' "$REL"
  printf '%q orchestration worker-show --dispatch %q --json\n' "$ORCA_BIN" "$DID"
  exit 0
fi
[[ "$RELRC" -eq 0 ]] || { echo "could not confirm the release; do not close anything" >&2; exit 1; }
[[ "$STATE" == release_pending ]] || { echo "release state '${STATE:-unknown}' does not authorise C1" >&2; exit 1; }
printf '%s\n' "$REL"
printf '%q orchestration worker-show --dispatch %q --json\n' "$ORCA_BIN" "$DID"
```

[C2] worker を release して state を読む。`released` は Orca が端末を閉じたという意味であり、
もう何もすることがない。`already_released` は同じ状態に 2 度到達しただけである。`retained` は
Orca が閉じることを **拒んだ** という意味であり、誰かが引き取ったか、identity を証明できなかった
かのいずれかである。したがって close コマンドを印字してよいのは handle と worktree が記録済み
state と一致するときだけで、一致しなければ何を、なぜ残すのかを伝える。

```bash
: "${SD:?set SD to the exact status_dir printed in Step 2}"
ORCA_BIN="${ORCA_BIN:-/Applications/Orca.app/Contents/Resources/bin/orca}"
WT=$(jq -r '.worktree_id // empty' "$SD/workers.json" 2>/dev/null)
TH=$(jq -r '.roles.design.terminal // empty' "$SD/workers.json" 2>/dev/null)
DID=$(jq -r '.roles.design.dispatch // empty' "$SD/workers.json" 2>/dev/null)
WP=$(jq -r '.worktree_path // empty' "$SD/workers.json" 2>/dev/null)
[[ -n "$WT" && -n "$TH" && -n "$DID" && -n "$WP" && -n "$ORCA_BIN" ]] || {
  echo "required cleanup state is missing; do not close or remove anything" >&2
  exit 1
}
RELRC=0; REL=$("$ORCA_BIN" orchestration worker-release --dispatch "$DID" --json 2>/dev/null) || RELRC=$?
jq -e '.ok == true and (.result | type == "object")' <<<"$REL" >/dev/null 2>&1 || {
  echo "could not confirm the release; do not close anything" >&2
  exit 1
}
STATE=$(jq -r '.result.state // empty' <<<"$REL" 2>/dev/null)
[[ "$RELRC" -eq 0 ]] || { echo "could not confirm the release; do not close anything" >&2; exit 1; }
case "$STATE" in
  released|retained|already_released) ;;
  *) echo "release state '${STATE:-unknown}' does not authorise C2" >&2; exit 1 ;;
esac
SHRC=0; SHOWN=""
if [[ "$STATE" != released ]]; then
  SHOWN=$("$ORCA_BIN" terminal show --terminal "$TH" --json 2>/dev/null) || SHRC=$?
  [[ "$SHRC" -eq 0 ]] && jq -e '.ok == true and (.result.terminal | type == "object")' <<<"$SHOWN" >/dev/null 2>&1 || {
    echo "could not verify the terminal identity; do not close anything" >&2
    exit 1
  }
fi
if [[ "$STATE" == released ]]; then
  echo "Orca closed the worker terminal; nothing to close"
elif [[ "$(jq -r '.result.terminal.handle // empty' <<<"$SHOWN")" == "$TH" \
     && "$(jq -r '.result.terminal.worktreeId // empty' <<<"$SHOWN")" == "$WT" ]]; then
  printf '%s terminal close --terminal %q --json\n' "$ORCA_BIN" "$TH"
else
  echo "the terminal no longer matches our state; leave it alone"
fi
```

[C3] worktree の削除は破壊的である。次の条件がすべて実際に成り立つ場合だけ削除コマンドを
表示する。条件を説明するだけで済ませない。

```bash
: "${SD:?set SD to the exact status_dir printed in Step 2}"
ORCA_BIN="${ORCA_BIN:-/Applications/Orca.app/Contents/Resources/bin/orca}"
WT=$(jq -r '.worktree_id // empty' "$SD/workers.json" 2>/dev/null)
TH=$(jq -r '.roles.design.terminal // empty' "$SD/workers.json" 2>/dev/null)
DID=$(jq -r '.roles.design.dispatch // empty' "$SD/workers.json" 2>/dev/null)
WP=$(jq -r '.worktree_path // empty' "$SD/workers.json" 2>/dev/null)
MERGED=$(jq -r '.merged // false' "$SD/integration-result.json" 2>/dev/null)
OWNED=$(jq -r '.worktree_created_by_this_run // false' "$SD/workers.json" 2>/dev/null)
KNOWN=$(jq -c '.worktree_terminals // null' "$SD/workers.json" 2>/dev/null)
[[ -n "$WT" && -n "$TH" && -n "$DID" && -n "$WP" && -n "$ORCA_BIN" && -n "$KNOWN" ]] || {
  echo "required cleanup state is missing; do not close or remove anything" >&2
  exit 1
}
RELRC=0; REL=$("$ORCA_BIN" orchestration worker-release --dispatch "$DID" --json 2>/dev/null) || RELRC=$?
jq -e '.ok == true and (.result | type == "object")' <<<"$REL" >/dev/null 2>&1 || {
  echo "could not confirm the release; do not remove anything" >&2
  exit 1
}
STATE=$(jq -r '.result.state // empty' <<<"$REL" 2>/dev/null)
[[ "$RELRC" -eq 0 ]] || { echo "could not confirm the release; do not remove anything" >&2; exit 1; }
case "$STATE" in
  released|retained|already_released) ;;
  *) echo "release state '${STATE:-unknown}' does not authorise C3" >&2; exit 1 ;;
esac
SHRC=0; SHOWN=""
if [[ "$STATE" != released ]]; then
  SHOWN=$("$ORCA_BIN" terminal show --terminal "$TH" --json 2>/dev/null) || SHRC=$?
  [[ "$SHRC" -eq 0 ]] && jq -e '.ok == true and (.result.terminal | type == "object")' <<<"$SHOWN" >/dev/null 2>&1 || {
    echo "could not verify the terminal identity; do not remove anything" >&2
    exit 1
  }
fi
IDENTITY_OK=no
if [[ "$STATE" == released ]]; then
  IDENTITY_OK=yes
elif [[ "$(jq -r '.result.terminal.handle // empty' <<<"$SHOWN")" == "$TH" \
     && "$(jq -r '.result.terminal.worktreeId // empty' <<<"$SHOWN")" == "$WT" ]]; then
  IDENTITY_OK=yes
fi
DIRTY=$(git -C "$WP" status --porcelain 2>/dev/null); DRC=$?

# Every terminal Orca still has in that worktree must be one we recorded. Keep all three
# states: yes is proven, no is disproven, and unknown is not enough authority to remove.
ACCOUNTED=unknown
TLRC=0; TL=$("$ORCA_BIN" terminal list --worktree "id:$WT" --json 2>/dev/null) || TLRC=$?
if [[ "$TLRC" -eq 0 ]] && jq -e '.ok == true and (.result.terminals | type == "array")' <<<"$TL" >/dev/null 2>&1 \
   && jq -e 'type == "array"' <<<"$KNOWN" >/dev/null 2>&1; then
  ACCOUNTED=$(jq -n --argjson l "$(jq -c '[.result.terminals[].handle]' <<<"$TL")" \
                    --argjson k "$KNOWN" 'if (($l - $k) | length) == 0 then "yes" else "no" end' -r)
fi

if [[ "$MERGED" == true && "$OWNED" == true && "$DRC" -eq 0 && -z "$DIRTY" \
      && "$IDENTITY_OK" == yes && "$ACCOUNTED" == yes ]]; then
  printf '%s worktree rm --worktree %q --json\n' "$ORCA_BIN" "id:$WT"
else
  echo "not offering to remove the worktree:"
  [[ "$MERGED" == true ]]      || echo "  - the work is not merged yet"
  [[ "$OWNED" == true ]]       || echo "  - this dispatch reused an existing worktree; it is not ours to remove"
  [[ "$DRC" -eq 0 ]]           || echo "  - the worker checkout could not be inspected"
  [[ -z "$DIRTY" ]]            || echo "  - the worker checkout has uncommitted changes"
  [[ "$IDENTITY_OK" == yes ]]  || echo "  - the terminal identity did not match our state"
  case "$ACCOUNTED" in
    yes) ;;
    no)      echo "  - a terminal in that worktree is not one we recorded" ;;
    unknown) echo "  - the terminals in that worktree could not be listed, so nothing is proven" ;;
  esac
fi
```

`IDENTITY_OK` は [C3] の中で計算する。[C2] から shell 変数を持ち込まない。Orca が自分で端末を
閉じたとき、あるいはこの block 内で handle と worktree が一致したときにだけ `yes` になる。
worker が Step 3 で exit 5 を返したタスクは `MERGED` が false であり、そのタスクの削除を
提示しない。これは意図した動作であって欠落ではない。

[C7] `worker-retain` は durable な例外を記録するため、中断したセッションの保持が
残りうる。この Run について何かを消す前に、Orca が実際に何を保持しているか尋ね、
自分たちの記録と突き合わせる。記録に無い保持は他者のもの、あるいは前回の Run の
自分たちのものであり、いずれにせよ手を出してよいものではない。この Run のすべての
タスクが 1 つの答えを共有するので、実行は 1 回だけとし、`SDS` には **すべての** タスクの
status dir を並べる。Orca は Run 全体を報告するため、`SDS` から漏れた兄弟タスクは ghost に
見え、全タスクの片付けを止めてしまう:

```bash
: "${SD:?set SD to the exact status_dir printed in Step 2}"
ORCA_BIN="${ORCA_BIN:-/Applications/Orca.app/Contents/Resources/bin/orca}"
SDS=("$SD")   # append every other status_dir of this Run
WJ=(); for d in "${SDS[@]}"; do WJ+=("$d/workers.json"); done
RUN=$(jq -r '.run_id // empty' "$SD/run.json" 2>/dev/null)
KNOWN=$(jq -sc '[.[] | .roles[]?.dispatch // empty]' "${WJ[@]}" 2>/dev/null)
[[ -n "$RUN" && -n "$KNOWN" && -n "$ORCA_BIN" ]] || {
  echo "required cleanup state is missing; do not close or remove anything" >&2
  exit 1
}
WLRC=0; WL=$("$ORCA_BIN" orchestration worker-list --run "$RUN" --terminal-state retained --json 2>/dev/null) || WLRC=$?
[[ "$WLRC" -eq 0 ]] && jq -e '.ok == true and (.result.workers | type == "array")' <<<"$WL" >/dev/null 2>&1 || {
  echo "could not list what Orca still holds for this Run; do not remove anything" >&2
  exit 1
}
GHOSTS=$(jq -c --argjson k "$KNOWN" '[.result.workers[].dispatchId] - $k' <<<"$WL")
if [[ "$(jq 'length' <<<"$GHOSTS")" -eq 0 ]]; then
  echo "every retained worker in this Run is one we recorded"
else
  echo "Orca still holds retained workers we did not record:" >&2
  jq -r '.[]' <<<"$GHOSTS" >&2
  echo "do not remove any worktree or dispatch record for this Run" >&2
  exit 1
fi
```

[C5] `.dispatch/<slug>` の dispatch 記録は、依頼と worker の結果の唯一のローカル控えである。
そのため、そのタスクの成果が merge 済みになったときだけ削除を提示する。この block は Orca
コマンドを呼ばないので release の分類も行わない。代わりに `$SD` が本当にこの dispatch の
記録であり、`.dispatch` ディレクトリの中にあることを証明する。

```bash
: "${SD:?set SD to the exact status_dir printed in Step 2}"
MERGED=$(jq -r '.merged // false' "$SD/integration-result.json" 2>/dev/null)
[[ -f "$SD/run.json" && -f "$SD/workers.json" ]] || {
  echo "this is not a dispatch status directory; do not remove anything" >&2
  exit 1
}
PARENT=$(cd "$SD/.." 2>/dev/null && pwd -P) || PARENT=""
[[ "$(basename "${PARENT:-/}")" == .dispatch ]] || {
  echo "the status directory is not inside .dispatch; do not remove it" >&2
  exit 1
}
if [[ "$MERGED" == true ]]; then
  printf 'rm -rf %q\n' "$SD"
else
  echo "not offering to remove the dispatch record:"
  echo "  - the work is not merged yet, so this is the only copy of the request and result"
fi
```

ユーザーへ、次を平易な言葉で伝える。

- [C1] `release_pending` と `release_unknown` は release が完了していない状態である。端末を閉じたり
  手動 acknowledge したりして補おうとしない。再試行するのは `release_pending` だけであり、
  `release_unknown` では receipt と result を確認しても、ユーザーが guarded manual integration を選んだ
  場合を含め、元の親 queue は blocked のままにする。
- [C2] `released` と `already_released` は Orca が端末を閉じたことを意味し、そのタスクについて
  閉じるものは残っていない。`retained` は Orca が端末を残したことを意味し、そのときは handle と
  worktree が記録済み state に一致する端末だけを閉じてよい。一致しなければ、すでに他者の
  所有物である。
- [C3] 削除コマンドは、成果が merge 済み、この dispatch が worktree を作成した、checkout が
  読めて clean、端末 identity が一致、worktree にまだ残る端末すべてが記録済み、の全条件を
  満たすときだけ表示する。再利用 worktree は最初からこちらのものではないため、削除を提示しない。
  **端末を列挙できないことは「存在しない」ことではない。何も証明されないのでコマンドを表示しない。**
- [C7] 何かを消す前に、この Run について Orca が実際に保持しているものが、こちらの記録と
  一致していなければならない。記録に無い保持が 1 つでもあれば、その worker だけでなく
  Run 全体の片付けを止める。
- [C4] `worktree rm` は branch の削除も試みる。Orca は変更が merge 済みと証明できない branch を
  残すので、branch が残ることは失敗ではなく合図である。ユーザーが dirty なファイルを見て失っても
  よいと判断するまで、`--force` を加えない。
- [C5] dispatch 記録は merge 済みになってからだけ提示する。それまでは何を依頼して何が返って
  きたかの唯一の控えであり、失うと手で調べる・再開する手段も失う。

## Step 6: 一度だけ尋ね、承認されたものを実行する

判定は Step 5 が済ませた。この step は尋ねて実行する。独自の判定は一切行わない。
Step 5 が実際に印字したコマンドを、印字されたとおりに実行するだけである。

[C6] 尋ね方と実行:

- どのタスクについても Step 5 が片付けのコマンドを 1 つも印字しなかったときは、承認するものが
  ない。[C1] の inspection コマンドはこれに数えない。Step 5 が既に印字した理由をそのまま使い、
  何を、なぜ残すのかをユーザーへ伝えて終わる。尋ねない。
- 質問はタスクごとに 1 問とし、質問の header にはそのタスクの slug を使い、選択肢はそのタスクに
  ついて Step 5 が印字した対象だけにする。Step 5 が何も印字しなかったタスクは質問から丸ごと
  外し、そのタスクについて何を、なぜ残すのかを伝える。
- `AskUserQuestion` が受け取れる質問は最大 4 問である。Step 1 でユーザーが 4 を超えるタスクを
  承認していた場合は、代わりに単一の質問とし、選択肢を「全タスクの端末」「全タスクの worktree」
  「全タスクの dispatch 記録」とする。選択肢に出してよいのは、少なくとも 1 つのタスクについて
  Step 5 がその対象を印字したときだけである。
- Step 5 が印字を見送った対象を選択肢に出さない。
- 何も選ばないのは正当な回答である。すべてを残し、何が残ったかを伝える。
- 承認されたコマンドは、タスクを slug 順に、タスク内では 端末 → worktree → dispatch 記録 の順に
  実行する。端末が開いたままの worktree を Orca は手放さず、記録は最後に失うものだからである。
- 各コマンドは Step 5 が印字したとおりに実行する。handle や worktree id を打ち直さない、
  `--force` を加えない、印字を見ていない selector に差し替えない。
- Orca コマンドごとに receipt を確認する。`.ok == true` のときだけ実行できたとみなす。
  それ以外ならそこで止め、何が実行されなかったかを報告し、残りには手を付けない。
  失敗が次の step を authorise することはなく、あるタスクの失敗が別のタスクの先送りを
  authorise することもない。
- dispatch 記録は端末と worktree の id を保持している。それらと並べて提示するときは、
  記録だけを削除して他を残すと何を失うのかをその選択肢に書き、承知のうえで選べるようにする。
- 最後に、タスクごとに削除したものと残したものを報告する。

## 既知の制限

該当するときは、黙って回避せずユーザーへ伝える。

| 制限 | ユーザーがすること |
|---|---|
| 片付けが勝手に走ることはない | Step 6 の質問に答える。承認したものだけが削除され、断ったものは残る |
| セッションが dispatch の途中で終了しても、自動回復しない | `$ORCA_BIN orchestration task-list --run <run_id> --json` と `$ORCA_BIN orchestration worker-show --dispatch <id> --json` で調べ、Step 5 と Step 6 と同様に片付ける |
| worker が報告せずに停止すると、組全体の待機が timeout する | 同じ inspection を行う。状態は `.dispatch/<slug>/` に、タスクごとに 1 ディレクトリある |
| worker は質問できない | 代わりに `result.md` へ理由を書いて失敗として終了するよう指示してある。読んで再度 dispatch する |
| どの役も Orca が起動する `claude` agent で動き、model と effort はまだ選べない | 信頼できるタスクだけを dispatch し、役ごとの agent 設定を足す stage を待つ |
| setup hook を必要とする repository は対象外 | worktree は setup を skip して作る |
| `release_unknown` batch は元の親 terminal の queue を block する | acknowledge しない。`received.json` と `result.md` を確認する。guarded manual integration でも queue は解消されない。後続の dispatch は別の Orca terminal から開始し、launch 時にはその `ORCA_TERMINAL_HANDLE` が使われる |
| failure / edge receipt fixture の一部は simulated のままである | 実機 E2E が証明したのは worker 1 本の成功経路だけである。Stage 2 で、依存する前に `check` の wait/ack、`worker-show` の wait state、`worker-release` の別 state、terminal/worktree cleanup の実機 receipt を capture する |

## ディスク上の状態

タスクごとに `.dispatch/<slug>/` が 1 つあり、そこに `request.md`、`run.json`、`workers.json`、
`received.json`、`integration-result.json`、`roles/design/{status.json,result.md}` がある。
1 つの Run のタスクは `run.json` に同じ `run_id` を持ち、`workers.json` にそれぞれの worktree を
持つ。`workers.json` の `roles` map は役ごとに 1 entry を持つので、後段の stage が何も動かさずに
役を増やせる。手で再開・片付けするために必要なものはすべてここにある。`.dispatch/` は
repository の `info/exclude` に加えるため、ユーザーの `git status` には現れない。
