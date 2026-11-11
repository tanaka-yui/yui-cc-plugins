import {
  API_BASE_ENV,
  ERROR_DEADLINE,
  ERROR_RATELIMITED,
  FATAL_SLACK_ERRORS,
  FETCH_TIMEOUT_MS,
  HISTORY_PAGE_LIMIT,
  LOOPBACK_HOSTS,
  SLACK_API_BASE,
  SLACK_FILES_ORIGIN,
} from './defaults.ts'
import { asArray, asObject, asString, get, parseJson } from './json.ts'
import { maskSecrets } from './secrets.ts'
import { compareTs } from './slack-text.ts'

import type { JsonObject } from './json.ts'
export type SlackFailure = { ok: false; error: string; retryAfterSeconds: number | null }
export type SlackResult = { ok: true; body: JsonObject } | SlackFailure
export type SlackList = { ok: true; messages: JsonObject[] } | SlackFailure
export type SlackPage = { ok: true; messages: JsonObject[]; hasMore: boolean } | SlackFailure
export type DownloadResult = { ok: true; bytes: Uint8Array } | { ok: false; error: string }
export type SlackClient = {
  call: (method: string, params: Record<string, string>, deadline: number) => Promise<SlackResult>
  download: (url: string, maxBytes: number, deadline: number) => Promise<DownloadResult>
}
export const slackApiBase = (): string => {
  try {
    const url = new URL(process.env[API_BASE_ENV] ?? '')
    if (
      LOOPBACK_HOSTS.includes(url.hostname) &&
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password
    )
      return url.href.replace(/\/$/, '')
  } catch {
    /* 差し替えが不正なら本番のAPIを使う */
  }
  return SLACK_API_BASE
}
export const tokenAllowedFor = (url: string): boolean => {
  try {
    const target = new URL(url)
    return (
      !target.username &&
      !target.password &&
      (target.origin === SLACK_FILES_ORIGIN || target.origin === new URL(slackApiBase()).origin)
    )
  } catch {
    return false
  }
}
export const isFatalSlackError = (error: string): boolean => FATAL_SLACK_ERRORS.includes(error)
const failure = (error: string, retryAfterSeconds: number | null = null): SlackFailure => ({
  ok: false,
  error: maskSecrets(error),
  retryAfterSeconds,
})
export const createSlackClient = (token: string): SlackClient => {
  // 429・締め切り・致命的エラーのあとは、この回の外部通信をすべて止める。
  let stopped: SlackFailure | null = null
  const remember = (r: SlackFailure): SlackFailure => {
    if (r.error === ERROR_RATELIMITED || r.error === ERROR_DEADLINE || isFatalSlackError(r.error)) stopped = r
    return r
  }
  const networkFailure = (error: Error | string, deadline: number): SlackFailure =>
    remember(failure(Date.now() >= deadline ? ERROR_DEADLINE : `network: ${String(error)}`))
  return {
    call: async (method, params, deadline) => {
      if (stopped) return stopped
      const remaining = deadline - Date.now()
      if (remaining <= 0) return remember(failure(ERROR_DEADLINE))
      const signal = AbortSignal.timeout(Math.min(FETCH_TIMEOUT_MS, remaining))
      try {
        const response = await fetch(`${slackApiBase()}/${method}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(params),
          signal,
          redirect: 'error',
        })
        if (response.status === 429) {
          const n = Number(response.headers.get('retry-after'))
          return remember(failure(ERROR_RATELIMITED, Number.isFinite(n) ? n : null))
        }
        if (!response.ok) return failure(`http: ${response.status}`)
        const body = asObject(parseJson(await response.text()))
        if (!body) return failure('応答をJSONとして読めません')
        if (body.ok !== true) return remember(failure(asString(body.error) ?? 'Slack API の応答が不正です'))
        return { ok: true, body }
      } catch (error) {
        return networkFailure(
          signal.aborted ? 'timeout' : error instanceof Error ? error.message : String(error),
          deadline,
        )
      }
    },
    download: async (url, maxBytes, deadline) => {
      if (!tokenAllowedFor(url)) return { ok: false, error: 'host_not_allowed' }
      if (stopped) return stopped
      const remaining = deadline - Date.now()
      if (remaining <= 0) return remember(failure(ERROR_DEADLINE))
      const signal = AbortSignal.timeout(Math.min(FETCH_TIMEOUT_MS, remaining))
      try {
        // リダイレクト先へ認証情報を送らない。
        const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal, redirect: 'error' })
        if (response.status === 429)
          return remember(failure(ERROR_RATELIMITED, Number(response.headers.get('retry-after')) || null))
        if (!response.ok) return { ok: false, error: `http: ${response.status}` }
        if (Number(response.headers.get('content-length')) > maxBytes) {
          await response.body?.cancel()
          return { ok: false, error: 'too_large' }
        }
        const reader = response.body?.getReader()
        if (!reader) return { ok: true, bytes: new Uint8Array() }
        const parts: Uint8Array[] = []
        let total = 0
        for (;;) {
          const next = await reader.read()
          if (next.done) break
          total += next.value.length
          if (total > maxBytes) {
            await reader.cancel()
            return { ok: false, error: 'too_large' }
          }
          parts.push(next.value)
        }
        const bytes = new Uint8Array(total)
        let at = 0
        for (const part of parts) {
          bytes.set(part, at)
          at += part.length
        }
        return { ok: true, bytes }
      } catch (error) {
        return networkFailure(
          signal.aborted ? 'timeout' : error instanceof Error ? error.message : String(error),
          deadline,
        )
      }
    },
  }
}
const messages = (body: JsonObject): JsonObject[] =>
  (asArray(body.messages) ?? []).flatMap((v) => {
    const o = asObject(v)
    return o ? [o] : []
  })
export type AuthInfo = { userId: string; botId: string; teamId: string; teamUrl: string; team: string }
export const authTest = async (
  c: SlackClient,
  deadline: number,
): Promise<{ ok: true; info: AuthInfo } | SlackFailure> => {
  const r = await c.call('auth.test', {}, deadline)
  if (!r.ok) return r
  const b = r.body
  if (!asString(b.user_id) || !asString(b.bot_id) || !asString(b.team_id) || !asString(b.url))
    return failure('Slack の認証情報が不正です')
  return {
    ok: true,
    info: {
      userId: String(b.user_id),
      botId: String(b.bot_id),
      teamId: String(b.team_id),
      teamUrl: String(b.url),
      team: asString(b.team) ?? '',
    },
  }
}
export const fetchLatest = async (
  c: SlackClient,
  channel: string,
  limit: number,
  deadline: number,
): Promise<SlackList> => {
  const r = await c.call('conversations.history', { channel, limit: String(limit) }, deadline)
  return r.ok ? { ok: true, messages: messages(r.body) } : r
}
export const fetchHistoryPage = async (
  c: SlackClient,
  channel: string,
  oldest: string,
  latest: string,
  inclusive: boolean,
  deadline: number,
): Promise<SlackPage> => {
  const r = await c.call(
    'conversations.history',
    { channel, oldest, latest, inclusive: String(inclusive), limit: String(HISTORY_PAGE_LIMIT) },
    deadline,
  )
  return r.ok
    ? {
        ok: true,
        messages: messages(r.body).sort((a, b) => compareTs(String(b.ts), String(a.ts))),
        hasMore: r.body.has_more === true,
      }
    : r
}
export const fetchReplies = async (
  c: SlackClient,
  channel: string,
  threadTs: string,
  after: string | null,
  deadline: number,
): Promise<SlackList> => {
  const all: JsonObject[] = []
  let cursor = ''
  const seen = new Set<string>()
  do {
    if (Date.now() >= deadline) return failure(ERROR_DEADLINE)
    const r = await c.call(
      'conversations.replies',
      { channel, ts: threadTs, limit: String(HISTORY_PAGE_LIMIT), ...(cursor ? { cursor } : {}) },
      deadline,
    )
    if (!r.ok) return r
    all.push(...messages(r.body))
    cursor = asString(get(r.body, 'response_metadata', 'next_cursor')) ?? ''
    if (cursor && seen.has(cursor)) return failure('ページの続きが進みません')
    seen.add(cursor)
  } while (cursor)
  return {
    ok: true,
    messages: all
      .filter(
        (m) =>
          asString(m.ts) &&
          compareTs(String(m.ts), threadTs) !== 0 &&
          (after === null || compareTs(String(m.ts), after) > 0),
      )
      .sort((a, b) => compareTs(String(a.ts), String(b.ts))),
  }
}
export const postThread = async (
  c: SlackClient,
  channel: string,
  threadTs: string,
  text: string,
  deadline: number,
): Promise<{ ok: true; ts: string } | SlackFailure> => {
  const r = await c.call(
    'chat.postMessage',
    { channel, thread_ts: threadTs, text: maskSecrets(text), unfurl_links: 'false', unfurl_media: 'false' },
    deadline,
  )
  return r.ok ? (asString(r.body.ts) ? { ok: true, ts: String(r.body.ts) } : failure('投稿の時刻がありません')) : r
}
export const fileInfo = async (c: SlackClient, fileId: string, deadline: number): Promise<JsonObject | null> => {
  const r = await c.call('files.info', { file: fileId }, deadline)
  return r.ok ? asObject(r.body.file) : null
}
export const userInfoName = async (c: SlackClient, userId: string, deadline: number): Promise<string | null> => {
  const r = await c.call('users.info', { user: userId }, deadline)
  if (!r.ok) return null
  for (const value of [
    get(r.body, 'user', 'profile', 'display_name'),
    get(r.body, 'user', 'profile', 'real_name'),
    get(r.body, 'user', 'name'),
  ])
    if (typeof value === 'string' && value.trim()) return maskSecrets(value.trim())
  return null
}
