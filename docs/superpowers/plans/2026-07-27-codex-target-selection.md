# codex-review / codex-exec 対象確定フロー Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `cmux-codex-review` に `--path` / `--list-targets`、`cmux-codex-exec` に `--list-targets` を追加し、引数無指定時にコマンド層がレビュー・実装対象をユーザーに確認するようにする。

**Architecture:** 候補列挙は bin の `--list-targets`（決定的・テスト可能・cmux 不要）が担い、確認（ask）はコマンド層の Markdown 手順が担う。bin は対話しない。既定動作と `!` 直接実行の後方互換は維持する。

**Tech Stack:** bash（`#!/usr/bin/env bash` + `set -euo pipefail`）、stub ベースのシェルテスト、Claude Code Plugin の Markdown（commands / SKILL）

## Global Constraints

- **macOS の bash 3.2 で動くこと**: `${ARR[@]}` は空配列だと `set -u` 下でエラーになるため、空になりうる配列展開は必ずガードする。連想配列・`declare -n` は使わない。
- **ドキュメント・コメント・コミットメッセージは日本語**、コード（変数名・CLI フラグ）は英語。
- **既定動作を変えない**: 引数無指定で `bin` を直接実行したときの挙動（review = 未コミット変更 / exec = plans の mtime 最新）は現状のまま。
- **バージョンは 3 か所同期**: `apps/<name>/.claude-plugin/plugin.json`、`apps/<name>/.codex-plugin/plugin.json`、ルート `.claude-plugin/marketplace.json`。
- `--list-targets` の出力形式は 1 行 1 候補の TSV `target<TAB>kind<TAB>value<TAB>label`。
- 参照する設計書: `docs/superpowers/specs/2026-07-27-codex-target-selection-design.md`

---

### Task 1: cmux-codex-review に `--path` を追加

指定したファイルの**内容全体**をレビュー対象にするオプション。差分ではなく文書レビュー用。

**Files:**
- Modify: `apps/cmux-codex-review/bin/cmux-codex-review`
- Test: `apps/cmux-codex-review/test/test-cmux-codex-review.sh`

**Interfaces:**
- Consumes: なし（最初のタスク）
- Produces: `cmux-codex-review --path <file>`（繰り返し可）。`TARGET="path"` / 配列 `PATHS` / 結合文字列 `PATHS_JOINED` を後続タスクが参照する。

- [ ] **Step 1: stub cmux に new-split の呼び出し記録を追加する**

`apps/cmux-codex-review/test/test-cmux-codex-review.sh` の stub cmux（現在 30〜35 行目付近）を次の内容に置き換える。`SPLIT_LOG` が未設定なら `/dev/null` に捨てるので既存テストには影響しない。

```bash
# stub cmux: new-split は surface を返し（SPLIT_LOG があれば呼び出しを記録）、send は送信文字列を記録
cat > "$TMP/bin/cmux" <<'STUB'
#!/usr/bin/env bash
if [[ "$1" == "new-split" ]]; then
  echo "split" >> "${SPLIT_LOG:-/dev/null}"
  echo "OK surface:31 workspace:9"; exit 0
fi
if [[ "$1" == "send" ]]; then printf '%s' "$4" > "$SENT_CMD"; exit 0; fi
STUB
chmod +x "$TMP/bin/cmux"
```

- [ ] **Step 2: 失敗するテスト D6 / D7 を追加する**

同ファイルの「入力検証: -m/-e に危険な文字を渡すと拒否される」ブロックの**直前**に次を挿入する。

```bash
# --- D6: --path 指定 → ファイル全文レビュー指示になり、prompt は 1 引数 ---
echo "spec body" > "$TMP/a-design.md"
echo "plan body" > "$TMP/b-plan.md"
CMUX_BIN="$TMP/bin/cmux" "$BIN" --path "$TMP/a-design.md" --path "$TMP/b-plan.md" >/dev/null 2>&1
reparse
if [[ "$(argc)" == "9" ]] \
  && prompt | grep -q "$TMP/a-design.md" \
  && prompt | grep -q "$TMP/b-plan.md" \
  && prompt | grep -q "読み"; then
  echo "PASS D6: --path 2 件が prompt に無傷で到達、argc=9"
else
  echo "FAIL D6: argc=$(argc) / prompt=[$(prompt)]"
  fail=1
fi

# --- D7: 存在しない --path は非ゼロ終了し、ペインを分割しない ---
rm -f "$TMP/split.log"
if ! SPLIT_LOG="$TMP/split.log" CMUX_BIN="$TMP/bin/cmux" "$BIN" --path "$TMP/does-not-exist.md" >/dev/null 2>&1 \
  && [[ ! -f "$TMP/split.log" ]]; then
  echo "PASS D7: 存在しない --path を拒否し、ペインを分割しない"
else
  echo "FAIL D7: 存在しないパスでペイン分割 or 正常終了した"
  fail=1
fi
```

またファイル冒頭のコメント（不変条件リスト、16 行目付近の `D5.` の次）に 2 行足す:

```bash
#   D6. --path はファイル全文レビュー指示になり、パスが prompt へ無傷で届く
#   D7. 存在しない --path は非ゼロ終了し、ペインを分割しない
```

- [ ] **Step 3: テストを実行して失敗を確認する**

Run: `bash apps/cmux-codex-review/test/test-cmux-codex-review.sh`
Expected: `FAIL D6` と `FAIL D7` が出て、最後に `--- FAIL あり ---`（終了コード 1）。D1〜D5 は PASS のまま。

- [ ] **Step 4: bin に `--path` を実装する**

`apps/cmux-codex-review/bin/cmux-codex-review` を編集する。

(a) 変数初期化（32〜34 行目付近）を次に置き換える:

```bash
DIR="right"; MODEL="gpt-5.6-sol"; EFFORT="xhigh"
TARGET="uncommitted"; TARGET_ARG=""; PATHS_JOINED=""
PATHS=()
TEAM=""; REVIEWER=""; PARENT=""; INSTRUCTIONS=""
```

(b) 引数パースの `--commit` 行の直後に `--path` を足す:

```bash
    --path)        TARGET="path"; PATHS+=("$2"); shift 2 ;;
```

(c) model / effort の正規表現検証の直後に、パス存在検証を足す（`cmux new-split` より**前**であることが D7 の要件）:

```bash
# --path のファイル存在検証。ペイン分割前に行う（無効なパスでペインを撒かないため）
if [[ "$TARGET" == "path" ]]; then
  for p in "${PATHS[@]}"; do
    [[ -f "$p" ]] || { echo "エラー: --path のファイルが存在しません: $p" >&2; exit 1; }
  done
fi
```

(d) レビュー指示の組み立て（57〜67 行目付近の `case "$TARGET"` から `追加指示:` まで）を次に置き換える:

```bash
# レビュー対象の説明文
case "$TARGET" in
  base)   TARGET_DESC="現在のブランチと $TARGET_ARG ブランチの差分" ;;
  commit) TARGET_DESC="コミット $TARGET_ARG の変更" ;;
  path)   TARGET_DESC="" ;;
  *)      TARGET_DESC="未コミットの変更 (git の staged / unstaged / untracked)" ;;
esac

if [[ "$TARGET" == "path" ]]; then
  # 差分ではなくファイル内容そのものをレビューさせる（spec/plan は文書として妥当かを見たいため）
  PATHS_JOINED=$(printf '%s, ' "${PATHS[@]}"); PATHS_JOINED=${PATHS_JOINED%, }
  REVIEW_INSTR="ファイル $PATHS_JOINED を読み、内容をレビューし、問題点・改善点を具体的に指摘せよ。"
else
  REVIEW_INSTR="$TARGET_DESC をレビューし、問題点・改善点を具体的に指摘せよ。"
fi
[[ -n "$INSTRUCTIONS" ]] && REVIEW_INSTR="$REVIEW_INSTR

追加指示: $INSTRUCTIONS"
```

(e) 最終行の起動サマリを次に置き換える:

```bash
echo "codex-review 起動: $S (方向: $DIR / model: $MODEL / effort: $EFFORT / 対象: $TARGET${TARGET_ARG:+ $TARGET_ARG}${PATHS_JOINED:+ $PATHS_JOINED})"
```

(f) ヘッダのコメント Usage（19〜21 行目付近の `--commit <sha>` の次）に 1 行足す:

```bash
#   --path <file>                   指定ファイルの内容をレビュー (繰り返し可)
```

- [ ] **Step 5: テストを実行して全 PASS を確認する**

Run: `bash apps/cmux-codex-review/test/test-cmux-codex-review.sh`
Expected: `PASS D6` / `PASS D7` を含む全項目 PASS、最後に `--- すべて PASS ---`（終了コード 0）。

- [ ] **Step 6: コミット**

```bash
git add apps/cmux-codex-review/bin/cmux-codex-review apps/cmux-codex-review/test/test-cmux-codex-review.sh
git commit -m "feat(cmux-codex-review): 指定ファイルの全文をレビューする --path を追加"
```

---

### Task 2: cmux-codex-review に `--list-targets` を追加

引数無指定時にコマンド層が読む候補一覧を出力するモード。ペイン分割しないので cmux 不要。

**Files:**
- Modify: `apps/cmux-codex-review/bin/cmux-codex-review`
- Test: `apps/cmux-codex-review/test/test-cmux-codex-review.sh`

**Interfaces:**
- Consumes: Task 1 の `--path`（候補の `kind=path` はそのまま `--path <value>` に変換される）
- Produces: `cmux-codex-review --list-targets` → stdout に TSV。列は `target<TAB>kind<TAB>value<TAB>label`、`kind` は `uncommitted` または `path`、`label` は `未コミット変更 (N files)` または `<spec|plan> / <committed|modified|untracked> / <MM-DD HH:MM>`。候補ゼロなら空出力・終了コード 0。

- [ ] **Step 1: 失敗するテスト D8 を追加する**

`apps/cmux-codex-review/test/test-cmux-codex-review.sh` の D7 ブロックの直後に挿入する。

```bash
# --- D8: --list-targets は cmux 無し・CMUX_SOCKET_PATH 無しで候補を TSV 出力する ---
REPO="$TMP/repo"
mkdir -p "$REPO/docs/superpowers/specs" "$REPO/docs/superpowers/plans"
git -C "$REPO" init -q >/dev/null 2>&1
git -C "$REPO" config user.email tester@example.com
git -C "$REPO" config user.name tester
echo "spec body" > "$REPO/docs/superpowers/specs/2026-01-01-a-design.md"
git -C "$REPO" add -A >/dev/null 2>&1
git -C "$REPO" commit -qm init >/dev/null 2>&1
echo "plan body" > "$REPO/docs/superpowers/plans/2026-01-02-b-plan.md"
lt=$(cd "$REPO" && env -u CMUX_SOCKET_PATH CMUX_BIN=/nonexistent/cmux "$BIN" --list-targets 2>&1)
if printf '%s\n' "$lt" | grep -q "^target.*uncommitted" \
  && printf '%s\n' "$lt" | grep -q "specs/2026-01-01-a-design.md.*spec / committed" \
  && printf '%s\n' "$lt" | grep -q "plans/2026-01-02-b-plan.md.*plan / untracked"; then
  echo "PASS D8: --list-targets が cmux 無しで候補を列挙"
else
  echo "FAIL D8: [$lt]"
  fail=1
fi
```

冒頭のコメント（不変条件リスト）に 1 行足す:

```bash
#   D8. --list-targets は cmux を呼ばずに候補を TSV 出力する（cmux 外でも動く）
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `bash apps/cmux-codex-review/test/test-cmux-codex-review.sh`
Expected: `FAIL D8:` が出る（`--list-targets` が未実装なので、`CMUX_SOCKET_PATH 未設定` エラーか、未知の引数として無視されペイン分割へ進み `/nonexistent/cmux` で失敗する）。D1〜D7 は PASS。

- [ ] **Step 3: bin に `--list-targets` を実装する**

`apps/cmux-codex-review/bin/cmux-codex-review` を編集する。

(a) **`CMUX_SOCKET_PATH` チェック（27〜30 行目付近）を削除**し、引数パースより前に候補列挙関数を定義する。`CMUX_BIN="${CMUX_BIN:-cmux}"` の直後に置く:

```bash
# 候補列挙。未コミット変更と docs/superpowers/{specs,plans} の直近 md を TSV で出す。
# 列: target<TAB>kind<TAB>value<TAB>label
list_targets() {
  local n kind d f state mt
  n=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  [[ "${n:-0}" -gt 0 ]] && printf 'target\tuncommitted\t\t未コミット変更 (%s files)\n' "$n"
  for kind in spec plan; do
    case "$kind" in
      spec) d="docs/superpowers/specs" ;;
      plan) d="docs/superpowers/plans" ;;
    esac
    [[ -d "$d" ]] || continue
    for f in $(ls -t "$d"/*.md 2>/dev/null | head -3); do
      if ! git ls-files --error-unmatch "$f" >/dev/null 2>&1; then
        state="untracked"
      elif git diff --quiet HEAD -- "$f" 2>/dev/null; then
        state="committed"
      else
        state="modified"
      fi
      mt=$(date -r "$f" '+%m-%d %H:%M' 2>/dev/null || echo "-")
      printf 'target\tpath\t%s\t%s / %s / %s\n' "$f" "$kind" "$state" "$mt"
    done
  done
  return 0
}
```

(b) 変数初期化に `LIST_TARGETS=0` を足す:

```bash
LIST_TARGETS=0
```

(c) 引数パースの `--path` 行の直後に足す:

```bash
    --list-targets) LIST_TARGETS=1; shift ;;
```

(d) 引数パースの `done` の**直後**（model / effort 検証の前）に、列挙モードの分岐と、削除した cmux チェックの再配置を書く:

```bash
# 候補列挙モードはペイン分割しないので cmux 不要（cmux 外・テストからも呼べる）
if [[ $LIST_TARGETS -eq 1 ]]; then
  list_targets
  exit 0
fi

if [[ -z "${CMUX_SOCKET_PATH:-}" ]]; then
  echo "エラー: cmux 内でのみ使用可能です (CMUX_SOCKET_PATH 未設定)" >&2
  exit 1
fi
```

(e) ヘッダのコメント Usage に 1 行足す:

```bash
#   --list-targets                  レビュー対象の候補を TSV で列挙して終了 (cmux 不要)
```

- [ ] **Step 4: テストを実行して全 PASS を確認する**

Run: `bash apps/cmux-codex-review/test/test-cmux-codex-review.sh`
Expected: `PASS D8` を含む全項目 PASS、`--- すべて PASS ---`（終了コード 0）。

- [ ] **Step 5: 実リポジトリでの出力を目視確認する**

Run: `apps/cmux-codex-review/bin/cmux-codex-review --list-targets`
Expected: 少なくとも `target	path	docs/superpowers/specs/2026-07-27-codex-target-selection-design.md	spec / committed / ...` の行が出る。エラー終了しない。

- [ ] **Step 6: コミット**

```bash
git add apps/cmux-codex-review/bin/cmux-codex-review apps/cmux-codex-review/test/test-cmux-codex-review.sh
git commit -m "feat(cmux-codex-review): レビュー対象の候補を列挙する --list-targets を追加"
```

---

### Task 3: codex-review のコマンド層に対象確定ステップを入れ、ドキュメントとバージョンを更新

**Files:**
- Modify: `apps/cmux-codex-review/commands/codex-review.md`
- Modify: `apps/cmux-codex-review/skills/codex-review/SKILL.md`
- Modify: `apps/cmux-codex-review/README.md`
- Modify: `apps/cmux-codex-review/CLAUDE.md`
- Modify: `apps/cmux-codex-review/.claude-plugin/plugin.json`
- Modify: `apps/cmux-codex-review/.codex-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`

**Interfaces:**
- Consumes: Task 1 の `--path <file>`、Task 2 の `--list-targets`（TSV 4 列）
- Produces: なし（このプラグインの最終タスク）

- [ ] **Step 1: `commands/codex-review.md` に Step 0 を追加する**

`## 手順` の直後、既存の `### Step 1: agmsg identity を解決し inbox を確認（非ブロッキング）` の**前**に挿入する。

````markdown
### Step 0: レビュー対象を確定する

`$ARGUMENTS` に `--uncommitted` / `--base` / `--commit` / `--path` のいずれかが含まれていれば
対象は明示済み。**何も尋ねずに** Step 1 へ進む。

含まれていなければ候補を列挙する:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/cmux-codex-review" --list-targets
```

出力は 1 行 1 候補の TSV（`target<TAB>kind<TAB>value<TAB>label`）。行数で分岐する:

- **0 行**: 「レビュー対象が検出できませんでした」と伝え、対象のパスかブランチをユーザーに尋ねる。
  回答を `--path <file>` / `--base <branch>` に変換して Step 1 へ。
- **1 行**: そのまま採用する（確認は不要）。採用した対象は Step 4 の報告に含める。
- **2 行以上**: AskUserQuestion で 1 つ選ばせる。選択肢は次の優先順で最大 4 枠:

| 枠 | 内容 | 変換後の bin 引数 |
|----|------|------------------|
| 1 | 未コミット変更（`kind=uncommitted` の行があれば） | `--uncommitted` |
| 2 | spec 最新（label が `spec /` で始まる先頭行） | `--path <spec>` |
| 3 | plan 最新（label が `plan /` で始まる先頭行） | `--path <plan>` |
| 4 | spec + plan をまとめて（枠 2 と 3 が両方あるときだけ） | `--path <spec> --path <plan>` |

`--list-targets` は spec / plan を各 3 件まで返すが、枠に載せるのは各先頭 1 件だけ。
残りの候補は質問文に列挙し、ユーザーが Other で指定できるようにする。

multiSelect は使わない。bin の対象指定は単一種別なので「未コミット + path」の混在は作れない。
複数ファイルのレビューは枠 4（`--path` の繰り返し）で表現する。

確定した引数は Step 2 の bin 実行にそのまま渡す。
````

- [ ] **Step 2: `commands/codex-review.md` の Step 2 と Step 4 を対象確定に合わせて直す**

Step 2 の 2 つのコード例（`$ARGUMENTS` を渡している 2 か所）の直前に、次の 1 行を足す:

```markdown
`$ARGUMENTS` に Step 0 で確定した対象引数を足して実行する。
```

Step 4 の本文を次に置き換える:

```markdown
bin の起動サマリ（surface / 方向 / model / effort / 対象）を 1 行で報告する。
Step 0 で候補から自動採用した場合は、どの対象を選んだかも明記する。
```

- [ ] **Step 3: `skills/codex-review/SKILL.md` を更新する**

(a) `## 実行手順` の直後、`### 1. agmsg の inbox を確認（非ブロッキング）` の前に挿入する:

```markdown
### 0. レビュー対象を確定する

`--uncommitted` / `--base` / `--commit` / `--path` が指定されていればそのまま使う。
無指定なら `bin/cmux-codex-review --list-targets` で候補（未コミット変更 /
`docs/superpowers/{specs,plans}` の直近 md）を列挙し、2 件以上なら AskUserQuestion で
ユーザーに選ばせる。1 件なら自動採用、0 件なら対象をユーザーに尋ねる。
分岐の詳細は `/codex-review` コマンド（`commands/codex-review.md`）の Step 0 と同じ。
```

(b) 引数表（`| 引数 | 意味 |` の表）の `--commit <sha>` 行の下に 2 行足す:

```markdown
| `--path <file>` | 指定ファイルの**内容全体**をレビュー（繰り返し可。spec/plan 向け） |
| `--list-targets` | 候補を TSV で列挙して終了（cmux 不要。Step 0 用） |
```

(c) 冒頭の「デフォルト設定」の `- **対象**: 未コミット変更（`--uncommitted`）` を次に置き換える:

```markdown
- **対象**: 未コミット変更（`--uncommitted`）。無指定時は候補を列挙してユーザーに確認する
```

- [ ] **Step 4: `README.md` を更新する**

(a) 「使い方 → スラッシュコマンド」のコード例に 1 行足す:

```
/codex-review --path docs/superpowers/specs/x-design.md  # 指定ファイルの内容をレビュー
```

(b) その直下に段落を足す:

```markdown
対象を指定せずに `/codex-review` を打った場合は、未コミット変更と
`docs/superpowers/{specs,plans}` の直近 md を候補として提示し、どれをレビューするか確認する。
brainstorming が spec を先にコミットするフローでも、対象がズレない。
```

(c) 「シェルスクリプト（直接実行、高速）」のコード例に 1 行足す:

```
!cmux-codex-review --list-targets     # 候補を TSV で列挙するだけ（cmux 外でも動く）
```

- [ ] **Step 5: `CLAUDE.md` を更新する**

(a) 「動作」の箇条書き 1 番目の前に新しい項目を足し、番号を振り直す:

```markdown
1. レビュー対象を確定（引数無指定なら `--list-targets` の候補をユーザーに確認）
```

(b) 「テスト」セクションの不変条件リストの `- **D5**: ...` の下に 3 行足す:

```markdown
- **D6**: `--path` はファイル全文レビュー指示になり、パスが prompt へ無傷で届く
- **D7**: 存在しない `--path` は非ゼロ終了し、ペインを分割しない（無効指定でペインを撒かない）
- **D8**: `--list-targets` は cmux を呼ばずに候補を TSV 出力する（`CMUX_SOCKET_PATH` 不要）
```

(c) 「デフォルト」の表の「対象」行を次に置き換える:

```markdown
| 対象 | `--uncommitted` | `--base <branch>` / `--commit <sha>` / `--path <file>`（繰り返し可） |
```

- [ ] **Step 6: バージョンを 1.2.0 → 1.3.0 に上げる**

`apps/cmux-codex-review/.claude-plugin/plugin.json`、`apps/cmux-codex-review/.codex-plugin/plugin.json`、
ルート `.claude-plugin/marketplace.json` の `cmux-codex-review` エントリ、いずれも `"version": "1.2.0"` を
`"version": "1.3.0"` に変更する。

- [ ] **Step 7: 検証**

```bash
bash apps/cmux-codex-review/test/test-cmux-codex-review.sh
grep -h '"version"' apps/cmux-codex-review/.claude-plugin/plugin.json apps/cmux-codex-review/.codex-plugin/plugin.json
node -e 'JSON.parse(require("fs").readFileSync(".claude-plugin/marketplace.json","utf8"));console.log("marketplace.json OK")'
```

Expected: テストは `--- すべて PASS ---`、`"version": "1.3.0"` が 2 行、`marketplace.json OK`。

- [ ] **Step 8: コミット**

```bash
git add apps/cmux-codex-review .claude-plugin/marketplace.json
git commit -m "feat(cmux-codex-review): 引数無指定時にレビュー対象を確認するフローを追加し v1.3.0 へ"
```

---

### Task 4: cmux-codex-exec に `--list-targets` を追加し、テストを新設

**Files:**
- Modify: `apps/cmux-codex-exec/bin/cmux-codex-exec`
- Create: `apps/cmux-codex-exec/test/test-cmux-codex-exec.sh`

**Interfaces:**
- Consumes: なし（Task 2 と同形式だが実装は独立。`cmux-codex-wait` と同じくプラグイン間でコピーを持つ運用）
- Produces: `cmux-codex-exec --list-targets` → TSV。`kind` は常に `plan`、`value` は plan のパス、`label` は `plan / <committed|modified|untracked> / <MM-DD HH:MM>`。候補ゼロなら空出力・終了コード 0。

- [ ] **Step 1: 失敗するテストファイルを新規作成する**

`apps/cmux-codex-exec/test/test-cmux-codex-exec.sh` を次の内容で作る。

```bash
#!/usr/bin/env bash
# cmux-codex-exec の回帰テスト。
#
# stub の cmux / codex を用意し、bin が `cmux send` でペインへ送る文字列を
# **ペインのシェルと同じように再パース**して、codex が実際に受け取る引数を検証する。
#
# 実行: bash apps/cmux-codex-exec/test/test-cmux-codex-exec.sh
#
# 守っている不変条件:
#   E1. plan を明示指定すると、そのパスが prompt へ無傷で届き、prompt は 1 引数
#   E2. --list-targets は cmux を呼ばずに plan 候補を mtime 降順で TSV 出力する

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$SCRIPT_DIR/../bin/cmux-codex-exec"
[[ -x "$BIN" ]] || { echo "FAIL: bin が見つからない/実行不可: $BIN"; exit 2; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"

cat > "$TMP/bin/cmux" <<'STUB'
#!/usr/bin/env bash
if [[ "$1" == "new-split" ]]; then echo "OK surface:31 workspace:9"; exit 0; fi
if [[ "$1" == "send" ]]; then printf '%s' "$4" > "$SENT_CMD"; exit 0; fi
STUB
chmod +x "$TMP/bin/cmux"

cat > "$TMP/bin/codex" <<'STUB'
#!/usr/bin/env bash
echo "$#" > "$CODEX_ARGC"
prompt=""; for a in "$@"; do prompt="$a"; done
printf '%s' "$prompt" > "$CODEX_PROMPT"
STUB
chmod +x "$TMP/bin/codex"

export CMUX_SOCKET_PATH=/tmp/fake.sock
export SENT_CMD="$TMP/sent.cmd"
fail=0

reparse() { env PATH="$TMP/bin:$PATH" CODEX_ARGC="$TMP/argc" CODEX_PROMPT="$TMP/prompt" bash -c "$(cat "$SENT_CMD")"; }
argc() { cat "$TMP/argc" 2>/dev/null || echo "?"; }
prompt() { cat "$TMP/prompt" 2>/dev/null || echo ""; }

# --- E1: plan の明示指定が prompt へ無傷で届き、prompt は 1 引数 ---
echo "plan body" > "$TMP/my-plan.md"
CMUX_BIN="$TMP/bin/cmux" "$BIN" "$TMP/my-plan.md" --team t --parent parent >/dev/null 2>&1
reparse
if [[ "$(argc)" == "6" ]] \
  && prompt | grep -q "$TMP/my-plan.md" \
  && prompt | grep -q "send.sh t "; then
  echo "PASS E1: plan パスと send.sh が prompt に無傷で到達、argc=6"
else
  echo "FAIL E1: argc=$(argc) / prompt=[$(prompt)]"
  fail=1
fi

# --- E2: --list-targets は cmux 無し・CMUX_SOCKET_PATH 無しで plan 候補を mtime 降順出力 ---
REPO="$TMP/repo"
mkdir -p "$REPO/docs/superpowers/plans"
git -C "$REPO" init -q >/dev/null 2>&1
git -C "$REPO" config user.email tester@example.com
git -C "$REPO" config user.name tester
echo "old" > "$REPO/docs/superpowers/plans/2026-01-01-old.md"
git -C "$REPO" add -A >/dev/null 2>&1
git -C "$REPO" commit -qm init >/dev/null 2>&1
echo "new" > "$REPO/docs/superpowers/plans/2026-01-02-new.md"
touch -t 202601010000 "$REPO/docs/superpowers/plans/2026-01-01-old.md"
touch -t 202601020000 "$REPO/docs/superpowers/plans/2026-01-02-new.md"
lt=$(cd "$REPO" && env -u CMUX_SOCKET_PATH CMUX_BIN=/nonexistent/cmux "$BIN" --list-targets 2>&1)
first=$(printf '%s\n' "$lt" | head -1)
if printf '%s' "$first" | grep -q "2026-01-02-new.md" \
  && printf '%s' "$first" | grep -q "plan / untracked" \
  && printf '%s\n' "$lt" | grep -q "2026-01-01-old.md.*plan / committed"; then
  echo "PASS E2: --list-targets が cmux 無しで plan を mtime 降順に列挙"
else
  echo "FAIL E2: [$lt]"
  fail=1
fi

[[ $fail -eq 0 ]] && echo "--- すべて PASS ---" || echo "--- FAIL あり ---"
exit $fail
```

- [ ] **Step 2: テストを実行して E2 の失敗を確認する**

Run: `bash apps/cmux-codex-exec/test/test-cmux-codex-exec.sh`
Expected: `PASS E1`（既存実装で通る）と `FAIL E2:`（`--list-targets` 未実装のため
`CMUX_SOCKET_PATH 未設定` エラー、または plan 未指定エラーになる）。終了コード 1。

- [ ] **Step 3: bin に `--list-targets` を実装する**

`apps/cmux-codex-exec/bin/cmux-codex-exec` を編集する。

(a) **`CMUX_SOCKET_PATH` チェック（20〜23 行目付近）を削除**し、`CMUX_BIN="${CMUX_BIN:-cmux}"` の直後に候補列挙関数を置く:

```bash
# plan 候補の列挙。docs/superpowers/plans の直近 md を TSV で出す。
# 列: target<TAB>kind<TAB>value<TAB>label
list_targets() {
  local f state mt
  [[ -d docs/superpowers/plans ]] || return 0
  for f in $(ls -t docs/superpowers/plans/*.md 2>/dev/null | head -3); do
    if ! git ls-files --error-unmatch "$f" >/dev/null 2>&1; then
      state="untracked"
    elif git diff --quiet HEAD -- "$f" 2>/dev/null; then
      state="committed"
    else
      state="modified"
    fi
    mt=$(date -r "$f" '+%m-%d %H:%M' 2>/dev/null || echo "-")
    printf 'target\tplan\t%s\tplan / %s / %s\n' "$f" "$state" "$mt"
  done
  return 0
}
```

(b) 変数初期化（25〜26 行目付近）に `LIST_TARGETS=0` を足す:

```bash
LIST_TARGETS=0
```

(c) 引数パースの `--plan-mode` 行の直後に足す:

```bash
    --list-targets) LIST_TARGETS=1; shift ;;
```

(d) 引数パースの `done` の**直後**（model / effort 検証の前）に、列挙モードの分岐と、削除した cmux チェックの再配置を書く:

```bash
# 候補列挙モードはペイン分割しないので cmux 不要（cmux 外・テストからも呼べる）
if [[ $LIST_TARGETS -eq 1 ]]; then
  list_targets
  exit 0
fi

if [[ -z "${CMUX_SOCKET_PATH:-}" ]]; then
  echo "エラー: cmux 内でのみ使用可能です (CMUX_SOCKET_PATH 未設定)" >&2
  exit 1
fi
```

(e) ヘッダのコメント Usage の `--plan-mode` 行の下に 1 行足す:

```bash
#   --list-targets                  plan 候補を TSV で列挙して終了 (cmux 不要)
```

- [ ] **Step 4: テストを実行して全 PASS を確認する**

Run: `bash apps/cmux-codex-exec/test/test-cmux-codex-exec.sh`
Expected: `PASS E1` / `PASS E2`、`--- すべて PASS ---`（終了コード 0）。

- [ ] **Step 5: 実リポジトリでの出力を目視確認する**

Run: `apps/cmux-codex-exec/bin/cmux-codex-exec --list-targets`
Expected: `target	plan	docs/superpowers/plans/2026-07-27-codex-target-selection.md	plan / ... ` を含む行が出る。エラー終了しない。

- [ ] **Step 6: コミット**

```bash
git add apps/cmux-codex-exec/bin/cmux-codex-exec apps/cmux-codex-exec/test/test-cmux-codex-exec.sh
git commit -m "feat(cmux-codex-exec): plan 候補を列挙する --list-targets と回帰テストを追加"
```

---

### Task 5: codex-exec のコマンド層に plan 確定ステップを入れ、ドキュメントとバージョンを更新

**Files:**
- Modify: `apps/cmux-codex-exec/commands/codex-exec.md`
- Modify: `apps/cmux-codex-exec/skills/codex-exec/SKILL.md`
- Modify: `apps/cmux-codex-exec/README.md`
- Modify: `apps/cmux-codex-exec/CLAUDE.md`
- Modify: `apps/cmux-codex-exec/.claude-plugin/plugin.json`
- Modify: `apps/cmux-codex-exec/.codex-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`

**Interfaces:**
- Consumes: Task 4 の `--list-targets`（TSV 4 列、`kind=plan`）
- Produces: なし（最終タスク）

- [ ] **Step 1: `commands/codex-exec.md` に Step 0 を追加する**

`## 手順` の直後、既存の `### Step 1: agmsg identity を解決` の前に挿入する。

````markdown
### Step 0: 実装対象の plan を確定する

`$ARGUMENTS` に plan のパス（`.md` で終わる位置引数）が含まれていれば、それを使う。
**何も尋ねずに** Step 1 へ進む。

含まれていなければ候補を列挙する:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/cmux-codex-exec" --list-targets
```

出力は 1 行 1 候補の TSV（`target<TAB>plan<TAB><path><TAB><label>`）。行数で分岐する:

- **0 行**: 「plan が見つかりません」と伝え、plan のパスをユーザーに尋ねる。
- **1 行以上**: **候補が 1 件でも必ず** AskUserQuestion で確認する。選択肢は候補の上位 3 件
  （label の `committed` / `untracked` と更新時刻を description に添える）。該当が無ければ
  ユーザーは Other でパスを指定できる。

exec は誤った plan を掴むとリポジトリを書き換えるため、review と違って 1 件でも確認を省かない。

確定した plan パスは Step 2 の bin 実行に**明示的に**渡す（bin 側の mtime 最新フォールバックに委ねない）。
````

- [ ] **Step 2: `commands/codex-exec.md` の Step 2 を書き換える**

Step 2 の本文とコード例を次に置き換える:

````markdown
Step 0 で確定した plan パスと `$ARGUMENTS`（`-d down` 等）に `--team <TEAM> --parent <PARENT>` を
足して実行する:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/cmux-codex-exec" <PLAN> $ARGUMENTS --team <TEAM> --parent <PARENT>
```

出力の `token=` / `codex_agent=` / `surface=` / `plan=` を記憶する。
````

- [ ] **Step 3: `skills/codex-exec/SKILL.md` を更新する**

(a) `## 実行手順` の番号付きリストの先頭（現在の `1. whoami.sh で…` の前）に項目を足し、以降の番号を 2〜6 に振り直す:

```markdown
1. **plan を確定**: `$ARGUMENTS` に plan パスが無ければ `bin/cmux-codex-exec --list-targets` で
   候補を列挙し、**1 件でも** AskUserQuestion でユーザーに確認する（誤った plan の実行は
   リポジトリを書き換えるため）。0 件ならパスを尋ねる。詳細は `commands/codex-exec.md` の Step 0。
```

(b) 冒頭のデフォルト記述の `plan は` 以降を次に置き換える:

```markdown
plan は引数指定を優先し、無指定なら `docs/superpowers/plans/` の候補をユーザーに確認する
（bin 単体実行時のフォールバックは従来どおり mtime 最新）。
```

- [ ] **Step 4: `README.md` を更新する**

(a) 「使い方」のコード例の 1 行目のコメントを次に置き換える:

```
/codex-exec                                   # plan 候補を提示して確認してから実装
```

(b) 「フロー」の箇条書きの先頭に項目を足し、以降の番号を振り直す:

```markdown
1. 実装する plan を確定（無指定なら候補を提示して確認）
```

(c) ファイル末尾の「ライセンス」の前にセクションを足す:

```markdown
## テスト

```bash
bash apps/cmux-codex-exec/test/test-cmux-codex-exec.sh
```

stub の cmux / codex を使い、`cmux send` が送る文字列をペインのシェルと同じように再パースして
codex の実引数を検証する。守っている不変条件は E1（plan パスと `send.sh` が prompt へ無傷で届き、
prompt は 1 引数）と E2（`--list-targets` は cmux 無しで plan を mtime 降順に列挙）。
```

- [ ] **Step 5: `CLAUDE.md` を更新する**

(a) 「構成」の `bin/cmux-codex-exec` の説明行を次に置き換える:

```markdown
- `bin/cmux-codex-exec` — plan 解決 + 対話 codex 起動 + token/agent 導出 + `--list-targets`（候補列挙）
```

(b) 「デフォルト」の表の `plan` 行を次に置き換える:

```markdown
| plan | 位置引数。無指定ならコマンド層が `--list-targets` の候補を確認（bin 単体では mtime 最新） | 位置引数でパス指定 |
```

(c) ファイル末尾の「関連プラグインとの境界」の前にセクションを足す:

```markdown
## テスト

```bash
bash apps/cmux-codex-exec/test/test-cmux-codex-exec.sh
```

- **E1**: plan パスと `send.sh` が prompt へ無傷で届き、prompt はちょうど 1 引数
- **E2**: `--list-targets` は cmux を呼ばずに plan を mtime 降順で TSV 出力する
```

- [ ] **Step 6: バージョンを 1.1.0 → 1.2.0 に上げる**

`apps/cmux-codex-exec/.claude-plugin/plugin.json`、`apps/cmux-codex-exec/.codex-plugin/plugin.json`、
ルート `.claude-plugin/marketplace.json` の `cmux-codex-exec` エントリ、いずれも `"version": "1.1.0"` を
`"version": "1.2.0"` に変更する。

- [ ] **Step 7: 検証**

```bash
bash apps/cmux-codex-exec/test/test-cmux-codex-exec.sh
bash apps/cmux-codex-review/test/test-cmux-codex-review.sh
grep -h '"version"' apps/cmux-codex-exec/.claude-plugin/plugin.json apps/cmux-codex-exec/.codex-plugin/plugin.json
node -e 'JSON.parse(require("fs").readFileSync(".claude-plugin/marketplace.json","utf8"));console.log("marketplace.json OK")'
```

Expected: 両テストとも `--- すべて PASS ---`、`"version": "1.2.0"` が 2 行、`marketplace.json OK`。

- [ ] **Step 8: コミット**

```bash
git add apps/cmux-codex-exec .claude-plugin/marketplace.json
git commit -m "feat(cmux-codex-exec): plan 確定フローを追加し v1.2.0 へ"
```
