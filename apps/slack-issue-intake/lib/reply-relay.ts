import { cachedUserName, getIssueStatus, getReplyRelay, saveReplyRelay, saveUserName, trackedIssues } from './db.ts'
import {
  ERROR_DEADLINE,
  ERROR_LEASE_LOST,
  ERROR_THREAD_NOT_FOUND,
  ISSUE_SCAN_PER_PAGE,
  LEARN_HUMAN_SUBTYPES,
  REPLY_MARKER_PREFIX,
  REPLY_NAME_MAX_CHARS,
  REPLY_RELAY_MAX_CHARS,
  REPLY_RELAY_THREADS_PER_POLL,
  REPLY_TEXT,
  STATUS_MAX_ATTEMPTS,
  STATUS_MIN_REMAINING_MS,
} from './defaults.ts'
import { stopError } from './drive.ts'
import { fenced, neutralizeMentions, truncate } from './issue-body.ts'
import { asArray, asObject, asString, get, parseJson } from './json.ts'
import { renewLease } from './lease.ts'
import { maskSecrets } from './secrets.ts'
import { fetchReplies, postThread, userInfoName } from './slack-api.ts'
import { formatTs, messagePermalink, messageText } from './slack-text.ts'

import type { ReplyRelayRow, TrackedIssue } from './db.ts'
import type { DriveContext } from './drive.ts'
import type { JsonObject } from './json.ts'

export type RelayReport = { relayed: number; errors: string[] }
const fill = (template: string, values: Record<string, string | number>): string =>
  template.replace(/\{(\w+)\}/g, (whole, key: string) => String(values[key] ?? whole))
// 見出しの投稿者名。Slack の表示名は誰でも決められるので、改行を消し、Markdown と HTML の記号を無効にして短くする
const headingName = (text: string): string =>
  neutralizeMentions(maskSecrets(text))
    .replace(/[\r\n]+/g, ' ')
    .slice(0, REPLY_NAME_MAX_CHARS)
    .replace(/[\\`*_[\]()<>#!|~]/g, '\\$&')
export const replyMarker = (channel: string, ts: string): string => `<!-- ${REPLY_MARKER_PREFIX}:${channel}:${ts} -->`

// poll の毎回（取り込みと通知のあと）、開いている Issue のスレッドで、人がボットにメンションした返信を Issue のコメントへ
// 転記する。Claude は起動しない。初めて見たスレッドは今の時刻を読み取り位置にするだけで、前からある返信は転記しない。
// 書く前に書き始めた返信を記録し、応答が届かずに書けたか分からないときは、次の回に Issue のコメントの印を探してから書く
export const relayReplies = async (ctx: DriveContext): Promise<RelayReport> => {
  const { rt, token } = ctx
  const report: RelayReport = { relayed: 0, errors: [] }
  const now = (): string => ctx.now().toISOString()
  const error = (e: string): void => {
    report.errors.push(maskSecrets(e))
  }
  const short = (): boolean => ctx.deadline - Date.now() < STATUS_MIN_REMAINING_MS
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
  const save = (row: ReplyRelayRow): boolean => {
    if (saveReplyRelay(rt.db, token, row, now())) return true
    error(ERROR_LEASE_LOST)
    return false
  }
  const bot = rt.config.slack.botUserId
  const botMention = new RegExp(`<@${bot}(?:\\|[^>]+)?>`, 'g')
  // 人がボットにメンションした返信か（ボット・連携の投稿と、メンションの無い相づちは転記しない）。
  // チャンネルにも送った返信（thread_broadcast）も人の返信。ほかのワークスペースの人（Slack コネクトなど）の返信は
  // 転記しない（Issue を起票できるのと同じ、このワークスペースのチャンネルのメンバーだけ）
  const request = (m: JsonObject): boolean =>
    asString(m.user) !== null &&
    [asString(m.team), asString(m.user_team)].every((team) => team === null || team === rt.config.slack.teamId) &&
    m.bot_id === undefined &&
    (asString(m.subtype) === null || LEARN_HUMAN_SUBTYPES.includes(asString(m.subtype) ?? '')) &&
    (asString(m.text) ?? '').match(botMention) !== null

  const name = async (id: string): Promise<string | null> => {
    const cached = cachedUserName(rt.db, id, now())
    if (cached) return cached
    const fetched = await userInfoName(rt.slack, id, ctx.deadline)
    if (!fetched.ok) return null
    if (fetched.name) saveUserName(rt.db, id, fetched.name, now())
    return fetched.name
  }
  const commentBody = async (thread: TrackedIssue, m: JsonObject): Promise<string> => {
    const ts = String(m.ts)
    let text = messageText(m).text.replace(botMention, '').trim()
    for (const match of text.matchAll(/<@(U[A-Z0-9]+)(?:\|[^>]+)?>/g)) {
      const id = match[1] ?? ''
      text = text.replaceAll(match[0], `@${(await name(id)) ?? id}`)
    }
    const author = asString(m.user)
    const files = asArray(m.files)?.length ?? 0
    const link = `${messagePermalink(rt.config.slack.teamUrl, thread.channel, ts)}?thread_ts=${thread.ts}&cid=${thread.channel}`
    return [
      fill(REPLY_TEXT.heading, {
        name: headingName((author && (await name(author))) ?? REPLY_TEXT.unknownName),
        link,
      }),
      '',
      fenced(truncate(maskSecrets(text), REPLY_RELAY_MAX_CHARS)),
      ...(files ? ['', fill(REPLY_TEXT.files, { count: files })] : []),
      '',
      replyMarker(thread.channel, ts),
    ].join('\n')
  }
  // 書き始めた返信の印が Issue のコメントにあるか（自分の gh のアカウントが書いたものだけ）。読めなければ null
  const relayedBefore = async (thread: TrackedIssue, marker: string, since: string | null): Promise<boolean | null> => {
    for (let page = 1; ; page++) {
      if (!valid()) return null
      const r = await rt.gh(
        [
          'api',
          `repos/${thread.repo}/issues/${thread.number}/comments?per_page=${ISSUE_SCAN_PER_PAGE}&page=${page}${since ? `&since=${since}` : ''}`,
        ],
        ctx.deadline,
      )
      const items = r.code === 0 ? asArray(parseJson(r.stdout)) : null
      if (!items) {
        error(r.stderr || REPLY_TEXT.commentFailed)
        return null
      }
      if (
        items.some(
          (c) =>
            asString(get(c, 'user', 'login')) === rt.config.github.login &&
            (asString(asObject(c)?.body) ?? '').trimEnd().split('\n').at(-1) === marker,
        )
      )
        return true
      if (items.length < ISSUE_SCAN_PER_PAGE) return false
    }
  }
  // 1 件を転記する。返すのは進めた行、'later' はこのスレッドを次の回に回す、'stop' はこの回をやめる
  const relayOne = async (thread: TrackedIssue, m: JsonObject, row: ReplyRelayRow) => {
    const ts = String(m.ts)
    const marker = replyMarker(thread.channel, ts)
    const done: ReplyRelayRow = { ...row, afterTs: ts, pendingTs: null, pendingAt: null, attempts: 0 }
    let pending = row
    if (row.pendingTs === ts) {
      const found = await relayedBefore(thread, marker, row.pendingAt)
      if (found === null) return 'later'
      if (found) return save(done) ? done : 'stop'
    } else {
      pending = { ...row, pendingTs: ts, pendingAt: now(), attempts: 0 }
      if (!save(pending)) return 'stop'
    }
    const body = await commentBody(thread, m)
    if (!valid()) return 'stop'
    const r = await rt.gh(
      ['issue', 'comment', String(thread.number), '--repo', thread.repo, '--body', body],
      ctx.deadline,
    )
    if (r.code !== 0) {
      error(r.stderr || REPLY_TEXT.commentFailed)
      if (stopError(r.stderr)) return 'stop'
      const attempts = pending.attempts + 1
      // 決まった回数で諦めて次の返信へ進む（同じ返信で止まり続けない）
      if (attempts >= STATUS_MAX_ATTEMPTS) return save(done) ? done : 'stop'
      return save({ ...pending, attempts }) ? 'later' : 'stop'
    }
    if (!save(done)) return 'stop'
    report.relayed++
    // 知らせられなくても転記はやり直さない
    if (valid()) {
      const posted = await postThread(
        rt.slack,
        thread.channel,
        thread.ts,
        fill(REPLY_TEXT.relayed, { url: r.stdout.trim() }),
        ctx.deadline,
      )
      if (!posted.ok) error(posted.error)
    }
    return done
  }

  // 開いている Issue のスレッド。初めて見たものは今を読み取り位置にして記録だけする
  const start = formatTs(Math.floor(ctx.now().getTime() / 1000))
  const rows: Array<{ thread: TrackedIssue; row: ReplyRelayRow }> = []
  for (const thread of trackedIssues(rt.db, rt.config.defaultRepo).values()) {
    if (getIssueStatus(rt.db, thread.repo, thread.number)?.state !== 'open') continue
    const row = getReplyRelay(rt.db, thread.repo, thread.number)
    if (row) {
      if (!row.gone) rows.push({ thread, row })
      continue
    }
    if (
      !save({
        repo: thread.repo,
        issueNumber: thread.number,
        afterTs: start,
        pendingTs: null,
        pendingAt: null,
        attempts: 0,
        checkedAt: now(),
        gone: false,
      })
    )
      return report
  }
  // 書きかけのスレッドを先に、あとはしばらく読んでいない順
  rows.sort(
    (a, b) =>
      Number(b.row.pendingTs !== null) - Number(a.row.pendingTs !== null) ||
      a.row.checkedAt.localeCompare(b.row.checkedAt),
  )
  for (const { thread, row } of rows.slice(0, REPLY_RELAY_THREADS_PER_POLL)) {
    if (short()) return report
    if (!valid()) return report
    const r = await fetchReplies(rt.slack, thread.channel, thread.ts, row.afterTs, ctx.deadline)
    if (!r.ok) {
      // 消された投稿は諦める（毎回 errors に出し続けない）
      if (r.error === ERROR_THREAD_NOT_FOUND) {
        if (!save({ ...row, gone: true, checkedAt: now() })) return report
        continue
      }
      error(r.error)
      if (stopError(r.error)) return report
      if (!save({ ...row, checkedAt: now() })) return report
      continue
    }
    let current = row
    for (const m of r.messages) {
      if (!request(m)) {
        current = { ...current, afterTs: String(m.ts) }
        continue
      }
      const next = await relayOne(thread, m, current)
      if (next === 'stop') return report
      if (next === 'later') {
        current = getReplyRelay(rt.db, thread.repo, thread.number) ?? current
        break
      }
      current = next
    }
    if (!save({ ...current, checkedAt: now() })) return report
  }
  return report
}
