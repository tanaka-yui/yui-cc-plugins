# Explicit Configuration (`--setup` / `--reset`)

`--setup` and `--reset` are the only mechanical configuration entry points. They
dispatch nothing: no worktree, workspace, or pane is created. This document is the
runtime source of truth for both modes.

## Scope

The settings are stored in three places: global config.json, project config.json, and
the runner registry.

| File | Purpose |
|---|---|
| `~/.claude/config/cmux-team-dispatch-task/config.json` | Global `review_mode` and role tuples, plus third-party keys. |
| `<repo>/.dispatch/config.json` | Project role-tuple overrides. |
| `~/.claude/config/cmux-team-dispatch-task/runners.json` | The runner registry. |

The four roles are `design`, `design_review`, `exec`, and `exec_review`. Each role tuple
has `runner`, `model`, and `effort`; `review_mode` is `on` or `off`. Neither mode removes
`.dispatch/`, a worktree, a branch, or a running session.

## Field-level write contract

Use `config-edit.sh` for every `config.json` field-level change. Never build a jq command
by hand. It validates values, preserves unknown keys such as `shell_ready_ms`, and makes
one atomic replacement with a writer-specific `mktemp "$CONFIG.XXXXXX"` followed by `mv`.
`runners.json` creation or rebuild remains the First-run setup interaction in `SKILL.md`.

## Write contract by entry point

The initial configuration is written only by normal First-run: the initial dispatch and
`--reset all`. The table uses stable ids so its Japanese counterpart has the same rows.

<!-- entry-contract:start -->
| Entry | `config.json` effect | Registry effect |
|---|---|---|
| `first-run` | Create the global initial configuration (`create-initial`). | Create the registry. |
| `setup-config` | Make exactly one `config-edit.sh` call (`one-config-edit`) for the selected layer. | No write. |
| `reset-config-global` | Unset the two owned keys in global only (`unset-two-keys`). | No write. |
| `reset-config-project` | Unset the two owned keys in project only (`unset-two-keys`). | No write. |
| `reset-runners` | Do not write either configuration layer (`no-config-write`). | Rebuild only in reset-mode First-run. |
| `reset-all` | Unset both layers, then create the global initial configuration (`unset-both-then-create-initial`). | Remove, then recreate the registry. |
<!-- entry-contract:end -->

`--reset all` has no layer choice: it clears both configuration layers. A reset preserves
unowned keys. Initial configuration assigns the registry default runner to all four roles,
omits model and effort unless a required Codex review model was collected, and asks once
for `review_mode`.

## S: `--setup`

### S0. Preflight

Run the issue-loop lock check. `--setup` is mutually exclusive with `--loop`, `--reset`,
and `--override`; report a conflict instead of guessing.

```bash
bash <SKILL_DIR>/scripts/issue-fetch.sh --state-file .dispatch-loop/loop-state.json lock-check
```

### S1. Show the current state

Show both config layers, their resolved four role tuples, `review_mode`, and the registry.
Mark missing fields as unset. This is an inspection only; do not write while displaying it.

### S2. Choose destination

Ask one question with exactly three targets:

1. global `config.json`;
2. project `config.json`;
3. `runners.json`.

For either `config.json` target, the first role question asks `review_mode` and which
roles to edit. It is a **multi-select** over `design`, `design_review`, `exec`, and
`exec_review`. The selected config layer is the only layer written.

### S3. `runners.json`

Only for the registry target: ask whether to add a runner, rebuild the registry, or leave
it alone. Adding or rebuilding uses the **registry-only setup flow**, then continues to
the registry preview. It never invokes normal First-run and never writes an initial
`config.json`. There is no registry model/effort editing path in `--setup`.

### S4. Ask one tuple per selected role

For each selected role, make one call containing three questions: runner / model / effort.
Runner choices are registered `runners[].name` values. If there are **five or more**
runners, show the first four and use the automatic **Other** input for the rest.

### S5. Pending tuple validation

Keep each reply as a **pending tuple**; do not write it immediately. Derive the engine
from the pending runner, then revalidate all three dimensions — runner, model, and effort
— against that engine. An unknown runner, invalid model, or invalid effort is invalid.

Re-ask only the invalid dimension. If it is invalid a second time, leave that role's whole
pending tuple unchanged. Do not partially apply it. `config.json remains unchanged` while
any pending tuple is being re-asked, and no write happens until every pending change is
valid or discarded.

Before building the command, validate every free-text runner, model, and effort answer.
Reject empty input, leading or trailing whitespace, control characters, and `'`, `"`, `` ` ``,
`$`, `\`, or `!`; re-ask the invalid dimension. Do not trim or shell-interpolate an answer.

### S6. Preview and confirm

Preview exactly one target file: the selected `config.json` layer or `runners.json`. Show
its before and after state, then offer write or abort. Abort writes nothing.

### S7. Write

For a config destination, use the following write. For a project destination, `mkdir -p
.dispatch` first. Then make exactly ONE `config-edit.sh` call containing every accepted
`--set` and `--unset`, so the whole result lands in a single atomic move. Print the result
with `--show`. If the destination was the project layer, tell the user it now shadows the
global layer for this repository.

For a registry destination, add or rebuild the registry through S3's registry-only setup
flow and print that one file. Do not invoke normal First-run and do not call
`config-edit.sh`: `config.json` remains unchanged. There is no cross-file write ordering
rule.

## R: `--reset`

### R0. Preflight

Apply S0's lock check and mutual-exclusion rules.

### R1. Resolve the target

Accept `--reset runners`, `--reset config`, or `--reset all`. With no argument, ask. Only
`--reset config` asks for global, project, or both; `--reset all` never asks for a layer.

### R2. Apply

- **`runners`**: remove only `runners.json`, then run reset-mode First-run. It recreates
  only the registry and leaves both `config.json` files byte-for-byte unchanged.
- **`config`**: for every chosen existing layer, use one call:

  ```bash
  bash <SKILL_DIR>/scripts/config-edit.sh --config <path> \
    --unset review_mode --unset runner
  ```

  This preserves every other key and does not create an absent config.
- **`all`**: run that two-unset call for both existing layers, remove `runners.json`, then
  use normal-mode First-run. It recreates the registry and the global initial configuration.

### R3. Offer to continue

Report the result and offer `--setup` starting at S1.
