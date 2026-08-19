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
状態はいずれも起動が続行され、claude 設計ペインは素の権限で上がる。再現形は 3 つある。

| ケース | 作り方 | 判定行 | stderr | 注入後の `settings.local.json` | 戻り値 |
|--------|--------|--------|--------|------------------------------|-------|
| A | `$CWD/.claude` が通常ファイル | `:121` | `failed to create .../.claude; skipping settings injection` | 存在しない | 1 |
| B | 既存 `settings.local.json` が不正 JSON | `:128`（出力は `:133`） | `failed to merge into .../settings.local.json; skipping` | 不正 JSON のまま存在 | 1 |
| C | `settings.local.json` が**ディレクトリ** | `:142` | **警告なし。`[permissions] injected ...` が 1 行出る** | ディレクトリのまま（中に temp が移動される） | **0（成功を報告する）** |

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

ケース C は手動操作限定ではない。git はディレクトリ自体を追跡しないが、
`.claude/settings.local.json/<file>` を tracked にすれば `git worktree add` がディレクトリを
materialize する。worktree 内の子セッションも `mkdir` 1 回で作れる（子セッションは
`bypassPermissions` で全ツール権限を持つ）。ただし昇格の天井は `bypassPermissions` = 正常系で
意図している状態そのものであり、Phase B 孫は元々 `--skip-permissions` 必須なので、
この到達経路から得られる実利得は無い。

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

(1) 注入が物理的に失敗した場合と (2) ファイルは読めるが別値が入っている場合を **挙動としては
区別しない**（この (1)/(2) は「調査結果」および「変更 3」のケース A/B/C とは別の軸なので
混同しないこと）。(2) の唯一の実在形は「`.claude` が書き込み不可 + 既存の有効 JSON が別値」で
`:138` の `mktemp` が失敗するケースである。repo 内の自動フローから作る経路は無い
（git は exec ビット以外の mode を保存しない / read-only FS や ENOSPC なら `:825` の
`cat > "$RUNNER_FILE"` が `set -e` 下で先に死ぬ / 同一 worktree への並行起動は prewarm が
全 launch を同期コマンド置換で直列化しているため到達不能）。tracked な
`settings.local.json` を持つ repo は merge が成功して上書きされる（その内容が不正 JSON なら
ケース B と同じ経路になる）。

残るのは `chmod` と別 uid 所有で、**worktree の子セッションは `bypassPermissions` を持つので
`chmod` も実行できる**（ケース C を `mkdir` 1 回で作れるのと同じ actor である）。それでも
専用分岐を足さないのは、昇格の天井が `bypassPermissions` = 正常系で意図している状態そのもので
あり、(2) を別扱いしても得られる保護が無いからである。区別は挙動ではなく **警告ログに
実測値を載せる**ことで担保する。

**symlink 検査も足さない。** `$CWD/.claude` がユーザーの `~/.claude` への symlink である場合、
書き込みはユーザーのグローバル設定へ抜ける。ただしこれは `:121` の `mkdir -p` と `:138` の
`mktemp` が既に symlink を追従している **既存の性質** であり、読み直しは同じ実体を見るだけで
blast radius を変えない。本変更が新たに広げるものは無い。

**壊れた `settings.local.json` を書き直すこともしない。** ケース B ではフラグを足すだけで、
不正 JSON のファイルは worktree に残したまま claude が読む。理由は
「不正 JSON は `jq` でも sqlite json1 でも読めず中身を保全する意味が無いが、破棄は本設計の
スコープ（permission の昇格）を超えるので手を出さない」である。

この判断のトレードオフは正直に書いておく。worktree は再利用される
（`prewarm-panes.sh:387-388`）ため、一度壊れた `settings.local.json` は以後その worktree を
使う全ディスパッチで permission 注入と agmsg 配線の両方を落とし続ける。書き直さない判断は
その劣化を恒久化する。それでも本 spec では扱わない。

なお「破棄すると agmsg の配送配線を無言で落とす」という理屈は**成立しない**ので、理由に
使わないこと。`delivery.sh set` は `launch-workspace.sh` より先に走り（`prewarm-panes.sh` の
Step 2 = `:411` / `:417` が最初の launch = `:474` より厳密に前）、`launch-workspace.sh` 自身は
`delivery.sh` を一度も呼ばない。ケース A / B では `delivery.sh` 自身が rc=1 で落ちて hook を
1 つも書かず、`prewarm-panes.sh:401-402` の既定値 `cmux-send` が上書きされないまま残る
（`:414/420` は警告ログのみ）。つまり Step 2a が壊れたファイルを見る時点で配線はすでに失われている。

### 変更 1: Step 2a に注入結果の読み直しを足す (`launch-workspace.sh`)

`BYPASS_INJECTION_OK=1` の初期化は **`:547-568` のコメントブロックの直前**に置く
（コメントと `if` の隣接を崩さないため）。claude 限定ブロックの外なので、codex engine では
1 のまま残る。

読み直し本体の**挿入位置は `:580` の `fi` の直後、`:581-583` の `ensure_claude_exclusions` 用
コメントの直前**。claude 限定ブロックの内側に収める。`ensure_claude_exclusions` との前後関係に
機能上の依存は無い（同関数は失敗しても `|| true` で握り潰され、何も返さない）。決定性のために
位置を固定するだけである。

```bash
BYPASS_INJECTION_OK=1
# --- Step 2a: permission prompt 抑止 (claude engine の全 MODE) ---
# ...既存のコメントブロック (4-6 で差し替え)...
if [[ "$RUNNER_ENGINE" == "claude" ]]; then
  ...既存の注入ブロック (:570-580) は変更なし...

  # 注入結果をファイル実体で読み直す。merge_claude_settings の戻り値を信用できないのは、
  # settings.local.json がディレクトリのとき mv が temp をその中へ移動して return 0 を返し、
  # 値が 1 つも入っていないのに injected とログに出るため。実体を見れば mkdir / mktemp /
  # jq の失敗も、既存ファイルが不正 JSON でマージが拒否されたケースも同時に捕まえられる。
  # 設計ペイン (standby / superpowers の有人経路) は CLI フラグを持たないので、
  # ここが唯一の防壁になる。
  EFFECTIVE_DEFAULT_MODE=$(jq -r '.permissions.defaultMode // ""' \
    "$CWD/.claude/settings.local.json" 2>/dev/null || echo "")
  # 判定は必ず生の値で行う (下の if)。サニタイズ済みの値で比較してはならない。
  # ログ用の値だけを別変数へ落とす。制御文字を含む値が stderr へ抜けると端末を書き換えられ、
  # 偽の [permissions] injected 行まで捏造できるため。defaultMode の正当な値域は英数字なので、
  # それ以外を落とせば制御・書式・分離文字は全 locale で確実に消える
  # (A-Z / a-z / 0-9 は範囲式で collation 依存のため一部のラテン文字は locale により残るが無害)。
  EFFECTIVE_DEFAULT_MODE_LOG="${EFFECTIVE_DEFAULT_MODE//[^A-Za-z0-9_-]/}"
  EFFECTIVE_DEFAULT_MODE_LOG="${EFFECTIVE_DEFAULT_MODE_LOG:0:64}"
  if [[ "$EFFECTIVE_DEFAULT_MODE" != "bypassPermissions" ]]; then
    BYPASS_INJECTION_OK=0
    log "warn" "permission bypass not confirmed in $CWD/.claude/settings.local.json (defaultMode='$EFFECTIVE_DEFAULT_MODE_LOG')"
  fi

  # 既存の :581-583 のコメント (ensure_claude_exclusions の || true の理由) はそのまま残す
  ensure_claude_exclusions || true
fi
```

**サニタイズを比較の前に置いてはならない。** `[^A-Za-z0-9_-]` は空白・`.`・`!`・`"`・
`[` `]`・`/` をすべて落とすため、`bypassPermissions ` / `bypass Permissions` /
`bypass.Permissions` / `bypassPermissions!` / JSON 配列 `["bypassPermissions"]` といった
**Claude Code が `bypassPermissions` として解釈しない値**がすべて `bypassPermissions` へ潰れ、
フォールバックが発火しなくなる。本 spec が塞ごうとしているデッドロックがそのまま再現する。
生の値で比較し、サニタイズはログ専用の別変数に限ること。

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
# plan は :804 でリテラルのフラグを持つので足さない。
# execute / standby / review は呼び出し元の --skip-permissions が CLAUDE_EXTRA_FLAGS 経由で
# 届くので、実際に渡されたときだけ足さない (二重付与の回避)。
# superpowers は :802 が CLAUDE_MODEL_FLAGS しか読まず --skip-permissions を受け取らないため、
# その値に関わらず足す。
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

`|| true` は `set -e` 対策だが、根拠は「条件が偽のとき」ではない（`[[ -n "" ]] && log ...` は
偽でも rc=0 になる）。必要なのは **`log` 自身が失敗する経路**（stderr が閉じている等）で、
`log` は最後の `&&` の後ろにあり `set -e` の免除対象外なので、`|| true` が無いと launch ごと死ぬ。

claude engine の 3 分岐に `$PERM_FALLBACK_FLAG` を挿す。`plan` (`:804`) は変更しない。

| 行 | MODE | 変更後 |
|----|------|-------|
| `:784-788` | `execute` | `'$PROMPT_TEXT'` の直前に `$PERM_FALLBACK_FLAG`。**`CLAUDE_EXTRA_FLAGS` 有無の両分岐とも**（`:787` の else 側は `CLAUDE_EXTRA_FLAGS` を持たないので見落としやすい） |
| `:793` | `standby` / `review`（prompt 有り） | `'$PROMPT_TEXT'` の直前に `$PERM_FALLBACK_FLAG` |
| `:795` | `standby` / `review`（prompt 無し） | この行は prompt を持たないので**末尾に追記**する |
| `:802` | `superpowers` | `${CLAUDE_MODEL_FLAGS:+ $CLAUDE_MODEL_FLAGS}$PERM_FALLBACK_FLAG` |

**行番号はすべて変更前のファイル基準である。** 同一ファイルへの編集は 4 つ（変更 1 / 変更 2 /
4-5 / 4-6）あり、変更 1 が約 20 行を挿入するため、適用後は `:802` → 実際 820、`:804` → 822、
`:793` → 811、`:795` → 813 のようにずれる。アンカー文字列は一意なので事故には至らないが、
**適用順は 4-5 → 4-6 → 変更 1 → 変更 2 とし、恒久コメントに行番号を焼かないこと**
（「`superpowers` の合成箇所」のように記述で書く）。

`:793` の splice 忘れは **prewarm の claude 設計ペインそのものを壊す**（`prewarm-panes.sh:515`
が `"$SLUG" "$OPUS_PROMPT"` の 2 位置引数を渡すので実構成は prompt 有り = `:793` を通る）。
テスト側の担保は 3-1 の P12 が持つ。

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

**設計ペインのエンドツーエンド（prewarm → 実 launch → composed command）はどの層にも作らない。**
代わりに 3-1 の P12 が prewarm の設計ペインと同じ引数形（`--mode standby --role plan` +
prompt 引数 + 注入不能）で `launch-workspace.sh` を直叩きし、`:793` を通す。この 1 本で
上記 5 条件を満たさずに継ぎ目を塞ぐ。

#### 3-1. `test/test-launch-workspace-permissions.sh` に P12〜P25 を追加

既存ハーネス（`cmux` スタブ + `RUNNERS_CONFIG_PATH` + `new_repo`）をそのまま使う。ただし
**2 つのヘルパーを新設する**。

**計数ヘルパー（必須）**: composed command は runner script の単一行に載るため `grep -c` では
二重付与を検出できない（`grep -c` は行数を数える）。既存ハーネスのアサーションはすべて
部分文字列一致で、計数手段が存在しない。`set -euo pipefail` 下で 0 件を数えると
スクリプトごと落ちるため `|| true` が要る。macOS の `wc -l` は先頭空白を出すので `tr -d ' '`。
ファイル不在で `0` を返すと否定側が空虚に PASS するので、存在確認を先に置く。

```bash
count_flag() {
  [[ -f "${1:-}" ]] || { echo "missing:${1:-<none>}"; return; }
  { grep -o -- '--dangerously-skip-permissions' "$1" || true; } | wc -l | tr -d ' '
}
```

**比較は必ず文字列で行い `(( ))` を使わないこと。** `missing:...` を `(( v == 1 ))` に渡すと
bash 3.2 + `set -u` で `missing: unbound variable` になり、テストファイルごと rc=1 で中断する。

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

**必須事項**:

- **フラグの計数対象は `$runner_file` のみ。** stdout / stderr を混ぜたものに対して数えてはならない。
- **テストが渡す prompt / plan パスに `--dangerously-skip-permissions` の文字列を含めないこと。**
  含めると `count_flag` が付与ゼロでも 1 を返し、オラクルが壊れる。P12 のように prompt 引数を
  渡すケースを足す以上、これは load-bearing な制約になる。
- **prompt には `'` `"` `` ` `` `$` `!` `\` も入れないこと。** composed command は
  `zsh -ic "... '$PROMPT_TEXT' ..."` で二重に引用され `launch-workspace.sh` はエスケープしない
  （`-i` は対話モードなので history 展開が効き `!` も特殊文字になる）。`CLAUDE.md` 保守項目 27 が
  `parallel-directive.sh` に課しているのと同じ不変条件である。

| id | MODE / 条件 | 期待 |
|----|------------|------|
| P12 | `standby`・**prompt 引数あり**・注入不能 A | `count_flag == 1`、stderr に `added the CLI permission flag` が**出る**。`:793`（prewarm 設計ペインの実構成）を通す |
| P13 | `superpowers`・注入不能 A | `count_flag == 1`（変更 2 の `:802` splice の担保） |
| P14 | `superpowers`・注入不能 A・`--skip-permissions` 明示 | `count_flag == 1`（`superpowers)` 分岐が `SKIP_PERMISSIONS` を見ないこと） |
| P15 | `superpowers`・正常系・`--skip-permissions` 明示 | `count_flag == 0`（P6 / RM10c の契約を維持） |
| P16 | `standby`・prompt 引数なし・注入不能 A・`--skip-permissions` 明示 | `count_flag == 1`（二重付与なし。`:795` の splice は担保しない — 後述） |
| P17 | `plan`・注入不能 A | `count_flag == 1`、stderr に `added the CLI permission flag` が**出ない** |
| P18 | `execute`・注入不能 A・`--skip-permissions` 無し | `count_flag == 1`（`:785` splice の担保） |
| P19 | codex engine・`.claude` の状態に関わらず | `count_flag == 0` かつ新警告が出ない |
| P20 | 正常系（`standby` / `superpowers`） | `count_flag == 0` かつ stderr に `permission bypass not confirmed` が**出ない** |
| P21 | `standby`・**prompt 引数なし・`--skip-permissions` なし**・注入不能 **B**（既存の不正 JSON） | `count_flag == 1`、stderr に新警告、`settings.local.json` が**不正 JSON のまま残る**。`:795` の splice の担保者 |
| P22 | `standby`・worktree 再利用（同一 repo へ 2 回 launch） | `count_flag == 0`、新警告が出ない、`defaultMode is already bypassPermissions` が stderr に**出る** |
| P23 | `standby`・`--unattended`・`--skip-permissions` 無し・注入不能 A | `count_flag == 1` |
| P24 | `standby`・**prompt 引数なし・`--skip-permissions` なし**・注入不能 **C**（`settings.local.json` がディレクトリ） | `count_flag == 1`。`:795` の担保者かつ戻り値ベース誤実装の唯一の検出者 |
| P25 | 非 git `--cwd`・注入不能 A | launch が rc=0 で成功し `count_flag == 1` |
| P26 | `standby`・`.claude` を `chmod a-w` して既存の有効 JSON に制御文字入りの `defaultMode` を残す（**root では skip**） | `count_flag == 1`、警告行に制御文字が 1 バイトも含まれず、偽の `[permissions] injected` 行が捏造されない |

各ケースの意図（テスト内コメントに書くこと）:

- **P12 が最重要。** `:793` だけ splice を忘れた実装は、prompt 引数を渡さないケースだけでは
  1 件も検出できない（レビュー側の mutation testing で確認済み）。しかもその `:793` が
  prewarm 設計ペインの実構成である。既存 P9 の `p9-standby` は WORKSPACE_NAME（第 1 位置引数）
  であって prompt ではないので、P9 を雛形にすると `:795` しか通らない点に注意。
- **P19 のフラグ側は判別能力を持たない**（`BYPASS_INJECTION_OK` が 0 になるのは claude 限定
  ブロックの内側だけなので、engine ガードを削った実装でも `count_flag == 0` は通る）。
  ただし**併記する「新警告が出ない」の側は、読み直しを claude ブロックの外へ動かした実装を
  実際に検出する**。両者を必ず併記すること。
- **P20 は偽陽性フォールバックの検出に load-bearing**。`standby` / `review` / `execute` は
  元からフラグを持つ経路があるため、読み直しが常に失敗する実装バグ（パス誤りなど）が composed
  command に現れず不可視になりうる。
- **P22 も偽陽性検出**である。`:575` の短絡経路（`merge_claude_settings` を**呼ばない**）は
  実運用の主経路でもある（prewarm は全ペインに同一 `--cwd` を渡すので 2 枚目以降は必ず通る）。
- **P21 と P24 が `:795`（prompt 無し分岐）の splice を担保する。** P16 は
  `--skip-permissions` を明示するので `SKIP_PERMISSIONS=1` → `*)` アームが偽 →
  `PERM_FALLBACK_FLAG` が空になり、その `count_flag == 1` は `CLAUDE_EXTRA_FLAGS` 由来だけで
  splice の有無に完全に無感応である。**P21 / P24 は prompt 引数を渡さず
  `--skip-permissions` も付けないこと**（付けると `:795` の穴が誰にも見えなくなる）。
- **P24 だけが「戻り値ベースの誤実装」を弾ける。** A と B は `merge_claude_settings` が 1 を
  返すので、`BYPASS_INJECTION_OK=1` を無条件初期化する本設計では、戻り値で分岐した実装でも
  P24 以外は全部通る。差が出るのはケース C の 4 通りだけである。
  **「P22 があるから P24 は冗長」という判断でこの穴を復活させないこと。**
- **P23 は変更 2 のブロック位置を担保する**。`SKIP_PERMISSIONS` が 1 になる経路は `:254`
  （引数）と `:742`（`UNATTENDED`）で行が離れている。ブロックを `:741` より前に置くと P16 は
  1 個のまま通るが、`--unattended` では `*)` が足した後に `:746` がもう 1 個足して 2 個になる。
- **P17 は 3 種の実装ミスを単独検出する**（stderr の否定 assert を落とさないこと）:
  `plan) ;;` の単独削除（`*)` に落ちて `SKIP_PERMISSIONS=0` なので付与ログが出る）、
  `plan) ;;` 削除 + `:804` への splice（フラグが 2 個になる）、付与ログの無条件出力
  （変更 1 の検出ログと変更 2 の付与ログを分離した設計の回帰）。P17 はこの分離を守る唯一の砦である。
- **P25 に flag oracle としての価値は無い**（P13 の重複であり、P13 自身も P14 の真部分集合）。
  読み直しを `ensure_claude_exclusions` の後ろへ動かす mutant も P1〜P26 を全件 PASS するので、
  「将来の位置変更への保険」とも書かないこと。残す意味は「非 git `--cwd` でも launch が rc=0 で
  続き、異常系でもフラグが付くこと」= P11 の異常系版の確認だけである。
- **`review` MODE のケースは置かない。** `:789` は `standby` / `review` の単一分岐なので、
  変更 2 の `case` でも両者は同じ `*)` に落ちる。ただし `*)` の代わりに
  `execute|standby)` と MODE を列挙するスリップは自然に起こり、それは P12〜P26 を全件 PASS する。
  それでもケースを置かないのは、**production の claude review ペインが prewarm 経路
  （`prewarm-panes.sh:638`）でもオンデマンド経路（`SKILL.md:1354`）でも常に
  `--skip-permissions` 付きで起動するため、`*)` が review を落としても composed command が
  変わらない**からである（「mutant が作れないから」ではない）。
- **サニタイザ（変更 1 のログ用 2 行）の回帰は P26 が持つ。** ただし到達には「読めるが別値」の
  状態が要るため `chmod a-w` が必要で、root 実行では成立しない。**root のときは skip し、
  skip したことを標準出力に明示すること**（無言 skip は空虚な PASS と同じ）。他ケースの
  A/B/C レシピが root でも成立するのとは扱いが違う点に注意。

警告文字列 `permission bypass not confirmed` と `added the CLI permission flag` の 2 つを
テスト定数に固定する（`CLAUDE.md` 保守項目 24 の `HOOK_WARN` と同じ運用）。前者は肯定側
（P21）と否定側（P19 / P20 / P22）、後者は肯定側（P12）と否定側（P17）で使う。

**注入不能状態の作り方**:

- A: `printf '' > "$repo/.claude"`（`.claude` を通常ファイルにする）
- B: `mkdir -p "$repo/.claude"; printf '{ not json,,,\n' > "$repo/.claude/settings.local.json"`
- C: `mkdir -p "$repo/.claude/settings.local.json"`

いずれも `chmod` と違って root 実行でも成立する。launch は rc=0 で続行し runner script も
生成される。

**P25 は P11 の `$TMP/plain-dir` を再利用してはならない。** P11 は `$plain` への注入を
**成功**させるので `$plain/.claude/` がディレクトリとして残り、そこへ A のレシピ
`printf '' > "$plain/.claude"` を実行すると `Is a directory` で rc=1 になる。
`set -euo pipefail` 下なので **P25 以降のケースと `--- all tests passed ---` の行が失われ、
テストが途中で停止する**（`pass()` は即座に echo するので先行結果は残る）。
`$TMP/plain-dir-p25` のように別ディレクトリを使うこと。

副作用を把握しておくこと:

- A では Step 2b の plan hook 注入 (`:593-611`) も同時に失敗し、MODE=plan では
  `merge_claude_settings:122` の `failed to create ...` が 2 回出る。**新警告
  `permission bypass not confirmed` は plan を含め常に 1 回**である。`[warn]` 行の総数に
  依存した assert を書かないこと。
- 実運用では agmsg の `delivery.sh set` (`prewarm-panes.sh:411/417`) も同じファイルを触るため、
  3 ケースで挙動が違う。テストではスタブなので無影響だが、シミュレーションの正体を誤解しないこと。

  | ケース | `delivery.sh set` の結果 | `prewarm.json` の `delivery` |
  |--------|------------------------|----------------------------|
  | A | rc=1（`mkdir -p` 失敗） | `cmux-send` |
  | B | rc=1（`Error: stepping, malformed JSON`） | `cmux-send` |
  | C | **rc=0（同じ `mv`-into-directory バグを踏み成功を偽報告）** | `agmsg`（**偽の配線成功**） |

- `ensure_claude_exclusions` / prompt file / runner script の書き込みは 3 ケースとも壊れない。
- `TMPDIR` が repo ツリー内を指す環境では、P11 / P25 の `ensure_claude_exclusions` が実 repo の
  `.git/info/exclude` に 2 行追記する（git が親を遡るため）。既定の `/var/folders/...` では
  発火しない。`grep -qxF` ガードで冪等なので無害であり、P11 の既存の性質で P25 が広げるものではない。

**ヘッダコメントも更新すること。** `test-launch-workspace-permissions.sh:2-5` を次で置き換える
（`:5` の「superpowers にフラグを足していないこと」は正常系限定の主張に変わるので、
CLAUDE.md 側だけ直してテストファイル側が残ると同じドリフトが再発する）:

```bash
# launch-workspace.sh が claude engine の worktree に注入する
# .claude/settings.local.json の permissions.defaultMode の回帰テスト。
# 検証項目: 全 MODE への注入 / codex engine 非対象 / 既存キー保持 / 冪等性 /
# 正常系では superpowers にフラグを足さないこと / info/exclude の追記 /
# 注入を確認できなかったときの --dangerously-skip-permissions へのフォールバック
# (3 ケース A・B・C、二重付与なし、正常系で誤発火しないこと)。
```

#### 3-2. `test/test-prewarm-design-permissions.sh` を新設（id prefix は `DB`、2 ケースのみ）

`test-prewarm-layout.sh` と同じ構成（`prewarm-panes.sh` をコピーし、隣に argv を記録する
`launch-workspace.sh` スタブ、agmsg スタブ、`RUNNERS_CONFIG_PATH`）。

| id | 期待 |
|----|------|
| DB1 | 同一 dispatch で、claude 設計の argv に `--skip-permissions` が **無く**、claude executor の argv には **ある**（非対称そのものを 1 ケースで固定する） |
| DB2 | codex 設計の argv に `--skip-permissions` が **無い** |

**このファイルは本 spec が入れる新挙動の回帰テストではない。** スタブが
`launch-workspace.sh` を実行しないので変更 1・変更 2 のコードには 1 行も到達しない。固定するのは
「欠陥 2」で指摘した既存の非対称であり、カバレッジ負債の返済である。この位置づけを
ファイル冒頭コメントと `CLAUDE.md` 保守項目 25 の両方に明記すること。

**既存テストとの重複**（新規価値は DB1 の executor 側と DB2 だけである）:

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
- **ペイン特定には `test-prewarm-layout.sh:78-80` の `pane_line()` を使う**
  （`--agmsg-from <name> ` の**末尾スペース**で `<slug>` と `<slug>-claude` の前方一致を防ぐ）。
  `--role exec` での特定は使わないこと: `--exec-choice ask` では claude / codex の
  executor 2 行にマッチし、フラグを持つのは 1 行だけなので偽 FAIL する。`pane_line()` を使えば
  DB1 は 1 ケースで両半分（設計行に flag なし / `<slug>-claude` 行に flag あり）を assert できる。
- **`pane_line()` を使うには `prewarm-panes.sh` に `--agmsg-team <name>` を渡すこと。**
  `--agmsg-from` は `AGMSG_TEAM` が空だと argv に出ない（`prewarm-panes.sh:555` / `:591`）。
  モデルの `test-prewarm-layout.sh:73` は `--agmsg-team demo-team` を渡している。
- **否定アサーションは 3 段構えで書く**: 対象行を取得 → 空なら `bad` → その行にフラグが無いことを
  assert。`test-prewarm-unattended.sh:60-65` の `assert_no_line_with` は 0 行マッチでも `ok` を
  返すのでモデルにしないこと（同ファイル `:53-59` の `assert_all_lines_with` は
  `total -gt 0` でガードしており非対称）。`test-prewarm-layout.sh:83-103` の `expect_split`
  （`[[ -z "$line" ]] && bad` を持つ）が良いモデル。
- 3-2 のスタブは runner script も `.claude/` も生成しない。**runner script のパスを組み立てて
  grep してはならない**（ファイルが存在しないので否定アサーションが必ず通る）。

### 変更 4: ドキュメント同期

挙動が変わるので `CLAUDE.md` のハードルールに従い 4 ファイルすべてを同じ commit で更新する。
加えてスクリプト内の 1 箇所（Step 2a コメント）も直す。

`scripts/check-doc-lang.mjs:94-104` は `*-ja.md` について `empty-translation`（日本語が 1 文字も
無い）しか見ないため、訳が原文より短くても `pnpm check` は green のまま通る。整合を守る唯一の
手段が spec 側での文面確定なので、置換する本文はすべて逐語で確定する。

#### 4-1. SKILL.md（英語のみ。日本語文字を 1 文字も入れない）

engine × MODE 表の本体は `:378-386`。差し替え対象は **`:381`（`claude | superpowers` 行）**:

```
| claude | superpowers | `<command> [--model <plan_model>] [--effort <plan_effort>] [--dangerously-skip-permissions] 'Read and follow the task in .cmux-team-dispatch-task-prompt.md'` |
```

**角括弧の中に条件を書き込まない。** この repo の既存慣行は `:382` のように角括弧を裸で置き、
条件は直下の散文（`:388-395`）が担う形で、セル内に脚注記法を持つ前例は SKILL.md に 0 件である。
この選択は guide-ja 側の書式差の問題も同時に消す。`:382` は変更しない。

**慣行に従う以上、直下の散文も更新する。** `:391-393` の末尾（`work).` の直後）に次の 2 文を足す:

```
Both brackets in that table are conditional, but not on the same thing: the one on the
`execute` row means the caller passed `--skip-permissions`, while the one on the
`superpowers` row means the settings readback described below failed. `superpowers` never
takes the flag from `--skip-permissions`, and `execute` gains it from either source.
```

`claude | standby` / `claude | review` の行は **足さない**。理由は「表がプロンプトを持つ
モードだけを並べているから」ではない（`:386` の `codex | review` 行はプロンプトを持たない）。
行を足すと guide-ja.md の対応表にも同じ拡張が要り、standby / review は起動プロンプトが
`--mode` ごとに固定されず親からの送信で決まるためセルに書ける「Composed command」が
一意にならないからである。standby / review の扱いは直下の段落で文章として書く。

`:409-414` の段落を次で置き換える:

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
file inside it and still reports success. The launcher therefore reads the file
back. When `permissions.defaultMode` is not `bypassPermissions` at that point —
the merge could not be written, a pre-existing `settings.local.json` holds
invalid JSON that `jq` refuses, or the directory case above — the launcher logs
a warning containing `permission bypass not confirmed` and adds
`--dangerously-skip-permissions` to that launch. It never doubles the flag:
`plan` already carries it literally at the composition site, and `execute` /
`standby` / `review` are skipped when the caller actually passed
`--skip-permissions`. `superpowers` is the exception that always gets the
fallback, because its composition site never reads `--skip-permissions` at all.
That is also why the bracket on the `superpowers` row above means something
different from the one on the `execute` row. Without the fallback the design
pane would be the only claude pane with no second line of defence, and it would
block on its first permission prompt with nobody attached.
```

置換後、`:416` の先行詞がフォールバック段落へ移る。`:416` の 1 行を次で置き換えて受け直す:

```
`AskUserQuestion` stays interactive under `bypassPermissions`: the permission system gates
```

#### 4-2. guide-ja.md

対応段落は **`:1619-1623`**（1619 行「MODE によらず、解決された runner engine が `claude` の
ときは worktree の」から始まる）。次で置き換える:

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
成功を報告するからである。そのため launcher はファイルを読み直す。その時点で
`permissions.defaultMode` が `bypassPermissions` でなければ — マージを書き込めなかった、
既存の `settings.local.json` が不正な JSON で `jq` に拒否された、あるいは上記の
ディレクトリのケース — `permission bypass not confirmed` を含む警告を出し、その launch に
`--dangerously-skip-permissions` を足す。二重付与は起きない。`plan` は組み立て箇所で
既にリテラルを持っており、`execute` / `standby` / `review` は呼び出し元が実際に
`--skip-permissions` を渡していたときは足さないからである。`superpowers` だけは例外で、
組み立て箇所がそもそも `--skip-permissions` を読まないため常にフォールバックが付く。
上の表の `superpowers` 行の角括弧が `execute` 行の角括弧と違う意味になるのはこのためである。
フォールバックが無いと、設計ペインだけが第二の防壁を持たない claude ペインとなり、
誰も見ていない状態で最初の permission prompt に当たって停止する。
```

`:1625` の書き出し（`このモードでも \`AskUserQuestion\` は対話的なまま残る。`）も
SKILL.md `:416` と同様に置き換える。置換後の直前の段落がフォールバックの説明で終わるため、
「このモード」の最近接先行詞が `--dangerously-skip-permissions` になってしまう:

```
`bypassPermissions` の下でも `AskUserQuestion` は対話的なまま残る。permission システムが門番をするのは
```

表 `:1604`（`claude | superpowers` 行）を次で置き換える（guide-ja は固定プロンプトを
`:1598-1599` へ括り出して cell を `'<PROMPT>'` に短縮する書式なので、SKILL.md の行をそのまま
貼らないこと）:

```
| claude | superpowers | `<command> [--model <plan_model>] [--effort <plan_effort>] [--dangerously-skip-permissions] '<PROMPT>'` |
```

SKILL.md `:391-393` と対応する散文（guide-ja `:1610-1615` の effort 段落）の末尾にも、
角括弧の意味差を説明する 2 文を足す:

```
上表の角括弧はどちらも条件付きだが、条件は同じではない。`execute` 行のそれは
「呼び出し元が `--skip-permissions` を渡したとき」、`superpowers` 行のそれは
「後述の settings 読み直しが失敗したとき」を意味する。`superpowers` は
`--skip-permissions` からフラグを受け取ることが無く、`execute` は両方の経路から受け取る。
```

あわせて **既存のドリフト 2 件を同 commit で直す**（4 ファイル整合ルール上、放置できない）:

1. `:1607`（`codex | superpowers` 行）に `--dangerously-bypass-approvals-and-sandbox` が
   抜けている（`SKILL.md:384` にはある）。次で置き換える:

```
| codex  | superpowers | `<command> [-c model_reasoning_effort='<plan_effort>'] [--model <plan_model>] --dangerously-bypass-approvals-and-sandbox '$superpowers:brainstorming <PROMPT>'` |
```

2. `codex | review` 行が `SKILL.md:386` にあって guide-ja の表に無い。
   `:1608`（`codex | execute` 行）の直後に次を挿入する:

```
| codex  | review      | `<command> [-c model_reasoning_effort='<review_effort>'] --model <review_model> --sandbox workspace-write -c approval_policy='never' --add-dir <STATUS_DIR>` |
```

#### 4-3. README.md

「permission prompt の抑止」節は `:145-168`。**`:166` の空行の直後、`:167` の codex 段落の
直前**に「次の段落 + 空行 1 行」を挿入する（節の末尾に置くと claude 専用の説明が
「codex engine は対象外」の後に来る）:

```
注入はベストエフォートで、戻り値も信用できない（`settings.local.json` がディレクトリだと
`mv` が temp をその中へ移して成功を報告する）。そのため起動スクリプトは書き込み後に
ファイルを読み直し、`permissions.defaultMode` が `bypassPermissions` になっていなければ
`permission bypass not confirmed` を含む警告を出したうえで、その起動にだけ
`--dangerously-skip-permissions` を足す。これが無いと、権限フラグを持たない設計ペインだけが
注入失敗時に素の権限で上がり、誰も見ていない状態で permission prompt に当たって止まる。
なおこのフォールバックも上記の確認ダイアログの前提を共有するので、
`skipDangerousModePermissionPrompt` をユーザー設定に置いていない環境では同じダイアログで
止まる点は変わらない。
```

#### 4-4. CLAUDE.md（保守項目 25）

第 1 bullet の末尾「失敗は警告のみで dispatch を止めないこと」を次で置き換える:

```
失敗時は `permission bypass not confirmed` を警告し、フォールバックしたうえで dispatch は
止めないこと。書き込み後にファイル実体を読み直して `bypassPermissions` を確認できなければ、
`plan`（`:804` でリテラル付与済み）と、`--skip-permissions` が `CLAUDE_EXTRA_FLAGS` 経由で
届く MODE（`execute` / `standby` / `review` で、かつ呼び出し元が実際に渡したとき）を除いて
`--dangerously-skip-permissions` へフォールバックすること。`superpowers` は
`--skip-permissions` を受け取らない（`:802` は `CLAUDE_MODEL_FLAGS` のみ）ため、その有無に
関わらずフォールバックを付けること。判定に `merge_claude_settings` の戻り値を使っては
ならない（`settings.local.json` がディレクトリのとき `mv` が成功を報告する）
```

codex bullet の該当文は `codex engine には**一切注入しない**こと` と `**` を含むので、
文字列一致で探すときは注意する。その **第 1 文の直後**に次を足す:

```
フォールバックフラグも codex には付けないこと（P19 が守る）。
```

`merge_claude_settings` bullet の末尾に、実装時に崩してはならない制約 2 件を足す:

```
新しい警告文にフラグのリテラル `--dangerously-skip-permissions` を含めないこと（テストが
composed command のフラグを数えるとき警告文にマッチして空虚な PASS になる）。agmsg の
`delivery.sh set` は同じ `settings.local.json` を read-modify-write するので、
`prewarm-panes.sh` の Step 2 が全 launch より前に走る順序を崩さないこと（崩すと注入が
巻き戻り、読み直しは Step 2a で終わっているため検出できない）。
```

最終 bullet を次で置き換える:

```
回帰は `bash test/test-launch-workspace-permissions.sh` の P1〜P26（全 MODE 注入 / codex 非対象
/ 既存キー保持 / 冪等 / 正常系では superpowers にフラグを足さない / info/exclude 追記 /
`--skip-permissions` との共存 / 非 git cwd でも launch が成功 / 読み直し失敗の 3 ケース
A・B・C でのフォールバック / superpowers は `--skip-permissions` を読まない（P14）/
standby の prompt 有無の両分岐 / plan と `--skip-permissions` 既付与での二重付与なし /
正常系で誤発火しない（P20）/ worktree 再利用の短絡では発火しない / `--unattended` との共存 /
ログ値のサニタイズ（P26、root では skip））と
`bash test/test-prewarm-design-permissions.sh`（DB1-DB2: 設計ペインと claude executor の
`--skip-permissions` 非対称。本項目の変更に対する回帰ではなく既存カバレッジ負債の返済）で
検証する。警告文言 `permission bypass not confirmed` と `added the CLI permission flag` は
テスト定数なので、変えたら両テストも同時に更新すること
```

#### 4-5. `launch-workspace.sh` の usage ヘッダ

`--skip-permissions` の説明 (`:41-43`) は**変更不要**（呼び出し元が明示するフラグという説明は
そのまま真である）。その下の注記ブロック (`:47-50`) を次で置き換える:

```
#   注記: claude engine では MODE を問わず、worktree の
#   .claude/settings.local.json に permissions.defaultMode: "bypassPermissions" を
#   注入する (Step 2a)。注入後にファイルを読み直して確認できなかったときは、
#   plan (組み立て箇所でリテラル付与済み) と、呼び出し元が --skip-permissions を
#   渡した execute / standby / review を除いて --dangerously-skip-permissions を
#   自動で足す。superpowers は --skip-permissions を読まないので常に足す。
#   --skip-permissions はそれとは別に呼び出し元が明示するフラグ。codex engine は対象外。
```

#### 4-6. `launch-workspace.sh` Step 2a のコメント (`:547-568`)

現行は「注入だけが機構」と読める。全文を次で置き換える（既存の裏取り 3 点と確認ダイアログの
注記は保存する）:

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
# 値が 1 つも入っていないのに injected とログに出る。だから戻り値ではなくファイルを
# 読み直して判定する。読み直しが失敗を告げたときに CLI フラグへ落とすのは、設計ペイン
# (standby / superpowers の有人経路) だけが第二の防壁を持たず、permission prompt に
# 当たると誰にも通知されないまま停止してディスパッチごとデッドロックするため。
#
# bypass モード突入の確認ダイアログはフラグでも defaultMode でも出る。抑止する
# skipDangerousModePermissionPrompt は project settings では無視されるため、
# ユーザー設定 ~/.claude/settings.json 側に置く必要がある (README 参照)。
# したがってフォールバックもこの前提を共有する。
#
# codex engine は .claude/settings.local.json を読まないため対象外。codex は
# --dangerously-bypass-approvals-and-sandbox / review ペインの
# --sandbox workspace-write で既に prompt が出ない。
```

## 非目標

- **codex 経路には手を入れない。** 調査で bypass 済みであることを確認済みで、既存テスト T4 が
  担保している。P19 は claude 側ガードの回帰であって codex の挙動変更ではない。
- **`superpowers` を `CLAUDE_EXTRA_FLAGS` へ切り替えない。** 呼び出し元の `--skip-permissions`
  を superpowers が無視するという既存契約（P6 / RM10c）は維持する。
- **壊れた `settings.local.json` を書き直さない**（理由は「設計」節に記載）。
- **symlink / ディレクトリ種別の事前検査を足さない**（同上）。
- **`skipDangerousModePermissionPrompt` の扱いは変更しない。** ユーザー設定
  `~/.claude/settings.json` に置く必要がある旨は既に文書化されている。
- **報告者の観測が bypass 確認ダイアログ由来だった場合、本変更は症状を解消しない。**
  managed / enterprise scope で `disableBypassPermissionsMode` が効いている環境も同様で、
  そこでは異常系の見え方が「ハング」から「Claude Code がフラグを拒否して即死」へ変わりうる
  （root 実行と同じクラス。未検証の推測として記録しておく）。
- **stdout JSON にフォールバックの痕跡を出さない。** `permission_fallback` 相当のキーを足せば
  親オーケストレータが縮退起動を報告できるが、stdout JSON の契約は 4 ファイルに documented
  されており拡張コストが便益に見合わない。痕跡は stderr の最大 2 行（検出の `[warn]` と付与の
  `[permissions]`。`plan` や `--skip-permissions` 既付与の経路では付与ログが出ないので 1 行）
  だけになる。runner script の composed command も残るが、worktree 内
  （`:824`）なので最終クリーンアップの `git worktree remove --force` で消え、当の子セッションが
  上書きもできるため恒久的な監査証跡ではない。この限界を承知のうえで見送る。
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
- シェルは bash 3.2 互換を維持する（新規の配列展開を導入しない。`${var//[^A-Za-z0-9_-]/}` と
  `${var:0:64}` は bash 3.2.57 で動作確認済み。文字クラスではなく否定リテラル集合なので
  locale にも依存しない）。

## 検証

**すべて worktree ルートで実行すること。** `/Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins`
は main のチェックアウトであり、変更 4 が触る 4 ファイルはそこには存在しない。そこで
`check-doc-lang` を走らせても必ず green になり、`japanese-in-english-doc` 違反を取り逃がす。

```
WT=$(git rev-parse --show-toplevel)
cd "$WT/apps/cmux-team-dispatch-task"
rc=0; for t in test/*.sh; do printf '%-46s ' "$t"; if bash "$t" >/dev/null 2>&1; then echo OK; else echo FAILED; rc=1; fi; done
cd "$WT" && node scripts/check-doc-lang.mjs apps/cmux-team-dispatch-task
exit $rc
```

失敗したスイートは `>/dev/null` を外して項目単位で確認する。全スイート green かつ
`check-doc-lang` が OK であること。

`pnpm check` は **worktree に `node_modules` が無いと `turbo: command not found` で落ちる**。
worktree で走らせるなら先に `pnpm install` すること。走らせない場合は
`check-doc-lang` を単体で実行した結果をもって doc gate の確認とし、その旨を報告に書く。
`pnpm check` を通す場合、`@tanaka-yui/token-meter` の `noNonNullAssertion` 警告 4 件は
既知のノイズであって失敗ではない。

変更 2 が触る `:802` の出力を実際に assert している既存アサーションは **P6
(`test-launch-workspace-permissions.sh:131`) と RM10c (`test-role-models.sh:113`) の 2 件だけ**
である。次の 3 つは claude の superpowers 経路を通す（回帰時に走る）が、**権限フラグを見ていない
ので**変更 2 が壊れても落ちない — 検証の頼りにしないこと:

- `test-launch-workspace-layout.sh:65`（assert は `claude-teams` の不在のみ。`:53` は
  削除済みフラグの die を期待するループで `:802` に到達しない）
- `test-launch-workspace-codex.sh:159-174`（`--runner claude` で全 MODE を回すので `:802` は
  通るが、assert は codex 用フラグの不在のみ）。同ファイル `:229`（T12）も
  `--mode execute --unattended` を走らせるが `assert_contains` の存在確認だけなので
  二重付与を検出できない
- `test-prewarm-layout.sh` PG1〜PG3（`launch-workspace.sh` をスタブへ差し替える）

テスト実行後に残留物が無いことを確認する（slug 別のフィルタは狭すぎるので使わない）:

```
git worktree list
git branch --list
git worktree prune -n -v
git status --porcelain
```

実行前と比べて worktree 件数（main + 稼働中 3 worktree = 4 件）とブランチ一覧が増えていないこと。
`git status --porcelain` は本ディスパッチ自身の生成物
（`.cmux-team-dispatch-task-prompt.md` と 3 本の `.cmux-team-dispatch-task-run-*.sh`）以外を
出さないこと。**`git add -A` でこれら 4 件を commit に巻き込まないこと**（tracked にすべき
ファイルではない）。過去に worktree ルートへ `git status` の出力そのものを名前に持つ
ディレクトリを作ってしまった前例があるので、アドホックな probe を書くときは出力先を必ず
`mktemp -d` にすること。
