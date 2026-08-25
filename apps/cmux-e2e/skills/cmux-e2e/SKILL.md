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
| `auth save|load|check|list|delete` | Manage saved browser state. |
| `run <scenario> [--auth <name>]` | Run a scenario and collect artifacts. |
| `down [--sweep]` | Close the recorded browser surface. |

## Safety

Always use `--surface <ref>` for browser operations. The surface identity is resolved by UUID,
locks are never reclaimed automatically, and `import` is never invoked. Do not close a surface
while a scenario is running.

## Scenario contract

Scenarios live in `.cmux-e2e-scenarios/<name>.sh` and call `cmux-e2e-browser`. Artifacts are
written to `.cmux-e2e-results/<name>/`. The wrapper checks identity before each browser command.

## Related skills

Read the `cmux-browser` skill for browser-operation mechanics and authentication steps. Use
`e2e-test` for headless CI scenarios; the two plugins use separate directories.
