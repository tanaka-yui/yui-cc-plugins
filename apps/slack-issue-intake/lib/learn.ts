import { repoSetting } from './config.ts'
import { getMeta, writeMetaFenced } from './db.ts'
import {
  DAY_MS,
  ERROR_DEADLINE,
  ERROR_LEASE_LOST,
  LEARN_CANCEL_PATTERN,
  LEARN_CANCEL_WINDOW_DAYS,
  LEARN_CANCELLABLE_KINDS,
  LEARN_CANCELS_FILE,
  LEARN_DIRECTIONS,
  LEARN_EVIDENCE_PATTERN,
  LEARN_FILE_VERSION,
  LEARN_NOTICE_KINDS,
  LEARN_NOTICES_PATH,
  LEARN_POSTS_PER_POLL,
  LEARN_TEXT,
  LEARN_THREADS_MAX,
  LEARN_URL_PREFIX,
  META_LEARN_LAST_ID,
  META_LEARN_POSTS,
  STATUS_MIN_REMAINING_MS,
} from './defaults.ts'
import { readJson, writeJson } from './fs.ts'
import { asArray, asObject, asString, parseJson } from './json.ts'
import { renewLease } from './lease.ts'
import { maskSecrets } from './secrets.ts'
import { createSlackClient, fetchReplies, postMessage, postThread } from './slack-api.ts'
import { escapeMrkdwn, messageText } from './slack-text.ts'

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { DriveContext } from './drive.ts'
import type { Json, JsonObject } from './json.ts'

type NoticeKind = (typeof LEARN_NOTICE_KINDS)[number]
type Direction = (typeof LEARN_DIRECTIONS)[number]
type NoticeItem = {
  n: number
  kind: NoticeKind
  ruleId: string
  direction: Direction
  text: string
  evidence: string[]
  url: string
}
type Notice = { id: number; repo: string; at: string; items: NoticeItem[] }
type Cancel = { noticeId: number; n: number; ruleId: string; at: string }
// 投稿した知らせ。チャンネルは投稿したときのもの（報告先を変えても前のスレッドを読めるように）。after は読み終えた返信の ts。
// acked は受け付けの返信を済ませた項目の番号（同じ項目への返信が重なっても受け付けは 1 回だけ）
type LearnPost = { id: number; channel: string; ts: string; after: string | null; acked: number[] }
export type LearnResult = { posted: number; cancelled: number; errors: string[] }

const count = (value: Json | undefined): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
const strings = (value: Json | undefined): string[] | null => {
  const list = asArray(value)
  return list?.every((v) => typeof v === 'string') ? list.map(String) : null
}
const parseItem = (value: Json): NoticeItem | null => {
  const o = asObject(value)
  const n = count(o?.n)
  const kind = LEARN_NOTICE_KINDS.find((k) => k === o?.kind) ?? null
  const direction = LEARN_DIRECTIONS.find((d) => d === o?.direction) ?? null
  const ruleId = asString(o?.ruleId)
  const text = asString(o?.text)
  const evidence = strings(o?.evidence)
  const url = asString(o?.url)
  return n === null ||
    kind === null ||
    direction === null ||
    ruleId === null ||
    text === null ||
    evidence === null ||
    url === null
    ? null
    : { n, kind, ruleId, direction, text, evidence, url }
}
const parseNotice = (value: Json): Notice | null => {
  const o = asObject(value)
  const id = count(o?.id)
  const repo = asString(o?.repo)
  const at = asString(o?.at)
  const list = asArray(o?.items)
  if (id === null || repo === null || at === null || list === null) return null
  const items = list.map(parseItem)
  return items.every((item) => item !== null) ? { id, repo, at, items } : null
}
// 1 つでも形が違えば全体を読めないとする（orca-team-dispatch-task の readNotices と同じ）
const readVersioned = <T>(path: string, key: string, parse: (value: Json) => T | null): T[] | null => {
  const o = asObject(readJson(path))
  const list = o?.version === LEARN_FILE_VERSION ? asArray(o[key]) : null
  if (list === null) return null
  const parsed = list.map(parse)
  return parsed.every((v) => v !== null) ? parsed : null
}
const parseCancel = (value: Json): Cancel | null => {
  const o = asObject(value)
  const noticeId = count(o?.noticeId)
  const n = count(o?.n)
  const ruleId = asString(o?.ruleId)
  const at = asString(o?.at)
  return noticeId === null || n === null || ruleId === null || at === null ? null : { noticeId, n, ruleId, at }
}
const parsePost = (value: Json): LearnPost | null => {
  const o = asObject(value)
  const id = count(o?.id)
  const channel = asString(o?.channel)
  const ts = asString(o?.ts)
  const after = asString(o?.after)
  const acked = (asArray(o?.acked) ?? []).flatMap((v) => {
    const n = count(v)
    return n === null ? [] : [n]
  })
  return id === null || channel === null || ts === null || (after === null && o?.after !== null)
    ? null
    : { id, channel, ts, after, acked }
}
// meta は自分だけが書くので、読めなければ投稿の記録が無いものとして扱う
const readPosts = (raw: string | null): LearnPost[] =>
  (asArray(parseJson(raw ?? '[]')) ?? []).flatMap((v) => {
    const post = parsePost(v)
    return post ? [post] : []
  })
const newest = (posts: LearnPost[]): LearnPost[] => [...posts].sort((a, b) => a.id - b.id).slice(-LEARN_THREADS_MAX)

const fill = (template: string, values: Record<string, string | number>): string =>
  template.replace(/\{(\w+)\}/g, (match, key: string) => String(values[key] ?? match))
// 知らせの文は信じられない材料なので、秘密を伏せ、Slack の記法と行の区切りを効かせない
const safe = (s: string): string => escapeMrkdwn(maskSecrets(s)).replace(/[\p{Cc}\u2028\u2029]+/gu, ' ')
const evidenceLabel = (id: string): string => {
  const m = id.match(LEARN_EVIDENCE_PATTERN)
  return m ? `#${m[1]}` : safe(id)
}
const kindLabel = (item: NoticeItem): string => {
  const url = item.url.startsWith(LEARN_URL_PREFIX) ? safe(item.url) : ''
  switch (item.kind) {
    case 'new':
      return item.direction === 'auto' ? LEARN_TEXT.newAuto : LEARN_TEXT.newEng
    case 'support':
      return LEARN_TEXT.support
    case 'withdrawn':
      return LEARN_TEXT.withdrawn
    case 'graduated':
      return LEARN_TEXT.graduated
    case 'global-issue':
      return fill(LEARN_TEXT.globalIssue, { url }).trim()
    case 'global-pr':
      return fill(LEARN_TEXT.globalPr, { url }).trim()
    case 'global-hint':
      return LEARN_TEXT.globalHint
  }
}
const cancellable = (item: NoticeItem): boolean => LEARN_CANCELLABLE_KINDS.includes(item.kind)
const renderNotice = (notice: Notice, repo: string): string => {
  const lines = [fill(LEARN_TEXT.heading, { repo: safe(repo) })]
  for (const item of notice.items) {
    lines.push(fill(LEARN_TEXT.item, { n: item.n, text: safe(item.text), kind: kindLabel(item) }))
    if (item.evidence.length)
      lines.push(fill(LEARN_TEXT.evidence, { evidence: item.evidence.map(evidenceLabel).join(' ') }))
  }
  if (notice.items.some(cancellable)) lines.push(LEARN_TEXT.cancelHint)
  return lines.join('\n')
}
// 前後の空白と全角の数字・空白を許す。合わなければ null
const cancelNumber = (text: string): number | null => {
  const m = text.normalize('NFKC').trim().match(LEARN_CANCEL_PATTERN)
  return m ? Number(m[1]) : null
}

// 報告の材料と同じフォルダの学びの知らせを、定期報告のチャンネルに投稿し、スレッドの「取り消し <番号>」を
// ホームの learn-cancels.json に書く。orca-team-dispatch-task が次の tick で読んで規則を取り下げる。Claude は起こさない
export const syncLearn = async (ctx: DriveContext): Promise<LearnResult> => {
  const { rt, token } = ctx
  const result: LearnResult = { posted: 0, cancelled: 0, errors: [] }
  const source = rt.config.report.source
  if (!source) return result
  const path = join(dirname(source), LEARN_NOTICES_PATH)
  if (!existsSync(path)) return result
  const notices = readVersioned(path, 'notices', parseNotice)
  if (!notices) {
    result.errors.push(maskSecrets(fill(LEARN_TEXT.unreadable, { path })))
    return result
  }
  // 学びだけの失敗を、起票・既存 Issue の取り込みに使うクライアントへ持ち越さない
  const slack = createSlackClient(rt.token)
  const valid = (): boolean => {
    if (Date.now() >= ctx.deadline) {
      result.errors.push(ERROR_DEADLINE)
      return false
    }
    if (!renewLease(rt.db, token, ctx.now(), ctx.ttlMs)) {
      result.errors.push(ERROR_LEASE_LOST)
      return false
    }
    return true
  }
  // 既存 Issue の取り込みの分の時間を残す。足りなければ errors に出さずに次の回へ回す
  const short = (): boolean => ctx.deadline - Date.now() < STATUS_MIN_REMAINING_MS
  let posts = newest(readPosts(getMeta(rt.db, META_LEARN_POSTS)))
  const save = (set: Record<string, string> = {}): boolean => {
    if (!valid()) return false
    if (writeMetaFenced(rt.db, token, ctx.now().toISOString(), { ...set, [META_LEARN_POSTS]: JSON.stringify(posts) }))
      return true
    result.errors.push(ERROR_LEASE_LOST)
    return false
  }

  // 投稿: そのホームのリポジトリの、まだ投稿していない知らせを id の小さい順に。失敗したら次の回に同じ id からやり直す
  const last = Number(getMeta(rt.db, META_LEARN_LAST_ID) ?? 0) || 0
  const channel = rt.config.report.channel ?? rt.config.channel
  const pending = notices
    .flatMap((notice) => {
      const setting = notice.id > last ? repoSetting(rt.config, notice.repo) : null
      return setting ? [{ notice, repo: setting.name }] : []
    })
    .sort((a, b) => a.notice.id - b.notice.id)
    .slice(0, LEARN_POSTS_PER_POLL)
  for (const { notice, repo } of pending) {
    if (short()) return result
    if (!valid()) return result
    const r = await postMessage(slack, channel, renderNotice(notice, repo), ctx.deadline, false)
    if (!r.ok) {
      result.errors.push(maskSecrets(r.error))
      break
    }
    posts = newest([...posts, { id: notice.id, channel, ts: r.ts, after: null, acked: [] }])
    if (!save({ [META_LEARN_LAST_ID]: String(notice.id) })) return result
    result.posted += 1
  }

  // 取り消し: 新しい投稿から順にスレッドを読む。自分の投稿と、知らせが古い（または notices.json から消えた）投稿は読まない
  const byId = new Map(notices.map((notice) => [notice.id, notice]))
  const cancelsPath = join(rt.home, LEARN_CANCELS_FILE)
  const own = (m: JsonObject): boolean =>
    asString(m.user) === rt.config.slack.botUserId || asString(m.bot_id) === rt.config.slack.botId
  const recent = (notice: Notice | undefined): boolean =>
    notice !== undefined && ctx.now().getTime() - Date.parse(notice.at) <= LEARN_CANCEL_WINDOW_DAYS * DAY_MS
  const update = (post: LearnPost, after: string | null, acked: number[]): void => {
    posts = posts.map((p) => (p.id === post.id ? { ...p, after, acked } : p))
  }
  for (const post of [...posts].reverse()) {
    if (!recent(byId.get(post.id))) continue
    if (short()) return result
    if (!valid()) return result
    const r = await fetchReplies(slack, post.channel, post.ts, post.after, ctx.deadline)
    if (!r.ok) {
      // 消された投稿は諦める（毎回 errors に出し続けない）
      if (r.error === 'thread_not_found') {
        posts = posts.filter((p) => p.id !== post.id)
        if (!save()) return result
        continue
      }
      result.errors.push(maskSecrets(r.error))
      break
    }
    let after = post.after
    const acked = [...post.acked]
    let stop = false
    for (const m of r.messages) {
      const n = own(m) ? null : cancelNumber(messageText(m).text)
      const item = n === null ? undefined : byId.get(post.id)?.items.find((i) => i.n === n && cancellable(i))
      if (item) {
        if (!valid()) return result
        const cancels = existsSync(cancelsPath) ? readVersioned(cancelsPath, 'cancels', parseCancel) : []
        // 読めないファイルは上書きしない。この返信から次の回に読み直す
        if (!cancels) {
          result.errors.push(maskSecrets(fill(LEARN_TEXT.cancelsUnreadable, { path: cancelsPath })))
          stop = true
          break
        }
        if (!cancels.some((c) => c.noticeId === post.id && c.n === item.n)) {
          const cancel: Cancel = { noticeId: post.id, n: item.n, ruleId: item.ruleId, at: ctx.now().toISOString() }
          writeJson(cancelsPath, { version: LEARN_FILE_VERSION, cancels: [...cancels, cancel] })
          result.cancelled += 1
        }
        // 依頼が前の回に書けていても、受け付けを返せていなければ返す。返せなければこの返信の手前で止め、次の回に読み直す
        if (!acked.includes(item.n)) {
          if (!valid()) return result
          const ack = await postThread(slack, post.channel, post.ts, LEARN_TEXT.accepted, ctx.deadline)
          if (!ack.ok) {
            result.errors.push(maskSecrets(ack.error))
            stop = true
            break
          }
          acked.push(item.n)
        }
      }
      after = String(m.ts)
    }
    if (after !== post.after || acked.length !== post.acked.length) {
      update(post, after, acked)
      if (!save()) return result
    }
    if (stop) break
  }
  return result
}
