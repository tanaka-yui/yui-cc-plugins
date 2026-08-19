# 設計ペインの permission bypass を fail-closed 化する設計

対象: `apps/cmux-team-dispatch-task`

## 背景

「設計 (Phase A) ペインが bypass-permission モードで上がらない」という報告を受けた。
`claude` engine の設計ペインは permission prompt が出ない状態で起動するはずだが、実際には
そうなっていない、という内容である。あわせて `codex` の設計ペインも承認バイパス済みで
上がることが要件として挙がっている。

## 調査結果: 報告された症状は再現しない

まず「実際に何が起きているか」を確定させた。結論として **報告された症状は現行コードでは
再現しない**。以下は本ディスパッチ自身のペインを `cmux read-screen` で実測した結果である。

| surface | 役割 | 起動フラグ | 実測表示 |
|---------|------|-----------|---------|
| 47 | design | `claude --model 'opus[1m]' --effort 'xhigh'`（**権限フラグなし**） | `⏵⏵ bypass permissions on` |
| 48 | claude executor | `--dangerously-skip-permissions` あり | `⏵⏵ bypass permissions on` |
| 49 | review | `--dangerously-skip-permissions` あり | `⏵⏵ bypass permissions on` |

セッション transcript の `type: "permission-mode"` レコードも全件 `bypassPermissions` で、
この repo の全 worktree セッション 14 本すべてが同じ結果だった。

SKILL.md が主張している 2 点も、コードを読んで裏を取った結果いずれも **正しい**:

- **注入は全 MODE に届く**: Step 2a (`launch-workspace.sh:569`) は MODE の条件分岐の外にあり、
  `RUNNER_ENGINE == "claude"` だけを条件に発火する。prewarm の設計ペインが使う `standby` も
  当然対象に含まれる。
- **書き込みはプロセス起動より前**: Step 2a は 569 行、runner script 生成 (Step 4) は 811 行以降、
  `cmux new-workspace` はさらにその後。設定ファイルは claude プロセスが読む前に確定している。
- **codex 設計ペインは bypass 済み**: hermetic な probe で composed command を確認したところ
  `codex -c model_reasoning_effort='xhigh' --dangerously-bypass-hook-trust
  --dangerously-bypass-approvals-and-sandbox` が生成されていた。既存テスト T4 も同じ内容を
  担保している。
- **engine 値の抜け道は無い**: `runners.json` の `engine` が `claude` / `codex` 以外なら
  起動前に die する。注入をすり抜けて claude が素の権限で起動する経路は存在しない。

したがって「注入が効いていない」「順序が逆」「codex にフラグが無い」という仮説はすべて棄却される。

## それでも修正すべき実在の欠陥

再現しなかったからといって現状が健全なわけではない。調査の過程で、報告された症状と
**同じ結果を招きうる実在の欠陥** が 2 つ見つかった。

### 欠陥 1: 設計ペインだけが単一機構に依存している

`merge_claude_settings` は失敗しても警告を出すだけで、`launch-workspace.sh` は起動を続行する
（`.claude` ディレクトリを作れない / `jq` のマージが失敗する / `mktemp` が失敗する、など）。

このとき各ペインがどうなるかは非対称である:

| ペイン | MODE | 権限フラグ | 注入失敗時 |
|--------|------|-----------|-----------|
| claude 設計 (prewarm) | `standby` | なし | **素の権限で起動する** |
| claude 設計 (非 prewarm) | `superpowers` | なし | **素の権限で起動する** |
| claude 設計 (非 prewarm) | `plan` | 常時付与 | 無害 |
| claude executor | `standby` | `--skip-permissions` 付き | 無害 |
| claude review | `review` | `--skip-permissions` 付き | 無害 |

設計ペインは唯一「第二の防壁」を持たない。注入に失敗すると、誰も見ていないペインが最初の
permission prompt で永久に停止する。設計ペインは status.json の遷移も親への完了通知も行わない
まま止まるため、ディスパッチ全体がデッドロックする。これは報告された症状とまったく同じ見え方に
なる。

### 欠陥 2: 設計ペイン起動経路にテストが無い

`test-launch-workspace-permissions.sh` の P1〜P11 はすべて `launch-workspace.sh` を直接叩く。
`prewarm-panes.sh` の設計ペイン起動経路を検証するテストは 1 本も存在しない。P9 は `standby` を
扱うが `--skip-permissions` を **付けた** ケースなので、「設計ペインにはフラグが無い」という
本件の核心そのものがテストから不可視になっている。

## 設計

方針は **fail-closed**。注入を主機構として維持したまま、それが効かなかったときに限り CLI フラグへ
落とす。正常系の composed command は 1 バイトも変えない。

### 変更 1: Step 2a に注入結果の検証を足す (`launch-workspace.sh`)

既存の注入ブロックの直後で `.claude/settings.local.json` を **読み直して** 検証する。
`merge_claude_settings` の戻り値を信じるのではなくファイルの実体を見るのは、「マージは成功を
返したがファイルが期待どおりでない」ケース（並行書き込みによる置き換えなど）も同時に捕まえる
ためである。

```bash
if [[ "$RUNNER_ENGINE" == "claude" ]]; then
  ...既存の注入ブロック（変更なし）...

  # 注入が実際に効いたか読み直して検証する。設計ペイン (standby / superpowers) は
  # CLI フラグを持たないため、ここが唯一の防壁になる。失敗を警告だけで通すと
  # permission prompt で停止し、status も通知も出ないままディスパッチが止まる。
  INJECTED_DEFAULT_MODE=$(jq -r '.permissions.defaultMode // ""' \
    "$CWD/.claude/settings.local.json" 2>/dev/null || echo "")
  if [[ "$INJECTED_DEFAULT_MODE" != "bypassPermissions" ]]; then
    log "warn" "bypassPermissions injection did not land in $CWD/.claude/settings.local.json; falling back to --dangerously-skip-permissions"
    SKIP_PERMISSIONS=1
  fi

  ensure_claude_exclusions || true
fi
```

`SKIP_PERMISSIONS` が消費されるのは 745 行なので、569 行台で立てた値は正しく反映される。

### 変更 2: superpowers 分岐を `CLAUDE_EXTRA_FLAGS` に切り替える (`launch-workspace.sh`)

変更 1 だけでは `superpowers` MODE にフォールバックが届かない。claude engine の各分岐が使う
変数は以下のとおりで、`superpowers` だけが権限フラグを含まない `CLAUDE_MODEL_FLAGS` を見ている:

| MODE | 現在使っている変数 | 権限フラグが届くか |
|------|------------------|------------------|
| `execute` | `CLAUDE_EXTRA_FLAGS` | 届く |
| `standby` / `review` | `CLAUDE_EXTRA_FLAGS` | 届く |
| `superpowers` | `CLAUDE_MODEL_FLAGS` | **届かない** |
| `plan` | フラグをリテラルで常時付与 | 届く（元から安全） |

`superpowers` 分岐を `CLAUDE_EXTRA_FLAGS` に変える。

```bash
elif [[ "$MODE" == "superpowers" ]]; then
  CORE_CMD="$RUNNER_COMMAND${CLAUDE_EXTRA_FLAGS:+ $CLAUDE_EXTRA_FLAGS} '$PROMPT_TEXT'"
```

`CLAUDE_EXTRA_FLAGS` は `CLAUDE_MODEL_FLAGS` に権限フラグを **足しただけ** の変数なので、
`SKIP_PERMISSIONS=0` のとき両者は文字列として等しい。したがって正常系の composed command は
従来と完全に同一で、既存テスト P6（superpowers にフラグを足さない）はそのまま green のままになる。

副作用として、`--mode superpowers` に明示的に `--skip-permissions` を渡した場合にフラグが
効くようになる。現状これを渡す呼び出し元は存在せず、明示指定を尊重する方向の変更なので許容する。

### 変更 3: 回帰テストを新設する

`test/test-prewarm-design-permissions.sh` を追加し、既存ハーネス様式
（PATH 上の `cmux` スタブ + `RUNNERS_CONFIG_PATH` + agmsg スタブ）に従う。
`prewarm-panes.sh` は **実物の** `launch-workspace.sh` を呼ばせ、生成された runner script と
worktree の `settings.local.json` を突き合わせる end-to-end 検証にする。

| id | 内容 |
|----|------|
| PD1 | prewarm の claude 設計ペイン: worktree に `defaultMode: bypassPermissions` が載る |
| PD2 | 同上・正常系: composed command に `--dangerously-skip-permissions` が **付かない**（従来どおり） |
| PD3 | 注入不能時の claude 設計ペイン (`standby`): composed command にフラグが **付く** |
| PD4 | 注入不能時の `superpowers`: composed command にフラグが **付く**（変更 2 の担保） |
| PD5 | prewarm の codex 設計ペイン: `--dangerously-bypass-approvals-and-sandbox` を持ち、`.claude/settings.local.json` を書かない |
| PD6 | claude executor は従来どおり `--dangerously-skip-permissions` を持つ（非対称の明示） |

注入不能状態は `$CWD/.claude` を **ディレクトリではなく通常ファイル** にして作る。
`merge_claude_settings` の `mkdir -p` が失敗し、読み直しも空になるので決定的に再現でき、
`chmod` と違って root 実行でも成立する。

テスト作成上の必須事項:

- `prewarm-panes.sh` を呼ぶケースは **worktree ディレクトリを事前に `mkdir -p` する**。
  未作成のまま渡すと `git worktree add` が実リポジトリに対して走り、ブランチと worktree 登録を
  残す（この repo で 2 回発生している事故）。
- 否定アサーション（PD2）は、grep する runner script が **実在することを先に確認する**。
  ファイルが無いから通る否定アサーションは欠陥であってテストではない。

### 変更 4: ドキュメント 4 ファイルを同期する

挙動が変わるので `CLAUDE.md` のハードルールに従い 4 ファイルすべてを同じ commit で更新する。

| ファイル | 変更内容 |
|---------|---------|
| `skills/cmux-team-dispatch-task/SKILL.md` | 注入の説明に fail-closed フォールバックの 1 段落を追加。engine × MODE 表の `claude / superpowers` 行を `[--dangerously-skip-permissions]` （注入失敗時のみ）に更新。**英語のみ** |
| `skills/cmux-team-dispatch-task/references/guide-ja.md` | SKILL.md と 1:1 対応する節を同内容で更新 |
| `README.md` | 利用者向けに「注入が失敗した場合はフラグへ自動フォールバックする」を追記 |
| `CLAUDE.md` | メンテナンス手順 25 に検証項目（フォールバックと新テスト）を追加 |

## 非目標

- codex 経路には手を入れない。調査で bypass 済みであることを確認済みで、既存テスト T4 が担保している。
- `--dangerously-skip-permissions` を設計ペインへ無条件付与しない。965a045 で意図的に決めた
  「superpowers にフラグを付けない」方針を、正常系では維持する。
- `skipDangerousModePermissionPrompt`（bypass モード突入確認ダイアログ）の扱いは変更しない。
  ユーザー設定 `~/.claude/settings.json` に置く必要がある旨は既に文書化されている。
- バージョン番号を上げない。push も PR 作成もしない（Wait-and-merge）。

## 影響範囲と後方互換

- 正常系（注入が成功する通常のディスパッチ）では composed command・settings ファイル・
  ペイン配置のいずれも変化しない。既存テスト P1〜P11、T1〜T15、PG1〜PG3 はすべて green のまま。
- 変化するのは「注入が失敗した」異常系だけで、そこでは従来ハングしていたペインが
  bypass 付きで起動するようになる。
- シェルは bash 3.2 互換を維持する（新規の配列展開は導入しない）。

## 検証

```
cd apps/cmux-team-dispatch-task
for t in test/*.sh; do printf '%-46s ' "$t"; if bash "$t" >/dev/null 2>&1; then echo OK; else echo FAILED; fi; done
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins && pnpm check
```

全スイート green かつ `check-doc-lang` が OK であること。`@tanaka-yui/token-meter` の
`noNonNullAssertion` 警告 4 件は既知のノイズ。

テスト実行後に残留物が無いことも確認する:

```
git worktree list
git branch --list 'feat/pd*'
```
