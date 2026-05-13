# Generic dev-up and e2e-test Skills Design

**Date**: 2026-05-13
**Status**: Draft
**Topic**: cmux-team-dispatch-task で並列起動された worktree 同士の docker compose ポート衝突を解消する汎用 skill 群 (dev-up) と、それと連携する agent-browser ベースの E2E テスト skill (e2e-test) を `yui-cc-plugins/apps/` に追加する

---

## Problem

`cmux-team-dispatch-task` は 1 タスク = 1 git worktree でディスパッチする汎用オーケストレーターである。child Claude セッションは `.worktrees/<slug>/` で独立してコード変更を行えるが、典型的なプロジェクトの `compose.yaml` のホスト側ポートは固定なため、複数 worktree から同時に `docker compose up` するとポートが衝突して 2 つ目以降の動作確認ができない。

さらに、画面を含むタスクで動作確認を自動化したいが、Browser Use は Anthropic API キーが別途必要で Max プラン枠で完結しない。Claude Chrome は可視ブラウザ前提で並列に複数 worktree を同時テストできない。

この 2 つの課題を、freelance-jp-app に固有ではなく **どのプロジェクトでも使える汎用 skill** として解決する。

## Goals

1. 各 worktree で `docker compose up` がポート衝突なしに並列起動できる
2. 並列 dispatch された worktree それぞれで E2E テストを並列実行できる（ヘッドレス、Cookie/storage を完全分離）
3. 上記 2 つの skill は **freelance-jp-app 固有のハードコードを持たず**、プロジェクト側の宣言的設定 (`.dev-up.yaml`) だけで動作する
4. 新規プロジェクトに導入する際は **`dev-up setup` で `.dev-up.yaml` を自動生成** できる（Claude が compose.yaml を解析）
5. `cmux-team-dispatch-task` は無改修
6. Claude Max プラン枠で完結（追加 API 課金なし）

## Non-goals

- Docker レベルでの動的ポート（`- "5432"` 形式）への移行はしない。URL を予測可能に保つことを優先する。
- 並列スロット数は当面 9 とし、それ以上の並列度はサポート対象外とする。
- Browser Use の採用はしない（Max プラン枠で完結しないため）。
- Playwright の採用はしない（agent-browser で要件をカバーできるため依存を増やさない）。
- Claude Chrome の skill 化はしない（ユーザー側の最終目視ツールとして運用ドキュメントに記載のみ）。
- プロジェクトのヘルスチェックエンドポイント標準化はしない（プロジェクト側の責務）。

## Approach

`yui-cc-plugins/apps/` 配下に **2 つの汎用 plugin** を追加する:

- `apps/dev-up/`: `.dev-up.yaml` を読んで compose stack をスロット予約付きで起動・停止する skill
- `apps/e2e-test/`: dev-up が生成した `.env.dispatch` を読み、agent-browser を `--session <project>-<slot>` で呼ぶ薄いラッパー skill

プロジェクト側の責務:
- `.dev-up.yaml` を 1 ファイル置く（`dev-up setup` で自動生成可能）
- `compose.yaml` のホスト側ポートを `${VAR:-default}` 形式に書き換える（`dev-up setup` で自動編集可能）

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
│          compose-up.sh, compose-down.sh, urls.sh,           │
│          status.sh, lib/parse-config.sh, lib/render-env.sh, │
│          lib/render-urls.sh, lib/smoke.sh                   │
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
│ プロジェクト (例: freelance-jp-app)                          │
│  .dev-up.yaml          ← プロジェクト固有設定                │
│  compose.yaml          ← ports を ${VAR:-default} 化         │
│  .gitignore            ← .env.dispatch, .e2e-results/        │
└─────────────────────────────────────────────────────────────┘
                            │ git worktree add (by cmux-team-dispatch-task)
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ .worktrees/<slug>/  (child Claude)                          │
│   1. dev-up up → スロット予約 → .env.dispatch 生成           │
│      → docker compose up -d --wait                          │
│   2. 実装                                                    │
│   3. (画面チケットのみ) e2e-test run <scenario>              │
│      → agent-browser --session <project>-<slot> で操作       │
│      → .e2e-results/<slug>/ に保存                           │
│   4. dev-up down → コンテナ停止 + スロット解放               │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
            ┌──────────────────────────────────┐
            │ ~/.cache/cc-skills/dev-up/       │
            │   <project>/slots/<N>/owner.json │
            └──────────────────────────────────┘
```

### 責務分離

- `cmux-team-dispatch-task`: ポート知識ゼロの汎用オーケストレーター（無改修）
- `dev-up`: `.dev-up.yaml` を読んでスロット予約と compose 起動を担当（プロジェクト固有情報を持たない）
- `e2e-test`: `.env.dispatch` を読んで agent-browser を呼ぶ薄いラッパー（プロジェクト固有のシナリオは持たない）
- プロジェクトの `.dev-up.yaml`: プロジェクト固有のポートと URL 設定を宣言

## Components

### A. `.dev-up.yaml` (プロジェクト側に置く設定ファイル)

スキーマ:

```yaml
project: <string>           # スロットレジストリのキー (kebab-case 推奨)
slot_range: [1, 9]          # 同時並列スロット数の範囲
offset_per_slot: 100        # ポートオフセット幅 (base + N * offset)
compose:
  files: [<string>]         # docker compose -f に渡す。複数可。
ports:                      # スロット番号に応じて環境変数として展開
  - { name: <ENV_NAME>, base: <int> }
urls:                       # urls/status サブコマンドの出力テンプレート
  - { label: <string>, template: <string> }  # template 内で ${PORT_NAME} を参照可
smoke:                      # 起動後の疎通確認 (任意。空配列も可)
  - { kind: http,  target: "http://localhost:${PORT_NAME}<path>" }
  - { kind: pg,    target: "localhost:${PORT_NAME}", user: <string> }
  - { kind: redis, target: "localhost:${PORT_NAME}" }
```

`kind` の取りうる値: `http`, `pg`, `redis`。それ以外は WARN を出してスキップする。

### B. `dev-up` skill

#### B-1. SKILL.md フロントマター

```yaml
---
name: dev-up
description: >
  Bring up an isolated docker compose stack per git worktree. Reserves a
  port slot from a shared registry, writes .env.dispatch, then runs
  docker compose with a unique COMPOSE_PROJECT_NAME. Use when verifying
  the running app inside a worktree spawned by cmux-team-dispatch-task,
  or whenever you need parallel stacks without port collisions. Run the
  `setup` subcommand once per new project to generate .dev-up.yaml from
  the existing compose.yaml.
argument-hint: "[setup|up|down|status|urls]"
---
```

#### B-2. サブコマンド

| サブコマンド | 動作 |
|--------------|------|
| `setup`  | Claude が `compose.yaml` を解析 → `.dev-up.yaml` 草案を Write → AskUserQuestion で確認 → `compose.yaml` の ports を `${VAR:-default}` 形式に書き換え → `.gitignore` 追記 |
| `up` (default) | ゾンビ掃除 → スロット予約 → `.env.dispatch` 生成 → `docker compose up -d --wait` → smoke → URL 出力 |
| `down`   | `docker compose down` → スロット解放 → `.env.dispatch` 削除 |
| `status` | 現在のスロット番号、起動中サービス、URL 一覧を出力 |
| `urls`   | URL 一覧のみ出力（slot 未予約ならエラー） |

#### B-3. スロットレジストリ

パス: `~/.cache/cc-skills/dev-up/<project>/slots/<N>/owner.json`

`<project>` は `.dev-up.yaml` の `project:` フィールド。プロジェクトを跨いでも衝突しない。

`owner.json`:

```json
{
  "pid": 12345,
  "worktree": "/abs/path/to/.worktrees/feature-x",
  "compose_project": "<project>-1",
  "reserved_at": "2026-05-13T10:00:00Z"
}
```

#### B-4. スクリプトの責務

| スクリプト | 責務 |
|------------|------|
| `setup.sh` | SKILL.md のセットアップ手順を Claude が読みやすい形に表示するだけ。実体の処理は Claude (LLM) が SKILL.md と `references/setup-guide.md` を読んで自走 |
| `reserve-slot.sh <project>` | ゾンビ掃除 → `slot_range` を順に `mkdir` で予約試行 → stdout に SLOT 番号 |
| `release-slot.sh <project> <slot>` | `slots/<slot>/` を削除 |
| `compose-up.sh` | `.dev-up.yaml` を `lib/parse-config.sh` で読む → reserve-slot.sh → `lib/render-env.sh` で `.env.dispatch` 生成 → `docker compose -f <files...> --env-file .env.dispatch -p <project>-<slot> up -d --wait` → `lib/smoke.sh` → `lib/render-urls.sh` で URL 表示 |
| `compose-down.sh` | `.env.dispatch` から `<project>` と `<slot>` を取得 → `docker compose -p <project>-<slot> down` → release-slot.sh → `.env.dispatch` 削除 |
| `urls.sh` | `.env.dispatch` を `source` → `lib/render-urls.sh` で `.dev-up.yaml` の `urls` を展開出力 |
| `status.sh` | `.env.dispatch` を `source` → `docker compose -p <project>-<slot> ps` + urls.sh |
| `lib/parse-config.sh` | yq で `.dev-up.yaml` をパースし、bash で扱える形 (環境変数配列等) に展開 |
| `lib/render-env.sh` | ports[*].name と ports[*].base、SLOT 番号、project から `.env.dispatch` を生成 |
| `lib/render-urls.sh` | urls[*].template の `${VAR}` を `.env.dispatch` の値で展開して表形式で出力 |
| `lib/smoke.sh` | smoke[*].kind に応じて curl / pg_isready / redis-cli を呼び分け、WARN レベルでエラー出力 |

#### B-5. setup の動作詳細

`dev-up setup` が呼ばれたら Claude は `references/setup-guide.md` を読み、以下を自走する:

1. `git rev-parse --show-toplevel` でプロジェクトルートを検出
2. プロジェクトルートで `compose.yaml`, `compose.yml`, `compose.all.yaml` を探索 (Glob)
3. 各 compose ファイルを Read し、`services.*.ports` を抽出
4. ホスト側ポートと service 名から環境変数名を推定する命名規則:
   - service 名から推定: `db` → `DB_PORT`, `db_dev` → `DB_DEV_PORT`, `redis` → `REDIS_PORT`
   - 接尾辞: `nginx` を含む service は `NGINX_*_PORT`, `php-fpm` 系は `PHP_*_PORT`
   - 同一 service で複数ポートある場合は用途別接尾辞 (`*_WEB_PORT`, `*_SMTP_PORT`)
5. `.dev-up.yaml` の草案を Write
6. AskUserQuestion で以下を確認:
   - project 名（デフォルト: ディレクトリ名の kebab-case）
   - slot_range / offset_per_slot を変更するか
   - urls の label を変更するか
   - smoke[*] を採用するか（推奨値は提示するが拒否可能）
7. 承認後、各 compose ファイルを Edit して ports を `${VAR:-default}` に書き換え
8. `.gitignore` に `.env.dispatch`、`.e2e-results/`、`.e2e-scenarios/`を追記（存在しなければ）
9. ユーザーに「`dev-up up` で起動できます」と案内

setup の実装はすべて Claude (LLM) のロジックで、bash スクリプト側に複雑な処理を入れない。setup.sh は単に SKILL.md/references を読むよう促すだけ。

#### B-6. ポート計算

`port = base + (offset_per_slot * SLOT)`

`offset_per_slot=100`, `slot_range=[1,9]` の場合、スロット 9 まで使ってもポート 4 桁の範囲を超えない。同 service の base 値が 100 未満で隣接していると衝突するため、setup 時にバリデーション（同 base に対する SLOT=1..max でのポートが他 service と重ならないこと）を行う。

#### B-7. .env.dispatch のスキーマ

```bash
COMPOSE_PROJECT_NAME=<project>-<slot>
SLOT=<slot>
PROJECT=<project>
<PORT_NAME_1>=<computed>
<PORT_NAME_2>=<computed>
...
```

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
argument-hint: "[install|run <scenario>|snapshot|teardown]"
---
```

#### C-2. サブコマンド

| サブコマンド | 動作 |
|--------------|------|
| `install`    | `npm i -g agent-browser && agent-browser install` を 1 回実行 |
| `run <scenario-name>` | `.env.dispatch` を source → `AGENT_BROWSER_SESSION=<project>-<slot>` を export → `<worktree-root>/.e2e-scenarios/<scenario-name>.sh` を bash で実行。`<scenario-name>` は拡張子なしの単一トークン (例: `login-flow`) |
| `snapshot`   | `agent-browser --session <project>-<slot> snapshot --json` を呼ぶ薄いラッパー（任意の URL を引数で渡せる） |
| `teardown`   | `agent-browser --session <project>-<slot> close` でセッションを閉じる |

#### C-3. シナリオファイル

`.e2e-scenarios/<slug>.sh` は child Claude がチケット内容に応じて動的に書く。skill は中身に関与しない。

シナリオファイル内で利用できる環境変数（run.sh が export する）:

- `AGENT_BROWSER_SESSION` (`<project>-<slot>`)
- `SLOT`
- `PROJECT`
- `RESULTS_DIR` (`.e2e-results/<slug>/`, 自動 mkdir 済み)
- `.env.dispatch` のすべての PORT 変数

シナリオの典型例:

```bash
#!/usr/bin/env bash
# .e2e-scenarios/login-flow.sh
set -euo pipefail

agent-browser --session "$AGENT_BROWSER_SESSION" open "http://localhost:$NGINX_USER_PORT/login"
agent-browser --session "$AGENT_BROWSER_SESSION" snapshot --json > "$RESULTS_DIR/01-login.json"
agent-browser --session "$AGENT_BROWSER_SESSION" fill --ref e3 "test@example.com"
agent-browser --session "$AGENT_BROWSER_SESSION" fill --ref e4 "password"
agent-browser --session "$AGENT_BROWSER_SESSION" click --ref e5
agent-browser --session "$AGENT_BROWSER_SESSION" wait --url-contains "/dashboard" --timeout 10
agent-browser --session "$AGENT_BROWSER_SESSION" screenshot --path "$RESULTS_DIR/02-dashboard.png"
```

#### C-4. 結果の保存

`<worktree-root>/.e2e-results/<slug>/` 配下に:
- `01-*.json`, `02-*.json` ... snapshot JSON
- `01-*.png`, `02-*.png` ... screenshot
- `console.log` ... 任意でシナリオから書き込み
- `report.md` ... child Claude がテスト後にまとめるレポート

ディレクトリは `.gitignore` で無視（setup 時に追記）。

### D. marketplace.json への登録

`yui-cc-plugins/.claude-plugin/marketplace.json` の `plugins` 配列に 2 エントリを追加:

```json
{
  "name": "dev-up",
  "description": "Worktree-isolated docker compose lifecycle. Reserve a port slot, generate .env.dispatch, run compose with unique project name.",
  "source": "./apps/dev-up",
  "version": "1.0.0",
  "license": "MIT",
  "category": "development",
  "tags": ["docker", "compose", "worktree", "cmux"]
},
{
  "name": "e2e-test",
  "description": "agent-browser based E2E tests against worktree-isolated stacks brought up by dev-up.",
  "source": "./apps/e2e-test",
  "version": "1.0.0",
  "license": "MIT",
  "category": "development",
  "tags": ["e2e", "browser", "agent-browser", "playwright-alternative"]
}
```

### E. freelance-jp-app 側の統合（リファレンス実装）

リポジトリの変更点:
- `compose.yaml` / `compose.all.yaml`: ports を `${VAR:-default}` 形式に書き換え（dev-up setup が自動編集）
- `.dev-up.yaml`: 新規作成（dev-up setup が自動生成）
- `.gitignore`: `.env.dispatch`, `.e2e-results/`, `.e2e-scenarios/` を追記

これらは setup 1 コマンドで完結する想定。

## Data Flow

### dev-up setup フロー

```
[user] dev-up setup
   │
   ▼
[Claude reads references/setup-guide.md]
   │
   ▼
[detect project root → glob compose*.yaml → parse services.*.ports]
   │
   ▼
[infer env var names from service names + heuristics]
   │
   ▼
[write .dev-up.yaml draft]
   │
   ▼
[AskUserQuestion: project name, slot_range, urls labels, smoke]
   │
   ▼
[Edit compose.yaml(s): ports → ${VAR:-default}]
   │
   ▼
[Edit .gitignore: add .env.dispatch, .e2e-results/, .e2e-scenarios/]
   │
   ▼
[案内: "Now run `dev-up up`"]
```

### dev-up up フロー

```
[child Claude] dev-up up
   │
   ▼
[scripts/compose-up.sh]
   │
   ▼
[lib/parse-config.sh: yq で .dev-up.yaml を読み bash 配列に]
   │
   ▼
[reserve-slot.sh <project>]
   ├─ ゾンビ掃除 (worktree 不在 or compose project 空)
   └─ mkdir で SLOT 番号予約
   │
   ▼
[lib/render-env.sh: ports[*].base + 100*SLOT → .env.dispatch]
   │
   ▼
[docker compose -f <files...> --env-file .env.dispatch -p <project>-<slot> up -d --wait]
   │
   ▼
[lib/smoke.sh: smoke[*] を kind で分岐実行 → WARN-only]
   │
   ▼
[lib/render-urls.sh: urls[*].template → 表形式出力]
```

### e2e-test run フロー

```
[child Claude] e2e-test run <scenario>
   │
   ▼
[scripts/run.sh]
   │
   ▼
[.env.dispatch を source → AGENT_BROWSER_SESSION=<project>-<slot> を export]
   │
   ▼
[mkdir .e2e-results/<slug>/ → RESULTS_DIR を export]
   │
   ▼
[bash .e2e-scenarios/<scenario>.sh]
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
| 全スロット予約済み | exit 1、未使用 worktree で `dev-up down` を案内 |
| `docker compose up` 失敗 | スロット予約維持、ユーザーが `dev-up down` で明示解放 |
| `.env.dispatch` 既存 (`up`) | compose project にコンテナがあれば既起動扱い (URL 再表示)、なければ古い残骸として削除→再 up |
| smoke test 失敗 | WARN のみ、exit 0 を維持 |
| `agent-browser` 未インストール (`e2e-test run`) | exit 1、`e2e-test install` を案内 |
| `.e2e-scenarios/<scenario>.sh` 不存在 | exit 1、シナリオファイル作成を案内 |
| `.env.dispatch` 不存在 (`e2e-test run`) | exit 1、`dev-up up` を先に実行する案内 |
| ゾンビスロット検出（worktree 不在 or 空 project） | 自動回収 (reserve-slot.sh のプレフェーズ) |

## Smoke Test

`lib/smoke.sh` は `.dev-up.yaml` の `smoke[*]` を kind ごとに分岐実行する:

| kind   | 実装 |
|--------|------|
| http   | `curl -fsS --max-time 5 <target> -o /dev/null` |
| pg     | `pg_isready -h <host> -p <port> -U <user> -t 5 > /dev/null 2>&1` |
| redis  | `redis-cli -h <host> -p <port> ping > /dev/null` |

すべて WARN レベル。1 つでも失敗しても skill は exit 0 を維持し、ユーザー判断に委ねる。

## Integration with cmux-team-dispatch-task

cmux 側は無改修。dispatch を呼ぶ際の **タスク記述テンプレ** に下記を含める運用とする:

```
動作確認するときは Bash で以下を実行してください:

1. dev-up up                # コンテナ起動、URL 表示
2. (実装作業)
3. (画面チケットの場合) e2e-test run <scenario-name>
   - 事前に .e2e-scenarios/<scenario-name>.sh をチケット内容に応じて作成
   - 結果は .e2e-results/<slug>/ に保存される
4. dev-up down              # コンテナ停止、スロット解放

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
   └─ docker compose up -d --wait
   │
   ▼
[child] 実装
   │
   ▼ (画面チケットの場合のみ)
[child] .e2e-scenarios/<slug>.sh を動的生成
[child] e2e-test run <slug>
   ├─ agent-browser --session <project>-1 で操作
   └─ .e2e-results/<slug>/ に保存
   │
   ▼
[ユーザー] (任意) claude --chrome で URL を開き最終目視
   │
   ▼
[child] e2e-test teardown (任意。次回 up 時にゾンビ回収されるので必須ではない)
[child] dev-up down
   │
   ▼
[cmux dispatch cleanup]
```

## Manual Verification Checklist

実装完了後の手動検証項目:

1. **新規プロジェクトで setup**
   - 任意の compose.yaml を持つプロジェクトで `dev-up setup` 実行 → `.dev-up.yaml` が生成され compose.yaml が `${VAR:-default}` 形式に書き換わる
2. **既定ポートで起動**
   - メイン worktree で従来通り `docker compose up` を実行 → 既定ポートで起動（dev-up を介さない場合）
3. **dev-up up → dev-up down**
   - メイン worktree で `dev-up up` → SLOT=1 のポートで起動、URL 表示、`.env.dispatch` 生成
   - `dev-up down` で停止、`.env.dispatch` 削除、スロット解放
4. **2 worktree 並列**
   - worktree A で `dev-up up` → SLOT=1, worktree B で `dev-up up` → SLOT=2、両方同時アクセス可
5. **mkdir-atomic な race condition**
   - 2 プロセスが同時に reserve-slot.sh を実行しても同一スロットが二重予約されない
6. **ゾンビ回収**
   - worktree を `dev-up down` せずに削除した後、新規 `dev-up up` がそのスロットを回収
7. **満杯時のエラー**
   - 9 スロット予約済みで 10 番目の `dev-up up` → 明示的エラー
8. **メイン worktree との共存**
   - メインの 35432 と dev-up の 35532 が並存
9. **e2e-test install**
   - `e2e-test install` で agent-browser がインストール、`agent-browser --version` が動く
10. **e2e-test run の並列分離**
    - 2 worktree で同時に `e2e-test run <scenario>` → セッションが `<project>-1` / `<project>-2` で分離、Cookie/storage が独立
11. **シナリオファイル不存在**
    - 存在しないシナリオを指定 → 明示的エラー、案内文表示
12. **e2e-test teardown**
    - `e2e-test teardown` でセッションが閉じる（`agent-browser --session <s> ps` で確認）

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

### freelance-jp-app リポジトリ (リファレンス実装)

- `compose.yaml` (modified by `dev-up setup`)
- `compose.all.yaml` (modified by `dev-up setup`)
- `.gitignore` (modified by `dev-up setup`)
- `.dev-up.yaml` (created by `dev-up setup`)

## Out of Scope

- `cmux-team-dispatch-task` skill 本体の改修
- ヘルスチェック標準化（プロジェクト側の責務）
- スロット数 10 以上への拡張
- Browser Use の採用
- Playwright の採用
- Claude Chrome の skill 化
- 他言語ランタイム（Python/Ruby/Go アプリ）の compose 起動サポート（kind=http で十分カバー可能）
