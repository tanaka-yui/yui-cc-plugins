# ディスパッチ配送レイヤー 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** cmux-team-dispatch-task の指示配送を `send-prompt.sh` 1 本に集約し、長文が Claude Code TUI の入力欄に詰まって届かない事故をなくす。

**Architecture:** 宛先ごとに agmsg push か タイプ入力かの **どちらか一方だけ** を選ぶ配送スクリプトを新設する。タイプ入力経路は 400 文字超の本文を outbox ファイルへ退避して 1 行のポインタだけを打ち、送信後に `cmux read-screen` で入力欄が空になったかを検証して Enter を再送する。既存の `cmux send` + `send-key return` 直書き 7 箇所をこのスクリプト呼び出しに置換し、`message_type` の二択設定を廃止する。

**Tech Stack:** bash 3.2 互換シェルスクリプト、cmux CLI、agmsg 1.1.13、jq

## Global Constraints

- **設計の正本**: `docs/superpowers/specs/2026-08-12-dispatch-message-delivery-design.md`
- **bash 3.2 互換必須**（macOS 標準）。`set -u` 下で空配列を展開するときは必ず `${arr[@]+"${arr[@]}"}` イディオムを使う
- **新規スクリプトの shebang は `#!/usr/bin/env bash`**（`parallel-directive.sh` に合わせる）。コード内コメントは日本語
- **`SKILL.md` と `references/*.md`（`*-ja.md` を除く）は英語必須**。日本語訳は `references/guide-ja.md`。検証は `pnpm check:doc-lang`
- **4 ファイル整合ルール**: `SKILL.md` / `references/guide-ja.md` / `README.md` / `CLAUDE.md` のいずれかを更新したら残り 3 つも **同じ commit で** 更新する（`apps/cmux-team-dispatch-task/CLAUDE.md`「ドキュメント整合の絶対ルール」）
- **`parallel-directive.sh` の出力文字制約は維持**: `'` `"` `` ` `` `$` `!` `\` を 1 文字も含めない
- **削除するフラグは無視せず明示的に拒否する**: メッセージに `was removed` を含む `die` を使う（`--layout` 削除の前例に倣う）
- **テストの実行方法**: `bash test/<name>.sh`（turbo の test タスクは無い）。作業ディレクトリは `apps/cmux-team-dispatch-task`
- **テスト出力の形式**: 既存の `test/test-parallel-directive.sh` に合わせ、`PASS <ID>: <説明>` / `FAIL <ID>: ...` を出力し、1 つでも失敗したら exit 1
- **cmux のパス**: `/Applications/cmux.app/Contents/Resources/bin/cmux`
- **agmsg のパス**: `send.sh` は `$HOME/.agents/skills/agmsg/scripts/send.sh`、ready sentinel は `$HOME/.agents/skills/agmsg/run/ready.<team>__<agent>`

---

### Task 1: 配送前提の検証（V1 / V2）

設計の agmsg 経路は「agmsg push が idle なセッションを起こす」が真であることに依存する。
実装前にこれを実測で確定させ、以降のタスクで有効化する経路を決める。
**このタスクだけはコードを書かず、手作業の検証と結果の記録を行う。**

**Files:**
- Create: `docs/superpowers/specs/2026-08-12-delivery-verification-results.md`

**Interfaces:**
- Consumes: なし
- Produces: `V1_RESULT` / `V2_RESULT`（`pass` | `fail`）。Task 8 のドキュメント記述と Task 9 の E2E 範囲がこれに従う

- [ ] **Step 1: V1 の準備 — claude ペインを idle で立てる**

cmux で新しいワークスペースを開き、任意の作業ディレクトリで `claude` を起動する。
起動したら、そのペインで次を実行して agmsg に join し、delivery mode を monitor にする。

```bash
~/.agents/skills/agmsg/scripts/join.sh v1probe probe-cc claude-code "$(pwd)"
~/.agents/skills/agmsg/scripts/delivery.sh set monitor claude-code "$(pwd)"
```

`delivery.sh` の出力に `AGMSG-DIRECTIVE:` 行があれば、その指示どおり Monitor ツールを起動する。
その後、このペインには **何も入力せず idle のまま放置する**。

- [ ] **Step 2: V1 の実行 — 別セッションから push する**

別のペイン（またはこのセッション）から送信する。

```bash
~/.agents/skills/agmsg/scripts/send.sh v1probe tester probe-cc 'V1 probe: reply with the word ACK'
```

期待: **タイプ入力を一切していないのに** probe-cc のペインが数秒以内に反応し、メッセージを読んで応答する。

反応したら `V1_RESULT=pass`、60 秒待っても無反応なら `V1_RESULT=fail`。

- [ ] **Step 3: V1 の後片付け**

probe ペインで次を実行し、ワークスペースを閉じる。

```bash
~/.agents/skills/agmsg/scripts/reset.sh "$(pwd)" claude-code probe-cc
```

- [ ] **Step 4: V2 の準備 — codex shim を入れる**

```bash
~/.agents/skills/agmsg/scripts/drivers/types/codex/codex-shim-install.sh function
```

出力された `codex()` シェル関数を `~/.zshrc` の末尾に追記する。追記後、新しいシェルで反映を確認する。

```bash
zsh -ic 'type codex' 2>/dev/null | head -3
```

期待: `codex is a shell function` を含む出力。

- [ ] **Step 5: V2 の実行 — codex ペインを立てて push する**

任意の作業ディレクトリで次を実行し、codex を monitor モードにする。

```bash
~/.agents/skills/agmsg/scripts/join.sh v2probe probe-cx codex "$(pwd)"
~/.agents/skills/agmsg/scripts/delivery.sh set monitor codex "$(pwd)"
```

cmux で新しいワークスペースを開き、dispatch と同じ形で codex を起動する。

```bash
zsh -ic 'codex --dangerously-bypass-approvals-and-sandbox "say READY and wait"'
```

起動したら bridge が立ったかを確認する。

```bash
ls ~/.agents/skills/agmsg/run/ | grep -i codex
```

期待: `codex-app-server.<hash>.pid` と `codex-app-server.<hash>.port` が存在する。
起動時に stderr へ `Codex monitor bridge unavailable` が出ていたら、その時点で `V2_RESULT=fail`。

codex ペインを idle にしたうえで、別ペインから push する。

```bash
~/.agents/skills/agmsg/scripts/send.sh v2probe tester probe-cx 'V2 probe: reply with the word ACK'
```

期待: タイプ入力なしで codex ペインが反応する。反応したら `V2_RESULT=pass`、60 秒無反応なら `fail`。

- [ ] **Step 6: V2 の後片付け**

```bash
~/.agents/skills/agmsg/scripts/reset.sh "$(pwd)" codex probe-cx
```

`V2_RESULT=fail` だった場合は `~/.zshrc` に追記した `codex()` 関数を削除する。
`pass` だった場合は残す（本番の dispatch で使うため）。

- [ ] **Step 7: 結果を記録する**

`docs/superpowers/specs/2026-08-12-delivery-verification-results.md` を次の内容で作成し、
`<...>` を実測値で埋める。

```markdown
# 配送前提の検証結果

実施日: 2026-08-12
対象: docs/superpowers/specs/2026-08-12-dispatch-message-delivery-design.md の V1 / V2

| ID | 検証内容 | 結果 | 観測 |
|----|---------|------|------|
| V1 | agmsg push が idle な claude セッションを起こすか | <pass/fail> | <観測した挙動と所要秒数> |
| V2 | codex bridge が codex 0.147 で通るか | <pass/fail> | <bridge pid の有無、注入の可否> |

## 実装への反映

- claude 宛ての配送: <agmsg push のみ / タイプ入力経路>
- codex 宛ての配送: <agmsg push のみ / タイプ入力経路>
- `cmux send` の全廃: <可能 / 不可（<engine> 宛てに残す）>
```

- [ ] **Step 8: Commit**

```bash
git add docs/superpowers/specs/2026-08-12-delivery-verification-results.md
git commit -m "docs(cmux-team-dispatch-task): 配送前提 V1 / V2 の検証結果を記録する"
```

---

### Task 2: `send-prompt.sh` の骨格と経路選択

**Files:**
- Create: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/send-prompt.sh`
- Test: `apps/cmux-team-dispatch-task/test/test-send-prompt.sh`

**Interfaces:**
- Consumes: なし
- Produces: 以降の全タスクが呼ぶ CLI。

  ```
  send-prompt.sh [--to-workspace <id>] [--to-surface <id>]
                 [--agmsg-team <t>] [--agmsg-to <agent>] [--agmsg-from <name>]
                 --label <label>
                 [--outbox-dir <path>] [--threshold <n>] [--retries <n>] [--settle <sec>]
                 [--] <text>
  ```

  既定値: `--threshold 400` / `--retries 3` / `--settle 0.5` / `--outbox-dir` は未指定なら
  `$STATUS_DIR/outbox`（環境変数 `STATUS_DIR` を参照。無ければタイプ入力経路でファイル化が必要になった時点で die）。

  環境変数によるテスト用の差し替え:
  `CMUX_BIN`（既定 `/Applications/cmux.app/Contents/Resources/bin/cmux`）、
  `AGMSG_SEND`（既定 `$HOME/.agents/skills/agmsg/scripts/send.sh`）、
  `AGMSG_READY_DIR`（既定 `$HOME/.agents/skills/agmsg/run`）。

  終了コード: `0` = 配送成功 / `1` = 配送失敗 / `2` = 使用法エラー。

- [ ] **Step 1: 失敗するテストを書く**

`apps/cmux-team-dispatch-task/test/test-send-prompt.sh` を作成する。

```bash
#!/usr/bin/env bash
# send-prompt.sh の回帰テスト。
#
# 守っている不変条件:
#   SP1. agmsg ready sentinel がある宛先では cmux を 1 度も呼ばない
#   SP2. sentinel が無ければタイプ入力経路に落ちる

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/send-prompt.sh"
[[ -f "$BIN" ]] || { echo "FAIL: スクリプトが見つからない: $BIN"; exit 2; }

fail=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# cmux / send.sh のスタブ。呼び出し引数を log に追記する。
# read-screen だけは「入力欄が空」を表す画面を返し、Enter 検証を通す。
make_stubs() {
  mkdir -p "$TMP/bin" "$TMP/run" "$TMP/outbox"
  cat > "$TMP/bin/cmux" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "cmux $*" >> "$CMUX_LOG"
if [[ "$1" == "read-screen" ]]; then
  printf '%s\n' "some output" "❯ " "  status line"
fi
exit 0
STUB
  cat > "$TMP/bin/send.sh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "send.sh $*" >> "$AGMSG_LOG"
exit 0
STUB
  chmod +x "$TMP/bin/cmux" "$TMP/bin/send.sh"
}

run_sp() {
  CMUX_LOG="$TMP/cmux.log" AGMSG_LOG="$TMP/agmsg.log" \
  CMUX_BIN="$TMP/bin/cmux" AGMSG_SEND="$TMP/bin/send.sh" AGMSG_READY_DIR="$TMP/run" \
  bash "$BIN" "$@"
}

reset_logs() { : > "$TMP/cmux.log"; : > "$TMP/agmsg.log"; }

make_stubs

# --- SP1: ready sentinel あり → agmsg のみ、cmux は呼ばれない ---
reset_logs
touch "$TMP/run/ready.myteam__reviewer"
run_sp --to-surface surface:2 --agmsg-team myteam --agmsg-to reviewer \
       --agmsg-from impl --label codereview --outbox-dir "$TMP/outbox" -- "hello reviewer"
if [[ ! -s "$TMP/cmux.log" ]] && grep -q 'send.sh myteam impl reviewer hello reviewer' "$TMP/agmsg.log"; then
  echo "PASS SP1: ready sentinel がある宛先では cmux を呼ばず agmsg のみで送る"
else
  echo "FAIL SP1: cmux.log=[$(cat "$TMP/cmux.log")] agmsg.log=[$(cat "$TMP/agmsg.log")]"; fail=1
fi

# --- SP2: sentinel なし → タイプ入力経路 ---
reset_logs
rm -f "$TMP/run/ready.myteam__reviewer"
run_sp --to-surface surface:2 --agmsg-team myteam --agmsg-to reviewer \
       --agmsg-from impl --label codereview --outbox-dir "$TMP/outbox" -- "hello reviewer"
if grep -q 'cmux send --surface surface:2 hello reviewer' "$TMP/cmux.log" \
   && grep -q 'cmux send-key --surface surface:2 return' "$TMP/cmux.log" \
   && [[ ! -s "$TMP/agmsg.log" ]]; then
  echo "PASS SP2: sentinel が無ければタイプ入力経路に落ちる"
else
  echo "FAIL SP2: cmux.log=[$(cat "$TMP/cmux.log")] agmsg.log=[$(cat "$TMP/agmsg.log")]"; fail=1
fi

exit $fail
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
cd apps/cmux-team-dispatch-task && bash test/test-send-prompt.sh
```

期待: `FAIL: スクリプトが見つからない: .../send-prompt.sh` で exit 2。

- [ ] **Step 3: 最小実装を書く**

`apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/send-prompt.sh` を作成する。

```bash
#!/usr/bin/env bash
set -uo pipefail

# send-prompt.sh — 子/親セッションへ 1 メッセージを配送する単一の入口。
#
# 宛先ごとに agmsg push か タイプ入力かの「どちらか一方だけ」を選ぶ。
# 従来の cmux send + send-key return を無遅延で撃つ dual-send は、1KB 超の本文が
# Claude Code TUI に貼り付け判定され、デバウンス中の Enter が submit ではなく
# 貼り付けバッファに吸われて入力欄に残る事故を起こしていた。
#
# Usage: send-prompt.sh [--to-workspace <id>] [--to-surface <id>]
#                       [--agmsg-team <t>] [--agmsg-to <agent>] [--agmsg-from <name>]
#                       --label <label>
#                       [--outbox-dir <path>] [--threshold <n>] [--retries <n>] [--settle <sec>]
#                       [--] <text>
#
# Exit: 0 = 配送成功 / 1 = 配送失敗 / 2 = 使用法エラー

CMUX_BIN="${CMUX_BIN:-/Applications/cmux.app/Contents/Resources/bin/cmux}"
AGMSG_SEND="${AGMSG_SEND:-$HOME/.agents/skills/agmsg/scripts/send.sh}"
AGMSG_READY_DIR="${AGMSG_READY_DIR:-$HOME/.agents/skills/agmsg/run}"

die() { echo "send-prompt: $1" >&2; exit 2; }

TO_WORKSPACE=""; TO_SURFACE=""
TEAM=""; TO_AGENT=""; FROM_AGENT=""
LABEL=""; OUTBOX_DIR=""
THRESHOLD=400; RETRIES=3; SETTLE=0.5
TEXT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --to-workspace) [[ $# -ge 2 ]] || die "--to-workspace requires a value"; TO_WORKSPACE="$2"; shift 2 ;;
    --to-surface)   [[ $# -ge 2 ]] || die "--to-surface requires a value";   TO_SURFACE="$2";   shift 2 ;;
    --agmsg-team)   [[ $# -ge 2 ]] || die "--agmsg-team requires a value";   TEAM="$2";         shift 2 ;;
    --agmsg-to)     [[ $# -ge 2 ]] || die "--agmsg-to requires a value";     TO_AGENT="$2";     shift 2 ;;
    --agmsg-from)   [[ $# -ge 2 ]] || die "--agmsg-from requires a value";   FROM_AGENT="$2";   shift 2 ;;
    --label)        [[ $# -ge 2 ]] || die "--label requires a value";        LABEL="$2";        shift 2 ;;
    --outbox-dir)   [[ $# -ge 2 ]] || die "--outbox-dir requires a value";   OUTBOX_DIR="$2";   shift 2 ;;
    --threshold)    [[ $# -ge 2 ]] || die "--threshold requires a value";    THRESHOLD="$2";    shift 2 ;;
    --retries)      [[ $# -ge 2 ]] || die "--retries requires a value";      RETRIES="$2";      shift 2 ;;
    --settle)       [[ $# -ge 2 ]] || die "--settle requires a value";       SETTLE="$2";       shift 2 ;;
    --) shift; TEXT="$*"; break ;;
    *)  TEXT="$*"; break ;;
  esac
done

[[ -n "$LABEL" ]] || die "--label is required"
[[ -n "$TEXT" ]] || die "message text is required"
[[ -n "$TO_WORKSPACE" || -n "$TO_SURFACE" ]] || die "--to-workspace or --to-surface is required"

# --- 経路選択 ---
# agmsg の 3 引数が揃い、宛先の watcher が生きている (ready sentinel が存在する)
# ときだけ agmsg 経路。sentinel は watcher プロセスの生存を示す。
route="typed"
if [[ -n "$TEAM" && -n "$TO_AGENT" && -n "$FROM_AGENT" ]] \
   && [[ -f "$AGMSG_READY_DIR/ready.${TEAM}__${TO_AGENT}" ]]; then
  route="agmsg"
fi

if [[ "$route" == "agmsg" ]]; then
  bash "$AGMSG_SEND" "$TEAM" "$FROM_AGENT" "$TO_AGENT" "$TEXT" && exit 0
  echo "send-prompt: agmsg push failed; falling back to typed delivery" >&2
fi

# --- タイプ入力経路 ---
TARGET=()
[[ -n "$TO_WORKSPACE" ]] && TARGET+=(--workspace "$TO_WORKSPACE")
[[ -n "$TO_SURFACE" ]] && TARGET+=(--surface "$TO_SURFACE")

"$CMUX_BIN" send ${TARGET[@]+"${TARGET[@]}"} "$TEXT" || exit 1
sleep "$SETTLE"
"$CMUX_BIN" send-key ${TARGET[@]+"${TARGET[@]}"} return || exit 1
exit 0
```

実行権限を付ける。

```bash
chmod +x apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/send-prompt.sh
```

- [ ] **Step 4: テストを実行して通ることを確認する**

```bash
cd apps/cmux-team-dispatch-task && bash test/test-send-prompt.sh
```

期待: `PASS SP1` と `PASS SP2` が出て exit 0。

- [ ] **Step 5: Commit**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/send-prompt.sh \
        apps/cmux-team-dispatch-task/test/test-send-prompt.sh
git commit -m "feat(cmux-team-dispatch-task): 配送経路を選ぶ send-prompt.sh を追加する"
```

---

### Task 3: 長文の outbox ファイル化

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/send-prompt.sh`
- Test: `apps/cmux-team-dispatch-task/test/test-send-prompt.sh`

**Interfaces:**
- Consumes: Task 2 の `send-prompt.sh` CLI
- Produces: `--threshold` 超の本文は `<outbox-dir>/<label>-<seq>.md` に退避され、
  タイプされるのは `<label>: read <path> and follow every instruction in it.` の 1 行だけ。
  `<seq>` は同一 `<label>` の既存ファイル数 + 1（過去の送信を上書きしない）。

- [ ] **Step 1: 失敗するテストを追加する**

`test/test-send-prompt.sh` の `exit $fail` の直前に、次を挿入する。
先頭のコメントブロックにも `SP3` 〜 `SP5` の行を追加する。

```bash
# --- SP3: 閾値超えは outbox にファイル化され、1 行のポインタだけがタイプされる ---
reset_logs
LONG="$(printf 'x%.0s' $(seq 1 500))"
run_sp --to-surface surface:2 --label codereview --outbox-dir "$TMP/outbox" -- "$LONG"
outfile="$TMP/outbox/codereview-1.md"
if [[ -f "$outfile" ]] \
   && [[ "$(cat "$outfile")" == "$LONG" ]] \
   && grep -qF "cmux send --surface surface:2 codereview: read $outfile and follow every instruction in it." "$TMP/cmux.log" \
   && ! grep -qF "xxxxxxxxxx" "$TMP/cmux.log"; then
  echo "PASS SP3: 閾値超えはファイル化され 1 行のポインタだけがタイプされる"
else
  echo "FAIL SP3: outfile=[$outfile] cmux.log=[$(cat "$TMP/cmux.log")]"; fail=1
fi

# --- SP4: 同一 label の 2 通目は連番になり 1 通目を上書きしない ---
reset_logs
LONG2="$(printf 'y%.0s' $(seq 1 500))"
run_sp --to-surface surface:2 --label codereview --outbox-dir "$TMP/outbox" -- "$LONG2"
if [[ "$(cat "$TMP/outbox/codereview-1.md")" == "$LONG" ]] \
   && [[ "$(cat "$TMP/outbox/codereview-2.md")" == "$LONG2" ]]; then
  echo "PASS SP4: 同一 label の 2 通目は連番になり 1 通目を上書きしない"
else
  echo "FAIL SP4: outbox=[$(ls "$TMP/outbox")]"; fail=1
fi

# --- SP5: 閾値以下は素のテキストとしてタイプされる ---
reset_logs
run_sp --to-surface surface:2 --label notify --outbox-dir "$TMP/outbox" -- "short message"
if grep -qF 'cmux send --surface surface:2 short message' "$TMP/cmux.log" \
   && [[ ! -f "$TMP/outbox/notify-1.md" ]]; then
  echo "PASS SP5: 閾値以下はファイル化せず素のテキストでタイプされる"
else
  echo "FAIL SP5: cmux.log=[$(cat "$TMP/cmux.log")] outbox=[$(ls "$TMP/outbox")]"; fail=1
fi
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
cd apps/cmux-team-dispatch-task && bash test/test-send-prompt.sh
```

期待: `FAIL SP3` と `FAIL SP4` が出て exit 1（SP5 は現状の実装でも通る）。

- [ ] **Step 3: 実装を追加する**

`send-prompt.sh` の `# --- タイプ入力経路 ---` の直後、`TARGET=()` の行の前に次を挿入する。

```bash
# 閾値を超える本文はタイプさせない。TUI が貼り付けと判定して [Pasted text #N] に
# 畳み、直後の Enter を吸ってしまうため。全文はファイルへ退避し、パスだけを打つ。
PAYLOAD="$TEXT"
if [[ ${#TEXT} -gt $THRESHOLD ]]; then
  [[ -n "$OUTBOX_DIR" ]] || OUTBOX_DIR="${STATUS_DIR:-}/outbox"
  [[ "$OUTBOX_DIR" != "/outbox" ]] || die "--outbox-dir is required when STATUS_DIR is unset"
  mkdir -p "$OUTBOX_DIR" || die "failed to create outbox dir: $OUTBOX_DIR"
  # 同一 label の既存ファイル数 + 1 を連番にする (過去の送信を上書きしない)
  seq_n=1
  while [[ -e "$OUTBOX_DIR/$LABEL-$seq_n.md" ]]; do
    seq_n=$((seq_n + 1))
  done
  OUTBOX_FILE="$OUTBOX_DIR/$LABEL-$seq_n.md"
  printf '%s' "$TEXT" > "$OUTBOX_FILE" || die "failed to write outbox file: $OUTBOX_FILE"
  PAYLOAD="$LABEL: read $OUTBOX_FILE and follow every instruction in it."
fi
```

続いて、`"$CMUX_BIN" send` の行の `"$TEXT"` を `"$PAYLOAD"` に変更する。

```bash
"$CMUX_BIN" send ${TARGET[@]+"${TARGET[@]}"} "$PAYLOAD" || exit 1
```

- [ ] **Step 4: テストを実行して通ることを確認する**

```bash
cd apps/cmux-team-dispatch-task && bash test/test-send-prompt.sh
```

期待: `PASS SP1` 〜 `PASS SP5` が出て exit 0。

- [ ] **Step 5: Commit**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/send-prompt.sh \
        apps/cmux-team-dispatch-task/test/test-send-prompt.sh
git commit -m "feat(cmux-team-dispatch-task): 閾値超えの本文を outbox へ退避しポインタだけ打つ"
```

---

### Task 4: Enter 検証と再送

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/send-prompt.sh`
- Test: `apps/cmux-team-dispatch-task/test/test-send-prompt.sh`

**Interfaces:**
- Consumes: Task 3 までの `send-prompt.sh`
- Produces: 送信後に `cmux read-screen` で入力欄を検査し、本文が残っていれば
  `send-key return` を最大 `--retries` 回まで 1 秒間隔で再送する。
  尽きたら exit 1。`read-screen` が失敗 or 空出力なら観測失敗とみなし成功扱いで exit 0。

- [ ] **Step 1: 失敗するテストを追加する**

まず、スタブを差し替え可能にする。`make_stubs` の `cmux` スタブを次に置き換える。
`SCREEN_FIXTURE` が指すファイルの内容を `read-screen` の出力として返すようにする。

```bash
  cat > "$TMP/bin/cmux" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "cmux $*" >> "$CMUX_LOG"
if [[ "$1" == "read-screen" ]]; then
  [[ -n "${SCREEN_FIXTURE:-}" && -f "$SCREEN_FIXTURE" ]] && cat "$SCREEN_FIXTURE"
fi
exit 0
STUB
```

`run_sp` に `SCREEN_FIXTURE` を渡すよう変更する。

```bash
run_sp() {
  CMUX_LOG="$TMP/cmux.log" AGMSG_LOG="$TMP/agmsg.log" SCREEN_FIXTURE="${SCREEN_FIXTURE:-}" \
  CMUX_BIN="$TMP/bin/cmux" AGMSG_SEND="$TMP/bin/send.sh" AGMSG_READY_DIR="$TMP/run" \
  bash "$BIN" "$@"
}
```

既存の SP1/SP2/SP3/SP4/SP5 が「入力欄は空」を見るよう、`make_stubs` の直後に既定の
fixture を用意する。

```bash
printf '%s\n' "some output" "❯ " "  status line" > "$TMP/screen-empty.txt"
printf '%s\n' "some output" "❯ short message" "  status line" > "$TMP/screen-stuck.txt"
SCREEN_FIXTURE="$TMP/screen-empty.txt"
```

そのうえで `exit $fail` の直前に次を追加し、先頭のコメントブロックにも `SP6` 〜 `SP8` を追記する。

```bash
# --- SP6: 入力欄が空なら Enter は 1 回だけで成功する ---
reset_logs
SCREEN_FIXTURE="$TMP/screen-empty.txt"
run_sp --to-surface surface:2 --label notify --outbox-dir "$TMP/outbox" -- "short message"
rc=$?
n=$(grep -c 'cmux send-key' "$TMP/cmux.log")
if [[ $rc -eq 0 && $n -eq 1 ]]; then
  echo "PASS SP6: 入力欄が空なら Enter は 1 回だけで成功する"
else
  echo "FAIL SP6: rc=$rc send-key回数=$n"; fail=1
fi

# --- SP7: 入力欄に残る場合は Enter を再送し、尽きたら exit 1 ---
reset_logs
SCREEN_FIXTURE="$TMP/screen-stuck.txt"
run_sp --to-surface surface:2 --label notify --outbox-dir "$TMP/outbox" \
       --retries 3 --settle 0 -- "short message"
rc=$?
n=$(grep -c 'cmux send-key' "$TMP/cmux.log")
if [[ $rc -eq 1 && $n -eq 4 ]]; then
  echo "PASS SP7: 入力欄に残る場合は Enter を 3 回再送して exit 1 する"
else
  echo "FAIL SP7: rc=$rc send-key回数=$n (期待 rc=1, 回数=4)"; fail=1
fi

# --- SP8: read-screen が空出力なら観測失敗として成功扱いにする ---
reset_logs
SCREEN_FIXTURE="$TMP/screen-missing.txt"   # 存在しない = 空出力
run_sp --to-surface surface:2 --label notify --outbox-dir "$TMP/outbox" -- "short message"
rc=$?
n=$(grep -c 'cmux send-key' "$TMP/cmux.log")
if [[ $rc -eq 0 && $n -eq 1 ]]; then
  echo "PASS SP8: read-screen が空出力なら観測失敗として成功扱いにする"
else
  echo "FAIL SP8: rc=$rc send-key回数=$n"; fail=1
fi
SCREEN_FIXTURE="$TMP/screen-empty.txt"
```

SP7 の期待回数が 4 なのは、最初の 1 回 + 再送 3 回だからである。

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
cd apps/cmux-team-dispatch-task && bash test/test-send-prompt.sh
```

期待: `FAIL SP7` が出て exit 1（SP6 / SP8 は現状の実装でも通る）。

- [ ] **Step 3: 実装を追加する**

`send-prompt.sh` の末尾（`"$CMUX_BIN" send-key ... return || exit 1` と `exit 0` の間）を、
次のブロックに置き換える。

```bash
"$CMUX_BIN" send-key ${TARGET[@]+"${TARGET[@]}"} return || exit 1

# 入力欄にテキストが残っていないかを確認する。TUI の貼り付けデバウンスに Enter が
# 吸われるとここで検出できる。read-screen が観測できない場合は配送失敗とみなさない
# (Phase A-R の生存確認と同じ扱い)。
probe="${PAYLOAD:0:30}"
attempt=0
while [[ $attempt -lt $RETRIES ]]; do
  screen=$("$CMUX_BIN" read-screen ${TARGET[@]+"${TARGET[@]}"} 2>/dev/null || true)
  [[ -n "$screen" ]] || exit 0                       # 観測失敗 = 配送失敗ではない
  input_line=$(printf '%s\n' "$screen" | grep -E '^[❯>]' || true)
  printf '%s' "$input_line" | grep -qF -- "$probe" || exit 0   # 入力欄は空 = 送信済み
  attempt=$((attempt + 1))
  sleep 1
  "$CMUX_BIN" send-key ${TARGET[@]+"${TARGET[@]}"} return || exit 1
done

echo "send-prompt: message still sitting in the input box after $RETRIES retries (label=$LABEL)" >&2
exit 1
```

- [ ] **Step 4: テストを実行して通ることを確認する**

```bash
cd apps/cmux-team-dispatch-task && bash test/test-send-prompt.sh
```

期待: `PASS SP1` 〜 `PASS SP8` が出て exit 0。

- [ ] **Step 5: Commit**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/send-prompt.sh \
        apps/cmux-team-dispatch-task/test/test-send-prompt.sh
git commit -m "feat(cmux-team-dispatch-task): 送信後に入力欄を検証し Enter を再送する"
```

---

### Task 5: agmsg 失敗時のタイプ入力フォールバック

Task 2 でフォールバックのコードは入れたが、テストがない。配送が無言で消える経路を作らないことを回帰で守る。

**Files:**
- Test: `apps/cmux-team-dispatch-task/test/test-send-prompt.sh`

**Interfaces:**
- Consumes: Task 4 までの `send-prompt.sh`
- Produces: なし（既存挙動の固定）

- [ ] **Step 1: 失敗するテストを追加する**

`exit $fail` の直前に次を追加し、先頭のコメントブロックにも `SP9` を追記する。

```bash
# --- SP9: agmsg の send.sh が失敗したらタイプ入力経路へフォールバックする ---
reset_logs
touch "$TMP/run/ready.myteam__reviewer"
cat > "$TMP/bin/send.sh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "send.sh $*" >> "$AGMSG_LOG"
exit 1
STUB
chmod +x "$TMP/bin/send.sh"
SCREEN_FIXTURE="$TMP/screen-empty.txt"
run_sp --to-surface surface:2 --agmsg-team myteam --agmsg-to reviewer \
       --agmsg-from impl --label codereview --outbox-dir "$TMP/outbox" -- "hello reviewer"
rc=$?
if [[ $rc -eq 0 ]] \
   && grep -q 'send.sh myteam impl reviewer' "$TMP/agmsg.log" \
   && grep -qF 'cmux send --surface surface:2 hello reviewer' "$TMP/cmux.log"; then
  echo "PASS SP9: agmsg 失敗時はタイプ入力経路へフォールバックする"
else
  echo "FAIL SP9: rc=$rc cmux.log=[$(cat "$TMP/cmux.log")]"; fail=1
fi
rm -f "$TMP/run/ready.myteam__reviewer"
```

- [ ] **Step 2: テストを実行して通ることを確認する**

```bash
cd apps/cmux-team-dispatch-task && bash test/test-send-prompt.sh
```

期待: `PASS SP1` 〜 `PASS SP9` が出て exit 0。Task 2 の実装で既にフォールバックしているため、
このテストは追加時点で通る。通らなければ Task 2 の実装に欠落があるので直す。

- [ ] **Step 3: Commit**

```bash
git add apps/cmux-team-dispatch-task/test/test-send-prompt.sh
git commit -m "test(cmux-team-dispatch-task): agmsg 失敗時のフォールバックを回帰で守る"
```

---

### Task 6: スクリプト側の呼び出しを置換する

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh`（`notify_parent()` 付近 851-873 行、`notify_reviewer_once()` 付近 886-906 行）
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/monitor-dispatch.sh:47-56`
- Test: `apps/cmux-team-dispatch-task/test/test-send-prompt-callsites.sh`（新規）

**Interfaces:**
- Consumes: Task 4 までの `send-prompt.sh`（`--to-workspace` / `--to-surface` / `--agmsg-*` / `--label`）
- Produces: スクリプト内に `cmux send` と `cmux send-key` の直書きペアが残らない状態

- [ ] **Step 1: 失敗するテストを書く**

`apps/cmux-team-dispatch-task/test/test-send-prompt-callsites.sh` を作成する。

```bash
#!/usr/bin/env bash
# 配送経路が send-prompt.sh に一本化されていることの静的検査。
#
# 守っている不変条件:
#   CS1. launch-workspace.sh / monitor-dispatch.sh に cmux send-key の直書きが残らない
#   CS2. 両スクリプトが send-prompt.sh を呼んでいる

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts"
fail=0

# --- CS1: send-key の直書きが残らない ---
# send-prompt.sh 自身は当然 send-key を呼ぶので対象外。
cs1=1
for f in launch-workspace.sh monitor-dispatch.sh; do
  # grep -n は行頭に行番号を付けるので、コメント行の除外は ':' の後ろを見る
  if grep -n 'send-key' "$SCRIPTS/$f" | grep -qv ':[[:space:]]*#'; then
    echo "  send-key の直書きが残っている: $f"
    grep -n 'send-key' "$SCRIPTS/$f" | head -5
    cs1=0
  fi
done
if [[ $cs1 -eq 1 ]]; then
  echo "PASS CS1: スクリプトに cmux send-key の直書きが残らない"
else
  echo "FAIL CS1: send-key の直書きが残っている"; fail=1
fi

# --- CS2: send-prompt.sh を呼んでいる ---
cs2=1
for f in launch-workspace.sh monitor-dispatch.sh; do
  grep -q 'send-prompt.sh' "$SCRIPTS/$f" || { echo "  send-prompt.sh を呼んでいない: $f"; cs2=0; }
done
if [[ $cs2 -eq 1 ]]; then
  echo "PASS CS2: 両スクリプトが send-prompt.sh を呼んでいる"
else
  echo "FAIL CS2: send-prompt.sh の呼び出しが無い"; fail=1
fi

exit $fail
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
cd apps/cmux-team-dispatch-task && bash test/test-send-prompt-callsites.sh
```

期待: `FAIL CS1` と `FAIL CS2` が出て exit 1。

- [ ] **Step 3: `monitor-dispatch.sh` を置換する**

47-56 行の `send_to_parent()` を次に置き換える。

```bash
# 親に1メッセージを送信する。配送経路の選択・長文のファイル化・Enter 検証は
# send-prompt.sh が受け持つ。失敗は silent (|| true)。
send_to_parent() {
  local msg="$1"
  if [[ -n "$PARENT_WORKSPACE" ]]; then
    bash "$SEND_PROMPT" --to-workspace "$PARENT_WORKSPACE" \
      --label dispatch-monitor --outbox-dir "$DISPATCH_DIR/outbox" -- "$msg" 2>/dev/null || true
  fi
}
```

`SCRIPT_PATH="${(%):-%x}"` の定義（29 行）の直後に `SEND_PROMPT` を追加する。
`monitor-dispatch.sh` は zsh なので、既存の `SCRIPT_PATH` から zsh の修飾子 `:h` で親ディレクトリを取る。

```zsh
SEND_PROMPT="${SCRIPT_PATH:h}/send-prompt.sh"
```

- [ ] **Step 4: `launch-workspace.sh` の runner wrapper を置換する**

`notify_parent()`（851-873 行付近）の本体を次に置き換える。ヒアドキュメント内なので
`\$` エスケープを維持する。

```bash
notify_parent() {
  local status_label="\$1"
  local msg="[dispatch] task \\\"\$SLUG\\\" finished (status: \$status_label)"

  local target_flag target_id
  if [[ -n "\$NOTIFY_WS" ]]; then
    target_flag="--to-workspace"; target_id="\$NOTIFY_WS"
  elif [[ -n "\$NOTIFY_SF" ]]; then
    target_flag="--to-surface"; target_id="\$NOTIFY_SF"
  else
    return 1
  fi

  local agmsg_args=()
  if [[ -n "\$AGMSG_TEAM" && -n "\$AGMSG_FROM" ]]; then
    agmsg_args=(--agmsg-team "\$AGMSG_TEAM" --agmsg-to parent --agmsg-from "\$AGMSG_FROM")
  fi

  bash "\$SEND_PROMPT" "\$target_flag" "\$target_id" \
    \${agmsg_args[@]+"\${agmsg_args[@]}"} \
    --label dispatch-notify --outbox-dir "\$STATUS_DIR/outbox" -- "\$msg" || return 1
  return 0
}
```

`notify_reviewer_once()` の末尾 2 行（`"\$CMUX" send ...` と `"\$CMUX" send-key ...`）を
次の 1 行に置き換える。

```bash
  local ws_args=()
  [[ -n "\$rworkspace" ]] && ws_args=(--to-workspace "\$rworkspace")
  bash "\$SEND_PROMPT" \${ws_args[@]+"\${ws_args[@]}"} --to-surface "\$rsurface" \
    --label dispatch-abort --outbox-dir "\$STATUS_DIR/outbox" -- "\$msg" || return 1
```

runner wrapper のヒアドキュメント冒頭（795-808 行の変数定義ブロック、`CMUX="${CMUX}"` の直後）に
`SEND_PROMPT` を追加する。

```bash
SEND_PROMPT="${SCRIPT_DIR}/send-prompt.sh"
```

先に `SCRIPT_DIR` が既に定義されているかを確認する。

```bash
grep -n '^SCRIPT_DIR=' apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh
```

出力が無ければ、スクリプト冒頭の変数定義ブロック（`CMUX=` の近く）に次を追加する。
`launch-workspace.sh` の shebang は `#!/bin/bash` なので `BASH_SOURCE` が使える。

```bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
```

- [ ] **Step 5: テストを実行して通ることを確認する**

```bash
cd apps/cmux-team-dispatch-task && bash test/test-send-prompt-callsites.sh
```

期待: `PASS CS1` と `PASS CS2` が出て exit 0。

- [ ] **Step 6: 既存の runner テストが壊れていないことを確認する**

```bash
cd apps/cmux-team-dispatch-task
bash test/test-runner-terminal-status.sh
bash test/test-runner-signal-exit.sh
bash test/test-monitor-layout.sh
```

期待: 3 つとも exit 0。失敗した場合は、テストが `cmux send` の直書きを期待している箇所を
`send-prompt.sh` の呼び出しを期待する形に更新する。

- [ ] **Step 7: Commit**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh \
        apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/monitor-dispatch.sh \
        apps/cmux-team-dispatch-task/test/
git commit -m "refactor(cmux-team-dispatch-task): スクリプトの配送を send-prompt.sh に一本化する"
```

---

### Task 7: `message_type` を廃止する

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh:200`, `:300-306`, `:362-368`, `:804`, `:855`
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh:74`, `:117-122`, `:176`, `:184`, `:229`, `:355`, `:392`, `:431`
- Test: `apps/cmux-team-dispatch-task/test/test-message-type-removed.sh`（新規）

**Interfaces:**
- Consumes: なし
- Produces: 両スクリプトが `--message-type` を `was removed` を含む `die` で拒否する。
  agmsg を使うかどうかは `--agmsg-team` の有無と `send.sh` の存在だけで決まる。

- [ ] **Step 1: 失敗するテストを書く**

`apps/cmux-team-dispatch-task/test/test-message-type-removed.sh` を作成する。

```bash
#!/usr/bin/env bash
# --message-type 廃止の回帰テスト。
#
# 守っている不変条件:
#   MT1. launch-workspace.sh は --message-type を was removed を含む die で拒否する
#   MT2. prewarm-panes.sh は --message-type を was removed を含む die で拒否する
#   MT3. 両スクリプトのソースに MESSAGE_TYPE 変数が残らない

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts"
fail=0

check_rejects() {
  local id="$1" script="$2"
  local out rc
  out=$(bash "$SCRIPTS/$script" --message-type agmsg 2>&1); rc=$?
  if [[ $rc -ne 0 ]] && grep -q 'was removed' <<<"$out"; then
    echo "PASS $id: $script は --message-type を was removed で拒否する"
  else
    echo "FAIL $id: rc=$rc out=[$out]"; fail=1
  fi
}

check_rejects MT1 launch-workspace.sh
check_rejects MT2 prewarm-panes.sh

# --- MT3: MESSAGE_TYPE 変数が残らない ---
mt3=1
for f in launch-workspace.sh prewarm-panes.sh; do
  if grep -q 'MESSAGE_TYPE' "$SCRIPTS/$f"; then
    echo "  MESSAGE_TYPE が残っている: $f"
    grep -n 'MESSAGE_TYPE' "$SCRIPTS/$f" | head -5
    mt3=0
  fi
done
if [[ $mt3 -eq 1 ]]; then
  echo "PASS MT3: 両スクリプトに MESSAGE_TYPE 変数が残らない"
else
  echo "FAIL MT3: MESSAGE_TYPE が残っている"; fail=1
fi

exit $fail
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
cd apps/cmux-team-dispatch-task && bash test/test-message-type-removed.sh
```

期待: `FAIL MT1` / `FAIL MT2` / `FAIL MT3` が出て exit 1。

- [ ] **Step 3: `launch-workspace.sh` を変更する**

200 行の `MESSAGE_TYPE="send-message"` を削除する。

300-306 行の `--message-type` case を次に置き換える。

```bash
    # v1.16.0 で削除。agmsg を使うかは --agmsg-team の有無と send.sh の存在で決まる。
    --message-type)
      die "--message-type was removed: agmsg is wired whenever --agmsg-team is given and send.sh exists"
      ;;
```

362-368 行の agmsg 必須チェックを次に置き換える。

```bash
# agmsg 配線は team / from が揃っているときだけ行う。send.sh が無ければ未インストール。
if [[ -n "$AGMSG_TEAM" || -n "$AGMSG_FROM" ]]; then
  [[ -n "$AGMSG_TEAM" ]] || die "--agmsg-team is required when --agmsg-from is given"
  [[ -n "$AGMSG_FROM" ]] || die "--agmsg-from is required when --agmsg-team is given"
  [[ -f "$AGMSG_SEND" ]] || die "agmsg is not installed (expected $AGMSG_SEND)"
fi
```

804 行の runner ヒアドキュメント内 `MESSAGE_TYPE="${MESSAGE_TYPE}"` の行を削除する。

855 行付近、`notify_parent()` 内に残っている `if [[ "\$MESSAGE_TYPE" == "agmsg" ]]; then ... fi`
のブロックは Task 6 の置換で既に消えている。残っていれば削除する。

- [ ] **Step 4: `prewarm-panes.sh` を変更する**

74 行の `MESSAGE_TYPE="send-message"` を削除する。

117-122 行の `--message-type` case を次に置き換える。

```bash
    # v1.16.0 で削除。agmsg を使うかは --agmsg-team の有無と send.sh の存在で決まる。
    --message-type)
      die "--message-type was removed: agmsg is wired whenever --agmsg-team is given and send.sh exists" ;;
```

176 行の `--with-opus` チェックを次に置き換える。

```bash
  [[ -n "$AGMSG_TEAM" ]] || die "--with-opus requires --agmsg-team"
```

184 行の agmsg 必須チェックを次に置き換える。

```bash
if [[ -n "$AGMSG_TEAM" ]]; then
  [[ -f "$AGMSG_DIR/send.sh" ]] || die "agmsg is not installed (expected $AGMSG_DIR/send.sh)"
fi
```

229 / 355 / 392 / 431 行の `if [[ "$MESSAGE_TYPE" == "agmsg" ]]; then` を
すべて `if [[ -n "$AGMSG_TEAM" ]]; then` に置き換える。

- [ ] **Step 5: テストを実行して通ることを確認する**

```bash
cd apps/cmux-team-dispatch-task && bash test/test-message-type-removed.sh
```

期待: `PASS MT1` 〜 `PASS MT3` が出て exit 0。

- [ ] **Step 6: 既存テストが壊れていないことを確認する**

```bash
cd apps/cmux-team-dispatch-task
for t in test/test-launch-workspace-*.sh test/test-prewarm-unattended.sh \
         test/test-runner-*.sh test/test-monitor-layout.sh test/test-parallel-directive.sh \
         test/test-send-prompt.sh test/test-send-prompt-callsites.sh; do
  echo "--- $t"; bash "$t" || echo "^^^ FAILED: $t"
done
```

期待: すべて exit 0。`--message-type` を渡しているテストがあれば、そのフラグを削って
`--agmsg-team` だけを渡す形に更新する。

- [ ] **Step 7: Commit**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/ \
        apps/cmux-team-dispatch-task/test/
git commit -m "feat(cmux-team-dispatch-task): message_type の二択を廃止し agmsg 前提に一本化する"
```

---

### Task 8: ドキュメント 6 ファイルを同期する

`CLAUDE.md`「ドキュメント整合の絶対ルール」により、`SKILL.md` / `guide-ja.md` / `README.md` /
`CLAUDE.md` は **同じ commit で** 更新しなければならない。loop-mode の 2 ファイルも
`message_type` に触れているため同時に直す。

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md`（L412-453 の message_type 解決、L595-600 / L804 / L1071 / L1202 / L1249-1275 / L1425 / L1739 の送信手順、L2318 / L2324 の Notes）
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md`（L103-109、L212、L1058、L1240-1254）
- Modify: `apps/cmux-team-dispatch-task/README.md`（L140-171）
- Modify: `apps/cmux-team-dispatch-task/CLAUDE.md`（項目 9 / 12 / 15）
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/loop-mode.md:79`, `:102`
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/loop-mode-ja.md:67`, `:86`
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh`（`REVIEW_INSTRUCTION` 667 行、`ABORT_REVIEW_STEP` 679 行、`ABORT_PARENT_STEP` 683 行）
- Test: `apps/cmux-team-dispatch-task/test/test-send-prompt-callsites.sh`（CS3 を追加）

**Interfaces:**
- Consumes: Task 7 までの実装
- Produces: エージェント向け指示文がすべて `send-prompt.sh` の 1 回呼び出しになった状態

- [ ] **Step 1: 失敗するテストを追加する**

`test/test-send-prompt-callsites.sh` の `exit $fail` の直前に次を追加し、
先頭のコメントブロックに `CS3` を追記する。

```bash
# --- CS3: SKILL.md の指示文に cmux send-key の直書きが残らない ---
SKILL="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/SKILL.md"
if grep -q 'send-key' "$SKILL"; then
  echo "FAIL CS3: SKILL.md に cmux send-key の直書きが残っている"
  grep -n 'send-key' "$SKILL" | head -10
  fail=1
else
  echo "PASS CS3: SKILL.md に cmux send-key の直書きが残らない"
fi
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
cd apps/cmux-team-dispatch-task && bash test/test-send-prompt-callsites.sh
```

期待: `FAIL CS3` が出て exit 1。

- [ ] **Step 3: `SKILL.md` の送信手順を置換する**

`cmux send <...> '<text>'` と `cmux send-key <...> return` の 2 行が並んでいる箇所
（L595-597 / L804-805 / L1071-1072 / L1202-1203 / L1252-1253 / L1273-1274 / L1425-1426 / L1739-1740）を、
すべて次の 1 行呼び出しに置き換える。`<...>` は各箇所の宛先に合わせる。

```
bash <SKILL_DIR>/scripts/send-prompt.sh --to-surface <TARGET_SURFACE> \
  --agmsg-team <TEAM> --agmsg-to <TARGET_AGENT> --agmsg-from <your-agent-name> \
  --label <label> --outbox-dir <EXISTING_STATUS_DIR>/outbox -- '<text>'
```

親宛ての箇所は `--to-surface` の代わりに `--to-workspace <PARENT_WORKSPACE_ID>` を、
`--agmsg-to` には `parent` を使う。`<TEAM>` が空のときは `--agmsg-*` の 3 フラグごと省略する。

`<label>` は箇所ごとに次を使う。

| 箇所 | label |
|------|-------|
| Phase A タスク投入 (L1739) | `phase-a-task` |
| Phase B 実行指示 (L804 / L1425) | `phase-b-exec` |
| Phase A-R レビュー依頼 (L1071) | `review-plan` |
| Phase B-R レビュー依頼 (L1202) | `review-code` |
| abort 通知 (L1252) | `abort-reviewer` |
| 完了通知 (L595 / L1273) | `dispatch-notify` |

あわせて、これらの箇所にある「agmsg push は inbox 記録専用なので `cmux send` が唯一の wake 手段」
という趣旨の説明文を、次の趣旨に書き換える（英語で書く）。

> 配送は `send-prompt.sh` が 1 経路だけ選ぶ。宛先の watcher が生きていれば agmsg push で送り、
> そうでなければタイプ入力へ落ちる。長文はファイルへ退避されるので入力欄に詰まらない。

- [ ] **Step 4: `SKILL.md` の `message_type` 解決を削除する**

L412-453 の「Decide how child sessions notify the parent (`message_type`)」ブロックを削除し、
次の趣旨の短い記述に置き換える（英語）。

> agmsg is wired whenever `~/.agents/skills/agmsg/scripts/send.sh` exists. There is no
> transport question and no `message_type` config key. `monitor-dispatch.sh` is launched
> only when agmsg is not installed.

L2318 / L2324 の Notes も同じ趣旨に更新する。L2324 の
「An agmsg push is inbox-record-only and cannot wake an idle session」の記述は、
Task 1 の `V1_RESULT` に従って書き換える。

- [ ] **Step 5: `launch-workspace.sh` の埋め込みプロンプトを置換する**

667 行の `REVIEW_INSTRUCTION` 内の
`(1) request the review by running: $CMUX send $TARGET_FLAGS followed by: $CMUX send-key $TARGET_FLAGS return -- the message must say: ...`
の部分を、次に置き換える。

```
(1) request the review by running: bash $SEND_PROMPT $SEND_TARGET_FLAGS --label review-code --outbox-dir $REVIEW_DIR/outbox -- the message must say: ...
```

`SEND_TARGET_FLAGS` は `TARGET_FLAGS` の `--workspace` / `--surface` を
`--to-workspace` / `--to-surface` に置き換えたものとして、同じ場所で組み立てる。

679 行の `ABORT_REVIEW_STEP` と 683 行の `ABORT_PARENT_STEP` も同様に、
`$CMUX send ...` + `$CMUX send-key ...` のペアを `bash $SEND_PROMPT ...` の 1 回呼び出しに置き換える。
label はそれぞれ `abort-reviewer` / `dispatch-notify` を使う。

- [ ] **Step 6: `guide-ja.md` を同期する**

L103-109 の「メッセージトランスポート解決」節を削除し、Step 4 で書いた英語記述の訳に置き換える。
L212 / L1058 / L1240-1254 の `message_type` に関する記述も同様に更新する。
SKILL.md と見出しが 1:1 対応することを保つ。

- [ ] **Step 7: `README.md` を同期する**

L140-171 の「メッセージトランスポート（message_type）」節を削除し、
「agmsg がインストールされていれば自動で配線される。設定項目は無い」旨の節に置き換える。
Task 1 で `V2_RESULT=pass` だった場合は、codex ペインで agmsg を使うために
`.zshrc` へ `codex()` 関数を追加する必要がある旨も書く。

- [ ] **Step 8: `CLAUDE.md` を同期する**

項目 9（`cmux send` に `send-key return` がペアで発行されているかの確認）を、
「配送が `send-prompt.sh` に一本化され、`cmux send-key` の直書きが残っていないこと。
回帰は `bash test/test-send-prompt-callsites.sh` で検証する」に書き換える。

項目 12（`message_type` の解決フロー）を、`message_type` 廃止後の判定
（`send.sh` の存在だけで決まる / 質問しない / 回帰は `bash test/test-message-type-removed.sh`）に書き換える。

項目 15（dual-send プロトコル）を、「宛先ごとに 1 経路だけ選ぶ」設計に書き換える。

「テスト方法」の E2E 項目 16 / 17 / 19 / 27 の `message_type` / dual-send 前提の記述も更新する。

`## ファイル構成` の表に `send-prompt.sh` の行を追加する。

- [ ] **Step 9: `loop-mode.md` / `loop-mode-ja.md` を同期する**

`loop-mode.md:79` の質問リストから `message_type` の項目を削除し、以降の番号を詰める。
`:102` の表から行 8 を削除する。`loop-mode-ja.md:67` / `:86` も同様に直す。

- [ ] **Step 10: テストと doc-lang チェックを実行する**

```bash
cd apps/cmux-team-dispatch-task && bash test/test-send-prompt-callsites.sh
cd ../.. && pnpm check:doc-lang
```

期待: `PASS CS1` 〜 `PASS CS3` が出て exit 0、`check:doc-lang` も違反なしで終了。
`japanese-in-english-doc` が出たら、SKILL.md / loop-mode.md に日本語を書いてしまっているので英語に直す。

- [ ] **Step 11: バージョンを上げる**

`apps/cmux-team-dispatch-task/.claude-plugin/plugin.json` の `version` を `1.16.0` にする。
`.codex-plugin/plugin.json` が存在すれば同じ値にする。
ルートの `.claude-plugin/marketplace.json` の該当エントリの `version` も同期する。

- [ ] **Step 12: Commit**

```bash
git add apps/cmux-team-dispatch-task/ .claude-plugin/marketplace.json
git commit -m "docs(cmux-team-dispatch-task): 配送の一本化と message_type 廃止を全文書へ反映する"
```

---

### Task 9: E2E で詰まりが解消したことを確認する

**Files:**
- Modify: `docs/superpowers/specs/2026-08-12-delivery-verification-results.md`（E2E 結果を追記）

**Interfaces:**
- Consumes: Task 8 までのすべて
- Produces: なし（受け入れ確認）

- [ ] **Step 1: プラグインを再インストールする**

```bash
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins && bash install.sh
```

- [ ] **Step 2: レビューを伴う dispatch を 1 件流す**

任意のリポジトリで cmux-team-dispatch-task を起動し、`review_mode` を有効にして
1 タスクだけディスパッチする。Phase B-R のコードレビュー依頼が発生するところまで進める。

- [ ] **Step 3: 長文の依頼が届いたことを確認する**

レビュアーペインを見て、次を確認する。

- 入力欄（`❯` の行）が空であること — 依頼文が残っていないこと
- レビュアーが依頼を読んで動き出していること
- `.dispatch/<slug>/review/outbox/` に `review-code-1.md` が生成されていること
  （タイプ入力経路を通った場合。agmsg 経路なら生成されない）

- [ ] **Step 4: 完了通知が親に届いたことを確認する**

親セッションに `[dispatch] task ... finished` が届き、親の入力欄に残っていないことを確認する。

- [ ] **Step 5: 結果を追記して commit する**

`docs/superpowers/specs/2026-08-12-delivery-verification-results.md` の末尾に
「## E2E 結果」節を追加し、上記 4 点の観測を書く。

```bash
git add docs/superpowers/specs/2026-08-12-delivery-verification-results.md
git commit -m "docs(cmux-team-dispatch-task): 配送一本化の E2E 結果を記録する"
```

---

## セルフレビュー結果

**spec カバレッジ**

| spec の要求 | 実装タスク |
|------------|-----------|
| `send-prompt.sh` の新設と経路選択 | Task 2 |
| 閾値 400 文字でのファイル化 | Task 3 |
| settle 0.5 秒 + Enter 検証 3 回再送 | Task 4 |
| agmsg 失敗時のフォールバック | Task 2（実装）/ Task 5（回帰） |
| `read-screen` 失敗を観測失敗として扱う | Task 4（SP8） |
| V1 / V2 検証ゲート | Task 1 |
| `message_type` 廃止 | Task 7 |
| `prewarm.json` の `delivery` は残す | Task 7（`AGMSG_TEAM` 判定に置換するだけで `delivery` は触らない） |
| スクリプト 2 箇所の置換 | Task 6 |
| SKILL.md 5 箇所 + `REVIEW_INSTRUCTION` の置換 | Task 8 |
| `parallel-directive.sh` の文字制約維持 | Global Constraints（変更しない） |
| テスト `test-send-prompt.sh` | Task 2-5 |
| 既存テストの更新 | Task 6 Step 6 / Task 7 Step 6 |
| E2E 目視確認 | Task 9 |

**型・名前の一貫性**

- `send-prompt.sh` のフラグ名は Task 2 の Interfaces で定義した
  `--to-workspace` / `--to-surface` / `--agmsg-team` / `--agmsg-to` / `--agmsg-from` /
  `--label` / `--outbox-dir` / `--threshold` / `--retries` / `--settle` を全タスクで一貫して使用
- 環境変数は `CMUX_BIN` / `AGMSG_SEND` / `AGMSG_READY_DIR` で一貫
- テスト ID は `SP1`-`SP9`（send-prompt）、`CS1`-`CS3`（call sites）、`MT1`-`MT3`（message_type）で重複なし
- 終了コードは全タスクで `0` = 成功 / `1` = 配送失敗 / `2` = 使用法エラー
