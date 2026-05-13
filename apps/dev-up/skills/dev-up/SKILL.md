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

# dev-up

Worktree-isolated development stack lifecycle. Reads `.dev-up.yaml` and
orchestrates Docker Compose stacks plus direct commands (Go servers,
Vite dev servers, etc.) with per-worktree port isolation.

## Subcommands

| Subcommand | Description |
|------------|-------------|
| `setup`    | Generate `.dev-up.yaml` by inspecting the repo. **LLM-driven.** Read `references/setup-guide.md` and follow it. |
| `up`       | Reserve a slot, generate `.env.dispatch`, start all services in `depends_on` order, run smoke tests, print URLs. |
| `down`     | Stop all services in reverse order (SIGTERM → 5s → SIGKILL for commands, `docker compose down` for compose), release the slot. |
| `status`   | Show current slot, running services, PID liveness, URLs. |
| `urls`     | Print only the URL table. |

## CLI flags

| Flag | Effect |
|------|--------|
| `--slot-range MIN-MAX` | Override `slot_range` from `.dev-up.yaml` for this invocation only. Example: `dev-up up --slot-range 1-20`. |

## How to invoke

From any worktree:

```bash
# Setup (first time only — LLM-driven)
bash <skill-dir>/scripts/setup.sh        # prints instructions; ask Claude to drive

# Operations
bash <skill-dir>/scripts/compose-up.sh
bash <skill-dir>/scripts/compose-up.sh --slot-range 1-20
bash <skill-dir>/scripts/compose-down.sh
bash <skill-dir>/scripts/status.sh
bash <skill-dir>/scripts/urls.sh
```

The skill is project-agnostic. Each project should have:

- `.dev-up.yaml` (created by `setup`)
- `.gitignore` entries for `.env.dispatch`, `.e2e-results/`, `.e2e-scenarios/`, `.dev-up-logs/`

## Port allocation

For each service in `.dev-up.yaml`, the host port for slot N is:

```
port = base + (offset_per_slot * N)
```

Defaults: `slot_range: [1, 9]`, `offset_per_slot: 100`. The main worktree (env unset)
keeps the default `base` values, so existing workflows continue to work unchanged.

## Slot registry

Reservations live at `~/.cache/cc-skills/dev-up/<project>/slots/<N>/`:

- `owner.json`: pid, worktree path, compose_project, reserved_at
- `processes.json`: for each `type: command` service, pid/pgid/log_file/depends_on

The `mkdir` operation that creates `slots/<N>/` is atomic, so concurrent reservations
never collide. Zombie sweep runs at the start of each `reserve-slot` to reclaim slots
whose worktree was deleted or whose processes are all dead.

## Integration with cmux-team-dispatch-task

The dispatch task description should include:

> 動作確認するときは Bash で `bash <skill-dir>/scripts/compose-up.sh` を実行してください。
> 完了直前に `bash <skill-dir>/scripts/compose-down.sh` でコンテナ停止とスロット解放を行ってください。
> URL 一覧を result.md の "## Verification URLs" セクションに転記してください。

`cmux-team-dispatch-task` is not modified — coordination flows through the prompt only.

## Failure modes

| Situation | Behavior |
|-----------|----------|
| `.dev-up.yaml` missing | Exit 1 with hint to run `setup`. |
| `yq` not installed | Exit 1 with `brew install yq` hint. |
| All slots taken | Exit 1 with hint about `--slot-range` extension. |
| `docker compose up` fails | Slot stays reserved; manual `down` required. |
| `command` service dies immediately after spawn | Exit 1, log file path shown. |
| `health_check` timeout | Exit 1, log file path shown. Subsequent `down` cleans up the partial start. |
| `depends_on` cycle | Exit 1 from `topo-sort` with the cycle pair shown. |
| Smoke test fails | WARN-only, exit 0 preserved. |
| Worktree deleted without `down` | Zombie sweep on next `up` reclaims the slot. |

## Dependencies

- `yq` (Go version, `mikefarah/yq`)
- `jq`
- `docker` (only if any service uses `type: docker-compose`)
- `tsort` (POSIX, in coreutils)
- `setsid` or `perl` (for session leader)
- `curl`, `nc` (for health checks)
- Optional: `pg_isready` (postgres smoke), `redis-cli` (redis smoke)
