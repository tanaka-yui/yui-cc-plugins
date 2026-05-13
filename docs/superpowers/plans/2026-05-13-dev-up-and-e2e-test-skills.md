# dev-up + e2e-test Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** worktree ごとのポート衝突を解消する汎用 `dev-up` skill と、それと連携する `e2e-test` skill を `yui-cc-plugins/apps/` に追加する。

**Architecture:** `.dev-up.yaml` を読み、`services[]` を `depends_on` の topo sort 順に起動。`type: docker-compose` は `docker compose --env-file .env.dispatch -p <project>-<slot> up -d --wait`、`type: command` は `setsid` で session leader として spawn し PID/PGID を `processes.json` で管理。停止は起動の逆順に SIGTERM→5s→SIGKILL。`e2e-test` は `.env.dispatch` を読み agent-browser を `--session <project>-<slot>` で呼ぶ薄いラッパー。

**Tech Stack:** bash + yq + docker compose + setsid (or perl) + agent-browser + git worktree

**Spec reference:** `docs/superpowers/specs/2026-05-13-dev-up-and-e2e-test-skills-design.md`

**Working directory:** `/Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins/`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `apps/dev-up/.claude-plugin/plugin.json` | Create | Claude plugin manifest |
| `apps/dev-up/.codex-plugin/plugin.json` | Create | Codex plugin manifest |
| `apps/dev-up/skills/dev-up/SKILL.md` | Create | skill entry point |
| `apps/dev-up/skills/dev-up/scripts/setup.sh` | Create | setup guide trigger |
| `apps/dev-up/skills/dev-up/scripts/reserve-slot.sh` | Create | slot reservation |
| `apps/dev-up/skills/dev-up/scripts/release-slot.sh` | Create | slot release |
| `apps/dev-up/skills/dev-up/scripts/compose-up.sh` | Create | up orchestration |
| `apps/dev-up/skills/dev-up/scripts/compose-down.sh` | Create | down orchestration |
| `apps/dev-up/skills/dev-up/scripts/urls.sh` | Create | URL table |
| `apps/dev-up/skills/dev-up/scripts/status.sh` | Create | status report |
| `apps/dev-up/skills/dev-up/scripts/lib/parse-config.sh` | Create | yq based YAML parse |
| `apps/dev-up/skills/dev-up/scripts/lib/render-env.sh` | Create | .env.dispatch generation |
| `apps/dev-up/skills/dev-up/scripts/lib/render-urls.sh` | Create | URL template expansion |
| `apps/dev-up/skills/dev-up/scripts/lib/smoke.sh` | Create | smoke test dispatch |
| `apps/dev-up/skills/dev-up/scripts/lib/spawn-command.sh` | Create | spawn command service |
| `apps/dev-up/skills/dev-up/scripts/lib/wait-health.sh` | Create | health_check loop |
| `apps/dev-up/skills/dev-up/scripts/lib/topo-sort.sh` | Create | depends_on sort |
| `apps/dev-up/skills/dev-up/scripts/lib/kill-pgid.sh` | Create | graceful kill |
| `apps/dev-up/skills/dev-up/scripts/lib/setsid-compat.sh` | Create | macOS/Linux setsid wrapper |
| `apps/dev-up/references/setup-guide.md` | Create | LLM-readable setup procedure |
| `apps/dev-up/README.md` | Create | user-facing docs |
| `apps/dev-up/CLAUDE.md` | Create | repo guide for Claude |
| `apps/dev-up/LICENSE` | Create | MIT |
| `apps/e2e-test/.claude-plugin/plugin.json` | Create | Claude plugin manifest |
| `apps/e2e-test/.codex-plugin/plugin.json` | Create | Codex plugin manifest |
| `apps/e2e-test/skills/e2e-test/SKILL.md` | Create | skill entry point |
| `apps/e2e-test/skills/e2e-test/scripts/install.sh` | Create | agent-browser install |
| `apps/e2e-test/skills/e2e-test/scripts/run.sh` | Create | scenario runner |
| `apps/e2e-test/skills/e2e-test/scripts/snapshot.sh` | Create | snapshot wrapper |
| `apps/e2e-test/skills/e2e-test/scripts/teardown.sh` | Create | session close |
| `apps/e2e-test/README.md` | Create | user-facing docs |
| `apps/e2e-test/CLAUDE.md` | Create | repo guide for Claude |
| `apps/e2e-test/LICENSE` | Create | MIT |
| `.claude-plugin/marketplace.json` | Modify | 2 entries 追加 |

---

## Task 1: dev-up app の skeleton 作成

**Files:**
- Create: `apps/dev-up/.claude-plugin/plugin.json`
- Create: `apps/dev-up/.codex-plugin/plugin.json`
- Create: `apps/dev-up/LICENSE`
- Create: `apps/dev-up/CLAUDE.md`
- Create: `apps/dev-up/README.md`

- [ ] **Step 1: ディレクトリと plugin manifests を作成**

```bash
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins
mkdir -p apps/dev-up/{.claude-plugin,.codex-plugin,skills/dev-up/scripts/lib,references}
```

- [ ] **Step 2: `apps/dev-up/.claude-plugin/plugin.json` を作成**

```json
{
  "name": "dev-up",
  "version": "1.0.0",
  "description": "Worktree-isolated dev stack lifecycle. Reserve a port slot, generate .env.dispatch, and run docker-compose stacks and/or direct commands (go, vite, etc.) with health checks and clean teardown.",
  "author": {
    "name": "tanaka-yui",
    "url": "https://github.com/tanaka-yui"
  },
  "repository": "https://github.com/tanaka-yui/yui-cc-plugins/apps/dev-up",
  "license": "MIT",
  "keywords": [
    "docker",
    "compose",
    "worktree",
    "cmux",
    "vite",
    "go"
  ],
  "skills": "./skills/"
}
```

- [ ] **Step 3: `apps/dev-up/.codex-plugin/plugin.json` を作成**

```json
{
  "name": "dev-up",
  "version": "1.0.0",
  "description": "Worktree-isolated dev stack lifecycle.",
  "author": {
    "name": "tanaka-yui",
    "url": "https://github.com/tanaka-yui"
  },
  "repository": "https://github.com/tanaka-yui/yui-cc-plugins/apps/dev-up",
  "license": "MIT",
  "keywords": ["docker", "compose", "worktree", "cmux"],
  "skills": "./skills/",
  "interface": {
    "displayName": "dev-up",
    "shortDescription": "Worktree-isolated dev stack with port slot reservation.",
    "developerName": "tanaka-yui",
    "category": "Development",
    "capabilities": ["Terminal", "Workflow"]
  }
}
```

- [ ] **Step 4: LICENSE を作成 (既存 cmux-team-dispatch-task からコピー)**

```bash
cp apps/cmux-team-dispatch-task/LICENSE apps/dev-up/LICENSE
```

- [ ] **Step 5: 簡素な README.md を作成**

```markdown
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
```

- [ ] **Step 6: 簡素な CLAUDE.md を作成**

```markdown
# CLAUDE.md (dev-up)

This plugin provides the `dev-up` skill. The skill body is at `skills/dev-up/SKILL.md`. Configuration and setup logic is described in `references/setup-guide.md`.
```

- [ ] **Step 7: コミット**

```bash
git add apps/dev-up/
git commit -m "feat(dev-up): scaffold plugin directory and manifests"
```

---

## Task 2: lib/parse-config.sh の実装

`.dev-up.yaml` を yq で解析し、bash で扱える形式（環境変数 export + 配列）にする。

**Files:**
- Create: `apps/dev-up/skills/dev-up/scripts/lib/parse-config.sh`

- [ ] **Step 1: スクリプト作成**

```bash
#!/usr/bin/env bash
# parse-config.sh — read .dev-up.yaml and emit shell-eval-able variables.
# Usage: eval "$(bash parse-config.sh <path-to-.dev-up.yaml>)"

set -euo pipefail

CONFIG_FILE="${1:-}"
[[ -z "$CONFIG_FILE" || ! -f "$CONFIG_FILE" ]] && { echo "ERROR: config file not found: $CONFIG_FILE" >&2; exit 1; }
command -v yq >/dev/null 2>&1 || { echo "ERROR: yq not installed. Run: brew install yq" >&2; exit 1; }

# Top-level scalars.
echo "DEVUP_PROJECT=$(yq -r '.project' "$CONFIG_FILE")"
echo "DEVUP_SLOT_MIN=$(yq -r '.slot_range[0]' "$CONFIG_FILE")"
echo "DEVUP_SLOT_MAX=$(yq -r '.slot_range[1]' "$CONFIG_FILE")"
echo "DEVUP_OFFSET=$(yq -r '.offset_per_slot' "$CONFIG_FILE")"

# Service names (one per line, newline-separated).
echo "DEVUP_SERVICES=( $(yq -r '.services[].name' "$CONFIG_FILE" | tr '\n' ' ') )"
```

- [ ] **Step 2: 実行権限を付与**

```bash
chmod +x apps/dev-up/skills/dev-up/scripts/lib/parse-config.sh
```

- [ ] **Step 3: 動作確認用のサンプル yaml を一時作成**

```bash
cat > /tmp/test-dev-up.yaml <<'EOF'
project: testproj
slot_range: [1, 9]
offset_per_slot: 100
services:
  - name: postgres
    type: docker-compose
  - name: go-api
    type: command
EOF
```

- [ ] **Step 4: パーサ動作確認**

```bash
eval "$(bash apps/dev-up/skills/dev-up/scripts/lib/parse-config.sh /tmp/test-dev-up.yaml)"
echo "project=$DEVUP_PROJECT"
echo "min=$DEVUP_SLOT_MIN max=$DEVUP_SLOT_MAX offset=$DEVUP_OFFSET"
echo "services=${DEVUP_SERVICES[*]}"
```

Expected: `project=testproj`, `min=1 max=9 offset=100`, `services=postgres go-api`

- [ ] **Step 5: クリーンアップ**

```bash
rm /tmp/test-dev-up.yaml
```

- [ ] **Step 6: コミット**

```bash
git add apps/dev-up/skills/dev-up/scripts/lib/parse-config.sh
git commit -m "feat(dev-up): add lib/parse-config.sh"
```

---

## Task 3: lib/render-env.sh の実装

全 service の `ports[]` と `env_overrides[]` を集めて `.env.dispatch` を生成する。

**Files:**
- Create: `apps/dev-up/skills/dev-up/scripts/lib/render-env.sh`

- [ ] **Step 1: スクリプト作成**

```bash
#!/usr/bin/env bash
# render-env.sh — generate .env.dispatch from .dev-up.yaml + slot number.
# Usage: render-env.sh <config-file> <slot> <output-file>

set -euo pipefail

CONFIG_FILE="$1"
SLOT="$2"
OUT_FILE="$3"

PROJECT=$(yq -r '.project' "$CONFIG_FILE")
OFFSET=$(yq -r '.offset_per_slot' "$CONFIG_FILE")
WORKTREE_ROOT=$(git rev-parse --show-toplevel)

{
  echo "COMPOSE_PROJECT_NAME=$PROJECT-$SLOT"
  echo "SLOT=$SLOT"
  echo "PROJECT=$PROJECT"
  echo "WORKTREE_ROOT=$WORKTREE_ROOT"

  # All ports across services.
  yq -r '.services[] | select(.type == "docker-compose") | .ports[] | "\(.name)=\(.base)"' "$CONFIG_FILE" 2>/dev/null \
    | while IFS='=' read -r name base; do
        [[ -z "$name" ]] && continue
        echo "$name=$((base + OFFSET * SLOT))"
      done

  yq -r '.services[] | select(.type == "command") | .env_overrides[]? | "\(.name)=\(.base)"' "$CONFIG_FILE" 2>/dev/null \
    | while IFS='=' read -r name base; do
        [[ -z "$name" ]] && continue
        echo "$name=$((base + OFFSET * SLOT))"
      done
} > "$OUT_FILE"

echo "wrote $OUT_FILE" >&2
```

- [ ] **Step 2: 実行権限を付与 + 動作確認**

```bash
chmod +x apps/dev-up/skills/dev-up/scripts/lib/render-env.sh

cat > /tmp/test-dev-up.yaml <<'EOF'
project: testproj
slot_range: [1, 9]
offset_per_slot: 100
services:
  - name: postgres
    type: docker-compose
    ports:
      - { name: DB_PORT, base: 35432 }
  - name: go-api
    type: command
    env_overrides:
      - { name: SERVER_PORT, base: 8080 }
EOF

cd /tmp && git init -q test-repo && cd test-repo
bash /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins/apps/dev-up/skills/dev-up/scripts/lib/render-env.sh \
  /tmp/test-dev-up.yaml 2 /tmp/test-env.dispatch
cat /tmp/test-env.dispatch
```

Expected:
```
COMPOSE_PROJECT_NAME=testproj-2
SLOT=2
PROJECT=testproj
WORKTREE_ROOT=/tmp/test-repo
DB_PORT=35632
SERVER_PORT=8280
```

- [ ] **Step 3: クリーンアップ**

```bash
rm -rf /tmp/test-repo /tmp/test-dev-up.yaml /tmp/test-env.dispatch
```

- [ ] **Step 4: コミット**

```bash
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins
git add apps/dev-up/skills/dev-up/scripts/lib/render-env.sh
git commit -m "feat(dev-up): add lib/render-env.sh for .env.dispatch generation"
```

---

## Task 4: lib/render-urls.sh の実装

**Files:**
- Create: `apps/dev-up/skills/dev-up/scripts/lib/render-urls.sh`

- [ ] **Step 1: スクリプト作成**

```bash
#!/usr/bin/env bash
# render-urls.sh — print URL table for current slot.
# Usage: render-urls.sh <config-file> <env-dispatch-file>

set -euo pipefail

CONFIG_FILE="$1"
ENV_FILE="$2"

# shellcheck disable=SC1090
source "$ENV_FILE"

cat <<HDR
┌────────────────────────────────────────────────────────────┐
│ $PROJECT (slot=$SLOT) services are up
├────────────────────────────────────────────────────────────┤
HDR

yq -r '.urls[] | "\(.label)\t\(.template)"' "$CONFIG_FILE" \
  | while IFS=$'\t' read -r label template; do
      # Expand ${VAR} from the sourced env.
      expanded=$(eval "echo \"$template\"")
      printf "│ %-12s %s\n" "$label:" "$expanded"
    done

cat <<FTR
└────────────────────────────────────────────────────────────┘
FTR
```

- [ ] **Step 2: 動作確認**

```bash
chmod +x apps/dev-up/skills/dev-up/scripts/lib/render-urls.sh

cat > /tmp/test-config.yaml <<'EOF'
urls:
  - { label: "User API",   template: "http://localhost:${NGINX_USER_PORT}" }
  - { label: "Postgres",   template: "postgres://root:root@localhost:${DB_PORT}" }
EOF
cat > /tmp/test-env <<'EOF'
PROJECT=testproj
SLOT=2
NGINX_USER_PORT=8281
DB_PORT=35632
EOF

bash apps/dev-up/skills/dev-up/scripts/lib/render-urls.sh /tmp/test-config.yaml /tmp/test-env
```

Expected: ボックスに `User API:   http://localhost:8281` と `Postgres: postgres://root:root@localhost:35632` が表示される。

- [ ] **Step 3: クリーンアップ + コミット**

```bash
rm /tmp/test-config.yaml /tmp/test-env
git add apps/dev-up/skills/dev-up/scripts/lib/render-urls.sh
git commit -m "feat(dev-up): add lib/render-urls.sh"
```

---

## Task 5: lib/setsid-compat.sh の実装

macOS には `setsid` がないので `perl` で代用する互換層。

**Files:**
- Create: `apps/dev-up/skills/dev-up/scripts/lib/setsid-compat.sh`

- [ ] **Step 1: スクリプト作成**

```bash
#!/usr/bin/env bash
# setsid-compat.sh — exec a command in a new session, falling back to perl on macOS.
# Usage: setsid-compat.sh <command> [args...]

set -euo pipefail

if command -v setsid >/dev/null 2>&1; then
  exec setsid "$@"
elif command -v perl >/dev/null 2>&1; then
  exec perl -e 'use POSIX qw(setsid); setsid or die "setsid: $!"; exec @ARGV or die "exec: $!"' -- "$@"
else
  echo "ERROR: neither setsid nor perl is available; cannot create new session" >&2
  exit 1
fi
```

- [ ] **Step 2: 動作確認 (macOS)**

```bash
chmod +x apps/dev-up/skills/dev-up/scripts/lib/setsid-compat.sh

bash apps/dev-up/skills/dev-up/scripts/lib/setsid-compat.sh ps -o pid,sid,command -p $$
```

Expected: 新しい session ID (`SID` 列が現在シェルの SID と異なる) で `ps` が実行される。

- [ ] **Step 3: コミット**

```bash
git add apps/dev-up/skills/dev-up/scripts/lib/setsid-compat.sh
git commit -m "feat(dev-up): add lib/setsid-compat.sh (perl fallback for macOS)"
```

---

## Task 6: lib/kill-pgid.sh の実装

**Files:**
- Create: `apps/dev-up/skills/dev-up/scripts/lib/kill-pgid.sh`

- [ ] **Step 1: スクリプト作成**

```bash
#!/usr/bin/env bash
# kill-pgid.sh — graceful kill of a process group: SIGTERM, wait 5s, SIGKILL.
# Usage: kill-pgid.sh <pgid>

set -euo pipefail

PGID="${1:-}"
[[ -z "$PGID" ]] && { echo "Usage: kill-pgid.sh <pgid>" >&2; exit 2; }

# Validate it's a positive integer.
[[ "$PGID" =~ ^[0-9]+$ ]] || { echo "ERROR: invalid pgid: $PGID" >&2; exit 2; }

# Check if the process group has any live members.
if ! kill -0 "-$PGID" 2>/dev/null; then
  echo "pgid $PGID has no live processes (already gone)"
  exit 0
fi

echo "sending SIGTERM to pgid $PGID"
kill -TERM -- "-$PGID" 2>/dev/null || true

# Wait up to 5 seconds for graceful exit.
for _ in 1 2 3 4 5; do
  sleep 1
  if ! kill -0 "-$PGID" 2>/dev/null; then
    echo "pgid $PGID exited gracefully"
    exit 0
  fi
done

echo "sending SIGKILL to pgid $PGID"
kill -KILL -- "-$PGID" 2>/dev/null || true
echo "pgid $PGID killed"
```

- [ ] **Step 2: 動作確認 (sleep を spawn して kill)**

```bash
chmod +x apps/dev-up/skills/dev-up/scripts/lib/kill-pgid.sh

bash apps/dev-up/skills/dev-up/scripts/lib/setsid-compat.sh bash -c 'sleep 60' &
SPAWN_PID=$!
sleep 0.2
PGID=$(ps -o pgid= -p $SPAWN_PID | tr -d ' ')
echo "spawned PID=$SPAWN_PID PGID=$PGID"

bash apps/dev-up/skills/dev-up/scripts/lib/kill-pgid.sh "$PGID"
wait "$SPAWN_PID" 2>/dev/null || true
```

Expected: `sending SIGTERM to pgid <N>` → `pgid <N> exited gracefully`、最終的に sleep が終了している。

- [ ] **Step 3: コミット**

```bash
git add apps/dev-up/skills/dev-up/scripts/lib/kill-pgid.sh
git commit -m "feat(dev-up): add lib/kill-pgid.sh"
```

---

## Task 7: lib/wait-health.sh の実装

**Files:**
- Create: `apps/dev-up/skills/dev-up/scripts/lib/wait-health.sh`

- [ ] **Step 1: スクリプト作成**

```bash
#!/usr/bin/env bash
# wait-health.sh — poll a health check until it passes or timeout.
# Usage: wait-health.sh <kind> <target> <timeout-sec> <interval-sec>
#   kind: http | tcp
#   target for http: full URL (e.g., http://localhost:8080/healthz)
#   target for tcp:  host:port (e.g., localhost:8080)

set -euo pipefail

KIND="$1"
TARGET="$2"
TIMEOUT="${3:-60}"
INTERVAL="${4:-1}"

elapsed=0
while (( elapsed < TIMEOUT )); do
  case "$KIND" in
    http)
      if curl -fsS --max-time 2 "$TARGET" -o /dev/null 2>/dev/null; then
        echo "health check passed: $KIND $TARGET (after ${elapsed}s)"
        exit 0
      fi
      ;;
    tcp)
      host="${TARGET%%:*}"
      port="${TARGET##*:}"
      if nc -z "$host" "$port" 2>/dev/null; then
        echo "health check passed: $KIND $TARGET (after ${elapsed}s)"
        exit 0
      fi
      ;;
    *)
      echo "WARN: unknown health_check kind: $KIND (skipping)" >&2
      exit 0
      ;;
  esac
  sleep "$INTERVAL"
  elapsed=$((elapsed + INTERVAL))
done

echo "ERROR: health check timed out after ${TIMEOUT}s: $KIND $TARGET" >&2
exit 1
```

- [ ] **Step 2: 動作確認 (Python の簡易 HTTP サーバーで)**

```bash
chmod +x apps/dev-up/skills/dev-up/scripts/lib/wait-health.sh

# シナリオ1: すぐ PASS
python3 -m http.server 18888 > /dev/null 2>&1 &
SRV_PID=$!
sleep 0.5
bash apps/dev-up/skills/dev-up/scripts/lib/wait-health.sh http "http://localhost:18888/" 5 1
kill $SRV_PID 2>/dev/null || true

# シナリオ2: timeout 失敗
bash apps/dev-up/skills/dev-up/scripts/lib/wait-health.sh http "http://localhost:18999/" 3 1 ; echo "exit=$?"
```

Expected: 1 つ目は `health check passed`、2 つ目は `ERROR: health check timed out` + `exit=1`。

- [ ] **Step 3: コミット**

```bash
git add apps/dev-up/skills/dev-up/scripts/lib/wait-health.sh
git commit -m "feat(dev-up): add lib/wait-health.sh"
```

---

## Task 8: lib/topo-sort.sh の実装

**Files:**
- Create: `apps/dev-up/skills/dev-up/scripts/lib/topo-sort.sh`

- [ ] **Step 1: スクリプト作成**

```bash
#!/usr/bin/env bash
# topo-sort.sh — topological sort of services by depends_on.
# Reads .dev-up.yaml from $1 and prints service names in start order, one per line.

set -euo pipefail

CONFIG_FILE="$1"

# Build "dependency target" pairs for tsort: "<dep> <service>" means <dep> must come before <service>.
PAIRS=$(yq -r '
  .services[] |
  . as $svc |
  if (.depends_on // []) | length == 0 then
    "\($svc.name) \($svc.name)"
  else
    .depends_on[] | "\(.) \($svc.name)"
  end
' "$CONFIG_FILE")

# tsort: dependencies first.
if ! result=$(echo "$PAIRS" | tsort 2>&1); then
  echo "ERROR: depends_on graph has a cycle:" >&2
  echo "$result" >&2
  exit 1
fi

echo "$result"
```

- [ ] **Step 2: 動作確認**

```bash
chmod +x apps/dev-up/skills/dev-up/scripts/lib/topo-sort.sh

cat > /tmp/topo-test.yaml <<'EOF'
services:
  - name: vite
    depends_on: [go-api]
  - name: go-api
    depends_on: [postgres]
  - name: postgres
EOF

bash apps/dev-up/skills/dev-up/scripts/lib/topo-sort.sh /tmp/topo-test.yaml
```

Expected:
```
postgres
go-api
vite
```

- [ ] **Step 3: 循環検出**

```bash
cat > /tmp/topo-cycle.yaml <<'EOF'
services:
  - name: a
    depends_on: [b]
  - name: b
    depends_on: [a]
EOF

bash apps/dev-up/skills/dev-up/scripts/lib/topo-sort.sh /tmp/topo-cycle.yaml ; echo "exit=$?"
```

Expected: stderr に `ERROR: depends_on graph has a cycle:`、`exit=1`。

- [ ] **Step 4: クリーンアップ + コミット**

```bash
rm /tmp/topo-test.yaml /tmp/topo-cycle.yaml
git add apps/dev-up/skills/dev-up/scripts/lib/topo-sort.sh
git commit -m "feat(dev-up): add lib/topo-sort.sh"
```

---

## Task 9: lib/smoke.sh の実装

**Files:**
- Create: `apps/dev-up/skills/dev-up/scripts/lib/smoke.sh`

- [ ] **Step 1: スクリプト作成**

```bash
#!/usr/bin/env bash
# smoke.sh — run smoke[] from .dev-up.yaml. WARN-only, never exits non-zero.
# Usage: smoke.sh <config-file> <env-dispatch-file>

set -uo pipefail

CONFIG_FILE="$1"
ENV_FILE="$2"

# shellcheck disable=SC1090
source "$ENV_FILE"

warn() { echo "WARN: smoke - $*" >&2; }

run_smoke() {
  local kind="$1"; local target="$2"; local user="$3"
  # Expand ${VAR} from the sourced env.
  target=$(eval "echo \"$target\"")
  case "$kind" in
    http)
      curl -fsS --max-time 5 "$target" -o /dev/null 2>/dev/null \
        || warn "http $target failed"
      ;;
    pg)
      local host="${target%%:*}"
      local port="${target##*:}"
      pg_isready -h "$host" -p "$port" -U "${user:-postgres}" -t 5 > /dev/null 2>&1 \
        || warn "pg $target user=$user failed"
      ;;
    redis)
      local host="${target%%:*}"
      local port="${target##*:}"
      redis-cli -h "$host" -p "$port" ping > /dev/null 2>&1 \
        || warn "redis $target failed"
      ;;
    *)
      warn "unknown kind: $kind (skipping)"
      ;;
  esac
}

# Iterate smoke[] using yq -o=json + jq-like pipeline via yq.
count=$(yq -r '.smoke | length // 0' "$CONFIG_FILE")
for i in $(seq 0 $((count - 1))); do
  [[ "$count" == "0" ]] && break
  kind=$(yq -r ".smoke[$i].kind" "$CONFIG_FILE")
  target=$(yq -r ".smoke[$i].target" "$CONFIG_FILE")
  user=$(yq -r ".smoke[$i].user // \"\"" "$CONFIG_FILE")
  run_smoke "$kind" "$target" "$user"
done

exit 0
```

- [ ] **Step 2: 動作確認**

```bash
chmod +x apps/dev-up/skills/dev-up/scripts/lib/smoke.sh

cat > /tmp/smoke-test.yaml <<'EOF'
smoke:
  - { kind: http, target: "http://localhost:18888/" }
  - { kind: http, target: "http://localhost:19999/" }
EOF
cat > /tmp/smoke-env <<'EOF'
PROJECT=testproj
SLOT=1
EOF

python3 -m http.server 18888 > /dev/null 2>&1 &
SRV_PID=$!
sleep 0.5
bash apps/dev-up/skills/dev-up/scripts/lib/smoke.sh /tmp/smoke-test.yaml /tmp/smoke-env
kill $SRV_PID 2>/dev/null || true
```

Expected: 1 つ目は無音で PASS、2 つ目は `WARN: smoke - http http://localhost:19999/ failed`、最終 exit 0。

- [ ] **Step 3: クリーンアップ + コミット**

```bash
rm /tmp/smoke-test.yaml /tmp/smoke-env
git add apps/dev-up/skills/dev-up/scripts/lib/smoke.sh
git commit -m "feat(dev-up): add lib/smoke.sh"
```

---

## Task 10: lib/spawn-command.sh の実装

**Files:**
- Create: `apps/dev-up/skills/dev-up/scripts/lib/spawn-command.sh`

- [ ] **Step 1: スクリプト作成**

```bash
#!/usr/bin/env bash
# spawn-command.sh — spawn a `type: command` service as a session leader.
# Usage: spawn-command.sh <config-file> <service-name> <env-dispatch-file> <processes-json>
# Outputs nothing on stdout; on success the processes.json is updated.

set -euo pipefail

CONFIG_FILE="$1"
SVC_NAME="$2"
ENV_FILE="$3"
PROCESSES_JSON="$4"

WORKTREE_ROOT=$(git rev-parse --show-toplevel)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Find the service block.
SVC_INDEX=$(yq -r ".services | to_entries | map(select(.value.name == \"$SVC_NAME\")) | .[0].key" "$CONFIG_FILE")
[[ "$SVC_INDEX" == "null" ]] && { echo "ERROR: service not found: $SVC_NAME" >&2; exit 1; }

CWD=$(yq -r ".services[$SVC_INDEX].cwd // \".\"" "$CONFIG_FILE")
CMD=$(yq -r ".services[$SVC_INDEX].command" "$CONFIG_FILE")
LOG_FILE=$(yq -r ".services[$SVC_INDEX].log_file // \"\"" "$CONFIG_FILE")
[[ -z "$LOG_FILE" ]] && LOG_FILE=".dev-up-logs/$SVC_NAME.log"

# Resolve LOG_FILE relative to worktree root.
case "$LOG_FILE" in /*) ABS_LOG="$LOG_FILE";; *) ABS_LOG="$WORKTREE_ROOT/$LOG_FILE";; esac
mkdir -p "$(dirname "$ABS_LOG")"

# Resolve CWD relative to worktree root.
case "$CWD" in /*) ABS_CWD="$CWD";; *) ABS_CWD="$WORKTREE_ROOT/$CWD";; esac
[[ -d "$ABS_CWD" ]] || { echo "ERROR: cwd does not exist: $ABS_CWD" >&2; exit 1; }

# Collect env_files (worktree-root relative).
ENV_FILE_ARGS=()
while IFS= read -r ef; do
  [[ -z "$ef" ]] && continue
  case "$ef" in /*) abs="$ef";; *) abs="$WORKTREE_ROOT/$ef";; esac
  [[ -f "$abs" ]] || { echo "ERROR: env_file not found: $abs" >&2; exit 1; }
  ENV_FILE_ARGS+=("$abs")
done < <(yq -r ".services[$SVC_INDEX].env_files[]? // empty" "$CONFIG_FILE")

# Build a sourced env: env_files → .env.dispatch → env_overrides (already in .env.dispatch).
# Note: .env.dispatch already contains env_overrides (rendered by render-env.sh),
# so loading env_files first and .env.dispatch second gives the correct precedence.
ENV_LOAD=""
for ef in "${ENV_FILE_ARGS[@]+"${ENV_FILE_ARGS[@]}"}"; do
  ENV_LOAD+="set -a; source '$ef'; set +a; "
done
ENV_LOAD+="set -a; source '$ENV_FILE'; set +a; "

# Build a self-contained wrapper script that loads env, cds, and execs the command.
# Using a wrapper file avoids quoting hell with nested bash -c invocations.
WRAPPER=$(mktemp)
{
  echo "#!/usr/bin/env bash"
  echo "set -euo pipefail"
  echo "$ENV_LOAD"
  echo "cd \"$ABS_CWD\""
  echo "exec $CMD"
} > "$WRAPPER"
chmod +x "$WRAPPER"

# Spawn in a new session, redirecting stdout/stderr to log.
bash "$SCRIPT_DIR/setsid-compat.sh" "$WRAPPER" >> "$ABS_LOG" 2>&1 &
SPAWN_PID=$!

# Schedule wrapper cleanup: the bash process opens and reads the file at start,
# so we can safely delete it after a short delay.
( sleep 5; rm -f "$WRAPPER" ) &
disown

# Wait briefly for the session leader to be established, then read PGID.
sleep 0.3
if ! kill -0 "$SPAWN_PID" 2>/dev/null; then
  echo "ERROR: command spawned but died immediately. See log: $ABS_LOG" >&2
  exit 1
fi

PGID=$(ps -o pgid= -p "$SPAWN_PID" | tr -d ' ')
STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Build depends_on JSON array.
DEPS_JSON=$(yq -o=json -I=0 ".services[$SVC_INDEX].depends_on // []" "$CONFIG_FILE")

# Append/update the entry in processes.json.
TMP=$(mktemp)
jq --arg name "$SVC_NAME" \
   --argjson pid "$SPAWN_PID" \
   --argjson pgid "$PGID" \
   --arg started_at "$STARTED_AT" \
   --arg log_file "$ABS_LOG" \
   --argjson deps "$DEPS_JSON" \
   '. + { ($name): { pid: $pid, pgid: $pgid, started_at: $started_at, log_file: $log_file, depends_on: $deps } }' \
   "$PROCESSES_JSON" > "$TMP"
mv "$TMP" "$PROCESSES_JSON"

echo "spawned $SVC_NAME: pid=$SPAWN_PID pgid=$PGID log=$ABS_LOG" >&2
```

- [ ] **Step 2: 動作確認**

```bash
chmod +x apps/dev-up/skills/dev-up/scripts/lib/spawn-command.sh

# テスト用 worktree + config
cd /tmp && rm -rf spawn-test && mkdir spawn-test && cd spawn-test
git init -q

cat > /tmp/spawn-config.yaml <<'EOF'
services:
  - name: dummy
    type: command
    cwd: "."
    command: "sleep 30"
EOF
cat > /tmp/spawn-env <<'EOF'
SLOT=1
PROJECT=testproj
EOF
echo '{}' > /tmp/spawn-processes.json

bash /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins/apps/dev-up/skills/dev-up/scripts/lib/spawn-command.sh \
  /tmp/spawn-config.yaml dummy /tmp/spawn-env /tmp/spawn-processes.json

cat /tmp/spawn-processes.json | jq
PGID=$(jq -r '.dummy.pgid' /tmp/spawn-processes.json)
ps -o pid,pgid,command -p "$(jq -r '.dummy.pid' /tmp/spawn-processes.json)"
kill -- "-$PGID"
```

Expected: `processes.json` に `dummy` キーが追加され `pid`/`pgid`/`log_file` が含まれる、`ps` で sleep プロセスが見える、最後の kill で終了。

- [ ] **Step 3: クリーンアップ + コミット**

```bash
rm -rf /tmp/spawn-test /tmp/spawn-config.yaml /tmp/spawn-env /tmp/spawn-processes.json /tmp/.dev-up-logs 2>/dev/null
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins
git add apps/dev-up/skills/dev-up/scripts/lib/spawn-command.sh
git commit -m "feat(dev-up): add lib/spawn-command.sh"
```

---

## Task 11: reserve-slot.sh の実装

**Files:**
- Create: `apps/dev-up/skills/dev-up/scripts/reserve-slot.sh`

- [ ] **Step 1: スクリプト作成**

```bash
#!/usr/bin/env bash
# reserve-slot.sh — reserve a free port slot for this worktree.
# Usage: reserve-slot.sh <project> [--slot-range MIN-MAX]
# stdout: reserved slot number.

set -euo pipefail

PROJECT="${1:-}"
[[ -z "$PROJECT" ]] && { echo "Usage: reserve-slot.sh <project> [--slot-range MIN-MAX]" >&2; exit 2; }
shift

# Defaults (overridden by --slot-range).
SLOT_MIN=1
SLOT_MAX=9

while [[ $# -gt 0 ]]; do
  case "$1" in
    --slot-range)
      [[ "$2" =~ ^([0-9]+)-([0-9]+)$ ]] || { echo "ERROR: --slot-range must be MIN-MAX" >&2; exit 2; }
      SLOT_MIN="${BASH_REMATCH[1]}"
      SLOT_MAX="${BASH_REMATCH[2]}"
      shift 2
      ;;
    *) echo "ERROR: unknown arg: $1" >&2; exit 2;;
  esac
done

REGISTRY="$HOME/.cache/cc-skills/dev-up/$PROJECT/slots"
mkdir -p "$REGISTRY"

# Phase 1: zombie sweep.
for slot_dir in "$REGISTRY"/*/; do
  [[ -d "$slot_dir" ]] || continue
  slot=$(basename "$slot_dir")
  owner_wt=$(jq -r '.worktree // empty' "$slot_dir/owner.json" 2>/dev/null || echo "")
  cp_name=$(jq -r '.compose_project // empty' "$slot_dir/owner.json" 2>/dev/null || echo "")

  # Worktree gone?
  if [[ -z "$owner_wt" || ! -d "$owner_wt" ]]; then
    rm -rf "$slot_dir"; continue
  fi

  # compose project has no containers?
  compose_alive=false
  if [[ -n "$cp_name" ]] && docker compose -p "$cp_name" ps -q 2>/dev/null | grep -q .; then
    compose_alive=true
  fi

  # Any spawned PID still alive?
  processes_alive=false
  if [[ -f "$slot_dir/processes.json" ]]; then
    while IFS= read -r pid; do
      [[ -z "$pid" || "$pid" == "null" ]] && continue
      if kill -0 "$pid" 2>/dev/null; then processes_alive=true; break; fi
    done < <(jq -r '.[].pid' "$slot_dir/processes.json" 2>/dev/null)
  fi

  if ! $compose_alive && ! $processes_alive; then
    rm -rf "$slot_dir"
  fi
done

# Phase 2: atomic mkdir reservation.
for slot in $(seq "$SLOT_MIN" "$SLOT_MAX"); do
  slot_dir="$REGISTRY/$slot"
  if mkdir "$slot_dir" 2>/dev/null; then
    worktree=$(git rev-parse --show-toplevel)
    cat > "$slot_dir/owner.json" <<EOF
{
  "pid": $$,
  "worktree": "$worktree",
  "compose_project": "$PROJECT-$slot",
  "reserved_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
    echo '{}' > "$slot_dir/processes.json"
    echo "$slot"
    exit 0
  fi
done

echo "ERROR: no free slot in [$SLOT_MIN, $SLOT_MAX]. Run 'dev-up down' in an unused worktree or extend --slot-range." >&2
exit 1
```

- [ ] **Step 2: 動作確認**

```bash
chmod +x apps/dev-up/skills/dev-up/scripts/reserve-slot.sh

cd /tmp && rm -rf reserve-test && mkdir reserve-test && cd reserve-test
git init -q
rm -rf ~/.cache/cc-skills/dev-up/testproj

bash /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins/apps/dev-up/skills/dev-up/scripts/reserve-slot.sh testproj
bash /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins/apps/dev-up/skills/dev-up/scripts/reserve-slot.sh testproj
ls ~/.cache/cc-skills/dev-up/testproj/slots/
```

Expected: stdout に `1`、次に `2`、`slots/1` と `slots/2` がリストされる。

- [ ] **Step 3: 満杯 + --slot-range**

```bash
for i in 3 4 5 6 7 8 9; do mkdir -p ~/.cache/cc-skills/dev-up/testproj/slots/$i; done
bash /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins/apps/dev-up/skills/dev-up/scripts/reserve-slot.sh testproj ; echo "exit=$?"
bash /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins/apps/dev-up/skills/dev-up/scripts/reserve-slot.sh testproj --slot-range 1-15
```

Expected: 1 つ目は exit 1、2 つ目は stdout に `10`。

- [ ] **Step 4: クリーンアップ + コミット**

```bash
rm -rf ~/.cache/cc-skills/dev-up/testproj /tmp/reserve-test
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins
git add apps/dev-up/skills/dev-up/scripts/reserve-slot.sh
git commit -m "feat(dev-up): add reserve-slot.sh with zombie sweep and --slot-range"
```

---

## Task 12: release-slot.sh の実装

**Files:**
- Create: `apps/dev-up/skills/dev-up/scripts/release-slot.sh`

- [ ] **Step 1: スクリプト作成**

```bash
#!/usr/bin/env bash
# release-slot.sh <project> <slot>

set -euo pipefail

[[ $# -ne 2 ]] && { echo "Usage: release-slot.sh <project> <slot>" >&2; exit 2; }
PROJECT="$1"
SLOT="$2"

SLOT_DIR="$HOME/.cache/cc-skills/dev-up/$PROJECT/slots/$SLOT"
if [[ ! -d "$SLOT_DIR" ]]; then
  echo "slot $SLOT for $PROJECT was not reserved (nothing to release)" >&2
  exit 0
fi

rm -rf "$SLOT_DIR"
echo "released slot $SLOT for $PROJECT"
```

- [ ] **Step 2: 動作確認 + コミット**

```bash
chmod +x apps/dev-up/skills/dev-up/scripts/release-slot.sh
mkdir -p ~/.cache/cc-skills/dev-up/testproj/slots/5
bash apps/dev-up/skills/dev-up/scripts/release-slot.sh testproj 5
ls ~/.cache/cc-skills/dev-up/testproj/slots/ ; rmdir ~/.cache/cc-skills/dev-up/testproj/slots ~/.cache/cc-skills/dev-up/testproj 2>/dev/null
git add apps/dev-up/skills/dev-up/scripts/release-slot.sh
git commit -m "feat(dev-up): add release-slot.sh"
```

---

## Task 13: compose-up.sh の実装

最も複雑なスクリプト。全 lib スクリプトを統合する。

**Files:**
- Create: `apps/dev-up/skills/dev-up/scripts/compose-up.sh`

- [ ] **Step 1: スクリプト作成**

```bash
#!/usr/bin/env bash
# compose-up.sh — bring up an isolated dev stack for this worktree.

set -euo pipefail

WORKTREE_ROOT=$(git rev-parse --show-toplevel)
cd "$WORKTREE_ROOT"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$SCRIPT_DIR/lib"
CONFIG_FILE="$WORKTREE_ROOT/.dev-up.yaml"
ENV_FILE="$WORKTREE_ROOT/.env.dispatch"

[[ -f "$CONFIG_FILE" ]] || { echo "ERROR: .dev-up.yaml not found. Run 'dev-up setup' first." >&2; exit 1; }

# Parse --slot-range.
SLOT_RANGE_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --slot-range) SLOT_RANGE_ARGS=(--slot-range "$2"); shift 2;;
    *) echo "ERROR: unknown arg: $1" >&2; exit 2;;
  esac
done

PROJECT=$(yq -r '.project' "$CONFIG_FILE")

# Idempotency: existing .env.dispatch.
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  SLOT_DIR="$HOME/.cache/cc-skills/dev-up/$PROJECT/slots/$SLOT"
  alive=false
  if docker compose -p "$COMPOSE_PROJECT_NAME" ps -q 2>/dev/null | grep -q .; then alive=true; fi
  if [[ -f "$SLOT_DIR/processes.json" ]]; then
    while IFS= read -r pid; do
      [[ -z "$pid" || "$pid" == "null" ]] && continue
      if kill -0 "$pid" 2>/dev/null; then alive=true; break; fi
    done < <(jq -r '.[].pid' "$SLOT_DIR/processes.json" 2>/dev/null)
  fi
  if $alive; then
    echo "Already up on slot=$SLOT. Re-printing URLs."
    bash "$LIB_DIR/render-urls.sh" "$CONFIG_FILE" "$ENV_FILE"
    exit 0
  else
    echo "Stale .env.dispatch found (no live processes). Re-reserving." >&2
    rm -f "$ENV_FILE"
  fi
fi

# Reserve slot.
SLOT=$(bash "$SCRIPT_DIR/reserve-slot.sh" "$PROJECT" "${SLOT_RANGE_ARGS[@]+"${SLOT_RANGE_ARGS[@]}"}")
echo "reserved slot=$SLOT"
SLOT_DIR="$HOME/.cache/cc-skills/dev-up/$PROJECT/slots/$SLOT"
PROCESSES_JSON="$SLOT_DIR/processes.json"

# Generate .env.dispatch.
bash "$LIB_DIR/render-env.sh" "$CONFIG_FILE" "$SLOT" "$ENV_FILE"

# Topological sort.
SORTED=$(bash "$LIB_DIR/topo-sort.sh" "$CONFIG_FILE")

# Start each service in order.
while IFS= read -r SVC; do
  [[ -z "$SVC" ]] && continue
  SVC_INDEX=$(yq -r ".services | to_entries | map(select(.value.name == \"$SVC\")) | .[0].key" "$CONFIG_FILE")
  TYPE=$(yq -r ".services[$SVC_INDEX].type" "$CONFIG_FILE")

  echo "starting $SVC (type=$TYPE)"

  case "$TYPE" in
    docker-compose)
      mapfile -t COMPOSE_FILES < <(yq -r ".services[$SVC_INDEX].files[]" "$CONFIG_FILE")
      COMPOSE_F_ARGS=()
      for f in "${COMPOSE_FILES[@]}"; do COMPOSE_F_ARGS+=(-f "$f"); done
      docker compose "${COMPOSE_F_ARGS[@]}" --env-file "$ENV_FILE" -p "$PROJECT-$SLOT" up -d --wait
      ;;
    command)
      bash "$LIB_DIR/spawn-command.sh" "$CONFIG_FILE" "$SVC" "$ENV_FILE" "$PROCESSES_JSON"

      # Health check, if defined.
      HC_KIND=$(yq -r ".services[$SVC_INDEX].health_check.kind // \"\"" "$CONFIG_FILE")
      if [[ -n "$HC_KIND" ]]; then
        HC_TARGET=$(yq -r ".services[$SVC_INDEX].health_check.target" "$CONFIG_FILE")
        HC_TIMEOUT=$(yq -r ".services[$SVC_INDEX].health_check.timeout // 60" "$CONFIG_FILE")
        HC_INTERVAL=$(yq -r ".services[$SVC_INDEX].health_check.interval // 1" "$CONFIG_FILE")
        # Expand ${VAR} from .env.dispatch.
        # shellcheck disable=SC1090
        ( source "$ENV_FILE"; bash "$LIB_DIR/wait-health.sh" "$HC_KIND" "$(eval "echo \"$HC_TARGET\"")" "$HC_TIMEOUT" "$HC_INTERVAL" )
      fi
      ;;
    *)
      echo "ERROR: unknown service type: $TYPE" >&2
      exit 1
      ;;
  esac
done <<< "$SORTED"

# Smoke test.
bash "$LIB_DIR/smoke.sh" "$CONFIG_FILE" "$ENV_FILE"

# URL table.
bash "$LIB_DIR/render-urls.sh" "$CONFIG_FILE" "$ENV_FILE"
```

- [ ] **Step 2: 実行権限を付与**

```bash
chmod +x apps/dev-up/skills/dev-up/scripts/compose-up.sh
```

- [ ] **Step 3: 動作確認は Task 14 (compose-down.sh) と合わせて Task 26 で実施**

- [ ] **Step 4: コミット**

```bash
git add apps/dev-up/skills/dev-up/scripts/compose-up.sh
git commit -m "feat(dev-up): add compose-up.sh"
```

---

## Task 14: compose-down.sh の実装

**Files:**
- Create: `apps/dev-up/skills/dev-up/scripts/compose-down.sh`

- [ ] **Step 1: スクリプト作成**

```bash
#!/usr/bin/env bash
# compose-down.sh — stop all services and release the slot.

set -euo pipefail

WORKTREE_ROOT=$(git rev-parse --show-toplevel)
cd "$WORKTREE_ROOT"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$SCRIPT_DIR/lib"
CONFIG_FILE="$WORKTREE_ROOT/.dev-up.yaml"
ENV_FILE="$WORKTREE_ROOT/.env.dispatch"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "no .env.dispatch found; nothing to bring down" >&2
  exit 0
fi

# shellcheck disable=SC1090
source "$ENV_FILE"
SLOT_DIR="$HOME/.cache/cc-skills/dev-up/$PROJECT/slots/$SLOT"
PROCESSES_JSON="$SLOT_DIR/processes.json"

# Topological sort then reverse for shutdown order.
# awk reverse works on both macOS (no tac) and Linux (no tail -r).
SORTED=$(bash "$LIB_DIR/topo-sort.sh" "$CONFIG_FILE" | awk '{a[NR]=$0} END{for(i=NR;i>0;i--) print a[i]}')

# Stop command services first (reverse order).
while IFS= read -r SVC; do
  [[ -z "$SVC" ]] && continue
  SVC_INDEX=$(yq -r ".services | to_entries | map(select(.value.name == \"$SVC\")) | .[0].key" "$CONFIG_FILE")
  TYPE=$(yq -r ".services[$SVC_INDEX].type" "$CONFIG_FILE")
  [[ "$TYPE" != "command" ]] && continue

  if [[ -f "$PROCESSES_JSON" ]]; then
    PGID=$(jq -r ".\"$SVC\".pgid // empty" "$PROCESSES_JSON")
    if [[ -n "$PGID" && "$PGID" != "null" ]]; then
      echo "stopping command service: $SVC (pgid=$PGID)"
      bash "$LIB_DIR/kill-pgid.sh" "$PGID" || true
    fi
  fi
done <<< "$SORTED"

# Stop docker-compose services. compose down is project-scoped so a single call covers all of them.
if yq -e '.services[] | select(.type == "docker-compose")' "$CONFIG_FILE" >/dev/null 2>&1; then
  echo "stopping docker compose project: $COMPOSE_PROJECT_NAME"
  # Collect -f files across docker-compose services.
  COMPOSE_F_ARGS=()
  while IFS= read -r f; do COMPOSE_F_ARGS+=(-f "$f"); done < <(yq -r '.services[] | select(.type == "docker-compose") | .files[]' "$CONFIG_FILE" | sort -u)
  docker compose "${COMPOSE_F_ARGS[@]}" --env-file "$ENV_FILE" -p "$COMPOSE_PROJECT_NAME" down || true
fi

# Release slot (which also wipes processes.json).
bash "$SCRIPT_DIR/release-slot.sh" "$PROJECT" "$SLOT"

# Remove .env.dispatch.
rm -f "$ENV_FILE"
echo "removed $ENV_FILE"
```

- [ ] **Step 2: 実行権限 + コミット**

```bash
chmod +x apps/dev-up/skills/dev-up/scripts/compose-down.sh
git add apps/dev-up/skills/dev-up/scripts/compose-down.sh
git commit -m "feat(dev-up): add compose-down.sh"
```

---

## Task 15: urls.sh の実装

**Files:**
- Create: `apps/dev-up/skills/dev-up/scripts/urls.sh`

- [ ] **Step 1: スクリプト作成**

```bash
#!/usr/bin/env bash
# urls.sh — print service URL table.

set -euo pipefail

WORKTREE_ROOT=$(git rev-parse --show-toplevel)
cd "$WORKTREE_ROOT"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$WORKTREE_ROOT/.dev-up.yaml"
ENV_FILE="$WORKTREE_ROOT/.env.dispatch"

[[ -f "$ENV_FILE" ]] || { echo "ERROR: .env.dispatch not found. Run 'dev-up up' first." >&2; exit 1; }

bash "$SCRIPT_DIR/lib/render-urls.sh" "$CONFIG_FILE" "$ENV_FILE"
```

- [ ] **Step 2: 実行権限 + コミット**

```bash
chmod +x apps/dev-up/skills/dev-up/scripts/urls.sh
git add apps/dev-up/skills/dev-up/scripts/urls.sh
git commit -m "feat(dev-up): add urls.sh"
```

---

## Task 16: status.sh の実装

**Files:**
- Create: `apps/dev-up/skills/dev-up/scripts/status.sh`

- [ ] **Step 1: スクリプト作成**

```bash
#!/usr/bin/env bash
# status.sh — show slot, running services (docker + command), and URLs.

set -euo pipefail

WORKTREE_ROOT=$(git rev-parse --show-toplevel)
cd "$WORKTREE_ROOT"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$WORKTREE_ROOT/.dev-up.yaml"
ENV_FILE="$WORKTREE_ROOT/.env.dispatch"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "no slot reserved for this worktree (.env.dispatch not found)"
  exit 0
fi

# shellcheck disable=SC1090
source "$ENV_FILE"
echo "slot: $SLOT"
echo "compose project: $COMPOSE_PROJECT_NAME"
echo ""

# docker-compose services.
if yq -e '.services[] | select(.type == "docker-compose")' "$CONFIG_FILE" >/dev/null 2>&1; then
  echo "docker containers:"
  docker compose -p "$COMPOSE_PROJECT_NAME" ps 2>/dev/null || echo "  (none)"
  echo ""
fi

# command services.
PROCESSES_JSON="$HOME/.cache/cc-skills/dev-up/$PROJECT/slots/$SLOT/processes.json"
if [[ -f "$PROCESSES_JSON" ]]; then
  echo "command services:"
  jq -r 'to_entries[] | "  \(.key)\tpid=\(.value.pid)\tlog=\(.value.log_file)"' "$PROCESSES_JSON" \
    | while IFS=$'\t' read -r name_part pid_part log_part; do
        pid="${pid_part#pid=}"
        if kill -0 "$pid" 2>/dev/null; then alive="alive"; else alive="DEAD"; fi
        echo "$name_part  [$alive]  $pid_part  $log_part"
      done
  echo ""
fi

bash "$SCRIPT_DIR/lib/render-urls.sh" "$CONFIG_FILE" "$ENV_FILE"
```

- [ ] **Step 2: 実行権限 + コミット**

```bash
chmod +x apps/dev-up/skills/dev-up/scripts/status.sh
git add apps/dev-up/skills/dev-up/scripts/status.sh
git commit -m "feat(dev-up): add status.sh"
```

---

## Task 17: setup.sh の実装

setup の実体は Claude (LLM) が `references/setup-guide.md` を読んで自走するので、setup.sh は Claude へのリダイレクトのみ。

**Files:**
- Create: `apps/dev-up/skills/dev-up/scripts/setup.sh`

- [ ] **Step 1: スクリプト作成**

```bash
#!/usr/bin/env bash
# setup.sh — points to the setup guide. The actual setup is performed by Claude
# (LLM) reading references/setup-guide.md and self-driving via AskUserQuestion +
# Read/Write/Edit tools.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUIDE="$SCRIPT_DIR/../../references/setup-guide.md"

if [[ ! -f "$GUIDE" ]]; then
  echo "ERROR: setup guide not found at $GUIDE" >&2
  exit 1
fi

cat <<EOF
dev-up setup must be driven by Claude (LLM).

This script does not perform the setup directly. Instead, Claude reads the
setup guide and runs through it interactively, prompting the user via
AskUserQuestion where decisions are needed.

If you are seeing this message in a terminal, please ask Claude to:
  Read $GUIDE and follow the procedure to generate .dev-up.yaml.
EOF
```

- [ ] **Step 2: 実行権限 + コミット**

```bash
chmod +x apps/dev-up/skills/dev-up/scripts/setup.sh
git add apps/dev-up/skills/dev-up/scripts/setup.sh
git commit -m "feat(dev-up): add setup.sh stub"
```

---

## Task 18: references/setup-guide.md の作成

**Files:**
- Create: `apps/dev-up/references/setup-guide.md`

- [ ] **Step 1: 手順書を作成**

```markdown
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
```

- [ ] **Step 2: コミット**

```bash
git add apps/dev-up/references/setup-guide.md
git commit -m "feat(dev-up): add references/setup-guide.md for LLM-driven setup"
```

---

## Task 19: SKILL.md の作成

**Files:**
- Create: `apps/dev-up/skills/dev-up/SKILL.md`

- [ ] **Step 1: SKILL.md を作成**

````markdown
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
````

- [ ] **Step 2: コミット**

```bash
git add apps/dev-up/skills/dev-up/SKILL.md
git commit -m "feat(dev-up): add SKILL.md"
```

---

## Task 20: e2e-test app の skeleton 作成

**Files:**
- Create: `apps/e2e-test/.claude-plugin/plugin.json`
- Create: `apps/e2e-test/.codex-plugin/plugin.json`
- Create: `apps/e2e-test/LICENSE`
- Create: `apps/e2e-test/CLAUDE.md`
- Create: `apps/e2e-test/README.md`

- [ ] **Step 1: ディレクトリと manifests 作成**

```bash
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins
mkdir -p apps/e2e-test/{.claude-plugin,.codex-plugin,skills/e2e-test/scripts}
cp apps/cmux-team-dispatch-task/LICENSE apps/e2e-test/LICENSE
```

- [ ] **Step 2: `.claude-plugin/plugin.json` を作成**

```json
{
  "name": "e2e-test",
  "version": "1.0.0",
  "description": "agent-browser based E2E tests against worktree-isolated stacks brought up by dev-up.",
  "author": {
    "name": "tanaka-yui",
    "url": "https://github.com/tanaka-yui"
  },
  "repository": "https://github.com/tanaka-yui/yui-cc-plugins/apps/e2e-test",
  "license": "MIT",
  "keywords": [
    "e2e",
    "browser",
    "agent-browser"
  ],
  "skills": "./skills/"
}
```

- [ ] **Step 3: `.codex-plugin/plugin.json` を作成**

```json
{
  "name": "e2e-test",
  "version": "1.0.0",
  "description": "agent-browser based E2E tests.",
  "author": { "name": "tanaka-yui", "url": "https://github.com/tanaka-yui" },
  "repository": "https://github.com/tanaka-yui/yui-cc-plugins/apps/e2e-test",
  "license": "MIT",
  "keywords": ["e2e", "browser"],
  "skills": "./skills/",
  "interface": {
    "displayName": "e2e-test",
    "shortDescription": "agent-browser E2E for worktree-isolated stacks.",
    "developerName": "tanaka-yui",
    "category": "Development",
    "capabilities": ["Terminal", "Workflow"]
  }
}
```

- [ ] **Step 4: 簡素な README と CLAUDE.md**

```bash
cat > apps/e2e-test/README.md <<'EOF'
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
EOF

cat > apps/e2e-test/CLAUDE.md <<'EOF'
# CLAUDE.md (e2e-test)

This plugin provides the `e2e-test` skill. The skill body is at `skills/e2e-test/SKILL.md`.
EOF
```

- [ ] **Step 5: コミット**

```bash
git add apps/e2e-test/
git commit -m "feat(e2e-test): scaffold plugin directory and manifests"
```

---

## Task 21: e2e-test install.sh の実装

**Files:**
- Create: `apps/e2e-test/skills/e2e-test/scripts/install.sh`

- [ ] **Step 1: スクリプト作成**

```bash
#!/usr/bin/env bash
# install.sh — install agent-browser globally (once per machine).

set -euo pipefail

if command -v agent-browser >/dev/null 2>&1; then
  echo "agent-browser already installed: $(agent-browser --version 2>&1 || echo 'version unknown')"
else
  echo "installing agent-browser via npm..."
  npm install -g agent-browser
fi

echo "running 'agent-browser install' to fetch Chromium..."
agent-browser install
echo "done."
```

- [ ] **Step 2: 実行権限 + コミット**

```bash
chmod +x apps/e2e-test/skills/e2e-test/scripts/install.sh
git add apps/e2e-test/skills/e2e-test/scripts/install.sh
git commit -m "feat(e2e-test): add install.sh"
```

---

## Task 22: e2e-test run.sh の実装

**Files:**
- Create: `apps/e2e-test/skills/e2e-test/scripts/run.sh`

- [ ] **Step 1: スクリプト作成**

```bash
#!/usr/bin/env bash
# run.sh — execute a scenario file against the current worktree's stack.
# Usage: run.sh <scenario-name>

set -euo pipefail

SCENARIO="${1:-}"
[[ -z "$SCENARIO" ]] && { echo "Usage: run.sh <scenario-name>" >&2; exit 2; }

# scenario-name must be a single token without slashes or extensions.
if [[ "$SCENARIO" =~ [/.] ]]; then
  echo "ERROR: scenario-name must be a single token without '/' or '.' (got: $SCENARIO)" >&2
  exit 2
fi

WORKTREE_ROOT=$(git rev-parse --show-toplevel)
cd "$WORKTREE_ROOT"

ENV_FILE="$WORKTREE_ROOT/.env.dispatch"
SCENARIO_FILE="$WORKTREE_ROOT/.e2e-scenarios/$SCENARIO.sh"

[[ -f "$ENV_FILE" ]] || { echo "ERROR: .env.dispatch not found. Run 'dev-up up' first." >&2; exit 1; }
[[ -f "$SCENARIO_FILE" ]] || { echo "ERROR: scenario not found: $SCENARIO_FILE" >&2; exit 1; }
command -v agent-browser >/dev/null 2>&1 || { echo "ERROR: agent-browser not installed. Run 'e2e-test install' first." >&2; exit 1; }

# shellcheck disable=SC1090
source "$ENV_FILE"

export AGENT_BROWSER_SESSION="$PROJECT-$SLOT"
export RESULTS_DIR="$WORKTREE_ROOT/.e2e-results/$SCENARIO"
mkdir -p "$RESULTS_DIR"

echo "running scenario: $SCENARIO (session=$AGENT_BROWSER_SESSION)"
bash "$SCENARIO_FILE"
echo "scenario complete. Results in: $RESULTS_DIR"
```

- [ ] **Step 2: 実行権限 + コミット**

```bash
chmod +x apps/e2e-test/skills/e2e-test/scripts/run.sh
git add apps/e2e-test/skills/e2e-test/scripts/run.sh
git commit -m "feat(e2e-test): add run.sh"
```

---

## Task 23: e2e-test snapshot.sh の実装

**Files:**
- Create: `apps/e2e-test/skills/e2e-test/scripts/snapshot.sh`

- [ ] **Step 1: スクリプト作成**

```bash
#!/usr/bin/env bash
# snapshot.sh — take a snapshot of the current page (or an optionally provided URL).
# Usage: snapshot.sh [url]

set -euo pipefail

WORKTREE_ROOT=$(git rev-parse --show-toplevel)
cd "$WORKTREE_ROOT"

ENV_FILE="$WORKTREE_ROOT/.env.dispatch"
[[ -f "$ENV_FILE" ]] || { echo "ERROR: .env.dispatch not found." >&2; exit 1; }

# shellcheck disable=SC1090
source "$ENV_FILE"
SESSION="$PROJECT-$SLOT"

URL="${1:-}"
if [[ -n "$URL" ]]; then
  agent-browser --session "$SESSION" open "$URL"
fi

agent-browser --session "$SESSION" snapshot --json
```

- [ ] **Step 2: 実行権限 + コミット**

```bash
chmod +x apps/e2e-test/skills/e2e-test/scripts/snapshot.sh
git add apps/e2e-test/skills/e2e-test/scripts/snapshot.sh
git commit -m "feat(e2e-test): add snapshot.sh"
```

---

## Task 24: e2e-test teardown.sh の実装

**Files:**
- Create: `apps/e2e-test/skills/e2e-test/scripts/teardown.sh`

- [ ] **Step 1: スクリプト作成**

```bash
#!/usr/bin/env bash
# teardown.sh — close the agent-browser session for this worktree.

set -euo pipefail

WORKTREE_ROOT=$(git rev-parse --show-toplevel)
cd "$WORKTREE_ROOT"

ENV_FILE="$WORKTREE_ROOT/.env.dispatch"
[[ -f "$ENV_FILE" ]] || { echo "no .env.dispatch found; nothing to teardown" >&2; exit 0; }

# shellcheck disable=SC1090
source "$ENV_FILE"
SESSION="$PROJECT-$SLOT"

agent-browser --session "$SESSION" close 2>/dev/null || true
echo "agent-browser session closed: $SESSION"
```

- [ ] **Step 2: 実行権限 + コミット**

```bash
chmod +x apps/e2e-test/skills/e2e-test/scripts/teardown.sh
git add apps/e2e-test/skills/e2e-test/scripts/teardown.sh
git commit -m "feat(e2e-test): add teardown.sh"
```

---

## Task 25: e2e-test SKILL.md の作成

**Files:**
- Create: `apps/e2e-test/skills/e2e-test/SKILL.md`

- [ ] **Step 1: SKILL.md を作成**

````markdown
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
````

- [ ] **Step 2: コミット**

```bash
git add apps/e2e-test/skills/e2e-test/SKILL.md
git commit -m "feat(e2e-test): add SKILL.md"
```

---

## Task 26: 統合動作確認 (テスト用プロジェクトで end-to-end)

実コードが揃ったので、シンプルな compose-only プロジェクトで end-to-end フローを確認する。

**Files:** (verification only)

- [ ] **Step 1: テスト用プロジェクトを作成**

```bash
rm -rf /tmp/devup-e2e-test
mkdir /tmp/devup-e2e-test
cd /tmp/devup-e2e-test
git init -q

cat > compose.yaml <<'EOF'
services:
  redis:
    image: redis:7-alpine
    ports:
      - "${REDIS_PORT:-6379}:6379"
EOF

cat > .dev-up.yaml <<'EOF'
project: devup-e2e
slot_range: [1, 9]
offset_per_slot: 100
services:
  - name: redis
    type: docker-compose
    files: ["compose.yaml"]
    ports:
      - { name: REDIS_PORT, base: 6379 }
urls:
  - { label: "Redis", template: "redis://localhost:${REDIS_PORT}" }
smoke:
  - { kind: redis, target: "localhost:${REDIS_PORT}" }
EOF

git add -A && git commit -q -m "initial"
```

- [ ] **Step 2: dev-up up を実行**

```bash
SKILL_DIR=/Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins/apps/dev-up/skills/dev-up
bash "$SKILL_DIR/scripts/compose-up.sh"
```

Expected: `reserved slot=1`, redis コンテナが起動 (port 6479)、URL テーブルに `Redis: redis://localhost:6479`、smoke WARN なし。

- [ ] **Step 3: status / urls**

```bash
bash "$SKILL_DIR/scripts/status.sh"
bash "$SKILL_DIR/scripts/urls.sh"
```

Expected: slot=1、docker container が表示される、URL テーブル再表示。

- [ ] **Step 4: 並列起動 (worktree 追加)**

```bash
cd /tmp/devup-e2e-test
git worktree add ../devup-e2e-test-2 -b second
cd ../devup-e2e-test-2
cp ../devup-e2e-test/.dev-up.yaml .
cp ../devup-e2e-test/compose.yaml .
bash "$SKILL_DIR/scripts/compose-up.sh"
```

Expected: `reserved slot=2`、port 6579 で別 redis コンテナ起動、両方並存。

- [ ] **Step 5: down → cleanup**

```bash
bash "$SKILL_DIR/scripts/compose-down.sh"
cd /tmp/devup-e2e-test
bash "$SKILL_DIR/scripts/compose-down.sh"
git worktree remove ../devup-e2e-test-2 --force
git branch -D second 2>/dev/null
```

Expected: 両方の redis が停止、スロット 1/2 とも解放、`.env.dispatch` 削除。

- [ ] **Step 6: クリーンアップ**

```bash
rm -rf /tmp/devup-e2e-test ~/.cache/cc-skills/dev-up/devup-e2e
```

- [ ] **Step 7: コミットはない (verification only)。実装に問題があれば該当タスクへ戻る。**

---

## Task 27: command type の動作確認

`type: command` も含むプロジェクトで動作確認する。

**Files:** (verification only)

- [ ] **Step 1: テスト用プロジェクトを作成**

```bash
rm -rf /tmp/devup-cmd-test
mkdir /tmp/devup-cmd-test
cd /tmp/devup-cmd-test
git init -q

cat > .dev-up.yaml <<'EOF'
project: devup-cmd
slot_range: [1, 9]
offset_per_slot: 100
services:
  - name: web
    type: command
    cwd: "."
    command: "python3 -m http.server ${WEB_PORT}"
    env_overrides:
      - { name: WEB_PORT, base: 18000 }
    health_check:
      kind: http
      target: "http://localhost:${WEB_PORT}/"
      timeout: 10
      interval: 1
urls:
  - { label: "Web", template: "http://localhost:${WEB_PORT}" }
EOF

git add -A && git commit -q -m "initial"
```

- [ ] **Step 2: 起動とヘルスチェック**

```bash
SKILL_DIR=/Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins/apps/dev-up/skills/dev-up
bash "$SKILL_DIR/scripts/compose-up.sh"
```

Expected: `reserved slot=1`、web service が port 18100 で spawn、`health check passed: http http://localhost:18100/`、URL テーブル表示。

- [ ] **Step 3: status で PID 確認**

```bash
bash "$SKILL_DIR/scripts/status.sh"
curl -s http://localhost:18100/ | head -5
```

Expected: `web [alive] pid=...`、curl で directory listing が返る。

- [ ] **Step 4: down で kill**

```bash
bash "$SKILL_DIR/scripts/compose-down.sh"
ps aux | grep "http.server 18100" | grep -v grep ; echo "exit=$?"
```

Expected: `stopping command service: web`, `pgid <N> exited gracefully`, `ps` で web プロセスなし (`exit=1` = grep が見つからない)。

- [ ] **Step 5: クリーンアップ**

```bash
rm -rf /tmp/devup-cmd-test ~/.cache/cc-skills/dev-up/devup-cmd
```

---

## Task 28: marketplace.json に登録

**Files:**
- Modify: `.claude-plugin/marketplace.json`

- [ ] **Step 1: marketplace.json を編集**

`yui-cc-plugins/.claude-plugin/marketplace.json` の `plugins` 配列の末尾に 2 エントリを追加:

```json
,
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

実行例:

```bash
# Read current file to find correct insertion point, then Edit to add entries before the closing "]" of "plugins".
```

- [ ] **Step 2: JSON 構文確認**

```bash
jq . .claude-plugin/marketplace.json > /dev/null && echo "OK"
```

Expected: `OK`。エラーなら JSON 構文を修正。

- [ ] **Step 3: コミット**

```bash
git add .claude-plugin/marketplace.json
git commit -m "feat(marketplace): register dev-up and e2e-test plugins"
```

---

## Task 29: freelance-jp-app に dev-up setup を実行 (リファレンス実装 1)

**Files:** (in freelance-jp-app repo)
- Create: `.dev-up.yaml`
- Modify: `compose.yaml`, `compose.all.yaml`, `.gitignore`

- [ ] **Step 1: freelance-jp-app に skill をリンク or インストール**

```bash
# 開発中は直接 path を呼ぶ:
cd /Users/yui/Documents/workspace/freelance/freelance-jp-app
SKILL_DIR=/Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins/apps/dev-up/skills/dev-up
```

- [ ] **Step 2: setup ガイドに従い `.dev-up.yaml` を作成**

Claude が `references/setup-guide.md` を読み、freelance-jp-app の `compose.yaml` / `compose.all.yaml` を解析。期待される `.dev-up.yaml`:

```yaml
project: freelance-jp-app
slot_range: [1, 9]
offset_per_slot: 100
services:
  - name: compose
    type: docker-compose
    files: ["compose.yaml"]
    ports:
      - { name: DB_PORT,          base: 35432 }
      - { name: DB_DEV_PORT,      base: 35433 }
      - { name: REDIS_PORT,       base: 6379  }
      - { name: PHP_USER_PORT,    base: 9001  }
      - { name: NGINX_USER_PORT,  base: 8081  }
      - { name: PHP_ADMIN_PORT,   base: 9002  }
      - { name: NGINX_ADMIN_PORT, base: 8082  }
      - { name: MAILHOG_WEB_PORT, base: 8025  }
      - { name: MAILHOG_SMTP_PORT,base: 1025  }
urls:
  - { label: "User API",   template: "http://localhost:${NGINX_USER_PORT}" }
  - { label: "Admin API",  template: "http://localhost:${NGINX_ADMIN_PORT}" }
  - { label: "Mailhog UI", template: "http://localhost:${MAILHOG_WEB_PORT}" }
  - { label: "Postgres",   template: "postgres://root:root@localhost:${DB_PORT}" }
  - { label: "Redis",      template: "redis://localhost:${REDIS_PORT}" }
smoke:
  - { kind: http, target: "http://localhost:${NGINX_USER_PORT}/" }
  - { kind: http, target: "http://localhost:${NGINX_ADMIN_PORT}/" }
  - { kind: pg,   target: "localhost:${DB_PORT}", user: "root" }
  - { kind: redis,target: "localhost:${REDIS_PORT}" }
```

- [ ] **Step 3: compose.yaml と compose.all.yaml の ports を `${VAR:-default}` 形式に書き換え**

(spec Components A の表に従い、9 つの ports を全て置換)

- [ ] **Step 4: `.gitignore` に追記**

```
.env.dispatch
.e2e-results/
.e2e-scenarios/
.dev-up-logs/
```

- [ ] **Step 5: 動作確認**

```bash
bash "$SKILL_DIR/scripts/compose-up.sh"
```

Expected: スロット 1 で docker compose 起動、URL 一覧表示、smoke PASS。

- [ ] **Step 6: down 後コミット**

```bash
bash "$SKILL_DIR/scripts/compose-down.sh"
cd /Users/yui/Documents/workspace/freelance/freelance-jp-app
git add .dev-up.yaml compose.yaml compose.all.yaml .gitignore
git commit -m "build(dev-up): adopt dev-up skill for worktree-isolated compose"
```

---

## Task 30: influencer-platform に dev-up setup を実行 (リファレンス実装 2)

**Files:** (in influencer-platform repo)

- [ ] **Step 1: setup ガイドに従い `.dev-up.yaml` を作成**

```bash
cd /Users/yui/Documents/workspace/cyberagent/influencer-platform
SKILL_DIR=/Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins/apps/dev-up/skills/dev-up
```

Claude が compose.yaml + go/ + typescript/ を解析。期待される `.dev-up.yaml`:

```yaml
project: influencer-platform
slot_range: [1, 9]
offset_per_slot: 100

services:
  - name: postgres
    type: docker-compose
    files: ["compose.yaml"]
    ports:
      - { name: DB_PORT, base: 35432 }

  - name: go-api
    type: command
    cwd: "./go"
    command: "task dev"
    env_files: ["./go/.env"]
    env_overrides:
      - { name: SERVER_PORT, base: 8080 }
    health_check:
      kind: http
      target: "http://localhost:${SERVER_PORT}/healthz"
      timeout: 60
      interval: 1
    depends_on: [postgres]

  - name: vite
    type: command
    cwd: "./typescript/apps/admin"
    command: "pnpm dev --port ${VITE_PORT}"
    env_overrides:
      - { name: VITE_PORT, base: 5173 }
    health_check:
      kind: http
      target: "http://localhost:${VITE_PORT}/"
      timeout: 60
    depends_on: [go-api]

urls:
  - { label: "Vite",     template: "http://localhost:${VITE_PORT}" }
  - { label: "Go API",   template: "http://localhost:${SERVER_PORT}" }
  - { label: "Postgres", template: "postgres://root:root@localhost:${DB_PORT}" }

smoke:
  - { kind: http,  target: "http://localhost:${VITE_PORT}/" }
  - { kind: http,  target: "http://localhost:${SERVER_PORT}/" }
  - { kind: pg,    target: "localhost:${DB_PORT}", user: "root" }
```

注意: influencer-platform の実コンパイル設定（task dev コマンド、healthz エンドポイント、Vite のエントリポイント）は事前に確認すること。`task dev` がない場合は `go run ./cmd/api` などに置換。

- [ ] **Step 2: compose.yaml の ports を `${VAR:-default}` に書き換え**

- [ ] **Step 3: `.gitignore` に追記**

- [ ] **Step 4: 動作確認** (`compose-up.sh` → `status.sh` → `compose-down.sh`)

- [ ] **Step 5: コミット**

```bash
git add .dev-up.yaml compose.yaml .gitignore
git commit -m "build(dev-up): adopt dev-up skill for worktree-isolated dev stack"
```

---

## Task 31: 旧 spec/plan の "Superseded" 注記を実装完了後の参照に整える

**Files:**
- Modify: `freelance-jp-app/docs/superpowers/specs/2026-05-13-worktree-isolated-compose-design.md`
- Modify: `freelance-jp-app/docs/superpowers/plans/2026-05-13-worktree-isolated-compose.md`

(既に Superseded 注記済み。新規 plan URL が確定したのでリンクを更新)

- [ ] **Step 1: 旧 spec/plan のリンクを正式パスに更新**

旧 plan のヘッダ行で "(to be written)" となっている部分を削除し、新 plan へのリンクを `yui-cc-plugins/docs/superpowers/plans/2026-05-13-dev-up-and-e2e-test-skills.md` に固定する。

- [ ] **Step 2: コミット**

```bash
cd /Users/yui/Documents/workspace/freelance/freelance-jp-app
git add docs/superpowers/plans/2026-05-13-worktree-isolated-compose.md
git commit -m "docs(superpowers): 旧 plan の Superseded リンクを確定"
```

---

## Task 32: 全 manual verification 実施 (spec の Manual Verification Checklist)

spec の "Manual Verification Checklist" 17 項目を順次確認。

- [ ] **Step 1: spec の Manual Verification Checklist を 1 件ずつ実行**

`yui-cc-plugins/docs/superpowers/specs/2026-05-13-dev-up-and-e2e-test-skills-design.md` の "Manual Verification Checklist" セクションに沿って 17 項目を実行。

各項目に PASS / FAIL / SKIP を記録。FAIL があれば該当タスクに戻って修正。

- [ ] **Step 2: 結果サマリを記録**

すべての項目で PASS なら実装完了。
