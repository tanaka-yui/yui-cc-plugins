# Generic dev-up and e2e-test Skills Design

**Date**: 2026-05-13
**Status**: Draft
**Topic**: cmux-team-dispatch-task で並列起動された worktree 同士のサーバー起動ポート衝突を解消する汎用 skill 群 (dev-up) と、それと連携する agent-browser ベースの E2E テスト skill (e2e-test) を `yui-cc-plugins/apps/` に追加する

---

## Problem

`cmux-team-dispatch-task` は 1 タスク = 1 git worktree でディスパッチする汎用オーケストレーターである。child Claude セッションは `.worktrees/<slug>/` で独立してコード変更を行えるが、典型的なプロジェクトのサーバー（Docker Compose スタック、Go API、Vite dev server 等）はホスト側ポートが固定なため、複数 worktree から同時に起動するとポートが衝突して 2 つ目以降の動作確認ができない。

さらに、画面を含むタスクで動作確認を自動化したいが、Browser Use は Anthropic API キーが別途必要で Max プラン枠で完結しない。Claude Chrome は可視ブラウザ前提で並列に複数 worktree を同時テストできない。

この 2 つの課題を、freelance-jp-app 等の特定プロジェクトに固有ではなく **どのプロジェクトでも使える汎用 skill** として解決する。プロジェクトのサーバー種別は Docker Compose に限らず、Go / TypeScript（Vite）等の直接実行コマンドにも対応する。

## Goals

1. 各 worktree でサーバー一式（Docker / Go / Vite 等）がポート衝突なしに並列起動できる
2. 並列 dispatch された worktree それぞれで E2E テストを並列実行できる（ヘッドレス、Cookie/storage を完全分離）
3. 上記 2 つの skill は **freelance-jp-app 固有のハードコードを持たず**、プロジェクト側の宣言的設定 (`.dev-up.yaml`) だけで動作する
4. 新規プロジェクトに導入する際は **`dev-up setup` で `.dev-up.yaml` を自動生成** できる（Claude が compose.yaml / package.json / go.mod / Taskfile.yml 等を解析）
5. Docker Compose 以外の起動コマンド（Go server, Vite dev server 等）も同じ skill が面倒を見る（spawn + PID 管理 + ヘルスチェック + ログ）
6. スロット数は `.dev-up.yaml` で任意の N に拡張でき、CLI フラグでも一時 override できる
7. `cmux-team-dispatch-task` は無改修
8. Claude Max プラン枠で完結（追加 API 課金なし）

## Non-goals

- Docker レベルでの動的ポート（`- "5432"` 形式）への移行はしない。URL を予測可能に保つことを優先する。
- Browser Use の採用はしない（Max プラン枠で完結しないため）。
- Playwright の採用はしない（agent-browser で要件をカバーできるため依存を増やさない）。
- Claude Chrome の skill 化はしない（ユーザー側の最終目視ツールとして運用ドキュメントに記載のみ）。
- プロジェクトのヘルスチェックエンドポイント標準化はしない（プロジェクト側の責務、設定で吸収）。
- service 間の起動順序は `depends_on` の topological sort + `health_check` での待機までとし、複雑な依存管理（条件付き再起動・サービスメッシュ等）はサポート対象外。

## Approach

`yui-cc-plugins/apps/` 配下に **2 つの汎用 plugin** を追加する:

- `apps/dev-up/`: `.dev-up.yaml` を読んで複数 service（docker-compose / command）をスロット予約付きで起動・停止する skill
- `apps/e2e-test/`: dev-up が生成した `.env.dispatch` を読み、agent-browser を `--session <project>-<slot>` で呼ぶ薄いラッパー skill

プロジェクト側の責務:
- `.dev-up.yaml` を 1 ファイル置く（`dev-up setup` で自動生成可能）
- Docker Compose を使う場合は `compose.yaml` のホスト側ポートを `${VAR:-default}` 形式に書き換える（`dev-up setup` で自動編集可能）
- 直接実行コマンド系（Go/Vite 等）は既存の env ファイルがあればそのまま継承、ポートだけ skill 側で上書き

`cmux-team-dispatch-task` を呼ぶ際のタスク記述に「動作確認時は dev-up + e2e-test を invoke せよ」と書くだけで連携が成立する。cmux 側のスクリプト改修は不要。

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ yui-cc-plugins (汎用 skill リポジトリ)                       │
│  apps/                                                       │
│    dev-up/                                                   │
│      .claude-plugin/plugin.json                             │
│      .codex-plugin/plugin.json                              │
│      skills/dev-up/                                          │
│        SKILL.md                                              │
│        scripts/                                              │
│          setup.sh, reserve-slot.sh, release-slot.sh,        │
│          compose-up.sh, compose-down.sh, urls.sh, status.sh │
│          lib/parse-config.sh, lib/render-env.sh,            │
│          lib/render-urls.sh, lib/smoke.sh,                  │
│          lib/spawn-command.sh, lib/wait-health.sh,          │
│          lib/topo-sort.sh, lib/kill-pgid.sh,                │
│          lib/setsid-compat.sh                               │
│      references/setup-guide.md                              │
│    e2e-test/                                                 │
│      .claude-plugin/plugin.json                             │
│      .codex-plugin/plugin.json                              │
│      skills/e2e-test/                                        │
│        SKILL.md                                              │
│        scripts/                                              │
│          install.sh, run.sh, snapshot.sh, teardown.sh       │
│  .claude-plugin/marketplace.json   ← 2 entries 追加         │
└─────────────────────────────────────────────────────────────┘
                            │ install via marketplace or local link
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ プロジェクト (例: freelance-jp-app, influencer-platform)     │
│  .dev-up.yaml          ← プロジェクト固有設定                │
│  compose.yaml          ← ports を ${VAR:-default} 化         │
│  go/.env etc.          ← 既存 env ファイルはそのまま継承     │
│  .gitignore            ← .env.dispatch, .e2e-results/,       │
│                          .dev-up-logs/, .e2e-scenarios/      │
└─────────────────────────────────────────────────────────────┘
                            │ git worktree add (by cmux-team-dispatch-task)
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ .worktrees/<slug>/  (child Claude)                          │
│   1. dev-up up → スロット予約 → .env.dispatch 生成           │
│      → services[*] を depends_on の topological sort で起動  │
│        ├─ docker-compose: docker compose up -d --wait        │
│        └─ command: setsid spawn → PID 記録 → health_check    │
│      → smoke (任意) → URL 表示                               │
│   2. 実装                                                    │
│   3. (画面チケットのみ) e2e-test run <scenario>              │
│      → agent-browser --session <project>-<slot> で操作       │
│      → .e2e-results/<slug>/ に保存                           │
│   4. dev-up down                                             │
│      → command 系を SIGTERM→5s→SIGKILL の順に PGID kill      │
│      → docker compose down → スロット解放                    │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
            ┌──────────────────────────────────────────┐
            │ ~/.cache/cc-skills/dev-up/<project>/     │
            │   slots/<N>/                             │
            │     owner.json                           │
            │     processes.json   ← spawn した PID/PGID│
            └──────────────────────────────────────────┘
```

### 責務分離

- `cmux-team-dispatch-task`: ポート知識ゼロの汎用オーケストレーター（無改修）
- `dev-up`: `.dev-up.yaml` を読んでスロット予約と全 service 起動を担当（プロジェクト固有情報を持たない、Docker / 直接コマンド両対応）
- `e2e-test`: `.env.dispatch` を読んで agent-browser を呼ぶ薄いラッパー（プロジェクト固有のシナリオは持たない）
- プロジェクトの `.dev-up.yaml`: プロジェクト固有のサーバー定義（type, port, env, health_check）を宣言

## Components

### A. `.dev-up.yaml` (プロジェクト側に置く設定ファイル)

スキーマ:

```yaml
project: <string>                       # スロットレジストリのキー (kebab-case 推奨)
slot_range: [<int>, <int>]              # 同時並列スロット数の範囲 (CLI --slot-range で override 可)
offset_per_slot: <int>                  # ポートオフセット幅 (base + N * offset)

services:                               # 起動対象 service 一覧
  - name: <string>                      # service 識別子 (kebab-case)
    type: docker-compose                # docker-compose 起動
    files: [<string>]                   # docker compose -f に渡す。複数可。
    ports:
      - { name: <ENV_NAME>, base: <int> }
    depends_on: [<service-name>]        # 任意

  - name: <string>
    type: command                       # 直接コマンド起動
    cwd: <string>                       # 実行ディレクトリ (worktree root 相対)
    command: <string>                   # shell 経由で実行されるコマンド
    env_files: [<string>]               # 任意。継承する既存 env ファイル (worktree root 相対)
    env_overrides:                      # スロット依存値 (base + N * offset)
      - { name: <ENV_NAME>, base: <int> }
    health_check:                       # 任意。起動完了判定
      kind: http | tcp
      target: <string>                  # ${ENV_NAME} を参照可
      timeout: <int>                    # 秒、デフォルト 60
      interval: <int>                   # 秒、デフォルト 1
    log_file: <string>                  # 任意。デフォルト ".dev-up-logs/<name>.log"
    depends_on: [<service-name>]        # 任意

urls:                                   # urls/status の出力テンプレート
  - { label: <string>, template: <string> }

smoke:                                  # 任意。全 service 起動後の最終疎通確認
  - { kind: http,  target: "..." }
  - { kind: pg,    target: "localhost:${PORT_NAME}", user: <string> }
  - { kind: redis, target: "localhost:${PORT_NAME}" }
```

`kind` の取りうる値:
- `services[*].health_check.kind`: `http`, `tcp`
- `smoke[*].kind`: `http`, `pg`, `redis`
- それ以外は WARN を出してスキップ

### B. `dev-up` skill

#### B-1. SKILL.md フロントマター

```yaml
---
name: dev-up
description: >
  Bring up an isolated development stack per git worktree. Reserves a
  port slot from a shared registry, writes .env.dispatch, then starts
  all services declared in .dev-up.yaml (docker-compose stacks and/or
  direct commands like `go run`, `pnpm dev`). Spawned commands are
  tracked with PID/PGID for clean teardown. Use when verifying the
  running app inside a worktree spawned by cmux-team-dispatch-task, or
  whenever you need parallel stacks without port collisions. Run the
  `setup` subcommand once per new project to generate .dev-up.yaml.
argument-hint: "[setup|up|down|status|urls] [--slot-range MIN-MAX]"
---
```

#### B-2. サブコマンド

| サブコマンド | 動作 |
|--------------|------|
| `setup`  | Claude が `compose.yaml` / `package.json` / `go.mod` / `Taskfile.yml` / `Makefile` を解析 → `.dev-up.yaml` 草案を Write → AskUserQuestion で確認 → 必要なら `compose.yaml` の ports を `${VAR:-default}` 形式に書き換え → `.gitignore` 追記 |
| `up` (default) | ゾンビ掃除 → スロット予約 → `.env.dispatch` 生成 → `services[*]` を `depends_on` の topological sort で起動 → smoke → URL 出力 |
| `down`   | spawn 系を起動の逆順に PGID kill (SIGTERM → 5s → SIGKILL) → `docker compose down` → スロット解放 → `.env.dispatch` 削除 |
| `status` | 現在のスロット番号、起動中サービス、各 PID 生存状況、URL 一覧を出力 |
| `urls`   | URL 一覧のみ出力（slot 未予約ならエラー） |

#### B-3. CLI フラグ

| フラグ | 動作 |
|--------|------|
| `--slot-range MIN-MAX` | `.dev-up.yaml` の `slot_range` を当該実行のみ override。例: `dev-up up --slot-range 1-20` |

#### B-4. スロットレジストリ

パス: `~/.cache/cc-skills/dev-up/<project>/slots/<N>/`

中身:

```
slots/<N>/
  owner.json        ← スロット予約者の情報
  processes.json    ← spawn した command 系の PID/PGID
```

`owner.json`:

```json
{
  "pid": 12345,
  "worktree": "/abs/path/to/.worktrees/feature-x",
  "compose_project": "<project>-1",
  "reserved_at": "2026-05-13T10:00:00Z"
}
```

`processes.json`（command 起動時に追記）:

```json
{
  "go-api": {
    "pid": 23456,
    "pgid": 23456,
    "started_at": "2026-05-13T10:00:30Z",
    "log_file": "/abs/path/to/.worktrees/feature-x/.dev-up-logs/go-api.log",
    "depends_on": ["postgres"]
  },
  "vite": { ... }
}
```

#### B-5. スクリプトの責務

| スクリプト | 責務 |
|------------|------|
| `setup.sh` | SKILL.md のセットアップ手順を Claude が読みやすい形に表示するだけ。実体の処理は Claude (LLM) が SKILL.md と `references/setup-guide.md` を読んで自走 |
| `reserve-slot.sh <project> [--slot-range MIN-MAX]` | ゾンビ掃除 → 範囲を順に `mkdir` で予約試行 → stdout に SLOT 番号 |
| `release-slot.sh <project> <slot>` | `slots/<slot>/` を削除 |
| `compose-up.sh [--slot-range ...]` | `.dev-up.yaml` を `lib/parse-config.sh` で読む → reserve-slot.sh → `lib/render-env.sh` で `.env.dispatch` 生成 → `lib/topo-sort.sh` で起動順決定 → 各 service を type で分岐起動 → `lib/smoke.sh` → `lib/render-urls.sh` |
| `compose-down.sh` | `.env.dispatch` から SLOT/PROJECT を取得 → `processes.json` の service を起動逆順に `lib/kill-pgid.sh` で停止 → docker-compose 系を `docker compose -p <project>-<slot> down` → release-slot.sh → `.env.dispatch` 削除 |
| `urls.sh` | `.env.dispatch` を source → `lib/render-urls.sh` で `.dev-up.yaml` の `urls` を展開出力 |
| `status.sh` | `.env.dispatch` を source → `docker compose -p <project>-<slot> ps` + `processes.json` から各 PID の `kill -0` 生存確認 + urls.sh |
| `lib/parse-config.sh` | yq で `.dev-up.yaml` をパースし、bash で扱える形に展開 |
| `lib/render-env.sh` | 全 service の `ports`/`env_overrides`、SLOT 番号、project から `.env.dispatch` を生成 |
| `lib/render-urls.sh` | `urls[*].template` の `${VAR}` を `.env.dispatch` の値で展開して表形式で出力 |
| `lib/smoke.sh` | `smoke[*].kind` に応じて curl / pg_isready / redis-cli を呼び分け、WARN レベルでエラー出力 |
| `lib/spawn-command.sh` | command type の service を `setsid-compat.sh` 経由で session leader として spawn し、PID/PGID を `processes.json` に追記。env は `env_files` → `.env.dispatch` → `env_overrides` の優先順でマージ |
| `lib/wait-health.sh` | `kind` に応じて `curl -fsS --max-time 2` または `nc -z` を `interval` 秒ごとに `timeout` まで実行 |
| `lib/topo-sort.sh` | `services[*].depends_on` を `tsort(1)` で topological sort。循環があれば exit 1 |
| `lib/kill-pgid.sh <pgid>` | `kill -TERM -<pgid>` → 5 秒待機 → `kill -0` で生存確認 → 残っていれば `kill -KILL -<pgid>` |
| `lib/setsid-compat.sh` | OS 判定: `command -v setsid` があればそれを使う、無ければ `perl -e 'use POSIX qw(setsid); setsid; exec @ARGV' --` で代用 |

#### B-6. setup の動作詳細

`dev-up setup` が呼ばれたら Claude は `references/setup-guide.md` を読み、以下を自走する:

1. `git rev-parse --show-toplevel` でプロジェクトルートを検出
2. 以下を **並列で検索**:
   - **Docker Compose**: `compose.yaml`, `compose.yml`, `compose.all.yaml`, `docker-compose.yaml`, `docker-compose.yml`
   - **Go**: `go.mod` がある場合、`main.go` or `cmd/*/main.go`、`Taskfile.yml` の `dev` ターゲット、`Makefile` の `dev:`、`.air.toml`、`go/`, `server/`, `api/` 等のサブディレクトリも対象
   - **TypeScript/Vite**: `package.json` の `scripts.dev`、`vite.config.{ts,js,mjs}`、turbo monorepo の場合 `apps/*/package.json` を再帰展開、`typescript/`, `frontend/`, `web/`, `apps/`, `packages/` 等のサブディレクトリも対象
   - **既存 env ファイル**: `.env`, `.env.local`, `.env.development`, `<subdir>/.env` 等
3. 各 service の **ポート抽出**:
   - **Docker Compose**: `services.*.ports` から抽出、service 名から環境変数名を推定 (`db` → `DB_PORT` 等)
   - **Go**: `.env` 内の `PORT`/`SERVER_PORT`/`HTTP_PORT`、ソース内の `:8080` 等のリテラル (`grep -nE ':[0-9]{4,5}'`)
   - **Vite**: `vite.config.*` の `server.port`、`package.json` scripts の `--port`、見つからなければ 5173 をデフォルト
   - 抽出失敗時は AskUserQuestion でユーザーに確認
4. **環境変数名の命名規則**:
   - Docker サービス名から: `db` → `DB_PORT`, `db_dev` → `DB_DEV_PORT`, `redis` → `REDIS_PORT`
   - 接尾辞: `nginx` を含む service は `NGINX_*_PORT`, `php-fpm` 系は `PHP_*_PORT`
   - Go: `SERVER_PORT` または `GO_API_PORT`（service 名から）
   - Vite: `VITE_PORT` または `<app-name>_PORT`
5. **健康チェック推定**:
   - Go: `GET ${SERVER_PORT}/healthz` または `GET ${SERVER_PORT}/`
   - Vite: `GET ${VITE_PORT}/`
   - Docker Compose: 各 service の `ports` から推定（root path への HTTP 接続、または `pg_isready` / `redis-cli ping` を smoke として登録）
6. **`depends_on` の推定**:
   - Docker Compose の `services.*.depends_on` を継承
   - Go/Vite は `postgres` 系 service が存在すれば自動で `depends_on: [postgres]`
7. `.dev-up.yaml` の草案を Write
8. AskUserQuestion で以下を確認:
   - project 名（デフォルト: ディレクトリ名の kebab-case）
   - slot_range / offset_per_slot を変更するか
   - 検出した service 一覧（名前・type・コマンド・ポート）が正しいか
   - urls の label を変更するか
   - smoke[*] を採用するか
9. 承認後:
   - 各 Docker Compose ファイルを Edit して ports を `${VAR:-default}` 形式に書き換え
   - `command` type の service については、既存 env ファイルを破壊しない（読み取り専用で継承）
   - `.gitignore` に `.env.dispatch`, `.e2e-results/`, `.e2e-scenarios/`, `.dev-up-logs/` を追記
10. ユーザーに「`dev-up up` で起動できます」と案内

setup の実装はすべて Claude (LLM) のロジックで、bash スクリプト側に複雑な処理を入れない。

#### B-7. ポート計算

`port = base + (offset_per_slot * SLOT)`

`offset_per_slot=100`, `slot_range=[1,9]` の場合、スロット 9 まで使ってもポート 4 桁の範囲を超えない。`slot_range` を拡張する場合（例: `[1, 20]`）は `offset_per_slot` も合わせて見直すこと（setup 時にバリデーション、サービス間で計算後のポートが重ならないこと）。

#### B-8. .env.dispatch のスキーマ

```bash
COMPOSE_PROJECT_NAME=<project>-<slot>
SLOT=<slot>
PROJECT=<project>
WORKTREE_ROOT=<abs path>
<PORT_NAME_1>=<computed>      # docker-compose の ports
<PORT_NAME_2>=<computed>      # command の env_overrides
...
```

すべての service の port / env_override が単一の `.env.dispatch` に集約される。各 command service の env は **`env_files` → `.env.dispatch` → `env_overrides`** の優先順でマージされて起動時に渡される（優先度が高い方が後勝ち）。

### C. `e2e-test` skill

#### C-1. SKILL.md フロントマター

```yaml
---
name: e2e-test
description: >
  Run agent-browser based E2E tests against the worktree-isolated stack
  brought up by dev-up. Reads .env.dispatch for URLs and uses
  --session <project>-<slot> so each worktree has its own browser
  context (cookies, storage, history). Scenarios are bash files in
  .e2e-scenarios/ written dynamically by the child Claude per ticket.
  Run `install` once to install agent-browser globally.
argument-hint: "[install|run <scenario-name>|snapshot|teardown]"
---
```

#### C-2. サブコマンド

| サブコマンド | 動作 |
|--------------|------|
| `install`    | `npm i -g agent-browser && agent-browser install` を 1 回実行 |
| `run <scenario-name>` | `.env.dispatch` を source → `AGENT_BROWSER_SESSION=<project>-<slot>` を export → `<worktree-root>/.e2e-scenarios/<scenario-name>.sh` を bash で実行。`<scenario-name>` は拡張子なしの単一トークン |
| `snapshot`   | `agent-browser --session <project>-<slot> snapshot --json` を呼ぶ薄いラッパー |
| `teardown`   | `agent-browser --session <project>-<slot> close` でセッションを閉じる |

#### C-3. シナリオファイル

`.e2e-scenarios/<scenario-name>.sh` は child Claude がチケット内容に応じて動的に書く。skill は中身に関与しない。

シナリオファイル内で利用できる環境変数（run.sh が export する）:
- `AGENT_BROWSER_SESSION` (`<project>-<slot>`)
- `SLOT`
- `PROJECT`
- `WORKTREE_ROOT`
- `RESULTS_DIR` (`.e2e-results/<scenario-name>/`、自動 mkdir 済み)
- `.env.dispatch` のすべての PORT 変数

シナリオの典型例:

```bash
#!/usr/bin/env bash
# .e2e-scenarios/login-flow.sh
set -euo pipefail

agent-browser --session "$AGENT_BROWSER_SESSION" open "http://localhost:$VITE_PORT/login"
agent-browser --session "$AGENT_BROWSER_SESSION" snapshot --json > "$RESULTS_DIR/01-login.json"
agent-browser --session "$AGENT_BROWSER_SESSION" fill --ref e3 "test@example.com"
agent-browser --session "$AGENT_BROWSER_SESSION" fill --ref e4 "password"
agent-browser --session "$AGENT_BROWSER_SESSION" click --ref e5
agent-browser --session "$AGENT_BROWSER_SESSION" wait --url-contains "/dashboard" --timeout 10
agent-browser --session "$AGENT_BROWSER_SESSION" screenshot --path "$RESULTS_DIR/02-dashboard.png"
```

#### C-4. 結果の保存

`<worktree-root>/.e2e-results/<scenario-name>/` 配下に snapshot/screenshot/console.log を保存。`report.md` は child Claude が書く（skill 外）。

ディレクトリは `.gitignore` で無視（setup 時に追記）。

### D. marketplace.json への登録

`yui-cc-plugins/.claude-plugin/marketplace.json` の `plugins` 配列に 2 エントリを追加:

```json
{
  "name": "dev-up",
  "description": "Worktree-isolated dev stack lifecycle. Reserve a port slot, generate .env.dispatch, and run docker-compose stacks and/or direct commands (go, vite, etc.) with health checks and clean teardown.",
  "source": "./apps/dev-up",
  "version": "1.0.0",
  "license": "MIT",
  "category": "development",
  "tags": ["docker", "compose", "worktree", "cmux", "vite", "go"]
},
{
  "name": "e2e-test",
  "description": "agent-browser based E2E tests against worktree-isolated stacks brought up by dev-up.",
  "source": "./apps/e2e-test",
  "version": "1.0.0",
  "license": "MIT",
  "category": "development",
  "tags": ["e2e", "browser", "agent-browser"]
}
```

### E. プロジェクト統合（リファレンス実装）

#### E-1. freelance-jp-app（Docker Compose のみ）

- `compose.yaml` / `compose.all.yaml`: ports を `${VAR:-default}` 形式に書き換え（setup が自動編集）
- `.dev-up.yaml`: 1 つの docker-compose service のみ
- `.gitignore`: skill 用エントリ追記

#### E-2. influencer-platform（Docker + Go + TypeScript）

- `compose.yaml`: ports を `${VAR:-default}` 形式に書き換え
- `.dev-up.yaml`: 3 service（postgres docker-compose, go-api command, vite command）
- `go/.env`: そのまま継承（env_files で参照）
- `typescript/apps/*/.env`: そのまま継承（env_files で参照）
- `.gitignore`: skill 用エントリ追記

## Data Flow

### dev-up setup フロー

```
[user] dev-up setup
   │
   ▼
[Claude reads references/setup-guide.md]
   │
   ▼
[detect project root → 並列スキャン:
   - compose*.yaml, docker-compose*.yaml
   - go.mod + main.go/cmd/*/main.go + Taskfile.yml の dev
   - package.json scripts.dev + vite.config.*
   - .env, .env.local, .env.development, subdirs/.env]
   │
   ▼
[ports/env を抽出、命名規則で env 変数名を推定]
   │
   ▼
[health_check の推定 (Go=/healthz, Vite=/, DB=pg_isready)]
   │
   ▼
[depends_on を Compose と postgres ヒューリスティクスから推定]
   │
   ▼
[write .dev-up.yaml draft]
   │
   ▼
[AskUserQuestion: project name, slot_range, services 一覧の正誤,
                  urls labels, smoke[]]
   │
   ▼
[Edit compose.yaml(s): ports → ${VAR:-default}]
[Edit .gitignore: add .env.dispatch, .e2e-results/, .e2e-scenarios/, .dev-up-logs/]
   │
   ▼
[案内: "Now run `dev-up up`"]
```

### dev-up up フロー

```
[child Claude] dev-up up [--slot-range MIN-MAX]
   │
   ▼
[scripts/compose-up.sh]
   │
   ▼
[lib/parse-config.sh: yq で .dev-up.yaml を読み bash 配列に]
   │
   ▼
[reserve-slot.sh <project> [--slot-range ...]]
   ├─ ゾンビ掃除 (worktree 不在 or compose project 空 or PID 死亡)
   └─ mkdir で SLOT 番号予約
   │
   ▼
[lib/render-env.sh: 全 service の ports/env_overrides を base + offset*SLOT で展開
   → .env.dispatch を生成]
   │
   ▼
[lib/topo-sort.sh: services[*].depends_on を tsort で起動順序決定
   → 循環があれば exit 1]
   │
   ▼
[各 service を起動順に処理:]
   ├─ type=docker-compose:
   │    docker compose -f <files...> --env-file .env.dispatch
   │      -p <project>-<slot> up -d --wait
   │
   └─ type=command:
        lib/spawn-command.sh で:
          ├─ env マージ: env_files → .env.dispatch → env_overrides
          ├─ cwd に移動
          ├─ setsid-compat.sh で session leader として spawn
          ├─ stdout/stderr を log_file にリダイレクト
          ├─ PID/PGID を processes.json に追記
          └─ health_check があれば lib/wait-health.sh で PASS 待ち
              (timeout 超過 → exit 1, ログパスを案内)
   │
   ▼
[lib/smoke.sh: smoke[*] を kind で分岐実行 → WARN-only]
   │
   ▼
[lib/render-urls.sh: urls[*].template → 表形式出力]
```

### dev-up down フロー

```
[child Claude] dev-up down
   │
   ▼
[.env.dispatch から SLOT, PROJECT を取得]
   │
   ▼
[processes.json から service 一覧を 起動の逆順 で取得]
   │
   ▼
[各 command service:
   lib/kill-pgid.sh <pgid>:
     ├─ kill -TERM -<pgid>
     ├─ 5 秒待機
     └─ kill -0 で生存確認 → 残ってれば kill -KILL -<pgid>]
   │
   ▼
[docker compose -p <project>-<slot> down]
   │
   ▼
[release-slot.sh <project> <slot>]
   │   └─ slots/<slot>/ を丸ごと削除 (processes.json も同時に消える)
   ▼
[rm .env.dispatch (worktree root から)]
```

### e2e-test run フロー

```
[child Claude] e2e-test run <scenario-name>
   │
   ▼
[scripts/run.sh]
   │
   ▼
[.env.dispatch を source]
[AGENT_BROWSER_SESSION=<project>-<slot> を export]
[RESULTS_DIR=<worktree-root>/.e2e-results/<scenario-name>/ を mkdir + export]
   │
   ▼
[bash <worktree-root>/.e2e-scenarios/<scenario-name>.sh]
   │
   ▼
[agent-browser コマンド群が --session 付きで実行]
   │
   ▼
[snapshot/screenshot を $RESULTS_DIR に保存]
   │
   ▼
[child Claude が report.md を書く (skill 外の責務)]
```

## Error Handling

| エラー | 動作 |
|--------|------|
| `.dev-up.yaml` 不存在 (`up`/`status`/`urls`) | exit 1、`dev-up setup` を案内 |
| `yq` 未インストール | exit 1、`brew install yq` を案内 |
| 全スロット予約済み | exit 1、未使用 worktree で `dev-up down` を案内。`--slot-range` で範囲拡張も提案 |
| `docker compose up` 失敗 | スロット予約維持、ユーザーが `dev-up down` で明示解放 |
| `command` 起動失敗（spawn 直後に死亡） | spawn 直後 1 秒で `kill -0` チェック、死んでいたら exit 1、ログパスを表示 |
| `health_check` timeout | exit 1、log_file パスを案内。spawn 済みプロセスは down フローで停止される |
| `depends_on` 循環 | `topo-sort.sh` の tsort 失敗で exit 1 |
| `env_files` 不存在 | exit 1、明示的なパス情報を出力 |
| `setsid` も `perl` も無い | exit 1、perl のインストールを案内 |
| `.env.dispatch` 既存 (`up`) | compose project や processes が生きていれば既起動扱い (URL 再表示)、なければ古い残骸として削除→再 up |
| smoke test 失敗 | WARN のみ、exit 0 を維持 |
| `agent-browser` 未インストール (`e2e-test run`) | exit 1、`e2e-test install` を案内 |
| `.e2e-scenarios/<scenario-name>.sh` 不存在 | exit 1、シナリオファイル作成を案内 |
| `.env.dispatch` 不存在 (`e2e-test run`) | exit 1、`dev-up up` を先に実行する案内 |
| ゾンビスロット検出 | 自動回収 (reserve-slot.sh のプレフェーズ): worktree 不在 / compose project 空 / processes.json の全 PID が死亡 |

## Smoke Test vs Health Check

役割を明確に分ける:

- **`services[*].health_check`**: 各 service の **起動完了判定**（up 時に PASS まで待つ、timeout で exit 1）
- **トップレベル `smoke[]`**: 全 service 起動後の **最終疎通確認**（WARN-only、失敗しても exit 0）

両方を持つことで、起動失敗を確実に検知しつつ、運用上の警告は柔軟に扱える。

`smoke.sh` の kind 実装:

| kind   | 実装 |
|--------|------|
| http   | `curl -fsS --max-time 5 <target> -o /dev/null` |
| pg     | `pg_isready -h <host> -p <port> -U <user> -t 5 > /dev/null 2>&1` |
| redis  | `redis-cli -h <host> -p <port> ping > /dev/null` |

`wait-health.sh` の kind 実装:

| kind | 実装 |
|------|------|
| http | `curl -fsS --max-time 2 <target> -o /dev/null` を `interval` 秒ごとに `timeout` 秒までリトライ |
| tcp  | `nc -z <host> <port>` を同様にリトライ |

## macOS setsid 対応

macOS には標準で `setsid` がない（util-linux 由来）。`lib/setsid-compat.sh` で OS 差を吸収:

```bash
if command -v setsid >/dev/null 2>&1; then
  exec setsid "$@"
elif command -v perl >/dev/null 2>&1; then
  exec perl -e 'use POSIX qw(setsid); setsid; exec @ARGV' -- "$@"
else
  echo "ERROR: neither setsid nor perl available; cannot start session leader" >&2
  exit 1
fi
```

perl は macOS 標準で入っているため追加インストール不要。Linux/util-linux 環境では setsid が優先される。

## Integration with cmux-team-dispatch-task

cmux 側は無改修。dispatch を呼ぶ際のタスク記述テンプレに下記を含める運用とする:

```
動作確認するときは Bash で以下を実行してください:

1. dev-up up                # 全 service 起動、URL 表示
2. (実装作業)
3. (画面チケットの場合) e2e-test run <scenario-name>
   - 事前に .e2e-scenarios/<scenario-name>.sh をチケット内容に応じて作成
   - 結果は .e2e-results/<scenario-name>/ に保存される
4. dev-up down              # 全 service 停止、スロット解放

URL 一覧と E2E テスト結果サマリを result.md の
"## Verification" セクションに転記してください。
```

## Lifecycle

```
[cmux dispatch 開始]
   │
   ▼
[worktree <slug> で child Claude 起動]
   │
   ▼
[child] dev-up up
   ├─ スロット予約 (例: SLOT=1)
   ├─ .env.dispatch 生成
   ├─ services を topological sort
   ├─ docker-compose service を docker compose up -d --wait
   └─ command service を setsid spawn → health_check 待ち
   │
   ▼
[child] 実装
   │
   ▼ (画面チケットのみ)
[child] .e2e-scenarios/<scenario-name>.sh を動的生成
[child] e2e-test run <scenario-name>
   ├─ agent-browser --session <project>-1 で操作
   └─ .e2e-results/<scenario-name>/ に保存
   │
   ▼
[ユーザー] (任意) claude --chrome で URL を開き最終目視
   │
   ▼
[child] e2e-test teardown (任意)
[child] dev-up down
   ├─ command service を起動逆順に PGID kill (SIGTERM→5s→SIGKILL)
   ├─ docker-compose service を down
   ├─ スロット解放
   └─ .env.dispatch 削除
   │
   ▼
[cmux dispatch cleanup]
```

## Manual Verification Checklist

実装完了後の手動検証項目:

1. **Docker Compose only プロジェクトの setup**
   - freelance-jp-app で `dev-up setup` → 1 service (docker-compose) の `.dev-up.yaml` が生成、compose.yaml が `${VAR:-default}` 化
2. **Multi-service (Docker + Go + Vite) プロジェクトの setup**
   - influencer-platform で `dev-up setup` → 3 service の `.dev-up.yaml` が生成、Go の env_files、Vite の env_overrides、depends_on が正しく設定
3. **既定ポートで起動**
   - メイン worktree で従来通り `docker compose up` を実行 → 既定ポートで起動（dev-up を介さない場合）
4. **dev-up up → dev-up down (Docker only)**
   - SLOT=1 のポートで docker stack が起動、`.env.dispatch` 生成、`dev-up down` で停止と解放
5. **dev-up up → dev-up down (Multi-service)**
   - SLOT=1 のポートで docker + go + vite が起動順に立ち上がる
   - health_check が PASS してから次の service が起動する
   - `dev-up down` で起動の逆順に停止
6. **2 worktree 並列**
   - worktree A: SLOT=1, worktree B: SLOT=2、両方の Go/Vite/DB に同時アクセス可
7. **mkdir-atomic な race condition**
   - 2 プロセスが同時に reserve-slot.sh を実行しても同一スロットが二重予約されない
8. **ゾンビ回収 (PID 死亡パターン)**
   - command service の PID を手動で kill → 新規 `dev-up up` がそのスロットを回収
9. **満杯時のエラー + --slot-range 拡張**
   - 9 スロット予約済みで 10 番目の `dev-up up` → exit 1
   - 同じ状態で `dev-up up --slot-range 1-20` → SLOT=10 で起動
10. **health_check timeout**
    - 起動失敗するサービス (例: 故意に invalid port) で `dev-up up` → timeout 後 exit 1、ログパス案内
11. **depends_on 順序**
    - postgres → go-api → vite の順で起動、down は逆順
12. **macOS / Linux 両方で動く**
    - macOS では perl 経由、Linux では setsid 経由で session leader が作られる
13. **メイン worktree との共存**
    - メインの 35432 と dev-up の 35532 が並存
14. **e2e-test install**
    - `e2e-test install` で agent-browser がインストール
15. **e2e-test run の並列分離**
    - 2 worktree で同時 `e2e-test run` → セッションが `<project>-1` / `<project>-2` で分離
16. **シナリオファイル不存在 / scenario name 不正**
    - 明示的エラー、案内文表示
17. **e2e-test teardown**
    - セッションが閉じる

## Open Questions

なし。

## Files Touched

### yui-cc-plugins リポジトリ (新規)

- `apps/dev-up/.claude-plugin/plugin.json`
- `apps/dev-up/.codex-plugin/plugin.json`
- `apps/dev-up/skills/dev-up/SKILL.md`
- `apps/dev-up/skills/dev-up/scripts/setup.sh`
- `apps/dev-up/skills/dev-up/scripts/reserve-slot.sh`
- `apps/dev-up/skills/dev-up/scripts/release-slot.sh`
- `apps/dev-up/skills/dev-up/scripts/compose-up.sh`
- `apps/dev-up/skills/dev-up/scripts/compose-down.sh`
- `apps/dev-up/skills/dev-up/scripts/urls.sh`
- `apps/dev-up/skills/dev-up/scripts/status.sh`
- `apps/dev-up/skills/dev-up/scripts/lib/parse-config.sh`
- `apps/dev-up/skills/dev-up/scripts/lib/render-env.sh`
- `apps/dev-up/skills/dev-up/scripts/lib/render-urls.sh`
- `apps/dev-up/skills/dev-up/scripts/lib/smoke.sh`
- `apps/dev-up/skills/dev-up/scripts/lib/spawn-command.sh`
- `apps/dev-up/skills/dev-up/scripts/lib/wait-health.sh`
- `apps/dev-up/skills/dev-up/scripts/lib/topo-sort.sh`
- `apps/dev-up/skills/dev-up/scripts/lib/kill-pgid.sh`
- `apps/dev-up/skills/dev-up/scripts/lib/setsid-compat.sh`
- `apps/dev-up/references/setup-guide.md`
- `apps/dev-up/README.md`
- `apps/dev-up/CLAUDE.md`
- `apps/dev-up/LICENSE`
- `apps/e2e-test/.claude-plugin/plugin.json`
- `apps/e2e-test/.codex-plugin/plugin.json`
- `apps/e2e-test/skills/e2e-test/SKILL.md`
- `apps/e2e-test/skills/e2e-test/scripts/install.sh`
- `apps/e2e-test/skills/e2e-test/scripts/run.sh`
- `apps/e2e-test/skills/e2e-test/scripts/snapshot.sh`
- `apps/e2e-test/skills/e2e-test/scripts/teardown.sh`
- `apps/e2e-test/README.md`
- `apps/e2e-test/CLAUDE.md`
- `apps/e2e-test/LICENSE`
- `.claude-plugin/marketplace.json` (2 entries 追加)

### freelance-jp-app リポジトリ (リファレンス: Docker only)

- `compose.yaml` (modified by `dev-up setup`)
- `compose.all.yaml` (modified by `dev-up setup`)
- `.gitignore` (modified by `dev-up setup`)
- `.dev-up.yaml` (created by `dev-up setup`)

### influencer-platform リポジトリ (リファレンス: Docker + Go + Vite)

- `compose.yaml` (modified by `dev-up setup`)
- `.gitignore` (modified by `dev-up setup`)
- `.dev-up.yaml` (created by `dev-up setup`)

## Out of Scope

- `cmux-team-dispatch-task` skill 本体の改修
- ヘルスチェック標準化（プロジェクト側の責務、設定で吸収）
- Browser Use の採用
- Playwright の採用
- Claude Chrome の skill 化
- 複雑な service 依存管理（条件付き再起動、サービスメッシュ、リトライポリシー等）
- Windows ネイティブ対応（WSL は対象外、cmux-team-dispatch-task と同じ前提）
- `health_check.kind` の追加（log パターン待ち等）は将来拡張
