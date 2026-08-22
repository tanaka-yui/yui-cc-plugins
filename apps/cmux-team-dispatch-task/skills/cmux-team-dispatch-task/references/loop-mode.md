# GitHub Issue Automatic Loop

`--loop` is the only mechanical entry point. When loop execution is explicitly requested
in natural language, confirm before starting; a mere mention of an issue does not trigger
it. This document is the runtime SoT (source of truth) for loop mode.

## L0: Read-only Check

Check `gh auth status`, `jq`, cmux, and `runners.json`. If `runners.json` is missing, do
not start first-run setup — exit with an error. Run the following before starting:

```bash
bash scripts/issue-fetch.sh --state-file .dispatch-loop/loop-state.json lock-check
```

Do not start if the lock is live. Only a natural-language trigger without `--loop`
requires confirming "should the loop be started" as a single question before this step.

`--loop` is also mutually exclusive with `--override`. This one is structural rather than
policy: `--override` asks a question per task, and an unattended issue loop has nobody to
answer it. A loop run therefore always uses the resolved configuration as-is.

## L1: Batched Configuration Before Start (3 calls)

Because `AskUserQuestion` allows at most four questions per call, this configuration must
always be gathered across exactly the following three calls. Once call ③'s final
confirmation passes, save the configuration to `loop-state.json`'s `config` and `filter`,
and ask no further questions until the loop ends.

### Call ①: Target Issues

1. **Label of target issues**
   - The top three labels (excluding `dispatch/*`) dynamically generated from
     `gh label list`: each means "target only open issues with this label"
   - **No filter**: "do not filter by label"
   - **Other**: "freely enter comma-separated labels"
2. **Assignee filter**
   - **Self (`@me`)**: "only issues assigned to me"
   - **Unassigned only (`no:assignee`)**: "only issues with no assignee"
   - **None**: "do not filter by assignee"
3. **Parallel execution count per batch (`concurrency`)** — default is 5. Present the
   first option as the default.
   - **5 (recommended)**: "standard parallelism"
   - **3**: "reduce resource consumption"
   - **8**: "process more on a high-spec machine"
   - **Other**: "freely enter an integer from 1 to 10"

   Validate the answer as an integer from 1 to 10; if it is out of range or not an
   integer, re-present only this question. `concurrency` is a **task count, not a pane
   count**. When prewarm is enabled, each task starts only its instantiated roles from
   `design`, `design_review`, `exec`, and `exec_review`. With `review_mode=off`, only
   `design` and `exec` are present; with `review_mode=on`, all four roles are present.
   Each task also adds one worktree. The upper bound of 10 is a safety valve for this
   resource amplification and must not be raised even if requested.
4. **Maximum batch count (`max_batches`)**
   - **3**: "stop after a short run"
   - **5**: "standard upper bound"
   - **10**: "process longer"
   - **Unlimited**: "continue until the target issues are exhausted"

`state` is fixed to `open` and is not asked about.

### Call ②: Execution Configuration

1. **Resolved role tuples**
   - Read `design`, `design_review`, `exec`, and `exec_review` from the config layers.
     Each role has its configured `runner`, `model`, and `effort`.
2. **Review mode (`review_mode`)**
   - **on**: use both review roles.
   - **off**: omit both review roles.
3. **integration strategy**
   - **PR per task**: "create a PR per issue"
   - **Wait and merge**: "merge after waiting for verified changes"

### Call ③: Supplementary Questions and Final Confirmation

Ask only the applicable questions; if none apply, ask only the single final confirmation
question.

1. **Start the loop with this configuration?**
   - **Start**: "confirm the above configuration and run"
   - **Redo configuration**: "go back to call ①"

## Question Point Decision Table (§4.1)

| # | Original question point | Resolution in loop mode |
|---:|---|---|
| 1 | Step 1a task collection | Resolved by the output of `issue-fetch.sh ... fetch`. |
| 2 | Step 1c brainstorming selection | Fixed to plan mode. |
| 3 | Step 1d layout | Fixed to workspace. |
| 4 | Step 1e integration strategy | Pre-configured in call ②. |
| 5 | Step 1f runner switch / per-task runner | Use the four role tuples from config in common across all tasks. |
| 6 | Step 1f first-run setup (interactive `runners.json` generation) | Checked at L0; if missing, exit with an error without starting. |
| 7 | Step 1f reviewer selection | Use the configured `design_review` and `exec_review` tuples when `review_mode=on`; omit them when it is `off`. |
| 8 | Step 1g review_mode | Resolved from config as `on` or `off`, and fixed for the duration of the loop. |
| 9 | Wait-and-merge Option A/B at completion | Always merge when integration=merge. Conflicts are handled automatically by the cleanup transition table. |
| 10 | The three cleanup questions at completion | Handled deterministically by the cleanup transition table. |
| 11 | Phase A-R's five rounds of `needs_work` | Note unresolved findings at the end of the document and proceed to Phase B. |
| 12 | Phase A-R reviewer stalled | Re-request the same round once; if stalled again, skip review and proceed to Phase B. |
| 13 | Phase B execution model selection | Use the configured `exec` tuple. |
| 14 | Phase B execution model persistence confirmation | Does not occur because the tuple is fixed in config. |
| 15 | Phase B-R's five rounds of `needs_work` | Note unresolved findings in the PR body and create the PR. |
| 16 | Phase B-R reviewer stalled | Note in the PR body that review was skipped, and create the PR. |
| 17 | Implicit approval gate of brainstorming / ExitPlanMode | No approval prompt is shown, due to the fixed plan mode and `--dangerously-skip-permissions`. |

## L2: Initialization, Dispatch, and Waiting

Once the configuration is finalized, run in order: `lock-acquire --lease-min
<lock_lease_min>`, `init --config-json <json> --filter-json <json>`, `reconcile`, the
stale-evidence check for normal dispatch, and `ensure-labels`. If `reconcile` aborts, run
`lock-release` and stop.

Each batch is claimed with `fetch --limit <concurrency> --batch <N>`. `fetch` returning
`[]`, exit 3 (all claims failed), or exit 4 (exhaustion unknown) all end the loop without
starting the next batch. For each issue, start prewarm with
`prewarm-panes.sh --unattended`.
Collect `[ready]` reports, then run `prune_not_ready` to remove review roles that did
not become ready, and invoke the renderer with the
validated snapshot:

```bash
render-loop-prompt.sh ... --prewarm <STATUS_DIR>/prewarm.json
```

Deliver the rendered prompt only after this sequence, and run `mark-dispatched` after
launch. The renderer reads the four role tuples and `review_mode` from `prewarm.json`;
do not pass role-specific runner or execution-choice flags.

**The parent that runs this loop must be a claude session.** `prewarm-panes.sh
--unattended` dies when it is called from a codex parent: codex cannot arm the 90-minute
safety timer (a self-addressed delayed message dies with the turn, measured as D-T2), and
an unattended loop has nobody to ask, so one lost `dispatch-notify:` would make the job
vanish silently. The all-Codex role tuple above is about the CHILD panes; it says nothing
about the loop driver.

Do not add a different engine or model merely to fill a pane. Pass the timeout sentinel
only to roles that `prewarm.json` actually instantiates.

Do not wait with a script. After dispatching a batch, end your turn. Each child's
`dispatch-notify` message wakes you; on every wake, reconcile the loop state file from
`.dispatch/*/status.json` (the same re-derivation Step 3 describes) and write each
issue's terminal status and `pr_url` into it with `issue-fetch.sh --state-file <path>
heartbeat` first, so the lock owner check still runs before the write.

A batch is complete when every issue in it has a terminal status. Until then, end your
turn again. The single-shot safety timer armed in Step 3 covers a child that never
reports: on that wake, any issue whose `claimed_at` is older than `task_timeout_min`
becomes `timeout`, with the same sentinel (`<loop-dir>/timed-out/<slug>`) and
`status.json` write the old script performed. A task with a `--timeout-sentinel` does
not accept a late-arriving status.

## L3: Cleanup and Termination

After each batch, run `loop-cleanup.sh --state-file <path> --batch <N> --integration
<pr|merge>`. Labels transition from `dispatch/in-progress` (at claim time) to
`dispatch/done` (after completion verification) or `dispatch/failed` (for
failed/timeout/conflict), adding `terminal` first.

Delete the worktree, branch, and the task's `.dispatch` only on success. Merge conflict,
WIP preservation failure, terminal label failure, and unverified PRs are all preserved.
On merge, close verified issues with `gh issue close --reason completed`, and only on
normal cleanup remove the agent from the team via agmsg's `leave.sh`. `leaked[]` and
stale locks are deleted only after manual confirmation.

Cleanup enumerates and de-duplicates the actual `surface_id` and `agent` values in the
task's sparse `prewarm.json`. Every `close-surface` call includes the task workspace, with
workspace-name lookup as the fallback when `status.json` lacks `workspace_id`. No cleanup
or timeout operation targets a role absent from `prewarm.json`.

`loop.task_timeout_min` is a third-party key in `config.json`; `--reset config` does not
remove it.

Call `lock-release` on every interruption path, including exit 3/4, cleanup failure, and
user interruption. Subsequent fallback uses the finalized config rather than questions.
Only values left unset use the spec's default values (concurrency=5, design=claude,
exec=claude, review=the configured value, layout=workspace).
