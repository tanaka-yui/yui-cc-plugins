# 設計ペインの permission bypass に起動時フォールバックを足す設計

対象: `apps/cmux-team-dispatch-task`

## 背景

「設計 (Phase A) ペインが bypass-permission モードで上がらない」という報告を受けた。
`claude` engine の設計ペインは permission prompt が出ない状態で起動するはずだが、実際には
そうなっていない、という内容である。あわせて `codex` の設計ペインも承認バイパス済みで
上がることが要件として挙がっている。

## 調査結果

### 報告書が挙げた 3 つの仮説はいずれも棄却される

まず「実際に何が起きているか」をコードと実測の両方から確定させた。

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

上記 3 仮説は棄却されるが、**症状そのものは再現する**。`$CWD/.claude/settings.local.json` が
**既に存在し、かつ不正な JSON** のとき、claude 設計ペインは確実に素の権限で起動する。

- `launch-workspace.sh:571-574` — `jq ... 2>/dev/null || echo ""` で `CURRENT_DEFAULT_MODE=""`
- `:578` `merge_claude_settings` → `:128` の `jq "$@" "$filter" "$settings_file"` が失敗し
  `merged=""` → `:133` で warn して `return 1`
- `:575` の `if` も `:578` の `elif` も偽になり、注入されないまま起動する

実測（不正 JSON を置いた worktree に `--mode standby --role plan` で起動）:

```
[warn] failed to merge into .../.claude/settings.local.json; skipping
zsh -ic "claude --model 'opus[1m]' --effort 'xhigh' 'wait idle'"
```

権限フラグも `bypassPermissions` も無い。これが報告された症状と同じ見え方になる。
先の実測（surface 47 / 全 14 セッション）は「すでに正常に注入済みの worktree」の観測であり、
この経路を一度も踏んでいなかった。

なお「既存の `defaultMode` が別値だった」説は棄却でよい。`:575` の等値判定が偽になり `:578` が
`.permissions.defaultMode = "bypassPermissions"` を無条件代入するため、`plan` / `acceptEdits`
などが入った stale worktree は上書きされる。

## 修正すべき欠陥

### 欠陥 1: 設計ペインだけが単一機構に依存している

`merge_claude_settings` は失敗しても警告を出すだけで、`launch-workspace.sh` は起動を続行する
（既存ファイルが不正 JSON / `.claude` を作れない / `mktemp` が失敗する、など）。

このとき各ペインがどうなるかは非対称である:

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
`prewarm-panes.sh` の設計ペイン起動経路を検証するテストは 1 本も存在しない。P9 は `standby` を
扱うが `--skip-permissions` を **付けた** ケースなので、「設計ペインにはフラグが無い」という
本件の核心そのものがテストから不可視になっている。

## 設計

方針は **起動時フォールバック**（fail-closed ではない。失敗時に権限を昇格させる設計であり、
呼称を正確にしておく）。注入を主機構として維持したまま、それが確認できなかったときに限り
CLI フラグへ落とす。正常系の composed command は 1 バイトも変えない。

`die` を採らない理由: 設計ペインが起動しないと Phase A ごと失われ、親は
「ペインが上がらない」という別の障害として観測することになる。permission bypass は
このプラグインの前提（`README.md:164-166` は opt-out 用の config キーを用意していないと明記）
なので、縮退起動より昇格起動のほうがプロジェクト意図に沿う。

(A) 注入が物理的に失敗した場合と (B) ファイルは読めるが別値が入っている場合を **挙動としては
区別しない**。Step 2a は `.permissions.defaultMode` を無条件代入するため、(B) が残るのは
「書けなかった」= (A) の部分集合に実質限られる。区別は挙動ではなく **警告ログに実測値を
載せる**ことで担保する。dispatch worktree の `.claude/settings.local.json` はこのプラグインが
所有するファイルであり、手編集によるロックダウンはサポート対象外とする。

### 変更 1: Step 2a に注入結果の読み直しを足す (`launch-workspace.sh`)

**挿入位置は `:580` の `fi` の直後、`:581-583` の `ensure_claude_exclusions` 用コメントの直前。**
この順序（`ensure_claude_exclusions` より前）は非 git `--cwd`（P11）との組み合わせで
load-bearing なので動かさないこと。

`BYPASS_INJECTION_OK=1` の初期化は `:569` の `if` の直前に置く（codex engine では 1 のまま残り、
フォールバックが発火しない）。

```bash
BYPASS_INJECTION_OK=1
if [[ "$RUNNER_ENGINE" == "claude" ]]; then
  ...既存の注入ブロック (:570-580) は変更なし...

  # 注入結果をファイル実体で読み直す。merge_claude_settings の戻り値ではなく実体を見るのは、
  # mkdir / mktemp / jq の失敗と「既存ファイルが不正 JSON でマージ自体が拒否された」ケースを
  # 一括で捕まえるため。設計ペイン (standby / superpowers の有人経路) は CLI フラグを
  # 持たないので、ここが唯一の防壁になる。
  EFFECTIVE_DEFAULT_MODE=$(jq -r '.permissions.defaultMode // ""' \
    "$CWD/.claude/settings.local.json" 2>/dev/null || echo "")
  if [[ "$EFFECTIVE_DEFAULT_MODE" != "bypassPermissions" ]]; then
    BYPASS_INJECTION_OK=0
    log "warn" "permission bypass not confirmed in $CWD/.claude/settings.local.json (defaultMode='$EFFECTIVE_DEFAULT_MODE'); adding --dangerously-skip-permissions to this launch"
  fi

  ensure_claude_exclusions || true
fi
```

読み直しが埋めるのは Step 2a 内の失敗検出だけである。読み直し以降
（`cmux new-workspace` → シェル起動 → claude が settings を読むまで）の秒単位の窓は
カバーしない。plan モードでは Step 2b (`:593-611`) が読み直しの**後**に同じファイルを
read-modify-write するが、plan はリテラルでフラグを持つため実害はない。

### 変更 2: 専用フォールバックフラグを足す (`launch-workspace.sh`)

`superpowers` 分岐 (`:802`) は権限フラグを含まない `CLAUDE_MODEL_FLAGS` を見ているため、
変更 1 だけではフォールバックが届かない。

`superpowers` を `CLAUDE_EXTRA_FLAGS` に丸ごと切り替える案は採らない。それをすると
`--mode superpowers --skip-permissions` の意味が変わり、既存テスト P6
(`test-launch-workspace-permissions.sh:126-135`) と RM10c (`test-role-models.sh:113`) が
「`SKIP_PERMISSIONS` の既定が 0」しか証明しないテストへ退化する。代わりに専用変数を足し、
「superpowers は呼び出し元の `--skip-permissions` を無視する」という既存契約を文字どおり保つ。

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
```

claude engine の 3 分岐に `$PERM_FALLBACK_FLAG` を挿す。`plan` (`:804`) は変更しない。

| 行 | MODE | 変更後 |
|----|------|-------|
| `:784-788` | `execute` | `CLAUDE_EXTRA_FLAGS` の直後、`'$PROMPT_TEXT'` の直前に `$PERM_FALLBACK_FLAG` |
| `:792-796` | `standby` / `review` | 同上（prompt 有無の両分岐とも） |
| `:802` | `superpowers` | `${CLAUDE_MODEL_FLAGS:+ $CLAUDE_MODEL_FLAGS}$PERM_FALLBACK_FLAG` |

変更 2 が安全に成立している非自明な根拠として、`launch-workspace.sh:619-622`
（`--unattended` は execute/standby 以外で `UNATTENDED=0` に落とされる）が load-bearing である。
この reset を将来消すと loop の無人昇格が superpowers へ流れ込む。また
`--mode superpowers` と `--skip-permissions` を同時に渡す呼び出し元は現在ゼロである
（`prewarm-panes.sh:498, 567, 638` / `SKILL.md:1116` / `guide-ja.md:574` はいずれも superpowers ではない）。

### 変更 3: 回帰テスト

テストは **2 ファイルに分ける**。理由は、フォールバックの挙動は composed command の話なので
`launch-workspace.sh` 直叩きが素直であり、一方 prewarm 側で確かめたいのは「設計 pane にどの
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

#### 3-1. `test/test-launch-workspace-permissions.sh` に P12〜P21 を追加

既存ハーネス（`cmux` スタブ + `RUNNERS_CONFIG_PATH` + `new_repo`）をそのまま使う。

| id | MODE / 条件 | 期待 |
|----|------------|------|
| P12 | `standby`・注入不能 | runner file が `--dangerously-skip-permissions` を **1 個** 持つ |
| P13 | `superpowers`・注入不能 | 同上（変更 2 の担保） |
| P14 | `superpowers`・注入不能・`--skip-permissions` 明示 | フラグはちょうど **1 個**（二重付与なし） |
| P15 | `superpowers`・注入成功・`--skip-permissions` 明示 | フラグ **0 個**（P6 / RM10c の契約を維持） |
| P16 | `standby`・注入不能・`--skip-permissions` 明示 | フラグはちょうど **1 個** |
| P17 | `plan`・注入不能 | フラグはちょうど **1 個**（`:804` のリテラルと二重にならない） |
| P18 | `review`・注入不能 | フラグが付く |
| P19 | `execute`・注入不能・`--skip-permissions` 無し | フラグが付く |
| P20 | codex engine・注入不能状態 | `--dangerously-skip-permissions` **0 個**（engine ガードの回帰） |
| P21 | 正常系（`standby` / `superpowers`） | stderr に `permission bypass not confirmed` が **出ない**、かつフラグ 0 個 |

P21 は偽陽性フォールバックの検出に load-bearing である。`standby` / `review` / `execute` は
元からフラグを持つ経路があるため、読み直しが常に失敗する実装バグ（パス誤りなど）が composed
command に現れず不可視になりうる。警告文字列 `permission bypass not confirmed` を
テスト定数に固定し、P12〜P20 の肯定側と P21 の否定側の両方で使う（`CLAUDE.md` 保守項目 24 の
`HOOK_WARN` と同じ運用）。

**注入不能状態の作り方**: `$CWD/.claude` を **ディレクトリではなく通常ファイル** にする。
`merge_claude_settings:121` の `mkdir -p` が失敗し、読み直しも空になるので決定的に再現でき、
`chmod` と違って root 実行でも成立する。launch は rc=0 で続行し runner script も生成される。

副作用を把握しておくこと:

- Step 2b の plan hook 注入 (`:593-611`) も同時に失敗し、MODE=plan では同一 warn が 2 回出る。
  **warn の件数や `[warn]` 行の総数に依存した assert を書かないこと。**
- 実運用では agmsg の `delivery.sh set` (`prewarm-panes.sh:411/417`) も同じ `.claude/` に書けず
  `CLAUDE_DELIVERY=cmux-send` へ落ちる。シミュレーションの正体は「bypass 注入だけの失敗」では
  なく「`.claude/` へ書く全処理の失敗」である。
- `ensure_claude_exclusions` / prompt file / runner script の書き込みは壊れない。

#### 3-2. `test/test-prewarm-design-permissions.sh` を新設（id prefix は `DB`）

`test-prewarm-layout.sh` と同じ構成（`prewarm-panes.sh` をコピーし、隣に argv を記録する
`launch-workspace.sh` スタブ、agmsg スタブ、`RUNNERS_CONFIG_PATH`）で、設計ペインへ渡る
フラグを argv レベルで固定する。

| id | 期待 |
|----|------|
| DB1 | claude 設計の起動 argv に `--mode standby` と `--role plan` があり `--skip-permissions` が **無い** |
| DB2 | claude executor の起動 argv には `--skip-permissions` が **ある**（非対称の明示） |
| DB3 | codex 設計の起動 argv に `--skip-permissions` が無く、`--runner <codex runner>` が渡る |
| DB4 | `--unattended` 付きでは claude 設計の argv にも `--skip-permissions` が付く（既存挙動の固定） |

`PD` prefix は使わない。`test/test-parallel-directive.sh` が `PD1`〜`PD7` を使用中で、
`CLAUDE.md` 保守項目 27 にも記載されているため、同一ドキュメント内で `PD` が 2 つのテストを
指すことになる。`DB` は未使用であることを確認済み。

**テスト作成上の必須事項**:

- `prewarm-panes.sh` を呼ぶケースは **worktree ディレクトリを事前に `mkdir -p` する**。
  未作成のまま渡すと `prewarm-panes.sh:387-395` の `git worktree add`（`-C` 無し）が
  テストを起動したリポジトリに対して走り、ブランチと worktree 登録を残す。二重防御として
  使い捨て repo を cwd にして実行する（`(cd "$TMP/repo" && bash .../prewarm-panes.sh ...)`）。
- 否定アサーション（DB1 / DB3 / P21）は、**grep 対象が実在することを先に確認する**。
  ファイルや argv 行が無いから通る否定アサーションは欠陥であってテストではない。
- runner script のパスは `prewarm-panes.sh` の出力 JSON (`:676-711`) に含まれないため、
  `launch-workspace.sh:380` の命名規約 `$CWD/.cmux-team-dispatch-task-run-<slug>.sh` を自前で
  組み立てる。**同一 worktree の `-<slug>-claude.sh` はフラグを含む**ので、
  grep 対象を設計ペインのファイルに限定しないと偽陽性になる。

### 変更 4: ドキュメント同期

挙動が変わるので `CLAUDE.md` のハードルールに従い 4 ファイルすべてを同じ commit で更新する。
加えてスクリプト内の 2 箇所（保守手順 1 が `--help` 出力と SKILL.md の整合を要求している）も直す。

#### SKILL.md（英語のみ。日本語文字を 1 文字も入れない）

engine × MODE 表 (`:376-386`) の `claude | superpowers` 行を次に差し替える:

```
| claude | superpowers | `<command> [--model <plan_model>] [--effort <plan_effort>] [--dangerously-skip-permissions] 'Read and follow the task in .cmux-team-dispatch-task-prompt.md'` |
```

`claude | standby` / `claude | review` の行は **足さない**。表は「起動プロンプトを持つ 3 モード」
の対応表として運用されており、行を足すと guide-ja.md と README.md にも同じ拡張が要る。
standby / review の扱いは直下の段落で文章として書く。

`:409-414` の段落を次で置き換える（`without adding --dangerously-skip-permissions to every
launch path` は部分的に偽になるため、段落追加ではなく置き換え）:

```
Regardless of MODE, when the resolved runner engine is `claude`, the script
injects `permissions.defaultMode: "bypassPermissions"` into the worktree's
`.claude/settings.local.json` (merged with `jq`, atomically via `mktemp` + `mv`,
and skipped when the key already holds that value). This is what keeps the
launch paths that carry no permission flag of their own free of permission
prompts: `superpowers`, and the `standby` / `review` panes started without
`--skip-permissions` — the prewarm design pane being the main one.

The injection is best effort, so the launcher reads the file back. When
`permissions.defaultMode` is not `bypassPermissions` at that point (the merge
could not be written, or a pre-existing `settings.local.json` holds invalid JSON
that `jq` refuses), the launcher logs a warning starting with `permission bypass
not confirmed` and adds `--dangerously-skip-permissions` to that launch. `plan`
already carries the flag literally, and the other modes take it from
`--skip-permissions`, so the fallback never doubles it. Without it the design
pane would be the only claude pane with no second line of defence, and it would
block on its first permission prompt with nobody attached.
```

#### guide-ja.md

`:1620-1623` の対応段落を SKILL.md と同内容の日本語へ置き換え、表 (`:1601-1608`) の
`claude | superpowers` 行にも `[--dangerously-skip-permissions]` を入れる。

あわせて **既存のドリフトを同 commit で直す**（4 ファイル整合ルール上、放置できない）:

- `codex | review` 行が SKILL.md にあって guide-ja.md に無い → 追加
- guide-ja.md の `codex | superpowers` 行に `--dangerously-bypass-approvals-and-sandbox` が
  抜けている → 追加

#### README.md

`:144-168`「permission prompt の抑止」節に、読み直しとフォールバックの説明を 1 段落追加する。
確認ダイアログの前提（`skipDangerousModePermissionPrompt` をユーザー設定に置くこと）は
既存記述があるので、フォールバックもその前提に依存する旨を 1 文で結びつける。

#### CLAUDE.md（保守項目 25）

既存 bullet の**書き換え**が要る:

1. 第 1 bullet 末尾「失敗は警告のみで dispatch を止めないこと」
   → 「失敗時は `permission bypass not confirmed` を警告し、`plan` と `--skip-permissions`
   既付与の経路を除いて `--dangerously-skip-permissions` へフォールバックすること」
2. 最終 bullet の回帰リスト
   → `test-launch-workspace-permissions.sh` を P1〜P21 に更新し、「superpowers にフラグを
   足さない」を「正常系では superpowers にフラグを足さない」に修正。
   `test-prewarm-design-permissions.sh`（DB1-DB4）を追加。

#### `launch-workspace.sh` 内の 2 箇所

- `:41-50` の usage ヘッダ（`--skip-permissions` の説明と注記）にフォールバックを追記
- `:547-568` の Step 2a コメント（現行は「注入だけが機構」と読める）を更新

## 非目標

- **codex 経路には手を入れない。** 調査で bypass 済みであることを確認済みで、既存テスト T4 が
  担保している。P20 は claude 側ガードの回帰であって codex の挙動変更ではない。
- **`superpowers` を `CLAUDE_EXTRA_FLAGS` へ切り替えない。** 呼び出し元の `--skip-permissions`
  を superpowers が無視するという既存契約（P6 / RM10c）は維持する。
- **`skipDangerousModePermissionPrompt` の扱いは変更しない。** ユーザー設定
  `~/.claude/settings.json` に置く必要がある旨は既に文書化されている。
- **報告者の観測が bypass 確認ダイアログ由来だった場合、本変更は症状を解消しない。**
  managed / enterprise scope で `disableBypassPermissionsMode` が効いている環境も同様。
- **stdout JSON にフォールバックの痕跡を出さない。** `permission_fallback` 相当のキーを足せば
  親オーケストレータが縮退起動を報告できるようになるが、stdout JSON の契約は 4 ファイルに
  documented されており拡張コストが便益に見合わない。痕跡は stderr の `[warn]` 行と
  composed command の 2 つで足りる（テストは composed command で assert する）。
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
- シェルは bash 3.2 互換を維持する（新規の配列展開を導入しない）。

## 検証

```
cd apps/cmux-team-dispatch-task
rc=0; for t in test/*.sh; do printf '%-46s ' "$t"; if bash "$t" >/dev/null 2>&1; then echo OK; else echo FAILED; rc=1; fi; done; exit $rc
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins && pnpm check
```

失敗したスイートは `>/dev/null` を外して項目単位で確認する。全スイート green かつ
`check-doc-lang` が OK であること。`@tanaka-yui/token-meter` の `noNonNullAssertion` 警告 4 件は
既知のノイズ。

変更 2 が直接触る `:802` を守っている既存アサーションは P6 だけではない。次も検証リストに含める:

- `test/test-role-models.sh:113` の `RM10c superpowers must not add --dangerously-skip-permissions`
- `test/test-launch-workspace-layout.sh:53,65`（superpowers モードを走らせる）
- `test/test-launch-workspace-codex.sh` の T1〜T15、`test/test-prewarm-layout.sh` の PG1〜PG3

テスト実行後に残留物が無いことを確認する（slug 別のフィルタは狭すぎるので使わない）:

```
git worktree list
git branch --list
git worktree prune -n -v
```

実行前と比べて worktree 4 件（main + 稼働中 3 worktree）とブランチ一覧が増えていないこと。
