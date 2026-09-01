# Codex Nonstop Handoff

## Current state

- Branch: `feat/codex-nonstop`.
- Completed commits: `d0602c9` (zsh-safe gate path and bash injection), `7f337e8` (shared review-state selector), `3cb4901` (lease/sequence and wait-budget gate work).
- In progress: Task 3c progress leases and Task 4 delegation ordering. Do not set the dispatch status to `done` or `error` until the remaining tasks and mandatory Phase B-R code review complete.

## Implemented behavior

- `review-state.sh` is the single authority for active review point and predicates; the gate consumes its predicates.
- Gate wait leases use `<point>|<round>|<role>|<agent>`, while progress leases use `progress|<role>|<agent>`. These namespaces must stay separate because review waits and active work have different lifetimes.
- The gate arms a progress lease before its final work-in-progress block, so `recovery-tick.sh` can recover an idle active pane even without review files.

## Observed counterexample

The V1 observation that a Stop-hook block restarts Codex is conditional. It was observed for a fresh, TUI-typed turn, but this exec pane became idle after agmsg-injected turns despite a manually reproduced gate `decision=block`. The specification was updated to preserve this counterexample. Recovery must not rely on block effectiveness; `recovery-tick.sh` is the durable recovery layer.

## Traps

- Never stage `.plan-round-*.tmp`; they belong to the design pane and are intentionally untracked.
- The test fixture for a missing team must unset `DISPATCH_GATE_TEAM`; otherwise this session's environment contaminates CG13.
- Invoke `bash -n` after every edit of `completion-gate.sh`: an edit-time syntax error makes the hook unable to block and can mimic the observed idle path.
- Do not arm a review wait lease on each rapid-restart block: that would keep moving its deadline. Progress leases are the intentional exception because a real Stop is evidence of active work under `goals=false`.
