import {
  confirmInflightDead,
  DRIVEN_STATES,
  forgetRun,
  getMeta,
  getSubmission,
  listByStates,
  registerRun,
  setInflight,
  setInflightChild,
  transition,
  transitionWithStatus,
} from './db.ts'
import {
  CREATE_LOOKBACK_MINUTES,
  CREATE_SETTLE_MS,
  ERROR_CREATE_IN_FLIGHT,
  ERROR_CREATE_SETTLING,
  ERROR_DEADLINE,
  ERROR_GH_ACCOUNT_CHANGED,
  ERROR_LEASE_LOST,
  ERROR_RATELIMITED,
  ERROR_STATE_CHANGED,
  MAX_ACTION_ATTEMPTS,
  MAX_TITLE_CHARS,
  META_LABELS_HASH,
  MSG_CREATED,
  MSG_CREATED_TIMEOUT,
  MSG_FAILED,
  MSG_QUESTION_FOOTER,
  MSG_REJECTED,
  PROBLEM_SEPARATOR,
  STATUS_BACKLOG,
  TITLE_ELLIPSIS,
} from './defaults.ts'
import { writeAtomic } from './fs.ts'
import { createIssue, findIssueByMarker, labelsHash } from './github.ts'
import { buildIssueBody, issueLabels, issueMarker, neutralizeMentions } from './issue-body.ts'
import { asString, get, parseJson } from './json.ts'
import { renewLease } from './lease.ts'
import { isAlive, selfIdentity } from './process.ts'
import { maskSecrets } from './secrets.ts'
import { isFatalSlackError, postThread } from './slack-api.ts'
import { escapeMrkdwn } from './slack-text.ts'

import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

import type { Submission, SubmissionPatch } from './db.ts'
import type { Runtime } from './runtime.ts'
import type { State } from './types.ts'
export type DriveContext = { rt: Runtime; token: string; ttlMs: number; now: () => Date; deadline: number }
export type DriveOutcome = { id: number; from: State; to: State; error: string | null; stop: boolean }
export const stopError = (error: string): boolean =>
  [ERROR_RATELIMITED, ERROR_DEADLINE, ERROR_LEASE_LOST, ERROR_GH_ACCOUNT_CHANGED].includes(error) ||
  isFatalSlackError(error)
export const driveOne = async (ctx: DriveContext, s: Submission): Promise<DriveOutcome> => {
  const { rt, token } = ctx
  const now = () => ctx.now().toISOString()
  const renew = (): boolean => renewLease(rt.db, token, ctx.now(), ctx.ttlMs)
  const out = (error: string | null = null, stop = false): DriveOutcome => ({
    id: s.id,
    from: s.state,
    to: getSubmission(rt.db, s.id)?.state ?? s.state,
    error,
    stop,
  })
  const changed = (): DriveOutcome => out(renew() ? ERROR_STATE_CHANGED : ERROR_LEASE_LOST, !renew())
  const update = (patch: SubmissionPatch): boolean => transition(rt.db, token, s.id, s.state, patch, now())
  const mention = s.reporterId ? `<@${s.reporterId}> ` : ''
  let attempts = s.attempts
  const fail = async (error: string, count = true): Promise<DriveOutcome> => {
    const e = maskSecrets(error)
    const failed = count && attempts >= MAX_ACTION_ATTEMPTS
    if (!update({ lastError: e, ...(failed ? { state: 'failed', failedFrom: s.state } : {}) })) return changed()
    if (failed && s.state === 'creating' && !stopError(e) && renew())
      await postThread(rt.slack, s.channel, s.ts, mention + MSG_FAILED, ctx.deadline)
    return out(e, stopError(e) || Date.now() >= ctx.deadline)
  }
  const countAttempt = (): boolean => {
    attempts++
    return update({ attempts })
  }
  const success = (patch: SubmissionPatch): DriveOutcome =>
    update({ ...patch, attempts: 0, lastError: null }) ? out() : changed()
  const withStatus = (): boolean => getMeta(rt.db, META_LABELS_HASH) === labelsHash()
  // Issue ができたら、ステータスの最初の記録も同じトランザクションで残す（通知はこの記録との差で出す）
  const created = (issue: { url: string; number: number }, backlog: boolean): DriveOutcome =>
    transitionWithStatus(
      rt.db,
      token,
      s.id,
      s.state,
      {
        state: 'notifying',
        issueUrl: issue.url,
        issueNumber: issue.number,
        inflight: null,
        attempts: 0,
        lastError: null,
      },
      {
        issueNumber: issue.number,
        status: backlog ? STATUS_BACKLOG : null,
        state: 'open',
        lastCommentId: 0,
        seenUpdatedAt: null,
        attempts: 0,
      },
      now(),
    )
      ? out()
      : changed()
  if (Date.now() >= ctx.deadline) return out(ERROR_DEADLINE, true)
  if (!renew()) return out(ERROR_LEASE_LOST, true)
  if (s.state === 'creating') {
    if (s.inflight) {
      if (isAlive(s.inflight.owner) || (s.inflight.child && isAlive(s.inflight.child)))
        return fail(ERROR_CREATE_IN_FLIGHT, false)
      const dead = confirmInflightDead(rt.db, token, s.id, now())
      if (!dead) return out(ERROR_LEASE_LOST, true)
      if (ctx.now().getTime() < Date.parse(dead) + CREATE_SETTLE_MS) return fail(ERROR_CREATE_SETTLING, false)
    }
    const viewer = await rt.gh(['api', 'user'], ctx.deadline)
    if (viewer.code !== 0) {
      if (!countAttempt()) return changed()
      return fail(viewer.stderr || 'GitHub の認証を確認できません')
    }
    const login = asString(get(parseJson(viewer.stdout) ?? undefined, 'login'))
    if (!login) {
      if (!countAttempt()) return changed()
      return fail('GitHub のログイン名を読み取れません')
    }
    if (login !== (s.createLogin ?? rt.config.github.login)) return fail(ERROR_GH_ACCOUNT_CHANGED, false)
    if (!countAttempt()) return changed()
    const started = s.createStartedAt ?? now()
    if (!update({ createStartedAt: started, createLogin: s.createLogin ?? rt.config.github.login })) return changed()
    const since = new Date(Date.parse(started) - CREATE_LOOKBACK_MINUTES * 60000).toISOString()
    const found = await findIssueByMarker(
      rt.gh,
      rt.config.repo,
      issueMarker(s.channel, s.ts),
      since,
      login,
      ctx.deadline,
    )
    if (!found.ok) return fail(found.error)
    if (found.issue) return created(found.issue, withStatus())
    if (!s.fields || s.decision?.action !== 'create') return fail('Issue の決定内容がありません')
    let body: string
    try {
      body = buildIssueBody(s, s.decision)
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error))
    }
    if (
      !setInflight(rt.db, token, s.id, { owner: selfIdentity(), child: null, at: now(), deadConfirmedAt: null }, now())
    )
      return out(ERROR_LEASE_LOST, true)
    // pollにも独立したrunディレクトリを割り当て、古い持ち主が新しい本文を消せないようにする。
    const bodyRunId = randomUUID()
    if (registerRun(rt.db, token, bodyRunId, now()) === null) return out(ERROR_LEASE_LOST, true)
    const backlog = withStatus()
    const dir = join(rt.paths.runsDir, bodyRunId)
    const file = join(dir, `issue-${s.id}.md`)
    try {
      writeAtomic(file, body)
      if (!renew()) return out(ERROR_LEASE_LOST, true)
      const title = [...neutralizeMentions(maskSecrets(s.fields.title))]
      const result = await createIssue(
        rt.gh,
        rt.config.repo,
        {
          title:
            title.length > MAX_TITLE_CHARS
              ? title.slice(0, MAX_TITLE_CHARS - 1).join('') + TITLE_ELLIPSIS
              : title.join(''),
          bodyFile: file,
          labels: issueLabels(s.fields, backlog),
        },
        ctx.deadline,
        (child) => setInflightChild(rt.db, s.id, process.pid, child),
      )
      if (!result.ok) return fail(result.error)
      return created(result, backlog)
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error))
    } finally {
      rmSync(dir, { recursive: true, force: true })
      forgetRun(rt.db, bodyRunId)
    }
  }
  if (!DRIVEN_STATES.includes(s.state)) return out()
  if (!countAttempt()) return changed()
  let text = ''
  if (s.state === 'asking') {
    if (s.decision?.action !== 'ask') return fail('質問の決定内容がありません')
    text = `${escapeMrkdwn(s.decision.message)}\n\n${MSG_QUESTION_FOOTER}`
  } else if (s.state === 'notifying') {
    if (!s.issueUrl) return fail('Issue URL がありません')
    text = (s.timedOutAt ? MSG_CREATED_TIMEOUT : MSG_CREATED).replace('{url}', s.issueUrl)
  } else if (s.state === 'rejecting')
    text = MSG_REJECTED.replace('{problems}', escapeMrkdwn(s.problems.join(PROBLEM_SEPARATOR)))
  if (!renew()) return out(ERROR_LEASE_LOST, true)
  const result = await postThread(rt.slack, s.channel, s.ts, mention + text, ctx.deadline)
  if (!result.ok) return fail(result.error)
  return success(
    s.state === 'asking'
      ? { state: 'waiting', rounds: s.rounds + 1, lastQuestionTs: result.ts, askedAt: now(), decision: null }
      : s.state === 'notifying'
        ? { state: 'created' }
        : { state: 'rejected' },
  )
}
export const driveItem = async (ctx: DriveContext, s: Submission): Promise<DriveOutcome[]> => {
  const results: DriveOutcome[] = []
  let current = s
  for (let i = 0; i < 3 && DRIVEN_STATES.includes(current.state); i++) {
    const r = await driveOne(ctx, current)
    results.push(r)
    if (r.error || r.stop) break
    const next = getSubmission(ctx.rt.db, s.id)
    if (!next || next.state === current.state) break
    current = next
  }
  return results
}
export const driveAll = async (ctx: DriveContext): Promise<DriveOutcome[]> => {
  const results: DriveOutcome[] = []
  for (const s of listByStates(ctx.rt.db, DRIVEN_STATES)) {
    const next = await driveItem(ctx, s)
    results.push(...next)
    if (next.some((r) => r.stop)) break
  }
  return results
}
