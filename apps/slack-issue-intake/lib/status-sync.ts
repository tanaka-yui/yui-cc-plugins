import { mentionPrefix } from './config.ts'
import { getIssueStatus, getMeta, inTransaction, leaseValid, saveIssueStatus, setMeta, trackedIssues } from './db.ts'
import {
  ERROR_DEADLINE,
  ERROR_LEASE_LOST,
  ERROR_THREAD_NOT_FOUND,
  ISSUE_SCAN_PER_PAGE,
  META_STATUS_CURSOR,
  SOURCE_LABEL,
  STATUS_CURSOR_OVERLAP_SECONDS,
  STATUS_MAX_ATTEMPTS,
} from './defaults.ts'
import { stopError } from './drive.ts'
import { currentStatus, isTrusted, parseMarker, renderStatusMessage, statusSlug } from './issue-status.ts'
import { asArray, asObject, asString, get, parseJson } from './json.ts'
import { renewLease } from './lease.ts'
import { maskSecrets } from './secrets.ts'
import { postThread } from './slack-api.ts'

import type { IssueStatusRow, TrackedIssue } from './db.ts'
import type { DriveContext } from './drive.ts'
import type { Json } from './json.ts'

export type StatusReport = { notified: number; errors: string[] }
type IssueView = { number: number; url: string; labels: string[]; state: 'open' | 'closed'; updatedAt: string }
type CommentView = { id: number; body: string; authorAssociation: string; login: string }

const readIssue = (value: Json): IssueView | 'pull' | null => {
  const o = asObject(value)
  if (!o || typeof o.number !== 'number' || !asString(o.html_url) || !asString(o.updated_at)) return null
  if (o.pull_request) return 'pull'
  return {
    number: o.number,
    url: String(o.html_url),
    labels: (asArray(o.labels) ?? []).flatMap((l) => asString(get(l, 'name')) ?? []),
    state: o.state === 'closed' ? 'closed' : 'open',
    updatedAt: String(o.updated_at),
  }
}
const readComment = (value: Json): CommentView | null => {
  const o = asObject(value)
  if (!o || typeof o.id !== 'number') return null
  return {
    id: o.id,
    body: asString(o.body) ?? '',
    authorAssociation: asString(o.author_association) ?? '',
    login: asString(get(o, 'user', 'login')) ?? '',
  }
}

// poll の毎回（取り込みのあと）に、from-slack の Issue のステータスと開閉の変化を元のスレッドへ知らせる。Claude は起動しない。
// 一覧は更新日時の昇順に読み、処理し終えた Issue の更新日時まで status_cursor を進める。締め切りで止まれば次の回で続きを読む
export const statusSync = async (ctx: DriveContext): Promise<StatusReport> => {
  const { rt, token } = ctx
  const report: StatusReport = { notified: 0, errors: [] }
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
  const save = (row: IssueStatusRow): boolean => {
    if (saveIssueStatus(rt.db, token, row, now())) return true
    error(ERROR_LEASE_LOST)
    return false
  }
  const advance = (updatedAt: string): boolean => {
    const saved = inTransaction(rt.db, () => {
      if (!leaseValid(rt.db, token, now())) return false
      const cursor = getMeta(rt.db, META_STATUS_CURSOR)
      if (!cursor || Date.parse(updatedAt) > Date.parse(cursor)) setMeta(rt.db, META_STATUS_CURSOR, updatedAt)
      return true
    })
    if (!saved) error(ERROR_LEASE_LOST)
    return saved
  }
  const readComments = async (n: number, since: string | null): Promise<CommentView[] | null> => {
    const all: CommentView[] = []
    for (let page = 1; ; page++) {
      if (!valid()) return null
      const r = await rt.gh(
        [
          'api',
          `repos/${rt.config.repo}/issues/${n}/comments?per_page=${ISSUE_SCAN_PER_PAGE}&page=${page}${since ? `&since=${since}` : ''}`,
        ],
        ctx.deadline,
      )
      if (r.code !== 0) {
        error(r.stderr || 'Issue のコメントを読めません')
        return null
      }
      const items = asArray(parseJson(r.stdout))
      const comments = items?.map(readComment)
      if (!items || !comments || comments.some((c) => !c)) {
        error('Issue のコメントの応答が不正です')
        return null
      }
      all.push(...comments.flatMap((c) => c ?? []))
      if (items.length < ISSUE_SCAN_PER_PAGE) return all
    }
  }
  // 1 件を処理する。false はこの回をここで止める（status_cursor をこの Issue より先へ進めない）
  const handle = async (issue: IssueView, thread: TrackedIssue): Promise<boolean> => {
    const row = getIssueStatus(rt.db, issue.number)
    const to = { status: currentStatus(issue.labels), state: issue.state }
    // 前からある Issue は、最初に見たときは記録するだけで知らせない
    if (!row)
      return save({
        issueNumber: issue.number,
        status: to.status,
        state: to.state,
        lastCommentId: 0,
        seenUpdatedAt: issue.updatedAt,
        attempts: 0,
      })
    if (row.seenUpdatedAt && Date.parse(issue.updatedAt) <= Date.parse(row.seenUpdatedAt)) return true
    const comments = await readComments(issue.number, row.seenUpdatedAt)
    if (!comments) return false
    const fresh = comments.filter((c) => c.id > row.lastCommentId)
    const latest = fresh
      .filter((c) => isTrusted(c, rt.config.github.login))
      .flatMap((c) => {
        const m = parseMarker(c.body)
        return m ? [{ marker: m, body: c.body }] : []
      })
      .at(-1)
    // マーカーは、今のステータスラベルと一致するときだけ「AI が変えた」とみなす
    const matches = latest?.marker.slug === statusSlug(to.status)
    const marker = latest && matches ? { event: latest.marker.event, body: latest.body } : null
    // orca-team-dispatch-task はコメントを書いてからラベルを動かす。その間に読んだときは（ラベルが変わらず、
    // 最新のマーカーがまだ合わない）、何も記録せずに次の回へ回す。seenUpdatedAt を進めないので、ラベルが変わった回に
    // 同じコメントをもう一度読み、AI の変化として知らせる
    if (latest && !matches && row.status === to.status && row.state === to.state) return true
    const next: IssueStatusRow = {
      issueNumber: issue.number,
      status: to.status,
      state: to.state,
      lastCommentId: Math.max(row.lastCommentId, ...fresh.map((c) => c.id)),
      seenUpdatedAt: issue.updatedAt,
      attempts: 0,
    }
    const text = renderStatusMessage(
      { from: { status: row.status, state: row.state }, to, marker },
      issue.url,
      mentionPrefix(rt.config),
    )
    if (!text) return save(next)
    if (!valid()) return false
    const posted = await postThread(rt.slack, thread.channel, thread.ts, text, ctx.deadline)
    if (posted.ok) {
      report.notified++
      return save(next)
    }
    error(posted.error)
    // 元の投稿が消えていれば、知らせるのを諦めて記録を進める
    if (posted.error === ERROR_THREAD_NOT_FOUND) return save(next)
    if (stopError(posted.error)) return false
    const attempts = row.attempts + 1
    if (attempts >= STATUS_MAX_ATTEMPTS) return save(next)
    save({ ...row, attempts })
    return false
  }

  const tracked = trackedIssues(rt.db)
  if (!tracked.size) return report
  const cursor = getMeta(rt.db, META_STATUS_CURSOR)
  const since = cursor ? new Date(Date.parse(cursor) - STATUS_CURSOR_OVERLAP_SECONDS * 1000).toISOString() : null
  for (let page = 1; ; page++) {
    if (!valid()) return report
    const r = await rt.gh(
      [
        'api',
        `repos/${rt.config.repo}/issues?labels=${SOURCE_LABEL}&state=all&sort=updated&direction=asc&per_page=${ISSUE_SCAN_PER_PAGE}&page=${page}${since ? `&since=${since}` : ''}`,
      ],
      ctx.deadline,
    )
    if (r.code !== 0) {
      error(r.stderr || 'Issue 一覧を読めません')
      return report
    }
    const items = asArray(parseJson(r.stdout))
    if (!items) {
      error('Issue 一覧の応答が不正です')
      return report
    }
    for (const value of items) {
      const issue = readIssue(value)
      if (!issue) {
        error('Issue 一覧の項目が不正です')
        return report
      }
      if (issue === 'pull') continue
      const thread = tracked.get(issue.number)
      if (thread && !(await handle(issue, thread))) return report
      if (!advance(issue.updatedAt)) return report
    }
    if (items.length < ISSUE_SCAN_PER_PAGE) return report
  }
}
