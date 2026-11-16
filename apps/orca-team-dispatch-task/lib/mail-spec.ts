export type MailRole = 'design' | 'design_review' | 'exec' | 'exec_review'
export type MailSpecInput = {
  slug: string
  role: MailRole
  orcaBin: string
  request: string
  plan: string | null
  baseBranch: string
  primaryRepo: string
  extraRepos: Array<{ repo: string; worktreePath: string; branch: string; baseBranch: string }>
  integration: boolean
  planOnly: boolean
  reviewer: string | null
  reviewOf: 'plan' | 'code' | null
  reviewRounds: number
}
export const MAIL_ENVELOPE_MAX_BYTES = 262_144
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

export const renderMailSpec = (input: MailSpecInput): string => {
  const orca = quote(input.orcaBin)
  const prefix = input.role === 'exec' ? 'code' : 'plan'
  const planning = input.role === 'design' && input.planOnly
  const multi = input.extraRepos.length > 0
  const worktrees = multi
    ? `This task spans ${1 + input.extraRepos.length} repositories. Your worktrees:
- ${input.primaryRepo}: this worktree (base ${input.baseBranch})
${input.extraRepos.map((r) => `- ${r.repo}: ${r.worktreePath} (branch ${r.branch}, base ${r.baseBranch})`).join('\n')}
Run git in another worktree with git -C <path>.

`
    : ''
  const extraChecks = multi
    ? '\n' +
      input.extraRepos
        .map(
          (r) =>
            `Repeat step 1 in the worktree for ${r.repo} using git -C ${quote(r.worktreePath)}, comparing with ${quote(r.baseBranch)}; keep its task branch and apply the same clean-worktree and reviewer restrictions.`,
        )
        .join('\n')
    : ''
  const extraPushes =
    multi && input.integration
      ? '\n' +
        input.extraRepos
          .map(
            (r) =>
              `After every commit in ${r.repo}, run git -C ${quote(r.worktreePath)} push origin HEAD:refs/heads/${r.branch} and apply the same saving requirement.`,
          )
          .join('\n')
      : ''
  const envelope = multi
    ? JSON.stringify({
        version: 2,
        nonce: '<16 or more hex characters>',
        heads: [
          { repo: input.primaryRepo, branch: '<git rev-parse --abbrev-ref HEAD>', head: '<git rev-parse HEAD>' },
          ...input.extraRepos.map((r) => ({
            repo: r.repo,
            branch: r.branch,
            head: `<git -C ${r.worktreePath} rev-parse HEAD>`,
          })),
        ],
        files: { '<name>': '<content>' },
      })
    : '{"version":1,"nonce":"<16 or more hex characters>","branch":"<git rev-parse --abbrev-ref HEAD>","head":"<git rev-parse HEAD>","files":{"<name>":"<content>"}}'
  const jqExample = multi
    ? `jq -n --arg nonce <nonce> --arg primaryBranch <your branch> --arg primaryHead <head> ${input.extraRepos.map((_, i) => `--arg branch${i} <branch> --arg head${i} <head>`).join(' ')} --rawfile result <result file> '{version:2,nonce:$nonce,heads:[{repo:${JSON.stringify(input.primaryRepo)},branch:$primaryBranch,head:$primaryHead},${input.extraRepos.map((r, i) => `{repo:${JSON.stringify(r.repo)},branch:$branch${i},head:$head${i}}`).join(',')}],files:{"result.md":$result}}' > <envelope file>`
    : `jq -n --arg nonce <nonce> --arg branch <your branch> --arg head <head> --rawfile result <result file> '{version:1,nonce:$nonce,branch:$branch,head:$head,files:{"result.md":$result}}' > <envelope file>`
  const task = input.reviewOf
    ? `Review the material sent in review requests. Do not implement the reporter's request.
Do not move your worktree's HEAD: do not checkout, reset, or commit. The git instructions
in the reporter's request (including continuation resets) are for the implementer, not you.`
    : input.role === 'exec'
      ? 'Build what the embedded plan describes, in this worktree, and commit it on this branch. Follow the plan; record any departure and its reason in result.md.'
      : `Decide the approach before you touch anything. Write down what you are going to do
and why in result.md before the first edit. If new evidence changes the approach, record why.
${planning ? 'PLAN ONLY. Do not implement anything and commit nothing. Write a concrete plan.md naming files, changes, and verification; another worker builds it.' : 'Do the work in this worktree and commit it on this branch.'}`
  const files = ['result.md (every role)']
  if (planning) files.push('plan.md and plan-result.json')
  if (input.integration) files.push('auto-result.json with the shape requested below')
  if (input.reviewer) files.push(`review/${prefix}-round-<n>-request.md`)
  if (input.reviewOf) files.push(`review/${input.reviewOf}-round-<n>-findings.md`)
  const review = input.reviewer
    ? `Before finishing, obtain review from your assigned reviewer. Review mail goes through your
coordinator: omit --to, and the coordinator forwards it to the reviewer and back.
For each round, put the full plan text (plan review) or the code change description (code
review) in a request file. ${
        prefix === 'code'
          ? multi
            ? `Finish pushing every repository before requesting review. Start each request with one four-line group per repository, primary first:\nrepo: ${input.primaryRepo}\nbranch: <your branch>\nhead: <git rev-parse HEAD>\nbase: ${input.baseBranch}\n${input.extraRepos.map((r) => `repo: ${r.repo}\nbranch: ${r.branch}\nhead: <git -C ${r.worktreePath} rev-parse HEAD>\nbase: ${r.baseBranch}`).join('\n')}\nThen describe the changes so the reviewer can inspect each exact commit.`
            : `Finish pushing before requesting review. Start each request with these three lines:
branch: <your branch>
head: <git rev-parse HEAD>
base: ${input.baseBranch}
Then describe the changes so the reviewer can inspect that exact commit.`
          : ''
      }
Send the request:
${orca} orchestration send --type status <ids> --subject "review-request: ${prefix} round <n>" --body "$(cat <request file>)" --json
Wait using step 6 for review-verdict: ${prefix} round <n> or review-unavailable: ${prefix} round <n>. Ignore earlier rounds returned
by --peek. Only the last VERDICT line exactly reading VERDICT: approved is approval.
Revise on needs_work, up to ${input.reviewRounds} rounds. At the limit, stop revising and
record every unresolved and declined finding with its reason in result.md${input.integration ? ' and auto-result.json review.unresolved / review.declined' : planning ? ' and plan-result.json review.unresolved / review.declined' : ''}.
If sending fails or review-unavailable arrives, review was not delivered: record review unavailable in result.md${input.integration ? ' and review.unresolved in auto-result.json' : planning ? ' and review.unresolved in plan-result.json' : ''}, then continue.
When review is finished, release the reviewer:
${orca} orchestration send --type status <ids> --subject "abort-reviewer: done" --body "the work is finished" --json`
    : input.reviewOf
      ? `Wait using step 6 for review-request: ${input.reviewOf} or abort-reviewer:.
For each new round, read the request body. Ignore rounds you already answered, even when
--peek returns them again. Review mail goes through your coordinator: omit --to, and the
coordinator forwards it to the requester.
${
  input.reviewOf === 'code'
    ? `Read branch:, head:, and base: afresh each round. Run git fetch origin +refs/heads/<branch>,
then verify git rev-parse FETCH_HEAD equals head:. Inspect git diff <base>...FETCH_HEAD and
git show FETCH_HEAD:<path>. If fetch fails or the head differs, return VERDICT: needs_work
with the verification failure; never approve code you did not inspect. To run tests, create
an isolated temporary checkout with git worktree add --detach <tmp> FETCH_HEAD and remove
it with git worktree remove --force <tmp> before finishing; keep your own HEAD unchanged.${multi ? `\nReview every repo: / branch: / head: / base: group. The primary group uses the commands above.\n${input.extraRepos.map((r) => `For ${r.repo}, run git -C ${quote(r.worktreePath)} fetch origin +refs/heads/<branch>, verify git -C ${quote(r.worktreePath)} rev-parse FETCH_HEAD equals head:, and inspect git -C ${quote(r.worktreePath)} diff <base>...FETCH_HEAD and git -C ${quote(r.worktreePath)} show FETCH_HEAD:<path>. If any fetch or head verification fails, return VERDICT: needs_work. To test, use git -C ${quote(r.worktreePath)} worktree add --detach <tmp> FETCH_HEAD and git -C ${quote(r.worktreePath)} worktree remove --force <tmp>; never move your own HEAD.`).join('\n')}` : ''}`
    : 'Read the entire plan in the request body.'
}
Write concrete findings and end with VERDICT: approved or VERDICT: needs_work. Send:
${orca} orchestration send --type status <ids> --subject "review-verdict: ${input.reviewOf} round <n>" --body "$(cat <findings file>)" --json
Keep waiting in this turn. On abort-reviewer:, include all findings and result.md in your
envelope and proceed to step 5.`
      : ''
  return `TASK: ${input.slug} (${input.role})

${task}

${worktrees}Run every verification command the request lists. Normal repository build, test, and edit
tools are allowed. The handoff protocol below uses only ${orca}, git, gh, jq (if installed),
openssl, mktemp, and cat. Do not call any orchestration plugin scripts or read/write paths
on the parent's machine. Put protocol artifacts outside the worktree; never commit them.
Do not ask a person questions. Do not use sudo. Never put secrets in logs or artifacts.

MAIL HANDOFF PROTOCOL
Your terminal handle, task ID and dispatch ID are in your Orca preamble.
<ids> means the identity flags in that preamble's orchestration send examples:
--task-id <task id> --dispatch-id <dispatch id> --from <handle>
Add --dispatch-capability <capability> only if your preamble shows one. Replace placeholders
with their literal values in every command. Do not invent IDs or message types.

1. First run git fetch origin. Compare git rev-parse HEAD with git rev-parse ${quote(input.baseBranch)}.
${
  input.reviewOf
    ? 'As a reviewer, keep your HEAD unchanged; report any unexpected base.'
    : `If they differ, only when git status --porcelain is empty, run git reset --hard ${quote(input.baseBranch)}.
If dirty, report the problem instead of discarding changes. Apply the request's continuation
git instructions after this initial base check. Capture your branch name first with
git rev-parse --abbrev-ref HEAD; keep that task branch when applying a continuation.`
}${extraChecks}

2. At every commit, review exchange, and completed artifact, send a heartbeat:
${orca} orchestration send --type status <ids> --subject "heartbeat: <short note>" --body "-" --json

3. ${input.integration ? 'After every commit, save your task branch to origin:\ngit push origin HEAD:refs/heads/<your branch>\nIf saving fails, fix it or report failure; never claim it was saved.' : 'This role does not publish an implementation branch.'}${extraPushes}

4. Make an artifact directory with mktemp -d outside the worktree. Write ${files.join('; ')} there.
${
  planning
    ? `plan-result.json must have this shape: {"decisions":[],"review":{"unresolved":[],"declined":[]}}.
List every planning decision and unresolved/declined review finding and reason in Japanese;
use empty arrays when none, and never include secrets. Preserve the implementer's result
and verification requirements in plan.md.`
    : ''
}

5. Finish the review protocol below before offering completion. Generate a nonce once for
this offer with openssl rand -hex 8. Build a valid JSON envelope in a temporary file:
${envelope}
For example, when jq is available:
${jqExample}
Add every required artifact to files using its allowed relative name. Without jq, construct
valid JSON carefully. Keep the envelope at most ${MAIL_ENVELOPE_MAX_BYTES} UTF-8 bytes; summarize long
artifacts if needed. If send fails with Argument list too long, shrink it below 120000 bytes
and retry. Offer it:
${orca} orchestration send --type merge_ready <ids> --subject "merge_ready: <nonce>" --body "$(cat <envelope file>)" --json

6. Wait inside this same turn; never end the turn to wait:
${orca} orchestration check --terminal <handle> --peek --wait --timeout-ms 600000 --json
Keep calling it until completion-accepted: <nonce> or completion-remediation: <nonce> for
your current offer arrives. Ignore earlier nonces and rounds returned by --peek. No timeout
or silence permits abandoning the wait. If older unread mail makes checks return at once,
wait 30 seconds between checks when your environment permits it; otherwise keep checking.
On remediation, fix the stated problem and repeat step 5 with a new nonce.

7. Never send worker_done while mail is unread: --peek leaves mail unread, and Orca restarts a
finished worker for its unread mail. Immediately before any worker_done below, mark your mail
read once without --peek:
${orca} orchestration check --terminal <handle> --json
If that check returns mail you have not acted on (for example a remediation for your current
nonce), handle it first and do not send worker_done yet.
After acceptance, send completion exactly once:
${orca} orchestration send --type worker_done --outcome succeeded <ids> --subject "<short status>" --body "<one line>" --json
If the work itself fails, do not send merge_ready. Put the reason in result.md${input.integration ? ' and the relevant auto-result.json fields, including envFailure for environment problems' : ''}, make an envelope as in step 5, and send:
${orca} orchestration send --type worker_done --outcome failed <ids> --subject "<short reason>" --body "$(cat <envelope file>)" --json
Before resending completion after an uncertain send, inspect:
${orca} orchestration dispatch-show --task <task id> --json
If already terminal, do not resend. After worker_done, stop and stay idle.

8. ${review || 'No separate reviewer is assigned.'}

REQUEST (full text)
${input.request}
${input.plan === null ? '' : `\nIMPLEMENTATION PLAN (full text)\n${input.plan}\n`}`
}
