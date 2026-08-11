# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository overview

`yui-cc-plugins` は cmux ターミナルマルチプレクサ向けの Claude Code プラグインを束ねた **pnpm + turbo monorepo**。各プラグインは独立した Claude Code Plugin としてインストール可能で、ルートの `.claude-plugin/marketplace.json` がマーケットプレイス定義となる。

### Apps

| パス | 種類 | 主な実装言語 | 役割 |
|------|------|-------------|------|
| `apps/cmux-fork` | Plugin (slash command) | bash | `/cfork` で会話を新 cmux ペインにフォーク |
| `apps/cmux-using` | Plugin (skill + commands) | bash + markdown | cmux 操作の汎用スキル |
| `apps/cmux-team-dispatch-task` | Plugin (skill + shell scripts) | bash + zsh | git worktree 分離による並列タスクディスパッチ |
| `apps/cmux-codex-review` | Plugin (slash command + skill) | bash | 新 cmux ペインで対話 codex (gpt-5.6-sol/xhigh) にコードレビューさせる。sandbox は workspace-write（完了通知の `send.sh` が agmsg DB へ書き込むため read-only 不可）。完了を agmsg 経由で親へ通知可 |
| `apps/cmux-codex-exec` | Plugin (slash command + skill) | bash | plan を対話 codex にカレントdir で実装させ、完了を親が agmsg 経由で検知して cmux-codex-review へ繋ぐ |
| `apps/cmux-remote` | App (PWA) | TypeScript (Vite client + Bun server) | cmux ワークスペースを iPhone から閲覧。`apps/cmux-remote/{client,server}` は **個別の workspace パッケージ** |

`pnpm-workspace.yaml` の packages は `apps/*` と `apps/cmux-remote/*` の両方を列挙している（cmux-remote だけ二段ネスト）ため、新規パッケージを追加するときはこの両方を意識する。

### プラグイン構造の規約

各プラグインは以下の共通レイアウトを持つ:

- `.claude-plugin/plugin.json` — Plugin マニフェスト
- `commands/<name>.md` — `/<name>` スラッシュコマンド
- `skills/<name>/SKILL.md` — スキル定義
- `bin/<name>` — シェルスクリプト本体
- `CLAUDE.md` — そのプラグインの開発ガイド（**ルートと内容を重複させず、プラグイン固有の事項のみ**）

バージョンは複数箇所に書かれている: `apps/<name>/.claude-plugin/plugin.json` を更新したら、`apps/<name>/.codex-plugin/plugin.json`（存在する場合）とルートの `.claude-plugin/marketplace.json` の対応する `version` も同期する。

## Commands

### Lint / format / 型チェック (turbo)

```bash
pnpm check         # turbo run check  (TypeScript 型チェック + biome check)
pnpm check:fix     # biome の auto-fix
pnpm format        # biome format
pnpm lint          # biome lint
pnpm sort-package  # package.json のキーを sort（差分があると失敗）
```

`turbo` がワークスペースを横断するので、ルートで `pnpm check` を叩けば全 app に伝播する。個別に走らせるときは workspace filter:

```bash
pnpm --filter @tanaka-yui/token-meter check
pnpm --filter @yui/cmux-remote-client build
```

### テスト

`turbo` には test タスクは登録されていない。テストはアプリ単位で直接ランナーを呼ぶ:

```bash
# token-meter (Bun)
cd apps/token-meter && bun test

# cmux-remote/client (Vitest)
cd apps/cmux-remote/client && bun run test

# cmux-remote/server (Bun)
cd apps/cmux-remote/server && bun test
```

### インストール / 配布

```bash
bash install.sh    # marketplace add + update でローカルパスを登録・カタログ更新し、全プラグインを一括インストール
```

**marketplace.json にプラグインを追加/更新したら `claude plugin marketplace update yui-cc-plugins` が必要**。`/reload-plugins` はインストール済みプラグインの再読込のみで、marketplace の**カタログ（インストール可能な一覧）は更新しない**ため、update しないと新プラグインが認識されない。install.sh は `marketplace add` の直後に `update` を実行するので、再実行すれば追加分も反映される。

リモート利用者向けには `/plugin marketplace add tanaka-yui/yui-cc-plugins` 経由（README 参照）。

## Tooling rules

- **biome 2.4.9** が単一の formatter/linter (rcs: `biome.json` ルートのみ。各 app は biome 設定を持たない)。設定の要点:
  - `lineWidth: 120`, `indentStyle: space`, `indentWidth: 2`
  - JS/TS: single quote, `semicolons: asNeeded`
  - lint: `noUnusedImports` / `noUnusedVariables` / `noUndeclaredVariables` / `useExhaustiveDependencies` は **error**
  - 緩い: `noExplicitAny: warn`, `noNonNullAssertion: warn`
- **Node 24.15 / pnpm 10.33** が `engines` で固定。`packageManager` フィールドも一致させる。
- **TypeScript 6** を使うアプリでも、cmux-remote/server は **Bun ランタイムで実行する** (`bun run` / `bun test`)。Vitest を使うのは cmux-remote/client のみ。

## Codex hook 互換性

`claude-plugins-official` の **security-guidance** プラグインは codex では動かない。cmux 経由で codex ペインを起動すると、ターン終了ごとに次が出る:

```
• Stop hook (failed)
  error: hook returned invalid stop hook JSON output
```

原因は出力スキーマの不一致。codex の hook 出力スキーマ（`stop.command.output` ほか）は **`additionalProperties: false`** で、Stop の許可キーは `continue` / `decision`(`"block"` のみ) / `reason` / `stopReason` / `suppressOutput` / `systemMessage` の 6 つだけ。一方 `security_reminder_hook.py` の `emit_metrics()` は **全経路で必ず `{"metrics": {...}}` を stdout に書く**（`rewakeSummary` も付く）ため、未知キーとして拒否される。

- **環境変数では回避できない**。`SECURITY_GUIDANCE_DISABLE=1` / `ENABLE_SECURITY_REMINDER=0` の kill switch 経路も `metrics` を出す。findings ゼロのターンでも必ず失敗する。
- **非互換は Stop だけではない**。`post_tool_use`（git commit/push レビュー。codex は `if` 条件を解さないので 5 エントリ全部が発火する）と `session_start`（`{"async": true, ...}` を出力）も同じくスキーマ違反。無事なのは `user_prompt_submit` のみ。
- security-guidance は **hooks しか提供していない**（skill / command なし）ので、codex 側で無効化して失うのは「codex では元々動かない security review」だけ。
- このフック失敗は**セッションを終了させない**。「Stop hook (failed)」はターン終了時の表示で、以降もプロンプトは生きている。実装セッションが黙って止まる事象は別件（`apps/cmux-team-dispatch-task/docs/notification-gaps.md` の U1）。

対処は codex 側でプラグインごと無効化する:

```bash
pnpm check:codex-hooks                       # 非互換なら exit 1
bash scripts/codex-hook-compat.sh disable    # ~/.codex/config.toml を冪等に書き換え
```

`disable` は `[plugins."security-guidance@claude-plugins-official"]` の `enabled` を `false` にするだけで、セクションが無い場合は**何も追記しない**（未インストールとみなす）。codex の `/hooks` TUI も同じファイルを自動保存するため、**実行中の codex セッションを閉じてから**走らせること。

`check:codex-hooks` は端末ごとのローカル設定に依存するため **`pnpm check` には組み込まない**（CI を落とさない）。代わりに `cmux-team-dispatch-task` の `launch-workspace.sh` が codex ペイン起動前に同じ判定を行い、有効なら `[warn]` を出す（設定は書き換えず dispatch も止めない）。

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
| `apps/*/commands/*.md` | **英語必須** | — | 作らない（ユーザー提示箇所に `Respond to the user in Japanese.` を書く。後述） |
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

### `commands/*.md` の日本語指示

`commands/*.md` には `## Output Language` ブロックを置かない。代わりに、ユーザーへ提示する箇所（最終報告・確認メッセージなど）の直前か、冒頭の指示部に `Respond to the user in Japanese.` の 1 行を含める（例: `apps/cmux-fork/commands/cfork.md:9`）。

`commands/*.md` の訳を作らない理由は「内容が SKILL.md に集約されているから」ではない。`cmux-fork` と `codex-bridge` は skill を持たず `commands/*.md` が唯一の指示文書だが、それでも訳は作らない。`commands/*.md` は 1 コマンド = 数行〜数十行の短い実行手順であり、`Respond to the user in Japanese.` の 1 行だけで「本文は英語 / 表示は日本語」を両立できるため、SKILL.md のような逐語訳ミラーは不要と判断している。

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

`scripts/check-doc-lang.mjs` は次の 4 種類の違反を検出する:

| ルール | 対象 | 内容 |
|--------|------|------|
| `japanese-in-english-doc` | `*-ja.md` 以外の対象ファイル全体 | frontmatter を除く本文に日本語文字が出現する |
| `missing-guide-ja` | `SKILL.md` | 対応する `references/guide-ja.md` が存在しない |
| `empty-translation` | `*-ja.md` | 日本語が 1 文字も含まれない |
| `missing-output-language` | `SKILL.md` のみ（`references/` / `commands/` は対象外） | 上記の `## Output Language` ブロック 3 行が一字一句そのまま含まれていない |

## Plugin-specific guidance

各プラグインの開発に踏み込む前に、必ず対応する CLAUDE.md を読むこと:

- `apps/cmux-team-dispatch-task/CLAUDE.md` — 並列ディスパッチ、Display Format Conventions (Box drawing 表), モデル選択フロー (opus/sonnet/codex), monitor heartbeat / `--resume`
- `apps/cmux-using/CLAUDE.md` — cmux ターミナル操作スキルの構成
- `apps/cmux-fork/CLAUDE.md` — `/cfork` の動作と前提

cmux 関連プラグインは互いの境界を意識しており、機能の重複を禁止する規約がある（各 CLAUDE.md の「関連プラグインとの境界」表を参照）。新機能を追加するときは、まずどのプラグインの責任範囲かを判断する。
