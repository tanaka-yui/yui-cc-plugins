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
  LEARN_DISPLAY_REPLACED,
  LEARN_DRAFT_BODY_SHOWN_MAX,
  LEARN_DRAFT_BREAK,
  LEARN_EVIDENCE_PATTERN,
  LEARN_FILE_VERSION,
  LEARN_HUMAN_SUBTYPES,
  LEARN_LINE_BREAK,
  LEARN_NOTICE_KINDS,
  LEARN_NOTICES_PATH,
  LEARN_POSTS_PER_POLL,
  LEARN_PUBLISH_PATTERN,
  LEARN_PUBLISHABLE_KIND,
  LEARN_REQUEST_ACTIONS,
  LEARN_TEXT,
  LEARN_THREADS_MAX,
  LEARN_URL_PREFIX,
  META_LEARN_LAST_ID,
  META_LEARN_POSTS,
  STATUS_MIN_REMAINING_MS,
} from './defaults.ts'
import { readJson, writeJson } from './fs.ts'
import { asArray, asObject, asString, parseJson } from './json.ts'
import { learnItemHash, noticeFingerprint } from './learn-hash.ts'
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
  // global-draft だけ下書きの本文が入る
  body: string
}
type Notice = { id: number; repo: string; at: string; items: NoticeItem[] }
type RequestAction = (typeof LEARN_REQUEST_ACTIONS)[number]
// user は公開を承認した人の Slack の id（公開の依頼だけに書く。無ければ ''）。hash は人が見た項目の learnItemHash
// （orca は自分の知らせの項目と同じ中身のときだけ依頼を効かせる。前の版の依頼には無く、'' で読む）
type Cancel = {
  noticeId: number
  n: number
  ruleId: string
  at: string
  action: RequestAction
  user: string
  hash: string
}
// 投稿した知らせ。チャンネルは投稿したときのもの（報告先を変えても前のスレッドを読めるように）。after は読み終えた返信の ts。
// acked / publishAcked は取り消し・公開の受け付けの返信を済ませた項目の番号（同じ項目への返信が重なっても受け付けは
// それぞれ 1 回だけ）。fingerprint は投稿した知らせの noticeFingerprint（前の版の記録には無く、'' で読む。どの知らせにも合わない）。
// drafts は下書きの題と本文を出して投稿したか（report.channel が設定されていたか。前の版の記録には無く、false で読む）
type LearnPost = {
  id: number
  channel: string
  ts: string
  after: string | null
  acked: number[]
  publishAcked: number[]
  fingerprint: string
  drafts: boolean
}
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
  // 前の版の知らせには body が無い
  const body = o?.body === undefined ? '' : asString(o.body)
  return n === null ||
    kind === null ||
    direction === null ||
    ruleId === null ||
    text === null ||
    evidence === null ||
    url === null ||
    body === null
    ? null
    : { n, kind, ruleId, direction, text, evidence, url, body }
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
  const action = o?.action === undefined ? 'cancel' : (LEARN_REQUEST_ACTIONS.find((a) => a === o.action) ?? null)
  const user = o?.user === undefined ? '' : asString(o.user)
  const hash = o?.hash === undefined ? '' : asString(o.hash)
  return noticeId === null ||
    n === null ||
    ruleId === null ||
    at === null ||
    action === null ||
    user === null ||
    hash === null
    ? null
    : { noticeId, n, ruleId, at, action, user, hash }
}
// ファイルに書く形。user は公開の依頼だけに、hash はある依頼だけに書く（前の版の依頼の形は変えない）
const storedCancel = (cancel: Cancel): JsonObject => {
  const { user, hash, ...entry } = cancel
  return { ...entry, ...(cancel.action === 'publish' ? { user } : {}), ...(hash === '' ? {} : { hash }) }
}
const parsePost = (value: Json): LearnPost | null => {
  const o = asObject(value)
  const id = count(o?.id)
  const channel = asString(o?.channel)
  const ts = asString(o?.ts)
  const after = asString(o?.after)
  const numbers = (value: Json | undefined): number[] =>
    (asArray(value) ?? []).flatMap((v) => {
      const n = count(v)
      return n === null ? [] : [n]
    })
  return id === null || channel === null || ts === null || (after === null && o?.after !== null)
    ? null
    : {
        id,
        channel,
        ts,
        after,
        acked: numbers(o?.acked),
        publishAcked: numbers(o?.publishAcked),
        fingerprint: asString(o?.fingerprint) ?? '',
        drafts: o?.drafts === true,
      }
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
    case 'global-draft':
      return LEARN_TEXT.globalDraft
  }
}
const cancellable = (item: NoticeItem): boolean => LEARN_CANCELLABLE_KINDS.includes(item.kind)
// 下書きの本文を 1 行ずつ固定の印を付けて出す（本文の行が知らせの行に見えないように）。印・改行・エスケープのあとの
// 長さを LEARN_DRAFT_BODY_SHOWN_MAX に収め、収まらなければ（省略）を付けて complete を false にする。
// 1 文字ずつエスケープして数えるので、実体参照（&amp; など）の途中では切らない
const draftBody = (body: string): { lines: string[]; complete: boolean } => {
  const prefix = fill(LEARN_TEXT.draftLine, { line: '' })
  const rows = maskSecrets(body)
    .split(LEARN_LINE_BREAK)
    .map((line) => Array.from(line, (ch) => safe(ch)))
  const full = rows.map((pieces) => prefix + pieces.join(''))
  if (full.join('\n').length <= LEARN_DRAFT_BODY_SHOWN_MAX) return { lines: full, complete: true }
  // （省略）の分を残して前から詰める
  const budget = LEARN_DRAFT_BODY_SHOWN_MAX - LEARN_TEXT.draftOmitted.length
  const lines: string[] = []
  let used = 0
  const omit = (line: string): { lines: string[]; complete: boolean } => ({
    lines: [...lines, `${line}${LEARN_TEXT.draftOmitted}`],
    complete: false,
  })
  for (const pieces of rows) {
    const start = prefix.length + (lines.length > 0 ? 1 : 0)
    if (used + start > budget) return omit(lines.pop() ?? '')
    used += start
    let line = prefix
    for (const piece of pieces) {
      if (used + piece.length > budget) return omit(line)
      line += piece
      used += piece.length
    }
    lines.push(line)
  }
  return { lines, complete: true }
}
// 出した文が公開する文と違うか: 秘密の形の文字列を伏せた、または safe が文字を置き換えた（題は 1 行で、本文は \n だけを
// 行の区切りとして許す）
const altered = (text: string, breaks: RegExp | null): boolean =>
  maskSecrets(text) !== text || LEARN_DISPLAY_REPLACED.test(breaks === null ? text : text.replace(breaks, ''))
const draftAltered = (item: NoticeItem): boolean => altered(item.text, null) || altered(item.body, LEARN_DRAFT_BREAK)
// Slack の返信で公開を受け付ける項目: 下書きで、題と本文を省かず伏せず置き換えずに、公開する文のとおりに見せたもの
const publishable = (item: NoticeItem): boolean =>
  item.kind === LEARN_PUBLISHABLE_KIND && draftBody(item.body).complete && !draftAltered(item)
// showDrafts が false（report.channel が無い）なら、下書きは題と本文を出さずに決まった 1 行にし、案内も出さない
const renderNotice = (notice: Notice, repo: string, showDrafts: boolean): string => {
  const lines = [fill(LEARN_TEXT.heading, { repo: safe(repo) })]
  let drafts = false
  let omitted = false
  let hidden = false
  for (const item of notice.items) {
    if (item.kind === LEARN_PUBLISHABLE_KIND && !showDrafts) {
      lines.push(fill(LEARN_TEXT.draftHidden, { n: item.n }))
      continue
    }
    lines.push(fill(LEARN_TEXT.item, { n: item.n, text: safe(item.text), kind: kindLabel(item) }))
    if (item.evidence.length)
      lines.push(fill(LEARN_TEXT.evidence, { evidence: item.evidence.map(evidenceLabel).join(' ') }))
    if (item.kind === LEARN_PUBLISHABLE_KIND) {
      const shown = draftBody(item.body)
      lines.push(...shown.lines)
      drafts = true
      omitted ||= !shown.complete
      hidden ||= draftAltered(item)
    }
  }
  if (omitted) lines.push(LEARN_TEXT.draftTooLongHint)
  else if (hidden) lines.push(LEARN_TEXT.draftMaskedHint)
  else if (drafts) lines.push(LEARN_TEXT.draftHint)
  else if (notice.items.some((item) => cancellable(item) && (showDrafts || item.kind !== LEARN_PUBLISHABLE_KIND)))
    lines.push(LEARN_TEXT.cancelHint)
  return lines.join('\n')
}
// 返信の「取り消し <番号>」「公開 <番号>」。前後の空白と全角の数字・空白を許す。合わなければ null
const requestOf = (text: string): { action: RequestAction; n: number } | null => {
  const normalized = text.normalize('NFKC').trim()
  const cancel = normalized.match(LEARN_CANCEL_PATTERN)
  if (cancel) return { action: 'cancel', n: Number(cancel[1]) }
  const publish = normalized.match(LEARN_PUBLISH_PATTERN)
  return publish ? { action: 'publish', n: Number(publish[1]) } : null
}

// 報告の材料と同じフォルダの学びの知らせを、定期報告のチャンネルに投稿し、スレッドの「取り消し <番号>」「公開 <番号>」を
// ホームの learn-cancels.json に書く。orca-team-dispatch-task が次の tick で読んで、規則を取り下げる・下書きを捨てる・
// 改善の Issue を作る。Claude は起こさない
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
  // 下書きの題と本文を出すのは、報告先のチャンネルを明示したときだけ（無ければフォームのチャンネルに落ちるため）
  const showDrafts = rt.config.report.channel !== null
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
    const r = await postMessage(slack, channel, renderNotice(notice, repo, showDrafts), ctx.deadline, false)
    if (!r.ok) {
      result.errors.push(maskSecrets(r.error))
      break
    }
    const post = {
      id: notice.id,
      channel,
      ts: r.ts,
      after: null,
      acked: [],
      publishAcked: [],
      fingerprint: noticeFingerprint(notice),
      drafts: showDrafts,
    }
    posts = newest([...posts, post])
    if (!save({ [META_LEARN_LAST_ID]: String(notice.id) })) return result
    result.posted += 1
  }

  // 取り消しと公開: 新しい投稿から順にスレッドを読む。自分の投稿と、知らせが古い（または notices.json から消えた）投稿は読まない
  const byId = new Map(notices.map((notice) => [notice.id, notice]))
  const cancelsPath = join(rt.home, LEARN_CANCELS_FILE)
  const own = (m: JsonObject): boolean =>
    asString(m.user) === rt.config.slack.botUserId || asString(m.bot_id) === rt.config.slack.botId
  // 人が書いた投稿か: user の id があり、bot_id が無く、subtype が無いか人の返信の subtype（公開はこれだけが承認できる）
  const person = (m: JsonObject): string | null => {
    const user = asString(m.user)
    const subtype = asString(m.subtype)
    return user && m.bot_id === undefined && (subtype === null || LEARN_HUMAN_SUBTYPES.includes(subtype)) ? user : null
  }
  const recent = (notice: Notice | undefined): boolean =>
    notice !== undefined && ctx.now().getTime() - Date.parse(notice.at) <= LEARN_CANCEL_WINDOW_DAYS * DAY_MS
  const update = (post: LearnPost, after: string | null, acked: number[], publishAcked: number[]): void => {
    posts = posts.map((p) => (p.id === post.id ? { ...p, after, acked, publishAcked } : p))
  }
  for (const post of [...posts].reverse()) {
    // 今の notices.json の同じ id の知らせが、投稿したものと違えば（報告の材料の場所を変えた・orca の learn/ を作り直した
    // など）、そのスレッドの返信は人が見ていない知らせを指すので、取り消しも公開も受けない。前の版の記録も同じ
    const current = byId.get(post.id)
    if (!recent(current) || current === undefined || noticeFingerprint(current) !== post.fingerprint) continue
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
    // 返信が指す項目。取り消しは取り消せる項目、公開は全文を見せた下書きだけ。下書きへの依頼は、題と本文を出して
    // 投稿したスレッドで、今も報告先のチャンネルが設定されているときだけ受ける（見ていない下書きを承認・破棄させない）
    const draftsOpen = post.drafts && rt.config.report.channel !== null
    const targets = {
      cancel: (i: NoticeItem): boolean => cancellable(i) && (draftsOpen || i.kind !== LEARN_PUBLISHABLE_KIND),
      publish: (i: NoticeItem): boolean => draftsOpen && publishable(i),
    }
    let after = post.after
    const acked = { cancel: [...post.acked], publish: [...post.publishAcked] }
    let stop = false
    for (const m of r.messages) {
      const parsed = own(m) ? null : requestOf(messageText(m).text)
      // ボット・連携の投稿の公開の返信は、依頼も受け付けの返事も出さずに無視する
      const approver = person(m)
      const request = parsed?.action === 'publish' && approver === null ? null : parsed
      const item =
        request === null ? undefined : current.items.find((i) => i.n === request.n && targets[request.action](i))
      if (request && item) {
        if (!valid()) return result
        const cancels = existsSync(cancelsPath) ? readVersioned(cancelsPath, 'cancels', parseCancel) : []
        // 読めないファイルは上書きしない。この返信から次の回に読み直す
        if (!cancels) {
          result.errors.push(maskSecrets(fill(LEARN_TEXT.cancelsUnreadable, { path: cancelsPath })))
          stop = true
          break
        }
        // 同じ知らせ・番号・種類の依頼は 1 回だけ（cancelled は取り消しと公開を合わせた依頼の数）
        const hash = learnItemHash(item)
        if (
          !cancels.some(
            (c) => c.noticeId === post.id && c.n === item.n && c.action === request.action && c.hash === hash,
          )
        ) {
          const cancel: Cancel = {
            noticeId: post.id,
            n: item.n,
            ruleId: item.ruleId,
            at: ctx.now().toISOString(),
            action: request.action,
            user: request.action === 'publish' ? (approver ?? '') : '',
            hash,
          }
          writeJson(cancelsPath, { version: LEARN_FILE_VERSION, cancels: [...cancels, cancel].map(storedCancel) })
          result.cancelled += 1
        }
        // 依頼が前の回に書けていても、受け付けを返せていなければ返す。返せなければこの返信の手前で止め、次の回に読み直す
        const done = acked[request.action]
        if (!done.includes(item.n)) {
          if (!valid()) return result
          const text = request.action === 'publish' ? LEARN_TEXT.publishAccepted : LEARN_TEXT.accepted
          const ack = await postThread(slack, post.channel, post.ts, text, ctx.deadline)
          if (!ack.ok) {
            result.errors.push(maskSecrets(ack.error))
            stop = true
            break
          }
          done.push(item.n)
        }
      }
      after = String(m.ts)
    }
    if (
      after !== post.after ||
      acked.cancel.length !== post.acked.length ||
      acked.publish.length !== post.publishAcked.length
    ) {
      update(post, after, acked.cancel, acked.publish)
      if (!save()) return result
    }
    if (stop) break
  }
  return result
}
