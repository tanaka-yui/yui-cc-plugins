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

**The limit applies to the combined chain, not to each file.** Codex reads the
`AGENTS.md` of every directory from the project root down to its working directory
(in each directory an `AGENTS.override.md` is read instead of `AGENTS.md` when it
exists), root first, and stops once the total reaches `project_doc_max_bytes`: the
file that crosses the limit is truncated and every deeper file is dropped. So the
most specific rules, read last, are the ones lost. The generator measures the chain
from the root to every generated file, handwritten and override files included
(whitespace-only files are not counted, as in Codex).

`--max-bytes <n>` overrides the limit for this run. Without it the limit comes from
`project_doc_max_bytes` in the repository's `.codex/config.toml` (committed; Codex
reads it only for a trusted project), then `~/.codex/config.toml`, then Codex's
default of 32768. The project file wins over the user file, as in Codex. With
`--global`, only `~/.codex/AGENTS.md` is measured, as a single file, against
`--max-bytes` or `~/.codex/config.toml`. The first output line states which limit
was used and where it came from.

The generator exits with status 1 when any chain is over the limit, after writing
every file. A non-zero exit here is the size report, not a crash: still read and
act on the output.

After running, present the generated/skipped/warning summary to the user. Note, as
needed, that a handwritten `AGENTS.md` (no sentinel) is skipped rather than
overwritten. Respond to the user in Japanese.

## Size overage

The final summary line reports an oversize count. When it is non-zero, act.

Content past the limit is **silently dropped by Codex**, so the tail of the chain
never reaches the agent. Do not just relay the warning — drive it to a fix.

The tool already prints, per over-limit chain: the total and overage, every file of
the chain with its bytes and contributing rules, a classification, and remedy
candidates. Build your proposal from that output rather than re-deriving it. Each
warning line ends with the classification as a bracketed identifier; match on that
identifier, not on the surrounding display text.

**Read the classification first — it decides which remedies are even possible.**

- `[chain-over-limit]` — every file fits on its own but the chain from the root does
  not. Shrink the largest file of the chain: for the root `AGENTS.md`, move sections
  that only one layer needs from `CLAUDE.md` into a `.claude/rules/` file with a
  deeper `codexTargets`; for a rule output, move part of it deeper or trim it. State
  the resulting chain totals. Raising the limit in the repository's
  `.codex/config.toml` is the alternative when the content is genuinely needed.
- `[concatenation-over-limit]` — one `AGENTS.md` exceeds the limit by itself while
  each of its rules fits. Reassigning `codexTargets` works. Propose moving its largest
  rule to a deeper directory that still covers the code it governs, and state the
  resulting chain totals.
- `[single-rule-over-limit]` — some rule (or `CLAUDE.md`) exceeds the limit by
  itself. **Reassigning `codexTargets` cannot fix this**: the same oversized body
  just moves to another path. Only splitting the rule file or trimming it works. Do
  not propose retargeting as if it would help.

To propose a split, read the offending rule file and cut it at `##` boundaries into
coherent parts, each of which must be under the limit on its own. Give each part a
`codexTargets` that is as deep as the code it actually governs, so a Codex session
working in a subdirectory loads only what it needs. Name the parts after their
scope, not `part1` / `part2`.

Present the plan with `AskUserQuestion` before touching any file: which sections go
to which new file, the resulting bytes per file and per chain, and the
`codexTargets` of each. Splitting rules is an editorial decision about what an agent
must read where — never apply it unattended.

After applying an approved change, re-run the generator and confirm the oversize
count in the summary line is zero. Report the before/after totals.

Raising `project_doc_max_bytes` is a legitimate alternative when the content is
genuinely needed. Recommend the repository's `.codex/config.toml`: it is committed,
so every developer and CI that trusts the project gets the same limit.
`~/.codex/config.toml` is machine-local and reaches no one else, so offer it only for
`--global` or as a personal stopgap.
