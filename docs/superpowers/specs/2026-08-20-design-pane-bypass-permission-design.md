# 設計ペインの permission bypass に起動時フォールバックを足す設計

対象: `apps/cmux-team-dispatch-task`

## 背景

「設計 (Phase A) ペインが bypass-permission モードで上がらない」という報告を受けた。
`claude` engine の設計ペインは permission prompt が出ない状態で起動するはずだが、実際には
そうなっていない、という内容である。あわせて `codex` の設計ペインも承認バイパス済みで
上がることが要件として挙がっている。

## 調査結果

### 報告書が挙げた 3 つの仮説はいずれも棄却される

- **仮説「`standby` は注入コードパスに到達しない」→ 誤り。** Step 2a
  (`launch-workspace.sh:569`) は MODE の条件分岐の外にあり、`RUNNER_ENGINE == "claude"`
  だけを条件に発火する。prewarm の設計ペインが使う `standby` も当然対象。
- **仮説「書き込みがプロセス起動より後」→ 誤り。** Step 2a は 569 行、runner script 生成
  (Step 4) は 811 行以降、`cmux new-workspace` は 1133 行。設定ファイルは claude プロセスが
  読む前に確定している。
- **仮説「codex 設計ペインに bypass フラグが無い」→ 誤り。** hermetic な probe で composed
  command を確認したところ `codex -c model_reasoning_effort='xhigh'
  --dangerously-bypass-hook-trust --dangerously-bypass-approvals-and-sandbox` が生成されて
  いた（`prewarm-panes.sh:476` → `launch-workspace.sh:758-765`）。既存テスト T4
  (`test-launch-workspace-codex.sh:132`) も同じ内容を担保している。

本ディスパッチ自身の 3 ペインを `cmux read-screen` で実測した結果も、正常な worktree では
機構が働いていることを示している。

| surface | 役割 | 起動フラグ | 実測表示 |
|---------|------|-----------|---------|
| 47 | design | `claude --model 'opus[1m]' --effort 'xhigh'`（**権限フラグなし**） | `⏵⏵ bypass permissions on` |
| 48 | claude executor | `--dangerously-skip-permissions` あり | `⏵⏵ bypass permissions on` |
| 49 | review | `--dangerously-skip-permissions` あり | `⏵⏵ bypass permissions on` |

### 別経路の決定的な再現条件を特定した

上記 3 仮説は棄却されるが、**症状そのものは再現する**。`merge_claude_settings` が値を書けない
状態はいずれも警告だけで起動が続行され、claude 設計ペインは素の権限で上がる。再現形は 3 つある。

| ケース | 作り方 | 到達行 | stderr | 注入後の `settings.local.json` | `merge_claude_settings` の戻り値 |
|--------|--------|--------|--------|------------------------------|--------------------------------|
| A | `$CWD/.claude` が通常ファイル | `:121` | `failed to create .../.claude; skipping settings injection` | 存在しない | 1 |
| B | 既存 `settings.local.json` が不正 JSON | `:128` | `failed to merge into .../settings.local.json; skipping` | 不正 JSON のまま存在 | 1 |
| C | `settings.local.json` が**ディレクトリ** | `:142` | なし | ディレクトリのまま（中に temp が移動される） | **0（成功を報告する）** |

ケース B の実測（不正 JSON を置いた worktree に `--mode standby --role plan` で起動）:

```
[warn] failed to merge into .../.claude/settings.local.json; skipping
zsh -ic "claude --model 'opus[1m]' --effort 'xhigh' 'wait idle'"
```

権限フラグも `bypassPermissions` も無い。これが報告された症状と同じ見え方になる。
先の実測（surface 47 / 全 14 セッション）は「すでに正常に注入済みの worktree」の観測であり、
これらの経路を一度も踏んでいなかった。

**ケース C が本設計の要である。** `[[ -f ]]` が偽 → `jq -n` 成功 → `mv "$tmp" "$settings_file"`
が temp をディレクトリの**中へ**移動 → `return 0` を返し `[permissions] injected ...` を
ログに出す。値は 1 つも入っていない。つまり **`merge_claude_settings` の戻り値では原理的に
検出できない失敗が実在する**。だから後述の検証はファイル実体を読み直す形でなければならない。

なお「既存の `defaultMode` が別値だった」説は棄却でよい。`:575` の等値判定が偽になり `:578` が
`.permissions.defaultMode = "bypassPermissions"` を無条件代入するため、`plan` / `acceptEdits`
などが入った stale worktree は上書きされる。

## 修正すべき欠陥

### 欠陥 1: 設計ペインだけが単一機構に依存している

| ペイン | MODE | 権限フラグ | 注入失敗時 |
|--------|------|-----------|-----------|
| claude 設計 (prewarm・有人) | `standby` | なし | **素の権限で起動する** |
| claude 設計 (非 prewarm) | `superpowers` | なし | **素の権限で起動する** |
| claude 設計 (非 prewarm) | `plan` | 常時付与 | 無害 |
| claude 設計 (prewarm・`--unattended`) | `standby` | `--skip-permissions` 付き | 無害 |
| claude executor | `standby` | `--skip-permissions` 付き | 無害 |
| claude review | `review` | `--skip-permissions` 付き | 無害 |

設計ペインの有人経路だけが「第二の防壁」を持たない（loop の `--unattended` 経路は
`prewarm-panes.sh:497-498` と `launch-workspace.sh:741-743` により既にフラグを持つ）。
注入に失敗すると、誰も見ていないペインが最初の permission prompt で停止する。設計ペインは
status.json の遷移も親への完了通知も行わないまま止まるため、ディスパッチ全体がデッドロックする。

**この因果には前提条件がある。** bypass モード突入の確認ダイアログはフラグでも `defaultMode`
でも表示され、抑止する `skipDangerousModePermissionPrompt` は project settings では無視される
（`SKILL.md:422-425` / `README.md:158-161`）。したがって本設計は
**ユーザー設定 `~/.claude/settings.json` に `skipDangerousModePermissionPrompt: true` が
入っていること**を前提とする。この前提が満たされない環境では、フラグを足しても同じダイアログで
ペインは止まる。同様に managed / enterprise scope の `permissions.defaultMode` や
`disableBypassPermissionsMode` が効いている環境では、読み直しが成功しても実効モードは
bypass にならない。

### 欠陥 2: 設計ペイン起動経路にテストが無い

`test-launch-workspace-permissions.sh` の P1〜P11 はすべて `launch-workspace.sh` を直接叩く。
`prewarm-panes.sh` の設計ペイン起動経路について、**claude executor の `--skip-permissions`
無条件付与（`prewarm-panes.sh:567`）を assert しているテストは 1 本も無い**。P9 は `standby` を
扱うが `--skip-permissions` を **付けた** ケースなので、非対称そのものはテストから不可視である。

## 設計

方針は **起動時フォールバック**（fail-closed ではない。失敗時に権限を昇格させる設計であり、
呼称を正確にしておく）。注入を主機構として維持したまま、それが確認できなかったときに限り
CLI フラグへ落とす。正常系の composed command は 1 バイトも変えない。

`die` を採らない理由: 設計ペインが起動しないと Phase A ごと失われ、親は
「ペインが上がらない」という別の障害として観測することになる。permission bypass は
このプラグインの前提（`README.md:163-165` は opt-out 用の config キーを用意していないと明記）
なので、縮退起動より昇格起動のほうがプロジェクト意図に沿う。

(A) 注入が物理的に失敗した場合と (B) ファイルは読めるが別値が入っている場合を **挙動としては
区別しない**。(B) の唯一の実在形は「`.claude` が書き込み不可 + 既存の有効 JSON が別値」で
`:138` の `mktemp` が失敗するケースだが、その状態を repo 内のフローから作る経路は存在しない
（git は exec ビット以外の mode を保存しない / read-only FS や ENOSPC なら `:825` の
`cat > "$RUNNER_FILE"` が `set -e` 下で先に死ぬ / 同一 worktree への並行起動は prewarm が
全 launch を同期コマンド置換で直列化しているため到達不能 / repo が正規に tracked な
`settings.local.json` を持つケースは merge が成功して上書きされる）。残るのは手動 chmod と
別 uid 所有だけなので、専用分岐を足す理由が無い。区別は挙動ではなく **警告ログに実測値を
載せる**ことで担保する。

**symlink 検査も足さない。** `$CWD/.claude` がユーザーの `~/.claude` への symlink である場合、
書き込みはユーザーのグローバル設定へ抜ける。ただしこれは `:121` の `mkdir -p` と `:138` の
`mktemp` が既に symlink を追従している **既存の性質** であり、読み直しは同じ実体を見るだけで
blast radius を変えない。本変更が新たに広げるものは無い。

**壊れた `settings.local.json` を書き直すこともしない。** ケース B ではフラグを足すだけで、
不正 JSON のファイルは worktree に残したまま claude が読む。丸ごと書き直せば根本治療になるが、
**このファイルには agmsg の SessionStart / SessionEnd hook が同居する**
（`prewarm-panes.sh:411/417` の `delivery.sh set` が書く）。パース不能なファイルを破棄すると
配送配線を無言で落とすリスクがあり、permission の問題を直すために配送の問題を作ることになる。
検出して昇格するに留める。

### 変更 1: Step 2a に注入結果の読み直しを足す (`launch-workspace.sh`)

**挿入位置は `:580` の `fi` の直後、`:581-583` の `ensure_claude_exclusions` 用コメントの直前。**
claude 限定ブロックの内側に収めることで、codex engine では `BYPASS_INJECTION_OK` が 1 のまま残る。
`ensure_claude_exclusions` との前後関係に機能上の依存は無い（同関数は失敗しても `|| true` で
握り潰され、何も返さない）。決定性のために位置を固定するだけである。

`BYPASS_INJECTION_OK=1` の初期化は `:569` の `if` の直前に置く。

```bash
BYPASS_INJECTION_OK=1
if [[ "$RUNNER_ENGINE" == "claude" ]]; then
  ...既存の注入ブロック (:570-580) は変更なし...

  # 注入結果をファイル実体で読み直す。merge_claude_settings の戻り値を信用できないのは、
  # settings.local.json がディレクトリのとき mv が temp をその中へ移動して return 0 を返し、
  # 値が 1 つも入っていないのに「injected」とログに出るため。実体を見れば mkdir / mktemp /
  # jq の失敗も、既存ファイルが不正 JSON でマージが拒否されたケースも同時に捕まえられる。
  # 設計ペイン (standby / superpowers の有人経路) は CLI フラグを持たないので、
  # ここが唯一の防壁になる。
  EFFECTIVE_DEFAULT_MODE=$(jq -r '.permissions.defaultMode // ""' \
    "$CWD/.claude/settings.local.json" 2>/dev/null || echo "")
  # 値はログにしか使わないが、制御文字を含む値が stderr へ抜けると端末を書き換えられるので落とす
  EFFECTIVE_DEFAULT_MODE="${EFFECTIVE_DEFAULT_MODE//[[:cntrl:]]/}"
  EFFECTIVE_DEFAULT_MODE="${EFFECTIVE_DEFAULT_MODE:0:64}"
  if [[ "$EFFECTIVE_DEFAULT_MODE" != "bypassPermissions" ]]; then
    BYPASS_INJECTION_OK=0
    log "warn" "permission bypass not confirmed in $CWD/.claude/settings.local.json (defaultMode='$EFFECTIVE_DEFAULT_MODE')"
  fi

  ensure_claude_exclusions || true
fi
```

**警告文にフラグのリテラル `--dangerously-skip-permissions` を含めないこと。** テストが
composed command のフラグを数えるとき、stdout と stderr を混ぜた入力に対して数えると警告文に
マッチしてしまい、変更 2 が未実装でも通る空虚なテストになる。文言からリテラルを外しておけば
テスト側の規律に頼らずに済む。

また、この警告は「検出」だけを言う。実際にフラグを足したかどうかは MODE と `SKIP_PERMISSIONS`
に依存し、claude × 注入不能の 10 通りのうち足すのは 5 通りだけなので、ここで「足した」と
書くと半分は嘘になる。実際に足したことは変更 2 側で別に記録する。

読み直しが埋めるのは Step 2a 内の失敗検出だけである。読み直し以降
（`cmux new-workspace` → シェル起動 → claude が settings を読むまで）の秒単位の窓はカバーしない。
plan モードでは Step 2b (`:593-611`) が読み直しの**後**に同じファイルを read-modify-write するが、
plan はリテラルでフラグを持つため実害はない。

**順序依存の注記（実装時に崩さないこと）**: agmsg の `delivery.sh set` は**同じ**
`.claude/settings.local.json` を `cp` → 加工 → `mv` の read-modify-write で書く。現状は
`prewarm-panes.sh:411/417` の呼び出しが Step 2 (`:397-465`) にあり、全 launch (`:471` 以降) より
厳密に前なので安全だが、この順序を崩すと `defaultMode` が巻き戻され、読み直しは Step 2a の
時点で終わっているため検出できない。

### 変更 2: 専用フォールバックフラグを足す (`launch-workspace.sh`)

`superpowers` 分岐 (`:802`) は権限フラグを含まない `CLAUDE_MODEL_FLAGS` を見ているため、
変更 1 だけではフォールバックが届かない。

`superpowers` を `CLAUDE_EXTRA_FLAGS` に丸ごと切り替える案は採らない。それをすると
`--mode superpowers --skip-permissions` の意味が変わり、既存テスト P6
(`test-launch-workspace-permissions.sh:126-135`) と RM10c (`test-role-models.sh:113`) が
「`SKIP_PERMISSIONS` の既定が 0」しか証明しないテストへ退化する。代わりに専用変数を足し、
「superpowers は呼び出し元の `--skip-permissions` を無視する」という既存契約を文字どおり保つ。

`SKIP_PERMISSIONS` に 2 つ目の由来を持たせて splice を `:802` の 1 箇所に減らす案もあるが、
「呼び出し元が要求した」と「注入が確認できなかった」が同じ変数に混ざり、`:802` が
`SKIP_PERMISSIONS` を読まないという契約も読み取れなくなるため採らない。

`CLAUDE_EXTRA_FLAGS` を組み立てた直後 (`:747` の後) に置く:

```bash
# Step 2a の読み直しで bypass を確認できなかったときだけ付ける緊急フラグ。
# plan は :804 でリテラルのフラグを持ち、それ以外の MODE は SKIP_PERMISSIONS 経由で
# CLAUDE_EXTRA_FLAGS 側に入るので、どちらとも二重にならないよう分岐で除外する。
# superpowers は設計上 SKIP_PERMISSIONS を読まない (:802 は CLAUDE_MODEL_FLAGS のみ) ため、
# その分岐だけは SKIP_PERMISSIONS の値に関わらずフォールバックを付ける。
PERM_FALLBACK_FLAG=""
if [[ "$RUNNER_ENGINE" == "claude" && $BYPASS_INJECTION_OK -eq 0 ]]; then
  case "$MODE" in
    plan) ;;
    superpowers) PERM_FALLBACK_FLAG=" --dangerously-skip-permissions" ;;
    *) if [[ $SKIP_PERMISSIONS -eq 0 ]]; then PERM_FALLBACK_FLAG=" --dangerously-skip-permissions"; fi ;;
  esac
fi
[[ -n "$PERM_FALLBACK_FLAG" ]] \
  && log "permissions" "added the CLI permission flag for mode=$MODE because the settings injection was not confirmed" \
  || true
```

`|| true` は `set -e` 対策（`[[ ]] && log` は条件が偽のとき非ゼロを返す）。

claude engine の 3 分岐に `$PERM_FALLBACK_FLAG` を挿す。`plan` (`:804`) は変更しない。

| 行 | MODE | 変更後 |
|----|------|-------|
| `:784-788` | `execute` | `'$PROMPT_TEXT'` の直前に `$PERM_FALLBACK_FLAG`。**`CLAUDE_EXTRA_FLAGS` 有無の両分岐とも**（`:787` の else 側は `CLAUDE_EXTRA_FLAGS` を持たないので見落としやすい） |
| `:792-796` | `standby` / `review` | 同上（prompt 有無の両分岐とも） |
| `:802` | `superpowers` | `${CLAUDE_MODEL_FLAGS:+ $CLAUDE_MODEL_FLAGS}$PERM_FALLBACK_FLAG` |

`:787` は現時点では到達不能（claude engine では `:427-446` の role 解決で `EFFORT` に必ず
既定値が入り `CLAUDE_MODEL_FLAGS` が空にならない）。テストでも検出できないので、
編集し忘れないよう指示として明記しておく。

**独立した注記（変更 2 の安全性の根拠ではない）**: `launch-workspace.sh:619-622` は
`--unattended` を execute/standby 以外で `UNATTENDED=0` に落とす。これは loop の無人昇格の
適用範囲を決めている箇所であり、消すと `--mode superpowers --unattended` が
`SKIP_PERMISSIONS=1` になる。ただし `:802` は `SKIP_PERMISSIONS` を読まず
`PERM_FALLBACK_FLAG` の `superpowers)` 分岐も読まないので、変更 2 の二重付与安全性には影響しない。

`--mode superpowers` と `--skip-permissions` を同時に渡す呼び出し元は現在ゼロである
（`prewarm-panes.sh:498, 567, 638` / `SKILL.md:1116` / `SKILL.md:1354` / `guide-ja.md:574`
はいずれも superpowers ではない）。

### 変更 3: 回帰テスト

テストは **2 ファイルに分ける**。フォールバックの挙動は composed command の話なので
`launch-workspace.sh` 直叩きが素直であり、prewarm 側で確かめたいのは「設計 pane にどの
フラグが渡るか」という argv の話だからである。

`prewarm-panes.sh` から **実物の** `launch-workspace.sh` を呼ぶ構成は採らない。既存の prewarm 系
5 本（`test-prewarm-layout.sh` / `-all-codex.sh` / `-unattended.sh` / `test-in-session.sh` /
`test-override.sh`）はすべて `launch-workspace.sh` をスタブへ差し替えており、実物を呼ぶ前例は無い。
実物を呼ぶには最低でも次が必要で、コストが便益に見合わない:

1. `cmux` は PATH ではなく `CMUX_BIN` で渡す（`launch-workspace.sh:91`、`:384` で `-x` 必須）
2. `new-workspace` / `rename-workspace` / `list-pane-surfaces` / `new-split` / `rename-tab` /
   `read-screen` / `send` を備えたスタブが要る
3. `read-screen` はプロンプト行（`[$%#❯>]\s*$`）を返す必要がある。返らないと
   `terminal-wait.sh:130` の要求を満たせず `wait_for_shell` が 1 ペインあたり最大 30 秒回る
4. `HOME` の差し替えが必須。`launch-workspace.sh:199` が
   `AGMSG_SEND="$HOME/.agents/skills/agmsg/scripts/send.sh"` をハードコードし `:373` で die する
   （`AGMSG_DIR` は `prewarm-panes.sh:61` にしか効かない）
5. 同じく `HOME` 隔離をしないと `terminal-wait.sh:57-89` の `save_sample_ms` が開発者の実
   `~/.claude/cmux-team-dispatch-task/config.json` を書き換える

#### 3-1. `test/test-launch-workspace-permissions.sh` に P12〜P27 を追加

既存ハーネス（`cmux` スタブ + `RUNNERS_CONFIG_PATH` + `new_repo`）をそのまま使う。ただし
**2 つのヘルパーを新設する**。

**計数ヘルパー（必須）**: composed command は runner script の単一行に載るため `grep -c` では
二重付与を検出できない（`grep -c` は行数を数える）。既存ハーネスのアサーションはすべて
部分文字列一致で、計数手段が存在しない。`set -euo pipefail` 下で 0 件を数えると
スクリプトごと落ちるため `|| true` が要る。macOS の `wc -l` は先頭空白を出すので `tr -d ' '`。

```bash
count_flag() {
  { grep -o -- '--dangerously-skip-permissions' "$1" || true; } | wc -l | tr -d ' '
}
```

**stderr 捕捉ヘルパー（必須）**: 既存の `run_launch` (`:56-59`) はリダイレクトを持たず、
stderr を assert している既存ケースは 1 つも無い。素朴に `2>&1` でマージすると stdout の
先頭に `[runner] ...` が混ざって `jq -r '.runner_file'` が壊れる。別ファイルへ落とす。

```bash
run_launch_err() {   # $1 = stderr の保存先, 以降 launch の引数
  local err="$1"; shift
  CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" \
    bash "$LAUNCH" "$@" 2> "$err"
}
```

**フラグの計数対象は `$runner_file` のみ。stdout / stderr を混ぜたものに対して数えてはならない。**

| id | MODE / 条件 | 期待 |
|----|------------|------|
| P12 | `standby`・注入不能 A | `count_flag == 1` |
| P13 | `superpowers`・注入不能 A | `count_flag == 1`（変更 2 の担保） |
| P14 | `superpowers`・注入不能 A・`--skip-permissions` 明示 | `count_flag == 1`（二重付与なし） |
| P15 | `superpowers`・正常系・`--skip-permissions` 明示 | `count_flag == 0`（P6 / RM10c の契約を維持） |
| P16 | `standby`・注入不能 A・`--skip-permissions` 明示 | `count_flag == 1` |
| P17 | `plan`・注入不能 A | `count_flag == 1`（`:804` のリテラルと二重にならない） |
| P18 | `review`・注入不能 A | `count_flag == 1` |
| P19 | `review`・注入不能 A・`--skip-permissions` 明示 | `count_flag == 1`（prewarm reviewer の実構成） |
| P20 | `execute`・注入不能 A・`--skip-permissions` 無し | `count_flag == 1` |
| P21 | codex engine・`.claude` の状態に関わらず | `count_flag == 0` かつ新警告が出ない |
| P22 | 正常系（`standby` / `superpowers`） | `count_flag == 0` かつ stderr に `permission bypass not confirmed` が **出ない** |
| P23 | `standby`・注入不能 **B**（既存の不正 JSON） | `count_flag == 1`、stderr に新警告、`settings.local.json` が**不正 JSON のまま残る** |
| P24 | `standby`・worktree 再利用（2 回目の launch） | `count_flag == 0`、新警告が出ない、`defaultMode is already bypassPermissions` が stderr に**出る** |
| P25 | `standby`・`--unattended`・`--skip-permissions` 無し・注入不能 A | `count_flag == 1` |
| P26 | `standby`・注入不能 **C**（`settings.local.json` がディレクトリ） | `count_flag == 1`（`merge_claude_settings` が 0 を返す唯一のケース） |
| P27 | 非 git `--cwd`・注入不能 A | launch が rc=0 で成功し `count_flag == 1`（P11 の拡張） |

各ケースの意図:

- **P21 は判別能力を持たない**（`BYPASS_INJECTION_OK` が 0 になるのは claude 限定ブロックの
  内側だけなので、engine ガードを削った実装でも通る）。読み直しを claude ブロックの外へ動かす
  将来変更に対する保険として残す。この意図をテスト内コメントに書くこと。
- **P22 は偽陽性フォールバックの検出に load-bearing**。`standby` / `review` / `execute` は
  元からフラグを持つ経路があるため、読み直しが常に失敗する実装バグ（パス誤りなど）が composed
  command に現れず不可視になりうる。
- **P24 は読み直し実装そのものを検証できる唯一のケース**。A / B / C のうち A と B は
  `merge_claude_settings` が 1 を返すので、「読み直しを実装せず戻り値で分岐した」誤実装でも
  P12〜P23 は全部通る。`:575` の短絡経路（`merge_claude_settings` を**呼ばない**）だけがそれを弾く。
  実運用の主経路でもある（prewarm は全ペインに同一 `--cwd` を渡すので 2 枚目以降は必ずここを通る）。
- **P25 は変更 2 のブロック位置を担保する**。`SKIP_PERMISSIONS` が 1 になる経路は `:254`
  （引数）と `:742`（`UNATTENDED`）で行が離れている。ブロックを `:741` より前に置くと P16 は
  1 個のまま通るが、`--unattended` では `*)` が足した後に `:746` がもう 1 個足して 2 個になる。
- **P26 はケース C の回帰**。戻り値ベースの実装を最も直接的に弾く。

警告文字列 `permission bypass not confirmed` をテスト定数に固定し、肯定側（P23）と否定側
（P21 / P22 / P24）の両方で使う（`CLAUDE.md` 保守項目 24 の `HOOK_WARN` と同じ運用）。

**注入不能状態の作り方**:

- A: `printf '' > "$repo/.claude"`（`.claude` を通常ファイルにする）
- B: `mkdir -p "$repo/.claude"; printf '{ not json,,,\n' > "$repo/.claude/settings.local.json"`
- C: `mkdir -p "$repo/.claude/settings.local.json"`

いずれも `chmod` と違って root 実行でも成立する。launch は rc=0 で続行し runner script も
生成される。

副作用を把握しておくこと:

- A では Step 2b の plan hook 注入 (`:593-611`) も同時に失敗し、MODE=plan では
  `merge_claude_settings:122` の `failed to create ...` が 2 回出る。**新警告
  `permission bypass not confirmed` は plan を含め常に 1 回**である。`[warn]` 行の総数に
  依存した assert を書かないこと。
- 実運用では agmsg の `delivery.sh set` (`prewarm-panes.sh:411/417`) も同じ `.claude/` に書けず
  `CLAUDE_DELIVERY=cmux-send` へ落ちる。A の正体は「bypass 注入だけの失敗」ではなく
  「`.claude/` へ書く全処理の失敗」である。
- `ensure_claude_exclusions` / prompt file / runner script の書き込みは壊れない。

#### 3-2. `test/test-prewarm-design-permissions.sh` を新設（id prefix は `DB`、2 ケースのみ）

`test-prewarm-layout.sh` と同じ構成（`prewarm-panes.sh` をコピーし、隣に argv を記録する
`launch-workspace.sh` スタブ、agmsg スタブ、`RUNNERS_CONFIG_PATH`）。

| id | 期待 |
|----|------|
| DB1 | 同一 dispatch で、claude 設計の argv に `--skip-permissions` が **無く**、claude executor の argv には **ある**（非対称そのものを 1 ケースで固定する） |
| DB2 | codex 設計の argv に `--skip-permissions` が **無い** |

**既存テストとの重複を明記しておく**（新規価値は DB1 の executor 側と DB2 だけである）:

| 既にカバーされている主張 | 既存テスト |
|------------------------|-----------|
| `--unattended` で設計 argv に `--skip-permissions` が付く | `test-prewarm-unattended.sh:75-78` (U1) |
| 通常時の設計 argv に `--skip-permissions` が無い | `test-prewarm-unattended.sh:80-83` (U2) |
| codex 設計に `--runner <codex>` と `--role plan` が渡る | `test-prewarm-all-codex.sh:68` (AC2) |
| claude executor の `--skip-permissions` 無条件付与 | **どのテストにも無い** |

新ファイルを作る（既存ファイルへ足さない）のは、`--skip-permissions` の非対称という単一の
関心事にファイル名を与えたほうが `CLAUDE.md` 保守項目 25 から索引しやすいためである。
id は 2 つに絞って運用コストを抑える。

`PD` prefix は使わない。`test/test-parallel-directive.sh` が `PD1`〜`PD7` を使用中で、
`CLAUDE.md` 保守項目 27 にも記載されているため、同一ドキュメント内で `PD` が 2 つのテストを
指すことになる。`DB` は未使用であることを確認済み。

**テスト作成上の必須事項**:

- `prewarm-panes.sh` を呼ぶケースは **worktree ディレクトリを事前に `mkdir -p` する**。
  未作成のまま渡すと `prewarm-panes.sh:387-395` の `git worktree add`（`-C` 無し）が
  テストを起動したリポジトリに対して走り、ブランチと worktree 登録を残す。二重防御として
  使い捨て repo を cwd にして実行する（`(cd "$TMP/repo" && bash .../prewarm-panes.sh ...)`）。
- **argv ログはペイン単位の行に限定して grep する。** ログ全体を grep すると claude executor 行の
  `--skip-permissions` を拾って偽陽性になる。`test-prewarm-layout.sh:78-80` の `pane_line()`
  （`--agmsg-from <name> ` の**末尾スペース**で `<slug>` と `<slug>-claude` の前方一致を防ぐ）
  を使うか、`--role plan` / `--role exec` で特定する。
- **否定アサーションは 3 段構えで書く**: 対象行を取得 → 空なら `bad` → その行にフラグが無いことを
  assert。`test-prewarm-unattended.sh:60-65` の `assert_no_line_with` は 0 行マッチでも `ok` を
  返すのでモデルにしないこと（同ファイル `:53-58` の `assert_all_lines_with` は
  `total -gt 0` でガードしており非対称）。`test-prewarm-layout.sh:84-92` の `expect_split`
  （`[[ -z "$line" ]] && bad` を持つ）が良いモデル。
- 3-2 のスタブは runner script も `.claude/` も生成しない。**runner script のパスを組み立てて
  grep してはならない**（ファイルが存在しないので否定アサーションが必ず通る）。

### 変更 4: ドキュメント同期

挙動が変わるので `CLAUDE.md` のハードルールに従い 4 ファイルすべてを同じ commit で更新する。
加えてスクリプト内の 2 箇所（保守手順 1 が `--help` 出力と SKILL.md の整合を要求している）も直す。

`scripts/check-doc-lang.mjs:94-104` は `*-ja.md` について `empty-translation`（日本語が 1 文字も
無い）しか見ないため、訳が原文より短くても `pnpm check` は green のまま通る。整合を守る唯一の
手段が spec 側での文面確定なので、**6 箇所すべてを逐語で確定する**。

#### 4-1. SKILL.md（英語のみ。日本語文字を 1 文字も入れない）

engine × MODE 表の本体は `:378-386`。差し替え対象は **`:381`（`claude | superpowers` 行）** で、
次に置き換える:

```
| claude | superpowers | `<command> [--model <plan_model>] [--effort <plan_effort>] [--dangerously-skip-permissions: only when the settings injection below is not confirmed; never from --skip-permissions] 'Read and follow the task in .cmux-team-dispatch-task-prompt.md'` |
```

同じ表の `:382`（`claude | execute`）の角括弧は「`--skip-permissions` を渡したときに付く」の意で、
superpowers 行とは条件が逆になる。角括弧の中に条件を書き切ることで取り違えを防ぐ。
`:382` は変更しない。

`claude | standby` / `claude | review` の行は **足さない**。表は「起動プロンプトを持つ 3 モード」
の対応表として運用されており、行を足すと guide-ja.md の対応表にも同じ拡張が要る。
standby / review の扱いは直下の段落で文章として書く。

`:409-414` の段落を次で置き換える:

```
Regardless of MODE, when the resolved runner engine is `claude`, the script
injects `permissions.defaultMode: "bypassPermissions"` into the worktree's
`.claude/settings.local.json` (merged with `jq`, atomically via `mktemp` + `mv`,
and skipped when the key already holds that value). This is what keeps normal
(non-loop) dispatches free of permission prompts on the launch paths that carry
no permission flag of their own: `superpowers`, and the `standby` / `review`
panes started without `--skip-permissions` — the prewarm design pane being the
main one. The loop path keeps its own guarantee through `--unattended`.

The injection is best effort, and its return code cannot be trusted: when
`settings.local.json` happens to be a directory, the atomic `mv` moves the temp
file inside it and still reports success. The launcher therefore reads the file
back. When `permissions.defaultMode` is not `bypassPermissions` at that point —
the merge could not be written, a pre-existing `settings.local.json` holds
invalid JSON that `jq` refuses, or the directory case above — the launcher logs
a warning starting with `permission bypass not confirmed` and adds
`--dangerously-skip-permissions` to that launch. It never doubles the flag:
`plan` already carries it literally, `superpowers` never takes it from
`--skip-permissions` at all, and the remaining modes take it from
`--skip-permissions` when the caller passed that flag. Without the fallback the
design pane would be the only claude pane with no second line of defence, and it
would block on its first permission prompt with nobody attached.
```

置換後、`:416` の `AskUserQuestion stays interactive under that mode:` の先行詞が
フォールバック段落へ移る。両者は等価モードなので実害は無いが、`:416` の書き出しを
`AskUserQuestion stays interactive under `bypassPermissions`:` に変えて受け直す。

#### 4-2. guide-ja.md

対応段落は **`:1619-1623`**（1619 行「MODE によらず、解決された runner engine が `claude` の
ときは worktree の」から始まる）。次で置き換える:

```
MODE によらず、解決された runner engine が `claude` のときは worktree の
`.claude/settings.local.json` に `permissions.defaultMode: "bypassPermissions"` を
注入する（`jq` でマージし、`mktemp` + `mv` でアトミックに置換。既に同値ならスキップ）。
これが、権限フラグを自前で持たない起動経路 — `superpowers` と、`--skip-permissions`
無しで起動する `standby` / `review` ペイン（主役は prewarm の設計ペイン）— から
通常（非 loop）ディスパッチの permission prompt を消している仕組み。loop 経路は
`--unattended` で別途保証される。

注入はベストエフォートで、しかも戻り値は信用できない。`settings.local.json` が
たまたまディレクトリだったとき、アトミックな `mv` は temp をその中へ移動したうえで
成功を報告するからである。そのため launcher はファイルを読み直す。その時点で
`permissions.defaultMode` が `bypassPermissions` でなければ — マージを書き込めなかった、
既存の `settings.local.json` が不正な JSON で `jq` に拒否された、あるいは上記の
ディレクトリのケース — `permission bypass not confirmed` で始まる警告を出し、その launch に
`--dangerously-skip-permissions` を足す。二重付与は起きない。`plan` は既にリテラルで
持っており、`superpowers` はそもそも `--skip-permissions` を受け取らず、残りの MODE は
呼び出し元が `--skip-permissions` を渡したときにそこから受け取るからである。
フォールバックが無いと、設計ペインだけが第二の防壁を持たない claude ペインとなり、
誰も見ていない状態で最初の permission prompt に当たって停止する。
```

表 (`:1601-1608`) の `claude | superpowers` 行にも SKILL.md `:381` と同じ角括弧注記を入れる。

あわせて **既存のドリフトを同 commit で直す**（4 ファイル整合ルール上、放置できない）:

- `codex | review` 行が `SKILL.md:386` にあって guide-ja.md の表に無い → 追加
- `guide-ja.md:1607` の `codex | superpowers` 行に
  `--dangerously-bypass-approvals-and-sandbox` が抜けている（`SKILL.md:384` にはある）→ 追加

#### 4-3. README.md

`:144-165`「permission prompt の抑止」節の末尾に次の段落を足す:

```
注入はベストエフォートで、戻り値も信用できない（`settings.local.json` がディレクトリだと
`mv` が temp をその中へ移して成功を報告する）。そのため起動スクリプトは書き込み後に
ファイルを読み直し、`permissions.defaultMode` が `bypassPermissions` になっていなければ
`permission bypass not confirmed` の警告を出したうえで、その起動にだけ
`--dangerously-skip-permissions` を足す。これが無いと、権限フラグを持たない設計ペインだけが
注入失敗時に素の権限で上がり、誰も見ていない状態で permission prompt に当たって止まる。
なおこのフォールバックも上記の確認ダイアログの前提を共有するので、
`skipDangerousModePermissionPrompt` をユーザー設定に置いていない環境では同じダイアログで
止まる点は変わらない。
```

#### 4-4. CLAUDE.md（保守項目 25）

既存 bullet の**書き換え**が要る:

1. 第 1 bullet 末尾「失敗は警告のみで dispatch を止めないこと」
   → 「失敗時は `permission bypass not confirmed` を警告し、書き込み後の読み直しで
   `bypassPermissions` を確認できなければ、`plan`（リテラル付与済み）と `--skip-permissions`
   既付与の経路を除いて `--dangerously-skip-permissions` へフォールバックすること。
   `merge_claude_settings` の戻り値では検出できない失敗（`settings.local.json` が
   ディレクトリのとき `mv` が成功を報告する）があるため、判定はファイル実体の読み直しで行うこと」
2. 最終 bullet の回帰リスト
   → `test-launch-workspace-permissions.sh` を P1〜P27 に更新し、「superpowers にフラグを
   足さない」を「正常系では superpowers にフラグを足さない」に修正。
   `bash test/test-prewarm-design-permissions.sh`（DB1-DB2）を追加

#### 4-5. `launch-workspace.sh` の usage ヘッダ

`--skip-permissions` の説明 (`:41-43`) と、その下の注記ブロック (`:47-50`) の 2 箇所。
注記ブロックを次で置き換える:

```
#   注記: claude engine では MODE を問わず、worktree の
#   .claude/settings.local.json に permissions.defaultMode: "bypassPermissions" を
#   注入する (Step 2a)。注入後に読み直して確認できなかったときは、plan と
#   --skip-permissions 既付与の経路を除いて --dangerously-skip-permissions を
#   自動で足す。--skip-permissions はそれとは別に呼び出し元が明示するフラグ。
#   codex engine は対象外。
```

#### 4-6. `launch-workspace.sh` Step 2a のコメント (`:547-568`)

現行は「注入だけが機構」と読める。読み直しとフォールバックが機構の一部であること、および
戻り値を信用しない理由（ディレクトリのケース）を追記する。既存の裏取り 3 点と
確認ダイアログの注記は残す。

## 非目標

- **codex 経路には手を入れない。** 調査で bypass 済みであることを確認済みで、既存テスト T4 が
  担保している。P21 は claude 側ガードの回帰であって codex の挙動変更ではない。
- **`superpowers` を `CLAUDE_EXTRA_FLAGS` へ切り替えない。** 呼び出し元の `--skip-permissions`
  を superpowers が無視するという既存契約（P6 / RM10c）は維持する。
- **壊れた `settings.local.json` を書き直さない**（理由は「設計」節に記載）。
- **symlink / ディレクトリ種別の事前検査を足さない**（同上）。
- **`skipDangerousModePermissionPrompt` の扱いは変更しない。** ユーザー設定
  `~/.claude/settings.json` に置く必要がある旨は既に文書化されている。
- **報告者の観測が bypass 確認ダイアログ由来だった場合、本変更は症状を解消しない。**
  managed / enterprise scope で `disableBypassPermissionsMode` が効いている環境も同様。
- **stdout JSON にフォールバックの痕跡を出さない。** `permission_fallback` 相当のキーを足せば
  親オーケストレータが縮退起動を報告できるようになるが、stdout JSON の契約は 4 ファイルに
  documented されており拡張コストが便益に見合わない。痕跡は stderr の 2 行
  （検出の `[warn]` と付与の `[permissions]`）と、ディスク上に残る
  `$CWD/.cmux-team-dispatch-task-run-<slug>.sh` の composed command で足りる。
- **バージョン番号を上げない。** bump は `.claude-plugin/plugin.json` /
  `.codex-plugin/plugin.json` / ルート `marketplace.json` をまとめて更新する専用の
  `release(...)` commit に委ねる（`ba5709e` 参照）。push も PR 作成もしない（Wait-and-merge）。

## 影響範囲と後方互換

- **正常系は完全に不変。** 注入が成功する通常のディスパッチでは composed command・settings
  ファイル・ペイン配置・stderr のいずれも変化しない。
- **変化するのは注入が確認できなかった異常系だけ。** そこでは設計ペインだけでなく、
  `--skip-permissions` を渡していない `execute` / `standby` / `review` の直叩きケースでも
  新たにフラグが付く（`:782-796` は `CLAUDE_EXTRA_FLAGS` 系のため）。「設計ペインだけが変わる」
  わけではない。
- **root 実行では挙動が「ハング」から「即死」に変わる。** Claude Code は root/sudo 下で
  `--dangerously-skip-permissions` を拒否するため、起動直後に終了し runner wrapper が
  `write_status "error"` (`:1077`) と親通知 (`:1087`) を出す。無言のハングより検知可能な
  失敗のほうが望ましいので、これは意図した結果として受け入れる。
- シェルは bash 3.2 互換を維持する（新規の配列展開を導入しない。`${var//[[:cntrl:]]/}` と
  `${var:0:64}` は bash 3.2.57 で動作確認済み）。

## 検証

```
cd apps/cmux-team-dispatch-task
rc=0; for t in test/*.sh; do printf '%-46s ' "$t"; if bash "$t" >/dev/null 2>&1; then echo OK; else echo FAILED; rc=1; fi; done; exit $rc
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins
node scripts/check-doc-lang.mjs apps/cmux-team-dispatch-task
pnpm check
```

失敗したスイートは `>/dev/null` を外して項目単位で確認する。全スイート green かつ
`check-doc-lang` が OK であること。`@tanaka-yui/token-meter` の `noNonNullAssertion` 警告 4 件は
既知のノイズ。

変更 2 が触る `:802` の出力を実際に assert している既存アサーションは **P6
(`test-launch-workspace-permissions.sh:131`) と RM10c (`test-role-models.sh:113`) の 2 件だけ**
である。次の 3 つは superpowers 経路を通す（回帰時に走る）が、権限フラグを見ていないので
変更 2 が壊れても落ちない — 検証の頼りにしないこと:

- `test-launch-workspace-layout.sh:65`（assert は `claude-teams` の不在のみ。`:53` は
  削除済みフラグの die を期待するループで `:802` に到達しない）
- `test-launch-workspace-codex.sh` T1〜T15（superpowers ケースは codex engine）
- `test-prewarm-layout.sh` PG1〜PG3（`launch-workspace.sh` をスタブへ差し替える）

テスト実行後に残留物が無いことを確認する（slug 別のフィルタは狭すぎるので使わない）:

```
git worktree list
git branch --list
git worktree prune -n -v
```

実行前と比べて worktree 件数（main + 稼働中 3 worktree = 4 件）とブランチ一覧が増えていないこと。
