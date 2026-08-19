# 設計ペインの permission bypass 起動時フォールバック 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `.claude/settings.local.json` への `bypassPermissions` 注入が効かなかったときに、claude 設計ペインが素の権限で起動して permission prompt にハングするのを防ぐため、起動時に `--dangerously-skip-permissions` へフォールバックする。

**Architecture:** `launch-workspace.sh` の Step 2a で、注入後に `jq -e` でファイル実体を判定して `BYPASS_INJECTION_OK` を立てる。Step 3 で専用変数 `PERM_FALLBACK_FLAG` を組み立て、claude engine の 4 つの合成箇所へ差し込む。正常系の composed command は 1 バイトも変わらない。

**Tech Stack:** bash 3.2（macOS 既定）、`jq`、既存のテストハーネス（`cmux` スタブ + `RUNNERS_CONFIG_PATH`）

**Spec:** `docs/superpowers/specs/2026-08-20-design-pane-bypass-permission-design.md`

## Global Constraints

- **bash 3.2 互換を維持する。** 新規の連想配列・`declare -A`・`${arr[@]}` の裸展開を導入しない。`set -u` 下で空になりうる配列は `${arr[@]+"${arr[@]}"}` で展開する。
- **コメントとコミットメッセージは日本語、コード識別子（変数名・関数名・CLI フラグ）は英語。**
- **`SKILL.md` と `references/*.md`（`*-ja.md` を除く）に日本語文字を 1 文字も書かない。** `node scripts/check-doc-lang.mjs` が hard gate。
- **4 ファイル同時更新ルール**（`apps/cmux-team-dispatch-task/CLAUDE.md`「ドキュメント整合の絶対ルール」）: `SKILL.md` / `references/guide-ja.md` / `README.md` / `CLAUDE.md` を同じ commit で一致させる。
- **バージョン番号を上げない。push しない。PR を作らない。**（Wait-and-merge。親がローカルで merge する）
- **`prewarm-panes.sh` を呼ぶテストは worktree ディレクトリを事前に `mkdir -p` する。** 未作成だと `prewarm-panes.sh:387-395` の `git worktree add`（`-C` 無し）が実リポジトリに対して走り、ブランチと worktree 登録を残す。
- **否定アサーションは対象が実在することを先に確認する。** ファイルや行が無いから通る否定アサーションは欠陥であってテストではない。
- **`git add -A` を使わない。** worktree ルートの `.cmux-team-dispatch-task-prompt.md` と 3 本の `.cmux-team-dispatch-task-run-*.sh` は本ディスパッチの生成物であり tracked にしてはならない。commit は必ずパスを明示する。
- **行番号ではなくアンカー文字列で編集箇所を探す。** 本計画の行番号は変更前のファイル基準で、Task 1 以降で常にずれる。

---

## File Structure

| ファイル | 変更 | 責務 |
|---------|------|------|
| `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh` | Modify | 判定（Step 2a）とフラグ合成（Step 3）。usage ヘッダと Step 2a コメントも同ファイル |
| `apps/cmux-team-dispatch-task/test/test-launch-workspace-permissions.sh` | Modify | フォールバック挙動の回帰（P12〜P26b）。ヘッダと EXIT trap も更新 |
| `apps/cmux-team-dispatch-task/test/test-prewarm-design-permissions.sh` | Create | 設計ペインと claude executor の `--skip-permissions` 非対称（DB1-DB2） |
| `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md` | Modify | 英語 SoT。表 1 行 + 散文 2 段落 |
| `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md` | Modify | 日本語ミラー + 既存ドリフト 2 件の修復 |
| `apps/cmux-team-dispatch-task/README.md` | Modify | 利用者向け 1 段落 |
| `apps/cmux-team-dispatch-task/CLAUDE.md` | Modify | 保守項目 25 の bullet 3 箇所 |

**タスク境界の理由:** Task 1（判定）と Task 2（フラグ合成）は片方だけでは無意味だが、Task 1 単体でも「警告が出る / composed command は不変」という独立した検証ができ、レビュアーが Task 2 だけを差し戻せる。Task 3-4 はテスト、Task 5 はドキュメント。

---

### Task 1: Step 2a に `jq -e` による判定を足す

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh`（Step 2a ブロック。変更前で `:547-585` 付近）

**Interfaces:**
- Consumes: なし
- Produces: シェル変数 `BYPASS_INJECTION_OK`（`0` = 注入を確認できなかった / `1` = 確認できた、または codex engine）。Task 2 がこれを読む。

- [ ] **Step 1: usage ヘッダの注記ブロックを差し替える**

`launch-workspace.sh` 冒頭のコメントで、次のアンカー行を探す:

```
#   注記: claude engine では MODE を問わず、worktree の
```

この行から `#   --dangerously-skip-permissions フラグを付ける。codex engine は対象外。` までの
4 行を、次の 7 行で置き換える（`--skip-permissions` オプション自体の説明行は変更しない）:

```
#   注記: claude engine では MODE を問わず、worktree の
#   .claude/settings.local.json に permissions.defaultMode: "bypassPermissions" を
#   注入する (Step 2a)。注入後にファイルを読み直して確認できなかったときは、
#   plan (組み立て箇所でリテラル付与済み) と、呼び出し元が --skip-permissions を
#   渡した execute / standby / review を除いて --dangerously-skip-permissions を
#   自動で足す。superpowers は --skip-permissions を読まないので常に足す。
#   --skip-permissions はそれとは別に呼び出し元が明示するフラグ。codex engine は対象外。
```

- [ ] **Step 2: Step 2a のコメントブロックを差し替える**

アンカー `# --- Step 2a: permission prompt 抑止 (claude engine の全 MODE) ---` から、その直下の
`if [[ "$RUNNER_ENGINE" == "claude" ]]; then` の直前までを、次で置き換える:

```bash
# --- Step 2a: permission prompt 抑止 (claude engine の全 MODE) ---
# claude の子セッションで permission prompt が出ないよう、worktree の
# .claude/settings.local.json に permissions.defaultMode: bypassPermissions を注入し、
# 注入できたことをファイル実体で確認する。確認できなければ CLI フラグへ落とす (Step 3)。
#
# 裏取り (Claude Code 公式ドキュメント + 実測):
#   - --dangerously-skip-permissions は --permission-mode bypassPermissions と
#     「等価なモード」で動作すると cli-reference に明記されている。両者に
#     AskUserQuestion の扱いの差は無い
#   - AskUserQuestion / ExitPlanMode は permission gate とは別レイヤーの対話 UI で、
#     bypassPermissions 下でも対話 TUI では通常どおり表示される (hooks のドキュメントが
#     「非対話モードでプロンプトなしに処理する」ために hook を要求していることが根拠)。
#     したがって superpowers モードのブレスト対話は壊れない
#   - settings.local.json に defaultMode を書くだけで CLI フラグ無しに permission
#     prompt が消えることは実測済み
#
# 注入は best effort で、しかも merge_claude_settings の戻り値は信用できない。
# settings.local.json がディレクトリのとき mv は temp をその中へ移動したうえで 0 を返し、
# 値が 1 つも入っていないのに injected とログに出る。だから戻り値ではなく、書き込んだ
# ファイルを jq -e で直接判定する (シェル文字列へ往復させると $() が末尾改行を剥がして
# 不正な値が等値になるので、比較は jq の中で完結させる)。判定が失敗を告げたときに
# CLI フラグへ落とすのは、設計ペイン (standby / superpowers の有人経路) だけが第二の
# 防壁を持たず、permission prompt に当たると誰にも通知されないまま停止して
# ディスパッチごとデッドロックするため。
#
# bypass モード突入の確認ダイアログはフラグでも defaultMode でも出る。抑止する
# skipDangerousModePermissionPrompt は project settings では無視されるため、
# ユーザー設定 ~/.claude/settings.json 側に置く必要がある (README 参照)。
# したがってフォールバックもこの前提を共有する。
#
# codex engine は .claude/settings.local.json を読まないため対象外。codex は
# --dangerously-bypass-approvals-and-sandbox / review ペインの
# --sandbox workspace-write で既に prompt が出ない。
BYPASS_INJECTION_OK=1
```

`BYPASS_INJECTION_OK=1` は claude ガードの**外**に置く（codex engine では 1 のまま残す）。

- [ ] **Step 3: 判定ブロックを挿入する**

既存の注入ブロックの `fi`（`elif merge_claude_settings ...` の次の `fi`）の直後、
`# \`|| true\` は必須。` で始まるコメントの直前に、次を挿入する:

```bash
  # 注入結果をファイル実体で判定する。merge_claude_settings の戻り値を信用しないのは、
  # settings.local.json がディレクトリのとき mv が temp をその中へ移動して return 0 を返し、
  # 値が 1 つも入っていないのに injected とログに出るため。判定を jq の中で完結させるのは、
  # シェル文字列へ往復させると $() が末尾改行を剥がして "bypassPermissions\n" のような
  # enum として不正な値が等値になってしまうため。jq -e は false で 1、不正 JSON で 5、
  # ファイル不在・ディレクトリで 2 を返すので、0 以外をすべて失敗として扱えば
  # 型混同・末尾空白・注入不能の全ケースに fail-closed になる。
  if ! jq -e '.permissions.defaultMode == "bypassPermissions"' \
       "$CWD/.claude/settings.local.json" >/dev/null 2>&1; then
    BYPASS_INJECTION_OK=0
    # ログ用の値だけを別に読む。制御文字を含む値が stderr へ抜けると端末を書き換えられ、
    # 偽の [permissions] injected 行まで捏造できるため英数字以外を落とす。
    EFFECTIVE_DEFAULT_MODE=$(jq -r '.permissions.defaultMode // ""' \
      "$CWD/.claude/settings.local.json" 2>/dev/null || echo "")
    EFFECTIVE_DEFAULT_MODE_LOG="${EFFECTIVE_DEFAULT_MODE//[^A-Za-z0-9_-]/}"
    EFFECTIVE_DEFAULT_MODE_LOG="${EFFECTIVE_DEFAULT_MODE_LOG:0:64}"
    # 生値と潰した値の長さを併記する。これが無いと near-miss 値 (例 ["bypassPermissions"])
    # で「not confirmed なのに defaultMode='bypassPermissions'」という読めない診断になり、
    # 保守者が「比較が壊れている」と誤解してサニタイズ済みの値で比較するよう直してしまう
    # (それはこの設計が禁じている変更そのもの)。末尾改行だけは $() が剥がすので raw_len と
    # shown_len が並ぶが、判定は jq -e が行っているので取りこぼしは無い。
    log "warn" "permission bypass not confirmed in $CWD/.claude/settings.local.json (defaultMode='$EFFECTIVE_DEFAULT_MODE_LOG' raw_len=${#EFFECTIVE_DEFAULT_MODE} shown_len=${#EFFECTIVE_DEFAULT_MODE_LOG})"
  fi

```

**警告文にフラグのリテラル `--dangerously-skip-permissions` を含めないこと。** テストが
composed command のフラグを数えるとき、stdout と stderr を混ぜた入力に対して数えると
警告文にマッチして、Task 2 が未実装でも通る空虚なテストになる。

- [ ] **Step 4: 構文チェックと既存スイートを走らせる**

Run:
```bash
cd apps/cmux-team-dispatch-task
bash -n skills/cmux-team-dispatch-task/scripts/launch-workspace.sh
bash test/test-launch-workspace-permissions.sh
```
Expected: `bash -n` は無出力、P1〜P11 が全部 PASS で `--- all tests passed ---`。
この時点ではまだ composed command は変わらないので、既存の否定アサーション（P6）も通る。

- [ ] **Step 5: commit**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh
git commit -m "feat(cmux-team-dispatch-task): bypassPermissions の注入結果を jq -e で判定する"
```

---

### Task 2: 専用フォールバックフラグを合成箇所へ差し込む

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh`（Step 3。変更前で `:744-805` 付近）

**Interfaces:**
- Consumes: `BYPASS_INJECTION_OK`（Task 1）、既存の `SKIP_PERMISSIONS` / `MODE` / `RUNNER_ENGINE` / `CLAUDE_EXTRA_FLAGS` / `CLAUDE_MODEL_FLAGS`
- Produces: シェル変数 `PERM_FALLBACK_FLAG`（`""` または `" --dangerously-skip-permissions"`。先頭に空白 1 つを含む）

- [ ] **Step 1: フラグ合成ブロックを追加する**

アンカーは次の 4 行（`CLAUDE_EXTRA_FLAGS` の組み立て）:

```bash
CLAUDE_EXTRA_FLAGS="$CLAUDE_MODEL_FLAGS"
if [[ $SKIP_PERMISSIONS -eq 1 ]]; then
  CLAUDE_EXTRA_FLAGS="${CLAUDE_EXTRA_FLAGS:+$CLAUDE_EXTRA_FLAGS }--dangerously-skip-permissions"
fi
```

この `fi` の直後に次を挿入する:

```bash

# Step 2a の判定で bypass を確認できなかったときだけ付ける緊急フラグ。
# plan は自分の合成箇所でリテラルのフラグを持つので足さない。
# execute / standby / review は呼び出し元の --skip-permissions が CLAUDE_EXTRA_FLAGS 経由で
# 届くので、実際に渡されたときだけ足さない (二重付与の回避)。
# superpowers はその合成箇所が CLAUDE_MODEL_FLAGS しか読まず --skip-permissions を
# 受け取らないため、その値に関わらず足す。
PERM_FALLBACK_FLAG=""
if [[ "$RUNNER_ENGINE" == "claude" && $BYPASS_INJECTION_OK -eq 0 ]]; then
  case "$MODE" in
    plan) ;;
    superpowers) PERM_FALLBACK_FLAG=" --dangerously-skip-permissions" ;;
    *) if [[ $SKIP_PERMISSIONS -eq 0 ]]; then PERM_FALLBACK_FLAG=" --dangerously-skip-permissions"; fi ;;
  esac
fi
# `|| true` は必須。条件が偽のときではなく、log への書き込みが失敗したときのため。
# log は最後の && の後ろにあり set -e の免除対象外なので、これが無いと launch ごと死ぬ。
[[ -n "$PERM_FALLBACK_FLAG" ]] \
  && log "permissions" "added the CLI permission flag for mode=$MODE because the settings injection was not confirmed" \
  || true
```

- [ ] **Step 2: claude engine の 4 つの合成箇所へ `$PERM_FALLBACK_FLAG` を差し込む**

`plan` の合成行（`--dangerously-skip-permissions '/plan $PROMPT_TEXT'` を含む行）は**変更しない**。
残る 4 行を次のとおり書き換える。**`execute` の else 側と `standby`/`review` の prompt 無し側を
飛ばさないこと**（前者は `CLAUDE_EXTRA_FLAGS` を持たず、後者は prompt を持たないので見落としやすい）。

変更前:
```bash
      if [[ -n "$CLAUDE_EXTRA_FLAGS" ]]; then
        CORE_CMD="$RUNNER_COMMAND $CLAUDE_EXTRA_FLAGS '$PROMPT_TEXT'"
      else
        CORE_CMD="$RUNNER_COMMAND '$PROMPT_TEXT'"
      fi
```
変更後:
```bash
      if [[ -n "$CLAUDE_EXTRA_FLAGS" ]]; then
        CORE_CMD="$RUNNER_COMMAND $CLAUDE_EXTRA_FLAGS$PERM_FALLBACK_FLAG '$PROMPT_TEXT'"
      else
        CORE_CMD="$RUNNER_COMMAND$PERM_FALLBACK_FLAG '$PROMPT_TEXT'"
      fi
```

変更前:
```bash
      if [[ -n "$PROMPT_TEXT" ]]; then
        CORE_CMD="$RUNNER_COMMAND${CLAUDE_EXTRA_FLAGS:+ $CLAUDE_EXTRA_FLAGS} '$PROMPT_TEXT'"
      else
        CORE_CMD="$RUNNER_COMMAND${CLAUDE_EXTRA_FLAGS:+ $CLAUDE_EXTRA_FLAGS}"
      fi
```
変更後:
```bash
      if [[ -n "$PROMPT_TEXT" ]]; then
        CORE_CMD="$RUNNER_COMMAND${CLAUDE_EXTRA_FLAGS:+ $CLAUDE_EXTRA_FLAGS}$PERM_FALLBACK_FLAG '$PROMPT_TEXT'"
      else
        CORE_CMD="$RUNNER_COMMAND${CLAUDE_EXTRA_FLAGS:+ $CLAUDE_EXTRA_FLAGS}$PERM_FALLBACK_FLAG"
      fi
```

変更前:
```bash
      CORE_CMD="$RUNNER_COMMAND${CLAUDE_MODEL_FLAGS:+ $CLAUDE_MODEL_FLAGS} '$PROMPT_TEXT'"
```
変更後:
```bash
      CORE_CMD="$RUNNER_COMMAND${CLAUDE_MODEL_FLAGS:+ $CLAUDE_MODEL_FLAGS}$PERM_FALLBACK_FLAG '$PROMPT_TEXT'"
```

あわせて `superpowers` 分岐のコメント末尾（`model/effort は役割設定なので付ける` の行）の後に
1 行足す:

```bash
      #  注入を確認できなかったときだけ PERM_FALLBACK_FLAG が権限フラグを補う
```

- [ ] **Step 3: 正常系がバイト等価であることを確認する**

Run:
```bash
cd apps/cmux-team-dispatch-task
bash -n skills/cmux-team-dispatch-task/scripts/launch-workspace.sh
bash test/test-launch-workspace-permissions.sh
bash test/test-role-models.sh
bash test/test-launch-workspace-codex.sh
bash test/test-launch-workspace-layout.sh
```
Expected: 4 スイートとも `--- all tests passed ---`。特に P6（superpowers にフラグを足さない）と
RM10c（同）が PASS のままであること。この 2 つが正常系のバイト等価を守っている。

- [ ] **Step 4: commit**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh
git commit -m "feat(cmux-team-dispatch-task): 注入未確認時に権限フラグへフォールバックする"
```

---

### Task 3: `test-launch-workspace-permissions.sh` に P12〜P26b を足す

**Files:**
- Modify: `apps/cmux-team-dispatch-task/test/test-launch-workspace-permissions.sh`

**Interfaces:**
- Consumes: Task 1 の `permission bypass not confirmed` / Task 2 の `added the CLI permission flag` という 2 つの警告文字列（テスト定数として固定する）、Task 2 の composed command
- Produces: なし

- [ ] **Step 1: ヘッダコメントを差し替える**

ファイル冒頭の 4 行コメントを次で置き換える:

```bash
# launch-workspace.sh が claude engine の worktree に注入する
# .claude/settings.local.json の permissions.defaultMode の回帰テスト。
# 検証項目: 全 MODE への注入 / codex engine 非対象 / 既存キー保持 / 冪等性 /
# 正常系では superpowers にフラグを足さないこと / info/exclude の追記 /
# 注入を確認できなかったときの --dangerously-skip-permissions へのフォールバック
# (3 ケース A・B・C、二重付与なし、正常系で誤発火しないこと) /
# 警告ログ値のサニタイズ (P26 / P26b、root では skip)。
```

- [ ] **Step 2: EXIT trap を書き換える**

変更前: `trap 'rm -rf "$TMP"' EXIT`
変更後:

```bash
trap 'chmod -R u+w "$TMP" 2>/dev/null || true; rm -rf "$TMP"' EXIT
```

P26 / P26b が `chmod a-w` したディレクトリを残すため、これが無いと `rm -rf` が
`Permission denied` で失敗する。`set -euo pipefail` 下では **EXIT trap 内の失敗が
そのままスクリプトの終了ステータスになる**ので、全ケース PASS でも rc=1 になり、
検証ブロックは stderr を捨てるので理由が画面に出ない。

- [ ] **Step 3: ヘルパーと定数を足す**

既存の `settings_of` / `default_mode_of` の定義の後に追加する:

```bash
WARN_NOT_CONFIRMED='permission bypass not confirmed'
WARN_FLAG_ADDED='added the CLI permission flag'

# composed command は runner script の単一行に載るので grep -c (行数) では二重付与を
# 検出できない。set -euo pipefail 下で 0 件を数えると落ちるので || true が要る。
# macOS の wc -l は先頭空白を出すので tr -d ' ' する。ファイル不在で 0 を返すと
# 否定側が空虚に PASS するため、存在確認を先に置く。
# 戻り値は必ず文字列で比較すること (( )) に渡すと missing:... が unbound variable になる。
count_flag() {
  [[ -f "${1:-}" ]] || { echo "missing:${1:-<none>}"; return; }
  { grep -o -- '--dangerously-skip-permissions' "$1" || true; } | wc -l | tr -d ' '
}

# 既存の run_launch は stderr を捨てるので、警告を assert するケース用に別に用意する。
# 素朴に 2>&1 でマージすると stdout 先頭に [runner] が混ざり jq -r '.runner_file' が壊れる。
run_launch_err() {   # $1 = stderr の保存先, 以降 launch の引数
  local err="$1"; shift
  CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" \
    bash "$LAUNCH" "$@" 2> "$err"
}

# 注入不能状態を作る 3 つのレシピ。いずれも chmod と違って root でも成立する。
break_a() { rm -rf "$1/.claude"; printf '' > "$1/.claude"; }                       # .claude が通常ファイル
break_b() { mkdir -p "$1/.claude"; printf '{ not json,,,\n' > "$1/.claude/settings.local.json"; }
break_c() { mkdir -p "$1/.claude/settings.local.json"; }                            # settings がディレクトリ

# 1 行に制御文字が含まれないことの macOS 可搬なアサート
has_no_ctrl() {
  [[ "$(printf '%s' "$1" | LC_ALL=C tr -d '\000-\037\177')" == "$1" ]]
}
```

**フラグの計数対象は `$runner_file` のみ。** stdout / stderr を混ぜたものに対して数えてはならない。
**テストが渡す prompt に `--dangerously-skip-permissions` の文字列を含めないこと**（`count_flag` が
付与ゼロでも 1 を返す）。**`'` `"` `` ` `` `$` `!` `\` も入れないこと**（composed command は
`zsh -ic "... '<prompt>' ..."` で二重に引用され、`launch-workspace.sh` はエスケープしない）。

- [ ] **Step 4: P12〜P20 を書く（フォールバックの基本挙動）**

既存の P11 の後に追加する:

```bash
# --- P12: standby (prompt 引数あり) + 注入不能 A ---
# prewarm の設計ペインは "$SLUG" "$OPUS_PROMPT" の 2 位置引数で起動するので prompt 有りの
# 合成行を通る。prompt 無しのケースだけではこの行の splice 忘れを 1 件も検出できない。
repo=$(new_repo p12); break_a "$repo"
out=$(run_launch_err "$TMP/err-p12" --cwd "$repo" --mode standby --role plan --runner claude \
  --status-dir "$TMP/status-p12" p12-standby 'agmsg actas p12 then wait idle')
runner_file=$(jq -r '.runner_file' <<<"$out")
if [[ "$(count_flag "$runner_file")" == "1" ]] \
   && grep -Fq -- "$WARN_FLAG_ADDED" "$TMP/err-p12" \
   && ! grep -Fq -- '--dangerously-skip-permissions' "$TMP/err-p12"; then
  pass 'P12 standby with prompt gains exactly one flag and logs the add'
else
  bad  'P12 standby with prompt gains exactly one flag and logs the add'
fi

# --- P13: superpowers + 注入不能 A ---
repo=$(new_repo p13); break_a "$repo"
out=$(run_launch --cwd "$repo" --mode superpowers --runner claude \
  --status-dir "$TMP/status-p13" p13-task 'do something')
[[ "$(count_flag "$(jq -r '.runner_file' <<<"$out")")" == "1" ]] \
  && pass 'P13 superpowers gains the fallback flag' \
  || bad  'P13 superpowers gains the fallback flag'

# --- P14: superpowers + 注入不能 A + --skip-permissions 明示 ---
# superpowers の合成箇所は SKIP_PERMISSIONS を読まないので、フォールバックは
# その値に関わらず 1 個だけ付く。case の superpowers アームが *) に落ちると 0 個になる。
repo=$(new_repo p14); break_a "$repo"
out=$(run_launch --cwd "$repo" --mode superpowers --runner claude --skip-permissions \
  --status-dir "$TMP/status-p14" p14-task 'do something')
[[ "$(count_flag "$(jq -r '.runner_file' <<<"$out")")" == "1" ]] \
  && pass 'P14 superpowers ignores --skip-permissions but takes the fallback once' \
  || bad  'P14 superpowers ignores --skip-permissions but takes the fallback once'

# --- P15: superpowers 正常系 + --skip-permissions 明示 ---
repo=$(new_repo p15)
out=$(run_launch --cwd "$repo" --mode superpowers --runner claude --skip-permissions \
  --status-dir "$TMP/status-p15" p15-task 'do something')
[[ "$(count_flag "$(jq -r '.runner_file' <<<"$out")")" == "0" ]] \
  && pass 'P15 superpowers keeps no flag when the injection succeeded' \
  || bad  'P15 superpowers keeps no flag when the injection succeeded'

# --- P16: standby (prompt なし) + 注入不能 A + --skip-permissions 明示 ---
# 二重付与の検出。P23 の弱い版で独自の検出力は無く、:795 の splice も担保しない
# (SKIP_PERMISSIONS=1 なので *) アームが偽になり PERM_FALLBACK_FLAG は空のまま)。
repo=$(new_repo p16); break_a "$repo"
out=$(run_launch --cwd "$repo" --mode standby --runner claude --skip-permissions \
  --status-dir "$TMP/status-p16" p16-standby)
[[ "$(count_flag "$(jq -r '.runner_file' <<<"$out")")" == "1" ]] \
  && pass 'P16 standby with --skip-permissions never doubles the flag' \
  || bad  'P16 standby with --skip-permissions never doubles the flag'

# --- P17: plan + 注入不能 A ---
# plan) ;; の単独削除・:804 への二重 splice・付与ログの無条件出力の 3 種を単独検出する
# 唯一のケース。stderr の否定 assert を落とさないこと。
repo=$(new_repo p17); break_a "$repo"
out=$(run_launch_err "$TMP/err-p17" --cwd "$repo" --mode plan --runner claude \
  --status-dir "$TMP/status-p17" p17-task 'do something')
if [[ "$(count_flag "$(jq -r '.runner_file' <<<"$out")")" == "1" ]] \
   && ! grep -Fq -- "$WARN_FLAG_ADDED" "$TMP/err-p17"; then
  pass 'P17 plan keeps one literal flag and logs no add'
else
  bad  'P17 plan keeps one literal flag and logs no add'
fi

# --- P18: execute + 注入不能 A + --skip-permissions なし ---
repo=$(new_repo p18); break_a "$repo"
out=$(run_launch --cwd "$repo" --mode execute --runner claude \
  --plan-file "$TMP/plan.md" --status-dir "$TMP/status-p18" p18-task)
[[ "$(count_flag "$(jq -r '.runner_file' <<<"$out")")" == "1" ]] \
  && pass 'P18 execute gains the fallback flag' \
  || bad  'P18 execute gains the fallback flag'

# --- P19: codex engine ---
# フラグ側は判別能力を持たない (BYPASS_INJECTION_OK が 0 になるのは claude 限定ブロックの
# 内側だけ) が、併記する「新警告が出ない」の側は読み直しを claude ブロックの外へ動かした
# 実装を実際に検出する。両方を必ず assert すること。
repo=$(new_repo p19); break_a "$repo"
out=$(run_launch_err "$TMP/err-p19" --cwd "$repo" --mode superpowers --runner codex \
  --status-dir "$TMP/status-p19" p19-task 'do something')
if [[ "$(count_flag "$(jq -r '.runner_file' <<<"$out")")" == "0" ]] \
   && ! grep -Fq -- "$WARN_NOT_CONFIRMED" "$TMP/err-p19"; then
  pass 'P19 codex takes neither the fallback nor the warning'
else
  bad  'P19 codex takes neither the fallback nor the warning'
fi

# --- P20: 正常系で誤発火しない ---
# standby / review / execute は元からフラグを持つ経路があるため、読み直しが常に失敗する
# 実装バグ (パス誤りなど) が composed command に現れず不可視になりうる。ここが唯一の砦。
for m in standby superpowers; do
  repo=$(new_repo "p20-$m")
  if [[ "$m" == "superpowers" ]]; then
    out=$(run_launch_err "$TMP/err-p20-$m" --cwd "$repo" --mode "$m" --runner claude \
      --status-dir "$TMP/status-p20-$m" "p20-$m" 'do something')
  else
    out=$(run_launch_err "$TMP/err-p20-$m" --cwd "$repo" --mode "$m" --runner claude \
      --status-dir "$TMP/status-p20-$m" "p20-$m")
  fi
  if [[ "$(count_flag "$(jq -r '.runner_file' <<<"$out")")" == "0" ]] \
     && ! grep -Fq -- "$WARN_NOT_CONFIRMED" "$TMP/err-p20-$m"; then
    pass "P20 $m stays unchanged when the injection succeeded"
  else
    bad  "P20 $m stays unchanged when the injection succeeded"
  fi
done
```

- [ ] **Step 5: P21〜P25 を書く（ケース B/C・短絡・unattended・非 git）**

```bash
# --- P21: standby (prompt なし・--skip-permissions なし) + 注入不能 B ---
# :795 の splice の担保者。B は既存ファイルが不正 JSON でマージが拒否されるケース。
repo=$(new_repo p21); break_b "$repo"
out=$(run_launch_err "$TMP/err-p21" --cwd "$repo" --mode standby --runner claude \
  --status-dir "$TMP/status-p21" p21-standby)
if [[ "$(count_flag "$(jq -r '.runner_file' <<<"$out")")" == "1" ]] \
   && grep -Fq -- "$WARN_NOT_CONFIRMED" "$TMP/err-p21" \
   && ! jq -e . "$(settings_of "$repo")" >/dev/null 2>&1; then
  pass 'P21 invalid JSON takes the fallback and is left untouched'
else
  bad  'P21 invalid JSON takes the fallback and is left untouched'
fi

# --- P22: worktree 再利用 (:575 の短絡経路) ---
# prewarm は全ペインに同一 --cwd を渡すので 2 枚目以降は必ずここを通る実運用の主経路。
repo=$(new_repo p22)
run_launch --cwd "$repo" --mode superpowers --runner claude \
  --status-dir "$TMP/status-p22" p22-first 'do something' >/dev/null
out=$(run_launch_err "$TMP/err-p22" --cwd "$repo" --mode standby --runner claude \
  --status-dir "$TMP/status-p22" p22-standby)
if [[ "$(count_flag "$(jq -r '.runner_file' <<<"$out")")" == "0" ]] \
   && ! grep -Fq -- "$WARN_NOT_CONFIRMED" "$TMP/err-p22" \
   && grep -Fq -- 'defaultMode is already bypassPermissions' "$TMP/err-p22"; then
  pass 'P22 worktree reuse short-circuits without firing the fallback'
else
  bad  'P22 worktree reuse short-circuits without firing the fallback'
fi

# --- P23: standby + --unattended + 注入不能 A ---
# PERM_FALLBACK_FLAG のブロックが UNATTENDED の SKIP_PERMISSIONS=1 より前に置かれると
# *) が足した後にもう 1 個足されて 2 個になる。ブロック位置の担保。
repo=$(new_repo p23); break_a "$repo"
out=$(run_launch --cwd "$repo" --mode standby --runner claude --unattended \
  --status-dir "$TMP/status-p23" p23-standby)
[[ "$(count_flag "$(jq -r '.runner_file' <<<"$out")")" == "1" ]] \
  && pass 'P23 --unattended never doubles the flag' \
  || bad  'P23 --unattended never doubles the flag'

# --- P24: standby (prompt なし・--skip-permissions なし) + 注入不能 C ---
# :795 の担保者かつ、戻り値ベース誤実装を弾ける唯一のケース。A と B は
# merge_claude_settings が 1 を返すので戻り値で分岐した実装でも P24 以外は全部通る。
# 「P22 があるから P24 は冗長」という判断でこの穴を復活させないこと。
repo=$(new_repo p24); break_c "$repo"
out=$(run_launch_err "$TMP/err-p24" --cwd "$repo" --mode standby --runner claude \
  --status-dir "$TMP/status-p24" p24-standby)
if [[ "$(count_flag "$(jq -r '.runner_file' <<<"$out")")" == "1" ]] \
   && grep -Fq -- "$WARN_NOT_CONFIRMED" "$TMP/err-p24"; then
  pass 'P24 directory settings takes the fallback despite merge returning 0'
else
  bad  'P24 directory settings takes the fallback despite merge returning 0'
fi

# --- P25: 非 git --cwd + 注入不能 A ---
# flag oracle としては P13 の重複。残す意味は「非 git でも launch が rc=0 で続き、
# 異常系でもフラグが付くこと」= P11 の異常系版。
# P11 の $TMP/plain-dir を再利用しないこと (P11 が .claude をディレクトリとして残すので
# break_a の printf が Is a directory で落ち、set -euo pipefail 下でスイートが停止する)。
plain25="$TMP/plain-dir-p25"
mkdir -p "$plain25"; break_a "$plain25"
if out=$(run_launch --cwd "$plain25" --mode superpowers --runner claude \
     --status-dir "$TMP/status-p25" p25-task 'do something' 2>/dev/null); then
  [[ "$(count_flag "$(jq -r '.runner_file' <<<"$out")")" == "1" ]] \
    && pass 'P25 non-git cwd still launches and gains the fallback' \
    || bad  'P25 non-git cwd still launches and gains the fallback'
else
  bad  'P25 non-git cwd must not abort the launch'
fi
```

- [ ] **Step 6: P26 / P26b を書く（サニタイザと判定順序）**

```bash
# --- P26 / P26b: 読めるが別値のケース (chmod が要るので root では skip) ---
# 到達には「有効な JSON が読めるのに書き込みは失敗する」状態が要り、それを作れるのは
# chmod a-w だけ。uid 0 はモードビットを無視して mktemp が成功し、ファイルが
# bypassPermissions に上書きされて全 assert が落ちるため root では成立しない。
# 到達するのは merge_claude_settings の failed to create a temp file であって
# failed to create .../.claude ではない (既存ディレクトリへの mkdir -p は成功する)。
if [[ $EUID -eq 0 ]]; then
  echo 'SKIP: P26 / P26b need chmod a-w, which uid 0 ignores'
else
  # P26: ESC/OSC + 改行で偽の [permissions] injected 行を捏造しようとする payload。
  # 生の制御バイトを JSON に書くと jq が control characters must be escaped で失敗し、
  # 読み直しが "" を返して全アサーションが自明に PASS する。必ず \u エスケープで書く。
  repo=$(new_repo p26)
  mkdir -p "$repo/.claude"
  printf '%s' '{"permissions":{"defaultMode":"acceptEdits]0;PWNED
[permissions] injected"}}' \
    > "$repo/.claude/settings.local.json"
  chmod a-w "$repo/.claude"
  out=$(run_launch_err "$TMP/err-p26" --cwd "$repo" --mode standby --runner claude \
    --status-dir "$TMP/status-p26" p26-standby)
  warn_line=$(grep -F -- "$WARN_NOT_CONFIRMED" "$TMP/err-p26" || true)
  # tr / grep は行単位なので改行の捏造は捕まえられない。警告が 1 行であることも見る。
  if [[ "$(count_flag "$(jq -r '.runner_file' <<<"$out")")" == "1" ]] \
     && [[ -n "$warn_line" ]] && has_no_ctrl "$warn_line" \
     && [[ "$(grep -ac "$WARN_NOT_CONFIRMED" "$TMP/err-p26" | tr -d ' ')" == "1" ]] \
     && ! grep -Fq -- '[permissions] injected permissions.defaultMode' "$TMP/err-p26"; then
    pass 'P26 sanitizer strips control bytes and blocks the forged injected line'
  else
    bad  'P26 sanitizer strips control bytes and blocks the forged injected line'
  fi

  # P26b: サニタイズすると bypassPermissions へちょうど潰れる payload。
  # 判定をサニタイズ後の値で行う実装 (この設計が禁じている形) だけがここで落ちる。
  repo=$(new_repo p26b)
  mkdir -p "$repo/.claude"
  printf '%s' '{"permissions":{"defaultMode":"bypassPermissions"}}' \
    > "$repo/.claude/settings.local.json"
  chmod a-w "$repo/.claude"
  out=$(run_launch --cwd "$repo" --mode standby --runner claude \
    --status-dir "$TMP/status-p26b" p26b-standby)
  [[ "$(count_flag "$(jq -r '.runner_file' <<<"$out")")" == "1" ]] \
    && pass 'P26b a value that sanitizes to bypassPermissions still takes the fallback' \
    || bad  'P26b a value that sanitizes to bypassPermissions still takes the fallback'
fi
```

- [ ] **Step 7: スイートを実行し、終了コードと残留物を確認する**

Run:
```bash
cd apps/cmux-team-dispatch-task
bash test/test-launch-workspace-permissions.sh; echo "rc=$?"
ls -d "${TMPDIR:-/tmp}"/tmp.* 2>/dev/null | wc -l
```
Expected: 全ケース PASS、`--- all tests passed ---`、**`rc=0`**、
`$TMPDIR` に消せない tmp ディレクトリが残っていないこと。
`rc=1` になる場合は EXIT trap の `chmod -R u+w` が入っていない（Step 2 を確認する）。

- [ ] **Step 8: commit**

```bash
git add apps/cmux-team-dispatch-task/test/test-launch-workspace-permissions.sh
git commit -m "test(cmux-team-dispatch-task): 権限フォールバックの回帰 P12-P26b を足す"
```

---

### Task 4: `test-prewarm-design-permissions.sh` を新設する

**Files:**
- Create: `apps/cmux-team-dispatch-task/test/test-prewarm-design-permissions.sh`

**Interfaces:**
- Consumes: `prewarm-panes.sh` の argv（`launch-workspace.sh` はスタブに差し替える）
- Produces: なし

**このファイルは本計画が入れる新挙動の回帰テストではない。** スタブが `launch-workspace.sh` を
実行しないので Task 1 / Task 2 のコードには 1 行も到達しない。固定するのは
「claude 設計ペインには `--skip-permissions` が渡らず、claude executor には渡る」という
既存の非対称であり、カバレッジ負債の返済である。既存カバレッジとの重複は次のとおりで、
新規価値は DB1 の executor 側と DB2 だけである:

| 既にカバーされている主張 | 既存テスト |
|------------------------|-----------|
| `--unattended` で設計 argv に `--skip-permissions` が付く | `test-prewarm-unattended.sh:75-78` (U1) |
| 通常時の設計 argv に `--skip-permissions` が無い | `test-prewarm-unattended.sh:80-83` (U2) |
| codex 設計に `--runner <codex>` と `--role plan` が渡る | `test-prewarm-all-codex.sh:68` (AC2) |
| claude executor の `--skip-permissions` 無条件付与 | **どのテストにも無い** |

- [ ] **Step 1: ファイルを作る**

```bash
#!/usr/bin/env bash
# prewarm-panes.sh が設計ペインと claude executor へ渡す権限フラグの非対称の回帰テスト。
#
# 本ファイルは launch-workspace.sh をスタブへ差し替えるため、Step 2a の注入判定や
# フォールバックのコードには到達しない。固定するのは「claude 設計ペインには
# --skip-permissions が渡らず (settings 注入に依存する)、claude executor には
# 無条件で渡る」という既存の非対称であって、フォールバック機構の回帰ではない。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREWARM="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/scripts" "$TMP/repo" "$TMP/agmsg"
git -C "$TMP/repo" init -q
git -C "$TMP/repo" config user.email test@example.invalid
git -C "$TMP/repo" config user.name test
touch "$TMP/repo/.gitkeep"
git -C "$TMP/repo" add .gitkeep
git -C "$TMP/repo" commit -qm init

cp "$PREWARM" "$TMP/scripts/prewarm-panes.sh"

cat > "$TMP/scripts/launch-workspace.sh" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$ARGV_LOG"
count=$(wc -l < "$ARGV_LOG" | tr -d ' ')
jq -n --arg surface "surface:$count" '{workspace_id:"workspace:1", surface_id:$surface}'
STUB
chmod +x "$TMP/scripts/launch-workspace.sh"

for s in join.sh delivery.sh leave.sh send.sh; do
  printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/agmsg/$s"
  chmod +x "$TMP/agmsg/$s"
done

cat > "$TMP/runners.json" <<'JSON'
{
  "default": "claude",
  "runners": [
    { "name": "claude", "command": "claude", "engine": "claude" },
    {
      "name": "codex",
      "command": "codex",
      "engine": "codex",
      "plan_model": "gpt-5.6-sol",
      "review_model": "gpt-5.6-sol",
      "exec_model": "gpt-5.6-terra"
    }
  ]
}
JSON

fail=0
pass() { echo "PASS: $1"; }
bad() { echo "FAIL: $1" >&2; fail=1; }

CASE_LOG=""

run_case() {
  local slug="$1"; shift
  CASE_LOG="$TMP/argv-$slug.log"
  : > "$CASE_LOG"
  # worktree は事前に作っておく。未作成のまま渡すと prewarm-panes.sh の
  # `git worktree add` が「テストを起動したリポジトリ」に対して走り、実リポジトリへ
  # ブランチと worktree 登録を残してしまう。使い捨て repo を cwd にするのは二重防御。
  mkdir -p "$TMP/repo-$slug"
  ( cd "$TMP/repo" && ARGV_LOG="$CASE_LOG" AGMSG_DIR="$TMP/agmsg" \
      RUNNERS_CONFIG_PATH="$TMP/runners.json" \
      bash "$TMP/scripts/prewarm-panes.sh" --with-design --agmsg-team demo-team \
        --cwd "$TMP/repo-$slug" --slug "$slug" --status-dir "$TMP/status-$slug" "$@" ) >/dev/null
}

# pane 行を --agmsg-from で特定する。末尾スペースを付けないと <slug> が <slug>-claude にも
# 前方一致する。--role exec での特定は --exec-choice ask のとき claude / codex の 2 行に
# マッチしてしまうので使わない。--agmsg-team は必須 (--with-design は無いと die する)。
pane_line() {
  grep -F -- "--agmsg-from $1 " "$CASE_LOG" || true
}

# <id> <pane-agent> <yes|no>: その pane 行に --skip-permissions があるか
expect_flag() {
  local id="$1" agent="$2" want="$3" line
  line=$(pane_line "$agent")
  if [[ -z "$line" ]]; then
    bad "$id pane '$agent' was not launched"
    return
  fi
  if grep -Fq -- '--skip-permissions' <<<"$line"; then
    [[ "$want" == yes ]] && pass "$id pane '$agent' carries --skip-permissions" \
                         || bad  "$id pane '$agent' must NOT carry --skip-permissions: $line"
  else
    [[ "$want" == no ]] && pass "$id pane '$agent' carries no --skip-permissions" \
                        || bad  "$id pane '$agent' must carry --skip-permissions: $line"
  fi
}

# --- DB1: claude 設計にはフラグ無し / claude executor にはフラグ有り ---
run_case db1 --design-runner claude --exec-runner claude --exec-choice claude
expect_flag DB1 db1 no
expect_flag DB1 db1-claude yes

# --- DB2: codex 設計にもフラグ無し ---
run_case db2 --design-runner codex --exec-runner codex --exec-choice codex
expect_flag DB2 db2 no

[[ $fail -eq 0 ]] && echo '--- all tests passed ---' || echo '--- failures ---'
exit "$fail"
```

- [ ] **Step 2: 実行権を付けて走らせる**

Run:
```bash
cd apps/cmux-team-dispatch-task
chmod +x test/test-prewarm-design-permissions.sh
bash test/test-prewarm-design-permissions.sh; echo "rc=$?"
```
Expected: DB1 が 2 行、DB2 が 1 行 PASS で `--- all tests passed ---`、`rc=0`。

`DB1 pane 'db1-claude' was not launched` が出る場合は `--exec-choice claude` で claude executor が
起動していない。`prewarm-panes.sh --help` で `--exec-runner` / `--exec-choice` の綴りを確認する。

- [ ] **Step 3: 残留物が無いことを確認する**

Run:
```bash
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins
git worktree list
git branch --list
```
Expected: worktree 4 件（main + 稼働中 3 worktree）、ブランチ一覧がテスト実行前と同じ。
増えていたら `mkdir -p "$TMP/repo-$slug"` が抜けている。

- [ ] **Step 4: commit**

```bash
git add apps/cmux-team-dispatch-task/test/test-prewarm-design-permissions.sh
git commit -m "test(cmux-team-dispatch-task): 設計ペインと executor の権限フラグ非対称を固定する"
```

---

### Task 5: ドキュメント 4 ファイルを同期する

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md`
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md`
- Modify: `apps/cmux-team-dispatch-task/README.md`
- Modify: `apps/cmux-team-dispatch-task/CLAUDE.md`

**Interfaces:**
- Consumes: Task 1 / Task 2 が確定させた挙動と 2 つの警告文字列
- Produces: なし

**逐語で置き換えること。** `scripts/check-doc-lang.mjs` は `*-ja.md` について
「日本語が 1 文字も無い」しか見ないので、訳が原文より短くても `pnpm check` は green のまま通る。
整合を守る手段は逐語置換しかない。

- [ ] **Step 1: SKILL.md の表 1 行を差し替える**

アンカーは `| claude | superpowers |` で始まる行。次で置き換える:

```
| claude | superpowers | `<command> [--model <plan_model>] [--effort <plan_effort>] [--dangerously-skip-permissions] 'Read and follow the task in .cmux-team-dispatch-task-prompt.md'` |
```

角括弧の中に条件を書き込まない（この repo の慣行は角括弧を裸で置き、条件は直下の散文が担う）。
`claude | execute` 行と `claude | standby` / `claude | review` 行は変更・追加しない。

- [ ] **Step 2: SKILL.md の表下の散文に段落を足す**

アンカーは `` `review_model` explicitly); when still unset, codex's own default model applies. ``
（表直下の段落の最終行）。**その直後に空行 1 行と次の段落**を挿入する:

```
The two `[--dangerously-skip-permissions]` brackets in that table are both conditional,
but not on the same condition. On the `execute` row it appears when the caller asked for
it, that is `--skip-permissions` or `--unattended` on the claude engine, or when the
settings readback described below fails. On the `superpowers` row only the readback
condition applies: that composition site never reads `--skip-permissions` at all.
```

- [ ] **Step 3: SKILL.md の注入説明段落を差し替える**

アンカーは `Regardless of MODE, when the resolved runner engine is` で始まる段落。
その段落全体（`--dangerously-skip-permissions` to every launch path.` まで）を次で置き換える:

```
Regardless of MODE, when the resolved runner engine is `claude`, the script
injects `permissions.defaultMode: "bypassPermissions"` into the worktree's
`.claude/settings.local.json` (merged with `jq`, atomically via `mktemp` + `mv`,
and skipped when the key already holds that value). This is what keeps normal
(non-loop) dispatches free of permission prompts on the launch paths that carry
no permission flag of their own: `superpowers`, and the `execute` / `standby` /
`review` panes started without `--skip-permissions` — the prewarm design pane
being the main one in practice, since Phase B always spawns executors with the
flag and every claude reviewer is spawned with it too. The loop path keeps its
own guarantee through `--unattended`.

The injection is best effort, and its return code cannot be trusted: when
`settings.local.json` happens to be a directory, the atomic `mv` moves the temp
file inside it and still reports success. The launcher therefore checks the file
itself with `jq -e`. When `permissions.defaultMode` is not exactly
`bypassPermissions` at that point — the merge could not be written, a
pre-existing `settings.local.json` holds invalid JSON that `jq` refuses, or the
directory case above — the launcher logs a warning containing `permission bypass
not confirmed` and adds `--dangerously-skip-permissions` to that launch. It never
doubles the flag: `plan` already carries it literally at the composition site,
and `execute` / `standby` / `review` are skipped when the caller actually passed
`--skip-permissions`. `superpowers` is the exception that always gets the
fallback, because its composition site never reads `--skip-permissions` at all.
That is also why the `[--dangerously-skip-permissions]` bracket on the
`superpowers` row above carries only part of the condition the one on the
`execute` row carries. Without the fallback the design pane would be the only
claude pane with no second line of defence, and it would block on its first
permission prompt with nobody attached.
```

- [ ] **Step 4: SKILL.md の AskUserQuestion 行の書き出しを直す**

置換後、その行の先行詞がフォールバック段落へ移るため、アンカー
`` `AskUserQuestion` stays interactive under that mode: the permission system gates ``
を次で置き換える:

```
`AskUserQuestion` stays interactive under `bypassPermissions`: the permission system gates
```

- [ ] **Step 5: SKILL.md に日本語が入っていないことを確認する**

Run:
```bash
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins
node scripts/check-doc-lang.mjs apps/cmux-team-dispatch-task
```
Expected: `OK`。`japanese-in-english-doc` が出たら Step 1-4 で日本語を混ぜている。

- [ ] **Step 6: guide-ja.md の表 1 行を差し替える**

アンカーは `| claude | superpowers |` で始まる行。guide-ja は固定プロンプトを表の上へ括り出して
cell を `'<PROMPT>'` に短縮する書式なので、SKILL.md の行をそのまま貼らないこと:

```
| claude | superpowers | `<command> [--model <plan_model>] [--effort <plan_effort>] [--dangerously-skip-permissions] '<PROMPT>'` |
```

- [ ] **Step 7: guide-ja.md の既存ドリフト 2 件を直す**

SKILL.md にあって guide-ja.md に無い / 欠けている行を修復する（4 ファイル整合ルール上、
表を触る以上ここで直す）。

アンカー `| codex  | superpowers |` の行を次で置き換える（bypass フラグが抜けている）:

```
| codex  | superpowers | `<command> [-c model_reasoning_effort='<plan_effort>'] [--model <plan_model>] --dangerously-bypass-approvals-and-sandbox '$superpowers:brainstorming <PROMPT>'` |
```

`| codex  | execute     |` の行の**直後**に、欠落している `codex | review` 行を挿入する:

```
| codex  | review      | `<command> [-c model_reasoning_effort='<review_effort>'] --model <review_model> --sandbox workspace-write -c approval_policy='never' --add-dir <STATUS_DIR>` |
```

- [ ] **Step 8: guide-ja.md の表直下に角括弧の説明段落を足す**

guide-ja は表の直下が effort 段落（原文は SKILL.md の `Reasoning effort resolves...`）なので、
**そこへ混ぜてはならない**。表の直後・effort 段落の直前に独立段落として挿入する
（前後に空行が 1 行ずつ残るようにする）:

```
上表の 2 つの `[--dangerously-skip-permissions]` はどちらも条件付きだが、条件は同じではない。
`execute` 行のそれは、呼び出し元が要求したとき（`--skip-permissions`、または claude engine での
`--unattended`）か、後述の settings 読み直しが失敗したときに現れる。`superpowers` 行のそれは
読み直しの条件だけで、その組み立て箇所は `--skip-permissions` をそもそも読まない。
```

- [ ] **Step 9: guide-ja.md の注入説明段落を差し替える**

アンカーは `MODE によらず、解決された runner engine が` で始まる段落。その段落全体
（`通常（非 loop）ディスパッチから permission prompt を消している仕組み。` まで）を次で置き換える:

```
MODE によらず、解決された runner engine が `claude` のときは worktree の
`.claude/settings.local.json` に `permissions.defaultMode: "bypassPermissions"` を
注入する（`jq` でマージし、`mktemp` + `mv` でアトミックに置換。既に同値ならスキップ）。
これが、権限フラグを自前で持たない起動経路 — `superpowers` と、`--skip-permissions`
無しで起動する `execute` / `standby` / `review` ペイン — から通常（非 loop）ディスパッチの
permission prompt を消している仕組み。実際の主役は prewarm の設計ペインで、Phase B の
executor も claude のレビューペインも常にフラグ付きで spawn される。loop 経路は
`--unattended` で別途保証される。

注入はベストエフォートで、しかも戻り値は信用できない。`settings.local.json` が
たまたまディレクトリだったとき、アトミックな `mv` は temp をその中へ移動したうえで
成功を報告するからである。そのため launcher は `jq -e` でファイル自体を判定する。その時点で
`permissions.defaultMode` が厳密に `bypassPermissions` でなければ — マージを書き込めなかった、
既存の `settings.local.json` が不正な JSON で `jq` に拒否された、あるいは上記の
ディレクトリのケース — `permission bypass not confirmed` を含む警告を出し、その launch に
`--dangerously-skip-permissions` を足す。二重付与は起きない。`plan` は組み立て箇所で
既にリテラルを持っており、`execute` / `standby` / `review` は呼び出し元が実際に
`--skip-permissions` を渡していたときは足さないからである。`superpowers` だけは例外で、
組み立て箇所がそもそも `--skip-permissions` を読まないため常にフォールバックが付く。
上の表の `superpowers` 行の `[--dangerously-skip-permissions]` が `execute` 行のそれより
狭い条件しか持たないのはこのためである。フォールバックが無いと、設計ペインだけが
第二の防壁を持たない claude ペインとなり、誰も見ていない状態で最初の permission prompt に
当たって停止する。
```

- [ ] **Step 10: guide-ja.md の AskUserQuestion 行の書き出しを直す**

アンカー `このモードでも \`AskUserQuestion\` は対話的なまま残る。` を含む行の書き出しを、
SKILL.md と同じ理由（先行詞がフォールバック段落へ移る）で次に変える:

```
`bypassPermissions` の下でも `AskUserQuestion` は対話的なまま残る。permission システムが門番をするのは
```

- [ ] **Step 11: README.md に段落を足す**

「permission prompt の抑止」節で、`opt-out 用の config キーは用意していない` を含む段落の直後の
空行の後、**`codex engine は対象外` で始まる段落の直前**に次の段落と空行 1 行を挿入する
（節の末尾に置くと claude 専用の説明が codex の記述の後に来る）:

```
注入はベストエフォートで、戻り値も信用できない（`settings.local.json` がディレクトリだと
`mv` が temp をその中へ移して成功を報告する）。そのため起動スクリプトは書き込み後に
`jq -e` でファイルを判定し、`permissions.defaultMode` が `bypassPermissions` になっていなければ
`permission bypass not confirmed` を含む警告を出したうえで、その起動にだけ
`--dangerously-skip-permissions` を足す。これが無いと、権限フラグを持たない設計ペインだけが
注入失敗時に素の権限で上がり、誰も見ていない状態で permission prompt に当たって止まる。
なおこのフォールバックも上記の確認ダイアログの前提を共有するので、
`skipDangerousModePermissionPrompt` をユーザー設定に置いていない環境では同じダイアログで
止まる点は変わらない。
```

- [ ] **Step 12: CLAUDE.md 保守項目 25 の第 1 bullet を差し替える**

アンカーは `既に同値なら書き込まずスキップ（worktree 再利用時の二重注入なし）、失敗は警告のみで dispatch を止めないこと`。
末尾の `失敗は警告のみで dispatch を止めないこと` を次で置き換える（bullet は 1 行のまま保つ）:

```
失敗時は `permission bypass not confirmed` を警告し、フォールバックしたうえで dispatch は止めないこと。書き込み後に `jq -e` でファイル実体を判定して `bypassPermissions` を確認できなければ、`plan`（組み立て箇所でリテラル付与済み）と、`--skip-permissions` が `CLAUDE_EXTRA_FLAGS` 経由で届く MODE（`execute` / `standby` / `review` で、かつ呼び出し元が実際に渡したとき）を除いて `--dangerously-skip-permissions` へフォールバックすること。`superpowers` は `--skip-permissions` を受け取らないため、その有無に関わらずフォールバックを付けること。判定に `merge_claude_settings` の戻り値を使ってはならない（`settings.local.json` がディレクトリのとき `mv` が成功を報告する）
```

- [ ] **Step 13: CLAUDE.md 保守項目 25 の残り 3 bullet を直す**

`merge_claude_settings` bullet（`両者が同じ settings.local.json に共存すること` で終わる行）は
**句点で終わっていない**ので、区切りを含めて 1 行に連結する（改行を入れない）:

```
。また、新しい警告文にフラグのリテラル `--dangerously-skip-permissions` を含めないこと（テストが composed command のフラグを数えるとき警告文にマッチして空虚な PASS になる）。agmsg の `delivery.sh set` は同じ `settings.local.json` を read-modify-write するので、`prewarm-panes.sh` の Step 2 が全 launch より前に走る順序を崩さないこと（崩すと注入が巻き戻り、判定は Step 2a で終わっているため検出できない）
```

codex bullet（`codex engine には**一切注入しない**こと。` を含む行）の**第 1 文の直後**に足す:

```
フォールバックフラグも codex には付けないこと（P19 が守る）。
```

最終 bullet（`回帰は \`bash test/test-launch-workspace-permissions.sh\` の P1〜P11` で始まる行）を
次で置き換える:

```
回帰は `bash test/test-launch-workspace-permissions.sh` の P1〜P26b（全 MODE 注入 / codex 非対象 / 既存キー保持 / 冪等 / 正常系では superpowers にフラグを足さない / info/exclude 追記 / `--skip-permissions` との共存 / 非 git cwd でも launch が成功 / 判定失敗の 3 ケース A・B・C でのフォールバック / superpowers は `--skip-permissions` を読まない（P14）/ standby の prompt 有無の両分岐 / plan と `--skip-permissions` 既付与での二重付与なし / 正常系で誤発火しない（P20）/ worktree 再利用の短絡では発火しない / `--unattended` との共存 / ログ値のサニタイズと判定順序の回帰（P26 / P26b、root では skip））と `bash test/test-prewarm-design-permissions.sh`（DB1-DB2: 設計ペインと claude executor の `--skip-permissions` 非対称。本項目の変更に対する回帰ではなく既存カバレッジ負債の返済）で検証する。警告文言 `permission bypass not confirmed` と `added the CLI permission flag` はテスト定数なので、変えたら両テストも同時に更新すること
```

- [ ] **Step 14: doc gate を走らせる**

Run:
```bash
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins
node scripts/check-doc-lang.mjs apps/cmux-team-dispatch-task
```
Expected: `OK`。

- [ ] **Step 15: commit**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md \
        apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md \
        apps/cmux-team-dispatch-task/README.md \
        apps/cmux-team-dispatch-task/CLAUDE.md
git commit -m "docs(cmux-team-dispatch-task): 権限フォールバックを 4 ファイルへ同期する"
```

---

### Task 6: 全体検証

**Files:** なし（検証のみ）

- [ ] **Step 1: 全スイートと doc gate を走らせる**

Run（**worktree ルートで実行すること**。`/Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins`
は main のチェックアウトで、変更した 4 ファイルはそこには存在しない）:

```bash
(
  set +e
  WT=$(git rev-parse --show-toplevel)
  cd "$WT/apps/cmux-team-dispatch-task" || exit 1
  rc=0
  for t in test/*.sh; do
    printf '%-46s ' "$t"
    if bash "$t" >/dev/null 2>&1; then echo OK; else echo FAILED; rc=1; fi
  done
  cd "$WT" || exit 1
  node scripts/check-doc-lang.mjs apps/cmux-team-dispatch-task || rc=1
  echo "rc=$rc"
)
```
Expected: 全スイート `OK`、`check-doc-lang` が `OK`、`rc=0`。
FAILED が出たスイートは `>/dev/null 2>&1` を外して項目単位で確認する。
`test-runner-terminal-status.sh` が稀に 1 度だけ落ちる既知の flake があるので、
そのスイートだけ落ちたときは 1 回再実行して切り分ける。

- [ ] **Step 2: `pnpm check` を走らせる**

Run:
```bash
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins && pnpm check
```
Expected: `check-doc-lang` が OK。`@tanaka-yui/token-meter` の `noNonNullAssertion` 警告 4 件は
既知のノイズであって失敗ではない。

worktree 側で `pnpm check` を走らせると `node_modules` が無く `turbo: command not found` で
落ちるので、main 側で走らせるか worktree で先に `pnpm install` する。main 側で走らせた場合は
**変更した 4 ファイルが検査対象に入らない**ので、Step 1 の `check-doc-lang` を doc gate の
根拠として報告に明記する。

- [ ] **Step 3: 残留物を確認する**

Run:
```bash
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins
git worktree list
git branch --list
git worktree prune -n -v
cd .worktrees/design-bypass-permission && git status --porcelain
```
Expected: worktree 4 件（main + 稼働中 3 worktree）、ブランチ一覧が実行前と同じ、
`git worktree prune -n -v` に刈るものが無い、`git status --porcelain` が
`.cmux-team-dispatch-task-prompt.md` と 3 本の `.cmux-team-dispatch-task-run-*.sh` の
4 件だけであること。**この 4 件を commit に含めないこと。**

---

## Self-Review

**1. Spec coverage**

| spec の要求 | 対応タスク |
|------------|-----------|
| 変更 1（Step 2a の判定 + `BYPASS_INJECTION_OK`） | Task 1 |
| 変更 1（サニタイズはログ専用 / 長さマーカー） | Task 1 Step 3 |
| 変更 2（`PERM_FALLBACK_FLAG` と 4 箇所の splice） | Task 2 |
| 変更 3-1（P12〜P26b + 2 ヘルパー + trap） | Task 3 |
| 変更 3-2（DB1-DB2） | Task 4 |
| 変更 4-1〜4-4（4 ファイル同期 + ドリフト修復） | Task 5 |
| 変更 4-5（usage ヘッダ） | Task 1 Step 1 |
| 変更 4-6（Step 2a コメント） | Task 1 Step 2 |
| 検証（worktree ルート / `|| rc=1` / 残留物） | Task 6 |

**2. Placeholder scan:** 「適切に」「必要に応じて」「TBD」の類は無い。全コードブロックが実物。

**3. Type consistency:** `BYPASS_INJECTION_OK`（Task 1 が produce → Task 2 が consume）、
`PERM_FALLBACK_FLAG`（Task 2 内で完結、先頭空白 1 つを含む文字列）、
`count_flag` / `run_launch_err` / `break_a` / `break_b` / `break_c` / `has_no_ctrl`
（Task 3 内で定義・使用）、`pane_line` / `expect_flag`（Task 4 内で定義・使用）。
警告文字列 `permission bypass not confirmed` と `added the CLI permission flag` は
Task 1 / Task 2 が出力し Task 3 が定数として固定し Task 5 が 4 ファイルへ書く。表記ゆれ無し。
