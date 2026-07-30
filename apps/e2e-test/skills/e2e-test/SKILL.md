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

## Output Language

All user-facing questions, option labels, tables, and progress reports MUST be
rendered in Japanese. This file is written in English for consistency; it does
not change the language presented to the user.

# e2e-test

A thin wrapper around [agent-browser](https://www.npmjs.com/package/agent-browser)
that pairs with `dev-up` to run E2E tests against worktree-isolated stacks.

## Subcommands

| Subcommand | Description |
|------------|-------------|
| `install` | `npm i -g agent-browser && agent-browser install`. Run once per machine. |
| `run <scenario-name>` | Source `.env.dispatch`, export `AGENT_BROWSER_SESSION=<project>-<slot>` and `RESULTS_DIR=.e2e-results/<scenario-name>/`, then execute `.e2e-scenarios/<scenario-name>.sh`. `scenario-name` is a single token without `/` or `.`. |
| `snapshot [url]` | Take an accessibility snapshot (optionally navigate to a URL first). |
| `teardown` | Close the agent-browser session for this worktree. |

## How to invoke

```bash
bash <skill-dir>/scripts/install.sh
bash <skill-dir>/scripts/run.sh login-flow
bash <skill-dir>/scripts/snapshot.sh "http://localhost:$VITE_PORT/dashboard"
bash <skill-dir>/scripts/teardown.sh
```

## Scenario file template

Scenarios live in `<worktree-root>/.e2e-scenarios/<name>.sh`. They are written
dynamically by the child Claude per ticket. The skill is project-agnostic.

Environment available to the scenario:
- `AGENT_BROWSER_SESSION` = `<project>-<slot>`
- `SLOT`, `PROJECT`, `WORKTREE_ROOT`
- `RESULTS_DIR` = `<worktree-root>/.e2e-results/<scenario-name>/` (auto-mkdir'd)
- All `*_PORT` env vars from `.env.dispatch`

Example `.e2e-scenarios/login-flow.sh`:

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

The child Claude then writes `$RESULTS_DIR/report.md` summarizing what happened.

## Parallel session isolation

Each worktree gets its own browser context via `--session <project>-<slot>`.
Cookies, localStorage, history, and tabs are fully isolated between sessions,
so N worktrees can run E2E tests concurrently without interfering.

## Failure modes

| Situation | Behavior |
|-----------|----------|
| `.env.dispatch` missing | Exit 1, hint to run `dev-up up` first. |
| `agent-browser` not installed | Exit 1, hint to run `install`. |
| Scenario name contains `/` or `.` | Exit 2, scenario names are single tokens. |
| Scenario file missing | Exit 1, hint with the resolved path. |
