# Completion Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 子セッションが作業の途中で停止したとき、Stop hook が決定論的に判定して自動で継続させる。

**Architecture:** `/goal` が内部で使っている Stop hook を、モデル評価ではなくディスクだけを読む
スクリプトで行う。`completion-gate.sh` が `status.json` / `.deferred` / `.assigned-<agent>` /
`review/*round*.md` を見て「完了」「待って良い」「途中で止まろうとしている」を判定し、最後の
場合だけ `{"decision":"block","reason":"..."}` を返す。両 engine の project-local hook 設定
(`.claude/settings.local.json` / `.codex/hooks.json`) へ同じ形で注入する。

**Tech Stack:** bash 3.2 (macOS), jq, cmux, agmsg

**Spec:** `docs/superpowers/specs/2026-08-22-dispatch-completion-gate-design.md`

## Global Constraints

- 判定は**ディスクのみ**。モデル評価・ネットワーク・cmux コマンドを使わない（spec §5-2）
- block 時の JSON のキーは **`decision` と `reason` だけ**。codex の hook 出力スキーマは
  `additionalProperties: false` で、Stop の許可キーは `continue` / `decision`（`"block"` のみ）/
  `reason` / `stopReason` / `suppressOutput` / `systemMessage` の 6 つ（spec G8）
- 注入は**冪等**。同じ worktree を再利用しても二重に入らない（spec §5-4）
- 注入失敗は**警告のみで dispatch を止めない**。既存の `ExitPlanMode` hook と同じ契約（spec §5-5）
- 連続 block には**上限がある**。上限に達したら必ず block をやめる（spec §5-6）
- スクリプトは `set -uo pipefail`。`set -e` は使わない（判定の非ゼロ終了で死ぬため）
- コード内コメントとドキュメントは日本語、識別子と CLI フラグは英語（ルート `CLAUDE.md`）
- `SKILL.md` を更新したら同じ commit で `references/guide-ja.md` も更新する。
  検証は `node scripts/check-doc-lang.mjs`

---

### Task 1: G-T1 / G-T2 の実測（スパイク。以降の全タスクの前提）

spec §6 のとおり、この設計は「Stop hook が `{"decision":"block"}` を返すとセッションが次の
ターンを開始する」ことに全面的に依存している。**まだ測っていない。** D-T2（codex の自分宛
タイマーが不発だった件）と同じ轍を踏まないため、ここで測る。

成果物はコードではなく**答え**である。作った実験用ファイルは捨てる。

**Files:**
- Create: `docs/superpowers/specs/2026-08-22-dispatch-completion-gate-design.md` への追記のみ
- 実験用の一時ファイルはスクラッチディレクトリに置き、終わったら消す

- [ ] **Step 1: claude 用の実験 hook を書く**

スクラッチに実験用リポジトリを作る（`$SCRATCH` は各自のスクラッチディレクトリ）。

```bash
SCRATCH=$(mktemp -d)
mkdir -p "$SCRATCH/repo/.claude"
cd "$SCRATCH/repo" && git init -q && git commit -q --allow-empty -m init

cat > "$SCRATCH/gate-probe.sh" <<'EOF'
#!/usr/bin/env bash
# 実験用: 3 回まで block を返し、4 回目以降は何も返さない。
set -uo pipefail
COUNT_FILE="$SCRATCH_COUNT_FILE"
n=$(cat "$COUNT_FILE" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > "$COUNT_FILE"
if [[ "$n" -le 3 ]]; then
  jq -nc --arg r "probe turn $n: keep going" '{decision:"block",reason:$r}'
fi
EOF
chmod +x "$SCRATCH/gate-probe.sh"
```

- [ ] **Step 2: claude の settings.local.json へ Stop hook として登録する**

```bash
jq -n --arg cmd "SCRATCH_COUNT_FILE=$SCRATCH/count zsh '$SCRATCH/gate-probe.sh'" \
  '{hooks:{Stop:[{matcher:"",hooks:[{type:"command",command:$cmd}]}]}}' \
  > "$SCRATCH/repo/.claude/settings.local.json"
```

- [ ] **Step 3: claude セッションを起動して 1 ターンだけ与える**

```bash
cd "$SCRATCH/repo"
claude --dangerously-skip-permissions -p 'Say the word "one" and nothing else.' \
  --output-format stream-json --verbose 2>&1 | tee "$SCRATCH/claude.log"
cat "$SCRATCH/count"
```

**測ること (G-T1):**
- `$SCRATCH/count` が `4` になっているか（= block のたびに新しいターンが始まったか）。
  `1` のままなら **block はターンを起こさない** ので設計が成立しない
- ログに `reason` の文字列（`probe turn N: keep going`）が次ターンの入力として現れるか
- **組込みガードの有無**: 連続 block を 3 回続けても止められなかったか。途中で
  「stop hook が繰り返し block した」旨のメッセージが出るなら、それが `stop_hook_active` 相当の
  ガードである。出た回数を記録する（Task 3 の上限値と整合させるため）

- [ ] **Step 4: codex 用に同じ実験を行う**

```bash
rm -f "$SCRATCH/count"
mkdir -p "$SCRATCH/repo/.codex"
jq -n --arg cmd "SCRATCH_COUNT_FILE=$SCRATCH/count bash '$SCRATCH/gate-probe.sh'" \
  '{hooks:{Stop:[{matcher:"",hooks:[{type:"command",command:$cmd}]}]}}' \
  > "$SCRATCH/repo/.codex/hooks.json"

cd "$SCRATCH/repo"
codex --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust \
  exec 'Say the word "one" and nothing else.' 2>&1 | tee "$SCRATCH/codex.log"
cat "$SCRATCH/count"
```

**測ること (G-T2):**
- `$SCRATCH/count` が `4` になっているか
- `--dangerously-bypass-hook-trust` を付けた起動が**承認待ちで止まらない**か
- `invalid stop hook JSON output` が出ないか（= `decision` / `reason` だけの出力が
  codex のスキーマに適合するか。spec G8 の確認）

- [ ] **Step 5: 結果を spec へ記録する**

`docs/superpowers/specs/2026-08-22-dispatch-completion-gate-design.md` の §6 の表に
実測日と結果を追記する。成立した場合も**しなかった場合も**書く。

**判定:**
- **G-T1 と G-T2 が両方成立** → Task 2 へ進む
- **G-T1 のみ成立** → codex を対象外にする。Task 5 を「codex は非対応と明記する」へ差し替え、
  spec §4-1 の表から codex 行を落として理由を書く。Task 2-4 と 6 はそのまま進む
- **G-T1 が不成立** → **この計画を止める**。設計ごと作り直しになる。spec §8 の
  「`/goal` をペインへタイプ入力する」案の実測へ戻り、新しい spec を書く

- [ ] **Step 6: 実験用ファイルを消して commit**

```bash
rm -rf "$SCRATCH"
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins
git add docs/superpowers/specs/2026-08-22-dispatch-completion-gate-design.md
git commit -m "docs(spec): completion gate の G-T1 / G-T2 を実測して結果を記録する"
```

---

### Task 2: completion-gate.sh の判定ロジック

**Files:**
- Create: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/completion-gate.sh`
- Test: `apps/cmux-team-dispatch-task/test/test-completion-gate.sh`

**Interfaces:**
- Consumes: なし（Task 1 の実測結果が前提になるだけ）
- Produces: `completion-gate.sh --status-dir <dir> --role <design|design_review|exec|exec_review> --agent <agent-name>`
  - block したいとき: stdout へ `{"decision":"block","reason":"<text>"}`、exit 0
  - 停止を許すとき: stdout へ**何も出さず** exit 0
  - 引数不正: stderr へメッセージ、exit 2（**stdout には何も出さない**。壊れた JSON を
    hook へ返すと engine 側が毎ターン parse error を出すため）

**判定順序（この順で評価する。順序が不変条件そのもの）:**

| # | 条件 | 結果 |
|---|------|------|
| 1 | `status.json` の `.status` が `done` / `error` | 許す |
| 2 | role が `design` かつ `<dir>/.deferred` が存在 | 許す |
| 3 | role が `design` / `exec` で `<dir>/.assigned-<agent>` が無い | 許す（タスク未着） |
| 4 | role が `design_review` / `exec_review` で `<dir>/review/` に `*round*.md` が 1 つも無い | 許す（依頼未着） |
| 5 | role が `design` / `exec` で、最新の `review/*round*.md` に `VERDICT:` 行が無い | 許す（verdict 待ち） |
| 6 | role が `design_review` / `exec_review` で、最新の `review/*round*.md` に `VERDICT:` 行が無い | **block**（書き終えていない） |
| 7 | 上記以外 | **block**（作業の途中） |

**5 と 6 は同じディスク状態に対して逆の判定である。** 依頼側にとって「VERDICT がまだ無い」は
相手待ちで正しい状態、レビュアーにとっては自分がまだ書いていないという意味だからである。
ここを取り違えると、レビュアーが verdict を書かずに止まるか、実装者が待機中に叩き起こされる。

- [ ] **Step 1: 失敗するテストを書く**

`apps/cmux-team-dispatch-task/test/test-completion-gate.sh`:

```bash
#!/usr/bin/env bash
# completion-gate.sh の判定回帰。
#
# 守っている不変条件:
#   CG1. status が done / error なら許す
#   CG2. design は .deferred があれば許す
#   CG3. design / exec は .assigned-<agent> が無ければ許す (タスク未着)
#   CG4. review ロールは round ファイルが無ければ許す (依頼未着)
#   CG5. 依頼側は VERDICT 行が無ければ許す (verdict 待ち)
#   CG6. レビュアーは VERDICT 行が無ければ block する (まだ書いていない)
#   CG7. それ以外は block する
#   CG8. block の JSON は decision / reason 以外のキーを含まない (codex の
#        additionalProperties:false に適合させるため)
#   CG9. 引数不正は exit 2 で、stdout には何も出さない

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/completion-gate.sh"
[[ -f "$BIN" ]] || { echo "FAIL: スクリプトが見つからない: $BIN"; exit 2; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
fail=0
pass() { echo "PASS $1"; }
bad() { echo "FAIL $1"; fail=1; }

# $1=ケース名 → 空の status dir を作って echo
mkdir_case() { local d="$TMP/$1"; mkdir -p "$d/review"; echo "$d"; }
set_status() { jq -n --arg s "$2" '{status:$s}' > "$1/status.json"; }

# --- CG1: 終端 status は許す ---
for st in done error; do
  d=$(mkdir_case "cg1-$st"); set_status "$d" "$st"
  out=$(bash "$BIN" --status-dir "$d" --role exec --agent task-exec); rc=$?
  [[ $rc -eq 0 && -z "$out" ]] && pass "CG1($st): 終端 status で停止を許す" \
    || bad "CG1($st): rc=$rc out=[$out]"
done

# --- CG2: design の .deferred ---
d=$(mkdir_case cg2); set_status "$d" executing; : > "$d/.deferred"
out=$(bash "$BIN" --status-dir "$d" --role design --agent task); rc=$?
[[ $rc -eq 0 && -z "$out" ]] && pass 'CG2: design は .deferred で停止を許す' \
  || bad "CG2: rc=$rc out=[$out]"

# --- CG3: タスク未着 ---
d=$(mkdir_case cg3); set_status "$d" executing
out=$(bash "$BIN" --status-dir "$d" --role exec --agent task-exec); rc=$?
[[ $rc -eq 0 && -z "$out" ]] && pass 'CG3: .assigned が無ければ停止を許す' \
  || bad "CG3: rc=$rc out=[$out]"

# --- CG4: 依頼未着 (review ロール) ---
d=$(mkdir_case cg4); set_status "$d" executing
out=$(bash "$BIN" --status-dir "$d" --role exec_review --agent task-exec-review); rc=$?
[[ $rc -eq 0 && -z "$out" ]] && pass 'CG4: round ファイルが無ければ停止を許す' \
  || bad "CG4: rc=$rc out=[$out]"

# --- CG5: 依頼側の verdict 待ち ---
d=$(mkdir_case cg5); set_status "$d" executing; : > "$d/.assigned-task-exec"
printf 'findings\n' > "$d/review/code-round-1.md"
out=$(bash "$BIN" --status-dir "$d" --role exec --agent task-exec); rc=$?
[[ $rc -eq 0 && -z "$out" ]] && pass 'CG5: 依頼側は VERDICT 未着で停止を許す' \
  || bad "CG5: rc=$rc out=[$out]"

# --- CG6: レビュアーは同じ状態で block ---
d=$(mkdir_case cg6); set_status "$d" executing
printf 'findings\n' > "$d/review/code-round-1.md"
out=$(bash "$BIN" --status-dir "$d" --role exec_review --agent task-exec-review); rc=$?
if [[ $rc -eq 0 ]] && jq -e '.decision == "block"' >/dev/null 2>&1 <<< "$out"; then
  pass 'CG6: レビュアーは VERDICT 未記入で block する'
else
  bad "CG6: rc=$rc out=[$out]"
fi

# --- CG7: 作業途中は block ---
d=$(mkdir_case cg7); set_status "$d" executing; : > "$d/.assigned-task-exec"
out=$(bash "$BIN" --status-dir "$d" --role exec --agent task-exec); rc=$?
if [[ $rc -eq 0 ]] && jq -e '.decision == "block" and (.reason | length > 0)' \
   >/dev/null 2>&1 <<< "$out"; then
  pass 'CG7: 作業途中は block し reason を付ける'
else
  bad "CG7: rc=$rc out=[$out]"
fi

# --- CG8: 出力キーは decision / reason だけ ---
if jq -e '(keys | sort) == ["decision","reason"]' >/dev/null 2>&1 <<< "$out"; then
  pass 'CG8: 出力キーは decision / reason だけ'
else
  bad "CG8: codex が拒否するキーが混じっている: [$out]"
fi

# --- CG9: 引数不正は exit 2 で stdout 無出力 ---
for args in "" "--status-dir $TMP" "--role exec --agent a" "--status-dir $TMP --role bogus --agent a"; do
  out=$(bash "$BIN" $args 2>/dev/null); rc=$?
  [[ $rc -eq 2 && -z "$out" ]] && pass "CG9([$args]): exit 2 で stdout 無出力" \
    || bad "CG9([$args]): rc=$rc out=[$out]"
done

[[ $fail -eq 0 ]] && echo '--- all passed ---' || echo '--- failures ---'
exit $fail
```

- [ ] **Step 2: テストを走らせて落ちることを確認する**

```bash
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins/apps/cmux-team-dispatch-task
bash test/test-completion-gate.sh
```

Expected: `FAIL: スクリプトが見つからない` で exit 2

- [ ] **Step 3: completion-gate.sh を実装する**

```bash
#!/usr/bin/env bash
# completion-gate.sh — Stop hook から呼ばれ、子セッションが仕事の途中で止まろうとして
# いるかを判定する。止まろうとしているなら block して継続させる。
#
# 判定は **ディスクだけ** を読む。モデル評価もネットワークも cmux も使わない。dispatch の
# 完了条件は既に status.json / .deferred / review ファイルとして materialize されており、
# 「待って良い状態」もそこから確定できるので、会話からの推測に賭ける理由が無い。
#
# 出力キーを decision / reason に限るのは codex の hook 出力スキーマが
# additionalProperties: false で、Stop の許可キーが continue / decision / reason /
# stopReason / suppressOutput / systemMessage の 6 つしか無いためである。未知キーを 1 つ
# 出すと毎ターン parse error になる (security-guidance が metrics を出して拒否されている
# のと同じ失敗)。
#
# Usage:
#   completion-gate.sh --status-dir <dir> --role <design|design_review|exec|exec_review> --agent <name>
#
# Output: block したいときだけ {"decision":"block","reason":"..."} を stdout へ
# Exit:   0 = 判定完了 (block の有無は stdout で表す) / 2 = 使用法エラー
set -uo pipefail

die() { echo "completion-gate: $1" >&2; exit 2; }

STATUS_DIR=""; ROLE=""; AGENT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --status-dir) [[ $# -ge 2 ]] || die "--status-dir requires a value"; STATUS_DIR="$2"; shift 2 ;;
    --role)       [[ $# -ge 2 ]] || die "--role requires a value";       ROLE="$2";       shift 2 ;;
    --agent)      [[ $# -ge 2 ]] || die "--agent requires a value";      AGENT="$2";      shift 2 ;;
    *)            die "unknown argument: $1" ;;
  esac
done
[[ -n "$STATUS_DIR" ]] || die "--status-dir is required"
[[ -n "$AGENT" ]] || die "--agent is required"
case "$ROLE" in
  design|design_review|exec|exec_review) ;;
  *) die "--role must be design, design_review, exec or exec_review" ;;
esac

# 停止を許す。stdout へ何も出さない。
allow() { exit 0; }

# 継続させる。reason は次ターンのガイダンスとして使われるので、何をすべきかを書く。
block() {
  jq -nc --arg r "$1" '{decision:"block",reason:$r}'
  exit 0
}

# 1. 仕事が終わっている
if [[ -f "$STATUS_DIR/status.json" ]]; then
  st=$(jq -r '.status // empty' "$STATUS_DIR/status.json" 2>/dev/null || echo "")
  case "$st" in done|error) allow ;; esac
fi

# 2. design は Phase B を委譲した時点で終わり
if [[ "$ROLE" == design && -f "$STATUS_DIR/.deferred" ]]; then
  allow
fi

# 最新の review ラウンドファイル。名前は design-round-N.md / code-round-N.md など複数あるので
# glob で拾い、更新時刻ではなく名前順の最後を取る (N が増える命名なので順序が意味を持つ)。
latest_round() {
  local f last=""
  shopt -s nullglob
  for f in "$STATUS_DIR"/review/*round*.md; do last="$f"; done
  [[ -n "$last" ]] && printf '%s' "$last"
}
ROUND_FILE=$(latest_round)

case "$ROLE" in
  design|exec)
    # 3. タスク未着。待つのが正しい状態。
    [[ -f "$STATUS_DIR/.assigned-$AGENT" ]] || allow
    # 5. verdict 待ち。相手が書くまで待つのが正しい状態。
    if [[ -n "$ROUND_FILE" ]] && ! grep -q '^VERDICT:' "$ROUND_FILE" 2>/dev/null; then
      allow
    fi
    ;;
  design_review|exec_review)
    # 4. 依頼未着。レビューペインは .assigned を使わないので round ファイルの有無で判定する
    #    (launch-workspace.sh の所有権判定が .assigned-* を見ており、レビュアーがそれを作ると
    #     foreign assignment と誤認されて status 書き込みが抑止される)。
    [[ -n "$ROUND_FILE" ]] || allow
    # 6. VERDICT を書き終えていない = 自分の仕事が途中。依頼側とは逆の判定になる。
    if ! grep -q '^VERDICT:' "$ROUND_FILE" 2>/dev/null; then
      block "review round file $ROUND_FILE has no VERDICT line yet. Finish the review, write VERDICT: approve or VERDICT: needs_work as its last line, then send the review-verdict: message."
    fi
    allow
    ;;
esac

# 7. 作業の途中で止まろうとしている
block "the task is not finished: status.json has no terminal status yet. Continue the work, then write status.json and send the dispatch-notify: message."
```

- [ ] **Step 4: テストが通ることを確認する**

```bash
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins/apps/cmux-team-dispatch-task
chmod +x skills/cmux-team-dispatch-task/scripts/completion-gate.sh
bash test/test-completion-gate.sh
```

Expected: `--- all passed ---`

- [ ] **Step 5: commit**

```bash
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/completion-gate.sh \
        apps/cmux-team-dispatch-task/test/test-completion-gate.sh
git commit -m "feat(dispatch): 完走判定 completion-gate.sh を追加する"
```

---

### Task 3: 連続 block の上限

Stop hook が永久に block すると無限ループになる。上限は任意のオプションではなく機能の一部である。

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/completion-gate.sh`
- Modify: `apps/cmux-team-dispatch-task/test/test-completion-gate.sh`

**Interfaces:**
- Consumes: Task 2 の `allow()` / `block()`
- Produces: `<status-dir>/.gate-blocks` に連続 block 回数を書く。上限は環境変数
  `DISPATCH_GATE_MAX_BLOCKS`（既定 10）で上書きできる（テストが短い値を使うため）

**カウンタの規則:**
- `block()` するたびに +1 する
- `allow()` するときは **0 にリセットする**。待機から復帰したあとに前の回数を持ち越さない
- 上限に達したら block せず許す。その旨を stderr に出す（stdout は engine が読むので使わない）

Task 1 で組込みガード（`stop_hook_active` 相当）が観測された場合は、その回数と本上限の
小さい方が実効値になる。spec §4-3 の注記を実測値へ更新すること。

- [ ] **Step 1: 失敗するテストを追加する**

`test/test-completion-gate.sh` の `[[ $fail -eq 0 ]]` の直前へ追記:

```bash
# --- CG10: 連続 block はカウントされ、上限で止まる ---
d=$(mkdir_case cg10); set_status "$d" executing; : > "$d/.assigned-task-exec"
blocked=0
for i in 1 2 3 4 5; do
  out=$(DISPATCH_GATE_MAX_BLOCKS=3 bash "$BIN" --status-dir "$d" --role exec --agent task-exec 2>/dev/null)
  [[ -n "$out" ]] && blocked=$((blocked + 1))
done
[[ "$blocked" == 3 ]] && pass 'CG10: 上限 3 で block が止まる' \
  || bad "CG10: block した回数が $blocked (期待 3)"

# --- CG11: allow でカウンタがリセットされる ---
d=$(mkdir_case cg11); set_status "$d" executing; : > "$d/.assigned-task-exec"
DISPATCH_GATE_MAX_BLOCKS=3 bash "$BIN" --status-dir "$d" --role exec --agent task-exec >/dev/null 2>&1
DISPATCH_GATE_MAX_BLOCKS=3 bash "$BIN" --status-dir "$d" --role exec --agent task-exec >/dev/null 2>&1
# verdict 待ちにして allow させる
printf 'findings\n' > "$d/review/code-round-1.md"
DISPATCH_GATE_MAX_BLOCKS=3 bash "$BIN" --status-dir "$d" --role exec --agent task-exec >/dev/null 2>&1
# verdict が来た状態に戻すと、また 3 回 block できるはず
printf 'findings\nVERDICT: approve\n' > "$d/review/code-round-1.md"
blocked=0
for i in 1 2 3 4; do
  out=$(DISPATCH_GATE_MAX_BLOCKS=3 bash "$BIN" --status-dir "$d" --role exec --agent task-exec 2>/dev/null)
  [[ -n "$out" ]] && blocked=$((blocked + 1))
done
[[ "$blocked" == 3 ]] && pass 'CG11: allow でカウンタがリセットされる' \
  || bad "CG11: リセット後の block が $blocked 回 (期待 3)"
```

- [ ] **Step 2: テストを走らせて CG10 / CG11 が落ちることを確認する**

```bash
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins/apps/cmux-team-dispatch-task
bash test/test-completion-gate.sh
```

Expected: `FAIL CG10` と `FAIL CG11`（上限が無いので 5 回とも block する）

- [ ] **Step 3: 上限を実装する**

`completion-gate.sh` の `allow()` / `block()` を置き換える:

```bash
MAX_BLOCKS="${DISPATCH_GATE_MAX_BLOCKS:-10}"
[[ "$MAX_BLOCKS" =~ ^[0-9]+$ ]] || die "DISPATCH_GATE_MAX_BLOCKS must be a whole number"
BLOCK_COUNT_FILE="$STATUS_DIR/.gate-blocks"

# 停止を許す。待機から復帰したあとに前の回数を持ち越さないよう、必ずカウンタを消す。
allow() { rm -f "$BLOCK_COUNT_FILE" 2>/dev/null || true; exit 0; }

# 継続させる。ただし上限に達したら諦めて停止を許す — Stop hook が永久に block すると
# 無限ループになるので、この上限は機能の一部であって任意のオプションではない。
block() {
  local n
  n=$(cat "$BLOCK_COUNT_FILE" 2>/dev/null || echo 0)
  [[ "$n" =~ ^[0-9]+$ ]] || n=0
  if [[ "$n" -ge "$MAX_BLOCKS" ]]; then
    echo "completion-gate: gave up after $n consecutive blocks; letting the session stop" >&2
    allow
  fi
  echo "$((n + 1))" > "$BLOCK_COUNT_FILE" 2>/dev/null || true
  jq -nc --arg r "$1" '{decision:"block",reason:$r}'
  exit 0
}
```

- [ ] **Step 4: テストが通ることを確認する**

```bash
bash test/test-completion-gate.sh
```

Expected: `--- all passed ---`

- [ ] **Step 5: commit**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/completion-gate.sh \
        apps/cmux-team-dispatch-task/test/test-completion-gate.sh
git commit -m "feat(dispatch): completion gate に連続 block の上限を入れる"
```

---

### Task 4: claude ペインへの注入

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh`
  （`ensure_claude_exclusions` は 160-174 行、`ExitPlanMode` 注入は 780 行以降。その直後に足す）
- Test: `apps/cmux-team-dispatch-task/test/test-completion-gate-injection.sh`

**Interfaces:**
- Consumes: Task 2/3 の `completion-gate.sh`、既存の `merge_claude_settings`
- Produces: `.claude/settings.local.json` の `.hooks.Stop` に
  `{matcher:"",hooks:[{type:"command",command:"zsh '<skill>/scripts/completion-gate.sh' --status-dir '<dir>' --role '<role>' --agent '<agent>'"}]}` が入る

**条件:** `RUNNER_ENGINE == claude` かつ `--status-dir` が渡されているとき。冪等性は既存の
`ExitPlanMode` 注入と同じく、ファイルに `completion-gate.sh` が既にあるかを `grep` で見る。

- [ ] **Step 1: 失敗するテストを書く**

```bash
#!/usr/bin/env bash
# completion gate の hook 注入。
#
# launch-workspace.sh は source すると最後まで実行されて die するので、既存の
# test-launch-workspace-*.sh と同じく **実プロセスとして起動して** 生成物を検査する。
#
#   CI1. claude engine では .claude/settings.local.json の Stop に 1 本入る
#   CI2. 同じ worktree で 2 回起動しても二重に入らない
#   CI3. 既存の hook (ExitPlanMode) を壊さない
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCH="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/launch-workspace.sh"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
fail=0
pass() { echo "PASS $1"; }
bad() { echo "FAIL $1"; fail=1; }

mkdir -p "$TMP/bin" "$TMP/repo/.claude" "$TMP/repo/.codex" "$TMP/status"
git -C "$TMP/repo" init -q
git -C "$TMP/repo" config user.email test@example.invalid
git -C "$TMP/repo" config user.name test
touch "$TMP/repo/.gitkeep"
git -C "$TMP/repo" add .gitkeep
git -C "$TMP/repo" commit -qm init
printf 'plan\n' > "$TMP/plan.md"

cat > "$TMP/bin/cmux" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  list-workspaces) ;;
  new-workspace) echo "workspace:1" ;;
  list-pane-surfaces) echo 'surface:2' ;;
  rename-workspace|rename-tab|notify|send|send-key|wait-for|identify) ;;
  *) echo "unexpected cmux command: $*" >&2; exit 1 ;;
esac
STUB
chmod +x "$TMP/bin/cmux"
printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/bin/agmsg-send.sh"
chmod +x "$TMP/bin/agmsg-send.sh"

cat > "$TMP/runners.json" <<'JSON'
{"default":"claude","runners":[
  {"name":"claude","command":"claude","engine":"claude"},
  {"name":"codex","command":"codex","engine":"codex"}]}
JSON

# 既存 hook を先に置いて CI3 を検査できるようにする
cat > "$TMP/repo/.claude/settings.local.json" <<'EOF'
{"hooks":{"PostToolUse":[{"matcher":"ExitPlanMode","hooks":[{"type":"command","command":"zsh /x/plan-approved-hook.sh"}]}]}}
EOF

run_launch() { # $1=runner, $2=workspace name
  CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" \
  AGMSG_SEND="$TMP/bin/agmsg-send.sh" bash "$LAUNCH" \
    --cwd "$TMP/repo" --mode execute --runner "$1" --role exec \
    --plan-file "$TMP/plan.md" --agmsg-team demo-team --agmsg-from task-exec \
    --status-dir "$TMP/status" --no-parallel "$2" >/dev/null 2>&1
}

gate_count() { # $1=検査するファイル
  jq '[.hooks.Stop[]?.hooks[]? | select(.command | test("completion-gate.sh"))] | length' \
    "$1" 2>/dev/null || echo 0
}

run_launch claude ci-1
n=$(gate_count "$TMP/repo/.claude/settings.local.json")
[[ "$n" == 1 ]] && pass 'CI1 Stop hook が 1 本入る' || bad "CI1 入っていない (n=$n)"

run_launch claude ci-2
n=$(gate_count "$TMP/repo/.claude/settings.local.json")
[[ "$n" == 1 ]] && pass 'CI2 二重に入らない' || bad "CI2 重複した (n=$n)"

jq -e '.hooks.PostToolUse[0].matcher == "ExitPlanMode"' \
  "$TMP/repo/.claude/settings.local.json" >/dev/null 2>&1 \
  && pass 'CI3 既存の hook が残っている' || bad 'CI3 既存の hook を壊した'

# 注入された command が正しい引数を持つこと (role / agent / status-dir)
cmd=$(jq -r '[.hooks.Stop[]?.hooks[]? | select(.command | test("completion-gate.sh"))][0].command' \
  "$TMP/repo/.claude/settings.local.json" 2>/dev/null || echo "")
if [[ "$cmd" == *"--role 'exec'"* && "$cmd" == *"--agent 'task-exec'"* \
   && "$cmd" == *"--status-dir '$TMP/status'"* ]]; then
  pass 'CI1b 注入された command が role / agent / status-dir を持つ'
else
  bad "CI1b command の引数が違う: [$cmd]"
fi

[[ $fail -eq 0 ]] && echo '--- all passed ---' || echo '--- failures ---'
exit $fail
```

- [ ] **Step 2: テストを走らせて落ちることを確認する**

```bash
bash test/test-completion-gate-injection.sh
```

Expected: `FAIL CI1 入っていない (n=0)`（まだ注入していないため）

- [ ] **Step 3: launch-workspace.sh に注入関数を足す**

`ensure_claude_exclusions()` の直後（174 行のあと）へ:

```bash
# 完走ゲート: 子セッションが仕事の途中で止まったら Stop hook が継続させる。
# 注入先は engine ごとに違うが、判定スクリプトと出力契約は共通である。
# ExitPlanMode hook と同じくベストエフォート — 失敗は警告のみで dispatch を止めない。
inject_completion_gate() {
  local script="$SCRIPT_DIR/completion-gate.sh"
  local settings_file="$CWD/.claude/settings.local.json"
  local cmd

  [[ -n "$STATUS_DIR" ]] || return 0
  if [[ -f "$settings_file" ]] && grep -q 'completion-gate.sh' "$settings_file" 2>/dev/null; then
    log "hook" "completion gate already present in $settings_file"
    return 0
  fi
  # パスと値をクォートして焼き込む (スキルの配置先やタスク slug に空白が入っても壊れない)
  cmd="zsh '$script' --status-dir '$STATUS_DIR' --role '${MODEL_ROLE}' --agent '${AGMSG_FROM}'"
  merge_claude_settings \
    '.hooks.Stop = ((.hooks.Stop // []) + [{matcher: "", hooks: [{type: "command", command: $cmd}]}])' \
    --arg cmd "$cmd" \
    || log "warn" "failed to inject the completion gate into $settings_file"
}
```

`log` は launch-workspace.sh 既存の関数。`MODEL_ROLE` は `--role` が入る既存の変数（`launch-workspace.sh:260`）、
`AGMSG_FROM` は `--agmsg-from` が入る既存の変数（同 328 行）。新しい変数を作らないこと。

- [ ] **Step 4: 呼び出しを足す**

`ExitPlanMode` 注入ブロック（786 行から始まる `if`）の直後へ:

```bash
# 完走ゲートは plan モードに限らない。claude engine で status-dir がある全ロールに入れる。
if [[ "$RUNNER_ENGINE" == "claude" ]]; then
  inject_completion_gate || true
fi
```

- [ ] **Step 5: テストが通ることを確認する**

```bash
bash test/test-completion-gate-injection.sh
```

Expected: `--- all passed ---`

- [ ] **Step 6: 既存のテストが壊れていないことを確認する**

```bash
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins/apps/cmux-team-dispatch-task
for t in test/test-launch-workspace-*.sh test/test-prewarm-layout.sh; do
  printf '%s ' "$(basename "$t")"; bash "$t" >/dev/null 2>&1 && echo OK || echo FAIL
done
```

Expected: 全部 OK

- [ ] **Step 7: commit**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh \
        apps/cmux-team-dispatch-task/test/test-completion-gate-injection.sh
git commit -m "feat(dispatch): claude ペインへ completion gate の Stop hook を注入する"
```

---

### Task 5: codex ペインへの注入と誤コミット防止

**Task 1 の G-T2 が不成立だった場合、このタスクは実装しない。** 代わりに spec §4-1 の表から
codex 行を落とし、`SKILL.md` / `guide-ja.md` / `README.md` に「codex ロールは対象外」と
その理由を書く（Task 6 に含める）。

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh`
- Modify: `apps/cmux-team-dispatch-task/test/test-completion-gate-injection.sh`

**Interfaces:**
- Consumes: Task 4 の `inject_completion_gate`
- Produces: `.codex/hooks.json` の `.hooks.Stop` に同じ形の entry。`info/exclude` に
  `.codex/hooks.json` が入る

**注意:** `.codex/hooks.json` には agmsg が SessionStart / SessionEnd を書いている。
**上書きしてはならない。** jq でマージする。

- [ ] **Step 1: 失敗するテストを追加する**

`test/test-completion-gate-injection.sh` の `[[ $fail -eq 0 ]]` の直前へ:

```bash
# --- CI4/CI5/CI6/CI7: codex 側 ---
# claude 側と同じく実プロセスで起動する。.codex/hooks.json には agmsg が
# SessionStart を書いているので、それを壊さないことまで見る。
cat > "$TMP/repo/.codex/hooks.json" <<'EOF'
{"hooks":{"SessionStart":[{"matcher":"","hooks":[{"type":"command","command":"'/x/session-start.sh' 'codex' '/x'"}]}]}}
EOF

run_launch codex ci-4
n=$(gate_count "$TMP/repo/.codex/hooks.json")
[[ "$n" == 1 ]] && pass 'CI4 codex に Stop hook が 1 本入る' || bad "CI4 入っていない (n=$n)"

run_launch codex ci-5
n=$(gate_count "$TMP/repo/.codex/hooks.json")
[[ "$n" == 1 ]] && pass 'CI5 codex でも二重に入らない' || bad "CI5 重複した (n=$n)"

jq -e '.hooks.SessionStart[0].hooks[0].command | test("session-start.sh")' \
  "$TMP/repo/.codex/hooks.json" >/dev/null 2>&1 \
  && pass 'CI6 agmsg の SessionStart を壊さない' || bad 'CI6 agmsg の hook を壊した'

# CI7: .codex/hooks.json が info/exclude に入る (誤コミット防止)
exclude=$(git -C "$TMP/repo" rev-parse --path-format=absolute --git-path info/exclude 2>/dev/null)
grep -qxF '.codex/hooks.json' "$exclude" 2>/dev/null \
  && pass 'CI7 .codex/hooks.json が info/exclude に入る' \
  || bad 'CI7 info/exclude に入っていない'
```

- [ ] **Step 2: テストを走らせて落ちることを確認する**

```bash
bash test/test-completion-gate-injection.sh
```

Expected: CI4 が FAIL（`inject_completion_gate_codex` が無い）

- [ ] **Step 3: codex 用の注入関数を足す**

`inject_completion_gate` の直後へ:

```bash
# codex 版。注入先が .codex/hooks.json である以外は claude 版と同じ契約である。
# このファイルには agmsg が SessionStart / SessionEnd を書いているので必ずマージする。
# worktree ごとに新しいパスになるため codex は毎回「未信頼」と判定するが、
# launch-workspace は全 codex 経路に --dangerously-bypass-hook-trust を付けているので
# 承認待ちにはならない (CODEX_HOOK_TRUST_FLAG)。
inject_completion_gate_codex() {
  local script="$SCRIPT_DIR/completion-gate.sh"
  local hooks_dir="$CWD/.codex"
  local hooks_file="$hooks_dir/hooks.json"
  local cmd merged tmp

  [[ -n "$STATUS_DIR" ]] || return 0
  if [[ -f "$hooks_file" ]] && grep -q 'completion-gate.sh' "$hooks_file" 2>/dev/null; then
    log "hook" "completion gate already present in $hooks_file"
    return 0
  fi
  if ! mkdir -p "$hooks_dir" 2>/dev/null; then
    log "warn" "failed to create $hooks_dir; skipping the codex completion gate"
    return 1
  fi
  cmd="bash '$script' --status-dir '$STATUS_DIR' --role '${MODEL_ROLE}' --agent '${AGMSG_FROM}'"
  if [[ -f "$hooks_file" ]]; then
    merged=$(jq --arg cmd "$cmd" \
      '.hooks.Stop = ((.hooks.Stop // []) + [{matcher: "", hooks: [{type: "command", command: $cmd}]}])' \
      "$hooks_file" 2>/dev/null) || merged=""
  else
    merged=$(jq -n --arg cmd "$cmd" \
      '{hooks:{Stop:[{matcher:"",hooks:[{type:"command",command:$cmd}]}]}}' 2>/dev/null) || merged=""
  fi
  if [[ -z "$merged" ]]; then
    log "warn" "failed to merge the completion gate into $hooks_file; skipping"
    return 1
  fi
  tmp=$(mktemp "$hooks_dir/.hooks.json.XXXXXX" 2>/dev/null) || {
    log "warn" "failed to create a temp file in $hooks_dir; skipping"
    return 1
  }
  printf '%s\n' "$merged" > "$tmp" && mv "$tmp" "$hooks_file" \
    || { rm -f "$tmp"; log "warn" "failed to write $hooks_file"; return 1; }
  return 0
}
```

- [ ] **Step 4: 呼び出しと除外設定を足す**

Task 4 で足した呼び出しブロックを次に置き換える:

```bash
if [[ "$RUNNER_ENGINE" == "claude" ]]; then
  inject_completion_gate || true
else
  inject_completion_gate_codex || true
fi
```

`ensure_claude_exclusions()` の `for entry in` 行を次に変える:

```bash
  for entry in '.claude/settings.local.json' '.claude/plans/' '.codex/hooks.json'; do
```

さらに、`ensure_claude_exclusions` は現在 claude engine のブロック内でしか呼ばれていない。
codex でも `.codex/hooks.json` を除外する必要があるので、呼び出しを engine 非依存の位置
（`inject_completion_gate*` の呼び出しブロックの直前）へ移すか、codex 側でも呼ぶ。

- [ ] **Step 5: テストが通ることを確認する**

```bash
bash test/test-completion-gate-injection.sh
```

Expected: `--- all passed ---`

- [ ] **Step 6: commit**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh \
        apps/cmux-team-dispatch-task/test/test-completion-gate-injection.sh
git commit -m "feat(dispatch): codex ペインへ completion gate を注入し .codex/hooks.json を除外する"
```

---

### Task 6: ドキュメントとバージョン

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md`
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md`
- Modify: `apps/cmux-team-dispatch-task/CLAUDE.md`
- Modify: `apps/cmux-team-dispatch-task/README.md`
- Modify: `apps/cmux-team-dispatch-task/.claude-plugin/plugin.json`
- Modify: `apps/cmux-team-dispatch-task/.codex-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`

- [ ] **Step 1: SKILL.md に completion gate の節を足す**

`### Pre-warm Standby Panes` の節の直後へ、次の内容を英語で書く（`SKILL.md` は英語必須）:

- 子セッションが仕事の途中で止まったら Stop hook が継続させること
- 判定はディスクだけを読み、モデル評価を使わないこと
- **「待って良い状態」（タスク未着 / verdict 待ち）は block しない**こと。これが
  monitor 専用設計の push 待機と両立する理由であること
- 依頼側とレビュアーで同じ「VERDICT 行が無い」状態の意味が逆になること
- 連続 block には上限（既定 10）があり、達したら諦めて停止を許すこと。上限到達は
  親が起床時に `status.json` から気づけること
- 注入はベストエフォートで、失敗しても dispatch は止まらないこと

- [ ] **Step 2: guide-ja.md に同じ節の日本語訳を足す**

`SKILL.md` の見出しと 1:1 対応させる（ルート `CLAUDE.md` の規約）。

- [ ] **Step 3: CLAUDE.md と README.md を更新する**

- `CLAUDE.md`: 検証項目に「completion gate が 4 ロールへ注入され、待機状態を block しないこと」を追加
- `README.md`: 「停止したら自動で再開する」ことと上限の説明を追加

- [ ] **Step 4: doc-lang 検証**

```bash
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins
node scripts/check-doc-lang.mjs
```

Expected: `check-doc-lang: OK`

- [ ] **Step 5: バージョンを 3.3.0 へ上げる**

3 箇所すべてを同期させる（ルート `CLAUDE.md` の規約）。

```bash
sed -i '' 's/"version": "3.2.1"/"version": "3.3.0"/' \
  apps/cmux-team-dispatch-task/.claude-plugin/plugin.json \
  apps/cmux-team-dispatch-task/.codex-plugin/plugin.json

python3 - <<'PY'
import json, pathlib
p = pathlib.Path('.claude-plugin/marketplace.json'); d = json.loads(p.read_text())
n = 0
for e in d.get('plugins', []):
    if e.get('name') == 'cmux-team-dispatch-task':
        e['version'] = '3.3.0'; n += 1
assert n == 1, n
p.write_text(json.dumps(d, indent=2, ensure_ascii=False) + "\n")
PY
```

- [ ] **Step 6: 全テストと check**

```bash
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins/apps/cmux-team-dispatch-task
for t in test/test-*.sh; do
  printf '%s ' "$(basename "$t")"; bash "$t" >/dev/null 2>&1 && echo OK || echo FAIL
done
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins && pnpm check
```

Expected: 全テスト OK、`pnpm check` が通る

- [ ] **Step 7: commit**

```bash
git add -A
git commit -m "docs(dispatch): completion gate を 4 ファイルへ記載し v3.3.0 へ上げる"
```

---

## 実行順の注意

Task 1 は**ゲート**である。結果によって Task 5 の有無と、最悪の場合は計画全体の破棄が決まる。
Task 1 を飛ばして Task 2 から始めてはならない — 動くと確かめていない機構の上に 5 タスク積むのは、
spec §3 で `/goal` を退けた理由（「動かないと分かった手段を指示に残すのは、手段が無いと書くより
悪い」）と同じ誤りになる。
