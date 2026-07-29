# SKILL.md 英語化と日本語訳分離ルールの厳格化 + cmux-team 廃止の設計

対象: リポジトリ全体（`origin/main` = `1ba545c`）

## 1. 背景

`apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md` は 2385 行のうち 238 行に日本語が混在している。散文の解説だけでなく、AskUserQuestion の質問文・選択肢ラベルといった**ユーザーへ直接表示されるリテラル文字列**も日本語で書かれており、英語の手順書のなかに日本語が断片的に差し込まれた状態になっている。

同じ状態が他の skill にも広がっている。日本語混在の SKILL.md は 11 ファイル中 9 ファイル（`e2e-test` は完全英語、`dev-up` はほぼ英語）。

ルートの `CLAUDE.md` には「ドキュメント・コメント・コミットメッセージ・PR 本文は日本語 / コード（変数名・関数名・関数引数・CLI フラグ）は英語」という規約しかなく、**SKILL.md を英語で書く規約は存在しない**。規約が無いため混在が発生し、今後も再発する。

日本語リファレンスは `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md`（1490 行）に 1 つだけ存在するが、SKILL.md の逐語訳ではなく独自構成の「利用ガイド」であり、対応関係が追えない（見出し数 102 対 65）。

## 2. ゴール

1. Claude 向け指示文書（SKILL.md / references / commands）を英語に統一する。
2. 日本語訳を `*-ja.md` に分離し、SKILL.md と 1:1 対応させる。
3. 規約を `CLAUDE.md` に明文化し、**機械的に検証可能**にして次回以降の再発を防ぐ。
4. 併せて `apps/cmux-team` プラグインを廃止する。

## 3. 決定事項

ブレスト中に確定した選択。

| # | 論点 | 決定 |
|---|------|------|
| D1 | 作業スコープ | 日本語混在の全 skill を一括対応 |
| D2 | `guide-ja.md` の位置づけ | SKILL.md と**見出し対応の逐語訳ミラー**。既存の独自解説は巻末 `## 補足` へ退避 |
| D3 | ルールの強制手段 | `CLAUDE.md` への明文化 **+ 検証スクリプト**を `pnpm check` に統合 |
| D4 | 英語必須の適用範囲 | `SKILL.md` 本文 / `references/` 配下の他 md / `commands/*.md`。frontmatter `description` は**対象外**（日本語トリガー語を保持するため） |
| D5 | ユーザー向け日本語リテラル | 英語化する。代わりに各 SKILL.md 冒頭へ `## Output Language` ブロックを置き、表示は日本語で行うことを明示する |
| D6 | `apps/cmux-team` | プラグイン一式を削除（skill だけでなく daemon / CLI / commands / templates / docs を含む） |

## 4. 言語ルール（`CLAUDE.md` に追記する内容）

### 4.1 ファイル種別ごとの言語

| ファイル | 言語 | 日本語訳 | 訳の要否 |
|---------|------|---------|---------|
| `skills/*/SKILL.md` 本文 | **英語必須** | `skills/*/references/guide-ja.md` | **必須** |
| `skills/*/SKILL.md` frontmatter `description` | 日本語可 | — | — （起動トリガー語のため対象外） |
| `references/<name>.md` | **英語必須** | `references/<name>-ja.md` | 任意（必要なときだけ作る） |
| `references/*-ja.md` | 日本語 | 自身が訳 | — |
| `commands/*.md` | **英語必須** | — | 作らない（内容は SKILL.md に集約） |
| `CLAUDE.md` / `README.md` / コミットメッセージ / PR 本文 | 日本語（現状維持） | — | — |

一般化した 1 行ルール: **`*-ja.md` 以外の Claude 向け指示文書に日本語文字を書かない。**

訳の要否が SKILL.md だけ必須なのは、SKILL.md が skill の仕様そのものであり日本語話者が読めない状態を許容できないため。`references/` 配下は補助資料なので、日本語で読みたい needs が生じたときに `<name>-ja.md` を追加すればよい。

`description` を対象外にする理由: この field は Claude が skill を起動するかどうかの判定に使われる。日本語で話しかけたときの発火率を落とさないため、日本語のトリガー語を残す。

### 4.2 `## Output Language` ブロック

各 SKILL.md の冒頭（frontmatter 直後）に置く。

```markdown
## Output Language

All user-facing questions, option labels, tables, and progress reports MUST be
rendered in Japanese. This file is written in English for consistency; it does
not change the language presented to the user.
```

これにより「本文は英語 / 表示は日本語」を両立させる。

### 4.3 `guide-ja.md` の構造

SKILL.md と見出しを 1:1 対応させる。

```markdown
# <SKILL.md の H1 の訳>

## Output Language の訳
## <H2 の訳>
### <H3 の訳>
...

---

## 補足（SKILL.md に対応セクションなし）

### 基本的な呼び出し例
```

SKILL.md 側に対応セクションが無い独自解説はすべて末尾の `## 補足` にまとめる。これにより「見出しが対応していれば同期済み」と目視で判定できる。

## 5. 検証スクリプト `scripts/check-doc-lang.mjs`

Node の素の ESM で実装する（依存ゼロ）。`engines.node` は 24.14 なので追加ランタイムは不要。

### 5.1 チェック内容

| # | チェック | 失敗条件 |
|---|---------|---------|
| A | 日本語混入 | 対象ファイルの **frontmatter を除いた本文**にひらがな / カタカナ / 漢字が出現する |
| B | 訳の存在 | `SKILL.md` に対応する `references/guide-ja.md` が存在しない |
| C | 訳の中身 | `*-ja.md` に日本語が 1 文字も含まれない（訳し忘れ・空ファイルの検出） |

### 5.2 対象ファイル

```
apps/*/skills/*/SKILL.md
apps/*/skills/*/references/**/*.md
apps/*/references/**/*.md
apps/*/commands/*.md
```

チェック A の除外: `*-ja.md`。

### 5.3 日本語の判定

正規表現 `/[぀-ゟ゠-ヿ㐀-䶿一-鿿豈-﫿]/u`（ひらがな / カタカナ / CJK 統合漢字 / 拡張 A / 互換漢字）。全角記号（`、` `。` `？`）は漢字レンジ外だが、それらは必ず日本語文と共に現れるため追加しない。

### 5.4 frontmatter の除外

ファイル先頭が `---` で始まる場合、次の `---` 行までをスキップする。これにより `description` の日本語が誤検出されない。

### 5.5 出力

違反を `<file>:<line>: <理由>` 形式で全件列挙し、1 件でもあれば exit 1。修正作業中に残件を一覧できるようにする。

### 5.6 組み込み

`apps` 配下で `package.json` を持つのは `token-meter` と `codex-bridge` の 2 つだけになる（cmux-team 削除後）。ドキュメント検証はリポジトリ横断のため turbo タスクにせず、ルートの script に直結する。

```json
"check": "turbo run check && node scripts/check-doc-lang.mjs",
"check:doc-lang": "node scripts/check-doc-lang.mjs"
```

turbo は既定でルートパッケージの task を実行しない（`//#check` を定義していない）ため、再帰は起きない。

## 6. `apps/cmux-team` の廃止

### 6.1 削除するもの

`apps/cmux-team/` 一式。

```
apps/cmux-team/
├── src/               20 ファイル（daemon.ts, conductor.ts, master.ts, dashboard.tsx …）
├── bin/cmux-team.ts   CLI エントリ
├── commands/          master.md, team-task.md, team-spec.md, team-archive.md
├── skills/            cmux-team, cmux-agent-role
├── templates/         13 ファイル
├── docs/              research / seeds / slides
├── package.json       pnpm workspace + turbo のメンバー
├── tsconfig.json
├── .claude-plugin/plugin.json
├── .codex-plugin/plugin.json
└── CLAUDE.md, README.md
```

### 6.2 参照を除去するファイル

| ファイル | 該当箇所 |
|---------|---------|
| `.claude-plugin/marketplace.json` | `cmux-team` エントリを削除 |
| `.agents/plugins/marketplace.json` | 同上（32〜35 行） |
| `install.sh` | 21 行 `claude plugin install cmux-team@yui-cc-plugins` |
| `CLAUDE.md`（ルート） | 8 箇所: Apps 表 / テスト節の `cd apps/cmux-team && bun test` / Tooling rules / Plugin-specific guidance |
| `README.md` | 3 箇所 |
| `AGENTS.md` | 3 箇所（7 / 10 / 31 行） |
| `apps/cmux-using/CLAUDE.md` | 3 箇所（関連プラグインとの境界表） |
| `apps/cmux-using/README.md` | 2 箇所 |
| `apps/cmux-team-dispatch-task/CLAUDE.md` | 2 箇所（関連プラグインとの境界表） |
| `apps/codex-bridge/CLAUDE.md` | 1 箇所 |
| `apps/token-meter/CLAUDE.md` | 1 箇所 |
| `pnpm-lock.yaml` | `pnpm install` で再生成 |

`pnpm-workspace.yaml` は `apps/*` の glob なので変更不要。

### 6.3 触らないもの

`docs/superpowers/plans/` `docs/superpowers/specs/` `.claude/plans/` `.superpowers/sdd/` `.git/sdd/` に含まれる cmux-team への言及は、過去の設計記録として保持する。書き換えると当時の判断の履歴が失われるため。

### 6.4 既存インストールの扱い

`install.sh` は uninstall を行わないため、ローカルへインストール済みの環境では `claude plugin uninstall cmux-team@yui-cc-plugins` の手動実行が必要になる。ルート `README.md` の該当箇所に注記を 1 行入れる。

## 7. 対象ファイル一覧（cmux-team 削除後）

### 7.1 SKILL.md（11 ファイル）

| skill | SKILL.md 行数 | guide-ja.md |
|-------|-------------:|-------------|
| `cmux-team-dispatch-task` | 2385 | 既存 1490 行 → ミラー再編 |
| `cmux-using` | 328 | 新規 |
| `dev-up` | 112 | 新規 |
| `codex-review` | 106 | 新規 |
| `token-report` | 81 | 新規 |
| `e2e-test` | 77 | 新規 |
| `codex-exec` | 44 | 新規 |
| `token-measure` | 43 | 新規 |
| `token-plugins` | 38 | 新規 |
| `token-stats` | 32 | 新規 |
| `token-clear` | 29 | 新規 |

`e2e-test` と `dev-up` は既に英語のため、作業は `guide-ja.md` の新規作成と `## Output Language` ブロックの追加のみ。

### 7.2 references（1 ファイル）

`apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/loop-mode.md`（112 行、うち 78 行が日本語）を英語化し、`loop-mode-ja.md` を新規作成する。

`references/unattended/*.md` 4 ファイルは日本語ゼロのため対象外。`apps/dev-up/references/setup-guide.md`（123 行）も日本語ゼロだが、`setup-guide-ja.md` は作らない（チェック B は SKILL.md にのみ適用するため必須ではない）。

### 7.3 commands（6 ファイル）

| ファイル | 行数 | 日本語行 |
|---------|-----:|--------:|
| `apps/cmux-codex-review/commands/codex-review.md` | 114 | 57 |
| `apps/cmux-codex-exec/commands/codex-exec.md` | 88 | 37 |
| `apps/cmux-using/commands/cmux.md` | 68 | 31 |
| `apps/codex-bridge/commands/codex-bridge.md` | 27 | 8 |
| `apps/cmux-using/commands/cfork.md` | 9 | 3 |
| `apps/cmux-fork/commands/cfork.md` | 8 | 2 |

## 8. 実行順序と検証

```
0. apps/cmux-team 廃止 + 参照除去
   → verify: pnpm install && pnpm check が緑 / bash install.sh が完走

1. ルート CLAUDE.md にルール追記 + scripts/check-doc-lang.mjs 作成
   → verify: node scripts/check-doc-lang.mjs が違反一覧を出力する（この時点では exit 1）

2. token-meter 5 件 → codex-exec / codex-review → e2e-test / dev-up
   → verify: skill 単位で該当ファイルの違反が消える

3. cmux-using
   → verify: 同上

4. cmux-team-dispatch-task（SKILL.md + loop-mode.md + guide-ja.md 再編）
   → verify: checker 緑 + apps/cmux-team-dispatch-task/test/*.sh 11 本が全通過

5. commands/*.md 6 件
   → verify: pnpm check 緑（checker を含む）

6. 各 app の CLAUDE.md にルール参照を追加
   + apps/cmux-team-dispatch-task/CLAUDE.md の guide-ja.md 節名参照を新構造へ更新
   → verify: bash install.sh 後に各 skill が発火する
```

cmux-team の削除を先頭に置く理由は、対象ファイルが 13 skill から 11 skill へ減り、以降の全ステップの作業量と検証対象が縮むため。

## 9. リスクと対処

### 9.1 dispatch-task の 4 ファイル整合規約

`apps/cmux-team-dispatch-task/CLAUDE.md` は SKILL.md / guide-ja.md / README.md / CLAUDE.md の完全一致を要求し、メンテナンス手順 23 項目のうち複数が `guide-ja.md「子セッション runner 設定」節` のように**節名を直接参照**している（項目 6 / 10 ほか）。guide-ja.md をミラー構造へ再編すると節名が変わるため、これらの参照を同時に更新する。

### 9.2 UI 文字列の表示揺れ

英語ラベルから日本語表示への変換は `## Output Language` ブロック頼みになる。Display Format Conventions の Template A/B/C は既に英語ヘッダなので影響しないが、AskUserQuestion の選択肢ラベルは揺れる可能性がある。dispatch-task の E2E で Step 1f の switch 質問が日本語で表示されることを確認する。

### 9.3 翻訳による意味劣化

Step 1f / 1g のモデル選択フローには微妙なニュアンスが含まれる（`design_runner` の「未設定」と明示 `"ask"` の区別、「常に〜」の永続化が 2 系統ある点など）。英語化でこれを落とさないよう、guide-ja.md 側に原文の日本語表現を保持する。

### 9.4 チェック A の誤検出

コード例やサンプル出力に日本語を含めたくなるケースがありうる。本設計では例外を設けず、サンプルも英語で書く。日本語のサンプルが必要な場合は guide-ja.md 側に置く。

## 10. 成功基準

1. `node scripts/check-doc-lang.mjs` が exit 0。
2. `pnpm check` が緑。
3. `apps/cmux-team-dispatch-task/test/*.sh` 11 本が全通過。
4. `bash install.sh` が cmux-team を要求せず完走し、各 skill が発火する。
5. ルート `CLAUDE.md` に 4.1 の表が記載されている。
