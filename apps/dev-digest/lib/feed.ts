import { EXCERPT_CHARS } from './defaults.ts'
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

const CDATA_PATTERN = /<!\[CDATA\[([\s\S]*?)\]\]>/g
// 段落や改行になるタグは空白に、それ以外は取り除く（<b>a</b>b が a b にならないように）
const BLOCK_TAG_PATTERN = /<\/?(?:p|br|li|ul|ol|div|h[1-6]|tr|table|blockquote|pre)(?=[\s/>])[^>]*>/gi
// `<` の次が英字・`/`・`!` のときだけタグとみなす（`a < b` は残す）
const TAG_PATTERN = /<[a-zA-Z/!][^>]*>/g

// 復号の順序: XML の実体を 1 段 → HTML タグを除く → HTML の実体を 1 段 → 空白を畳む。
// CDATA の中身は XML の実体を戻さない（HTML の実体は戻す）
const decodeText = (raw: string): string => {
  const parts: string[] = []
  let last = 0
  for (const match of raw.matchAll(CDATA_PATTERN)) {
    parts.push(unescapeOnce(raw.slice(last, match.index)))
    parts.push(match[1] ?? '')
    last = match.index + match[0].length
  }
  parts.push(unescapeOnce(raw.slice(last)))
  const stripped = parts.join('').replace(BLOCK_TAG_PATTERN, ' ').replace(TAG_PATTERN, '')
  return unescapeOnce(stripped).replace(/\s+/g, ' ').trim()
}

const truncate = (text: string, limit: number): string => {
  if (text.length <= limit) return text
  const cut = text.slice(0, limit)
  // サロゲートペアを途中で切らない
  return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// 閉じを持つ要素の中身（生）。見つからなければ null
const rawElement = (block: string, name: string): string | null => {
  const pattern = new RegExp(`<${escapeRegExp(name)}(?:\\s[^>]*)?>([\\s\\S]*?)</${escapeRegExp(name)}>`)
  return pattern.exec(block)?.[1] ?? null
}

const textElement = (block: string, name: string): string | null => {
  const raw = rawElement(block, name)
  if (raw === null) return null
  const text = decodeText(raw)
  return text === '' ? null : text
}

const parseAttributes = (tag: string): Record<string, string> => {
  const attributes: Record<string, string> = {}
  for (const match of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const name = match[1]
    if (name !== undefined) attributes[name] = unescapeOnce(match[2] ?? match[3] ?? '')
  }
  return attributes
}

// 自己終了または空の要素（<link ... /> や <sec:cvss ... />）の属性を全部集める
const attributeList = (block: string, name: string): Record<string, string>[] =>
  [...block.matchAll(new RegExp(`<${escapeRegExp(name)}(?=[\\s/>])([^>]*)>`, 'g'))].map((match) =>
    parseAttributes(match[1] ?? ''),
  )

const toIso = (text: string | null): string | null => {
  if (text === null) return null
  const date = new Date(text)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

const firstOf = (...values: (string | null)[]): string | null => values.find((value) => value !== null) ?? null

// 開きタグの直後から次の開きタグ・閉じタグまでを 1 区間とする。閉じが無い項目は捨てる
const blocks = (xml: string, tag: 'item' | 'entry'): { open: string; body: string }[] => {
  const pattern = new RegExp(`<${tag}(?=[\\s>])([^>]*)>((?:(?!<${tag}[\\s>])[\\s\\S])*?)</${tag}>`, 'g')
  return [...xml.matchAll(pattern)].map((match) => ({ open: match[1] ?? '', body: match[2] ?? '' }))
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
  [...blocks(xml, 'item'), ...blocks(xml, 'entry')]
    .map(({ open, body }) => toItem(open, body))
    .filter((item): item is FeedItem => item !== null)

// 本文が変わったかを見る指紋（title + summary + updatedAt）
export const contentHash = (item: FeedItem): string =>
  createHash('sha256')
    .update(`${item.title}\0${item.summary}\0${item.updatedAt ?? ''}`)
    .digest('hex')
