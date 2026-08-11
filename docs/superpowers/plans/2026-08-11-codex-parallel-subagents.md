# codex 並列実行ディレクティブ 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `cmux-codex-exec` / `cmux-codex-review` が codex へ送るプロンプトに「独立作業が2件以上なら必ず `spawn_agent` で並列化せよ」というディレクティブを注入し、並列度を親セッションまで返す。

**Architecture:** 共通のシェル関数を `bin/codex-parallel-lib.sh` として両プラグインに**同一内容のコピー**で置き、各 bin が `source` してプロンプトへ連結する。並列度は codex が agmsg 完了通知本文へ `agents=N` として埋め込み、`cmux-codex-wait` がそれを抽出して親へ渡す。

**Tech Stack:** bash（プラグイン本体・テストとも）。ビルドツールもランタイム依存も無い。テストは stub の `cmux` / `codex` を PATH に置き、`cmux send` が送る文字列をペインのシェルと同じように再パースして codex の実引数を検証する既存方式。

## Global Constraints

- 対象リポジトリは `/Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins`。
- `bin/codex-parallel-lib.sh` は exec 側と review 側で**一字一句同一**であること。`cmux-codex-wait` も同様（既存の不変条件）。
- プロンプトは `cmux send` でペインへ送られ、**ペインのシェルで再パースされる**。プロンプト全体は常にちょうど1引数として codex に届くこと（exec は argc=6、review は argc=9）。
- ディレクティブの連結は**必ずエスケープ処理（`PROMPT_ESC` / `REVIEW_INSTR_ESC`）より前**に行うこと。
- 引数バリデーションの失敗は**ペイン分割より前**に非ゼロ終了すること（無効な指定でペインを撒かない）。
- `--agents` の既定値は `4`、許容範囲は `2`〜`8` の整数。オフにする手段は `--no-parallel` のみ。
- ドキュメントの言語規約: `SKILL.md` / `commands/*.md` / `references/*.md`（`*-ja.md` を除く）は**英語必須**。`CLAUDE.md` / `README.md` / `references/*-ja.md` は日本語。bin のコメントと codex へ送るプロンプト文字列は日本語（既存どおり）。
- `SKILL.md` を更新したら `references/guide-ja.md` を**同じ commit で**更新する。
- バージョン: `cmux-codex-exec` `1.4.0` → `1.5.0`、`cmux-codex-review` `1.5.0` → `1.6.0`。ルート `.claude-plugin/marketplace.json` の対応 `version` も同期する。

---

### Task 1: 共通ライブラリと exec 側の配線

**Files:**
- Create: `apps/cmux-codex-exec/bin/codex-parallel-lib.sh`
- Modify: `apps/cmux-codex-exec/bin/cmux-codex-exec`
- Test: `apps/cmux-codex-exec/test/test-cmux-codex-exec.sh`

**Interfaces:**
- Consumes: なし（最初のタスク）
- Produces:
  - `list_codex_agent_types()` — 引数なし。cwd 直下の `.codex/agents/*.toml` を走査し、`- <stem> — <description>` の行を stdout へ出力する。該当が無ければ何も出力せず `return 0`。
  - `build_parallel_directive(max, phases)` — `$1` は同時実行上限（整数）、`$2` はプラグイン固有のフェーズ指示（複数行テキスト）。プロンプトへ連結する複数行テキストを stdout へ出力する。先頭に空行2つを含む。
  - `apps/cmux-codex-exec/bin/codex-parallel-lib.sh` — Task 2 でこのファイルを review 側へ**バイト単位でコピー**する。

- [ ] **Step 1: 失敗するテストを書く（E4 / E5）**

`apps/cmux-codex-exec/test/test-cmux-codex-exec.sh` のヘッダコメントの不変条件一覧（`#   E3.` の行の直後）に追記する。

```bash
#   E4. 既定でプロンプトに並列実行ディレクティブが入り、prompt は 1 引数のまま
#   E5. --no-parallel でディレクティブを一切注入しない
#   E6. .codex/agents/*.toml があれば agent_type 候補が載り、無ければフォールバック文言になる
#   E7. description に ' が含まれても prompt は 1 引数のまま
#   E8. 通知配線時、send.sh の本文に agents= が入る
#   E9. --agents の不正値は非ゼロ終了し、ペインを分割しない
```

同ファイルの stub `cmux` を、review 側と同じく `new-split` の呼び出しを記録できる形に差し替える（E9 で使う）。

```bash
cat > "$TMP/bin/cmux" <<'STUB'
#!/usr/bin/env bash
if [[ "$1" == "new-split" ]]; then
  echo "split" >> "${SPLIT_LOG:-/dev/null}"
  echo "OK surface:31 workspace:9"; exit 0
fi
if [[ "$1" == "send" ]]; then printf '%s' "$4" > "$SENT_CMD"; exit 0; fi
STUB
```

E3 のブロックの後（`[[ $fail -eq 0 ]] && echo ...` の直前）に次を追加する。

```bash
# --- E4: 既定で並列実行ディレクティブが入り、prompt は 1 引数のまま ---
CMUX_BIN="$TMP/bin/cmux" "$BIN" "$TMP/my-plan.md" >/dev/null 2>&1
reparse
if [[ "$(argc)" == "6" ]] \
  && prompt | grep -q 'spawn_agent' \
  && prompt | grep -q 'wait_agent' \
  && prompt | grep -q '最大 4 体'; then
  echo "PASS E4: 既定で並列実行ディレクティブが prompt に入る、argc=6"
else
  echo "FAIL E4: argc=$(argc) / prompt=[$(prompt)]"
  fail=1
fi

# --- E5: --no-parallel でディレクティブを注入しない ---
CMUX_BIN="$TMP/bin/cmux" "$BIN" "$TMP/my-plan.md" --no-parallel >/dev/null 2>&1
reparse
if [[ "$(argc)" == "6" ]] && ! prompt | grep -q 'spawn_agent'; then
  echo "PASS E5: --no-parallel でディレクティブ非注入、argc=6"
else
  echo "FAIL E5: argc=$(argc) / prompt=[$(prompt)]"
  fail=1
fi
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `bash apps/cmux-codex-exec/test/test-cmux-codex-exec.sh`
Expected: `FAIL E4` が出る（E5 は現状のプロンプトに `spawn_agent` が無いので偶然 PASS するが、`--no-parallel` が未知の引数として PLAN に代入されるため plan 解決が壊れて FAIL になる可能性もある。どちらにせよ E4 の FAIL が出ていればよい）

- [ ] **Step 3: 共通ライブラリを作る**

`apps/cmux-codex-exec/bin/codex-parallel-lib.sh` を新規作成する。

```bash
#!/usr/bin/env bash
# codex-parallel-lib.sh — codex に spawn_agent で並列作業させるディレクティブを組み立てる。
#
# cmux-codex-exec / cmux-codex-review の両プラグインに**同一内容のコピー**として置く。
# 乖離は apps/cmux-codex-review/test/test-cmux-codex-wait.sh の W8 が検出する。
#
# 提供する関数:
#   list_codex_agent_types                   .codex/agents/*.toml を候補行として列挙
#   build_parallel_directive <max> <phases>  プロンプトへ連結するディレクティブを出力
#
# 呼び出し側は set -euo pipefail で動くため、この中でパイプラインの失敗を漏らさないこと
# （grep が no-match で 1 を返すと pipefail + set -e で呼び出し元ごと落ちる）。

# .codex/agents/*.toml から agent_type 候補を "- <stem> — <description>" 形式で列挙する。
# agent_type 名はファイル名 stem。description は toml の description = "..." の 1 行目。
# プロンプトはペインのシェルで再パースされるため、stem は安全な文字だけのものに限る。
list_codex_agent_types() {
  local f stem desc line
  [[ -d .codex/agents ]] || return 0
  for f in .codex/agents/*.toml; do
    [[ -f "$f" ]] || continue
    stem=$(basename "$f" .toml)
    [[ "$stem" =~ ^[A-Za-z0-9._-]+$ ]] || continue
    desc=""
    while IFS= read -r line || [[ -n "$line" ]]; do
      if [[ "$line" =~ ^[[:space:]]*description[[:space:]]*=[[:space:]]*(.*)$ ]]; then
        desc="${BASH_REMATCH[1]}"
        # description = """ で始まる複数行形式は 1 行目に本文が無いので名前だけにする
        [[ "$desc" == '"""' ]] && desc=""
        desc="${desc#\"}"
        desc="${desc%\"}"
        break
      fi
    done < "$f"
    if [[ -n "$desc" ]]; then
      printf -- '- %s — %s\n' "$stem" "$desc"
    else
      printf -- '- %s\n' "$stem"
    fi
  done
  return 0
}

# 並列実行ディレクティブ本文を出力する。
#   $1: 同時実行の上限（整数）
#   $2: プラグイン固有のフェーズ指示（複数行テキスト）
build_parallel_directive() {
  local max="$1" phases="$2" types agent_block
  types=$(list_codex_agent_types)
  if [[ -n "$types" ]]; then
    agent_block="利用可能な agent_type:
$types
適切なものが無ければ agent_type は省略してよい。"
  else
    agent_block="このリポジトリには agent_type の定義が無い。agent_type は省略して spawn せよ。"
  fi
  printf '%s' "

## 並列実行（必須）

独立して進められる作業が2件以上あるときは、必ず spawn_agent で子エージェントを起動して
並列に進め、wait_agent で結果を回収せよ。逐次で済ませてはならない。
同時に走らせる子エージェントは最大 ${max} 体まで。

${phases}

${agent_block}

最後に、次の表で並列実行サマリーを必ず提示せよ:
| task_name | agent_type | 担当 | 結果 |
"
}
```

- [ ] **Step 4: exec の bin にライブラリを配線する**

`apps/cmux-codex-exec/bin/cmux-codex-exec` を編集する。

(a) ヘッダの Usage コメント（`#   --list-targets ...` の行の直後）に追記:

```bash
#   --no-parallel                   並列実行ディレクティブを注入しない
#   --agents <N>                    同時実行する子エージェントの上限 2..8 (default: 4)
```

(b) `CMUX_BIN="${CMUX_BIN:-cmux}"` の直後に source を追加:

```bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./codex-parallel-lib.sh
source "$SCRIPT_DIR/codex-parallel-lib.sh"
```

(c) 変数初期化（`LIST_TARGETS=0` の行の直後）:

```bash
NO_PARALLEL=0; MAX_AGENTS=4
```

(d) 引数パース（`--list-targets) LIST_TARGETS=1; shift ;;` の行の直後）:

```bash
    --no-parallel)  NO_PARALLEL=1; shift ;;
    --agents)       MAX_AGENTS="$2"; shift 2 ;;
```

(e) バリデーション（`--effort` の検証行の直後、ペイン分割より前）:

```bash
# --agents はプロンプトへ埋め込まれる。範囲外・非数値はペイン分割前に弾く
[[ "$MAX_AGENTS" =~ ^[2-8]$ ]] || { echo "エラー: --agents は 2〜8 の整数で指定してください" >&2; exit 1; }
```

(f) `NOTIFY` ブロック（現行 86-93 行）を丸ごと次に差し替える:

```bash
# 完了通知指示（--team/--parent 両方あるときのみ注入）
NOTIFY=""
if [[ -n "$TEAM" && -n "$PARENT" ]]; then
  AGENTS_SUFFIX=""; AGENTS_NOTE=""
  if [[ $NO_PARALLEL -eq 0 ]]; then
    AGENTS_SUFFIX=" agents=<N>"
    AGENTS_NOTE="
その際 agents=<N> の <N> は、実際に spawn した子エージェントの総数（整数）に置き換えよ。"
  fi
  NOTIFY="

作業がすべて完了したら、最後に必ず次を1回だけ実行して完了を通知せよ:
~/.agents/skills/agmsg/scripts/send.sh $TEAM $CODEX_AGENT $PARENT 'DONE $TOKEN: $PLAN_NAME 実装完了$AGENTS_SUFFIX'$AGENTS_NOTE"
fi
```

(g) `TASK=` の組み立て（現行 96-102 行）の直後、`PROMPT=` の直前に並列ディレクティブの生成を挿入:

```bash
# 並列実行ディレクティブ。実装本体（ファイル編集）は同一 worktree の競合を避けるため
# 親エージェントに逐次でやらせ、書き込みの無い調査と実装後の検証だけを並列化させる。
PARALLEL=""
if [[ $NO_PARALLEL -eq 0 ]]; then
  EXEC_PHASES="このタスクでは次のとおり分担せよ:

- plan を読んだ直後、影響範囲 / 既存実装パターン / テスト構成 / 関連ドキュメントの調査を
  読み取り専用の子エージェントに分割して並列実行し、結果を集約してから実装に入れ。
- 実装本体（ファイル編集）は親エージェントが逐次で行え。複数の子エージェントに同一
  worktree のファイルを同時編集させてはならない。
- 実装完了後、型チェック / lint / テスト / ドキュメント整合の検証を子エージェントに
  分けて並列実行せよ。"
  PARALLEL=$(build_parallel_directive "$MAX_AGENTS" "$EXEC_PHASES")
fi
```

(h) `PROMPT=` の行を差し替える:

```bash
PROMPT="$TASK$PARALLEL$NOTIFY"
```

- [ ] **Step 5: テストを実行して E4 / E5 が通ることを確認する**

Run: `bash apps/cmux-codex-exec/test/test-cmux-codex-exec.sh`
Expected: `PASS E1` 〜 `PASS E5` がすべて出て `--- すべて PASS ---` で終わる

- [ ] **Step 6: 残りのテスト（E6 / E7 / E8 / E9）を書く**

E5 のブロックの直後に追加する。

```bash
# --- E6: .codex/agents/*.toml があれば agent_type 候補が載る / 無ければフォールバック文言 ---
AGENTREPO="$TMP/agentrepo"
mkdir -p "$AGENTREPO/.codex/agents"
cp "$TMP/my-plan.md" "$AGENTREPO/plan.md"
cat > "$AGENTREPO/.codex/agents/my-coder.toml" <<'TOML'
description = "Implements backend code"
developer_instructions = """
body
"""
TOML
(cd "$AGENTREPO" && CMUX_BIN="$TMP/bin/cmux" "$BIN" plan.md >/dev/null 2>&1)
reparse
has_type=0
prompt | grep -q 'my-coder — Implements backend code' && has_type=1

NOAGENT="$TMP/noagent"
mkdir -p "$NOAGENT"
cp "$TMP/my-plan.md" "$NOAGENT/plan.md"
(cd "$NOAGENT" && CMUX_BIN="$TMP/bin/cmux" "$BIN" plan.md >/dev/null 2>&1)
reparse
has_fallback=0
prompt | grep -q 'agent_type の定義が無い' && has_fallback=1

if [[ $has_type -eq 1 && $has_fallback -eq 1 ]]; then
  echo "PASS E6: agent_type 候補の列挙とフォールバック文言が切り替わる"
else
  echo "FAIL E6: has_type=$has_type / has_fallback=$has_fallback"
  fail=1
fi

# --- E7: description に ' が含まれても prompt は 1 引数のまま ---
cat > "$AGENTREPO/.codex/agents/quoter.toml" <<'TOML'
description = "It's a quality checker"
TOML
(cd "$AGENTREPO" && CMUX_BIN="$TMP/bin/cmux" "$BIN" plan.md >/dev/null 2>&1)
reparse
if [[ "$(argc)" == "6" ]] && prompt | grep -q "It's a quality checker"; then
  echo "PASS E7: description の ' がエスケープされ、argc=6 のまま"
else
  echo "FAIL E7: argc=$(argc) / prompt=[$(prompt)]"
  fail=1
fi

# --- E8: 通知配線時、send.sh の本文に agents= が入る ---
CMUX_BIN="$TMP/bin/cmux" "$BIN" "$TMP/my-plan.md" --team t --parent parent >/dev/null 2>&1
reparse
if prompt | grep -q '実装完了 agents=' && prompt | grep -q 'spawn した子エージェントの総数'; then
  echo "PASS E8: 通知本文に agents= と置換指示が入る"
else
  echo "FAIL E8: prompt=[$(prompt)]"
  fail=1
fi

# --- E8b: --no-parallel では agents= を付けない ---
CMUX_BIN="$TMP/bin/cmux" "$BIN" "$TMP/my-plan.md" --no-parallel --team t --parent parent >/dev/null 2>&1
reparse
if prompt | grep -q '実装完了' && ! prompt | grep -q 'agents='; then
  echo "PASS E8b: --no-parallel では通知本文に agents= を付けない"
else
  echo "FAIL E8b: prompt=[$(prompt)]"
  fail=1
fi

# --- E9: --agents の不正値は非ゼロ終了し、ペインを分割しない ---
rm -f "$TMP/split.log"
bad=0
SPLIT_LOG="$TMP/split.log" CMUX_BIN="$TMP/bin/cmux" "$BIN" "$TMP/my-plan.md" --agents 9 >/dev/null 2>&1 && bad=1
SPLIT_LOG="$TMP/split.log" CMUX_BIN="$TMP/bin/cmux" "$BIN" "$TMP/my-plan.md" --agents abc >/dev/null 2>&1 && bad=1
if [[ $bad -eq 0 && ! -f "$TMP/split.log" ]]; then
  echo "PASS E9: --agents の不正値を拒否し、ペインを分割しない"
else
  echo "FAIL E9: bad=$bad / split.log=$( [[ -f "$TMP/split.log" ]] && echo exists || echo none )"
  fail=1
fi
```

- [ ] **Step 7: テストを実行して全 PASS を確認する**

Run: `bash apps/cmux-codex-exec/test/test-cmux-codex-exec.sh`
Expected: `PASS E1` 〜 `PASS E9`（E8b 含む）がすべて出て `--- すべて PASS ---`

- [ ] **Step 8: コミット**

```bash
git add apps/cmux-codex-exec/bin/codex-parallel-lib.sh \
        apps/cmux-codex-exec/bin/cmux-codex-exec \
        apps/cmux-codex-exec/test/test-cmux-codex-exec.sh
git commit -m "feat(cmux-codex-exec): codex に spawn_agent で調査と検証を並列化させる"
```

---

### Task 2: review 側への展開

**Files:**
- Create: `apps/cmux-codex-review/bin/codex-parallel-lib.sh`（Task 1 のファイルをバイト単位でコピー）
- Modify: `apps/cmux-codex-review/bin/cmux-codex-review`
- Test: `apps/cmux-codex-review/test/test-cmux-codex-review.sh`
- Test: `apps/cmux-codex-review/test/test-cmux-codex-wait.sh`（W8 の同一性検証のみ追加）

**Interfaces:**
- Consumes: Task 1 が作った `list_codex_agent_types()` / `build_parallel_directive(max, phases)`。シグネチャは Task 1 の Interfaces 節と同一。
- Produces: なし（Task 3・4 はこのタスクの成果物に依存しない）

- [ ] **Step 1: 失敗するテストを書く（D10 / D11）**

`apps/cmux-codex-review/test/test-cmux-codex-review.sh` のヘッダコメント（`#   D9.` の行の直後）に追記する。

```bash
#   D10. 既定でプロンプトに並列実行ディレクティブが入り、prompt は 1 引数のまま
#   D11. --no-parallel でディレクティブを一切注入しない
#   D12. .codex/agents/*.toml があれば agent_type 候補が載り、無ければフォールバック文言になる
#   D13. description に ' が含まれても prompt は 1 引数のまま
#   D14. 通知配線時、send.sh の本文に agents= が入る
#   D15. --agents の不正値は非ゼロ終了し、ペインを分割しない
```

`--effort` の検証ブロックの直後（`[[ $fail -eq 0 ]] && echo ...` の直前）に次を追加する。

```bash
# --- D10: 既定で並列実行ディレクティブが入り、prompt は 1 引数のまま ---
CMUX_BIN="$TMP/bin/cmux" "$BIN" >/dev/null 2>&1
reparse
if [[ "$(argc)" == "9" ]] \
  && prompt | grep -q 'spawn_agent' \
  && prompt | grep -q 'wait_agent' \
  && prompt | grep -q '最大 4 体'; then
  echo "PASS D10: 既定で並列実行ディレクティブが prompt に入る、argc=9"
else
  echo "FAIL D10: argc=$(argc) / prompt=[$(prompt)]"
  fail=1
fi

# --- D11: --no-parallel でディレクティブを注入しない ---
CMUX_BIN="$TMP/bin/cmux" "$BIN" --no-parallel >/dev/null 2>&1
reparse
if [[ "$(argc)" == "9" ]] && ! prompt | grep -q 'spawn_agent'; then
  echo "PASS D11: --no-parallel でディレクティブ非注入、argc=9"
else
  echo "FAIL D11: argc=$(argc) / prompt=[$(prompt)]"
  fail=1
fi
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `bash apps/cmux-codex-review/test/test-cmux-codex-review.sh`
Expected: `FAIL D10` が出る

- [ ] **Step 3: ライブラリをコピーする**

```bash
cp apps/cmux-codex-exec/bin/codex-parallel-lib.sh apps/cmux-codex-review/bin/codex-parallel-lib.sh
diff apps/cmux-codex-exec/bin/codex-parallel-lib.sh apps/cmux-codex-review/bin/codex-parallel-lib.sh
```

Expected: `diff` は何も出力しない

- [ ] **Step 4: review の bin にライブラリを配線する**

`apps/cmux-codex-review/bin/cmux-codex-review` を編集する。

(a) ヘッダの Usage コメント（`#   --list-targets ...` の行の直後）に追記:

```bash
#   --no-parallel                   並列実行ディレクティブを注入しない
#   --agents <N>                    同時実行する子エージェントの上限 2..8 (default: 4)
```

(b) `CMUX_BIN="${CMUX_BIN:-cmux}"` の直後に source を追加:

```bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./codex-parallel-lib.sh
source "$SCRIPT_DIR/codex-parallel-lib.sh"
```

(c) 変数初期化（`LIST_TARGETS=0` の行の直後）:

```bash
NO_PARALLEL=0; MAX_AGENTS=4
```

(d) 引数パース（`--list-targets) LIST_TARGETS=1; shift ;;` の行の直後）:

```bash
    --no-parallel) NO_PARALLEL=1; shift ;;
    --agents)      MAX_AGENTS="$2"; shift 2 ;;
```

**注意**: review の引数パースは末尾に `*) INSTRUCTIONS="..."` のフォールスルーがあるため、上記2ケースを `--)` より前に置くこと。置き忘れると `--no-parallel` がレビュー指示の文字列に混入する。

(e) バリデーション（`--effort` の検証行の直後、`--path` の存在検証より前）:

```bash
# --agents はプロンプトへ埋め込まれる。範囲外・非数値はペイン分割前に弾く
[[ "$MAX_AGENTS" =~ ^[2-8]$ ]] || { echo "エラー: --agents は 2〜8 の整数で指定してください" >&2; exit 1; }
```

(f) `追加指示` を連結する行（現行 118-120 行）の直後、ペイン分割より前に並列ディレクティブを連結:

```bash
# 並列実行ディレクティブ。観点別レビューと背景調査を子エージェントに分けさせる
if [[ $NO_PARALLEL -eq 0 ]]; then
  REVIEW_PHASES="このレビューでは次のとおり分担せよ:

- レビュー観点（バグ・正確性 / セキュリティ / 設計・可読性 / テスト網羅）ごとに
  子エージェントを spawn し、並列にレビューさせよ。
- diff だけで判断できない点（呼び出し元、既存規約、変更経緯）は調査用の子エージェントに
  並列で集めさせ、その結果を踏まえて判断せよ。
- 親エージェントは子の指摘を集約し、重複を除いて重要度順に 1 本のレビューとして提示せよ。"
  REVIEW_INSTR="$REVIEW_INSTR$(build_parallel_directive "$MAX_AGENTS" "$REVIEW_PHASES")"
fi
```

(g) 完了通知ブロック（現行 128-134 行）を丸ごと次に差し替える:

```bash
# 完了通知指示（--team/--reviewer/--parent すべてあるときのみ）
if [[ -n "$TEAM" && -n "$REVIEWER" && -n "$PARENT" ]]; then
  AGENTS_SUFFIX=""; AGENTS_NOTE=""
  if [[ $NO_PARALLEL -eq 0 ]]; then
    AGENTS_SUFFIX=" agents=<N>"
    AGENTS_NOTE="
その際 agents=<N> の <N> は、実際に spawn した子エージェントの総数（整数）に置き換えよ。"
  fi
  REVIEW_INSTR="$REVIEW_INSTR

レビューの提示がすべて終わったら、最後に必ず次を1回だけ実行して完了を通知せよ:
~/.agents/skills/agmsg/scripts/send.sh $TEAM $REVIEWER $PARENT 'DONE $TOKEN: レビュー完了$AGENTS_SUFFIX'$AGENTS_NOTE"
fi
```

- [ ] **Step 5: テストを実行して D10 / D11 が通ることを確認する**

Run: `bash apps/cmux-codex-review/test/test-cmux-codex-review.sh`
Expected: 既存の D1〜D9 も含めてすべて PASS

- [ ] **Step 6: 残りのテスト（D12 / D13 / D14 / D15）を書く**

D11 のブロックの直後に追加する。

```bash
# --- D12: .codex/agents/*.toml があれば agent_type 候補が載る / 無ければフォールバック文言 ---
AGENTREPO="$TMP/agentrepo"
mkdir -p "$AGENTREPO/.codex/agents"
cat > "$AGENTREPO/.codex/agents/my-reviewer.toml" <<'TOML'
description = "Reviews backend code"
developer_instructions = """
body
"""
TOML
(cd "$AGENTREPO" && CMUX_BIN="$TMP/bin/cmux" "$BIN" >/dev/null 2>&1)
reparse
has_type=0
prompt | grep -q 'my-reviewer — Reviews backend code' && has_type=1

NOAGENT=$(mktemp -d)
(cd "$NOAGENT" && CMUX_BIN="$TMP/bin/cmux" "$BIN" >/dev/null 2>&1)
reparse
has_fallback=0
prompt | grep -q 'agent_type の定義が無い' && has_fallback=1
rm -rf "$NOAGENT"

if [[ $has_type -eq 1 && $has_fallback -eq 1 ]]; then
  echo "PASS D12: agent_type 候補の列挙とフォールバック文言が切り替わる"
else
  echo "FAIL D12: has_type=$has_type / has_fallback=$has_fallback"
  fail=1
fi

# --- D13: description に ' が含まれても prompt は 1 引数のまま ---
cat > "$AGENTREPO/.codex/agents/quoter.toml" <<'TOML'
description = "It's a quality checker"
TOML
(cd "$AGENTREPO" && CMUX_BIN="$TMP/bin/cmux" "$BIN" >/dev/null 2>&1)
reparse
if [[ "$(argc)" == "9" ]] && prompt | grep -q "It's a quality checker"; then
  echo "PASS D13: description の ' がエスケープされ、argc=9 のまま"
else
  echo "FAIL D13: argc=$(argc) / prompt=[$(prompt)]"
  fail=1
fi

# --- D14: 通知配線時、send.sh の本文に agents= が入る / --no-parallel では入らない ---
CMUX_BIN="$TMP/bin/cmux" "$BIN" --team t --reviewer cxrev-review --parent parent >/dev/null 2>&1
reparse
with_agents=0
prompt | grep -q 'レビュー完了 agents=' && prompt | grep -q 'spawn した子エージェントの総数' && with_agents=1

CMUX_BIN="$TMP/bin/cmux" "$BIN" --no-parallel --team t --reviewer cxrev-review --parent parent >/dev/null 2>&1
reparse
without_agents=0
prompt | grep -q 'レビュー完了' && ! prompt | grep -q 'agents=' && without_agents=1

if [[ $with_agents -eq 1 && $without_agents -eq 1 ]]; then
  echo "PASS D14: 通知本文の agents= が並列有無で切り替わる"
else
  echo "FAIL D14: with=$with_agents / without=$without_agents"
  fail=1
fi

# --- D15: --agents の不正値は非ゼロ終了し、ペインを分割しない ---
rm -f "$TMP/split.log"
bad=0
SPLIT_LOG="$TMP/split.log" CMUX_BIN="$TMP/bin/cmux" "$BIN" --agents 9 >/dev/null 2>&1 && bad=1
SPLIT_LOG="$TMP/split.log" CMUX_BIN="$TMP/bin/cmux" "$BIN" --agents abc >/dev/null 2>&1 && bad=1
if [[ $bad -eq 0 && ! -f "$TMP/split.log" ]]; then
  echo "PASS D15: --agents の不正値を拒否し、ペインを分割しない"
else
  echo "FAIL D15: bad=$bad / split.log=$( [[ -f "$TMP/split.log" ]] && echo exists || echo none )"
  fail=1
fi
```

- [ ] **Step 7: W8（ライブラリの同一性）を追加する**

`apps/cmux-codex-review/test/test-cmux-codex-wait.sh` のヘッダコメント（`#   W5.` の行の直後）に追記:

```bash
#   W8. codex-parallel-lib.sh が review / exec 2 プラグインで同一内容
```

W5 のブロックの直後に追加する。

```bash
# --- W8: 2 プラグインの codex-parallel-lib.sh は同一内容 ---
LIB="$SCRIPT_DIR/../bin/codex-parallel-lib.sh"
LIB_SIBLING="$SCRIPT_DIR/../../cmux-codex-exec/bin/codex-parallel-lib.sh"
if [[ -f "$LIB" && -f "$LIB_SIBLING" ]]; then
  if diff -q "$LIB" "$LIB_SIBLING" >/dev/null; then
    echo "PASS W8: review / exec の codex-parallel-lib.sh が同一"
  else
    echo "FAIL W8: 2 プラグインの codex-parallel-lib.sh が乖離している"
    diff "$LIB" "$LIB_SIBLING" | head -20
    fail=1
  fi
else
  echo "SKIP W8: codex-parallel-lib.sh が両方には無い"
fi
```

- [ ] **Step 8: 両テストを実行して全 PASS を確認する**

Run:
```bash
bash apps/cmux-codex-review/test/test-cmux-codex-review.sh
bash apps/cmux-codex-review/test/test-cmux-codex-wait.sh
```
Expected: 両方とも `--- すべて PASS ---`。`test-cmux-codex-wait.sh` は W1 / W2b で各4秒待つため 10 秒程度かかる

- [ ] **Step 9: コミット**

```bash
git add apps/cmux-codex-review/bin/codex-parallel-lib.sh \
        apps/cmux-codex-review/bin/cmux-codex-review \
        apps/cmux-codex-review/test/test-cmux-codex-review.sh \
        apps/cmux-codex-review/test/test-cmux-codex-wait.sh
git commit -m "feat(cmux-codex-review): codex に観点別レビューと背景調査を並列化させる"
```

---

### Task 3: watcher が並列度を親へ返す

**Files:**
- Modify: `apps/cmux-codex-review/bin/cmux-codex-wait`
- Modify: `apps/cmux-codex-exec/bin/cmux-codex-wait`（同一内容のコピー）
- Test: `apps/cmux-codex-review/test/test-cmux-codex-wait.sh`

**Interfaces:**
- Consumes: Task 1・2 が仕込んだ通知本文フォーマット `DONE <token>: ... agents=<N>`
- Produces: `cmux-codex-wait` の標準出力 `status=done token=<token> agents=<N>`。`agents=` は通知本文に含まれるときだけ付く。Task 4 の `commands/codex-exec.md` がこれを読む

- [ ] **Step 1: 失敗するテストを書く（W6 / W7）**

`apps/cmux-codex-review/test/test-cmux-codex-wait.sh` のヘッダコメント（Task 2 で追加した `#   W8.` の行の直前）に追記:

```bash
#   W6. 完了メッセージに agents=N があれば status=done の行にそれを載せる
#   W7. agents= が無ければ出力は従来どおり（後方互換）
```

W3 のブロックの直後に追加する。

```bash
# --- W6: 完了メッセージの agents=N を status 行に載せる ---
echo "2026-08-11 | t | codex → parent | DONE codex-review-31: レビュー完了 agents=5" > "$HIST_OUT"
out=$("$BIN" t parent codex-review-31 --interval 1 2>&1); rc=$?
if [[ $rc -eq 0 ]] && printf '%s' "$out" | grep -q "status=done token=codex-review-31 agents=5"; then
  echo "PASS W6: agents=5 を status 行に載せる"
else
  echo "FAIL W6: rc=$rc out=[$out]"
  fail=1
fi

# --- W7: agents= が無ければ出力は従来どおり（後方互換） ---
echo "2026-08-11 | t | codex → parent | DONE codex-review-31: レビュー完了" > "$HIST_OUT"
out=$("$BIN" t parent codex-review-31 --interval 1 2>&1); rc=$?
if [[ $rc -eq 0 ]] && [[ "$(printf '%s' "$out" | tr -d '\n')" == "status=done token=codex-review-31" ]]; then
  echo "PASS W7: agents= 無しなら従来どおりの出力"
else
  echo "FAIL W7: rc=$rc out=[$out]"
  fail=1
fi
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `bash apps/cmux-codex-review/test/test-cmux-codex-wait.sh`
Expected: `FAIL W6`（W7 は現状でも PASS する）

- [ ] **Step 3: watcher を実装する**

`apps/cmux-codex-review/bin/cmux-codex-wait` の 52-55 行を差し替える。

変更前:
```bash
  if "$AGMSG_HISTORY" "$TEAM" "$AGENT" 30 2>/dev/null | grep -qF "$TOKEN"; then
    echo "status=done token=$TOKEN"
    exit 0
  fi
```

変更後:
```bash
  # マッチ行を捕まえるのは、完了通知本文に埋め込まれた agents=N（codex が実際に spawn した
  # 子エージェント数）を親へ渡すため。agents= が無ければ従来どおりの出力になる。
  hit=$("$AGMSG_HISTORY" "$TEAM" "$AGENT" 30 2>/dev/null | grep -F "$TOKEN" | tail -1)
  if [[ -n "$hit" ]]; then
    agents=$(printf '%s' "$hit" | grep -oE 'agents=[0-9]+' | tail -1)
    echo "status=done token=$TOKEN${agents:+ $agents}"
    exit 0
  fi
```

ヘッダコメントの Exit 行の直前（`#   --liveness-interval ...` の行の直後）に追記:

```bash
#
# 完了メッセージに agents=<N> が含まれていれば status 行に転記する（codex が spawn した
# 子エージェント数を親セッションへ返すため）。含まれなければ従来どおりの出力になる。
```

- [ ] **Step 4: exec 側へコピーする**

```bash
cp apps/cmux-codex-review/bin/cmux-codex-wait apps/cmux-codex-exec/bin/cmux-codex-wait
diff apps/cmux-codex-review/bin/cmux-codex-wait apps/cmux-codex-exec/bin/cmux-codex-wait
```

Expected: `diff` は何も出力しない

- [ ] **Step 5: テストを実行して W1〜W8 が全 PASS することを確認する**

Run: `bash apps/cmux-codex-review/test/test-cmux-codex-wait.sh`
Expected: `PASS W3` / `PASS W6` / `PASS W7` / `PASS W4` / `PASS W1` / `PASS W2` / `PASS W2b` / `PASS W5` / `PASS W8` が出て `--- すべて PASS ---`

- [ ] **Step 6: コミット**

```bash
git add apps/cmux-codex-review/bin/cmux-codex-wait \
        apps/cmux-codex-exec/bin/cmux-codex-wait \
        apps/cmux-codex-review/test/test-cmux-codex-wait.sh
git commit -m "feat(cmux-codex-wait): 完了通知の agents=N を status 行へ転記する"
```

---

### Task 4: ドキュメントとバージョン同期

**Files:**
- Modify: `apps/cmux-codex-exec/skills/codex-exec/SKILL.md`
- Modify: `apps/cmux-codex-exec/skills/codex-exec/references/guide-ja.md`
- Modify: `apps/cmux-codex-exec/commands/codex-exec.md`
- Modify: `apps/cmux-codex-exec/CLAUDE.md`
- Modify: `apps/cmux-codex-exec/README.md`
- Modify: `apps/cmux-codex-exec/.claude-plugin/plugin.json`
- Modify: `apps/cmux-codex-review/skills/codex-review/SKILL.md`
- Modify: `apps/cmux-codex-review/skills/codex-review/references/guide-ja.md`
- Modify: `apps/cmux-codex-review/CLAUDE.md`
- Modify: `apps/cmux-codex-review/README.md`
- Modify: `apps/cmux-codex-review/.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`

**Interfaces:**
- Consumes: Task 1〜3 で確定した CLI（`--no-parallel` / `--agents <N>`）と watcher 出力（`status=done token=... agents=<N>`）
- Produces: なし（最終タスク）

- [ ] **Step 1: exec の SKILL.md を更新する（英語）**

`apps/cmux-codex-exec/skills/codex-exec/SKILL.md` の `## Why this design` セクション末尾に段落を追加:

```markdown
Parallelism is not left to codex's discretion. The launched prompt carries a
mandatory directive: whenever two or more pieces of work are independent, codex
MUST fan them out with `spawn_agent` and collect them with `wait_agent`. Only
read-only investigation and post-implementation verification are parallelized —
file edits stay sequential in the parent agent, because this plugin runs in the
current directory without worktree isolation and concurrent writers would
clobber each other.
```

`## Procedure` の直前に節を追加:

```markdown
## Parallel execution

The prompt is built with a directive that caps concurrent child agents (default
4) and asks codex to close with a summary table of what it spawned. Available
`agent_type` values are discovered from `.codex/agents/*.toml` in the current
directory and listed with their descriptions; if none exist, codex is told to
omit `agent_type`.

| Argument | Meaning |
|------|------|
| `--no-parallel` | Do not inject the directive (identical to the previous behavior) |
| `--agents <N>` | Concurrency cap. Integers 2-8 only; anything else exits non-zero before splitting a pane (default: 4) |

When notification wiring is on, codex appends `agents=<N>` to the completion
message, and `bin/cmux-codex-wait` echoes it back as
`status=done token=<token> agents=<N>`.
```

- [ ] **Step 2: exec の guide-ja.md を同じ commit で更新する（日本語）**

`apps/cmux-codex-exec/skills/codex-exec/references/guide-ja.md` の `## なぜこの構成か` 末尾に追加:

```markdown
並列化は codex の裁量に任せない。起動プロンプトには「独立して進められる作業が2件以上あるときは
必ず `spawn_agent` で並列化し、`wait_agent` で回収せよ」という義務指示を載せる。並列化するのは
読み取り専用の調査と実装後の検証だけで、ファイル編集は親エージェントの逐次実行のままにする。
このプラグインは worktree を分離せずカレントディレクトリで動くため、同時書き込みは互いを
壊してしまうからである。
```

`## 実行手順` の直前に節を追加（SKILL.md と見出しを 1:1 対応させる）:

```markdown
## 並列実行

プロンプトには同時実行の上限（既定 4）を含む並列化ディレクティブが載り、最後に「何を spawn したか」の
サマリー表を出させる。`agent_type` の候補はカレントディレクトリの `.codex/agents/*.toml` から検出し、
description つきで列挙する。1 つも無ければ「agent_type は省略せよ」と伝える。

| 引数 | 意味 |
|------|------|
| `--no-parallel` | ディレクティブを注入しない（従来どおりの挙動） |
| `--agents <N>` | 同時実行の上限。2〜8 の整数のみ。それ以外はペイン分割前に非ゼロ終了（default: 4） |

通知配線がある場合、codex は完了メッセージに `agents=<N>` を付け、`bin/cmux-codex-wait` が
`status=done token=<token> agents=<N>` として親へ返す。
```

- [ ] **Step 3: exec の commands/codex-exec.md を更新する（英語）**

`### Step 5: Branch after waking` の `status=done` の項目を差し替える:

```markdown
- `status=done`: ask the user whether to review the uncommitted changes with
  codex-review, noting that codex-exec has finished (including which plan). If
  the output also carries `agents=<N>`, report that number as how many child
  agents codex ran in parallel. If yes, launch `/codex-review --uncommitted`
  (cmux-codex-review) with the target stated explicitly (since the user has
  already answered the target, don't make Step 0 ask for candidates again).
  Respond to the user in Japanese.
```

- [ ] **Step 4: exec の CLAUDE.md と README.md を更新する（日本語）**

`apps/cmux-codex-exec/CLAUDE.md` の「構成」リストに1行追加:

```markdown
- `bin/codex-parallel-lib.sh` — 並列実行ディレクティブの生成（`.codex/agents/*.toml` の検出含む）。
  `cmux-codex-review` 側と**同一内容のコピー**（W8 が同一性を検証する）
```

「デフォルト」表に2行追加:

```markdown
| 並列実行 | 有効（調査・検証を `spawn_agent` で分割） | `--no-parallel` |
| 同時実行の上限 | `4`（2〜8） | `--agents <N>` |
```

「テスト」の不変条件リストに追加:

```markdown
- **E4-E5**: 既定でディレクティブが入り `--no-parallel` で消える（prompt は常に 1 引数）
- **E6-E7**: `.codex/agents/*.toml` の候補列挙とフォールバック、description の `'` エスケープ
- **E8**: 通知本文の `agents=` が並列有無で切り替わる
- **E9**: `--agents` の不正値は非ゼロ終了し、ペインを分割しない
```

「完了通知の仕組み」節の末尾に1段落追加:

```markdown
並列実行時は codex が完了メッセージ末尾に `agents=<N>` を付け、`cmux-codex-wait` がそれを
`status=done token=... agents=<N>` として親へ転記する。指示が守られていなければ `agents=` が
付かないので、親側で気づける。
```

`apps/cmux-codex-exec/README.md` の「使い方」ブロックに2行追加:

```
/codex-exec --no-parallel                     # 並列化させず従来どおり逐次で実装
/codex-exec --agents 2                        # 同時実行の子エージェントを 2 体までに絞る
```

「フロー」の項目3を差し替える:

```markdown
3. 新ペインで対話 codex が plan を実装（調査と検証は `spawn_agent` で並列化。既定 4 並列）
```

- [ ] **Step 5: review 側のドキュメントを更新する**

`apps/cmux-codex-review/skills/codex-review/SKILL.md` の主な引数表に2行追加:

```markdown
| `--no-parallel` | Do not inject the parallel-execution directive |
| `--agents <N>` | Concurrency cap for child agents. Integers 2-8 only (default: 4) |
```

`## Why this design` 末尾に段落を追加:

```markdown
Parallelism is mandatory rather than discretionary. The prompt instructs codex to
spawn one child agent per review lens (bugs/correctness, security,
design/readability, test coverage) and to gather background that a diff alone
cannot settle — call sites, existing conventions, change history — with
additional child agents in parallel. The parent agent then merges the findings
into a single deduplicated, severity-ordered review. Available `agent_type`
values are discovered from `.codex/agents/*.toml`; if none exist, codex omits
`agent_type`.
```

`apps/cmux-codex-review/skills/codex-review/references/guide-ja.md` の主な引数表に対応する2行を追加:

```markdown
| `--no-parallel` | 並列実行ディレクティブを注入しない |
| `--agents <N>` | 子エージェントの同時実行上限。2〜8 の整数のみ（default: 4） |
```

`## なぜこの構成か` 末尾に追加:

```markdown
並列化は裁量ではなく義務にしている。プロンプトはレビュー観点（バグ・正確性 / セキュリティ /
設計・可読性 / テスト網羅）ごとに子エージェントを spawn させ、diff だけでは判断できない背景
（呼び出し元、既存規約、変更経緯）も別の子エージェントに並列で集めさせる。親エージェントは
それらを重複除去のうえ重要度順に 1 本へまとめる。`agent_type` の候補は `.codex/agents/*.toml`
から検出し、無ければ省略させる。
```

`apps/cmux-codex-review/CLAUDE.md` の「構成」に1行、「デフォルト」表に2行、「テスト」の不変条件に D10-D15 と W6-W8 を追加する（exec 側と同じ体裁で、ID と文言だけ review 用に差し替える）。

```markdown
- `bin/codex-parallel-lib.sh` — 並列実行ディレクティブの生成（`cmux-codex-exec` と**同一内容のコピー**。W8 が同一性を検証する）
```

```markdown
| 並列実行 | 有効（観点別レビュー・背景調査を `spawn_agent` で分割） | `--no-parallel` |
| 同時実行の上限 | `4`（2〜8） | `--agents <N>` |
```

```markdown
- **D10-D11**: 既定でディレクティブが入り `--no-parallel` で消える（prompt は常に 1 引数）
- **D12-D13**: `.codex/agents/*.toml` の候補列挙とフォールバック、description の `'` エスケープ
- **D14**: 通知本文の `agents=` が並列有無で切り替わる
- **D15**: `--agents` の不正値は非ゼロ終了し、ペインを分割しない
```

`test-cmux-codex-wait.sh` の不変条件リストにも追加:

```markdown
- **W6**: 完了メッセージの `agents=N` を `status=done` 行へ転記する
- **W7**: `agents=` が無ければ出力は従来どおり（後方互換）
- **W8**: review / exec 2 プラグインの `codex-parallel-lib.sh` が同一内容
```

`apps/cmux-codex-review/README.md` の「使い方」ブロックに2行追加:

```
/codex-review --no-parallel   # 並列化させず 1 エージェントでレビュー
/codex-review --agents 2      # 同時実行の子エージェントを 2 体までに絞る
```

- [ ] **Step 6: バージョンを同期する**

`apps/cmux-codex-exec/.claude-plugin/plugin.json` の `"version"` を `1.4.0` → `1.5.0`。
`apps/cmux-codex-review/.claude-plugin/plugin.json` の `"version"` を `1.5.0` → `1.6.0`。
`.claude-plugin/marketplace.json` の `cmux-codex-exec` を `1.5.0`、`cmux-codex-review` を `1.6.0` に更新。

確認:

```bash
grep -n '"version"' apps/cmux-codex-exec/.claude-plugin/plugin.json apps/cmux-codex-review/.claude-plugin/plugin.json
node -e "const m=require('./.claude-plugin/marketplace.json');console.log(m.plugins.filter(p=>p.name.startsWith('cmux-codex')).map(p=>p.name+'='+p.version).join(' '))"
```

Expected: `cmux-codex-exec=1.5.0 cmux-codex-review=1.6.0`

- [ ] **Step 7: ドキュメント言語規約と全体チェックを走らせる**

Run:
```bash
node scripts/check-doc-lang.mjs apps/cmux-codex-exec
node scripts/check-doc-lang.mjs apps/cmux-codex-review
pnpm check
```
Expected: いずれも違反なしで終了コード 0。`japanese-in-english-doc` が出たら、日本語を書いてよいのは `references/*-ja.md` / `CLAUDE.md` / `README.md` だけであることを思い出して該当箇所を英語に直す

- [ ] **Step 8: 全テストを再実行する**

Run:
```bash
bash apps/cmux-codex-exec/test/test-cmux-codex-exec.sh
bash apps/cmux-codex-review/test/test-cmux-codex-review.sh
bash apps/cmux-codex-review/test/test-cmux-codex-wait.sh
```
Expected: 3本とも `--- すべて PASS ---`

- [ ] **Step 9: コミット**

```bash
git add apps/cmux-codex-exec apps/cmux-codex-review .claude-plugin/marketplace.json
git commit -m "docs(cmux-codex): 並列実行ディレクティブを文書化しバージョンを同期する"
```

---

## 完了条件

次のすべてがグリーンであること。

```bash
bash apps/cmux-codex-exec/test/test-cmux-codex-exec.sh
bash apps/cmux-codex-review/test/test-cmux-codex-review.sh
bash apps/cmux-codex-review/test/test-cmux-codex-wait.sh
pnpm check
```

加えて、`bin/codex-parallel-lib.sh` と `bin/cmux-codex-wait` が両プラグインで `diff` 無差分であること（W5 / W8 が自動で検証する）。
