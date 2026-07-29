# dispatch の error / abort 時通知欠落の修正 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 子セッションが `status.json` に終端状態（`done` / `error`）を書けば、セッションが終了しなくても**親への通知が試みられ続ける**ようにする。あわせて実装者が停止するときの手順をプロンプトに定義し、レビュアーの解放経路を用意する（**レビュアー wake は best-effort であり、届くことは保証しない** — spec 3.1・4.6）。

**Architecture:** runner wrapper（`launch-workspace.sh` が heredoc で生成する bash スクリプト）に 2 つの変更を入れる。(1) 子が書いた終端 status を wrapper が上書きしないようにする。(2) 子プロセスと並行して `status.json` を poll するバックグラウンド watcher を走らせ、終端遷移を検知したら親へ通知する。あわせて SKILL.md のプロンプト文面に ABORT/ESCALATION プロトコルを追加し、実装者が停止するときに踏むべき手順を定義する。

**Tech Stack:** bash（runner wrapper）/ zsh（`launch-workspace.sh` 本体）/ jq / markdown（SKILL.md・guide-ja.md・README.md・CLAUDE.md）

**設計ドキュメント:** `docs/superpowers/specs/2026-07-29-dispatch-error-notification-design.md`（以下「spec」と呼ぶ。節番号はこの spec のもの）

## Global Constraints

- ドキュメント・コメント・コミットメッセージは**日本語**、コード（変数名・関数名・CLI フラグ）は**英語**（ルート `CLAUDE.md`「Language convention」）。
- `SKILL.md` / `references/guide-ja.md` / `README.md` / `CLAUDE.md` の 4 ファイルは機能仕様を**完全に一致**させる（`apps/cmux-team-dispatch-task/CLAUDE.md`「ドキュメント整合の絶対ルール」）。
- **`timeout` / `gtimeout` を使ってはならない**。対象 macOS に存在しない（spec 7 章・U5）。
- 新しい通知チャネルを発明しない。既存の 2 チャネル（agmsg `send.sh` による inbox 記録 + `cmux send` / `cmux send-key return` による wake）のみを使う（spec 3 章）。
- `cmux send` の後には**必ず** `cmux send-key ... return` をペアで発行する（`CLAUDE.md` 項目 9）。
- 既存の所有権モデルを壊さない: `.deferred`（実行を他 surface へ移譲した）・`.assigned-<SLUG>`（standby が実装を引き受けた）・timeout sentinel（ループモードで terminal 化済み）。
- 本作業のバージョン: `apps/cmux-team-dispatch-task/.claude-plugin/plugin.json` を `1.10.2` → `1.11.0`、ルート `.claude-plugin/marketplace.json` の該当エントリも `1.11.0`、`apps/cmux-team-dispatch-task/.codex-plugin/plugin.json` を `1.3.0` → `1.4.0`。ルート `.agents/plugins/marketplace.json` は version フィールドが無いので**変更しない**。
- リポジトリルートは `/Users/yui-tanaka/develop/workspace/private/yui-cc-plugins/.worktrees/codex-error-notify-fix`。以下のパスはすべてこのルートからの相対とする。
- **既存の signal 終了ガード（`launch-workspace.sh:778-785`）を変更してはならない**（spec 4.5）。`exit>=128` かつ終端 status のとき status 更新と通知の両方を抑止する挙動は `test/test-runner-signal-exit.sh:97-100` の S1 が守っている。通知可否を marker 比較へ一本化すると、marker が wrapper 起動時に消えるため S1 が失敗する。Task 1 の sticky 化によりガードの status 抑止部分は冗長になるが、そのまま残すこと。
- 略記: `SKILL_DIR` = `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task`

## File Structure

| ファイル | 役割 | 本作業での扱い |
|---|---|---|
| `$SKILL_DIR/scripts/launch-workspace.sh` | runner wrapper を生成する起動スクリプト | 修正（Task 1・2・3・5・6） |
| `apps/cmux-team-dispatch-task/test/test-runner-terminal-status.sh` | 終端 status と watcher の動的回帰テスト | 新規（Task 1、Task 2・3・6 で追記） |
| `apps/cmux-team-dispatch-task/test/test-launch-workspace-codex.sh` | codex 起動の静的検査 | 修正（Task 5） |
| `$SKILL_DIR/SKILL.md` | スキル定義（SoT） | 修正（Task 4・6・7） |
| `$SKILL_DIR/references/unattended/code-review-block.md` | 無人ループ用の確定文面 | 修正（Task 5） |
| `$SKILL_DIR/references/guide-ja.md` | 日本語リファレンス | 修正（Task 9） |
| `apps/cmux-team-dispatch-task/README.md` | 公開ドキュメント | 修正（Task 9） |
| `apps/cmux-team-dispatch-task/CLAUDE.md` | 開発ガイド（退行防止ルール） | 修正（Task 9） |
| `apps/cmux-team-dispatch-task/docs/notification-gaps.md` | 通知欠落パターン一覧 | 新規（Task 8） |
| `apps/cmux-team-dispatch-task/.claude-plugin/plugin.json` ほか | バージョン | 修正（Task 10） |

## タスク順序と依存

全 10 タスク。**Task 1 → 2 → 3 は同じ runner wrapper を順に育てるのでこの順で実行する**（Task 2 は Task 1 の `FINAL_STATUS` を、Task 3 は Task 2 の `notify_parent_once` を使う）。

| Task | 内容 | 依存 |
|---|---|---|
| 1 | 終端 status の sticky 化 | — |
| 2 | 親通知の関数化と通知 claim | 1 |
| 3 | `status.json` watcher | 2 |
| 4 | SKILL.md の ABORT/ESCALATION プロトコル | — |
| 5 | spawn 経路と無人ループ文面の同期 | 4（同じ手順を短縮形で埋め込む） |
| 6 | watcher からのレビュアー wake | 3・4 |
| 7 | `--defer-status` 欠落の修正 | — |
| 8 | `notification-gaps.md` の作成 | — |
| 9 | 4 ファイル整合 | 1〜8（`notification-gaps.md` へリンクするため 8 を含む） |
| 10 | バージョン更新と最終検証 | 1〜9 |

---

### Task 1: 終端 status の sticky 化

子が `status.json` に書いた終端状態を wrapper が上書きしないようにする（spec 4.1）。これを直さないと Task 4 で追加する ABORT プロトコル（`error` を書いてセッションを終了する）が `done` に握り潰される。

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh:787-808`
- Test: `apps/cmux-team-dispatch-task/test/test-runner-terminal-status.sh`（新規作成）

**Interfaces:**
- Consumes: なし（最初のタスク）
- Produces: runner wrapper 内のシェル変数 `FINAL_STATUS`（値は `done` または `error`）。Task 2・3 の watcher と通知処理がこれを参照する。

- [ ] **Step 1: 失敗するテストを書く**

`apps/cmux-team-dispatch-task/test/test-runner-terminal-status.sh` を新規作成する。既存の `test/test-runner-signal-exit.sh` と同じ stub 基盤を使う（静的な文言一致ではなく、生成された runner script を実際に実行する）。

```bash
#!/usr/bin/env bash
# runner wrapper の終端 status 保持と status.json watcher の動的回帰テスト。
#
# 再現するバグ: 子が status.json に error を書いてセッションを終えても、wrapper が
# 「exit 0 なら done」と無条件に上書きしていたため、error が握り潰されて親には
# `status: done` が通知されていた。
#
# 静的な文言一致ではなく、生成された runner script を実際に実行して検証する。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCH="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/launch-workspace.sh"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/repo" "$TMP/zdot"
: > "$TMP/zdot/.zshrc"   # ユーザーの .zshrc を読ませない (zsh -ic の副作用を排除)

git -C "$TMP/repo" init -q
git -C "$TMP/repo" config user.email test@example.invalid
git -C "$TMP/repo" config user.name test
touch "$TMP/repo/.gitkeep"
git -C "$TMP/repo" add .gitkeep
git -C "$TMP/repo" commit -qm init

# cmux stub。
# - cmux-attempts.log: 成否によらず send / send-key の呼び出しを記録する
#   (通知の再試行が止まったことを検証するために使う)
# - cmux-calls.log: 成功した呼び出しだけを記録する
# - $TMP/cmux-fail が存在する間は send / send-key を失敗させる
cat > "$TMP/bin/cmux" <<STUB
#!/usr/bin/env bash
case "\$1" in
  new-workspace) echo 'workspace:1' ;;
  list-pane-surfaces) echo 'surface:2' ;;
  send|send-key)
    echo "\$*" >> "$TMP/cmux-attempts.log"
    if [[ -f "$TMP/cmux-fail" ]]; then exit 1; fi
    echo "\$*" >> "$TMP/cmux-calls.log" ;;
  notify) echo "\$*" >> "$TMP/cmux-calls.log" ;;
  rename-workspace|rename-tab|wait-for|identify|new-split) ;;
  *) echo "unexpected cmux command: \$*" >&2; exit 1 ;;
esac
STUB
chmod +x "$TMP/bin/cmux"

# 終了コードを引数で決める stub runner。
# STUB_WRITE_STATUS が指定されていれば、終了する前に status.json へその値を書き、
# STUB_SLEEP 秒だけ生存し続ける (子が idle 残留する状況の再現)。
cat > "$TMP/bin/stub-agent" <<'STUB'
#!/usr/bin/env bash
if [[ -n "${STUB_WRITE_STATUS:-}" && -n "${STUB_STATUS_DIR:-}" ]]; then
  jq -n --arg s "$STUB_WRITE_STATUS" '{status:$s, message:"child-written"}' \
    > "$STUB_STATUS_DIR/status.json"
fi
[[ -n "${STUB_SLEEP:-}" ]] && sleep "$STUB_SLEEP"
exit "${STUB_EXIT_CODE:-0}"
STUB
chmod +x "$TMP/bin/stub-agent"

cat > "$TMP/runners.json" <<JSON
{
  "default": "stub",
  "runners": [
    { "name": "stub", "command": "$TMP/bin/stub-agent", "engine": "claude" }
  ]
}
JSON

fail=0

assert_eq() {
  local actual="$1" expected="$2" label="$3"
  if [[ "$actual" == "$expected" ]]; then
    echo "PASS: $label"
  else
    echo "FAIL: $label (expected: $expected, got: $actual)"
    fail=1
  fi
}

# 生成された runner script を、子プロセスの終了コードと事前 status を指定して実行する。
# 実行後の status.json と通知ログは $TMP/status-<label> / $TMP/cmux-calls.log に残る。
STATUS_DIR=""
run_case() {
  local label="$1" exit_code="$2" prior_status="$3"
  STATUS_DIR="$TMP/status-$label"
  local name="task-$label"

  rm -rf "$STATUS_DIR" "$TMP/cmux-calls.log" "$TMP/cmux-attempts.log"
  mkdir -p "$STATUS_DIR"
  jq -n --arg s "$prior_status" '{status:$s, message:"child-written"}' > "$STATUS_DIR/status.json"
  touch "$STATUS_DIR/.assigned-$name"

  local output runner
  output=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" bash "$LAUNCH" \
    --cwd "$TMP/repo" --mode standby --runner stub --status-dir "$STATUS_DIR" \
    --parent-notify-workspace 'workspace:9' "$name")
  runner=$(jq -r '.runner_file' <<<"$output")

  ZDOTDIR="$TMP/zdot" STUB_EXIT_CODE="$exit_code" PATH="$TMP/bin:$PATH" \
    bash "$runner" >/dev/null 2>&1 || true
}

status_of()  { jq -r '.status'  "$STATUS_DIR/status.json"; }
message_of() { jq -r '.message' "$STATUS_DIR/status.json"; }
notified_label() {
  grep -oE 'status: (done|error)' "$TMP/cmux-calls.log" 2>/dev/null | tail -1 | sed 's/status: //'
}

# T1: 子が error を書いて正常終了 → error が保持され、親通知も error
run_case error-exit0 0 error
assert_eq "$(status_of)"       'error'         'T1 子が書いた error が done に降格しない'
assert_eq "$(message_of)"      'child-written' 'T1 子が書いた message が保持される'
assert_eq "$(notified_label)"  'error'         'T1 親通知が status: error になる'

# T2: 子が done を書いて正常終了 → done と message が保持される
run_case done-exit0 0 done
assert_eq "$(status_of)"  'done'          'T2 子が書いた done が保持される'
assert_eq "$(message_of)" 'child-written' 'T2 子が書いた message が保持される'

# T3: 子が done を書いた後に非ゼロ終了 → 保守的に error
run_case done-exit1 1 done
assert_eq "$(status_of)" 'error' 'T3 done 宣言後のクラッシュは error 扱い'

# T4: 終端でない status からの正常終了 → 従来どおり done
run_case exec-exit0 0 executing
assert_eq "$(status_of)"      'done' 'T4 executing からの正常終了は done'
assert_eq "$(notified_label)" 'done' 'T4 親通知が status: done になる'

# T5: 終端でない status からの異常終了 → 従来どおり error
run_case exec-exit1 1 executing
assert_eq "$(status_of)" 'error' 'T5 executing からの異常終了は error'

[[ $fail -eq 0 ]] && echo '--- all tests passed ---' || echo '--- failures ---'
exit "$fail"
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
bash apps/cmux-team-dispatch-task/test/test-runner-terminal-status.sh
```

Expected: `FAIL: T1 子が書いた error が done に降格しない (expected: error, got: done)` と `FAIL: T1 親通知が status: error になる (expected: error, got: done)` と `FAIL: T2 子が書いた message が保持される` が出て、終了コード 1。

- [ ] **Step 3: sticky 化を実装する**

`$SKILL_DIR/scripts/launch-workspace.sh` の heredoc 内、以下の**現行ブロック**（`:787-791`）を探す。

```bash
if [[ \$CLAUDE_EXIT -eq 0 ]]; then
  write_status "done" "Claude session completed (exit 0)"
else
  write_status "error" "Claude session exited with code \$CLAUDE_EXIT"
fi
```

これを次に置き換える。

```bash
# 子が書いた終端 status は上書きしない。
# - error: 握り潰すと ABORT プロトコル (status error を書いてセッション終了) が無効化される
# - done + 正常終了: 子が書いた変更サマリを "Claude session completed" で潰さない
# - done + 異常終了: done 宣言後のクラッシュは保守的に error 扱いとして親に調査させる
FINAL_STATUS=""
if [[ "\$PREV_STATUS" == "error" ]]; then
  FINAL_STATUS="error"
  echo "[runner] preserving child-written terminal status 'error'" >&2
elif [[ "\$PREV_STATUS" == "done" && \$CLAUDE_EXIT -eq 0 ]]; then
  FINAL_STATUS="done"
  echo "[runner] preserving child-written terminal status 'done'" >&2
elif [[ \$CLAUDE_EXIT -eq 0 ]]; then
  write_status "done" "Claude session completed (exit 0)"
  FINAL_STATUS="done"
else
  write_status "error" "Claude session exited with code \$CLAUDE_EXIT"
  FINAL_STATUS="error"
fi
```

続いて、同じ heredoc 内の**現行ブロック**（`:805-808`）を探す。

```bash
STATUS_LABEL="done"
if [[ \$CLAUDE_EXIT -ne 0 ]]; then
  STATUS_LABEL="error"
fi
```

これを次に置き換える（親通知のラベルを終了コードではなく確定した status から導出する）。

```bash
STATUS_LABEL="\$FINAL_STATUS"
```

- [ ] **Step 4: テストを実行して通ることを確認する**

```bash
bash apps/cmux-team-dispatch-task/test/test-runner-terminal-status.sh
```

Expected: `--- all tests passed ---`、終了コード 0。

- [ ] **Step 5: 既存の回帰テストが壊れていないことを確認する**

```bash
bash apps/cmux-team-dispatch-task/test/test-runner-signal-exit.sh
bash apps/cmux-team-dispatch-task/test/test-launch-workspace-codex.sh
bash apps/cmux-team-dispatch-task/test/test-launch-workspace-review-config.sh
```

Expected: 3 つとも `--- all tests passed ---`。

- [ ] **Step 6: 構文チェックしてコミットする**

```bash
zsh -n apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh
bash -n apps/cmux-team-dispatch-task/test/test-runner-terminal-status.sh
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh \
        apps/cmux-team-dispatch-task/test/test-runner-terminal-status.sh
git commit -m "fix(cmux-team-dispatch-task): 子が書いた終端 status を wrapper が上書きしないようにする

子が status.json に error を書いてセッションを終えても、wrapper が exit 0 を見て
無条件に done へ上書きしていたため、error が握り潰され親には status: done が
通知されていた。親通知のラベルも終了コード由来から確定 status 由来に変更した。"
```

---

### Task 2: 親通知を関数に切り出し、通知 claim を導入する

Task 3 の watcher と exit パスが**同じ通知処理**を使えるようにする（spec 4.3・4.7「実装上の要点」）。あわせて `.notified-<SLUG>` marker を導入し、内容に「最後に通知に成功した status 文字列」を保持する。

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh`（heredoc 内。関数定義は `write_status()` の直後、通知呼び出しは末尾）
- Test: `apps/cmux-team-dispatch-task/test/test-runner-terminal-status.sh`（Task 1 で作成済み。ケースを追加）

**Interfaces:**
- Consumes: Task 1 の `FINAL_STATUS`
- Produces:
  - `notify_parent <status_label>` — 親へ `[dispatch] task "<SLUG>" finished (status: <status_label>)` を送る。`cmux send` と `cmux send-key return` の**両方**が成功したときだけ 0 を返す。agmsg `send.sh` の失敗は成否に含めない
  - `notify_parent_once <status_label>` — marker の内容が `<status_label>` と同じなら何もせず 0 を返す。異なれば `cmux wait-for --signal <SLUG>-done` を撃ってから `notify_parent` を呼び、成功したときだけ marker に `<status_label>` を書く
  - `$STATUS_DIR/.notified-$SLUG` — 最後に通知に成功した status 文字列（改行なし）
  - シェル変数 `NOTIFIED_FILE` / `NOTIFY_WS` / `NOTIFY_SF` / `LAYOUT_MODE`

- [ ] **Step 1: 失敗するテストを追加する**

`test/test-runner-terminal-status.sh` の T5 の直後（`[[ $fail -eq 0 ]]` の行より前）に次を挿入する。

```bash
marker_of() { cat "$STATUS_DIR/.notified-task-$1" 2>/dev/null || echo '(none)'; }

# T6: 通知に成功したら marker に通知済み status が記録される
run_case marker 0 error
assert_eq "$(marker_of marker)" 'error' 'T6 marker に通知済み status が記録される'

# T7: 通知が失敗したら marker を書かない (次の参加者が再試行できる)
: > "$TMP/cmux-fail"
run_case sendfail 0 error
rm -f "$TMP/cmux-fail"
assert_eq "$(marker_of sendfail)" '(none)' 'T7 通知失敗時は marker を書かない'
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
bash apps/cmux-team-dispatch-task/test/test-runner-terminal-status.sh
```

Expected: `FAIL: T6 marker に通知済み status が記録される (expected: error, got: (none))`。T7 は marker がそもそも存在しないので偶然 PASS するが、T6 が落ちるので終了コードは 1。

- [ ] **Step 3: 通知関数を定義する**

`$SKILL_DIR/scripts/launch-workspace.sh` の heredoc 内、`write_status()` 関数定義の**直後**（現行 `:736` の閉じ括弧の後、`:738` の standby 判定コメントの前）に次を挿入する。

```bash
NOTIFY_WS="${NOTIFY_WORKSPACE}"
NOTIFY_SF="${NOTIFY_SURFACE}"
LAYOUT_MODE="${LAYOUT}"
NOTIFIED_FILE=""
[[ -n "\$STATUS_DIR" ]] && NOTIFIED_FILE="\$STATUS_DIR/.notified-\$SLUG"

# 親へ完了通知を送る。cmux send だけでは親が claude TUI の場合 input box に
# テキストが残って Enter が押されないため、必ず send-key return を続けて発行する。
# agmsg send.sh は inbox 記録専用で idle な親を起こせないため、その失敗は
# 成否に含めない (wake は常に cmux send + send-key return が担う)。
notify_parent() {
  local status_label="\$1"
  local msg="[dispatch] task \\"\$SLUG\\" finished (status: \$status_label)"

  if [[ "\$MESSAGE_TYPE" == "agmsg" ]]; then
    bash "\$AGMSG_SEND" "\$AGMSG_TEAM" "\$AGMSG_FROM" parent "\$msg" 2>/dev/null || \\
      echo "[runner] agmsg record failed (inbox only; wake is cmux send)" >&2
  fi

  local target_flag target_id
  if [[ "\$LAYOUT_MODE" == "split" && -n "\$NOTIFY_SF" ]]; then
    target_flag="--surface"; target_id="\$NOTIFY_SF"
  elif [[ -n "\$NOTIFY_WS" ]]; then
    target_flag="--workspace"; target_id="\$NOTIFY_WS"
  else
    return 1
  fi

  "\$CMUX" send "\$target_flag" "\$target_id" "\$msg" 2>/dev/null || return 1
  "\$CMUX" send-key "\$target_flag" "\$target_id" return 2>/dev/null || return 1
  return 0
}

# 同じ status を二度通知しない。通知に成功したときだけ marker を更新するので、
# 失敗したら次の参加者 (watcher の次の poll、または exit パス) が再試行する。
notify_parent_once() {
  local status_label="\$1" prev=""
  [[ -n "\$NOTIFIED_FILE" && -f "\$NOTIFIED_FILE" ]] && prev=\$(cat "\$NOTIFIED_FILE" 2>/dev/null || echo "")
  [[ "\$prev" == "\$status_label" ]] && return 0
  "\$CMUX" wait-for --signal "\$SLUG-done" 2>/dev/null || true
  notify_parent "\$status_label" || return 1
  [[ -n "\$NOTIFIED_FILE" ]] && printf '%s' "\$status_label" > "\$NOTIFIED_FILE"
  return 0
}
```

- [ ] **Step 4: wrapper 起動時に marker を掃除する**

同じ heredoc 内、`# standby wrapper は起動時に status.json を書かない` のコメント行（現行 `:738`）の**直前**に次を挿入する。

```bash
# この pane の前回実行が残した通知 marker を消す (pane 世代の分離)。
# runner script は pane 起動ごとに 1 回だけ実行されるため、ここで消せば足りる。
if [[ -n "\$STATUS_DIR" ]]; then
  rm -f "\$STATUS_DIR/.notified-\$SLUG" "\$STATUS_DIR/.notified-reviewer-\$SLUG" \\
        "\$STATUS_DIR/.stop-watcher-\$SLUG"
fi
```

- [ ] **Step 5: exit パスの通知を関数呼び出しに置き換える**

同じ heredoc 内、Task 1 で `STATUS_LABEL="\$FINAL_STATUS"` にしたブロックを含む**現行の通知部分全体**（`cmux wait-for --signal` の行から heredoc 末尾の `fi` まで）を探し、次に置き換える。

```bash
if [[ -n "\$NOTIFY_WS" ]]; then
  "\$CMUX" notify --title "Done: \$SLUG" \\
    --body "Exit code: \$CLAUDE_EXIT" \\
    --workspace "\$NOTIFY_WS" 2>/dev/null || true
fi

notify_parent_once "\$FINAL_STATUS" || \\
  echo "[runner] parent notification failed for status '\$FINAL_STATUS'" >&2
```

置き換えで消える現行の行は、`cmux wait-for --signal`（`notify_parent_once` へ移動）、`NOTIFY_WS` / `NOTIFY_SF` / `LAYOUT_MODE` / `STATUS_LABEL` の再定義（Step 3 で上へ移動）、`NOTIFY_MSG` の組み立てと agmsg / send / send-key の 3 ブロック（`notify_parent` へ移動）である。

- [ ] **Step 6: テストを実行して通ることを確認する**

```bash
bash apps/cmux-team-dispatch-task/test/test-runner-terminal-status.sh
bash apps/cmux-team-dispatch-task/test/test-runner-signal-exit.sh
```

Expected: 両方 `--- all tests passed ---`。

- [ ] **Step 7: 構文チェックしてコミットする**

```bash
zsh -n apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh
bash -n apps/cmux-team-dispatch-task/test/test-runner-terminal-status.sh
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh \
        apps/cmux-team-dispatch-task/test/test-runner-terminal-status.sh
git commit -m "refactor(cmux-team-dispatch-task): runner wrapper の親通知を関数化し通知 claim を導入

watcher と exit パスが同じ通知処理を共有できるよう notify_parent /
notify_parent_once を切り出した。marker (.notified-<slug>) は存在の有無ではなく
最後に通知に成功した status 文字列を保持し、通知が失敗したときは marker を
更新しないので次の参加者が再試行できる。"
```

---

### Task 3: `status.json` watcher（本タスクの中核）

子セッションが終端 status を書いても TUI が idle のまま残ると、wrapper は `${CLAUDE_CMD}` の待ちでブロックしたまま通知に到達しない（spec 2.2 H4）。子と並行して `status.json` を poll し、終端遷移を検知した時点で親へ通知する（spec 4.2・4.3）。

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh`（heredoc 内。`${CLAUDE_CMD}` の直前と直後）
- Test: `apps/cmux-team-dispatch-task/test/test-runner-terminal-status.sh`

**Interfaces:**
- Consumes: Task 2 の `notify_parent_once` / `NOTIFIED_FILE`
- Produces:
  - シェル変数 `WATCHER_PID`（watcher のプロセス ID。空文字なら未起動）
  - シェル変数 `WATCH_INTERVAL`（poll 間隔・秒。環境変数 `CMUX_DISPATCH_WATCH_INTERVAL` で上書き可能。既定 15）
  - `$STATUS_DIR/.stop-watcher-$SLUG`（協調停止 sentinel）
  - Task 6 はこの watcher ループ内に `notify_reviewer_once` の呼び出しを足す

- [ ] **Step 1: `run_case` を stub の挙動を指定できる形に差し替える**

`test/test-runner-terminal-status.sh` の既存の `run_case` 定義（`STATUS_DIR=""` の行から関数の閉じ括弧まで）を次に置き換える。

```bash
STATUS_DIR=""
# 環境変数:
#   STUB_WRITE_STATUS / STUB_SLEEP … stub-agent の挙動 (子の idle 残留を再現)
#   EXTRA_SENTINEL                … 起動前に status dir へ作るファイル名
run_case() {
  local label="$1" exit_code="$2" prior_status="$3"
  STATUS_DIR="$TMP/status-$label"
  local name="task-$label"

  rm -rf "$STATUS_DIR" "$TMP/cmux-calls.log" "$TMP/cmux-attempts.log"
  mkdir -p "$STATUS_DIR"
  jq -n --arg s "$prior_status" '{status:$s, message:"child-written"}' > "$STATUS_DIR/status.json"
  touch "$STATUS_DIR/.assigned-$name"
  [[ -n "${EXTRA_SENTINEL:-}" ]] && touch "$STATUS_DIR/$EXTRA_SENTINEL"

  local output runner
  output=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" bash "$LAUNCH" \
    --cwd "$TMP/repo" --mode standby --runner stub --status-dir "$STATUS_DIR" \
    --defer-status --parent-notify-workspace 'workspace:9' "$name")
  runner=$(jq -r '.runner_file' <<<"$output")

  ZDOTDIR="$TMP/zdot" STUB_EXIT_CODE="$exit_code" PATH="$TMP/bin:$PATH" \
    CMUX_DISPATCH_WATCH_INTERVAL=1 STUB_STATUS_DIR="$STATUS_DIR" \
    STUB_WRITE_STATUS="${STUB_WRITE_STATUS:-}" STUB_SLEEP="${STUB_SLEEP:-}" \
    bash "$runner" >/dev/null 2>&1 || true
}
```

- [ ] **Step 2: 失敗するテストを追加する**

T7 の直後（`[[ $fail -eq 0 ]]` の行より前）に次を挿入する。

```bash
attempts() { wc -l < "$TMP/cmux-attempts.log" 2>/dev/null | tr -d ' ' || echo 0; }
log_has()  { grep -q "$1" "$TMP/cmux-calls.log" 2>/dev/null; }
log_count() { grep -c "$1" "$TMP/cmux-calls.log" 2>/dev/null || true; }

# runner を非同期起動する。watcher と exit パスを区別するには、子が生存している
# 間に通知ログを観測しなければならない (同期実行では最後の exit パスの結果しか見えない)。
RUNNER_BG_PID=""
run_case_bg() {
  local label="$1" exit_code="$2" prior_status="$3"
  STATUS_DIR="$TMP/status-$label"
  local name="task-$label"

  [[ -n "${REVIEW_PRESEED:-}" ]] || rm -rf "$STATUS_DIR"
  rm -f "$TMP/cmux-calls.log" "$TMP/cmux-attempts.log"
  mkdir -p "$STATUS_DIR"
  jq -n --arg s "$prior_status" '{status:$s, message:"child-written"}' > "$STATUS_DIR/status.json"
  touch "$STATUS_DIR/.assigned-$name"
  [[ -n "${EXTRA_SENTINEL:-}" ]] && touch "$STATUS_DIR/$EXTRA_SENTINEL"

  local output runner
  output=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" bash "$LAUNCH" \
    --cwd "$TMP/repo" --mode standby --runner stub --status-dir "$STATUS_DIR" \
    --defer-status --parent-notify-workspace 'workspace:9' "$name")
  runner=$(jq -r '.runner_file' <<<"$output")

  ZDOTDIR="$TMP/zdot" STUB_EXIT_CODE="$exit_code" PATH="$TMP/bin:$PATH" \
    CMUX_DISPATCH_WATCH_INTERVAL=1 STUB_STATUS_DIR="$STATUS_DIR" \
    STUB_WRITE_STATUS="${STUB_WRITE_STATUS:-}" STUB_SLEEP="${STUB_SLEEP:-}" \
    bash "$runner" >/dev/null 2>&1 &
  RUNNER_BG_PID=$!
}

# 子がまだ生きているか
child_alive() { kill -0 "$RUNNER_BG_PID" 2>/dev/null; }

# パターンがログに現れるのを最大 <limit> 秒待つ
wait_for_log() {
  local pattern="$1" limit="${2:-10}" i
  for i in $(seq 1 $((limit * 2))); do
    log_has "$pattern" && return 0
    sleep 0.5
  done
  return 1
}

# 子を止め、watcher も stop sentinel で終わらせてから回収する
stop_case() {
  : > "$STATUS_DIR/.stop-watcher-task-$1"
  kill "$RUNNER_BG_PID" 2>/dev/null || true
  wait "$RUNNER_BG_PID" 2>/dev/null || true
  sleep 2   # orphan になった watcher が sentinel を見て終わるのを待つ
}

# T8: 子が error を書いたまま生存している間に watcher が親へ通知する
#     (exit パスではなく watcher が発火したことを、子の生存中に観測して確定させる)
STUB_WRITE_STATUS=error STUB_SLEEP=30 run_case_bg watcher-fires 0 executing
unset STUB_WRITE_STATUS STUB_SLEEP
if wait_for_log 'status: error' 12; then t8_seen=yes; else t8_seen=no; fi
t8_alive=$(child_alive && echo yes || echo no)
stop_case watcher-fires
assert_eq "$t8_seen"  'yes' 'T8 子の生存中に watcher が error を通知する'
assert_eq "$t8_alive" 'yes' 'T8 通知を観測した時点で子はまだ生存している'

# T9: .deferred があれば watcher は生存中に通知しない
EXTRA_SENTINEL=.deferred STUB_WRITE_STATUS=error STUB_SLEEP=30 run_case_bg watcher-deferred 0 executing
unset EXTRA_SENTINEL STUB_WRITE_STATUS STUB_SLEEP
sleep 8
t9_seen=$(log_has 'status: ' && echo yes || echo no)
stop_case watcher-deferred
assert_eq "$t9_seen" 'no' 'T9 .deferred があれば watcher は通知しない'

# T10: 他 pane の .assigned-* があれば watcher は生存中に通知しない
#      (exit パスには foreign-assignment ガードが無いので、観測は生存中に限る)
EXTRA_SENTINEL=.assigned-other-pane STUB_WRITE_STATUS=error STUB_SLEEP=30 run_case_bg watcher-foreign 0 executing
unset EXTRA_SENTINEL STUB_WRITE_STATUS STUB_SLEEP
sleep 8
t10_seen=$(log_has 'status: ' && echo yes || echo no)
stop_case watcher-foreign
assert_eq "$t10_seen" 'no' 'T10 他 pane の .assigned-* があれば watcher は通知しない'

# T11: wrapper 終了後に watcher の再試行が止まる (通知が失敗し続ける状況で確認する)
: > "$TMP/cmux-fail"
STUB_WRITE_STATUS=error STUB_SLEEP=3 run_case_bg watcher-stops 0 executing
unset STUB_WRITE_STATUS STUB_SLEEP
wait "$RUNNER_BG_PID" 2>/dev/null || true
sleep 2
after_exit=$(attempts)
sleep 5
rm -f "$TMP/cmux-fail"
assert_eq "$(attempts)" "$after_exit" 'T11 wrapper 終了後に watcher の再試行が止まる'

# T12: watcher が done を通知した後に子が異常終了 → error の訂正通知が続く
#      (done が先、error が後、という順序まで確認する)
STUB_WRITE_STATUS=done STUB_SLEEP=25 run_case_bg watcher-correction 1 executing
unset STUB_WRITE_STATUS STUB_SLEEP
if wait_for_log 'status: done' 12; then t12_done=yes; else t12_done=no; fi
t12_alive=$(child_alive && echo yes || echo no)
kill "$RUNNER_BG_PID" 2>/dev/null || true   # stub を落とすと wrapper は非ゼロ終了へ進む
wait "$RUNNER_BG_PID" 2>/dev/null || true
sleep 2
assert_eq "$t12_done"  'yes' 'T12 子の生存中に watcher が done を通知する'
assert_eq "$t12_alive" 'yes' 'T12 done 通知の時点で子はまだ生存している'
assert_eq "$(log_has 'status: error' && echo yes || echo no)" 'yes' \
  'T12 その後の異常終了で error の訂正通知が届く'
```

- [ ] **Step 3: テストを実行して失敗を確認する**

```bash
bash apps/cmux-team-dispatch-task/test/test-runner-terminal-status.sh
```

Expected: `FAIL: T8 子の生存中に watcher が error を通知する (expected: yes, got: no)` と `FAIL: T12 子の生存中に watcher が done を通知する`。T9 / T10 / T11 は watcher が存在しないので PASS するが、終了コードは 1。

これらのケースは**子が生存している間**に観測するので、Task 1・2 だけ適用した状態（exit パスは正しく通知する）でも確実に落ちる。同期実行のままでは exit パスの結果しか見えず、実装前から PASS してしまう。

- [ ] **Step 4: watcher を実装する**

`$SKILL_DIR/scripts/launch-workspace.sh` の heredoc 内、`${CLAUDE_CMD}` の行（現行 `:743`）の**直前**に次を挿入する。

```bash
# --- status.json watcher ---
# 子が終端 status を書いても TUI が idle のまま残ると、この wrapper は下の
# 子プロセス待ちでブロックしたまま通知に到達しない。そこで子と並行して
# status.json を poll し、終端遷移を検知した時点で親へ通知する。
# 抑止条件は exit パスの所有権判定と同一。.deferred / .assigned-* は実行中に
# 作られるため poll のたびに再評価する。
# 通知に失敗しても marker を更新しないので、次の poll がそのまま再試行になる。
WATCH_INTERVAL="\${CMUX_DISPATCH_WATCH_INTERVAL:-15}"
WATCHER_PID=""
if [[ -n "\$STATUS_DIR" ]]; then
  (
    while true; do
      # 停止要求への追随を 1 秒以内にするため、待機は 1 秒刻みに分割する。
      # まとめて sleep すると、短時間で終わる子の exit パスが最大 WATCH_INTERVAL 秒
      # 待たされ、既存の回帰テストも同じだけ遅くなる。
      [[ -f "\$STATUS_DIR/.stop-watcher-\$SLUG" ]] && exit 0
      _slept=0
      while (( _slept < WATCH_INTERVAL )); do
        sleep 1
        _slept=\$(( _slept + 1 ))
        [[ -f "\$STATUS_DIR/.stop-watcher-\$SLUG" ]] && exit 0
      done

      [[ -n "\$TIMEOUT_SENTINEL" && -f "\$TIMEOUT_SENTINEL" ]] && continue
      [[ "\$DEFER_STATUS" == "1" && -f "\$STATUS_DIR/.deferred" ]] && continue
      [[ "\$STANDBY" == "1" && ! -f "\$STATUS_DIR/.assigned-\$SLUG" ]] && continue

      # 所有権を他 pane へ渡した (.assigned → .deferred の間の窓)
      if [[ "\$DEFER_STATUS" == "1" ]]; then
        _foreign=0
        for _a in "\$STATUS_DIR"/.assigned-*; do
          [[ -e "\$_a" ]] || continue
          [[ "\$_a" == "\$STATUS_DIR/.assigned-\$SLUG" ]] || _foreign=1
        done
        (( _foreign )) && continue
      fi

      [[ -f "\$STATUS_DIR/status.json" ]] || continue
      _st=\$(jq -r '.status // empty' "\$STATUS_DIR/status.json" 2>/dev/null || echo "")
      [[ "\$_st" == "done" || "\$_st" == "error" ]] || continue

      notify_parent_once "\$_st" || continue
      exit 0
    done
  ) &
  WATCHER_PID=\$!
fi
```

- [ ] **Step 5: 協調停止を実装する**

同じ heredoc 内、`CLAUDE_EXIT=\$?` の行（現行 `:744`）の**直後**に次を挿入する。

```bash
# watcher を協調的に停止する。強制 kill は通知の途中で切れる可能性があるため、
# 先に sentinel を置いて自発的な終了を最大 20 秒待ち、それでも残る場合だけ kill する。
if [[ -n "\$WATCHER_PID" ]]; then
  [[ -n "\$STATUS_DIR" ]] && : > "\$STATUS_DIR/.stop-watcher-\$SLUG"
  for _i in \$(seq 1 20); do
    kill -0 "\$WATCHER_PID" 2>/dev/null || break
    sleep 1
  done
  kill "\$WATCHER_PID" 2>/dev/null || true
  wait "\$WATCHER_PID" 2>/dev/null || true
fi
```

- [ ] **Step 6: テストを実行して通ることを確認する**

```bash
bash apps/cmux-team-dispatch-task/test/test-runner-terminal-status.sh
```

Expected: `--- all tests passed ---`。所要時間は 60 秒前後（stub の sleep と協調停止の待ちのため）。

- [ ] **Step 7: 既存の回帰テストを流す**

```bash
bash apps/cmux-team-dispatch-task/test/test-runner-signal-exit.sh
bash apps/cmux-team-dispatch-task/test/test-launch-workspace-codex.sh
bash apps/cmux-team-dispatch-task/test/test-launch-workspace-review-config.sh
```

Expected: 3 つとも `--- all tests passed ---`。

- [ ] **Step 8: 構文チェックしてコミットする**

```bash
zsh -n apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh
bash -n apps/cmux-team-dispatch-task/test/test-runner-terminal-status.sh
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh \
        apps/cmux-team-dispatch-task/test/test-runner-terminal-status.sh
git commit -m "feat(cmux-team-dispatch-task): status.json watcher で exit に依存しない親通知を追加

子が終端 status を書いても TUI が idle のまま残ると wrapper は子プロセス待ちで
ブロックしたままとなり、完了通知に到達しなかった。子と並行して status.json を
poll し、終端遷移を検知した時点で親へ通知する watcher を追加する。抑止条件は
exit パスの所有権判定 (timeout sentinel / .deferred / 未 assigned standby /
他 pane の .assigned-*) と同一で、poll のたびに再評価する。"
```

---

### Task 4: SKILL.md に ABORT / ESCALATION プロトコルを追加する

実装者（standby ペイン）は task prompt を読んでいないため、`SKILL.md:1185-1187` が明記するとおり status protocol が適用されない。停止するときの通知経路がプロンプト上に存在しないので追加する（spec 5.1・5.2・5.3）。

**Files:**
- Modify: `$SKILL_DIR/SKILL.md`（`{{CODE_REVIEW_BLOCK}}` 内の共通プロトコル a / e、および status protocol の error 分岐 2 箇所）

**Interfaces:**
- Consumes: なし（プロンプト文面のみ）
- Produces: 実装者が停止する際に踏む 5 手順。Task 5 の spawn 経路と Task 9 の guide-ja.md がこの文面と一致している必要がある

- [ ] **Step 1: 共通プロトコル a に ABORT 節を挿入する**

`$SKILL_DIR/SKILL.md` の `After the PR is created (or all changes are merged per the plan), do these` で始まる行（現行 `:1183`）を探し、その**直前**に次を挿入する（インデントは周囲の 12 スペースに合わせる）。

```
            *** ABORT / ESCALATION PROTOCOL — this overrides everything above ***
            If at ANY point you decide to STOP without completing the work — a
            blocking error, a design contradiction, a decision that the plan is
            wrong, or simply giving up — you MUST NOT stop silently. Writing
            <EXISTING_STATUS_DIR>/status.json is NOT a notification: that file is
            polled by the parent only, and the reviewer waiting on you never sees
            it. Before you stop, do ALL of the following, in this order:
              1. Write the reason to
                 <EXISTING_STATUS_DIR>/review/code-round-<current N>.md with the
                 LAST line exactly 'VERDICT: needs_work'. If you never sent a
                 review request, use N=1. This is a record for the parent — the
                 reviewer does not poll this file.
              2. Notify the REVIEWER over both channels. The typed cmux send +
                 send-key return pair is the ONLY thing that actually wakes it:
                   ~/.agents/skills/agmsg/scripts/send.sh <TEAM> <your-agent-name> <task-slug> '[abort] <one-line reason>'
                   /Applications/cmux.app/Contents/Resources/bin/cmux send --surface <REVIEWER_SURFACE> '[abort] <one-line reason>'
                   /Applications/cmux.app/Contents/Resources/bin/cmux send-key --surface <REVIEWER_SURFACE> return
                 Skip only the send.sh line when <TEAM> is empty.
              3. Write status.json with status "error" and the reason as message.
              4. Notify the PARENT over both channels — the same commands as (a)
                 below, but with "status: error".
              5. END THIS SESSION so the runner wrapper can finalize. claude
                 implementers run /exit. codex implementers must END THE CODEX
                 SESSION ITSELF — do NOT run /exit (codex does not act on it).
            *** END ABORT / ESCALATION PROTOCOL ***

```

- [ ] **Step 2: orphan guard（共通プロトコル e）を書き換える**

同じファイルの現行 `:1237-1240`:

```
      e. Orphan guard: if the implementer finishes without ever requesting a review,
         you simply stay idle — that is acceptable. The parent closes all panes at
         the final all-tasks-complete cleanup, and status.json is still owned by the
         implementer's wrapper.
```

これを次に置き換える。

```
      e. Orphan guard: if the implementer COMPLETES its work without ever requesting
         a review, you simply stay idle — that is acceptable. The parent closes all
         panes at the final all-tasks-complete cleanup, and status.json is still
         owned by the implementer's wrapper.
         BUT if you receive an '[abort] ...' message from the implementer, do NOT
         keep waiting. Report the abort reason to the parent over both channels
         (~/.agents/skills/agmsg/scripts/send.sh <TEAM> <task-slug> parent '<reason>'
          + cmux send --workspace <PARENT_WORKSPACE_ID> '<reason>' + send-key return)
         and then exit THIS session.
```

- [ ] **Step 3: status protocol の error 分岐 2 箇所に必須通知を明記する**

同じファイルの現行 `:1394-1395`（Wait and merge）と `:1434-1435`（PR per task）はどちらも次の形をしている。

```
If you encounter a blocking error, run:
  echo '{"status":"error","message":"<error description>","timestamp":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' > <project-root>/.dispatch/<task-slug>/status.json
```

**両方**を次に置き換える。

```
If you encounter a blocking error, run:
  echo '{"status":"error","message":"<error description>","timestamp":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' > <project-root>/.dispatch/<task-slug>/status.json
Writing this file is NOT a notification — it is polled by the parent only. The
completion notification below is MANDATORY on the error path exactly as much as
on the done path. Send it immediately after writing status.json, then end this
session.
```

- [ ] **Step 4: 変更が入ったことを確認する**

```bash
grep -c 'ABORT / ESCALATION PROTOCOL' apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md
grep -c 'Writing this file is NOT a notification' apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md
grep -c "if you receive an '\[abort\] ...' message" apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md
```

Expected: 順に `2`（開始行と終了行）、`2`（error 分岐 2 箇所）、`1`。

- [ ] **Step 5: コミットする**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md
git commit -m "feat(cmux-team-dispatch-task): 実装者の ABORT/ESCALATION プロトコルを追加

実装者は task prompt を読んでいないため status protocol が適用されず、停止する
ときの通知経路がプロンプト上に存在しなかった。停止を決めた時点で踏む 5 手順
(findings 記録 → レビュアー通知 → status.json → 親通知 → セッション終了) を
成功パスより上に追加し、orphan guard に [abort] 受信時の動作を足した。
status protocol の error 分岐 2 箇所にも必須通知を明記した。"
```

---

### Task 5: spawn 経路と無人ループ文面を同期する

prewarm 経路（Task 4）だけ直すと `--mode execute` の spawn 経路に古い挙動が残る。`CLAUDE.md` 項目 21 が扱った「2 経路のうち片方だけ直る」退行と同型なので、両方を同時に直す（spec 5.4・5.5）。

**Files:**
- Modify: `$SKILL_DIR/scripts/launch-workspace.sh:538-573`（`EXIT_INSTRUCTION` / `REVIEW_INSTRUCTION`）
- Modify: `$SKILL_DIR/references/unattended/code-review-block.md`
- Test: `apps/cmux-team-dispatch-task/test/test-launch-workspace-codex.sh`（既存。ケースを追加）

**Interfaces:**
- Consumes: Task 4 の ABORT プロトコルの文面（同じ 5 手順を短縮形で埋め込む）
- Produces: `launch-workspace.sh` 内のシェル変数 `ABORT_INSTRUCTION`

- [ ] **Step 1: 失敗する検査を追加する**

`test/test-launch-workspace-codex.sh` の末尾（結果表示より前）に次を追加する。ケース ID は既存と衝突しない `A1` / `A2` / `A3` を使う。

**inner prompt にクォート文字が入ると壊れる**ため、文言 grep だけでなく「生成された runner を実行したとき、prompt がちょうど 1 引数として渡ること」を検証する。

```bash
# argv を記録する probe runner。inner prompt が単一引数として渡るかを見る
cat > "$TMP/bin/argv-probe" <<'PROBE'
#!/usr/bin/env bash
{ echo "argc=$#"; printf 'arg=%s\n' "$@"; } > "$ARGV_OUT"
PROBE
chmod +x "$TMP/bin/argv-probe"

cat > "$TMP/runners-probe.json" <<JSON
{
  "default": "probe",
  "runners": [
    { "name": "probe", "command": "$TMP/bin/argv-probe", "engine": "claude" }
  ]
}
JSON

echo '# plan' > "$TMP/abort-plan.md"
mkdir -p "$TMP/abort-status/review"
jq -n '{reviewer_surface:"surface:55", reviewer_workspace:"workspace:5", review_dir:"'"$TMP"'/abort-status/review"}' \
  > "$TMP/abort-status/review/code-review.json"

# A1: レビュー有効の spawn 経路で inner prompt に ABORT 手順が入る
a1_out=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners-probe.json" bash "$LAUNCH" \
  --cwd "$TMP/repo" --mode execute --plan-file "$TMP/abort-plan.md" --runner probe \
  --status-dir "$TMP/abort-status" --parent-notify-workspace 'workspace:9' \
  --review-config "$TMP/abort-status/review/code-review.json" abort-with-review 2>/dev/null)
a1_runner=$(jq -r '.runner_file' <<<"$a1_out")
if grep -q 'ABORT PROTOCOL' "$a1_runner" && grep -q 'code-round-N.md' "$a1_runner"; then
  echo "PASS: A1 レビュー有効の spawn 経路に ABORT 手順が入る"
else
  echo "FAIL: A1 レビュー有効の spawn 経路に ABORT 手順が入らない"; fail=1
fi

# A2: inner prompt がちょうど 1 引数として渡る (クォート事故の検出)
ARGV_OUT="$TMP/argv-a2.txt" ZDOTDIR="$TMP/zdot" PATH="$TMP/bin:$PATH" \
  bash "$a1_runner" >/dev/null 2>&1 || true
a2_argc=$(grep -oE 'argc=[0-9]+' "$TMP/argv-a2.txt" 2>/dev/null | head -1 | cut -d= -f2)
if [[ "$a2_argc" == "1" ]]; then
  echo "PASS: A2 inner prompt が単一引数として渡る"
else
  echo "FAIL: A2 inner prompt が単一引数でない (argc=${a2_argc:-none})"; fail=1
fi

# A3: レビュー無効 (--review-config なし) では reviewer 手順を含めない
a3_out=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners-probe.json" bash "$LAUNCH" \
  --cwd "$TMP/repo" --mode execute --plan-file "$TMP/abort-plan.md" --runner probe \
  --status-dir "$TMP/abort-status2" --parent-notify-workspace 'workspace:9' abort-no-review 2>/dev/null)
a3_runner=$(jq -r '.runner_file' <<<"$a3_out")
if grep -q 'ABORT PROTOCOL' "$a3_runner" && ! grep -q 'code-round-N.md' "$a3_runner"; then
  echo "PASS: A3 レビュー無効では reviewer 手順を含めない"
else
  echo "FAIL: A3 レビュー無効なのに reviewer 手順が入っている"; fail=1
fi
```

テスト冒頭に `$TMP/zdot/.zshrc` の用意（`mkdir -p "$TMP/zdot"; : > "$TMP/zdot/.zshrc"`）が無ければ追加する。

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
bash apps/cmux-team-dispatch-task/test/test-launch-workspace-codex.sh
```

Expected: `FAIL: A1 ...` と `FAIL: A3 ...`、終了コード 1。

- [ ] **Step 3: `ABORT_INSTRUCTION` を定義して埋め込む**

`$SKILL_DIR/scripts/launch-workspace.sh` の `if [[ "$MODE" == "execute" ]]; then` ブロック内、`REVIEW_INSTRUCTION` の組み立てが終わった直後（`PROMPT_TEXT=` の行の直前）に次を挿入する。

**クォート文字（シングル・ダブルとも）を文中に一切使ってはならない。** `PROMPT_TEXT` は `CORE_CMD` の中で `'...'` に包まれ、さらに `zsh -ic "..."` に渡されるため（`launch-workspace.sh:610-674`）、クォートが混ざると prompt が複数引数へ分割される。既存の `REVIEW_INSTRUCTION` にも同じ制約がコメントで明記されている（`:546`）。

```bash
  # 途中で停止する場合の通知手順。status.json は親がポーリングするだけのファイルで
  # あり通知ではないため、待っている全員へ明示的に送らせる。
  # REVIEW_INSTRUCTION と同じ制約: 文中にクォート文字を使わないこと。
  ABORT_INSTRUCTION=""
  if [[ -n "$STATUS_DIR" ]]; then
    # reviewer への通知手順はレビューが有効なときだけ入れる (宛先が無いのに
    # 通知を要求すると実装者が実行できない指示になる)
    ABORT_REVIEW_STEP=""
    if [[ -n "$REVIEW_CONFIG" ]]; then
      ABORT_REVIEW_STEP="First write the reason to $REVIEW_DIR/code-round-N.md for the current round N, using N=1 if you never sent a review request, with the LAST line being exactly VERDICT: needs_work; this is only a record because the reviewer does not poll that file. Then wake the reviewer by running: $CMUX send $TARGET_FLAGS -- the message must start with [abort] followed by a one line reason -- and then: $CMUX send-key $TARGET_FLAGS return. Next "
    fi
    ABORT_PARENT_STEP=""
    if [[ -n "$NOTIFY_WORKSPACE" ]]; then
      ABORT_PARENT_STEP="Then notify the parent by running: $CMUX send --workspace $NOTIFY_WORKSPACE -- the message must say: [dispatch] task $WORKSPACE_NAME finished (status: error) -- and then: $CMUX send-key --workspace $NOTIFY_WORKSPACE return. "
    fi
    ABORT_INSTRUCTION="ABORT PROTOCOL, which overrides everything above: if at any point you decide to stop without completing the work, whether from a blocking error, a design contradiction, or simply giving up, you must not stop silently. Writing the status file is not a notification because only the parent polls it. Before you stop: ${ABORT_REVIEW_STEP}write $STATUS_DIR/status.json with status set to error and the reason as the message. ${ABORT_PARENT_STEP}Finally end this session exactly as described below for the successful case. "
  fi
```

続いて `PROMPT_TEXT` の組み立て（現行 `:573`）を次に置き換える。

```bash
  PROMPT_TEXT="Read and execute the plan at $PLAN_FILE. ${REVIEW_INSTRUCTION}${ABORT_INSTRUCTION}${EXIT_INSTRUCTION}"
```

`ABORT_INSTRUCTION` を `EXIT_INSTRUCTION` の**前**に置くのは、末尾の「end this session exactly as described below」が直後の `EXIT_INSTRUCTION`（engine 別の終了指示）を指すようにするためである。

- [ ] **Step 4: 無人ループ用の確定文面を更新する**

`$SKILL_DIR/references/unattended/code-review-block.md` の末尾に次の 1 段落を追記する（既存の文面は変更しない）。

```
If you stop before completing the work, do not stop silently. Write the reason to the round findings file with a last line of `VERDICT: needs_work`, wake the reviewer with `cmux send` followed by `cmux send-key return`, write status `error` with the reason as message, notify the parent the same way, and end the session. Writing the status file alone notifies no one.
```

- [ ] **Step 5: テストを実行して通ることを確認する**

```bash
bash apps/cmux-team-dispatch-task/test/test-launch-workspace-codex.sh
bash apps/cmux-team-dispatch-task/test/test-launch-workspace-review-config.sh
```

Expected: 両方 `--- all tests passed ---`。

- [ ] **Step 6: 構文チェックしてコミットする**

```bash
zsh -n apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh \
        apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/unattended/code-review-block.md \
        apps/cmux-team-dispatch-task/test/test-launch-workspace-codex.sh
git commit -m "feat(cmux-team-dispatch-task): spawn 経路と無人ループ文面にも abort 手順を焼き込む

prewarm 経路の REQUEST_TEXT だけを直すと --mode execute の spawn 経路に古い
挙動が残る (CLAUDE.md 項目 21 と同型の片経路退行)。launch-workspace.sh に
ABORT_INSTRUCTION を追加して inner prompt へ埋め込み、render-loop-prompt.sh が
参照する unattended の確定文面にも同じ手順を追記した。"
```

---

### Task 6: watcher からのレビュアー wake（best-effort）

実装者が ABORT プロトコルを踏まずに `error` だけ書いて止まった場合でも、レビュアーを待機から解放する補助経路を用意する（spec 4.6）。**best-effort であり、届くことを保証しない**。

**Files:**
- Modify: `$SKILL_DIR/scripts/launch-workspace.sh`（heredoc 内。Task 2 の関数群と Task 3 の watcher ループ）
- Modify: `$SKILL_DIR/SKILL.md`（prewarm 経路でも `code-review.json` を書く）
- Test: `apps/cmux-team-dispatch-task/test/test-runner-terminal-status.sh`

**Interfaces:**
- Consumes: Task 2 の `notify_parent` の構造、Task 3 の watcher ループ
- Produces: `notify_reviewer_once <status_label>` — `<STATUS_DIR>/review/code-review.json` が読めて `reviewer_surface` が非空のときだけレビュアーへ `[abort] <message>` を送る。それ以外は**何もせず 0 を返す**（レビュアーが居ない構成が正常系）。marker は `$STATUS_DIR/.notified-reviewer-$SLUG`

- [ ] **Step 1: 失敗するテストを追加する**

`test/test-runner-terminal-status.sh` の T12 の直後に次を挿入する。

まず cmux stub を**宛先ごとに失敗させられる**形に拡張する。stub 定義の `send|send-key)` 分岐を次に差し替える（親宛は成功しつつレビュアー宛だけ失敗させるため）。

```bash
  send|send-key)
    echo "\$*" >> "$TMP/cmux-attempts.log"
    if [[ -f "$TMP/cmux-fail" ]]; then exit 1; fi
    if [[ -f "$TMP/cmux-fail-reviewer" && "\$*" == *"surface:77"* ]]; then exit 1; fi
    echo "\$*" >> "$TMP/cmux-calls.log" ;;
```

`grep -c` は match が無いとき `0` を出力した**うえで終了コード 1 を返す**ため、`|| echo 0` を付けると `0` が 2 行出る。カウント用ヘルパーは `|| true` を使う。

```bash
# grep -c は 0 件でも 0 を出力するので、フォールバックは || true にする
# (|| echo 0 だと 0 が 2 行出て比較が壊れる)
reviewer_msgs() { grep -c '\[abort\]' "$TMP/cmux-calls.log" 2>/dev/null || true; }

seed_review_config() {   # $1 = status dir, $2 = JSON 本体
  mkdir -p "$1/review"
  printf '%s' "$2" > "$1/review/code-review.json"
}

# T13: code-review.json があれば error 時にレビュアーへ [abort] が飛ぶ
STATUS_DIR="$TMP/status-reviewer"; rm -rf "$STATUS_DIR"
seed_review_config "$STATUS_DIR" '{"reviewer_surface":"surface:77","reviewer_workspace":"workspace:7","review_dir":"x"}'
REVIEW_PRESEED=1 STUB_WRITE_STATUS=error STUB_SLEEP=30 run_case_bg reviewer 0 executing
unset REVIEW_PRESEED STUB_WRITE_STATUS STUB_SLEEP
if wait_for_log '\[abort\]' 12; then t13=yes; else t13=no; fi
stop_case reviewer
assert_eq "$t13" 'yes' 'T13 code-review.json があればレビュアーへ [abort] が飛ぶ'

# T14: code-review.json が無ければレビュアー通知はスキップされ、親通知は成功する
STUB_WRITE_STATUS=error STUB_SLEEP=30 run_case_bg no-reviewer 0 executing
unset STUB_WRITE_STATUS STUB_SLEEP
wait_for_log 'status: error' 12 || true
t14_abort=$(reviewer_msgs)
t14_parent=$(log_has 'status: error' && echo yes || echo no)
stop_case no-reviewer
assert_eq "$t14_abort"  '0'   'T14 code-review.json が無ければ [abort] は送らない'
assert_eq "$t14_parent" 'yes' 'T14 レビュアー不在でも親通知は成功する'

# T15: done では [abort] を送らない (abort は error 専用)
STATUS_DIR="$TMP/status-reviewer-done"; rm -rf "$STATUS_DIR"
seed_review_config "$STATUS_DIR" '{"reviewer_surface":"surface:77","reviewer_workspace":"workspace:7","review_dir":"x"}'
REVIEW_PRESEED=1 STUB_WRITE_STATUS=done STUB_SLEEP=30 run_case_bg reviewer-done 0 executing
unset REVIEW_PRESEED STUB_WRITE_STATUS STUB_SLEEP
wait_for_log 'status: done' 12 || true
t15=$(reviewer_msgs)
stop_case reviewer-done
assert_eq "$t15" '0' 'T15 done では [abort] を送らない'

# T16: 壊れた JSON / 空 surface でも親通知は成功する (レビュアー通知はスキップ)
for variant in broken empty; do
  STATUS_DIR="$TMP/status-rv-$variant"; rm -rf "$STATUS_DIR"
  if [[ "$variant" == broken ]]; then
    seed_review_config "$STATUS_DIR" 'this is not json'
  else
    seed_review_config "$STATUS_DIR" '{"reviewer_surface":"","reviewer_workspace":"","review_dir":"x"}'
  fi
  REVIEW_PRESEED=1 STUB_WRITE_STATUS=error STUB_SLEEP=30 run_case_bg "rv-$variant" 0 executing
  unset REVIEW_PRESEED STUB_WRITE_STATUS STUB_SLEEP
  wait_for_log 'status: error' 12 || true
  v_parent=$(log_has 'status: error' && echo yes || echo no)
  v_abort=$(reviewer_msgs)
  stop_case "rv-$variant"
  assert_eq "$v_parent" 'yes' "T16 ($variant) 壊れた/空の config でも親通知は成功する"
  assert_eq "$v_abort"  '0'   "T16 ($variant) 壊れた/空の config では [abort] を送らない"
done

# T17: レビュアー宛だけ失敗させる → 親 marker は確定し、復旧後に [abort] が届く
STATUS_DIR="$TMP/status-rv-retry"; rm -rf "$STATUS_DIR"
seed_review_config "$STATUS_DIR" '{"reviewer_surface":"surface:77","reviewer_workspace":"workspace:7","review_dir":"x"}'
: > "$TMP/cmux-fail-reviewer"
REVIEW_PRESEED=1 STUB_WRITE_STATUS=error STUB_SLEEP=40 run_case_bg rv-retry 0 executing
unset REVIEW_PRESEED STUB_WRITE_STATUS STUB_SLEEP
wait_for_log 'status: error' 12 || true
t17_parent_marker=$(cat "$STATUS_DIR/.notified-task-rv-retry" 2>/dev/null || echo '(none)')
t17_abort_before=$(reviewer_msgs)
rm -f "$TMP/cmux-fail-reviewer"          # transport 復旧
if wait_for_log '\[abort\]' 12; then t17_after=yes; else t17_after=no; fi
stop_case rv-retry
assert_eq "$t17_parent_marker" 'error' 'T17 レビュアー送信が失敗しても親 marker は確定する'
assert_eq "$t17_abort_before"  '0'     'T17 復旧前は [abort] が届いていない'
assert_eq "$t17_after"         'yes'   'T17 復旧後に [abort] が届く'
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
bash apps/cmux-team-dispatch-task/test/test-runner-terminal-status.sh
```

Expected: `FAIL: T13 code-review.json があればレビュアーへ [abort] が飛ぶ (expected: yes, got: no)`。

- [ ] **Step 3: `notify_reviewer_once` を実装する**

`$SKILL_DIR/scripts/launch-workspace.sh` の heredoc 内、Task 2 で定義した `notify_parent_once()` の**直後**に次を挿入する。

```bash
# 実装者が error で止まったとき、待機中のレビュアーを解放する補助経路。
# best-effort — レビュアーが居ない構成 (Phase B-R 無効 / レビューペイン spawn 失敗)
# が正常系なので、config が無い・壊れている場合は何もせず成功扱いにする。
# 親通知とは独立した marker を持ち、失敗しても親通知の claim を妨げない。
notify_reviewer_once() {
  local status_label="\$1"
  [[ "\$status_label" == "error" ]] || return 0
  [[ -n "\$STATUS_DIR" ]] || return 0

  local cfg="\$STATUS_DIR/review/code-review.json"
  [[ -f "\$cfg" ]] || return 0
  local rsurface rworkspace
  rsurface=\$(jq -r '.reviewer_surface // empty' "\$cfg" 2>/dev/null || echo "")
  rworkspace=\$(jq -r '.reviewer_workspace // empty' "\$cfg" 2>/dev/null || echo "")
  [[ -n "\$rsurface" ]] || return 0

  local marker="\$STATUS_DIR/.notified-reviewer-\$SLUG" prev=""
  [[ -f "\$marker" ]] && prev=\$(cat "\$marker" 2>/dev/null || echo "")
  [[ "\$prev" == "\$status_label" ]] && return 0

  local reason=""
  [[ -f "\$STATUS_DIR/status.json" ]] && \\
    reason=\$(jq -r '.message // empty' "\$STATUS_DIR/status.json" 2>/dev/null || echo "")
  local msg="[abort] task \$SLUG stopped with status error: \$reason"

  local ws_args=()
  [[ -n "\$rworkspace" ]] && ws_args=(--workspace "\$rworkspace")
  "\$CMUX" send "\${ws_args[@]}" --surface "\$rsurface" "\$msg" 2>/dev/null || return 1
  "\$CMUX" send-key "\${ws_args[@]}" --surface "\$rsurface" return 2>/dev/null || return 1
  printf '%s' "\$status_label" > "\$marker"
  return 0
}
```

- [ ] **Step 4: watcher ループと exit パスから呼ぶ**

Task 3 の watcher ループ内、`notify_parent_once "\$_st" || continue` の**直後**を次に変更する。

```bash
      notify_parent_once "\$_st" || continue
      # レビュアー wake は best-effort。失敗しても親通知の完了は取り消さない。
      notify_reviewer_once "\$_st" || continue
      exit 0
```

Task 2 で置いた exit パスの通知呼び出しも次に変更する。

```bash
notify_parent_once "\$FINAL_STATUS" || \\
  echo "[runner] parent notification failed for status '\$FINAL_STATUS'" >&2
notify_reviewer_once "\$FINAL_STATUS" || \\
  echo "[runner] reviewer abort notification failed (best-effort)" >&2
```

- [ ] **Step 5: prewarm 経路でも `code-review.json` を書くよう SKILL.md を直す**

`$SKILL_DIR/SKILL.md` の PHASE B-R「共通プロトコル a」の **Placeholder values** 段落（現行 `:1202` 付近）の直後に次を追記する。

```
         Before sending this REQUEST_TEXT, write the reviewer wiring file so the
         implementer's runner wrapper can also wake the reviewer if the
         implementer stops without following the abort protocol:
           mkdir -p "<EXISTING_STATUS_DIR>/review"
           jq -n --arg s "<REVIEWER_SURFACE>" --arg w "<REVIEWER_WORKSPACE>" \
             --arg d "<EXISTING_STATUS_DIR>/review" \
             '{reviewer_surface: $s, reviewer_workspace: $w, review_dir: $d}' \
             > "<EXISTING_STATUS_DIR>/review/code-review.json"
         <REVIEWER_WORKSPACE> is the reviewer pane's workspace ($CMUX_WORKSPACE_ID
         when YOU are the reviewer). The spawn fallback already writes this file;
         this makes the prewarm path write it too.
```

- [ ] **Step 6: テストを実行して通ることを確認する**

```bash
bash apps/cmux-team-dispatch-task/test/test-runner-terminal-status.sh
bash apps/cmux-team-dispatch-task/test/test-runner-signal-exit.sh
```

Expected: 両方 `--- all tests passed ---`。

- [ ] **Step 7: 構文チェックしてコミットする**

```bash
zsh -n apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh
bash -n apps/cmux-team-dispatch-task/test/test-runner-terminal-status.sh
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh \
        apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md \
        apps/cmux-team-dispatch-task/test/test-runner-terminal-status.sh
git commit -m "feat(cmux-team-dispatch-task): 実装者が error で止まったときのレビュアー解放を追加

実装者が abort プロトコルを踏まずに error だけ書いて止まると、レビュアーは
待機したまま残っていた。watcher が code-review.json を読んでレビュアー surface へ
[abort] を送る補助経路を追加し、prewarm 経路でも code-review.json を書くようにした。
親通知とは独立した marker を持ち、レビュアー不在や送信失敗が親通知を妨げない
best-effort の経路である。"
```

---

### Task 7: workspace レイアウト起動の `--defer-status` 欠落を直す

`SKILL.md:809` は「Child session は `--defer-status` で起動されている」と書いているが、workspace レイアウトの起動例（`SKILL.md:1464-1474`）はこのフラグを渡していない（既定は `launch-workspace.sh:136` の `DEFER_STATUS=0`）。Child が `.deferred` を作って exit しても自分の wrapper が `status.json` を上書きしてしまう。watcher とは無関係に**現行でも存在する不整合**であり、Task 3 の foreign `.assigned-*` 抑止の前提でもある（spec 4.4）。

**Files:**
- Modify: `$SKILL_DIR/SKILL.md`（`### Launch: Workspace Mode (default)` 節の起動例）

**Interfaces:**
- Consumes: なし
- Produces: なし（起動フラグの修正のみ）。Task 9 が guide-ja.md / README.md の対応する起動例へ同じフラグを反映する

- [ ] **Step 1: 現状を確認する**

Task 4・6 で SKILL.md 前半に行が増えているため、**固定行番号ではなく構造で探す**。

```bash
grep -n '^### Launch: Workspace Mode' apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md
awk '/^### Launch: Workspace Mode/,/^### Pre-warm Standby Panes/' \
  apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md | grep -c -- '--defer-status'
```

Expected: 見出しの行番号が表示され、`--defer-status` の出現数は `0`。

- [ ] **Step 2: 起動例にフラグを追加する**

`bash <this-skill-dir>/scripts/launch-workspace.sh \` で始まる workspace モードの起動例の `--status-dir` 行の直後に次の 1 行を挿入する。

```
  --defer-status \
```

同じブロックの下にある説明文の末尾に次を追記する。

```
`--defer-status` は必須である。Phase B で実行を別 surface へ移譲したとき、Child の
runner wrapper が `.deferred` を見て `status.json` の上書きをスキップするために使う。
これを省くと Child の wrapper が孫の書いた終端状態を踏み潰す。
```

- [ ] **Step 3: 反映を確認する**

```bash
awk '/^### Launch: Workspace Mode/,/^### Pre-warm Standby Panes/' \
  apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md | grep -c -- '--defer-status'
```

Expected: `1` 以上。

- [ ] **Step 4: コミットする**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md
git commit -m "fix(cmux-team-dispatch-task): workspace レイアウト起動の --defer-status 欠落を修正

SKILL.md は Child が --defer-status 付きで起動される前提で書かれているが、
workspace レイアウトの起動例だけフラグが抜けており、Child が .deferred を作って
exit しても自分の wrapper が status.json を上書きしていた。"
```

---

### Task 8: 派生パターン一覧 `notification-gaps.md` を作成する

タスクの成果物 2（通知欠落／無限待機パターンの網羅的な洗い出し）。spec 2.2・2.3・8 章の内容を根拠付きで 1 枚にまとめる（spec 6.1）。

**Files:**
- Create: `apps/cmux-team-dispatch-task/docs/notification-gaps.md`

**Interfaces:**
- Consumes: なし
- Produces: Task 9 の `CLAUDE.md` がこのファイルへリンクする

- [ ] **Step 1: ファイルを作成する**

`apps/cmux-team-dispatch-task/docs/notification-gaps.md` を次の内容で新規作成する。

````markdown
# 通知欠落・無限待機パターン一覧

dispatch では「誰かが待っていて、誰かが知らせる」構造が何箇所にもある。知らせる側の経路が
存在しない、あるいは待つ側が終了条件に到達し得ない箇所を洗い出したもの。

調査基準バージョン: v1.10.2（`origin/main` = `2cafd40`）。設計は
`docs/superpowers/specs/2026-07-29-dispatch-error-notification-design.md`。

行番号は調査時点のものなので、参照する際は前後の文脈で確認すること。

## 修正したパターン

| ID | 症状 | 根拠 | 影響 | 対応 |
|---|---|---|---|---|
| P1 | 実装者（standby）に error 経路の通知手段が構造的に存在しない | `SKILL.md:1183` の完了通知は「PR 作成後」にしかない。`:1185-1187` が「standby は task prompt を読んでいないので他の status protocol は適用されない」と明記 | 実装者が停止すると親もレビュアーも無期限に待つ（**実際に発生した事象**） | 修正: 共通プロトコル a に ABORT/ESCALATION プロトコルを追加 |
| P2 | 子が終端 status を書いても TUI が idle 残留すると通知に到達しない | `launch-workspace.sh:743-744` で wrapper は子プロセス待ちにブロックする | 通知経路が 1 本もない | 修正: `status.json` watcher を追加（exit に依存しない発火） |
| P3 | runner wrapper が子の書いた `error` を `done` に上書きする | `launch-workspace.sh:787-791` が `PREV_STATUS` を見ずに `exit 0` → `done` を書く。親通知のラベルも `:805-808` で終了コード由来 | abort プロトコル自体が無効化される。`error` が握り潰され親には `done` が届く | 修正: 終端 status の sticky 化 |
| P4 | レビュアーの orphan guard が実装者 error 時に永久 idle になる | `SKILL.md:1237-1240`「you simply stay idle — that is acceptable」 | レビュアーが最終クリーンアップまで解放されない | 修正: `[abort]` 受信時の動作を追加＋ watcher からの補助 wake |
| P5 | status protocol の error 分岐に通知指示が無い | `SKILL.md:1394-1395` / `:1434-1435` | agmsg ブロックの記述に暗黙依存していた | 修正: error 分岐を自己完結させた |
| P6 | 無人ループ用の確定文面に abort 経路が無い | `references/unattended/code-review-block.md` | ループモードでは abort プロトコルが存在しない | 修正: 文面を追記 |
| P7 | workspace レイアウト起動に `--defer-status` が無い | `SKILL.md:1464-1474` の起動例、既定値は `launch-workspace.sh:136` | Child の wrapper が孫の書いた終端状態を踏み潰す | 修正: 起動例にフラグを追加 |
| P8 | `.assigned` → `.deferred` の窓で設計 pane と実装 pane が二重に通知し得る | `SKILL.md:740-802`, `:1275-1336`, `:837-871` の手順順序 | watcher 導入で顕在化する | 修正: 他 pane の `.assigned-*` がある間は watcher を抑止 |

## 未解決として記録するパターン

いずれも「現行と同じかそれ以上に悪くはならない」ため、今回は修正せず記録に留める。

| ID | 症状 | 根拠 | 判断理由 |
|---|---|---|---|
| U1 | 実装者が `status.json` すら書かず沈黙する | `SKILL.md:1153-1172` と `:1221-1240` | terminal 遷移が無いので watcher も発火できない。検知には deadline が必要で、それを持つのはループモードの `batch-wait.sh --timeout-min` だけ。**通常 dispatch では親もレビュアーも無期限に待つ**。15 分 stall 判定は実装者 → レビュアー方向にしか存在しない |
| U2 | handoff 失敗時の所有権移譲 | `SKILL.md:751-774` ほか | `cmux send` の終了コードは配信の有無を一意に示さない。agmsg 記録は `cmux send` より**先**に行われるため「送信失敗＝何も届いていない」とも言えない。安全な rollback 条件を定義できないので Phase B の手順は現行のまま |
| U3 | spawn フォールバックの起動確認 | `launch-workspace.sh:865-881`, `:90` | `new-workspace --command` が runner を起動した**後**に rename / surface 取得 / status 生成が失敗し得るため、非ゼロ終了は「未起動」を意味しない。runner 側の起動 acknowledgement が必要 |
| U4 | 部分配信（`send` 成功・`send-key` 失敗）による input box での文面連結 | `launch-workspace.sh:817-825` | 現行も 1 回きりの `\|\| true` で同じ問題を持つ。安全な回復には「相手の input box を壊さずに outcome 不明を解消する cmux 操作」が必要で、それは cmux 側の機能 |
| U5 | `cmux` コマンドの hang | — | 対象 macOS に `timeout` / `gtimeout` が無い。`perl -e alarm` 等の代替は可能だが、外部依存を増やす割に現行より改善しない |
| U6 | dispatch 世代の排他（旧 wrapper 生存・stale PID 再利用） | — | `kill -0` による PID 検査は TOCTOU と PID 再利用に耐えない。正しくは親側の排他 lock と generation token が必要。通常は最終 cleanup が `.dispatch` を消すため発生頻度は低い |
| U7 | agmsg `send.sh` 失敗時のリトライ | `SKILL.md:1803-1810` | agmsg push は inbox 記録専用で idle セッションを起こせない。wake は `cmux send` が担うため、記録の失敗は警告ログに留める |
| U8 | 終端状態を書いた直後・最初の poll 前に signal 終了すると、この wrapper からは通知されない | `launch-workspace.sh:778-785`, `test/test-runner-signal-exit.sh:97-100` | signal ガードの通知抑止は既存の回帰テストが守っている挙動（クリーンアップ時の重複通知を防ぐ）。窓は最大 15 秒で、現行と同じ挙動 |

## この一覧の使い方

- 通知が届かない事象を調査するときは、まず P1〜P8 が退行していないかを確認する。回帰テストは
  `test/test-runner-terminal-status.sh` と `test/test-runner-signal-exit.sh`
- U1〜U8 に該当する事象は既知である。再発見して同じ調査を繰り返さないこと
- 新しいパターンを見つけたら、根拠となる `file:line` を添えてこの表に追記する
````

- [ ] **Step 2: コミットする**

```bash
git add apps/cmux-team-dispatch-task/docs/notification-gaps.md
git commit -m "docs(cmux-team-dispatch-task): 通知欠落・無限待機パターンの一覧を追加

修正した 8 パターンと、現行より悪化しないため記録に留める 8 パターンを
根拠となる file:line 付きでまとめた。"
```

---

### Task 9: 4 ファイル整合（guide-ja.md / README.md / CLAUDE.md）

`CLAUDE.md`「ドキュメント整合の絶対ルール」に従い、SKILL.md の変更を残り 3 ファイルへ反映する（spec 6.2）。

**Files:**
- Modify: `$SKILL_DIR/references/guide-ja.md`
- Modify: `apps/cmux-team-dispatch-task/README.md`
- Modify: `apps/cmux-team-dispatch-task/CLAUDE.md`

**Interfaces:**
- Consumes: Task 1〜7 の全変更と、Task 8 が作る `docs/notification-gaps.md`（CLAUDE.md からリンクする）
- Produces: なし

- [ ] **Step 1: guide-ja.md を更新する**

`grep -n 'status.json' apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md` で status protocol の説明箇所（`:187` 付近と `:760` / `:836` 付近）を特定し、次の 3 点を反映する。

1. runner wrapper が子の書いた終端 status を上書きしないこと（Task 1 の表をそのまま日本語で記載）
2. `status.json` watcher の存在・poll 間隔 15 秒・4 つの抑止条件・`.notified-<slug>` marker が通知済み status を保持すること（Task 2・3）
3. 実装者の ABORT/ESCALATION プロトコル 5 手順と、レビュアーが `[abort]` を受けたら待機を打ち切ること（Task 4・6）

- [ ] **Step 2: README.md を更新する**

完了通知を説明している節に次を追記する。

```
完了通知は `status.json` の終端遷移で発火する。子セッションが `done` / `error` を
書けば、セッションが終了しなくても runner wrapper の watcher が親へ通知する
（15 秒間隔で監視）。`error` でも `done` と同じ経路で通知が飛ぶ。

ただし子が `status.json` を書かないまま沈黙した場合は検知できない。既知の限界は
`docs/notification-gaps.md` にまとめてある。
```

- [ ] **Step 3: CLAUDE.md のファイル構成表に docs を追加する**

`| \`CLAUDE.md\` | この開発ガイド |` の行の**直前**に次を挿入する。

```
| `docs/notification-gaps.md` | 通知欠落・無限待機パターンの一覧（修正済み / 未解決） |
```

- [ ] **Step 4: CLAUDE.md に退行防止ルール 23 を追加する**

番号付きルールの末尾（現在は 22）の直後に次を追加する。

```
23. **error パスの通知**が SKILL.md / guide-ja.md / README.md / CLAUDE.md の 4 ファイルで一致しているか確認:
    - runner wrapper が**子の書いた終端 status を上書きしない**こと（`PREV_STATUS` が `error` なら常に保持、`done` は正常終了時のみ保持、`done` + 非ゼロ終了は保守的に `error`）。親通知のラベルは終了コードではなく確定 status から導出すること
    - `status.json` watcher が `${CLAUDE_CMD}` と並行して走り、15 秒間隔（`CMUX_DISPATCH_WATCH_INTERVAL` で上書き可）で終端遷移を検知して通知すること。抑止条件は exit パスと同一（timeout sentinel / `.deferred` / 未 assigned standby / **他 pane の `.assigned-*`**）で、poll のたびに再評価すること
    - 通知処理は `notify_parent()` / `notify_parent_once()` に一本化し、watcher と exit パスの**両方が同じ関数を呼ぶ**こと（片方だけ直す退行を防ぐ）。marker `.notified-<slug>` は存在の有無ではなく**通知済み status 文字列**を保持し、通知が成功したときだけ更新すること
    - 実装者の **ABORT/ESCALATION プロトコル**（findings 記録 → レビュアー通知 → status.json → 親通知 → セッション終了）が prewarm 経路（SKILL.md の共通プロトコル a）と spawn 経路（`launch-workspace.sh` の `ABORT_INSTRUCTION`）の**両方**に入っていること。`references/unattended/code-review-block.md` にも同じ手順があること
    - workspace レイアウトの Child 起動に `--defer-status` が付いていること（SKILL.md / guide-ja.md / README.md の**すべての起動例**で一致していること）
    - **`timeout` / `gtimeout` を使わないこと**（対象 macOS に存在しない）
    - 回帰は `bash test/test-runner-terminal-status.sh` と `bash test/test-runner-signal-exit.sh` で検証。既知の未解決パターンは `docs/notification-gaps.md` を参照
```

- [ ] **Step 5: guide-ja.md / README.md の起動例にも `--defer-status` を反映する**

Task 7 は SKILL.md の起動例だけを直している。Global Constraints の 4 ファイル整合に従い、派生ドキュメント側の `launch-workspace.sh` 起動例にも同じフラグを入れる。

```bash
# 起動例を含む箇所を洗い出す
grep -n 'launch-workspace.sh' apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md
grep -n 'launch-workspace.sh' apps/cmux-team-dispatch-task/README.md
```

見つかった **workspace レイアウトの Child 起動例**（`--mode plan` / `--mode superpowers` を伴うもの。`--mode execute` の孫起動例には付けない）に `--defer-status \` を追加し、「Phase B で実行を移譲したとき Child の wrapper が status.json を上書きしないために必須」である旨を添える。

- [ ] **Step 6: 起動例の整合を静的に検査する**

```bash
for f in apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md \
         apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md \
         apps/cmux-team-dispatch-task/README.md; do
  printf '%s: ' "$f"
  grep -c -- '--defer-status' "$f" || true
done
```

Expected: 3 ファイルすべてで 1 以上。0 のファイルがあれば Step 5 に戻る。

- [ ] **Step 7: 整合を目視確認する**

```bash
for f in apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md \
         apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md \
         apps/cmux-team-dispatch-task/README.md \
         apps/cmux-team-dispatch-task/CLAUDE.md; do
  echo "=== $f ==="
  grep -c 'watcher' "$f" || true
done
```

Expected: 4 ファイルすべてで 1 以上。

- [ ] **Step 8: コミットする**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md \
        apps/cmux-team-dispatch-task/README.md \
        apps/cmux-team-dispatch-task/CLAUDE.md
git commit -m "docs(cmux-team-dispatch-task): error パス通知の変更を 4 ファイルへ同期

guide-ja.md に終端 status の sticky 化・watcher・ABORT プロトコルを反映し、
README.md に完了通知の発火条件と既知の限界を追記した。CLAUDE.md には
ファイル構成表の docs 行と、退行防止ルール 23 を追加した。"
```

---

### Task 10: バージョン更新と最終検証

バージョン規則は spec 6.3 の表に従う。

**Files:**
- Modify: `apps/cmux-team-dispatch-task/.claude-plugin/plugin.json`
- Modify: `apps/cmux-team-dispatch-task/.codex-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`（リポジトリルート）

**Interfaces:**
- Consumes: Task 1〜9
- Produces: なし

- [ ] **Step 1: バージョンを上げる**

```bash
jq '.version = "1.11.0"' apps/cmux-team-dispatch-task/.claude-plugin/plugin.json > /tmp/p.json \
  && mv /tmp/p.json apps/cmux-team-dispatch-task/.claude-plugin/plugin.json
jq '.version = "1.4.0"' apps/cmux-team-dispatch-task/.codex-plugin/plugin.json > /tmp/c.json \
  && mv /tmp/c.json apps/cmux-team-dispatch-task/.codex-plugin/plugin.json
jq '(.plugins[] | select(.name == "cmux-team-dispatch-task") | .version) = "1.11.0"' \
  .claude-plugin/marketplace.json > /tmp/m.json && mv /tmp/m.json .claude-plugin/marketplace.json
```

`.agents/plugins/marketplace.json` は version フィールドを持たないので**変更しない**。

- [ ] **Step 2: バージョンが揃っていることを確認する**

```bash
jq -r .version apps/cmux-team-dispatch-task/.claude-plugin/plugin.json
jq -r .version apps/cmux-team-dispatch-task/.codex-plugin/plugin.json
jq -r '.plugins[] | select(.name=="cmux-team-dispatch-task") | .version' .claude-plugin/marketplace.json
```

Expected: `1.11.0` / `1.4.0` / `1.11.0`。

- [ ] **Step 3: 全テストと型チェックを流す**

失敗を握り潰さないよう、**失敗を集計して最後に非ゼロで終える**形にする。

```bash
pnpm check || { echo 'pnpm check FAILED'; exit 1; }

rc=0
for t in apps/cmux-team-dispatch-task/test/*.sh; do
  echo "=== $t ==="
  bash "$t" || { echo "FAILED: $t"; rc=1; }
done
exit "$rc"
```

Expected: 終了コード **0**。ログの目視ではなく終了コードで判定すること。1 件でも落ちたら次の Step へ進まない。

- [ ] **Step 4: シェルスクリプトの構文チェック**

```bash
rc=0
zsh -n apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh || rc=1
for f in apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/*.sh; do
  bash -n "$f" 2>/dev/null || zsh -n "$f" || { echo "SYNTAX FAIL: $f"; rc=1; }
done
for f in apps/cmux-team-dispatch-task/test/*.sh; do
  bash -n "$f" || { echo "SYNTAX FAIL: $f"; rc=1; }
done
exit "$rc"
```

Expected: 終了コード **0**。

- [ ] **Step 5: `timeout` を使っていないことを確認する**

```bash
grep -rn '\btimeout \|gtimeout' apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/ \
  | grep -v -- '--timeout-min\|timeout sentinel\|TIMEOUT_SENTINEL\|ready-timeout' || echo "OK: timeout コマンドは未使用"
```

Expected: `OK: timeout コマンドは未使用`。

- [ ] **Step 6: コミットする**

```bash
git add apps/cmux-team-dispatch-task/.claude-plugin/plugin.json \
        apps/cmux-team-dispatch-task/.codex-plugin/plugin.json \
        .claude-plugin/marketplace.json
git commit -m "chore(cmux-team-dispatch-task): error パス通知の追加に伴い v1.11.0 へバンプ

.codex-plugin も独立 stream として v1.4.0 へ上げる。
.agents/plugins/marketplace.json は version フィールドを持たないため変更しない。"
```
