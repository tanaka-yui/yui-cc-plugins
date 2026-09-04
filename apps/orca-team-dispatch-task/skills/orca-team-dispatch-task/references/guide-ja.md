## 出力言語

ユーザーへ提示する質問、選択肢ラベル、表、進捗報告はすべて日本語で表示する。
この SKILL.md 本文は規約上の統一のため英語で書かれているだけであり、ユーザーへの
表示言語を変えるものではない。

# Orca Team Dispatch

1 つのタスクを 1 worker 専用の Orca worktree で実行し、成果を親へ持ち帰る。

```bash
PLUGIN="${CLAUDE_PLUGIN_ROOT:?the plugin root is not set; reinstall the plugin}"
ORCA_BIN="${ORCA_BIN:-/Applications/Orca.app/Contents/Resources/bin/orca}"
```

Orca CLI は PATH に無い。ユーザーへ見せるコマンドも含め、常に `$ORCA_BIN` 経由で呼ぶ。

## Step 1: 依頼を書き出す

worker は依頼をファイルから読む。逐語で写し、要約しない。要約するとユーザーが実際に
出した指示が失われる。

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

```bash
: "${REQ:?set REQ to the exact request_file path printed in Step 1}"
OUT=$(bash "$PLUGIN/bin/orca-start.sh" --request-file "$REQ" --slug "$SLUG" \
        --objective "<one line naming the outcome>") || { echo "$OUT"; exit 1; }
SD=$(sed -n 's/^status_dir=//p' <<<"$OUT")
```

exit 1 は worker が起動しなかったことを意味する。メッセージに resources are KEPT と
あれば Task はすでに実在する。何も削除せず、表示された inspection コマンドを実行する。

## Step 3: 待つ

先にユーザーへ伝える。worker が終わると、この skill はメッセージを acknowledge する前に
dispatch を release する。端末はこちらで作って `worker-start` へ渡した再利用端末なので、
Orca は `retained` と報告して閉じない。端末と worktree は Step 5 でユーザーが片付けるまで
残る。これは Orca の再利用端末の規則であり、この skill が retention を要求したためではない。

```bash
bash "$PLUGIN/bin/orca-wait.sh" --status-dir "$SD"
```

| Exit | 意味 | すること |
|---|---|---|
| 0 | worker が成功を報告して完了 | `$SD/roles/design/result.md` を読み、ユーザーへ伝えて Step 4 へ進む |
| 5 | worker が失敗を報告して完了 | `result.md` を読み、失敗内容を伝えて Step 5 へ進む。**merge しない** |
| 3 | まだ実行中 | 進捗を報告してから、もう一度呼ぶ |
| 4 | worker が停止・失敗した、または Orca transport を検証できない | 調べてユーザーへ伝える。何も削除しない。release transport failure の前に receipt が保存されていれば canonical wait を再実行し、batch を手で復旧しない |
| 1 | batch が未対応・矛盾、receipt を読めない・書けない、または release が完了していない | acknowledge していない。手動 acknowledge はせず、下の状態別の手順に従う |

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

exit 0 のときだけ実行する。

```bash
bash "$PLUGIN/bin/orca-merge.sh" --status-dir "$SD"
```

dispatch を始めたときにいたブランチへ worker のブランチを merge する。worker が成功を
報告していること、`result.md` が空でないこと、checkout が開始時のブランチのままであること、
checkout が clean であることのすべてを満たさなければ拒否する。競合時は merge を中断して
すべてを残すので、ユーザーへ解決方法を伝える。

## Step 5: ユーザーへ正確な片付けコマンドを渡す

この版は何も削除しない。実際の値を埋めたコマンドを表示し、ユーザーに判断させる。
placeholder を見せない。

release は自分で実行し、その結果の state で分類する。exit code だけでは端末を閉じてよいか
判断できない。

各 cleanup block は別の tool call である。block を実行する前に `SD` へ Step 2 が出した正確な
`status_dir` を設定する。各 block は state を自分で読み直し、state がなければ fail closed する。
作り物の handle、dispatch、worktree id を代入してはならない。

[C1] `release_pending` または `release_unknown`: **ここで止まる。**exit 0 は何かを閉じる
権限ではない。receipt と次の inspection コマンドをユーザーへ見せ、端末と worktree は意図的に
保持していると伝える。

```bash
: "${SD:?set SD to the exact status_dir printed in Step 2}"
ORCA_BIN="${ORCA_BIN:-/Applications/Orca.app/Contents/Resources/bin/orca}"
DID=$(jq -r '.design.dispatch // empty' "$SD/workers.json" 2>/dev/null)
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

[C2] `retained` または `already_released`: Orca が端末をこちらに残した。閉じる前に、
handle と端末が属する worktree が記録済み state と一致することを確認し、所有物であると証明する。

```bash
: "${SD:?set SD to the exact status_dir printed in Step 2}"
ORCA_BIN="${ORCA_BIN:-/Applications/Orca.app/Contents/Resources/bin/orca}"
WT=$(jq -r '.worktree_id // empty' "$SD/workers.json" 2>/dev/null)
TH=$(jq -r '.design.terminal // empty' "$SD/workers.json" 2>/dev/null)
DID=$(jq -r '.design.dispatch // empty' "$SD/workers.json" 2>/dev/null)
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
  retained|already_released) ;;
  *) echo "release state '${STATE:-unknown}' does not authorise C2" >&2; exit 1 ;;
esac
SHRC=0; SHOWN=$("$ORCA_BIN" terminal show --terminal "$TH" --json 2>/dev/null) || SHRC=$?
[[ "$SHRC" -eq 0 ]] && jq -e '.ok == true and (.result.terminal | type == "object")' <<<"$SHOWN" >/dev/null 2>&1 || {
  echo "could not verify the terminal identity; do not close anything" >&2
  exit 1
}
if [[ "$(jq -r '.result.terminal.handle // empty' <<<"$SHOWN")" == "$TH" \
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
TH=$(jq -r '.design.terminal // empty' "$SD/workers.json" 2>/dev/null)
DID=$(jq -r '.design.dispatch // empty' "$SD/workers.json" 2>/dev/null)
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
  retained|already_released) ;;
  *) echo "release state '${STATE:-unknown}' does not authorise C3" >&2; exit 1 ;;
esac
SHRC=0; SHOWN=$("$ORCA_BIN" terminal show --terminal "$TH" --json 2>/dev/null) || SHRC=$?
[[ "$SHRC" -eq 0 ]] && jq -e '.ok == true and (.result.terminal | type == "object")' <<<"$SHOWN" >/dev/null 2>&1 || {
  echo "could not verify the terminal identity; do not remove anything" >&2
  exit 1
}
IDENTITY_OK=no
if [[ "$(jq -r '.result.terminal.handle // empty' <<<"$SHOWN")" == "$TH" \
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

`IDENTITY_OK` は [C3] の中で計算する。[C2] から shell 変数を持ち込まない。この block 内で handle と
worktree が一致したときだけ `yes` になる。
worker が Step 3 で exit 5 を返したときは `MERGED` が false であり、削除を提示しない。
これは意図した動作であって欠落ではない。

ユーザーへ、次を平易な言葉で伝える。

- [C1] `release_pending` と `release_unknown` は release が完了していない状態である。端末を閉じたり
  手動 acknowledge したりして補おうとしない。再試行するのは `release_pending` だけであり、
  `release_unknown` では receipt と result を確認しても、ユーザーが guarded manual integration を選んだ
  場合を含め、元の親 queue は blocked のままにする。
- [C2] handle と worktree が記録済み state に一致する端末だけを閉じてよい。一致しなければ、
  すでに他者の所有物である。
- [C3] 削除コマンドは、成果が merge 済み、この dispatch が worktree を作成した、checkout が
  読めて clean、端末 identity が一致、worktree にまだ残る端末すべてが記録済み、の全条件を
  満たすときだけ表示する。再利用 worktree は最初からこちらのものではないため、削除を提示しない。
  **端末を列挙できないことは「存在しない」ことではない。何も証明されないのでコマンドを表示しない。**
- [C4] `worktree rm` は branch の削除も試みる。Orca は変更が merge 済みと証明できない branch を
  残すので、branch が残ることは失敗ではなく合図である。ユーザーが dirty なファイルを見て失っても
  よいと判断するまで、`--force` を加えない。

## 既知の制限

該当するときは、黙って回避せずユーザーへ伝える。

| 制限 | ユーザーがすること |
|---|---|
| 自動で片付けるものはない | Step 5 のコマンドを実行する |
| セッションが dispatch の途中で終了しても、自動回復しない | `$ORCA_BIN orchestration task-list --run <run_id> --json` と `$ORCA_BIN orchestration worker-show --dispatch <id> --json` で調べ、Step 5 と同様に片付ける |
| worker が報告せずに停止すると、待機は timeout する | 同じ inspection を行う。状態は `.dispatch/<slug>/` にある |
| worker は質問できない | 代わりに `result.md` へ理由を書いて失敗として終了するよう指示してある。読んで再度 dispatch する |
| runner は固定で設定できず、`claude --dangerously-skip-permissions` で実行される | 信頼できるタスクだけを dispatch する。worker は permission prompt を出さない |
| setup hook を必要とする repository は対象外 | worktree は setup を skip して作る |
| `release_unknown` batch は元の親 terminal の queue を block する | acknowledge しない。`received.json` と `result.md` を確認する。guarded manual integration でも queue は解消されない。後続の dispatch は別の Orca terminal から開始し、launch 時にはその `ORCA_TERMINAL_HANDLE` が使われる |

## ディスク上の状態

`.dispatch/<slug>/` には `request.md`、`run.json`、`workers.json`、`received.json`、
`integration-result.json`、`run-design.sh`、`roles/design/{status.json,result.md}` がある。
手で再開・片付けするために必要なものはすべてここにある。`.dispatch/` は repository の
`info/exclude` に加えるため、ユーザーの `git status` には現れない。
