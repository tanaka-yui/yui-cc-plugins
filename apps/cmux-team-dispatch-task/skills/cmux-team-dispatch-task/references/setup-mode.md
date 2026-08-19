# Explicit Configuration (`--setup` / `--reset`)

`--setup` and `--reset` are the only mechanical entry points. Both dispatch nothing —
no worktree, no workspace, no pane is created. This document is the runtime SoT
(source of truth) for both modes.

Without them, the role keys can only be persisted as a side effect of answering
"always ..." during a real dispatch, so reviewing or clearing the configuration used to
require throwing a dummy task at the skill.

## Scope

Two files are in scope, and nothing else:

| File | Holds |
|---|---|
| `~/.claude/cmux-team-dispatch-task/config.json` (global) | the role keys, plus keys owned by other components |
| `<repo>/.dispatch/config.json` (project, overrides global) | the role keys |
| `~/.claude/cmux-team-dispatch-task/runners.json` | the runner registry |

The role keys are exactly these five:

| Key | Values |
|---|---|
| `design_runner` | a `runners[].name`, or `"ask"` |
| `review_runner` | a `runners[].name`, or `"ask"` |
| `exec_choice` | `"claude"` / `"codex"` / `"ask"` |
| `review_mode` | `"on"` / `"off"` / `"ask"` |
| `prewarm` | `true` / `false` |

Neither mode ever touches `.dispatch/<task-slug>/`, worktrees, `feat/*` branches, or any
running session. Deleting those is the job of the end-of-dispatch cleanup prompts in
SKILL.md.

## Three-state semantics

Every role key has three distinct states, and `--setup` can produce all three. Do not
collapse them:

- **a fixed value** — the corresponding question is skipped entirely for every dispatch
- **`"ask"`** — the question is asked, but its persistence options stay hidden
- **the key absent** — the question is asked WITH its persistence options

`review_mode` is the one key where `"ask"` and absent behave identically at dispatch
time; offer "back to asking" for it and write the key out rather than storing `"ask"`.

## All writes go through `config-edit.sh`

Never hand-assemble a jq invocation for these files. One call performs every change as a
single atomic replacement:

```bash
bash <SKILL_DIR>/scripts/config-edit.sh --config <path> \
  --set design_runner=codex --set prewarm=true --unset review_mode
```

The script validates keys and values, merges instead of replacing (so `shell_ready_ms`,
owned by `terminal-wait.sh`, survives), writes through a writer-specific
`mktemp "$CONFIG.XXXXXX"`, and moves it into place only when jq succeeded. It exits 0 on
success, 1 on a write failure that left the file unchanged, and 2 on a usage or
validation error. `--get <key>` and `--show` read without writing.

## S: `--setup`

### S0. Preflight

```bash
bash <SKILL_DIR>/scripts/issue-fetch.sh --state-file .dispatch-loop/loop-state.json lock-check
```

If the lock is live, refuse and stop: an issue loop reads this configuration between
batches, and removing `runners.json` mid-loop breaks it outright.

`--setup` is mutually exclusive with `--loop`, `--reset`, and `--override`. If more than
one is given, do not guess — report the conflict and ask which one to run. Want the
change to stick? Use `--setup`. Want it for this dispatch only? Use `--override` instead.

### S1. Show the current state

Print a plain markdown table of the five role keys with three columns — the project
value, the global value, and the resolved value — followed by the `runners.json`
registry (name, command, engine, and the models each engine uses). Mark a key that is
absent from both layers as unset rather than blank.

Do not use the box-drawing Templates A/B/C here. Those are reserved for task lists,
progress, and the final summary; a configuration listing is none of those.

### S2. Ask call ① — 2 questions

1. **Destination** — global `~/.claude/cmux-team-dispatch-task/config.json` (the default,
   and the layer every "always ..." answer writes to), or project
   `<repo>/.dispatch/config.json`, which overrides global for this repository only.
2. **Target** — the role keys only, `runners.json` only, or both.

Writing the project layer is the one sanctioned exception to the "global config only"
persistence rule, and it applies only because the user chose it explicitly here.

### S3. `runners.json` (only when it is a target)

If the file does not exist, run **First-run setup** from SKILL.md Step 1f as-is. If it
exists, ask whether to add a runner, rebuild the registry from scratch, or leave it
alone, then reuse the same First-run setup interaction.

Skip First-run setup's review-behavior question in this path — `review_runner` is set in
S4 instead, and asking twice would let the two answers disagree.

### S4. Ask call ② — 4 questions

One question per key, four options each, so the call stays inside `AskUserQuestion`'s
limit of four questions and four options. Every question names the current resolved
value.

| Question | Options |
|---|---|
| `design_runner` | pick a fixed runner / `"ask"` / back to unset / leave unchanged |
| `review_runner` | pick a fixed runner / `"ask"` / back to unset (legacy auto-resolution) / leave unchanged |
| `exec_choice` | pick a fixed engine / `"ask"` / back to unset / leave unchanged |
| `review_mode` | `on` / `off` / back to asking every dispatch / leave unchanged |

### S5. Ask call ③ — up to 4 questions, only the ones still needed

- **which `design_runner`** — the entries of `runners[]`. With more than four registered,
  offer the first four and let the rest arrive through the free-text "Other" field.
- **which `review_runner`** — review-capable runners only: a codex runner needs a
  non-empty `review_model`, a claude runner may fall back to `opus[1m]`. The review
  runner may share an engine, or even a name, with the design runner.
- **which `exec_choice`** — `claude` / `codex`. Offer `codex` only when a runner with
  `engine: codex` is registered, and `claude` only when a claude runner is registered.
- **`prewarm`** — `true` / `false` / back to unset (defaults to `true`) / leave unchanged.

### S6. Preview and confirm

Show the target file before and after, then ask a single question: write, or abort. An
abort writes nothing.

### S7. Write

For the project destination, `mkdir -p .dispatch` first. Then make exactly ONE
`config-edit.sh` call carrying every `--set` and `--unset`, so the whole result lands in
a single atomic move. Print the result with `--show` afterwards.

If the destination was the project layer, tell the user it now shadows the global layer
for this repository.

## R: `--reset`

### R0. Preflight

Identical to S0 — the same lock check and the same mutual exclusion.

### R1. Resolve the target

Take it from the argument: `--reset runners`, `--reset config`, or `--reset all`. With no
argument, ask for it (the registry / the role keys / both). An unrecognized target is an
error, not a task description.

When the target includes `config`, ask which layer to clear: global, project, or both.

### R2. Apply

- **`runners`** — set `RUNNERS_RESET=true`, remove only the registry
  (`rm -f -- "$RUNNERS_JSON"`), then run First-run setup in reset mode, which skips every
  config-persistence question. Both `config.json` layers stay untouched.
- **`config`** — one `config-edit.sh` call per selected layer, unsetting exactly the five
  role keys. Every other key, `shell_ready_ms` included, is preserved. A layer whose file
  does not exist is skipped, not created.

Neither branch removes `.dispatch/`, a worktree, or a branch.

### R3. Offer to continue

Report what changed, then ask whether to run `--setup` now. Yes continues at S1 with the
already-completed preflight.
