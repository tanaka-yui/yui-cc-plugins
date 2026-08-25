---
name: cmux-e2e
description: >
  E2E test infrastructure using the visible cmux browser. Use it when a user asks to test
  an authenticated UI flow, inspect a UI while testing, or run E2E scenarios without Playwright.
argument-hint: "[up|auth|run|down]"
---

## Output Language

All user-facing questions, option labels, tables, and progress reports MUST be
rendered in Japanese. This file is written in English for consistency; it does
not change the language presented to the user.

# cmux-e2e

Use a real visible browser surface for worktree-scoped E2E scenarios.

## Commands

| Command | Purpose |
| --- | --- |
| `up [--profile <name>]` | Create or reuse this worktree's browser surface. |
| `auth save <name> [--check-url <url> --check-selector <css>]` | Save browser state and an optional validity check; both check flags are required together. |
| `auth load|check|list|delete <name>` | Apply, verify, list, or delete saved browser state. |
| `run <scenario> [--auth <name>] [--allow-js-errors] [--no-guard]` | Run a scenario and collect artifacts. |
| `down [--sweep]` | Close the recorded browser surface. |

## How to invoke

The scripts are not installed on `PATH`. Invoke them from this plugin's directory, for example:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/skills/cmux-e2e/scripts/up.sh"
bash "${CLAUDE_PLUGIN_ROOT}/skills/cmux-e2e/scripts/auth.sh" save admin --check-url "http://localhost:5173/home" --check-selector "#avatar"
bash "${CLAUDE_PLUGIN_ROOT}/skills/cmux-e2e/scripts/run.sh" login-flow --auth admin
bash "${CLAUDE_PLUGIN_ROOT}/skills/cmux-e2e/scripts/down.sh"
```

## Safety

Always use `--surface <ref>` for browser operations. The surface identity is resolved by UUID,
locks are never reclaimed automatically, and `import` is never invoked. Do not close a surface
while a scenario is running.

## Scenario contract

Scenarios live in `.cmux-e2e-scenarios/<name>.sh` and call `cmux-e2e-browser`. Artifacts are
written to `.cmux-e2e-results/<name>/`. The wrapper checks identity before each browser command.

## Scenario file template

```bash
#!/usr/bin/env bash
set -euo pipefail

cmux-e2e-browser goto "http://localhost:${VITE_PORT}/login"
cmux-e2e-browser wait --load-state complete --timeout-ms 10000
cmux-e2e-browser snapshot --interactive > "$RESULTS_DIR/01-login.txt"
```

The scenario receives `CMUX_E2E_SURFACE`, `WORKTREE_ROOT`, and `RESULTS_DIR`.

## CLI invocation rules

Use `--surface <ref>` and named flags such as `--selector`; use `--timeout-ms`, not `--timeout`.
Branch on cmux exit codes rather than parsing stderr. Never invoke browser `import`.

## Related skills

Read the `cmux-browser` skill for browser-operation mechanics and authentication steps. Use
`e2e-test` for headless CI scenarios; the two plugins use separate directories.

## Environment

When `.env.dispatch` exists, it is parsed as data rather than sourced. Only
`COMPOSE_PROJECT_NAME`, `PROJECT`, `SLOT`, and `*_PORT` keys are supplied to the scenario.

## Authentication

Use `up`, complete the login in the visible surface, then run `auth save <name>` with both
verification flags. Pass `--auth <name>` to `run`; `auth check` verifies the digest and condition.

## Artifacts

Artifacts may contain session data. Directories are private and files are mode `0600`; inspect
them before sharing. Add both `.cmux-e2e-scenarios/` and `.cmux-e2e-results/` to a consuming
project's `.gitignore`.

## Failure modes

Exit `2` means invalid arguments. Exit `1` means a missing/unusable surface, locked operation,
failed scenario, artifact collection failure, or unapproved JavaScript errors.
