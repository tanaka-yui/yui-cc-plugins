# e2e-test

## Output Language

ユーザーへの質問・選択肢ラベル・表・進捗報告はすべて日本語で表示する。SKILL.md 本文が英語なのは記述の統一のためであり、ユーザーへの提示言語は変えない。

[agent-browser](https://www.npmjs.com/package/agent-browser) の薄いラッパーであり、`dev-up`
と組み合わせて worktree 隔離されたスタックに対して E2E テストを実行する。

## サブコマンド

| サブコマンド | 説明 |
|------------|-------------|
| `install` | `npm i -g agent-browser && agent-browser install`。マシンごとに一度だけ実行する。 |
| `run <scenario-name>` | `.env.dispatch` を source し、`AGENT_BROWSER_SESSION=<project>-<slot>` と `RESULTS_DIR=.e2e-results/<scenario-name>/` を export したうえで `.e2e-scenarios/<scenario-name>.sh` を実行する。`scenario-name` は `/` や `.` を含まない単一トークン。 |
| `snapshot [url]` | アクセシビリティスナップショットを取得する（任意で先に URL へ遷移）。 |
| `teardown` | この worktree の agent-browser セッションを閉じる。 |

## 呼び出し方

```bash
bash <skill-dir>/scripts/install.sh
bash <skill-dir>/scripts/run.sh login-flow
bash <skill-dir>/scripts/snapshot.sh "http://localhost:$VITE_PORT/dashboard"
bash <skill-dir>/scripts/teardown.sh
```

## シナリオファイルのテンプレート

シナリオは `<worktree-root>/.e2e-scenarios/<name>.sh` に置く。チケットごとに子 Claude が
動的に書く。このスキルはプロジェクト非依存。

シナリオから参照できる環境変数:
- `AGENT_BROWSER_SESSION` = `<project>-<slot>`
- `SLOT`、`PROJECT`、`WORKTREE_ROOT`
- `RESULTS_DIR` = `<worktree-root>/.e2e-results/<scenario-name>/`（自動 mkdir される）
- `.env.dispatch` 由来のすべての `*_PORT` 環境変数

`.e2e-scenarios/login-flow.sh` の例:

```bash
#!/usr/bin/env bash
set -euo pipefail

agent-browser --session "$AGENT_BROWSER_SESSION" open "http://localhost:$VITE_PORT/login"
agent-browser --session "$AGENT_BROWSER_SESSION" snapshot --json > "$RESULTS_DIR/01-login.json"
agent-browser --session "$AGENT_BROWSER_SESSION" fill --ref e3 "test@example.com"
agent-browser --session "$AGENT_BROWSER_SESSION" fill --ref e4 "password"
agent-browser --session "$AGENT_BROWSER_SESSION" click --ref e5
agent-browser --session "$AGENT_BROWSER_SESSION" wait --url-contains "/dashboard" --timeout 10
agent-browser --session "$AGENT_BROWSER_SESSION" screenshot --path "$RESULTS_DIR/02-dashboard.png"
```

その後、子 Claude が `$RESULTS_DIR/report.md` に何が起きたかをまとめて書く。

## 並列セッションの隔離

各 worktree は `--session <project>-<slot>` によって専用のブラウザコンテキストを持つ。
Cookie・localStorage・履歴・タブはセッション間で完全に隔離されるため、N 個の worktree が
互いに干渉せずに並行して E2E テストを実行できる。

## 失敗モード

| 状況 | 挙動 |
|-----------|----------|
| `.env.dispatch` が無い | Exit 1、先に `dev-up up` を実行するようヒントを出す。 |
| `agent-browser` 未インストール | Exit 1、`install` を実行するようヒントを出す。 |
| シナリオ名に `/` または `.` を含む | Exit 2、シナリオ名は単一トークンである必要がある。 |
| シナリオファイルが無い | Exit 1、解決済みパスとともにヒントを出す。 |
