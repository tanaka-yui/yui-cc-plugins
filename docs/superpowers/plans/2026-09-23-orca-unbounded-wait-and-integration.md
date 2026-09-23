# 子の待機上限撤廃・停滞監視・取り込み方の事前質問 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** orca-team-dispatch-task の子が自分から待機をやめないようにし、停滞は親が検知してユーザーに止めるかを尋ね、取り込み方（merge / PR）を dispatch 前に毎回尋ねる。

**Architecture:** 子の指示文（`orca-start.sh`）と `completion.sh` から期限を外す。`orca-wait.sh` がタスク単位の無変化時間を見て exit 8 で抜け、新設の `orca-stop.sh` がユーザーの選んだ役を「記録してから閉じる」。止めた役は `stopped.json` で決着済みとして集約する。取り込み方は `orca-start.sh --integration` で `workers.json` に記録し、merge / PR の両スクリプトが記録と違う方を拒む。

**Tech Stack:** bash（`set -uo pipefail`）、jq、git、Orca CLI（テストは `test/lib/orca-stub.sh`）。

**Spec:** `docs/superpowers/specs/2026-09-23-orca-unbounded-wait-and-integration-design.md`

## Global Constraints

- 作業ディレクトリ: `apps/orca-team-dispatch-task`（以下のパスはここからの相対。docs はリポジトリルートから）
- テスト実行: `bash test/<name>.sh`（各テストは最後に `failures: N` を出し、0 件で exit 0）。全体は `bash test/run-all.sh`
- シェルスクリプトのコメントは日本語、既存の `# ★ **...**` の書き方に揃える。変数名・関数名・CLI フラグは英語
- `SKILL.md` は英語のみ（日本語文字を入れない）。`references/guide-ja.md` は SKILL.md の完全な写し（見出し 1:1、**bash block は一字一句同じ順で写す**）。SKILL.md を変えたら同じ commit で guide-ja.md も変える
- 値のハードコードを避ける: 時間の既定値はフラグか `ORCA_*` 環境変数で上書きできる形にする（既存の `ORCA_WAKE_INTERVAL_SECONDS` と同じ構え）
- `stat` の flag は GNU / BSD で違う。ファイル時刻は `orca-wait.sh` の `file_mtime` 1 箇所だけで取る
- バージョン: `.claude-plugin/plugin.json` / `.codex-plugin/plugin.json` / ルート `.claude-plugin/marketplace.json` を 3.5.1 → 3.6.0（Task 8）
- commit メッセージは日本語、`<type>(orca-dispatch): ...` 形式。末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- 新しいテストファイルは `test/run-all.sh` の `SUITE` に足す（足さないと `MISSING FROM SUITE` で落ちる）

## Review Focus

1. **質問に数時間かけて答えたあとの呼び直し** — `questions.json` は答えた時刻を持たない。取り次ぎ済みとして通した時点で `human.json` を書かないと、呼び直した直後に exit 8 になる（Task 5 の WT88）
2. **止めた役の worker_done が、閉じる直前に届いていた** — receipt は記録し、閉じた端末に `worker-retain` をかけない（かけると exit 4 に落ちる）。矛盾扱いもしない（Task 3 の WT83b）
3. **兄弟タスクが全部終わっていて 1 つだけ動いている** — 決着済みのタスクを停滞として報告しない（Task 5 の WT91）
4. **旧版で起動した status dir（`workers.json` に `integration` が無い）** — merge も PR も今までどおり通す（Task 7 の MG22 / PR16）
5. **`--on-stall report` で停滞が続く** — 同じ停滞を毎周 log に出さない。動き出したら `detected_at` を消し、次の停滞をまた 1 回だけ出す（Task 5 の WT90）

---

### Task 1: `completion.sh` の待機期限を撤廃する

**Files:**
- Modify: `skills/orca-team-dispatch-task/scripts/completion.sh:38-43`（期限の定義）、`:77-81`（`sent`）、`:92`（コメント）、`:115-117` と `:143-145`（`expired` 判定）
- Test: `test/test-completion.sh:248-264`（CM22 / CM22b / CM23）、`:296-303`（CM27b）

**Interfaces:**
- Produces: `completion.sh --role-dir <d> await` の出力は `accepted` / `remediation <本文>` / `waiting` の 3 種のみ。`completion.json` に `await_deadline` を書かない。環境変数 `ORCA_AWAIT_TOTAL_SECONDS` は廃止

- [ ] **Step 1: 失敗するテストに書き換える**

`test/test-completion.sh` の CM22 から CM23 まで（`# CM22:` の行から CM23 の `ateardown` まで）を次で置き換える:

```bash
# CM22: ★ **待機に期限を置かない。**worker は待っている相手の事情（人の回答待ちなど）を
#      知らないので、「来ない」を判断させない。`sent` は期限を記録しない。
asetup
[[ -z "$(jq -r '.await_deadline // empty' "$D/completion.json")" ]] \
  && ok "CM22 sent は期限を記録しない" || fail "CM22"
ateardown

# CM22b: 旧版が書いた期限が残っていても expired を返さない（待ち続ける）。
asetup
upd=$(jq -c --argjson t "$(( $(date +%s) - 1 ))" '.await_deadline = $t' "$D/completion.json")
printf '%s\n' "$upd" > "$D/completion.json"
out=$(aw 2>/dev/null); rc=$?
[[ "$rc" -eq 0 && "$out" == waiting ]] && ok "CM22b 古い期限では降りない" || fail "CM22b (rc=$rc out=$out)"
ateardown

# CM23: 旧版の期限が残っていても、届いている accepted は受理する。
asetup; reply accepted "$N"
upd=$(jq -c --argjson t "$(( $(date +%s) - 1 ))" '.await_deadline = $t' "$D/completion.json")
printf '%s\n' "$upd" > "$D/completion.json"
out=$(aw 2>/dev/null)
[[ "$out" == accepted ]] && ok "CM23 古い期限があっても accepted を拾う" || fail "CM23 ($out)"
ateardown
```

CM27b（`# CM27b:` から最後の `ateardown` まで）を次で置き換える:

```bash
# CM27b: waiter_exists が続き、旧版の期限を越えていても waiting を返す（期限で降りない）。
asetup
printf '%s\n' '{"ok":false,"error":{"code":"waiter_exists","message":"a waiter is already active"}}' \
  > "$ORCA_STUB_DIR/orchestration_check"
upd=$(jq -c --argjson t "$(( $(date +%s) - 1 ))" '.await_deadline = $t' "$D/completion.json")
printf '%s\n' "$upd" > "$D/completion.json"
out=$(ORCA_WAITER_RETRY_SECONDS=0 aw 2>/dev/null); rc=$?
[[ "$rc" -eq 0 && "$out" == waiting ]] && ok "CM27b 期限では降りない" || fail "CM27b (rc=$rc out=$out)"
ateardown
```

- [ ] **Step 2: 失敗を確かめる**

Run: `bash test/test-completion.sh 2>&1 | grep -E 'CM22|CM27b|failures'`
Expected: `FAIL: CM22`、`FAIL: CM22b (rc=0 out=expired)`、`FAIL: CM27b (rc=0 out=expired)`、`failures: 3`

- [ ] **Step 3: 実装する**

`completion.sh` の期限定義（`# ★ **待つのは 24 時間。**` から `AWAIT_TOTAL_SECONDS=...` の行まで）を次で置き換える:

```bash
# ★ **待機に期限を置かない。**worker は待っている相手の事情（人の回答待ちなど）を知らない
#   ので、「来ない」を判断できない。止めるかどうかは親がタスク全体を見て、ユーザーに尋ねる
#   （`orca-wait.sh` の停滞検知と `orca-stop.sh`）。1 回のブロックは 10 分（agent の shell の
#   上限）なので、待機は呼び直しで続ける。
AWAIT_WINDOW_MS="${ORCA_AWAIT_WINDOW_MS:-600000}"
```

`sent)` の書き込み（`# ★ **待機の期限はここで決まる。**` のコメント 2 行と、その下の `write "$(jq -c --argjson d ...` から `|| { log "cannot write $CJ"; exit 1; } ;;` まで）を次で置き換える:

```bash
    write "$(jq -c '.phase = "merge_ready_sent"' "$CJ")" \
      || { log "cannot write $CJ"; exit 1; } ;;
```

`await)` 冒頭コメントの `# 出力は 1 行: accepted / remediation <本文> / waiting / expired` を `# 出力は 1 行: accepted / remediation <本文> / waiting` に変える。

`waiter_exists` の分岐から次の 2 行を削除する:

```bash
        DL=$(read_field await_deadline)
        if [[ "$DL" =~ ^[0-9]+$ ]] && [[ "$(date +%s)" -ge "$DL" ]]; then echo expired; exit 0; fi
```

返事を探したあとの次の 3 行（コメント 1 行 + 2 行）を削除する:

```bash
    # ★ **期限の判定は返事を探したあと。**時計より届いている事実が優先する。
    DL=$(read_field await_deadline)
    if [[ "$DL" =~ ^[0-9]+$ ]] && [[ "$(date +%s)" -ge "$DL" ]]; then echo expired; exit 0; fi
```

transport 障害のコメント 2 行目 `#   24 時間叩き続けることになる。` を `#   際限なく叩き続けることになる。` に変える（1 行目 `# ★ **transport の障害を「返事が無い」と混ぜない。**混ぜると、壊れた経路を` はそのまま）。

- [ ] **Step 4: 通ることを確かめる**

Run: `bash test/test-completion.sh 2>&1 | tail -1 && grep -n 'expired\|await_deadline\|AWAIT_TOTAL' skills/orca-team-dispatch-task/scripts/completion.sh`
Expected: `failures: 0`、grep は何も出さない

- [ ] **Step 5: Commit**

```bash
git add skills/orca-team-dispatch-task/scripts/completion.sh test/test-completion.sh
git commit -m "fix(orca-dispatch): 完了の返事待ちに期限を置かない

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 子への指示文から待機上限を外し、`review-skipped:` を教える

**Files:**
- Modify: `bin/orca-start.sh:308-321`（STATUS PROTOCOL の step E）、`:383-385`（REVIEW LOOP step 1 の末尾）、`:433-462`（REVIEW PROTOCOL step 3 と step 6）
- Test: `test/test-start.sh:809-813`（ST67）、末尾に ST89 / ST90 を追加

**Interfaces:**
- Consumes: Task 1 の `await` の 3 出力
- Produces: 依頼側（design / exec）の指示文は subject `review-skipped:` を「reviewer が親に止められた」として扱う。Task 4 の `orca-stop.sh` がこの subject を送る

- [ ] **Step 1: 失敗するテストを書く**

`test/test-start.sh` の ST67 を次で置き換える:

```bash
# ST67: 完了の待機は `completion.sh await` の呼び直しで、その 3 つの答えが spec に載る。
#      **`expired` は載せない** — worker は自分の時計で待機をやめない。
setup; start >/dev/null 2>&1; sp=$(spec); miss=""
for w in 'completion.sh --role-dir' ' await' 'accepted' 'remediation' 'waiting'; do
  [[ "$sp" == *"$w"* ]] || miss="$miss [$w]"; done
[[ "$sp" == *'expired'* ]] && miss="$miss [expired-present]"
[[ -z "$miss" ]] && ok "ST67 await の 3 つの答えが載る" || fail "ST67:$miss"; teardown
```

ファイル末尾の `echo "failures: $fails"` の直前に追加する:

```bash
# ST89: ★ **子に待機の期限を持たせない。**2026-09-23: design が brainstorm でユーザーの回答を
#      待つ間に、reviewer が「1 時間依頼なし」で自分から終了し、レビューが付かなかった。
setup; review_on; start >/dev/null 2>&1
specs=$(grep 'orchestration task-create' "$ORCA_STUB_DIR/calls.log")
rv=$(head -1 <<<"$specs"); dz=$(tail -1 <<<"$specs"); bad=""
for s in "$rv" "$dz"; do
  for w in 'six times' 'one hour' 'another hour' '24 hours'; do
    [[ "$s" == *"$w"* ]] && bad="$bad [$w]"; done
  [[ "$s" == *'no time limit'* ]] || bad="$bad [no-time-limit]"
done
[[ -z "$bad" ]] && ok "ST89 待機に期限を書かない" || fail "ST89:$bad"; teardown

# ST90: 依頼側は `review-skipped:` を「reviewer が止められた」と読み、レビュー無しで進む。
setup; review_on; start >/dev/null 2>&1
dz=$(grep 'orchestration task-create' "$ORCA_STUB_DIR/calls.log" | tail -1)
[[ "$dz" == *'review-skipped:'* && "$dz" == *'Skip step 7'* ]] \
  && ok "ST90 review-skipped の扱いが載る" || fail "ST90"; teardown
```

- [ ] **Step 2: 失敗を確かめる**

Run: `bash test/test-start.sh 2>&1 | grep -E 'ST67|ST89|ST90|failures'`
Expected: `FAIL: ST67: [expired-present]`、`FAIL: ST89: ...`、`FAIL: ST90`

- [ ] **Step 3: 実装する**

`bin/orca-start.sh` の STATUS PROTOCOL step E の箇条書き（`- \`waiting\` -> nobody has answered yet.` から `like \`expired\`.` まで）を次で置き換える:

```
   - \`waiting\` -> nobody has answered yet. **Run it again, in this same turn.** Keep
     running it. It is normal for this to take several rounds. **This wait has no time
     limit:** whether a stalled task should stop is decided by the user through the parent,
     not by you.
   A non-zero exit means the mailbox could not be read at all; try once more. If it fails
   again, write that in result.md, run
   \`bash $q_rs $q_rd error the mailbox could not be read\`, and stop. Do not report done.
```

（`\`accepted\`` と `\`remediation <reason>\`` の 2 行はそのまま残す。）

REVIEW LOOP step 1 の末尾 2 行:

```
   If the wait returns nothing, run it again, in this same turn. Give up and go to step 5
   only once it has come back empty six times in a row (one hour).
```

を次で置き換える:

```
   If the wait returns nothing, run it again, in this same turn. **This wait has no time
   limit.** Keep waiting until a request or \`abort-reviewer:\` arrives, however long that
   takes: the worker you review may be waiting on a person. Whether a stalled task should
   stop is decided by the user through the parent, not by you.
```

REVIEW PROTOCOL（`render_review_block` 内の文字列）step 3 の `Use --peek. **Never pass --ack.** Look for a subject starting \`review-verdict:\`.` の行を次で置き換える:

```
   Use --peek. **Never pass --ack.** Look for a subject starting \`review-verdict:\`.
   A subject starting \`review-skipped:\` means the parent stopped your reviewer: go to step 6.
```

同じ step 3 の `turn closed here is a dispatch that stops for good. If the wait returns nothing, run it` / `again, in this same turn — reviewing takes longer than one wait.` の 2 行を次で置き換える:

```
   turn closed here is a dispatch that stops for good. If the wait returns nothing, run it
   again, in this same turn — reviewing takes longer than one wait. **This wait has no time
   limit.** Do not skip the review because nothing has arrived yet.
```

同じ step 3 の `the review as skipped because of it** — only the empty waits in step 6 justify that.` を次にする:

```
   the review as skipped because of it** — only a \`review-skipped:\` message justifies that.
```

step 6（`6. Once the wait has come back empty six times in a row (one hour), send the same round` から `and proceed.` まで 3 行）を次で置き換える:

```
6. On \`review-skipped:\`, your reviewer is gone. Note in result.md that round <n> was not
   reviewed because the reviewer was stopped, and proceed without review. Skip step 7.
```

- [ ] **Step 4: 通ることを確かめる**

Run: `bash test/test-start.sh 2>&1 | tail -1`
Expected: `failures: 0`

- [ ] **Step 5: Commit**

```bash
git add bin/orca-start.sh test/test-start.sh
git commit -m "fix(orca-dispatch): reviewer と依頼側が自分の時計で待機をやめないようにする

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `orca-wait.sh` で止めた役（`stopped.json`）を決着済みとして扱う

**Files:**
- Modify: `bin/orca-wait.sh`（`stored_outcome` の直後に関数追加、`rewake_stalled` / `healthy` / `aggregate` / `finish` / `drain` の merge_ready 分岐と retain ループ）
- Test: `test/test-wait.sh`（末尾に WT80〜WT83b）

**Interfaces:**
- Produces:
  - `is_stopped <status dir> <role>` → `<sd>/roles/<role>/stopped.json` があれば 0
  - `role_outcome <status dir> <role>` → receipt の outcome を stdout。receipt が無く止めた役なら `stopped`。記録が壊れていれば 1
  - 最終行 `task=... role=<r> ... outcome=stopped`。成果を載せる役（`integration_role`）が stopped ならタスクは failed（exit 5）。reviewer が stopped でも failed にしない
- Consumes: なし（`stopped.json` の形は `{"stopped_at": <epoch>, "by": "user"}`。Task 4 が書く）

- [ ] **Step 1: 失敗するテストを書く**

`test/test-wait.sh` 末尾の `echo "failures: $fails"` の直前に追加する:

```bash
# ── ユーザーが止めた役（orca-stop.sh が stopped.json を書く）──
two_roles() {
  jq -nc '{integration_role:"design",roles:{
    design:{terminal:"term_w",task:"task_x",dispatch:"ctx_x",retained:false},
    design_review:{terminal:"term_r",task:"task_r",dispatch:"ctx_r",retained:false}}}' > "$SD/workers.json"
  mkdir -p "$SD/roles/design_review"
}
stop_role() { mkdir -p "$SD/roles/$1"; echo '{"stopped_at":1,"by":"user"}' > "$SD/roles/$1/stopped.json"; }
# 閉じた端末の worker-show は stopped を返す。reviewer（ctx_r）だけそう返す stub
reviewer_closed() {
  cat > "$ORCA_STUB_DIR/orchestration_worker-show.hook" <<'HOOK'
#!/usr/bin/env bash
case "$*" in *ctx_r*) s=stopped ;; *) s=active ;; esac
printf '{"ok":true,"result":{"worker":{"state":"%s"}}}\n' "$s" > "$ORCA_STUB_DIR/orchestration_worker-show"
HOOK
  chmod +x "$ORCA_STUB_DIR/orchestration_worker-show.hook"
}

# WT80: ★ **成果を載せる役を止めたら、そのタスクは失敗で終わる。**status は書きかけの
#      executing のまま残るので、status を待つと永久に終わらない。
setup; stop_role design
echo '{"ok":true,"result":{"worker":{"state":"stopped"}}}' > "$ORCA_STUB_DIR/orchestration_worker-show"
out=$(w 2>/dev/null); rc=$?
[[ "$rc" -eq 5 && "$out" == *"role=design dispatch=ctx_x status_dir=$SD outcome=stopped"* \
   && "$out" == *"outcome=failed"* ]] \
  && ok "WT80 止めた作る役は失敗で終わる" || fail "WT80 (rc=$rc out=$out)"; teardown

# WT81: ★ **止めた役に worker-show をかけない。**閉じた端末は stopped を返し、かけると
#      まだ働いている兄弟ごと exit 4 で落ちる。
setup; two_roles; stop_role design_review; reviewer_closed
w 1 >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 3 ]] && ok "WT81 止めた役を health check にかけない" || fail "WT81 (rc=$rc)"; teardown

# WT82: reviewer を止めても、成果が成功ならタスクは成功。その役の行は outcome=stopped。
setup; two_roles; stop_role design_review; reviewer_closed; dn
echo '["worker_done|task_x|ctx_x|succeeded"]' > "$SD/received.json"
out=$(w 2>/dev/null); rc=$?
[[ "$rc" -eq 0 && "$out" == *"role=design_review dispatch=ctx_r status_dir=$SD outcome=stopped"* ]] \
  && ok "WT82 止めた reviewer はタスクを失敗にしない" || fail "WT82 (rc=$rc out=$out)"; teardown

# WT83: ★ **止めた役の merge_ready には返事をしない**（端末は閉じている）。batch は処理済みにする。
setup; two_roles; stop_role design_review; reviewer_closed
jq -nc '{ok:true,result:{runId:"run_x",deliveryId:"dmr",count:1,messages:[
  {id:"mr",type:"merge_ready",subject:"merge_ready: n1",
   payload:({taskId:"task_r",dispatchId:"ctx_r"}|tojson),body:""}]}}' > "$ORCA_STUB_DIR/orchestration_check"
w 1 >/dev/null 2>&1
! tr '\037' '\n' < "$ORCA_STUB_DIR/argv.log" | grep -q '^completion-' \
  && grep -q -- '--ack dmr' "$ORCA_STUB_DIR/calls.log" \
  && ok "WT83 止めた役の merge_ready に答えない" || fail "WT83"; teardown

# WT83b: ★ **閉じる直前に届いた worker_done は記録するが、retain しない。**閉じた端末に
#       retain をかけると失敗し、batch が永久に ack されない。
setup; two_roles; stop_role design_review; reviewer_closed
jq -nc '{ok:true,result:{runId:"run_x",deliveryId:"dwd",count:1,messages:[
  {id:"wd",type:"worker_done",payload:({taskId:"task_r",dispatchId:"ctx_r",outcome:"succeeded"}|tojson),body:""}]}}' \
  > "$ORCA_STUB_DIR/orchestration_check"
w 1 >/dev/null 2>&1
grep -q 'worker_done|task_r|ctx_r|succeeded' "$SD/received.json" 2>/dev/null \
  && ! grep 'worker-retain' "$ORCA_STUB_DIR/calls.log" | grep -q ctx_r \
  && grep -q -- '--ack dwd' "$ORCA_STUB_DIR/calls.log" \
  && ok "WT83b 止めた役の receipt は記録し retain しない" || fail "WT83b"; teardown
```

- [ ] **Step 2: 失敗を確かめる**

Run: `bash test/test-wait.sh 2>&1 | grep -E 'WT8[0-3]|failures'`
Expected: WT80 / WT81 / WT82 / WT83 / WT83b がすべて FAIL

- [ ] **Step 3: 実装する**

`bin/orca-wait.sh` の `stored_outcome() { ... }` の閉じ括弧の直後に追加する:

```bash
# ★ **ユーザーが止めた役は決着済みとして扱う**（`orca-stop.sh`）。止めた端末は閉じてあり、
#   worker_done は二度と来ない。**receipt が在ればそれが優先する**（閉じる直前に送られた場合）。
is_stopped() { [[ -f "$1/roles/$2/stopped.json" ]]; }
role_outcome() {   # $1=status dir $2=role → receipt の outcome、無ければ止めた役は stopped。壊れていれば 1
  local oc
  oc=$(stored_outcome "$1" "$2") || return 1
  if [[ -z "$oc" ]] && is_stopped "$1" "$2"; then oc=stopped; fi
  printf '%s' "$oc"
}
```

次の 4 箇所の `stored_outcome` を `role_outcome` に置き換える（引数は同じ）:
- `rewake_stalled` 内: `settled=$(stored_outcome "${T_SD[$i]}" "${T_ROLE[$i]}") || settled=""`
- `healthy` 内: `settled=$(stored_outcome "${T_SD[$i]}" "${T_ROLE[$i]}") || settled=""`
- `aggregate` の最初のループ: `existing=$(stored_outcome "${T_SD[$i]}" "${T_ROLE[$i]}") || return 1`
- `finish` 内: `oc=$(stored_outcome "${T_SD[$i]}" "${T_ROLE[$i]}") || oc=""`

（`drain` 内と `aggregate` の 2 つ目のループの `stored_outcome` は receipt そのものとの比較なので**変えない**。）

`aggregate` の 2 つ目のループで、`[[ -n "$irole" ]] || irole=design` の直後に追加する:

```bash
    # ★ 成果を載せる役をユーザーが止めたら、そのタスクは失敗である。status は書きかけの
    #   まま残るので、status を待つと永久に終わらない
    if is_stopped "$sd" "$irole" && [[ -z "$(stored_outcome "$sd" "$irole" 2>/dev/null)" ]]; then
      worst=failed; continue
    fi
```

`drain` の merge_ready 分岐で、`idx` が見つからないときの `return 7` ブロック（`fi`）の直後に追加する:

```bash
      # ★ **止めた役には返事をしない。**端末は閉じており、受理を送っても読む者は居ない
      if is_stopped "${T_SD[$idx]}" "${T_ROLE[$idx]}"; then
        log "ignoring merge_ready from ${T_ROLE[$idx]} (dispatch $did): the user stopped it"
        continue
      fi
```

`drain` の retain ループで、`[[ -n "$existing" ]] || record_outcome "$tsd" "$tid" "$did" "$oc" || return $?` の直後に追加する:

```bash
    # ★ 止めた役は端末を閉じてある。保持する資源が無いので retain をかけない
    #   （かけると失敗して batch が ack されず、同じ batch を永久に読み直す）
    is_stopped "$tsd" "$trole" && continue
```

- [ ] **Step 4: 通ることを確かめる**

Run: `bash test/test-wait.sh 2>&1 | tail -1`
Expected: `failures: 0`

- [ ] **Step 5: Commit**

```bash
git add bin/orca-wait.sh test/test-wait.sh
git commit -m "feat(orca-dispatch): ユーザーが止めた役を待機で決着済みとして扱う

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `bin/orca-stop.sh` を作る

**Files:**
- Create: `bin/orca-stop.sh`
- Create: `test/test-stop.sh`
- Modify: `test/run-all.sh:4`（`SUITE` に `test-stop` を追加）

**Interfaces:**
- Consumes: `bin/orca-send.sh --workers <wf> --to <role> --subject <s> --body <b>`（配送後に自分で `orca-wake.sh` を呼ぶ）。Task 3 の `stopped.json` の意味
- Produces:
  - `orca-stop.sh --status-dir <sd> --role <role>` — 0 = 止めた（決着済みで何もしなかった場合を含む）/ 1 = 止め切れなかった（記録できない・端末を閉じられない・端末が未記録）/ 2 = 使用法
  - `orca-stop.sh --status-dir <sd> --snooze` — `stall.json` の `snoozed_at` を今にし `detected_at` / `idle_min` を消す
  - `--role` も記録のあとに snooze と同じ書き込みをする（止めた直後に同じタスクがまた停滞判定されないように）
  - reviewer（`design_review` / `exec_review`）を止めたら、依頼側（`design` / `exec`）へ subject `review-skipped: stopped by the user` を送る

- [ ] **Step 1: 失敗するテストを書く**

`test/test-stop.sh` を作る:

```bash
#!/usr/bin/env bash
# ユーザーが選んだ役を止める。**記録してから閉じる**ことと、**止め切れなかったら
# 止め切れなかったと言う**ことが全部である。
set -uo pipefail
P="$(cd "$(dirname "$0")/.." && pwd)"
S="$P/bin/orca-stop.sh"
fails=0; ok() { echo "PASS: $1"; }; fail() { echo "FAIL: $1"; fails=$((fails+1)); }

setup() {
  ORCA_STUB_DIR=$(mktemp -d); export ORCA_STUB_DIR ORCA_BIN="$P/test/lib/orca-stub.sh"
  export ORCA_TERMINAL_HANDLE=term_p
  : > "$ORCA_STUB_DIR/calls.log"; : > "$ORCA_STUB_DIR/argv.log"
  SD=$(mktemp -d); mkdir -p "$SD/roles/design"
  printf '{"run_id":"run_x","parent_handle":"term_p","repo_root":"/tmp"}\n' > "$SD/run.json"
  jq -nc '{integration_role:"design",roles:{
    design:{terminal:"term_w",task:"task_x",dispatch:"ctx_x"},
    design_review:{terminal:"term_r",task:"task_r",dispatch:"ctx_r"}}}' > "$SD/workers.json"
  echo '{"ok":true,"result":{"message":{"id":"m1"}}}' > "$ORCA_STUB_DIR/orchestration_send"
  echo '{"ok":true,"result":{"worker":{"state":"active"},"dispatch":{"status":"dispatched"}}}' \
    > "$ORCA_STUB_DIR/orchestration_worker-show"
}
teardown() { rm -rf "$ORCA_STUB_DIR" "$SD"; unset ORCA_BIN ORCA_STUB_DIR ORCA_TERMINAL_HANDLE; }
st() { bash "$S" --status-dir "$SD" "$@"; }
argv() { tr '\037' '\n' < "$ORCA_STUB_DIR/argv.log"; }

# SP1: 使用法。--role と --snooze はどちらか 1 つだけ
setup; st >/dev/null 2>&1; a=$?; st --role design --snooze >/dev/null 2>&1; b=$?
bash "$S" --role design >/dev/null 2>&1; c=$?
[[ "$a" -eq 2 && "$b" -eq 2 && "$c" -eq 2 ]] && ok "SP1 使用法エラー" || fail "SP1 ($a/$b/$c)"; teardown

# SP2: ★ **reviewer を止める。**記録 → 端末を閉じる → 依頼側へ review-skipped。時計も数え直す
setup; st --role design_review >/dev/null 2>&1; rc=$?
cl=$(grep 'terminal close' "$ORCA_STUB_DIR/calls.log" | head -1)
[[ "$rc" -eq 0 && -f "$SD/roles/design_review/stopped.json" \
   && "$(jq -r '.by' "$SD/roles/design_review/stopped.json")" == user \
   && "$cl" == *'--terminal term_r'* ]] \
  && argv | grep -qx 'review-skipped: stopped by the user' \
  && argv | grep -qx 'dispatch:ctx_x' \
  && [[ "$(jq -r '.snoozed_at' "$SD/stall.json")" =~ ^[0-9]+$ ]] \
  && ok "SP2 reviewer を止めて依頼側を進ませる" || fail "SP2 (rc=$rc cl=$cl)"; teardown

# SP3: ★ **記録できなければ閉じない。**記録の無い停止は、待機からは worker の消失に見える
setup; : > "$SD/roles/design_review"   # 役 dir の位置に通常ファイルを置き、記録を失敗させる
st --role design_review >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 1 ]] && ! grep -q 'terminal close' "$ORCA_STUB_DIR/calls.log" \
  && ok "SP3 記録できなければ閉じない" || fail "SP3 (rc=$rc)"; teardown

# SP4: 決着済みの役には何もしない
setup; echo '["worker_done|task_r|ctx_r|succeeded"]' > "$SD/received.json"
st --role design_review >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 0 && ! -e "$SD/roles/design_review/stopped.json" ]] \
  && ! grep -q 'terminal close' "$ORCA_STUB_DIR/calls.log" \
  && ok "SP4 決着済みには触らない" || fail "SP4 (rc=$rc)"; teardown

# SP5: 閉じられなければ 1。ただし記録は残す（待機は止めた役として扱える）
setup; echo 1 > "$ORCA_STUB_DIR/terminal_close.rc"
st --role design_review >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 1 && -f "$SD/roles/design_review/stopped.json" ]] \
  && ok "SP5 閉じられなくても記録は残す" || fail "SP5 (rc=$rc)"; teardown

# SP6: --snooze は snoozed_at を今にし、detected_at を消す
setup; echo '{"detected_at":5,"idle_min":130}' > "$SD/stall.json"
st --snooze >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 0 && "$(jq -r '.snoozed_at' "$SD/stall.json")" =~ ^[0-9]+$ ]] \
  && jq -e 'has("detected_at") | not' "$SD/stall.json" >/dev/null \
  && ok "SP6 snooze" || fail "SP6 (rc=$rc)"; teardown

# SP7: 作る役を止めても review-skipped は送らない（送る相手が居ない）
setup; st --role design >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 0 && -f "$SD/roles/design/stopped.json" ]] \
  && ! grep -q 'orchestration send' "$ORCA_STUB_DIR/calls.log" \
  && ok "SP7 作る役を止めても review-skipped を送らない" || fail "SP7 (rc=$rc)"; teardown

# SP8: dispatch の記録が無い役は止められない（何を止めるか分からない）
setup; st --role exec >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 1 && ! -e "$SD/roles/exec/stopped.json" ]] \
  && ok "SP8 記録の無い役は止めない" || fail "SP8 (rc=$rc)"; teardown

echo "failures: $fails"; [[ "$fails" -eq 0 ]]
```

`test/run-all.sh` の `SUITE=` 行で `test-recover` の直後に ` test-stop` を足す:

```bash
SUITE="test-start test-config test-send test-wake test-issue-fetch test-issue test-pr test-completion test-recover test-stop test-wait test-merge test-report-status test-docs test-e2e"
```

- [ ] **Step 2: 失敗を確かめる**

Run: `bash test/test-stop.sh 2>&1 | tail -2`
Expected: SP1〜SP8 が FAIL（スクリプトが無い）、`failures: 8`

- [ ] **Step 3: 実装する**

`bin/orca-stop.sh` を作り、`chmod +x bin/orca-stop.sh` する:

```bash
#!/usr/bin/env bash
# orca-stop.sh — ユーザーが止めると決めた役を止める / 停滞の判定を数え直す。
#
# Usage: orca-stop.sh --status-dir <d> --role <role>
#        orca-stop.sh --status-dir <d> --snooze
# Exit:  0 = 止めた（決着済みで何もしなかった場合を含む）/ 1 = 止め切れなかった / 2 = 使用法エラー
#
# ★ **止めるかどうかを決めるのはユーザーである。**子は待機に期限を持たず、親（`orca-wait.sh`）は
#   停滞を見つけて exit 8 で知らせるだけで、自分では何も止めない。これはユーザーが選んだあとに
#   親が呼ぶ口である。
#
# ★ **止まっている子が協力してくれる前提を置かない。**止めたいのは応答しない子なので、
#   message で「終われ」と頼むのではなく、端末を閉じる。
#
# ★ **記録してから閉じる。**`stopped.json` の無いまま閉じると、`orca-wait.sh` からは worker が
#   消えたように見え、exit 4 と `orca-recover.sh` の置き換えに回ってしまう。

set -uo pipefail
die() { echo "orca-stop: $1" >&2; exit 2; }
log() { echo "orca-stop: $1" >&2; }
ORCA_BIN="${ORCA_BIN:-${ORCA_CLI_COMMAND:-/Applications/Orca.app/Contents/Resources/bin/orca}}"
need2() { [[ "$2" -ge 2 ]] || die "$1 requires a value"; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SD="" ROLE="" SNOOZE=0
while [[ $# -gt 0 ]]; do case "$1" in
  --status-dir) need2 "$1" $#; SD="$2";   shift 2 ;;
  --role)       need2 "$1" $#; ROLE="$2"; shift 2 ;;
  --snooze)     SNOOZE=1; shift ;;
  *) die "unknown option: $1" ;; esac; done
[[ -n "$SD" ]] || die "--status-dir is required"
if [[ "$SNOOZE" -eq 1 ]]; then
  [[ -z "$ROLE" ]] || die "pass either --role or --snooze, not both"
else
  [[ -n "$ROLE" ]] || die "pass --role <role> or --snooze"
fi
[[ -r "$SD/workers.json" ]] || die "cannot read the dispatch state in $SD"

write() {   # $1=path $2=content
  local t
  t=$(mktemp "$SD/.tmp.XXXXXX") || return 1
  printf '%s\n' "$2" > "$t" && mv -f "$t" "$1" || { rm -f "$t"; return 1; }
}
# ★ **停滞の時計を今から数え直す。**止めた直後もタスクの最終変化時刻はまだ古いので、
#   数え直さないと次の周回で同じタスクがすぐ停滞に戻る。
snooze() {
  local cur upd
  cur=$(jq -c 'if type == "object" then . else {} end' "$SD/stall.json" 2>/dev/null) || cur='{}'
  [[ -n "$cur" ]] || cur='{}'
  upd=$(jq -c --argjson t "$(date +%s)" '.snoozed_at = $t | del(.detected_at, .idle_min)' <<<"$cur") \
    && [[ -n "$upd" ]] && write "$SD/stall.json" "$upd"
}

if [[ "$SNOOZE" -eq 1 ]]; then
  snooze || { log "could not record the snooze in $SD/stall.json"; exit 1; }
  log "the stall clock for $(basename "$SD") restarts now"
  exit 0
fi

TID=$(jq -r --arg r "$ROLE" '.roles[$r].task // empty' "$SD/workers.json" 2>/dev/null || echo "")
DID=$(jq -r --arg r "$ROLE" '.roles[$r].dispatch // empty' "$SD/workers.json" 2>/dev/null || echo "")
[[ -n "$TID" && -n "$DID" ]] || { log "role '$ROLE' has no dispatch recorded in $SD; nothing was stopped"; exit 1; }

# 1. 決着済みなら何もしない。止める対象がもう無い
if [[ -f "$SD/received.json" ]] \
   && jq -e --arg p "worker_done|$TID|$DID|" 'any(.[]; type == "string" and startswith($p))' \
        "$SD/received.json" >/dev/null 2>&1; then
  log "$ROLE has already settled; nothing to stop"
  exit 0
fi

# 2. 記録する。**書けなければ閉じない**
mkdir -p "$SD/roles/$ROLE" 2>/dev/null \
  && write "$SD/roles/$ROLE/stopped.json" "$(jq -nc --argjson t "$(date +%s)" '{stopped_at: $t, by: "user"}')" \
  || { log "could not record that $ROLE was stopped; its terminal was left open"; exit 1; }
snooze || log "could not restart the stall clock for $(basename "$SD"); the next wait may report it again"

RC=0
# 3. 端末を閉じる。閉じられなくても 2 の記録は残す（待機は止めた役として扱える）
TH=$(jq -r --arg r "$ROLE" '.roles[$r].terminal // empty' "$SD/workers.json" 2>/dev/null || echo "")
if [[ -z "$TH" ]]; then
  log "$ROLE has no terminal recorded; it is recorded as stopped, but nothing was closed"
  RC=1
else
  CRC=0; OUT=$("$ORCA_BIN" terminal close --terminal "$TH" --json 2>/dev/null) || CRC=$?
  if [[ "$CRC" -ne 0 ]] || ! jq -e '.ok == true' <<<"$OUT" >/dev/null 2>&1; then
    log "could not close the terminal of $ROLE ($TH, rc=$CRC); it is recorded as stopped, so close it by hand"
    RC=1
  else
    log "stopped $ROLE (terminal $TH)"
  fi
fi

# 4. reviewer を止めたら、レビューを待っている依頼側を進ませる。**送れなくても 1〜3 は覆さない**
case "$ROLE" in
  design_review) RQ=design ;;
  exec_review)   RQ=exec ;;
  *)             RQ="" ;;
esac
if [[ -n "$RQ" ]] && jq -e --arg r "$RQ" '.roles[$r].dispatch // empty | length > 0' "$SD/workers.json" >/dev/null 2>&1; then
  bash "$HERE/orca-send.sh" --workers "$SD/workers.json" --to "$RQ" \
    --subject 'review-skipped: stopped by the user' \
    --body "the $ROLE reviewer was stopped by the user; continue without review" >/dev/null \
    || log "could not tell $RQ that its reviewer was stopped; it may keep waiting for a verdict"
fi
exit "$RC"
```

- [ ] **Step 4: 通ることを確かめる**

Run: `bash test/test-stop.sh 2>&1 | tail -1 && bash test/run-all.sh 2>&1 | grep -E 'MISSING|FAILED|ALL GREEN'`
Expected: `failures: 0`、`MISSING` が出ない（他 suite の結果はこの時点では問わない）

- [ ] **Step 5: Commit**

```bash
git add bin/orca-stop.sh test/test-stop.sh test/run-all.sh
git commit -m "feat(orca-dispatch): ユーザーが選んだ役を記録してから止める orca-stop.sh を足す

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `orca-wait.sh` に停滞の検知（exit 8 / `--on-stall report`）を足す

**Files:**
- Modify: `bin/orca-wait.sh`（ヘッダの Usage / Exit、既定値と引数、`healthy` の agentWait 分岐、`drain` の question 分岐 2 箇所、関数追加、メインループ）
- Test: `test/test-wait.sh`（末尾に WT84〜WT92）

**Interfaces:**
- Consumes: Task 3 の `role_outcome`、Task 4 が書く `stall.json` の `snoozed_at`
- Produces:
  - 引数 `--stall-after-min <n>`（既定 120、正の整数）、`--on-stall ask|report`（既定 ask）。環境変数 `ORCA_STALL_AFTER_SECONDS` で秒単位に上書き可（テスト用）
  - exit 8 と stdout の行: `stalled task=<slug> status_dir=<sd> idle_min=<n>` と、役ごとに `stalled_role task=<slug> role=<role> phase=<phase> terminal=<handle>`
  - `<sd>/human.json`（`{"last_human_at": <epoch>}`）、`<sd>/stall.json` の `detected_at` / `idle_min`（report のとき）

- [ ] **Step 1: 失敗するテストを書く**

`test/test-wait.sh` 末尾の `echo "failures: $fails"` の直前に追加する:

```bash
# ── 停滞の検知（子は期限を持たないので、見つけるのは親である）──
old() { touch -t 202001010000 "$@"; }
STALL=3600

# WT84: 子が書くものが閾値を越えて変わらなければ exit 8。タスクと役を名指しする
setup; old "$SD/run.json" "$SD/roles/design/status.json"
out=$(ORCA_STALL_AFTER_SECONDS=$STALL w 2>/dev/null); rc=$?
b=$(basename "$SD")
[[ "$rc" -eq 8 && "$out" == *"stalled task=$b status_dir=$SD idle_min="* \
   && "$out" == *"stalled_role task=$b role=design phase=executing terminal=term_w"* ]] \
  && ok "WT84 停滞で 8" || fail "WT84 (rc=$rc out=$out)"; teardown

# WT85: 動いているタスクは停滞ではない（run.json も status.json も新しい）
setup; ORCA_STALL_AFTER_SECONDS=$STALL w >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 3 ]] && ok "WT85 動いていれば 8 にしない" || fail "WT85 (rc=$rc)"; teardown

# WT86: ★ **親が書くファイルは変化に数えない。**数えると親の鼓動で常に「変化あり」になる
setup; old "$SD/run.json" "$SD/roles/design/status.json"
echo '[]' > "$SD/received.json"; echo '[]' > "$SD/questions.json"; echo 1 > "$SD/roles/design/.woken"
ORCA_STALL_AFTER_SECONDS=$STALL w >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 8 ]] && ok "WT86 親の書き込みで時計を戻さない" || fail "WT86 (rc=$rc)"; teardown

# WT87: ★ **人を待っている役が居れば停滞ではない**（agentWait）。その時点を human.json に残す
setup; old "$SD/run.json" "$SD/roles/design/status.json"
echo '{"ok":true,"result":{"worker":{"state":"active"},"observation":{"agentWait":{"evidence":"hook"}}}}' \
  > "$ORCA_STUB_DIR/orchestration_worker-show"
ORCA_STALL_AFTER_SECONDS=$STALL w >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 3 && "$(jq -r '.last_human_at' "$SD/human.json" 2>/dev/null)" =~ ^[0-9]+$ ]] \
  && ok "WT87 人の入力待ちで時計を戻す" || fail "WT87 (rc=$rc)"; teardown

# WT88: ★ **答えるのに何時間かかっても、呼び直した直後に停滞としない。**取り次ぎ済みの
#      質問を通した時点（人が答えた直後）で時計を戻す。
setup; old "$SD/run.json" "$SD/roles/design/status.json"
jq -nc '{ok:true,result:{runId:"run_x",deliveryId:"dq",count:1,messages:[
  {id:"q1",type:"question",payload:({taskId:"task_x",dispatchId:"ctx_x"}|tojson),body:"which?"}]}}' \
  > "$ORCA_STUB_DIR/orchestration_check"
echo '["q1"]' > "$SD/questions.json"
ORCA_STALL_AFTER_SECONDS=$STALL w >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 3 && -f "$SD/human.json" ]] && ok "WT88 答えた直後に停滞としない" || fail "WT88 (rc=$rc)"; teardown

# WT89: snoozed_at（「待ち続ける」と答えた時刻）から数え直す
setup; old "$SD/run.json" "$SD/roles/design/status.json"
printf '{"snoozed_at":%s}\n' "$(date +%s)" > "$SD/stall.json"
ORCA_STALL_AFTER_SECONDS=$STALL w >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 3 ]] && ok "WT89 snooze から数え直す" || fail "WT89 (rc=$rc)"; teardown

# WT90: ★ **report は抜けずに記録する。同じ停滞を毎周出さない。**動き出したら記録を消す
setup; old "$SD/run.json" "$SD/roles/design/status.json"
err=$(ORCA_STALL_AFTER_SECONDS=$STALL bash "$P/bin/orca-wait.sh" --status-dir "$SD" --max-waits 3 \
        --timeout-ms 1 --on-stall report 2>&1 >/dev/null); rc=$?
n=$(grep -c 'stalled task=' <<<"$err")
d1=$(jq -r '.detected_at // empty' "$SD/stall.json" 2>/dev/null)
echo '{"status":"executing"}' > "$SD/roles/design/status.json"   # 動き出した
ORCA_STALL_AFTER_SECONDS=$STALL bash "$P/bin/orca-wait.sh" --status-dir "$SD" --max-waits 1 \
  --timeout-ms 1 --on-stall report >/dev/null 2>&1
[[ "$rc" -eq 3 && "$n" -eq 1 && "$d1" =~ ^[0-9]+$ ]] \
  && jq -e 'has("detected_at") | not' "$SD/stall.json" >/dev/null 2>&1 \
  && ok "WT90 report は 1 回だけ記録し、動けば消す" || fail "WT90 (rc=$rc n=$n d1=$d1)"; teardown

# WT91: ★ **決着済みのタスクを停滞として報告しない**（兄弟がまだ動いているだけ）
setup; dn; echo '["worker_done|task_x|ctx_x|succeeded"]' > "$SD/received.json"
SD2=$(mktemp -d); mkdir -p "$SD2/roles/design"; cp "$SD/run.json" "$SD2/run.json"
echo '{"roles":{"design":{"terminal":"term_y","task":"task_y","dispatch":"ctx_y","retained":false}}}' > "$SD2/workers.json"
echo '{"status":"executing"}' > "$SD2/roles/design/status.json"
old "$SD/run.json" "$SD/roles/design/status.json" "$SD/received.json"
out=$(ORCA_STALL_AFTER_SECONDS=$STALL bash "$P/bin/orca-wait.sh" --status-dir "$SD" --status-dir "$SD2" \
        --max-waits 1 --timeout-ms 1 2>/dev/null); rc=$?
[[ "$rc" -eq 3 && "$out" != *stalled* ]] && ok "WT91 決着済みは停滞ではない" || fail "WT91 (rc=$rc out=$out)"
rm -rf "$SD2"; teardown

# WT92: 引数の検査
setup
bash "$P/bin/orca-wait.sh" --status-dir "$SD" --on-stall bogus >/dev/null 2>&1; a=$?
bash "$P/bin/orca-wait.sh" --status-dir "$SD" --stall-after-min 0 >/dev/null 2>&1; b=$?
[[ "$a" -eq 2 && "$b" -eq 2 ]] && ok "WT92 停滞の引数を検査する" || fail "WT92 ($a/$b)"; teardown
```

- [ ] **Step 2: 失敗を確かめる**

Run: `bash test/test-wait.sh 2>&1 | grep -E 'WT8[4-9]|WT9[0-2]|failures'`
Expected: WT84 / WT86 / WT87 / WT88 / WT90 / WT92 が FAIL（WT85 / WT89 / WT91 は機能が無くても 3 で通りうる）

- [ ] **Step 3: 実装する**

ヘッダの Usage と Exit を次に変える:

```bash
# Usage: orca-wait.sh --status-dir <d> [--status-dir <d> ...] [--max-waits <n>] [--timeout-ms <n>]
#                     [--stall-after-min <n>] [--on-stall ask|report]
# Exit: 0 全件成功 / 5 1 件以上が失敗 / 1 batch を処理できない / 2 使用法 / 3 時間切れ
#       / 4 transport または worker state が不明 / 6 worker が人へ質問している
#       / 8 進んでいないタスクがある（--on-stall ask のとき。止めるかはユーザーが決める）
```

`# ★ **既定は 24 時間**` のコメント 3 行と `SDS=() MAXW=288 TMO=300000` を次で置き換える:

```bash
# ★ **既定は 24 時間**（5 分 × 288）。子は待機に期限を持たないので、これは子を見捨てる期限では
#   ない。24 時間ごとに exit 3 で状況を報告し、親が呼び直すための区切りである。
# ★ **停滞の既定は 120 分。**子が書くものがそれだけ変わらなければ知らせる（止めはしない）。
SDS=() MAXW=288 TMO=300000 STALL_MIN=120 ON_STALL=ask
```

引数の `case` に 2 行足す:

```bash
  --stall-after-min) need2 "$1" $#; STALL_MIN="$2"; shift 2 ;;
  --on-stall)        need2 "$1" $#; ON_STALL="$2";  shift 2 ;;
```

`[[ "$TMO" =~ ... ]] || die ...` の直後に足す:

```bash
[[ "$STALL_MIN" =~ ^[1-9][0-9]*$ ]] || die "--stall-after-min must be a positive integer"
case "$ON_STALL" in ask|report) ;; *) die "--on-stall must be ask or report: $ON_STALL" ;; esac
# テストが実時間を使わずに済むよう、秒で上書きできる（他の間隔と同じ構え）
STALL_SECONDS="${ORCA_STALL_AFTER_SECONDS:-$((STALL_MIN * 60))}"
```

Task 3 で足した `role_outcome` の直後に、次の関数群を足す:

```bash
# ★ **停滞は親が見つけ、止めるかどうかは人が決める。**子は待機に期限を持たない（待っている
#   相手の事情を知らないので「来ない」を判断できない）。タスク単位で「子が書くもの」が一定時間
#   どれも変わらなければ知らせる。**親が書くもの（wait.json / .woken / received.json /
#   questions.json / stall.json）は数えない** — 数えると親の鼓動で常に「変化あり」になる。
file_mtime() {   # $1=path → epoch。**GNU と BSD の stat の違いはここ 1 箇所で吸収する**
  stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0
}
LATEST=0
newer() { [[ "$1" =~ ^[0-9]+$ ]] && [[ "$1" -gt "$LATEST" ]] && LATEST="$1"; return 0; }
task_last_change() {   # $1=status dir → 子が最後に何かを変えた時刻（epoch）を stdout
  local sd="$1" f wt
  LATEST=0
  # 下限は dispatch の開始（run.json は起動時に 1 度だけ書かれる）
  newer "$(file_mtime "$sd/run.json")"
  # human.json は親が書くが、人とのやりとりの記録なので数える（人を待つ間は停滞ではない）
  for f in "$sd"/roles/*/status.json "$sd"/roles/*/result.md "$sd"/roles/*/completion.json \
           "$sd/plan.md" "$sd"/review/* "$sd/human.json"; do
    [[ -e "$f" ]] || continue
    newer "$(file_mtime "$f")"
  done
  while IFS= read -r wt; do
    [[ -n "$wt" && -d "$wt" ]] || continue
    newer "$(git -C "$wt" log -1 --format=%ct 2>/dev/null || echo 0)"
    while IFS= read -r f; do
      [[ -e "$wt/$f" ]] || continue
      newer "$(file_mtime "$wt/$f")"
    done < <(git -C "$wt" status --porcelain 2>/dev/null | cut -c4-)
  done < <(jq -r '.roles[].worktree_path // empty' "$sd/workers.json" 2>/dev/null)
  printf '%s' "$LATEST"
}
# ★ **人を待っている間は停滞ではない。**人とのやりとりを見た時点を残し、時計をそこから戻す。
#   書けなくても待機は止めない（最悪、ユーザーに 1 回余計に尋ねるだけで、誤って止めはしない）
mark_human() {   # $1=status dir
  write "$1" "$1/human.json" "$(jq -nc --argjson t "$(date +%s)" '{last_human_at: $t}')" || true
}
task_settled() {   # $1=status dir → その status dir の役が全部決着していれば 0
  local i oc
  for i in "${!TASKS[@]}"; do
    [[ "${T_SD[$i]}" == "$1" ]] || continue
    oc=$(role_outcome "${T_SD[$i]}" "${T_ROLE[$i]}") || return 1
    [[ -n "$oc" ]] || return 1
  done
  return 0
}
stall_lines() {   # $1=status dir $2=止まっている分 → 報告行を stdout
  local sd="$1" i ph th slug
  slug=$(basename "$sd")
  echo "stalled task=$slug status_dir=$sd idle_min=$2"
  for i in "${!TASKS[@]}"; do
    [[ "${T_SD[$i]}" == "$sd" ]] || continue
    ph=$(jq -r '.phase // empty' "$sd/roles/${T_ROLE[$i]}/completion.json" 2>/dev/null || echo "")
    [[ -n "$ph" ]] || ph=$(jq -r '.status // empty' "$sd/roles/${T_ROLE[$i]}/status.json" 2>/dev/null || echo "")
    th=$(jq -r --arg r "${T_ROLE[$i]}" '.roles[$r].terminal // empty' "$sd/workers.json" 2>/dev/null || echo "")
    echo "stalled_role task=$slug role=${T_ROLE[$i]} phase=${ph:-none} terminal=${th:-none}"
  done
}
check_stall() {   # 0 = 尋ねるべき停滞は無い / 1 = ask で停滞を stdout に出した（呼び出し側が 8 で抜ける）
  local sd now last snz idle cur upd l found=0
  now=$(date +%s)
  for sd in "${SDS[@]}"; do
    task_settled "$sd" && continue
    last=$(task_last_change "$sd")
    snz=$(jq -r '.snoozed_at // 0' "$sd/stall.json" 2>/dev/null || echo 0)
    [[ "$snz" =~ ^[0-9]+$ ]] && [[ "$snz" -gt "$last" ]] && last="$snz"
    cur=$(jq -c 'if type == "object" then . else {} end' "$sd/stall.json" 2>/dev/null) || cur='{}'
    [[ -n "$cur" ]] || cur='{}'
    if [[ $((now - last)) -lt "$STALL_SECONDS" ]]; then
      # 動き出したら、次の停滞をまた報告できるよう記録を消す
      if jq -e 'has("detected_at")' <<<"$cur" >/dev/null 2>&1; then
        upd=$(jq -c 'del(.detected_at, .idle_min)' <<<"$cur") && [[ -n "$upd" ]] \
          && write "$sd" "$sd/stall.json" "$upd" || true
      fi
      continue
    fi
    idle=$(( (now - last) / 60 ))
    if [[ "$ON_STALL" == ask ]]; then
      stall_lines "$sd" "$idle"; found=1; continue
    fi
    # ★ report は抜けない（無人の --issue）。**同じ停滞で毎周書かない**
    jq -e 'has("detected_at")' <<<"$cur" >/dev/null 2>&1 && continue
    while IFS= read -r l; do log "$l"; done < <(stall_lines "$sd" "$idle")
    upd=$(jq -c --argjson t "$now" --argjson m "$idle" '.detected_at = $t | .idle_min = $m' <<<"$cur") \
      && [[ -n "$upd" ]] && write "$sd" "$sd/stall.json" "$upd" \
      || log "could not record the stall in $sd/stall.json"
  done
  [[ "$found" -eq 0 ]]
}
```

`healthy` の `[[ -n "$wait" && "$wait" != null ]] && continue` を次で置き換える:

```bash
    if [[ -n "$wait" && "$wait" != null ]]; then mark_human "${T_SD[$i]}"; continue; fi
```

`drain` の question 分岐で、`log "${T_ROLE[$idx]}'s question was already relayed; treating it as handled"` の直後（`continue` の前）に足す:

```bash
        # 取り次ぎ済みとして通すのは、人が答えたあとの呼び直しである。そこで時計を戻す
        mark_human "${T_SD[$idx]}"
```

同じ分岐の `return 6` の直前に足す:

```bash
      mark_human "${T_SD[$idx]}"
```

メインループの `rewake_stalled` の直後（`n=$((n + 1))` の前）に足す:

```bash
  check_stall || {
    log "a task has made no progress for $(( STALL_SECONDS / 60 )) minutes or more and nobody is waiting on a person;"
    log "ask the user whether to keep waiting or stop a role (orca-stop.sh), then run this wait again"
    exit 8
  }
```

- [ ] **Step 4: 通ることを確かめる**

Run: `bash test/test-wait.sh 2>&1 | tail -1`
Expected: `failures: 0`

- [ ] **Step 5: Commit**

```bash
git add bin/orca-wait.sh test/test-wait.sh
git commit -m "feat(orca-dispatch): 進んでいないタスクを見つけて exit 8 で知らせる

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `orca-recover.sh` が止めた役を置き換えない / `--issue` は report で待つ

**Files:**
- Modify: `bin/orca-recover.sh`（役ループ冒頭）、`bin/orca-issue.sh:163`（内部の待機呼び出し）
- Test: `test/test-recover.sh`（末尾に RC16）、`test/test-issue.sh`（末尾に IS24）

**Interfaces:**
- Consumes: `stopped.json`（Task 4）、`orca-wait.sh --on-stall report`（Task 5）

- [ ] **Step 1: 失敗するテストを書く**

`test/test-recover.sh` 末尾の `echo "failures: $fails"` の直前に足す:

```bash
# RC16: ★ **ユーザーが止めた役を生き返らせない。**置き換えると、止めた役が別の端末で走り出す
setup; owe; show failed
echo '{"stopped_at":1,"by":"user"}' > "$SD/roles/design/stopped.json"
out=$(rec 2>&1); rc=$?
[[ "$rc" -eq 0 && "$out" == *"stopped by the user"* ]] \
  && ! grep -q 'worker-start\|orchestration send' "$ORCA_STUB_DIR/calls.log" \
  && ok "RC16 止めた役は回復しない" || fail "RC16 (rc=$rc out=$out)"
teardown
```

`test/test-issue.sh` 末尾の `echo "failures: $fails"` の直前に足す（`P` はこのファイルでもプラグインルートを指す。違う変数名なら合わせる）:

```bash
# IS24: ★ **無人の実行は停滞で止まって尋ねない。**尋ねる相手が居ないので、記録だけ残して待ち続ける
grep -q -- '--on-stall report' "$P/bin/orca-issue.sh" \
  && ok "IS24 --issue は停滞を記録して待ち続ける" || fail "IS24"
```

- [ ] **Step 2: 失敗を確かめる**

Run: `bash test/test-recover.sh 2>&1 | grep -E 'RC16'; bash test/test-issue.sh 2>&1 | grep -E 'IS24'`
Expected: `FAIL: RC16 ...`、`FAIL: IS24`

- [ ] **Step 3: 実装する**

`bin/orca-recover.sh` の役ループで、`rd="$SD/roles/$role"` の直後に足す:

```bash
  # ★ **ユーザーが止めた役には何もしない**（`orca-stop.sh`）。置き換えると、止めた役が
  #   別の端末で生き返る。
  if [[ -f "$rd/stopped.json" ]]; then
    log "$role: stopped by the user; not recovering it"
    continue
  fi
```

`bin/orca-issue.sh` の待機呼び出しを次にする:

```bash
  bash "$PLUGIN/bin/orca-wait.sh" --status-dir "$SD" --max-waits "$MAXW" --timeout-ms "$TMO" \
    --on-stall report || WRC=$?
```

その直前のコメント `# ★ wake 駆動にしない。...` の下に 1 行足す:

```bash
# ★ **停滞で止まって尋ねない。**無人なので尋ねる相手が居ない。stall.json に残して待ち続ける。
```

- [ ] **Step 4: 通ることを確かめる**

Run: `bash test/test-recover.sh 2>&1 | tail -1; bash test/test-issue.sh 2>&1 | tail -1`
Expected: どちらも `failures: 0`

- [ ] **Step 5: Commit**

```bash
git add bin/orca-recover.sh bin/orca-issue.sh test/test-recover.sh test/test-issue.sh
git commit -m "fix(orca-dispatch): 止めた役を回復で生き返らせず、無人実行は停滞を記録して待つ

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: 取り込み方を `orca-start.sh --integration` で記録し、merge / PR が記録と違う方を拒む

**Files:**
- Modify: `bin/orca-start.sh:4-7`（Usage）、`:37-49`（引数）、`:56-60`（続きの起動の検査）、`:125-128`（`CFG_SET`）、`:241-245`（`workers-initial`）
- Modify: `bin/orca-merge.sh`（`jq -e '.merged == true'` の前）、`bin/orca-pr.sh`（`EXISTING=` の前）
- Test: `test/test-start.sh`（ST91〜ST93）、`test/test-merge.sh`（MG21 / MG22）、`test/test-pr.sh`（PR15 / PR16）

**Interfaces:**
- Produces: `orca-start.sh --integration merge|pr`（1 段目のみ。省略時は設定値）。`workers.json` の top-level `integration`（`"merge"` か `"pr"`）。`--phase exec` / `--resume` で渡すと exit 2
- Consumes: `config-resolve.sh --integration <v>`（不正値は resolver が exit 2 → `orca-start.sh` は資源を作る前に exit 1）

- [ ] **Step 1: 失敗するテストを書く**

`test/test-start.sh` 末尾の `echo "failures: $fails"` の直前に足す:

```bash
# ST91: 取り込み方は起動時に workers.json へ記録する。省略すれば設定値（既定 merge）
setup; start --integration pr >/dev/null 2>&1
a=$(jq -r '.integration // empty' "$R/.dispatch/s/workers.json" 2>/dev/null); teardown
setup; start >/dev/null 2>&1
b=$(jq -r '.integration // empty' "$R/.dispatch/s/workers.json" 2>/dev/null); teardown
[[ "$a" == pr && "$b" == merge ]] && ok "ST91 取り込み方を記録する" || fail "ST91 (a=$a b=$b)"

# ST92: ★ **続きの起動で取り込み方を変えさせない。**記録と違う値で 2 段目を起こすと、merge と PR が食い違う
setup; phase_b_on; start >/dev/null 2>&1; design_done
exec_phase --integration pr >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 2 && "$(jq -r '.integration' "$R/.dispatch/s/workers.json")" == merge ]] \
  && ok "ST92 続きの起動は取り込み方を受け取らない" || fail "ST92 (rc=$rc)"; teardown

# ST93: 不正な値では何も作らない（設定の解決で止まる）
setup; start --integration squash >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 1 ]] && ! grep -q 'worktree create\|worker-start' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST93 不正な取り込み方で何も作らない" || fail "ST93 (rc=$rc)"; teardown
```

`test/test-merge.sh` 末尾の `echo "failures: $fails"` の直前に足す:

```bash
# MG21: ★ **PR と記録された dispatch を merge しない。**両方やると、レビュー前に成果が入る
setup; jq -c '.integration = "pr"' "$SD/workers.json" > "$SD/w" && mv "$SD/w" "$SD/workers.json"
out=$(m 2>&1); rc=$?
[[ "$rc" -eq 1 && "$out" == *'orca-pr.sh'* ]] && ! in_main && [[ ! -e "$SD/integration-result.json" ]] \
  && ok "MG21 PR の dispatch を merge しない" || fail "MG21 (rc=$rc out=$out)"; teardown

# MG22: merge と記録されていても、記録が無くても（旧版）今までどおり merge する
setup; jq -c '.integration = "merge"' "$SD/workers.json" > "$SD/w" && mv "$SD/w" "$SD/workers.json"
m >/dev/null 2>&1; x=$?; in_main; y=$?; teardown
setup; m >/dev/null 2>&1; u=$?; in_main; v=$?; teardown
[[ "$x" -eq 0 && "$y" -eq 0 && "$u" -eq 0 && "$v" -eq 0 ]] \
  && ok "MG22 merge の記録・記録無しは merge する" || fail "MG22 ($x/$y/$u/$v)"
```

`test/test-pr.sh` 末尾の `echo "failures: $fails"` の直前に足す:

```bash
# PR15: ★ **merge と記録された dispatch で PR を作らない。**
setup; jq -c '.integration = "merge"' "$SD/workers.json" > "$SD/w" && mv "$SD/w" "$SD/workers.json"
out=$(pr --repo o/r 2>&1); rc=$?
[[ "$rc" -eq 1 && "$out" == *'orca-merge.sh'* ]] && ! ghlog | grep -q 'pr create' \
  && ok "PR15 merge の dispatch で PR を作らない" || fail "PR15 (rc=$rc out=$out)"; teardown

# PR16: pr と記録されていれば今までどおり作る
setup; jq -c '.integration = "pr"' "$SD/workers.json" > "$SD/w" && mv "$SD/w" "$SD/workers.json"
pr --repo o/r >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 0 ]] && ghlog | grep -q 'pr create' \
  && ok "PR16 pr の dispatch は PR を作る" || fail "PR16 (rc=$rc)"; teardown
```

- [ ] **Step 2: 失敗を確かめる**

Run: `bash test/test-start.sh 2>&1 | grep -E 'ST9[1-3]'; bash test/test-merge.sh 2>&1 | grep -E 'MG2[12]'; bash test/test-pr.sh 2>&1 | grep -E 'PR1[56]'`
Expected: ST91 / ST92 / MG21 / PR15 が FAIL（ST93 / MG22 / PR16 は既存の動作で通りうる）

- [ ] **Step 3: 実装する**

`bin/orca-start.sh` の Usage コメントの 1 行目の後ろに `[--integration merge|pr]` を足す:

```bash
# Usage: orca-start.sh --request-file <f> --slug <s> --objective <o> [--repo-root <p>]
#          [--run <run_id>] [--agent <id>] [--model <id>] [--effort <level>]
#          [--phase design|exec] [--design-mode direct|plan|brainstorm] [--integration merge|pr]
```

引数の初期化（`OV_DESIGN_MODE` を初期化している行）に `OV_INTEGRATION=""` を足し、`case` に足す:

```bash
  --integration)  need2 "$1" $#; OV_INTEGRATION="$2"; shift 2 ;;
```

`CONT=0; [[ "$PHASE" == exec || "$RESUME" -eq 1 ]] && CONT=1` の直後に足す:

```bash
# ★ **取り込み方は起動時に 1 度だけ決める。**続きの起動で変えると、記録と実際の取り込みが
#   食い違い、merge と PR の両方が走りうる
[[ "$CONT" -eq 0 || -z "$OV_INTEGRATION" ]] \
  || die "--integration is fixed when the dispatch starts; the recorded value is kept"
```

`[[ -n "$OV_DESIGN_MODE" ]] && CFG_SET+=(--design-mode "$OV_DESIGN_MODE")` の直後に足す:

```bash
[[ -n "$OV_INTEGRATION" ]] && CFG_SET+=(--integration "$OV_INTEGRATION")
```

`write workers-initial ...` の jq を次にする（`--arg ig` と `integration:$ig` を足す）:

```bash
write workers-initial "$SD/workers.json" "$(jq -nc --arg r "$RUN" --arg ib "$IB" \
  --arg ir "$(jq -r '.integration_role // "design"' <<<"$CFG")" \
  --arg ig "$(jq -r '.integration' <<<"$CFG")" \
  --argjson roles "$(jq -c '.roles | map_values(. + {retained:false})' <<<"$CFG")" \
  '{run_id:$r, integration_branch:$ib, integration_role:$ir, integration:$ig, roles:$roles}')" || {
```

その上のコメント `# ★ **取り込み先の役を 1 箇所で決める。**...` の下に 1 行足す:

```bash
#   取り込み方（merge / pr）も同じく起動時に記録し、Step 4 と merge / PR の両スクリプトが読む。
```

`bin/orca-merge.sh` の `jq -e '.merged == true' "$SD/integration-result.json" ...` の直前に足す:

```bash
# ★ **PR と決めた dispatch を merge しない。**両方やるとレビュー前に成果が入る。記録が無い
#   （旧版で起動した）dispatch は今までどおり通す。`stop` は integration-result.json を書くので
#   使わない — PR 側の記録を汚さない。
[[ "$(jq -r '.integration // empty' "$SD/workers.json" 2>/dev/null)" != pr ]] || {
  log "this dispatch was started to open a pull request; use orca-pr.sh instead"; exit 1; }
```

`bin/orca-pr.sh` の `# ★ 既に PR があるなら作り直さない。` の直前に足す:

```bash
# ★ **merge と決めた dispatch で PR を作らない。**記録が無い（旧版）dispatch は今までどおり通す。
[[ "$(jq -r '.integration // empty' "$SD/workers.json" 2>/dev/null)" != merge ]] || {
  log "this dispatch was started to merge; use orca-merge.sh instead"; exit 1; }
```

- [ ] **Step 4: 通ることを確かめる**

Run: `bash test/test-start.sh 2>&1 | tail -1; bash test/test-merge.sh 2>&1 | tail -1; bash test/test-pr.sh 2>&1 | tail -1; bash test/test-issue.sh 2>&1 | tail -1`
Expected: すべて `failures: 0`

- [ ] **Step 5: Commit**

```bash
git add bin/orca-start.sh bin/orca-merge.sh bin/orca-pr.sh test/test-start.sh test/test-merge.sh test/test-pr.sh
git commit -m "feat(orca-dispatch): 取り込み方を起動時に記録し、merge と PR の取り違えを拒む

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: 文書（SKILL.md / guide-ja.md / CLAUDE.md / README.md）とバージョン

**Files:**
- Modify: `skills/orca-team-dispatch-task/SKILL.md`（Step 1b / Step 2 / Step 3 / Step 4 / I3 / Known limitations / State on disk）
- Modify: `skills/orca-team-dispatch-task/references/guide-ja.md`（同じ箇所を 1:1 で）
- Modify: `CLAUDE.md`（構成 / 配送は起床ではない / 待つのは 24 時間 / 範囲）、`README.md`
- Modify: `.claude-plugin/plugin.json`、`.codex-plugin/plugin.json`、ルート `.claude-plugin/marketplace.json`
- Test: `test/test-docs.sh`（SK19 / SK20 を SK18 の直後に追加）

**Interfaces:**
- Consumes: Task 1〜7 のすべて（exit 8、`orca-stop.sh --role/--snooze`、`--on-stall report`、`--integration`、`workers.json` の `integration`）

- [ ] **Step 1: 失敗するテストを書く**

`test/test-docs.sh` の SK18 ブロックの直後（`# SK16:` の前）に足す:

```bash
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
  grep -q 'orca-stop.sh" --status-dir "\$SD" --snooze' "$f" || bad="$bad [snooze:$(basename "$f")]"
  grep -q 'orca-stop.sh" --status-dir "\$SD" --role "\$ROLE"' "$f" || bad="$bad [stop:$(basename "$f")]"
  grep -q -- '--on-stall report' "$f" || bad="$bad [issue-report:$(basename "$f")]"
  grep -q 'stopped.json' "$f" || bad="$bad [state:$(basename "$f")]"
done
[[ -z "$bad" ]] && ok "SK20 停滞はユーザーが決める" || fail "SK20:$bad"
```

- [ ] **Step 2: 失敗を確かめる**

Run: `bash test/test-docs.sh 2>&1 | grep -E 'SK19|SK20'`
Expected: `FAIL: SK19: ...`、`FAIL: SK20: ...`

- [ ] **Step 3: SKILL.md を書き換える**

**Step 1b** — 設定値を読む bash block の最後の行 `  | jq -r .design_mode` を次に変える（両方の推奨値を 1 回で読む）:

```bash
  | jq -r '"design_mode=\(.design_mode) integration=\(.integration)"'
```

`call. A selected task gets \`brainstorm\`, every other task gets \`plan\`:` の直前の文 `Past sixteen tasks, ask the next sixteen in a further call.` を次にする:

```
up to four such questions in the one call — three when the integration question below shares it.
Past that many tasks, ask the rest in a further call.
```

（直前の `group the tasks in order and put` の続きとして読めるよう、元の `up to four such questions in the one call. Past sixteen tasks, ask the next sixteen in a further` の 2 行を置き換える。）

`Keep each task's answer as that task's \`DESIGN_MODE\`` の段落の直前に、次の 2 段落を足す:

```markdown
**The same call also asks how the finished work comes home**, the way
`cmux-team-dispatch-task` asks its Step 1e. Add one single-select question with two answers:
**Wait and merge** — every task is waited for and its branch merged into the branch you
dispatched from — and **PR per task** — each task's branch is pushed and a pull request is
opened instead. Mark the configured `integration` as the recommendation. It is asked every time,
like the question above: the configuration is the recommendation, never a reason to skip it.

The answer covers every task in the dispatch. Keep it as `INTEGRATION`, `merge` or `pr`, and
pass it in Step 2 for every task. Because this question takes one of the four places in the
call, the first call carries at most three task questions — twelve tasks.
```

`**\`--issue\` has no Step 1b.**` の段落末尾 `downgrades \`brainstorm\` to \`plan\`.` を次にする:

```
downgrades `brainstorm` to `plan`. It takes `integration` from the configuration as it is.
```

**Step 2** — bash block を次にする:

```bash
: "${REQ:?set REQ to the exact request_file path printed in Step 1}"
: "${DESIGN_MODE:?set DESIGN_MODE to this task's Step 1b answer: brainstorm or plan}"
: "${INTEGRATION:?set INTEGRATION to the Step 1b answer: merge or pr}"
RUN="${RUN:-}"   # empty for the first task; the printed run_id for every task after it
OUT=$(bash "$PLUGIN/bin/orca-start.sh" --request-file "$REQ" --slug "$SLUG" \
        --design-mode "$DESIGN_MODE" --integration "$INTEGRATION" \
        --objective "<one line naming the outcome>" ${RUN:+--run "$RUN"}) || { echo "$OUT"; exit 1; }
SD=$(sed -n 's/^status_dir=//p' <<<"$OUT")
RUN=$(sed -n 's/^run_id=//p' <<<"$OUT")
printf 'status_dir=%s\nrun_id=%s\n' "$SD" "$RUN"
```

その下の `work out first. Shell variables do not cross tool calls here either, and \`DESIGN_MODE\` is one of them: set it` / `in this call from that task's Step 1b answer.` を次にする:

```
work out first. Shell variables do not cross tool calls here either, and `DESIGN_MODE` and
`INTEGRATION` are among them: set them in this call from the Step 1b answers.
`INTEGRATION` is recorded in `workers.json` when the task starts; `--resume` and
`--phase exec` keep the recorded value and refuse a new one.
```

**Step 3** — exit 表の `| 6 |` の行の直後に足す:

```
| 8 | A task has made no progress for two hours, and none of its roles is waiting on a person | Nothing was stopped. Follow the stalled-task steps below: show the user what each role's terminal shows, ask once, run what they chose, then run the same wait again |
```

`On exit 6 nothing has gone wrong.` で始まる段落の直後に、次の節本文を足す（見出しは付けない。SK8e の構造一致を崩さないため）:

````markdown
On exit 8 nothing has been stopped either. The wait found a task where nothing a worker
writes — its status, result, completion record, plan, review files, or the files and commits
in its worktree — has changed for `--stall-after-min` minutes (120 by default), while no role
was waiting on a person. **Workers never give up waiting by themselves**, so this is the only
place a stuck task is noticed, and **whether to stop anything is the user's decision, never
yours.**

For every `stalled_role` line the wait printed, read what that terminal shows now:

```bash
: "${TERM_HANDLE:?set TERM_HANDLE to the terminal= value of one stalled_role line}"
"$ORCA_BIN" terminal read --terminal "$TERM_HANDLE" --screen --json
```

Show the user how long each task has been idle and the last lines of each role's screen, then
ask in one `AskUserQuestion` call: one `multiSelect` question per stalled task, whose options
are **Keep waiting** and one option per role on that task's `stalled_role` lines. For a task
where only **Keep waiting** was chosen, restart its stall clock:

```bash
: "${PLUGIN:?run the block at the top of this file first}"
: "${SD:?set SD to the status_dir= value of the stalled task line}"
bash "$PLUGIN/bin/orca-stop.sh" --status-dir "$SD" --snooze
```

For every role the user chose to stop, run this once, with `ROLE` set to that role:

```bash
: "${PLUGIN:?run the block at the top of this file first}"
: "${SD:?set SD to the status_dir= value of the stalled task line}"
: "${ROLE:?set ROLE to one role the user chose to stop}"
bash "$PLUGIN/bin/orca-stop.sh" --status-dir "$SD" --role "$ROLE"
```

It records the stop before it closes the terminal, so the wait settles that role as
`outcome=stopped` instead of reporting a lost worker, and `orca-recover.sh` leaves it alone.
It restarts the stall clock too. Stopping a reviewer tells the worker it reviews to carry on
without review: that work is then unreviewed, and Step 4's gate applies as usual. Stopping the
role that carries the work fails the task: do not bring it home, and take it to Step 5. Exit 1
means the stop could not be recorded or the terminal could not be closed, and the message says
which; tell the user. Then run the same wait again.
````

**Step 4** — 最初の段落（`Run this once per succeeded task, ...` で終わる段落）の直後に足す:

````markdown
First read how this dispatch was asked to come home — Step 1b's answer, recorded when it
started:

```bash
: "${SD:?set SD to the exact status_dir printed in Step 2}"
jq -r '.integration // "not recorded"' "$SD/workers.json"
```

`merge` means the merge below. `pr` means the pull request block further down. `not recorded`
means an older version started the dispatch: use the configured `integration`. Each script
refuses the other's recorded value, so the two cannot be mixed up.
````

`**When \`integration\` is \`pr\`, use this instead of the merge above.**` を `**When it is \`pr\`, use this instead of the merge above.**` にする。

**I3** — パス 2 の bash block を次にする:

```bash
: "${PLUGIN:?run the block at the top of this file first}"
bash "$PLUGIN/bin/orca-wait.sh" --status-dir "<status_dir 1>" --status-dir "<status_dir 2>" \
  --on-stall report
```

その直後の段落の先頭に次の 2 文を足す:

```
`--on-stall report` keeps an unattended run from stopping to ask: a stalled task is written to
its `stall.json` and the log, and the wait goes on. When someone comes back, a `stall.json` with
`detected_at` names the task to take through Step 3's exit 8 steps.
```

**Known limitations** — 次の 2 行を置き換える:

- `| Review stops after two rounds, and a silent reviewer is retried once | The role being reviewed records the unresolved findings in \`result.md\` and keeps the best version it has. Read that section before integrating |` を
  `| Review stops after two rounds | The role being reviewed records the unresolved findings in \`result.md\` and keeps the best version it has. Read that section before integrating |`

表の末尾に 1 行足す:

```
| A stalled task is only reported; nothing stops it unless you say so | Workers wait with no time limit. The wait exits 8 after two hours without progress, and Step 3 asks you whether to keep waiting or stop a role. An `--issue` run only records it in `stall.json` and keeps waiting |
```

**State on disk** — `sent.json` (one entry per message this task actually delivered), and` の行を次にする:

```
`sent.json` (one entry per message this task actually delivered), `stall.json` (when the
task was found stalled, and when the user chose to keep waiting), `human.json` (the last time
the wait saw a role waiting on a person), and
```

`roles/design/{status.json,result.md}. Tasks of one Run carry` を次にする:

```
`roles/design/{status.json,result.md}`, plus `roles/<role>/stopped.json` for a role the user
stopped. Tasks of one Run carry
```

- [ ] **Step 4: guide-ja.md を同じ箇所で書き換える**

bash block は Step 3 の SKILL.md と**一字一句同じ**ものを同じ順で入れる（SK8d）。文は次の訳を使う。

**Step 1b** — bash block の最後の行を SKILL.md と同じ `  | jq -r '"design_mode=\(.design_mode) integration=\(.integration)"'` にする。`最大 4 問入れる。16 タスクを超えるときは、次の 16 件を別の呼び出しで尋ねる。` を `最大 4 問入れる（下の取り込み方の質問と同じ呼び出しに入れるときは 3 問）。それを超えるタスクは別の呼び出しで尋ねる。` にする。`各タスクの答えをそのタスクの \`DESIGN_MODE\` として保持し` の段落の直前に足す:

```markdown
**同じ呼び出しで、完了した成果の取り込み方も尋ねる。**`cmux-team-dispatch-task` の Step 1e
と同じ尋ね方である。単一選択の質問を 1 つ足し、答えは 2 つ: **Wait and merge** — 全タスクの
完了を待ち、各ブランチを dispatch したときのブランチへ merge する — と **PR per task** —
各タスクのブランチを push し、代わりに pull request を作る。設定済みの `integration` を推奨と
して示す。上の質問と同じく毎回尋ねる。設定は推奨であって、質問を省く理由ではない。

答えは dispatch の全タスクに共通である。`INTEGRATION`（`merge` か `pr`）として保持し、
Step 2 で全タスクに渡す。この質問が呼び出しの 4 枠のうち 1 つを使うので、最初の呼び出しに
入るタスクの質問は 3 問、12 タスクまでになる。
```

`**\`--issue\` は Step 1b を持たない。**` の段落末尾に `\`integration\` は設定の値をそのまま使う。` を足す。

**Step 2** — bash block を SKILL.md と同じものにする。`ここでも shell 変数は tool call を跨がず、\`DESIGN_MODE\` もその 1 つである。この call の中で、そのタスクの Step 1b の答えから設定する。` を次にする:

```
ここでも shell 変数は tool call を跨がず、`DESIGN_MODE` と `INTEGRATION` もそうである。
この call の中で、Step 1b の答えから設定する。`INTEGRATION` はタスクの起動時に `workers.json`
へ記録され、`--resume` と `--phase exec` は記録された値を引き継ぎ、新しい値を拒む。
```

**Step 3** — exit 表の `| 6 |` の行の直後に足す:

```
| 8 | あるタスクが 2 時間進んでおらず、そのどの役も人を待っていない | 何も止めていない。下の停滞時の手順に従う: 各役の端末に何が出ているかをユーザーに見せ、1 回尋ね、選ばれたことを実行し、同じ待機をもう一度走らせる |
```

`終了コード 6 では何も壊れていない。` の段落の直後に、SKILL.md と同じ構造（見出し無し、bash block 3 つを同じ順）で次を足す:

````markdown
終了コード 8 でも何も止めていない。待機が、worker の書くもの — status、result、完了の記録、
計画、レビューのファイル、worktree のファイルと commit — が `--stall-after-min` 分（既定 120）
変わらず、しかもどの役も人を待っていないタスクを見つけたということである。**worker は自分から
待機をやめない**ので、詰まったタスクに気づけるのはここだけであり、**何かを止めるかどうかは
ユーザーが決める。親が決めてはならない。**

待機が出力した `stalled_role` の行ごとに、その端末の今の表示を読む:

```bash
: "${TERM_HANDLE:?set TERM_HANDLE to the terminal= value of one stalled_role line}"
"$ORCA_BIN" terminal read --terminal "$TERM_HANDLE" --screen --json
```

各タスクがどれだけ止まっているかと、各役の画面の最後の数行をユーザーに見せ、1 回の
`AskUserQuestion` で尋ねる: 停滞したタスクごとに `multiSelect` の質問を 1 つ置き、選択肢は
**Keep waiting** と、そのタスクの `stalled_role` の行の役 1 つずつ。**Keep waiting** だけが
選ばれたタスクは、停滞の時計を数え直す:

```bash
: "${PLUGIN:?run the block at the top of this file first}"
: "${SD:?set SD to the status_dir= value of the stalled task line}"
bash "$PLUGIN/bin/orca-stop.sh" --status-dir "$SD" --snooze
```

ユーザーが止めると選んだ役ごとに、`ROLE` をその役にして 1 回ずつ実行する:

```bash
: "${PLUGIN:?run the block at the top of this file first}"
: "${SD:?set SD to the status_dir= value of the stalled task line}"
: "${ROLE:?set ROLE to one role the user chose to stop}"
bash "$PLUGIN/bin/orca-stop.sh" --status-dir "$SD" --role "$ROLE"
```

これは端末を閉じる前に停止を記録するので、待機はその役を失われた worker として報告せず
`outcome=stopped` として決着させ、`orca-recover.sh` もその役に触らない。停滞の時計も数え直す。
reviewer を止めると、レビューされる側の worker にレビュー無しで進むよう伝える。その成果は
無レビューになり、Step 4 の gate が今までどおり働く。成果を載せる役を止めるとタスクは失敗する。
持ち帰らず、Step 5 へ回す。exit 1 は停止を記録できなかったか端末を閉じられなかったことを表し、
どちらかはメッセージが言う。ユーザーへ伝える。そのあと同じ待機をもう一度走らせる。
````

**Step 4** — 最初の段落の直後に足す:

````markdown
まず、この dispatch がどう持ち帰るよう頼まれたか — 起動時に記録した Step 1b の答え — を読む:

```bash
: "${SD:?set SD to the exact status_dir printed in Step 2}"
jq -r '.integration // "not recorded"' "$SD/workers.json"
```

`merge` なら下の merge。`pr` ならさらに下の pull request の block。`not recorded` は古い版が
起動した dispatch なので、設定の `integration` に従う。両スクリプトは相手側の記録値を拒むので、
取り違えることはない。
````

`**\`integration\` が \`pr\` のときは、上の merge の代わりにこちらを使う。**` を `**それが \`pr\` のときは、上の merge の代わりにこちらを使う。**` にする。

**I3** — パス 2 の bash block を SKILL.md と同じものにし、直後の段落の先頭に足す:

```
`--on-stall report` は、無人の実行が停滞で止まって尋ねるのを防ぐ。停滞したタスクは
`stall.json` と log に書かれ、待機は続く。人が戻ってきたら、`detected_at` を持つ `stall.json`
のタスクを Step 3 の終了コード 8 の手順にかける。
```

**既知の制限** — `| レビューは 2 ラウンドで打ち切り、無言の reviewer への再依頼は 1 回だけ |` を `| レビューは 2 ラウンドで打ち切り |` にし、表の末尾に足す:

```
| 停滞したタスクは知らされるだけで、ユーザーが言わない限り何も止まらない | worker は期限なしで待つ。待機は進捗の無いまま 2 時間経つと終了コード 8 で抜け、Step 3 が待ち続けるか役を止めるかを尋ねる。`--issue` の実行は `stall.json` に記録するだけで待ち続ける |
```

**ディスク上の状態** — `` `sent.json`（このタスクが実際に配送した message の記録）、`` の後ろに `` `stall.json`（停滞を見つけた時刻と、ユーザーが待ち続けると答えた時刻）、`human.json`（役が人を待っているのを待機が最後に見た時刻）、`` を足し、`` `roles/design/{status.json,result.md}` がある。`` を `` `roles/design/{status.json,result.md}`、ユーザーが止めた役には `roles/<role>/stopped.json` がある。`` にする。

- [ ] **Step 5: CLAUDE.md と README.md を書き換える**

`CLAUDE.md` の構成の節で、`` `bin/orca-merge.sh`（成果を親ブランチへ。 `` の前に `` `bin/orca-stop.sh`（ユーザーが選んだ役を記録してから止める。停滞の時計の数え直しも）/ `` を足す。

「配送は起床ではない」の層 1 の `（1 回 10 分ブロック / 出力は \`accepted\` \`remediation\` \`waiting\` \`expired\` の 4 つ）。` を `（1 回 10 分ブロック / 出力は \`accepted\` \`remediation\` \`waiting\` の 3 つ。期限は無い）。` にする。

`## 待つのは 24 時間` の節の見出しと最初の 2 段落（`**「翌日の仕事までに分かっていればよい」が要件である。**` から `10 分（agent の shell の上限）なので、24 時間は呼び直しで作るしかない。` まで）を次で置き換える（`親の側は**背景で走らせる**。` 以降の段落は残す）:

```markdown
## 子は待ち続け、止めるのはユーザー

**子は待機に期限を持たない。**2026-09-23 の実測: design が brainstorm でユーザーの回答を
待つ間に、reviewer が「1 時間依頼なし」で自分から終了し、そのタスクはレビューされなかった。
子は待っている相手の事情（人の回答待ちなど）を知らないので、「来ない」を判断できない。
reviewer・依頼側のレビュー待ち・`completion.sh await` のどれも、自分から待機をやめる経路を
持たない（回帰は `test-start.sh` の ST67 / ST89 / ST90、`test-completion.sh` の CM22 / CM22b /
CM27b）。

**停滞を見つけるのは親、止めるかを決めるのはユーザー。**`orca-wait.sh` はタスク単位で
「子が書くもの」（status / result / completion / plan / review / worktree の変更と commit）の
最終変化時刻を見て、`--stall-after-min`（既定 120）を越えたら exit 8 で抜ける。**親が書く
ファイル（`wait.json` / `.woken` / `received.json` / `questions.json` / `stall.json`）は
数えない** — 数えると親の鼓動で常に「変化あり」になる。人を待っている間（`agentWait` と
質問の取り次ぎ）は `human.json` に時刻を残して時計を戻す。`questions.json` は答えた時刻を
持たないので、取り次ぎ済みとして通した時点（人が答えた直後）でも戻す。止めるのは
`orca-stop.sh` で、**記録してから端末を閉じる**（記録の無い停止は worker の消失に見え、
exit 4 と recovery に回る）。`--issue` は `--on-stall report` で止まらずに記録だけ残す
（回帰は `test-wait.sh` の WT80-92、`test-stop.sh`、`test-recover.sh` の RC16）。

親の `--max-waits` の既定 288（5 分 × 288 = 24 時間）は残す。子の期限と揃える意味は
無くなり、24 時間ごとに exit 3 で状況を報告して呼び直す区切りになった。
```

`## 範囲` の箇条書きで、`- **\`design_mode\` で取りかかり方を選べる**` の項の直前に足す:

```markdown
- **取り込み方（merge / PR）は Step 1b の同じ呼び出しで毎回尋ねる**（cmux 版の 1e と同じ）。
  答えは `orca-start.sh --integration` で `workers.json` に記録し、Step 4 はそれを読む。
  `orca-merge.sh` は `pr` の記録を、`orca-pr.sh` は `merge` の記録を拒む（記録が無い旧版は通す）。
  回帰は `test-docs.sh` の SK19、`test-start.sh` の ST91-93、MG21 / MG22、PR15 / PR16
```

`README.md` の `## 範囲と制限` の段落末尾 `（日本語は \`references/guide-ja.md\`）。ここでは繰り返さない。` の直前の文として、`**片付けが勝手に走ることはない。**確認してから、承認されたものだけを片付ける。` の直後に足す:

```
worker は待機に期限を持たず、進んでいないタスクは待ち続けるか止めるかをユーザーに尋ねる。
取り込み方（merge / PR）は dispatch の前に毎回尋ねる。
```

- [ ] **Step 6: バージョンを 3.6.0 にする**

`apps/orca-team-dispatch-task/.claude-plugin/plugin.json` と `.codex-plugin/plugin.json` の `"version":"3.5.1"` を `"version":"3.6.0"` に、ルート `.claude-plugin/marketplace.json` の `orca-team-dispatch-task` の `"version": "3.5.1"` を `"version": "3.6.0"` にする。

- [ ] **Step 7: 全体を通す**

Run: `bash test/run-all.sh 2>&1 | tail -3 && (cd ../.. && node scripts/check-doc-lang.mjs apps/orca-team-dispatch-task)`
Expected: `ALL GREEN`、`check-doc-lang: OK`

SK8d / SK8e（訳の構造一致）で落ちたら、guide-ja.md の bash block と見出しの位置を SKILL.md に合わせ直す。

- [ ] **Step 8: Commit**

```bash
git add skills/orca-team-dispatch-task/SKILL.md skills/orca-team-dispatch-task/references/guide-ja.md \
  CLAUDE.md README.md .claude-plugin/plugin.json .codex-plugin/plugin.json ../../.claude-plugin/marketplace.json \
  test/test-docs.sh
git commit -m "docs(orca-dispatch): 停滞時の手順と取り込み方の質問を書き、3.6.0 にする

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
