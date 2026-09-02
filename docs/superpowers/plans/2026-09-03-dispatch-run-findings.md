# dispatch 実運用 findings 対応 (第1弾) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 2026-09-02 の loop 実運用で「親が手で介入しなければ成果物が失われていた」不具合のうち、原因がコード上で確定している F1〜F6・F9 を、指示ではなく機構で塞ぐ。

**Architecture:** レビュー依頼をディスクへ materialize してから送る単一のヘルパーへ一本化し、gate の review 状態選択を role ごとの point へスコープする。PR の作成先は親が解決して `integration.json` として配り、子は読むだけにする。`report-status.sh` に 3 つのガードを足し、配線中の誤報告は sentinel ファイルで黙らせる。loop の後片付けはタスク単位で完結させる。

**Tech Stack:** bash (全スクリプト)、jq、gh CLI、agmsg (`~/.agents/skills/agmsg/scripts/send.sh`)、cmux CLI。テストは `apps/cmux-team-dispatch-task/test/test-*.sh` の bash 直実行。

**Spec:** `docs/superpowers/specs/2026-09-03-dispatch-run-findings-design.md`

## Global Constraints

- 作業ディレクトリはリポジトリルート `/Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins`。以下のパスはすべて `apps/cmux-team-dispatch-task/` からの相対で書く。実際のコマンドではこのプレフィックスを付けること。
- **ドキュメント言語規約**: `skills/*/SKILL.md`、`references/*.md`（`*-ja.md` を除く）、`commands/*.md` に**日本語文字を書いてはならない**。SKILL.md を更新したら `skills/cmux-team-dispatch-task/references/guide-ja.md` を**同じコミットで**更新する。`references/loop-mode.md` を更新したら `references/loop-mode-ja.md` も同じコミットで更新する。検証は `pnpm check:doc-lang`。
- **シェルスクリプトのコメントは日本語**（既存スクリプトに合わせる）。コード識別子・CLI フラグは英語。
- **コミットメッセージは日本語**。形式は `<type>(dispatch): <要約>`。既存履歴に合わせる。
- 新規スクリプトはすべて `#!/usr/bin/env bash` + `set -uo pipefail`（`set -e` は使わない。既存スクリプトの慣例）。
- 一時ファイルは**同一ディレクトリの `mktemp` + `mv`** で原子的に置換する。共有名の `.tmp` は並列書き込みで壊れるため使わない。
- テストは `bash apps/cmux-team-dispatch-task/test/test-<name>.sh` で単体実行し、末尾で `exit $fail` する。PASS/FAIL 行を不変条件 ID 付きで出す。
- **`error` 状態への遷移は絶対に塞がない。** 本タスクで追加するどのガードも `report-status.sh <dir> error` を拒否してはならない。
- agmsg のメッセージ本文プレフィックスは `phase-a-task:` / `phase-b-exec:` / `review-plan:` / `review-code:` / `review-verdict:` / `abort-reviewer:` / `dispatch-notify:` の 7 種のみ。新設しない。

---

## File Structure

| パス | 責務 |
|------|------|
| `skills/cmux-team-dispatch-task/scripts/review-request.sh` | **新規**。レビュー依頼を request ファイルへ書いてから 1 回だけ送る。書けたが送れないときはファイルを消す |
| `skills/cmux-team-dispatch-task/scripts/record-pr.sh` | **新規**。指定リポジトリ上に PR が実在することを確認してから `status.json` の `pr_url` を更新する |
| `skills/cmux-team-dispatch-task/scripts/review-state.sh` | review ディレクトリの状態計算。point スコープを受け取れるようにする |
| `skills/cmux-team-dispatch-task/scripts/completion-gate.sh` | Stop hook 判定。role→point を渡す / 配線中は静かに allow / REVIEW_HINT の文面 |
| `skills/cmux-team-dispatch-task/scripts/report-status.sh` | 終端状態の書き込み口。V1/V2 の拒否と V3 の警告 |
| `skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh` | ペイン起動。`integration.json` の書き出しと `.wiring` sentinel |
| `skills/cmux-team-dispatch-task/scripts/phase-b-deliver.sh` | Phase B 委譲。`integration.json` を読んで PR 手順を埋める / 依頼手順を helper へ |
| `skills/cmux-team-dispatch-task/scripts/phase-a-review-wait.sh` | Phase A-R 待機文の生成。依頼手順を helper へ |
| `skills/cmux-team-dispatch-task/scripts/launch-workspace.sh` | ペイン起動と inner prompt 組み立て。`REVIEW_INSTRUCTION` の依頼手順を helper へ |
| `skills/cmux-team-dispatch-task/scripts/loop-cleanup.sh` | batch 後片付け。close の追加 / 段階ログ / `verify_done` の `--repo` |
| `skills/cmux-team-dispatch-task/references/unattended/review-block.md` | 無人 Phase A-R 手順（英語） |
| `skills/cmux-team-dispatch-task/references/unattended/code-review-block.md` | 無人 Phase B-R 手順（英語） |
| `test/test-review-request.sh` | **新規**。Task 1 の回帰テスト |
| `test/test-record-pr.sh` | **新規**。Task 5 の回帰テスト |
| `test/test-report-status.sh` | **新規**。Task 7 の回帰テスト |
| `test/test-integration-config.sh` | **新規**。Task 4 の回帰テスト |

---

### Task 1: `review-request.sh` — レビュー依頼の原子化

**Files:**
- Create: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/review-request.sh`
- Test: `apps/cmux-team-dispatch-task/test/test-review-request.sh`

**Interfaces:**
- Consumes: agmsg `send.sh <team> <from> <to> <body>`（環境変数 `AGMSG_SEND` で差し替え可能）
- Produces: `review-request.sh --review-dir <dir> --point <design|code> --round <1..5> --team <team> --from <agent> --to <agent>` を stdin から本文を読んで実行。副作用は `<review-dir>/<point>-round-<N>-request.md` の作成と agmsg 送信 1 回。exit 0 = 両方成功 / 1 = 送信失敗（request ファイルは削除済み） / 2 = 使用法エラー（何も書かない）

- [ ] **Step 1: 失敗するテストを書く**

`apps/cmux-team-dispatch-task/test/test-review-request.sh`:

```bash
#!/usr/bin/env bash
# review-request.sh の回帰テスト。
#
# 守っている不変条件:
#   RQ1. 本文を stdin から受け、<point>-round-<N>-request.md へ書く
#   RQ2. 同じ本文を review-code: プレフィックス付きで send.sh へ 4 引数で渡す
#   RQ3. point=design なら review-plan: プレフィックス
#   RQ4. send.sh が非ゼロなら request ファイルを削除して exit 1
#        (残すと gate が「始まっていない待機」を待機と読む)
#   RQ5. 空 stdin は exit 2 で、ファイルを 1 つも作らない
#   RQ6. 不正な point / round / agent 名は exit 2
#   RQ7. 同一ラウンドの再送は上書きし、mtime が進む
#   RQ8. 一時ファイルは *.md にマッチしない (review_select_active の走査を汚さない)

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/review-request.sh"
[[ -f "$BIN" ]] || { echo "FAIL: スクリプトが見つからない: $BIN"; exit 2; }

fail=0
pass() { echo "PASS $1"; }
bad() { echo "FAIL $1"; fail=1; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

SEND="$TMP/send.sh"
SEND_LOG="$TMP/send.log"
cat > "$SEND" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$#" >> "$SEND_LOG"
for a in "$@"; do printf '%s\n' "$a" >> "$SEND_LOG"; done
exit "${SEND_EXIT:-0}"
STUB
chmod +x "$SEND"

mkrd() { local d="$TMP/$1/review"; mkdir -p "$d"; printf '%s' "$d"; }
run() { AGMSG_SEND="$SEND" SEND_LOG="$SEND_LOG" bash "$BIN" "$@"; }

# --- RQ1 / RQ2 ---
rd=$(mkrd rq1)
: > "$SEND_LOG"
printf 'code review round 1: inspect the committed implementation\n' \
  | run --review-dir "$rd" --point code --round 1 --team t1 --from ex --to rev
rc=$?
req="$rd/code-round-1-request.md"
if [[ $rc -eq 0 && -f "$req" ]] && grep -q 'inspect the committed implementation' "$req"; then
  pass "RQ1: request ファイルを書く"
else
  bad "RQ1: rc=$rc file=$([[ -f $req ]] && echo yes || echo no)"
fi
if [[ "$(sed -n 1p "$SEND_LOG")" == 4 \
   && "$(sed -n 2p "$SEND_LOG")" == t1 \
   && "$(sed -n 3p "$SEND_LOG")" == ex \
   && "$(sed -n 4p "$SEND_LOG")" == rev ]] \
   && sed -n 5p "$SEND_LOG" | grep -q '^review-code: code review round 1'; then
  pass "RQ2: 4 引数と review-code: プレフィックス"
else
  bad "RQ2: send.sh の引数が違う: $(tr '\n' '|' < "$SEND_LOG")"
fi

# --- RQ3 ---
rd=$(mkrd rq3)
: > "$SEND_LOG"
printf 'plan review\n' | run --review-dir "$rd" --point design --round 2 --team t1 --from d --to dr
if [[ -f "$rd/design-round-2-request.md" ]] && sed -n 5p "$SEND_LOG" | grep -q '^review-plan: plan review'; then
  pass "RQ3: design は review-plan: プレフィックス"
else
  bad "RQ3: design の経路が違う"
fi

# --- RQ4 ---
rd=$(mkrd rq4)
printf 'body\n' | SEND_EXIT=1 AGMSG_SEND="$SEND" SEND_LOG="$SEND_LOG" \
  bash "$BIN" --review-dir "$rd" --point code --round 1 --team t1 --from ex --to rev
rc=$?
if [[ $rc -eq 1 && ! -e "$rd/code-round-1-request.md" ]]; then
  pass "RQ4: 送信失敗で request ファイルを削除し exit 1"
else
  bad "RQ4: rc=$rc 残存=$([[ -e $rd/code-round-1-request.md ]] && echo yes || echo no)"
fi

# --- RQ5 ---
rd=$(mkrd rq5)
printf '   \n' | run --review-dir "$rd" --point code --round 1 --team t1 --from ex --to rev
rc=$?
if [[ $rc -eq 2 && -z "$(ls -A "$rd")" ]]; then
  pass "RQ5: 空 stdin は exit 2 で何も作らない"
else
  bad "RQ5: rc=$rc 中身=$(ls -A "$rd")"
fi

# --- RQ6 ---
rd=$(mkrd rq6)
bad6=0
printf 'b\n' | run --review-dir "$rd" --point spec --round 1 --team t1 --from ex --to rev
[[ $? -eq 2 ]] || bad6=1
printf 'b\n' | run --review-dir "$rd" --point code --round 6 --team t1 --from ex --to rev
[[ $? -eq 2 ]] || bad6=1
printf 'b\n' | run --review-dir "$rd" --point code --round 1 --team 't 1' --from ex --to rev
[[ $? -eq 2 ]] || bad6=1
printf 'b\n' | run --review-dir "$TMP/does-not-exist" --point code --round 1 --team t1 --from ex --to rev
[[ $? -eq 2 ]] || bad6=1
if [[ $bad6 -eq 0 && -z "$(ls -A "$rd")" ]]; then
  pass "RQ6: 不正な引数は exit 2 で何も作らない"
else
  bad "RQ6: 検証が緩い"
fi

# --- RQ7 ---
rd=$(mkrd rq7)
printf 'round 1 first\n' | run --review-dir "$rd" --point code --round 1 --team t1 --from ex --to rev
req="$rd/code-round-1-request.md"
before=$(stat -f %m "$req" 2>/dev/null || stat -c %Y "$req")
sleep 1.1
printf 'round 1 resend\n' | run --review-dir "$rd" --point code --round 1 --team t1 --from ex --to rev
after=$(stat -f %m "$req" 2>/dev/null || stat -c %Y "$req")
if grep -q 'round 1 resend' "$req" && (( after > before )); then
  pass "RQ7: 再送で上書きし mtime が進む"
else
  bad "RQ7: before=$before after=$after"
fi

# --- RQ8 ---
rd=$(mkrd rq8)
printf 'body\n' | run --review-dir "$rd" --point code --round 1 --team t1 --from ex --to rev
shopt -s nullglob
mds=("$rd"/*.md)
if [[ ${#mds[@]} -eq 1 ]]; then
  pass "RQ8: *.md にマッチするのは request ファイルだけ"
else
  bad "RQ8: *.md が ${#mds[@]} 個ある: ${mds[*]}"
fi
shopt -u nullglob

[[ $fail -eq 0 ]] && echo "--- すべて PASS ---" || echo "--- FAIL あり ---"
exit $fail
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `bash apps/cmux-team-dispatch-task/test/test-review-request.sh`
Expected: `FAIL: スクリプトが見つからない: .../review-request.sh` で exit 2

- [ ] **Step 3: `review-request.sh` を実装**

`apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/review-request.sh`:

```bash
#!/usr/bin/env bash
# review-request.sh — レビュー依頼をディスクへ materialize してから 1 回だけ送る。
#
# completion-gate.sh の「レビュー待ちなら停止を許す」判定はディスクだけを読み、その材料は
# <point>-round-<N>-request.md である。書き込みと送信を別々の手順として指示すると、実測で
# 4/7 の頻度で書き込みだけが落ちた (2026-09-02 の loop 運用。親が明示的に指示し直しても再発)。
# 落ちた側は gate から待機に見えないので判定 7 に落ち、その文面が提示する唯一の出口 error を
# 取って、進行中のレビューごと中断される。
#
# 本文は stdin で受ける。--body-file にすると「先にファイルを書く」という、いま落ちている
# 手順がそのまま残る。位置引数は、複数行かつ引用符を含む依頼文が zsh -ic "..." の内側で
# 壊れるため使わない。
#
# Usage:
#   review-request.sh --review-dir <dir> --point <design|code> --round <N> \
#                     --team <team> --from <agent> --to <agent> < body
#
# Exit: 0 = 書いて送った / 1 = 送信失敗 (request ファイルは削除済み) / 2 = 使用法エラー
set -uo pipefail

die() { echo "review-request: $1" >&2; exit 2; }
fail() { echo "review-request: $1" >&2; exit 1; }

REVIEW_DIR=''; POINT=''; ROUND=''; TEAM=''; FROM=''; TO=''
AGMSG_SEND="${AGMSG_SEND:-$HOME/.agents/skills/agmsg/scripts/send.sh}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --review-dir) [[ $# -ge 2 ]] || die '--review-dir requires a value'; REVIEW_DIR="$2"; shift 2 ;;
    --point)      [[ $# -ge 2 ]] || die '--point requires a value';      POINT="$2";      shift 2 ;;
    --round)      [[ $# -ge 2 ]] || die '--round requires a value';      ROUND="$2";      shift 2 ;;
    --team)       [[ $# -ge 2 ]] || die '--team requires a value';       TEAM="$2";       shift 2 ;;
    --from)       [[ $# -ge 2 ]] || die '--from requires a value';       FROM="$2";       shift 2 ;;
    --to)         [[ $# -ge 2 ]] || die '--to requires a value';         TO="$2";         shift 2 ;;
    *) die "unknown option: $1" ;;
  esac
done

case "$POINT" in design|code) ;; *) die 'point must be design or code' ;; esac
[[ "$ROUND" =~ ^[1-5]$ ]] || die 'round must be 1..5'
[[ "$TEAM" =~ ^[A-Za-z0-9._-]+$ ]] || die 'team must match [A-Za-z0-9._-]+'
[[ "$FROM" =~ ^[A-Za-z0-9._-]+$ ]] || die 'from must match [A-Za-z0-9._-]+'
[[ "$TO"   =~ ^[A-Za-z0-9._-]+$ ]] || die 'to must match [A-Za-z0-9._-]+'
[[ -n "$REVIEW_DIR" && -d "$REVIEW_DIR" && ! -L "$REVIEW_DIR" ]] \
  || die 'review-dir must be an existing non-symlink directory'
[[ -f "$AGMSG_SEND" ]] || die "send.sh not found at $AGMSG_SEND"

# 本文は stdin から一括で読む。空 (空白のみを含む) なら何も書かずに終わる — 空の依頼を
# ディスクへ残すと、gate はそれを正当な待機として読んでしまう。
BODY=$(cat) || die 'cannot read the request body from stdin'
[[ -n "${BODY//[[:space:]]/}" ]] || die 'the request body on stdin is empty'

TARGET="$REVIEW_DIR/$POINT-round-$ROUND-request.md"
if [[ -e "$TARGET" || -L "$TARGET" ]]; then
  [[ -f "$TARGET" && ! -L "$TARGET" ]] || die 'request target must be a regular non-symlink file'
fi

# 一時名は先頭ドット + .md 以外の接尾辞にする。review_select_active は review/*.md を走査
# するので、書きかけの一時ファイルがそこへ現れてはならない。
TMP=$(mktemp "$REVIEW_DIR/.$POINT-round-$ROUND-request.XXXXXX") || fail 'mktemp failed'
if ! printf '%s\n' "$BODY" > "$TMP"; then
  rm -f "$TMP"; fail 'cannot write the request file'
fi
mv -- "$TMP" "$TARGET" || { rm -f "$TMP"; fail "cannot publish $TARGET"; }

case "$POINT" in
  design) PREFIX='review-plan: ' ;;
  code)   PREFIX='review-code: ' ;;
esac

# 送れなかったらファイルを消す。残すと「始まっていない待機」を gate が待機として読み、
# 相手が居ないまま WAIT_MINUTES を丸ごと溶かす。
if ! bash "$AGMSG_SEND" "$TEAM" "$FROM" "$TO" "$PREFIX$BODY"; then
  rm -f "$TARGET"
  fail "delivery to $TO failed; the request file was removed so the gate does not read a wait that never started"
fi
```

- [ ] **Step 4: テストを実行して通ることを確認**

Run: `bash apps/cmux-team-dispatch-task/test/test-review-request.sh`
Expected: RQ1〜RQ8 がすべて PASS、`--- すべて PASS ---`、exit 0

- [ ] **Step 5: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/review-request.sh \
        apps/cmux-team-dispatch-task/test/test-review-request.sh
git commit -m "feat(dispatch): レビュー依頼を原子的に送る review-request.sh を追加する"
```

---

### Task 2: `review-state.sh` の point スコープ化と gate への配線

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/review-state.sh`
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/completion-gate.sh`
- Test: `apps/cmux-team-dispatch-task/test/test-review-state.sh`（追記）
- Test: `apps/cmux-team-dispatch-task/test/test-completion-gate.sh`（追記）

**Interfaces:**
- Consumes: なし（Task 1 とは独立）
- Produces: `review_select_active <status-dir> [point]`。第 2 引数を渡すと、その point（ファイル名の `-round-` より前の部分）のキーだけを候補にする。省略時は従来どおり全 point。`completion-gate.sh` は `design`/`design_review` に `design` を、`exec`/`exec_review` に `code` を渡す

- [ ] **Step 1: 失敗するテストを書く（review-state 側）**

`apps/cmux-team-dispatch-task/test/test-review-state.sh` の末尾、`[[ $fail -eq 0 ]]` の行の**直前**に追記:

```bash
# RS-P1: point を渡すと、その point のキーだけが候補になる。
# exec が code の request を書かないまま、design 側が新しい VERDICT 付き findings を持つ状況。
# スコープ無しだと design が選ばれて「レビューは終わっている」に見える (2026-09-02 の F1)。
d=$(mk rsp1)
printf 'findings\n' > "$d/review/code-round-1.md"; sleep 1
printf 'findings\nVERDICT: approve\n' > "$d/review/design-round-2.md"
review_select_active "$d"; chk RS-P1a "$RS_POINT|$RS_ROUND" 'design|2'
review_select_active "$d" code; chk RS-P1b "$RS_POINT|$RS_ROUND" 'code|1'
review_select_active "$d" code
[[ "$RS_FINDINGS_UNFINISHED" == 1 ]] \
  && pass "RS-P1c: code へスコープすると VERDICT 未達を検出する" \
  || bad "RS-P1c: RS_FINDINGS_UNFINISHED=$RS_FINDINGS_UNFINISHED"

# RS-P2: スコープした point のファイルが 1 つも無ければ、何も選ばずに戻る。
# 別 point へ退避しない — 退避は RS-P1 で塞いだ masking を再現するだけである。
d=$(mk rsp2)
printf 'findings\nVERDICT: approve\n' > "$d/review/design-round-1.md"
review_select_active "$d" code
chk RS-P2a "$RS_POINT|$RS_ROUND" '|'
[[ "$RS_HAS_ACTIVITY" == 0 ]] \
  && pass "RS-P2b: スコープ空振りは activity なし" \
  || bad "RS-P2b: RS_HAS_ACTIVITY=$RS_HAS_ACTIVITY"

# RS-P3: point 省略時の挙動は変わらない (既存の呼び出し元を壊さない)。
d=$(mk rsp3)
printf 'req\n' > "$d/review/code-round-1-request.md"
review_select_active "$d"; chk RS-P3 "$RS_POINT|$RS_ROUND" 'code|1'
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `bash apps/cmux-team-dispatch-task/test/test-review-state.sh`
Expected: `FAIL RS-P1b: got=[design|2] want=[code|1]` と `FAIL RS-P2a` が出て exit 1

- [ ] **Step 3: `review-state.sh` に point 引数を足す**

`scripts/review-state.sh` の関数シグネチャを変更する。

変更前:
```bash
review_select_active() {
  local sd="$1" f base p n key
```
変更後:
```bash
review_select_active() {
  # $2 = 省略可能な point。渡すとその point のキーだけを候補にする。
  # role ごとに自分の review point だけを見るためのもので、フォールバックは持たない。
  # 「スコープが空振りしたら全体を見る」にすると、design 点の VERDICT 付き findings が
  # exec の未完了レビューをマスクする経路 (2026-09-02 の F1) がそのまま戻る。
  local sd="$1" want_point="${2:-}" f base p n key
```

同ファイルのキー収集ループを変更する。

変更前:
```bash
    [[ "$base" =~ ^(.+)-round-([0-9]+)(-request|-abort)?\.md$ ]] || continue
    key="${BASH_REMATCH[1]}|${BASH_REMATCH[2]}"
```
変更後:
```bash
    [[ "$base" =~ ^(.+)-round-([0-9]+)(-request|-abort)?\.md$ ]] || continue
    [[ -z "$want_point" || "${BASH_REMATCH[1]}" == "$want_point" ]] || continue
    key="${BASH_REMATCH[1]}|${BASH_REMATCH[2]}"
```

- [ ] **Step 4: テストを実行して通ることを確認**

Run: `bash apps/cmux-team-dispatch-task/test/test-review-state.sh`
Expected: RS-P1a/b/c、RS-P2a/b、RS-P3 を含めすべて PASS、exit 0

- [ ] **Step 5: gate の回帰テストを書く**

`apps/cmux-team-dispatch-task/test/test-completion-gate.sh` の末尾、集計行の**直前**に追記。このファイルは gate を `$BIN`、一時領域を `$TMP`、ケース作成を `mkdir_case <name>`、status 作成を `set_status <dir> <status>` で持っている（`pass` / `bad` も同ファイル定義）:

```bash
# CG-P1: exec が code のレビュー待ちである間、design 側の新しい VERDICT に隠されない。
# 2026-09-02 の F1 の再現: reviewer は code-round-1.md を書き始めているが VERDICT はまだ無く、
# design-round-2.md (VERDICT 付き) の方が新しい。スコープ前はここで判定 7 に落ち、
# 実装者に error を勧めていた。
d=$(mkdir_case cgp1); set_status "$d" executing
: > "$d/.assigned-task-exec"
printf 'req\n' > "$d/review/code-round-1-request.md"; sleep 1
printf 'partial findings\n' > "$d/review/code-round-1.md"; sleep 1
printf 'findings\nVERDICT: approve\n' > "$d/review/design-round-2.md"
out=$(bash "$BIN" --status-dir "$d" --role exec --agent task-exec 2>/dev/null); rc=$?
if [[ $rc -eq 0 && -z "$out" ]]; then
  pass "CG-P1: code へスコープした exec は待機として allow される"
else
  bad "CG-P1: rc=$rc out=[$out]"
fi
```

（`set_status` は `prewarm.json` に `exec.agent = "task-exec"` を書くので、`.assigned-task-exec` と agent 名を揃えている。）

- [ ] **Step 6: テストを実行して失敗を確認**

Run: `bash apps/cmux-team-dispatch-task/test/test-completion-gate.sh`
Expected: `FAIL CG-P1` — `out` に `{"decision":"block",...}` が入っている

- [ ] **Step 7: `completion-gate.sh` に role→point を配線**

`scripts/completion-gate.sh` の `review_select_active "$STATUS_DIR"` の呼び出し箇所を変更する。

変更前:
```bash
. "$SCRIPT_DIR/review-state.sh"
review_select_active "$STATUS_DIR"
```
変更後:
```bash
. "$SCRIPT_DIR/review-state.sh"
# role ごとに自分の review point だけを見る。design ペインは Phase A-R の依頼者、exec は
# Phase B-R の依頼者であり、それぞれの相手が design_review / exec_review である。
# 全 point を混ぜて最新 1 件を選ぶと、design 点の VERDICT 付き findings が exec の未完了
# レビューをマスクし、待機中の実装者が判定 7 へ落ちる (2026-09-02 に 4/7 のタスクで発生)。
case "$ROLE" in
  design|design_review) GATE_POINT=design ;;
  exec|exec_review)     GATE_POINT=code ;;
esac
review_select_active "$STATUS_DIR" "$GATE_POINT"
```

- [ ] **Step 8: テストを実行して通ることを確認**

Run:
```bash
bash apps/cmux-team-dispatch-task/test/test-completion-gate.sh
bash apps/cmux-team-dispatch-task/test/test-review-state.sh
bash apps/cmux-team-dispatch-task/test/test-review-gate.sh
bash apps/cmux-team-dispatch-task/test/test-completion-gate-injection.sh
```
Expected: 4 本すべて exit 0

- [ ] **Step 9: SKILL.md と guide-ja.md を更新**

`skills/cmux-team-dispatch-task/SKILL.md` の completion gate 判定を説明している箇所（`grep -n "review-state" SKILL.md` で特定）に、次の英文を 1 段落として追加する:

```markdown
The gate scopes the review state to the role's own review point: `design` and
`design_review` see only `design-round-*`, `exec` and `exec_review` see only
`code-round-*`. There is no fallback to an unscoped scan. Mixing both points and taking
the newest file lets a finished design review mask an unfinished code review, which sends
a waiting implementer into the "task is not finished" branch; measured on 2026-09-02 in 4
of 7 tasks.
```

同じ内容の訳を `references/guide-ja.md` の対応する見出しの下へ入れる:

```markdown
gate は review の状態を role 自身の review point へスコープする。`design` と `design_review`
は `design-round-*` だけを、`exec` と `exec_review` は `code-round-*` だけを見る。未スコープ
走査へのフォールバックは無い。両 point を混ぜて最新ファイルを取ると、完了した design review が
未完了の code review をマスクし、待機中の実装者を「タスクが終わっていない」分岐へ落とす
（2026-09-02 に 7 タスク中 4 件で実測）。
```

- [ ] **Step 10: ドキュメント言語検査**

Run: `pnpm check:doc-lang`
Expected: exit 0（違反なし）

- [ ] **Step 11: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/review-state.sh \
        apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/completion-gate.sh \
        apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md \
        apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md \
        apps/cmux-team-dispatch-task/test/test-review-state.sh \
        apps/cmux-team-dispatch-task/test/test-completion-gate.sh
git commit -m "fix(dispatch): review の状態を role の point へスコープする"
```

---

### Task 3: レビュー依頼手順を `review-request.sh` へ統一する

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/phase-b-deliver.sh:177-198`
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/phase-a-review-wait.sh`
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh:1071`
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/completion-gate.sh:416`
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/unattended/review-block.md`
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/unattended/code-review-block.md`
- Test: `apps/cmux-team-dispatch-task/test/test-delivery-callsites.sh`（追記）

**Interfaces:**
- Consumes: Task 1 の `review-request.sh`（引数は Task 1 の Produces のとおり）
- Produces: 依頼側のプロンプト文面。レビュー依頼だけが helper 経由になり、`review-verdict:` / `abort-reviewer:` / `dispatch-notify:` は従来どおり `send.sh` 直呼びのまま

- [ ] **Step 1: 失敗する契約テストを書く**

`apps/cmux-team-dispatch-task/test/test-delivery-callsites.sh` の不変条件コメント（冒頭）へ CS8 を追記し、集計行の直前へ次を追加する。ファイル冒頭の `pass`/`bad` ヘルパー名は実物を読んで合わせること:

```bash
# CS8: レビュー依頼は review-request.sh 経由に一本化されている。
#      依頼側の 4 つの生成元と 2 つの無人ブロックが helper を名指ししており、かつ
#      「request ファイルを書いてから send.sh を呼べ」という 2 手順の旧文面が残らない。
#      2 手順のままだと 4/7 の頻度で書き込みだけが落ちる (2026-09-02 実測)。
CS8_SOURCES=(
  "$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/phase-b-deliver.sh"
  "$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/phase-a-review-wait.sh"
  "$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/launch-workspace.sh"
  "$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/completion-gate.sh"
  "$SCRIPT_DIR/../skills/cmux-team-dispatch-task/references/unattended/review-block.md"
  "$SCRIPT_DIR/../skills/cmux-team-dispatch-task/references/unattended/code-review-block.md"
)
cs8=0
for f in "${CS8_SOURCES[@]}"; do
  grep -q 'review-request\.sh' "$f" || { echo "  CS8: $f に review-request.sh が無い"; cs8=1; }
done
# 旧文面の残骸。request ファイルのパスと send を同じ文で語る指示は消えていること。
if grep -rn 'write that same message text to' "${CS8_SOURCES[@]}" >/dev/null 2>&1; then
  echo "  CS8: 2 手順の旧文面が残っている"; cs8=1
fi
if [[ $cs8 -eq 0 ]]; then
  pass "CS8: レビュー依頼が review-request.sh へ一本化されている"
else
  bad "CS8: レビュー依頼の一本化が未完了"
fi
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `bash apps/cmux-team-dispatch-task/test/test-delivery-callsites.sh`
Expected: `FAIL CS8` と、6 ファイルすべてに `review-request.sh` が無い旨の 6 行

- [ ] **Step 3: `phase-b-deliver.sh` の Phase B-R 文面を差し替える**

`scripts/phase-b-deliver.sh` の `REQUEST_PATH` 定義（177 行付近）を、helper のパスに置き換える。

変更前:
```bash
  REQUEST_PATH="$REVIEW_DIR/code-round-N-request.md"
```
変更後:
```bash
  # 依頼はディスクへ materialize させる。completion-gate.sh の「レビュー待ちなら停止を許す」
  # 判定はディスクだけを読み、その材料は <point>-round-<N>-request.md である。書き込みと
  # 送信を 2 手順として指示すると、実測 4/7 の頻度で書き込みだけが落ちた (2026-09-02)。
  # review-request.sh は両方を 1 コマンドで行い、送信に失敗したらファイルを消す。
  REVIEW_REQUEST_CMD="bash $SCRIPT_DIR/review-request.sh"
```

同ファイルの `REQUEST_TEXT` の `MANDATORY CODE REVIEW:` 節（198 行付近）で、依頼手順の前半を置き換える。

変更前（`REQUEST_TEXT="$REQUEST_TEXT MANDATORY CODE REVIEW: ...` の冒頭部分）:
```
MANDATORY CODE REVIEW: after all changes are committed and before creating the PR, request the review with ONE call to $AGMSG_SEND, passing exactly four arguments in this order: team $TEAM, sender $EXEC_AGENT, recipient $REVIEWER_AGENT, and the whole review-code: message as one argument. For round N, write that same message text to $REQUEST_PATH before that send: the completion gate reads only the disk, and this file is the sole proof that you are waiting for a verdict instead of idling mid-task. Without it the gate stops you every turn and offers a terminal error you must not take. For round N, that message tells the reviewer to
```
変更後:
```
MANDATORY CODE REVIEW: after all changes are committed and before creating the PR, request the review with ONE call to $REVIEW_REQUEST_CMD --review-dir $REVIEW_DIR --point code --round N --team $TEAM --from $EXEC_AGENT --to $REVIEWER_AGENT, piping the whole request text into it on standard input with a here-document. That single call writes the request to disk and sends it; do NOT call $AGMSG_SEND yourself for a review request, and do NOT write the request file by hand. The completion gate reads only the disk, and that file is the sole proof that you are waiting for a verdict instead of idling mid-task; a non-zero exit from the helper means the reviewer was NOT told and the file was removed, so report it instead of waiting. The request text tells the reviewer to
```

- [ ] **Step 4: `phase-a-review-wait.sh` に依頼手順を足す**

`scripts/phase-a-review-wait.sh` は現在、待機プロトコルだけを出力し依頼手順を持たない。冒頭の `printf` の直前へ、両 engine 共通の依頼手順を出力する行を足す。`--review-dir` を新しい引数として受ける。

usage 行を変更する。

変更前:
```bash
  echo 'usage: phase-a-review-wait.sh --waiter-engine <claude|codex> --reviewer-engine <claude|codex> --team <team> --waiter-agent <agent> --reviewer-agent <agent> --reviewer-workspace <workspace:N> --reviewer-surface <surface:N> --findings-path <path> --send-command <path>' >&2
```
変更後:
```bash
  echo 'usage: phase-a-review-wait.sh --waiter-engine <claude|codex> --reviewer-engine <claude|codex> --team <team> --waiter-agent <agent> --reviewer-agent <agent> --reviewer-workspace <workspace:N> --reviewer-surface <surface:N> --findings-path <path> --review-dir <path> --send-command <path>' >&2
```

変数宣言と引数解析へ `REVIEW_DIR` を足す。

変更前:
```bash
FINDINGS_PATH=''
SEND_COMMAND=''
```
変更後:
```bash
FINDINGS_PATH=''
REVIEW_DIR=''
SEND_COMMAND=''
```

変更前:
```bash
    --findings-path) [[ $# -ge 2 ]] || usage; FINDINGS_PATH="$2"; shift 2 ;;
```
変更後:
```bash
    --findings-path) [[ $# -ge 2 ]] || usage; FINDINGS_PATH="$2"; shift 2 ;;
    --review-dir) [[ $# -ge 2 ]] || usage; REVIEW_DIR="$2"; shift 2 ;;
```

変更前:
```bash
[[ -n "$FINDINGS_PATH" && -n "$SEND_COMMAND" ]] || usage
```
変更後:
```bash
[[ -n "$FINDINGS_PATH" && -n "$REVIEW_DIR" && -n "$SEND_COMMAND" ]] || usage
```

`case "$WAITER_ENGINE" in` の直前へ、依頼手順の出力を足す:

```bash
# 依頼の出し方は待機の仕方より先に書く。依頼がディスクへ現れないと、そのあとの待機は
# gate から見えず、判定 7 の「terminal status を書け」に落ちる (2026-09-02 の F1)。
printf 'Request each design review round with ONE call to bash %s/review-request.sh --review-dir %s --point design --round N --team %s --from %s --to %s, piping the whole request text into it on standard input with a here-document. That single call writes the request to disk and sends it. Do NOT send a review request with agmsg send.sh and do NOT write the request file by hand; a non-zero exit means the reviewer was NOT told and the file was removed, so report it instead of waiting.\n' \
  "$SCRIPT_DIR" "$REVIEW_DIR" "$TEAM" "$WAITER_AGENT" "$REVIEWER_AGENT"
```

- [ ] **Step 5: `launch-workspace.sh` の `REVIEW_INSTRUCTION` を差し替える**

`scripts/launch-workspace.sh:1071` の `REVIEW_INSTRUCTION` 内、`(1) request the review with ONE call to $AGMSG_SEND, ... as a single quoted argument.` の一文を次に置き換える:

```
(1) request the review with ONE call to bash $SCRIPT_DIR/review-request.sh --review-dir $REVIEW_DIR --point code --round N --team $AGMSG_TEAM --from $AGMSG_FROM --to $REVIEWER_AGENT, piping the whole request text into it on standard input with a here-document. That single call writes the request to $REVIEW_DIR/code-round-N-request.md and sends it. Do NOT send a review request with agmsg send.sh and do NOT write the request file by hand. A non-zero exit means the reviewer was NOT told and the file was removed, so report that instead of waiting.
```

`$SCRIPT_DIR` がこのスクリプトで未定義なら、ファイル冒頭の既存の定義（`grep -n 'SCRIPT_DIR=' scripts/launch-workspace.sh`）を確認して使う。無ければ `"$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"` で定義を追加する。

- [ ] **Step 6: `completion-gate.sh` の `REVIEW_HINT` を差し替える**

`scripts/completion-gate.sh:416` の末尾一文を置き換える。

変更前:
```
Before the review, write your request text to $STATUS_DIR/review/code-round-<N>-request.md, then send it with one call whose body starts with review-code:.
```
変更後:
```
Make the request with one call to bash $SCRIPT_DIR/review-request.sh --review-dir $STATUS_DIR/review --point code --round <N> --team $TEAM --from $AGENT --to $reviewer, piping the request text into it on standard input; that single call writes the request file this gate reads and sends the message.
```

同じ理由で、判定 7 の最終 `block` 文面にある「request ファイルを自分で書け」という誘導も置き換える。

変更前:
```
Instead write the request text you already sent to $STATUS_DIR/review/<point>-round-<N>-request.md for the round you requested, which is how this gate sees a wait, then keep waiting.
```
変更後:
```
Instead re-issue the same round through bash $SCRIPT_DIR/review-request.sh --review-dir $STATUS_DIR/review --point <design|code> --round <N> --team $TEAM --from $AGENT --to <the reviewer agent>, piping the same request text into it on standard input; that is how this gate sees a wait. Then keep waiting.
```

- [ ] **Step 7: 無人ブロック 2 本を更新（英語のまま）**

`references/unattended/review-block.md` の 1 文目を置き換える。

変更前:
```
After preparing the plan, request review from that configured pane.
```
変更後:
```
After preparing the plan, request review from that configured pane with ONE call to `<skill dir>/scripts/review-request.sh --review-dir <status dir>/review --point design --round N --team <team> --from <your agent name> --to <Design review agent>`, piping the whole request text into it on standard input with a here-document. That single call writes the request to disk and sends it. Never send a review request with `send.sh` and never write the request file by hand; a non-zero exit means the reviewer was NOT told and the file was removed, so report it instead of waiting.
```

`references/unattended/code-review-block.md` の 1 文目を置き換える。

変更前:
```
Phase B-R is assigned to the `exec_review` pane. Request each review with ONE call to agmsg `send.sh`: `~/.agents/skills/agmsg/scripts/send.sh <team> <your agent name> <Exec review agent> 'review-code: <request text>'`.
```
変更後:
```
Phase B-R is assigned to the `exec_review` pane. Request each review with ONE call to `<skill dir>/scripts/review-request.sh --review-dir <status dir>/review --point code --round N --team <team> --from <your agent name> --to <Exec review agent>`, piping the whole request text into it on standard input with a here-document. That single call writes the request to `<status dir>/review/code-round-N-request.md` — which is the only thing the completion gate reads as proof that you are waiting — and then sends the message. Never send a review request with `send.sh` and never write the request file by hand.
```

- [ ] **Step 8: テストを実行して通ることを確認**

Run:
```bash
bash apps/cmux-team-dispatch-task/test/test-delivery-callsites.sh
bash apps/cmux-team-dispatch-task/test/test-phase-b-delivery.sh
bash apps/cmux-team-dispatch-task/test/test-review-contract-docs.sh
bash apps/cmux-team-dispatch-task/test/test-skill-script-refs.sh
bash apps/cmux-team-dispatch-task/test/test-completion-gate.sh
```
Expected: 5 本すべて exit 0。落ちたテストがあれば、そのテストが固定している旧文面を新文面へ更新する（テストの意図は「依頼手順が存在すること」なので、パスを新しい helper へ読み替える）

- [ ] **Step 9: ドキュメント言語検査**

Run: `pnpm check:doc-lang`
Expected: exit 0

- [ ] **Step 10: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/phase-b-deliver.sh \
        apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/phase-a-review-wait.sh \
        apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh \
        apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/completion-gate.sh \
        apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/unattended/review-block.md \
        apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/unattended/code-review-block.md \
        apps/cmux-team-dispatch-task/test/test-delivery-callsites.sh
git commit -m "fix(dispatch): レビュー依頼を review-request.sh へ一本化する"
```

---

### Task 4: `integration.json` — 親が解決した PR 先を配る

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh`
- Test: `apps/cmux-team-dispatch-task/test/test-integration-config.sh`（新規）

**Interfaces:**
- Consumes: なし
- Produces: `prewarm-panes.sh --integration <pr|merge> [--pr-repo <owner/repo>] [--pr-base <branch>] [--pr-issue <N>]`。副作用として `<status-dir>/integration.json` を必ず書く。スキーマは `integration=pr` のとき `{"integration":"pr","repo":"<owner/repo>","base":"<branch>","head":"feat/<slug>","issue":<N>}`（`issue` は `--pr-issue` が渡ったときのみ）、`integration=merge` のとき `{"integration":"merge"}`

- [ ] **Step 1: 失敗するテストを書く**

`apps/cmux-team-dispatch-task/test/test-integration-config.sh`:

```bash
#!/usr/bin/env bash
# prewarm-panes.sh が書く integration.json の契約。
#
# 守っている不変条件:
#   IC1. --integration pr で {integration,repo,base,head} を書き、head は feat/<slug>
#   IC2. --pr-issue を渡すと issue が入り、渡さないと issue キーごと無い
#   IC3. --integration 省略時 (既定 merge) でも必ずファイルを書く
#        (不在を「merge のことだろう」と推測させない)
#   IC4. --integration pr で --pr-repo / --pr-base が欠けたら起動前に die する
#   IC5. 不正な owner/repo と base は die する (値は子のコマンド文へ埋まる)
#
# このテストは JSON 生成部だけを対象にする。ペイン起動は行わない。

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh"
[[ -f "$BIN" ]] || { echo "FAIL: スクリプトが見つからない: $BIN"; exit 2; }

fail=0
pass() { echo "PASS $1"; }
bad() { echo "FAIL $1"; fail=1; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

# prewarm-panes.sh は起動処理を伴うので、JSON 生成関数だけを切り出して評価する。
# 実装は write_integration_config() を「引数解析の直後・ペイン起動の前」に置くこと。
extract_fn() {
  sed -n '/^write_integration_config() {/,/^}/p' "$BIN"
}
[[ -n "$(extract_fn)" ]] || { echo "FAIL: write_integration_config が無い"; exit 1; }

# 値は位置引数で渡す。eval で "VAR=値" を組み立てる形にすると、IC5 が渡すシェル
# メタ文字入りの値をテスト自身が実行してしまう。
run_fn() { # $1=status-dir $2=slug $3=integration $4=repo $5=base $6=issue
  ( set -uo pipefail
    die() { echo "prewarm: $1" >&2; exit 2; }
    # 本体の依存を最小のスタブで満たす。symlink 検証そのものは既存の prewarm テストが見る。
    validate_publish_destination() { :; }
    STATUS_DIR="$1"; SLUG="$2"
    INTEGRATION="${3:-merge}"; PR_REPO="${4:-}"; PR_BASE="${5:-}"; PR_ISSUE="${6:-}"
    eval "$(extract_fn)"
    write_integration_config )
}

# --- IC1 ---
sd="$TMP/ic1"; mkdir -p "$sd"
run_fn "$sd" login-page pr CyberAgentAI/influencer-platform main
got=$(jq -c '[.integration,.repo,.base,.head]' "$sd/integration.json" 2>/dev/null)
if [[ "$got" == '["pr","CyberAgentAI/influencer-platform","main","feat/login-page"]' ]]; then
  pass "IC1: pr の 4 フィールドと head=feat/<slug>"
else
  bad "IC1: got=$got"
fi

# --- IC2 ---
if jq -e 'has("issue") | not' "$sd/integration.json" >/dev/null; then
  pass "IC2a: --pr-issue 無しなら issue キーが無い"
else
  bad "IC2a: issue キーが混入している"
fi
sd="$TMP/ic2"; mkdir -p "$sd"
run_fn "$sd" fix-auth pr o/r main 117
if [[ "$(jq -r '.issue' "$sd/integration.json")" == 117 ]]; then
  pass "IC2b: --pr-issue が数値で入る"
else
  bad "IC2b: issue=$(jq -c '.issue' "$sd/integration.json")"
fi

# --- IC3 ---
sd="$TMP/ic3"; mkdir -p "$sd"
run_fn "$sd" some-task
if [[ "$(jq -c . "$sd/integration.json" 2>/dev/null)" == '{"integration":"merge"}' ]]; then
  pass "IC3: 既定でも必ず書く"
else
  bad "IC3: got=$(cat "$sd/integration.json" 2>/dev/null)"
fi

# --- IC4 ---
sd="$TMP/ic4"; mkdir -p "$sd"
run_fn "$sd" t pr "" main 2>/dev/null
rc4a=$?
run_fn "$sd" t pr o/r "" 2>/dev/null
rc4b=$?
if [[ $rc4a -eq 2 && $rc4b -eq 2 && ! -e "$sd/integration.json" ]]; then
  pass "IC4: pr で repo/base が欠けたら die しファイルも作らない"
else
  bad "IC4: rc=$rc4a/$rc4b"
fi

# --- IC5 ---
sd="$TMP/ic5"; mkdir -p "$sd"
rc5=0
run_fn "$sd" t pr "o/r; rm -rf /" main 2>/dev/null || rc5=$?
[[ $rc5 -eq 2 ]] || { bad "IC5a: 不正な repo を通した"; }
rc5=0
run_fn "$sd" t pr o/r "ma in" 2>/dev/null || rc5=$?
[[ $rc5 -eq 2 ]] || { bad "IC5b: 不正な base を通した"; }
[[ ! -e "$sd/integration.json" ]] && pass "IC5: 不正な値は die しファイルも作らない" \
  || bad "IC5: ファイルが作られた"

[[ $fail -eq 0 ]] && echo "--- すべて PASS ---" || echo "--- FAIL あり ---"
exit $fail
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `bash apps/cmux-team-dispatch-task/test/test-integration-config.sh`
Expected: `FAIL: write_integration_config が無い` で exit 1

- [ ] **Step 3: `prewarm-panes.sh` にオプションと生成関数を足す**

変数の初期化を、既存の `SLUG=""` の近くへ追加する:

```bash
INTEGRATION=merge; PR_REPO=''; PR_BASE=''; PR_ISSUE=''
```

引数解析の `case` へ 4 つ追加する（`--slug` の分岐の直後）:

```bash
    --integration)
      [[ $# -ge 2 ]] || die "--integration requires pr or merge"
      INTEGRATION="$2"; shift 2 ;;
    --pr-repo)
      [[ $# -ge 2 ]] || die "--pr-repo requires owner/repo"
      PR_REPO="$2"; shift 2 ;;
    --pr-base)
      [[ $# -ge 2 ]] || die "--pr-base requires a branch name"
      PR_BASE="$2"; shift 2 ;;
    --pr-issue)
      [[ $# -ge 2 ]] || die "--pr-issue requires an issue number"
      PR_ISSUE="$2"; shift 2 ;;
```

生成関数を、引数の必須チェック群の直後・ペイン起動より前に置く:

```bash
# PR の作成先は親が解決して status dir へ置く。子 (design ペイン) に remote を選ばせない。
# 2026-09-02 に、remote が 3 つある環境で子が個人フォークへ push し、フォーク内 PR を作った
# (issue は origin 側にあるので Closes も効かない)。値をコマンドライン経由で子へ渡す方式は
# 採らない — 子がフラグを落とせば静かに元の挙動へ戻るためである。
write_integration_config() {
  local tmp
  case "$INTEGRATION" in
    merge|pr) ;;
    *) die "--integration must be pr or merge (got: $INTEGRATION)" ;;
  esac
  if [[ "$INTEGRATION" == pr ]]; then
    [[ -n "$PR_REPO" ]] || die "--pr-repo is required when --integration is pr"
    [[ -n "$PR_BASE" ]] || die "--pr-base is required when --integration is pr"
    # この 2 値は子のプロンプトへ埋まり、その全体が zsh -ic "..." で包まれる。
    # 引用を破れる文字は fail-closed で弾く。
    [[ "$PR_REPO" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] \
      || die "--pr-repo must be owner/repo"
    [[ "$PR_BASE" =~ ^[A-Za-z0-9._/-]+$ ]] || die "--pr-base has invalid characters"
    [[ -z "$PR_ISSUE" || "$PR_ISSUE" =~ ^[0-9]+$ ]] || die "--pr-issue must be a number"
  fi
  mkdir -p "$STATUS_DIR" || die "cannot create status directory at $STATUS_DIR"
  # status dir が symlink に差し替えられていないことを、書く前に既存の検証で確かめる。
  validate_publish_destination
  tmp=$(mktemp "$STATUS_DIR/.integration.json.XXXXXX") \
    || die "cannot create temporary integration artifact"
  if [[ "$INTEGRATION" == pr ]]; then
    jq -n --arg repo "$PR_REPO" --arg base "$PR_BASE" --arg head "feat/$SLUG" \
      --arg issue "$PR_ISSUE" \
      '{integration:"pr", repo:$repo, base:$base, head:$head}
       + (if $issue == "" then {} else {issue: ($issue | tonumber)} end)' > "$tmp" \
      || { rm -f "$tmp"; die "cannot write integration.json"; }
  else
    jq -n '{integration:"merge"}' > "$tmp" \
      || { rm -f "$tmp"; die "cannot write integration.json"; }
  fi
  mv -- "$tmp" "$STATUS_DIR/integration.json" \
    || { rm -f "$tmp"; die "cannot publish $STATUS_DIR/integration.json"; }
}
write_integration_config
```

- [ ] **Step 4: テストを実行して通ることを確認**

Run: `bash apps/cmux-team-dispatch-task/test/test-integration-config.sh`
Expected: IC1〜IC5 がすべて PASS、exit 0

- [ ] **Step 5: 既存の prewarm テストが壊れていないことを確認**

Run:
```bash
for t in apps/cmux-team-dispatch-task/test/test-prewarm-*.sh; do echo "== $t"; bash "$t" || echo "!! FAILED"; done
```
Expected: すべて exit 0。落ちたものは `--status-dir` 配下に増えた `integration.json` を許容するよう更新する

- [ ] **Step 6: SKILL.md と guide-ja.md に親の手順を書く**

`SKILL.md` の `prewarm-panes.sh` 呼び出しを示している箇所へ、integration の引き渡しを追加する。英文:

```markdown
When the integration strategy is PR per task, resolve the target repository from `origin`
once, in the parent, and pass it to every `prewarm-panes.sh` call:

    PR_REPO=$(git remote get-url origin | sed -E 's#(git@github\.com:|https://github\.com/)##; s#\.git$##')
    PR_BASE=$(git symbolic-ref --short HEAD)
    prewarm-panes.sh ... --integration pr --pr-repo "$PR_REPO" --pr-base "$PR_BASE"

Add `--pr-issue <N>` in loop mode. Never let a child pick the remote: measured on
2026-09-02, a child in a three-remote repository pushed to a personal fork and opened the
PR inside that fork, where the issue does not exist. For wait-and-merge, pass
`--integration merge` or omit it.
```

対応する訳を `references/guide-ja.md` の同じ位置へ入れる。

- [ ] **Step 7: ドキュメント言語検査**

Run: `pnpm check:doc-lang`
Expected: exit 0

- [ ] **Step 8: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh \
        apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md \
        apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md \
        apps/cmux-team-dispatch-task/test/test-integration-config.sh
git commit -m "feat(dispatch): PR 作成先を親が解決して integration.json へ配る"
```

---

### Task 5: `record-pr.sh` — PR の実在を確認してから `pr_url` を記録する

**Files:**
- Create: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/record-pr.sh`
- Test: `apps/cmux-team-dispatch-task/test/test-record-pr.sh`

**Interfaces:**
- Consumes: Task 4 の `integration.json`（`repo` / `head` を読む）
- Produces: `record-pr.sh --status-dir <dir>`。`integration.json` の `repo` と `head` を使って `gh pr list --repo <repo> --head <head> --json url --jq '.[0].url'` を実行し、URL があれば `status.json` の `pr_url` へマージする。exit 0 = 記録した / 1 = PR が見つからない・gh 失敗・書き込み失敗 / 2 = 使用法エラー

- [ ] **Step 1: 失敗するテストを書く**

`apps/cmux-team-dispatch-task/test/test-record-pr.sh`:

```bash
#!/usr/bin/env bash
# record-pr.sh の回帰テスト。
#
# 守っている不変条件:
#   RP1. gh が URL を返したら status.json へ pr_url をマージし、既存フィールドを保存する
#   RP2. gh へ --repo と --head を integration.json の値で渡す
#        (--repo が無いと fork 側の PR を拾う。2026-09-02 の F3)
#   RP3. PR が見つからなければ exit 1 で pr_url を書かない
#   RP4. gh が非ゼロなら exit 1 で pr_url を書かない
#   RP5. integration=merge のときは何もせず exit 0 (PR を要求しないモード)
#   RP6. integration.json が無ければ exit 2

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/record-pr.sh"
[[ -f "$BIN" ]] || { echo "FAIL: スクリプトが見つからない: $BIN"; exit 2; }

fail=0
pass() { echo "PASS $1"; }
bad() { echo "FAIL $1"; fail=1; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

BIN_DIR="$TMP/bin"; mkdir -p "$BIN_DIR"
GH_LOG="$TMP/gh.log"
cat > "$BIN_DIR/gh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GH_LOG"
[[ -n "${GH_FAIL:-}" ]] && exit 1
printf '%s' "${GH_URL:-}"
exit 0
STUB
chmod +x "$BIN_DIR/gh"

setup() { # $1=name $2=integration.json の中身
  local d="$TMP/$1"; mkdir -p "$d"
  printf '%s\n' "$2" > "$d/integration.json"
  printf '{"status":"executing","workspace_id":"workspace:5","surface_id":"surface:3"}\n' \
    > "$d/status.json"
  printf '%s' "$d"
}
run() { PATH="$BIN_DIR:$PATH" GH_LOG="$GH_LOG" bash "$BIN" "$@"; }

PRJSON='{"integration":"pr","repo":"CyberAgentAI/influencer-platform","base":"main","head":"feat/fix-auth"}'

# --- RP1 / RP2 ---
d=$(setup rp1 "$PRJSON"); : > "$GH_LOG"
GH_URL='https://github.com/CyberAgentAI/influencer-platform/pull/117' run --status-dir "$d"
rc=$?
url=$(jq -r '.pr_url // empty' "$d/status.json")
ws=$(jq -r '.workspace_id // empty' "$d/status.json")
if [[ $rc -eq 0 && "$url" == 'https://github.com/CyberAgentAI/influencer-platform/pull/117' \
   && "$ws" == 'workspace:5' ]]; then
  pass "RP1: pr_url をマージし既存フィールドを保存する"
else
  bad "RP1: rc=$rc url=[$url] ws=[$ws]"
fi
if grep -q -- '--repo CyberAgentAI/influencer-platform' "$GH_LOG" \
   && grep -q -- '--head feat/fix-auth' "$GH_LOG"; then
  pass "RP2: gh へ --repo と --head を渡す"
else
  bad "RP2: gh の引数: $(cat "$GH_LOG")"
fi

# --- RP3 ---
d=$(setup rp3 "$PRJSON")
GH_URL='' run --status-dir "$d"
rc=$?
if [[ $rc -eq 1 ]] && jq -e '.pr_url | not' "$d/status.json" >/dev/null; then
  pass "RP3: PR 不在なら exit 1 で書かない"
else
  bad "RP3: rc=$rc url=$(jq -c '.pr_url' "$d/status.json")"
fi

# --- RP4 ---
d=$(setup rp4 "$PRJSON")
GH_FAIL=1 run --status-dir "$d"
rc=$?
if [[ $rc -eq 1 ]] && jq -e '.pr_url | not' "$d/status.json" >/dev/null; then
  pass "RP4: gh 失敗なら exit 1 で書かない"
else
  bad "RP4: rc=$rc"
fi

# --- RP5 ---
d=$(setup rp5 '{"integration":"merge"}'); : > "$GH_LOG"
run --status-dir "$d"
rc=$?
if [[ $rc -eq 0 && ! -s "$GH_LOG" ]]; then
  pass "RP5: merge では gh を呼ばず exit 0"
else
  bad "RP5: rc=$rc gh=$(cat "$GH_LOG")"
fi

# --- RP6 ---
d="$TMP/rp6"; mkdir -p "$d"
run --status-dir "$d"
[[ $? -eq 2 ]] && pass "RP6: integration.json 不在は exit 2" || bad "RP6: exit 2 にならない"

[[ $fail -eq 0 ]] && echo "--- すべて PASS ---" || echo "--- FAIL あり ---"
exit $fail
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `bash apps/cmux-team-dispatch-task/test/test-record-pr.sh`
Expected: `FAIL: スクリプトが見つからない` で exit 2

- [ ] **Step 3: `record-pr.sh` を実装**

`apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/record-pr.sh`:

```bash
#!/usr/bin/env bash
# record-pr.sh — PR が正しいリポジトリに実在することを確認してから pr_url を記録する。
#
# 子に URL を自己申告させない。2026-09-02 の実運用では、実装とレビューを終えた子が push も
# gh pr create もせずに done を書き (F2)、別の子は remote が 3 つある環境で個人フォークへ
# PR を作った (F3)。どちらも「PR を作った」という申告だけは正しく見えていた。
#
# 検索先は integration.json (親が dispatch 時に書く) の repo と head であり、子が選べない。
#
# Usage: record-pr.sh --status-dir <dir>
#
# Exit: 0 = 記録した (または integration=merge で対象外) / 1 = PR 不在・gh 失敗・書き込み失敗
#       / 2 = 使用法エラー
set -uo pipefail

die() { echo "record-pr: $1" >&2; exit 2; }
fail() { echo "record-pr: $1" >&2; exit 1; }

STATUS_DIR=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --status-dir) [[ $# -ge 2 ]] || die '--status-dir requires a value'; STATUS_DIR="$2"; shift 2 ;;
    *) die "unknown option: $1" ;;
  esac
done
[[ -n "$STATUS_DIR" && -d "$STATUS_DIR" && ! -L "$STATUS_DIR" ]] \
  || die 'status-dir must be an existing non-symlink directory'
command -v jq >/dev/null 2>&1 || fail 'jq is not installed'

CONFIG="$STATUS_DIR/integration.json"
[[ -f "$CONFIG" && ! -L "$CONFIG" ]] || die "integration.json not found at $CONFIG"
INTEGRATION=$(jq -r '.integration // empty' "$CONFIG" 2>/dev/null) \
  || die 'integration.json is not valid JSON'
case "$INTEGRATION" in
  merge) exit 0 ;;
  pr) ;;
  *) die "integration.json has an unknown integration: ${INTEGRATION:-<empty>}" ;;
esac

REPO=$(jq -r '.repo // empty' "$CONFIG")
HEAD=$(jq -r '.head // empty' "$CONFIG")
[[ -n "$REPO" && -n "$HEAD" ]] || die 'integration.json is missing repo or head'
command -v gh >/dev/null 2>&1 || fail 'gh is not installed'

# --repo を必ず付ける。付けないと gh は現在のディレクトリの remote 設定から推測し、
# fork 側に作られた PR を拾う (2026-09-02 の F3 がまさにその形で成立した)。
URL=$(gh pr list --repo "$REPO" --head "$HEAD" --json url --jq '.[0].url // empty' 2>/dev/null) \
  || fail "gh pr list failed for $REPO ($HEAD)"
[[ -n "$URL" ]] \
  || fail "no pull request for $HEAD on $REPO; push the branch to origin and create the PR with --repo $REPO before recording it"

FILE="$STATUS_DIR/status.json"
BASE='{}'
if [[ -f "$FILE" ]] && jq -e . "$FILE" >/dev/null 2>&1; then
  BASE=$(cat "$FILE")
fi
TMP=$(mktemp "$FILE.XXXXXX") || fail 'mktemp failed'
if printf '%s' "$BASE" | jq --arg u "$URL" '.pr_url = $u' > "$TMP"; then
  mv -- "$TMP" "$FILE" || { rm -f "$TMP"; fail "failed to replace $FILE"; }
else
  rm -f "$TMP"; fail 'failed to compose status json'
fi
echo "record-pr: recorded $URL" >&2
```

- [ ] **Step 4: テストを実行して通ることを確認**

Run: `bash apps/cmux-team-dispatch-task/test/test-record-pr.sh`
Expected: RP1〜RP6 がすべて PASS、exit 0

- [ ] **Step 5: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/record-pr.sh \
        apps/cmux-team-dispatch-task/test/test-record-pr.sh
git commit -m "feat(dispatch): PR の実在を確認して pr_url を記録する record-pr.sh を追加する"
```

---

### Task 6: `phase-b-deliver.sh` に PR プロトコルを埋め込む

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/phase-b-deliver.sh:122`
- Test: `apps/cmux-team-dispatch-task/test/test-phase-b-delivery.sh`（追記）

**Interfaces:**
- Consumes: Task 4 の `integration.json`、Task 5 の `record-pr.sh`
- Produces: `phase-b-exec:` 本文。`integration=pr` のとき push / PR 作成 / `record-pr.sh` の手順が逐語で入る。新しいコマンドラインフラグは増やさない

- [ ] **Step 1: 失敗するテストを書く**

このファイルは PASS を `ok()`、FAIL を `bad()` で出す（`pass` ではない）。送信本文は既存の
`deliver_mixed_body <prewarm.json> <status-dir>` が stdout に返す。まずそのヘルパーの直後へ、
integration.json を先に置ける薄いラッパを足す:

```bash
pb_pr_body() { # $1=ケース名 $2=integration.json の中身 (空文字なら作らない)
  local d="$TMP/$1"
  mkdir -p "$d"
  [[ -z "$2" ]] || printf '%s\n' "$2" > "$d/integration.json"
  deliver_mixed_body "$TMP/prewarm.json" "$d"
}
```

そのうえで集計行の直前へ追記する:

```bash
# PB-PR1: integration=pr のとき、push 先と PR 作成先が本文に逐語で入る。
# 「PR を作れ」だけを指示していた時期に、子が push せず done を書き (F2)、
# 別の子がフォークへ PR を作った (F3)。どちらも 2026-09-02 に実測。
body=$(pb_pr_body pbpr1 '{"integration":"pr","repo":"o/r","base":"main","head":"feat/pbpr1","issue":117}')
pbpr=0
grep -q 'git push -u origin feat/pbpr1' <<<"$body" || { echo "  PB-PR1: push 手順が無い"; pbpr=1; }
grep -q 'gh pr create --repo o/r --base main --head feat/pbpr1' <<<"$body" \
  || { echo "  PB-PR1: PR 作成手順が無い"; pbpr=1; }
grep -q 'Closes #117' <<<"$body" || { echo "  PB-PR1: Closes が無い"; pbpr=1; }
grep -q 'record-pr.sh' <<<"$body" || { echo "  PB-PR1: record-pr.sh の呼び出しが無い"; pbpr=1; }
[[ $pbpr -eq 0 ]] && ok "PB-PR1: pr の手順が逐語で入る" || bad "PB-PR1"

# PB-PR2: issue が無ければ Closes 行を出さない (存在しない issue 番号を捏造させない)。
body=$(pb_pr_body pbpr2 '{"integration":"pr","repo":"o/r","base":"main","head":"feat/pbpr2"}')
grep -q 'Closes #' <<<"$body" && bad "PB-PR2: issue 無しで Closes を出した" \
  || ok "PB-PR2: issue 無しなら Closes を出さない"

# PB-PR3: integration=merge では PR の文言を 1 つも出さない。
body=$(pb_pr_body pbpr3 '{"integration":"merge"}')
grep -qE 'gh pr create|record-pr\.sh' <<<"$body" && bad "PB-PR3: merge で PR 文言が出た" \
  || ok "PB-PR3: merge では PR 文言を出さない"

# PB-PR4: integration.json が無ければ die する。黙って merge 扱いにすると F2 が再発する。
pb_pr_body pbpr4 '' >/dev/null 2>&1
[[ $? -ne 0 ]] && ok "PB-PR4: integration.json 不在で die する" \
  || bad "PB-PR4: 不在を黙って通した"
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `bash apps/cmux-team-dispatch-task/test/test-phase-b-delivery.sh`
Expected: PB-PR1〜PB-PR4 が FAIL

- [ ] **Step 3: `phase-b-deliver.sh` に読み取りと文面生成を足す**

`STATUS_PROTOCOL` の定義（122 行付近）の**直前**へ挿入する:

```bash
# PR の作成先は親が integration.json へ書いている (prewarm-panes.sh)。子に remote を
# 選ばせない。不在なら die する — 黙って merge 扱いにすると、integration=pr のはずの
# タスクが PR 無しで done になる (2026-09-02 の F2)。
INTEGRATION_CONFIG="$STATUS_DIR/integration.json"
[[ -f "$INTEGRATION_CONFIG" && ! -L "$INTEGRATION_CONFIG" ]] \
  || die "integration.json not found at $INTEGRATION_CONFIG"
INTEGRATION_DOC=$(cat "$INTEGRATION_CONFIG") || die 'cannot read integration.json'
jq -e 'type == "object"' >/dev/null 2>&1 <<< "$INTEGRATION_DOC" \
  || die 'integration.json is not a JSON object'
INTEGRATION=$(jq -r '.integration // empty' <<< "$INTEGRATION_DOC")
case "$INTEGRATION" in
  merge|pr) ;;
  *) die "integration.json has an unknown integration: ${INTEGRATION:-<empty>}" ;;
esac

PR_PROTOCOL=""
if [[ "$INTEGRATION" == pr ]]; then
  PR_REPO=$(jq -r '.repo // empty' <<< "$INTEGRATION_DOC")
  PR_BASE=$(jq -r '.base // empty' <<< "$INTEGRATION_DOC")
  PR_HEAD=$(jq -r '.head // empty' <<< "$INTEGRATION_DOC")
  PR_ISSUE=$(jq -r '.issue // empty' <<< "$INTEGRATION_DOC")
  [[ -n "$PR_REPO" && -n "$PR_BASE" && -n "$PR_HEAD" ]] \
    || die 'integration.json is missing repo, base or head'
  PR_CLOSES=""
  [[ -z "$PR_ISSUE" ]] || PR_CLOSES=" The PR body must contain the line Closes #$PR_ISSUE."
  PR_PROTOCOL="MANDATORY PR PROTOCOL: this task integrates as a pull request. After the code review approves, push with exactly git push -u origin $PR_HEAD and create the pull request with exactly gh pr create --repo $PR_REPO --base $PR_BASE --head $PR_HEAD plus your title and body. Never push to any other remote and never omit --repo: this repository may have several remotes, and a PR created anywhere but $PR_REPO is not a deliverable.$PR_CLOSES Then record the URL with one call to bash $SCRIPT_DIR/record-pr.sh --status-dir $STATUS_DIR, which verifies the pull request exists on $PR_REPO before writing pr_url; do not write pr_url by hand. A non-zero exit from that helper means there is no PR on $PR_REPO yet, so fix that instead of reporting done. Run it before the terminal status: report-status.sh refuses done while pr_url is missing. "
fi
```

`REQUEST_TEXT` の組み立てへ差し込む。

変更前:
```bash
REQUEST_TEXT="Read and execute the plan at $PLAN_FILE. ${PARALLEL:+$PARALLEL }$STATUS_PROTOCOL"
```
変更後:
```bash
REQUEST_TEXT="Read and execute the plan at $PLAN_FILE. ${PARALLEL:+$PARALLEL }$PR_PROTOCOL$STATUS_PROTOCOL"
```

- [ ] **Step 4: 既存の配送テストへ `integration.json` を用意する**

Step 3 で `phase-b-deliver.sh` は `integration.json` の不在を die にした。`test-phase-b-delivery.sh` の既存ケースはそれを作っていないので、全ケースが die する。`deliver_mixed_body` の `mkdir -p "$status"` の直後へ 1 行足して、既定を与える:

```bash
  [[ -f "$status/integration.json" ]] || printf '%s\n' '{"integration":"merge"}' > "$status/integration.json"
```

`deliver_mixed_body` を経由せず `bash "$DELIVER"` を直接呼んでいるケースがあれば（`grep -n 'bash "\$DELIVER"' test-phase-b-delivery.sh` で洗い出す）、その `--status-dir` に同じ既定を置く。`pb_pr_body` は先に書き込むので、この既定に上書きされない。

- [ ] **Step 5: テストを実行して通ることを確認**

Run: `bash apps/cmux-team-dispatch-task/test/test-phase-b-delivery.sh`
Expected: PB-PR1〜PB-PR4 を含めすべて PASS、exit 0

- [ ] **Step 6: SKILL.md と guide-ja.md の PR 記述を実装に合わせる**

`SKILL.md:201` の宣言を実態に合わせて書き換える。

変更前:
```markdown
- **PR per task** → child prompts include push + `gh pr create` instructions in the status protocol
```
変更後:
```markdown
- **PR per task** → the parent resolves `origin` once and passes `--integration pr --pr-repo <owner/repo> --pr-base <branch>` to `prewarm-panes.sh`, which writes `<status-dir>/integration.json`. `phase-b-deliver.sh` reads that file and embeds the exact `git push -u origin <head>` and `gh pr create --repo <owner/repo> --base <base> --head <head>` commands into the child's protocol, followed by `record-pr.sh`, which verifies the PR exists on that repository before writing `pr_url`. The child never chooses a remote.
```

`SKILL.md:810` 付近の「The PR-per-task variant also pushes the branch, creates the PR, and records pr_url.」を次に差し替える:

```markdown
The PR-per-task variant pushes the branch to `origin`, creates the PR on the repository
named in `integration.json`, and records `pr_url` through `record-pr.sh`, which fails when
no PR exists there. The wait-and-merge variant leaves the verified branch for the parent to
merge.
```

`references/guide-ja.md` の対応する 2 箇所へ同じ内容の訳を入れる。

- [ ] **Step 7: ドキュメント言語検査**

Run: `pnpm check:doc-lang`
Expected: exit 0

- [ ] **Step 8: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/phase-b-deliver.sh \
        apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md \
        apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md \
        apps/cmux-team-dispatch-task/test/test-phase-b-delivery.sh
git commit -m "feat(dispatch): PR の push 先と作成先を子のプロトコルへ埋め込む"
```

---

### Task 7: `report-status.sh` のガード V1 / V2 / V3

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/report-status.sh`
- Test: `apps/cmux-team-dispatch-task/test/test-report-status.sh`（新規）

**Interfaces:**
- Consumes: Task 4 の `integration.json`、既存の環境変数 `DISPATCH_GATE_ROLE`
- Produces: `report-status.sh <status-dir> <done|error> [message...]` の位置引数契約は不変。`done` のとき V1 / V2 で exit 1、V3 で `status.json` に `result_missing: true` を足す

- [ ] **Step 1: 失敗するテストを書く**

`apps/cmux-team-dispatch-task/test/test-report-status.sh`:

```bash
#!/usr/bin/env bash
# report-status.sh のガード。
#
# 守っている不変条件:
#   RS-G1. integration=pr かつ pr_url 無しの done は exit 1 で status を書かない
#   RS-G2. DISPATCH_GATE_ROLE=design かつ .deferred 存在の done は exit 1
#          (委譲済みタスクの terminal status の所有者は exec である)
#   RS-G3. result.md 不在の done は通すが result_missing: true を残す
#   RS-G4. result.md があれば result_missing を立てない (前回の残骸も消す)
#   RS-G5. error は 3 条件すべてで常に通る (壊れたときの出口を塞がない)
#   RS-G6. integration.json が読めないときは V1 を発動させない (fail-open)
#   RS-G7. 既存フィールド (workspace_id / surface_id / pr_url) を保存する

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/report-status.sh"
[[ -f "$BIN" ]] || { echo "FAIL: スクリプトが見つからない: $BIN"; exit 2; }

fail=0
pass() { echo "PASS $1"; }
bad() { echo "FAIL $1"; fail=1; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

setup() { # $1=name $2=integration.json (空文字なら作らない)
  local d="$TMP/$1"; mkdir -p "$d"
  printf '{"status":"executing","workspace_id":"workspace:5","surface_id":"surface:3"}\n' \
    > "$d/status.json"
  [[ -z "$2" ]] || printf '%s\n' "$2" > "$d/integration.json"
  printf '%s' "$d"
}
PRJSON='{"integration":"pr","repo":"o/r","base":"main","head":"feat/x"}'
st() { jq -r '.status // empty' "$1/status.json"; }

# --- RS-G1 ---
d=$(setup g1 "$PRJSON"); printf 'done\n' > "$d/result.md"
bash "$BIN" "$d" done finished 2>/dev/null
rc=$?
if [[ $rc -eq 1 && "$(st "$d")" == executing ]]; then
  pass "RS-G1: pr で pr_url 無しの done を拒否する"
else
  bad "RS-G1: rc=$rc status=$(st "$d")"
fi

# pr_url があれば通る
jq '.pr_url = "https://github.com/o/r/pull/1"' "$d/status.json" > "$d/t" && mv "$d/t" "$d/status.json"
bash "$BIN" "$d" done finished
if [[ $? -eq 0 && "$(st "$d")" == done ]]; then
  pass "RS-G1b: pr_url があれば done を通す"
else
  bad "RS-G1b: status=$(st "$d")"
fi

# --- RS-G2 ---
d=$(setup g2 '{"integration":"merge"}'); printf 'done\n' > "$d/result.md"; : > "$d/.deferred"
DISPATCH_GATE_ROLE=design bash "$BIN" "$d" done delegated 2>/dev/null
rc=$?
if [[ $rc -eq 1 && "$(st "$d")" == executing ]]; then
  pass "RS-G2: 委譲済み design の done を拒否する"
else
  bad "RS-G2: rc=$rc status=$(st "$d")"
fi
DISPATCH_GATE_ROLE=exec bash "$BIN" "$d" done implemented
if [[ $? -eq 0 && "$(st "$d")" == done ]]; then
  pass "RS-G2b: 同じ状態でも exec の done は通る"
else
  bad "RS-G2b: status=$(st "$d")"
fi

# --- RS-G3 / RS-G4 ---
d=$(setup g3 '{"integration":"merge"}')
bash "$BIN" "$d" done finished
if [[ $? -eq 0 && "$(jq -r '.result_missing' "$d/status.json")" == true ]]; then
  pass "RS-G3: result.md 不在は通すが result_missing を残す"
else
  bad "RS-G3: result_missing=$(jq -c '.result_missing' "$d/status.json")"
fi
printf 'summary\n' > "$d/result.md"
bash "$BIN" "$d" done finished
if jq -e '.result_missing | not' "$d/status.json" >/dev/null; then
  pass "RS-G4: result.md が現れたら result_missing を落とす"
else
  bad "RS-G4: result_missing が残っている"
fi

# --- RS-G5 ---
d=$(setup g5 "$PRJSON"); : > "$d/.deferred"
DISPATCH_GATE_ROLE=design bash "$BIN" "$d" error something broke
if [[ $? -eq 0 && "$(st "$d")" == error ]]; then
  pass "RS-G5: error は常に通る"
else
  bad "RS-G5: status=$(st "$d")"
fi

# --- RS-G6 ---
d=$(setup g6 'not json at all'); printf 'x\n' > "$d/result.md"
bash "$BIN" "$d" done finished
if [[ $? -eq 0 && "$(st "$d")" == done ]]; then
  pass "RS-G6: integration.json が壊れていても done を止めない"
else
  bad "RS-G6: status=$(st "$d")"
fi

# --- RS-G7 ---
d=$(setup g7 '{"integration":"merge"}'); printf 'x\n' > "$d/result.md"
bash "$BIN" "$d" done finished
got=$(jq -c '[.workspace_id,.surface_id]' "$d/status.json")
if [[ "$got" == '["workspace:5","surface:3"]' ]]; then
  pass "RS-G7: 既存フィールドを保存する"
else
  bad "RS-G7: got=$got"
fi

[[ $fail -eq 0 ]] && echo "--- すべて PASS ---" || echo "--- FAIL あり ---"
exit $fail
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `bash apps/cmux-team-dispatch-task/test/test-report-status.sh`
Expected: RS-G1 / RS-G2 / RS-G3 が FAIL（現状は無条件に done を書く）

- [ ] **Step 3: `report-status.sh` にガードを実装**

`FILE="$STATUS_DIR/status.json"` の行の**直前**へ挿入する:

```bash
# --- 終端状態のガード ---
#
# 2026-09-02 の実運用で、完了していないのに done が立つ経路が 2 つ実測された。
#   V1: integration=pr のタスクで、push も PR 作成もせずに done を書いた (issue #79)
#   V2: 委譲を済ませた design ペインが、実装が 1 行も入っていない状態で done を書いた (#78)
# どちらも親が差し戻さなければ、completion-gate が done を見て exec の途中停止を許し、
# 作業が失われていた。
#
# error は決して拒否しない。本当に壊れたときの出口を塞ぐと、子はどこへも行けなくなる。
if [[ "$STATUS" == done ]]; then
  # V2: 委譲済みタスクの terminal status を所有するのは exec であって design ではない。
  if [[ "${DISPATCH_GATE_ROLE:-}" == design && -f "$STATUS_DIR/.deferred" ]]; then
    fail "this task was delegated to the exec role, which owns its terminal status; a design pane must not write done here (use error only when the delegation itself failed)"
  fi
  # V1: PR 統合では PR URL の記録が完了条件である。判定材料は親が書いた integration.json で、
  # 読めないときは発動しない (fail-open)。ガードの誤判定でタスクを永久に終われなくしない。
  _integration=$(jq -r '.integration // empty' "$STATUS_DIR/integration.json" 2>/dev/null || echo "")
  if [[ "$_integration" == pr ]]; then
    _pr=$(jq -r '.pr_url // empty' "$STATUS_DIR/status.json" 2>/dev/null || echo "")
    [[ -n "$_pr" ]] \
      || fail "integration is pr, so recording the PR URL is part of finishing: run record-pr.sh --status-dir $STATUS_DIR first (it verifies the PR exists on the repository this dispatch targets)"
  fi
fi

# V3: result.md が無くても done は通す。書けない事情 (sandbox / ディスク) で完了不能に
# したくないためで、代わりに親が検知できる痕跡を残す。2026-09-02 には「result.md written」
# と報告しながら実ファイルが無いケースが 3 件あった。
RESULT_MISSING=false
if [[ "$STATUS" == done && ! -s "$STATUS_DIR/result.md" ]]; then
  RESULT_MISSING=true
  echo "report-status: warning: $STATUS_DIR/result.md is missing or empty; recording result_missing" >&2
fi
```

`jq` の合成式を変更して `result_missing` を反映する。

変更前:
```bash
if printf '%s' "$BASE" | jq --arg s "$STATUS" --arg m "$MESSAGE" \
     '.status = $s | .message = $m | .timestamp = (now | todate)' > "$TMP"; then
```
変更後:
```bash
if printf '%s' "$BASE" | jq --arg s "$STATUS" --arg m "$MESSAGE" \
     --argjson rm "$RESULT_MISSING" \
     '.status = $s | .message = $m | .timestamp = (now | todate)
      | if $rm then .result_missing = true else del(.result_missing) end' > "$TMP"; then
```

- [ ] **Step 4: テストを実行して通ることを確認**

Run: `bash apps/cmux-team-dispatch-task/test/test-report-status.sh`
Expected: RS-G1〜RS-G7 がすべて PASS、exit 0

- [ ] **Step 5: 既存テストへの影響を確認**

Run:
```bash
bash apps/cmux-team-dispatch-task/test/test-execute-completion.sh
bash apps/cmux-team-dispatch-task/test/test-runner-terminal-status.sh
bash apps/cmux-team-dispatch-task/test/test-runner-signal-exit.sh
bash apps/cmux-team-dispatch-task/test/test-in-session.sh
```
Expected: すべて exit 0。`integration.json` を作っていないケースは V1 が fail-open なので影響しないはず。落ちたものは `.deferred` と `DISPATCH_GATE_ROLE` の組み合わせを見直す

- [ ] **Step 6: SKILL.md と guide-ja.md の状態プロトコルを更新**

`SKILL.md:800-807` の「Every child status protocol includes:」のリストへ 2 項目を足し、`result_missing` を親の再導出材料として書く。英文:

```markdown
    6. `report-status.sh` refuses `done` when `integration.json` says `pr` and
       `status.json` has no `pr_url`, and when a `design` role writes `done` while
       `.deferred` exists. It never refuses `error`.
    7. `done` with a missing or empty `result.md` still writes, but records
       `result_missing: true`.

On every wake, treat a completion notification as a claim, not a fact. Re-derive from
disk: `result_missing: true` means the child reported a result file it did not write, and
for PR integration the PR must exist on the repository named in `integration.json`.
Measured on 2026-09-02: three children reported files that were never written, and one
reported `done` with no branch on the remote at all.
```

`references/guide-ja.md` の対応箇所へ訳を入れる。

- [ ] **Step 7: ドキュメント言語検査**

Run: `pnpm check:doc-lang`
Expected: exit 0

- [ ] **Step 8: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/report-status.sh \
        apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md \
        apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md \
        apps/cmux-team-dispatch-task/test/test-report-status.sh
git commit -m "fix(dispatch): 完了していない done を report-status.sh が拒否する"
```

---

### Task 8: `.wiring` sentinel — 配線中の誤報告を止める

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh`
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/completion-gate.sh:315`
- Test: `apps/cmux-team-dispatch-task/test/test-completion-gate.sh`（追記）
- Test: `apps/cmux-team-dispatch-task/test/test-prewarm-layout.sh`（追記）

**Interfaces:**
- Consumes: なし
- Produces: `<status-dir>/.wiring`。`prewarm-panes.sh` が最初のペイン起動より前に作り、`prewarm.json` の publish 直後および die / rollback 経路で削除する。`completion-gate.sh` は role=design で `prewarm.json` が読めないとき、このファイルがあれば静かに allow する

- [ ] **Step 1: 失敗するテストを書く（gate 側）**

`apps/cmux-team-dispatch-task/test/test-completion-gate.sh` の集計行の直前へ追記:

```bash
# CG-W1: 配線中 (prewarm.json 不在 + .wiring 存在) の design ペインは静かに allow される。
# 2026-09-02 には全 8 タスクでここが block へ倒れ、gate 自身の文面が「親へ報告せよ」と
# 指示したため、誤報告が最多 9 通連続で親のインボックスを埋めた。2 件は .escalated まで書いた。
d=$(mkdir_case cgw1)
printf '{"status":"executing"}\n' > "$d/status.json"   # prewarm.json は意図的に作らない
: > "$d/.wiring"
out=$(bash "$BIN" --status-dir "$d" --role design --agent task-design 2>/dev/null); rc=$?
if [[ $rc -eq 0 && -z "$out" ]]; then
  pass "CG-W1: 配線中の design は静かに allow"
else
  bad "CG-W1: rc=$rc out=[$out]"
fi

# CG-W2: .wiring が無ければ従来どおり block する (本当に壊れた prewarm を見逃さない)。
d=$(mkdir_case cgw2)
printf '{"status":"executing"}\n' > "$d/status.json"
out=$(bash "$BIN" --status-dir "$d" --role design --agent task-design 2>/dev/null)
if grep -q '"decision":"block"' <<<"$out"; then
  pass "CG-W2: .wiring 無しなら従来どおり block"
else
  bad "CG-W2: out=[$out]"
fi
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `bash apps/cmux-team-dispatch-task/test/test-completion-gate.sh`
Expected: `FAIL CG-W1` — block JSON が返っている

- [ ] **Step 3: `completion-gate.sh` に sentinel を見る分岐を足す**

変更前（315 行付近）:
```bash
if [[ "$ROLE" == design ]]; then
  expected_exec_agent >/dev/null || block "the prewarm snapshot at $STATUS_DIR/prewarm.json is missing, unreadable, or has no exec agent. Report this to parent$NOTIFY_HINT and wait; do not write a terminal status."
```
変更後:
```bash
if [[ "$ROLE" == design ]]; then
  # prewarm.json は全ペインの起動と配線が終わってから publish される。それより前に
  # 起動済みペインの Stop hook が発火する区間があり、そこを block へ倒すと、この文面が
  # 「親へ報告せよ」と指示してしまう。2026-09-02 には全 8 タスクで誤報告が発生し、最多で
  # 9 通連続、2 件は .escalated まで書いた。配線中のペインは「タスク到着を待つ idle」で
  # あって停止して良い状態なので、sentinel があるあいだは黙って許す。
  if ! expected_exec_agent >/dev/null; then
    [[ -f "$STATUS_DIR/.wiring" ]] && allow
    block "the prewarm snapshot at $STATUS_DIR/prewarm.json is missing, unreadable, or has no exec agent. Report this to parent$NOTIFY_HINT and wait; do not write a terminal status."
  fi
```

- [ ] **Step 4: テストを実行して通ることを確認**

Run: `bash apps/cmux-team-dispatch-task/test/test-completion-gate.sh`
Expected: CG-W1 / CG-W2 とも PASS、exit 0

- [ ] **Step 5: prewarm 側の失敗するテストを書く**

`apps/cmux-team-dispatch-task/test/test-prewarm-layout.sh` の集計行の直前へ追記。このファイルは
`lib/prewarm-harness.sh` を読み込んでおり、`run_pw <roles-file> [args...]` が 1 回の実行で
`$STATUS`（そのケース専用の status ディレクトリ）を作る。`$ROLES_ON` は review 有効の roles ファイル。
`pass` / `bad` の実名はファイル冒頭を確認して合わせること:

```bash
# PW-W1: .wiring は最初のペイン起動より前に作られ、prewarm.json の publish 後に消える。
# 起動より前であることは、cmux スタブが呼ばれた時点の sentinel 有無で見る。
# (実装は「引数検証の直後・launch_role の前」に touch を置くこと)
run_pw "$ROLES_ON" >/dev/null 2>&1
if [[ -f "$STATUS/prewarm.json" && ! -e "$STATUS/.wiring" ]]; then
  pass "PW-W1a: 正常終了後は prewarm.json があり .wiring は残らない"
else
  bad "PW-W1a: prewarm=$([[ -f $STATUS/prewarm.json ]] && echo yes || echo no) wiring=$([[ -e $STATUS/.wiring ]] && echo yes || echo no)"
fi

# PW-W1b: design ペインの起動に失敗した経路でも sentinel を残さない。
# 残すと completion-gate が「配線中」と読み続け、壊れた prewarm を永久に見逃す。
make_launch_stub design
run_pw "$ROLES_ON" >/dev/null 2>&1
[[ ! -e "$STATUS/.wiring" ]] \
  && pass "PW-W1b: die 経路でも .wiring を残さない" \
  || bad "PW-W1b: .wiring が残っている"
make_launch_stub ''
```

- [ ] **Step 6: `prewarm-panes.sh` に sentinel の作成と削除を足す**

Task 4 で追加した `write_integration_config` の呼び出しの**直後**へ:

```bash
# 配線中であることをディスクへ出す。completion-gate.sh はこれを見て、prewarm.json が
# まだ無い design ペインを黙って停止させる (誤報告の抑止)。publish 後と die/rollback で消す。
mkdir -p "$STATUS_DIR" || die "cannot create status directory at $STATUS_DIR"
WIRING_SENTINEL="$STATUS_DIR/.wiring"
: > "$WIRING_SENTINEL" || die "cannot write $WIRING_SENTINEL"
```

既存の `trap` / rollback ハンドラ（`grep -n 'trap ' scripts/prewarm-panes.sh` で特定）へ削除を足す。ハンドラ本体の先頭に:

```bash
  [[ -z "${WIRING_SENTINEL:-}" ]] || rm -f "$WIRING_SENTINEL"
```

`mv -- "$PREWARM_TMP" "$STATUS_DIR/prewarm.json"` の**直後**（`PREWARM_TMP=""` の次）へ:

```bash
rm -f "$WIRING_SENTINEL"
WIRING_SENTINEL=""
```

- [ ] **Step 7: テストを実行して通ることを確認**

Run:
```bash
bash apps/cmux-team-dispatch-task/test/test-prewarm-layout.sh
bash apps/cmux-team-dispatch-task/test/test-completion-gate.sh
bash apps/cmux-team-dispatch-task/test/test-integration-config.sh
```
Expected: 3 本すべて exit 0

- [ ] **Step 8: SKILL.md と guide-ja.md に sentinel を記載**

`SKILL.md` の prewarm を説明している箇所へ英文で追加:

```markdown
`prewarm-panes.sh` writes `<status-dir>/.wiring` before it launches the first pane and
removes it when `prewarm.json` is published (and on every rollback path). Panes start
before that snapshot exists, and their Stop hooks fire in that window; without the
sentinel the gate tells a design pane to report a missing snapshot to the parent. Measured
on 2026-09-02: all eight tasks produced such reports, one of them nine in a row, and two
panes escalated.
```

`references/guide-ja.md` へ訳を入れる。

- [ ] **Step 9: ドキュメント言語検査**

Run: `pnpm check:doc-lang`
Expected: exit 0

- [ ] **Step 10: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh \
        apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/completion-gate.sh \
        apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md \
        apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md \
        apps/cmux-team-dispatch-task/test/test-completion-gate.sh \
        apps/cmux-team-dispatch-task/test/test-prewarm-layout.sh
git commit -m "fix(dispatch): 配線中の prewarm 不在で誤報告させない"
```

---

### Task 9: `loop-cleanup.sh` — close の追加 / 段階ログ / `--repo`

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/loop-cleanup.sh`
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/loop-mode.md:164-167`
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/loop-mode-ja.md:123`
- Test: `apps/cmux-team-dispatch-task/test/test-loop-cleanup.sh`（追記）

**Interfaces:**
- Consumes: Task 4 の `integration.json`（`repo` を `verify_done` で使う）
- Produces: `loop-cleanup.sh` がタスクごとに `cmux close-surface` / `cmux close-workspace` を呼び、各段階を stderr へ 1 行ずつ出す。出力 JSON のスキーマは変えない

- [ ] **Step 1: 失敗するテストを書く**

`apps/cmux-team-dispatch-task/test/test-loop-cleanup.sh` の集計行の直前へ追記。既存ハーネス（`lib/cleanup-harness.sh`、`CLEANUP_HARNESS_CALLS`）を再利用する:

```bash
# LC-C1: タスクごとに close-surface と close-workspace を呼ぶ。
# ドキュメント (loop-mode.md) は cleanup が閉じると書いていたが、実装は leave.sh だけを
# 呼んでいた。5 分でタイムアウトした 2026-09-02 の batch 2 では、workspace が開いたまま
# 残った。閉じるのが cleanup の責任であることを、ここで実装側に固定する。
# (ハーネスの正常系 1 タスク実行のあとに評価する)
if grep -q "^cmux close-surface .*--workspace " "$CLEANUP_HARNESS_CALLS" \
   && grep -q "^cmux close-workspace " "$CLEANUP_HARNESS_CALLS"; then
  pass "LC-C1: cleanup が surface と workspace を閉じる"
else
  bad "LC-C1: close 呼び出しが無い: $(cat "$CLEANUP_HARNESS_CALLS")"
fi

# LC-C2: 各タスクの段階が stderr に出る。どこまで終わったかが外から分かること。
if grep -qE '^\[step\] ' "$CLEANUP_HARNESS_STDERR"; then
  pass "LC-C2: 段階ログが出る"
else
  bad "LC-C2: 段階ログが無い"
fi

# LC-C3: verify_done の PR 検索に --repo が入る。
# 入っていないと gh は現在の remote 設定から推測し、fork 側の PR を完了の証拠として拾う。
if grep -q 'gh pr list --repo' \
   "$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/loop-cleanup.sh"; then
  pass "LC-C3: verify_done が --repo を渡す"
else
  bad "LC-C3: gh pr list に --repo が無い"
fi
```

ハーネスが stderr を捕まえていない場合は `lib/cleanup-harness.sh` に `CLEANUP_HARNESS_STDERR="$CLEANUP_HARNESS_ROOT/stderr.log"` を足し、実行関数の `2>` をそこへ向ける。

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `bash apps/cmux-team-dispatch-task/test/test-loop-cleanup.sh`
Expected: LC-C1 / LC-C2 / LC-C3 が FAIL

- [ ] **Step 3: `verify_done` に `--repo` を足す**

変更前:
```bash
  if [[ "$INTEGRATION" == pr ]]; then
    local pr; pr=$(jq -r '.pr_url // empty' "$DISPATCH_DIR/$slug/status.json" 2>/dev/null || echo "")
    [[ -n "$pr" ]] && gh pr view "$pr" --json state >/dev/null 2>&1 && return 0
    [[ $(gh pr list --head "feat/$slug" --json url 2>/dev/null | jq length 2>/dev/null || echo 0) -gt 0 ]]
```
変更後:
```bash
  if [[ "$INTEGRATION" == pr ]]; then
    local pr repo; pr=$(jq -r '.pr_url // empty' "$DISPATCH_DIR/$slug/status.json" 2>/dev/null || echo "")
    [[ -n "$pr" ]] && gh pr view "$pr" --json state >/dev/null 2>&1 && return 0
    # --repo は必須である。省くと gh は現在のディレクトリの remote 設定から推測し、
    # 個人フォークに作られた PR を完了の証拠として拾う (2026-09-02 の F3)。
    # 探すべきリポジトリは親が integration.json へ書いている。
    repo=$(jq -r '.repo // empty' "$DISPATCH_DIR/$slug/integration.json" 2>/dev/null || echo "")
    [[ -n "$repo" ]] || { log warn "$slug: integration.json に repo が無いため PR 検証をスキップ"; return 1; }
    [[ $(gh pr list --repo "$repo" --head "feat/$slug" --json url 2>/dev/null | jq length 2>/dev/null || echo 0) -gt 0 ]]
```

- [ ] **Step 4: close と段階ログを足す**

タスクループ内の `if [[ -n "$AGMSG_TEAM" && "$PREWARM_CAN_LEAVE" == yes ]]; then` の**直前**へ挿入する:

```bash
  # surface と workspace を閉じるのは cleanup の責任である。references/loop-mode.md は
  # 以前からそう書いていたが、実装は leave.sh しか呼んでいなかった。閉じる処理が別の
  # ステップにあると、cleanup が途中で中断されたとき workspace だけが開いたまま残る
  # (2026-09-02 の batch 2)。ここへ置くと、タスクごとの後片付けが 1 か所で完結する。
  if [[ "$PREWARM_CAN_LEAVE" == yes ]]; then
    log step "$slug: closing surfaces"
    while IFS= read -r sf; do
      [[ -n "$sf" ]] || continue
      cmux close-surface --workspace "$cleanup_workspace" --surface "$sf" >/dev/null 2>&1 || true
    done < <(jq -r '. as $d | ["design","design_review","exec","exec_review"]
      | map(select($d[.] != null) | $d[.].surface_id) | .[]' <<< "$PREWARM_DOC" \
      | awk 'NF && !seen[$0]++')
    cmux close-workspace --workspace "$cleanup_workspace" >/dev/null 2>&1 || true
  fi
```

`log step` の呼び出しを各段階へ足す。タスクループ内の該当位置へそれぞれ 1 行:

```bash
  log step "$slug: start (status=$status)"
```
（`slug=$(jq ...)` の行の直後）

```bash
  log step "$slug: preserving WIP"
```
（`if [[ "$status" != done ]]; then preserve_wip ...` の直前）

```bash
  log step "$slug: finalize + labels"
```
（`bash "$FETCH" --state-file "$STATE_FILE" finalize ...` の直前）

```bash
  log step "$slug: removing worktree"
```
（`git -C "$REPO_ROOT" worktree remove "$wt" --force` の直前）

```bash
    log step "$slug: leaving team"
```
（`while IFS= read -r agent; do` の直前）

- [ ] **Step 5: テストを実行して通ることを確認**

Run: `bash apps/cmux-team-dispatch-task/test/test-loop-cleanup.sh`
Expected: LC-C1 / LC-C2 / LC-C3 を含めすべて PASS、exit 0

- [ ] **Step 6: 関連テストを確認**

Run:
```bash
bash apps/cmux-team-dispatch-task/test/test-cleanup-close.sh
bash apps/cmux-team-dispatch-task/test/test-snapshot-contract.sh
```
Expected: 2 本とも exit 0。`test-snapshet-contract.sh` は「不正な prewarm では close も leave もしない」を固定しているので、`PREWARM_CAN_LEAVE == yes` のガードを外していないことを確認する

- [ ] **Step 7: `loop-mode.md` を実装に合わせる**

`references/loop-mode.md:164-167` を置き換える。

変更前:
```markdown
Cleanup enumerates and de-duplicates the actual `surface_id` and `agent` values in the
task's sparse `prewarm.json`. Every `close-surface` call includes the task workspace, with
workspace-name lookup as the fallback when `status.json` lacks `workspace_id`. No cleanup
or timeout operation targets a role absent from `prewarm.json`.
```
変更後:
```markdown
Cleanup enumerates and de-duplicates the actual `surface_id` and `agent` values in the
task's sparse `prewarm.json`, then closes those surfaces and the task workspace before
leaving the team — one task's teardown finishes before the next one starts, so an
interrupted cleanup leaves whole tasks done rather than every task half-done. Every
`close-surface` call includes the task workspace, and nothing is closed unless the
snapshot validates and its `workspace_id` matches the workspace found by name. No cleanup
or timeout operation targets a role absent from `prewarm.json`.

`loop-cleanup.sh` logs each task's stage to stderr (`[step] <slug>: ...`), so an
interrupted run shows exactly how far it got. Budget for it: each task makes three to five
`gh` calls plus a worktree removal, so a four-task batch runs for minutes, not seconds.
Raise the Bash tool timeout explicitly before calling it — the default is far too short and
a SIGTERM mid-batch leaves the remaining tasks untouched.
```

`references/loop-mode-ja.md:123` の対応する記述を、同じ内容の訳へ置き換える。

- [ ] **Step 8: ドキュメント言語検査**

Run: `pnpm check:doc-lang`
Expected: exit 0

- [ ] **Step 9: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/loop-cleanup.sh \
        apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/loop-mode.md \
        apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/loop-mode-ja.md \
        apps/cmux-team-dispatch-task/test/test-loop-cleanup.sh \
        apps/cmux-team-dispatch-task/test/lib/cleanup-harness.sh
git commit -m "fix(dispatch): cleanup がタスクごとに workspace を閉じて段階を出す"
```

---

### Task 10: safety timer の再アーム停止分岐 / バージョン同期 / 全体検証

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md:1228-1232`
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md`
- Modify: `apps/cmux-team-dispatch-task/.claude-plugin/plugin.json`
- Modify: `apps/cmux-team-dispatch-task/.codex-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`

**Interfaces:**
- Consumes: Task 1〜9 のすべて
- Produces: バージョン 3.9.0 で一貫したプラグイン定義。F8 の運用分岐がドキュメント化された状態

- [ ] **Step 1: SKILL.md に timer 連続 kill の分岐を書く**

`SKILL.md` の「**Bound the re-arming.**」の段落の**直後**へ英文で追加する:

```markdown
   **Stop re-arming when the timer itself keeps dying.** If the background `sleep` is
   killed before it fires twice in a row — it disappears minutes into a 90-minute wait
   rather than waking you — do not arm a third one. Say plainly in your next report that
   this dispatch is running without a backstop, so a silent child needs the user's eyes,
   and continue monitoring through agmsg messages alone. Measured on 2026-09-02: arms 2
   through 5 were all killed within minutes to half an hour, and the parent ran the rest
   of the batch with no timer. Re-arming a timer that never survives costs a wake each
   time and buys nothing.
```

- [ ] **Step 2: `guide-ja.md` へ訳を入れる**

`references/guide-ja.md` の対応する「再アームの上限」の段落の直後へ:

```markdown
   **timer 自体が死に続けるなら再アームをやめる。** background の `sleep` が発火前に 2 回
   連続で kill されたら（90 分待つはずが数分で消える）、3 回目を張らない。次の報告で
   「この dispatch は backstop 無しで動いている」とはっきり述べ、沈黙した子はユーザーの目が
   要ると伝えたうえで、agmsg のメッセージだけで監視を続ける。2026-09-02 の実測では arm 2〜5
   がすべて数分〜30 分で kill され、親は残りの batch を timer 無しで回した。生き残らない
   timer を張り直すのは、毎回 wake を消費して何も得ない。
```

- [ ] **Step 3: ドキュメント言語検査**

Run: `pnpm check:doc-lang`
Expected: exit 0

- [ ] **Step 4: バージョンを 3.9.0 へ同期**

```bash
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins
jq '.version = "3.9.0"' apps/cmux-team-dispatch-task/.claude-plugin/plugin.json > /tmp/p.json \
  && mv /tmp/p.json apps/cmux-team-dispatch-task/.claude-plugin/plugin.json
jq '.version = "3.9.0"' apps/cmux-team-dispatch-task/.codex-plugin/plugin.json > /tmp/p.json \
  && mv /tmp/p.json apps/cmux-team-dispatch-task/.codex-plugin/plugin.json
jq '(.plugins[] | select(.name == "cmux-team-dispatch-task") | .version) = "3.9.0"' \
  .claude-plugin/marketplace.json > /tmp/m.json && mv /tmp/m.json .claude-plugin/marketplace.json
```

- [ ] **Step 5: 3 箇所が一致することを確認**

Run:
```bash
jq -r '.version' apps/cmux-team-dispatch-task/.claude-plugin/plugin.json
jq -r '.version' apps/cmux-team-dispatch-task/.codex-plugin/plugin.json
jq -r '.plugins[] | select(.name == "cmux-team-dispatch-task") | .version' .claude-plugin/marketplace.json
```
Expected: 3 行とも `3.9.0`

- [ ] **Step 6: テストを全数実行**

Run:
```bash
rc=0
for t in apps/cmux-team-dispatch-task/test/test-*.sh; do
  if bash "$t" >/tmp/out.$$ 2>&1; then echo "OK   $t"; else echo "FAIL $t"; cat /tmp/out.$$; rc=1; fi
done
exit $rc
```
Expected: すべて `OK`。1 つでも FAIL があれば、その原因を直してから次へ進む

- [ ] **Step 7: リポジトリ全体の検査**

Run: `pnpm check`
Expected: exit 0

- [ ] **Step 8: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md \
        apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md \
        apps/cmux-team-dispatch-task/.claude-plugin/plugin.json \
        apps/cmux-team-dispatch-task/.codex-plugin/plugin.json \
        .claude-plugin/marketplace.json
git commit -m "chore(dispatch): timer 連続 kill の分岐を書き v3.9.0 へ上げる"
```

---

## 実装後の確認事項

- `bash install.sh` を実行し、`claude plugin marketplace update yui-cc-plugins` まで通ることを確認する
- 第2弾（F7 / F8）の調査は spec の 9 節に手順がある。本計画の範囲外
