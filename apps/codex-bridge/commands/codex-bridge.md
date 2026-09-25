---
allowed-tools: Bash, Read, Edit, Write, AskUserQuestion
description: "Claude の rules/CLAUDE.md を Codex 用 AGENTS.md にネスト生成する"
---

# /codex-bridge

Generates each directory's `AGENTS.md` following the frontmatter `codexTargets` of
`.claude/rules/*.md`, and converts the root `CLAUDE.md` into a root `AGENTS.md`. When
`--global` is given, converts `~/.claude/CLAUDE.md` into `~/.codex/AGENTS.md` (so that
Codex responds in Japanese).

## Execution

`<PLUGIN_ROOT>` below is the installed copy of this plugin. No environment variable carries it
into the Bash tool, so resolve it once and write the literal path in its place:

```bash
jq -er '.plugins["codex-bridge@yui-cc-plugins"][0].installPath' ~/.claude/plugins/installed_plugins.json
```

Never pick the newest-looking version directory under the plugin cache (older versions stay there),
and never fall back to a development checkout of this repository: either runs a copy other than the
installed one. If the command fails, stop and tell the user the plugin is not installed. Respond to
the user in Japanese.

No arguments (project generation):

```bash
bun "<PLUGIN_ROOT>/bin/codex-bridge.ts"
```

If `$ARGUMENTS` contains `--global`, generate globally:

```bash
bun "<PLUGIN_ROOT>/bin/codex-bridge.ts" $ARGUMENTS
```

`--max-bytes <n>` overrides the size limit for this run. Without it the limit comes
from `project_doc_max_bytes` in `~/.codex/config.toml`, falling back to Codex's
default of 32768. The first output line states which limit was used and where it
came from.

After running, present the generated/skipped/warning summary to the user. Note, as
needed, that a handwritten `AGENTS.md` (no sentinel) is skipped rather than
overwritten. Respond to the user in Japanese.

## Size overage

The final summary line reports an oversize count. When it is non-zero, act.

An `AGENTS.md` over the limit is **silently truncated by Codex**, so the tail of the
file never reaches the agent. Do not just relay the warning — drive it to a fix.

The tool already prints, per oversized output: the byte count and overage, a
per-rule breakdown, a classification, and remedy candidates. Build your proposal
from that output rather than re-deriving it. Each warning line ends with the
classification as a bracketed identifier; match on that identifier, not on the
surrounding display text.

**Read the classification first — it decides which remedies are even possible.**

- `[concatenation-over-limit]` — no single rule exceeds the limit. Reassigning
  `codexTargets` works. Propose moving the largest contributing rule to a deeper
  directory that still covers the code it governs, and state the resulting byte
  count for both outputs.
- `[single-rule-over-limit]` — some rule exceeds the limit by itself. **Reassigning
  `codexTargets` cannot fix this**: the same oversized body just moves to another
  path. Only splitting the rule file or trimming it works. Do not propose
  retargeting as if it would help.

To propose a split, read the offending rule file and cut it at `##` boundaries into
coherent parts, each of which must be under the limit on its own. Give each part a
`codexTargets` that is as deep as the code it actually governs, so a Codex session
working in a subdirectory loads only what it needs. Name the parts after their
scope, not `part1` / `part2`.

Present the plan with `AskUserQuestion` before touching any file: which sections go
to which new file, the resulting byte count per file, and the `codexTargets` of
each. Splitting rules is an editorial decision about what an agent must read where —
never apply it unattended.

After applying an approved split, re-run the generator and confirm the oversize
count in the summary line is zero. Report the before/after byte counts.

Raising `project_doc_max_bytes` in `~/.codex/config.toml` is a legitimate escape
hatch, but say plainly that it is machine-local: it cannot be committed, so other
developers and CI keep getting truncated files. Offer it as a stopgap, not as the
fix.
