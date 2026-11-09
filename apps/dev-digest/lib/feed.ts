import { EXCERPT_CHARS, MAX_FEED_BYTES } from './defaults.ts'
import { maxSeverity, parseSeverity } from './severity.ts'

import { createHash } from 'node:crypto'

import type { Severity } from './severity.ts'

export type FeedItem = {
  guid: string
  url: string
  title: string
  summary: string
  author: string | null
  publishedAt: string | null
  updatedAt: string | null
  severity: Severity | null
  products: string[]
}

// 汎用の XML パーサは持たない。<item> / <entry> の区間を切り出し、必要な要素だけ正規表現で読む。
// 名前空間の接頭辞（dc: dcterms: sec:）は名前の一部としてそのまま探す。

const NAMED_ENTITIES: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

// 実体参照を 1 段だけ戻す（&amp;lt; は &lt; になる）
const unescapeOnce = (text: string): string =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
    if (name.startsWith('#')) {
      const code =
        name[1]?.toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10)
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? match
  })

// 段落や改行になるタグは空白に、それ以外は取り除く（<b>a</b>b が a b にならないように）
const BLOCK_TAG_PATTERN = /^<\/?(?:p|br|li|ul|ol|div|h[1-6]|tr|table|blockquote|pre)(?=[\s/>])/i
const CDATA_OPEN = '<![CDATA['
const CDATA_CLOSE = ']]>'

// 入力は信頼できないので、ネストした量指定子を持つ正規表現は使わず indexOf で線形に走査する

// `<` の次が英字・`/`・`!` のときだけタグとみなして除く（`a < b` は残す）。閉じの `>` が無ければ以降は本文
const stripTags = (text: string): string => {
  let result = ''
  let position = 0
  while (position < text.length) {
    const open = text.indexOf('<', position)
    if (open === -1) break
    const next = text[open + 1] ?? ''
    if (!/[a-zA-Z/!]/.test(next)) {
      result += text.slice(position, open + 1)
      position = open + 1
      continue
    }
    const close = text.indexOf('>', open)
    if (close === -1) break
    result += text.slice(position, open) + (BLOCK_TAG_PATTERN.test(text.slice(open, open + 16)) ? ' ' : '')
    position = close + 1
  }
  return result + text.slice(position)
}

// CDATA の中身は XML の実体を戻さず、そのまま通す
const unescapeOutsideCdata = (raw: string): string => {
  let result = ''
  let position = 0
  while (position < raw.length) {
    const open = raw.indexOf(CDATA_OPEN, position)
    const close = open === -1 ? -1 : raw.indexOf(CDATA_CLOSE, open + CDATA_OPEN.length)
    if (open === -1 || close === -1) break
    result += unescapeOnce(raw.slice(position, open)) + raw.slice(open + CDATA_OPEN.length, close)
    position = close + CDATA_CLOSE.length
  }
  return result + unescapeOnce(raw.slice(position))
}

// 復号の順序: XML の実体を 1 段 → HTML タグを除く → HTML の実体を 1 段 → 空白を畳む。
// CDATA の中身は XML の実体を戻さない（HTML の実体は戻す）
const decodeText = (raw: string): string =>
  unescapeOnce(stripTags(unescapeOutsideCdata(raw)))
    .replace(/\s+/g, ' ')
    .trim()

const truncate = (text: string, limit: number): string => {
  if (text.length <= limit) return text
  const cut = text.slice(0, limit)
  // サロゲートペアを途中で切らない
  return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut
}

// `<name` の直後が空白・`>`・`/` の開始タグを from 以降から探す（`<titles` は除く）
const findOpen = (text: string, name: string, from: number): number => {
  const needle = `<${name}`
  let position = text.indexOf(needle, from)
  while (position !== -1) {
    if (/[\s>/]/.test(text[position + needle.length] ?? '')) return position
    position = text.indexOf(needle, position + needle.length)
  }
  return -1
}

// 閉じを持つ要素の中身（生）。見つからない・自己終了・閉じが無いときは null
const rawElement = (block: string, name: string): string | null => {
  const start = findOpen(block, name, 0)
  if (start === -1) return null
  const end = block.indexOf('>', start)
  if (end === -1 || block[end - 1] === '/') return null
  const close = block.indexOf(`</${name}>`, end)
  return close === -1 ? null : block.slice(end + 1, close)
}

const textElement = (block: string, name: string): string | null => {
  const raw = rawElement(block, name)
  if (raw === null) return null
  const text = decodeText(raw)
  return text === '' ? null : text
}

const parseAttributes = (tag: string): Record<string, string> => {
  const attributes: Record<string, string> = {}
  for (const match of tag.matchAll(/(?<![\w:.-])([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const name = match[1]
    if (name !== undefined) attributes[name] = unescapeOnce(match[2] ?? match[3] ?? '')
  }
  return attributes
}

// 自己終了または空の要素（<link ... /> や <sec:cvss ... />）の属性を全部集める
const attributeList = (block: string, name: string): Record<string, string>[] => {
  const list: Record<string, string>[] = []
  let position = findOpen(block, name, 0)
  while (position !== -1) {
    const end = block.indexOf('>', position)
    if (end === -1) break
    list.push(parseAttributes(block.slice(position + name.length + 1, end)))
    position = findOpen(block, name, end)
  }
  return list
}

const toIso = (text: string | null): string | null => {
  if (text === null) return null
  const date = new Date(text)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

const firstOf = (...values: (string | null)[]): string | null => values.find((value) => value !== null) ?? null

// 開始タグから最初の閉じタグまでを 1 区間とする。閉じるより前に同じ開始タグが来たら、その項目は捨てて
// 次の開始タグから続ける。閉じが無い項目も捨てる（全体で線形: 閉じタグの位置は使い回す）
const blocks = (xml: string, tag: 'item' | 'entry'): { open: string; body: string }[] => {
  const closeTag = `</${tag}>`
  const found: { open: string; body: string }[] = []
  let position = 0
  let closeAt = -1
  while (true) {
    const start = findOpen(xml, tag, position)
    if (start === -1) break
    const end = xml.indexOf('>', start)
    if (end === -1) break
    if (closeAt < end) closeAt = xml.indexOf(closeTag, end)
    if (closeAt === -1) break
    const nextStart = findOpen(xml, tag, end)
    if (nextStart !== -1 && nextStart < closeAt) {
      position = nextStart
      continue
    }
    found.push({ open: xml.slice(start + tag.length + 1, end), body: xml.slice(end + 1, closeAt) })
    position = closeAt + closeTag.length
  }
  return found
}

const itemUrl = (body: string): string | null => {
  const links = attributeList(body, 'link').filter((attributes) => attributes.href !== undefined)
  const alternate = links.find((attributes) => attributes.rel === undefined || attributes.rel === 'alternate')
  return firstOf(alternate?.href ?? null, textElement(body, 'link'))
}

const itemAuthor = (body: string): string | null => {
  const author = rawElement(body, 'author')
  return firstOf(
    textElement(body, 'dc:creator'),
    author === null ? null : firstOf(textElement(author, 'name'), decodeText(author) || null),
  )
}

const itemSeverity = (body: string): Severity | null => {
  const found: Severity[] = []
  for (const attributes of attributeList(body, 'sec:cvss')) {
    const severity = parseSeverity(attributes.severity ?? '')
    if (severity !== null) found.push(severity)
  }
  return maxSeverity(found)
}

const itemProducts = (body: string): string[] => {
  const products = attributeList(body, 'sec:cpe')
    .map((attributes) => (attributes.product ?? '').trim())
    .filter((product) => product !== '')
  return [...new Set(products)]
}

const toItem = (open: string, body: string): FeedItem | null => {
  const title = textElement(body, 'title')
  if (title === null) return null
  const url = itemUrl(body)
  const rdfAbout = parseAttributes(open)['rdf:about'] ?? null
  const guid = firstOf(rdfAbout, textElement(body, 'guid'), textElement(body, 'id'), url)
  if (guid === null) return null
  const summaryText = firstOf(
    textElement(body, 'description'),
    textElement(body, 'summary'),
    textElement(body, 'content:encoded'),
    textElement(body, 'content'),
  )
  const updatedAt = toIso(firstOf(textElement(body, 'dcterms:modified'), textElement(body, 'updated')))
  const publishedAt = toIso(
    firstOf(
      textElement(body, 'pubDate'),
      textElement(body, 'dcterms:issued'),
      textElement(body, 'published'),
      textElement(body, 'dc:date'),
      textElement(body, 'updated'),
    ),
  )
  return {
    guid,
    url: url ?? (guid.startsWith('http') ? guid : ''),
    title,
    summary: truncate(summaryText ?? '', EXCERPT_CHARS),
    author: itemAuthor(body),
    publishedAt,
    updatedAt,
    severity: itemSeverity(body),
    products: itemProducts(body),
  }
}

// 壊れた XML でも投げない。閉じの無い項目や title の無い項目は捨てて、完全な項目だけを返す
export const parseFeed = (xml: string): FeedItem[] =>
  xml.length > MAX_FEED_BYTES
    ? []
    : [...blocks(xml, 'item'), ...blocks(xml, 'entry')]
        .map(({ open, body }) => toItem(open, body))
        .filter((item): item is FeedItem => item !== null)

// 本文が変わったかを見る指紋（title + summary + updatedAt）
export const contentHash = (item: FeedItem): string =>
  createHash('sha256')
    .update(`${item.title}\0${item.summary}\0${item.updatedAt ?? ''}`)
    .digest('hex')
