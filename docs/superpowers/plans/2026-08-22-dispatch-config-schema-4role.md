# cmux-team-dispatch-task 設定スキーマ 4 ロール化 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `runners.json` を runner の同一性だけに縮小し、`config.json` へ design / design_review / exec / exec_review の 4 ロール入れ子を導入して、ディスパッチ時の対話的なロール解決を全廃する。

**Architecture:** 設定の読み取りを新スクリプト `config-resolve.sh` に一本化し、書き込みは既存の `config-edit.sh` に集約する。両者は新しい source 専用ヘルパー `config-lib.sh` を共有し、パス解決・値検証・effort 正規化を 1 箇所に置く。`prewarm-panes.sh` はロール値を `--roles <file>`（resolver の出力）1 本で受け取り、`render-loop-prompt.sh` と `loop-cleanup.sh` は `prewarm.json` を唯一の入力にする。

**Tech Stack:** bash 3.2（macOS 標準）/ `jq` / 既存のテストランナーは素の bash スクリプト。ビルドツールなし。

**Spec:** `docs/superpowers/specs/2026-08-22-dispatch-config-schema-design.md`

## Global Constraints

- **破壊的変更**。バージョンは **3.0.0**。`apps/cmux-team-dispatch-task/.claude-plugin/plugin.json`、`apps/cmux-team-dispatch-task/.codex-plugin/plugin.json`、ルート `.claude-plugin/marketplace.json` の 3 箇所を同期する。
- **4 ファイル整合の絶対ルール**: `skills/cmux-team-dispatch-task/SKILL.md` / `skills/cmux-team-dispatch-task/references/guide-ja.md` / `README.md` / `apps/cmux-team-dispatch-task/CLAUDE.md` の機能仕様を完全一致させる。1 つを更新したら残り 3 つも同じ commit で更新する。
- **言語規約**: `SKILL.md` と `references/*.md`（`*-ja.md` を除く）は**英語必須**。`references/guide-ja.md` は SKILL.md と見出し 1:1 の日本語ミラー。`CLAUDE.md` / `README.md` / `docs/**` は日本語。`commands/*.md` は英語で `Respond to the user in Japanese.` の 1 行を持つ。検証は `pnpm check:doc-lang`。
- **SKILL.md の `## Output Language` ブロック**（frontmatter 直後の 3 行）は一字一句そのまま維持する。
- **シェル引用の制約**: 起動コマンドは `zsh -ic "claude ... '<prompt>' ..."` の形で二重に引用され、`launch-workspace.sh` はエスケープしない。`-i` は対話モードなので history 展開が効く。したがってコマンドへ埋まる値に `'` `"` `` ` `` `$` `\` `!` と制御文字を通してはならない。
- **ロール名は 4 つ固定**: `design` / `design_review` / `exec` / `exec_review`。この綴りを config キー・`--role` 値・prewarm.json キー・テスト fixture のすべてで使う。
- **agmsg agent 名**: `<slug>` / `<slug>-design-review` / `<slug>-exec` / `<slug>-exec-review`。
- **effort allowlist**: claude `low|medium|high|xhigh|max`、codex `minimal|low|medium|high|xhigh`（**codex に `max` は無い**）。
- **組込み既定値**: model は claude engine のみ `design`=`opus[1m]` / `design_review`=`opus[1m]` / `exec`=`sonnet` / `exec_review`=`opus[1m]`、codex engine は既定なし。effort は `design`/`design_review`/`exec_review`=`xhigh`、`exec`=`high`。
- **既存テストの互換**: `RUNNERS_CONFIG_PATH` は `runners.json` 個別の override として存続させる（14 テストファイル・延べ 60 箇所が設定している）。`config.json` 用の個別 env var は追加しない。
- **テストの流儀**: `set -uo pipefail`、`bad()` / `ok()` ヘルパー、`mktemp -d` + `trap`、失敗しても即 exit せず `fail=1` を積む。既存 `test/test-config-edit.sh` の書式に揃える。
- **旧契約を encode したテストは意図的に更新する**。通すためにテストを削除しない（対象スクリプトごと削除する場合を除き、その旨を PR 本文に書く）。
- **worktree の外を触らない**。`~/.claude/**` を含む worktree 外のパスへは読み書きしない。ユーザーの実ファイル移行手順は `result.md` に書くだけ。

---

## File Structure

| パス | 区分 | 責務 |
|------|------|------|
| `skills/cmux-team-dispatch-task/scripts/config-lib.sh` | **新規** | source 専用。パス解決（`DISPATCH_CONFIG_HOME` / `RUNNERS_CONFIG_PATH`）、runner 名・model 値の検証、effort の小文字正規化と engine 別 allowlist、ロール名と組込み既定値の表 |
| `skills/cmux-team-dispatch-task/scripts/config-resolve.sh` | **新規** | ロール解決の唯一の読み手。project → global → 既定値を (role, field) 単位で合成し、engine を引き、`--set` を最優先で適用して JSON を 1 つ出す。fail-fast を持つ |
| `skills/cmux-team-dispatch-task/scripts/config-edit.sh` | 改修 | ロール / review 設定の唯一の書き手。入れ子キー、`--engine <role>=<engine>`、旧キーの拒否 |
| `skills/cmux-team-dispatch-task/scripts/runners-edit.sh` | **削除** | 扱っていた 6 フィールドが `runners.json` から出ていくため |
| `skills/cmux-team-dispatch-task/scripts/launch-workspace.sh` | 改修 | runners.json 役割フィールド層を削除、`--role` の値域を 4 ロールへ、review ペインの `--add-dir` を `<STATUS_DIR>/review` へ |
| `skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh` | 改修 | ロール入力を `--roles <file>` 1 本に、2/4 ペインの固定配置、新 prewarm.json スキーマ |
| `skills/cmux-team-dispatch-task/scripts/render-loop-prompt.sh` | 改修 | 入力を `--prewarm <file>` 1 本に、review_mode 不一致の警告 |
| `skills/cmux-team-dispatch-task/scripts/loop-cleanup.sh` | 改修 | prewarm.json 実在ロールの列挙 + workspace 照合 |
| `skills/cmux-team-dispatch-task/scripts/terminal-wait.sh` | 改修 | config.json のパスを `config-lib.sh` から取る |
| `skills/cmux-team-dispatch-task/SKILL.md` | 改修 | Step 1f / 1g / 1g-2、placeholder、prewarm 節、Setup/Reset 委譲 |
| `skills/cmux-team-dispatch-task/references/guide-ja.md` | 改修 | SKILL.md の 1:1 日本語ミラー |
| `skills/cmux-team-dispatch-task/references/setup-mode{,-ja}.md` | 改修 | S2 / S3 再編、S3-M 削除、pending tuple、入口ごとの書き込み契約表 |
| `skills/cmux-team-dispatch-task/references/loop-mode{,-ja}.md` | 改修 | ロール語彙 |
| `skills/cmux-team-dispatch-task/references/unattended/*.md` | 改修 | ブロックの宛先を design_review / exec_review へ |
| `README.md` / `CLAUDE.md`（プラグイン） | 改修 | 公開ドキュメントと開発ガイド |
| `test/test-config-lib.sh` | **新規** | Task 1 |
| `test/test-config-resolve.sh` | **新規** | Task 2 |
| `test/test-roles-input.sh` | **新規** | Task 5 |
| `test/test-pane-invariant.sh` | **新規** | Task 5 |
| `test/test-snapshot-contract.sh` | **新規** | Task 6 |
| `test/test-config-paths.sh` | **新規** | Task 4 |
| `test/test-runners-edit.sh` | **削除** | 対象スクリプトごと削除 |

---

## Task 1: `config-lib.sh`（パスと検証の単一箇所）

**Files:**
- Create: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/config-lib.sh`
- Test: `apps/cmux-team-dispatch-task/test/test-config-lib.sh`

**Interfaces:**
- Consumes: なし（最初のタスク）
- Produces: 以下の関数。以降のすべてのタスクがこの名前と挙動に依存する。

```
dispatch_config_home                      -> stdout: 基準ディレクトリ
dispatch_config_file                      -> stdout: <base>/config.json
dispatch_project_config_file <root>       -> stdout: <root>/.dispatch/config.json
dispatch_runners_file                     -> stdout: RUNNERS_CONFIG_PATH または <base>/runners.json
dispatch_role_names                       -> stdout: 4 ロール名を 1 行ずつ
dispatch_valid_runner_name <v>            -> rc 0 = 妥当 / 1 = 不正
dispatch_valid_model <v>                  -> rc 0 / 1
dispatch_normalize_effort <v>             -> stdout: 小文字化した値
dispatch_valid_effort <effort> <engine>   -> rc 0 / 1（effort は正規化済みを渡す）
dispatch_default_model <role> <engine>    -> stdout: 既定 model（codex は空）
dispatch_default_effort <role>            -> stdout: 既定 effort
dispatch_model_required <role> <engine>   -> rc 0 = 必須 / 1 = 省略可
```

- [ ] **Step 1: 失敗するテストを書く**

`apps/cmux-team-dispatch-task/test/test-config-lib.sh` を作る:

```bash
#!/usr/bin/env bash
# config-lib.sh の単体テスト。
#
# 守っている不変条件:
#   CL1. DISPATCH_CONFIG_HOME の既定値と env による上書き
#   CL2. RUNNERS_CONFIG_PATH が runners.json だけを個別に上書きする
#   CL3. runner 名の検証 (空 / 前後空白 / シェルメタ文字 / 制御文字を拒否)
#   CL4. model 値の検証 (同じ拒否条件。内部空白は許容)
#   CL5. effort の小文字正規化 ("xHigh" -> "xhigh")
#   CL6. effort の engine 別 allowlist (codex に max は無い)
#   CL7. ロール名は 4 つ固定
#   CL8. 組込み既定値の表
#   CL9. model 省略可否の matrix

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/config-lib.sh"
fail=0
bad() { echo "FAIL $1"; fail=1; }
ok() { echo "PASS $1"; }
[[ -f "$LIB" ]] || { echo "FAIL: config-lib.sh が無い: $LIB"; exit 2; }

# shellcheck source=/dev/null
HOME_BAK="${HOME}"
unset DISPATCH_CONFIG_HOME RUNNERS_CONFIG_PATH
source "$LIB"

# CL1: 既定値
if [[ "$(dispatch_config_home)" == "$HOME_BAK/.claude/config/cmux-team-dispatch-task" ]]; then
  ok 'CL1a: DISPATCH_CONFIG_HOME の既定値'
else
  bad "CL1a: 既定値が違う ($(dispatch_config_home))"
fi
if [[ "$(dispatch_config_file)" == "$(dispatch_config_home)/config.json" ]]; then
  ok 'CL1b: config.json のパス'
else
  bad 'CL1b: config.json のパス'
fi
if [[ "$(dispatch_project_config_file /tmp/repo)" == '/tmp/repo/.dispatch/config.json' ]]; then
  ok 'CL1c: project config のパス'
else
  bad 'CL1c: project config のパス'
fi

# CL1d: env による上書き
( export DISPATCH_CONFIG_HOME=/tmp/cfghome
  source "$LIB"
  [[ "$(dispatch_config_file)" == '/tmp/cfghome/config.json' \
  && "$(dispatch_runners_file)" == '/tmp/cfghome/runners.json' ]] ) \
  && ok 'CL1d: DISPATCH_CONFIG_HOME が両ファイルへ効く' \
  || bad 'CL1d: DISPATCH_CONFIG_HOME が効かない'

# CL2: RUNNERS_CONFIG_PATH は runners.json だけを上書きする
( export DISPATCH_CONFIG_HOME=/tmp/cfghome RUNNERS_CONFIG_PATH=/tmp/other/runners.json
  source "$LIB"
  [[ "$(dispatch_runners_file)" == '/tmp/other/runners.json' \
  && "$(dispatch_config_file)" == '/tmp/cfghome/config.json' ]] ) \
  && ok 'CL2: RUNNERS_CONFIG_PATH は runners.json だけを上書きする' \
  || bad 'CL2: RUNNERS_CONFIG_PATH の作用範囲'

# CL3 / CL4: runner 名と model の拒否条件
reject_cases=( '' ' lead' 'trail ' "quo'te" 'dou"ble' 'back`tick' 'dol$lar' 'back\slash' )
for v in "${reject_cases[@]}"; do
  dispatch_valid_runner_name "$v" && bad "CL3: runner 名 '$v' を受理した"
  dispatch_valid_model "$v" && bad "CL4: model '$v' を受理した"
done
printf -v ctrl 'a\tb'
dispatch_valid_runner_name "$ctrl" && bad 'CL3: 制御文字を含む runner 名を受理した'
dispatch_valid_model "$ctrl" && bad 'CL4: 制御文字を含む model を受理した'
dispatch_valid_runner_name 'ccf' && ok 'CL3: 正常な runner 名を受理する' || bad 'CL3: 正常値を拒否した'
dispatch_valid_model 'opus[1m]' && ok 'CL4a: opus[1m] を受理する' || bad 'CL4a'
dispatch_valid_model 'gpt 5 sol' && ok 'CL4b: 内部空白は許容する' || bad 'CL4b: 内部空白を拒否した'

# CL5: effort の正規化
[[ "$(dispatch_normalize_effort xHigh)" == 'xhigh' ]] && ok 'CL5a: xHigh -> xhigh' || bad 'CL5a'
[[ "$(dispatch_normalize_effort MAX)" == 'max' ]] && ok 'CL5b: MAX -> max' || bad 'CL5b'

# CL6: engine 別 allowlist
dispatch_valid_effort xhigh claude && ok 'CL6a: claude xhigh' || bad 'CL6a'
dispatch_valid_effort max claude && ok 'CL6b: claude max' || bad 'CL6b'
dispatch_valid_effort max codex && bad 'CL6c: codex に max は無いのに受理した' || ok 'CL6c: codex max を拒否する'
dispatch_valid_effort minimal codex && ok 'CL6d: codex minimal' || bad 'CL6d'
dispatch_valid_effort minimal claude && bad 'CL6e: claude に minimal は無いのに受理した' || ok 'CL6e: claude minimal を拒否する'

# CL7: ロール名
if [[ "$(dispatch_role_names | tr '\n' ' ')" == 'design design_review exec exec_review ' ]]; then
  ok 'CL7: ロール名 4 つ'
else
  bad "CL7: ロール名が違う ($(dispatch_role_names | tr '\n' ' '))"
fi

# CL8: 既定値
[[ "$(dispatch_default_model design claude)" == 'opus[1m]' ]] && ok 'CL8a' || bad 'CL8a'
[[ "$(dispatch_default_model exec claude)" == 'sonnet' ]] && ok 'CL8b' || bad 'CL8b'
[[ "$(dispatch_default_model exec_review claude)" == 'opus[1m]' ]] && ok 'CL8c' || bad 'CL8c'
[[ -z "$(dispatch_default_model design codex)" ]] && ok 'CL8d: codex に既定 model は無い' || bad 'CL8d'
[[ "$(dispatch_default_effort design)" == 'xhigh' ]] && ok 'CL8e' || bad 'CL8e'
[[ "$(dispatch_default_effort exec)" == 'high' ]] && ok 'CL8f' || bad 'CL8f'
[[ "$(dispatch_default_effort exec_review)" == 'xhigh' ]] && ok 'CL8g' || bad 'CL8g'

# CL9: model 省略可否
dispatch_model_required design_review codex && ok 'CL9a: codex review は model 必須' || bad 'CL9a'
dispatch_model_required exec_review codex && ok 'CL9b: codex exec_review は model 必須' || bad 'CL9b'
dispatch_model_required design codex && bad 'CL9c: codex design は省略可のはず' || ok 'CL9c: codex design は省略可'
dispatch_model_required exec codex && bad 'CL9d: codex exec は省略可のはず' || ok 'CL9d: codex exec は省略可'

exit $fail
```

- [ ] **Step 2: テストを走らせて失敗を確認**

Run: `bash apps/cmux-team-dispatch-task/test/test-config-lib.sh`
Expected: `FAIL: config-lib.sh が無い` で exit 2

- [ ] **Step 3: `config-lib.sh` を実装**

```bash
#!/usr/bin/env bash
# config-lib.sh — cmux-team-dispatch-task の設定パスと値検証を 1 箇所に集約する
# source 専用ヘルパー。実行してはならない。
#
# ここに置くのは「複数のスクリプトが同じ判断をする必要があるもの」だけ:
#   - 設定ファイルのパス解決 (DISPATCH_CONFIG_HOME / RUNNERS_CONFIG_PATH)
#   - runner 名 / model 値の拒否条件。値は zsh -ic "... '<prompt>' ..." の二重引用を
#     通って再実行されるため、引用を破る文字を 1 箇所で弾く
#   - effort の小文字正規化と engine 別 allowlist。ユーザーは "xHigh" と書きうる
#   - ロール名・組込み既定値・model 省略可否の表
#
# source する側: config-edit.sh / config-resolve.sh / prewarm-panes.sh /
#                render-loop-prompt.sh / terminal-wait.sh / launch-workspace.sh

dispatch_config_home() {
  printf '%s\n' "${DISPATCH_CONFIG_HOME:-$HOME/.claude/config/cmux-team-dispatch-task}"
}

dispatch_config_file() { printf '%s/config.json\n' "$(dispatch_config_home)"; }

dispatch_project_config_file() { printf '%s/.dispatch/config.json\n' "$1"; }

# RUNNERS_CONFIG_PATH は runners.json だけの個別 override。既存テスト 14 本が使う。
dispatch_runners_file() {
  printf '%s\n' "${RUNNERS_CONFIG_PATH:-$(dispatch_config_home)/runners.json}"
}

dispatch_role_names() { printf 'design\ndesign_review\nexec\nexec_review\n'; }

# 空・前後の空白・シェルメタ文字・制御文字を拒否する。内部の空白は許容する
# (前後の空白を黙ってトリムすると「入力した値と違う値が保存される」ため弾く)。
_dispatch_valid_shell_value() {
  local v="$1"
  [[ -n "$v" ]] || return 1
  case "$v" in
    [[:space:]]*|*[[:space:]]) return 1 ;;
  esac
  case "$v" in
    *\'*|*\"*|*\`*|*\$*|*\\*|*!*) return 1 ;;
  esac
  case "$v" in
    *[[:cntrl:]]*) return 1 ;;
  esac
  return 0
}

dispatch_valid_runner_name() { _dispatch_valid_shell_value "$1"; }
dispatch_valid_model() { _dispatch_valid_shell_value "$1"; }

dispatch_normalize_effort() { printf '%s\n' "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"; }

dispatch_valid_effort() {
  case "$2" in
    claude) case "$1" in low|medium|high|xhigh|max) return 0 ;; *) return 1 ;; esac ;;
    codex)  case "$1" in minimal|low|medium|high|xhigh) return 0 ;; *) return 1 ;; esac ;;
    *) return 1 ;;
  esac
}

# codex には既定 model が無い (codex 側のデフォルトに委ねる)。
dispatch_default_model() {
  [[ "$2" == claude ]] || { printf '\n'; return 0; }
  case "$1" in
    exec) printf 'sonnet\n' ;;
    design|design_review|exec_review) printf 'opus[1m]\n' ;;
    *) printf '\n' ;;
  esac
}

dispatch_default_effort() {
  case "$1" in
    exec) printf 'high\n' ;;
    *) printf 'xhigh\n' ;;
  esac
}

# claude は既定値が必ず埋まるので常に必須。codex は review 2 ロールだけ必須で、
# design / exec は省略可 (codex 側デフォルトに委ねる)。
dispatch_model_required() {
  [[ "$2" == codex ]] || return 0
  case "$1" in
    design_review|exec_review) return 0 ;;
    *) return 1 ;;
  esac
}
```

**注意**: `!` を拒否文字に含めているのは、`zsh -ic` が対話モードで history 展開を効かせるため（`parallel-directive.sh` の PD4 と同じ理由）。既存の `runners-edit.sh` は `!` を弾いていなかったが、これは取りこぼしなので新しい実装で塞ぐ。

- [ ] **Step 4: テストを走らせて通過を確認**

Run: `bash apps/cmux-team-dispatch-task/test/test-config-lib.sh`
Expected: すべて `PASS`、exit 0

- [ ] **Step 5: commit**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/config-lib.sh \
        apps/cmux-team-dispatch-task/test/test-config-lib.sh
git commit -m "feat(dispatch): 設定パスと値検証を config-lib.sh へ集約する"
```

---

## Task 2: `config-resolve.sh`（ロール解決の唯一の読み手）

**Files:**
- Create: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/config-resolve.sh`
- Test: `apps/cmux-team-dispatch-task/test/test-config-resolve.sh`

**Interfaces:**
- Consumes: Task 1 の `config-lib.sh` 全関数
- Produces:
  ```
  config-resolve.sh --project-root <dir> [--runners <path>] [--set <role>.<field>=<value>]...
  ```
  標準出力に次の形の JSON を 1 つ。exit 0 = 成功 / 2 = 検証エラー・fail-fast / 1 = 読み取り失敗。

  ```json
  {
    "config_home": "...", "global_config": "...", "project_config": "...", "runners_file": "...",
    "review_mode": "on",
    "roles": {
      "design":        {"runner":"ccf","engine":"claude","model":"opus[1m]","effort":"xhigh"},
      "design_review": {"runner":"codex","engine":"codex","model":"gpt-5.6-sol","effort":"xhigh"},
      "exec":          {"runner":"codex","engine":"codex","effort":"high"},
      "exec_review":   {"runner":"ccf","engine":"claude","model":"opus[1m]","effort":"high"}
    }
  }
  ```
  `model` が決まらないロールは**キーごと省略**する（`null` も空文字も出さない）。
  `review_mode=off` のとき `roles` は `design` と `exec` の 2 つだけ。

- [ ] **Step 1: 失敗するテストを書く**

`apps/cmux-team-dispatch-task/test/test-config-resolve.sh` を作る。冒頭は Task 1 と同じ体裁で、fixture を作るヘルパーを置く:

```bash
#!/usr/bin/env bash
# config-resolve.sh の単体テスト。
#
# 守っている不変条件:
#   CR1. (role, field) 単位の precedence: project が field 単位で global を上書きする
#   CR2. global runner + project effort-only が成立する (ロールごと置換にしない)
#   CR3. effort の小文字正規化が解決経路に効く
#   CR4. 組込み既定値の表
#   CR5. runner 未設定 / runners.json に不在なら exit 2 (ペインを作らせない)
#   CR6. codex の review 2 ロールは model 必須、design / exec は省略可
#   CR7. model のメタ文字は読み取り時にも拒否する
#   CR8. --set が最優先レイヤーとして適用される
#   CR9. review_mode の終端規則 (無効レイヤーを飛ばして最後は既定 on)
#  CR10. レイヤー単位 fallback の負例 (不正値が出力に残らない)
#  CR11. review_mode=off では review 2 ロールを解決しない
#  CR12. model が決まらないロールはキーごと省略される

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESOLVE="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/config-resolve.sh"
fail=0
bad() { echo "FAIL $1"; fail=1; }
ok() { echo "PASS $1"; }
[[ -f "$RESOLVE" ]] || { echo "FAIL: config-resolve.sh が無い: $RESOLVE"; exit 2; }

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
export DISPATCH_CONFIG_HOME="$TMP/home"
PROJ="$TMP/repo"
mkdir -p "$DISPATCH_CONFIG_HOME" "$PROJ/.dispatch"

write_runners() {
  cat > "$DISPATCH_CONFIG_HOME/runners.json" <<'JSON'
{"default":"ccf","runners":[
  {"name":"ccf","command":"ccf","engine":"claude"},
  {"name":"cx","command":"codex","engine":"codex"}
]}
JSON
}
write_global() { printf '%s\n' "$1" > "$DISPATCH_CONFIG_HOME/config.json"; }
write_project() { printf '%s\n' "$1" > "$PROJ/.dispatch/config.json"; }
clear_project() { rm -f "$PROJ/.dispatch/config.json"; }
run_resolve() { bash "$RESOLVE" --project-root "$PROJ" "$@" 2>"$TMP/err"; }

FULL_GLOBAL='{"review_mode":"on","runner":{
  "design":{"runner":"ccf","model":"opus[1m]","effort":"xhigh"},
  "design_review":{"runner":"cx","model":"gpt-5.6-sol","effort":"xhigh"},
  "exec":{"runner":"cx","model":"gpt-5.6-terra","effort":"high"},
  "exec_review":{"runner":"ccf","model":"opus[1m]","effort":"high"}}}'

write_runners

# CR1: project が field 単位で上書きする
clear_project; write_global "$FULL_GLOBAL"
write_project '{"runner":{"design":{"model":"fable"}}}'
out=$(run_resolve)
[[ "$(jq -r '.roles.design.model' <<<"$out")" == 'fable' \
&& "$(jq -r '.roles.design.runner' <<<"$out")" == 'ccf' \
&& "$(jq -r '.roles.design.effort' <<<"$out")" == 'xhigh' ]] \
  && ok 'CR1: project の model だけが上書きされ runner/effort は global を継承' \
  || bad "CR1: $(jq -c '.roles.design' <<<"$out")"

# CR2: global runner + project effort-only
clear_project; write_global "$FULL_GLOBAL"
write_project '{"runner":{"exec":{"effort":"medium"}}}'
out=$(run_resolve)
[[ "$(jq -r '.roles.exec.effort' <<<"$out")" == 'medium' \
&& "$(jq -r '.roles.exec.engine' <<<"$out")" == 'codex' ]] \
  && ok 'CR2: project effort-only でも global runner から engine を引ける' \
  || bad "CR2: $(jq -c '.roles.exec' <<<"$out")"

# CR3: 大文字混じりの effort が正規化される
clear_project; write_global "$FULL_GLOBAL"
write_project '{"runner":{"design":{"effort":"xHigh"}}}'
out=$(run_resolve)
[[ "$(jq -r '.roles.design.effort' <<<"$out")" == 'xhigh' ]] \
  && ok 'CR3: xHigh が xhigh へ正規化される' || bad 'CR3'

# CR4: 既定値 (model / effort を書かない config)
clear_project
write_global '{"review_mode":"on","runner":{
  "design":{"runner":"ccf"},"design_review":{"runner":"ccf"},
  "exec":{"runner":"ccf"},"exec_review":{"runner":"ccf"}}}'
out=$(run_resolve)
[[ "$(jq -r '.roles.design.model' <<<"$out")" == 'opus[1m]' \
&& "$(jq -r '.roles.exec.model' <<<"$out")" == 'sonnet' \
&& "$(jq -r '.roles.exec.effort' <<<"$out")" == 'high' \
&& "$(jq -r '.roles.exec_review.effort' <<<"$out")" == 'xhigh' ]] \
  && ok 'CR4: 組込み既定値が埋まる' || bad "CR4: $(jq -c '.roles' <<<"$out")"

# CR5: runner 未設定 / 不在
clear_project
write_global '{"review_mode":"off","runner":{"exec":{"runner":"ccf"}}}'
run_resolve >/dev/null; [[ $? -eq 2 ]] && ok 'CR5a: design の runner 未設定で exit 2' || bad 'CR5a'
write_global '{"review_mode":"off","runner":{"design":{"runner":"nope"},"exec":{"runner":"ccf"}}}'
run_resolve >/dev/null; [[ $? -eq 2 ]] && ok 'CR5b: 未登録 runner で exit 2' || bad 'CR5b'

# CR6: codex review の model 必須 / design・exec は省略可
clear_project
write_global '{"review_mode":"on","runner":{
  "design":{"runner":"cx"},"design_review":{"runner":"cx","model":"gpt-5.6-sol"},
  "exec":{"runner":"cx"},"exec_review":{"runner":"cx"}}}'
run_resolve >/dev/null; [[ $? -eq 2 ]] && ok 'CR6a: codex exec_review の model 欠落で exit 2' || bad 'CR6a'
write_global '{"review_mode":"on","runner":{
  "design":{"runner":"cx"},"design_review":{"runner":"cx"},
  "exec":{"runner":"cx"},"exec_review":{"runner":"cx","model":"gpt-5.6-sol"}}}'
run_resolve >/dev/null; [[ $? -eq 2 ]] && ok 'CR6b: codex design_review の model 欠落で exit 2' || bad 'CR6b'
write_global '{"review_mode":"off","runner":{"design":{"runner":"cx"},"exec":{"runner":"cx"}}}'
out=$(run_resolve); rc=$?
[[ $rc -eq 0 ]] && ok 'CR6c: codex design / exec は model 省略可' || bad "CR6c (rc=$rc)"

# CR7: model のメタ文字を読み取り時に拒否
clear_project
write_global "$FULL_GLOBAL"
write_project "{\"runner\":{\"design\":{\"model\":\"a'; touch /tmp/pwn; #\"}}}"
run_resolve >/dev/null; [[ $? -eq 2 ]] && ok 'CR7: メタ文字入り model を拒否' || bad 'CR7'

# CR8: --set が最優先
clear_project; write_global "$FULL_GLOBAL"
out=$(run_resolve --set exec.model=custom-model --set exec.effort=medium)
[[ "$(jq -r '.roles.exec.model' <<<"$out")" == 'custom-model' \
&& "$(jq -r '.roles.exec.effort' <<<"$out")" == 'medium' ]] \
  && ok 'CR8: --set が最優先レイヤーになる' || bad "CR8: $(jq -c '.roles.exec' <<<"$out")"

# CR9: review_mode の終端規則
clear_project
write_global '{"review_mode":"ask","runner":{"design":{"runner":"ccf"},"exec":{"runner":"ccf"},
  "design_review":{"runner":"ccf"},"exec_review":{"runner":"ccf"}}}'
out=$(run_resolve)
[[ "$(jq -r '.review_mode' <<<"$out")" == 'on' ]] \
  && ok 'CR9a: "ask" は無効化され既定 on へ' || bad 'CR9a'
write_global '{"review_mode":true,"runner":{"design":{"runner":"ccf"},"exec":{"runner":"ccf"},
  "design_review":{"runner":"ccf"},"exec_review":{"runner":"ccf"}}}'
out=$(run_resolve)
[[ "$(jq -r '.review_mode' <<<"$out")" == 'on' ]] \
  && ok 'CR9b: boolean も無効化され既定 on へ' || bad 'CR9b'
write_global '{"review_mode":"off","runner":{"design":{"runner":"ccf"},"exec":{"runner":"ccf"}}}'
write_project '{"review_mode":"nonsense"}'
out=$(run_resolve)
[[ "$(jq -r '.review_mode' <<<"$out")" == 'off' ]] \
  && ok 'CR9c: 不正な project レイヤーを飛ばして global の off を採る' || bad 'CR9c'

# CR10: レイヤー単位 fallback の負例
clear_project; write_global "$FULL_GLOBAL"
write_project '{"runner":{"design":{"effort":"bogus"}}}'
out=$(run_resolve)
[[ "$(jq -r '.roles.design.effort' <<<"$out")" == 'xhigh' ]] \
  && ok 'CR10a: 不正 effort は当該レイヤーだけ無効化され global へ落ちる' || bad 'CR10a'
grep -q 'bogus' <<<"$out" && bad 'CR10b: 不正値が出力に残った' || ok 'CR10b: 不正値は出力に残らない'
write_project '{"runner":{"exec":{"model":"opus[1m]"}}}'   # codex ロールに claude alias
out=$(run_resolve)
[[ "$(jq -r '.roles.exec.model' <<<"$out")" == 'gpt-5.6-terra' ]] \
  && ok 'CR10c: codex ロールの claude alias は当該レイヤーだけ無効化される' || bad 'CR10c'

# CR11 / CR12: review off と model 省略
clear_project
write_global '{"review_mode":"off","runner":{"design":{"runner":"cx"},"exec":{"runner":"cx"}}}'
out=$(run_resolve)
[[ "$(jq -r '.roles | keys | join(",")' <<<"$out")" == 'design,exec' ]] \
  && ok 'CR11: review off では 2 ロールだけ解決する' || bad "CR11: $(jq -c '.roles|keys' <<<"$out")"
[[ "$(jq -r '.roles.design | has("model")' <<<"$out")" == 'false' ]] \
  && ok 'CR12: 決まらない model はキーごと省略される' || bad 'CR12'

exit $fail
```

- [ ] **Step 2: テストを走らせて失敗を確認**

Run: `bash apps/cmux-team-dispatch-task/test/test-config-resolve.sh`
Expected: `FAIL: config-resolve.sh が無い` で exit 2

- [ ] **Step 3: `config-resolve.sh` を実装**

実装の骨子（`SCRIPT_DIR` で `config-lib.sh` を source し、jq でレイヤーを読む）:

```bash
#!/usr/bin/env bash
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./config-lib.sh
. "$SCRIPT_DIR/config-lib.sh"

die() { echo "config-resolve: $1" >&2; exit 2; }
warn() { echo "[warn] config-resolve: $1" >&2; }
```

処理順:

1. 引数を読む。`--set <role>.<field>=<value>` は連想配列を使わず `OVERRIDE_design_model` のような変数名で保持する（bash 3.2 に連想配列は無い）。role と field は allowlist 済みなので変数名へ埋めてよい。
2. `review_mode` を解決する。レイヤーは `--set review_mode` は無い（`--override` に review_mode は無い）ので project → global → 既定 `on`。各レイヤーは `jq -r 'if (.review_mode|type)=="string" then .review_mode else empty end'` で読み、値が `on` / `off` でなければ `warn` して次へ。
3. active なロール集合を決める（`on` なら 4 つ、`off` なら `design` と `exec`）。
4. 各ロール・各フィールドについて、`--set` → project → global の順に最初の**妥当な**値を採る。
   - `runner`: `dispatch_valid_runner_name` を通り、かつ `runners.json` に実在すること。不正なら `warn` して次のレイヤーへ。
   - `model`: `dispatch_valid_model` を通ること。加えて engine が codex のとき `opus[1m]` / `sonnet` / `fable` のいずれかなら `warn` して次のレイヤーへ。
   - `effort`: `dispatch_normalize_effort` の後 `dispatch_valid_effort <v> <engine>` を通ること。
   - engine は `runner` 決定後に `runners.json` から引く。したがって**`runner` を先に解決してから** model / effort を解決する。
5. `runner` がどのレイヤーからも決まらなければ die（exit 2）。メッセージは
   `role '<role>' has no usable runner; run the skill with --setup` の形。
6. `model` が決まらず `dispatch_model_required <role> <engine>` が真なら die。偽ならキーを出力しない。
7. `effort` は最後に `dispatch_default_effort <role>` で必ず埋まる。
8. `jq -n` で JSON を組み立てて stdout へ出す。`model` の有無は `jq` の引数で分岐させる（`--argjson m 'null'` にせず、キーを足すかどうかで分ける）。

`runners.json` が無い場合は die（`runners.json not found at <path>; run the skill to perform first-run setup`）。

- [ ] **Step 4: テストを走らせて通過を確認**

Run: `bash apps/cmux-team-dispatch-task/test/test-config-resolve.sh`
Expected: すべて `PASS`、exit 0

- [ ] **Step 5: commit**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/config-resolve.sh \
        apps/cmux-team-dispatch-task/test/test-config-resolve.sh
git commit -m "feat(dispatch): ロール解決を config-resolve.sh へ一本化する"
```

---

## Task 3: `config-edit.sh` の 4 ロール対応と `runners-edit.sh` の削除

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/config-edit.sh`
- Delete: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/runners-edit.sh`
- Delete: `apps/cmux-team-dispatch-task/test/test-runners-edit.sh`
- Modify: `apps/cmux-team-dispatch-task/test/test-config-edit.sh`
- Modify: `apps/cmux-team-dispatch-task/test/test-delivery-callsites.sh`（CS4 ratchet）

**Interfaces:**
- Consumes: Task 1 の `config-lib.sh`
- Produces:
  ```
  config-edit.sh --config <path> [--runners <path>] [--engine <role>=<engine>]...
                 [--set <key>=<value>]... [--unset <key>]...
  config-edit.sh --config <path> --get <key>
  config-edit.sh --config <path> --show
  ```
  キー allowlist: `review_mode`（`on`/`off` のみ）、`runner.<role>.runner`、`runner.<role>.model`、`runner.<role>.effort`、`runner.<role>`（unset 専用）、`runner`（unset 専用）。

- [ ] **Step 1: 失敗するテストを書く**

`test/test-config-edit.sh` を書き換える。CE1-CE11 の枠組みは残しつつ、旧キー（`design_runner` など）を新キーへ置き換え、次の不変条件を追加する:

```bash
#   CE12. 入れ子キー runner.<role>.<field> の set / get / unset
#   CE13. --unset runner がトップレベルごと消し、空オブジェクトを残さない
#   CE14. --set runner は受け付けない (unset 専用)
#   CE15. 旧 4 キー (design_runner / review_runner / exec_choice / prewarm) は exit 2
#   CE16. review_mode の "ask" は exit 2
#   CE17. effort の engine 解決順 4 段。--set の並び順に依存しない
#   CE18. --engine <role>=<engine> が繰り返せる (複数ロール異種 engine の 1 コール編集)
#   CE19. runner 名の禁止文字を直接渡すと exit 2 かつ原本不変
#   CE20. model の禁止文字 / 内部空白の許容 (test-runners-edit.sh からの移植)
#   CE21. effort の engine 別 allowlist (codex に max は無い。移植)
#   CE22. reset 相当 (--unset review_mode --unset runner) が第三者キーを温存する
```

追加テストの実体:

```bash
# CE12: 入れ子キー
reset_config
bash "$EDIT" --config "$C" --engine design=claude \
  --set runner.design.runner=ccf --set runner.design.model='opus[1m]' \
  --set runner.design.effort=xhigh >/dev/null 2>&1
if [[ "$(jq -r '.runner.design.runner' "$C")" == 'ccf' \
   && "$(jq -r '.runner.design.model' "$C")" == 'opus[1m]' \
   && "$(jq -r '.runner.design.effort' "$C")" == 'xhigh' ]]; then
  ok 'CE12a: 入れ子キーの --set'
else
  bad "CE12a: $(cat "$C")"
fi
[[ "$(bash "$EDIT" --config "$C" --get runner.design.model)" == 'opus[1m]' ]] \
  && ok 'CE12b: 入れ子キーの --get' || bad 'CE12b'
bash "$EDIT" --config "$C" --unset runner.design.model >/dev/null 2>&1
[[ "$(jq -r '.runner.design | has("model")' "$C")" == 'false' \
&& "$(jq -r '.runner.design.runner' "$C")" == 'ccf' ]] \
  && ok 'CE12c: 入れ子キーの --unset' || bad 'CE12c'

# CE13 / CE22: reset 相当
reset_config
printf '%s\n' '{"shell_ready_ms":{"baseline_ms":7},"loop":{"task_timeout_min":45,"other":1},
"review_mode":"on","runner":{"design":{"runner":"ccf"},"exec":{"runner":"ccf"}}}' > "$C"
before_loop=$(jq -cS '.loop' "$C"); before_srm=$(jq -cS '.shell_ready_ms' "$C")
bash "$EDIT" --config "$C" --unset review_mode --unset runner >/dev/null 2>&1
if [[ "$(jq -r 'has("review_mode")' "$C")" == 'false' \
   && "$(jq -r 'has("runner")' "$C")" == 'false' \
   && "$(jq -cS '.loop' "$C")" == "$before_loop" \
   && "$(jq -cS '.shell_ready_ms' "$C")" == "$before_srm" ]]; then
  ok 'CE13/CE22: reset が役割キーだけ消し loop と shell_ready_ms を温存する'
else
  bad "CE13/CE22: $(cat "$C")"
fi

# CE14 / CE15 / CE16: 拒否
reset_config; printf '{}\n' > "$C"; before=$(cat "$C")
for k in 'runner=x' 'design_runner=ccf' 'review_runner=ccf' 'exec_choice=codex' 'prewarm=true' 'review_mode=ask'; do
  bash "$EDIT" --config "$C" --set "$k" >/dev/null 2>&1
  rc=$?
  [[ $rc -eq 2 && "$(cat "$C")" == "$before" ]] \
    && ok "CE14-16: --set $k を exit 2 で拒否し原本不変" \
    || bad "CE14-16: --set $k (rc=$rc)"
done
for k in design_runner review_runner exec_choice prewarm; do
  bash "$EDIT" --config "$C" --unset "$k" >/dev/null 2>&1
  [[ $? -eq 2 ]] && ok "CE15: --unset $k を exit 2 で拒否" || bad "CE15: --unset $k"
done

# CE17 / CE18: effort の engine 解決順と --engine の反復
reset_config
printf '%s\n' '{"runner":{"design":{"runner":"ccf"},"exec":{"runner":"cx"}}}' > "$C"
cat > "$TMP/runners.json" <<'JSON'
{"default":"ccf","runners":[{"name":"ccf","command":"ccf","engine":"claude"},
                            {"name":"cx","command":"codex","engine":"codex"}]}
JSON
# 対象ファイル内の runner から engine を引く (解決順 3)
bash "$EDIT" --config "$C" --runners "$TMP/runners.json" \
  --set runner.design.effort=max --set runner.exec.effort=minimal >/dev/null 2>&1
[[ $? -eq 0 && "$(jq -r '.runner.design.effort' "$C")" == 'max' \
&& "$(jq -r '.runner.exec.effort' "$C")" == 'minimal' ]] \
  && ok 'CE17a: 対象ファイルの runner から engine を引いて 2 ロールを 1 コールで更新' \
  || bad "CE17a: $(cat "$C")"
# --engine の反復 (解決順 2)。config に runner が無いケース
reset_config; printf '{}\n' > "$C"
bash "$EDIT" --config "$C" --runners "$TMP/runners.json" \
  --engine design=claude --engine exec=codex \
  --set runner.design.effort=max --set runner.exec.effort=minimal >/dev/null 2>&1
[[ $? -eq 0 && "$(jq -r '.runner.design.effort' "$C")" == 'max' \
&& "$(jq -r '.runner.exec.effort' "$C")" == 'minimal' ]] \
  && ok 'CE18: --engine <role>=<engine> の反復で異種 engine を 1 コール更新' \
  || bad "CE18: $(cat "$C")"
# 解決順 1 が 2 より優先。--set の並び順に依存しない
reset_config; printf '{}\n' > "$C"
bash "$EDIT" --config "$C" --runners "$TMP/runners.json" --engine exec=claude \
  --set runner.exec.effort=minimal --set runner.exec.runner=cx >/dev/null 2>&1
[[ $? -eq 0 && "$(jq -r '.runner.exec.effort' "$C")" == 'minimal' ]] \
  && ok 'CE17b: 同一バッチの runner が --engine より優先し、順序に依存しない' || bad 'CE17b'
# engine がどこからも決まらない
reset_config; printf '{}\n' > "$C"
bash "$EDIT" --config "$C" --runners "$TMP/runners.json" --set runner.exec.effort=high >/dev/null 2>&1
[[ $? -eq 2 ]] && ok 'CE17c: engine が決まらないと exit 2' || bad 'CE17c'

# CE19 / CE20 / CE21: 値の検証 (test-runners-edit.sh からの移植)
reset_config; printf '{}\n' > "$C"; before=$(cat "$C")
for v in '' ' x' 'x ' "q'uote" 'd"q' 'b`t' 'd$l' 'b\s'; do
  bash "$EDIT" --config "$C" --set "runner.design.runner=$v" >/dev/null 2>&1
  [[ $? -eq 2 && "$(cat "$C")" == "$before" ]] || bad "CE19: runner 名 '$v' を受理した"
  bash "$EDIT" --config "$C" --set "runner.design.model=$v" >/dev/null 2>&1
  [[ $? -eq 2 && "$(cat "$C")" == "$before" ]] || bad "CE20: model '$v' を受理した"
done
ok 'CE19/CE20: runner 名と model の禁止文字を exit 2 で拒否し原本不変'
bash "$EDIT" --config "$C" --engine design=claude --set 'runner.design.model=gpt 5 sol' >/dev/null 2>&1
[[ $? -eq 0 ]] && ok 'CE20b: model の内部空白は許容' || bad 'CE20b'
reset_config; printf '{}\n' > "$C"
bash "$EDIT" --config "$C" --runners "$TMP/runners.json" --engine design=codex \
  --set runner.design.effort=max >/dev/null 2>&1
[[ $? -eq 2 ]] && ok 'CE21: codex に max は無いので exit 2' || bad 'CE21'
```

- [ ] **Step 2: テストを走らせて失敗を確認**

Run: `bash apps/cmux-team-dispatch-task/test/test-config-edit.sh`
Expected: CE12 以降が FAIL（未実装のため）

- [ ] **Step 3: `config-edit.sh` を書き換える**

- 冒頭で `config-lib.sh` を source する。
- `known_key()` を新しい allowlist へ置き換える。`runner.<role>.<field>` のパースは
  `case "$key" in runner.*.*) role="${key#runner.}"; field="${role#*.}"; role="${role%%.*}" ;; esac`
  の形で行い、role が `dispatch_role_names` に含まれること、field が `runner|model|effort` の
  いずれかであることを確認する。
- `--set runner=...` と `--set runner.<role>=...` は「unset 専用キー」として exit 2。
- `--engine <role>=<engine>` を繰り返し受け取り、`ENGINE_<role>` 変数へ保持する。
- **引数を全部読み終えてから**検証する（順序非依存にするため）。effort の検証では
  engine を「同一バッチの `--set runner.<role>.runner`」→「`--engine <role>=`」→
  「対象ファイル内の `.runner.<role>.runner` を `runners.json` で引いた engine」の順に解決し、
  決まらなければ `die_usage "cannot determine the engine for role '<role>'; pass --engine <role>=<claude|codex>"`。
- jq 式の組み立ては既存どおり。入れ子キーは `.runner.design.model = $v1` のように直接埋める
  （role / field は allowlist 通過済み）。`--unset runner` は `del(.runner)`。
- `--get` / `--show` の挙動は既存のまま。`--get runner.design.model` は
  `jq -r '.runner.design.model // empty'`。
- ヘッダーコメントを新しい契約に合わせて全面的に書き直す。旧コメントの
  「扱えるキーは役割キー 5 つだけ」「グローバルは ~/.claude/cmux-team-dispatch-task/config.json」
  は誤りになるので消す。

- [ ] **Step 4: `runners-edit.sh` と `test-runners-edit.sh` を削除し CS4 ratchet を更新**

```bash
git rm apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/runners-edit.sh
git rm apps/cmux-team-dispatch-task/test/test-runners-edit.sh
```

`test/test-delivery-callsites.sh` の CS4 で管理している「削除済みスクリプト」表に
`runners-edit.sh` を追加する。CS4 は「表にあるのに 0 件でも FAIL」するラチェットなので、
参照が残っている箇所（SKILL.md / setup-mode*.md / CLAUDE.md / README.md）は Task 7-10 で
消える。Task 3 の時点では CS4 が赤くなるのが正しいので、**この時点で
`test-delivery-callsites.sh` を走らせて赤いことを確認し、Task 10 で緑に戻す**。

- [ ] **Step 5: テストを走らせて通過を確認**

Run: `bash apps/cmux-team-dispatch-task/test/test-config-edit.sh`
Expected: すべて `PASS`、exit 0

Run: `bash apps/cmux-team-dispatch-task/test/test-delivery-callsites.sh`
Expected: CS4 が FAIL（Task 10 まで想定内。他の CS は PASS）

- [ ] **Step 6: commit**

```bash
git add -A apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts \
           apps/cmux-team-dispatch-task/test
git commit -m "feat(dispatch)!: config-edit.sh を 4 ロール対応にし runners-edit.sh を削除する"
```

---

## Task 4: `launch-workspace.sh` と `terminal-wait.sh` のパス・ロール対応

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh`（`:104` のパス、`:346-356` の `--role`、`:458-507` の役割フィールド層、`:915-917` の `--add-dir`）
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/terminal-wait.sh:15`
- Create: `apps/cmux-team-dispatch-task/test/test-config-paths.sh`
- Modify: `apps/cmux-team-dispatch-task/test/test-launch-workspace-codex.sh`（`--add-dir` の CR1 系）
- Modify: `apps/cmux-team-dispatch-task/test/test-role-models.sh`

**Interfaces:**
- Consumes: Task 1 の `config-lib.sh`
- Produces: `launch-workspace.sh --role design|design_review|exec|exec_review`。model / effort は
  `--model` / `--effort` の明示値 > `--role` に対応する組込み既定値の 2 段。

- [ ] **Step 1: 失敗するテストを書く**

`test/test-config-paths.sh`:

```bash
#!/usr/bin/env bash
# D6 のパスヘルパーが全 consumer へ届いていることの検査。
#
#   CP1. launch-workspace.sh が RUNNERS_CONFIG_PATH 未設定時に新しい既定 base を使う
#   CP2. RUNNERS_CONFIG_PATH を設定するとそちらを使う (既存 14 テストの互換)
#   CP3. terminal-wait.sh が DISPATCH_CONFIG_HOME 配下の config.json を使う
#   CP4. 旧パス ~/.claude/cmux-team-dispatch-task への参照がスクリプトに残らない

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
S="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts"
fail=0
bad() { echo "FAIL $1"; fail=1; }
ok() { echo "PASS $1"; }

# CP1 / CP2: launch-workspace.sh のエラーメッセージに現れるパスで判定する
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
out=$(DISPATCH_CONFIG_HOME="$TMP/h" bash "$S/launch-workspace.sh" --runner nope 2>&1)
grep -q "$TMP/h/runners.json" <<<"$out" \
  && ok 'CP1: DISPATCH_CONFIG_HOME 由来の runners.json を見る' \
  || bad "CP1: $out"
out=$(DISPATCH_CONFIG_HOME="$TMP/h" RUNNERS_CONFIG_PATH="$TMP/x/runners.json" \
      bash "$S/launch-workspace.sh" --runner nope 2>&1)
grep -q "$TMP/x/runners.json" <<<"$out" \
  && ok 'CP2: RUNNERS_CONFIG_PATH の個別 override が効く' \
  || bad "CP2: $out"

# CP3: terminal-wait.sh の config パス
out=$(DISPATCH_CONFIG_HOME="$TMP/h" bash -c ". '$S/terminal-wait.sh' >/dev/null 2>&1; \
      printf '%s' \"\$TERMINAL_WAIT_GLOBAL_CONFIG\"")
[[ "$out" == "$TMP/h/config.json" ]] \
  && ok 'CP3: terminal-wait.sh が DISPATCH_CONFIG_HOME を使う' || bad "CP3: $out"

# CP4: 旧パスの残骸
if grep -rn '\.claude/cmux-team-dispatch-task' "$S" >/dev/null 2>&1; then
  bad "CP4: 旧パスの参照が残っている: $(grep -rln '\.claude/cmux-team-dispatch-task' "$S" | tr '\n' ' ')"
else
  ok 'CP4: 旧パスの参照が無い'
fi

exit $fail
```

`test/test-launch-workspace-codex.sh` に追加する検査（既存の CR1 系の隣）:

```bash
# CR1f: review ペインの --add-dir は STATUS_DIR ではなく STATUS_DIR/review
if grep -q "add-dir '\$STATUS_DIR/review'" "$LAUNCH" && ! grep -q "add-dir '\$STATUS_DIR'" "$LAUNCH"; then
  ok 'CR1f: review ペインの書き込み許可が STATUS_DIR/review に狭まっている'
else
  bad 'CR1f: --add-dir が STATUS_DIR 全体のままか、review 版が無い'
fi
# CR1g: STATUS_DIR/review は -d 判定の前に mkdir -p される
if grep -q 'mkdir -p "\$STATUS_DIR/review"' "$LAUNCH"; then
  ok 'CR1g: STATUS_DIR/review を事前に作る'
else
  bad 'CR1g: STATUS_DIR/review の mkdir が無い'
fi
# RL1: --role の値域
for r in design design_review exec exec_review; do
  grep -q "$r" "$LAUNCH" || bad "RL1: --role $r が値域に無い"
done
ok 'RL1: --role の新しい値域'
# RL2: 旧値は拒否
out=$(bash "$LAUNCH" --role plan --mode plan 2>&1); [[ $? -ne 0 ]] \
  && ok 'RL2a: --role plan は拒否' || bad 'RL2a'
out=$(bash "$LAUNCH" --role review --mode review 2>&1); [[ $? -ne 0 ]] \
  && ok 'RL2b: --role review は拒否' || bad 'RL2b'
```

**重要**: `--role exec` は**新しい正当値**なので拒否リストに入れない。

- [ ] **Step 2: テストを走らせて失敗を確認**

Run: `bash apps/cmux-team-dispatch-task/test/test-config-paths.sh`
Expected: CP1-CP4 が FAIL

- [ ] **Step 3: `launch-workspace.sh` を改修**

1. `:104` の `RUNNERS_CONFIG_PATH="${RUNNERS_CONFIG_PATH:-$HOME/.claude/cmux-team-dispatch-task/runners.json}"` を削除し、代わりに冒頭で `config-lib.sh` を source して
   `RUNNERS_CONFIG_PATH="$(dispatch_runners_file)"` にする。
2. `--role` の検証を `[[ "$MODEL_ROLE" =~ ^(design|design_review|exec|exec_review)$ ]]` に変える。
   `--mode` からの既定導出は `plan|superpowers) MODEL_ROLE="design" ;; review) MODEL_ROLE="design_review" ;; execute|standby) MODEL_ROLE="exec" ;;`。
   `exec_review` は `--role` の明示指定でのみ選ぶ。
3. `:458-507` の `RUNNER_PLAN_MODEL` ほか 6 変数とその読み取り・フォールバックを**削除**し、
   次に置き換える:
   ```bash
   [[ -z "$MODEL" ]] && MODEL="$(dispatch_default_model "$MODEL_ROLE" "$RUNNER_ENGINE")"
   [[ -z "$EFFORT" ]] && EFFORT="$(dispatch_default_effort "$MODEL_ROLE")"
   ```
   `--runner` から `command` と `engine` を引く処理（`:466-469`）は残す。
4. `:915-917` を次に変える:
   ```bash
   REVIEW_WRITABLE_FLAG=""
   if [[ -n "$STATUS_DIR" ]]; then
     # reviewer が worktree 外へ書くのは findings だけ。STATUS_DIR 全体を許可すると
     # roles.json / prewarm.json まで書けてしまい、検証を通る別内容へ差し替えられる。
     mkdir -p "$STATUS_DIR/review" 2>/dev/null || true
     [[ -d "$STATUS_DIR/review" ]] && REVIEW_WRITABLE_FLAG+=" --add-dir '$STATUS_DIR/review'"
   fi
   ```
5. `--help` / ヘッダーコメントの `--role` 説明と runners.json のパス説明を更新する。

- [ ] **Step 4: `terminal-wait.sh` を改修**

`:15` の `TERMINAL_WAIT_GLOBAL_CONFIG="$HOME/.claude/cmux-team-dispatch-task/config.json"` を
`config-lib.sh` を source したうえで `TERMINAL_WAIT_GLOBAL_CONFIG="$(dispatch_config_file)"` にする。
`shell_ready_ms` の merge / atomic write は**そのまま維持**する（terminal-wait.sh は
`shell_ready_ms` の owner であり続ける）。

- [ ] **Step 5: `test-role-models.sh` を書き換える**

RM1-RM17 は `runners.json` の役割フィールドから model / effort を解決する契約を検証していた。
新しい契約は「`--model` / `--effort` の明示値 > `--role` の組込み既定値」の 2 段なので、
各ケースを次のように読み替える:
- 「runner に `plan_model` があるとき design ペインへ届く」→ **削除**（その層は無い）。
- 「未設定でも既定値が埋まり flag が付く」→ **維持**。`--role design` で `--model 'opus[1m]' --effort xhigh`、
  `--role exec` で `--model sonnet --effort high`、codex engine では `--model` が付かず
  `-c model_reasoning_effort='<v>'` が付くこと。
- 「明示 `--model` / `--effort` が優先」→ **維持**。
- 「allowlist は engine 別」→ **維持**。
- `--role design_review` / `--role exec_review` の 2 ケースを**追加**（どちらも既定 effort は
  `xhigh`、claude なら既定 model は `opus[1m]`）。

- [ ] **Step 6: テストを走らせて通過を確認**

```bash
bash apps/cmux-team-dispatch-task/test/test-config-paths.sh
bash apps/cmux-team-dispatch-task/test/test-role-models.sh
bash apps/cmux-team-dispatch-task/test/test-launch-workspace-codex.sh
bash apps/cmux-team-dispatch-task/test/test-launch-workspace-permissions.sh
bash apps/cmux-team-dispatch-task/test/test-launch-workspace-layout.sh
```
Expected: すべて exit 0

- [ ] **Step 7: commit**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/launch-workspace.sh \
        apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/terminal-wait.sh \
        apps/cmux-team-dispatch-task/test
git commit -m "feat(dispatch)!: launch-workspace を 4 ロール化し reviewer の書き込み許可を review/ へ狭める"
```

---

## Task 5: `prewarm-panes.sh` の `--roles` 化と 2/4 ペイン固定

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh`
- Create: `apps/cmux-team-dispatch-task/test/test-roles-input.sh`
- Create: `apps/cmux-team-dispatch-task/test/test-pane-invariant.sh`
- Modify: `apps/cmux-team-dispatch-task/test/test-prewarm-layout.sh`, `test-prewarm-all-codex.sh`, `test-prewarm-unattended.sh`, `test-prewarm-design-permissions.sh`, `test-in-session.sh`

**Interfaces:**
- Consumes: Task 1 の `config-lib.sh`、Task 2 が出す `roles.json` の形
- Produces: `prewarm.json` の新スキーマ。以降 Task 6 / 7 が依存する。

```json
{
  "workspace_id": "workspace:23",
  "review_mode": "on",
  "design":        {"surface_id":"surface:65","agent":"<slug>","runner":"ccf","engine":"claude","model":"opus[1m]","effort":"xhigh","wired":true},
  "design_review": {"surface_id":"surface:67","agent":"<slug>-design-review","runner":"cx","engine":"codex","model":"gpt-5.6-sol","effort":"xhigh","wired":true},
  "exec":          {"surface_id":"surface:66","agent":"<slug>-exec","runner":"cx","engine":"codex","effort":"high","wired":true},
  "exec_review":   {"surface_id":"surface:68","agent":"<slug>-exec-review","runner":"ccf","engine":"claude","model":"opus[1m]","effort":"high","wired":true}
}
```

`review_mode=off` では `design_review` / `exec_review` キーが存在しない。`model` は codex の
`design` / `exec` で省略されうる。stdout JSON は `{workspace_id, review_mode, panes:{...}}`。

- [ ] **Step 1: 失敗するテストを書く（`test-roles-input.sh`）**

`prewarm-panes.sh` は cmux を呼ぶので、テストは**静的検査と早期 exit の検査**に限る
（既存の `test-prewarm-layout.sh` と同じ方針）。

```bash
#!/usr/bin/env bash
# prewarm-panes.sh の --roles 入力検証。cmux を呼ぶ前に落ちることだけを見る。
#
#   RI1. --roles が必須で、旧 13 フラグは exit 2
#   RI2. 妥当な roles.json (on=4 / off=2) は検証を通過する
#   RI3. 改竄 roles.json は副作用ゼロで exit 2
#   RI4. registry path は roles.json の runners_file から取らない
#   RI5. model 省略可否 matrix
#   RI6. --review-mode フラグは存在しない

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PW="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh"
fail=0
bad() { echo "FAIL $1"; fail=1; }
ok() { echo "PASS $1"; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
export DISPATCH_CONFIG_HOME="$TMP/home"; mkdir -p "$DISPATCH_CONFIG_HOME" "$TMP/wt" "$TMP/status"
cat > "$DISPATCH_CONFIG_HOME/runners.json" <<'JSON'
{"default":"ccf","runners":[{"name":"ccf","command":"ccf","engine":"claude"},
                            {"name":"cx","command":"codex","engine":"codex"}]}
JSON
ROLES_ON="$TMP/roles-on.json"; ROLES_OFF="$TMP/roles-off.json"
cat > "$ROLES_ON" <<'JSON'
{"review_mode":"on","roles":{
 "design":{"runner":"ccf","engine":"claude","model":"opus[1m]","effort":"xhigh"},
 "design_review":{"runner":"cx","engine":"codex","model":"gpt-5.6-sol","effort":"xhigh"},
 "exec":{"runner":"cx","engine":"codex","effort":"high"},
 "exec_review":{"runner":"ccf","engine":"claude","model":"opus[1m]","effort":"high"}}}
JSON
cat > "$ROLES_OFF" <<'JSON'
{"review_mode":"off","roles":{
 "design":{"runner":"ccf","engine":"claude","model":"opus[1m]","effort":"xhigh"},
 "exec":{"runner":"cx","engine":"codex","effort":"high"}}}
JSON
run_pw() {
  bash "$PW" --with-design --cwd "$TMP/wt" --slug t --status-dir "$TMP/status" \
    --agmsg-team team --roles "$1" "${@:2}" 2>&1
}

# RI1: 旧フラグの拒否
for f in --design-runner --reviewer-runner --exec-runner --claude-runner --codex-runner \
         --exec-choice --review-model --design-model --design-effort --reviewer-model \
         --reviewer-effort --exec-model --exec-effort --review-mode; do
  out=$(run_pw "$ROLES_ON" "$f" x); rc=$?
  [[ $rc -eq 2 || $rc -eq 1 ]] && grep -qi 'unknown\|removed' <<<"$out" \
    || bad "RI1: $f が拒否されない"
done
ok 'RI1: 旧 13 フラグと --review-mode を拒否する'

# RI3: 改竄 fixture は副作用ゼロで exit 2
tamper() { jq "$1" "$ROLES_ON" > "$TMP/bad.json"; run_pw "$TMP/bad.json" >/dev/null 2>&1; }
tamper '.roles.design.model = "a'; touch /tmp/pwn; #"'; [[ $? -eq 2 ]] || bad 'RI3a: メタ文字 model'
tamper '.roles.design.effort = "bogus"';                      [[ $? -eq 2 ]] || bad 'RI3b: 範囲外 effort'
tamper '.roles.design.engine = "codex"';                      [[ $? -eq 2 ]] || bad 'RI3c: engine 不整合'
tamper '.roles.design.runner = "nope"';                       [[ $? -eq 2 ]] || bad 'RI3d: 未登録 runner'
tamper 'del(.roles.exec_review)';                             [[ $? -eq 2 ]] || bad 'RI3e: on なのに review ロール欠落'
tamper '.review_mode = "off"';                                [[ $? -eq 2 ]] || bad 'RI3f: off なのに review ロールがある'
tamper '.roles.design.bogus = 1';                             [[ $? -eq 2 ]] || bad 'RI3g: 許可外キー'
[[ -e /tmp/pwn ]] && bad 'RI3h: 副作用が起きた'
ok 'RI3: 改竄 roles.json を副作用ゼロで拒否する'

# RI4: runners_file の差し替えを信じない
cat > "$TMP/fake-runners.json" <<'JSON'
{"default":"evil","runners":[{"name":"evil","command":"evil","engine":"claude"}]}
JSON
jq --arg f "$TMP/fake-runners.json" '.runners_file = $f | .roles.design.runner = "evil"' \
  "$ROLES_ON" > "$TMP/bad.json"
run_pw "$TMP/bad.json" >/dev/null 2>&1
[[ $? -eq 2 ]] && ok 'RI4: roles.json の runners_file を参照先に使わない' || bad 'RI4'

# RI5: model 省略可否
jq 'del(.roles.exec.model)' "$ROLES_ON" > "$TMP/ok.json"   # codex exec は省略可
jq 'del(.roles.design_review.model)' "$ROLES_ON" > "$TMP/bad.json"
run_pw "$TMP/bad.json" >/dev/null 2>&1
[[ $? -eq 2 ]] && ok 'RI5a: codex design_review の model 欠落を拒否' || bad 'RI5a'
jq '.roles.design_review.model = null' "$ROLES_ON" > "$TMP/bad.json"
run_pw "$TMP/bad.json" >/dev/null 2>&1
[[ $? -eq 2 ]] && ok 'RI5b: null も拒否' || bad 'RI5b'

# RI6: --review-mode フラグがソースに存在しない
grep -q -- '--review-mode' "$PW" && bad 'RI6: --review-mode フラグが残っている' \
  || ok 'RI6: --review-mode フラグは存在しない'

exit $fail
```

- [ ] **Step 2: 失敗するテストを書く（`test-pane-invariant.sh`）**

配置の固定表とスキーマを**ソースの静的検査**で押さえる（既存 `test-prewarm-layout.sh` の PG 系と同じ流儀）:

```bash
#!/usr/bin/env bash
#   PI1. review on = 4 ペイン / off = 2 ペインの固定表
#   PI2. split 方向: design_review=right(design) / exec=down(design) / exec_review=right(exec)
#   PI3. prewarm.json のキーが 4 ロール名で、executors / review が現れない
#   PI4. agent 名が <slug> / <slug>-design-review / <slug>-exec / <slug>-exec-review
#   PI5. in-session 分岐が存在しない
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PW="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh"
fail=0; bad() { echo "FAIL $1"; fail=1; }; ok() { echo "PASS $1"; }

grep -q 'executors' "$PW" && bad 'PI3a: executors が残っている' || ok 'PI3a: executors キーが無い'
grep -qE '"review"|\.review\b' "$PW" && bad 'PI3b: 旧 review キーが残っている' || ok 'PI3b'
for a in '\-design-review' '\-exec-review' '\-exec\b'; do
  grep -qE "SLUG}?$a" "$PW" || bad "PI4: agent 名 $a が無い"
done
ok 'PI4: 4 つの agent 名'
grep -qE 'IN_SESSION|in-session' "$PW" && bad 'PI5: in-session 分岐が残っている' || ok 'PI5'
grep -q 'standby-split-direction right' "$PW" || bad 'PI2: right split が無い'
grep -q 'standby-split-direction down' "$PW" || bad 'PI2: down split が無い'
ok 'PI1/PI2: 固定表の split 方向'
exit $fail
```

- [ ] **Step 3: テストを走らせて失敗を確認**

Run: `bash apps/cmux-team-dispatch-task/test/test-roles-input.sh`
Expected: RI1 以降が FAIL

- [ ] **Step 4: `prewarm-panes.sh` を改修**

1. 冒頭で `config-lib.sh` を source する。
2. 削除するフラグ: `--design-runner` / `--reviewer-runner` / `--exec-runner` / `--claude-runner` /
   `--codex-runner` / `--exec-choice` / `--review-model` / `--design-model` / `--design-effort` /
   `--reviewer-model` / `--reviewer-effort` / `--exec-model` / `--exec-effort`。
   `--message-type` と同じく、渡されたら `was removed` を含む die で拒否する。
   `--review-mode` は**そもそも作らない**（渡されたら `unknown option`）。
3. `--roles <path>` を必須にする。**検証済みスナップショット契約**:
   ```bash
   ROLES_DOC=$(cat "$ROLES_FILE") || die "cannot read --roles file"
   # 以降 "$ROLES_FILE" を再読しない。すべて "$ROLES_DOC" から取る。
   ```
4. 検証関数を書く。順に:
   - `jq -e` で JSON として妥当か。
   - トップレベルの許可キーは `review_mode` / `roles` / `config_home` / `global_config` /
     `project_config` / `runners_file` の 6 つだけ。それ以外があれば die。ただし path 系
     4 つは**値を一切参照しない**（診断用の metadata として通すだけ）。
     **とくに `runners_file` を参照先の決定に使わない**。registry は
     `RUNNERS_FILE="$(dispatch_runners_file)"` から独立に引く。
   - `review_mode` が `on` / `off`。
   - active ロール集合が `review_mode` と一致（on = 4 / off = 2）。
   - 各ロール: キー集合が `runner|engine|model|effort` の部分集合で `runner|engine|effort` は必須。
     `dispatch_valid_runner_name` / `dispatch_valid_model` / `dispatch_valid_effort` を通す。
     `engine` が `runners.json` の値と一致する。
     `dispatch_model_required` が真なら `model` が存在し非空（`null` は `jq` の `has` で真に
     なるので `type == "string"` で判定する）。
   - 違反はすべて `die`（exit 2）。**worktree 作成・`join.sh`・`delivery.sh set`・ペイン起動より
     前に**実行する。
5. 配置を固定表に置き換える。`set_exec_split_flags` と `EXEC_LAST_SURFACE` の動的計算を消し、
   次の 4 行にする:
   ```
   design        : workspace のメイン surface (--with-design)
   design_review : --standby-split-from <design> --standby-split-direction right
   exec          : --standby-split-from <design> --standby-split-direction down
   exec_review   : --standby-split-from <exec>   --standby-split-direction right
   ```
6. 各ロールの launch は `launch-workspace.sh --role <role> --runner <runner> --effort <effort>`
   を渡し、`model` キーがあるときだけ `--model <model>` を足す。**無いときはフラグごと付けない**。
7. `prewarm.json` の書き出しを新スキーマにする。`review_mode` を含める（Task 6 の renderer が
   不一致を検出するため）。`wired` は診断出力として `true` を書く（分岐に使わない）。
8. agmsg の join は 4 つの新 agent 名で行う。
9. `--unattended` × codex 親の die、`--agmsg-team` 必須、`--timeout-sentinel` の転送は**維持**。

- [ ] **Step 5: 既存 prewarm テストを更新**

- `test-prewarm-layout.sh`: PG1-PG3 の split 方向検査を固定表へ。PW1-PW10 のフラグ検査を
  `--roles` へ。
- `test-prewarm-all-codex.sh`: 「3 ペイン」を「review on なら 4 ペイン」に読み替える
  （all-Codex でも exec ペインは常に立つ）。
- `test-prewarm-unattended.sh` / `test-prewarm-design-permissions.sh`: フラグ名の追随。
- `test-in-session.sh`: **反転**する。ヘッダーの不変条件を
  `IS1. in-session 判定コードが存在しない / IS2. design と exec のロール設定が完全一致でも
  exec ペインが必ず立つ / IS3. prewarm.json に executors キーが現れない` に書き換え、
  同一 tuple の `roles.json` を渡して 4 ロールぶんの launch が組み立てられることを検査する。

- [ ] **Step 6: テストを走らせて通過を確認**

```bash
for f in test-roles-input test-pane-invariant test-prewarm-layout test-prewarm-all-codex \
         test-prewarm-unattended test-prewarm-design-permissions test-in-session; do
  bash "apps/cmux-team-dispatch-task/test/$f.sh" || echo "^^ $f FAILED"
done
```
Expected: すべて exit 0

- [ ] **Step 7: commit**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh \
        apps/cmux-team-dispatch-task/test
git commit -m "feat(dispatch)!: prewarm を --roles 入力・2/4 ペイン固定・4 ロール schema にする"
```

---

## Task 6: `render-loop-prompt.sh` と `loop-cleanup.sh`

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/render-loop-prompt.sh`
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/loop-cleanup.sh`
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/unattended/review-block.md`, `code-review-block.md`
- Create: `apps/cmux-team-dispatch-task/test/test-snapshot-contract.sh`
- Modify: `apps/cmux-team-dispatch-task/test/test-loop-prompt.sh`, `test-loop-cleanup.sh`, `test-cleanup-close.sh`

**Interfaces:**
- Consumes: Task 5 が書く `prewarm.json`
- Produces: `render-loop-prompt.sh --prewarm <path>`（ロール別フラグは全廃）。
  `loop-cleanup.sh` は `prewarm.json` 実在ロールの `agent` / `surface_id` を列挙する。

- [ ] **Step 1: 失敗するテストを書く（`test-snapshot-contract.sh`）**

```bash
#!/usr/bin/env bash
#   SC1. reviewer の --add-dir が STATUS_DIR/review に狭まっている
#   SC2. 3 consumer が対象 JSON を 1 回だけ内容として読む (再読しない)
#   SC3. prewarm.json の agent がロール名と対応しないと拒否
#   SC4. surface_id / workspace_id が空だと拒否
#   SC5. wired が boolean true でないと拒否
#   SC6. cleanup は workspace_id を独立値と照合してから close する
#   SC7. SKILL.md に prewarm.json の生読みが残っていない
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
S="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts"
SKILL="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/SKILL.md"
fail=0; bad() { echo "FAIL $1"; fail=1; }; ok() { echo "PASS $1"; }

# SC1
grep -q "add-dir '\$STATUS_DIR/review'" "$S/launch-workspace.sh" \
  && ! grep -q "add-dir '\$STATUS_DIR'" "$S/launch-workspace.sh" \
  && ok 'SC1: reviewer の書き込み許可が review/ に狭まっている' || bad 'SC1'

# SC2: 対象ファイルへの jq/cat が 1 回だけであることの静的検査
for pair in "prewarm-panes.sh:ROLES_FILE" "render-loop-prompt.sh:PREWARM_FILE" "loop-cleanup.sh:PREWARM_FILE"; do
  f="${pair%%:*}"; v="${pair##*:}"
  n=$(grep -c "\"\$$v\"" "$S/$f" 2>/dev/null || echo 0)
  if [[ "$n" -le 1 ]]; then ok "SC2: $f は $v を 1 回しか読まない"; else bad "SC2: $f が $v を $n 回読む"; fi
done

# SC3-SC5 は renderer と cleanup の早期 exit で検査する
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/prewarm.json" <<'JSON'
{"workspace_id":"workspace:1","review_mode":"on",
 "design":{"surface_id":"s1","agent":"t","runner":"ccf","engine":"claude","model":"opus[1m]","effort":"xhigh","wired":true},
 "design_review":{"surface_id":"s2","agent":"t-design-review","runner":"ccf","engine":"claude","model":"opus[1m]","effort":"xhigh","wired":true},
 "exec":{"surface_id":"s3","agent":"t-exec","runner":"ccf","engine":"claude","model":"sonnet","effort":"high","wired":true},
 "exec_review":{"surface_id":"s4","agent":"t-exec-review","runner":"ccf","engine":"claude","model":"opus[1m]","effort":"high","wired":true}}
JSON
bad_prewarm() { jq "$1" "$TMP/prewarm.json" > "$TMP/bad.json"; }
render() { bash "$S/render-loop-prompt.sh" --prewarm "$1" --slug t --issue 1 --issue-title x \
  --issue-url u --issue-body-file /dev/null --plan-hint h --status-dir "$TMP" \
  --timeout-sentinel "$TMP/s" --team tm --layout workspace --parent-workspace w \
  --skill-dir "$S/.." >/dev/null 2>&1; }
bad_prewarm '.design_review.agent = "parent"';  render "$TMP/bad.json"; [[ $? -ne 0 ]] && ok 'SC3: 別ロールの agent 名を拒否' || bad 'SC3'
bad_prewarm '.design.surface_id = ""';          render "$TMP/bad.json"; [[ $? -ne 0 ]] && ok 'SC4: 空 surface_id を拒否' || bad 'SC4'
bad_prewarm '.design.wired = "true"';           render "$TMP/bad.json"; [[ $? -ne 0 ]] && ok 'SC5: 文字列 "true" を拒否' || bad 'SC5'

# SC6
grep -q 'workspace_id' "$S/loop-cleanup.sh" \
  && grep -qE 'workspace list|EXPECTED_WORKSPACE|\$CMUX_WORKSPACE_ID' "$S/loop-cleanup.sh" \
  && ok 'SC6: cleanup が workspace_id を照合する' || bad 'SC6'

# SC7
grep -q 'prewarm.json"' "$SKILL" && bad 'SC7: SKILL.md に prewarm.json の生読みが残っている' \
  || ok 'SC7: SKILL.md の prewarm.json 読み取りが契約に沿っている'
exit $fail
```

**注**: SC7 は Task 7 で SKILL.md を書き換えるまで赤い。Task 6 の時点では SC1-SC6 が緑なら可。

- [ ] **Step 2: `test-loop-prompt.sh` を書き換える**

```bash
#   LP1. --prewarm が必須。旧 --review-* / ロール別フラグは die
#   LP2. phase block は design engine で選ばれる (design/exec が異なる 2 方向)
#   LP3. 4 状態: review 0 件 / 2 件 / exec_review 欠落 / design_review 欠落
#   LP4. review_mode=on なのに review ロールが欠けると stderr に警告 (die はしない)
#   LP5. codex の design / exec は model 省略で成功、active review の model 欠落は die
```

LP2 の具体:

```bash
mk_prewarm() { # $1=design engine $2=exec engine
  jq -n --arg de "$1" --arg ee "$2" '{
    workspace_id:"w", review_mode:"off",
    design:{surface_id:"s1",agent:"t",runner:"r1",engine:$de,model:"m",effort:"xhigh",wired:true},
    exec:{surface_id:"s2",agent:"t-exec",runner:"r2",engine:$ee,model:"m",effort:"high",wired:true}}'
}
mk_prewarm claude codex > "$TMP/p.json"
out=$(render_ok "$TMP/p.json")
grep -q 'Claude design runner' <<<"$out" && ok 'LP2a: design=claude で claude の phase block' || bad 'LP2a'
mk_prewarm codex claude > "$TMP/p.json"
out=$(render_ok "$TMP/p.json")
grep -q 'Codex design runner' <<<"$out" && ok 'LP2b: design=codex で codex の phase block' || bad 'LP2b'
```

LP3 / LP4 の具体:

```bash
# review 2 件 -> 両ブロック
out=$(render_ok "$FULL_ON"); grep -q 'design-review' <<<"$out" && grep -q 'exec-review' <<<"$out" \
  && ok 'LP3a: 両ブロック' || bad 'LP3a'
# exec_review だけ欠落 -> design_review ブロックのみ + 警告
jq 'del(.exec_review)' "$FULL_ON" > "$TMP/p.json"
out=$(render_ok "$TMP/p.json"); err=$(render_err "$TMP/p.json")
grep -q 'design-review' <<<"$out" && ! grep -q 'exec-review' <<<"$out" \
  && grep -qi 'warn' <<<"$err" && ok 'LP3b/LP4a: exec_review 欠落で片方だけ + 警告' || bad 'LP3b/LP4a'
# design_review だけ欠落 -> 対称
jq 'del(.design_review)' "$FULL_ON" > "$TMP/p.json"
out=$(render_ok "$TMP/p.json")
grep -q 'exec-review' <<<"$out" && ! grep -q 'design-review' <<<"$out" \
  && ok 'LP3c: design_review 欠落で対称に振る舞う' || bad 'LP3c'
# review off + 0 件 -> 警告なし
err=$(render_err "$FULL_OFF")
grep -qi 'warn' <<<"$err" && bad 'LP4b: off なのに警告が出た' || ok 'LP4b: off では警告なし'
```

- [ ] **Step 3: `render-loop-prompt.sh` を改修**

1. `--design-runner` / `--design-engine` / `--exec-runner` / `--exec-engine` / `--review` /
   `--review-model` / `--review-runner` / `--review-engine` / `--review-pane-agent` /
   `--exec-choice` を**すべて削除**し、渡されたら die する。
2. `--prewarm <path>` を必須にする。`PREWARM_DOC=$(cat "$PREWARM_FILE")` で 1 回だけ読む。
3. `config-lib.sh` を source して Task 5 と同じ検証を行う。加えて `agent` のロール対応・
   非空 `surface_id` / `workspace_id`・`wired === true`・型・許可外キーを検査する。
4. `phase=$(cat "$REF_DIR/phase-block-$DESIGN_ENGINE.md")` は**そのまま**（`DESIGN_ENGINE` は
   `.design.engine` から取る）。
5. ブロックの出力規則: `.design_review` があれば `review-block.md`、`.exec_review` があれば
   `code-review-block.md`。`review_mode == "on"` なのにどちらかが無ければ **stderr に警告**
   （`[warn] render-loop-prompt: review_mode is on but role '<role>' is absent from prewarm.json;
   its review gate will be skipped`）。die はしない。
6. ヘッダー行の出力を 4 ロールぶんに増やす（`Design runner` / `Design engine` /
   `Exec runner` / `Exec engine` に加えて、存在するとき `Design review agent` などを出す）。

- [ ] **Step 4: `unattended/review-block.md` と `code-review-block.md` を更新**

`review-block.md` は Phase A-R が `design_review` ペイン宛であること、
`code-review-block.md` は Phase B-R が `exec_review` ペイン宛であることを明示する。
**英語で書く**（`references/` 配下は `*-ja.md` 以外は英語必須）。

- [ ] **Step 5: `loop-cleanup.sh` を改修**

1. `PREWARM_DOC=$(cat "$PREWARM_FILE")` で 1 回だけ読み、以後再読しない。
2. Task 5 / Step 4 と同じ検証を通す。
3. `agent` と `surface_id` を**実在ロールから列挙**する:
   ```bash
   AGENTS=$(jq -r '. as $d | ["design","design_review","exec","exec_review"]
                   | map(select($d[.] != null) | $d[.].agent) | .[]' <<<"$PREWARM_DOC")
   ```
4. **workspace 照合**: `prewarm.json` の `workspace_id` が、cleanup が独立に知っている値
   （引数、または `cmux workspace list` を `[<slug>]` でリテラル一致して引いた値）と一致
   しなければ close を行わず警告する。
5. `close-surface --workspace` 必須の既存規約は維持する。

- [ ] **Step 6: テストを走らせて通過を確認**

```bash
bash apps/cmux-team-dispatch-task/test/test-loop-prompt.sh
bash apps/cmux-team-dispatch-task/test/test-loop-cleanup.sh
bash apps/cmux-team-dispatch-task/test/test-cleanup-close.sh
bash apps/cmux-team-dispatch-task/test/test-snapshot-contract.sh   # SC7 は Task 7 まで赤で可
```

- [ ] **Step 7: commit**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts \
        apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/unattended \
        apps/cmux-team-dispatch-task/test
git commit -m "feat(dispatch)!: loop の renderer と cleanup を prewarm.json 起点の 4 ロール対応にする"
```

---

## Task 7: `SKILL.md` と `guide-ja.md`

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md`
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md`

**Interfaces:**
- Consumes: Task 2 の `config-resolve.sh` CLI、Task 5 の `prewarm.json` スキーマ、Task 4 の `--role` 値域
- Produces: 子セッションへ埋め込む placeholder 名（Task 9 / 10 のドキュメントが参照する）

- [ ] **Step 1: Step 1f を書き換える（`SKILL.md:223-340`）**

対話フローを全削除し、次に置き換える（**英語で書く**）:

```markdown
### 1f. Resolve Roles

Every role is fixed by configuration. There is no interactive resolution at dispatch time.

1. If `$(bash <SKILL_DIR>/scripts/config-lib.sh …)`'s runners file does not exist, run
   **First-run setup** (see below), then continue.
2. Resolve all four roles with one call:

   ```bash
   ROLES_JSON="<STATUS_DIR>/roles.json"
   bash <SKILL_DIR>/scripts/config-resolve.sh --project-root "$(git rev-parse --show-toplevel)" \
     > "$ROLES_JSON" || exit 1
   ```

3. `config-resolve.sh` exits 2 when a role has no usable runner, or when a codex review role
   has no model. Stop and tell the user to run the skill with `--setup`. Do not create panes.
4. Read every role value from `$ROLES_JSON`. Do not re-derive them anywhere else.
```

削除するもの: switch 質問（4 択 / 3 択）、タスクごとの runner 質問、
「常に既定 / 常に固定」の永続化 2 択、`valid_design_runner()`、
`PLAN_MODEL` / `PLAN_EFFORT` の inline jq、independent review role の解決節（5 番）。

- [ ] **Step 2: Step 1g を書き換える（`SKILL.md:562-946`）**

- 節タイトルを `### 1g. Resolve Delivery and Review Mode` にする。
- **維持**: agmsg hard requirement ブロック、`verify-agmsg-ready.sh` の分岐、codex 親に
  タイマーが無い旨、unattended × codex 親の拒否、Delivery contract、label 表、
  `join.sh` の配線、`[ready]` プロトコル、完了通知ブロック。
- **削除**: `review_mode` の 4 択 AskUserQuestion と jq merge 永続化、`exec_choice` の解決、
  `resolve_exec_runner()`、`valid_exec_choice()`、`IN_SESSION` 判定ブロック、
  `CLAUDE_EXEC_RUNNER` / `CODEX_EXEC_RUNNER`。
- `REVIEW_ENABLED` は `jq -r '.review_mode' "$ROLES_JSON"` が `on` かどうかで決める。
- child の agmsg join は 4 つの新 agent 名で行う。

- [ ] **Step 3: Step 1g-2（`--override`）を書き換える（`SKILL.md:947-1016`）**

- Call 2 の選択肢を `design` / `design_review` / `exec` / `exec_review` にする。review 2 つは
  `review_mode=on` のときだけ提示する。
- Call 3 の 3 問はそのまま。**回答は pending tuple として扱う**旨と、runner 変更で
  engine が変わったときに runner / model / effort の 3 次元を再検証し、不正になった次元だけを
  再質問し、2 回目も不正ならそのロールの変更を丸ごと破棄する旨を書く。
- 自由入力は**コマンドを組み立てる前に**検証する旨を明記する（`'` `"` `` ` `` `$` `\` `!`・
  制御文字・空・前後空白を拒否して再質問）。
- 結果の適用:
  ```bash
  bash <SKILL_DIR>/scripts/config-resolve.sh --project-root "$ROOT" \
    --set exec.model=<v> --set exec.effort=<v> > "$ROLES_JSON"
  ```
- 「Step 1f の switch 質問との関係」表を**削除**する。

- [ ] **Step 4: placeholder を改名する**

| 旧 | 新 |
|----|----|
| `{{PLAN_MODEL}}` / `{{PLAN_EFFORT}}` | `{{DESIGN_MODEL}}` / `{{DESIGN_EFFORT}}` |
| `{{REVIEW_MODEL}}` / `{{REVIEW_EFFORT}}` / `{{REVIEW_ENGINE}}` | `{{DESIGN_REVIEW_MODEL}}` / `{{DESIGN_REVIEW_EFFORT}}` / `{{DESIGN_REVIEW_ENGINE}}` |
| `{{REVIEW_PANE_AGENT}}` | `{{DESIGN_REVIEW_AGENT}}` |
| — | `{{EXEC_REVIEW_MODEL}}` / `{{EXEC_REVIEW_EFFORT}}` / `{{EXEC_REVIEW_ENGINE}}` / `{{EXEC_REVIEW_AGENT}}` |
| `{{EXEC_MODEL}}` / `{{EXEC_EFFORT}}` | 同名で維持 |
| `{{EXEC_DEFAULT_HINT}}` / `{{CODEX_OPTION_LINE}}` | **削除** |

Phase A-R の依頼先は `{{DESIGN_REVIEW_AGENT}}`、Phase B-R の依頼先は `{{EXEC_REVIEW_AGENT}}` に
なる。生成されるタスクプロンプトの `PHASE B` から AskUserQuestion を削除し、常に
`exec` ペインへ委譲する形にする。

- [ ] **Step 4b: レビュー 2 ロール化と `code-review.json` の gating（spec §5）**

- `REVIEW_POLICY` / `resolve_code_reviewer_for_choice` / legacy cross-engine resolver の記述を
  **すべて削除**する。設計セッションがレビュアーへ転じる分岐（`:1619`, `:1648`, `:1666`,
  `:1851`, `:1907` 付近）も消し、設計ペインは**常に** `.deferred` を作って exit する形にする。
- Phase A-R は `design_review` ペインが spec / plan の 2 ポイントで再利用される。
- Phase B-R は `exec_review` ペインが担当する。`review/code-review.json` は常に `exec_review` の
  解決値で埋める（`reviewer_surface` / `reviewer_agent` / `reviewer_runner` / `reviewer_engine` /
  `reviewer_workspace` / `review_dir` のフィールド自体は配線情報として残す）。
- **gating**: `code-review.json` を書き `--review-config` を渡すのは、`prewarm.json` に
  `exec_review` が存在する（= ペインの起動と readiness が成功した）ときだけ。存在しなければ
  **両方とも省略**して Phase B-R の gate だけをスキップし、警告を出す。到達不能な surface /
  agent を書いた JSON を残すと、実装者が永遠に来ない verdict を待つ。
- 「`review_mode=on` だが capable reviewer が解決できない」ケースの警告フォールバック記述は
  削除する（Task 2 の fail-fast に統合済み）。ペイン spawn 失敗時に当該 gate だけを警告して
  スキップする挙動は**維持**する。

- [ ] **Step 5: prewarm 節と `prewarm.json` 読み取りを書き換える（`SKILL.md:2200-2350` ほか）**

- `PREWARM` 設定キーの読み取り（`:2202-2210`）を削除し、prewarm は常時 on と書く。
- `IF prewarm.json is absent, fall back to spawn` のブロックを**すべて削除**する
  （`:1234`, `:1339`, `:1476`, `:2007` 付近）。
- `prewarm.json` を読む 5 箇所（`:1202`, `:1475`, `:1977`, `:2789`, `:2832`）を新スキーマへ更新し、
  **検証済みスナップショット契約**に従わせる: 1 回だけ `PREWARM_DOC=$(cat …)` で読み、
  以後は `<<<"$PREWARM_DOC"` で jq する。
- `prewarm-panes.sh` の呼び出しを `--roles "$ROLES_JSON"` 1 本にする。
- 2/4 ペインの固定表を図で書く。

- [ ] **Step 6: First-run setup を書き換える（`SKILL.md:479-536`）**

- `runners.json` を書いたあと、**通常モードのときだけ**初期 `config.json` をグローバルへ書く。
  reset mode（`--reset runners` 由来）では書かない。
- 初期 config の中身:
  - `runner.<role>.runner` は 4 ロールとも `runners.json` の `default` を入れる。**これが
    `default` の唯一の読み手**である。
  - `runner.<role>.model` と `runner.<role>.effort` は書かない（組込み既定値に任せる）。
  - **例外**: `default` が codex engine の runner のとき、`design_review` と `exec_review` は
    model 必須なので、**2 つの review ロールぶんの model を 1 コールで聞いて書く**。聞かないと
    初回生成した config が Task 2 の fail-fast に必ず引っかかり、ディスパッチが 1 度も動かない。
    `default` が claude engine なら既定値 `opus[1m]` が埋まるので聞かない。
  - `review_mode` は **1 回だけ聞く**（`on` / `off` の 2 択）。D3 でディスパッチ時の質問が
    消えた以上、値の初回決定はここか `--setup` しか無い。
- `runners.json` へ書く runner レコードから `plan_model` / `review_model` / `exec_model` /
  `plan_effort` / `review_effort` / `exec_effort` の 6 フィールドを**削除**する
  （`name` / `command` / `engine` と `default` だけを書く）。

- [ ] **Step 7: Setup / Reset の委譲節を更新**

`## Setup Mode` / `## Reset Mode` は短い委譲節のままにし、`references/setup-mode.md` を指す。
`--reset config` が 2 キーを消すこと、`--reset all` が両レイヤーを消すことだけ 1 行ずつ書く。

- [ ] **Step 8: `guide-ja.md` を 1:1 で追随させる**

SKILL.md の見出しと 1:1 対応を保つ。SKILL.md に対応節が無い日本語解説は末尾の
「補足（SKILL.md に対応セクションなし）」へまとめる。`ターミナル起動待機の自動学習` の
config パス記述（`:879`, `:1733`, `:1754`, `:1809`, `:1810`, `:1818`, `:1952`）を新パスへ更新する。

- [ ] **Step 9: 検証**

```bash
pnpm check:doc-lang
bash apps/cmux-team-dispatch-task/test/test-skill-script-refs.sh
bash apps/cmux-team-dispatch-task/test/test-snapshot-contract.sh   # SC7 がここで緑になる
bash apps/cmux-team-dispatch-task/test/test-delivery-callsites.sh  # CS3 / CS5-CS7
```

- [ ] **Step 10: commit**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md \
        apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md
git commit -m "docs(dispatch)!: SKILL.md と guide-ja.md を 4 ロール契約へ更新する"
```

---

## Task 8: `setup-mode.md` / `setup-mode-ja.md`

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/setup-mode.md`（英語）
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/setup-mode-ja.md`（日本語）
- Modify: `apps/cmux-team-dispatch-task/test/test-setup-skill.sh`

**Interfaces:**
- Consumes: Task 3 の `config-edit.sh` CLI
- Produces: `--setup` / `--reset` の実行時 SoT

- [ ] **Step 1: S2 / S3 を再編する**

- **S2（書き込み先／対象）**: グローバル `config.json` / プロジェクト `config.json` /
  `runners.json` の 3 択。
- **`config.json` 対象のロール質問**: 1 コール目で `review_mode` と「どのロールを編集するか」
  （multiSelect、4 ロール）を聞く。選ばれたロールごとに 1 コールで runner / model / effort の
  3 問。`runners[]` が 5 件以上なら先頭 4 件 + 「Other」。
- **S3（`runners.json` 対象）**: 4 択から **3 択**へ（runner を追加 / レジストリを作り直す /
  そのまま）。「登録済み runner の model・effort を編集」を削除。
- **S3-M を丸ごと削除**: 候補プール表、M1 / M2 / M3、`####` 見出し 8 個、
  `*_model` 拒否条件の限定句。

- [ ] **Step 2: pending tuple の節を追加する**

runner / model / effort を 1 コールで聞く以上、runner の回答が engine を変えると他 2 次元が
不整合になりうる。次を明記する:

- 回答は pending tuple として保持し、runner の回答から決まる engine で 3 次元すべてを再検証する。
- 不正になった次元だけを再質問する。
- 2 回目も不正ならそのロールの tuple を丸ごと未変更にする。
- **全 pending 変更が有効になるまで書き込まない**。再質問の最中も `config.json` は不変。
- 自由入力は**コマンド構築前に**検証する（`'` `"` `` ` `` `$` `\` `!`・制御文字・空・前後空白）。

- [ ] **Step 3: 入口ごとの書き込み契約表を入れる**

spec §6 の表をそのまま英日に落とす。初期 config を書くのは「初回ディスパッチ」と
`--reset all` の 2 経路だけ。`--reset all` はレイヤー選択を持たず両レイヤーを消す。

- [ ] **Step 4: S6 / S7 を更新する**

- S6 プレビューは対象に応じた 1 ファイル。
- S7 の書き込みは `config-edit.sh` の 1 コールのみ。`runners-edit.sh` → `config-edit.sh` の
  順序規約を削除する。**S7 の温存 3 文**（`single atomic move` を含む文 /
  `mkdir -p .dispatch` の文 / shadow する旨の文）は逐語で維持する。
- `--reset config` を `--unset review_mode --unset runner` の 1 コールとして書く。

- [ ] **Step 5: `test-setup-skill.sh` を更新する**

- SU10-12 / SU14-16 の S3-M needle を、新しいロール質問節の needle へ置き換える。
- SU13 の「両スクリプトを名指す」担保を `config-edit.sh` のみへ。
- 追加: pending tuple の 3 負例（model / effort / 未登録 runner）が節に書かれていること、
  入口ごとの表が英日で同じ行数・同じ順であること、`--reset all` が両レイヤーを消す旨が
  英日にあること。

- [ ] **Step 6: 検証**

```bash
pnpm check:doc-lang
bash apps/cmux-team-dispatch-task/test/test-setup-skill.sh
```

- [ ] **Step 7: commit**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/setup-mode.md \
        apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/setup-mode-ja.md \
        apps/cmux-team-dispatch-task/test/test-setup-skill.sh
git commit -m "docs(dispatch)!: setup-mode を 4 ロールのロール質問へ再編し S3-M を削除する"
```

---

## Task 9: `loop-mode.md` / `loop-mode-ja.md`

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/loop-mode.md`（英語）
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/loop-mode-ja.md`（日本語）
- Modify: `apps/cmux-team-dispatch-task/test/test-loop-skill.sh`

- [ ] **Step 1: ロール語彙を更新する**

`design_runner` / `review_runner` / `exec_choice` / `review_mode: ask` への言及を消し、
4 ロールと `review_mode: on|off` に置き換える。`loop-mode.md:105` の
「Step 1g review_mode は call ② で事前設定」という記述は、`review_mode` が config 固定に
なったので「config から解決され、ループ中は固定」へ書き換える。

- [ ] **Step 2: renderer の呼び出しを `--prewarm` に更新する**

ループが `render-loop-prompt.sh` を呼ぶ箇所の引数を `--prewarm <STATUS_DIR>/prewarm.json` に
する。ロール別フラグの記述を消す。

- [ ] **Step 3: `loop.task_timeout_min` の位置を明記する**

`config.json` の第三者キーであり、`--reset config` で消えないことを 1 行書く。

- [ ] **Step 4: 検証**

```bash
pnpm check:doc-lang
bash apps/cmux-team-dispatch-task/test/test-loop-skill.sh
```

- [ ] **Step 5: commit**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/loop-mode.md \
        apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/loop-mode-ja.md \
        apps/cmux-team-dispatch-task/test/test-loop-skill.sh
git commit -m "docs(dispatch): loop-mode のロール語彙と renderer 呼び出しを更新する"
```

---

## Task 10: `README.md` とプラグイン `CLAUDE.md`

**Files:**
- Modify: `apps/cmux-team-dispatch-task/README.md`
- Modify: `apps/cmux-team-dispatch-task/CLAUDE.md`
- Modify: `apps/cmux-team-dispatch-task/test/test-doc-stale-vocab.sh`
- Modify: `apps/cmux-team-dispatch-task/test/test-delivery-callsites.sh`（CS4 をここで緑にする）

- [ ] **Step 1: `README.md` を更新する**

- 設定ファイルのパスを `~/.claude/config/cmux-team-dispatch-task/` へ（`:16`, `:427`, `:595`）。
- `config.json` / `runners.json` のスキーマ例を新しい形に差し替える。
- ペイン配置図を 2/4 の固定表にする。
- `--setup` の手順と `--override` の 4 ロール化を反映する。
- 「codex 選択肢は runners.json に codex runner があるときのみ」といった対話前提の記述を消す。

- [ ] **Step 2: プラグイン `CLAUDE.md` を更新する**

| 箇所 | 変更 |
|------|------|
| ファイル構成表（`:6-30`） | `runners-edit.sh` を削除、`config-lib.sh` / `config-resolve.sh` を追加、`render-loop-prompt.sh` と `loop-cleanup.sh` の説明を 4 ロールへ、config パスを新基準へ |
| 「role 解決の現行契約」（`:42-101`） | 全面書き換え。4 ロール、(role,field) 単位の合成、fail-fast、in-session と legacy の削除、2/4 ペイン固定、検証済みスナップショット契約 |
| 項目 8 | Phase B の質問と in-session 条件を削除 |
| 項目 10 | config 由来のロール解決へ |
| 項目 13 | prewarm.json の 4 ロールキーへ |
| 項目 17 / 18 | legacy policy 削除、review 2 ロール |
| 項目 19 | `design_runner` / `exec_choice` の precedence を、(role,field) 合成と fail-fast へ置換 |
| 項目 20 / 39 | reviewer の `--add-dir` が `<STATUS_DIR>/review` に狭まったことを反映 |
| 項目 26 | レイアウトを 2 パターンの固定表へ |
| 項目 28 | S3-M 削除、`config-edit.sh` の新 allowlist、2 キー reset |
| 項目 37 / 38 | **削除** |
| 項目 43 | S3-M 記述を新ロール質問へ |
| 項目 44 | 4 段 precedence、4 ロール、`config-edit.sh` のみ言及 |
| 項目 47 | `runners-edit.sh` と削除した分岐を反映 |
| E2E 節の項目 8 / 9 | **削除**（モデル選択の動的表示 / in-session 実行） |

- [ ] **Step 3: `test-doc-stale-vocab.sh` を更新する**

DS2 の旧語彙リストへ追加: `design_runner`、`review_runner`、`exec_choice`、
`prewarm` 設定キー、`review_mode` の `"ask"`、in-session、`REVIEW_POLICY`、legacy resolver、
`runners-edit.sh`、`plan_model` / `review_model` / `exec_model` / `plan_effort` /
`review_effort` / `exec_effort`、旧 config パス。
走査対象に**英語の `SKILL.md` と `references/unattended/*.md`** を明示的に含める。
DS3 のラチェット（リストが陳腐化していないこと）も更新する。

- [ ] **Step 4: CS4 ratchet を緑にする**

Task 3 で `runners-edit.sh` を削除済みリストへ入れたので、この時点で参照がゼロになっている
はず。`bash test/test-delivery-callsites.sh` を走らせて CS4 が PASS することを確認する。
残っていれば該当ファイルを直す。

- [ ] **Step 5: 検証**

```bash
pnpm check:doc-lang
bash apps/cmux-team-dispatch-task/test/test-doc-stale-vocab.sh
bash apps/cmux-team-dispatch-task/test/test-delivery-callsites.sh
```

- [ ] **Step 6: commit**

```bash
git add apps/cmux-team-dispatch-task/README.md apps/cmux-team-dispatch-task/CLAUDE.md \
        apps/cmux-team-dispatch-task/test
git commit -m "docs(dispatch)!: README とプラグイン CLAUDE.md を 4 ロール契約へ更新する"
```

---

## Task 11: バージョン 3.0.0 と全体検証

**Files:**
- Modify: `apps/cmux-team-dispatch-task/.claude-plugin/plugin.json`
- Modify: `apps/cmux-team-dispatch-task/.codex-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`（ルート）

- [ ] **Step 1: 3 箇所の version を `3.0.0` にする**

```bash
jq '.version = "3.0.0"' apps/cmux-team-dispatch-task/.claude-plugin/plugin.json > /tmp/p1 \
  && mv /tmp/p1 apps/cmux-team-dispatch-task/.claude-plugin/plugin.json
jq '.version = "3.0.0"' apps/cmux-team-dispatch-task/.codex-plugin/plugin.json > /tmp/p2 \
  && mv /tmp/p2 apps/cmux-team-dispatch-task/.codex-plugin/plugin.json
jq '(.plugins[] | select(.name == "cmux-team-dispatch-task") | .version) = "3.0.0"' \
  .claude-plugin/marketplace.json > /tmp/p3 && mv /tmp/p3 .claude-plugin/marketplace.json
```

3 箇所が一致していることを確認する:

```bash
jq -r '.version' apps/cmux-team-dispatch-task/.claude-plugin/plugin.json
jq -r '.version' apps/cmux-team-dispatch-task/.codex-plugin/plugin.json
jq -r '.plugins[] | select(.name=="cmux-team-dispatch-task") | .version' .claude-plugin/marketplace.json
```
Expected: 3 行とも `3.0.0`

- [ ] **Step 2: 全テストを走らせる**

```bash
for f in apps/cmux-team-dispatch-task/test/test-*.sh; do
  echo "=== $f ==="
  bash "$f" || echo "!!! FAILED: $f"
done
```
Expected: `!!! FAILED` が 1 件も出ない

- [ ] **Step 3: monorepo の検証を走らせる**

```bash
pnpm check
pnpm check:doc-lang
```
Expected: どちらも exit 0

- [ ] **Step 4: `result.md` を書く**

`/Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins/.dispatch/config-schema-4role/result.md`
に次のセクションで書く（**worktree 外のファイルなので、書き込みはこの 1 ファイルだけ**）:

```markdown
# config-schema-4role

## Changes Made
## Test Results
## Commits
## Migration steps for the user
```

`Migration steps for the user` には次を載せる:

```bash
mkdir -p ~/.claude/config/cmux-team-dispatch-task
mv ~/.claude/cmux-team-dispatch-task/runners.json ~/.claude/config/cmux-team-dispatch-task/
# config.json は旧スキーマなので移さず作り直す
rm -f ~/.claude/cmux-team-dispatch-task/config.json
rmdir ~/.claude/cmux-team-dispatch-task 2>/dev/null || true
# 4 ロールを対話で埋める
# /cmux-team-dispatch-task --setup
```

local-conf 側は、`~/.claude/config` が既に単一シンボリックリンクなので、
`~/.claude/cmux-team-dispatch-task` を指すリンクマニフェスト項目を**削除するだけ**でよい旨を書く。

- [ ] **Step 5: commit**

```bash
git add apps/cmux-team-dispatch-task/.claude-plugin/plugin.json \
        apps/cmux-team-dispatch-task/.codex-plugin/plugin.json \
        .claude-plugin/marketplace.json
git commit -m "chore(dispatch)!: バージョンを 3.0.0 へ上げる"
```

---

## 完了条件

1. `for f in apps/cmux-team-dispatch-task/test/test-*.sh; do bash "$f"; done` が全件 exit 0。
2. `pnpm check` と `pnpm check:doc-lang` が exit 0。
3. `git status --porcelain` に未コミットの変更が無い（`.codex/` などの untracked は除く）。
4. `grep -rn '\.claude/cmux-team-dispatch-task' apps/cmux-team-dispatch-task/` が 0 件。
5. `grep -rn 'design_runner\|review_runner\|exec_choice\|runners-edit\|REVIEW_POLICY' apps/cmux-team-dispatch-task/` が 0 件（`docs/` の履歴記述を除く）。
6. バージョンが 3 箇所とも `3.0.0`。
