# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository overview

`yui-cc-plugins` は cmux ターミナルマルチプレクサ向けの Claude Code プラグインを束ねた **pnpm + turbo monorepo**。各プラグインは独立した Claude Code Plugin としてインストール可能で、ルートの `.claude-plugin/marketplace.json` がマーケットプレイス定義となる。

### Apps

| パス | 種類 | 主な実装言語 | 役割 |
|------|------|-------------|------|
| `apps/cmux-fork` | Plugin (slash command) | bash | `/cfork` で会話を新 cmux ペインにフォーク |
| `apps/cmux-using` | Plugin (skill + commands) | bash + markdown | cmux 操作の汎用スキル |
| `apps/cmux-team` | Plugin (skill + TypeScript daemon) | TypeScript (Bun runtime) | 4層 (Master/Manager/Conductor/Agent) オーケストレーション。daemon プロセスを持つ唯一のプラグイン |
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

ルートと plugin manifest の両方にバージョンが書かれている: `apps/<name>/.claude-plugin/plugin.json` を更新したら、ルートの `.claude-plugin/marketplace.json` の対応する `version` も同期する。

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
pnpm --filter cmux-team check
pnpm --filter @yui/cmux-remote-client build
```

### テスト

`turbo` には test タスクは登録されていない。テストはアプリ単位で直接ランナーを呼ぶ:

```bash
# cmux-team (Bun)
cd apps/cmux-team && bun test
cd apps/cmux-team && bun test src/daemon.test.ts        # 単一ファイル
cd apps/cmux-team && bun test --test-name-pattern='foo'  # パターン

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
- **TypeScript 6** を使うアプリでも、cmux-team や cmux-remote/server は **Bun ランタイムで実行する** (`bun run` / `bun test`)。Vitest を使うのは cmux-remote/client のみ。

## Language convention

- **ドキュメント・コメント・コミットメッセージ・PR 本文**: 日本語
- **コード（変数名・関数名・関数引数・CLI フラグ）**: 英語
- これは全 app で一貫しており、各プラグインの CLAUDE.md にも明記されている。

## Plugin-specific guidance

各プラグインの開発に踏み込む前に、必ず対応する CLAUDE.md を読むこと:

- `apps/cmux-team/CLAUDE.md` — 4層 (Master/Manager/Conductor/Agent) アーキテクチャ。daemon, worktree 隔離、pull 型監視の設計原則
- `apps/cmux-team-dispatch-task/CLAUDE.md` — 並列ディスパッチ、Display Format Conventions (Box drawing 表), モデル選択フロー (opus/sonnet/codex), monitor heartbeat / `--resume`
- `apps/cmux-using/CLAUDE.md` — cmux ターミナル操作スキルの構成
- `apps/cmux-fork/CLAUDE.md` — `/cfork` の動作と前提

cmux 関連プラグインは互いの境界を意識しており、機能の重複を禁止する規約がある（各 CLAUDE.md の「関連プラグインとの境界」表を参照）。新機能を追加するときは、まずどのプラグインの責任範囲かを判断する。
