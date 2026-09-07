# orca-team-dispatch-task 並列 dispatch（Stage A）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `orca-team-dispatch-task` を「1 タスク・1 worker」から「N タスクを 1 つの Orca Run 上で並列に dispatch し、取りこぼさず待ち、dispatch ごとに確実に片付ける」へ拡張する。

**Architecture:** 端末生成を Orca に任せる（`worker-start --agent`）ことで `terminal create` + runner 生成の経路を丸ごと削除する。全タスクを 1 つの Run に載せ、親端末の FIFO Delivery を「既知の `(task, dispatch)` 集合」に照らして drain する。settle した worker は ack の前に `worker-retain` で保持し、`worker-release` は Step 6 のユーザー承認後にだけ実行する。

**Tech Stack:** bash + jq、Orca CLI 1.4.197（`$ORCA_BIN`）、テストは自作の bash ランナーと `test/lib/orca-stub.sh`

**Spec:** `docs/superpowers/specs/2026-09-07-orca-parallel-multi-worker-design.md`

## Global Constraints

- Orca CLI は PATH に無い。**常に `$ORCA_BIN`** 経由で呼ぶ（既定 `/Applications/Orca.app/Contents/Resources/bin/orca`）。ユーザーに見せるコマンド文字列も同じ
- `skills/orca-team-dispatch-task/SKILL.md` は **英語のみ**。日本語は `skills/orca-team-dispatch-task/references/guide-ja.md` にだけ書く（`scripts/check-doc-lang.mjs` が検査）
- SKILL.md の frontmatter 直後の `## Output Language` ブロック 3 行は**一字一句そのまま**維持する
- SKILL.md と `guide-ja.md` の **bash ブロックはバイト一致**（`test-docs.sh` の SK8d が `cmp` で比較）
- 両文書の **`[Cn]` の ID 集合が一致**（SK8）、**`## Known limitations` 表の行数が一致**（SK8c）、**H2 見出しの並びが一致**（SK8e。新しい H2 は `normalise_headings()` に登録する）
- `README.md` に `worker-release` / `worktree rm` / `terminal close` / `task-list --run` の語を書かない（SK9）
- 完了条件は毎回 `cd apps/orca-team-dispatch-task && bash test/run-all.sh` が **ALL GREEN**
- リポジトリ全体では `pnpm check` と `node scripts/check-doc-lang.mjs apps/orca-team-dispatch-task` が通ること
- バージョンは `apps/orca-team-dispatch-task/.claude-plugin/plugin.json` / `.codex-plugin/plugin.json` / ルート `.claude-plugin/marketplace.json` の 3 箇所を同期する
- **使わなくなったコード・ファイル・テスト fixture は同じ commit で消す**（spec D7）
- コミットメッセージは日本語。末尾に `Claude-Session: https://claude.ai/code/session_01Hjrrf6y5oDbwAgAHmHHgp3` を付ける
- 作業ブランチは `docs/orca-parallel-multi-worker-spec`（spec の commit 済み。ここに実装を積む）

---

### Task 1: U1 / U2 を実機で確定させ、spec を更新する

**この Task は Orca が動く端末でしか実行できない。以降のすべての Task の前提になる。**

`--agent claude` に切り替えると argv を制御できなくなり、Stage 1 が明示していた `--dangerously-skip-permissions` が失われる（spec U1）。権限プロンプトで worker が止まれば無人 dispatch は成立しない。`worker-start` の receipt のどのフィールドに端末 handle が入るかも未確定（spec U2）。

**Files:**
- Modify: `docs/superpowers/specs/2026-09-07-orca-parallel-multi-worker-design.md`（0 節の改訂履歴と 11 節の U1 / U2）

**Interfaces:**
- Produces: U1 の結論（**(a) `--agent` 経路を採用** または **(b) `terminal create --command` 経路へ戻す**）と、U2 の **端末 handle の JSON パス**。Task 3 以降がこの 2 つを使う

- [ ] **Step 1: 使い捨ての worktree と Run を作る**

Orca 端末（`ORCA_TERMINAL_HANDLE` が設定されている端末）で実行する。

```bash
ORCA_BIN=/Applications/Orca.app/Contents/Resources/bin/orca
RR=$(git rev-parse --show-toplevel)
"$ORCA_BIN" worktree create --repo "path:$RR" --name u1-probe --no-parent --setup skip --json | tee /tmp/u1-wt.json
WT=$(jq -r '.result.worktree.id' /tmp/u1-wt.json)
"$ORCA_BIN" orchestration run-create --objective "U1 probe" --from "$ORCA_TERMINAL_HANDLE" --json | tee /tmp/u1-run.json
```

- [ ] **Step 2: 権限プロンプトを踏む Task を作って worker を起動する**

「必ずファイルを書く」指示にする。権限プロンプトが出るなら、ここで worker が止まる。

```bash
"$ORCA_BIN" orchestration task-create \
  --spec 'Write the single line "u1 probe ok" to a new file named U1-PROBE.txt in this worktree, then end your turn. Do not commit.' \
  --task-title u1-probe --from "$ORCA_TERMINAL_HANDLE" --json | tee /tmp/u1-task.json
TID=$(jq -r '.result.task.id' /tmp/u1-task.json)
"$ORCA_BIN" orchestration worker-start --task "$TID" --worktree "id:$WT" \
  --agent claude --from "$ORCA_TERMINAL_HANDLE" --json | tee /tmp/u1-worker.json
```

- [ ] **Step 3: U2 を確定する — receipt のどこに端末 handle が入るか**

```bash
jq -r 'paths(scalars) as $p | select($p[-1] | test("handle|Handle")) | "\($p | join(".")) = \(getpath($p))"' /tmp/u1-worker.json
```

**Expected:** 端末 handle を含むパスが 1 つ以上出る（`result.worker.agent_terminal_handle` が第一候補）。出たパスを控える。

- [ ] **Step 4: U1 を確定する — 権限プロンプトで止まるか**

worker を目視し、CLI でも確認する。

```bash
DID=$(jq -r '.result.dispatchId' /tmp/u1-worker.json)
"$ORCA_BIN" orchestration worker-show --dispatch "$DID" --json | jq '.result.observation.agentWait, .result.worker.state'
"$ORCA_BIN" orchestration worker-read --dispatch "$DID" --json | tail -40
```

**Expected（(a) の場合）:** `agentWait` が `null` のまま `U1-PROBE.txt` が作られる。
**Expected（(b) の場合）:** `agentWait` が非 null で、出力に権限確認のプロンプトが見える。

- [ ] **Step 5: 後片付け**

```bash
"$ORCA_BIN" orchestration worker-release --dispatch "$DID" --json
"$ORCA_BIN" worktree rm --worktree "id:$WT" --json
rm -f /tmp/u1-*.json
```

- [ ] **Step 6: spec に結論を書く**

`docs/superpowers/specs/2026-09-07-orca-parallel-multi-worker-design.md` の 11 節の U1 行と U2 行を、実測値で書き換える。0 節の改訂履歴に `rev2` を足す。

U1 が **(b)** に倒れた場合は、**この計画の Task 3 を実行してはならない。**代わりに spec の 7 節と Stage C の方針を書き直し、この計画も作り直す。Task 3 以降は (a) を前提にしている。

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/specs/2026-09-07-orca-parallel-multi-worker-design.md
git commit -m "$(cat <<'EOF'
docs(orca-dispatch): U1 / U2 を実機で確定させる

--agent claude 経路が権限プロンプトで停止しないこと、および worker-start の
receipt から端末 handle を取り出す JSON パスを実測で確定した。

Claude-Session: https://claude.ai/code/session_01Hjrrf6y5oDbwAgAHmHHgp3
EOF
)"
```

---

### Task 2: `workers.json` を `roles` 形へ移す（挙動を変えない純粋なリファクタ）

Stage B で `design_review` / `exec` / `exec_review` を足せる形にする。**この Task では挙動を 1 つも変えない。**変わるのは JSON のキー階層と、それを読む 4 ファイルの jq セレクタだけ。

**Files:**
- Modify: `apps/orca-team-dispatch-task/bin/orca-start.sh`（`workers.json` を書く 3 箇所）
- Modify: `apps/orca-team-dispatch-task/bin/orca-wait.sh:31-32`
- Modify: `apps/orca-team-dispatch-task/bin/orca-merge.sh`（`TID` / `DID` の読み出し）
- Modify: `apps/orca-team-dispatch-task/skills/orca-team-dispatch-task/SKILL.md`（`[C1]` `[C2]` `[C3]` の bash ブロック）
- Modify: `apps/orca-team-dispatch-task/skills/orca-team-dispatch-task/references/guide-ja.md`（同じブロックをバイト一致で）
- Modify: `apps/orca-team-dispatch-task/test/test-start.sh:81`
- Modify: `apps/orca-team-dispatch-task/test/test-wait.sh`（`setup()` と WT4d の fixture）
- Modify: `apps/orca-team-dispatch-task/test/test-merge.sh:17`
- Modify: `apps/orca-team-dispatch-task/test/test-docs.sh:85,103,126`

**Interfaces:**
- Produces: `workers.json` の新しい形。以降のすべての Task がこれを読む

```json
{
  "run_id": "...", "worktree_id": "...", "worktree_path": "...",
  "branch": "...", "integration_branch": "...",
  "worktree_created_by_this_run": true,
  "worktree_terminals": ["term_..."],
  "roles": { "design": { "terminal": "...", "task": "...", "dispatch": "...", "retained": false } }
}
```

- [ ] **Step 1: テストの fixture を新しい形に書き換える（先に赤くする）**

`test/test-merge.sh:17` を書き換える。

```bash
    integration_branch:"main",roles:{design:{terminal:"term_w",task:"task_x",dispatch:"ctx_x",retained:false}}}' > "$SD/workers.json"
```

`test/test-wait.sh` の `setup()` 内の 1 行を書き換える。

```bash
  echo '{"roles":{"design":{"terminal":"term_w","task":"task_x","dispatch":"ctx_x","retained":false}}}' > "$SD/workers.json"
```

`test/test-wait.sh` の WT4d の fixture も同様に書き換える。

```bash
echo '{"roles":{"design":{"terminal":"term_w","task":"task_f2917652a612","dispatch":"ctx_22efecad4b84","retained":false}}}' > "$SD/workers.json"
```

`test/test-docs.sh` の 85 / 103 / 126 行目の `design:{terminal:"term_w",dispatch:"ctx_w"}}` を、それぞれ `roles:{design:{terminal:"term_w",dispatch:"ctx_w",retained:false}}}` に書き換える。

`test/test-start.sh:81` の検証式を書き換える。

```bash
       and .roles.design.terminal=="term_w" and .roles.design.task=="task_x" and .roles.design.dispatch=="ctx_x"' \
```

- [ ] **Step 2: テストを走らせて赤いことを確認する**

Run: `cd apps/orca-team-dispatch-task && bash test/run-all.sh`
Expected: `test-start` / `test-wait` / `test-merge` / `test-docs` が FAIL する（本体がまだ旧キーを読んでいるため）

- [ ] **Step 3: `orca-start.sh` の書き込みを新しい形にする**

`workers-initial` の jq を書き換える。

```bash
postwrite workers-initial "$SD/workers.json" "$(jq -nc --arg r "$RUN" --arg w "$WT_ID" --arg p "$WT_PATH" \
  --arg b "$BR" --arg h "$H" --arg ib "$IB" --argjson own "$OWNED" --argjson ts "$TERMS" \
  '{run_id:$r,worktree_id:$w,worktree_path:$p,branch:$b,integration_branch:$ib,
    worktree_created_by_this_run:$own, worktree_terminals:$ts,
    roles:{design:{terminal:$h, retained:false}}}')"
```

後続の 2 つの更新も書き換える。

```bash
write workers-after-task "$SD/workers.json" "$(jq -c --arg t "$TID" '.roles.design.task = $t' "$SD/workers.json")" || {
```

```bash
write workers-after-dispatch "$SD/workers.json" "$(jq -c --arg d "$DID" '.roles.design.dispatch = $d' "$SD/workers.json")" || {
```

- [ ] **Step 4: `orca-wait.sh` と `orca-merge.sh` の読み出しを書き換える**

`bin/orca-wait.sh:31-32`:

```bash
TID=$(jq -r '.roles.design.task // empty' "$SD/workers.json")
DID=$(jq -r '.roles.design.dispatch // empty' "$SD/workers.json")
```

`bin/orca-merge.sh`:

```bash
TID=$(value '.roles.design.task' "$SD/workers.json") || stop "the dispatch identity is incomplete"
DID=$(value '.roles.design.dispatch' "$SD/workers.json") || stop "the dispatch identity is incomplete"
```

- [ ] **Step 5: SKILL.md の `[C1]` `[C2]` `[C3]` を書き換える**

3 ブロックに現れる次の 2 パターンを置換する。

```bash
DID=$(jq -r '.roles.design.dispatch // empty' "$SD/workers.json" 2>/dev/null)
TH=$(jq -r '.roles.design.terminal // empty' "$SD/workers.json" 2>/dev/null)
```

- [ ] **Step 6: `guide-ja.md` の同じ 3 ブロックを同じ内容にする**

bash ブロックは **バイト一致**でなければ `test-docs.sh` の SK8d が落ちる。SKILL.md 側からコピーして貼る。

- [ ] **Step 7: テストを走らせて緑になることを確認する**

Run: `cd apps/orca-team-dispatch-task && bash test/run-all.sh`
Expected: `ALL GREEN`。**期待値を 1 つも変えずに緑になること**が、挙動を変えていない証明になる

- [ ] **Step 8: Commit**

```bash
git add apps/orca-team-dispatch-task
git commit -m "$(cat <<'EOF'
refactor(orca-dispatch): workers.json を roles 形へ移す

Stage B で design_review / exec / exec_review を足せるように、
design を roles の下へ移し retained フィールドを足した。
挙動は変えていない（期待値を 1 つも変えずに全テストが緑）。

Claude-Session: https://claude.ai/code/session_01Hjrrf6y5oDbwAgAHmHHgp3
EOF
)"
```

---

### Task 3: `orca-start.sh` が端末を作るのをやめ、`worker-start --agent` に任せる

**前提:** Task 1 で U1 が **(a)** に確定していること。

**Files:**
- Modify: `apps/orca-team-dispatch-task/bin/orca-start.sh`
- Modify: `apps/orca-team-dispatch-task/test/test-start.sh`
- Modify: `apps/orca-team-dispatch-task/test/test-e2e.sh:22`

**Interfaces:**
- Consumes: Task 1 が確定した端末 handle の JSON パス（以下 `result.worker.agent_terminal_handle` として書く。Task 1 の実測が違えばそちらに合わせる）
- Produces: `worker-start` は `--agent claude --worktree id:<wt>` で呼ばれ、`--terminal` を渡さない。`orca-start.sh` は `terminal create` / `terminal wait` を一切呼ばない

- [ ] **Step 1: 失敗するテストを書く**

`test/test-start.sh` の末尾（`echo "---"` の直前）に足す。

```bash
# ST20: 端末は Orca に作らせる。terminal create / terminal wait を呼ばない
setup; start >/dev/null 2>&1
! grep -q 'terminal create' "$ORCA_STUB_DIR/calls.log" \
  && ! grep -q 'terminal wait' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST20 端末を自分で作らない" || fail "ST20 terminal create を呼んだ"; teardown

# ST21: worker-start は --agent を渡し、--terminal を渡さない
setup; start >/dev/null 2>&1; l=$(grep 'orchestration worker-start' "$ORCA_STUB_DIR/calls.log" | head -1)
[[ "$l" == *--agent* && "$l" == *claude* && "$l" != *--terminal* ]] \
  && ok "ST21 worker-start の argv" || fail "ST21 ($l)"; teardown

# ST22: 端末 handle は worker-start の receipt から取る
setup; start >/dev/null 2>&1
[[ "$(jq -r '.roles.design.terminal' "$R/.dispatch/s/workers.json")" == "term_w" ]] \
  && ok "ST22 receipt から handle を取る" || fail "ST22"; teardown

# ST23: rc 0 でも handle が無ければ資源を残して止まる。**推測しない**
setup; echo '{"ok":true,"result":{"state":"ready","dispatchId":"ctx_x","worker":{}}}' \
  > "$ORCA_STUB_DIR/orchestration_worker-start"
out=$(start 2>&1); rc=$?
[[ "$rc" -eq 1 && "$out" == *"Resources are KEPT"* ]] \
  && ! grep -q 'worktree rm' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST23 handle 不明で資源を残す" || fail "ST23 (rc=$rc out=$out)"; teardown
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `cd apps/orca-team-dispatch-task && bash test/test-start.sh`
Expected: `FAIL: ST20` `FAIL: ST21` `FAIL: ST22` `FAIL: ST23`

- [ ] **Step 3: runner 生成と `terminal create` を削除する**

`bin/orca-start.sh` から次のブロックを**丸ごと削除**する。

```bash
# 削除する
RUNNER="$SD/run-design.sh"
{ printf '%s\n' '#!/usr/bin/env bash'
  printf 'export ORCA_BIN=%q\n' "$ORCA_BIN"
  printf 'exec claude --dangerously-skip-permissions\n'
} > "$RUNNER" && chmod +x "$RUNNER" || { kept "cannot write the runner"; cleanup_before_task; exit 1; }

printf -v RUN_CMD 'bash %q' "$RUNNER"
TCR=0; TCJ2=$("$ORCA_BIN" terminal create --worktree "id:$WT_ID" --title "$SLUG-design" \
                --command "$RUN_CMD" --json 2>/dev/null) || TCR=$?
H=$(jq -r '.result.terminal.handle // empty' <<<"$TCJ2" 2>/dev/null || echo "")
[[ "$TCR" -eq 0 && -n "$H" ]] || { kept "terminal create failed (rc=$TCR)"; cleanup_before_task; exit 1; }
"$ORCA_BIN" terminal wait --terminal "$H" --for tui-idle --timeout-ms 120000 --json >/dev/null 2>&1 \
  || log "tui-idle wait timed out (continuing)"
```

- [ ] **Step 4: `cleanup_before_task` から端末を落とす**

端末は Task 作成より後に生まれるので、巻き戻し対象は worktree だけになる。

```bash
cleanup_before_task() {
  local wr=0
  if [[ -z "$CREATED" ]]; then log "the worktree was reused, so it is kept"
  else
    "$ORCA_BIN" worktree rm --worktree "id:$CREATED" --force --json >/dev/null 2>&1 || wr=$?
    [[ "$wr" -eq 0 ]] && log "the worktree this call created was removed" \
      || log "worktree rm FAILED (rc=$wr); it is KEPT"
  fi
}
```

- [ ] **Step 5: `workers.json` の初期書き込みから端末と inventory を外す**

端末はまだ存在しないので、`H` も `TERMS` もここでは書けない。`terminal list` の呼び出しごと `worker-start` の後ろへ移す。

```bash
postwrite status "$SD/roles/design/status.json" '{"status":"starting"}'
OWNED=false; [[ -n "$CREATED" ]] && OWNED=true
postwrite workers-initial "$SD/workers.json" "$(jq -nc --arg r "$RUN" --arg w "$WT_ID" --arg p "$WT_PATH" \
  --arg b "$BR" --arg ib "$IB" --argjson own "$OWNED" \
  '{run_id:$r,worktree_id:$w,worktree_path:$p,branch:$b,integration_branch:$ib,
    worktree_created_by_this_run:$own, worktree_terminals:null,
    roles:{design:{retained:false}}}')"
```

- [ ] **Step 6: `worker-start` を `--agent` 経路にし、handle を receipt から取る**

```bash
WRC=0; WJ2=$("$ORCA_BIN" orchestration worker-start --task "$TID" --worktree "id:$WT_ID" \
               --agent claude --from "$PH" --json 2>/dev/null) || WRC=$?
WSTATE=$(jq -r '.result.state // empty' <<<"$WJ2" 2>/dev/null || echo "")
DID=$(jq -r '.result.dispatchId // empty' <<<"$WJ2" 2>/dev/null || echo "")
H=$(jq -r '.result.worker.agent_terminal_handle // empty' <<<"$WJ2" 2>/dev/null || echo "")
if [[ "$WRC" -ne 0 || "$WSTATE" != ready || -z "$DID" ]]; then
  log "worker-start did not report ready (rc=$WRC state='${WSTATE:-none}'). Resources are KEPT."
  log "inspect with: $ORCA_BIN orchestration task-list --run $RUN --json"
  exit 1
fi
if [[ -z "$H" ]]; then
  log "worker-start reported ready but returned no agent terminal handle. Resources are KEPT."
  log "task=$TID dispatch=$DID  inspect with: $ORCA_BIN orchestration worker-show --dispatch $DID --json"
  exit 1
fi
```

- [ ] **Step 7: `worker-start` の後ろで端末を inventory して記録する**

削除した `terminal list` のブロックを、ここへそのまま移す。

```bash
TLRC=0; TL=$("$ORCA_BIN" terminal list --worktree "id:$WT_ID" --json 2>/dev/null) || TLRC=$?
if [[ "$TLRC" -eq 0 ]] && jq -e '.result.terminals | type == "array"' <<<"$TL" >/dev/null 2>&1; then
  TERMS=$(jq -c '[.result.terminals[].handle]' <<<"$TL")
else
  TERMS=null
  log "could not inventory the terminals in this worktree (rc=$TLRC); cleanup will refuse to remove it"
fi
write workers-after-dispatch "$SD/workers.json" \
  "$(jq -c --arg d "$DID" --arg h "$H" --argjson ts "$TERMS" \
     '.roles.design.dispatch = $d | .roles.design.terminal = $h | .worktree_terminals = $ts' \
     "$SD/workers.json")" || {
  kept "the worker started but the dispatch id could not be recorded. Resources are KEPT."
  log "task=$TID dispatch=$DID"
  log "inspect with: $ORCA_BIN orchestration worker-show --dispatch $DID --json"; exit 1; }
```

- [ ] **Step 8: 消えた経路を支えていたテストを削除・書き換える**

`test/test-start.sh` から次を**削除**する: `ST6g`（`terminal_create.rc` を見る）、`ST6h`（不完全な `terminal create` receipt）、`ST11` のうち `run-design.sh` の存在を検査する行、`ST12`（`terminal create` に runner の絶対パスを渡す）、および末尾（279 行付近）の `terminal_create` fixture を置く setup。

`setup()` から `terminal_create` の fixture 行を削除し、`orchestration_worker-start` の fixture に handle を足す。

```bash
  echo '{"ok":true,"result":{"state":"ready","dispatchId":"ctx_x","worker":{"agent_terminal_handle":"term_w"}}}' \
    > "$ORCA_STUB_DIR/orchestration_worker-start"
```

`terminal create` が呼ばれないことを主張していた早期失敗の検査（102 / 107 / 127 行付近）は、`terminal create` がそもそも存在しなくなり空虚になるので `worker-start` に変える。

```bash
[[ $? -eq 1 ]] && ! grep -q 'orchestration worker-start' "$ORCA_STUB_DIR/calls.log" \
```

`test/test-e2e.sh:22` の `terminal_create` fixture を削除し、同ファイルの `orchestration_worker-start` fixture に handle を足す。

- [ ] **Step 9: テストが緑になることを確認する**

Run: `cd apps/orca-team-dispatch-task && bash test/run-all.sh`
Expected: `ALL GREEN`

- [ ] **Step 10: Commit**

```bash
git add apps/orca-team-dispatch-task
git commit -m "$(cat <<'EOF'
feat(orca-dispatch): 端末生成を Orca の worker-start --agent に任せる

自前の terminal create + runner スクリプト生成 + tui-idle 待ちを削除し、
worker-start --agent claude が作る agent 端末を使う。端末 handle は
receipt から取り、取れなければ資源を残して停止する（推測しない）。

これにより --model / --effort がネイティブに使えるようになる（Stage C）。
呼ばれなくなった経路を支えていたテストと fixture も同時に削除した。

Claude-Session: https://claude.ai/code/session_01Hjrrf6y5oDbwAgAHmHHgp3
EOF
)"
```

---

### Task 4: `orca-start.sh` に `--run <run_id>` を足して 1 つの Run に相乗りさせる

**Files:**
- Modify: `apps/orca-team-dispatch-task/bin/orca-start.sh`
- Modify: `apps/orca-team-dispatch-task/test/test-start.sh`

**Interfaces:**
- Produces: `orca-start.sh` は `run_id=<id>` を stdout に印字する（`status_dir=` と並べて）。2 本目以降の呼び出しは `--run <id>` を受け取り、`run-create` を呼ばない

- [ ] **Step 1: 失敗するテストを書く**

`test/test-start.sh` の末尾に足す。

```bash
# ST24: --run を渡したら run-create を呼ばず、束縛だけ確かめる
setup; start --run run_x >/dev/null 2>&1
! grep -q 'run-create' "$ORCA_STUB_DIR/calls.log" \
  && grep -q 'run-current' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST24 Run に相乗りする" || fail "ST24"; teardown

# ST25: 相乗り先が自分に束縛されていなければ何も作らない
setup
echo '{"ok":true,"result":{"run":{"id":"run_x","coordinator_handle":"term_other"}}}' \
  > "$ORCA_STUB_DIR/orchestration_run-current"
out=$(start --run run_x 2>&1); rc=$?
[[ "$rc" -eq 1 ]] && ! grep -q 'worktree create' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST25 他人の Run に相乗りしない" || fail "ST25 (rc=$rc out=$out)"; teardown

# ST26: 相乗り先の id が食い違ったら止める
setup
echo '{"ok":true,"result":{"run":{"id":"run_other","coordinator_handle":"term_p"}}}' \
  > "$ORCA_STUB_DIR/orchestration_run-current"
start --run run_x >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 1 ]] && ok "ST26 別 Run への相乗りを拒否" || fail "ST26 (rc=$rc)"; teardown

# ST27: run_id を stdout に印字する（2 本目以降が使う）
setup; out=$(start 2>/dev/null)
[[ "$out" == *"run_id=run_x"* ]] && ok "ST27 run_id を印字" || fail "ST27 ($out)"; teardown
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `cd apps/orca-team-dispatch-task && bash test/test-start.sh`
Expected: `FAIL: ST24` `FAIL: ST25` `FAIL: ST26`（ST27 は既に印字していれば通る）

- [ ] **Step 3: 引数を足す**

```bash
RF="" SLUG="" OBJ="" RR="" RUN_IN=""
while [[ $# -gt 0 ]]; do case "$1" in
  --request-file) need2 "$1" $#; RF="$2";     shift 2 ;;
  --slug)         need2 "$1" $#; SLUG="$2";   shift 2 ;;
  --objective)    need2 "$1" $#; OBJ="$2";    shift 2 ;;
  --repo-root)    need2 "$1" $#; RR="$2";     shift 2 ;;
  --run)          need2 "$1" $#; RUN_IN="$2"; shift 2 ;;
  *) die "unknown option: $1" ;; esac; done
```

- [ ] **Step 4: Run の作成を分岐させる**

既存の `--- Run ---` ブロックを置き換える。束縛の確認（O26）はどちらの経路でも通す。

```bash
# --- Run ---
if [[ -n "$RUN_IN" ]]; then
  RUN="$RUN_IN"
else
  RCJ=0; RJ=$("$ORCA_BIN" orchestration run-create --objective "$OBJ" --from "$PH" --json 2>/dev/null) || RCJ=$?
  RUN=$(jq -r '.result.run.id // empty' <<<"$RJ" 2>/dev/null || echo "")
  [[ "$RCJ" -eq 0 && -n "$RUN" ]] || { log "run-create failed (rc=$RCJ)"; exit 1; }
fi
# 束縛先が自分であることを確かめる。候補が 1 つのとき Orca は暗黙に選ぶ (O26)
CJ2=$("$ORCA_BIN" orchestration run-current --from "$PH" --json 2>/dev/null)
CO=$(jq -r '.result.run.coordinator_handle // empty' <<<"$CJ2")
CI=$(jq -r '.result.run.id // empty' <<<"$CJ2")
[[ "$CO" == "$PH" ]] || { log "the Run bound to '${CO:-unknown}', not to $PH"; exit 1; }
[[ "$CI" == "$RUN" ]] || { log "this terminal is bound to Run '${CI:-unknown}', not to $RUN"; exit 1; }
```

- [ ] **Step 5: `run_id` を印字する**

最終行を書き換える。

```bash
printf 'status_dir=%s\nrun_id=%s\n' "$SD" "$RUN"
```

（既存の最終行が同じならそのままでよい。`run_id=` が出ていることを確認する）

- [ ] **Step 6: テストが緑になることを確認する**

Run: `cd apps/orca-team-dispatch-task && bash test/run-all.sh`
Expected: `ALL GREEN`

- [ ] **Step 7: Commit**

```bash
git add apps/orca-team-dispatch-task
git commit -m "$(cat <<'EOF'
feat(orca-dispatch): --run で 1 つの Run に相乗りできるようにする

複数タスクを並列 dispatch するとき、Run は 1 つで足りる（Orca の Run は
namespace/inbox であり、複数 Task を持てる）。2 本目以降の orca-start.sh は
--run を受け取り run-create を呼ばない。相乗り先が自分に束縛された同じ Run で
あることを id と coordinator handle の両方で確かめてから進む。

Claude-Session: https://claude.ai/code/session_01Hjrrf6y5oDbwAgAHmHHgp3
EOF
)"
```

---

### Task 5: `orca-wait.sh` を release から retain へ切り替える

worker のセッションを最後まで保持し、解放権限を Step 6 だけに集約する（spec D6 / D11 / D12）。**この Task ではまだ 1 タスクのまま。**

**Files:**
- Modify: `apps/orca-team-dispatch-task/bin/orca-wait.sh`
- Modify: `apps/orca-team-dispatch-task/test/test-wait.sh`
- Modify: `apps/orca-team-dispatch-task/test/test-e2e.sh`（E7 と `worker-release` fixture）

**Interfaces:**
- Produces: `orca-wait.sh` は `worker-release` を一切呼ばない。`worker_done` を処理した batch では、ack の前に `worker-retain --dispatch <id>` を呼び、成功したら `workers.json` の `.roles.design.retained` を `true` にする

- [ ] **Step 1: 既存テストを新しい契約へ書き換える**

`test/test-wait.sh` の `WT10` / `WT10b` を差し替える。

```bash
# WT10: **worker_done は retain してから ack する。**解放は Step 6 だけの権限（spec D12）
setup; dn; msg; w >/dev/null 2>&1
r=$(grep -n 'worker-retain' "$ORCA_STUB_DIR/calls.log" | head -1 | cut -d: -f1)
a=$(grep -n -- '--ack' "$ORCA_STUB_DIR/calls.log" | head -1 | cut -d: -f1)
[[ -n "$r" && -n "$a" && "$r" -lt "$a" ]] && ok "WT10 retain が ack より前" || fail "WT10 順序 ($r/$a)"
! grep -q 'worker-release' "$ORCA_STUB_DIR/calls.log" || fail "WT10b release を呼んだ"
[[ "$(jq -r '.roles.design.retained' "$SD/workers.json")" == "true" ]] \
  && ok "WT10c retained を記録" || fail "WT10c"; teardown
```

`WT11` / `WT11b` / `WT11c` は `worker-release` の状態分岐を検査しているが、その分岐は `orca-wait.sh` から消える。**3 件とも削除**し、retain 版の 1 件に置き換える。

```bash
# WT11: retain の receipt が ok でなければ ack しない
setup; dn; msg
echo '{"ok":false,"error":"unavailable"}' > "$ORCA_STUB_DIR/orchestration_worker-retain"
out=$(w 2>&1); rc=$?
[[ "$rc" -eq 4 && "$out" == *"worker-retain receipt was not ok"* && -e "$SD/received.json" ]] \
  && ! grep -q -- '--ack' "$ORCA_STUB_DIR/calls.log" \
  && ok "WT11 retain 失敗で ack しない" || fail "WT11 (rc=$rc out=$out)"; teardown
```

`WT18a` / `WT18a1` も `worker-release` の transport 失敗を見ているので **削除**する（WT11 が同じ性質を retain で覆う）。

`setup()` の `orchestration_worker-release` fixture を `orchestration_worker-retain` に差し替える。

```bash
  echo '{"ok":true,"result":{}}' > "$ORCA_STUB_DIR/orchestration_worker-retain"
```

`WT4d` / `WT4e` / `WT12` / `WT13` / `WT15` / `WT16` / `WT17` にある `grep -c 'worker-release\|--ack'` と `grep -q 'worker-release\|--ack'` を、`'worker-retain\|--ack'` に置換する。

- [ ] **Step 2: `test-e2e.sh` の E7 も新しい契約へ書き換える**

`test/test-e2e.sh` の `orchestration_worker-release` fixture を `orchestration_worker-retain` に差し替える。

```bash
echo '{"ok":true,"result":{}}' > "$ORCA_STUB_DIR/orchestration_worker-retain"
```

E7 を差し替える。

```bash
# **retain してから ack している**（解放は Step 6 だけの権限。spec D12）
r=$(grep -n 'worker-retain' "$ORCA_STUB_DIR/calls.log" | head -1 | cut -d: -f1)
a=$(grep -n -- '--ack' "$ORCA_STUB_DIR/calls.log" | head -1 | cut -d: -f1)
[[ -n "$r" && -n "$a" && "$r" -lt "$a" ]] && ! grep -q 'worker-release' "$ORCA_STUB_DIR/calls.log" \
  && ok "E7 retain が ack より前・release しない" || fail "E7 順序 ($r/$a)"
```

- [ ] **Step 3: テストが失敗することを確認する**

Run: `cd apps/orca-team-dispatch-task && bash test/test-wait.sh && bash test/test-e2e.sh`
Expected: `FAIL: WT10` `FAIL: WT10b` `FAIL: WT11` `FAIL: E7` ほか

- [ ] **Step 4: `drain()` の release を retain に置き換える**

`bin/orca-wait.sh` の `drain()` 内、`record_outcome` の後ろのブロックを丸ごと置き換える。

```bash
  [[ "$record_needed" -eq 0 ]] || record_outcome "$batch_oc" || return 1
  # ★ **ack より前に owner を決める**（Orca guide）。この版の owner は常に「保持」である。
  #   解放は Step 6 のユーザー承認後だけが行う (spec D12)。
  RETRC=0
  RET=$("$ORCA_BIN" orchestration worker-retain --dispatch "$DID" --json 2>/dev/null) || RETRC=$?
  jq -e '.ok == true' <<<"$RET" >/dev/null 2>&1 || {
    log "worker-retain receipt was not ok (rc=$RETRC); the batch is not acknowledged"
    return 2
  }
  [[ "$RETRC" -eq 0 ]] || {
    log "worker-retain failed (rc=$RETRC); the batch is not acknowledged"
    return 2
  }
  write "$SD/workers.json" "$(jq -c '.roles.design.retained = true' "$SD/workers.json")" || {
    log "could not record the retention; the batch is not acknowledged"
    return 2
  }
```

`drain()` の局所変数宣言から `REL RELRC RST` を外し、`RET RETRC` を入れる。

- [ ] **Step 5: テストが緑になることを確認する**

Run: `cd apps/orca-team-dispatch-task && bash test/run-all.sh`
Expected: `ALL GREEN`

- [ ] **Step 6: Commit**

```bash
git add apps/orca-team-dispatch-task
git commit -m "$(cat <<'EOF'
feat(orca-dispatch): 待機は worker を解放せず保持する

worker_done を処理したら ack の前に worker-retain で端末を保持し、
worker-release は呼ばない。Stage B のレビュー差し戻しで design の
セッションへ投げ直せるようにするための前提であり、解放の権限を
Step 6（ユーザー承認後）だけに集約する。

Claude-Session: https://claude.ai/code/session_01Hjrrf6y5oDbwAgAHmHHgp3
EOF
)"
```

---

### Task 6: `orca-wait.sh` を複数 `--status-dir` の集約待機にする

**Files:**
- Modify: `apps/orca-team-dispatch-task/bin/orca-wait.sh`
- Modify: `apps/orca-team-dispatch-task/test/test-wait.sh`

**Interfaces:**
- Produces: `orca-wait.sh --status-dir <d1> --status-dir <d2> …`。exit は 0（全 succeeded）/ 5（1 件以上 failed）/ 3（時間切れ）/ 1（batch 処理不能）/ 4（transport 不明）/ 2（使用法）

- [ ] **Step 1: 失敗するテストを書く**

`test/test-wait.sh` に 2 タスク用のヘルパーと検査を足す（`echo "---"` の直前）。

```bash
# --- 2 タスクの集約待機 ---
setup2() {
  setup
  SD2=$(mktemp -d); mkdir -p "$SD2/roles/design"
  echo '{"run_id":"run_x","parent_handle":"term_p","repo_root":"/tmp"}' > "$SD2/run.json"
  echo '{"roles":{"design":{"terminal":"term_w2","task":"task_y","dispatch":"ctx_y","retained":false}}}' \
    > "$SD2/workers.json"
  echo '{"status":"executing"}' > "$SD2/roles/design/status.json"
}
teardown2() { rm -rf "$SD2"; teardown; }
w2() { bash "$P/bin/orca-wait.sh" --status-dir "$SD" --status-dir "$SD2" \
         --max-waits "${1:-1}" --timeout-ms 1; }
both_msg() { jq -nc --arg o1 "${1:-succeeded}" --arg o2 "${2:-succeeded}" \
  '{ok:true,result:{runId:"run_x",deliveryId:"d9",count:2,messages:[
    {id:"n1",type:"worker_done",payload:({taskId:"task_x",dispatchId:"ctx_x",outcome:$o1}|tojson),body:""},
    {id:"n2",type:"worker_done",payload:({taskId:"task_y",dispatchId:"ctx_y",outcome:$o2}|tojson),body:""}]}}' \
  > "$ORCA_STUB_DIR/orchestration_check"; }
dn2() { echo '{"status":"done"}' > "$SD2/roles/design/status.json"; }
er2() { echo '{"status":"error"}' > "$SD2/roles/design/status.json"; }

# WT21: 1 batch に 2 タスクの worker_done が同居しても、両方を正しく振り分ける
setup2; dn; dn2; both_msg; out=$(w2 2>/dev/null); rc=$?
[[ "$rc" -eq 0 && "$(jq -c . "$SD/received.json")" == '["worker_done|task_x|ctx_x|succeeded"]' \
   && "$(jq -c . "$SD2/received.json")" == '["worker_done|task_y|ctx_y|succeeded"]' ]] \
  && ok "WT21 receipt を振り分ける" || fail "WT21 (rc=$rc out=$out)"; teardown2

# WT22: settle した dispatch すべてを retain してから ack は 1 回
setup2; dn; dn2; both_msg; w2 >/dev/null 2>&1
[[ "$(grep -c 'worker-retain' "$ORCA_STUB_DIR/calls.log")" -eq 2 \
   && "$(grep -c -- '--ack' "$ORCA_STUB_DIR/calls.log")" -eq 1 ]] \
  && ok "WT22 retain 2 回・ack 1 回" || fail "WT22"; teardown2

# WT23: 1 件成功・1 件失敗は 5。両方の receipt は残る
setup2; dn; er2; both_msg succeeded failed; w2 >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 5 && -s "$SD/received.json" && -s "$SD2/received.json" ]] \
  && ok "WT23 部分失敗は 5" || fail "WT23 (rc=$rc)"; teardown2

# WT24: 期待集合に無い dispatch が混ざったら ack も retain もしない
setup2; dn; dn2
jq -nc '{ok:true,result:{runId:"run_x",deliveryId:"d9",count:2,messages:[
  {id:"n1",type:"worker_done",payload:({taskId:"task_x",dispatchId:"ctx_x",outcome:"succeeded"}|tojson),body:""},
  {id:"n3",type:"worker_done",payload:({taskId:"task_z",dispatchId:"ctx_z",outcome:"succeeded"}|tojson),body:""}]}}' \
  > "$ORCA_STUB_DIR/orchestration_check"
w2 >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 1 ]] && ! grep -q 'worker-retain\|--ack' "$ORCA_STUB_DIR/calls.log" \
  && ok "WT24 未知の dispatch を含む batch を捨てない" || fail "WT24 (rc=$rc)"; teardown2

# WT25: parent_handle が食い違う status-dir を混ぜたら使用法エラー
setup2; echo '{"run_id":"run_x","parent_handle":"term_q","repo_root":"/tmp"}' > "$SD2/run.json"
w2 >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 2 ]] && ok "WT25a parent 不一致は 2" || fail "WT25a (rc=$rc)"; teardown2
setup2; echo '{"run_id":"run_y","parent_handle":"term_p","repo_root":"/tmp"}' > "$SD2/run.json"
w2 >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 2 ]] && ok "WT25b run 不一致は 2" || fail "WT25b (rc=$rc)"; teardown2

# WT26: 片方だけ終端なら終わらない（もう片方を待ち続けて時間切れ 3）
setup2; dn; msg; w2 2 >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 3 ]] && ok "WT26 全件終端まで待つ" || fail "WT26 (rc=$rc)"; teardown2
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `cd apps/orca-team-dispatch-task && bash test/test-wait.sh`
Expected: `FAIL: WT21` 以降が失敗する（`--status-dir` の 2 回目が「unknown option」で exit 2 になる）

- [ ] **Step 3: 引数と期待集合を作る**

`bin/orca-wait.sh` の引数解析と検証を書き換える。

```bash
SDS=() MAXW=12 TMO=300000
while [[ $# -gt 0 ]]; do case "$1" in
  --status-dir) need2 "$1" $#; SDS+=("$2"); shift 2 ;;
  --max-waits)  need2 "$1" $#; MAXW="$2";   shift 2 ;;
  --timeout-ms) need2 "$1" $#; TMO="$2";    shift 2 ;;
  *) die "unknown option: $1" ;;
esac; done
[[ "${#SDS[@]}" -ge 1 ]] || die "--status-dir is required"
[[ "$MAXW" =~ ^[1-9][0-9]*$ ]] || die "--max-waits must be a positive integer"
[[ "$TMO" =~ ^[1-9][0-9]*$ ]] || die "--timeout-ms must be a positive integer"

PH="" RUN=""
declare -a TASKS DISPS
for sd in "${SDS[@]}"; do
  [[ -r "$sd/run.json" && -r "$sd/workers.json" ]] || die "cannot read the dispatch state in $sd"
  h=$(jq -r '.parent_handle // empty' "$sd/run.json")
  r=$(jq -r '.run_id // empty' "$sd/run.json")
  t=$(jq -r '.roles.design.task // empty' "$sd/workers.json")
  d=$(jq -r '.roles.design.dispatch // empty' "$sd/workers.json")
  [[ -n "$h" && -n "$r" && -n "$t" && -n "$d" ]] || die "the dispatch identity is incomplete in $sd"
  [[ -z "$PH"  || "$PH"  == "$h" ]] || die "the status dirs do not share one parent terminal"
  [[ -z "$RUN" || "$RUN" == "$r" ]] || die "the status dirs do not share one Run"
  PH="$h"; RUN="$r"; TASKS+=("$t"); DISPS+=("$d")
done
```

- [ ] **Step 4: `(task, dispatch)` から status-dir を引く関数を足す**

```bash
sd_of() {   # $1=task $2=dispatch → 対応する status dir を stdout。無ければ 1
  local i
  for i in "${!SDS[@]}"; do
    [[ "${TASKS[$i]}" == "$1" && "${DISPS[$i]}" == "$2" ]] || continue
    printf '%s' "${SDS[$i]}"; return 0
  done
  return 1
}
```

`write` / `stored_outcome` / `record_outcome` を **status-dir を第 1 引数で受ける形**に変える（`$SD` の暗黙参照をやめる）。

```bash
write() {   # $1=status dir $2=path $3=content
  local t
  t=$(mktemp "$1/.tmp.XXXXXX") || return 1
  printf '%s\n' "$3" > "$t" && mv -f "$t" "$2" || { rm -f "$t"; return 1; }
}
stored_outcome() {   # $1=status dir。receipt が 1 件なら outcome を stdout、0 件なら空、壊れていれば 1
  local sd="$1" recv matches count tid did
  recv="$sd/received.json"
  tid=$(jq -r '.roles.design.task // empty' "$sd/workers.json")
  did=$(jq -r '.roles.design.dispatch // empty' "$sd/workers.json")
  [[ -f "$recv" ]] || return 0
  matches=$(jq -c --arg task "$tid" --arg dispatch "$did" \
    'if type != "array" or any(.[]; type != "string" or (split("|") | length) != 4) then error("invalid receipts")
     else [.[] | split("|") | select(.[0] == "worker_done" and .[1] == $task and .[2] == $dispatch)]
     end' "$recv" 2>/dev/null) || { log "received outcome record is invalid or unreadable; it is not acknowledged"; return 1; }
  count=$(jq 'length' <<<"$matches") || { log "received outcome record is invalid or unreadable; it is not acknowledged"; return 1; }
  [[ "$count" -le 1 ]] || { log "received outcome record has duplicate receipts; it is not acknowledged"; return 1; }
  [[ "$count" -eq 0 ]] || jq -r '.[0][3]' <<<"$matches"
}
record_outcome() {   # $1=status dir $2=task $3=dispatch $4=outcome
  local sd="$1" records receipt
  records='[]'
  if [[ -f "$sd/received.json" ]]; then
    records=$(jq -c . "$sd/received.json") || { log "received outcome record is invalid or unreadable; it is not acknowledged"; return 1; }
  fi
  receipt="worker_done|$2|$3|$4"
  write "$sd" "$sd/received.json" "$(jq -c --arg receipt "$receipt" '. + [$receipt]' <<<"$records")" \
    || { log "could not record the worker outcome; it is not acknowledged"; return 1; }
}
```

- [ ] **Step 5: `drain()` を集合ベースにする**

メッセージごとに `sd_of` で所属を決め、属さないものは今までどおり ack を拒む。

```bash
    tsd=$(sd_of "$tid" "$did") || {
      log "batch $d carries a message this version cannot handle (type='$t' task='$tid' dispatch='$did')"
      log "it is NOT acknowledged, so nothing is lost. Inspect with:"
      log "  $ORCA_BIN orchestration check --terminal $PH --peek --json"
      return 1
    }
```

outcome の矛盾検査は **同じ `(task, dispatch)` の中だけ**で行う。既存の `batch_oc` は batch 全体で 1 つの outcome を要求しているので、2 タスクが混ざると必ず誤判定する。`batch_oc` を捨て、`(task, dispatch)` → outcome の連想配列にする。

```bash
  declare -A SETTLED=()
  for ((i = 0; i < n; i++)); do
    # …（型・payload・lifecycle rejection の検査は現行のまま）…
    tsd=$(sd_of "$tid" "$did") || { … return 1; }
    oc=$(jq -r '.outcome // empty' <<<"$payload")
    case "$oc" in
      succeeded|failed) ;;
      *) log "worker_done has outcome '${oc:-none}'"; return 1 ;;
    esac
    key="$tid|$did"
    [[ -z "${SETTLED[$key]:-}" || "${SETTLED[$key]}" == "$oc" ]] || {
      log "batch $d has contradictory outcomes for task '$tid' dispatch '$did'"
      return 1
    }
    SETTLED[$key]="$oc"
  done
```

receipt の記録と `worker-retain` は、`SETTLED` のキーごとに 1 回ずつ回す。**1 件でも失敗したらその時点で ack せずに戻る。**

```bash
  for key in "${!SETTLED[@]}"; do
    tid="${key%%|*}"; did="${key#*|}"; tsd=$(sd_of "$tid" "$did") || return 1
    existing=$(stored_outcome "$tsd") || return 1
    if [[ -n "$existing" && "$existing" != "${SETTLED[$key]}" ]]; then
      log "received outcome '$existing' contradicts batch outcome '${SETTLED[$key]}' for task '$tid' dispatch '$did'"
      return 1
    fi
    [[ -n "$existing" ]] || record_outcome "$tsd" "$tid" "$did" "${SETTLED[$key]}" || return 1
    RETRC=0
    RET=$("$ORCA_BIN" orchestration worker-retain --dispatch "$did" --json 2>/dev/null) || RETRC=$?
    jq -e '.ok == true' <<<"$RET" >/dev/null 2>&1 && [[ "$RETRC" -eq 0 ]] || {
      log "worker-retain receipt was not ok (rc=$RETRC) for dispatch '$did'; the batch is not acknowledged"
      return 2
    }
    write "$tsd" "$tsd/workers.json" "$(jq -c '.roles.design.retained = true' "$tsd/workers.json")" || {
      log "could not record the retention; the batch is not acknowledged"
      return 2
    }
  done
```

- [ ] **Step 6: 終了判定を集約する**

```bash
aggregate() {   # 全件終端なら outcome を stdout（succeeded / failed）。未終端なら 1
  local i sd st oc existing worst=succeeded
  for i in "${!SDS[@]}"; do
    sd="${SDS[$i]}"
    st=$(jq -r '.status // empty' "$sd/roles/design/status.json" 2>/dev/null || echo "")
    case "$st" in
      done)  oc=succeeded ;;
      error) oc=failed ;;
      *) return 1 ;;
    esac
    existing=$(stored_outcome "$sd") || return 1
    [[ "$existing" == "$oc" ]] || return 1
    [[ "$oc" == succeeded ]] || worst=failed
  done
  printf '%s' "$worst"
}
```

`finish()` と `healthy()` も全 dispatch を回すように変える。`healthy()` は 1 つでも不健全なら 1 を返す。

- [ ] **Step 7: テストが緑になることを確認する**

Run: `cd apps/orca-team-dispatch-task && bash test/run-all.sh`
Expected: `ALL GREEN`。既存の 1 タスクのケース（WT1〜WT20）が**すべて無改変で通る**こと

- [ ] **Step 8: Commit**

```bash
git add apps/orca-team-dispatch-task
git commit -m "$(cat <<'EOF'
feat(orca-dispatch): 複数タスクの集約待機に対応する

--status-dir を繰り返し受け取り、既知の (task, dispatch) 集合に照らして
1 本の FIFO Delivery を drain する。1 batch に複数タスクの worker_done が
同居しても取りこぼさず振り分け、settle した dispatch すべてを retain してから
1 回だけ ack する。集合に無いメッセージを含む batch は今までどおり ack しない。

exit 5 は「1 件以上が失敗」を意味する。成功したタスクだけ merge へ進む。

Claude-Session: https://claude.ai/code/session_01Hjrrf6y5oDbwAgAHmHHgp3
EOF
)"
```

---

### Task 7: `[C7]` — Orca の実状態と突き合わせてから片付ける

`worker-retain` は durable な例外を記録するので、スキルが中断されると保持が残る（spec 9-2）。自前の記録ではなく Orca に聞いてから消す。

**Files:**
- Modify: `apps/orca-team-dispatch-task/skills/orca-team-dispatch-task/SKILL.md`（Step 5 に `[C7]` を新設）
- Modify: `apps/orca-team-dispatch-task/skills/orca-team-dispatch-task/references/guide-ja.md`
- Modify: `apps/orca-team-dispatch-task/test/test-docs.sh`

**Interfaces:**
- Produces: `[C7]` ブロック。`$SD` と `$ORCA_BIN` だけを入力に取り、**記録に無い保持中 dispatch が 1 つでもあれば非 0 で終わる**

- [ ] **Step 1: 失敗するテストを書く**

`test/test-docs.sh` の `SK10` の直前に足す（`extract_cleanup_block` を再利用する）。

`test-docs.sh` は SKILL.md を `$S`、`guide-ja.md` を `$G`、プラグイン root を `$P` として持ち、`extract_cleanup_block <label> <file>` は **2 引数**を取る。

```bash
# SK13: [C7] は記録に無い保持中 dispatch を見つけたら止める
c7_scratch=$(mktemp -d); c7="$c7_scratch/C7.sh"
extract_cleanup_block C7 "$S" > "$c7"
c7_sd=$(mktemp -d)
echo '{"run_id":"run_x","parent_handle":"term_p","repo_root":"/tmp"}' > "$c7_sd/run.json"
echo '{"roles":{"design":{"dispatch":"ctx_w","retained":true}}}' > "$c7_sd/workers.json"

ORCA_STUB_DIR=$(mktemp -d); export ORCA_STUB_DIR ORCA_BIN="$P/test/lib/orca-stub.sh"
printf '%s\n' '{"ok":true,"result":{"workers":[{"dispatchId":"ctx_w"}]}}' \
  > "$ORCA_STUB_DIR/orchestration_worker-list"
out=$(SD="$c7_sd" bash "$c7" 2>&1); rc=$?
[[ "$rc" -eq 0 ]] && ok "SK13a 記録どおりなら通す" || fail "SK13a (rc=$rc out=$out)"

printf '%s\n' '{"ok":true,"result":{"workers":[{"dispatchId":"ctx_w"},{"dispatchId":"ctx_ghost"}]}}' \
  > "$ORCA_STUB_DIR/orchestration_worker-list"
out=$(SD="$c7_sd" bash "$c7" 2>&1); rc=$?
[[ "$rc" -ne 0 && "$out" == *ctx_ghost* ]] && ok "SK13b 記録に無い保持で止まる" \
  || fail "SK13b (rc=$rc out=$out)"

printf '%s\n' '{"ok":false,"error":"unavailable"}' > "$ORCA_STUB_DIR/orchestration_worker-list"
out=$(SD="$c7_sd" bash "$c7" 2>&1); rc=$?
[[ "$rc" -ne 0 ]] && ok "SK13c 列挙できなければ止まる" || fail "SK13c (rc=$rc out=$out)"
rm -rf "$c7_sd" "$c7_scratch" "$ORCA_STUB_DIR"; unset ORCA_BIN
```

`SK6c` の役ループに `C7` を足す。

```bash
for label in C1 C2 C3 C5 C7; do
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `cd apps/orca-team-dispatch-task && bash test/test-docs.sh`
Expected: `FAIL: SK13a`（`[C7]` がまだ無く `extract_cleanup_block` が空を返す）

- [ ] **Step 3: SKILL.md に `[C7]` を書く**

`[C3]` の説明文の後、`[C5]` の前に挿入する。

````markdown
[C7] `worker-retain` records a durable exception, so a session that died mid-dispatch
leaves retained terminals behind. Before removing anything for this Run, ask Orca what it
actually still holds and compare it against what we recorded. A retention we did not record
is someone else's — or our own from a previous run — and either way it is not ours to step
on:

```bash
: "${SD:?set SD to the exact status_dir printed in Step 2}"
ORCA_BIN="${ORCA_BIN:-/Applications/Orca.app/Contents/Resources/bin/orca}"
RUN=$(jq -r '.run_id // empty' "$SD/run.json" 2>/dev/null)
KNOWN=$(jq -c '[.roles[]?.dispatch // empty]' "$SD/workers.json" 2>/dev/null)
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
````

`[C3]` の条件説明に 1 行足す。

```markdown
- [C7] Before any removal, what Orca still holds for this Run must match what we recorded.
  A retained worker we cannot account for stops the whole Run's cleanup, not just its own
  task.
```

- [ ] **Step 4: `guide-ja.md` に同じものを書く**

見出しと散文は日本語、**bash ブロックはバイト一致**。

- [ ] **Step 5: テストが緑になることを確認する**

Run: `cd apps/orca-team-dispatch-task && bash test/run-all.sh`
Expected: `ALL GREEN`

- [ ] **Step 6: Commit**

```bash
git add apps/orca-team-dispatch-task
git commit -m "$(cat <<'EOF'
feat(orca-dispatch): 片付け前に Orca の保持状態と突き合わせる [C7]

worker-retain は durable な例外を記録するため、中断したセッションの保持が
残りうる。自前の workers.json ではなく worker-list --terminal-state retained を
正として突き合わせ、記録に無い保持が 1 つでもあれば、その Run の worktree と
dispatch 記録をどれも消さない。列挙できなかった場合も同じく止まる。

Claude-Session: https://claude.ai/code/session_01Hjrrf6y5oDbwAgAHmHHgp3
EOF
)"
```

---

### Task 8: SKILL.md / guide-ja.md を新しいライフサイクルへ書き換える

**Files:**
- Modify: `apps/orca-team-dispatch-task/skills/orca-team-dispatch-task/SKILL.md`
- Modify: `apps/orca-team-dispatch-task/skills/orca-team-dispatch-task/references/guide-ja.md`
- Modify: `apps/orca-team-dispatch-task/test/test-docs.sh`

**Interfaces:**
- Produces: N タスク並列の手順書。Step 1 の件数上限、Step 2 の `--run` 相乗り、Step 3 の集約待機、Step 5 の release state 4 分類、Step 6 の質問分割

- [ ] **Step 1: 文言を固定する失敗テストを書く**

`test/test-docs.sh` の末尾付近（`SK13` の後）に足す。

```bash
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

# SK15: 上限 4 タスクと質問の割り方が両文書にある
grep -q 'at most four tasks at once' "$S" && grep -q 'one question per task' "$S" \
  && grep -q '一度に 4 タスクまで' "$G" && grep -q 'タスクごとに 1 問' "$G" \
  && ok "SK15 質問の割り方" || fail "SK15"

# SK16: 消えた記述が残っていない
! grep -q 'run-design.sh' "$S" && ! grep -q 'run-design.sh' "$G" \
  && ! grep -q 'dangerously-skip-permissions' "$S" \
  && ok "SK16 消えた経路の記述が残っていない" || fail "SK16"
```

**注意:** 既存の `SK4` は SKILL.md に `design_review` / `exec_review` / `review_mode` / `merge_ready` などの語が現れると落ちる（「Stage 1 に無いものを宣言しない」）。Stage A でもこれらの役は実装しないので、**Step 3〜8 の本文でこれらの語を使ってはならない**。「a later stage」のようにぼかして書く。

- [ ] **Step 2: テストが失敗することを確認する**

Run: `cd apps/orca-team-dispatch-task && bash test/test-docs.sh`
Expected: `FAIL: SK14` `FAIL: SK15` `FAIL: SK16`

- [ ] **Step 3: Step 1 に件数の規則を足す**

```markdown
Dispatch at most four tasks at once. Four tasks is already four live agent sessions, and
Step 6 asks one question per task — `AskUserQuestion` takes at most four. If the user wants
more, show them the task count and the number of sessions it will start, and get an explicit
yes before going past four.
```

- [ ] **Step 4: Step 2 を N 回呼ぶ形にする**

```markdown
Run this once per task. **The first call creates the Run and prints `run_id`; every later
call passes that same `run_id` back with `--run`, so all tasks share one Run and one parent
mailbox.** Call them one after another, not in parallel.
```

`run_id` を拾う行を bash ブロックに足す。

```bash
RUN=$(sed -n 's/^run_id=//p' <<<"$OUT")
```

- [ ] **Step 5: Step 3 を集約待機にする**

`--status-dir` を並べる形に書き換え、**Step 3 の「端末は retained なので残る」という説明を削除する**（N17。今は `worker-retain` が明示的に保持している）。

```markdown
Tell the user first: when a worker finishes, this skill retains its terminal before it
acknowledges the message. Nothing is released here. The terminal, the worktree and the
dispatch record all survive until Step 5 decides what may go and Step 6 asks the user.
Retention is deliberate — a later stage sends review feedback back to the same session.
```

exit の表に「exit 5 は 1 件以上が失敗。成功したタスクだけ Step 4 へ進む」を足す。

- [ ] **Step 6: Step 5 の release state の読み方を書き換える**

`[C2]` の説明文を差し替える。

```markdown
[C2] Release the worker and read the state. `released` means Orca closed the terminal and
there is nothing left to do. `already_released` is the same, reached twice. `retained` means
Orca **refused** to close it — someone took it over, or its identity could not be proven —
so print a close command only when the handle and worktree still match our recorded state,
and otherwise say it is being kept and why.
```

**bash ブロックも直す。**`[C2]` と `[C3]` は現在 `retained|already_released` だけを通しているが、正常系が `released` になるので受理集合に足す。両ブロックの同じ箇所を書き換える。

```bash
case "$STATE" in
  released|retained|already_released) ;;
  *) echo "release state '${STATE:-unknown}' does not authorise C2" >&2; exit 1 ;;
esac
```

`[C2]` では、`released` のときは端末が既に閉じているので `terminal close` を印字しない。

```bash
if [[ "$STATE" == released ]]; then
  echo "Orca closed the worker terminal; nothing to close"
elif [[ "$(jq -r '.result.terminal.handle // empty' <<<"$SHOWN")" == "$TH" \
     && "$(jq -r '.result.terminal.worktreeId // empty' <<<"$SHOWN")" == "$WT" ]]; then
  printf '%s terminal close --terminal %q --json\n' "$ORCA_BIN" "$TH"
else
  echo "the terminal no longer matches our state; leave it alone"
fi
```

`[C3]` の削除条件に `released` を認める。`terminal show` の照合は `released` のとき成立しないので、その場合は `IDENTITY_OK=yes` とみなす（Orca が閉じたことがそのまま証明になる）。

```bash
IDENTITY_OK=no
if [[ "$STATE" == released ]]; then
  IDENTITY_OK=yes
elif [[ "$(jq -r '.result.terminal.handle // empty' <<<"$SHOWN")" == "$TH" \
     && "$(jq -r '.result.terminal.worktreeId // empty' <<<"$SHOWN")" == "$WT" ]]; then
  IDENTITY_OK=yes
fi
```

`test-docs.sh` の `C2-show-receipt` / `C3-show-receipt` / `C3-release-receipt` の各ケースは `orchestration_worker-release` fixture の `state` を返しているので、**`released` を返す新しいケースを 3 つ足す**（`released` で `terminal close` を印字しないこと、`released` で worktree 削除が提示されること、`released` で `terminal show` が失敗しても止まらないこと）。

- [ ] **Step 7: Step 6 の質問の割り方を書く**

```markdown
- Ask one question per task, with the task's slug as the question header, and offer only the
  actions Step 5 printed for that task. A task for which Step 5 printed nothing is left out
  of the question entirely — say what is being kept for it and why.
- `AskUserQuestion` takes at most four questions. If the user approved more than four tasks
  in Step 1, ask a single question instead whose options are "every task's terminals",
  "every task's worktrees" and "every task's dispatch records", and offer an option only when
  Step 5 printed that action for at least one task.
- Run the approved commands task by task in slug order, and within a task in this order:
  terminal, then worktree, then dispatch record.
```

- [ ] **Step 8: 制限表と `## State on disk` を直す**

「The runner is fixed and cannot be configured; it runs `claude --dangerously-skip-permissions`」の行を書き換える。**行数は変えない**（SK8c）。

```markdown
| Every role runs the `claude` agent Orca launches; the model and effort cannot be chosen yet | Dispatch only a task you trust, and wait for the stage that adds per-role agent settings |
```

`## State on disk` から `run-design.sh` を削り、`workers.json` の `roles` 形に触れる。

- [ ] **Step 9: `guide-ja.md` を同じ構造で更新する**

H2 見出しを増やしていないので `normalise_headings()` の更新は不要。増やしたなら登録する。

SK15 が拾う日本語の語を必ず含める: **`一度に 4 タスクまで`** と **`タスクごとに 1 問`**。bash ブロックは SKILL.md からコピーしてバイト一致にする。

- [ ] **Step 10: すべての検査を通す**

Run: `cd apps/orca-team-dispatch-task && bash test/run-all.sh`
Expected: `ALL GREEN`

Run: `node scripts/check-doc-lang.mjs apps/orca-team-dispatch-task`（リポジトリルートで）
Expected: `check-doc-lang: OK`

- [ ] **Step 11: Commit**

```bash
git add apps/orca-team-dispatch-task
git commit -m "$(cat <<'EOF'
docs(orca-dispatch): SKILL を N タスク並列のライフサイクルへ書き換える

Step 1 に件数上限、Step 2 に --run 相乗り、Step 3 に集約待機と「保持は意図的」の
説明、Step 5 に release state の 4 分類、Step 6 にタスクごとの質問の割り方を書いた。
--terminal 再利用の副作用として端末が残るという旧説明と、runner 固定の制限行を
実態に合わせて差し替えた。

Claude-Session: https://claude.ai/code/session_01Hjrrf6y5oDbwAgAHmHHgp3
EOF
)"
```

---

### Task 9: `test-e2e.sh` に 2 タスク並列のシナリオを足す

**Files:**
- Modify: `apps/orca-team-dispatch-task/test/test-e2e.sh`

**Interfaces:**
- Consumes: Task 3〜6 で確定した `orca-start.sh` / `orca-wait.sh` のインターフェース

- [ ] **Step 1: 失敗するテストを書く**

`test/test-e2e.sh` の末尾、`git -C "$R" worktree remove` の直前に足す。既存の ID は E1〜E11 まで使われているので **E12 / E13** を使う。スタブは 1 サブコマンドにつき 1 応答しか返さないので、**2 本目を起動する前に fixture を差し替える**。

```bash
# --- 2 タスクを 1 つの Run で並列に流す ---
WT2=$(mktemp -d)/wt2; git -C "$R" worktree add -q -b orca/e2e-b "$WT2" >/dev/null 2>&1
REQ2=$(mktemp); printf 'second task\n' > "$REQ2"
: > "$ORCA_STUB_DIR/calls.log"

# 1 本目（Run を作る）
echo '{"ok":true,"result":{"task":{"id":"task_a"}}}' > "$ORCA_STUB_DIR/orchestration_task-create"
echo '{"ok":true,"result":{"state":"ready","dispatchId":"ctx_a","worker":{"agent_terminal_handle":"term_a"}}}' \
  > "$ORCA_STUB_DIR/orchestration_worker-start"
printf '{"ok":true,"result":{"worktree":{"id":"wt_a","path":"%s","branch":"refs/heads/orca/e2e"}}}\n' \
  "$WT" > "$ORCA_STUB_DIR/worktree_create"
OUTA=$(bash "$P/bin/orca-start.sh" --request-file "$REQ" --slug pa --objective o --repo-root "$R" 2>&1)
SDA=$(sed -n 's/^status_dir=//p' <<<"$OUTA"); RUNID=$(sed -n 's/^run_id=//p' <<<"$OUTA")

# 2 本目（同じ Run に相乗り）
echo '{"ok":true,"result":{"task":{"id":"task_b"}}}' > "$ORCA_STUB_DIR/orchestration_task-create"
echo '{"ok":true,"result":{"state":"ready","dispatchId":"ctx_b","worker":{"agent_terminal_handle":"term_b"}}}' \
  > "$ORCA_STUB_DIR/orchestration_worker-start"
printf '{"ok":true,"result":{"worktree":{"id":"wt_b","path":"%s","branch":"refs/heads/orca/e2e-b"}}}\n' \
  "$WT2" > "$ORCA_STUB_DIR/worktree_create"
OUTB=$(bash "$P/bin/orca-start.sh" --request-file "$REQ2" --slug pb --objective o --repo-root "$R" \
         --run "$RUNID" 2>&1)
SDB=$(sed -n 's/^status_dir=//p' <<<"$OUTB")

[[ -n "$SDA" && -n "$SDB" && "$(grep -c 'run-create' "$ORCA_STUB_DIR/calls.log")" -eq 1 ]] \
  && ok "E12 2 タスクが 1 つの Run に載る" || fail "E12 (a=$SDA b=$SDB)"

# 1 batch に 2 件の worker_done が同居する
echo '{"status":"done"}' > "$SDA/roles/design/status.json"
echo '{"status":"done"}' > "$SDB/roles/design/status.json"
jq -nc '{ok:true,result:{runId:"run_e",deliveryId:"de",count:2,messages:[
  {id:"e1",type:"worker_done",payload:({taskId:"task_a",dispatchId:"ctx_a",outcome:"succeeded"}|tojson),body:""},
  {id:"e2",type:"worker_done",payload:({taskId:"task_b",dispatchId:"ctx_b",outcome:"succeeded"}|tojson),body:""}]}}' \
  > "$ORCA_STUB_DIR/orchestration_check"
: > "$ORCA_STUB_DIR/calls.log"
bash "$P/bin/orca-wait.sh" --status-dir "$SDA" --status-dir "$SDB" --max-waits 1 --timeout-ms 1 >/dev/null 2>&1
rc=$?
[[ "$rc" -eq 0 \
   && "$(jq -c . "$SDA/received.json")" == '["worker_done|task_a|ctx_a|succeeded"]' \
   && "$(jq -c . "$SDB/received.json")" == '["worker_done|task_b|ctx_b|succeeded"]' \
   && "$(grep -c 'worker-retain' "$ORCA_STUB_DIR/calls.log")" -eq 2 \
   && "$(grep -c -- '--ack' "$ORCA_STUB_DIR/calls.log")" -eq 1 ]] \
  && ok "E13 1 batch で 2 件を振り分け、retain 2 回・ack 1 回" || fail "E13 (rc=$rc)"

git -C "$R" worktree remove --force "$WT2" >/dev/null 2>&1
rm -rf "$REQ2" "$(dirname "$WT2")"
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `cd apps/orca-team-dispatch-task && bash test/test-e2e.sh`
Expected: Task 4 と Task 6 が未実装なら `FAIL: E12` / `FAIL: E13`。実装済みなら**最初から緑になる**ので、その場合は「本体は正しいがカバーされていなかった」ことの確認として扱い、Step 3 を飛ばす

- [ ] **Step 3: 落ちた場合だけ原因を直す**

このテストは本体の新機能を追加しない。落ちたなら Task 4 / Task 6 の実装漏れなので、そちらへ戻る。

- [ ] **Step 4: テストが緑になることを確認する**

Run: `cd apps/orca-team-dispatch-task && bash test/run-all.sh`
Expected: `ALL GREEN`

- [ ] **Step 5: Commit**

```bash
git add apps/orca-team-dispatch-task
git commit -m "$(cat <<'EOF'
test(orca-dispatch): 2 タスク並列の E2E を足す

1 つの Run に 2 タスクを載せ、1 batch で両方の worker_done を受けて
それぞれの received.json に振り分けるところまでを stub 上で通す。

Claude-Session: https://claude.ai/code/session_01Hjrrf6y5oDbwAgAHmHHgp3
EOF
)"
```

---

### Task 10: バージョンを 2.0.0 にし、`README.md` と `CLAUDE.md` を更新する

端末の扱いが変わる（`worker-release` が実際に端末を閉じるようになる）ので互換性のある変更ではない。

**Files:**
- Modify: `apps/orca-team-dispatch-task/.claude-plugin/plugin.json`
- Modify: `apps/orca-team-dispatch-task/.codex-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`
- Modify: `apps/orca-team-dispatch-task/README.md`
- Modify: `apps/orca-team-dispatch-task/CLAUDE.md`

- [ ] **Step 1: 3 箇所のバージョンを 2.0.0 にする**

```bash
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins
grep -n '"version"' apps/orca-team-dispatch-task/.claude-plugin/plugin.json \
  apps/orca-team-dispatch-task/.codex-plugin/plugin.json
grep -n 'orca-team-dispatch-task' -A3 .claude-plugin/marketplace.json | grep version
```

3 箇所を `2.0.0` に書き換える。

- [ ] **Step 2: `CLAUDE.md` の「範囲」を書き換える**

```markdown
## 範囲

Stage A は **1 タスク = 1 役（design）**。レビュー無し・PR 無し・ループ無し・設定無し。
**N タスクを 1 つの Run で並列に dispatch できる**（既定上限 4）。worker のセッションは
`worker-retain` で最後まで保持し、解放は Step 6 の承認後だけ。片付けが勝手に走ることは
ない — Step 5 が削除してよいものを判定し、Step 6 が尋ねて、承認されたものだけを実行する。
recovery 機構は意図的に持たない（設計 spec 18-1 の裁定）。テストは `bash test/run-all.sh`。
```

「構成」節から `run-design.sh` の記述を消す。

- [ ] **Step 3: `README.md` を更新する**

並列 dispatch ができること、片付けは確認してから行われることを書く。**`worker-release` / `worktree rm` / `terminal close` / `task-list --run` の語は使わない**（SK9）。

- [ ] **Step 4: すべての検査を通す**

Run: `cd apps/orca-team-dispatch-task && bash test/run-all.sh`
Expected: `ALL GREEN`

Run: `pnpm check && node scripts/check-doc-lang.mjs apps/orca-team-dispatch-task`（リポジトリルートで）
Expected: 両方成功

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
chore(orca-dispatch): 2.0.0 へ上げ、README と開発ガイドを更新する

端末生成を Orca に移したことで worker-release が実際に端末を閉じるように
なるため、互換性のある変更ではない。並列 dispatch と保持の方針を
README / CLAUDE.md に反映した。

Claude-Session: https://claude.ai/code/session_01Hjrrf6y5oDbwAgAHmHHgp3
EOF
)"
```

---

## 実装後に残ること

- **Stage B**（レビュー協調）と **Stage C**（役ごとの agent / model / effort）は別の spec と計画にする
- spec 11 節の U3 / U4 / U5 は Stage B / C で解く
- `test-docs.sh` の既存の制限表の行「Failure and edge receipt fixtures are partly simulated」が指す Stage 2 の実測は、この計画では扱わない
