import {
  AGENT_STATES,
  completeSlice,
  getMeta,
  getScan,
  insertSubmission,
  inTransaction,
  leaseValid,
  listByStates,
  saveScan,
  transition,
} from './db.ts'
import {
  ANSWER_TIMEOUT_HOURS,
  ERROR_DEADLINE,
  ERROR_LEASE_LOST,
  ERROR_THREAD_NOT_FOUND,
  HISTORY_LAG_SECONDS,
  HISTORY_SLICE_SECONDS,
} from './defaults.ts'
import { driveAll, stopError } from './drive.ts'
import { asString } from './json.ts'
import { renewLease } from './lease.ts'
import { parseSubmission } from './parse.ts'
import { maskSecrets } from './secrets.ts'
import { fetchHistoryPage, fetchReplies, isFatalSlackError } from './slack-api.ts'
import { compareTs, formatTs, messagePermalink, messageText, tsMicro } from './slack-text.ts'

import type { DriveContext, DriveOutcome } from './drive.ts'
export type SyncReport = {
  inserted: number
  rejected: number
  answered: number
  timedOut: number
  failed: number
  driven: DriveOutcome[]
  errors: string[]
  fatal: string | null
  partial: boolean
  leaseLost: boolean
}
export const agentWorkCount = (db: DriveContext['rt']['db']): number => listByStates(db, AGENT_STATES).length
export const sync = async (ctx: DriveContext): Promise<SyncReport> => {
  const { rt, token } = ctx
  const report: SyncReport = {
    inserted: 0,
    rejected: 0,
    answered: 0,
    timedOut: 0,
    failed: 0,
    driven: [],
    errors: [],
    fatal: null,
    partial: false,
    leaseLost: false,
  }
  const error = (e: string): boolean => {
    report.errors.push(maskSecrets(e))
    report.partial = true
    if (isFatalSlackError(e)) report.fatal = e
    if (e === ERROR_LEASE_LOST) report.leaseLost = true
    return stopError(e)
  }
  const valid = (): boolean => {
    if (Date.now() >= ctx.deadline) {
      error(ERROR_DEADLINE)
      return false
    }
    if (!renewLease(rt.db, token, ctx.now(), ctx.ttlMs)) {
      error(ERROR_LEASE_LOST)
      return false
    }
    return true
  }
  for (;;) {
    if (!valid()) return report
    let scan = getScan(rt.db)
    if (!scan) {
      const cursor = getMeta(rt.db, 'cursor_ts') ?? formatTs(Math.floor(ctx.now().getTime() / 1000))
      const horizon = Math.floor(ctx.now().getTime() / 1000) - HISTORY_LAG_SECONDS
      if (compareTs(cursor, formatTs(horizon)) >= 0) break
      scan = {
        sliceOldest: cursor,
        sliceLatest: formatTs(Math.min(Math.floor(tsMicro(cursor) / 1000000) + HISTORY_SLICE_SECONDS, horizon)),
        resumeLatest: null,
      }
      if (!saveScan(rt.db, token, scan, ctx.now().toISOString())) {
        error(ERROR_LEASE_LOST)
        return report
      }
    }
    const page = await fetchHistoryPage(
      rt.slack,
      rt.config.channel,
      scan.sliceOldest,
      scan.resumeLatest ?? scan.sliceLatest,
      scan.resumeLatest === null,
      ctx.deadline,
    )
    if (!page.ok) {
      if (error(page.error)) return report
      break
    }
    if (!valid()) return report
    // ページの挿入もリースを確認したトランザクション内で行う。
    const inserted = inTransaction(rt.db, () => {
      if (!leaseValid(rt.db, token, ctx.now().toISOString())) return false
      for (const m of page.messages) {
        const ts = asString(m.ts)
        if (!ts || compareTs(ts, getMeta(rt.db, 'accept_after_ts') ?? '0') <= 0) continue
        const subtype = asString(m.subtype)
        if (subtype && !['bot_message', 'thread_broadcast', 'file_share'].includes(subtype)) continue
        // form --manifest のワークフローは自分のボットとして投稿する。自分の投稿はマーカーで始まるものだけを受け付け、
        // 起票者は本文のメンションだけから取る（ボット自身を起票者にしない）。自分の返信は常にスレッド内なので履歴に出ない
        const own = m.user === rt.config.slack.botUserId || m.bot_id === rt.config.slack.botId
        const parsed = parseSubmission(messageText(m).text, own ? null : asString(m.user))
        if (parsed.kind === 'not-submission') continue
        const id = insertSubmission(
          rt.db,
          {
            channel: rt.config.channel,
            ts,
            permalink: messagePermalink(rt.config.slack.teamUrl, rt.config.channel, ts),
            raw: m,
            fields: parsed.kind === 'ok' ? parsed.fields : null,
            problems: parsed.kind === 'invalid' ? parsed.problems : [],
            reporterId: parsed.kind === 'ok' ? parsed.fields.reporterId : parsed.reporterId,
            state: parsed.kind === 'ok' ? 'new' : 'rejecting',
          },
          ctx.now().toISOString(),
        )
        if (id) {
          if (parsed.kind === 'ok') report.inserted++
          else report.rejected++
        }
      }
      return true
    })
    if (!inserted) {
      error(ERROR_LEASE_LOST)
      return report
    }
    if (page.hasMore) {
      const oldest = page.messages.at(-1)
      const resume = oldest ? asString(oldest.ts) : null
      if (!resume || compareTs(resume, scan.resumeLatest ?? scan.sliceLatest) >= 0) {
        error('履歴のページが進みません')
        break
      }
      if (!saveScan(rt.db, token, { ...scan, resumeLatest: resume }, ctx.now().toISOString())) {
        error(ERROR_LEASE_LOST)
        return report
      }
    } else if (!completeSlice(rt.db, token, scan.sliceLatest, ctx.now().toISOString())) {
      error(ERROR_LEASE_LOST)
      return report
    }
  }
  for (const s of listByStates(rt.db, ['waiting'])) {
    if (!valid()) return report
    const replies = await fetchReplies(rt.slack, s.channel, s.ts, s.lastQuestionTs, ctx.deadline)
    if (!replies.ok) {
      if (replies.error === ERROR_THREAD_NOT_FOUND) {
        if (
          !transition(
            rt.db,
            token,
            s.id,
            'waiting',
            { state: 'failed', failedFrom: 'waiting', lastError: ERROR_THREAD_NOT_FOUND },
            ctx.now().toISOString(),
          )
        ) {
          error(ERROR_LEASE_LOST)
          return report
        }
        report.failed++
        continue
      }
      if (error(replies.error)) return report
      continue
    }
    const human = replies.messages.some((m) => !m.bot_id && asString(m.user) && m.user !== rt.config.slack.botUserId)
    const timeout = !human && s.askedAt && Date.parse(s.askedAt) + ANSWER_TIMEOUT_HOURS * 3600000 <= ctx.now().getTime()
    if (human || timeout) {
      if (
        !transition(
          rt.db,
          token,
          s.id,
          'waiting',
          human ? { state: 'answered' } : { state: 'timed_out', timedOutAt: ctx.now().toISOString() },
          ctx.now().toISOString(),
        )
      ) {
        error(ERROR_LEASE_LOST)
        return report
      }
      if (human) report.answered++
      else report.timedOut++
    }
  }
  if (!valid()) return report
  report.driven = await driveAll(ctx)
  for (const d of report.driven) if (d.error) error(d.error)
  return report
}
