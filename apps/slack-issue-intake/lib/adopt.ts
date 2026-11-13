import {
  advanceCursor,
  getAdopted,
  getMeta,
  insertAdopted,
  issueKey,
  markAdoptedLabeled,
  markAdoptedTried,
  pendingAdopted,
  recordAdopted,
  unlabeledAdopted,
  writeMetaFenced,
} from './db.ts'
import {
  ADOPT_MAX_PER_POLL,
  ADOPT_SWEEP_RESERVED,
  ADOPTED_CLOSED_NOTE,
  ADOPTED_LABEL,
  adoptAfterKey,
  adoptCursorKey,
  adoptSweepKey,
  ERROR_DEADLINE,
  ERROR_LEASE_LOST,
  ISSUE_SCAN_PER_PAGE,
  META_ADOPT_ROTATION,
  MSG_ADOPTED,
  MSG_STATUS_NONE,
  SOURCE_LABEL,
  STATUS_CURSOR_OVERLAP_SECONDS,
} from './defaults.ts'
import { stopError } from './drive.ts'
import { currentStatus } from './issue-status.ts'
import { asArray, asObject, asString, get, parseJson } from './json.ts'
import { renewLease } from './lease.ts'
import { maskSecrets } from './secrets.ts'
import { postMessage } from './slack-api.ts'
import { escapeMrkdwn } from './slack-text.ts'

import type { DriveContext } from './drive.ts'
import type { Json } from './json.ts'

export type AdoptReport = { adopted: number; errors: string[] }
type Issue = {
  number: number
  title: string
  url: string
  createdAt: string
  updatedAt: string
  labels: string[]
  state: 'open' | 'closed'
  pull: boolean
}
const readIssue = (value: Json): Issue | null => {
  const o = asObject(value)
  if (
    !o ||
    typeof o.number !== 'number' ||
    !asString(o.html_url) ||
    typeof o.title !== 'string' ||
    !asString(o.created_at) ||
    !asString(o.updated_at)
  )
    return null
  return {
    number: o.number,
    title: o.title,
    url: String(o.html_url),
    createdAt: String(o.created_at),
    updatedAt: String(o.updated_at),
    labels: (asArray(o.labels) ?? []).flatMap((l) => asString(get(l, 'name')) ?? []),
    state: o.state === 'closed' ? 'closed' : 'open',
    pull: Boolean(o.pull_request),
  }
}
export const adoptExisting = async (ctx: DriveContext): Promise<AdoptReport> => {
  const { rt, token } = ctx
  const report: AdoptReport = { adopted: 0, errors: [] }
  const error = (e: string): void => {
    report.errors.push(maskSecrets(e))
  }
  const now = (): string => ctx.now().toISOString()
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
  const fenced = (ok: boolean): boolean => {
    if (!ok) error(ERROR_LEASE_LOST)
    return ok
  }
  const seen = new Map<string, Issue>()
  const repos = rt.config.repos.filter((r) => r.existing === 'thread')
  let inserted = 0
  if (repos.length) {
    const rotation = Number(getMeta(rt.db, META_ADOPT_ROTATION) ?? '0')
    const start = Number.isInteger(rotation) && rotation >= 0 ? rotation % repos.length : 0
    const ordered = [...repos.slice(start), ...repos.slice(0, start)]
    if (
      !valid() ||
      !fenced(writeMetaFenced(rt.db, token, now(), { [META_ADOPT_ROTATION]: String((start + 1) % repos.length) }))
    )
      return report
    const after = new Map<string, string>()
    for (const repo of ordered) {
      const key = adoptAfterKey(repo.name)
      let at = getMeta(rt.db, key)
      if (!at) {
        at = now()
        if (!fenced(writeMetaFenced(rt.db, token, now(), { [key]: at }))) return report
      }
      after.set(repo.name, at)
    }
    const consider = (repo: string, issue: Issue, limit: number): 'ok' | 'limit' | 'lost' => {
      seen.set(issueKey(repo, issue.number), issue)
      const labels = issue.labels.map((l) => l.toLowerCase())
      if (
        issue.pull ||
        labels.includes(SOURCE_LABEL) ||
        getAdopted(rt.db, repo, issue.number) ||
        labels.includes(ADOPTED_LABEL)
      )
        return 'ok'
      if (!(Date.parse(issue.createdAt) > Date.parse(after.get(repo) ?? '') || currentStatus(issue.labels) !== null))
        return 'ok'
      if (inserted >= limit) return 'limit'
      if (
        !fenced(
          insertAdopted(
            rt.db,
            token,
            {
              repo,
              issueNumber: issue.number,
              channel: rt.config.channel,
              title: maskSecrets(issue.title),
              url: issue.url,
            },
            now(),
          ),
        )
      )
        return 'lost'
      inserted++
      return 'ok'
    }
    incremental: for (const repo of ordered) {
      const key = adoptCursorKey(repo.name)
      const cursor = getMeta(rt.db, key)
      const since = cursor ? new Date(Date.parse(cursor) - STATUS_CURSOR_OVERLAP_SECONDS * 1000).toISOString() : null
      for (let page = 1; ; page++) {
        if (!valid()) return report
        const r = await rt.gh(
          [
            'api',
            `repos/${repo.name}/issues?state=open&sort=updated&direction=asc&per_page=${ISSUE_SCAN_PER_PAGE}&page=${page}${since ? `&since=${since}` : ''}`,
          ],
          ctx.deadline,
        )
        const values = r.code === 0 ? asArray(parseJson(r.stdout)) : null
        if (!values) {
          error(r.stderr || 'Issue 一覧の応答が不正です')
          break
        }
        for (const value of values) {
          const issue = readIssue(value)
          if (!issue) {
            error('Issue 一覧の項目が不正です')
            continue incremental
          }
          const result = consider(repo.name, issue, ADOPT_MAX_PER_POLL - ADOPT_SWEEP_RESERVED)
          if (result === 'lost') return report
          if (result === 'limit') break incremental
          if (!fenced(advanceCursor(rt.db, token, key, issue.updatedAt, now()))) return report
        }
        if (values.length < ISSUE_SCAN_PER_PAGE) break
      }
    }
    sweep: for (const repo of ordered) {
      if (inserted >= ADOPT_MAX_PER_POLL) break
      const key = adoptSweepKey(repo.name)
      const stored = Number(getMeta(rt.db, key) ?? '1')
      const page = Number.isInteger(stored) && stored > 0 ? stored : 1
      if (!valid()) return report
      const r = await rt.gh(
        [
          'api',
          `repos/${repo.name}/issues?state=open&sort=created&direction=asc&per_page=${ISSUE_SCAN_PER_PAGE}&page=${page}`,
        ],
        ctx.deadline,
      )
      const values = r.code === 0 ? asArray(parseJson(r.stdout)) : null
      if (!values) {
        error(r.stderr || 'Issue 一覧の応答が不正です')
        continue
      }
      for (const value of values) {
        const issue = readIssue(value)
        if (!issue) {
          error('Issue 一覧の項目が不正です')
          continue sweep
        }
        const result = consider(repo.name, issue, ADOPT_MAX_PER_POLL)
        if (result === 'lost') return report
        if (result === 'limit') break sweep
      }
      if (
        !fenced(
          writeMetaFenced(rt.db, token, now(), { [key]: String(values.length < ISSUE_SCAN_PER_PAGE ? 1 : page + 1) }),
        )
      )
        return report
    }
  }
  for (const row of pendingAdopted(rt.db).slice(0, ADOPT_MAX_PER_POLL)) {
    if (!valid() || !fenced(markAdoptedTried(rt.db, token, row.repo, row.issueNumber, now()))) return report
    let issue = seen.get(issueKey(row.repo, row.issueNumber))
    if (!issue) {
      if (!valid()) return report
      const r = await rt.gh(['api', `repos/${row.repo}/issues/${row.issueNumber}`], ctx.deadline)
      issue = (r.code === 0 ? readIssue(parseJson(r.stdout) ?? null) : null) ?? undefined
      if (!issue) {
        error(r.stderr || 'Issue を読めません')
        continue
      }
    }
    const status =
      (currentStatus(issue.labels) ?? MSG_STATUS_NONE) + (issue.state === 'closed' ? ADOPTED_CLOSED_NOTE : '')
    const text = MSG_ADOPTED.replace('{repo}', row.repo)
      .replace('{number}', String(row.issueNumber))
      .replace('{title}', escapeMrkdwn(maskSecrets(issue.title)))
      .replace('{url}', issue.url)
      .replace('{status}', status)
    if (!valid()) return report
    const posted = await postMessage(rt.slack, row.channel, text, ctx.deadline)
    if (!posted.ok) {
      error(posted.error)
      if (stopError(posted.error)) return report
      continue
    }
    if (
      !fenced(
        recordAdopted(
          rt.db,
          token,
          row.repo,
          row.issueNumber,
          posted.ts,
          {
            repo: row.repo,
            issueNumber: row.issueNumber,
            status: currentStatus(issue.labels),
            state: issue.state,
            lastCommentId: 0,
            seenUpdatedAt: issue.updatedAt,
            attempts: 0,
          },
          now(),
        ),
      )
    )
      return report
    report.adopted++
  }
  for (const row of unlabeledAdopted(rt.db).slice(0, ADOPT_MAX_PER_POLL)) {
    if (!valid() || !fenced(markAdoptedTried(rt.db, token, row.repo, row.issueNumber, now()))) return report
    const r = await rt.gh(
      ['issue', 'edit', String(row.issueNumber), '--repo', row.repo, '--add-label', ADOPTED_LABEL],
      ctx.deadline,
    )
    if (r.code !== 0) {
      error(r.stderr || 'Issue のラベルを付けられません')
      continue
    }
    if (!fenced(markAdoptedLabeled(rt.db, token, row.repo, row.issueNumber, now()))) return report
  }
  return report
}
