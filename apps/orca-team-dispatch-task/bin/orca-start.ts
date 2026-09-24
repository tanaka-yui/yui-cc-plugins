// worktree を用意し、worker を 1 つ起動してタスクを届ける。
// Usage: node orca-start.ts --request-file <f> --slug <s> --objective <o> [--repo-root <p>]
//        [--run <id>] [--agent <id>] [--model <id>] [--effort <level>]
//        [--phase design|exec] [--design-mode direct|plan|brainstorm] [--integration merge|pr]
//        node orca-start.ts --slug <s> --resume [--repo-root <p>] [--design-mode ...]
// Exit: 0 / 1 起動できなかった / 2 使用法
import { die, log } from '../lib/cli.ts'
import { startIncomplete } from '../lib/dispatch.ts'
import { readJson, writeAtomic } from '../lib/fs.ts'
import { asArray, asObject, asString, get, type Json, type JsonObject, parseJson } from '../lib/json.ts'
import { orcaBin, receiptOk, runOrca, terminalHandles, workerTerminal } from '../lib/orca.ts'
import { envCount, run, runNode, sleepSeconds, which } from '../lib/sys.ts'
import { trustBlocked, trustHint } from '../lib/trust.ts'

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
// 移植元の理由（bin/orca-start.sh）:
// ★ WSL2 では Orca 本体が Windows 側に居るので、**CLI 境界で path 形式が変わる**（実測）。
//   送り: `path:` selector が Linux path のままだと repo_not_found になる
//   受け: receipt の path は UNC で返り、bash の -d も git -C も解釈できない
//   HOST_KIND だけを根拠にしない — wslpath の無い環境で変換すると path が空文字になる
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
    return writeAtomic(file, `${content}\n`)
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
// ★ 全ロール共通の STATUS PROTOCOL はここだけで組み立てる。役ごとに持つと文面がずれる。
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
// 移植元の理由（bin/orca-start.sh）:
// ★ 依頼元とラベルは役で決まる。design は計画を、exec は実装をレビューさせる
//
// ★ 依頼側のレビュー手順は design と exec で **ラベルとファイル名だけ**が違う。
//   本文を 2 つ書くと必ず片方だけ直されてドリフトするので、1 箇所で組み立てる。
//
// ★ **取りかかり方の指示は design にだけ載せる。**exec は計画に従う役であり、
//   reviewer は何も作らない。
//
// ★ **brainstorming のあとに writing-plans まで進ませる。**2026-09-23 の実測: 次の段を
//   書いていなかったので、worker は brainstorming だけで spec と plan を混ぜた plan.md を
//   1 本書いて終えた。**skill 自身の保存先と commit の手順はここで上書きする** — spec と
//   plan は status dir に置き、merge に混ぜない。phase_b=off の実装は Subagent-driven に
//   固定する（ユーザーの決定。実行方法の質問を 1 回減らす）。
//   ★ **finishing-a-development-branch は走らせない。**Subagent-driven は最後にそれを呼び、
//   merge / PR / 破棄を尋ねる。取り込み方は Step 1b でユーザーが選んでおり、取り込むのは親である
//
// ★ **design は実装しない。**実装役が別に居るのに両方が書くと、同じ変更が 2 つの
//   ブランチに載って取り込みが壊れる。
const renderSpec = (context: Context, role: string): string => {
  const qRoleDir = shellQuote(join(context.statusDir, 'roles', role))
  const qPlan = shellQuote(join(context.statusDir, 'plan.md'))
  const qSpec = shellQuote(join(context.statusDir, 'spec.md'))
  const qRequestFile = shellQuote(join(context.statusDir, 'request.md'))
  const qWorkersFile = shellQuote(join(context.statusDir, 'workers.json'))
  const qCompletion = shellQuote(join(SCRIPTS, 'completion.ts'))
  const qReportStatus = shellQuote(join(SCRIPTS, 'report-status.ts'))
  const qOrcaBin = shellQuote(orcaBin())
  const qSender = shellQuote(SENDER)
  const qReviewDir = shellQuote(context.reviewDir)
  const request = readFileSync(join(context.statusDir, 'request.md'), 'utf8').replace(/\n+$/, '')
  const closing = `STATUS PROTOCOL

Your injected preamble gives you the task id, the dispatch id, the dispatch capability
and the --from handle. Use that set. The Orca CLI is ${qOrcaBin}.

**Finishing is two-phase: you offer the work, the parent checks it, then you report.** Do
not report done before the parent has accepted. Do not skip a step because the work looks
obviously fine — the point is that the parent, not you, decides that.

A. Write ${qRoleDir}/status.json with status executing when you start.
B. Do the work, then write ${qRoleDir}/result.md describing what you did.

C. Offer it. This records the attempt and prints its nonce:

     node ${qCompletion} --role-dir ${qRoleDir} prepare

D. Tell the parent it is ready. **The subject carries the nonce and nothing else** — Orca
   builds the payload from the id flags, so a nonce put there would be dropped.
   **Read the nonce back from the record inside the same command**, as written here: each
   command you run is a fresh shell, so a variable you set in C is gone by now, and a
   merge_ready without a nonce jams the parent's whole batch.

     ${qOrcaBin} orchestration send --type merge_ready \\
       --task-id <task id> --dispatch-id <dispatch id> \\
       --dispatch-capability <capability> --from <handle> \\
       --subject "merge_ready: $(node ${qCompletion} --role-dir ${qRoleDir} nonce)" \\
       --body "<what you did>" --json

   Then run: node ${qCompletion} --role-dir ${qRoleDir} sent
   The parent replies on this same dispatch.

E. Wait for that reply. **Do not end your turn to wait.** A message put in your mailbox
   does not wake you: a turn closed here is a dispatch that stops for good, and someone has
   to come and restart you by hand.

     node ${qCompletion} --role-dir ${qRoleDir} await

   It blocks for up to 10 minutes, reads your mailbox with --peek (never --ack), matches
   your own nonce, and prints one line:
   - \`accepted\` -> go to F.
   - \`remediation <reason>\` -> the reason says what is missing. Fix it and go back to C.
     The nonce does not change.
   - \`waiting\` -> nobody has answered yet. **Run it again, in this same turn.** Keep
     running it. It is normal for this to take several rounds. **This wait has no time limit:**
     whether a stalled task should stop is decided by the user through the parent, not by
     you.
   A non-zero exit means the mailbox could not be read at all; try once more. If it fails
   again, write that in result.md, run
   \`node ${qReportStatus} ${qRoleDir} error the mailbox could not be read\`, and stop. Do not report done.

F. Report. \`await\` already checked the nonce and recorded the acceptance, so there is
   nothing to confirm here:

     node ${qReportStatus} ${qRoleDir} done <one line>

G. Send worker_done, then record that it landed:

     ${qOrcaBin} orchestration send --type worker_done \\
       --task-id <task id> --dispatch-id <dispatch id> \\
       --dispatch-capability <capability> --from <handle> \\
       --outcome succeeded --subject "<short status>" --body "<what you did>" --json
     node ${qCompletion} --role-dir ${qRoleDir} settle

   **Before resending anything, inspect:**
     ${qOrcaBin} orchestration dispatch-show --task <task id> --json
   If the dispatch is already terminal, **do not resend** — run settle and stop.

H. **If the work itself failed, none of C-G applies.** Write why in result.md, run
   \`node ${qReportStatus} ${qRoleDir} error <reason>\`, and send worker_done with --outcome failed. That
   status is the record that a failure is still owed; there is nothing to offer.

I. **Do not invent message types.** The only things you send are the ones above, plus
   \`orchestration ask\` **when this task told you to ask** (see the brainstorming section, if
   there is one). Do not send escalations: the parent has no path for them.

   When you do use \`ask\`, expect it to block until a person answers through the parent, and
   remember it costs someone's attention. Ask only what you need answered.
J. End your turn and stay idle.`
  if (role === 'design_review' || role === 'exec_review') {
    const noun = role === 'design_review' ? 'plan' : 'implementation'
    const prefix = role === 'design_review' ? 'plan' : 'code'
    const label = role === 'design_review' ? 'review-plan:' : 'review-code:'
    const requester = role === 'design_review' ? 'design' : 'exec'
    const reviewer = `REVIEWER FOR TASK: ${context.slug}

You review. **You do not implement anything and you change no file** except the findings
files described below. The work itself belongs to another worker.

The request that worker was given is in ${qRequestFile}. Read it for context.

REVIEW LOOP

1. Wait for a request:

     ${qOrcaBin} orchestration check --terminal "$ORCA_TERMINAL_HANDLE" \\
       --peek --wait --timeout-ms 600000 --json

   Use --peek. **Never pass --ack** — the cursor is not yours to advance.
   A review request has a subject starting \`${label}\` and names a round number.
   A subject starting \`abort-reviewer:\` means the work finished without you; go to step 5.

   **Do not end your turn to wait.** A message put in your mailbox does not wake you, so a
   turn closed here leaves the worker you review waiting on a verdict that never comes.
   **An error naming an existing waiter is not a failure.** Orca refuses a wait while
   another one is active on this Run; the message says so (\`waiter_exists\`, or an
   already-active actionable waiter). That means the mailbox is busy, not that the work is
   gone. Wait a few seconds and run the same command again. It does not count as an empty
   wait.
   If the wait returns nothing, run it again, in this same turn. **This wait has no time limit.**
   Keep waiting until a request or \`abort-reviewer:\` arrives, however long that takes: the
   worker you review may be waiting on a person. Whether a stalled task should stop is
   decided by the user through the parent, not by you.

2. The body names a file under ${qReviewDir}. Read it and review the ${noun} against the request.

3. Write your findings to ${qReviewDir}/${prefix}-round-<n>-findings.md, where <n> is the round
   from the subject. **The prefix matters**: two reviewers share this directory, and a
   shared filename would overwrite the other one's findings. **End the file with exactly one line of this form and nothing after it:**

       VERDICT: approved

   or

       VERDICT: needs_work

   Use needs_work when something must change before this is worth building. Say what and
   why, concretely, above the verdict line. Do not edit the request file.

4. Send the verdict back:

     node ${qSender} --workers ${qWorkersFile} --to ${requester} \\
       --subject 'review-verdict: round <n>' --body '<absolute path to your findings file>'

   A non-zero exit means it was NOT delivered. Try once more; if it fails again, leave the
   findings file in place and go to step 5.
   Then go back to step 1 for the next round.

5. Finish. Say in result.md which rounds you answered and what each verdict was.`
    return `${reviewer}\n\n${closing}`
  }
  // ★ design と exec のレビュー手順はラベルとファイル名だけ変える。
  const reviewBlock = (reviewer: string, label: string, prefix: string, noun: string): string => {
    const requester = reviewer
    return `REVIEW PROTOCOL (do this before you finish)

A reviewer is already running and waiting for you. Have your ${noun} reviewed before you finish.

1. Write your ${noun} to ${qReviewDir}/${prefix}-round-<n>-request.md, starting at n=1. Be concrete enough
   that someone can disagree with it.

2. Send the request:

     node ${qSender} --workers ${qWorkersFile} --to ${requester} \\
       --subject '${label} round <n>' --body '<absolute path to your request file>'

   **A non-zero exit means it was NOT delivered.** Delete the request file you just wrote,
   note in result.md that review was unavailable, and carry on without it.

3. Wait for the verdict:

     ${qOrcaBin} orchestration check --terminal "$ORCA_TERMINAL_HANDLE" \\
       --peek --wait --timeout-ms 600000 --json

   Use --peek. **Never pass --ack.** Look for a subject starting \`review-verdict:\`.
   A subject starting \`review-skipped:\` means the parent stopped your reviewer: go to step 6.

   **Do not end your turn to wait.** A message put in your mailbox does not wake you, so a
   turn closed here is a dispatch that stops for good. If the wait returns nothing, run it
   again, in this same turn — reviewing takes longer than one wait. **This wait has no time limit.**
   Do not skip the review because nothing has arrived yet.

   **An error naming an existing waiter is not reviewisunavailable.** Orca refuses a
   wait while another one is active on this Run (\`waiter_exists\`, or an already-active
   actionable waiter). Wait a few seconds and run the same command again. **Do not record
   the review as skipped because of it** — only a \`review-skipped:\` message justifies that.

4. The body names a findings file. Read it. **Only a line reading exactly
   \`VERDICT: approved\` means approved.** Anything else, including a missing VERDICT line,
   is needs_work.

5. On needs_work: revise and repeat from step 1 with the next round number.
   **Stop after round 2.** Record the unresolved findings in result.md and keep the best
   version you have. Do not keep asking.

6. On \`review-skipped:\`, your reviewer is gone. Note in result.md that round <n> was not
   reviewed because the reviewer was stopped, and proceed without review. Skip step 7.

7. When you are done, release the reviewer:

     node ${qSender} --workers ${qWorkersFile} --to ${requester} \\
       --subject 'abort-reviewer: done' --body 'the work is finished'

`
  }
  if (role === 'exec') {
    const block =
      context.reviewMode === 'on' ? reviewBlock('exec_review', 'review-code:', 'code', 'implementation') : ''
    const task = `TASK: ${context.slug} (implementation)

Another worker has already planned this. **The plan says what to build.** It is at
${qPlan}. Read it first. If ${qSpec} exists, it is the
design the plan was written from: read it too. The original request is at
${qRequestFile} for context.

${block}1. Build what the plan describes, in this worktree, and commit it on this branch.
2. **Follow the plan.** If a step turns out to be wrong or impossible, do the rest, and say
   in result.md exactly which step you departed from and why. Do not silently redesign it.
3. Do not edit ${qPlan} or ${qSpec}. They are the record
   of what was agreed.`
    return `${task}\n\n${closing}`
  }
  let approach = ''
  if (context.designMode === 'plan')
    approach = `**Decide the approach before you touch anything.** Write down what you are
going to do and why, in result.md, before the first edit. If what you find while working
makes that approach wrong, say so there rather than quietly doing something else.

`
  if (context.designMode === 'brainstorm') {
    // ★ 2026-09-23: brainstorming の次に writing-plans を明記し、保存先と commit 手順を上書きする。
    // ★ finishing-a-development-branch は走らせない。取り込み方は親が決める。
    const afterPlan =
      context.phaseB === 'on'
        ? `Stop once the plan is written and self-reviewed: another worker builds it. Do not
   ask how to execute it, and do not start implementing.`
        : `Then build it in this worktree with \`superpowers:subagent-driven-development\`,
   following the plan, and commit the work on this branch. Do not ask how to execute the plan.
   Do not run \`superpowers:finishing-a-development-branch\`: stop after committing; the parent brings the branch home.`
    approach = `**Work through the superpowers skills in this order.**

1. Invoke \`superpowers:brainstorming\` and settle the open questions with the user before you
   plan or build anything.
2. Write the agreed design to ${qSpec}. This replaces the skill's own spec
   location and commit step: **write it there, not under docs/, and do not commit it.**
3. Invoke \`superpowers:writing-plans\` and write the plan to ${qPlan}, again
   instead of the skill's own location and without committing it.
   ${afterPlan}

**Ask through \`orchestration ask\`, not by printing a question and stopping.** The parent
relays it to a person and sends their answer back; a question you only print is read by
nobody. Ask one question at a time, as the skill does: each call blocks until someone answers.
The skill's request for the user to review the written spec goes through the same call.

If nobody ever answers, that call is where you will be waiting — that is expected, and the
person watching decides whether to answer or to stop the dispatch.

If either skill is not installed in this session, say so in result.md and carry on without it
rather than inventing your own version of it.

`
  }
  const others =
    context.designMode === 'brainstorm'
      ? `leave every other file alone apart from ${qSpec}.`
      : 'leave every other file alone.'
  // ★ design は phase_b=on では実装しない。実装役と両方が書くと取り込みが壊れる。
  const task =
    context.phaseB === 'on'
      ? `PLAN ONLY. **Do not implement anything and commit nothing.**

Another worker will build this from your plan, in a different worktree. Write the plan to
${qPlan} and ${others}

Make it specific enough to be built from without asking you: name the files to change, what
each change is for, and how someone would tell it worked. If the request cannot be built as
asked, say so in the plan rather than inventing a different task.`
      : 'Do the work in this worktree and commit it on this branch.'
  const block = context.reviewMode === 'on' ? reviewBlock('design_review', 'review-plan:', 'plan', 'plan') : ''
  const design = `TASK: ${context.slug}

${request}

${block}${approach}${task}`
  return `${design}\n\n${closing}`
}

// 移植元の理由（bin/orca-start.sh）:
// ★ **接続が切れた create は、Orca 側では作り終えていることがある**（実測 2026-09-19:
//   runtime_unavailable が 3 回続き、どれも同名の worktree が後から現れた）。待つ長さは
//   env で変えられる（テストが 2 分待たずに済むように）。
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
// 起動が終わらなかった役を回復する 1 行（incompleteStart と codex の信頼の案内が同じものを示す）
const recoverCommand = (statusDir: string, role: string): string =>
  `node ${join(PLUGIN, 'bin', 'orca-recover.ts')} --status-dir ${statusDir} --role ${role}`
// ★ 起動が終わらなかった試行は、失敗・停止が証明されてから同じ Task に置き換える。Orca が start_unknown と言う
//   試行は生死が分からないので、回復はその画面を見せて、ユーザーに --adopt か --restart を選ばせる
const incompleteStart = (statusDir: string, slug: string, role: string, dispatch: string): string =>
  `the ${role} start did not complete for ${slug} (dispatch ${dispatch}); run ${recoverCommand(statusDir, role)}: it replaces that start once Orca reports it failed or stopped, and when Orca reports it start_unknown it shows that worker's screen so that you can adopt or restart it`

// 移植元の理由（bin/orca-start.sh）:
// ★ **役ごとに違う名前にする。**`design` 以外を一律 `-review` にしていたので、
//   `exec` が `<slug>-review` を名乗り、**review_mode と phase_b を同時に on にすると
//   design_review と衝突した**（実機で発見: exec のブランチが `pb-live-review` になった）。
//
// ★ **inspection の失敗を「不在」と解釈しない** (round 2 finding 3)。
//   接続失敗・権限エラー・不正 selector を「作ってよい」と読むと資源が二重になる
//
// ★ **receipt の名前は `.displayName` である。`.name` は存在しない**（実測 O40）。
//
// ★ setup hook を走らせるかは設定で決まる（既定 skip）。
//   **rc と stdout を分けて持つ** — 非 0 と receipt らしき JSON が同時に返ることがある
//
// ★ **なぜ作れなかったかまで言う**（実測 2026-09-19: rc だけでは原因が残らなかった）
//
// ★ 接続切れだけは待つ。作る前に同名が無いことを確かめてあるので、後から現れた
//   ものはこの呼び出しが作ったものである。**それ以外の失敗は Orca が作れなかったと
//   答えているので待たない**
//
// ★ **setup が失敗した worktree で作業させない。**依存の無いまま実装すると、
//   なぜ失敗したか分からない成果ができる。receipt が setup の失敗を報告したら、
//   この呼び出しが作った worktree を戻して止まる。
//   **拾った worktree には receipt が無く、setup の成否を証明できない。**消す根拠も
//   無いので残して止まる
//
// ★ **再利用するなら clean であること** (round 2 finding 4)。dirty な checkout を worker へ
//   渡すと、前回の未完了変更が成果 commit に混ざる。status 自体が失敗するのも判断不能である
//
// ★ **作った worktree が、親の「いまの」HEAD から切られているかを確かめる。**
//   `worktree create` に基点を渡す口が無いので、基点を決めるのは Orca である。実測:
//   先のタスクを親へ取り込んで HEAD が進んだあとに切った worktree が、**取り込み前の
//   base のまま**だった。そこで実装させると、既に入っている変更を知らないまま働くので、
//   持ち帰りで必ず衝突する。**古い基点で黙って働かせない。**
//   **再利用した worktree には触らない** — 進行中の作業を巻き戻しかねない。
//
// ★ **読めないことを「一致している」と読まない。**判断できないなら作らない。
//
// ★ **この worktree を誰が作ったか**を記録する (round 3 finding 1)。端末はまだ存在しないので
//   端末集合の inventory は worker-start の後（端末が生まれてから）に回す
//
// ★ **`worktree create` が作った空の最初の端末を覚えておく**（実測 2026-09-19）。
//   worker-start は既存 worktree に agent 端末を別に作るので、放っておくと空のシェルが残る。
//   receipt は handle を返さない（startupTerminal=null）ため、agent 端末が生まれる前に列挙する。
//   **この呼び出しが作り、setup を走らせず、端末がちょうど 1 枚のときだけ**それと確定する。
//   それ以外（再利用 / setup 端末 / repo 設定のタブ / 列挙失敗）は区別できないので触らない
//
// ★ ここから先は何が起きても資源を削除しない (O19)。
//   **rc 0 + state=ready + dispatch id の 3 つ揃い**を要求する。
//   failed / outcome_unknown の receipt にも dispatchId が残ることがある
// ★ `--effort requires --model` (Orca)。config-resolve が model 無しの effort を既に
//   落としているが、ここでも組にして渡す — 片方だけが残ると worker-start が使用法で落ちる
//
// ★ **生きている dispatch id を捨てない。**記録せずに止めると、その worker はそれでも走って
//   共有 Delivery へ worker_done を送る。**兄弟タスクの wait はその message を処理できず、
//   batch を永久に ack できなくなる** — 完了した隣のタスクの成果まで取り出せなくなる。
//   記録さえ残っていれば、その status dir を wait 集合に入れて drain できる
//
// ★ **inventory の失敗を空配列に化けさせない** (round 4 finding 1)。
//   列挙できなかったことと「端末が 0 個」は別である。前者を [] にすると、
//   あとの cleanup gate が「未 account 0」と読んで削除を許してしまう (fail-open)。
//   確定できなければ null を記録し、gate 側はそれを「判断不能」として閉じる
//
// ★ **reviewer が起きなければ design を起こさない。**依頼先の無いレビュー要求で
//   design が待ち続けるより、1 件も起こさないほうが片付けが簡単である。
//   逆に design が失敗しても reviewer の資源は消さない（Task 成立後は削除しない / O19）。
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
  const recordOrphan = (shown: Json | null): void => {
    if (dispatch === '') return
    const terminal = agentTerminal || workerTerminal(shown)
    if (
      !roleUpdate(`workers-orphan-dispatch-${role}`, workersFile, role, {
        dispatch,
        terminal,
        start_incomplete: true,
        worktree_terminals: terminalHandles(worktreeId),
      })
    ) {
      log(NAME, `the dispatch id could not be recorded either; wait on dispatch=${dispatch} by hand`)
    }
  }
  if (started.rc !== 0 || state !== 'ready' || dispatch === '') {
    const shownResult =
      dispatch === '' ? null : runOrca(['orchestration', 'worker-show', '--dispatch', dispatch, '--json'])
    const shown = shownResult !== null && receiptOk(shownResult) ? shownResult.json : null
    recordOrphan(shown)
    log(
      NAME,
      `worker-start did not report ready for ${role} (rc=${started.rc} state='${state || 'none'}'). Resources are KEPT.`,
    )
    log(NAME, `inspect with: ${orcaBin()} orchestration task-list --run ${context.run} --json`)
    // ★ **codex がフォルダの信頼を求めて止まった起動なら、解き方をその場で言う**（lib/trust.ts）。2026-09-24 の
    //   influencer-platform: agent-trust-workspace で落ち、worker-show を読むまで原因が分からなかった
    if (dispatch !== '') {
      if (trustBlocked(shown)) {
        const retry = recoverCommand(context.statusDir, role)
        for (const line of trustHint(role, workerTerminal(shown), worktreePath, retry)) log(NAME, line)
      }
    }
    return false
  }
  if (agentTerminal === '') {
    const shown = runOrca(['orchestration', 'worker-show', '--dispatch', dispatch, '--json'])
    recordOrphan(receiptOk(shown) ? shown.json : null)
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
// 移植元の理由（bin/orca-start.sh）:
// ★ `--resume` は **design 段の起動が途中で落ちた status dir を続ける。**記録済みの依頼と
//   Run を使い、dispatch の無い役だけを起こす（exec 段は元から続きなので付けない）。
//
// ★ **exec は design が終わってからでないと起こせない。**計画が無いうちに実装させられない
//   ので、起動は 2 段に分かれる。`--phase design`（既定）が 1 段目、`--phase exec` が
//   2 段目である。**待ちはこのコマンドに持たせない** — 呼び出し側が `orca-wait.ts` で
//   待ってから 2 段目を呼ぶ（`orca-issue.ts` の phase 分割と同じ理由）。
// Exit: 0 / 1 = 起動できなかった / 2 = 使用法エラー
//
// ★ **続きの起動**（exec 段と --resume）は既存の status dir の記録を引き継ぐ
//
// ★ **取り込み方は起動時に 1 度だけ決める。**続きの起動で変えると、記録と実際の取り込みが
//   食い違い、merge と PR の両方が走りうる
//
// ★ slug は path になるので **fail closed に検証する**。../ で .dispatch の外へ出さない
//
// ★ repo は **常に親 checkout そのもの**を exact な path selector で指す。
//   `--repo` は受け付けない (round 2 finding 4): 別 repo を指されると worker はそこで動く
//   のに merge 先は $RR のままになり、誤 merge か不可解な失敗になる
//
// ★ failpoint は **呼び出し地点の ID** で撃つ (round 3 finding 6)。
//   同じ workers.json でも「Task 前」と「Task 後」は別の境界であり、
//   basename で比較すると狙った側を一度も発火させられない。
//   site は run / status / workers-initial / workers-after-task / workers-after-dispatch
//
// ★ **jq の出力を検査せずに write へ渡さない。**入力が空なら jq は空を返して 0 で終わるので、
//   握り潰すと workers.json を空で上書きし、branch と integration_branch が復元不能に消える
//
// ★ ORCA_BIN は path のことも PATH 上の command 名のこともある（WSL2 の `orca-ide`）。
//   command 名に -x を当てると必ず落ちる
//
// ★ **設定は資源を作る前に解決する。**壊れた config で worktree と Task を作ってから
//   落ちると、片付けの要る残骸だけが残る。config-resolve は読めない設定で exit 1 を返す。
//   設定が 1 つも無いのは正常で、そのとき各ロールは既定 tuple (lib/config.ts) で走る。
//
// ★ **起動順は reviewer が先** (spec 5-1 T4a)。design は起動直後にレビューを依頼しうるので、
//   その時点で reviewer の dispatch が workers.json に無いと、依頼が宛先不明で落ちる。
//
// ★ **2 段目。**design が成功していることと、その計画が実在することを確かめてから起こす。
//
// ★ **空の計画で実装させない。**plan.md が無い／空なら、exec は何を作るか知らないまま走る
//
// ★ **reviewer が先**（T4a と同じ理由）。exec は起動直後にレビューを依頼しうるので、
//   その時点で exec_review の dispatch が workers.json に無いと宛先不明で落ちる。
//   **やり直しでは起きている reviewer を起こし直さない**（実測 2026-09-19: exec_review が
//   起きたあと exec の worktree create だけが落ちた）。起こし直すと先の reviewer が
//   workers.json から外れ、誰にも使われないまま retained で残る。
//
// ★ **続ける元が揃っていなければ何も起こさない。**依頼か記録が無いまま起こすと、
//   何を頼まれたか分からない worker ができる
//
// ★ 続きの起動（exec 段と --resume）は記録の続きである。依頼も Run も上書きしない
//
// ★ `.dispatch/` を repo の除外へ入れる（実測: 入れないと親が常に `?? .dispatch/` で
//   dirty になり、merge の dirty ガードが必ず発火する）。
//   linked worktree では --git-path が絶対パスを返すので、相対のときだけ足す
//
// ★ **解決した tuple を全ロール分まとめて先に置く。**あとから「この worker は何で
//   走ったのか」を receipt 無しで答えられるようにする。未設定の model / effort は
//   キー自体を置かない（config-resolve の出力と同じ形にし、未設定と空文字を混ぜない）。
// ★ **取り込み先の役を 1 箇所で決める。**merge も PR も同じ値を読む。別々に判断すると
//   必ずずれる。今は design だけだが、実装役が増えたらここが変わる。
//   取り込み方（merge / pr）も同じく起動時に記録し、Step 4 と merge / PR の両スクリプトが読む。
//
// ★ 続きの起動は tuple だけを足す。**既存の役の記録を上書きしない**
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
