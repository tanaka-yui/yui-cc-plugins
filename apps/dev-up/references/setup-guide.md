# dev-up setup guide

This guide is read by Claude (LLM) to perform `dev-up setup` interactively.
It generates `.dev-up.yaml` for a new project by inspecting the repository.

## Procedure

### Step 1: detect project root

Run `git rev-parse --show-toplevel`. All subsequent paths are relative to this.

### Step 2: scan for service types

Run the following searches in parallel:

- **Docker Compose**: Glob for `compose.yaml`, `compose.yml`, `compose.all.yaml`, `docker-compose.yaml`, `docker-compose.yml` at any depth.
- **Go**: find `go.mod` files. For each `go.mod`, look for `main.go` or `cmd/*/main.go` nearby, plus `Taskfile.yml` (with a `dev` target) or `Makefile` (with `dev:`) or `.air.toml`.
- **TypeScript/Vite/Node**: find `package.json` files with `scripts.dev`, especially in `apps/*/package.json`, `typescript/apps/*/package.json`, `frontend/`, `web/`, etc. Look for `vite.config.{ts,js,mjs}` alongside.
- **Env files**: find `.env`, `.env.local`, `.env.development` at the root and in subdirectories.

### Step 3: extract port info per service

For each detected service, determine the host port and what env var name should hold it.

- **Docker Compose service**: Read `services.<svc>.ports[]`. The host-side port (left of `:`) is the `base`. Env name follows the rules in Step 4.
- **Go service**: Look in the discovered `.env` file for `PORT`, `SERVER_PORT`, `HTTP_PORT`. If not found, grep the source for `:\d{4,5}` literals. If still ambiguous, ask the user via `AskUserQuestion`.
- **Vite service**: Read `vite.config.*` for `server.port` (any of `port: \d+`). If not found, check `package.json` scripts.dev for `--port \d+`. Default to 5173 if nothing is set.

### Step 4: env var naming heuristics

- Docker service `db` → `DB_PORT`
- Docker service `db_dev` or `db-dev` → `DB_DEV_PORT`
- Docker service `redis` → `REDIS_PORT`
- Docker service containing `nginx` → `NGINX_<purpose>_PORT` (e.g., `php-user-nginx` → `NGINX_USER_PORT`)
- Docker service containing `php` and not nginx → `PHP_<purpose>_PORT` (e.g., `php-admin` → `PHP_ADMIN_PORT`)
- Docker service `mailhog` with 2 ports → `MAILHOG_WEB_PORT` (8025) and `MAILHOG_SMTP_PORT` (1025)
- Go service → `SERVER_PORT` (default) or `GO_API_PORT` if there are multiple Go services
- Vite service → `VITE_PORT` (default) or `<APP_NAME>_PORT` for monorepo (e.g., `admin/` → `ADMIN_PORT`)

### Step 5: health_check inference

- Go service: default to `{ kind: http, target: "http://localhost:${SERVER_PORT}/healthz", timeout: 60 }`. Confirm with user.
- Vite service: default to `{ kind: http, target: "http://localhost:${VITE_PORT}/", timeout: 60 }`.
- Docker Compose services: no per-service `health_check` (compose `up -d --wait` handles it). Add the relevant connection check to top-level `smoke[]` instead.

### Step 6: depends_on inference

- Docker Compose: copy `services.<svc>.depends_on` if present.
- Go/Vite: if a `postgres` or `db` docker-compose service exists, add `depends_on: [<that-svc-name>]` to the Go service. Add `depends_on: [<go-svc-name>]` to the Vite service if a Go service exists.

### Step 7: write the draft

Use `Write` to create `.dev-up.yaml`. Schema:

```yaml
project: <kebab-case directory name>
slot_range: [1, 9]
offset_per_slot: 100
services:
  - { name, type: docker-compose, files: [...], ports: [{name, base}], depends_on: [] }
  - { name, type: command, cwd, command, env_files: [], env_overrides: [{name, base}],
      health_check: { kind, target, timeout, interval }, log_file, depends_on: [] }
urls:
  - { label, template }
smoke:
  - { kind: http|pg|redis, target, user? }
```

### Step 8: confirm with the user via AskUserQuestion

Ask one question per key decision:

1. project name (default: directory basename in kebab-case)
2. detected services list — is it correct?
3. URL labels — are they good?
4. smoke[] — accept the proposed checks?

### Step 9: edit compose files

For each Docker Compose file referenced in `services[].files`, use `Edit` to replace fixed host ports with `${VAR:-default}` form, using the env names determined in Step 4.

Example transformation:

```yaml
# Before
ports:
  - "8081:8080"

# After
ports:
  - "${NGINX_USER_PORT:-8081}:8080"
```

### Step 10: update .gitignore

Ensure these entries are present (append if missing):

```
.env.dispatch
.e2e-results/
.e2e-scenarios/
.dev-up-logs/
```

### Step 11: final message

Tell the user:

> `.dev-up.yaml` has been created. You can now run:
>   - `bash <skill-dir>/scripts/compose-up.sh` to start the stack
>   - `bash <skill-dir>/scripts/compose-down.sh` to stop it
>
> For new projects in different worktrees, the slot reservation is shared via
> `~/.cache/cc-skills/dev-up/<project>/slots/`.

## Validation rules

Before finishing setup, validate:

- All env var names in `ports[*].name` and `env_overrides[*].name` are unique across the file.
- Computed ports (`base + offset_per_slot * SLOT_MAX`) do not collide between services.
- `depends_on` does not have a cycle (run topological sort mentally or via `lib/topo-sort.sh`).
- Each `env_files` path resolves to an existing file (warn but allow if not).
