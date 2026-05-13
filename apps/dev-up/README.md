# dev-up

Worktree-isolated dev stack lifecycle skill. Reserves a port slot from a shared registry, generates `.env.dispatch`, and runs all services declared in `.dev-up.yaml` (docker-compose stacks and/or direct commands like `go run`, `pnpm dev`).

Designed to work with `cmux-team-dispatch-task` so multiple worktrees can run the same project in parallel without port collisions.

## Subcommands

- `dev-up setup` — generate `.dev-up.yaml` for a new project (Claude inspects the repo)
- `dev-up up` — reserve slot, generate `.env.dispatch`, start all services
- `dev-up down` — stop all services, release slot
- `dev-up status` — show running state
- `dev-up urls` — print service URL table

See `skills/dev-up/SKILL.md` for full details.
