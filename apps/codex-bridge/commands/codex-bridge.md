---
allowed-tools: Bash
description: "Claude の rules/CLAUDE.md を Codex 用 AGENTS.md にネスト生成する"
---

# /codex-bridge

Generates each directory's `AGENTS.md` following the frontmatter `codexTargets` of
`.claude/rules/*.md`, and converts the root `CLAUDE.md` into a root `AGENTS.md`. When
`--global` is given, converts `~/.claude/CLAUDE.md` into `~/.codex/AGENTS.md` (so that
Codex responds in Japanese).

## Execution

No arguments (project generation):

```bash
bun "${CLAUDE_PLUGIN_ROOT}/bin/codex-bridge.ts"
```

If `$ARGUMENTS` contains `--global`, generate globally:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/bin/codex-bridge.ts" $ARGUMENTS
```

After running, present the generated/skipped/warning summary to the user. Note, as
needed, that a handwritten `AGENTS.md` (no sentinel) is skipped rather than
overwritten, and that files exceeding 32KB carry a truncation risk. Respond to the
user in Japanese.
