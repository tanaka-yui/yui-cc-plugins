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
- **テストで悪意ある値を扱うときは必ずデータとして渡す**。`jq --arg v "$value" '.a.b = $v'` の形にし、シェル文字列やヒアドキュメントへ直接埋め込まない。`'` を含む値をシェルの単一引用の中に置くと**引用が閉じてテスト自身がコマンドを実行する**。副作用検出用の sentinel は `/tmp` ではなく `$TMP` 配下（`mktemp -d` の下）に置く。
- **テストループは失敗を集約する**。`for f in …; do bash "$f" || echo FAILED; done` は `echo` の rc 0 でループ全体が成功終了するので使わない。`fail=0; … || fail=1; …; exit $fail` の形にする。
- **`set -e` のテストファイルへ「非 0 を期待する呼び出し」を足すときは `if` で捕まえる**。`out=$(cmd)` の単純代入は `cmd` が非 0 を返した時点でファイル全体を終了させるので、`if out=$(cmd); then rc=0; else rc=$?; fi` の形にする。`test-launch-workspace-codex.sh` は `set -euo pipefail` で始まっている。
- **ハングし得る待機には必ず bounded watchdog を付ける**。FIFO の 2 回目の `open()` は EOF を返さず**次の writer を待って block** する。タイムアウトを持たない待機は、誤実装を「失敗」ではなく「無限ハング」にしてしまう。macOS に `timeout` は無いので、バックグラウンド起動 + 有限ループ + `kill` で自前に区切る。
- **assertion は「非 0」で満足しない**。必須引数の欠落など別の理由でも非 0 になるので、期待する rc と**メッセージの断片**の両方を検査する。逆に正例は「実際に走らせて成功すること」まで見る（fixture を作るだけで終わらせない）。

---

## File Structure

| パス | 区分 | 責務 |
|------|------|------|
| `skills/cmux-team-dispatch-task/scripts/config-lib.sh` | **新規** | source 専用。パス解決（`DISPATCH_CONFIG_HOME` / `RUNNERS_CONFIG_PATH`）、runner 名・model 値の検証、effort の小文字正規化と engine 別 allowlist、ロール名と組込み既定値の表 |
| `skills/cmux-team-dispatch-task/scripts/config-resolve.sh` | **新規** | ロール解決の唯一の読み手。project → global → 既定値を (role, field) 単位で合成し、engine を引き、`--set` を最優先で適用して JSON を 1 つ出す。fail-fast を持つ |
| `skills/cmux-team-dispatch-task/scripts/override-args.sh` | **新規** | `--override` の回答（pending tuple）を `config-resolve.sh` へ渡す `--set` 引数列へ変換する。**engine 整合が取れないロールは丸ごと破棄**して警告する。resolver の「フィールド単位の layer fallback」とは別の政策なので、別スクリプトに分ける |
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
reject_cases=( '' ' lead' 'trail ' "quo'te" 'dou"ble' 'back`tick' 'dol$lar' 'back\slash' 'bang!' )
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
  標準出力に次の形の JSON を 1 つ。**exit 0 = 成功 / 1 = 読み取り・パース失敗 / 2 = 検証エラー
  と fail-fast**。この 2 つは呼び出し側（Task 7）が別の分岐で扱うので、実装でも必ず分ける
  （2 は「`--setup` で直せる設定の誤り」、1 は「ファイルが読めない・JSON が壊れている」）。

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
#  CR14. 壊れた JSON / 読めないファイルは exit 1 (設定エラーの exit 2 と区別する)

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

# CR7: model のメタ文字は「当該レイヤーだけ無効化」であって resolver 全体の失敗ではない。
# 値は必ず jq --arg でデータとして渡す (シェルへ埋めるとテスト自身がコマンドを実行する)。
clear_project
write_global "$FULL_GLOBAL"
EVIL="a'; touch $TMP/pwn; #"
jq -n --arg v "$EVIL" '{runner:{design:{model:$v}}}' > "$PROJ/.dispatch/config.json"
out=$(run_resolve); rc=$?
if [[ $rc -eq 0 && "$(jq -r '.roles.design.model' <<<"$out")" == 'opus[1m]' ]]; then
  ok 'CR7a: メタ文字入り model は当該レイヤーだけ無効化され global へ落ちる'
else
  bad "CR7a: rc=$rc model=$(jq -r '.roles.design.model' <<<"$out")"
fi
grep -qF -- "$EVIL" <<<"$out" && bad 'CR7b: 不正 model が出力に残った' || ok 'CR7b: 不正 model は出力に残らない'
[[ -e "$TMP/pwn" ]] && bad 'CR7c: テストが副作用を起こした' || ok 'CR7c: 副作用なし'

# CR13: --runners による registry の個別指定
clear_project; write_global "$FULL_GLOBAL"
cat > "$TMP/alt-runners.json" <<'JSON'
{"default":"ccf","runners":[{"name":"ccf","command":"ccf","engine":"claude"},
                            {"name":"cx","command":"codex","engine":"codex"}]}
JSON
out=$(bash "$RESOLVE" --project-root "$PROJ" --runners "$TMP/alt-runners.json" 2>"$TMP/err")
[[ $? -eq 0 && "$(jq -r '.runners_file' <<<"$out")" == "$TMP/alt-runners.json" ]] \
  && ok 'CR13: --runners が registry のパスを差し替える' || bad "CR13: $(cat "$TMP/err")"

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

# CR14: 読み取り・パース失敗は exit 1 (設定エラーの exit 2 と区別する)
clear_project; write_global "$FULL_GLOBAL"
printf 'not json at all\n' > "$PROJ/.dispatch/config.json"
run_resolve >/dev/null; [[ $? -eq 1 ]] && ok 'CR14a: 壊れた project config は exit 1' || bad 'CR14a'
clear_project
printf '{ broken\n' > "$DISPATCH_CONFIG_HOME/runners.json"
run_resolve >/dev/null; [[ $? -eq 1 ]] && ok 'CR14b: 壊れた runners.json は exit 1' || bad 'CR14b'
rm -f "$DISPATCH_CONFIG_HOME/runners.json"
run_resolve >/dev/null; [[ $? -eq 2 ]] && ok 'CR14c: runners.json 不在は exit 2 (setup で直せる)' || bad 'CR14c'
write_runners

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

# 検証エラー / fail-fast (呼び出し側は --setup を案内する)
die() { echo "config-resolve: $1" >&2; exit 2; }
# 読み取り・パース失敗 (設定内容の問題ではないので --setup を案内しない)
die_read() { echo "config-resolve: $1" >&2; exit 1; }
warn() { echo "[warn] config-resolve: $1" >&2; }
```

`die_read`（exit 1）を使うのは: `runners.json` / `config.json` が存在するのに**読めない**、
または**壊れた JSON**である（`jq -e . <file>` が失敗する）場合。

`die`（exit 2）を使うのは: ロールの `runner` が未設定 / `runners.json` に不在、codex の
review ロールに `model` が無い、`--project-root` 未指定などの使用法エラー、そして
**`runners.json` 自体が存在しない**場合（First-run setup で直せるため）。

`config.json` の**不在はエラーではない**。そのレイヤーが未設定というだけである。

処理順:

1. 引数を読む。受け付けるのは `--project-root <dir>`（必須）、`--runners <path>`（任意。
   省略時は `dispatch_runners_file`。**出力の `runners_file` には実際に使ったパスを書く**）、
   `--set <role>.<field>=<value>`（繰り返し可）の 3 つだけ。それ以外は exit 2。
   `--set` は連想配列を使わず `OVERRIDE_design_model` のような変数名で保持する
   （bash 3.2 に連想配列は無い）。role と field は allowlist 済みなので変数名へ埋めてよい。
2. `review_mode` を解決する。レイヤーは `--set review_mode` は無い（`--override` に review_mode は無い）ので project → global → 既定 `on`。各レイヤーは `jq -r 'if (.review_mode|type)=="string" then .review_mode else empty end'` で読み、値が `on` / `off` でなければ `warn` して次へ。
3. active なロール集合を決める（`on` なら 4 つ、`off` なら `design` と `exec`）。
4. 各ロール・各フィールドについて、`--set` → project → global の順に最初の**妥当な**値を採る。
   - `runner`: `dispatch_valid_runner_name` を通り、かつ `runners.json` に実在すること。不正なら `warn` して次のレイヤーへ。
   - `model`: `dispatch_valid_model` を通ること。加えて engine が codex のとき `opus[1m]` /
     `sonnet` / `fable` のいずれかなら `warn` して次のレイヤーへ。**検証に落ちた値で resolver
     全体を止めない**（レイヤー単位の無効化。spec §3 の非対称の説明を参照）。不正値が出力へ
     残らないことだけが要件である。
   - `effort`: `dispatch_normalize_effort` の後 `dispatch_valid_effort <v> <engine>` を通ること。
   - engine は `runner` 決定後に `runners.json` から引く。したがって**`runner` を先に解決してから** model / effort を解決する。
5. `runner` がどのレイヤーからも決まらなければ die（exit 2）。メッセージは
   `role '<role>' has no usable runner; run the skill with --setup` の形。
6. `model` が決まらず `dispatch_model_required <role> <engine>` が真なら die。偽ならキーを出力しない。
7. `effort` は最後に `dispatch_default_effort <role>` で必ず埋まる。
8. `jq -n` で JSON を組み立てて stdout へ出す。`model` の有無は `jq` の引数で分岐させる（`--argjson m 'null'` にせず、キーを足すかどうかで分ける）。

`runners.json` が無い場合は `die`（exit 2。`runners.json not found at <path>; run the skill to
perform first-run setup`）。**壊れた JSON や読めないファイルは `die_read`（exit 1）**。

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

## Task 2b: `override-args.sh`（`--override` の引数ビルダー）

**Files:**
- Create: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/override-args.sh`
- Test: `apps/cmux-team-dispatch-task/test/test-override-args.sh`

**Interfaces:**
- Consumes: Task 1 の `config-lib.sh`、Task 2 の `config-resolve.sh` が出す `roles.json`
- Produces:
  ```
  override-args.sh --roles <resolved.json> [--runners <path>] \
                   --pending <role>.<field>=<value> ...
  ```
  標準出力に `--set <role>.<field>=<value>` の並びを **NUL 区切り**で出す
  （値に空白が入りうるため。呼び出し側は `while IFS= read -r -d ''` で配列へ読む）。
  exit 0 = 成功（破棄が起きても 0）、2 = 使用法エラー。

**なぜ別スクリプトなのか**（R4 #1）。`config-resolve.sh` の契約は
**フィールド単位のレイヤー無効化**である（不正な 1 つを捨てて次のレイヤーへ落とす）。
一方 `--override` の契約は**ロール単位の丸ごと破棄**である（runner を変えたら engine が変わり、
model と effort がその engine と整合しなければ、そのロールの変更は部分適用してはならない）。
この 2 つを同じスクリプトに入れると、どちらの規則が効いているのか呼び出し側から分からなくなる。
SKILL.md の散文に置くとテストできない。

**破棄の規則:**

1. `--pending <role>.runner=<v>` があれば、その `<v>` から engine を引く。無ければ
   `roles.json` の `.roles.<role>.engine` を使う。
2. その engine で `<role>` の 3 次元を検証する（runner は registry 実在、model は
   `config-lib.sh` の検証 + codex への claude エイリアス禁止 + codex review の非空、
   effort は engine 別 allowlist）。
3. **1 つでも不正なら、そのロールの `--set` を 1 つも出さない**。stderr に
   `[warn] override-args: dropping the whole override for role '<role>' (<次元>: <理由>)`
   を出す。他のロールの `--set` は出す。
4. 「変更なし」を表す空値の `--pending` は無視する（`--set` を出さない）。

- [ ] **Step 1: 失敗するテストを書く**

```bash
#!/usr/bin/env bash
#   OA1. 有効な 3 次元は 3 本の --set になる
#   OA2. 不正な model があるとそのロールの --set が 1 本も出ない (有効な effort も出ない)
#   OA3. 不正な effort でも同じ
#   OA4. 未登録 runner でも同じ
#   OA5. 破棄されるのは当該ロールだけで、他ロールの --set は残る
#   OA6. 空値の --pending は無視される
#   OA7. 出力は NUL 区切りで、値に空白が入っても壊れない
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OA="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/override-args.sh"
fail=0; bad() { echo "FAIL $1"; fail=1; }; ok() { echo "PASS $1"; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/runners.json" <<'JSON'
{"default":"ccf","runners":[{"name":"ccf","command":"ccf","engine":"claude"},
                            {"name":"cx","command":"codex","engine":"codex"}]}
JSON
cat > "$TMP/roles.json" <<'JSON'
{"review_mode":"on","roles":{
 "design":{"runner":"ccf","engine":"claude","model":"opus[1m]","effort":"xhigh"},
 "design_review":{"runner":"ccf","engine":"claude","model":"opus[1m]","effort":"xhigh"},
 "exec":{"runner":"ccf","engine":"claude","model":"sonnet","effort":"high"},
 "exec_review":{"runner":"ccf","engine":"claude","model":"opus[1m]","effort":"high"}}}
JSON
args() {  # 出力を配列へ読む
  OUT=()
  while IFS= read -r -d '' a; do OUT+=("$a"); done < <(
    bash "$OA" --roles "$TMP/roles.json" --runners "$TMP/runners.json" "$@" 2>"$TMP/err")
}
has() { printf '%s\n' "${OUT[@]}" | grep -qFx -- "$1"; }

# OA1
args --pending design.runner=cx --pending design.model=gpt-5.6-sol --pending design.effort=xhigh
{ has '--set' && has 'design.runner=cx' && has 'design.model=gpt-5.6-sol' \
  && has 'design.effort=xhigh'; } && ok 'OA1: 有効な 3 次元がそのまま出る' || bad "OA1: ${OUT[*]}"

# OA2 / OA3 / OA4 / OA5: 不正な 1 次元でロール丸ごと破棄。有効な別次元も出ない。
#   design には有効な変更を同時に渡し、そちらは残ることを見る。
for bad_case in model effort runner; do
  case "$bad_case" in
    model)  drop=(--pending exec.runner=cx --pending 'exec.model=opus[1m]') ;;  # codex に claude alias
    effort) drop=(--pending exec.runner=cx --pending exec.effort=max) ;;        # codex に max は無い
    runner) drop=(--pending exec.runner=nope) ;;                                # 未登録
  esac
  args --pending design.model=KEPT "${drop[@]}" --pending exec.effort=medium
  if has 'design.model=KEPT' \
     && ! printf '%s\n' "${OUT[@]}" | grep -q '^exec\.' \
     && grep -qi 'dropping the whole override' "$TMP/err"; then
    ok "OA2-4/OA5-$bad_case: exec は丸ごと破棄され design は残る"
  else
    bad "OA2-4/OA5-$bad_case: ${OUT[*]}"
  fi
done

# OA6
args --pending design.model=
printf '%s\n' "${OUT[@]}" | grep -q '^design\.model=' && bad 'OA6: 空値を --set にした' \
  || ok 'OA6: 空値の --pending は無視される'

# OA7
args --pending 'design.model=gpt 5 sol'
has 'design.model=gpt 5 sol' && ok 'OA7: 空白を含む値が 1 要素として渡る' || bad "OA7: ${OUT[*]}"
exit $fail
```

- [ ] **Step 2: テストを走らせて失敗を確認**

Run: `bash apps/cmux-team-dispatch-task/test/test-override-args.sh`
Expected: `override-args.sh` が無く全件 FAIL

- [ ] **Step 3: `override-args.sh` を実装**

`config-lib.sh` を source し、`--pending` をロールごとに集めて上の 4 規則を適用する。
出力は `printf '%s\0'` で `--set` と `<role>.<field>=<value>` を交互に出す。

- [ ] **Step 4: テストを走らせて通過を確認 → commit**

```bash
bash apps/cmux-team-dispatch-task/test/test-override-args.sh
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/override-args.sh \
        apps/cmux-team-dispatch-task/test/test-override-args.sh
git commit -m "feat(dispatch): --override の引数ビルダーを override-args.sh へ切り出す"
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

# CE12d: --unset runner.<role> はそのロールだけ消し、他ロールを温存する
reset_config
printf '%s\n' '{"runner":{"design":{"runner":"ccf","model":"opus[1m]"},
"exec":{"runner":"cx","effort":"high"}},"review_mode":"on"}' > "$C"
bash "$EDIT" --config "$C" --unset runner.design >/dev/null 2>&1
if [[ "$(jq -r '.runner | has("design")' "$C")" == 'false' \
   && "$(jq -r '.runner.exec.runner' "$C")" == 'cx' \
   && "$(jq -r '.runner.exec.effort' "$C")" == 'high' \
   && "$(jq -r '.review_mode' "$C")" == 'on' ]]; then
  ok 'CE12d: --unset runner.<role> はそのロールだけ消す'
else
  bad "CE12d: $(cat "$C")"
fi

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
for v in '' ' x' 'x ' "q'uote" 'd"q' 'b`t' 'd$l' 'b\s' 'bang!'; do
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

**probe の作り方が load-bearing である。** `launch-workspace.sh` は `:342` で
`workspace name is required` を先に die するので、`--runner nope` だけを渡すと runner 解決へ
到達しない。既存の `test-role-models.sh:64-76` と同じ「stub 済みで他は妥当な呼び出し」を使い、
`--runner` にだけ不正値を入れて、runners path を含むエラーメッセージを見る。

```bash
#!/usr/bin/env bash
# D6 のパスヘルパーが全 consumer へ届いていることの検査。
#
#   CP1. launch-workspace.sh が RUNNERS_CONFIG_PATH 未設定時に新しい既定 base を使う
#   CP2. RUNNERS_CONFIG_PATH を設定するとそちらを使う (既存 14 テストの互換)
#   CP3. terminal-wait.sh が DISPATCH_CONFIG_HOME 配下の config.json を使う
#   CP4. 旧パス ~/.claude/cmux-team-dispatch-task への参照がスクリプトに残らない
#
# CP2 は変更前から PASS しうる (既存実装も RUNNERS_CONFIG_PATH を尊重する)。
# red を作るのは CP1 / CP3 / CP4 である。

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
S="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts"
LAUNCH="$S/launch-workspace.sh"
fail=0
bad() { echo "FAIL $1"; fail=1; }
ok() { echo "PASS $1"; }

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/repo" "$TMP/status"
printf '#!/bin/sh\nexit 0\n' > "$TMP/bin/cmux"; chmod +x "$TMP/bin/cmux"

# 他はすべて妥当な呼び出しで、--runner だけ実在しない名前にする。
probe() {
  CMUX_BIN="$TMP/bin/cmux" "$@" bash "$LAUNCH" \
    --cwd "$TMP/repo" --mode plan --runner definitely-not-a-runner \
    --agmsg-team demo --agmsg-from probe --status-dir "$TMP/status" \
    probe-ws prompt 2>&1
}

# CP1: 既定 base が使われる
out=$(probe env DISPATCH_CONFIG_HOME="$TMP/h")
if grep -q "$TMP/h/runners.json" <<<"$out"; then
  ok 'CP1: DISPATCH_CONFIG_HOME 由来の runners.json を見る'
else
  bad "CP1: 期待するパスがメッセージに無い: $out"
fi

# CP2: 個別 override
out=$(probe env DISPATCH_CONFIG_HOME="$TMP/h" RUNNERS_CONFIG_PATH="$TMP/x/runners.json")
if grep -q "$TMP/x/runners.json" <<<"$out"; then
  ok 'CP2: RUNNERS_CONFIG_PATH の個別 override が効く'
else
  bad "CP2: $out"
fi

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
grep -q 'mkdir -p "\$STATUS_DIR/review"' "$LAUNCH" \
  && ok 'CR1g: STATUS_DIR/review を事前に作る' || bad 'CR1g: mkdir が無い'
# CR1h: STATUS_DIR にシェルメタ文字があるときは fail-closed で die する。
# このファイルは set -euo pipefail なので、非 0 を期待する呼び出しは必ず if で捕まえる
# (単純代入だとその場でファイル全体が終了する)。runner は既存 fixture に実在する
# 'codex' を使う (未登録名だと runner 解決で先に落ちて、見たい分岐へ届かない)。
BAD_STATUS="$TMP/sta'tus"
if out=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" \
         bash "$LAUNCH" --cwd "$TMP/repo" --mode review --runner codex \
           --agmsg-team demo --agmsg-from p --status-dir "$BAD_STATUS" ws prompt 2>&1); then
  rc=0
else
  rc=$?
fi
# rc が非 0 で、かつ理由が status-dir であること。さらに副作用ゼロも必須にする
# (別の理由で落ちて生成物が無いだけ、を PASS にしないため)。
if [[ $rc -ne 0 ]] && grep -qi 'status-dir' <<<"$out" \
   && [[ ! -d "$BAD_STATUS" ]] && ! grep -rq "sta'tus" "$TMP" --include='*.sh' 2>/dev/null; then
  ok 'CR1h: メタ文字入り STATUS_DIR を fail-closed で拒否し、ツリーも composed command も作らない'
else
  bad "CR1h: rc=$rc out=$out"
fi
```

**RL1 / RL2 と CR1f-h は `test-config-paths.sh` ではなく
`test/test-launch-workspace-codex.sh` へ入れる。** そちらには既に `assert_contains` /
`assert_not_contains` の helper と `$TMP/runners.json` の registry fixture、`$TMP/bin/cmux`
の stub が揃っている（`test-role-models.sh:60-90` と同型）。`test-config-paths.sh` は
`bad` / `ok` しか持たないので、そこへ書くと helper 未定義と registry 不在で必ず落ちる。

`--role` の値域は**生成された runner script の中身**で見る（ソースへの grep はコメントに
当たるので使わない）:

```bash
# RL1: --role の 4 値が受理され、対応する既定 model / effort が焼き込まれる。
# runner は既存 fixture に実在する 'claude' を使う。
role_script() {  # $1=role  -> runner script のパス
  jq -r '.runner_file' <<<"$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" \
    bash "$LAUNCH" --cwd "$TMP/repo" --mode standby --role "$1" --runner claude \
      --agmsg-team demo --agmsg-from r --status-dir "$TMP/status" ws prompt)"
}
assert_contains "$(role_script design)"        "--model 'opus[1m]'" 'RL1a: design'
assert_contains "$(role_script design_review)" "--model 'opus[1m]'" 'RL1b: design_review'
assert_contains "$(role_script design_review)" "--effort xhigh"     'RL1c: design_review の既定 effort'
assert_contains "$(role_script exec)"          "--model 'sonnet'"   'RL1d: exec は正当値'
assert_contains "$(role_script exec)"          "--effort high"      'RL1e: exec の既定 effort'
assert_contains "$(role_script exec_review)"   "--model 'opus[1m]'" 'RL1f: exec_review'
assert_contains "$(role_script exec_review)"   "--effort xhigh"     'RL1g: exec_review の既定 effort'

# RL2: 旧 role 値は「値域エラー」で落ちる。非 0 だけでは足りない (必須引数欠落でも非 0 になる)。
# set -e 下なので if で捕まえる。
for r in plan review; do
  if out=$(CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" \
             bash "$LAUNCH" --cwd "$TMP/repo" --mode standby --role "$r" --runner claude \
               --agmsg-team demo --agmsg-from r --status-dir "$TMP/status" ws prompt 2>&1); then
    rc=0
  else
    rc=$?
  fi
  if [[ $rc -ne 0 ]] && grep -q -- "--role" <<<"$out" && grep -qE "design|exec" <<<"$out"; then
    ok "RL2: --role $r が値域エラーで拒否される"
  else
    bad "RL2: --role $r (rc=$rc) $out"
  fi
done
```

**`--role exec` は新しい正当値なので拒否リストに入れない**（RL1d が正例を押さえる）。

- [ ] **Step 2: テストを走らせて失敗を確認**

Run: `bash apps/cmux-team-dispatch-task/test/test-config-paths.sh`
Expected: **CP1 / CP3 / CP4 が FAIL**。CP2 は既存実装も `RUNNERS_CONFIG_PATH` を尊重するので
変更前から PASS してよい（red を作るのは残り 3 つ）。

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
4. **`STATUS_DIR` を `AGMSG_SKILL_DIR` と同じ fail-closed で検証する**。この値は
   `--add-dir '<path>'` として `zsh -ic "... '<prompt>' ..."` の合成コマンドへ埋まるのに、
   現行コードは検証していない（既存の欠落。`AGMSG_SKILL_DIR` にだけ `:929-932` の検査がある）。
   引数パース直後、`mkdir` とコマンド組立ての**前**に置く:
   ```bash
   STATUS_DIR_SAFE=1
   case "$STATUS_DIR" in
     *\'*|*\"*|*\`*|*\$*|*\!*|*\\*|*[[:cntrl:]]*)
       STATUS_DIR_SAFE=0
       die "--status-dir contains a shell metacharacter; refusing to build the composed command" ;;
   esac
   ```
   `die` にするのは、`STATUS_DIR` が無いと status.json も findings も書けず、警告して続行する
   意味が無いからである（`AGMSG_SKILL_DIR` は警告して `--add-dir` を諦めるだけでよい）。
5. `:915-917` を次に変える:
   ```bash
   REVIEW_WRITABLE_FLAG=""
   if [[ -n "$STATUS_DIR" ]]; then
     # reviewer が worktree 外へ書くのは findings だけ。STATUS_DIR 全体を許可すると
     # roles.json / prewarm.json まで書けてしまい、検証を通る別内容へ差し替えられる。
     mkdir -p "$STATUS_DIR/review" 2>/dev/null || true
     [[ -d "$STATUS_DIR/review" ]] && REVIEW_WRITABLE_FLAG+=" --add-dir '$STATUS_DIR/review'"
   fi
   ```
6. `--help` / ヘッダーコメントの `--role` 説明（`:23-26`, `:251` の die メッセージを含む）と
   runners.json のパス説明（`:81`）を更新する。

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
- Create: `apps/cmux-team-dispatch-task/test/lib/prewarm-harness.sh`（stub 注入・fixture・`run_pw` / `run_pw_roles` / `launch_count` / `no_side_effects`）
- Create: `apps/cmux-team-dispatch-task/test/lib/fifo-once.sh`（bounded watchdog 付き read-once helper。**Task 5 で作る**。Task 6 も同じものを source する）
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
# --- stub の注入 ---
# prewarm-panes.sh は launcher を "$SCRIPT_DIR/launch-workspace.sh" として **兄弟ファイル**
# で呼ぶので、PATH に置いた stub では捕まらない。実物と stub を同じ一時 scripts ディレクトリ
# へ並べ、そちらの prewarm-panes.sh を実行する。
SCRIPTS_REAL="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts"
FAKE="$TMP/scripts"; mkdir -p "$FAKE" "$TMP/bin"
cp "$SCRIPTS_REAL/prewarm-panes.sh" "$SCRIPTS_REAL/config-lib.sh" "$FAKE/"
PW="$FAKE/prewarm-panes.sh"

make_launch_stub() {  # $1 = 失敗させたい --role (空なら全部成功)
  cat > "$FAKE/launch-workspace.sh" <<STUB
#!/bin/sh
printf '%s\n' "launch \$*" >> "$TMP/calls.log"
if [ -n "$1" ]; then
  case "\$*" in *"--role $1"*) exit 1 ;; esac
fi
printf '{"surface_id":"s","workspace_id":"workspace:1"}\n'
STUB
  chmod +x "$FAKE/launch-workspace.sh"
}
make_launch_stub ""

# agmsg は AGMSG_DIR で差し替えられる (prewarm-panes.sh:59 の既定を上書きする)
for b in join.sh delivery.sh leave.sh; do
  printf '#!/bin/sh\nprintf "%%s\\n" "%s \$*" >> "%s/calls.log"\nexit 0\n' "$b" "$TMP" > "$TMP/bin/$b"
  chmod +x "$TMP/bin/$b"
done
printf '#!/bin/sh\nprintf "%%s\\n" "cmux \$*" >> "%s/calls.log"\nexit 0\n' "$TMP" > "$TMP/bin/cmux"
chmod +x "$TMP/bin/cmux"
export CMUX_BIN="$TMP/bin/cmux" AGMSG_DIR="$TMP/bin"

# 各ケースは **独立した status dir** で走らせる。使い回すと前のケースの prewarm.json が
# 残り、正しく early reject した実装でも「副作用があった」と誤判定する。
CASE_N=0
run_pw() {
  CASE_N=$((CASE_N + 1))
  STATUS="$TMP/status-$CASE_N"; mkdir -p "$STATUS"
  : > "$TMP/calls.log"
  bash "$PW" --with-design --cwd "$TMP/wt" --slug t --status-dir "$STATUS" \
    --agmsg-team team --roles "$1" "${@:2}" 2>&1
}
launch_count() { grep -c '^launch ' "$TMP/calls.log" 2>/dev/null || true; }
no_side_effects() {
  # 副作用ゼロ = 何も呼ばれず、この case の status dir に成果物が無い
  [[ ! -s "$TMP/calls.log" ]] && [[ ! -e "$STATUS/prewarm.json" ]] && [[ ! -e "$TMP/pwn" ]]
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

# RI2: 妥当な入力は検証を通り、ロール数ぶんの launch が走る
run_pw "$ROLES_ON" >/dev/null 2>&1
[[ "$(launch_count)" == 4 ]] && ok 'RI2a: review on で 4 ロールぶん launch する' \
  || bad "RI2a: launch 回数 $(launch_count)"
run_pw "$ROLES_OFF" >/dev/null 2>&1
[[ "$(launch_count)" == 2 ]] && ok 'RI2b: review off で 2 ロールぶん launch する' \
  || bad "RI2b: launch 回数 $(launch_count)"

# RI2d: --roles を FIFO で渡す。FIFO は 1 度しか読めない。「内容として 1 回だけ読む」実装
#       だけが成功し、検証後に再度 jq する実装は 2 回目の open で block する。
#       block を失敗として扱うため bounded watchdog 付きの helper を使う。
. "$SCRIPT_DIR/lib/fifo-once.sh"
fifo_read_once 'RI2d: roles.json を 1 回しか読まない' "$ROLES_ON" run_pw_roles

# RI2c: --roles 未指定は「値域エラー」で落ちる (必須引数欠落とメッセージで区別する)
out=$(bash "$PW" --with-design --cwd "$TMP/wt" --slug t --status-dir "$TMP/status" \
       --agmsg-team team 2>&1); rc=$?
[[ $rc -eq 2 ]] && grep -q -- '--roles' <<<"$out" \
  && ok 'RI2c: --roles 未指定を exit 2 と明示メッセージで拒否' || bad "RI2c: rc=$rc $out"

# RI3: 改竄 fixture は副作用ゼロで exit 2
# 値は必ず jq --arg でデータとして渡す。シェル文字列へ埋めるとテスト自身がコマンドを実行する。
tamper_expr() { jq "$1" "$ROLES_ON" > "$TMP/bad.json"; run_pw "$TMP/bad.json" >/dev/null 2>&1; }
tamper_arg()  { jq --arg v "$2" "$1" "$ROLES_ON" > "$TMP/bad.json"; run_pw "$TMP/bad.json" >/dev/null 2>&1; }

tamper_arg '.roles.design.model = $v' "a'; touch $TMP/pwn; #"
rc=$?; { [[ $rc -eq 2 ]] && no_side_effects; } && ok 'RI3a: メタ文字 model' || bad "RI3a (rc=$rc)"
tamper_arg '.roles.design.model = $v' 'bang!'
rc=$?; [[ $rc -eq 2 ]] && ok 'RI3a2: ! を含む model' || bad "RI3a2 (rc=$rc)"
tamper_expr '.roles.design.effort = "bogus"'
rc=$?; { [[ $rc -eq 2 ]] && no_side_effects; } && ok 'RI3b: 範囲外 effort' || bad "RI3b (rc=$rc)"
# **副作用ゼロは全ケースに掛ける**。engine 不整合や未登録 runner を launch/join の「後」で
# 弾く実装は、rc だけを見ていると通ってしまう。
tamper_expr '.roles.design.engine = "codex"'
rc=$?; { [[ $rc -eq 2 ]] && no_side_effects; } && ok 'RI3c: engine 不整合' || bad "RI3c (rc=$rc)"
tamper_expr '.roles.design.runner = "nope"'
rc=$?; { [[ $rc -eq 2 ]] && no_side_effects; } && ok 'RI3d: 未登録 runner' || bad "RI3d (rc=$rc)"
tamper_expr 'del(.roles.exec_review)'
rc=$?; { [[ $rc -eq 2 ]] && no_side_effects; } && ok 'RI3e: on なのに review ロール欠落' || bad "RI3e (rc=$rc)"
tamper_expr '.review_mode = "off"'
rc=$?; { [[ $rc -eq 2 ]] && no_side_effects; } && ok 'RI3f: off なのに review ロールがある' || bad "RI3f (rc=$rc)"
tamper_expr '.roles.design.bogus = 1'
rc=$?; { [[ $rc -eq 2 ]] && no_side_effects; } && ok 'RI3g: 許可外キー' || bad "RI3g (rc=$rc)"
[[ -e "$TMP/pwn" ]] && bad 'RI3h: テストまたは実装が副作用を起こした' || ok 'RI3h: 副作用なし'

# RI4: runners_file の差し替えを信じない
cat > "$TMP/fake-runners.json" <<'JSON'
{"default":"evil","runners":[{"name":"evil","command":"evil","engine":"claude"}]}
JSON
jq --arg f "$TMP/fake-runners.json" '.runners_file = $f | .roles.design.runner = "evil"' \
  "$ROLES_ON" > "$TMP/bad.json"
run_pw "$TMP/bad.json" >/dev/null 2>&1
[[ $? -eq 2 ]] && ok 'RI4: roles.json の runners_file を参照先に使わない' || bad 'RI4'

# RI5: model 省略可否 (負例だけでなく正例も実際に走らせる)
jq 'del(.roles.design_review.model)' "$ROLES_ON" > "$TMP/bad.json"
run_pw "$TMP/bad.json" >/dev/null 2>&1
[[ $? -eq 2 ]] && ok 'RI5a: codex design_review の model 欠落を拒否' || bad 'RI5a'
jq '.roles.design_review.model = null' "$ROLES_ON" > "$TMP/bad.json"
run_pw "$TMP/bad.json" >/dev/null 2>&1
[[ $? -eq 2 ]] && ok 'RI5b: null も拒否' || bad 'RI5b'
# 負例: review 2 ロール × (省略 / null / 空文字) の 6 通りをすべて拒否する
for role in design_review exec_review; do
  for mut in 'del(.roles.ROLE.model)' '.roles.ROLE.model = null' '.roles.ROLE.model = ""'; do
    tamper_expr "${mut//ROLE/$role}"
    rc=$?; { [[ $rc -eq 2 ]] && no_side_effects; } \
      || bad "RI5-neg: $role の $mut を受理した (rc=$rc)"
  done
done
ok 'RI5a: codex review 2 ロールの model 省略 / null / 空文字をすべて拒否する'

# 正例: codex の design と exec はどちらも model 省略で成功し、--model が付かない。
# **$ROLES_ON の design は claude (runner=ccf) なので、そのまま model を消すと正しい
# validator が「必須 model 欠落」で弾く**。省略可なのは codex のときだけなので、
# ロールを codex tuple へ変えてから消す。
for role in design exec; do
  jq --arg r "$role" '.roles[$r].runner = "cx" | .roles[$r].engine = "codex"
                      | del(.roles[$r].model)' "$ROLES_ON" > "$TMP/ok.json"
  run_pw "$TMP/ok.json" >/dev/null 2>&1
  rc=$?
  if [[ $rc -eq 0 ]] \
     && ! grep -E "^launch .*--role $role( |\$)" "$TMP/calls.log" | grep -q -- '--model'; then
    ok "RI5c-$role: codex $role は model 省略で成功し --model が付かない"
  else
    bad "RI5c-$role: rc=$rc $(grep "^launch .*--role $role" "$TMP/calls.log")"
  fi
done
# 対称の負例: claude ロールの model 省略は engine に関わらず拒否される
jq 'del(.roles.design.model)' "$ROLES_ON" > "$TMP/bad.json"   # design は claude のまま
run_pw "$TMP/bad.json" >/dev/null 2>&1
[[ $? -eq 2 ]] && ok 'RI5d: claude ロールの model 省略は拒否される' || bad 'RI5d'

# RI6: --review-mode フラグがソースに存在しない
grep -q -- '--review-mode' "$PW" && bad 'RI6: --review-mode フラグが残っている' \
  || ok 'RI6: --review-mode フラグは存在しない'

exit $fail
```

- [ ] **Step 2: 失敗するテストを書く（`test-pane-invariant.sh`）**

配置の固定表とスキーマを**ソースの静的検査**で押さえる（既存 `test-prewarm-layout.sh` の PG 系と同じ流儀）:

`test-roles-input.sh` と同じ stub を使い、**生成された `prewarm.json` と launch の引数**を
検査する。ソースへの grep はコメントに当たるので使わない。

```bash
#!/usr/bin/env bash
#   PI1. review on = 4 launch / off = 2 launch
#   PI2. split 方向: design_review=right(design) / exec=down(design) / exec_review=right(exec)
#   PI3. prewarm.json のキーが 4 ロール名で、executors / review が現れない
#   PI4. agent 名が <slug> / <slug>-design-review / <slug>-exec / <slug>-exec-review
#   PI5. design と exec のロール設定が完全一致でも exec ペインが立つ (in-session 廃止)
#   PI6. exec_review の spawn 失敗時は prewarm.json にそのキーが現れない
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PW="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh"
fail=0; bad() { echo "FAIL $1"; fail=1; }; ok() { echo "PASS $1"; }

# --- 共通 harness ---
# stub 注入・fixture・run_pw / launch_count / no_side_effects は test-roles-input.sh と
# 完全に同じものが要る。**コピペせず** `test/lib/prewarm-harness.sh` として切り出し、
# 両テストの冒頭で `. "$SCRIPT_DIR/lib/prewarm-harness.sh"` する
# (Task 5 Step 1 でこのファイルを作り、test-roles-input.sh からも source する)。
. "$SCRIPT_DIR/lib/prewarm-harness.sh"

# run_pw が case ごとに $STATUS を更新するので、PJ は run_pw の **後**に解決する

# PI1 / PI3 / PI4
run_pw "$ROLES_ON" >/dev/null 2>&1
PJ="$STATUS/prewarm.json"
[[ "$(launch_count)" == 4 ]] && ok 'PI1a: on で 4 launch' || bad "PI1a: $(launch_count)"
[[ "$(jq -r 'del(.workspace_id,.review_mode) | keys | join(",")' "$PJ")" \
   == 'design,design_review,exec,exec_review' ]] \
  && ok 'PI3a: prewarm.json のキーが 4 ロール名' || bad "PI3a: $(jq -c 'keys' "$PJ")"
jq -e 'has("executors") or has("review")' "$PJ" >/dev/null \
  && bad 'PI3b: executors / review キーが残っている' || ok 'PI3b'
for pair in 'design:t' 'design_review:t-design-review' 'exec:t-exec' 'exec_review:t-exec-review'; do
  r="${pair%%:*}"; a="${pair##*:}"
  [[ "$(jq -r --arg r "$r" '.[$r].agent' "$PJ")" == "$a" ]] || bad "PI4: $r の agent 名"
done
ok 'PI4: 4 つの agent 名'

# PI2: split 方向を launch の引数から見る
grep -qE '^launch .*--role design_review .*--standby-split-direction right' "$TMP/calls.log" \
  && ok 'PI2a: design_review は right split' || bad 'PI2a'
grep -qE '^launch .*--role exec .*--standby-split-direction down' "$TMP/calls.log" \
  && ok 'PI2b: exec は down split' || bad 'PI2b'
grep -qE '^launch .*--role exec_review .*--standby-split-direction right' "$TMP/calls.log" \
  && ok 'PI2c: exec_review は right split' || bad 'PI2c'

# PI1b: off
run_pw "$ROLES_OFF" >/dev/null 2>&1
PJ="$STATUS/prewarm.json"
[[ "$(launch_count)" == 2 ]] && ok 'PI1b: off で 2 launch' || bad "PI1b: $(launch_count)"
[[ "$(jq -r 'del(.workspace_id,.review_mode) | keys | join(",")' "$PJ")" == 'design,exec' ]] \
  && ok 'PI1c: off の prewarm.json は 2 ロール' || bad 'PI1c'

# PI5: design と exec が完全一致でも exec ペインが立つ
jq '.roles.exec = .roles.design' "$ROLES_OFF" > "$TMP/same.json"
run_pw "$TMP/same.json" >/dev/null 2>&1
PJ="$STATUS/prewarm.json"
{ [[ "$(launch_count)" == 2 ]] && jq -e 'has("exec")' "$PJ" >/dev/null; } \
  && ok 'PI5: in-session 廃止 — 一致していても exec ペインが立つ' || bad 'PI5'

# PI6: exec_review の launch だけ失敗させる
make_launch_stub exec_review
run_pw "$ROLES_ON" >/dev/null 2>&1
PJ="$STATUS/prewarm.json"
if jq -e 'has("exec_review")' "$PJ" >/dev/null 2>&1; then
  bad 'PI6a: spawn 失敗した exec_review が prewarm.json に現れた'
else
  jq -e 'has("design_review") and has("design") and has("exec")' "$PJ" >/dev/null \
    && ok 'PI6a: exec_review だけ省略され残り 3 ロールは保持される' || bad 'PI6a: 他ロールが消えた'
fi
# PI6b: join 済みだった exec_review は leave.sh で戻される
grep -q 'leave.sh .*-exec-review' "$TMP/calls.log" \
  && ok 'PI6b: 起動に失敗した exec_review は leave される' || bad 'PI6b'
# PI6c: prewarm 段階では code-review.json を作らない (gating は SKILL.md 側の責務)
[[ ! -e "$STATUS/review/code-review.json" ]] \
  && ok 'PI6c: prewarm 段階では code-review.json を作らない' || bad 'PI6c'
# 注: 「exec_review の key 有無 × [ready] 有無」を通した gating の動的検査は、実装が
#     SKILL.md 側にあるため Task 7 の test-launch-workspace-review-config.sh が持つ (R4 #5)。
# PI6d: stub を戻し、正常系では 2 つの reviewer tuple が混線しないことを確かめる
make_launch_stub ""
run_pw "$ROLES_ON" >/dev/null 2>&1
PJ="$STATUS/prewarm.json"
{ [[ "$(jq -r '.design_review.agent' "$PJ")" == 't-design-review' ]] \
  && [[ "$(jq -r '.exec_review.agent'   "$PJ")" == 't-exec-review'   ]] \
  && [[ "$(jq -r '.design_review.model' "$PJ")" != "$(jq -r '.exec_review.model' "$PJ")" \
     || "$(jq -r '.design_review.runner' "$PJ")" != "$(jq -r '.exec_review.runner' "$PJ")" ]]; } \
  && ok 'PI6d: 2 つの reviewer tuple が別々に保持される' \
  || bad "PI6d: $(jq -c '{dr:.design_review, xr:.exec_review}' "$PJ")"
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
7. **ロール別の launch 失敗を扱う**（spec §5 / §6）。ロールごとに扱いが違う:
   - `design` / `exec` の launch が失敗したら**ディスパッチを止める**（die）。この 2 つは必須で、
     欠けたまま進んでも実装が走らない。
   - `design_review` / `exec_review` の launch が失敗したら、**警告してそのロールだけ省略**する。
     `prewarm.json` にそのキーを書かず、既に `join.sh` を済ませていれば `leave.sh` で team
     member を戻す。残りのロールは保持して続行する。
   - **readiness 失敗はここで扱わない**。`prewarm-panes.sh` は launch 直後に `prewarm.json` を
     書くので、`[ready] <name>` が来るかどうかを観測できない。readiness の観測主体は
     `[ready]` を待つ親であり、その扱いは Task 7 の担当である（spec §5 の表）。
     待機・callback・再書き込みの機構を `prewarm-panes.sh` に**持たせてはならない**。
   - この非対称は spec §5 の「review spawn 失敗時は当該 gate だけを警告してスキップ」と
     「ロールが解決できない設定エラーは fail-fast」の区別に対応する。設定の誤りは Task 2 の
     resolver が既に止めているので、ここに残るのは runtime の失敗だけである。
8. `prewarm.json` の書き出しを新スキーマにする。`review_mode` は**解決された意図された値**を
   書く（Task 6 の renderer が「on なのに review ロールが無い」を検出するため。起動できた
   ロール数から逆算してはならない）。`wired` は診断出力として `true` を書く（分岐に使わない）。
9. agmsg の join は 4 つの新 agent 名で行う。
10. `--unattended` × codex 親の die、`--agmsg-team` 必須、`--timeout-sentinel` の転送は**維持**。

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
fail=0
for f in test-roles-input test-pane-invariant test-prewarm-layout test-prewarm-all-codex \
         test-prewarm-unattended test-prewarm-design-permissions test-in-session; do
  bash "apps/cmux-team-dispatch-task/test/$f.sh" || { echo "^^ $f FAILED"; fail=1; }
done
exit $fail
```
Expected: exit 0（`|| echo` だけにすると `echo` の rc 0 でループ全体が成功終了してしまう）

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
- Modify: `apps/cmux-team-dispatch-task/test/test-loop-prompt.sh`, `test-loop-cleanup.sh`
- Create: `apps/cmux-team-dispatch-task/test/lib/cleanup-harness.sh`（自己完結した cleanup 実行 harness）
- （`test/lib/fifo-once.sh` は **Task 5 で作成済み**。ここでは source するだけ）

**`test-cleanup-close.sh` は Task 6 では触らない。** 対象の close 実装は SKILL.md 側にあり
Task 7 で変わるので、更新も green 実行も **Task 7 の担当**である（R3 #4）。Task 7 の Files と
Step にも明示的に入れてある。

**`test-input-validation.sh` も Task 7 では作らない。** それが検査する
`setup-mode.md` / `setup-mode-ja.md` の更新は Task 8 なので、Task 7 で作って green 実行すると
必ず赤い。**作成・実行とも Task 8 の担当**にする（R4 #3）。

**Interfaces:**
- Consumes: Task 5 が書く `prewarm.json`
- Produces: `render-loop-prompt.sh --prewarm <path>`（ロール別フラグは全廃）。
  `loop-cleanup.sh` は `prewarm.json` 実在ロールの `agent` / `surface_id` を列挙する。

- [ ] **Step 1: 失敗するテストを書く（`test-snapshot-contract.sh`）**

```bash
#!/usr/bin/env bash
# 検証済みスナップショット契約の動的検査。
#
#   SC1. reviewer の --add-dir が STATUS_DIR/review に狭まっている (静的)
#   SC2. 検証後に対象 JSON を差し替えても差し替え後の値が使われない (動的 TOCTOU)
#   SC3. prewarm.json の agent がロール名と対応しないと拒否
#   SC4. surface_id / workspace_id が空だと拒否
#   SC5. wired が boolean true でないと拒否
#   SC6. cleanup は workspace_id を独立値と照合し、不一致なら leave しない
#   SC7. SKILL.md に「検証前の生読み」が残っていない

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
S="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts"
SKILL="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/SKILL.md"
fail=0; bad() { echo "FAIL $1"; fail=1; }; ok() { echo "PASS $1"; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
export DISPATCH_CONFIG_HOME="$TMP/home"; mkdir -p "$DISPATCH_CONFIG_HOME" "$TMP/bin" "$TMP/status"

# **helper と fixture は使用より前に用意する**。SC2 は run_pw_roles /
# run_cleanup_with_prewarm / $ROLES_ON をすべて使うので、3 つの source をここに置く。
. "$SCRIPT_DIR/lib/fifo-once.sh"
. "$SCRIPT_DIR/lib/prewarm-harness.sh"    # run_pw / run_pw_roles / $ROLES_ON / $ROLES_OFF
. "$SCRIPT_DIR/lib/cleanup-harness.sh"    # run_cleanup_for_slug / run_cleanup_with_prewarm /
                                          # cleanup_stub_workspace

# registry fixture が無いと「別の理由の失敗」で空疎に通るので必ず置く。
# **prewarm-harness.sh の $ROLES_ON が使う runner をすべて含めること**。ここで 'ccf' だけに
# 上書きすると、SC2b は FIFO の契約へ到達する前に「未登録 runner 'cx'」で落ちる (R4 #3)。
cat > "$DISPATCH_CONFIG_HOME/runners.json" <<'JSON'
{"default":"ccf","runners":[{"name":"ccf","command":"ccf","engine":"claude"},
                            {"name":"cx","command":"codex","engine":"codex"}]}
JSON
for b in cmux leave.sh; do
  printf '#!/bin/sh\nprintf "%%s\\n" "$0 $*" >> "%s/calls.log"\nexit 0\n' "$TMP" > "$TMP/bin/$b"
  chmod +x "$TMP/bin/$b"
done

VALID="$TMP/prewarm.json"
cat > "$VALID" <<'JSON'
{"workspace_id":"workspace:1","review_mode":"on",
 "design":{"surface_id":"s1","agent":"t","runner":"ccf","engine":"claude","model":"opus[1m]","effort":"xhigh","wired":true},
 "design_review":{"surface_id":"s2","agent":"t-design-review","runner":"ccf","engine":"claude","model":"opus[1m]","effort":"xhigh","wired":true},
 "exec":{"surface_id":"s3","agent":"t-exec","runner":"ccf","engine":"claude","model":"sonnet","effort":"high","wired":true},
 "exec_review":{"surface_id":"s4","agent":"t-exec-review","runner":"ccf","engine":"claude","model":"opus[1m]","effort":"high","wired":true}}
JSON

render() {  # $1 = prewarm path
  bash "$S/render-loop-prompt.sh" --prewarm "$1" --slug t --issue 1 --issue-title x \
    --issue-url u --issue-body-file /dev/null --plan-hint h --status-dir "$TMP/status" \
    --timeout-sentinel "$TMP/sentinel" --team tm --layout workspace --parent-workspace w \
    --skill-dir "$S/.." 2>"$TMP/err"
}

# --- SC1 ---
if grep -q "add-dir '\$STATUS_DIR/review'" "$S/launch-workspace.sh" \
   && ! grep -q "add-dir '\$STATUS_DIR'" "$S/launch-workspace.sh"; then
  ok 'SC1: reviewer の書き込み許可が review/ に狭まっている'
else
  bad 'SC1'
fi

# --- SC2: 「1 回だけ読む」を FIFO で動的に証明する ---
# FIFO は 1 度しか読めない。内容を 1 回だけ読んで検証済みローカル値を使う実装は成功し、
# 検証のあとに同じ path をもう一度 jq / cat する実装は 2 回目で空を読んで必ず落ちる。
# これは「同一実行内で読み直していない」ことの直接の証拠になり、順次書き換えの疑似
# TOCTOU と違って誤実装を通さない。3 consumer すべてに掛ける。
# **必ず bounded watchdog を付ける**。FIFO の 2 回目の open は EOF ではなく block なので、
# watchdog が無いと再読する誤実装は「失敗」ではなく「無限ハング」になる。
# helper は test/lib/fifo-once.sh に置き、3 テストから source する。
# **プロセスグループごと殺す**。`( cmd ) &` の PID は subshell のもので、実際に FIFO の
# 2 回目の open で止まるのはその子である。subshell だけを kill すると本体が orphan として
# 残り、テストが終わってもプロセスが残留する (R4 #6)。
# job control を有効にすると各バックグラウンドジョブが独自の pgid を持つので、
# `kill -- -PID` でグループ全体へ届く。
set -m   # ファイル冒頭で 1 回

fifo_read_once() {   # $1=ラベル $2=中身のファイル $3.. = 実行コマンド (最後に FIFO パスが付く)
  local label="$1" src="$2"; shift 2
  local f="$TMP/in.fifo"; rm -f "$f"; mkfifo "$f" || { bad "$label (mkfifo 失敗)"; return; }
  rm -f "$TMP/fifo.rc"

  ( cat "$src" > "$f" 2>/dev/null ) & local wpid=$!
  ( "$@" "$f" >/dev/null 2>&1; printf '%s' "$?" > "$TMP/fifo.rc" ) & local cpid=$!

  local i=0
  while kill -0 "$cpid" 2>/dev/null && [ "$i" -lt 40 ]; do sleep 0.5; i=$((i + 1)); done

  local timed_out=0
  if kill -0 "$cpid" 2>/dev/null; then
    timed_out=1
    # まず穏当に、次に確実に。いずれもグループ宛 (先頭の `-`)。
    kill -TERM -- "-$cpid" 2>/dev/null || kill -TERM "$cpid" 2>/dev/null || true
    sleep 1
    kill -KILL -- "-$cpid" 2>/dev/null || kill -KILL "$cpid" 2>/dev/null || true
  fi
  kill -KILL -- "-$wpid" 2>/dev/null || kill -KILL "$wpid" 2>/dev/null || true
  wait "$cpid" "$wpid" 2>/dev/null || true
  rm -f "$f"

  if [[ $timed_out -eq 1 ]]; then
    bad "$label — 20 秒で終わらなかった。FIFO を 2 回開こうとして block した可能性が高い"
    return
  fi
  [[ "$(cat "$TMP/fifo.rc" 2>/dev/null)" == 0 ]] \
    && ok "$label" || bad "$label (rc=$(cat "$TMP/fifo.rc" 2>/dev/null))"
}

# `kill 0` は自分の属するプロセスグループ全体 (テストランナーの親を含む) を殺すので
# 使ってはならない。掃除は上の明示的な kill で足りる。

# 3 consumer それぞれの「FIFO を最後の引数として受ける」薄いラッパを、
# 各 harness が公開する (prewarm-harness.sh / cleanup-harness.sh)。
#   run_pw_roles <fifo>              -> prewarm-panes.sh --roles <fifo> ...
#   run_cleanup_with_prewarm <fifo>  -> loop-cleanup.sh の prewarm 読取を <fifo> へ向ける
#   render <fifo>                    -> render-loop-prompt.sh --prewarm <fifo> ...
fifo_read_once 'SC2a: renderer は prewarm.json を 1 回しか読まない' "$VALID" render
fifo_read_once 'SC2b: prewarm-panes.sh は roles.json を 1 回しか読まない' "$ROLES_ON" run_pw_roles
fifo_read_once 'SC2c: loop-cleanup.sh は prewarm.json を 1 回しか読まない' "$VALID" run_cleanup_with_prewarm

# --- SC3 / SC4 / SC5: 検証固有の失敗であることをメッセージで確かめる ---
expect_reject() {  # $1=ラベル $2=jq 式 [$3=--arg 値]
  local label="$1" expr="$2"
  if [[ $# -ge 3 ]]; then jq --arg v "$3" "$expr" "$VALID" > "$TMP/bad.json"
  else jq "$expr" "$VALID" > "$TMP/bad.json"; fi
  : > "$TMP/calls.log"
  render "$TMP/bad.json" >/dev/null 2>&1
  local rc=$?
  if [[ $rc -ne 0 ]] && grep -qiE 'prewarm|invalid|agent|wired|surface' "$TMP/err"; then
    ok "$label"
  else
    bad "$label (rc=$rc err=$(cat "$TMP/err"))"
  fi
}
expect_reject 'SC3a: 別ロールの agent 名を拒否' '.design_review.agent = "t-exec"'
expect_reject 'SC3b: parent への差し替えを拒否'  '.design_review.agent = "parent"'
expect_reject 'SC4a: 空 surface_id を拒否'       '.design.surface_id = ""'
expect_reject 'SC4b: 空 workspace_id を拒否'     '.workspace_id = ""'
expect_reject 'SC5a: 文字列 "true" を拒否'       '.design.wired = "true"'
expect_reject 'SC5b: wired=false を拒否'          '.design.wired = false'
expect_reject 'SC5c: 許可外キーを拒否'            '.design.bogus = 1'
expect_reject 'SC5d: 型違い (effort が数値) を拒否' '.design.effort = 3'
expect_reject 'SC5e: メタ文字入り model を拒否'   '.design.model = $v' "a'; touch $TMP/pwn; #"
expect_reject 'SC5g: active review ロールの model 欠落を拒否' 'del(.design_review.model)'
[[ -e "$TMP/pwn" ]] && bad 'SC5f: 副作用が起きた' || ok 'SC5f: 副作用なし'

# --- SC3-SC5 と同じ matrix を **cleanup にも掛ける** (spec §7)。
#     renderer だけに掛けると、cleanup が検証なしで leave / close する実装が通る。
expect_reject_cleanup() {   # $1=ラベル $2=jq 式 [$3=--arg 値]
  local label="$1" expr="$2"
  if [[ $# -ge 3 ]]; then jq --arg v "$3" "$expr" "$VALID" > "$TMP/dispatch/t/prewarm.json"
  else jq "$expr" "$VALID" > "$TMP/dispatch/t/prewarm.json"; fi
  : > "$TMP/calls.log"
  run_cleanup_for_slug t "$TMP/dispatch" >/dev/null 2>&1
  # 拒否 = leave も close も 1 件も走らない (rc はループ継続のため 0 でよい)
  [[ "$(grep -c 'leave.sh\|close-surface' "$TMP/calls.log")" == 0 ]] \
    && ok "$label" || bad "$label ($(cat "$TMP/calls.log"))"
}
expect_reject_cleanup 'SC8a: cleanup も別ロールの agent 名を拒否' '.design_review.agent = "t-exec"'
expect_reject_cleanup 'SC8b: cleanup も空 surface_id を拒否'      '.design.surface_id = ""'
expect_reject_cleanup 'SC8c: cleanup も wired 非 boolean を拒否'  '.design.wired = "true"'
expect_reject_cleanup 'SC8d: cleanup も型違いを拒否'              '.design.effort = 3'
expect_reject_cleanup 'SC8e: cleanup も許可外キーを拒否'          '.design.bogus = 1'
expect_reject_cleanup 'SC8f: cleanup も active review の model 欠落を拒否' 'del(.exec_review.model)'

# --- SC6: cleanup の workspace 照合 ---
# harness (冒頭で source 済み) は HOME を差し替えて leave.sh の **絶対パス**
# ($HOME/.agents/skills/agmsg/scripts/leave.sh) ごと stub 化する。ホストの agmsg を
# 触らないことが要件のため。
mkdir -p "$TMP/dispatch/t"; cp "$VALID" "$TMP/dispatch/t/prewarm.json"
# 一致するケース: leave が 4 件
cleanup_stub_workspace 'workspace:1'
run_cleanup_for_slug t "$TMP/dispatch"; rc=$?
[[ $rc -eq 0 && "$(grep -c 'leave.sh' "$TMP/calls.log")" == 4 ]] \
  && ok 'SC6a: workspace 一致で 4 ロールぶん leave する' \
  || bad "SC6a: rc=$rc leaves=$(grep -c 'leave.sh' "$TMP/calls.log")"
# 不一致のケース: leave ゼロ。rc も見る (command not found を PASS にしないため)
cleanup_stub_workspace 'workspace:999'
run_cleanup_for_slug t "$TMP/dispatch"; rc=$?
[[ $rc -eq 0 && "$(grep -c 'leave.sh' "$TMP/calls.log")" == 0 ]] \
  && ok 'SC6b: workspace 不一致では leave しない' \
  || bad "SC6b: rc=$rc leaves=$(grep -c 'leave.sh' "$TMP/calls.log")"

# --- SC7: 「検証前の生読み」だけを検出する needle ---
# 正しい実装は PREWARM_DOC=$(cat …) の 1 回だけで、以後は <<<"$PREWARM_DOC" を使う。
# したがって「jq ... "<...>/prewarm.json"」の形 (ファイルを直接 jq する) が残っていたら FAIL。
if grep -nE 'jq [^|]*prewarm\.json"' "$SKILL" >/dev/null 2>&1; then
  bad "SC7: SKILL.md にファイルを直接 jq する生読みが残っている: $(grep -nE 'jq [^|]*prewarm\.json"' "$SKILL" | head -3)"
else
  ok 'SC7: SKILL.md の prewarm.json 読み取りがスナップショット契約に沿っている'
fi
exit $fail
```

**注**: SC7 は Task 7 で SKILL.md を書き換えるまで赤い。**Task 6 の green 確認では
`test-snapshot-contract.sh` を実行しない**（実行すれば必ず非 0 になり、緑の判定にならない）。
このテストは **Task 7 の Step 9 で初めて実行する**。

- [ ] **Step 2: `test-loop-prompt.sh` を書き換える**

```bash
#   LP1. --prewarm が必須。旧 --review-* / ロール別フラグは die
#   LP2. phase block は design engine で選ばれる (design/exec が異なる 2 方向)
#   LP3. 4 状態: review 0 件 / 2 件 / exec_review 欠落 / design_review 欠落
#   LP4. review_mode=on なのに review ロールが欠けると stderr に警告 (die はしない)
#   LP5. codex の design / exec は model 省略で成功、active review の model 欠落は die
#   LP6. review 2 ロール × 必須 5 field を 1 つずつ欠落させると die する (5x2 = 10 ケース)
#   LP7. 2 つの reviewer tuple が別々のブロックへ届き、混線しない
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

# LP6: 必須 field の欠落 matrix (review 2 ロール × 5 field)
for role in design_review exec_review; do
  # spec が必須と定める 5 つは runner / engine / model / effort / agent。
  # active な review ロールでは model も必須である点に注意 (surface_id は別途 SC4 が見る)。
  for f in runner engine model effort agent; do
    jq --arg r "$role" --arg f "$f" 'del(.[$r][$f])' "$FULL_ON" > "$TMP/p.json"
    render_ok "$TMP/p.json" >/dev/null 2>&1
    [[ $? -ne 0 ]] || bad "LP6: $role の $f 欠落を見逃した"
  done
done
ok 'LP6: review 2 ロール × 必須 5 field の欠落をすべて die する'

# LP7: 2 つの reviewer tuple が混線しない
jq '.design_review.agent = "t-design-review" | .design_review.model = "DR-MODEL"
  | .exec_review.agent = "t-exec-review"   | .exec_review.model = "XR-MODEL"' \
  "$FULL_ON" > "$TMP/p.json"
out=$(render_ok "$TMP/p.json")
dr_block=$(sed -n '/design-review/,/^$/p' <<<"$out")
xr_block=$(sed -n '/exec-review/,/^$/p' <<<"$out")
{ grep -q 'DR-MODEL' <<<"$dr_block" && ! grep -q 'XR-MODEL' <<<"$dr_block" \
  && grep -q 'XR-MODEL' <<<"$xr_block" && ! grep -q 'DR-MODEL' <<<"$xr_block"; } \
  && ok 'LP7: 2 つの reviewer tuple が別々のブロックへ届く' \
  || bad 'LP7: reviewer tuple が混線した'
```

- [ ] **Step 3: `render-loop-prompt.sh` を改修**

1. `--design-runner` / `--design-engine` / `--exec-runner` / `--exec-engine` / `--review` /
   `--review-model` / `--review-runner` / `--review-engine` / `--review-pane-agent` /
   `--exec-choice` を**すべて削除**し、渡されたら die する。
2. `--prewarm <path>` を必須にする。`PREWARM_DOC=$(cat "$PREWARM_FILE")` で 1 回だけ読む。
   親が `[ready]` の結果を `prewarm.json` へ反映済み（Task 7 Step 4a の `prune_not_ready`）
   なので、renderer は「キーがある ⇔ 使える」で判断してよい。**renderer 自身が readiness を
   判定してはならない**（親しか観測できない）。
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

現状の把握（これを踏まえないと指示が実装不能になる）:
`loop-cleanup.sh` は `--dispatch-dir` / `--repo-root` / `--agmsg-team` を取り、slug ごとの
ループの中で `leave.sh` を **ハードコードした 5 つの agent 名**
（`"$slug" "$slug-sonnet" "$slug-codex" "$slug-review" "$slug-opus"`）に対して呼ぶ。
**`close-surface` は行わない**（サーフェスを閉じるのは SKILL.md 側の最終クリーンアップ）。
`prewarm.json` も現状は読んでいない。

1. **prewarm path を導出し、スナップショットを「早く」取る**:
   slug ループの中で `PREWARM_FILE="$DISPATCH_DIR/$slug/prewarm.json"`。
   **読み取り・検証・workspace 照合は、`status=done` の枝が `rm -rf "$dir"` を実行するより
   前に済ませ**、検証済みの agent 一覧をシェル変数に保持する（現行 `:89-95` は
   `rm -rf "$dir"` のあとに leave している。素直に既存 leave ブロックを差し替えるだけだと、
   done のタスクでは `prewarm.json` が既に消えていて必ず snapshot を失う）。
   `prewarm.json` が無い場合は **role-aware な leave だけを省略**し、
   finalize / label / worktree / branch の既存 cleanup は**そのまま続ける**
   （`continue` を使うとそれらまで飛ばしてしまう）。この場合の leave は
   「何もしない」であって、旧ハードコード 5 名へのフォールバックではない。
2. `PREWARM_DOC=$(cat "$PREWARM_FILE")` で **1 回だけ内容として読み**、以後は
   `<<<"$PREWARM_DOC"` で jq する。**元パスを読み直さない**。
3. **`prewarm.json` 用の検証**を通す（`roles.json` 用の検証とは別物である点に注意）:
   - JSON として妥当。
   - トップレベルの許可キーは `workspace_id` / `review_mode` / 4 ロール名だけ。
   - 各ロールのキーは `surface_id` / `agent` / `runner` / `engine` / `model` / `effort` /
     `wired` の部分集合で、`surface_id` / `agent` / `runner` / `engine` / `effort` / `wired` は必須。
     **`model` は §4 の matrix に従う**: claude の全ロールと codex の review 2 ロールでは
     必須、codex の `design` / `exec` でだけ省略可。「常に optional」にしてはならない。
   - `agent` が**そのロールに対応する名前**（`$slug` / `$slug-design-review` / `$slug-exec` /
     `$slug-exec-review`）。
   - `surface_id` と `workspace_id` が非空文字列、`wired` が boolean の `true`。
   - `config-lib.sh` の runner / model / effort 検証を通る。
   - 違反したら**その slug の leave を行わず**警告して次へ（ループ全体は止めない。他の slug の
     cleanup は独立に価値がある）。
4. **leave 対象を実在ロールから列挙**する。ハードコードの 5 名を置き換える:
   ```bash
   while IFS= read -r agent; do
     [[ -n "$agent" ]] || continue
     "$HOME/.agents/skills/agmsg/scripts/leave.sh" "$AGMSG_TEAM" "$agent" >/dev/null 2>&1 || true
   done < <(jq -r '. as $d | ["design","design_review","exec","exec_review"]
                   | map(select($d[.] != null) | $d[.].agent) | .[]' <<<"$PREWARM_DOC")
   ```
   `review_mode=off` なら 2 件、`on` なら 4 件、いずれも各 1 回。
5. **workspace 照合**: `prewarm.json` の `workspace_id` が cleanup 自身が独立に知っている値と
   一致しなければ、**その slug の leave をスキップ**して警告する。独立値は
   `cmux workspace list` を `[<slug>]` で**リテラル一致**（正規表現ではなく `grep -F`）して
   引く。前回実行の古い `prewarm.json` が残っていても誤爆しないための照合でもある。

**`close-surface` の 4 ロール化は Task 7 の担当**である（spec §6 の表）。`loop-cleanup.sh` は
leave だけを持ち、close はディスパッチ末尾の SKILL.md `:2789-2832` にある。そちらの
`.. | objects | .surface_id? // empty` の再帰列挙を **4 ロールキーの明示列挙**へ変え、
`awk 'NF && !seen[$0]++'` の重複除去と `close-surface --workspace` 必須は維持する。
件数の回帰は `test-loop-cleanup.sh`（leave）と `test-cleanup-close.sh`（close）で別々に固定する。

- [ ] **Step 6: テストを走らせて通過を確認**

```bash
bash apps/cmux-team-dispatch-task/test/test-loop-prompt.sh
bash apps/cmux-team-dispatch-task/test/test-loop-cleanup.sh
# ここで走らせないもの (どちらも Task 7 の実装が入るまで必ず赤い):
#   test-snapshot-contract.sh — SC7 が SKILL.md を見る
#   test-cleanup-close.sh     — 対象の close 実装は SKILL.md 側
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
- Modify: `apps/cmux-team-dispatch-task/test/test-cleanup-close.sh`（close の 4 ロール化と workspace 照合。実装が SKILL.md 側にあるためここが担当）
- Modify: `apps/cmux-team-dispatch-task/test/test-override.sh`（`override-args.sh` を通した OV14 を含む）

**Interfaces:**
- Consumes: Task 2 の `config-resolve.sh` CLI、Task 2b の `override-args.sh`、Task 5 の `prewarm.json` スキーマ、Task 4 の `--role` 値域
- Produces: 子セッションへ埋め込む placeholder 名（Task 9 / 10 のドキュメントが参照する）

- [ ] **Step 1: Step 1f を書き換える（`SKILL.md:223-340`）**

対話フローを全削除し、次に置き換える（**英語で書く**）:

```markdown
### 1f. Resolve Roles

Every role is fixed by configuration. There is no interactive resolution at dispatch time.

`config-lib.sh` is **source-only** — running it produces no output. Source it and call its
functions:

```bash
. <SKILL_DIR>/scripts/config-lib.sh
RUNNERS_FILE="$(dispatch_runners_file)"
[[ -f "$RUNNERS_FILE" ]] || run_first_run_setup   # see First-run setup below, then continue

ROOT="$(git rev-parse --show-toplevel)"
ROLES_JSON="<STATUS_DIR>/roles.json"
mkdir -p "$(dirname "$ROLES_JSON")"

# Keep the resolver's exit code. `|| exit 1` would flatten 2 into 1 and make the
# "run --setup" branch below unreachable.
RESOLVE_RC=0
bash <SKILL_DIR>/scripts/config-resolve.sh --project-root "$ROOT" > "$ROLES_JSON" \
  || RESOLVE_RC=$?
case "$RESOLVE_RC" in
  0) ;;
  2) echo "[error] a role is unconfigured: $(cat "$ROLES_JSON" 2>/dev/null)" >&2
     echo "        run this skill with --setup to fix the configuration" >&2
     rm -f "$ROLES_JSON"; exit 1 ;;
  *) echo "[error] config-resolve.sh failed (rc=$RESOLVE_RC); the configuration could not be read" >&2
     rm -f "$ROLES_JSON"; exit 1 ;;
esac
```

Exit 2 means a role has no usable runner, or a codex review role has no model — a
configuration error the user must fix. Any other non-zero means the resolver itself failed
(unreadable file, broken JSON). **Keep the two on separate branches**: the first names a fix,
the second does not. Create no panes on either.

Read every role value from `$ROLES_JSON`. Do not re-derive them anywhere else.
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
- 結果の適用。**選択されたロールと、実際に変更された次元だけ**を `--set` へ組み立てる。
  `exec` 固定でも `model` / `effort` 固定でもない:

  ```bash
  # 各ロールの pending tuple が確定したら、変更された次元だけを集める。
  # OVERRIDE_ARGS は配列で持つ (文字列連結は値に空白があると壊れる)。
  OVERRIDE_ARGS=()
  for role in design design_review exec exec_review; do
    # <role> が Call 2 で選ばれていなければスキップする
    eval "sel=\${SELECTED_$role:-}"; [[ -n "$sel" ]] || continue
    for field in runner model effort; do
      eval "v=\${PENDING_${role}_${field}:-}"
      # 「変更なし」を選んだ次元は空のまま。空は --set しない
      [[ -n "$v" ]] || continue
      OVERRIDE_ARGS+=(--set "$role.$field=$v")
    done
  done

  if [[ ${#OVERRIDE_ARGS[@]} -gt 0 ]]; then
    RESOLVE_RC=0
    bash <SKILL_DIR>/scripts/config-resolve.sh --project-root "$ROOT" \
      "${OVERRIDE_ARGS[@]}" > "$ROLES_JSON.new" || RESOLVE_RC=$?
    if [[ "$RESOLVE_RC" -eq 0 ]]; then
      mv "$ROLES_JSON.new" "$ROLES_JSON"
    else
      rm -f "$ROLES_JSON.new"
      echo "[warn] the override produced an unresolvable configuration; keeping the resolved values" >&2
    fi
  fi
  ```

  `runner` を含めるのが要点である。runner の override は engine を変えるので、
  `--set <role>.runner=` を渡さないと model / effort だけが変わって engine と食い違う。
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

- [ ] **Step 4a: review ロールの readiness 失敗を親側で扱う（spec §5 の表）**

`[ready] <name>` を待つ既存のステップに、ロール別の分岐を足す:

- `design` / `exec` の `[ready]` が来なければ**従来どおりディスパッチを止める**。
- `design_review` の `[ready]` が来なければ**警告して Phase A-R をスキップ**する。config は
  書き換えない。
- `exec_review` の `[ready]` が来なければ**警告して Phase B-R をスキップ**し、
  `code-review.json` を書かず `--review-config` も渡さない（Step 4b の gating と同じ扱い）。

`prewarm.json` にキーがあることは **launch が成功した**ことしか意味しない。readiness の
成功と同一視してはならない。codex ペインについては `verify-agmsg-ready.sh --codex` で
「seat 未記録」と「ペイン死亡」を切り分ける既存の手順をそのまま使う。

**判定結果を `prewarm.json` へ書き戻す**（R3 #5）。これをしないと下流（renderer / cleanup /
gating）は「キーがある = 使える」と読むしかなく、readiness に失敗した review ロールにも依頼を
送ってしまう。`[ready]` の収集が終わった時点で、**ready にならなかった review ロールのキーを
削除**する:

**キーを消す前に、そのペインと team member を回収する**（R4 #4）。readiness 失敗は launch
失敗と違い、**surface が既に作られ agmsg に join も済んでいる**状態で起きる。先にキーを消すと、
後続の loop cleanup も最終 cleanup も「実在するロール」だけを列挙するので、そのペインと
member を誰も回収できず残る。

```bash
# writer 固有 mktemp + 同一ディレクトリ mv (config-edit.sh と同じ規約)
prune_not_ready() {   # $1.. = ready にならなかったロール名
  local pj="<EXISTING_STATUS_DIR>/prewarm.json" tmp role filter='.' sf ag
  [[ $# -gt 0 ]] || return 0

  # 1) 先に回収する。キーを消したあとでは surface_id も agent も引けない。
  for role in "$@"; do
    sf=$(jq -r --arg r "$role" '.[$r].surface_id // empty' "$pj")
    ag=$(jq -r --arg r "$role" '.[$r].agent // empty' "$pj")
    [[ -n "$sf" ]] && "$CMUX_BIN" close-surface --workspace "$WS" --surface "$sf" 2>/dev/null || true
    [[ -n "$ag" ]] && "$AGMSG_DIR/leave.sh" "$TEAM" "$ag" >/dev/null 2>&1 || true
  done

  # 2) そのあとでキーを消す
  tmp=$(mktemp "$pj.XXXXXX") || return 1
  for role in "$@"; do filter="$filter | del(.$role)"; done
  if jq "$filter" "$pj" > "$tmp"; then mv "$tmp" "$pj"; else rm -f "$tmp"; return 1; fi
}
```

**呼び出し側は fail-closed にする**。`prune_not_ready` が非 0 を返したときは
`prewarm.json` に stale なキーが残っているので、**render も配送も行わずに停止**する:

```bash
prune_not_ready "${NOT_READY[@]}" || {
  echo "[error] could not prune non-ready roles from prewarm.json; stopping before delivery" >&2
  echo "        (a stale role key would send a request to a pane that never reported ready)" >&2
  exit 1
}
```

これで **「ロールが `prewarm.json` に存在する ⇔ そのロールは使える」**が下流全体で成り立ち、
renderer は追加の入力を持たずに 3 状態を正しく表現できる（spec §6 の表）。
`design` / `exec` が ready にならなかった場合は削除ではなく**ディスパッチを止める**。

**順序を守ること**: prewarm 起動 → `[ready]` 収集 → `prune_not_ready` → 以降の
renderer / delivery / `code-review.json` 生成。

- [ ] **Step 4b: レビュー 2 ロール化と `code-review.json` の gating（spec §5）**

- `REVIEW_POLICY` / `resolve_code_reviewer_for_choice` / legacy cross-engine resolver の記述を
  **すべて削除**する。設計セッションがレビュアーへ転じる分岐（`:1619`, `:1648`, `:1666`,
  `:1851`, `:1907` 付近）も消し、設計ペインは**常に** `.deferred` を作って exit する形にする。
- Phase A-R は `design_review` ペインが spec / plan の 2 ポイントで再利用される。
- Phase B-R は `exec_review` ペインが担当する。`review/code-review.json` は常に `exec_review` の
  解決値で埋める（`reviewer_surface` / `reviewer_agent` / `reviewer_runner` / `reviewer_engine` /
  `reviewer_workspace` / `review_dir` のフィールド自体は配線情報として残す）。
- **gating**: `code-review.json` を書き `--review-config` を渡すのは、**次の 2 つが揃った
  ときだけ**である。どちらか欠けたら**両方とも省略**して Phase B-R の gate をスキップし、
  警告を出す。到達不能な surface / agent を書いた JSON を残すと、実装者が永遠に来ない
  verdict を待つ。
  1. `prewarm.json` に `exec_review` キーがある（launch 成功。Task 5）
  2. `exec_review` から `[ready] <slug>-exec-review` を受け取った（readiness 成功。Step 4a）
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
- **最終クリーンアップの close-surface を 4 ロール化する**（`:2789-2832`。spec §6 の表）。
  `.. | objects | .surface_id? // empty` と `.. | objects | .agent? // empty` の**再帰列挙**を、
  4 ロールキーの**明示列挙**へ変える:
  ```bash
  jq -r '. as $d | ["design","design_review","exec","exec_review"]
         | map(select($d[.] != null) | $d[.].surface_id) | .[]' <<<"$PREWARM_DOC"
  ```
  `awk 'NF && !seen[$0]++'` の重複除去と `close-surface --workspace` 必須は**維持**する
  （CLAUDE.md 項目 42）。
  **workspace 照合を追加する**（spec §4）: `prewarm.json` の `workspace_id` を、
  status.json / 引数 / `cmux workspace list` を `[<slug>]` でリテラル一致して引いた値
  （この 3 つは `prewarm.json` とは独立に得られる）と**比較し、一致したときだけ**
  `close-surface` する。一致しなければ警告して**close を 1 件も行わない**。
  `workspace_id` が欠落しているときの `cmux workspace list` フォールバックは維持する。
  再帰列挙のままだと、将来 `prewarm.json` に `surface_id` を持つ別のオブジェクトが増えたときに
  無関係なサーフェスを閉じる。回帰は `test-cleanup-close.sh` で `review_mode=on` の 4 件 /
  `off` の 2 件を固定する。

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

- [ ] **Step 9: `test-override.sh` を更新する（spec §7）**

`test/test-input-validation.sh` は **Task 8 で作る**（検査対象の `setup-mode*.md` の更新が
Task 8 のため。Task 7 で作ると必ず赤い）。参考として、その内容は次のとおり:

```bash
#!/usr/bin/env bash
#   IV1. SKILL.md / setup-mode.md / setup-mode-ja.md に「コマンドを組み立てる前に検証する」旨がある
#   IV2. 拒否文字集合が 3 文書で一致する (' " ` $ \ ! と制御文字と空と前後空白)
#   IV3. 違反時は再質問する旨がある
#   IV4. 3 次元 (runner / model / effort) すべてが事前検証の対象と書かれている
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
R="$SCRIPT_DIR/../skills/cmux-team-dispatch-task"
fail=0; bad() { echo "FAIL $1"; fail=1; }; ok() { echo "PASS $1"; }
for f in "$R/SKILL.md" "$R/references/setup-mode.md" "$R/references/setup-mode-ja.md"; do
  base=$(basename "$f")
  grep -qE 'before building|before the command|コマンドを組み立てる前' "$f" \
    && ok "IV1: $base に事前検証の契約がある" || bad "IV1: $base"
  # 1 文字ずつ検査する。'\$' は「バックスラッシュ + ドル」の 2 文字、'\\' は
  # 「バックスラッシュ 2 個」になってしまうので使わない。
  for ch in "'" '"' '`' '$' '\' '!'; do
    grep -qF -- "$ch" "$f" || bad "IV2: $base に拒否文字 [$ch] が列挙されていない"
  done
  grep -qE 're-ask|再質問' "$f" && ok "IV3: $base に再質問の指示がある" || bad "IV3: $base"
  for dim in runner model effort; do
    grep -qi "$dim" "$f" || bad "IV4: $base に $dim への言及が無い"
  done
done
exit $fail
```

（上のブロックは Task 8 で作成する。Task 7 では書かない。）

`test/test-override.sh` の更新（spec §7 / R2 #6 / R2 #3 / R4 #1）:

```bash
#   OV10. 対象ロールが design / design_review / exec / exec_review の 4 つ
#   OV11. review 2 ロールは review_mode=on のときだけ提示される
#   OV12. 全ロール・全フィールドを override しても両 config.json がバイト単位で不変
#   OV13. override 無しで再 resolve すると元の値へ戻る
#   OV14. pending tuple の 3 負例 (model / effort / 未登録 runner) がそのロールの変更を
#         丸ごと破棄し、他ロールの override は生き残る
#   OV15. prewarm へは --roles 1 本で渡り、旧 6 フラグは現れない
```

OV12 / OV13 / OV14 / OV15 の実体（**4 ロール × 3 次元をすべて回し、適用されたことも確認する**。
バイト不変だけを見ると「`--set` を無視して config も変えない実装」が通ってしまう）:

```bash
# 4 ロール × 3 次元ぶんの --set を一度に渡す
ARGS=()
for r in design design_review exec exec_review; do
  ARGS+=(--set "$r.runner=cx" --set "$r.model=M-$r" --set "$r.effort=medium")
done
g_before=$(shasum -a 256 "$GLOBAL_CONFIG" | cut -d' ' -f1)
p_before=$(shasum -a 256 "$PROJ_CONFIG"   | cut -d' ' -f1)
out=$(bash "$RESOLVE" --project-root "$PROJ" "${ARGS[@]}")

# OV12a: すべての override が実際に適用されている
applied=1
for r in design design_review exec exec_review; do
  [[ "$(jq -r --arg r "$r" '.roles[$r].runner' <<<"$out")" == 'cx'       ]] || applied=0
  [[ "$(jq -r --arg r "$r" '.roles[$r].model'  <<<"$out")" == "M-$r"     ]] || applied=0
  [[ "$(jq -r --arg r "$r" '.roles[$r].effort' <<<"$out")" == 'medium'   ]] || applied=0
  [[ "$(jq -r --arg r "$r" '.roles[$r].engine' <<<"$out")" == 'codex'    ]] || applied=0
done
[[ $applied -eq 1 ]] && ok 'OV12a: 4 ロール × 3 次元の override が適用され engine も追随する' \
  || bad "OV12a: $(jq -c '.roles' <<<"$out")"

# OV12b: それでも両 config は 1 バイトも変わらない
[[ "$(shasum -a 256 "$GLOBAL_CONFIG" | cut -d' ' -f1)" == "$g_before" \
&& "$(shasum -a 256 "$PROJ_CONFIG"   | cut -d' ' -f1)" == "$p_before" ]] \
  && ok 'OV12b: override は両 config を 1 バイトも変えない' || bad 'OV12b'

# OV13: 次回の resolve は元の値へ戻る
out2=$(bash "$RESOLVE" --project-root "$PROJ")
[[ "$(jq -r '.roles.design.model' <<<"$out2")" == 'opus[1m]' \
&& "$(jq -r '.roles.design.runner' <<<"$out2")" == 'ccf' ]] \
  && ok 'OV13: 次回の resolve は元の値へ戻る' || bad "OV13: $(jq -c '.roles.design' <<<"$out2")"

# OV14: 「ロール丸ごと破棄」は **override-args.sh の責務**である (Task 2b)。
#       resolver はフィールド単位の layer fallback をするので、不正値を直接 resolver へ渡すと
#       正しい実装ほど「有効な次元だけ適用」して当然になる。したがってここでは
#       **builder を通した引数列**を resolver へ渡し、破棄が効いていることを見る。
#       (builder 自身の詳細な負例は test-override-args.sh が持つ)
build_args() {   # $@ = --pending ...
  ARGS=()
  while IFS= read -r -d '' a; do ARGS+=("$a"); done < <(
    bash "$OVERRIDE_ARGS_SH" --roles "$ROLES_JSON" --runners "$RUNNERS_JSON" "$@" 2>/dev/null)
}
build_args --pending design.model=KEPT \
           --pending exec.runner=cx --pending 'exec.model=opus[1m]' --pending exec.effort=medium
out4=$(bash "$RESOLVE" --project-root "$PROJ" ${ARGS[@]+"${ARGS[@]}"})
if [[ "$(jq -r '.roles.design.model' <<<"$out4")" == 'KEPT' ]] \
   && [[ "$(jq -r '.roles.exec.effort' <<<"$out4")" != 'medium' ]] \
   && [[ "$(jq -r '.roles.exec.runner' <<<"$out4")" != 'cx' ]]; then
  ok 'OV14: builder が exec を丸ごと破棄し、design の override だけが resolver へ届く'
else
  bad "OV14: $(jq -c '.roles.exec, .roles.design' <<<"$out4")"
fi

# OV15: prewarm へは --roles 1 本で渡り、旧 6 フラグが現れない
grep -nE -- '--design-model|--design-effort|--reviewer-model|--reviewer-effort|--exec-model|--exec-effort' \
  "$SKILL_MD" && bad 'OV15: 旧 override フラグが SKILL.md に残っている' \
  || ok 'OV15: prewarm への引渡しは --roles 1 本'
```

- [ ] **Step 9b: gating と cleanup 照合の動的テストを足す（R4 #5）**

`test/test-launch-workspace-review-config.sh` に **exec_review の「key 有無 × ready 有無」
2x2** を足す。`code-review.json` と `--review-config` は**必ず同時に出るか同時に出ないか**の
どちらかでなければならない:

| `prewarm.json` の `exec_review` | `[ready] <slug>-exec-review` | `code-review.json` | `--review-config` |
|---|---|---|---|
| あり | 受領 | **作る** | **渡す** |
| あり | 未受領（親が prune 済みなので実際にはキーも消える） | 作らない | 渡さない |
| なし（launch 失敗） | — | 作らない | 渡さない |
| なし（prune 済み） | — | 作らない | 渡さない |

```bash
for case in have_ready have_notready missing; do
  setup_prewarm "$case"       # exec_review キーと ready sentinel を case ごとに用意する
  run_phase_b_wiring
  cr="$STATUS/review/code-review.json"
  if [[ "$case" == have_ready ]]; then
    { [[ -f "$cr" ]] && grep -q -- '--review-config' "$GENERATED_CMD"; } \
      && ok "RC-$case: 両方そろって出る" || bad "RC-$case"
  else
    { [[ ! -f "$cr" ]] && ! grep -q -- '--review-config' "$GENERATED_CMD"; } \
      && ok "RC-$case: 両方とも出ない" || bad "RC-$case: 片方だけ出た"
  fi
done
```

`test/test-cleanup-close.sh` には **workspace 一致 / 不一致の 2 fixture**を足す
（件数だけでは照合を実装しないコードが通る）:

```bash
# 一致: review on で 4 件、off で 2 件 close する
close_fixture 'workspace:1' on ; [[ "$(close_count)" == 4 ]] && ok 'CL3a' || bad 'CL3a'
close_fixture 'workspace:1' off; [[ "$(close_count)" == 2 ]] && ok 'CL3b' || bad 'CL3b'
# 不一致: 1 件も close しない
close_fixture 'workspace:999' on; [[ "$(close_count)" == 0 ]] \
  && ok 'CL3c: workspace 不一致では 1 件も close しない' || bad 'CL3c'
```

- [ ] **Step 10: 検証**

```bash
pnpm check:doc-lang
bash apps/cmux-team-dispatch-task/test/test-skill-script-refs.sh
bash apps/cmux-team-dispatch-task/test/test-snapshot-contract.sh   # SC7 がここで初めて緑になる
bash apps/cmux-team-dispatch-task/test/test-override.sh
bash apps/cmux-team-dispatch-task/test/test-cleanup-close.sh       # close の 4 ロール化と workspace 照合
bash apps/cmux-team-dispatch-task/test/test-override-args.sh       # Task 2b から継続して緑
bash apps/cmux-team-dispatch-task/test/test-launch-workspace-review-config.sh  # gating の 2x2
```

**`test-delivery-callsites.sh` は Task 7 では走らせない。** CS4 は Task 3 で意図的に赤くした
ラチェットで、参照がゼロになるのは Task 10 である。全体を実行すれば必ず非 0 になり、
「CS3 / CS5-CS7 を見たい」というコメントを添えても checkpoint は緑にならない（R3 #8）。
このタスクで CS3 / CS5-CS7 だけを確認したいなら、対象の grep を手で走らせるか、
テスト側に `--only CS3,CS5,CS6,CS7` のような絞り込みを足す。**全体の green 確認は Task 10** で行う。

- [ ] **Step 11: commit しない（Task 10 まで持ち越す）**

Global Constraints の**4 ファイル整合の絶対ルール**は、SKILL.md / guide-ja.md / README.md /
CLAUDE.md を**同じ commit** で更新することを要求する。Task 7 で前 2 つだけを commit すると
このルールを破る。したがって **Task 7 / 8 / 9 は commit せず、Task 10 の 1 commit にまとめる**
（作業単位としてはタスクを分けるが、git の単位は 1 つ）。

作業ツリーを次のタスクへ引き継ぐだけでよい。中断する場合は
`git stash push -u -m "config-schema-4role-docs-wip"` ではなく**WIP commit** を使い、
Task 10 で `git reset --soft` してまとめ直す（stash はワークツリー間で共有されるため）。

---

## Task 8: `setup-mode.md` / `setup-mode-ja.md`

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/setup-mode.md`（英語）
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/setup-mode-ja.md`（日本語）
- Modify: `apps/cmux-team-dispatch-task/test/test-setup-skill.sh`
- Create: `apps/cmux-team-dispatch-task/test/test-input-validation.sh`（Task 7 Step 9 に内容を載せてある。検査対象の `setup-mode*.md` を更新するこのタスクで作る）

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
- 追加（**needle 検査**）: pending tuple の 3 負例（model / effort / 未登録 runner）が節に
  書かれていること、入口ごとの表が英日で同じ行数・同じ順であること、`--reset all` が両レイヤーを
  消す旨が英日にあること。
- 追加（**動的検査**。spec §7 が要求する入口ごとの実挙動。needle だけでは
  「config を途中で書く実装」も「`--reset all` が片方のレイヤーしか消さない実装」も通る）。

  `--setup` / `--reset` の**対話部分は LLM が実行するのでテストできない**。テストできるのは
  「入口ごとに、どのファイルへ何回書き、最後に resolve が通るか」という**副作用の列**である。
  そこで各入口を**手順の列として最後まで実行**し、各ステップの前後で両 config のバイト列を
  比べる。1 コールだけを模倣する形（前回の SU17-SU20）では、First-run が config を作らない
  実装や `--reset all` が再初期化しない実装が通ってしまう。

  **この形の限界を明示しておく**（R4 #7）。`write_registry` / `write_initial_config` は
  テスト側が定義した「あるべき手順」なので、本番の指示文が違う手順を書いていてもこの動的
  テストは通る。したがって**静的 assertion と組で使う**:

  - 動的側（下の SU17-SU22）は「その手順を実行したら config はこうなる」を固定する。
  - 静的側（`test-input-validation.sh` / `test-setup-skill.sh` の needle）は
    「`setup-mode.md` の入口表の各行が、その手順を指示している」ことを固定する。
    具体的には入口表の 6 行それぞれについて、`config.json` 列の値（「初期値を作成」/
    「書かない」/「2 キーを unset」）が英日で一致し、行の順序も一致していることを検査する。
  - 残余: 「指示文どおりに LLM が実行するか」は自動テストの範囲外である。これは
    `--setup` が対話フローである以上避けられないので、残余リスクとして受け入れる。

  各入口の期待は §6 の表と 1:1 に対応させる:

  | 入口 | 実行する手順 | 検査 |
  |------|--------------|------|
  | 初回ディスパッチ | `runners.json` 不在 → First-run 相当（registry 書き込み → 初期 config 書き込み）→ resolve | 終了時に global config が生成され、project は不変、resolve が exit 0 |
  | `--reset config`（global） | `config-edit.sh --unset review_mode --unset runner`（global のみ）| global の 2 キーだけ消え、`shell_ready_ms` と `loop` が不変、project がバイト不変、resolve が exit 2 |
  | `--reset config`（project） | 同上を project のみへ | project の役割キーだけ消え、global がバイト不変 |
  | `--reset runners` | `rm runners.json` → reset mode First-run（registry のみ書き込み）| **両 config がバイト不変**（初期 config を書かない）|
  | `--reset all` | 両レイヤーへ `--unset` → `rm runners.json` → **通常モード** First-run（registry + 初期 config）→ resolve | 両レイヤーの役割キーが消え、global に初期 config が再生成され、第三者キーが残り、resolve が exit 0 |

```bash
# global と project に異なる値を置く
setup_fixture() {
  mkdir -p "$G_DIR" "$P_DIR/.dispatch"
  printf '%s\n' '{"shell_ready_ms":{"baseline_ms":7},"loop":{"task_timeout_min":45},
"review_mode":"on","runner":{"design":{"runner":"ccf"},"design_review":{"runner":"ccf"},
"exec":{"runner":"ccf"},"exec_review":{"runner":"ccf"}}}' > "$G_DIR/config.json"
  printf '%s\n' '{"runner":{"design":{"model":"fable"}}}' > "$P_DIR/.dispatch/config.json"
}
sha() { shasum -a 256 "$1" 2>/dev/null | cut -d' ' -f1; }

# SU17: --reset config (global のみ選択) は global の 2 キーだけ消し project を触らない
setup_fixture; p_before=$(sha "$P_DIR/.dispatch/config.json")
bash "$EDIT" --config "$G_DIR/config.json" --unset review_mode --unset runner >/dev/null
[[ "$(jq -r 'has("review_mode") or has("runner")' "$G_DIR/config.json")" == 'false' \
&& "$(jq -r '.loop.task_timeout_min' "$G_DIR/config.json")" == '45' \
&& "$(sha "$P_DIR/.dispatch/config.json")" == "$p_before" ]] \
  && ok 'SU17: --reset config (global) は global の 2 キーだけ消し project を温存' || bad 'SU17'

# SU18: --reset all は両レイヤーの役割キーを消す
setup_fixture
for c in "$G_DIR/config.json" "$P_DIR/.dispatch/config.json"; do
  bash "$EDIT" --config "$c" --unset review_mode --unset runner >/dev/null
done
[[ "$(jq -r 'has("runner")' "$G_DIR/config.json")" == 'false' \
&& "$(jq -r 'has("runner")' "$P_DIR/.dispatch/config.json")" == 'false' \
&& "$(jq -r '.shell_ready_ms.baseline_ms' "$G_DIR/config.json")" == '7' ]] \
  && ok 'SU18: --reset all は両レイヤーの役割キーを消し第三者キーを温存' || bad 'SU18'

# SU17b: --reset config (project のみ) は project の役割キーだけ消し global を触らない
setup_fixture; g_before=$(sha "$G_DIR/config.json")
bash "$EDIT" --config "$P_DIR/.dispatch/config.json" --unset review_mode --unset runner >/dev/null
[[ "$(jq -r 'has("runner")' "$P_DIR/.dispatch/config.json")" == 'false' \
&& "$(sha "$G_DIR/config.json")" == "$g_before" ]] \
  && ok 'SU17b: --reset config (project) は global を温存' || bad 'SU17b'

# --- First-run 相当の書き込みを 1 つの関数にまとめ、入口ごとに「実行するか否か」を見る ---
# 実際の --setup は LLM が対話で駆動するが、config へ書く操作はこの列に集約される。
write_registry() {
  printf '%s\n' '{"default":"ccf","runners":[{"name":"ccf","command":"ccf","engine":"claude"}]}' \
    > "$G_DIR/runners.json"
}
write_initial_config() {   # 通常モードの First-run だけが呼ぶ
  local args=(--config "$G_DIR/config.json" --set review_mode=on)
  for r in design design_review exec exec_review; do args+=(--set "runner.$r.runner=ccf"); done
  bash "$EDIT" "${args[@]}" >/dev/null
}
resolve_rc() {
  DISPATCH_CONFIG_HOME="$G_DIR" bash "$RESOLVE" --project-root "$P_DIR" >/dev/null 2>&1
  echo $?
}

# SU19: --reset runners = registry 削除 → **reset mode** First-run (registry のみ)。
#       両 config が 1 バイトも変わらないこと。
setup_fixture; g_before=$(sha "$G_DIR/config.json"); p_before=$(sha "$P_DIR/.dispatch/config.json")
rm -f "$G_DIR/runners.json"
write_registry                 # reset mode は write_initial_config を **呼ばない**
[[ "$(sha "$G_DIR/config.json")" == "$g_before" \
&& "$(sha "$P_DIR/.dispatch/config.json")" == "$p_before" ]] \
  && ok 'SU19: --reset runners は両 config を 1 バイトも変えない' || bad 'SU19'

# SU20: 初回ディスパッチ = registry 不在 → 通常モード First-run → resolve が通る
rm -rf "$G_DIR" "$P_DIR"; mkdir -p "$G_DIR" "$P_DIR/.dispatch"
write_registry; write_initial_config
[[ "$(resolve_rc)" == 0 ]] && ok 'SU20a: 初回ディスパッチ後は resolve が exit 0' || bad 'SU20a'
for r in design design_review exec exec_review; do
  [[ "$(jq -r --arg r "$r" '.runner[$r].runner' "$G_DIR/config.json")" == 'ccf' ]] \
    || bad "SU20b: 初期 config の $r に default runner が入っていない"
done
[[ "$(jq -r '.runner.design | has("model")' "$G_DIR/config.json")" == 'false' ]] \
  && ok 'SU20c: 初期 config は model / effort を書かない (既定値に任せる)' || bad 'SU20c'
[[ ! -e "$P_DIR/.dispatch/config.json" ]] \
  && ok 'SU20d: 初期 config は global にだけ書かれる' || bad 'SU20d'

# SU21: --reset all = 両レイヤーの役割キー削除 → registry 削除 → **通常モード** First-run
#       → resolve が通る (再初期化しない実装を落とす)
setup_fixture
for c in "$G_DIR/config.json" "$P_DIR/.dispatch/config.json"; do
  bash "$EDIT" --config "$c" --unset review_mode --unset runner >/dev/null
done
rm -f "$G_DIR/runners.json"
write_registry; write_initial_config
[[ "$(resolve_rc)" == 0 ]] && ok 'SU21a: --reset all の後は resolve が exit 0' || bad 'SU21a'
[[ "$(jq -r 'has("runner")' "$P_DIR/.dispatch/config.json")" == 'false' \
&& "$(jq -r '.shell_ready_ms.baseline_ms' "$G_DIR/config.json")" == '7' ]] \
  && ok 'SU21b: project の役割キーは消え第三者キーは残る' || bad 'SU21b'

# SU22: --reset config の直後は resolve が exit 2 (設定が無いので fail-fast する)
setup_fixture; write_registry
bash "$EDIT" --config "$G_DIR/config.json" --unset review_mode --unset runner >/dev/null
bash "$EDIT" --config "$P_DIR/.dispatch/config.json" --unset review_mode --unset runner >/dev/null
[[ "$(resolve_rc)" == 2 ]] && ok 'SU22: --reset config の後は resolve が exit 2' || bad 'SU22'
```

- [ ] **Step 6: 検証**

```bash
pnpm check:doc-lang
bash apps/cmux-team-dispatch-task/test/test-setup-skill.sh
bash apps/cmux-team-dispatch-task/test/test-input-validation.sh
```

- [ ] **Step 7: commit**

**commit しない**（Task 10 へ持ち越す。4 ファイル整合の絶対ルールのため。Task 7 Step 11 参照）。

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

- [ ] **Step 2: renderer の呼び出しと順序を直す**

ループが `render-loop-prompt.sh` を呼ぶ箇所の引数を `--prewarm <STATUS_DIR>/prewarm.json` に
する。ロール別フラグの記述を消す。

**あわせて呼び出し順序を直す**（R3 #5）。`loop-mode.md:125-126` は「renderer → prewarm」の順で
書かれているが、renderer の入力が `prewarm.json` になった以上この順序は成立しない。正しい順序を
明記する: **prewarm 起動 → `[ready]` 収集 → `prune_not_ready`（ready にならなかった review
ロールを削除）→ renderer → 配送**。日本語版も同じ順序へ揃える。

- [ ] **Step 3: `loop.task_timeout_min` の位置を明記する**

`config.json` の第三者キーであり、`--reset config` で消えないことを 1 行書く。

- [ ] **Step 4: 検証**

```bash
pnpm check:doc-lang
bash apps/cmux-team-dispatch-task/test/test-loop-skill.sh
```

- [ ] **Step 5: commit**

**commit しない**（Task 10 へ持ち越す。4 ファイル整合の絶対ルールのため。Task 7 Step 11 参照）。

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

**Task 7 / 8 / 9 / 10 の全変更を 1 commit にまとめる**（4 ファイル整合の絶対ルール）。
Task 7 で作った `test-input-validation.sh` と更新した `test-override.sh` もここに含める:

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md \
        apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references \
        apps/cmux-team-dispatch-task/README.md \
        apps/cmux-team-dispatch-task/CLAUDE.md \
        apps/cmux-team-dispatch-task/test
git commit -m "docs(dispatch)!: 4 ファイルと参照ドキュメントを 4 ロール契約へ更新する"
```

commit 前に `git status --porcelain` で **4 ファイルすべてが含まれている**ことを確認する。
1 つでも欠けていたら整合ルール違反なので commit しない。

---

## Task 11: バージョン 3.0.0 と全体検証

**Files:**
- Modify: `apps/cmux-team-dispatch-task/.claude-plugin/plugin.json`
- Modify: `apps/cmux-team-dispatch-task/.codex-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`（ルート）

- [ ] **Step 1: 3 箇所の version を `3.0.0` にする**

**固定名の `/tmp/p1` などへリダイレクトしてはならない**（既存ファイルを壊す。symlink が
置かれていれば別の writable file を上書きする。`/tmp` と対象が別ファイルシステムなら `mv` も
atomic でない）。**対象と同じディレクトリに `mktemp` を作り、jq 成功時だけ `mv`** する
（`config-edit.sh` と同じ規約）:

```bash
bump() {  # $1=対象ファイル $2=jq 式
  local f="$1" expr="$2" tmp
  tmp=$(mktemp "$f.XXXXXX") || { echo "mktemp failed for $f" >&2; return 1; }
  if jq "$expr" "$f" > "$tmp"; then
    mv "$tmp" "$f"
  else
    rm -f "$tmp"; echo "jq failed for $f; left unchanged" >&2; return 1
  fi
}
bump apps/cmux-team-dispatch-task/.claude-plugin/plugin.json '.version = "3.0.0"'
bump apps/cmux-team-dispatch-task/.codex-plugin/plugin.json  '.version = "3.0.0"'
bump .claude-plugin/marketplace.json \
  '(.plugins[] | select(.name == "cmux-team-dispatch-task") | .version) = "3.0.0"'
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
fail=0
for f in apps/cmux-team-dispatch-task/test/test-*.sh; do
  echo "=== $f ==="
  bash "$f" || { echo "!!! FAILED: $f"; fail=1; }
done
echo "aggregate exit: $fail"
exit $fail
```
Expected: `!!! FAILED` が 1 件も出ず、`aggregate exit: 0`。**`|| echo` だけでは失敗を握り潰す**
（`echo` が rc 0 を返すのでループが成功終了する）。

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

1. 全テストが緑。**失敗を集約して判定する**:
   ```bash
   fail=0
   for f in apps/cmux-team-dispatch-task/test/test-*.sh; do
     bash "$f" >/dev/null 2>&1 || { echo "FAILED: $f"; fail=1; }
   done
   exit $fail
   ```
2. `pnpm check` と `pnpm check:doc-lang` が exit 0。
3. `git status --porcelain` に未コミットの変更が無い（`.codex/` などの untracked は除く）。
4. 旧パスの残骸がない。**`test/` を除外する**（`test-config-paths.sh` の CP4 は「存在しないこと」を
   検査するために旧パス文字列を needle として意図的に持つ）:
   ```bash
   grep -rn '\.claude/cmux-team-dispatch-task' \
     apps/cmux-team-dispatch-task/skills apps/cmux-team-dispatch-task/README.md \
     apps/cmux-team-dispatch-task/CLAUDE.md
   ```
   Expected: 0 件
5. 旧語彙の残骸がない。**`test/` と `docs/` を除外する**（`test-doc-stale-vocab.sh` は旧語彙リスト
   そのものを持ち、`docs/` の spec と plan は履歴として旧語彙を説明している）:
   ```bash
   grep -rnE 'design_runner|review_runner|exec_choice|runners-edit|REVIEW_POLICY|plan_model|review_model|exec_model' \
     apps/cmux-team-dispatch-task/skills apps/cmux-team-dispatch-task/README.md \
     apps/cmux-team-dispatch-task/CLAUDE.md
   ```
   ただし CLAUDE.md の項目 47（退役候補の記録）など**意図的な履歴記述**には
   `stale-vocab-exempt:` マーカーを付けたうえで、検査側でも除外する:
   ```bash
   grep -rnE 'design_runner|review_runner|exec_choice|runners-edit|REVIEW_POLICY|plan_model|review_model|exec_model' \
     apps/cmux-team-dispatch-task/skills apps/cmux-team-dispatch-task/README.md \
     apps/cmux-team-dispatch-task/CLAUDE.md \
     | grep -v 'stale-vocab-exempt:'
   ```
   Expected: 0 件。マーカーの付いた行だけが除外される（`test-doc-stale-vocab.sh` の
   DS1/DS2 と同じ扱い）。
6. バージョンが 3 箇所とも `3.0.0`。
7. `bash apps/cmux-team-dispatch-task/test/test-delivery-callsites.sh` の **CS4 が PASS**
   （Task 3 で意図的に赤くしたラチェットが Task 10 で緑に戻っていること）。
8. **新規スクリプト 3 本が存在し、対応するテストが緑**であること:
   `config-lib.sh` / `config-resolve.sh` / `override-args.sh` と
   `test-config-lib.sh` / `test-config-resolve.sh` / `test-override-args.sh`。
9. **`fifo_read_once` を使うテストの実行後にプロセスが残らない**こと:
   `ps -eo command | grep -c '[p]rewarm-panes.sh'` が全テスト実行後に 0。
