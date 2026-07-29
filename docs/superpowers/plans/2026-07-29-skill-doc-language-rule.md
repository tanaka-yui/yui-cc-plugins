# SKILL.md 英語化と日本語訳分離ルールの厳格化 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `apps/cmux-team` プラグインを廃止し、残る全 skill の SKILL.md / references / commands を英語へ統一したうえで、日本語訳を `*-ja.md` に分離するルールを `CLAUDE.md` と検証スクリプトで強制する。

**Architecture:** ルート直下に依存ゼロの Node スクリプト `scripts/check-doc-lang.mjs` を置き、`apps/` 配下の Claude 向け指示文書を走査して「日本語混入」「訳の欠落」「訳の空実装」を検出する。純関数を export してテスト可能にし、CLI としても動く二面構成にする。翻訳作業はこのスクリプトを回帰テストとして使い、skill 単位で緑にしていく。

**Tech Stack:** Node 24+ 組み込み ESM / `node:test` + `node:assert`（依存追加なし）/ pnpm 10.33 / turbo 2.8 / biome 2.4.9

設計ドキュメント: `docs/superpowers/specs/2026-07-29-skill-doc-language-rule-design.md`

---

## Global Constraints

これらは全タスクの要件に暗黙的に含まれる。

- **言語ルール（本計画が導入する規約そのもの）:**
  - `skills/*/SKILL.md` 本文 → **英語必須**。日本語訳は `skills/*/references/guide-ja.md` に**必須**で置く。
  - `skills/*/SKILL.md` の frontmatter `description` → **日本語可**（起動トリガー語のため検証対象外）。
  - `references/<name>.md` → **英語必須**。訳が必要なら `references/<name>-ja.md`（任意）。
  - `references/*-ja.md` → 日本語。
  - `commands/*.md` → **英語必須**。訳は作らない。
  - `CLAUDE.md` / `README.md` / コミットメッセージ / PR 本文 → 日本語（現状維持）。
  - 一行ルール: **`*-ja.md` 以外の Claude 向け指示文書に日本語文字を書かない。**
- **`## Output Language` ブロック:** 英語化する全 SKILL.md の frontmatter 直後に、以下を**一字一句このまま**挿入する。

  ```markdown
  ## Output Language

  All user-facing questions, option labels, tables, and progress reports MUST be
  rendered in Japanese. This file is written in English for consistency; it does
  not change the language presented to the user.
  ```

- **`guide-ja.md` の構造:** SKILL.md と見出しを 1:1 対応させる。SKILL.md に対応セクションが無い独自解説は、ファイル末尾の `---` の後に `## 補足（SKILL.md に対応セクションなし）` を置いてそこへ集める。
- **英語化の変換規則（全翻訳タスク共通）:** SKILL.md を英語化するときは必ず次の 5 つを守る。

  1. frontmatter は変更しない（`description` は日本語可）。
  2. frontmatter 直後に上記の `## Output Language` ブロックを一字一句そのまま挿入する。
  3. 本文の見出し・散文・表のセル・コード例中のコメントをすべて英語にする。コマンド名・パス・フラグ・JSON キー・環境変数名・モデル名・シグナル名はそのまま残す。
  4. `references/guide-ja.md` を作り、英語化後の SKILL.md の見出しを 1:1 で日本語訳する。本文は**変更前の日本語をそのまま流用**する（訳し直さない）。`## Output Language` の訳は次を使う:

     ```markdown
     ## Output Language

     ユーザーへの質問・選択肢ラベル・表・進捗報告はすべて日本語で表示する。SKILL.md 本文が英語なのは記述の統一のためであり、ユーザーへの提示言語は変えない。
     ```

  5. 元の SKILL.md に無い解説を追加しない。情報を削らない。

- **検証コマンドは `node scripts/check-doc-lang.mjs <path...>` を直接使う。** `pnpm check:doc-lang` は引数なしの全体検査用。パス指定の絞り込みでは、パッケージマネージャの引数転送に依存しないよう `node` を直接呼ぶ。
- **日本語判定の範囲は設計書 §5.3 から意図的に拡張している。** 設計書はひらがな / カタカナ / 漢字のみを挙げているが、実装では CJK 記号・句読点ブロック（`、` `。` `「` `」` など、U+3001–U+303F）も検出対象に含める。英語化のやり残しとして日本語の句読点だけが行に残るケースを拾うため。Box drawing（U+2500–U+257F）と矢印（U+2190–U+21FF）は範囲外なので Template A/B/C の罫線は誤検出しない。
- **コミットメッセージ:** 日本語。Conventional Commit 形式（`feat(scope): ...` / `docs(scope): ...` / `chore(scope): ...`）。
- **Node バージョン:** `package.json` の `engines.node` は `24.14.1`。`node --test` と `node:test` はこのバージョンで利用可能。依存パッケージは追加しない。
- **biome:** `lineWidth: 120`, `indentStyle: space`, `indentWidth: 2`, JS/TS は single quote, `semicolons: asNeeded`。`scripts/*.mjs` もこの設定に従う。
- **`apps/cmux-remote` は存在しない。** ルート `CLAUDE.md` と `AGENTS.md` に記述が残っているが本計画の対象外。触らない（Task 1 で cmux-team の行だけ消し、cmux-remote の行は残す）。

---

## File Structure

### 新規作成

| ファイル | 責務 |
|---------|------|
| `scripts/check-doc-lang.mjs` | 言語ルールの検証。純関数の export + CLI エントリ |
| `scripts/check-doc-lang.test.mjs` | 上記の `node:test` テスト。fixture は `fs.mkdtemp` で一時生成 |
| `apps/*/skills/*/references/guide-ja.md` | 各 skill の日本語訳（10 ファイル新規 + dispatch-task は既存を再編） |
| `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/loop-mode-ja.md` | `loop-mode.md` の日本語訳 |

### 削除

| パス | 理由 |
|-----|------|
| `apps/cmux-team/` 一式 | プラグイン廃止 |

### 変更

| ファイル | 変更内容 |
|---------|---------|
| `package.json`（ルート） | `check:doc-lang` script 追加、`check` に連結 |
| `CLAUDE.md`（ルート） | 言語ルールの表を追加。cmux-team 参照 8 箇所を除去 |
| `README.md` / `AGENTS.md` / `install.sh` / 両 `marketplace.json` | cmux-team 参照を除去 |
| `apps/*/skills/*/SKILL.md` 11 ファイル | 英語化 + `## Output Language` 挿入 |
| `apps/*/commands/*.md` 6 ファイル | 英語化 |
| `apps/cmux-team-dispatch-task/skills/.../references/loop-mode.md` | 英語化 |
| `apps/*/CLAUDE.md` | 言語ルールへの参照を追加。cmux-team 参照を除去 |

### 責務の分離

`check-doc-lang.mjs` は「走査（`collectTargets`）」「判定（`findJapaneseLines` / `stripFrontmatter`）」「集約（`check`）」「出力（CLI 部）」に分ける。テストは集約以下の純関数に対して書き、CLI 部はテストしない。

---

## Task 1: cmux-team プラグインの廃止

**Files:**
- Delete: `apps/cmux-team/`（ディレクトリごと）
- Modify: `.claude-plugin/marketplace.json`
- Modify: `.agents/plugins/marketplace.json:31-41`
- Modify: `install.sh:21`
- Modify: `CLAUDE.md:15,50,59-62,89,101`
- Modify: `README.md:12,40`
- Modify: `AGENTS.md:7,10,31`
- Modify: `apps/cmux-using/CLAUDE.md:38-46`
- Modify: `apps/cmux-using/README.md:28,31`
- Modify: `apps/cmux-team-dispatch-task/CLAUDE.md:56-63`
- Modify: `apps/codex-bridge/CLAUDE.md:24`
- Modify: `apps/token-meter/CLAUDE.md:57`
- Modify: `pnpm-lock.yaml`（`pnpm install` による再生成）

**Interfaces:**
- Consumes: なし（最初のタスク）
- Produces: `apps/` 配下が 9 プラグイン（`cmux-codex-exec` / `cmux-codex-review` / `cmux-fork` / `cmux-team-dispatch-task` / `cmux-using` / `codex-bridge` / `dev-up` / `e2e-test` / `token-meter`）になる。以降のタスクが扱う SKILL.md は 11 ファイル

- [ ] **Step 1: 削除前の状態を記録する**

```bash
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins
git rev-parse HEAD
find apps -name SKILL.md | sort | wc -l   # 13 が出ること
```

Expected: `13`

- [ ] **Step 2: ディレクトリを削除する**

```bash
git rm -r --quiet apps/cmux-team
find apps -name SKILL.md | sort | wc -l   # 11 になること
```

Expected: `11`

- [ ] **Step 3: `.claude-plugin/marketplace.json` から cmux-team エントリを削除する**

`plugins` 配列から以下のオブジェクトを丸ごと削除する（前後のカンマに注意）。

```json
    {
      "name": "cmux-team",
      "description": "Claude Code + cmux によるマルチエージェント開発オーケストレーション。並列サブエージェントをターミナルペインで可視化。",
      "source": "./apps/cmux-team",
      "version": "1.0.0",
      "license": "MIT",
      "category": "development",
      "tags": [
        "cmux",
        "multi-agent",
        "orchestration",
        "team"
      ]
    },
```

削除後に JSON の妥当性を確認する:

```bash
jq -e '.plugins | length == 9' .claude-plugin/marketplace.json
jq -r '.plugins[].name' .claude-plugin/marketplace.json
```

Expected: `true` が返り、一覧に `cmux-team` が含まれない（`cmux-team-dispatch-task` は残る）

- [ ] **Step 4: `.agents/plugins/marketplace.json` から cmux-team エントリを削除する**

31〜41 行目付近の以下のオブジェクトを丸ごと削除する。

```json
    {
      "name": "cmux-team",
      "source": {
        "source": "local",
        "path": "./apps/cmux-team"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Development"
    },
```

```bash
jq -e '[.plugins[].name] | index("cmux-team") == null' .agents/plugins/marketplace.json
```

Expected: `true`

- [ ] **Step 5: `install.sh` から install 行を削除する**

21 行目 `claude plugin install cmux-team@yui-cc-plugins` を削除する。

```bash
grep -c "cmux-team@" install.sh   # 1 になること（cmux-team-dispatch-task@ のみ残る）
bash -n install.sh
```

Expected: `1` が出力され、`bash -n` はエラーなし

- [ ] **Step 6: ルート `CLAUDE.md` から cmux-team を除去する**

6 箇所を編集する。

1. 15 行目の Apps 表の行を削除:
   ```
   | `apps/cmux-team` | Plugin (skill + TypeScript daemon) | TypeScript (Bun runtime) | 4層 (Master/Manager/Conductor/Agent) オーケストレーション。daemon プロセスを持つ唯一のプラグイン |
   ```
2. 50 行目 `pnpm --filter cmux-team check` を `pnpm --filter @tanaka-yui/token-meter check` に置換
3. 59〜62 行目のテストブロックを削除:
   ```
   # cmux-team (Bun)
   cd apps/cmux-team && bun test
   cd apps/cmux-team && bun test src/daemon.test.ts        # 単一ファイル
   cd apps/cmux-team && bun test --test-name-pattern='foo'  # パターン
   ```
   代わりに token-meter のテストを先頭に置く（既に記載があるならそのまま）:
   ```
   # token-meter (Bun)
   cd apps/token-meter && bun test
   ```
4. 89 行目 `cmux-team や cmux-remote/server は` → `cmux-remote/server は`
5. 101 行目の Plugin-specific guidance の行を削除:
   ```
   - `apps/cmux-team/CLAUDE.md` — 4層 (Master/Manager/Conductor/Agent) アーキテクチャ。daemon, worktree 隔離、pull 型監視の設計原則
   ```
6. ファイル全体を読み直し、残った文脈で `cmux-team`（`-dispatch-task` 無し）が 0 件であることを確認

```bash
grep -oE "cmux-team(-dispatch-task)?" CLAUDE.md | grep -cx "cmux-team" || echo 0
```

Expected: `0`

- [ ] **Step 7: `README.md` から cmux-team を除去する**

1. 12 行目 `/plugin install cmux-team@yui-cc-plugins` を削除
2. 40 行目の一覧表の行を削除:
   ```
   | cmux-team | マルチエージェント開発オーケストレーション | [README](apps/cmux-team/README.md) |
   ```
3. インストール手順のブロック（21 行目 `bash install.sh` の直後、`> **既にマーケットプレイスを登録済みの環境**` の注記の下）に、廃止プラグインの後始末を 1 行足す:
   ```markdown
   > **`cmux-team` は廃止されました。** 既にインストール済みの環境では手動で削除してください:
   > ```bash
   > claude plugin uninstall cmux-team@yui-cc-plugins
   > ```
   ```

```bash
grep -oE "cmux-team(-dispatch-task)?" README.md | grep -cx "cmux-team"
```

Expected: `1`（uninstall 案内の 1 件のみ）

- [ ] **Step 8: `AGENTS.md` から cmux-team を除去する**

1. 7 行目 → `- \`apps/cmux-fork\`, \`apps/cmux-using\`, and \`apps/cmux-team-dispatch-task\` contain plugin packages.`
2. 10 行目 `- \`apps/cmux-team/src\` contains TypeScript source and colocated \`*.test.ts\` / \`*.test.tsx\` tests.` を削除
3. 31 行目の `\`cmux-team\` currently relies on TypeScript and Biome checks; ` を削除し、文を `Place tests next to source files using \`*.test.ts\` or \`*.test.tsx\`. Client tests use Vitest, and server tests use Bun. Add focused tests for queueing, task dispatch, terminal/proxy behavior, or UI logic when changing those areas.` にする

```bash
grep -oE "cmux-team(-dispatch-task)?" AGENTS.md | grep -cx "cmux-team" || echo 0
```

Expected: `0`

- [ ] **Step 9: 各 app の CLAUDE.md / README.md から cmux-team を除去する**

`apps/cmux-using/CLAUDE.md` の 38〜46 行目「## cmux-team との境界」節を丸ごと削除する（表と「**重複を避ける**」の一文を含む）。

`apps/cmux-using/README.md` の 28 行目「## cmux-team との関係」節から cmux-team の項目（31 行目）を削除する。節に他の項目が残らない場合は節ごと削除する。

`apps/cmux-team-dispatch-task/CLAUDE.md` の「## 関連プラグインとの境界」表から `cmux-team` 列を削除し、63 行目を次のようにする:

```markdown
**重複を避ける**: cmux-using 固有の機能（基本 cmux 操作）を含めない。
```

`apps/codex-bridge/CLAUDE.md` の 24 行目を次のようにする:

```markdown
cmux 系プラグインとは責務が独立。本プラグインは「Claude 設定 → Codex 設定」の一方向変換のみを担い、cmux トポロジや実行オーケストレーションには関与しない。
```

`apps/token-meter/CLAUDE.md` の 57 行目の表の行 `| cmux-team | マルチエージェント | 無関係。同じ hook には共存可能 |` を削除する。

```bash
grep -roE "cmux-team(-dispatch-task)?" apps/ --include="*.md" | grep -c ":cmux-team$" || echo 0
```

Expected: `0`

- [ ] **Step 10: lockfile を再生成して型チェックを通す**

```bash
pnpm install
pnpm check
```

Expected: `pnpm install` が `apps/cmux-team` の importer を削除した lockfile を書き、`pnpm check` が緑

- [ ] **Step 11: コミット**

```bash
git add -A
git commit -m "chore: cmux-team プラグインを廃止

skill 2件・TypeScript daemon・CLI・commands・templates を含む
apps/cmux-team 一式を削除し、marketplace.json / install.sh /
各 CLAUDE.md / README.md / AGENTS.md の参照を除去した。
docs/superpowers/ 配下の過去 plan / spec は史料として残す。"
```

---

## Task 2: 検証スクリプト `check-doc-lang.mjs`

**Files:**
- Create: `scripts/check-doc-lang.mjs`
- Create: `scripts/check-doc-lang.test.mjs`
- Modify: `package.json`（`check:doc-lang` script の追加のみ。`check` への連結は Task 14）

**Interfaces:**
- Consumes: Task 1 の成果（`apps/` が 9 プラグイン）
- Produces:
  - `JAPANESE_RE: RegExp`
  - `stripFrontmatter(text: string) => { body: string, startLine: number }` — `startLine` は body の先頭が元ファイルの何行目か（1 始まり）
  - `findJapaneseLines(text: string) => Array<{ line: number, text: string }>` — frontmatter を除いた本文中の該当行。`line` は元ファイル基準の 1 始まり
  - `collectTargets(root: string) => string[]` — root からの相対パス。ソート済み
  - `check(root: string, filter?: string[]) => Array<{ file: string, line: number, rule: string, message: string }>` — `rule` は `'japanese-in-english-doc' | 'missing-guide-ja' | 'empty-translation'`
  - CLI: `node scripts/check-doc-lang.mjs [path...]` — 違反を `file:line: [rule] message` 形式で全件出力し、1 件でもあれば exit 1

- [ ] **Step 1: 失敗するテストを書く**

`scripts/check-doc-lang.test.mjs` を作成する。

```javascript
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { check, collectTargets, findJapaneseLines, stripFrontmatter } from './check-doc-lang.mjs'

const roots = []

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'doc-lang-'))
  roots.push(root)
  return root
}

function write(root, relPath, content) {
  const full = join(root, relPath)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content)
  return full
}

// 最小構成の skill を作る。guide-ja.md も同時に置くのでルール B/C は満たす。
function makeSkill(root, app, skill, skillBody) {
  write(root, `apps/${app}/skills/${skill}/SKILL.md`, skillBody)
  write(root, `apps/${app}/skills/${skill}/references/guide-ja.md`, '# 日本語ガイド\n')
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe('stripFrontmatter', () => {
  it('removes a leading --- block and reports the body start line', () => {
    const text = '---\nname: x\ndescription: 日本語\n---\n\n# Title\n'
    const { body, startLine } = stripFrontmatter(text)
    assert.equal(body, '\n# Title\n')
    assert.equal(startLine, 5)
  })

  it('returns the text unchanged when there is no frontmatter', () => {
    const { body, startLine } = stripFrontmatter('# Title\nbody\n')
    assert.equal(body, '# Title\nbody\n')
    assert.equal(startLine, 1)
  })

  it('returns the text unchanged when the closing --- is missing', () => {
    const text = '---\nname: x\n# Title\n'
    const { body, startLine } = stripFrontmatter(text)
    assert.equal(body, text)
    assert.equal(startLine, 1)
  })
})

describe('findJapaneseLines', () => {
  it('detects hiragana, katakana and kanji', () => {
    const hits = findJapaneseLines('one\nこれ\nカタカナ\n漢字\n')
    assert.deepEqual(
      hits.map((h) => h.line),
      [2, 3, 4],
    )
  })

  it('ignores box drawing, arrows and em dashes', () => {
    assert.deepEqual(findJapaneseLines('┌─┬─┐\na → b\nTemplate A — list\n'), [])
  })

  it('detects japanese punctuation left behind on an otherwise english line', () => {
    const hits = findJapaneseLines('run the script、then commit\n')
    assert.equal(hits.length, 1)
    assert.equal(hits[0].line, 1)
  })

  it('skips the frontmatter block', () => {
    assert.deepEqual(findJapaneseLines('---\ndescription: 日本語の説明\n---\n# Title\n'), [])
  })
})

describe('collectTargets', () => {
  it('collects SKILL.md, references, commands but not README or CLAUDE.md', () => {
    const root = makeRoot()
    makeSkill(root, 'demo', 'demo', '# Demo\n')
    write(root, 'apps/demo/skills/demo/references/loop.md', '# Loop\n')
    write(root, 'apps/demo/references/setup.md', '# Setup\n')
    write(root, 'apps/demo/commands/demo.md', '# Command\n')
    write(root, 'apps/demo/README.md', '# 日本語 README\n')
    write(root, 'apps/demo/CLAUDE.md', '# 日本語ガイド\n')

    assert.deepEqual(collectTargets(root), [
      'apps/demo/commands/demo.md',
      'apps/demo/references/setup.md',
      'apps/demo/skills/demo/SKILL.md',
      'apps/demo/skills/demo/references/guide-ja.md',
      'apps/demo/skills/demo/references/loop.md',
    ])
  })
})

describe('check', () => {
  it('reports japanese in a SKILL.md body', () => {
    const root = makeRoot()
    makeSkill(root, 'demo', 'demo', '# Demo\n\nこれは日本語です。\n')
    const violations = check(root)
    assert.equal(violations.length, 1)
    assert.equal(violations[0].file, 'apps/demo/skills/demo/SKILL.md')
    assert.equal(violations[0].line, 3)
    assert.equal(violations[0].rule, 'japanese-in-english-doc')
  })

  it('allows japanese in the frontmatter description', () => {
    const root = makeRoot()
    makeSkill(root, 'demo', 'demo', '---\nname: demo\ndescription: 日本語の説明\n---\n\n# Demo\n')
    assert.deepEqual(check(root), [])
  })

  it('reports a SKILL.md with no guide-ja.md', () => {
    const root = makeRoot()
    write(root, 'apps/demo/skills/demo/SKILL.md', '# Demo\n')
    const violations = check(root)
    assert.equal(violations.length, 1)
    assert.equal(violations[0].rule, 'missing-guide-ja')
    assert.equal(violations[0].file, 'apps/demo/skills/demo/SKILL.md')
  })

  it('reports a -ja.md that contains no japanese', () => {
    const root = makeRoot()
    write(root, 'apps/demo/skills/demo/SKILL.md', '# Demo\n')
    write(root, 'apps/demo/skills/demo/references/guide-ja.md', '# Guide\n')
    const violations = check(root)
    assert.equal(violations.length, 1)
    assert.equal(violations[0].rule, 'empty-translation')
  })

  it('does not apply the japanese rule to -ja.md files', () => {
    const root = makeRoot()
    makeSkill(root, 'demo', 'demo', '# Demo\n')
    write(root, 'apps/demo/skills/demo/references/loop-mode-ja.md', '# ループ\n\n日本語の本文。\n')
    assert.deepEqual(check(root), [])
  })

  it('reports japanese in commands and references', () => {
    const root = makeRoot()
    makeSkill(root, 'demo', 'demo', '# Demo\n')
    write(root, 'apps/demo/commands/demo.md', '# Command\n\n日本語。\n')
    write(root, 'apps/demo/skills/demo/references/loop.md', '# Loop\n\n日本語。\n')
    const files = check(root).map((v) => v.file)
    assert.deepEqual(files.sort(), [
      'apps/demo/commands/demo.md',
      'apps/demo/skills/demo/references/loop.md',
    ])
  })

  it('restricts results to the given path filter', () => {
    const root = makeRoot()
    makeSkill(root, 'a', 'a', '# A\n\n日本語。\n')
    makeSkill(root, 'b', 'b', '# B\n\n日本語。\n')
    const violations = check(root, ['apps/a'])
    assert.equal(violations.length, 1)
    assert.equal(violations[0].file, 'apps/a/skills/a/SKILL.md')
  })

  it('returns an empty array for a clean tree', () => {
    const root = makeRoot()
    makeSkill(root, 'demo', 'demo', '# Demo\n\nAll english here.\n')
    write(root, 'apps/demo/commands/demo.md', '# Command\n')
    assert.deepEqual(check(root), [])
  })
})
```

- [ ] **Step 2: テストが失敗することを確認する**

```bash
node --test scripts/check-doc-lang.test.mjs
```

Expected: FAIL。`Cannot find module '.../scripts/check-doc-lang.mjs'` で全テストがエラーになる

- [ ] **Step 3: 検証スクリプトを実装する**

`scripts/check-doc-lang.mjs` を作成する。

```javascript
#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

// ひらがな / カタカナ / CJK 記号・句読点 / CJK 統合漢字 / 拡張 A / 互換漢字。
// Box drawing (U+2500-257F) と矢印 (U+2190-21FF) は範囲外なので誤検出しない。
export const JAPANESE_RE = /[、-〿぀-ゟ゠-ヿ㐀-䶿一-鿿豈-﫿]/u

// frontmatter (先頭の --- ブロック) を本文から切り離す。
// description に日本語トリガー語を残すため、検証対象から外す必要がある。
export function stripFrontmatter(text) {
  const lines = text.split('\n')
  if (lines[0] !== '---') return { body: text, startLine: 1 }
  const closing = lines.indexOf('---', 1)
  if (closing === -1) return { body: text, startLine: 1 }
  return { body: lines.slice(closing + 1).join('\n'), startLine: closing + 2 }
}

export function findJapaneseLines(text) {
  const { body, startLine } = stripFrontmatter(text)
  const hits = []
  body.split('\n').forEach((line, index) => {
    if (JAPANESE_RE.test(line)) hits.push({ line: startLine + index, text: line })
  })
  return hits
}

function isDir(path) {
  return existsSync(path) && statSync(path).isDirectory()
}

function walkMarkdown(dir, root, acc) {
  if (!isDir(dir)) return acc
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walkMarkdown(full, root, acc)
    else if (entry.name.endsWith('.md')) acc.push(relative(root, full))
  }
  return acc
}

// 対象: apps/*/skills/*/SKILL.md, apps/*/skills/*/references/**/*.md,
//       apps/*/references/**/*.md, apps/*/commands/*.md
export function collectTargets(root) {
  const appsDir = join(root, 'apps')
  if (!isDir(appsDir)) return []
  const targets = []
  for (const app of readdirSync(appsDir, { withFileTypes: true })) {
    if (!app.isDirectory()) continue
    const appPath = join(appsDir, app.name)

    const commandsDir = join(appPath, 'commands')
    if (isDir(commandsDir)) {
      for (const entry of readdirSync(commandsDir)) {
        if (entry.endsWith('.md')) targets.push(relative(root, join(commandsDir, entry)))
      }
    }

    walkMarkdown(join(appPath, 'references'), root, targets)

    const skillsDir = join(appPath, 'skills')
    if (!isDir(skillsDir)) continue
    for (const skill of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!skill.isDirectory()) continue
      const skillPath = join(skillsDir, skill.name)
      const skillFile = join(skillPath, 'SKILL.md')
      if (existsSync(skillFile)) targets.push(relative(root, skillFile))
      walkMarkdown(join(skillPath, 'references'), root, targets)
    }
  }
  return targets.sort()
}

export function isTranslation(relPath) {
  return basename(relPath).endsWith('-ja.md')
}

export function check(root, filter) {
  const matches = (relPath) => !filter?.length || filter.some((f) => relPath.startsWith(f))
  const violations = []

  for (const relPath of collectTargets(root)) {
    if (!matches(relPath)) continue
    const text = readFileSync(join(root, relPath), 'utf8')

    if (isTranslation(relPath)) {
      if (!JAPANESE_RE.test(text)) {
        violations.push({
          file: relPath,
          line: 1,
          rule: 'empty-translation',
          message: 'translation file contains no Japanese text',
        })
      }
      continue
    }

    for (const hit of findJapaneseLines(text)) {
      violations.push({
        file: relPath,
        line: hit.line,
        rule: 'japanese-in-english-doc',
        message: `Japanese found: ${hit.text.trim().slice(0, 60)}`,
      })
    }

    if (basename(relPath) === 'SKILL.md') {
      const guide = join(root, relPath.replace(/SKILL\.md$/, 'references/guide-ja.md'))
      if (!existsSync(guide)) {
        violations.push({
          file: relPath,
          line: 1,
          rule: 'missing-guide-ja',
          message: 'references/guide-ja.md is required for every SKILL.md',
        })
      }
    }
  }

  return violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.cwd()
  const violations = check(root, process.argv.slice(2))
  for (const v of violations) console.error(`${v.file}:${v.line}: [${v.rule}] ${v.message}`)
  if (violations.length > 0) {
    console.error(`\n${violations.length} violation(s). See CLAUDE.md "Language convention".`)
    process.exit(1)
  }
  console.log('check-doc-lang: OK')
}
```

- [ ] **Step 4: テストが通ることを確認する**

```bash
node --test scripts/check-doc-lang.test.mjs
```

Expected: PASS（全 15 テスト）

- [ ] **Step 5: 実リポジトリに対して走らせ、違反の全体像を得る**

```bash
node scripts/check-doc-lang.mjs 2>&1 | tail -5
node scripts/check-doc-lang.mjs 2>&1 | grep -c "japanese-in-english-doc" || true
node scripts/check-doc-lang.mjs 2>&1 | grep "missing-guide-ja" || true
```

Expected: exit 1。`missing-guide-ja` が 10 件（dispatch-task 以外の全 skill）出る。この件数を記録し、以降のタスクで減っていくことを確認する

- [ ] **Step 6: `package.json` に script を追加する**

`scripts` に 1 行足す（`check` の書き換えは Task 14 で行う。ここで連結すると以降の全タスクで `pnpm check` が落ちるため）。

```json
"check:doc-lang": "node scripts/check-doc-lang.mjs",
```

```bash
pnpm check:doc-lang; echo "exit=$?"
```

Expected: 違反一覧が出て `exit=1`

- [ ] **Step 7: biome を通す**

```bash
pnpm biome check --write scripts/
pnpm biome check scripts/
```

Expected: エラーなし

- [ ] **Step 8: コミット**

```bash
git add scripts/check-doc-lang.mjs scripts/check-doc-lang.test.mjs package.json
git commit -m "feat(scripts): SKILL.md の言語ルール検証スクリプトを追加

日本語混入 / guide-ja.md の欠落 / 訳の空実装 の 3 チェックを行う。
frontmatter は description に日本語トリガー語を残すため検証対象外。
node --test でユニットテストを実行する。"
```

---

## Task 3: ルート `CLAUDE.md` に言語ルールを明文化

**Files:**
- Modify: `CLAUDE.md`（`## Language convention` 節、90〜96 行目付近）

**Interfaces:**
- Consumes: Task 2 の `scripts/check-doc-lang.mjs`（検証コマンドとして参照する）
- Produces: 以降のタスクで各 app の CLAUDE.md が参照するルールの正本

- [ ] **Step 1: `## Language convention` 節を差し替える**

既存の節:

```markdown
## Language convention

- **ドキュメント・コメント・コミットメッセージ・PR 本文**: 日本語
- **コード（変数名・関数名・関数引数・CLI フラグ）**: 英語
- これは全 app で一貫しており、各プラグインの CLAUDE.md にも明記されている。
```

これを次に差し替える:

```markdown
## Language convention

### 基本

- **ドキュメント・コメント・コミットメッセージ・PR 本文**: 日本語
- **コード（変数名・関数名・関数引数・CLI フラグ）**: 英語

### Claude 向け指示文書は英語（厳格ルール）

skill / command の定義ファイルは Claude が読む指示文書なので **英語で書く**。日本語訳は `*-ja.md` に分離する。

| ファイル | 言語 | 日本語訳 | 訳の要否 |
|---------|------|---------|---------|
| `apps/*/skills/*/SKILL.md` 本文 | **英語必須** | `apps/*/skills/*/references/guide-ja.md` | **必須** |
| `SKILL.md` の frontmatter `description` | 日本語可 | — | — （起動トリガー語のため対象外） |
| `apps/*/**/references/<name>.md` | **英語必須** | `references/<name>-ja.md` | 任意 |
| `references/*-ja.md` | 日本語 | 自身が訳 | — |
| `apps/*/commands/*.md` | **英語必須** | — | 作らない（内容は SKILL.md に集約） |
| `CLAUDE.md` / `README.md` | 日本語 | — | — |

一行ルール: **`*-ja.md` 以外の Claude 向け指示文書に日本語文字を書かない。**

`description` だけ日本語を許すのは、この field が skill の起動判定に使われるため。日本語で話しかけたときの発火率を落とさないよう、日本語のトリガー語を残す。

`references/` 配下の訳が任意なのは補助資料だから。SKILL.md は skill の仕様そのものなので、日本語で読めない状態を許容せず訳を必須にする。

### SKILL.md の `## Output Language` ブロック

本文が英語でもユーザーへの表示は日本語である必要があるため、全 SKILL.md の frontmatter 直後に次を置く:

```markdown
## Output Language

All user-facing questions, option labels, tables, and progress reports MUST be
rendered in Japanese. This file is written in English for consistency; it does
not change the language presented to the user.
```

AskUserQuestion の質問文・選択肢ラベル、進捗テーブル、最終サマリーはすべてこのブロックの対象。SKILL.md 側に日本語のリテラル文字列を置いてはならない。

### `guide-ja.md` の構造

SKILL.md と見出しを 1:1 対応させる。SKILL.md に対応セクションが無い独自解説は末尾にまとめる:

```markdown
# <SKILL.md の H1 の訳>

## Output Language の訳
## <H2 の訳>
### <H3 の訳>

---

## 補足（SKILL.md に対応セクションなし）
```

SKILL.md を更新したら guide-ja.md も同じ commit で更新する。

### 検証

```bash
pnpm check:doc-lang              # 全体
node scripts/check-doc-lang.mjs apps/dev-up  # パス指定で絞り込み
```

`pnpm check` にも組み込まれているため、違反があると CI が落ちる。
```

- [ ] **Step 2: 表記が壊れていないことを確認する**

```bash
grep -n "Output Language" CLAUDE.md
grep -n "check:doc-lang" CLAUDE.md
```

Expected: `## Output Language` を含む行と `pnpm check:doc-lang` の行がそれぞれ見つかる

- [ ] **Step 3: コミット**

```bash
git add CLAUDE.md
git commit -m "docs: SKILL.md 英語必須と日本語訳分離のルールを明文化

skill / command の指示文書は英語、日本語訳は *-ja.md に分離する規約を
Language convention 節に追加。Output Language ブロックと guide-ja.md の
ミラー構造、pnpm check:doc-lang による検証方法も記載した。"
```

---

## Task 4: token-meter の 5 skill を英語化

**Files:**
- Modify: `apps/token-meter/skills/token-clear/SKILL.md`（29 行）
- Modify: `apps/token-meter/skills/token-measure/SKILL.md`（43 行）
- Modify: `apps/token-meter/skills/token-plugins/SKILL.md`（38 行）
- Modify: `apps/token-meter/skills/token-report/SKILL.md`（81 行）
- Modify: `apps/token-meter/skills/token-stats/SKILL.md`（32 行）
- Create: `apps/token-meter/skills/token-clear/references/guide-ja.md`
- Create: `apps/token-meter/skills/token-measure/references/guide-ja.md`
- Create: `apps/token-meter/skills/token-plugins/references/guide-ja.md`
- Create: `apps/token-meter/skills/token-report/references/guide-ja.md`
- Create: `apps/token-meter/skills/token-stats/references/guide-ja.md`

**Interfaces:**
- Consumes: Task 2 の `pnpm check:doc-lang`、Task 3 の `## Output Language` 定型文
- Produces: なし（他タスクから参照されない）

- [ ] **Step 1: 現状の違反を確認する**

```bash
node scripts/check-doc-lang.mjs apps/token-meter; echo "exit=$?"
```

Expected: `japanese-in-english-doc` と `missing-guide-ja` が両方出て `exit=1`

- [ ] **Step 2: `token-clear` を英語化する**

`apps/token-meter/skills/token-clear/SKILL.md` を次の内容に置き換える。frontmatter は既に英語なので触らない。

```markdown
---
name: token-clear
description: >
  Use when the user invokes `/token-clear` or asks to delete old token-meter
  JSONL logs by retention period. Confirms before destructive deletion.
---

## Output Language

All user-facing questions, option labels, tables, and progress reports MUST be
rendered in Japanese. This file is written in English for consistency; it does
not change the language presented to the user.

# token-clear: Delete log history

Delete JSONL files under `~/.claude/token-meter/logs/` by retention period.

## Arguments

| Argument | Behavior |
|---|---|
| `--before <N>d` | Delete files older than N days (e.g. `--before 30d`) |
| `--all` | Delete every JSONL file |
| `--dry-run` | Only print the deletion candidates |

## Procedure

1. Parse the date (`YYYY-MM-DD.jsonl`) from each candidate filename and compare it against `--before`.
2. Unless `--dry-run` is set, print the candidate list and their total size, then ask the user to confirm before deleting.
3. Delete with `rm` after confirmation.

## Cautions

- Deletion is **irreversible**. Always confirm the candidates with `--dry-run` before the real run.
- Skip files that are currently being written (the JSONL for today's date) and emit a warning.
```

- [ ] **Step 3: `token-clear` の guide-ja.md を作る**

`apps/token-meter/skills/token-clear/references/guide-ja.md`:

```markdown
# token-clear: 履歴削除

## Output Language

ユーザーへの質問・選択肢ラベル・表・進捗報告はすべて日本語で表示する。SKILL.md 本文が英語なのは記述の統一のためであり、ユーザーへの提示言語は変えない。

## 引数仕様

| 引数 | 動作 |
|---|---|
| `--before <N>d` | N 日以上前のファイルを削除 (例: `--before 30d`) |
| `--all` | 全 JSONL を削除 |
| `--dry-run` | 削除候補のみ表示 |

## 実装手順

1. 削除候補ファイル名から日付 (`YYYY-MM-DD.jsonl`) をパースし `--before` と比較。
2. `--dry-run` でない限り、削除前に candidate 一覧と合計サイズを表示しユーザーに確認を求める。
3. 確認後 `rm` で削除。

## 注意

- 削除は **不可逆**。必ず `--dry-run` で候補を確認してから本実行する。
- 同名ファイルが書込中の場合 (現在日付の jsonl) はスキップして警告を出す。
```

- [ ] **Step 4: `token-clear` を検証する**

```bash
node scripts/check-doc-lang.mjs apps/token-meter/skills/token-clear; echo "exit=$?"
```

Expected: `exit=0`

- [ ] **Step 5: 残り 4 skill に同じ変換を適用する**

`token-measure` / `token-plugins` / `token-report` / `token-stats` について、Global Constraints の「英語化の変換規則」1〜5 を適用する。Step 2 の SKILL.md と Step 3 の guide-ja.md が、その規則を適用した結果の見本になっている。

各 skill ごとに検証する:

```bash
for s in token-measure token-plugins token-report token-stats; do
  node scripts/check-doc-lang.mjs "apps/token-meter/skills/$s" && echo "$s OK"
done
```

Expected: 4 件すべて `OK`

- [ ] **Step 6: token-meter 全体を検証する**

```bash
node scripts/check-doc-lang.mjs apps/token-meter; echo "exit=$?"
```

Expected: `exit=0`

- [ ] **Step 7: コミット**

```bash
git add apps/token-meter/skills
git commit -m "docs(token-meter): SKILL.md を英語化し日本語訳を guide-ja.md へ分離

token-clear / token-measure / token-plugins / token-report / token-stats の
5 skill について SKILL.md 本文を英語化し、Output Language ブロックを追加。
日本語の説明は references/guide-ja.md へ移した。"
```

---

## Task 5: codex-exec / codex-review の 2 skill を英語化

**Files:**
- Modify: `apps/cmux-codex-exec/skills/codex-exec/SKILL.md`（44 行、うち 26 行が日本語）
- Modify: `apps/cmux-codex-review/skills/codex-review/SKILL.md`（106 行、うち 58 行が日本語）
- Create: `apps/cmux-codex-exec/skills/codex-exec/references/guide-ja.md`
- Create: `apps/cmux-codex-review/skills/codex-review/references/guide-ja.md`

**Interfaces:**
- Consumes: Task 3 の `## Output Language` 定型文
- Produces: なし

- [ ] **Step 1: 現状の違反を確認する**

```bash
node scripts/check-doc-lang.mjs apps/cmux-codex-exec apps/cmux-codex-review; echo "exit=$?"
```

Expected: `exit=1`

- [ ] **Step 2: `codex-exec` を英語化する**

`apps/cmux-codex-exec/skills/codex-exec/SKILL.md` に Global Constraints の「英語化の変換規則」1〜5 を適用する。

この skill は agmsg 経由の完了検知を扱うため、次の用語は**英語化しても意味が変わらないよう固定する**:

| 元の日本語 | 英訳 |
|-----------|------|
| 完了通知 | completion notification |
| 親セッション | parent session |
| 対話 codex | interactive codex |
| カレントディレクトリ | the current directory |
| 発火 | fire / trigger |

`send.sh` / `cmux send` / `cmux send-key return` などのコマンド名、`agmsg` / `plan` などの識別子は変換しない。

- [ ] **Step 3: `codex-exec` の guide-ja.md を作る**

`apps/cmux-codex-exec/skills/codex-exec/references/guide-ja.md` を作成する。英語化後の SKILL.md の見出しを 1:1 で日本語訳し、本文は変更前の日本語をそのまま流用する。

- [ ] **Step 4: `codex-exec` を検証する**

```bash
node scripts/check-doc-lang.mjs apps/cmux-codex-exec; echo "exit=$?"
```

Expected: `exit=0`

- [ ] **Step 5: `codex-review` に同じ変換を適用する**

Step 2〜4 と同じ手順。この skill は sandbox 設定を扱うため、`workspace-write` / `read-only` / `--sandbox` / `approval_policy` などの値と flag は変換しない。

```bash
node scripts/check-doc-lang.mjs apps/cmux-codex-review; echo "exit=$?"
```

Expected: `exit=0`

- [ ] **Step 6: コミット**

```bash
git add apps/cmux-codex-exec apps/cmux-codex-review
git commit -m "docs(codex): SKILL.md を英語化し日本語訳を guide-ja.md へ分離

codex-exec / codex-review の SKILL.md 本文を英語化し、Output Language
ブロックを追加。日本語の説明は references/guide-ja.md へ移した。"
```

---

## Task 6: e2e-test / dev-up の guide-ja.md を整備

**Files:**
- Modify: `apps/e2e-test/skills/e2e-test/SKILL.md`（77 行、日本語 0 行）
- Modify: `apps/dev-up/skills/dev-up/SKILL.md`（112 行、うち 3 行が日本語）
- Create: `apps/e2e-test/skills/e2e-test/references/guide-ja.md`
- Create: `apps/dev-up/skills/dev-up/references/guide-ja.md`

**Interfaces:**
- Consumes: Task 3 の `## Output Language` 定型文
- Produces: なし

- [ ] **Step 1: 現状の違反を確認する**

```bash
node scripts/check-doc-lang.mjs apps/e2e-test apps/dev-up
```

Expected: `missing-guide-ja` が 2 件と、`dev-up` の SKILL.md に `japanese-in-english-doc` が数件

- [ ] **Step 2: 残っている日本語を特定して英語化する**

```bash
node scripts/check-doc-lang.mjs apps/dev-up | grep japanese-in-english-doc
```

出力された行番号の箇所だけを英語に直す。それ以外は触らない。`apps/dev-up/references/setup-guide.md` は日本語 0 行なので変更しない（訳も作らない）。

- [ ] **Step 3: 両 skill に `## Output Language` ブロックを挿入する**

frontmatter 直後に Global Constraints の定型文をそのまま挿入する。

- [ ] **Step 4: guide-ja.md を新規作成する**

両 skill の `references/guide-ja.md` を作成する。既存の日本語本文が無いため、英語 SKILL.md からの新規翻訳になる。

まず対応させる見出しを取得する:

```bash
for f in apps/e2e-test/skills/e2e-test/SKILL.md apps/dev-up/skills/dev-up/SKILL.md; do
  echo "=== $f"
  grep -n '^#\{1,4\} ' "$f"
done
```

出力された見出しを 1:1 で訳し、各節の本文を翻訳して埋める。コマンド名・フラグ・パス・ファイル名（`agent-browser` / `.dev-up.yaml` / `.env.dispatch` / `--session` / `.e2e-scenarios/` など）は英語のまま残す。`## Output Language` の訳は Global Constraints の定型文を使う。SKILL.md に無い節は追加しない。

- [ ] **Step 5: 検証する**

```bash
node scripts/check-doc-lang.mjs apps/e2e-test apps/dev-up; echo "exit=$?"
```

Expected: `exit=0`

- [ ] **Step 6: コミット**

```bash
git add apps/e2e-test apps/dev-up
git commit -m "docs(dev-up,e2e-test): guide-ja.md を追加し Output Language を明記

SKILL.md は元々ほぼ英語のため、残存していた日本語の英語化と
Output Language ブロックの追加、日本語訳の新規作成を行った。"
```

---

## Task 7: cmux-using を英語化

**Files:**
- Modify: `apps/cmux-using/skills/cmux-using/SKILL.md`（328 行、うち 130 行が日本語）
- Create: `apps/cmux-using/skills/cmux-using/references/guide-ja.md`

**Interfaces:**
- Consumes: Task 3 の `## Output Language` 定型文
- Produces: なし

- [ ] **Step 1: 現状の違反を確認する**

```bash
node scripts/check-doc-lang.mjs apps/cmux-using; echo "exit=$?"
node -e "const t=require('fs').readFileSync('apps/cmux-using/skills/cmux-using/SKILL.md','utf8');console.log(t.split('\n').filter(l=>/^#{1,3} /.test(l)).join('\n'))"
```

Expected: `exit=1`。見出し一覧が出るので、guide-ja.md のミラー構造を組み立てる材料にする

- [ ] **Step 2: frontmatter の `description` は日本語のまま残すことを確認する**

この skill の `description` は日本語:

```yaml
description: "cmux ターミナル内での操作スキル。ペイン分割、サブエージェント起動・監視・結果回収、コマンド送信、画面読み取り、通知に使用。CMUX_* 環境変数が存在する場合にトリガーされる。"
```

**これは変更しない。** 検証スクリプトは frontmatter をスキップするので違反にならない。

```bash
node scripts/check-doc-lang.mjs apps/cmux-using | grep ":2:\|:3:" || echo "frontmatter は検出されない"
```

Expected: `frontmatter は検出されない`

- [ ] **Step 3: `## Output Language` ブロックを挿入し、本文を英語化する**

Global Constraints の「英語化の変換規則」1〜5 を適用する。この skill 固有の用語は次で固定する:

| 元の日本語 | 英訳 |
|-----------|------|
| ペイン分割 | pane split |
| サブエージェント起動 | sub-agent launch |
| 監視 | monitoring |
| 結果回収 | result collection |
| コマンド送信 | command dispatch |
| 画面読み取り | screen read |
| 通知 | notification |
| ワークスペース | workspace |
| サーフェス | surface |

`cmux` のサブコマンド名（`send` / `send-key` / `read-screen` / `wait-for` / `split` など）と環境変数名（`CMUX_*`）は変換しない。

- [ ] **Step 4: guide-ja.md を作る**

`apps/cmux-using/skills/cmux-using/references/guide-ja.md` を作成する。英語化後の SKILL.md の見出しを 1:1 で日本語訳し、本文は変更前の日本語をそのまま流用する。

- [ ] **Step 5: 見出しの対応を目視確認する**

```bash
node -e "
const fs=require('fs')
const h=f=>fs.readFileSync(f,'utf8').split('\n').filter(l=>/^#{1,4} /.test(l)).length
console.log('SKILL.md   :', h('apps/cmux-using/skills/cmux-using/SKILL.md'))
console.log('guide-ja.md:', h('apps/cmux-using/skills/cmux-using/references/guide-ja.md'))
"
```

Expected: guide-ja.md の見出し数が SKILL.md 以上（`## 補足` の分だけ多くなりうる）

- [ ] **Step 6: 検証する**

```bash
node scripts/check-doc-lang.mjs apps/cmux-using; echo "exit=$?"
```

Expected: `exit=0`

- [ ] **Step 7: コミット**

```bash
git add apps/cmux-using
git commit -m "docs(cmux-using): SKILL.md を英語化し日本語訳を guide-ja.md へ分離

本文を英語化して Output Language ブロックを追加。frontmatter の
description は起動トリガー語のため日本語のまま残した。"
```

---

## Task 8: dispatch-task SKILL.md 前半（Step 1 まで）を英語化

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md:1-604`

**Interfaces:**
- Consumes: Task 3 の `## Output Language` 定型文
- Produces: SKILL.md の 1〜604 行が英語になる。行番号がずれるため Task 9 は着手時に再取得すること

**背景:** このファイルは 2385 行。1 タスクで扱うには大きすぎるため H2 境界で 3 分割する。前半は `# Team Dispatch`(L19) / `## Display Format Conventions`(L30) / `## Loop Mode`(L81) / `## Step 1: Parse and Prepare`(L87-604)。日本語は 200〜599 行に集中しており（98 行）、Step 1f のランナー設定と Step 1g のメッセージ transport 解決が中心。

- [ ] **Step 1: 対象範囲の違反行を洗い出す**

```bash
F=apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md
node scripts/check-doc-lang.mjs "$F" | awk -F: '$2 <= 604' | tee /tmp/dispatch-front.txt | wc -l
```

Expected: 100 件前後。この一覧を作業中のチェックリストにする

- [ ] **Step 2: `## Output Language` ブロックを挿入する**

frontmatter の直後、`# Team Dispatch`(L19) の**前**に Global Constraints の定型文をそのまま挿入する。

- [ ] **Step 3: `## Loop Mode` の見出しを英語化する**

L81 の見出しを次にする:

```markdown
## Loop Mode (automatic GitHub issue loop)
```

本文（L83〜85）も英語にする。`references/loop-mode.md` への参照リンクは Task 11 で英語化されるが、パスは変わらないのでそのまま。

- [ ] **Step 4: Step 1f のユーザー向けリテラルを英語化する**

L238〜250 の AskUserQuestion の質問文と選択肢を英語にする。**表示は日本語で行われる**（`## Output Language` ブロックによる）ので、ここは英語で書いてよい。

変更前:

```markdown
   - If **2 or more** runners are registered → ask the user via AskUserQuestion:
     > 子セッションごとにランタイム/モデルを切り替えますか？ (default: いいえ, 全タスクに既定 runner を適用)
     Options — **ask form** は 1–2 のみ、**unset form** は 1–4:
       1. いいえ (今回のみ) → assign the `default` runner from `runners.json` to all
          tasks。config には書かない
       2. はい (今回のみ)   → for each task, ask which runner to use via AskUserQuestion.
```

変更後:

```markdown
   - If **2 or more** runners are registered → ask the user via AskUserQuestion:
     > Switch the runtime/model per child session? (default: No — apply the default runner to every task)
     Options — the **ask form** offers 1–2 only, the **unset form** offers 1–4:
       1. No (this time only) → assign the `default` runner from `runners.json` to all
          tasks. Do not write to config.
       2. Yes (this time only) → for each task, ask which runner to use via AskUserQuestion.
```

同じ要領で L241〜254 の残りの選択肢と永続化の説明を英語化する。次の用語を固定する:

| 元の日本語 | 英訳 |
|-----------|------|
| 今回のみ | this time only |
| 常に〜 | always ... |
| 未設定 | unset |
| 不正値 | invalid value |
| 永続化 | persist |
| 遮蔽する | mask / shadow |
| フォールバック | fall back |
| 質問を省略 | skip the question |

- [ ] **Step 5: Step 1f / 1g のシェルコメントを英語化する**

L205〜207, L491〜494, L532 のコメント行を英語にする。例:

変更前:

```bash
# 各レイヤーを個別に検証する — project の不正値が global に保存済みの「常に〜」を
# 遮蔽しないよう、不正値は警告してそのレイヤーだけ未設定として扱い次へフォールバック。
# 有効値 = runners[].name のいずれか、または "ask"（"ask" は有効値としてフォールバック停止）
```

変更後:

```bash
# Validate each layer independently so that an invalid project value does not mask an
# "always ..." choice already persisted in global. On an invalid value, warn and treat
# only that layer as unset, then fall back to the next one.
# Valid values = any runners[].name, or "ask" ("ask" is valid and stops the fallback).
```

- [ ] **Step 6: 残りの日本語を潰す**

```bash
F=apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md
node scripts/check-doc-lang.mjs "$F" | awk -F: '$2 <= 640'
```

`## Step 2: Launch Sessions` の見出し行（英語化後の位置。Step 2 の開始行までに残った日本語）が 0 件になるまで繰り返す。行番号は Output Language ブロックを足した分ずれるので、`grep -n '^## Step 2' "$F"` で境界を再確認する。

Expected: 前半範囲の違反が 0 件

- [ ] **Step 7: 表示テンプレートが壊れていないことを確認する**

Display Format Conventions の Template A/B/C は Box drawing 文字を含む。行が崩れていないことを確認する:

```bash
F=apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md
sed -n '/^### Template A/,/^### Template B/p' "$F"
```

Expected: 罫線の桁が揃っており、ヘッダが元と同じカラム構成

- [ ] **Step 8: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md
git commit -m "docs(cmux-team-dispatch-task): SKILL.md 前半を英語化

Output Language ブロックを追加し、Display Format Conventions /
Loop Mode / Step 1 (1a-1h) を英語化した。Step 1f の runner 選択と
Step 1g の message transport 解決に含まれていた日本語リテラルは、
表示を日本語に保ったまま英語表記へ移した。"
```

---

## Task 9: dispatch-task SKILL.md 中盤（Step 2）を英語化

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md` の `## Step 2: Launch Sessions` 節

**Interfaces:**
- Consumes: Task 8 の成果
- Produces: Step 2 節が英語になる

**背景:** 元の行番号では L605〜1849。日本語は約 119 行で、800〜999 行（子セッションプロンプトの組み立て）と 1400〜1599 行（Plan-mode Enforcement Hook）に集中する。

- [ ] **Step 1: 節の境界を再取得する**

```bash
F=apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md
grep -n '^## ' "$F"
```

Expected: `## Step 2: Launch Sessions` と `## Step 3: Monitor and Complete` の行番号が得られる。以降 `$START` / `$END` としてこの範囲を使う

- [ ] **Step 2: 対象範囲の違反行を洗い出す**

```bash
F=apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md
START=$(grep -n '^## Step 2' "$F" | cut -d: -f1)
END=$(grep -n '^## Step 3' "$F" | cut -d: -f1)
node scripts/check-doc-lang.mjs "$F" | awk -F: -v s=$START -v e=$END '$2 >= s && $2 < e'
```

Expected: 120 件前後

- [ ] **Step 3: 子セッションプロンプトの日本語を英語化する**

`### Building the Task Prompt` 以下に埋め込まれる子セッション向けプロンプト文が対象。**これは子 Claude が読む指示文なので英語化してよい**が、子セッションもユーザーへ日本語で表示する必要があるため、プロンプト内に次の一文が含まれていることを確認し、無ければ追加する:

```
All user-facing questions, option labels, and progress reports MUST be rendered in Japanese.
```

`PROGRESS REPORTING FORMAT` に埋め込まれた Template B のテーブルは、Task 8 Step 7 で確認した Display Format Conventions の Template B と**カラム数・順序・幅・Mode 略称が完全一致**していなければならない（`apps/cmux-team-dispatch-task/CLAUDE.md` のメンテナンス手順 7）。英語化の前後で崩れていないことを確認する:

```bash
F=apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md
grep -n "PROGRESS REPORTING FORMAT" "$F"
```

- [ ] **Step 4: Plan-mode Enforcement Hook 節を英語化する**

`### Plan-mode Enforcement Hook (ExitPlanMode)` 節の日本語を英語にする。`plan-approved-hook.sh` / `settings.local.json` / `PostToolUse` / `ExitPlanMode` / `hookSpecificOutput.additionalContext` などの識別子は変換しない。

- [ ] **Step 5: 残りの日本語を潰す**

```bash
F=apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md
START=$(grep -n '^## Step 2' "$F" | cut -d: -f1)
END=$(grep -n '^## Step 3' "$F" | cut -d: -f1)
node scripts/check-doc-lang.mjs "$F" | awk -F: -v s=$START -v e=$END '$2 >= s && $2 < e' | wc -l
```

Expected: `0`

- [ ] **Step 6: 静的検査テストを流す**

```bash
cd apps/cmux-team-dispatch-task
bash test/test-launch-workspace-codex.sh
bash test/test-launch-workspace-review-config.sh
bash test/test-prewarm-unattended.sh
cd -
```

Expected: 3 本とも PASS。SKILL.md 自体は検査対象ではないが、Step 2 の記述と `launch-workspace.sh` / `prewarm-panes.sh` の実装がずれていないことの傍証になる

- [ ] **Step 7: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md
git commit -m "docs(cmux-team-dispatch-task): SKILL.md Step 2 を英語化

子セッションプロンプトの組み立てと Plan-mode Enforcement Hook を英語化。
子セッション側にもユーザー表示を日本語で行う指示を明記した。
PROGRESS REPORTING FORMAT の Template B は桁を変更していない。"
```

---

## Task 10: dispatch-task SKILL.md 後半（Step 3 以降）を英語化

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md` の `## Step 3: Monitor and Complete` 以降

**Interfaces:**
- Consumes: Task 9 の成果
- Produces: SKILL.md 全体が英語になる（`pnpm check:doc-lang` でこのファイルの `japanese-in-english-doc` が 0 件）

**背景:** 元の行番号では L1850〜2385。`## Step 3`(L1850) / `## Status Protocol Reference`(L2235) / `## superpowers Execution Handoff Integration`(L2313) / `## Constraints`(L2369)。日本語は約 10 行と少ない。

- [ ] **Step 1: 対象範囲の違反行を洗い出す**

```bash
F=apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md
START=$(grep -n '^## Step 3' "$F" | cut -d: -f1)
node scripts/check-doc-lang.mjs "$F" | awk -F: -v s=$START '$2 >= s'
```

Expected: 10 件前後

- [ ] **Step 2: 該当行を英語化する**

主なものは Step 3 のシェルコメント（`# 1. Check if the PID is still alive` 周辺の日本語行）と、`### 4) Final housekeeping` 付近のコメント。`status.json` / `result.md` / `.dispatch/` / `.dispatch-loop/` のスキーマ記述は識別子なので変換しない。

- [ ] **Step 3: ファイル全体で日本語が 0 件になったことを確認する**

```bash
F=apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md
node scripts/check-doc-lang.mjs "$F" | grep japanese-in-english-doc | wc -l
```

Expected: `0`

- [ ] **Step 4: 全テストを流す**

```bash
cd apps/cmux-team-dispatch-task
for t in test/*.sh; do echo "--- $t"; bash "$t" || echo "FAILED: $t"; done
cd -
```

Expected: 11 本すべて PASS（`FAILED:` の行が出ない）

- [ ] **Step 5: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md
git commit -m "docs(cmux-team-dispatch-task): SKILL.md 後半を英語化

Step 3 / Status Protocol Reference / superpowers Execution Handoff /
Constraints を英語化し、SKILL.md 全体から日本語を除去した。"
```

---

## Task 11: `loop-mode.md` を英語化し `loop-mode-ja.md` を作る

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/loop-mode.md`（112 行、うち 78 行が日本語）
- Create: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/loop-mode-ja.md`

**Interfaces:**
- Consumes: Task 8 で英語化された SKILL.md の `## Loop Mode` 節（この reference を参照している）
- Produces: なし

- [ ] **Step 1: 現状を確認する**

```bash
D=apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references
node scripts/check-doc-lang.mjs "$D/loop-mode.md"; echo "exit=$?"
cp "$D/loop-mode.md" /tmp/loop-mode-original.md
```

Expected: `exit=1`。原本を退避しておく（guide 作成時に流用する）

- [ ] **Step 2: `loop-mode.md` を英語化する**

Global Constraints の「英語化の変換規則」3 と 5 を適用する（frontmatter が無いので 1・2 は不適用、訳は別ファイルなので 4 は Step 3 で扱う）。この文書固有の用語:

| 元の日本語 | 英訳 |
|-----------|------|
| 自動ループ | automatic loop |
| owner lock | owner lock（変換しない） |
| timeout sentinel | timeout sentinel（変換しない） |
| issue を尽きるまで | until the issues are exhausted |
| 確定文面 | fixed prompt text |

`.dispatch-loop/` / `render-loop-prompt.sh` / `references/unattended/` などのパスは変換しない。

- [ ] **Step 3: `loop-mode-ja.md` を作る**

退避した `/tmp/loop-mode-original.md` の日本語本文を土台に、英語化後の `loop-mode.md` の見出しと 1:1 対応する形へ整える。SKILL.md 用の `guide-ja.md` とは別ファイルなので `## 補足` 節は不要。

- [ ] **Step 4: 検証する**

```bash
D=apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references
node scripts/check-doc-lang.mjs "$D/loop-mode.md" "$D/loop-mode-ja.md"; echo "exit=$?"
```

Expected: `exit=0`

- [ ] **Step 5: loop 関連テストを流す**

```bash
cd apps/cmux-team-dispatch-task
bash test/test-loop-prompt.sh
bash test/test-loop-skill.sh
bash test/test-loop-cleanup.sh
cd -
```

Expected: 3 本とも PASS

- [ ] **Step 6: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references
git commit -m "docs(cmux-team-dispatch-task): loop-mode.md を英語化し日本語訳を分離

references/loop-mode.md を英語化し、日本語版を loop-mode-ja.md として
新設した。owner lock / timeout sentinel の契約は変更していない。"
```

---

## Task 12: dispatch-task の `guide-ja.md` をミラー構造へ再編

**Files:**
- Modify: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md`（1490 行）

**Interfaces:**
- Consumes: Task 8〜10 で英語化された SKILL.md（見出し構造が確定している）
- Produces: SKILL.md と 1:1 対応する見出しを持つ日本語訳

**背景:** 既存の guide-ja.md は SKILL.md の逐語訳ではなく独自構成の「利用ガイド」（見出し 102 個 対 SKILL.md 65 個）。ミラー構造へ組み替え、対応セクションが無い解説は末尾の `## 補足` へ集める。

- [ ] **Step 1: 両ファイルの見出しを並べて突き合わせる**

```bash
S=apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md
G=apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md
grep -n '^#\{1,4\} ' "$S" > /tmp/skill-headings.txt
grep -n '^#\{1,4\} ' "$G" > /tmp/guide-headings.txt
wc -l /tmp/skill-headings.txt /tmp/guide-headings.txt
```

Expected: SKILL.md 側 66 行前後（`## Output Language` を追加した分）、guide-ja.md 側 102 行前後

- [ ] **Step 2: 対応表を作る**

`/tmp/skill-headings.txt` の各見出しについて、guide-ja.md 側の対応セクションを特定する。既存の対応関係の目安:

| SKILL.md | 既存 guide-ja.md |
|---------|-----------------|
| `# Team Dispatch` | `# cmux-team-dispatch-task 利用ガイド` |
| `## Display Format Conventions` | `## 表示フォーマット規約（Display Format Conventions）` |
| `### Template A/B/C` | `### Template A/B/C` |
| `## Loop Mode` | （なし → 新規に訳す） |
| `## Step 1: Parse and Prepare` | `### Step 1: Parse and Prepare`（階層が 1 段深い） |
| `## Step 2: Launch Sessions` | `### Step 2: Launch Sessions` |
| `## Step 3: Monitor and Complete` | `### Step 3: Monitor and Complete` |
| `## Status Protocol Reference` | `## ステータスプロトコル` 相当の節 |
| `## Constraints` | 相当節を探す |

対応が無い guide-ja.md 側の節（`## 概要` / `### 主な特徴` / `## 使い方` / `### 基本的な呼び出し` / `## アーキテクチャ` / `### 3つのレイアウトモード` など）は `## 補足` 行き。

- [ ] **Step 3: guide-ja.md を書き直す**

構造:

```markdown
# Team Dispatch

## Output Language

ユーザーへの質問・選択肢ラベル・表・進捗報告はすべて日本語で表示する。SKILL.md 本文が英語なのは記述の統一のためであり、ユーザーへの提示言語は変えない。

## 表示フォーマット規約（Display Format Conventions）

### Template A — 起動前タスク一覧（Step 1h）
### Template B — 実行中の進捗表（Step 3 報告）
### Template C — 最終サマリー（全タスクが terminal 状態に到達後）

## ループモード（GitHub issue 自動ループ）

## Step 1: 解析と準備

### 1a. タスク収集
### 1b. 利用可能な Agent の発見（自動）
### 1c. Brainstorming 対象タスクの選択
### 1d. レイアウトモードの選択
### 1e. 統合戦略の選択
### 1f. 子セッション runner の設定
### 1g. メッセージ transport の解決
### 1h. サマリー表示と実行

## Step 2: セッションの起動

（以下 SKILL.md の見出しに 1:1 対応）

## Step 3: 監視と完了

## ステータスプロトコル リファレンス

## superpowers 実行ハンドオフ連携

## 制約

---

## 補足（SKILL.md に対応セクションなし）

### 概要
### 主な特徴
### 基本的な呼び出し
### 引数なし（対話モード）
### プランファイルを指定
### 混合指定
### レイアウトモードの指定
### アーキテクチャ
### 3つのレイアウトモード
（既存の内容をそのまま移設）
```

**内容は書き直さず移設する。** 既存の日本語本文は仕様の正確な記述なので、章立てだけ組み替えて中身は温存する。SKILL.md に無い記述を削除しない（`## 補足` へ移す）。

- [ ] **Step 4: 見出しの対応を検証する**

```bash
S=apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md
G=apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md
node -e "
const fs=require('fs')
const heads=f=>fs.readFileSync(f,'utf8').split('\n').filter(l=>/^#{1,4} /.test(l))
const s=heads('$S')
const g=heads('$G')
const cut=g.findIndex(h=>h.includes('補足'))
console.log('SKILL.md headings      :', s.length)
console.log('guide-ja before 補足   :', cut === -1 ? g.length : cut)
console.log('guide-ja 補足 onwards  :', cut === -1 ? 0 : g.length - cut)
"
```

Expected: `guide-ja before 補足` が `SKILL.md headings` と同数

- [ ] **Step 5: 検証する**

```bash
node scripts/check-doc-lang.mjs apps/cmux-team-dispatch-task; echo "exit=$?"
```

Expected: `exit=0`

- [ ] **Step 6: コミット**

```bash
git add apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md
git commit -m "docs(cmux-team-dispatch-task): guide-ja.md を SKILL.md のミラー構造へ再編

見出しを SKILL.md と 1:1 対応させ、対応セクションが無い解説は
末尾の「補足」節へ移した。本文の内容は変更していない。"
```

---

## Task 13: `commands/*.md` 6 ファイルを英語化

**Files:**
- Modify: `apps/cmux-codex-review/commands/codex-review.md`（114 行、うち 57 行が日本語）
- Modify: `apps/cmux-codex-exec/commands/codex-exec.md`（88 行、うち 37 行が日本語）
- Modify: `apps/cmux-using/commands/cmux.md`（68 行、うち 31 行が日本語）
- Modify: `apps/codex-bridge/commands/codex-bridge.md`（27 行、うち 8 行が日本語）
- Modify: `apps/cmux-using/commands/cfork.md`（9 行、うち 3 行が日本語）
- Modify: `apps/cmux-fork/commands/cfork.md`（8 行、うち 2 行が日本語）

**Interfaces:**
- Consumes: Task 5 / Task 7 で英語化された対応する SKILL.md（用語を揃える）
- Produces: なし

- [ ] **Step 1: 現状の違反を確認する**

```bash
node scripts/check-doc-lang.mjs apps/cmux-fork/commands apps/cmux-using/commands \
  apps/codex-bridge/commands apps/cmux-codex-exec/commands apps/cmux-codex-review/commands
echo "exit=$?"
```

Expected: `exit=1`

- [ ] **Step 2: 小さいものから英語化する**

`cfork.md` 2 ファイル（8 行 / 9 行）→ `codex-bridge.md`（27 行）の順に英語化する。frontmatter があれば `description` は触らない。

`commands/*.md` には `## Output Language` ブロックを**追加しない**（skill ではないため）。ただしユーザー向けに日本語で応答すべき文言があれば、`Respond to the user in Japanese.` の 1 行を本文に含める。

```bash
node scripts/check-doc-lang.mjs apps/cmux-fork/commands apps/cmux-using/commands/cfork.md apps/codex-bridge/commands
echo "exit=$?"
```

Expected: `exit=0`

- [ ] **Step 3: `cmux.md` を英語化する**

訳語は cmux-using SKILL.md と揃える:

| 元の日本語 | 英訳 |
|-----------|------|
| ペイン分割 | pane split |
| サブエージェント起動 | sub-agent launch |
| 監視 | monitoring |
| 結果回収 | result collection |
| コマンド送信 | command dispatch |
| 画面読み取り | screen read |
| 通知 | notification |
| ワークスペース | workspace |
| サーフェス | surface |

`cmux` のサブコマンド名（`send` / `send-key` / `read-screen` / `wait-for` / `split` など）と環境変数名（`CMUX_*`）は変換しない。

```bash
node scripts/check-doc-lang.mjs apps/cmux-using/commands; echo "exit=$?"
```

Expected: `exit=0`

- [ ] **Step 4: `codex-exec.md` / `codex-review.md` を英語化する**

訳語は codex-exec / codex-review の SKILL.md と揃える:

| 元の日本語 | 英訳 |
|-----------|------|
| 完了通知 | completion notification |
| 親セッション | parent session |
| 対話 codex | interactive codex |
| カレントディレクトリ | the current directory |
| 発火 | fire / trigger |

sandbox の値（`workspace-write` / `read-only`）、モデル名（`gpt-5.6-sol`）、reasoning effort の値（`xhigh`）、`send.sh` / `cmux send` / `cmux send-key return` / `agmsg` は変換しない。

```bash
node scripts/check-doc-lang.mjs apps/cmux-codex-exec apps/cmux-codex-review; echo "exit=$?"
```

Expected: `exit=0`

- [ ] **Step 5: リポジトリ全体を検証する**

```bash
pnpm check:doc-lang; echo "exit=$?"
```

Expected: `exit=0`（全違反が解消)

- [ ] **Step 6: コミット**

```bash
git add apps/*/commands
git commit -m "docs(commands): スラッシュコマンド定義を英語化

cfork / cmux / codex-bridge / codex-exec / codex-review の 6 ファイルを
英語化した。対応する SKILL.md と同じ訳語を使っている。"
```

---

## Task 14: ルールを `pnpm check` に統合し、各 app の CLAUDE.md から参照する

**Files:**
- Modify: `package.json`（`check` に `check-doc-lang` を連結）
- Modify: `apps/cmux-team-dispatch-task/CLAUDE.md`（言語ルール節 + guide-ja.md の節名参照）
- Modify: `apps/cmux-using/CLAUDE.md`（言語ルール節）
- Modify: `apps/cmux-codex-exec/CLAUDE.md` / `apps/cmux-codex-review/CLAUDE.md` / `apps/token-meter/CLAUDE.md` / `apps/codex-bridge/CLAUDE.md` / `apps/dev-up/CLAUDE.md` / `apps/e2e-test/CLAUDE.md` / `apps/cmux-fork/CLAUDE.md`

**Interfaces:**
- Consumes: Task 1〜13 のすべて
- Produces: 最終成果物

- [ ] **Step 1: リポジトリ全体が緑であることを確認する**

```bash
pnpm check:doc-lang; echo "exit=$?"
```

Expected: `exit=0` と `check-doc-lang: OK`

- [ ] **Step 2: `package.json` の `check` に連結する**

```json
"check": "turbo run check && node scripts/check-doc-lang.mjs",
```

```bash
pnpm check; echo "exit=$?"
```

Expected: `exit=0`。末尾に `check-doc-lang: OK` が出る

- [ ] **Step 3: 連結が機能することを確認する（意図的に壊す）**

```bash
F=apps/e2e-test/skills/e2e-test/SKILL.md
cp "$F" /tmp/e2e-backup.md
printf '\nこれは意図的な違反です。\n' >> "$F"
pnpm check; echo "exit=$?"
cp /tmp/e2e-backup.md "$F"
pnpm check; echo "exit=$?"
```

Expected: 1 回目 `exit=1` で違反行が表示され、復元後の 2 回目は `exit=0`

- [ ] **Step 4: 各 app の CLAUDE.md に言語ルールの参照を追加する**

各 `apps/*/CLAUDE.md` の言語ルール節（`## 言語ルール` があればそこ、無ければ末尾）に次を追加する:

```markdown
## 言語ルール

- **ドキュメント・コメント**: 日本語
- **コード（変数名・関数名・コマンド）**: 英語
- **`SKILL.md` / `commands/*.md` / `references/*.md`**: **英語必須**。日本語訳は `references/*-ja.md` に置く。
  詳細はルート `CLAUDE.md` の「Language convention」を参照。検証は `pnpm check:doc-lang`。
```

既に `## 言語ルール` 節を持つのは `apps/cmux-team-dispatch-task` / `apps/cmux-using`。他は末尾に新設する。`apps/dev-up/CLAUDE.md` と `apps/e2e-test/CLAUDE.md` は 3 行しかないので、この節を足すだけでよい。

- [ ] **Step 5: dispatch-task CLAUDE.md の guide-ja.md 節名参照を更新する**

`apps/cmux-team-dispatch-task/CLAUDE.md` のメンテナンス手順は guide-ja.md の節名を直接参照している。Task 12 でミラー構造へ変わったため、次を更新する:

- 項目 6: `guide-ja.md の説明` → 節名の指定が無いのでそのまま
- 項目 10: `guide-ja.md「子セッション runner 設定」` → `guide-ja.md「### 1f. 子セッション runner の設定」`

他にも節名を名指ししている箇所がないか確認する:

```bash
grep -n "guide-ja.md「" apps/cmux-team-dispatch-task/CLAUDE.md
```

見つかった行はすべて Task 12 の新しい節名に合わせる。

さらに「## ドキュメント整合の絶対ルール」節に 1 行足す:

```markdown
なお SKILL.md は英語、guide-ja.md は日本語で、**見出しは 1:1 対応**させる（ルート `CLAUDE.md`「Language convention」）。SKILL.md に節を足したら guide-ja.md にも対応する節を足すこと。
```

- [ ] **Step 6: 全体の最終検証**

```bash
pnpm install
pnpm check
node --test scripts/check-doc-lang.test.mjs
cd apps/cmux-team-dispatch-task && for t in test/*.sh; do bash "$t" >/dev/null || echo "FAILED: $t"; done; cd -
bash -n install.sh
jq -e '.plugins | length == 9' .claude-plugin/marketplace.json
find apps -name SKILL.md | wc -l
find apps -name guide-ja.md | wc -l
```

Expected:
- `pnpm check` が `exit 0`
- テスト 15 件 PASS、`FAILED:` の出力なし
- `.plugins | length == 9` が `true`
- `SKILL.md` が 11 件、`guide-ja.md` が 11 件

- [ ] **Step 7: プラグインを再インストールして発火を確認する**

```bash
bash install.sh
```

Expected: cmux-team を要求せず完走する。実行後、Claude Code で以下を確認する（手動）:

1. `/token-clear` などのスラッシュコマンドが認識される
2. 「並列で実行して」と日本語で依頼したとき `cmux-team-dispatch-task` skill が発火する（`description` の日本語トリガー語が効いている）
3. dispatch-task の Step 1f で runner 切り替えの質問が出るとき、選択肢が**日本語で表示される**（`## Output Language` ブロックが効いている）

- [ ] **Step 8: コミット**

```bash
git add -A
git commit -m "chore: 言語ルール検証を pnpm check に統合し各 CLAUDE.md から参照

check-doc-lang.mjs を pnpm check に連結し、違反があると CI が落ちる
ようにした。各 app の CLAUDE.md にルート CLAUDE.md への参照を追加し、
dispatch-task の CLAUDE.md は guide-ja.md の新しい節名に合わせた。"
```

---

## Out of Scope

以下は本計画では扱わない。

- **`apps/cmux-remote` の記述:** ルート `CLAUDE.md` の Apps 表と `pnpm-workspace.yaml` の説明、`AGENTS.md` の 11 行目が `apps/cmux-remote` に言及しているが、このディレクトリは既に存在しない。本計画の変更対象ではないため触らない（別途整理が必要）。
- **`docs/superpowers/plans/` `docs/superpowers/specs/` `.claude/plans/` `.superpowers/sdd/` の cmux-team 言及:** 過去の設計記録として保持する。
- **`apps/*/README.md`:** 日本語のまま。ユーザー向けドキュメントなので英語化しない。
- **`apps/dev-up/references/setup-guide.md` の日本語訳:** 元々日本語 0 行で、`references/` 配下の訳は任意のため作らない。
