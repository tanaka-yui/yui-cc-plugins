import { AUTOLINK_BREAK, DEFAULT_TIMEZONE, FETCH_TIMEOUT_MS, LOOPBACK_HOSTS, WEBHOOK_OVERRIDE_ENV } from './defaults.ts'

import type { Section } from './config.ts'
import type { DigestFile, DigestGroup } from './digest.ts'
import type { PendingEntry, PendingFile } from './pending.ts'
import type { Severity } from './severity.ts'

// 組み込みのカテゴリの並び。追加したカテゴリはこの後ろに設定の順で並ぶ
const BUILTIN_ORDER: readonly Section[] = ['jvn', 'aws', 'gcp', 'releases', 'x', 'devto']
// group の置き場所の優先順位（公式ソース）。無ければ x、それも無ければほかのメンバー
const OFFICIAL_SECTIONS: readonly Section[] = ['jvn', 'aws', 'gcp', 'releases']
const CUSTOM_MARK = '📌'
const ELLIPSIS = '…'

const sectionTitle = (section: Section, jvnMin: Severity | null): string => {
  switch (section) {
    case 'jvn':
      return jvnMin === null ? '🚨 脆弱性（JVN）' : `🚨 脆弱性（JVN ${jvnMin} 以上）`
    case 'aws':
      return '☁️ AWS'
    case 'gcp':
      return '☁️ Google Cloud'
    case 'releases':
      return '🏷️ リリース'
    case 'x':
      return '🤖 X'
    case 'devto':
      return '📰 dev.to'
    case 'feed':
      return `${CUSTOM_MARK} フィード`
  }
}

export const escapeMrkdwn = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

// リンクの外に出す自由文（AI の要約・外部のタイトルなど）。Slack は URL やドメインらしき並びを自動でリンクにするので、
// `://` と「英数字.英字 2 文字以上」の間に幅ゼロの文字を挟んで止める。リンクはプログラムが組み立てた url からしか出さない
const plainText = (text: string): string =>
  escapeMrkdwn(text)
    .replaceAll('://', `:${AUTOLINK_BREAK}//`)
    .replaceAll(/([A-Za-z0-9])\.(?=[A-Za-z]{2,})/g, `$1${AUTOLINK_BREAK}.`)

const linkTarget = (url: string): string =>
  url.replaceAll('<', '%3C').replaceAll('>', '%3E').replaceAll('|', '%7C').replaceAll(/\s/g, '%20')

// http / https 以外（javascript: など）や読めない URL はリンクにしない
const isHttpUrl = (url: string): boolean => {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

// 外部由来の URL は必ずここを通す。リンクにできなければエスケープしたラベルだけを返す
const link = (url: string, label: string): string =>
  isHttpUrl(url) ? `<${linkTarget(url)}|${escapeMrkdwn(label)}>` : plainText(label)

// ISO 時刻を、指定タイムゾーンの M/D にする
export const formatMonthDay = (iso: string, timeZone: string = DEFAULT_TIMEZONE): string => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, month: 'numeric', day: 'numeric' }).formatToParts(
    new Date(iso),
  )
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? ''
  return `${part('month')}/${part('day')}`
}

const unique = (ids: number[]): number[] => [...new Set(ids)]

type Body = { lines: string[]; count: number }
type PlacedGroup = { group: DigestGroup; found: PendingEntry[] }

// group のうち、対象の項目集合に入っているメンバー
const groupMembers = (
  byId: ReadonlyMap<number, PendingEntry>,
  group: DigestGroup,
  ids: ReadonlySet<number>,
): PendingEntry[] =>
  unique(group.itemIds)
    .filter((id) => ids.has(id))
    .map((id) => byId.get(id))
    .filter((item): item is PendingEntry => item !== undefined)

const placementRank = (item: PendingEntry): number =>
  OFFICIAL_SECTIONS.includes(item.section) ? 0 : item.section === 'x' ? 1 : 2

// group を載せるカテゴリ。順位のいちばん高いメンバー（同順位なら先のもの）のカテゴリ。found は 1 件以上
const placeGroup = (found: PendingEntry[]): string =>
  found.reduce((best, item) => (placementRank(item) < placementRank(best) ? item : best)).category

// 各項目が通知のどのカテゴリに載るか。group のメンバーは group の置き場所に揃える
export const placeItems = (pending: PendingFile, digest: DigestFile, ids: ReadonlySet<number>): Map<number, string> => {
  const byId = new Map(pending.items.map((item) => [item.id, item]))
  const placed = new Map<number, string>()
  for (const group of digest.groups) {
    const found = groupMembers(byId, group, ids)
    if (found.length === 0) continue
    const category = placeGroup(found)
    for (const item of found) placed.set(item.id, category)
  }
  for (const id of ids) {
    const item = byId.get(id)
    if (item !== undefined && !placed.has(id)) placed.set(id, item.category)
  }
  return placed
}

// 見出しの並びと文言。組み込み → 追加したカテゴリ（設定の順）→ 設定に無いカテゴリ（id をそのまま見出しにする）
const headings = (options: RenderOptions, present: PendingEntry[]): Array<{ id: string; title: string }> => {
  const jvnMin = options.jvnMin ?? null
  const known = [
    ...BUILTIN_ORDER.map((section) => ({ id: section, title: sectionTitle(section, jvnMin) })),
    ...(options.categories ?? []).map((category) => ({ id: category.id, title: `${CUSTOM_MARK} ${category.title}` })),
  ]
  const knownIds = new Set(known.map((heading) => heading.id))
  const rest = [...new Set(present.map((item) => item.category))].filter((id) => !knownIds.has(id))
  return [
    ...known,
    ...rest.map((id) => ({ id, title: id === 'feed' ? sectionTitle('feed', jvnMin) : `${CUSTOM_MARK} ${id}` })),
  ]
}

// 対象の項目集合に対し、セクション順に行を作る。group は集合内のメンバーだけで描く
const renderBody = (
  pending: PendingFile,
  digest: DigestFile,
  ids: ReadonlySet<number>,
  options: RenderOptions,
): Body => {
  const byId = new Map(pending.items.map((item) => [item.id, item]))
  const notes = new Map<number, string>()
  for (const note of digest.notes) if (!notes.has(note.id)) notes.set(note.id, note.summaryJa)

  const grouped = new Set<number>()
  const groupsByCategory = new Map<string, PlacedGroup[]>()
  for (const group of digest.groups) {
    const found = groupMembers(byId, group, ids)
    if (found.length === 0) continue
    for (const item of found) grouped.add(item.id)
    const category = placeGroup(found)
    groupsByCategory.set(category, [...(groupsByCategory.get(category) ?? []), { group, found }])
  }

  const itemLines = (item: PendingEntry): string[] => {
    const mark = item.updated ? '【追記】' : ''
    const cvss = item.section === 'jvn' && item.severity !== null ? ` [CVSS ${item.severity}]` : ''
    const summary = notes.get(item.id)
    if (summary === undefined) {
      const head = `• ${mark}${plainText(item.title)}（要約なし）${cvss}`
      return isHttpUrl(item.url) ? [head, `  ${link(item.url, linkTarget(item.url))}`] : [head]
    }
    return [`• ${mark}${link(item.url, item.title)}${cvss} — ${plainText(summary)}`]
  }

  const groupLines = ({ group, found }: PlacedGroup): string[] => {
    const out = [`• ${plainText(group.titleJa)} — ${plainText(group.summaryJa)}`]
    for (const item of found.filter((entry) => entry.section !== 'x')) out.push(`  ${link(item.url, item.title)}`)
    const posts = found.filter((entry) => entry.section === 'x')
    // 送信済みにする投稿はすべてリンクを載せる（spec §9）
    if (posts.length > 0) {
      const mentions = posts.map((post) => link(post.url, `@${(post.author ?? '?').replace(/^@/, '')}`))
      out.push(`  言及: ${mentions.join(', ')}`)
    }
    return out
  }

  const lines: string[] = []
  const present = pending.items.filter((item) => ids.has(item.id))
  for (const heading of headings(options, present)) {
    const groups = groupsByCategory.get(heading.id) ?? []
    const singles = present.filter((item) => item.category === heading.id && !grouped.has(item.id))
    if (groups.length === 0 && singles.length === 0) continue
    lines.push('', `*${plainText(heading.title)}*`)
    for (const entry of groups) lines.push(...groupLines(entry))
    for (const item of singles) lines.push(...itemLines(item))
  }
  return { lines, count: present.length }
}

// categories: 追加したカテゴリの id と見出し（設定の順）
export type RenderOptions = {
  jvnMin?: Severity | null
  timeZone?: string
  categories?: Array<{ id: string; title: string }>
}

export const renderGlobal = (
  pending: PendingFile,
  digest: DigestFile,
  date: string,
  options: RenderOptions = {},
): string[] => {
  const body = renderBody(pending, digest, new Set(pending.globalIds), options)
  const lines: string[] = []
  if (pending.previousIncomplete !== null) {
    const previous = formatMonthDay(pending.previousIncomplete, options.timeZone)
    lines.push(`⚠️ 前回（${previous}）の実行は完了しませんでした`)
  }
  lines.push(`☀️ ${date} 開発速報（全体・${body.count} 件）`, ...body.lines)
  if (pending.failures.length > 0) lines.push('')
  for (const failure of pending.failures) {
    lines.push(`⚠️ 取得できなかったソース: ${plainText(failure.sourceId)}（${plainText(failure.reason)}）`)
  }
  return lines
}

// セクション専用のチャンネルに送る 1 通。ids はそのチャンネルに載る項目（placeItems で振り分けたもの）。0 件なら null
export const renderSection = (
  pending: PendingFile,
  digest: DigestFile,
  ids: number[],
  date: string,
  options: RenderOptions = {},
): string[] | null => {
  const body = renderBody(pending, digest, new Set(ids), options)
  if (body.count === 0) return null
  return [`☀️ ${date} 開発速報（${body.count} 件）`, ...body.lines]
}

// リポジトリの対象項目 = digest の選択 ∪ ownIds（重複は 1 件）
export const repoItemIds = (pending: PendingFile, digest: DigestFile, slug: string): number[] => {
  const own = pending.repos.find((repo) => repo.slug === slug)?.ownIds ?? []
  const chosen = digest.repos.filter((repo) => repo.slug === slug).flatMap((repo) => repo.itemIds)
  return unique([...chosen, ...own])
}

// 見出しは全体の Webhook に載せるときも専用のときも同じ。date と viaGlobal は見出しに使わない
export const renderRepo = (
  pending: PendingFile,
  digest: DigestFile,
  slug: string,
  _date: string,
  _viaGlobal: boolean,
  options: RenderOptions = {},
): string[] | null => {
  const repo = pending.repos.find((entry) => entry.slug === slug)
  if (repo === undefined) return null
  const body = renderBody(pending, digest, new Set(repoItemIds(pending, digest, slug)), options)
  if (body.count === 0) return null
  return [`📦 [${plainText(repo.displayName)}] 関連（${body.count} 件）`, ...body.lines]
}

const continuation = (k: number, n: number): string => `（続き ${k}/${n}）`
// 続き番号の見出しに使う余白（桁数の上限を 3 桁として見積もる）
const CONTINUATION_RESERVE = continuation(999, 999).length + 1

export const splitMessages = (lines: string[], maxChars: number): string[] => {
  const whole = lines.join('\n')
  if (whole.length <= maxChars) return [whole]
  const budget = maxChars - CONTINUATION_RESERVE
  const chunks: string[] = []
  let current: string[] = []
  let size = 0
  for (const original of lines) {
    const line = original.length > budget ? `${original.slice(0, budget - ELLIPSIS.length)}${ELLIPSIS}` : original
    const added = current.length === 0 ? line.length : line.length + 1
    if (size + added > budget && current.length > 0) {
      chunks.push(current.join('\n'))
      current = []
      size = 0
    }
    size += current.length === 0 ? line.length : line.length + 1
    current.push(line)
  }
  if (current.length > 0) chunks.push(current.join('\n'))
  return chunks.map((chunk, index) => (index === 0 ? chunk : `${continuation(index + 1, chunks.length)}\n${chunk}`))
}

export const overrideUrl = (url: string): string => {
  const base = process.env[WEBHOOK_OVERRIDE_ENV]
  if (base === undefined || base === '') return url
  try {
    const target = new URL(base)
    // 環境変数で送信先を外部に向けられないよう、ループバックのときだけ使う
    if (!LOOPBACK_HOSTS.includes(target.hostname)) return url
    const original = new URL(url)
    return `${target.origin}${original.pathname}${original.search}`
  } catch {
    return url
  }
}

export type PostResult = { ok: boolean; status: number; error: string | null }

// 応答本文は読まない（URL が混ざりうる）。例外の文面は呼び出し側で maskSecrets する
// リンクのプレビュー（記事カード・画像）は出さない。速報は件数が多く、プレビューで本文が埋もれるため
export const postWebhook = async (url: string, text: string): Promise<PostResult> => {
  try {
    const response = await fetch(overrideUrl(url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, unfurl_links: false, unfurl_media: false }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    await response.body?.cancel()
    return response.ok
      ? { ok: true, status: response.status, error: null }
      : { ok: false, status: response.status, error: `HTTP ${response.status}` }
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) }
  }
}
