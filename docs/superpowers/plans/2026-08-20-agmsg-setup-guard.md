# agmsg セットアップガード 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** agmsg が「インストール済み」ではなく「このセッションで実際に watcher が動いている」ことを判定し、
動いていなければその場でバックグラウンド watcher を起動する guard を追加して、`Monitor` ツールを持たない
ハーネスでも agmsg 配線がすべて定義済みの終了状態で終わるようにする。

**Architecture:** 新規スクリプト `ensure-agmsg-ready.sh` を各ペインが自分の初期プロンプトから 1 回実行する。
guard は自セッションの pidfile（`watch.<SID>.pid` / `watch.<SID>.<数字>.pid`）だけを候補として見て、
候補があれば何もせず、無ければ `nohup bash watch.sh <sid> <project> <type> <name> &` で起動する。
sentinel パスのエンコードは新規 `agmsg-path.sh` に切り出し、`send-prompt.sh` と共有する。

**Tech Stack:** bash 3.2 互換のシェルスクリプト、jq、既存のシェルテストスイート（`test/*.sh`）

**Spec:** `docs/superpowers/specs/2026-08-20-agmsg-setup-guard-design.md`（改訂 6）

## Global Constraints

- シェルは **bash 3.2 互換**。`set -u` 下で空になりうる配列は `${arr[@]+"${arr[@]}"}` で展開する。
- **`timeout` / `gtimeout` を使わない**（`apps/cmux-team-dispatch-task/CLAUDE.md` 項目 23）。
- コメント・コミットメッセージは**日本語**、識別子・CLI フラグは**英語**。
- `SKILL.md` と `*-ja.md` 以外の `references/*.md` に**日本語文字を 1 文字も書かない**
  （`node scripts/check-doc-lang.mjs` が hard gate）。
- `SKILL.md` / `references/**/*.md` に `cmux send` / `cmux send-key` のリテラルを入れない
  （`test/test-send-prompt-callsites.sh` の CS3）。
- パスのプレースホルダは編集箇所の周囲に合わせる（Step 1g 周辺は `<SKILL_DIR>`）。
- **バージョン番号を更新しない。push しない。PR を作らない。**
- `prewarm-panes.sh` を呼ぶテストは必ず先にワークツリーディレクトリを `mkdir -p` する
  （実リポジトリに対して `git worktree add` が走ると残骸が出る。本リポジトリで 2 回発生している）。
- `prewarm-panes.sh` は**自スクリプトディレクトリから新しいファイルを source / 実行してはならない**
  （テスト 5 本が `$TMP/scripts/` へ複製して実行する）。初期プロンプトへ**文字列として**埋め込むのは可。
- 検証ゲートは**リポジトリルートから**実行する（`check-doc-lang.mjs` は cwd 基準で `apps/` を走査するため、
  `apps/cmux-team-dispatch-task` を cwd にすると対象 0 件で無条件に OK になる）。

**用語**: 本計画で `SD` は
`apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts`、
`TD` は `apps/cmux-team-dispatch-task/test` を指す。

---

## File Structure

| ファイル | 責務 |
|---|---|
| `SD/agmsg-path.sh`（新規, source 専用） | sentinel パスのエンコード 1 つだけ。`AGMSG_DIR` にも `SKILL_DIR` にも依存しない純粋な文字列変換 |
| `SD/ensure-agmsg-ready.sh`（新規, 実行可能） | guard 本体。引数検証 → ログ → 配線 → 候補判定 → 起動 → 待機 → composite 検証 → 1 行出力 |
| `SD/send-prompt.sh`（修正） | sentinel パスの算出を `agmsg-path.sh` へ委譲。読めなければ生連結にフォールバック |
| `SD/prewarm-panes.sh`（修正） | 全ロールの初期プロンプトに guard を載せる。`delivery.sh` の出力漏れを塞ぐ。`prewarm.json` に `watcher` を書く |
| `SD/launch-workspace.sh`（修正） | runner script へ `AGMSG_EXPECTED_NAME` を export。`--agmsg-from` を値域検証。codex review に agmsg `run`/`db` の `--add-dir` を追加 |
| `TD/test-agmsg-ready.sh`（新規） | AR1-AR21。guard の全経路 |
| `TD/test-send-prompt.sh`（修正） | SP25 / SP26 |
| `TD/test-launch-workspace-codex.sh`（修正） | CR1 / CR1b / LW1 / LW2 |
| `TD/test-prewarm-layout.sh`（修正） | PW1-PW10 |
| `TD/test-prewarm-unattended.sh`（修正） | `assert_no_line_with` のガード強化 |
| `TD/test-agmsg-skill-block.sh`（新規） | AG1-AG4。`SKILL.md` のブロックを抽出して実行 |
| `SKILL.md` / `references/guide-ja.md` / `README.md` / `CLAUDE.md` / `docs/notification-gaps.md`（修正） | 4 ファイル整合 41 行 ＋ notification-gaps 2 行 |

---

### Task 1: sentinel パスのエンコーダ

**Files:**
- Create: `SD/agmsg-path.sh`
- Create: `TD/test-agmsg-ready.sh`

**Interfaces:**
- Consumes: なし
- Produces: `agmsg_encode_component <s>` → `[A-Za-z0-9._-]` 以外を `%XX` にした文字列を stdout へ。
  `agmsg_ready_path <ready_dir> <team> <agent>` → `<ready_dir>/ready.<enc team>__<enc agent>` を stdout へ。

- [ ] **Step 1: 失敗するテストを書く**

`TD/test-agmsg-ready.sh` を新規作成する。

```bash
#!/usr/bin/env bash
# ensure-agmsg-ready.sh と agmsg-path.sh の回帰テスト。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SD="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts"

fail=0
bad() { echo "FAIL: $1" >&2; fail=1; }

# --- AR17: エンコードのゴールデンベクタ ---
# shellcheck disable=SC1091
source "$SD/agmsg-path.sh"

check_enc() {  # <team> <agent> <expected basename>
  local got
  got=$(agmsg_ready_path /run "$1" "$2")
  [[ "$got" == "/run/$3" ]] || bad "AR17 enc('$1','$2') = $got (want /run/$3)"
}
check_enc 'dispatch-my repo'  parent   'ready.dispatch-my%20repo__parent'
check_enc 'dispatch-a%b'      parent   'ready.dispatch-a%25b__parent'
check_enc 'dispatch-日本'      parent   'ready.dispatch-%E6%97%A5%E6%9C%AC__parent'
check_enc 'dispatch-ok_1.2-3' x-review 'ready.dispatch-ok_1.2-3__x-review'

[[ $fail -eq 0 ]] && echo '--- all tests passed ---' || echo '--- failures ---'
exit "$fail"
```

- [ ] **Step 2: 失敗を確認する**

```bash
cd <repo root> && bash apps/cmux-team-dispatch-task/test/test-agmsg-ready.sh
```

Expected: FAIL。`agmsg-path.sh` が存在しないので `source` がエラーになり、
`agmsg_ready_path: command not found` で 4 件とも FAIL する。

- [ ] **Step 3: 最小の実装を書く**

`SD/agmsg-path.sh` を新規作成する。

```bash
#!/usr/bin/env bash
# agmsg-path.sh — agmsg の ready sentinel パスを組み立てる source 専用ヘルパー。
#
# agmsg 本体は ~/.agents/skills/agmsg/scripts/lib/actas-lock.sh:43-73 の
# _actas_lock_encode / agmsg_ready_path で [A-Za-z0-9._-] 以外を %XX へ変換した
# パスを作る。send-prompt.sh は長らく生連結しており、team 名に空白や非 ASCII が
# 入ると watcher が動いていても sentinel を見つけられなかった。
# 本ファイルはその規則を 1 箇所に置き、guard と send-prompt.sh で共有する。
# 上流の規則が変わっても検出できないので、追跡点として上記の行番号を残す。
#
# 提供関数:
#   agmsg_encode_component <s>              → %XX エンコード済み文字列
#   agmsg_ready_path <ready_dir> <t> <a>    → <ready_dir>/ready.<t>__<a>
#
# SKILL_DIR にも AGMSG_DIR にも依存しない純粋な文字列変換である。

agmsg_encode_component() {
  printf '%s' "$1" | LC_ALL=C awk '
    BEGIN { for (n = 0; n < 256; n++) ord[sprintf("%c", n)] = n }
    {
      for (i = 1; i <= length($0); i++) {
        c = substr($0, i, 1)
        if (c ~ /[A-Za-z0-9._\-]/) printf "%s", c
        else printf "%%%02X", ord[c]
      }
    }
  '
}

agmsg_ready_path() {
  local dir="$1" team agent
  team="$(agmsg_encode_component "$2")"
  agent="$(agmsg_encode_component "$3")"
  printf '%s/ready.%s__%s' "$dir" "$team" "$agent"
}
```

- [ ] **Step 4: テストが通ることを確認する**

```bash
cd <repo root> && bash apps/cmux-team-dispatch-task/test/test-agmsg-ready.sh
```

Expected: `--- all tests passed ---`、exit 0。

- [ ] **Step 5: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/agmsg-path.sh \
        apps/cmux-team-dispatch-task/test/test-agmsg-ready.sh
git commit -m "feat(cmux-team-dispatch-task): sentinel パスのエンコーダを切り出す"
```

---

### Task 2: `send-prompt.sh` をエンコーダへ切り替える

**Files:**
- Modify: `SD/send-prompt.sh`（`AGMSG_READY_DIR` 定義付近と sentinel 判定行）
- Modify: `TD/test-send-prompt.sh`（末尾へ SP25 / SP26 を追加）

**Interfaces:**
- Consumes: Task 1 の `agmsg_ready_path <ready_dir> <team> <agent>`
- Produces: なし

**不変条件（既存 SP0-SP24 を壊さないため）:**
- `AGMSG_SEND` は**そのまま維持**する。`AGMSG_DIR` へ寄せてはならない
  （`test-send-prompt.sh` は `AGMSG_SEND` と `AGMSG_READY_DIR` を個別に渡し `AGMSG_DIR` を設定しない）。
- `AGMSG_READY_DIR` の既定は現行のまま。明示指定を常に優先する。
- **lib が読めなくても die しない。** die は唯一の wake 手段の喪失を意味する。生連結へフォールバックする。

- [ ] **Step 1: 失敗するテストを書く**

`TD/test-send-prompt.sh` の末尾（`exit` の直前）へ追加する。既存のヘルパー名は
ファイル先頭を読んで合わせること。以下は最小の独立ケースとして書く形。

```bash
# --- SP25: sentinel パスが %XX エンコードされる ---
SP25_TMP=$(mktemp -d)
mkdir -p "$SP25_TMP/run" "$SP25_TMP/outbox"
# watch.sh が作るのと同じ綴りで sentinel を置く（空白 → %20）
: > "$SP25_TMP/run/ready.dispatch-my%20repo__reviewer"
: > "$SP25_TMP/agmsg-send.log"
cat > "$SP25_TMP/send.sh" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$AGMSG_SEND_LOG"
STUB
chmod +x "$SP25_TMP/send.sh"
CMUX_BIN="$SP25_TMP/cmux" AGMSG_SEND="$SP25_TMP/send.sh" \
AGMSG_SEND_LOG="$SP25_TMP/agmsg-send.log" AGMSG_READY_DIR="$SP25_TMP/run" \
bash "$BIN" --to-surface s1 --agmsg-team 'dispatch-my repo' --agmsg-to reviewer \
  --agmsg-from parent --label t --outbox-dir "$SP25_TMP/outbox" -- hello >/dev/null 2>&1
grep -q 'reviewer' "$SP25_TMP/agmsg-send.log" \
  || bad 'SP25 encoded sentinel path was not found (inbox record skipped)'
rm -rf "$SP25_TMP"

# --- SP26: agmsg-path.sh が無くても die しない ---
SP26_TMP=$(mktemp -d)
mkdir -p "$SP26_TMP/scripts" "$SP26_TMP/run" "$SP26_TMP/outbox"
cp "$BIN" "$SP26_TMP/scripts/send-prompt.sh"   # lib を持たないディレクトリへ複製
cat > "$SP26_TMP/cmux" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
chmod +x "$SP26_TMP/cmux"
CMUX_BIN="$SP26_TMP/cmux" AGMSG_READY_DIR="$SP26_TMP/run" \
bash "$SP26_TMP/scripts/send-prompt.sh" --to-surface s1 --label t \
  --outbox-dir "$SP26_TMP/outbox" -- hello >/dev/null 2>&1
[[ $? -eq 0 ]] || bad 'SP26 send-prompt.sh died without agmsg-path.sh'
rm -rf "$SP26_TMP"
```

`$BIN` は既存スイートが `send-prompt.sh` の絶対パスに使っている変数名。異なる場合は合わせる。
`cmux` スタブを SP25 でも用意する必要があるかはファイル先頭のヘルパーを読んで判断し、
既存ケースと同じ流儀に揃えること。

- [ ] **Step 2: 失敗を確認する**

```bash
cd <repo root> && bash apps/cmux-team-dispatch-task/test/test-send-prompt.sh
```

Expected: `SP25 encoded sentinel path was not found` で FAIL（生連結なので `%20` 版を見つけられない）。
SP26 は現状 PASS する（まだ source していないため）。

- [ ] **Step 3: 実装する**

`SD/send-prompt.sh` の環境変数定義の直後に `SCRIPT_DIR` を足し、`agmsg-path.sh` を optional source する。

```bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# sentinel パスのエンコードは agmsg-path.sh に一本化している。読めない場合でも
# die しない — send-prompt.sh の die は唯一の wake 手段の喪失を意味するため、
# 生連結へフォールバックして配送だけは必ず行う。
if [[ -r "$SCRIPT_DIR/agmsg-path.sh" ]]; then
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/agmsg-path.sh"
fi

# ready sentinel のパスを返す。agmsg-path.sh を読めていればエンコード、
# 読めていなければ従来どおりの生連結。
resolve_ready_path() {
  if declare -F agmsg_ready_path >/dev/null 2>&1; then
    agmsg_ready_path "$AGMSG_READY_DIR" "$1" "$2"
  else
    printf '%s/ready.%s__%s' "$AGMSG_READY_DIR" "$1" "$2"
  fi
}
```

sentinel を見ている条件式を差し替える。

```bash
# 修正前:
#   && [[ -f "$AGMSG_READY_DIR/ready.${TEAM}__${TO_AGENT}" ]]; then
# 修正後:
   && [[ -f "$(resolve_ready_path "$TEAM" "$TO_AGENT")" ]]; then
```

- [ ] **Step 4: テストが通ることを確認する**

```bash
cd <repo root> && bash apps/cmux-team-dispatch-task/test/test-send-prompt.sh
cd <repo root> && bash apps/cmux-team-dispatch-task/test/test-send-prompt-callsites.sh
```

Expected: 両方とも既存ケースを含めて全通過。

- [ ] **Step 5: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/send-prompt.sh \
        apps/cmux-team-dispatch-task/test/test-send-prompt.sh
git commit -m "fix(cmux-team-dispatch-task): sentinel パスをエンコードして send-prompt を揃える"
```

---

### Task 3: guard の骨格 — 引数検証・ログ・配線・出力契約

**Files:**
- Create: `SD/ensure-agmsg-ready.sh`
- Modify: `TD/test-agmsg-ready.sh`（共通ヘルパーと AR1 / AR2 / AR2b / AR2c / AR14 / AR15 / AR16a-f / AR18 を追加）

**Interfaces:**
- Consumes: Task 1 の `agmsg_ready_path`
- Produces: 実行可能スクリプト。CLI は
  `ensure-agmsg-ready.sh --type <claude-code|codex> --name <agent> [--project <path>]`。
  stdout は**常に 1 行 7 キー**
  `ensure-agmsg-ready: installed=… wired=… name=… watcher=… pid=… reason=… log=…`。
  exit 0 = 配線できた / 1 = 配線できない / 2 = 使用法エラー。
  `reason` の値域と各キーの実値は **spec の「出力」節の表が SoT** である。

- [ ] **Step 1: 共通ヘルパーと失敗するテストを書く**

`TD/test-agmsg-ready.sh` の AR17 の**前**に stub ツリーと共通ヘルパーを置く。

```bash
TMP=$(mktemp -d)
trap 'cleanup_all' EXIT
FIXTURE_PIDS=()
cleanup_all() {
  local p
  for p in ${FIXTURE_PIDS[@]+"${FIXTURE_PIDS[@]}"}; do kill "$p" 2>/dev/null || true; done
  rm -rf "$TMP"
}

GUARD="$SD/ensure-agmsg-ready.sh"
export AGMSG_DIR="$TMP/stub/scripts"
export AGMSG_READY_DIR="$TMP/stub/run"
export AGMSG_LOG_DIR="$TMP/logs"
export AGMSG_STUB_LOG="$TMP/stub.log"
export AGMSG_READY_TIMEOUT=1
mkdir -p "$AGMSG_DIR" "$AGMSG_READY_DIR" "$AGMSG_LOG_DIR"

# 安全装置: stub を指していない状態で走らせると実機の watcher を kill しうる
[[ "$AGMSG_DIR" == "$TMP"/* && "$AGMSG_READY_DIR" == "$TMP"/* ]] || exit 2

: > "$AGMSG_DIR/send.sh"
cat > "$AGMSG_DIR/delivery.sh" <<'STUB'
#!/usr/bin/env bash
echo "delivery|$*" >> "$AGMSG_STUB_LOG"
echo 'AGMSG-DIRECTIVE: stub'
exit "${AGMSG_STUB_DELIVERY_RC:-0}"
STUB
chmod +x "$AGMSG_DIR/delivery.sh"

cat > "$AGMSG_DIR/watch.sh" <<'STUB'
#!/usr/bin/env bash
printf '%s|%s\n' "${AGMSG_WATCH_INTERVAL:-}" "$*" >> "$AGMSG_STUB_LOG"
sentinel="$AGMSG_READY_DIR/ready.t__$4"
pidfile="$AGMSG_READY_DIR/watch.$AGMSG_STUB_INSTANCE_ID.pid"
write_ready() { [[ $# -ge 4 ]] && { printf '%s\n' "$AGMSG_STUB_INSTANCE_ID" > "$sentinel"; printf '%s\n' "$$" > "$pidfile"; }; }
case "${AGMSG_STUB_MODE:-alive}" in
  alive)              write_ready "$@"; sleep 300 ;;
  sentinel-then-exit) write_ready "$@"; exit 0 ;;
  no-sentinel)        printf '%s\n' "$$" > "$pidfile"; sleep 300 ;;
  held)               echo 'agmsg watch: cannot claim (held by other sessions): x' >&2; exit 1 ;;
  unregistered)       echo "agmsg watch: no registration for agent 'x'"; exit 0 ;;
  db-error)           echo 'ERROR: cannot open message DB /x'; exit 1 ;;
  silent-exit)        exit 0 ;;
  decoy)              echo '2026-01-01 | t | a - b | agmsg watch: cannot claim'; write_ready "$@"; sleep 300 ;;
esac
STUB
chmod +x "$AGMSG_DIR/watch.sh"

reset_case() {
  rm -rf "${AGMSG_READY_DIR:?}"/* "${AGMSG_LOG_DIR:?}"/* 2>/dev/null || true
  : > "$AGMSG_STUB_LOG"
}

# 出力契約の検証。全ケースで呼ぶ。
assert_line() {  # <output>
  local out="$1"
  [[ $(printf '%s' "$out" | wc -l | tr -d ' ') -eq 0 ]] || bad "output is not a single line: $out"
  local k
  for k in installed wired name watcher pid reason log; do
    [[ "$out" == *" $k="* ]] || bad "output is missing key '$k': $out"
  done
  [[ "$out" == ensure-agmsg-ready:* ]] || bad "output has no prefix: $out"
}

run_guard() {  # 追加の引数をそのまま渡す。stdout を返し、rc を GUARD_RC に入れる
  local out
  GUARD_RC=0
  out=$(bash "$GUARD" "$@" 2>"$TMP/stderr.txt") || GUARD_RC=$?
  printf '%s' "$out"
}
```

続けてケースを書く。

```bash
# --- AR16a-f: exit 2 ---
reset_case; out=$(run_guard --name x); assert_line "$out"
[[ $GUARD_RC -eq 2 && "$out" == *"reason=usage"* ]] || bad 'AR16a missing --type'
reset_case; out=$(run_guard --type claude-code); assert_line "$out"
[[ $GUARD_RC -eq 2 ]] || bad 'AR16b missing --name'
reset_case; out=$(run_guard --type claude-code --name x --bogus)
[[ $GUARD_RC -eq 2 ]] || bad 'AR16c unknown flag'
reset_case; out=$(run_guard --type grok --name x)
[[ $GUARD_RC -eq 2 ]] || bad 'AR16d bad --type'
reset_case; out=$(run_guard --type claude-code --name 'a b'); assert_line "$out"
[[ $GUARD_RC -eq 2 && "$out" == *" name=- "* ]] || bad 'AR16e bad --name must print name=-'
reset_case; out=$(AGMSG_EXPECTED_NAME=other run_guard --type claude-code --name x)
[[ $GUARD_RC -eq 2 ]] || bad 'AR16f AGMSG_EXPECTED_NAME mismatch'
[[ ! -s "$AGMSG_STUB_LOG" ]] || bad 'AR16 must not call delivery.sh or watch.sh'

# --- AR1: 未インストール ---
reset_case; mv "$AGMSG_DIR/send.sh" "$TMP/send.sh.bak"
out=$(run_guard --type claude-code --name ar-$$-1); assert_line "$out"
[[ $GUARD_RC -eq 1 && "$out" == *"reason=not-installed"* ]] || bad 'AR1'
grep -q 'not installed' "$TMP/stderr.txt" || bad 'AR1 stderr hint'
mv "$TMP/send.sh.bak" "$AGMSG_DIR/send.sh"

# --- AR14: delivery.sh 失敗 ---
reset_case
out=$(AGMSG_STUB_DELIVERY_RC=1 run_guard --type claude-code --name ar-$$-14); assert_line "$out"
[[ $GUARD_RC -eq 1 && "$out" == *"reason=delivery-set-failed"* ]] || bad 'AR14'
grep -q 'watch.sh' "$AGMSG_STUB_LOG" && bad 'AR14 must not launch watch.sh'

# --- AR13: AGMSG-DIRECTIVE が stdout へ漏れない ---
[[ "$out" == *"AGMSG-DIRECTIVE"* ]] && bad 'AR13 directive leaked to stdout'

# --- AR2 / AR2c: ログを作れない ---
reset_case; : > "$TMP/afile"
out=$(AGMSG_LOG_DIR="$TMP/afile/sub" AGMSG_STUB_MODE=alive AGMSG_STUB_INSTANCE_ID="s.1" \
      CLAUDE_CODE_SESSION_ID=s run_guard --type claude-code --name ar-$$-2)
assert_line "$out"
[[ $GUARD_RC -eq 0 && "$out" == *"reason=log-unwritable"* ]] || bad 'AR2 reason'
grep -q 'watch.sh' "$AGMSG_STUB_LOG" || bad 'AR2 must still launch the watcher'
[[ -c /dev/null ]] || bad 'AR2c /dev/null was removed'

# --- AR2b: TMPDIR 未設定でも log-unwritable にならない ---
reset_case
out=$(env -u TMPDIR -u AGMSG_LOG_DIR AGMSG_STUB_MODE=held CLAUDE_CODE_SESSION_ID=s \
      bash "$GUARD" --type claude-code --name ar-$$-2b 2>/dev/null)
[[ "$out" != *"reason=log-unwritable"* ]] || bad 'AR2b'

# --- AR15: session id の取り方 ---
reset_case
out=$(CLAUDE_CODE_SESSION_ID=cc-sid CODEX_THREAD_ID=cx-sid AGMSG_STUB_MODE=silent-exit \
      run_guard --type claude-code --name ar-$$-15)
grep -q '|cc-sid ' "$AGMSG_STUB_LOG" || bad 'AR15 claude-code must use CLAUDE_CODE_SESSION_ID'
reset_case
out=$(CLAUDE_CODE_SESSION_ID=cc-sid CODEX_THREAD_ID=cx-sid AGMSG_STUB_MODE=silent-exit \
      run_guard --type codex --name ar-$$-15b)
grep -q '|cx-sid ' "$AGMSG_STUB_LOG" || bad 'AR15 codex must use CODEX_THREAD_ID'
reset_case
out=$(env -u CLAUDE_CODE_SESSION_ID -u CODEX_THREAD_ID AGMSG_STUB_MODE=silent-exit \
      bash "$GUARD" --type claude-code --name ar-$$-15c 2>/dev/null)
grep -q '|- ' "$AGMSG_STUB_LOG" && bad 'AR15 must not pass the "-" sentinel'
```

- [ ] **Step 2: 失敗を確認する**

```bash
cd <repo root> && bash apps/cmux-team-dispatch-task/test/test-agmsg-ready.sh
```

Expected: FAIL。`ensure-agmsg-ready.sh` が存在しないので全ケースが落ちる。

- [ ] **Step 3: 実装する**

`SD/ensure-agmsg-ready.sh` を新規作成する。**この Task では手順 5〜9（候補判定・起動・待機・
composite 検証）を実装しない。** 代わりに、配線に成功したら常に起動して sentinel を
`AGMSG_READY_TIMEOUT` まで待ち、出れば `watcher=started`、出なければ `watcher=none reason=watcher-exited`
とする暫定実装にする。Task 4 と Task 5 で置き換える。

```bash
#!/usr/bin/env bash
set -uo pipefail

# ensure-agmsg-ready.sh — このセッションで agmsg の inbox watcher が動いていることを保証する。
#
# 背景: delivery.sh set は「Monitor ツールを呼べ」という AGMSG-DIRECTIVE を印字するが、
# その ツールを持たないハーネスでは追従不能で watcher が起動しない。本スクリプトは
# watcher の有無を自分で判定し、無ければ nohup で起動する。
# 詳細は docs/superpowers/specs/2026-08-20-agmsg-setup-guard-design.md を参照。
#
# 出力は常に 1 行 7 キー。exit 0 = 配線できた / 1 = 配線できない / 2 = 使用法エラー。
# **watcher を起動できなかったことは決して exit 1 にしない。**

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/agmsg-path.sh"

AGMSG_DIR="${AGMSG_DIR:-$HOME/.agents/skills/agmsg/scripts}"
# AGMSG_DIR は比較に使うので絶対パス化する (~ を残さない)
case "$AGMSG_DIR" in "~"*) AGMSG_DIR="$HOME${AGMSG_DIR#\~}" ;; esac
AGMSG_READY_DIR="${AGMSG_READY_DIR:-$(dirname "$AGMSG_DIR")/run}"
AGMSG_LOG_DIR="${AGMSG_LOG_DIR:-${TMPDIR:-$HOME/.cache}/agmsg}"
AGMSG_READY_TIMEOUT="${AGMSG_READY_TIMEOUT:-15}"
AGMSG_WATCH_INTERVAL="${AGMSG_WATCH_INTERVAL:-30}"

TYPE=""; NAME=""; PROJECT="$PWD"
INSTALLED=no; WIRED=no; WATCHER=none; PID="-"; REASON="-"; LOG="-"

emit() {  # 常にこれ 1 回だけで出力する
  printf 'ensure-agmsg-ready: installed=%s wired=%s name=%s watcher=%s pid=%s reason=%s log=%s\n' \
    "$INSTALLED" "$WIRED" "${NAME:--}" "$WATCHER" "$PID" "$REASON" "$LOG"
}
hint() { printf 'ensure-agmsg-ready: %s\n' "$1" >&2; }
die_usage() {
  REASON=usage
  hint "usage: ensure-agmsg-ready.sh --type <claude-code|codex> --name <agent> [--project <path>]"
  emit
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --type)    [[ $# -ge 2 ]] || die_usage; TYPE="$2"; shift 2 ;;
    --name)    [[ $# -ge 2 ]] || die_usage; NAME="$2"; shift 2 ;;
    --project) [[ $# -ge 2 ]] || die_usage; PROJECT="$2"; shift 2 ;;
    *) die_usage ;;
  esac
done

[[ -n "$TYPE" && -n "$NAME" ]] || die_usage
[[ "$TYPE" == claude-code || "$TYPE" == codex ]] || die_usage
# --name は $LOG のファイル名へ生連結されるので値域を必ず検証する。
# 通らない値は name= にも出さない (1 行契約が壊れるため)。
if ! [[ "$NAME" =~ ^[A-Za-z0-9._-]+$ ]]; then NAME=""; die_usage; fi
[[ -d "$PROJECT" ]] || die_usage
# AGMSG_EXPECTED_NAME はセキュリティ境界ではなく、配線ミスの早期検出である。
if [[ -n "${AGMSG_EXPECTED_NAME:-}" && "$AGMSG_EXPECTED_NAME" != "$NAME" ]]; then die_usage; fi

# --- 手順 2: インストール確認 ---
if [[ ! -f "$AGMSG_DIR/send.sh" ]]; then
  REASON=not-installed; hint "agmsg is not installed at $AGMSG_DIR"; emit; exit 1
fi
INSTALLED=yes

# --- 手順 3: ログの用意 ---
mkdir -p "$AGMSG_LOG_DIR" 2>/dev/null || true
LOG_PATH="$(umask 077; mktemp "$AGMSG_LOG_DIR/agmsg-watch-$NAME.XXXXXX" 2>/dev/null || true)"
if [[ -z "$LOG_PATH" ]]; then
  LOG_PATH=/dev/null
  REASON=log-unwritable
  hint "cannot create a log under $AGMSG_LOG_DIR; diagnostics disabled"
else
  LOG="$LOG_PATH"
fi

# --- 手順 4: 配線 ---
# stdout も stderr もログへ落とす。/dev/null ではないのは、AGMSG-DIRECTIVE と codex の
# シェル shim 手順を呼び出し元へ漏らさずに事後解析だけは残すため。
if ! bash "$AGMSG_DIR/delivery.sh" set monitor "$TYPE" "$PROJECT" >>"$LOG_PATH" 2>&1; then
  REASON=delivery-set-failed; hint "see $LOG"; emit; exit 1
fi
WIRED=yes

# --- session id ---
SID=""
[[ "$TYPE" == claude-code ]] && SID="${CLAUDE_CODE_SESSION_ID:-}"
[[ "$TYPE" == codex ]] && SID="${CODEX_THREAD_ID:-}"
if [[ -z "$SID" ]]; then
  # "-" は渡さない。watch.sh に採番させると起動ごとに別 uuid になり、
  # 同一ペインで 2 回走ったとき 2 本目が 1 本目に held される。
  if command -v uuidgen >/dev/null 2>&1; then
    SID="agmsg-$(uuidgen | tr 'A-Z' 'a-z')"
  else
    SID="agmsg-$$-$(date +%s)"
  fi
fi
[[ "$SID" =~ ^[A-Za-z0-9._-]+$ ]] || SID="agmsg-$$"

# --- 手順 5-9 は Task 4 / Task 5 で実装する。暫定: 常に起動して待つ ---
AGMSG_WATCH_INTERVAL="$AGMSG_WATCH_INTERVAL" \
nohup bash "$AGMSG_DIR/watch.sh" "$SID" "$PROJECT" "$TYPE" "$NAME" </dev/null >>"$LOG_PATH" 2>&1 &
WATCH_PID=$!

deadline=$(( AGMSG_READY_TIMEOUT * 5 ))
found=""
for _ in $(seq 1 "$deadline"); do
  if compgen -G "$AGMSG_READY_DIR/ready.*__$(agmsg_encode_component "$NAME")" >/dev/null 2>&1; then
    found=1; break
  fi
  sleep 0.2
done
if [[ -n "$found" ]]; then
  WATCHER=started; PID="$WATCH_PID"
else
  WATCHER=none; [[ "$REASON" == "-" ]] && REASON=watcher-exited; hint "see $LOG"
fi
emit
exit 0
```

- [ ] **Step 4: テストが通ることを確認する**

```bash
chmod +x apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/ensure-agmsg-ready.sh
cd <repo root> && bash -n apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/ensure-agmsg-ready.sh
cd <repo root> && bash apps/cmux-team-dispatch-task/test/test-agmsg-ready.sh
```

Expected: `--- all tests passed ---`。

- [ ] **Step 5: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/ensure-agmsg-ready.sh \
        apps/cmux-team-dispatch-task/test/test-agmsg-ready.sh
git commit -m "feat(cmux-team-dispatch-task): agmsg guard の引数検証と配線を実装する"
```

---

### Task 4: guard の候補判定（中核方針 2）

**Files:**
- Modify: `SD/ensure-agmsg-ready.sh`（手順 5・6 を実装し、暫定の「常に起動」を置き換える）
- Modify: `TD/test-agmsg-ready.sh`（AR3 / AR3b-k / AR4 / AR4b / AR5 を追加）

**Interfaces:**
- Consumes: Task 3 の `$SID` / `$AGMSG_READY_DIR` / `emit` / `hint`
- Produces: シェル関数
  `guard_normalized_id_from_pidfile <path>` → pidfile 名から正規化 id、
  `guard_is_composite <id>` → 0/1、
  `guard_pid_alive <pid>` → 0/1（`_agmsg_pid_alive_local` と同じ意味論）、
  `guard_is_watcher <pid>` → 0/1（フルパス cmdline 照合）、
  `guard_name_slot <pid>` → argv の 5 番目のトークン

- [ ] **Step 1: 失敗するテストを書く**

`TD/test-agmsg-ready.sh` へ追加する。fixture watcher を起こすヘルパーを先に置く。

```bash
start_fixture() {  # <instance_id> <sid> <project> <type> [<name>] → pid を FIXTURE_PIDS へ
  local iid="$1"; shift
  AGMSG_STUB_INSTANCE_ID="$iid" AGMSG_STUB_MODE=alive \
    nohup bash "$AGMSG_DIR/watch.sh" "$@" </dev/null >/dev/null 2>&1 &
  local p=$!
  FIXTURE_PIDS+=("$p")
  printf '%s\n' "$p" > "$AGMSG_READY_DIR/watch.$iid.pid"
  sleep 0.3
  printf '%s' "$p"
}

# --- AR3: 自セッション・composite・名前一致 → existing ---
reset_case
start_fixture "s3.111" s3 /p claude-code "ar-$$-3" >/dev/null
: > "$AGMSG_STUB_LOG"
out=$(CLAUDE_CODE_SESSION_ID=s3 run_guard --type claude-code --name "ar-$$-3"); assert_line "$out"
[[ "$out" == *"watcher=existing"* ]] || bad 'AR3 existing'
grep -q 'watch.sh' "$AGMSG_STUB_LOG" && bad 'AR3 must not launch a new watcher'

# --- AR3i: existing を返しても既存 watcher を kill しない ---
existing_pid=$(cat "$AGMSG_READY_DIR/watch.s3.111.pid")
kill -0 "$existing_pid" 2>/dev/null || bad 'AR3i the existing watcher was killed'
ls "$AGMSG_READY_DIR"/ready.* >/dev/null 2>&1 || bad 'AR3i the sentinel was removed'

# --- AR3d: 同一セッション・別ロール → existing-other ---
reset_case
start_fixture "s3d.111" s3d /p claude-code "ar-$$-3d-claude" >/dev/null
: > "$AGMSG_STUB_LOG"
out=$(CLAUDE_CODE_SESSION_ID=s3d run_guard --type claude-code --name "ar-$$-3d")
[[ "$out" == *"watcher=existing-other"* ]] || bad 'AR3d existing-other'
grep -q 'watch.sh' "$AGMSG_STUB_LOG" && bad 'AR3d must not launch'

# --- AR3e: broad ($# 3) → existing-other ---
reset_case
start_fixture "s3e.111" s3e /p claude-code >/dev/null
: > "$AGMSG_STUB_LOG"
out=$(CLAUDE_CODE_SESSION_ID=s3e run_guard --type claude-code --name "ar-$$-3e")
[[ "$out" == *"watcher=existing-other"* ]] || bad 'AR3e broad'

# --- AR3c: 別セッションの同名は候補にせず起動する ---
reset_case
start_fixture "other.111" other /p claude-code "ar-$$-3c" >/dev/null
: > "$AGMSG_STUB_LOG"
out=$(CLAUDE_CODE_SESSION_ID=s3c AGMSG_STUB_MODE=held run_guard --type claude-code --name "ar-$$-3c")
[[ "$out" == *"reason=held-by-other-session"* ]] || bad 'AR3c must attempt and report held'
grep -q 'drop' "$TMP/stderr.txt" || bad 'AR3c recovery hint'

# --- AR3j: bare は候補にせず起動する。bare は kill しない ---
reset_case
bare_pid=$(start_fixture "s3j" s3j /p claude-code "ar-$$-3j")
: > "$AGMSG_STUB_LOG"
out=$(CLAUDE_CODE_SESSION_ID=s3j AGMSG_STUB_MODE=silent-exit run_guard --type claude-code --name "ar-$$-3j")
grep -q 'watch.sh' "$AGMSG_STUB_LOG" || bad 'AR3j must launch despite the bare candidate'
kill -0 "$bare_pid" 2>/dev/null || bad 'AR3j must not kill the bare watcher'
grep -q 'bare instance id' "$TMP/stderr.txt" || bad 'AR3j hint'

# --- AR3k: --name codex が型引数へ誤ヒットしない ---
reset_case
start_fixture "s3k.111" s3k /p codex >/dev/null
: > "$AGMSG_STUB_LOG"
out=$(CODEX_THREAD_ID=s3k run_guard --type codex --name codex)
[[ "$out" == *"watcher=existing-other"* ]] || bad 'AR3k name slot must be positional'

# --- AR4: 候補の pid が死んでいれば起動する ---
reset_case
printf '%s\n' 999999 > "$AGMSG_READY_DIR/watch.s4.111.pid"
: > "$AGMSG_STUB_LOG"
out=$(CLAUDE_CODE_SESSION_ID=s4 AGMSG_STUB_MODE=silent-exit run_guard --type claude-code --name "ar-$$-4")
grep -q 'watch.sh' "$AGMSG_STUB_LOG" || bad 'AR4 must launch when the candidate pid is dead'

# --- AR3h: 候補ゼロなら ps が空でも起動する ---
reset_case
mkdir -p "$TMP/nops"; printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/nops/ps"; chmod +x "$TMP/nops/ps"
: > "$AGMSG_STUB_LOG"
out=$(PATH="$TMP/nops:$PATH" CLAUDE_CODE_SESSION_ID=s3h AGMSG_STUB_MODE=silent-exit \
      run_guard --type claude-code --name "ar-$$-3h")
grep -q 'watch.sh' "$AGMSG_STUB_LOG" || bad 'AR3h must launch when there is no candidate'

# --- AR3g: 候補があり ps が空 → existing-other ---
reset_case
start_fixture "s3g.111" s3g /p claude-code "ar-$$-3g" >/dev/null
: > "$AGMSG_STUB_LOG"
out=$(PATH="$TMP/nops:$PATH" CLAUDE_CODE_SESSION_ID=s3g run_guard --type claude-code --name "ar-$$-3g")
[[ "$out" == *"watcher=existing-other"* ]] || bad 'AR3g'
grep -q 'watch.sh' "$AGMSG_STUB_LOG" && bad 'AR3g must not launch'

# --- AR5: 生きた owner の sentinel を消さない / 死んだものは消す ---
reset_case
enc=$(bash -c "source '$SD/agmsg-path.sh'; agmsg_encode_component 'ar-$$-5'")
printf 'alive.1\n' > "$AGMSG_READY_DIR/ready.t__$enc"
printf '%s\n' "$$" > "$AGMSG_READY_DIR/watch.alive.1.pid"
out=$(CLAUDE_CODE_SESSION_ID=s5 AGMSG_STUB_MODE=silent-exit run_guard --type claude-code --name "ar-$$-5")
[[ -f "$AGMSG_READY_DIR/ready.t__$enc" ]] || bad 'AR5 must keep a sentinel whose pidfile pid is alive'
reset_case
printf 'dead.1\n' > "$AGMSG_READY_DIR/ready.t__$enc"
out=$(CLAUDE_CODE_SESSION_ID=s5b AGMSG_STUB_MODE=silent-exit run_guard --type claude-code --name "ar-$$-5")
[[ -f "$AGMSG_READY_DIR/ready.t__$enc" ]] && bad 'AR5 must remove a sentinel with no pidfile'
```

`AR3b`（zsh ラッパー除外）と `AR4b`（EPERM）は次の形で足す。

```bash
# --- AR3b: argv[0]/argv[1] が watch.sh でないプロセスは候補にしない ---
reset_case
nohup /bin/sh -c "sleep 300 # $AGMSG_DIR/watch.sh s3b /p claude-code ar-$$-3b" </dev/null >/dev/null 2>&1 &
FIXTURE_PIDS+=($!)
printf '%s\n' "$!" > "$AGMSG_READY_DIR/watch.s3b.111.pid"
sleep 0.3; : > "$AGMSG_STUB_LOG"
out=$(CLAUDE_CODE_SESSION_ID=s3b AGMSG_STUB_MODE=silent-exit run_guard --type claude-code --name "ar-$$-3b")
grep -q 'watch.sh' "$AGMSG_STUB_LOG" || bad 'AR3b wrapper shell must not count as a candidate'

# --- AR4b: EPERM を生存として扱う ---
reset_case
mkdir -p "$TMP/eperm"
cat > "$TMP/eperm/kill" <<'STUB'
#!/usr/bin/env bash
# -0 は必ず "not permitted" で失敗させる (EPERM のシミュレーション)
if [[ "${1:-}" == "-0" ]]; then echo "kill: ($2) - Operation not permitted" >&2; exit 1; fi
exec /bin/kill "$@"
STUB
chmod +x "$TMP/eperm/kill"
start_fixture "s4b.111" s4b /p claude-code "ar-$$-4b" >/dev/null
: > "$AGMSG_STUB_LOG"
out=$(PATH="$TMP/eperm:$PATH" CLAUDE_CODE_SESSION_ID=s4b run_guard --type claude-code --name "ar-$$-4b")
grep -q 'watch.sh' "$AGMSG_STUB_LOG" && bad 'AR4b EPERM must be treated as alive'
```

- [ ] **Step 2: 失敗を確認する**

```bash
cd <repo root> && bash apps/cmux-team-dispatch-task/test/test-agmsg-ready.sh
```

Expected: AR3 系がすべて FAIL（暫定実装は候補を見ずに必ず起動するため）。

- [ ] **Step 3: 実装する**

`SD/ensure-agmsg-ready.sh` の「暫定」ブロックの**前**に共通ルールの関数群を置き、
暫定ブロックの先頭に候補判定を挿す。

```bash
# --- 共通ルール ---
# 正規化 id は pidfile 名そのもの。剥がしは session-start.sh:221 と同形。
guard_normalized_id_from_pidfile() {
  local id=${1##*/}; id=${id#watch.}; id=${id%.pid}; printf '%s' "$id"
}

# agmsg_instance_is_composite (instance-id.sh:171-183) の 3 条件を逐語で写す。
guard_is_composite() {
  local token="$1" pid prefix
  case "$token" in *.*) ;; *) return 1 ;; esac
  pid="${token##*.}"; prefix="${token%.*}"
  [[ -n "$prefix" ]] || return 1
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  return 0
}

# _agmsg_pid_alive_local (instance-id.sh:112-139) と同じ意味論。
# 素の kill -0 は「シグナルを送れるか」であって生存判定ではない。EPERM を
# 「死」と読むと、注入中の watcher を kill したり生きた sentinel を消したりする。
guard_pid_alive() {
  local pid="$1" err stat
  case "$pid" in ''|*[!0-9]*|0*) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null && return 0
  err="$(export LC_ALL=C; kill -0 "$pid" 2>&1)" && return 0
  case "$err" in
    *[Nn]'o such process'*) ;;
    *) return 0 ;;   # EPERM とその他は生存
  esac
  stat="$(ps -o stat= -p "$pid" 2>/dev/null | tr -d ' ')"
  [[ -n "$stat" ]] || return 1
  case "$stat" in Z*) return 1 ;; esac
  return 0
}

guard_args() { ps -ww -p "$1" -o args= 2>/dev/null; }

# argv[0] または argv[1] が $AGMSG_DIR/watch.sh とフルパスで等価であること。
# agmsg 本体より厳しいが、Claude Code の Bash ツールが張るラッパーシェル
# (argv[0]=/bin/zsh, argv[1]=-c) を確実に落とすために意図的にそうする。
guard_is_watcher() {
  local args a1 a2
  args="$(guard_args "$1")"; [[ -n "$args" ]] || return 2   # 2 = 判定不能
  # shellcheck disable=SC2086
  set -f; set -- $args; set +f
  a1="${1:-}"; a2="${2:-}"
  [[ "$a1" == "$AGMSG_DIR/watch.sh" || "$a2" == "$AGMSG_DIR/watch.sh" ]]
}

# 名前スロット = watch.sh を 1 番目に数えた 5 番目のトークン。
# 「argv のどこかに含まれる」だと型引数 (claude-code/codex) やパスの
# 1 コンポーネントが --name と一致して誤ヒットする。
guard_name_slot() {
  local args; args="$(guard_args "$1")"; [[ -n "$args" ]] || return 1
  # shellcheck disable=SC2086
  set -f; set -- $args; set +f
  local i=0 t
  for t in "$@"; do
    i=$((i + 1))
    if [[ "$t" == "$AGMSG_DIR/watch.sh" ]]; then
      shift $((i - 1)); printf '%s' "${5:-}"; return 0
    fi
  done
  return 1
}
```

候補判定（暫定ブロックの先頭に挿入）。

```bash
# --- 手順 5: 候補の判定 ---
# 自分の起動が壊しうるのは「正規化 id が自分と同じ watcher」だけ (watch.sh:165-179)。
# 正規化 id は必ず $SID か $SID.<pid> になるので、この 2 形だけを見る。
CAND_PID=""; CAND_KIND=""
for f in "$AGMSG_READY_DIR"/watch.*.pid; do
  [[ -f "$f" ]] || continue
  id="$(guard_normalized_id_from_pidfile "$f")"
  case "$id" in
    "$SID") ;;
    "$SID".*) [[ "${id#"$SID".}" =~ ^[0-9]+$ ]] || continue ;;
    *) continue ;;
  esac
  p="$(head -1 "$f" 2>/dev/null || true)"
  guard_pid_alive "$p" || continue
  # bare は自分の起動 (composite の pidfile) と衝突しないので候補にしない。
  # かつ bare は永久に自己終了しないので、候補に数えると恒久ブロックになる。
  if ! guard_is_composite "$id"; then
    hint "a watcher with a bare instance id is running for this role (pid $p); it will never self-terminate - kill it manually"
    continue
  fi
  guard_is_watcher "$p"; rc=$?
  [[ $rc -eq 1 ]] && continue                      # watcher ではない
  if [[ $rc -eq 2 ]]; then                          # argv 不明 → 名前を判定できない
    CAND_PID="${CAND_PID:-$p}"; CAND_KIND=other; continue
  fi
  if [[ "$(guard_name_slot "$p" || true)" == "$NAME" ]]; then
    CAND_PID="$p"; CAND_KIND=mine; break
  fi
  CAND_PID="${CAND_PID:-$p}"; CAND_KIND="${CAND_KIND:-other}"
done

if [[ -n "$CAND_KIND" ]]; then
  PID="$CAND_PID"
  [[ "$CAND_KIND" == mine ]] && WATCHER=existing || WATCHER=existing-other
  emit; exit 0
fi

# --- 手順 6: stale sentinel の掃除 ---
# 生きた watcher の sentinel を消すと再作成されない (watch.sh:385-395 は起動時 1 回のみ)
# ので、pidfile の pid が生きているものは絶対に消さない。
for s in "$AGMSG_READY_DIR"/ready.*__"$(agmsg_encode_component "$NAME")"; do
  [[ -f "$s" ]] || continue
  t="$(head -1 "$s" 2>/dev/null || true)"
  if [[ -n "$t" && -f "$AGMSG_READY_DIR/watch.$t.pid" ]] \
     && guard_pid_alive "$(head -1 "$AGMSG_READY_DIR/watch.$t.pid" 2>/dev/null || true)"; then
    continue
  fi
  rm -f "$s"
done
```

- [ ] **Step 4: テストが通ることを確認する**

```bash
cd <repo root> && bash -n apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/ensure-agmsg-ready.sh
cd <repo root> && bash apps/cmux-team-dispatch-task/test/test-agmsg-ready.sh
```

Expected: `--- all tests passed ---`。

- [ ] **Step 5: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/ensure-agmsg-ready.sh \
        apps/cmux-team-dispatch-task/test/test-agmsg-ready.sh
git commit -m "feat(cmux-team-dispatch-task): guard の候補判定を自セッションへ限定する"
```

---

### Task 5: guard の起動・待機・分類・composite 検証

**Files:**
- Modify: `SD/ensure-agmsg-ready.sh`（暫定の待機ブロックを手順 7-10 の実装で置き換える）
- Modify: `TD/test-agmsg-ready.sh`（AR6 / AR6b-d / AR7 / AR8 / AR9a-e / AR10 / AR10b / AR11 / AR11b / AR12 / AR19 / AR20 / AR21 を追加）

**Interfaces:**
- Consumes: Task 4 の `guard_*` 関数群
- Produces: なし（guard の完成形）

- [ ] **Step 1: 失敗するテストを書く**

```bash
# --- AR6: 正常系 ---
reset_case
out=$(CLAUDE_CODE_SESSION_ID=s6 AGMSG_STUB_INSTANCE_ID="s6.222" AGMSG_STUB_MODE=alive \
      run_guard --type claude-code --name "ar-$$-6"); assert_line "$out"
[[ $GUARD_RC -eq 0 && "$out" == *"watcher=started"* && "$out" == *" log=- "* ]] || bad 'AR6'
[[ -f "$AGMSG_READY_DIR/watch.s6.222.pid" ]] || bad 'AR6 pidfile must be composite'
ls "$AGMSG_LOG_DIR"/agmsg-watch-* >/dev/null 2>&1 && bad 'AR6 the log must be removed on success'
# AR7: pid が watch.sh 本体であること
pid=$(printf '%s' "$out" | sed -n 's/.* pid=\([0-9]*\) .*/\1/p')
guard_ps=$(ps -ww -p "$pid" -o args= 2>/dev/null)
[[ "$guard_ps" == *"$AGMSG_DIR/watch.sh"* ]] || bad 'AR7 pid is not the watch.sh process'
# AR20: interval が export される
grep -q '^30|' "$AGMSG_STUB_LOG" || bad 'AR20 AGMSG_WATCH_INTERVAL was not exported'

# --- AR21: 2 回目は existing ---
: > "$AGMSG_STUB_LOG"
out=$(CLAUDE_CODE_SESSION_ID=s6 run_guard --type claude-code --name "ar-$$-6")
[[ "$out" == *"watcher=existing"* ]] || bad 'AR21 second run must not start a second watcher'
grep -q 'watch.sh' "$AGMSG_STUB_LOG" && bad 'AR21 must not launch again'

# --- AR8: watcher 生存中でもコマンド置換が戻る（ハング検出は自前 watchdog） ---
reset_case
( CLAUDE_CODE_SESSION_ID=s8 AGMSG_STUB_INSTANCE_ID="s8.222" AGMSG_STUB_MODE=alive \
  bash "$GUARD" --type claude-code --name "ar-$$-8" >"$TMP/ar8.out" 2>/dev/null ) &
ar8=$!
for _ in $(seq 1 100); do kill -0 "$ar8" 2>/dev/null || break; sleep 0.1; done
if kill -0 "$ar8" 2>/dev/null; then kill -9 "$ar8" 2>/dev/null; bad 'AR8 guard did not return (fd leak)'; fi

# --- AR9a-d: 分類 ---
for m in held:held-by-other-session unregistered:not-registered \
         db-error:db-unavailable silent-exit:watcher-exited; do
  reset_case
  mode="${m%%:*}"; want="${m##*:}"
  start=$SECONDS
  out=$(AGMSG_READY_TIMEOUT=10 CLAUDE_CODE_SESSION_ID="s9$mode" AGMSG_STUB_MODE="$mode" \
        run_guard --type claude-code --name "ar-$$-9"); assert_line "$out"
  [[ "$out" == *"reason=$want"* ]] || bad "AR9 $mode -> $want (got $out)"
  [[ $((SECONDS - start)) -lt 3 ]] || bad "AR9 $mode did not abort early"
  [[ $GUARD_RC -eq 0 ]] || bad "AR9 $mode must exit 0"
done

# --- AR9e: decoy 行で誤分類しない ---
reset_case
out=$(CLAUDE_CODE_SESSION_ID=s9e AGMSG_STUB_INSTANCE_ID="s9e.222" AGMSG_STUB_MODE=decoy \
      run_guard --type claude-code --name "ar-$$-9e")
[[ "$out" == *"watcher=started"* ]] || bad 'AR9e decoy body line must not be classified'

# --- AR10 / AR10b: bare で起動した watcher は kill する ---
reset_case
out=$(CLAUDE_CODE_SESSION_ID=s10 AGMSG_STUB_INSTANCE_ID="s10" AGMSG_STUB_MODE=alive \
      run_guard --type claude-code --name "ar-$$-10")
[[ "$out" == *"reason=bare-started"* && "$out" == *"watcher=none"* ]] || bad 'AR10'
ls "$AGMSG_READY_DIR"/ready.* >/dev/null 2>&1 && bad 'AR10b the sentinel must be cleaned up'

# --- AR11 / AR11b: timeout ---
reset_case
enc=$(bash -c "source '$SD/agmsg-path.sh'; agmsg_encode_component 'someone-else'")
printf 'alive.1\n' > "$AGMSG_READY_DIR/ready.t__$enc"
printf '%s\n' "$$" > "$AGMSG_READY_DIR/watch.alive.1.pid"
out=$(CLAUDE_CODE_SESSION_ID=s11 AGMSG_STUB_INSTANCE_ID="s11.222" AGMSG_STUB_MODE=no-sentinel \
      run_guard --type claude-code --name "ar-$$-11")
[[ "$out" == *"reason=start-timeout"* ]] || bad 'AR11'
[[ -f "$AGMSG_READY_DIR/ready.t__$enc" ]] || bad 'AR11b must not remove another role sentinel'

# --- AR12: 手順 8 の照合時に ps が空 → orphan-watcher ---
reset_case
mkdir -p "$TMP/lateps"
cat > "$TMP/lateps/ps" <<STUB
#!/usr/bin/env bash
# 3 回目以降は空出力にする (手順 5 は通し、手順 8 で失敗させる)
n=\$(cat "$TMP/psn" 2>/dev/null || echo 0); n=\$((n+1)); echo \$n > "$TMP/psn"
[[ \$n -ge 3 ]] && exit 0
exec /bin/ps "\$@"
STUB
chmod +x "$TMP/lateps/ps"; echo 0 > "$TMP/psn"
out=$(PATH="$TMP/lateps:$PATH" CLAUDE_CODE_SESSION_ID=s12 AGMSG_STUB_INSTANCE_ID="s12.222" \
      AGMSG_STUB_MODE=no-sentinel run_guard --type claude-code --name "ar-$$-12")
[[ "$out" == *"reason=orphan-watcher"* ]] || bad 'AR12'
grep -q 'kill it manually' "$TMP/stderr.txt" || bad 'AR12 hint'

# --- AR6c: 他セッションの sentinel があっても started にしない ---
reset_case
enc=$(bash -c "source '$SD/agmsg-path.sh'; agmsg_encode_component 'ar-$$-6c'")
printf 'alive.1\n' > "$AGMSG_READY_DIR/ready.t__$enc"
printf '%s\n' "$$" > "$AGMSG_READY_DIR/watch.alive.1.pid"
out=$(CLAUDE_CODE_SESSION_ID=s6c AGMSG_STUB_MODE=held run_guard --type claude-code --name "ar-$$-6c")
[[ "$out" == *"reason=held-by-other-session"* ]] || bad 'AR6c must not report started'

# --- AR6d: AGMSG_READY_DIR の指し違い ---
reset_case
mkdir -p "$TMP/elsewhere"
out=$(AGMSG_READY_DIR="$TMP/elsewhere" CLAUDE_CODE_SESSION_ID=s6d AGMSG_STUB_INSTANCE_ID="s6d.222" \
      AGMSG_STUB_MODE=alive run_guard --type claude-code --name "ar-$$-6d")
[[ "$out" == *"reason=pidfile-missing"* ]] || bad 'AR6d'

# --- AR19: ログのモードとユニーク性（異常系で取る） ---
reset_case
out1=$(CLAUDE_CODE_SESSION_ID=s19 AGMSG_STUB_MODE=held run_guard --type claude-code --name "ar-$$-19")
out2=$(CLAUDE_CODE_SESSION_ID=s19 AGMSG_STUB_MODE=held run_guard --type claude-code --name "ar-$$-19")
l1=$(printf '%s' "$out1" | sed -n 's/.* log=\([^ ]*\)$/\1/p')
l2=$(printf '%s' "$out2" | sed -n 's/.* log=\([^ ]*\)$/\1/p')
[[ "$l1" != "$l2" ]] || bad 'AR19 log paths must be unique'
for l in "$l1" "$l2"; do
  [[ "$(ls -l "$l" | cut -c1-10)" == "-rw-------" ]] || bad "AR19 $l is not 0600"
done
```

- [ ] **Step 2: 失敗を確認する**

```bash
cd <repo root> && bash apps/cmux-team-dispatch-task/test/test-agmsg-ready.sh
```

Expected: AR6 の `log=-`、AR9 の分類、AR10 / AR11 / AR12 / AR6c / AR6d がすべて FAIL。

- [ ] **Step 3: 実装する**

暫定の起動〜待機ブロックを置き換える。

```bash
# --- 手順 7: 起動 ---
# サブシェルで包まない / setsid を使わない / bash -c を挟まない。
# サブシェルは echo $! の直後に終了するのでプロセスが pid 1 へ再親付けされ、
# agmsg の ppid ウォークが失敗して bare id になる (実測 3/3)。
# fd 3 本すべてを付け替える。呼び出し元のパイプを 1 本でも残すと、
# コマンド置換が EOF を待って戻らなくなる。
AGMSG_WATCH_INTERVAL="$AGMSG_WATCH_INTERVAL" \
nohup bash "$AGMSG_DIR/watch.sh" "$SID" "$PROJECT" "$TYPE" "$NAME" </dev/null >>"$LOG_PATH" 2>&1 &
WATCH_PID=$!

READY_GLOB="$AGMSG_READY_DIR/ready.*__$(agmsg_encode_component "$NAME")"

# 起動した watcher の正規化 id を pidfile から復元する。
guard_my_norm_id() {
  local f id p
  for f in "$AGMSG_READY_DIR"/watch.*.pid; do
    [[ -f "$f" ]] || continue
    p="$(head -1 "$f" 2>/dev/null || true)"
    [[ "$p" == "$WATCH_PID" ]] || continue
    guard_normalized_id_from_pidfile "$f"; return 0
  done
  return 1
}

# SIGTERM のみ。kill -9 は watch.sh の trap を飛ばして sentinel と pidfile を残す。
guard_stop_watcher() {
  local i
  case "$WATCH_PID" in ''|*[!0-9]*|0*) return 1 ;; esac
  [[ "${#WATCH_PID}" -le 10 ]] || return 1
  guard_is_watcher "$WATCH_PID" || return 1     # 判定不能 (rc 2) でも kill しない
  kill -TERM "$WATCH_PID" 2>/dev/null || true
  for i in $(seq 1 20); do
    guard_pid_alive "$WATCH_PID" || return 0
    sleep 0.1
  done
  return 1
}

guard_clean_my_sentinels() {   # 自分の正規化 id を持つ sentinel だけ消す
  local s t; local mine="$1"
  for s in $READY_GLOB; do
    [[ -f "$s" ]] || continue
    t="$(head -1 "$s" 2>/dev/null || true)"
    [[ "$t" == "$mine" ]] && rm -f "$s"
  done
}

classify_from_log() {
  if grep -q '^agmsg watch: cannot claim' "$LOG_PATH" 2>/dev/null; then
    REASON=held-by-other-session
    hint "run /agmsg drop $NAME in the owning session, then retry"
  elif grep -q '^agmsg watch: no registration' "$LOG_PATH" 2>/dev/null; then
    REASON=not-registered; hint "run join.sh for this role first; see $LOG"
  elif grep -q '^ERROR: cannot open message DB' "$LOG_PATH" 2>/dev/null; then
    REASON=db-unavailable; hint "see $LOG"
  else
    REASON=watcher-exited; hint "see $LOG"
  fi
}

# --- 手順 8: 待機 ---
deadline=$(( AGMSG_READY_TIMEOUT * 5 ))
mine=""; done_ok=""
for _ in $(seq 1 "$deadline"); do
  mine="$(guard_my_norm_id || true)"
  if [[ -n "$mine" ]]; then
    for s in $READY_GLOB; do
      [[ -f "$s" ]] || continue
      # sentinel の中身が自分の正規化 id と一致することまで確認する。
      # 存在だけを見ると、他セッションの生きた sentinel を掴んで偽の started を返す。
      [[ "$(head -1 "$s" 2>/dev/null || true)" == "$mine" ]] && { done_ok=1; break; }
    done
  fi
  [[ -n "$done_ok" ]] && break
  guard_pid_alive "$WATCH_PID" || { classify_from_log; WATCHER=none; emit; exit 0; }
  sleep 0.2
done

if [[ -z "$done_ok" ]]; then
  if [[ -z "$mine" ]] && ! guard_pid_alive "$WATCH_PID"; then
    classify_from_log; WATCHER=none; emit; exit 0
  fi
  if guard_stop_watcher; then
    [[ -n "$mine" ]] && guard_clean_my_sentinels "$mine"
    REASON=start-timeout; hint "see $LOG"
  else
    REASON=orphan-watcher; PID="$WATCH_PID"
    hint "watcher $WATCH_PID did not stop; kill it manually. see $LOG"
  fi
  WATCHER=none; emit; exit 0
fi

# sentinel を書いた直後に watch.sh が exit するレースがあるので再確認する
if ! guard_pid_alive "$WATCH_PID"; then
  classify_from_log; WATCHER=none; emit; exit 0
fi

# --- 手順 9: composite 検証 ---
if [[ -z "$mine" ]]; then
  # pidfile が見つからないのは bare ではない。AGMSG_READY_DIR の指し違いや
  # $SID の不正でも起きる。ここで kill すると健全な watcher を毎回殺す。
  REASON=pidfile-missing; WATCHER=none
  hint "no pidfile under $AGMSG_READY_DIR; it must match \$(dirname AGMSG_DIR)/run"
  emit; exit 0
fi
if ! guard_is_composite "$mine"; then
  if guard_stop_watcher; then guard_clean_my_sentinels "$mine"; fi
  REASON=bare-started; WATCHER=none; hint "see $LOG"; emit; exit 0
fi

WATCHER=started; PID="$WATCH_PID"

# --- 手順 10: 正常系のログ削除 ---
# LOG_PATH が /dev/null のときは絶対に削除しない。root では /dev/null が消え、
# 非 root では rm が rc 1 を返して set -e 下の呼び出し元ごと落ちる。
if [[ "$LOG_PATH" != /dev/null && ( "$REASON" == "-" || "$REASON" == log-unwritable ) ]]; then
  rm -f "$LOG_PATH"; LOG="-"
fi
emit
exit 0
```

`watcher=existing` / `existing-other` で早期 return する手順 5 の直前にも、同じログ削除を入れる。

```bash
if [[ -n "$CAND_KIND" ]]; then
  PID="$CAND_PID"
  [[ "$CAND_KIND" == mine ]] && WATCHER=existing || WATCHER=existing-other
  if [[ "$LOG_PATH" != /dev/null && ( "$REASON" == "-" || "$REASON" == log-unwritable ) ]]; then
    rm -f "$LOG_PATH"; LOG="-"
  fi
  emit; exit 0
fi
```

- [ ] **Step 4: テストが通ることを確認する**

```bash
cd <repo root> && bash -n apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/ensure-agmsg-ready.sh
cd <repo root> && bash apps/cmux-team-dispatch-task/test/test-agmsg-ready.sh
```

Expected: `--- all tests passed ---`。

- [ ] **Step 5: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/ensure-agmsg-ready.sh \
        apps/cmux-team-dispatch-task/test/test-agmsg-ready.sh
git commit -m "feat(cmux-team-dispatch-task): guard の起動・待機・composite 検証を実装する"
```

---

### Task 6: `launch-workspace.sh` — 期待ロール名の export と codex review の sandbox

**Files:**
- Modify: `SD/launch-workspace.sh`（`--agmsg-from` の検証、runner script への export、`REVIEW_WRITABLE_FLAG`）
- Modify: `TD/test-launch-workspace-codex.sh`（CR1 / CR1b / LW1 / LW2 を T5 群の隣へ）

**Interfaces:**
- Consumes: Task 3-5 の guard（`AGMSG_EXPECTED_NAME` を読む）
- Produces: runner script に `export AGMSG_EXPECTED_NAME='<name>'` が入る

- [ ] **Step 1: 失敗するテストを書く**

`TD/test-launch-workspace-codex.sh` の T5 群の直後へ追加する。既存の
`assert_contains` / `assert_not_contains` ヘルパー名はファイル先頭で確認して合わせること。

```bash
# --- CR1 / CR1b: codex review の --add-dir ---
FAKE_AGMSG="$TMP/fake-agmsg"; mkdir -p "$FAKE_AGMSG/run" "$FAKE_AGMSG/db" "$FAKE_AGMSG/scripts"
out=$(AGMSG_SKILL_DIR="$FAKE_AGMSG" run_launch --mode review --role review --cwd "$TMP/repo" \
        --status-dir "$TMP/status" --runner codex rv1)
assert_contains "$out" "--add-dir '$FAKE_AGMSG/run'"  'CR1 agmsg run must be writable'
assert_contains "$out" "--add-dir '$FAKE_AGMSG/db'"   'CR1 agmsg db must be writable'
assert_not_contains "$out" "$FAKE_AGMSG/scripts"      'CR1 agmsg scripts must NOT be writable'

out=$(AGMSG_SKILL_DIR="$FAKE_AGMSG" run_launch --mode review --role review --cwd "$TMP/repo" \
        --runner codex rv2)
assert_contains "$out" "--add-dir '$FAKE_AGMSG/run'" 'CR1b must add agmsg dirs without STATUS_DIR'

# --- LW1: runner script に AGMSG_EXPECTED_NAME が入る ---
out=$(run_launch --mode standby --role exec --cwd "$TMP/repo" --status-dir "$TMP/status" \
        --agmsg-team demo --agmsg-from demo-claude --runner claude lw1)
runner=$(ls "$TMP/repo"/.cmux-team-dispatch-task-run-*.sh | head -1)
grep -q "export AGMSG_EXPECTED_NAME='demo-claude'" "$runner" \
  || bad 'LW1 runner script must export AGMSG_EXPECTED_NAME'

# --- LW2: --agmsg-from の値域検証 ---
if run_launch --mode standby --role exec --cwd "$TMP/repo" --status-dir "$TMP/status" \
     --agmsg-team demo --agmsg-from 'bad name' --runner claude lw2 >/dev/null 2>&1; then
  bad 'LW2 --agmsg-from with a space must die'
fi
```

`run_launch` は既存スイートのヘルパー名に合わせること（無ければ `bash "$LAUNCH" …` を直接書く）。

- [ ] **Step 2: 失敗を確認する**

```bash
cd <repo root> && bash apps/cmux-team-dispatch-task/test/test-launch-workspace-codex.sh
```

Expected: CR1 / CR1b / LW1 / LW2 が FAIL。

- [ ] **Step 3: 実装する**

(a) `--agmsg-from` の検証を `WORKSPACE_NAME` の検証（`:367` 付近）の直後へ足す。

```bash
# agmsg の from 名は guard の --name と runner script の AGMSG_EXPECTED_NAME に
# そのまま入るので、workspace 名と同じ値域で検証する。
if [[ -n "$AGMSG_FROM" ]]; then
  [[ "$AGMSG_FROM" =~ ^[A-Za-z0-9._-]+$ ]] || die "invalid --agmsg-from '$AGMSG_FROM': use only [A-Za-z0-9._-]"
fi
```

(b) runner script の heredoc（`AGMSG_SEND` などを書いている `:835-837` 付近）へ 1 行足す。

```bash
export AGMSG_EXPECTED_NAME='$AGMSG_FROM'
```

ヒアドキュメント内なので初期プロンプトの禁止文字制約は掛からない。
`AGMSG_FROM` が空のときは行ごと出さないこと。

(c) `REVIEW_WRITABLE_FLAG`（`:766-771` 付近）を書き換える。

```bash
      REVIEW_WRITABLE_FLAG=""
      [[ -n "$STATUS_DIR" ]] && REVIEW_WRITABLE_FLAG+=" --add-dir '$STATUS_DIR'"
      # watcher は run/ と db/ にしか書かない。scripts/ を書き込み許可に含めては
      # ならない — そこは全ペインの guard が実行し session-start.sh 経由で
      # マシン上の全 Claude Code セッションが触れるコードで、無人 codex reviewer に
      # 書き込み権を与えるとサンドボックス外・別セッションの権限で任意コードが走る。
      AGMSG_SKILL_DIR="${AGMSG_SKILL_DIR:-$HOME/.agents/skills/agmsg}"
      [[ -d "$AGMSG_SKILL_DIR/run" ]] && REVIEW_WRITABLE_FLAG+=" --add-dir '$AGMSG_SKILL_DIR/run'"
      [[ -d "$AGMSG_SKILL_DIR/db" ]]  && REVIEW_WRITABLE_FLAG+=" --add-dir '$AGMSG_SKILL_DIR/db'"
```

- [ ] **Step 4: テストが通ることを確認する**

```bash
cd <repo root> && bash apps/cmux-team-dispatch-task/test/test-launch-workspace-codex.sh
cd <repo root> && bash apps/cmux-team-dispatch-task/test/test-codex-review-sandbox.sh
cd <repo root> && bash apps/cmux-team-dispatch-task/test/test-launch-workspace-permissions.sh
```

Expected: 3 本とも全通過（既存の T5 群は `grep -Fq` なので 2 本目の `--add-dir` を足しても壊れない）。

- [ ] **Step 5: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh \
        apps/cmux-team-dispatch-task/test/test-launch-workspace-codex.sh
git commit -m "feat(cmux-team-dispatch-task): 期待ロール名の export と codex review の agmsg 許可を足す"
```

---

### Task 7: `prewarm-panes.sh` — 全ロールへの guard 注入

**Files:**
- Modify: `SD/prewarm-panes.sh`（`wire_delivery` のリダイレクト、design の gate、4 ロールの初期プロンプト、`prewarm.json`）
- Modify: `TD/test-prewarm-layout.sh`（PW1-PW10）
- Modify: `TD/test-prewarm-unattended.sh`（`assert_no_line_with` の強化）

**Interfaces:**
- Consumes: Task 3-5 の guard（文字列として埋め込むだけ。実在検査はしない）
- Produces: `prewarm.json` の各ロールに `watcher: "guard-injected" | "none"`

- [ ] **Step 1: 失敗するテストを書く**

`TD/test-prewarm-layout.sh` へ追加する（slug は `pw1`…`pw9`。ワークツリーは必ず先に `mkdir -p`）。

```bash
# --- PW1: watcher キー ---
jq -e '[.. | objects | select(has("delivery")) | has("watcher")] | all' "$TMP/status/prewarm.json" \
  >/dev/null || bad 'PW1 every role with delivery must have watcher'
jq -e '[.. | objects | select(has("delivery")) | (.delivery == "agmsg") == (.watcher == "guard-injected")] | all' \
  "$TMP/status/prewarm.json" >/dev/null || bad 'PW1 delivery and watcher must agree'

# --- PW3 / PW4 / PW5: プロンプト ---
[[ -s "$TMP/argv.log" ]] || bad 'PW3 argv.log is empty'
grep -q 'ensure-agmsg-ready.sh' "$TMP/argv.log" || bad 'PW3 guard must be injected'
grep -q '/agmsg actas' "$TMP/argv.log" && bad 'PW4 /agmsg actas must not appear'
grep -qE "['\"\`\$!\\\\]" "$TMP/argv.log" && bad 'PW5 forbidden characters in the prompt'
[[ $(wc -l < "$TMP/argv.log" | tr -d ' ') -eq "$expected_panes" ]] \
  || bad 'PW5 a newline in the prompt broke the pane count'

# --- PW6: stderr へ AGMSG-DIRECTIVE が漏れない ---
grep -q 'AGMSG-DIRECTIVE' "$TMP/prewarm.stderr" && bad 'PW6 directive leaked to stderr'

# --- PW8: --agmsg-team 無しでは guard を載せない ---
grep -q 'ensure-agmsg-ready.sh' "$TMP/argv-noteam.log" && bad 'PW8'

# --- PW10: --agmsg-from が各ロールへ渡る ---
grep -Fq -- '--agmsg-from pw1-claude' "$TMP/argv.log" || bad 'PW10 executor role name'
grep -Fq -- '--agmsg-from pw1-review' "$TMP/argv.log" || bad 'PW10 review role name'
```

PW2（`delivery.sh` 失敗）・PW7（guard の exit 1）・PW9（design の gate）は
failure-injection stub を新規に作る。

```bash
# delivery.sh stub: AGMSG_STUB_DELIVERY_RC で失敗させる
# join.sh stub:     AGMSG_STUB_JOIN_FAIL=<agent 名> でその agent だけ失敗させる
cat > "$TMP/agmsg/join.sh" <<'STUB'
#!/usr/bin/env bash
echo "$0 $*" >> "$AGMSG_LOG"
[[ "${AGMSG_STUB_JOIN_FAIL:-}" == "$2" ]] && exit 1
exit 0
STUB
```

PW2 は `AGMSG_STUB_DELIVERY_RC=1` で走らせ、`prewarm.json` の claude-code 型ロールがすべて
`watcher: "none"` になり `argv.log` に `ensure-agmsg-ready.sh` が現れないことを assert する。
PW7 は `ensure-agmsg-ready.sh` stub を `exit 1` にしても `prewarm.json` が書かれることを assert する。
PW9 は `AGMSG_STUB_JOIN_FAIL=pw9` で design の join だけ失敗させ、
design のプロンプトから guard が消えることを assert する。

PW5b は空白入りの一時ディレクトリから `prewarm-panes.sh` を実行し、
`watcher: "none"` になり guard が注入されないことを assert する。

- [ ] **Step 2: 失敗を確認する**

```bash
cd <repo root> && bash apps/cmux-team-dispatch-task/test/test-prewarm-layout.sh
```

Expected: PW1 / PW3 / PW10 などが FAIL。

- [ ] **Step 3: 実装する**

(a) `wire_delivery` のリダイレクトを直す（2 箇所）。

```bash
# 修正前: >&2 2>/dev/null   ← stdout を元の stderr に複製してから stderr を捨てている
# 修正後:
    if bash "$AGMSG_DIR/delivery.sh" set monitor codex "$CWD" >/dev/null 2>&1; then
    if bash "$AGMSG_DIR/delivery.sh" set monitor claude-code "$CWD" >/dev/null 2>&1; then
```

(b) guard 行を組み立てるヘルパーを足す。**1 行・禁止文字なし。**

```bash
# 初期プロンプトへ埋め込む guard 実行文。SCRIPT_DIR に空白が含まれる場合は
# プロンプトをクォートできず bash が exit 127 で終わるので、注入しない。
GUARD_INJECTABLE=1
case "$SCRIPT_DIR" in *[[:space:]]*) GUARD_INJECTABLE=0 ;; esac
[[ $GUARD_INJECTABLE -eq 0 ]] && log "agmsg" "skill dir contains whitespace; not injecting the guard"

guard_clause() {  # <type> <name>
  printf 'Run bash %s/ensure-agmsg-ready.sh --type %s --name %s and continue even if it exits non-zero.' \
    "$SCRIPT_DIR" "$1" "$2"
}
```

(c) 4 ロールのプロンプトを組み立てる。design の gate を `DESIGN_DELIVERY` に揃える。

```bash
  # design (claude / codex 共通)
  if [[ $GUARD_INJECTABLE -eq 1 && "$DESIGN_DELIVERY" == "agmsg" ]]; then
    DESIGN_WATCHER="guard-injected"
    OPUS_PROMPT="$(guard_clause "$DESIGN_WIRING_TYPE" "$SLUG") Then wait idle. Your task will arrive as a prompt typed into this pane; an identical copy may also be recorded in your agmsg inbox history (treat both as ONE task). Do not start any work until the task prompt arrives."
  else
    DESIGN_WATCHER="none"
    OPUS_PROMPT="Wait idle. Your task will be typed directly into this pane as a prompt. Do not start any work until it arrives."
  fi
```

executor（claude / codex 共通）と review も同型で組み立てる。文面は
**spec の設計 2(B) のプロンプト表を逐語で**使う。codex 分岐と review 分岐は
現在プロンプトを渡していないので、`launch-workspace.sh` への位置引数を足す。

(d) `prewarm.json` の `jq -n` へ 4 変数を追加する。

```bash
  --arg dw "$DESIGN_WATCHER" \
  --arg cw "$CLAUDE_EXEC_WATCHER" \
  --arg xw "$CODEX_WATCHER" \
  --arg rw "$REVIEW_WATCHER" \
```

各ロールのオブジェクトへ `watcher: $dw` などを足す。

- [ ] **Step 4: テストが通ることを確認する**

```bash
cd <repo root>
for t in apps/cmux-team-dispatch-task/test/test-prewarm-*.sh apps/cmux-team-dispatch-task/test/test-in-session.sh; do
  printf '%-56s ' "$t"; if bash "$t" >/dev/null 2>&1; then echo OK; else echo FAILED; fi
done
git worktree list
```

Expected: すべて OK。`git worktree list` に新しい残骸が無いこと。

- [ ] **Step 5: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh \
        apps/cmux-team-dispatch-task/test/test-prewarm-layout.sh \
        apps/cmux-team-dispatch-task/test/test-prewarm-unattended.sh
git commit -m "feat(cmux-team-dispatch-task): 全ロールの初期プロンプトへ agmsg guard を載せる"
```

---

### Task 8: `SKILL.md` の Step 1g と子プロンプト

**Files:**
- Modify: `SKILL.md`（`514-528` / `526` / `748-812` / `793-812` / `2118-2119` / `2127-2128` / `2137-2145` / `2201-2203` / `2737` / `386`）
- Create: `TD/test-agmsg-skill-block.sh`（AG1-AG4）

**Interfaces:**
- Consumes: Task 3-5 の guard の rc 契約
- Produces: なし

- [ ] **Step 1: 失敗するテストを書く**

`TD/test-agmsg-skill-block.sh` を新規作成する。`test-cleanup-close.sh` の
「fenced block を awk で抜き出して bash で実行し、stub への呼び出しログを検査する」流儀を踏襲する。

```bash
#!/usr/bin/env bash
# SKILL.md の Step 1g ブロックを抽出して実行し、rc 分岐を検証する。
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/SKILL.md"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
fail=0; bad() { echo "FAIL: $1" >&2; fail=1; }

# TEAM="dispatch- は SKILL.md 全体で 1 箇所しかないので一意アンカーになる。
# 「Step 1g の fenced block」では特定できない (配下に bash フェンスが 6 個ある)。
awk '/TEAM="dispatch-/{f=1} f{print} f&&/^```$/{exit}' "$SKILL" | sed '/^```/d' > "$TMP/block.raw"
[[ -s "$TMP/block.raw" ]] || bad 'AG1 could not extract the Step 1g block'

mkdir -p "$TMP/skill/scripts" "$TMP/agmsg"
# 先に置換してから、~/.agents が 1 文字も残っていないことを assert する (fail-closed)
sed -e "s|~/.agents/skills/agmsg/scripts|$TMP/agmsg|g" \
    -e "s|<SKILL_DIR>|$TMP/skill|g" "$TMP/block.raw" > "$TMP/block.sh"
grep -q '~/.agents' "$TMP/block.sh" && bad 'AG1 the extracted block still touches the real agmsg'

cat > "$TMP/agmsg/join.sh" <<'STUB'
#!/usr/bin/env bash
exit "${JOIN_RC:-0}"
STUB
cat > "$TMP/skill/scripts/resolve-agmsg-type.sh" <<'STUB'
#!/usr/bin/env bash
echo claude-code
STUB
cat > "$TMP/git" <<'STUB'
#!/usr/bin/env bash
[[ "$1" == rev-parse ]] && { echo /tmp/demo-repo; exit 0; }
exit 0
STUB
chmod +x "$TMP/agmsg/join.sh" "$TMP/skill/scripts/resolve-agmsg-type.sh" "$TMP/git"

make_guard() {  # <rc> <state>
  cat > "$TMP/skill/scripts/ensure-agmsg-ready.sh" <<STUB
#!/usr/bin/env bash
echo "\$*" > "$TMP/guard.argv"
echo '$2'
exit $1
STUB
  chmod +x "$TMP/skill/scripts/ensure-agmsg-ready.sh"
}

run_block() {  # 追加の env をそのまま渡す
  ( cd "$TMP" && PATH="$TMP:$PATH" bash -c "set -euo pipefail; source '$TMP/block.sh'; \
     echo \"TEAM=\$TEAM AGMSG_INSTALLED=\${AGMSG_INSTALLED:-unset}\"" ) 2>&1
}

# AG1-a: rc 0 / started → 警告なし
make_guard 0 'ensure-agmsg-ready: installed=yes wired=yes name=parent watcher=started pid=1 reason=- log=-'
out=$(run_block); [[ "$out" == *"[warn]"* ]] && bad 'AG1 rc0/started must not warn'
[[ "$out" == *"TEAM=dispatch-demo-repo"* ]] || bad 'AG1 rc0 must keep TEAM'

# AG1-b: rc 0 / none → warn かつ TEAM 維持
make_guard 0 'ensure-agmsg-ready: installed=yes wired=yes name=parent watcher=none pid=- reason=start-timeout log=-'
out=$(run_block); [[ "$out" == *"[warn]"* ]] || bad 'AG1 rc0/none must warn'
[[ "$out" == *"TEAM=dispatch-demo-repo"* ]] || bad 'AG1 rc0/none must keep TEAM'

# AG1-c: rc 0 / existing-other → warn
make_guard 0 'ensure-agmsg-ready: installed=yes wired=yes name=parent watcher=existing-other pid=9 reason=- log=-'
out=$(run_block); [[ "$out" == *"[warn]"* ]] || bad 'AG1 rc0/existing-other must warn'

# AG1-d: rc 1 → TEAM 空 + AGMSG_INSTALLED=false
make_guard 1 'ensure-agmsg-ready: installed=no wired=no name=parent watcher=none pid=- reason=not-installed log=-'
out=$(run_block)
[[ "$out" == *"TEAM= "* || "$out" == *"TEAM="$'\n'* || "$out" == *"TEAM= AGMSG_INSTALLED=false"* ]] \
  || bad 'AG1 rc1 must clear TEAM'
[[ "$out" == *"AGMSG_INSTALLED=false"* ]] || bad 'AG1 rc1 must set AGMSG_INSTALLED=false'

# AG1-e: rc 2 → 停止
make_guard 2 'ensure-agmsg-ready: installed=no wired=no name=- watcher=none pid=- reason=usage log=-'
out=$(run_block); [[ "$out" == *"[error]"* ]] || bad 'AG1 rc2 must error out'

# AG1-f: join 失敗でも guard に到達する
make_guard 0 'ensure-agmsg-ready: installed=yes wired=yes name=parent watcher=started pid=1 reason=- log=-'
out=$(JOIN_RC=1 run_block); [[ -f "$TMP/guard.argv" ]] || bad 'AG1 join failure must not abort the block'

# AG2: --name parent を渡し --session-id を渡さない
grep -Fq -- '--name parent' "$TMP/guard.argv" || bad 'AG2 --name parent'
grep -Fq -- '--session-id' "$TMP/guard.argv" && bad 'AG2 must not pass --session-id'

# AG3 / AG4: 子プロンプトの guard 行
grep -q 'prewarm: false' "$SKILL" || bad 'AG3 the child guard line must be gated on prewarm: false'
grep -q 'ensure-agmsg-ready.sh --type <CHILD_AGMSG_TYPE> --name <task-slug>' "$SKILL" \
  || bad 'AG4 the child guard line must resolve --type per task'

[[ $fail -eq 0 ]] && echo '--- all tests passed ---' || echo '--- failures ---'
exit "$fail"
```

- [ ] **Step 2: 失敗を確認する**

```bash
cd <repo root> && bash apps/cmux-team-dispatch-task/test/test-agmsg-skill-block.sh
```

Expected: `AG1 could not extract the Step 1g block` などで FAIL。

- [ ] **Step 3: 実装する**

`SKILL.md` を **spec の設計 2(A) / 2(C) とドキュメント表の 1-9 行目**のとおりに書き換える。
Step 1g の配線ブロックは spec の (A) のコードブロックを**逐語で**入れる
（`env -u AGMSG_EXPECTED_NAME` と `|| true` と `|| AGMSG_RC=$?` を落とさないこと）。
`AGMSG_INSTALLED` の定義文、`monitor-dispatch.sh` の起動条件、`/clear` の既知の制限、
`prewarm.json` の `watcher` キー、sentinel パスのエンコード、Delivery 要約の「MUST be followed」、
codex review の `--add-dir` の内訳も同時に直す。

**`SKILL.md` に日本語文字を 1 文字も書かないこと。**

- [ ] **Step 4: テストが通ることを確認する**

```bash
cd <repo root> && bash apps/cmux-team-dispatch-task/test/test-agmsg-skill-block.sh
cd <repo root> && bash apps/cmux-team-dispatch-task/test/test-send-prompt-callsites.sh
cd <repo root> && node scripts/check-doc-lang.mjs apps/cmux-team-dispatch-task
```

Expected: 3 本とも通過。`check-doc-lang` は `missing-guide-ja` を出す可能性があるが、
その場合は Task 9 で訳を入れるまで一時的に失敗する。**Task 8 の時点では
`japanese-in-english-doc` が出ないことだけを確認する。**

- [ ] **Step 5: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md \
        apps/cmux-team-dispatch-task/test/test-agmsg-skill-block.sh
git commit -m "feat(cmux-team-dispatch-task): Step 1g を agmsg guard 呼び出しへ置き換える"
```

---

### Task 9: ドキュメント同期と最終ゲート

**Files:**
- Modify: `references/guide-ja.md`（ドキュメント表 10-19 / 26-27 行目）
- Modify: `README.md`（20-23 行目）
- Modify: `apps/cmux-team-dispatch-task/CLAUDE.md`（28-41 行目）
- Modify: `apps/cmux-team-dispatch-task/docs/notification-gaps.md`（P9 と U9）
- Modify: `SD/prewarm-panes.sh:584,617` と `SD/launch-workspace.sh:791` のコメント

**Interfaces:**
- Consumes: Task 1-8 のすべて
- Produces: なし

- [ ] **Step 1: ドキュメント表の全 41 行を反映する**

spec の「ドキュメント」節の表を上から順に処理する。**1 行 = 1 参照**なので、
41 行すべてに対応する編集があることをチェックリストとして確認する。
`guide-ja.md` は `SKILL.md` と見出しが 1:1 対応する訳なので、Task 8 で入れた変更に対応する
訳をすべて入れる。

`docs/notification-gaps.md` の「修正したパターン」へ P9 を、「未解決として記録するパターン」へ U9 を足す。

```markdown
| P9 | agmsg watcher が起動せず inbox 記録が全ロールで落ちる | `SKILL.md` の AGMSG-DIRECTIVE 依存 | Monitor ツールを持たないハーネスで watcher ゼロ | `ensure-agmsg-ready.sh` を追加 |
```

```markdown
| U9 | `/clear` 後に watcher が戻らない | guard は初期プロンプトから 1 回だけ走る。Monitor 非搭載ハーネスではそのペインの watcher が復帰しない |
```

- [ ] **Step 2: 4 ファイル整合を確認する**

```bash
cd <repo root>
grep -rn 'AGMSG-DIRECTIVE' apps/cmux-team-dispatch-task/skills apps/cmux-team-dispatch-task/README.md apps/cmux-team-dispatch-task/CLAUDE.md
grep -rn 'needs no encoding\|エンコードは不要' apps/cmux-team-dispatch-task/
grep -rn '3 点セット\|3点セット' apps/cmux-team-dispatch-task/
grep -rn '/agmsg actas' apps/cmux-team-dispatch-task/skills apps/cmux-team-dispatch-task/CLAUDE.md
```

Expected: いずれも「変更後に偽になる記述」が残っていないこと
（`AGMSG-DIRECTIVE` は本文中の説明としてのみ残ってよいが、「従え」という指示は残さない）。

- [ ] **Step 3: 検証ゲートを実行する**

```bash
cd <repo root>
bash -n apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/ensure-agmsg-ready.sh
bash -n apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/agmsg-path.sh
rc=0
for t in apps/cmux-team-dispatch-task/test/*.sh; do
  printf '%-56s ' "$t"
  if bash "$t" >/dev/null 2>&1; then echo OK; else echo FAILED; rc=1; fi
done
node scripts/check-doc-lang.mjs apps/cmux-team-dispatch-task || rc=1
pnpm check || rc=1
git worktree list
git branch --list 'feat/pg*' 'feat/is*' 'feat/ov*' 'feat/pw*'
exit $rc
```

Expected: 全スイート OK、`check-doc-lang: OK`、`pnpm check` 通過
（`@tanaka-yui/token-meter` の `noNonNullAssertion` 警告 4 件は既知のノイズ）。
`git worktree list` と `git branch --list` に新しい残骸が無いこと。

- [ ] **Step 4: 残骸があれば掃除する**

```bash
# テストが残したワークツリー / ブランチがあれば削除する
git worktree prune
git branch -D <残ったブランチ名>   # 必要なときだけ
```

- [ ] **Step 5: コミット**

```bash
git add -A apps/cmux-team-dispatch-task
git commit -m "docs(cmux-team-dispatch-task): agmsg guard を 4 ファイルへ同期する"
```

---

## Self-Review

**1. Spec coverage**

| spec の節 | 対応タスク |
|---|---|
| 設計 3（`agmsg-path.sh`） | Task 1、Task 2 |
| 事実 17 / `send-prompt.sh` のエンコード | Task 2（SP25 / SP26） |
| 設計 1 手順 1-4（引数検証・ログ・配線） | Task 3（AR1 / AR2 / AR2b / AR2c / AR13 / AR14 / AR15 / AR16 / AR18） |
| 設計 1 手順 5-6（候補判定・stale 掃除）＋ 共通ルール | Task 4（AR3 群 / AR4 / AR4b / AR5） |
| 設計 1 手順 7-10（起動・待機・composite・ログ削除） | Task 5（AR6 群 / AR7-AR12 / AR19 / AR20 / AR21） |
| 設計 2(D)（codex review の `--add-dir`）＋ `AGMSG_EXPECTED_NAME` | Task 6（CR1 / CR1b / LW1 / LW2） |
| 設計 2(B)（prewarm のプロンプト）＋ 設計 4（`prewarm.json`） | Task 7（PW1-PW10） |
| 設計 2(A)（Step 1g）＋ 設計 2(C)（非 prewarm 経路） | Task 8（AG1-AG4） |
| ドキュメント 41 行 ＋ `notification-gaps.md` | Task 9 |
| 検証ゲート | Task 9 Step 3 |

**2. Placeholder scan**: 各 Task のコードブロックは実際に貼れる内容になっている。
Task 7 と Task 8 は既存ファイルの大きな書き換えなので、文面の逐語ソースを
「spec の設計 2(B) のプロンプト表」「spec の設計 2(A) のコードブロック」と明示した。
Task 9 のドキュメント編集は spec の 41 行表がチェックリストである。

**3. Type consistency**: guard の関数名は Task 4 で定義した
`guard_normalized_id_from_pidfile` / `guard_is_composite` / `guard_pid_alive` /
`guard_is_watcher` / `guard_name_slot` を Task 5 でもそのまま使っている。
`agmsg_encode_component` / `agmsg_ready_path` は Task 1 の定義と Task 2-5 の利用で一致。
`WATCHER` / `REASON` / `PID` / `LOG` の 4 変数は Task 3 で宣言し Task 4-5 で更新する。

**注意（実装者向けの申し送り）**: `AR3i` と `AR3j` は
**中核方針 2（guard は既存の watcher を kill・置換・復元しない）の唯一の自動検査**である。
これを落とすと、パス A で kill を書いても全 AR が緑のまま通る。必ず入れること。
