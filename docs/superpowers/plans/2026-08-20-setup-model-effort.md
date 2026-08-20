# `--setup` での役割別 model / effort 設定 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `--setup` から、登録済み runner の 3 役割 × 2 次元 = 6 フィールド（`plan_model` / `review_model` / `exec_model` と対応 effort）を設定・変更・既定へ戻せるようにする。

**Architecture:** `runners.json` へのフィールド単位の書き込みを新規スクリプト `runners-edit.sh` に一本化する（`config-edit.sh` と同型の契約: writer 固有 `mktemp` + jq + 成功時のみ `mv`、exit 0/1/2）。`--setup` 側は S3 に 4 番目の選択肢「登録済み runner の model / effort を編集」を足し、新設の S3-M で AskUserQuestion 3 コール（runner 選択 → model 3 問 → effort 3 問）を回す。解決ロジック・既定値・`launch-workspace.sh` / `prewarm-panes.sh` / `--override` は 1 行も変えない。

**Tech Stack:** bash 3.2（macOS 既定）、jq、markdown ドキュメント、bash ベースの回帰テスト。

**Spec:** `docs/superpowers/specs/2026-08-20-setup-model-effort-design.md`
（**必ず spec も読むこと。** 本計画は spec の §番号を参照しながら進む。spec は 5 ラウンドのレビューを経て approve 済みで、選択肢生成の 24 通り・deny-list の全数試験・RE9d/RE9e の弁別力はすべて実測で裏付けられている。）

## Global Constraints

- **bash 3.2 互換**（macOS 既定）。連想配列（bash 4+）禁止。`set -u` 下で空になりうる配列は `${arr[@]+"${arr[@]}"}` で展開する。here-string（`<<<`）は使ってよい。
- **`SKILL.md` と `references/` 配下の `*-ja.md` でないファイルに日本語を 1 文字も書かない。** `node scripts/check-doc-lang.mjs` が硬いゲート。`README.md` / `CLAUDE.md` / `*-ja.md` は日本語。
- **シェルスクリプトのコメントは日本語**（`config-edit.sh` と同じ。ルート / プラグイン `CLAUDE.md` の規約）。コード識別子は英語。
- **コミットメッセージは日本語。**
- **バージョン番号を bump しない。push しない。PR を作らない。** 親がローカルで merge する。
- **4 ファイル整合ルール**（`apps/cmux-team-dispatch-task/CLAUDE.md`）: `SKILL.md` / `references/guide-ja.md` / `README.md` / `CLAUDE.md` は同じコミットで一致させる。`setup-mode.md` / `setup-mode-ja.md` も相互にミラーする。
- **既存テストの grep 対象を壊さない。** 特に `test-setup-skill.sh` SU5 が探す 10 個の文字列（うち 7 個が今回の改訂対象セクション内）と SU1 / SU3 / SU8 の needle。詳細は spec §3.2。
  **SU6 の 2 needle にも注意**: `mutually exclusive with \`--loop\`` と `never reach Step 1a` は
  Task 5 が書き換える `SKILL.md:117` と**同じ段落（117-121 行）**にある。段落ごと書き直すと道連れになる。
- **`prewarm-panes.sh` を呼ぶテストを足さない。** 呼ぶなら先に worktree ディレクトリを `mkdir -p` すること（呼ばなければ該当しない）。本計画のテストは一切呼ばない。
- effort allowlist は engine 別: claude `low|medium|high|xhigh|max`、codex `minimal|low|medium|high|xhigh`。**codex に `max` を出さない・通さない。**
- 既定値（変更しない）: model は plan/review claude `opus[1m]` / exec claude `sonnet`（codex は既定なし）、effort は両 engine 共通で plan/review `xhigh` / exec `high`。

---

## File Structure

| パス | 種別 | 責務 |
|---|---|---|
| `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/runners-edit.sh` | 新規 | `runners.json` の 6 フィールドを原子的に読み書きする唯一の口。runner の同一性（`name` / `command` / `engine` / `default`）には触らない |
| `apps/cmux-team-dispatch-task/test/test-runners-edit.sh` | 新規 | 上記の動的ユニットテスト（RE1-RE20 + 7 sub-id） |
| `apps/cmux-team-dispatch-task/test/test-setup-skill.sh` | 変更 | SU10-SU16 を追加（SU1-SU9 は変更しない）。SU13 は `README.md` も読むので `$SCRIPT_DIR/../README.md` を解決する |
| `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/setup-mode.md` | 変更 | `--setup` の runtime SoT。S1/S2/S3/S6/S7 改訂、`### S3-M` 新設、`## All writes …` 改題 + I/F 段落 |
| `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/setup-mode-ja.md` | 変更 | 上記の日本語ミラー（見出しレベル・個数・順序まで一致） |
| `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md` | 変更 | `## Setup Mode` 節、`Both modes write exclusively …`、First-run setup 見出し、`Never call config-edit.sh here.` |
| `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md` | 変更 | SKILL.md の 1:1 訳 3 箇所（`## セットアップモード` 節 / 67 行 / 251 行）＋ **1:1 訳では拾えない独自 2 箇所（1363 行の README ミラー / 1641 行の初回セットアップ）** |
| `apps/cmux-team-dispatch-task/README.md` | 変更 | `### 設定（--setup）` / 286 行 / 131 行 |
| `apps/cmux-team-dispatch-task/CLAUDE.md` | 変更 | **Task 5 Step 6 の 8 項目**（保守手順 44 の 2 変更を 1 項目にまとめている）: ファイル構成表 2 箇所（新規行 + 23 行）、「role 解決の現行契約」節の 91 行、保守手順 28 の 3 箇所（247 / 251 / 本文）、保守手順 44（検査条件の拡張 + 末尾 1 行）、E2E 項目 43。**193 行（保守手順 19）と 152 行（保守項目 10）は変更不要・逐語保護**なので触らない |

**タスクの切り方**: Task 1-3 でスクリプトを TDD で作り（読み取り → 書き込み → dry-run）、Task 4 で `setup-mode*` と対応 SU、Task 5 で 4 ファイル整合と SU13、Task 6 で全ゲート。各タスクの末尾で `test/*.sh` が全部緑になる。

---

### Task 1: `runners-edit.sh` の引数解析・検証・読み取りモード

**Files:**
- Create: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/runners-edit.sh`
- Test: `apps/cmux-team-dispatch-task/test/test-runners-edit.sh`

**Interfaces:**
- Consumes: なし（新規）
- Produces: `runners-edit.sh` の CLI。
  `--runners <path>` / `--name <runner>` / `--set <field>=<value>` / `--unset <field>` /
  `--get <field>` / `--show` / `--dry-run`。exit 0 成功 / 1 読み書き失敗（ファイル無変更）/
  2 usage・検証エラー。Task 2 / 3 が同じファイルを拡張する。

- [ ] **Step 1: テストハーネスと読み取り系ケースを書く（失敗する）**

`apps/cmux-team-dispatch-task/test/test-runners-edit.sh` を新規作成する。

```bash
#!/usr/bin/env bash
# runners-edit.sh の単体テスト。
#
# 守っている不変条件（spec: docs/superpowers/specs/2026-08-20-setup-model-effort-design.md §4.1）:
#   RE1  --set が指定 runner のフィールドだけを更新し、他 runner と default の値を変えない
#   RE2  allowlist 外のフィールド名は --set / --unset / --get の 3 モードとも exit 2
#   RE3  engine 別 effort allowlist（負と正のコントロール両方）
#   RE4  model はモデル名を allowlist しないが、空 / 空白のみ / 前後の空白 /
#        シェルメタ文字 / 制御文字は exit 2
#   RE5  --unset は該当フィールドだけ削除。不在フィールドでも exit 0（冪等）
#   RE6  未知の --name は exit 2 かつ cmp でバイト同一
#   RE7  複数の --set / --unset が 1 回でまとめて反映される
#   RE8  壊れた JSON / 読み取り不能 / 0 バイトは exit 1、元ファイル無傷
#   RE9  temp の残骸が全経路でゼロ（7 経路。--dry-run は RE18 の no_residue、
#        mv 失敗は RE9b の find が担保する）
#   RE9b mv 失敗（chflags uchg）で exit 1・固有メッセージ・残骸ゼロ・原ファイル無傷
#   RE9c mktemp 失敗（chmod 555 の親）で exit 1・固有メッセージ・残骸ゼロ
#   RE9d 順序の直接検証（555 親で検証エラーが exit 2 になる = mktemp より前に検証している）
#   RE9e --dry-run と読み取りモードが 555 親でも exit 0（mktemp を経由していない）
#   RE10 --get / --show は非破壊。不在 / 未登録 name / 破損の扱い
#   RE11 引数エラーはすべて exit 2
#   RE12 編集対象レコード内の allowlist 外フィールドが生存する（マージであって置換でない）
#   RE13 書き込みモードでファイル不在は exit 2、親ディレクトリを作らない
#   RE14a 注入・拒否側: メタ文字入りペイロードは exit 2 かつ cmp バイト同一
#   RE14b 注入・往復側: opus[1m] が exit 0 で完全一致往復し、他フィールドが不変
#   RE15 .runners が配列でないときは exit 2。配列だが要素が非オブジェクトのときは
#        型安全 select で素通しして exit 0（ガードを外すと rc=5 → exit 1 になる）
#   RE16 name 重複は exit 2。" や $ を含む name でも 3 モードとも正しく動く
#   RE17 engine 欠落 / 未知 engine への --set <*_effort> は exit 2、--unset は exit 0
#   RE18 --dry-run は書き込まず当該レコードだけを出す
#   RE18b --dry-run の出力が実書き込み結果と一致する
#   RE19 欠番（trap により弁別力がゼロだったため RE9 へ統合。id は詰めない）
#   RE20 runners[] が空配列のときの --set / bare --show

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EDIT="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/runners-edit.sh"
fail=0

[[ -f "$EDIT" ]] || { echo "FAIL: runners-edit.sh が無い: $EDIT"; exit 2; }

TMP=$(mktemp -d)
# chmod 555 のディレクトリと uchg のファイルは rm -rf で消せないので、trap の前に必ず戻す
cleanup() {
  chmod -R u+w "$TMP" 2>/dev/null || true
  find "$TMP" -flags uchg -exec chflags nouchg {} + 2>/dev/null || true
  rm -rf "$TMP"
}
# EXIT だけだと SIGTERM でハンドラは走るがスクリプトが続行し、消えた $TMP に対して
# 残りのテストが走って rc=0 の偽成功になる。INT / TERM は明示的に終了させる。
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

bad() { echo "FAIL $1"; fail=1; }
ok() { echo "PASS $1"; }

R="$TMP/runners.json"

# 標準フィクスチャ。claude と codex を 1 件ずつ、未知フィールド zzz_custom 付き。
reset_registry() {
  rm -f "$TMP"/runners.json*
  cat > "$R" <<'JSON'
{
  "default": "cc",
  "zzz_top": "keep-me",
  "runners": [
    { "name": "cc", "command": "claude", "engine": "claude",
      "plan_model": "opus[1m]", "exec_model": "fable",
      "plan_effort": "max", "zzz_custom": "keep-me-too" },
    { "name": "cx", "command": "codex", "engine": "codex",
      "review_model": "gpt-5.6-sol", "exec_effort": "high" }
  ]
}
JSON
}

# temp の残骸検査。runners.json.XXXXXX が 1 件も無いこと。
no_residue() {
  local n
  n=$(find "$TMP" -maxdepth 1 -name 'runners.json.*' | wc -l | tr -d ' ')
  [[ "$n" == 0 ]]
}

# ---- RE11: 引数エラーはすべて exit 2 ----
reset_registry
re11_pass=1
run_rc() { bash "$EDIT" "$@" >/dev/null 2>&1; echo $?; }
[[ "$(run_rc)" == 2 ]] || re11_pass=0                                          # 引数なし
[[ "$(run_rc --runners "$R" --name cc --set plan_effort=max --show)" == 2 ]] || re11_pass=0
[[ "$(run_rc --runners "$R" --name cc)" == 2 ]] || re11_pass=0                 # モード未指定
[[ "$(run_rc --name cc --show)" == 2 ]] || re11_pass=0                         # --runners 未指定
[[ "$(run_rc --runners "$R" --set plan_effort=max)" == 2 ]] || re11_pass=0     # --set に --name なし
[[ "$(run_rc --runners "$R" --get plan_model)" == 2 ]] || re11_pass=0          # --get に --name なし
[[ "$(run_rc --runners "$R" --name cc --set plan_effort)" == 2 ]] || re11_pass=0  # 形式違い
[[ "$(run_rc --runners "$R" --name cc --set plan_effort=max --unset plan_effort)" == 2 ]] || re11_pass=0
[[ "$(run_rc --runners "$R" --name cc --unset plan_effort --set plan_effort=max)" == 2 ]] || re11_pass=0  # 逆順
[[ "$(run_rc --runners "$R" --name cc --set plan_effort=max --set plan_effort=high)" == 2 ]] || re11_pass=0
[[ "$(run_rc --runners "$R" --name cc --unset plan_effort --unset plan_effort)" == 2 ]] || re11_pass=0
[[ "$(run_rc --runners "$R" --name cc --get plan_model --get exec_model)" == 2 ]] || re11_pass=0
[[ "$(run_rc --runners "$R" --name cc --name cx --show)" == 2 ]] || re11_pass=0
[[ "$(run_rc --runners "$R" --runners "$R" --name cc --show)" == 2 ]] || re11_pass=0
[[ "$(run_rc --runners "$R" --name cc --show --dry-run)" == 2 ]] || re11_pass=0
if [[ $re11_pass == 1 ]]; then ok 'RE11: 引数エラーはすべて exit 2'; else bad 'RE11'; fi

# ---- RE2: allowlist 外のフィールド名は 3 モードとも exit 2 ----
reset_registry
re2_pass=1
[[ "$(run_rc --runners "$R" --name cc --set engine=codex)" == 2 ]] || re2_pass=0
[[ "$(run_rc --runners "$R" --name cc --unset engine)" == 2 ]] || re2_pass=0
[[ "$(run_rc --runners "$R" --name cc --get engine)" == 2 ]] || re2_pass=0
[[ "$(run_rc --runners "$R" --name cc --set default=cx)" == 2 ]] || re2_pass=0
[[ "$(run_rc --runners "$R" --name cc --set plan_modl=x)" == 2 ]] || re2_pass=0
# runner の同一性に触らないことの唯一の機械的担保。command は実際に実行される文字列。
[[ "$(run_rc --runners "$R" --name cc --set command=x)" == 2 ]] || re2_pass=0
[[ "$(run_rc --runners "$R" --name cc --unset command)" == 2 ]] || re2_pass=0
[[ "$(run_rc --runners "$R" --name cc --unset name)" == 2 ]] || re2_pass=0
[[ "$(run_rc --runners "$R" --name cc --unset default)" == 2 ]] || re2_pass=0
if [[ $re2_pass == 1 ]]; then ok 'RE2: allowlist 外フィールドは 3 モードとも exit 2'; else bad 'RE2'; fi

# ---- RE4: model の値検証（allowlist は作らないが空とメタ文字は弾く） ----
reset_registry
# Task 1 では拒否側だけを検査する（受理側は書き込みを伴うので Task 2 で足す）。
re4_pass=1
for bad_v in '' '   ' '  fable' 'fable  ' "a'b" 'a"b' 'a`b' 'a$b' 'a\b' \
             "$(printf 'a\033b')" "$(printf 'a\tb')"; do
  [[ "$(run_rc --runners "$R" --name cc --set "plan_model=$bad_v")" == 2 ]] || re4_pass=0
done
if [[ $re4_pass == 1 ]]; then ok 'RE4: model の空とメタ文字を弾く'; else bad 'RE4'; fi

# ---- RE10: 読み取りモード ----
reset_registry
re10_pass=1
[[ "$(bash "$EDIT" --runners "$R" --name cc --get plan_model 2>/dev/null)" == 'opus[1m]' ]] || re10_pass=0
[[ -z "$(bash "$EDIT" --runners "$R" --name cc --get review_model 2>/dev/null)" ]] || re10_pass=0
bash "$EDIT" --runners "$R" --name cc --get review_model >/dev/null 2>&1 || re10_pass=0
[[ "$(bash "$EDIT" --runners "$R" --name cx --show 2>/dev/null | jq -r '.name')" == cx ]] || re10_pass=0
[[ "$(bash "$EDIT" --runners "$R" --show 2>/dev/null | jq -r '.default')" == cc ]] || re10_pass=0
# ファイル不在
[[ "$(bash "$EDIT" --runners "$TMP/none.json" --show 2>/dev/null)" == '{}' ]] || re10_pass=0
[[ "$(run_rc --runners "$TMP/none.json" --show)" == 0 ]] || re10_pass=0
[[ -z "$(bash "$EDIT" --runners "$TMP/none.json" --name cc --get plan_model 2>/dev/null)" ]] || re10_pass=0
[[ "$(run_rc --runners "$TMP/none.json" --name cc --get plan_model)" == 0 ]] || re10_pass=0
# 未登録 name は exit 2（フィールド未設定の exit 0 と区別する）
[[ "$(run_rc --runners "$R" --name nope --show)" == 2 ]] || re10_pass=0
[[ "$(run_rc --runners "$R" --name nope --get plan_model)" == 2 ]] || re10_pass=0
# 破損 JSON は読み取りでも exit 1
echo '{ broken' > "$TMP/broken.json"
[[ "$(run_rc --runners "$TMP/broken.json" --show)" == 1 ]] || re10_pass=0
[[ "$(run_rc --runners "$TMP/broken.json" --name cc --get plan_model)" == 1 ]] || re10_pass=0
if [[ $re10_pass == 1 ]]; then ok 'RE10: 読み取りモードは非破壊で契約どおり'; else bad 'RE10'; fi

# ---- RE8: 壊れた JSON / 0 バイト / 読み取り不能 ----
re8_pass=1
echo '{ broken' > "$TMP/b.json"; before=$(cksum < "$TMP/b.json")
[[ "$(run_rc --runners "$TMP/b.json" --name cc --set plan_effort=max)" == 1 ]] || re8_pass=0
[[ "$(cksum < "$TMP/b.json")" == "$before" ]] || re8_pass=0
: > "$TMP/z.json"
for m in '--show' '--name cc --get plan_model' '--name cc --set plan_effort=max' \
         '--name cc --set plan_effort=max --dry-run'; do
  # shellcheck disable=SC2086
  [[ "$(run_rc --runners "$TMP/z.json" $m)" == 1 ]] || re8_pass=0
done
if [[ $EUID -ne 0 ]]; then
  reset_registry
  cp "$R" "$TMP/ro.json"
  chmod 000 "$TMP/ro.json"
  rc_ro=$(run_rc --runners "$TMP/ro.json" --show)
  chmod 644 "$TMP/ro.json"          # 判定より前に必ず戻す（SP6 と同じ形）
  [[ "$rc_ro" == 1 ]] || re8_pass=0
fi
if [[ $re8_pass == 1 ]]; then ok 'RE8: 破損 / 0 バイト / 読み取り不能は exit 1 で原本保持'; else bad 'RE8'; fi

# ---- RE15: .runners の型崩れ ----
re15_pass=1
echo '{"runners": {"a": {"name": "cc"}}}' > "$TMP/o.json"
[[ "$(run_rc --runners "$TMP/o.json" --name cc --set plan_effort=max)" == 2 ]] || re15_pass=0
[[ "$(jq -r '.runners | type' "$TMP/o.json")" == object ]] || re15_pass=0
echo '{"runners": null}' > "$TMP/n.json"
[[ "$(run_rc --runners "$TMP/n.json" --name cc --set plan_effort=max)" == 2 ]] || re15_pass=0
echo '{"x": 1}' > "$TMP/m.json"
[[ "$(run_rc --runners "$TMP/m.json" --name cc --set plan_effort=max)" == 2 ]] || re15_pass=0
echo '{"runners": [1, 2]}' > "$TMP/e.json"
[[ "$(run_rc --runners "$TMP/e.json" --name cc --set plan_effort=max)" == 2 ]] || re15_pass=0
[[ "$(run_rc --runners "$TMP/e.json" --name cc --get plan_model)" == 2 ]] || re15_pass=0
# 配列だが一部の要素が非オブジェクト: 型安全 select が効くので成功し、非オブジェクト要素も生存する。
# WRITE_FILTER から (type == "object") and を外すと jq が rc=5 → exit 1 になるのでここで kill できる。
echo '{"runners":[{"name":"cc","engine":"claude"},true]}' > "$TMP/mixed.json"
[[ "$(run_rc --runners "$TMP/mixed.json" --name cc --set plan_effort=max)" == 0 ]] || re15_pass=0
[[ "$(jq -r '.runners[0].plan_effort' "$TMP/mixed.json")" == max ]] || re15_pass=0
[[ "$(jq -r '.runners[1]' "$TMP/mixed.json")" == true ]] || re15_pass=0
[[ "$(bash "$EDIT" --runners "$TMP/mixed.json" --name cc --show 2>/dev/null | jq -r '.name')" == cc ]] || re15_pass=0
# --dry-run の select / ENGINE / --get / --show の型安全ガードも kill する。
# object-first だと first(...) の短絡で露見しないので、非オブジェクトが先頭のレジストリも使う。
[[ "$(run_rc --runners "$TMP/mixed.json" --name cc --set plan_effort=max --dry-run)" == 0 ]] || re15_pass=0
echo '{"runners":[true,{"name":"cc","engine":"claude"}]}' > "$TMP/mixedrev.json"
[[ "$(run_rc --runners "$TMP/mixedrev.json" --name cc --set plan_effort=max)" == 0 ]] || re15_pass=0
[[ "$(bash "$EDIT" --runners "$TMP/mixedrev.json" --name cc --get plan_effort 2>/dev/null)" == max ]] || re15_pass=0
[[ "$(bash "$EDIT" --runners "$TMP/mixedrev.json" --name cc --show 2>/dev/null | jq -r '.name')" == cc ]] || re15_pass=0
# --name 無しの bare --show は素通し
[[ "$(run_rc --runners "$TMP/o.json" --show)" == 0 ]] || re15_pass=0
if [[ $re15_pass == 1 ]]; then ok 'RE15: .runners が非配列なら exit 2、要素が非オブジェクトなら型安全 select で素通し'; else bad 'RE15'; fi

# ---- RE20: runners[] が空配列 ----
re20_pass=1
echo '{"default": "cc", "runners": []}' > "$TMP/empty.json"
[[ "$(run_rc --runners "$TMP/empty.json" --name cc --set plan_effort=max)" == 2 ]] || re20_pass=0
[[ "$(run_rc --runners "$TMP/empty.json" --show)" == 0 ]] || re20_pass=0
if [[ $re20_pass == 1 ]]; then ok 'RE20: 空 runners[] は --set が exit 2、bare --show は exit 0'; else bad 'RE20'; fi

# ---- RE13: 書き込みモードでファイル不在 ----
re13_pass=1
[[ "$(run_rc --runners "$TMP/nodir/runners.json" --name cc --set plan_effort=max)" == 2 ]] || re13_pass=0
[[ ! -d "$TMP/nodir" ]] || re13_pass=0
# -f を -e に緩めるとディレクトリで偽成功する（コメントに理由が書いてあるのに無テストだった）
mkdir -p "$TMP/adir"
[[ "$(run_rc --runners "$TMP/adir" --name cc --set plan_effort=max)" == 2 ]] || re13_pass=0
[[ "$(run_rc --runners "$TMP/adir" --show)" == 0 ]] || re13_pass=0
if [[ $re13_pass == 1 ]]; then ok 'RE13: 不在 / ディレクトリの扱いと、親を作らないこと'; else bad 'RE13'; fi

if [[ $fail -eq 0 ]]; then
  echo '--- all tests passed ---'
else
  echo '--- failures ---'
fi
exit "$fail"
```

**段取り注（コードブロックには入れない）**: 上の RE15 のうち、`$TMP/mixed.json` と
`$TMP/mixedrev.json` に対する **assert 8 行**（`run_rc` ×3〔うち 1 つが `--dry-run`〕/
`jq` ×2 / `--show` ×2 / `--get` ×1）は書き込みを伴うので、**Task 1 Step 1 ではこの 8 行だけを外す**
（`echo '{"runners":…}' >` の 2 行は残す）。外さないと Task 1 Step 4 が RE15 で赤くなる。
復帰は **7 行が Task 2 Step 1、`--dry-run` の 1 行だけが Task 3 Step 1**。

- [ ] **Step 2: テストが失敗することを確認する**

Run: `cd apps/cmux-team-dispatch-task && bash test/test-runners-edit.sh`
Expected: `FAIL: runners-edit.sh が無い: …` で exit 2。

- [ ] **Step 3: `runners-edit.sh` の前半（引数解析・検証・読み取り）を実装する**

`apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/runners-edit.sh` を新規作成し、実行ビットを立てる（`chmod +x`）。

```bash
#!/usr/bin/env bash
set -euo pipefail

# runners-edit.sh — cmux-team-dispatch-task の runners.json を原子的に読み書きする。
#
# `--setup` の S3-M（登録済み runner の model / effort 編集）から呼ばれる唯一の書き込み口。
# config-edit.sh と同型の契約 (writer 固有 mktemp + jq + jq 成功時のみ同一 directory へ mv)
# をスクリプト側で保証し、呼び出しごとに jq を組み立て直すことで起きるマージ漏れを防ぐ。
#
# 扱えるのは役割別の model / effort 6 フィールドだけ。runner の同一性
# (name / command / engine) と default には触らない。
#
# Usage: runners-edit.sh --runners <path> --name <runner> [--set <field>=<value>]... [--unset <field>]... [--dry-run]
#        runners-edit.sh --runners <path> --name <runner> --get <field>
#        runners-edit.sh --runners <path> [--name <runner>] --show
#
#   --runners <path>     対象 runners.json。既定の場所は
#                        ~/.claude/cmux-team-dispatch-task/runners.json
#   --name <runner>      対象 runner の name。--set / --unset / --get では必須
#   --set <field>=<value> フィールドを設定する (繰り返し可)
#   --unset <field>      フィールドを削除する (繰り返し可)。不在でも成功 (冪等)
#   --dry-run            書き込まず、適用後の当該レコードだけを stdout に出す
#   --get <field>        値を stdout に出す。未設定なら空。値が文字列であることを前提と
#                        する (手編集でオブジェクトが入っていると整形済み複数行を返す)
#   --show               --name 併用でレコード単体、省略時はファイル全体
#
# 検証:
#   フィールドは 6 つの allowlist のみ。未知は exit 2。
#   model は「モデル名の allowlist を作らない」が、空・空白のみ・前後の空白パディング・
#   シェルメタ文字 (' " ` $ \) ・制御文字は exit 2。値は zsh -ic の二重引用を通って
#   再実行されるため。
#   effort は runner レコードの engine 別 allowlist
#   (claude: low|medium|high|xhigh|max / codex: minimal|low|medium|high|xhigh)。
#   codex に max は無い。
#
# exit code: 0 成功 / 1 読み書き失敗 (ファイルは変更されない) / 2 usage・検証エラー

die_usage() {
  echo "runners-edit: $1" >&2
  echo 'Usage: runners-edit.sh --runners <path> --name <runner> [--set <field>=<value>]... [--unset <field>]... [--dry-run]' >&2
  echo '       runners-edit.sh --runners <path> --name <runner> --get <field>' >&2
  echo '       runners-edit.sh --runners <path> [--name <runner>] --show' >&2
  exit 2
}

known_field() {
  case "$1" in
    plan_model|review_model|exec_model|plan_effort|review_effort|exec_effort) return 0 ;;
    *) return 1 ;;
  esac
}

is_model_field() { case "$1" in *_model) return 0 ;; *) return 1 ;; esac; }

# モデル名の allowlist は作らない。空・前後の空白・シェルメタ文字・制御文字だけ弾く。
# 前後の空白を黙ってトリムすると「入力した値と違う値が保存される」ことになるので弾く。
valid_model_value() {
  local v="$1"
  [[ -n "$v" ]] || return 1
  case "$v" in
    [[:space:]]*|*[[:space:]]) return 1 ;;
  esac
  case "$v" in
    *\'*|*\"*|*\`*|*\$*|*\\*) return 1 ;;
  esac
  case "$v" in
    *[[:cntrl:]]*) return 1 ;;
  esac
  return 0
}

valid_effort_value() {
  case "$2" in
    claude) case "$1" in low|medium|high|xhigh|max) return 0 ;; *) return 1 ;; esac ;;
    codex)  case "$1" in minimal|low|medium|high|xhigh) return 0 ;; *) return 1 ;; esac ;;
    *) return 1 ;;
  esac
}

RUNNERS=""
NAME=""
GET_FIELD=""
SHOW=0
DRY_RUN=0
MUTATE=0
ARG_INDEX=0
FILTER=""
JQ_ARGS=()
SET_FIELDS=" "
UNSET_FIELDS=" "
EFFORT_CHECKS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --runners)
      [[ $# -ge 2 ]] || die_usage '--runners requires a value'
      # 繰り返し不可のフラグは last-wins で黙って通さない。S6 のプレビューを組み立てる
      # LLM がフラグを重ねたとき、別フィールドの値を「現在値」として提示しうるため。
      # 空文字は「未指定」と区別しない (S3-M で空名は流れない)。boolean の --show /
      # --dry-run は値を持たず曖昧さが無いので重複を許す。
      [[ -z "$RUNNERS" ]] || die_usage '--runners given more than once'
      RUNNERS="$2"; shift 2 ;;
    --name)
      [[ $# -ge 2 ]] || die_usage '--name requires a value'
      [[ -z "$NAME" ]] || die_usage '--name given more than once'
      NAME="$2"; shift 2 ;;
    --set)
      [[ $# -ge 2 ]] || die_usage '--set requires <field>=<value>'
      case "$2" in
        *=*) ;;
        *) die_usage "--set must be <field>=<value>: $2" ;;
      esac
      set_field="${2%%=*}"
      set_value="${2#*=}"
      known_field "$set_field" || die_usage "unknown field: $set_field"
      case "$SET_FIELDS" in *" $set_field "*) die_usage "duplicate --set for $set_field" ;; esac
      case "$UNSET_FIELDS" in *" $set_field "*) die_usage "--set and --unset for the same field: $set_field" ;; esac
      if is_model_field "$set_field"; then
        valid_model_value "$set_value" \
          || die_usage "invalid model value for $set_field (empty, leading/trailing whitespace, or contains a shell metacharacter or a control character)"
      else
        # engine はレコードを読むまで分からないので、後で照合する
        EFFORT_CHECKS+=("$set_field=$set_value")
      fi
      SET_FIELDS="$SET_FIELDS$set_field "
      ARG_INDEX=$((ARG_INDEX + 1))
      JQ_ARGS+=(--arg "v$ARG_INDEX" "$set_value")
      # フィールド名は allowlist 済みなので jq 式へ直接埋めてよい。値は必ず --arg 経由。
      FILTER="${FILTER:+$FILTER | }.${set_field} = \$v$ARG_INDEX"
      MUTATE=1
      shift 2 ;;
    --unset)
      [[ $# -ge 2 ]] || die_usage '--unset requires a field'
      known_field "$2" || die_usage "unknown field: $2"
      case "$SET_FIELDS" in *" $2 "*) die_usage "--set and --unset for the same field: $2" ;; esac
      case "$UNSET_FIELDS" in *" $2 "*) die_usage "duplicate --unset for $2" ;; esac
      UNSET_FIELDS="$UNSET_FIELDS$2 "
      FILTER="${FILTER:+$FILTER | }del(.${2})"
      MUTATE=1
      shift 2 ;;
    --dry-run)
      DRY_RUN=1; shift ;;
    --get)
      [[ $# -ge 2 ]] || die_usage '--get requires a field'
      known_field "$2" || die_usage "unknown field: $2"
      [[ -z "$GET_FIELD" ]] || die_usage '--get given more than once'
      GET_FIELD="$2"; shift 2 ;;
    --show)
      SHOW=1; shift ;;
    *)
      die_usage "unknown argument: $1" ;;
  esac
done

[[ -n "$RUNNERS" ]] || die_usage '--runners is required'

mode_count=$((MUTATE + SHOW))
[[ -n "$GET_FIELD" ]] && mode_count=$((mode_count + 1))
[[ "$mode_count" -eq 1 ]] \
  || die_usage 'specify exactly one of --set/--unset, --get, or --show'
[[ "$DRY_RUN" -eq 0 || "$MUTATE" -eq 1 ]] || die_usage '--dry-run requires --set or --unset'
if [[ "$MUTATE" -eq 1 || -n "$GET_FIELD" ]]; then
  [[ -n "$NAME" ]] || die_usage '--name is required for --set/--unset/--get'
fi

# 検証はすべて mktemp より前に完了する。trap は引数パース直後に張る:
# 検証エラーの exit 経路と mktemp 経路で trap の有無を分岐させないためと、
# mktemp 〜 mv の窓を SIGINT / SIGTERM / SIGHUP から守るため。
# trap 本体は必ず成功で終わる形にする (rm -f の -f を外すと exit 2 が exit 1 に化ける)。
TMP=""
trap 'rm -f "${TMP:-}"' EXIT

# -e ではなく -f を使う。-e だとディレクトリを渡したとき偽成功する。
if [[ ! -f "$RUNNERS" ]]; then
  if [[ "$MUTATE" -eq 1 ]]; then
    die_usage "$RUNNERS does not exist; creating the registry is First-run setup's job"
  fi
  if [[ -n "$GET_FIELD" ]]; then exit 0; fi
  echo '{}'
  exit 0
fi

if ! DOC=$(jq . "$RUNNERS" 2>/dev/null); then
  echo "runners-edit: cannot read $RUNNERS (invalid JSON or unreadable)" >&2
  exit 1
fi
# jq は 0 バイト入力・空白のみ入力に rc=0 を返すので、別途弾く。
if [[ -z "${DOC//[[:space:]]/}" ]]; then
  echo "runners-edit: $RUNNERS is empty" >&2
  exit 1
fi

if [[ -n "$NAME" ]]; then
  if [[ "$(jq -r '.runners | type' <<<"$DOC" 2>/dev/null)" != array ]]; then
    echo "runners-edit: .runners is not an array in $RUNNERS" >&2
    exit 2
  fi
  # jq が失敗しても空文字になり "1" と等しくならない
  # (型安全 select にした今 || echo '' は到達不能な安全弁。select を戻したときのため残す)
  MATCHES=$(jq --arg n "$NAME" \
    '[.runners[] | select((type == "object") and .name == $n)] | length' \
    <<<"$DOC" 2>/dev/null || echo '')
  if [[ "$MATCHES" != 1 ]]; then
    echo "runners-edit: --name '$NAME' must match exactly one runner (matched: ${MATCHES:-error})" >&2
    exit 2
  fi
fi

# effort の照合はレコードの engine を読んでから。--set <*_effort> のときだけ。
if [[ "$MUTATE" -eq 1 && ${#EFFORT_CHECKS[@]} -gt 0 ]]; then
  ENGINE=$(jq -r --arg n "$NAME" \
    'first(.runners[] | select((type == "object") and .name == $n) | .engine // empty)' \
    <<<"$DOC" 2>/dev/null || echo '')
  case "$ENGINE" in
    claude|codex) ;;
    *)
      echo "runners-edit: runner '$NAME' has no usable engine; cannot validate effort" >&2
      exit 2 ;;
  esac
  for chk in ${EFFORT_CHECKS[@]+"${EFFORT_CHECKS[@]}"}; do
    chk_field="${chk%%=*}"
    chk_value="${chk#*=}"
    valid_effort_value "$chk_value" "$ENGINE" \
      || die_usage "invalid effort '$chk_value' for the $ENGINE engine ($chk_field)"
  done
fi

# 読み取りモードはここで結果を出して終わる。--name は必ず --arg、
# フィールド名は allowlist 通過後にのみ式へ埋める。
if [[ -n "$GET_FIELD" ]]; then
  if ! jq -r --arg n "$NAME" \
    "first(.runners[] | select((type == \"object\") and .name == \$n) | .${GET_FIELD} // empty)" \
    <<<"$DOC"; then
    echo "runners-edit: read failed" >&2
    exit 1
  fi
  exit 0
fi

if [[ "$SHOW" -eq 1 ]]; then
  if [[ -n "$NAME" ]]; then
    if ! jq --arg n "$NAME" \
      'first(.runners[] | select((type == "object") and .name == $n))' <<<"$DOC"; then
      echo "runners-edit: read failed" >&2
      exit 1
    fi
  else
    # 手順 3 / 4 はスキップ済み。config-edit.sh と同じ素通し。
    if ! jq '.' <<<"$DOC"; then
      echo "runners-edit: read failed" >&2
      exit 1
    fi
  fi
  exit 0
fi

# 書き込みは Task 2 で実装する。
echo 'runners-edit: write path not implemented yet' >&2
exit 1
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `cd apps/cmux-team-dispatch-task && bash test/test-runners-edit.sh`
Expected: `--- all tests passed ---` で exit 0（RE11 / RE2 / RE4 / RE10 / RE8 / RE15 /
RE20 / RE13 がすべて PASS）。この時点のテストは書き込みを一切行わないので、
末尾の「write path not implemented yet」には到達しない。

- [ ] **Step 5: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/runners-edit.sh \
        apps/cmux-team-dispatch-task/test/test-runners-edit.sh
git commit -m "feat(cmux-team-dispatch-task): runners-edit.sh の引数解析・検証・読み取りを実装する"
```

---

### Task 2: `runners-edit.sh` の書き込みパス（mktemp / jq / mv / trap）

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/runners-edit.sh`（末尾の未実装ブロックを置き換える）
- Modify: `apps/cmux-team-dispatch-task/test/test-runners-edit.sh`（RE1 / RE3 / RE4 good / RE5 / RE6 / RE7 / RE9 / RE9b / RE9c / RE9d / RE12 / RE14a / RE14b / RE16 / RE17 を追加）

**Interfaces:**
- Consumes: Task 1 の `$DOC` / `$FILTER` / `$JQ_ARGS` / `$NAME` / `$TMP` / `$MUTATE` / `$DRY_RUN`
- Produces: 書き込み成功時 exit 0 かつ `runners.json` が更新される。`--dry-run` は Task 3。

- [ ] **Step 1: 書き込み系のテストを追加する（失敗する）**

まず **Task 1 Step 1 で外した 2 箇所を戻す**:
(a) **RE15 の assert 7 行** —
`mixed.json` に対する `run_rc` / `jq` ×2 / `--show` の 4 行と、
`mixedrev.json` に対する `run_rc` / `--get` / `--show` の 3 行。
**`mixed.json` に対する `--dry-run` の 1 行だけは戻さない**（Task 3 Step 1 で戻す。
この時点では `--dry-run` が未実装なので戻すと Task 2 Step 4 が赤くなる）。
`echo` の 2 行は Task 1 でも残っている。
(b) **RE4 の受理側ループ**（Task 1 には書かない。下の挿入ブロックに含まれているので、
別途足す必要は無い）。
そのうえで `if [[ $fail -eq 0 ]]` の直前に次を挿入する。

```bash
# ---- RE1 / RE12: 指定 runner のフィールドだけ更新、他は値が不変 ----
reset_registry
before_cx=$(jq -cS '.runners[1]' "$R")
bash "$EDIT" --runners "$R" --name cc --set plan_effort=high >/dev/null 2>&1
re1_pass=1
[[ "$(jq -r '.runners[0].plan_effort' "$R")" == high ]] || re1_pass=0
[[ "$(jq -cS '.runners[1]' "$R")" == "$before_cx" ]] || re1_pass=0
[[ "$(jq -r '.default' "$R")" == cc ]] || re1_pass=0
[[ "$(jq -r '.zzz_top' "$R")" == keep-me ]] || re1_pass=0
[[ "$(jq -r '.runners[0].zzz_custom' "$R")" == keep-me-too ]] || re1_pass=0
[[ "$(jq -r '.runners[0].command' "$R")" == claude ]] || re1_pass=0
if [[ $re1_pass == 1 ]]; then ok 'RE1/RE12: 指定 runner だけ更新、未知キーとフィールドは生存'; else bad 'RE1/RE12'; fi

# ---- RE4（受理側）: モデル名の allowlist は作らない ----
reset_registry
re4b_pass=1
# 'opus 1m' は「内部の空白は通る」の witness。doc がそう書いているのに検査が無いと、
# valid_model_value を *[[:space:]]* で弾く変異体が全緑で生存する。
for good in 'gpt-9.9-nova' 'opus[1m]' 'a.b_c-d/e' 'opus 1m'; do
  bash "$EDIT" --runners "$R" --name cc --set "plan_model=$good" >/dev/null 2>&1 \
    && [[ "$(jq -r '.runners[0].plan_model' "$R")" == "$good" ]] || re4b_pass=0
done
if [[ $re4b_pass == 1 ]]; then ok 'RE4: 未知のモデル名文字列がそのまま通る'; else bad 'RE4 受理側'; fi

# ---- RE3: engine 別 effort allowlist（負と正のコントロール） ----
reset_registry
re3_pass=1
[[ "$(run_rc --runners "$R" --name cc --set plan_effort=minimal)" == 2 ]] || re3_pass=0
[[ "$(run_rc --runners "$R" --name cx --set plan_effort=max)" == 2 ]] || re3_pass=0
for v in max low; do
  bash "$EDIT" --runners "$R" --name cc --set "plan_effort=$v" >/dev/null 2>&1 \
    && [[ "$(jq -r '.runners[0].plan_effort' "$R")" == "$v" ]] || re3_pass=0
done
for v in minimal xhigh; do
  bash "$EDIT" --runners "$R" --name cx --set "plan_effort=$v" >/dev/null 2>&1 \
    && [[ "$(jq -r '.runners[1].plan_effort' "$R")" == "$v" ]] || re3_pass=0
done
if [[ $re3_pass == 1 ]]; then ok 'RE3: engine 別 effort allowlist（負と正の両方）'; else bad 'RE3'; fi

# ---- RE5: --unset は該当フィールドだけ削除。不在でも冪等 ----
reset_registry
re5_pass=1
bash "$EDIT" --runners "$R" --name cc --unset plan_model >/dev/null 2>&1 || re5_pass=0
[[ "$(jq -r '.runners[0] | has("plan_model")' "$R")" == false ]] || re5_pass=0
[[ "$(jq -r '.runners[0].exec_model' "$R")" == fable ]] || re5_pass=0
bash "$EDIT" --runners "$R" --name cc --unset plan_model >/dev/null 2>&1 || re5_pass=0
bash "$EDIT" --runners "$R" --name cc --unset review_effort >/dev/null 2>&1 || re5_pass=0
if [[ $re5_pass == 1 ]]; then ok 'RE5: --unset は該当フィールドだけ削除し冪等'; else bad 'RE5'; fi

# ---- RE6: 未知の --name は exit 2 かつバイト同一 ----
reset_registry
cp "$R" "$TMP/expect.json"
re6_pass=1
[[ "$(run_rc --runners "$R" --name nope --set plan_effort=max)" == 2 ]] || re6_pass=0
cmp -s "$R" "$TMP/expect.json" || re6_pass=0
if [[ $re6_pass == 1 ]]; then ok 'RE6: 未知 --name は exit 2 かつバイト同一'; else bad 'RE6'; fi

# ---- RE7: 複数の --set / --unset が 1 回でまとめて反映される ----
reset_registry
re7_pass=1
bash "$EDIT" --runners "$R" --name cc \
  --set plan_effort=xhigh --set review_model=fable --unset exec_model >/dev/null 2>&1 || re7_pass=0
[[ "$(jq -r '.runners[0].plan_effort' "$R")" == xhigh ]] || re7_pass=0
[[ "$(jq -r '.runners[0].review_model' "$R")" == fable ]] || re7_pass=0
[[ "$(jq -r '.runners[0] | has("exec_model")' "$R")" == false ]] || re7_pass=0
if [[ $re7_pass == 1 ]]; then ok 'RE7: 複数の --set / --unset が 1 回で反映される'; else bad 'RE7'; fi

# ---- RE14a: 注入・拒否側 ----
reset_registry
cp "$R" "$TMP/expect.json"
re14a_pass=1
[[ "$(run_rc --runners "$R" --name cc --set 'plan_model=a", "command": "pwned')" == 2 ]] || re14a_pass=0
cmp -s "$R" "$TMP/expect.json" || re14a_pass=0
if [[ $re14a_pass == 1 ]]; then ok 'RE14a: メタ文字入りペイロードは exit 2 かつバイト同一'; else bad 'RE14a'; fi

# ---- RE14b: 注入・往復側（jq 構文として意味を持つ値） ----
# 値はフィクスチャの現在値 (opus[1m]) と必ず違えること。同値だと --set を no-op にする
# 変異体でも PASS してしまい、「完全一致往復」が証明できない。
reset_registry
re14b_pass=1
bash "$EDIT" --runners "$R" --name cc --set 'plan_model=fable[1m]' >/dev/null 2>&1 || re14b_pass=0
[[ "$(jq -r '.runners[0].plan_model' "$R")" == 'fable[1m]' ]] || re14b_pass=0
[[ "$(jq -r '.runners[0].command' "$R")" == claude ]] || re14b_pass=0
[[ "$(jq -r '.runners[0].engine' "$R")" == claude ]] || re14b_pass=0
[[ "$(jq -r '.runners[0].name' "$R")" == cc ]] || re14b_pass=0
[[ "$(jq -r '.runners[1].name' "$R")" == cx ]] || re14b_pass=0
[[ "$(jq -r '.default' "$R")" == cc ]] || re14b_pass=0
if [[ $re14b_pass == 1 ]]; then ok 'RE14b: jq 添字構文を含む値が完全一致往復する'; else bad 'RE14b'; fi

# ---- RE16: name 重複と、" / $ を含む name の 3 モード ----
re16_pass=1
cat > "$TMP/dup.json" <<'JSON'
{ "runners": [ { "name": "d", "engine": "claude" }, { "name": "d", "engine": "claude" } ] }
JSON
cp "$TMP/dup.json" "$TMP/dup.expect"
[[ "$(run_rc --runners "$TMP/dup.json" --name d --set plan_effort=max)" == 2 ]] || re16_pass=0
cmp -s "$TMP/dup.json" "$TMP/dup.expect" || re16_pass=0
cat > "$TMP/odd.json" <<'JSON'
{ "runners": [ { "name": "a\"b$c", "engine": "claude", "command": "x" },
               { "name": "plain", "engine": "claude" } ] }
JSON
bash "$EDIT" --runners "$TMP/odd.json" --name 'a"b$c' --set plan_effort=max >/dev/null 2>&1 || re16_pass=0
[[ "$(jq -r '.runners[0].plan_effort' "$TMP/odd.json")" == max ]] || re16_pass=0
[[ "$(jq -r '.runners[1] | has("plan_effort")' "$TMP/odd.json")" == false ]] || re16_pass=0
[[ "$(bash "$EDIT" --runners "$TMP/odd.json" --name 'a"b$c' --get plan_effort 2>/dev/null)" == max ]] || re16_pass=0
[[ "$(bash "$EDIT" --runners "$TMP/odd.json" --name 'a"b$c' --show 2>/dev/null | jq -r '.command')" == x ]] || re16_pass=0
if [[ $re16_pass == 1 ]]; then ok 'RE16: name 重複は exit 2、特殊文字 name は 3 モードとも正常'; else bad 'RE16'; fi

# ---- RE17: engine 欠落 / 未知 engine ----
re17_pass=1
cat > "$TMP/noeng.json" <<'JSON'
{ "runners": [ { "name": "g", "command": "x", "plan_effort": "high" },
               { "name": "h", "command": "y", "engine": "gemini" } ] }
JSON
cp "$TMP/noeng.json" "$TMP/noeng.expect"
[[ "$(run_rc --runners "$TMP/noeng.json" --name g --set plan_effort=high)" == 2 ]] || re17_pass=0
[[ "$(run_rc --runners "$TMP/noeng.json" --name h --set plan_effort=high)" == 2 ]] || re17_pass=0
cmp -s "$TMP/noeng.json" "$TMP/noeng.expect" || re17_pass=0
[[ "$(run_rc --runners "$TMP/noeng.json" --name g --set plan_effort=high --dry-run)" == 2 ]] || re17_pass=0
bash "$EDIT" --runners "$TMP/noeng.json" --name g --unset plan_effort >/dev/null 2>&1 || re17_pass=0
[[ "$(jq -r '.runners[0] | has("plan_effort")' "$TMP/noeng.json")" == false ]] || re17_pass=0
if [[ $re17_pass == 1 ]]; then ok 'RE17: engine 不明への --set <*_effort> は exit 2、--unset は exit 0'; else bad 'RE17'; fi

# ---- RE9: 全経路で残骸ゼロ ----
reset_registry
re9_pass=1
bash "$EDIT" --runners "$R" --name cc --set plan_effort=high >/dev/null 2>&1
no_residue || re9_pass=0
run_rc --runners "$R" --name cc --set "plan_model=a'b" >/dev/null; no_residue || re9_pass=0
run_rc --runners "$R" --name cx --set plan_effort=max >/dev/null; no_residue || re9_pass=0
run_rc --runners "$R" --name nope --set plan_effort=max >/dev/null; no_residue || re9_pass=0
echo '{ broken' > "$TMP/br2.json"
bash "$EDIT" --runners "$TMP/br2.json" --name cc --set plan_effort=max >/dev/null 2>&1
[[ "$(find "$TMP" -maxdepth 1 -name 'br2.json.*' | wc -l | tr -d ' ')" == 0 ]] || re9_pass=0
if [[ $re9_pass == 1 ]]; then ok 'RE9: 全経路で temp の残骸がゼロ'; else bad 'RE9'; fi

# ---- RE9b: mv 失敗（chflags uchg） ----
if [[ $EUID -ne 0 ]] && command -v chflags >/dev/null 2>&1; then
  reset_registry
  cp "$R" "$TMP/imm.json"
  chflags uchg "$TMP/imm.json" 2>/dev/null && {
    out=$(bash "$EDIT" --runners "$TMP/imm.json" --name cc --set plan_effort=high 2>&1); rc=$?
    chflags nouchg "$TMP/imm.json"
    re9b_pass=1
    [[ $rc -eq 1 ]] || re9b_pass=0
    grep -q 'move failed' <<<"$out" || re9b_pass=0
    [[ "$(find "$TMP" -maxdepth 1 -name 'imm.json.*' | wc -l | tr -d ' ')" == 0 ]] || re9b_pass=0
    [[ "$(jq -r '.runners[0].plan_effort' "$TMP/imm.json")" == max ]] || re9b_pass=0
    if [[ $re9b_pass == 1 ]]; then ok 'RE9b: mv 失敗で exit 1・固有メッセージ・残骸ゼロ・原本保持'; else bad 'RE9b'; fi
  } || echo 'SKIP RE9b: chflags uchg が使えない'
else
  echo 'SKIP RE9b: root または chflags 無し'
fi

# ---- RE9c / RE9d: chmod 555 の親ディレクトリ ----
if [[ $EUID -ne 0 ]]; then
  mkdir -p "$TMP/ro"
  reset_registry
  cp "$R" "$TMP/ro/runners.json"
  chmod 555 "$TMP/ro"
  # RE9c: mktemp 失敗 → exit 1・固有メッセージ・残骸ゼロ
  out=$(bash "$EDIT" --runners "$TMP/ro/runners.json" --name cc --set plan_effort=high 2>&1); rc9c=$?
  # RE9d: 検証エラーは mktemp より前なので exit 2 のまま（誤順序なら mktemp が先に落ちて rc=1）
  rc_effort=$(bash "$EDIT" --runners "$TMP/ro/runners.json" --name cc --set plan_effort=minimal >/dev/null 2>&1; echo $?)
  rc_name=$(bash "$EDIT" --runners "$TMP/ro/runners.json" --name nope --set plan_effort=high >/dev/null 2>&1; echo $?)
  rc_model=$(bash "$EDIT" --runners "$TMP/ro/runners.json" --name cc --set "plan_model=a'b" >/dev/null 2>&1; echo $?)
  # RE9e: --dry-run と読み取りモードは mktemp を経由しないので 555 でも成功する
  dry=$(bash "$EDIT" --runners "$TMP/ro/runners.json" --name cc --set plan_effort=high --dry-run 2>/dev/null); rc_dry=$?
  showout=$(bash "$EDIT" --runners "$TMP/ro/runners.json" --name cc --show 2>/dev/null); rc_show=$?
  getout=$(bash "$EDIT" --runners "$TMP/ro/runners.json" --name cc --get plan_model 2>/dev/null); rc_get=$?
  residue=$(find "$TMP/ro" -maxdepth 1 -name 'runners.json.*' 2>/dev/null | wc -l | tr -d ' ')
  chmod 755 "$TMP/ro"

  re9c_pass=1
  [[ $rc9c -eq 1 ]] || re9c_pass=0
  grep -q 'mktemp failed' <<<"$out" || re9c_pass=0
  [[ "$residue" == 0 ]] || re9c_pass=0
  if [[ $re9c_pass == 1 ]]; then ok 'RE9c: mktemp 失敗で exit 1・固有メッセージ・残骸ゼロ'; else bad 'RE9c'; fi

  re9d_pass=1
  [[ "$rc_effort" == 2 ]] || re9d_pass=0
  [[ "$rc_name" == 2 ]] || re9d_pass=0
  [[ "$rc_model" == 2 ]] || re9d_pass=0   # 正のコントロール（手順 0 なので順序の観測窓ではない）
  if [[ $re9d_pass == 1 ]]; then ok 'RE9d: 検証は mktemp より前（555 親でも exit 2）'; else bad 'RE9d'; fi

  re9e_pass=1
  [[ $rc_dry -eq 0 ]] || re9e_pass=0
  [[ "$(jq -r '.plan_effort' <<<"$dry")" == high ]] || re9e_pass=0
  [[ $rc_show -eq 0 ]] || re9e_pass=0
  [[ "$(jq -r '.name' <<<"$showout")" == cc ]] || re9e_pass=0
  [[ $rc_get -eq 0 ]] || re9e_pass=0
  [[ "$getout" == 'opus[1m]' ]] || re9e_pass=0
  if [[ $re9e_pass == 1 ]]; then ok 'RE9e: --dry-run と読み取りは mktemp を経由しない'; else bad 'RE9e'; fi
else
  echo 'SKIP RE9c/RE9d/RE9e: root'
fi
```

**注**: 上のブロックのうち **RE9e の 3 行（`dry=$(…--dry-run…)` の取得と
`re9e_pass` の判定 2 行）だけは Task 3 で `--dry-run` を実装するまで成立しない。**
Task 2 の Step 1 では `--dry-run` を呼ぶ行と `re9e_pass` の判定ブロックをコメントアウトし、
`--show` / `--get` の 4 行だけで RE9e を出す。Task 3 の Step 1 で戻す。

- [ ] **Step 2: テストが失敗することを確認する**

Run: `cd apps/cmux-team-dispatch-task && bash test/test-runners-edit.sh`
Expected: **FAIL するのはちょうど次の 11 件** —
`RE1/RE12` / `RE4 受理側` / `RE3` / `RE5` / `RE7` / `RE14b` / `RE15` / `RE16` / `RE17` /
`RE9b` / `RE9c`（`RE15` は Step 1 で戻す mixed 配列の `--set` が write stub に当たるため）。
`RE6` / `RE9` / `RE9d` / `RE14a` は**この時点でも PASS する**（いずれも書き込みパスへ到達せず
parse / 手順 4 / 手順 0 で exit 2 になるため）。ここで期待と食い違うと幻の不具合を追うことになる。

- [ ] **Step 3: 書き込みパスを実装する**

`runners-edit.sh` の末尾 2 行

```bash
# 書き込みは Task 2 で実装する。
echo 'runners-edit: write path not implemented yet' >&2
exit 1
```

を次で置き換える。

```bash
# 対象 runner だけを写像する。他の要素・default・未知キーはそのまま通す。
# (type == "object") and を省略すると、要素が非オブジェクトのレジストリで jq が rc=5 で死ぬ。
WRITE_FILTER=".runners |= map(if (type == \"object\") and .name == \$n then ($FILTER) else . end)"

if [[ "$DRY_RUN" -eq 1 ]]; then
  # 書き込みは Task 3 で実装する。
  echo 'runners-edit: --dry-run not implemented yet' >&2
  exit 1
fi

# 共有 $RUNNERS.tmp は並列書き込みで壊れるため必ず writer 固有の mktemp を使う。
if ! TMP=$(mktemp "$RUNNERS.XXXXXX"); then
  echo 'runners-edit: mktemp failed; nothing was written' >&2
  exit 1
fi

# jq が失敗したまま mv すると runners.json を壊すので、成功時だけ mv する。
# なおここに到達する失敗の witness は構築できない (手順 3 / 4 を通過した文書では
# 型安全 select が効くため)。意図的に到達困難な安全弁である。
jq ${JQ_ARGS[@]+"${JQ_ARGS[@]}"} --arg n "$NAME" "$WRITE_FILTER" <<<"$DOC" > "$TMP" || {
  rm -f "$TMP"
  echo "runners-edit: write failed (jq error); $RUNNERS is unchanged" >&2
  exit 1
}

mv "$TMP" "$RUNNERS" || {
  rm -f "$TMP"
  echo "runners-edit: move failed; $RUNNERS is unchanged" >&2
  exit 1
}
TMP=""
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `cd apps/cmux-team-dispatch-task && bash test/test-runners-edit.sh`
Expected: `--- all tests passed ---`（RE9e は `--show` / `--get` の半分だけで PASS）。

- [ ] **Step 5: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/runners-edit.sh \
        apps/cmux-team-dispatch-task/test/test-runners-edit.sh
git commit -m "feat(cmux-team-dispatch-task): runners-edit.sh の原子的な書き込みパスを実装する"
```

---

### Task 3: `--dry-run`

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/runners-edit.sh`
- Modify: `apps/cmux-team-dispatch-task/test/test-runners-edit.sh`（RE18 / RE18b と RE9e を追加）

**Interfaces:**
- Consumes: Task 2 の `$WRITE_FILTER` / `$JQ_ARGS` / `$NAME` / `$DOC`
- Produces: `--dry-run` が適用後の**当該レコードだけ**を stdout へ出し、ファイルを変更しない。
  S6 のプレビューがこれを唯一の after 生成手段として使う。

- [ ] **Step 1: `--dry-run` のテストを追加する（失敗する）**

Task 2 でコメントアウトした **RE9e の `--dry-run` 3 行**と、Task 2 で保留した
**RE15 の `--dry-run` 1 行**（`mixed.json` に対する `--set plan_effort=max --dry-run`）を戻し、
さらに次を `if [[ $fail -eq 0 ]]` の直前へ挿入する（各ブロックは `reset_registry` から
始まるので順序には依存しない）。

```bash
# ---- RE18 / RE18b: --dry-run ----
reset_registry
cp "$R" "$TMP/expect.json"
re18_pass=1
out=$(bash "$EDIT" --runners "$R" --name cc --set plan_effort=high --dry-run 2>/dev/null); rc=$?
[[ $rc -eq 0 ]] || re18_pass=0
cmp -s "$R" "$TMP/expect.json" || re18_pass=0            # ファイルを変更しない
[[ "$(jq -r '.name' <<<"$out")" == cc ]] || re18_pass=0  # レコード単体を出す
[[ "$(jq -r '.plan_effort' <<<"$out")" == high ]] || re18_pass=0
no_residue || re18_pass=0
[[ "$(run_rc --runners "$R" --name cc --show --dry-run)" == 2 ]] || re18_pass=0
[[ "$(run_rc --runners "$R" --name cc --get plan_model --dry-run)" == 2 ]] || re18_pass=0
[[ "$(run_rc --runners "$TMP/none2.json" --name cc --set plan_effort=high --dry-run)" == 2 ]] || re18_pass=0
if [[ $re18_pass == 1 ]]; then ok 'RE18: --dry-run は書き込まずレコード単体を出す'; else bad 'RE18'; fi

# RE18b: dry-run の出力 == 同一引数の実書き込み結果。
# フィクスチャは claude runner（codex には max が無く effort allowlist で落ちるため）。
# 現在値 (max) と --set の値 (high) を必ず違えて、恒真になるのを防ぐ。
reset_registry
re18b_pass=1
dry=$(bash "$EDIT" --runners "$R" --name cc \
        --set plan_effort=high --unset exec_model --dry-run 2>/dev/null) || re18b_pass=0
bash "$EDIT" --runners "$R" --name cc \
  --set plan_effort=high --unset exec_model >/dev/null 2>&1 || re18b_pass=0
real=$(bash "$EDIT" --runners "$R" --name cc --show 2>/dev/null)
[[ "$(jq -S . <<<"$dry")" == "$(jq -S . <<<"$real")" ]] || re18b_pass=0
# 正のコントロール: 実際に変わっていること
[[ "$(jq -r '.plan_effort' <<<"$dry")" == high ]] || re18b_pass=0
[[ "$(jq -r 'has("exec_model")' <<<"$dry")" == false ]] || re18b_pass=0
if [[ $re18b_pass == 1 ]]; then ok 'RE18b: dry-run 出力が実書き込み結果と一致する'; else bad 'RE18b'; fi
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `cd apps/cmux-team-dispatch-task && bash test/test-runners-edit.sh`
Expected: **RE15 / RE9e / RE18 / RE18b の 4 件**が FAIL（`--dry-run not implemented yet`）。

- [ ] **Step 3: `--dry-run` を実装する**

`runners-edit.sh` の

```bash
if [[ "$DRY_RUN" -eq 1 ]]; then
  # 書き込みは Task 3 で実装する。
  echo 'runners-edit: --dry-run not implemented yet' >&2
  exit 1
fi
```

を次で置き換える。

```bash
if [[ "$DRY_RUN" -eq 1 ]]; then
  # mktemp を経由しない。経由すると書き込み権限の無いレジストリでプレビューが失敗し、
  # S6 が確認質問へ進めなくなる。出すのは当該レコードだけ (--show --name と対称) で、
  # 呼び出し側が jq でレコードを抜く必要を無くしている。
  if ! jq ${JQ_ARGS[@]+"${JQ_ARGS[@]}"} --arg n "$NAME" \
    "$WRITE_FILTER | .runners[] | select((type == \"object\") and .name == \$n)" \
    <<<"$DOC"; then
    echo "runners-edit: dry-run failed (jq error)" >&2
    exit 1
  fi
  exit 0
fi
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `cd apps/cmux-team-dispatch-task && bash test/test-runners-edit.sh`
Expected: `--- all tests passed ---` で exit 0。

- [ ] **Step 5: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/runners-edit.sh \
        apps/cmux-team-dispatch-task/test/test-runners-edit.sh
git commit -m "feat(cmux-team-dispatch-task): runners-edit.sh に --dry-run を追加する"
```

---

### Task 4: `setup-mode.md` / `setup-mode-ja.md` と SU10-SU12 / SU14-SU16

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/setup-mode.md`
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/setup-mode-ja.md`
- Modify: `apps/cmux-team-dispatch-task/test/test-setup-skill.sh`

**Interfaces:**
- Consumes: Task 1-3 の `runners-edit.sh`（usage 出力の 7 フラグ）
- Produces: `--setup` の runtime SoT。Task 5 の SKILL.md / guide-ja.md がこれを参照する。

**このタスクの内容は spec §2（フロー）・§3（同期表・3.0.1 の逐語文字列・3.1 の改題と I/F 段落）・
§4.2（SU10-SU16）に完全に書かれている。逐語で固定された文字列は spec からコピーすること。**

- [ ] **Step 1: SU10-SU12 / SU14-SU16 を書く（失敗する）**

`test/test-setup-skill.sh` を編集する。

1. 冒頭の不変条件コメント（現在 SU1-SU9 の 9 行）に SU10-SU16 の 7 行を足す。
   SU13 は Task 5 Step 1 で初めて実装されるので、この時点ではコメントだけが 1 タスク分先行する。
   `test-runners-edit.sh` が RE1-RE20 のコメントを持つ形で新規作成されるのと対称にする。

2. 冒頭の必須ファイルリスト（現在 5 ファイル）に `runners-edit.sh` を足す。

```bash
EDIT="$SK/scripts/config-edit.sh"
REDIT="$SK/scripts/runners-edit.sh"
...
for f in "$SKILL" "$SETUP_EN" "$SETUP_JA" "$GUIDE" "$EDIT" "$REDIT"; do
  [[ -f "$f" ]] || { echo "FAIL: 必須ファイルが無い: $f"; exit 2; }
done
```

3. SU9 の直後（`if [[ $fail -eq 0 ]]` の直前）に次を挿入する。

```bash
# 平坦化テキスト。長い needle は doc の折り返しをまたぐので生ファイルでは一致しない。
# 行・行番号を要するアサーション（SU12 / SU14 逆方向 / SU15 の #### / SU16 の行順）だけは
# 生ファイルを使う。
ja_flat=$(tr '\n' ' ' < "$SETUP_JA" | tr -s ' ')

need_flat() {
  local hay="$1" label="$2"; shift 2
  local needle miss=0
  for needle in "$@"; do
    grep -Fq -- "$needle" <<<"$hay" || { echo "  missing: $needle"; miss=1; }
  done
  if [[ $miss -eq 0 ]]; then ok "$label"; else bad "$label"; fi
}

# SU10
need_flat "$en_flat" 'SU10: setup-mode.md が S3-M と選択肢生成規則を記載する' \
  'S3-M' \
  'plan_model' 'review_model' 'exec_model' 'plan_effort' 'review_effort' 'exec_effort' \
  "edit an existing runner's models and efforts" \
  'keep (' 'back to the default (' \
  'unset (not review-capable)' 'unset it (not review-capable)' \
  'no longer be chosen as the reviewer' \
  'it is the current review_runner' 'contains a single quote' \
  'gpt-5.6-sol' 'the role keys only' 'pick option 2 or 3 to reach them' \
  'mkdir -p .dispatch' 'shadows the global layer' \
  '[[:cntrl:]]' 'padded with whitespace' 'only through option 2'

# SU11
need_flat "$en_flat" 'SU11: setup-mode.md が runners-edit.sh の契約を記載する' \
  'runners-edit.sh' 'mktemp "$RUNNERS.XXXXXX"' \
  'exits 2 when the file is absent' 'First-run setup' \
  'runners-edit.sh takes --runners and --name, then one of --set / --unset (optionally with --dry-run), --get, or --show.' \
  'last-write-wins' 'replaces a symlink with a regular file'
# 改題そのもの。needle は I/F 段落が持つので、改題の有無とは独立してしまう。
su11h_pass=1
grep -Fq -- '## All field-level writes go through the edit scripts' "$SETUP_EN" \
  || { echo '  EN の改題後の見出しが無い'; su11h_pass=0; }
grep -Fq -- '## All writes go through `config-edit.sh`' "$SETUP_EN" \
  && { echo '  EN に旧見出しが残っている'; su11h_pass=0; }
if [[ $su11h_pass == 1 ]]; then ok 'SU11: setup-mode.md が改題されている'; else bad 'SU11: 改題'; fi

# SU12: codex の候補プール行に max が無い（正アンカー + 負アサーション + 正のコントロール）
CLAUDE_POOL='| claude `*_effort` | `max` / `xhigh` / `high` / `medium` / `low` |'
CODEX_POOL='| codex `*_effort` | `xhigh` / `high` / `medium` / `low` / `minimal` |'
su12_pass=1
for f in "$SETUP_EN" "$SETUP_JA"; do
  if [[ ! -r "$f" ]]; then echo "  unreadable: $f"; su12_pass=0; continue; fi
  n_codex=$(grep -Fc -- "$CODEX_POOL" "$f"); rc=$?
  if [[ $rc -ge 2 ]]; then echo "  grep error on $f"; su12_pass=0; continue; fi
  [[ "$n_codex" == 1 ]] || { echo "  codex pool row count=$n_codex in $(basename "$f")"; su12_pass=0; }
  grep -F -- "$CODEX_POOL" "$f" | grep -Fq -- 'max' && { echo "  max leaked into the codex pool row in $(basename "$f")"; su12_pass=0; }
  n_claude=$(grep -Fc -- "$CLAUDE_POOL" "$f"); rc=$?
  if [[ $rc -ge 2 ]]; then echo "  grep error on $f"; su12_pass=0; continue; fi
  [[ "$n_claude" == 1 ]] || { echo "  claude pool row count=$n_claude in $(basename "$f")"; su12_pass=0; }
  grep -F -- "$CLAUDE_POOL" "$f" | grep -Fq -- 'max' || { echo "  claude pool row lost max in $(basename "$f")"; su12_pass=0; }
done
if [[ $su12_pass == 1 ]]; then ok 'SU12: codex の候補プール行に max が無い（claude 行は max を持つ）'; else bad 'SU12'; fi

# SU14: runners-edit.sh が動き、usage の 7 フラグと doc の記述が双方向で一致する
su14_pass=1
[[ -x "$REDIT" ]] || { echo '  runners-edit.sh に実行ビットが無い'; su14_pass=0; }
usage=$(bash "$REDIT" 2>&1); rc=$?
[[ $rc -eq 2 ]] || { echo "  usage rc=$rc"; su14_pass=0; }
grep -q 'Usage: runners-edit.sh' <<<"$usage" || { echo '  usage 行が無い'; su14_pass=0; }
# 部分一致だと単数形タイポ --runner が --runners に当たって生存するので語境界を要求する
# 語境界が必須。--set は --setup に食われ（setup-mode.md に --setup が既に 7 箇所ある）、
# --runner は --runners に食われる。
for fl in --runners --name --set --unset --get --show --dry-run; do
  grep -Eq -- "(^|[^a-z-])${fl}([^a-z-]|\$)" <<<"$usage" || { echo "  usage に $fl が無い"; su14_pass=0; }
  grep -Eq -- "(^|[^a-z-])${fl}([^a-z-]|\$)" "$SETUP_EN" || { echo "  setup-mode.md に $fl が無い"; su14_pass=0; }
done
# 逆方向: code fence の内側にある runners-edit.sh 実行行（と \ 継続行）に、
# usage に無いフラグが現れない。fence の外（散文の対比行）は対象にしない
# — §3.1 は runners-edit.sh の I/F 段落を config-edit.sh の本文の後ろへ追記させるので、
#   「runners-edit.sh takes --runners where config-edit.sh takes --config」のような
#   対比行が書かれやすく、ファイル全体を走査すると正しい doc が誤 FAIL する。
doc_flags=$(awk '
  /^[[:space:]]*```/ { fence = !fence; inln = 0; next }
  !fence { next }
  /runners-edit\.sh/ { inln = 1 }
  inln { print }
  inln && !/\\$/ { inln = 0 }
' "$SETUP_EN" | grep -o -- '--[a-z][a-z-]*' | sort -u)
if [[ -z "$doc_flags" ]]; then
  echo '  code block 内に runners-edit.sh の実行行が無い（fail-open 禁止）'
  su14_pass=0
fi
for fl in $doc_flags; do
  grep -Eq -- "(^|[^a-z-])${fl}([^a-z-]|\$)" <<<"$usage" \
    || { echo "  doc の $fl が usage に無い"; su14_pass=0; }
done
if [[ $su14_pass == 1 ]]; then ok 'SU14: runners-edit.sh の usage と doc の I/F が双方向で一致'; else bad 'SU14'; fi

# SU15
need_flat "$ja_flat" 'SU15: setup-mode-ja.md が S3-M の日本語 needle を持つ' \
  'S3-M' \
  'plan_model' 'review_model' 'exec_model' 'plan_effort' 'review_effort' 'exec_effort' \
  '登録済み runner の model / effort を編集' \
  '変更なし（現在:' '既定に戻す（' \
  '未設定（レビュアーに選べません）' '未設定に戻す（レビュアーに選べません）' \
  'レビュアーに選べなくなります' \
  '現在の review_runner なので' "名前に ' を含むため" \
  'gpt-5.6-sol' '役割キーのみ' '2 か 3 を選ぶと到達できます' \
  'mkdir -p .dispatch' 'グローバルより優先されることをユーザーに伝える' \
  '選択肢 2 経由のみ' '選択肢 1 / 3 の First-run setup は値を検証しない' \
  '前後に空白' 'runners-edit.sh' 'mktemp "$RUNNERS.XXXXXX"' \
  'symlink は通常ファイルに置き換わり'

# 改題そのもの（EN と対称）
su15h2_pass=1
grep -Fq -- '## フィールド単位の書き込みは全て edit スクリプトを通す' "$SETUP_JA" \
  || { echo '  JA の改題後の見出しが無い'; su15h2_pass=0; }
grep -Fq -- '## 書き込みは全て `config-edit.sh` を通す' "$SETUP_JA" \
  && { echo '  JA に旧見出しが残っている'; su15h2_pass=0; }
if [[ $su15h2_pass == 1 ]]; then ok 'SU15: setup-mode-ja.md が改題されている'; else bad 'SU15: 改題'; fi

# SU15 の #### 検査（生ファイル）: 個数一致 / 6 個以上 / 8 見出しが同順
su15h_pass=1
en_h4=$(grep -c '^#### ' "$SETUP_EN")
ja_h4=$(grep -c '^#### ' "$SETUP_JA")
[[ "$en_h4" == "$ja_h4" ]] || { echo "  #### 個数 en=$en_h4 ja=$ja_h4"; su15h_pass=0; }
[[ "$en_h4" -ge 6 ]] || { echo "  #### が $en_h4 個しかない"; su15h_pass=0; }
check_order() {
  local file="$1"; shift
  local prev=0 ln
  for h in "$@"; do
    ln=$(grep -Fn -- "$h" "$file" | head -1 | cut -d: -f1)
    [[ -n "$ln" ]] || { echo "  見出しが無い: $h"; return 1; }
    [[ "$ln" -gt "$prev" ]] || { echo "  見出しの順序が違う: $h"; return 1; }
    prev="$ln"
  done
  return 0
}
check_order "$SETUP_EN" \
  '#### M1. Which runner' \
  '#### M2. Three model questions in one call' \
  '#### M3. Three effort questions in one call' \
  '#### Why by dimension rather than by role' \
  '#### Building the options' \
  '#### Deriving the codex model candidates' \
  '#### Warning when a codex review_model is unset' \
  '#### Free-text answers' || su15h_pass=0
check_order "$SETUP_JA" \
  '#### M1. どの runner か' \
  '#### M2. model 3 問（1 コール）' \
  '#### M3. effort 3 問（1 コール）' \
  '#### 役割単位ではなく次元単位にした理由' \
  '#### 選択肢の組み立て' \
  '#### codex model 候補の導出' \
  '#### codex review_model を unset するときの警告' \
  '#### 自由入力の扱い' || su15h_pass=0
if [[ $su15h_pass == 1 ]]; then ok 'SU15: #### が英日で同数・6 個以上・同順'; else bad 'SU15: #### 構造'; fi

# SU16: S7 の温存 3 文（平坦化）と S7 節内の呼び出し順（生ファイル）
need_flat "$en_flat" 'SU16: setup-mode.md が S7 の温存 3 文を保つ' \
  'so the whole result lands in a single atomic move.' \
  'For the project destination, `mkdir -p .dispatch` first.' \
  'tell the user it now shadows the global layer'
need_flat "$ja_flat" 'SU16: setup-mode-ja.md が S7 の温存 3 文を保つ' \
  '結果全体が単一の mv で反映されるようにする。' \
  'プロジェクト宛なら先に `mkdir -p .dispatch` する。' \
  'このリポジトリではグローバルより優先されることをユーザーに伝える。'

su16o_pass=1
# awk は `### S7.` から次の `## ` までを取る。現物は直後が `## R:` なので巻き込まない。
check_s7_order() {
  local file="$1" head="$2" s7 r c
  s7=$(awk -v h="$head" 'index($0, h) == 1 {f=1} f && /^## / && index($0, h) != 1 {exit} f' "$file")
  r=$(grep -n 'runners-edit\.sh' <<<"$s7" | head -1 | cut -d: -f1)
  c=$(grep -n 'config-edit\.sh' <<<"$s7" | head -1 | cut -d: -f1)
  [[ -n "$r" && -n "$c" && "$r" -lt "$c" ]]
}
check_s7_order "$SETUP_EN" '### S7.' || { echo '  setup-mode.md の S7 で runners-edit が先に来ていない'; su16o_pass=0; }
check_s7_order "$SETUP_JA" '### S7.' || { echo '  setup-mode-ja.md の S7 で runners-edit が先に来ていない'; su16o_pass=0; }
if [[ $su16o_pass == 1 ]]; then ok 'SU16: S7 節内で runners-edit.sh が config-edit.sh より前'; else bad 'SU16: S7 の順序'; fi
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `cd apps/cmux-team-dispatch-task && bash test/test-setup-skill.sh`
Expected: SU10 / SU11 / SU12 / SU14 / SU15 が FAIL。SU1-SU9 は PASS のまま。
**SU16 は 3 ラベルに分かれており、温存 3 文の 2 ラベル（EN / JA）は改訂前の現物で
既に PASS する**（保護テストなので正しい）。赤くなるのは「S7 節内で runners-edit.sh が
config-edit.sh より前」の 1 ラベルだけ。ここを誤診しないこと。

- [ ] **Step 3: `setup-mode.md` を改訂する**

spec §2.1 / §2.2 / §2.3 / §2.4 / §2.5 / §2.6 と §3.0.1 / §3.1 のとおりに書く。**要点**:

1. **`### S1. Show the current state`** — レジストリ表示を転置形（1 runner = 見出し 1 行 + 表 5 行）へ。
   未設定は `default (<value>)`。codex model 未設定は `unset (codex-side default)` /
   `unset (not review-capable)`。5 件超は優先集合 + 1 行要約
   `- <name> (<engine>): models <plan>/<review>/<exec>, efforts <plan>/<review>/<exec>`。
   engine が `claude` / `codex` でない runner は全セル `-` + `unusable engine — cannot be edited here`。
   元データは `runners-edit.sh --show`。
2. **`### S2. Ask call ① — 2 questions`** — Q2 の 3 ラベルを
   `the role keys only`（description に `per-role models and efforts live in the registry; pick option 2 or 3 to reach them`）/
   `the runner registry (models and efforts included)` /
   `both — the role keys and the registry (models and efforts included)` へ。
3. **``### S3. `runners.json` (only when it is a target)``** — 4 択
   （`add a runner` / `edit an existing runner's models and efforts` /
   `rebuild the registry from scratch` / `leave it alone`）と到達不能リスト
   （S2 選択肢 1 / ファイル不在 / `--show` が非 0 / 選択肢 1・3 の後 / `runners[]` が空 /
   選択可能 runner が 1 件なら M1 を出さず採用 / engine 不明・`'` 入り name の除外 / 1 回 1 件）。
4. **`### S3-M. Edit a runner's models and efforts`（新設）** — 下位見出しは §3.0.1 (2) の
   EN 8 個をその順で。規則 1（4 形）/ 規則 2 / 規則 3（4 行の表）/ 規則 4、候補プール表
   （**`claude *_effort` と `codex *_effort` の 2 行は spec §2.4 から 1 バイト単位でコピー**）、
   codex 候補導出 step 1-4、3 段防御 (b)(c)、自由入力の扱い、警告文言の EN 6 種。
   - **拒否条件は 5 つすべて書く**: 空 / 空白のみ / **前後に空白を持つ値** /
     5 つのシェルメタ文字 / `[[:cntrl:]]`。**内部の空白は通る**（`opus 1m` は受理される）。
     これを落とすと S3-M の "Other" 事前チェックが `  fable` を通し、S6 の `--dry-run` が
     exit 2 でプレビュー生成が落ちる、という **doc に書かれていない失敗経路**が開く。
   - **§3.0.1 (1) の EN 限定句を逐語で**添える。
   - **spec §2.4 の選択肢生成例 4 つには日本語の括弧説明が付いている。** 丸写しすると
     `japanese-in-english-doc` に当たるので、`setup-mode.md` へ写すときは括弧内も英語にする
     （Step 5 の `check-doc-lang` で必ず捕まるが、往復を減らすためここで潰す）。
5. **`### S6. Preview and confirm`** — 2 ファイル分。before は `--show --name`、after は
   同じ `--set` / `--unset` 群 + `--dry-run`。警告リストのラベルは `Warnings:` ↔ `警告:`。
   **これはユーザーへ提示するラベルであって markdown 見出しではない。** 見出し化すると
   SU8 の見出し数が変わる（片方だけなら 19/20 で即赤、英日そろえても 20/20 で釣り合って
   しまい「S3-M を足して 19 個ずつ」という意図が崩れる）。危険なのは見出し化そのもの。
5b. **doc にも書く指示 2 つ** — §2.1 の「閾値 5 は M1 の『5 件以上なら先頭 4 件』とは
   別の数え方である」と、§2.4 の「選択肢は必ず 2 つ以上になる」（床の根拠 1 文）。
   どちらも spec が明示的に「doc にも書く」と指示しているが、ゲートは見ない。
6. **`### S7. Write`** — **既存散文を消さずに** `runners-edit.sh` の手順を 1 番目へ挿入。
   温存 3 文（spec §2.6 の表）を逐語で残す。**S7 節内で `runners-edit.sh` が
   `config-edit.sh` より前に現れること**（SU16）。2 ファイル非トランザクションと
   両方向の復旧案内、単一引用の規約と `'` の前提。
7. **`## All writes go through \`config-edit.sh\`` → `## All field-level writes go through the edit scripts`** —
   **既存本文（49-61 行）は 1 文字も消さない**。その後ろに限定文と `runners-edit.sh` の
   I/F 段落を追記する。段落には次を**逐語で**含める。
   - `runners-edit.sh takes --runners and --name, then one of --set / --unset (optionally with --dry-run), --get, or --show.`
     （7 フラグを 1 文に集約する。`--set` / `--unset` / `--get` / `--show` は既存の
     `config-edit.sh` 例文にも現れるので、個別 grep では「I/F 段落から落ちたが他所に在る」
     を検出できない）
   - `mktemp "$RUNNERS.XXXXXX"` / exit 0/1/2 の意味 / 置換ではなくマージすること
   - `exits 2 when the file is absent` と `First-run setup`
   - **spec §1.4 が「文書化のみ」と決めた 3 挙動**を逐語 1 文で:
     `The write is last-write-wins, replaces a symlink with a regular file, and leaves the temp file's mode on the result.`
     （文書化が唯一の緩和策なので、書かれなければ緩和策が存在しないのと同じ）
   - **`runners-edit.sh` の実行例を ```` ```bash ```` フェンスで最低 1 つ置く**
     （SU14 の逆方向は fence 内の実行行だけを見るので、散文だけだと抽出 0 件になり
     fail-open ガードで FAIL する。現物の S7 はフェンスを 1 つも持たない散文である）。
   - **`runners-edit.sh` を含む行に `--config` を書かない。** 2 スクリプトを対比するなら
     行を分ける。SU14 の逆方向は code fence の内側だけを見るので散文の対比は安全だが、
     fence 内で 1 行に混ぜると誤 FAIL する。
   - **逐語 needle を含む文は 1 行に収め、行頭マーカーを挟まない。** SU10 / SU11 / SU15 /
     SU16 は `tr '\n' ' '` の平坦化テキストを grep するので、blockquote の `> ` や
     箇条書きの `- ` が needle の内側に落ちると一致しない。特に
     `exits 2 when the file is absent` を blockquote で折り返さないこと。

- [ ] **Step 4: `setup-mode-ja.md` を同一構造で改訂する**

英語版と **H1-H3 の見出し数を一致**させ（`### S3-M. runner の model / effort を編集する`
を足して 19 個ずつ）、`####` も §3.0.1 (2) の JA 8 個を同順で置く。
ユーザー可視文字列は spec §2 の JA 表記。**括弧は全角。**

**Step 3 の項目 1-7 すべてに JA 側の対応がある。とくに次の 4 つは
どのゲートも捕まえないので明示的に消化すること。**

1. **項目 7 の JA 版（最重要）** — `## 書き込みは全て \`config-edit.sh\` を通す`
   （`setup-mode-ja.md:39`）を **`## フィールド単位の書き込みは全て edit スクリプトを通す`**
   へ改題し、**既存本文（41-48 行）は 1 文字も消さず**、その後ろに §3.1 の限定文と
   `runners-edit.sh` の I/F 段落（7 フラグを 1 文に集約したもの /
   `mktemp "$RUNNERS.XXXXXX"` / exit 0/1/2 / マージ / ファイル不在は exit 2 /
   First-run setup）の訳を追記する。
   **§1.4 が「文書化のみ」と決めた 3 挙動の 1 文も訳す**（EN 側と同じく、文書化が唯一の
   緩和策なので、書かれなければ緩和策が存在しないのと同じ）。逐語:
   `書き込みは last-write-wins で、symlink は通常ファイルに置き換わり、temp の mode が結果に残る。`
   実行例は ```` ```bash ```` フェンスに入れる。
   **SU8 は見出し数しか見ないので片方だけ改題しても 19/19 で緑になる。**
   これを落とすと、`runners-edit.sh` 導入後に**偽になる見出し**が残り、
   spec §3.1 が 20 行かけて警告した「First-run setup を `runners-edit.sh` に寄せて
   exit 2 のデッドロックになる」誤読を招く。**改題そのものを守るのは SU15 の
   「新見出しが存在し旧見出しが存在しない」アサーション**であって、
   `runners-edit.sh` / `mktemp "$RUNNERS.XXXXXX"` の needle ではない
   （これらは I/F 段落が持つので改題の有無と独立している）。
2. **§3.0.1 (1) の JA 逐語文** — S3-M の「自由入力の扱い」に
   **`この拒否は S3 の選択肢 2 経由のみに適用される。選択肢 1 / 3 の First-run setup は値を検証しない。`**
   をそのまま書く。**SU15 は 2 文とも needle にしている**ので、どちらが落ちても赤くなる。
   これは spec §1.3.1「既知の限界（重要）」が最も強く要求した限定句の JA 側の担保である。
   拒否条件そのもの（空 / 空白のみ / **前後に空白** / 5 メタ文字 / `[[:cntrl:]]`、
   内部の空白は通る）も EN 側と同じ内訳で書く。
3. **候補プール表の 2 行は英語版とバイト単位で同一**にする（SU12 のアンカー）。
   **表のヘッダ（`| target | pool |`）と `codex *_model` セル
   （`see the codex candidate derivation below`）も英語のまま**にする。
   識別子であり、SU12 は 2 行しか見ないので訳すと英日で表の形が割れる。
4. **S7 節（`### S7. 書き込み`）** — 温存 3 文（spec §2.6 の JA 列）を逐語で残し、
   `runners-edit.sh` の手順を 1 番目に挿入する（SU16 の行順）。実行例は ```` ```bash ````
   フェンスに入れる。
5. **S1 転置表のヘッダと見出し行は訳さない。** spec §2.1 は
   `| role | model | effort |` と `runner: <name> (command: <command>, engine: <engine>)`、
   および 1 行要約の `models` / `efforts` / `-` を「**識別子なので英日とも ASCII のまま**
   （§2.4 の候補プール表と同じ扱い）」と明記している。日本語化するのは
   `default (<value>)` ↔ `既定（<値>）` のような**状態ラベル**だけ。
   SU12 は候補プール 2 行しか見ず、SU15 は S1 ヘッダを needle に持たず、
   `check-doc-lang` は `*-ja.md` を `empty-translation` でしか見ないので、
   **どのゲートも捕まえない。**
6. **逐語 needle を含む文は 1 行に収め、行頭マーカーを挟まない**（Step 3-7 の EN 側と同じ）。
   SU15 の長い JA needle（`グローバルより優先されることをユーザーに伝える` /
   `選択肢 1 / 3 の First-run setup は値を検証しない`）が対象。

- [ ] **Step 5: テストが通ることを確認する**

Run: `cd apps/cmux-team-dispatch-task && bash test/test-setup-skill.sh`
Expected: **SU1-SU12 / SU14-SU16** がすべて PASS（`--- all tests passed ---`）。
**SU13 はこの時点でまだ存在しない** — Task 5 Step 1 で追加する。

Run: `cd $(git rev-parse --show-toplevel) && node scripts/check-doc-lang.mjs apps/cmux-team-dispatch-task`
Expected: OK（`setup-mode.md` に日本語が 1 文字も無いこと）。

- [ ] **Step 6: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/setup-mode.md \
        apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/setup-mode-ja.md \
        apps/cmux-team-dispatch-task/test/test-setup-skill.sh
git commit -m "feat(cmux-team-dispatch-task): --setup に役割別 model/effort の編集フロー S3-M を追加する"
```

---

### Task 5: 4 ファイル整合（SKILL.md / guide-ja.md / README.md / CLAUDE.md）と SU13

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md`
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md`
- Modify: `apps/cmux-team-dispatch-task/README.md`
- Modify: `apps/cmux-team-dispatch-task/CLAUDE.md`
- Modify: `apps/cmux-team-dispatch-task/test/test-setup-skill.sh`（SU13）

**Interfaces:**
- Consumes: Task 4 の `setup-mode.md` / `setup-mode-ja.md`
- Produces: 4 ファイル整合。以降のタスクは検証のみ。

**変更箇所は spec §3 の同期表が SoT。** 表の全行を消化すること。

- [ ] **Step 1: SU13 を書く（失敗する）**

`test/test-setup-skill.sh` の SU12 の直後に挿入する。

```bash
# SU13
su13_pass=1
grep -Fq -- 'runners-edit.sh' "$SKILL" || { echo '  SKILL.md が runners-edit.sh を名指ししていない'; su13_pass=0; }
grep -Fq -- 'runners-edit.sh' "$GUIDE" || { echo '  guide-ja.md が runners-edit.sh を名指ししていない'; su13_pass=0; }
# --override が runners-edit.sh も呼ばない旨。CLAUDE.md 項目 44 は人手チェックリストなので、
# ここが唯一の機械的担保になる。
skill_flat2=$(tr '\n' ' ' < "$SKILL" | tr -s ' ')
guide_flat2=$(tr '\n' ' ' < "$GUIDE" | tr -s ' ')
grep -Fq -- 'Never call `config-edit.sh` or `runners-edit.sh` here.' <<<"$skill_flat2" \
  || { echo '  SKILL.md の --override が runners-edit.sh に触れていない'; su13_pass=0; }
grep -Fq -- '`config-edit.sh` と `runners-edit.sh` はここでは絶対に呼ばない。' <<<"$guide_flat2" \
  || { echo '  guide-ja.md の --override が runners-edit.sh に触れていない'; su13_pass=0; }
README="$SCRIPT_DIR/../README.md"
readme_flat=$(tr '\n' ' ' < "$README" | tr -s ' ')
grep -Fq -- 'config にも `runners.json` にも一切書き戻しません。' <<<"$readme_flat" \
  || { echo '  README.md の --override が runners.json に触れていない'; su13_pass=0; }
if [[ $su13_pass == 1 ]]; then ok 'SU13: SKILL.md / guide-ja.md / README.md が両スクリプトを名指しする'; else bad 'SU13'; fi
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `cd apps/cmux-team-dispatch-task && bash test/test-setup-skill.sh`
Expected: SU13 が FAIL、他は PASS。

- [ ] **Step 3: `SKILL.md` を更新する（4 箇所。英語のみ）**

1. `## Setup Mode (explicit configuration)` — 「役割キーと runners.json レジストリを歩く」の
   説明に「per-role models and efforts」も設定できる旨を 1 文足し、**`runners-edit.sh` を
   名指しする**（SU13 のアンカー）。
2. ``Both modes write exclusively through `scripts/config-edit.sh`,`` の 1 文 —
   spec §3.1 の限定へ。`--reset runners` はどちらのスクリプトも通らないので、
   無条件の「2 スクリプトを通る」と書かない。**`scripts/config-edit.sh` の逐語は残す**（SU1）。
3. **First-run setup 見出し（433-434 行）** — 現行の
   `(when runners.json does not exist, …, and when --setup selects the registry as a target)`
   は S3 に選択肢 2 が増えると偽になるので、**選択肢 1 / 3 に限る**旨へ改める。
4. **822 行 `Never call config-edit.sh here.`**（`--override`）— **逐語で**
   ``Never call `config-edit.sh` or `runners-edit.sh` here.`` にする（SU13 の needle）。

- [ ] **Step 4: `guide-ja.md` を更新する（5 箇所。日本語）**

1. `## セットアップモード（設定の明示構成）` — SKILL.md 変更の 1:1 訳。
   **`runners-edit.sh` を名指しする**（SU13）。
2. **67 行**（`## リセットモード（設定のリセット）` 配下）「両モードとも書き込みは
   `scripts/config-edit.sh` **だけ**を通す」— `SKILL.md:117` の訳なので同じ限定へ。
   **節名だけを追うと漏れるので注意。**
3. **251 行**「`config-edit.sh` はここでは絶対に呼ばない。」— **逐語で**
   「`config-edit.sh` と `runners-edit.sh` はここでは絶対に呼ばない。」にする（SU13 の needle）。
4. **1363 行 `### 設定（\`--setup\`）`** — `README.md:84-98` の逐語ミラー。README と同じ更新。
5. **1641 行 `### 初回セットアップ`** — 本文の「…または `--setup` で `runners.json` を
   対象に選んだときは、初回セットアップが起動します」を選択肢 1 / 3 限定へ。

- [ ] **Step 5: `README.md` を更新する（3 箇所。日本語）**

1. `### 設定（\`--setup\`）` — 役割別 model / effort を設定できる旨を追記。
2. **286 行** 「どちらも書き込みは `scripts/config-edit.sh` を通し、置換ではなくマージします」
   — spec §3.1 と同じ限定を付ける。
3. **131 行** 「**config には一切書き戻しません。**」（`--override`）— `runners.json` へも
   書き戻さない旨を追加。

- [ ] **Step 6: `CLAUDE.md` を更新する（8 箇所。日本語）**

1. ファイル構成表に `skills/cmux-team-dispatch-task/scripts/runners-edit.sh` の行を追加。
   隣接する 19 行（`config-edit.sh` = 「config.json への唯一の書き込み口」）は真のままなので
   文言を変えない。
2. **23 行**（`runners.json` の行）「`--setup` / `--reset runners` からも**再生成**される」→
   `--setup` はフィールド単位の編集も行う旨へ。
3. **91 行**（role 解決の現行契約、`--override`）「**config へ書き戻さない**
   （`config-edit.sh` を呼ばない）」→ `runners-edit.sh` も追加。
4. **247 行**（保守手順 28）「書き込みは **`scripts/config-edit.sh` だけ**を通す」→
   spec §3.1 と同じ限定へ。「だけ」は追記では消えない。
5. **251 行**（保守手順 28 の回帰行）`SU1-SU9` → **`SU1-SU16`**、
   `bash test/test-runners-edit.sh`（**RE1-RE20。RE9b / RE9c / RE9d / RE9e / RE14a /
   RE14b / RE18b を含む。RE19 は欠番**）を追加。
6. **保守手順 28 本文** — `runners-edit.sh` の契約、SU10-SU16 の needle 一覧、
   **`setup-mode.md` / `setup-mode-ja.md` の両方**が維持する義務 4 つ
   （SU12 のアンカー 2 行を 1 バイト一致で持つ / S7 温存 3 文 / S7 節内の順序 /
   §3.0.1 の限定句 2 文と `####` 8 見出しを逐語・同順で持つ）。
7. **保守手順 44（256-257 行）** — 検査条件を「`config-edit.sh` / `runners-edit.sh` の
   **どちらも**呼び出す記述が無いこと」へ拡張。**257 行の引用例
   「（「Never call `config-edit.sh` here」のように…）」も同時に更新する** —
   Step 3-4 でこの文字列は SKILL.md から消えるので、放置すると stale な引用になる
   （SU13 は CLAUDE.md を読まないので機械的には捕まらない）。末尾に §2.4「次元単位 vs 役割単位」と
   effort 範囲外時の挙動差（`--override` は警告して既定へフォールバック / `--setup` は
   再質問）を**意図的な差**として 1 行。
8. **「テスト方法」E2E 項目 43** — S3-M のケースを追記（S3 の 4 択 → runner 選択 →
   model 3 問 → effort 3 問 → S6 の 2 ファイルプレビュー → S7 の 2 コール）。
   **E2E は 43 の次が 45 で 44 が欠番だが既存の欠番なので触らない。**

**変更しないこと**（spec §3 の「変更不要と確認済み」）: `.codex-plugin/plugin.json` /
ルート `marketplace.json` / `loop-mode*.md` / `unattended/*.md` / `notification-gaps.md` /
`SKILL.md:490` / `guide-ja.md:1494-1497` / `README.md:247-250` / `CLAUDE.md:193` /
`CLAUDE.md:152` / `--reset` の R2 節 / `runners.json` スキーマ節。

- [ ] **Step 7: テストと doc-lang が通ることを確認する**

Run: `cd apps/cmux-team-dispatch-task && bash test/test-setup-skill.sh`
Expected: SU1-SU16 すべて PASS。

Run: `cd $(git rev-parse --show-toplevel) && node scripts/check-doc-lang.mjs apps/cmux-team-dispatch-task`
Expected: OK。

- [ ] **Step 8: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md \
        apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md \
        apps/cmux-team-dispatch-task/README.md \
        apps/cmux-team-dispatch-task/CLAUDE.md \
        apps/cmux-team-dispatch-task/test/test-setup-skill.sh
git commit -m "docs(cmux-team-dispatch-task): S3-M と runners-edit.sh を 4 ファイルへ同期する"
```

---

### Task 6: 全検証ゲートと残骸確認

**Files:** なし（検証のみ。修正が必要なら該当タスクのファイルへ戻る）

**Interfaces:**
- Consumes: Task 1-5 のすべて
- Produces: `gate exit: 0` と `residue: 0`

- [ ] **Step 1: スナップショット → 全スイート → 残骸確認を 1 つの Bash 呼び出しで走らせる**

**3 つに分けてはならない。** `snap()` と `$SNAPDIR` はシェル関数と変数なので、
別々の Bash 呼び出しに分けると後半が `snap: command not found` で
**偽の `residue: 1`** を出す。

```bash
cd "$(git rev-parse --show-toplevel)" || exit 1
SNAPDIR=$(mktemp -d)
snap() {
  git worktree list --porcelain | awk '/^worktree /{print substr($0,10)}' | sort > "$1"
  git branch --list --format='%(refname:short)' | sort > "$2"
}
snap "$SNAPDIR/wt.before" "$SNAPDIR/br.before"

cd "$(git rev-parse --show-toplevel)/apps/cmux-team-dispatch-task" || exit 1
fail=0
for t in test/*.sh; do
  printf '%-46s ' "$t"
  if bash "$t" >/dev/null 2>&1; then echo OK; else echo FAILED; fail=1; fi
done
cd "$(git rev-parse --show-toplevel)" || exit 1
pnpm check || fail=1
echo "gate exit: $fail"

snap "$SNAPDIR/wt.after" "$SNAPDIR/br.after"
residue=0
diff "$SNAPDIR/wt.before" "$SNAPDIR/wt.after" || residue=1
diff "$SNAPDIR/br.before" "$SNAPDIR/br.after" || residue=1
echo "residue: $residue"
[[ $fail -eq 0 && $residue -eq 0 ]]
```

Expected: 全スイート OK、`check-doc-lang` が OK、**`gate exit: 0` かつ `residue: 0`**。
`feat/pg*` / `feat/is*` / `feat/ov*` のような残留ブランチも worktree 登録も
増えていないこと。
`@tanaka-yui/token-meter` の `noNonNullAssertion` 警告 4 件は既知のノイズで失敗ではない。
FAILED が出たら、当該スイートを**リダイレクト無しで再実行**して原因を読む。

- [ ] **Step 2: 未コミットの変更が無いことを確認する**

```bash
cd "$(git rev-parse --show-toplevel)" && git status --porcelain
```

Expected: `.cmux-team-dispatch-task-*` 系の実行時ファイル以外に何も出ないこと。
出たら `git add -A && git commit` する（worktree のクリーンアップで失われるため）。

- [ ] **Step 3: 最終コミット（必要な場合のみ）**

```bash
git add -A
git commit -m "chore(cmux-team-dispatch-task): 検証ゲートの残差を整理する"
```

---

## Self-Review

**1. Spec coverage**

| spec 節 | 実装タスク |
|---|---|
| §1.1 なぜ新規スクリプトか | Task 1（設計判断。コード上はファイル分離として実現） |
| §1.2 インターフェース | Task 1（引数解析）/ Task 3（`--dry-run`） |
| §1.3 検証（field allowlist / model / effort / 構造 / 引数相互作用） | Task 1（RE2 / RE4 / RE11 / RE15）/ Task 2（RE3 / RE17） |
| §1.3.1 deny-list の根拠 | Task 1（`valid_model_value`）+ Task 4（doc の限定句） |
| §1.4 実行順序・9 スニペット・`--arg` 契約・trap・`mv` | Task 1（手順 0-6）/ Task 2（手順 7b-9）/ Task 3（手順 7a） |
| §1.5 不在 / 破損 / 0 バイト | Task 1（RE8 / RE10 / RE13） |
| §2.1 S1 | Task 4 Step 3-1 |
| §2.2 S2 | Task 4 Step 3-2 |
| §2.3 S3 と到達不能リスト | Task 4 Step 3-3 |
| §2.4 S3-M（規則 1-4 / 候補プール / codex 導出 / 3 段防御 / 自由入力 / 警告文言） | Task 4 Step 3-4 |
| §2.5 S6 | Task 4 Step 3-5 |
| §2.6 S7（温存 3 文 / 順序 / 非トランザクション / クォート） | Task 4 Step 3-6 |
| §3 同期表 | Task 4（setup-mode*）/ Task 5（4 ファイル） |
| §3.0.1 逐語文字列 2 種 | Task 4 Step 3-4 / Step 4 |
| §3.1 改題と I/F 段落 | Task 4 Step 3-7 |
| §3.2 言語規則と既存テストの保護 | Task 4 Step 5（check-doc-lang）/ SU1-SU9 が緑のまま |
| §4.1 RE1-RE20 | Task 1 / 2 / 3 |
| §4.2 SU10-SU16 | Task 4（SU10-12 / 14-16）/ Task 5（SU13） |
| §4.3 テストの注意と限界 | Task 5 Step 6-8（E2E 項目 43 への追記） |
| 検証ゲート | Task 6 |

**ギャップなし。**

**2. Placeholder scan**

`TBD` / `TODO` / 「適切に」「必要に応じて」の類は無い。Task 4 / 5 の doc 改訂は
「spec の §番号 + 逐語文字列」で指示しており、書くべき内容はすべて spec 側に確定済みの
文字列として存在する（候補プール 2 行 / 限定句 2 文 / `####` 8 見出し / 警告文言 6 種 /
温存 3 文 / S3 の 4 ラベル / S2 の 3 ラベル / 規則 1 の 4 形 / 規則 3 の 4 行）。

**3. Type consistency**

- スクリプト内の識別子: `known_field` / `is_model_field` / `valid_model_value` /
  `valid_effort_value` / `RUNNERS` / `NAME` / `GET_FIELD` / `SHOW` / `DRY_RUN` /
  `MUTATE` / `FILTER` / `JQ_ARGS` / `SET_FIELDS` / `UNSET_FIELDS` / `EFFORT_CHECKS` /
  `DOC` / `MATCHES` / `ENGINE` / `TMP` / `WRITE_FILTER` — Task 1-3 で一貫。
- テスト内のヘルパー: `bad` / `ok` / `run_rc` / `reset_registry` / `no_residue` /
  `need_flat` / `check_order` / `check_s7_order` — 重複定義なし。
  `test-setup-skill.sh` 側の既存 `need` / `ok` / `bad` / `en_flat` は再利用し、
  `ja_flat` と `need_flat` を新設する。
- CLI フラグ名は spec §1.2 と完全一致（`--runners` / `--name` / `--set` / `--unset` /
  `--get` / `--show` / `--dry-run`）。SU14 の双方向検査がこれを固定する。
