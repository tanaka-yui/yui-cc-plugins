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

## All field-level writes go through the edit scripts

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

The two edit scripts own every **field-level** update. Creating `runners.json` from
scratch and rebuilding it stay with First-run setup (SKILL.md Step 1f), which writes
the file itself; `runners-edit.sh` only edits an existing registry and **exits 2 when
the file is absent**.

`runners-edit.sh` follows the same pattern for `runners.json`, one runner record at a
time:

```bash
bash <SKILL_DIR>/scripts/runners-edit.sh --runners <path> --name 'ccenec' \
  --set 'plan_model=opus[1m]' --unset exec_model
```

runners-edit.sh takes --runners and --name, then one of --set / --unset (optionally with --dry-run), --get, or --show.
It validates the six per-role `*_model` / `*_effort` fields, merges rather than
replacing (so `name` / `command` / `engine`, other runners, and any unrelated field
survive), and writes through a writer-specific `mktemp "$RUNNERS.XXXXXX"`, moving it
into place only when jq succeeded. Exit codes carry the same meaning as
`config-edit.sh`: 0 success, 1 a write failure that left the file unchanged, 2 a usage
or validation error. `--get <field>` and `--show` read without writing.

The write is last-write-wins, replaces a symlink with a regular file, and leaves the temp file's mode on the result.

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
value, the global value, and the resolved value. Mark a key that is absent from both
layers as unset rather than blank.

Do not use the box-drawing Templates A/B/C here. Those are reserved for task lists,
progress, and the final summary; a configuration listing is none of those.

Follow it with the `runners.json` registry, one runner at a time, in **transposed
form** built from `runners-edit.sh --runners <path> --show` (the whole file): a
heading line plus a 5-line table (header, separator, and the three roles) — 6 lines
per runner.

```
runner: ccenec (command: ccenec, engine: claude)

| role   | model              | effort          |
|--------|--------------------|-----------------|
| plan   | opus[1m]           | max             |
| review | default (opus[1m]) | default (xhigh) |
| exec   | fable              | default (high)  |
```

Show the **effective value** for an unset field instead of leaving the cell blank:
`default (<value>)`. Two exceptions, because a codex model has no effective default:

- `plan_model` / `exec_model` unset on a codex runner → `unset (codex-side default)`
- `review_model` unset on a codex runner → `unset (not review-capable)` — a codex
  reviewer needs `review_model` set, so this is not "falls back to a default", it is
  "cannot currently be chosen as the reviewer"

This differs from how the five role keys are shown above on purpose: a role key is
three-state (a fixed value / `"ask"` / absent), so it needs its state spelled out as
`unset`; a runner field is two-state (set / unset) and always resolves to an effective
value, so showing that value is more useful than the word `unset`.

A runner whose `engine` is neither `claude` nor `codex` (missing, or something like
`gemini`) has no effective defaults and no codex exception to apply. Fill every model
and effort cell with `-` and mark its engine column `unusable engine — cannot be
edited here`.

When more than five runners are registered, only print the transposed form for a
**priority set**: the runner named by `default`, the runners resolved from
`design_runner` / `review_runner`, and the runner Step 1f would resolve from
`exec_choice`'s engine. `exec_choice` is an engine choice (`"claude"` / `"codex"` /
`"ask"`), not a runner name — looking it up directly in `runners[].name` silently
drops the current exec runner. If the priority set is empty (an invalid `default` and
every role key `"ask"`, unset, or invalid), fall back to the first five runners in
registration order. List every other runner as one summary line instead of the full
table, using the **effective** value for every field (`-` for an unset codex model):

`- <name> (<engine>): models <plan>/<review>/<exec>, efforts <plan>/<review>/<exec>`

The threshold of five here is a **display** threshold and is unrelated to M1's
"five or more registered → offer the first four" selection threshold below; six
runners would already print 36 lines, which stops being useful.

The heading line, the table header (`| role | model | effort |`), and the one-line
summary's `models` / `efforts` / `-` tokens are identifiers: keep them in ASCII in
both the English and Japanese docs. Only state labels such as `default (<value>)` get
translated.

### S2. Ask call ① — 2 questions

1. **Destination** — global `~/.claude/cmux-team-dispatch-task/config.json` (the default,
   and the layer every "always ..." answer writes to), or project
   `<repo>/.dispatch/config.json`, which overrides global for this repository only.
2. **Target**:

   | # | Label | Description |
   |---|---|---|
   | 1 | `the role keys only` | per-role models and efforts live in the registry; pick option 2 or 3 to reach them |
   | 2 | `the runner registry (models and efforts included)` | — |
   | 3 | `both — the role keys and the registry (models and efforts included)` | — |

Writing the project layer is the one sanctioned exception to the "global config only"
persistence rule, and it applies only because the user chose it explicitly here.

### S3. `runners.json` (only when it is a target)

If the file does not exist, run **First-run setup** from SKILL.md Step 1f as-is, then
go straight to S4 — S3-M is never offered on this path. If it exists, ask:

| # | Label |
|---|---|
| 1 | `add a runner` |
| 2 | `edit an existing runner's models and efforts` |
| 3 | `rebuild the registry from scratch` |
| 4 | `leave it alone` |

Options 1 and 3 reuse the First-run setup interaction as before, then go straight to
S4 — S3-M is not offered even after adding or rebuilding; re-run `--setup` to keep
editing. Option 2 goes to **S3-M** below. Option 4 goes straight to S4.

Skip First-run setup's review-behavior question in this path — `review_runner` is set in
S4 instead, and asking twice would let the two answers disagree.

**Paths that never reach S3-M:**

- S2 Q2's option 1 (the role keys only) was chosen — S3 itself never runs.
- The file does not exist — First-run setup runs instead (see above).
- `runners-edit.sh --show` returns non-zero (a corrupt registry) — S1 already failed to
  list `runners[]`; do not offer option 2, steer the user to option 3 instead.
- After option 1 (add) or option 3 (rebuild) — go straight to S4, as above.
- `runners[]` is empty, or every entry is excluded by M1 below, leaving zero
  selectable runners — do not offer option 2 at all (an empty M1 would violate
  AskUserQuestion's two-option minimum).
- Exactly one selectable runner remains — option 2 IS still offered, but M1 is
  skipped: that runner is adopted silently and M2 runs directly. A single runner is
  the most common setup, and the repository already has this precedent (CLAUDE.md
  maintenance item 37, "runner count branch: one runner is adopted silently, no
  question").
- A runner is excluded from M1 (with a warning) when its `engine` is neither `claude`
  nor `codex`, or when its `name` contains `'`.
- One `--setup` run edits at most one runner. Re-run `--setup` to edit a second one.

### S3-M. Edit a runner's models and efforts

Only runs when S3's option 2 was chosen. Happy path is **3 `AskUserQuestion` calls**
(worst case +3 = 6, across the three re-ask paths below).

The subsections below use `####`, one level deeper than the rest of this document, so
that `setup-mode.md` and `setup-mode-ja.md` keep matching heading counts and order.

#### M1. Which runner

Options are the entries of `runners[]` (label = `name`, description =
`command (engine)`). With five or more registered, offer the first four and let the
rest arrive through the automatic "Other" free-text field — the same convention S5
uses for `design_runner`.

If "Other" names something not in the list, warn and ask the same question **once
more**. If it is still unrecognized the second time, abandon S3-M and go to S4 (do not
loop forever). S3-M never creates a runner — adding one is S3's option 1.

Runner names containing `'` are excluded from the option list, and their exclusion is
reported.

#### M2. Three model questions in one call

Ask `plan_model`, `review_model`, and `exec_model` together, one call.

#### M3. Three effort questions in one call

Ask `plan_effort`, `review_effort`, and `exec_effort` together, one call.

#### Why by dimension rather than by role

`--override` (Step 1g-2) asks "which role" first, then issues one call per role. S3-M
does not follow that shape:

- `--override` can see a different engine per task, so grouping by role makes sense
  there. Here the runner being edited is fixed for the whole call, so all six fields
  share one engine — there is no per-role engine to separate.
- Every question's first option is always "keep unchanged", so "skip this role" is
  already expressible as option 1. A role-selection question ahead of it adds no
  information.
- The result is **3 calls**: M1 + M2 + M3. Applying `--override` to one task across all
  three roles takes 5 calls (Call 1 + Call 2 + Call 3×3) — S3-M uses 2 fewer calls
  under the same conditions.

#### Building the options

**Do not build a static options table.** Because writing the effective default
explicitly and deleting the field are effectively the same outcome for many
combinations (see the two-state note in S1: a runner field always resolves to an
effective value), a fixed table would leave 1-2 of the 4 slots dead most of the time.
First-run setup's effort options (SKILL.md Step 1f, "plan_effort / review_effort /
exec_effort") already build without duplicates for the same reason.

Build each question with these rules, in order:

1. **opt1 = keep unchanged.**

   | State | Label |
   |---|---|
   | set | `keep (<current>)` |
   | unset, has an effective default | `keep (default: <d>)` |
   | unset, codex `plan_model` / `exec_model` | `keep (unset — codex-side default)` |
   | unset, codex `review_model` | `keep (unset — not review-capable)` |

2. **opt2 onward = fill from the candidate pool, in order**, after removing the
   **current value** and the **effective default** from the pool.
3. **The final slot, reserved before rule 2 runs.** Reserve it first — filling all
   four slots with rule 2 first would remove the only path back to unset (an empty
   "Other" answer means "keep unchanged", not "unset", so it cannot substitute).

   | Condition | Label |
   |---|---|
   | set, has an effective default, and differs from it | `back to the default (<d>)` |
   | set, codex `plan_model` / `exec_model` | `unset it (codex-side default)` |
   | set, codex `review_model` | `unset it (not review-capable)` — description: `this runner can no longer be chosen as the reviewer` |
   | set, matches the effective default (claude model / either engine's effort) | not shown — it would duplicate opt1 |
   | unset | not shown |

4. Candidates that do not fit in the four slots are still reachable through the
   automatic "Other" free-text field. **Never fill a slot with a placeholder.**

**The result always has at least two options.** Rule 2 excludes at most two values
(the current value and the effective default, or one if they are equal), so even the
smallest pool — claude `*_model` with 3 entries — leaves at least one. A set field
also gets rule 3's extra slot. codex model's floor is guaranteed by the `gpt-5.6-sol`
top-up in step 3 of the candidate derivation below.

**Candidate pool** (by engine, in this order):

| target | pool |
|---|---|
| claude `*_model` | `opus[1m]` / `sonnet` / `fable` |
| codex `*_model` | see the codex candidate derivation below |
| claude `*_effort` | `max` / `xhigh` / `high` / `medium` / `low` |
| codex `*_effort` | `xhigh` / `high` / `medium` / `low` / `minimal` |

**`max` exists only in the claude pool** — it never appears on any codex path (pool,
default, or an accepted "Other" answer).

Example (claude runner, `plan_effort` unset, effective default `xhigh`):
`keep (default: xhigh)` / `max` / `high` / `medium` (`xhigh` is excluded because it is
the default; `low` overflows to "Other").

Example (claude runner, `plan_effort: "max"`, effective default `xhigh`, differs):
`keep (max)` / `high` / `medium` / `back to the default (xhigh)` (`max` is the current
value and `xhigh` is the effective default, so both are excluded from the pool; rule 3
reserves the final slot first, so only 2 pool entries fit).

Example (claude runner, `plan_effort: "xhigh"`, matches the effective default):
`keep (xhigh)` / `max` / `high` / `medium` (rule 3 shows nothing; `low` overflows to
"Other").

Example (codex runner, `review_model: "gpt-5.6-sol"`, the only codex model string in
the registry): `keep (gpt-5.6-sol)` / `unset it (not review-capable)` (the candidate
pool is empty; the floor of 2 comes entirely from rule 3).

#### Deriving the codex model candidates

Collect every codex model string that appears anywhere in `runners.json` (the
`plan_model` / `review_model` / `exec_model` values of `engine: codex` records), then:

1. **Exclude the current value of the field being edited** (otherwise it would
   duplicate opt1).
2. Deduplicate, and order by `runners[]` registration order (within one runner:
   `plan_model` → `review_model` → `exec_model`).
3. If slots remain, top up with `gpt-5.6-sol`, the same free-text example First-run
   setup already offers — **only if it does not already match the step-2 pool or the
   current value.** Topping it up right after step 1 removed it (when the current
   value already was `gpt-5.6-sol`) would duplicate opt1; this happens with the
   canonical all-Codex example `gpt-5.6-sol` / `gpt-5.6-sol` / `gpt-5.6-terra`.
4. If slots still remain, **shrink the option count** rather than inventing a
   placeholder. The floor (opt1 + 1) is carried entirely by step 3's `gpt-5.6-sol`
   top-up — it is reached when `engine: codex` runners exist but none has any of the
   three models set yet (immediately after First-run setup left them all blank), so
   step 1 removes nothing and step 2's pool is empty.

#### Warning when a codex review_model is unset

A codex reviewer requires `review_model`. If it is unset and that runner is chosen as
the reviewer, `prewarm-panes.sh` fails at launch with
`die "codex reviewer runner '<name>' requires review_model"` — the dispatch itself
never starts, and there is no clue left days later about why. Three layers guard
against this:

- **(a) S1** — displays `unset (not review-capable)` (see above).
- **(b) M2** — rule 3's `unset it (not review-capable)` option carries the
  description `this runner can no longer be chosen as the reviewer`.
- **(c) S6** — if unsetting it would affect the runner currently named by
  `review_runner` (project or global), add this line to S6's warning list:
  `removing review_model from <runner> — it is the current review_runner, so the next
  dispatch will fail to start`.

#### Free-text answers

| Case | Message |
|---|---|
| M1 "Other" names an unregistered runner | `no runner named <name> is registered; pick one from the list` |
| M1 excludes a name containing `'` | `runner <name> contains a single quote and cannot be edited here; edit runners.json by hand` |
| M1 excludes a runner with an unusable engine | `runner <name> has no usable engine and cannot be edited here` |
| effort "Other" is out of range | `<value> is not a valid effort for the <engine> engine` |
| model "Other" hits a rejection condition | `<value> cannot be used as a model name (it is empty, padded with whitespace, or contains a shell metacharacter or a control character)` |
| S6 warning list heading | `Warnings:` |

- **Effort "Other"** is checked against the engine's allowlist. Out of range → warn
  and re-ask **that one question only**, once. Still out of range the second time →
  leave that field unchanged and carry the warning into the S6 preview. `--setup`
  persists its answers, so silently falling back to a default the way `--override`
  does would mean "the saved value differs from what was typed" without any way to
  notice later.
- **Model "Other"** is not checked against a model-name allowlist, but the rejection
  conditions from `runners-edit.sh` still apply: empty / whitespace-only / **has
  leading or trailing whitespace** / one of five shell metacharacters
  (`'` `"` `` ` `` `$` `\`) / any `[[:cntrl:]]` control character. **Internal
  whitespace passes** (`opus 1m` is accepted — the value always ends up inside a
  quoted string at every downstream layer, and the recipe below always quotes its
  examples, so there is no path where an unquoted argument could split). A rejected
  value warns and re-asks that one question only, once (symmetric with effort).
  **This pre-check is the only guard protecting the S7 command line** — the
  `runners-edit.sh` deny-list runs after the shell has already parsed the line, so it
  cannot help there. This rejection applies only through option 2 of S3; the
  First-run setup paths behind options 1 and 3 do not validate the value.
- **An empty answer** means "keep unchanged" on either dimension.

> **On terminology**: the role keys' `back to unset` wording (used throughout S4/S5,
> `setup-mode-ja.md`, `README.md`, `guide-ja.md`, and `SKILL.md`) is a different
> vocabulary from `back to the default (<d>)` used above. This is a
> deliberate distinction: a role key is three-state and shows its state, a runner
> field is two-state and shows its effective value (see S1). **The one exception is a
> codex `*_model`, which has no effective default and therefore keeps the `unset`
> wording** (rule 3's two exception rows above).

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

When `runners.json` is being edited through S3-M, the preview covers two files:
`config.json`'s before/after as usual, plus `runners.json`'s before/after for **the
edited runner's record only**:

- **before**: `runners-edit.sh --runners <path> --name <runner> --show`
- **after**: `runners-edit.sh --runners <path> --name <runner> <the same --set /
  --unset group> --dry-run`

Both calls print a single record, so no jq is needed on the caller's side. Reusing the
exact same `--set` / `--unset` group that S7 will send is what keeps the preview and
the real write in agreement.

If S3-M deferred any warnings (an effort/model "Other" that failed twice, or the
`review_model`-unset case above), list them under a `Warnings:` heading below the
preview. This is a presentation label, not a markdown heading — turning it into one
would change the heading count SU8 checks.

### S7. Write

1. `runners-edit.sh`, at most once, carrying every `--set` and `--unset` for the
   edited runner in one call:

   ```bash
   bash <SKILL_DIR>/scripts/runners-edit.sh --runners <path> --name 'ccenec' \
     --set 'plan_model=opus[1m]' --set 'plan_effort=max' --unset exec_model
   ```

   **Quote every value.** The single-quoting above assumes the value itself never
   contains `'` — that assumption is guaranteed by S3-M's "Other" pre-check (see
   § Free-text answers above), not by `runners-edit.sh`'s own deny-list. The same
   reasoning protects the `--name` argument: M1 excludes any runner name containing
   `'` before it can reach this command line.
2. For the project destination, `mkdir -p .dispatch` first.
3. Then make exactly ONE `config-edit.sh` call carrying every `--set` and `--unset`,
   so the whole result lands in a single atomic move.
4. Print both results with `--show` afterwards.
5. If the destination was the project layer, tell the user it now shadows the global layer
   for this repository.

The registry is written first (step 1, before step 3): the role keys reference
runners by name, so it reads more naturally for the registry side to already be
settled by the time the role keys are written. Nothing here adds or removes a runner,
so the order does not change the result, but fixing it is still worth doing in case
that ever changes.

**These two files are not one transaction.** Each call is atomic on its own, but there
is no atomicity across the two. Whichever direction fails, report what succeeded, then
print the remaining full command line and stop:

- Step 1 fails → do not run step 3; print the full `config-edit.sh` command line.
- Step 3 fails → report that step 1 already succeeded, then print the full
  `config-edit.sh` command line.

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
