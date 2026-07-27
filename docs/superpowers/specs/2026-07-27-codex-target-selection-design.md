# codex-review / codex-exec のレビュー・実装対象を確定させる

## 背景と問題

`cmux-codex-review` はレビュー対象のデフォルトが未コミット変更（`TARGET="uncommitted"`）、
`cmux-codex-exec` は plan を `ls -t docs/superpowers/plans/*.md | head -1` の mtime 最新で
無言採用している。この既定は「実装 → その場でレビュー」の流れでは正しいが、
superpowers の brainstorming フローとは噛み合わない。

brainstorming は設計文書を書いた直後に **git commit する**。そのため spec を codex に
レビューさせたくて `/codex-review` を打っても、未コミット差分は空か無関係な残骸になり、
レビュー対象がズレる。現状の bin には特定ファイルを対象にする手段がない（`--base` と
`--commit` のみで、どちらも差分レビュー）。

`codex-exec` 側は plan が複数あるとき mtime 最新が意図した plan とは限らず、
何が選ばれたかはペイン起動後の出力でしか分からない。exec の誤爆はリポジトリの
書き換えを伴うため、review より代償が大きい。

## 方針

引数で対象が明示されていないときだけ、bin が候補を列挙し、コマンド層（LLM）が
ユーザーに確認する。引数を明示した場合と `!` による bin 直接実行の軽さは維持する。

- 候補列挙は **bin の `--list-targets`** が担う（決定的でテスト可能にするため）
- 確認（ask）は **コマンド層**が担う（bin は対話しない）
- 候補が1件のとき: review は自動採用、exec は必ず確認（誤爆コストの非対称性）

## 設計

### 1. `bin/cmux-codex-review`

#### 新オプション `--path <file>`（繰り返し可）

`TARGET="path"` を追加する。差分ではなく **ファイル内容の全文レビュー**を指示する:

```
ファイル docs/superpowers/specs/x-design.md, docs/superpowers/plans/x-plan.md を読み、
内容をレビューし、問題点・改善点を具体的に指摘せよ。
```

spec / plan は「差分が妥当か」ではなく「文書として妥当か」を見てほしいので、
commit 単位の差分レビューより意図に合う。コミット済み・未コミットを問わず同じ扱いになる。

起動前に各パスを `[[ -f ]]` で検証し、存在しなければ非ゼロ終了する（codex の空振り防止）。
パスは既存の `REVIEW_INSTR_ESC`（`'\''` エスケープ）経路に乗るため引用符崩れは起きない。

`--uncommitted`（既定）/ `--base` / `--commit` は現状維持。

#### 新モード `--list-targets`

候補を列挙して exit する。ペイン分割せず、`CMUX_SOCKET_PATH` チェックも通さない
（cmux 外でも列挙でき、テストが容易になる）。出力は 1 行 1 候補の TSV:

```
target	uncommitted		未コミット変更 (3 files)
target	path	docs/superpowers/specs/2026-07-27-foo-design.md	spec / committed / 07-27 14:02
target	path	docs/superpowers/plans/2026-07-27-foo-plan.md	plan / untracked / 07-27 14:20
```

列は `target<TAB>kind<TAB>value<TAB>label`。`kind` は `uncommitted` か `path`。

- `uncommitted`: `git status --porcelain` が非空のときのみ出力。label のファイル数は同コマンドの行数
- `path`: `docs/superpowers/specs/*.md` と `docs/superpowers/plans/*.md` を
  それぞれ mtime 降順で最大 3 件
- コミット状態は 2 段で判定する:
  `git ls-files --error-unmatch <f>` が失敗 → `untracked` /
  成功しかつ `git diff --quiet HEAD -- <f>` が成功 → `committed` / それ以外 → `modified`
- 候補ゼロなら何も出力せず exit 0

### 2. `bin/cmux-codex-exec`

`--list-targets` のみ追加する。`docs/superpowers/plans/*.md` を mtime 降順で最大 3 件、
review と同じ TSV 形式（`kind` は `plan`）で出力する。

plan 無指定時の mtime 最新フォールバックは**残す**。`!` での直接実行の軽さを壊さないためで、
確認はコマンド層の責務とする。

### 3. `commands/codex-review.md` — Step 0「対象確定」

既存 Step 1（agmsg identity）の前に挿入する。

1. `$ARGUMENTS` に `--uncommitted` / `--base` / `--commit` / `--path` のいずれかが含まれる
   → ask せず従来フローへ
2. 含まれない → `bin/cmux-codex-review --list-targets` を実行
   - **0 件**: 「レビュー対象が検出できませんでした」とし、パスかブランチをユーザーに尋ねる
   - **1 件**: 自動採用し、起動サマリに対象を出すだけ
   - **2 件以上**: AskUserQuestion で単一選択

AskUserQuestion は最大 4 択なので、次の優先順で 4 枠に詰め、残りは Other（自由入力）に任せる:

| 枠 | 内容 |
|----|------|
| 1 | 未コミット変更（候補にあれば） |
| 2 | spec 最新（`docs/superpowers/specs/` の先頭） |
| 3 | plan 最新（`docs/superpowers/plans/` の先頭） |
| 4 | spec + plan をまとめて（両方あるときだけ。`--path a --path b` に変換） |

multiSelect は使わない。bin の `TARGET` は単一なので「未コミット + path」の混在は作れず、
選択肢を排他にした方が破綻しない。複数ファイルのレビューは枠 4 に畳む。

`--list-targets` は spec / plan を各 3 件まで返すが、選択肢に載るのは各先頭 1 件だけである。
残りは「Other を選んだユーザーに提示する候補」として質問文または直後の会話で示す。

3. 確定した対象を bin 引数（`--path <f>...` / `--base <branch>` / `--commit <sha>`）に変換し、
   既存の Step 1 → Step 2 へ進む

### 4. `commands/codex-exec.md` — Step 0「plan 確定」

1. `$ARGUMENTS` に plan パスがある → そのまま従来フローへ
2. 無い → `bin/cmux-codex-exec --list-targets`
   - **0 件**: 「plan が見つかりません」としてパスをユーザーに尋ねる
   - **1 件以上**: 候補が 1 件でも必ず AskUserQuestion で確認する（上位 3 件 + Other）
3. 確定した plan を明示的に `bin/cmux-codex-exec <plan>` へ渡す（mtime フォールバックに委ねない）

### 5. 両 `SKILL.md`

実行手順の先頭に「Step 0: 対象確定（引数無指定時は `--list-targets` → ask）」を 1 段落追記し、
詳細はコマンド側を参照させる（既存の書き方を踏襲）。引数表に `--path` と `--list-targets` を追加する。

## テスト

### `apps/cmux-codex-review/test/test-cmux-codex-review.sh` に追加

既存の「`cmux send` が送る文字列をペインのシェルと同じく再パースして codex の実引数を検証する」
流儀を踏襲する。

- **D6**: `--path a.md --path b.md` → prompt がちょうど 1 引数で、両パスが無傷で含まれる
- **D7**: 存在しない `--path` は非ゼロ終了し、`cmux new-split` を呼ばない
- **D8**: `--list-targets` は `CMUX_SOCKET_PATH` 未設定でも動き、cmux stub を一切呼ばず TSV を出す。
  一時 git リポジトリに specs / plans の md を置き、片方を commit・片方を未コミットにして
  `committed` / `untracked` ラベルを検証する

### `apps/cmux-codex-exec/test/test-cmux-codex-exec.sh` を新設

- `--list-targets` が `docs/superpowers/plans/*.md` を mtime 降順で出す
- plan を明示指定したとき prompt が 1 引数で codex に届く（`'\''` エスケープの回帰防止）

## ドキュメント

- `apps/cmux-codex-review/{README.md,CLAUDE.md}`: デフォルト表に `--path`、動作セクションに Step 0、
  不変条件 D6–D8 を追記
- `apps/cmux-codex-exec/{README.md,CLAUDE.md}`: 同様の追記 + テストセクション新設
- ルート `CLAUDE.md` / `marketplace.json` の説明文は挙動の主旨が変わらないので据え置き

## バージョン

機能追加のため minor bump。`.claude-plugin/plugin.json` / `.codex-plugin/plugin.json` /
ルート `marketplace.json` の 3 か所を同期する。

| プラグイン | 現在 | 新 |
|---|---|---|
| cmux-codex-review | 1.2.0 | 1.3.0 |
| cmux-codex-exec | 1.1.0 | 1.2.0 |

## スコープ外

- 前回のレビュー対象を記憶する永続化
- `specs/` `plans/` 以外の探索ディレクトリを設定可能にする
- `--path` のグロブ展開（シェルに任せる）
