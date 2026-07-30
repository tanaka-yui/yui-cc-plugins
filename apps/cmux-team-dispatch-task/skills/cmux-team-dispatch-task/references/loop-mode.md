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
   count**. When prewarm is enabled, each task spins up 3 panes (review disabled) or 4
   panes (review enabled), and adds 1 worktree per task (`concurrency=10` with review
   enabled means 40 panes + 10 worktrees). The upper bound of 10 is a safety valve
   accounting for this amplification, and must not be raised even if requested.
4. **Maximum batch count (`max_batches`)**
   - **3**: "stop after a short run"
   - **5**: "standard upper bound"
   - **10**: "process longer"
   - **Unlimited**: "continue until the target issues are exhausted"

`state` is fixed to `open` and is not asked about.

### Call ②: Execution Configuration

1. **design runner (the child session's runtime)**
   - Dynamically enumerate `runners[]` from `runners.json`: label = `name`, description =
     `command (engine)`.
2. **exec runner (Phase B execution model)**
   - **opus 1m**: "implement with high reasoning effort"
   - **sonnet**: "standard implementation model"
   - **codex**: "shown only when a codex engine runner exists"
3. **Review feature (Phase A-R / Phase B-R)**
   - **Enabled**: "review the design and implementation"
   - **Disabled**: "skip review and proceed"
4. **integration strategy**
   - **PR per task**: "create a PR per issue"
   - **Wait and merge**: "merge after waiting for verified changes"

### Call ③: Supplementary Questions and Final Confirmation

Ask only the applicable questions; if none apply, ask only the single final confirmation
question.

1. **Notification transport (`message_type`)** (when config is unset and agmsg is
   available)
   - Enumerate the available transports; the chosen value is persisted to the global
     config as usual.
2. **reviewer runner** (when the design runner is codex, there are two or more claude
   engine runners, and review is enabled)
   - Dynamically enumerate claude engine runners, to be chosen as "the runner that
     reviews the codex design."
3. **Start the loop with this configuration?**
   - **Start**: "confirm the above configuration and run"
   - **Redo configuration**: "go back to call ①"

## Question Point Decision Table (§4.1)

| # | Original question point | Resolution in loop mode |
|---:|---|---|
| 1 | Step 1a task collection | Resolved by the output of `issue-fetch.sh ... fetch`. |
| 2 | Step 1c brainstorming selection | Fixed to plan mode. |
| 3 | Step 1d layout | Fixed to workspace. |
| 4 | Step 1e integration strategy | Pre-configured in call ②. |
| 5 | Step 1f runner switch / per-task runner | Use call ②'s design runner in common across all tasks. |
| 6 | Step 1f first-run setup (interactive `runners.json` generation) | Checked at L0; if missing, exit with an error without starting. |
| 7 | Step 1f cross-engine reviewer selection | Auto-adopted if there is one claude runner; pre-configured in call ③ if there are two or more. |
| 8 | Step 1g message_type initial setup | Pre-configured in call ③ only when config is unset, and persisted as usual. |
| 9 | Step 1g review_mode | Pre-configured in call ②, and fixed for the duration of the loop. |
| 10 | Wait-and-merge Option A/B at completion | Always merge when integration=merge. Conflicts are handled automatically by the cleanup transition table. |
| 11 | The three cleanup questions at completion | Handled deterministically by the cleanup transition table. |
| 12 | Phase A-R's three rounds of `needs_work` | Note unresolved findings at the end of the document and proceed to Phase B. |
| 13 | Phase A-R reviewer stalled | Re-request the same round once; if stalled again, skip review and proceed to Phase B. |
| 14 | Phase B execution model selection | Bake call ②'s exec runner into `EXEC_DEFAULT_HINT`. |
| 15 | Phase B exec_choice persistence confirmation | Does not occur, due to #14. |
| 16 | Phase B-R's three rounds of `needs_work` | Note unresolved findings in the PR body and create the PR. |
| 17 | Phase B-R reviewer stalled | Note in the PR body that review was skipped, and create the PR. |
| 18 | Implicit approval gate of brainstorming / ExitPlanMode | No approval prompt is shown, due to the fixed plan mode and `--dangerously-skip-permissions`. |

## L2: Initialization, Dispatch, and Waiting

Once the configuration is finalized, run in order: `lock-acquire --lease-min
<lock_lease_min>`, `init --config-json <json> --filter-json <json>`, `reconcile`, the
stale-evidence check for normal dispatch, and `ensure-labels`. If `reconcile` aborts, run
`lock-release` and stop.

Each batch is claimed with `fetch --limit <concurrency> --batch <N>`. `fetch` returning
`[]`, exit 3 (all claims failed), or exit 4 (exhaustion unknown) all end the loop without
starting the next batch. Prepare each issue with `render-loop-prompt.sh` and
`prewarm-panes.sh --unattended`, and run `mark-dispatched` after launch.

`batch-wait.sh --state-file <path> --batch <N> --timeout-min <task_timeout_min>` is
complete only on `ALL_TERMINAL`; re-run on `WAITING`. A task with a `--timeout-sentinel`
does not accept a late-arriving status.

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

Call `lock-release` on every interruption path, including exit 3/4, cleanup failure, and
user interruption. Subsequent fallback uses the finalized config rather than questions.
Only values left unset use the spec's default values (concurrency=5, design=opus,
exec=sonnet, review=the configured value, layout=workspace).
