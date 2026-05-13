# e2e-test

agent-browser based E2E tests against worktree-isolated stacks brought up by `dev-up`.

Reads `.env.dispatch` for service URLs and ports, and runs `agent-browser` with
`--session <project>-<slot>` so each worktree has its own browser context.

Scenarios are bash files in `.e2e-scenarios/<name>.sh` written dynamically by the
child Claude per ticket. The skill is a thin wrapper around `agent-browser`.

## Subcommands

- `e2e-test install` — install agent-browser (run once per machine)
- `e2e-test run <scenario-name>` — run a scenario
- `e2e-test snapshot [url]` — take a snapshot
- `e2e-test teardown` — close the session

See `skills/e2e-test/SKILL.md` for full details.
