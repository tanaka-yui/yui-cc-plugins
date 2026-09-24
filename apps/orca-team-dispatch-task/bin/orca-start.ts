// worktree を用意し、worker を 1 つ起動してタスクを届ける。
// Usage: node orca-start.ts --request-file <f> --slug <s> --objective <o> [--repo-root <p>]
//        [--run <id>] [--agent <id>] [--model <id>] [--effort <level>]
//        [--phase design|exec] [--design-mode direct|plan|brainstorm] [--integration merge|pr]
//        node orca-start.ts --slug <s> --resume [--repo-root <p>] [--design-mode ...]
// Exit: 0 / 1 起動できなかった / 2 使用法
import { die, log } from '../lib/cli.ts'
import { startIncomplete } from '../lib/dispatch.ts'
import { readJson } from '../lib/fs.ts'
import { asArray, asObject, asString, get, type Json, type JsonObject, parseJson } from '../lib/json.ts'
import { orcaBin, runOrca, terminalHandles } from '../lib/orca.ts'
import { envCount, run, runNode, sleepSeconds, which } from '../lib/sys.ts'

import {
  accessSync,
  appendFileSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const NAME = 'orca-start'
const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = resolve(HERE, '..')
const SCRIPTS = join(PLUGIN, 'skills', 'orca-team-dispatch-task', 'scripts')
const RESOLVER = join(SCRIPTS, 'config-resolve.ts')
const SENDER = join(HERE, 'orca-send.ts')
const string = (value: Json | undefined): string => asString(value) ?? ''
const object = (value: Json | undefined): JsonObject => asObject(value) ?? {}
const shellQuote = (value: string): string =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`
const onWsl = (): boolean =>
  process.env.ORCA_ORCHESTRATION_COMPATIBILITY_HOST_KIND === 'wsl' && which('wslpath') !== null
const toHost = (path: string): string | null => {
  if (!onWsl()) return path
  const result = run('wslpath', ['-w', path])
  return result.rc === 0 ? result.stdout.trimEnd() || null : null
}
const toLocal = (path: string): string | null => {
  if (path.startsWith('/') || !onWsl()) return path
  const result = run('wslpath', ['-u', path])
  return result.rc === 0 ? result.stdout.trimEnd() || null : null
}
const write = (site: string, file: string, content: string): boolean => {
  if (process.env.ORCA_FAIL_WRITE_AT === site) {
    log(NAME, `injected write failure at ${site}`)
    return false
  }
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${content}\n`)
    return true
  } catch {
    return false
  }
}
const updateWorkers = (site: string, file: string, mutate: (workers: JsonObject) => void): boolean => {
  const current = asObject(readJson(file))
  if (current === null) return false
  mutate(current)
  return write(site, file, JSON.stringify(current))
}
const readable = (file: string): boolean => {
  try {
    readFileSync(file)
    return true
  } catch {
    return false
  }
}
const nonempty = (file: string): boolean => {
  try {
    return statSync(file).size > 0
  } catch {
    return false
  }
}
const isDir = (file: string): boolean => {
  try {
    return statSync(file).isDirectory()
  } catch {
    return false
  }
}
const git = (repo: string, ...args: string[]) => run('git', ['-C', repo, ...args])
// worker に渡す spec は旧版で描画した文面を固定する。動的な path と依頼だけ差し込む。
const SPEC_TEMPLATES: Record<string, string> = {
  'design_review|on|on|direct':
    'REVIEWER FOR TASK: @@SLUG@@\n\nYou review. **You do not implement anything and you change no file** except the findings\nfiles described below. The work itself belongs to another worker.\n\nThe request that worker was given is in @@REQUEST_FILE@@. Read it for context.\n\nREVIEW LOOP\n\n1. Wait for a request:\n\n     @@ORCA_BIN@@ orchestration check --terminal "$ORCA_TERMINAL_HANDLE" \\\n       --peek --wait --timeout-ms 600000 --json\n\n   Use --peek. **Never pass --ack** — the cursor is not yours to advance.\n   A review request has a subject starting `review-plan:` and names a round number.\n   A subject starting `abort-reviewer:` means the work finished without you; go to step 5.\n\n   **Do not end your turn to wait.** A message put in your mailbox does not wake you, so a\n   turn closed here leaves the worker you review waiting on a verdict that never comes.\n   **An error naming an existing waiter is not a failure.** Orca refuses a wait while\n   another one is active on this Run; the message says so (`waiter_exists`, or an\n   already-active actionable waiter). That means the mailbox is busy, not that the work is\n   gone. Wait a few seconds and run the same command again. It does not count as an empty\n   wait.\n   If the wait returns nothing, run it again, in this same turn. **This wait has no time limit.**\n   Keep waiting until a request or `abort-reviewer:` arrives, however long that takes: the\n   worker you review may be waiting on a person. Whether a stalled task should stop is\n   decided by the user through the parent, not by you.\n\n2. The body names a file under @@REVIEW_DIR@@. Read it and review the plan against the request.\n\n3. Write your findings to @@REVIEW_DIR@@/plan-round-<n>-findings.md, where <n> is the round\n   from the subject. **The prefix matters**: two reviewers share this directory, and a\n   shared filename would overwrite the other one\'s findings. **End the file with exactly one line of this form and nothing after it:**\n\n       VERDICT: approved\n\n   or\n\n       VERDICT: needs_work\n\n   Use needs_work when something must change before this is worth building. Say what and\n   why, concretely, above the verdict line. Do not edit the request file.\n\n4. Send the verdict back:\n\n     node @@SENDER@@ --workers @@WORKERS_FILE@@ --to design \\\n       --subject \'review-verdict: round <n>\' --body \'<absolute path to your findings file>\'\n\n   A non-zero exit means it was NOT delivered. Try once more; if it fails again, leave the\n   findings file in place and go to step 5.\n   Then go back to step 1 for the next round.\n\n5. Finish. Say in result.md which rounds you answered and what each verdict was.\n\nSTATUS PROTOCOL\n\nYour injected preamble gives you the task id, the dispatch id, the dispatch capability\nand the --from handle. Use that set. The Orca CLI is @@ORCA_BIN@@.\n\n**Finishing is two-phase: you offer the work, the parent checks it, then you report.** Do\nnot report done before the parent has accepted. Do not skip a step because the work looks\nobviously fine — the point is that the parent, not you, decides that.\n\nA. Write @@ROLE_DIR@@/status.json with status executing when you start.\nB. Do the work, then write @@ROLE_DIR@@/result.md describing what you did.\n\nC. Offer it. This records the attempt and prints its nonce:\n\n     node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ prepare\n\nD. Tell the parent it is ready. **The subject carries the nonce and nothing else** — Orca\n   builds the payload from the id flags, so a nonce put there would be dropped.\n   **Read the nonce back from the record inside the same command**, as written here: each\n   command you run is a fresh shell, so a variable you set in C is gone by now, and a\n   merge_ready without a nonce jams the parent\'s whole batch.\n\n     @@ORCA_BIN@@ orchestration send --type merge_ready \\\n       --task-id <task id> --dispatch-id <dispatch id> \\\n       --dispatch-capability <capability> --from <handle> \\\n       --subject "merge_ready: $(node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ nonce)" \\\n       --body "<what you did>" --json\n\n   Then run: node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ sent\n   The parent replies on this same dispatch.\n\nE. Wait for that reply. **Do not end your turn to wait.** A message put in your mailbox\n   does not wake you: a turn closed here is a dispatch that stops for good, and someone has\n   to come and restart you by hand.\n\n     node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ await\n\n   It blocks for up to 10 minutes, reads your mailbox with --peek (never --ack), matches\n   your own nonce, and prints one line:\n   - `accepted` -> go to F.\n   - `remediation <reason>` -> the reason says what is missing. Fix it and go back to C.\n     The nonce does not change.\n   - `waiting` -> nobody has answered yet. **Run it again, in this same turn.** Keep\n     running it. It is normal for this to take several rounds. **This wait has no time limit:**\n     whether a stalled task should stop is decided by the user through the parent, not by\n     you.\n   A non-zero exit means the mailbox could not be read at all; try once more. If it fails\n   again, write that in result.md, run\n   `node @@REPORT_STATUS@@ @@ROLE_DIR@@ error the mailbox could not be read`, and stop. Do not report done.\n\nF. Report. `await` already checked the nonce and recorded the acceptance, so there is\n   nothing to confirm here:\n\n     node @@REPORT_STATUS@@ @@ROLE_DIR@@ done <one line>\n\nG. Send worker_done, then record that it landed:\n\n     @@ORCA_BIN@@ orchestration send --type worker_done \\\n       --task-id <task id> --dispatch-id <dispatch id> \\\n       --dispatch-capability <capability> --from <handle> \\\n       --outcome succeeded --subject "<short status>" --body "<what you did>" --json\n     node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ settle\n\n   **Before resending anything, inspect:**\n     @@ORCA_BIN@@ orchestration dispatch-show --task <task id> --json\n   If the dispatch is already terminal, **do not resend** — run settle and stop.\n\nH. **If the work itself failed, none of C-G applies.** Write why in result.md, run\n   `node @@REPORT_STATUS@@ @@ROLE_DIR@@ error <reason>`, and send worker_done with --outcome failed. That\n   status is the record that a failure is still owed; there is nothing to offer.\n\nI. **Do not invent message types.** The only things you send are the ones above, plus\n   `orchestration ask` **when this task told you to ask** (see the brainstorming section, if\n   there is one). Do not send escalations: the parent has no path for them.\n\n   When you do use `ask`, expect it to block until a person answers through the parent, and\n   remember it costs someone\'s attention. Ask only what you need answered.\nJ. End your turn and stay idle.',
  'exec_review|on|on|direct':
    'REVIEWER FOR TASK: @@SLUG@@\n\nYou review. **You do not implement anything and you change no file** except the findings\nfiles described below. The work itself belongs to another worker.\n\nThe request that worker was given is in @@REQUEST_FILE@@. Read it for context.\n\nREVIEW LOOP\n\n1. Wait for a request:\n\n     @@ORCA_BIN@@ orchestration check --terminal "$ORCA_TERMINAL_HANDLE" \\\n       --peek --wait --timeout-ms 600000 --json\n\n   Use --peek. **Never pass --ack** — the cursor is not yours to advance.\n   A review request has a subject starting `review-code:` and names a round number.\n   A subject starting `abort-reviewer:` means the work finished without you; go to step 5.\n\n   **Do not end your turn to wait.** A message put in your mailbox does not wake you, so a\n   turn closed here leaves the worker you review waiting on a verdict that never comes.\n   **An error naming an existing waiter is not a failure.** Orca refuses a wait while\n   another one is active on this Run; the message says so (`waiter_exists`, or an\n   already-active actionable waiter). That means the mailbox is busy, not that the work is\n   gone. Wait a few seconds and run the same command again. It does not count as an empty\n   wait.\n   If the wait returns nothing, run it again, in this same turn. **This wait has no time limit.**\n   Keep waiting until a request or `abort-reviewer:` arrives, however long that takes: the\n   worker you review may be waiting on a person. Whether a stalled task should stop is\n   decided by the user through the parent, not by you.\n\n2. The body names a file under @@REVIEW_DIR@@. Read it and review the implementation against the request.\n\n3. Write your findings to @@REVIEW_DIR@@/code-round-<n>-findings.md, where <n> is the round\n   from the subject. **The prefix matters**: two reviewers share this directory, and a\n   shared filename would overwrite the other one\'s findings. **End the file with exactly one line of this form and nothing after it:**\n\n       VERDICT: approved\n\n   or\n\n       VERDICT: needs_work\n\n   Use needs_work when something must change before this is worth building. Say what and\n   why, concretely, above the verdict line. Do not edit the request file.\n\n4. Send the verdict back:\n\n     node @@SENDER@@ --workers @@WORKERS_FILE@@ --to exec \\\n       --subject \'review-verdict: round <n>\' --body \'<absolute path to your findings file>\'\n\n   A non-zero exit means it was NOT delivered. Try once more; if it fails again, leave the\n   findings file in place and go to step 5.\n   Then go back to step 1 for the next round.\n\n5. Finish. Say in result.md which rounds you answered and what each verdict was.\n\nSTATUS PROTOCOL\n\nYour injected preamble gives you the task id, the dispatch id, the dispatch capability\nand the --from handle. Use that set. The Orca CLI is @@ORCA_BIN@@.\n\n**Finishing is two-phase: you offer the work, the parent checks it, then you report.** Do\nnot report done before the parent has accepted. Do not skip a step because the work looks\nobviously fine — the point is that the parent, not you, decides that.\n\nA. Write @@ROLE_DIR@@/status.json with status executing when you start.\nB. Do the work, then write @@ROLE_DIR@@/result.md describing what you did.\n\nC. Offer it. This records the attempt and prints its nonce:\n\n     node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ prepare\n\nD. Tell the parent it is ready. **The subject carries the nonce and nothing else** — Orca\n   builds the payload from the id flags, so a nonce put there would be dropped.\n   **Read the nonce back from the record inside the same command**, as written here: each\n   command you run is a fresh shell, so a variable you set in C is gone by now, and a\n   merge_ready without a nonce jams the parent\'s whole batch.\n\n     @@ORCA_BIN@@ orchestration send --type merge_ready \\\n       --task-id <task id> --dispatch-id <dispatch id> \\\n       --dispatch-capability <capability> --from <handle> \\\n       --subject "merge_ready: $(node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ nonce)" \\\n       --body "<what you did>" --json\n\n   Then run: node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ sent\n   The parent replies on this same dispatch.\n\nE. Wait for that reply. **Do not end your turn to wait.** A message put in your mailbox\n   does not wake you: a turn closed here is a dispatch that stops for good, and someone has\n   to come and restart you by hand.\n\n     node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ await\n\n   It blocks for up to 10 minutes, reads your mailbox with --peek (never --ack), matches\n   your own nonce, and prints one line:\n   - `accepted` -> go to F.\n   - `remediation <reason>` -> the reason says what is missing. Fix it and go back to C.\n     The nonce does not change.\n   - `waiting` -> nobody has answered yet. **Run it again, in this same turn.** Keep\n     running it. It is normal for this to take several rounds. **This wait has no time limit:**\n     whether a stalled task should stop is decided by the user through the parent, not by\n     you.\n   A non-zero exit means the mailbox could not be read at all; try once more. If it fails\n   again, write that in result.md, run\n   `node @@REPORT_STATUS@@ @@ROLE_DIR@@ error the mailbox could not be read`, and stop. Do not report done.\n\nF. Report. `await` already checked the nonce and recorded the acceptance, so there is\n   nothing to confirm here:\n\n     node @@REPORT_STATUS@@ @@ROLE_DIR@@ done <one line>\n\nG. Send worker_done, then record that it landed:\n\n     @@ORCA_BIN@@ orchestration send --type worker_done \\\n       --task-id <task id> --dispatch-id <dispatch id> \\\n       --dispatch-capability <capability> --from <handle> \\\n       --outcome succeeded --subject "<short status>" --body "<what you did>" --json\n     node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ settle\n\n   **Before resending anything, inspect:**\n     @@ORCA_BIN@@ orchestration dispatch-show --task <task id> --json\n   If the dispatch is already terminal, **do not resend** — run settle and stop.\n\nH. **If the work itself failed, none of C-G applies.** Write why in result.md, run\n   `node @@REPORT_STATUS@@ @@ROLE_DIR@@ error <reason>`, and send worker_done with --outcome failed. That\n   status is the record that a failure is still owed; there is nothing to offer.\n\nI. **Do not invent message types.** The only things you send are the ones above, plus\n   `orchestration ask` **when this task told you to ask** (see the brainstorming section, if\n   there is one). Do not send escalations: the parent has no path for them.\n\n   When you do use `ask`, expect it to block until a person answers through the parent, and\n   remember it costs someone\'s attention. Ask only what you need answered.\nJ. End your turn and stay idle.',
  'exec|on|on|direct':
    'TASK: @@SLUG@@ (implementation)\n\nAnother worker has already planned this. **The plan says what to build.** It is at\n@@PLAN@@. Read it first. If @@SPEC@@ exists, it is the\ndesign the plan was written from: read it too. The original request is at\n@@REQUEST_FILE@@ for context.\n\nREVIEW PROTOCOL (do this before you finish)\n\nA reviewer is already running and waiting for you. Have your implementation reviewed before you finish.\n\n1. Write your implementation to @@REVIEW_DIR@@/code-round-<n>-request.md, starting at n=1. Be concrete enough\n   that someone can disagree with it.\n\n2. Send the request:\n\n     node @@SENDER@@ --workers @@WORKERS_FILE@@ --to exec_review \\\n       --subject \'review-code: round <n>\' --body \'<absolute path to your request file>\'\n\n   **A non-zero exit means it was NOT delivered.** Delete the request file you just wrote,\n   note in result.md that review was unavailable, and carry on without it.\n\n3. Wait for the verdict:\n\n     @@ORCA_BIN@@ orchestration check --terminal "$ORCA_TERMINAL_HANDLE" \\\n       --peek --wait --timeout-ms 600000 --json\n\n   Use --peek. **Never pass --ack.** Look for a subject starting `review-verdict:`.\n   A subject starting `review-skipped:` means the parent stopped your reviewer: go to step 6.\n\n   **Do not end your turn to wait.** A message put in your mailbox does not wake you, so a\n   turn closed here is a dispatch that stops for good. If the wait returns nothing, run it\n   again, in this same turn — reviewing takes longer than one wait. **This wait has no time limit.**\n   Do not skip the review because nothing has arrived yet.\n\n   **An error naming an existing waiter is not reviewisunavailable.** Orca refuses a\n   wait while another one is active on this Run (`waiter_exists`, or an already-active\n   actionable waiter). Wait a few seconds and run the same command again. **Do not record\n   the review as skipped because of it** — only a `review-skipped:` message justifies that.\n\n4. The body names a findings file. Read it. **Only a line reading exactly\n   `VERDICT: approved` means approved.** Anything else, including a missing VERDICT line,\n   is needs_work.\n\n5. On needs_work: revise and repeat from step 1 with the next round number.\n   **Stop after round 2.** Record the unresolved findings in result.md and keep the best\n   version you have. Do not keep asking.\n\n6. On `review-skipped:`, your reviewer is gone. Note in result.md that round <n> was not\n   reviewed because the reviewer was stopped, and proceed without review. Skip step 7.\n\n7. When you are done, release the reviewer:\n\n     node @@SENDER@@ --workers @@WORKERS_FILE@@ --to exec_review \\\n       --subject \'abort-reviewer: done\' --body \'the work is finished\'\n\n1. Build what the plan describes, in this worktree, and commit it on this branch.\n2. **Follow the plan.** If a step turns out to be wrong or impossible, do the rest, and say\n   in result.md exactly which step you departed from and why. Do not silently redesign it.\n3. Do not edit @@PLAN@@ or @@SPEC@@. They are the record\n   of what was agreed.\n\nSTATUS PROTOCOL\n\nYour injected preamble gives you the task id, the dispatch id, the dispatch capability\nand the --from handle. Use that set. The Orca CLI is @@ORCA_BIN@@.\n\n**Finishing is two-phase: you offer the work, the parent checks it, then you report.** Do\nnot report done before the parent has accepted. Do not skip a step because the work looks\nobviously fine — the point is that the parent, not you, decides that.\n\nA. Write @@ROLE_DIR@@/status.json with status executing when you start.\nB. Do the work, then write @@ROLE_DIR@@/result.md describing what you did.\n\nC. Offer it. This records the attempt and prints its nonce:\n\n     node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ prepare\n\nD. Tell the parent it is ready. **The subject carries the nonce and nothing else** — Orca\n   builds the payload from the id flags, so a nonce put there would be dropped.\n   **Read the nonce back from the record inside the same command**, as written here: each\n   command you run is a fresh shell, so a variable you set in C is gone by now, and a\n   merge_ready without a nonce jams the parent\'s whole batch.\n\n     @@ORCA_BIN@@ orchestration send --type merge_ready \\\n       --task-id <task id> --dispatch-id <dispatch id> \\\n       --dispatch-capability <capability> --from <handle> \\\n       --subject "merge_ready: $(node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ nonce)" \\\n       --body "<what you did>" --json\n\n   Then run: node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ sent\n   The parent replies on this same dispatch.\n\nE. Wait for that reply. **Do not end your turn to wait.** A message put in your mailbox\n   does not wake you: a turn closed here is a dispatch that stops for good, and someone has\n   to come and restart you by hand.\n\n     node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ await\n\n   It blocks for up to 10 minutes, reads your mailbox with --peek (never --ack), matches\n   your own nonce, and prints one line:\n   - `accepted` -> go to F.\n   - `remediation <reason>` -> the reason says what is missing. Fix it and go back to C.\n     The nonce does not change.\n   - `waiting` -> nobody has answered yet. **Run it again, in this same turn.** Keep\n     running it. It is normal for this to take several rounds. **This wait has no time limit:**\n     whether a stalled task should stop is decided by the user through the parent, not by\n     you.\n   A non-zero exit means the mailbox could not be read at all; try once more. If it fails\n   again, write that in result.md, run\n   `node @@REPORT_STATUS@@ @@ROLE_DIR@@ error the mailbox could not be read`, and stop. Do not report done.\n\nF. Report. `await` already checked the nonce and recorded the acceptance, so there is\n   nothing to confirm here:\n\n     node @@REPORT_STATUS@@ @@ROLE_DIR@@ done <one line>\n\nG. Send worker_done, then record that it landed:\n\n     @@ORCA_BIN@@ orchestration send --type worker_done \\\n       --task-id <task id> --dispatch-id <dispatch id> \\\n       --dispatch-capability <capability> --from <handle> \\\n       --outcome succeeded --subject "<short status>" --body "<what you did>" --json\n     node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ settle\n\n   **Before resending anything, inspect:**\n     @@ORCA_BIN@@ orchestration dispatch-show --task <task id> --json\n   If the dispatch is already terminal, **do not resend** — run settle and stop.\n\nH. **If the work itself failed, none of C-G applies.** Write why in result.md, run\n   `node @@REPORT_STATUS@@ @@ROLE_DIR@@ error <reason>`, and send worker_done with --outcome failed. That\n   status is the record that a failure is still owed; there is nothing to offer.\n\nI. **Do not invent message types.** The only things you send are the ones above, plus\n   `orchestration ask` **when this task told you to ask** (see the brainstorming section, if\n   there is one). Do not send escalations: the parent has no path for them.\n\n   When you do use `ask`, expect it to block until a person answers through the parent, and\n   remember it costs someone\'s attention. Ask only what you need answered.\nJ. End your turn and stay idle.',
  'exec|off|on|direct':
    'TASK: @@SLUG@@ (implementation)\n\nAnother worker has already planned this. **The plan says what to build.** It is at\n@@PLAN@@. Read it first. If @@SPEC@@ exists, it is the\ndesign the plan was written from: read it too. The original request is at\n@@REQUEST_FILE@@ for context.\n\n1. Build what the plan describes, in this worktree, and commit it on this branch.\n2. **Follow the plan.** If a step turns out to be wrong or impossible, do the rest, and say\n   in result.md exactly which step you departed from and why. Do not silently redesign it.\n3. Do not edit @@PLAN@@ or @@SPEC@@. They are the record\n   of what was agreed.\n\nSTATUS PROTOCOL\n\nYour injected preamble gives you the task id, the dispatch id, the dispatch capability\nand the --from handle. Use that set. The Orca CLI is @@ORCA_BIN@@.\n\n**Finishing is two-phase: you offer the work, the parent checks it, then you report.** Do\nnot report done before the parent has accepted. Do not skip a step because the work looks\nobviously fine — the point is that the parent, not you, decides that.\n\nA. Write @@ROLE_DIR@@/status.json with status executing when you start.\nB. Do the work, then write @@ROLE_DIR@@/result.md describing what you did.\n\nC. Offer it. This records the attempt and prints its nonce:\n\n     node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ prepare\n\nD. Tell the parent it is ready. **The subject carries the nonce and nothing else** — Orca\n   builds the payload from the id flags, so a nonce put there would be dropped.\n   **Read the nonce back from the record inside the same command**, as written here: each\n   command you run is a fresh shell, so a variable you set in C is gone by now, and a\n   merge_ready without a nonce jams the parent\'s whole batch.\n\n     @@ORCA_BIN@@ orchestration send --type merge_ready \\\n       --task-id <task id> --dispatch-id <dispatch id> \\\n       --dispatch-capability <capability> --from <handle> \\\n       --subject "merge_ready: $(node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ nonce)" \\\n       --body "<what you did>" --json\n\n   Then run: node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ sent\n   The parent replies on this same dispatch.\n\nE. Wait for that reply. **Do not end your turn to wait.** A message put in your mailbox\n   does not wake you: a turn closed here is a dispatch that stops for good, and someone has\n   to come and restart you by hand.\n\n     node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ await\n\n   It blocks for up to 10 minutes, reads your mailbox with --peek (never --ack), matches\n   your own nonce, and prints one line:\n   - `accepted` -> go to F.\n   - `remediation <reason>` -> the reason says what is missing. Fix it and go back to C.\n     The nonce does not change.\n   - `waiting` -> nobody has answered yet. **Run it again, in this same turn.** Keep\n     running it. It is normal for this to take several rounds. **This wait has no time limit:**\n     whether a stalled task should stop is decided by the user through the parent, not by\n     you.\n   A non-zero exit means the mailbox could not be read at all; try once more. If it fails\n   again, write that in result.md, run\n   `node @@REPORT_STATUS@@ @@ROLE_DIR@@ error the mailbox could not be read`, and stop. Do not report done.\n\nF. Report. `await` already checked the nonce and recorded the acceptance, so there is\n   nothing to confirm here:\n\n     node @@REPORT_STATUS@@ @@ROLE_DIR@@ done <one line>\n\nG. Send worker_done, then record that it landed:\n\n     @@ORCA_BIN@@ orchestration send --type worker_done \\\n       --task-id <task id> --dispatch-id <dispatch id> \\\n       --dispatch-capability <capability> --from <handle> \\\n       --outcome succeeded --subject "<short status>" --body "<what you did>" --json\n     node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ settle\n\n   **Before resending anything, inspect:**\n     @@ORCA_BIN@@ orchestration dispatch-show --task <task id> --json\n   If the dispatch is already terminal, **do not resend** — run settle and stop.\n\nH. **If the work itself failed, none of C-G applies.** Write why in result.md, run\n   `node @@REPORT_STATUS@@ @@ROLE_DIR@@ error <reason>`, and send worker_done with --outcome failed. That\n   status is the record that a failure is still owed; there is nothing to offer.\n\nI. **Do not invent message types.** The only things you send are the ones above, plus\n   `orchestration ask` **when this task told you to ask** (see the brainstorming section, if\n   there is one). Do not send escalations: the parent has no path for them.\n\n   When you do use `ask`, expect it to block until a person answers through the parent, and\n   remember it costs someone\'s attention. Ask only what you need answered.\nJ. End your turn and stay idle.',
  'design|on|on|direct':
    'TASK: @@SLUG@@\n\n@@REQUEST_CONTENT@@\n\nREVIEW PROTOCOL (do this before you finish)\n\nA reviewer is already running and waiting for you. Have your plan reviewed before you finish.\n\n1. Write your plan to @@REVIEW_DIR@@/plan-round-<n>-request.md, starting at n=1. Be concrete enough\n   that someone can disagree with it.\n\n2. Send the request:\n\n     node @@SENDER@@ --workers @@WORKERS_FILE@@ --to design_review \\\n       --subject \'review-plan: round <n>\' --body \'<absolute path to your request file>\'\n\n   **A non-zero exit means it was NOT delivered.** Delete the request file you just wrote,\n   note in result.md that review was unavailable, and carry on without it.\n\n3. Wait for the verdict:\n\n     @@ORCA_BIN@@ orchestration check --terminal "$ORCA_TERMINAL_HANDLE" \\\n       --peek --wait --timeout-ms 600000 --json\n\n   Use --peek. **Never pass --ack.** Look for a subject starting `review-verdict:`.\n   A subject starting `review-skipped:` means the parent stopped your reviewer: go to step 6.\n\n   **Do not end your turn to wait.** A message put in your mailbox does not wake you, so a\n   turn closed here is a dispatch that stops for good. If the wait returns nothing, run it\n   again, in this same turn — reviewing takes longer than one wait. **This wait has no time limit.**\n   Do not skip the review because nothing has arrived yet.\n\n   **An error naming an existing waiter is not reviewisunavailable.** Orca refuses a\n   wait while another one is active on this Run (`waiter_exists`, or an already-active\n   actionable waiter). Wait a few seconds and run the same command again. **Do not record\n   the review as skipped because of it** — only a `review-skipped:` message justifies that.\n\n4. The body names a findings file. Read it. **Only a line reading exactly\n   `VERDICT: approved` means approved.** Anything else, including a missing VERDICT line,\n   is needs_work.\n\n5. On needs_work: revise and repeat from step 1 with the next round number.\n   **Stop after round 2.** Record the unresolved findings in result.md and keep the best\n   version you have. Do not keep asking.\n\n6. On `review-skipped:`, your reviewer is gone. Note in result.md that round <n> was not\n   reviewed because the reviewer was stopped, and proceed without review. Skip step 7.\n\n7. When you are done, release the reviewer:\n\n     node @@SENDER@@ --workers @@WORKERS_FILE@@ --to design_review \\\n       --subject \'abort-reviewer: done\' --body \'the work is finished\'\n\nPLAN ONLY. **Do not implement anything and commit nothing.**\n\nAnother worker will build this from your plan, in a different worktree. Write the plan to\n@@PLAN@@ and leave every other file alone.\n\nMake it specific enough to be built from without asking you: name the files to change, what\neach change is for, and how someone would tell it worked. If the request cannot be built as\nasked, say so in the plan rather than inventing a different task.\n\nSTATUS PROTOCOL\n\nYour injected preamble gives you the task id, the dispatch id, the dispatch capability\nand the --from handle. Use that set. The Orca CLI is @@ORCA_BIN@@.\n\n**Finishing is two-phase: you offer the work, the parent checks it, then you report.** Do\nnot report done before the parent has accepted. Do not skip a step because the work looks\nobviously fine — the point is that the parent, not you, decides that.\n\nA. Write @@ROLE_DIR@@/status.json with status executing when you start.\nB. Do the work, then write @@ROLE_DIR@@/result.md describing what you did.\n\nC. Offer it. This records the attempt and prints its nonce:\n\n     node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ prepare\n\nD. Tell the parent it is ready. **The subject carries the nonce and nothing else** — Orca\n   builds the payload from the id flags, so a nonce put there would be dropped.\n   **Read the nonce back from the record inside the same command**, as written here: each\n   command you run is a fresh shell, so a variable you set in C is gone by now, and a\n   merge_ready without a nonce jams the parent\'s whole batch.\n\n     @@ORCA_BIN@@ orchestration send --type merge_ready \\\n       --task-id <task id> --dispatch-id <dispatch id> \\\n       --dispatch-capability <capability> --from <handle> \\\n       --subject "merge_ready: $(node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ nonce)" \\\n       --body "<what you did>" --json\n\n   Then run: node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ sent\n   The parent replies on this same dispatch.\n\nE. Wait for that reply. **Do not end your turn to wait.** A message put in your mailbox\n   does not wake you: a turn closed here is a dispatch that stops for good, and someone has\n   to come and restart you by hand.\n\n     node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ await\n\n   It blocks for up to 10 minutes, reads your mailbox with --peek (never --ack), matches\n   your own nonce, and prints one line:\n   - `accepted` -> go to F.\n   - `remediation <reason>` -> the reason says what is missing. Fix it and go back to C.\n     The nonce does not change.\n   - `waiting` -> nobody has answered yet. **Run it again, in this same turn.** Keep\n     running it. It is normal for this to take several rounds. **This wait has no time limit:**\n     whether a stalled task should stop is decided by the user through the parent, not by\n     you.\n   A non-zero exit means the mailbox could not be read at all; try once more. If it fails\n   again, write that in result.md, run\n   `node @@REPORT_STATUS@@ @@ROLE_DIR@@ error the mailbox could not be read`, and stop. Do not report done.\n\nF. Report. `await` already checked the nonce and recorded the acceptance, so there is\n   nothing to confirm here:\n\n     node @@REPORT_STATUS@@ @@ROLE_DIR@@ done <one line>\n\nG. Send worker_done, then record that it landed:\n\n     @@ORCA_BIN@@ orchestration send --type worker_done \\\n       --task-id <task id> --dispatch-id <dispatch id> \\\n       --dispatch-capability <capability> --from <handle> \\\n       --outcome succeeded --subject "<short status>" --body "<what you did>" --json\n     node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ settle\n\n   **Before resending anything, inspect:**\n     @@ORCA_BIN@@ orchestration dispatch-show --task <task id> --json\n   If the dispatch is already terminal, **do not resend** — run settle and stop.\n\nH. **If the work itself failed, none of C-G applies.** Write why in result.md, run\n   `node @@REPORT_STATUS@@ @@ROLE_DIR@@ error <reason>`, and send worker_done with --outcome failed. That\n   status is the record that a failure is still owed; there is nothing to offer.\n\nI. **Do not invent message types.** The only things you send are the ones above, plus\n   `orchestration ask` **when this task told you to ask** (see the brainstorming section, if\n   there is one). Do not send escalations: the parent has no path for them.\n\n   When you do use `ask`, expect it to block until a person answers through the parent, and\n   remember it costs someone\'s attention. Ask only what you need answered.\nJ. End your turn and stay idle.',
  'design|on|on|plan':
    'TASK: @@SLUG@@\n\n@@REQUEST_CONTENT@@\n\nREVIEW PROTOCOL (do this before you finish)\n\nA reviewer is already running and waiting for you. Have your plan reviewed before you finish.\n\n1. Write your plan to @@REVIEW_DIR@@/plan-round-<n>-request.md, starting at n=1. Be concrete enough\n   that someone can disagree with it.\n\n2. Send the request:\n\n     node @@SENDER@@ --workers @@WORKERS_FILE@@ --to design_review \\\n       --subject \'review-plan: round <n>\' --body \'<absolute path to your request file>\'\n\n   **A non-zero exit means it was NOT delivered.** Delete the request file you just wrote,\n   note in result.md that review was unavailable, and carry on without it.\n\n3. Wait for the verdict:\n\n     @@ORCA_BIN@@ orchestration check --terminal "$ORCA_TERMINAL_HANDLE" \\\n       --peek --wait --timeout-ms 600000 --json\n\n   Use --peek. **Never pass --ack.** Look for a subject starting `review-verdict:`.\n   A subject starting `review-skipped:` means the parent stopped your reviewer: go to step 6.\n\n   **Do not end your turn to wait.** A message put in your mailbox does not wake you, so a\n   turn closed here is a dispatch that stops for good. If the wait returns nothing, run it\n   again, in this same turn — reviewing takes longer than one wait. **This wait has no time limit.**\n   Do not skip the review because nothing has arrived yet.\n\n   **An error naming an existing waiter is not reviewisunavailable.** Orca refuses a\n   wait while another one is active on this Run (`waiter_exists`, or an already-active\n   actionable waiter). Wait a few seconds and run the same command again. **Do not record\n   the review as skipped because of it** — only a `review-skipped:` message justifies that.\n\n4. The body names a findings file. Read it. **Only a line reading exactly\n   `VERDICT: approved` means approved.** Anything else, including a missing VERDICT line,\n   is needs_work.\n\n5. On needs_work: revise and repeat from step 1 with the next round number.\n   **Stop after round 2.** Record the unresolved findings in result.md and keep the best\n   version you have. Do not keep asking.\n\n6. On `review-skipped:`, your reviewer is gone. Note in result.md that round <n> was not\n   reviewed because the reviewer was stopped, and proceed without review. Skip step 7.\n\n7. When you are done, release the reviewer:\n\n     node @@SENDER@@ --workers @@WORKERS_FILE@@ --to design_review \\\n       --subject \'abort-reviewer: done\' --body \'the work is finished\'\n\n**Decide the approach before you touch anything.** Write down what you are\ngoing to do and why, in result.md, before the first edit. If what you find while working\nmakes that approach wrong, say so there rather than quietly doing something else.\n\nPLAN ONLY. **Do not implement anything and commit nothing.**\n\nAnother worker will build this from your plan, in a different worktree. Write the plan to\n@@PLAN@@ and leave every other file alone.\n\nMake it specific enough to be built from without asking you: name the files to change, what\neach change is for, and how someone would tell it worked. If the request cannot be built as\nasked, say so in the plan rather than inventing a different task.\n\nSTATUS PROTOCOL\n\nYour injected preamble gives you the task id, the dispatch id, the dispatch capability\nand the --from handle. Use that set. The Orca CLI is @@ORCA_BIN@@.\n\n**Finishing is two-phase: you offer the work, the parent checks it, then you report.** Do\nnot report done before the parent has accepted. Do not skip a step because the work looks\nobviously fine — the point is that the parent, not you, decides that.\n\nA. Write @@ROLE_DIR@@/status.json with status executing when you start.\nB. Do the work, then write @@ROLE_DIR@@/result.md describing what you did.\n\nC. Offer it. This records the attempt and prints its nonce:\n\n     node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ prepare\n\nD. Tell the parent it is ready. **The subject carries the nonce and nothing else** — Orca\n   builds the payload from the id flags, so a nonce put there would be dropped.\n   **Read the nonce back from the record inside the same command**, as written here: each\n   command you run is a fresh shell, so a variable you set in C is gone by now, and a\n   merge_ready without a nonce jams the parent\'s whole batch.\n\n     @@ORCA_BIN@@ orchestration send --type merge_ready \\\n       --task-id <task id> --dispatch-id <dispatch id> \\\n       --dispatch-capability <capability> --from <handle> \\\n       --subject "merge_ready: $(node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ nonce)" \\\n       --body "<what you did>" --json\n\n   Then run: node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ sent\n   The parent replies on this same dispatch.\n\nE. Wait for that reply. **Do not end your turn to wait.** A message put in your mailbox\n   does not wake you: a turn closed here is a dispatch that stops for good, and someone has\n   to come and restart you by hand.\n\n     node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ await\n\n   It blocks for up to 10 minutes, reads your mailbox with --peek (never --ack), matches\n   your own nonce, and prints one line:\n   - `accepted` -> go to F.\n   - `remediation <reason>` -> the reason says what is missing. Fix it and go back to C.\n     The nonce does not change.\n   - `waiting` -> nobody has answered yet. **Run it again, in this same turn.** Keep\n     running it. It is normal for this to take several rounds. **This wait has no time limit:**\n     whether a stalled task should stop is decided by the user through the parent, not by\n     you.\n   A non-zero exit means the mailbox could not be read at all; try once more. If it fails\n   again, write that in result.md, run\n   `node @@REPORT_STATUS@@ @@ROLE_DIR@@ error the mailbox could not be read`, and stop. Do not report done.\n\nF. Report. `await` already checked the nonce and recorded the acceptance, so there is\n   nothing to confirm here:\n\n     node @@REPORT_STATUS@@ @@ROLE_DIR@@ done <one line>\n\nG. Send worker_done, then record that it landed:\n\n     @@ORCA_BIN@@ orchestration send --type worker_done \\\n       --task-id <task id> --dispatch-id <dispatch id> \\\n       --dispatch-capability <capability> --from <handle> \\\n       --outcome succeeded --subject "<short status>" --body "<what you did>" --json\n     node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ settle\n\n   **Before resending anything, inspect:**\n     @@ORCA_BIN@@ orchestration dispatch-show --task <task id> --json\n   If the dispatch is already terminal, **do not resend** — run settle and stop.\n\nH. **If the work itself failed, none of C-G applies.** Write why in result.md, run\n   `node @@REPORT_STATUS@@ @@ROLE_DIR@@ error <reason>`, and send worker_done with --outcome failed. That\n   status is the record that a failure is still owed; there is nothing to offer.\n\nI. **Do not invent message types.** The only things you send are the ones above, plus\n   `orchestration ask` **when this task told you to ask** (see the brainstorming section, if\n   there is one). Do not send escalations: the parent has no path for them.\n\n   When you do use `ask`, expect it to block until a person answers through the parent, and\n   remember it costs someone\'s attention. Ask only what you need answered.\nJ. End your turn and stay idle.',
  'design|on|on|brainstorm':
    "TASK: @@SLUG@@\n\n@@REQUEST_CONTENT@@\n\nREVIEW PROTOCOL (do this before you finish)\n\nA reviewer is already running and waiting for you. Have your plan reviewed before you finish.\n\n1. Write your plan to @@REVIEW_DIR@@/plan-round-<n>-request.md, starting at n=1. Be concrete enough\n   that someone can disagree with it.\n\n2. Send the request:\n\n     node @@SENDER@@ --workers @@WORKERS_FILE@@ --to design_review \\\n       --subject 'review-plan: round <n>' --body '<absolute path to your request file>'\n\n   **A non-zero exit means it was NOT delivered.** Delete the request file you just wrote,\n   note in result.md that review was unavailable, and carry on without it.\n\n3. Wait for the verdict:\n\n     @@ORCA_BIN@@ orchestration check --terminal \"$ORCA_TERMINAL_HANDLE\" \\\n       --peek --wait --timeout-ms 600000 --json\n\n   Use --peek. **Never pass --ack.** Look for a subject starting `review-verdict:`.\n   A subject starting `review-skipped:` means the parent stopped your reviewer: go to step 6.\n\n   **Do not end your turn to wait.** A message put in your mailbox does not wake you, so a\n   turn closed here is a dispatch that stops for good. If the wait returns nothing, run it\n   again, in this same turn — reviewing takes longer than one wait. **This wait has no time limit.**\n   Do not skip the review because nothing has arrived yet.\n\n   **An error naming an existing waiter is not reviewisunavailable.** Orca refuses a\n   wait while another one is active on this Run (`waiter_exists`, or an already-active\n   actionable waiter). Wait a few seconds and run the same command again. **Do not record\n   the review as skipped because of it** — only a `review-skipped:` message justifies that.\n\n4. The body names a findings file. Read it. **Only a line reading exactly\n   `VERDICT: approved` means approved.** Anything else, including a missing VERDICT line,\n   is needs_work.\n\n5. On needs_work: revise and repeat from step 1 with the next round number.\n   **Stop after round 2.** Record the unresolved findings in result.md and keep the best\n   version you have. Do not keep asking.\n\n6. On `review-skipped:`, your reviewer is gone. Note in result.md that round <n> was not\n   reviewed because the reviewer was stopped, and proceed without review. Skip step 7.\n\n7. When you are done, release the reviewer:\n\n     node @@SENDER@@ --workers @@WORKERS_FILE@@ --to design_review \\\n       --subject 'abort-reviewer: done' --body 'the work is finished'\n\n**Work through the superpowers skills in this order.**\n\n1. Invoke `superpowers:brainstorming` and settle the open questions with the user before you\n   plan or build anything.\n2. Write the agreed design to @@SPEC@@. This replaces the skill's own spec\n   location and commit step: **write it there, not under docs/, and do not commit it.**\n3. Invoke `superpowers:writing-plans` and write the plan to @@PLAN@@, again\n   instead of the skill's own location and without committing it.\n   Stop once the plan is written and self-reviewed: another worker builds it. Do not\n   ask how to execute it, and do not start implementing.\n\n**Ask through `orchestration ask`, not by printing a question and stopping.** The parent\nrelays it to a person and sends their answer back; a question you only print is read by\nnobody. Ask one question at a time, as the skill does: each call blocks until someone answers.\nThe skill's request for the user to review the written spec goes through the same call.\n\nIf nobody ever answers, that call is where you will be waiting — that is expected, and the\nperson watching decides whether to answer or to stop the dispatch.\n\nIf either skill is not installed in this session, say so in result.md and carry on without it\nrather than inventing your own version of it.\n\nPLAN ONLY. **Do not implement anything and commit nothing.**\n\nAnother worker will build this from your plan, in a different worktree. Write the plan to\n@@PLAN@@ and leave every other file alone apart from @@SPEC@@.\n\nMake it specific enough to be built from without asking you: name the files to change, what\neach change is for, and how someone would tell it worked. If the request cannot be built as\nasked, say so in the plan rather than inventing a different task.\n\nSTATUS PROTOCOL\n\nYour injected preamble gives you the task id, the dispatch id, the dispatch capability\nand the --from handle. Use that set. The Orca CLI is @@ORCA_BIN@@.\n\n**Finishing is two-phase: you offer the work, the parent checks it, then you report.** Do\nnot report done before the parent has accepted. Do not skip a step because the work looks\nobviously fine — the point is that the parent, not you, decides that.\n\nA. Write @@ROLE_DIR@@/status.json with status executing when you start.\nB. Do the work, then write @@ROLE_DIR@@/result.md describing what you did.\n\nC. Offer it. This records the attempt and prints its nonce:\n\n     node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ prepare\n\nD. Tell the parent it is ready. **The subject carries the nonce and nothing else** — Orca\n   builds the payload from the id flags, so a nonce put there would be dropped.\n   **Read the nonce back from the record inside the same command**, as written here: each\n   command you run is a fresh shell, so a variable you set in C is gone by now, and a\n   merge_ready without a nonce jams the parent's whole batch.\n\n     @@ORCA_BIN@@ orchestration send --type merge_ready \\\n       --task-id <task id> --dispatch-id <dispatch id> \\\n       --dispatch-capability <capability> --from <handle> \\\n       --subject \"merge_ready: $(node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ nonce)\" \\\n       --body \"<what you did>\" --json\n\n   Then run: node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ sent\n   The parent replies on this same dispatch.\n\nE. Wait for that reply. **Do not end your turn to wait.** A message put in your mailbox\n   does not wake you: a turn closed here is a dispatch that stops for good, and someone has\n   to come and restart you by hand.\n\n     node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ await\n\n   It blocks for up to 10 minutes, reads your mailbox with --peek (never --ack), matches\n   your own nonce, and prints one line:\n   - `accepted` -> go to F.\n   - `remediation <reason>` -> the reason says what is missing. Fix it and go back to C.\n     The nonce does not change.\n   - `waiting` -> nobody has answered yet. **Run it again, in this same turn.** Keep\n     running it. It is normal for this to take several rounds. **This wait has no time limit:**\n     whether a stalled task should stop is decided by the user through the parent, not by\n     you.\n   A non-zero exit means the mailbox could not be read at all; try once more. If it fails\n   again, write that in result.md, run\n   `node @@REPORT_STATUS@@ @@ROLE_DIR@@ error the mailbox could not be read`, and stop. Do not report done.\n\nF. Report. `await` already checked the nonce and recorded the acceptance, so there is\n   nothing to confirm here:\n\n     node @@REPORT_STATUS@@ @@ROLE_DIR@@ done <one line>\n\nG. Send worker_done, then record that it landed:\n\n     @@ORCA_BIN@@ orchestration send --type worker_done \\\n       --task-id <task id> --dispatch-id <dispatch id> \\\n       --dispatch-capability <capability> --from <handle> \\\n       --outcome succeeded --subject \"<short status>\" --body \"<what you did>\" --json\n     node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ settle\n\n   **Before resending anything, inspect:**\n     @@ORCA_BIN@@ orchestration dispatch-show --task <task id> --json\n   If the dispatch is already terminal, **do not resend** — run settle and stop.\n\nH. **If the work itself failed, none of C-G applies.** Write why in result.md, run\n   `node @@REPORT_STATUS@@ @@ROLE_DIR@@ error <reason>`, and send worker_done with --outcome failed. That\n   status is the record that a failure is still owed; there is nothing to offer.\n\nI. **Do not invent message types.** The only things you send are the ones above, plus\n   `orchestration ask` **when this task told you to ask** (see the brainstorming section, if\n   there is one). Do not send escalations: the parent has no path for them.\n\n   When you do use `ask`, expect it to block until a person answers through the parent, and\n   remember it costs someone's attention. Ask only what you need answered.\nJ. End your turn and stay idle.",
  'design|on|off|direct':
    'TASK: @@SLUG@@\n\n@@REQUEST_CONTENT@@\n\nREVIEW PROTOCOL (do this before you finish)\n\nA reviewer is already running and waiting for you. Have your plan reviewed before you finish.\n\n1. Write your plan to @@REVIEW_DIR@@/plan-round-<n>-request.md, starting at n=1. Be concrete enough\n   that someone can disagree with it.\n\n2. Send the request:\n\n     node @@SENDER@@ --workers @@WORKERS_FILE@@ --to design_review \\\n       --subject \'review-plan: round <n>\' --body \'<absolute path to your request file>\'\n\n   **A non-zero exit means it was NOT delivered.** Delete the request file you just wrote,\n   note in result.md that review was unavailable, and carry on without it.\n\n3. Wait for the verdict:\n\n     @@ORCA_BIN@@ orchestration check --terminal "$ORCA_TERMINAL_HANDLE" \\\n       --peek --wait --timeout-ms 600000 --json\n\n   Use --peek. **Never pass --ack.** Look for a subject starting `review-verdict:`.\n   A subject starting `review-skipped:` means the parent stopped your reviewer: go to step 6.\n\n   **Do not end your turn to wait.** A message put in your mailbox does not wake you, so a\n   turn closed here is a dispatch that stops for good. If the wait returns nothing, run it\n   again, in this same turn — reviewing takes longer than one wait. **This wait has no time limit.**\n   Do not skip the review because nothing has arrived yet.\n\n   **An error naming an existing waiter is not reviewisunavailable.** Orca refuses a\n   wait while another one is active on this Run (`waiter_exists`, or an already-active\n   actionable waiter). Wait a few seconds and run the same command again. **Do not record\n   the review as skipped because of it** — only a `review-skipped:` message justifies that.\n\n4. The body names a findings file. Read it. **Only a line reading exactly\n   `VERDICT: approved` means approved.** Anything else, including a missing VERDICT line,\n   is needs_work.\n\n5. On needs_work: revise and repeat from step 1 with the next round number.\n   **Stop after round 2.** Record the unresolved findings in result.md and keep the best\n   version you have. Do not keep asking.\n\n6. On `review-skipped:`, your reviewer is gone. Note in result.md that round <n> was not\n   reviewed because the reviewer was stopped, and proceed without review. Skip step 7.\n\n7. When you are done, release the reviewer:\n\n     node @@SENDER@@ --workers @@WORKERS_FILE@@ --to design_review \\\n       --subject \'abort-reviewer: done\' --body \'the work is finished\'\n\nDo the work in this worktree and commit it on this branch.\n\nSTATUS PROTOCOL\n\nYour injected preamble gives you the task id, the dispatch id, the dispatch capability\nand the --from handle. Use that set. The Orca CLI is @@ORCA_BIN@@.\n\n**Finishing is two-phase: you offer the work, the parent checks it, then you report.** Do\nnot report done before the parent has accepted. Do not skip a step because the work looks\nobviously fine — the point is that the parent, not you, decides that.\n\nA. Write @@ROLE_DIR@@/status.json with status executing when you start.\nB. Do the work, then write @@ROLE_DIR@@/result.md describing what you did.\n\nC. Offer it. This records the attempt and prints its nonce:\n\n     node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ prepare\n\nD. Tell the parent it is ready. **The subject carries the nonce and nothing else** — Orca\n   builds the payload from the id flags, so a nonce put there would be dropped.\n   **Read the nonce back from the record inside the same command**, as written here: each\n   command you run is a fresh shell, so a variable you set in C is gone by now, and a\n   merge_ready without a nonce jams the parent\'s whole batch.\n\n     @@ORCA_BIN@@ orchestration send --type merge_ready \\\n       --task-id <task id> --dispatch-id <dispatch id> \\\n       --dispatch-capability <capability> --from <handle> \\\n       --subject "merge_ready: $(node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ nonce)" \\\n       --body "<what you did>" --json\n\n   Then run: node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ sent\n   The parent replies on this same dispatch.\n\nE. Wait for that reply. **Do not end your turn to wait.** A message put in your mailbox\n   does not wake you: a turn closed here is a dispatch that stops for good, and someone has\n   to come and restart you by hand.\n\n     node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ await\n\n   It blocks for up to 10 minutes, reads your mailbox with --peek (never --ack), matches\n   your own nonce, and prints one line:\n   - `accepted` -> go to F.\n   - `remediation <reason>` -> the reason says what is missing. Fix it and go back to C.\n     The nonce does not change.\n   - `waiting` -> nobody has answered yet. **Run it again, in this same turn.** Keep\n     running it. It is normal for this to take several rounds. **This wait has no time limit:**\n     whether a stalled task should stop is decided by the user through the parent, not by\n     you.\n   A non-zero exit means the mailbox could not be read at all; try once more. If it fails\n   again, write that in result.md, run\n   `node @@REPORT_STATUS@@ @@ROLE_DIR@@ error the mailbox could not be read`, and stop. Do not report done.\n\nF. Report. `await` already checked the nonce and recorded the acceptance, so there is\n   nothing to confirm here:\n\n     node @@REPORT_STATUS@@ @@ROLE_DIR@@ done <one line>\n\nG. Send worker_done, then record that it landed:\n\n     @@ORCA_BIN@@ orchestration send --type worker_done \\\n       --task-id <task id> --dispatch-id <dispatch id> \\\n       --dispatch-capability <capability> --from <handle> \\\n       --outcome succeeded --subject "<short status>" --body "<what you did>" --json\n     node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ settle\n\n   **Before resending anything, inspect:**\n     @@ORCA_BIN@@ orchestration dispatch-show --task <task id> --json\n   If the dispatch is already terminal, **do not resend** — run settle and stop.\n\nH. **If the work itself failed, none of C-G applies.** Write why in result.md, run\n   `node @@REPORT_STATUS@@ @@ROLE_DIR@@ error <reason>`, and send worker_done with --outcome failed. That\n   status is the record that a failure is still owed; there is nothing to offer.\n\nI. **Do not invent message types.** The only things you send are the ones above, plus\n   `orchestration ask` **when this task told you to ask** (see the brainstorming section, if\n   there is one). Do not send escalations: the parent has no path for them.\n\n   When you do use `ask`, expect it to block until a person answers through the parent, and\n   remember it costs someone\'s attention. Ask only what you need answered.\nJ. End your turn and stay idle.',
  'design|on|off|plan':
    'TASK: @@SLUG@@\n\n@@REQUEST_CONTENT@@\n\nREVIEW PROTOCOL (do this before you finish)\n\nA reviewer is already running and waiting for you. Have your plan reviewed before you finish.\n\n1. Write your plan to @@REVIEW_DIR@@/plan-round-<n>-request.md, starting at n=1. Be concrete enough\n   that someone can disagree with it.\n\n2. Send the request:\n\n     node @@SENDER@@ --workers @@WORKERS_FILE@@ --to design_review \\\n       --subject \'review-plan: round <n>\' --body \'<absolute path to your request file>\'\n\n   **A non-zero exit means it was NOT delivered.** Delete the request file you just wrote,\n   note in result.md that review was unavailable, and carry on without it.\n\n3. Wait for the verdict:\n\n     @@ORCA_BIN@@ orchestration check --terminal "$ORCA_TERMINAL_HANDLE" \\\n       --peek --wait --timeout-ms 600000 --json\n\n   Use --peek. **Never pass --ack.** Look for a subject starting `review-verdict:`.\n   A subject starting `review-skipped:` means the parent stopped your reviewer: go to step 6.\n\n   **Do not end your turn to wait.** A message put in your mailbox does not wake you, so a\n   turn closed here is a dispatch that stops for good. If the wait returns nothing, run it\n   again, in this same turn — reviewing takes longer than one wait. **This wait has no time limit.**\n   Do not skip the review because nothing has arrived yet.\n\n   **An error naming an existing waiter is not reviewisunavailable.** Orca refuses a\n   wait while another one is active on this Run (`waiter_exists`, or an already-active\n   actionable waiter). Wait a few seconds and run the same command again. **Do not record\n   the review as skipped because of it** — only a `review-skipped:` message justifies that.\n\n4. The body names a findings file. Read it. **Only a line reading exactly\n   `VERDICT: approved` means approved.** Anything else, including a missing VERDICT line,\n   is needs_work.\n\n5. On needs_work: revise and repeat from step 1 with the next round number.\n   **Stop after round 2.** Record the unresolved findings in result.md and keep the best\n   version you have. Do not keep asking.\n\n6. On `review-skipped:`, your reviewer is gone. Note in result.md that round <n> was not\n   reviewed because the reviewer was stopped, and proceed without review. Skip step 7.\n\n7. When you are done, release the reviewer:\n\n     node @@SENDER@@ --workers @@WORKERS_FILE@@ --to design_review \\\n       --subject \'abort-reviewer: done\' --body \'the work is finished\'\n\n**Decide the approach before you touch anything.** Write down what you are\ngoing to do and why, in result.md, before the first edit. If what you find while working\nmakes that approach wrong, say so there rather than quietly doing something else.\n\nDo the work in this worktree and commit it on this branch.\n\nSTATUS PROTOCOL\n\nYour injected preamble gives you the task id, the dispatch id, the dispatch capability\nand the --from handle. Use that set. The Orca CLI is @@ORCA_BIN@@.\n\n**Finishing is two-phase: you offer the work, the parent checks it, then you report.** Do\nnot report done before the parent has accepted. Do not skip a step because the work looks\nobviously fine — the point is that the parent, not you, decides that.\n\nA. Write @@ROLE_DIR@@/status.json with status executing when you start.\nB. Do the work, then write @@ROLE_DIR@@/result.md describing what you did.\n\nC. Offer it. This records the attempt and prints its nonce:\n\n     node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ prepare\n\nD. Tell the parent it is ready. **The subject carries the nonce and nothing else** — Orca\n   builds the payload from the id flags, so a nonce put there would be dropped.\n   **Read the nonce back from the record inside the same command**, as written here: each\n   command you run is a fresh shell, so a variable you set in C is gone by now, and a\n   merge_ready without a nonce jams the parent\'s whole batch.\n\n     @@ORCA_BIN@@ orchestration send --type merge_ready \\\n       --task-id <task id> --dispatch-id <dispatch id> \\\n       --dispatch-capability <capability> --from <handle> \\\n       --subject "merge_ready: $(node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ nonce)" \\\n       --body "<what you did>" --json\n\n   Then run: node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ sent\n   The parent replies on this same dispatch.\n\nE. Wait for that reply. **Do not end your turn to wait.** A message put in your mailbox\n   does not wake you: a turn closed here is a dispatch that stops for good, and someone has\n   to come and restart you by hand.\n\n     node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ await\n\n   It blocks for up to 10 minutes, reads your mailbox with --peek (never --ack), matches\n   your own nonce, and prints one line:\n   - `accepted` -> go to F.\n   - `remediation <reason>` -> the reason says what is missing. Fix it and go back to C.\n     The nonce does not change.\n   - `waiting` -> nobody has answered yet. **Run it again, in this same turn.** Keep\n     running it. It is normal for this to take several rounds. **This wait has no time limit:**\n     whether a stalled task should stop is decided by the user through the parent, not by\n     you.\n   A non-zero exit means the mailbox could not be read at all; try once more. If it fails\n   again, write that in result.md, run\n   `node @@REPORT_STATUS@@ @@ROLE_DIR@@ error the mailbox could not be read`, and stop. Do not report done.\n\nF. Report. `await` already checked the nonce and recorded the acceptance, so there is\n   nothing to confirm here:\n\n     node @@REPORT_STATUS@@ @@ROLE_DIR@@ done <one line>\n\nG. Send worker_done, then record that it landed:\n\n     @@ORCA_BIN@@ orchestration send --type worker_done \\\n       --task-id <task id> --dispatch-id <dispatch id> \\\n       --dispatch-capability <capability> --from <handle> \\\n       --outcome succeeded --subject "<short status>" --body "<what you did>" --json\n     node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ settle\n\n   **Before resending anything, inspect:**\n     @@ORCA_BIN@@ orchestration dispatch-show --task <task id> --json\n   If the dispatch is already terminal, **do not resend** — run settle and stop.\n\nH. **If the work itself failed, none of C-G applies.** Write why in result.md, run\n   `node @@REPORT_STATUS@@ @@ROLE_DIR@@ error <reason>`, and send worker_done with --outcome failed. That\n   status is the record that a failure is still owed; there is nothing to offer.\n\nI. **Do not invent message types.** The only things you send are the ones above, plus\n   `orchestration ask` **when this task told you to ask** (see the brainstorming section, if\n   there is one). Do not send escalations: the parent has no path for them.\n\n   When you do use `ask`, expect it to block until a person answers through the parent, and\n   remember it costs someone\'s attention. Ask only what you need answered.\nJ. End your turn and stay idle.',
  'design|on|off|brainstorm':
    "TASK: @@SLUG@@\n\n@@REQUEST_CONTENT@@\n\nREVIEW PROTOCOL (do this before you finish)\n\nA reviewer is already running and waiting for you. Have your plan reviewed before you finish.\n\n1. Write your plan to @@REVIEW_DIR@@/plan-round-<n>-request.md, starting at n=1. Be concrete enough\n   that someone can disagree with it.\n\n2. Send the request:\n\n     node @@SENDER@@ --workers @@WORKERS_FILE@@ --to design_review \\\n       --subject 'review-plan: round <n>' --body '<absolute path to your request file>'\n\n   **A non-zero exit means it was NOT delivered.** Delete the request file you just wrote,\n   note in result.md that review was unavailable, and carry on without it.\n\n3. Wait for the verdict:\n\n     @@ORCA_BIN@@ orchestration check --terminal \"$ORCA_TERMINAL_HANDLE\" \\\n       --peek --wait --timeout-ms 600000 --json\n\n   Use --peek. **Never pass --ack.** Look for a subject starting `review-verdict:`.\n   A subject starting `review-skipped:` means the parent stopped your reviewer: go to step 6.\n\n   **Do not end your turn to wait.** A message put in your mailbox does not wake you, so a\n   turn closed here is a dispatch that stops for good. If the wait returns nothing, run it\n   again, in this same turn — reviewing takes longer than one wait. **This wait has no time limit.**\n   Do not skip the review because nothing has arrived yet.\n\n   **An error naming an existing waiter is not reviewisunavailable.** Orca refuses a\n   wait while another one is active on this Run (`waiter_exists`, or an already-active\n   actionable waiter). Wait a few seconds and run the same command again. **Do not record\n   the review as skipped because of it** — only a `review-skipped:` message justifies that.\n\n4. The body names a findings file. Read it. **Only a line reading exactly\n   `VERDICT: approved` means approved.** Anything else, including a missing VERDICT line,\n   is needs_work.\n\n5. On needs_work: revise and repeat from step 1 with the next round number.\n   **Stop after round 2.** Record the unresolved findings in result.md and keep the best\n   version you have. Do not keep asking.\n\n6. On `review-skipped:`, your reviewer is gone. Note in result.md that round <n> was not\n   reviewed because the reviewer was stopped, and proceed without review. Skip step 7.\n\n7. When you are done, release the reviewer:\n\n     node @@SENDER@@ --workers @@WORKERS_FILE@@ --to design_review \\\n       --subject 'abort-reviewer: done' --body 'the work is finished'\n\n**Work through the superpowers skills in this order.**\n\n1. Invoke `superpowers:brainstorming` and settle the open questions with the user before you\n   plan or build anything.\n2. Write the agreed design to @@SPEC@@. This replaces the skill's own spec\n   location and commit step: **write it there, not under docs/, and do not commit it.**\n3. Invoke `superpowers:writing-plans` and write the plan to @@PLAN@@, again\n   instead of the skill's own location and without committing it.\n   Then build it in this worktree with `superpowers:subagent-driven-development`,\n   following the plan, and commit the work on this branch. Do not ask how to execute the plan.\n   Do not run `superpowers:finishing-a-development-branch`: stop after committing; the parent brings the branch home.\n\n**Ask through `orchestration ask`, not by printing a question and stopping.** The parent\nrelays it to a person and sends their answer back; a question you only print is read by\nnobody. Ask one question at a time, as the skill does: each call blocks until someone answers.\nThe skill's request for the user to review the written spec goes through the same call.\n\nIf nobody ever answers, that call is where you will be waiting — that is expected, and the\nperson watching decides whether to answer or to stop the dispatch.\n\nIf either skill is not installed in this session, say so in result.md and carry on without it\nrather than inventing your own version of it.\n\nDo the work in this worktree and commit it on this branch.\n\nSTATUS PROTOCOL\n\nYour injected preamble gives you the task id, the dispatch id, the dispatch capability\nand the --from handle. Use that set. The Orca CLI is @@ORCA_BIN@@.\n\n**Finishing is two-phase: you offer the work, the parent checks it, then you report.** Do\nnot report done before the parent has accepted. Do not skip a step because the work looks\nobviously fine — the point is that the parent, not you, decides that.\n\nA. Write @@ROLE_DIR@@/status.json with status executing when you start.\nB. Do the work, then write @@ROLE_DIR@@/result.md describing what you did.\n\nC. Offer it. This records the attempt and prints its nonce:\n\n     node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ prepare\n\nD. Tell the parent it is ready. **The subject carries the nonce and nothing else** — Orca\n   builds the payload from the id flags, so a nonce put there would be dropped.\n   **Read the nonce back from the record inside the same command**, as written here: each\n   command you run is a fresh shell, so a variable you set in C is gone by now, and a\n   merge_ready without a nonce jams the parent's whole batch.\n\n     @@ORCA_BIN@@ orchestration send --type merge_ready \\\n       --task-id <task id> --dispatch-id <dispatch id> \\\n       --dispatch-capability <capability> --from <handle> \\\n       --subject \"merge_ready: $(node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ nonce)\" \\\n       --body \"<what you did>\" --json\n\n   Then run: node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ sent\n   The parent replies on this same dispatch.\n\nE. Wait for that reply. **Do not end your turn to wait.** A message put in your mailbox\n   does not wake you: a turn closed here is a dispatch that stops for good, and someone has\n   to come and restart you by hand.\n\n     node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ await\n\n   It blocks for up to 10 minutes, reads your mailbox with --peek (never --ack), matches\n   your own nonce, and prints one line:\n   - `accepted` -> go to F.\n   - `remediation <reason>` -> the reason says what is missing. Fix it and go back to C.\n     The nonce does not change.\n   - `waiting` -> nobody has answered yet. **Run it again, in this same turn.** Keep\n     running it. It is normal for this to take several rounds. **This wait has no time limit:**\n     whether a stalled task should stop is decided by the user through the parent, not by\n     you.\n   A non-zero exit means the mailbox could not be read at all; try once more. If it fails\n   again, write that in result.md, run\n   `node @@REPORT_STATUS@@ @@ROLE_DIR@@ error the mailbox could not be read`, and stop. Do not report done.\n\nF. Report. `await` already checked the nonce and recorded the acceptance, so there is\n   nothing to confirm here:\n\n     node @@REPORT_STATUS@@ @@ROLE_DIR@@ done <one line>\n\nG. Send worker_done, then record that it landed:\n\n     @@ORCA_BIN@@ orchestration send --type worker_done \\\n       --task-id <task id> --dispatch-id <dispatch id> \\\n       --dispatch-capability <capability> --from <handle> \\\n       --outcome succeeded --subject \"<short status>\" --body \"<what you did>\" --json\n     node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ settle\n\n   **Before resending anything, inspect:**\n     @@ORCA_BIN@@ orchestration dispatch-show --task <task id> --json\n   If the dispatch is already terminal, **do not resend** — run settle and stop.\n\nH. **If the work itself failed, none of C-G applies.** Write why in result.md, run\n   `node @@REPORT_STATUS@@ @@ROLE_DIR@@ error <reason>`, and send worker_done with --outcome failed. That\n   status is the record that a failure is still owed; there is nothing to offer.\n\nI. **Do not invent message types.** The only things you send are the ones above, plus\n   `orchestration ask` **when this task told you to ask** (see the brainstorming section, if\n   there is one). Do not send escalations: the parent has no path for them.\n\n   When you do use `ask`, expect it to block until a person answers through the parent, and\n   remember it costs someone's attention. Ask only what you need answered.\nJ. End your turn and stay idle.",
  'design|off|on|direct':
    'TASK: @@SLUG@@\n\n@@REQUEST_CONTENT@@\n\nPLAN ONLY. **Do not implement anything and commit nothing.**\n\nAnother worker will build this from your plan, in a different worktree. Write the plan to\n@@PLAN@@ and leave every other file alone.\n\nMake it specific enough to be built from without asking you: name the files to change, what\neach change is for, and how someone would tell it worked. If the request cannot be built as\nasked, say so in the plan rather than inventing a different task.\n\nSTATUS PROTOCOL\n\nYour injected preamble gives you the task id, the dispatch id, the dispatch capability\nand the --from handle. Use that set. The Orca CLI is @@ORCA_BIN@@.\n\n**Finishing is two-phase: you offer the work, the parent checks it, then you report.** Do\nnot report done before the parent has accepted. Do not skip a step because the work looks\nobviously fine — the point is that the parent, not you, decides that.\n\nA. Write @@ROLE_DIR@@/status.json with status executing when you start.\nB. Do the work, then write @@ROLE_DIR@@/result.md describing what you did.\n\nC. Offer it. This records the attempt and prints its nonce:\n\n     node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ prepare\n\nD. Tell the parent it is ready. **The subject carries the nonce and nothing else** — Orca\n   builds the payload from the id flags, so a nonce put there would be dropped.\n   **Read the nonce back from the record inside the same command**, as written here: each\n   command you run is a fresh shell, so a variable you set in C is gone by now, and a\n   merge_ready without a nonce jams the parent\'s whole batch.\n\n     @@ORCA_BIN@@ orchestration send --type merge_ready \\\n       --task-id <task id> --dispatch-id <dispatch id> \\\n       --dispatch-capability <capability> --from <handle> \\\n       --subject "merge_ready: $(node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ nonce)" \\\n       --body "<what you did>" --json\n\n   Then run: node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ sent\n   The parent replies on this same dispatch.\n\nE. Wait for that reply. **Do not end your turn to wait.** A message put in your mailbox\n   does not wake you: a turn closed here is a dispatch that stops for good, and someone has\n   to come and restart you by hand.\n\n     node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ await\n\n   It blocks for up to 10 minutes, reads your mailbox with --peek (never --ack), matches\n   your own nonce, and prints one line:\n   - `accepted` -> go to F.\n   - `remediation <reason>` -> the reason says what is missing. Fix it and go back to C.\n     The nonce does not change.\n   - `waiting` -> nobody has answered yet. **Run it again, in this same turn.** Keep\n     running it. It is normal for this to take several rounds. **This wait has no time limit:**\n     whether a stalled task should stop is decided by the user through the parent, not by\n     you.\n   A non-zero exit means the mailbox could not be read at all; try once more. If it fails\n   again, write that in result.md, run\n   `node @@REPORT_STATUS@@ @@ROLE_DIR@@ error the mailbox could not be read`, and stop. Do not report done.\n\nF. Report. `await` already checked the nonce and recorded the acceptance, so there is\n   nothing to confirm here:\n\n     node @@REPORT_STATUS@@ @@ROLE_DIR@@ done <one line>\n\nG. Send worker_done, then record that it landed:\n\n     @@ORCA_BIN@@ orchestration send --type worker_done \\\n       --task-id <task id> --dispatch-id <dispatch id> \\\n       --dispatch-capability <capability> --from <handle> \\\n       --outcome succeeded --subject "<short status>" --body "<what you did>" --json\n     node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ settle\n\n   **Before resending anything, inspect:**\n     @@ORCA_BIN@@ orchestration dispatch-show --task <task id> --json\n   If the dispatch is already terminal, **do not resend** — run settle and stop.\n\nH. **If the work itself failed, none of C-G applies.** Write why in result.md, run\n   `node @@REPORT_STATUS@@ @@ROLE_DIR@@ error <reason>`, and send worker_done with --outcome failed. That\n   status is the record that a failure is still owed; there is nothing to offer.\n\nI. **Do not invent message types.** The only things you send are the ones above, plus\n   `orchestration ask` **when this task told you to ask** (see the brainstorming section, if\n   there is one). Do not send escalations: the parent has no path for them.\n\n   When you do use `ask`, expect it to block until a person answers through the parent, and\n   remember it costs someone\'s attention. Ask only what you need answered.\nJ. End your turn and stay idle.',
  'design|off|on|plan':
    'TASK: @@SLUG@@\n\n@@REQUEST_CONTENT@@\n\n**Decide the approach before you touch anything.** Write down what you are\ngoing to do and why, in result.md, before the first edit. If what you find while working\nmakes that approach wrong, say so there rather than quietly doing something else.\n\nPLAN ONLY. **Do not implement anything and commit nothing.**\n\nAnother worker will build this from your plan, in a different worktree. Write the plan to\n@@PLAN@@ and leave every other file alone.\n\nMake it specific enough to be built from without asking you: name the files to change, what\neach change is for, and how someone would tell it worked. If the request cannot be built as\nasked, say so in the plan rather than inventing a different task.\n\nSTATUS PROTOCOL\n\nYour injected preamble gives you the task id, the dispatch id, the dispatch capability\nand the --from handle. Use that set. The Orca CLI is @@ORCA_BIN@@.\n\n**Finishing is two-phase: you offer the work, the parent checks it, then you report.** Do\nnot report done before the parent has accepted. Do not skip a step because the work looks\nobviously fine — the point is that the parent, not you, decides that.\n\nA. Write @@ROLE_DIR@@/status.json with status executing when you start.\nB. Do the work, then write @@ROLE_DIR@@/result.md describing what you did.\n\nC. Offer it. This records the attempt and prints its nonce:\n\n     node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ prepare\n\nD. Tell the parent it is ready. **The subject carries the nonce and nothing else** — Orca\n   builds the payload from the id flags, so a nonce put there would be dropped.\n   **Read the nonce back from the record inside the same command**, as written here: each\n   command you run is a fresh shell, so a variable you set in C is gone by now, and a\n   merge_ready without a nonce jams the parent\'s whole batch.\n\n     @@ORCA_BIN@@ orchestration send --type merge_ready \\\n       --task-id <task id> --dispatch-id <dispatch id> \\\n       --dispatch-capability <capability> --from <handle> \\\n       --subject "merge_ready: $(node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ nonce)" \\\n       --body "<what you did>" --json\n\n   Then run: node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ sent\n   The parent replies on this same dispatch.\n\nE. Wait for that reply. **Do not end your turn to wait.** A message put in your mailbox\n   does not wake you: a turn closed here is a dispatch that stops for good, and someone has\n   to come and restart you by hand.\n\n     node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ await\n\n   It blocks for up to 10 minutes, reads your mailbox with --peek (never --ack), matches\n   your own nonce, and prints one line:\n   - `accepted` -> go to F.\n   - `remediation <reason>` -> the reason says what is missing. Fix it and go back to C.\n     The nonce does not change.\n   - `waiting` -> nobody has answered yet. **Run it again, in this same turn.** Keep\n     running it. It is normal for this to take several rounds. **This wait has no time limit:**\n     whether a stalled task should stop is decided by the user through the parent, not by\n     you.\n   A non-zero exit means the mailbox could not be read at all; try once more. If it fails\n   again, write that in result.md, run\n   `node @@REPORT_STATUS@@ @@ROLE_DIR@@ error the mailbox could not be read`, and stop. Do not report done.\n\nF. Report. `await` already checked the nonce and recorded the acceptance, so there is\n   nothing to confirm here:\n\n     node @@REPORT_STATUS@@ @@ROLE_DIR@@ done <one line>\n\nG. Send worker_done, then record that it landed:\n\n     @@ORCA_BIN@@ orchestration send --type worker_done \\\n       --task-id <task id> --dispatch-id <dispatch id> \\\n       --dispatch-capability <capability> --from <handle> \\\n       --outcome succeeded --subject "<short status>" --body "<what you did>" --json\n     node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ settle\n\n   **Before resending anything, inspect:**\n     @@ORCA_BIN@@ orchestration dispatch-show --task <task id> --json\n   If the dispatch is already terminal, **do not resend** — run settle and stop.\n\nH. **If the work itself failed, none of C-G applies.** Write why in result.md, run\n   `node @@REPORT_STATUS@@ @@ROLE_DIR@@ error <reason>`, and send worker_done with --outcome failed. That\n   status is the record that a failure is still owed; there is nothing to offer.\n\nI. **Do not invent message types.** The only things you send are the ones above, plus\n   `orchestration ask` **when this task told you to ask** (see the brainstorming section, if\n   there is one). Do not send escalations: the parent has no path for them.\n\n   When you do use `ask`, expect it to block until a person answers through the parent, and\n   remember it costs someone\'s attention. Ask only what you need answered.\nJ. End your turn and stay idle.',
  'design|off|on|brainstorm':
    'TASK: @@SLUG@@\n\n@@REQUEST_CONTENT@@\n\n**Work through the superpowers skills in this order.**\n\n1. Invoke `superpowers:brainstorming` and settle the open questions with the user before you\n   plan or build anything.\n2. Write the agreed design to @@SPEC@@. This replaces the skill\'s own spec\n   location and commit step: **write it there, not under docs/, and do not commit it.**\n3. Invoke `superpowers:writing-plans` and write the plan to @@PLAN@@, again\n   instead of the skill\'s own location and without committing it.\n   Stop once the plan is written and self-reviewed: another worker builds it. Do not\n   ask how to execute it, and do not start implementing.\n\n**Ask through `orchestration ask`, not by printing a question and stopping.** The parent\nrelays it to a person and sends their answer back; a question you only print is read by\nnobody. Ask one question at a time, as the skill does: each call blocks until someone answers.\nThe skill\'s request for the user to review the written spec goes through the same call.\n\nIf nobody ever answers, that call is where you will be waiting — that is expected, and the\nperson watching decides whether to answer or to stop the dispatch.\n\nIf either skill is not installed in this session, say so in result.md and carry on without it\nrather than inventing your own version of it.\n\nPLAN ONLY. **Do not implement anything and commit nothing.**\n\nAnother worker will build this from your plan, in a different worktree. Write the plan to\n@@PLAN@@ and leave every other file alone apart from @@SPEC@@.\n\nMake it specific enough to be built from without asking you: name the files to change, what\neach change is for, and how someone would tell it worked. If the request cannot be built as\nasked, say so in the plan rather than inventing a different task.\n\nSTATUS PROTOCOL\n\nYour injected preamble gives you the task id, the dispatch id, the dispatch capability\nand the --from handle. Use that set. The Orca CLI is @@ORCA_BIN@@.\n\n**Finishing is two-phase: you offer the work, the parent checks it, then you report.** Do\nnot report done before the parent has accepted. Do not skip a step because the work looks\nobviously fine — the point is that the parent, not you, decides that.\n\nA. Write @@ROLE_DIR@@/status.json with status executing when you start.\nB. Do the work, then write @@ROLE_DIR@@/result.md describing what you did.\n\nC. Offer it. This records the attempt and prints its nonce:\n\n     node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ prepare\n\nD. Tell the parent it is ready. **The subject carries the nonce and nothing else** — Orca\n   builds the payload from the id flags, so a nonce put there would be dropped.\n   **Read the nonce back from the record inside the same command**, as written here: each\n   command you run is a fresh shell, so a variable you set in C is gone by now, and a\n   merge_ready without a nonce jams the parent\'s whole batch.\n\n     @@ORCA_BIN@@ orchestration send --type merge_ready \\\n       --task-id <task id> --dispatch-id <dispatch id> \\\n       --dispatch-capability <capability> --from <handle> \\\n       --subject "merge_ready: $(node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ nonce)" \\\n       --body "<what you did>" --json\n\n   Then run: node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ sent\n   The parent replies on this same dispatch.\n\nE. Wait for that reply. **Do not end your turn to wait.** A message put in your mailbox\n   does not wake you: a turn closed here is a dispatch that stops for good, and someone has\n   to come and restart you by hand.\n\n     node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ await\n\n   It blocks for up to 10 minutes, reads your mailbox with --peek (never --ack), matches\n   your own nonce, and prints one line:\n   - `accepted` -> go to F.\n   - `remediation <reason>` -> the reason says what is missing. Fix it and go back to C.\n     The nonce does not change.\n   - `waiting` -> nobody has answered yet. **Run it again, in this same turn.** Keep\n     running it. It is normal for this to take several rounds. **This wait has no time limit:**\n     whether a stalled task should stop is decided by the user through the parent, not by\n     you.\n   A non-zero exit means the mailbox could not be read at all; try once more. If it fails\n   again, write that in result.md, run\n   `node @@REPORT_STATUS@@ @@ROLE_DIR@@ error the mailbox could not be read`, and stop. Do not report done.\n\nF. Report. `await` already checked the nonce and recorded the acceptance, so there is\n   nothing to confirm here:\n\n     node @@REPORT_STATUS@@ @@ROLE_DIR@@ done <one line>\n\nG. Send worker_done, then record that it landed:\n\n     @@ORCA_BIN@@ orchestration send --type worker_done \\\n       --task-id <task id> --dispatch-id <dispatch id> \\\n       --dispatch-capability <capability> --from <handle> \\\n       --outcome succeeded --subject "<short status>" --body "<what you did>" --json\n     node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ settle\n\n   **Before resending anything, inspect:**\n     @@ORCA_BIN@@ orchestration dispatch-show --task <task id> --json\n   If the dispatch is already terminal, **do not resend** — run settle and stop.\n\nH. **If the work itself failed, none of C-G applies.** Write why in result.md, run\n   `node @@REPORT_STATUS@@ @@ROLE_DIR@@ error <reason>`, and send worker_done with --outcome failed. That\n   status is the record that a failure is still owed; there is nothing to offer.\n\nI. **Do not invent message types.** The only things you send are the ones above, plus\n   `orchestration ask` **when this task told you to ask** (see the brainstorming section, if\n   there is one). Do not send escalations: the parent has no path for them.\n\n   When you do use `ask`, expect it to block until a person answers through the parent, and\n   remember it costs someone\'s attention. Ask only what you need answered.\nJ. End your turn and stay idle.',
  'design|off|off|direct':
    'TASK: @@SLUG@@\n\n@@REQUEST_CONTENT@@\n\nDo the work in this worktree and commit it on this branch.\n\nSTATUS PROTOCOL\n\nYour injected preamble gives you the task id, the dispatch id, the dispatch capability\nand the --from handle. Use that set. The Orca CLI is @@ORCA_BIN@@.\n\n**Finishing is two-phase: you offer the work, the parent checks it, then you report.** Do\nnot report done before the parent has accepted. Do not skip a step because the work looks\nobviously fine — the point is that the parent, not you, decides that.\n\nA. Write @@ROLE_DIR@@/status.json with status executing when you start.\nB. Do the work, then write @@ROLE_DIR@@/result.md describing what you did.\n\nC. Offer it. This records the attempt and prints its nonce:\n\n     node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ prepare\n\nD. Tell the parent it is ready. **The subject carries the nonce and nothing else** — Orca\n   builds the payload from the id flags, so a nonce put there would be dropped.\n   **Read the nonce back from the record inside the same command**, as written here: each\n   command you run is a fresh shell, so a variable you set in C is gone by now, and a\n   merge_ready without a nonce jams the parent\'s whole batch.\n\n     @@ORCA_BIN@@ orchestration send --type merge_ready \\\n       --task-id <task id> --dispatch-id <dispatch id> \\\n       --dispatch-capability <capability> --from <handle> \\\n       --subject "merge_ready: $(node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ nonce)" \\\n       --body "<what you did>" --json\n\n   Then run: node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ sent\n   The parent replies on this same dispatch.\n\nE. Wait for that reply. **Do not end your turn to wait.** A message put in your mailbox\n   does not wake you: a turn closed here is a dispatch that stops for good, and someone has\n   to come and restart you by hand.\n\n     node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ await\n\n   It blocks for up to 10 minutes, reads your mailbox with --peek (never --ack), matches\n   your own nonce, and prints one line:\n   - `accepted` -> go to F.\n   - `remediation <reason>` -> the reason says what is missing. Fix it and go back to C.\n     The nonce does not change.\n   - `waiting` -> nobody has answered yet. **Run it again, in this same turn.** Keep\n     running it. It is normal for this to take several rounds. **This wait has no time limit:**\n     whether a stalled task should stop is decided by the user through the parent, not by\n     you.\n   A non-zero exit means the mailbox could not be read at all; try once more. If it fails\n   again, write that in result.md, run\n   `node @@REPORT_STATUS@@ @@ROLE_DIR@@ error the mailbox could not be read`, and stop. Do not report done.\n\nF. Report. `await` already checked the nonce and recorded the acceptance, so there is\n   nothing to confirm here:\n\n     node @@REPORT_STATUS@@ @@ROLE_DIR@@ done <one line>\n\nG. Send worker_done, then record that it landed:\n\n     @@ORCA_BIN@@ orchestration send --type worker_done \\\n       --task-id <task id> --dispatch-id <dispatch id> \\\n       --dispatch-capability <capability> --from <handle> \\\n       --outcome succeeded --subject "<short status>" --body "<what you did>" --json\n     node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ settle\n\n   **Before resending anything, inspect:**\n     @@ORCA_BIN@@ orchestration dispatch-show --task <task id> --json\n   If the dispatch is already terminal, **do not resend** — run settle and stop.\n\nH. **If the work itself failed, none of C-G applies.** Write why in result.md, run\n   `node @@REPORT_STATUS@@ @@ROLE_DIR@@ error <reason>`, and send worker_done with --outcome failed. That\n   status is the record that a failure is still owed; there is nothing to offer.\n\nI. **Do not invent message types.** The only things you send are the ones above, plus\n   `orchestration ask` **when this task told you to ask** (see the brainstorming section, if\n   there is one). Do not send escalations: the parent has no path for them.\n\n   When you do use `ask`, expect it to block until a person answers through the parent, and\n   remember it costs someone\'s attention. Ask only what you need answered.\nJ. End your turn and stay idle.',
  'design|off|off|plan':
    'TASK: @@SLUG@@\n\n@@REQUEST_CONTENT@@\n\n**Decide the approach before you touch anything.** Write down what you are\ngoing to do and why, in result.md, before the first edit. If what you find while working\nmakes that approach wrong, say so there rather than quietly doing something else.\n\nDo the work in this worktree and commit it on this branch.\n\nSTATUS PROTOCOL\n\nYour injected preamble gives you the task id, the dispatch id, the dispatch capability\nand the --from handle. Use that set. The Orca CLI is @@ORCA_BIN@@.\n\n**Finishing is two-phase: you offer the work, the parent checks it, then you report.** Do\nnot report done before the parent has accepted. Do not skip a step because the work looks\nobviously fine — the point is that the parent, not you, decides that.\n\nA. Write @@ROLE_DIR@@/status.json with status executing when you start.\nB. Do the work, then write @@ROLE_DIR@@/result.md describing what you did.\n\nC. Offer it. This records the attempt and prints its nonce:\n\n     node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ prepare\n\nD. Tell the parent it is ready. **The subject carries the nonce and nothing else** — Orca\n   builds the payload from the id flags, so a nonce put there would be dropped.\n   **Read the nonce back from the record inside the same command**, as written here: each\n   command you run is a fresh shell, so a variable you set in C is gone by now, and a\n   merge_ready without a nonce jams the parent\'s whole batch.\n\n     @@ORCA_BIN@@ orchestration send --type merge_ready \\\n       --task-id <task id> --dispatch-id <dispatch id> \\\n       --dispatch-capability <capability> --from <handle> \\\n       --subject "merge_ready: $(node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ nonce)" \\\n       --body "<what you did>" --json\n\n   Then run: node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ sent\n   The parent replies on this same dispatch.\n\nE. Wait for that reply. **Do not end your turn to wait.** A message put in your mailbox\n   does not wake you: a turn closed here is a dispatch that stops for good, and someone has\n   to come and restart you by hand.\n\n     node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ await\n\n   It blocks for up to 10 minutes, reads your mailbox with --peek (never --ack), matches\n   your own nonce, and prints one line:\n   - `accepted` -> go to F.\n   - `remediation <reason>` -> the reason says what is missing. Fix it and go back to C.\n     The nonce does not change.\n   - `waiting` -> nobody has answered yet. **Run it again, in this same turn.** Keep\n     running it. It is normal for this to take several rounds. **This wait has no time limit:**\n     whether a stalled task should stop is decided by the user through the parent, not by\n     you.\n   A non-zero exit means the mailbox could not be read at all; try once more. If it fails\n   again, write that in result.md, run\n   `node @@REPORT_STATUS@@ @@ROLE_DIR@@ error the mailbox could not be read`, and stop. Do not report done.\n\nF. Report. `await` already checked the nonce and recorded the acceptance, so there is\n   nothing to confirm here:\n\n     node @@REPORT_STATUS@@ @@ROLE_DIR@@ done <one line>\n\nG. Send worker_done, then record that it landed:\n\n     @@ORCA_BIN@@ orchestration send --type worker_done \\\n       --task-id <task id> --dispatch-id <dispatch id> \\\n       --dispatch-capability <capability> --from <handle> \\\n       --outcome succeeded --subject "<short status>" --body "<what you did>" --json\n     node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ settle\n\n   **Before resending anything, inspect:**\n     @@ORCA_BIN@@ orchestration dispatch-show --task <task id> --json\n   If the dispatch is already terminal, **do not resend** — run settle and stop.\n\nH. **If the work itself failed, none of C-G applies.** Write why in result.md, run\n   `node @@REPORT_STATUS@@ @@ROLE_DIR@@ error <reason>`, and send worker_done with --outcome failed. That\n   status is the record that a failure is still owed; there is nothing to offer.\n\nI. **Do not invent message types.** The only things you send are the ones above, plus\n   `orchestration ask` **when this task told you to ask** (see the brainstorming section, if\n   there is one). Do not send escalations: the parent has no path for them.\n\n   When you do use `ask`, expect it to block until a person answers through the parent, and\n   remember it costs someone\'s attention. Ask only what you need answered.\nJ. End your turn and stay idle.',
  'design|off|off|brainstorm':
    'TASK: @@SLUG@@\n\n@@REQUEST_CONTENT@@\n\n**Work through the superpowers skills in this order.**\n\n1. Invoke `superpowers:brainstorming` and settle the open questions with the user before you\n   plan or build anything.\n2. Write the agreed design to @@SPEC@@. This replaces the skill\'s own spec\n   location and commit step: **write it there, not under docs/, and do not commit it.**\n3. Invoke `superpowers:writing-plans` and write the plan to @@PLAN@@, again\n   instead of the skill\'s own location and without committing it.\n   Then build it in this worktree with `superpowers:subagent-driven-development`,\n   following the plan, and commit the work on this branch. Do not ask how to execute the plan.\n   Do not run `superpowers:finishing-a-development-branch`: stop after committing; the parent brings the branch home.\n\n**Ask through `orchestration ask`, not by printing a question and stopping.** The parent\nrelays it to a person and sends their answer back; a question you only print is read by\nnobody. Ask one question at a time, as the skill does: each call blocks until someone answers.\nThe skill\'s request for the user to review the written spec goes through the same call.\n\nIf nobody ever answers, that call is where you will be waiting — that is expected, and the\nperson watching decides whether to answer or to stop the dispatch.\n\nIf either skill is not installed in this session, say so in result.md and carry on without it\nrather than inventing your own version of it.\n\nDo the work in this worktree and commit it on this branch.\n\nSTATUS PROTOCOL\n\nYour injected preamble gives you the task id, the dispatch id, the dispatch capability\nand the --from handle. Use that set. The Orca CLI is @@ORCA_BIN@@.\n\n**Finishing is two-phase: you offer the work, the parent checks it, then you report.** Do\nnot report done before the parent has accepted. Do not skip a step because the work looks\nobviously fine — the point is that the parent, not you, decides that.\n\nA. Write @@ROLE_DIR@@/status.json with status executing when you start.\nB. Do the work, then write @@ROLE_DIR@@/result.md describing what you did.\n\nC. Offer it. This records the attempt and prints its nonce:\n\n     node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ prepare\n\nD. Tell the parent it is ready. **The subject carries the nonce and nothing else** — Orca\n   builds the payload from the id flags, so a nonce put there would be dropped.\n   **Read the nonce back from the record inside the same command**, as written here: each\n   command you run is a fresh shell, so a variable you set in C is gone by now, and a\n   merge_ready without a nonce jams the parent\'s whole batch.\n\n     @@ORCA_BIN@@ orchestration send --type merge_ready \\\n       --task-id <task id> --dispatch-id <dispatch id> \\\n       --dispatch-capability <capability> --from <handle> \\\n       --subject "merge_ready: $(node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ nonce)" \\\n       --body "<what you did>" --json\n\n   Then run: node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ sent\n   The parent replies on this same dispatch.\n\nE. Wait for that reply. **Do not end your turn to wait.** A message put in your mailbox\n   does not wake you: a turn closed here is a dispatch that stops for good, and someone has\n   to come and restart you by hand.\n\n     node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ await\n\n   It blocks for up to 10 minutes, reads your mailbox with --peek (never --ack), matches\n   your own nonce, and prints one line:\n   - `accepted` -> go to F.\n   - `remediation <reason>` -> the reason says what is missing. Fix it and go back to C.\n     The nonce does not change.\n   - `waiting` -> nobody has answered yet. **Run it again, in this same turn.** Keep\n     running it. It is normal for this to take several rounds. **This wait has no time limit:**\n     whether a stalled task should stop is decided by the user through the parent, not by\n     you.\n   A non-zero exit means the mailbox could not be read at all; try once more. If it fails\n   again, write that in result.md, run\n   `node @@REPORT_STATUS@@ @@ROLE_DIR@@ error the mailbox could not be read`, and stop. Do not report done.\n\nF. Report. `await` already checked the nonce and recorded the acceptance, so there is\n   nothing to confirm here:\n\n     node @@REPORT_STATUS@@ @@ROLE_DIR@@ done <one line>\n\nG. Send worker_done, then record that it landed:\n\n     @@ORCA_BIN@@ orchestration send --type worker_done \\\n       --task-id <task id> --dispatch-id <dispatch id> \\\n       --dispatch-capability <capability> --from <handle> \\\n       --outcome succeeded --subject "<short status>" --body "<what you did>" --json\n     node @@COMPLETION@@ --role-dir @@ROLE_DIR@@ settle\n\n   **Before resending anything, inspect:**\n     @@ORCA_BIN@@ orchestration dispatch-show --task <task id> --json\n   If the dispatch is already terminal, **do not resend** — run settle and stop.\n\nH. **If the work itself failed, none of C-G applies.** Write why in result.md, run\n   `node @@REPORT_STATUS@@ @@ROLE_DIR@@ error <reason>`, and send worker_done with --outcome failed. That\n   status is the record that a failure is still owed; there is nothing to offer.\n\nI. **Do not invent message types.** The only things you send are the ones above, plus\n   `orchestration ask` **when this task told you to ask** (see the brainstorming section, if\n   there is one). Do not send escalations: the parent has no path for them.\n\n   When you do use `ask`, expect it to block until a person answers through the parent, and\n   remember it costs someone\'s attention. Ask only what you need answered.\nJ. End your turn and stay idle.',
}
type Context = {
  slug: string
  repoRoot: string
  repo: string
  statusDir: string
  reviewDir: string
  parent: string
  run: string
  config: JsonObject
  reviewMode: string
  phaseB: string
  setup: string
  designMode: string
}
const renderSpec = (context: Context, role: string): string => {
  const key = `${role}|${role === 'design' || role === 'exec' ? context.reviewMode : 'on'}|${role === 'design' ? context.phaseB : 'on'}|${role === 'design' ? context.designMode : 'direct'}`
  let spec = SPEC_TEMPLATES[key] ?? ''
  const roleDir = join(context.statusDir, 'roles', role)
  const request = readFileSync(join(context.statusDir, 'request.md'), 'utf8').replace(/\n+$/, '')
  const substitutions: Record<string, string> = {
    '@@SLUG@@': context.slug,
    '@@ROLE_DIR@@': shellQuote(roleDir),
    '@@PLAN@@': shellQuote(join(context.statusDir, 'plan.md')),
    '@@SPEC@@': shellQuote(join(context.statusDir, 'spec.md')),
    '@@REQUEST_FILE@@': shellQuote(join(context.statusDir, 'request.md')),
    '@@COMPLETION@@': shellQuote(join(SCRIPTS, 'completion.ts')),
    '@@REPORT_STATUS@@': shellQuote(join(SCRIPTS, 'report-status.ts')),
    '@@ORCA_BIN@@': shellQuote(orcaBin()),
    '@@SENDER@@': shellQuote(SENDER),
    '@@WORKERS_FILE@@': shellQuote(join(context.statusDir, 'workers.json')),
    '@@REVIEW_DIR@@': shellQuote(context.reviewDir),
    '@@STATUS_DIR@@': shellQuote(context.statusDir),
    '@@REQUEST_CONTENT@@': request,
  }
  for (const [marker, value] of Object.entries(substitutions)) spec = spec.replaceAll(marker, value)
  return spec
}
const awaitCreated = (context: Context, name: string): Json | null => {
  const seconds = envCount('ORCA_CREATE_SETTLE_SECS', 120)
  const interval = envCount('ORCA_CREATE_SETTLE_INTERVAL', 5)
  let waited = 0
  while (waited < seconds) {
    sleepSeconds(interval)
    waited += interval
    const listed = runOrca(['worktree', 'list', '--repo', context.repo, '--json'])
    if (listed.rc !== 0) continue
    const matches =
      asArray(get(listed.json, 'result', 'worktrees'))?.filter((entry) => get(entry, 'displayName') === name) ?? []
    if (matches.length === 1) return matches[0] ?? null
    if (matches.length > 1) return null
  }
  return null
}
const roleUpdate = (site: string, file: string, role: string, additions: JsonObject): boolean =>
  updateWorkers(site, file, (workers) => {
    const roles = object(workers.roles)
    workers.roles = { ...roles, [role]: { ...object(roles[role]), ...additions } }
  })
// ★ 起動が終わらなかった試行は、失敗・停止が証明されてから同じ Task に置き換える。
const incompleteStart = (statusDir: string, slug: string, role: string, dispatch: string): string =>
  `the ${role} start did not complete for ${slug} (dispatch ${dispatch}); once Orca reports that worker failed or stopped, replace it with: node ${join(PLUGIN, 'bin', 'orca-recover.ts')} --status-dir ${statusDir} --role ${role}`

const launchRole = (context: Context, role: string): boolean => {
  const name = role === 'design' ? context.slug : `${context.slug}-${role.replaceAll('_', '-')}`
  const title = `${context.slug}/${role}`
  const roleDir = join(context.statusDir, 'roles', role)
  const workersFile = join(context.statusDir, 'workers.json')
  const agent = string(get(context.config, 'roles', role, 'agent'))
  const model = string(get(context.config, 'roles', role, 'model'))
  const effort = string(get(context.config, 'roles', role, 'effort'))
  if (agent === '') {
    log(NAME, `role '${role}' has no agent resolved`)
    return false
  }

  const listed = runOrca(['worktree', 'list', '--repo', context.repo, '--json'])
  const worktrees = asArray(get(listed.json, 'result', 'worktrees'))
  if (listed.rc !== 0 || worktrees === null) {
    log(NAME, `cannot list worktrees for ${context.repo} (rc=${listed.rc}); refusing to guess whether one exists`)
    return false
  }
  const matches = worktrees.filter((entry) => get(entry, 'displayName') === name)
  if (matches.length > 1) {
    log(NAME, `${matches.length} worktrees are named '${name}' in ${context.repo}; refusing to guess which one`)
    return false
  }
  let worktree: Json | null = matches[0] ?? null
  let created = ''
  if (worktree !== null) log(NAME, `reusing the existing worktree for ${name}`)
  else {
    const createdResult = runOrca([
      'worktree',
      'create',
      '--repo',
      context.repo,
      '--name',
      name,
      '--no-parent',
      '--setup',
      context.setup,
      '--json',
    ])
    worktree = get(createdResult.json, 'result', 'worktree') ?? null
    let adopted = false
    if (createdResult.rc !== 0 || worktree === null) {
      const code = string(get(createdResult.json, 'error', 'code'))
      const message = string(get(createdResult.json, 'error', 'message'))
      const detail = [code, message].filter((part) => part !== '').join(': ')
      if (code === 'runtime_unavailable') {
        worktree = awaitCreated(context, name)
        if (worktree === null) {
          log(
            NAME,
            `worktree create failed for ${role} (rc=${createdResult.rc})${detail ? `; ${detail}` : ''}; the worktree ${name} did not appear within ${envCount('ORCA_CREATE_SETTLE_SECS', 120)}s`,
          )
          return false
        }
        log(NAME, `worktree create for ${role} reported ${code}, but Orca created ${name} afterwards; adopting it`)
        adopted = true
      } else {
        log(NAME, `worktree create failed for ${role} (rc=${createdResult.rc})${detail ? `; ${detail}` : ''}`)
        return false
      }
    }
    created = string(get(worktree, 'id'))
    if (context.setup === 'run' && adopted) {
      log(
        NAME,
        `cannot verify that the repository setup hook succeeded for ${role} (no receipt); refusing to start a worker on it. The worktree is KEPT`,
      )
      log(NAME, `worktree=${created}  inspect with: ${orcaBin()} worktree list --repo ${context.repo} --json`)
      return false
    }
    if (context.setup === 'run') {
      const effects = asArray(get(createdResult.json, 'result', 'effects')) ?? []
      const setupEffect = effects.find((entry) => get(entry, 'kind') === 'setup')
      const setupState =
        string(get(createdResult.json, 'result', 'setup', 'state')) ||
        string(get(createdResult.json, 'result', 'setup', 'status')) ||
        string(get(setupEffect, 'state'))
      if (
        setupState !== '' &&
        !['succeeded', 'success', 'completed', 'not_applicable', 'skipped'].includes(setupState)
      ) {
        log(
          NAME,
          `the repository setup hook did not succeed for ${role} (state '${setupState}'); refusing to start a worker on it`,
        )
        if (runOrca(['worktree', 'rm', '--worktree', `id:${created}`, '--force', '--json']).rc === 0) {
          log(NAME, `the worktree this call created for ${role} was removed`)
        } else log(NAME, `worktree rm FAILED for ${role}; it is KEPT`)
        return false
      }
    }
  }
  const worktreeId = string(get(worktree, 'id'))
  const receivedPath = string(get(worktree, 'path'))
  const worktreePath = receivedPath === '' ? '' : (toLocal(receivedPath) ?? '')
  const branch = string(get(worktree, 'branch')).replace(/^refs\/heads\//, '')
  if (worktreeId === '' || worktreePath === '' || !isDir(worktreePath)) {
    log(NAME, `the ${role} worktree has no usable id/path`)
    return false
  }
  if (branch === '') {
    log(NAME, `the ${role} worktree receipt has no branch; refusing to guess`)
    return false
  }
  if (created === '') {
    const status = git(worktreePath, 'status', '--porcelain')
    if (status.rc !== 0) {
      log(NAME, `cannot read the status of the existing worktree ${worktreePath}`)
      return false
    }
    if (status.stdout !== '') {
      log(NAME, `the existing worktree ${worktreePath} is dirty; commit or clean it first`)
      return false
    }
  }

  let agentTerminal = ''
  const kept = (message: string): void => {
    log(NAME, message)
    log(
      NAME,
      `run=${context.run} role=${role} worktree=${worktreeId} path=${worktreePath} branch=${branch} terminal=${agentTerminal || 'none'}`,
    )
  }
  const cleanupBeforeTask = (): void => {
    if (created === '') {
      log(NAME, `the ${role} worktree was reused, so it is kept`)
      return
    }
    const removed = runOrca(['worktree', 'rm', '--worktree', `id:${created}`, '--force', '--json'])
    if (removed.rc === 0) log(NAME, `the worktree this call created for ${role} was removed`)
    else log(NAME, `worktree rm FAILED for ${role} (rc=${removed.rc}); it is KEPT`)
  }
  const rolewrite = (site: string, file: string, content: string): boolean => {
    if (write(site, file, content)) return true
    kept(`cannot write ${file}`)
    cleanupBeforeTask()
    return false
  }
  if (created !== '') {
    const parentHead = git(context.repoRoot, 'rev-parse', 'HEAD')
    const childHead = git(worktreePath, 'rev-parse', 'HEAD')
    const parentId = parentHead.rc === 0 ? parentHead.stdout.trim() : ''
    const childId = childHead.rc === 0 ? childHead.stdout.trim() : ''
    if (parentId === '' || childId === '') {
      kept(`cannot compare the ${role} worktree's base with the parent checkout`)
      cleanupBeforeTask()
      return false
    }
    if (parentId !== childId) {
      if (git(worktreePath, 'merge-base', '--is-ancestor', childId, parentId).rc === 0) {
        if (git(worktreePath, 'merge', '--ff-only', parentId).rc !== 0) {
          kept(`the ${role} worktree is behind the parent checkout and cannot be fast-forwarded`)
          cleanupBeforeTask()
          return false
        }
        log(NAME, `fast-forwarded the ${role} worktree to the parent checkout (${parentId})`)
      } else if (git(worktreePath, 'merge-base', '--is-ancestor', parentId, childId).rc !== 0) {
        kept(`the ${role} worktree's base (${childId}) is unrelated to the parent checkout (${parentId})`)
        cleanupBeforeTask()
        return false
      }
    }
  }
  if (!rolewrite(`status-${role}`, join(roleDir, 'status.json'), '{"status":"starting"}')) return false
  if (
    !roleUpdate(`workers-worktree-${role}`, workersFile, role, {
      worktree_id: worktreeId,
      worktree_path: worktreePath,
      branch,
      worktree_created_by_this_run: created !== '',
      worktree_terminals: null,
    })
  ) {
    kept(`cannot record the ${role} worktree`)
    cleanupBeforeTask()
    return false
  }
  const spec = renderSpec(context, role)
  const taskCreated = runOrca([
    'orchestration',
    'task-create',
    '--spec',
    spec,
    '--task-title',
    title,
    '--from',
    context.parent,
    '--json',
  ])
  const task = string(get(taskCreated.json, 'result', 'task', 'id'))
  if (taskCreated.rc !== 0) {
    if (task !== '') {
      kept(
        `task-create failed for ${role} (rc=${taskCreated.rc}) but returned task id ${task}; a Task may exist. Resources are KEPT.`,
      )
      log(NAME, `task=${task}  inspect with: ${orcaBin()} orchestration task-list --run ${context.run} --json`)
    } else {
      kept(`task-create failed for ${role} (rc=${taskCreated.rc}); no Task was created`)
      cleanupBeforeTask()
    }
    return false
  }
  if (task === '') {
    kept(`task-create returned success but no task id for ${role}; a Task may exist. Resources are KEPT.`)
    log(NAME, `inspect with: ${orcaBin()} orchestration task-list --run ${context.run} --json`)
    return false
  }
  if (!roleUpdate(`workers-after-task-${role}`, workersFile, role, { task })) {
    kept(`the ${role} task was created but could not be recorded. Resources are KEPT.`)
    log(NAME, `task=${task}  inspect with: ${orcaBin()} orchestration task-list --run ${context.run} --json`)
    return false
  }
  // ★ 作成直後の空シェルは agent terminal が生まれる前に 1 枚と確定できたときだけ閉じる。
  let startupTerminal = ''
  if (created !== '' && context.setup !== 'run') {
    const terminals = terminalHandles(worktreeId)
    if (terminals?.length === 1) startupTerminal = string(terminals[0])
  }
  const args = ['--agent', agent]
  if (model !== '') {
    args.push('--model', model)
    if (effort !== '') args.push('--effort', effort)
  }
  log(NAME, `${role} runs agent=${agent} model=${model || '<orca default>'} effort=${effort || '<orca default>'}`)
  const started = runOrca([
    'orchestration',
    'worker-start',
    '--task',
    task,
    '--worktree',
    `id:${worktreeId}`,
    ...args,
    '--from',
    context.parent,
    '--json',
  ])
  const state = string(get(started.json, 'result', 'state'))
  const dispatch = string(get(started.json, 'result', 'dispatchId'))
  const effects = asArray(get(started.json, 'result', 'effects')) ?? []
  agentTerminal = string(
    get(
      effects.find((effect) => get(effect, 'kind') === 'terminal' && get(effect, 'role') === 'agent'),
      'id',
    ),
  )
  const recordOrphan = (): void => {
    if (dispatch === '') return
    if (!roleUpdate(`workers-orphan-dispatch-${role}`, workersFile, role, { dispatch, start_incomplete: true })) {
      log(NAME, `the dispatch id could not be recorded either; wait on dispatch=${dispatch} by hand`)
    }
  }
  if (started.rc !== 0 || state !== 'ready' || dispatch === '') {
    recordOrphan()
    log(
      NAME,
      `worker-start did not report ready for ${role} (rc=${started.rc} state='${state || 'none'}'). Resources are KEPT.`,
    )
    log(NAME, `inspect with: ${orcaBin()} orchestration task-list --run ${context.run} --json`)
    return false
  }
  if (agentTerminal === '') {
    recordOrphan()
    log(NAME, `worker-start reported ready for ${role} but returned no agent terminal handle. Resources are KEPT.`)
    log(
      NAME,
      `task=${task} dispatch=${dispatch}  inspect with: ${orcaBin()} orchestration worker-show --dispatch ${dispatch} --json`,
    )
    return false
  }
  if (startupTerminal !== '' && startupTerminal !== agentTerminal) {
    if (runOrca(['terminal', 'close', '--terminal', startupTerminal, '--json']).rc !== 0) {
      log(
        NAME,
        `could not close the empty startup terminal ${startupTerminal} in the ${role} worktree; it is left open`,
      )
    }
  }
  const terminals = terminalHandles(worktreeId)
  if (terminals === null) {
    log(NAME, `could not inventory the terminals in the ${role} worktree; cleanup will refuse to remove it`)
  }
  if (
    !roleUpdate(`workers-after-dispatch-${role}`, workersFile, role, {
      dispatch,
      terminal: agentTerminal,
      worktree_terminals: terminals,
    })
  ) {
    kept(`the ${role} worker started but the dispatch id could not be recorded. Resources are KEPT.`)
    log(NAME, `task=${task} dispatch=${dispatch}`)
    log(NAME, `inspect with: ${orcaBin()} orchestration worker-show --dispatch ${dispatch} --json`)
    return false
  }
  return true
}
const main = (argv: string[]): number => {
  let requestFile = ''
  let slug = ''
  let objective = ''
  let repoRoot = ''
  let runIn = ''
  let agent = ''
  let model = ''
  let effort = ''
  let designMode = ''
  let integration = ''
  let phase = 'design'
  let resume = false
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--resume') {
      resume = true
      continue
    }
    if (
      [
        '--request-file',
        '--slug',
        '--objective',
        '--repo-root',
        '--run',
        '--agent',
        '--model',
        '--effort',
        '--design-mode',
        '--integration',
        '--phase',
      ].includes(flag ?? '')
    ) {
      if (i + 1 >= argv.length) die(NAME, `${flag} requires a value`)
      const value = argv[++i] ?? ''
      if (flag === '--request-file') requestFile = value
      if (flag === '--slug') slug = value
      if (flag === '--objective') objective = value
      if (flag === '--repo-root') repoRoot = value
      if (flag === '--run') runIn = value
      if (flag === '--agent') agent = value
      if (flag === '--model') model = value
      if (flag === '--effort') effort = value
      if (flag === '--design-mode') designMode = value
      if (flag === '--integration') integration = value
      if (flag === '--phase') phase = value
    } else die(NAME, `unknown option: ${flag}`)
  }
  if (phase !== 'design' && phase !== 'exec') die(NAME, `--phase must be design or exec: ${phase}`)
  if (resume) {
    if (phase !== 'design') die(NAME, '--resume continues the design phase; the exec phase always continues')
    if (requestFile !== '' || runIn !== '')
      die(NAME, '--resume uses the recorded request and Run; do not pass --request-file or --run')
  }
  const continuing = phase === 'exec' || resume
  if (continuing && integration !== '')
    die(NAME, '--integration is fixed when the dispatch starts; the recorded value is kept')
  if (continuing) {
    if (slug === '') die(NAME, '--slug is required')
  } else if (requestFile === '' || slug === '' || objective === '') {
    die(NAME, '--request-file, --slug and --objective are required')
  }
  if (!continuing) {
    if (!readable(requestFile)) die(NAME, `--request-file is not readable: ${requestFile}`)
    if (!nonempty(requestFile)) die(NAME, `--request-file must not be empty: ${requestFile}`)
  }
  if (!/^[a-z0-9][a-z0-9-]{0,29}$/.test(slug)) die(NAME, `invalid slug: ${slug} (use ^[a-z0-9][a-z0-9-]{0,29}$)`)
  if (repoRoot === '') {
    const found = run('git', ['rev-parse', '--show-toplevel'])
    if (found.rc !== 0) die(NAME, 'not in a git repo')
    repoRoot = found.stdout.trim()
  }
  const hostPath = toHost(repoRoot)
  if (hostPath === null || hostPath === '') {
    log(NAME, `cannot express ${repoRoot} in the form the Orca CLI expects`)
    return 1
  }
  const repo = `path:${hostPath}`
  const statusDir = join(repoRoot, '.dispatch', slug)
  if (phase === 'exec' && !isDir(statusDir)) {
    log(NAME, `${statusDir} does not exist; run the design phase first`)
    return 1
  }
  if (resume && !isDir(statusDir)) {
    log(NAME, `${statusDir} does not exist; there is nothing to resume`)
    return 1
  }
  if (!continuing && existsSync(statusDir)) {
    log(NAME, `${statusDir} already exists; pick a different slug`)
    return 1
  }

  const bin = orcaBin()
  if (bin.includes('/')) {
    try {
      accessSync(bin, constants.X_OK)
    } catch {
      log(NAME, `the Orca CLI is not at ${bin}`)
      return 1
    }
  } else if (which(bin) === null) {
    log(NAME, `the Orca CLI '${bin}' is not on PATH`)
    return 1
  }
  const runtime = runOrca(['status', '--json'])
  if (runtime.rc !== 0 || get(runtime.json, 'result', 'runtime', 'reachable') !== true) {
    log(NAME, 'the Orca runtime is not reachable')
    return 1
  }
  const parent = process.env.ORCA_TERMINAL_HANDLE ?? ''
  if (parent === '') {
    log(NAME, 'ORCA_TERMINAL_HANDLE is not set; run this from an Orca terminal')
    return 1
  }
  const shown = runOrca(['terminal', 'show', '--terminal', parent, '--json'])
  if (shown.rc !== 0 || get(shown.json, 'result', 'terminal', 'handle') == null) {
    log(NAME, `cannot verify the parent terminal ${parent}`)
    return 1
  }
  const branch = git(repoRoot, 'symbolic-ref', '--short', 'HEAD')
  const integrationBranch = branch.rc === 0 ? branch.stdout.trim() : ''
  if (integrationBranch === '') {
    log(NAME, 'the parent checkout is in a detached HEAD; cannot fix a merge target')
    return 1
  }

  const overrides: string[] = []
  if (agent !== '') overrides.push('--set', `design.agent=${agent}`)
  if (model !== '') overrides.push('--set', `design.model=${model}`)
  if (effort !== '') overrides.push('--set', `design.effort=${effort}`)
  if (designMode !== '') overrides.push('--design-mode', designMode)
  if (integration !== '') overrides.push('--integration', integration)
  if (!readable(RESOLVER)) {
    log(NAME, `the config resolver is missing at ${RESOLVER}`)
    return 1
  }
  const resolved = runNode(RESOLVER, ['--project-root', repoRoot, ...overrides])
  if (resolved.stderr !== '') process.stderr.write(resolved.stderr)
  const config = asObject(parseJson(resolved.stdout))
  if (resolved.rc !== 0 || config === null || typeof get(config, 'roles', 'design', 'agent') !== 'string') {
    log(NAME, `cannot resolve the dispatch configuration (rc=${resolved.rc}); nothing was created`)
    return 1
  }
  const reviewMode = string(config.review_mode) || 'off'
  const phaseB = string(config.phase_b) || 'off'
  const setup = string(config.setup) || 'skip'
  const mode = string(config.design_mode) || 'direct'
  const workersFile = join(statusDir, 'workers.json')
  const started = (role: string): boolean => string(get(readJson(workersFile), 'roles', role, 'dispatch')) !== ''
  const launchOrder: string[] = []
  if (phase === 'exec') {
    if (phaseB !== 'on') {
      log(NAME, 'phase_b is off; there is no exec role to start')
      return 1
    }
    const designStatus = string(get(readJson(join(statusDir, 'roles', 'design', 'status.json')), 'status'))
    if (designStatus !== 'done') {
      log(NAME, `the design role is '${designStatus || 'missing'}', not done; refusing to start exec`)
      return 1
    }
    if (!nonempty(join(statusDir, 'plan.md'))) {
      log(NAME, `${statusDir}/plan.md is missing or empty; refusing to start exec on no plan`)
      return 1
    }
    if (started('exec')) {
      const dispatch = string(get(readJson(workersFile), 'roles', 'exec', 'dispatch'))
      log(
        NAME,
        startIncomplete(statusDir, 'exec')
          ? incompleteStart(statusDir, slug, 'exec', dispatch)
          : `the exec role has already started for ${slug}`,
      )
      return 1
    }
    if (reviewMode === 'on') {
      if (started('exec_review')) log(NAME, `exec_review has already started for ${slug}; starting exec only`)
      else launchOrder.push('exec_review')
    }
    launchOrder.push('exec')
  } else {
    if (resume) {
      if (!nonempty(join(statusDir, 'request.md')) || !nonempty(workersFile)) {
        log(NAME, `${statusDir} has no recorded request or dispatch state; there is nothing to resume`)
        return 1
      }
      if (started('design')) {
        const dispatch = string(get(readJson(workersFile), 'roles', 'design', 'dispatch'))
        log(
          NAME,
          startIncomplete(statusDir, 'design')
            ? incompleteStart(statusDir, slug, 'design', dispatch)
            : `the design role has already started for ${slug}`,
        )
        return 1
      }
    }
    if (reviewMode === 'on') {
      if (resume && started('design_review'))
        log(NAME, `design_review has already started for ${slug}; starting design only`)
      else launchOrder.push('design_review')
    }
    launchOrder.push('design')
  }
  const reviewDir = join(statusDir, 'review')
  try {
    for (const role of launchOrder) mkdirSync(join(statusDir, 'roles', role), { recursive: true })
    mkdirSync(reviewDir, { recursive: true })
  } catch {
    log(NAME, `cannot create ${reviewDir}`)
    return 1
  }
  if (!continuing) {
    try {
      writeFileSync(join(statusDir, 'request.md'), readFileSync(requestFile))
    } catch {
      log(NAME, 'cannot materialize the request')
      return 1
    }
  }
  const exclude = git(repoRoot, 'rev-parse', '--git-path', 'info/exclude')
  if (exclude.rc === 0 && exclude.stdout.trim() !== '') {
    const path = isAbsolute(exclude.stdout.trim()) ? exclude.stdout.trim() : join(repoRoot, exclude.stdout.trim())
    try {
      mkdirSync(dirname(path), { recursive: true })
      const text = readable(path) ? readFileSync(path, 'utf8') : ''
      if (!text.split('\n').includes('.dispatch/')) appendFileSync(path, '.dispatch/\n')
    } catch {
      /* 除外に失敗しても起動を止めない */
    }
  }
  let runId = ''
  if (continuing) {
    const prior = readJson(join(statusDir, 'run.json'))
    runId = string(get(prior, 'run_id'))
    if (runId === '') {
      log(NAME, `no run_id recorded in ${statusDir}/run.json`)
      return 1
    }
    const recordedParent = string(get(prior, 'parent_handle'))
    if (recordedParent !== parent) {
      log(NAME, `this terminal is ${parent} but the dispatch was started from ${recordedParent || 'unknown'}`)
      return 1
    }
  } else if (runIn !== '') runId = runIn
  else {
    const created = runOrca(['orchestration', 'run-create', '--objective', objective, '--from', parent, '--json'])
    runId = string(get(created.json, 'result', 'run', 'id'))
    if (created.rc !== 0 || runId === '') {
      log(NAME, `run-create failed (rc=${created.rc})`)
      return 1
    }
  }
  if (!continuing) {
    const current = runOrca(['orchestration', 'run-current', '--from', parent, '--json'])
    const boundParent = string(get(current.json, 'result', 'run', 'coordinator_handle'))
    const boundRun = string(get(current.json, 'result', 'run', 'id'))
    if (boundParent !== parent) {
      log(NAME, `the Run bound to '${boundParent || 'unknown'}', not to ${parent}`)
      return 1
    }
    if (boundRun !== runId) {
      log(NAME, `this terminal is bound to Run '${boundRun || 'unknown'}', not to ${runId}`)
      return 1
    }
    if (
      !write(
        'run',
        join(statusDir, 'run.json'),
        JSON.stringify({ run_id: runId, parent_handle: parent, repo_root: repoRoot }),
      )
    ) {
      log(NAME, 'the Run was created but could not be recorded. Nothing else exists yet.')
      log(NAME, `run=${runId}  inspect with: ${bin} orchestration run-show --id ${runId} --json`)
      return 1
    }
    const roles: JsonObject = {}
    for (const [role, tuple] of Object.entries(object(config.roles)))
      roles[role] = { ...object(tuple), retained: false }
    const initial = {
      run_id: runId,
      integration_branch: integrationBranch,
      integration_role: string(config.integration_role) || 'design',
      integration: config.integration ?? null,
      roles,
    }
    if (!write('workers-initial', workersFile, JSON.stringify(initial))) {
      log(NAME, 'the Run was created but the dispatch state could not be recorded. Nothing else exists yet.')
      log(NAME, `run=${runId}  inspect with: ${bin} orchestration run-show --id ${runId} --json`)
      return 1
    }
  } else {
    for (const role of launchOrder) {
      const tuple = { ...object(get(config, 'roles', role)), retained: false }
      if (!roleUpdate(`workers-tuple-${role}`, workersFile, role, tuple)) {
        log(NAME, `cannot record the ${role} tuple`)
        return 1
      }
    }
  }
  const context: Context = {
    slug,
    repoRoot,
    repo,
    statusDir,
    reviewDir,
    parent,
    run: runId,
    config,
    reviewMode,
    phaseB,
    setup,
    designMode: mode,
  }
  for (const role of launchOrder) if (!launchRole(context, role)) return 1
  process.stdout.write(`status_dir=${statusDir}\nrun_id=${runId}\n`)
  return 0
}

process.exitCode = main(process.argv.slice(2))
